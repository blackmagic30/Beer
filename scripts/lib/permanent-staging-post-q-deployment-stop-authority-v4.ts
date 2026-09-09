import {
  POST_Q_DEPLOYMENT_STOP_LOCK,
  POST_Q_DEPLOYMENT_STOP_Q_LEAVES,
  postQSha256,
  type PostQAuthorityEvidence,
  type ReviewedContainmentAuthorityEvidence,
} from "./permanent-staging-post-q-deployment-stop.js";

export const POST_Q_DEPLOYMENT_STOP_AUTHORITY_V4_SCHEMA =
  "pintpath-permanent-staging-post-q-authority/v4" as const;
export const POST_Q_DEPLOYMENT_STOP_REVIEWED_AUTHORITY_V4_SCHEMA =
  "pintpath-permanent-staging-post-q-reviewed-candidate-authority/v4" as const;
export const POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_ID =
  "pintpath-post-q-staging-stop-reauthorization-2026-09-09/v4" as const;
export const POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_THREAD_ID =
  "01a0840a-3590-74d1-9567-0e9eec01a9a4" as const;
export const POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_SOURCE_SHA256 =
  "ccaf9c49e38f97368f6187d7c3ff1c853cffe8334fdfaf3478835c7e93f4028c" as const;
export const POST_Q_DEPLOYMENT_STOP_V4_EXPLICIT_EXPIRY =
  "2026-09-10T08:00:00.000Z" as const;
export const POST_Q_DEPLOYMENT_STOP_V4_DIRECT_PARENT_SHA =
  "c6f0f66302a96086c5a60962224af739050e8ff1" as const;
export const POST_Q_DEPLOYMENT_STOP_V4_DIRECT_PARENT_TREE_SHA =
  "73028c14f816ed9599606add3d131a25737db2d2" as const;
export const POST_Q_DEPLOYMENT_STOP_V4_DIRECT_PARENT_PARENT_SHA =
  "78162cf42a0ef3190343a657ff94f288d4a4c7ca" as const;
const V2_CANDIDATE_SHA =
  "78162cf42a0ef3190343a657ff94f288d4a4c7ca" as const;
const V2_CANDIDATE_TREE_SHA =
  "410fd437bb0c459049f08bbff63ee605f2e65c9e" as const;
const V2_CANDIDATE_PARENT_SHA =
  "d27275f4c101b764c6016e8b378969c14719258e" as const;
export const POST_Q_DEPLOYMENT_STOP_V4_WORKFLOW_ID = 353_312_302 as const;
export const POST_Q_DEPLOYMENT_STOP_V4_WORKFLOW_PATH =
  ".github/workflows/stop-permanent-staging-post-q-deployment.yml" as const;
export const POST_Q_DEPLOYMENT_STOP_V4_CONFIRMATION_PREFIX =
  "REAUTHORIZE_ONE_STAGING_DEPLOYMENT_STOP_6300A324_9407_4B1C_B651_749C47E9537F_FOR_" as const;
export const POST_Q_DEPLOYMENT_STOP_V4_CONFIRMATION_SUFFIX =
  "_UNDER_V4_FROM_01A0840A_3590_74D1_9567_0E9EEC01A9A4" as const;

const RELEASE_POLICY_SHA256 =
  "4aaedd863d08e539e1628db5d14557cc23531a0c6d586ffb25acebcba7907e90";
