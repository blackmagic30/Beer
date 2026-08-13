import crypto from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import {
  POSTGRES_MIGRATION_MAINTENANCE_ENV,
  POSTGRES_MIGRATION_MAINTENANCE_VALUE,
  PostgresMigrationSourceError,
  createPostgresMigrationPlan,
  createPostgresMigrationSnapshot,
} from "../src/db/postgres-migration-source.js";
import { exportPostgresMigrationLedgerAuthority } from "../src/db/postgres-migration-ledger.js";
import { serializeCanonicalPostgresMigrationJson, sha256PostgresMigrationBytes } from "../src/db/postgres-migration-schema.js";
import {
  PostgresMigrationTargetError,
  applyPostgresMigration,
  inspectPostgresMigrationTarget,
  safePostgresMigrationTargetFailure,
  verifyPostgresMigration,
  type PostgresMigrationEnvironment,
  type PostgresMigrationTargetInput,
  type PostgresMigrationVerifyInput,
} from "../src/db/postgres-migration-target.js";
import {
  postgresMigrationApplyReceiptSchema,
  postgresMigrationVerificationApprovalSchema,
} from "../src/db/postgres-migration-receipt.js";
import { readPrivateSecretFile } from "../src/lib/offsite-backup-download.js";
import {
  assertExactSupabaseOrigin,
  assertSupabaseServerApiKey,
  resolveExactOperationalOffsiteBackupBucket,
} from "../src/lib/supabase-key-format.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

dotenv.config({ quiet: true });

const SNAPSHOT_ARGUMENTS = new Set([
  "--candidate-sha",
  "--deletion-ledger-authority",
  "--maintenance-reference",
  "--operator-id",
  "--output-dir",
  "--source-evidence",
  "--source-sqlite",
]);

const PLAN_ARGUMENTS = new Set([
  "--chunk-rows",
  "--output-plan",
  "--snapshot-manifest",
  "--snapshot-manifest-sha256",
]);

const LEDGER_EXPORT_ARGUMENTS = new Set([
  "--output-dir",
  "--service-role-key-file",
]);

const PRODUCTION_SUPABASE_ORIGIN = "https://auth.pintpath.au" as const;
const OFFSITE_BACKUP_SUPABASE_ORIGIN =
  "https://hfbmhdxrwtihukmixxta.supabase.co" as const;

const TARGET_INSPECT_ARGUMENTS = new Set([
  "--output-target-identity",
  "--root-ca-der-sha256",
  "--root-ca-file",
  "--target-ddl",
  "--target-ddl-sha256",
  "--target-url-file",
]);

const TARGET_EXECUTE_ARGUMENTS = new Set([
  "--approval-reference",
  "--candidate-sha",
  "--expected-environment",
  "--operator-id",
  "--output-receipt",
  "--plan",
  "--plan-sha256",
  "--root-ca-der-sha256",
  "--root-ca-file",
  "--snapshot-manifest",
  "--snapshot-manifest-sha256",
  "--target-ddl",
  "--target-ddl-sha256",
  "--target-identity-sha256",
  "--target-url-file",
  "--target-url-sha256",
  "--transport-authority-sha256",
]);

const TARGET_VERIFY_ARGUMENTS = new Set([
  ...TARGET_EXECUTE_ARGUMENTS,
  "--apply-receipt",
  "--apply-receipt-sha256",
  "--verification-approval",
  "--verification-approval-sha256",
  "--verifier-public-key",
]);

export const POSTGRES_MIGRATION_APPLY_CONFIRMATION_ENV = "PINTPATH_POSTGRES_MIGRATION_APPLY" as const;
export const POSTGRES_MIGRATION_APPLY_CONFIRMATION_VALUE = "confirmed" as const;

function exactAbsolutePath(value: string): string {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(value) || resolved !== value) {
    throw new PostgresMigrationSourceError("ARGUMENT_INVALID", "Every migration path must be canonical and absolute.");
  }
  return value;
}

function exactChunkRows(value: string): number {
  if (!/^[1-9]\d{0,4}$/.test(value)) {
    throw new PostgresMigrationSourceError(
      "ARGUMENT_INVALID",
      "Chunk rows must be a base-10 integer from 1 through 10000.",
    );
  }
  const parsed = Number(value);
  if (parsed > 10_000) {
    throw new PostgresMigrationSourceError(
      "ARGUMENT_INVALID",
      "Chunk rows must be a base-10 integer from 1 through 10000.",
    );
  }
  return parsed;
}

