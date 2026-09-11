import { productionArchiveRuntime, productionProviderSourceExact } from "./lib/production-source-archive-authority.js";
import type { ProtectedSourceArchiveIdentity } from "../src/lib/protected-source-archive.js";
import { parseProductionArchiveDeploymentProviderSnapshotResponse } from "../src/lib/railway-application-deployment-attestation.js";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRailwayMutationBoundaryCheck } from
  "./check-railway-mutation-boundary.js";
import {
  parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse,
  parseRailwayApplicationDeploymentAttestationRuntimeResponse,
  type RailwayApplicationDeploymentAttestationProviderSnapshot,
} from "../src/lib/railway-application-deployment-attestation.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";
import {
  parseRailwayMultiRegionReplicaTopology,
  type RailwayRegionReplicaCount,
} from "./lib/railway-multi-region-replica-topology.js";
import {
  PROTECTED_SCALE_RECEIPT_SCHEMA,
  protectedScaleReplicaTopologyExact,
} from "./lib/protected-scale-receipt-topology.js";
import {
  parseProductionScaleActivationPrerequisiteVerification,
  type ProductionScaleActivationPrerequisiteVerification,
} from "./verify-production-maintenance-role-limit-prerequisites.js";
import {
  commitRailwayReplicaEnvironmentPatch,
  railwayEnvironmentPatchCommitVariables,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
  type RailwayEnvironmentPatchCommitAttempt,
  type RailwayRegionReplicaTarget,
} from "./lib/railway-environment-patch-commit.js";

export const PROTECTED_STAGING_SCALE_SCHEMA =
  PROTECTED_SCALE_RECEIPT_SCHEMA;
export const PROTECTED_STAGING_SCALE_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;

const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const PRODUCTION_ENVIRONMENT_ID = "13dab015-df74-45c6-b26f-69323daea99a";
const STAGING_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const REGION = "asia-southeast1-eqsg3a";
const LEGACY_STAGING_REGION = "europe-west4-drams3a";
const STAGING_DOMAIN = "beer-staging.up.railway.app";
const PRODUCTION_DOMAIN = "pintpath.au";
// Railway injects PORT=8080 for the deployed application. Keep the protected
// scale attestation bound to the same explicit port used by both live Railway
// domains and the documented production runtime contract.
const APPLICATION_TARGET_PORT = 8080;
const POLICY_PATH = "ops/railway/permanent-staging-scale-evidence-policy.json";
const POLICY_SHA256 =
  "e960db6dde4c367ae26148d5e4c0e013b8f8cb5e4923bdced9a606d965673cb0";
const BOUNDARY_POLICY_PATH = "ops/railway/production-staging-mutation-policy.json";
const GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
export const PROTECTED_SCALE_EXTERNAL_MUTATION_FREEZE_ATTESTATION =
  "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN" as const;
const EXTERNAL_MUTATION_FREEZE_ENFORCEMENT =
  "operational_attestation_only" as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const QUERY_TIMEOUT_MS = 20_000;
const RECONCILIATION_TIMEOUT_MS = 5 * 60_000;
const RECONCILIATION_INTERVAL_MS = 5_000;

export const PROTECTED_STAGING_SCALE_DISCOVERY_QUERY = `query PintPathProtectedScaleDiscovery(
  $environmentId: String!
  $serviceId: String!
) {
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    latestDeployment { id }
  }
}`;

export const PROTECTED_STAGING_SCALE_SNAPSHOT_QUERY = `query PintPathProtectedScaleSnapshot(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
  $deploymentId: String!
) {
  environment(id: $environmentId, projectId: $projectId) {
    id
    config(decryptVariables: false)
  }
  staged: environmentStagedChanges(environmentId: $environmentId) {
    environmentId
    patch(decryptVariables: false)
  }
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    id
    serviceId
    environmentId
    numReplicas
    source { repo image }
    latestDeployment { id status deploymentStopped snapshotId }
    activeDeployments { id status deploymentStopped }
    domains {
      serviceDomains { id domain targetPort }
      customDomains { id domain targetPort }
    }
  }
  deployment(id: $deploymentId) {
    id
    projectId
    environmentId
    serviceId
    snapshotId
    meta
  }
}`;

export const PROTECTED_STAGING_SCALE_TOKEN_SCOPE_QUERY =
  `query PintPathProtectedScaleTokenScope { projectToken { projectId environmentId } }`;
