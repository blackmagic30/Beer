#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  githubGet as releaseGithubGet,
  parseGithubReleaseChecksPolicy,
  selectArtifact,
  selectCheckRunCandidates,
  validateWorkflowRun,
  verifyReviewedPullRequest,
} from "./verify-github-release-candidate.mjs";

export const POST_Q_AUTHORITY_V4_SCHEMA =
  "pintpath-permanent-staging-post-q-authority/v4";
export const POST_Q_REVIEWED_CANDIDATE_V4_SCHEMA =
  "pintpath-permanent-staging-post-q-reviewed-candidate-authority/v4";

const RELEASE_POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.github/release-required-checks.json",
);
const AUTHORIZATION_SOURCE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../ops/railway/permanent-staging-post-q-deployment-stop-authorization-v4.json",
);
const SUCCESSOR_POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../ops/railway/permanent-staging-post-q-deployment-stop-policy-v4.json",
);

const REPOSITORY = "blackmagic30/Beer";
const REPOSITORY_ID = 1215862300;
const Q_RUN_ID = "34229745722";
const Q_WORKFLOW_ID = 344383802;
const Q_RUN_NUMBER = 13;
const Q_HEAD_SHA = "606d33facb515dd10bc94c360e43c20beb999cc1";
const EXPIRED_RUN_HEAD_SHA =
  "f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7";
const EXPIRED_RUN_HEAD_TREE_SHA =
  "9978dca9491f7bf7bee77ce39debe1f713e89c53";
const SUCCESSOR_DIRECT_PARENT_SHA =
  "c6f0f66302a96086c5a60962224af739050e8ff1";
const SUCCESSOR_DIRECT_PARENT_TREE_SHA =
  "73028c14f816ed9599606add3d131a25737db2d2";
const SUCCESSOR_DIRECT_PARENT_PARENT_SHA =
  "78162cf42a0ef3190343a657ff94f288d4a4c7ca";
const V2_CANDIDATE_SHA =
  "78162cf42a0ef3190343a657ff94f288d4a4c7ca";
const V2_CANDIDATE_TREE_SHA =
  "410fd437bb0c459049f08bbff63ee605f2e65c9e";
const V2_CANDIDATE_PARENT_SHA =
  "d27275f4c101b764c6016e8b378969c14719258e";
const PRE_V2_CANDIDATE_TREE_SHA =
  "53808bdd995a6ff1d2204e01f7639b103dbd5a76";
const EXPIRED_AUTHORITY_DEADLINE = "2026-09-08T18:57:20.000Z";
const SUCCESSOR_EXPLICIT_EXPIRY = "2026-09-10T08:00:00.000Z";
const SUCCESSOR_AUTHORIZATION_ID =
  "pintpath-post-q-staging-stop-reauthorization-2026-09-09/v4";
const SUCCESSOR_AUTHORIZATION_THREAD_ID =
  "01a0840a-3590-74d1-9567-0e9eec01a9a4";
const SUCCESSOR_AUTHORIZATION_SOURCE_SCHEMA =
  "pintpath-reviewed-user-authorization-provenance/v2";
const SUCCESSOR_AUTHORIZATION_SOURCE_SHA256 =
  "ccaf9c49e38f97368f6187d7c3ff1c853cffe8334fdfaf3478835c7e93f4028c";
const SUCCESSOR_AUTHORIZATION_SOURCE_SIZE_BYTES = 613;
const SUCCESSOR_POLICY_SHA256 =
  "5d1b8d898cf81b70cd53af57be869ba16f5ffe30de2b53e2a4ed1bc6afd09048";
const SUCCESSOR_AUTHORIZATION_MESSAGES = Object.freeze([
  "Codex was running for multiple days on two prompts and I had no clue what it did I just stopped them recently because they were eatting away at tokens and the logs were massive. Can you check what they had done, finish of what they were currently working on so there’s no error in the code or bug and tell me what it was doing",
]);
const EXPIRED_WORKFLOW_BLOB_OID =
  "0d5efadc53101ae6631e25bbff7c804a30faa672";
const EXPIRED_WORKFLOW_BYTE_SHA256 =
  "6a452880ccbe3d80d9d771b4aae7bd3be2bcf26beac7dee1af91d0c705e7a9a8";
const EXPIRED_WORKFLOW_SIZE_BYTES = 28_866;
const V2_ARCHIVE = Object.freeze({
  authorization: Object.freeze({
    path: "ops/railway/permanent-staging-post-q-deployment-stop-authorization-v2.json",
    blobOid: "69a56dfcd32afaaef2998884ba7df6051dc8b67e",
    sizeBytes: 267,
    byteSha256:
      "4203affc634766c1ba695c969448d8c126552d1c16ffb090e2a55d5f319a0779",
  }),
  policy: Object.freeze({
    path: "ops/railway/permanent-staging-post-q-deployment-stop-policy-v2.json",
    blobOid: "4f2b1447129bf73788d16f6c37057d89e392a520",
    sizeBytes: 6141,
    byteSha256:
      "5f4c4bc20c8ef68ed77f51ad92a11cede00122e3274e4408eb8ea858d6a07e4b",
  }),
  verifier: Object.freeze({
    path: "scripts/verify-permanent-staging-post-q-authority-v2.mjs",
    blobOid: "306c9536ebd320205542072474959ff67c2738e9",
    sizeBytes: 56_752,
    byteSha256:
      "50eccd00ae5059568da11421d75546ed4691ab30399d8bb6a36a2c626cc3105f",
  }),
  authorityLibrary: Object.freeze({
    path: "scripts/lib/permanent-staging-post-q-deployment-stop-authority-v2.ts",
    blobOid: "b16a9ee516d64e67d8ccdf566f2148334e0626ba",
    sizeBytes: 23_328,
    byteSha256:
      "412890199755cc95f9f69cd9c6ca15d1b16716b1f3c12fcefed5102e665a9389",
  }),
  executor: Object.freeze({
    path: "scripts/execute-protected-permanent-staging-post-q-deployment-stop-v2.ts",
    blobOid: "e8696a21e3f6b5124acf3d91fcd692a9b87e2902",
    sizeBytes: 987,
    byteSha256:
      "4b4b41cb81e18862c6b340d2e78e0a940f9c41c2396cc38d77af8b8808f87b87",
  }),
  canonicalWorkflow: Object.freeze({
    path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
    blobOid: "6633205b7fdf36edae8986d6fa08c9a48e8a95c9",
    sizeBytes: 30_062,
    byteSha256:
      "712cca911de33b915defb3939dedd95a6c53a57e03e7e596d009437071d7ada5",
  }),
});
const V3_ARCHIVE = Object.freeze({
  authorization: Object.freeze({
    path: "ops/railway/permanent-staging-post-q-deployment-stop-authorization-v3.json",
    blobOid: "6ea9e73897003e915329b9ff6cc33b13014de82d",
    sizeBytes: 394,
    byteSha256:
      "d2c7b4c9d700a1d7c5219dd6c4245d5900154421497b8c637ac93f9215662549",
  }),
  policy: Object.freeze({
    path: "ops/railway/permanent-staging-post-q-deployment-stop-policy-v3.json",
    blobOid: "b64b40375dc978c9a6df0d28bad3abc1d105bf51",
    sizeBytes: 10_991,
    byteSha256:
      "e7c0adec553e42e28ff2ae877835aa3255cfaa2ee8584f64c08ebe7983d901dd",
  }),
  verifier: Object.freeze({
    path: "scripts/verify-permanent-staging-post-q-authority-v3.mjs",
    blobOid: "8dd01f7a22ea19baea752bd6295597cda47e46a9",
    sizeBytes: 75_418,
    byteSha256:
      "0d6a2c0bf2edd32a7836705639aef37877b9cd735261213168116da072200205",
  }),
  authorityLibrary: Object.freeze({
    path: "scripts/lib/permanent-staging-post-q-deployment-stop-authority-v3.ts",
    blobOid: "b4a3cabda3f5689a1810abb07037cf354230bfb0",
    sizeBytes: 29_934,
    byteSha256:
      "77071cdeb3d637012eb3b2afc24d4e4d70832c6343c4f8c91d61dcffd2b720fd",
  }),
  executor: Object.freeze({
    path: "scripts/execute-protected-permanent-staging-post-q-deployment-stop-v3.ts",
    blobOid: "de4e2858e48f599fe4ed3ec83ffc4f7e6aa1dba7",
    sizeBytes: 987,
    byteSha256:
      "39bdc2fb9fa62adc21e8b41d54a59dbe1d0431d5e6a1fdb78649baf3b767508a",
  }),
  canonicalWorkflow: Object.freeze({
    path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
    blobOid: "a604248b6feb925887d3a331af7ae15007408c46",
    sizeBytes: 30_062,
    byteSha256:
      "b0ccb3f5387188edbad24e4b136becc4ead63436a9753db1d5d056e177ab4bad",
  }),
});
const INELIGIBLE_V2_RUN = Object.freeze({
  candidateSha: V2_CANDIDATE_SHA,
  candidateTreeSha: V2_CANDIDATE_TREE_SHA,
  candidateSoleParentSha: V2_CANDIDATE_PARENT_SHA,
  pullRequestNumber: 99,
  reviewedHeadSha: "3b844ce9e5839251552419c3610a797bd1a1f3c7",
  mergedAt: "2026-09-08T21:35:27Z",
  workflowId: 275_221_294,
  workflowPath: ".github/workflows/ci.yml",
  runId: 34_281_452_199,
  runNumber: 563,
  checkSuiteId: 92_869_213_373,
  startedAt: "2026-09-08T21:35:31Z",
  completedAt: "2026-09-08T21:43:26Z",
  failedJobId: 102_248_030_722,
  failedJobStartedAt: "2026-09-08T21:39:21Z",
  failedJobCompletedAt: "2026-09-08T21:43:25Z",
  successfulBuildStepNumber: 8,
  successfulBuildStepName: "Build, test, and scan",
  successfulBuildStepStartedAt: "2026-09-08T21:39:51Z",
  successfulBuildStepCompletedAt: "2026-09-08T21:43:06Z",
  failedStepNumber: 11,
  failedStepName: "Dependency audit",
  failedStepStartedAt: "2026-09-08T21:43:22Z",
  failedStepCompletedAt: "2026-09-08T21:43:23Z",
});
const MAX_AFTER_MERGE_MS = 4 * 60 * 60 * 1_000;
const MAX_AFTER_RUN_START_MS = 90 * 60 * 1_000;
const RELEASE_POLICY_SHA256 =
  "4aaedd863d08e539e1628db5d14557cc23531a0c6d586ffb25acebcba7907e90";
const Q_WORKFLOW_PATH =
  ".github/workflows/recover-permanent-staging-cold-zero.yml";
const Q_TITLE =
  `Permanent staging cold recovery | quiesce | ${Q_HEAD_SHA}`;
const Q_ARTIFACT_ID = "10057495901";
const Q_ARTIFACT_NAME =
  `pintpath-permanent-staging-cold-quiesce-${Q_HEAD_SHA}`;
const Q_ARTIFACT_DIGEST =
  "sha256:32a404cdd7078dc04d4b2531deec460dd4f44b4309fe35d873c8bcd46a367c4b";
const Q_JOB_ID = 102072625320;
const Q_JOB_NAME =
  "Quiesce the configured Europe replica from one to zero";
const CONTAINMENT_WORKFLOW_PATH =
  ".github/workflows/stop-permanent-staging-post-q-deployment.yml";
const CONTAINMENT_WORKFLOW_ID = 353312302;
const CONTAINMENT_WORKFLOW_NAME =
  "Stop the exact post-Q permanent staging deployment";
const CONTAINMENT_RECOVERY_RUN_ID = "34255228036";
const CONTAINMENT_RECOVERY_RUN_NUMBER = 1;
const CONTAINMENT_RECOVERY_RUN_CREATED_AT = "2026-09-08T17:07:48Z";
const CONTAINMENT_RECOVERY_RUN_STARTED_AT = "2026-09-08T17:07:48Z";
const CONTAINMENT_RECOVERY_RUN_COMPLETED_AT = "2026-09-08T17:12:11Z";
const CONTAINMENT_PREPARE_JOB =
  "Authenticate Q and persist the exact stop intent";
const CONTAINMENT_RECOVERY_PREPARE_JOB_ID = "102159216963";
const CONTAINMENT_APPLY_JOB =
  "Stop the one exact accidental staging deployment";
const CONTAINMENT_RECOVERY_APPLY_JOB_ID = "102160681336";
const FAILED_V3_RUN_ID = "34304764597";
const FAILED_V3_RUN_NUMBER = 2;
const FAILED_V3_HEAD_SHA = SUCCESSOR_DIRECT_PARENT_SHA;
const FAILED_V3_CHECK_SUITE_ID = 92_929_472_980;
const FAILED_V3_RUN_CREATED_AT = "2026-09-09T02:49:57Z";
const FAILED_V3_RUN_STARTED_AT = "2026-09-09T02:49:57Z";
const FAILED_V3_RUN_COMPLETED_AT = "2026-09-09T02:58:09Z";
const FAILED_V3_PREPARE_JOB_ID = "102319052311";
const FAILED_V3_APPLY_JOB_ID = "102319762173";
const CONTAINMENT_WRITER_STEP =
  "Stop the exact accidental staging deployment once";
const V4_PHASES = Object.freeze([
  "prepare",
  "apply-reauth",
  "apply-prewrite",
]);
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HISTORY_PAGES = 10;
const TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

