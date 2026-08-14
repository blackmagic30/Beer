import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.github/release-required-checks.json",
);
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TREE_SHA_PATTERN = /^[a-f0-9]{40}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RUN_URL_PATTERN =
  /^https:\/\/github\.com\/blackmagic30\/Beer\/actions\/runs\/([1-9][0-9]*)\/job\/[1-9][0-9]*$/;
const WORKFLOW_PATH_PATTERN =
  /^\.github\/workflows\/[a-z0-9][a-z0-9._-]*\.ya?ml$/;
const CHECK_EVENTS = new Set(["push", "workflow_dispatch"]);
const PHASES = Object.freeze([
  "staging",
  "production",
  "close",
  "activation",
  "promotion-recovery",
  "open",
  "release",
]);
const PRODUCTION_STAGES = Object.freeze([
  "deploy",
  "scale",
  "close",
  "activation",
  "promotion-recovery",
  "open",
]);
const PHASE_STAGE_COUNTS = Object.freeze({
  staging: 0,
  production: 0,
  close: 2,
  activation: 3,
  "promotion-recovery": 4,
  open: 5,
  release: 6,
});
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ASSOCIATED_PULL_PAGES = 10;
const MAX_REVIEW_PAGES = 10;
const MAX_MUTATION_HISTORY_PAGES = 10;
const MAX_STAGING_MUTATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STAGING_DEPLOYMENT_CHECK = "Deploy permanent staging";
const STAGING_SCALE_CHECK = "Scale 1→2, prove, and converge 2→1";
const EFFECTIVE_REVIEW_STATES = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "DISMISSED",
]);
const REVIEW_AUTHORITY_ASSOCIATIONS = new Set([
  "COLLABORATOR",
  "MEMBER",
  "OWNER",
]);
const REVIEW_AUTHORITY_PERMISSIONS = new Set([
  "write",
  "maintain",
  "admin",
]);
const REPOSITORY_PERMISSIONS = new Set([
  "none",
  "read",
  "triage",
  "write",
  "maintain",
  "admin",
]);
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const PROVIDER_MUTATION_WORKFLOW_PATH =
  ".github/workflows/permanent-staging-provider-mutation.yml";
const PROVIDER_MUTATION_WORKFLOW_ID =
  "permanent-staging-provider-mutation.yml";
const RUNTIME_VARIABLE_WORKFLOW_PATH =
  ".github/workflows/configure-runtime-variable.yml";
const RUNTIME_VARIABLE_WORKFLOW_ID = "configure-runtime-variable.yml";
const PROVIDER_MUTATION_JOB = "One atomic variable mutation";
const PROVIDER_MUTATION_STEP =
  "Execute exactly one reviewed atomic Railway mutation";
const PROVIDER_MUTATION_OPERATIONS = Object.freeze([
  "provider-google-maps-api-key",
  "provider-google-maps-map-id",
  "provider-google-places-api-key",
  "provider-openai-api-key",
  "supabase-key-replacement",
]);
const RUNTIME_VARIABLE_TARGETS = Object.freeze([
  "permanent-staging",
  "production",
]);
const RUNTIME_VARIABLE_NAMES = Object.freeze([
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

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key, index) => Object.keys(value)[index] === key)
  );
}

function safeName(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 160 &&
    !/[\r\n\0]/.test(value)
  );
}

function timestamp(value) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateGitCommit(value, expectedSha, requireLinearHistory) {
  if (
    value?.sha !== expectedSha ||
    typeof value?.tree?.sha !== "string" ||
    !TREE_SHA_PATTERN.test(value.tree.sha) ||
    !Array.isArray(value?.parents) ||
    (requireLinearHistory && value.parents.length !== 1) ||
    value.parents.some((parent) =>
      typeof parent?.sha !== "string" || !SHA_PATTERN.test(parent.sha))
  ) throw new Error("reviewed_pull_request_invalid");
  return Object.freeze({ sha: value.sha, treeSha: value.tree.sha });
}

