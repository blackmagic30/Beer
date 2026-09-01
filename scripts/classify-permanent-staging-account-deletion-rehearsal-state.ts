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
  type AccountDeletionRehearsalAttemptSnapshot,
  accountDeletionRehearsalAttemptInvariantSha256,
  accountDeletionRehearsalRunMarkerName,
  canonicalJson,
  exactCleanupPatch,
  parseAccountDeletionRehearsalPolicy,
  rowNamesSatisfyActivationPreflight,
  rowNamesSatisfyActivationStored,
  rowNamesSatisfyCleanupStored,
  sha256Hex,
} from "./lib/permanent-staging-account-deletion-rehearsal.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

export const ACCOUNT_DELETION_REHEARSAL_OBSERVATION_SCHEMA =
  "pintpath-account-deletion-rehearsal-state-observation/v1" as const;

export type AccountDeletionRehearsalObservedState =
  | "SAFE_ONE_PREACTIVATION"
  | "SAFE_TWO_PREACTIVATION"
  | "ACTIVATION_STORED_SAFE_TWO"
  | "ACTIVE_TWO"
  | "CLEANUP_STAGED_ACTIVE_TWO"
  | "CLEANUP_STORED_ACTIVE_TWO"
  | "CLEANUP_STORED_SAFE_TWO"
  | "SAFE_ONE_FINAL"
  | "QUARANTINED_ZERO_PENDING_CLEANUP"
  | "QUARANTINED_ZERO"
  | "UNKNOWN";

const POLICY_PATH =
  "ops/railway/permanent-staging-account-deletion-rehearsal-policy.json";
const BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const TOKEN = /^[^\r\n\0]{16,4096}$/;
const MAX_BYTES = 1024 * 1024;

