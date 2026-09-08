import crypto from "node:crypto";

import {
  railwayEnvironmentPatchCommitVariables,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
} from "./railway-environment-patch-commit.js";
import {
  PROTECTED_SCALE_RECEIPT_SCHEMA,
  protectedScaleReplicaTopologyExact,
} from "./protected-scale-receipt-topology.js";

const PRODUCTION_ENVIRONMENT_ID = "13dab015-df74-45c6-b26f-69323daea99a";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const REGION = "asia-southeast1-eqsg3a";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;

export const PROTECTED_PRODUCTION_SCALE_PATCH_HISTORY_QUERY =
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
}` as const;

export const PROTECTED_PRODUCTION_SCALE_PATCH_QUERY =
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
}` as const;

type JsonRecord = Record<string, unknown>;

export interface ParsedProtectedProductionScaleReceipt {
  readonly schemaVersion: typeof PROTECTED_SCALE_RECEIPT_SCHEMA;
  readonly outcome: "scaled" | "reconciled_scaled" | "already_converged";
  readonly githubRunId: string;
  readonly deploymentIdSha256: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly attempts: 0 | 1;
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is JsonRecord {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    sortObjectKeys(value[key]),
  ]));
}

function canonicalProviderJson(value: unknown): string {
  return `${JSON.stringify(sortObjectKeys(value), null, 2)}\n`;
}

function pagesExact(value: unknown, rowCount: number): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return false;
  let expectedAfter: string | null = null;
  let total = 0;
  const endCursors = new Set<string>();
  for (const [index, page] of value.entries()) {
    if (!exactKeys(page, [
      "requestAfter",
      "count",
      "endCursor",
      "hasNextPage",
    ]) || page.requestAfter !== expectedAfter ||
      !Number.isSafeInteger(page.count) || Number(page.count) < 0 ||
      Number(page.count) > 100 || typeof page.hasNextPage !== "boolean" ||
      !(page.endCursor === null || typeof page.endCursor === "string") ||
      (typeof page.endCursor === "string" &&
        (page.endCursor.length < 1 || page.endCursor.length > 4096 ||
          /[\r\n\0]/.test(page.endCursor) ||
          endCursors.has(page.endCursor))) ||
      (Number(page.count) === 0
        ? page.endCursor !== null
        : page.endCursor === null) ||
      (page.hasNextPage && Number(page.count) !== 100) ||
      (page.hasNextPage !== (index < value.length - 1))) return false;
    total += Number(page.count);
    if (typeof page.endCursor === "string") endCursors.add(page.endCursor);
    expectedAfter = page.endCursor as string | null;
  }
  return total === rowCount;
}

