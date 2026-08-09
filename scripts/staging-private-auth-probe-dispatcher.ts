import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runStagingPrivateAuthProbe,
  stagingPrivateAuthProbeInternals,
  type StagingPrivateAuthProbeProgress,
  type StagingPrivateAuthProbeReceipt,
  type StagingPrivateAuthProbeMode,
  type StagingPrivateAuthProbeTarget,
} from "./staging-private-auth-probe.js";

export const STAGING_AUTH_PROBE_RAILWAY_CONFIG_PATH =
  "/railway.auth-probe.toml";
export const STAGING_AUTH_PROBE_NODE_VERSION = "v22.23.2";
export const STAGING_AUTH_PROBE_PSQL_VERSION = "17.10";

const LIVE_MODES = new Set<StagingPrivateAuthProbeMode>([
  "watch-old-rejection",
  "provision-runtime-candidate",
  "verify-current",
  "retire-old-runtime",
]);
const TARGETS = new Set<StagingPrivateAuthProbeTarget>([
  "all",
  "postgres-admin",
  "postgres-runtime",
  "redis",
]);
const MAX_CONTROL_VALUE_LENGTH = 64;
const TOOLCHAIN_TIMEOUT_MS = 15_000;
const POSTGRES_CLIENT_VERSION_PATTERN = /^psql \(PostgreSQL\) 17\.10(?:\s|$)/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECEIPT_KEYS = [
  "schemaVersion",
  "timestamp",
  "deploymentId",
  "mode",
  "target",
  "outcome",
  "identity",
  "checks",
] as const;
const IDENTITY_KEYS = [
  "project",
  "environment",
  "service",
  "deployment",
  "debugLoggingDisabled",
  "postgresResource",
  "redisResource",
  "postgresAdminTarget",
  "postgresRuntimeTarget",
  "redisTarget",
  "postgresAdminLogin",
  "postgresRuntimeLogin",
  "redisLogin",
  "postgresCredentialsDistinct",
  "providerCredentialsDistinct",
  "postgresClient17",
  "runtimeCandidateDistinct",
  "runtimeCandidateSecretDistinct",
  "runtimeCandidateOwnerSecretValid",
  "retiredRuntimeDistinct",
] as const;
const CHECK_KEYS = [
  "postgresAdminAuth",
  "postgresRuntimeAuth",
  "redisAuth",
  "postgresAdminTransition",
  "postgresRuntimeTransition",
  "redisTransition",
  "runtimeHandoff",
  "runtimeReadiness",
  "runtimeMutation",
] as const;
const AUTHENTICATION_RECEIPTS = new Set([
  "accepted",
  "rejected",
  "inconclusive",
  "not-run",
]);
const TRANSITION_RECEIPTS = new Set(["observed", "not-observed", "not-run"]);
const HANDOFF_RECEIPTS = new Set([
  "observed",
  "not-observed",
  "inconclusive",
  "not-run",
]);
const READINESS_RECEIPTS = new Set([
  "ready",
  "not-ready",
  "inconclusive",
  "not-run",
]);
const MUTATION_RECEIPTS = new Set([
  "completed",
  "rolled-back",
  "cleanup-inconclusive",
  "inconclusive",
  "not-run",
]);

type DispatcherReceiptMode = "build-only" | "invalid";
type DispatcherReceiptTarget = "all" | "invalid";

interface DispatcherReceipt {
  schemaVersion: "staging-private-auth-probe-dispatcher/v1";
  mode: DispatcherReceiptMode;
  target: DispatcherReceiptTarget;
  outcome: "passed" | "failed";
  checks: {
    dedicatedRailwayConfig: boolean;
    node22_23_2: boolean;
    postgresClient17_10: boolean;
  };
}

interface DispatcherDependencies {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  nodeVersion: string;
  readPsqlVersion: () => Promise<string | null>;
  runProbe: (
    mode: StagingPrivateAuthProbeMode,
    target: StagingPrivateAuthProbeTarget,
    writeOutput: (output: string) => void,
  ) => Promise<0 | 1>;
  writeOutput: (output: string) => void;
}

function controlValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim() ?? "";
  return value.length <= MAX_CONTROL_VALUE_LENGTH ? value : "";
}

function dedicatedConfigSelected(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    controlValue(env, "STAGING_AUTH_PROBE_RAILWAY_CONFIG_PATH") ===
    STAGING_AUTH_PROBE_RAILWAY_CONFIG_PATH
  );
}

