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
  proveProviderReadinessOnEveryInstance,
  runtimeProof,
} from "./execute-protected-permanent-staging-account-deletion-rehearsal-redeploy.js";
import {
  ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
  ACCOUNT_DELETION_REHEARSAL_LOCK,
  accountDeletionRehearsalAttemptInvariantSha256,
  accountDeletionRehearsalAttemptSnapshotSha256,
  canonicalJson,
  parseAccountDeletionRehearsalPolicy,
  parseAccountDeletionRehearsalAttemptArm,
  rowNamesSatisfyActivationPreflight,
  rowNamesSatisfyCleanupStored,
  sha256Hex,
} from "./lib/permanent-staging-account-deletion-rehearsal.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

export const ACCOUNT_DELETION_REHEARSAL_SCALE_SCHEMA =
  "pintpath-account-deletion-rehearsal-scale/v1" as const;

const POLICY_PATH =
  "ops/railway/permanent-staging-account-deletion-rehearsal-policy.json";
const BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const TOKEN = /^[^\r\n\0]{16,4096}$/;
const MAX_BYTES = 1024 * 1024;
const MAX_ROUNDS = 61;

type Operation = "prepare-two" | "converge-one";

interface Arguments {
  readonly operation: Operation;
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
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly boundaryCheck: () => Promise<0 | 1>;
  readonly validateCli: (filename: string) => boolean;
  readonly runCommand: (
    executable: string,
    args: readonly string[],
    token: string,
  ) => Promise<CommandResult>;
  readonly runReadinessCommand: (
    executable: string,
    args: readonly string[],
    token: string,
  ) => Promise<{
    readonly code: number | null;
    readonly timedOut: boolean;
    readonly stdout: string;
    readonly stderrSha256: string;
  }>;
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
  const operation = values.get("--operation");
  const candidateSha = values.get("--candidate-sha") ?? "";
  const activationRunId = values.get("--activation-run-id") ?? "";
  const authorityFile = values.get("--authority-file") ?? "";
  const prerequisiteFile = values.get("--prerequisite-file") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  if (!(operation === "prepare-two" || operation === "converge-one")
    || !SHA.test(candidateSha) || !RUN_ID.test(activationRunId)
    || !path.isAbsolute(authorityFile) || !path.isAbsolute(prerequisiteFile)
    || !path.isAbsolute(evidenceDirectory)) return null;
  return { operation, candidateSha, activationRunId, authorityFile,
    prerequisiteFile, evidenceDirectory };
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
  return deployment ? { ...metadata, ...deployment } : null;
}

function authorityExact(source: string, args: Arguments, runId: string): boolean {
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value)
      || value.schemaVersion !== "pintpath-account-deletion-rehearsal-authority/v1"
      || value.executorState !== ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE
      || value.candidateSha !== args.candidateSha
      || value.githubRunId !== runId
      || value.secretMaterialIncluded !== false) return false;
    if (args.operation === "prepare-two") {
      return args.activationRunId === runId
        && value.mode === "start"
        && record(value.reviewedPullRequest)
        && value.cleanupMayProceedAfterMainAdvances === false;
    }
    if (value.mode === "start") {
      return args.activationRunId === runId
        && record(value.reviewedPullRequest)
        && value.cleanupMayProceedAfterMainAdvances === false;
    }
    return value.mode === "cleanup"
      && record(value.originalActivation)
      && value.originalActivation.runId === args.activationRunId
      && value.cleanupMayProceedAfterMainAdvances === true;
  } catch {
    return false;
  }
}

type ConvergePrerequisiteKind =
  | "safe_redeploy"
  | "cleanup_safe_two_observation"
  | "preactivation_safe_two_observation";

function shaListExact(value: unknown, length: number): boolean {
  return Array.isArray(value) && value.length === length
    && new Set(value).size === length
    && value.every((item) => typeof item === "string"
      && /^[a-f0-9]{64}$/.test(item));
}