function historySnapshotExact(
  value: unknown,
  matchingCount: 0 | 1,
  expected: {
    readonly messageSha256: string;
    readonly patchSha256: string;
    readonly startedAtMs: number;
    readonly completedAtMs: number;
  },
): value is JsonRecord {
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
    value.querySha256.history !==
      sha256(PROTECTED_PRODUCTION_SCALE_PATCH_HISTORY_QUERY) ||
    value.querySha256.patch !== sha256(PROTECTED_PRODUCTION_SCALE_PATCH_QUERY) ||
    !Number.isSafeInteger(value.pageCount) || Number(value.pageCount) < 1 ||
    Number(value.pageCount) > 8 || !Number.isSafeInteger(value.rowCount) ||
    Number(value.rowCount) < 0 || Number(value.rowCount) > 800 ||
    !Array.isArray(value.pages) || value.pages.length !== value.pageCount ||
    !pagesExact(value.pages, Number(value.rowCount)) ||
    !SHA256_PATTERN.test(String(value.rowsProjectionSha256)) ||
    !SHA256_PATTERN.test(String(value.nonMatchingRowsProjectionSha256)) ||
    value.paginationCompleteExact !== true ||
    value.matchingPatchCount !== matchingCount ||
    value.secretMaterialIncluded !== false ||
    value.secretDerivedCommitmentsIncluded !== false) return false;
  if (matchingCount === 0) {
    return value.matchingPatch === null &&
      value.rowsProjectionSha256 === value.nonMatchingRowsProjectionSha256;
  }
  if (!exactKeys(value.matchingPatch, [
    "rowIndex",
    "idSha256",
    "status",
    "createdAt",
    "updatedAt",
    "appliedAt",
    "messageSha256",
    "patchSha256",
    "crossFetchExact",
  ]) || value.matchingPatch.rowIndex !== 0 ||
    !SHA256_PATTERN.test(String(value.matchingPatch.idSha256)) ||
    value.matchingPatch.status !== "COMMITTED" ||
    !canonicalTimestamp(value.matchingPatch.createdAt) ||
    !canonicalTimestamp(value.matchingPatch.updatedAt) ||
    !canonicalTimestamp(value.matchingPatch.appliedAt) ||
    Date.parse(value.matchingPatch.createdAt) >
      Date.parse(value.matchingPatch.updatedAt) ||
    Date.parse(value.matchingPatch.appliedAt) >
      Date.parse(value.matchingPatch.updatedAt) ||
    Date.parse(value.matchingPatch.createdAt) < expected.startedAtMs ||
    Date.parse(value.matchingPatch.appliedAt) < expected.startedAtMs ||
    Date.parse(value.matchingPatch.createdAt) > expected.completedAtMs ||
    Date.parse(value.matchingPatch.appliedAt) > expected.completedAtMs ||
    Date.parse(value.matchingPatch.updatedAt) > expected.completedAtMs ||
    value.matchingPatch.messageSha256 !== expected.messageSha256 ||
    value.matchingPatch.patchSha256 !== expected.patchSha256 ||
    value.matchingPatch.crossFetchExact !== true) return false;
  return true;
}

function providerHistoryExact(
  value: unknown,
  attempts: 0 | 1,
  expected: {
    readonly messageSha256: string;
    readonly patchSha256: string;
    readonly startedAtMs: number;
    readonly completedAtMs: number;
  },
): boolean {
  if (!exactKeys(value, ["prewrite", "postflight"])) return false;
  if (attempts === 0) {
    return value.prewrite === null && value.postflight === null;
  }
  return historySnapshotExact(value.prewrite, 0, expected) &&
    historySnapshotExact(value.postflight, 1, expected) &&
    Number(value.postflight.rowCount) === Number(value.prewrite.rowCount) + 1 &&
    value.postflight.nonMatchingRowsProjectionSha256 ===
      value.prewrite.rowsProjectionSha256;
}

function directMutationExact(
  value: unknown,
  outcome: ParsedProtectedProductionScaleReceipt["outcome"],
  expected: {
    readonly variablesSha256: string;
    readonly requestBodySha256: string;
    readonly commitMessageSha256: string;
  },
): boolean {
  if (!exactKeys(value, [
    "operationName",
    "operation",
    "transportOutcome",
    "querySha256",
    "variablesSha256",
    "requestBodySha256",
    "responseBodySha256",
    "acknowledgementSha256",
    "acknowledgementExact",
    "commitMessageSha256",
    "zeroRegionsEncodedAsJsonNull",
    "providerCasOrLockVerified",
    "externalMutationFreezeEnforcement",
  ]) || value.operationName !== RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME ||
    value.operation !== "environmentPatchCommit" ||
    value.querySha256 !== sha256(RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION) ||
    value.providerCasOrLockVerified !== false ||
    value.externalMutationFreezeEnforcement !== "operational_attestation_only") {
    return false;
  }
  if (outcome === "already_converged") {
    return value.transportOutcome === null && value.variablesSha256 === null &&
      value.requestBodySha256 === null && value.responseBodySha256 === null &&
      value.acknowledgementSha256 === null &&
      value.acknowledgementExact === false &&
      value.commitMessageSha256 === null &&
      value.zeroRegionsEncodedAsJsonNull === false;
  }
  return value.transportOutcome === (outcome === "scaled"
      ? "acknowledged"
      : "transport_uncertain") &&
    value.variablesSha256 === expected.variablesSha256 &&
    value.requestBodySha256 === expected.requestBodySha256 &&
    value.commitMessageSha256 === expected.commitMessageSha256 &&
    value.zeroRegionsEncodedAsJsonNull === true &&
    (outcome === "scaled"
      ? SHA256_PATTERN.test(String(value.responseBodySha256)) &&
        SHA256_PATTERN.test(String(value.acknowledgementSha256)) &&
        value.acknowledgementExact === true
      : (value.responseBodySha256 === null ||
          SHA256_PATTERN.test(String(value.responseBodySha256))) &&
        value.acknowledgementSha256 === null &&
        value.acknowledgementExact === false);
}

