import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRailwayMutationBoundaryCheck } from
  "./check-railway-mutation-boundary.js";
import {
  ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
  ACCOUNT_DELETION_REHEARSAL_LOCK,
  accountDeletionRehearsalActivationVariablesForRun,
  accountDeletionRehearsalAttemptSnapshotSha256,
  accountDeletionRehearsalCleanupPatchForRun,
  canonicalJson,
  exactCleanupPatch,
  parseAccountDeletionRehearsalPolicy,
  parseAccountDeletionRehearsalAttemptArm,
  rowNamesSatisfyActivationPreflight,
  rowNamesSatisfyActivationStored,
  rowNamesSatisfyCleanupStored,
  sha256Hex,
  uuidValueIsExact,
} from "./lib/permanent-staging-account-deletion-rehearsal.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

export const ACCOUNT_DELETION_REHEARSAL_TRANSITION_SCHEMA =
  "pintpath-account-deletion-rehearsal-transition/v1" as const;
export const ACCOUNT_DELETION_REHEARSAL_TRANSITION_TERMINAL_SCHEMA =
  "pintpath-account-deletion-rehearsal-transition-terminal/v1" as const;

const POLICY_PATH =
  "ops/railway/permanent-staging-account-deletion-rehearsal-policy.json";
const BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const TOKEN = /^[^\r\n\0]{16,4096}$/;
const MAX_BYTES = 1024 * 1024;

export const ACCOUNT_DELETION_REHEARSAL_SCOPE_QUERY =
  `query PintPathAccountDeletionRehearsalScope { projectToken { projectId environmentId } }`;
export const ACCOUNT_DELETION_REHEARSAL_METADATA_QUERY =
  `query PintPathAccountDeletionRehearsalMetadata(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
  $after: String
) {
  environment(id:$environmentId,projectId:$projectId) {
    id
    variables(first:100,after:$after) {
      edges { node { id name environmentId serviceId isSealed references } }
      pageInfo { hasNextPage endCursor }
    }
  }
  staged: environmentStagedChanges(environmentId:$environmentId) {
    environmentId
    patch(decryptVariables:false)
  }
  serviceInstance(environmentId:$environmentId,serviceId:$serviceId) {
    id
    serviceId
    environmentId
    numReplicas
    latestDeployment { id status deploymentStopped snapshotId }
    activeDeployments { id status deploymentStopped }
  }
}`;
export const ACCOUNT_DELETION_REHEARSAL_DEPLOYMENT_QUERY =
  `query PintPathAccountDeletionRehearsalDeployment($deploymentId:String!) {
  deployment(id:$deploymentId) {
    id projectId environmentId serviceId snapshotId meta
    instances { id status }
  }
}`;
export const ACCOUNT_DELETION_REHEARSAL_ACTIVATION_MUTATION =
  `mutation PintPathAccountDeletionRehearsalActivation(
  $projectId:String!
  $serviceId:String!
  $environmentId:String!
  $variables:EnvironmentVariables!
  $skipDeploys:Boolean
) {
  variableCollectionUpsert(input:{projectId:$projectId,serviceId:$serviceId,environmentId:$environmentId,variables:$variables,skipDeploys:$skipDeploys})
}`;
export const ACCOUNT_DELETION_REHEARSAL_CLEANUP_STAGE_MUTATION =
  `mutation PintPathAccountDeletionRehearsalCleanupStage(
  $environmentId:String!
  $input:EnvironmentConfig!
  $merge:Boolean
) {
  environmentStageChanges(environmentId:$environmentId,input:$input,merge:$merge) {
    id environmentId status createdAt updatedAt appliedAt message
  }
}`;
export const ACCOUNT_DELETION_REHEARSAL_CLEANUP_COMMIT_MUTATION =
  `mutation PintPathAccountDeletionRehearsalCleanupCommit(
  $environmentId:String!
  $commitMessage:String
  $skipDeploys:Boolean
) {
  environmentPatchCommitStaged(environmentId:$environmentId,commitMessage:$commitMessage,skipDeploys:$skipDeploys)
}`;
export const ACCOUNT_DELETION_REHEARSAL_CLEANUP_PATCH_READBACK_QUERY =
  `query PintPathAccountDeletionRehearsalCleanupPatchReadback(
  $environmentId:String!
) {
  masked: environmentStagedChanges(environmentId:$environmentId) {
    environmentId patch(decryptVariables:false)
  }
  decrypted: environmentStagedChanges(environmentId:$environmentId) {
    environmentId patch(decryptVariables:true)
  }
}`;