const SUCCESSOR_POLICY_SHA256 =
  "5d1b8d898cf81b70cd53af57be869ba16f5ffe30de2b53e2a4ed1bc6afd09048";
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
const V3_ARCHIVE = Object.freeze([
  Object.freeze(["authorization",
    "ops/railway/permanent-staging-post-q-deployment-stop-authorization-v3.json",
    "6ea9e73897003e915329b9ff6cc33b13014de82d", 394,
    "d2c7b4c9d700a1d7c5219dd6c4245d5900154421497b8c637ac93f9215662549"]),
  Object.freeze(["policy",
    "ops/railway/permanent-staging-post-q-deployment-stop-policy-v3.json",
    "b64b40375dc978c9a6df0d28bad3abc1d105bf51", 10_991,
    "e7c0adec553e42e28ff2ae877835aa3255cfaa2ee8584f64c08ebe7983d901dd"]),
  Object.freeze(["verifier",
    "scripts/verify-permanent-staging-post-q-authority-v3.mjs",
    "8dd01f7a22ea19baea752bd6295597cda47e46a9", 75_418,
    "0d6a2c0bf2edd32a7836705639aef37877b9cd735261213168116da072200205"]),
  Object.freeze(["authorityLibrary",
    "scripts/lib/permanent-staging-post-q-deployment-stop-authority-v3.ts",
    "b4a3cabda3f5689a1810abb07037cf354230bfb0", 29_934,
    "77071cdeb3d637012eb3b2afc24d4e4d70832c6343c4f8c91d61dcffd2b720fd"]),
  Object.freeze(["executor",
    "scripts/execute-protected-permanent-staging-post-q-deployment-stop-v3.ts",
    "de4e2858e48f599fe4ed3ec83ffc4f7e6aa1dba7", 987,
    "39bdc2fb9fa62adc21e8b41d54a59dbe1d0431d5e6a1fdb78649baf3b767508a"]),
  Object.freeze(["canonicalWorkflow",
    ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
    "a604248b6feb925887d3a331af7ae15007408c46", 30_062,
    "b0ccb3f5387188edbad24e4b136becc4ead63436a9753db1d5d056e177ab4bad"]),
] as const);
const FAILED_V3_RUN_ID = "34304764597" as const;
const FAILED_V3_INTENT_MEMBER = Object.freeze({
  path: "stop-intent.json",
  sizeBytes: 5_245,
  sha256:
    "f51921b2dca554008c2e569abb04e2ba6b562d9b1e9f724264a29b3d72a96d1d",
  sealedPath: "stop-intent.json",
});
const FAILED_V3_EVIDENCE_MEMBER = Object.freeze({
  path: "boundary-postflight.json",
  sizeBytes: 754,
  sha256:
    "827bc8f797062b613038ae5d6f5c24c9489f50d3beb889d55e92c5593b9bc742",
  sealedPath: "boundary-postflight.json",
});

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

export function derivePostQDeploymentStopV4Deadline(
  pullRequestMergedAt: string,
  runStartedAt: string,
): string | null {
  if (!timestamp(pullRequestMergedAt) || !timestamp(runStartedAt)) return null;
  const merged = Date.parse(pullRequestMergedAt);
  const started = Date.parse(runStartedAt);
  const explicit = Date.parse(POST_Q_DEPLOYMENT_STOP_V4_EXPLICIT_EXPIRY);
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
  ]) && value.authorizationId === POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_ID &&
    value.sourceThreadId === POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_THREAD_ID &&
    value.sourceSchemaVersion ===
      "pintpath-reviewed-user-authorization-provenance/v2" &&
    value.sourceSha256 === POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_SOURCE_SHA256 &&
    value.sourceSizeBytes === 613 &&
    value.sourceSerialization === "JSON.stringify(value,null,2)+LF" &&
    value.messagesExact === true && value.provenanceUse ===
      "pintpath-post-q-staging-stop-successor-v4-reviewed-context" &&
    value.reviewedProvenanceOnly === true &&
    value.cryptographicUserSignatureClaimed === false &&
    value.secretMaterialIncluded === false &&
    value.secretDerivedCommitmentsIncluded === false;
}

function deadlinePolicyExact(value: unknown, mergedAt: string,
  runStartedAt: string): value is Json {
  const derived = derivePostQDeploymentStopV4Deadline(mergedAt, runStartedAt);
  return derived !== null && exact(value, [
    "explicitExpiry", "maximumAfterPullRequestMergeSeconds",
    "maximumAfterRunStartSeconds", "derivedDeadline",
    "derivation", "rederiveImmediatelyBeforeWriter",
    "expirySuppressesPostWriteReconciliation", "expirySuppressesFinalization",
  ]) && value.explicitExpiry === POST_Q_DEPLOYMENT_STOP_V4_EXPLICIT_EXPIRY &&
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
  ]) && value.workflowId === POST_Q_DEPLOYMENT_STOP_V4_WORKFLOW_ID &&
    value.workflowPath === POST_Q_DEPLOYMENT_STOP_V4_WORKFLOW_PATH &&
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
  ]) || value.candidateSha !== V2_CANDIDATE_SHA ||
    value.candidateTreeSha !== V2_CANDIDATE_TREE_SHA ||
    value.candidateSoleParentSha !== V2_CANDIDATE_PARENT_SHA ||
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

