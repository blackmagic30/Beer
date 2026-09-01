import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRailwayMutationBoundaryCheck } from
  "./check-railway-mutation-boundary.js";
import {
  ACCOUNT_DELETION_REHEARSAL_DEPLOYMENT_QUERY,
  ACCOUNT_DELETION_REHEARSAL_METADATA_QUERY,
  ACCOUNT_DELETION_REHEARSAL_SCOPE_QUERY,
  accountDeletionRehearsalTransitionInternals,
  collectAccountDeletionRehearsalMetadata,
} from "./execute-protected-permanent-staging-account-deletion-rehearsal-transition.js";
import {
  type AccountDeletionRehearsalAttemptOperation,
  ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
  ACCOUNT_DELETION_REHEARSAL_LOCK,
  accountDeletionRehearsalAttemptInvariantSha256,
  accountDeletionRehearsalAttemptSnapshotSha256,
  canonicalJson,
  exactCleanupPatch,
  parseAccountDeletionRehearsalPolicy,
  parseAccountDeletionRehearsalAttemptArm,
  rowNamesSatisfyActivationStored,
  rowNamesSatisfyCleanupStored,
  sha256Hex,
} from "./lib/permanent-staging-account-deletion-rehearsal.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

export const ACCOUNT_DELETION_REHEARSAL_QUARANTINE_SCHEMA =
  "pintpath-account-deletion-rehearsal-quarantine/v1" as const;

const POLICY_PATH =
  "ops/railway/permanent-staging-account-deletion-rehearsal-policy.json";
const BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const TOKEN = /^[^\r\n\0]{16,4096}$/;
const MAX_BYTES = 1024 * 1024;

type QuarantineOperation = Extract<
  AccountDeletionRehearsalAttemptOperation,
  "quarantine-zero" | "quarantine-zero-retry-1" |
  "quarantine-zero-retry-2"
>;

const QUARANTINE_OPERATIONS: readonly QuarantineOperation[] = [
  "quarantine-zero",
  "quarantine-zero-retry-1",
  "quarantine-zero-retry-2",
] as const;

interface Arguments {
  readonly operation: QuarantineOperation;
  readonly candidateSha: string;
  readonly activationRunId: string;
  readonly authorityFile: string;
  readonly prerequisiteFile: string;
  readonly evidenceDirectory: string;
}

interface Snapshot {
  readonly rowNames: readonly string[];
  readonly replicas: number;
  readonly deploymentId: string;
  readonly snapshotId: string;
  readonly candidateSha: string;
  readonly imageDigest: string;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly instances: readonly { readonly id: string; readonly status: string }[];
}

interface CommandResult {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly boundaryCheck: () => Promise<0 | 1>;
  readonly validateCli: (filename: string) => boolean;
  readonly runCommand: (
    executable: string,
    args: readonly string[],
    token: string,
  ) => Promise<CommandResult>;
  readonly probeRuntimeAbsent: () => Promise<boolean>;
  readonly readFile: (filename: string) => string;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(argv: readonly string[]): Arguments | null {
  if (argv.length !== 12) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]
      || values.has(argv[index]!)) return null;
    values.set(argv[index]!, argv[index + 1]!);
  }
  const operation = values.get("--operation") as QuarantineOperation | undefined;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const activationRunId = values.get("--activation-run-id") ?? "";
  const authorityFile = values.get("--authority-file") ?? "";
  const prerequisiteFile = values.get("--prerequisite-file") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  return operation !== undefined && QUARANTINE_OPERATIONS.includes(operation)
    && SHA.test(candidateSha) && RUN_ID.test(activationRunId)
    && path.isAbsolute(authorityFile) && path.isAbsolute(prerequisiteFile)
    && path.isAbsolute(evidenceDirectory)
    ? { operation, candidateSha, activationRunId, authorityFile, prerequisiteFile,
        evidenceDirectory }
    : null;
}

async function boundedJson(response: Response): Promise<unknown> {
  const source = await response.text();
  if (!response.ok || Buffer.byteLength(source, "utf8") > MAX_BYTES
    || source.includes("\0")) throw new Error("response_invalid");
  return JSON.parse(source) as unknown;
}

async function graphql(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return boundedJson(await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  }));
}