export async function verifyReviewedPullRequest(
  fetchImpl,
  token,
  policy,
  candidateSha,
) {
  const associated = [];
  let associatedListingComplete = false;
  for (let page = 1; page <= MAX_ASSOCIATED_PULL_PAGES; page += 1) {
    const batch = await githubGet(
      fetchImpl,
      token,
      policy.repository,
      `/commits/${candidateSha}/pulls?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length > 100) {
      throw new Error("reviewed_pull_request_invalid");
    }
    associated.push(...batch);
    if (batch.length < 100) {
      associatedListingComplete = true;
      break;
    }
  }
  if (!associatedListingComplete || associated.length === 0) {
    throw new Error("reviewed_pull_request_invalid");
  }
  const matches = associated.filter((pull) =>
    positiveInteger(pull?.number) &&
    pull?.state === "closed" &&
    pull?.merge_commit_sha === candidateSha &&
    pull?.base?.ref === policy.branch &&
    pull?.base?.repo?.full_name === policy.repository &&
    pull?.head?.repo?.full_name === policy.repository
  );
  if (matches.length !== 1) throw new Error("reviewed_pull_request_invalid");

  const summary = matches[0];
  const pull = await githubGet(
    fetchImpl,
    token,
    policy.repository,
    `/pulls/${summary.number}`,
  );
  const mergedAtMs = timestamp(pull?.merged_at);
  if (
    pull?.number !== summary.number ||
    pull?.state !== "closed" ||
    pull?.merged !== true ||
    pull?.draft !== false ||
    pull?.merge_commit_sha !== candidateSha ||
    pull?.base?.ref !== policy.branch ||
    pull?.base?.repo?.full_name !== policy.repository ||
    pull?.head?.repo?.full_name !== policy.repository ||
    typeof pull?.head?.sha !== "string" ||
    !SHA_PATTERN.test(pull.head.sha) ||
    !positiveInteger(pull?.user?.id) ||
    !positiveInteger(pull?.merged_by?.id) ||
    mergedAtMs === null
  ) throw new Error("reviewed_pull_request_invalid");

  const reviewedPrHeadSha = pull.head.sha;
  const reviews = [];
  let reviewListingComplete = false;
  for (let page = 1; page <= MAX_REVIEW_PAGES; page += 1) {
    const batch = await githubGet(
      fetchImpl,
      token,
      policy.repository,
      `/pulls/${pull.number}/reviews?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length > 100) {
      throw new Error("reviewed_pull_request_invalid");
    }
    reviews.push(...batch);
    if (batch.length < 100) {
      reviewListingComplete = true;
      break;
    }
  }
  if (!reviewListingComplete || reviews.length === 0) {
    throw new Error("reviewed_pull_request_invalid");
  }
  const effectiveByReviewer = new Map();
  for (const review of reviews) {
    if (
      review?.commit_id !== reviewedPrHeadSha ||
      !EFFECTIVE_REVIEW_STATES.has(review?.state)
    ) continue;
    if (!REVIEW_AUTHORITY_ASSOCIATIONS.has(review?.author_association)) continue;
    const submittedAtMs = timestamp(review?.submitted_at);
    if (
      !positiveInteger(review?.id) ||
      !positiveInteger(review?.user?.id) ||
      typeof review?.user?.login !== "string" ||
      !GITHUB_LOGIN_PATTERN.test(review.user.login) ||
      submittedAtMs === null ||
      submittedAtMs > mergedAtMs
    ) throw new Error("reviewed_pull_request_invalid");
    const previous = effectiveByReviewer.get(review.user.id);
    if (
      previous === undefined ||
      submittedAtMs > previous.submittedAtMs ||
      (submittedAtMs === previous.submittedAtMs && review.id > previous.review.id)
    ) effectiveByReviewer.set(review.user.id, { review, submittedAtMs });
  }
  const effectiveApprovals = [...effectiveByReviewer.values()]
    .map((value) => value.review)
    .filter((review) =>
      review.state === "APPROVED" && review.user.id !== pull.user.id);
  if (effectiveApprovals.length === 0) {
    throw new Error("reviewed_pull_request_invalid");
  }
  const approvals = [];
  for (const approval of effectiveApprovals) {
    const authority = await githubGet(
      fetchImpl,
      token,
      policy.repository,
      `/collaborators/${encodeURIComponent(approval.user.login)}/permission`,
      { allowNotFound: true },
    );
    if (authority === null) continue;
    if (
      !REPOSITORY_PERMISSIONS.has(authority?.permission) ||
      authority?.user?.id !== approval.user.id ||
      authority?.user?.login !== approval.user.login
    ) throw new Error("reviewed_pull_request_invalid");
    if (REVIEW_AUTHORITY_PERMISSIONS.has(authority.permission)) {
      approvals.push(approval);
    }
  }
  if (approvals.length === 0) throw new Error("reviewed_pull_request_invalid");

  const candidateCommit = validateGitCommit(
    await githubGet(
      fetchImpl,
      token,
      policy.repository,
      `/git/commits/${candidateSha}`,
    ),
    candidateSha,
    true,
  );
  const reviewedCommit = validateGitCommit(
    await githubGet(
      fetchImpl,
      token,
      policy.repository,
      `/git/commits/${reviewedPrHeadSha}`,
    ),
    reviewedPrHeadSha,
    false,
  );
  if (candidateCommit.treeSha !== reviewedCommit.treeSha) {
    throw new Error("reviewed_pull_request_invalid");
  }

  const approvingReviewIds = [...new Set(approvals.map((review) => review.id))]
    .sort((left, right) => left - right);
  const approvingReviewerIds = [...new Set(approvals.map((review) => review.user.id))]
    .sort((left, right) => left - right);
  return Object.freeze({
    number: pull.number,
    reviewedPrHeadSha,
    mergeCommitSha: candidateSha,
    treeSha: candidateCommit.treeSha,
    mergedAt: pull.merged_at,
    authorId: pull.user.id,
    mergedById: pull.merged_by.id,
    approvingReviewIds,
    approvingReviewerIds,
    githubMergeExact: true,
    reviewedTreeExact: true,
    independentApprovalExact: true,
    linearHistoryExact: true,
  });
}