export const PROTECTED_STAGING_SCALE_PATCH_HISTORY_QUERY =
  `query PintPathProtectedScalePatchHistory(
  $environmentId: String!
  $after: String
) {
  environmentPatches(environmentId: $environmentId, first: 100, after: $after) {
    edges {
      cursor
      node {
        id
        environmentId
        status
        createdAt
        updatedAt
        appliedAt
        message
        patch(decryptVariables: false)
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const PROTECTED_STAGING_SCALE_PATCH_QUERY =
  `query PintPathProtectedScalePatch($id: String!) {
  environmentPatch(id: $id) {
    id
    environmentId
    status
    createdAt
    updatedAt
    appliedAt
    message
    patch(decryptVariables: false)
  }
}`;

type Direction =
  | "out"
  | "converge-one"
  | "converge-production-two"
  | "quiesce-staging-zero"
  | "bootstrap-staging-one";

type ReplicaCount = 0 | 1 | 2;

type RuntimeMaintenanceExpectation =
  | {
      readonly enabled: boolean;
      readonly candidateBound: boolean;
      readonly legacyIdentityOnly?: false;
      readonly sourceArchive?: ProtectedSourceArchiveIdentity;
    }
  | { readonly legacyIdentityOnly: true };

interface ScaleTarget {
  readonly environmentId: string;
  readonly domain: string;
}

interface ProtectedScaleSnapshot
  extends Omit<RailwayApplicationDeploymentAttestationProviderSnapshot, "deployment"> {
  readonly deployment: Omit<RailwayApplicationDeploymentAttestationProviderSnapshot["deployment"], "commitHash"> & { readonly commitHash: string | null };
  readonly sourceArchiveAuthority?: ProtectedSourceArchiveIdentity;
  readonly configuredReplicas: number;
  readonly configuredRegions: readonly RailwayRegionReplicaCount[];
  readonly serviceSource: {
    readonly repo: string | null;
    readonly image: string | null;
  };
  readonly environmentConfig: unknown;
  readonly stagedPatchEmpty: true;
}

const STAGING_TARGET: ScaleTarget = Object.freeze({
  environmentId: STAGING_ENVIRONMENT_ID,
  domain: STAGING_DOMAIN,
});
const PRODUCTION_TARGET: ScaleTarget = Object.freeze({
  environmentId: PRODUCTION_ENVIRONMENT_ID,
  domain: PRODUCTION_DOMAIN,
});

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly boundaryCheck: () => Promise<0 | 1>;
  readonly reassertRepositoryState: (cwd: string, candidateSha: string) => boolean;
  readonly validateProductionActivationPrerequisite: (
    source: string,
    expected: {
      readonly candidateSha: string;
      readonly currentRunId: string;
      readonly activateRunId: string;
      readonly now: Date;
    },
  ) => ProductionScaleActivationPrerequisiteVerification;
  readonly commitScale: (
    token: string,
    input: {
      readonly environmentId: string;
      readonly serviceId: string;
      readonly regions: readonly RailwayRegionReplicaTarget[];
      readonly commitMessage: string;
    },
  ) => Promise<RailwayEnvironmentPatchCommitAttempt>;
  readonly readPatchHistory: (
    token: string,
    environmentId: string,
    commitMessage: string,
    expectedPatch: unknown,
  ) => Promise<ScalePatchHistoryEvidence>;
  readonly probeRuntime: (
    target: ScaleTarget,
    candidateSha: string,
    deploymentId: string,
    expectation: RuntimeMaintenanceExpectation,
  ) => Promise<boolean>;
  readonly probeRuntimeAbsent: (target: ScaleTarget) => Promise<boolean>;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

interface ScaleReceipt {
  readonly schemaVersion: typeof PROTECTED_STAGING_SCALE_SCHEMA;
  readonly executorState: typeof PROTECTED_STAGING_SCALE_STATE;
  readonly direction: Direction | null;
  readonly outcome:
    | "scaled"
    | "reconciled_scaled"
    | "already_converged"
    | "blocked"
    | "failed_before_attempt"
    | "mutation_uncertain";
  readonly candidateSha: string | null;
  readonly githubRunId: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly desiredReplicas: ReplicaCount | null;
  readonly deploymentIdSha256: string | null;
  readonly attempts: 0 | 1;
  readonly retryAllowed: false;
  readonly intentSha256: string | null;
  readonly terminalEvidenceSha256: string | null;
  readonly directMutationEvidence: {
    readonly operationName:
      typeof RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME;
    readonly operation: "environmentPatchCommit";
    readonly transportOutcome:
      RailwayEnvironmentPatchCommitAttempt["outcome"] | null;
    readonly querySha256: string;
    readonly variablesSha256: string | null;
    readonly requestBodySha256: string | null;
    readonly responseBodySha256: string | null;
    readonly acknowledgementSha256: string | null;
    readonly acknowledgementExact: boolean;
    readonly commitMessageSha256: string | null;
    readonly zeroRegionsEncodedAsJsonNull: boolean;
    readonly providerCasOrLockVerified: false;
    readonly externalMutationFreezeEnforcement:
      typeof EXTERNAL_MUTATION_FREEZE_ENFORCEMENT;
  };
  readonly providerHistoryEvidence: {
    readonly prewrite: ScalePatchHistoryEvidence | null;
    readonly postflight: ScalePatchHistoryEvidence | null;
  };
  readonly productionActivationPrerequisite: {
    readonly runId: string;
    readonly verificationSha256: string;
    readonly terminalSha256: string;
    readonly prerequisitesSha256: string;
    readonly deploymentBeforeIdSha256: string;
    readonly deploymentAfterIdSha256: string;
  } | null;
  readonly replicaTopology: {
    readonly authoritySource: "environment.config(decryptVariables:false)";
    readonly primaryRegion: typeof REGION;
    readonly allowedRegions: readonly string[];
    readonly before: ReplicaTopologySnapshot | null;
    readonly immediatelyBeforeWrite: ReplicaTopologySnapshot | null;
    readonly after: ReplicaTopologySnapshot | null;
    readonly patchRegions: readonly RailwayRegionReplicaTarget[];
    readonly environmentConfigCollateralUnchanged: boolean;
  };
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
  readonly checks: {
    policyExact: boolean;
    githubAuthorityExact: boolean;
    externalMutationFreezeAttested: boolean;
    tokenScopesExact: boolean;
    directMutationContractExact: boolean;
    boundaryPreflightExact: boolean;
    targetPreflightExact: boolean;
    productionActivationPrerequisiteExact: boolean;
    productionActivationDeploymentContinuityExact: boolean;
    runtimePreflightExact: boolean;
    durableIntentExact: boolean;
    repositoryPrewriteReasserted: boolean;
    writeAttemptedAtMostOnce: boolean;
    mutationResponseClassified: boolean;
    acknowledgementExact: boolean;
    lostAcknowledgementExact: boolean;
    providerHistoryPrewriteExact: boolean;
    providerHistoryPostflightExact: boolean;
    postflightAttempted: boolean;
    targetPostflightExact: boolean;
    runtimePostflightExact: boolean;
    candidateUnchanged: boolean;
    deploymentUnchanged: boolean;
    providerConfigurationCollateralUnchanged: boolean;
    replicaTopologyEvidenceExact: boolean;
    boundaryPostflightExact: boolean;
    terminalEvidenceExact: boolean;
    finalReceiptEvidenceExact: boolean;
  };
}

interface ReplicaTopologySnapshot {
  readonly configuredReplicas: number;
  readonly configuredRegions: readonly RailwayRegionReplicaCount[];
  readonly configuredTopologySha256: string;
  readonly legacyAggregateReplicas: number | null;
  readonly serviceSourceSha256: string;
  readonly stagedPatchEmpty: true;
}

export interface ScalePatchHistoryEvidence {
  readonly querySha256: {
    readonly history: string;
    readonly patch: string;
  };
  readonly pages: readonly {
    readonly requestAfter: string | null;
    readonly count: number;
    readonly endCursor: string | null;
    readonly hasNextPage: boolean;
  }[];
  readonly pageCount: number;
  readonly rowCount: number;
  readonly rowsProjectionSha256: string;
  readonly nonMatchingRowsProjectionSha256: string;
  readonly paginationCompleteExact: boolean;
  readonly matchingPatchCount: number;
  readonly matchingPatch: {
    readonly rowIndex: 0;
    readonly idSha256: string;
    readonly status: "COMMITTED";
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly appliedAt: string;
    readonly messageSha256: string;
    readonly patchSha256: string;
    readonly crossFetchExact: true;
  } | null;
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort().map((key) => [
      key,
      sortObjectKeys((value as Record<string, unknown>)[key]),
    ]));
}

function canonicalProviderJson(value: unknown): string {
  return `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`;
}

function environmentConfigCollateral(value: unknown): unknown | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    if (typeof copy.services !== "object" || copy.services === null ||
      Array.isArray(copy.services)) return null;
    const service = (copy.services as Record<string, unknown>)[SERVICE_ID];
    if (typeof service !== "object" || service === null || Array.isArray(service)) {
      return null;
    }
    const deploy = (service as Record<string, unknown>).deploy;
    if (typeof deploy !== "object" || deploy === null || Array.isArray(deploy) ||
      !Object.hasOwn(deploy, "multiRegionConfig")) return null;
    delete (deploy as Record<string, unknown>).multiRegionConfig;
    return copy;
  } catch {
    return null;
  }
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((key, index) => actual[index] === key);
}

function parseArguments(argv: readonly string[]): {
  readonly direction: Direction;
  readonly candidateSha: string;
  readonly expectedDeploymentSha: string;
  readonly evidenceDirectory: string;
  readonly productionActivationRunId: string | null;
  readonly productionScaleVerificationFile: string | null;
} | null {
  if (argv.length !== 6 && argv.length !== 8 && argv.length !== 12) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]
      || values.has(argv[index]!)) return null;
    values.set(argv[index]!, argv[index + 1]!);
  }
  if ([...values.keys()].some((key) =>
    ![
      "--direction",
      "--candidate-sha",
      "--expected-deployment-sha",
      "--evidence-dir",
      "--production-activation-run-id",
      "--production-scale-verification-file",
    ].includes(key))) return null;
  const direction = values.get("--direction");
  const candidateSha = values.get("--candidate-sha") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const productionActivationRunId =
    values.get("--production-activation-run-id") ?? null;
  const productionScaleVerificationFile =
    values.get("--production-scale-verification-file") ?? null;
  if ((direction === "out" || direction === "converge-one") && argv.length === 6
    && !values.has("--expected-deployment-sha") && SHA_PATTERN.test(candidateSha)
    && path.isAbsolute(evidenceDirectory)) {
    return {
      direction,
      candidateSha,
      expectedDeploymentSha: candidateSha,
      evidenceDirectory,
      productionActivationRunId: null,
      productionScaleVerificationFile: null,
    };
  }
  const expectedDeploymentSha = values.get("--expected-deployment-sha") ?? "";
  if (!SHA_PATTERN.test(candidateSha) || !SHA_PATTERN.test(expectedDeploymentSha)
    || !path.isAbsolute(evidenceDirectory)) return null;
  if (direction === "converge-production-two") {
    const producerArgumentsExact =
      (productionActivationRunId === null
        && productionScaleVerificationFile === null)
      || (productionActivationRunId !== null
        && RUN_ID_PATTERN.test(productionActivationRunId)
        && productionScaleVerificationFile !== null
        && path.isAbsolute(productionScaleVerificationFile));
    return expectedDeploymentSha === candidateSha && producerArgumentsExact
      ? {
          direction,
          candidateSha,
          expectedDeploymentSha,
          evidenceDirectory,
          productionActivationRunId,
          productionScaleVerificationFile,
        }
      : null;
  }
  if (direction === "bootstrap-staging-one") {
    return expectedDeploymentSha === candidateSha
        && productionActivationRunId === null
        && productionScaleVerificationFile === null
      ? {
          direction,
          candidateSha,
          expectedDeploymentSha,
          evidenceDirectory,
          productionActivationRunId: null,
          productionScaleVerificationFile: null,
        }
      : null;
  }
  return direction === "quiesce-staging-zero"
    && expectedDeploymentSha !== candidateSha
    && productionActivationRunId === null
    && productionScaleVerificationFile === null
    ? {
        direction,
        candidateSha,
        expectedDeploymentSha,
        evidenceDirectory,
        productionActivationRunId: null,
        productionScaleVerificationFile: null,
      }
    : null;
}

function readProductionActivationPrerequisite(
  filename: string,
  evidenceDirectory: string,
): string {
  if (
    !path.isAbsolute(filename)
    || path.basename(filename)
      !== "production-scale-activation-verification.json"
    || path.dirname(path.resolve(filename)) !== fs.realpathSync(evidenceDirectory)
  ) throw new Error("activation_prerequisite_invalid");
  try {
    const source = readTrustedRegularFile(filename, {
      minBytes: 2,
      maxBytes: 1024 * 1024,
      requireOwner: true,
      requirePrivate: true,
    }).toString("utf8");
    if (source.includes("\0")) throw new Error("activation_prerequisite_invalid");
    return source;
  } catch {
    throw new Error("activation_prerequisite_invalid");
  }
}

function reassertRepositoryState(cwd: string, candidateSha: string): boolean {
  try {
    const run = (args: readonly string[]): string => execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    execFileSync("git", [
      "fetch",
      "--no-tags",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ], { cwd, stdio: ["ignore", "ignore", "ignore"] });
    return run(["rev-parse", "HEAD"]) === candidateSha
      && run(["rev-parse", "refs/remotes/origin/main"]) === candidateSha
      && run(["status", "--porcelain=v2", "--untracked-files=all"]) === "";
  } catch {
    return false;
  }
}

function durableWrite(directory: string, leaf: string, source: string): string {
  try {
    writePrivateExclusiveFile(directory, leaf, source, { requireOwner: true });
  } catch {
    throw new Error("evidence_invalid");
  }
  return sha256(source);
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !/^application\/json(?:;|$)/i.test(
    response.headers.get("content-type") ?? "",
  )) throw new Error("provider_response_invalid");
  const source = await response.text();
  if (Buffer.byteLength(source) > MAX_RESPONSE_BYTES) {
    throw new Error("provider_response_invalid");
  }
  return JSON.parse(source) as unknown;
}

async function graphql(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Project-Access-Token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  return await readJson(response);
}

function parseScope(value: unknown, environmentId = STAGING_ENVIRONMENT_ID): boolean {
  return exactKeys(value, ["data"])
    && exactKeys(value.data, ["projectToken"])
    && exactKeys(value.data.projectToken, ["projectId", "environmentId"])
    && value.data.projectToken.projectId === PROJECT_ID
    && value.data.projectToken.environmentId === environmentId;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

export async function readPatchHistory(
  fetchImpl: typeof fetch,
  token: string,
  environmentId: string,
  commitMessage: string,
  expectedPatch: unknown,
): Promise<ScalePatchHistoryEvidence> {
  let after: string | null = null;
  let previousCreatedAt: number | null = null;
  const ids = new Set<string>();
  const cursors = new Set<string>();
  const endCursors = new Set<string>();
  const pages: Array<ScalePatchHistoryEvidence["pages"][number]> = [];
  const projections: unknown[] = [];
  const nonMatchingProjections: unknown[] = [];
  const matchingNodes: Record<string, unknown>[] = [];
  while (pages.length < 8) {
    const requestAfter: string | null = after;
    const value = await graphql(
      fetchImpl,
      token,
      PROTECTED_STAGING_SCALE_PATCH_HISTORY_QUERY,
      { environmentId, after },
    );
    if (!exactKeys(value, ["data"]) ||
      !exactKeys(value.data, ["environmentPatches"]) ||
      !exactKeys(value.data.environmentPatches, ["edges", "pageInfo"]) ||
      !Array.isArray(value.data.environmentPatches.edges) ||
      value.data.environmentPatches.edges.length > 100 ||
      !exactKeys(value.data.environmentPatches.pageInfo, [
        "hasNextPage",
        "endCursor",
      ]) || typeof value.data.environmentPatches.pageInfo.hasNextPage !== "boolean") {
      throw new Error("provider_patch_history_invalid");
    }
    const edges = value.data.environmentPatches.edges;
    const pageInfo = value.data.environmentPatches.pageInfo;
    const hasNextPage = pageInfo.hasNextPage as boolean;
    if (hasNextPage && edges.length !== 100) {
      throw new Error("provider_patch_history_invalid");
    }
    for (const edge of edges) {
      if (!exactKeys(edge, ["cursor", "node"]) ||
        typeof edge.cursor !== "string" || edge.cursor.length < 1 ||
        edge.cursor.length > 4096 || cursors.has(edge.cursor) ||
        !exactKeys(edge.node, [
          "id",
          "environmentId",
          "status",
          "createdAt",
          "updatedAt",
          "appliedAt",
          "message",
          "patch",
        ]) || typeof edge.node.id !== "string" ||
        !UUID_PATTERN.test(edge.node.id) || ids.has(edge.node.id) ||
        edge.node.environmentId !== environmentId ||
        typeof edge.node.status !== "string" ||
        !canonicalTimestamp(edge.node.createdAt) ||
        !canonicalTimestamp(edge.node.updatedAt) ||
        !(edge.node.appliedAt === null || canonicalTimestamp(edge.node.appliedAt)) ||
        !(edge.node.message === null || typeof edge.node.message === "string")) {
        throw new Error("provider_patch_history_invalid");
      }
      const createdAt = Date.parse(edge.node.createdAt);
      const updatedAt = Date.parse(edge.node.updatedAt);
      const appliedAt = edge.node.appliedAt === null
        ? null
        : Date.parse(edge.node.appliedAt);
      if (createdAt > updatedAt || (appliedAt !== null && appliedAt > updatedAt)) {
        throw new Error("provider_patch_history_invalid");
      }
      if (previousCreatedAt !== null && createdAt >= previousCreatedAt) {
        throw new Error("provider_patch_history_invalid");
      }
      previousCreatedAt = createdAt;
      cursors.add(edge.cursor);
      ids.add(edge.node.id);
      if (ids.size > 800) throw new Error("provider_patch_history_invalid");
      const isMatch = edge.node.message === commitMessage;
      const projection = {
        id: edge.node.id,
        environmentId: edge.node.environmentId,
        status: edge.node.status,
        createdAt: edge.node.createdAt,
        updatedAt: edge.node.updatedAt,
        appliedAt: edge.node.appliedAt,
        messageMatchesTarget: isMatch,
      };
      projections.push(projection);
      if (!isMatch) nonMatchingProjections.push(projection);
      if (isMatch) {
        if (projections.length !== 1) {
          throw new Error("provider_patch_history_invalid");
        }
        if (edge.node.status !== "COMMITTED" ||
          !canonicalTimestamp(edge.node.appliedAt) ||
          canonicalProviderJson(edge.node.patch) !==
            canonicalProviderJson(expectedPatch)) {
          throw new Error("provider_patch_history_invalid");
        }
        matchingNodes.push(edge.node);
      }
    }
    const endCursor = pageInfo.endCursor;
    if (!(endCursor === null || typeof endCursor === "string") ||
      (edges.length === 0 ? endCursor !== null :
        endCursor !== (edges.at(-1) as Record<string, unknown>).cursor) ||
      (typeof endCursor === "string" && endCursors.has(endCursor))) {
      throw new Error("provider_patch_history_invalid");
    }
    if (typeof endCursor === "string") endCursors.add(endCursor);
    pages.push({
      requestAfter,
      count: edges.length,
      endCursor,
      hasNextPage,
    });
    if (!hasNextPage) break;
    if (typeof endCursor !== "string" || endCursor === requestAfter) {
      throw new Error("provider_patch_history_invalid");
    }
    after = endCursor;
  }
  if (pages.length === 0 || pages.at(-1)?.hasNextPage !== false ||
    matchingNodes.length > 1) throw new Error("provider_patch_history_invalid");
  let matchingPatch: ScalePatchHistoryEvidence["matchingPatch"] = null;
  if (matchingNodes.length === 1) {
    const node = matchingNodes[0]!;
    const crossFetched = await graphql(
      fetchImpl,
      token,
      PROTECTED_STAGING_SCALE_PATCH_QUERY,
      { id: node.id },
    );
    if (!exactKeys(crossFetched, ["data"]) ||
      !exactKeys(crossFetched.data, ["environmentPatch"]) ||
      canonicalProviderJson(crossFetched.data.environmentPatch) !==
        canonicalProviderJson(node)) {
      throw new Error("provider_patch_history_invalid");
    }
    matchingPatch = {
      rowIndex: 0,
      idSha256: sha256(node.id as string),
      status: "COMMITTED",
      createdAt: node.createdAt as string,
      updatedAt: node.updatedAt as string,
      appliedAt: node.appliedAt as string,
      messageSha256: sha256(commitMessage),
      patchSha256: sha256(canonicalProviderJson(expectedPatch)),
      crossFetchExact: true,
    };
  }
  return {
    querySha256: {
      history: sha256(PROTECTED_STAGING_SCALE_PATCH_HISTORY_QUERY),
      patch: sha256(PROTECTED_STAGING_SCALE_PATCH_QUERY),
    },
    pages,
    pageCount: pages.length,
    rowCount: projections.length,
    rowsProjectionSha256: sha256(canonicalProviderJson(projections)),
    nonMatchingRowsProjectionSha256: sha256(
      canonicalProviderJson(nonMatchingProjections),
    ),
    paginationCompleteExact: true,
    matchingPatchCount: matchingNodes.length,
    matchingPatch,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
}

function parseDiscovery(value: unknown): string | null {
  if (!exactKeys(value, ["data"])
    || !exactKeys(value.data, ["serviceInstance"])
    || !exactKeys(value.data.serviceInstance, ["latestDeployment"])
    || !exactKeys(value.data.serviceInstance.latestDeployment, ["id"])
    || typeof value.data.serviceInstance.latestDeployment.id !== "string"
    || !UUID_PATTERN.test(value.data.serviceInstance.latestDeployment.id)) return null;
  return value.data.serviceInstance.latestDeployment.id;
}

async function querySnapshot(
  fetchImpl: typeof fetch,
  token: string,
  target: ScaleTarget = STAGING_TARGET,
  sourceArchive?: ProtectedSourceArchiveIdentity,
): Promise<ProtectedScaleSnapshot> {
  const deploymentId = parseDiscovery(await graphql(
    fetchImpl,
    token,
    PROTECTED_STAGING_SCALE_DISCOVERY_QUERY,
    { environmentId: target.environmentId, serviceId: SERVICE_ID },
  ));
  if (!deploymentId) throw new Error("provider_snapshot_invalid");
  const response = await graphql(
    fetchImpl,
    token,
    PROTECTED_STAGING_SCALE_SNAPSHOT_QUERY,
    {
      projectId: PROJECT_ID,
      environmentId: target.environmentId,
      serviceId: SERVICE_ID,
      deploymentId,
    },
  );
  if (!exactKeys(response, ["data"])
    || !exactKeys(response.data, [
      "environment",
      "staged",
      "serviceInstance",
      "deployment",
    ])
    || !exactKeys(response.data.environment, ["id", "config"])
    || response.data.environment.id !== target.environmentId
    || !exactKeys(response.data.staged, ["environmentId", "patch"])
    || response.data.staged.environmentId !== target.environmentId
    || !exactKeys(response.data.staged.patch, [])
    || typeof response.data.serviceInstance !== "object"
    || response.data.serviceInstance === null
    || Array.isArray(response.data.serviceInstance)) {
    throw new Error("provider_snapshot_invalid");
  }
  const serviceInstanceRecord = response.data.serviceInstance as
    Record<string, unknown>;
  if (!exactKeys(serviceInstanceRecord.source, ["repo", "image"])
    || !(serviceInstanceRecord.source.repo === null ||
      typeof serviceInstanceRecord.source.repo === "string")
    || !(serviceInstanceRecord.source.image === null ||
      typeof serviceInstanceRecord.source.image === "string")) {
    throw new Error("provider_snapshot_invalid");
  }
  const topology = parseRailwayMultiRegionReplicaTopology(
    response.data.environment.config,
    SERVICE_ID,
  );
  if (topology.kind !== "configured") {
    throw new Error("provider_snapshot_invalid");
  }
  const { source: serviceSource, ...serviceInstance } =
    serviceInstanceRecord;
  const source = JSON.stringify({
    data: {
      serviceInstance,
      deployment: response.data.deployment,
    },
  });
  const snapshot = sourceArchive
    ? parseProductionArchiveDeploymentProviderSnapshotResponse(source, sourceArchive)
    : parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(source);
  if (!snapshot) throw new Error("provider_snapshot_invalid");
  const collateralConfig = environmentConfigCollateral(
    response.data.environment.config,
  );
  if (collateralConfig === null) throw new Error("provider_snapshot_invalid");
  return Object.freeze({
    ...snapshot,
    ...(sourceArchive ? { sourceArchiveAuthority: sourceArchive } : {}),
    configuredReplicas: topology.configuredTotal,
    configuredRegions: topology.regions,
    serviceSource: Object.freeze({
      repo: (serviceSource as Record<string, unknown>).repo as string | null,
      image: (serviceSource as Record<string, unknown>).image as string | null,
    }),
    environmentConfig: response.data.environment.config,
    stagedPatchEmpty: true as const,
  });
}

async function probeRuntime(
  fetchImpl: typeof fetch,
  target: ScaleTarget,
  candidateSha: string,
  deploymentId: string,
  expectation: RuntimeMaintenanceExpectation,
): Promise<boolean> {
  for (const route of ["/health", "/startup", "/ready"] as const) {
    const response = await fetchImpl(`https://${target.domain}${route}`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const source = await response.text();
    if (Buffer.byteLength(source, "utf8") > MAX_RESPONSE_BYTES) return false;
    if ("legacyIdentityOnly" in expectation) {
      if (!legacyRuntimeIdentityExact(route, source, candidateSha)) return false;
      continue;
    }
    const runtime = expectation.sourceArchive
      ? productionArchiveRuntime(route, source, candidateSha, expectation.sourceArchive)
      : parseRailwayApplicationDeploymentAttestationRuntimeResponse(route, source);
    if (
      !runtime
      || (!expectation.sourceArchive && runtime.deployment.commitSha !== candidateSha)
      || runtime.deployment.projectIdSha256
        !== railwayDeploymentIdentityIdSha256("project", PROJECT_ID)
      || runtime.deployment.environmentIdSha256
        !== railwayDeploymentIdentityIdSha256("environment", target.environmentId)
      || runtime.deployment.serviceIdSha256
        !== railwayDeploymentIdentityIdSha256("service", SERVICE_ID)
      || runtime.deployment.deploymentIdSha256
        !== railwayDeploymentIdentityIdSha256("deployment", deploymentId)
      || runtime.automaticMaintenance.enabled !== expectation.enabled
      || runtime.automaticMaintenance.candidateBound !== expectation.candidateBound
    ) return false;
  }
  return true;
}

