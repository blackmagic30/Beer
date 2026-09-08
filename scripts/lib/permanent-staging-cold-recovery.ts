import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { runRailwayMutationBoundaryCheck } from
  "../check-railway-mutation-boundary.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./trusted-filesystem.js";
import {
  parseRailwayMultiRegionReplicaTopology,
  type RailwayRegionReplicaCount,
} from "./railway-multi-region-replica-topology.js";

export const COLD_RECOVERY_POLICY_PATH =
  "ops/railway/permanent-staging-cold-recovery-policy.json" as const;
export const COLD_RECOVERY_POLICY_SHA256 =
  "02fa6bf7154341a1fbb09ed68169585fe8ce9432e826108f993e6992d9d8e413" as const;
export const COLD_RECOVERY_BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json" as const;
export const COLD_RECOVERY_BOUNDARY_POLICY_SHA256 =
  "a61ccb5493bbb15e37c8b158f441219b4540937d9dd0ab46ddc0a0cf0be84079" as const;
export const COLD_RECOVERY_CLI_SHA256 =
  "27133cfc20bffc43b2f32c1638fa3c50eefc2f9d2d80301a93de34632ccb7a43" as const;

export const COLD_RECOVERY_LOCK = Object.freeze({
  repository: "blackmagic30/Beer",
  projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  environmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  forbiddenProductionEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
  serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  serviceInstanceId: "5a2f3970-2850-44e0-9b6c-f5c7627dde13",
  deploymentId: "c71fdb35-2be0-4031-b952-85595dfb2913",
  snapshotId: "f1061f4f-e1dd-49f3-b91a-60efbc3d6841",
  sourceSha: "12c0d24f6619a0286e16b8daf56fc27aaa1e3aba",
  domainId: "afbb2417-c6df-48e3-9987-271b10ab2962",
  domain: "beer-staging.up.railway.app",
  targetPort: 8_080,
  region: "asia-southeast1-eqsg3a",
  configuredRegionBefore: "europe-west4-drams3a",
  quiesceRegions: Object.freeze([
    "europe-west4-drams3a",
    "asia-southeast1-eqsg3a",
  ] as const),
} as const);

export const COLD_RECOVERY_SCOPE_QUERY =
  `query PintPathPermanentStagingColdRecoveryScope { projectToken { projectId environmentId } }`;
export const COLD_RECOVERY_STATE_QUERY =
  `query PintPathPermanentStagingColdRecoveryState(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
  $deploymentId: String!
) {
  environment(id:$environmentId,projectId:$projectId) {
    id
    config(decryptVariables:false)
    variables(first:100) {
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
    source { repo image }
    latestDeployment { id status deploymentStopped snapshotId }
    activeDeployments { id status deploymentStopped }
    domains {
      serviceDomains { id domain targetPort }
      customDomains { id domain targetPort }
    }
  }
  deployment(id:$deploymentId) {
    id
    projectId
    environmentId
    serviceId
    snapshotId
    meta
  }
}`;
export const COLD_RECOVERY_PREPARE_MUTATION =
  `mutation PintPathPermanentStagingColdPrepare(
  $projectId: String!
  $serviceId: String!
  $environmentId: String!
  $variables: EnvironmentVariables!
  $skipDeploys: Boolean
) {
  variableCollectionUpsert(input:{projectId:$projectId,serviceId:$serviceId,environmentId:$environmentId,variables:$variables,skipDeploys:$skipDeploys})
}`;

const GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const MAX_PROVIDER_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VARIABLE_PATTERN = /^[A-Z][A-Z0-9_]{0,255}$/;
const TARGET_VARIABLES = Object.freeze([
  "PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED",
  "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
] as const);
const REQUIRED_REFERENCES = Object.freeze({
  DATABASE_URL: Object.freeze([
    "c454955f-263b-4599-aee0-dc447a4d3d15.PINTPATH_RUNTIME_DATABASE_URL",
  ]),
  REDIS_URL: Object.freeze([
    "d6351cec-fe04-4a6f-8e05-1cc164ea1e73.REDIS_URL",
  ]),
} as const);
const REQUIRED_UNREFERENCED = Object.freeze([
  "ALCOHOL_GAMIFICATION_ENABLED",
  "CONSUMER_PAID_ENROLLMENT_ENABLED",
  "GOOGLE_MAPS_API_KEY",
  "GOOGLE_MAPS_MAP_ID",
  "GOOGLE_PLACES_API_KEY",
  "OPENAI_API_KEY",
  "PINT_POINTS_REWARDS_ENABLED",
  "PUBLIC_BASE_URL",
  "REPORT_DELIVERY_SCHEDULE_ENABLED",
  "SUPABASE_ANON_KEY",
  "SUPABASE_RESULTS_TABLE",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
] as const);
const FORBIDDEN_VARIABLES = Object.freeze([
  "OFFSITE_BACKUP_BUCKET",
  "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
  "OFFSITE_BACKUP_SUPABASE_URL",
] as const);
const SUPABASE_REPLACEMENT_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-variable-mutation/v4" as const;
const SUPABASE_REPLACEMENT_TERMINAL_SCHEMA =
  "pintpath-permanent-staging-variable-mutation-terminal/v4" as const;
export const COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION =
  "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN" as const;
const EXTERNAL_MUTATION_FREEZE_ENFORCEMENT =
  "OPERATIONAL_NOT_PROVIDER_VERIFIED" as const;

export interface ColdRecoveryVariableRow {
  readonly id: string;
  readonly name: string;
  readonly environmentId: string;
  readonly serviceId: string | null;
  readonly isSealed: boolean;
  readonly references: readonly string[];
}

export interface ColdRecoveryState {
  readonly environmentId: string;
  readonly serviceInstanceId: string;
  readonly serviceId: string;
  readonly numReplicas: null | 0;
  readonly configuredReplicas: 0 | 1;
  readonly configuredRegions: readonly RailwayRegionReplicaCount[];
  readonly deploymentRegions: readonly RailwayRegionReplicaCount[];
  readonly source: { readonly repo: null; readonly image: null };
  readonly latestDeployment: {
    readonly id: string;
    readonly status: "FAILED";
    readonly deploymentStopped: true;
    readonly snapshotId: string;
  };
  readonly activeDeployments: readonly [];
  readonly domains: readonly [{
    readonly kind: "service";
    readonly id: string;
    readonly domain: string;
    readonly targetPort: 8_080;
  }];
  readonly deployment: {
    readonly id: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly snapshotId: string;
    readonly commitHash: string;
    readonly imageDigest: null;
    readonly patchId: null;
  };
  readonly rows: readonly ColdRecoveryVariableRow[];
}

export interface BoundaryEvidence {
  readonly passed: boolean;
  readonly receiptSha256: string | null;
}

export interface ColdReconcileReviewedAuthority {
  readonly sha256: string;
  readonly priorQuiesceRunId: string;
  readonly prepareRunId: string;
}

export interface ColdPrepareReconcileReviewedAuthority {
  readonly sha256: string;
  readonly priorPrepareRunId: string;
  readonly replacementRunId: string;
}

export const COLD_QUIESCE_SUCCESSOR_BINDING = Object.freeze({
  authorityOperation: "cold-recovery-successor-quiesce",
  bridgeOperation: "cold-quiesce-successor-bridge",
  bridgeSchema:
    "pintpath-permanent-staging-cold-quiesce-successor-bridge/v3",
  legacyCandidateSha: "838e8c877dcafc0a822a12e5a26afa81c26924a3",
  legacyReviewedHeadSha: "cc2c5311d47f3e895173cb11ef094ef856e0cf07",
  legacyTreeSha: "9da75485e85addfec7096b1c04c52f6780d17b64",
  legacyPullRequestNumber: 90,
  legacyMergedAt: "2026-09-07T18:18:58Z",
  legacyPrepareRunId: "34152745186",
  legacyQuiesceRunId: "34153306935",
  legacyReadOnlyReconcileRunId: "34154020478",
  legacyQuiesceRunCompletedAt: "2026-09-07T18:57:20.000Z",
  intermediateCandidateSha: "919cbbc9ed4a5bb1d99bc2624f5b534e31ddb604",
  intermediateReviewedHeadSha:
    "a8448524162c36da3d220c4b8aa21dd42cb11535",
  intermediateTreeSha: "06257eba9476e393fe54b70395af8641f8b6d59a",
  intermediatePullRequestNumber: 91,
  intermediateMergedAt: "2026-09-08T02:22:51Z",
  intermediateAmbiguousPrepareRunId: "34180322982",
  intermediateFailedReadOnlyPrepareReconcileRunId: "34181145015",
  priorArtifactId: "10040956324",
  priorArtifactName:
    "pintpath-permanent-staging-cold-quiesce-1161e7ecd421556b104bcae059e8764ebf4a545e",
  priorArtifactDigest:
    "sha256:3db418b86eea098ff4cf8c3a5198ac445d5a51c2f0ac7481dce288027c70166e",
  priorReceiptSha256:
    "e7b02c804d93b3d053551cf3373892768a71361bc59acdbf8a403efa0b4361cf",
  priorIntentSha256:
    "661406730dcac531cb7fc1c8af2916731b68a88f3e0a55e1f71b67c6eaa0b57c",
  priorBridgeSha256:
    "72c773b44f376b8368495f8461be4789a6de86c9e05fc18de6c14733ddfc2c03",
  priorPrerequisitesSha256:
    "ba52630022c2c80f5d294716bc9dfffa5b8ae1dd7b6c6dcbe621f81191a83ffb",
  priorReviewedAuthoritySha256:
    "973faf61ab61cec680ad064a88624c887b516a125b21f6792090b21d5a33fb46",
  priorCandidateSha: "1161e7ecd421556b104bcae059e8764ebf4a545e",
  priorReviewedHeadSha: "23f6b96154de7a0eb5a0cc90136d3796a1301668",
  priorTreeSha: "8a58c3eb755a68a2c456a5abff34fa7c01a9af3e",
  priorPullRequestNumber: 93,
  priorMergedAt: "2026-09-08T04:04:40Z",
  priorPrepareRunId: "34186355641",
  priorQuiesceRunId: "34186930666",
  legacyArtifactId: "10030213299",
  legacyArtifactName:
    "pintpath-permanent-staging-cold-quiesce-838e8c877dcafc0a822a12e5a26afa81c26924a3",
  legacyArtifactDigest:
    "sha256:3f830a7376e604a46e0d8cfe3521fc8eb4e1db444ab73bec4063c22442c42fbe",
  legacyReceiptSha256:
    "e9fa51ae3a56f405ba091417299cf6b4c3d0ad19d9ed8ff8601a7f51a450e0fd",
  legacyIntentSha256:
    "7f37309fd87088b2333067387ba234622e4f24f8a9bcf2029ccb698b6ca12421",
  legacyPrerequisitesSha256:
    "b17e6b115d6331ba63b7abdd8a130d39ae2008f652480bbc167de4e9bb84b8bb",
  legacyReviewedAuthoritySha256:
    "f45df8c1260857eddbe1e326064ba822169d800392c4bf8fc95f6591df5c0d41",
  priorCliStderrSha256:
    "5df1ca8f5b08f53475635a850aaab5837e482d4096e9f6b319c4f962f4400930",
  commandProducerGitBlobSha: "e88780b8f83f87ee63f764ec5db7608d529e175f",
  commandProducerSha256:
    "a7571fc741d3c422f3a7e33b626187ae3c794475adc8c4b2b5998d0405928860",
  railwayCliTagCommitSha: "5a8c5065b5cb929d7a1cadf7e168c2eed9453999",
  railwayCliMainGitBlobSha: "e4516626d224e239ef3d74f9f85e33ea84b50d47",
  railwayCliMainSha256:
    "09f30a5fa1ee19df3a352796ab9bf6a4ca599145bc08972717c3c4fb8147754d",
  railwayCliScaleGitBlobSha: "8d5530d85f2d5ce8771610417eb47787752b633c",
  railwayCliScaleSha256:
    "f015a7aa1cd9a90d75d6f9bd4903faed28569b942b61dfc5fe7e2638360b86f9",
  railwayCliRegionsGitBlobSha: "2e21e12e3ce0fd1a71de4d33fa1f41952aa2e980",
  railwayCliRegionsSha256:
    "6ed16ce3b48bc0f3e730efa569fd755061c9258e486cf4fd9e3626179b26dac7",
  railwayCliClientGitBlobSha: "bf93e00a5efb4a70c19c7ae74275e76c488d7199",
  railwayCliClientSha256:
    "e3d9dcef12dc5c6108ecbfc6f11df6d7cdf803861f142aaceeadcd15f00ba5da",
  railwayCliErrorsGitBlobSha: "8ab2def1ffcfb082a811d0f7e23a4cb3a8414bed",
  railwayCliErrorsSha256:
    "bc6ae769ac8816ea3aeaea8db83bd6f1dab30020a1cfb371a7416af54a5ed0b6",
  railwayCliEnvironmentPatchCommitGitBlobSha:
    "9c0883295e9f663e958f20a6bc3dbdce49c79ea8",
  railwayCliEnvironmentPatchCommitSha256:
    "67a2b6e11d70170b1f797701ee47bc5a1678e55dd96e8927518296ee683d03a6",
  providerHistoryQuerySha256:
    "23a8f9c875d032a629ec8c3d41a0312fed7d63372377147b0b708618d5ab0791",
  providerPatchesQuerySha256:
    "d6defa675b61ad4447c28b52044a5d86dffaf5a1f8d405241b6e29cb4683098e",
  providerPatchQuerySha256:
    "f13292b4399ee428e665b3ef58188e55f3a293c98f6732019cf1b01a76ca86d7",
  priorCompletedAt: "2026-09-08T04:32:27.000Z",
  deadline: "2026-09-08T18:57:20.000Z",
  maximumBridgeAgeMs: 60 * 1_000,
  maximumClockSkewMs: 5 * 1_000,
} as const);