async function readSnapshot(
  dependencies: Dependencies,
  metadataToken: string,
): Promise<Snapshot | null> {
  const metadata = await collectAccountDeletionRehearsalMetadata((after) =>
    graphql(dependencies.fetchImpl, metadataToken,
      ACCOUNT_DELETION_REHEARSAL_METADATA_QUERY, {
        projectId: ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
        environmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
        serviceId: ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
        after,
      }));
  if (!metadata) return null;
  const deployment = accountDeletionRehearsalTransitionInternals.parseDeployment(
    await graphql(dependencies.fetchImpl, metadataToken,
      ACCOUNT_DELETION_REHEARSAL_DEPLOYMENT_QUERY, {
        deploymentId: metadata.deploymentId,
      }),
    metadata,
  );
  return deployment ? {
    rowNames: metadata.rowNames,
    replicas: metadata.replicas,
    deploymentId: metadata.deploymentId,
    snapshotId: metadata.snapshotId,
    candidateSha: deployment.candidateSha,
    imageDigest: deployment.imageDigest,
    patch: metadata.patch,
    instances: deployment.instances,
  } : null;
}

function authorityExact(source: string, args: Arguments, runId: string): boolean {
  try {
    const value = JSON.parse(source) as unknown;
    return record(value)
      && value.schemaVersion === "pintpath-account-deletion-rehearsal-authority/v1"
      && value.executorState === ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE
      && value.candidateSha === args.candidateSha
      && value.githubRunId === runId
      && value.secretMaterialIncluded === false
      && (value.mode === "start"
        ? args.activationRunId === runId && record(value.reviewedPullRequest)
        : value.mode === "cleanup" && record(value.originalActivation)
          && value.originalActivation.runId === args.activationRunId
          && value.cleanupMayProceedAfterMainAdvances === true);
  } catch {
    return false;
  }
}

function quarantineSnapshotStateExact(
  snapshot: Snapshot,
  args: Pick<Arguments, "activationRunId" | "candidateSha" | "operation">,
  postflight = false,
): boolean {
  if (snapshot.candidateSha !== args.candidateSha
    || ![0, 1, 2].includes(snapshot.replicas)) return false;
  const retryOperation = args.operation !== "quarantine-zero";
  if (retryOperation && !postflight && snapshot.replicas === 0) return false;
  if (snapshot.replicas === 0) {
    if (snapshot.instances.length !== 0) return false;
  } else if (snapshot.instances.length !== snapshot.replicas
    || snapshot.instances.some((instance) => instance.status !== "RUNNING")) {
    return false;
  }
  const patchEmpty = Object.keys(snapshot.patch).length === 0;
  const activeRowsExact = rowNamesSatisfyActivationStored(
    snapshot.rowNames,
    args.activationRunId,
  );
  const cleanupRowsExact = rowNamesSatisfyCleanupStored(snapshot.rowNames);
  return (patchEmpty && (activeRowsExact || cleanupRowsExact))
    || (exactCleanupPatch(snapshot.patch, args.activationRunId)
      && activeRowsExact);
}

function quarantinedZeroCleanupExact(snapshot: Snapshot): boolean {
  return snapshot.replicas === 0 && snapshot.instances.length === 0
    && Object.keys(snapshot.patch).length === 0
    && rowNamesSatisfyCleanupStored(snapshot.rowNames);
}

function defaultValidateCli(filename: string): boolean {
  try {
    return sha256Hex(fs.readFileSync(filename)) ===
        ACCOUNT_DELETION_REHEARSAL_LOCK.railwayCliExecutableSha256
      && execFileSync(filename, ["--version"], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === `railway ${ACCOUNT_DELETION_REHEARSAL_LOCK.railwayCliVersion}`;
  } catch {
    return false;
  }
}

function runRailwayCommand(
  executable: string,
  args: readonly string[],
  token: string,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/nonexistent",
        RAILWAY_TOKEN: token,
        CI: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = crypto.createHash("sha256");
    const stderr = crypto.createHash("sha256");
    child.stdout.on("data", (chunk: Buffer) => stdout.update(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.update(chunk));
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 60_000);
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, timedOut, stdoutSha256: stdout.digest("hex"),
        stderrSha256: stderr.digest("hex") });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut, stdoutSha256: stdout.digest("hex"),
        stderrSha256: stderr.digest("hex") });
    });
  });
}