function checkRequirementExact(value, production) {
  const keys = production
    ? ["stage", "name", "workflowPath", "event"]
    : ["name", "workflowPath", "event"];
  return exactKeys(value, keys)
    && (!production || PRODUCTION_STAGES.includes(value.stage))
    && safeName(value.name)
    && typeof value.workflowPath === "string"
    && WORKFLOW_PATH_PATTERN.test(value.workflowPath)
    && CHECK_EVENTS.has(value.event);
}

function artifactRequirementExact(value, production) {
  const keys = production
    ? ["stage", "name", "producerCheck"]
    : ["name", "producerCheck"];
  return exactKeys(value, keys)
    && (!production || PRODUCTION_STAGES.includes(value.stage))
    && safeName(value.name)
    && safeName(value.producerCheck);
}

export function parseGithubReleaseChecksPolicy(source) {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source, "utf8") > 64 * 1024 ||
    source.includes("\0")
  ) return null;
  try {
    const value = JSON.parse(source);
    if (
      !exactKeys(value, [
        "schemaVersion",
        "repository",
        "branch",
        "phaseConsumers",
        "requiredChecks",
        "requiredArtifacts",
      ]) ||
      value.schemaVersion !== "pintpath-github-release-required-checks/v3" ||
      value.repository !== "blackmagic30/Beer" ||
      value.branch !== "main" ||
      !exactKeys(value.phaseConsumers, PHASES) ||
      !exactKeys(value.requiredChecks, ["base", "staging", "production"]) ||
      !exactKeys(value.requiredArtifacts, ["base", "staging", "production"])
    ) return null;
    for (const phase of PHASES) {
      const consumer = value.phaseConsumers[phase];
      if (
        !exactKeys(consumer, ["workflowPath", "event"]) ||
        !WORKFLOW_PATH_PATTERN.test(consumer.workflowPath) ||
        consumer.event !== "workflow_dispatch"
      ) return null;
    }
    for (const group of [value.requiredChecks.base, value.requiredChecks.staging]) {
      if (
        !Array.isArray(group) ||
        group.length === 0 ||
        group.length > 32 ||
        group.some((item) => !checkRequirementExact(item, false))
      ) return null;
    }
    if (
      !Array.isArray(value.requiredChecks.production) ||
      value.requiredChecks.production.length !== PRODUCTION_STAGES.length ||
      value.requiredChecks.production.some((item, index) =>
        !checkRequirementExact(item, true) || item.stage !== PRODUCTION_STAGES[index])
    ) return null;
    const checks = [
      ...value.requiredChecks.base,
      ...value.requiredChecks.staging,
      ...value.requiredChecks.production,
    ];
    const checkNames = checks.map((item) => item.name);
    if (new Set(checkNames).size !== checkNames.length) return null;
    for (const group of [value.requiredArtifacts.base, value.requiredArtifacts.staging]) {
      if (
        !Array.isArray(group) ||
        group.length === 0 ||
        group.length > 32 ||
        group.some((item) => !artifactRequirementExact(item, false))
      ) return null;
    }
    if (
      !Array.isArray(value.requiredArtifacts.production) ||
      value.requiredArtifacts.production.length !== PRODUCTION_STAGES.length ||
      value.requiredArtifacts.production.some((item, index) =>
        !artifactRequirementExact(item, true) || item.stage !== PRODUCTION_STAGES[index])
    ) return null;
    const artifactRequirements = [
      ...value.requiredArtifacts.base,
      ...value.requiredArtifacts.staging,
      ...value.requiredArtifacts.production,
    ];
    if (
      new Set(artifactRequirements.map((item) => item.name)).size
        !== artifactRequirements.length ||
      artifactRequirements.some((item) => !checkNames.includes(item.producerCheck)) ||
      value.requiredArtifacts.production.some((artifact, index) =>
        artifact.producerCheck !== value.requiredChecks.production[index].name)
    ) return null;
    return canonicalJson(value) === source ? Object.freeze(value) : null;
  } catch {
    return null;
  }
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) throw new Error("argument_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--candidate-sha", "--phase", "--output"].includes(name) ||
      values.has(name) ||
      typeof value !== "string" ||
      value.length === 0
    ) throw new Error("argument_invalid");
    values.set(name, value);
  }
  const candidateSha = values.get("--candidate-sha");
  const phase = values.get("--phase");
  const output = values.get("--output");
  if (
    !SHA_PATTERN.test(candidateSha) ||
    !PHASES.includes(phase) ||
    !path.isAbsolute(output)
  ) throw new Error("argument_invalid");
  return { candidateSha, phase, output };
}