export interface ColdQuiesceSuccessorBinding {
  readonly bridgeSha256: string;
  readonly reviewedAuthoritySha256: string;
  readonly currentRunId: string;
  readonly currentPrepareRunId: string;
  readonly priorCandidateSha: string;
  readonly priorQuiesceRunId: string;
  readonly priorArtifactId: string;
  readonly priorArtifactDigest: string;
  readonly legacyCandidateSha: string;
  readonly legacyQuiesceRunId: string;
  readonly legacyArtifactId: string;
  readonly legacyArtifactDigest: string;
  readonly providerNoWriteProofSha256: string;
  readonly liveStateSha256: string;
  readonly verifiedAt: string;
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalIsoTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function sourceFileAnchorExact(
  value: unknown,
  expectedPath: string,
  expectedGitBlobSha: string,
  expectedSha256: string,
): boolean {
  return exactKeys(value, ["path", "gitBlobSha", "sha256"]) &&
    value.path === expectedPath && value.gitBlobSha === expectedGitBlobSha &&
    value.sha256 === expectedSha256;
}

function providerPageChainExact(
  value: unknown,
  expectedCount: number,
): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return false;
  let priorCursor: string | null = null;
  let count = 0;
  const cursors = new Set<string>();
  for (const [index, page] of value.entries()) {
    if (!exactKeys(page, [
      "requestAfter", "count", "endCursor", "hasNextPage",
    ]) || page.requestAfter !== priorCursor ||
      !Number.isSafeInteger(page.count) || Number(page.count) < 1 ||
      Number(page.count) > 100 || typeof page.endCursor !== "string" ||
      page.endCursor.length < 1 || page.endCursor.length > 1024 ||
      /[\r\n\0]/.test(page.endCursor) || cursors.has(page.endCursor) ||
      page.hasNextPage !== (index < value.length - 1) ||
      (page.hasNextPage && page.count !== 100)) return false;
    count += Number(page.count);
    priorCursor = page.endCursor;
    cursors.add(page.endCursor);
  }
  return count === expectedCount;
}