function legacyRuntimeIdentityExact(
  route: "/health" | "/startup" | "/ready",
  source: string,
  expectedCommitSha: string,
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return false;
  }
  if (!exactKeys(value, ["ok", "data"]) || value.ok !== true) return false;
  const dataKeys = route === "/health"
    ? ["service", "status", "deployment"]
    : ["service", "status", "deployment", "dependencies"];
  if (!exactKeys(value.data, dataKeys)) return false;
  const expectedStatus = route === "/health"
    ? "ok"
    : route === "/startup"
      ? "startup_ready"
      : "ready";
  if (value.data.service !== "pint-path" || value.data.status !== expectedStatus) {
    return false;
  }
  if (route !== "/health" && (
    typeof value.data.dependencies !== "object"
    || value.data.dependencies === null
    || Array.isArray(value.data.dependencies)
  )) return false;
  const deployment = value.data.deployment;
  return exactKeys(deployment, ["version", "commitSha", "environment"])
    && typeof deployment.version === "string"
    && /^[a-z0-9._-]{1,80}$/i.test(deployment.version)
    && deployment.commitSha === expectedCommitSha
    && deployment.environment === "production";
}

async function probeRuntimeAbsent(
  fetchImpl: typeof fetch,
  target: ScaleTarget,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  for (let round = 0; round < 3; round += 1) {
    for (const route of ["/health", "/startup", "/ready"] as const) {
      try {
        const response = await fetchImpl(`https://${target.domain}${route}`, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        });
        const exactAbsentStatus = response.status === 404;
        await response.body?.cancel().catch(() => undefined);
        if (!exactAbsentStatus) return false;
      } catch {
        // Network and redirect failures do not prove that the application is absent.
        return false;
      }
    }
    if (round < 2) await sleep(10_000);
  }
  return true;
}

function snapshotExact(
  snapshot: ProtectedScaleSnapshot,
  candidateSha: string,
  replicas: ReplicaCount,
  target: ScaleTarget = STAGING_TARGET,
  placement: "primary-region" | "any-single-region" = "primary-region",
): boolean {
  const allowedRegions = target.environmentId === STAGING_ENVIRONMENT_ID
    ? new Set([REGION, LEGACY_STAGING_REGION])
    : new Set([REGION]);
  const configuredTopologyExact = snapshot.configuredReplicas === replicas
    && snapshot.configuredRegions.every(({ region }) => allowedRegions.has(region))
    && snapshot.configuredRegions.every(({ numReplicas }) =>
      Number.isSafeInteger(numReplicas) && numReplicas >= 0)
    && (placement === "any-single-region"
        ? snapshot.configuredRegions.filter(({ numReplicas }) => numReplicas > 0)
          .length === 1
          && snapshot.configuredRegions.some(({ numReplicas }) =>
            numReplicas === replicas)
        : replicas === 0
          ? snapshot.configuredRegions.every(({ numReplicas }) => numReplicas === 0)
          : snapshot.configuredRegions.some(({ region, numReplicas }) =>
            region === REGION && numReplicas === replicas)
            && snapshot.configuredRegions.every(({ region, numReplicas }) =>
              region === REGION || numReplicas === 0));
  return snapshot.serviceId === SERVICE_ID
    && snapshot.environmentId === target.environmentId
    && configuredTopologyExact
    && snapshot.latestDeployment.id === snapshot.deployment.id
    && snapshot.latestDeployment.status === "SUCCESS"
    && snapshot.latestDeployment.deploymentStopped === false
    && snapshot.deployment.projectId === PROJECT_ID
    && snapshot.deployment.environmentId === target.environmentId
    && snapshot.deployment.serviceId === SERVICE_ID
    && productionProviderSourceExact(snapshot.deployment.commitHash, candidateSha, snapshot.sourceArchiveAuthority)
    && snapshot.deployment.patchId === null
    && snapshot.activeDeployments.length === 1
    && snapshot.activeDeployments[0]?.id === snapshot.latestDeployment.id
    && snapshot.activeDeployments[0]?.status === "SUCCESS"
    && snapshot.activeDeployments[0]?.deploymentStopped === false
    && snapshot.domains.length === 1
    && snapshot.domains[0]?.kind === "service"
    && snapshot.domains[0].domain === target.domain
    && snapshot.domains[0].targetPort === APPLICATION_TARGET_PORT;
}

