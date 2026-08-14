import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalProductionPromotionRecoveryActivationJson,
  PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_EVIDENCE,
  PRODUCTION_PROMOTION_RECOVERY_CLEANUP_EVIDENCE,
  verifyProductionPromotionRecoveryActivationEvidence,
} from "./create-production-promotion-recovery-activation-receipt.mjs";
import {
  holdPrivateDirectoryIdentity,
  readTrustedRegularFile,
} from "./lib/trusted-filesystem.js";

const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_EVIDENCE_BYTES = 128 * 1024 * 1024;
export const PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_FILES = Object.freeze([
  "activation-receipt.json",
  ...PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_EVIDENCE,
  "tested-commit-sha.txt",
].sort());

function fail(code) {
  throw new Error(`production_promotion_recovery_activation_${code}`);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function exactTimestamp(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail("receipt_invalid");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("receipt_invalid");
  }
  return value;
}

function parseArgs(argv) {
  if (argv.length !== 8) fail("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) fail("arguments_invalid");
    values.set(key, value);
  }
  const directory = values.get("--directory") ?? "";
  const candidateSha = values.get("--candidate-sha") ?? "";
  const runId = values.get("--run-id") ?? "";
  const githubAuthority = values.get("--github-authority") ?? "";
  if (values.size !== 4 || !path.isAbsolute(directory) || path.resolve(directory) !== directory
    || directory.includes("\0") || !SHA.test(candidateSha) || !RUN_ID.test(runId)
    || !path.isAbsolute(githubAuthority) || path.resolve(githubAuthority) !== githubAuthority
    || githubAuthority.includes("\0")) fail("arguments_invalid");
  return { directory, candidateSha, runId, githubAuthority };
}

function parseJson(bytes, code) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
    return value;
  } catch {
    return fail(code);
  }
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  holdDirectory: (directory) => holdPrivateDirectoryIdentity(directory, {
    requireExactDirectoryMode: true, requireOwner: true,
  }),
  readFile: (filename) => readTrustedRegularFile(filename, {
    minBytes: 1, maxBytes: MAX_EVIDENCE_BYTES, requirePrivate: true, requireOwner: true,
  }),
  listDirectory: (directory) => fs.readdirSync(directory).sort(),
});

function readHeldDirectory(directory, expectedLeaves, dependencies) {
  const held = dependencies.holdDirectory(directory);
  let closed = false;
  try {
    held.assertExact();
    const observed = dependencies.listDirectory(directory);
    held.assertExact();
    if (JSON.stringify(observed) !== JSON.stringify([...expectedLeaves].sort())) {
      fail("inventory_invalid");
    }
    const files = Object.fromEntries(expectedLeaves.map((leaf) => {
      held.assertExact();
      const bytes = dependencies.readFile(path.join(directory, leaf));
      held.assertExact();
      return [leaf, { bytes, sha256: sha256(bytes) }];
    }));
    held.assertExact();
    held.close();
    closed = true;
    return files;
  } finally {
    if (!closed) {
      try {
        held.close();
      } catch {
        fail("directory_unsafe");
      }
    }
  }
}

function readHeldFile(filename, dependencies) {
  const directory = path.dirname(filename);
  const held = dependencies.holdDirectory(directory);
  let closed = false;
  try {
    held.assertExact();
    const bytes = dependencies.readFile(filename);
    held.assertExact();
    held.close();
    closed = true;
    return bytes;
  } finally {
    if (!closed) {
      try {
        held.close();
      } catch {
        fail("directory_unsafe");
      }
    }
  }
}

