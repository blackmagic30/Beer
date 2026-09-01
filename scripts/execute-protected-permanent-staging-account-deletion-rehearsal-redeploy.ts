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
  ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
  ACCOUNT_DELETION_REHEARSAL_LOCK,
  accountDeletionRehearsalAttemptSnapshotSha256,
  canonicalJson,
  parseAccountDeletionRehearsalPolicy,
  parseAccountDeletionRehearsalAttemptArm,
  rowNamesSatisfyActivationStored,
  rowNamesSatisfyCleanupStored,
  runtimeStateExact,
  sha256Hex,
} from "./lib/permanent-staging-account-deletion-rehearsal.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

export const ACCOUNT_DELETION_REHEARSAL_REDEPLOY_SCHEMA =
  "pintpath-account-deletion-rehearsal-redeploy/v1" as const;

const POLICY_PATH =
  "ops/railway/permanent-staging-account-deletion-rehearsal-policy.json";
const BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const TOKEN = /^[^\r\n\0]{16,4096}$/;
const MAX_BYTES = 1024 * 1024;
const MAX_ROUNDS = 91;

type Operation = "apply-active" | "apply-safe";
type RuntimeRoute = "/health" | "/startup" | "/ready";

interface Arguments {
  readonly operation: Operation;
  readonly candidateSha: string;
  readonly transitionRunId: string;
  readonly transitionTerminalFile: string;
  readonly authorityFile: string;
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
  readonly canonicalDeployment: string;
  readonly instances: readonly { readonly id: string; readonly status: string }[];
}

interface CommandResult {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
}

interface RuntimeProof {
  readonly exact: boolean;
  readonly rounds: number;
  readonly replicaIdSha256s: readonly string[];
  readonly responseSha256s: Readonly<Record<RuntimeRoute, readonly string[]>>;
  readonly providerReadinessSha256s: readonly string[];
}

interface RuntimeProofDependencies {
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
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
}

interface Dependencies extends RuntimeProofDependencies {
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

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length
    && expected.every((key, index) => actual[index] === key);
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
  const transitionRunId = values.get("--transition-run-id") ?? "";
  const transitionTerminalFile = values.get("--transition-terminal-file") ?? "";
  const authorityFile = values.get("--authority-file") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  if (!(["apply-active", "apply-safe"] as const).includes(operation as Operation)
    || !SHA.test(candidateSha) || !RUN_ID.test(transitionRunId)
    || !path.isAbsolute(transitionTerminalFile) || !path.isAbsolute(authorityFile)
    || !path.isAbsolute(evidenceDirectory)) return null;
  return {
    operation: operation as Operation,
    candidateSha,
    transitionRunId,
    transitionTerminalFile,
    authorityFile,
    evidenceDirectory,
  };
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
    graphql(
      dependencies.fetchImpl,
      metadataToken,
      ACCOUNT_DELETION_REHEARSAL_METADATA_QUERY,
      {
        projectId: ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
        environmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
        serviceId: ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
        after,
      },
    ));
  if (!metadata) return null;
  const deployment = accountDeletionRehearsalTransitionInternals.parseDeployment(
    await graphql(
      dependencies.fetchImpl,
      metadataToken,
      ACCOUNT_DELETION_REHEARSAL_DEPLOYMENT_QUERY,
      { deploymentId: metadata.deploymentId },
    ),
    metadata,
  );
  return deployment ? { ...metadata, ...deployment } : null;
}

interface TransitionBinding {
  readonly operation: "store-activation" | "store-cleanup" | "reconcile-cleanup";
  readonly activationRunId: string | null;
}

