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
  ACCOUNT_DELETION_REHEARSAL_ATTEMPT_OPERATIONS,
  ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
  ACCOUNT_DELETION_REHEARSAL_LOCK,
  type AccountDeletionRehearsalAttemptOperation,
  type AccountDeletionRehearsalAttemptSnapshot,
  accountDeletionRehearsalAttemptInvariantSha256,
  canonicalJson,
  createAccountDeletionRehearsalAttemptArm,
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

const POLICY_PATH =
  "ops/railway/permanent-staging-account-deletion-rehearsal-policy.json";
const BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const TOKEN = /^[^\r\n\0]{16,4096}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BYTES = 1024 * 1024;

const QUARANTINE_RETRY_OPERATIONS = new Set<
  AccountDeletionRehearsalAttemptOperation
>([
  "quarantine-zero-retry-1",
  "quarantine-zero-retry-2",
]);

const QUARANTINE_RETRY_STATES = new Set([
  "SAFE_ONE_FINAL",
  "ACTIVATION_STORED_SAFE_TWO",
  "ACTIVE_TWO",
  "CLEANUP_STAGED_ACTIVE_TWO",
  "CLEANUP_STORED_ACTIVE_TWO",
  "CLEANUP_STORED_SAFE_TWO",
]);

interface Arguments {
  readonly operation: AccountDeletionRehearsalAttemptOperation;
  readonly candidateSha: string;
  readonly activationRunId: string;
  readonly authorityFile: string;
  readonly prerequisiteFile: string | null;
  readonly evidenceDirectory: string;
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly boundaryCheck: () => Promise<0 | 1>;
  readonly readFile: (filename: string) => string;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(argv: readonly string[]): Arguments | null {
  if (argv.length !== 10 && argv.length !== 12) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]
      || values.has(argv[index]!)) return null;
    values.set(argv[index]!, argv[index + 1]!);
  }
  const operation = values.get("--operation") as
    AccountDeletionRehearsalAttemptOperation | undefined;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const activationRunId = values.get("--activation-run-id") ?? "";
  const authorityFile = values.get("--authority-file") ?? "";
  const prerequisiteFile = values.get("--prerequisite-file") ?? null;
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  return operation && ACCOUNT_DELETION_REHEARSAL_ATTEMPT_OPERATIONS.includes(operation)
    && SHA.test(candidateSha) && RUN_ID.test(activationRunId)
    && path.isAbsolute(authorityFile)
    && (prerequisiteFile === null || path.isAbsolute(prerequisiteFile))
    && path.isAbsolute(evidenceDirectory)
    ? { operation, candidateSha, activationRunId, authorityFile,
        prerequisiteFile, evidenceDirectory }
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

async function readSnapshot(
  dependencies: Dependencies,
  token: string,
): Promise<AccountDeletionRehearsalAttemptSnapshot | null> {
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
      ACCOUNT_DELETION_REHEARSAL_DEPLOYMENT_QUERY, {
        deploymentId: metadata.deploymentId,
      }),
    metadata,
  );
  return deployment ? { ...metadata, ...deployment } : null;
}

function authorityExact(
  source: string,
  args: Arguments,
  githubRunId: string,
): boolean {
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value)
      || value.schemaVersion !== "pintpath-account-deletion-rehearsal-authority/v1"
      || value.executorState !== ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE
      || value.candidateSha !== args.candidateSha
      || value.githubRunId !== githubRunId
      || value.secretMaterialIncluded !== false) return false;
    if (value.mode === "start") {
      return args.activationRunId === githubRunId
        && record(value.reviewedPullRequest)
        && value.cleanupMayProceedAfterMainAdvances === false;
    }
    return value.mode === "cleanup"
      && args.operation !== "prepare-two"
      && args.operation !== "store-activation"
      && args.operation !== "apply-active"
      && record(value.originalActivation)
      && value.originalActivation.runId === args.activationRunId
      && value.cleanupMayProceedAfterMainAdvances === true;
  } catch {
    return false;
  }
}