type Operation = "store-activation" | "store-cleanup" | "reconcile-cleanup"
  | "cleanup-contained-zero";

interface Arguments {
  readonly operation: Operation;
  readonly candidateSha: string;
  readonly authorityFile: string;
  readonly evidenceDirectory: string;
  readonly activationRunId: string | null;
  readonly prerequisiteFile: string | null;
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

interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  tokenScopesExact: boolean;
  boundaryPreflightExact: boolean;
  targetPreflightExact: boolean;
  durableAttemptArmExact: boolean;
  attemptPreflightExact: boolean;
  durableIntentExact: boolean;
  writeAttemptedAtMostOnce: boolean;
  stageAcknowledgementExact: boolean;
  stagedPatchReadbackExact: boolean;
  commitAcknowledgementExact: boolean;
  postflightAttempted: boolean;
  targetPostflightExact: boolean;
  deploymentUnchanged: boolean;
  boundaryPostflightExact: boolean;
  terminalEvidenceExact: boolean;
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly boundaryCheck: () => Promise<0 | 1>;
  readonly readAuthority: (filename: string) => string;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

function transitionPreflightState(
  snapshot: Snapshot,
  args: Arguments,
): {
  readonly targetPreflightExact: boolean;
  readonly exactStrandedCleanupPatch: boolean;
  readonly cleanupAlreadyStored: boolean;
} {
  const cleanupAtZero = (args.operation === "reconcile-cleanup"
      || args.operation === "cleanup-contained-zero")
    && snapshot.replicas === 0 && snapshot.instances.length === 0;
  const replicasExact = args.operation === "cleanup-contained-zero"
    ? cleanupAtZero : snapshot.replicas === 2 || cleanupAtZero;
  if (!replicasExact || snapshot.candidateSha !== args.candidateSha
    || args.activationRunId === null) {
    return { targetPreflightExact: false,
      exactStrandedCleanupPatch: false, cleanupAlreadyStored: false };
  }
  const patchEmpty = Object.keys(snapshot.patch).length === 0;
  const activeRowsExact = rowNamesSatisfyActivationStored(
    snapshot.rowNames,
    args.activationRunId,
  );
  const exactStrandedCleanupPatch = (args.operation === "reconcile-cleanup"
      || args.operation === "cleanup-contained-zero")
    && exactCleanupPatch(snapshot.patch, args.activationRunId)
    && activeRowsExact;
  const cleanupAlreadyStored = args.operation !== "store-activation"
    && patchEmpty && rowNamesSatisfyCleanupStored(snapshot.rowNames);
  return {
    exactStrandedCleanupPatch,
    cleanupAlreadyStored,
    targetPreflightExact: (patchEmpty && (
      args.operation === "store-activation"
        ? rowNamesSatisfyActivationPreflight(snapshot.rowNames)
        : activeRowsExact || cleanupAlreadyStored
    )) || exactStrandedCleanupPatch,
  };
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
  if (argv.length !== 10 && argv.length !== 12) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]
      || values.has(argv[index]!)) return null;
    values.set(argv[index]!, argv[index + 1]!);
  }
  const operation = values.get("--operation");
  const candidateSha = values.get("--candidate-sha") ?? "";
  const authorityFile = values.get("--authority-file") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const activationRunId = values.get("--activation-run-id") ?? null;
  const prerequisiteFile = values.get("--prerequisite-file") ?? null;
  if (
    !["store-activation", "store-cleanup", "reconcile-cleanup",
      "cleanup-contained-zero"].includes(
      operation ?? "",
    )
    || !SHA.test(candidateSha)
    || !path.isAbsolute(authorityFile)
    || !path.isAbsolute(evidenceDirectory)
    || !RUN_ID.test(activationRunId ?? "")
    || (prerequisiteFile !== null && !path.isAbsolute(prerequisiteFile))
    || (["reconcile-cleanup", "cleanup-contained-zero"].includes(operation ?? "")
      !== (prerequisiteFile !== null))
  ) return null;
  return {
    operation: operation as Operation,
    candidateSha,
    authorityFile,
    evidenceDirectory,
    activationRunId,
    prerequisiteFile,
  };
}

