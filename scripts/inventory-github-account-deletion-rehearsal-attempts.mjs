import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { githubGet } from "./verify-github-release-candidate.mjs";
import {
  downloadGithubArtifactBundle,
  githubArtifactMetadataExact,
} from "./lib/github-artifact-bundle.mjs";

export const ACCOUNT_DELETION_REHEARSAL_ATTEMPT_INVENTORY_SCHEMA =
  "pintpath-account-deletion-rehearsal-attempt-inventory/v1";

const REPOSITORY = "blackmagic30/Beer";
const MAIN_WORKFLOW =
  ".github/workflows/permanent-staging-account-deletion-rehearsal.yml";
const RECONCILE_WORKFLOW =
  ".github/workflows/reconcile-permanent-staging-account-deletion-rehearsal.yml";
const ARM_SCHEMA = "pintpath-account-deletion-rehearsal-attempt-arm/v1";
const EXECUTOR_STATE = "GITHUB_ENVIRONMENT_PROTECTED";
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const PER_PAGE = 100;
const MAX_MATCHING_ARTIFACTS = 8;

export const ACCOUNT_DELETION_REHEARSAL_ATTEMPT_OPERATIONS = Object.freeze([
  "prepare-two",
  "store-activation",
  "apply-active",
  "store-cleanup",
  "reconcile-cleanup",
  "cleanup-contained-zero",
  "apply-safe",
  "converge-one",
  "quarantine-zero",
  "quarantine-zero-retry-1",
  "quarantine-zero-retry-2",
]);

const ARM_KEYS = Object.freeze([
  "schemaVersion",
  "executorState",
  "operation",
  "candidateSha",
  "activationRunId",
  "githubRunId",
  "projectId",
  "environmentId",
  "serviceId",
  "authoritySha256",
  "prerequisiteSha256",
  "providerSnapshotSha256",
  "providerInvariantSha256",
  "maximumAttempts",
  "retryAllowed",
  "mutationCredentialExposed",
  "secretMaterialIncluded",
]);

const RESULT_KEYS = Object.freeze([
  "ok",
  "schemaVersion",
  "operation",
  "candidateSha",
  "activationRunId",
  "contentSha256",
  "providerSnapshotSha256",
  "providerInvariantSha256",
  "mutationCredentialExposed",
  "secretMaterialIncluded",
]);

const ORIGINAL_ONLY_OPERATIONS = new Set([
  "prepare-two",
  "store-activation",
  "apply-active",
  "store-cleanup",
]);
const RECONCILE_ONLY_OPERATIONS = new Set([
  "reconcile-cleanup",
  "cleanup-contained-zero",
  "quarantine-zero",
  "quarantine-zero-retry-1",
  "quarantine-zero-retry-2",
]);
const PREREQUISITE_REQUIRED_OPERATIONS = new Set([
  "prepare-two",
  "apply-active",
  "reconcile-cleanup",
  "cleanup-contained-zero",
  "apply-safe",
  "converge-one",
  "quarantine-zero",
  "quarantine-zero-retry-1",
  "quarantine-zero-retry-2",
]);

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function workflowPathExact(actual, expected) {
  return actual === expected || actual === `${expected}@main`;
}

function producerRunExact(
  run,
  { runId, currentRunId, candidateSha, activationRunId },
) {
  const lifecycleExact = runId === currentRunId
    ? run.status === "in_progress" && run.conclusion === null
    : run.status === "completed"
      && ["success", "failure", "cancelled", "timed_out", "action_required"]
        .includes(run.conclusion);
  const common = record(run)
    && String(run.id) === runId
    && run.run_attempt === 1
    && lifecycleExact
    && run.head_branch === "main"
    && SHA.test(run.head_sha)
    && record(run.repository)
    && run.repository.full_name === REPOSITORY;
  if (!common) return false;
  if (workflowPathExact(run.path, MAIN_WORKFLOW)) {
    return runId === activationRunId
      && run.event === "workflow_dispatch"
      && run.head_sha === candidateSha;
  }
  return workflowPathExact(run.path, RECONCILE_WORKFLOW)
    && ["workflow_dispatch", "workflow_run", "schedule"].includes(run.event);
}