export function parseColdQuiesceSuccessorBinding(
  bridgeSource: string,
  reviewedAuthoritySource: string,
  candidateSha: string,
  currentRunId: string,
  currentPrepareRunId: string,
  nowMs: number,
  enforceCurrentDeadline = true,
): ColdQuiesceSuccessorBinding | null {
  try {
    const bridge = JSON.parse(bridgeSource) as unknown;
    const authority = JSON.parse(reviewedAuthoritySource) as unknown;
    const expected = COLD_QUIESCE_SUCCESSOR_BINDING;
    if (!record(bridge) || canonical(bridge) !== bridgeSource ||
      !record(authority) || `${JSON.stringify(authority)}\n` !== reviewedAuthoritySource ||
      !canonicalIsoTimestamp(bridge.verifiedAt) || !Number.isFinite(nowMs)) {
      return null;
    }
    const verifiedAtMs = Date.parse(String(bridge.verifiedAt));
    const deadlineMs = Date.parse(expected.deadline);
    if (verifiedAtMs < Date.parse(expected.priorCompletedAt) ||
      verifiedAtMs >= deadlineMs || (enforceCurrentDeadline && (
        nowMs >= deadlineMs || verifiedAtMs > nowMs + expected.maximumClockSkewMs ||
        nowMs - verifiedAtMs > expected.maximumBridgeAgeMs
      ))) return null;

    const intermediate = record(bridge.intermediateCandidate)
      ? bridge.intermediateCandidate
      : null;
    const legacy = record(bridge.legacyCandidate)
      ? bridge.legacyCandidate
      : null;
    const legacyArtifact = record(bridge.legacyArtifact)
      ? bridge.legacyArtifact
      : null;
    const priorArtifact = record(bridge.priorArtifact) ? bridge.priorArtifact : null;
    const prepare = record(bridge.currentPrepare) ? bridge.currentPrepare : null;
    const cliFailure = record(bridge.priorCliFailure) ? bridge.priorCliFailure : null;
    const proof = record(bridge.providerNoWriteProof)
      ? bridge.providerNoWriteProof
      : null;
    const history = proof && record(proof.history) ? proof.history : null;
    const patches = proof && record(proof.patches) ? proof.patches : null;
    const proofChecks = proof && record(proof.checks) ? proof.checks : null;
    const mutationExclusivity = record(bridge.mutationExclusivity)
      ? bridge.mutationExclusivity
      : null;
    const liveTopology = record(bridge.liveTopology) ? bridge.liveTopology : null;
    const sourceProof = record(bridge.sourceProof) ? bridge.sourceProof : null;
    const commandProducer = sourceProof && record(sourceProof.commandProducer)
      ? sourceProof.commandProducer
      : null;
    const railwayCli = sourceProof && record(sourceProof.railwayCli)
      ? sourceProof.railwayCli
      : null;
    const checks = record(bridge.checks) ? bridge.checks : null;
    const expectedRegions = [{
      region: COLD_RECOVERY_LOCK.configuredRegionBefore,
      numReplicas: 1,
    }];
    const expectedDeploymentRegions = [{
      region: COLD_RECOVERY_LOCK.region,
      numReplicas: 1,
    }];
    const shaExact = (value: unknown) =>
      typeof value === "string" && SHA256_PATTERN.test(value);

    if (
      bridge.schemaVersion !== expected.bridgeSchema ||
      bridge.operation !== expected.bridgeOperation ||
      bridge.candidateSha !== candidateSha || bridge.currentRunId !== currentRunId ||
      bridge.currentPrepareRunId !== currentPrepareRunId ||
      !SHA_PATTERN.test(candidateSha) || !/^[1-9][0-9]{0,19}$/.test(currentRunId) ||
      !/^[1-9][0-9]{0,19}$/.test(currentPrepareRunId) ||
      currentRunId === currentPrepareRunId ||
      bridge.sourceSha !== COLD_RECOVERY_LOCK.sourceSha ||
      bridge.priorCandidateSha !== expected.priorCandidateSha ||
      bridge.priorQuiesceRunId !== expected.priorQuiesceRunId ||
      bridge.priorAmbiguousColdQuiesceRunCompletedAt !== expected.priorCompletedAt ||
      bridge.coldQuiesceSuccessorGraceHours !== 24 ||
      bridge.coldQuiesceSuccessorDeadline !== expected.deadline ||
      bridge.coldQuiesceSuccessorWithinGraceExact !== true ||
      !exactKeys(intermediate, [
        "candidateSha", "reviewedHeadSha", "treeSha", "pullRequestNumber",
        "mergedAt", "ambiguousPrepareRunId",
        "failedReadOnlyPrepareReconcileRunId",
      ]) || intermediate.candidateSha !== expected.intermediateCandidateSha ||
      intermediate.reviewedHeadSha !== expected.intermediateReviewedHeadSha ||
      intermediate.treeSha !== expected.intermediateTreeSha ||
      intermediate.pullRequestNumber !== expected.intermediatePullRequestNumber ||
      intermediate.mergedAt !== expected.intermediateMergedAt ||
      intermediate.ambiguousPrepareRunId !== expected.intermediateAmbiguousPrepareRunId ||
      intermediate.failedReadOnlyPrepareReconcileRunId !==
        expected.intermediateFailedReadOnlyPrepareReconcileRunId ||
      !exactKeys(legacy, [
        "candidateSha", "reviewedHeadSha", "treeSha", "pullRequestNumber",
        "mergedAt", "prepareRunId", "quiesceRunId", "quiesceRunCompletedAt",
        "failedReadOnlyReconcileRunId",
      ]) || legacy.candidateSha !== expected.legacyCandidateSha ||
      legacy.reviewedHeadSha !== expected.legacyReviewedHeadSha ||
      legacy.treeSha !== expected.legacyTreeSha ||
      legacy.pullRequestNumber !== expected.legacyPullRequestNumber ||
      legacy.mergedAt !== expected.legacyMergedAt ||
      legacy.prepareRunId !== expected.legacyPrepareRunId ||
      legacy.quiesceRunId !== expected.legacyQuiesceRunId ||
      legacy.quiesceRunCompletedAt !== expected.legacyQuiesceRunCompletedAt ||
      legacy.failedReadOnlyReconcileRunId !==
        expected.legacyReadOnlyReconcileRunId ||
      !exactKeys(legacyArtifact, [
        "id", "name", "digest", "receiptSha256", "intentSha256",
        "prerequisitesSha256", "priorReviewedAuthoritySha256",
      ]) || legacyArtifact.id !== expected.legacyArtifactId ||
      legacyArtifact.name !== expected.legacyArtifactName ||
      legacyArtifact.digest !== expected.legacyArtifactDigest ||
      legacyArtifact.receiptSha256 !== expected.legacyReceiptSha256 ||
      legacyArtifact.intentSha256 !== expected.legacyIntentSha256 ||
      legacyArtifact.prerequisitesSha256 !== expected.legacyPrerequisitesSha256 ||
      legacyArtifact.priorReviewedAuthoritySha256 !==
        expected.legacyReviewedAuthoritySha256 ||
      !exactKeys(priorArtifact, [
        "id", "name", "digest", "receiptSha256", "intentSha256",
        "successorBridgeSha256", "prerequisitesSha256",
        "reviewedAuthoritySha256",
      ]) || priorArtifact.id !== expected.priorArtifactId ||
      priorArtifact.name !== expected.priorArtifactName ||
      priorArtifact.digest !== expected.priorArtifactDigest ||
      priorArtifact.receiptSha256 !== expected.priorReceiptSha256 ||
      priorArtifact.intentSha256 !== expected.priorIntentSha256 ||
      priorArtifact.successorBridgeSha256 !== expected.priorBridgeSha256 ||
      priorArtifact.prerequisitesSha256 !==
        expected.priorPrerequisitesSha256 ||
      priorArtifact.reviewedAuthoritySha256 !==
        expected.priorReviewedAuthoritySha256 ||
      !exactKeys(prepare, [
        "runId", "terminalSha256", "replacementRunId", "startedAt", "completedAt",
      ]) || prepare.runId !== currentPrepareRunId || !shaExact(prepare.terminalSha256) ||
      prepare.replacementRunId !== authority.selectedReplacementRunId ||
      !canonicalIsoTimestamp(prepare.startedAt) ||
      !canonicalIsoTimestamp(prepare.completedAt) ||
      Date.parse(String(prepare.startedAt)) >= Date.parse(String(prepare.completedAt)) ||
      !exactKeys(cliFailure, [
        "cliVersion", "cliSha256", "cliExitCode", "timedOut", "stdoutSha256",
        "stderrSha256", "normalizedErrorSha256", "clapParseFailure",
        "renderedErrorKind", "graphqlAuthorizationDenied", "deniedResolver",
        "resolverUnknown", "environmentPatchCommitReached",
      ]) || cliFailure.cliVersion !== "5.32.0" ||
      cliFailure.cliSha256 !== COLD_RECOVERY_CLI_SHA256 || cliFailure.cliExitCode !== 1 ||
      cliFailure.timedOut !== false || cliFailure.stdoutSha256 !== sha256("") ||
      cliFailure.stderrSha256 !== expected.priorCliStderrSha256 ||
      cliFailure.normalizedErrorSha256 !== expected.priorCliStderrSha256 ||
      cliFailure.clapParseFailure !== false ||
      cliFailure.renderedErrorKind !== "UnauthorizedToken" ||
      cliFailure.graphqlAuthorizationDenied !== true ||
      cliFailure.deniedResolver !== null || cliFailure.resolverUnknown !== true ||
      cliFailure.environmentPatchCommitReached !== null ||
      bridge.providerWriteCommitted !== false ||
      !exactKeys(mutationExclusivity, [
        "externalMutationFreezeAttestation", "enforcement",
        "concurrencyGroup", "cancelInProgress", "bridgeTokenCustody",
        "mutationTokenPresent",
      ]) || mutationExclusivity.externalMutationFreezeAttestation !==
        COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION ||
      mutationExclusivity.enforcement !==
        EXTERNAL_MUTATION_FREEZE_ENFORCEMENT ||
      mutationExclusivity.concurrencyGroup !==
        "pintpath-permanent-staging-key-rollout" ||
      mutationExclusivity.cancelInProgress !== false ||
      mutationExclusivity.bridgeTokenCustody !== "METADATA_ONLY" ||
      mutationExclusivity.mutationTokenPresent !== false
    ) return null;

    if (
      !exactKeys(proof, [
        "schemaVersion", "observedAt", "environmentId", "serviceId",
        "querySha256", "history", "patches", "incidentWindows",
        "liveStateSha256", "checks", "secretMaterialIncluded",
        "secretDerivedCommitmentsIncluded",
      ]) || proof.schemaVersion !==
        "pintpath-permanent-staging-cold-provider-no-write-proof/v1" ||
      proof.observedAt !== bridge.verifiedAt ||
      proof.environmentId !== COLD_RECOVERY_LOCK.environmentId ||
      proof.serviceId !== COLD_RECOVERY_LOCK.serviceId ||
      !exactKeys(proof.querySha256, ["history", "patches", "patch"]) ||
      proof.querySha256.history !== expected.providerHistoryQuerySha256 ||
      proof.querySha256.patches !== expected.providerPatchesQuerySha256 ||
      proof.querySha256.patch !== expected.providerPatchQuerySha256 ||
      !exactKeys(history, [
        "pages", "count", "rowsSha256", "prefixCount", "prefixRowsSha256",
        "suffixEventIds",
      ]) || history.count !== 8 || history.prefixCount !== 6 ||
      !providerPageChainExact(history.pages, 8) || !shaExact(history.rowsSha256) ||
      history.prefixRowsSha256 !==
        "f1270eaf4378364f1d91624515f7a0b370f9274254535619704a56d948bf609f" ||
      !Array.isArray(history.suffixEventIds) || history.suffixEventIds.length !== 2 ||
      history.suffixEventIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id)) ||
      !exactKeys(patches, [
        "pages", "count", "rowsSha256", "prefixCount", "prefixRowsSha256",
        "suffixPatchIds", "crossFetchProjectionSha256",
      ]) || patches.count !== 124 || patches.prefixCount !== 122 ||
      !providerPageChainExact(patches.pages, 124) || !shaExact(patches.rowsSha256) ||
      patches.prefixRowsSha256 !==
        "a560f185f77fb091da39314eb1f7f9f5ab3a4d2f6593752339649751f6c133db" ||
      !Array.isArray(patches.suffixPatchIds) || patches.suffixPatchIds.length !== 2 ||
      patches.suffixPatchIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id)) ||
      !shaExact(patches.crossFetchProjectionSha256) ||
      canonical(proof.incidentWindows) !== canonical([
        {
          startedAt: "2026-09-07T18:51:21.000Z",
          completedAt: "2026-09-07T18:57:20.000Z",
        },
        {
          startedAt: "2026-09-08T04:30:38.868Z",
          completedAt: "2026-09-08T04:32:22.210Z",
        },
      ]) || !shaExact(proof.liveStateSha256) ||
      !exactKeys(proofChecks, [
        "paginationCompleteExact", "chronologicalOrderExact",
        "historicalPrefixesExact", "historicalScalePositiveControlExact",
        "legacyUnauthorizedRunNoWriteExact",
        "priorUnauthorizedRunNoWriteExact", "authorizedSuffixExact",
        "targetDeployAbsentFromSuffixExact", "crossFetchedPatchesExact",
        "ledgerRecheckExact", "liveTopologyContinuityExact",
      ]) || Object.values(proofChecks).some((value) => value !== true) ||
      proof.secretMaterialIncluded !== false ||
      proof.secretDerivedCommitmentsIncluded !== false
    ) return null;

    if (
      !exactKeys(sourceProof, ["commandProducer", "railwayCli"]) ||
      !exactKeys(commandProducer, [
        "repository", "candidateSha", "path", "gitBlobSha", "sha256",
      ]) || commandProducer.repository !== COLD_RECOVERY_LOCK.repository ||
      commandProducer.candidateSha !== expected.priorCandidateSha ||
      commandProducer.path !== "scripts/lib/permanent-staging-cold-recovery.ts" ||
      commandProducer.gitBlobSha !== expected.commandProducerGitBlobSha ||
      commandProducer.sha256 !== expected.commandProducerSha256 ||
      !exactKeys(railwayCli, [
        "repository", "version", "tag", "tagCommitSha", "main", "scale",
        "regions", "client", "errors", "environmentPatchCommit",
      ]) || railwayCli.repository !== "railwayapp/cli" ||
      railwayCli.version !== "5.32.0" || railwayCli.tag !== "v5.32.0" ||
      railwayCli.tagCommitSha !== expected.railwayCliTagCommitSha ||
      !sourceFileAnchorExact(railwayCli.main, "src/main.rs",
        expected.railwayCliMainGitBlobSha, expected.railwayCliMainSha256) ||
      !sourceFileAnchorExact(railwayCli.scale, "src/commands/scale.rs",
        expected.railwayCliScaleGitBlobSha, expected.railwayCliScaleSha256) ||
      !sourceFileAnchorExact(railwayCli.regions, "src/controllers/regions.rs",
        expected.railwayCliRegionsGitBlobSha, expected.railwayCliRegionsSha256) ||
      !sourceFileAnchorExact(railwayCli.client, "src/client.rs",
        expected.railwayCliClientGitBlobSha, expected.railwayCliClientSha256) ||
      !sourceFileAnchorExact(railwayCli.errors, "src/errors.rs",
        expected.railwayCliErrorsGitBlobSha, expected.railwayCliErrorsSha256) ||
      !sourceFileAnchorExact(
        railwayCli.environmentPatchCommit,
        "src/gql/mutations/strings/EnvironmentPatchCommit.graphql",
        expected.railwayCliEnvironmentPatchCommitGitBlobSha,
        expected.railwayCliEnvironmentPatchCommitSha256,
      ) || !exactKeys(liveTopology, [
        "configuredReplicas", "configuredRegions", "legacyAggregateReplicas",
        "deploymentManifestRegions", "liveStateSha256",
      ]) || liveTopology.configuredReplicas !== 1 ||
      canonical(liveTopology.configuredRegions) !== canonical(expectedRegions) ||
      liveTopology.legacyAggregateReplicas !== null ||
      canonical(liveTopology.deploymentManifestRegions) !==
        canonical(expectedDeploymentRegions) ||
      liveTopology.liveStateSha256 !== proof.liveStateSha256 ||
      !exactKeys(checks, [
        "reviewedSuccessorAuthorityExact", "directSuccessorLineageExact",
        "legacyToIntermediateLineageExact", "intermediateToPriorLineageExact",
        "completeFourCandidateLineageExact", "legacyColdHistoryExact",
        "intermediateColdHistoryExact", "priorColdHistoryExact",
        "legacyArtifactMetadataExact", "legacyArtifactContentsExact",
        "priorArtifactMetadataExact", "priorArtifactContentsExact",
        "currentPrepareTerminalExact",
        "sourceAnchorsExact", "priorCliGraphqlAuthorizationFailureExact",
        "providerHistoryCompleteExact", "providerNoWriteExact",
        "externalMutationFreezeAttested", "serializedMutationConcurrencyExact",
        "metadataOnlyTokenCustodyExact",
        "readOnlyTokenScopeExact", "configuredLiveTopologyExact",
        "deploymentManifestIdentityExact", "noProviderMutationPerformed",
      ]) || Object.values(checks).some((value) => value !== true) ||
      bridge.reviewedAuthoritySha256 !== sha256(reviewedAuthoritySource) ||
      bridge.nextRequiredProof !==
        "FRESH_REVIEWED_SUCCESSOR_CONFIGURED_ONE_TO_ZERO" ||
      bridge.secretMaterialIncluded !== false ||
      bridge.secretDerivedCommitmentsIncluded !== false
    ) return null;

    if (
      authority.command !== "verify-github-reviewed-candidate-authority" ||
      authority.ok !== true || authority.schemaVersion !== 1 ||
      authority.kind !== "pintpath-github-reviewed-candidate-authority" ||
      authority.repository !== COLD_RECOVERY_LOCK.repository ||
      authority.candidateSha !== candidateSha ||
      authority.operation !== expected.authorityOperation ||
      authority.workflowPath !==
        ".github/workflows/recover-permanent-staging-cold-zero.yml" ||
      authority.workflowRunId !== currentRunId ||
      authority.workflowRunAttempt !== 1 ||
      authority.selectedColdPrepareRunId !== currentPrepareRunId ||
      authority.selectedReplacementRunId !== prepare.replacementRunId ||
      authority.priorAmbiguousColdQuiesceCandidateSha !== expected.priorCandidateSha ||
      authority.priorAmbiguousColdQuiesceReviewedHeadSha !==
        expected.priorReviewedHeadSha ||
      authority.priorAmbiguousColdQuiesceTreeSha !== expected.priorTreeSha ||
      authority.priorAmbiguousColdQuiescePullRequestNumber !==
        expected.priorPullRequestNumber ||
      authority.priorAmbiguousColdQuiesceCandidateMergedAt !== expected.priorMergedAt ||
      authority.priorColdPrepareRunId !== expected.priorPrepareRunId ||
      authority.priorAmbiguousColdQuiesceRunId !== expected.priorQuiesceRunId ||
      Object.hasOwn(
        authority,
        "priorFailedReadOnlyColdQuiesceReconcileRunId",
      ) ||
      authority.legacyColdRecoveryCandidateSha !== expected.legacyCandidateSha ||
      authority.legacyColdRecoveryReviewedHeadSha !==
        expected.legacyReviewedHeadSha ||
      authority.legacyColdRecoveryTreeSha !== expected.legacyTreeSha ||
      authority.legacyColdRecoveryPullRequestNumber !==
        expected.legacyPullRequestNumber ||
      authority.legacyColdRecoveryCandidateMergedAt !== expected.legacyMergedAt ||
      authority.legacyColdPrepareRunId !== expected.legacyPrepareRunId ||
      authority.legacyColdQuiesceRunId !== expected.legacyQuiesceRunId ||
      authority.legacyColdQuiesceRunCompletedAt !==
        expected.legacyQuiesceRunCompletedAt ||
      authority.legacyFailedReadOnlyColdQuiesceReconcileRunId !==
        expected.legacyReadOnlyReconcileRunId ||
      authority.intermediateColdRecoveryCandidateSha !==
        expected.intermediateCandidateSha ||
      authority.intermediateColdRecoveryReviewedHeadSha !==
        expected.intermediateReviewedHeadSha ||
      authority.intermediateColdRecoveryTreeSha !== expected.intermediateTreeSha ||
      authority.intermediateColdRecoveryPullRequestNumber !==
        expected.intermediatePullRequestNumber ||
      authority.intermediateColdRecoveryCandidateMergedAt !==
        expected.intermediateMergedAt ||
      authority.intermediateAmbiguousColdPrepareRunId !==
        expected.intermediateAmbiguousPrepareRunId ||
      authority.intermediateFailedReadOnlyColdPrepareReconcileRunId !==
        expected.intermediateFailedReadOnlyPrepareReconcileRunId ||
      authority.priorAmbiguousColdQuiesceArtifactId !==
        expected.priorArtifactId ||
      authority.priorAmbiguousColdQuiesceArtifactName !==
        expected.priorArtifactName ||
      authority.priorAmbiguousColdQuiesceArtifactDigest !==
        expected.priorArtifactDigest ||
      authority.legacyAmbiguousColdQuiesceArtifactId !== expected.legacyArtifactId ||
      authority.legacyAmbiguousColdQuiesceArtifactName !== expected.legacyArtifactName ||
      authority.legacyAmbiguousColdQuiesceArtifactDigest !==
        expected.legacyArtifactDigest ||
      authority.coldQuiesceSuccessorDeadline !== expected.deadline ||
      authority.coldQuiesceSuccessorWithinGraceExact !== true ||
      authority.coldQuiesceSuccessorDirectParentExact !== true ||
      authority.coldQuiesceSuccessorLegacyToIntermediateParentExact !== true ||
      authority.coldQuiesceSuccessorIntermediateToPriorParentExact !== true ||
      authority.coldQuiesceSuccessorCompleteFourCandidateLineageExact !== true ||
      authority.coldQuiesceSuccessorLegacyHistoryExact !== true ||
      authority.coldQuiesceSuccessorIntermediateHistoryExact !== true ||
      authority.coldQuiesceSuccessorPriorHistoryExact !== true ||
      authority.coldQuiesceSuccessorAllRefsHistoryExact !== true ||
      authority.coldQuiesceSuccessorCurrentPrepareExact !== true ||
      authority.coldQuiesceSuccessorLegacyArtifactMetadataExact !== true ||
      authority.coldQuiesceSuccessorPriorArtifactMetadataExact !== true ||
      authority.coldQuiesceSuccessorPriorProviderProofRequired !== true ||
      authority.coldQuiesceSuccessorBridgeRequired !== true ||
      authority.completeRetainedHistoryExact !== true ||
      authority.stagingLifecycleSealed !== false ||
      authority.reviewedAuthorityExact !== true ||
      authority.freshDispatchWriteGuardExact !== true
    ) return null;

    return Object.freeze({
      bridgeSha256: sha256(bridgeSource),
      reviewedAuthoritySha256: sha256(reviewedAuthoritySource),
      currentRunId,
      currentPrepareRunId,
      priorCandidateSha: expected.priorCandidateSha,
      priorQuiesceRunId: expected.priorQuiesceRunId,
      priorArtifactId: expected.priorArtifactId,
      priorArtifactDigest: expected.priorArtifactDigest,
      legacyCandidateSha: expected.legacyCandidateSha,
      legacyQuiesceRunId: expected.legacyQuiesceRunId,
      legacyArtifactId: expected.legacyArtifactId,
      legacyArtifactDigest: expected.legacyArtifactDigest,
      providerNoWriteProofSha256: sha256(canonical(proof)),
      liveStateSha256: String(proof.liveStateSha256),
      verifiedAt: String(bridge.verifiedAt),
    });
  } catch {
    return null;
  }
}