export const FAILED_V3_INTENT_ARTIFACT_MEMBER = Object.freeze({
  path: "stop-intent.json",
  sizeBytes: 5_245,
  sha256:
    "f51921b2dca554008c2e569abb04e2ba6b562d9b1e9f724264a29b3d72a96d1d",
});
export const FAILED_V3_TERMINAL_ARTIFACT_MEMBER = Object.freeze({
  path: "boundary-postflight.json",
  sizeBytes: 754,
  sha256:
    "827bc8f797062b613038ae5d6f5c24c9489f50d3beb889d55e92c5593b9bc742",
});
const FAILED_V3_ARTIFACTS = Object.freeze([
  Object.freeze({
    id: 10_086_316_260,
    name:
      `pintpath-permanent-staging-post-q-deployment-stop-intent-${FAILED_V3_HEAD_SHA}-${FAILED_V3_RUN_ID}`,
    digest:
      "sha256:e6882bd5bd659f2d95de84a8163be011722a96802b3a08a2e8eea4216fdd8766",
    sizeBytes: 2_507,
    createdAt: "2026-09-09T02:53:43Z",
    updatedAt: "2026-09-09T02:53:43Z",
    expiresAt: "2026-10-09T02:53:42Z",
    member: FAILED_V3_INTENT_ARTIFACT_MEMBER,
  }),
  Object.freeze({
    id: 10_086_412_037,
    name:
      `pintpath-permanent-staging-post-q-deployment-stop-${FAILED_V3_HEAD_SHA}-${FAILED_V3_RUN_ID}`,
    digest:
      "sha256:49c92825d47b7c90b3aba605c12b9643990c9091b7b6dac0d207fb57e665d4eb",
    sizeBytes: 471,
    createdAt: "2026-09-09T02:58:06Z",
    updatedAt: "2026-09-09T02:58:06Z",
    expiresAt: "2026-10-09T02:58:06Z",
    member: FAILED_V3_TERMINAL_ARTIFACT_MEMBER,
  }),
]);

export const POST_Q_ARTIFACT_MEMBERS = Object.freeze([
  Object.freeze({
    path: "pintpath-cold-github-candidate/reviewed-authority.json",
    sizeBytes: 5354,
    sha256:
      "877d697225c6f8a6290386a1f2e9b003ee1a521b01af0cd046d482a4b16c8dfc",
  }),
  Object.freeze({
    path:
      "pintpath-permanent-staging-cold-evidence/cold-quiesce-intent.json",
    sizeBytes: 2952,
    sha256:
      "2937fa93e50fd01ed36f7578e6da3d236eec73d1efc65f120aa02581d7b81d99",
  }),
  Object.freeze({
    path:
      "pintpath-permanent-staging-cold-evidence/cold-quiesce-receipt.json",
    sizeBytes: 6466,
    sha256:
      "f1ee14e3d8082add77cefeaafde38f188df36e29688cba679cbc92b75bb322c5",
  }),
  Object.freeze({
    path:
      "pintpath-permanent-staging-cold-evidence/cold-quiesce-successor-bridge.json",
    sizeBytes: 12505,
    sha256:
      "b355f3474a368e4f4b97c98d6d5fc1f35b01e0aa48d22f1c19e6a1d8ccadaec3",
  }),
  Object.freeze({
    path:
      "pintpath-permanent-staging-cold-evidence/prerequisites-verification.json",
    sizeBytes: 2724,
    sha256:
      "fe423786cb2db2af8230fc8e3fb7bb6a19a9cbe366adb1a6542aade79c8f7867",
  }),
]);

const Q_TARGET_STEPS = Object.freeze([
  [1, "Set up job", "success"],
  [2, "Checkout the exact candidate without persisted credentials", "success"],
  [3, "Require exact cold quiesce authority", "success"],
  [4, "Setup the repository Node runtime", "success"],
  [5, "Install immutable dependencies", "success"],
  [6, "Run the complete repository gate before provider-token custody", "success"],
  [7, "Create private prerequisite and evidence custody", "success"],
  [8, "Authenticate the reviewed candidate and fresh cold quiesce dispatch", "success"],
  [9, "Retrieve the immediate prior quiesce artifact", "success"],
  [10, "Seal the exact immediate prior evidence bundle", "success"],
  [11, "Retrieve the exact failed-prewrite direct-predecessor artifact", "success"],
  [12, "Seal the exact failed-prewrite evidence bundle", "success"],
  [13, "Retrieve the pinned legacy quiesce artifact", "success"],
  [14, "Seal the exact legacy evidence bundle", "success"],
  [15, "Retrieve the exact cold prepare artifact", "success"],
  [16, "Seal and authenticate the exact cold prepare receipt", "success"],
  [17, "Bind the ambiguous predecessor to configured live topology", "success"],
  [18, "Quiesce the configured Europe replica from one to zero once", "failure"],
  [19, "Remove legacy artifact custody", "success"],
  [20, "Remove immediate prior, failed-prewrite, and prepare artifact custody", "success"],
  [21, "Reconcile the Railway production-staging mutation boundary", "success"],
  [22, "Upload bounded cold quiesce evidence", "success"],
  [43, "Post Setup the repository Node runtime", "skipped"],
  [44, "Post Checkout the exact candidate without persisted credentials", "success"],
  [45, "Complete job", "success"],
]);

const Q_SKIPPED_JOBS = Object.freeze([
  Object.freeze({
    id: 102072626482,
    name: "Bind the exact replacement and prepare the dead baseline",
  }),
  Object.freeze({
    id: 102072626886,
    name: "Reconcile an ambiguous cold prepare at the exact dead baseline",
  }),
  Object.freeze({
    id: 102072656578,
    name: "Reconcile an ambiguous cold quiesce at exact zero",
  }),
]);

const CONTAINMENT_RECOVERY_PREPARE_STEPS = Object.freeze([
  Object.freeze([
    1, "Set up job", "success",
    "2026-09-08T17:07:54Z", "2026-09-08T17:07:55Z",
  ]),
  Object.freeze([
    2,
    "Checkout the exact main candidate without persisted credentials",
    "success",
    "2026-09-08T17:07:55Z",
    "2026-09-08T17:07:58Z",
  ]),
  Object.freeze([
    3,
    "Require exact one-attempt staging-only containment authority",
    "success",
    "2026-09-08T17:07:58Z",
    "2026-09-08T17:07:59Z",
  ]),
  Object.freeze([
    4, "Setup the repository Node runtime", "success",
    "2026-09-08T17:07:59Z", "2026-09-08T17:08:00Z",
  ]),
  Object.freeze([
    5, "Install immutable dependencies", "success",
    "2026-09-08T17:08:00Z", "2026-09-08T17:08:04Z",
  ]),
  Object.freeze([
    6,
    "Run the complete repository gate before provider-token custody",
    "success",
    "2026-09-08T17:08:04Z",
    "2026-09-08T17:12:07Z",
  ]),
  Object.freeze([
    7, "Create private Q, intent, and evidence custody", "success",
    "2026-09-08T17:12:07Z", "2026-09-08T17:12:07Z",
  ]),
  Object.freeze([
    8, "Download the exact immutable failed-Q artifact", "success",
    "2026-09-08T17:12:07Z", "2026-09-08T17:12:08Z",
  ]),
  Object.freeze([
    9,
    "Authenticate the exact failed Q run, sole writer, and artifact bytes",
    "failure",
    "2026-09-08T17:12:08Z",
    "2026-09-08T17:12:08Z",
  ]),
  Object.freeze([
    10,
    "Prepare the exact post-Q stop intent with metadata credentials only",
    "skipped",
    "2026-09-08T17:12:08Z",
    "2026-09-08T17:12:08Z",
  ]),
  Object.freeze([
    11,
    "Persist the exact stop intent before any stop credential exists",
    "skipped",
    "2026-09-08T17:12:08Z",
    "2026-09-08T17:12:08Z",
  ]),
  Object.freeze([
    12, "Remove prepare Q custody", "success",
    "2026-09-08T17:12:08Z", "2026-09-08T17:12:08Z",
  ]),
  Object.freeze([
    23, "Post Setup the repository Node runtime", "skipped",
    "2026-09-08T17:12:08Z", "2026-09-08T17:12:08Z",
  ]),
  Object.freeze([
    24,
    "Post Checkout the exact main candidate without persisted credentials",
    "success",
    "2026-09-08T17:12:08Z",
    "2026-09-08T17:12:09Z",
  ]),
  Object.freeze([
    25, "Complete job", "success",
    "2026-09-08T17:12:09Z", "2026-09-08T17:12:09Z",
  ]),
]);

const FAILED_V3_PREPARE_STEPS = Object.freeze([
  Object.freeze([1, "Set up job", "success", "2026-09-09T02:50:03Z", "2026-09-09T02:50:05Z"]),
  Object.freeze([2, "Checkout the exact main candidate without persisted credentials", "success", "2026-09-09T02:50:05Z", "2026-09-09T02:50:09Z"]),
  Object.freeze([3, "Require exact one-attempt staging-only containment authority", "success", "2026-09-09T02:50:09Z", "2026-09-09T02:50:10Z"]),
  Object.freeze([4, "Setup the repository Node runtime", "success", "2026-09-09T02:50:10Z", "2026-09-09T02:50:14Z"]),
  Object.freeze([5, "Install immutable dependencies", "success", "2026-09-09T02:50:14Z", "2026-09-09T02:50:18Z"]),
  Object.freeze([6, "Run the complete repository gate before provider-token custody", "success", "2026-09-09T02:50:18Z", "2026-09-09T02:53:32Z"]),
  Object.freeze([7, "Create private Q, intent, and evidence custody", "success", "2026-09-09T02:53:32Z", "2026-09-09T02:53:32Z"]),
  Object.freeze([8, "Download the exact immutable failed-Q artifact", "success", "2026-09-09T02:53:32Z", "2026-09-09T02:53:33Z"]),
  Object.freeze([9, "Authenticate the exact failed Q run, sole writer, and artifact bytes", "success", "2026-09-09T02:53:33Z", "2026-09-09T02:53:40Z"]),
  Object.freeze([10, "Prepare the exact post-Q stop intent with metadata credentials only", "success", "2026-09-09T02:53:40Z", "2026-09-09T02:53:42Z"]),
  Object.freeze([11, "Persist the exact stop intent before any stop credential exists", "success", "2026-09-09T02:53:42Z", "2026-09-09T02:53:43Z"]),
  Object.freeze([12, "Remove prepare Q custody", "success", "2026-09-09T02:53:43Z", "2026-09-09T02:53:43Z"]),
  Object.freeze([23, "Post Setup the repository Node runtime", "success", "2026-09-09T02:53:43Z", "2026-09-09T02:53:43Z"]),
  Object.freeze([24, "Post Checkout the exact main candidate without persisted credentials", "success", "2026-09-09T02:53:43Z", "2026-09-09T02:53:43Z"]),
  Object.freeze([25, "Complete job", "success", "2026-09-09T02:53:43Z", "2026-09-09T02:53:43Z"]),
]);

