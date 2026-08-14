import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_PRIVATE_STORAGE_BUCKET,
  createSupabasePrivateStorageRestoreBoundary,
  postgresPrivateStorageRecoveryInternals,
  type PostgresPrivateStorageBoundary,
  type PostgresPrivateStorageRecoveryManifest,
} from "../src/lib/postgres-private-storage-recovery.js";
import { assertSupabaseServerApiKey } from "../src/lib/supabase-key-format.js";
import { POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE } from "../src/lib/postgres-railway-stock-localhost-ca.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";
import {
  holdPrivateDirectoryIdentity,
  readTrustedRegularFile,
  writePrivateExclusiveFile,
  type HeldPrivateDirectoryIdentity,
} from "./lib/trusted-filesystem.js";

const ARGUMENTS = new Set([
  "--purge-authority-file", "--purge-authority-sha256",
  "--purge-authority-public-key-file", "--purge-authority-public-key-sha256",
  "--recovery-manifest-file", "--recovery-manifest-sha256",
  "--restore-receipt-file", "--restore-receipt-sha256",
  "--destination-restore-authority-sha256", "--expected-root-ca-der-sha256",
  "--destination-origin-sha256", "--destination-project-ref",
  "--expected-candidate-sha", "--forbidden-origin-sha256s",
  "--service-role-key-file", "--target-connection-url-sha256",
  "--target-database-identity-sha256", "--target-railway-project-id",
  "--target-railway-environment-id", "--output",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE = /^[a-f0-9]{40}$/;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Json = Record<string, unknown>;

export class PostgresPrivateStoragePurgeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PostgresPrivateStoragePurgeError";
  }
}

function fail(code: string): never {
  throw new PostgresPrivateStoragePurgeError(code);
}

function hash(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactAbsolute(value: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    fail("arguments_invalid");
  }
  return value;
}

function exactSha(value: string): string {
  if (!SHA256.test(value)) fail("arguments_invalid");
  return value;
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function record(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCanonical(bytes: Buffer, code: string): Json {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(code);
  }
  if (!record(value) || canonicalPostgresBackupJson(value) !== bytes.toString("utf8")) fail(code);
  return value;
}

function exactTimestamp(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("authority_invalid");
  }
  return value;
}

interface ExpectedObject {
  readonly objectPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType: string;
}

function expectedObjects(manifest: PostgresPrivateStorageRecoveryManifest): readonly ExpectedObject[] {
  return Object.freeze(manifest.sourceStorage.objects.map((object) => ({
    objectPath: object.objectPath,
    bytes: object.bytes,
    sha256: object.sha256,
    contentType: object.contentType,
  })));
}

function objectSetSha256(objects: readonly ExpectedObject[]): string {
  return hash(canonicalPostgresBackupJson(objects));
}

interface AuthorityInput {
  readonly source: string;
  readonly sourceSha256: string;
  readonly publicKeyPem: string;
  readonly publicKeySha256: string;
  readonly candidateSha: string;
  readonly destinationOrigin: string;
  readonly destinationOriginSha256: string;
  readonly destinationProjectRef: string;
  readonly targetConnectionUrlSha256: string;
  readonly targetDatabaseIdentitySha256: string;
  readonly targetRailwayProjectId: string;
  readonly targetRailwayEnvironmentId: string;
  readonly destinationRestoreAuthoritySha256: string;
  readonly now: Date;
}