export function policyExact(cwd: string): boolean {
  try {
    const policy = fs.readFileSync(path.resolve(cwd, COLD_RECOVERY_POLICY_PATH));
    const boundary = fs.readFileSync(
      path.resolve(cwd, COLD_RECOVERY_BOUNDARY_POLICY_PATH),
    );
    if (
      policy.byteLength > MAX_EVIDENCE_BYTES ||
      sha256(policy) !== COLD_RECOVERY_POLICY_SHA256 ||
      sha256(boundary) !== COLD_RECOVERY_BOUNDARY_POLICY_SHA256
    ) return false;
    const value = JSON.parse(policy.toString("utf8")) as unknown;
    return record(value) &&
      value.schemaVersion === "pintpath-permanent-staging-cold-recovery-policy/v4" &&
      value.policyId === "pintpath-permanent-staging-one-time-cold-recovery" &&
      value.activationState === "GITHUB_ENVIRONMENT_PROTECTED" &&
      value.repository === COLD_RECOVERY_LOCK.repository &&
      record(value.target) &&
      value.target.projectId === COLD_RECOVERY_LOCK.projectId &&
      value.target.environmentId === COLD_RECOVERY_LOCK.environmentId &&
      value.target.forbiddenProductionEnvironmentId ===
        COLD_RECOVERY_LOCK.forbiddenProductionEnvironmentId &&
      value.target.serviceId === COLD_RECOVERY_LOCK.serviceId &&
      value.target.serviceInstanceId === COLD_RECOVERY_LOCK.serviceInstanceId &&
      value.target.configuredRegionBefore ===
        COLD_RECOVERY_LOCK.configuredRegionBefore &&
      canonical(value.target.quiesceRegions) ===
        canonical(COLD_RECOVERY_LOCK.quiesceRegions) &&
      record(value.deadState) &&
      value.deadState.replicas === null &&
      value.deadState.configuredReplicas === 1 &&
      canonical(value.deadState.configuredRegions) === canonical({
        [COLD_RECOVERY_LOCK.configuredRegionBefore]: 1,
      }) &&
      canonical(value.deadState.deploymentManifestRegions) === canonical({
        [COLD_RECOVERY_LOCK.region]: 1,
      }) &&
      value.deadState.latestDeploymentId === COLD_RECOVERY_LOCK.deploymentId &&
      value.deadState.snapshotId === COLD_RECOVERY_LOCK.snapshotId &&
      value.deadState.sourceSha === COLD_RECOVERY_LOCK.sourceSha &&
      record(value.requiredVariableRows) &&
      Array.isArray(value.requiredVariableRows.sealedServiceRows) &&
      canonical(value.requiredVariableRows.sealedServiceRows) ===
        canonical(["SUPABASE_SERVICE_ROLE_KEY"]) &&
      record(value.operations) && record(value.operations.prepare) &&
      record(value.operations.prepare.supabaseReplacementPrerequisite) &&
      value.operations.prepare.supabaseReplacementPrerequisite.operation ===
        "supabase-key-replacement" &&
      value.operations.prepare.supabaseReplacementPrerequisite
          .exactInputPairCanaryRequired === true &&
      record(value.operations.reconcilePrepare) &&
      value.operations.reconcilePrepare.replicasBefore === null &&
      value.operations.reconcilePrepare.replicasAfter === null &&
      value.operations.reconcilePrepare.priorAmbiguousPrepareRunRequired === true &&
      value.operations.reconcilePrepare.providerMutationAllowed === false &&
      value.operations.reconcilePrepare.variableMutationCredentialAllowed === false &&
      record(value.operations.quiesce) &&
      canonical(value.operations.quiesce.configuredReplicasBeforeAllowed) ===
        canonical([1]) &&
      value.operations.quiesce.configuredReplicasAfter === 0 &&
      canonical(value.operations.quiesce.legacyReplicasBeforeAllowed) ===
        canonical([null]) &&
      canonical(value.operations.quiesce.legacyReplicasAfterAllowed) ===
        canonical([null, 0]) &&
      canonical(value.operations.quiesce.singleEnvironmentPatchCommitRegions) ===
        canonical(COLD_RECOVERY_LOCK.quiesceRegions) &&
      value.operations.quiesce.maximumAttempts === 1 &&
      value.operations.quiesce.transport === "direct-graphql" &&
      value.operations.quiesce.operationName ===
        "PintPathEnvironmentPatchCommit" &&
      value.operations.quiesce.mutation === "environmentPatchCommit" &&
      value.operations.quiesce.zeroReplicaRegionsEncodedAsJsonNull === true &&
      value.operations.quiesce.commitMessageBindsCandidateAndRunId === true &&
      value.operations.quiesce
          .completeProviderPatchHistoryPrewriteRequired === true &&
      value.operations.quiesce.prewriteExactCommitMessageMatches === 0 &&
      value.operations.quiesce.postflightExactCommitMessageMatches === 1 &&
      value.operations.quiesce
          .matchingPatchMustBeNewestCommittedAndCrossFetched === true &&
      value.operations.quiesce.providerHistoryContinuityRequired === true &&
      value.operations.quiesce
          .finalProviderStateReadMustImmediatelyPrecedeMutation === true &&
      value.operations.quiesce.providerCasOrLockVerified === false &&
      value.operations.quiesce.externalMutationFreezeEnforcement ===
        "operational_attestation_only" &&
      value.operations.quiesce.configuredOneToZeroReceiptClaimed === true &&
      value.operations.quiesce
          .lostAcknowledgementMayReconcileOnlyFromExactConfiguredZeroPostflight === true &&
      record(value.operations.reconcileQuiesce) &&
      value.operations.reconcileQuiesce.configuredReplicasBefore === 0 &&
      value.operations.reconcileQuiesce.configuredReplicasAfter === 0 &&
      value.operations.reconcileQuiesce
          .configuredOneToZeroReceiptClaimed === false &&
      value.operations.reconcileQuiesce.priorAmbiguousQuiesceRunRequired === true &&
      value.operations.reconcileQuiesce.providerMutationAllowed === false &&
      value.operations.reconcileQuiesce.scaleCredentialAllowed === false &&
      value.operations.reconcileQuiesce.providerHistoryClaimed === false &&
      record(value.evidence) &&
      value.evidence.supabaseReplacementReceiptHashBindingRequired === true &&
      value.evidence.truthfulConfiguredReplicaTopologyBindingRequired === true &&
      value.evidence.legacyAggregateMustNotImpersonateConfiguredTopology === true &&
      value.evidence.configuredOneToZeroReceiptRequired === true &&
      value.evidence.completeProviderPatchHistoryRequiredBeforeWrite === true &&
      value.evidence.currentQuiesceProviderPatchHistoryRequired === true &&
      value.evidence.legacyAndPriorQuiesceNoWriteProofRequired === true &&
      value.evidence.providerHistoryMustUseVariableKeyOnlyProjection === true &&
      value.evidence.readOnlyRunnerLossReconciliationMustBindPriorRun === true;
  } catch {
    return false;
  }
}

