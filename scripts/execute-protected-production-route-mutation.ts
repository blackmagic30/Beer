import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runRailwayMutationBoundaryCheck } from
  "./check-railway-mutation-boundary.js";
import {
  parseRailwayApplicationDeploymentAttestationEmptyPatchResponse,
  parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse,
  parseRailwayApplicationDeploymentAttestationRuntimeResponse,
  parseRailwayApplicationDeploymentAttestationTokenScopeResponse,
  type RailwayApplicationDeploymentAttestationProviderSnapshot,
} from "../src/lib/railway-application-deployment-attestation.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";
import {
  parseProductionPromotionRecoveryReceipt,
  type ProductionPromotionRecoveryReceipt,
} from "../src/lib/production-promotion-recovery.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

export const PROTECTED_PRODUCTION_ROUTE_MUTATION_SCHEMA =
  "pintpath-protected-production-route-mutation/v1" as const;
export const PROTECTED_PRODUCTION_ROUTE_MUTATION_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;

const POLICY_PATH = "ops/railway/production-route-mutation-policy.json";
const POLICY_SHA256 =
  "44b904f53d8941a02a9cf7a6eb4819573b6b258b593710be0717369d9bf14d9d";
const BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json";
const BOUNDARY_POLICY_SHA256 =
  "cebed5aebb1e2ada4cd247649eb418fa7d8b77b5c863ed4ecece601f492ac3c8";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const PRODUCTION_ENVIRONMENT_ID = "13dab015-df74-45c6-b26f-69323daea99a";
const STAGING_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const DOMAIN = "pintpath.au";
const TARGET_PORT = null;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const TOKEN = /^[^\r\n\0]{16,4096}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RELEASE_POLICY_SHA256 =
  "b47f562d94b462ed7d2b1d9df317ac239a607d517bb487c109585e09213ba4fd";
const PROMOTION_RECOVERY_POLICY_SHA256 =
  "57f66c1c9dde912586ec510e37c28cc3dfea2c098e67c78edbea189c7dcc9988";
const PRODUCTION_STAGE_CONTRACTS = Object.freeze({
  deploy: Object.freeze({
    name: "Deploy protected production",
    workflowPath: ".github/workflows/deploy-production.yml",
    artifactPrefix: "pintpath-production-deployment-",
  }),
  scale: Object.freeze({
    name: "Converge exact production deployment to two replicas",
    workflowPath: ".github/workflows/production-converge-two-replicas.yml",
    artifactPrefix: "pintpath-production-scale-evidence-",
  }),
  close: Object.freeze({
    name: "Close exact production route",
    workflowPath: ".github/workflows/close-production-route.yml",
    artifactPrefix: "pintpath-production-route-close-",
  }),
  activation: Object.freeze({
    name: "Activate exact production promotion recovery",
    workflowPath: ".github/workflows/activate-production-promotion-recovery.yml",
    artifactPrefix: "pintpath-production-promotion-recovery-activation-",
  }),
  "promotion-recovery": Object.freeze({
    name: "Attest protected production promotion and recovery",
    workflowPath: ".github/workflows/attest-production-promotion-recovery.yml",
    artifactPrefix: "pintpath-production-promotion-recovery-",
  }),
});

export const PRODUCTION_ROUTE_TOKEN_SCOPE_QUERY =
  `query PintPathProductionRouteTokenScope { projectToken { projectId environmentId } }`;
export const PRODUCTION_ROUTE_EMPTY_PATCH_QUERY =
  `query PintPathProductionRouteEmptyPatch($projectId:String!,$environmentId:String!){
  environment(id:$environmentId,projectId:$projectId){id}
  staged:environmentStagedChanges(environmentId:$environmentId){environmentId patch(decryptVariables:false)}
}`;
export const PRODUCTION_ROUTE_INVENTORY_QUERY =
  `query PintPathProductionRouteInventory($projectId:String!,$environmentId:String!){
  environment(id:$environmentId,projectId:$projectId){
    id
    serviceInstances(first:100){
      edges{node{
        id serviceId serviceName environmentId numReplicas
        latestDeployment{id status deploymentStopped snapshotId}
        activeDeployments{id status deploymentStopped}
        domains{serviceDomains{id domain targetPort}customDomains{id domain targetPort}}
      }}
      pageInfo{hasNextPage endCursor}
    }
  }
}`;
export const PRODUCTION_ROUTE_TARGET_QUERY =
  `query PintPathProductionRouteTarget($environmentId:String!,$serviceId:String!,$deploymentId:String!){
  serviceInstance(environmentId:$environmentId,serviceId:$serviceId){
    id serviceId environmentId numReplicas
    latestDeployment{id status deploymentStopped snapshotId}
    activeDeployments{id status deploymentStopped}
    domains{serviceDomains{id domain targetPort}customDomains{id domain targetPort}}
  }
  deployment(id:$deploymentId){id projectId environmentId serviceId snapshotId meta}
}`;
export const PRODUCTION_ROUTE_CLOSE_MUTATION =
  `mutation PintPathCloseProductionRoute($id:String!){customDomainDelete(id:$id)}`;
export const PRODUCTION_ROUTE_OPEN_MUTATION =
  `mutation PintPathOpenProductionRoute($input:CustomDomainCreateInput!){
  customDomainCreate(input:$input){id domain environmentId serviceId projectId targetPort}
}`;

type Operation = "close" | "open";
type Outcome =
  | "closed"
  | "opened"
  | "closed_reconciled_after_lost_ack"
  | "opened_reconciled_after_lost_ack"
  | "failed_before_attempt"
  | "mutation_uncertain"
  | "blocked";
