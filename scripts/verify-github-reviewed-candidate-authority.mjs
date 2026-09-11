import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  githubGet,
  parseGithubReleaseChecksPolicy,
  verifyReviewedPullRequest,
} from "./verify-github-release-candidate.mjs";

const POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.github/release-required-checks.json",
);
const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const MAX_HISTORY_PAGES = 10;
const MAX_CANDIDATE_AGE_HOURS = 7 * 24;
const MAX_CANDIDATE_AGE_MS = MAX_CANDIDATE_AGE_HOURS * 60 * 60 * 1000;
const RECOVERY_GRACE_HOURS = 24;
const RECOVERY_GRACE_MS = RECOVERY_GRACE_HOURS * 60 * 60 * 1000;
const PRODUCTION_POSTGRES_SOURCE_REPIN_RECOVERY_SETTLEMENT_MS = 60_000;
const PRODUCTION_POSTGRES_SOURCE_REPIN_INCIDENT_RECOVERY_GRACE_HOURS = 7 * 24;
const PRODUCTION_POSTGRES_SOURCE_REPIN_INCIDENT_RECOVERY_GRACE_MS =
  PRODUCTION_POSTGRES_SOURCE_REPIN_INCIDENT_RECOVERY_GRACE_HOURS * 60 * 60 * 1000;
const PRODUCTION_POSTGRES_SOURCE_REPIN_RECOVERY_BRIDGE = Object.freeze({
  priorCandidateSha: "52049a1ef414e274e47197e28726387c90d96990",
  priorReviewedHeadSha: "b4326474f809d7eff1402d803c61e065abc441b3",
  priorTreeSha: "250da7d4f74818a7a7fc9faf499c2a4530e617ec",
  priorPullRequestNumber: 81,
  priorMergedAt: "2026-09-04T22:02:05Z",
  candidateSha: "4edaddbee03e44f7d2e0cb808b2357e7e5739db5",
  reviewedHeadSha: "baa113bb975be6041d5cd7d7828c41aceb2f065c",
  treeSha: "337cf37c8beccb7f228cf042b676f0934e7a479e",
  pullRequestNumber: 83,
  mergedAt: "2026-09-05T23:58:45Z",
  skippedWriterRunId: "34000245292",
  skippedWriterRunCreatedAt: "2026-09-06T00:02:38Z",
  skippedWriterRunStartedAt: "2026-09-06T00:02:38Z",
  skippedWriterRunCompletedAt: "2026-09-06T00:06:44Z",
  skippedWriterRunConclusion: "failure",
  stagedRecoveryCandidateSha:
    "e4ae715f997a14aec247c50e1b21f69c78de0fd0",
  stagedRecoveryReviewedHeadSha:
    "6dc8706ee7619f64c37f3f9ff8c4b1b9c6cdea30",
  stagedRecoveryTreeSha:
    "b4fa974a84321266264919f5d4ea105bd1585549",
  stagedRecoveryPullRequestNumber: 84,
  stagedRecoveryMergedAt: "2026-09-06T09:36:26Z",
  stagedRecoveryRunId: "34025400175",
  stagedRecoveryRunCreatedAt: "2026-09-06T09:42:18Z",
  stagedRecoveryRunStartedAt: "2026-09-06T09:42:18Z",
  stagedRecoveryRunCompletedAt: "2026-09-06T09:47:28Z",
  stagedRecoveryRunConclusion: "failure",
  stagedRecoveryArtifactId: 9986949361,
  stagedRecoveryArtifactName:
    "pintpath-production-postgres-source-lock-reconcile-e4ae715f997a14aec247c50e1b21f69c78de0fd0-34025400175",
  stagedRecoveryArtifactDigest:
    "sha256:a48e945315ded8de15dabe89e77c5ce34f4b17f9b66aeb5c41ff05212016224f",
  stagedRecoveryArtifactBytes: 4442,
  stagedRecoveryArtifactCreatedAt: "2026-09-06T09:47:25Z",
  stagedRecoverySettlementSeconds: 60,
  stagedRecoveryGraceHours: 168,
  postStageBridgeCandidateSha:
    "82d149681d9716f6964a05b80d0c50adbdf7d24a",
  postStageBridgeReviewedHeadSha:
    "90c1fa5ba7327bf01bac833063a1dfcbff772d2e",
  postStageBridgeTreeSha:
    "7b0968d8986ed3ae9af68fc94804a7fa24cbd0f9",
  postStageBridgePullRequestNumber: 85,
  postStageBridgeMergedAt: "2026-09-07T10:32:27Z",
  postStageBridgeSkippedWriterRunId: "34113262642",
  postStageBridgeSkippedWriterRunCreatedAt: "2026-09-07T10:47:19Z",
  postStageBridgeSkippedWriterRunStartedAt: "2026-09-07T10:47:19Z",
  postStageBridgeSkippedWriterRunCompletedAt: "2026-09-07T10:51:22Z",
  postStageBridgeSkippedWriterRunConclusion: "failure",
  finalZeroWriteBridgeCandidateSha: "b41d0314c155f5f9953a7dd17c195afa9aa97b9c",
  finalZeroWriteBridgeReviewedHeadSha:
    "dc048e8783134b529d58dea302fbfaec067d3216",
  finalZeroWriteBridgeTreeSha: "5fa5599dedbc32867c0c3eb14f200afc2a993283",
  finalZeroWriteBridgePullRequestNumber: 87,
  finalZeroWriteBridgeMergedAt: "2026-09-07T11:53:25Z",
  finalZeroWriteRunId: "34118981931",
  finalZeroWriteRunCreatedAt: "2026-09-07T11:54:00Z",
  finalZeroWriteRunStartedAt: "2026-09-07T11:54:00Z",
  finalZeroWriteRunCompletedAt: "2026-09-07T11:58:19Z",
  finalZeroWriteRunConclusion: "failure",
  finalZeroWriteSettlementSeconds: 60,
  finalZeroWriteArtifactId: 10017539632,
  finalZeroWriteArtifactName:
    "pintpath-production-postgres-source-lock-reconcile-b41d0314c155f5f9953a7dd17c195afa9aa97b9c-34118981931",
  finalZeroWriteArtifactDigest:
    "sha256:f0c5751504b52d3f13b8f3763a2293768b847ea5b96f5f9e57a6b527a6b1d0bb",
  finalZeroWriteArtifactBytes: 4611,
  finalZeroWriteArtifactCreatedAt: "2026-09-07T11:58:16Z",
});
const COLD_QUIESCE_SUCCESSOR_OPERATION =
  "cold-recovery-successor-quiesce";
const CURRENT_COLD_QUIESCE_JOB_NAME =
  "Quiesce the configured Europe replica from one to zero";
const CURRENT_COLD_QUIESCE_WRITE_STEP =
  "Quiesce the configured Europe replica from one to zero once";
const LEGACY_AMBIGUOUS_COLD_QUIESCE_JOB_NAME =
  "Initialize the exact dead baseline at explicit zero";
const LEGACY_AMBIGUOUS_COLD_QUIESCE_WRITE_STEP =
  "Initialize the dead baseline from null to explicit zero once";
const COLD_QUIESCE_SUCCESSOR_BRIDGE = Object.freeze({
  legacyCandidateSha: "838e8c877dcafc0a822a12e5a26afa81c26924a3",
  legacyReviewedHeadSha: "cc2c5311d47f3e895173cb11ef094ef856e0cf07",
  legacyTreeSha: "9da75485e85addfec7096b1c04c52f6780d17b64",
  legacyPullRequestNumber: 90,
  legacyMergedAt: "2026-09-07T18:18:58Z",
  prepareRunId: 34152745186,
  prepareRunCreatedAt: "2026-09-07T18:43:02Z",
  prepareRunStartedAt: "2026-09-07T18:43:02Z",
  prepareRunCompletedAt: "2026-09-07T18:47:32Z",
  ambiguousQuiesceRunId: 34153306935,
  ambiguousQuiesceRunCreatedAt: "2026-09-07T18:51:21Z",
  ambiguousQuiesceRunStartedAt: "2026-09-07T18:51:21Z",
  ambiguousQuiesceRunCompletedAt: "2026-09-07T18:57:20Z",
  successorGraceHours: 24,
  successorDeadline: "2026-09-08T18:57:20.000Z",
  failedReadOnlyReconcileRunId: 34154020478,
  failedReadOnlyReconcileRunCreatedAt: "2026-09-07T19:02:23Z",
  failedReadOnlyReconcileRunStartedAt: "2026-09-07T19:02:23Z",
  failedReadOnlyReconcileRunCompletedAt: "2026-09-07T19:06:38Z",
  intermediateCandidateSha: "919cbbc9ed4a5bb1d99bc2624f5b534e31ddb604",
  intermediateReviewedHeadSha:
    "a8448524162c36da3d220c4b8aa21dd42cb11535",
  intermediateTreeSha: "06257eba9476e393fe54b70395af8641f8b6d59a",
  intermediatePullRequestNumber: 91,
  intermediateMergedAt: "2026-09-08T02:22:51Z",
  intermediateAmbiguousPrepareRunId: 34180322982,
  intermediateAmbiguousPrepareRunCreatedAt: "2026-09-08T02:31:01Z",
  intermediateAmbiguousPrepareRunStartedAt: "2026-09-08T02:31:01Z",
  intermediateAmbiguousPrepareRunCompletedAt: "2026-09-08T02:36:30Z",
  intermediateFailedReadOnlyPrepareReconcileRunId: 34181145015,
  intermediateFailedReadOnlyPrepareReconcileRunCreatedAt:
    "2026-09-08T02:45:16Z",
  intermediateFailedReadOnlyPrepareReconcileRunStartedAt:
    "2026-09-08T02:45:16Z",
  intermediateFailedReadOnlyPrepareReconcileRunCompletedAt:
    "2026-09-08T02:48:59Z",
  failedSuccessorCandidateSha:
    "1161e7ecd421556b104bcae059e8764ebf4a545e",
  failedSuccessorReviewedHeadSha:
    "23f6b96154de7a0eb5a0cc90136d3796a1301668",
  failedSuccessorTreeSha:
    "8a58c3eb755a68a2c456a5abff34fa7c01a9af3e",
  failedSuccessorPullRequestNumber: 93,
  failedSuccessorMergedAt: "2026-09-08T04:04:40Z",
  failedSuccessorPrepareRunId: 34186355641,
  failedSuccessorPrepareRunCreatedAt: "2026-09-08T04:15:27Z",
  failedSuccessorPrepareRunStartedAt: "2026-09-08T04:15:27Z",
  failedSuccessorPrepareRunCompletedAt: "2026-09-08T04:20:00Z",
  failedSuccessorQuiesceRunId: 34186930666,
  failedSuccessorQuiesceRunCreatedAt: "2026-09-08T04:25:21Z",
  failedSuccessorQuiesceRunStartedAt: "2026-09-08T04:25:21Z",
  failedSuccessorQuiesceRunCompletedAt: "2026-09-08T04:32:27Z",
  failedSuccessorArtifactId: 10040956324,
  failedSuccessorArtifactName:
    "pintpath-permanent-staging-cold-quiesce-1161e7ecd421556b104bcae059e8764ebf4a545e",
  failedSuccessorArtifactDigest:
    "sha256:3db418b86eea098ff4cf8c3a5198ac445d5a51c2f0ac7481dce288027c70166e",
  failedSuccessorArtifactBytes: 8155,
  failedSuccessorArtifactCreatedAt: "2026-09-08T04:32:24Z",
  failedSuccessorArtifactExpiresAt: "2026-10-08T04:32:22Z",
  failedPrewriteCandidateSha:
    "de35797a41640a996971af0b1ad49e3c5372baa8",
  failedPrewriteReviewedHeadSha:
    "546b32711971666c9074d6c6bd0d2556f76f4bb6",
  failedPrewriteTreeSha:
    "efe8319526c25f28b6bcb8cc44bd559d0eed98e7",
  failedPrewritePullRequestNumber: 95,
  failedPrewriteMergedAt: "2026-09-08T11:10:55Z",
  failedPrewriteReplacementRunId: 34220577080,
  failedPrewriteReplacementRunStartedAt: "2026-09-08T11:25:07Z",
  failedPrewriteReplacementRunCompletedAt: "2026-09-08T11:29:56Z",
  failedPrewritePrepareRunId: 34221196430,
  failedPrewritePrepareRunCreatedAt: "2026-09-08T11:32:06Z",
  failedPrewritePrepareRunStartedAt: "2026-09-08T11:32:06Z",
  failedPrewritePrepareRunCompletedAt: "2026-09-08T11:36:40Z",
  failedPrewriteQuiesceRunId: 34221811602,
  failedPrewriteQuiesceRunCreatedAt: "2026-09-08T11:39:07Z",
  failedPrewriteQuiesceRunStartedAt: "2026-09-08T11:39:07Z",
  failedPrewriteQuiesceRunCompletedAt: "2026-09-08T11:44:07Z",
  failedPrewriteArtifactId: 10054211585,
  failedPrewriteArtifactName:
    "pintpath-permanent-staging-cold-quiesce-de35797a41640a996971af0b1ad49e3c5372baa8",
  failedPrewriteArtifactDigest:
    "sha256:bbc8716da1caf68cc39307ac0cb2a07f1066b6cbb5d8159fbf56e0fe552e4ee0",
  failedPrewriteArtifactBytes: 2920,
  failedPrewriteArtifactCreatedAt: "2026-09-08T11:44:03Z",
  failedPrewriteArtifactExpiresAt: "2026-10-08T11:44:02Z",
  priorCandidateSha: "1161e7ecd421556b104bcae059e8764ebf4a545e",
  priorReviewedHeadSha: "23f6b96154de7a0eb5a0cc90136d3796a1301668",
  priorTreeSha: "8a58c3eb755a68a2c456a5abff34fa7c01a9af3e",
  priorPullRequestNumber: 93,
  priorMergedAt: "2026-09-08T04:04:40Z",
  priorPrepareRunId: 34186355641,
  priorQuiesceRunId: 34186930666,
  priorQuiesceRunCompletedAt: "2026-09-08T04:32:27Z",
  artifactId: 10030213299,
  artifactName:
    "pintpath-permanent-staging-cold-quiesce-838e8c877dcafc0a822a12e5a26afa81c26924a3",
  artifactDigest:
    "sha256:3f830a7376e604a46e0d8cfe3521fc8eb4e1db444ab73bec4063c22442c42fbe",
  artifactBytes: 4507,
  artifactCreatedAt: "2026-09-07T18:57:18Z",
  artifactExpiresAt: "2026-10-07T18:57:18Z",
});
const NONTERMINAL_RUN_STATUSES = new Set([
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
]);
const REPOSITORY = "blackmagic30/Beer";
const PROVIDER_WORKFLOW_PATH =
  ".github/workflows/permanent-staging-provider-mutation.yml";
const PROVIDER_WORKFLOW_ID = "permanent-staging-provider-mutation.yml";
const CUTOVER_WORKFLOW_PATH =
  ".github/workflows/permanent-staging-supabase-legacy-cutover.yml";
const CUTOVER_WORKFLOW_ID = "permanent-staging-supabase-legacy-cutover.yml";
const RUNTIME_VARIABLE_WORKFLOW_PATH =
  ".github/workflows/configure-runtime-variable.yml";
const RUNTIME_VARIABLE_WORKFLOW_ID = "configure-runtime-variable.yml";
const COLD_RECOVERY_WORKFLOW_PATH =
  ".github/workflows/recover-permanent-staging-cold-zero.yml";
const COLD_RECOVERY_WORKFLOW_ID =
  "recover-permanent-staging-cold-zero.yml";
const STAGING_BOOTSTRAP_WORKFLOW_PATH =
  ".github/workflows/bootstrap-permanent-staging-worker-fence.yml";
const STAGING_BOOTSTRAP_WORKFLOW_ID =
  "bootstrap-permanent-staging-worker-fence.yml";
const WORKER_FENCE_WORKFLOW_PATH =
  ".github/workflows/configure-automatic-maintenance-worker-fence.yml";
const WORKER_FENCE_WORKFLOW_ID =
  "configure-automatic-maintenance-worker-fence.yml";
const DEPLOYMENT_WORKFLOW_PATH =
  ".github/workflows/deploy-permanent-staging.yml";
const DEPLOYMENT_WORKFLOW_ID = "deploy-permanent-staging.yml";
const PRODUCTION_POSTGRES_SOURCE_REPIN_OPERATION =
  "production-postgres-source-repin";
const PRODUCTION_POSTGRES_SOURCE_REPIN_RECONCILE_OPERATION =
  "production-postgres-source-repin-reconcile";
const PRODUCTION_POSTGRES_SOURCE_REPIN_WORKFLOW_PATH =
  ".github/workflows/repin-production-postgres-source.yml";
const PRODUCTION_POSTGRES_SOURCE_REPIN_WORKFLOW_ID =
  "repin-production-postgres-source.yml";
const PRODUCTION_POSTGRES_SOURCE_REPIN_JOB_NAME =
  "Lock or reconcile the protected production Postgres source";
const PRODUCTION_POSTGRES_SOURCE_REPIN_WRITE_STEP =
  "Apply or reconcile the exact production Postgres source lock";
const PROVIDER_JOB_NAME = "One protected variable mutation plan";
const PROVIDER_WRITE_STEP =
  "Execute one reviewed protected Railway mutation plan";
const CUTOVER_JOB_NAME = "Reconcile or disable exact permanent-staging legacy keys";
const CUTOVER_WRITE_STEP =
  "Canary replacement keys and reconcile or disable legacy keys once";
const CUTOVER_MODES = new Set([
  "reconcile-already-disabled-legacy-keys",
  "disable-enabled-legacy-keys",
]);
const COLD_RECOVERY_OPERATIONS = new Set([
  "cold-recovery-prepare",
  "cold-recovery-reconcile-prepare",
  "cold-recovery-quiesce",
  "cold-recovery-reconcile-quiesce",
]);
const RUNNER_LOSS_RECOVERY_OPERATIONS = new Set([
  "cold-recovery-reconcile-prepare",
  "cold-recovery-reconcile-quiesce",
  "staging-worker-bootstrap-reconcile-restore",
  "staging-worker-fence-reconcile-activate",
]);
const PROVIDER_OPERATIONS = new Set([
  "provider-google-maps-api-key",
  "provider-google-maps-map-id",
  "provider-google-places-api-key",
  "provider-openai-api-key",
  "supabase-key-replacement",
  "remove-forbidden-offsite-backup-variables",
  "resume-forbidden-offsite-backup-deletion-patch",
  "cancel-forbidden-offsite-backup-deletion-patch",
  "cancel-masked-forbidden-offsite-backup-deletion-patch",
  "reconcile-completed-forbidden-offsite-backup-deletion",
]);
const OFFSITE_CLEANUP_OPERATION =
  "remove-forbidden-offsite-backup-variables";
const OFFSITE_CLEANUP_RECOVERY_OPERATIONS = new Set([
  "resume-forbidden-offsite-backup-deletion-patch",
  "cancel-forbidden-offsite-backup-deletion-patch",
]);
const INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION =
  "cancel-masked-forbidden-offsite-backup-deletion-patch";
const OFFSITE_CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION =
  "reconcile-completed-forbidden-offsite-backup-deletion";
const OFFSITE_CLEANUP_PATCH_SHA256 =
  "3650174bf695aaebb3b9ba7f91a4f2a724a0806b30511578448964c36eebfb91";
const CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA =
  "0eadad05ce6c313ed3c12492d3095609ce5872d5";
const CLEANUP_CLOSEOUT_ORIGINAL_REVIEWED_HEAD_SHA =
  "b8d0d0e44cf63e996388a223ba4ee2ff02ab02e5";
const CLEANUP_CLOSEOUT_ORIGINAL_TREE_SHA =
  "2f624d697d97f5682d7b69231ed4d0ec66a21e6d";
const CLEANUP_CLOSEOUT_ORIGINAL_PULL_REQUEST_NUMBER = 71;
const CLEANUP_CLOSEOUT_ORIGINAL_MERGED_AT = "2026-08-29T09:42:49Z";
const CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID = 33246243698;
const CLEANUP_CLOSEOUT_ORIGINAL_RUN_CREATED_AT = "2026-08-29T09:45:53Z";
const CLEANUP_CLOSEOUT_ORIGINAL_RUN_COMPLETED_AT = "2026-08-29T09:49:29Z";
const CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_ID = 9712963222;
const CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_NAME =
  "pintpath-permanent-staging-provider-mutation-remove-forbidden-offsite-backup-variables-0eadad05ce6c313ed3c12492d3095609ce5872d5";
const CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_DIGEST =
  "sha256:aeb28aef046845e9f8ce830c2ae4a2eee762ce79810c69a1727fbef07f121ad3";
const CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_BYTES = 2111;
const CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_CREATED_AT = "2026-08-29T09:49:26Z";
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID = 33246655561;
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_CREATED_AT = "2026-08-29T09:56:44Z";
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_COMPLETED_AT = "2026-08-29T10:00:57Z";
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_ID = 9713096183;
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_NAME =
  "pintpath-permanent-staging-provider-mutation-resume-forbidden-offsite-backup-deletion-patch-0eadad05ce6c313ed3c12492d3095609ce5872d5";
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_DIGEST =
  "sha256:e1a4e7017298b49df7c0afb3fcc8a354740248c5333cb21248d3bbd80d65c0b8";
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_BYTES = 313;
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_CREATED_AT =
  "2026-08-29T10:00:54Z";
const CLEANUP_CLOSEOUT_MINIMUM_OBSERVATION_MS = 10 * 60 * 1_000;
const INCIDENT_ORIGINAL_CANDIDATE_SHA =
  "ac7130e0306802825922d21a4c61135b84edd43b";
const INCIDENT_ORIGINAL_REVIEWED_HEAD_SHA =
  "b41c39a601f20a510ccbc09187acdca29abd7a02";
const INCIDENT_ORIGINAL_TREE_SHA =
  "b111b763883f04d06642f8e01386b0af5a201fa0";
const INCIDENT_ORIGINAL_PULL_REQUEST_NUMBER = 65;
const INCIDENT_ORIGINAL_MERGED_AT = "2026-08-28T10:20:39Z";
const INCIDENT_PRIOR_CLEANUP_RUN_ID = "33164687424";
const INCIDENT_PRIOR_CLEANUP_RUN_CREATED_AT = "2026-08-28T10:47:25Z";
const INCIDENT_PRIOR_CLEANUP_RUN_COMPLETED_AT = "2026-08-28T10:51:43Z";
const INCIDENT_PRIOR_CLEANUP_ARTIFACT_ID = 9683176636;
const INCIDENT_PRIOR_CLEANUP_ARTIFACT_NAME =
  "pintpath-permanent-staging-provider-mutation-remove-forbidden-offsite-backup-variables-ac7130e0306802825922d21a4c61135b84edd43b";
const INCIDENT_PRIOR_CLEANUP_ARTIFACT_DIGEST =
  "sha256:0df300c84d53ece3fca5f7c72007bf5dd4a8ba9d1ea989e5d74bc80904aed98e";
const INCIDENT_PRIOR_CLEANUP_ARTIFACT_BYTES = 2090;
const INCIDENT_PRIOR_CLEANUP_ARTIFACT_CREATED_AT = "2026-08-28T10:51:40Z";
const INCIDENT_STAGED_PATCH_ID = "63b3cc8a-f68f-4b99-adb7-70dfdfa7d6ae";
const INCIDENT_STAGED_PATCH_CREATED_AT = "2026-08-28T10:51:38.861Z";
const INCIDENT_ORIGINAL_BASELINE_METADATA_SHA256 =
  "c88c7915e91f391c4d40e4869d18b44783746a2b4e153c99637f34333c021abd";