function exactTargetEnvironment(value: string): PostgresMigrationEnvironment {
  if (value === "permanent-staging" || value === "production") return value;
  throw new PostgresMigrationSourceError(
    "ARGUMENT_INVALID",
    "Environment must be permanent-staging or production.",
  );
}

function samePrivateReceiptIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function samePrivateReceiptParent(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

function assertPrivateReceiptDescriptor(
  stat: fs.BigIntStats,
  expectedBytes: number,
  expectedUid: bigint,
): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1n
    || stat.uid !== expectedUid
    || Number(stat.mode & 0o7777n) !== 0o600
    || stat.size !== BigInt(expectedBytes)
  ) {
    throw new PostgresMigrationSourceError("ARTIFACT_INVALID", "Receipt output is not a private file.");
  }
}

function assertPrivateReceiptParent(stat: fs.BigIntStats, expectedUid: bigint): void {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== expectedUid
    || stat.nlink < 1n
    || Number(stat.mode & 0o022n) !== 0
  ) {
    throw new PostgresMigrationSourceError(
      "ARTIFACT_INVALID",
      "Receipt output parent must be a trusted current-user directory.",
    );
  }
}

async function readStablePrivateArtifactBytes(
  filePathInput: string,
  maxBytes = 1024 * 1024,
): Promise<Buffer> {
  const filePath = exactAbsolutePath(filePathInput);
  if (typeof process.geteuid !== "function") {
    throw new PostgresMigrationSourceError("ARTIFACT_INVALID", "Private artifact ownership cannot be verified.");
  }
  let pathStat: fs.BigIntStats;
  try {
    pathStat = fs.lstatSync(filePath, { bigint: true });
    if (
      !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.nlink !== 1n
      || pathStat.uid !== BigInt(process.geteuid())
      || Number(pathStat.mode & 0o7777n) !== 0o600
      || pathStat.size < 1n
      || pathStat.size > BigInt(maxBytes)
      || fs.realpathSync(filePath) !== filePath
    ) throw new Error("unsafe");
  } catch {
    throw new PostgresMigrationSourceError("ARTIFACT_INVALID", "Private artifact file is unsafe.");
  }
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!samePrivateReceiptIdentity(pathStat, before)) {
      throw new PostgresMigrationSourceError("SOURCE_CHANGED", "Private artifact changed before reading.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!samePrivateReceiptIdentity(before, after) || BigInt(bytes.length) !== after.size) {
      throw new PostgresMigrationSourceError("SOURCE_CHANGED", "Private artifact changed while reading.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseCanonicalPrivateArtifact<T>(
  bytes: Buffer,
  schema: { parse(value: unknown): T },
): T {
  let parsed: T;
  try {
    parsed = schema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new PostgresMigrationSourceError("ARTIFACT_INVALID", "Private JSON artifact is invalid.");
  }
  if (!bytes.equals(serializeCanonicalPostgresMigrationJson(parsed))) {
    throw new PostgresMigrationSourceError("ARTIFACT_INVALID", "Private JSON artifact is not canonical.");
  }
  return parsed;
}

async function readStablePrivateReceipt(
  handle: FileHandle,
  expectedBytes: Buffer,
  expectedUid: bigint,
): Promise<fs.BigIntStats> {
  const before = await handle.stat({ bigint: true });
  assertPrivateReceiptDescriptor(before, expectedBytes.length, expectedUid);
  const verifiedBytes = Buffer.allocUnsafe(expectedBytes.length);
  let position = 0;
  while (position < verifiedBytes.length) {
    const read = await handle.read(
      verifiedBytes,
      position,
      verifiedBytes.length - position,
      position,
    );
    if (read.bytesRead === 0) break;
    position += read.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (
    !samePrivateReceiptIdentity(before, after)
    || position !== expectedBytes.length
    || !verifiedBytes.equals(expectedBytes)
  ) {
    throw new PostgresMigrationSourceError("SOURCE_CHANGED", "Receipt output changed while it was verified.");
  }
  return after;
}

function currentPrivateReceiptPathStat(filePath: string): fs.BigIntStats | undefined {
  try {
    return fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function removePrivateReceiptTemporaryPath(filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // The command is already failing closed. Preserve the original result;
    // the unpredictable name is inside the verified private parent.
  }
}

async function writePrivateReceipt(filePathInput: string, value: unknown): Promise<string> {
  const filePath = exactAbsolutePath(filePathInput);
  if (typeof process.geteuid !== "function") {
    throw new PostgresMigrationSourceError("ARTIFACT_INVALID", "Receipt output ownership cannot be verified.");
  }
  const expectedUid = BigInt(process.geteuid());
  const parent = path.dirname(filePath);
  let parentHandle: FileHandle;
  try {
    parentHandle = await fs.promises.open(
      parent,
      fs.constants.O_RDONLY
        | (fs.constants.O_DIRECTORY ?? 0)
        | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new PostgresMigrationSourceError("ARGUMENT_INVALID", "Receipt output parent must exist.");
  }
  const temporaryPath = path.join(
    parent,
    `.pint-path-postgres-receipt-${crypto.randomBytes(16).toString("hex")}.tmp`,
  );
  const bytes = serializeCanonicalPostgresMigrationJson(value);
  let handle: FileHandle | undefined;
  try {
    const parentBefore = await parentHandle.stat({ bigint: true });
    assertPrivateReceiptParent(parentBefore, expectedUid);
    const parentPathBefore = fs.lstatSync(parent, { bigint: true });
    if (
      !samePrivateReceiptParent(parentBefore, parentPathBefore)
      || fs.realpathSync(parent) !== parent
    ) {
      throw new PostgresMigrationSourceError("ARTIFACT_INVALID", "Receipt output parent changed while it was opened.");
    }

    handle = await fs.promises.open(
      temporaryPath,
      fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_RDWR
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    await readStablePrivateReceipt(handle, bytes, expectedUid);

    const parentAfterWrite = await parentHandle.stat({ bigint: true });
    const parentPathAfterWrite = fs.lstatSync(parent, { bigint: true });
    assertPrivateReceiptParent(parentAfterWrite, expectedUid);
    if (
      !samePrivateReceiptParent(parentBefore, parentAfterWrite)
      || !samePrivateReceiptParent(parentAfterWrite, parentPathAfterWrite)
      || fs.realpathSync(parent) !== parent
    ) {
      throw new PostgresMigrationSourceError("SOURCE_CHANGED", "Receipt output parent changed before publication.");
    }

    try {
      await fs.promises.link(temporaryPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PostgresMigrationSourceError("ARGUMENT_INVALID", "Receipt output must not already exist.");
      }
      throw new PostgresMigrationSourceError("ARTIFACT_INVALID", "Receipt output could not be published safely.");
    }
    await fs.promises.unlink(temporaryPath);
    await parentHandle.sync();

    const descriptorStat = await readStablePrivateReceipt(handle, bytes, expectedUid);
    const publishedPathStat = currentPrivateReceiptPathStat(filePath);
    const parentAfter = await parentHandle.stat({ bigint: true });
    const parentPathAfter = fs.lstatSync(parent, { bigint: true });
    assertPrivateReceiptParent(parentAfter, expectedUid);
    if (
      !publishedPathStat
      || !samePrivateReceiptIdentity(descriptorStat, publishedPathStat)
      || !samePrivateReceiptParent(parentBefore, parentAfter)
      || !samePrivateReceiptParent(parentAfter, parentPathAfter)
      || fs.realpathSync(parent) !== parent
    ) {
      throw new PostgresMigrationSourceError("SOURCE_CHANGED", "Receipt output changed while it was published.");
    }
    return sha256PostgresMigrationBytes(bytes);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The descriptor was already fsynced; preserve the authoritative
        // validation result and continue the private temporary cleanup.
      }
    }
    // Never lstat-then-unlink the published path: an external same-UID process
    // could replace that name after the check. A post-publication mismatch is
    // left fail-closed for explicit operator review; only our random temporary
    // name is removed automatically.
    await removePrivateReceiptTemporaryPath(temporaryPath);
    try {
      await parentHandle.close();
    } catch {
      // The parent descriptor owns no buffered receipt data.
    }
  }
}

async function targetInputFromArguments(
  args: ReadonlyMap<string, string>,
  readSecretFile: typeof readPrivateSecretFile,
): Promise<{
  input: PostgresMigrationTargetInput;
  outputReceipt: string;
}> {
  const targetUrl = await readSecretFile(exactAbsolutePath(args.get("--target-url-file")!));
  return {
    input: {
      snapshotManifestPath: exactAbsolutePath(args.get("--snapshot-manifest")!),
      expectedSnapshotManifestSha256: args.get("--snapshot-manifest-sha256")!,
      planPath: exactAbsolutePath(args.get("--plan")!),
      expectedPlanSha256: args.get("--plan-sha256")!,
      targetDdlPath: exactAbsolutePath(args.get("--target-ddl")!),
      expectedTargetDdlSha256: args.get("--target-ddl-sha256")!,
      targetUrl,
      expectedTargetUrlSha256: args.get("--target-url-sha256")!,
      rootCaFile: exactAbsolutePath(args.get("--root-ca-file")!),
      expectedRootCaDerSha256: args.get("--root-ca-der-sha256")!,
      expectedTransportAuthoritySha256: args.get("--transport-authority-sha256")!,
      expectedTargetIdentitySha256: args.get("--target-identity-sha256")!,
      expectedEnvironment: exactTargetEnvironment(args.get("--expected-environment")!),
      candidateSha: args.get("--candidate-sha")!,
      approvalReference: args.get("--approval-reference")!,
      operatorId: args.get("--operator-id")!,
    },
    outputReceipt: exactAbsolutePath(args.get("--output-receipt")!),
  };
}

function safeFailure(error: unknown): { code: string; message: string; exitCode: number; retryable: boolean } {
  if (error instanceof PostgresMigrationSourceError) {
    return {
      code: error.code,
      message: error.message,
      exitCode: ["ARGUMENT_INVALID", "MAINTENANCE_REQUIRED"].includes(error.code) ? 2 : 3,
      retryable: false,
    };
  }
  if (error instanceof PostgresMigrationTargetError) {
    const failure = safePostgresMigrationTargetFailure(error);
    return {
      code: failure.code,
      message: failure.message,
      exitCode: failure.exitCode,
      retryable: failure.retryable,
    };
  }
  return {
    code: "UNEXPECTED_FAILURE",
    message: "Postgres migration source command failed unexpectedly; inspect protected application logs.",
    exitCode: 3,
    retryable: false,
  };
}

export async function runPostgresMigrationSourceCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: {
    readSecretFile?: typeof readPrivateSecretFile;
    readPrivateBytes?: typeof readStablePrivateArtifactBytes;
    inspectTarget?: typeof inspectPostgresMigrationTarget;
    applyTarget?: typeof applyPostgresMigration;
    verifyTarget?: typeof verifyPostgresMigration;
    exportLedger?: typeof exportPostgresMigrationLedgerAuthority;
  } = {},
): Promise<Record<string, unknown>> {
  const [subcommand, ...rawArguments] = argv;
  if (subcommand === "inspect-target") {
    const args = parseStrictArguments(rawArguments, {
      allowed: TARGET_INSPECT_ARGUMENTS,
      required: TARGET_INSPECT_ARGUMENTS,
    });
    const targetUrl = await (dependencies.readSecretFile ?? readPrivateSecretFile)(
      exactAbsolutePath(args.get("--target-url-file")!),
    );
    const result = await (dependencies.inspectTarget ?? inspectPostgresMigrationTarget)({
      targetUrl,
      targetDdlPath: exactAbsolutePath(args.get("--target-ddl")!),
      expectedTargetDdlSha256: args.get("--target-ddl-sha256")!,
      rootCaFile: exactAbsolutePath(args.get("--root-ca-file")!),
      expectedRootCaDerSha256: args.get("--root-ca-der-sha256")!,
    });
    const targetIdentityFileSha256 = await writePrivateReceipt(
      exactAbsolutePath(args.get("--output-target-identity")!),
      result.targetIdentity,
    );
    const { targetIdentity: _privateTargetIdentity, ...publicResult } = result;
    return {
      ok: true,
      command: "inspect-target",
      ...publicResult,
      targetIdentityFileSha256,
    };
  }
  if (subcommand === "apply" || subcommand === "verify-target") {
    const args = parseStrictArguments(rawArguments, {
      allowed: subcommand === "apply" ? TARGET_EXECUTE_ARGUMENTS : TARGET_VERIFY_ARGUMENTS,
      required: subcommand === "apply" ? TARGET_EXECUTE_ARGUMENTS : TARGET_VERIFY_ARGUMENTS,
    });
    if (subcommand === "apply") {
      if (
        environment[POSTGRES_MIGRATION_APPLY_CONFIRMATION_ENV]
        !== POSTGRES_MIGRATION_APPLY_CONFIRMATION_VALUE
      ) {
        throw new PostgresMigrationSourceError(
          "MAINTENANCE_REQUIRED",
          `Apply requires ${POSTGRES_MIGRATION_APPLY_CONFIRMATION_ENV}=${POSTGRES_MIGRATION_APPLY_CONFIRMATION_VALUE}.`,
        );
      }
      assertOperatorMutationAllowed("Postgres migration target apply");
    }
    const { input, outputReceipt } = await targetInputFromArguments(
      args,
      dependencies.readSecretFile ?? readPrivateSecretFile,
    );
    let receipt;
    if (subcommand === "apply") {
      receipt = await (dependencies.applyTarget ?? applyPostgresMigration)(input);
    } else {
      const readPrivateBytes = dependencies.readPrivateBytes ?? readStablePrivateArtifactBytes;
      const applyReceiptBytes = await readPrivateBytes(
        exactAbsolutePath(args.get("--apply-receipt")!),
      );
      const approvalBytes = await readPrivateBytes(
        exactAbsolutePath(args.get("--verification-approval")!),
      );
      const verifierPublicKeyBytes = await readPrivateBytes(
        exactAbsolutePath(args.get("--verifier-public-key")!),
        64 * 1024,
      );
      const applyReceiptFileSha256 = sha256PostgresMigrationBytes(applyReceiptBytes);
      const approvalFileSha256 = sha256PostgresMigrationBytes(approvalBytes);
      const verifyInput: PostgresMigrationVerifyInput = {
        ...input,
        verificationAuthority: {
          applyReceipt: parseCanonicalPrivateArtifact(
            applyReceiptBytes,
            postgresMigrationApplyReceiptSchema,
          ),
          applyReceiptFileSha256,
          expectedApplyReceiptFileSha256: args.get("--apply-receipt-sha256")!,
          approval: parseCanonicalPrivateArtifact(
            approvalBytes,
            postgresMigrationVerificationApprovalSchema,
          ),
          approvalFileSha256,
          expectedApprovalFileSha256: args.get("--verification-approval-sha256")!,
          verifierPublicKeyBytes,
          now: new Date(),
        },
      };
      receipt = await (dependencies.verifyTarget ?? verifyPostgresMigration)(verifyInput);
    }
    const receiptFileSha256 = await writePrivateReceipt(outputReceipt, receipt);
    return {
      ok: true,
      command: subcommand,
      status: receipt.status,
      receiptSha256: receipt.receiptSha256,
      receiptFileSha256,
      expectedEnvironment: receipt.expectedEnvironment,
      targetIdentitySha256: receipt.targetIdentitySha256,
      sourceSnapshotSha256: receipt.sourceSnapshotSha256,
      tableCount: receipt.tableCount,
      columnCount: receipt.columnCount,
      rowCount: receipt.rowCount,
      chunkCount: receipt.chunkCount,
      foreignKeyCount: receipt.foreignKeyCount,
    };
  }
  if (subcommand === "ledger-export") {
    const args = parseStrictArguments(rawArguments, {
      allowed: LEDGER_EXPORT_ARGUMENTS,
      required: LEDGER_EXPORT_ARGUMENTS,
    });
    const sourceSupabaseUrl = environment.SUPABASE_URL ?? "";
    const destinationSupabaseUrl = environment.OFFSITE_BACKUP_SUPABASE_URL ?? "";
    assertExactSupabaseOrigin(
      sourceSupabaseUrl,
      PRODUCTION_SUPABASE_ORIGIN,
      "SUPABASE_URL",
    );
    assertExactSupabaseOrigin(
      destinationSupabaseUrl,
      OFFSITE_BACKUP_SUPABASE_ORIGIN,
      "OFFSITE_BACKUP_SUPABASE_URL",
    );
    const destinationServiceRoleKey = await (
      dependencies.readSecretFile ?? readPrivateSecretFile
    )(
      exactAbsolutePath(args.get("--service-role-key-file")!),
    );
    assertSupabaseServerApiKey(
      destinationServiceRoleKey,
      "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
    );
    const result = await (dependencies.exportLedger ?? exportPostgresMigrationLedgerAuthority)({
      sourceSupabaseUrl,
      destinationSupabaseUrl,
      destinationServiceRoleKey,
      bucketName: resolveExactOperationalOffsiteBackupBucket(
        environment.OFFSITE_BACKUP_BUCKET,
      ),
      outputDirectory: exactAbsolutePath(args.get("--output-dir")!),
    });
    return {
      ok: true,
      command: "ledger-export",
      kind: result.manifest.kind,
      manifestSha256: result.manifestSha256,
      currentLedgerSha256: result.manifest.current.sha256,
      genesisSha256: result.manifest.genesis.sha256,
      checkpointSha256: result.manifest.checkpoint.sha256,
      immutableSetSha256: result.manifest.checkpoint.immutableSetSha256,
      immutableObjectCount: result.manifest.checkpoint.immutableObjectCount,
      tombstoneCount: result.manifest.checkpoint.tombstoneCount,
    };
  }
  if (subcommand === "snapshot") {
    assertOperatorMutationAllowed("Postgres migration source snapshot");
    const args = parseStrictArguments(rawArguments, {
      allowed: SNAPSHOT_ARGUMENTS,
      required: SNAPSHOT_ARGUMENTS,
    });
    const result = await createPostgresMigrationSnapshot({
      sourceSqlite: exactAbsolutePath(args.get("--source-sqlite")!),
      sourceEvidence: exactAbsolutePath(args.get("--source-evidence")!),
      deletionLedgerAuthorityManifest: exactAbsolutePath(args.get("--deletion-ledger-authority")!),
      outputDirectory: exactAbsolutePath(args.get("--output-dir")!),
      candidateSha: args.get("--candidate-sha")!,
      operatorId: args.get("--operator-id")!,
      maintenanceReference: args.get("--maintenance-reference")!,
      maintenanceConfirmed:
        environment[POSTGRES_MIGRATION_MAINTENANCE_ENV] === POSTGRES_MIGRATION_MAINTENANCE_VALUE,
    });
    return {
      ok: true,
      command: "snapshot",
      kind: result.manifest.kind,
      manifestSha256: result.manifestSha256,
      databaseSha256: result.manifest.database.sha256,
      sourceSchemaVersion: result.manifest.schema.sourceVersion,
      sourceSchemaFingerprint: result.manifest.schema.fingerprint,
      evidenceTreeSha256: result.manifest.evidence.treeSha256,
      evidenceFileCount: result.manifest.evidence.files,
      deletionLedgerAuthoritySha256: result.manifest.deletionLedger.authorityManifestSha256,
      deletionLedgerCurrentSha256: result.manifest.deletionLedger.currentLedgerSha256,
      deletionLedgerGenesisSha256: result.manifest.deletionLedger.genesisSha256,
      deletionLedgerCheckpointSha256: result.manifest.deletionLedger.checkpointSha256,
      deletionLedgerImmutableSetSha256: result.manifest.deletionLedger.immutableSetSha256,
      deletionLedgerTombstoneCount: result.manifest.deletionLedger.tombstoneCount,
    };
  }
  if (subcommand === "plan") {
    const args = parseStrictArguments(rawArguments, {
      allowed: PLAN_ARGUMENTS,
      required: PLAN_ARGUMENTS,
    });
    const chunkRows = exactChunkRows(args.get("--chunk-rows")!);
    const result = await createPostgresMigrationPlan({
      snapshotManifestPath: exactAbsolutePath(args.get("--snapshot-manifest")!),
      expectedSnapshotManifestSha256: args.get("--snapshot-manifest-sha256")!,
      outputPlanPath: exactAbsolutePath(args.get("--output-plan")!),
      chunkRows,
    });
    return {
      ok: true,
      command: "plan",
      kind: result.plan.kind,
      planSha256: result.planSha256,
      snapshotManifestSha256: result.plan.snapshotManifestSha256,
      sourceDatabaseSha256: result.plan.sourceDatabaseSha256,
      tableCount: result.plan.tableCount,
      columnCount: result.plan.columnCount,
      totalRows: result.plan.totalRows,
      chunkRows: result.plan.chunkRows,
    };
  }
  throw new PostgresMigrationSourceError(
    "ARGUMENT_INVALID",
    "Expected inspect-target, ledger-export, snapshot, plan, apply, or verify-target.",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = await runPostgresMigrationSourceCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const failure = safeFailure(error);
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
    })}\n`);
    process.exitCode = failure.exitCode;
  }
}