interface Args {
  readonly operation: Operation;
  readonly candidateSha: string;
  readonly evidenceDir: string;
  readonly githubAuthority: string;
  readonly deploymentReceipt: string | null;
  readonly scaleReceipt: string | null;
  readonly closeReceipt: string | null;
  readonly promotionRecoveryReceipt: string | null;
}
interface ProductionChainArtifact {
  readonly stage: string;
  readonly artifactId: number;
  readonly name: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly runId: number;
  readonly producerCheck: string;
}
interface ProductionChainStage {
  readonly stage: string;
  readonly name: string;
  readonly runId: number;
  readonly checkSuiteId: number;
  readonly workflowId: number;
  readonly workflowPath: string;
  readonly event: "workflow_dispatch";
  readonly runAttempt: 1;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly artifact: ProductionChainArtifact;
}
interface GithubPredecessorAuthority {
  readonly sourceSha256: string;
  readonly orderedProductionChainSha256: string;
  readonly consumerStartedAt: string;
  readonly stages: readonly ProductionChainStage[];
}
interface PromotionRecoveryAuthority {
  readonly sourceSha256: string;
  readonly receipt: ProductionPromotionRecoveryReceipt;
}
interface OperationReceiptAuthorities {
  productionDeploymentReceiptSha256: string | null;
  productionScaleReceiptSha256: string | null;
  closedRouteReceiptSha256: string | null;
}
interface Route {
  readonly kind: "service" | "custom";
  readonly id: string;
  readonly domain: string;
  readonly targetPort: number | null;
}
interface InventoryService {
  readonly instanceId: string;
  readonly serviceId: string;
  readonly serviceName: string;
  readonly environmentId: string;
  readonly numReplicas: number;
  readonly latestDeployment: {
    readonly id: string;
    readonly status: string;
    readonly deploymentStopped: boolean;
    readonly snapshotId: string;
  };
  readonly activeDeployments: readonly {
    readonly id: string;
    readonly status: string;
    readonly deploymentStopped: boolean;
  }[];
  readonly routes: readonly Route[];
}
interface Inventory {
  readonly environmentId: string;
  readonly services: readonly InventoryService[];
}
interface RepositoryState {
  readonly headSha: string;
  readonly originMainSha: string;
  readonly clean: boolean;
}
interface Checks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  repositoryAuthorityExact: boolean;
  predecessorAuthorityExact: boolean;
  predecessorReceiptsExact: boolean;
  promotionRecoveryAuthorityExact: boolean;
  credentialsExact: boolean;
  tokenScopesExact: boolean;
  patchPreflightEmpty: boolean;
  inventoryPreflightExact: boolean;
  candidateDeploymentPreflightExact: boolean;
  boundaryPreflightExact: boolean;
  durableIntentExact: boolean;
  repositoryPrewriteReasserted: boolean;
  providerPrewriteReasserted: boolean;
  writeAttemptedAtMostOnce: boolean;
  acknowledgementExact: boolean;
  postflightAttempted: boolean;
  patchPostflightEmpty: boolean;
  inventoryTransitionExact: boolean;
  candidateDeploymentPostflightExact: boolean;
  boundaryPostflightExact: boolean;
  publicRuntimePostflightExact: boolean;
  terminalEvidenceExact: boolean;
  finalReceiptEvidenceExact: boolean;
}
interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly repositoryState: (cwd: string) => RepositoryState;
  readonly reassertRepositoryState: (
    cwd: string,
    candidateSha: string,
  ) => RepositoryState;
  readonly runBoundary: () => Promise<boolean>;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function observedTimestamp(now: () => number): string {
  const value = now();
  if (!Number.isFinite(value)) throw new Error("clock_invalid");
  return new Date(value).toISOString();
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return record(value)
    && Object.keys(value).length === names.length
    && names.every((name, index) => Object.keys(value)[index] === name);
}
function safeString(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && !/[\r\n\0]/.test(value);
}
function parseArgs(argv: readonly string[]): Args | null {
  if (argv.length !== 12) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) return null;
    values.set(key, value);
  }
  const operation = values.get("--operation") ?? "";
  const candidateSha = values.get("--candidate-sha") ?? "";
  const evidenceDir = values.get("--evidence-dir") ?? "";
  const githubAuthority = values.get("--github-authority") ?? "";
  const deploymentReceipt = values.get("--deployment-receipt") ?? null;
  const scaleReceipt = values.get("--scale-receipt") ?? null;
  const closeReceipt = values.get("--close-receipt") ?? null;
  const promotionRecoveryReceipt = values.get("--promotion-recovery-receipt") ?? null;
  if ((operation !== "close" && operation !== "open")
    || !SHA.test(candidateSha)
    || !path.isAbsolute(evidenceDir)
    || !path.isAbsolute(githubAuthority)
    || githubAuthority === evidenceDir
    || (operation === "close" && (values.size !== 6
      || deploymentReceipt === null || !path.isAbsolute(deploymentReceipt)
      || scaleReceipt === null || !path.isAbsolute(scaleReceipt)
      || closeReceipt !== null || promotionRecoveryReceipt !== null))
    || (operation === "open" && (values.size !== 6
      || deploymentReceipt !== null || scaleReceipt !== null
      || closeReceipt === null || !path.isAbsolute(closeReceipt)
      || promotionRecoveryReceipt === null
      || !path.isAbsolute(promotionRecoveryReceipt)))) return null;
  return {
    operation,
    candidateSha,
    evidenceDir,
    githubAuthority,
    deploymentReceipt,
    scaleReceipt,
    closeReceipt,
    promotionRecoveryReceipt,
  };
}
function policyExact(cwd: string): boolean {
  try {
    const source = fs.readFileSync(path.resolve(cwd, POLICY_PATH));
    if (sha256(source) !== POLICY_SHA256) return false;
    const value = JSON.parse(source.toString("utf8")) as unknown;
    return canonical(value) === source.toString("utf8")
      && exact(value, [
        "schemaVersion", "policyId", "activationState", "projectId", "target",
        "githubEnvironments", "candidateContract", "predecessorAuthorityContract", "mutationBoundary",
        "providerContract", "inventoryContract", "openRuntimeContract", "evidence",
      ])
      && value.schemaVersion === "pintpath-protected-production-route-mutation-policy/v3"
      && value.policyId === "pintpath-protected-production-canonical-route"
      && value.activationState === PROTECTED_PRODUCTION_ROUTE_MUTATION_STATE
      && value.projectId === PROJECT_ID
      && exact(value.target, [
        "environmentId", "forbiddenEnvironmentId", "serviceId", "domainKind",
        "domain", "targetPort", "requiredGitRef",
      ])
      && value.target.environmentId === PRODUCTION_ENVIRONMENT_ID
      && value.target.forbiddenEnvironmentId === STAGING_ENVIRONMENT_ID
      && value.target.serviceId === SERVICE_ID
      && value.target.domainKind === "custom"
      && value.target.domain === DOMAIN
      && value.target.targetPort === TARGET_PORT
      && value.target.requiredGitRef === "refs/heads/main"
      && exact(value.githubEnvironments, ["close", "open"])
      && value.githubEnvironments.close === "production-route-close"
      && value.githubEnvironments.open === "production-route-open"
      && exact(value.candidateContract, [
        "exactCurrentMainHeadRequired", "cleanCommittedHeadRequired",
        "healthySoleActiveDeploymentRequired", "requiredReplicaCount",
      ])
      && value.candidateContract.exactCurrentMainHeadRequired === true
      && value.candidateContract.cleanCommittedHeadRequired === true
      && value.candidateContract.healthySoleActiveDeploymentRequired === true
      && value.candidateContract.requiredReplicaCount === 2
      && exact(value.predecessorAuthorityContract, [
        "schemaVersion", "policySha256", "requiredPhaseByOperation",
        "requiredStagesByOperation", "currentConsumerRunExact",
        "runAttemptOneRequired", "predecessorsCompletedBeforeConsumerStarted",
        "strictChronologyRequired", "strictCanonicalJsonRequired",
        "artifactIdDigestAndSizeRequired", "orderedProductionChainSha256Required",
        "githubAuthenticatedPullRequestRequired", "reviewedPrHeadTreeEqualityRequired",
        "linearHistoryRequired", "pullRequestApprovalRequirement",
        "promotionRecoveryReceiptSchemaVersion", "promotionRecoveryPolicySha256",
        "promotionRecoverySelfHashRequired",
        "promotionRecoveryCandidateDeploymentAndCloseBindingRequired",
      ])
      && value.predecessorAuthorityContract.schemaVersion
        === "pintpath-github-release-candidate-receipt/v5"
      && value.predecessorAuthorityContract.policySha256 === RELEASE_POLICY_SHA256
      && exact(value.predecessorAuthorityContract.requiredPhaseByOperation, ["close", "open"])
      && value.predecessorAuthorityContract.requiredPhaseByOperation.close === "close"
      && value.predecessorAuthorityContract.requiredPhaseByOperation.open === "open"
      && exact(value.predecessorAuthorityContract.requiredStagesByOperation, ["close", "open"])
      && JSON.stringify(value.predecessorAuthorityContract.requiredStagesByOperation.close)
        === '["deploy","scale"]'
      && JSON.stringify(value.predecessorAuthorityContract.requiredStagesByOperation.open)
        === '["deploy","scale","close","activation","promotion-recovery"]'
      && value.predecessorAuthorityContract.currentConsumerRunExact === true
      && value.predecessorAuthorityContract.runAttemptOneRequired === true
      && value.predecessorAuthorityContract.predecessorsCompletedBeforeConsumerStarted === true
      && value.predecessorAuthorityContract.strictChronologyRequired === true
      && value.predecessorAuthorityContract.strictCanonicalJsonRequired === true
      && value.predecessorAuthorityContract.artifactIdDigestAndSizeRequired === true
      && value.predecessorAuthorityContract.orderedProductionChainSha256Required === true
      && value.predecessorAuthorityContract.githubAuthenticatedPullRequestRequired === true
      && value.predecessorAuthorityContract.reviewedPrHeadTreeEqualityRequired === true
      && value.predecessorAuthorityContract.linearHistoryRequired === true
      && value.predecessorAuthorityContract.pullRequestApprovalRequirement === "not_required"
      && value.predecessorAuthorityContract.promotionRecoveryReceiptSchemaVersion
        === "pintpath-production-promotion-recovery-receipt/v1"
      && value.predecessorAuthorityContract.promotionRecoveryPolicySha256
        === PROMOTION_RECOVERY_POLICY_SHA256
      && value.predecessorAuthorityContract.promotionRecoverySelfHashRequired === true
      && value.predecessorAuthorityContract
        .promotionRecoveryCandidateDeploymentAndCloseBindingRequired === true
      && exact(value.mutationBoundary, [
        "policyPath", "policySha256", "immediatePreflightRequired",
        "unconditionalPostflightRequired",
      ])
      && value.mutationBoundary.policyPath === BOUNDARY_POLICY_PATH
      && value.mutationBoundary.policySha256 === BOUNDARY_POLICY_SHA256
      && value.mutationBoundary.immediatePreflightRequired === true
      && value.mutationBoundary.unconditionalPostflightRequired === true
      && exact(value.providerContract, [
        "graphqlEndpoint", "railwayCliSchemaVersion", "railwayCliSchemaSha256",
        "closeMutation", "openMutation", "maximumWriteAttemptsPerDispatch",
        "automaticRetriesAllowed", "workflowRerunsAllowed",
        "separateConfirmedDispatchRequiredPerOperation", "ambiguousOutcomeAction",
      ])
      && value.providerContract.graphqlEndpoint === ENDPOINT
      && value.providerContract.railwayCliSchemaVersion === "5.32.0"
      && value.providerContract.railwayCliSchemaSha256
        === "89530486d77ed677586554085d4ff67e8ae6d3c44a6825d67c94320d4a083285"
      && value.providerContract.closeMutation === "customDomainDelete"
      && value.providerContract.openMutation === "customDomainCreate"
      && value.providerContract.maximumWriteAttemptsPerDispatch === 1
      && value.providerContract.automaticRetriesAllowed === false
      && value.providerContract.workflowRerunsAllowed === false
      && value.providerContract.separateConfirmedDispatchRequiredPerOperation === true
      && value.providerContract.ambiguousOutcomeAction
        === "READ_ONLY_RECONCILIATION_STOP_NO_RETRY"
      && exact(value.inventoryContract, [
        "completeServicePaginationRequired", "completeRouteInventoryRequired",
        "canonicalRouteUniqueAcrossEnvironment", "onlyCanonicalRouteMayChange",
        "stagedPatchMustRemainEmpty", "candidateDeploymentMustRemainUnchanged",
      ])
      && Object.values(value.inventoryContract).every((entry) => entry === true)
      && exact(value.openRuntimeContract, [
        "httpsRequired", "validTlsRequired", "redirectsAllowed", "requiredRoutes",
        "sameCandidateAndDeploymentRequired", "maximumObservationSeconds",
        "pollIntervalSeconds",
      ])
      && value.openRuntimeContract.httpsRequired === true
      && value.openRuntimeContract.validTlsRequired === true
      && value.openRuntimeContract.redirectsAllowed === false
      && JSON.stringify(value.openRuntimeContract.requiredRoutes)
        === '["/health","/startup","/ready"]'
      && value.openRuntimeContract.sameCandidateAndDeploymentRequired === true
      && value.openRuntimeContract.maximumObservationSeconds === 900
      && value.openRuntimeContract.pollIntervalSeconds === 10
      && exact(value.evidence, [
        "durableIntentRequiredBeforeWrite", "terminalEvidenceRequired",
        "finalReceiptEvidenceRequired",
        "providerCredentialsAllowedInEvidence", "secretDerivedCommitmentsAllowed",
      ])
      && value.evidence.durableIntentRequiredBeforeWrite === true
      && value.evidence.terminalEvidenceRequired === true
      && value.evidence.finalReceiptEvidenceRequired === true
      && value.evidence.providerCredentialsAllowedInEvidence === false
      && value.evidence.secretDerivedCommitmentsAllowed === false;
  } catch {
    return false;
  }
}