export function verifyPostgresPrivateStoragePurgeAuthority(input: AuthorityInput): string {
  if (hash(input.source) !== input.sourceSha256
    || hash(input.publicKeyPem) !== input.publicKeySha256) fail("authority_invalid");
  const envelope = parseCanonical(Buffer.from(input.source), "authority_invalid");
  const payload = envelope.payload;
  if (!exactKeys(envelope, ["schemaVersion", "payload", "signatureBase64"])
    || envelope.schemaVersion !== "pintpath-private-storage-disposable-purge-authority/v1"
    || !record(payload)
    || !exactKeys(payload, [
      "schemaVersion", "operation", "candidateSha", "destinationOrigin",
      "destinationOriginSha256", "destinationProjectRef", "bucketName",
      "bucketNameSha256", "targetConnectionUrlSha256",
      "targetDatabaseIdentitySha256", "targetRailwayProjectId",
      "targetRailwayEnvironmentId", "destinationRestoreAuthoritySha256",
      "reviewerIdSha256",
      "reviewerPublicKeySha256", "issuedAt", "expiresAt",
    ])
    || typeof envelope.signatureBase64 !== "string"
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
      .test(envelope.signatureBase64)) fail("authority_invalid");
  const issuedAt = exactTimestamp(payload.issuedAt);
  const expiresAt = exactTimestamp(payload.expiresAt);
  const nowMs = input.now.getTime();
  if (payload.schemaVersion !== "pintpath-private-storage-disposable-purge-authority-payload/v1"
    || payload.operation !== "purge-only-restored-object-set"
    || payload.candidateSha !== input.candidateSha
    || payload.destinationOrigin !== input.destinationOrigin
    || payload.destinationOriginSha256 !== input.destinationOriginSha256
    || payload.destinationProjectRef !== input.destinationProjectRef
    || payload.bucketName !== POSTGRES_PRIVATE_STORAGE_BUCKET
    || payload.bucketNameSha256 !== hash(POSTGRES_PRIVATE_STORAGE_BUCKET)
    || payload.targetConnectionUrlSha256 !== input.targetConnectionUrlSha256
    || payload.targetDatabaseIdentitySha256 !== input.targetDatabaseIdentitySha256
    || payload.targetRailwayProjectId !== input.targetRailwayProjectId
    || payload.targetRailwayEnvironmentId !== input.targetRailwayEnvironmentId
    || payload.destinationRestoreAuthoritySha256
      !== input.destinationRestoreAuthoritySha256
    || payload.reviewerPublicKeySha256 !== input.publicKeySha256
    || typeof payload.reviewerIdSha256 !== "string" || !SHA256.test(payload.reviewerIdSha256)
    || !Number.isFinite(nowMs) || Date.parse(issuedAt) > nowMs || Date.parse(expiresAt) <= nowMs
    || Date.parse(expiresAt) - Date.parse(issuedAt) > 86_400_000) fail("authority_invalid");
  try {
    const key = crypto.createPublicKey(input.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519"
      || !crypto.verify(null, Buffer.from(canonicalPostgresBackupJson(payload)), key,
        Buffer.from(envelope.signatureBase64, "base64"))) fail("authority_invalid");
  } catch {
    fail("authority_invalid");
  }
  return payload.reviewerIdSha256;
}

function assertOutputReady(
  filename: string,
  evidenceDirectory: HeldPrivateDirectoryIdentity,
): void {
  const output = exactAbsolute(filename);
  try {
    evidenceDirectory.assertExact();
    if (path.dirname(output) !== evidenceDirectory.path || fs.existsSync(output)) {
      fail("output_unsafe");
    }
  } catch {
    fail("output_unsafe");
  }
}

async function readPrivateFile(filename: string): Promise<string> {
  try {
    return readTrustedRegularFile(filename, {
      minBytes: 1, maxBytes: 16 * 1024 * 1024,
      requireOwner: true, requirePrivate: true,
    }).toString("utf8");
  } catch {
    fail("secret_file_unsafe");
  }
}

function assertEvidenceExact(directory: HeldPrivateDirectoryIdentity): void {
  try {
    directory.assertExact();
  } catch {
    fail("output_unsafe");
  }
}

export interface PostgresPrivateStoragePurgeDependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  readonly readPrivateFile: (filePath: string) => Promise<string>;
  readonly createStorage: (input: {
    readonly supabaseUrl: string;
    readonly serviceRoleKey: string;
    readonly bucketName: string;
  }) => PostgresPrivateStorageBoundary;
  readonly assertMutationAllowed: (operation: string) => void;
  readonly writeOutput: (value: string) => void;
  readonly holdEvidenceDirectory: (directory: string) => HeldPrivateDirectoryIdentity;
}