function convergePrerequisiteKind(
  source: string,
  args: Arguments,
  runId: string,
  authoritySource: string | null,
): ConvergePrerequisiteKind | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value)) return null;
    if (value.schemaVersion ===
        "pintpath-account-deletion-rehearsal-redeploy-terminal/v1"
      && value.secretMaterialIncluded === false && record(value.receipt)
      && record(value.receipt.checks) && record(value.receipt.runtime)
      && value.receipt.schemaVersion ===
        "pintpath-account-deletion-rehearsal-redeploy/v1"
      && value.receipt.operation === "apply-safe"
      && ["redeployed_safe", "already_safe"].includes(String(value.receipt.outcome))
      && value.receipt.candidateSha === args.candidateSha
      && value.receipt.activationRunId === args.activationRunId
      && [runId, args.activationRunId].includes(String(value.receipt.githubRunId))
      && value.receipt.runtime.exact === true
      && shaListExact(value.receipt.runtime.replicaIdSha256s, 2)
      && shaListExact(value.receipt.runtime.providerReadinessSha256s, 2)
      && value.receipt.checks.targetPostflightExact === true
      && value.receipt.checks.sourceUnchanged === true
      && value.receipt.checks.accountDeletionRuntimeStateExact === true
      && value.receipt.checks.boundaryPostflightExact === true) {
      return "safe_redeploy";
    }
    if (value.schemaVersion !==
        "pintpath-account-deletion-rehearsal-state-observation/v1"
      || value.executorState !== ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE
      || value.exact !== true || value.candidateSha !== args.candidateSha
      || typeof value.implementationSha !== "string"
      || !SHA.test(value.implementationSha)
      || value.activationRunId !== args.activationRunId
      || value.githubRunId !== runId
      || authoritySource === null
      || value.authoritySha256 !== sha256Hex(authoritySource)
      || value.mutationCredentialExposed !== false
      || value.secretMaterialIncluded !== false
      || !record(value.lock) || !record(value.providerSnapshot)
      || !record(value.runtime) || !record(value.checks)
      || value.lock.projectId !== ACCOUNT_DELETION_REHEARSAL_LOCK.projectId
      || value.lock.environmentId !==
        ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId
      || value.lock.serviceId !== ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId
      || value.lock.region !== ACCOUNT_DELETION_REHEARSAL_LOCK.region
      || value.providerSnapshot.replicas !== 2
      || value.providerSnapshot.instanceCount !== 2
      || !shaListExact(value.providerSnapshot.instanceIdSha256s, 2)
      || !Array.isArray(value.providerSnapshot.instanceStatuses)
      || value.providerSnapshot.instanceStatuses.length !== 2
      || value.providerSnapshot.instanceStatuses.some((status) => status !== "RUNNING")
      || value.providerSnapshot.patchCategory !== "empty"
      || value.runtime.expected !== "safe" || value.runtime.replicas !== 2
      || value.runtime.publicExact !== true || value.runtime.providerExact !== true
      || value.runtime.runtimeUnavailableExact !== false
      || !shaListExact(value.runtime.replicaIdSha256s, 2)
      || !shaListExact(value.runtime.providerReadinessSha256s, 2)
      || value.checks.policyExact !== true
      || value.checks.githubAuthorityExact !== true
      || value.checks.tokenScopesExact !== true
      || value.checks.cliExact !== true
      || value.checks.boundaryPreflightExact !== true
      || value.checks.providerTopologyExact !== true
      || value.checks.candidateExact !== true
      || value.checks.rowCategoryExact !== true
      || value.checks.stagedPatchExact !== true
      || value.checks.activationMarkerExact !== true
      || value.checks.runtimeProofExact !== true
      || value.checks.boundaryPostflightExact !== true) return null;
    if (value.state === "CLEANUP_STORED_SAFE_TWO"
      && value.providerSnapshot.rowCategory === "cleanup") {
      return "cleanup_safe_two_observation";
    }
    if (value.state === "SAFE_TWO_PREACTIVATION"
      && value.providerSnapshot.rowCategory === "preactivation") {
      return "preactivation_safe_two_observation";
    }
    return null;
  } catch {
    return null;
  }
}

function prerequisiteExact(
  source: string,
  args: Arguments,
  runId: string,
  authoritySource: string | null = null,
): boolean {
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value)) return false;
    if (args.operation === "prepare-two") {
      return value.schemaVersion ===
          "pintpath-account-deletion-rehearsal-cleanup-arm/v1"
        && value.candidateSha === args.candidateSha
        && value.activationRunId === args.activationRunId
        && args.activationRunId === runId
        && value.projectId === ACCOUNT_DELETION_REHEARSAL_LOCK.projectId
        && value.environmentId ===
          ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId
        && value.serviceId === ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId
        && value.cleanupRequired === true
        && value.disarmCondition ===
          "SAFE_ONE_PREACTIVATION_OR_SAFE_ONE_FINAL_OR_QUARANTINED_ZERO"
        && value.secretMaterialIncluded === false;
    }
    return convergePrerequisiteKind(
      source, args, runId, authoritySource,
    ) !== null;
  } catch {
    return false;
  }
}

