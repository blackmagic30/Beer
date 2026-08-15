import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  productionRecoveryLogicalOffsiteResultSchema,
  productionRecoveryLogicalOffsiteRetrievalSchema,
  productionRecoveryLogicalWormResultSchema,
} from "../src/lib/production-promotion-recovery.js";

const REPOSITORY = "blackmagic30/Beer";
const WORKFLOW_PATH = ".github/workflows/production-logical-backup.yml";
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_BACKUP_AGE_MS = 2 * 60 * 60 * 1000;
const MINIMUM_WORM_RETENTION_MS = 29 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const BACKUP_ENTRIES = Object.freeze([
  "logical-backup-result.json",
  "logical-offsite-result.json",
  "logical-worm-result.json",
]);
const RESTORE_ENTRIES = Object.freeze([
  "retrieval-result.json",
  "target-inspection.json",
  "restore-receipt.json",
  "restore-result.json",
]);

const receiptSha256 = z.string().regex(SHA256);
const receiptTimestamp = z
  .string()
  .datetime({ offset: false, precision: 3 })
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  );
const backupResultSchema = z
  .object({
    schemaVersion: z.literal(3),
    ok: z.literal(true),
    archiveSha256: receiptSha256,
    manifestSha256: receiptSha256,
    stateReceiptSha256: receiptSha256,
    authoritativeRowCount: z.string().regex(/^(?:0|[1-9]\d*)$/),
    overallStateSha256: receiptSha256,
  })
  .strict();
const targetInspectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.literal(true),
    command: z.literal("inspect-target"),
    targetIdentitySha256: receiptSha256,
    disposableTarget: z.literal(true),
    privateSchemasAbsent: z.literal(true),
  })
  .strict();
const restoreReceiptSchema = z
  .object({
    kind: z.literal("pintpath-postgres-logical-restore-rehearsal"),
    version: z.literal(1),
    status: z.literal("verified"),
    restoredAt: receiptTimestamp,
    backupManifestSha256: receiptSha256,
    backupArchiveSha256: receiptSha256,
    targetIdentitySha256: receiptSha256,
    targetUrlSha256: receiptSha256,
    authoritativeTableCount: z.number().int().positive(),
    authoritativeColumnCount: z.number().int().positive(),
    foreignKeyCount: z.number().int().nonnegative(),
    authoritativeRowCount: z.string().regex(/^(?:0|[1-9]\d*)$/),
    nonEmptyAuthoritativeTableCount: z.number().int().nonnegative(),
    authoritativeCountInventorySha256: receiptSha256,
    controlCountInventorySha256: receiptSha256,
    schemaMetadataSha256: receiptSha256,
    rowSecurityTableCount: z.number().int().nonnegative(),
    aclContractSha256: receiptSha256,
    apiRolesIsolated: z.literal(true),
    runtimeApplicationAccessRestored: z.literal(true),
    migratorReconciliationAccessVerified: z.literal(true),
    runtimeOperationsIsolated: z.literal(true),
    promotionReconciliationReady: z.literal(true),
    sourceStateBindingStatus: z.literal("exact-match"),
    expectedSourceStateReceiptSha256: receiptSha256,
    sourceSnapshotBindingSha256: receiptSha256,
    expectedSourceTableSetSha256: receiptSha256,
    expectedSourceDataSha256: receiptSha256,
    expectedSourceStateTotalsSha256: receiptSha256,
    expectedSourceKeyRangesSha256: receiptSha256,
    expectedArchivedControlTableSetSha256: receiptSha256,
    expectedArchivedControlDataSha256: receiptSha256,
    expectedArchivedControlKeyRangesSha256: receiptSha256,
    expectedSourceOverallStateSha256: receiptSha256,
    restoredOverallStateSha256: receiptSha256,
    exactDataReconciliation: z.literal("canonical-contract-exact"),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.nonEmptyAuthoritativeTableCount > value.authoritativeTableCount ||
      value.restoredOverallStateSha256 !== value.expectedSourceOverallStateSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "logical restore relation mismatch",
      });
    }
  });
const restoreResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.literal(true),
    command: z.literal("restore"),
    receiptSha256,
    backupManifestSha256: receiptSha256,
    backupArchiveSha256: receiptSha256,
    targetIdentitySha256: receiptSha256,
    authoritativeRowCount: z.string().regex(/^(?:0|[1-9]\d*)$/),
    nonEmptyAuthoritativeTableCount: z.number().int().nonnegative(),
    authoritativeCountInventorySha256: receiptSha256,
    overallStateSha256: receiptSha256,
    promotionReconciliationReady: z.literal(true),
    sourceStateBindingStatus: z.literal("exact-match"),
  })
  .strict();

function fail(code = "invalid") {
  throw new Error(`production_postgres_source_pin_recovery_${code}`);
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sameFile(left, right) {
  return left.isFile() && right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function canonicalAuthorityPath(filename) {
  if (path.resolve(filename) !== filename) return false;
  const resolved = fs.realpathSync(filename);
  return resolved === filename ||
    (process.platform !== "linux" && process.env.VITEST === "true");
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function timestamp(value, code = "receipt_invalid") {
  if (typeof value !== "string") fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(code);
  return milliseconds;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) fail("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !["--candidate-sha", "--backup-run-id", "--output"].includes(key) ||
      typeof value !== "string" ||
      value.length === 0 ||
      values.has(key)
    ) fail("arguments_invalid");
    values.set(key, value);
  }
  const candidateSha = values.get("--candidate-sha") ?? "";
  const backupRunId = values.get("--backup-run-id") ?? "";
  const output = values.get("--output") ?? "";
  if (
    !SHA.test(candidateSha) ||
    !RUN_ID.test(backupRunId) ||
    !path.isAbsolute(output) ||
    path.resolve(output) !== output ||
    output.includes("\0")
  ) fail("arguments_invalid");
  return { candidateSha, backupRunId, output };
}

async function boundedBytes(response, maximum, expected = null) {
  if (!response.ok || !response.body) fail("github_response_invalid");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximum || (expected !== null && total > expected)) {
      await reader.cancel().catch(() => undefined);
      fail("github_response_invalid");
    }
    chunks.push(next.value);
  }
  if (expected !== null && total !== expected) fail("github_response_invalid");
  return Buffer.concat(chunks);
}

async function boundedJson(response) {
  const bytes = await boundedBytes(response, MAX_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("github_response_invalid");
  }
}

async function github(fetchImpl, token, endpoint, accept) {
  return fetchImpl(`https://api.github.com/repos/${REPOSITORY}${endpoint}`, {
    method: "GET",
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      "User-Agent": "pintpath-production-postgres-source-pin-recovery/1",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
}

function validateRun(value, args, now) {
  const createdAt = timestamp(value?.created_at, "run_invalid");
  const startedAt = timestamp(value?.run_started_at, "run_invalid");
  const completedAt = timestamp(value?.updated_at, "run_invalid");
  if (
    String(value?.id) !== args.backupRunId ||
    value?.repository?.full_name !== REPOSITORY ||
    value?.head_repository?.full_name !== REPOSITORY ||
    value?.head_sha !== args.candidateSha ||
    value?.head_branch !== "main" ||
    ![WORKFLOW_PATH, `${WORKFLOW_PATH}@main`].includes(value?.path) ||
    value?.event !== "workflow_dispatch" ||
    value?.run_attempt !== 1 ||
    value?.status !== "completed" ||
    value?.conclusion !== "success" ||
    createdAt > startedAt ||
    startedAt >= completedAt ||
    completedAt > now + MAX_FUTURE_SKEW_MS
  ) fail("run_invalid");
  return { createdAt, startedAt, completedAt };
}

function artifactFromListing(value, expectedName, runId, candidateSha) {
  if (
    !record(value) ||
    !positiveInteger(value.id) ||
    value.name !== expectedName ||
    !positiveInteger(value.size_in_bytes) ||
    value.size_in_bytes > MAX_ARTIFACT_BYTES ||
    !ARTIFACT_DIGEST.test(value.digest) ||
    value.expired !== false ||
    value?.workflow_run?.id !== runId ||
    value?.workflow_run?.head_sha !== candidateSha
  ) fail("artifact_listing_invalid");
  return {
    id: value.id,
    name: value.name,
    digest: value.digest,
    sizeBytes: value.size_in_bytes,
  };
}

async function materializeArtifact(input) {
  const metadata = await boundedJson(await github(
    input.fetchImpl,
    input.token,
    `/actions/artifacts/${input.artifact.id}`,
    "application/vnd.github+json",
  ));
  const archiveUrl =
    `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${input.artifact.id}/zip`;
  if (
    metadata?.id !== input.artifact.id ||
    metadata?.name !== input.artifact.name ||
    metadata?.digest !== input.artifact.digest ||
    metadata?.size_in_bytes !== input.artifact.sizeBytes ||
    metadata?.expired !== false ||
    metadata?.workflow_run?.id !== input.runId ||
    metadata?.workflow_run?.head_sha !== input.candidateSha ||
    metadata?.archive_download_url !== archiveUrl
  ) fail("artifact_metadata_invalid");
  const archive = await boundedBytes(
    await github(
      input.fetchImpl,
      input.token,
      `/actions/artifacts/${input.artifact.id}/zip`,
      "application/octet-stream",
    ),
    MAX_ARTIFACT_BYTES,
    input.artifact.sizeBytes,
  );
  if (`sha256:${sha256(archive)}` !== input.artifact.digest) {
    fail("artifact_digest_invalid");
  }
  return {
    entries: input.extractEntries(
      archive,
      input.custody,
      input.expectedEntries,
      input.artifact.id,
    ),
    receiptSetSha256: sha256(archive),
  };
}

function safeArchiveEntry(value) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 512 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\r\n\0]/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "..");
}