export async function purgePostgresPrivateStorageRecoveryTarget(
  overrides: Partial<PostgresPrivateStoragePurgeDependencies> = {},
): Promise<object> {
  const dependencies: PostgresPrivateStoragePurgeDependencies = {
    argv: process.argv.slice(2), env: process.env, now: () => new Date(),
    readPrivateFile,
    createStorage: createSupabasePrivateStorageRestoreBoundary,
    assertMutationAllowed: assertOperatorMutationAllowed,
    writeOutput: (value) => process.stdout.write(value),
    holdEvidenceDirectory: (directory) => holdPrivateDirectoryIdentity(directory, {
      requireExactDirectoryMode: true, requireOwner: true,
    }),
    ...overrides,
  };
  let args: ReadonlyMap<string, string>;
  try {
    args = parseStrictArguments(dependencies.argv, { allowed: ARGUMENTS, required: ARGUMENTS });
  } catch {
    fail("arguments_invalid");
  }
  if (dependencies.env.PINTPATH_POSTGRES_PRIVATE_STORAGE_PURGE !== "confirmed") {
    fail("confirmation_required");
  }
  const outputPath = exactAbsolute(args.get("--output")!);
  let evidenceDirectory: HeldPrivateDirectoryIdentity;
  try {
    evidenceDirectory = dependencies.holdEvidenceDirectory(path.dirname(outputPath));
    assertOutputReady(outputPath, evidenceDirectory);
  } catch {
    fail("output_unsafe");
  }
  try {
    dependencies.assertMutationAllowed("Purge exact disposable private Storage recovery set");
  const origin = dependencies.env.RESTORE_SUPABASE_URL;
  const candidateSha = args.get("--expected-candidate-sha")!;
  const projectRef = args.get("--destination-project-ref")!;
  const projectId = args.get("--target-railway-project-id")!;
  const environmentId = args.get("--target-railway-environment-id")!;
  const originSha256 = exactSha(args.get("--destination-origin-sha256")!);
  const destinationRestoreAuthoritySha256 = exactSha(
    args.get("--destination-restore-authority-sha256")!,
  );
  const expectedRootCaDerSha256 = exactSha(args.get("--expected-root-ca-der-sha256")!);
  const forbidden = args.get("--forbidden-origin-sha256s")!.split(",");
  if (!origin || origin !== `https://${projectRef}.supabase.co` || hash(origin) !== originSha256
    || !CANDIDATE.test(candidateSha) || !PROJECT_REF.test(projectRef)
    || !UUID.test(projectId) || !UUID.test(environmentId)
    || forbidden.length < 1 || forbidden.some((value) => !SHA256.test(value))
    || new Set(forbidden).size !== forbidden.length || forbidden.includes(originSha256)) {
    fail("configuration_missing_or_unsafe");
  }
  const paths = [
    "--purge-authority-file", "--purge-authority-public-key-file",
    "--recovery-manifest-file", "--restore-receipt-file", "--service-role-key-file",
  ] as const;
  const sources = await Promise.all(paths.map((flag) => dependencies.readPrivateFile(
      exactAbsolute(args.get(flag)!),
    ).catch(() => fail("secret_file_unsafe"))));
  const authoritySource = sources[0]!;
  const publicKeyPem = sources[1]!;
  const manifestSource = sources[2]!;
  const restoreSource = sources[3]!;
  const serviceRoleKey = sources[4]!;
  const manifestBytes = Buffer.from(manifestSource);
  const restoreBytes = Buffer.from(restoreSource);
  const manifestSha256 = exactSha(args.get("--recovery-manifest-sha256")!);
  const restoreSha256 = exactSha(args.get("--restore-receipt-sha256")!);
  if (hash(manifestBytes) !== manifestSha256 || hash(restoreBytes) !== restoreSha256) {
    fail("evidence_hash_mismatch");
  }
  let manifest: PostgresPrivateStorageRecoveryManifest;
  try {
    manifest = postgresPrivateStorageRecoveryInternals.parseRecoveryManifest(manifestBytes);
  } catch {
    fail("recovery_manifest_invalid");
  }
  const restore = parseCanonical(restoreBytes, "restore_receipt_invalid");
  const objects = expectedObjects(manifest);
  const restoredSetSha256 = objectSetSha256(objects);
  if (!exactKeys(restore, [
    "schemaVersion", "kind", "ok", "restoredAt", "targetDatabaseIdentitySha256",
    "recoverySetSha256", "recoveryManifestSha256", "restoredObjectCount",
    "restoredBytes", "destinationObjectSetSha256", "deletionAuthoritySetSha256",
    "databaseTransportProfile", "databaseTransportRootCaDerSha256",
    "databaseEffectiveRole", "candidateSha", "destinationConnectionUrlSha256",
    "destinationOriginSha256", "destinationBucketNameSha256",
    "destinationAuthoritySha256", "destinationAuthorityPublicKeySha256",
    "destinationAuthorityReviewerIdSha256", "destinationRailwayProjectIdSha256",
    "destinationRailwayEnvironmentIdSha256",
  ]) || restore.schemaVersion !== 1
    || restore.kind !== "pintpath-postgres-private-storage-recovery-restore"
    || restore.ok !== true || exactTimestamp(restore.restoredAt) === ""
    || restore.candidateSha !== candidateSha
    || manifest.logicalBackup.candidateSha !== candidateSha
    || restore.recoverySetSha256 !== manifest.recoverySetSha256
    || restore.recoveryManifestSha256 !== manifestSha256
    || restore.targetDatabaseIdentitySha256 !== args.get("--target-database-identity-sha256")
    || restore.destinationConnectionUrlSha256 !== args.get("--target-connection-url-sha256")
    || restore.databaseTransportProfile !== POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE
    || restore.databaseTransportRootCaDerSha256 !== expectedRootCaDerSha256
    || restore.databaseEffectiveRole !== "pintpath_migrator"
    || restore.destinationOriginSha256 !== originSha256
    || restore.destinationBucketNameSha256 !== hash(POSTGRES_PRIVATE_STORAGE_BUCKET)
    || restore.destinationAuthoritySha256 !== destinationRestoreAuthoritySha256
    || typeof restore.destinationAuthorityPublicKeySha256 !== "string"
    || !SHA256.test(restore.destinationAuthorityPublicKeySha256)
    || typeof restore.destinationAuthorityReviewerIdSha256 !== "string"
    || !SHA256.test(restore.destinationAuthorityReviewerIdSha256)
    || restore.destinationRailwayProjectIdSha256 !== hash(projectId)
    || restore.destinationRailwayEnvironmentIdSha256 !== hash(environmentId)
    || restore.destinationObjectSetSha256 !== restoredSetSha256
    || restore.restoredObjectCount !== objects.length
    || restore.restoredBytes !== String(objects.reduce((sum, value) => sum + value.bytes, 0))
    || restore.deletionAuthoritySetSha256 !== manifest.deletionAuthority.authoritySetSha256) {
    fail("restore_receipt_invalid");
  }
  let reviewerIdSha256: string;
  try {
    reviewerIdSha256 = verifyPostgresPrivateStoragePurgeAuthority({
      source: authoritySource,
      sourceSha256: exactSha(args.get("--purge-authority-sha256")!),
      publicKeyPem,
      publicKeySha256: exactSha(args.get("--purge-authority-public-key-sha256")!),
      candidateSha, destinationOrigin: origin, destinationOriginSha256: originSha256,
      destinationProjectRef: projectRef,
      targetConnectionUrlSha256: exactSha(args.get("--target-connection-url-sha256")!),
      targetDatabaseIdentitySha256: exactSha(args.get("--target-database-identity-sha256")!),
      targetRailwayProjectId: projectId, targetRailwayEnvironmentId: environmentId,
      destinationRestoreAuthoritySha256, now: dependencies.now(),
    });
    assertSupabaseServerApiKey(serviceRoleKey, "RESTORE_SUPABASE_SERVICE_ROLE_KEY");
  } catch {
    fail("authority_invalid");
  }
  const storage = dependencies.createStorage({
    supabaseUrl: origin, serviceRoleKey, bucketName: POSTGRES_PRIVATE_STORAGE_BUCKET,
  });
  const bucket = await storage.inspectBucket().catch(() => fail("storage_unreachable"));
  if (bucket.private !== true) fail("bucket_not_private");
  const before = await storage.listObjects().catch(() => fail("storage_unreachable"));
  if (before.length !== objects.length || before.some((observed, index) => {
    const expected = objects[index];
    return !expected || observed.objectPath !== expected.objectPath
      || observed.bytes !== expected.bytes || observed.contentType !== expected.contentType;
  })) fail("unexpected_object_set");
  for (const expected of objects) {
    const downloaded = await storage.downloadObject(expected.objectPath)
      .catch(() => fail("storage_unreachable"));
    if (downloaded.bytes.length !== expected.bytes || hash(downloaded.bytes) !== expected.sha256
      || downloaded.contentType !== expected.contentType) fail("unexpected_object_set");
  }
  const reasserted = await storage.listObjects().catch(() => fail("storage_unreachable"));
  if (canonicalPostgresBackupJson(reasserted) !== canonicalPostgresBackupJson(before)) {
    fail("concurrent_object_change");
  }
  if (!storage.removeObjects) fail("purge_unavailable");
  assertEvidenceExact(evidenceDirectory);
  await storage.removeObjects(objects.map((value) => value.objectPath))
    .catch(() => fail("purge_failed"));
  assertEvidenceExact(evidenceDirectory);
  const after = await storage.listObjects().catch(() => fail("storage_unreachable"));
  const confirmed = await storage.listObjects().catch(() => fail("storage_unreachable"));
  if (after.length !== 0 || confirmed.length !== 0) fail("absence_not_proven");
  const completedAt = dependencies.now().toISOString();
  if (new Date(completedAt).toISOString() !== completedAt) fail("clock_invalid");
  const withoutHash = {
    schemaVersion: 1,
    kind: "pintpath-postgres-private-storage-recovery-target-purge",
    ok: true,
    candidateSha,
    completedAt,
    destinationProjectRefSha256: hash(projectRef),
    targetRailwayProjectIdSha256: hash(projectId),
    targetRailwayEnvironmentIdSha256: hash(environmentId),
    targetDatabaseIdentitySha256: exactSha(args.get("--target-database-identity-sha256")!),
    targetConnectionUrlSha256: exactSha(args.get("--target-connection-url-sha256")!),
    destinationOriginSha256: originSha256,
    bucketNameSha256: hash(POSTGRES_PRIVATE_STORAGE_BUCKET),
    destinationRestoreAuthoritySha256,
    purgeAuthoritySha256: exactSha(args.get("--purge-authority-sha256")!),
    purgeAuthorityPublicKeySha256: exactSha(args.get("--purge-authority-public-key-sha256")!),
    purgeAuthorityReviewerIdSha256: reviewerIdSha256,
    recoverySetSha256: manifest.recoverySetSha256,
    recoveryManifestSha256: manifestSha256,
    restoreReceiptSha256: restoreSha256,
    restoredObjectSetSha256: restoredSetSha256,
    removedObjectCount: objects.length,
    bucketPrivateExact: true,
    restoredObjectSetExact: true,
    concurrentObjectSetAbsent: true,
    storageObjectsAbsentExact: true,
  };
  const receipt = { ...withoutHash, receiptSha256: hash(canonicalPostgresBackupJson(withoutHash)) };
  const evidenceDirectoryIdentity = evidenceDirectory.identity;
  try {
    assertEvidenceExact(evidenceDirectory);
    evidenceDirectory.close();
  } catch {
    fail("output_unsafe");
  }
  try {
    writePrivateExclusiveFile(path.dirname(outputPath), path.basename(outputPath),
      canonicalPostgresBackupJson(receipt), {
        requireExactDirectoryMode: true, requireOwner: true,
        expectedDirectoryIdentity: evidenceDirectoryIdentity,
      });
  } catch {
    fail("output_unsafe");
  }
  dependencies.writeOutput(canonicalPostgresBackupJson({
    schemaVersion: 1, ok: true, receiptSha256: receipt.receiptSha256,
  }));
    return receipt;
  } finally {
    try {
      evidenceDirectory.close();
    } catch {
      // A failed first close is already failure-dominant above.
    }
  }
}

export async function runPostgresPrivateStoragePurgeCli(
  argv = process.argv.slice(2),
  overrides: Partial<PostgresPrivateStoragePurgeDependencies> = {},
): Promise<0 | 1> {
  const output = overrides.writeOutput ?? ((value: string) => process.stdout.write(value));
  try {
    await purgePostgresPrivateStorageRecoveryTarget({ ...overrides, argv, writeOutput: output });
    return 0;
  } catch (error) {
    output(canonicalPostgresBackupJson({
      schemaVersion: 1, ok: false,
      failureCode: error instanceof PostgresPrivateStoragePurgeError
        ? error.code : "unexpected_failure",
    }));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPostgresPrivateStoragePurgeCli();
}
