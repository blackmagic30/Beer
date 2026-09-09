import {
  POST_Q_DEPLOYMENT_STOP_LOCK,
  POST_Q_DEPLOYMENT_STOP_Q_LEAVES,
  postQSha256,
  type PostQAuthorityEvidence,
  type ReviewedContainmentAuthorityEvidence,
} from "./permanent-staging-post-q-deployment-stop.js";

export const POST_Q_DEPLOYMENT_STOP_AUTHORITY_V3_SCHEMA =
  "pintpath-permanent-staging-post-q-authority/v3" as const;
export const POST_Q_DEPLOYMENT_STOP_REVIEWED_AUTHORITY_V3_SCHEMA =
  "pintpath-permanent-staging-post-q-reviewed-candidate-authority/v3" as const;
export const POST_Q_DEPLOYMENT_STOP_V3_AUTHORIZATION_ID =
  "pintpath-post-q-staging-stop-reauthorization-2026-09-10/v3" as const;
export const POST_Q_DEPLOYMENT_STOP_V3_AUTHORIZATION_THREAD_ID =
  "01a02140-8628-7d30-9374-8d29d4a9f3a3" as const;
export const POST_Q_DEPLOYMENT_STOP_V3_AUTHORIZATION_SOURCE_SHA256 =
  "d2c7b4c9d700a1d7c5219dd6c4245d5900154421497b8c637ac93f9215662549" as const;
export const POST_Q_DEPLOYMENT_STOP_V3_EXPLICIT_EXPIRY =
  "2026-09-10T08:00:00.000Z" as const;
export const POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_SHA =
  "78162cf42a0ef3190343a657ff94f288d4a4c7ca" as const;
export const POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_TREE_SHA =
  "410fd437bb0c459049f08bbff63ee605f2e65c9e" as const;
export const POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_PARENT_SHA =
  "d27275f4c101b764c6016e8b378969c14719258e" as const;
export const POST_Q_DEPLOYMENT_STOP_V3_WORKFLOW_ID = 353_312_302 as const;
export const POST_Q_DEPLOYMENT_STOP_V3_WORKFLOW_PATH =
  ".github/workflows/stop-permanent-staging-post-q-deployment.yml" as const;
export const POST_Q_DEPLOYMENT_STOP_V3_CONFIRMATION_PREFIX =
  "REAUTHORIZE_ONE_STAGING_DEPLOYMENT_STOP_6300A324_9407_4B1C_B651_749C47E9537F_FOR_" as const;
export const POST_Q_DEPLOYMENT_STOP_V3_CONFIRMATION_SUFFIX =
  "_UNDER_V3_FROM_01A02140_8628_7D30_9374_8D29D4A9F3A3" as const;

const RELEASE_POLICY_SHA256 =
  "4aaedd863d08e539e1628db5d14557cc23531a0c6d586ffb25acebcba7907e90";
const SUCCESSOR_POLICY_SHA256 =
  "e7c0adec553e42e28ff2ae877835aa3255cfaa2ee8584f64c08ebe7983d901dd";
const OLD_DEADLINE = "2026-09-08T18:57:20.000Z";
const OLD_RUN_ID = "34255228036";
const OLD_WORKFLOW_BLOB_OID = "0d5efadc53101ae6631e25bbff7c804a30faa672";
const OLD_WORKFLOW_BYTE_SHA256 =
  "6a452880ccbe3d80d9d771b4aae7bd3be2bcf26beac7dee1af91d0c705e7a9a8";
const OLD_WORKFLOW_SIZE_BYTES = 28_866;
const OLD_RECOVERY_TREE_SHA =
  "9978dca9491f7bf7bee77ce39debe1f713e89c53";
const OLD_RECOVERY_CANDIDATE_SHA =
  "f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7";
const PRE_V2_CANDIDATE_TREE_SHA =
  "53808bdd995a6ff1d2204e01f7639b103dbd5a76";
const MAX_AFTER_MERGE_MS = 4 * 60 * 60 * 1_000;
const MAX_AFTER_RUN_START_MS = 90 * 60 * 1_000;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