function snapshotStateExact(
  snapshot: AccountDeletionRehearsalAttemptSnapshot,
  args: Arguments,
): boolean {
  if (snapshot.candidateSha !== args.candidateSha) return false;
  const patchEmpty = Object.keys(snapshot.patch).length === 0;
  switch (args.operation) {
    case "prepare-two":
      return patchEmpty && snapshot.replicas === 1
        && rowNamesSatisfyActivationPreflight(snapshot.rowNames);
    case "store-activation":
      return patchEmpty && snapshot.replicas === 2
        && rowNamesSatisfyActivationPreflight(snapshot.rowNames);
    case "apply-active":
    case "store-cleanup":
      return patchEmpty && snapshot.replicas === 2
        && rowNamesSatisfyActivationStored(
          snapshot.rowNames,
          args.activationRunId,
        );
    case "reconcile-cleanup":
      return (snapshot.replicas === 0 || snapshot.replicas === 2) && (
        (patchEmpty && (rowNamesSatisfyActivationStored(
          snapshot.rowNames,
          args.activationRunId,
        )
          || rowNamesSatisfyCleanupStored(snapshot.rowNames)))
        || (exactCleanupPatch(snapshot.patch, args.activationRunId)
          && rowNamesSatisfyActivationStored(
            snapshot.rowNames,
            args.activationRunId,
          ))
      );
    case "cleanup-contained-zero":
      return snapshot.replicas === 0 && snapshot.instances.length === 0
        && rowNamesSatisfyActivationStored(
          snapshot.rowNames,
          args.activationRunId,
        )
        && (patchEmpty || exactCleanupPatch(
          snapshot.patch,
          args.activationRunId,
        ));
    case "apply-safe":
      return patchEmpty && snapshot.replicas === 2
        && rowNamesSatisfyCleanupStored(snapshot.rowNames);
    case "converge-one":
      return patchEmpty && (snapshot.replicas === 1 || snapshot.replicas === 2)
        && (rowNamesSatisfyCleanupStored(snapshot.rowNames)
          || rowNamesSatisfyActivationPreflight(snapshot.rowNames));
    case "quarantine-zero":
      return [0, 1, 2].includes(snapshot.replicas)
        && snapshot.instances.length === snapshot.replicas
        && snapshot.instances.every((instance) => instance.status === "RUNNING")
        && (
        (patchEmpty && (
          rowNamesSatisfyActivationStored(
            snapshot.rowNames,
            args.activationRunId,
          )
          || rowNamesSatisfyCleanupStored(snapshot.rowNames)
        ))
        || (exactCleanupPatch(snapshot.patch, args.activationRunId)
          && rowNamesSatisfyActivationStored(
            snapshot.rowNames,
            args.activationRunId,
          ))
        );
    case "quarantine-zero-retry-1":
    case "quarantine-zero-retry-2":
      return [1, 2].includes(snapshot.replicas)
        && snapshot.instances.length === snapshot.replicas
        && snapshot.instances.every((instance) => instance.status === "RUNNING")
        && (
          (patchEmpty && (
            rowNamesSatisfyActivationStored(
              snapshot.rowNames,
              args.activationRunId,
            )
            || rowNamesSatisfyCleanupStored(snapshot.rowNames)
          ))
          || (exactCleanupPatch(snapshot.patch, args.activationRunId)
            && rowNamesSatisfyActivationStored(
              snapshot.rowNames,
              args.activationRunId,
            ))
        );
  }
}

function shaListExact(value: unknown, length: number): value is string[] {
  return Array.isArray(value) && value.length === length
    && new Set(value).size === length
    && value.every((entry) => typeof entry === "string" && SHA256.test(entry));
}

function responseHashesExact(value: unknown, replicas: number): boolean {
  if (!record(value)
    || JSON.stringify(Object.keys(value)) !==
      JSON.stringify(["/health", "/startup", "/ready"])) return false;
  return ["/health", "/startup", "/ready"].every((route) =>
    shaListExact(value[route], replicas));
}