const CHECK_KEYS = [
  "policyExact",
  "githubAuthorityExact",
  "externalMutationFreezeAttested",
  "tokenScopesExact",
  "directMutationContractExact",
  "boundaryPreflightExact",
  "targetPreflightExact",
  "productionActivationPrerequisiteExact",
  "productionActivationDeploymentContinuityExact",
  "runtimePreflightExact",
  "durableIntentExact",
  "repositoryPrewriteReasserted",
  "writeAttemptedAtMostOnce",
  "mutationResponseClassified",
  "acknowledgementExact",
  "lostAcknowledgementExact",
  "providerHistoryPrewriteExact",
  "providerHistoryPostflightExact",
  "postflightAttempted",
  "targetPostflightExact",
  "runtimePostflightExact",
  "candidateUnchanged",
  "deploymentUnchanged",
  "providerConfigurationCollateralUnchanged",
  "replicaTopologyEvidenceExact",
  "boundaryPostflightExact",
  "terminalEvidenceExact",
  "finalReceiptEvidenceExact",
] as const;

function checksExact(
  value: unknown,
  outcome: ParsedProtectedProductionScaleReceipt["outcome"],
): boolean {
  if (!exactKeys(value, CHECK_KEYS)) return false;
  const attempted = outcome !== "already_converged";
  const acknowledged = outcome === "scaled";
  const lostAcknowledgement = outcome === "reconciled_scaled";
  const falseWhenUnattempted = new Set([
    "durableIntentExact",
    "mutationResponseClassified",
    "acknowledgementExact",
    "lostAcknowledgementExact",
    "providerHistoryPrewriteExact",
    "providerHistoryPostflightExact",
  ]);
  return CHECK_KEYS.every((key) => {
    if (key === "acknowledgementExact") return value[key] === acknowledged;
    if (key === "lostAcknowledgementExact") {
      return value[key] === lostAcknowledgement;
    }
    if (falseWhenUnattempted.has(key)) return value[key] === attempted;
    return value[key] === true;
  });
}

