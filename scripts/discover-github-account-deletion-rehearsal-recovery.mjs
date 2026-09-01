import path from "node:path";
import { fileURLToPath } from "node:url";

import { githubGet } from "./verify-github-release-candidate.mjs";
import { downloadGithubArtifactBundle } from
  "./lib/github-artifact-bundle.mjs";
import {
  validateAccountDeletionRehearsalArmBundle,
  validateAccountDeletionRehearsalCloseoutBundle,
} from "./finalize-account-deletion-rehearsal-closeout.mjs";
import { inventoryAccountDeletionRehearsalAttempts } from
  "./inventory-github-account-deletion-rehearsal-attempts.mjs";

export const ACCOUNT_DELETION_REHEARSAL_GUARDIAN_DISCOVERY_SCHEMA =
  "pintpath-account-deletion-rehearsal-guardian-discovery/v1";

const REPOSITORY = "blackmagic30/Beer";
const MAIN_WORKFLOW_ID =
  "permanent-staging-account-deletion-rehearsal.yml";
const MAIN_WORKFLOW_NAME =
  "Rehearse Pint Path permanent-staging account deletion";
const MAIN_WORKFLOW_PATH =
  ".github/workflows/permanent-staging-account-deletion-rehearsal.yml";
const RECONCILE_WORKFLOW_NAME =
  "Reconcile Pint Path account-deletion rehearsal cleanup";
const RECONCILE_WORKFLOW_PATH =
  ".github/workflows/reconcile-permanent-staging-account-deletion-rehearsal.yml";
const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const PER_PAGE = 100;
const MAX_RUN_PAGES = 10;
const MAX_ARTIFACT_PAGES = 10;
const DISCOVERY_EPOCH = Date.parse("2026-09-01T00:00:00.000Z");
const DISCOVERY_HORIZON_MS = 89 * 24 * 60 * 60 * 1_000;
const MAIN_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);
const RECONCILE_EVENTS = new Set([
  "workflow_run",
  "workflow_dispatch",
  "schedule",
]);
const ARM_ENTRIES = Object.freeze([
  "cleanup-arm.json",
  "github-authority.json",
]);
const CLOSEOUT_ENTRIES = Object.freeze([
  "closeout.json",
  "provider-evidence.json",
  "authority.json",
  "attempt-inventory.json",
]);
const UNTRUSTED_CLOSEOUT_ERRORS = new Set([
  "artifact_archive_invalid",
  "artifact_authority_invalid",
  "artifact_digest_mismatch",
  "artifact_entries_invalid",
  "artifact_entry_invalid",
  "authority_invalid",
  "cleanup_arm_invalid",
  "closeout_expectation_invalid",
  "closeout_invalid",
  "containment_terminal_state_invalid",
  "provider_evidence_invalid",
  "attempt_inventory_invalid",
]);

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function workflowPathExact(actual, expected) {
  return actual === expected || actual === `${expected}@main`;
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function runIdExact(value) {
  return Number.isSafeInteger(value) && value > 0 && RUN_ID.test(String(value));
}

function repositoryExact(run) {
  return record(run.repository) && run.repository.full_name === REPOSITORY;
}

function completedLatestRunExact(run, expectedRunId) {
  return record(run)
    && runIdExact(run.id)
    && String(run.id) === expectedRunId
    && Number.isSafeInteger(run.run_attempt)
    && run.run_attempt >= 1
    && run.status === "completed"
    && repositoryExact(run);
}

async function immutableAttemptOneRun(fetchImpl, token, latestRun) {
  const runId = String(latestRun?.id ?? "");
  if (!RUN_ID.test(runId) || !completedLatestRunExact(latestRun, runId)) {
    return null;
  }
  if (latestRun.run_attempt === 1) return latestRun;
  const firstAttempt = await githubGet(
    fetchImpl,
    token,
    REPOSITORY,
    `/actions/runs/${runId}/attempts/1`,
  );
  return record(firstAttempt)
      && String(firstAttempt.id) === runId
      && firstAttempt.run_attempt === 1
    ? firstAttempt : null;
}

function mainRunExact(run) {
  return record(run)
    && runIdExact(run.id)
    && run.run_attempt === 1
    && run.status === "completed"
    && MAIN_CONCLUSIONS.has(run.conclusion)
    && run.name === MAIN_WORKFLOW_NAME
    && workflowPathExact(run.path, MAIN_WORKFLOW_PATH)
    && run.event === "workflow_dispatch"
    && run.head_branch === "main"
    && SHA.test(run.head_sha)
    && repositoryExact(run);
}

function closeoutProducerRunExact(run, {
  expectedRunId,
  expectedMode,
  expectedCandidateSha,
}) {
  const original = expectedMode === "original";
  const expectedPath = original ? MAIN_WORKFLOW_PATH : RECONCILE_WORKFLOW_PATH;
  const expectedName = original ? MAIN_WORKFLOW_NAME : RECONCILE_WORKFLOW_NAME;
  return record(run)
    && runIdExact(run.id)
    && String(run.id) === expectedRunId
    && run.run_attempt === 1
    && run.status === "completed"
    && run.conclusion === "success"
    && run.name === expectedName
    && workflowPathExact(run.path, expectedPath)
    && (original
      ? run.event === "workflow_dispatch"
      : RECONCILE_EVENTS.has(run.event))
    && run.head_branch === "main"
    && SHA.test(run.head_sha)
    && (!original || run.head_sha === expectedCandidateSha)
    && repositoryExact(run);
}

function validListing(listing, field) {
  return record(listing)
    && Number.isSafeInteger(listing.total_count)
    && listing.total_count >= 0
    && Array.isArray(listing[field])
    && listing[field].length <= PER_PAGE;
}

async function listCompletedRuns(fetchImpl, token, now) {
  if (!Number.isFinite(now) || now < DISCOVERY_EPOCH
    || now >= DISCOVERY_EPOCH + DISCOVERY_HORIZON_MS) {
    throw new Error("discovery_epoch_expired");
  }
  const runs = [];
  const seen = new Set();
  let expectedTotal = null;
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const listing = await githubGet(
      fetchImpl,
      token,
      REPOSITORY,
      `/actions/workflows/${MAIN_WORKFLOW_ID}/runs`
        + `?event=workflow_dispatch&status=completed&branch=main`
        + `&per_page=${PER_PAGE}&page=${page}`,
    );
    if (!validListing(listing, "workflow_runs")) {
      throw new Error("run_listing_invalid");
    }
    if (expectedTotal === null) expectedTotal = listing.total_count;
    if (listing.total_count !== expectedTotal) {
      throw new Error("run_listing_changed");
    }
    const offset = (page - 1) * PER_PAGE;
    const expectedLength = Math.min(
      PER_PAGE,
      Math.max(0, expectedTotal - offset),
    );
    if (listing.workflow_runs.length !== expectedLength) {
      throw new Error("run_listing_incomplete");
    }
    for (const latestRun of listing.workflow_runs) {
      const id = String(latestRun?.id ?? "");
      if (!RUN_ID.test(id) || seen.has(id)) {
        throw new Error("run_listing_ambiguous");
      }
      seen.add(id);
      const run = await immutableAttemptOneRun(fetchImpl, token, latestRun);
      if (!run) throw new Error("main_run_invalid");
      const completedAt = timestamp(run.updated_at);
      if (completedAt === null || completedAt > now) {
        throw new Error("run_timestamp_invalid");
      }
      if (completedAt < DISCOVERY_EPOCH) continue;
      if (!mainRunExact(run)) throw new Error("main_run_invalid");
      runs.push(run);
    }
    if (offset + expectedLength >= expectedTotal) {
      return runs.sort((left, right) => {
        const timeDifference = timestamp(left.updated_at)
          - timestamp(right.updated_at);
        return timeDifference || (BigInt(left.id) < BigInt(right.id) ? -1 : 1);
      });
    }
  }
  throw new Error("run_discovery_incomplete");
}