function scalePatchRegions(
  target: ScaleTarget,
  desiredReplicas: ReplicaCount,
): readonly RailwayRegionReplicaTarget[] {
  const regions = target.environmentId === STAGING_ENVIRONMENT_ID
    ? [REGION, LEGACY_STAGING_REGION]
    : [REGION];
  return [...regions].sort().map((region) => Object.freeze({
    region,
    numReplicas: region === REGION ? desiredReplicas : 0,
  }));
}

function topologySnapshot(
  snapshot: ProtectedScaleSnapshot | null,
): ReplicaTopologySnapshot | null {
  if (snapshot === null) return null;
  const configured = {
    configuredReplicas: snapshot.configuredReplicas,
    configuredRegions: snapshot.configuredRegions,
  };
  return {
    ...configured,
    configuredTopologySha256: sha256(canonical(configured)),
    legacyAggregateReplicas: snapshot.numReplicas,
    serviceSourceSha256: sha256(canonicalProviderJson(snapshot.serviceSource)),
    stagedPatchEmpty: snapshot.stagedPatchEmpty,
  };
}

function providerConfigurationCollateralExact(
  before: ProtectedScaleSnapshot,
  after: ProtectedScaleSnapshot,
): boolean {
  const beforeConfig = environmentConfigCollateral(before.environmentConfig);
  const afterConfig = environmentConfigCollateral(after.environmentConfig);
  return beforeConfig !== null && afterConfig !== null &&
    canonicalProviderJson(beforeConfig) === canonicalProviderJson(afterConfig) &&
    canonicalProviderJson(before.serviceSource) ===
      canonicalProviderJson(after.serviceSource) &&
    before.stagedPatchEmpty && after.stagedPatchEmpty;
}

function topologyReceipt(
  target: ScaleTarget,
  before: ProtectedScaleSnapshot | null,
  immediatelyBeforeWrite: ProtectedScaleSnapshot | null,
  after: ProtectedScaleSnapshot | null,
  patchRegions: readonly RailwayRegionReplicaTarget[],
): ScaleReceipt["replicaTopology"] {
  return {
    authoritySource: "environment.config(decryptVariables:false)",
    primaryRegion: REGION,
    allowedRegions: target.environmentId === STAGING_ENVIRONMENT_ID
      ? [REGION, LEGACY_STAGING_REGION]
      : [REGION],
    before: topologySnapshot(before),
    immediatelyBeforeWrite: topologySnapshot(immediatelyBeforeWrite),
    after: topologySnapshot(after),
    patchRegions,
    environmentConfigCollateralUnchanged: before !== null && after !== null &&
      providerConfigurationCollateralExact(before, after),
  };
}

function topologyEvidenceExact(
  direction: Direction,
  desiredReplicas: ReplicaCount,
  target: ScaleTarget,
  attempts: 0 | 1,
  before: ProtectedScaleSnapshot | null,
  immediatelyBeforeWrite: ProtectedScaleSnapshot | null,
  after: ProtectedScaleSnapshot | null,
  patchRegions: readonly RailwayRegionReplicaTarget[],
): boolean {
  const receiptExact = protectedScaleReplicaTopologyExact(
    topologyReceipt(
      target,
      before,
      immediatelyBeforeWrite,
      after,
      patchRegions,
    ),
    {
      direction,
      attempts,
      desiredReplicas,
      target: target.environmentId === STAGING_ENVIRONMENT_ID
        ? "staging"
        : "production",
    },
  );
  if (!receiptExact) return false;
  if (before === null || after === null || !snapshotExact(
    after,
    after.sourceArchiveAuthority?.candidateSha ?? after.deployment.commitHash ?? "",
    desiredReplicas,
    target,
  )) return false;
  if (attempts === 0) {
    return immediatelyBeforeWrite === null && patchRegions.length === 0
      && authoritativeSnapshotIdentity(before) === authoritativeSnapshotIdentity(after)
      && before.configuredReplicas === desiredReplicas;
  }
  const placement = direction === "quiesce-staging-zero"
    ? "any-single-region"
    : "primary-region";
  return immediatelyBeforeWrite !== null
    && authoritativeSnapshotIdentity(before)
      === authoritativeSnapshotIdentity(immediatelyBeforeWrite)
    && snapshotExact(
      immediatelyBeforeWrite,
      before.sourceArchiveAuthority?.candidateSha ?? before.deployment.commitHash ?? "",
      before.configuredReplicas as ReplicaCount,
      target,
      placement,
    )
    && canonical(patchRegions)
      === canonical(scalePatchRegions(target, desiredReplicas));
}

function deploymentIdentity(snapshot: ProtectedScaleSnapshot): string {
  return canonical({
    latestDeployment: snapshot.latestDeployment,
    activeDeployments: snapshot.activeDeployments,
    deployment: snapshot.deployment,
    domains: snapshot.domains,
    serviceInstanceId: snapshot.serviceInstanceId,
    serviceSource: snapshot.serviceSource,
    stagedPatchEmpty: snapshot.stagedPatchEmpty,
  });
}

function authoritativeSnapshotIdentity(snapshot: ProtectedScaleSnapshot): string {
  return canonical({
    serviceInstanceId: snapshot.serviceInstanceId,
    serviceId: snapshot.serviceId,
    environmentId: snapshot.environmentId,
    configuredReplicas: snapshot.configuredReplicas,
    configuredRegions: snapshot.configuredRegions,
    serviceSource: snapshot.serviceSource,
    environmentConfig: snapshot.environmentConfig,
    stagedPatchEmpty: snapshot.stagedPatchEmpty,
    latestDeployment: snapshot.latestDeployment,
    activeDeployments: snapshot.activeDeployments,
    domains: snapshot.domains,
    deployment: snapshot.deployment,
  });
}

async function reconcile(
  dependencies: Dependencies,
  token: string,
  candidateSha: string,
  replicas: ReplicaCount,
  target: ScaleTarget = STAGING_TARGET,
  sourceArchive?: ProtectedSourceArchiveIdentity,
): Promise<ProtectedScaleSnapshot | null> {
  const deadline = dependencies.now() + RECONCILIATION_TIMEOUT_MS;
  do {
    try {
      const snapshot = await querySnapshot(dependencies.fetchImpl, token, target, sourceArchive);
      if (snapshotExact(snapshot, candidateSha, replicas, target)) return snapshot;
    } catch {
      // Read-only reconciliation continues until its fixed deadline.
    }
    if (dependencies.now() >= deadline) break;
    await dependencies.sleep(RECONCILIATION_INTERVAL_MS);
  } while (dependencies.now() <= deadline);
  return null;
}

function policyExact(cwd: string): boolean {
  try {
    const source = fs.readFileSync(path.resolve(cwd, POLICY_PATH));
    if (sha256(source) !== POLICY_SHA256) return false;
    const value = JSON.parse(source.toString("utf8")) as unknown;
    return (
      exactKeys(value, [
        "schemaVersion",
        "policyId",
        "activationState",
        "projectId",
        "productionEnvironmentId",
        "stagingEnvironmentId",
        "serviceId",
        "publicOrigin",
        "region",
        "githubEnvironment",
        "requiredGitRef",
        "directMutation",
        "lifecycle",
        "productionConvergence",
        "workerBootstrap",
        "runtimeFence",
        "evidence",
      ]) &&
      value.schemaVersion ===
        "pintpath-permanent-staging-scale-evidence-policy/v3" &&
      value.activationState === PROTECTED_STAGING_SCALE_STATE &&
      value.projectId === PROJECT_ID &&
      value.productionEnvironmentId === PRODUCTION_ENVIRONMENT_ID &&
      value.stagingEnvironmentId === STAGING_ENVIRONMENT_ID &&
      value.serviceId === SERVICE_ID &&
      value.publicOrigin === `https://${STAGING_DOMAIN}` &&
      value.region === REGION &&
      value.githubEnvironment === "permanent-staging-scale-evidence" &&
      value.requiredGitRef === "refs/heads/main" &&
      exactKeys(value.directMutation, [
        "endpoint",
        "operationName",
        "operation",
        "maximumAttempts",
        "automaticRetriesAllowed",
        "stagingFullRegionPatchRequired",
        "stagingRegions",
        "productionRegions",
        "zeroRegionsEncodedAsJsonNull",
        "emptyStagedPatchRequired",
        "providerHistoryContinuityRequired",
        "providerPatchCrossFetchRequired",
        "lostAcknowledgementReconciliationAllowed",
        "providerCasOrLockVerified",
        "externalMutationFreezeAttestation",
        "externalMutationFreezeEnforcement",
      ]) &&
      value.directMutation.endpoint === GRAPHQL_ENDPOINT &&
      value.directMutation.operationName ===
        RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME &&
      value.directMutation.operation === "environmentPatchCommit" &&
      value.directMutation.maximumAttempts === 1 &&
      value.directMutation.automaticRetriesAllowed === false &&
      value.directMutation.stagingFullRegionPatchRequired === true &&
      canonical(value.directMutation.stagingRegions) ===
        canonical([REGION, LEGACY_STAGING_REGION]) &&
      canonical(value.directMutation.productionRegions) === canonical([REGION]) &&
      value.directMutation.zeroRegionsEncodedAsJsonNull === true &&
      value.directMutation.emptyStagedPatchRequired === true &&
      value.directMutation.providerHistoryContinuityRequired === true &&
      value.directMutation.providerPatchCrossFetchRequired === true &&
      value.directMutation.lostAcknowledgementReconciliationAllowed === true &&
      value.directMutation.providerCasOrLockVerified === false &&
      value.directMutation.externalMutationFreezeAttestation ===
        PROTECTED_SCALE_EXTERNAL_MUTATION_FREEZE_ATTESTATION &&
      value.directMutation.externalMutationFreezeEnforcement ===
        EXTERNAL_MUTATION_FREEZE_ENFORCEMENT &&
      exactKeys(value.productionConvergence, [
        "environmentId",
        "publicOrigin",
        "githubEnvironment",
        "requiredReplicaCount",
        "scaleDownAllowed",
        "maximumAttempts",
        "automaticRetriesAllowed",
        "unconditionalReadOnlyPostflight",
        "exactExistingDeploymentShaRequired",
        "activationPrerequisiteRequired",
        "activationVerificationSchema",
        "activationVerificationFilename",
        "exactActivationRunBindingRequired",
        "liveDeploymentContinuityRequired",
        "durableIntentBindingRequired",
        "terminalReceiptBindingRequired",
      ]) &&
      value.productionConvergence.environmentId ===
        PRODUCTION_ENVIRONMENT_ID &&
      value.productionConvergence.publicOrigin ===
        `https://${PRODUCTION_DOMAIN}` &&
      value.productionConvergence.githubEnvironment ===
        "production-topology-configuration" &&
      value.productionConvergence.requiredReplicaCount === 2 &&
      value.productionConvergence.scaleDownAllowed === false &&
      value.productionConvergence.maximumAttempts === 1 &&
      value.productionConvergence.automaticRetriesAllowed === false &&
      value.productionConvergence.unconditionalReadOnlyPostflight === true &&
      value.productionConvergence.exactExistingDeploymentShaRequired === true &&
      value.productionConvergence.activationPrerequisiteRequired === true &&
      value.productionConvergence.activationVerificationSchema ===
        "pintpath-production-scale-activation-prerequisite/v1" &&
      value.productionConvergence.activationVerificationFilename ===
        "production-scale-activation-verification.json" &&
      value.productionConvergence.exactActivationRunBindingRequired === true &&
      value.productionConvergence.liveDeploymentContinuityRequired === true &&
      value.productionConvergence.durableIntentBindingRequired === true &&
      value.productionConvergence.terminalReceiptBindingRequired === true &&
      exactKeys(value.workerBootstrap, [
        "quiesceDirection",
        "bootstrapDirection",
        "initialReplicaCount",
        "quiescedReplicaCount",
        "restoredReplicaCount",
        "maximumAttemptsPerTransition",
        "automaticRetriesAllowed",
        "runtimeMustBeUnavailableWhileQuiesced",
        "restoredRuntimeAutomaticMaintenanceEnabled",
        "restoredRuntimeCandidateBindingRequired",
        "deploymentMustRemainUnchangedPerScale",
      ]) &&
      value.workerBootstrap.quiesceDirection === "quiesce-staging-zero" &&
      value.workerBootstrap.bootstrapDirection === "bootstrap-staging-one" &&
      value.workerBootstrap.initialReplicaCount === 1 &&
      value.workerBootstrap.quiescedReplicaCount === 0 &&
      value.workerBootstrap.restoredReplicaCount === 1 &&
      value.workerBootstrap.maximumAttemptsPerTransition === 1 &&
      value.workerBootstrap.automaticRetriesAllowed === false &&
      value.workerBootstrap.runtimeMustBeUnavailableWhileQuiesced === true &&
      value.workerBootstrap.restoredRuntimeAutomaticMaintenanceEnabled === false &&
      value.workerBootstrap.restoredRuntimeCandidateBindingRequired === true &&
      value.workerBootstrap.deploymentMustRemainUnchangedPerScale === true &&
      exactKeys(value.runtimeFence, [
        "requiredRoutes",
        "automaticMaintenanceEnabled",
        "candidateBindingRequired",
        "preflightRequired",
        "postflightRequired",
      ]) &&
      Array.isArray(value.runtimeFence.requiredRoutes) &&
      JSON.stringify(value.runtimeFence.requiredRoutes)
        === JSON.stringify(["/health", "/startup", "/ready"]) &&
      value.runtimeFence.automaticMaintenanceEnabled === true &&
      value.runtimeFence.candidateBindingRequired === true &&
      value.runtimeFence.preflightRequired === true &&
      value.runtimeFence.postflightRequired === true &&
      exactKeys(value.evidence, [
        "durableIntentRequiredBeforeEachWrite",
        "terminalEvidenceRequired",
        "finalReceiptRequired",
        "deploymentMustRemainUnchanged",
        "candidateCommitMustRemainExact",
      ]) &&
      Object.values(value.evidence).every((entry) => entry === true)
    );
  } catch {
    return false;
  }
}

