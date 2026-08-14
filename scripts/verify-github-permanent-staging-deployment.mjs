import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  holdPrivateDirectoryIdentity,
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
const DEPLOYMENT_WORKFLOW_PATH =
  ".github/workflows/deploy-permanent-staging.yml";
const DEPLOYMENT_WORKFLOW_ID = "deploy-permanent-staging.yml";
const DEPLOYMENT_JOB_NAME = "Deploy permanent staging";
const DEPLOYMENT_MUTATION_STEP =
  "Execute one permanent-staging source upload and reconcile it";
const CUTOVER_WORKFLOW_PATH =
  ".github/workflows/permanent-staging-supabase-legacy-cutover.yml";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

function fail(code) {
  throw new Error(`github_permanent_staging_deployment_${code}`);
}

function parseArgs(argv) {
  if (argv.length !== 8) fail("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      ![
        "--candidate-sha",
        "--replacement-run-id",
        "--deployment-run-id",
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
  const deploymentRunId = values.get("--deployment-run-id") ?? "";
  const output = values.get("--output") ?? "";
  if (
    !SHA.test(candidateSha) ||
    !RUN_ID.test(replacementRunId) ||
    !RUN_ID.test(deploymentRunId) ||
    replacementRunId === deploymentRunId ||
    !path.isAbsolute(output) ||
    path.resolve(output) !== output ||
    output.includes("\0") ||
    path.basename(output) !== "deployment-github-authority.json"
  )
    fail("arguments_invalid");
  return { candidateSha, replacementRunId, deploymentRunId, output };
}

function exactObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
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
    run.conclusion !== expected.conclusion
  )
    fail(expected.failureCode);
  return run;
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

function failedBeforeWriteExact(value, runId) {
  const listing = exactObject(value);
  const jobs = Array.isArray(listing?.jobs) ? listing.jobs : [];
  if (listing?.total_count !== 1 || jobs.length !== 1) return false;
  const job = exactObject(jobs[0]);
  if (
    !job ||
    String(job.run_id) !== runId ||
    job.run_attempt !== 1 ||
    job.name !== DEPLOYMENT_JOB_NAME ||
    job.status !== "completed" ||
    job.conclusion !== "failure" ||
    !Array.isArray(job.steps)
  ) return false;
  const mutationSteps = job.steps.filter((candidate) =>
    exactObject(candidate)?.name === DEPLOYMENT_MUTATION_STEP);
  if (mutationSteps.length !== 1) return false;
  const mutation = exactObject(mutationSteps[0]);
  return mutation?.status === "completed" && mutation.conclusion === "skipped";
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
      status: "in_progress",
      conclusion: null,
      failureCode: "consumer_run_invalid",
    },
  );
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
      status: "completed",
      conclusion: "success",
      failureCode: "deployment_run_invalid",
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
  if (
    replacementCreatedAt.milliseconds > replacementStartedAt.milliseconds ||
    replacementUpdatedAt.milliseconds <= replacementStartedAt.milliseconds ||
    replacementUpdatedAt.milliseconds >= deploymentStartedAt.milliseconds ||
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
      status: "completed",
      conclusion: "success",
      failureCode: "replacement_window_invalid",
    },
  );
  if (
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
  let selectedWindowRun = null;
  for (const candidate of candidateRuns) {
    const observed = exactObject(candidate);
    const runId = String(observed?.id ?? "");
    if (!RUN_ID.test(runId)) fail("deployment_window_invalid");
    const conclusion = observed?.conclusion;
    if (conclusion !== "success" && conclusion !== "failure") {
      fail("deployment_window_invalid");
    }
    const validated = validateWorkflowRun(observed, {
      runId,
      candidateSha: input.candidateSha,
      workflowPath: DEPLOYMENT_WORKFLOW_PATH,
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
    if (conclusion === "success") {
      if (runId !== input.deploymentRunId || selectedWindowRun !== null) {
        fail("deployment_window_invalid");
      }
      selectedWindowRun = validated;
      if (
        validated.run_started_at !== deploymentRun.run_started_at ||
        validated.updated_at !== deploymentRun.updated_at
      ) fail("deployment_window_invalid");
    } else {
      const jobs = await githubJson(
        input.fetchImpl,
        `${base}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
        token,
        input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      );
      if (!failedBeforeWriteExact(jobs, runId)) fail("deployment_window_invalid");
      safeFailedRunIds.push(runId);
    }
  }
  if (selectedWindowRun === null) fail("deployment_window_invalid");

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

  return {
    schemaVersion: 1,
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
    replacementPrecedesDeployment: true,
    deploymentPrecedesCutover: true,
    replacementWindowExact: true,
    deploymentWindowExact: true,
    failedBeforeWriteDeploymentRunIds: safeFailedRunIds,
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

const DEFAULT_DEPENDENCIES = Object.freeze({
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  holdDirectory: (directory) =>
    holdPrivateDirectoryIdentity(directory, {
      requireExactDirectoryMode: true,
      requireOwner: true,
    }),
  assertOutputAbsent,
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
    const authority = await verifyGithubPermanentStagingDeployment({
      ...args,
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