function transitionTerminalBinding(
  source: string,
  args: Arguments,
): TransitionBinding | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value) || !record(value.receipt) || !record(value.receipt.checks)) {
      return null;
    }
    const expectedOperation = args.operation === "apply-active"
      ? "store-activation"
      : (["store-cleanup", "reconcile-cleanup"].includes(
          String(value.receipt.operation),
        ) ? value.receipt.operation : null);
    const expectedOutcomes = args.operation === "apply-active"
      ? ["activation_stored"]
      : ["cleanup_stored", "cleanup_already_stored"];
    const exact = value.schemaVersion ===
        "pintpath-account-deletion-rehearsal-transition-terminal/v1"
      && value.secretMaterialIncluded === false
      && value.receipt.operation === expectedOperation
      && expectedOutcomes.includes(String(value.receipt.outcome))
      && value.receipt.candidateSha === args.candidateSha
      && value.receipt.githubRunId === args.transitionRunId
      && value.receipt.checks.targetPostflightExact === true
      && value.receipt.checks.deploymentUnchanged === true
      && value.receipt.checks.boundaryPostflightExact === true;
    if (!exact || typeof expectedOperation !== "string") return null;
    const activationRunId = value.receipt.activationRunId;
    return {
      operation: expectedOperation as TransitionBinding["operation"],
      activationRunId: typeof activationRunId === "string"
        && RUN_ID.test(activationRunId) ? activationRunId : null,
    };
  } catch {
    return null;
  }
}

function transitionTerminalExact(source: string, args: Arguments): boolean {
  return transitionTerminalBinding(source, args) !== null;
}

function authorityExact(
  source: string,
  args: Arguments,
  currentRunId: string,
  transition: TransitionBinding,
): boolean {
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value)) return false;
    const common = value.schemaVersion ===
        "pintpath-account-deletion-rehearsal-authority/v1"
      && value.executorState === ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE
      && value.candidateSha === args.candidateSha
      && value.githubRunId === currentRunId
      && value.secretMaterialIncluded === false;
    if (!common) return false;
    if (args.operation === "apply-active") {
      return transition.operation === "store-activation"
        && value.mode === "start"
        && record(value.reviewedPullRequest)
        && value.cleanupMayProceedAfterMainAdvances === false;
    }
    if (transition.operation === "store-cleanup") {
      return value.mode === "start"
        && record(value.reviewedPullRequest)
        && value.cleanupMayProceedAfterMainAdvances === false;
    }
    return transition.operation === "reconcile-cleanup"
      && transition.activationRunId !== null
      && value.mode === "cleanup"
      && record(value.originalActivation)
      && value.originalActivation.runId === transition.activationRunId
      && value.cleanupMayProceedAfterMainAdvances === true;
  } catch {
    return false;
  }
}

function defaultValidateCli(filename: string): boolean {
  try {
    const bytes = fs.readFileSync(filename);
    return sha256Hex(bytes) ===
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
      resolve({
        code: null,
        timedOut,
        stdoutSha256: stdout.digest("hex"),
        stderrSha256: stderr.digest("hex"),
      });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        timedOut,
        stdoutSha256: stdout.digest("hex"),
        stderrSha256: stderr.digest("hex"),
      });
    });
  });
}

function runRailwayReadinessCommand(
  executable: string,
  args: readonly string[],
  token: string,
): Promise<{
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderrSha256: string;
}> {
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
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    const stderr = crypto.createHash("sha256");
    let invalid = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_BYTES) {
        invalid = true;
        child.kill("SIGKILL");
      } else {
        stdout.push(Buffer.from(chunk));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.update(chunk));
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120_000);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: invalid ? null : code,
        timedOut,
        stdout: invalid ? "" : Buffer.concat(stdout).toString("utf8"),
        stderrSha256: stderr.digest("hex"),
      });
    };
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}

function providerReadinessExact(
  source: string,
  expectedProfile: "account_deletion_rehearsal" | "permanent_staging_complete",
): boolean {
  if (Buffer.byteLength(source, "utf8") > MAX_BYTES || source.includes("\0")) {
    return false;
  }
  try {
    const value = JSON.parse(source) as unknown;
    return record(value)
      && value.ok === true
      && value.environment === "production"
      && value.readinessProfile === expectedProfile
      && value.strictLaunchCheck === true
      && record(value.summary)
      && value.summary.failures === 0
      && Array.isArray(value.checks)
      && value.checks.length > 0
      && value.checks.every((check) => record(check) && check.status === "pass");
  } catch {
    return false;
  }
}