interface Arguments {
  readonly candidateSha: string;
  readonly activationRunId: string;
  readonly authorityFile: string;
  readonly evidenceDirectory: string;
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
  readonly runReadinessCommand: (
    executable: string,
    args: readonly string[],
    token: string,
  ) => Promise<{ readonly code: number | null; readonly timedOut: boolean;
    readonly stdout: string; readonly stderrSha256: string }>;
  readonly probeRuntimeAbsent: () => Promise<boolean>;
  readonly readFile: (filename: string) => string;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

interface ClassificationRuntimeProof {
  readonly expected: "active" | "safe" | "absent" | null;
  readonly replicas: number;
  readonly publicExact: boolean;
  readonly providerExact: boolean;
  readonly runtimeUnavailableExact: boolean;
  readonly replicaIdSha256s: readonly string[];
  readonly responseSha256s: Readonly<Record<"/health" | "/startup" | "/ready",
    readonly string[]>>;
  readonly providerReadinessSha256s: readonly string[];
}

type RowCategory = "preactivation" | "active" | "cleanup" | "unknown";

function rowCategory(
  rowNames: readonly string[],
  activationRunId: string,
): RowCategory {
  if (rowNamesSatisfyActivationStored(rowNames, activationRunId)) return "active";
  if (rowNamesSatisfyCleanupStored(rowNames)) return "cleanup";
  if (rowNamesSatisfyActivationPreflight(rowNames)) return "preactivation";
  return "unknown";
}

function patchCategory(
  patch: Readonly<Record<string, unknown>>,
  activationRunId: string,
): "empty" | "exact_cleanup" | "unknown" {
  if (Object.keys(patch).length === 0) return "empty";
  return exactCleanupPatch(patch, activationRunId) ? "exact_cleanup" : "unknown";
}

function quarantinedZeroState(
  snapshot: AccountDeletionRehearsalAttemptSnapshot,
  args: Pick<Arguments, "activationRunId" | "candidateSha">,
): "QUARANTINED_ZERO_PENDING_CLEANUP" | "QUARANTINED_ZERO" | null {
  if (snapshot.candidateSha !== args.candidateSha || snapshot.replicas !== 0
    || snapshot.instances.length !== 0) return null;
  const activeRowsExact = rowNamesSatisfyActivationStored(
    snapshot.rowNames,
    args.activationRunId,
  );
  if (Object.keys(snapshot.patch).length === 0) {
    if (rowNamesSatisfyCleanupStored(snapshot.rowNames)) {
      return "QUARANTINED_ZERO";
    }
    return activeRowsExact ? "QUARANTINED_ZERO_PENDING_CLEANUP" : null;
  }
  return activeRowsExact
    && exactCleanupPatch(snapshot.patch, args.activationRunId)
    ? "QUARANTINED_ZERO_PENDING_CLEANUP" : null;
}

function emptyRuntimeProof(replicas = 0): ClassificationRuntimeProof {
  return {
    expected: null,
    replicas,
    publicExact: false,
    providerExact: false,
    runtimeUnavailableExact: false,
    replicaIdSha256s: [],
    responseSha256s: { "/health": [], "/startup": [], "/ready": [] },
    providerReadinessSha256s: [],
  };
}

function twoReplicaObservedState(
  snapshot: AccountDeletionRehearsalAttemptSnapshot,
  args: Pick<Arguments, "activationRunId" | "candidateSha">,
  runtime: ClassificationRuntimeProof,
): AccountDeletionRehearsalObservedState | null {
  if (snapshot.candidateSha !== args.candidateSha || snapshot.replicas !== 2
    || snapshot.instances.length !== 2
    || snapshot.instances.some((instance) => instance.status !== "RUNNING")
    || !classificationRuntimeExact(runtime)) return null;
  const emptyPatch = Object.keys(snapshot.patch).length === 0;
  const exactStrandedCleanupPatch = exactCleanupPatch(
    snapshot.patch,
    args.activationRunId,
  );
  if (!emptyPatch && !exactStrandedCleanupPatch) return null;
  if (exactStrandedCleanupPatch) {
    return rowNamesSatisfyActivationStored(
      snapshot.rowNames,
      args.activationRunId,
    ) && runtime.expected === "active" ? "CLEANUP_STAGED_ACTIVE_TWO" : null;
  }
  if (rowNamesSatisfyActivationStored(snapshot.rowNames, args.activationRunId)) {
    return runtime.expected === "active" ? "ACTIVE_TWO"
      : runtime.expected === "safe" ? "ACTIVATION_STORED_SAFE_TWO" : null;
  }
  if (rowNamesSatisfyCleanupStored(snapshot.rowNames)) {
    return runtime.expected === "active" ? "CLEANUP_STORED_ACTIVE_TWO"
      : runtime.expected === "safe" ? "CLEANUP_STORED_SAFE_TWO" : null;
  }
  if (rowNamesSatisfyActivationPreflight(snapshot.rowNames)) {
    return runtime.expected === "safe" ? "SAFE_TWO_PREACTIVATION" : null;
  }
  return null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(argv: readonly string[]): Arguments | null {
  if (argv.length !== 8) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]
      || values.has(argv[index]!)) return null;
    values.set(argv[index]!, argv[index + 1]!);
  }
  const candidateSha = values.get("--candidate-sha") ?? "";
  const activationRunId = values.get("--activation-run-id") ?? "";
  const authorityFile = values.get("--authority-file") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  return SHA.test(candidateSha) && RUN_ID.test(activationRunId)
    && path.isAbsolute(authorityFile) && path.isAbsolute(evidenceDirectory)
    ? { candidateSha, activationRunId, authorityFile, evidenceDirectory }
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
    headers: { accept: "application/json", authorization: `Bearer ${token}`,
      "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  }));
}

async function readSnapshot(dependencies: Dependencies, token: string) {
  const metadata = await collectAccountDeletionRehearsalMetadata((after) =>
    graphql(dependencies.fetchImpl, token,
      ACCOUNT_DELETION_REHEARSAL_METADATA_QUERY, {
        projectId: ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
        environmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
        serviceId: ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
        after,
      }));
  if (!metadata) return null;
  const deployment = accountDeletionRehearsalTransitionInternals.parseDeployment(
    await graphql(dependencies.fetchImpl, token,
      ACCOUNT_DELETION_REHEARSAL_DEPLOYMENT_QUERY,
      { deploymentId: metadata.deploymentId }),
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
      || value.githubRunId !== runId || value.secretMaterialIncluded !== false) {
      return false;
    }
    return value.mode === "start"
      ? args.activationRunId === runId && record(value.reviewedPullRequest)
      : value.mode === "cleanup" && record(value.originalActivation)
        && value.originalActivation.runId === args.activationRunId
        && value.cleanupMayProceedAfterMainAdvances === true;
  } catch {
    return false;
  }
}