const RUNTIME_VARIABLE_TARGETS = new Set([
  "permanent-staging",
  "permanent-staging-postgres",
  "production",
]);
const RUNTIME_VARIABLE_NAMES = new Set([
  "DATABASE_URL",
  "DATABASE_MAINTENANCE_URL",
  "PINTPATH_POSTGRES_ROOT_CA_PEM",
  "PINTPATH_POSTGRES_ROOT_CA_DER_SHA256",
  "GOOGLE_MAPS_API_KEY",
  "GOOGLE_MAPS_MAP_ID",
  "GOOGLE_PLACES_API_KEY",
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "REDIS_URL",
  "RESEND_TRANSACTIONAL_API_KEY",
  "RESEND_WEBHOOK_SIGNING_SECRET",
  "SOURCE_EVIDENCE_SIGNING_SECRET",
  "ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID",
  "ACCOUNT_DELETION_NOTICE_FROM",
  "ACCOUNT_DELETION_NOTICE_KEYRING_JSON",
  "ACCOUNT_DELETION_NOTICE_REPLY_TO",
  "PINTPATH_RUNTIME_DATABASE_URL",
]);

const PRODUCTION_RUNTIME_VARIABLE_NAMES = new Set([
  "BAR_PILOT_ENABLED",
  "BAR_PILOT_VENUE_IDS",
  "ALCOHOL_PROMOTION_APPROVAL_REFERENCE",
  "DATABASE_PATH",
  "PINTPATH_DATABASE_RESOURCE_ID",
  "PINTPATH_EXPECTED_DATABASE_RESOURCE_ID",
  "PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS",
  "PINTPATH_EXPECTED_DATABASE_URL_SHA256",
  "PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S",
  "PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID",
  "PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256",
  "PINTPATH_REDIS_RESOURCE_ID",
  "PINTPATH_EXPECTED_REDIS_RESOURCE_ID",
  "PINTPATH_FORBIDDEN_REDIS_RESOURCE_IDS",
  "PINTPATH_EXPECTED_REDIS_URL_SHA256",
  "PINTPATH_FORBIDDEN_REDIS_URL_SHA256S",
  "PINTPATH_PERMANENT_STAGING_REDIS_RESOURCE_ID",
  "PINTPATH_PERMANENT_STAGING_REDIS_URL_SHA256",
  "REQUIRE_REDIS_RATE_LIMITING",
  "ALLOW_IN_MEMORY_RATE_LIMITING_IN_PRODUCTION"
]);

function runtimeVariableCombinationExact(target, variableName) {
  if (PRODUCTION_RUNTIME_VARIABLE_NAMES.has(variableName)) return target === "production";
  return target === "permanent-staging-postgres"
    ? variableName === "PINTPATH_RUNTIME_DATABASE_URL"
    : (target === "permanent-staging" || target === "production") &&
      variableName !== "PINTPATH_RUNTIME_DATABASE_URL" &&
      RUNTIME_VARIABLE_NAMES.has(variableName);
}

function fail(code = "invalid") {
  throw new Error(`github_reviewed_candidate_authority_${code}`);
}

function parseTimestamp(value, code) {
  if (typeof value !== "string") fail(code);
  const milliseconds = Date.parse(value);
  const canonical = Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : "";
  if (
    !Number.isFinite(milliseconds) ||
    (canonical !== value && canonical !== value.replace("Z", ".000Z"))
  ) {
    fail(code);
  }
  return milliseconds;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 4 || argv.length > 16 || argv.length % 2) {
    fail("arguments_invalid");
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      ![
        "--candidate-sha",
        "--operation",
        "--replacement-run-id",
        "--deployment-run-id",
        "--cutover-mode",
        "--prior-run-id",
        "--prior-candidate-sha",
        "--failed-prewrite-run-id",
        "--failed-prewrite-candidate-sha",
        "--prepare-run-id",
        "--target",
        "--variable-name",
      ].includes(key) ||
      typeof value !== "string" ||
      value.length === 0 ||
      values.has(key)
    ) fail("arguments_invalid");
    values.set(key, value);
  }
  const candidateSha = values.get("--candidate-sha") ?? "";
  const operation = values.get("--operation") ?? "";
  const replacementRunId = values.get("--replacement-run-id") ?? null;
  const deploymentRunId = values.get("--deployment-run-id") ?? null;
  const cutoverMode = values.get("--cutover-mode") ?? null;
  const priorRunId = values.get("--prior-run-id") ?? null;
  const priorCandidateSha = values.get("--prior-candidate-sha") ?? null;
  const failedPrewriteRunId = values.get("--failed-prewrite-run-id") ?? null;
  const failedPrewriteCandidateSha =
    values.get("--failed-prewrite-candidate-sha") ?? null;
  const prepareRunId = values.get("--prepare-run-id") ?? null;
  const target = values.get("--target") ?? null;
  const variableName = values.get("--variable-name") ?? null;
  const cutover = operation === "supabase-legacy-key-cutover";
  const runtimeVariable = operation === "runtime-variable";
  const coldPrepare = operation === "cold-recovery-prepare";
  const coldPrepareReconcile =
    operation === "cold-recovery-reconcile-prepare";
  const coldQuiesceReconcile =
    operation === "cold-recovery-reconcile-quiesce";
  const coldQuiesceSuccessor =
    operation === COLD_QUIESCE_SUCCESSOR_OPERATION;
  const runnerLossReconcile = RUNNER_LOSS_RECOVERY_OPERATIONS.has(operation);
  const productionPostgresSourceRepinReconcile =
    operation === PRODUCTION_POSTGRES_SOURCE_REPIN_RECONCILE_OPERATION;
  const offsiteCleanupRecovery =
    OFFSITE_CLEANUP_RECOVERY_OPERATIONS.has(operation);
  const incidentMaskedCleanupCancel =
    operation === INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION;
  const offsiteCleanupSuccessorCloseout =
    operation === OFFSITE_CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION;
  if (
    !SHA.test(candidateSha) ||
    (!cutover &&
      !runtimeVariable &&
      operation !== PRODUCTION_POSTGRES_SOURCE_REPIN_OPERATION &&
      operation !== PRODUCTION_POSTGRES_SOURCE_REPIN_RECONCILE_OPERATION &&
      !PROVIDER_OPERATIONS.has(operation) &&
      !COLD_RECOVERY_OPERATIONS.has(operation) &&
      !coldQuiesceSuccessor &&
      !RUNNER_LOSS_RECOVERY_OPERATIONS.has(operation)) ||
    (cutover
      ? !RUN_ID.test(replacementRunId ?? "") ||
        !RUN_ID.test(deploymentRunId ?? "") ||
        !CUTOVER_MODES.has(cutoverMode)
      : coldPrepare || coldPrepareReconcile || coldQuiesceSuccessor
      ? !RUN_ID.test(replacementRunId ?? "") ||
        deploymentRunId !== null ||
        cutoverMode !== null
      : replacementRunId !== null || deploymentRunId !== null || cutoverMode !== null) ||
    (offsiteCleanupRecovery || incidentMaskedCleanupCancel ||
      offsiteCleanupSuccessorCloseout || runnerLossReconcile ||
      productionPostgresSourceRepinReconcile || coldQuiesceSuccessor
      ? !RUN_ID.test(priorRunId ?? "")
      : priorRunId !== null) ||
    (productionPostgresSourceRepinReconcile || coldQuiesceSuccessor
      ? !SHA.test(priorCandidateSha ?? "")
      : priorCandidateSha !== null) ||
    (coldQuiesceSuccessor
      ? !RUN_ID.test(failedPrewriteRunId ?? "") ||
        !SHA.test(failedPrewriteCandidateSha ?? "")
      : failedPrewriteRunId !== null || failedPrewriteCandidateSha !== null) ||
    (coldQuiesceReconcile || coldQuiesceSuccessor
      ? !RUN_ID.test(prepareRunId ?? "") || prepareRunId === priorRunId
      : prepareRunId !== null) ||
    (runtimeVariable
      ? !RUNTIME_VARIABLE_TARGETS.has(target) ||
        !RUNTIME_VARIABLE_NAMES.has(variableName) ||
        !runtimeVariableCombinationExact(target, variableName)
      : target !== null || variableName !== null)
  ) fail("arguments_invalid");
  return Object.freeze({
    candidateSha,
    operation,
    replacementRunId,
    deploymentRunId,
    cutoverMode,
    priorRunId,
    priorCandidateSha,
    failedPrewriteRunId,
    failedPrewriteCandidateSha,
    prepareRunId,
    target,
    variableName,
  });
}

function operationConfiguration(
  operation,
  candidateSha,
  target,
  variableName,
  cutoverMode = null,
) {
  if (operation === "supabase-legacy-key-cutover") {
    if (!CUTOVER_MODES.has(cutoverMode)) fail("arguments_invalid");
    return Object.freeze({
      workflowPath: CUTOVER_WORKFLOW_PATH,
      workflowId: CUTOVER_WORKFLOW_ID,
      displayTitle:
        `Permanent staging Supabase legacy cutover | ${cutoverMode} | ${candidateSha}`,
      jobName: CUTOVER_JOB_NAME,
      writeStep: CUTOVER_WRITE_STEP,
      priorSkippedWriteAllowed: true,
      cutoverMode,
    });
  }
  if (operation === "runtime-variable") {
    return Object.freeze({
      workflowPath: RUNTIME_VARIABLE_WORKFLOW_PATH,
      workflowId: RUNTIME_VARIABLE_WORKFLOW_ID,
      displayTitle:
        `Configure runtime variable | ${target} | ${variableName} | ${candidateSha}`,
      jobName: null,
      writeStep: null,
      priorSkippedWriteAllowed: false,
    });
  }
  if (operation === PRODUCTION_POSTGRES_SOURCE_REPIN_OPERATION) {
    return Object.freeze({
      workflowPath: PRODUCTION_POSTGRES_SOURCE_REPIN_WORKFLOW_PATH,
      workflowId: PRODUCTION_POSTGRES_SOURCE_REPIN_WORKFLOW_ID,
      displayTitle: `Production Postgres source lock | apply | ${candidateSha}`,
      jobName: PRODUCTION_POSTGRES_SOURCE_REPIN_JOB_NAME,
      writeStep: PRODUCTION_POSTGRES_SOURCE_REPIN_WRITE_STEP,
      priorSkippedWriteAllowed: true,
    });
  }
  if (operation === PRODUCTION_POSTGRES_SOURCE_REPIN_RECONCILE_OPERATION) {
    return Object.freeze({
      workflowPath: PRODUCTION_POSTGRES_SOURCE_REPIN_WORKFLOW_PATH,
      workflowId: PRODUCTION_POSTGRES_SOURCE_REPIN_WORKFLOW_ID,
      displayTitle:
        `Production Postgres source lock | reconcile | ${candidateSha}`,
      jobName: PRODUCTION_POSTGRES_SOURCE_REPIN_JOB_NAME,
      writeStep: PRODUCTION_POSTGRES_SOURCE_REPIN_WRITE_STEP,
      priorSkippedWriteAllowed: true,
    });
  }
  if (
    COLD_RECOVERY_OPERATIONS.has(operation) ||
    operation === COLD_QUIESCE_SUCCESSOR_OPERATION
  ) {
    const coldOperation = operation === "cold-recovery-prepare"
      ? "prepare"
      : operation === "cold-recovery-reconcile-prepare"
      ? "reconcile-prepare"
      : operation === "cold-recovery-quiesce" ||
          operation === COLD_QUIESCE_SUCCESSOR_OPERATION
      ? "quiesce"
      : "reconcile-quiesce";
    return Object.freeze({
      workflowPath: COLD_RECOVERY_WORKFLOW_PATH,
      workflowId: COLD_RECOVERY_WORKFLOW_ID,
      displayTitle:
        `Permanent staging cold recovery | ${coldOperation} | ${candidateSha}`,
      jobName: coldOperation === "prepare"
        ? "Bind the exact replacement and prepare the dead baseline"
        : coldOperation === "reconcile-prepare"
        ? "Reconcile an ambiguous cold prepare at the exact dead baseline"
        : coldOperation === "quiesce"
        ? CURRENT_COLD_QUIESCE_JOB_NAME
        : "Reconcile an ambiguous cold quiesce at exact zero",
      writeStep: coldOperation === "prepare"
        ? "Prepare the exact dead staging baseline once"
        : coldOperation === "quiesce"
        ? CURRENT_COLD_QUIESCE_WRITE_STEP
        : null,
      priorSkippedWriteAllowed: true,
    });
  }
  if (operation === "staging-worker-bootstrap-reconcile-restore") {
    return Object.freeze({
      workflowPath: STAGING_BOOTSTRAP_WORKFLOW_PATH,
      workflowId: STAGING_BOOTSTRAP_WORKFLOW_ID,
      displayTitle:
        `Permanent staging worker bootstrap | reconcile-restore | ${candidateSha}`,
      jobName: "Reconcile an ambiguous staging bootstrap restore at exact one",
      writeStep: null,
      priorSkippedWriteAllowed: true,
    });
  }
  if (operation === "staging-worker-fence-reconcile-activate") {
    return Object.freeze({
      workflowPath: WORKER_FENCE_WORKFLOW_PATH,
      workflowId: WORKER_FENCE_WORKFLOW_ID,
      displayTitle:
        `Automatic maintenance worker fence | permanent-staging | reconcile-activate | ${candidateSha}`,
      jobName: "Reconcile an ambiguous staging automatic-maintenance activation",
      writeStep: null,
      priorSkippedWriteAllowed: true,
    });
  }
  if (operation === INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION) {
    return Object.freeze({
      workflowPath: PROVIDER_WORKFLOW_PATH,
      workflowId: PROVIDER_WORKFLOW_ID,
      displayTitle:
        `Permanent staging provider mutation | ${operation} | ${candidateSha}`,
      jobName: PROVIDER_JOB_NAME,
      writeStep: PROVIDER_WRITE_STEP,
      priorSkippedWriteAllowed: true,
    });
  }
  return Object.freeze({
    workflowPath: PROVIDER_WORKFLOW_PATH,
    workflowId: PROVIDER_WORKFLOW_ID,
    displayTitle:
      `Permanent staging provider mutation | ${operation} | ${candidateSha}`,
    jobName: PROVIDER_JOB_NAME,
    writeStep: PROVIDER_WRITE_STEP,
    priorSkippedWriteAllowed: true,
  });
}

function workflowPathExact(value, expected) {
  return value === expected || value === `${expected}@main`;
}

function isNonterminalRun(value) {
  return NONTERMINAL_RUN_STATUSES.has(value?.status) && value?.conclusion === null;
}

function validateRunIdentity(value, expected) {
  const createdAt = parseTimestamp(value?.created_at, expected.failureCode);
  const startedAt = parseTimestamp(value?.run_started_at, expected.failureCode);
  const updatedAt = parseTimestamp(value?.updated_at, expected.failureCode);
  if (
    !Number.isSafeInteger(value?.id) ||
    value.id <= 0 ||
    value.id !== expected.runId ||
    value?.repository?.full_name !== REPOSITORY ||
    value?.head_repository?.full_name !== REPOSITORY ||
    value?.head_sha !== expected.candidateSha ||
    value?.head_branch !== "main" ||
    !workflowPathExact(value?.path, expected.workflowPath) ||
    value?.event !== "workflow_dispatch" ||
    value?.display_title !== expected.displayTitle ||
    value?.run_attempt !== 1 ||
    startedAt < createdAt ||
    updatedAt < startedAt
  ) fail(expected.failureCode);
  return Object.freeze({ ...value, createdAt, startedAt, updatedAt });
}