function timestampMilliseconds(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function sha256Exact(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function readCanonicalFile(filename: string): string {
  if (!path.isAbsolute(filename)) throw new Error("authority_path_invalid");
  let bytes: Buffer | null = null;
  try {
    bytes = readTrustedRegularFile(filename, {
      minBytes: 2,
      maxBytes: MAX_RESPONSE_BYTES,
      requireOwner: true,
    });
    const source = bytes.toString("utf8");
    if (source.includes("\0") || Buffer.byteLength(source, "utf8") !== bytes.length) {
      throw new Error("authority_file_invalid");
    }
    return source;
  } catch {
    throw new Error("authority_file_invalid");
  } finally {
    bytes?.fill(0);
  }
}

function chainArtifact(value: unknown, expectedStage: string): ProductionChainArtifact | null {
  if (!exact(value, [
    "stage", "artifactId", "name", "digest", "sizeBytes", "runId", "producerCheck",
  ])
    || value.stage !== expectedStage
    || !positiveInteger(value.artifactId)
    || !safeString(value.name, 160)
    || typeof value.digest !== "string" || !ARTIFACT_DIGEST.test(value.digest)
    || !positiveInteger(value.sizeBytes)
    || !positiveInteger(value.runId)
    || !safeString(value.producerCheck, 160)) return null;
  return value as unknown as ProductionChainArtifact;
}

function chainStage(
  value: unknown,
  expectedStage: keyof typeof PRODUCTION_STAGE_CONTRACTS,
  candidateSha: string,
): ProductionChainStage | null {
  const contract = PRODUCTION_STAGE_CONTRACTS[expectedStage];
  if (!exact(value, [
    "stage", "name", "runId", "checkSuiteId", "workflowId", "workflowPath",
    "event", "runAttempt", "startedAt", "completedAt", "artifact",
  ])
    || value.stage !== expectedStage
    || value.name !== contract.name
    || !positiveInteger(value.runId)
    || !positiveInteger(value.checkSuiteId)
    || !positiveInteger(value.workflowId)
    || value.workflowPath !== contract.workflowPath
    || value.event !== "workflow_dispatch"
    || value.runAttempt !== 1) return null;
  const startedAt = timestampMilliseconds(value.startedAt);
  const completedAt = timestampMilliseconds(value.completedAt);
  const artifact = chainArtifact(value.artifact, expectedStage);
  if (startedAt === null || completedAt === null || completedAt <= startedAt
    || !artifact || artifact.runId !== value.runId
    || artifact.producerCheck !== value.name
    || artifact.name !== `${contract.artifactPrefix}${candidateSha}`) return null;
  return value as unknown as ProductionChainStage;
}

function genericCheckExact(value: unknown): boolean {
  if (!record(value)) return false;
  const hasStage = Object.hasOwn(value, "stage");
  const keys = hasStage
    ? [
        "stage", "name", "runId", "checkSuiteId", "workflowId", "workflowPath",
        "event", "runAttempt", "startedAt", "completedAt",
      ]
    : [
        "name", "runId", "checkSuiteId", "workflowId", "workflowPath", "event",
        "runAttempt", "startedAt", "completedAt",
      ];
  if (!exact(value, keys)
    || (hasStage && ![
      "deploy", "scale", "close", "activation", "promotion-recovery", "open",
    ]
      .includes(String(value.stage)))
    || !safeString(value.name, 160)
    || !positiveInteger(value.runId)
    || !positiveInteger(value.checkSuiteId)
    || !positiveInteger(value.workflowId)
    || typeof value.workflowPath !== "string"
    || !/^\.github\/workflows\/[a-z0-9][a-z0-9._-]*\.ya?ml$/.test(value.workflowPath)
    || (value.event !== "push" && value.event !== "workflow_dispatch")
    || value.runAttempt !== 1) return false;
  const startedAt = timestampMilliseconds(value.startedAt);
  const completedAt = timestampMilliseconds(value.completedAt);
  return startedAt !== null && completedAt !== null && completedAt > startedAt;
}

function genericArtifactExact(value: unknown): boolean {
  if (!record(value)) return false;
  const hasStage = Object.hasOwn(value, "stage");
  const keys = hasStage
    ? ["stage", "artifactId", "name", "digest", "sizeBytes", "runId", "producerCheck"]
    : ["artifactId", "name", "digest", "sizeBytes", "runId", "producerCheck"];
  return exact(value, keys)
    && (!hasStage || [
      "deploy", "scale", "close", "activation", "promotion-recovery", "open",
    ]
      .includes(String(value.stage)))
    && positiveInteger(value.artifactId)
    && safeString(value.name, 160)
    && typeof value.digest === "string" && ARTIFACT_DIGEST.test(value.digest)
    && positiveInteger(value.sizeBytes)
    && positiveInteger(value.runId)
    && safeString(value.producerCheck, 160);
}

function reviewedPullRequestExact(value: unknown, candidateSha: string): boolean {
  if (!record(value) || !exact(value, [
    "number", "reviewedPrHeadSha", "mergeCommitSha", "treeSha", "mergedAt",
    "authorId", "mergedById", "githubMergeExact", "reviewedTreeExact",
    "pullRequestApprovalRequirement", "pullRequestApprovalRequirementExact",
    "linearHistoryExact",
  ])) return false;
  return positiveInteger(value.number)
    && typeof value.reviewedPrHeadSha === "string" && SHA.test(value.reviewedPrHeadSha)
    && value.mergeCommitSha === candidateSha
    && typeof value.treeSha === "string" && SHA.test(value.treeSha)
    && timestampMilliseconds(value.mergedAt) !== null
    && positiveInteger(value.authorId)
    && positiveInteger(value.mergedById)
    && value.githubMergeExact === true
    && value.reviewedTreeExact === true
    && value.pullRequestApprovalRequirement === "not_required"
    && value.pullRequestApprovalRequirementExact === true
    && value.linearHistoryExact === true;
}

function parseGithubPredecessorAuthority(
  source: string,
  args: Args,
  env: Readonly<Record<string, string | undefined>>,
): GithubPredecessorAuthority | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (canonical(value) !== source || !exact(value, [
      "schemaVersion", "repository", "branch", "phase", "candidateSha",
      "reviewedPullRequest", "policySha256", "consumer", "checks", "artifacts",
      "productionChain",
      "orderedProductionChainSha256", "requiredChecksExact", "requiredArtifactsExact",
      "chronologyExact", "currentConsumerExact",
    ])
      || value.schemaVersion !== "pintpath-github-release-candidate-receipt/v5"
      || value.repository !== "blackmagic30/Beer"
      || value.branch !== "main"
      || value.phase !== args.operation
      || value.candidateSha !== args.candidateSha
      || !reviewedPullRequestExact(value.reviewedPullRequest, args.candidateSha)
      || value.policySha256 !== RELEASE_POLICY_SHA256
      || value.requiredChecksExact !== true
      || value.requiredArtifactsExact !== true
      || value.chronologyExact !== true
      || value.currentConsumerExact !== true
      || !exact(value.consumer, [
        "runId", "workflowId", "workflowPath", "event", "runAttempt", "runStartedAt",
      ])) return null;
    const expectedWorkflow = `.github/workflows/${args.operation}-production-route.yml`;
    const expectedWorkflowRef = `blackmagic30/Beer/${expectedWorkflow}@refs/heads/main`;
    const consumerStartedAt = timestampMilliseconds(value.consumer.runStartedAt);
    if (!positiveInteger(value.consumer.runId)
      || !positiveInteger(value.consumer.workflowId)
      || value.consumer.workflowPath !== expectedWorkflow
      || value.consumer.event !== "workflow_dispatch"
      || value.consumer.runAttempt !== 1
      || consumerStartedAt === null
      || env.GITHUB_RUN_ID !== String(value.consumer.runId)
      || env.GITHUB_WORKFLOW_REF !== expectedWorkflowRef) return null;
    const expectedCheckCount = args.operation === "close" ? 13 : 16;
    const expectedArtifactCount = args.operation === "close" ? 7 : 10;
    if (!Array.isArray(value.checks) || value.checks.length !== expectedCheckCount
      || value.checks.some((item) => !genericCheckExact(item))
      || new Set(value.checks.map((item) => (item as { name: string }).name)).size
        !== value.checks.length
      || !Array.isArray(value.artifacts) || value.artifacts.length !== expectedArtifactCount
      || value.artifacts.some((item) => !genericArtifactExact(item))
      || new Set(value.artifacts.map((item) => (item as { name: string }).name)).size
        !== value.artifacts.length
      || new Set(value.artifacts.map((item) => (item as { artifactId: number }).artifactId)).size
        !== value.artifacts.length
      || !Array.isArray(value.productionChain)) return null;
    if (value.checks.some((item) =>
      timestampMilliseconds((item as { completedAt: string }).completedAt)! >= consumerStartedAt)) {
      return null;
    }
    const expectedStages: Array<keyof typeof PRODUCTION_STAGE_CONTRACTS> = args.operation === "close"
      ? ["deploy", "scale"]
      : ["deploy", "scale", "close", "activation", "promotion-recovery"];
    if (value.productionChain.length !== expectedStages.length) return null;
    const stages: ProductionChainStage[] = [];
    for (let index = 0; index < expectedStages.length; index += 1) {
      const stage = chainStage(
        value.productionChain[index],
        expectedStages[index]!,
        args.candidateSha,
      );
      if (!stage) return null;
      const matchingChecks = value.checks.filter((item) =>
        record(item) && item.stage === stage.stage);
      const matchingArtifacts = value.artifacts.filter((item) =>
        record(item) && item.stage === stage.stage);
      const { artifact: _artifact, ...stageCheck } = stage;
      if (matchingChecks.length !== 1 || matchingArtifacts.length !== 1
        || canonical(matchingChecks[0]) !== canonical(stageCheck)
        || canonical(matchingArtifacts[0]) !== canonical(stage.artifact)) return null;
      if (index > 0) {
        const priorCompletedAt = timestampMilliseconds(stages[index - 1]!.completedAt);
        const currentStartedAt = timestampMilliseconds(stage.startedAt);
        if (priorCompletedAt === null || currentStartedAt === null
          || priorCompletedAt >= currentStartedAt) return null;
      }
      stages.push(stage);
    }
    const lastCompletedAt = timestampMilliseconds(stages.at(-1)?.completedAt);
    if (lastCompletedAt === null || lastCompletedAt >= consumerStartedAt) return null;
    const chainSha = sha256(canonical(value.productionChain));
    if (typeof value.orderedProductionChainSha256 !== "string"
      || !SHA256.test(value.orderedProductionChainSha256)
      || value.orderedProductionChainSha256 !== chainSha) return null;
    return {
      sourceSha256: sha256(source),
      orderedProductionChainSha256: chainSha,
      consumerStartedAt: value.consumer.runStartedAt as string,
      stages,
    };
  } catch {
    return null;
  }
}