function allChecksExact(value: unknown, requiredChecks: readonly string[]): boolean {
  return record(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify(requiredChecks)
    && requiredChecks.every((name) => value[name] === true);
}

function quarantineRetryObservationExact(
  source: string,
  snapshot: AccountDeletionRehearsalAttemptSnapshot,
  args: Arguments,
  githubRunId: string,
  authoritySource: string,
): boolean {
  if (!QUARANTINE_RETRY_OPERATIONS.has(args.operation)) return false;
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value) || canonicalJson(value) !== source
      || value.schemaVersion !==
        "pintpath-account-deletion-rehearsal-state-observation/v1"
      || value.executorState !== ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE
      || value.exact !== true
      || typeof value.state !== "string"
      || !QUARANTINE_RETRY_STATES.has(value.state)
      || value.candidateSha !== args.candidateSha
      || value.activationRunId !== args.activationRunId
      || value.githubRunId !== githubRunId
      || typeof value.implementationSha !== "string"
      || !SHA.test(value.implementationSha)
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
      || value.lock.publicOrigin !== ACCOUNT_DELETION_REHEARSAL_LOCK.publicOrigin
      || value.providerSnapshot.replicas !== snapshot.replicas
      || ![1, 2].includes(snapshot.replicas)
      || value.providerSnapshot.instanceCount !== snapshot.instances.length
      || snapshot.instances.length !== snapshot.replicas
      || !shaListExact(value.providerSnapshot.instanceIdSha256s,
        snapshot.instances.length)
      || canonicalJson(value.providerSnapshot.instanceIdSha256s) !==
        canonicalJson(snapshot.instances.map((instance) =>
          sha256Hex(instance.id)).sort())
      || !Array.isArray(value.providerSnapshot.instanceStatuses)
      || canonicalJson(value.providerSnapshot.instanceStatuses) !==
        canonicalJson(snapshot.instances.map((instance) => instance.status).sort())
      || value.providerSnapshot.instanceStatuses.some(
        (status) => status !== "RUNNING",
      )
      || value.providerSnapshot.deploymentIdSha256 !== sha256Hex(
        snapshot.deploymentId,
      )
      || value.providerSnapshot.snapshotIdSha256 !== sha256Hex(snapshot.snapshotId)
      || value.providerSnapshot.imageDigestSha256 !== sha256Hex(snapshot.imageDigest)
      || value.providerSnapshot.invariantSha256 !==
        accountDeletionRehearsalAttemptInvariantSha256(snapshot)
      || value.providerSnapshot.rowNamesSha256 !== sha256Hex(canonicalJson(
        [...snapshot.rowNames].sort(),
      ))
      || value.providerSnapshot.patchSha256 !== sha256Hex(canonicalJson(
        snapshot.patch,
      ))
      || value.runtime.replicas !== snapshot.replicas
      || value.runtime.publicExact !== true
      || value.runtime.providerExact !== true
      || value.runtime.runtimeUnavailableExact !== false
      || !shaListExact(value.runtime.replicaIdSha256s, snapshot.replicas)
      || !responseHashesExact(value.runtime.responseSha256s, snapshot.replicas)
      || !shaListExact(
        value.runtime.providerReadinessSha256s,
        snapshot.replicas,
      )) return false;
    const state = value.state;
    const expectedRuntime = [
      "ACTIVE_TWO",
      "CLEANUP_STAGED_ACTIVE_TWO",
      "CLEANUP_STORED_ACTIVE_TWO",
    ].includes(state) ? "active" : "safe";
    const expectedRows = state === "ACTIVATION_STORED_SAFE_TWO"
      || state === "ACTIVE_TWO" || state === "CLEANUP_STAGED_ACTIVE_TWO"
      ? "active" : "cleanup";
    const expectedPatch = state === "CLEANUP_STAGED_ACTIVE_TWO"
      ? "cleanup" : "empty";
    const expectedReplicas = state === "SAFE_ONE_FINAL" ? 1 : 2;
    if (snapshot.replicas !== expectedReplicas
      || value.runtime.expected !== expectedRuntime
      || value.providerSnapshot.rowCategory !== expectedRows
      || value.providerSnapshot.patchCategory !== expectedPatch) return false;
    const requiredChecks = [
      "policyExact",
      "githubAuthorityExact",
      "tokenScopesExact",
      "cliExact",
      "boundaryPreflightExact",
      "providerTopologyExact",
      "candidateExact",
      "rowCategoryExact",
      "stagedPatchExact",
      "activationMarkerExact",
      "runtimeProofExact",
      "boundaryPostflightExact",
    ];
    return allChecksExact(value.checks, requiredChecks);
  } catch {
    return false;
  }
}

function durableWrite(directory: string, leaf: string, source: string): string {
  writePrivateExclusiveFile(directory, leaf, source);
  return sha256Hex(source);
}