async function verifyProductionPostgresSourceRepinRecoveryCandidates(
  input,
  policy,
  currentPull,
  currentMergedAtMs,
) {
  const crossCandidate = input.priorCandidateSha !== input.candidateSha;
  if (!crossCandidate) {
    return Object.freeze({
      priorPull: currentPull,
      priorMergedAtMs: currentMergedAtMs,
      crossCandidate: false,
      recoveryBridge: null,
      stagedRecovery: null,
      postStageBridge: null,
      finalZeroWriteBridge: null,
    });
  }
  const priorPull = await verifyReviewedPullRequest(
    input.fetchImpl,
    input.token,
    policy,
    input.priorCandidateSha,
  );
  const priorMergedAtMs = parseTimestamp(
    priorPull.mergedAt,
    "production_postgres_source_repin_reconciliation_history_invalid",
  );
  const currentCommit = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/git/commits/${input.candidateSha}`,
  );
  const currentCommitExact =
    currentCommit?.sha === input.candidateSha &&
    currentCommit?.tree?.sha === currentPull.treeSha &&
    Array.isArray(currentCommit?.parents) &&
    currentCommit.parents.length === 1;
  const expected = PRODUCTION_POSTGRES_SOURCE_REPIN_RECOVERY_BRIDGE;
  const usesFinalZeroWriteBridge =
    currentCommit?.parents?.[0]?.sha ===
    expected.finalZeroWriteBridgeCandidateSha;
  if (priorMergedAtMs >= currentMergedAtMs || !currentCommitExact) {
    fail("production_postgres_source_repin_reconciliation_history_invalid");
  }
  if (
    input.priorCandidateSha !== expected.priorCandidateSha ||
    priorPull.number !== expected.priorPullRequestNumber ||
    priorPull.reviewedPrHeadSha !== expected.priorReviewedHeadSha ||
    priorPull.treeSha !== expected.priorTreeSha ||
    priorPull.mergedAt !== expected.priorMergedAt ||
    !usesFinalZeroWriteBridge
  ) {
    fail("production_postgres_source_repin_reconciliation_history_invalid");
  }
  const bridgePull = await verifyReviewedPullRequest(
    input.fetchImpl,
    input.token,
    policy,
    expected.candidateSha,
  );
  const bridgeCommit = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/git/commits/${expected.candidateSha}`,
  );
  const bridgeMergedAtMs = parseTimestamp(
    expected.mergedAt,
    "production_postgres_source_repin_reconciliation_history_invalid",
  );
  const stagedRecoveryPull = await verifyReviewedPullRequest(
    input.fetchImpl,
    input.token,
    policy,
    expected.stagedRecoveryCandidateSha,
  );
  const stagedRecoveryCommit = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/git/commits/${expected.stagedRecoveryCandidateSha}`,
  );
  const stagedRecoveryMergedAtMs = parseTimestamp(
    expected.stagedRecoveryMergedAt,
    "production_postgres_source_repin_reconciliation_history_invalid",
  );
  const postStageBridgePull = await verifyReviewedPullRequest(
    input.fetchImpl,
    input.token,
    policy,
    expected.postStageBridgeCandidateSha,
  );
  const postStageBridgeCommit = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/git/commits/${expected.postStageBridgeCandidateSha}`,
  );
  const postStageBridgeMergedAtMs = parseTimestamp(
    expected.postStageBridgeMergedAt,
    "production_postgres_source_repin_reconciliation_history_invalid",
  );
  const finalZeroWriteBridgePull = await verifyReviewedPullRequest(
    input.fetchImpl,
    input.token,
    policy,
    expected.finalZeroWriteBridgeCandidateSha,
  );
  const finalZeroWriteBridgeCommit = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/git/commits/${expected.finalZeroWriteBridgeCandidateSha}`,
  );
  const finalZeroWriteBridgeMergedAtMs = parseTimestamp(
    expected.finalZeroWriteBridgeMergedAt,
    "production_postgres_source_repin_reconciliation_history_invalid",
  );
  if (
    bridgePull.number !== expected.pullRequestNumber ||
    bridgePull.reviewedPrHeadSha !== expected.reviewedHeadSha ||
    bridgePull.treeSha !== expected.treeSha ||
    bridgePull.mergedAt !== expected.mergedAt ||
    bridgeCommit?.sha !== expected.candidateSha ||
    bridgeCommit?.tree?.sha !== expected.treeSha ||
    !Array.isArray(bridgeCommit?.parents) ||
    bridgeCommit.parents.length !== 1 ||
    bridgeCommit.parents[0]?.sha !== input.priorCandidateSha ||
    priorMergedAtMs >= bridgeMergedAtMs ||
    stagedRecoveryPull.number !== expected.stagedRecoveryPullRequestNumber ||
    stagedRecoveryPull.reviewedPrHeadSha !==
      expected.stagedRecoveryReviewedHeadSha ||
    stagedRecoveryPull.treeSha !== expected.stagedRecoveryTreeSha ||
    stagedRecoveryPull.mergedAt !== expected.stagedRecoveryMergedAt ||
    stagedRecoveryCommit?.sha !== expected.stagedRecoveryCandidateSha ||
    stagedRecoveryCommit?.tree?.sha !== expected.stagedRecoveryTreeSha ||
    !Array.isArray(stagedRecoveryCommit?.parents) ||
    stagedRecoveryCommit.parents.length !== 1 ||
    stagedRecoveryCommit.parents[0]?.sha !== expected.candidateSha ||
    bridgeMergedAtMs >= stagedRecoveryMergedAtMs ||
    postStageBridgePull?.number !==
      expected.postStageBridgePullRequestNumber ||
    postStageBridgePull?.reviewedPrHeadSha !==
      expected.postStageBridgeReviewedHeadSha ||
    postStageBridgePull?.treeSha !== expected.postStageBridgeTreeSha ||
    postStageBridgePull?.mergedAt !== expected.postStageBridgeMergedAt ||
    postStageBridgeCommit?.sha !== expected.postStageBridgeCandidateSha ||
    postStageBridgeCommit?.tree?.sha !== expected.postStageBridgeTreeSha ||
    !Array.isArray(postStageBridgeCommit?.parents) ||
    postStageBridgeCommit.parents.length !== 1 ||
    postStageBridgeCommit.parents[0]?.sha !==
      expected.stagedRecoveryCandidateSha ||
    postStageBridgeMergedAtMs === null ||
    stagedRecoveryMergedAtMs >= postStageBridgeMergedAtMs ||
    finalZeroWriteBridgePull?.number !==
      expected.finalZeroWriteBridgePullRequestNumber ||
    finalZeroWriteBridgePull?.reviewedPrHeadSha !==
      expected.finalZeroWriteBridgeReviewedHeadSha ||
    finalZeroWriteBridgePull?.treeSha !==
      expected.finalZeroWriteBridgeTreeSha ||
    finalZeroWriteBridgePull?.mergedAt !==
      expected.finalZeroWriteBridgeMergedAt ||
    finalZeroWriteBridgeCommit?.sha !==
      expected.finalZeroWriteBridgeCandidateSha ||
    finalZeroWriteBridgeCommit?.tree?.sha !==
      expected.finalZeroWriteBridgeTreeSha ||
    !Array.isArray(finalZeroWriteBridgeCommit?.parents) ||
    finalZeroWriteBridgeCommit.parents.length !== 1 ||
    finalZeroWriteBridgeCommit.parents[0]?.sha !==
      expected.postStageBridgeCandidateSha ||
    finalZeroWriteBridgeMergedAtMs === null ||
    postStageBridgeMergedAtMs >= finalZeroWriteBridgeMergedAtMs ||
    finalZeroWriteBridgeMergedAtMs >= currentMergedAtMs
  ) {
    fail("production_postgres_source_repin_reconciliation_history_invalid");
  }
  return Object.freeze({
    priorPull,
    priorMergedAtMs,
    crossCandidate: true,
    recoveryBridge: expected,
    stagedRecovery: expected,
    postStageBridge: expected,
    finalZeroWriteBridge: expected,
  });
}

async function listWorkflowHistory(input) {
  const history = [];
  let totalCount = null;
  let complete = false;
  const range = `${input.mergedAt}..${input.currentStartedAt}`;
  for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
    const listing = await githubGet(
      input.fetchImpl,
      input.token,
      REPOSITORY,
      `/actions/workflows/${input.workflowId}/runs` +
        `?branch=main&event=workflow_dispatch&created=${encodeURIComponent(range)}` +
        `&per_page=100&page=${page}`,
    );
    if (
      !Number.isSafeInteger(listing?.total_count) ||
      listing.total_count < 0 ||
      listing.total_count > MAX_HISTORY_PAGES * 100 ||
      !Array.isArray(listing?.workflow_runs) ||
      listing.workflow_runs.length > 100 ||
      (totalCount !== null && listing.total_count !== totalCount)
    ) fail("history_invalid");
    totalCount = listing.total_count;
    history.push(...listing.workflow_runs);
    if (listing.workflow_runs.length < 100) {
      complete = true;
      break;
    }
  }
  if (!complete || history.length !== totalCount) fail("history_incomplete");
  return history;
}

async function listCompleteWorkflowHistoryAllRefs(input) {
  const history = [];
  let totalCount = null;
  let complete = false;
  for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
    const listing = await githubGet(
      input.fetchImpl,
      input.token,
      REPOSITORY,
      `/actions/workflows/${input.workflowId}/runs` +
        `?event=workflow_dispatch&per_page=100&page=${page}`,
    );
    if (
      !Number.isSafeInteger(listing?.total_count) ||
      listing.total_count < 0 ||
      listing.total_count > MAX_HISTORY_PAGES * 100 ||
      !Array.isArray(listing?.workflow_runs) ||
      listing.workflow_runs.length > 100 ||
      (totalCount !== null && listing.total_count !== totalCount)
    ) fail("history_invalid");
    totalCount = listing.total_count;
    history.push(...listing.workflow_runs);
    if (listing.workflow_runs.length < 100) {
      complete = true;
      break;
    }
  }
  if (!complete || history.length !== totalCount) fail("history_incomplete");
  return history;
}

async function priorRunWriteDisposition(input, run, configuration) {
  if (
    run.status !== "completed" ||
    !["failure", "cancelled", "timed_out"].includes(run.conclusion)
  ) return "invalid";
  const listing = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
  );
  const cold = configuration.workflowPath === COLD_RECOVERY_WORKFLOW_PATH;
  const bootstrapJobNames = [
    "Verify the chain and perform one exact protected scale transition",
    "Reconcile an ambiguous staging bootstrap restore at exact one",
  ];
  const workerJobNames = [
    "One candidate-bound automatic-maintenance transition",
    "Reconcile an ambiguous staging automatic-maintenance activation",
  ];
  const legacyAmbiguousColdQuiesce = cold &&
    run.id === COLD_QUIESCE_SUCCESSOR_BRIDGE.ambiguousQuiesceRunId;
  if (legacyAmbiguousColdQuiesce !== (
    configuration.jobName === LEGACY_AMBIGUOUS_COLD_QUIESCE_JOB_NAME &&
    configuration.writeStep === LEGACY_AMBIGUOUS_COLD_QUIESCE_WRITE_STEP
  )) return "invalid";
  const workflowJobNames = cold
    ? exactWorkflowJobNames(
      configuration.workflowPath,
      legacyAmbiguousColdQuiesce
        ? LEGACY_AMBIGUOUS_COLD_QUIESCE_JOB_NAME
        : CURRENT_COLD_QUIESCE_JOB_NAME,
    )
    : configuration.workflowPath === STAGING_BOOTSTRAP_WORKFLOW_PATH
    ? bootstrapJobNames
    : configuration.workflowPath === WORKER_FENCE_WORKFLOW_PATH
    ? workerJobNames
    : null;
  const expectedJobCount = workflowJobNames?.length ?? 1;
  if (listing?.total_count !== expectedJobCount ||
    !Array.isArray(listing?.jobs) ||
    listing.jobs.length !== expectedJobCount) return "invalid";
  const matchingJobs = listing.jobs.filter((job) =>
    job?.name === configuration.jobName);
  if (matchingJobs.length !== 1) return "invalid";
  const job = matchingJobs[0];
  if (
    job?.run_id !== run.id ||
    job?.run_attempt !== 1 ||
    job?.name !== configuration.jobName ||
    job?.status !== "completed" ||
    job?.conclusion !== run.conclusion ||
    !Array.isArray(job?.steps)
  ) return "invalid";
  if (workflowJobNames !== null) {
    if (new Set(listing.jobs.map((item) => item?.name)).size !==
        workflowJobNames.length ||
      workflowJobNames.some((name) =>
        !listing.jobs.some((item) => item?.name === name)) ||
      listing.jobs.some((item) => item !== job &&
        (item?.run_id !== run.id || item?.run_attempt !== 1 ||
          item?.status !== "completed" || item?.conclusion !== "skipped"))) {
      return "invalid";
    }
  }
  const writeSteps = job.steps.filter((step) => step?.name === configuration.writeStep);
  if (writeSteps.length !== 1 || writeSteps[0]?.status !== "completed") {
    return "invalid";
  }
  if (writeSteps[0]?.conclusion === "skipped") return "skipped";
  return ["success", "failure", "cancelled", "timed_out"].includes(
    writeSteps[0]?.conclusion,
  )
    ? "may-have-written"
    : "invalid";
}

function exactWorkflowJobNames(
  workflowPath,
  coldQuiesceJobName = CURRENT_COLD_QUIESCE_JOB_NAME,
) {
  return workflowPath === COLD_RECOVERY_WORKFLOW_PATH
    ? [
        "Bind the exact replacement and prepare the dead baseline",
        "Reconcile an ambiguous cold prepare at the exact dead baseline",
        coldQuiesceJobName,
        "Reconcile an ambiguous cold quiesce at exact zero",
      ]
    : workflowPath === STAGING_BOOTSTRAP_WORKFLOW_PATH
    ? [
        "Verify the chain and perform one exact protected scale transition",
        "Reconcile an ambiguous staging bootstrap restore at exact one",
      ]
    : workflowPath === WORKER_FENCE_WORKFLOW_PATH
    ? [
        "One candidate-bound automatic-maintenance transition",
        "Reconcile an ambiguous staging automatic-maintenance activation",
      ]
    : null;
}

async function successfulWriteRunExact(input, run, configuration) {
  const jobNames = exactWorkflowJobNames(configuration.workflowPath);
  if (
    configuration.writeStep === null ||
    jobNames === null ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) return false;
  const listing = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
  );
  if (
    listing?.total_count !== jobNames.length ||
    !Array.isArray(listing?.jobs) ||
    listing.jobs.length !== jobNames.length ||
    new Set(listing.jobs.map((job) => job?.name)).size !== jobNames.length ||
    jobNames.some((name) =>
      !listing.jobs.some((job) => job?.name === name))
  ) return false;
  const selected = listing.jobs.find((job) =>
    job?.name === configuration.jobName);
  const writeSteps = Array.isArray(selected?.steps)
    ? selected.steps.filter((step) => step?.name === configuration.writeStep)
    : [];
  return selected?.run_id === run.id &&
    selected.run_attempt === 1 &&
    selected.status === "completed" &&
    selected.conclusion === "success" &&
    writeSteps.length === 1 &&
    writeSteps[0]?.status === "completed" &&
    writeSteps[0]?.conclusion === "success" &&
    listing.jobs.every((job) => job === selected || (
      job?.run_id === run.id &&
      job?.run_attempt === 1 &&
      job?.status === "completed" &&
      job?.conclusion === "skipped"
    ));
}

async function readOnlyReconciliationRunExact(
  input,
  run,
  configuration,
  allowedConclusions,
  exactJobNames = null,
) {
  const jobNames = exactJobNames ??
    exactWorkflowJobNames(configuration.workflowPath);
  if (configuration.writeStep !== null || jobNames === null ||
    run.status !== "completed" ||
    !allowedConclusions.includes(run.conclusion)) {
    return false;
  }
  const listing = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
  );
  if (listing?.total_count !== jobNames.length ||
    !Array.isArray(listing?.jobs) ||
    listing.jobs.length !== jobNames.length ||
    new Set(listing.jobs.map((job) => job?.name)).size !== jobNames.length ||
    jobNames.some((name) =>
      !listing.jobs.some((job) => job?.name === name))) return false;
  const selected = listing.jobs.find((job) =>
    job?.name === configuration.jobName);
  return selected?.run_id === run.id &&
    selected.run_attempt === 1 &&
    selected.status === "completed" &&
    selected.conclusion === run.conclusion &&
    Array.isArray(selected.steps) &&
    listing.jobs.every((job) => job === selected || (
      job?.run_id === run.id &&
      job?.run_attempt === 1 &&
      job?.status === "completed" &&
      job?.conclusion === "skipped"
    ));
}

async function priorReadOnlyReconciliationRunExact(
  input,
  run,
  configuration,
) {
  return readOnlyReconciliationRunExact(
    input,
    run,
    configuration,
    ["failure", "cancelled", "timed_out"],
  );
}

async function successfulReadOnlyReconciliationRunExact(
  input,
  run,
  configuration,
) {
  return readOnlyReconciliationRunExact(
    input,
    run,
    configuration,
    ["success"],
  );
}

async function priorRunSkippedWrite(input, run, configuration) {
  return await priorRunWriteDisposition(input, run, configuration) === "skipped";
}

async function verifyOperationHistory(input, configuration, currentRun) {
  const history = await listWorkflowHistory({
    ...input,
    workflowId: configuration.workflowId,
  });
  const matching = history.filter((run) =>
    run?.head_sha === input.candidateSha &&
    run?.display_title === configuration.displayTitle);
  const identifiers = matching.map((run) => run?.id);
  if (
    identifiers.filter((id) => id === currentRun.id).length !== 1 ||
    new Set(identifiers).size !== identifiers.length
  ) fail("history_invalid");
  const safePriorRunIds = [];
  for (const observed of matching) {
    const run = validateRunIdentity(observed, {
      runId: observed?.id,
      candidateSha: input.candidateSha,
      workflowPath: configuration.workflowPath,
      displayTitle: configuration.displayTitle,
      failureCode: "history_invalid",
    });
    if (
      run.createdAt < input.mergedAtMs ||
      run.createdAt > input.currentStartedAtMs
    ) fail("history_invalid");
    if (run.id === currentRun.id) {
      if (
        !isNonterminalRun(run) ||
        run.created_at !== currentRun.created_at ||
        run.run_started_at !== currentRun.run_started_at
      ) fail("history_invalid");
      continue;
    }
    if (
      configuration.priorSkippedWriteAllowed !== true ||
      !await priorRunSkippedWrite(input, run, configuration)
    ) {
      fail("prior_write_ambiguous");
    }
    safePriorRunIds.push(String(run.id));
  }
  return safePriorRunIds.sort((left, right) => Number(left) - Number(right));
}

async function verifyProductionPostgresSourceRepinReconciliationHistory(
  input,
  currentRun,
) {
  const completeCrossCandidateBridge =
    input.recoveryBridge !== null &&
    input.stagedRecovery !== null &&
    input.postStageBridge !== null &&
    input.finalZeroWriteBridge !== null;
  const noCrossCandidateBridge =
    input.recoveryBridge === null &&
    input.stagedRecovery === null &&
    input.postStageBridge === null &&
    input.finalZeroWriteBridge === null;
  if (
    input.crossCandidate
      ? !completeCrossCandidateBridge
      : !noCrossCandidateBridge
  ) {
    fail("production_postgres_source_repin_reconciliation_history_invalid");
  }
  const recoveryGraceHours = input.recoveryBridge === null
    ? RECOVERY_GRACE_HOURS
    : PRODUCTION_POSTGRES_SOURCE_REPIN_INCIDENT_RECOVERY_GRACE_HOURS;
  const recoveryGraceMs = input.recoveryBridge === null
    ? RECOVERY_GRACE_MS
    : PRODUCTION_POSTGRES_SOURCE_REPIN_INCIDENT_RECOVERY_GRACE_MS;
  const stagedRecoveryGraceMs =
    (input.stagedRecovery?.stagedRecoveryGraceHours ?? 0) * 60 * 60 * 1000;
  const allowedCandidateShas = new Set([
    input.priorCandidateSha,
    input.candidateSha,
    ...(input.recoveryBridge === null
      ? []
      : [
        input.recoveryBridge.candidateSha,
        input.recoveryBridge.stagedRecoveryCandidateSha,
        ...(input.postStageBridge == null
          ? []
          : [input.postStageBridge.postStageBridgeCandidateSha]),
        ...(input.finalZeroWriteBridge == null
          ? []
          : [input.finalZeroWriteBridge.finalZeroWriteBridgeCandidateSha]),
      ]),
  ]);
  const currentReconcileConfiguration = operationConfiguration(
    PRODUCTION_POSTGRES_SOURCE_REPIN_RECONCILE_OPERATION,
    input.candidateSha,
    null,
    null,
  );
  const history = await listWorkflowHistory({
    ...input,
    mergedAt: input.historyStartAt,
    workflowId: PRODUCTION_POSTGRES_SOURCE_REPIN_WORKFLOW_ID,
  });
  if (
    history.some((run) => !allowedCandidateShas.has(run?.head_sha)) ||
    new Set(history.map((run) => run?.id)).size !== history.length
  ) {
    fail("production_postgres_source_repin_reconciliation_history_invalid");
  }
  let currentSeen = false;
  let selectedOriginal = null;
  let selectedStagedRecovery = null;
  let selectedFinalZeroWrite = null;
  const safePriorSkippedWriteRunIds = [];
  for (const observed of history) {
    const observedCandidateSha = observed?.head_sha;
    const applyConfiguration = operationConfiguration(
      PRODUCTION_POSTGRES_SOURCE_REPIN_OPERATION,
      observedCandidateSha,
      null,
      null,
    );
    const reconcileConfiguration = operationConfiguration(
      PRODUCTION_POSTGRES_SOURCE_REPIN_RECONCILE_OPERATION,
      observedCandidateSha,
      null,
      null,
    );
    const configuration = observed?.display_title === applyConfiguration.displayTitle
      ? applyConfiguration
      : observed?.display_title === reconcileConfiguration.displayTitle
      ? reconcileConfiguration
      : null;
    if (configuration === null) {
      fail("production_postgres_source_repin_reconciliation_history_invalid");
    }
    const run = validateRunIdentity(observed, {
      runId: observed?.id,
      candidateSha: observedCandidateSha,
      workflowPath: PRODUCTION_POSTGRES_SOURCE_REPIN_WORKFLOW_PATH,
      displayTitle: configuration.displayTitle,
      failureCode:
        "production_postgres_source_repin_reconciliation_history_invalid",
    });
    if (run.createdAt < input.historyStartAtMs ||
      run.createdAt > input.currentStartedAtMs) {
      fail("production_postgres_source_repin_reconciliation_history_invalid");
    }
    if (run.id === currentRun.id) {
      if (run.head_sha !== input.candidateSha ||
        configuration.displayTitle !== currentReconcileConfiguration.displayTitle ||
        currentSeen ||
        !isNonterminalRun(run) ||
        run.created_at !== currentRun.created_at ||
        run.run_started_at !== currentRun.run_started_at) {
        fail("production_postgres_source_repin_reconciliation_history_invalid");
      }
      currentSeen = true;
      continue;
    }
    const disposition = await priorRunWriteDisposition(
      input,
      run,
      configuration,
    );
    if (run.head_sha === input.priorCandidateSha &&
      configuration.displayTitle === applyConfiguration.displayTitle &&
      String(run.id) === input.priorRunId) {
      if (selectedOriginal !== null || disposition !== "may-have-written") {
        fail("production_postgres_source_repin_reconciliation_history_invalid");
      }
      selectedOriginal = Object.freeze({
        run,
        updatedAt: run.updatedAt,
      });
      continue;
    }
    if (
      input.stagedRecovery !== null &&
      String(run.id) === input.stagedRecovery.stagedRecoveryRunId
    ) {
      if (
        selectedStagedRecovery !== null ||
        run.head_sha !== input.stagedRecovery.stagedRecoveryCandidateSha ||
        configuration.displayTitle !==
          `Production Postgres source lock | reconcile | ${input.stagedRecovery.stagedRecoveryCandidateSha}` ||
        run.created_at !== input.stagedRecovery.stagedRecoveryRunCreatedAt ||
        run.run_started_at !==
          input.stagedRecovery.stagedRecoveryRunStartedAt ||
        run.updated_at !==
          input.stagedRecovery.stagedRecoveryRunCompletedAt ||
        run.conclusion !== input.stagedRecovery.stagedRecoveryRunConclusion ||
        disposition !== "may-have-written"
      ) {
        fail("production_postgres_source_repin_reconciliation_history_invalid");
      }
      selectedStagedRecovery = Object.freeze({
        run,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
      continue;
    }
    if (
      input.finalZeroWriteBridge !== null &&
      String(run.id) === input.finalZeroWriteBridge.finalZeroWriteRunId
    ) {
      if (
        selectedFinalZeroWrite !== null ||
        run.head_sha !==
          input.finalZeroWriteBridge.finalZeroWriteBridgeCandidateSha ||
        configuration.displayTitle !==
          `Production Postgres source lock | reconcile | ${input.finalZeroWriteBridge.finalZeroWriteBridgeCandidateSha}` ||
        run.created_at !==
          input.finalZeroWriteBridge.finalZeroWriteRunCreatedAt ||
        run.run_started_at !==
          input.finalZeroWriteBridge.finalZeroWriteRunStartedAt ||
        run.updated_at !==
          input.finalZeroWriteBridge.finalZeroWriteRunCompletedAt ||
        run.conclusion !==
          input.finalZeroWriteBridge.finalZeroWriteRunConclusion ||
        disposition !== "may-have-written"
      ) {
        fail("production_postgres_source_repin_reconciliation_history_invalid");
      }
      selectedFinalZeroWrite = Object.freeze({
        run,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
      continue;
    }
    if (disposition !== "skipped") {
      fail("production_postgres_source_repin_reconciliation_history_invalid");
    }
    safePriorSkippedWriteRunIds.push(String(run.id));
  }
  const stagedRecoveryMergedAtMs = input.stagedRecovery === null
    ? null
    : parseTimestamp(
      input.stagedRecovery.stagedRecoveryMergedAt,
      "production_postgres_source_repin_reconciliation_history_invalid",
    );
  if (!currentSeen || selectedOriginal === null ||
    (input.crossCandidate && selectedStagedRecovery === null) ||
    (input.crossCandidate && selectedFinalZeroWrite === null) ||
    (input.crossCandidate &&
      selectedOriginal.updatedAt >= input.currentCandidateMergedAtMs) ||
    (selectedStagedRecovery !== null &&
      (stagedRecoveryMergedAtMs === null ||
        stagedRecoveryMergedAtMs >= selectedStagedRecovery.createdAt ||
        selectedOriginal.updatedAt >= selectedStagedRecovery.createdAt ||
        selectedStagedRecovery.updatedAt >=
          input.currentCandidateMergedAtMs ||
        selectedStagedRecovery.updatedAt >= currentRun.startedAt ||
        currentRun.startedAt - selectedStagedRecovery.updatedAt <
          input.stagedRecovery.stagedRecoverySettlementSeconds * 1_000 ||
        currentRun.startedAt - selectedStagedRecovery.updatedAt >
          stagedRecoveryGraceMs)) ||
    selectedOriginal.updatedAt >= currentRun.startedAt ||
    currentRun.startedAt - selectedOriginal.updatedAt <
      PRODUCTION_POSTGRES_SOURCE_REPIN_RECOVERY_SETTLEMENT_MS ||
    currentRun.startedAt - selectedOriginal.updatedAt > recoveryGraceMs) {
    fail("production_postgres_source_repin_reconciliation_history_invalid");
  }
  const bridgeRun = input.recoveryBridge === null
    ? null
    : history.find((run) =>
      String(run?.id) === input.recoveryBridge.skippedWriterRunId);
  if (
    input.recoveryBridge !== null && (
      bridgeRun?.head_sha !== input.recoveryBridge.candidateSha ||
      bridgeRun?.display_title !==
        `Production Postgres source lock | reconcile | ${input.recoveryBridge.candidateSha}` ||
      bridgeRun?.created_at !== input.recoveryBridge.skippedWriterRunCreatedAt ||
      bridgeRun?.run_started_at !==
        input.recoveryBridge.skippedWriterRunStartedAt ||
      bridgeRun?.updated_at !== input.recoveryBridge.skippedWriterRunCompletedAt ||
      bridgeRun?.conclusion !== input.recoveryBridge.skippedWriterRunConclusion ||
      !safePriorSkippedWriteRunIds.includes(
        input.recoveryBridge.skippedWriterRunId,
      )
    )
  ) {
    fail("production_postgres_source_repin_reconciliation_history_invalid");
  }
  const postStageBridgeRun = input.postStageBridge == null
    ? null
    : history.find((run) =>
      String(run?.id) ===
        input.postStageBridge.postStageBridgeSkippedWriterRunId);
  const postStageBridgeMergedAtMs = input.postStageBridge == null
    ? null
    : parseTimestamp(
      input.postStageBridge.postStageBridgeMergedAt,
      "production_postgres_source_repin_reconciliation_history_invalid",
    );
  const postStageBridgeRunCreatedAtMs = input.postStageBridge == null
    ? null
    : parseTimestamp(
      postStageBridgeRun?.created_at,
      "production_postgres_source_repin_reconciliation_history_invalid",
    );
  const postStageBridgeRunCompletedAtMs = input.postStageBridge == null
    ? null
    : parseTimestamp(
      postStageBridgeRun?.updated_at,
      "production_postgres_source_repin_reconciliation_history_invalid",
    );
  const finalZeroWriteBridgeMergedAtMs = input.finalZeroWriteBridge == null
    ? null
    : parseTimestamp(
      input.finalZeroWriteBridge.finalZeroWriteBridgeMergedAt,
      "production_postgres_source_repin_reconciliation_history_invalid",
    );
  if (
    input.postStageBridge != null && (
      postStageBridgeRun?.head_sha !==
        input.postStageBridge.postStageBridgeCandidateSha ||
      postStageBridgeRun?.display_title !==
        `Production Postgres source lock | reconcile | ${input.postStageBridge.postStageBridgeCandidateSha}` ||
      postStageBridgeRun?.created_at !==
        input.postStageBridge.postStageBridgeSkippedWriterRunCreatedAt ||
      postStageBridgeRun?.run_started_at !==
        input.postStageBridge.postStageBridgeSkippedWriterRunStartedAt ||
      postStageBridgeRun?.updated_at !==
        input.postStageBridge.postStageBridgeSkippedWriterRunCompletedAt ||
      postStageBridgeRun?.conclusion !==
        input.postStageBridge.postStageBridgeSkippedWriterRunConclusion ||
      postStageBridgeMergedAtMs === null ||
      postStageBridgeRunCreatedAtMs === null ||
      postStageBridgeRunCompletedAtMs === null ||
      postStageBridgeRunCreatedAtMs <= postStageBridgeMergedAtMs ||
      postStageBridgeRunCompletedAtMs >= input.currentCandidateMergedAtMs ||
      finalZeroWriteBridgeMergedAtMs === null ||
      postStageBridgeRunCompletedAtMs >= finalZeroWriteBridgeMergedAtMs ||
      !safePriorSkippedWriteRunIds.includes(
        input.postStageBridge.postStageBridgeSkippedWriterRunId,
      )
    )
  ) {
    fail("production_postgres_source_repin_reconciliation_history_invalid");
  }
  if (
    input.finalZeroWriteBridge !== null &&
    (selectedFinalZeroWrite === null ||
      finalZeroWriteBridgeMergedAtMs === null ||
      selectedFinalZeroWrite.createdAt <= finalZeroWriteBridgeMergedAtMs ||
      selectedFinalZeroWrite.updatedAt >= input.currentCandidateMergedAtMs ||
      selectedFinalZeroWrite.updatedAt >= currentRun.startedAt ||
      currentRun.startedAt - selectedFinalZeroWrite.updatedAt <
        input.finalZeroWriteBridge.finalZeroWriteSettlementSeconds * 1_000)
  ) {
    fail("production_postgres_source_repin_reconciliation_history_invalid");
  }
  for (const skippedRunId of safePriorSkippedWriteRunIds) {
    const skipped = history.find((run) => String(run?.id) === skippedRunId);
    if (parseTimestamp(
      skipped?.updated_at,
      "production_postgres_source_repin_reconciliation_history_invalid",
    ) >= currentRun.startedAt) {
      fail("production_postgres_source_repin_reconciliation_history_invalid");
    }
  }
  if (input.stagedRecovery !== null) {
    const artifactListing = await githubGet(
      input.fetchImpl,
      input.token,
      REPOSITORY,
      `/actions/runs/${input.stagedRecovery.stagedRecoveryRunId}/artifacts?name=${encodeURIComponent(input.stagedRecovery.stagedRecoveryArtifactName)}&per_page=100&page=1`,
    );
    const artifact = Array.isArray(artifactListing?.artifacts) &&
        artifactListing.artifacts.length === 1
      ? artifactListing.artifacts[0]
      : null;
    const artifactCreatedAt = parseTimestamp(
      artifact?.created_at,
      "production_postgres_source_repin_staged_recovery_artifact_invalid",
    );
    const artifactUpdatedAt = parseTimestamp(
      artifact?.updated_at,
      "production_postgres_source_repin_staged_recovery_artifact_invalid",
    );
    const artifactExpiresAt = parseTimestamp(
      artifact?.expires_at,
      "production_postgres_source_repin_staged_recovery_artifact_invalid",
    );
    if (
      artifactListing?.total_count !== 1 ||
      artifact?.id !== input.stagedRecovery.stagedRecoveryArtifactId ||
      artifact?.name !== input.stagedRecovery.stagedRecoveryArtifactName ||
      artifact?.size_in_bytes !==
        input.stagedRecovery.stagedRecoveryArtifactBytes ||
      artifact?.expired !== false ||
      artifact?.digest !== input.stagedRecovery.stagedRecoveryArtifactDigest ||
      artifact?.created_at !==
        input.stagedRecovery.stagedRecoveryArtifactCreatedAt ||
      artifact?.updated_at !==
        input.stagedRecovery.stagedRecoveryArtifactCreatedAt ||
      artifact?.workflow_run?.id !==
        Number(input.stagedRecovery.stagedRecoveryRunId) ||
      artifact?.workflow_run?.head_branch !== "main" ||
      artifact?.workflow_run?.head_sha !==
        input.stagedRecovery.stagedRecoveryCandidateSha ||
      artifactCreatedAt !== artifactUpdatedAt ||
      artifactUpdatedAt > selectedStagedRecovery.updatedAt ||
      artifactExpiresAt <= currentRun.startedAt
    ) {
      fail(
        "production_postgres_source_repin_staged_recovery_artifact_invalid",
      );
    }
  }
  if (input.finalZeroWriteBridge !== null) {
    const artifactListing = await githubGet(
      input.fetchImpl,
      input.token,
      REPOSITORY,
      `/actions/runs/${input.finalZeroWriteBridge.finalZeroWriteRunId}/artifacts?name=${encodeURIComponent(input.finalZeroWriteBridge.finalZeroWriteArtifactName)}&per_page=100&page=1`,
    );
    const artifact =
      Array.isArray(artifactListing?.artifacts) &&
      artifactListing.artifacts.length === 1
        ? artifactListing.artifacts[0]
        : null;
    const artifactCreatedAt = parseTimestamp(
      artifact?.created_at,
      "production_postgres_source_repin_final_zero_write_artifact_invalid",
    );
    const artifactUpdatedAt = parseTimestamp(
      artifact?.updated_at,
      "production_postgres_source_repin_final_zero_write_artifact_invalid",
    );
    const artifactExpiresAt = parseTimestamp(
      artifact?.expires_at,
      "production_postgres_source_repin_final_zero_write_artifact_invalid",
    );
    if (
      selectedFinalZeroWrite === null ||
      artifactListing?.total_count !== 1 ||
      artifact?.id !== input.finalZeroWriteBridge.finalZeroWriteArtifactId ||
      artifact?.name !==
        input.finalZeroWriteBridge.finalZeroWriteArtifactName ||
      artifact?.size_in_bytes !==
        input.finalZeroWriteBridge.finalZeroWriteArtifactBytes ||
      artifact?.expired !== false ||
      artifact?.digest !==
        input.finalZeroWriteBridge.finalZeroWriteArtifactDigest ||
      artifact?.created_at !==
        input.finalZeroWriteBridge.finalZeroWriteArtifactCreatedAt ||
      artifact?.updated_at !==
        input.finalZeroWriteBridge.finalZeroWriteArtifactCreatedAt ||
      artifact?.workflow_run?.id !==
        Number(input.finalZeroWriteBridge.finalZeroWriteRunId) ||
      artifact?.workflow_run?.head_branch !== "main" ||
      artifact?.workflow_run?.head_sha !==
        input.finalZeroWriteBridge.finalZeroWriteBridgeCandidateSha ||
      artifactCreatedAt !== artifactUpdatedAt ||
      artifactUpdatedAt > selectedFinalZeroWrite.updatedAt ||
      artifactExpiresAt <= currentRun.startedAt
    ) {
      fail(
        "production_postgres_source_repin_final_zero_write_artifact_invalid",
      );
    }
  }
  return Object.freeze({
    safePriorSkippedWriteRunIds: safePriorSkippedWriteRunIds.sort(
      (left, right) => Number(left) - Number(right),
    ),
    safePriorReadOnlyRunIds: [],
    reconciledPriorAmbiguousDisableRunId: null,
    priorAmbiguousProductionPostgresSourceRepinRunId: input.priorRunId,
    priorProductionPostgresSourceRepinIntentCandidateSha:
      input.priorCandidateSha,
    crossCandidateProductionPostgresSourceRepinRecoveryExact:
      input.priorCandidateSha !== input.candidateSha,
    productionPostgresSourceRepinRecoveryChainCandidateShas:
      input.priorCandidateSha === input.candidateSha
        ? [input.candidateSha]
        : input.recoveryBridge === null
        ? [input.priorCandidateSha, input.candidateSha]
        : [
          input.priorCandidateSha,
          input.recoveryBridge.candidateSha,
          input.recoveryBridge.stagedRecoveryCandidateSha,
          ...(input.postStageBridge == null
            ? []
            : [input.postStageBridge.postStageBridgeCandidateSha]),
          ...(input.finalZeroWriteBridge == null
            ? []
            : [input.finalZeroWriteBridge.finalZeroWriteBridgeCandidateSha]),
          input.candidateSha,
        ],
    productionPostgresSourceRepinRecoveryBridgeExact:
      input.recoveryBridge !== null,
    productionPostgresSourceRepinPostStageBridgeExact:
      input.postStageBridge != null,
    productionPostgresSourceRepinFinalZeroWriteBridgeExact:
      input.finalZeroWriteBridge !== null,
    productionPostgresSourceRepinFinalZeroWriteArtifactMetadataExact:
      input.finalZeroWriteBridge !== null,
    provenZeroWriteProductionPostgresSourceRepinRunId:
      selectedFinalZeroWrite === null
        ? null
        : String(selectedFinalZeroWrite.run.id),
    exactPriorProductionPostgresSourceRepinCandidateRunBound: true,
    secondProductionPostgresRemediationDismissPreventedExact: true,
    runnerLossRecoveryOriginalRunCompletedAt: new Date(
      selectedOriginal.updatedAt,
    ).toISOString(),
    runnerLossRecoverySettlementSeconds:
      PRODUCTION_POSTGRES_SOURCE_REPIN_RECOVERY_SETTLEMENT_MS / 1_000,
    runnerLossRecoveryGraceHours: recoveryGraceHours,
    runnerLossRecoveryWithinGraceExact: true,
    productionPostgresSourceRepinStagedRecoveryRunExact:
      input.stagedRecovery !== null,
    productionPostgresSourceRepinStagedRecoveryArtifactMetadataExact:
      input.stagedRecovery !== null,
    priorPossiblyWritingProductionPostgresSourceReconcileRunId:
      selectedStagedRecovery === null
        ? null
        : String(selectedStagedRecovery.run.id),
    noAdditionalPossiblyWritingProductionPostgresSourceLockRunsExact: true,
    runnerLossRecoveryStageRunCompletedAt:
      selectedStagedRecovery === null
        ? null
        : new Date(selectedStagedRecovery.updatedAt).toISOString(),
    runnerLossRecoveryStageSettlementSeconds:
      input.stagedRecovery?.stagedRecoverySettlementSeconds ?? null,
    runnerLossRecoveryStageGraceHours:
      input.stagedRecovery?.stagedRecoveryGraceHours ?? null,
    runnerLossRecoveryStageWithinGraceExact: true,
    runnerLossRecoveryFinalZeroWriteRunCompletedAt:
      selectedFinalZeroWrite === null
        ? null
        : new Date(selectedFinalZeroWrite.updatedAt).toISOString(),
    runnerLossRecoveryFinalZeroWriteSettlementSeconds:
      input.finalZeroWriteBridge?.finalZeroWriteSettlementSeconds ?? null,
    runnerLossRecoveryFinalZeroWriteWithinSettlementExact:
      input.finalZeroWriteBridge !== null,
  });
}

async function verifyProductionPostgresSourceRepinApplyHistory(
  input,
  currentRun,
) {
  const applyConfiguration = operationConfiguration(
    PRODUCTION_POSTGRES_SOURCE_REPIN_OPERATION,
    input.candidateSha,
    null,
    null,
  );
  const reconcileConfiguration = operationConfiguration(
    PRODUCTION_POSTGRES_SOURCE_REPIN_RECONCILE_OPERATION,
    input.candidateSha,
    null,
    null,
  );
  const history = await listWorkflowHistory({
    ...input,
    workflowId: PRODUCTION_POSTGRES_SOURCE_REPIN_WORKFLOW_ID,
  });
  const candidateRuns = history.filter((run) =>
    run?.head_sha === input.candidateSha);
  if (new Set(candidateRuns.map((run) => run?.id)).size !== candidateRuns.length) {
    fail("history_invalid");
  }
  let currentSeen = false;
  const safePriorSkippedWriteRunIds = [];
  for (const observed of candidateRuns) {
    const configuration = observed?.display_title === applyConfiguration.displayTitle
      ? applyConfiguration
      : observed?.display_title === reconcileConfiguration.displayTitle
      ? reconcileConfiguration
      : null;
    if (configuration === null) fail("history_invalid");
    const run = validateRunIdentity(observed, {
      runId: observed?.id,
      candidateSha: input.candidateSha,
      workflowPath: PRODUCTION_POSTGRES_SOURCE_REPIN_WORKFLOW_PATH,
      displayTitle: configuration.displayTitle,
      failureCode: "history_invalid",
    });
    if (run.createdAt < input.mergedAtMs ||
      run.createdAt > input.currentStartedAtMs) {
      fail("history_invalid");
    }
    if (run.id === currentRun.id) {
      if (configuration !== applyConfiguration || currentSeen ||
        !isNonterminalRun(run) ||
        run.created_at !== currentRun.created_at ||
        run.run_started_at !== currentRun.run_started_at) {
        fail("history_invalid");
      }
      currentSeen = true;
      continue;
    }
    if (await priorRunWriteDisposition(input, run, configuration) !== "skipped") {
      fail("prior_write_ambiguous");
    }
    if (run.updatedAt >= currentRun.startedAt) fail("history_invalid");
    safePriorSkippedWriteRunIds.push(String(run.id));
  }
  if (!currentSeen) fail("history_invalid");
  return Object.freeze({
    safePriorSkippedWriteRunIds: safePriorSkippedWriteRunIds.sort(
      (left, right) => Number(left) - Number(right),
    ),
    safePriorReadOnlyRunIds: [],
    reconciledPriorAmbiguousDisableRunId: null,
  });
}

function coldConfigurationForTitle(displayTitle, candidateSha) {
  for (const operation of COLD_RECOVERY_OPERATIONS) {
    const configuration = operationConfiguration(
      operation,
      candidateSha,
      null,
      null,
    );
    if (configuration.displayTitle === displayTitle) {
      return Object.freeze({ operation, configuration });
    }
  }
  return null;
}

async function verifyColdQuiesceReconciliationHistory(input, currentRun) {
  const history = await listWorkflowHistory({
    ...input,
    workflowId: COLD_RECOVERY_WORKFLOW_ID,
  });
  const candidateRuns = history.filter((run) =>
    run?.head_sha === input.candidateSha);
  if (new Set(candidateRuns.map((run) => run?.id)).size !== candidateRuns.length) {
    fail("cold_reconciliation_history_invalid");
  }
  let currentSeen = false;
  let selectedPrepare = null;
  let ambiguousPrepare = null;
  let selectedQuiesce = null;
  const safePriorSkippedWriteRuns = [];
  const safePrepareReadOnlyRuns = [];
  const safeQuiesceReadOnlyRuns = [];
  for (const observed of candidateRuns) {
    const classified = coldConfigurationForTitle(
      observed?.display_title,
      input.candidateSha,
    );
    if (classified === null) fail("cold_reconciliation_history_invalid");
    const run = validateRunIdentity(observed, {
      runId: observed?.id,
      candidateSha: input.candidateSha,
      workflowPath: COLD_RECOVERY_WORKFLOW_PATH,
      displayTitle: classified.configuration.displayTitle,
      failureCode: "cold_reconciliation_history_invalid",
    });
    if (run.createdAt < input.mergedAtMs ||
      run.createdAt > input.currentStartedAtMs) {
      fail("cold_reconciliation_history_invalid");
    }
    if (run.id === currentRun.id) {
      if (classified.operation !== "cold-recovery-reconcile-quiesce" ||
        currentSeen || !isNonterminalRun(run) ||
        run.created_at !== currentRun.created_at ||
        run.run_started_at !== currentRun.run_started_at) {
        fail("cold_reconciliation_history_invalid");
      }
      currentSeen = true;
      continue;
    }
    if (classified.operation === "cold-recovery-reconcile-quiesce") {
      if (!await priorReadOnlyReconciliationRunExact(
        input,
        run,
        classified.configuration,
      )) fail("cold_reconciliation_history_invalid");
      safeQuiesceReadOnlyRuns.push(Object.freeze({
        run,
        updatedAt: run.updatedAt,
      }));
      continue;
    }
    if (classified.operation === "cold-recovery-reconcile-prepare") {
      if (String(run.id) === input.prepareRunId) {
        if (selectedPrepare !== null ||
          !await successfulReadOnlyReconciliationRunExact(
            input,
            run,
            classified.configuration,
          )) {
          fail("cold_reconciliation_history_invalid");
        }
        selectedPrepare = Object.freeze({
          run,
          updatedAt: run.updatedAt,
          reconciled: true,
        });
      } else {
        if (!await priorReadOnlyReconciliationRunExact(
          input,
          run,
          classified.configuration,
        )) fail("cold_reconciliation_history_invalid");
        safePrepareReadOnlyRuns.push(Object.freeze({
          run,
          updatedAt: run.updatedAt,
        }));
      }
      continue;
    }
    if (classified.operation === "cold-recovery-prepare" &&
      String(run.id) === input.prepareRunId) {
      if (selectedPrepare !== null || run.status !== "completed" ||
        run.conclusion !== "success") {
        fail("cold_reconciliation_history_invalid");
      }
      selectedPrepare = Object.freeze({
        run,
        updatedAt: run.updatedAt,
        reconciled: false,
      });
      continue;
    }
    const disposition = await priorRunWriteDisposition(
      input,
      run,
      classified.configuration,
    );
    if (classified.operation === "cold-recovery-quiesce" &&
      String(run.id) === input.priorRunId) {
      if (selectedQuiesce !== null || disposition !== "may-have-written") {
        fail("cold_reconciliation_history_invalid");
      }
      selectedQuiesce = Object.freeze({
        run,
        updatedAt: parseTimestamp(
          run.updated_at,
          "cold_reconciliation_history_invalid",
        ),
      });
      continue;
    }
    if (classified.operation === "cold-recovery-prepare" &&
      disposition === "may-have-written") {
      if (ambiguousPrepare !== null) {
        fail("cold_reconciliation_history_invalid");
      }
      ambiguousPrepare = Object.freeze({ run, updatedAt: run.updatedAt });
      continue;
    }
    if (disposition !== "skipped") {
      fail("cold_reconciliation_history_invalid");
    }
    safePriorSkippedWriteRuns.push(Object.freeze({
      operation: classified.operation,
      run,
      updatedAt: run.updatedAt,
    }));
  }
  safePrepareReadOnlyRuns.sort((left, right) =>
    left.run.startedAt - right.run.startedAt);
  safeQuiesceReadOnlyRuns.sort((left, right) =>
    left.run.startedAt - right.run.startedAt);
  const prepareReconciliationChronologyExact = selectedPrepare !== null &&
    (selectedPrepare.reconciled === false
      ? ambiguousPrepare === null && safePrepareReadOnlyRuns.length === 0
      : ambiguousPrepare !== null &&
        ambiguousPrepare.run.startedAt - input.mergedAtMs <=
          MAX_CANDIDATE_AGE_MS &&
        safePrepareReadOnlyRuns.every((item, index) =>
          (index === 0
            ? ambiguousPrepare.updatedAt < item.run.startedAt
            : safePrepareReadOnlyRuns[index - 1].updatedAt <
              item.run.startedAt)) &&
        (safePrepareReadOnlyRuns.length === 0
          ? ambiguousPrepare.updatedAt < selectedPrepare.run.startedAt
          : safePrepareReadOnlyRuns.at(-1).updatedAt <
            selectedPrepare.run.startedAt));
  const skippedChronologyExact = selectedPrepare !== null &&
    selectedQuiesce !== null && safePriorSkippedWriteRuns.every((item) =>
      item.updatedAt < (item.operation === "cold-recovery-prepare"
        ? ambiguousPrepare?.run.startedAt ?? selectedPrepare.run.startedAt
        : selectedQuiesce.run.startedAt));
  if (!currentSeen || selectedPrepare === null || selectedQuiesce === null ||
    !prepareReconciliationChronologyExact ||
    !skippedChronologyExact ||
    selectedPrepare.updatedAt >= selectedQuiesce.run.startedAt ||
    selectedQuiesce.updatedAt >= currentRun.startedAt ||
    selectedQuiesce.run.startedAt - input.mergedAtMs > MAX_CANDIDATE_AGE_MS ||
    currentRun.startedAt - selectedQuiesce.updatedAt > RECOVERY_GRACE_MS ||
    safeQuiesceReadOnlyRuns.some((item, index) =>
      (index === 0
        ? selectedQuiesce.updatedAt >= item.run.startedAt
        : safeQuiesceReadOnlyRuns[index - 1].updatedAt >= item.run.startedAt)) ||
    (safeQuiesceReadOnlyRuns.length > 0 &&
      safeQuiesceReadOnlyRuns.at(-1).updatedAt >= currentRun.startedAt)) {
    fail("cold_reconciliation_history_invalid");
  }
  return Object.freeze({
    safePriorSkippedWriteRunIds: safePriorSkippedWriteRuns.map((item) =>
      String(item.run.id)).sort(
      (left, right) => Number(left) - Number(right),
    ),
    safePriorReadOnlyRunIds: [
      ...safePrepareReadOnlyRuns,
      ...safeQuiesceReadOnlyRuns,
    ].map((item) => String(item.run.id)).sort(
      (left, right) => Number(left) - Number(right),
    ),
    reconciledPriorAmbiguousDisableRunId: null,
    priorAmbiguousColdQuiesceRunId: input.priorRunId,
    selectedColdPrepareRunId: input.prepareRunId,
    exactPriorColdQuiesceCandidateRunBound: true,
    secondColdScaleWritePreventedExact: true,
    runnerLossRecoveryOriginalRunCompletedAt: new Date(
      selectedQuiesce.updatedAt,
    ).toISOString(),
    runnerLossRecoveryGraceHours: RECOVERY_GRACE_HOURS,
    runnerLossRecoveryWithinGraceExact: true,
  });
}

export async function verifyColdQuiesceSuccessorBridge(
  input,
  policy,
  currentPull,
  currentRun,
) {
  const expected = COLD_QUIESCE_SUCCESSOR_BRIDGE;
  if (
    input.priorCandidateSha !== expected.priorCandidateSha ||
    input.priorRunId !== String(expected.priorQuiesceRunId) ||
    input.failedPrewriteCandidateSha !== expected.failedPrewriteCandidateSha ||
    input.failedPrewriteRunId !== String(expected.failedPrewriteQuiesceRunId)
  ) fail("cold_quiesce_successor_bridge_invalid");

  let priorPull;
  let intermediatePull;
  let failedSuccessorPull;
  let failedPrewritePull;
  try {
    priorPull = await verifyReviewedPullRequest(
      input.fetchImpl,
      input.token,
      policy,
      expected.legacyCandidateSha,
    );
    intermediatePull = await verifyReviewedPullRequest(
      input.fetchImpl,
      input.token,
      policy,
      expected.intermediateCandidateSha,
    );
    failedSuccessorPull = await verifyReviewedPullRequest(
      input.fetchImpl,
      input.token,
      policy,
      expected.failedSuccessorCandidateSha,
    );
    failedPrewritePull = await verifyReviewedPullRequest(
      input.fetchImpl,
      input.token,
      policy,
      expected.failedPrewriteCandidateSha,
    );
  } catch {
    fail("cold_quiesce_successor_bridge_invalid");
  }
  const intermediateCommit = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/git/commits/${expected.intermediateCandidateSha}`,
  );
  const currentCommit = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/git/commits/${input.candidateSha}`,
  );
  const failedSuccessorCommit = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/git/commits/${expected.failedSuccessorCandidateSha}`,
  );
  const failedPrewriteCommit = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/git/commits/${expected.failedPrewriteCandidateSha}`,
  );
  if (
    priorPull.number !== expected.legacyPullRequestNumber ||
    priorPull.reviewedPrHeadSha !== expected.legacyReviewedHeadSha ||
    priorPull.treeSha !== expected.legacyTreeSha ||
    priorPull.mergedAt !== expected.legacyMergedAt ||
    intermediatePull.number !== expected.intermediatePullRequestNumber ||
    intermediatePull.reviewedPrHeadSha !==
      expected.intermediateReviewedHeadSha ||
    intermediatePull.treeSha !== expected.intermediateTreeSha ||
    intermediatePull.mergedAt !== expected.intermediateMergedAt ||
    intermediateCommit?.sha !== expected.intermediateCandidateSha ||
    intermediateCommit?.tree?.sha !== expected.intermediateTreeSha ||
    !Array.isArray(intermediateCommit?.parents) ||
    intermediateCommit.parents.length !== 1 ||
    intermediateCommit.parents[0]?.sha !== expected.legacyCandidateSha ||
    failedSuccessorPull.number !== expected.failedSuccessorPullRequestNumber ||
    failedSuccessorPull.reviewedPrHeadSha !==
      expected.failedSuccessorReviewedHeadSha ||
    failedSuccessorPull.treeSha !== expected.failedSuccessorTreeSha ||
    failedSuccessorPull.mergedAt !== expected.failedSuccessorMergedAt ||
    failedSuccessorCommit?.sha !== expected.failedSuccessorCandidateSha ||
    failedSuccessorCommit?.tree?.sha !== expected.failedSuccessorTreeSha ||
    !Array.isArray(failedSuccessorCommit?.parents) ||
    failedSuccessorCommit.parents.length !== 1 ||
    failedSuccessorCommit.parents[0]?.sha !== expected.intermediateCandidateSha ||
    failedPrewritePull.number !== expected.failedPrewritePullRequestNumber ||
    failedPrewritePull.reviewedPrHeadSha !==
      expected.failedPrewriteReviewedHeadSha ||
    failedPrewritePull.treeSha !== expected.failedPrewriteTreeSha ||
    failedPrewritePull.mergedAt !== expected.failedPrewriteMergedAt ||
    failedPrewriteCommit?.sha !== expected.failedPrewriteCandidateSha ||
    failedPrewriteCommit?.tree?.sha !== expected.failedPrewriteTreeSha ||
    !Array.isArray(failedPrewriteCommit?.parents) ||
    failedPrewriteCommit.parents.length !== 1 ||
    failedPrewriteCommit.parents[0]?.sha !==
      expected.failedSuccessorCandidateSha ||
    currentCommit?.sha !== input.candidateSha ||
    currentCommit?.tree?.sha !== currentPull.treeSha ||
    !Array.isArray(currentCommit?.parents) ||
    currentCommit.parents.length !== 1 ||
    currentCommit.parents[0]?.sha !== expected.failedPrewriteCandidateSha
  ) fail("cold_quiesce_successor_bridge_invalid");

  const currentPrepareRunId = Number(input.prepareRunId);
  if (
    !RUN_ID.test(input.prepareRunId ?? "") ||
    !Number.isSafeInteger(currentPrepareRunId) ||
    currentPrepareRunId === currentRun.id
  ) fail("cold_quiesce_successor_bridge_history_invalid");
  let history;
  try {
    history = await listCompleteWorkflowHistoryAllRefs({
      ...input,
      workflowId: COLD_RECOVERY_WORKFLOW_ID,
    });
  } catch {
    fail("cold_quiesce_successor_bridge_history_invalid");
  }
  const priorMergedAtMs = Date.parse(expected.legacyMergedAt);
  const retained = history.map((run) => Object.freeze({
    run,
    createdAt: parseTimestamp(
      run?.created_at,
      "cold_quiesce_successor_bridge_history_invalid",
    ),
    updatedAt: parseTimestamp(
      run?.updated_at,
      "cold_quiesce_successor_bridge_history_invalid",
    ),
  }));
  const relevant = retained.filter((item) =>
    item.run?.status !== "completed" ||
    typeof item.run?.conclusion !== "string" ||
    item.run.conclusion.length === 0 ||
    item.updatedAt >= priorMergedAtMs
  ).map((item) => item.run);
  const priorRuns = relevant.filter((run) =>
    run?.head_sha === expected.legacyCandidateSha);
  const intermediateRuns = relevant.filter((run) =>
    run?.head_sha === expected.intermediateCandidateSha);
  const failedSuccessorRuns = relevant.filter((run) =>
    run?.head_sha === expected.failedSuccessorCandidateSha);
  const failedPrewriteRuns = relevant.filter((run) =>
    run?.head_sha === expected.failedPrewriteCandidateSha);
  const currentRuns = relevant.filter((run) =>
    run?.head_sha === input.candidateSha);
  const expectedRunIds = [
    expected.prepareRunId,
    expected.ambiguousQuiesceRunId,
    expected.failedReadOnlyReconcileRunId,
    expected.intermediateAmbiguousPrepareRunId,
    expected.intermediateFailedReadOnlyPrepareReconcileRunId,
    expected.failedSuccessorPrepareRunId,
    expected.failedSuccessorQuiesceRunId,
    expected.failedPrewritePrepareRunId,
    expected.failedPrewriteQuiesceRunId,
    currentPrepareRunId,
    currentRun.id,
  ];
  if (
    relevant.length !== expectedRunIds.length ||
    priorRuns.length !== 3 ||
    intermediateRuns.length !== 2 ||
    failedSuccessorRuns.length !== 2 ||
    failedPrewriteRuns.length !== 2 ||
    currentRuns.length !== 2 ||
    new Set(relevant.map((run) => run?.id)).size !== relevant.length ||
    expectedRunIds.some((id) => !relevant.some((run) => run?.id === id)) ||
    relevant.some((run) =>
      run?.head_sha !== expected.legacyCandidateSha &&
      run?.head_sha !== expected.intermediateCandidateSha &&
      run?.head_sha !== expected.failedSuccessorCandidateSha &&
      run?.head_sha !== expected.failedPrewriteCandidateSha &&
      run?.head_sha !== input.candidateSha)
  ) fail("cold_quiesce_successor_bridge_history_invalid");

  const validatePinnedRun = (
    runs,
    candidateSha,
    runId,
    operation,
    expectedRun,
  ) => {
    const currentConfiguration = operationConfiguration(
      operation,
      candidateSha,
      null,
      null,
    );
    const configuration = runId === expected.ambiguousQuiesceRunId &&
        operation === "cold-recovery-quiesce"
      ? Object.freeze({
        ...currentConfiguration,
        jobName: LEGACY_AMBIGUOUS_COLD_QUIESCE_JOB_NAME,
        writeStep: LEGACY_AMBIGUOUS_COLD_QUIESCE_WRITE_STEP,
      })
      : currentConfiguration;
    const run = validateRunIdentity(
      runs.find((item) => item?.id === runId),
      {
        runId,
        candidateSha,
        workflowPath: COLD_RECOVERY_WORKFLOW_PATH,
        displayTitle: configuration.displayTitle,
        failureCode: "cold_quiesce_successor_bridge_history_invalid",
      },
    );
    if (
      run.created_at !== expectedRun.createdAt ||
      run.run_started_at !== expectedRun.startedAt ||
      run.updated_at !== expectedRun.completedAt ||
      run.status !== "completed" ||
      run.conclusion !== expectedRun.conclusion
    ) fail("cold_quiesce_successor_bridge_history_invalid");
    return Object.freeze({ run, configuration });
  };
  const prepare = validatePinnedRun(
    priorRuns,
    expected.legacyCandidateSha,
    expected.prepareRunId,
    "cold-recovery-prepare",
    {
      createdAt: expected.prepareRunCreatedAt,
      startedAt: expected.prepareRunStartedAt,
      completedAt: expected.prepareRunCompletedAt,
      conclusion: "success",
    },
  );
  const quiesce = validatePinnedRun(
    priorRuns,
    expected.legacyCandidateSha,
    expected.ambiguousQuiesceRunId,
    "cold-recovery-quiesce",
    {
      createdAt: expected.ambiguousQuiesceRunCreatedAt,
      startedAt: expected.ambiguousQuiesceRunStartedAt,
      completedAt: expected.ambiguousQuiesceRunCompletedAt,
      conclusion: "failure",
    },
  );
  const reconciliation = validatePinnedRun(
    priorRuns,
    expected.legacyCandidateSha,
    expected.failedReadOnlyReconcileRunId,
    "cold-recovery-reconcile-quiesce",
    {
      createdAt: expected.failedReadOnlyReconcileRunCreatedAt,
      startedAt: expected.failedReadOnlyReconcileRunStartedAt,
      completedAt: expected.failedReadOnlyReconcileRunCompletedAt,
      conclusion: "failure",
    },
  );
  const intermediatePrepare = validatePinnedRun(
    intermediateRuns,
    expected.intermediateCandidateSha,
    expected.intermediateAmbiguousPrepareRunId,
    "cold-recovery-prepare",
    {
      createdAt: expected.intermediateAmbiguousPrepareRunCreatedAt,
      startedAt: expected.intermediateAmbiguousPrepareRunStartedAt,
      completedAt: expected.intermediateAmbiguousPrepareRunCompletedAt,
      conclusion: "failure",
    },
  );
  const intermediatePrepareReconciliation = validatePinnedRun(
    intermediateRuns,
    expected.intermediateCandidateSha,
    expected.intermediateFailedReadOnlyPrepareReconcileRunId,
    "cold-recovery-reconcile-prepare",
    {
      createdAt:
        expected.intermediateFailedReadOnlyPrepareReconcileRunCreatedAt,
      startedAt:
        expected.intermediateFailedReadOnlyPrepareReconcileRunStartedAt,
      completedAt:
        expected.intermediateFailedReadOnlyPrepareReconcileRunCompletedAt,
      conclusion: "failure",
    },
  );
  const failedSuccessorPrepare = validatePinnedRun(
    failedSuccessorRuns,
    expected.failedSuccessorCandidateSha,
    expected.failedSuccessorPrepareRunId,
    "cold-recovery-prepare",
    {
      createdAt: expected.failedSuccessorPrepareRunCreatedAt,
      startedAt: expected.failedSuccessorPrepareRunStartedAt,
      completedAt: expected.failedSuccessorPrepareRunCompletedAt,
      conclusion: "success",
    },
  );
  const failedSuccessorQuiesce = validatePinnedRun(
    failedSuccessorRuns,
    expected.failedSuccessorCandidateSha,
    expected.failedSuccessorQuiesceRunId,
    "cold-recovery-quiesce",
    {
      createdAt: expected.failedSuccessorQuiesceRunCreatedAt,
      startedAt: expected.failedSuccessorQuiesceRunStartedAt,
      completedAt: expected.failedSuccessorQuiesceRunCompletedAt,
      conclusion: "failure",
    },
  );
  const failedPrewritePrepare = validatePinnedRun(
    failedPrewriteRuns,
    expected.failedPrewriteCandidateSha,
    expected.failedPrewritePrepareRunId,
    "cold-recovery-prepare",
    {
      createdAt: expected.failedPrewritePrepareRunCreatedAt,
      startedAt: expected.failedPrewritePrepareRunStartedAt,
      completedAt: expected.failedPrewritePrepareRunCompletedAt,
      conclusion: "success",
    },
  );
  const failedPrewriteQuiesce = validatePinnedRun(
    failedPrewriteRuns,
    expected.failedPrewriteCandidateSha,
    expected.failedPrewriteQuiesceRunId,
    "cold-recovery-quiesce",
    {
      createdAt: expected.failedPrewriteQuiesceRunCreatedAt,
      startedAt: expected.failedPrewriteQuiesceRunStartedAt,
      completedAt: expected.failedPrewriteQuiesceRunCompletedAt,
      conclusion: "failure",
    },
  );
  const currentPrepareConfiguration = operationConfiguration(
    "cold-recovery-prepare",
    input.candidateSha,
    null,
    null,
  );
  const currentPrepare = validateRunIdentity(
    currentRuns.find((run) => run?.id === currentPrepareRunId),
    {
      runId: currentPrepareRunId,
      candidateSha: input.candidateSha,
      workflowPath: COLD_RECOVERY_WORKFLOW_PATH,
      displayTitle: currentPrepareConfiguration.displayTitle,
      failureCode: "cold_quiesce_successor_bridge_history_invalid",
    },
  );
  const currentConfiguration = operationConfiguration(
    COLD_QUIESCE_SUCCESSOR_OPERATION,
    input.candidateSha,
    null,
    null,
  );
  const selectedCurrent = validateRunIdentity(
    currentRuns.find((run) => run?.id === currentRun.id),
    {
      runId: currentRun.id,
      candidateSha: input.candidateSha,
      workflowPath: COLD_RECOVERY_WORKFLOW_PATH,
      displayTitle: currentConfiguration.displayTitle,
      failureCode: "cold_quiesce_successor_bridge_history_invalid",
    },
  );
  const intermediateMergedAtMs = parseTimestamp(
    expected.intermediateMergedAt,
    "cold_quiesce_successor_bridge_history_invalid",
  );
  const failedSuccessorMergedAtMs = parseTimestamp(
    expected.failedSuccessorMergedAt,
    "cold_quiesce_successor_bridge_history_invalid",
  );
  const failedPrewriteMergedAtMs = parseTimestamp(
    expected.failedPrewriteMergedAt,
    "cold_quiesce_successor_bridge_history_invalid",
  );
  if (
    await priorRunWriteDisposition(
      input,
      quiesce.run,
      quiesce.configuration,
    ) !== "may-have-written" ||
    !await readOnlyReconciliationRunExact(
      input,
      reconciliation.run,
      reconciliation.configuration,
      ["failure", "cancelled", "timed_out"],
      exactWorkflowJobNames(
        COLD_RECOVERY_WORKFLOW_PATH,
        LEGACY_AMBIGUOUS_COLD_QUIESCE_JOB_NAME,
      ),
    ) ||
    await priorRunWriteDisposition(
      input,
      intermediatePrepare.run,
      intermediatePrepare.configuration,
    ) !== "may-have-written" ||
    !await readOnlyReconciliationRunExact(
      input,
      intermediatePrepareReconciliation.run,
      intermediatePrepareReconciliation.configuration,
      ["failure"],
    ) ||
    !await successfulWriteRunExact(
      input,
      failedSuccessorPrepare.run,
      failedSuccessorPrepare.configuration,
    ) ||
    !await successfulWriteRunExact(
      input,
      failedPrewritePrepare.run,
      failedPrewritePrepare.configuration,
    ) ||
    await priorRunWriteDisposition(
      input,
      failedPrewriteQuiesce.run,
      failedPrewriteQuiesce.configuration,
    ) !== "skipped" ||
    !await successfulWriteRunExact(
      input,
      currentPrepare,
      currentPrepareConfiguration,
    ) ||
    !isNonterminalRun(selectedCurrent) ||
    selectedCurrent.created_at !== currentRun.created_at ||
    selectedCurrent.run_started_at !== currentRun.run_started_at ||
    priorMergedAtMs >= prepare.run.createdAt ||
    prepare.run.updatedAt >= quiesce.run.startedAt ||
    quiesce.run.updatedAt >= reconciliation.run.startedAt ||
    reconciliation.run.updatedAt >= intermediateMergedAtMs ||
    intermediateMergedAtMs >= intermediatePrepare.run.createdAt ||
    intermediatePrepare.run.updatedAt >=
      intermediatePrepareReconciliation.run.startedAt ||
    intermediatePrepareReconciliation.run.updatedAt >=
      failedSuccessorMergedAtMs ||
    failedSuccessorMergedAtMs >= failedSuccessorPrepare.run.createdAt ||
    failedSuccessorPrepare.run.updatedAt >=
      failedSuccessorQuiesce.run.startedAt ||
    failedSuccessorQuiesce.run.updatedAt >= failedPrewriteMergedAtMs ||
    failedPrewriteMergedAtMs >= failedPrewritePrepare.run.createdAt ||
    failedPrewritePrepare.run.updatedAt >=
      failedPrewriteQuiesce.run.startedAt ||
    failedPrewriteQuiesce.run.updatedAt >= input.currentMergedAtMs ||
    input.currentMergedAtMs >= currentPrepare.createdAt ||
    currentPrepare.status !== "completed" ||
    currentPrepare.conclusion !== "success" ||
    currentPrepare.updatedAt >= selectedCurrent.createdAt ||
    selectedCurrent.startedAt >= Date.parse(expected.successorDeadline)
  ) fail("cold_quiesce_successor_bridge_history_invalid");

  const artifactListing = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/actions/runs/${expected.ambiguousQuiesceRunId}/artifacts?name=${encodeURIComponent(expected.artifactName)}&per_page=100&page=1`,
  );
  const artifact = artifactListing?.total_count === 1 &&
      Array.isArray(artifactListing?.artifacts) &&
      artifactListing.artifacts.length === 1
    ? artifactListing.artifacts[0]
    : null;
  const artifactCreatedAt = parseTimestamp(
    artifact?.created_at,
    "cold_quiesce_successor_bridge_artifact_invalid",
  );
  const artifactUpdatedAt = parseTimestamp(
    artifact?.updated_at,
    "cold_quiesce_successor_bridge_artifact_invalid",
  );
  const artifactExpiresAt = parseTimestamp(
    artifact?.expires_at,
    "cold_quiesce_successor_bridge_artifact_invalid",
  );
  if (
    artifact?.id !== expected.artifactId ||
    artifact?.name !== expected.artifactName ||
    artifact?.size_in_bytes !== expected.artifactBytes ||
    artifact?.digest !== expected.artifactDigest ||
    artifact?.expired !== false ||
    artifact?.created_at !== expected.artifactCreatedAt ||
    artifact?.updated_at !== expected.artifactCreatedAt ||
    artifact?.expires_at !== expected.artifactExpiresAt ||
    artifact?.workflow_run?.id !== expected.ambiguousQuiesceRunId ||
    artifact?.workflow_run?.head_branch !== "main" ||
    artifact?.workflow_run?.head_sha !== expected.legacyCandidateSha ||
    artifactCreatedAt !== artifactUpdatedAt ||
    artifactUpdatedAt > quiesce.run.updatedAt ||
    artifactExpiresAt <= currentRun.startedAt
  ) fail("cold_quiesce_successor_bridge_artifact_invalid");

  const failedSuccessorArtifactListing = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/actions/runs/${expected.failedSuccessorQuiesceRunId}/artifacts?name=${encodeURIComponent(expected.failedSuccessorArtifactName)}&per_page=100&page=1`,
  );
  const failedSuccessorArtifact =
      failedSuccessorArtifactListing?.total_count === 1 &&
      Array.isArray(failedSuccessorArtifactListing?.artifacts) &&
      failedSuccessorArtifactListing.artifacts.length === 1
    ? failedSuccessorArtifactListing.artifacts[0]
    : null;
  const failedSuccessorArtifactCreatedAt = parseTimestamp(
    failedSuccessorArtifact?.created_at,
    "cold_quiesce_successor_bridge_artifact_invalid",
  );
  const failedSuccessorArtifactUpdatedAt = parseTimestamp(
    failedSuccessorArtifact?.updated_at,
    "cold_quiesce_successor_bridge_artifact_invalid",
  );
  const failedSuccessorArtifactExpiresAt = parseTimestamp(
    failedSuccessorArtifact?.expires_at,
    "cold_quiesce_successor_bridge_artifact_invalid",
  );
  if (
    failedSuccessorArtifact?.id !== expected.failedSuccessorArtifactId ||
    failedSuccessorArtifact?.name !== expected.failedSuccessorArtifactName ||
    failedSuccessorArtifact?.size_in_bytes !==
      expected.failedSuccessorArtifactBytes ||
    failedSuccessorArtifact?.digest !== expected.failedSuccessorArtifactDigest ||
    failedSuccessorArtifact?.expired !== false ||
    failedSuccessorArtifact?.created_at !==
      expected.failedSuccessorArtifactCreatedAt ||
    failedSuccessorArtifact?.updated_at !==
      expected.failedSuccessorArtifactCreatedAt ||
    failedSuccessorArtifact?.expires_at !==
      expected.failedSuccessorArtifactExpiresAt ||
    failedSuccessorArtifact?.workflow_run?.id !==
      expected.failedSuccessorQuiesceRunId ||
    failedSuccessorArtifact?.workflow_run?.head_branch !== "main" ||
    failedSuccessorArtifact?.workflow_run?.head_sha !==
      expected.failedSuccessorCandidateSha ||
    failedSuccessorArtifactCreatedAt !== failedSuccessorArtifactUpdatedAt ||
    failedSuccessorArtifactUpdatedAt > failedSuccessorQuiesce.run.updatedAt ||
    failedSuccessorArtifactExpiresAt <= currentRun.startedAt
  ) fail("cold_quiesce_successor_bridge_artifact_invalid");

  const failedPrewriteArtifactListing = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/actions/runs/${expected.failedPrewriteQuiesceRunId}/artifacts?name=${encodeURIComponent(expected.failedPrewriteArtifactName)}&per_page=100&page=1`,
  );
  const failedPrewriteArtifact =
      failedPrewriteArtifactListing?.total_count === 1 &&
      Array.isArray(failedPrewriteArtifactListing?.artifacts) &&
      failedPrewriteArtifactListing.artifacts.length === 1
    ? failedPrewriteArtifactListing.artifacts[0]
    : null;
  const failedPrewriteArtifactCreatedAt = parseTimestamp(
    failedPrewriteArtifact?.created_at,
    "cold_quiesce_successor_bridge_artifact_invalid",
  );
  const failedPrewriteArtifactUpdatedAt = parseTimestamp(
    failedPrewriteArtifact?.updated_at,
    "cold_quiesce_successor_bridge_artifact_invalid",
  );
  const failedPrewriteArtifactExpiresAt = parseTimestamp(
    failedPrewriteArtifact?.expires_at,
    "cold_quiesce_successor_bridge_artifact_invalid",
  );
  if (
    failedPrewriteArtifact?.id !== expected.failedPrewriteArtifactId ||
    failedPrewriteArtifact?.name !== expected.failedPrewriteArtifactName ||
    failedPrewriteArtifact?.size_in_bytes !==
      expected.failedPrewriteArtifactBytes ||
    failedPrewriteArtifact?.digest !== expected.failedPrewriteArtifactDigest ||
    failedPrewriteArtifact?.expired !== false ||
    failedPrewriteArtifact?.created_at !==
      expected.failedPrewriteArtifactCreatedAt ||
    failedPrewriteArtifact?.updated_at !==
      expected.failedPrewriteArtifactCreatedAt ||
    failedPrewriteArtifact?.expires_at !==
      expected.failedPrewriteArtifactExpiresAt ||
    failedPrewriteArtifact?.workflow_run?.id !==
      expected.failedPrewriteQuiesceRunId ||
    failedPrewriteArtifact?.workflow_run?.head_branch !== "main" ||
    failedPrewriteArtifact?.workflow_run?.head_sha !==
      expected.failedPrewriteCandidateSha ||
    failedPrewriteArtifactCreatedAt !== failedPrewriteArtifactUpdatedAt ||
    failedPrewriteArtifactUpdatedAt > failedPrewriteQuiesce.run.updatedAt ||
    failedPrewriteArtifactExpiresAt <= currentRun.startedAt
  ) fail("cold_quiesce_successor_bridge_artifact_invalid");

  return Object.freeze({
    priorAmbiguousColdQuiesceCandidateSha: expected.priorCandidateSha,
    priorAmbiguousColdQuiesceReviewedHeadSha: expected.priorReviewedHeadSha,
    priorAmbiguousColdQuiesceTreeSha: expected.priorTreeSha,
    priorAmbiguousColdQuiescePullRequestNumber:
      expected.priorPullRequestNumber,
    priorAmbiguousColdQuiesceCandidateMergedAt: expected.priorMergedAt,
    priorAmbiguousColdQuiesceRunId: String(expected.priorQuiesceRunId),
    priorAmbiguousColdQuiesceRunCompletedAt:
      new Date(failedSuccessorQuiesce.run.updatedAt).toISOString(),
    coldQuiesceSuccessorGraceHours: expected.successorGraceHours,
    coldQuiesceSuccessorDeadline: expected.successorDeadline,
    coldQuiesceSuccessorWithinGraceExact: true,
    priorColdPrepareRunId: String(expected.priorPrepareRunId),
    selectedColdPrepareRunId: String(currentPrepareRunId),
    legacyColdRecoveryCandidateSha: expected.legacyCandidateSha,
    legacyColdRecoveryReviewedHeadSha: expected.legacyReviewedHeadSha,
    legacyColdRecoveryTreeSha: expected.legacyTreeSha,
    legacyColdRecoveryPullRequestNumber: expected.legacyPullRequestNumber,
    legacyColdRecoveryCandidateMergedAt: expected.legacyMergedAt,
    legacyColdPrepareRunId: String(expected.prepareRunId),
    legacyColdQuiesceRunId: String(expected.ambiguousQuiesceRunId),
    legacyColdQuiesceRunCompletedAt:
      new Date(quiesce.run.updatedAt).toISOString(),
    legacyFailedReadOnlyColdQuiesceReconcileRunId:
      String(expected.failedReadOnlyReconcileRunId),
    intermediateColdRecoveryCandidateSha:
      expected.intermediateCandidateSha,
    intermediateColdRecoveryReviewedHeadSha:
      expected.intermediateReviewedHeadSha,
    intermediateColdRecoveryTreeSha: expected.intermediateTreeSha,
    intermediateColdRecoveryPullRequestNumber:
      expected.intermediatePullRequestNumber,
    intermediateColdRecoveryCandidateMergedAt:
      expected.intermediateMergedAt,
    intermediateAmbiguousColdPrepareRunId:
      String(expected.intermediateAmbiguousPrepareRunId),
    intermediateFailedReadOnlyColdPrepareReconcileRunId:
      String(expected.intermediateFailedReadOnlyPrepareReconcileRunId),
    selectedColdPrepareRunStartedAt:
      new Date(currentPrepare.startedAt).toISOString(),
    selectedColdPrepareRunCompletedAt:
      new Date(currentPrepare.updatedAt).toISOString(),
    priorAmbiguousColdQuiesceArtifactId:
      String(expected.failedSuccessorArtifactId),
    priorAmbiguousColdQuiesceArtifactName:
      expected.failedSuccessorArtifactName,
    priorAmbiguousColdQuiesceArtifactDigest:
      expected.failedSuccessorArtifactDigest,
    failedPrewriteColdRecoveryCandidateSha:
      expected.failedPrewriteCandidateSha,
    failedPrewriteColdRecoveryReviewedHeadSha:
      expected.failedPrewriteReviewedHeadSha,
    failedPrewriteColdRecoveryTreeSha: expected.failedPrewriteTreeSha,
    failedPrewriteColdRecoveryPullRequestNumber:
      expected.failedPrewritePullRequestNumber,
    failedPrewriteColdRecoveryCandidateMergedAt:
      expected.failedPrewriteMergedAt,
    failedPrewriteReplacementRunId:
      String(expected.failedPrewriteReplacementRunId),
    failedPrewriteReplacementRunStartedAt:
      new Date(expected.failedPrewriteReplacementRunStartedAt).toISOString(),
    failedPrewriteReplacementRunCompletedAt:
      new Date(expected.failedPrewriteReplacementRunCompletedAt).toISOString(),
    failedPrewriteColdPrepareRunId:
      String(expected.failedPrewritePrepareRunId),
    failedPrewriteColdQuiesceRunId:
      String(expected.failedPrewriteQuiesceRunId),
    failedPrewriteColdQuiesceRunCompletedAt:
      new Date(failedPrewriteQuiesce.run.updatedAt).toISOString(),
    failedPrewriteColdQuiesceArtifactId:
      String(expected.failedPrewriteArtifactId),
    failedPrewriteColdQuiesceArtifactName:
      expected.failedPrewriteArtifactName,
    failedPrewriteColdQuiesceArtifactDigest:
      expected.failedPrewriteArtifactDigest,
    legacyAmbiguousColdQuiesceArtifactId: String(expected.artifactId),
    legacyAmbiguousColdQuiesceArtifactName: expected.artifactName,
    legacyAmbiguousColdQuiesceArtifactDigest: expected.artifactDigest,
    coldQuiesceSuccessorDirectParentExact: true,
    coldQuiesceSuccessorLegacyToIntermediateParentExact: true,
    coldQuiesceSuccessorIntermediateToPriorParentExact: true,
    coldQuiesceSuccessorPriorToFailedPrewriteParentExact: true,
    coldQuiesceSuccessorCompleteFiveCandidateLineageExact: true,
    coldQuiesceSuccessorLegacyHistoryExact: true,
    coldQuiesceSuccessorIntermediateHistoryExact: true,
    coldQuiesceSuccessorPriorHistoryExact: true,
    coldQuiesceSuccessorFailedPrewriteHistoryExact: true,
    coldQuiesceSuccessorFailedPrewriteSkippedExact: true,
    coldQuiesceSuccessorAllRefsHistoryExact: true,
    coldQuiesceSuccessorCurrentPrepareExact: true,
    coldQuiesceSuccessorLegacyArtifactMetadataExact: true,
    coldQuiesceSuccessorPriorArtifactMetadataExact: true,
    coldQuiesceSuccessorFailedPrewriteArtifactMetadataExact: true,
    coldQuiesceSuccessorPriorProviderProofRequired: true,
    coldQuiesceSuccessorBridgeRequired: true,
  });
}