function parsePromotionRecoveryAuthority(
  source: string,
  candidateSha: string,
  deploymentIdSha256: string,
  predecessorAuthority: GithubPredecessorAuthority,
  closedRoute: {
    readonly sourceSha256: string;
    readonly terminalEvidenceSha256: string;
    readonly completedAt: string;
    readonly productionDeploymentReceiptSha256: string;
    readonly productionScaleReceiptSha256: string;
  },
): PromotionRecoveryAuthority | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (canonical(value) !== source) return null;
    const parsed = parseProductionPromotionRecoveryReceipt(value);
    const closeStage = predecessorAuthority.stages.find((stage) => stage.stage === "close");
    const promotionStage = predecessorAuthority.stages.find(
      (stage) => stage.stage === "promotion-recovery",
    );
    const promotionCommittedAt = timestampMilliseconds(parsed.promotionCommittedAt);
    const closeCompletedAt = timestampMilliseconds(closeStage?.completedAt);
    const attestedAt = timestampMilliseconds(parsed.attestedAt);
    const promotionStartedAt = timestampMilliseconds(promotionStage?.startedAt);
    const promotionCompletedAt = timestampMilliseconds(promotionStage?.completedAt);
    if (!closeStage || !promotionStage
      || parsed.candidateSha !== candidateSha
      || parsed.policySha256 !== PROMOTION_RECOVERY_POLICY_SHA256
      || parsed.productionDeploymentIdSha256 !== deploymentIdSha256
      || parsed.productionDeploymentReceiptSha256
        !== closedRoute.productionDeploymentReceiptSha256
      || parsed.productionScaleReceiptSha256
        !== closedRoute.productionScaleReceiptSha256
      || parsed.closedRouteReceiptSha256 !== closedRoute.sourceSha256
      || parsed.closedRouteTerminalEvidenceSha256
        !== closedRoute.terminalEvidenceSha256
      || promotionCommittedAt === null || closeCompletedAt === null
      || promotionCommittedAt <= closeCompletedAt
      || promotionCommittedAt <= timestampMilliseconds(closedRoute.completedAt)!
      || attestedAt === null || promotionStartedAt === null || promotionCompletedAt === null
      || promotionCommittedAt > attestedAt
      || attestedAt < promotionStartedAt || attestedAt > promotionCompletedAt) return null;
    return { sourceSha256: sha256(source), receipt: parsed };
  } catch {
    return null;
  }
}

function timestampWithinStage(
  startedAt: unknown,
  completedAt: unknown,
  stage: ProductionChainStage,
): boolean {
  const started = timestampMilliseconds(startedAt);
  const completed = timestampMilliseconds(completedAt);
  const stageStarted = timestampMilliseconds(stage.startedAt);
  const stageCompleted = timestampMilliseconds(stage.completedAt);
  return started !== null && completed !== null
    && stageStarted !== null && stageCompleted !== null
    && started >= stageStarted && completed >= started && completed <= stageCompleted;
}

function parseProductionDeploymentReceipt(
  source: string,
  candidateSha: string,
  stage: ProductionChainStage,
): { sourceSha256: string; deploymentIdSha256: string; completedAt: string } | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (canonical(value) !== source || !exact(value, [
      "schemaVersion", "operation", "executorState", "target", "outcome",
      "candidateSha", "startedAt", "completedAt", "writeAttempts", "acknowledgement",
      "previousDeploymentIdSha256", "deploymentIdSha256", "intentSha256",
      "cliOutputSha256", "boundaryPreflightSha256", "boundaryPostflightSha256",
      "collateralSnapshotSha256s", "replicaCounts", "runtimeResponseSha256s", "checks",
    ])
      || value.schemaVersion !== "pintpath-railway-application-deployment-executor/v4"
      || value.operation !== "pintpath-railway-application-source-upload"
      || value.executorState !== PROTECTED_PRODUCTION_ROUTE_MUTATION_STATE
      || value.target !== "production"
      || !["deployed", "already_deployed", "reconciled_success"].includes(String(value.outcome))
      || value.candidateSha !== candidateSha
      || !timestampWithinStage(value.startedAt, value.completedAt, stage)
      || (value.writeAttempts !== 0 && value.writeAttempts !== 1)
      || !["not_attempted", "received", "missing_or_failed"].includes(
        String(value.acknowledgement),
      )
      || !sha256Exact(value.previousDeploymentIdSha256)
      || !sha256Exact(value.deploymentIdSha256)
      || !sha256Exact(value.intentSha256)
      || !sha256Exact(value.boundaryPreflightSha256)
      || !sha256Exact(value.boundaryPostflightSha256)
      || (value.writeAttempts === 0
        ? value.cliOutputSha256 !== null
        : !sha256Exact(value.cliOutputSha256))
      || !exact(value.collateralSnapshotSha256s, ["before", "after"])
      || !sha256Exact(value.collateralSnapshotSha256s.before)
      || !sha256Exact(value.collateralSnapshotSha256s.after)
      || !exact(value.replicaCounts, ["before", "after"])
      || (value.replicaCounts.after !== 1 && value.replicaCounts.after !== 2)
      || value.replicaCounts.before !== value.replicaCounts.after
      || !exact(value.runtimeResponseSha256s, ["health", "startup", "ready"])
      || !sha256Exact(value.runtimeResponseSha256s.health)
      || !sha256Exact(value.runtimeResponseSha256s.startup)
      || !sha256Exact(value.runtimeResponseSha256s.ready)
      || !exact(value.checks, [
        "policyExact", "githubMainExact", "sourceAuthorityExact", "cliExact",
        "writeTokenScopeExact", "costPolicyExact", "prerequisiteExact",
        "boundaryPreflightExact", "targetPreflightExact", "gitAutodeployAbsent",
        "collateralInventoryExact", "durableIntentExact", "sourceReasserted",
        "writeAttemptedAtMostOnce", "targetPostflightAttempted", "targetPostflightExact",
        "reconciliationCompleted", "topologyPreserved", "deploymentExact",
        "runtimeHealthExact", "runtimeStartupExact", "runtimeReadinessExact",
        "collateralStateUnchanged", "boundaryPostflightExact", "terminalEvidenceExact",
      ])
      || Object.values(value.checks).some((check) => check !== true)
      || (value.outcome === "already_deployed"
        ? value.writeAttempts !== 0 || value.acknowledgement !== "not_attempted"
        : value.writeAttempts !== 1)
      || (value.outcome === "deployed" && value.acknowledgement !== "received")
      || (value.outcome === "reconciled_success"
        && value.acknowledgement !== "missing_or_failed")) return null;
    return {
      sourceSha256: sha256(source),
      deploymentIdSha256: value.deploymentIdSha256,
      completedAt: value.completedAt as string,
    };
  } catch {
    return null;
  }
}

function parseProductionScaleReceipt(
  source: string,
  candidateSha: string,
  deploymentIdSha256: string,
  deploymentCompletedAt: string,
  stage: ProductionChainStage,
): { sourceSha256: string } | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (canonical(value) !== source || !exact(value, [
      "schemaVersion", "executorState", "direction", "outcome", "candidateSha",
      "startedAt", "completedAt", "desiredReplicas", "deploymentIdSha256", "attempts",
      "retryAllowed", "intentSha256", "terminalEvidenceSha256", "commandStdoutSha256",
      "commandStderrSha256", "checks",
    ])
      || value.schemaVersion !== "pintpath-permanent-staging-scale-operation/v1"
      || value.executorState !== PROTECTED_PRODUCTION_ROUTE_MUTATION_STATE
      || value.direction !== "converge-production-two"
      || (value.outcome !== "scaled" && value.outcome !== "already_converged")
      || value.candidateSha !== candidateSha
      || value.desiredReplicas !== 2
      || value.deploymentIdSha256 !== deploymentIdSha256
      || value.retryAllowed !== false
      || (value.attempts !== 0 && value.attempts !== 1)
      || !timestampWithinStage(value.startedAt, value.completedAt, stage)
      || timestampMilliseconds(value.startedAt)! < timestampMilliseconds(deploymentCompletedAt)!
      || !sha256Exact(value.terminalEvidenceSha256)
      || (value.attempts === 0
        ? value.intentSha256 !== null
          || value.commandStdoutSha256 !== null
          || value.commandStderrSha256 !== null
        : !sha256Exact(value.intentSha256)
          || !sha256Exact(value.commandStdoutSha256)
          || !sha256Exact(value.commandStderrSha256))
      || !exact(value.checks, [
        "policyExact", "githubAuthorityExact", "tokenScopesExact", "cliExact",
        "boundaryPreflightExact", "targetPreflightExact", "durableIntentExact",
        "repositoryPrewriteReasserted", "writeAttemptedAtMostOnce", "acknowledgementExact",
        "postflightAttempted", "targetPostflightExact", "candidateUnchanged",
        "deploymentUnchanged", "boundaryPostflightExact", "terminalEvidenceExact",
        "finalReceiptEvidenceExact",
      ])) return null;
    const required = Object.entries(value.checks)
      .filter(([name]) => name !== "durableIntentExact")
      .every(([, check]) => check === true);
    if (!required || value.checks.durableIntentExact !== (value.attempts === 1)
      || (value.outcome === "scaled") !== (value.attempts === 1)) return null;
    return { sourceSha256: sha256(source) };
  } catch {
    return null;
  }
}

function closeReceiptChecksExact(value: unknown): boolean {
  if (!exact(value, [
    "policyExact", "githubAuthorityExact", "repositoryAuthorityExact",
    "predecessorAuthorityExact", "predecessorReceiptsExact",
    "promotionRecoveryAuthorityExact", "credentialsExact", "tokenScopesExact",
    "patchPreflightEmpty", "inventoryPreflightExact", "candidateDeploymentPreflightExact",
    "boundaryPreflightExact", "durableIntentExact", "repositoryPrewriteReasserted",
    "providerPrewriteReasserted", "writeAttemptedAtMostOnce", "acknowledgementExact",
    "postflightAttempted", "patchPostflightEmpty", "inventoryTransitionExact",
    "candidateDeploymentPostflightExact", "boundaryPostflightExact",
    "publicRuntimePostflightExact", "terminalEvidenceExact", "finalReceiptEvidenceExact",
  ])) return false;
  return Object.entries(value).every(([name, check]) =>
    name === "publicRuntimePostflightExact" || name === "acknowledgementExact"
      ? typeof check === "boolean"
      : check === true)
    && value.publicRuntimePostflightExact === false;
}