const FAILED_V3_APPLY_STEPS = Object.freeze([
  Object.freeze([1, "Set up job", "success", "2026-09-09T02:53:49Z", "2026-09-09T02:53:50Z"]),
  Object.freeze([2, "Checkout the exact main candidate without persisted credentials", "success", "2026-09-09T02:53:50Z", "2026-09-09T02:53:53Z"]),
  Object.freeze([3, "Require exact apply authority and durable-intent outputs", "success", "2026-09-09T02:53:53Z", "2026-09-09T02:53:53Z"]),
  Object.freeze([4, "Setup the repository Node runtime", "success", "2026-09-09T02:53:53Z", "2026-09-09T02:53:54Z"]),
  Object.freeze([5, "Install immutable dependencies", "success", "2026-09-09T02:53:54Z", "2026-09-09T02:53:59Z"]),
  Object.freeze([6, "Run the complete repository gate again before the sole writer", "success", "2026-09-09T02:53:59Z", "2026-09-09T02:58:03Z"]),
  Object.freeze([7, "Create private Q, intent, and terminal evidence custody", "success", "2026-09-09T02:58:03Z", "2026-09-09T02:58:03Z"]),
  Object.freeze([8, "Download the exact immutable failed-Q artifact again", "success", "2026-09-09T02:58:03Z", "2026-09-09T02:58:04Z"]),
  Object.freeze([9, "Reauthenticate the exact failed Q run and artifact", "failure", "2026-09-09T02:58:04Z", "2026-09-09T02:58:05Z"]),
  Object.freeze([10, "Download the exact durable stop intent", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"]),
  Object.freeze([11, "Bind the exact durable intent artifact before the writer", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"]),
  Object.freeze([12, "Download a fresh exact failed-Q artifact for immediate reassertion", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"]),
  Object.freeze([13, "Prove the production-staging boundary in a metadata-only process", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"]),
  Object.freeze([14, "Reassert current main, Q authority, and intent immediately before the writer", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"]),
  Object.freeze([15, "Stop the exact accidental staging deployment once", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"]),
  Object.freeze([16, "Reconcile the Railway production-staging mutation boundary", "success", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"]),
  Object.freeze([17, "Finalize the outer durable receipt without any provider credential", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"]),
  Object.freeze([18, "Require terminal evidence after every writer outcome", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"]),
  Object.freeze([19, "Remove downloaded Q and intent custody", "success", "2026-09-09T02:58:05Z", "2026-09-09T02:58:06Z"]),
  Object.freeze([20, "Upload bounded secret-free stop intent and terminal evidence", "success", "2026-09-09T02:58:06Z", "2026-09-09T02:58:06Z"]),
  Object.freeze([39, "Post Setup the repository Node runtime", "skipped", "2026-09-09T02:58:06Z", "2026-09-09T02:58:06Z"]),
  Object.freeze([40, "Post Checkout the exact main candidate without persisted credentials", "success", "2026-09-09T02:58:06Z", "2026-09-09T02:58:06Z"]),
  Object.freeze([41, "Complete job", "success", "2026-09-09T02:58:06Z", "2026-09-09T02:58:06Z"]),
]);

const CURRENT_V4_PREPARE_STEPS = Object.freeze([
  [1, "Set up job"],
  [2, "Checkout the exact main candidate without persisted credentials"],
  [3, "Require exact one-attempt staging-only containment authority"],
  [4, "Setup the repository Node runtime"],
  [5, "Install immutable dependencies"],
  [6, "Run the complete repository gate before provider-token custody"],
  [7, "Create private Q, intent, and evidence custody"],
  [8, "Download the exact failed V3 durable intent artifact"],
  [9, "Download the exact failed V3 terminal evidence artifact"],
  [10, "Download the exact immutable failed-Q artifact"],
  [11, "Authenticate the exact failed Q run, sole writer, and artifact bytes"],
  [12, "Prepare the exact post-Q stop intent with metadata credentials only"],
  [13, "Persist the exact stop intent before any stop credential exists"],
  [14, "Remove prepare Q custody"],
  [27, "Post Setup the repository Node runtime"],
  [28, "Post Checkout the exact main candidate without persisted credentials"],
  [29, "Complete job"],
]);

const CURRENT_V4_APPLY_STEPS = Object.freeze([
  [1, "Set up job"],
  [2, "Checkout the exact main candidate without persisted credentials"],
  [3, "Require exact apply authority and durable-intent outputs"],
  [4, "Setup the repository Node runtime"],
  [5, "Install immutable dependencies"],
  [6, "Run the complete repository gate again before the sole writer"],
  [7, "Create private Q, intent, and terminal evidence custody"],
  [8, "Download the exact failed V3 durable intent artifact again"],
  [9, "Download the exact failed V3 terminal evidence artifact again"],
  [10, "Download the exact immutable failed-Q artifact again"],
  [11, "Reauthenticate the exact failed Q run and artifact"],
  [12, "Download the exact durable stop intent"],
  [13, "Bind the exact durable intent artifact before the writer"],
  [14, "Download a fresh exact failed-Q artifact for immediate reassertion"],
  [15, "Prove the production-staging boundary in a metadata-only process"],
  [16, "Reassert current main, Q authority, and intent immediately before the writer"],
  [17, CONTAINMENT_WRITER_STEP],
  [18, "Reconcile the Railway production-staging mutation boundary"],
  [19, "Finalize the outer durable receipt without any provider credential"],
  [20, "Require terminal evidence after every writer outcome"],
  [21, "Remove downloaded Q and intent custody"],
  [22, "Upload bounded secret-free stop intent and terminal evidence"],
  [43, "Post Setup the repository Node runtime"],
  [44, "Post Checkout the exact main candidate without persisted credentials"],
  [45, "Complete job"],
]);

function fail(code) {
  throw new Error(`post_q_authority_${code}`);
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function authorizationSourceExact(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return false;
  }
  return Buffer.byteLength(source) === SUCCESSOR_AUTHORIZATION_SOURCE_SIZE_BYTES &&
    sha256(source) === SUCCESSOR_AUTHORIZATION_SOURCE_SHA256 &&
    source === canonical(value) && record(value) &&
    JSON.stringify(Object.keys(value)) ===
      JSON.stringify([
        "schemaVersion", "threadId", "messages", "provenanceUse",
        "cryptographicUserSignatureClaimed",
      ]) &&
    value.schemaVersion === SUCCESSOR_AUTHORIZATION_SOURCE_SCHEMA &&
    value.threadId === SUCCESSOR_AUTHORIZATION_THREAD_ID &&
    Array.isArray(value.messages) && value.messages.length === 1 &&
    value.messages.every((message, index) =>
      message === SUCCESSOR_AUTHORIZATION_MESSAGES[index]) &&
    value.provenanceUse ===
      "pintpath-post-q-staging-stop-successor-v4-reviewed-context" &&
    value.cryptographicUserSignatureClaimed === false;
}

function authorizationEvidence() {
  return Object.freeze({
    authorizationId: SUCCESSOR_AUTHORIZATION_ID,
    sourceThreadId: SUCCESSOR_AUTHORIZATION_THREAD_ID,
    sourceSchemaVersion: SUCCESSOR_AUTHORIZATION_SOURCE_SCHEMA,
    sourceSha256: SUCCESSOR_AUTHORIZATION_SOURCE_SHA256,
    sourceSizeBytes: SUCCESSOR_AUTHORIZATION_SOURCE_SIZE_BYTES,
    sourceSerialization: "JSON.stringify(value,null,2)+LF",
    messagesExact: true,
    provenanceUse:
      "pintpath-post-q-staging-stop-successor-v4-reviewed-context",
    reviewedProvenanceOnly: true,
    cryptographicUserSignatureClaimed: false,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

export function successorPolicyExact(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return false;
  }
  return source === canonical(value) && sha256(source) === SUCCESSOR_POLICY_SHA256 &&
    record(value) &&
    value.schemaVersion ===
      "pintpath-permanent-staging-post-q-deployment-stop-policy/v4" &&
    value.repository === REPOSITORY && record(value.workflow) &&
    value.workflow.path === CONTAINMENT_WORKFLOW_PATH &&
    value.workflow.workflowId === CONTAINMENT_WORKFLOW_ID &&
    value.workflow.requiredRunNumber === 3 &&
    value.workflow.requiredTotalHistoryRows === 3 &&
    value.workflow.historyQueryEventFilterAllowed === false &&
    value.workflow.currentWriterMustNotHaveStarted === true &&
    Array.isArray(value.workflow.currentWriterVerificationPhases) &&
    JSON.stringify(value.workflow.currentWriterVerificationPhases) ===
      JSON.stringify(["prepare", "apply-reauth", "apply-prewrite"]) &&
    Array.isArray(value.workflow.applyPrewriteFutureWriterStatesAllowed) &&
    JSON.stringify(value.workflow.applyPrewriteFutureWriterStatesAllowed) ===
      JSON.stringify(["pending"]) &&
    value.workflow.observedStepPrefixMustBeExact === true &&
    value.workflow.writerTimestampsOrConclusionForbidden === true &&
    value.workflow.rerunAllowed === false &&
    value.workflow.newDispatchAfterRun3Allowed === false &&
    record(value.archivedV1) &&
    value.archivedV1.authorityDeadline === EXPIRED_AUTHORITY_DEADLINE &&
    value.archivedV1.expired === true && value.archivedV1.reused === false &&
    record(value.archivedV2) &&
    value.archivedV2.candidateSha === V2_CANDIDATE_SHA &&
    value.archivedV2.candidateTreeSha === V2_CANDIDATE_TREE_SHA &&
    value.archivedV2.candidateSoleParentSha ===
      V2_CANDIDATE_PARENT_SHA &&
    record(value.archivedV2.ineligibility) &&
    value.archivedV2.ineligibility.runId === INELIGIBLE_V2_RUN.runId &&
    value.archivedV2.ineligibility.runAttempt === 1 &&
    value.archivedV2.ineligibility.failedJobId ===
      INELIGIBLE_V2_RUN.failedJobId &&
    value.archivedV2.ineligibility.failedStepNumber ===
      INELIGIBLE_V2_RUN.failedStepNumber &&
    value.archivedV2.ineligibility.authorityConsumed === false &&
    value.archivedV2.ineligibility.rerunCanQualify === false &&
    record(value.archivedV3) &&
    value.archivedV3.candidateSha === SUCCESSOR_DIRECT_PARENT_SHA &&
    value.archivedV3.candidateTreeSha === SUCCESSOR_DIRECT_PARENT_TREE_SHA &&
    value.archivedV3.candidateSoleParentSha ===
      SUCCESSOR_DIRECT_PARENT_PARENT_SHA &&
    record(value.archivedV3.failedRun) &&
    value.archivedV3.failedRun.runId === Number(FAILED_V3_RUN_ID) &&
    value.archivedV3.failedRun.runNumber === FAILED_V3_RUN_NUMBER &&
    value.archivedV3.failedRun.runAttempt === 1 &&
    value.archivedV3.failedRun.failedStepNumber === 9 &&
    value.archivedV3.failedRun.writerStepNumber === 15 &&
    value.archivedV3.failedRun.deploymentStopAttempts === 0 &&
    value.archivedV3.failedRun.writerNeverStartedExact === true &&
    value.archivedV3.failedRun.productionMutationForbiddenExact === true &&
    value.archivedV3.failedRun.rerunCanQualify === false &&
    Array.isArray(value.archivedV3.artifacts) &&
    value.archivedV3.artifacts.length === 2 &&
    value.archivedV3.artifacts[0]?.id === 10_086_316_260 &&
    value.archivedV3.artifacts[0]?.memberSha256 ===
      FAILED_V3_INTENT_ARTIFACT_MEMBER.sha256 &&
    value.archivedV3.artifacts[1]?.id === 10_086_412_037 &&
    value.archivedV3.artifacts[1]?.memberSha256 ===
      FAILED_V3_TERMINAL_ARTIFACT_MEMBER.sha256 &&
    value.archivedV3.authorityConsumed === true &&
    value.archivedV3.deploymentStopAuthorityConsumed === false &&
    value.archivedV3.canonicalRun3SuccessorRequired === true &&
    record(value.authorization) &&
    value.authorization.authorizationId === SUCCESSOR_AUTHORIZATION_ID &&
    value.authorization.sourceSha256 ===
      SUCCESSOR_AUTHORIZATION_SOURCE_SHA256 && record(value.deadline) &&
    value.deadline.explicitExpiry === SUCCESSOR_EXPLICIT_EXPIRY &&
    value.deadline.rederiveImmediatelyBeforeWriter === true &&
    value.deadline.expirySuppressesPostWriteReconciliation === false &&
    value.deadline.expirySuppressesFinalization === false &&
    record(value.environmentConfigProjection) &&
    value.environmentConfigProjection.sourceQueryDecryptVariables === false &&
    record(value.environmentConfigProjection.staticEligibilityProjection) &&
    value.environmentConfigProjection.staticEligibilityProjection.schemaVersion ===
      "pintpath-permanent-staging-post-q-target-deploy-config-projection/v1" &&
    value.environmentConfigProjection.staticEligibilityProjection.scope ===
      "exact-target-service-deploy-object" &&
    value.environmentConfigProjection.staticEligibilityProjection
      .historicalFullEnvironmentHashRequired === false &&
    value.environmentConfigProjection.staticEligibilityProjection
      .projectionSizeBytes === 540 &&
    value.environmentConfigProjection.staticEligibilityProjection
      .projectionSha256 ===
        "8ab34441af1ec87d5068ce0155975a9fea46a192537b70c54677e64f60ae183e" &&
    record(value.environmentConfigProjection.dynamicCollateralCommitment) &&
    value.environmentConfigProjection.dynamicCollateralCommitment.schemaVersion ===
      "pintpath-permanent-staging-post-q-observed-environment-config/v1" &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .exactKnownRootServiceVolumeAndNestedPathsRequired === true &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .unknownOrMissingPathRejected === true &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .numericBooleanAndNullMetadataValuesHashed === true &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .allProviderStringValuesRedactedBeforeHashing === true &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .rawProviderStringsComparedOnlyInProcess === true &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .rawProviderStringsPersistedOrHashed === false &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .exactPerServiceVariableNameSetsRequired === true &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .variableValueMustBeNull === true &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .onlyKnownPasswordGeneratorsMayBeStrings === true &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .generatorGrammarExact ===
        "secret(32,lowercase-then-uppercase-ascii)" &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .generatorProjectedAsSemanticDescriptor === true &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .rawGeneratorPersistedOrHashed === false &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .preflightPrewriteAndEveryTerminalObservationEqualityRequired === true &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .historicalDigestPinned === false &&
    value.environmentConfigProjection.dynamicCollateralCommitment
      .onlySchemaAndDigestPersisted === true &&
    value.environmentConfigProjection.secretMaterialIncluded === false &&
    value.environmentConfigProjection.secretDerivedCommitmentsIncluded === false;
}

function gitBlobOid(source) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  return crypto.createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

function archiveBytesExact(source, expected) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  return bytes.byteLength === expected.sizeBytes &&
    sha256(bytes) === expected.byteSha256 &&
    gitBlobOid(bytes) === expected.blobOid;
}

function archivedV2LocalFilesExact() {
  return ["authorization", "policy", "verifier", "authorityLibrary", "executor"]
    .every((key) => {
      const expected = V2_ARCHIVE[key];
      const source = fs.readFileSync(path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        `../${expected.path}`,
      ));
      return archiveBytesExact(source, expected);
    });
}

function archivedV2Evidence() {
  return Object.freeze({
    candidateSha: V2_CANDIDATE_SHA,
    candidateTreeSha: V2_CANDIDATE_TREE_SHA,
    candidateSoleParentSha: V2_CANDIDATE_PARENT_SHA,
    authorityConsumed: false,
    canonicalWorkflowRunAbsent: true,
    files: Object.freeze(Object.entries(V2_ARCHIVE).map(([name, value]) =>
      Object.freeze({ name, ...value }))),
  });
}

function archivedV3LocalFilesExact() {
  return ["authorization", "policy", "verifier", "authorityLibrary", "executor"]
    .every((key) => {
      const expected = V3_ARCHIVE[key];
      const source = fs.readFileSync(path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        `../${expected.path}`,
      ));
      return archiveBytesExact(source, expected);
    });
}

function archivedV3FilesEvidence() {
  return Object.freeze(Object.entries(V3_ARCHIVE).map(([name, value]) =>
    Object.freeze({ name, ...value })));
}

export function archivedV2WorkflowExact(value) {
  const expected = V2_ARCHIVE.canonicalWorkflow;
  if (!record(value) || value.type !== "file" ||
    value.path !== expected.path || value.sha !== expected.blobOid ||
    value.size !== expected.sizeBytes || value.encoding !== "base64" ||
    typeof value.content !== "string") return false;
  try {
    return archiveBytesExact(
      Buffer.from(value.content.replaceAll("\n", ""), "base64"),
      expected,
    );
  } catch {
    return false;
  }
}

export function archivedV3WorkflowExact(value) {
  const expected = V3_ARCHIVE.canonicalWorkflow;
  if (!record(value) || value.type !== "file" ||
    value.path !== expected.path || value.sha !== expected.blobOid ||
    value.size !== expected.sizeBytes || value.encoding !== "base64" ||
    typeof value.content !== "string") return false;
  try {
    return archiveBytesExact(
      Buffer.from(value.content.replaceAll("\n", ""), "base64"),
      expected,
    );
  } catch {
    return false;
  }
}

function githubTimestampExact(value) {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z");
}

export function deriveSuccessorDeadline(mergedAt, runStartedAt) {
  if (!githubTimestampExact(mergedAt) ||
    !githubTimestampExact(runStartedAt) ||
    !githubTimestampExact(SUCCESSOR_EXPLICIT_EXPIRY)) return null;
  const merged = Date.parse(mergedAt);
  const started = Date.parse(runStartedAt);
  const explicit = Date.parse(SUCCESSOR_EXPLICIT_EXPIRY);
  if (![merged, started, explicit].every(Number.isFinite) ||
    merged > started || started >= explicit) return null;
  return new Date(Math.min(
    merged + MAX_AFTER_MERGE_MS,
    started + MAX_AFTER_RUN_START_MS,
    explicit,
  )).toISOString();
}

function containmentRunTitle(headSha) {
  return `Permanent staging post-Q deployment stop | ${headSha}`;
}

function containmentRunTitleExact(value, headSha) {
  const expected = containmentRunTitle(headSha);
  return value.name === expected && value.display_title === expected;
}

function githubActorIdentityExact(value) {
  return ["actor", "triggering_actor"].every((field) =>
    record(value[field]) && value[field].id === 29029791 &&
      value[field].login === "blackmagic30");
}

function repositoryIdentityExact(value) {
  return record(value.repository) && value.repository.id === REPOSITORY_ID &&
    value.repository.full_name === REPOSITORY &&
    record(value.head_repository) &&
    value.head_repository.id === REPOSITORY_ID &&
    value.head_repository.full_name === REPOSITORY;
}

function containmentWorkflowMetadataExact(value) {
  return record(value) && value.id === CONTAINMENT_WORKFLOW_ID &&
    value.name === CONTAINMENT_WORKFLOW_NAME &&
    value.path === CONTAINMENT_WORKFLOW_PATH && value.state === "active";
}

export function historicalWorkflowBlobExact(value) {
  if (!record(value) || value.type !== "file" ||
    value.name !== "stop-permanent-staging-post-q-deployment.yml" ||
    value.path !== CONTAINMENT_WORKFLOW_PATH ||
    value.sha !== EXPIRED_WORKFLOW_BLOB_OID ||
    value.size !== EXPIRED_WORKFLOW_SIZE_BYTES || value.encoding !== "base64" ||
    typeof value.content !== "string") return false;
  let bytes;
  try {
    bytes = Buffer.from(value.content.replaceAll("\n", ""), "base64");
  } catch {
    return false;
  }
  return bytes.byteLength === EXPIRED_WORKFLOW_SIZE_BYTES &&
    sha256(bytes) === EXPIRED_WORKFLOW_BYTE_SHA256;
}

const INELIGIBLE_V2_JOBS = Object.freeze([
  Object.freeze({
    id: 102_246_920_048,
    name: "supabase-database",
    startedAt: "2026-09-08T21:35:34Z",
    completedAt: "2026-09-08T21:37:47Z",
    conclusion: "success",
  }),
  Object.freeze({
    id: 102_246_920_166,
    name: "postgres-tool-runtime-closure-observation",
    startedAt: "2026-09-08T21:35:35Z",
    completedAt: "2026-09-08T21:36:06Z",
    conclusion: "success",
  }),
  Object.freeze({
    id: 102_247_091_137,
    name: "postgres-migration-integration",
    startedAt: "2026-09-08T21:36:08Z",
    completedAt: "2026-09-08T21:39:19Z",
    conclusion: "success",
  }),
  Object.freeze({
    id: INELIGIBLE_V2_RUN.failedJobId,
    name: "build-test-scan",
    startedAt: INELIGIBLE_V2_RUN.failedJobStartedAt,
    completedAt: INELIGIBLE_V2_RUN.failedJobCompletedAt,
    conclusion: "failure",
  }),
]);

function ineligibleV2PullRequestExact(value) {
  return record(value) && value.number === INELIGIBLE_V2_RUN.pullRequestNumber &&
    value.state === "closed" && value.merged === true &&
    value.merged_at === INELIGIBLE_V2_RUN.mergedAt &&
    value.merge_commit_sha === V2_CANDIDATE_SHA &&
    record(value.head) && value.head.sha === INELIGIBLE_V2_RUN.reviewedHeadSha &&
    record(value.head.repo) && value.head.repo.full_name === REPOSITORY &&
    record(value.base) && value.base.ref === "main" &&
    value.base.sha === V2_CANDIDATE_PARENT_SHA &&
    record(value.base.repo) && value.base.repo.full_name === REPOSITORY &&
    record(value.user) && value.user.id === 29_029_791 &&
    record(value.merged_by) && value.merged_by.id === 29_029_791;
}

function ineligibleV2JobsExact(value) {
  if (!record(value) || value.total_count !== INELIGIBLE_V2_JOBS.length ||
    !Array.isArray(value.jobs) || value.jobs.length !== INELIGIBLE_V2_JOBS.length) {
    return false;
  }
  const ids = new Set();
  for (const expected of INELIGIBLE_V2_JOBS) {
    const matches = value.jobs.filter((job) => record(job) && job.id === expected.id);
    if (matches.length !== 1) return false;
    const job = matches[0];
    if (ids.has(job.id) || job.name !== expected.name ||
      job.run_id !== INELIGIBLE_V2_RUN.runId || job.run_attempt !== 1 ||
      job.workflow_name !== "CI" || job.head_sha !== V2_CANDIDATE_SHA ||
      job.status !== "completed" || job.conclusion !== expected.conclusion ||
      job.started_at !== expected.startedAt || job.completed_at !== expected.completedAt ||
      !Array.isArray(job.steps)) return false;
    ids.add(job.id);
  }
  const failed = value.jobs.find((job) =>
    record(job) && job.id === INELIGIBLE_V2_RUN.failedJobId);
  if (!record(failed)) return false;
  const failedSteps = failed.steps.filter((step) =>
    record(step) && step.conclusion === "failure");
  const build = failed.steps.filter((step) =>
    record(step) && step.number === INELIGIBLE_V2_RUN.successfulBuildStepNumber &&
      step.name === INELIGIBLE_V2_RUN.successfulBuildStepName);
  return failedSteps.length === 1 && build.length === 1 &&
    build[0].status === "completed" && build[0].conclusion === "success" &&
    build[0].started_at === INELIGIBLE_V2_RUN.successfulBuildStepStartedAt &&
    build[0].completed_at === INELIGIBLE_V2_RUN.successfulBuildStepCompletedAt &&
    failedSteps[0].number === INELIGIBLE_V2_RUN.failedStepNumber &&
    failedSteps[0].name === INELIGIBLE_V2_RUN.failedStepName &&
    failedSteps[0].status === "completed" &&
    failedSteps[0].started_at === INELIGIBLE_V2_RUN.failedStepStartedAt &&
    failedSteps[0].completed_at === INELIGIBLE_V2_RUN.failedStepCompletedAt;
}

function ineligibleV2RunExact(value) {
  return record(value) && value.id === INELIGIBLE_V2_RUN.runId &&
    value.workflow_id === INELIGIBLE_V2_RUN.workflowId &&
    value.path === INELIGIBLE_V2_RUN.workflowPath &&
    value.run_number === INELIGIBLE_V2_RUN.runNumber && value.run_attempt === 1 &&
    value.check_suite_id === INELIGIBLE_V2_RUN.checkSuiteId &&
    value.event === "push" && value.status === "completed" &&
    value.conclusion === "failure" && value.head_branch === "main" &&
    value.head_sha === V2_CANDIDATE_SHA &&
    value.created_at === INELIGIBLE_V2_RUN.startedAt &&
    value.run_started_at === INELIGIBLE_V2_RUN.startedAt &&
    value.updated_at === INELIGIBLE_V2_RUN.completedAt &&
    repositoryIdentityExact(value) && githubActorIdentityExact(value);
}

async function verifyIneligibleV2Candidate(fetchImpl, token) {
  let pullRequest;
  let reviewedHead;
  let run;
  let jobs;
  let archivedWorkflow;
  try {
    [pullRequest, reviewedHead, run, jobs, archivedWorkflow] = await Promise.all([
      releaseGithubGet(fetchImpl, token, REPOSITORY, "/pulls/99"),
      releaseGithubGet(
        fetchImpl,
        token,
        REPOSITORY,
        `/git/commits/${INELIGIBLE_V2_RUN.reviewedHeadSha}`,
      ),
      releaseGithubGet(
        fetchImpl,
        token,
        REPOSITORY,
        `/actions/runs/${INELIGIBLE_V2_RUN.runId}`,
      ),
      releaseGithubGet(
        fetchImpl,
        token,
        REPOSITORY,
        `/actions/runs/${INELIGIBLE_V2_RUN.runId}/attempts/1/jobs` +
          "?filter=all&per_page=100",
      ),
      releaseGithubGet(
        fetchImpl,
        token,
        REPOSITORY,
        `/contents/${CONTAINMENT_WORKFLOW_PATH}` +
          `?ref=${V2_CANDIDATE_SHA}`,
      ),
    ]);
  } catch {
    fail("archived_v2_invalid");
  }
  if (!ineligibleV2PullRequestExact(pullRequest) ||
    !record(reviewedHead) || reviewedHead.sha !== INELIGIBLE_V2_RUN.reviewedHeadSha ||
    !record(reviewedHead.tree) ||
    reviewedHead.tree.sha !== V2_CANDIDATE_TREE_SHA ||
    !ineligibleV2RunExact(run) || !ineligibleV2JobsExact(jobs) ||
    !archivedV2WorkflowExact(archivedWorkflow)) fail("archived_v2_invalid");
  return Object.freeze({
    candidateSha: V2_CANDIDATE_SHA,
    candidateTreeSha: V2_CANDIDATE_TREE_SHA,
    candidateSoleParentSha: V2_CANDIDATE_PARENT_SHA,
    pullRequestNumber: INELIGIBLE_V2_RUN.pullRequestNumber,
    reviewedPrHeadSha: INELIGIBLE_V2_RUN.reviewedHeadSha,
    mergedAt: INELIGIBLE_V2_RUN.mergedAt,
    workflowId: INELIGIBLE_V2_RUN.workflowId,
    workflowPath: INELIGIBLE_V2_RUN.workflowPath,
    runId: INELIGIBLE_V2_RUN.runId,
    runNumber: INELIGIBLE_V2_RUN.runNumber,
    runAttempt: 1,
    checkSuiteId: INELIGIBLE_V2_RUN.checkSuiteId,
    event: "push",
    headBranch: "main",
    status: "completed",
    conclusion: "failure",
    runStartedAt: INELIGIBLE_V2_RUN.startedAt,
    runCompletedAt: INELIGIBLE_V2_RUN.completedAt,
    failedJobId: INELIGIBLE_V2_RUN.failedJobId,
    failedJobName: "build-test-scan",
    failedJobStartedAt: INELIGIBLE_V2_RUN.failedJobStartedAt,
    failedJobCompletedAt: INELIGIBLE_V2_RUN.failedJobCompletedAt,
    successfulBuildStepNumber: INELIGIBLE_V2_RUN.successfulBuildStepNumber,
    successfulBuildStepName: INELIGIBLE_V2_RUN.successfulBuildStepName,
    successfulBuildStepStatus: "completed",
    successfulBuildStepConclusion: "success",
    successfulBuildStepStartedAt:
      INELIGIBLE_V2_RUN.successfulBuildStepStartedAt,
    successfulBuildStepCompletedAt:
      INELIGIBLE_V2_RUN.successfulBuildStepCompletedAt,
    failedStepNumber: INELIGIBLE_V2_RUN.failedStepNumber,
    failedStepName: INELIGIBLE_V2_RUN.failedStepName,
    failedStepStartedAt: INELIGIBLE_V2_RUN.failedStepStartedAt,
    failedStepCompletedAt: INELIGIBLE_V2_RUN.failedStepCompletedAt,
    canonicalWorkflowRunAbsent: true,
    authorityConsumed: false,
    rerunCanQualify: false,
    archivedFilesExact: true,
    archivedWorkflowExact: true,
  });
}

function parseArguments(argv) {
  if (argv.length !== 16) return null;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) return null;
    values.set(key, value);
  }
  const allowed = [
    "--phase",
    "--candidate-sha",
    "--q-run-id",
    "--q-artifact-id",
    "--failed-v3-intent-downloaded-dir",
    "--failed-v3-evidence-downloaded-dir",
    "--downloaded-dir",
    "--output-dir",
  ];
  if (values.size !== allowed.length || allowed.some((key) => !values.has(key))) {
    return null;
  }
  const phase = values.get("--phase");
  const candidateSha = values.get("--candidate-sha");
  const qRunId = values.get("--q-run-id");
  const qArtifactId = values.get("--q-artifact-id");
  const failedV3IntentDownloadedDirectory = values.get(
    "--failed-v3-intent-downloaded-dir",
  );
  const failedV3EvidenceDownloadedDirectory = values.get(
    "--failed-v3-evidence-downloaded-dir",
  );
  const downloadedDirectory = values.get("--downloaded-dir");
  const outputDirectory = values.get("--output-dir");
  const archivedDirectories = [
    failedV3IntentDownloadedDirectory,
    failedV3EvidenceDownloadedDirectory,
  ];
  if (!V4_PHASES.includes(phase) || !SHA_PATTERN.test(candidateSha) ||
    qRunId !== Q_RUN_ID ||
    qArtifactId !== Q_ARTIFACT_ID || !path.isAbsolute(downloadedDirectory) ||
    !path.isAbsolute(outputDirectory) ||
    archivedDirectories.some((directory) => !path.isAbsolute(directory)) ||
    path.resolve(downloadedDirectory) === path.resolve(outputDirectory) ||
    path.dirname(path.resolve(downloadedDirectory)) !==
      path.resolve(outputDirectory) ||
    path.basename(downloadedDirectory) !== "downloaded" ||
    archivedDirectories.some((directory) =>
      path.basename(path.resolve(directory)) !== "downloaded") ||
    new Set([
      path.resolve(downloadedDirectory),
      path.resolve(outputDirectory),
      ...archivedDirectories.map((directory) => path.resolve(directory)),
      ...archivedDirectories.map((directory) =>
        path.dirname(path.resolve(directory))),
    ]).size !== 6) return null;
  return {
    phase,
    candidateSha,
    qRunId,
    qArtifactId,
    failedV3IntentDownloadedDirectory: path.resolve(
      failedV3IntentDownloadedDirectory,
    ),
    failedV3EvidenceDownloadedDirectory: path.resolve(
      failedV3EvidenceDownloadedDirectory,
    ),
    downloadedDirectory: path.resolve(downloadedDirectory),
    outputDirectory: path.resolve(outputDirectory),
  };
}

function environmentExact(env, candidateSha) {
  return env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.GITHUB_REPOSITORY === REPOSITORY &&
    env.GITHUB_REF === "refs/heads/main" &&
    env.GITHUB_SHA === candidateSha &&
    env.GITHUB_RUN_ATTEMPT === "1" &&
    RUN_ID_PATTERN.test(env.GITHUB_RUN_ID ?? "") &&
    env.GITHUB_RUN_ID !== Q_RUN_ID &&
    env.GITHUB_API_URL === "https://api.github.com" &&
    env.PINTPATH_PROTECTED_ENVIRONMENT ===
      "permanent-staging-scale-evidence" &&
    env.PINTPATH_POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_ID ===
      SUCCESSOR_AUTHORIZATION_ID &&
    env.PINTPATH_POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_SOURCE_SHA256 ===
      SUCCESSOR_AUTHORIZATION_SOURCE_SHA256 &&
    env.PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION ===
      "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN" &&
    TOKEN_PATTERN.test(env.GITHUB_TOKEN ?? "");
}

async function boundedJson(response) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    fail("github_response_invalid");
  }
  if (response.body === null) fail("github_response_invalid");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail("github_response_invalid");
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    fail("github_response_invalid");
  }
}

async function githubGet(fetchImpl, env, resource, allowNext = false) {
  const response = await fetchImpl(`${env.GITHUB_API_URL}${resource}`, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
    },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok || (!allowNext &&
    response.headers.get("link")?.includes('rel="next"'))) {
    await response.body?.cancel();
    fail("github_response_invalid");
  }
  const value = await boundedJson(response);
  return allowNext
    ? Object.freeze({ value, link: response.headers.get("link") })
    : value;
}

function paginationLinkExact(link, page, total, rowsBefore, pageLength) {
  const needsNext = rowsBefore + pageLength < total;
  const match = typeof link === "string"
    ? /<([^>]+)>;\s*rel="next"/u.exec(link)
    : null;
  if (!needsNext) return match === null;
  if (match === null) return false;
  try {
    const next = new URL(match[1]);
    return next.origin === "https://api.github.com" &&
      next.searchParams.get("per_page") === "100" &&
      next.searchParams.get("page") === String(page + 1);
  } catch {
    return false;
  }
}

function currentContainmentRunExact(value, env, candidateSha) {
  return record(value) && value.id === Number(env.GITHUB_RUN_ID) &&
    value.workflow_id === CONTAINMENT_WORKFLOW_ID &&
    value.run_number === 3 &&
    value.run_attempt === 1 && containmentRunTitleExact(value, candidateSha) &&
    value.event === "workflow_dispatch" &&
    value.status === "in_progress" && value.conclusion === null &&
    value.head_branch === "main" && value.head_sha === candidateSha &&
    value.path === CONTAINMENT_WORKFLOW_PATH &&
    githubTimestampExact(value.created_at) &&
    githubTimestampExact(value.run_started_at) &&
    githubTimestampExact(value.updated_at) &&
    Date.parse(value.created_at) <= Date.parse(value.run_started_at) &&
    Date.parse(value.run_started_at) <= Date.parse(value.updated_at) &&
    repositoryIdentityExact(value) && githubActorIdentityExact(value);
}

function containmentRunListingRowExact(value, workflowId) {
  return record(value) && RUN_ID_PATTERN.test(String(value.id)) &&
    workflowId === CONTAINMENT_WORKFLOW_ID &&
    value.workflow_id === CONTAINMENT_WORKFLOW_ID &&
    Number.isSafeInteger(value.run_number) && value.run_number > 0 &&
    value.run_attempt === 1 && SHA_PATTERN.test(value.head_sha) &&
    containmentRunTitleExact(value, value.head_sha) &&
    value.event === "workflow_dispatch" &&
    value.path === CONTAINMENT_WORKFLOW_PATH &&
    value.head_branch === "main" && repositoryIdentityExact(value) &&
    githubActorIdentityExact(value);
}

async function completeContainmentRunHistory(fetchImpl, env, workflowId) {
  if (workflowId !== CONTAINMENT_WORKFLOW_ID) {
    fail("containment_history_invalid");
  }
  const rows = [];
  const ids = new Set();
  let total = null;
  for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
    const pageResponse = await githubGet(
      fetchImpl,
      env,
      `/repos/${REPOSITORY}/actions/workflows/${CONTAINMENT_WORKFLOW_ID}/runs` +
        `?per_page=100&page=${page}`,
      true,
    );
    const value = pageResponse.value;
    if (!record(value) || !Number.isSafeInteger(value.total_count) ||
      value.total_count < 1 || value.total_count > MAX_HISTORY_PAGES * 100 ||
      !Array.isArray(value.workflow_runs) || value.workflow_runs.length > 100 ||
      (total !== null && value.total_count !== total)) {
      fail("containment_history_invalid");
    }
    total ??= value.total_count;
    const expectedLength = Math.min(100, total - rows.length);
    if (expectedLength < 1 || value.workflow_runs.length !== expectedLength) {
      fail("containment_history_invalid");
    }
    if (!paginationLinkExact(
      pageResponse.link,
      page,
      total,
      rows.length,
      value.workflow_runs.length,
    )) fail("containment_history_invalid");
    for (const run of value.workflow_runs) {
      if (!containmentRunListingRowExact(run, workflowId) ||
        ids.has(String(run.id))) fail("containment_history_invalid");
      ids.add(String(run.id));
      rows.push(run);
    }
    if (rows.length === total) return rows;
  }
  fail("containment_history_invalid");
}

async function completeAttemptJobs(fetchImpl, env, runId, runAttempt) {
  const jobs = [];
  const ids = new Set();
  let total = null;
  for (let page = 1; page <= 2; page += 1) {
    const pageResponse = await githubGet(
      fetchImpl,
      env,
      `/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}/jobs` +
        `?filter=all&per_page=100&page=${page}`,
      true,
    );
    const value = pageResponse.value;
    if (!record(value) || !Number.isSafeInteger(value.total_count) ||
      value.total_count < 1 || value.total_count > 200 ||
      !Array.isArray(value.jobs) || value.jobs.length > 100 ||
      (total !== null && value.total_count !== total)) {
      fail("containment_history_invalid");
    }
    total ??= value.total_count;
    const expectedLength = Math.min(100, total - jobs.length);
    if (expectedLength < 1 || value.jobs.length !== expectedLength) {
      fail("containment_history_invalid");
    }
    if (!paginationLinkExact(
      pageResponse.link,
      page,
      total,
      jobs.length,
      value.jobs.length,
    )) fail("containment_history_invalid");
    for (const job of value.jobs) {
      if (!record(job) || !RUN_ID_PATTERN.test(String(job.id)) ||
        ids.has(String(job.id)) || job.run_id !== Number(runId) ||
        job.run_attempt !== runAttempt || typeof job.name !== "string" ||
        !Array.isArray(job.steps)) fail("containment_history_invalid");
      ids.add(String(job.id));
      jobs.push(job);
    }
    if (jobs.length === total) return jobs;
  }
  fail("containment_history_invalid");
}

function priorAttemptDefinitelySkipped(jobs) {
  if (jobs.length !== 2 || new Set(jobs.map((job) => job.name)).size !== 2) {
    return false;
  }
  const prepare = jobs.find((job) => job.name === CONTAINMENT_PREPARE_JOB);
  const apply = jobs.find((job) => job.name === CONTAINMENT_APPLY_JOB);
  return record(prepare) && prepare.status === "completed" &&
    typeof prepare.conclusion === "string" && record(apply) &&
    apply.status === "completed" &&
    apply.conclusion === "skipped" && apply.steps.length === 0;
}

function completedStepsExact(steps, expectedSteps) {
  return Array.isArray(steps) &&
    steps.length === expectedSteps.length &&
    steps.every((step, index) => {
      const expected = expectedSteps[index];
      return record(step) && step.number === expected[0] &&
        step.name === expected[1] && step.status === "completed" &&
        step.conclusion === expected[2] && step.started_at === expected[3] &&
        step.completed_at === expected[4];
    });
}

function recoveryPrepareStepsExact(steps) {
  return completedStepsExact(steps, CONTAINMENT_RECOVERY_PREPARE_STEPS);
}

function recoveryBridgeRunExact(run, jobs) {
  if (!record(run) || String(run.id) !== CONTAINMENT_RECOVERY_RUN_ID ||
    run.workflow_id !== CONTAINMENT_WORKFLOW_ID ||
    run.check_suite_id !== 92795131798 ||
    run.run_number !== CONTAINMENT_RECOVERY_RUN_NUMBER ||
    run.run_attempt !== 1 ||
    !containmentRunTitleExact(run, EXPIRED_RUN_HEAD_SHA) ||
    run.event !== "workflow_dispatch" || run.status !== "completed" ||
    run.conclusion !== "failure" || run.head_branch !== "main" ||
    run.head_sha !== EXPIRED_RUN_HEAD_SHA ||
    run.path !== CONTAINMENT_WORKFLOW_PATH ||
    run.created_at !== CONTAINMENT_RECOVERY_RUN_CREATED_AT ||
    run.run_started_at !== CONTAINMENT_RECOVERY_RUN_STARTED_AT ||
    run.updated_at !== CONTAINMENT_RECOVERY_RUN_COMPLETED_AT ||
    !repositoryIdentityExact(run) || !githubActorIdentityExact(run) ||
    jobs.length !== 2 ||
    String(jobs[0]?.id) !== CONTAINMENT_RECOVERY_PREPARE_JOB_ID ||
    String(jobs[1]?.id) !== CONTAINMENT_RECOVERY_APPLY_JOB_ID) return false;
  const prepare = jobs[0];
  const apply = jobs[1];
  const expectedWorkflowName = containmentRunTitle(
    EXPIRED_RUN_HEAD_SHA,
  );
  return record(prepare) && prepare.name === CONTAINMENT_PREPARE_JOB &&
    prepare.run_id === Number(CONTAINMENT_RECOVERY_RUN_ID) &&
    prepare.run_attempt === 1 &&
    prepare.workflow_name === expectedWorkflowName &&
    prepare.head_sha === EXPIRED_RUN_HEAD_SHA &&
    prepare.status === "completed" && prepare.conclusion === "failure" &&
    prepare.created_at === "2026-09-08T17:07:50Z" &&
    prepare.started_at === "2026-09-08T17:07:53Z" &&
    prepare.completed_at === "2026-09-08T17:12:10Z" &&
    recoveryPrepareStepsExact(prepare.steps) && record(apply) &&
    apply.name === CONTAINMENT_APPLY_JOB &&
    apply.run_id === Number(CONTAINMENT_RECOVERY_RUN_ID) &&
    apply.run_attempt === 1 &&
    apply.workflow_name === expectedWorkflowName &&
    apply.head_sha === EXPIRED_RUN_HEAD_SHA &&
    apply.status === "completed" && apply.conclusion === "skipped" &&
    apply.created_at === "2026-09-08T17:12:11Z" &&
    apply.started_at === "2026-09-08T17:12:11Z" &&
    apply.completed_at === "2026-09-08T17:12:10Z" &&
    apply.steps.length === 0;
}

export function failedV3RunExact(run, jobs) {
  if (!record(run) || String(run.id) !== FAILED_V3_RUN_ID ||
    run.workflow_id !== CONTAINMENT_WORKFLOW_ID ||
    run.check_suite_id !== FAILED_V3_CHECK_SUITE_ID ||
    run.run_number !== FAILED_V3_RUN_NUMBER || run.run_attempt !== 1 ||
    !containmentRunTitleExact(run, FAILED_V3_HEAD_SHA) ||
    run.event !== "workflow_dispatch" || run.status !== "completed" ||
    run.conclusion !== "failure" || run.head_branch !== "main" ||
    run.head_sha !== FAILED_V3_HEAD_SHA || run.path !== CONTAINMENT_WORKFLOW_PATH ||
    run.created_at !== FAILED_V3_RUN_CREATED_AT ||
    run.run_started_at !== FAILED_V3_RUN_STARTED_AT ||
    run.updated_at !== FAILED_V3_RUN_COMPLETED_AT ||
    !repositoryIdentityExact(run) || !githubActorIdentityExact(run) ||
    jobs.length !== 2 || String(jobs[0]?.id) !== FAILED_V3_PREPARE_JOB_ID ||
    String(jobs[1]?.id) !== FAILED_V3_APPLY_JOB_ID) return false;
  const prepare = jobs[0];
  const apply = jobs[1];
  const workflowName = containmentRunTitle(FAILED_V3_HEAD_SHA);
  return record(prepare) && prepare.name === CONTAINMENT_PREPARE_JOB &&
    prepare.run_id === Number(FAILED_V3_RUN_ID) && prepare.run_attempt === 1 &&
    prepare.workflow_name === workflowName && prepare.head_sha === FAILED_V3_HEAD_SHA &&
    prepare.status === "completed" && prepare.conclusion === "success" &&
    prepare.created_at === "2026-09-09T02:49:58Z" &&
    prepare.started_at === "2026-09-09T02:50:02Z" &&
    prepare.completed_at === "2026-09-09T02:53:45Z" &&
    completedStepsExact(prepare.steps, FAILED_V3_PREPARE_STEPS) &&
    record(apply) && apply.name === CONTAINMENT_APPLY_JOB &&
    apply.run_id === Number(FAILED_V3_RUN_ID) && apply.run_attempt === 1 &&
    apply.workflow_name === workflowName && apply.head_sha === FAILED_V3_HEAD_SHA &&
    apply.status === "completed" && apply.conclusion === "failure" &&
    apply.created_at === "2026-09-09T02:53:46Z" &&
    apply.started_at === "2026-09-09T02:53:49Z" &&
    apply.completed_at === "2026-09-09T02:58:08Z" &&
    completedStepsExact(apply.steps, FAILED_V3_APPLY_STEPS) &&
    apply.steps.filter((step) =>
      record(step) && step.name === CONTAINMENT_WRITER_STEP &&
        step.status === "completed" && step.conclusion === "skipped" &&
        step.started_at === step.completed_at).length === 1;
}

export function failedV3ArtifactsExact(value) {
  if (!record(value) || value.total_count !== FAILED_V3_ARTIFACTS.length ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length !== FAILED_V3_ARTIFACTS.length) return false;
  return FAILED_V3_ARTIFACTS.every((expected) => {
    const matches = value.artifacts.filter((artifact) =>
      record(artifact) && artifact.id === expected.id);
    if (matches.length !== 1) return false;
    const artifact = matches[0];
    return artifact.name === expected.name &&
      artifact.size_in_bytes === expected.sizeBytes &&
      artifact.digest === expected.digest && artifact.expired === false &&
      artifact.created_at === expected.createdAt &&
      artifact.updated_at === expected.updatedAt &&
      artifact.expires_at === expected.expiresAt &&
      record(artifact.workflow_run) &&
      artifact.workflow_run.id === Number(FAILED_V3_RUN_ID) &&
      artifact.workflow_run.repository_id === REPOSITORY_ID &&
      artifact.workflow_run.head_repository_id === REPOSITORY_ID &&
      artifact.workflow_run.head_branch === "main" &&
      artifact.workflow_run.head_sha === FAILED_V3_HEAD_SHA;
  });
}

function currentStepPrefixExact(steps, expectedSteps, checkpointNumber) {
  if (!Array.isArray(steps) || steps.length < checkpointNumber ||
    steps.length > expectedSteps.length) return false;
  return steps.every((step, index) => {
    const expected = expectedSteps[index];
    if (!record(step) || step.number !== expected[0] ||
      step.name !== expected[1]) return false;
    if (step.number < checkpointNumber) {
      return step.status === "completed" && step.conclusion === "success" &&
        githubTimestampExact(step.started_at) &&
        githubTimestampExact(step.completed_at) &&
        Date.parse(step.started_at) <= Date.parse(step.completed_at);
    }
    if (step.number === checkpointNumber) {
      return step.status === "in_progress" && step.conclusion === null &&
        githubTimestampExact(step.started_at) && step.completed_at === null;
    }
    return step.status === "pending" && step.conclusion === null &&
      step.started_at === null && step.completed_at === null;
  });
}

export function currentWriterNotStarted(jobs, phase) {
  if (jobs.length < 1 || jobs.length > 2 ||
    new Set(jobs.map((job) => job.name)).size !== jobs.length ||
    jobs.some((job) => ![CONTAINMENT_PREPARE_JOB, CONTAINMENT_APPLY_JOB]
      .includes(job.name)) ||
    !jobs.some((job) => job.name === CONTAINMENT_PREPARE_JOB)) return false;
  const prepare = jobs.find((job) => job.name === CONTAINMENT_PREPARE_JOB);
  if (!record(prepare)) return false;
  const apply = jobs.find((job) => job.name === CONTAINMENT_APPLY_JOB);
  if (phase === "prepare") {
    if (prepare.status !== "in_progress" || prepare.conclusion !== null ||
      !githubTimestampExact(prepare.started_at) || prepare.completed_at !== null ||
      !currentStepPrefixExact(prepare.steps, CURRENT_V4_PREPARE_STEPS, 11)) {
      return false;
    }
    if (apply === undefined) return true;
    return apply.status === "queued" && apply.conclusion === null &&
      apply.started_at === null && apply.completed_at === null &&
      apply.steps.length === 0;
  }
  const checkpointNumber = phase === "apply-reauth"
    ? 11
    : phase === "apply-prewrite"
    ? 16
    : null;
  if (checkpointNumber === null) return false;
  if (prepare.status !== "completed" || prepare.conclusion !== "success" ||
    !record(apply) || apply.status !== "in_progress" ||
    apply.conclusion !== null ||
    typeof apply.started_at !== "string" ||
    !Number.isFinite(Date.parse(apply.started_at)) || apply.completed_at !== null ||
    !currentStepPrefixExact(
      apply.steps,
      CURRENT_V4_APPLY_STEPS,
      checkpointNumber,
    )) return false;
  const writers = apply.steps.filter((step) =>
    record(step) && step.name === CONTAINMENT_WRITER_STEP);
  if (writers.length !== 1) return false;
  const writer = writers[0];
  return writer.number === 17 && writer.status === "pending" &&
    writer.conclusion === null &&
    writer.started_at === null && writer.completed_at === null;
}

export function currentWorkflowAuthorityEvidence(
  currentRun,
  candidateSha,
  totalDispatchRuns,
) {
  return Object.freeze({
    workflowId: currentRun.workflow_id,
    workflowPath: CONTAINMENT_WORKFLOW_PATH,
    runId: String(currentRun.id),
    runNumber: currentRun.run_number,
    runAttempt: 1,
    headSha: candidateSha,
    totalDispatchRuns,
    currentWriterNotStartedExact: true,
    allPriorRunsNoWriteExact: true,
    exactFailedV3PrewriterRunArchived: true,
    allWorkflowRunPagesReadExact: true,
    allRunAttemptJobPagesReadExact: true,
    freshDispatchCannotRepeatWriteExact: true,
  });
}

async function verifyContainmentSingleUseAuthority(
  fetchImpl,
  env,
  candidateSha,
  currentRun,
  phase,
  historicalWorkflowExact = historicalWorkflowBlobExact,
  historicalV3WorkflowExact = archivedV3WorkflowExact,
) {
  if (!currentContainmentRunExact(currentRun, env, candidateSha)) {
    fail("containment_history_invalid");
  }
  const [runs, recoveryRun, recoveryArtifacts, failedV3Run,
    failedV3Artifacts, workflowMetadata, historicalWorkflow,
    historicalV3Workflow] =
    await Promise.all([
    completeContainmentRunHistory(
      fetchImpl,
      env,
      currentRun.workflow_id,
    ),
    githubGet(
      fetchImpl,
      env,
      `/repos/${REPOSITORY}/actions/runs/${CONTAINMENT_RECOVERY_RUN_ID}`,
    ),
    githubGet(
      fetchImpl,
      env,
      `/repos/${REPOSITORY}/actions/runs/${CONTAINMENT_RECOVERY_RUN_ID}` +
        "/artifacts?per_page=100&page=1",
    ),
    githubGet(
      fetchImpl,
      env,
      `/repos/${REPOSITORY}/actions/runs/${FAILED_V3_RUN_ID}`,
    ),
    githubGet(
      fetchImpl,
      env,
      `/repos/${REPOSITORY}/actions/runs/${FAILED_V3_RUN_ID}` +
        "/artifacts?per_page=100&page=1",
    ),
    githubGet(
      fetchImpl,
      env,
      `/repos/${REPOSITORY}/actions/workflows/${CONTAINMENT_WORKFLOW_ID}`,
    ),
    githubGet(
      fetchImpl,
      env,
      `/repos/${REPOSITORY}/contents/${CONTAINMENT_WORKFLOW_PATH}` +
        `?ref=${EXPIRED_RUN_HEAD_SHA}`,
    ),
    githubGet(
      fetchImpl,
      env,
      `/repos/${REPOSITORY}/contents/${CONTAINMENT_WORKFLOW_PATH}` +
        `?ref=${FAILED_V3_HEAD_SHA}`,
    ),
  ]);
  if (runs.length !== 3 || !record(recoveryArtifacts) ||
    recoveryArtifacts.total_count !== 0 ||
    !Array.isArray(recoveryArtifacts.artifacts) ||
    recoveryArtifacts.artifacts.length !== 0 ||
    !failedV3ArtifactsExact(failedV3Artifacts) ||
    !containmentWorkflowMetadataExact(workflowMetadata) ||
    !historicalWorkflowExact(historicalWorkflow) ||
    !historicalV3WorkflowExact(historicalV3Workflow)) {
    fail("containment_history_invalid");
  }
  const currentRows = runs.filter((run) =>
    String(run.id) === env.GITHUB_RUN_ID);
  const priorRows = runs.filter((run) =>
    String(run.id) !== env.GITHUB_RUN_ID);
  if (String(runs[0]?.id) !== env.GITHUB_RUN_ID ||
    String(runs[1]?.id) !== FAILED_V3_RUN_ID ||
    String(runs[2]?.id) !== CONTAINMENT_RECOVERY_RUN_ID ||
    currentRows.length !== 1 ||
    !currentContainmentRunExact(currentRows[0], env, candidateSha) ||
    priorRows.length !== 2 ||
    String(priorRows[0].id) !== FAILED_V3_RUN_ID ||
    String(priorRows[1].id) !== CONTAINMENT_RECOVERY_RUN_ID) {
    fail("containment_history_invalid");
  }
  const [recoveryJobs, failedV3Jobs, currentJobs] = await Promise.all([
    completeAttemptJobs(
      fetchImpl,
      env,
      CONTAINMENT_RECOVERY_RUN_ID,
      1,
    ),
    completeAttemptJobs(fetchImpl, env, FAILED_V3_RUN_ID, 1),
    completeAttemptJobs(fetchImpl, env, env.GITHUB_RUN_ID, 1),
  ]);
  if (!priorAttemptDefinitelySkipped(recoveryJobs) ||
    !recoveryBridgeRunExact(runs[2], recoveryJobs) ||
    !recoveryBridgeRunExact(recoveryRun, recoveryJobs) ||
    !failedV3RunExact(runs[1], failedV3Jobs) ||
    !failedV3RunExact(failedV3Run, failedV3Jobs) ||
    !currentWriterNotStarted(currentJobs, phase)) {
    fail("containment_authority_consumed");
  }
  const archivedV3 = Object.freeze({
    candidateSha: FAILED_V3_HEAD_SHA,
    candidateTreeSha: SUCCESSOR_DIRECT_PARENT_TREE_SHA,
    candidateSoleParentSha: SUCCESSOR_DIRECT_PARENT_PARENT_SHA,
    runId: FAILED_V3_RUN_ID,
    runNumber: FAILED_V3_RUN_NUMBER,
    runAttempt: 1,
    workflowId: CONTAINMENT_WORKFLOW_ID,
    workflowPath: CONTAINMENT_WORKFLOW_PATH,
    checkSuiteId: FAILED_V3_CHECK_SUITE_ID,
    prepareJobId: FAILED_V3_PREPARE_JOB_ID,
    applyJobId: FAILED_V3_APPLY_JOB_ID,
    failedStepNumber: 9,
    failedStepName: "Reauthenticate the exact failed Q run and artifact",
    writerStepNumber: 15,
    writerStepName: CONTAINMENT_WRITER_STEP,
    writerNeverStartedExact: true,
    deploymentStopAttempts: 0,
    productionMutationForbiddenExact: true,
    artifacts: Object.freeze(FAILED_V3_ARTIFACTS.map((artifact) =>
      Object.freeze({
        id: String(artifact.id),
        name: artifact.name,
        digest: artifact.digest,
        sizeBytes: artifact.sizeBytes,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
        expiresAt: artifact.expiresAt,
        member: artifact.member,
      }))),
    files: archivedV3FilesEvidence(),
    authorityConsumed: true,
    deploymentStopAuthorityConsumed: false,
    canonicalRun3SuccessorRequired: true,
  });
  return Object.freeze({
    expiredAuthority: Object.freeze({
      workflowId: CONTAINMENT_WORKFLOW_ID,
      workflowPath: CONTAINMENT_WORKFLOW_PATH,
      authorizationDeadline: EXPIRED_AUTHORITY_DEADLINE,
      authorizationExpired: true,
      authorityReused: false,
      runId: CONTAINMENT_RECOVERY_RUN_ID,
      runNumber: 1,
      runAttempt: 1,
      headSha: EXPIRED_RUN_HEAD_SHA,
      prepareJobId: CONTAINMENT_RECOVERY_PREPARE_JOB_ID,
      applyJobId: CONTAINMENT_RECOVERY_APPLY_JOB_ID,
      artifactCount: 0,
      historicalWorkflowBlobOid: EXPIRED_WORKFLOW_BLOB_OID,
      historicalWorkflowByteSha256: EXPIRED_WORKFLOW_BYTE_SHA256,
      historicalWorkflowSizeBytes: EXPIRED_WORKFLOW_SIZE_BYTES,
      historicalWorkflowPathAtHeadExact: true,
      prepareFailedBeforeIntentExact: true,
      applySkippedWithoutStepsExact: true,
      writerNeverExistedOrStartedExact: true,
    }),
    archivedV3,
    currentWorkflow: currentWorkflowAuthorityEvidence(
      currentRun,
      candidateSha,
      runs.length,
    ),
  });
}

export async function verifyPostQReviewedCandidate(
  fetchImpl,
  token,
  candidateSha,
  currentRun,
  nowMs = Date.now(),
) {
  const policySource = fs.readFileSync(RELEASE_POLICY_PATH, "utf8");
  const authorizationSource = fs.readFileSync(AUTHORIZATION_SOURCE_PATH, "utf8");
  const successorPolicySource = fs.readFileSync(SUCCESSOR_POLICY_PATH, "utf8");
  const policy = parseGithubReleaseChecksPolicy(policySource);
  if (policy === null || policy.repository !== REPOSITORY ||
    policy.branch !== "main" || sha256(policySource) !== RELEASE_POLICY_SHA256 ||
    !authorizationSourceExact(authorizationSource) ||
    !successorPolicyExact(successorPolicySource) ||
    !archivedV2LocalFilesExact() ||
    !archivedV3LocalFilesExact() ||
    !currentContainmentRunExact(
      currentRun,
      { GITHUB_RUN_ID: String(currentRun?.id) },
      candidateSha,
    )) fail("reviewed_candidate_invalid");
  let reviewedPullRequest;
  try {
    reviewedPullRequest = await verifyReviewedPullRequest(
      fetchImpl,
      token,
      policy,
      candidateSha,
    );
  } catch {
    fail("reviewed_candidate_invalid");
  }
  if (reviewedPullRequest.number <= 102) {
    fail("reviewed_candidate_invalid");
  }
  const ineligibleV2 = await verifyIneligibleV2Candidate(fetchImpl, token);
  const currentStartedAt = Date.parse(String(currentRun.run_started_at));
  const mergedAt = Date.parse(String(reviewedPullRequest.mergedAt));
  const ineligibleRunCompletedAt = Date.parse(INELIGIBLE_V2_RUN.completedAt);
  const failedV3RunCompletedAt = Date.parse(FAILED_V3_RUN_COMPLETED_AT);
  const expiredDeadline = Date.parse(EXPIRED_AUTHORITY_DEADLINE);
  const derivedDeadline = deriveSuccessorDeadline(
    reviewedPullRequest.mergedAt,
    currentRun.run_started_at,
  );
  const deadline = Date.parse(String(derivedDeadline));
  if (!Number.isFinite(currentStartedAt) || !Number.isFinite(mergedAt) ||
    !Number.isFinite(ineligibleRunCompletedAt) ||
    !Number.isFinite(failedV3RunCompletedAt) ||
    !Number.isFinite(expiredDeadline) ||
    !Number.isFinite(nowMs) || currentStartedAt < expiredDeadline ||
    nowMs < expiredDeadline ||
    derivedDeadline === null || !Number.isFinite(deadline) ||
    mergedAt <= ineligibleRunCompletedAt || mergedAt <= failedV3RunCompletedAt ||
    mergedAt > currentStartedAt ||
    nowMs < currentStartedAt - 5 * 60 * 1000 || nowMs >= deadline ||
    currentStartedAt >= deadline) {
    fail("reviewed_candidate_invalid");
  }
  let candidateCommit;
  let predecessorCommit;
  let v2Commit;
  let preV2Commit;
  let expiredRunHeadCommit;
  let predecessorReviewedHeadCommit;
  let predecessorPullRequest;
  let mainReference;
  try {
    [candidateCommit, predecessorCommit, v2Commit, preV2Commit,
      expiredRunHeadCommit,
      predecessorReviewedHeadCommit, predecessorPullRequest, mainReference] =
      await Promise.all([
      releaseGithubGet(
        fetchImpl,
        token,
        REPOSITORY,
        `/git/commits/${candidateSha}`,
      ),
      releaseGithubGet(
        fetchImpl,
        token,
        REPOSITORY,
        `/git/commits/${SUCCESSOR_DIRECT_PARENT_SHA}`,
      ),
      releaseGithubGet(
        fetchImpl,
        token,
        REPOSITORY,
        `/git/commits/${SUCCESSOR_DIRECT_PARENT_PARENT_SHA}`,
      ),
      releaseGithubGet(
        fetchImpl,
        token,
        REPOSITORY,
        `/git/commits/${V2_CANDIDATE_PARENT_SHA}`,
      ),
      releaseGithubGet(
        fetchImpl,
        token,
        REPOSITORY,
        `/git/commits/${EXPIRED_RUN_HEAD_SHA}`,
      ),
      releaseGithubGet(
        fetchImpl,
        token,
        REPOSITORY,
        "/git/commits/3ab064f5026a923b42bf67dbd94cb5d16f125c0d",
      ),
      releaseGithubGet(fetchImpl, token, REPOSITORY, "/pulls/98"),
      releaseGithubGet(fetchImpl, token, REPOSITORY, "/git/ref/heads/main"),
    ]);
  } catch {
    fail("reviewed_candidate_invalid");
  }
  if (!record(candidateCommit) || candidateCommit.sha !== candidateSha ||
    !record(candidateCommit.tree) ||
    candidateCommit.tree.sha !== reviewedPullRequest.treeSha ||
    !Array.isArray(candidateCommit.parents) || candidateCommit.parents.length !== 1 ||
    candidateCommit.parents[0]?.sha !== SUCCESSOR_DIRECT_PARENT_SHA ||
    !record(predecessorCommit) ||
    predecessorCommit.sha !== SUCCESSOR_DIRECT_PARENT_SHA ||
    !record(predecessorCommit.tree) ||
    predecessorCommit.tree.sha !== SUCCESSOR_DIRECT_PARENT_TREE_SHA ||
    !Array.isArray(predecessorCommit.parents) ||
    predecessorCommit.parents.length !== 1 ||
    predecessorCommit.parents[0]?.sha !== SUCCESSOR_DIRECT_PARENT_PARENT_SHA ||
    !record(v2Commit) || v2Commit.sha !== V2_CANDIDATE_SHA ||
    !record(v2Commit.tree) || v2Commit.tree.sha !== V2_CANDIDATE_TREE_SHA ||
    !Array.isArray(v2Commit.parents) || v2Commit.parents.length !== 1 ||
    v2Commit.parents[0]?.sha !== V2_CANDIDATE_PARENT_SHA ||
    !record(preV2Commit) || preV2Commit.sha !== V2_CANDIDATE_PARENT_SHA ||
    !record(preV2Commit.tree) ||
    preV2Commit.tree.sha !== PRE_V2_CANDIDATE_TREE_SHA ||
    !Array.isArray(preV2Commit.parents) || preV2Commit.parents.length !== 1 ||
    preV2Commit.parents[0]?.sha !== EXPIRED_RUN_HEAD_SHA ||
    !record(expiredRunHeadCommit) ||
    expiredRunHeadCommit.sha !== EXPIRED_RUN_HEAD_SHA ||
    !record(expiredRunHeadCommit.tree) ||
    expiredRunHeadCommit.tree.sha !== EXPIRED_RUN_HEAD_TREE_SHA ||
    !Array.isArray(expiredRunHeadCommit.parents) ||
    expiredRunHeadCommit.parents.length !== 1 ||
    expiredRunHeadCommit.parents[0]?.sha !== Q_HEAD_SHA ||
    !record(predecessorReviewedHeadCommit) ||
    predecessorReviewedHeadCommit.sha !==
      "3ab064f5026a923b42bf67dbd94cb5d16f125c0d" ||
    !record(predecessorReviewedHeadCommit.tree) ||
    predecessorReviewedHeadCommit.tree.sha !== PRE_V2_CANDIDATE_TREE_SHA ||
    !record(predecessorPullRequest) || predecessorPullRequest.number !== 98 ||
    predecessorPullRequest.state !== "closed" ||
    predecessorPullRequest.merged !== true ||
    predecessorPullRequest.merged_at !== "2026-09-08T18:23:44Z" ||
    mergedAt <= Date.parse(predecessorPullRequest.merged_at) ||
    predecessorPullRequest.merge_commit_sha !== V2_CANDIDATE_PARENT_SHA ||
    !record(predecessorPullRequest.head) ||
    predecessorPullRequest.head.sha !==
      "3ab064f5026a923b42bf67dbd94cb5d16f125c0d" ||
    !record(predecessorPullRequest.head.repo) ||
    predecessorPullRequest.head.repo.full_name !== REPOSITORY ||
    !record(predecessorPullRequest.base) ||
    predecessorPullRequest.base.ref !== "main" ||
    predecessorPullRequest.base.sha !== EXPIRED_RUN_HEAD_SHA ||
    !record(predecessorPullRequest.base.repo) ||
    predecessorPullRequest.base.repo.full_name !== REPOSITORY ||
    !record(predecessorPullRequest.user) ||
    predecessorPullRequest.user.id !== 29029791 ||
    !record(predecessorPullRequest.merged_by) ||
    predecessorPullRequest.merged_by.id !== 29029791 ||
    !record(mainReference) || mainReference.ref !== "refs/heads/main" ||
    !record(mainReference.object) || mainReference.object.type !== "commit" ||
    mainReference.object.sha !== candidateSha) {
    fail("reviewed_candidate_invalid");
  }
  const workflowRuns = new Map();
  const checks = [];
  for (const requirement of policy.requiredChecks.base) {
    let candidates;
    try {
      candidates = selectCheckRunCandidates(
        await releaseGithubGet(
          fetchImpl,
          token,
          REPOSITORY,
          `/commits/${candidateSha}/check-runs?filter=all&check_name=` +
            `${encodeURIComponent(requirement.name)}&per_page=100`,
        ),
        requirement,
        candidateSha,
      );
    } catch {
      fail("reviewed_candidate_invalid");
    }
    const intended = [];
    for (const candidate of candidates) {
      let run = workflowRuns.get(candidate.runId);
      if (run === undefined) {
        try {
          run = await releaseGithubGet(
            fetchImpl,
            token,
            REPOSITORY,
            `/actions/runs/${candidate.runId}`,
          );
        } catch {
          fail("reviewed_candidate_invalid");
        }
        workflowRuns.set(candidate.runId, run);
      }
      try {
        const selected = validateWorkflowRun(
          run,
          candidate,
          requirement,
          policy,
          candidateSha,
        );
        if (selected !== null) intended.push(selected);
      } catch {
        fail("reviewed_candidate_invalid");
      }
    }
    if (intended.length !== 1 ||
      Date.parse(intended[0].startedAt) < mergedAt ||
      Date.parse(intended[0].completedAt) >= currentStartedAt) {
      fail("reviewed_candidate_invalid");
    }
    checks.push(intended[0]);
  }
  if (checks.length !== 8) fail("reviewed_candidate_invalid");
  const checkByName = new Map(checks.map((check) => [check.name, check]));
  const artifactPayloadByRun = new Map();
  const artifacts = [];
  for (const requirement of policy.requiredArtifacts.base) {
    const producer = checkByName.get(requirement.producerCheck);
    if (producer === undefined) fail("reviewed_candidate_invalid");
    let payload = artifactPayloadByRun.get(producer.runId);
    if (payload === undefined) {
      try {
        payload = await releaseGithubGet(
          fetchImpl,
          token,
          REPOSITORY,
          `/actions/runs/${producer.runId}/artifacts?per_page=100`,
        );
      } catch {
        fail("reviewed_candidate_invalid");
      }
      artifactPayloadByRun.set(producer.runId, payload);
    }
    try {
      artifacts.push(selectArtifact(
        payload,
        {
          ...requirement,
          name: requirement.name.replaceAll("{candidateSha}", candidateSha),
        },
        candidateSha,
        producer.runId,
        REPOSITORY,
      ));
    } catch {
      fail("reviewed_candidate_invalid");
    }
  }
  if (artifacts.length !== 3) fail("reviewed_candidate_invalid");
  return Object.freeze({
    schemaVersion: POST_Q_REVIEWED_CANDIDATE_V4_SCHEMA,
    repository: REPOSITORY,
    branch: "main",
    candidateSha,
    reviewedPullRequest,
    releasePolicySha256: sha256(policySource),
    successorPolicySha256: sha256(successorPolicySource),
    directParentSha: SUCCESSOR_DIRECT_PARENT_SHA,
    ineligibleV2,
    predecessorBridge: {
      candidateSha: SUCCESSOR_DIRECT_PARENT_SHA,
      treeSha: SUCCESSOR_DIRECT_PARENT_TREE_SHA,
      soleParentSha: SUCCESSOR_DIRECT_PARENT_PARENT_SHA,
      v2CandidateSha: V2_CANDIDATE_SHA,
      v2TreeSha: V2_CANDIDATE_TREE_SHA,
      v2SoleParentSha: V2_CANDIDATE_PARENT_SHA,
      preV2CandidateSha: V2_CANDIDATE_PARENT_SHA,
      preV2TreeSha: PRE_V2_CANDIDATE_TREE_SHA,
      preV2SoleParentSha: EXPIRED_RUN_HEAD_SHA,
      recoveryCandidateSha: EXPIRED_RUN_HEAD_SHA,
      recoveryTreeSha: EXPIRED_RUN_HEAD_TREE_SHA,
      recoverySoleParentSha: Q_HEAD_SHA,
      preV2PullRequestNumber: 98,
      preV2ReviewedPrHeadSha: "3ab064f5026a923b42bf67dbd94cb5d16f125c0d",
      preV2MergeCommitSha: V2_CANDIDATE_PARENT_SHA,
      preV2BaseSha: EXPIRED_RUN_HEAD_SHA,
      preV2MergedAt: "2026-09-08T18:23:44Z",
      preV2GithubMergeExact: true,
      preV2ReviewedTreeExact: true,
      linearHistoryExact: true,
    },
    authorization: authorizationEvidence(),
    deadlinePolicy: {
      explicitExpiry: SUCCESSOR_EXPLICIT_EXPIRY,
      maximumAfterPullRequestMergeSeconds: MAX_AFTER_MERGE_MS / 1_000,
      maximumAfterRunStartSeconds: MAX_AFTER_RUN_START_MS / 1_000,
      derivedDeadline,
      derivation:
        "min(pull_request_merged_at_plus_4h,current_run_started_at_plus_90m,explicit_expiry)",
      rederiveImmediatelyBeforeWriter: true,
      expirySuppressesPostWriteReconciliation: false,
      expirySuppressesFinalization: false,
    },
    currentContainmentRun: {
      runId: String(currentRun.id),
      workflowId: currentRun.workflow_id,
      workflowPath: CONTAINMENT_WORKFLOW_PATH,
      runAttempt: 1,
      runStartedAt: currentRun.run_started_at,
    },
    requiredChecks: checks,
    requiredArtifacts: artifacts,
    checks: {
      mergedPullRequestAndTreeExact: true,
      soleParentSquashShapeExact: true,
      directParentExact: true,
      ineligibleV2Attempt1Exact: true,
      archivedV2BytesAndBlobExact: true,
      archivedV3BytesAndBlobExact: true,
      archivedV3RunCompletedBeforeMergeExact: true,
      predecessorBridgeExact: true,
      currentMainTipExact: true,
      noLaterMainDriftExact: true,
      baseRequiredCheckLineageExact: true,
      baseRequiredArtifactsExact: true,
      chronologyExact: true,
      deadlineDerivedExact: true,
      authorizationProvenanceExact: true,
      expiredAuthorityNotReusedExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

export function qRunExact(value) {
  return record(value) && value.id === Number(Q_RUN_ID) &&
    value.workflow_id === Q_WORKFLOW_ID && value.run_number === Q_RUN_NUMBER &&
    value.run_attempt === 1 && value.name === Q_TITLE &&
    value.display_title === Q_TITLE && value.event === "workflow_dispatch" &&
    value.status === "completed" && value.conclusion === "failure" &&
    value.head_branch === "main" && value.head_sha === Q_HEAD_SHA &&
    value.path === Q_WORKFLOW_PATH &&
    value.created_at === "2026-09-08T13:04:29Z" &&
    value.run_started_at === "2026-09-08T13:04:29Z" &&
    value.updated_at === "2026-09-08T13:10:47Z" &&
    record(value.repository) && value.repository.id === REPOSITORY_ID &&
    value.repository.full_name === REPOSITORY;
}

function targetStepsExact(steps) {
  return Array.isArray(steps) && steps.length === Q_TARGET_STEPS.length &&
    steps.every((step, index) => {
      const expected = Q_TARGET_STEPS[index];
      return record(step) && step.number === expected[0] &&
        step.name === expected[1] && step.status === "completed" &&
        step.conclusion === expected[2];
    }) &&
    steps[16]?.started_at === "2026-09-08T13:08:52Z" &&
    steps[16]?.completed_at === "2026-09-08T13:08:57Z" &&
    steps[17]?.started_at === "2026-09-08T13:08:57Z" &&
    steps[17]?.completed_at === "2026-09-08T13:10:42Z" &&
    steps[20]?.started_at === "2026-09-08T13:10:42Z" &&
    steps[20]?.completed_at === "2026-09-08T13:10:42Z" &&
    steps[21]?.started_at === "2026-09-08T13:10:42Z" &&
    steps[21]?.completed_at === "2026-09-08T13:10:43Z";
}

export function qJobsExact(value) {
  if (!record(value) || value.total_count !== 4 || !Array.isArray(value.jobs) ||
    value.jobs.length !== 4) return false;
  const target = value.jobs.find((job) => job?.id === Q_JOB_ID);
  if (!record(target) || target.name !== Q_JOB_NAME ||
    target.run_attempt !== 1 || target.status !== "completed" ||
    target.conclusion !== "failure" ||
    target.started_at !== "2026-09-08T13:04:34Z" ||
    target.completed_at !== "2026-09-08T13:10:46Z" ||
    !targetStepsExact(target.steps)) return false;
  return Q_SKIPPED_JOBS.every((expected) => {
    const job = value.jobs.find((candidate) => candidate?.id === expected.id);
    return record(job) && job.name === expected.name && job.run_attempt === 1 &&
      job.status === "completed" && job.conclusion === "skipped" &&
      Array.isArray(job.steps) && job.steps.length === 0;
  }) && new Set(value.jobs.map((job) => job.id)).size === 4;
}

export function qArtifactExact(value) {
  return record(value) && value.id === Number(Q_ARTIFACT_ID) &&
    value.name === Q_ARTIFACT_NAME && value.size_in_bytes === 12561 &&
    value.digest === Q_ARTIFACT_DIGEST && value.expired === false &&
    value.created_at === "2026-09-08T13:10:43Z" &&
    value.updated_at === "2026-09-08T13:10:43Z" &&
    value.expires_at === "2026-10-08T13:10:42Z" &&
    record(value.workflow_run) &&
    value.workflow_run.id === Number(Q_RUN_ID) &&
    value.workflow_run.repository_id === REPOSITORY_ID &&
    value.workflow_run.head_repository_id === REPOSITORY_ID &&
    value.workflow_run.head_branch === "main" &&
    value.workflow_run.head_sha === Q_HEAD_SHA;
}

function walk(root, current = root, files = [], directories = []) {
  const currentStat = fs.lstatSync(current);
  if (currentStat.isSymbolicLink()) fail("artifact_files_invalid");
  if (!currentStat.isDirectory()) fail("artifact_files_invalid");
  if (current !== root) directories.push(path.relative(root, current));
  for (const entry of fs.readdirSync(current).sort()) {
    const entryPath = path.join(current, entry);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) fail("artifact_files_invalid");
    if (stat.isDirectory()) walk(root, entryPath, files, directories);
    else if (stat.isFile()) files.push(path.relative(root, entryPath));
    else fail("artifact_files_invalid");
  }
  return { files, directories };
}

function sameHeldArtifactFile(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function readHeldArtifactMember(filename, expectedSizeBytes) {
  if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0 ||
    typeof fs.constants.O_NOFOLLOW !== "number" ||
    fs.constants.O_NOFOLLOW <= 0 ||
    typeof fs.constants.O_NONBLOCK !== "number" ||
    fs.constants.O_NONBLOCK <= 0) fail("artifact_files_invalid");
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      filename,
      fs.constants.O_RDONLY |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n ||
      before.size !== BigInt(expectedSizeBytes)) fail("artifact_files_invalid");
    const bytes = Buffer.alloc(expectedSizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!Number.isSafeInteger(count) || count <= 0) {
        fail("artifact_files_invalid");
      }
      offset += count;
    }
    const overflow = Buffer.alloc(1);
    if (fs.readSync(descriptor, overflow, 0, 1, offset) !== 0) {
      fail("artifact_files_invalid");
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameHeldArtifactFile(before, after)) fail("artifact_files_invalid");
    return bytes;
  } catch {
    fail("artifact_files_invalid");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function writeExclusive(filename, source, mode = 0o600) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
    mode,
  );
  try {
    fs.writeFileSync(descriptor, source);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function sealPostQArtifact(
  downloadedDirectory,
  outputDirectory,
  expectedMembers = POST_Q_ARTIFACT_MEMBERS,
) {
  const outputStat = fs.lstatSync(outputDirectory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink() ||
    (outputStat.mode & 0o077) !== 0 ||
    fs.realpathSync(path.dirname(downloadedDirectory)) !==
      fs.realpathSync(outputDirectory)) fail("artifact_files_invalid");
  const inventory = walk(downloadedDirectory);
  const expectedPaths = expectedMembers.map((member) => member.path).sort();
  if (JSON.stringify(inventory.files) !== JSON.stringify(expectedPaths)) {
    fail("artifact_files_invalid");
  }
  const allowedDirectories = new Set(expectedPaths.flatMap((memberPath) => {
    const segments = memberPath.split("/");
    return segments.slice(0, -1).map((_, index) =>
      segments.slice(0, index + 1).join("/"));
  }));
  if (inventory.directories.some((directory) => !allowedDirectories.has(directory))) {
    fail("artifact_files_invalid");
  }
  const sealedDirectory = path.join(outputDirectory, "sealed");
  fs.mkdirSync(sealedDirectory, { mode: 0o700 });
  const members = [];
  for (const expected of expectedMembers) {
    const sourcePath = path.join(downloadedDirectory, expected.path);
    const source = readHeldArtifactMember(sourcePath, expected.sizeBytes);
    if (source.byteLength !== expected.sizeBytes ||
      sha256(source) !== expected.sha256) fail("artifact_files_invalid");
    const destination = path.join(sealedDirectory, expected.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    writeExclusive(destination, source, 0o400);
    if (!fs.readFileSync(destination).equals(source)) {
      fail("artifact_files_invalid");
    }
    members.push({ ...expected, sealedPath: expected.path });
  }
  return Object.freeze({ sealedDirectory, members: Object.freeze(members) });
}

// The archived V3 artifacts are immutable no-write evidence, not input to the
// V4 writer.  Authenticate their downloaded bytes in place so the apply job can
// repeat this check at reauthentication and prewrite without mutating custody.
export function verifyDownloadedArtifact(
  downloadedDirectory,
  expectedMembers,
) {
  const downloadedStat = fs.lstatSync(downloadedDirectory);
  if (!downloadedStat.isDirectory() || downloadedStat.isSymbolicLink()) {
    fail("artifact_files_invalid");
  }
  const inventory = walk(downloadedDirectory);
  const expectedPaths = expectedMembers.map((member) => member.path).sort();
  if (JSON.stringify(inventory.files) !== JSON.stringify(expectedPaths)) {
    fail("artifact_files_invalid");
  }
  const allowedDirectories = new Set(expectedPaths.flatMap((memberPath) => {
    const segments = memberPath.split("/");
    return segments.slice(0, -1).map((_, index) =>
      segments.slice(0, index + 1).join("/"));
  }));
  if (inventory.directories.some((directory) =>
    !allowedDirectories.has(directory))) fail("artifact_files_invalid");
  const members = expectedMembers.map((expected) => {
    const sourcePath = path.join(downloadedDirectory, expected.path);
    const source = readHeldArtifactMember(sourcePath, expected.sizeBytes);
    if (source.byteLength !== expected.sizeBytes ||
      sha256(source) !== expected.sha256) fail("artifact_files_invalid");
    return Object.freeze({ ...expected, sealedPath: expected.path });
  });
  return Object.freeze({ members: Object.freeze(members) });
}

export async function verifyPermanentStagingPostQAuthorityV4(
  overrides = {},
) {
  const dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    fetchImpl: fetch,
    now: () => Date.now(),
    sealArtifact: sealPostQArtifact,
    verifyArchivedArtifact: verifyDownloadedArtifact,
    verifyCandidate: verifyPostQReviewedCandidate,
    historicalWorkflowExact: historicalWorkflowBlobExact,
    historicalV3WorkflowExact: archivedV3WorkflowExact,
    writeAuthority: writeExclusive,
    writeReviewedCandidate: writeExclusive,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const args = parseArguments(dependencies.argv);
  if (args === null) fail("arguments_invalid");
  if (!environmentExact(dependencies.env, args.candidateSha)) {
    fail("environment_invalid");
  }

  const [run, jobs, artifact, currentRun] = await Promise.all([
    githubGet(
      dependencies.fetchImpl,
      dependencies.env,
      `/repos/${REPOSITORY}/actions/runs/${Q_RUN_ID}`,
    ),
    githubGet(
      dependencies.fetchImpl,
      dependencies.env,
      `/repos/${REPOSITORY}/actions/runs/${Q_RUN_ID}/jobs?per_page=100`,
    ),
    githubGet(
      dependencies.fetchImpl,
      dependencies.env,
      `/repos/${REPOSITORY}/actions/artifacts/${Q_ARTIFACT_ID}`,
    ),
    githubGet(
      dependencies.fetchImpl,
      dependencies.env,
      `/repos/${REPOSITORY}/actions/runs/${dependencies.env.GITHUB_RUN_ID}`,
    ),
  ]);
  if (!qRunExact(run) || !qJobsExact(jobs) || !qArtifactExact(artifact)) {
    fail("github_authority_invalid");
  }
  const containment = await verifyContainmentSingleUseAuthority(
    dependencies.fetchImpl,
    dependencies.env,
    args.candidateSha,
    currentRun,
    args.phase,
    dependencies.historicalWorkflowExact,
    dependencies.historicalV3WorkflowExact,
  );
  const reviewedCandidate = await dependencies.verifyCandidate(
    dependencies.fetchImpl,
    dependencies.env.GITHUB_TOKEN,
    args.candidateSha,
    currentRun,
  );
  if (!record(reviewedCandidate) ||
    reviewedCandidate.schemaVersion !== POST_Q_REVIEWED_CANDIDATE_V4_SCHEMA) {
    fail("reviewed_candidate_invalid");
  }
  const sealed = dependencies.sealArtifact(
    args.downloadedDirectory,
    args.outputDirectory,
  );
  if (!record(sealed) || typeof sealed.sealedDirectory !== "string" ||
    !Array.isArray(sealed.members) || sealed.members.length !== 5) {
    fail("artifact_files_invalid");
  }
  const failedV3Intent = dependencies.verifyArchivedArtifact(
    args.failedV3IntentDownloadedDirectory,
    [FAILED_V3_INTENT_ARTIFACT_MEMBER],
  );
  const failedV3Evidence = dependencies.verifyArchivedArtifact(
    args.failedV3EvidenceDownloadedDirectory,
    [FAILED_V3_TERMINAL_ARTIFACT_MEMBER],
  );
  if (!record(failedV3Intent) || !Array.isArray(failedV3Intent.members) ||
    failedV3Intent.members.length !== 1 || !record(failedV3Evidence) ||
    !Array.isArray(failedV3Evidence.members) ||
    failedV3Evidence.members.length !== 1) fail("artifact_files_invalid");
  const authority = {
    schemaVersion: POST_Q_AUTHORITY_V4_SCHEMA,
    operation: "post-q-deployment-stop-containment-v4",
    repository: REPOSITORY,
    candidateSha: args.candidateSha,
    currentRunId: dependencies.env.GITHUB_RUN_ID,
    currentRunAttempt: 1,
    authorization: authorizationEvidence(),
    archivedV2: archivedV2Evidence(),
    archivedV3: {
      ...containment.archivedV3,
      downloadedMembers: [
        failedV3Intent.members[0],
        failedV3Evidence.members[0],
      ],
      artifactBytesExact: true,
    },
    expiredAuthority: containment.expiredAuthority,
    currentWorkflow: containment.currentWorkflow,
    failedQ: {
      runId: Q_RUN_ID,
      runAttempt: 1,
      workflowId: Q_WORKFLOW_ID,
      workflowPath: Q_WORKFLOW_PATH,
      headSha: Q_HEAD_SHA,
      conclusion: "failure",
      writerAttemptedOnce: true,
      configuredZeroReached: false,
      reinterpretAsZeroAllowed: false,
    },
    artifact: {
      id: Q_ARTIFACT_ID,
      name: Q_ARTIFACT_NAME,
      digest: Q_ARTIFACT_DIGEST,
      sizeBytes: 12561,
      members: sealed.members,
    },
    qMutationDisposition: {
      attempts: 1,
      retryAllowed: false,
      acknowledgementExact: true,
      configuredZeroReached: false,
      reinterpretAsZeroAllowed: false,
    },
    checks: {
      currentDispatchExact: true,
      qRunExact: true,
      qFourJobInventoryExact: true,
      qArtifactMetadataExact: true,
      qFiveMemberCustodyExact: true,
      expiredWorkflowHistoryExact: true,
      expiredWriterAbsentExact: true,
      expiredAuthorityNotReusedExact: true,
      successorSingleUseExact: true,
      successorWriterNotStartedExact: true,
      authorizationProvenanceExact: true,
      archivedV2BytesAndBlobExact: true,
      archivedV2CandidateIneligibleExact: true,
      archivedV3BytesAndBlobExact: true,
      archivedV3RunAndJobsExact: true,
      archivedV3ArtifactsAndMembersExact: true,
      evidenceSecretFreeExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
  const source = canonical(authority);
  const authorityPath = path.join(args.outputDirectory, "q-authority.json");
  dependencies.writeAuthority(authorityPath, source, 0o400);
  const reviewedCandidateSource = canonical(reviewedCandidate);
  const reviewedCandidatePath = path.join(
    args.outputDirectory,
    "reviewed-containment-authority.json",
  );
  dependencies.writeReviewedCandidate(
    reviewedCandidatePath,
    reviewedCandidateSource,
    0o400,
  );
  dependencies.writeOutput(canonical({
    ok: true,
    authorityPath,
    authoritySha256: sha256(source),
    reviewedCandidatePath,
    reviewedCandidateSha256: sha256(reviewedCandidateSource),
    sealedDirectory: sealed.sealedDirectory,
  }));
  return Object.freeze({
    authority,
    authorityPath,
    authoritySha256: sha256(source),
    reviewedCandidate,
    reviewedCandidatePath,
    reviewedCandidateSha256: sha256(reviewedCandidateSource),
    sealedDirectory: sealed.sealedDirectory,
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  verifyPermanentStagingPostQAuthorityV4().catch((error) => {
    const message = error instanceof Error ? error.message : "post_q_authority_failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