const REQUIRED_CHECKS = Object.freeze([
  ["postgres-tool-runtime-closure-observation", ".github/workflows/ci.yml"],
  ["postgres-migration-integration", ".github/workflows/ci.yml"],
  ["build-test-scan", ".github/workflows/ci.yml"],
  ["supabase-database", ".github/workflows/ci.yml"],
  ["CodeQL JavaScript and TypeScript", ".github/workflows/codeql.yml"],
  ["CodeQL Swift", ".github/workflows/codeql.yml"],
  ["release-readiness", ".github/workflows/pintpath-release-readiness.yml"],
  ["ios", ".github/workflows/native-apps.yml"],
] as const);
const REQUIRED_ARTIFACTS = Object.freeze([
  ["pintpath-mission-discovery-scale-evidence", "postgres-migration-integration"],
  ["pintpath-postgres-tool-runtime-closure-v4-observation", "postgres-tool-runtime-closure-observation"],
  ["pintpath-automated-readiness-evidence", "release-readiness"],
] as const);
const V2_ARCHIVE = Object.freeze([
  Object.freeze(["authorization",
    "ops/railway/permanent-staging-post-q-deployment-stop-authorization-v2.json",
    "69a56dfcd32afaaef2998884ba7df6051dc8b67e", 267,
    "4203affc634766c1ba695c969448d8c126552d1c16ffb090e2a55d5f319a0779"]),
  Object.freeze(["policy",
    "ops/railway/permanent-staging-post-q-deployment-stop-policy-v2.json",
    "4f2b1447129bf73788d16f6c37057d89e392a520", 6141,
    "5f4c4bc20c8ef68ed77f51ad92a11cede00122e3274e4408eb8ea858d6a07e4b"]),
  Object.freeze(["verifier",
    "scripts/verify-permanent-staging-post-q-authority-v2.mjs",
    "306c9536ebd320205542072474959ff67c2738e9", 56_752,
    "50eccd00ae5059568da11421d75546ed4691ab30399d8bb6a36a2c626cc3105f"]),
  Object.freeze(["authorityLibrary",
    "scripts/lib/permanent-staging-post-q-deployment-stop-authority-v2.ts",
    "b16a9ee516d64e67d8ccdf566f2148334e0626ba", 23_328,
    "412890199755cc95f9f69cd9c6ca15d1b16716b1f3c12fcefed5102e665a9389"]),
  Object.freeze(["executor",
    "scripts/execute-protected-permanent-staging-post-q-deployment-stop-v2.ts",
    "e8696a21e3f6b5124acf3d91fcd692a9b87e2902", 987,
    "4b4b41cb81e18862c6b340d2e78e0a940f9c41c2396cc38d77af8b8808f87b87"]),
  Object.freeze(["canonicalWorkflow",
    ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
    "6633205b7fdf36edae8986d6fa08c9a48e8a95c9", 30_062,
    "712cca911de33b915defb3939dedd95a6c53a57e03e7e596d009437071d7ada5"]),
] as const);

type Json = Record<string, unknown>;