function parseClosedRouteReceipt(
  source: string,
  candidateSha: string,
  deploymentIdSha256: string,
  predecessorAuthority: GithubPredecessorAuthority,
): {
  sourceSha256: string;
  terminalEvidenceSha256: string;
  completedAt: string;
  productionDeploymentReceiptSha256: string;
  productionScaleReceiptSha256: string;
} | null {
  try {
    const value = JSON.parse(source) as unknown;
    const stage = predecessorAuthority.stages.find((item) => item.stage === "close");
    const deploy = predecessorAuthority.stages.find((item) => item.stage === "deploy");
    const scale = predecessorAuthority.stages.find((item) => item.stage === "scale");
    if (!stage || !deploy || !scale || canonical(value) !== source || !exact(value, [
      "schemaVersion", "executorState", "outcome", "operation", "candidateSha",
      "startedAt", "completedAt", "githubEnvironment", "policySha256", "projectIdSha256",
      "environmentIdSha256", "serviceIdSha256", "domain", "targetPort", "routeIdSha256",
      "deploymentIdSha256", "predecessorAuthoritySha256", "orderedProductionChainSha256",
      "productionDeploymentArtifactDigest", "productionScaleArtifactDigest",
      "closedRouteArtifactDigest", "promotionRecoveryArtifactDigest",
      "promotionRecoveryReceiptSha256", "productionDeploymentReceiptSha256",
      "productionScaleReceiptSha256", "closedRouteReceiptSha256", "attempts", "retryAllowed",
      "intentSha256", "terminalEvidenceSha256", "beforeInventorySha256",
      "afterInventorySha256", "checks",
    ])
      || value.schemaVersion !== PROTECTED_PRODUCTION_ROUTE_MUTATION_SCHEMA
      || value.executorState !== PROTECTED_PRODUCTION_ROUTE_MUTATION_STATE
      || (value.outcome !== "closed"
        && value.outcome !== "closed_reconciled_after_lost_ack")
      || value.operation !== "close"
      || value.candidateSha !== candidateSha
      || value.githubEnvironment !== "production-route-close"
      || value.policySha256 !== POLICY_SHA256
      || value.projectIdSha256 !== sha256(PROJECT_ID)
      || value.environmentIdSha256 !== sha256(PRODUCTION_ENVIRONMENT_ID)
      || value.serviceIdSha256 !== sha256(SERVICE_ID)
      || value.domain !== DOMAIN
      || value.targetPort !== TARGET_PORT
      || !sha256Exact(value.routeIdSha256)
      || value.deploymentIdSha256 !== deploymentIdSha256
      || !sha256Exact(value.predecessorAuthoritySha256)
      || value.orderedProductionChainSha256
        !== sha256(canonical(predecessorAuthority.stages.slice(0, 2)))
      || value.productionDeploymentArtifactDigest !== deploy.artifact.digest
      || value.productionScaleArtifactDigest !== scale.artifact.digest
      || value.closedRouteArtifactDigest !== null
      || value.promotionRecoveryArtifactDigest !== null
      || value.promotionRecoveryReceiptSha256 !== null
      || typeof value.productionDeploymentReceiptSha256 !== "string"
      || !SHA256.test(value.productionDeploymentReceiptSha256)
      || typeof value.productionScaleReceiptSha256 !== "string"
      || !SHA256.test(value.productionScaleReceiptSha256)
      || value.closedRouteReceiptSha256 !== null
      || value.attempts !== 1 || value.retryAllowed !== false
      || !sha256Exact(value.intentSha256)
      || !sha256Exact(value.terminalEvidenceSha256)
      || !sha256Exact(value.beforeInventorySha256)
      || !sha256Exact(value.afterInventorySha256)
      || !timestampWithinStage(value.startedAt, value.completedAt, stage)
      || !closeReceiptChecksExact(value.checks)
      || (value.outcome === "closed")
        !== (value.checks as Record<string, unknown>).acknowledgementExact) return null;
    return {
      sourceSha256: sha256(source),
      terminalEvidenceSha256: value.terminalEvidenceSha256,
      completedAt: value.completedAt as string,
      productionDeploymentReceiptSha256:
        value.productionDeploymentReceiptSha256 as string,
      productionScaleReceiptSha256: value.productionScaleReceiptSha256 as string,
    };
  } catch {
    return null;
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("provider_query_failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("provider_query_failed");
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error("provider_query_failed");
  }
}
async function call(
  fetchImpl: typeof fetch,
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "pintpath-protected-production-route/1",
    },
    body: JSON.stringify({ operationName, query, variables }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  return boundedJson(response);
}
function providerSource(value: unknown): string {
  return JSON.stringify(value);
}
function parseRoute(value: unknown, kind: Route["kind"]): Route | null {
  if (!exact(value, ["id", "domain", "targetPort"])
    || typeof value.id !== "string" || !UUID.test(value.id)
    || !safeString(value.domain, 253)
    || !(value.targetPort === null
      || (Number.isSafeInteger(value.targetPort)
        && (value.targetPort as number) >= 1
        && (value.targetPort as number) <= 65_535))) return null;
  return { kind, id: value.id, domain: value.domain, targetPort: value.targetPort as number | null };
}
function parseInventory(value: unknown): Inventory | null {
  if (!exact(value, ["data"]) || !exact(value.data, ["environment"])) return null;
  const environment = value.data.environment;
  if (!exact(environment, ["id", "serviceInstances"])
    || environment.id !== PRODUCTION_ENVIRONMENT_ID
    || !exact(environment.serviceInstances, ["edges", "pageInfo"])
    || !Array.isArray(environment.serviceInstances.edges)
    || environment.serviceInstances.edges.length > 100
    || !exact(environment.serviceInstances.pageInfo, ["hasNextPage", "endCursor"])
    || environment.serviceInstances.pageInfo.hasNextPage !== false
    || environment.serviceInstances.pageInfo.endCursor !== null) return null;
  const services: InventoryService[] = [];
  for (const edge of environment.serviceInstances.edges) {
    if (!exact(edge, ["node"])) return null;
    const node = edge.node;
    if (!exact(node, [
      "id", "serviceId", "serviceName", "environmentId", "numReplicas",
      "latestDeployment", "activeDeployments", "domains",
    ])
      || typeof node.id !== "string" || !UUID.test(node.id)
      || typeof node.serviceId !== "string" || !UUID.test(node.serviceId)
      || !safeString(node.serviceName, 256)
      || node.environmentId !== PRODUCTION_ENVIRONMENT_ID
      || !Number.isSafeInteger(node.numReplicas)
      || (node.numReplicas as number) < 0 || (node.numReplicas as number) > 50
      || !exact(node.latestDeployment, ["id", "status", "deploymentStopped", "snapshotId"])
      || typeof node.latestDeployment.id !== "string" || !UUID.test(node.latestDeployment.id)
      || !safeString(node.latestDeployment.status, 32)
      || typeof node.latestDeployment.deploymentStopped !== "boolean"
      || typeof node.latestDeployment.snapshotId !== "string" || !UUID.test(node.latestDeployment.snapshotId)
      || !Array.isArray(node.activeDeployments) || node.activeDeployments.length > 100
      || !exact(node.domains, ["serviceDomains", "customDomains"])
      || !Array.isArray(node.domains.serviceDomains)
      || !Array.isArray(node.domains.customDomains)
      || node.domains.serviceDomains.length > 100
      || node.domains.customDomains.length > 100) return null;
    const activeDeployments: Array<{ id: string; status: string; deploymentStopped: boolean }> = [];
    for (const active of node.activeDeployments) {
      if (!exact(active, ["id", "status", "deploymentStopped"])
        || typeof active.id !== "string" || !UUID.test(active.id)
        || !safeString(active.status, 32)
        || typeof active.deploymentStopped !== "boolean") return null;
      activeDeployments.push({ id: active.id, status: active.status, deploymentStopped: active.deploymentStopped });
    }
    const routes: Route[] = [];
    for (const [kind, candidates] of [
      ["service", node.domains.serviceDomains],
      ["custom", node.domains.customDomains],
    ] as const) {
      for (const candidate of candidates) {
        const route = parseRoute(candidate, kind);
        if (!route) return null;
        routes.push(route);
      }
    }
    routes.sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(routes.map((route) => route.id)).size !== routes.length
      || new Set(routes.map((route) => route.domain)).size !== routes.length
      || new Set(activeDeployments.map((deployment) => deployment.id)).size
        !== activeDeployments.length) return null;
    services.push({
      instanceId: node.id,
      serviceId: node.serviceId,
      serviceName: node.serviceName,
      environmentId: node.environmentId,
      numReplicas: node.numReplicas as number,
      latestDeployment: {
        id: node.latestDeployment.id,
        status: node.latestDeployment.status,
        deploymentStopped: node.latestDeployment.deploymentStopped,
        snapshotId: node.latestDeployment.snapshotId,
      },
      activeDeployments,
      routes,
    });
  }
  services.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  if (new Set(services.map((service) => service.instanceId)).size !== services.length
    || new Set(services.map((service) => service.serviceId)).size !== services.length) return null;
  return { environmentId: environment.id, services };
}
function targetService(inventory: Inventory): InventoryService | null {
  const matches = inventory.services.filter((service) => service.serviceId === SERVICE_ID);
  return matches.length === 1 ? matches[0]! : null;
}
function canonicalRoutes(inventory: Inventory): Array<Route & { serviceId: string }> {
  return inventory.services.flatMap((service) => service.routes.map((route) => ({
    ...route,
    serviceId: service.serviceId,
  }))).filter((route) => route.domain === DOMAIN);
}
function candidateExact(
  snapshot: RailwayApplicationDeploymentAttestationProviderSnapshot,
  candidateSha: string,
): boolean {
  return snapshot.deployment.projectId === PROJECT_ID
    && snapshot.environmentId === PRODUCTION_ENVIRONMENT_ID
    && snapshot.serviceId === SERVICE_ID
    && snapshot.deployment.environmentId === PRODUCTION_ENVIRONMENT_ID
    && snapshot.deployment.serviceId === SERVICE_ID
    && snapshot.deployment.commitHash === candidateSha
    && snapshot.deployment.patchId === null
    && snapshot.numReplicas === 2
    && snapshot.latestDeployment.id === snapshot.deployment.id
    && snapshot.latestDeployment.snapshotId === snapshot.deployment.snapshotId
    && snapshot.latestDeployment.status === "SUCCESS"
    && snapshot.latestDeployment.deploymentStopped === false
    && snapshot.activeDeployments.length === 1
    && snapshot.activeDeployments[0]?.id === snapshot.deployment.id
    && snapshot.activeDeployments[0]?.status === "SUCCESS"
    && snapshot.activeDeployments[0]?.deploymentStopped === false;
}
function snapshotWithoutRoutes(
  snapshot: RailwayApplicationDeploymentAttestationProviderSnapshot,
): string {
  return canonical({ ...snapshot, domains: [] });
}
function inventoryTransitionExact(
  before: Inventory,
  after: Inventory,
  operation: Operation,
  expectedRoute: Route,
): boolean {
  const expected = structuredClone(before) as unknown as {
    environmentId: string;
    services: Array<{ serviceId: string; routes: Route[] }>;
  };
  const target = expected.services.find((service) => service.serviceId === SERVICE_ID);
  if (!target) return false;
  if (operation === "close") {
    target.routes = target.routes.filter((route) => route.id !== expectedRoute.id);
  } else {
    target.routes.push(expectedRoute);
    target.routes.sort((left, right) => left.id.localeCompare(right.id));
  }
  return canonical(expected) === canonical(after);
}
function parseCloseAcknowledgement(value: unknown): boolean {
  return exact(value, ["data"])
    && exact(value.data, ["customDomainDelete"])
    && value.data.customDomainDelete === true;
}
function parseOpenAcknowledgement(value: unknown): Route | null {
  if (!exact(value, ["data"]) || !exact(value.data, ["customDomainCreate"])) return null;
  const created = value.data.customDomainCreate;
  if (!exact(created, ["id", "domain", "environmentId", "serviceId", "projectId", "targetPort"])
    || created.environmentId !== PRODUCTION_ENVIRONMENT_ID
    || created.serviceId !== SERVICE_ID
    || created.projectId !== PROJECT_ID) return null;
  const route = parseRoute({
    id: created.id,
    domain: created.domain,
    targetPort: created.targetPort,
  }, "custom");
  return route?.domain === DOMAIN && route.targetPort === TARGET_PORT ? route : null;
}
async function boundedText(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new Error("runtime_probe_failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("runtime_probe_failed");
    }
    chunks.push(next.value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}
function runtimeIdentityExact(
  route: "/health" | "/startup" | "/ready",
  source: string,
  candidateSha: string,
  deploymentId: string,
): boolean {
  const value = parseRailwayApplicationDeploymentAttestationRuntimeResponse(route, source);
  return value !== null
    && value.route === route
    && value.restoreMarkerPresent === false
    && value.deployment.commitSha === candidateSha
    && value.deployment.environment === "production"
    && value.deployment.projectIdSha256
      === railwayDeploymentIdentityIdSha256("project", PROJECT_ID)
    && value.deployment.environmentIdSha256
      === railwayDeploymentIdentityIdSha256("environment", PRODUCTION_ENVIRONMENT_ID)
    && value.deployment.serviceIdSha256
      === railwayDeploymentIdentityIdSha256("service", SERVICE_ID)
    && value.deployment.deploymentIdSha256
      === railwayDeploymentIdentityIdSha256("deployment", deploymentId);
}
async function proveOpenPublicRuntime(
  fetchImpl: typeof fetch,
  candidateSha: string,
  deploymentId: string,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  const routes = ["/health", "/startup", "/ready"] as const;
  const deadline = now() + 900_000;
  for (let poll = 0; poll < 91; poll += 1) {
    try {
      let exact = true;
      for (const route of routes) {
        const response = await fetchImpl(`https://${DOMAIN}${route}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
        const source = await boundedText(response);
        exact = exact
          && runtimeIdentityExact(route, source, candidateSha, deploymentId);
      }
      if (exact) return true;
    } catch {
      // Certificate issuance, route propagation, and readiness are observed only.
    }
    if (now() >= deadline || poll === 90) return false;
    await sleep(10_000);
  }
  return false;
}
function privateWrite(directory: string, leaf: string, source: string): string {
  try {
    writePrivateExclusiveFile(directory, leaf, source, {
      requireExactDirectoryMode: true,
      requireOwner: true,
    });
  } catch {
    throw new Error("evidence_invalid");
  }
  return sha256(source);
}
function defaultRepositoryState(cwd: string): RepositoryState {
  const run = (args: readonly string[]) => execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return {
    headSha: run(["rev-parse", "HEAD"]),
    originMainSha: run(["rev-parse", "refs/remotes/origin/main"]),
    clean: run(["status", "--porcelain=v2", "--untracked-files=all"]) === "",
  };
}
function defaultReassertRepositoryState(
  cwd: string,
  _candidateSha: string,
): RepositoryState {
  execFileSync("git", [
    "fetch",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  });
  return defaultRepositoryState(cwd);
}
async function defaultBoundary(env: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  let output = "";
  const code = await runRailwayMutationBoundaryCheck({
    argv: ["--policy", BOUNDARY_POLICY_PATH],
    env: {
      PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN:
        env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN,
      PINTPATH_RAILWAY_STAGING_METADATA_TOKEN:
        env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN,
    },
    writeOutput: (source) => { output += source; },
  });
  try {
    const receipt = JSON.parse(output) as Record<string, unknown>;
    return code === 0 && receipt.mode === "read-only-boundary" && receipt.outcome === "passed";
  } catch {
    return false;
  }
}
function emptyChecks(): Checks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    repositoryAuthorityExact: false,
    predecessorAuthorityExact: false,
    predecessorReceiptsExact: false,
    promotionRecoveryAuthorityExact: false,
    credentialsExact: false,
    tokenScopesExact: false,
    patchPreflightEmpty: false,
    inventoryPreflightExact: false,
    candidateDeploymentPreflightExact: false,
    boundaryPreflightExact: false,
    durableIntentExact: false,
    repositoryPrewriteReasserted: false,
    providerPrewriteReasserted: false,
    writeAttemptedAtMostOnce: true,
    acknowledgementExact: false,
    postflightAttempted: false,
    patchPostflightEmpty: false,
    inventoryTransitionExact: false,
    candidateDeploymentPostflightExact: false,
    boundaryPostflightExact: false,
    publicRuntimePostflightExact: false,
    terminalEvidenceExact: false,
    finalReceiptEvidenceExact: false,
  };
}
function receipt(
  args: Args | null,
  outcome: Outcome,
  startedAt: string,
  completedAt: string,
  attempts: 0 | 1,
  intentSha256: string | null,
  terminalSha256: string | null,
  beforeInventorySha256: string | null,
  afterInventorySha256: string | null,
  routeIdSha256: string | null,
  deploymentIdSha256: string | null,
  predecessorAuthority: GithubPredecessorAuthority | null,
  promotionRecoveryReceiptSha256: string | null,
  operationReceiptAuthorities: OperationReceiptAuthorities,
  checks: Checks,
) {
  const stageDigest = (stage: string): string | null =>
    predecessorAuthority?.stages.find((item) => item.stage === stage)?.artifact.digest ?? null;
  return {
    schemaVersion: PROTECTED_PRODUCTION_ROUTE_MUTATION_SCHEMA,
    executorState: PROTECTED_PRODUCTION_ROUTE_MUTATION_STATE,
    outcome,
    operation: args?.operation ?? null,
    candidateSha: args?.candidateSha ?? null,
    startedAt,
    completedAt,
    githubEnvironment: args ? `production-route-${args.operation}` : null,
    policySha256: POLICY_SHA256,
    projectIdSha256: sha256(PROJECT_ID),
    environmentIdSha256: sha256(PRODUCTION_ENVIRONMENT_ID),
    serviceIdSha256: sha256(SERVICE_ID),
    domain: DOMAIN,
    targetPort: TARGET_PORT,
    routeIdSha256,
    deploymentIdSha256,
    predecessorAuthoritySha256: predecessorAuthority?.sourceSha256 ?? null,
    orderedProductionChainSha256:
      predecessorAuthority?.orderedProductionChainSha256 ?? null,
    productionDeploymentArtifactDigest: stageDigest("deploy"),
    productionScaleArtifactDigest: stageDigest("scale"),
    closedRouteArtifactDigest: stageDigest("close"),
    promotionRecoveryArtifactDigest: stageDigest("promotion-recovery"),
    promotionRecoveryReceiptSha256,
    productionDeploymentReceiptSha256:
      operationReceiptAuthorities.productionDeploymentReceiptSha256,
    productionScaleReceiptSha256:
      operationReceiptAuthorities.productionScaleReceiptSha256,
    closedRouteReceiptSha256:
      operationReceiptAuthorities.closedRouteReceiptSha256,
    attempts,
    retryAllowed: false,
    intentSha256,
    terminalEvidenceSha256: terminalSha256,
    beforeInventorySha256,
    afterInventorySha256,
    checks,
  };
}

export async function runProtectedProductionRouteMutation(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    repositoryState: defaultRepositoryState,
    reassertRepositoryState: defaultReassertRepositoryState,
    runBoundary: () => defaultBoundary(process.env),
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    writeDurable: privateWrite,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const startedAt = observedTimestamp(dependencies.now);
  let completedAt = startedAt;
  const args = parseArgs(dependencies.argv);
  const checks = emptyChecks();
  let attempts: 0 | 1 = 0;
  let outcome: Outcome = "blocked";
  let intentSha256: string | null = null;
  let terminalSha256: string | null = null;
  let beforeInventorySha256: string | null = null;
  let afterInventorySha256: string | null = null;
  let routeIdSha256: string | null = null;
  let deploymentIdSha256: string | null = null;
  let predecessorAuthority: GithubPredecessorAuthority | null = null;
  let promotionRecoveryReceiptSha256: string | null = null;
  const operationReceiptAuthorities: OperationReceiptAuthorities = {
    productionDeploymentReceiptSha256: null,
    productionScaleReceiptSha256: null,
    closedRouteReceiptSha256: null,
  };
  let metadataToken = "";
  let beforeInventory: Inventory | null = null;
  let beforeSnapshot: RailwayApplicationDeploymentAttestationProviderSnapshot | null = null;
  let expectedRoute: Route | null = null;
  try {
    checks.policyExact = policyExact(dependencies.cwd);
    checks.githubAuthorityExact = args !== null
      && dependencies.env.GITHUB_ACTIONS === "true"
      && dependencies.env.GITHUB_REF === "refs/heads/main"
      && dependencies.env.GITHUB_SHA === args.candidateSha
      && dependencies.env.GITHUB_RUN_ATTEMPT === "1"
      && typeof dependencies.env.GITHUB_RUN_ID === "string"
      && /^[1-9][0-9]*$/.test(dependencies.env.GITHUB_RUN_ID)
      && dependencies.env.PINTPATH_PRODUCTION_ROUTE_AUTHORITY_OPERATION === args.operation
      && dependencies.env.PINTPATH_PRODUCTION_ROUTE_CONFIRMATION
        === `${args.operation.toUpperCase()}_PINTPATH_PRODUCTION_ROUTE`;
    const repository = dependencies.repositoryState(dependencies.cwd);
    checks.repositoryAuthorityExact = args !== null
      && repository.headSha === args.candidateSha
      && repository.originMainSha === args.candidateSha
      && repository.clean;
    if (!args || !checks.policyExact || !checks.githubAuthorityExact
      || !checks.repositoryAuthorityExact) throw new Error("authority_invalid");
    const predecessorSource = readCanonicalFile(args.githubAuthority);
    predecessorAuthority = parseGithubPredecessorAuthority(
      predecessorSource,
      args,
      dependencies.env,
    );
    checks.predecessorAuthorityExact = predecessorAuthority !== null;
    checks.promotionRecoveryAuthorityExact = args.operation === "close";
    const routeStartedAtMs = timestampMilliseconds(startedAt);
    const consumerStartedAtMs = timestampMilliseconds(
      predecessorAuthority?.consumerStartedAt,
    );
    if (!checks.predecessorAuthorityExact || !predecessorAuthority
      || routeStartedAtMs === null || consumerStartedAtMs === null
      || routeStartedAtMs < consumerStartedAtMs) {
      throw new Error("predecessor_authority_invalid");
    }
    metadataToken = dependencies.env.PINTPATH_RAILWAY_PRODUCTION_ROUTE_METADATA_TOKEN ?? "";
    const writeToken = dependencies.env.PINTPATH_RAILWAY_PRODUCTION_ROUTE_MUTATION_TOKEN ?? "";
    const boundaryProductionToken =
      dependencies.env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
    const boundaryStagingToken =
      dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    checks.credentialsExact = TOKEN.test(metadataToken)
      && TOKEN.test(writeToken)
      && TOKEN.test(boundaryProductionToken)
      && TOKEN.test(boundaryStagingToken)
      && new Set([
        metadataToken,
        writeToken,
        boundaryProductionToken,
        boundaryStagingToken,
      ]).size === 4;
    if (!checks.credentialsExact) throw new Error("credentials_invalid");
    const initialVariables = {
      projectId: PROJECT_ID,
      environmentId: PRODUCTION_ENVIRONMENT_ID,
    };
    const [metadataScopeRaw, writeScopeRaw, patchRaw, inventoryRaw] = await Promise.all([
      call(dependencies.fetchImpl, metadataToken, "PintPathProductionRouteTokenScope",
        PRODUCTION_ROUTE_TOKEN_SCOPE_QUERY, {}),
      call(dependencies.fetchImpl, writeToken, "PintPathProductionRouteTokenScope",
        PRODUCTION_ROUTE_TOKEN_SCOPE_QUERY, {}),
      call(dependencies.fetchImpl, metadataToken, "PintPathProductionRouteEmptyPatch",
        PRODUCTION_ROUTE_EMPTY_PATCH_QUERY, initialVariables),
      call(dependencies.fetchImpl, metadataToken, "PintPathProductionRouteInventory",
        PRODUCTION_ROUTE_INVENTORY_QUERY, initialVariables),
    ]);
    const metadataScope = parseRailwayApplicationDeploymentAttestationTokenScopeResponse(
      providerSource(metadataScopeRaw),
    );
    const writeScope = parseRailwayApplicationDeploymentAttestationTokenScopeResponse(
      providerSource(writeScopeRaw),
    );
    checks.tokenScopesExact = metadataScope?.projectId === PROJECT_ID
      && metadataScope.environmentId === PRODUCTION_ENVIRONMENT_ID
      && writeScope?.projectId === PROJECT_ID
      && writeScope.environmentId === PRODUCTION_ENVIRONMENT_ID;
    const patch = parseRailwayApplicationDeploymentAttestationEmptyPatchResponse(
      providerSource(patchRaw),
    );
    checks.patchPreflightEmpty = patch?.environmentId === PRODUCTION_ENVIRONMENT_ID
      && patch.patchEmpty;
    beforeInventory = parseInventory(inventoryRaw);
    const service = beforeInventory ? targetService(beforeInventory) : null;
    const canonicalBefore = beforeInventory ? canonicalRoutes(beforeInventory) : [];
    checks.inventoryPreflightExact = beforeInventory !== null
      && service !== null
      && canonicalBefore.length === (args.operation === "close" ? 1 : 0)
      && (args.operation === "open"
        || (canonicalBefore[0]?.kind === "custom"
          && canonicalBefore[0].serviceId === SERVICE_ID
          && canonicalBefore[0].targetPort === TARGET_PORT));
    if (!checks.tokenScopesExact || !checks.patchPreflightEmpty
      || !checks.inventoryPreflightExact || !service || !beforeInventory) {
      throw new Error("preflight_invalid");
    }
    const targetRaw = await call(
      dependencies.fetchImpl,
      metadataToken,
      "PintPathProductionRouteTarget",
      PRODUCTION_ROUTE_TARGET_QUERY,
      {
        environmentId: PRODUCTION_ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
        deploymentId: service.latestDeployment.id,
      },
    );
    beforeSnapshot = parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(
      providerSource(targetRaw),
    );
    checks.candidateDeploymentPreflightExact = beforeSnapshot !== null
      && candidateExact(beforeSnapshot, args.candidateSha);
    if (!checks.candidateDeploymentPreflightExact || !beforeSnapshot) {
      throw new Error("candidate_invalid");
    }
    const observedDeploymentIdSha256 = railwayDeploymentIdentityIdSha256(
      "deployment",
      beforeSnapshot.deployment.id,
    );
    if (!observedDeploymentIdSha256) throw new Error("deployment_identity_invalid");
    deploymentIdSha256 = observedDeploymentIdSha256;
    if (args.operation === "close") {
      const deploymentStage = predecessorAuthority.stages.find(
        (stage) => stage.stage === "deploy",
      );
      const scaleStage = predecessorAuthority.stages.find(
        (stage) => stage.stage === "scale",
      );
      const deploymentAuthority = deploymentStage
        ? parseProductionDeploymentReceipt(
            readCanonicalFile(args.deploymentReceipt!),
            args.candidateSha,
            deploymentStage,
          )
        : null;
      const scaleAuthority = scaleStage && deploymentAuthority
        ? parseProductionScaleReceipt(
            readCanonicalFile(args.scaleReceipt!),
            args.candidateSha,
            deploymentAuthority.deploymentIdSha256,
            deploymentAuthority.completedAt,
            scaleStage,
          )
        : null;
      checks.predecessorReceiptsExact = deploymentAuthority !== null
        && scaleAuthority !== null
        && deploymentAuthority.deploymentIdSha256 === deploymentIdSha256;
      operationReceiptAuthorities.productionDeploymentReceiptSha256 =
        deploymentAuthority?.sourceSha256 ?? null;
      operationReceiptAuthorities.productionScaleReceiptSha256 =
        scaleAuthority?.sourceSha256 ?? null;
      if (!checks.predecessorReceiptsExact) {
        throw new Error("predecessor_receipts_invalid");
      }
    } else {
      const closedRouteAuthority = parseClosedRouteReceipt(
        readCanonicalFile(args.closeReceipt!),
        args.candidateSha,
        deploymentIdSha256,
        predecessorAuthority,
      );
      checks.predecessorReceiptsExact = closedRouteAuthority !== null;
      operationReceiptAuthorities.closedRouteReceiptSha256 =
        closedRouteAuthority?.sourceSha256 ?? null;
      if (!closedRouteAuthority) throw new Error("closed_route_receipt_invalid");
      operationReceiptAuthorities.productionDeploymentReceiptSha256 =
        closedRouteAuthority.productionDeploymentReceiptSha256;
      operationReceiptAuthorities.productionScaleReceiptSha256 =
        closedRouteAuthority.productionScaleReceiptSha256;
      const promotionSource = readCanonicalFile(args.promotionRecoveryReceipt!);
      const promotionAuthority = parsePromotionRecoveryAuthority(
        promotionSource,
        args.candidateSha,
        deploymentIdSha256,
        predecessorAuthority,
        closedRouteAuthority,
      );
      checks.promotionRecoveryAuthorityExact = promotionAuthority !== null;
      promotionRecoveryReceiptSha256 = promotionAuthority?.sourceSha256 ?? null;
      if (!checks.promotionRecoveryAuthorityExact) {
        throw new Error("promotion_recovery_authority_invalid");
      }
    }
    expectedRoute = args.operation === "close"
      ? canonicalBefore[0]!
      : null;
    beforeInventorySha256 = sha256(canonical(beforeInventory));
    const intent = canonical({
      schemaVersion: "pintpath-protected-production-route-intent/v1",
      operation: args.operation,
      candidateSha: args.candidateSha,
      githubEnvironment: `production-route-${args.operation}`,
      policySha256: POLICY_SHA256,
      beforeInventorySha256,
      deploymentIdSha256,
      predecessorAuthoritySha256: predecessorAuthority.sourceSha256,
      orderedProductionChainSha256:
        predecessorAuthority.orderedProductionChainSha256,
      predecessorArtifacts: predecessorAuthority.stages.map((stage) => ({
        stage: stage.stage,
        artifactId: stage.artifact.artifactId,
        digest: stage.artifact.digest,
        sizeBytes: stage.artifact.sizeBytes,
        runId: stage.runId,
      })),
      promotionRecoveryReceiptSha256,
      productionDeploymentReceiptSha256:
        operationReceiptAuthorities.productionDeploymentReceiptSha256,
      productionScaleReceiptSha256:
        operationReceiptAuthorities.productionScaleReceiptSha256,
      closedRouteReceiptSha256:
        operationReceiptAuthorities.closedRouteReceiptSha256,
      routeIdSha256: expectedRoute ? sha256(expectedRoute.id) : null,
      domain: DOMAIN,
      targetPort: TARGET_PORT,
      maximumWriteAttempts: 1,
      retryAllowed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    intentSha256 = dependencies.writeDurable(args.evidenceDir, "intent.json", intent);
    checks.durableIntentExact = intentSha256 === sha256(intent);
    if (!checks.durableIntentExact) throw new Error("intent_invalid");
    const prewriteRepository = dependencies.reassertRepositoryState(
      dependencies.cwd,
      args.candidateSha,
    );
    checks.repositoryPrewriteReasserted = prewriteRepository.headSha === args.candidateSha
      && prewriteRepository.originMainSha === args.candidateSha
      && prewriteRepository.clean;
    if (!checks.repositoryPrewriteReasserted) {
      throw new Error("repository_prewrite_drift");
    }
    const prewriteVariables = {
      projectId: PROJECT_ID,
      environmentId: PRODUCTION_ENVIRONMENT_ID,
    };
    const [prewritePatchRaw, prewriteInventoryRaw] = await Promise.all([
      call(dependencies.fetchImpl, metadataToken, "PintPathProductionRouteEmptyPatch",
        PRODUCTION_ROUTE_EMPTY_PATCH_QUERY, prewriteVariables),
      call(dependencies.fetchImpl, metadataToken, "PintPathProductionRouteInventory",
        PRODUCTION_ROUTE_INVENTORY_QUERY, prewriteVariables),
    ]);
    const prewritePatch = parseRailwayApplicationDeploymentAttestationEmptyPatchResponse(
      providerSource(prewritePatchRaw),
    );
    const prewriteInventory = parseInventory(prewriteInventoryRaw);
    const prewriteService = prewriteInventory ? targetService(prewriteInventory) : null;
    let prewriteSnapshot: RailwayApplicationDeploymentAttestationProviderSnapshot | null = null;
    if (prewriteService) {
      const prewriteTargetRaw = await call(
        dependencies.fetchImpl,
        metadataToken,
        "PintPathProductionRouteTarget",
        PRODUCTION_ROUTE_TARGET_QUERY,
        {
          environmentId: PRODUCTION_ENVIRONMENT_ID,
          serviceId: SERVICE_ID,
          deploymentId: prewriteService.latestDeployment.id,
        },
      );
      prewriteSnapshot = parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(
        providerSource(prewriteTargetRaw),
      );
    }
    checks.providerPrewriteReasserted = prewritePatch?.environmentId
        === PRODUCTION_ENVIRONMENT_ID
      && prewritePatch.patchEmpty
      && prewriteInventory !== null
      && canonical(prewriteInventory) === canonical(beforeInventory)
      && prewriteSnapshot !== null
      && canonical(prewriteSnapshot) === canonical(beforeSnapshot)
      && candidateExact(prewriteSnapshot, args.candidateSha);
    if (!checks.providerPrewriteReasserted) {
      throw new Error("provider_prewrite_drift");
    }
    checks.boundaryPreflightExact = await dependencies.runBoundary();
    if (!checks.boundaryPreflightExact) throw new Error("boundary_invalid");
    attempts = 1;
    try {
      if (args.operation === "close") {
        const acknowledgement = await call(
          dependencies.fetchImpl,
          writeToken,
          "PintPathCloseProductionRoute",
          PRODUCTION_ROUTE_CLOSE_MUTATION,
          { id: expectedRoute!.id },
        );
        checks.acknowledgementExact = parseCloseAcknowledgement(acknowledgement);
        routeIdSha256 = sha256(expectedRoute!.id);
      } else {
        const acknowledgement = await call(
          dependencies.fetchImpl,
          writeToken,
          "PintPathOpenProductionRoute",
          PRODUCTION_ROUTE_OPEN_MUTATION,
          {
            input: {
              domain: DOMAIN,
              environmentId: PRODUCTION_ENVIRONMENT_ID,
              projectId: PROJECT_ID,
              serviceId: SERVICE_ID,
              targetPort: TARGET_PORT,
            },
          },
        );
        expectedRoute = parseOpenAcknowledgement(acknowledgement);
        checks.acknowledgementExact = expectedRoute !== null;
        routeIdSha256 = expectedRoute ? sha256(expectedRoute.id) : null;
      }
    } catch {
      checks.acknowledgementExact = false;
    }
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  } finally {
    if (attempts === 1 && args && beforeInventory && beforeSnapshot) {
      checks.postflightAttempted = true;
      try {
        const variables = { projectId: PROJECT_ID, environmentId: PRODUCTION_ENVIRONMENT_ID };
        const [patchRaw, inventoryRaw] = await Promise.all([
          call(dependencies.fetchImpl, metadataToken, "PintPathProductionRouteEmptyPatch",
            PRODUCTION_ROUTE_EMPTY_PATCH_QUERY, variables),
          call(dependencies.fetchImpl, metadataToken, "PintPathProductionRouteInventory",
            PRODUCTION_ROUTE_INVENTORY_QUERY, variables),
        ]);
        const patch = parseRailwayApplicationDeploymentAttestationEmptyPatchResponse(
          providerSource(patchRaw),
        );
        checks.patchPostflightEmpty = patch?.environmentId === PRODUCTION_ENVIRONMENT_ID
          && patch.patchEmpty;
        const afterInventory = parseInventory(inventoryRaw);
        const service = afterInventory ? targetService(afterInventory) : null;
        if (afterInventory && service) {
          afterInventorySha256 = sha256(canonical(afterInventory));
          const afterTargetRaw = await call(
            dependencies.fetchImpl,
            metadataToken,
            "PintPathProductionRouteTarget",
            PRODUCTION_ROUTE_TARGET_QUERY,
            {
              environmentId: PRODUCTION_ENVIRONMENT_ID,
              serviceId: SERVICE_ID,
              deploymentId: service.latestDeployment.id,
            },
          );
          const afterSnapshot = parseRailwayApplicationDeploymentAttestationProviderSnapshotResponse(
            providerSource(afterTargetRaw),
          );
          checks.candidateDeploymentPostflightExact = afterSnapshot !== null
            && candidateExact(afterSnapshot, args.candidateSha)
            && snapshotWithoutRoutes(beforeSnapshot) === snapshotWithoutRoutes(afterSnapshot);
          if (!expectedRoute && args.operation === "open") {
            const observed = canonicalRoutes(afterInventory);
            if (observed.length === 1 && observed[0]?.kind === "custom"
              && observed[0].serviceId === SERVICE_ID
              && observed[0].targetPort === TARGET_PORT) {
              expectedRoute = {
                kind: observed[0].kind,
                id: observed[0].id,
                domain: observed[0].domain,
                targetPort: observed[0].targetPort,
              };
              routeIdSha256 = sha256(observed[0].id);
            }
          }
          checks.inventoryTransitionExact = expectedRoute !== null
            && inventoryTransitionExact(beforeInventory, afterInventory, args.operation, expectedRoute)
            && canonicalRoutes(afterInventory).length === (args.operation === "open" ? 1 : 0);
        }
      } catch {
        checks.patchPostflightEmpty = false;
        checks.inventoryTransitionExact = false;
        checks.candidateDeploymentPostflightExact = false;
      }
      try {
        checks.boundaryPostflightExact = await dependencies.runBoundary();
      } catch {
        checks.boundaryPostflightExact = false;
      }
      const reconciledProvider = checks.patchPostflightEmpty
        && checks.inventoryTransitionExact
        && checks.candidateDeploymentPostflightExact
        && checks.boundaryPostflightExact;
      if (args.operation === "open" && reconciledProvider) {
        try {
          checks.publicRuntimePostflightExact = await proveOpenPublicRuntime(
            dependencies.fetchImpl,
            args.candidateSha,
            beforeSnapshot.deployment.id,
            dependencies.now,
            dependencies.sleep,
          );
        } catch {
          checks.publicRuntimePostflightExact = false;
        }
      }
      const reconciled = reconciledProvider
        && (args.operation === "close" || checks.publicRuntimePostflightExact);
      if (reconciled) {
        outcome = checks.acknowledgementExact
          ? (args.operation === "close" ? "closed" : "opened")
          : (args.operation === "close"
              ? "closed_reconciled_after_lost_ack"
              : "opened_reconciled_after_lost_ack");
      } else {
        outcome = "mutation_uncertain";
      }
    }
  }
  completedAt = observedTimestamp(dependencies.now);
  if (timestampMilliseconds(completedAt)! < timestampMilliseconds(startedAt)!) {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  }
  let provisional = receipt(
    args, outcome, startedAt, completedAt, attempts, intentSha256, null,
    beforeInventorySha256, afterInventorySha256, routeIdSha256,
    deploymentIdSha256, predecessorAuthority, promotionRecoveryReceiptSha256,
    operationReceiptAuthorities, checks,
  );
  if (args && checks.durableIntentExact) {
    try {
      const terminal = canonical({
        schemaVersion: "pintpath-protected-production-route-terminal/v1",
        receipt: provisional,
      });
      terminalSha256 = dependencies.writeDurable(args.evidenceDir, "terminal.json", terminal);
      checks.terminalEvidenceExact = terminalSha256 === sha256(terminal);
    } catch {
      checks.terminalEvidenceExact = false;
      if (attempts === 1) outcome = "mutation_uncertain";
    }
  }
  provisional = receipt(
    args, outcome, startedAt, completedAt, attempts, intentSha256, terminalSha256,
    beforeInventorySha256, afterInventorySha256, routeIdSha256,
    deploymentIdSha256, predecessorAuthority, promotionRecoveryReceiptSha256,
    operationReceiptAuthorities, checks,
  );
  if (args && checks.terminalEvidenceExact) {
    try {
      checks.finalReceiptEvidenceExact = true;
      provisional = receipt(
        args, outcome, startedAt, completedAt, attempts, intentSha256, terminalSha256,
        beforeInventorySha256, afterInventorySha256, routeIdSha256,
        deploymentIdSha256, predecessorAuthority, promotionRecoveryReceiptSha256,
        operationReceiptAuthorities, checks,
      );
      const finalSource = canonical(provisional);
      checks.finalReceiptEvidenceExact = dependencies.writeDurable(
        args.evidenceDir,
        "receipt.json",
        finalSource,
      ) === sha256(finalSource);
      if (!checks.finalReceiptEvidenceExact) {
        outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
      }
    } catch {
      checks.finalReceiptEvidenceExact = false;
      outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
    }
  }
  provisional = receipt(
    args, outcome, startedAt, completedAt, attempts, intentSha256, terminalSha256,
    beforeInventorySha256, afterInventorySha256, routeIdSha256,
    deploymentIdSha256, predecessorAuthority, promotionRecoveryReceiptSha256,
    operationReceiptAuthorities, checks,
  );
  dependencies.writeOutput(`${JSON.stringify(provisional)}\n`);
  return ((outcome === "closed"
      || outcome === "opened"
      || outcome === "closed_reconciled_after_lost_ack"
      || outcome === "opened_reconciled_after_lost_ack")
      && checks.terminalEvidenceExact
      && checks.finalReceiptEvidenceExact)
    ? 0
    : 1;
}

export const protectedProductionRouteMutationInternals = {
  parseArgs,
  policyExact,
  parseInventory,
  parseCloseAcknowledgement,
  parseOpenAcknowledgement,
  inventoryTransitionExact,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedProductionRouteMutation();
}
