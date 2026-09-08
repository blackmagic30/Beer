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

export const POST_Q_AUTHORITY_SCHEMA =
  "pintpath-permanent-staging-post-q-authority/v1";
export const POST_Q_REVIEWED_CANDIDATE_SCHEMA =
  "pintpath-permanent-staging-post-q-reviewed-candidate-authority/v1";

const RELEASE_POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.github/release-required-checks.json",
);

const REPOSITORY = "blackmagic30/Beer";
const REPOSITORY_ID = 1215862300;
const Q_RUN_ID = "34229745722";
const Q_WORKFLOW_ID = 344383802;
const Q_RUN_NUMBER = 13;
const Q_HEAD_SHA = "606d33facb515dd10bc94c360e43c20beb999cc1";
const CONTAINMENT_DIRECT_PARENT_SHA =
  "f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7";
const CONTAINMENT_RECOVERY_PARENT_TREE_SHA =
  "9978dca9491f7bf7bee77ce39debe1f713e89c53";
const CONTAINMENT_AUTHORITY_DEADLINE = "2026-09-08T18:57:20.000Z";
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
const CONTAINMENT_WRITER_STEP =
  "Stop the exact accidental staging deployment once";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HISTORY_PAGES = 10;
const TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

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

function parseArguments(argv) {
  if (argv.length !== 10) return null;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) return null;
    values.set(key, value);
  }
  const allowed = [
    "--candidate-sha",
    "--q-run-id",
    "--q-artifact-id",
    "--downloaded-dir",
    "--output-dir",
  ];
  if (values.size !== allowed.length || allowed.some((key) => !values.has(key))) {
    return null;
  }
  const candidateSha = values.get("--candidate-sha");
  const qRunId = values.get("--q-run-id");
  const qArtifactId = values.get("--q-artifact-id");
  const downloadedDirectory = values.get("--downloaded-dir");
  const outputDirectory = values.get("--output-dir");
  if (!SHA_PATTERN.test(candidateSha) || qRunId !== Q_RUN_ID ||
    qArtifactId !== Q_ARTIFACT_ID || !path.isAbsolute(downloadedDirectory) ||
    !path.isAbsolute(outputDirectory) ||
    path.resolve(downloadedDirectory) === path.resolve(outputDirectory) ||
    path.dirname(path.resolve(downloadedDirectory)) !==
      path.resolve(outputDirectory) ||
    path.basename(downloadedDirectory) !== "downloaded") return null;
  return {
    candidateSha,
    qRunId,
    qArtifactId,
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
  return boundedJson(response);
}