export async function runtimeProof(
  dependencies: RuntimeProofDependencies,
  candidateSha: string,
  expected: "active" | "safe",
  expectedReplicaCount: 1 | 2,
): Promise<RuntimeProof> {
  const observations = new Map<string, Map<RuntimeRoute, Set<string>>>();
  const startedAt = dependencies.now();
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    for (const route of ["/health", "/startup", "/ready"] as const) {
      try {
        const response = await dependencies.fetchImpl(
          `${ACCOUNT_DELETION_REHEARSAL_LOCK.publicOrigin}${route}`,
          {
            method: "GET",
            headers: { accept: "application/json" },
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          },
        );
        const source = await response.text();
        if (!response.ok || Buffer.byteLength(source, "utf8") > MAX_BYTES) continue;
        const parsed = JSON.parse(source) as unknown;
        const exact = runtimeStateExact(route, parsed, candidateSha, expected);
        if (!exact) continue;
        let replica = observations.get(exact.replicaIdSha256);
        if (!replica) {
          replica = new Map();
          observations.set(exact.replicaIdSha256, replica);
        }
        const hashes = replica.get(route) ?? new Set<string>();
        hashes.add(sha256Hex(source));
        replica.set(route, hashes);
      } catch {
        // A deployment can be unavailable while Railway replaces its replicas.
      }
    }
    const complete = [...observations.entries()].filter(([, routes]) =>
      (["/health", "/startup", "/ready"] as const)
        .every((route) => (routes.get(route)?.size ?? 0) > 0));
    if (complete.length >= expectedReplicaCount) {
      const selected = complete.slice(0, expectedReplicaCount);
      return {
        exact: true,
        rounds: round,
        replicaIdSha256s: selected.map(([id]) => id).sort(),
        responseSha256s: {
          "/health": selected.flatMap(([, routes]) =>
            [...(routes.get("/health") ?? [])]).sort(),
          "/startup": selected.flatMap(([, routes]) =>
            [...(routes.get("/startup") ?? [])]).sort(),
          "/ready": selected.flatMap(([, routes]) =>
            [...(routes.get("/ready") ?? [])]).sort(),
        },
        providerReadinessSha256s: [],
      };
    }
    if (round === MAX_ROUNDS || dependencies.now() - startedAt >= 900_000) break;
    await dependencies.sleep(10_000);
  }
  return {
    exact: false,
    rounds: MAX_ROUNDS,
    replicaIdSha256s: [],
    responseSha256s: { "/health": [], "/startup": [], "/ready": [] },
    providerReadinessSha256s: [],
  };
}

export async function proveProviderReadinessOnEveryInstance(
  dependencies: RuntimeProofDependencies,
  instances: readonly { readonly id: string; readonly status: string }[],
  executable: string,
  token: string,
  expectedProfile: "account_deletion_rehearsal" | "permanent_staging_complete",
  expectedInstanceCount: 1 | 2,
): Promise<readonly string[] | null> {
  if (instances.length !== expectedInstanceCount || instances.some((instance) =>
    instance.status !== "RUNNING")) return null;
  const hashes: string[] = [];
  for (const instance of [...instances].sort((left, right) =>
    left.id.localeCompare(right.id))) {
    const result = await dependencies.runReadinessCommand(executable, [
      "ssh",
      "--project", ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
      "--environment", ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
      "--service", ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
      "--deployment-instance", instance.id,
      "npm", "run", "--silent", "readiness:launch",
    ], token);
    if (result.code !== 0 || result.timedOut
      || !providerReadinessExact(result.stdout, expectedProfile)) return null;
    hashes.push(sha256Hex(result.stdout));
  }
  return hashes;
}

function durableWrite(directory: string, leaf: string, source: string): string {
  writePrivateExclusiveFile(directory, leaf, source);
  return sha256Hex(source);
}