function record(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Json {
  return record(value) && JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
}

function canonical(value: unknown, source: string): boolean {
  return `${JSON.stringify(value, null, 2)}\n` === source;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z");
}

function allTrue(value: unknown, keys: readonly string[]): boolean {
  return exact(value, keys) && Object.values(value).every((item) => item === true);
}

export function derivePostQDeploymentStopV3Deadline(
  pullRequestMergedAt: string,
  runStartedAt: string,
): string | null {
  if (!timestamp(pullRequestMergedAt) || !timestamp(runStartedAt)) return null;
  const merged = Date.parse(pullRequestMergedAt);
  const started = Date.parse(runStartedAt);
  const explicit = Date.parse(POST_Q_DEPLOYMENT_STOP_V3_EXPLICIT_EXPIRY);
  if (![merged, started, explicit].every(Number.isFinite) ||
    merged > started || started >= explicit) return null;
  return new Date(Math.min(
    merged + MAX_AFTER_MERGE_MS,
    started + MAX_AFTER_RUN_START_MS,
    explicit,
  )).toISOString();
}

function authorizationExact(value: unknown): value is Json {
  return exact(value, [
    "authorizationId", "sourceThreadId", "sourceSchemaVersion",
    "sourceSha256", "sourceSizeBytes", "sourceSerialization",
    "messagesExact", "provenanceUse", "reviewedProvenanceOnly",
    "cryptographicUserSignatureClaimed", "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ]) && value.authorizationId === POST_Q_DEPLOYMENT_STOP_V3_AUTHORIZATION_ID &&
    value.sourceThreadId === POST_Q_DEPLOYMENT_STOP_V3_AUTHORIZATION_THREAD_ID &&
    value.sourceSchemaVersion ===
      "pintpath-reviewed-user-authorization-provenance/v2" &&
    value.sourceSha256 === POST_Q_DEPLOYMENT_STOP_V3_AUTHORIZATION_SOURCE_SHA256 &&
    value.sourceSizeBytes === 394 &&
    value.sourceSerialization === "JSON.stringify(value,null,2)+LF" &&
    value.messagesExact === true && value.provenanceUse ===
      "pintpath-post-q-staging-stop-successor-v3-reviewed-context" &&
    value.reviewedProvenanceOnly === true &&
    value.cryptographicUserSignatureClaimed === false &&
    value.secretMaterialIncluded === false &&
    value.secretDerivedCommitmentsIncluded === false;
}

function deadlinePolicyExact(value: unknown, mergedAt: string,
  runStartedAt: string): value is Json {
  const derived = derivePostQDeploymentStopV3Deadline(mergedAt, runStartedAt);
  return derived !== null && exact(value, [
    "explicitExpiry", "maximumAfterPullRequestMergeSeconds",
    "maximumAfterRunStartSeconds", "derivedDeadline",
    "derivation", "rederiveImmediatelyBeforeWriter",
    "expirySuppressesPostWriteReconciliation", "expirySuppressesFinalization",
  ]) && value.explicitExpiry === POST_Q_DEPLOYMENT_STOP_V3_EXPLICIT_EXPIRY &&
    value.maximumAfterPullRequestMergeSeconds === 14_400 &&
    value.maximumAfterRunStartSeconds === 5_400 &&
    value.derivedDeadline === derived &&
    value.derivation ===
      "min(pull_request_merged_at_plus_4h,current_run_started_at_plus_90m,explicit_expiry)" &&
    value.rederiveImmediatelyBeforeWriter === true &&
    value.expirySuppressesPostWriteReconciliation === false &&
    value.expirySuppressesFinalization === false;
}

function oldNoWriteExact(value: unknown): value is Json {
  return exact(value, [
    "workflowId", "workflowPath", "authorizationDeadline",
    "authorizationExpired", "authorityReused", "runId", "runNumber",
    "runAttempt", "headSha", "prepareJobId", "applyJobId", "artifactCount",
    "historicalWorkflowBlobOid", "historicalWorkflowByteSha256",
    "historicalWorkflowSizeBytes", "historicalWorkflowPathAtHeadExact",
    "prepareFailedBeforeIntentExact", "applySkippedWithoutStepsExact",
    "writerNeverExistedOrStartedExact",
  ]) && value.workflowId === POST_Q_DEPLOYMENT_STOP_V3_WORKFLOW_ID &&
    value.workflowPath === POST_Q_DEPLOYMENT_STOP_V3_WORKFLOW_PATH &&
    value.authorizationDeadline === OLD_DEADLINE &&
    value.authorizationExpired === true && value.authorityReused === false &&
    value.runId === OLD_RUN_ID && value.runNumber === 1 && value.runAttempt === 1 &&
    value.headSha === OLD_RECOVERY_CANDIDATE_SHA &&
    value.prepareJobId === "102159216963" && value.applyJobId === "102160681336" &&
    value.artifactCount === 0 &&
    value.historicalWorkflowBlobOid === OLD_WORKFLOW_BLOB_OID &&
    value.historicalWorkflowByteSha256 === OLD_WORKFLOW_BYTE_SHA256 &&
    value.historicalWorkflowSizeBytes === OLD_WORKFLOW_SIZE_BYTES &&
    value.historicalWorkflowPathAtHeadExact === true &&
    value.prepareFailedBeforeIntentExact === true &&
    value.applySkippedWithoutStepsExact === true &&
    value.writerNeverExistedOrStartedExact === true;
}

function archivedV2Exact(value: unknown): value is Json {
  if (!record(value)) return false;
  const files = value.files;
  if (!exact(value, [
    "candidateSha", "candidateTreeSha", "candidateSoleParentSha",
    "authorityConsumed", "canonicalWorkflowRunAbsent", "files",
  ]) || value.candidateSha !== POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_SHA ||
    value.candidateTreeSha !== POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_TREE_SHA ||
    value.candidateSoleParentSha !==
      POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_PARENT_SHA ||
    value.authorityConsumed !== false ||
    value.canonicalWorkflowRunAbsent !== true || !Array.isArray(files) ||
    files.length !== V2_ARCHIVE.length) return false;
  return V2_ARCHIVE.every((expected, index) => {
    const item = files[index];
    return exact(item, ["name", "path", "blobOid", "sizeBytes", "byteSha256"]) &&
      item.name === expected[0] && item.path === expected[1] &&
      item.blobOid === expected[2] && item.sizeBytes === expected[3] &&
      item.byteSha256 === expected[4];
  });
}

function ineligibleV2Exact(value: unknown): value is Json {
  return exact(value, [
    "candidateSha", "candidateTreeSha", "candidateSoleParentSha",
    "pullRequestNumber", "reviewedPrHeadSha", "mergedAt", "workflowId",
    "workflowPath", "runId", "runNumber", "runAttempt", "checkSuiteId",
    "event", "headBranch", "status", "conclusion", "runStartedAt",
    "runCompletedAt", "failedJobId",
    "failedJobName", "failedJobStartedAt", "failedJobCompletedAt",
    "successfulBuildStepNumber", "successfulBuildStepName",
    "successfulBuildStepStatus", "successfulBuildStepConclusion",
    "successfulBuildStepStartedAt", "successfulBuildStepCompletedAt",
    "failedStepNumber", "failedStepName", "failedStepStartedAt",
    "failedStepCompletedAt", "canonicalWorkflowRunAbsent", "authorityConsumed",
    "rerunCanQualify", "archivedFilesExact", "archivedWorkflowExact",
  ]) && value.candidateSha === POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_SHA &&
    value.candidateTreeSha === POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_TREE_SHA &&
    value.candidateSoleParentSha ===
      POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_PARENT_SHA &&
    value.pullRequestNumber === 99 && value.reviewedPrHeadSha ===
      "3b844ce9e5839251552419c3610a797bd1a1f3c7" &&
    value.mergedAt === "2026-09-08T21:35:27Z" &&
    value.workflowId === 275_221_294 &&
    value.workflowPath === ".github/workflows/ci.yml" &&
    value.runId === 34_281_452_199 && value.runNumber === 563 &&
    value.runAttempt === 1 && value.checkSuiteId === 92_869_213_373 &&
    value.event === "push" && value.headBranch === "main" &&
    value.status === "completed" && value.conclusion === "failure" &&
    value.runStartedAt === "2026-09-08T21:35:31Z" &&
    value.runCompletedAt === "2026-09-08T21:43:26Z" &&
    value.failedJobId === 102_248_030_722 &&
    value.failedJobName === "build-test-scan" && value.failedStepNumber === 11 &&
    value.failedJobStartedAt === "2026-09-08T21:39:21Z" &&
    value.failedJobCompletedAt === "2026-09-08T21:43:25Z" &&
    value.successfulBuildStepNumber === 8 &&
    value.successfulBuildStepName === "Build, test, and scan" &&
    value.successfulBuildStepStatus === "completed" &&
    value.successfulBuildStepConclusion === "success" &&
    value.successfulBuildStepStartedAt === "2026-09-08T21:39:51Z" &&
    value.successfulBuildStepCompletedAt === "2026-09-08T21:43:06Z" &&
    value.failedStepName === "Dependency audit" &&
    value.failedStepStartedAt === "2026-09-08T21:43:22Z" &&
    value.failedStepCompletedAt === "2026-09-08T21:43:23Z" &&
    value.canonicalWorkflowRunAbsent === true && value.authorityConsumed === false &&
    value.rerunCanQualify === false && value.archivedFilesExact === true &&
    value.archivedWorkflowExact === true;
}

function currentWorkflowExact(value: unknown,
  expected: { readonly candidateSha: string; readonly runId: string }): boolean {
  return exact(value, [
    "workflowId", "workflowPath", "runId", "runNumber", "runAttempt",
    "headSha", "totalDispatchRuns", "currentWriterNotStartedExact",
    "solePriorRunNoWriteExact", "allWorkflowRunPagesReadExact",
    "allRunAttemptJobPagesReadExact", "freshDispatchCannotRepeatWriteExact",
  ]) && value.workflowId === POST_Q_DEPLOYMENT_STOP_V3_WORKFLOW_ID &&
    value.workflowPath === POST_Q_DEPLOYMENT_STOP_V3_WORKFLOW_PATH &&
    value.runId === expected.runId && value.runNumber === 2 &&
    value.runAttempt === 1 && value.headSha === expected.candidateSha &&
    value.totalDispatchRuns === 2 && value.currentWriterNotStartedExact === true &&
    value.solePriorRunNoWriteExact === true &&
    value.allWorkflowRunPagesReadExact === true &&
    value.allRunAttemptJobPagesReadExact === true &&
    value.freshDispatchCannotRepeatWriteExact === true;
}

export function parsePostQDeploymentStopAuthorityV3(
  source: string,
  expected: { readonly candidateSha: string; readonly runId: string },
): PostQAuthorityEvidence | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!exact(value, [
      "schemaVersion", "operation", "repository", "candidateSha",
      "currentRunId", "currentRunAttempt", "authorization", "archivedV2",
      "expiredAuthority",
      "currentWorkflow", "failedQ", "artifact", "qMutationDisposition", "checks",
      "secretMaterialIncluded", "secretDerivedCommitmentsIncluded",
    ]) || !canonical(value, source) ||
      value.schemaVersion !== POST_Q_DEPLOYMENT_STOP_AUTHORITY_V3_SCHEMA ||
      value.operation !== "post-q-deployment-stop-containment-v3" ||
      value.repository !== POST_Q_DEPLOYMENT_STOP_LOCK.repository ||
      value.candidateSha !== expected.candidateSha ||
      value.currentRunId !== expected.runId || value.currentRunAttempt !== 1 ||
      !authorizationExact(value.authorization) ||
      !archivedV2Exact(value.archivedV2) ||
      !oldNoWriteExact(value.expiredAuthority) ||
      !currentWorkflowExact(value.currentWorkflow, expected) ||
      !exact(value.failedQ, [
        "runId", "runAttempt", "workflowId", "workflowPath", "headSha",
        "conclusion", "writerAttemptedOnce", "configuredZeroReached",
        "reinterpretAsZeroAllowed",
      ]) || value.failedQ.runId !== POST_Q_DEPLOYMENT_STOP_LOCK.q.runId ||
      value.failedQ.runAttempt !== 1 || value.failedQ.workflowId !== 344_383_802 ||
      value.failedQ.workflowPath !==
        ".github/workflows/recover-permanent-staging-cold-zero.yml" ||
      value.failedQ.headSha !== POST_Q_DEPLOYMENT_STOP_LOCK.q.candidateSha ||
      value.failedQ.conclusion !== "failure" ||
      value.failedQ.writerAttemptedOnce !== true ||
      value.failedQ.configuredZeroReached !== false ||
      value.failedQ.reinterpretAsZeroAllowed !== false ||
      !exact(value.artifact, ["id", "name", "digest", "sizeBytes", "members"]) ||
      value.artifact.id !== POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId ||
      value.artifact.name !== POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactName ||
      value.artifact.digest !== POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest ||
      value.artifact.sizeBytes !== 12_561 || !Array.isArray(value.artifact.members) ||
      value.artifact.members.length !== POST_Q_DEPLOYMENT_STOP_Q_LEAVES.length ||
      !exact(value.qMutationDisposition, [
        "attempts", "retryAllowed", "acknowledgementExact",
        "configuredZeroReached", "reinterpretAsZeroAllowed",
      ]) || value.qMutationDisposition.attempts !== 1 ||
      value.qMutationDisposition.retryAllowed !== false ||
      value.qMutationDisposition.acknowledgementExact !== true ||
      value.qMutationDisposition.configuredZeroReached !== false ||
      value.qMutationDisposition.reinterpretAsZeroAllowed !== false ||
      !allTrue(value.checks, [
        "currentDispatchExact", "qRunExact", "qFourJobInventoryExact",
        "qArtifactMetadataExact", "qFiveMemberCustodyExact",
        "expiredWorkflowHistoryExact", "expiredWriterAbsentExact",
        "expiredAuthorityNotReusedExact", "successorSingleUseExact",
        "successorWriterNotStartedExact", "authorizationProvenanceExact",
        "archivedV2BytesAndBlobExact", "archivedV2CandidateIneligibleExact",
        "evidenceSecretFreeExact",
      ]) || value.secretMaterialIncluded !== false ||
      value.secretDerivedCommitmentsIncluded !== false) return null;
    for (const leaf of POST_Q_DEPLOYMENT_STOP_Q_LEAVES) {
      const matches = (value.artifact.members as unknown[]).filter((member) =>
        record(member) && member.path === leaf.relativePath);
      if (matches.length !== 1 || !exact(matches[0], [
        "path", "sizeBytes", "sha256", "sealedPath",
      ]) || matches[0].sha256 !== leaf.sha256 ||
        matches[0].sealedPath !== leaf.relativePath ||
        !Number.isSafeInteger(matches[0].sizeBytes) ||
        (matches[0].sizeBytes as number) < 1) return null;
    }
    return {
      sha256: postQSha256(source),
      currentRunId: expected.runId,
      currentRunAttempt: 1,
      totalWorkflowDispatchRuns: 2,
      priorSkippedAttemptCount: 1,
      qArtifactId: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId,
      qArtifactDigest: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest,
      singleUseAuthorityExact: true,
    };
  } catch {
    return null;
  }
}