export async function runPrepareProtectedAccountDeletionRehearsalAction(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2), env: process.env, cwd: process.cwd(),
    fetchImpl: fetch,
    boundaryCheck: () => runRailwayMutationBoundaryCheck({
      argv: ["--policy", BOUNDARY_POLICY_PATH],
    }),
    readFile: (filename) => readTrustedRegularFile(filename, {
      minBytes: 1, maxBytes: 128 * 1024, requireOwner: true, requirePrivate: true,
    }).toString("utf8"),
    writeDurable: durableWrite,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const args = parseArguments(dependencies.argv);
  try {
    if (!args || dependencies.env.GITHUB_REF !== "refs/heads/main"
      || dependencies.env.GITHUB_RUN_ATTEMPT !== "1"
      || !RUN_ID.test(dependencies.env.GITHUB_RUN_ID ?? "")
      || parseAccountDeletionRehearsalPolicy(fs.readFileSync(
        path.join(dependencies.cwd, POLICY_PATH), "utf8")) === null) {
      throw new Error("preflight_invalid");
    }
    const githubRunId = dependencies.env.GITHUB_RUN_ID!;
    const authoritySource = dependencies.readFile(args.authorityFile);
    const prerequisiteSource = args.prerequisiteFile === null
      ? null : dependencies.readFile(args.prerequisiteFile);
    if ((args.operation === "cleanup-contained-zero"
        || QUARANTINE_RETRY_OPERATIONS.has(args.operation))
      && prerequisiteSource === null) throw new Error("prerequisite_invalid");
    if (!authorityExact(authoritySource, args, githubRunId)
      || await dependencies.boundaryCheck() !== 0) throw new Error("authority_invalid");
    const metadataToken =
      dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    const productionMetadataToken =
      dependencies.env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
    if (!TOKEN.test(metadataToken) || !TOKEN.test(productionMetadataToken)
      || metadataToken === productionMetadataToken) throw new Error("token_invalid");
    const scope = await graphql(dependencies.fetchImpl, metadataToken,
      ACCOUNT_DELETION_REHEARSAL_SCOPE_QUERY, {});
    if (!accountDeletionRehearsalTransitionInternals.scopeExact(scope)) {
      throw new Error("scope_invalid");
    }
    const snapshot = await readSnapshot(dependencies, metadataToken);
    if (!snapshot || !snapshotStateExact(snapshot, args)
      || (QUARANTINE_RETRY_OPERATIONS.has(args.operation)
        && (prerequisiteSource === null
          || !quarantineRetryObservationExact(
            prerequisiteSource,
            snapshot,
            args,
            githubRunId,
            authoritySource,
          )))
      || await dependencies.boundaryCheck() !== 0) throw new Error("state_invalid");
    const arm = createAccountDeletionRehearsalAttemptArm({
      operation: args.operation, candidateSha: args.candidateSha,
      activationRunId: args.activationRunId, githubRunId,
      authoritySource, prerequisiteSource, snapshot,
    });
    const source = canonicalJson(arm);
    const contentSha256 = dependencies.writeDurable(
      args.evidenceDirectory, "attempt-arm.json", source,
    );
    dependencies.writeOutput(`${JSON.stringify({
      ok: true,
      schemaVersion: arm.schemaVersion,
      operation: arm.operation,
      candidateSha: arm.candidateSha,
      activationRunId: arm.activationRunId,
      contentSha256,
      providerSnapshotSha256: arm.providerSnapshotSha256,
      providerInvariantSha256: arm.providerInvariantSha256,
      mutationCredentialExposed: false,
      secretMaterialIncluded: false,
    })}\n`);
    return 0;
  } catch {
    dependencies.writeOutput(`${JSON.stringify({
      ok: false,
      operation: args?.operation ?? null,
      candidateSha: args?.candidateSha ?? null,
      mutationCredentialExposed: false,
      secretMaterialIncluded: false,
    })}\n`);
    return 1;
  }
}

export const accountDeletionRehearsalActionPrepareInternals = {
  authorityExact, parseArguments, quarantineRetryObservationExact,
  readSnapshot, snapshotStateExact,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPrepareProtectedAccountDeletionRehearsalAction();
}