async function boundedBody(response: Response): Promise<string> {
  if (response.body === null) throw new Error("provider_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_PROVIDER_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("provider_response_invalid");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

export async function railwayCall(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  if (!TOKEN_PATTERN.test(token)) throw new Error("token_invalid");
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Project-Access-Token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const source = await boundedBody(response);
  if (!response.ok) throw new Error("provider_response_invalid");
  const value = JSON.parse(source) as unknown;
  if (record(value) && Object.hasOwn(value, "errors")) {
    throw new Error("provider_response_invalid");
  }
  return value;
}

export function tokenScopeExact(value: unknown): boolean {
  return exactKeys(value, ["data"]) &&
    exactKeys(value.data, ["projectToken"]) &&
    exactKeys(value.data.projectToken, ["projectId", "environmentId"]) &&
    value.data.projectToken.projectId === COLD_RECOVERY_LOCK.projectId &&
    value.data.projectToken.environmentId === COLD_RECOVERY_LOCK.environmentId;
}

function parseVariableRow(value: unknown): ColdRecoveryVariableRow | null {
  if (
    !exactKeys(value, [
      "id",
      "name",
      "environmentId",
      "serviceId",
      "isSealed",
      "references",
    ]) ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 256 ||
    typeof value.name !== "string" ||
    !VARIABLE_PATTERN.test(value.name) ||
    value.environmentId !== COLD_RECOVERY_LOCK.environmentId ||
    !(value.serviceId === null ||
      (typeof value.serviceId === "string" && UUID_PATTERN.test(value.serviceId))) ||
    typeof value.isSealed !== "boolean" ||
    !Array.isArray(value.references) ||
    value.references.length > 100 ||
    value.references.some((item) =>
      typeof item !== "string" || item.length > 512 || /[\r\n\0]/.test(item))
  ) return null;
  return {
    id: value.id,
    name: value.name,
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    serviceId: value.serviceId as string | null,
    isSealed: value.isSealed,
    references: [...value.references].sort() as string[],
  };
}

function serviceRowExact(
  rows: readonly ColdRecoveryVariableRow[],
  name: string,
  references: readonly string[],
  expectedSealed: boolean | null = null,
): boolean {
  // Railway returns every service's variables in the environment inventory.
  // A database service legitimately owns its own DATABASE_URL row, so rows on
  // unrelated services are collateral state rather than target ambiguity. A
  // same-name shared row still shadows the application service and must fail.
  const matches = rows.filter((row) =>
    row.name === name &&
    (row.serviceId === COLD_RECOVERY_LOCK.serviceId || row.serviceId === null)
  );
  return matches.length === 1 &&
    matches[0]?.serviceId === COLD_RECOVERY_LOCK.serviceId &&
    (expectedSealed === null || matches[0]?.isSealed === expectedSealed) &&
    canonical(matches[0].references) === canonical([...references].sort());
}

export function requiredRowsExact(rows: readonly ColdRecoveryVariableRow[]): boolean {
  return Object.entries(REQUIRED_REFERENCES).every(([name, references]) =>
    serviceRowExact(rows, name, references)) &&
    REQUIRED_UNREFERENCED.every((name) => serviceRowExact(
      rows,
      name,
      [],
      name === "SUPABASE_SERVICE_ROLE_KEY" ? true : null,
    )) &&
    FORBIDDEN_VARIABLES.every((name) =>
      rows.every((row) => row.name !== name));
}

export function serviceRoleSealedExact(
  rows: readonly ColdRecoveryVariableRow[],
): boolean {
  return serviceRowExact(rows, "SUPABASE_SERVICE_ROLE_KEY", [], true);
}

export function maintenanceRowsBeforeExact(
  rows: readonly ColdRecoveryVariableRow[],
): boolean {
  return TARGET_VARIABLES.every((name) => {
    const matches = rows.filter((row) =>
      row.name === name &&
      (row.serviceId === COLD_RECOVERY_LOCK.serviceId || row.serviceId === null)
    );
    return matches.length === 0 ||
      (matches.length === 1 &&
        matches[0]?.serviceId === COLD_RECOVERY_LOCK.serviceId &&
        matches[0].references.length === 0);
  });
}

export function maintenanceRowsAfterExact(
  rows: readonly ColdRecoveryVariableRow[],
): boolean {
  return TARGET_VARIABLES.every((name) => serviceRowExact(rows, name, []));
}

export function nonMaintenanceRows(
  rows: readonly ColdRecoveryVariableRow[],
): readonly ColdRecoveryVariableRow[] {
  return rows.filter((row) =>
    row.serviceId !== COLD_RECOVERY_LOCK.serviceId ||
    !TARGET_VARIABLES.includes(nameAsTarget(row.name)));
}

function nameAsTarget(name: string): (typeof TARGET_VARIABLES)[number] {
  return name as (typeof TARGET_VARIABLES)[number];
}

export function parseColdRecoveryState(
  value: unknown,
  expectedConfiguredReplicas: 0 | 1 | "any",
): ColdRecoveryState | null {
  if (
    !exactKeys(value, ["data"]) ||
    !exactKeys(value.data, ["environment", "staged", "serviceInstance", "deployment"])
  ) return null;
  const environment = value.data.environment;
  const staged = value.data.staged;
  const instance = value.data.serviceInstance;
  const deployment = value.data.deployment;
  if (
    !exactKeys(environment, ["id", "config", "variables"]) ||
    environment.id !== COLD_RECOVERY_LOCK.environmentId ||
    !exactKeys(environment.variables, ["edges", "pageInfo"]) ||
    !Array.isArray(environment.variables.edges) ||
    environment.variables.edges.length > 100 ||
    !exactKeys(environment.variables.pageInfo, ["hasNextPage", "endCursor"]) ||
    environment.variables.pageInfo.hasNextPage !== false ||
    !exactKeys(staged, ["environmentId", "patch"]) ||
    staged.environmentId !== COLD_RECOVERY_LOCK.environmentId ||
    !record(staged.patch) ||
    Object.keys(staged.patch).length !== 0 ||
    !exactKeys(instance, [
      "id",
      "serviceId",
      "environmentId",
      "numReplicas",
      "source",
      "latestDeployment",
      "activeDeployments",
      "domains",
    ]) ||
    instance.id !== COLD_RECOVERY_LOCK.serviceInstanceId ||
    instance.serviceId !== COLD_RECOVERY_LOCK.serviceId ||
    instance.environmentId !== COLD_RECOVERY_LOCK.environmentId ||
    !(instance.numReplicas === null || instance.numReplicas === 0) ||
    !exactKeys(instance.source, ["repo", "image"]) ||
    instance.source.repo !== null ||
    instance.source.image !== null ||
    !exactKeys(instance.latestDeployment, [
      "id",
      "status",
      "deploymentStopped",
      "snapshotId",
    ]) ||
    instance.latestDeployment.id !== COLD_RECOVERY_LOCK.deploymentId ||
    instance.latestDeployment.status !== "FAILED" ||
    instance.latestDeployment.deploymentStopped !== true ||
    instance.latestDeployment.snapshotId !== COLD_RECOVERY_LOCK.snapshotId ||
    !Array.isArray(instance.activeDeployments) ||
    instance.activeDeployments.length !== 0 ||
    !exactKeys(instance.domains, ["serviceDomains", "customDomains"]) ||
    !Array.isArray(instance.domains.serviceDomains) ||
    instance.domains.serviceDomains.length !== 1 ||
    !Array.isArray(instance.domains.customDomains) ||
    instance.domains.customDomains.length !== 0 ||
    !exactKeys(instance.domains.serviceDomains[0], ["id", "domain", "targetPort"]) ||
    instance.domains.serviceDomains[0].id !== COLD_RECOVERY_LOCK.domainId ||
    instance.domains.serviceDomains[0].domain !== COLD_RECOVERY_LOCK.domain ||
    instance.domains.serviceDomains[0].targetPort !== COLD_RECOVERY_LOCK.targetPort ||
    !exactKeys(deployment, [
      "id",
      "projectId",
      "environmentId",
      "serviceId",
      "snapshotId",
      "meta",
    ]) ||
    deployment.id !== COLD_RECOVERY_LOCK.deploymentId ||
    deployment.projectId !== COLD_RECOVERY_LOCK.projectId ||
    deployment.environmentId !== COLD_RECOVERY_LOCK.environmentId ||
    deployment.serviceId !== COLD_RECOVERY_LOCK.serviceId ||
    deployment.snapshotId !== COLD_RECOVERY_LOCK.snapshotId ||
    !record(deployment.meta) ||
    deployment.meta.commitHash !== COLD_RECOVERY_LOCK.sourceSha ||
    (deployment.meta.imageDigest ?? null) !== null ||
    (deployment.meta.patchId ?? null) !== null
  ) return null;
  const configuredTopology = parseRailwayMultiRegionReplicaTopology(
    environment.config,
    COLD_RECOVERY_LOCK.serviceId,
  );
  const manifestDeploy = record(deployment.meta.serviceManifest) &&
      record(deployment.meta.serviceManifest.deploy)
    ? deployment.meta.serviceManifest.deploy
    : null;
  const deploymentTopology = parseRailwayMultiRegionReplicaTopology({
    services: {
      [COLD_RECOVERY_LOCK.serviceId]: { deploy: manifestDeploy },
    },
  }, COLD_RECOVERY_LOCK.serviceId);
  const configuredReplicas = configuredTopology.kind === "configured" &&
      (configuredTopology.configuredTotal === 0 ||
        configuredTopology.configuredTotal === 1)
    ? configuredTopology.configuredTotal
    : null;
  if (
    configuredTopology.kind !== "configured" ||
    configuredReplicas === null ||
    (expectedConfiguredReplicas !== "any" &&
      configuredReplicas !== expectedConfiguredReplicas) ||
    (configuredReplicas === 1 && instance.numReplicas !== null) ||
    (configuredReplicas === 1
      ? canonical(configuredTopology.regions) !== canonical([{
        region: COLD_RECOVERY_LOCK.configuredRegionBefore,
        numReplicas: 1,
      }])
      : configuredTopology.effectiveZero !== true ||
        configuredTopology.regions.some((entry) =>
          !COLD_RECOVERY_LOCK.quiesceRegions.includes(
            entry.region as (typeof COLD_RECOVERY_LOCK.quiesceRegions)[number],
          ) || entry.numReplicas !== 0)) ||
    deploymentTopology.kind !== "configured" ||
    deploymentTopology.configuredTotal !== 1 ||
    canonical(deploymentTopology.regions) !== canonical([{
      region: COLD_RECOVERY_LOCK.region,
      numReplicas: 1,
    }])
  ) return null;
  const rows: ColdRecoveryVariableRow[] = [];
  for (const edge of environment.variables.edges) {
    if (!exactKeys(edge, ["node"])) return null;
    const parsed = parseVariableRow(edge.node);
    if (!parsed) return null;
    rows.push(parsed);
  }
  rows.sort((left, right) =>
    `${left.serviceId ?? ""}:${left.name}:${left.id}`.localeCompare(
      `${right.serviceId ?? ""}:${right.name}:${right.id}`,
    ));
  if (
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    new Set(rows.map((row) => `${row.serviceId ?? ""}:${row.name}`)).size !== rows.length ||
    !requiredRowsExact(rows)
  ) return null;
  return {
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    serviceInstanceId: COLD_RECOVERY_LOCK.serviceInstanceId,
    serviceId: COLD_RECOVERY_LOCK.serviceId,
    numReplicas: instance.numReplicas as null | 0,
    configuredReplicas,
    configuredRegions: configuredTopology.regions,
    deploymentRegions: deploymentTopology.regions,
    source: { repo: null, image: null },
    latestDeployment: {
      id: COLD_RECOVERY_LOCK.deploymentId,
      status: "FAILED",
      deploymentStopped: true,
      snapshotId: COLD_RECOVERY_LOCK.snapshotId,
    },
    activeDeployments: [],
    domains: [{
      kind: "service",
      id: COLD_RECOVERY_LOCK.domainId,
      domain: COLD_RECOVERY_LOCK.domain,
      targetPort: 8_080,
    }],
    deployment: {
      id: COLD_RECOVERY_LOCK.deploymentId,
      projectId: COLD_RECOVERY_LOCK.projectId,
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      snapshotId: COLD_RECOVERY_LOCK.snapshotId,
      commitHash: COLD_RECOVERY_LOCK.sourceSha,
      imageDigest: null,
      patchId: null,
    },
    rows,
  };
}

export async function readColdRecoveryState(
  fetchImpl: typeof fetch,
  token: string,
  configuredReplicas: 0 | 1 | "any",
): Promise<ColdRecoveryState | null> {
  try {
    return parseColdRecoveryState(await railwayCall(
      fetchImpl,
      token,
      COLD_RECOVERY_STATE_QUERY,
      {
        projectId: COLD_RECOVERY_LOCK.projectId,
        environmentId: COLD_RECOVERY_LOCK.environmentId,
        serviceId: COLD_RECOVERY_LOCK.serviceId,
        deploymentId: COLD_RECOVERY_LOCK.deploymentId,
      },
    ), configuredReplicas);
  } catch {
    return null;
  }
}

export function coldIdentityCanonical(state: ColdRecoveryState): string {
  return canonical({
    environmentId: state.environmentId,
    serviceInstanceId: state.serviceInstanceId,
    serviceId: state.serviceId,
    deploymentRegions: state.deploymentRegions,
    source: state.source,
    latestDeployment: state.latestDeployment,
    activeDeployments: state.activeDeployments,
    domains: state.domains,
    deployment: state.deployment,
  });
}

export function fullStateCanonical(state: ColdRecoveryState): string {
  return canonical(state);
}

export interface SupabaseReplacementPrerequisite {
  readonly terminalSha256: string;
  readonly candidateSha: string;
  readonly outcome: "acknowledged_pending_runtime_proof";
}

export function parseSupabaseReplacementPrerequisite(
  source: string,
  candidateSha: string,
): SupabaseReplacementPrerequisite | null {
  try {
    const terminal = JSON.parse(source) as unknown;
    if (!exactKeys(terminal, [
      "schemaVersion",
      "receipt",
      "secretMaterialIncluded",
      "secretDerivedCommitmentsIncluded",
    ]) || canonical(terminal) !== source ||
      terminal.schemaVersion !== SUPABASE_REPLACEMENT_TERMINAL_SCHEMA ||
      terminal.secretMaterialIncluded !== false ||
      terminal.secretDerivedCommitmentsIncluded !== false ||
      !record(terminal.receipt)) return null;
    const receipt = terminal.receipt;
    if (!exactKeys(receipt, [
      "schemaVersion",
      "executorState",
      "operation",
      "outcome",
      "candidateSha",
      "attempts",
      "retryAllowed",
      "intentSha256",
      "terminalEvidenceSha256",
      "externalMutationFreeze",
      "stagedDeletionPatchId",
      "supabaseKeyCanary",
      "checks",
    ]) || receipt.schemaVersion !== SUPABASE_REPLACEMENT_RECEIPT_SCHEMA ||
      receipt.executorState !== "GITHUB_ENVIRONMENT_PROTECTED" ||
      receipt.operation !== "supabase-key-replacement" ||
      receipt.outcome !== "acknowledged_pending_runtime_proof" ||
      receipt.candidateSha !== candidateSha || receipt.attempts !== 1 ||
      receipt.retryAllowed !== false ||
      !SHA256_PATTERN.test(String(receipt.intentSha256)) ||
      receipt.terminalEvidenceSha256 !== null ||
      !exactKeys(receipt.externalMutationFreeze, [
        "attestation",
        "enforcement",
        "providerCasOrLockVerified",
      ]) || receipt.externalMutationFreeze.attestation !==
        COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION ||
      receipt.externalMutationFreeze.enforcement !==
        EXTERNAL_MUTATION_FREEZE_ENFORCEMENT ||
      receipt.externalMutationFreeze.providerCasOrLockVerified !== false ||
      receipt.stagedDeletionPatchId !== null ||
      !exactKeys(receipt.supabaseKeyCanary, [
        "origin",
        "publishableEndpoint",
        "secretEndpoint",
        "publishableHttpStatus",
        "secretHttpStatus",
        "checks",
        "secretMaterialIncluded",
        "secretDerivedCommitmentsIncluded",
      ])) return null;
    const canary = receipt.supabaseKeyCanary;
    if (canary.origin !== "https://bbfibbadwjxzrcdncavy.supabase.co" ||
      canary.publishableEndpoint !== "/auth/v1/settings" ||
      canary.secretEndpoint !== "/rest/v1/profiles?select=id&limit=1" ||
      canary.publishableHttpStatus !== 200 || canary.secretHttpStatus !== 200 ||
      canary.secretMaterialIncluded !== false ||
      canary.secretDerivedCommitmentsIncluded !== false ||
      !exactKeys(canary.checks, [
        "replacementKeyShapesExact",
        "replacementKeysDistinct",
        "publishableAuthSettingsExact",
        "secretProfilesRelationExact",
        "exactInputPairUsed",
        "evidenceSecretFreeExact",
      ]) || Object.values(canary.checks).some((value) => value !== true) ||
      !exactKeys(receipt.checks, [
        "policyExact",
        "githubAuthorityExact",
        "externalMutationFreezeAttested",
        "tokenScopesExact",
        "boundaryPreflightExact",
        "boundaryPrecommitExact",
        "targetPreflightExact",
        "supabasePairCanaryExact",
        "durableIntentExact",
        "mutationAttemptedAtMostOnce",
        "acknowledgementExact",
        "stageAcknowledgementExact",
        "commitAcknowledgementExact",
        "stagedDeletionPatchExact",
        "committedDeletionPatchExact",
        "deploySuppressionExact",
        "postflightAttempted",
        "targetPostflightExact",
        "deploymentUnchanged",
        "boundaryPostflightExact",
        "inputZeroized",
        "terminalEvidenceExact",
      ])) return null;
    const checks = receipt.checks;
    const requiredTrue = [
      "policyExact",
      "githubAuthorityExact",
      "externalMutationFreezeAttested",
      "tokenScopesExact",
      "boundaryPreflightExact",
      "targetPreflightExact",
      "supabasePairCanaryExact",
      "durableIntentExact",
      "mutationAttemptedAtMostOnce",
      "acknowledgementExact",
      "deploySuppressionExact",
      "postflightAttempted",
      "targetPostflightExact",
      "deploymentUnchanged",
      "boundaryPostflightExact",
      "inputZeroized",
    ] as const;
    const requiredFalse = [
      "boundaryPrecommitExact",
      "stageAcknowledgementExact",
      "commitAcknowledgementExact",
      "stagedDeletionPatchExact",
      "committedDeletionPatchExact",
      "terminalEvidenceExact",
    ] as const;
    if (requiredTrue.some((key) => checks[key] !== true) ||
      requiredFalse.some((key) => checks[key] !== false)) return null;
    return {
      terminalSha256: sha256(source),
      candidateSha,
      outcome: "acknowledged_pending_runtime_proof",
    };
  } catch {
    return null;
  }
}

export function reassertRepositoryState(cwd: string, candidateSha: string): boolean {
  try {
    const run = (args: readonly string[]) => execFileSync("git", [...args], {
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
    return run(["rev-parse", "HEAD"]) === candidateSha &&
      run(["rev-parse", "refs/remotes/origin/main"]) === candidateSha &&
      run(["status", "--porcelain=v2", "--untracked-files=all"]) === "";
  } catch {
    return false;
  }
}

export function writeDurable(
  directory: string,
  leaf: string,
  source: string,
): string {
  if (Buffer.byteLength(source) > MAX_EVIDENCE_BYTES) {
    throw new Error("evidence_invalid");
  }
  writePrivateExclusiveFile(directory, leaf, source, { requireOwner: true });
  return sha256(source);
}

export function readPrivateEvidence(filename: string): string {
  return readTrustedRegularFile(filename, {
    minBytes: 2,
    maxBytes: MAX_EVIDENCE_BYTES,
    requireOwner: true,
    requirePrivate: true,
  }).toString("utf8");
}

export function parseColdReconcileReviewedAuthority(
  source: string,
  candidateSha: string,
  currentRunId: string,
  priorQuiesceRunId: string,
  prepareRunId: string,
): ColdReconcileReviewedAuthority | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value) || `${JSON.stringify(value)}\n` !== source ||
      value.command !== "verify-github-reviewed-candidate-authority" ||
      value.ok !== true ||
      value.kind !== "pintpath-github-reviewed-candidate-authority" ||
      value.repository !== COLD_RECOVERY_LOCK.repository ||
      value.candidateSha !== candidateSha ||
      value.operation !== "cold-recovery-reconcile-quiesce" ||
      value.workflowPath !==
        ".github/workflows/recover-permanent-staging-cold-zero.yml" ||
      value.workflowRunId !== currentRunId ||
      value.workflowRunAttempt !== 1 ||
      value.priorAmbiguousColdQuiesceRunId !== priorQuiesceRunId ||
      value.selectedColdPrepareRunId !== prepareRunId ||
      value.exactPriorColdQuiesceCandidateRunBound !== true ||
      value.secondColdScaleWritePreventedExact !== true ||
      !canonicalIsoTimestamp(value.runnerLossRecoveryOriginalRunCompletedAt) ||
      value.runnerLossRecoveryGraceHours !== 24 ||
      value.runnerLossRecoveryWithinGraceExact !== true ||
      value.reviewedAuthorityExact !== true ||
      value.freshDispatchWriteGuardExact !== true) return null;
    return {
      sha256: sha256(source),
      priorQuiesceRunId,
      prepareRunId,
    };
  } catch {
    return null;
  }
}