export function parseProtectedProductionScaleReceipt(
  value: unknown,
  expected: {
    readonly candidateSha: string;
    readonly deploymentBeforeActivationIdSha256: string;
    readonly expectedGithubRunId: string;
  },
): ParsedProtectedProductionScaleReceipt | null {
  if (!exactKeys(value, [
    "schemaVersion",
    "executorState",
    "direction",
    "outcome",
    "candidateSha",
    "githubRunId",
    "startedAt",
    "completedAt",
    "desiredReplicas",
    "deploymentIdSha256",
    "attempts",
    "retryAllowed",
    "intentSha256",
    "terminalEvidenceSha256",
    "directMutationEvidence",
    "providerHistoryEvidence",
    "productionActivationPrerequisite",
    "replicaTopology",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
    "checks",
  ]) || value.schemaVersion !== PROTECTED_SCALE_RECEIPT_SCHEMA ||
    value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED" ||
    value.direction !== "converge-production-two" ||
    !["scaled", "reconciled_scaled", "already_converged"].includes(
      String(value.outcome),
    ) || value.candidateSha !== expected.candidateSha ||
    typeof value.githubRunId !== "string" ||
    !RUN_ID_PATTERN.test(value.githubRunId) ||
    value.githubRunId !== expected.expectedGithubRunId ||
    !canonicalTimestamp(value.startedAt) ||
    !canonicalTimestamp(value.completedAt) ||
    Date.parse(value.completedAt) < Date.parse(value.startedAt) ||
    value.desiredReplicas !== 2 ||
    !SHA256_PATTERN.test(String(value.deploymentIdSha256)) ||
    value.retryAllowed !== false ||
    (value.attempts !== 0 && value.attempts !== 1) ||
    !SHA256_PATTERN.test(String(value.terminalEvidenceSha256)) ||
    value.secretMaterialIncluded !== false ||
    value.secretDerivedCommitmentsIncluded !== false) return null;

  const outcome = value.outcome as ParsedProtectedProductionScaleReceipt["outcome"];
  const attempts = value.attempts as 0 | 1;
  if ((attempts === 0) !== (outcome === "already_converged") ||
    (attempts === 0
      ? value.intentSha256 !== null
      : !SHA256_PATTERN.test(String(value.intentSha256)))) return null;

  const prerequisite = value.productionActivationPrerequisite;
  if (!exactKeys(prerequisite, [
    "runId",
    "verificationSha256",
    "terminalSha256",
    "prerequisitesSha256",
    "deploymentBeforeIdSha256",
    "deploymentAfterIdSha256",
  ]) || typeof prerequisite.runId !== "string" ||
    !RUN_ID_PATTERN.test(prerequisite.runId) ||
    !SHA256_PATTERN.test(String(prerequisite.verificationSha256)) ||
    !SHA256_PATTERN.test(String(prerequisite.terminalSha256)) ||
    !SHA256_PATTERN.test(String(prerequisite.prerequisitesSha256)) ||
    prerequisite.deploymentBeforeIdSha256 !==
      expected.deploymentBeforeActivationIdSha256 ||
    prerequisite.deploymentAfterIdSha256 !== value.deploymentIdSha256 ||
    prerequisite.deploymentAfterIdSha256 ===
      prerequisite.deploymentBeforeIdSha256) return null;

  const commitMessage =
    `PintPath scale converge-production-two ${expected.candidateSha} run ${value.githubRunId}`;
  const variables = railwayEnvironmentPatchCommitVariables({
    environmentId: PRODUCTION_ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    regions: [{ region: REGION, numReplicas: 2 }],
    commitMessage,
  });
  if (variables === null) return null;
  const requestBody = JSON.stringify({
    operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
    query: RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
    variables,
  });
  const directExpected = {
    variablesSha256: sha256(JSON.stringify(variables)),
    requestBodySha256: sha256(requestBody),
    commitMessageSha256: sha256(commitMessage),
  };
  const historyExpected = {
    messageSha256: directExpected.commitMessageSha256,
    patchSha256: sha256(canonicalProviderJson(variables.patch)),
    startedAtMs: Date.parse(value.startedAt),
    completedAtMs: Date.parse(value.completedAt),
  };
  if (!directMutationExact(value.directMutationEvidence, outcome, directExpected) ||
    !providerHistoryExact(value.providerHistoryEvidence, attempts, historyExpected) ||
    !protectedScaleReplicaTopologyExact(value.replicaTopology, {
      direction: "converge-production-two",
      attempts,
      desiredReplicas: 2,
      target: "production",
    }) || !checksExact(value.checks, outcome)) return null;

  return {
    schemaVersion: PROTECTED_SCALE_RECEIPT_SCHEMA,
    outcome,
    githubRunId: value.githubRunId,
    deploymentIdSha256: String(value.deploymentIdSha256),
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    attempts,
  };
}