function runnerLossRecoveryConfiguration(operation, candidateSha) {
  if (operation === "cold-recovery-reconcile-prepare") {
    return Object.freeze({
      workflowId: COLD_RECOVERY_WORKFLOW_ID,
      workflowPath: COLD_RECOVERY_WORKFLOW_PATH,
      current: operationConfiguration(operation, candidateSha, null, null),
      original: operationConfiguration(
        "cold-recovery-prepare",
        candidateSha,
        null,
        null,
      ),
      allowedSuccessfulPredecessor: null,
      output: "cold-prepare",
    });
  }
  if (operation === "staging-worker-bootstrap-reconcile-restore") {
    return Object.freeze({
      workflowId: STAGING_BOOTSTRAP_WORKFLOW_ID,
      workflowPath: STAGING_BOOTSTRAP_WORKFLOW_PATH,
      current: operationConfiguration(operation, candidateSha, null, null),
      original: Object.freeze({
        workflowPath: STAGING_BOOTSTRAP_WORKFLOW_PATH,
        workflowId: STAGING_BOOTSTRAP_WORKFLOW_ID,
        displayTitle:
          `Permanent staging worker bootstrap | restore | ${candidateSha}`,
        jobName: "Verify the chain and perform one exact protected scale transition",
        writeStep: "Perform at most one exact candidate-bound scale transition",
      }),
      allowedSuccessfulPredecessor:
        `Permanent staging worker bootstrap | quiesce | ${candidateSha}`,
      output: "restore",
    });
  }
  if (operation === "staging-worker-fence-reconcile-activate") {
    return Object.freeze({
      workflowId: WORKER_FENCE_WORKFLOW_ID,
      workflowPath: WORKER_FENCE_WORKFLOW_PATH,
      current: operationConfiguration(operation, candidateSha, null, null),
      original: Object.freeze({
        workflowPath: WORKER_FENCE_WORKFLOW_PATH,
        workflowId: WORKER_FENCE_WORKFLOW_ID,
        displayTitle:
          `Automatic maintenance worker fence | permanent-staging | activate | ${candidateSha}`,
        jobName: "One candidate-bound automatic-maintenance transition",
        writeStep: "Execute at most one exact atomic Railway variable upsert",
      }),
      allowedSuccessfulPredecessor:
        `Automatic maintenance worker fence | permanent-staging | prepare | ${candidateSha}`,
      output: "activate",
    });
  }
  fail("runner_loss_reconciliation_history_invalid");
}