async function defaultProbeRuntimeAbsent(): Promise<boolean> {
  for (const route of ["/health", "/startup", "/ready"] as const) {
    try {
      const response = await fetch(
        `${ACCOUNT_DELETION_REHEARSAL_LOCK.publicOrigin}${route}`,
        {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.ok) return false;
    } catch {
      // Network refusal is the expected observation at zero replicas.
    }
  }
  return true;
}

function durableWrite(directory: string, leaf: string, source: string): string {
  writePrivateExclusiveFile(directory, leaf, source);
  return sha256Hex(source);
}

export async function runProtectedAccountDeletionRehearsalQuarantine(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    boundaryCheck: () => runRailwayMutationBoundaryCheck({
      argv: ["--policy", BOUNDARY_POLICY_PATH],
    }),
    validateCli: defaultValidateCli,
    runCommand: runRailwayCommand,
    probeRuntimeAbsent: defaultProbeRuntimeAbsent,
    readFile: (filename) => readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 128 * 1024,
      requireOwner: true,
      requirePrivate: true,
    }).toString("utf8"),
    writeDurable: durableWrite,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const args = parseArguments(dependencies.argv);
  const checks = {
    policyExact: false,
    githubAuthorityExact: false,
    tokenScopesExact: false,
    cliExact: false,
    boundaryPreflightExact: false,
    targetPreflightExact: false,
    durableAttemptArmExact: false,
    attemptPreflightExact: false,
    durableIntentExact: false,
    writeAttemptedAtMostOnce: true,
    acknowledgementExact: false,
    postflightAttempted: false,
    zeroReplicasExact: false,
    stableZeroSnapshotsExact: false,
    cleanupStoredAtZeroExact: false,
    deploymentUnchanged: false,
    providerInvariantUnchanged: false,
    runtimeUnavailableExact: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
  };
  let attempts: 0 | 1 = 0;
  let intentSha256: string | null = null;
  let terminalSha256: string | null = null;
  let command: CommandResult | null = null;
  let outcome: "quarantined_zero" | "already_quarantined_zero"
    | "quarantined_zero_pending_cleanup"
    | "already_quarantined_zero_pending_cleanup"
    | "failed_before_attempt" | "mutation_uncertain" = "failed_before_attempt";
  let before: Snapshot | null = null;
  let after: Snapshot | null = null;
  let attemptArmSha256: string | null = null;
  try {
    checks.policyExact = parseAccountDeletionRehearsalPolicy(
      fs.readFileSync(path.join(dependencies.cwd, POLICY_PATH), "utf8"),
    ) !== null;
    if (!args || !checks.policyExact) throw new Error("arguments_invalid");
    const runId = dependencies.env.GITHUB_RUN_ID ?? "";
    checks.githubAuthorityExact = RUN_ID.test(runId)
      && dependencies.env.GITHUB_RUN_ATTEMPT === "1"
      && dependencies.env.GITHUB_REF === "refs/heads/main"
      && dependencies.env.PINTPATH_ACCOUNT_DELETION_REHEARSAL_CONFIRMATION ===
        "QUARANTINE_ACCOUNT_DELETION_REHEARSAL_IN_PERMANENT_STAGING"
      && authorityExact(dependencies.readFile(args.authorityFile), args, runId);
    if (!checks.githubAuthorityExact) throw new Error("authority_invalid");
    const authoritySource = dependencies.readFile(args.authorityFile);
    const prerequisiteSource = dependencies.readFile(args.prerequisiteFile);
    const attemptArmFile =
      dependencies.env.PINTPATH_ACCOUNT_DELETION_REHEARSAL_ATTEMPT_ARM_FILE ?? "";
    attemptArmSha256 =
      dependencies.env.PINTPATH_ACCOUNT_DELETION_REHEARSAL_ATTEMPT_ARM_SHA256 ?? null;
    const attemptArm = path.isAbsolute(attemptArmFile)
      ? parseAccountDeletionRehearsalAttemptArm(
        dependencies.readFile(attemptArmFile), {
          operation: args.operation,
          candidateSha: args.candidateSha,
          activationRunId: args.activationRunId,
          githubRunId: runId,
          authoritySource,
          prerequisiteSource,
          contentSha256: attemptArmSha256 ?? "",
        },
      ) : null;
    checks.durableAttemptArmExact = attemptArm !== null;
    if (!attemptArm) throw new Error("attempt_arm_invalid");
    const metadataToken =
      dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    const scaleToken = dependencies.env.PINTPATH_RAILWAY_STAGING_SCALE_TOKEN ?? "";
    const productionMetadataToken =
      dependencies.env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
    const cli = dependencies.env.PINTPATH_RAILWAY_CLI_PATH ?? "";
    if (!TOKEN.test(metadataToken) || !TOKEN.test(scaleToken)
      || !TOKEN.test(productionMetadataToken)
      || new Set([metadataToken, scaleToken, productionMetadataToken]).size !== 3) {
      throw new Error("tokens_invalid");
    }
    const [metadataScope, scaleScope] = await Promise.all([
      graphql(dependencies.fetchImpl, metadataToken,
        ACCOUNT_DELETION_REHEARSAL_SCOPE_QUERY, {}),
      graphql(dependencies.fetchImpl, scaleToken,
        ACCOUNT_DELETION_REHEARSAL_SCOPE_QUERY, {}),
    ]);
    checks.tokenScopesExact =
      accountDeletionRehearsalTransitionInternals.scopeExact(metadataScope)
      && accountDeletionRehearsalTransitionInternals.scopeExact(scaleScope);
    checks.cliExact = path.isAbsolute(cli) && dependencies.validateCli(cli);
    checks.boundaryPreflightExact = await dependencies.boundaryCheck() === 0;
    before = await readSnapshot(dependencies, metadataToken);
    checks.targetPreflightExact = before !== null
      && quarantineSnapshotStateExact(before, args);
    checks.attemptPreflightExact = before !== null
      && (attemptArm.providerSnapshotSha256 ===
        accountDeletionRehearsalAttemptSnapshotSha256(before)
        || (args.operation === "quarantine-zero"
          && before.replicas === 0 && before.instances.length === 0
          && attemptArm.providerInvariantSha256 ===
            accountDeletionRehearsalAttemptInvariantSha256(before)));
    if (!checks.tokenScopesExact || !checks.cliExact
      || !checks.boundaryPreflightExact || !checks.targetPreflightExact
      || !checks.attemptPreflightExact || !before) {
      throw new Error("preflight_invalid");
    }
    const intent = canonicalJson({
      schemaVersion: "pintpath-account-deletion-rehearsal-quarantine-intent/v1",
      operation: args.operation,
      candidateSha: args.candidateSha,
      activationRunId: args.activationRunId,
      attemptArmSha256,
      providerInvariantBeforeSha256:
        accountDeletionRehearsalAttemptInvariantSha256(before),
      observedDeploymentIdSha256: sha256Hex(before.deploymentId),
      projectId: ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
      environmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
      serviceId: ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
      direction: "QUARANTINED_ZERO",
      exactArguments: ["service", "scale",
        `${ACCOUNT_DELETION_REHEARSAL_LOCK.region}=0`, "--project", "<project>",
        "--environment", "<environment>", "--service", "<service>", "--json"],
      maximumAttempts: 1,
      retryAllowed: false,
      restorationAllowed: false,
      secretMaterialIncluded: false,
    });
    intentSha256 = dependencies.writeDurable(args.evidenceDirectory,
      "intent.json", intent);
    checks.durableIntentExact = intentSha256 === sha256Hex(intent);
    if (!checks.durableIntentExact) throw new Error("intent_invalid");
    if (before.replicas === 0) {
      checks.acknowledgementExact = true;
      outcome = quarantinedZeroCleanupExact(before)
        ? "already_quarantined_zero"
        : "already_quarantined_zero_pending_cleanup";
    } else {
      attempts = 1;
      command = await dependencies.runCommand(cli, [
        "service", "scale", `${ACCOUNT_DELETION_REHEARSAL_LOCK.region}=0`,
        "--project", ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
        "--environment", ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
        "--service", ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
        "--json",
      ], scaleToken);
      checks.acknowledgementExact = command.code === 0 && !command.timedOut;
    }
    checks.postflightAttempted = true;
    let zeroSnapshotInvariant: string | null = null;
    let stableZeroObservations = 0;
    let stableUnavailableObservations = 0;
    for (let round = 0; round < 61; round += 1) {
      try {
        after = await readSnapshot(dependencies, metadataToken);
      } catch {
        after = null;
      }
      if (after?.replicas === 0 && after.instances.length === 0
        && quarantineSnapshotStateExact(after, args, true)) {
        const invariant = accountDeletionRehearsalAttemptInvariantSha256(after);
        const runtimeAbsent = await dependencies.probeRuntimeAbsent();
        if (!runtimeAbsent) {
          zeroSnapshotInvariant = null;
          stableZeroObservations = 0;
          stableUnavailableObservations = 0;
        } else if (zeroSnapshotInvariant === null) {
          zeroSnapshotInvariant = invariant;
          stableZeroObservations = 1;
          stableUnavailableObservations = 1;
        } else if (invariant === zeroSnapshotInvariant) {
          stableZeroObservations += 1;
          stableUnavailableObservations += 1;
        } else {
          zeroSnapshotInvariant = invariant;
          stableZeroObservations = 1;
          stableUnavailableObservations = 1;
        }
        if (stableZeroObservations >= 2
          && stableUnavailableObservations >= 2) break;
      } else {
        zeroSnapshotInvariant = null;
        stableZeroObservations = 0;
        stableUnavailableObservations = 0;
      }
      if (round === 60) break;
      await dependencies.sleep(5_000);
    }
    checks.zeroReplicasExact = after?.replicas === 0
      && after.instances.length === 0
      && quarantineSnapshotStateExact(after, args, true);
    checks.cleanupStoredAtZeroExact = after !== null
      && quarantinedZeroCleanupExact(after);
    checks.stableZeroSnapshotsExact = stableZeroObservations >= 2;
    checks.deploymentUnchanged = after !== null
      && after.deploymentId === before.deploymentId
      && after.snapshotId === before.snapshotId
      && after.candidateSha === before.candidateSha
      && after.imageDigest === before.imageDigest;
    checks.providerInvariantUnchanged = after !== null
      && accountDeletionRehearsalAttemptInvariantSha256(after) ===
        accountDeletionRehearsalAttemptInvariantSha256(before);
    checks.runtimeUnavailableExact = checks.zeroReplicasExact
      && checks.stableZeroSnapshotsExact
      && stableUnavailableObservations >= 2;
    checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
    if (!(checks.zeroReplicasExact && checks.stableZeroSnapshotsExact
      && checks.deploymentUnchanged && checks.providerInvariantUnchanged
      && checks.runtimeUnavailableExact && checks.boundaryPostflightExact)) {
      outcome = "mutation_uncertain";
    } else if (before.replicas !== 0) {
      outcome = checks.cleanupStoredAtZeroExact
        ? "quarantined_zero" : "quarantined_zero_pending_cleanup";
    } else {
      outcome = checks.cleanupStoredAtZeroExact
        ? "already_quarantined_zero"
        : "already_quarantined_zero_pending_cleanup";
    }
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  }
  const receipt = {
    schemaVersion: ACCOUNT_DELETION_REHEARSAL_QUARANTINE_SCHEMA,
    executorState: ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
    outcome,
    operation: args?.operation ?? null,
    candidateSha: args?.candidateSha ?? null,
    activationRunId: args?.activationRunId ?? null,
    githubRunId: dependencies.env.GITHUB_RUN_ID ?? null,
    attempts,
    retryAllowed: false,
    attemptArmSha256,
    providerInvariantBeforeSha256: before
      ? accountDeletionRehearsalAttemptInvariantSha256(before) : null,
    providerInvariantAfterSha256: after
      ? accountDeletionRehearsalAttemptInvariantSha256(after) : null,
    restorationAllowed: false,
    intentSha256,
    terminalSha256,
    command,
    checks,
  };
  if (args && checks.durableIntentExact) {
    try {
      const terminal = canonicalJson({
        schemaVersion: "pintpath-account-deletion-rehearsal-quarantine-terminal/v1",
        receipt,
        secretMaterialIncluded: false,
      });
      terminalSha256 = dependencies.writeDurable(args.evidenceDirectory,
        "terminal.json", terminal);
      checks.terminalEvidenceExact = terminalSha256 === sha256Hex(terminal);
    } catch {
      checks.terminalEvidenceExact = false;
    }
  }
  const final = { ...receipt, terminalSha256, checks };
  dependencies.writeOutput(`${JSON.stringify(final)}\n`);
  return ["quarantined_zero", "already_quarantined_zero",
    "quarantined_zero_pending_cleanup",
    "already_quarantined_zero_pending_cleanup"].includes(final.outcome)
    && checks.terminalEvidenceExact ? 0 : 1;
}

export const accountDeletionRehearsalQuarantineInternals = {
  authorityExact,
  parseArguments,
  quarantinedZeroCleanupExact,
  quarantineSnapshotStateExact,
  readSnapshot,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedAccountDeletionRehearsalQuarantine();
}