function defaultValidateCli(filename: string): boolean {
  try {
    return sha256Hex(fs.readFileSync(filename)) ===
        ACCOUNT_DELETION_REHEARSAL_LOCK.railwayCliExecutableSha256
      && execFileSync(filename, ["--version"], {
        encoding: "utf8", timeout: 10_000,
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
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", RAILWAY_TOKEN: token,
        CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = crypto.createHash("sha256");
    const stderr = crypto.createHash("sha256");
    child.stdout.on("data", (chunk: Buffer) => stdout.update(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.update(chunk));
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut, stdoutSha256: stdout.digest("hex"),
        stderrSha256: stderr.digest("hex") });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 60_000);
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}

function runReadinessCommand(
  executable: string,
  args: readonly string[],
  token: string,
): Promise<{ readonly code: number | null; readonly timedOut: boolean;
  readonly stdout: string; readonly stderrSha256: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", RAILWAY_TOKEN: token,
        CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const stderr = crypto.createHash("sha256");
    let timedOut = false;
    let settled = false;
    let invalid = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) { invalid = true; child.kill("SIGKILL"); }
      else chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.update(chunk));
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: invalid ? null : code, timedOut,
        stdout: invalid ? "" : Buffer.concat(chunks).toString("utf8"),
        stderrSha256: stderr.digest("hex") });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120_000);
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}

function durableWrite(directory: string, leaf: string, source: string): string {
  writePrivateExclusiveFile(directory, leaf, source);
  return sha256Hex(source);
}