function archivedV3Exact(value: unknown): value is Json {
  if (!exact(value, [
    "candidateSha", "candidateTreeSha", "candidateSoleParentSha",
    "runId", "runNumber", "runAttempt", "workflowId", "workflowPath",
    "checkSuiteId", "prepareJobId", "applyJobId", "failedStepNumber",
    "failedStepName", "writerStepNumber", "writerStepName",
    "writerNeverStartedExact", "deploymentStopAttempts",
    "productionMutationForbiddenExact", "artifacts", "files",
    "authorityConsumed", "deploymentStopAuthorityConsumed",
    "canonicalRun3SuccessorRequired", "downloadedMembers",
    "artifactBytesExact",
  ])) return false;
  const files = value.files;
  const artifacts = value.artifacts;
  const downloadedMembers = value.downloadedMembers;
  if (value.candidateSha !== POST_Q_DEPLOYMENT_STOP_V4_DIRECT_PARENT_SHA ||
    value.candidateTreeSha !== POST_Q_DEPLOYMENT_STOP_V4_DIRECT_PARENT_TREE_SHA ||
    value.candidateSoleParentSha !==
      POST_Q_DEPLOYMENT_STOP_V4_DIRECT_PARENT_PARENT_SHA ||
    value.runId !== FAILED_V3_RUN_ID || value.runNumber !== 2 ||
    value.runAttempt !== 1 ||
    value.workflowId !== POST_Q_DEPLOYMENT_STOP_V4_WORKFLOW_ID ||
    value.workflowPath !== POST_Q_DEPLOYMENT_STOP_V4_WORKFLOW_PATH ||
    value.checkSuiteId !== 92_929_472_980 ||
    value.prepareJobId !== "102319052311" ||
    value.applyJobId !== "102319762173" ||
    value.failedStepNumber !== 9 ||
    value.failedStepName !== "Reauthenticate the exact failed Q run and artifact" ||
    value.writerStepNumber !== 15 ||
    value.writerStepName !== "Stop the exact accidental staging deployment once" ||
    value.writerNeverStartedExact !== true || value.deploymentStopAttempts !== 0 ||
    value.productionMutationForbiddenExact !== true ||
    value.authorityConsumed !== true ||
    value.deploymentStopAuthorityConsumed !== false ||
    value.canonicalRun3SuccessorRequired !== true ||
    value.artifactBytesExact !== true || !Array.isArray(files) ||
    files.length !== V3_ARCHIVE.length || !Array.isArray(artifacts) ||
    artifacts.length !== 2 || !Array.isArray(downloadedMembers) ||
    downloadedMembers.length !== 2) return false;
  if (!V3_ARCHIVE.every((expected, index) => {
    const item = files[index];
    return exact(item, ["name", "path", "blobOid", "sizeBytes", "byteSha256"]) &&
      item.name === expected[0] && item.path === expected[1] &&
      item.blobOid === expected[2] && item.sizeBytes === expected[3] &&
      item.byteSha256 === expected[4];
  })) return false;
  const expectedArtifacts = [
    {
      id: "10086316260",
      name:
        `pintpath-permanent-staging-post-q-deployment-stop-intent-${POST_Q_DEPLOYMENT_STOP_V4_DIRECT_PARENT_SHA}-${FAILED_V3_RUN_ID}`,
      digest:
        "sha256:e6882bd5bd659f2d95de84a8163be011722a96802b3a08a2e8eea4216fdd8766",
      sizeBytes: 2_507,
      createdAt: "2026-09-09T02:53:43Z",
      updatedAt: "2026-09-09T02:53:43Z",
      expiresAt: "2026-10-09T02:53:42Z",
      member: FAILED_V3_INTENT_MEMBER,
    },
    {
      id: "10086412037",
      name:
        `pintpath-permanent-staging-post-q-deployment-stop-${POST_Q_DEPLOYMENT_STOP_V4_DIRECT_PARENT_SHA}-${FAILED_V3_RUN_ID}`,
      digest:
        "sha256:49c92825d47b7c90b3aba605c12b9643990c9091b7b6dac0d207fb57e665d4eb",
      sizeBytes: 471,
      createdAt: "2026-09-09T02:58:06Z",
      updatedAt: "2026-09-09T02:58:06Z",
      expiresAt: "2026-10-09T02:58:06Z",
      member: FAILED_V3_EVIDENCE_MEMBER,
    },
  ];
  return expectedArtifacts.every((expected, index) => {
    const artifact = artifacts[index];
    const member = artifact?.member;
    const downloaded = downloadedMembers[index];
    const memberWithoutSealedPath = {
      path: expected.member.path,
      sizeBytes: expected.member.sizeBytes,
      sha256: expected.member.sha256,
    };
    return exact(artifact, [
      "id", "name", "digest", "sizeBytes", "createdAt", "updatedAt",
      "expiresAt", "member",
    ]) && artifact.id === expected.id && artifact.name === expected.name &&
      artifact.digest === expected.digest && artifact.sizeBytes === expected.sizeBytes &&
      artifact.createdAt === expected.createdAt &&
      artifact.updatedAt === expected.updatedAt &&
      artifact.expiresAt === expected.expiresAt &&
      JSON.stringify(member) === JSON.stringify(memberWithoutSealedPath) &&
      JSON.stringify(downloaded) === JSON.stringify(expected.member);
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
  ]) && value.candidateSha === V2_CANDIDATE_SHA &&
    value.candidateTreeSha === V2_CANDIDATE_TREE_SHA &&
    value.candidateSoleParentSha === V2_CANDIDATE_PARENT_SHA &&
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
    "allPriorRunsNoWriteExact",
    "exactFailedV3PrewriterRunArchived", "allWorkflowRunPagesReadExact",
    "allRunAttemptJobPagesReadExact", "freshDispatchCannotRepeatWriteExact",
  ]) && value.workflowId === POST_Q_DEPLOYMENT_STOP_V4_WORKFLOW_ID &&
    value.workflowPath === POST_Q_DEPLOYMENT_STOP_V4_WORKFLOW_PATH &&
    value.runId === expected.runId && value.runNumber === 3 &&
    value.runAttempt === 1 && value.headSha === expected.candidateSha &&
    value.totalDispatchRuns === 3 && value.currentWriterNotStartedExact === true &&
    value.allPriorRunsNoWriteExact === true &&
    value.exactFailedV3PrewriterRunArchived === true &&
    value.allWorkflowRunPagesReadExact === true &&
    value.allRunAttemptJobPagesReadExact === true &&
    value.freshDispatchCannotRepeatWriteExact === true;
}