function parseCanonicalJson(bytes, failureCode) {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.includes("\0")) throw new Error(failureCode);
    const value = JSON.parse(source);
    if (canonical(value) !== source && `${JSON.stringify(value)}\n` !== source) {
      throw new Error(failureCode);
    }
    return { source, value };
  } catch {
    throw new Error(failureCode);
  }
}

function parseAttemptArm(bytes, expected) {
  const { source, value } = parseCanonicalJson(bytes, "attempt_arm_invalid");
  if (!exactKeys(value, ARM_KEYS)
    || value.schemaVersion !== ARM_SCHEMA
    || value.executorState !== EXECUTOR_STATE
    || value.operation !== expected.operation
    || value.candidateSha !== expected.candidateSha
    || value.activationRunId !== expected.activationRunId
    || value.githubRunId !== expected.producerRunId
    || value.projectId !== PROJECT_ID
    || value.environmentId !== ENVIRONMENT_ID
    || value.serviceId !== SERVICE_ID
    || !SHA256.test(value.authoritySha256)
    || (PREREQUISITE_REQUIRED_OPERATIONS.has(expected.operation)
      ? !SHA256.test(value.prerequisiteSha256)
      : value.prerequisiteSha256 !== null)
    || !SHA256.test(value.providerSnapshotSha256)
    || !SHA256.test(value.providerInvariantSha256)
    || value.maximumAttempts !== 1
    || value.retryAllowed !== false
    || value.mutationCredentialExposed !== false
    || value.secretMaterialIncluded !== false) {
    throw new Error("attempt_arm_invalid");
  }
  return { source, value, contentSha256: sha256(source) };
}

function parseAttemptResult(bytes, expected) {
  const { value } = parseCanonicalJson(bytes, "attempt_result_invalid");
  if (!exactKeys(value, RESULT_KEYS)
    || value.ok !== true
    || value.schemaVersion !== ARM_SCHEMA
    || value.operation !== expected.operation
    || value.candidateSha !== expected.candidateSha
    || value.activationRunId !== expected.activationRunId
    || value.contentSha256 !== expected.contentSha256
    || value.providerSnapshotSha256 !== expected.providerSnapshotSha256
    || value.providerInvariantSha256 !== expected.providerInvariantSha256
    || value.mutationCredentialExposed !== false
    || value.secretMaterialIncluded !== false) {
    throw new Error("attempt_result_invalid");
  }
}

async function listExactArtifacts(fetchImpl, token, expectedName) {
  const first = await githubGet(
    fetchImpl,
    token,
    REPOSITORY,
    `/actions/artifacts?name=${encodeURIComponent(expectedName)}`
      + `&per_page=${PER_PAGE}&page=1`,
  );
  if (!record(first) || !Number.isSafeInteger(first.total_count)
    || first.total_count < 0 || first.total_count > MAX_MATCHING_ARTIFACTS
    || !Array.isArray(first.artifacts)
    || first.artifacts.length !== first.total_count) {
    throw new Error("attempt_listing_invalid");
  }
  return first.artifacts;
}