export async function runProtectedAccountDeletionRehearsalScale(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2), env: process.env, cwd: process.cwd(),
    fetchImpl: fetch, now: Date.now,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    boundaryCheck: () => runRailwayMutationBoundaryCheck({
      argv: ["--policy", BOUNDARY_POLICY_PATH],
    }),
    validateCli: defaultValidateCli,
    runCommand: runRailwayCommand,
    runReadinessCommand,
    readFile: (filename) => readTrustedRegularFile(filename, {
      minBytes: 1, maxBytes: 128 * 1024, requireOwner: true, requirePrivate: true,
    }).toString("utf8"),
    writeDurable: durableWrite,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const args = parseArguments(dependencies.argv);
  const checks = {
    policyExact: false, githubAuthorityExact: false, prerequisiteReceiptExact: false,
    tokenScopesExact: false, cliExact: false, boundaryPreflightExact: false,
    targetPreflightExact: false, durableIntentExact: false,
    durableAttemptArmExact: false, attemptPreflightExact: false,
    safeRuntimePreflightExact: false,
    writeAttemptedAtMostOnce: true, acknowledgementExact: false,
    postflightAttempted: false, targetPostflightExact: false,
    deploymentUnchanged: false, safeRuntimeExact: false,
    boundaryPostflightExact: false, terminalEvidenceExact: false,
  };
  let attempts: 0 | 1 = 0;
  let intentSha256: string | null = null;
  let terminalSha256: string | null = null;
  let command: CommandResult | null = null;
  let outcome: "prepared_two" | "converged_one" | "already_converged_one"
    | "converged_one_preactivation" | "already_converged_one_preactivation"
    | "failed_before_attempt" | "mutation_uncertain" = "failed_before_attempt";
  let before: Snapshot | null = null;
  let acceptedConvergeKind: ConvergePrerequisiteKind | null = null;
  try {
    checks.policyExact = parseAccountDeletionRehearsalPolicy(
      fs.readFileSync(path.join(dependencies.cwd, POLICY_PATH), "utf8"),
    ) !== null;
    if (!args || !checks.policyExact) throw new Error("arguments_invalid");
    const runId = dependencies.env.GITHUB_RUN_ID ?? "";
    const confirmation = args.operation === "prepare-two"
      ? "PREPARE_ACCOUNT_DELETION_REHEARSAL_TWO_REPLICAS_IN_PERMANENT_STAGING"
      : "CONVERGE_ACCOUNT_DELETION_REHEARSAL_TO_ONE_IN_PERMANENT_STAGING";
    const authoritySource = dependencies.readFile(args.authorityFile);
    const prerequisiteSource = dependencies.readFile(args.prerequisiteFile);
    checks.githubAuthorityExact = RUN_ID.test(runId)
      && dependencies.env.GITHUB_RUN_ATTEMPT === "1"
      && dependencies.env.GITHUB_REF === "refs/heads/main"
      && dependencies.env.PINTPATH_ACCOUNT_DELETION_REHEARSAL_CONFIRMATION ===
        confirmation
      && authorityExact(authoritySource, args, runId);
    checks.prerequisiteReceiptExact = prerequisiteExact(
      prerequisiteSource, args, runId, authoritySource,
    );
    if (!checks.githubAuthorityExact || !checks.prerequisiteReceiptExact) {
      throw new Error("authority_invalid");
    }
    const convergeKind = args.operation === "converge-one"
      ? convergePrerequisiteKind(
        prerequisiteSource,
        args,
        runId,
        authoritySource,
      ) : null;
    acceptedConvergeKind = convergeKind;
    const attemptArmFile =
      dependencies.env.PINTPATH_ACCOUNT_DELETION_REHEARSAL_ATTEMPT_ARM_FILE ?? "";
    const attemptArmSha256 =
      dependencies.env.PINTPATH_ACCOUNT_DELETION_REHEARSAL_ATTEMPT_ARM_SHA256 ?? "";
    const attemptArm = path.isAbsolute(attemptArmFile)
      ? parseAccountDeletionRehearsalAttemptArm(
        dependencies.readFile(attemptArmFile), {
          operation: args.operation,
          candidateSha: args.candidateSha,
          activationRunId: args.activationRunId,
          githubRunId: runId,
          authoritySource,
          prerequisiteSource,
          contentSha256: attemptArmSha256,
        },
      ) : null;
    checks.durableAttemptArmExact = attemptArm !== null;
    if (!attemptArm) throw new Error("attempt_arm_invalid");
    const metadataToken = dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    const scaleToken = dependencies.env.PINTPATH_RAILWAY_STAGING_SCALE_TOKEN ?? "";
    // Railway project tokens can open an instance shell; use the existing
    // staging metadata token for the read-only readiness command. Never expose
    // the deployment-mutation token in the scale environment.
    const readinessToken = metadataToken;
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
    const rowStateExact = before !== null && (args.operation === "prepare-two"
      || convergeKind === "preactivation_safe_two_observation"
      ? rowNamesSatisfyActivationPreflight(before.rowNames)
      : rowNamesSatisfyCleanupStored(before.rowNames));
    checks.targetPreflightExact = before !== null
      && before.candidateSha === args.candidateSha
      && Object.keys(before.patch).length === 0
      && rowStateExact
      && (args.operation === "prepare-two"
        ? before.replicas === 1
        : (before.replicas === 1 || before.replicas === 2));
    if (!checks.tokenScopesExact || !checks.cliExact
      || !checks.boundaryPreflightExact || !checks.targetPreflightExact || !before) {
      throw new Error("preflight_invalid");
    }
    const preflightRuntime = await runtimeProof(
      dependencies, args.candidateSha, "safe", before.replicas as 1 | 2,
    );
    const preflightProvider = preflightRuntime.exact
      ? await proveProviderReadinessOnEveryInstance(
        dependencies, before.instances, cli, readinessToken,
        "permanent_staging_complete", before.replicas as 1 | 2,
      ) : null;
    checks.safeRuntimePreflightExact = preflightRuntime.exact
      && preflightRuntime.replicaIdSha256s.length === before.replicas
      && preflightProvider !== null
      && preflightProvider.length === before.replicas;
    if (!checks.safeRuntimePreflightExact) throw new Error("runtime_preflight_invalid");
    checks.attemptPreflightExact = attemptArm.providerSnapshotSha256 ===
      accountDeletionRehearsalAttemptSnapshotSha256(before)
      || (args.operation === "converge-one" && before.replicas === 1
        && attemptArm.providerInvariantSha256 ===
          accountDeletionRehearsalAttemptInvariantSha256(before));
    if (!checks.attemptPreflightExact) throw new Error("armed_snapshot_drift");
    const desired = args.operation === "prepare-two" ? 2 : 1;
    const intent = canonicalJson({
      schemaVersion: "pintpath-account-deletion-rehearsal-scale-intent/v1",
      operation: args.operation, candidateSha: args.candidateSha,
      activationRunId: args.activationRunId,
      projectId: ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
      environmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
      serviceId: ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
      deploymentIdSha256: sha256Hex(before.deploymentId),
      desiredReplicas: desired,
      command: ["service", "scale", `${ACCOUNT_DELETION_REHEARSAL_LOCK.region}=${desired}`,
        "--project", "<project>", "--environment", "<environment>",
        "--service", "<service>", "--json"],
      maximumAttempts: 1, retryAllowed: false, secretMaterialIncluded: false,
    });
    intentSha256 = dependencies.writeDurable(args.evidenceDirectory, "intent.json", intent);
    checks.durableIntentExact = intentSha256 === sha256Hex(intent);
    if (!checks.durableIntentExact) throw new Error("intent_invalid");
    if (before.replicas === desired) {
      checks.acknowledgementExact = true;
      outcome = "already_converged_one";
    } else {
      attempts = 1;
      command = await dependencies.runCommand(cli, [
        "service", "scale", `${ACCOUNT_DELETION_REHEARSAL_LOCK.region}=${desired}`,
        "--project", ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
        "--environment", ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
        "--service", ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
        "--json",
      ], scaleToken);
      checks.acknowledgementExact = command.code === 0 && !command.timedOut;
    }
    checks.postflightAttempted = true;
    let after: Snapshot | null = null;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      try { after = await readSnapshot(dependencies, metadataToken); }
      catch { after = null; }
      if (after?.replicas === desired && after.instances.length === desired
        && after.instances.every((instance) => instance.status === "RUNNING")) break;
      if (round + 1 === MAX_ROUNDS) break;
      await dependencies.sleep(5_000);
    }
    checks.targetPostflightExact = after !== null
      && after.replicas === desired
      && after.instances.length === desired
      && after.instances.every((instance) => instance.status === "RUNNING")
      && after.candidateSha === args.candidateSha
      && Object.keys(after.patch).length === 0
      && (args.operation === "prepare-two"
        || convergeKind === "preactivation_safe_two_observation"
        ? rowNamesSatisfyActivationPreflight(after.rowNames)
        : rowNamesSatisfyCleanupStored(after.rowNames));
    checks.deploymentUnchanged = after !== null
      && after.deploymentId === before.deploymentId
      && after.snapshotId === before.snapshotId
      && after.candidateSha === before.candidateSha
      && after.imageDigest === before.imageDigest;
    if (checks.targetPostflightExact && checks.deploymentUnchanged && after) {
      const runtime = await runtimeProof(dependencies, args.candidateSha, "safe", desired);
      const provider = runtime.exact
        ? await proveProviderReadinessOnEveryInstance(
          dependencies, after.instances, cli, readinessToken,
          "permanent_staging_complete", desired,
        ) : null;
      checks.safeRuntimeExact = runtime.exact
        && runtime.replicaIdSha256s.length === desired
        && provider !== null && provider.length === desired;
    }
    checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
    const success = checks.targetPostflightExact && checks.deploymentUnchanged
      && checks.safeRuntimeExact && checks.boundaryPostflightExact;
    outcome = success
      ? args.operation === "prepare-two" ? "prepared_two"
        : convergeKind === "preactivation_safe_two_observation"
          ? before.replicas === 1
            ? "already_converged_one_preactivation"
            : "converged_one_preactivation"
          : before.replicas === 1 ? "already_converged_one" : "converged_one"
      : "mutation_uncertain";
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  }
  const receipt = {
    schemaVersion: ACCOUNT_DELETION_REHEARSAL_SCALE_SCHEMA,
    executorState: ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
    operation: args?.operation ?? null, outcome,
    candidateSha: args?.candidateSha ?? null,
    activationRunId: args?.activationRunId ?? null,
    convergePrerequisiteKind: acceptedConvergeKind,
    githubRunId: dependencies.env.GITHUB_RUN_ID ?? null,
    attempts, retryAllowed: false, intentSha256, terminalSha256, command, checks,
  };
  if (args && checks.durableIntentExact) {
    try {
      const terminal = canonicalJson({
        schemaVersion: "pintpath-account-deletion-rehearsal-scale-terminal/v1",
        receipt, secretMaterialIncluded: false,
      });
      terminalSha256 = dependencies.writeDurable(args.evidenceDirectory,
        "terminal.json", terminal);
      checks.terminalEvidenceExact = terminalSha256 === sha256Hex(terminal);
    } catch {
      checks.terminalEvidenceExact = false;
      if (attempts === 1) outcome = "mutation_uncertain";
    }
  }
  const final = { ...receipt, outcome, terminalSha256, checks };
  dependencies.writeOutput(`${JSON.stringify(final)}\n`);
  return ["prepared_two", "converged_one", "already_converged_one",
    "converged_one_preactivation", "already_converged_one_preactivation"]
    .includes(final.outcome) && checks.terminalEvidenceExact ? 0 : 1;
}

export const accountDeletionRehearsalScaleInternals = {
  authorityExact, parseArguments, prerequisiteExact, readSnapshot,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedAccountDeletionRehearsalScale();
}