function emptyChecks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    tokenScopesExact: false,
    boundaryPreflightExact: false,
    targetPreflightExact: false,
    durableAttemptArmExact: false,
    attemptPreflightExact: false,
    durableIntentExact: false,
    writeAttemptedAtMostOnce: true,
    stageAcknowledgementExact: false,
    stagedPatchReadbackExact: false,
    commitAcknowledgementExact: false,
    postflightAttempted: false,
    targetPostflightExact: false,
    deploymentUnchanged: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const source = await response.text();
  if (!response.ok || Buffer.byteLength(source, "utf8") > MAX_BYTES
    || source.includes("\0")) throw new Error("provider_response_invalid");
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

function scopeExact(value: unknown): boolean {
  return exactKeys(value, ["data"])
    && exactKeys(value.data, ["projectToken"])
    && exactKeys(value.data.projectToken, ["projectId", "environmentId"])
    && value.data.projectToken.projectId === ACCOUNT_DELETION_REHEARSAL_LOCK.projectId
    && value.data.projectToken.environmentId ===
      ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId;
}

interface MetadataRow {
  readonly key: string;
  readonly name: string;
  readonly relevant: boolean;
}

interface MetadataPage {
  readonly rows: readonly MetadataRow[];
  readonly nextCursor: string | null;
  readonly replicas: number;
  readonly deploymentId: string;
  readonly snapshotId: string;
  readonly patch: Readonly<Record<string, unknown>>;
}

export interface AccountDeletionRehearsalMetadata {
  readonly rowNames: readonly string[];
  readonly replicas: number;
  readonly deploymentId: string;
  readonly snapshotId: string;
  readonly patch: Readonly<Record<string, unknown>>;
}

function parseMetadataPage(value: unknown): MetadataPage | null {
  if (!exactKeys(value, ["data"]) || !exactKeys(value.data, [
    "environment", "staged", "serviceInstance",
  ])) return null;
  const environment = value.data.environment;
  const staged = value.data.staged;
  const service = value.data.serviceInstance;
  if (!record(environment) || environment.id !==
      ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId
    || !record(environment.variables)
    || !Array.isArray(environment.variables.edges)
    || !record(environment.variables.pageInfo)
    || typeof environment.variables.pageInfo.hasNextPage !== "boolean"
    || !record(staged)
    || staged.environmentId !== ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId
    || !record(staged.patch)
    || !record(service)
    || service.serviceId !== ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId
    || service.environmentId !== ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId
    || !Number.isSafeInteger(service.numReplicas)
    || !record(service.latestDeployment)
    || !Array.isArray(service.activeDeployments)
    || service.activeDeployments.length !== 1
    || !record(service.activeDeployments[0])
    || service.latestDeployment.id !== service.activeDeployments[0].id
    || service.latestDeployment.status !== "SUCCESS"
    || service.activeDeployments[0].status !== "SUCCESS"
    || service.latestDeployment.deploymentStopped !== false
    || service.activeDeployments[0].deploymentStopped !== false
    || !uuidValueIsExact(service.latestDeployment.id)
    || !uuidValueIsExact(service.latestDeployment.snapshotId)) return null;
  const hasNextPage = environment.variables.pageInfo.hasNextPage;
  const endCursor = environment.variables.pageInfo.endCursor;
  if ((hasNextPage && (typeof endCursor !== "string" || endCursor.length === 0))
    || (!hasNextPage && !(endCursor === null || typeof endCursor === "string"))) {
    return null;
  }
  const rows: MetadataRow[] = [];
  const rowKeys = new Set<string>();
  for (const edge of environment.variables.edges) {
    if (!record(edge) || !record(edge.node)
      || typeof edge.node.name !== "string"
      || edge.node.environmentId !== ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId
      || !(edge.node.serviceId === null || typeof edge.node.serviceId === "string")
      || typeof edge.node.isSealed !== "boolean"
      || !Array.isArray(edge.node.references)) return null;
    const rowKey = `${String(edge.node.serviceId)}\0${edge.node.name}`;
    if (rowKeys.has(rowKey)) return null;
    rowKeys.add(rowKey);
    // Railway returns variables for every service in the environment. Only
    // global rows and rows scoped to Beer can affect this service; foreign
    // Postgres/Redis rows are structurally validated above and then ignored.
    rows.push({
      key: rowKey,
      name: edge.node.name,
      relevant: edge.node.serviceId === null
        || edge.node.serviceId === ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
    });
  }
  return {
    rows,
    nextCursor: hasNextPage ? endCursor as string : null,
    replicas: service.numReplicas as number,
    deploymentId: service.latestDeployment.id as string,
    snapshotId: service.latestDeployment.snapshotId as string,
    patch: staged.patch,
  };
}