function emptyChecks(): ScaleReceipt["checks"] {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    externalMutationFreezeAttested: false,
    tokenScopesExact: false,
    directMutationContractExact: false,
    boundaryPreflightExact: false,
    targetPreflightExact: false,
    productionActivationPrerequisiteExact: false,
    productionActivationDeploymentContinuityExact: false,
    runtimePreflightExact: false,
    durableIntentExact: false,
    repositoryPrewriteReasserted: false,
    writeAttemptedAtMostOnce: true,
    mutationResponseClassified: false,
    acknowledgementExact: false,
    lostAcknowledgementExact: false,
    providerHistoryPrewriteExact: false,
    providerHistoryPostflightExact: false,
    postflightAttempted: false,
    targetPostflightExact: false,
    runtimePostflightExact: false,
    candidateUnchanged: false,
    deploymentUnchanged: false,
    providerConfigurationCollateralUnchanged: false,
    replicaTopologyEvidenceExact: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
    finalReceiptEvidenceExact: false,
  };
}

export function protectedScaleCommitMessage(
  direction: Direction,
  candidateSha: string,
  runId: string,
): string {
  return `PintPath scale ${direction} ${candidateSha} run ${runId}`;
}

function directMutationEvidence(
  attempt: RailwayEnvironmentPatchCommitAttempt | null,
  variables: Record<string, unknown> | null,
  commitMessage: string | null,
): ScaleReceipt["directMutationEvidence"] {
  const requestBody = variables === null ? null : JSON.stringify({
    operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
    query: RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
    variables,
  });
  const multiRegionConfig = variables !== null &&
      typeof variables.patch === "object" && variables.patch !== null &&
      !Array.isArray(variables.patch)
    ? ((variables.patch as Record<string, unknown>).services as
      Record<string, unknown> | undefined)?.[SERVICE_ID]
    : null;
  const deploy = typeof multiRegionConfig === "object" &&
      multiRegionConfig !== null && !Array.isArray(multiRegionConfig)
    ? (multiRegionConfig as Record<string, unknown>).deploy
    : null;
  const topology = typeof deploy === "object" && deploy !== null &&
      !Array.isArray(deploy)
    ? (deploy as Record<string, unknown>).multiRegionConfig
    : null;
  const zeroRegionsEncodedAsJsonNull = typeof topology === "object" &&
    topology !== null && !Array.isArray(topology);
  return {
    operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
    operation: "environmentPatchCommit",
    transportOutcome: attempt?.outcome ?? null,
    querySha256: attempt?.querySha256 ??
      sha256(RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION),
    variablesSha256: attempt?.variablesSha256 ??
      (variables === null ? null : sha256(JSON.stringify(variables))),
    requestBodySha256: attempt?.requestBodySha256 ??
      (requestBody === null ? null : sha256(requestBody)),
    responseBodySha256: attempt?.responseBodySha256 ?? null,
    acknowledgementSha256: attempt?.acknowledgementSha256 ?? null,
    acknowledgementExact: attempt?.acknowledgementExact ?? false,
    commitMessageSha256: commitMessage === null ? null : sha256(commitMessage),
    zeroRegionsEncodedAsJsonNull:
      attempt?.zeroRegionsEncodedAsJsonNull ?? zeroRegionsEncodedAsJsonNull,
    providerCasOrLockVerified: false,
    externalMutationFreezeEnforcement: EXTERNAL_MUTATION_FREEZE_ENFORCEMENT,
  };
}

function mutationAttemptEvidenceExact(
  attempt: RailwayEnvironmentPatchCommitAttempt,
  variables: Record<string, unknown>,
): boolean {
  const requestBody = JSON.stringify({
    operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
    query: RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
    variables,
  });
  const acknowledgementRelationExact = attempt.outcome === "acknowledged"
    ? attempt.acknowledgementExact &&
      typeof attempt.acknowledgementSha256 === "string" &&
      SHA256_PATTERN.test(attempt.acknowledgementSha256) &&
      typeof attempt.responseBodySha256 === "string" &&
      SHA256_PATTERN.test(attempt.responseBodySha256)
    : attempt.acknowledgementExact === false &&
      attempt.acknowledgementSha256 === null &&
      (attempt.responseBodySha256 === null ||
        SHA256_PATTERN.test(attempt.responseBodySha256));
  return attempt.operationName ===
      RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME &&
    attempt.querySha256 === sha256(RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION) &&
    attempt.variablesSha256 === sha256(JSON.stringify(variables)) &&
    attempt.requestBodySha256 === sha256(requestBody) &&
    attempt.zeroRegionsEncodedAsJsonNull === true &&
    acknowledgementRelationExact;
}

function patchHistoryPagesExact(
  pages: readonly ScalePatchHistoryEvidence["pages"][number][],
  rowCount: number,
): boolean {
  if (pages.length < 1 || pages.length > 8) return false;
  let expectedAfter: string | null = null;
  let rows = 0;
  const endCursors = new Set<string>();
  for (const [index, page] of pages.entries()) {
    if (!exactKeys(page, [
      "requestAfter",
      "count",
      "endCursor",
      "hasNextPage",
    ]) || page.requestAfter !== expectedAfter ||
      !Number.isSafeInteger(page.count) || page.count < 0 || page.count > 100 ||
      typeof page.hasNextPage !== "boolean" ||
      !(page.endCursor === null || typeof page.endCursor === "string") ||
      (typeof page.endCursor === "string" &&
        (page.endCursor.length < 1 || page.endCursor.length > 4096 ||
          /[\r\n\0]/.test(page.endCursor) || endCursors.has(page.endCursor))) ||
      (page.count === 0 ? page.endCursor !== null : page.endCursor === null) ||
      (page.hasNextPage && page.count !== 100) ||
      (page.hasNextPage !== (index < pages.length - 1))) return false;
    rows += page.count;
    if (typeof page.endCursor === "string") {
      endCursors.add(page.endCursor);
    }
    expectedAfter = page.endCursor;
  }
  return rows === rowCount;
}

export function patchHistoryEvidenceExact(
  value: ScalePatchHistoryEvidence,
  matchingCount: 0 | 1,
  expectedCommitMessage: string,
  expectedPatch: unknown,
  producerWindow?: {
    readonly startedAtMs: number;
    readonly completedAtMs: number;
  },
): boolean {
  const expectedMessageSha256 = sha256(expectedCommitMessage);
  const expectedPatchSha256 = sha256(canonicalProviderJson(expectedPatch));
  if (!exactKeys(value, [
    "querySha256",
    "pages",
    "pageCount",
    "rowCount",
    "rowsProjectionSha256",
    "nonMatchingRowsProjectionSha256",
    "paginationCompleteExact",
    "matchingPatchCount",
    "matchingPatch",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ]) || !exactKeys(value.querySha256, ["history", "patch"]) ||
    !Array.isArray(value.pages)) return false;
  return value.querySha256.history ===
      sha256(PROTECTED_STAGING_SCALE_PATCH_HISTORY_QUERY) &&
    value.querySha256.patch === sha256(PROTECTED_STAGING_SCALE_PATCH_QUERY) &&
    value.pageCount === value.pages.length && value.pageCount >= 1 &&
    value.pageCount <= 8 && Number.isSafeInteger(value.rowCount) &&
    value.rowCount >= 0 && value.rowCount <= 800 &&
    patchHistoryPagesExact(value.pages, value.rowCount) &&
    SHA256_PATTERN.test(value.rowsProjectionSha256) &&
    SHA256_PATTERN.test(value.nonMatchingRowsProjectionSha256) &&
    value.paginationCompleteExact && value.matchingPatchCount === matchingCount &&
    value.secretMaterialIncluded === false &&
    value.secretDerivedCommitmentsIncluded === false &&
    (matchingCount === 0
      ? value.matchingPatch === null &&
        value.rowsProjectionSha256 === value.nonMatchingRowsProjectionSha256
      : exactKeys(value.matchingPatch, [
          "rowIndex",
          "idSha256",
          "status",
          "createdAt",
          "updatedAt",
          "appliedAt",
          "messageSha256",
          "patchSha256",
          "crossFetchExact",
        ]) && value.matchingPatch.rowIndex === 0 &&
        value.matchingPatch.crossFetchExact === true &&
        value.matchingPatch.status === "COMMITTED" &&
        SHA256_PATTERN.test(value.matchingPatch.idSha256) &&
        canonicalTimestamp(value.matchingPatch.createdAt) &&
        canonicalTimestamp(value.matchingPatch.updatedAt) &&
        canonicalTimestamp(value.matchingPatch.appliedAt) &&
        Date.parse(value.matchingPatch.createdAt) <=
          Date.parse(value.matchingPatch.updatedAt) &&
        Date.parse(value.matchingPatch.appliedAt) <=
          Date.parse(value.matchingPatch.updatedAt) &&
        (producerWindow === undefined || (
          Date.parse(value.matchingPatch.createdAt) >=
            producerWindow.startedAtMs &&
          Date.parse(value.matchingPatch.appliedAt) >=
            producerWindow.startedAtMs &&
          Date.parse(value.matchingPatch.createdAt) <=
            producerWindow.completedAtMs &&
          Date.parse(value.matchingPatch.appliedAt) <=
            producerWindow.completedAtMs &&
          Date.parse(value.matchingPatch.updatedAt) <=
            producerWindow.completedAtMs
        )) &&
        value.matchingPatch.messageSha256 === expectedMessageSha256 &&
        value.matchingPatch.patchSha256 === expectedPatchSha256);
}