function checksExact(value: unknown, candidateSha: string, mergedAt: string,
  runStartedAt: string): value is Json[] {
  if (!Array.isArray(value) || value.length !== REQUIRED_CHECKS.length) return false;
  const merged = Date.parse(mergedAt);
  const started = Date.parse(runStartedAt);
  return value.every((item, index) => {
    const required = REQUIRED_CHECKS[index]!;
    return exact(item, [
      "name", "runId", "checkSuiteId", "workflowId", "workflowPath", "event",
      "runAttempt", "startedAt", "completedAt",
    ]) && item.name === required[0] && item.workflowPath === required[1] &&
      item.event === "push" && item.runAttempt === 1 &&
      Number.isSafeInteger(item.runId) && (item.runId as number) > 0 &&
      Number.isSafeInteger(item.checkSuiteId) && (item.checkSuiteId as number) > 0 &&
      Number.isSafeInteger(item.workflowId) && (item.workflowId as number) > 0 &&
      timestamp(item.startedAt) && timestamp(item.completedAt) &&
      Date.parse(item.startedAt) >= merged && Date.parse(item.completedAt) >
        Date.parse(item.startedAt) && Date.parse(item.completedAt) < started &&
      SHA.test(candidateSha);
  });
}

function artifactsExact(value: unknown, checks: readonly Json[]): boolean {
  if (!Array.isArray(value) || value.length !== REQUIRED_ARTIFACTS.length) return false;
  return value.every((item, index) => {
    const required = REQUIRED_ARTIFACTS[index]!;
    const producer = checks.find((check) => check.name === required[1]);
    return exact(item, [
      "artifactId", "name", "digest", "sizeBytes", "runId", "producerCheck",
    ]) && item.name === required[0] && item.producerCheck === required[1] &&
      producer !== undefined && item.runId === producer.runId &&
      Number.isSafeInteger(item.artifactId) && (item.artifactId as number) > 0 &&
      Number.isSafeInteger(item.sizeBytes) && (item.sizeBytes as number) > 0 &&
      typeof item.digest === "string" && SHA256.test(item.digest);
  });
}