function parseMetadata(value: unknown): AccountDeletionRehearsalMetadata | null {
  const page = parseMetadataPage(value);
  if (!page || page.nextCursor !== null) return null;
  return {
    rowNames: [...new Set(page.rows.filter((row) => row.relevant)
      .map((row) => row.name))].sort(),
    replicas: page.replicas,
    deploymentId: page.deploymentId,
    snapshotId: page.snapshotId,
    patch: page.patch,
  };
}

export async function collectAccountDeletionRehearsalMetadata(
  fetchPage: (after: string | null) => Promise<unknown>,
): Promise<AccountDeletionRehearsalMetadata | null> {
  const cursors = new Set<string>();
  const rowKeys = new Set<string>();
  const names = new Set<string>();
  let first: MetadataPage | null = null;
  let after: string | null = null;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = parseMetadataPage(await fetchPage(after));
    if (!page) return null;
    if (!first) first = page;
    else if (page.replicas !== first.replicas
      || page.deploymentId !== first.deploymentId
      || page.snapshotId !== first.snapshotId
      || canonicalJson(page.patch) !== canonicalJson(first.patch)) return null;
    for (const row of page.rows) {
      if (rowKeys.has(row.key)) return null;
      rowKeys.add(row.key);
      if (row.relevant) names.add(row.name);
    }
    if (rowKeys.size > 1_000) return null;
    if (page.nextCursor === null) {
      return {
        rowNames: [...names].sort(),
        replicas: page.replicas,
        deploymentId: page.deploymentId,
        snapshotId: page.snapshotId,
        patch: page.patch,
      };
    }
    if (cursors.has(page.nextCursor)) return null;
    cursors.add(page.nextCursor);
    after = page.nextCursor;
  }
  return null;
}

function parseDeployment(value: unknown, metadata: ReturnType<typeof parseMetadata>): {
  readonly candidateSha: string;
  readonly imageDigest: string;
  readonly canonicalDeployment: string;
  readonly instances: readonly { readonly id: string; readonly status: string }[];
} | null {
  if (!metadata || !exactKeys(value, ["data"])
    || !exactKeys(value.data, ["deployment"]) || !record(value.data.deployment)) {
    return null;
  }
  const deployment = value.data.deployment;
  if (deployment.id !== metadata.deploymentId
    || deployment.projectId !== ACCOUNT_DELETION_REHEARSAL_LOCK.projectId
    || deployment.environmentId !== ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId
    || deployment.serviceId !== ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId
    || deployment.snapshotId !== metadata.snapshotId
    || !record(deployment.meta)
    || typeof deployment.meta.commitHash !== "string"
    || !SHA.test(deployment.meta.commitHash)
    || typeof deployment.meta.imageDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(deployment.meta.imageDigest)
    || deployment.meta.patchId !== null
    || !Array.isArray(deployment.instances)
    || deployment.instances.some((instance) => !record(instance)
      || !uuidValueIsExact(instance.id)
      || typeof instance.status !== "string"
      || !/^[A-Z_]{1,32}$/.test(instance.status))) return null;
  return {
    candidateSha: deployment.meta.commitHash,
    imageDigest: deployment.meta.imageDigest,
    canonicalDeployment: canonicalJson(deployment),
    instances: deployment.instances as readonly {
      readonly id: string;
      readonly status: string;
    }[],
  };
}

