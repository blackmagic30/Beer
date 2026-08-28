import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  holdPrivateDirectoryIdentity,
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";
import { fetchBoundedResponseText } from "./lib/bounded-http-response.js";

const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const REPOSITORY = "blackmagic30/Beer";
const REPLACEMENT_WORKFLOW_PATH =
  ".github/workflows/permanent-staging-provider-mutation.yml";
const REPLACEMENT_WORKFLOW_ID = "permanent-staging-provider-mutation.yml";
const REPLACEMENT_WORKFLOW_NAME =
  "Mutate Pint Path permanent-staging provider variables";
const DEPLOYMENT_WORKFLOW_PATH =
  ".github/workflows/deploy-permanent-staging.yml";
const DEPLOYMENT_WORKFLOW_ID = "deploy-permanent-staging.yml";
const DEPLOYMENT_JOB_NAME = "Deploy permanent staging";
const DEPLOYMENT_WORKFLOW_NAME = "Deploy Pint Path permanent staging";
const DEPLOYMENT_MUTATION_STEP =
  "Execute one permanent-staging source upload and reconcile it";
const CUTOVER_WORKFLOW_PATH =
  ".github/workflows/permanent-staging-supabase-legacy-cutover.yml";
const CUTOVER_WORKFLOW_NAME = "Permanent staging Supabase legacy-key cutover";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const DEPLOYMENT_RECEIPT_SCHEMA =
  "pintpath-railway-application-deployment-executor/v5";
const DEPLOYMENT_RECEIPT_OPERATION =
  "pintpath-railway-application-source-upload";
const DEPLOYMENT_RECEIPT_STATE = "GITHUB_ENVIRONMENT_PROTECTED";
const DEPLOYMENT_CHECK_KEYS = Object.freeze([
  "boundaryPostflightExact",
  "boundaryPreflightExact",
  "cliExact",
  "collateralInventoryExact",
  "collateralStateUnchanged",
  "costPolicyExact",
  "deploymentExact",
  "durableIntentExact",
  "gitAutodeployAbsent",
  "githubMainExact",
  "policyExact",
  "prerequisiteExact",
  "reconciliationCompleted",
  "runtimeHealthExact",
  "runtimeReadinessExact",
  "runtimeStartupExact",
  "sourceAuthorityExact",
  "sourceReasserted",
  "targetPostflightAttempted",
  "targetPostflightExact",
  "targetPreflightExact",
  "terminalEvidenceExact",
  "topologyPreserved",
  "workerFenceDeploymentContinuityExact",
  "workerFencePrerequisiteExact",
  "writeAttemptedAtMostOnce",
  "writeTokenScopeExact",
]);

function fail(code) {
  throw new Error(`github_permanent_staging_deployment_${code}`);
}

function parseArgs(argv) {
  if (argv.length !== 14) fail("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      ![
        "--candidate-sha",
        "--replacement-run-id",
        "--fenced-deployment-run-id",
        "--deployment-run-id",
        "--fenced-deployment-receipt",
        "--deployment-receipt",
        "--output",
      ].includes(key) ||
      !value ||
      values.has(key)
    )
      fail("arguments_invalid");
    values.set(key, value);
  }
  const candidateSha = values.get("--candidate-sha") ?? "";
  const replacementRunId = values.get("--replacement-run-id") ?? "";
  const fencedDeploymentRunId =
    values.get("--fenced-deployment-run-id") ?? "";
  const deploymentRunId = values.get("--deployment-run-id") ?? "";
  const fencedDeploymentReceipt =
    values.get("--fenced-deployment-receipt") ?? "";
  const deploymentReceipt = values.get("--deployment-receipt") ?? "";
  const output = values.get("--output") ?? "";
  if (
    !SHA.test(candidateSha) ||
    !RUN_ID.test(replacementRunId) ||
    !RUN_ID.test(fencedDeploymentRunId) ||
    !RUN_ID.test(deploymentRunId) ||
    replacementRunId === deploymentRunId ||
    replacementRunId === fencedDeploymentRunId ||
    fencedDeploymentRunId === deploymentRunId ||
    !safeReceiptPath(fencedDeploymentReceipt) ||
    !safeReceiptPath(deploymentReceipt) ||
    fencedDeploymentReceipt === deploymentReceipt ||
    !path.isAbsolute(output) ||
    path.resolve(output) !== output ||
    output.includes("\0") ||
    path.basename(output) !== "deployment-github-authority.json"
  )
    fail("arguments_invalid");
  return {
    candidateSha,
    replacementRunId,
    fencedDeploymentRunId,
    deploymentRunId,
    fencedDeploymentReceipt,
    deploymentReceipt,
    output,
  };
}