function receipt(
  direction: Direction | null,
  outcome: ScaleReceipt["outcome"],
  candidateSha: string | null,
  githubRunId: string | null,
  startedAt: string,
  completedAt: string,
  desiredReplicas: ReplicaCount | null,
  deploymentIdSha256: string | null,
  attempts: 0 | 1,
  intentSha256: string | null,
  terminalEvidenceSha256: string | null,
  productionActivationPrerequisite:
    ScaleReceipt["productionActivationPrerequisite"],
  replicaTopology: ScaleReceipt["replicaTopology"],
  mutationAttempt: RailwayEnvironmentPatchCommitAttempt | null,
  mutationVariables: Record<string, unknown> | null,
  commitMessage: string | null,
  providerHistoryPrewrite: ScalePatchHistoryEvidence | null,
  providerHistoryPostflight: ScalePatchHistoryEvidence | null,
  checks: ScaleReceipt["checks"],
): ScaleReceipt {
  return {
    schemaVersion: PROTECTED_STAGING_SCALE_SCHEMA,
    executorState: PROTECTED_STAGING_SCALE_STATE,
    direction,
    outcome,
    candidateSha,
    githubRunId,
    startedAt,
    completedAt,
    desiredReplicas,
    deploymentIdSha256,
    attempts,
    retryAllowed: false,
    intentSha256,
    terminalEvidenceSha256,
    directMutationEvidence: directMutationEvidence(
      mutationAttempt,
      mutationVariables,
      commitMessage,
    ),
    providerHistoryEvidence: {
      prewrite: providerHistoryPrewrite,
      postflight: providerHistoryPostflight,
    },
    productionActivationPrerequisite,
    replicaTopology,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
    checks,
  };
}