async function verifyRunnerLossReconciliationHistory(input, currentRun) {
  const phase = runnerLossRecoveryConfiguration(input.operation, input.candidateSha);
  const history = await listWorkflowHistory({
    ...input,
    workflowId: phase.workflowId,
  });
  const candidateRuns = history.filter((run) =>
    run?.head_sha === input.candidateSha);
  if (new Set(candidateRuns.map((run) => run?.id)).size !== candidateRuns.length) {
    fail("runner_loss_reconciliation_history_invalid");
  }
  let currentSeen = false;
  let selectedOriginal = null;
  let successfulPredecessor = null;
  const safePriorSkippedWriteRunIds = [];
  const safePriorReadOnlyRuns = [];
  for (const observed of candidateRuns) {
    const title = observed?.display_title;
    const configuration = title === phase.current.displayTitle
      ? phase.current
      : title === phase.original.displayTitle
      ? phase.original
      : title === phase.allowedSuccessfulPredecessor
      ? Object.freeze({
          workflowPath: phase.workflowPath,
          displayTitle: title,
        })
      : null;
    if (configuration === null) {
      fail("runner_loss_reconciliation_history_invalid");
    }
    const run = validateRunIdentity(observed, {
      runId: observed?.id,
      candidateSha: input.candidateSha,
      workflowPath: phase.workflowPath,
      displayTitle: configuration.displayTitle,
      failureCode: "runner_loss_reconciliation_history_invalid",
    });
    if (run.createdAt < input.mergedAtMs ||
      run.createdAt > input.currentStartedAtMs) {
      fail("runner_loss_reconciliation_history_invalid");
    }
    if (run.id === currentRun.id) {
      if (configuration !== phase.current || currentSeen || !isNonterminalRun(run) ||
        run.created_at !== currentRun.created_at ||
        run.run_started_at !== currentRun.run_started_at) {
        fail("runner_loss_reconciliation_history_invalid");
      }
      currentSeen = true;
      continue;
    }
    if (configuration === phase.current) {
      if (!await priorReadOnlyReconciliationRunExact(
        input,
        run,
        configuration,
      )) fail("runner_loss_reconciliation_history_invalid");
      safePriorReadOnlyRuns.push(Object.freeze({
        run,
        updatedAt: run.updatedAt,
      }));
      continue;
    }
    if (title === phase.allowedSuccessfulPredecessor) {
      if (successfulPredecessor !== null || run.status !== "completed" ||
        run.conclusion !== "success") {
        fail("runner_loss_reconciliation_history_invalid");
      }
      successfulPredecessor = Object.freeze({
        run,
        updatedAt: parseTimestamp(
          run.updated_at,
          "runner_loss_reconciliation_history_invalid",
        ),
      });
      continue;
    }
    const disposition = await priorRunWriteDisposition(input, run, phase.original);
    if (String(run.id) === input.priorRunId) {
      if (selectedOriginal !== null || disposition !== "may-have-written") {
        fail("runner_loss_reconciliation_history_invalid");
      }
      selectedOriginal = Object.freeze({
        run,
        updatedAt: parseTimestamp(
          run.updated_at,
          "runner_loss_reconciliation_history_invalid",
        ),
      });
    } else if (disposition === "skipped") {
      safePriorSkippedWriteRunIds.push(String(run.id));
    } else {
      fail("runner_loss_reconciliation_history_invalid");
    }
  }
  if (!currentSeen || selectedOriginal === null ||
    selectedOriginal.updatedAt >= currentRun.startedAt ||
    selectedOriginal.run.startedAt - input.mergedAtMs >
      MAX_CANDIDATE_AGE_MS ||
    (successfulPredecessor !== null &&
      successfulPredecessor.updatedAt >= selectedOriginal.run.startedAt)) {
    fail("runner_loss_reconciliation_history_invalid");
  }
  for (const skippedRunId of safePriorSkippedWriteRunIds) {
    const skipped = candidateRuns.find((run) => String(run?.id) === skippedRunId);
    if (parseTimestamp(
      skipped?.updated_at,
      "runner_loss_reconciliation_history_invalid",
    ) >= selectedOriginal.run.startedAt) {
      fail("runner_loss_reconciliation_history_invalid");
    }
  }
  safePriorReadOnlyRuns.sort((left, right) =>
    left.run.startedAt - right.run.startedAt);
  if (safePriorReadOnlyRuns.some((item, index) =>
    (index === 0
      ? selectedOriginal.updatedAt >= item.run.startedAt
      : safePriorReadOnlyRuns[index - 1].updatedAt >= item.run.startedAt)) ||
    (safePriorReadOnlyRuns.length > 0 &&
      safePriorReadOnlyRuns.at(-1).updatedAt >= currentRun.startedAt)) {
    fail("runner_loss_reconciliation_history_invalid");
  }
  const common = {
    safePriorSkippedWriteRunIds: safePriorSkippedWriteRunIds.sort(
      (left, right) => Number(left) - Number(right),
    ),
    safePriorReadOnlyRunIds: safePriorReadOnlyRuns.map((item) =>
      String(item.run.id)).sort((left, right) => Number(left) - Number(right)),
    reconciledPriorAmbiguousDisableRunId: null,
    runnerLossRecoveryOriginalRunCompletedAt: new Date(
      selectedOriginal.updatedAt,
    ).toISOString(),
    runnerLossRecoveryGraceHours: RECOVERY_GRACE_HOURS,
    runnerLossRecoveryWithinGraceExact:
      currentRun.startedAt - selectedOriginal.updatedAt <= RECOVERY_GRACE_MS,
  };
  if (!common.runnerLossRecoveryWithinGraceExact) {
    fail("runner_loss_reconciliation_grace_expired");
  }
  return phase.output === "cold-prepare"
    ? Object.freeze({
        ...common,
        priorAmbiguousColdPrepareRunId: input.priorRunId,
        selectedSupabaseReplacementRunId: input.replacementRunId,
        exactPriorColdPrepareCandidateRunBound: true,
        secondColdPrepareWritePreventedExact: true,
      })
    : phase.output === "restore"
    ? Object.freeze({
        ...common,
        priorAmbiguousStagingRestoreRunId: input.priorRunId,
        exactPriorStagingRestoreCandidateRunBound: true,
        secondStagingRestoreScaleWritePreventedExact: true,
      })
    : Object.freeze({
        ...common,
        priorAmbiguousStagingActivateRunId: input.priorRunId,
        exactPriorStagingActivateCandidateRunBound: true,
        secondStagingActivateVariableWritePreventedExact: true,
      });
}