function createDispatcherReceipt(input: {
  mode?: "build-only";
  outcome: "passed" | "failed";
  dedicatedRailwayConfig: boolean;
  nodeVersion?: string;
  psqlVersion?: string | null;
}): DispatcherReceipt {
  return {
    schemaVersion: "staging-private-auth-probe-dispatcher/v1",
    mode: input.mode ?? "invalid",
    target: input.mode === "build-only" ? "all" : "invalid",
    outcome: input.outcome,
    checks: {
      dedicatedRailwayConfig: input.dedicatedRailwayConfig,
      node22_23_2: input.nodeVersion === STAGING_AUTH_PROBE_NODE_VERSION,
      postgresClient17_10: Boolean(
        input.psqlVersion &&
          POSTGRES_CLIENT_VERSION_PATTERN.test(input.psqlVersion.trim()),
      ),
    },
  };
}

function writeReceipt(
  writeOutput: (output: string) => void,
  receipt: DispatcherReceipt,
): void {
  writeOutput(`${JSON.stringify(receipt)}\n`);
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key, index) => actualKeys[index] === key)
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function parseCanonicalDelegatedReceipt(
  output: string,
  mode: StagingPrivateAuthProbeMode,
  target: StagingPrivateAuthProbeTarget,
  exitCode: 0 | 1,
): StagingPrivateAuthProbeReceipt | null {
  if (!output.endsWith("\n") || output.slice(0, -1).includes("\n")) return null;
  try {
    const parsed: unknown = JSON.parse(output);
    if (!hasExactKeys(parsed, RECEIPT_KEYS)) return null;
    const identity = parsed.identity;
    const checks = parsed.checks;
    if (
      !hasExactKeys(identity, IDENTITY_KEYS) ||
      !hasExactKeys(checks, CHECK_KEYS)
    ) {
      return null;
    }
    const outcome = parsed.outcome;
    if (
      parsed.schemaVersion === "staging-private-auth-probe/v1" &&
      isCanonicalTimestamp(parsed.timestamp) &&
      typeof parsed.deploymentId === "string" &&
      (UUID_PATTERN.test(parsed.deploymentId) ||
        parsed.deploymentId === "unavailable") &&
      parsed.mode === mode &&
      parsed.target === target &&
      (outcome === "passed" ||
        outcome === "failed" ||
        outcome === "inconclusive") &&
      (outcome === "passed" ? exitCode === 0 : exitCode === 1) &&
      IDENTITY_KEYS.every((key) => typeof identity[key] === "boolean") &&
      AUTHENTICATION_RECEIPTS.has(checks.postgresAdminAuth as string) &&
      AUTHENTICATION_RECEIPTS.has(checks.postgresRuntimeAuth as string) &&
      AUTHENTICATION_RECEIPTS.has(checks.redisAuth as string) &&
      TRANSITION_RECEIPTS.has(checks.postgresAdminTransition as string) &&
      TRANSITION_RECEIPTS.has(checks.postgresRuntimeTransition as string) &&
      TRANSITION_RECEIPTS.has(checks.redisTransition as string) &&
      HANDOFF_RECEIPTS.has(checks.runtimeHandoff as string) &&
      READINESS_RECEIPTS.has(checks.runtimeReadiness as string) &&
      MUTATION_RECEIPTS.has(checks.runtimeMutation as string) &&
      `${JSON.stringify(parsed)}\n` === output
    ) {
      return parsed as unknown as StagingPrivateAuthProbeReceipt;
    }
    return null;
  } catch {
    return null;
  }
}

function parseCanonicalProgress(
  output: string,
): StagingPrivateAuthProbeProgress | null {
  if (!output.endsWith("\n") || output.slice(0, -1).includes("\n")) return null;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    if (
      keys.length !== 6 ||
      keys[0] !== "schemaVersion" ||
      keys[1] !== "deploymentId" ||
      keys[2] !== "mode" ||
      keys[3] !== "target" ||
      keys[4] !== "event" ||
      keys[5] !== "outcome" ||
      parsed.schemaVersion !== "staging-private-auth-probe-progress/v1" ||
      typeof parsed.deploymentId !== "string" ||
      !UUID_PATTERN.test(parsed.deploymentId) ||
      parsed.mode !== "watch-old-rejection" ||
      !TARGETS.has(parsed.target as StagingPrivateAuthProbeTarget) ||
      parsed.event !== "watcher-armed" ||
      parsed.outcome !== "accepted" ||
      `${JSON.stringify(parsed)}\n` !== output
    ) {
      return null;
    }
    return parsed as unknown as StagingPrivateAuthProbeProgress;
  } catch {
    return null;
  }
}

async function defaultReadPsqlVersion(): Promise<string | null> {
  const result = await stagingPrivateAuthProbeInternals.runCapturedProcess({
    command: "psql",
    arguments: ["--version"],
    environment: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
    },
    stdin: "",
    timeoutMs: TOOLCHAIN_TIMEOUT_MS,
  });
  return !result.timedOut &&
    !result.spawnFailed &&
    !result.outputOverflow &&
    result.exitCode === 0 &&
    result.stderr === ""
    ? result.stdout.trim()
    : null;
}