async function classifyRuntime(
  dependencies: Dependencies,
  snapshot: NonNullable<Awaited<ReturnType<typeof readSnapshot>>>,
  candidateSha: string,
  expected: "active" | "safe",
  token: string,
  cli: string,
): Promise<ClassificationRuntimeProof> {
  if (!(snapshot.replicas === 1 || snapshot.replicas === 2)
    || snapshot.instances.length !== snapshot.replicas
    || snapshot.instances.some((instance) => instance.status !== "RUNNING")) {
    return { ...emptyRuntimeProof(snapshot.replicas), expected };
  }
  const runtime = await runtimeProof(
    dependencies, candidateSha, expected, snapshot.replicas,
  );
  const provider = runtime.exact
    ? await proveProviderReadinessOnEveryInstance(
      dependencies, snapshot.instances, cli, token,
      expected === "active" ? "account_deletion_rehearsal"
        : "permanent_staging_complete",
      snapshot.replicas,
    ) : null;
  return {
    expected,
    replicas: snapshot.replicas,
    publicExact: runtime.exact
      && runtime.replicaIdSha256s.length === snapshot.replicas,
    providerExact: provider !== null && provider.length === snapshot.replicas,
    runtimeUnavailableExact: false,
    replicaIdSha256s: runtime.replicaIdSha256s,
    responseSha256s: runtime.responseSha256s,
    providerReadinessSha256s: provider ?? [],
  };
}

async function classifyRuntimeCandidates(
  dependencies: Dependencies,
  snapshot: NonNullable<Awaited<ReturnType<typeof readSnapshot>>>,
  candidateSha: string,
  expectedCandidates: readonly ("active" | "safe")[],
  token: string,
  cli: string,
): Promise<ClassificationRuntimeProof> {
  if (!(snapshot.replicas === 1 || snapshot.replicas === 2)
    || snapshot.instances.length !== snapshot.replicas
    || snapshot.instances.some((instance) => instance.status !== "RUNNING")) {
    return emptyRuntimeProof(snapshot.replicas);
  }
  for (const expected of expectedCandidates) {
    const provider = await proveProviderReadinessOnEveryInstance(
      dependencies,
      snapshot.instances,
      cli,
      token,
      expected === "active" ? "account_deletion_rehearsal"
        : "permanent_staging_complete",
      snapshot.replicas,
    );
    if (provider === null || provider.length !== snapshot.replicas) continue;
    const publicRuntime = await runtimeProof(
      dependencies,
      candidateSha,
      expected,
      snapshot.replicas,
    );
    const proof: ClassificationRuntimeProof = {
      expected,
      replicas: snapshot.replicas,
      publicExact: publicRuntime.exact
        && publicRuntime.replicaIdSha256s.length === snapshot.replicas,
      providerExact: true,
      runtimeUnavailableExact: false,
      replicaIdSha256s: publicRuntime.replicaIdSha256s,
      responseSha256s: publicRuntime.responseSha256s,
      providerReadinessSha256s: provider,
    };
    if (classificationRuntimeExact(proof)) return proof;
  }
  return emptyRuntimeProof(snapshot.replicas);
}

function classificationRuntimeExact(proof: ClassificationRuntimeProof): boolean {
  return proof.publicExact && proof.providerExact
    && proof.replicaIdSha256s.length === proof.replicas
    && proof.providerReadinessSha256s.length === proof.replicas;
}

function defaultValidateCli(filename: string): boolean {
  try {
    return sha256Hex(fs.readFileSync(filename)) ===
        ACCOUNT_DELETION_REHEARSAL_LOCK.railwayCliExecutableSha256
      && execFileSync(filename, ["--version"], {
        encoding: "utf8", timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() ===
        `railway ${ACCOUNT_DELETION_REHEARSAL_LOCK.railwayCliVersion}`;
  } catch {
    return false;
  }
}

function runReadinessCommand(
  executable: string,
  args: readonly string[],
  token: string,
): Promise<{ readonly code: number | null; readonly timedOut: boolean;
  readonly stdout: string; readonly stderrSha256: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
        env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent",
          RAILWAY_TOKEN: token, CI: "true" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      const stderr = crypto.createHash("sha256");
      let settled = false;
      let timedOut = false;
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
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); },
        120_000);
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}