export function parseColdPrepareReconcileReviewedAuthority(
  source: string,
  candidateSha: string,
  currentRunId: string,
  priorPrepareRunId: string,
  replacementRunId: string,
): ColdPrepareReconcileReviewedAuthority | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value) || `${JSON.stringify(value)}\n` !== source ||
      value.command !== "verify-github-reviewed-candidate-authority" ||
      value.ok !== true ||
      value.kind !== "pintpath-github-reviewed-candidate-authority" ||
      value.repository !== COLD_RECOVERY_LOCK.repository ||
      value.candidateSha !== candidateSha ||
      value.operation !== "cold-recovery-reconcile-prepare" ||
      value.workflowPath !==
        ".github/workflows/recover-permanent-staging-cold-zero.yml" ||
      value.workflowRunId !== currentRunId ||
      value.workflowRunAttempt !== 1 ||
      value.priorAmbiguousColdPrepareRunId !== priorPrepareRunId ||
      value.selectedSupabaseReplacementRunId !== replacementRunId ||
      value.exactPriorColdPrepareCandidateRunBound !== true ||
      value.secondColdPrepareWritePreventedExact !== true ||
      !canonicalIsoTimestamp(value.runnerLossRecoveryOriginalRunCompletedAt) ||
      value.runnerLossRecoveryGraceHours !== 24 ||
      value.runnerLossRecoveryWithinGraceExact !== true ||
      value.reviewedAuthorityExact !== true ||
      value.freshDispatchWriteGuardExact !== true) return null;
    return {
      sha256: sha256(source),
      priorPrepareRunId,
      replacementRunId,
    };
  } catch {
    return null;
  }
}