export function parsePostQDeploymentStopAuthorityV4(
  source: string,
  expected: { readonly candidateSha: string; readonly runId: string },
): PostQAuthorityEvidence | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!exact(value, [
      "schemaVersion", "operation", "repository", "candidateSha",
      "currentRunId", "currentRunAttempt", "authorization", "archivedV2",
      "archivedV3", "expiredAuthority",
      "currentWorkflow", "failedQ", "artifact", "qMutationDisposition", "checks",
      "secretMaterialIncluded", "secretDerivedCommitmentsIncluded",
    ]) || !canonical(value, source) ||
      value.schemaVersion !== POST_Q_DEPLOYMENT_STOP_AUTHORITY_V4_SCHEMA ||
      value.operation !== "post-q-deployment-stop-containment-v4" ||
      value.repository !== POST_Q_DEPLOYMENT_STOP_LOCK.repository ||
      value.candidateSha !== expected.candidateSha ||
      value.currentRunId !== expected.runId || value.currentRunAttempt !== 1 ||
      !authorizationExact(value.authorization) ||
      !archivedV2Exact(value.archivedV2) ||
      !archivedV3Exact(value.archivedV3) ||
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
        "archivedV3BytesAndBlobExact", "archivedV3RunAndJobsExact",
        "archivedV3ArtifactsAndMembersExact",
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
      totalWorkflowDispatchRuns: 3,
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