function cutoverConfigurationForTitle(displayTitle, candidateSha) {
  for (const cutoverMode of CUTOVER_MODES) {
    const configuration = operationConfiguration(
      "supabase-legacy-key-cutover",
      candidateSha,
      null,
      null,
      cutoverMode,
    );
    if (configuration.displayTitle === displayTitle) return configuration;
  }
  return null;
}

async function verifyCutoverOperationHistory(input, configuration, currentRun) {
  const history = await listWorkflowHistory({
    ...input,
    workflowId: configuration.workflowId,
  });
  const matching = history.filter((run) => run?.head_sha === input.candidateSha);
  const identifiers = matching.map((run) => run?.id);
  if (
    identifiers.filter((id) => id === currentRun.id).length !== 1 ||
    new Set(identifiers).size !== identifiers.length
  ) fail("history_invalid");

  const safePriorSkippedWriteRunIds = [];
  const safePriorReadOnlyRunIds = [];
  let reconciledPriorAmbiguousDisableRunId = null;
  for (const observed of matching) {
    const observedConfiguration = cutoverConfigurationForTitle(
      observed?.display_title,
      input.candidateSha,
    );
    if (observedConfiguration === null) fail("history_invalid");
    const run = validateRunIdentity(observed, {
      runId: observed?.id,
      candidateSha: input.candidateSha,
      workflowPath: observedConfiguration.workflowPath,
      displayTitle: observedConfiguration.displayTitle,
      failureCode: "history_invalid",
    });
    if (
      run.createdAt < input.mergedAtMs ||
      run.createdAt > input.currentStartedAtMs
    ) fail("history_invalid");
    if (run.id === currentRun.id) {
      if (
        observedConfiguration.cutoverMode !== configuration.cutoverMode ||
        !isNonterminalRun(run) ||
        run.created_at !== currentRun.created_at ||
        run.run_started_at !== currentRun.run_started_at
      ) fail("history_invalid");
      continue;
    }

    if (observedConfiguration.cutoverMode ===
      "reconcile-already-disabled-legacy-keys") {
      if (
        run.status !== "completed" ||
        !["success", "failure", "cancelled", "timed_out"].includes(run.conclusion)
      ) fail("history_invalid");
      safePriorReadOnlyRunIds.push(String(run.id));
      continue;
    }

    const disposition = await priorRunWriteDisposition(
      input,
      run,
      observedConfiguration,
    );
    if (disposition === "skipped") {
      safePriorSkippedWriteRunIds.push(String(run.id));
      continue;
    }
    if (
      disposition !== "may-have-written" ||
      configuration.cutoverMode !== "reconcile-already-disabled-legacy-keys" ||
      reconciledPriorAmbiguousDisableRunId !== null
    ) fail("prior_write_ambiguous");
    reconciledPriorAmbiguousDisableRunId = String(run.id);
  }
  const numericSort = (left, right) => Number(left) - Number(right);
  return Object.freeze({
    safePriorSkippedWriteRunIds: safePriorSkippedWriteRunIds.sort(numericSort),
    safePriorReadOnlyRunIds: safePriorReadOnlyRunIds.sort(numericSort),
    reconciledPriorAmbiguousDisableRunId,
  });
}

async function verifyOffsiteCleanupRecoveryHistory(input, currentRun) {
  const history = await listWorkflowHistory({
    ...input,
    workflowId: PROVIDER_WORKFLOW_ID,
  });
  const cleanupConfiguration = operationConfiguration(
    OFFSITE_CLEANUP_OPERATION,
    input.candidateSha,
    null,
    null,
  );
  const recoveryConfigurations = [...OFFSITE_CLEANUP_RECOVERY_OPERATIONS].map(
    (operation) => operationConfiguration(
      operation,
      input.candidateSha,
      null,
      null,
    ),
  );
  const currentRecoveryConfiguration = operationConfiguration(
    input.operation,
    input.candidateSha,
    null,
    null,
  );
  let priorCleanupRun = null;
  const safePriorRecoverySkippedWriteRunIds = [];
  const ambiguousPriorSameModeRecoveryRuns = [];
  const relevantRunIds = new Set();
  let currentRunSeen = 0;
  for (const observed of history.filter((run) =>
    run?.head_sha === input.candidateSha)) {
    const configuration = observed?.display_title ===
      cleanupConfiguration.displayTitle
      ? cleanupConfiguration
      : recoveryConfigurations.find((candidate) =>
        candidate.displayTitle === observed?.display_title) ?? null;
    if (configuration === null) continue;
    if (relevantRunIds.has(observed?.id)) {
      fail("cleanup_recovery_history_invalid");
    }
    relevantRunIds.add(observed?.id);
    const run = validateRunIdentity(observed, {
      runId: observed?.id,
      candidateSha: input.candidateSha,
      workflowPath: PROVIDER_WORKFLOW_PATH,
      displayTitle: configuration.displayTitle,
      failureCode: "cleanup_recovery_history_invalid",
    });
    if (
      run.createdAt < input.mergedAtMs ||
      run.createdAt > input.currentStartedAtMs
    ) fail("cleanup_recovery_history_invalid");
    if (run.id === currentRun.id) {
      if (configuration.displayTitle !== currentRecoveryConfiguration.displayTitle ||
        !isNonterminalRun(run) ||
        run.created_at !== currentRun.created_at ||
        run.run_started_at !== currentRun.run_started_at) {
        fail("cleanup_recovery_history_invalid");
      }
      currentRunSeen += 1;
      continue;
    }
    const disposition = await priorRunWriteDisposition(input, run, configuration);
    if (configuration === cleanupConfiguration) {
      if (String(run.id) === input.priorRunId) {
        if (priorCleanupRun !== null || disposition !== "may-have-written") {
          fail("cleanup_recovery_history_invalid");
        }
        priorCleanupRun = Object.freeze({
          run,
          updatedAt: parseTimestamp(
            run.updated_at,
            "cleanup_recovery_history_invalid",
          ),
        });
      } else if (disposition !== "skipped") {
        fail("cleanup_recovery_history_invalid");
      }
      continue;
    }
    if (disposition === "skipped") {
      safePriorRecoverySkippedWriteRunIds.push(String(run.id));
      continue;
    }
    const updatedAt = parseTimestamp(
      run.updated_at,
      "cleanup_recovery_history_invalid",
    );
    if (configuration.displayTitle !== currentRecoveryConfiguration.displayTitle
      || disposition !== "may-have-written"
      || updatedAt >= currentRun.startedAt) fail("prior_write_ambiguous");
    ambiguousPriorSameModeRecoveryRuns.push(Object.freeze({ run, updatedAt }));
  }
  ambiguousPriorSameModeRecoveryRuns.sort((left, right) =>
    left.run.startedAt - right.run.startedAt);
  const recoveryChronologyExact = ambiguousPriorSameModeRecoveryRuns.every(
    (item, index) =>
      (index === 0
        ? priorCleanupRun !== null &&
          priorCleanupRun.updatedAt < item.run.startedAt
        : ambiguousPriorSameModeRecoveryRuns[index - 1].updatedAt <
          item.run.startedAt),
  );
  if (
    currentRunSeen !== 1 ||
    priorCleanupRun === null ||
    priorCleanupRun.run.startedAt >= currentRun.startedAt ||
    priorCleanupRun.updatedAt >= currentRun.startedAt ||
    priorCleanupRun.run.startedAt - input.mergedAtMs >
      MAX_CANDIDATE_AGE_MS ||
    currentRun.startedAt - priorCleanupRun.updatedAt > RECOVERY_GRACE_MS ||
    !recoveryChronologyExact ||
    (ambiguousPriorSameModeRecoveryRuns.length > 0 &&
      ambiguousPriorSameModeRecoveryRuns.at(-1).updatedAt >=
        currentRun.startedAt)
  ) fail("cleanup_recovery_history_invalid");
  return Object.freeze({
    priorCleanupRunId: input.priorRunId,
    priorCleanupPatchSha256: OFFSITE_CLEANUP_PATCH_SHA256,
    exactPriorCleanupCandidateRunBound: true,
    safePriorRecoverySkippedWriteRunIds:
      safePriorRecoverySkippedWriteRunIds.sort(
        (left, right) => Number(left) - Number(right),
      ),
    ambiguousPriorSameModeRecoveryRunIds:
      ambiguousPriorSameModeRecoveryRuns.map((item) => String(item.run.id)).sort(
        (left, right) => Number(left) - Number(right),
      ),
    sameModeRecoveryConvergenceExact: true,
    offsiteCleanupRecoveryOriginalRunCompletedAt: new Date(
      priorCleanupRun.updatedAt,
    ).toISOString(),
    offsiteCleanupRecoveryGraceHours: RECOVERY_GRACE_HOURS,
    offsiteCleanupRecoveryWithinGraceExact: true,
  });
}