export function verifyProductionPromotionRecoveryActivation(input, overrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const files = readHeldDirectory(
    input.directory, PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_FILES, dependencies,
  );
  const githubAuthorityBytes = readHeldFile(input.githubAuthority, dependencies);
  const githubAuthority = parseJson(githubAuthorityBytes, "github_authority_invalid");
  if (!exactKeys(githubAuthority, [
    "schemaVersion", "kind", "repository", "candidateSha", "workflowPath",
    "workflowRunId", "workflowRunAttempt", "workflowRunStartedAt", "workflowEvent",
    "workflowConclusion",
    "artifactName", "artifactId", "artifactDigest", "artifactSizeBytes", "artifactExpired",
  ]) || githubAuthority.schemaVersion !== 1
    || githubAuthority.kind !== "pintpath-production-promotion-recovery-activation-github-authority"
    || !REPOSITORY.test(String(githubAuthority.repository))
    || githubAuthority.candidateSha !== input.candidateSha
    || githubAuthority.workflowPath !== ".github/workflows/activate-production-promotion-recovery.yml"
    || githubAuthority.workflowRunId !== input.runId
    || githubAuthority.workflowRunAttempt !== 1
    || githubAuthority.workflowEvent !== "workflow_dispatch"
    || githubAuthority.workflowConclusion !== "success"
    || githubAuthority.artifactName
      !== `pintpath-production-promotion-recovery-activation-${input.candidateSha}`
    || !RUN_ID.test(String(githubAuthority.artifactId))
    || !/^sha256:[a-f0-9]{64}$/.test(String(githubAuthority.artifactDigest))
    || !Number.isSafeInteger(githubAuthority.artifactSizeBytes)
    || githubAuthority.artifactSizeBytes < 1
    || githubAuthority.artifactExpired !== false) fail("github_authority_invalid");
  const workflowRunStartedAt = exactTimestamp(githubAuthority.workflowRunStartedAt);
  if (files["tested-commit-sha.txt"].bytes.toString("utf8") !== `${input.candidateSha}\n`) {
    fail("candidate_mismatch");
  }
  const receipt = parseJson(files["activation-receipt.json"].bytes, "receipt_invalid");
  if (!exactKeys(receipt, [
    "schemaVersion", "kind", "candidateSha", "producerWorkflow",
    "producerRunId", "producerRunAttempt", "completedAt",
    "targetProjectIdSha256", "targetEnvironmentIdSha256",
    "targetDatabaseIdentitySha256", "targetSupabaseOriginSha256",
    "evidence", "evidenceAggregateSha256", "cleanupEvidenceAggregateSha256",
    "allOperationsExact", "targetAbsent", "receiptSha256",
  ]) || receipt.schemaVersion !== 1
    || receipt.kind !== "pintpath-production-promotion-recovery-activation"
    || receipt.candidateSha !== input.candidateSha
    || receipt.producerWorkflow !== "activate-production-promotion-recovery.yml"
    || receipt.producerRunId !== input.runId || receipt.producerRunAttempt !== "1"
    || receipt.allOperationsExact !== true || receipt.targetAbsent !== true
    || !SHA256.test(String(receipt.targetProjectIdSha256))
    || !SHA256.test(String(receipt.targetEnvironmentIdSha256))
    || !SHA256.test(String(receipt.targetDatabaseIdentitySha256))
    || !SHA256.test(String(receipt.targetSupabaseOriginSha256))) fail("receipt_invalid");
  const completedAt = exactTimestamp(receipt.completedAt);
  if (Date.parse(workflowRunStartedAt) > Date.parse(completedAt)) fail("receipt_invalid");
  const expectedEvidence = PRODUCTION_PROMOTION_RECOVERY_ACTIVATION_EVIDENCE.map((leaf) => ({
    leaf, sha256: files[leaf].sha256,
  }));
  const expectedCleanupEvidence = PRODUCTION_PROMOTION_RECOVERY_CLEANUP_EVIDENCE.map(
    (leaf) => ({ leaf, sha256: files[leaf].sha256 }),
  );
  if (JSON.stringify(receipt.evidence) !== JSON.stringify(expectedEvidence)
    || receipt.evidenceAggregateSha256
      !== sha256(canonicalProductionPromotionRecoveryActivationJson(expectedEvidence))
    || receipt.cleanupEvidenceAggregateSha256
      !== sha256(canonicalProductionPromotionRecoveryActivationJson(expectedCleanupEvidence))) {
    fail("evidence_mismatch");
  }
  const { receiptSha256, ...withoutHash } = receipt;
  if (receiptSha256 !== sha256(canonicalProductionPromotionRecoveryActivationJson(withoutHash))) {
    fail("receipt_hash_mismatch");
  }
  let cleanup;
  try {
    cleanup = verifyProductionPromotionRecoveryActivationEvidence(files, {
      candidateSha: input.candidateSha,
      runId: input.runId,
      targetProjectIdSha256: receipt.targetProjectIdSha256,
      targetEnvironmentIdSha256: receipt.targetEnvironmentIdSha256,
      targetDatabaseIdentitySha256: receipt.targetDatabaseIdentitySha256,
      targetSupabaseOriginSha256: receipt.targetSupabaseOriginSha256,
    });
  } catch {
    fail("evidence_invalid");
  }
  if (Date.parse(completedAt) < Math.max(
    Date.parse(cleanup.railwayCompletedAt), Date.parse(cleanup.supabaseCompletedAt),
  )) fail("receipt_invalid");
  return receipt;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const receipt = verifyProductionPromotionRecoveryActivation(args);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    candidateSha: receipt.candidateSha,
    receiptSha256: receipt.receiptSha256,
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "activation_invalid"}\n`);
    process.exitCode = 1;
  }
}