export function parsePostQDeploymentStopReviewedAuthorityV3(
  source: string,
  expected: { readonly candidateSha: string; readonly runId: string },
): ReviewedContainmentAuthorityEvidence | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!exact(value, [
      "schemaVersion", "repository", "branch", "candidateSha",
      "reviewedPullRequest", "releasePolicySha256", "successorPolicySha256",
      "directParentSha", "ineligibleV2",
      "predecessorBridge", "authorization", "deadlinePolicy",
      "currentContainmentRun", "requiredChecks", "requiredArtifacts", "checks",
      "secretMaterialIncluded", "secretDerivedCommitmentsIncluded",
    ]) || !canonical(value, source) ||
      value.schemaVersion !== POST_Q_DEPLOYMENT_STOP_REVIEWED_AUTHORITY_V3_SCHEMA ||
      value.repository !== POST_Q_DEPLOYMENT_STOP_LOCK.repository ||
      value.branch !== "main" || value.candidateSha !== expected.candidateSha ||
      value.releasePolicySha256 !== RELEASE_POLICY_SHA256 ||
      value.successorPolicySha256 !== SUCCESSOR_POLICY_SHA256 ||
      value.directParentSha !== POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_SHA ||
      !ineligibleV2Exact(value.ineligibleV2) ||
      !authorizationExact(value.authorization) || !record(value.reviewedPullRequest) ||
      !exact(value.currentContainmentRun, [
        "runId", "workflowId", "workflowPath", "runAttempt", "runStartedAt",
      ]) || value.currentContainmentRun.runId !== expected.runId ||
      value.currentContainmentRun.workflowId !==
        POST_Q_DEPLOYMENT_STOP_V3_WORKFLOW_ID ||
      value.currentContainmentRun.workflowPath !==
        POST_Q_DEPLOYMENT_STOP_V3_WORKFLOW_PATH ||
      value.currentContainmentRun.runAttempt !== 1 ||
      !timestamp(value.currentContainmentRun.runStartedAt) ||
      Date.parse(value.currentContainmentRun.runStartedAt) < Date.parse(OLD_DEADLINE) ||
      !deadlinePolicyExact(value.deadlinePolicy,
        value.reviewedPullRequest.mergedAt as string,
        value.currentContainmentRun.runStartedAt) ||
      !exact(value.predecessorBridge, [
        "candidateSha", "treeSha", "soleParentSha", "preV2CandidateSha",
        "preV2TreeSha", "preV2SoleParentSha",
        "recoveryCandidateSha", "recoveryTreeSha", "recoverySoleParentSha",
        "preV2PullRequestNumber", "preV2ReviewedPrHeadSha",
        "preV2MergeCommitSha", "preV2BaseSha", "preV2MergedAt",
        "preV2GithubMergeExact", "preV2ReviewedTreeExact",
        "linearHistoryExact",
      ]) || value.predecessorBridge.candidateSha !==
        POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_SHA ||
      value.predecessorBridge.treeSha !==
        POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_TREE_SHA ||
      value.predecessorBridge.soleParentSha !==
        POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_PARENT_SHA ||
      value.predecessorBridge.preV2CandidateSha !==
        POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_PARENT_SHA ||
      value.predecessorBridge.preV2TreeSha !== PRE_V2_CANDIDATE_TREE_SHA ||
      value.predecessorBridge.preV2SoleParentSha !==
        OLD_RECOVERY_CANDIDATE_SHA ||
      value.predecessorBridge.recoveryCandidateSha !==
        OLD_RECOVERY_CANDIDATE_SHA ||
      value.predecessorBridge.recoveryTreeSha !== OLD_RECOVERY_TREE_SHA ||
      value.predecessorBridge.recoverySoleParentSha !==
        POST_Q_DEPLOYMENT_STOP_LOCK.q.candidateSha ||
      value.predecessorBridge.preV2PullRequestNumber !== 98 ||
      value.predecessorBridge.preV2ReviewedPrHeadSha !==
        "3ab064f5026a923b42bf67dbd94cb5d16f125c0d" ||
      value.predecessorBridge.preV2MergeCommitSha !==
        POST_Q_DEPLOYMENT_STOP_V3_DIRECT_PARENT_PARENT_SHA ||
      value.predecessorBridge.preV2BaseSha !== OLD_RECOVERY_CANDIDATE_SHA ||
      value.predecessorBridge.preV2MergedAt !== "2026-09-08T18:23:44Z" ||
      !timestamp(value.reviewedPullRequest.mergedAt) ||
      Date.parse(value.reviewedPullRequest.mergedAt) <=
        Date.parse(value.ineligibleV2.runCompletedAt as string) ||
      value.predecessorBridge.preV2GithubMergeExact !== true ||
      value.predecessorBridge.preV2ReviewedTreeExact !== true ||
      value.predecessorBridge.linearHistoryExact !== true ||
      !exact(value.reviewedPullRequest, [
        "number", "reviewedPrHeadSha", "mergeCommitSha", "treeSha", "mergedAt",
        "authorId", "mergedById", "githubMergeExact", "reviewedTreeExact",
        "pullRequestApprovalRequirement", "pullRequestApprovalRequirementExact",
        "linearHistoryExact",
      ]) || value.reviewedPullRequest.mergeCommitSha !== expected.candidateSha ||
      typeof value.reviewedPullRequest.reviewedPrHeadSha !== "string" ||
      !SHA.test(value.reviewedPullRequest.reviewedPrHeadSha) ||
      typeof value.reviewedPullRequest.treeSha !== "string" ||
      !SHA.test(value.reviewedPullRequest.treeSha) ||
      !Number.isSafeInteger(value.reviewedPullRequest.number) ||
      (value.reviewedPullRequest.number as number) <= 99 ||
      !Number.isSafeInteger(value.reviewedPullRequest.authorId) ||
      !Number.isSafeInteger(value.reviewedPullRequest.mergedById) ||
      value.reviewedPullRequest.pullRequestApprovalRequirement !== "not_required" ||
      value.reviewedPullRequest.githubMergeExact !== true ||
      value.reviewedPullRequest.reviewedTreeExact !== true ||
      value.reviewedPullRequest.pullRequestApprovalRequirementExact !== true ||
      value.reviewedPullRequest.linearHistoryExact !== true ||
      !checksExact(value.requiredChecks, expected.candidateSha,
        value.reviewedPullRequest.mergedAt, value.currentContainmentRun.runStartedAt) ||
      !artifactsExact(value.requiredArtifacts, value.requiredChecks as Json[]) ||
      !allTrue(value.checks, [
        "mergedPullRequestAndTreeExact", "soleParentSquashShapeExact",
        "directParentExact", "ineligibleV2Attempt1Exact",
        "archivedV2BytesAndBlobExact", "predecessorBridgeExact",
        "currentMainTipExact",
        "noLaterMainDriftExact", "baseRequiredCheckLineageExact",
        "baseRequiredArtifactsExact", "chronologyExact", "deadlineDerivedExact",
        "authorizationProvenanceExact", "expiredAuthorityNotReusedExact",
      ]) || value.secretMaterialIncluded !== false ||
      value.secretDerivedCommitmentsIncluded !== false) return null;
    const deadline = derivePostQDeploymentStopV3Deadline(
      value.reviewedPullRequest.mergedAt as string,
      value.currentContainmentRun.runStartedAt,
    );
    if (deadline === null || value.deadlinePolicy.derivedDeadline !== deadline) {
      return null;
    }
    return {
      sha256: postQSha256(source),
      candidateSha: expected.candidateSha,
      reviewedPrHeadSha: value.reviewedPullRequest.reviewedPrHeadSha,
      reviewedPullRequestNumber: value.reviewedPullRequest.number as number,
      reviewedPullRequestMergedAt: value.reviewedPullRequest.mergedAt as string,
      authorizationDeadline: deadline,
      workflowRunStartedAt: value.currentContainmentRun.runStartedAt,
      workflowRunId: expected.runId,
      workflowRunAttempt: 1,
      reviewedAuthorityExact: true,
      freshDispatchWriteGuardExact: true,
    };
  } catch {
    return null;
  }
}