async function verifyIncidentMaskedCleanupCancelHistory(
  input,
  currentRun,
  policy,
) {
  if (input.priorRunId !== INCIDENT_PRIOR_CLEANUP_RUN_ID) {
    fail("incident_cleanup_cancel_history_invalid");
  }
  const candidateCommit = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/git/commits/${input.candidateSha}`,
  );
  if (
    candidateCommit?.sha !== input.candidateSha ||
    !Array.isArray(candidateCommit?.parents) ||
    candidateCommit.parents.length !== 1 ||
    candidateCommit.parents[0]?.sha !== INCIDENT_ORIGINAL_CANDIDATE_SHA
  ) fail("incident_cleanup_cancel_successor_invalid");

  const originalPull = await verifyReviewedPullRequest(
    input.fetchImpl,
    input.token,
    policy,
    INCIDENT_ORIGINAL_CANDIDATE_SHA,
  );
  if (
    originalPull.number !== INCIDENT_ORIGINAL_PULL_REQUEST_NUMBER ||
    originalPull.reviewedPrHeadSha !== INCIDENT_ORIGINAL_REVIEWED_HEAD_SHA ||
    originalPull.treeSha !== INCIDENT_ORIGINAL_TREE_SHA ||
    originalPull.mergedAt !== INCIDENT_ORIGINAL_MERGED_AT
  ) fail("incident_cleanup_cancel_original_candidate_invalid");

  const originalConfiguration = operationConfiguration(
    OFFSITE_CLEANUP_OPERATION,
    INCIDENT_ORIGINAL_CANDIDATE_SHA,
    null,
    null,
  );
  const priorRun = validateRunIdentity(
    await githubGet(
      input.fetchImpl,
      input.token,
      REPOSITORY,
      `/actions/runs/${INCIDENT_PRIOR_CLEANUP_RUN_ID}`,
    ),
    {
      runId: Number(INCIDENT_PRIOR_CLEANUP_RUN_ID),
      candidateSha: INCIDENT_ORIGINAL_CANDIDATE_SHA,
      workflowPath: PROVIDER_WORKFLOW_PATH,
      displayTitle: originalConfiguration.displayTitle,
      failureCode: "incident_cleanup_cancel_original_run_invalid",
    },
  );
  if (
    priorRun.created_at !== INCIDENT_PRIOR_CLEANUP_RUN_CREATED_AT ||
    priorRun.run_started_at !== INCIDENT_PRIOR_CLEANUP_RUN_CREATED_AT ||
    priorRun.updated_at !== INCIDENT_PRIOR_CLEANUP_RUN_COMPLETED_AT ||
    priorRun.status !== "completed" ||
    priorRun.conclusion !== "failure" ||
    await priorRunWriteDisposition(input, priorRun, originalConfiguration) !==
      "may-have-written"
  ) fail("incident_cleanup_cancel_original_run_invalid");

  const artifactListing = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/actions/runs/${INCIDENT_PRIOR_CLEANUP_RUN_ID}/artifacts?per_page=100&page=1`,
  );
  const artifact = Array.isArray(artifactListing?.artifacts)
    && artifactListing.artifacts.length === 1
    ? artifactListing.artifacts[0]
    : null;
  const artifactCreatedAt = parseTimestamp(
    artifact?.created_at,
    "incident_cleanup_cancel_artifact_invalid",
  );
  const artifactUpdatedAt = parseTimestamp(
    artifact?.updated_at,
    "incident_cleanup_cancel_artifact_invalid",
  );
  const artifactExpiresAt = parseTimestamp(
    artifact?.expires_at,
    "incident_cleanup_cancel_artifact_invalid",
  );
  if (
    artifactListing?.total_count !== 1 ||
    artifact?.id !== INCIDENT_PRIOR_CLEANUP_ARTIFACT_ID ||
    artifact?.name !== INCIDENT_PRIOR_CLEANUP_ARTIFACT_NAME ||
    artifact?.size_in_bytes !== INCIDENT_PRIOR_CLEANUP_ARTIFACT_BYTES ||
    artifact?.expired !== false ||
    artifact?.digest !== INCIDENT_PRIOR_CLEANUP_ARTIFACT_DIGEST ||
    artifact?.created_at !== INCIDENT_PRIOR_CLEANUP_ARTIFACT_CREATED_AT ||
    artifact?.updated_at !== INCIDENT_PRIOR_CLEANUP_ARTIFACT_CREATED_AT ||
    artifact?.workflow_run?.id !== Number(INCIDENT_PRIOR_CLEANUP_RUN_ID) ||
    artifact?.workflow_run?.head_branch !== "main" ||
    artifact?.workflow_run?.head_sha !== INCIDENT_ORIGINAL_CANDIDATE_SHA ||
    artifactCreatedAt > artifactUpdatedAt ||
    artifactUpdatedAt > priorRun.updatedAt ||
    artifactExpiresAt <= currentRun.startedAt
  ) fail("incident_cleanup_cancel_artifact_invalid");

  if (
    originalPull.mergedAt !== INCIDENT_ORIGINAL_MERGED_AT ||
    parseTimestamp(originalPull.mergedAt, "incident_cleanup_cancel_history_invalid") >
      priorRun.startedAt ||
    priorRun.updatedAt > input.mergedAtMs ||
    input.mergedAtMs > currentRun.startedAt ||
    currentRun.startedAt - priorRun.updatedAt >= RECOVERY_GRACE_MS
  ) fail("incident_cleanup_cancel_history_invalid");

  const incidentConfiguration = operationConfiguration(
    INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION,
    input.candidateSha,
    null,
    null,
  );
  const history = await listWorkflowHistory({
    ...input,
    workflowId: PROVIDER_WORKFLOW_ID,
  });
  const matching = history.filter((run) =>
    run?.head_sha === input.candidateSha);
  if (matching.some((run) =>
    run?.display_title !== incidentConfiguration.displayTitle) ||
    new Set(matching.map((run) => run?.id)).size !== matching.length) {
    fail("incident_cleanup_cancel_history_invalid");
  }
  let currentSeen = 0;
  const safePriorSkippedWriteRunIds = [];
  const ambiguousPriorRuns = [];
  const orderedPriorRuns = [];
  const absoluteDeadlineMs = priorRun.updatedAt + RECOVERY_GRACE_MS;
  for (const observed of matching) {
    const run = validateRunIdentity(observed, {
      runId: observed?.id,
      candidateSha: input.candidateSha,
      workflowPath: PROVIDER_WORKFLOW_PATH,
      displayTitle: incidentConfiguration.displayTitle,
      failureCode: "incident_cleanup_cancel_history_invalid",
    });
    if (run.createdAt < input.mergedAtMs ||
      run.createdAt > currentRun.startedAt ||
      run.startedAt >= absoluteDeadlineMs) {
      fail("incident_cleanup_cancel_history_invalid");
    }
    if (run.id === currentRun.id) {
      if (!isNonterminalRun(run) ||
        run.created_at !== currentRun.created_at ||
        run.run_started_at !== currentRun.run_started_at) {
        fail("incident_cleanup_cancel_history_invalid");
      }
      currentSeen += 1;
      continue;
    }
    const disposition = await priorRunWriteDisposition(
      input,
      run,
      incidentConfiguration,
    );
    const updatedAt = parseTimestamp(
      run.updated_at,
      "incident_cleanup_cancel_history_invalid",
    );
    if (updatedAt >= absoluteDeadlineMs || updatedAt >= currentRun.startedAt) {
      fail("incident_cleanup_cancel_history_invalid");
    }
    if (disposition === "skipped") {
      safePriorSkippedWriteRunIds.push(String(run.id));
    } else if (disposition === "may-have-written") {
      ambiguousPriorRuns.push(Object.freeze({ run, updatedAt }));
    } else {
      fail("incident_cleanup_cancel_history_invalid");
    }
    orderedPriorRuns.push(Object.freeze({ run, updatedAt }));
  }
  orderedPriorRuns.sort((left, right) =>
    left.run.startedAt - right.run.startedAt);
  if (currentSeen !== 1 || orderedPriorRuns.some((item, index) =>
    index > 0 && orderedPriorRuns[index - 1].updatedAt >= item.run.startedAt) ||
    (orderedPriorRuns.length > 0 &&
      orderedPriorRuns.at(-1).updatedAt >= currentRun.startedAt)) {
    fail("incident_cleanup_cancel_history_invalid");
  }

  return Object.freeze({
    incidentOriginalCandidateSha: INCIDENT_ORIGINAL_CANDIDATE_SHA,
    incidentOriginalReviewedPrHeadSha: INCIDENT_ORIGINAL_REVIEWED_HEAD_SHA,
    incidentOriginalPullRequestNumber: INCIDENT_ORIGINAL_PULL_REQUEST_NUMBER,
    incidentOriginalPullRequestMergedAt: INCIDENT_ORIGINAL_MERGED_AT,
    incidentSuccessorDirectParentExact: true,
    incidentPriorCleanupRunId: INCIDENT_PRIOR_CLEANUP_RUN_ID,
    incidentPriorCleanupRunCreatedAt: INCIDENT_PRIOR_CLEANUP_RUN_CREATED_AT,
    incidentPriorCleanupRunCompletedAt: INCIDENT_PRIOR_CLEANUP_RUN_COMPLETED_AT,
    incidentPriorCleanupArtifactId: String(INCIDENT_PRIOR_CLEANUP_ARTIFACT_ID),
    incidentPriorCleanupArtifactName: INCIDENT_PRIOR_CLEANUP_ARTIFACT_NAME,
    incidentPriorCleanupArtifactDigest: INCIDENT_PRIOR_CLEANUP_ARTIFACT_DIGEST,
    incidentPriorCleanupArtifactExact: true,
    incidentStagedPatchId: INCIDENT_STAGED_PATCH_ID,
    incidentStagedPatchCreatedAt: INCIDENT_STAGED_PATCH_CREATED_AT,
    incidentMaskedPatchStructure:
      "exact-three-offsite-variable-wrappers-with-five-asterisk-values",
    incidentOriginalBaselineMetadataSha256:
      INCIDENT_ORIGINAL_BASELINE_METADATA_SHA256,
    incidentCancellationOnlyExact: true,
    incidentRecoveryGraceHours: RECOVERY_GRACE_HOURS,
    incidentRecoveryWithinGraceExact: true,
    incidentSafePriorSkippedWriteRunIds:
      safePriorSkippedWriteRunIds.sort(
        (left, right) => Number(left) - Number(right),
      ),
    incidentAmbiguousPriorCancelRunIds: ambiguousPriorRuns.map((item) =>
      String(item.run.id)).sort(
      (left, right) => Number(left) - Number(right),
    ),
    incidentPriorRunsStrictlyOrderedAndNonOverlappingExact: true,
    incidentSameCandidateConvergenceExact: true,
    incidentAbsoluteRecoveryDeadline: new Date(absoluteDeadlineMs).toISOString(),
  });
}