async function snapshot(
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
  const deployment = parseDeployment(await graphql(
    dependencies.fetchImpl,
    metadataToken,
    ACCOUNT_DELETION_REHEARSAL_DEPLOYMENT_QUERY,
    { deploymentId: metadata.deploymentId },
  ), metadata);
  return deployment ? { ...metadata, ...deployment } : null;
}

function authorityExact(source: string, args: Arguments, runId: string): boolean {
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value)) return false;
    const expectedMode = args.operation === "store-activation" ? "start" : "cleanup";
    const sameRunCleanup = args.operation !== "store-activation"
      && args.activationRunId === runId;
    return value.schemaVersion === "pintpath-account-deletion-rehearsal-authority/v1"
      && value.executorState === ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE
      && (value.mode === expectedMode || (sameRunCleanup && value.mode === "start"))
      && value.candidateSha === args.candidateSha
      && value.githubRunId === runId
      && value.secretMaterialIncluded === false
      && (value.mode === "start"
        ? args.activationRunId === runId
          && record(value.reviewedPullRequest)
          && value.cleanupMayProceedAfterMainAdvances === false
        : record(value.originalActivation)
          && value.originalActivation.runId === args.activationRunId
          && value.cleanupMayProceedAfterMainAdvances === true);
  } catch {
    return false;
  }
}

function stageAcknowledgementExact(value: unknown): boolean {
  return exactKeys(value, ["data"])
    && exactKeys(value.data, ["environmentStageChanges"])
    && record(value.data.environmentStageChanges)
    && uuidValueIsExact(value.data.environmentStageChanges.id)
    && value.data.environmentStageChanges.environmentId ===
      ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId
    && value.data.environmentStageChanges.status === "STAGED";
}

function commitAcknowledgementExact(value: unknown): boolean {
  return exactKeys(value, ["data"])
    && exactKeys(value.data, ["environmentPatchCommitStaged"])
    && typeof value.data.environmentPatchCommitStaged === "string"
    && value.data.environmentPatchCommitStaged.length > 0
    && value.data.environmentPatchCommitStaged.length <= 256
    && !/[\r\n\0]/.test(value.data.environmentPatchCommitStaged);
}

function dualCleanupPatchReadbackExact(value: unknown, runId: string): boolean {
  if (!exactKeys(value, ["data"]) || !exactKeys(value.data, [
    "masked", "decrypted",
  ])) return false;
  for (const key of ["masked", "decrypted"] as const) {
    const staged = value.data[key];
    if (!exactKeys(staged, ["environmentId", "patch"])
      || staged.environmentId !==
        ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId
      || !exactCleanupPatch(staged.patch, runId)) return false;
  }
  return true;
}

function durableWrite(directory: string, leaf: string, source: string): string {
  writePrivateExclusiveFile(directory, leaf, Buffer.from(source));
  return sha256Hex(source);
}

function fixedReceipt(
  args: Arguments | null,
  operation: Operation | null,
  outcome: "activation_stored" | "cleanup_stored" | "cleanup_already_stored"
    | "failed_before_attempt" | "mutation_uncertain",
  attempts: 0 | 1,
  intentSha256: string | null,
  terminalSha256: string | null,
  checks: Checks,
) {
  return {
    schemaVersion: ACCOUNT_DELETION_REHEARSAL_TRANSITION_SCHEMA,
    executorState: ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
    operation,
    outcome,
    candidateSha: args?.candidateSha ?? null,
    githubRunId: args ? null : null,
    activationRunId: args?.activationRunId ?? null,
    attempts,
    retryAllowed: false as const,
    intentSha256,
    terminalSha256,
    checks,
  };
}