const DEFAULT_DEPENDENCIES: DispatcherDependencies = {
  argv: process.argv.slice(2),
  env: process.env,
  nodeVersion: process.version,
  readPsqlVersion: defaultReadPsqlVersion,
  runProbe: (mode, target, writeOutput) =>
    runStagingPrivateAuthProbe(mode, target, { writeOutput }),
  writeOutput: (output) => process.stdout.write(output),
};

export async function runStagingPrivateAuthProbeDispatcher(
  overrides: Partial<DispatcherDependencies> = {},
): Promise<0 | 1> {
  const dependencies: DispatcherDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  const configSelected = dedicatedConfigSelected(dependencies.env);
  const mode = controlValue(dependencies.env, "STAGING_AUTH_PROBE_MODE");
  const target = controlValue(dependencies.env, "STAGING_AUTH_PROBE_TARGET");

  if (
    dependencies.argv.length !== 0 ||
    !configSelected ||
    (mode === "build-only" && target !== "all")
  ) {
    writeReceipt(
      dependencies.writeOutput,
      createDispatcherReceipt({
        outcome: "failed",
        dedicatedRailwayConfig: configSelected,
      }),
    );
    return 1;
  }

  if (mode === "build-only") {
    let psqlVersion: string | null = null;
    try {
      psqlVersion = await dependencies.readPsqlVersion();
    } catch {
      psqlVersion = null;
    }
    const receipt = createDispatcherReceipt({
      mode: "build-only",
      outcome: "failed",
      dedicatedRailwayConfig: true,
      nodeVersion: dependencies.nodeVersion,
      psqlVersion,
    });
    receipt.outcome =
      receipt.checks.node22_23_2 && receipt.checks.postgresClient17_10
        ? "passed"
        : "failed";
    writeReceipt(dependencies.writeOutput, receipt);
    return receipt.outcome === "passed" ? 0 : 1;
  }

  if (
    !LIVE_MODES.has(mode as StagingPrivateAuthProbeMode) ||
    !TARGETS.has(target as StagingPrivateAuthProbeTarget)
  ) {
    writeReceipt(
      dependencies.writeOutput,
      createDispatcherReceipt({
        outcome: "failed",
        dedicatedRailwayConfig: true,
      }),
    );
    return 1;
  }

  const delegatedMode = mode as StagingPrivateAuthProbeMode;
  const delegatedTarget = target as StagingPrivateAuthProbeTarget;
  const expectedDeploymentId = controlValue(
    dependencies.env,
    "RAILWAY_DEPLOYMENT_ID",
  );
  let delegatedInvalid = false;
  let delegatedTerminal: string | null = null;
  let progress: StagingPrivateAuthProbeProgress | null = null;
  const captureDelegatedOutput = (output: string): void => {
    if (delegatedInvalid) return;
    const candidateProgress = parseCanonicalProgress(output);
    if (candidateProgress) {
      if (
        delegatedMode !== "watch-old-rejection" ||
        delegatedTerminal !== null ||
        progress !== null ||
        candidateProgress.deploymentId !== expectedDeploymentId ||
        candidateProgress.target !== delegatedTarget
      ) {
        delegatedInvalid = true;
        return;
      }
      progress = candidateProgress;
      dependencies.writeOutput(output);
      return;
    }
    if (delegatedTerminal !== null) {
      delegatedInvalid = true;
      return;
    }
    delegatedTerminal = output;
  };
  let exitCode: 0 | 1;
  try {
    exitCode = await dependencies.runProbe(
      delegatedMode,
      delegatedTarget,
      captureDelegatedOutput,
    );
  } catch {
    writeReceipt(
      dependencies.writeOutput,
      createDispatcherReceipt({
        outcome: "failed",
        dedicatedRailwayConfig: true,
      }),
    );
    return 1;
  }
  const terminalReceipt = delegatedTerminal
    ? parseCanonicalDelegatedReceipt(
        delegatedTerminal,
        delegatedMode,
        delegatedTarget,
        exitCode,
      )
    : null;
  const watchProgressIsConsistent =
    delegatedMode !== "watch-old-rejection" ||
    Boolean(
      terminalReceipt &&
        terminalReceipt.deploymentId === expectedDeploymentId &&
        (terminalReceipt.outcome === "passed" ? progress !== null : true) &&
        (progress === null || terminalReceipt.outcome !== "failed"),
    );
  if (
    delegatedInvalid ||
    delegatedTerminal === null ||
    terminalReceipt === null ||
    !watchProgressIsConsistent
  ) {
    writeReceipt(
      dependencies.writeOutput,
      createDispatcherReceipt({
        outcome: "failed",
        dedicatedRailwayConfig: true,
      }),
    );
    return 1;
  }
  dependencies.writeOutput(delegatedTerminal);
  return exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runStagingPrivateAuthProbeDispatcher();
}