async function listAllArtifacts(fetchImpl, token, endpoint, failureCode) {
  const artifacts = [];
  const seen = new Set();
  let expectedTotal = null;
  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const listing = await githubGet(
      fetchImpl,
      token,
      REPOSITORY,
      `${endpoint}${separator}per_page=${PER_PAGE}&page=${page}`,
    );
    if (!validListing(listing, "artifacts")) throw new Error(failureCode);
    if (expectedTotal === null) {
      expectedTotal = listing.total_count;
      if (expectedTotal > MAX_ARTIFACT_PAGES * PER_PAGE) {
        throw new Error("artifact_discovery_incomplete");
      }
    }
    if (listing.total_count !== expectedTotal) {
      throw new Error("artifact_listing_changed");
    }
    const offset = (page - 1) * PER_PAGE;
    const expectedLength = Math.min(
      PER_PAGE,
      Math.max(0, expectedTotal - offset),
    );
    if (listing.artifacts.length !== expectedLength) {
      throw new Error("artifact_listing_incomplete");
    }
    for (const artifact of listing.artifacts) {
      if (!record(artifact) || !Number.isSafeInteger(artifact.id)
        || artifact.id <= 0 || typeof artifact.name !== "string"
        || seen.has(artifact.id)) {
        throw new Error("artifact_listing_ambiguous");
      }
      seen.add(artifact.id);
      artifacts.push(artifact);
    }
    if (offset + expectedLength >= expectedTotal) return artifacts;
  }
  throw new Error("artifact_discovery_incomplete");
}