export function parsePostQDeploymentStopReviewedAuthorityV4(
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
      value.schemaVersion !== POST_Q_DEPLOYMENT_STOP_REVIEWED_AUTHORITY_V4_SCHEMA ||
      value.repository !== POST_Q_DEPLOYMENT_STOP_LOCK.repository ||
      value.branch !== "main" || value.candidateSha !== expected.candidateSha ||
      value.releasePolicySha256 !== RELEASE_POLICY_SHA256 ||
      value.successorPolicySha256 !== SUCCESSOR_POLICY_SHA256 ||
      value.directParentSha !== POST_Q_DEPLOYMENT_STOP_V4_DIRECT_PARENT_SHA ||
      !ineligibleV2Exact(value.ineligibleV2) ||
      !authorizationExact(value.authorization) || !record(value.reviewedPullRequest) ||
      !exact(value.currentContainmentRun, [
        "runId", "workflowId", "workflowPath", "runAttempt", "runStartedAt",
      ]) || value.currentContainmentRun.runId !== expected.runId ||
      value.currentContainmentRun.workflowId !==
        POST_Q_DEPLOYMENT_STOP_V4_WORKFLOW_ID ||
      value.currentContainmentRun.workflowPath !==
        POST_Q_DEPLOYMENT_STOP_V4_WORKFLOW_PATH ||
      value.currentContainmentRun.runAttempt !== 1 ||
      !timestamp(value.currentContainmentRun.runStartedAt) ||
      Date.parse(value.currentContainmentRun.runStartedAt) < Date.parse(OLD_DEADLINE) ||
      !deadlinePolicyExact(value.deadlinePolicy,
        value.reviewedPullRequest.mergedAt as string,
        value.currentContainmentRun.runStartedAt) ||
      !exact(value.predecessorBridge, [
        "candidateSha", "treeSha", "soleParentSha", "preV2CandidateSha",
        "v2CandidateSha", "v2TreeSha", "v2SoleParentSha",
        "preV2TreeSha", "preV2SoleParentSha",
        "recoveryCandidateSha", "recoveryTreeSha", "recoverySoleParentSha",
        "preV2PullRequestNumber", "preV2ReviewedPrHeadSha",
        "preV2MergeCommitSha", "preV2BaseSha", "preV2MergedAt",
        "preV2GithubMergeExact", "preV2ReviewedTreeExact",
        "linearHistoryExact",
      ]) || value.predecessorBridge.candidateSha !==
        POST_Q_DEPLOYMENT_STOP_V4_DIRECT_PARENT_SHA ||
      value.predecessorBridge.treeSha !==
        POST_Q_DEPLOYMENT_STOP_V4_DIRECT_PARENT_TREE_SHA ||
      value.predecessorBridge.soleParentSha !==
        POST_Q_DEPLOYMENT_STOP_V4_DIRECT_PARENT_PARENT_SHA ||
      value.predecessorBridge.v2CandidateSha !== V2_CANDIDATE_SHA ||
      value.predecessorBridge.v2TreeSha !== V2_CANDIDATE_TREE_SHA ||
      value.predecessorBridge.v2SoleParentSha !== V2_CANDIDATE_PARENT_SHA ||
      value.predecessorBridge.preV2CandidateSha !== V2_CANDIDATE_PARENT_SHA ||
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
        V2_CANDIDATE_PARENT_SHA ||
      value.predecessorBridge.preV2BaseSha !== OLD_RECOVERY_CANDIDATE_SHA ||
      value.predecessorBridge.preV2MergedAt !== "2026-09-08T18:23:44Z" ||
      !timestamp(value.reviewedPullRequest.mergedAt) ||
      Date.parse(value.reviewedPullRequest.mergedAt) <=
        Date.parse(value.ineligibleV2.runCompletedAt as string) ||
      Date.parse(value.reviewedPullRequest.mergedAt) <=
        Date.parse("2026-09-09T02:58:09Z") ||
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
      (value.reviewedPullRequest.number as number) <= 102 ||
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
        "archivedV2BytesAndBlobExact", "archivedV3BytesAndBlobExact",
        "archivedV3RunCompletedBeforeMergeExact", "predecessorBridgeExact",
        "currentMainTipExact",
        "noLaterMainDriftExact", "baseRequiredCheckLineageExact",
        "baseRequiredArtifactsExact", "chronologyExact", "deadlineDerivedExact",
        "authorizationProvenanceExact", "expiredAuthorityNotReusedExact",
      ]) || value.secretMaterialIncluded !== false ||
      value.secretDerivedCommitmentsIncluded !== false) return null;
    const deadline = derivePostQDeploymentStopV4Deadline(
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

export function postQDeploymentStopV4DeadlineExact(
  authority: ReviewedContainmentAuthorityEvidence,
  nowMs: number,
): boolean {
  if (authority.workflowRunStartedAt === undefined || !Number.isFinite(nowMs)) {
    return false;
  }
  const derived = derivePostQDeploymentStopV4Deadline(
    authority.reviewedPullRequestMergedAt,
    authority.workflowRunStartedAt,
  );
  return derived !== null && authority.authorizationDeadline === derived &&
    nowMs < Date.parse(derived);
}

export function postQDeploymentStopV4ConfirmationExact(
  candidateSha: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION ===
      "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN" &&
    env.PINTPATH_POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_ID ===
      POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_ID &&
    env.PINTPATH_POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_SOURCE_SHA256 ===
      POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_SOURCE_SHA256 &&
    env.PINTPATH_POST_Q_DEPLOYMENT_STOP_CONFIRMATION ===
      `${POST_Q_DEPLOYMENT_STOP_V4_CONFIRMATION_PREFIX}${candidateSha}` +
      POST_Q_DEPLOYMENT_STOP_V4_CONFIRMATION_SUFFIX;
}