function safeReceiptPath(value) {
  return path.isAbsolute(value) && path.resolve(value) === value &&
    !value.includes("\0") && path.basename(value) === "deployment-receipt.json";
}

function exactObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function exactKeys(value, keys) {
  return exactObject(value) !== null &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function githubTimestamp(value, failureCode) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) {
    fail(failureCode);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(failureCode);
  const canonical = new Date(milliseconds).toISOString();
  if (canonical !== (value.includes(".") ? value : value.replace("Z", ".000Z"))) {
    fail(failureCode);
  }
  return { canonical, milliseconds };
}

async function githubJson(fetchImpl, url, token, requestTimeoutMs) {
  let bounded;
  try {
    bounded = await fetchBoundedResponseText(
      fetchImpl,
      url,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "pintpath-permanent-staging-deployment-verifier/1",
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        cache: "no-store",
      },
      {
        maximumBytes: MAX_RESPONSE_BYTES,
        signal: AbortSignal.timeout(requestTimeoutMs),
      },
    );
  } catch {
    fail("api_failed");
  }
  if (!bounded.response.ok) fail("api_failed");
  try {
    return JSON.parse(bounded.source);
  } catch {
    return fail("api_invalid");
  }
}

function validateWorkflowRun(value, expected) {
  const run = exactObject(value);
  const repository = exactObject(run?.repository);
  const headRepository = exactObject(run?.head_repository);
  const workflowPathExact =
    run?.path === expected.workflowPath ||
    run?.path === `${expected.workflowPath}@main`;
  if (
    !run ||
    String(run.id) !== expected.runId ||
    repository?.full_name !== REPOSITORY ||
    headRepository?.full_name !== REPOSITORY ||
    run.head_sha !== expected.candidateSha ||
    run.head_branch !== "main" ||
    !workflowPathExact ||
    run.event !== "workflow_dispatch" ||
    run.run_attempt !== 1 ||
    run.status !== expected.status ||
    run.conclusion !== expected.conclusion ||
    (expected.workflowName !== undefined && run.name !== expected.workflowName) ||
    (expected.displayTitle !== undefined &&
      run.display_title !== expected.displayTitle)
  )
    fail(expected.failureCode);
  return run;
}

function deploymentTitle(phase, candidateSha) {
  return `Deploy permanent staging | ${phase} | ${candidateSha}`;
}

function deploymentPhase(value, candidateSha) {
  for (const phase of ["fenced", "active"]) {
    if (value === deploymentTitle(phase, candidateSha)) return phase;
  }
  return null;
}

function replacementTitle(candidateSha) {
  return `Permanent staging provider mutation | supabase-key-replacement | ${candidateSha}`;
}

function cutoverTitleExact(value, candidateSha) {
  return [
    "reconcile-already-disabled-legacy-keys",
    "disable-enabled-legacy-keys",
  ].some((operation) => value ===
    `Permanent staging Supabase legacy cutover | ${operation} | ${candidateSha}`);
}

function validateArtifact(value, expected) {
  const listing = exactObject(value);
  const artifacts = Array.isArray(listing?.artifacts) ? listing.artifacts : [];
  if (listing?.total_count !== 1 || artifacts.length !== 1) {
    fail("artifact_invalid");
  }
  const artifact = exactObject(artifacts[0]);
  const workflowRun = exactObject(artifact?.workflow_run);
  if (
    !artifact ||
    artifact.name !== expected.name ||
    artifact.expired !== false ||
    !RUN_ID.test(String(artifact.id)) ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > MAX_ARTIFACT_BYTES ||
    !ARTIFACT_DIGEST.test(String(artifact.digest)) ||
    artifact.archive_download_url !==
      `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip` ||
    String(workflowRun?.id) !== expected.runId ||
    workflowRun?.head_sha !== expected.candidateSha
  )
    fail("artifact_invalid");
  return artifact;
}

function validateWorkflowRunListing(value, failureCode = "deployment_window_invalid") {
  const listing = exactObject(value);
  const runs = Array.isArray(listing?.workflow_runs) ? listing.workflow_runs : [];
  if (
    !Number.isSafeInteger(listing?.total_count) ||
    listing.total_count < 1 ||
    listing.total_count > 100 ||
    runs.length !== listing.total_count
  ) fail(failureCode);
  return runs;
}

