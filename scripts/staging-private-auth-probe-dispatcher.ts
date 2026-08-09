import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runStagingPrivateAuthProbe,
  stagingPrivateAuthProbeInternals,
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

function isCanonicalDelegatedReceipt(
  output: string,
  mode: StagingPrivateAuthProbeMode,
  target: StagingPrivateAuthProbeTarget,
  exitCode: 0 | 1,
): boolean {
  if (!output.endsWith("\n") || output.slice(0, -1).includes("\n"))
    return false;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const outcome = String(parsed.outcome);
    return (
      parsed.schemaVersion === "staging-private-auth-probe/v1" &&
      parsed.mode === mode &&
      parsed.target === target &&
      ["passed", "failed", "inconclusive"].includes(outcome) &&
      (outcome === "passed" ? exitCode === 0 : exitCode === 1)
    );
  } catch {
    return false;
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

  const delegatedOutput: string[] = [];
  let exitCode: 0 | 1;
  try {
    exitCode = await dependencies.runProbe(
      mode as StagingPrivateAuthProbeMode,
      target as StagingPrivateAuthProbeTarget,
      (output) => delegatedOutput.push(output),
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
  if (
    delegatedOutput.length !== 1 ||
    !isCanonicalDelegatedReceipt(
      delegatedOutput[0] ?? "",
      mode as StagingPrivateAuthProbeMode,
      target as StagingPrivateAuthProbeTarget,
      exitCode,
    )
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
  dependencies.writeOutput(delegatedOutput[0]!);
  return exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runStagingPrivateAuthProbeDispatcher();
}