function defaultExtractEntries(
  archive,
  custody,
  expectedEntries,
  artifactId,
  spawnArchive = spawnSync,
) {
  if (!positiveInteger(artifactId)) fail("artifact_archive_invalid");
  const archiveLeaf = `.production-source-pin-recovery-${artifactId}.zip`;
  custody.writeLeaf(archiveLeaf, archive);
  const archiveAuthority = custody.openReadLeaf(archiveLeaf);
  const childArchivePath = process.platform === "linux"
    ? "/proc/self/fd/3"
    : "/dev/fd/3";
  let cleanupFailure = null;
  try {
    archiveAuthority.assertExact(archive);
    const listed = spawnArchive("/usr/bin/unzip", ["-Z1", childArchivePath], {
      encoding: "utf8",
      maxBuffer: MAX_JSON_BYTES,
      shell: false,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe", archiveAuthority.handle],
    });
    archiveAuthority.assertExact(archive);
    if (listed.status !== 0 || listed.signal !== null || listed.error) {
      fail("artifact_archive_invalid");
    }
    const names = listed.stdout.trimEnd().split("\n");
    if (
      names.length !== expectedEntries.length ||
      new Set(names).size !== names.length ||
      names.some((name) => !safeArchiveEntry(name)) ||
      expectedEntries.some((name) => names.filter((entry) => entry === name).length !== 1)
    ) fail("artifact_archive_invalid");
    const entries = new Map();
    for (const name of expectedEntries) {
      archiveAuthority.assertExact(archive);
      const extracted = spawnArchive("/usr/bin/unzip", ["-p", childArchivePath, name], {
        encoding: null,
        maxBuffer: MAX_JSON_BYTES,
        shell: false,
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe", archiveAuthority.handle],
      });
      archiveAuthority.assertExact(archive);
      if (
        extracted.status !== 0 ||
        extracted.signal !== null ||
        extracted.error ||
        !Buffer.isBuffer(extracted.stdout) ||
        extracted.stdout.length <= 1 ||
        extracted.stdout.length > MAX_JSON_BYTES
      ) fail("artifact_archive_invalid");
      entries.set(name, extracted.stdout);
    }
    return entries;
  } finally {
    try {
      fs.closeSync(archiveAuthority.handle);
    } catch (error) {
      cleanupFailure = error;
    }
    try {
      custody.removeLeaf(archiveLeaf);
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (cleanupFailure !== null) fail("artifact_cleanup_failed");
  }
}

function jsonEntry(entries, name, schema) {
  const bytes = entries.get(name);
  if (!Buffer.isBuffer(bytes) || bytes.length <= 1 || bytes.length > MAX_JSON_BYTES) {
    fail("receipt_invalid");
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(source);
    if (canonicalPostgresBackupJson(parsed) !== source) fail("receipt_invalid");
    return { bytes, value: schema.parse(parsed) };
  } catch {
    fail("receipt_invalid");
  }
}

function validateReceipts(backupEntries, restoreEntries, now, runTimes) {
  const backupSource = jsonEntry(
    backupEntries,
    "logical-backup-result.json",
    backupResultSchema,
  );
  const offsiteSource = jsonEntry(
    backupEntries,
    "logical-offsite-result.json",
    productionRecoveryLogicalOffsiteResultSchema,
  );
  const wormSource = jsonEntry(
    backupEntries,
    "logical-worm-result.json",
    productionRecoveryLogicalWormResultSchema,
  );
  const retrievalSource = jsonEntry(
    restoreEntries,
    "retrieval-result.json",
    productionRecoveryLogicalOffsiteRetrievalSchema,
  );
  const targetSource = jsonEntry(
    restoreEntries,
    "target-inspection.json",
    targetInspectionSchema,
  );
  const restoreReceiptSource = jsonEntry(
    restoreEntries,
    "restore-receipt.json",
    restoreReceiptSchema,
  );
  const restoreSource = jsonEntry(
    restoreEntries,
    "restore-result.json",
    restoreResultSchema,
  );
  const backup = backupSource.value;
  const offsite = offsiteSource.value;
  const worm = wormSource.value;
  const retrieval = retrievalSource.value;
  const target = targetSource.value;
  const restoreReceipt = restoreReceiptSource.value;
  const restore = restoreSource.value;
  if (
    offsite.manifestSha256 !== backup.manifestSha256 ||
    offsite.archiveSha256 !== backup.archiveSha256 ||
    offsite.stateReceiptSha256 !== backup.stateReceiptSha256 ||
    offsite.overallStateSha256 !== backup.overallStateSha256 ||
    worm.backupCreatedAt !== offsite.backupCreatedAt ||
    worm.manifestSha256 !== backup.manifestSha256 ||
    worm.archiveSha256 !== backup.archiveSha256 ||
    worm.stateReceiptSha256 !== backup.stateReceiptSha256 ||
    worm.overallStateSha256 !== backup.overallStateSha256 ||
    worm.backupIdSha256 !== offsite.backupIdSha256 ||
    retrieval.successStateSha256 !== offsite.successStateSha256 ||
    retrieval.backupCreatedAt !== offsite.backupCreatedAt ||
    retrieval.backupIdSha256 !== offsite.backupIdSha256 ||
    retrieval.latestPointerSha256 !== offsite.latestPointerSha256 ||
    retrieval.attestationSha256 !== offsite.attestationSha256 ||
    retrieval.remoteObjectSetSha256 !== offsite.remoteObjectSetSha256 ||
    retrieval.manifestSha256 !== backup.manifestSha256 ||
    retrieval.archiveSha256 !== backup.archiveSha256 ||
    retrieval.stateReceiptSha256 !== backup.stateReceiptSha256 ||
    retrieval.overallStateSha256 !== backup.overallStateSha256 ||
    retrieval.sourceDatabaseIdentitySha256 !== offsite.sourceDatabaseIdentitySha256 ||
    restore.backupManifestSha256 !== backup.manifestSha256 ||
    restore.backupArchiveSha256 !== backup.archiveSha256 ||
    restore.overallStateSha256 !== backup.overallStateSha256 ||
    restore.targetIdentitySha256 !== target.targetIdentitySha256 ||
    sha256(restoreReceiptSource.bytes) !== restore.receiptSha256 ||
    restoreReceipt.backupManifestSha256 !== backup.manifestSha256 ||
    restoreReceipt.backupArchiveSha256 !== backup.archiveSha256 ||
    restoreReceipt.targetIdentitySha256 !== restore.targetIdentitySha256 ||
    restoreReceipt.authoritativeRowCount !== backup.authoritativeRowCount ||
    restoreReceipt.authoritativeRowCount !== restore.authoritativeRowCount ||
    restoreReceipt.nonEmptyAuthoritativeTableCount !==
      restore.nonEmptyAuthoritativeTableCount ||
    restoreReceipt.authoritativeCountInventorySha256 !==
      restore.authoritativeCountInventorySha256 ||
    restoreReceipt.expectedSourceStateReceiptSha256 !== backup.stateReceiptSha256 ||
    restoreReceipt.expectedSourceOverallStateSha256 !== backup.overallStateSha256 ||
    restoreReceipt.restoredOverallStateSha256 !== backup.overallStateSha256 ||
    restore.overallStateSha256 !== backup.overallStateSha256 ||
    target.targetIdentitySha256 === retrieval.sourceDatabaseIdentitySha256
  ) fail("receipt_invalid");
  const backupCreatedAt = timestamp(offsite.backupCreatedAt);
  const completedAt = timestamp(offsite.completedAt);
  const wormCompletedAt = timestamp(worm.completedAt);
  const retrievedAt = timestamp(retrieval.retrievedAt);
  const restoredAt = timestamp(restoreReceipt.restoredAt);
  const minimumRetainUntil = timestamp(worm.minimumRetainUntil);
  if (
    runTimes.startedAt > backupCreatedAt ||
    completedAt < backupCreatedAt ||
    wormCompletedAt < backupCreatedAt ||
    retrievedAt < Math.max(completedAt, wormCompletedAt) ||
    restoredAt < retrievedAt ||
    restoredAt > runTimes.completedAt ||
    [completedAt, wormCompletedAt, retrievedAt, restoredAt]
      .some((value) => value > now + MAX_FUTURE_SKEW_MS) ||
    now - Math.min(completedAt, wormCompletedAt) > MAX_BACKUP_AGE_MS ||
    minimumRetainUntil - now < MINIMUM_WORM_RETENTION_MS
  ) fail("receipt_stale");
  return {
    backupCreatedAt: offsite.backupCreatedAt,
    completedAt: offsite.completedAt,
    manifestSha256: backup.manifestSha256,
    archiveSha256: backup.archiveSha256,
    stateReceiptSha256: backup.stateReceiptSha256,
    overallStateSha256: backup.overallStateSha256,
    sourceDatabaseIdentitySha256: offsite.sourceDatabaseIdentitySha256,
    successStateSha256: offsite.successStateSha256,
    wormReceiptSha256: worm.receiptSha256,
    minimumRetainUntil: worm.minimumRetainUntil,
    retrievedAt: retrieval.retrievedAt,
    restoredAt: restoreReceipt.restoredAt,
    restoreReceiptSha256: restore.receiptSha256,
    restoreTargetIdentitySha256: restore.targetIdentitySha256,
    receiptFilesSha256: sha256(canonical({
      backup: sha256(backupSource.bytes),
      offsite: sha256(offsiteSource.bytes),
      worm: sha256(wormSource.bytes),
      retrieval: sha256(retrievalSource.bytes),
      target: sha256(targetSource.bytes),
      restoreReceipt: sha256(restoreReceiptSource.bytes),
      restore: sha256(restoreSource.bytes),
    })),
  };
}

function holdPrivateParent(filename) {
  const parent = path.dirname(filename);
  const outputLeaf = path.basename(filename);
  const directoryFlag = fs.constants.O_DIRECTORY;
  const noFollowFlag = fs.constants.O_NOFOLLOW;
  const nonBlockFlag = fs.constants.O_NONBLOCK;
  if (
    !path.isAbsolute(filename) ||
    path.resolve(filename) !== filename ||
    outputLeaf.length < 1 ||
    outputLeaf.length > 255 ||
    outputLeaf === "." ||
    outputLeaf === ".." ||
    outputLeaf.includes("/") ||
    outputLeaf.includes("\0") ||
    !positiveInteger(directoryFlag) ||
    !positiveInteger(noFollowFlag) ||
    !positiveInteger(nonBlockFlag)
  ) fail("output_unsafe");
  let handle = null;
  try {
    handle = fs.openSync(
      parent,
      fs.constants.O_RDONLY |
        directoryFlag |
        noFollowFlag |
        nonBlockFlag,
    );
  } catch {
    fail("output_unsafe");
  }
  let held;
  let descriptorRoot;
  try {
    held = fs.fstatSync(handle, { bigint: true });
    const stat = fs.lstatSync(parent, { bigint: true });
    const canonicalParent = fs.realpathSync(parent);
    descriptorRoot = process.platform === "linux"
      ? `/proc/self/fd/${handle}`
      : process.env.VITEST === "true"
        ? parent
        : null;
    const descriptorCanonical = descriptorRoot === null
      ? null
      : fs.realpathSync(descriptorRoot);
    const entries = descriptorRoot === null
      ? null
      : fs.readdirSync(descriptorRoot);
    if (
      !held.isDirectory() ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      held.dev !== stat.dev ||
      held.ino !== stat.ino ||
      held.uid !== stat.uid ||
      held.gid !== stat.gid ||
      held.mode !== stat.mode ||
      Number(held.mode & 0o7777n) !== 0o700 ||
      (canonicalParent !== parent &&
        !(process.platform !== "linux" && process.env.VITEST === "true")) ||
      descriptorRoot === null ||
      (process.platform === "linux" && descriptorCanonical !== parent) ||
      (typeof process.geteuid === "function" &&
        held.uid !== BigInt(process.geteuid())) ||
      entries === null ||
      entries.length !== 0
    ) fail("output_unsafe");
  } catch (error) {
    try {
      fs.closeSync(handle);
    } catch {
      fail("output_cleanup_failed");
    }
    if (
      error instanceof Error &&
      error.message.startsWith("production_postgres_source_pin_recovery_")
    ) throw error;
    fail("output_unsafe");
  }
  const expectedEntries = new Set();
  let closed = false;
  const assertExact = () => {
    if (closed) fail("output_unsafe");
    const current = fs.lstatSync(parent, { bigint: true });
    const currentHeld = fs.fstatSync(handle, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== held.dev ||
      current.ino !== held.ino ||
      current.uid !== held.uid ||
      current.gid !== held.gid ||
      current.mode !== held.mode ||
      currentHeld.dev !== held.dev ||
      currentHeld.ino !== held.ino ||
      currentHeld.uid !== held.uid ||
      currentHeld.gid !== held.gid ||
      currentHeld.mode !== held.mode ||
      !canonicalAuthorityPath(parent) ||
      (process.platform === "linux" &&
        fs.realpathSync(descriptorRoot) !== path.resolve(parent)) ||
      canonical(fs.readdirSync(descriptorRoot).sort()) !==
        canonical([...expectedEntries].sort())
    ) fail("output_unsafe");
  };
  const safeLeaf = (leaf) => {
    if (
      typeof leaf !== "string" ||
      leaf.length < 1 ||
      leaf.length > 255 ||
      leaf === "." ||
      leaf === ".." ||
      leaf.includes("/") ||
      leaf.includes("\\") ||
      /[\r\n\0]/.test(leaf)
    ) fail("output_unsafe");
    return path.join(descriptorRoot, leaf);
  };
  const writeLeaf = (leaf, source) => {
    assertExact();
    const target = safeLeaf(leaf);
    const descriptor = fs.openSync(
      target,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        noFollowFlag,
      0o600,
    );
    expectedEntries.add(leaf);
    let cleanupFailure = null;
    try {
      fs.writeFileSync(descriptor, source);
      fs.fsyncSync(descriptor);
      const opened = fs.fstatSync(descriptor, { bigint: true });
      const current = fs.lstatSync(target, { bigint: true });
      if (
        !opened.isFile() ||
        current.isSymbolicLink() ||
        !sameFile(opened, current) ||
        opened.nlink !== 1n ||
        Number(opened.mode & 0o7777n) !== 0o600
      ) fail("output_unsafe");
    } finally {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        cleanupFailure = error;
      }
    }
    if (cleanupFailure !== null) fail("output_cleanup_failed");
    fs.fsyncSync(handle);
    assertExact();
  };
  const openReadLeaf = (leaf) => {
    assertExact();
    if (!expectedEntries.has(leaf)) fail("output_unsafe");
    const target = safeLeaf(leaf);
    const descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | noFollowFlag | nonBlockFlag,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(target, { bigint: true });
    if (
      !opened.isFile() ||
      current.isSymbolicLink() ||
      !sameFile(opened, current) ||
      opened.nlink !== 1n ||
      Number(opened.mode & 0o7777n) !== 0o600
    ) {
      fs.closeSync(descriptor);
      fail("output_unsafe");
    }
    assertExact();
    return {
      handle: descriptor,
      assertExact: (expectedBytes) => {
        assertExact();
        const beforeRead = fs.fstatSync(descriptor, { bigint: true });
        const beforePath = fs.lstatSync(target, { bigint: true });
        if (
          !Buffer.isBuffer(expectedBytes) ||
          !sameFile(opened, beforeRead) ||
          !sameFile(opened, beforePath) ||
          beforePath.isSymbolicLink() ||
          beforeRead.size !== BigInt(expectedBytes.length)
        ) fail("artifact_archive_invalid");
        const hash = crypto.createHash("sha256");
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (offset < expectedBytes.length) {
          const count = fs.readSync(
            descriptor,
            buffer,
            0,
            Math.min(buffer.length, expectedBytes.length - offset),
            offset,
          );
          if (count <= 0) fail("artifact_archive_invalid");
          hash.update(buffer.subarray(0, count));
          offset += count;
        }
        const afterRead = fs.fstatSync(descriptor, { bigint: true });
        const afterPath = fs.lstatSync(target, { bigint: true });
        if (
          hash.digest("hex") !== sha256(expectedBytes) ||
          !sameFile(opened, afterRead) ||
          !sameFile(opened, afterPath) ||
          afterPath.isSymbolicLink()
        ) fail("artifact_archive_invalid");
        assertExact();
      },
    };
  };
  const removeLeaf = (leaf) => {
    assertExact();
    if (!expectedEntries.has(leaf)) fail("output_unsafe");
    fs.unlinkSync(safeLeaf(leaf));
    expectedEntries.delete(leaf);
    fs.fsyncSync(handle);
    assertExact();
  };
  return {
    handle,
    outputLeaf,
    assertExact,
    writeLeaf,
    openReadLeaf,
    removeLeaf,
    close: () => {
      if (closed) fail("output_unsafe");
      let cleanupFailure = null;
      try {
        assertExact();
        fs.fsyncSync(handle);
      } catch (error) {
        cleanupFailure = error;
      }
      try {
        fs.closeSync(handle);
      } catch (error) {
        cleanupFailure ??= error;
      }
      closed = true;
      if (cleanupFailure !== null) fail("output_cleanup_failed");
    },
  };
}