function requirements(policy, phase, candidateSha) {
  const checks = [...policy.requiredChecks.base];
  const artifacts = [...policy.requiredArtifacts.base];
  if (phase !== "staging") {
    checks.push(...policy.requiredChecks.staging);
    artifacts.push(...policy.requiredArtifacts.staging);
  }
  const stageCount = PHASE_STAGE_COUNTS[phase];
  checks.push(...policy.requiredChecks.production.slice(0, stageCount));
  artifacts.push(...policy.requiredArtifacts.production.slice(0, stageCount));
  return {
    consumer: policy.phaseConsumers[phase],
    checks,
    artifacts: artifacts.map((item) => ({
      ...item,
      name: item.name.replaceAll("{candidateSha}", candidateSha),
    })),
    productionStages: PRODUCTION_STAGES.slice(0, stageCount),
  };
}

async function boundedJson(response) {
  if (!response.ok || !response.body) throw new Error("github_query_failed");
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("github_query_failed");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("github_query_failed");
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new Error("github_query_failed");
  }
}

export async function githubGet(
  fetchImpl,
  token,
  repository,
  endpoint,
  options = {},
) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}${endpoint}`,
    {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "pintpath-release-candidate-verifier/3",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (options.allowNotFound === true && response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  return boundedJson(response);
}

async function listMutationWorkflowRuns(
  fetchImpl,
  token,
  policy,
  workflowId,
  mergedAt,
  consumerStartedAt,
) {
  const runs = [];
  let totalCount = null;
  let complete = false;
  const range = `${mergedAt}..${consumerStartedAt}`;
  for (let page = 1; page <= MAX_MUTATION_HISTORY_PAGES; page += 1) {
    const listing = await githubGet(
      fetchImpl,
      token,
      policy.repository,
      `/actions/workflows/${workflowId}/runs` +
        `?branch=${encodeURIComponent(policy.branch)}` +
        `&event=workflow_dispatch&created=${encodeURIComponent(range)}` +
        `&per_page=100&page=${page}`,
    );
    if (
      !Number.isSafeInteger(listing?.total_count) ||
      listing.total_count < 0 ||
      listing.total_count > MAX_MUTATION_HISTORY_PAGES * 100 ||
      !Array.isArray(listing?.workflow_runs) ||
      listing.workflow_runs.length > 100 ||
      (totalCount !== null && listing.total_count !== totalCount)
    ) throw new Error("staging_mutation_history_invalid");
    totalCount = listing.total_count;
    runs.push(...listing.workflow_runs);
    if (listing.workflow_runs.length < 100) {
      complete = true;
      break;
    }
  }
  if (!complete || runs.length !== totalCount) {
    throw new Error("staging_mutation_history_invalid");
  }
  return runs;
}

function providerOperationForTitle(value, candidateSha) {
  for (const operation of PROVIDER_MUTATION_OPERATIONS) {
    if (
      value ===
        `Permanent staging provider mutation | ${operation} | ${candidateSha}`
    ) return operation;
  }
  return null;
}

function runtimeVariableTitle(value, candidateSha) {
  for (const target of RUNTIME_VARIABLE_TARGETS) {
    for (const variableName of RUNTIME_VARIABLE_NAMES) {
      if (
        value ===
          `Configure runtime variable | ${target} | ${variableName} | ${candidateSha}`
      ) return Object.freeze({ target, variableName });
    }
  }
  return null;
}

function validateMutationWorkflowRun(
  value,
  policy,
  candidateSha,
  workflowPath,
  displayTitle,
) {
  const createdAtMs = timestamp(value?.created_at);
  const startedAtMs = timestamp(value?.run_started_at);
  const updatedAtMs = timestamp(value?.updated_at);
  if (
    !Number.isSafeInteger(value?.id) ||
    value.id <= 0 ||
    value?.repository?.full_name !== policy.repository ||
    value?.head_repository?.full_name !== policy.repository ||
    value?.head_sha !== candidateSha ||
    value?.head_branch !== policy.branch ||
    (value?.path !== workflowPath && value?.path !== `${workflowPath}@main`) ||
    value?.event !== "workflow_dispatch" ||
    value?.display_title !== displayTitle ||
    value?.run_attempt !== 1 ||
    value?.status !== "completed" ||
    typeof value?.conclusion !== "string" ||
    createdAtMs === null ||
    startedAtMs === null ||
    updatedAtMs === null ||
    createdAtMs > startedAtMs ||
    startedAtMs >= updatedAtMs
  ) throw new Error("staging_mutation_history_invalid");
  return Object.freeze({ ...value, createdAtMs, startedAtMs, updatedAtMs });
}

async function providerFailureSkippedWrite(
  fetchImpl,
  token,
  policy,
  run,
) {
  if (!["failure", "cancelled", "timed_out"].includes(run.conclusion)) {
    return false;
  }
  const listing = await githubGet(
    fetchImpl,
    token,
    policy.repository,
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
    job?.name !== PROVIDER_MUTATION_JOB ||
    job?.status !== "completed" ||
    job?.conclusion !== run.conclusion ||
    !Array.isArray(job?.steps)
  ) return false;
  const mutationSteps = job.steps.filter((step) =>
    step?.name === PROVIDER_MUTATION_STEP);
  return mutationSteps.length === 1 &&
    mutationSteps[0]?.status === "completed" &&
    mutationSteps[0]?.conclusion === "skipped";
}

async function verifyStagingMutationClosure(input) {
  const mergedAtMs = timestamp(input.reviewedPullRequest.mergedAt);
  const deployStartedAtMs = timestamp(input.deployment.startedAt);
  const consumerStartedAtMs = timestamp(input.consumerStartedAt);
  if (
    mergedAtMs === null ||
    deployStartedAtMs === null ||
    consumerStartedAtMs === null ||
    deployStartedAtMs < mergedAtMs ||
    deployStartedAtMs - mergedAtMs > MAX_STAGING_MUTATION_WINDOW_MS
  ) throw new Error("staging_mutation_history_expired");

  const providerRuns = await listMutationWorkflowRuns(
    input.fetchImpl,
    input.token,
    input.policy,
    PROVIDER_MUTATION_WORKFLOW_ID,
    input.reviewedPullRequest.mergedAt,
    input.consumerStartedAt,
  );
  for (const observed of providerRuns.filter((run) =>
    run?.head_sha === input.candidateSha)) {
    const operation = providerOperationForTitle(
      observed?.display_title,
      input.candidateSha,
    );
    if (operation === null) throw new Error("staging_mutation_history_invalid");
    const run = validateMutationWorkflowRun(
      observed,
      input.policy,
      input.candidateSha,
      PROVIDER_MUTATION_WORKFLOW_PATH,
      `Permanent staging provider mutation | ${operation} | ${input.candidateSha}`,
    );
    if (
      run.createdAtMs < mergedAtMs ||
      run.createdAtMs > consumerStartedAtMs
    ) throw new Error("staging_mutation_history_invalid");
    if (
      run.conclusion !== "success" &&
      !await providerFailureSkippedWrite(
        input.fetchImpl,
        input.token,
        input.policy,
        run,
      )
    ) throw new Error("staging_mutation_history_invalid");
    if (run.updatedAtMs >= deployStartedAtMs) {
      throw new Error("staging_mutation_after_closeout_deployment");
    }
  }

  const runtimeRuns = await listMutationWorkflowRuns(
    input.fetchImpl,
    input.token,
    input.policy,
    RUNTIME_VARIABLE_WORKFLOW_ID,
    input.reviewedPullRequest.mergedAt,
    input.consumerStartedAt,
  );
  for (const observed of runtimeRuns.filter((run) =>
    run?.head_sha === input.candidateSha)) {
    const classified = runtimeVariableTitle(
      observed?.display_title,
      input.candidateSha,
    );
    if (classified === null) throw new Error("staging_mutation_history_invalid");
    if (classified.target !== "permanent-staging") continue;
    const run = validateMutationWorkflowRun(
      observed,
      input.policy,
      input.candidateSha,
      RUNTIME_VARIABLE_WORKFLOW_PATH,
      observed.display_title,
    );
    if (
      run.createdAtMs < mergedAtMs ||
      run.createdAtMs > consumerStartedAtMs
    ) throw new Error("staging_mutation_history_invalid");
    if (run.conclusion !== "success") {
      throw new Error("staging_mutation_history_invalid");
    }
    if (run.updatedAtMs >= deployStartedAtMs) {
      throw new Error("staging_mutation_after_closeout_deployment");
    }
  }
}

function selectCheckRunCandidates(value, requirement, candidateSha) {
  if (
    !exactKeys(value, ["total_count", "check_runs"]) ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0 ||
    value.total_count > 100 ||
    !Array.isArray(value.check_runs) ||
    value.check_runs.length !== value.total_count
  ) throw new Error("checks_invalid");
  const candidates = [];
  for (const run of value.check_runs) {
    if (
      run?.name !== requirement.name ||
      run?.head_sha !== candidateSha ||
      run?.status !== "completed" ||
      run?.conclusion !== "success"
    ) continue;
    const startedAtMs = timestamp(run.started_at);
    const completedAtMs = timestamp(run.completed_at);
    if (
      run.app?.slug !== "github-actions" ||
      typeof run.details_url !== "string" ||
      !RUN_URL_PATTERN.test(run.details_url) ||
      !Number.isSafeInteger(run.check_suite?.id) ||
      run.check_suite.id <= 0 ||
      startedAtMs === null ||
      completedAtMs === null ||
      completedAtMs <= startedAtMs
    ) throw new Error(`required_check_invalid:${requirement.name}`);
    const runId = Number(RUN_URL_PATTERN.exec(run.details_url)[1]);
    if (!Number.isSafeInteger(runId)) throw new Error("checks_invalid");
    candidates.push(Object.freeze({
      checkSuiteId: run.check_suite.id,
      name: requirement.name,
      runId,
      startedAt: run.started_at,
      startedAtMs,
      completedAt: run.completed_at,
      completedAtMs,
    }));
  }
  return candidates;
}

function validateWorkflowRun(value, candidate, requirement, policy, candidateSha) {
  const runStartedAtMs = timestamp(value?.run_started_at);
  if (
    value?.id !== candidate.runId ||
    value?.check_suite_id !== candidate.checkSuiteId ||
    value?.head_sha !== candidateSha ||
    value?.head_branch !== policy.branch ||
    value?.status !== "completed" ||
    value?.conclusion !== "success" ||
    value?.repository?.full_name !== policy.repository ||
    value?.head_repository?.full_name !== policy.repository
  ) throw new Error("workflow_run_invalid");
  if (value.path !== requirement.workflowPath || value.event !== requirement.event) {
    return null;
  }
  if (
    !Number.isSafeInteger(value?.workflow_id) ||
    value.workflow_id <= 0 ||
    value?.run_attempt !== 1 ||
    runStartedAtMs === null ||
    candidate.startedAtMs < runStartedAtMs
  ) throw new Error("workflow_run_invalid");
  return Object.freeze({
    ...(requirement.stage ? { stage: requirement.stage } : {}),
    name: requirement.name,
    runId: candidate.runId,
    checkSuiteId: candidate.checkSuiteId,
    workflowId: value.workflow_id,
    workflowPath: value.path,
    event: value.event,
    runAttempt: value.run_attempt,
    startedAt: candidate.startedAt,
    completedAt: candidate.completedAt,
  });
}

function validateCurrentConsumer(value, expected, policy, candidateSha, runId) {
  const runStartedAtMs = timestamp(value?.run_started_at);
  if (
    value?.id !== runId ||
    value?.head_sha !== candidateSha ||
    value?.head_branch !== policy.branch ||
    value?.status !== "in_progress" ||
    value?.conclusion !== null ||
    !Number.isSafeInteger(value?.workflow_id) ||
    value.workflow_id <= 0 ||
    value?.run_attempt !== 1 ||
    value?.repository?.full_name !== policy.repository ||
    value?.head_repository?.full_name !== policy.repository ||
    value?.path !== expected.workflowPath ||
    value?.event !== expected.event ||
    runStartedAtMs === null
  ) throw new Error("current_consumer_invalid");
  return Object.freeze({
    runId,
    workflowId: value.workflow_id,
    workflowPath: value.path,
    event: value.event,
    runAttempt: value.run_attempt,
    runStartedAt: value.run_started_at,
  });
}

function selectArtifact(value, requirement, candidateSha, runId, repository) {
  if (
    !exactKeys(value, ["total_count", "artifacts"]) ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0 ||
    value.total_count > 100 ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length !== value.total_count
  ) throw new Error("artifacts_invalid");
  const matches = value.artifacts.filter((item) => item?.name === requirement.name);
  if (matches.length !== 1) {
    throw new Error(`required_artifact_missing_or_duplicate:${requirement.name}`);
  }
  const artifact = matches[0];
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    artifact.expired !== false ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    typeof artifact.digest !== "string" ||
    !DIGEST_PATTERN.test(artifact.digest) ||
    artifact.workflow_run?.head_sha !== candidateSha ||
    artifact.workflow_run?.id !== runId ||
    artifact.archive_download_url
      !== `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`
  ) throw new Error(`required_artifact_invalid:${requirement.name}`);
  return Object.freeze({
    ...(requirement.stage ? { stage: requirement.stage } : {}),
    artifactId: artifact.id,
    name: artifact.name,
    digest: artifact.digest,
    sizeBytes: artifact.size_in_bytes,
    runId,
    producerCheck: requirement.producerCheck,
  });
}

function writeExclusive(filename, source) {
  const parent = path.dirname(filename);
  const parentStat = fs.lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (parentStat.mode & 0o777) !== 0o700 ||
    (typeof process.geteuid === "function" && parentStat.uid !== process.geteuid()) ||
    fs.realpathSync(parent) !== path.resolve(parent)
  ) throw new Error("output_unsafe");
  fs.writeFileSync(filename, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const fd = fs.openSync(filename, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parentFd = fs.openSync(parent, "r");
  try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
}

export async function runGithubReleaseCandidateVerification(argv, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const env = dependencies.env ?? process.env;
  const writeOutput = dependencies.writeOutput
    ?? ((value) => process.stdout.write(value));
  try {
    const args = parseArguments(argv);
    const policySource = fs.readFileSync(POLICY_PATH, "utf8");
    const policy = parseGithubReleaseChecksPolicy(policySource);
    if (!policy) throw new Error("policy_invalid");
    if (
      env.GITHUB_ACTIONS !== "true" ||
      env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_SHA !== args.candidateSha ||
      env.GITHUB_REPOSITORY !== policy.repository ||
      env.GITHUB_RUN_ATTEMPT !== "1" ||
      typeof env.GITHUB_RUN_ID !== "string" ||
      !POSITIVE_INTEGER_PATTERN.test(env.GITHUB_RUN_ID) ||
      typeof env.GITHUB_TOKEN !== "string" ||
      env.GITHUB_TOKEN.length < 16 ||
      /[\r\n\0]/.test(env.GITHUB_TOKEN)
    ) throw new Error("github_context_invalid");
    const currentRunId = Number(env.GITHUB_RUN_ID);
    if (!Number.isSafeInteger(currentRunId)) throw new Error("github_context_invalid");
    const required = requirements(policy, args.phase, args.candidateSha);
    const reviewedPullRequest = await verifyReviewedPullRequest(
      fetchImpl,
      env.GITHUB_TOKEN,
      policy,
      args.candidateSha,
    );
    const currentRun = await githubGet(
      fetchImpl,
      env.GITHUB_TOKEN,
      policy.repository,
      `/actions/runs/${currentRunId}`,
    );
    const consumer = validateCurrentConsumer(
      currentRun,
      required.consumer,
      policy,
      args.candidateSha,
      currentRunId,
    );
    const consumerStartedAtMs = timestamp(consumer.runStartedAt);
    const workflowRuns = new Map([[currentRunId, currentRun]]);
    const intendedByName = new Map();
    for (const requirement of required.checks) {
      const checksPayload = await githubGet(
        fetchImpl,
        env.GITHUB_TOKEN,
        policy.repository,
        `/commits/${args.candidateSha}/check-runs?filter=all&check_name=${encodeURIComponent(requirement.name)}&per_page=100`,
      );
      const candidates = selectCheckRunCandidates(
        checksPayload,
        requirement,
        args.candidateSha,
      );
      const intended = [];
      for (const candidate of candidates) {
        let run = workflowRuns.get(candidate.runId);
        if (run === undefined) {
          run = await githubGet(
            fetchImpl,
            env.GITHUB_TOKEN,
            policy.repository,
            `/actions/runs/${candidate.runId}`,
          );
          workflowRuns.set(candidate.runId, run);
        }
        const selected = validateWorkflowRun(
          run,
          candidate,
          requirement,
          policy,
          args.candidateSha,
        );
        if (selected) intended.push(selected);
      }
      if (
        requirement.name === STAGING_DEPLOYMENT_CHECK
          ? intended.length !== 2 ||
            new Set(intended.map((item) => item.runId)).size !== intended.length
          : intended.length !== 1
      ) {
        throw new Error(`required_check_invalid:${requirement.name}`);
      }
      intendedByName.set(requirement.name, intended);
    }
    const stagingDeployments = intendedByName.get(STAGING_DEPLOYMENT_CHECK);
    if (stagingDeployments !== undefined) {
      const stagingScales = intendedByName.get(STAGING_SCALE_CHECK);
      if (!stagingScales || stagingScales.length !== 1) {
        throw new Error(`required_check_invalid:${STAGING_DEPLOYMENT_CHECK}:scale_missing`);
      }
      const scaleStartedAtMs = timestamp(stagingScales[0].startedAt);
      if (
        scaleStartedAtMs === null ||
        stagingDeployments.some((item) => timestamp(item.completedAt) >= scaleStartedAtMs)
      ) throw new Error(`required_check_invalid:${STAGING_DEPLOYMENT_CHECK}:chronology`);
      const ordered = [...stagingDeployments].sort((left, right) =>
        timestamp(left.completedAt) - timestamp(right.completedAt));
      if (
        ordered.length !== 2 ||
        timestamp(ordered[0].completedAt) === timestamp(ordered[1].completedAt) ||
        timestamp(ordered[0].completedAt) >= timestamp(ordered[1].startedAt)
      ) throw new Error(`required_check_invalid:${STAGING_DEPLOYMENT_CHECK}:ambiguous`);
      await verifyStagingMutationClosure({
        fetchImpl,
        token: env.GITHUB_TOKEN,
        policy,
        candidateSha: args.candidateSha,
        reviewedPullRequest,
        deployment: ordered[1],
        consumerStartedAt: consumer.runStartedAt,
      });
      intendedByName.set(STAGING_DEPLOYMENT_CHECK, [ordered[1]]);
    }
    const checks = required.checks.map((requirement) => {
      const intended = intendedByName.get(requirement.name);
      if (!intended || intended.length !== 1) {
        throw new Error(`required_check_invalid:${requirement.name}`);
      }
      return intended[0];
    });
    if (
      consumerStartedAtMs === null ||
      checks.some((check) => timestamp(check.completedAt) >= consumerStartedAtMs)
    ) throw new Error("chronology_invalid");
    const checkByName = new Map(checks.map((check) => [check.name, check]));
    const artifactPayloadByRun = new Map();
    const artifacts = [];
    for (const requirement of required.artifacts) {
      const producer = checkByName.get(requirement.producerCheck);
      if (!producer) throw new Error("artifact_producer_invalid");
      let payload = artifactPayloadByRun.get(producer.runId);
      if (payload === undefined) {
        payload = await githubGet(
          fetchImpl,
          env.GITHUB_TOKEN,
          policy.repository,
          `/actions/runs/${producer.runId}/artifacts?per_page=100`,
        );
        artifactPayloadByRun.set(producer.runId, payload);
      }
      artifacts.push(selectArtifact(
        payload,
        requirement,
        args.candidateSha,
        producer.runId,
        policy.repository,
      ));
    }
    const productionChain = required.productionStages.map((stage) => {
      const check = checks.find((item) => item.stage === stage);
      const artifact = artifacts.find((item) => item.stage === stage);
      if (!check || !artifact || check.runId !== artifact.runId) {
        throw new Error("production_chain_invalid");
      }
      return Object.freeze({ ...check, artifact });
    });
    for (let index = 1; index < productionChain.length; index += 1) {
      if (
        timestamp(productionChain[index - 1].completedAt)
          >= timestamp(productionChain[index].startedAt)
      ) throw new Error("chronology_invalid");
    }
    const orderedProductionChainSha256 = sha256(canonicalJson(productionChain));
    const receipt = Object.freeze({
      schemaVersion: "pintpath-github-release-candidate-receipt/v4",
      repository: policy.repository,
      branch: policy.branch,
      phase: args.phase,
      candidateSha: args.candidateSha,
      reviewedPullRequest,
      policySha256: sha256(policySource),
      consumer,
      checks,
      artifacts,
      productionChain,
      orderedProductionChainSha256,
      requiredChecksExact: true,
      requiredArtifactsExact: true,
      chronologyExact: true,
      currentConsumerExact: true,
    });
    const source = canonicalJson(receipt);
    writeExclusive(args.output, source);
    writeOutput(`${JSON.stringify({
      candidateSha: args.candidateSha,
      command: "verify-github-release-candidate",
      ok: true,
      phase: args.phase,
      reviewedPrHeadSha: reviewedPullRequest.reviewedPrHeadSha,
      orderedProductionChainSha256,
      receiptSha256: sha256(source),
    })}\n`);
    return 0;
  } catch (error) {
    const failureCode = error instanceof Error
      ? error.message.split(":", 1)[0]
      : "unexpected_failure";
    writeOutput(`${JSON.stringify({
      command: "verify-github-release-candidate",
      failureCode,
      ok: false,
    })}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runGithubReleaseCandidateVerification(process.argv.slice(2));
}
