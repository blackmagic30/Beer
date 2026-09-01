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
const MAX_MUTATION_HISTORY_PAGES = 10;
const MAX_STAGING_MUTATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RUNNER_LOSS_RECOVERY_GRACE_MS = 24 * 60 * 60 * 1000;
const STAGING_DEPLOYMENT_CHECK = "Deploy permanent staging";
const STAGING_VENUE_DIRECTORY_CHECK =
  "Apply and prove permanent-staging venue directory";
const STAGING_SCALE_CHECK = "Scale 1→2, prove, and converge 2→1";
const PROVIDER_MUTATION_WORKFLOW_PATH =
  ".github/workflows/permanent-staging-provider-mutation.yml";
const PROVIDER_MUTATION_WORKFLOW_ID =
  "permanent-staging-provider-mutation.yml";
const RUNTIME_VARIABLE_WORKFLOW_PATH =
  ".github/workflows/configure-runtime-variable.yml";
const RUNTIME_VARIABLE_WORKFLOW_ID = "configure-runtime-variable.yml";
const WORKER_FENCE_WORKFLOW_PATH =
  ".github/workflows/configure-automatic-maintenance-worker-fence.yml";
const WORKER_FENCE_WORKFLOW_ID =
  "configure-automatic-maintenance-worker-fence.yml";
const STAGING_BOOTSTRAP_WORKFLOW_PATH =
  ".github/workflows/bootstrap-permanent-staging-worker-fence.yml";
const STAGING_BOOTSTRAP_WORKFLOW_ID =
  "bootstrap-permanent-staging-worker-fence.yml";
const COLD_RECOVERY_WORKFLOW_PATH =
  ".github/workflows/recover-permanent-staging-cold-zero.yml";
const COLD_RECOVERY_WORKFLOW_ID =
  "recover-permanent-staging-cold-zero.yml";
const STAGING_VENUE_DIRECTORY_WORKFLOW_PATH =
  ".github/workflows/permanent-staging-venue-directory.yml";
const STAGING_VENUE_DIRECTORY_WORKFLOW_ID =
  "permanent-staging-venue-directory.yml";
const COLD_RECOVERY_JOBS = Object.freeze({
  prepare: Object.freeze({
    jobName: "Bind the exact replacement and prepare the dead baseline",
    writeStep: "Prepare the exact dead staging baseline once",
  }),
  "reconcile-prepare": Object.freeze({
    jobName: "Reconcile an ambiguous cold prepare at the exact dead baseline",
    writeStep: null,
    proofStep: "Prove the lost prepare acknowledgement without another write",
  }),
  quiesce: Object.freeze({
    jobName: "Initialize the exact dead baseline at explicit zero",
    writeStep: "Initialize the dead baseline from null to explicit zero once",
  }),
  "reconcile-quiesce": Object.freeze({
    jobName: "Reconcile an ambiguous cold quiesce at exact zero",
    writeStep: null,
    proofStep:
      "Prove the ambiguous cold quiesce reached exact zero without a second write",
  }),
});
const STAGING_WORKER_JOBS = Object.freeze({
  configure: Object.freeze({
    jobName: "One candidate-bound automatic-maintenance transition",
    writeStep: "Execute at most one exact atomic Railway variable upsert",
    proofStep: null,
  }),
  "reconcile-activate": Object.freeze({
    jobName: "Reconcile an ambiguous staging automatic-maintenance activation",
    writeStep: null,
    proofStep: "Prove the lost activation acknowledgement without another write",
  }),
});
const STAGING_BOOTSTRAP_JOBS = Object.freeze({
  bootstrap: Object.freeze({
    jobName: "Verify the chain and perform one exact protected scale transition",
    writeStep: "Perform at most one exact candidate-bound scale transition",
    proofStep: null,
  }),
  "reconcile-restore": Object.freeze({
    jobName: "Reconcile an ambiguous staging bootstrap restore at exact one",
    writeStep: null,
    proofStep:
      "Prove the ambiguous restore reached exact one without a second write",
  }),
});
const PROVIDER_MUTATION_JOB = "One protected variable mutation plan";
const PROVIDER_MUTATION_STEP =
  "Execute one reviewed protected Railway mutation plan";
const PROVIDER_MUTATION_OPERATIONS = Object.freeze([
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
const CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION =
  "reconcile-completed-forbidden-offsite-backup-deletion";
const CLEANUP_SUCCESSOR_CLOSEOUT_ORIGINAL_CANDIDATE_SHA =
  "0eadad05ce6c313ed3c12492d3095609ce5872d5";
const CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_SHA =
  "d939a77d0950b27466f3b9ecd26643a2416059a7";
const CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_TREE_SHA =
  "83b0b51efd2cf0ac5c2299c6cfd4c919d1973aff";
const CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_MERGED_AT =
  "2026-08-29T11:16:02Z";
const CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_PULL_REQUEST_NUMBER = 72;
const CLEANUP_SUCCESSOR_CLOSEOUT_RUN_ID = 33249810569;
const CLEANUP_SUCCESSOR_CLOSEOUT_RUN_CREATED_AT =
  "2026-08-29T11:18:12Z";
const CLEANUP_SUCCESSOR_CLOSEOUT_RUN_COMPLETED_AT =
  "2026-08-29T11:22:43Z";
const CLEANUP_SUCCESSOR_CLOSEOUT_ARTIFACT_ID = 9714046913;
const CLEANUP_SUCCESSOR_CLOSEOUT_ARTIFACT_NAME =
  "pintpath-permanent-staging-provider-mutation-reconcile-completed-forbidden-offsite-backup-deletion-d939a77d0950b27466f3b9ecd26643a2416059a7";
const CLEANUP_SUCCESSOR_CLOSEOUT_ARTIFACT_DIGEST =
  "sha256:625fca28703f9c4c7897c6d52a3e54cef8caee6e68f66c3b26a1565d7e4f655d";
const CLEANUP_SUCCESSOR_CLOSEOUT_ARTIFACT_BYTES = 2583;
const CLEANUP_SUCCESSOR_CLOSEOUT_ARTIFACT_CREATED_AT =
  "2026-08-29T11:22:39Z";
const CLEANUP_SUCCESSOR_CLOSEOUT_ARTIFACT_EXPIRES_AT =
  "2026-09-28T11:22:38Z";
const CLEANUP_SUCCESSOR_CLOSEOUT_EVIDENCE_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../docs/incident-evidence/permanent-staging-cleanup-closeout-2026-08-29",
);
const CLEANUP_SUCCESSOR_CLOSEOUT_ATTESTATION_SHA256 =
  "2f7f0204e4962f33d87d59b09da5a81ee76d343b8d23a48947547ed1099f0a64";
const CLEANUP_SUCCESSOR_CLOSEOUT_RETAINED_EVIDENCE = Object.freeze([
  Object.freeze({
    leaf: "intent.json",
    sha256:
      "2f4aae0e84f714d0b9a1a9129d45f169270cdbde387a310fc323c248603aa180",
    sizeInBytes: 2443,
  }),
  Object.freeze({
    leaf: "dispatch.json",
    sha256:
      "4ac26e99c3d94d303c3c08f85f1a258e562d79f5e1edbec3100851a57db4844e",
    sizeInBytes: 233,
  }),
  Object.freeze({
    leaf: "terminal.json",
    sha256:
      "4d73f8a8455ed08d6538962c91718cc04259122550a1d0ee1ca9461aa4f8efd3",
    sizeInBytes: 1842,
  }),
]);
const CLEANUP_SUCCESSOR_CLOSEOUT_STEP =
  "Reconcile the completed cleanup with metadata only";
const PROVIDER_BOUNDARY_STEP =
  "Reconcile the Railway mutation boundary after every attempt";
const PROVIDER_EVIDENCE_UPLOAD_STEP =
  "Upload secret-free terminal evidence";
const INCIDENT_MASKED_CLEANUP_CANCEL_DEADLINE_MS =
  Date.parse("2026-08-29T10:51:43Z");
const RUNTIME_VARIABLE_TARGETS = Object.freeze([
  "permanent-staging",
  "permanent-staging-postgres",
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
  "PINTPATH_RUNTIME_DATABASE_URL",
]);

function runtimeVariableCombinationExact(target, variableName) {
  return target === "permanent-staging-postgres"
    ? variableName === "PINTPATH_RUNTIME_DATABASE_URL"
    : (target === "permanent-staging" || target === "production") &&
      variableName !== "PINTPATH_RUNTIME_DATABASE_URL" &&
      RUNTIME_VARIABLE_NAMES.includes(variableName);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sameHeldFileSnapshot(left, right) {
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

export function readHeldPinnedEvidenceFile(filename, maximumBytes) {
  if (
    typeof filename !== "string" ||
    !path.isAbsolute(filename) ||
    path.resolve(filename) !== filename ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    typeof fs.constants.O_NOFOLLOW !== "number" ||
    fs.constants.O_NOFOLLOW <= 0 ||
    typeof fs.constants.O_NONBLOCK !== "number" ||
    fs.constants.O_NONBLOCK <= 0
  ) throw new Error("invalid");
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      filename,
      fs.constants.O_RDONLY |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.size < 0n ||
      before.size > BigInt(maximumBytes)
    ) throw new Error("invalid");
    const bytes = Buffer.alloc(Number(before.size));
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
        throw new Error("invalid");
      }
      offset += count;
    }
    const overflow = Buffer.alloc(1);
    if (fs.readSync(descriptor, overflow, 0, 1, offset) !== 0) {
      throw new Error("invalid");
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameHeldFileSnapshot(before, after)) throw new Error("invalid");
    return bytes;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
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
    timestamp(pull?.merged_at) === null
  ) throw new Error("reviewed_pull_request_invalid");

  const reviewedPrHeadSha = pull.head.sha;
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

  return Object.freeze({
    number: pull.number,
    reviewedPrHeadSha,
    mergeCommitSha: candidateSha,
    treeSha: candidateCommit.treeSha,
    mergedAt: pull.merged_at,
    authorId: pull.user.id,
    mergedById: pull.merged_by.id,
    githubMergeExact: true,
    reviewedTreeExact: true,
    pullRequestApprovalRequirement: "not_required",
    pullRequestApprovalRequirementExact: true,
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
        "User-Agent": "pintpath-release-candidate-verifier/5",
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
      if (!runtimeVariableCombinationExact(target, variableName)) continue;
      if (
        value ===
          `Configure runtime variable | ${target} | ${variableName} | ${candidateSha}`
      ) return Object.freeze({ target, variableName });
    }
  }
  return null;
}