function writeExclusive(filename, source, custody) {
  if (path.basename(filename) !== custody.outputLeaf) fail("output_unsafe");
  custody.writeLeaf(custody.outputLeaf, source);
}

export async function runProductionPostgresSourcePinRecoveryMaterializer(
  argv,
  dependencies = {},
) {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? (() => Date.now());
  const extractEntries = dependencies.extractEntries ?? defaultExtractEntries;
  const writeOutput = dependencies.writeOutput ?? ((value) => process.stdout.write(value));
  let custody = null;
  try {
    const args = parseArguments(argv);
    custody = holdPrivateParent(args.output);
    const token = env.GITHUB_TOKEN ?? "";
    if (
      env.GITHUB_ACTIONS !== "true" ||
      env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_REPOSITORY !== REPOSITORY ||
      env.GITHUB_SHA !== args.candidateSha ||
      env.GITHUB_RUN_ATTEMPT !== "1" ||
      token.length < 16 ||
      /[\r\n\0]/.test(token)
    ) fail("github_context_invalid");
    const currentTime = now();
    const run = await boundedJson(await github(
      fetchImpl,
      token,
      `/actions/runs/${args.backupRunId}`,
      "application/vnd.github+json",
    ));
    const runTimes = validateRun(run, args, currentTime);
    const listing = await boundedJson(await github(
      fetchImpl,
      token,
      `/actions/runs/${args.backupRunId}/artifacts?per_page=100&page=1`,
      "application/vnd.github+json",
    ));
    if (
      listing?.total_count !== 2 ||
      !Array.isArray(listing?.artifacts) ||
      listing.artifacts.length !== 2
    ) fail("artifact_listing_invalid");
    const runId = Number(args.backupRunId);
    const backupName = `production-logical-backup-receipts-${args.backupRunId}-1`;
    const restoreName = `production-restore-drill-receipts-${args.backupRunId}-1`;
    const find = (name) => listing.artifacts.filter((artifact) => artifact?.name === name);
    const backupMatches = find(backupName);
    const restoreMatches = find(restoreName);
    if (backupMatches.length !== 1 || restoreMatches.length !== 1) {
      fail("artifact_listing_invalid");
    }
    const backupArtifact = artifactFromListing(
      backupMatches[0], backupName, runId, args.candidateSha,
    );
    const restoreArtifact = artifactFromListing(
      restoreMatches[0], restoreName, runId, args.candidateSha,
    );
    if (backupArtifact.id === restoreArtifact.id) fail("artifact_listing_invalid");
    const backupMaterialized = await materializeArtifact({
      artifact: backupArtifact,
      candidateSha: args.candidateSha,
      expectedEntries: BACKUP_ENTRIES,
      extractEntries,
      fetchImpl,
      custody,
      runId,
      token,
    });
    custody.assertExact();
    const restoreMaterialized = await materializeArtifact({
      artifact: restoreArtifact,
      candidateSha: args.candidateSha,
      expectedEntries: RESTORE_ENTRIES,
      extractEntries,
      fetchImpl,
      custody,
      runId,
      token,
    });
    const recovery = validateReceipts(
      backupMaterialized.entries,
      restoreMaterialized.entries,
      currentTime,
      runTimes,
    );
    const payload = {
      schemaVersion: "pintpath-production-postgres-source-pin-recovery-authority/v1",
      repository: REPOSITORY,
      candidateSha: args.candidateSha,
      workflowPath: WORKFLOW_PATH,
      workflowRunId: args.backupRunId,
      workflowRunAttempt: 1,
      workflowRunStartedAt: run.run_started_at,
      workflowRunCompletedAt: run.updated_at,
      backupArtifact: { ...backupArtifact, receiptSetSha256: backupMaterialized.receiptSetSha256 },
      restoreArtifact: { ...restoreArtifact, receiptSetSha256: restoreMaterialized.receiptSetSha256 },
      recovery,
      checks: {
        exactCandidateRun: true,
        exactBackupArtifact: true,
        exactRestoreArtifact: true,
        crossCopyBindingsExact: true,
        databaseIdentityBound: true,
        restoreDrillExact: true,
        freshnessExact: true,
        wormRetentionExact: true,
      },
    };
    const authority = {
      ...payload,
      authoritySha256: sha256(canonical(payload)),
    };
    const source = canonical(authority);
    writeExclusive(args.output, source, custody);
    custody.close();
    custody = null;
    writeOutput(`${JSON.stringify({
      command: "materialize-production-postgres-source-pin-recovery-authority",
      ok: true,
      workflowRunId: args.backupRunId,
      authoritySha256: authority.authoritySha256,
      outputSha256: sha256(source),
    })}\n`);
    return 0;
  } catch (error) {
    if (custody !== null) {
      try {
        custody.close();
      } catch {
        // The operation already fails closed; do not publish a success receipt.
      }
      custody = null;
    }
    writeOutput(`${JSON.stringify({
      command: "materialize-production-postgres-source-pin-recovery-authority",
      ok: false,
      failureCode: error instanceof Error
        ? error.message.split(":", 1)[0]
        : "unexpected_failure",
    })}\n`);
    return 1;
  }
}

export const productionPostgresSourcePinRecoveryInternals = {
  parseArguments,
  validateRun,
  validateReceipts,
  holdPrivateParent,
  writeExclusive,
  defaultExtractEntries,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProductionPostgresSourcePinRecoveryMaterializer(
    process.argv.slice(2),
  );
}
