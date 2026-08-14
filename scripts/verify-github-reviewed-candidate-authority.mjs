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
const DEPLOYMENT_WORKFLOW_PATH =
  ".github/workflows/deploy-permanent-staging.yml";
const DEPLOYMENT_WORKFLOW_ID = "deploy-permanent-staging.yml";
const PROVIDER_JOB_NAME = "One atomic variable mutation";
const PROVIDER_WRITE_STEP =
  "Execute exactly one reviewed atomic Railway mutation";
const CUTOVER_JOB_NAME = "Disable exact permanent-staging legacy keys";
const CUTOVER_WRITE_STEP =
  "Canary replacement keys, disable legacy keys once, and reconcile";
const PROVIDER_OPERATIONS = new Set([
  "provider-google-maps-api-key",
  "provider-google-maps-map-id",
  "provider-google-places-api-key",
  "provider-openai-api-key",
  "supabase-key-replacement",
]);
const RUNTIME_VARIABLE_TARGETS = new Set(["permanent-staging", "production"]);
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
  "ACCOUNT_DELETION_NOTICE_KEYRING_JSON",
]);

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
  if (!Array.isArray(argv) || argv.length < 4 || argv.length > 8 || argv.length % 2) {
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
  const target = values.get("--target") ?? null;
  const variableName = values.get("--variable-name") ?? null;
  const cutover = operation === "supabase-legacy-key-cutover";
  const runtimeVariable = operation === "runtime-variable";
  if (
    !SHA.test(candidateSha) ||
    (!cutover && !runtimeVariable && !PROVIDER_OPERATIONS.has(operation)) ||
    (cutover
      ? !RUN_ID.test(replacementRunId ?? "") || !RUN_ID.test(deploymentRunId ?? "")
      : replacementRunId !== null || deploymentRunId !== null) ||
    (runtimeVariable
      ? !RUNTIME_VARIABLE_TARGETS.has(target) || !RUNTIME_VARIABLE_NAMES.has(variableName)
      : target !== null || variableName !== null)
  ) fail("arguments_invalid");
  return Object.freeze({
    candidateSha,
    operation,
    replacementRunId,
    deploymentRunId,
    target,
    variableName,
  });
}

function operationConfiguration(operation, candidateSha, target, variableName) {
  if (operation === "supabase-legacy-key-cutover") {
    return Object.freeze({
      workflowPath: CUTOVER_WORKFLOW_PATH,
      workflowId: CUTOVER_WORKFLOW_ID,
      displayTitle: `Permanent staging Supabase legacy cutover | ${candidateSha}`,
      jobName: CUTOVER_JOB_NAME,
      writeStep: CUTOVER_WRITE_STEP,
      priorSkippedWriteAllowed: true,
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

function validateRunIdentity(value, expected) {
  const createdAt = parseTimestamp(value?.created_at, expected.failureCode);
  const startedAt = parseTimestamp(value?.run_started_at, expected.failureCode);
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
    startedAt < createdAt
  ) fail(expected.failureCode);
  return Object.freeze({ ...value, createdAt, startedAt });
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

async function priorRunSkippedWrite(input, run, configuration) {
  if (
    run.status !== "completed" ||
    !["failure", "cancelled", "timed_out"].includes(run.conclusion)
  ) return false;
  const listing = await githubGet(
    input.fetchImpl,
    input.token,
    REPOSITORY,
    `/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
  );
  if (
    listing?.total_count !== 1 ||
    !Array.isArray(listing?.jobs) ||
    listing.jobs.length !== 1
  ) return false;
  const job = listing.jobs[0];
  if (
    job?.run_id !== run.id ||
    job?.run_attempt !== 1 ||
    job?.name !== configuration.jobName ||
    job?.status !== "completed" ||
    job?.conclusion !== run.conclusion ||
    !Array.isArray(job?.steps)
  ) return false;
  const writeSteps = job.steps.filter((step) => step?.name === configuration.writeStep);
  return writeSteps.length === 1 &&
    writeSteps[0]?.status === "completed" &&
    writeSteps[0]?.conclusion === "skipped";
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
        run.status !== "in_progress" ||
        run.conclusion !== null ||
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
    if (classified.target !== "permanent-staging") continue;
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
  if (currentRun.status !== "in_progress" || currentRun.conclusion !== null) {
    fail("current_run_invalid");
  }
  const mergedAtMs = parseTimestamp(pull.mergedAt, "reviewed_pull_request_invalid");
  if (
    currentRun.createdAt < mergedAtMs ||
    currentRun.startedAt - mergedAtMs > MAX_CANDIDATE_AGE_MS
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
  const safePriorRunIds = await verifyOperationHistory(
    historyInput,
    configuration,
    currentRun,
  );
  const stagingDeploymentRunIds =
    PROVIDER_OPERATIONS.has(input.operation) ||
      (input.operation === "runtime-variable" && input.target === "permanent-staging")
      ? await verifyStagingLifecycleNotSealed(historyInput)
      : null;
  const replacementHistory = input.operation === "supabase-legacy-key-cutover"
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
    workflowPath: configuration.workflowPath,
    workflowRunId: currentRunIdSource,
    workflowRunAttempt: 1,
    workflowRunCreatedAt: currentRun.created_at,
    reviewedPullRequestMergedAt: pull.mergedAt,
    candidateHistoryMaximumAgeHours: MAX_CANDIDATE_AGE_HOURS,
    completeRetainedHistoryExact: true,
    safePriorSkippedWriteRunIds: safePriorRunIds,
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