export async function runProtectedPermanentStagingScale(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    boundaryCheck: () => runRailwayMutationBoundaryCheck({
      argv: ["--policy", BOUNDARY_POLICY_PATH],
    }),
    reassertRepositoryState,
    validateProductionActivationPrerequisite:
      parseProductionScaleActivationPrerequisiteVerification,
    commitScale: (token, input) => commitRailwayReplicaEnvironmentPatch(
      fetch,
      token,
      input,
    ),
    readPatchHistory: (token, environmentId, commitMessage, expectedPatch) =>
      readPatchHistory(
        fetch,
        token,
        environmentId,
        commitMessage,
        expectedPatch,
      ),
    probeRuntime: (target, candidateSha, deploymentId, expectation) => probeRuntime(
      fetch,
      target,
      candidateSha,
      deploymentId,
      expectation,
    ),
    probeRuntimeAbsent: (target) => probeRuntimeAbsent(
      fetch,
      target,
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ),
    writeDurable: durableWrite,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const startedAt = new Date(dependencies.now()).toISOString();
  let completedAt = startedAt;
  const args = parseArguments(dependencies.argv);
  const checks = emptyChecks();
  let sourceArchive: ProtectedSourceArchiveIdentity | undefined;
  const direction = args?.direction ?? null;
  const candidateSha = args?.candidateSha ?? null;
  const githubRunId = RUN_ID_PATTERN.test(dependencies.env.GITHUB_RUN_ID ?? "")
    ? dependencies.env.GITHUB_RUN_ID!
    : null;
  const desiredReplicas = direction === "quiesce-staging-zero" ? 0
    : direction === "converge-one" || direction === "bootstrap-staging-one" ? 1
      : direction === "out" || direction === "converge-production-two" ? 2 : null;
  const target = direction === "converge-production-two" ? PRODUCTION_TARGET : STAGING_TARGET;
  let attempts: 0 | 1 = 0;
  let intentSha: string | null = null;
  let terminalSha: string | null = null;
  let mutationAttempt: RailwayEnvironmentPatchCommitAttempt | null = null;
  let mutationVariables: Record<string, unknown> | null = null;
  let commitMessage: string | null = null;
  let providerHistoryPrewrite: ScalePatchHistoryEvidence | null = null;
  let providerHistoryPostflight: ScalePatchHistoryEvidence | null = null;
  let outcome: ScaleReceipt["outcome"] = "blocked";
  let before: ProtectedScaleSnapshot | null = null;
  let immediatelyBeforeWrite: ProtectedScaleSnapshot | null = null;
  let after: ProtectedScaleSnapshot | null = null;
  let patchRegions: readonly RailwayRegionReplicaTarget[] = [];
  let intendedPatchRegions: readonly RailwayRegionReplicaTarget[] = [];
  let deploymentIdSha256: string | null = null;
  let metadataToken = "";
  let productionActivationVerification:
    ProductionScaleActivationPrerequisiteVerification | null = null;
  let productionActivationPrerequisite:
    ScaleReceipt["productionActivationPrerequisite"] = null;
  try {
    checks.policyExact = policyExact(dependencies.cwd);
    const confirmation = direction === "out"
      ? "SCALE_PERMANENT_STAGING_TO_TWO_FOR_EVIDENCE"
      : direction === "converge-one"
        ? "CONVERGE_PERMANENT_STAGING_TO_ONE"
        : direction === "converge-production-two"
          ? "CONVERGE_PRODUCTION_TO_TWO_REPLICAS"
          : direction === "quiesce-staging-zero"
            ? "QUIESCE_PERMANENT_STAGING_TO_ZERO_FOR_WORKER_BOOTSTRAP"
            : "RESTORE_PERMANENT_STAGING_TO_ONE_FOR_WORKER_BOOTSTRAP";
    checks.githubAuthorityExact = args !== null
      && dependencies.env.GITHUB_REF === "refs/heads/main"
      && dependencies.env.GITHUB_SHA === args.candidateSha
      && dependencies.env.PINTPATH_SCALE_CONFIRMATION === confirmation
      && dependencies.env.GITHUB_RUN_ATTEMPT === "1";
    checks.externalMutationFreezeAttested =
      dependencies.env.PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION ===
        PROTECTED_SCALE_EXTERNAL_MUTATION_FREEZE_ATTESTATION;
    if (!args || !checks.policyExact || !checks.githubAuthorityExact) {
      throw new Error("authority_invalid");
    }
    if (!checks.externalMutationFreezeAttested) {
      throw new Error("external_mutation_freeze_invalid");
    }
    const productionActivationRunId = args.productionActivationRunId
      ?? dependencies.env.PINTPATH_PRODUCTION_SCALE_ACTIVATE_RUN_ID
      ?? null;
    const productionScaleVerificationFile = args.productionScaleVerificationFile
      ?? dependencies.env.PINTPATH_PRODUCTION_SCALE_ACTIVATION_VERIFICATION_FILE
      ?? null;
    if (direction === "converge-production-two") {
      const currentRunId = githubRunId ?? "";
      if (
        !productionActivationRunId
        || !RUN_ID_PATTERN.test(productionActivationRunId)
        || !RUN_ID_PATTERN.test(currentRunId)
        || !productionScaleVerificationFile
      ) throw new Error("activation_prerequisite_invalid");
      try {
        const verificationSource = readProductionActivationPrerequisite(
          productionScaleVerificationFile,
          args.evidenceDirectory,
        );
        productionActivationVerification =
          dependencies.validateProductionActivationPrerequisite(
            verificationSource,
            {
              candidateSha: args.candidateSha,
              currentRunId,
              activateRunId: productionActivationRunId,
              now: new Date(dependencies.now()),
            },
          );
        sourceArchive = productionActivationVerification.activationPrerequisites.rolePrerequisites.productionDeployment.sourceArchive;
        productionActivationPrerequisite = {
          runId: productionActivationVerification.activation.runId,
          verificationSha256: sha256(verificationSource),
          terminalSha256:
            productionActivationVerification.activation.terminalSha256,
          prerequisitesSha256:
            productionActivationVerification.activation.prerequisitesSha256,
          deploymentBeforeIdSha256:
            productionActivationVerification.activation
              .deploymentBeforeIdSha256,
          deploymentAfterIdSha256:
            productionActivationVerification.activation.deploymentAfterIdSha256,
        };
        checks.productionActivationPrerequisiteExact =
          productionActivationPrerequisite.runId === productionActivationRunId
          && productionActivationVerification.candidateSha === args.candidateSha
          && productionActivationVerification.consumer.runId === currentRunId
          && Object.entries(productionActivationPrerequisite)
            .filter(([key]) => key !== "runId")
            .every(([, value]) => SHA256_PATTERN.test(value));
      } catch {
        throw new Error("activation_prerequisite_invalid");
      }
      if (!checks.productionActivationPrerequisiteExact) {
        throw new Error("activation_prerequisite_invalid");
      }
    } else {
      if (
        productionActivationRunId !== null
        || productionScaleVerificationFile !== null
      ) throw new Error("activation_prerequisite_invalid");
      checks.productionActivationPrerequisiteExact = true;
      checks.productionActivationDeploymentContinuityExact = true;
    }
    metadataToken = direction === "converge-production-two"
      ? dependencies.env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? ""
      : dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    const mutationToken = direction === "converge-production-two"
      ? dependencies.env.PINTPATH_RAILWAY_PRODUCTION_SCALE_TOKEN ?? ""
      : dependencies.env.PINTPATH_RAILWAY_STAGING_SCALE_TOKEN ?? "";
    if (!TOKEN_PATTERN.test(metadataToken) || !TOKEN_PATTERN.test(mutationToken)
      || metadataToken === mutationToken) throw new Error("token_invalid");
    const [metadataScope, mutationScope] = await Promise.all([
      graphql(dependencies.fetchImpl, metadataToken, PROTECTED_STAGING_SCALE_TOKEN_SCOPE_QUERY, {}),
      graphql(dependencies.fetchImpl, mutationToken, PROTECTED_STAGING_SCALE_TOKEN_SCOPE_QUERY, {}),
    ]);
    checks.tokenScopesExact = parseScope(metadataScope, target.environmentId)
      && parseScope(mutationScope, target.environmentId);
    const currentRunId = githubRunId ?? "";
    if (!RUN_ID_PATTERN.test(currentRunId)) throw new Error("run_id_invalid");
    intendedPatchRegions = scalePatchRegions(target, desiredReplicas!);
    commitMessage = protectedScaleCommitMessage(
      args.direction,
      args.candidateSha,
      currentRunId,
    );
    mutationVariables = railwayEnvironmentPatchCommitVariables({
      environmentId: target.environmentId,
      serviceId: SERVICE_ID,
      regions: intendedPatchRegions,
      commitMessage,
    });
    const expectedMutationVariables = {
      environmentId: target.environmentId,
      patch: {
        services: {
          [SERVICE_ID]: {
            deploy: {
              multiRegionConfig: Object.fromEntries(intendedPatchRegions.map((entry) => [
                entry.region,
                entry.numReplicas === 0 ? null : {
                  numReplicas: entry.numReplicas,
                },
              ])),
            },
          },
        },
      },
      commitMessage,
    };
    checks.directMutationContractExact =
      RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION.includes(
        `mutation ${RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME}`,
      ) && RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION.includes(
        "environmentPatchCommit(",
      ) && canonical(mutationVariables) === canonical(expectedMutationVariables);
    checks.boundaryPreflightExact = await dependencies.boundaryCheck() === 0;
    if (!checks.tokenScopesExact || !checks.directMutationContractExact ||
      !checks.boundaryPreflightExact) {
      throw new Error("preflight_invalid");
    }
    before = await querySnapshot(dependencies.fetchImpl, metadataToken, target, sourceArchive);
    deploymentIdSha256 = railwayDeploymentIdentityIdSha256(
      "deployment",
      before.deployment.id,
    ) ?? null;
    if (!deploymentIdSha256) throw new Error("deployment_identity_invalid");
    if (direction === "converge-production-two") {
      checks.productionActivationDeploymentContinuityExact =
        productionActivationPrerequisite !== null
        && deploymentIdSha256
          === productionActivationPrerequisite.deploymentAfterIdSha256;
      if (!checks.productionActivationDeploymentContinuityExact) {
        throw new Error("activation_prerequisite_invalid");
      }
    }
    const beforeReplicas = before.configuredReplicas;
    checks.targetPreflightExact = direction === "out"
      ? snapshotExact(before, args.expectedDeploymentSha, 1, target)
      : direction === "quiesce-staging-zero"
        ? snapshotExact(
          before,
          args.expectedDeploymentSha,
          1,
          target,
          "any-single-region",
        )
        : direction === "bootstrap-staging-one"
          ? snapshotExact(before, args.expectedDeploymentSha, 0, target)
          : (beforeReplicas === 1 || beforeReplicas === 2)
            && snapshotExact(
              before,
              args.expectedDeploymentSha,
              beforeReplicas as 1 | 2,
              target,
            );
    if (!checks.targetPreflightExact) throw new Error("target_invalid");
    checks.runtimePreflightExact = direction === "quiesce-staging-zero"
      ? await dependencies.probeRuntime(
          target,
          args.expectedDeploymentSha,
          before.deployment.id,
          { legacyIdentityOnly: true },
        )
      : direction === "bootstrap-staging-one"
        ? await dependencies.probeRuntimeAbsent(target)
        : await dependencies.probeRuntime(
          target,
          args.expectedDeploymentSha,
          before.deployment.id,
          { enabled: true, candidateBound: true, ...(sourceArchive ? { sourceArchive } : {}) },
        );
    if (!checks.runtimePreflightExact) throw new Error("runtime_fence_invalid");
    if ((direction === "converge-one" && beforeReplicas === 1)
      || (direction === "converge-production-two" && beforeReplicas === 2)) {
      checks.postflightAttempted = true;
      after = await querySnapshot(dependencies.fetchImpl, metadataToken, target, sourceArchive);
      checks.targetPostflightExact = authoritativeSnapshotIdentity(before)
          === authoritativeSnapshotIdentity(after)
        && snapshotExact(
          after,
          args.expectedDeploymentSha,
          desiredReplicas!,
          target,
        );
      checks.runtimePostflightExact = checks.targetPostflightExact
        && await dependencies.probeRuntime(
          target,
          args.expectedDeploymentSha,
          after.deployment.id,
          { enabled: true, candidateBound: true, ...(sourceArchive ? { sourceArchive } : {}) },
        );
      checks.candidateUnchanged = productionProviderSourceExact(after.deployment.commitHash, args.expectedDeploymentSha, sourceArchive);
      checks.deploymentUnchanged = deploymentIdentity(before)
        === deploymentIdentity(after);
      checks.providerConfigurationCollateralUnchanged =
        providerConfigurationCollateralExact(before, after);
      checks.replicaTopologyEvidenceExact = topologyEvidenceExact(
        args.direction,
        desiredReplicas!,
        target,
        attempts,
        before,
        immediatelyBeforeWrite,
        after,
        patchRegions,
      );
      checks.repositoryPrewriteReasserted = dependencies.reassertRepositoryState(
        dependencies.cwd,
        args.candidateSha,
      );
      checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
      outcome = checks.targetPostflightExact && checks.runtimePostflightExact
        && checks.candidateUnchanged && checks.deploymentUnchanged
        && checks.providerConfigurationCollateralUnchanged
        && checks.replicaTopologyEvidenceExact
        && checks.repositoryPrewriteReasserted
        && checks.boundaryPostflightExact
        ? "already_converged"
        : "mutation_uncertain";
    } else {
      patchRegions = intendedPatchRegions;
      const beforeTopology = topologySnapshot(before)!;
      const intent = canonical({
        schemaVersion: "pintpath-permanent-staging-scale-intent/v3",
        direction,
        candidateSha: args.candidateSha,
        githubRunId: currentRunId,
        expectedDeploymentSha: args.expectedDeploymentSha,
        projectId: PROJECT_ID,
        environmentId: target.environmentId,
        serviceId: SERVICE_ID,
        region: REGION,
        beforeReplicas,
        legacyAggregateBeforeReplicas: before.numReplicas,
        beforeConfiguredRegions: before.configuredRegions,
        beforeConfiguredTopologySha256: beforeTopology.configuredTopologySha256,
        patchRegions,
        desiredReplicas,
        productionActivationPrerequisite,
        maximumAttempts: 1,
        retryAllowed: false,
        beforeDeploymentSha256: sha256(deploymentIdentity(before)),
        stagedPatchEmptyBefore: before.stagedPatchEmpty,
        mutation: {
          operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
          operation: "environmentPatchCommit",
          querySha256: sha256(RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION),
          variablesSha256: sha256(JSON.stringify(mutationVariables)),
          commitMessageSha256: sha256(commitMessage!),
          zeroRegionsEncodedAsJsonNull: true,
          providerCasOrLockVerified: false,
          externalMutationFreezeEnforcement:
            EXTERNAL_MUTATION_FREEZE_ENFORCEMENT,
        },
      });
      intentSha = dependencies.writeDurable(
        args.evidenceDirectory,
        `${direction}-intent.json`,
        intent,
      );
      checks.durableIntentExact = intentSha === sha256(intent);
      if (!checks.durableIntentExact) throw new Error("intent_invalid");
      try {
        immediatelyBeforeWrite = await querySnapshot(
          dependencies.fetchImpl,
          metadataToken,
          target,
          sourceArchive,
        );
      } catch {
        immediatelyBeforeWrite = null;
      }
      checks.targetPreflightExact = checks.targetPreflightExact
        && immediatelyBeforeWrite !== null
        && authoritativeSnapshotIdentity(immediatelyBeforeWrite)
          === authoritativeSnapshotIdentity(before)
        && snapshotExact(
          immediatelyBeforeWrite,
          args.expectedDeploymentSha,
          beforeReplicas as ReplicaCount,
          target,
          direction === "quiesce-staging-zero"
            ? "any-single-region"
            : "primary-region",
        );
      if (direction === "converge-production-two") {
        const prewriteDeploymentIdSha256 = immediatelyBeforeWrite === null
          ? null
          : railwayDeploymentIdentityIdSha256(
              "deployment",
              immediatelyBeforeWrite!.deployment.id,
            );
        checks.productionActivationDeploymentContinuityExact =
          checks.productionActivationDeploymentContinuityExact
          && productionActivationPrerequisite !== null
          && prewriteDeploymentIdSha256
            === productionActivationPrerequisite.deploymentAfterIdSha256;
      }
      if (!checks.targetPreflightExact
        || !checks.productionActivationDeploymentContinuityExact) {
        throw new Error("provider_prewrite_drift");
      }

      let runtimePrewriteExact = false;
      try {
        runtimePrewriteExact = direction === "quiesce-staging-zero"
          ? await dependencies.probeRuntime(
              target,
              args.expectedDeploymentSha,
              immediatelyBeforeWrite!.deployment.id,
              { legacyIdentityOnly: true },
            )
          : direction === "bootstrap-staging-one"
            ? await dependencies.probeRuntimeAbsent(target)
            : await dependencies.probeRuntime(
                target,
                args.expectedDeploymentSha,
                immediatelyBeforeWrite!.deployment.id,
                { enabled: true, candidateBound: true, ...(sourceArchive ? { sourceArchive } : {}) },
              );
      } catch {
        runtimePrewriteExact = false;
      }
      checks.runtimePreflightExact = checks.runtimePreflightExact
        && runtimePrewriteExact;
      if (!checks.runtimePreflightExact) throw new Error("runtime_prewrite_drift");

      checks.repositoryPrewriteReasserted = dependencies.reassertRepositoryState(
        dependencies.cwd,
        args.candidateSha,
      );
      if (!checks.repositoryPrewriteReasserted) {
        throw new Error("repository_prewrite_drift");
      }

      providerHistoryPrewrite = await dependencies.readPatchHistory(
        metadataToken,
        target.environmentId,
        commitMessage!,
        mutationVariables!.patch,
      );
      checks.providerHistoryPrewriteExact = patchHistoryEvidenceExact(
        providerHistoryPrewrite,
        0,
        commitMessage!,
        mutationVariables!.patch,
      );
      if (!checks.providerHistoryPrewriteExact) {
        throw new Error("provider_patch_history_prewrite_invalid");
      }

      try {
        runtimePrewriteExact = direction === "quiesce-staging-zero"
          ? await dependencies.probeRuntime(
              target,
              args.expectedDeploymentSha,
              immediatelyBeforeWrite!.deployment.id,
              { legacyIdentityOnly: true },
            )
          : direction === "bootstrap-staging-one"
            ? await dependencies.probeRuntimeAbsent(target)
            : await dependencies.probeRuntime(
                target,
                args.expectedDeploymentSha,
                immediatelyBeforeWrite!.deployment.id,
                { enabled: true, candidateBound: true, ...(sourceArchive ? { sourceArchive } : {}) },
              );
      } catch {
        runtimePrewriteExact = false;
      }
      checks.runtimePreflightExact = checks.runtimePreflightExact &&
        runtimePrewriteExact;
      checks.repositoryPrewriteReasserted =
        checks.repositoryPrewriteReasserted &&
        dependencies.reassertRepositoryState(
          dependencies.cwd,
          args.candidateSha,
        );
      if (!checks.runtimePreflightExact ||
        !checks.repositoryPrewriteReasserted) {
        throw new Error("final_prewrite_reassertion_failed");
      }

      // This authoritative provider read is intentionally the last awaited
      // operation before the sole mutation attempt. The provider exposes no
      // CAS/lock primitive, so any earlier read would leave a wider overwrite
      // window after the history, runtime, and repository reassertions.
      const finalPrewrite = await querySnapshot(
        dependencies.fetchImpl,
        metadataToken,
        target,
        sourceArchive,
      );
      checks.targetPreflightExact = checks.targetPreflightExact &&
        authoritativeSnapshotIdentity(finalPrewrite) ===
          authoritativeSnapshotIdentity(before) &&
        snapshotExact(
          finalPrewrite,
          args.expectedDeploymentSha,
          beforeReplicas as ReplicaCount,
          target,
          direction === "quiesce-staging-zero"
            ? "any-single-region"
            : "primary-region",
        );
      if (!checks.targetPreflightExact) {
        throw new Error("provider_final_prewrite_drift");
      }
      immediatelyBeforeWrite = finalPrewrite;

      attempts = 1;
      try {
        mutationAttempt = await dependencies.commitScale(mutationToken, {
          environmentId: target.environmentId,
          serviceId: SERVICE_ID,
          regions: patchRegions,
          commitMessage: commitMessage!,
        });
      } catch {
        mutationAttempt = null;
      }
      checks.mutationResponseClassified = mutationAttempt !== null &&
        mutationAttemptEvidenceExact(mutationAttempt, mutationVariables!);
      checks.acknowledgementExact =
        checks.mutationResponseClassified &&
        mutationAttempt?.outcome === "acknowledged" &&
        mutationAttempt.acknowledgementExact;
      checks.lostAcknowledgementExact =
        checks.mutationResponseClassified &&
        mutationAttempt?.outcome === "transport_uncertain" &&
        !mutationAttempt.acknowledgementExact;
      checks.postflightAttempted = true;
      after = await reconcile(
        dependencies,
        metadataToken,
        args.expectedDeploymentSha,
        desiredReplicas!,
        target,
        sourceArchive,
      );
      checks.targetPostflightExact = after !== null;
      try {
        providerHistoryPostflight = await dependencies.readPatchHistory(
          metadataToken,
          target.environmentId,
          commitMessage!,
          mutationVariables!.patch,
        );
      } catch {
        providerHistoryPostflight = null;
      }
      checks.providerHistoryPostflightExact = providerHistoryPostflight !== null &&
        patchHistoryEvidenceExact(
          providerHistoryPostflight,
          1,
          commitMessage!,
          mutationVariables!.patch,
        ) &&
        providerHistoryPrewrite !== null &&
        providerHistoryPostflight.rowCount ===
          providerHistoryPrewrite.rowCount + 1 &&
        providerHistoryPostflight.nonMatchingRowsProjectionSha256 ===
          providerHistoryPrewrite.rowsProjectionSha256;
      checks.runtimePostflightExact = after !== null && (
        direction === "quiesce-staging-zero"
          ? await dependencies.probeRuntimeAbsent(target)
          : await dependencies.probeRuntime(
            target,
            args.expectedDeploymentSha,
            after.deployment.id,
            direction === "bootstrap-staging-one"
              ? { enabled: false, candidateBound: true }
              : { enabled: true, candidateBound: true, ...(sourceArchive ? { sourceArchive } : {}) },
          )
      );
      checks.candidateUnchanged = after !== null && productionProviderSourceExact(after.deployment.commitHash, args.expectedDeploymentSha, sourceArchive);
      checks.deploymentUnchanged = after !== null
        && deploymentIdentity(before) === deploymentIdentity(after);
      checks.providerConfigurationCollateralUnchanged = after !== null &&
        providerConfigurationCollateralExact(before, after);
      checks.replicaTopologyEvidenceExact = topologyEvidenceExact(
        args.direction,
        desiredReplicas!,
        target,
        attempts,
        before,
        immediatelyBeforeWrite,
        after,
        patchRegions,
      );
      try {
        checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
      } catch {
        checks.boundaryPostflightExact = false;
      }
      const exactReconciledTransition = checks.targetPostflightExact
        && checks.candidateUnchanged && checks.deploymentUnchanged
        && checks.providerConfigurationCollateralUnchanged
        && checks.providerHistoryPrewriteExact
        && checks.providerHistoryPostflightExact
        && checks.replicaTopologyEvidenceExact
        && checks.runtimePreflightExact && checks.runtimePostflightExact
        && checks.boundaryPostflightExact && checks.repositoryPrewriteReasserted;
      outcome = exactReconciledTransition && checks.acknowledgementExact
        ? "scaled"
        : exactReconciledTransition && checks.lostAcknowledgementExact
          ? "reconciled_scaled"
          : "mutation_uncertain";
    }
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  } finally {
    if (attempts === 1 && !checks.postflightAttempted && args && desiredReplicas !== null) {
      checks.postflightAttempted = true;
      after = await reconcile(
        dependencies,
        metadataToken,
        args.expectedDeploymentSha,
        desiredReplicas,
        target,
        sourceArchive,
      );
      checks.targetPostflightExact = after !== null;
      try {
        providerHistoryPostflight = await dependencies.readPatchHistory(
          metadataToken,
          target.environmentId,
          commitMessage!,
          mutationVariables!.patch,
        );
      } catch {
        providerHistoryPostflight = null;
      }
      checks.providerHistoryPostflightExact = providerHistoryPostflight !== null &&
        patchHistoryEvidenceExact(
          providerHistoryPostflight,
          1,
          commitMessage!,
          mutationVariables!.patch,
        ) &&
        providerHistoryPrewrite !== null &&
        providerHistoryPostflight.rowCount ===
          providerHistoryPrewrite.rowCount + 1 &&
        providerHistoryPostflight.nonMatchingRowsProjectionSha256 ===
          providerHistoryPrewrite.rowsProjectionSha256;
      checks.runtimePostflightExact = after !== null && (
        direction === "quiesce-staging-zero"
          ? await dependencies.probeRuntimeAbsent(target)
          : await dependencies.probeRuntime(
            target,
            args.expectedDeploymentSha,
            after.deployment.id,
            direction === "bootstrap-staging-one"
              ? { enabled: false, candidateBound: true }
              : { enabled: true, candidateBound: true, ...(sourceArchive ? { sourceArchive } : {}) },
          )
      );
      checks.candidateUnchanged = after !== null && productionProviderSourceExact(after.deployment.commitHash, args.expectedDeploymentSha, sourceArchive);
      checks.deploymentUnchanged = before !== null && after !== null
        && deploymentIdentity(before) === deploymentIdentity(after);
      checks.providerConfigurationCollateralUnchanged =
        before !== null && after !== null &&
        providerConfigurationCollateralExact(before, after);
    }
    if (checks.boundaryPreflightExact && !checks.boundaryPostflightExact) {
      try {
        checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
      } catch {
        checks.boundaryPostflightExact = false;
      }
    }
  }
  checks.replicaTopologyEvidenceExact = args !== null
    && desiredReplicas !== null
    && topologyEvidenceExact(
      args.direction,
      desiredReplicas,
      target,
      attempts,
      before,
      immediatelyBeforeWrite,
      after,
      patchRegions,
    );
  if ((outcome === "scaled" || outcome === "reconciled_scaled" ||
    outcome === "already_converged")
    && !checks.replicaTopologyEvidenceExact) {
    outcome = "mutation_uncertain";
  }
  if (attempts === 0) {
    mutationVariables = null;
    commitMessage = null;
  }
  completedAt = new Date(dependencies.now()).toISOString();
  if (attempts === 1 && providerHistoryPostflight !== null &&
    commitMessage !== null && mutationVariables !== null) {
    checks.providerHistoryPostflightExact =
      checks.providerHistoryPostflightExact && patchHistoryEvidenceExact(
        providerHistoryPostflight,
        1,
        commitMessage,
        mutationVariables.patch,
        {
          startedAtMs: Date.parse(startedAt),
          completedAtMs: Date.parse(completedAt),
        },
      );
    if ((outcome === "scaled" || outcome === "reconciled_scaled") &&
      !checks.providerHistoryPostflightExact) {
      outcome = "mutation_uncertain";
    }
  }
  let provisional = receipt(
    direction,
    outcome,
    candidateSha,
    githubRunId,
    startedAt,
    completedAt,
    desiredReplicas,
    deploymentIdSha256,
    attempts,
    intentSha,
    null,
    productionActivationPrerequisite,
    topologyReceipt(
      target,
      before,
      immediatelyBeforeWrite,
      after,
      patchRegions,
    ),
    mutationAttempt,
    mutationVariables,
    commitMessage,
    providerHistoryPrewrite,
    providerHistoryPostflight,
    checks,
  );
  if (args && (checks.durableIntentExact || outcome === "already_converged")) {
    try {
      const terminal = canonical({
        schemaVersion: "pintpath-permanent-staging-scale-terminal/v3",
        receipt: provisional,
      });
      terminalSha = dependencies.writeDurable(
        args.evidenceDirectory,
        `${args.direction}-terminal.json`,
        terminal,
      );
      checks.terminalEvidenceExact = terminalSha === sha256(terminal);
    } catch {
      checks.terminalEvidenceExact = false;
      if (attempts === 1) outcome = "mutation_uncertain";
    }
  }
  const finalReceipt = receipt(
    direction,
    outcome,
    candidateSha,
    githubRunId,
    startedAt,
    completedAt,
    desiredReplicas,
    deploymentIdSha256,
    attempts,
    intentSha,
    terminalSha,
    productionActivationPrerequisite,
    topologyReceipt(
      target,
      before,
      immediatelyBeforeWrite,
      after,
      patchRegions,
    ),
    mutationAttempt,
    mutationVariables,
    commitMessage,
    providerHistoryPrewrite,
    providerHistoryPostflight,
    checks,
  );
  let durableReceipt = finalReceipt;
  if (args && checks.terminalEvidenceExact) {
    try {
      checks.finalReceiptEvidenceExact = true;
      durableReceipt = receipt(
        direction,
        outcome,
        candidateSha,
        githubRunId,
        startedAt,
        completedAt,
        desiredReplicas,
        deploymentIdSha256,
        attempts,
        intentSha,
        terminalSha,
        productionActivationPrerequisite,
        topologyReceipt(
          target,
          before,
          immediatelyBeforeWrite,
          after,
          patchRegions,
        ),
        mutationAttempt,
        mutationVariables,
        commitMessage,
        providerHistoryPrewrite,
        providerHistoryPostflight,
        checks,
      );
      const source = canonical(durableReceipt);
      checks.finalReceiptEvidenceExact = dependencies.writeDurable(
        args.evidenceDirectory,
        `${args.direction}-receipt.json`,
        source,
      ) === sha256(source);
    } catch {
      checks.finalReceiptEvidenceExact = false;
    }
  }
  if (!checks.finalReceiptEvidenceExact) {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  }
  durableReceipt = receipt(
    direction,
    outcome,
    candidateSha,
    githubRunId,
    startedAt,
    completedAt,
    desiredReplicas,
    deploymentIdSha256,
    attempts,
    intentSha,
    terminalSha,
    productionActivationPrerequisite,
    topologyReceipt(
      target,
      before,
      immediatelyBeforeWrite,
      after,
      patchRegions,
    ),
    mutationAttempt,
    mutationVariables,
    commitMessage,
    providerHistoryPrewrite,
    providerHistoryPostflight,
    checks,
  );
  dependencies.writeOutput(`${JSON.stringify(durableReceipt)}\n`);
  return (outcome === "scaled" || outcome === "reconciled_scaled" ||
    outcome === "already_converged")
    && checks.runtimePreflightExact && checks.runtimePostflightExact
    && checks.replicaTopologyEvidenceExact
    && checks.terminalEvidenceExact && checks.finalReceiptEvidenceExact ? 0 : 1;
}

export const protectedPermanentStagingScaleInternals = {
  authoritativeSnapshotIdentity,
  deploymentIdentity,
  parseArguments,
  parseDiscovery,
  parseScope,
  mutationAttemptEvidenceExact,
  patchHistoryEvidenceExact,
  probeRuntime,
  probeRuntimeAbsent,
  readPatchHistory,
  scalePatchRegions,
  snapshotExact,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedPermanentStagingScale();
}