export async function defaultBoundaryCheck(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
): Promise<BoundaryEvidence> {
  let source = "";
  const code = await runRailwayMutationBoundaryCheck({
    argv: ["--policy", COLD_RECOVERY_BOUNDARY_POLICY_PATH],
    env,
    fetchImpl,
    writeOutput: (chunk) => {
      if (Buffer.byteLength(source) + Buffer.byteLength(chunk) > MAX_EVIDENCE_BYTES) {
        throw new Error("boundary_invalid");
      }
      source += chunk;
    },
  });
  return {
    passed: code === 0,
    receiptSha256: source.length > 0 ? sha256(source) : null,
  };
}

export async function probeRuntimeAbsent(
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  for (let round = 0; round < 3; round += 1) {
    for (const route of ["/health", "/startup", "/ready"] as const) {
      try {
        const response = await fetchImpl(
          `https://${COLD_RECOVERY_LOCK.domain}${route}`,
          {
            method: "GET",
            headers: { accept: "application/json" },
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (response.ok) return false;
        await response.body?.cancel();
      } catch {
        // Connection errors and provider 404/5xx both mean no healthy app route.
      }
    }
    if (round < 2) await sleep(5_000);
  }
  return true;
}

export function argumentsExact(
  argv: readonly string[],
  includePrepareEvidence: boolean,
): {
  readonly candidateSha: string;
  readonly expectedDeploymentSha: string;
  readonly evidenceDirectory: string;
  readonly replacementRunId: string | null;
  readonly replacementTerminalFile: string | null;
  readonly prepareRunId: string | null;
  readonly prepareVerificationFile: string | null;
  readonly successorBridgeFile: string | null;
  readonly reviewedAuthorityFile: string | null;
} | null {
  const expectedLength = includePrepareEvidence ? 14 : 10;
  if (argv.length !== expectedLength) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || !key.startsWith("--") || values.has(key)) return null;
    values.set(key, value);
  }
  const allowed = includePrepareEvidence
    ? [
      "--candidate-sha",
      "--expected-deployment-sha",
      "--evidence-dir",
      "--prepare-run-id",
      "--prepare-verification-file",
      "--successor-bridge-file",
      "--reviewed-authority-file",
    ]
    : [
      "--candidate-sha",
      "--expected-deployment-sha",
      "--evidence-dir",
      "--replacement-run-id",
      "--replacement-terminal-file",
    ];
  if ([...values.keys()].some((key) => !allowed.includes(key))) return null;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const expectedDeploymentSha = values.get("--expected-deployment-sha") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const replacementRunId = values.get("--replacement-run-id") ?? null;
  const replacementTerminalFile =
    values.get("--replacement-terminal-file") ?? null;
  const prepareRunId = values.get("--prepare-run-id") ?? null;
  const prepareVerificationFile = values.get("--prepare-verification-file") ?? null;
  const successorBridgeFile = values.get("--successor-bridge-file") ?? null;
  const reviewedAuthorityFile = values.get("--reviewed-authority-file") ?? null;
  if (
    !SHA_PATTERN.test(candidateSha) ||
    expectedDeploymentSha !== COLD_RECOVERY_LOCK.sourceSha ||
    candidateSha === expectedDeploymentSha ||
    !path.isAbsolute(evidenceDirectory) ||
    (!includePrepareEvidence &&
      (!replacementRunId || !/^[1-9][0-9]{0,19}$/.test(replacementRunId) ||
        !replacementTerminalFile || !path.isAbsolute(replacementTerminalFile) ||
        path.resolve(replacementTerminalFile) !== replacementTerminalFile ||
        path.basename(replacementTerminalFile) !== "terminal.json")) ||
    (includePrepareEvidence &&
      (!prepareRunId || !/^[1-9][0-9]{0,19}$/.test(prepareRunId) ||
        !prepareVerificationFile || !path.isAbsolute(prepareVerificationFile) ||
        !successorBridgeFile || !path.isAbsolute(successorBridgeFile) ||
        path.resolve(successorBridgeFile) !== successorBridgeFile ||
        path.basename(successorBridgeFile) !==
          "cold-quiesce-successor-bridge.json" ||
        !reviewedAuthorityFile || !path.isAbsolute(reviewedAuthorityFile) ||
        path.resolve(reviewedAuthorityFile) !== reviewedAuthorityFile ||
        path.basename(reviewedAuthorityFile) !== "reviewed-authority.json")) ||
    (!includePrepareEvidence &&
      (prepareRunId !== null || prepareVerificationFile !== null ||
        successorBridgeFile !== null || reviewedAuthorityFile !== null))
  ) return null;
  return {
    candidateSha,
    expectedDeploymentSha,
    evidenceDirectory,
    replacementRunId,
    replacementTerminalFile,
    prepareRunId,
    prepareVerificationFile,
    successorBridgeFile,
    reviewedAuthorityFile,
  };
}