async function verifyCleanupSuccessorCloseoutHistory(
  input,
  currentRun,
  policy,
) {
  if (input.priorRunId !== String(CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID)) {
    fail("cleanup_successor_closeout_history_invalid");
  }
  const candidateCommit = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/git/commits/${input.candidateSha}`,
  );
  if (
    candidateCommit?.sha !== input.candidateSha ||
    !Array.isArray(candidateCommit?.parents) ||
    candidateCommit.parents.length !== 1 ||
    candidateCommit.parents[0]?.sha !== CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA
  ) fail("cleanup_successor_closeout_candidate_invalid");

  const originalPull = await verifyReviewedPullRequest(
    input.fetchImpl,
    input.token,
    policy,
    CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA,
  );
  if (
    originalPull.number !== CLEANUP_CLOSEOUT_ORIGINAL_PULL_REQUEST_NUMBER ||
    originalPull.reviewedPrHeadSha !==
      CLEANUP_CLOSEOUT_ORIGINAL_REVIEWED_HEAD_SHA ||
    originalPull.treeSha !== CLEANUP_CLOSEOUT_ORIGINAL_TREE_SHA ||
    originalPull.mergedAt !== CLEANUP_CLOSEOUT_ORIGINAL_MERGED_AT ||
    originalPull.reviewedTreeExact !== true
  ) fail("cleanup_successor_closeout_original_candidate_invalid");

  const originalConfiguration = operationConfiguration(
    OFFSITE_CLEANUP_OPERATION,
    CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA,
    null,
    null,
  );
  const failedRecoveryConfiguration = operationConfiguration(
    "resume-forbidden-offsite-backup-deletion-patch",
    CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA,
    null,
    null,
  );
  const originalRun = validateRunIdentity(
    await githubGet(
      input.fetchImpl,
      input.token,
      REPOSITORY,
      `/actions/runs/${CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID}`,
    ),
    {
      runId: CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID,
      candidateSha: CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA,
      workflowPath: PROVIDER_WORKFLOW_PATH,
      displayTitle: originalConfiguration.displayTitle,
      failureCode: "cleanup_successor_closeout_original_run_invalid",
    },
  );
  const failedRecoveryRun = validateRunIdentity(
    await githubGet(
      input.fetchImpl,
      input.token,
      REPOSITORY,
      `/actions/runs/${CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID}`,
    ),
    {
      runId: CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID,
      candidateSha: CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA,
      workflowPath: PROVIDER_WORKFLOW_PATH,
      displayTitle: failedRecoveryConfiguration.displayTitle,
      failureCode: "cleanup_successor_closeout_failed_recovery_run_invalid",
    },
  );
  if (
    originalRun.created_at !== CLEANUP_CLOSEOUT_ORIGINAL_RUN_CREATED_AT ||
    originalRun.run_started_at !== CLEANUP_CLOSEOUT_ORIGINAL_RUN_CREATED_AT ||
    originalRun.updated_at !== CLEANUP_CLOSEOUT_ORIGINAL_RUN_COMPLETED_AT ||
    originalRun.status !== "completed" ||
    originalRun.conclusion !== "failure" ||
    await priorRunWriteDisposition(input, originalRun, originalConfiguration) !==
      "may-have-written" ||
    failedRecoveryRun.created_at !==
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_CREATED_AT ||
    failedRecoveryRun.run_started_at !==
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_CREATED_AT ||
    failedRecoveryRun.updated_at !==
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_COMPLETED_AT ||
    failedRecoveryRun.status !== "completed" ||
    failedRecoveryRun.conclusion !== "failure" ||
    await priorRunWriteDisposition(
      input,
      failedRecoveryRun,
      failedRecoveryConfiguration,
    ) !== "may-have-written"
  ) fail("cleanup_successor_closeout_predecessor_runs_invalid");

  const exactArtifact = async (runId, expected) => {
    const listing = await githubGet(
      input.fetchImpl,
      input.token,
      REPOSITORY,
      `/actions/runs/${runId}/artifacts?per_page=100&page=1`,
    );
    const artifact = Array.isArray(listing?.artifacts) &&
      listing.artifacts.length === 1
      ? listing.artifacts[0]
      : null;
    const createdAt = parseTimestamp(
      artifact?.created_at,
      "cleanup_successor_closeout_artifact_invalid",
    );
    const updatedAt = parseTimestamp(
      artifact?.updated_at,
      "cleanup_successor_closeout_artifact_invalid",
    );
    const expiresAt = parseTimestamp(
      artifact?.expires_at,
      "cleanup_successor_closeout_artifact_invalid",
    );
    if (
      listing?.total_count !== 1 ||
      artifact?.id !== expected.id ||
      artifact?.name !== expected.name ||
      artifact?.size_in_bytes !== expected.bytes ||
      artifact?.expired !== false ||
      artifact?.digest !== expected.digest ||
      artifact?.created_at !== expected.createdAt ||
      artifact?.updated_at !== expected.createdAt ||
      artifact?.workflow_run?.id !== runId ||
      artifact?.workflow_run?.head_branch !== "main" ||
      artifact?.workflow_run?.head_sha !==
        CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA ||
      createdAt !== updatedAt ||
      expiresAt <= currentRun.startedAt
    ) fail("cleanup_successor_closeout_artifact_invalid");
  };
  await exactArtifact(CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID, {
    id: CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_ID,
    name: CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_NAME,
    digest: CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_DIGEST,
    bytes: CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_BYTES,
    createdAt: CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_CREATED_AT,
  });
  await exactArtifact(CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID, {
    id: CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_ID,
    name: CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_NAME,
    digest: CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_DIGEST,
    bytes: CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_BYTES,
    createdAt: CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_CREATED_AT,
  });

  const history = await listWorkflowHistory({
    ...input,
    workflowId: PROVIDER_WORKFLOW_ID,
    mergedAt: CLEANUP_CLOSEOUT_ORIGINAL_MERGED_AT,
  });
  if (
    history.length !== 3 ||
    new Set(history.map((run) => run?.id)).size !== history.length
  ) fail("cleanup_successor_closeout_history_invalid");
  const originalCandidateRuns = history.filter((run) =>
    run?.head_sha === CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA);
  if (
    originalCandidateRuns.length !== 2 ||
    JSON.stringify(originalCandidateRuns.map((run) => run?.id).sort(
      (left, right) => left - right,
    )) !== JSON.stringify([
      CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID,
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID,
    ])
  ) fail("cleanup_successor_closeout_original_history_invalid");
  const listedOriginalRun = validateRunIdentity(
    originalCandidateRuns.find((run) =>
      run?.id === CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID),
    {
      runId: CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID,
      candidateSha: CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA,
      workflowPath: PROVIDER_WORKFLOW_PATH,
      displayTitle: originalConfiguration.displayTitle,
      failureCode: "cleanup_successor_closeout_original_history_invalid",
    },
  );
  const listedFailedRecoveryRun = validateRunIdentity(
    originalCandidateRuns.find((run) =>
      run?.id === CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID),
    {
      runId: CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID,
      candidateSha: CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA,
      workflowPath: PROVIDER_WORKFLOW_PATH,
      displayTitle: failedRecoveryConfiguration.displayTitle,
      failureCode: "cleanup_successor_closeout_original_history_invalid",
    },
  );
  if (
    listedOriginalRun.created_at !== originalRun.created_at ||
    listedOriginalRun.run_started_at !== originalRun.run_started_at ||
    listedOriginalRun.updated_at !== originalRun.updated_at ||
    listedOriginalRun.status !== originalRun.status ||
    listedOriginalRun.conclusion !== originalRun.conclusion ||
    listedFailedRecoveryRun.created_at !== failedRecoveryRun.created_at ||
    listedFailedRecoveryRun.run_started_at !== failedRecoveryRun.run_started_at ||
    listedFailedRecoveryRun.updated_at !== failedRecoveryRun.updated_at ||
    listedFailedRecoveryRun.status !== failedRecoveryRun.status ||
    listedFailedRecoveryRun.conclusion !== failedRecoveryRun.conclusion
  ) fail("cleanup_successor_closeout_original_history_invalid");
  const successorRuns = history.filter((run) =>
    run?.head_sha === input.candidateSha);
  if (
    successorRuns.length !== 1 ||
    successorRuns[0]?.id !== currentRun.id ||
    successorRuns[0]?.display_title !== operationConfiguration(
      OFFSITE_CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION,
      input.candidateSha,
      null,
      null,
    ).displayTitle
  ) fail("cleanup_successor_closeout_current_history_invalid");
  const listedCurrentRun = validateRunIdentity(successorRuns[0], {
    runId: currentRun.id,
    candidateSha: input.candidateSha,
    workflowPath: PROVIDER_WORKFLOW_PATH,
    displayTitle: operationConfiguration(
      OFFSITE_CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION,
      input.candidateSha,
      null,
      null,
    ).displayTitle,
    failureCode: "cleanup_successor_closeout_current_history_invalid",
  });
  if (
    !isNonterminalRun(listedCurrentRun) ||
    listedCurrentRun.created_at !== currentRun.created_at ||
    listedCurrentRun.run_started_at !== currentRun.run_started_at
  ) fail("cleanup_successor_closeout_current_history_invalid");

  const absoluteDeadlineMs = originalRun.updatedAt + RECOVERY_GRACE_MS;
  if (
    parseTimestamp(CLEANUP_CLOSEOUT_ORIGINAL_MERGED_AT,
      "cleanup_successor_closeout_history_invalid") > originalRun.startedAt ||
    originalRun.updatedAt >= failedRecoveryRun.startedAt ||
    failedRecoveryRun.updatedAt > input.mergedAtMs ||
    input.mergedAtMs > currentRun.startedAt ||
    currentRun.startedAt - originalRun.updatedAt <
      CLEANUP_CLOSEOUT_MINIMUM_OBSERVATION_MS ||
    currentRun.startedAt >= absoluteDeadlineMs
  ) fail("cleanup_successor_closeout_history_invalid");

  return Object.freeze({
    cleanupCloseoutOriginalCandidateSha:
      CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA,
    cleanupCloseoutOriginalReviewedPrHeadSha:
      CLEANUP_CLOSEOUT_ORIGINAL_REVIEWED_HEAD_SHA,
    cleanupCloseoutOriginalTreeSha: CLEANUP_CLOSEOUT_ORIGINAL_TREE_SHA,
    cleanupCloseoutOriginalPullRequestNumber:
      CLEANUP_CLOSEOUT_ORIGINAL_PULL_REQUEST_NUMBER,
    cleanupCloseoutOriginalPullRequestMergedAt:
      CLEANUP_CLOSEOUT_ORIGINAL_MERGED_AT,
    cleanupCloseoutSuccessorDirectParentExact: true,
    cleanupCloseoutOriginalRunId: String(CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID),
    cleanupCloseoutOriginalRunCreatedAt:
      CLEANUP_CLOSEOUT_ORIGINAL_RUN_CREATED_AT,
    cleanupCloseoutOriginalRunCompletedAt:
      CLEANUP_CLOSEOUT_ORIGINAL_RUN_COMPLETED_AT,
    cleanupCloseoutOriginalRunMayHaveWrittenExact: true,
    cleanupCloseoutOriginalArtifactId:
      String(CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_ID),
    cleanupCloseoutOriginalArtifactName:
      CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_NAME,
    cleanupCloseoutOriginalArtifactDigest:
      CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_DIGEST,
    cleanupCloseoutOriginalArtifactExact: true,
    cleanupCloseoutFailedRecoveryRunId:
      String(CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID),
    cleanupCloseoutFailedRecoveryRunCreatedAt:
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_CREATED_AT,
    cleanupCloseoutFailedRecoveryRunCompletedAt:
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_COMPLETED_AT,
    cleanupCloseoutFailedRecoveryArtifactId:
      String(CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_ID),
    cleanupCloseoutFailedRecoveryArtifactName:
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_NAME,
    cleanupCloseoutFailedRecoveryArtifactDigest:
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_DIGEST,
    cleanupCloseoutFailedRecoveryDispatchOnlyArtifactExact: true,
    cleanupCloseoutOriginalHistoryExact: true,
    cleanupCloseoutCurrentHistoryExact: true,
    cleanupCloseoutRecoveryGraceHours: RECOVERY_GRACE_HOURS,
    cleanupCloseoutWithinGraceExact: true,
    cleanupCloseoutMinimumObservationMinutes:
      CLEANUP_CLOSEOUT_MINIMUM_OBSERVATION_MS / 60_000,
    cleanupCloseoutMinimumObservationSatisfiedExact: true,
    cleanupCloseoutAbsoluteDeadline: new Date(absoluteDeadlineMs).toISOString(),
    cleanupCloseoutMetadataOnlyExact: true,
  });
}

async function verifySelectedReplacementHistory(input) {
  const configuration = operationConfiguration(
    "supabase-key-replacement",
    input.candidateSha,
    null,
    null,
  );
  const history = await listWorkflowHistory({
    ...input,
    workflowId: configuration.workflowId,
  });
  const matching = history.filter((run) =>
    run?.head_sha === input.candidateSha &&
    run?.display_title === configuration.displayTitle);
  if (
    matching.length === 0 ||
    new Set(matching.map((run) => run?.id)).size !== matching.length
  ) fail("replacement_history_invalid");
  const safePriorRunIds = [];
  let selected = null;
  for (const observed of matching) {
    const run = validateRunIdentity(observed, {
      runId: observed?.id,
      candidateSha: input.candidateSha,
      workflowPath: configuration.workflowPath,
      displayTitle: configuration.displayTitle,
      failureCode: "replacement_history_invalid",
    });
    if (
      run.createdAt < input.mergedAtMs ||
      run.createdAt > input.currentStartedAtMs
    ) fail("replacement_history_invalid");
    if (String(run.id) === input.replacementRunId) {
      if (selected !== null || run.status !== "completed" || run.conclusion !== "success") {
        fail("replacement_history_invalid");
      }
      selected = run;
      continue;
    }
    if (!await priorRunSkippedWrite(input, run, configuration)) {
      fail("replacement_history_invalid");
    }
    safePriorRunIds.push(String(run.id));
  }
  if (selected === null) fail("replacement_history_invalid");
  return Object.freeze({
    selectedReplacementRunId: input.replacementRunId,
    selectedReplacementRunStartedAt:
      new Date(selected.startedAt).toISOString(),
    selectedReplacementRunCompletedAt:
      new Date(selected.updatedAt).toISOString(),
    safeSkippedReplacementRunIds: safePriorRunIds.sort(
      (left, right) => Number(left) - Number(right),
    ),
  });
}

function validateDeploymentRun(value, input) {
  const createdAt = parseTimestamp(value?.created_at, "deployment_run_invalid");
  const startedAt = parseTimestamp(value?.run_started_at, "deployment_run_invalid");
  const updatedAt = parseTimestamp(value?.updated_at, "deployment_run_invalid");
  if (
    String(value?.id) !== input.deploymentRunId ||
    value?.repository?.full_name !== REPOSITORY ||
    value?.head_repository?.full_name !== REPOSITORY ||
    value?.head_sha !== input.candidateSha ||
    value?.head_branch !== "main" ||
    !workflowPathExact(value?.path, DEPLOYMENT_WORKFLOW_PATH) ||
    value?.event !== "workflow_dispatch" ||
    value?.run_attempt !== 1 ||
    value?.status !== "completed" ||
    value?.conclusion !== "success" ||
    createdAt > startedAt ||
    startedAt >= updatedAt ||
    updatedAt >= input.currentStartedAtMs
  ) fail("deployment_run_invalid");
  return Object.freeze({
    startedAt,
    updatedAt,
    updatedAtSource: value.updated_at,
  });
}

function providerConfigurationForTitle(displayTitle, candidateSha) {
  for (const operation of PROVIDER_OPERATIONS) {
    const configuration = operationConfiguration(operation, candidateSha, null, null);
    if (configuration.displayTitle === displayTitle) return configuration;
  }
  return null;
}

function runtimeConfigurationForTitle(displayTitle, candidateSha) {
  for (const target of RUNTIME_VARIABLE_TARGETS) {
    for (const variableName of RUNTIME_VARIABLE_NAMES) {
      if (!runtimeVariableCombinationExact(target, variableName)) continue;
      const configuration = operationConfiguration(
        "runtime-variable",
        candidateSha,
        target,
        variableName,
      );
      if (configuration.displayTitle === displayTitle) {
        return Object.freeze({ configuration, target });
      }
    }
  }
  return null;
}

function validateCompletedHistoricalRun(observed, configuration, input) {
  const run = validateRunIdentity(observed, {
    runId: observed?.id,
    candidateSha: input.candidateSha,
    workflowPath: configuration.workflowPath,
    displayTitle: configuration.displayTitle,
    failureCode: "stale_deployment_history_invalid",
  });
  const updatedAt = parseTimestamp(run.updated_at, "stale_deployment_history_invalid");
  if (
    run.status !== "completed" ||
    typeof run.conclusion !== "string" ||
    run.createdAt < input.mergedAtMs ||
    run.createdAt > input.currentStartedAtMs ||
    updatedAt < run.startedAt
  ) fail("stale_deployment_history_invalid");
  return updatedAt;
}

async function verifyNoPostDeploymentStagingWrites(input, deployment) {
  const providerHistory = await listWorkflowHistory({
    ...input,
    workflowId: PROVIDER_WORKFLOW_ID,
  });
  for (const observed of providerHistory.filter((run) =>
    run?.head_sha === input.candidateSha)) {
    const configuration = providerConfigurationForTitle(
      observed?.display_title,
      input.candidateSha,
    );
    if (configuration === null) fail("stale_deployment_history_invalid");
    const updatedAt = validateCompletedHistoricalRun(
      observed,
      configuration,
      input,
    );
    if (updatedAt >= deployment.startedAt) fail("stale_deployment");
  }

  const runtimeHistory = await listWorkflowHistory({
    ...input,
    workflowId: RUNTIME_VARIABLE_WORKFLOW_ID,
  });
  for (const observed of runtimeHistory.filter((run) =>
    run?.head_sha === input.candidateSha)) {
    const classified = runtimeConfigurationForTitle(
      observed?.display_title,
      input.candidateSha,
    );
    if (classified === null) fail("stale_deployment_history_invalid");
    if (classified.target === "production") continue;
    validateRunIdentity(observed, {
      runId: observed?.id,
      candidateSha: input.candidateSha,
      workflowPath: classified.configuration.workflowPath,
      displayTitle: classified.configuration.displayTitle,
      failureCode: "stale_deployment_history_invalid",
    });
    const updatedAt = validateCompletedHistoricalRun(
      observed,
      classified.configuration,
      input,
    );
    if (updatedAt >= deployment.startedAt) {
      fail("stale_deployment");
    }
  }
  return Object.freeze({
    deploymentWorkflowRunId: input.deploymentRunId,
    deploymentWorkflowRunUpdatedAt: deployment.updatedAtSource,
    noPostDeploymentStagingWritesExact: true,
  });
}

async function verifyStagingLifecycleNotSealed(input) {
  const history = await listWorkflowHistory({
    ...input,
    workflowId: DEPLOYMENT_WORKFLOW_ID,
  });
  const successfulRunIds = [];
  for (const observed of history.filter((run) =>
    run?.head_sha === input.candidateSha)) {
    const createdAt = parseTimestamp(
      observed?.created_at,
      "deployment_history_invalid",
    );
    const startedAt = parseTimestamp(
      observed?.run_started_at,
      "deployment_history_invalid",
    );
    const updatedAt = parseTimestamp(
      observed?.updated_at,
      "deployment_history_invalid",
    );
    if (
      !Number.isSafeInteger(observed?.id) ||
      observed.id <= 0 ||
      observed?.repository?.full_name !== REPOSITORY ||
      observed?.head_repository?.full_name !== REPOSITORY ||
      observed?.head_branch !== "main" ||
      !workflowPathExact(observed?.path, DEPLOYMENT_WORKFLOW_PATH) ||
      observed?.event !== "workflow_dispatch" ||
      observed?.run_attempt !== 1 ||
      observed?.status !== "completed" ||
      typeof observed?.conclusion !== "string" ||
      createdAt < input.mergedAtMs ||
      createdAt > input.currentStartedAtMs ||
      createdAt > startedAt ||
      startedAt >= updatedAt
    ) fail("deployment_history_invalid");
    if (observed.conclusion === "success") {
      successfulRunIds.push(String(observed.id));
    }
  }
  if (new Set(successfulRunIds).size !== successfulRunIds.length) {
    fail("deployment_history_invalid");
  }
  if (successfulRunIds.length >= 2) fail("staging_lifecycle_sealed");
  return successfulRunIds.sort((left, right) => Number(left) - Number(right));
}

async function verifyCutoverDeploymentSequence(input, selectedDeployment) {
  const history = await listWorkflowHistory({
    ...input,
    workflowId: DEPLOYMENT_WORKFLOW_ID,
  });
  const successful = [];
  for (const observed of history.filter((run) =>
    run?.head_sha === input.candidateSha)) {
    const createdAt = parseTimestamp(
      observed?.created_at,
      "deployment_history_invalid",
    );
    const startedAt = parseTimestamp(
      observed?.run_started_at,
      "deployment_history_invalid",
    );
    const updatedAt = parseTimestamp(
      observed?.updated_at,
      "deployment_history_invalid",
    );
    if (
      !Number.isSafeInteger(observed?.id) ||
      observed.id <= 0 ||
      observed?.repository?.full_name !== REPOSITORY ||
      observed?.head_repository?.full_name !== REPOSITORY ||
      observed?.head_branch !== "main" ||
      !workflowPathExact(observed?.path, DEPLOYMENT_WORKFLOW_PATH) ||
      observed?.event !== "workflow_dispatch" ||
      observed?.run_attempt !== 1 ||
      observed?.status !== "completed" ||
      typeof observed?.conclusion !== "string" ||
      createdAt < input.mergedAtMs ||
      createdAt > input.currentStartedAtMs ||
      createdAt > startedAt ||
      startedAt >= updatedAt
    ) fail("deployment_history_invalid");
    if (observed.conclusion === "success") {
      successful.push(Object.freeze({
        id: String(observed.id),
        startedAt,
        updatedAt,
      }));
    }
  }
  if (
    successful.length !== 2 ||
    new Set(successful.map((run) => run.id)).size !== successful.length
  ) fail("cutover_deployment_sequence_invalid");
  successful.sort((left, right) => left.updatedAt - right.updatedAt);
  if (
    successful[0].updatedAt >= successful[1].startedAt ||
    successful[1].id !== input.deploymentRunId ||
    successful[1].startedAt !== selectedDeployment.startedAt ||
    successful[1].updatedAt !== selectedDeployment.updatedAt
  ) fail("cutover_deployment_sequence_invalid");
  return Object.freeze({
    stagingDeploymentRunIds: successful.map((run) => run.id),
    closeoutDeploymentRunId: input.deploymentRunId,
    stagingDeploymentSequenceExact: true,
  });
}

export async function verifyGithubReviewedCandidateAuthority(input) {
  const policySource = fs.readFileSync(POLICY_PATH, "utf8");
  const policy = parseGithubReleaseChecksPolicy(policySource);
  const token = input.env.GITHUB_TOKEN ?? "";
  const currentRunIdSource = input.env.GITHUB_RUN_ID ?? "";
  const productionPostgresSourceRepinReconcile =
    input.operation === PRODUCTION_POSTGRES_SOURCE_REPIN_RECONCILE_OPERATION;
  const coldQuiesceSuccessor =
    input.operation === COLD_QUIESCE_SUCCESSOR_OPERATION;
  if (
    !policy ||
    policy.repository !== REPOSITORY ||
    input.env.GITHUB_ACTIONS !== "true" ||
    input.env.GITHUB_REF !== "refs/heads/main" ||
    input.env.GITHUB_SHA !== input.candidateSha ||
    input.env.GITHUB_REPOSITORY !== REPOSITORY ||
    input.env.GITHUB_RUN_ATTEMPT !== "1" ||
    !RUN_ID.test(currentRunIdSource) ||
    token.length < 16 ||
    /[\r\n\0]/.test(token) ||
    (productionPostgresSourceRepinReconcile || coldQuiesceSuccessor
      ? !SHA.test(input.priorCandidateSha ?? "")
      : input.priorCandidateSha != null)
  ) fail("environment_invalid");
  const currentRunId = Number(currentRunIdSource);
  if (!Number.isSafeInteger(currentRunId)) fail("environment_invalid");
  const configuration = operationConfiguration(
    input.operation,
    input.candidateSha,
    input.target,
    input.variableName,
    input.cutoverMode,
  );
  const pull = await verifyReviewedPullRequest(
    input.fetchImpl,
    token,
    policy,
    input.candidateSha,
  );
  const currentRun = validateRunIdentity(
    await githubGet(
      input.fetchImpl,
      token,
      REPOSITORY,
      `/actions/runs/${currentRunId}`,
    ),
    {
      runId: currentRunId,
      candidateSha: input.candidateSha,
      workflowPath: configuration.workflowPath,
      displayTitle: configuration.displayTitle,
      failureCode: "current_run_invalid",
    },
  );
  if (!isNonterminalRun(currentRun)) {
    fail("current_run_invalid");
  }
  const mergedAtMs = parseTimestamp(pull.mergedAt, "reviewed_pull_request_invalid");
  if (
    currentRun.createdAt < mergedAtMs ||
    (!RUNNER_LOSS_RECOVERY_OPERATIONS.has(input.operation) &&
      input.operation !==
        PRODUCTION_POSTGRES_SOURCE_REPIN_RECONCILE_OPERATION &&
      !OFFSITE_CLEANUP_RECOVERY_OPERATIONS.has(input.operation) &&
      currentRun.startedAt - mergedAtMs > MAX_CANDIDATE_AGE_MS)
  ) fail("candidate_history_expired");
  const productionPostgresSourceRepinRecoveryCandidateAuthority =
    productionPostgresSourceRepinReconcile
      ? await verifyProductionPostgresSourceRepinRecoveryCandidates(
        {
          fetchImpl: input.fetchImpl,
          token,
          candidateSha: input.candidateSha,
          priorCandidateSha: input.priorCandidateSha,
        },
        policy,
        pull,
        mergedAtMs,
      )
      : null;
  const historyInput = {
    fetchImpl: input.fetchImpl,
    token,
    candidateSha: input.candidateSha,
    currentStartedAt: currentRun.run_started_at,
    currentStartedAtMs: currentRun.startedAt,
    mergedAt: pull.mergedAt,
    mergedAtMs,
  };
  const coldQuiesceSuccessorBridge = coldQuiesceSuccessor
    ? await verifyColdQuiesceSuccessorBridge(
      {
        ...historyInput,
        priorCandidateSha: input.priorCandidateSha,
        priorRunId: input.priorRunId,
        failedPrewriteCandidateSha: input.failedPrewriteCandidateSha,
        failedPrewriteRunId: input.failedPrewriteRunId,
        prepareRunId: input.prepareRunId,
        currentMergedAtMs: mergedAtMs,
      },
      policy,
      pull,
      currentRun,
    )
    : null;
  const incidentCleanupCancelHistory =
    input.operation === INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION
      ? await verifyIncidentMaskedCleanupCancelHistory(
        {
          ...historyInput,
          priorRunId: input.priorRunId,
        },
        currentRun,
        policy,
      )
      : null;
  const cleanupSuccessorCloseoutHistory =
    input.operation === OFFSITE_CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION
      ? await verifyCleanupSuccessorCloseoutHistory(
        {
          ...historyInput,
          priorRunId: input.priorRunId,
        },
        currentRun,
        policy,
      )
      : null;
  const operationHistory = input.operation === "supabase-legacy-key-cutover"
    ? await verifyCutoverOperationHistory(historyInput, configuration, currentRun)
    : input.operation === PRODUCTION_POSTGRES_SOURCE_REPIN_OPERATION
    ? await verifyProductionPostgresSourceRepinApplyHistory(
      historyInput,
      currentRun,
    )
    : input.operation === PRODUCTION_POSTGRES_SOURCE_REPIN_RECONCILE_OPERATION
    ? await verifyProductionPostgresSourceRepinReconciliationHistory({
      ...historyInput,
      priorRunId: input.priorRunId,
      priorCandidateSha: input.priorCandidateSha,
      historyStartAt:
        productionPostgresSourceRepinRecoveryCandidateAuthority.priorPull.mergedAt,
      historyStartAtMs:
        productionPostgresSourceRepinRecoveryCandidateAuthority.priorMergedAtMs,
      currentCandidateMergedAtMs: mergedAtMs,
      crossCandidate:
        productionPostgresSourceRepinRecoveryCandidateAuthority.crossCandidate,
      recoveryBridge:
        productionPostgresSourceRepinRecoveryCandidateAuthority.recoveryBridge,
      stagedRecovery:
        productionPostgresSourceRepinRecoveryCandidateAuthority.stagedRecovery,
      postStageBridge:
        productionPostgresSourceRepinRecoveryCandidateAuthority.postStageBridge,
      finalZeroWriteBridge:
        productionPostgresSourceRepinRecoveryCandidateAuthority
          .finalZeroWriteBridge,
    }, currentRun)
    : input.operation === "cold-recovery-reconcile-quiesce"
    ? await verifyColdQuiesceReconciliationHistory({
      ...historyInput,
      priorRunId: input.priorRunId,
      prepareRunId: input.prepareRunId,
    }, currentRun)
    : coldQuiesceSuccessor
    ? Object.freeze({
      safePriorSkippedWriteRunIds: [],
      safePriorReadOnlyRunIds: [],
      reconciledPriorAmbiguousDisableRunId: null,
    })
    : input.operation === "cold-recovery-reconcile-prepare" ||
        input.operation === "staging-worker-bootstrap-reconcile-restore" ||
        input.operation === "staging-worker-fence-reconcile-activate"
    ? await verifyRunnerLossReconciliationHistory({
      ...historyInput,
      operation: input.operation,
      priorRunId: input.priorRunId,
      replacementRunId: input.replacementRunId,
    }, currentRun)
    : input.operation === INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION
    ? Object.freeze({
      safePriorSkippedWriteRunIds:
        incidentCleanupCancelHistory.incidentSafePriorSkippedWriteRunIds,
      safePriorReadOnlyRunIds: [],
      reconciledPriorAmbiguousDisableRunId: null,
    })
    : input.operation === OFFSITE_CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION
    ? Object.freeze({
      safePriorSkippedWriteRunIds: [],
      safePriorReadOnlyRunIds: [],
      reconciledPriorAmbiguousDisableRunId: null,
    })
    : OFFSITE_CLEANUP_RECOVERY_OPERATIONS.has(input.operation)
    ? Object.freeze({
      safePriorSkippedWriteRunIds: [],
      safePriorReadOnlyRunIds: [],
      reconciledPriorAmbiguousDisableRunId: null,
    })
    : Object.freeze({
      safePriorSkippedWriteRunIds: await verifyOperationHistory(
        historyInput,
        configuration,
        currentRun,
      ),
      safePriorReadOnlyRunIds: [],
      reconciledPriorAmbiguousDisableRunId: null,
    });
  const cleanupRecoveryHistory =
    OFFSITE_CLEANUP_RECOVERY_OPERATIONS.has(input.operation)
      ? await verifyOffsiteCleanupRecoveryHistory(
        {
          ...historyInput,
          operation: input.operation,
          priorRunId: input.priorRunId,
        },
        currentRun,
      )
      : null;
  const stagingDeploymentRunIds =
    PROVIDER_OPERATIONS.has(input.operation) ||
      COLD_RECOVERY_OPERATIONS.has(input.operation) ||
      coldQuiesceSuccessor ||
      RUNNER_LOSS_RECOVERY_OPERATIONS.has(input.operation) ||
      (input.operation === "runtime-variable" && input.target !== "production")
      ? await verifyStagingLifecycleNotSealed(historyInput)
      : null;
  const replacementHistory =
    input.operation === "supabase-legacy-key-cutover" ||
      input.operation === "cold-recovery-prepare" ||
      input.operation === "cold-recovery-reconcile-prepare" ||
      coldQuiesceSuccessor
    ? await verifySelectedReplacementHistory({
      ...historyInput,
      replacementRunId: input.replacementRunId,
    })
    : null;
  let deploymentFreshness = null;
  let deploymentSequence = null;
  if (input.operation === "supabase-legacy-key-cutover") {
    const deployment = validateDeploymentRun(
      await githubGet(
        input.fetchImpl,
        token,
        REPOSITORY,
        `/actions/runs/${input.deploymentRunId}`,
      ),
      {
        candidateSha: input.candidateSha,
        deploymentRunId: input.deploymentRunId,
        currentStartedAtMs: currentRun.startedAt,
      },
    );
    deploymentSequence = await verifyCutoverDeploymentSequence(
      {
        ...historyInput,
        deploymentRunId: input.deploymentRunId,
      },
      deployment,
    );
    deploymentFreshness = await verifyNoPostDeploymentStagingWrites(
      historyInput,
      deployment,
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "pintpath-github-reviewed-candidate-authority",
    repository: REPOSITORY,
    candidateSha: input.candidateSha,
    reviewedPrHeadSha: pull.reviewedPrHeadSha,
    reviewedPullRequestNumber: pull.number,
    operation: input.operation,
    ...(input.cutoverMode === null ? {} : { cutoverMode: input.cutoverMode }),
    workflowPath: configuration.workflowPath,
    workflowRunId: currentRunIdSource,
    workflowRunAttempt: 1,
    workflowRunCreatedAt: currentRun.created_at,
    reviewedPullRequestMergedAt: pull.mergedAt,
    ...(OFFSITE_CLEANUP_RECOVERY_OPERATIONS.has(input.operation) ||
        input.operation === OFFSITE_CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION
      ? { reviewedTreeExact: pull.reviewedTreeExact }
      : {}),
    candidateHistoryMaximumAgeHours: MAX_CANDIDATE_AGE_HOURS,
    completeRetainedHistoryExact: true,
    safePriorSkippedWriteRunIds: operationHistory.safePriorSkippedWriteRunIds,
    ...(operationHistory.safePriorReadOnlyRunIds.length === 0
      ? {}
      : { safePriorReadOnlyRunIds: operationHistory.safePriorReadOnlyRunIds }),
    ...(operationHistory.reconciledPriorAmbiguousDisableRunId === null
      ? {}
      : {
        reconciledPriorAmbiguousDisableRunId:
          operationHistory.reconciledPriorAmbiguousDisableRunId,
        secondCutoverWritePreventedExact: true,
      }),
    ...(input.operation === "cold-recovery-reconcile-quiesce"
      ? {
        priorAmbiguousColdQuiesceRunId:
          operationHistory.priorAmbiguousColdQuiesceRunId,
        selectedColdPrepareRunId: operationHistory.selectedColdPrepareRunId,
        exactPriorColdQuiesceCandidateRunBound:
          operationHistory.exactPriorColdQuiesceCandidateRunBound,
        secondColdScaleWritePreventedExact:
          operationHistory.secondColdScaleWritePreventedExact,
      }
      : {}),
    ...(input.operation === "cold-recovery-reconcile-prepare"
      ? {
        priorAmbiguousColdPrepareRunId:
          operationHistory.priorAmbiguousColdPrepareRunId,
        selectedSupabaseReplacementRunId:
          operationHistory.selectedSupabaseReplacementRunId,
        exactPriorColdPrepareCandidateRunBound:
          operationHistory.exactPriorColdPrepareCandidateRunBound,
        secondColdPrepareWritePreventedExact:
          operationHistory.secondColdPrepareWritePreventedExact,
      }
      : {}),
    ...(input.operation === "staging-worker-bootstrap-reconcile-restore"
      ? {
        priorAmbiguousStagingRestoreRunId:
          operationHistory.priorAmbiguousStagingRestoreRunId,
        exactPriorStagingRestoreCandidateRunBound:
          operationHistory.exactPriorStagingRestoreCandidateRunBound,
        secondStagingRestoreScaleWritePreventedExact:
          operationHistory.secondStagingRestoreScaleWritePreventedExact,
      }
      : {}),
    ...(input.operation === "staging-worker-fence-reconcile-activate"
      ? {
        priorAmbiguousStagingActivateRunId:
          operationHistory.priorAmbiguousStagingActivateRunId,
        exactPriorStagingActivateCandidateRunBound:
          operationHistory.exactPriorStagingActivateCandidateRunBound,
        secondStagingActivateVariableWritePreventedExact:
          operationHistory.secondStagingActivateVariableWritePreventedExact,
      }
      : {}),
    ...(input.operation === PRODUCTION_POSTGRES_SOURCE_REPIN_RECONCILE_OPERATION
      ? {
        priorAmbiguousProductionPostgresSourceRepinRunId:
          operationHistory.priorAmbiguousProductionPostgresSourceRepinRunId,
        priorProductionPostgresSourceRepinIntentCandidateSha:
          operationHistory
            .priorProductionPostgresSourceRepinIntentCandidateSha,
        crossCandidateProductionPostgresSourceRepinRecoveryExact:
          operationHistory
            .crossCandidateProductionPostgresSourceRepinRecoveryExact,
        productionPostgresSourceRepinRecoveryChainCandidateShas:
          operationHistory
            .productionPostgresSourceRepinRecoveryChainCandidateShas,
        productionPostgresSourceRepinRecoveryBridgeExact:
          operationHistory.productionPostgresSourceRepinRecoveryBridgeExact,
        productionPostgresSourceRepinPostStageBridgeExact:
          operationHistory
            .productionPostgresSourceRepinPostStageBridgeExact,
        productionPostgresSourceRepinFinalZeroWriteBridgeExact:
          operationHistory
            .productionPostgresSourceRepinFinalZeroWriteBridgeExact,
        productionPostgresSourceRepinFinalZeroWriteArtifactMetadataExact:
          operationHistory
            .productionPostgresSourceRepinFinalZeroWriteArtifactMetadataExact,
        provenZeroWriteProductionPostgresSourceRepinRunId:
          operationHistory.provenZeroWriteProductionPostgresSourceRepinRunId,
        exactPriorProductionPostgresSourceRepinCandidateRunBound:
          operationHistory
            .exactPriorProductionPostgresSourceRepinCandidateRunBound,
        secondProductionPostgresRemediationDismissPreventedExact:
          operationHistory
            .secondProductionPostgresRemediationDismissPreventedExact,
        runnerLossRecoveryOriginalRunCompletedAt:
          operationHistory.runnerLossRecoveryOriginalRunCompletedAt,
        runnerLossRecoverySettlementSeconds:
          operationHistory.runnerLossRecoverySettlementSeconds,
        runnerLossRecoveryGraceHours:
          operationHistory.runnerLossRecoveryGraceHours,
        runnerLossRecoveryWithinGraceExact:
          operationHistory.runnerLossRecoveryWithinGraceExact,
        productionPostgresSourceRepinStagedRecoveryRunExact:
          operationHistory.productionPostgresSourceRepinStagedRecoveryRunExact,
        productionPostgresSourceRepinStagedRecoveryArtifactMetadataExact:
          operationHistory
            .productionPostgresSourceRepinStagedRecoveryArtifactMetadataExact,
        priorPossiblyWritingProductionPostgresSourceReconcileRunId:
          operationHistory
            .priorPossiblyWritingProductionPostgresSourceReconcileRunId,
        noAdditionalPossiblyWritingProductionPostgresSourceLockRunsExact:
          operationHistory
            .noAdditionalPossiblyWritingProductionPostgresSourceLockRunsExact,
        runnerLossRecoveryStageRunCompletedAt:
          operationHistory.runnerLossRecoveryStageRunCompletedAt,
        runnerLossRecoveryStageSettlementSeconds:
          operationHistory.runnerLossRecoveryStageSettlementSeconds,
        runnerLossRecoveryStageGraceHours:
          operationHistory.runnerLossRecoveryStageGraceHours,
        runnerLossRecoveryStageWithinGraceExact:
          operationHistory.runnerLossRecoveryStageWithinGraceExact,
        runnerLossRecoveryFinalZeroWriteRunCompletedAt:
          operationHistory.runnerLossRecoveryFinalZeroWriteRunCompletedAt,
        runnerLossRecoveryFinalZeroWriteSettlementSeconds:
          operationHistory.runnerLossRecoveryFinalZeroWriteSettlementSeconds,
        runnerLossRecoveryFinalZeroWriteWithinSettlementExact:
          operationHistory
            .runnerLossRecoveryFinalZeroWriteWithinSettlementExact,
      }
      : {}),
    ...(RUNNER_LOSS_RECOVERY_OPERATIONS.has(input.operation)
      ? {
        runnerLossRecoveryOriginalRunCompletedAt:
          operationHistory.runnerLossRecoveryOriginalRunCompletedAt,
        runnerLossRecoveryGraceHours:
          operationHistory.runnerLossRecoveryGraceHours,
        runnerLossRecoveryWithinGraceExact:
          operationHistory.runnerLossRecoveryWithinGraceExact,
      }
      : {}),
    ...(cleanupRecoveryHistory ?? {}),
    ...(incidentCleanupCancelHistory ?? {}),
    ...(cleanupSuccessorCloseoutHistory ?? {}),
    ...(coldQuiesceSuccessorBridge ?? {}),
    ...(stagingDeploymentRunIds === null
      ? {}
      : {
        successfulStagingDeploymentRunIds: stagingDeploymentRunIds,
        stagingLifecycleSealed: false,
      }),
    ...(replacementHistory ?? {}),
    ...(deploymentSequence ?? {}),
    ...(deploymentFreshness ?? {}),
    reviewedAuthorityExact: true,
    freshDispatchWriteGuardExact: true,
  });
}

export async function runGithubReviewedCandidateAuthority(argv, dependencies = {}) {
  const writeOutput = dependencies.writeOutput ?? ((value) => process.stdout.write(value));
  try {
    const args = parseArguments(argv);
    const authority = await verifyGithubReviewedCandidateAuthority({
      ...args,
      env: dependencies.env ?? process.env,
      fetchImpl: dependencies.fetchImpl ?? fetch,
    });
    writeOutput(`${JSON.stringify({
      command: "verify-github-reviewed-candidate-authority",
      ok: true,
      ...authority,
    })}\n`);
    return 0;
  } catch (error) {
    writeOutput(`${JSON.stringify({
      command: "verify-github-reviewed-candidate-authority",
      ok: false,
      failureCode: error instanceof Error ? error.message : "unexpected_failure",
    })}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runGithubReviewedCandidateAuthority(process.argv.slice(2));
}
