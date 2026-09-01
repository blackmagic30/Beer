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

function runtimeVariableCombinationExact(target, variableName) {
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
  if (!Array.isArray(argv) || argv.length < 4 || argv.length > 10 || argv.length % 2) {
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
      !RUNNER_LOSS_RECOVERY_OPERATIONS.has(operation)) ||
    (cutover
      ? !RUN_ID.test(replacementRunId ?? "") ||
        !RUN_ID.test(deploymentRunId ?? "") ||
        !CUTOVER_MODES.has(cutoverMode)
      : coldPrepare || coldPrepareReconcile
      ? !RUN_ID.test(replacementRunId ?? "") ||
        deploymentRunId !== null ||
        cutoverMode !== null
      : replacementRunId !== null || deploymentRunId !== null || cutoverMode !== null) ||
    (offsiteCleanupRecovery || incidentMaskedCleanupCancel ||
      offsiteCleanupSuccessorCloseout || runnerLossReconcile ||
      productionPostgresSourceRepinReconcile
      ? !RUN_ID.test(priorRunId ?? "")
      : priorRunId !== null) ||
    (coldQuiesceReconcile
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
  if (COLD_RECOVERY_OPERATIONS.has(operation)) {
    const coldOperation = operation === "cold-recovery-prepare"
      ? "prepare"
      : operation === "cold-recovery-reconcile-prepare"
      ? "reconcile-prepare"
      : operation === "cold-recovery-quiesce"
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
        ? "Initialize the exact dead baseline at explicit zero"
        : "Reconcile an ambiguous cold quiesce at exact zero",
      writeStep: coldOperation === "prepare"
        ? "Prepare the exact dead staging baseline once"
        : coldOperation === "quiesce"
        ? "Initialize the dead baseline from null to explicit zero once"
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
  const coldJobNames = [
    "Bind the exact replacement and prepare the dead baseline",
    "Reconcile an ambiguous cold prepare at the exact dead baseline",
    "Initialize the exact dead baseline at explicit zero",
    "Reconcile an ambiguous cold quiesce at exact zero",
  ];
  const cold = configuration.workflowPath === COLD_RECOVERY_WORKFLOW_PATH;
  const bootstrapJobNames = [
    "Verify the chain and perform one exact protected scale transition",
    "Reconcile an ambiguous staging bootstrap restore at exact one",
  ];
  const workerJobNames = [
    "One candidate-bound automatic-maintenance transition",
    "Reconcile an ambiguous staging automatic-maintenance activation",
  ];
  const workflowJobNames = cold
    ? coldJobNames
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

function exactWorkflowJobNames(workflowPath) {
  return workflowPath === COLD_RECOVERY_WORKFLOW_PATH
    ? [
        "Bind the exact replacement and prepare the dead baseline",
        "Reconcile an ambiguous cold prepare at the exact dead baseline",
        "Initialize the exact dead baseline at explicit zero",
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

async function readOnlyReconciliationRunExact(
  input,
  run,
  configuration,
  allowedConclusions,
) {
  const jobNames = exactWorkflowJobNames(configuration.workflowPath);
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
    fail("production_postgres_source_repin_reconciliation_history_invalid");
  }
  let currentSeen = false;
  let selectedOriginal = null;
  const safePriorSkippedWriteRunIds = [];
  for (const observed of candidateRuns) {
    const configuration = observed?.display_title ===
        applyConfiguration.displayTitle
      ? applyConfiguration
      : observed?.display_title === reconcileConfiguration.displayTitle
      ? reconcileConfiguration
      : null;
    if (configuration === null) {
      fail("production_postgres_source_repin_reconciliation_history_invalid");
    }
    const run = validateRunIdentity(observed, {
      runId: observed?.id,
      candidateSha: input.candidateSha,
      workflowPath: PRODUCTION_POSTGRES_SOURCE_REPIN_WORKFLOW_PATH,
      displayTitle: configuration.displayTitle,
      failureCode:
        "production_postgres_source_repin_reconciliation_history_invalid",
    });
    if (run.createdAt < input.mergedAtMs ||
      run.createdAt > input.currentStartedAtMs) {
      fail("production_postgres_source_repin_reconciliation_history_invalid");
    }
    if (run.id === currentRun.id) {
      if (configuration !== reconcileConfiguration || currentSeen ||
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
    if (configuration === applyConfiguration &&
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
    if (disposition !== "skipped") {
      fail("production_postgres_source_repin_reconciliation_history_invalid");
    }
    safePriorSkippedWriteRunIds.push(String(run.id));
  }
  if (!currentSeen || selectedOriginal === null ||
    selectedOriginal.updatedAt >= currentRun.startedAt ||
    currentRun.startedAt - selectedOriginal.updatedAt <
      PRODUCTION_POSTGRES_SOURCE_REPIN_RECOVERY_SETTLEMENT_MS ||
    currentRun.startedAt - selectedOriginal.updatedAt > RECOVERY_GRACE_MS) {
    fail("production_postgres_source_repin_reconciliation_history_invalid");
  }
  for (const skippedRunId of safePriorSkippedWriteRunIds) {
    const skipped = candidateRuns.find((run) => String(run?.id) === skippedRunId);
    if (parseTimestamp(
      skipped?.updated_at,
      "production_postgres_source_repin_reconciliation_history_invalid",
    ) >= currentRun.startedAt) {
      fail("production_postgres_source_repin_reconciliation_history_invalid");
    }
  }
  return Object.freeze({
    safePriorSkippedWriteRunIds: safePriorSkippedWriteRunIds.sort(
      (left, right) => Number(left) - Number(right),
    ),
    safePriorReadOnlyRunIds: [],
    reconciledPriorAmbiguousDisableRunId: null,
    priorAmbiguousProductionPostgresSourceRepinRunId: input.priorRunId,
    exactPriorProductionPostgresSourceRepinCandidateRunBound: true,
    secondProductionPostgresRemediationDismissPreventedExact: true,
    runnerLossRecoveryOriginalRunCompletedAt: new Date(
      selectedOriginal.updatedAt,
    ).toISOString(),
    runnerLossRecoverySettlementSeconds:
      PRODUCTION_POSTGRES_SOURCE_REPIN_RECOVERY_SETTLEMENT_MS / 1_000,
    runnerLossRecoveryGraceHours: RECOVERY_GRACE_HOURS,
    runnerLossRecoveryWithinGraceExact: true,
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
    /[\r\n\0]/.test(token)
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
  const historyInput = {
    fetchImpl: input.fetchImpl,
    token,
    candidateSha: input.candidateSha,
    currentStartedAt: currentRun.run_started_at,
    currentStartedAtMs: currentRun.startedAt,
    mergedAt: pull.mergedAt,
    mergedAtMs,
  };
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
    }, currentRun)
    : input.operation === "cold-recovery-reconcile-quiesce"
    ? await verifyColdQuiesceReconciliationHistory({
      ...historyInput,
      priorRunId: input.priorRunId,
      prepareRunId: input.prepareRunId,
    }, currentRun)
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
      RUNNER_LOSS_RECOVERY_OPERATIONS.has(input.operation) ||
      (input.operation === "runtime-variable" && input.target !== "production")
      ? await verifyStagingLifecycleNotSealed(historyInput)
      : null;
  const replacementHistory =
    input.operation === "supabase-legacy-key-cutover" ||
      input.operation === "cold-recovery-prepare" ||
      input.operation === "cold-recovery-reconcile-prepare"
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