function currentContainmentRunExact(value, env, candidateSha) {
  return record(value) && value.id === Number(env.GITHUB_RUN_ID) &&
    value.workflow_id === CONTAINMENT_WORKFLOW_ID &&
    value.run_number === 2 &&
    value.run_attempt === 1 && containmentRunTitleExact(value, candidateSha) &&
    value.event === "workflow_dispatch" &&
    value.status === "in_progress" && value.conclusion === null &&
    value.head_branch === "main" && value.head_sha === candidateSha &&
    value.path === CONTAINMENT_WORKFLOW_PATH &&
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
  const rows = [];
  const ids = new Set();
  let total = null;
  for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
    const value = await githubGet(
      fetchImpl,
      env,
      `/repos/${REPOSITORY}/actions/workflows/` +
        `stop-permanent-staging-post-q-deployment.yml/runs` +
        `?event=workflow_dispatch&per_page=100&page=${page}`,
      true,
    );
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
    const value = await githubGet(
      fetchImpl,
      env,
      `/repos/${REPOSITORY}/actions/runs/${runId}/attempts/${runAttempt}/jobs` +
        `?filter=all&per_page=100&page=${page}`,
      true,
    );
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

function recoveryPrepareStepsExact(steps) {
  return Array.isArray(steps) &&
    steps.length === CONTAINMENT_RECOVERY_PREPARE_STEPS.length &&
    steps.every((step, index) => {
      const expected = CONTAINMENT_RECOVERY_PREPARE_STEPS[index];
      return record(step) && step.number === expected[0] &&
        step.name === expected[1] && step.status === "completed" &&
        step.conclusion === expected[2] && step.started_at === expected[3] &&
        step.completed_at === expected[4];
    });
}

function recoveryBridgeRunExact(run, jobs) {
  if (!record(run) || String(run.id) !== CONTAINMENT_RECOVERY_RUN_ID ||
    run.workflow_id !== CONTAINMENT_WORKFLOW_ID ||
    run.check_suite_id !== 92795131798 ||
    run.run_number !== CONTAINMENT_RECOVERY_RUN_NUMBER ||
    run.run_attempt !== 1 ||
    !containmentRunTitleExact(run, CONTAINMENT_DIRECT_PARENT_SHA) ||
    run.event !== "workflow_dispatch" || run.status !== "completed" ||
    run.conclusion !== "failure" || run.head_branch !== "main" ||
    run.head_sha !== CONTAINMENT_DIRECT_PARENT_SHA ||
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
    CONTAINMENT_DIRECT_PARENT_SHA,
  );
  return record(prepare) && prepare.name === CONTAINMENT_PREPARE_JOB &&
    prepare.run_id === Number(CONTAINMENT_RECOVERY_RUN_ID) &&
    prepare.run_attempt === 1 &&
    prepare.workflow_name === expectedWorkflowName &&
    prepare.head_sha === CONTAINMENT_DIRECT_PARENT_SHA &&
    prepare.status === "completed" && prepare.conclusion === "failure" &&
    prepare.created_at === "2026-09-08T17:07:50Z" &&
    prepare.started_at === "2026-09-08T17:07:53Z" &&
    prepare.completed_at === "2026-09-08T17:12:10Z" &&
    recoveryPrepareStepsExact(prepare.steps) && record(apply) &&
    apply.name === CONTAINMENT_APPLY_JOB &&
    apply.run_id === Number(CONTAINMENT_RECOVERY_RUN_ID) &&
    apply.run_attempt === 1 &&
    apply.workflow_name === expectedWorkflowName &&
    apply.head_sha === CONTAINMENT_DIRECT_PARENT_SHA &&
    apply.status === "completed" && apply.conclusion === "skipped" &&
    apply.created_at === "2026-09-08T17:12:11Z" &&
    apply.started_at === "2026-09-08T17:12:11Z" &&
    apply.completed_at === "2026-09-08T17:12:10Z" &&
    apply.steps.length === 0;
}

function currentWriterNotStarted(jobs) {
  if (jobs.length < 1 || jobs.length > 2 ||
    new Set(jobs.map((job) => job.name)).size !== jobs.length ||
    jobs.some((job) => ![CONTAINMENT_PREPARE_JOB, CONTAINMENT_APPLY_JOB]
      .includes(job.name)) ||
    !jobs.some((job) => job.name === CONTAINMENT_PREPARE_JOB)) return false;
  const prepare = jobs.find((job) => job.name === CONTAINMENT_PREPARE_JOB);
  if (!record(prepare)) return false;
  const apply = jobs.find((job) => job.name === CONTAINMENT_APPLY_JOB);
  if (prepare.status === "in_progress" && prepare.conclusion === null) {
    if (apply === undefined) return true;
    return apply.status === "queued" && apply.conclusion === null &&
      apply.started_at === null && apply.completed_at === null &&
      apply.steps.length === 0;
  }
  if (prepare.status !== "completed" || prepare.conclusion !== "success" ||
    !record(apply) || apply.status !== "in_progress" ||
    apply.conclusion !== null ||
    typeof apply.started_at !== "string" ||
    !Number.isFinite(Date.parse(apply.started_at)) ||
    apply.completed_at !== null) return false;
  const writers = apply.steps.filter((step) =>
    record(step) && step.name === CONTAINMENT_WRITER_STEP);
  if (writers.length !== 1) return false;
  const writer = writers[0];
  return writer.status === "pending" && writer.conclusion === null &&
    writer.started_at === null && writer.completed_at === null;
}

async function verifyContainmentSingleUseAuthority(
  fetchImpl,
  env,
  candidateSha,
  currentRun,
) {
  if (!currentContainmentRunExact(currentRun, env, candidateSha)) {
    fail("containment_history_invalid");
  }
  const [runs, recoveryRun, recoveryArtifacts, workflowMetadata] =
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
      `/repos/${REPOSITORY}/actions/workflows/${CONTAINMENT_WORKFLOW_ID}`,
    ),
  ]);
  if (runs.length !== 2 || !record(recoveryArtifacts) ||
    recoveryArtifacts.total_count !== 0 ||
    !Array.isArray(recoveryArtifacts.artifacts) ||
    recoveryArtifacts.artifacts.length !== 0 ||
    !containmentWorkflowMetadataExact(workflowMetadata)) {
    fail("containment_history_invalid");
  }
  const currentRows = runs.filter((run) =>
    String(run.id) === env.GITHUB_RUN_ID);
  const priorRows = runs.filter((run) =>
    String(run.id) !== env.GITHUB_RUN_ID);
  if (String(runs[0]?.id) !== env.GITHUB_RUN_ID ||
    String(runs[1]?.id) !== CONTAINMENT_RECOVERY_RUN_ID ||
    currentRows.length !== 1 ||
    !currentContainmentRunExact(currentRows[0], env, candidateSha) ||
    priorRows.length !== 1 ||
    String(priorRows[0].id) !== CONTAINMENT_RECOVERY_RUN_ID) {
    fail("containment_history_invalid");
  }
  const priorAttempts = [];
  let recoveryBridge = null;
  for (const run of runs) {
    if (String(run.id) === env.GITHUB_RUN_ID) continue;
    if (run.status !== "completed" || typeof run.conclusion !== "string") {
      fail("containment_authority_consumed");
    }
    for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
      const jobs = await completeAttemptJobs(
        fetchImpl,
        env,
        String(run.id),
        attempt,
      );
      if (!priorAttemptDefinitelySkipped(jobs)) {
        fail("containment_authority_consumed");
      }
      if (String(run.id) === CONTAINMENT_RECOVERY_RUN_ID) {
        if (recoveryBridge !== null ||
          !recoveryBridgeRunExact(run, jobs) ||
          !recoveryBridgeRunExact(recoveryRun, jobs)) {
          fail("containment_authority_consumed");
        }
        recoveryBridge = Object.freeze({
          runId: CONTAINMENT_RECOVERY_RUN_ID,
          runAttempt: 1,
          workflowId: CONTAINMENT_WORKFLOW_ID,
          workflowPath: CONTAINMENT_WORKFLOW_PATH,
          headSha: CONTAINMENT_DIRECT_PARENT_SHA,
          prepareJobId: CONTAINMENT_RECOVERY_PREPARE_JOB_ID,
          applyJobId: CONTAINMENT_RECOVERY_APPLY_JOB_ID,
          prepareFailedBeforeIntentExact: true,
          applyCompletedSkippedWithoutStepsExact: true,
          writerNeverExistedOrStartedExact: true,
          artifactsAbsentExact: true,
        });
      }
      priorAttempts.push({
        runId: String(run.id),
        runAttempt: attempt,
        headSha: run.head_sha,
        writerDisposition: "completed_skipped",
      });
    }
  }
  if (recoveryBridge === null) fail("containment_history_invalid");
  priorAttempts.sort((left, right) =>
    Number(left.runId) - Number(right.runId) ||
    left.runAttempt - right.runAttempt);
  const currentJobs = await completeAttemptJobs(
    fetchImpl,
    env,
    env.GITHUB_RUN_ID,
    1,
  );
  if (!currentWriterNotStarted(currentJobs)) {
    fail("containment_authority_consumed");
  }
  return Object.freeze({
    workflowPath: CONTAINMENT_WORKFLOW_PATH,
    workflowId: currentRun.workflow_id,
    runId: env.GITHUB_RUN_ID,
    runNumber: currentRun.run_number,
    runAttempt: 1,
    headSha: candidateSha,
    totalWorkflowDispatchRuns: runs.length,
    priorAttempts: Object.freeze(priorAttempts),
    recoveryBridge,
    workflowMetadataExact: true,
    currentWriterNotStartedExact: true,
    everyPriorWriterDefinitelySkippedExact: true,
    priorCompletedBeforeWriterRunsDoNotConsumeAuthority: true,
    allWorkflowRunPagesReadExact: true,
    allRunAttemptJobPagesReadExact: true,
    freshDispatchCannotRepeatWriteExact: true,
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
  const policy = parseGithubReleaseChecksPolicy(policySource);
  if (policy === null || policy.repository !== REPOSITORY ||
    policy.branch !== "main" || sha256(policySource) !== RELEASE_POLICY_SHA256 ||
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
  const currentStartedAt = Date.parse(String(currentRun.run_started_at));
  const mergedAt = Date.parse(String(reviewedPullRequest.mergedAt));
  const recoveryRunCompletedAt = Date.parse(
    CONTAINMENT_RECOVERY_RUN_COMPLETED_AT,
  );
  const deadline = Date.parse(CONTAINMENT_AUTHORITY_DEADLINE);
  if (!Number.isFinite(currentStartedAt) || !Number.isFinite(mergedAt) ||
    !Number.isFinite(recoveryRunCompletedAt) || !Number.isFinite(nowMs) ||
    !Number.isFinite(deadline) || mergedAt <= recoveryRunCompletedAt ||
    mergedAt > currentStartedAt || currentStartedAt - mergedAt > 7 * 24 * 60 * 60 * 1000 ||
    nowMs < currentStartedAt - 5 * 60 * 1000 || nowMs >= deadline ||
    currentStartedAt >= deadline) {
    fail("reviewed_candidate_invalid");
  }
  let candidateCommit;
  let recoveryParentCommit;
  let mainReference;
  try {
    [candidateCommit, recoveryParentCommit, mainReference] = await Promise.all([
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
        `/git/commits/${CONTAINMENT_DIRECT_PARENT_SHA}`,
      ),
      releaseGithubGet(fetchImpl, token, REPOSITORY, "/git/ref/heads/main"),
    ]);
  } catch {
    fail("reviewed_candidate_invalid");
  }
  if (!record(candidateCommit) || candidateCommit.sha !== candidateSha ||
    !record(candidateCommit.tree) ||
    candidateCommit.tree.sha !== reviewedPullRequest.treeSha ||
    !Array.isArray(candidateCommit.parents) || candidateCommit.parents.length !== 1 ||
    candidateCommit.parents[0]?.sha !== CONTAINMENT_DIRECT_PARENT_SHA ||
    !record(recoveryParentCommit) ||
    recoveryParentCommit.sha !== CONTAINMENT_DIRECT_PARENT_SHA ||
    !record(recoveryParentCommit.tree) ||
    recoveryParentCommit.tree.sha !== CONTAINMENT_RECOVERY_PARENT_TREE_SHA ||
    !Array.isArray(recoveryParentCommit.parents) ||
    recoveryParentCommit.parents.length !== 1 ||
    recoveryParentCommit.parents[0]?.sha !== Q_HEAD_SHA ||
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
    schemaVersion: POST_Q_REVIEWED_CANDIDATE_SCHEMA,
    repository: REPOSITORY,
    branch: "main",
    candidateSha,
    reviewedPullRequest,
    releasePolicySha256: sha256(policySource),
    directParentSha: CONTAINMENT_DIRECT_PARENT_SHA,
    recoveryBridge: {
      candidateSha: CONTAINMENT_DIRECT_PARENT_SHA,
      treeSha: CONTAINMENT_RECOVERY_PARENT_TREE_SHA,
      soleParentSha: Q_HEAD_SHA,
    },
    authorizationDeadline: CONTAINMENT_AUTHORITY_DEADLINE,
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
      recoveryBridgeExact: true,
      currentMainTipExact: true,
      noLaterMainDriftExact: true,
      baseRequiredCheckLineageExact: true,
      baseRequiredArtifactsExact: true,
      chronologyExact: true,
      candidateMaximumAgeHours: 168,
      fixedDeadlineExact: true,
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
    const source = fs.readFileSync(sourcePath);
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

export async function verifyPermanentStagingPostQAuthority(
  overrides = {},
) {
  const dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    fetchImpl: fetch,
    now: () => Date.now(),
    sealArtifact: sealPostQArtifact,
    verifyCandidate: verifyPostQReviewedCandidate,
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
    dependencies.now(),
  );
  const reviewedCandidate = await dependencies.verifyCandidate(
    dependencies.fetchImpl,
    dependencies.env.GITHUB_TOKEN,
    args.candidateSha,
    currentRun,
  );
  if (!record(reviewedCandidate) ||
    reviewedCandidate.schemaVersion !== POST_Q_REVIEWED_CANDIDATE_SCHEMA) {
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
  const authority = {
    schemaVersion: POST_Q_AUTHORITY_SCHEMA,
    operation: "post-q-deployment-stop-containment",
    repository: REPOSITORY,
    candidateSha: args.candidateSha,
    currentRunId: dependencies.env.GITHUB_RUN_ID,
    currentRunAttempt: 1,
    containment,
    failedQ: {
      runId: Q_RUN_ID,
      runAttempt: 1,
      workflowId: Q_WORKFLOW_ID,
      workflowPath: Q_WORKFLOW_PATH,
      headSha: Q_HEAD_SHA,
      conclusion: "failure",
      bridgeStepConclusion: "success",
      soleWriterStepConclusion: "failure",
      boundaryStepConclusion: "success",
      artifactUploadStepConclusion: "success",
      otherJobsSkipped: true,
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
      qSoleWriterDispositionExact: true,
      qArtifactMetadataExact: true,
      qFiveMemberCustodyExact: true,
      qRetryPreventedExact: true,
      containmentCurrentRunExact: true,
      containmentSingleUseHistoryExact: true,
      containmentSecondWritePreventedExact: true,
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
  verifyPermanentStagingPostQAuthority().catch((error) => {
    const message = error instanceof Error ? error.message : "post_q_authority_failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