async function inspectOperation(
  fetchImpl,
  token,
  operation,
  candidateSha,
  activationRunId,
  runCache,
  currentRunId,
) {
  const expectedName =
    `pintpath-account-deletion-rehearsal-attempt-${operation}`
    + `-${candidateSha}-${activationRunId}`;
  const artifacts = await listExactArtifacts(fetchImpl, token, expectedName);
  if (artifacts.length === 0) return null;
  if (artifacts.length !== 1) throw new Error("attempt_history_ambiguous");
  const artifact = artifacts[0];
  const producerRunId = String(artifact?.workflow_run?.id ?? "");
  if (!RUN_ID.test(producerRunId)
    || !githubArtifactMetadataExact(artifact, {
      repository: REPOSITORY,
      expectedName,
      expectedRunId: producerRunId,
    })) throw new Error("attempt_artifact_invalid");
  let run = runCache.get(producerRunId);
  if (!run) {
    const runPath = producerRunId === currentRunId
      ? `/actions/runs/${producerRunId}`
      : `/actions/runs/${producerRunId}/attempts/1`;
    run = await githubGet(
      fetchImpl,
      token,
      REPOSITORY,
      runPath,
    );
    runCache.set(producerRunId, run);
  }
  if (!producerRunExact(run, {
    runId: producerRunId,
    currentRunId,
    candidateSha,
    activationRunId,
  })) {
    throw new Error("attempt_producer_invalid");
  }
  const producerWorkflow = workflowPathExact(run.path, MAIN_WORKFLOW)
    ? "original" : "reconcile";
  if ((ORIGINAL_ONLY_OPERATIONS.has(operation)
      && producerWorkflow !== "original")
    || (RECONCILE_ONLY_OPERATIONS.has(operation)
      && producerWorkflow !== "reconcile")) {
    throw new Error("attempt_producer_invalid");
  }
  const entries = await downloadGithubArtifactBundle({
    artifact,
    repository: REPOSITORY,
    expectedName,
    expectedRunId: producerRunId,
    expectedEntries: ["attempt-arm.json", "result.json"],
    token,
    fetchImpl,
  });
  const arm = parseAttemptArm(entries.get("attempt-arm.json"), {
    operation,
    candidateSha,
    activationRunId,
    producerRunId,
  });
  parseAttemptResult(entries.get("result.json"), {
    operation,
    candidateSha,
    activationRunId,
    contentSha256: arm.contentSha256,
    providerSnapshotSha256: arm.value.providerSnapshotSha256,
    providerInvariantSha256: arm.value.providerInvariantSha256,
  });
  return {
    artifactId: artifact.id,
    artifactDigest: artifact.digest,
    producerRunId,
    producerWorkflow,
    producerHeadSha: run.head_sha,
    producerEvent: run.event,
    contentSha256: arm.contentSha256,
    authoritySha256: arm.value.authoritySha256,
    prerequisiteSha256: arm.value.prerequisiteSha256,
    providerSnapshotSha256: arm.value.providerSnapshotSha256,
    providerInvariantSha256: arm.value.providerInvariantSha256,
  };
}

export async function inventoryAccountDeletionRehearsalAttempts(overrides = {}) {
  const env = overrides.env ?? process.env;
  const fetchImpl = overrides.fetchImpl ?? fetch;
  if (env.GITHUB_REPOSITORY !== REPOSITORY || !env.GITHUB_TOKEN
    || !SHA.test(env.PINTPATH_ACCOUNT_DELETION_CANDIDATE_SHA ?? "")
    || !RUN_ID.test(env.PINTPATH_ACCOUNT_DELETION_ACTIVATION_RUN_ID ?? "")) {
    throw new Error("attempt_inventory_authority_invalid");
  }
  const candidateSha = env.PINTPATH_ACCOUNT_DELETION_CANDIDATE_SHA;
  const activationRunId = env.PINTPATH_ACCOUNT_DELETION_ACTIVATION_RUN_ID;
  const currentRunId = RUN_ID.test(env.GITHUB_RUN_ID ?? "")
    ? env.GITHUB_RUN_ID : null;
  const runCache = new Map();
  const attempts = {};
  for (const operation of ACCOUNT_DELETION_REHEARSAL_ATTEMPT_OPERATIONS) {
    attempts[operation] = await inspectOperation(
      fetchImpl,
      env.GITHUB_TOKEN,
      operation,
      candidateSha,
      activationRunId,
      runCache,
      currentRunId,
    );
  }
  return {
    schemaVersion: ACCOUNT_DELETION_REHEARSAL_ATTEMPT_INVENTORY_SCHEMA,
    repository: REPOSITORY,
    candidateSha,
    activationRunId,
    attempts,
    complete: true,
    mutationCredentialExposed: false,
    secretMaterialIncluded: false,
  };
}

export async function runAccountDeletionRehearsalAttemptInventory(
  overrides = {},
) {
  const writeOutput = overrides.writeOutput
    ?? ((source) => process.stdout.write(source));
  try {
    const result = await inventoryAccountDeletionRehearsalAttempts(overrides);
    writeOutput(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch {
    writeOutput(`${JSON.stringify({
      schemaVersion: ACCOUNT_DELETION_REHEARSAL_ATTEMPT_INVENTORY_SCHEMA,
      complete: false,
      mutationCredentialExposed: false,
      secretMaterialIncluded: false,
    })}\n`);
    return 1;
  }
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runAccountDeletionRehearsalAttemptInventory();
}

export const accountDeletionRehearsalAttemptInventoryInternals = {
  canonical,
  exactKeys,
  inspectOperation,
  listExactArtifacts,
  parseAttemptArm,
  parseAttemptResult,
  producerRunExact,
  workflowPathExact,
};