export async function runProtectedAccountDeletionRehearsalRedeploy(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    now: Date.now,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    boundaryCheck: () => runRailwayMutationBoundaryCheck({
      argv: ["--policy", BOUNDARY_POLICY_PATH],
    }),
    validateCli: defaultValidateCli,
    runCommand: runRailwayCommand,
    runReadinessCommand: runRailwayReadinessCommand,
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
    transitionReceiptExact: false,
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
    targetPostflightExact: false,
    sourceUnchanged: false,
    twoReplicaRuntimeExact: false,
    accountDeletionRuntimeStateExact: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
  };
  let attempts: 0 | 1 = 0;
  let intentSha256: string | null = null;
  let terminalSha256: string | null = null;
  let command: CommandResult | null = null;
  let runtime: RuntimeProof = {
    exact: false,
    rounds: 0,
    replicaIdSha256s: [],
    responseSha256s: { "/health": [], "/startup": [], "/ready": [] },
    providerReadinessSha256s: [],
  };
  let outcome: "redeployed_active" | "redeployed_safe" | "already_safe"
    | "failed_before_attempt" | "mutation_uncertain" = "failed_before_attempt";
  let before: Snapshot | null = null;
  let metadataToken = "";
  let activationRunId: string | null = null;
  try {
    checks.policyExact = parseAccountDeletionRehearsalPolicy(
      fs.readFileSync(path.join(dependencies.cwd, POLICY_PATH), "utf8"),
    ) !== null;
    if (!args || !checks.policyExact) throw new Error("arguments_invalid");
    const runId = dependencies.env.GITHUB_RUN_ID ?? "";
    const transitionSource = dependencies.readFile(args.transitionTerminalFile);
    const transition = transitionTerminalBinding(transitionSource, args);
    const authoritySource = dependencies.readFile(args.authorityFile);
    checks.githubAuthorityExact = RUN_ID.test(runId)
      && dependencies.env.GITHUB_RUN_ATTEMPT === "1"
      && dependencies.env.GITHUB_REF === "refs/heads/main"
      && transition !== null
      && authorityExact(authoritySource, args, runId, transition);
    checks.transitionReceiptExact = transition !== null;
    if (!checks.githubAuthorityExact || !checks.transitionReceiptExact) {
      throw new Error("authority_invalid");
    }
    activationRunId = transition?.activationRunId ?? null;
    if (!activationRunId) throw new Error("transition_binding_invalid");
    const attemptArmFile =
      dependencies.env.PINTPATH_ACCOUNT_DELETION_REHEARSAL_ATTEMPT_ARM_FILE ?? "";
    const attemptArmSha256 =
      dependencies.env.PINTPATH_ACCOUNT_DELETION_REHEARSAL_ATTEMPT_ARM_SHA256 ?? "";
    const attemptArm = path.isAbsolute(attemptArmFile)
      ? parseAccountDeletionRehearsalAttemptArm(
        dependencies.readFile(attemptArmFile), {
          operation: args.operation,
          candidateSha: args.candidateSha,
          activationRunId,
          githubRunId: runId,
          authoritySource,
          prerequisiteSource: transitionSource,
          contentSha256: attemptArmSha256,
        },
      ) : null;
    checks.durableAttemptArmExact = attemptArm !== null;
    if (!attemptArm) throw new Error("attempt_arm_invalid");
    metadataToken = dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    const deployToken = dependencies.env.PINTPATH_RAILWAY_STAGING_DEPLOY_TOKEN ?? "";
    const productionMetadataToken =
      dependencies.env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
    const cli = dependencies.env.PINTPATH_RAILWAY_CLI_PATH ?? "";
    if (!TOKEN.test(metadataToken) || !TOKEN.test(deployToken)
      || !TOKEN.test(productionMetadataToken)
      || new Set([metadataToken, deployToken, productionMetadataToken]).size !== 3) {
      throw new Error("tokens_invalid");
    }
    const [metadataScope, deployScope] = await Promise.all([
      graphql(dependencies.fetchImpl, metadataToken,
        ACCOUNT_DELETION_REHEARSAL_SCOPE_QUERY, {}),
      graphql(dependencies.fetchImpl, deployToken,
        ACCOUNT_DELETION_REHEARSAL_SCOPE_QUERY, {}),
    ]);
    checks.tokenScopesExact =
      accountDeletionRehearsalTransitionInternals.scopeExact(metadataScope)
      && accountDeletionRehearsalTransitionInternals.scopeExact(deployScope);
    checks.cliExact = path.isAbsolute(cli) && dependencies.validateCli(cli);
    checks.boundaryPreflightExact = await dependencies.boundaryCheck() === 0;
    before = await readSnapshot(dependencies, metadataToken);
    checks.targetPreflightExact = before !== null
      && before.replicas === 2
      && before.candidateSha === args.candidateSha
      && Object.keys(before.patch).length === 0
      && (args.operation === "apply-active"
        ? rowNamesSatisfyActivationStored(before.rowNames, activationRunId)
        : rowNamesSatisfyCleanupStored(before.rowNames));
    if (!checks.tokenScopesExact || !checks.cliExact
      || !checks.boundaryPreflightExact || !checks.targetPreflightExact || !before) {
      throw new Error("preflight_invalid");
    }
    let safeAlreadyProven = false;
    if (args.operation === "apply-safe") {
      runtime = await runtimeProof(dependencies, args.candidateSha, "safe", 2);
      if (runtime.exact) {
        const providerReadinessSha256s =
          await proveProviderReadinessOnEveryInstance(
            dependencies, before.instances, cli, deployToken,
            "permanent_staging_complete", 2,
          );
        runtime = { ...runtime, exact: providerReadinessSha256s !== null,
          providerReadinessSha256s: providerReadinessSha256s ?? [] };
      }
      safeAlreadyProven = runtime.exact
        && runtime.replicaIdSha256s.length === 2
        && runtime.providerReadinessSha256s.length === 2;
    }
    checks.attemptPreflightExact = attemptArm.providerSnapshotSha256 ===
      accountDeletionRehearsalAttemptSnapshotSha256(before)
      || (args.operation === "apply-safe" && safeAlreadyProven);
    if (!checks.attemptPreflightExact) throw new Error("armed_snapshot_drift");
    const intent = canonicalJson({
      schemaVersion: "pintpath-account-deletion-rehearsal-redeploy-intent/v1",
      operation: args.operation,
      candidateSha: args.candidateSha,
      transitionRunId: args.transitionRunId,
      projectId: ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
      environmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
      serviceId: ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
      deploymentBeforeIdSha256: sha256Hex(before.deploymentId),
      imageDigestSha256: sha256Hex(before.imageDigest),
      command: ["redeploy", "--project", "<project>", "--environment",
        "<environment>", "--service", "<service>", "--yes", "--json"],
      sourceUploadAllowed: false,
      fromSourceAllowed: false,
      maximumAttempts: 1,
      retryAllowed: false,
      secretMaterialIncluded: false,
    });
    intentSha256 = dependencies.writeDurable(args.evidenceDirectory,
      "intent.json", intent);
    checks.durableIntentExact = intentSha256 === sha256Hex(intent);
    if (!checks.durableIntentExact) throw new Error("intent_invalid");
    let after: Snapshot | null = before;
    if (!safeAlreadyProven) {
      attempts = 1;
      command = await dependencies.runCommand(cli, [
        "redeploy",
        "--project", ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
        "--environment", ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
        "--service", ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
        "--yes",
        "--json",
      ], deployToken);
      checks.acknowledgementExact = command.code === 0 && !command.timedOut;
      checks.postflightAttempted = true;
      after = null;
      for (let round = 1; round <= MAX_ROUNDS; round += 1) {
        try {
          after = await readSnapshot(dependencies, metadataToken);
        } catch {
          after = null;
        }
        if (after && after.deploymentId !== before.deploymentId
          && after.replicas === 2 && after.candidateSha === args.candidateSha
          && after.imageDigest === before.imageDigest
          && Object.keys(after.patch).length === 0
          && (args.operation === "apply-active"
            ? rowNamesSatisfyActivationStored(after.rowNames, activationRunId)
            : rowNamesSatisfyCleanupStored(after.rowNames))) break;
        if (round === MAX_ROUNDS) break;
        await dependencies.sleep(10_000);
      }
    } else {
      checks.acknowledgementExact = true;
      checks.postflightAttempted = true;
    }
    checks.targetPostflightExact = after !== null
      && (safeAlreadyProven || after.deploymentId !== before.deploymentId)
      && after.replicas === 2
      && Object.keys(after.patch).length === 0
      && (args.operation === "apply-active"
        ? rowNamesSatisfyActivationStored(after.rowNames, activationRunId)
        : rowNamesSatisfyCleanupStored(after.rowNames));
    checks.sourceUnchanged = after !== null
      && after.candidateSha === before.candidateSha
      && after.imageDigest === before.imageDigest;
    if (!safeAlreadyProven && checks.targetPostflightExact && checks.sourceUnchanged) {
      runtime = await runtimeProof(
        dependencies,
        args.candidateSha,
        args.operation === "apply-active" ? "active" : "safe",
        2,
      );
      if (runtime.exact) {
        const providerReadinessSha256s =
          await proveProviderReadinessOnEveryInstance(
            dependencies,
            after!.instances,
            cli,
            deployToken,
            args.operation === "apply-active"
              ? "account_deletion_rehearsal"
              : "permanent_staging_complete",
            2,
          );
        runtime = {
          ...runtime,
          exact: providerReadinessSha256s !== null,
          providerReadinessSha256s: providerReadinessSha256s ?? [],
        };
      }
    }
    checks.twoReplicaRuntimeExact = runtime.exact
      && runtime.replicaIdSha256s.length === 2
      && new Set(runtime.replicaIdSha256s).size === 2;
    checks.accountDeletionRuntimeStateExact = runtime.exact;
    checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
    const success = checks.targetPostflightExact && checks.sourceUnchanged
      && checks.twoReplicaRuntimeExact && checks.accountDeletionRuntimeStateExact
      && checks.boundaryPostflightExact;
    outcome = success
      ? args.operation === "apply-active" ? "redeployed_active"
        : safeAlreadyProven ? "already_safe" : "redeployed_safe"
      : "mutation_uncertain";
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
    if (attempts === 1 && !checks.postflightAttempted) {
      checks.postflightAttempted = true;
      try {
        checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
      } catch {
        checks.boundaryPostflightExact = false;
      }
    }
  }
  const receipt = {
    schemaVersion: ACCOUNT_DELETION_REHEARSAL_REDEPLOY_SCHEMA,
    executorState: ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
    operation: args?.operation ?? null,
    outcome,
    candidateSha: args?.candidateSha ?? null,
    transitionRunId: args?.transitionRunId ?? null,
    activationRunId,
    githubRunId: dependencies.env.GITHUB_RUN_ID ?? null,
    attempts,
    retryAllowed: false,
    intentSha256,
    terminalSha256,
    command,
    runtime,
    checks,
  };
  if (args && checks.durableIntentExact) {
    try {
      const terminal = canonicalJson({
        schemaVersion: "pintpath-account-deletion-rehearsal-redeploy-terminal/v1",
        receipt,
        secretMaterialIncluded: false,
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
  return ["redeployed_active", "redeployed_safe", "already_safe"]
    .includes(final.outcome)
    && checks.terminalEvidenceExact ? 0 : 1;
}

export const accountDeletionRehearsalRedeployInternals = {
  authorityExact,
  parseArguments,
  readSnapshot,
  runtimeProof,
  providerReadinessExact,
  proveProviderReadinessOnEveryInstance,
  transitionTerminalExact,
  transitionTerminalBinding,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedAccountDeletionRehearsalRedeploy();
}