function deploymentWriteDisposition(value, run) {
  const listing = exactObject(value);
  const jobs = Array.isArray(listing?.jobs) ? listing.jobs : [];
  if (listing?.total_count !== 1 || jobs.length !== 1) return "invalid";
  const job = exactObject(jobs[0]);
  if (
    !job ||
    String(job.run_id) !== String(run.id) ||
    job.run_attempt !== 1 ||
    job.name !== DEPLOYMENT_JOB_NAME ||
    job.status !== "completed" ||
    job.conclusion !== run.conclusion ||
    !Array.isArray(job.steps)
  ) return "invalid";
  const mutationSteps = job.steps.filter((candidate) =>
    exactObject(candidate)?.name === DEPLOYMENT_MUTATION_STEP);
  if (mutationSteps.length !== 1) return "invalid";
  const mutation = exactObject(mutationSteps[0]);
  if (mutation?.status !== "completed") return "invalid";
  if (mutation.conclusion === "skipped") return "skipped";
  return ["success", "failure", "cancelled", "timed_out"].includes(
    mutation.conclusion,
  ) ? "may-have-written" : "invalid";
}

function validateDeploymentReceipt(value, expected) {
  const receipt = exactObject(value);
  const checks = exactObject(receipt?.checks);
  const replicaCounts = exactObject(receipt?.replicaCounts);
  const runtimeResponseSha256s = exactObject(receipt?.runtimeResponseSha256s);
  const collateralSnapshotSha256s = exactObject(
    receipt?.collateralSnapshotSha256s,
  );
  const workerFencePrerequisite = exactObject(receipt?.workerFencePrerequisite);
  const outcome = receipt?.outcome;
  const startedAt = githubTimestamp(receipt?.startedAt, "receipt_invalid");
  const completedAt = githubTimestamp(receipt?.completedAt, "receipt_invalid");
  const hashes = [
    receipt?.previousDeploymentIdSha256,
    receipt?.deploymentIdSha256,
    receipt?.intentSha256,
    receipt?.boundaryPreflightSha256,
    receipt?.boundaryPostflightSha256,
    collateralSnapshotSha256s?.before,
    collateralSnapshotSha256s?.after,
  ];
  const phaseRuntimeExact = expected.phase === "fenced"
    ? exactKeys(runtimeResponseSha256s, ["health", "startup", "ready"]) &&
      Object.values(runtimeResponseSha256s).every((item) => item === null)
    : exactKeys(runtimeResponseSha256s, ["health", "startup", "ready"]) &&
      Object.values(runtimeResponseSha256s).every((item) =>
        typeof item === "string" && /^[a-f0-9]{64}$/.test(item));
  const outcomeExact = expected.phase === "active"
    ? outcome === "already_deployed" && receipt?.writeAttempts === 0 &&
      receipt?.acknowledgement === "not_attempted" &&
      receipt?.cliOutputSha256 === null
    : ["deployed", "reconciled_success", "already_deployed"].includes(outcome) &&
      (outcome === "already_deployed"
        ? receipt?.writeAttempts === 0 &&
          receipt?.acknowledgement === "not_attempted" &&
          receipt?.cliOutputSha256 === null
        : receipt?.writeAttempts === 1 &&
          (outcome === "deployed"
            ? receipt?.acknowledgement === "received"
            : receipt?.acknowledgement === "missing_or_failed") &&
          typeof receipt?.cliOutputSha256 === "string" &&
          /^[a-f0-9]{64}$/.test(receipt.cliOutputSha256));
  const workerFenceExact = receipt?.workerFencePrerequisite === null || (
    exactKeys(workerFencePrerequisite, [
      "runId",
      "verificationSha256",
      "bindingSha256",
      "terminalSha256",
      "deploymentIdSha256",
    ]) &&
    RUN_ID.test(String(workerFencePrerequisite.runId)) &&
    [
      workerFencePrerequisite.verificationSha256,
      workerFencePrerequisite.bindingSha256,
      workerFencePrerequisite.terminalSha256,
      workerFencePrerequisite.deploymentIdSha256,
    ].every((item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))
  );
  if (
    !exactKeys(receipt, [
      "schemaVersion",
      "operation",
      "executorState",
      "target",
      "outcome",
      "failureCode",
      "candidateSha",
      "startedAt",
      "completedAt",
      "writeAttempts",
      "acknowledgement",
      "previousDeploymentIdSha256",
      "deploymentIdSha256",
      "intentSha256",
      "cliOutputSha256",
      "boundaryPreflightSha256",
      "boundaryPostflightSha256",
      "collateralSnapshotSha256s",
      "replicaCounts",
      "runtimeResponseSha256s",
      "workerFencePrerequisite",
      "checks",
    ]) ||
    receipt.schemaVersion !== DEPLOYMENT_RECEIPT_SCHEMA ||
    receipt.operation !== DEPLOYMENT_RECEIPT_OPERATION ||
    receipt.executorState !== DEPLOYMENT_RECEIPT_STATE ||
    receipt.target !== "permanent-staging" ||
    receipt.failureCode !== null ||
    receipt.candidateSha !== expected.candidateSha ||
    !outcomeExact ||
    startedAt.milliseconds < expected.runStartedAtMs ||
    completedAt.milliseconds < startedAt.milliseconds ||
    completedAt.milliseconds > expected.runUpdatedAtMs ||
    !exactKeys(replicaCounts, ["before", "after"]) ||
    replicaCounts.before !== (expected.phase === "fenced" ? 0 : 1) ||
    replicaCounts.after !== (expected.phase === "fenced" ? 0 : 1) ||
    !phaseRuntimeExact ||
    !exactKeys(collateralSnapshotSha256s, ["before", "after"]) ||
    hashes.some((item) =>
      typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item)) ||
    collateralSnapshotSha256s.before !== collateralSnapshotSha256s.after ||
    (outcome === "already_deployed"
      ? receipt.previousDeploymentIdSha256 !== receipt.deploymentIdSha256
      : receipt.previousDeploymentIdSha256 === receipt.deploymentIdSha256) ||
    !workerFenceExact ||
    !exactKeys(checks, DEPLOYMENT_CHECK_KEYS) ||
    Object.values(checks).some((item) => item !== true)
  ) fail("receipt_invalid");
  return Object.freeze({
    outcome,
    writeAttempts: receipt.writeAttempts,
    startedAt: startedAt.canonical,
    completedAt: completedAt.canonical,
  });
}