function stagingWorkerOperationForTitle(value, candidateSha) {
  for (const operation of ["prepare", "activate", "reconcile-activate"]) {
    if (
      value ===
        `Automatic maintenance worker fence | permanent-staging | ${operation} | ${candidateSha}`
    ) return operation;
  }
  return null;
}

function stagingBootstrapOperationForTitle(value, candidateSha) {
  for (const operation of ["quiesce", "restore", "reconcile-restore"]) {
    if (
      value ===
        `Permanent staging worker bootstrap | ${operation} | ${candidateSha}`
    ) return operation;
  }
  return null;
}

function coldRecoveryOperationForTitle(value, candidateSha) {
  for (const operation of [
    "prepare",
    "reconcile-prepare",
    "quiesce",
    "reconcile-quiesce",
  ]) {
    if (
      value ===
        `Permanent staging cold recovery | ${operation} | ${candidateSha}`
    ) return operation;
  }
  return null;
}

async function workflowJobDisposition(
  fetchImpl,
  token,
  policy,
  run,
  jobs,
  selectedJobKey,
  expectedKind,
) {
  const configuration = jobs[selectedJobKey];
  if (
    !configuration ||
    (expectedKind === "write" && (
      !configuration.writeStep ||
      !["failure", "cancelled", "timed_out"].includes(run.conclusion)
    )) ||
    (expectedKind === "reconcile" && (
      !configuration.proofStep || run.conclusion !== "success"
    )) ||
    (expectedKind === "reconcile-retry" && (
      !configuration.proofStep ||
      !["failure", "cancelled", "timed_out"].includes(run.conclusion)
    ))
  ) return "invalid";
  const listing = await githubGet(
    fetchImpl,
    token,
    policy.repository,
    `/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
  );
  const jobNames = Object.values(jobs).map((item) => item.jobName);
  if (
    listing?.total_count !== jobNames.length ||
    !Array.isArray(listing?.jobs) ||
    listing.jobs.length !== jobNames.length ||
    new Set(listing.jobs.map((job) => job?.name)).size !== jobNames.length ||
    jobNames.some((name) => !listing.jobs.some((job) => job?.name === name))
  ) return "invalid";
  const selected = listing.jobs.find((job) =>
    job?.name === configuration.jobName);
  if (
    selected?.run_id !== run.id ||
    selected?.run_attempt !== 1 ||
    selected?.status !== "completed" ||
    selected?.conclusion !== run.conclusion ||
    !Array.isArray(selected?.steps) ||
    listing.jobs.some((job) => job !== selected && (
      job?.run_id !== run.id ||
      job?.run_attempt !== 1 ||
      job?.status !== "completed" ||
      job?.conclusion !== "skipped"
    ))
  ) return "invalid";
  if (expectedKind === "reconcile-retry") return "read-only-retry";
  const expectedStep = expectedKind === "write"
    ? configuration.writeStep
    : configuration.proofStep;
  const writeSteps = selected.steps.filter((step) =>
    step?.name === expectedStep);
  if (
    writeSteps.length !== 1 ||
    writeSteps[0]?.status !== "completed"
  ) return "invalid";
  if (expectedKind === "reconcile") {
    return writeSteps[0]?.conclusion === "success"
      ? "read-only-reconciled"
      : "invalid";
  }
  if (writeSteps[0]?.conclusion === "skipped") return "skipped";
  return ["success", "failure", "cancelled", "timed_out"].includes(
    writeSteps[0]?.conclusion,
  ) ? "may-have-written" : "invalid";
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

async function providerWriteDisposition(
  fetchImpl,
  token,
  policy,
  run,
) {
  if (!["failure", "cancelled", "timed_out"].includes(run.conclusion)) {
    return "invalid";
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
  ) return "invalid";
  const job = listing.jobs[0];
  if (
    job?.run_id !== run.id ||
    job?.run_attempt !== 1 ||
    job?.name !== PROVIDER_MUTATION_JOB ||
    job?.status !== "completed" ||
    job?.conclusion !== run.conclusion ||
    !Array.isArray(job?.steps)
  ) return "invalid";
  const mutationSteps = job.steps.filter((step) =>
    step?.name === PROVIDER_MUTATION_STEP);
  if (mutationSteps.length !== 1 ||
    mutationSteps[0]?.status !== "completed") return "invalid";
  if (mutationSteps[0]?.conclusion === "skipped") return "skipped";
  return ["success", "failure", "cancelled", "timed_out"].includes(
    mutationSteps[0]?.conclusion,
  ) ? "may-have-written" : "invalid";
}

async function successfulIncidentProviderTerminalExact(
  fetchImpl,
  token,
  policy,
  run,
) {
  // The reviewed workflow has no continue-on-error on this step, and the
  // incident executor returns zero only for its three terminal outcomes.
  if (run.conclusion !== "success") return false;
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
  const terminalSteps = Array.isArray(job?.steps)
    ? job.steps.filter((step) => step?.name === PROVIDER_MUTATION_STEP)
    : [];
  return job?.run_id === run.id &&
    job?.run_attempt === 1 &&
    job?.name === PROVIDER_MUTATION_JOB &&
    job?.status === "completed" &&
    job?.conclusion === "success" &&
    terminalSteps.length === 1 &&
    terminalSteps[0]?.status === "completed" &&
    terminalSteps[0]?.conclusion === "success";
}

function verifyDurableCleanupSuccessorCloseout() {
  try {
    const attestationPath = path.join(
      CLEANUP_SUCCESSOR_CLOSEOUT_EVIDENCE_DIRECTORY,
      "attestation.json",
    );
    const attestationBytes = readHeldPinnedEvidenceFile(
      attestationPath,
      16 * 1024,
    );
    if (
      sha256(attestationBytes) !==
        CLEANUP_SUCCESSOR_CLOSEOUT_ATTESTATION_SHA256
    ) throw new Error("invalid");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      attestationBytes,
    );
    const value = JSON.parse(source);
    if (
      canonicalJson(value) !== source ||
      !exactKeys(value, [
        "schemaVersion",
        "operation",
        "originalCandidateSha",
        "anchor",
        "workflowRun",
        "workflowJob",
        "githubArtifact",
        "retainedEvidence",
        "result",
      ]) ||
      value.schemaVersion !==
        "pintpath-permanent-staging-cleanup-closeout-attestation/v1" ||
      value.operation !== CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION ||
      value.originalCandidateSha !==
        CLEANUP_SUCCESSOR_CLOSEOUT_ORIGINAL_CANDIDATE_SHA ||
      !exactKeys(value.anchor, [
        "candidateSha",
        "treeSha",
        "parentSha",
        "pullRequestNumber",
        "mergedAt",
      ]) ||
      value.anchor.candidateSha !== CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_SHA ||
      value.anchor.treeSha !== CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_TREE_SHA ||
      value.anchor.parentSha !==
        CLEANUP_SUCCESSOR_CLOSEOUT_ORIGINAL_CANDIDATE_SHA ||
      value.anchor.pullRequestNumber !==
        CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_PULL_REQUEST_NUMBER ||
      value.anchor.mergedAt !== CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_MERGED_AT ||
      !exactKeys(value.workflowRun, [
        "id",
        "workflowPath",
        "displayTitle",
        "headBranch",
        "headSha",
        "runAttempt",
        "status",
        "conclusion",
        "createdAt",
        "runStartedAt",
        "updatedAt",
      ]) ||
      value.workflowRun.id !== CLEANUP_SUCCESSOR_CLOSEOUT_RUN_ID ||
      value.workflowRun.workflowPath !== PROVIDER_MUTATION_WORKFLOW_PATH ||
      value.workflowRun.displayTitle !==
        `Permanent staging provider mutation | ${CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION} | ${CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_SHA}` ||
      value.workflowRun.headBranch !== "main" ||
      value.workflowRun.headSha !== CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_SHA ||
      value.workflowRun.runAttempt !== 1 ||
      value.workflowRun.status !== "completed" ||
      value.workflowRun.conclusion !== "success" ||
      value.workflowRun.createdAt !== CLEANUP_SUCCESSOR_CLOSEOUT_RUN_CREATED_AT ||
      value.workflowRun.runStartedAt !==
        CLEANUP_SUCCESSOR_CLOSEOUT_RUN_CREATED_AT ||
      value.workflowRun.updatedAt !==
        CLEANUP_SUCCESSOR_CLOSEOUT_RUN_COMPLETED_AT ||
      !exactKeys(value.workflowJob, [
        "name",
        "runId",
        "runAttempt",
        "status",
        "conclusion",
        "steps",
      ]) ||
      value.workflowJob.name !== PROVIDER_MUTATION_JOB ||
      value.workflowJob.runId !== CLEANUP_SUCCESSOR_CLOSEOUT_RUN_ID ||
      value.workflowJob.runAttempt !== 1 ||
      value.workflowJob.status !== "completed" ||
      value.workflowJob.conclusion !== "success" ||
      !Array.isArray(value.workflowJob.steps) ||
      value.workflowJob.steps.length !== 4
    ) throw new Error("invalid");
    const expectedSteps = [
      [PROVIDER_MUTATION_STEP, "skipped"],
      [CLEANUP_SUCCESSOR_CLOSEOUT_STEP, "success"],
      [PROVIDER_BOUNDARY_STEP, "success"],
      [PROVIDER_EVIDENCE_UPLOAD_STEP, "success"],
    ];
    if (value.workflowJob.steps.some((step, index) =>
      !exactKeys(step, ["name", "status", "conclusion"]) ||
      step.name !== expectedSteps[index][0] ||
      step.status !== "completed" ||
      step.conclusion !== expectedSteps[index][1])) throw new Error("invalid");
    if (
      !exactKeys(value.githubArtifact, [
        "id",
        "name",
        "digest",
        "sizeInBytes",
        "createdAt",
        "updatedAt",
        "expiresAt",
      ]) ||
      value.githubArtifact.id !== CLEANUP_SUCCESSOR_CLOSEOUT_ARTIFACT_ID ||
      value.githubArtifact.name !== CLEANUP_SUCCESSOR_CLOSEOUT_ARTIFACT_NAME ||
      value.githubArtifact.digest !==
        CLEANUP_SUCCESSOR_CLOSEOUT_ARTIFACT_DIGEST ||
      value.githubArtifact.sizeInBytes !==
        CLEANUP_SUCCESSOR_CLOSEOUT_ARTIFACT_BYTES ||
      value.githubArtifact.createdAt !==
        CLEANUP_SUCCESSOR_CLOSEOUT_ARTIFACT_CREATED_AT ||
      value.githubArtifact.updatedAt !==
        CLEANUP_SUCCESSOR_CLOSEOUT_ARTIFACT_CREATED_AT ||
      value.githubArtifact.expiresAt !==
        CLEANUP_SUCCESSOR_CLOSEOUT_ARTIFACT_EXPIRES_AT ||
      !Array.isArray(value.retainedEvidence) ||
      value.retainedEvidence.length !==
        CLEANUP_SUCCESSOR_CLOSEOUT_RETAINED_EVIDENCE.length ||
      !exactKeys(value.result, [
        "outcome",
        "mutationAttempts",
        "secretMaterialIncluded",
        "secretDerivedCommitmentsIncluded",
        "laterCandidateCloseoutRerunsAllowed",
      ]) ||
      value.result.outcome !== "cleanup_completed_read_only_reconciled" ||
      value.result.mutationAttempts !== 0 ||
      value.result.secretMaterialIncluded !== false ||
      value.result.secretDerivedCommitmentsIncluded !== false ||
      value.result.laterCandidateCloseoutRerunsAllowed !== false
    ) throw new Error("invalid");
    for (
      let index = 0;
      index < CLEANUP_SUCCESSOR_CLOSEOUT_RETAINED_EVIDENCE.length;
      index += 1
    ) {
      const expected = CLEANUP_SUCCESSOR_CLOSEOUT_RETAINED_EVIDENCE[index];
      const observed = value.retainedEvidence[index];
      const expectedPath = path.posix.join(
        "docs/incident-evidence/permanent-staging-cleanup-closeout-2026-08-29",
        expected.leaf,
      );
      if (
        !exactKeys(observed, ["path", "sha256", "sizeInBytes"]) ||
        observed.path !== expectedPath ||
        observed.sha256 !== expected.sha256 ||
        observed.sizeInBytes !== expected.sizeInBytes
      ) throw new Error("invalid");
      const evidencePath = path.join(
        CLEANUP_SUCCESSOR_CLOSEOUT_EVIDENCE_DIRECTORY,
        expected.leaf,
      );
      const evidence = readHeldPinnedEvidenceFile(
        evidencePath,
        expected.sizeInBytes,
      );
      if (
        evidence.length !== expected.sizeInBytes ||
        sha256(evidence) !== expected.sha256
      ) throw new Error("invalid");
    }
  } catch {
    throw new Error("staging_mutation_history_invalid");
  }
}

async function verifyCleanupSuccessorLineage(
  fetchImpl,
  token,
  policy,
  candidateSha,
) {
  let anchor;
  try {
    anchor = await githubGet(
      fetchImpl,
      token,
      policy.repository,
      `/git/commits/${CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_SHA}`,
    );
  } catch {
    throw new Error("staging_mutation_history_unavailable");
  }
  if (
    anchor?.sha !== CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_SHA ||
    anchor?.tree?.sha !== CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_TREE_SHA ||
    !Array.isArray(anchor?.parents) ||
    anchor.parents.length !== 1 ||
    anchor.parents[0]?.sha !==
      CLEANUP_SUCCESSOR_CLOSEOUT_ORIGINAL_CANDIDATE_SHA
  ) throw new Error("staging_mutation_history_invalid");
  if (candidateSha === CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_SHA) return;

  let comparison;
  try {
    comparison = await githubGet(
      fetchImpl,
      token,
      policy.repository,
      `/compare/${CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_SHA}...${candidateSha}`,
    );
  } catch {
    throw new Error("staging_mutation_history_unavailable");
  }
  if (
    comparison?.status !== "ahead" ||
    comparison?.base_commit?.sha !==
      CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_SHA ||
    comparison?.merge_base_commit?.sha !==
      CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_SHA ||
    comparison?.behind_by !== 0 ||
    !Number.isSafeInteger(comparison?.ahead_by) ||
    comparison.ahead_by < 1
  ) throw new Error("staging_mutation_history_invalid");
}

async function verifyHistoricalCleanupSuccessorCloseout(
  input,
  mergedAtMs,
  deployStartedAtMs,
) {
  verifyDurableCleanupSuccessorCloseout();
  await verifyCleanupSuccessorLineage(
    input.fetchImpl,
    input.token,
    input.policy,
    input.candidateSha,
  );
  const anchorMergedAtMs = timestamp(
    CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_MERGED_AT,
  );
  const closeoutCreatedAtMs = timestamp(
    CLEANUP_SUCCESSOR_CLOSEOUT_RUN_CREATED_AT,
  );
  const closeoutCompletedAtMs = timestamp(
    CLEANUP_SUCCESSOR_CLOSEOUT_RUN_COMPLETED_AT,
  );
  if (
    anchorMergedAtMs === null ||
    closeoutCreatedAtMs === null ||
    closeoutCompletedAtMs === null ||
    anchorMergedAtMs > closeoutCreatedAtMs ||
    closeoutCreatedAtMs > closeoutCompletedAtMs ||
    closeoutCompletedAtMs >= deployStartedAtMs ||
    (input.candidateSha === CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_SHA
      ? mergedAtMs !== anchorMergedAtMs
      : closeoutCompletedAtMs >= mergedAtMs)
  ) throw new Error("staging_mutation_history_invalid");
}

async function verifyStagingMutationClosure(input) {
  const mergedAtMs = timestamp(input.reviewedPullRequest.mergedAt);
  const deployStartedAtMs = timestamp(input.deployments?.[1]?.startedAt);
  const consumerStartedAtMs = timestamp(input.consumerStartedAt);
  if (
    mergedAtMs === null ||
    deployStartedAtMs === null ||
    consumerStartedAtMs === null ||
    deployStartedAtMs < mergedAtMs
  ) throw new Error("staging_mutation_history_expired");
  const initialWriteDeadlineMs = mergedAtMs + MAX_STAGING_MUTATION_WINDOW_MS;
  const recoveryOriginalCompletionTimes = [];
  const requireInitialWriteInWindow = (run) => {
    if (run.updatedAtMs > initialWriteDeadlineMs) {
      throw new Error("staging_mutation_history_expired");
    }
  };
  const recordRunnerLossRecovery = (original, recovery, priorReadOnlyRetries) => {
    requireInitialWriteInWindow(original);
    const retries = [...priorReadOnlyRetries].sort((left, right) =>
      left.startedAtMs - right.startedAtMs);
    if (
      new Set(retries.map((run) => run.id)).size !== retries.length ||
      retries.some((run, index) =>
        (index === 0
          ? original.updatedAtMs >= run.startedAtMs
          : retries[index - 1].updatedAtMs >= run.startedAtMs)) ||
      (retries.length === 0
        ? original.updatedAtMs >= recovery.startedAtMs
        : retries.at(-1).updatedAtMs >= recovery.startedAtMs)
    ) {
      throw new Error("staging_bootstrap_history_invalid");
    }
    const recoveryDeadlineMs =
      original.updatedAtMs + RUNNER_LOSS_RECOVERY_GRACE_MS;
    if (
      retries.some((run) => run.updatedAtMs > recoveryDeadlineMs) ||
      recovery.updatedAtMs > recoveryDeadlineMs
    ) {
      throw new Error("staging_mutation_history_expired");
    }
    recoveryOriginalCompletionTimes.push(original.updatedAtMs);
    return Object.freeze(retries);
  };

  if (
    !Array.isArray(input.deployments) ||
    input.deployments.length !== 2 ||
    !input.venueDirectory ||
    !input.scale
  ) throw new Error("staging_bootstrap_history_invalid");
  await verifyHistoricalCleanupSuccessorCloseout(
    input,
    mergedAtMs,
    deployStartedAtMs,
  );
  const [fencedDeployment, activeDeployment] = input.deployments;
  const fencedStartedAtMs = timestamp(fencedDeployment.startedAt);
  const fencedCompletedAtMs = timestamp(fencedDeployment.completedAt);
  const activeStartedAtMs = timestamp(activeDeployment.startedAt);
  const activeCompletedAtMs = timestamp(activeDeployment.completedAt);
  const venueStartedAtMs = timestamp(input.venueDirectory.startedAt);
  const venueCompletedAtMs = timestamp(input.venueDirectory.completedAt);
  const scaleStartedAtMs = timestamp(input.scale.startedAt);
  const fencedRun = input.workflowRuns.get(fencedDeployment.runId);
  const activeRun = input.workflowRuns.get(activeDeployment.runId);
  const venueRun = input.workflowRuns.get(input.venueDirectory.runId);
  if (
    fencedStartedAtMs === null ||
    fencedCompletedAtMs === null ||
    activeStartedAtMs === null ||
    activeCompletedAtMs === null ||
    venueStartedAtMs === null ||
    venueCompletedAtMs === null ||
    scaleStartedAtMs === null ||
    activeStartedAtMs !== deployStartedAtMs ||
    fencedRun?.display_title !==
      `Deploy permanent staging | fenced | ${input.candidateSha}` ||
    activeRun?.display_title !==
      `Deploy permanent staging | active | ${input.candidateSha}` ||
    venueRun?.display_title !==
      `Permanent staging venue directory | apply-refresh-validate | ${input.candidateSha}`
  ) throw new Error("staging_bootstrap_history_invalid");

  const providerRuns = await listMutationWorkflowRuns(
    input.fetchImpl,
    input.token,
    input.policy,
    PROVIDER_MUTATION_WORKFLOW_ID,
    input.reviewedPullRequest.mergedAt,
    input.consumerStartedAt,
  );
  const ambiguousOffsiteCleanupRuns = [];
  const ambiguousOffsiteCleanupRecoveryRuns = [];
  const successfulOffsiteCleanupRecoveryRuns = [];
  const safeSkippedOffsiteCleanupRuns = [];
  const safeSkippedOffsiteCleanupRecoveryRuns = [];
  const incidentCleanupCancelRuns = [];
  let nonIncidentProviderRuns = 0;
  let successfulOffsiteCleanupRuns = 0;
  const closeoutTitlePrefix =
    `Permanent staging provider mutation | ${CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION} | `;
  const currentWindowCloseouts = providerRuns.filter((run) =>
    typeof run?.display_title === "string" &&
    run.display_title.startsWith(closeoutTitlePrefix));
  if (input.candidateSha === CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_SHA) {
    if (
      currentWindowCloseouts.length !== 1 ||
      currentWindowCloseouts[0]?.id !== CLEANUP_SUCCESSOR_CLOSEOUT_RUN_ID ||
      currentWindowCloseouts[0]?.head_sha !==
        CLEANUP_SUCCESSOR_CLOSEOUT_ANCHOR_SHA
    ) throw new Error("staging_mutation_history_invalid");
  } else if (currentWindowCloseouts.length !== 0) {
    throw new Error("staging_mutation_history_invalid");
  }
  for (const observed of providerRuns.filter((run) =>
    run?.head_sha === input.candidateSha &&
    run?.id !== CLEANUP_SUCCESSOR_CLOSEOUT_RUN_ID)) {
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
    if (operation === CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION) {
      throw new Error("staging_mutation_history_invalid");
    } else if (operation === INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION) {
      const disposition = run.conclusion === "success"
        ? await successfulIncidentProviderTerminalExact(
          input.fetchImpl,
          input.token,
          input.policy,
          run,
        )
          ? "success"
          : "invalid"
        : await providerWriteDisposition(
          input.fetchImpl,
          input.token,
          input.policy,
          run,
        );
      if (!new Set(["success", "skipped", "may-have-written"]).has(
        disposition,
      )) throw new Error("staging_mutation_history_invalid");
      requireInitialWriteInWindow(run);
      incidentCleanupCancelRuns.push(Object.freeze({ run, disposition }));
    } else if (run.conclusion === "success") {
      nonIncidentProviderRuns += 1;
      if (operation === OFFSITE_CLEANUP_OPERATION) {
        successfulOffsiteCleanupRuns += 1;
        requireInitialWriteInWindow(run);
      }
      if (OFFSITE_CLEANUP_RECOVERY_OPERATIONS.has(operation)) {
        successfulOffsiteCleanupRecoveryRuns.push({ operation, run });
      } else if (operation !== OFFSITE_CLEANUP_OPERATION) {
        requireInitialWriteInWindow(run);
      }
    } else {
      nonIncidentProviderRuns += 1;
      const disposition = await providerWriteDisposition(
        input.fetchImpl,
        input.token,
        input.policy,
        run,
      );
      if (disposition === "skipped") {
        if (operation === OFFSITE_CLEANUP_OPERATION) {
          safeSkippedOffsiteCleanupRuns.push(run);
        } else if (OFFSITE_CLEANUP_RECOVERY_OPERATIONS.has(operation)) {
          safeSkippedOffsiteCleanupRecoveryRuns.push({ operation, run });
        }
      } else if (
        operation === OFFSITE_CLEANUP_OPERATION &&
        disposition === "may-have-written"
      ) {
        requireInitialWriteInWindow(run);
        ambiguousOffsiteCleanupRuns.push(run);
      } else if (
        OFFSITE_CLEANUP_RECOVERY_OPERATIONS.has(operation) &&
        disposition === "may-have-written"
      ) {
        ambiguousOffsiteCleanupRecoveryRuns.push({ operation, run });
      } else {
        throw new Error("staging_mutation_history_invalid");
      }
    }
    if (run.updatedAtMs >= deployStartedAtMs) {
      throw new Error("staging_mutation_after_closeout_deployment");
    }
  }
  if (successfulOffsiteCleanupRuns > 1) {
    throw new Error("staging_mutation_history_invalid");
  }
  if (incidentCleanupCancelRuns.length > 0) {
    const ordered = [...incidentCleanupCancelRuns].sort((left, right) =>
      left.run.startedAtMs - right.run.startedAtMs);
    const successful = ordered.filter((item) =>
      item.disposition === "success");
    if (
      nonIncidentProviderRuns !== 0 ||
      new Set(ordered.map((item) => item.run.id)).size !== ordered.length ||
      successful.length !== 1 ||
      ordered.at(-1) !== successful[0] ||
      ordered.some((item) =>
        item.run.startedAtMs >= INCIDENT_MASKED_CLEANUP_CANCEL_DEADLINE_MS) ||
      ordered.some((item, index) => index > 0 &&
        ordered[index - 1].run.updatedAtMs >= item.run.startedAtMs)
    ) throw new Error("staging_mutation_history_invalid");
  }
  ambiguousOffsiteCleanupRecoveryRuns.sort((left, right) =>
    left.run.startedAtMs - right.run.startedAtMs);
  if (ambiguousOffsiteCleanupRuns.length === 0) {
    if (successfulOffsiteCleanupRecoveryRuns.length !== 0 ||
      ambiguousOffsiteCleanupRecoveryRuns.length !== 0 ||
      safeSkippedOffsiteCleanupRecoveryRuns.length !== 0) {
      throw new Error("staging_mutation_history_invalid");
    }
  } else if (
    ambiguousOffsiteCleanupRuns.length !== 1 ||
    successfulOffsiteCleanupRecoveryRuns.length !== 1 ||
    successfulOffsiteCleanupRuns !== 0 ||
    ambiguousOffsiteCleanupRuns[0].updatedAtMs >=
      successfulOffsiteCleanupRecoveryRuns[0].run.startedAtMs ||
    ambiguousOffsiteCleanupRecoveryRuns.some((item) =>
      item.operation !== successfulOffsiteCleanupRecoveryRuns[0].operation ||
      item.run.startedAtMs <= ambiguousOffsiteCleanupRuns[0].updatedAtMs ||
      item.run.updatedAtMs >=
        successfulOffsiteCleanupRecoveryRuns[0].run.startedAtMs)
  ) {
    throw new Error("staging_mutation_history_invalid");
  } else {
    const originalCleanup = ambiguousOffsiteCleanupRuns[0];
    const finalRecovery = successfulOffsiteCleanupRecoveryRuns[0];
    const recoveryDeadlineMs =
      originalCleanup.updatedAtMs + RUNNER_LOSS_RECOVERY_GRACE_MS;
    const priorRecoveryAttempts = [
      ...ambiguousOffsiteCleanupRecoveryRuns.map((item) => ({
        ...item,
        disposition: "may-have-written",
      })),
      ...safeSkippedOffsiteCleanupRecoveryRuns.map((item) => ({
        ...item,
        disposition: "skipped",
      })),
    ].sort((left, right) => left.run.startedAtMs - right.run.startedAtMs);
    if (priorRecoveryAttempts.some((item, index) =>
        item.run.startedAtMs <= originalCleanup.updatedAtMs ||
        item.run.updatedAtMs >= finalRecovery.run.startedAtMs ||
        (index > 0 && priorRecoveryAttempts[index - 1].run.updatedAtMs >=
          item.run.startedAtMs))) {
      throw new Error("staging_mutation_history_invalid");
    }
    if (
      priorRecoveryAttempts.some((item) =>
        item.run.updatedAtMs > recoveryDeadlineMs) ||
      finalRecovery.run.updatedAtMs > recoveryDeadlineMs
    ) throw new Error("staging_mutation_history_expired");
    recoveryOriginalCompletionTimes.push(originalCleanup.updatedAtMs);
    if (safeSkippedOffsiteCleanupRuns.some((run) =>
      run.updatedAtMs >= originalCleanup.startedAtMs)) {
      throw new Error("staging_mutation_history_invalid");
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
    if (classified.target === "production") continue;
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
    requireInitialWriteInWindow(run);
    if (run.updatedAtMs >= deployStartedAtMs) {
      throw new Error("staging_mutation_after_closeout_deployment");
    }
  }

  const venueDirectoryRuns = await listMutationWorkflowRuns(
    input.fetchImpl,
    input.token,
    input.policy,
    STAGING_VENUE_DIRECTORY_WORKFLOW_ID,
    input.reviewedPullRequest.mergedAt,
    input.consumerStartedAt,
  );
  const candidateVenueDirectoryRuns = venueDirectoryRuns.filter((run) =>
    run?.head_sha === input.candidateSha
  );
  if (candidateVenueDirectoryRuns.length !== 1) {
    throw new Error("staging_bootstrap_history_invalid");
  }
  let venueDirectoryRun;
  try {
    venueDirectoryRun = validateMutationWorkflowRun(
      candidateVenueDirectoryRuns[0],
      input.policy,
      input.candidateSha,
      STAGING_VENUE_DIRECTORY_WORKFLOW_PATH,
      `Permanent staging venue directory | apply-refresh-validate | ${input.candidateSha}`,
    );
  } catch {
    throw new Error("staging_bootstrap_history_invalid");
  }
  if (
    venueDirectoryRun.id !== input.venueDirectory.runId ||
    venueDirectoryRun.conclusion !== "success" ||
    venueDirectoryRun.createdAtMs < mergedAtMs ||
    venueDirectoryRun.createdAtMs > consumerStartedAtMs ||
    venueDirectoryRun.startedAtMs > venueStartedAtMs ||
    venueDirectoryRun.updatedAtMs < venueCompletedAtMs
  ) throw new Error("staging_bootstrap_history_invalid");
  requireInitialWriteInWindow(venueDirectoryRun);

  const workerRuns = await listMutationWorkflowRuns(
    input.fetchImpl,
    input.token,
    input.policy,
    WORKER_FENCE_WORKFLOW_ID,
    input.reviewedPullRequest.mergedAt,
    input.consumerStartedAt,
  );
  const stagingWorkers = [];
  const safeSkippedWorkers = [];
  const ambiguousActivations = [];
  const priorReadOnlyActivationReconciliations = [];
  for (const observed of workerRuns.filter((run) =>
    run?.head_sha === input.candidateSha &&
    String(run?.display_title ?? "").startsWith(
      "Automatic maintenance worker fence | permanent-staging | ",
    ))) {
    const operation = stagingWorkerOperationForTitle(
      observed.display_title,
      input.candidateSha,
    );
    if (operation === null) throw new Error("staging_bootstrap_history_invalid");
    const run = validateMutationWorkflowRun(
      observed,
      input.policy,
      input.candidateSha,
      WORKER_FENCE_WORKFLOW_PATH,
      observed.display_title,
    );
    if (run.createdAtMs < mergedAtMs ||
      run.createdAtMs > consumerStartedAtMs ||
      run.updatedAtMs >= activeStartedAtMs) {
      throw new Error("staging_bootstrap_history_invalid");
    }
    if (run.conclusion === "success") {
      if (operation === "reconcile-activate") {
        if (await workflowJobDisposition(
          input.fetchImpl,
          input.token,
          input.policy,
          run,
          STAGING_WORKER_JOBS,
          "reconcile-activate",
          "reconcile",
        ) !== "read-only-reconciled") {
          throw new Error("staging_bootstrap_history_invalid");
        }
      } else {
        requireInitialWriteInWindow(run);
      }
      stagingWorkers.push(Object.freeze({ operation, run }));
      continue;
    }
    if (operation === "reconcile-activate") {
      if (await workflowJobDisposition(
        input.fetchImpl,
        input.token,
        input.policy,
        run,
        STAGING_WORKER_JOBS,
        "reconcile-activate",
        "reconcile-retry",
      ) !== "read-only-retry") {
        throw new Error("staging_bootstrap_history_invalid");
      }
      priorReadOnlyActivationReconciliations.push(
        Object.freeze({ operation, run }),
      );
      continue;
    }
    const disposition = await workflowJobDisposition(
      input.fetchImpl,
      input.token,
      input.policy,
      run,
      STAGING_WORKER_JOBS,
      "configure",
      "write",
    );
    if (disposition === "skipped") {
      safeSkippedWorkers.push(Object.freeze({ operation, run }));
    } else if (operation === "activate" && disposition === "may-have-written") {
      requireInitialWriteInWindow(run);
      ambiguousActivations.push(Object.freeze({ operation, run }));
    } else {
      throw new Error("staging_bootstrap_history_invalid");
    }
  }

  const bootstrapRuns = await listMutationWorkflowRuns(
    input.fetchImpl,
    input.token,
    input.policy,
    STAGING_BOOTSTRAP_WORKFLOW_ID,
    input.reviewedPullRequest.mergedAt,
    input.consumerStartedAt,
  );
  const stagingBootstrap = [];
  const safeSkippedBootstrap = [];
  const ambiguousRestores = [];
  const priorReadOnlyRestoreReconciliations = [];
  for (const observed of bootstrapRuns.filter((run) =>
    run?.head_sha === input.candidateSha)) {
    const operation = stagingBootstrapOperationForTitle(
      observed?.display_title,
      input.candidateSha,
    );
    if (operation === null) throw new Error("staging_bootstrap_history_invalid");
    const run = validateMutationWorkflowRun(
      observed,
      input.policy,
      input.candidateSha,
      STAGING_BOOTSTRAP_WORKFLOW_PATH,
      observed.display_title,
    );
    if (run.createdAtMs < mergedAtMs ||
      run.createdAtMs > consumerStartedAtMs ||
      run.updatedAtMs >= activeStartedAtMs) {
      throw new Error("staging_bootstrap_history_invalid");
    }
    if (run.conclusion === "success") {
      if (operation === "reconcile-restore") {
        if (await workflowJobDisposition(
          input.fetchImpl,
          input.token,
          input.policy,
          run,
          STAGING_BOOTSTRAP_JOBS,
          "reconcile-restore",
          "reconcile",
        ) !== "read-only-reconciled") {
          throw new Error("staging_bootstrap_history_invalid");
        }
      } else {
        requireInitialWriteInWindow(run);
      }
      stagingBootstrap.push(Object.freeze({ operation, run }));
      continue;
    }
    if (operation === "reconcile-restore") {
      if (await workflowJobDisposition(
        input.fetchImpl,
        input.token,
        input.policy,
        run,
        STAGING_BOOTSTRAP_JOBS,
        "reconcile-restore",
        "reconcile-retry",
      ) !== "read-only-retry") {
        throw new Error("staging_bootstrap_history_invalid");
      }
      priorReadOnlyRestoreReconciliations.push(
        Object.freeze({ operation, run }),
      );
      continue;
    }
    const disposition = await workflowJobDisposition(
      input.fetchImpl,
      input.token,
      input.policy,
      run,
      STAGING_BOOTSTRAP_JOBS,
      "bootstrap",
      "write",
    );
    if (disposition === "skipped") {
      safeSkippedBootstrap.push(Object.freeze({ operation, run }));
    } else if (operation === "restore" && disposition === "may-have-written") {
      requireInitialWriteInWindow(run);
      ambiguousRestores.push(Object.freeze({ operation, run }));
    } else {
      throw new Error("staging_bootstrap_history_invalid");
    }
  }

  const coldRuns = await listMutationWorkflowRuns(
    input.fetchImpl,
    input.token,
    input.policy,
    COLD_RECOVERY_WORKFLOW_ID,
    input.reviewedPullRequest.mergedAt,
    input.consumerStartedAt,
  );
  const stagingColdRecovery = [];
  const safeSkippedColdRecovery = [];
  const ambiguousColdPrepare = [];
  const ambiguousColdQuiesce = [];
  const priorReadOnlyColdReconciliations = [];
  let observedCandidateColdRuns = 0;
  for (const observed of coldRuns.filter((run) =>
    run?.head_sha === input.candidateSha)) {
    observedCandidateColdRuns += 1;
    const operation = coldRecoveryOperationForTitle(
      observed?.display_title,
      input.candidateSha,
    );
    if (operation === null) throw new Error("staging_bootstrap_history_invalid");
    const run = validateMutationWorkflowRun(
      observed,
      input.policy,
      input.candidateSha,
      COLD_RECOVERY_WORKFLOW_PATH,
      observed.display_title,
    );
    if (run.createdAtMs < mergedAtMs ||
      run.createdAtMs > consumerStartedAtMs ||
      run.updatedAtMs >= activeStartedAtMs) {
      throw new Error("staging_bootstrap_history_invalid");
    }
    if (run.conclusion === "success") {
      if (operation.startsWith("reconcile-")) {
        if (await workflowJobDisposition(
          input.fetchImpl,
          input.token,
          input.policy,
          run,
          COLD_RECOVERY_JOBS,
          operation,
          "reconcile",
        ) !== "read-only-reconciled") {
          throw new Error("staging_bootstrap_history_invalid");
        }
      } else {
        requireInitialWriteInWindow(run);
      }
      stagingColdRecovery.push(Object.freeze({ operation, run }));
      continue;
    }
    if (operation.startsWith("reconcile-")) {
      if (await workflowJobDisposition(
        input.fetchImpl,
        input.token,
        input.policy,
        run,
        COLD_RECOVERY_JOBS,
        operation,
        "reconcile-retry",
      ) !== "read-only-retry") {
        throw new Error("staging_bootstrap_history_invalid");
      }
      priorReadOnlyColdReconciliations.push(Object.freeze({ operation, run }));
      continue;
    }
    const disposition = await workflowJobDisposition(
      input.fetchImpl,
      input.token,
      input.policy,
      run,
      COLD_RECOVERY_JOBS,
      operation,
      "write",
    );
    if (disposition === "skipped") {
      safeSkippedColdRecovery.push(Object.freeze({ operation, run }));
    } else if (disposition === "may-have-written") {
      requireInitialWriteInWindow(run);
      if (operation === "prepare") {
        ambiguousColdPrepare.push(Object.freeze({ operation, run }));
      } else if (operation === "quiesce") {
        ambiguousColdQuiesce.push(Object.freeze({ operation, run }));
      } else {
        throw new Error("staging_bootstrap_history_invalid");
      }
    } else {
      throw new Error("staging_bootstrap_history_invalid");
    }
  }

  const one = (values, operation) => {
    const matches = values.filter((item) => item.operation === operation);
    if (matches.length !== 1) throw new Error("staging_bootstrap_history_invalid");
    return matches[0].run;
  };
  const selectRecoveryPhase = (
    successful,
    ambiguous,
    priorReadOnlyReconciliations,
    normalOperation,
    recoveryOperation,
  ) => {
    const normal = successful.filter((item) =>
      item.operation === normalOperation);
    const recovered = successful.filter((item) =>
      item.operation === recoveryOperation);
    const originals = ambiguous.filter((item) =>
      item.operation === normalOperation);
    const priorReadOnly = priorReadOnlyReconciliations.filter((item) =>
      item.operation === recoveryOperation);
    if (
      normal.length === 1 &&
      recovered.length === 0 &&
      originals.length === 0 &&
      priorReadOnly.length === 0
    ) {
      return Object.freeze({
        first: normal[0].run,
        terminal: normal[0].run,
        runs: Object.freeze([normal[0].run]),
      });
    }
    if (normal.length === 0 && recovered.length === 1 && originals.length === 1) {
      const orderedPriorReadOnly = recordRunnerLossRecovery(
        originals[0].run,
        recovered[0].run,
        priorReadOnly.map((item) => item.run),
      );
      return Object.freeze({
        first: originals[0].run,
        terminal: recovered[0].run,
        runs: Object.freeze([
          originals[0].run,
          ...orderedPriorReadOnly,
          recovered[0].run,
        ]),
      });
    }
    throw new Error("staging_bootstrap_history_invalid");
  };
  const requireSafeRetriesBetween = (
    safeRetries,
    operation,
    priorCompletedAtMs,
    selectedStartedAtMs,
  ) => {
    const selectedRetries = safeRetries.filter((item) =>
      item.operation === operation).sort((left, right) =>
        left.run.startedAtMs - right.run.startedAtMs);
    if (
      new Set(selectedRetries.map((item) => item.run.id)).size !==
        selectedRetries.length ||
      selectedRetries.some((item, index) =>
        item.run.startedAtMs <= priorCompletedAtMs ||
        item.run.updatedAtMs >= selectedStartedAtMs ||
        (index > 0 &&
          selectedRetries[index - 1].run.updatedAtMs >= item.run.startedAtMs))
    ) {
      throw new Error("staging_bootstrap_history_invalid");
    }
  };

  const workerPrepare = stagingWorkers.filter((item) =>
    item.operation === "prepare");
  const bootstrapQuiesce = stagingBootstrap.filter((item) =>
    item.operation === "quiesce");
  const normalPath =
    workerPrepare.length === 1 &&
    bootstrapQuiesce.length === 1 &&
    observedCandidateColdRuns === 0;
  const coldPath =
    workerPrepare.length === 0 &&
    bootstrapQuiesce.length === 0 &&
    safeSkippedWorkers.filter((item) => item.operation === "prepare").length === 0 &&
    safeSkippedBootstrap.filter((item) => item.operation === "quiesce").length === 0 &&
    observedCandidateColdRuns > 0;
  if (normalPath === coldPath) throw new Error("staging_bootstrap_history_invalid");

  const preparePhase = normalPath
    ? Object.freeze({
        first: one(stagingWorkers, "prepare"),
        terminal: one(stagingWorkers, "prepare"),
        runs: Object.freeze([one(stagingWorkers, "prepare")]),
      })
    : selectRecoveryPhase(
        stagingColdRecovery,
        ambiguousColdPrepare,
        priorReadOnlyColdReconciliations,
        "prepare",
        "reconcile-prepare",
      );
  const quiescePhase = normalPath
    ? Object.freeze({
        first: one(stagingBootstrap, "quiesce"),
        terminal: one(stagingBootstrap, "quiesce"),
        runs: Object.freeze([one(stagingBootstrap, "quiesce")]),
      })
    : selectRecoveryPhase(
        stagingColdRecovery,
        ambiguousColdQuiesce,
        priorReadOnlyColdReconciliations,
        "quiesce",
        "reconcile-quiesce",
      );
  const restorePhase = selectRecoveryPhase(
    stagingBootstrap,
    ambiguousRestores,
    priorReadOnlyRestoreReconciliations,
    "restore",
    "reconcile-restore",
  );
  const activatePhase = selectRecoveryPhase(
    stagingWorkers,
    ambiguousActivations,
    priorReadOnlyActivationReconciliations,
    "activate",
    "reconcile-activate",
  );

  if (
    stagingWorkers.length !== (normalPath ? 2 : 1) ||
    stagingBootstrap.length !== (normalPath ? 2 : 1) ||
    stagingColdRecovery.length !== (coldPath ? 2 : 0) ||
    ambiguousColdPrepare.length > 1 ||
    ambiguousColdQuiesce.length > 1 ||
    ambiguousRestores.length > 1 ||
    ambiguousActivations.length > 1
  ) throw new Error("staging_bootstrap_history_invalid");

  requireSafeRetriesBetween(
    normalPath ? safeSkippedWorkers : safeSkippedColdRecovery,
    "prepare",
    mergedAtMs,
    preparePhase.first.startedAtMs,
  );
  requireSafeRetriesBetween(
    normalPath ? safeSkippedBootstrap : safeSkippedColdRecovery,
    "quiesce",
    preparePhase.terminal.updatedAtMs,
    quiescePhase.first.startedAtMs,
  );
  requireSafeRetriesBetween(
    safeSkippedBootstrap,
    "restore",
    fencedCompletedAtMs,
    restorePhase.first.startedAtMs,
  );
  requireSafeRetriesBetween(
    safeSkippedWorkers,
    "activate",
    restorePhase.terminal.updatedAtMs,
    activatePhase.first.startedAtMs,
  );
  if (normalPath && (
    safeSkippedColdRecovery.length !== 0 ||
    ambiguousColdPrepare.length !== 0 ||
    ambiguousColdQuiesce.length !== 0
  )) throw new Error("staging_bootstrap_history_invalid");

  const selectedMutationRuns = [
    ...preparePhase.runs,
    ...quiescePhase.runs,
    ...restorePhase.runs,
    ...activatePhase.runs,
  ];
  if (
    new Set(selectedMutationRuns.map((run) => run.id)).size !==
      selectedMutationRuns.length
  ) throw new Error("staging_bootstrap_history_invalid");
  if (
    preparePhase.terminal.updatedAtMs >= quiescePhase.first.startedAtMs ||
    quiescePhase.terminal.updatedAtMs >= fencedStartedAtMs ||
    fencedCompletedAtMs >= venueStartedAtMs ||
    venueCompletedAtMs >= restorePhase.first.startedAtMs ||
    restorePhase.terminal.updatedAtMs >= activatePhase.first.startedAtMs ||
    activatePhase.terminal.updatedAtMs >= activeStartedAtMs ||
    activeCompletedAtMs >= scaleStartedAtMs
  ) throw new Error("staging_bootstrap_history_invalid");

  if (deployStartedAtMs > initialWriteDeadlineMs) {
    if (recoveryOriginalCompletionTimes.length === 0) {
      throw new Error("staging_mutation_history_expired");
    }
    const closeoutGraceDeadlineMs = Math.max(
      ...recoveryOriginalCompletionTimes.map((completedAtMs) =>
        completedAtMs + RUNNER_LOSS_RECOVERY_GRACE_MS),
    );
    if (deployStartedAtMs > closeoutGraceDeadlineMs) {
      throw new Error("staging_mutation_history_expired");
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

function sameFilesystemNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.gid === right.gid && left.mode === right.mode;
}

function descriptorChildPath(parentFd, parent, leaf) {
  // GitHub-hosted release consumers are Linux. The descriptor-relative path
  // keeps creation in the directory we opened even if its pathname is swapped.
  return process.platform === "linux"
    ? path.posix.join("/proc/self/fd", String(parentFd), leaf)
    : path.join(parent, leaf);
}

function writeExclusive(filename, source) {
  const parent = path.dirname(filename);
  const leaf = path.basename(filename);
  const uid = process.geteuid?.() ?? process.getuid?.();
  let parentFd = null;
  let outputFd = null;
  let exact = false;
  try {
    if (
      !Number.isSafeInteger(uid) || uid === undefined || uid < 0 ||
      filename.includes("\0") || path.resolve(filename) !== filename ||
      leaf.length === 0 || leaf === "." || leaf === ".." ||
      !Number.isSafeInteger(fs.constants.O_DIRECTORY) ||
      fs.constants.O_DIRECTORY <= 0 ||
      !Number.isSafeInteger(fs.constants.O_NOFOLLOW) ||
      fs.constants.O_NOFOLLOW <= 0
    ) throw new Error("output_unsafe");
    parentFd = fs.openSync(
      parent,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const parentDescriptor = fs.fstatSync(parentFd, { bigint: true });
    const parentPath = fs.lstatSync(parent, { bigint: true });
    if (
      !parentDescriptor.isDirectory() || !parentPath.isDirectory() ||
      parentPath.isSymbolicLink() ||
      !sameFilesystemNode(parentDescriptor, parentPath) ||
      parentDescriptor.uid !== BigInt(uid) || parentDescriptor.nlink < 1n ||
      Number(parentDescriptor.mode & 0o7777n) !== 0o700 ||
      fs.realpathSync(parent) !== parent
    ) throw new Error("output_unsafe");

    const target = descriptorChildPath(parentFd, parent, leaf);
    if (process.platform === "linux") {
      const descriptorAlias = fs.statSync(`/proc/self/fd/${parentFd}`, { bigint: true });
      if (!sameFilesystemNode(descriptorAlias, parentDescriptor)) {
        throw new Error("output_unsafe");
      }
    }
    outputFd = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    const created = fs.fstatSync(outputFd, { bigint: true });
    if (
      !created.isFile() || created.nlink !== 1n || created.uid !== BigInt(uid) ||
      Number(created.mode & 0o7777n) !== 0o600 || created.size !== 0n
    ) throw new Error("output_unsafe");
    const bytes = Buffer.from(source, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(outputFd, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error("output_unsafe");
      }
      offset += written;
    }
    fs.fsyncSync(outputFd);
    const completed = fs.fstatSync(outputFd, { bigint: true });
    const outputPath = fs.lstatSync(filename, { bigint: true });
    const parentDescriptorAfter = fs.fstatSync(parentFd, { bigint: true });
    const parentPathAfter = fs.lstatSync(parent, { bigint: true });
    if (
      !sameFilesystemNode(completed, created) || completed.nlink !== 1n ||
      completed.size !== BigInt(bytes.length) || !outputPath.isFile() ||
      outputPath.isSymbolicLink() || !sameFilesystemNode(outputPath, completed) ||
      outputPath.nlink !== 1n || outputPath.size !== BigInt(bytes.length) ||
      fs.realpathSync(filename) !== filename ||
      !sameFilesystemNode(parentDescriptorAfter, parentDescriptor) ||
      !sameFilesystemNode(parentPathAfter, parentDescriptor) ||
      parentPathAfter.isSymbolicLink() || fs.realpathSync(parent) !== parent
    ) throw new Error("output_unsafe");
    fs.fsyncSync(parentFd);
    const outputDescriptorFinal = fs.fstatSync(outputFd, { bigint: true });
    const outputPathFinal = fs.lstatSync(filename, { bigint: true });
    const parentDescriptorFinal = fs.fstatSync(parentFd, { bigint: true });
    const parentPathFinal = fs.lstatSync(parent, { bigint: true });
    exact = sameFilesystemNode(outputDescriptorFinal, completed) &&
      outputDescriptorFinal.nlink === 1n &&
      outputDescriptorFinal.size === BigInt(bytes.length) &&
      outputPathFinal.isFile() && !outputPathFinal.isSymbolicLink() &&
      sameFilesystemNode(outputPathFinal, outputDescriptorFinal) &&
      outputPathFinal.nlink === 1n &&
      outputPathFinal.size === BigInt(bytes.length) &&
      fs.realpathSync(filename) === filename &&
      sameFilesystemNode(parentDescriptorFinal, parentDescriptor) &&
      sameFilesystemNode(parentPathFinal, parentDescriptor) &&
      fs.realpathSync(parent) === parent;
  } catch {
    exact = false;
  } finally {
    try { if (outputFd !== null) fs.closeSync(outputFd); } catch { exact = false; }
    try { if (parentFd !== null) fs.closeSync(parentFd); } catch { exact = false; }
  }
  if (!exact) throw new Error("output_unsafe");
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
      const stagingVenueDirectories = intendedByName.get(
        STAGING_VENUE_DIRECTORY_CHECK,
      );
      const stagingScales = intendedByName.get(STAGING_SCALE_CHECK);
      if (!stagingVenueDirectories || stagingVenueDirectories.length !== 1) {
        throw new Error(
          `required_check_invalid:${STAGING_DEPLOYMENT_CHECK}:venue_directory_missing`,
        );
      }
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
        deployments: ordered,
        venueDirectory: stagingVenueDirectories[0],
        scale: stagingScales[0],
        workflowRuns,
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
      schemaVersion: "pintpath-github-release-candidate-receipt/v5",
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