async function listRunArtifacts(fetchImpl, token, runId) {
  return listAllArtifacts(
    fetchImpl,
    token,
    `/actions/runs/${runId}/artifacts`,
    "artifact_listing_invalid",
  );
}

async function listNamedArtifacts(fetchImpl, token, name) {
  const artifacts = await listAllArtifacts(
    fetchImpl,
    token,
    `/actions/artifacts?name=${encodeURIComponent(name)}`,
    "closeout_listing_invalid",
  );
  if (artifacts.some((artifact) => artifact.name !== name)) {
    throw new Error("closeout_listing_invalid");
  }
  return artifacts;
}

function decodeEntry(entries, leaf) {
  try {
    const bytes = entries.get(leaf);
    if (!Buffer.isBuffer(bytes)) throw new Error("artifact_entry_invalid");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("artifact_entry_invalid");
  }
}

async function downloadArmBundle(
  fetchImpl,
  token,
  artifact,
  candidateSha,
  activationRunId,
) {
  const expectedName =
    `pintpath-account-deletion-rehearsal-arm-${candidateSha}`
    + `-${activationRunId}`;
  const entries = await downloadGithubArtifactBundle({
    artifact,
    repository: REPOSITORY,
    expectedName,
    expectedRunId: activationRunId,
    expectedEntries: ARM_ENTRIES,
    token,
    fetchImpl,
  });
  const cleanupArmSource = decodeEntry(entries, "cleanup-arm.json");
  const originalAuthoritySource = decodeEntry(
    entries,
    "github-authority.json",
  );
  validateAccountDeletionRehearsalArmBundle({
    cleanupArmSource,
    authoritySource: originalAuthoritySource,
    expectedCandidateSha: candidateSha,
    expectedActivationRunId: activationRunId,
  });
  return { cleanupArmSource, originalAuthoritySource };
}

function invalidCloseoutError(error) {
  return error instanceof Error && UNTRUSTED_CLOSEOUT_ERRORS.has(error.message);
}

async function closeoutArtifactTrusted({
  fetchImpl,
  token,
  artifact,
  expectedName,
  expectedMode,
  candidateSha,
  activationRunId,
  cleanupArmSource,
  originalAuthoritySource,
  inventoryImpl,
}) {
  try {
    const producerRunId = String(artifact?.workflow_run?.id ?? "");
    if (!RUN_ID.test(producerRunId)) return false;
    const latestProducer = await githubGet(
      fetchImpl,
      token,
      REPOSITORY,
      `/actions/runs/${producerRunId}`,
    );
    const producer = await immutableAttemptOneRun(
      fetchImpl,
      token,
      latestProducer,
    );
    if (!closeoutProducerRunExact(producer, {
      expectedRunId: producerRunId,
      expectedMode,
      expectedCandidateSha: candidateSha,
    })) return false;
    const entries = await downloadGithubArtifactBundle({
      artifact,
      repository: REPOSITORY,
      expectedName,
      expectedRunId: producerRunId,
      expectedEntries: CLOSEOUT_ENTRIES,
      token,
      fetchImpl,
    });
    const closeoutSource = decodeEntry(entries, "closeout.json");
    const providerEvidenceSource = decodeEntry(
      entries,
      "provider-evidence.json",
    );
    const authoritySource = decodeEntry(entries, "authority.json");
    const attemptInventorySource = decodeEntry(
      entries,
      "attempt-inventory.json",
    );
    if (expectedMode === "original"
      && authoritySource !== originalAuthoritySource) return false;
    validateAccountDeletionRehearsalCloseoutBundle({
      closeoutSource,
      providerEvidenceSource,
      authoritySource,
      cleanupArmSource,
      attemptInventorySource,
      expectedMode,
      expectedCandidateSha: candidateSha,
      expectedActivationRunId: activationRunId,
      expectedProducerRunId: producerRunId,
      expectedImplementationSha: producer.head_sha,
    });
    const liveInventory = await inventoryImpl({
      env: {
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_TOKEN: token,
        PINTPATH_ACCOUNT_DELETION_CANDIDATE_SHA: candidateSha,
        PINTPATH_ACCOUNT_DELETION_ACTIVATION_RUN_ID: activationRunId,
      },
      fetchImpl,
    });
    return canonical(liveInventory) === attemptInventorySource;
  } catch (error) {
    if (invalidCloseoutError(error)) return false;
    throw error;
  }
}