export async function verifyGithubPermanentStagingDeployment(input) {
  const repository = input.env.GITHUB_REPOSITORY ?? "";
  const token = input.env.GITHUB_TOKEN ?? "";
  const api = input.env.GITHUB_API_URL ?? "https://api.github.com";
  const currentRunId = input.env.GITHUB_RUN_ID ?? "";
  if (
    input.env.GITHUB_ACTIONS !== "true" ||
    input.env.GITHUB_REF !== "refs/heads/main" ||
    input.env.GITHUB_SHA !== input.candidateSha ||
    input.env.GITHUB_RUN_ATTEMPT !== "1" ||
    repository !== REPOSITORY ||
    api !== "https://api.github.com" ||
    !RUN_ID.test(currentRunId) ||
    currentRunId === input.replacementRunId ||
    currentRunId === input.fencedDeploymentRunId ||
    currentRunId === input.deploymentRunId ||
    token.length < 16 ||
    /[\r\n\0]/.test(token)
  )
    fail("environment_invalid");

  const base = `${api}/repos/${repository}`;
  const currentRun = validateWorkflowRun(
    await githubJson(
      input.fetchImpl,
      `${base}/actions/runs/${currentRunId}`,
      token,
      input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
    {
      runId: currentRunId,
      candidateSha: input.candidateSha,
      workflowPath: CUTOVER_WORKFLOW_PATH,
      workflowName: CUTOVER_WORKFLOW_NAME,
      status: "in_progress",
      conclusion: null,
      failureCode: "consumer_run_invalid",
    },
  );
  if (!cutoverTitleExact(currentRun.display_title, input.candidateSha)) {
    fail("consumer_run_invalid");
  }
  const replacementRun = validateWorkflowRun(
    await githubJson(
      input.fetchImpl,
      `${base}/actions/runs/${input.replacementRunId}`,
      token,
      input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
    {
      runId: input.replacementRunId,
      candidateSha: input.candidateSha,
      workflowPath: REPLACEMENT_WORKFLOW_PATH,
      workflowName: REPLACEMENT_WORKFLOW_NAME,
      displayTitle: replacementTitle(input.candidateSha),
      status: "completed",
      conclusion: "success",
      failureCode: "replacement_run_invalid",
    },
  );
  const deploymentRun = validateWorkflowRun(
    await githubJson(
      input.fetchImpl,
      `${base}/actions/runs/${input.deploymentRunId}`,
      token,
      input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
    {
      runId: input.deploymentRunId,
      candidateSha: input.candidateSha,
      workflowPath: DEPLOYMENT_WORKFLOW_PATH,
      workflowName: DEPLOYMENT_WORKFLOW_NAME,
      displayTitle: deploymentTitle("active", input.candidateSha),
      status: "completed",
      conclusion: "success",
      failureCode: "deployment_run_invalid",
    },
  );
  const fencedDeploymentRun = validateWorkflowRun(
    await githubJson(
      input.fetchImpl,
      `${base}/actions/runs/${input.fencedDeploymentRunId}`,
      token,
      input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
    {
      runId: input.fencedDeploymentRunId,
      candidateSha: input.candidateSha,
      workflowPath: DEPLOYMENT_WORKFLOW_PATH,
      workflowName: DEPLOYMENT_WORKFLOW_NAME,
      displayTitle: deploymentTitle("fenced", input.candidateSha),
      status: "completed",
      conclusion: "success",
      failureCode: "fenced_deployment_run_invalid",
    },
  );
  const currentStartedAt = githubTimestamp(
    currentRun.run_started_at,
    "consumer_run_invalid",
  );
  const replacementStartedAt = githubTimestamp(
    replacementRun.run_started_at,
    "replacement_run_invalid",
  );
  const replacementCreatedAt = githubTimestamp(
    replacementRun.created_at,
    "replacement_run_invalid",
  );
  const replacementUpdatedAt = githubTimestamp(
    replacementRun.updated_at,
    "replacement_run_invalid",
  );
  const deploymentStartedAt = githubTimestamp(
    deploymentRun.run_started_at,
    "deployment_run_invalid",
  );
  const deploymentUpdatedAt = githubTimestamp(
    deploymentRun.updated_at,
    "deployment_run_invalid",
  );
  const fencedDeploymentStartedAt = githubTimestamp(
    fencedDeploymentRun.run_started_at,
    "fenced_deployment_run_invalid",
  );
  const fencedDeploymentUpdatedAt = githubTimestamp(
    fencedDeploymentRun.updated_at,
    "fenced_deployment_run_invalid",
  );
  if (
    replacementCreatedAt.milliseconds > replacementStartedAt.milliseconds ||
    replacementUpdatedAt.milliseconds <= replacementStartedAt.milliseconds ||
    replacementUpdatedAt.milliseconds >=
      fencedDeploymentStartedAt.milliseconds ||
    fencedDeploymentUpdatedAt.milliseconds <=
      fencedDeploymentStartedAt.milliseconds ||
    fencedDeploymentUpdatedAt.milliseconds >= deploymentStartedAt.milliseconds ||
    deploymentUpdatedAt.milliseconds <= deploymentStartedAt.milliseconds ||
    deploymentUpdatedAt.milliseconds >= currentStartedAt.milliseconds
  )
    fail("chronology_invalid");

  const replacementWindow =
    `${replacementCreatedAt.canonical}..${deploymentStartedAt.canonical}`;
  const replacementRuns = validateWorkflowRunListing(await githubJson(
    input.fetchImpl,
    `${base}/actions/workflows/${REPLACEMENT_WORKFLOW_ID}/runs` +
      `?branch=main&event=workflow_dispatch&created=${encodeURIComponent(replacementWindow)}` +
      "&per_page=100",
    token,
    input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
  ), "replacement_window_invalid");
  const sameCandidateReplacementRuns = replacementRuns.filter((candidate) =>
    exactObject(candidate)?.head_sha === input.candidateSha);
  if (
    sameCandidateReplacementRuns.length !== 1 ||
    String(exactObject(sameCandidateReplacementRuns[0])?.id) !== input.replacementRunId
  ) fail("replacement_window_invalid");
  const selectedReplacementWindowRun = validateWorkflowRun(
    sameCandidateReplacementRuns[0],
    {
      runId: input.replacementRunId,
      candidateSha: input.candidateSha,
      workflowPath: REPLACEMENT_WORKFLOW_PATH,
      workflowName: REPLACEMENT_WORKFLOW_NAME,
      displayTitle: replacementTitle(input.candidateSha),
      status: "completed",
      conclusion: "success",
      failureCode: "replacement_window_invalid",
    },
  );
  if (
    selectedReplacementWindowRun.created_at !== replacementRun.created_at ||
    selectedReplacementWindowRun.run_started_at !== replacementRun.run_started_at ||
    selectedReplacementWindowRun.updated_at !== replacementRun.updated_at
  ) fail("replacement_window_invalid");

  const deploymentWindow =
    `${replacementUpdatedAt.canonical}..${currentStartedAt.canonical}`;
  const deploymentRuns = validateWorkflowRunListing(await githubJson(
    input.fetchImpl,
    `${base}/actions/workflows/${DEPLOYMENT_WORKFLOW_ID}/runs` +
      `?branch=main&event=workflow_dispatch&created=${encodeURIComponent(deploymentWindow)}` +
      "&per_page=100",
    token,
    input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
  ));
  const candidateRuns = deploymentRuns.filter((candidate) =>
    exactObject(candidate)?.head_sha === input.candidateSha);
  if (
    candidateRuns.length === 0 ||
    new Set(candidateRuns.map((candidate) => String(exactObject(candidate)?.id))).size
      !== candidateRuns.length
  ) fail("deployment_window_invalid");
  const safeFailedRunIds = [];
  const ambiguousRunIds = { fenced: [], active: [] };
  const failedRuns = { fenced: [], active: [] };
  const successful = { fenced: null, active: null };
  for (const candidate of candidateRuns) {
    const observed = exactObject(candidate);
    const runId = String(observed?.id ?? "");
    if (!RUN_ID.test(runId)) fail("deployment_window_invalid");
    const conclusion = observed?.conclusion;
    if (![
      "success",
      "failure",
      "cancelled",
      "timed_out",
    ].includes(conclusion)) {
      fail("deployment_window_invalid");
    }
    const phase = deploymentPhase(observed?.display_title, input.candidateSha);
    if (phase === null) fail("deployment_window_invalid");
    const validated = validateWorkflowRun(observed, {
      runId,
      candidateSha: input.candidateSha,
      workflowPath: DEPLOYMENT_WORKFLOW_PATH,
      workflowName: DEPLOYMENT_WORKFLOW_NAME,
      displayTitle: deploymentTitle(phase, input.candidateSha),
      status: "completed",
      conclusion,
      failureCode: "deployment_window_invalid",
    });
    const createdAt = githubTimestamp(validated.created_at, "deployment_window_invalid");
    const startedAt = githubTimestamp(
      validated.run_started_at,
      "deployment_window_invalid",
    );
    const updatedAt = githubTimestamp(validated.updated_at, "deployment_window_invalid");
    if (
      createdAt.milliseconds < replacementUpdatedAt.milliseconds ||
      startedAt.milliseconds < createdAt.milliseconds ||
      updatedAt.milliseconds <= startedAt.milliseconds ||
      updatedAt.milliseconds >= currentStartedAt.milliseconds
    ) fail("deployment_window_invalid");
    if (
      phase === "fenced" &&
      updatedAt.milliseconds >= deploymentStartedAt.milliseconds
    ) fail("deployment_window_invalid");
    if (
      phase === "active" &&
      startedAt.milliseconds <= fencedDeploymentUpdatedAt.milliseconds
    ) fail("deployment_window_invalid");
    if (conclusion === "success") {
      if (successful[phase] !== null) fail("deployment_window_invalid");
      successful[phase] = validated;
    } else {
      const jobs = await githubJson(
        input.fetchImpl,
        `${base}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
        token,
        input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      );
      const disposition = deploymentWriteDisposition(jobs, validated);
      if (disposition === "skipped") safeFailedRunIds.push(runId);
      else if (disposition === "may-have-written") {
        ambiguousRunIds[phase].push(runId);
      } else fail("deployment_window_invalid");
      failedRuns[phase].push(Object.freeze({
        id: runId,
        startedAtMs: startedAt.milliseconds,
        updatedAtMs: updatedAt.milliseconds,
      }));
    }
  }
  if (
    successful.fenced === null ||
    successful.active === null ||
    String(successful.fenced.id) !== input.fencedDeploymentRunId ||
    String(successful.active.id) !== input.deploymentRunId ||
    successful.fenced.created_at !== fencedDeploymentRun.created_at ||
    successful.fenced.run_started_at !==
      fencedDeploymentRun.run_started_at ||
    successful.fenced.updated_at !== fencedDeploymentRun.updated_at ||
    successful.active.created_at !== deploymentRun.created_at ||
    successful.active.run_started_at !== deploymentRun.run_started_at ||
    successful.active.updated_at !== deploymentRun.updated_at ||
    ambiguousRunIds.fenced.length > 1 ||
    ambiguousRunIds.active.length > 1
  ) fail("deployment_window_invalid");
  if (
    failedRuns.fenced.some((run) =>
      run.updatedAtMs >= fencedDeploymentStartedAt.milliseconds) ||
    failedRuns.active.some((run) =>
      run.startedAtMs <= fencedDeploymentUpdatedAt.milliseconds ||
      run.updatedAtMs >= deploymentStartedAt.milliseconds)
  ) fail("deployment_window_invalid");

  const fencedReceipt = validateDeploymentReceipt(
    input.fencedDeploymentReceipt,
    {
      phase: "fenced",
      candidateSha: input.candidateSha,
      runStartedAtMs: fencedDeploymentStartedAt.milliseconds,
      runUpdatedAtMs: fencedDeploymentUpdatedAt.milliseconds,
    },
  );
  const activeReceipt = validateDeploymentReceipt(input.deploymentReceipt, {
    phase: "active",
    candidateSha: input.candidateSha,
    runStartedAtMs: deploymentStartedAt.milliseconds,
    runUpdatedAtMs: deploymentUpdatedAt.milliseconds,
  });
  if (
    (fencedReceipt.outcome === "already_deployed") !==
      (ambiguousRunIds.fenced.length === 1) ||
    activeReceipt.outcome !== "already_deployed" ||
    activeReceipt.writeAttempts !== 0
  ) fail("deployment_window_invalid");

  const replacementArtifactName =
    `pintpath-permanent-staging-provider-mutation-supabase-key-replacement-${input.candidateSha}`;
  const replacementArtifact = validateArtifact(
    await githubJson(
      input.fetchImpl,
      `${base}/actions/runs/${input.replacementRunId}/artifacts` +
        `?name=${encodeURIComponent(replacementArtifactName)}&per_page=100`,
      token,
      input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
    {
      candidateSha: input.candidateSha,
      runId: input.replacementRunId,
      name: replacementArtifactName,
    },
  );
  const deploymentArtifactName =
    `pintpath-permanent-staging-deployment-${input.candidateSha}`;
  const deploymentArtifact = validateArtifact(
    await githubJson(
      input.fetchImpl,
      `${base}/actions/runs/${input.deploymentRunId}/artifacts` +
        `?name=${encodeURIComponent(deploymentArtifactName)}&per_page=100`,
      token,
      input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
    {
      candidateSha: input.candidateSha,
      runId: input.deploymentRunId,
      name: deploymentArtifactName,
    },
  );
  const fencedDeploymentArtifactName =
    `pintpath-permanent-staging-fenced-deployment-${input.candidateSha}`;
  const fencedDeploymentArtifact = validateArtifact(
    await githubJson(
      input.fetchImpl,
      `${base}/actions/runs/${input.fencedDeploymentRunId}/artifacts` +
        `?name=${encodeURIComponent(fencedDeploymentArtifactName)}&per_page=100`,
      token,
      input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
    {
      candidateSha: input.candidateSha,
      runId: input.fencedDeploymentRunId,
      name: fencedDeploymentArtifactName,
    },
  );

  return {
    schemaVersion: 2,
    kind: "pintpath-github-permanent-staging-deployment-authority",
    repository,
    candidateSha: input.candidateSha,
    consumerWorkflowPath: CUTOVER_WORKFLOW_PATH,
    consumerWorkflowRunId: currentRunId,
    consumerWorkflowRunStartedAt: currentStartedAt.canonical,
    replacementWorkflowPath: REPLACEMENT_WORKFLOW_PATH,
    replacementWorkflowRunId: input.replacementRunId,
    replacementWorkflowRunAttempt: 1,
    replacementWorkflowRunCreatedAt: replacementCreatedAt.canonical,
    replacementWorkflowRunStartedAt: replacementStartedAt.canonical,
    replacementWorkflowRunUpdatedAt: replacementUpdatedAt.canonical,
    replacementWorkflowEvent: "workflow_dispatch",
    replacementWorkflowConclusion: "success",
    replacementArtifactName: replacementArtifact.name,
    replacementArtifactId: String(replacementArtifact.id),
    replacementArtifactDigest: replacementArtifact.digest,
    replacementArtifactSizeBytes: replacementArtifact.size_in_bytes,
    replacementArtifactExpired: false,
    fencedDeploymentWorkflowRunId: input.fencedDeploymentRunId,
    fencedDeploymentWorkflowRunAttempt: 1,
    fencedDeploymentWorkflowRunStartedAt: fencedDeploymentStartedAt.canonical,
    fencedDeploymentWorkflowRunUpdatedAt: fencedDeploymentUpdatedAt.canonical,
    fencedDeploymentWorkflowEvent: "workflow_dispatch",
    fencedDeploymentWorkflowConclusion: "success",
    fencedDeploymentArtifactName: fencedDeploymentArtifact.name,
    fencedDeploymentArtifactId: String(fencedDeploymentArtifact.id),
    fencedDeploymentArtifactDigest: fencedDeploymentArtifact.digest,
    fencedDeploymentArtifactSizeBytes: fencedDeploymentArtifact.size_in_bytes,
    fencedDeploymentArtifactExpired: false,
    fencedDeploymentReceiptOutcome: fencedReceipt.outcome,
    deploymentWorkflowPath: DEPLOYMENT_WORKFLOW_PATH,
    deploymentWorkflowRunId: input.deploymentRunId,
    deploymentWorkflowRunAttempt: 1,
    deploymentWorkflowRunStartedAt: deploymentStartedAt.canonical,
    deploymentWorkflowRunUpdatedAt: deploymentUpdatedAt.canonical,
    deploymentWorkflowEvent: "workflow_dispatch",
    deploymentWorkflowConclusion: "success",
    deploymentArtifactName: deploymentArtifact.name,
    deploymentArtifactId: String(deploymentArtifact.id),
    deploymentArtifactDigest: deploymentArtifact.digest,
    deploymentArtifactSizeBytes: deploymentArtifact.size_in_bytes,
    deploymentArtifactExpired: false,
    deploymentReceiptOutcome: activeReceipt.outcome,
    replacementPrecedesDeployment: true,
    replacementPrecedesFencedDeployment: true,
    fencedDeploymentPrecedesActiveDeployment: true,
    deploymentPrecedesCutover: true,
    replacementWindowExact: true,
    deploymentWindowExact: true,
    failedBeforeWriteDeploymentRunIds: safeFailedRunIds.sort(
      (left, right) => Number(left) - Number(right),
    ),
    reconciledAmbiguousFencedDeploymentRunIds:
      ambiguousRunIds.fenced.sort((left, right) => Number(left) - Number(right)),
    reconciledAmbiguousActiveDeploymentRunIds:
      ambiguousRunIds.active.sort((left, right) => Number(left) - Number(right)),
  };
}

function assertOutputAbsent(filename) {
  try {
    fs.lstatSync(filename);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    fail("output_unsafe");
  }
  fail("output_collision");
}

function readDeploymentReceipt(filename) {
  let source;
  let value;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(
      readTrustedRegularFile(filename, {
        minBytes: 2,
        maxBytes: MAX_RECEIPT_BYTES,
        requirePrivate: true,
        requireOwner: true,
      }),
    );
    value = JSON.parse(source);
  } catch {
    fail("receipt_invalid");
  }
  if (
    exactObject(value) === null ||
    source !== `${JSON.stringify(value, null, 2)}\n`
  ) fail("receipt_invalid");
  return value;
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  holdDirectory: (directory) =>
    holdPrivateDirectoryIdentity(directory, {
      requireExactDirectoryMode: true,
      requireOwner: true,
    }),
  assertOutputAbsent,
  readReceipt: readDeploymentReceipt,
  writeFile: (directory, leaf, source, expectedDirectoryIdentity) =>
    writePrivateExclusiveFile(directory, leaf, source, {
      requireExactDirectoryMode: true,
      requireOwner: true,
      expectedDirectoryIdentity,
    }),
});

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  overrides = {},
) {
  const args = parseArgs(argv);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const parent = path.dirname(args.output);
  const heldDirectory = dependencies.holdDirectory(parent);
  let closed = false;
  try {
    heldDirectory.assertExact();
    dependencies.assertOutputAbsent(args.output);
    heldDirectory.assertExact();
    const fencedDeploymentReceipt = dependencies.readReceipt(
      args.fencedDeploymentReceipt,
    );
    const deploymentReceipt = dependencies.readReceipt(args.deploymentReceipt);
    heldDirectory.assertExact();
    const authority = await verifyGithubPermanentStagingDeployment({
      ...args,
      fencedDeploymentReceipt,
      deploymentReceipt,
      env,
      fetchImpl,
      requestTimeoutMs: dependencies.requestTimeoutMs,
    });
    heldDirectory.assertExact();
    const directoryIdentity = heldDirectory.identity;
    heldDirectory.close();
    closed = true;
    dependencies.writeFile(
      parent,
      path.basename(args.output),
      `${JSON.stringify(authority)}\n`,
      directoryIdentity,
    );
    return authority;
  } catch (error) {
    if (!closed) {
      try {
        heldDirectory.close();
      } catch {
        fail("output_unsafe");
      }
    }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