export function postQDeploymentStopV3DeadlineExact(
  authority: ReviewedContainmentAuthorityEvidence,
  nowMs: number,
): boolean {
  if (authority.workflowRunStartedAt === undefined || !Number.isFinite(nowMs)) {
    return false;
  }
  const derived = derivePostQDeploymentStopV3Deadline(
    authority.reviewedPullRequestMergedAt,
    authority.workflowRunStartedAt,
  );
  return derived !== null && authority.authorizationDeadline === derived &&
    nowMs < Date.parse(derived);
}

export function postQDeploymentStopV3ConfirmationExact(
  candidateSha: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION ===
      "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN" &&
    env.PINTPATH_POST_Q_DEPLOYMENT_STOP_V3_AUTHORIZATION_ID ===
      POST_Q_DEPLOYMENT_STOP_V3_AUTHORIZATION_ID &&
    env.PINTPATH_POST_Q_DEPLOYMENT_STOP_V3_AUTHORIZATION_SOURCE_SHA256 ===
      POST_Q_DEPLOYMENT_STOP_V3_AUTHORIZATION_SOURCE_SHA256 &&
    env.PINTPATH_POST_Q_DEPLOYMENT_STOP_CONFIRMATION ===
      `${POST_Q_DEPLOYMENT_STOP_V3_CONFIRMATION_PREFIX}${candidateSha}` +
      POST_Q_DEPLOYMENT_STOP_V3_CONFIRMATION_SUFFIX;
}