async function hasTrustedReconcileCloseout({
  fetchImpl,
  token,
  candidateSha,
  activationRunId,
  cleanupArmSource,
  originalAuthoritySource,
  inventoryImpl,
}) {
  const name =
    `pintpath-account-deletion-rehearsal-reconcile-closeout-${candidateSha}`
    + `-${activationRunId}`;
  const artifacts = await listNamedArtifacts(fetchImpl, token, name);
  for (const artifact of artifacts) {
    if (await closeoutArtifactTrusted({
      fetchImpl,
      token,
      artifact,
      expectedName: name,
      expectedMode: "reconcile",
      candidateSha,
      activationRunId,
      cleanupArmSource,
      originalAuthoritySource,
      inventoryImpl,
    })) return true;
  }
  return false;
}

export async function discoverAccountDeletionRehearsalRecovery(overrides = {}) {
  const env = overrides.env ?? process.env;
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const now = overrides.now?.() ?? Date.now();
  const inventoryImpl = overrides.inventoryImpl
    ?? inventoryAccountDeletionRehearsalAttempts;
  if (env.GITHUB_REPOSITORY !== REPOSITORY || !env.GITHUB_TOKEN
    || typeof inventoryImpl !== "function") {
    throw new Error("guardian_authority_invalid");
  }
  const runs = await listCompletedRuns(fetchImpl, env.GITHUB_TOKEN, now);
  for (const run of runs) {
    const activationRunId = String(run.id);
    const candidateSha = run.head_sha;
    const artifacts = await listRunArtifacts(
      fetchImpl,
      env.GITHUB_TOKEN,
      activationRunId,
    );
    const armName =
      `pintpath-account-deletion-rehearsal-arm-${candidateSha}`
      + `-${activationRunId}`;
    const armArtifacts = artifacts.filter(({ name }) => name === armName);
    if (armArtifacts.length === 0) continue;
    if (armArtifacts.length !== 1) throw new Error("cleanup_arm_ambiguous");
    const { cleanupArmSource, originalAuthoritySource } =
      await downloadArmBundle(
        fetchImpl,
        env.GITHUB_TOKEN,
        armArtifacts[0],
        candidateSha,
        activationRunId,
      );

    const originalCloseoutName =
      `pintpath-account-deletion-rehearsal-closeout-${candidateSha}`
      + `-${activationRunId}`;
    const originalCloseouts = artifacts.filter(
      ({ name }) => name === originalCloseoutName,
    );
    if (originalCloseouts.length > 1) {
      throw new Error("original_closeout_ambiguous");
    }
    let disarmed = false;
    if (run.conclusion === "success" && originalCloseouts.length === 1) {
      disarmed = await closeoutArtifactTrusted({
        fetchImpl,
        token: env.GITHUB_TOKEN,
        artifact: originalCloseouts[0],
        expectedName: originalCloseoutName,
        expectedMode: "original",
        candidateSha,
        activationRunId,
        cleanupArmSource,
        originalAuthoritySource,
        inventoryImpl,
      });
    }
    if (!disarmed) {
      disarmed = await hasTrustedReconcileCloseout({
        fetchImpl,
        token: env.GITHUB_TOKEN,
        candidateSha,
        activationRunId,
        cleanupArmSource,
        originalAuthoritySource,
        inventoryImpl,
      });
    }
    if (disarmed) continue;

    return {
      schemaVersion: ACCOUNT_DELETION_REHEARSAL_GUARDIAN_DISCOVERY_SCHEMA,
      outcome: "recovery_required",
      activationRunId,
      candidateSha,
      originalConclusion: run.conclusion,
      secretMaterialIncluded: false,
    };
  }
  return {
    schemaVersion: ACCOUNT_DELETION_REHEARSAL_GUARDIAN_DISCOVERY_SCHEMA,
    outcome: "no_recovery_required",
    activationRunId: null,
    candidateSha: null,
    originalConclusion: null,
    secretMaterialIncluded: false,
  };
}

export async function runAccountDeletionRehearsalRecoveryDiscovery(
  overrides = {},
) {
  const writeOutput = overrides.writeOutput
    ?? ((source) => process.stdout.write(source));
  try {
    const result = await discoverAccountDeletionRehearsalRecovery(overrides);
    writeOutput(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    writeOutput(`${JSON.stringify({
      schemaVersion: ACCOUNT_DELETION_REHEARSAL_GUARDIAN_DISCOVERY_SCHEMA,
      outcome: "blocked",
      activationRunId: null,
      candidateSha: null,
      originalConclusion: null,
      secretMaterialIncluded: false,
    })}\n`);
    return 1;
  }
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runAccountDeletionRehearsalRecoveryDiscovery();
}

export const accountDeletionRehearsalRecoveryDiscoveryInternals = {
  canonical,
  closeoutArtifactTrusted,
  closeoutProducerRunExact,
  completedLatestRunExact,
  decodeEntry,
  hasTrustedReconcileCloseout,
  immutableAttemptOneRun,
  listAllArtifacts,
  listCompletedRuns,
  listNamedArtifacts,
  listRunArtifacts,
  mainRunExact,
  workflowPathExact,
};