export function reconcileArgumentsExact(argv: readonly string[]): {
  readonly candidateSha: string;
  readonly expectedDeploymentSha: string;
  readonly evidenceDirectory: string;
  readonly prepareRunId: string;
  readonly prepareVerificationFile: string;
  readonly priorQuiesceRunId: string;
  readonly reviewedAuthorityFile: string;
  readonly successorBridgeFile: string;
  readonly successorReviewedAuthorityFile: string;
} | null {
  if (argv.length !== 18) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || !key.startsWith("--") || values.has(key)) return null;
    values.set(key, value);
  }
  const allowed = [
    "--candidate-sha",
    "--expected-deployment-sha",
    "--evidence-dir",
    "--prepare-run-id",
    "--prepare-verification-file",
    "--prior-quiesce-run-id",
    "--reviewed-authority-file",
    "--successor-bridge-file",
    "--successor-reviewed-authority-file",
  ];
  if ([...values.keys()].some((key) => !allowed.includes(key))) return null;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const expectedDeploymentSha = values.get("--expected-deployment-sha") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const prepareRunId = values.get("--prepare-run-id") ?? "";
  const prepareVerificationFile = values.get("--prepare-verification-file") ?? "";
  const priorQuiesceRunId = values.get("--prior-quiesce-run-id") ?? "";
  const reviewedAuthorityFile = values.get("--reviewed-authority-file") ?? "";
  const successorBridgeFile = values.get("--successor-bridge-file") ?? "";
  const successorReviewedAuthorityFile =
    values.get("--successor-reviewed-authority-file") ?? "";
  if (!SHA_PATTERN.test(candidateSha) ||
    expectedDeploymentSha !== COLD_RECOVERY_LOCK.sourceSha ||
    candidateSha === expectedDeploymentSha ||
    !path.isAbsolute(evidenceDirectory) ||
    !/^[1-9][0-9]{0,19}$/.test(prepareRunId) ||
    !/^[1-9][0-9]{0,19}$/.test(priorQuiesceRunId) ||
    prepareRunId === priorQuiesceRunId ||
    !path.isAbsolute(prepareVerificationFile) ||
    path.basename(prepareVerificationFile) !== "prerequisites-verification.json" ||
    !path.isAbsolute(reviewedAuthorityFile) ||
    path.basename(reviewedAuthorityFile) !== "reviewed-authority.json" ||
    !path.isAbsolute(successorBridgeFile) ||
    path.resolve(successorBridgeFile) !== successorBridgeFile ||
    path.basename(successorBridgeFile) !==
      "cold-quiesce-successor-bridge.json" ||
    !path.isAbsolute(successorReviewedAuthorityFile) ||
    path.resolve(successorReviewedAuthorityFile) !==
      successorReviewedAuthorityFile ||
    path.basename(successorReviewedAuthorityFile) !== "reviewed-authority.json") {
    return null;
  }
  return {
    candidateSha,
    expectedDeploymentSha,
    evidenceDirectory,
    prepareRunId,
    prepareVerificationFile,
    priorQuiesceRunId,
    reviewedAuthorityFile,
    successorBridgeFile,
    successorReviewedAuthorityFile,
  };
}

export function reconcilePrepareArgumentsExact(argv: readonly string[]): {
  readonly candidateSha: string;
  readonly expectedDeploymentSha: string;
  readonly evidenceDirectory: string;
  readonly replacementRunId: string;
  readonly replacementTerminalFile: string;
  readonly priorPrepareRunId: string;
  readonly reviewedAuthorityFile: string;
} | null {
  if (argv.length !== 14) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || !key.startsWith("--") || values.has(key)) return null;
    values.set(key, value);
  }
  const allowed = [
    "--candidate-sha",
    "--expected-deployment-sha",
    "--evidence-dir",
    "--replacement-run-id",
    "--replacement-terminal-file",
    "--prior-prepare-run-id",
    "--reviewed-authority-file",
  ];
  if ([...values.keys()].some((key) => !allowed.includes(key))) return null;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const expectedDeploymentSha = values.get("--expected-deployment-sha") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const replacementRunId = values.get("--replacement-run-id") ?? "";
  const replacementTerminalFile = values.get("--replacement-terminal-file") ?? "";
  const priorPrepareRunId = values.get("--prior-prepare-run-id") ?? "";
  const reviewedAuthorityFile = values.get("--reviewed-authority-file") ?? "";
  if (!SHA_PATTERN.test(candidateSha) ||
    expectedDeploymentSha !== COLD_RECOVERY_LOCK.sourceSha ||
    candidateSha === expectedDeploymentSha ||
    !path.isAbsolute(evidenceDirectory) ||
    !/^[1-9][0-9]{0,19}$/.test(replacementRunId) ||
    !/^[1-9][0-9]{0,19}$/.test(priorPrepareRunId) ||
    replacementRunId === priorPrepareRunId ||
    !path.isAbsolute(replacementTerminalFile) ||
    path.basename(replacementTerminalFile) !== "terminal.json" ||
    !path.isAbsolute(reviewedAuthorityFile) ||
    path.basename(reviewedAuthorityFile) !== "reviewed-authority.json") return null;
  return {
    candidateSha,
    expectedDeploymentSha,
    evidenceDirectory,
    replacementRunId,
    replacementTerminalFile,
    priorPrepareRunId,
    reviewedAuthorityFile,
  };
}

export function authorityExact(
  env: Readonly<Record<string, string | undefined>>,
  operation: "prepare" | "reconcile-prepare" | "quiesce" | "reconcile-quiesce",
  candidateSha: string,
  expectedDeploymentSha: string,
): boolean {
  const expectedEnvironment = operation === "prepare" || operation === "reconcile-prepare"
    ? "permanent-staging-provider-mutation"
    : "permanent-staging-scale-evidence";
  const expectedConfirmation = operation === "prepare"
    ? `PREPARE_PERMANENT_STAGING_COLD_RECOVERY_FOR_${candidateSha}_FROM_${expectedDeploymentSha}`
    : operation === "reconcile-prepare"
    ? `RECONCILE_PERMANENT_STAGING_COLD_PREPARE_FOR_${candidateSha}_FROM_${expectedDeploymentSha}`
    : operation === "quiesce"
    ? `QUIESCE_PERMANENT_STAGING_COLD_RECOVERY_TO_ZERO_FOR_${candidateSha}_FROM_${expectedDeploymentSha}`
    : `RECONCILE_PERMANENT_STAGING_COLD_RECOVERY_AT_ZERO_FOR_${candidateSha}_FROM_${expectedDeploymentSha}`;
  return env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_REPOSITORY === COLD_RECOVERY_LOCK.repository &&
    env.GITHUB_REF === "refs/heads/main" &&
    env.GITHUB_SHA === candidateSha &&
    env.GITHUB_RUN_ATTEMPT === "1" &&
    env.PINTPATH_PROTECTED_ENVIRONMENT === expectedEnvironment &&
    env.PINTPATH_COLD_RECOVERY_CONFIRMATION === expectedConfirmation;
}

export function readOnlyTokensExact(
  env: Readonly<Record<string, string | undefined>>,
): { readonly metadata: string } | null {
  const metadata = env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
  const production = env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
  const scale = env.PINTPATH_RAILWAY_STAGING_SCALE_TOKEN ?? "";
  const variable = env.PINTPATH_RAILWAY_STAGING_VARIABLE_TOKEN ?? "";
  const variableMutation =
    env.PINTPATH_RAILWAY_STAGING_VARIABLE_MUTATION_TOKEN ?? "";
  const generic = env.RAILWAY_TOKEN ?? "";
  const stagingMutation = env.PINTPATH_RAILWAY_STAGING_MUTATION_TOKEN ?? "";
  if (!TOKEN_PATTERN.test(metadata) || !TOKEN_PATTERN.test(production) ||
    metadata === production || scale !== "" || variable !== "" ||
    variableMutation !== "" || generic !== "" || stagingMutation !== "") {
    return null;
  }
  return { metadata };
}

export function tokensExact(
  env: Readonly<Record<string, string | undefined>>,
  operation: "prepare" | "quiesce",
): {
  readonly metadata: string;
  readonly mutation: string;
} | null {
  const metadata = env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
  const production = env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
  const mutation = operation === "prepare"
    ? env.PINTPATH_RAILWAY_STAGING_VARIABLE_TOKEN ?? ""
    : env.PINTPATH_RAILWAY_STAGING_SCALE_TOKEN ?? "";
  if (
    !TOKEN_PATTERN.test(metadata) ||
    !TOKEN_PATTERN.test(production) ||
    !TOKEN_PATTERN.test(mutation) ||
    metadata === production ||
    mutation === metadata ||
    mutation === production
  ) return null;
  return { metadata, mutation };
}

export function shaPatternsExact(value: unknown): boolean {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}