export async function runProtectedAccountDeletionRehearsalTransition(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    boundaryCheck: () => runRailwayMutationBoundaryCheck({
      argv: ["--policy", BOUNDARY_POLICY_PATH],
    }),
    readAuthority: (filename) => readTrustedRegularFile(filename, {
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
  const checks = emptyChecks();
  let attempts: 0 | 1 = 0;
  let intentSha256: string | null = null;
  let terminalSha256: string | null = null;
  let outcome: ReturnType<typeof fixedReceipt>["outcome"] =
    "failed_before_attempt";
  let before: Snapshot | null = null;
  let metadataToken = "";
  try {
    const policySource = fs.readFileSync(path.join(dependencies.cwd, POLICY_PATH), "utf8");
    checks.policyExact = parseAccountDeletionRehearsalPolicy(policySource) !== null;
    if (!args || !checks.policyExact) throw new Error("arguments_or_policy_invalid");
    const runId = dependencies.env.GITHUB_RUN_ID ?? "";
    const expectedConfirmation = args.operation === "store-activation"
      ? "ACTIVATE_ACCOUNT_DELETION_REHEARSAL_IN_PERMANENT_STAGING"
      : "CLEAN_UP_ACCOUNT_DELETION_REHEARSAL_IN_PERMANENT_STAGING";
    const authority = dependencies.readAuthority(args.authorityFile);
    checks.githubAuthorityExact = RUN_ID.test(runId)
      && dependencies.env.GITHUB_RUN_ATTEMPT === "1"
      && dependencies.env.GITHUB_REF === "refs/heads/main"
      && dependencies.env.PINTPATH_ACCOUNT_DELETION_REHEARSAL_CONFIRMATION ===
        expectedConfirmation
      && authorityExact(authority, args, runId);
    if (!checks.githubAuthorityExact) throw new Error("authority_invalid");
    const attemptArmFile =
      dependencies.env.PINTPATH_ACCOUNT_DELETION_REHEARSAL_ATTEMPT_ARM_FILE ?? "";
    const attemptArmSha256 =
      dependencies.env.PINTPATH_ACCOUNT_DELETION_REHEARSAL_ATTEMPT_ARM_SHA256 ?? "";
    const prerequisiteSource = args.prerequisiteFile === null
      ? null : dependencies.readAuthority(args.prerequisiteFile);
    const attemptArm = path.isAbsolute(attemptArmFile)
      ? parseAccountDeletionRehearsalAttemptArm(
        dependencies.readAuthority(attemptArmFile), {
          operation: args.operation,
          candidateSha: args.candidateSha,
          activationRunId: args.activationRunId!,
          githubRunId: runId,
          authoritySource: authority,
          prerequisiteSource,
          contentSha256: attemptArmSha256,
        },
      ) : null;
    checks.durableAttemptArmExact = attemptArm !== null;
    if (!attemptArm) throw new Error("attempt_arm_invalid");

    metadataToken = dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    const mutationToken =
      dependencies.env.PINTPATH_RAILWAY_STAGING_VARIABLE_MUTATION_TOKEN ?? "";
    const productionMetadataToken =
      dependencies.env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
    if (!TOKEN.test(metadataToken) || !TOKEN.test(mutationToken)
      || !TOKEN.test(productionMetadataToken)
      || new Set([metadataToken, mutationToken, productionMetadataToken]).size !== 3) {
      throw new Error("token_invalid");
    }
    const [metadataScope, mutationScope] = await Promise.all([
      graphql(dependencies.fetchImpl, metadataToken,
        ACCOUNT_DELETION_REHEARSAL_SCOPE_QUERY, {}),
      graphql(dependencies.fetchImpl, mutationToken,
        ACCOUNT_DELETION_REHEARSAL_SCOPE_QUERY, {}),
    ]);
    checks.tokenScopesExact = scopeExact(metadataScope) && scopeExact(mutationScope);
    checks.boundaryPreflightExact = await dependencies.boundaryCheck() === 0;
    if (!checks.tokenScopesExact || !checks.boundaryPreflightExact) {
      throw new Error("boundary_or_scope_invalid");
    }
    before = await snapshot(dependencies, metadataToken);
    if (!before) {
      throw new Error("target_invalid");
    }
    const preflight = transitionPreflightState(before, args);
    const { exactStrandedCleanupPatch, cleanupAlreadyStored } = preflight;
    checks.targetPreflightExact = preflight.targetPreflightExact;
    checks.attemptPreflightExact =
      attemptArm.providerSnapshotSha256 ===
        accountDeletionRehearsalAttemptSnapshotSha256(before)
      || (args.operation !== "store-activation"
        && (cleanupAlreadyStored || exactStrandedCleanupPatch));
    if (!checks.targetPreflightExact || !checks.attemptPreflightExact) {
      throw new Error("preflight_invalid");
    }
    if (cleanupAlreadyStored) {
      checks.postflightAttempted = true;
      checks.targetPostflightExact = true;
      checks.deploymentUnchanged = true;
      checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
      outcome = "cleanup_already_stored";
    } else {
      const binding = {
        operation: args.operation,
        candidateSha: args.candidateSha,
        activationRunId: args.activationRunId,
        projectId: ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
        environmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
        serviceId: ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
        mutation: args.operation === "store-activation"
          ? {
            name: "variableCollectionUpsert",
            variables: accountDeletionRehearsalActivationVariablesForRun(
              args.activationRunId!,
            ),
            skipDeploys: true,
          }
          : {
            stage: "environmentStageChanges",
            patch: accountDeletionRehearsalCleanupPatchForRun(
              args.activationRunId!,
            ),
            merge: false,
            commit: "environmentPatchCommitStaged",
            skipDeploys: true,
            resumeExactExistingPatch: exactStrandedCleanupPatch,
          },
        maximumAttempts: 1,
        retryAllowed: false,
        preflightSha256: sha256Hex(canonicalJson(before)),
        authoritySha256: sha256Hex(authority),
        secretMaterialIncluded: false,
      };
      const intent = canonicalJson({
        schemaVersion: "pintpath-account-deletion-rehearsal-transition-intent/v1",
        binding,
      });
      intentSha256 = dependencies.writeDurable(
        args.evidenceDirectory,
        "intent.json",
        intent,
      );
      checks.durableIntentExact = intentSha256 === sha256Hex(intent);
      if (!checks.durableIntentExact) throw new Error("intent_invalid");
      attempts = 1;
      if (args.operation === "store-activation") {
        const acknowledgement = await graphql(
          dependencies.fetchImpl,
          mutationToken,
          ACCOUNT_DELETION_REHEARSAL_ACTIVATION_MUTATION,
          {
            projectId: ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
            environmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
            serviceId: ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
            variables: accountDeletionRehearsalActivationVariablesForRun(
              args.activationRunId!,
            ),
            skipDeploys: true,
          },
        );
        checks.commitAcknowledgementExact = exactKeys(acknowledgement, ["data"])
          && exactKeys(acknowledgement.data, ["variableCollectionUpsert"])
          && acknowledgement.data.variableCollectionUpsert === true;
      } else {
        if (!exactStrandedCleanupPatch) {
          let stage: unknown = null;
          try {
            stage = await graphql(
              dependencies.fetchImpl,
              mutationToken,
              ACCOUNT_DELETION_REHEARSAL_CLEANUP_STAGE_MUTATION,
              {
                environmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
                input: accountDeletionRehearsalCleanupPatchForRun(
                  args.activationRunId!,
                ),
                merge: false,
              },
            );
          } catch {
            // Lost acknowledgement is reconciled by the exact masked readback.
          }
          checks.stageAcknowledgementExact = stageAcknowledgementExact(stage);
        }
        const staged = await snapshot(dependencies, metadataToken);
        const maskedExact = staged !== null
          && exactCleanupPatch(staged.patch, args.activationRunId!)
          && staged.canonicalDeployment === before.canonicalDeployment;
        // Only ask Railway to decrypt after the masked shape has proven that
        // this patch contains the fixed non-secret disabled/null cleanup map.
        // A foreign patch is rejected without ever reading decrypted values.
        if (maskedExact) {
          const readback = await graphql(
            dependencies.fetchImpl,
            metadataToken,
            ACCOUNT_DELETION_REHEARSAL_CLEANUP_PATCH_READBACK_QUERY,
            {
              environmentId:
                ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
            },
          );
          checks.stagedPatchReadbackExact =
            dualCleanupPatchReadbackExact(readback, args.activationRunId!);
        }
        if (!checks.stagedPatchReadbackExact) throw new Error("stage_uncertain");
        checks.boundaryPreflightExact = await dependencies.boundaryCheck() === 0;
        if (!checks.boundaryPreflightExact) throw new Error("precommit_boundary_invalid");
        const commit = await graphql(
          dependencies.fetchImpl,
          mutationToken,
          ACCOUNT_DELETION_REHEARSAL_CLEANUP_COMMIT_MUTATION,
          {
            environmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
            commitMessage: `Pint Path account-deletion rehearsal cleanup ${args.candidateSha}`,
            skipDeploys: true,
          },
        );
        checks.commitAcknowledgementExact = commitAcknowledgementExact(commit);
      }
      checks.postflightAttempted = true;
      const after = await snapshot(dependencies, metadataToken);
      checks.targetPostflightExact = after !== null
        && after.replicas === before.replicas
        && (after.replicas !== 0 || after.instances.length === 0)
        && Object.keys(after.patch).length === 0
        && (args.operation === "store-activation"
          ? rowNamesSatisfyActivationStored(
            after.rowNames,
            args.activationRunId!,
          )
          : rowNamesSatisfyCleanupStored(after.rowNames));
      checks.deploymentUnchanged = after !== null
        && before.canonicalDeployment === after.canonicalDeployment;
      checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
      const acknowledgementOrReconciled = args.operation === "store-activation"
        ? checks.commitAcknowledgementExact
        : checks.commitAcknowledgementExact || checks.targetPostflightExact;
      const success = acknowledgementOrReconciled && checks.targetPostflightExact
        && checks.deploymentUnchanged
        && checks.boundaryPostflightExact;
      outcome = success
        ? args.operation === "store-activation"
          ? "activation_stored"
          : "cleanup_stored"
        : "mutation_uncertain";
    }
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
    if (attempts === 1 && !checks.postflightAttempted && args && before) {
      checks.postflightAttempted = true;
      try {
        const after = await snapshot(dependencies, metadataToken);
        checks.targetPostflightExact = after !== null
          && after.replicas === before.replicas
          && (after.replicas !== 0 || after.instances.length === 0)
          && Object.keys(after.patch).length === 0
          && (args.operation === "store-activation"
            ? rowNamesSatisfyActivationStored(
              after.rowNames,
              args.activationRunId!,
            )
            : rowNamesSatisfyCleanupStored(after.rowNames));
        checks.deploymentUnchanged = after !== null
          && before.canonicalDeployment === after.canonicalDeployment;
      } catch {
        checks.targetPostflightExact = false;
      }
      try {
        checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
      } catch {
        checks.boundaryPostflightExact = false;
      }
    }
  }
  const runId = dependencies.env.GITHUB_RUN_ID ?? null;
  const provisional = {
    ...fixedReceipt(args, args?.operation ?? null, outcome, attempts,
      intentSha256, null, checks),
    githubRunId: runId,
  };
  if (args && (checks.durableIntentExact || outcome === "cleanup_already_stored")) {
    try {
      const terminal = canonicalJson({
        schemaVersion: ACCOUNT_DELETION_REHEARSAL_TRANSITION_TERMINAL_SCHEMA,
        receipt: provisional,
        secretMaterialIncluded: false,
        secretDerivedCommitmentsIncluded: false,
      });
      terminalSha256 = dependencies.writeDurable(
        args.evidenceDirectory,
        "terminal.json",
        terminal,
      );
      checks.terminalEvidenceExact = terminalSha256 === sha256Hex(terminal);
    } catch {
      checks.terminalEvidenceExact = false;
      if (attempts === 1) outcome = "mutation_uncertain";
    }
  }
  const receipt = {
    ...fixedReceipt(args, args?.operation ?? null, outcome, attempts,
      intentSha256, terminalSha256, checks),
    githubRunId: runId,
  };
  dependencies.writeOutput(`${JSON.stringify(receipt)}\n`);
  return ["activation_stored", "cleanup_stored", "cleanup_already_stored"]
    .includes(receipt.outcome) && checks.terminalEvidenceExact ? 0 : 1;
}

export const accountDeletionRehearsalTransitionInternals = {
  authorityExact,
  commitAcknowledgementExact,
  parseArguments,
  parseDeployment,
  parseMetadata,
  parseMetadataPage,
  scopeExact,
  stageAcknowledgementExact,
  transitionPreflightState,
  dualCleanupPatchReadbackExact,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedAccountDeletionRehearsalTransition();
}