async function defaultProbeRuntimeAbsent(): Promise<boolean> {
  for (const route of ["/health", "/startup", "/ready"] as const) {
    try {
      const response = await fetch(
        `${ACCOUNT_DELETION_REHEARSAL_LOCK.publicOrigin}${route}`,
        { method: "GET", redirect: "error", cache: "no-store",
          signal: AbortSignal.timeout(10_000) },
      );
      if (response.ok) return false;
    } catch { /* expected at zero */ }
  }
  return true;
}

function durableWrite(directory: string, leaf: string, source: string): string {
  writePrivateExclusiveFile(directory, leaf, source);
  return sha256Hex(source);
}

export async function runClassifyAccountDeletionRehearsalState(
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
    runReadinessCommand,
    probeRuntimeAbsent: defaultProbeRuntimeAbsent,
    readFile: (filename) => readTrustedRegularFile(filename, {
      minBytes: 1, maxBytes: 128 * 1024, requireOwner: true, requirePrivate: true,
    }).toString("utf8"),
    writeDurable: durableWrite,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const args = parseArguments(dependencies.argv);
  let state: AccountDeletionRehearsalObservedState = "UNKNOWN";
  let providerSnapshot: Awaited<ReturnType<typeof readSnapshot>> = null;
  let runtime = emptyRuntimeProof();
  let authoritySha256: string | null = null;
  const checks = {
    policyExact: false,
    githubAuthorityExact: false,
    tokenScopesExact: false,
    cliExact: false,
    boundaryPreflightExact: false,
    providerTopologyExact: false,
    candidateExact: false,
    rowCategoryExact: false,
    stagedPatchExact: false,
    activationMarkerExact: false,
    runtimeProofExact: false,
    boundaryPostflightExact: false,
  };
  try {
    const authoritySource = args
      ? dependencies.readFile(args.authorityFile) : "";
    authoritySha256 = args ? sha256Hex(authoritySource) : null;
    checks.policyExact = parseAccountDeletionRehearsalPolicy(fs.readFileSync(
      path.join(dependencies.cwd, POLICY_PATH), "utf8")) !== null;
    checks.githubAuthorityExact = args !== null
      && dependencies.env.GITHUB_REF === "refs/heads/main"
      && dependencies.env.GITHUB_RUN_ATTEMPT === "1"
      && authorityExact(authoritySource, args,
        dependencies.env.GITHUB_RUN_ID ?? "");
    const implementationSha = dependencies.env.GITHUB_SHA ?? "";
    const implementationExact = SHA.test(implementationSha);
    checks.boundaryPreflightExact = await dependencies.boundaryCheck() === 0;
    if (!args || dependencies.env.GITHUB_REF !== "refs/heads/main"
      || dependencies.env.GITHUB_RUN_ATTEMPT !== "1"
      || !checks.policyExact || !checks.githubAuthorityExact
      || !implementationExact
      || !checks.boundaryPreflightExact) throw new Error("preflight_invalid");
    const metadataToken =
      dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    const productionMetadataToken =
      dependencies.env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
    const cli = dependencies.env.PINTPATH_RAILWAY_CLI_PATH ?? "";
    if (!TOKEN.test(metadataToken) || !TOKEN.test(productionMetadataToken)
      || metadataToken === productionMetadataToken || !path.isAbsolute(cli)
      || !dependencies.validateCli(cli)) {
      throw new Error("token_invalid");
    }
    checks.cliExact = true;
    const scope = await graphql(dependencies.fetchImpl, metadataToken,
      ACCOUNT_DELETION_REHEARSAL_SCOPE_QUERY, {});
    const snapshot = await readSnapshot(dependencies, metadataToken);
    providerSnapshot = snapshot;
    checks.tokenScopesExact =
      accountDeletionRehearsalTransitionInternals.scopeExact(scope);
    checks.providerTopologyExact = snapshot !== null;
    checks.candidateExact = snapshot?.candidateSha === args.candidateSha;
    checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
    if (!checks.tokenScopesExact || !snapshot || !checks.candidateExact
      || !checks.boundaryPostflightExact) throw new Error("state_invalid");
    const emptyPatch = Object.keys(snapshot.patch).length === 0;
    const exactStrandedCleanupPatch = exactCleanupPatch(
      snapshot.patch,
      args.activationRunId,
    );
    const activeRowsExact = rowNamesSatisfyActivationStored(
      snapshot.rowNames,
      args.activationRunId,
    );
    const cleanupRowsExact = rowNamesSatisfyCleanupStored(snapshot.rowNames);
    const initialZeroState = quarantinedZeroState(snapshot, args);
    if (initialZeroState !== null) {
      const invariant = accountDeletionRehearsalAttemptInvariantSha256(snapshot);
      let stableObservations = 0;
      let observed = snapshot;
      for (let round = 0; round < 2; round += 1) {
        const exactZero = quarantinedZeroState(observed, args) === initialZeroState
          && accountDeletionRehearsalAttemptInvariantSha256(observed) === invariant
          && observed.candidateSha === args.candidateSha;
        if (!exactZero || !await dependencies.probeRuntimeAbsent()) break;
        stableObservations += 1;
        if (round === 0) {
          await dependencies.sleep(5_000);
          const next = await readSnapshot(dependencies, metadataToken);
          if (!next) break;
          observed = next;
          providerSnapshot = next;
        }
      }
      if (stableObservations === 2) {
        state = initialZeroState;
        runtime = {
          ...emptyRuntimeProof(0),
          expected: "absent",
          runtimeUnavailableExact: true,
        };
      }
    }
    else if ((emptyPatch || exactStrandedCleanupPatch)
      && snapshot.replicas === 2
      && activeRowsExact) {
      runtime = await classifyRuntimeCandidates(
        dependencies,
        snapshot,
        args.candidateSha,
        exactStrandedCleanupPatch ? ["active"] : ["active", "safe"],
        metadataToken,
        cli,
      );
      state = twoReplicaObservedState(snapshot, args, runtime) ?? "UNKNOWN";
    }
    else if (emptyPatch && snapshot.replicas === 2
      && cleanupRowsExact) {
      runtime = await classifyRuntimeCandidates(
        dependencies,
        snapshot,
        args.candidateSha,
        ["active", "safe"],
        metadataToken,
        cli,
      );
      state = twoReplicaObservedState(snapshot, args, runtime) ?? "UNKNOWN";
    }
    else if (emptyPatch && snapshot.replicas === 1
      && cleanupRowsExact) {
      runtime = await classifyRuntime(dependencies, snapshot, args.candidateSha,
        "safe", metadataToken, cli);
      if (classificationRuntimeExact(runtime)) state = "SAFE_ONE_FINAL";
    }
    else if (emptyPatch && snapshot.replicas === 1
      && rowNamesSatisfyActivationPreflight(snapshot.rowNames)) {
      runtime = await classifyRuntime(dependencies, snapshot, args.candidateSha,
        "safe", metadataToken, cli);
      if (classificationRuntimeExact(runtime)) state = "SAFE_ONE_PREACTIVATION";
    }
    else if (emptyPatch && snapshot.replicas === 2
      && rowNamesSatisfyActivationPreflight(snapshot.rowNames)) {
      runtime = await classifyRuntime(dependencies, snapshot, args.candidateSha,
        "safe", metadataToken, cli);
      if (classificationRuntimeExact(runtime)) state = "SAFE_TWO_PREACTIVATION";
    }
    const observedRows = providerSnapshot?.rowNames ?? snapshot.rowNames;
    const observedPatch = providerSnapshot?.patch ?? snapshot.patch;
    const observedCategory = rowCategory(observedRows, args.activationRunId);
    const observedPatchCategory = patchCategory(observedPatch, args.activationRunId);
    checks.rowCategoryExact = observedCategory !== "unknown";
    checks.stagedPatchExact = observedPatchCategory !== "unknown";
    checks.activationMarkerExact = observedCategory === "active"
      ? observedRows.filter((name) => name.startsWith(
        "ACCOUNT_DELETION_REHEARSAL_RUN_",
      )).length === 1
        && observedRows.includes(accountDeletionRehearsalRunMarkerName(
          args.activationRunId,
        ))
      : observedRows.every((name) => !name.startsWith(
        "ACCOUNT_DELETION_REHEARSAL_RUN_",
      ));
    checks.runtimeProofExact = state === "QUARANTINED_ZERO"
      || state === "QUARANTINED_ZERO_PENDING_CLEANUP"
      ? runtime.runtimeUnavailableExact : classificationRuntimeExact(runtime);
    const receipt = {
      schemaVersion: ACCOUNT_DELETION_REHEARSAL_OBSERVATION_SCHEMA,
      executorState: ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
      state, candidateSha: args.candidateSha,
      implementationSha,
      activationRunId: args.activationRunId,
      githubRunId: dependencies.env.GITHUB_RUN_ID,
      authoritySha256,
      exact: state !== "UNKNOWN",
      lock: {
        projectId: ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
        environmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
        serviceId: ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
        region: ACCOUNT_DELETION_REHEARSAL_LOCK.region,
        publicOrigin: ACCOUNT_DELETION_REHEARSAL_LOCK.publicOrigin,
      },
      providerSnapshot: {
        replicas: providerSnapshot?.replicas ?? snapshot.replicas,
        instanceCount: providerSnapshot?.instances.length ?? snapshot.instances.length,
        instanceIdSha256s: (providerSnapshot?.instances ?? snapshot.instances)
          .map((instance) => sha256Hex(instance.id)).sort(),
        instanceStatuses: (providerSnapshot?.instances ?? snapshot.instances)
          .map((instance) => instance.status).sort(),
        deploymentIdSha256: sha256Hex(
          providerSnapshot?.deploymentId ?? snapshot.deploymentId,
        ),
        snapshotIdSha256: sha256Hex(
          providerSnapshot?.snapshotId ?? snapshot.snapshotId,
        ),
        imageDigestSha256: sha256Hex(
          providerSnapshot?.imageDigest ?? snapshot.imageDigest,
        ),
        invariantSha256: accountDeletionRehearsalAttemptInvariantSha256(
          providerSnapshot ?? snapshot,
        ),
        rowNamesSha256: sha256Hex(canonicalJson([...observedRows].sort())),
        rowCategory: observedCategory,
        patchSha256: sha256Hex(canonicalJson(observedPatch)),
        patchCategory: observedPatchCategory,
      },
      runtime,
      checks,
      mutationCredentialExposed: false,
      secretMaterialIncluded: false,
    };
    const source = canonicalJson(receipt);
    const evidenceSha256 = dependencies.writeDurable(
      args.evidenceDirectory, "state-observation.json", source,
    );
    dependencies.writeOutput(`${JSON.stringify({ ...receipt, evidenceSha256 })}\n`);
    return state === "UNKNOWN" ? 1 : 0;
  } catch {
    dependencies.writeOutput(`${JSON.stringify({
      schemaVersion: ACCOUNT_DELETION_REHEARSAL_OBSERVATION_SCHEMA,
      state: "UNKNOWN", candidateSha: args?.candidateSha ?? null,
      implementationSha: dependencies.env.GITHUB_SHA ?? null,
      activationRunId: args?.activationRunId ?? null, exact: false,
      authoritySha256,
      checks,
      providerSnapshot: providerSnapshot ? {
        replicas: providerSnapshot.replicas,
        deploymentIdSha256: sha256Hex(providerSnapshot.deploymentId),
        snapshotIdSha256: sha256Hex(providerSnapshot.snapshotId),
        imageDigestSha256: sha256Hex(providerSnapshot.imageDigest),
        rowNamesSha256: sha256Hex(canonicalJson(
          [...providerSnapshot.rowNames].sort(),
        )),
        patchSha256: sha256Hex(canonicalJson(providerSnapshot.patch)),
      } : null,
      runtime,
      mutationCredentialExposed: false, secretMaterialIncluded: false,
    })}\n`);
    return 1;
  }
}

export const accountDeletionRehearsalStateClassifierInternals = {
  authorityExact, classificationRuntimeExact, classifyRuntime,
  classifyRuntimeCandidates, emptyRuntimeProof, parseArguments,
  quarantinedZeroState, rowCategory, twoReplicaObservedState,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runClassifyAccountDeletionRehearsalState();
}
