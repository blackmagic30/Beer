import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

import { POSTGRES_MIGRATION_CONTRACT } from "./postgres-migration-contract.js";
import {
  POSTGRES_MIGRATION_LEDGER_AUTHORITY_MANIFEST_FILE,
  readPostgresMigrationLedgerAuthority,
  type ReadPostgresMigrationLedgerAuthorityBundle,
} from "./postgres-migration-ledger.js";
import {
  canonicalizePostgresMigrationJson,
  inspectPostgresMigrationSchema,
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
  sha256PostgresMigrationContract,
  type PostgresMigrationColumnContract,
  type PostgresMigrationConversion,
  type PostgresMigrationSchemaInspection,
  type PostgresMigrationTableContract,
} from "./postgres-migration-schema.js";

export const POSTGRES_MIGRATION_MAINTENANCE_ENV = "PINTPATH_SQLITE_WRITE_MAINTENANCE" as const;
export const POSTGRES_MIGRATION_MAINTENANCE_VALUE = "confirmed" as const;
export const POSTGRES_MIGRATION_SNAPSHOT_DATABASE_FILE = "pint-path.sqlite" as const;
export const POSTGRES_MIGRATION_SNAPSHOT_MANIFEST_FILE = "snapshot-manifest.json" as const;
export const POSTGRES_MIGRATION_SNAPSHOT_LEDGER_DIRECTORY = "account-deletion-ledger-authority" as const;
export const POSTGRES_MIGRATION_SNAPSHOT_KIND = "pint-path-postgres-migration-source-snapshot" as const;
export const POSTGRES_MIGRATION_PLAN_KIND = "pint-path-postgres-migration-plan" as const;
export const POSTGRES_MIGRATION_SNAPSHOT_VERSION = 2 as const;
export const POSTGRES_MIGRATION_PLAN_VERSION = 1 as const;

export type PostgresMigrationSourceErrorCode =
  | "ARTIFACT_INVALID"
  | "ARGUMENT_INVALID"
  | "MAINTENANCE_REQUIRED"
  | "SOURCE_CHANGED"
  | "SOURCE_DATA_INVALID"
  | "SOURCE_INTEGRITY_FAILED"
  | "SOURCE_SCHEMA_MISMATCH";

export class PostgresMigrationSourceError extends Error {
  constructor(
    readonly code: PostgresMigrationSourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PostgresMigrationSourceError";
  }
}

type StableFile = {
  bytes: number;
  sha256: string;
  contents?: Buffer;
};

type EvidenceTreeSummary = {
  bytes: number;
  directories: number;
  files: number;
  treeSha256: string;
};

export interface PostgresMigrationSnapshotManifest {
  readonly kind: typeof POSTGRES_MIGRATION_SNAPSHOT_KIND;
  readonly version: typeof POSTGRES_MIGRATION_SNAPSHOT_VERSION;
  readonly capturedAt: string;
  readonly candidateSha: string;
  readonly contractSha256: string;
  readonly operatorIdSha256: string;
  readonly maintenanceReferenceSha256: string;
  readonly schema: {
    readonly sourceVersion: number;
    readonly fingerprint: string;
    readonly counts: PostgresMigrationSchemaInspection["counts"];
  };
  readonly database: {
    readonly file: typeof POSTGRES_MIGRATION_SNAPSHOT_DATABASE_FILE;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly evidence: EvidenceTreeSummary;
  readonly deletionLedger: {
    readonly directory: typeof POSTGRES_MIGRATION_SNAPSHOT_LEDGER_DIRECTORY;
    readonly authorityManifestFile: typeof POSTGRES_MIGRATION_LEDGER_AUTHORITY_MANIFEST_FILE;
    readonly authorityManifestSha256: string;
    readonly currentLedgerSha256: string;
    readonly genesisSha256: string;
    readonly checkpointSha256: string;
    readonly immutableObjectCount: number;
    readonly immutableSetSha256: string;
    readonly tombstoneCount: number;
    readonly latestCompletedAt: string | null;
  };
}

export interface PostgresMigrationPlanChunk {
  readonly ordinal: number;
  readonly rowCount: number;
  readonly transformedSha256: string;
  readonly firstPrimaryKeySha256: string;
  readonly lastPrimaryKeySha256: string;
}

export interface PostgresMigrationPlanTable {
  readonly name: string;
  readonly columnCount: number;
  readonly rowCount: number;
  readonly transformedSha256: string;
  readonly conversionCounts: Readonly<Record<PostgresMigrationConversion, number>>;
  readonly chunks: readonly PostgresMigrationPlanChunk[];
}

export interface PostgresMigrationPlan {
  readonly kind: typeof POSTGRES_MIGRATION_PLAN_KIND;
  readonly version: typeof POSTGRES_MIGRATION_PLAN_VERSION;
  readonly candidateSha: string;
  readonly contractSha256: string;
  readonly snapshotManifestSha256: string;
  readonly sourceDatabaseSha256: string;
  readonly sourceSchemaVersion: number;
  readonly sourceSchemaFingerprint: string;
  readonly chunkRows: number;
  readonly tableCount: number;
  readonly columnCount: number;
  readonly totalRows: number;
  readonly importOrder: readonly string[];
  readonly tables: readonly PostgresMigrationPlanTable[];
}

type BigIntStats = fs.BigIntStats;

function sourceError(
  code: PostgresMigrationSourceErrorCode,
  message: string,
): PostgresMigrationSourceError {
  return new PostgresMigrationSourceError(code, message);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Identity(value: string, label: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    normalized.length < 3
    || normalized.length > 160
    || /[\r\n\0]/.test(normalized)
  ) {
    throw sourceError("ARGUMENT_INVALID", `${label} must be an explicit 3-160 character opaque value.`);
  }
  return sha256PostgresMigrationBytes(`${label}\0${normalized}`);
}

function normalizeCandidateSha(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(normalized)) {
    throw sourceError("ARGUMENT_INVALID", "Candidate SHA must be an exact 40- or 64-character hexadecimal digest.");
  }
  return normalized;
}

function assertSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw sourceError("ARGUMENT_INVALID", `${label} must be an exact SHA-256 digest.`);
  }
  return normalized;
}

function assertCanonicalAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    throw sourceError("ARTIFACT_INVALID", `${label} must be a canonical absolute path.`);
  }
  return value;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertSafeRegularFile(filePath: string, label: string, requiredMode?: number): BigIntStats {
  assertCanonicalAbsolutePath(filePath, label);
  let stat: BigIntStats;
  try {
    stat = fs.lstatSync(filePath, { bigint: true });
  } catch {
    throw sourceError("ARTIFACT_INVALID", `${label} must be an existing regular file.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw sourceError("ARTIFACT_INVALID", `${label} must be a regular, single-link file.`);
  }
  try {
    if (fs.realpathSync(filePath) !== filePath) throw new Error("noncanonical");
  } catch {
    throw sourceError("ARTIFACT_INVALID", `${label} must not resolve through a symlink.`);
  }
  if (requiredMode !== undefined && Number(stat.mode & 0o777n) !== requiredMode) {
    throw sourceError("ARTIFACT_INVALID", `${label} must have mode ${requiredMode.toString(8)}.`);
  }
  return stat;
}

function assertSafeDirectory(directoryPath: string, label: string, requiredMode?: number): BigIntStats {
  assertCanonicalAbsolutePath(directoryPath, label);
  let stat: BigIntStats;
  try {
    stat = fs.lstatSync(directoryPath, { bigint: true });
  } catch {
    throw sourceError("ARTIFACT_INVALID", `${label} must be an existing directory.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw sourceError("ARTIFACT_INVALID", `${label} must be a real directory.`);
  }
  try {
    if (fs.realpathSync(directoryPath) !== directoryPath) throw new Error("noncanonical");
  } catch {
    throw sourceError("ARTIFACT_INVALID", `${label} must not resolve through a symlink.`);
  }
  if (requiredMode !== undefined && Number(stat.mode & 0o777n) !== requiredMode) {
    throw sourceError("ARTIFACT_INVALID", `${label} must have mode ${requiredMode.toString(8)}.`);
  }
  return stat;
}

function assertNewCanonicalDirectory(directoryPath: string): string {
  assertCanonicalAbsolutePath(directoryPath, "Snapshot output directory");
  if (fs.existsSync(directoryPath)) {
    throw sourceError("ARTIFACT_INVALID", "Snapshot output directory must not already exist.");
  }
  assertSafeDirectory(path.dirname(directoryPath), "Snapshot output parent");
  return directoryPath;
}

function assertNewCanonicalFile(filePath: string, label: string): string {
  assertCanonicalAbsolutePath(filePath, label);
  if (fs.existsSync(filePath)) {
    throw sourceError("ARTIFACT_INVALID", `${label} must not already exist.`);
  }
  assertSafeDirectory(path.dirname(filePath), `${label} parent`);
  return filePath;
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.promises.open(directoryPath, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readStableRegularFile(
  filePath: string,
  label: string,
  options: { includeContents?: boolean; maxBytes?: number; requiredMode?: number } = {},
): Promise<StableFile> {
  const pathStat = assertSafeRegularFile(filePath, label, options.requiredMode);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const handle = await fs.promises.open(filePath, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameFileIdentity(pathStat, before) || before.nlink !== 1n) {
      throw sourceError("SOURCE_CHANGED", `${label} changed while it was opened.`);
    }
    if (before.size > BigInt(options.maxBytes ?? Number.MAX_SAFE_INTEGER)) {
      throw sourceError("ARTIFACT_INVALID", `${label} exceeds the supported size.`);
    }
    const hash = crypto.createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, position);
      if (read.bytesRead === 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      if (options.includeContents) chunks.push(Buffer.from(chunk));
      position += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, after) || BigInt(position) !== before.size) {
      throw sourceError("SOURCE_CHANGED", `${label} changed while it was read.`);
    }
    const result: StableFile = {
      bytes: position,
      sha256: hash.digest("hex"),
    };
    if (options.includeContents) result.contents = Buffer.concat(chunks, position);
    return result;
  } finally {
    await handle.close();
  }
}

function updateLengthFramed(hash: crypto.Hash, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const size = Buffer.allocUnsafe(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(size);
  hash.update(bytes);
}

async function inspectEvidenceTree(root: string): Promise<EvidenceTreeSummary> {
  assertSafeDirectory(root, "Source evidence directory");
  const entries: Array<{ kind: "directory" | "file"; relativePath: string; absolutePath: string }> = [];

  function walk(relativeDirectory: string): void {
    const absoluteDirectory = relativeDirectory ? path.join(root, relativeDirectory) : root;
    const children = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => compareStrings(left.name, right.name));
    for (const child of children) {
      const relativePath = relativeDirectory ? path.join(relativeDirectory, child.name) : child.name;
      const absolutePath = path.join(root, relativePath);
      const stat = fs.lstatSync(absolutePath, { bigint: true });
      if (stat.isSymbolicLink()) {
        throw sourceError("ARTIFACT_INVALID", "Source evidence must not contain symbolic links.");
      }
      if (stat.isDirectory()) {
        entries.push({ kind: "directory", relativePath, absolutePath });
        walk(relativePath);
      } else if (stat.isFile() && stat.nlink === 1n) {
        entries.push({ kind: "file", relativePath, absolutePath });
      } else {
        throw sourceError("ARTIFACT_INVALID", "Source evidence must contain only real directories and single-link files.");
      }
    }
  }

  walk("");
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
  const treeHash = crypto.createHash("sha256");
  updateLengthFramed(treeHash, "pint-path-evidence-tree-v1");
  let bytes = 0;
  let directories = 0;
  let files = 0;
  for (const entry of entries) {
    updateLengthFramed(treeHash, entry.kind === "directory" ? "D" : "F");
    updateLengthFramed(treeHash, entry.relativePath.split(path.sep).join("/"));
    if (entry.kind === "directory") {
      assertSafeDirectory(entry.absolutePath, "Source evidence child directory");
      directories += 1;
      continue;
    }
    const inspected = await readStableRegularFile(entry.absolutePath, "Source evidence file");
    updateLengthFramed(treeHash, inspected.sha256);
    updateLengthFramed(treeHash, String(inspected.bytes));
    files += 1;
    bytes += inspected.bytes;
    if (!Number.isSafeInteger(bytes)) {
      throw sourceError("ARTIFACT_INVALID", "Source evidence exceeds the supported total size.");
    }
  }
  return { bytes, directories, files, treeSha256: treeHash.digest("hex") };
}

function sameEvidenceTree(left: EvidenceTreeSummary, right: EvidenceTreeSummary): boolean {
  return left.bytes === right.bytes
    && left.directories === right.directories
    && left.files === right.files
    && left.treeSha256 === right.treeSha256;
}

function assertSafeSqliteSidecars(databasePath: string): void {
  for (const suffix of ["-journal", "-shm", "-wal"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (fs.existsSync(sidecar)) assertSafeRegularFile(sidecar, "SQLite sidecar");
  }
}

function assertContractInventory(): void {
  const tableNames = new Set<string>();
  let columnCount = 0;
  for (const table of POSTGRES_MIGRATION_CONTRACT.tables) {
    if (tableNames.has(table.name)) throw sourceError("SOURCE_SCHEMA_MISMATCH", "Migration contract contains a duplicate table.");
    tableNames.add(table.name);
    const columnNames = new Set<string>();
    const primaryKeyPositions: number[] = [];
    for (const column of table.columns) {
      if (columnNames.has(column[0])) throw sourceError("SOURCE_SCHEMA_MISMATCH", "Migration contract contains a duplicate column.");
      columnNames.add(column[0]);
      columnCount += 1;
      if (column[4] > 0) primaryKeyPositions.push(column[4]);
    }
    primaryKeyPositions.sort((left, right) => left - right);
    if (
      primaryKeyPositions.length === 0
      || primaryKeyPositions.some((position, index) => position !== index + 1)
    ) {
      throw sourceError("SOURCE_SCHEMA_MISMATCH", "Every migration table must have a complete primary-key contract.");
    }
  }
  if (
    tableNames.size !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables
    || columnCount !== POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns
    || POSTGRES_MIGRATION_CONTRACT.importOrder.length !== tableNames.size
    || new Set(POSTGRES_MIGRATION_CONTRACT.importOrder).size !== tableNames.size
    || POSTGRES_MIGRATION_CONTRACT.importOrder.some((table) => !tableNames.has(table))
  ) {
    throw sourceError("SOURCE_SCHEMA_MISMATCH", "Migration contract inventory is inconsistent.");
  }
}

function assertSchemaMatchesContract(inspection: PostgresMigrationSchemaInspection): void {
  if (inspection.descriptor.userVersion !== POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion) {
    throw sourceError("SOURCE_SCHEMA_MISMATCH", "SQLite source schema version does not match the reviewed migration contract.");
  }
  if (
    inspection.fingerprint !== POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint
    || JSON.stringify(inspection.counts) !== JSON.stringify(POSTGRES_MIGRATION_CONTRACT.expectedCounts)
  ) {
    throw sourceError("SOURCE_SCHEMA_MISMATCH", "SQLite source schema fingerprint does not match the reviewed migration contract.");
  }
  const contractByTable = new Map<string, PostgresMigrationTableContract>(
    POSTGRES_MIGRATION_CONTRACT.tables.map((table) => [table.name, table]),
  );
  for (const table of inspection.descriptor.tables) {
    const expected = contractByTable.get(table.name);
    if (!expected || table.columns.length !== expected.columns.length) {
      throw sourceError("SOURCE_SCHEMA_MISMATCH", "SQLite source table inventory does not match the migration contract.");
    }
    table.columns.forEach((column, index) => {
      const expectedColumn = expected.columns[index];
      if (
        !expectedColumn
        || expectedColumn[0] !== column.name
        || expectedColumn[1] !== column.type
        || expectedColumn[3] !== (column.notnull === 0 && column.pk === 0)
        || expectedColumn[4] !== column.pk
      ) {
        throw sourceError("SOURCE_SCHEMA_MISMATCH", "SQLite source column inventory does not match the migration contract.");
      }
    });
  }
}

function inspectAndValidateSqlite(database: BetterSqlite3.Database): PostgresMigrationSchemaInspection {
  const integrityRows = database.pragma("integrity_check") as Array<Record<string, unknown>>;
  if (
    integrityRows.length !== 1
    || String(Object.values(integrityRows[0] ?? {})[0] ?? "").toLowerCase() !== "ok"
  ) {
    throw sourceError("SOURCE_INTEGRITY_FAILED", "SQLite integrity_check did not return exactly one ok row.");
  }
  const foreignKeyRows = database.pragma("foreign_key_check") as Array<Record<string, unknown>>;
  if (foreignKeyRows.length > 0) {
    throw sourceError("SOURCE_INTEGRITY_FAILED", "SQLite foreign_key_check reported violations.");
  }
  const inspection = inspectPostgresMigrationSchema(database);
  assertSchemaMatchesContract(inspection);
  return inspection;
}

function openValidatedReadOnlySqlite(databasePath: string): BetterSqlite3.Database {
  assertSafeRegularFile(databasePath, "SQLite source database");
  assertSafeSqliteSidecars(databasePath);
  const database = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
  try {
    database.pragma("query_only = ON");
    database.pragma("foreign_keys = ON");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function writeNewCanonicalJson(filePath: string, value: unknown): Promise<string> {
  assertNewCanonicalFile(filePath, "Migration artifact");
  const bytes = serializeCanonicalPostgresMigrationJson(value);
  const handle = await fs.promises.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  assertSafeRegularFile(filePath, "Migration artifact", 0o600);
  await fsyncDirectory(path.dirname(filePath));
  return sha256PostgresMigrationBytes(bytes);
}

async function writeNewPrivateBytes(filePath: string, bytes: Buffer): Promise<void> {
  assertNewCanonicalFile(filePath, "Migration private artifact");
  const handle = await fs.promises.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  assertSafeRegularFile(filePath, "Migration private artifact", 0o600);
}

function sameLedgerAuthority(
  left: ReadPostgresMigrationLedgerAuthorityBundle,
  right: ReadPostgresMigrationLedgerAuthorityBundle,
): boolean {
  return left.manifestSha256 === right.manifestSha256
    && left.manifest.current.sha256 === right.manifest.current.sha256
    && left.manifest.genesis.sha256 === right.manifest.genesis.sha256
    && left.manifest.checkpoint.sha256 === right.manifest.checkpoint.sha256
    && left.manifest.checkpoint.immutableSetSha256 === right.manifest.checkpoint.immutableSetSha256;
}

async function readSourceLedgerAuthority(
  manifestPath: string,
): Promise<ReadPostgresMigrationLedgerAuthorityBundle> {
  try {
    return await readPostgresMigrationLedgerAuthority(manifestPath);
  } catch {
    throw sourceError("ARTIFACT_INVALID", "Deletion ledger authority bundle is missing or invalid.");
  }
}

async function copyLedgerAuthorityIntoSnapshot(
  bundle: ReadPostgresMigrationLedgerAuthorityBundle,
  snapshotDirectory: string,
): Promise<void> {
  const outputDirectory = path.join(snapshotDirectory, POSTGRES_MIGRATION_SNAPSHOT_LEDGER_DIRECTORY);
  await fs.promises.mkdir(outputDirectory, { mode: 0o700 });
  await fs.promises.chmod(outputDirectory, 0o700);
  assertSafeDirectory(outputDirectory, "Snapshot ledger authority directory", 0o700);
  await Promise.all([
    writeNewPrivateBytes(
      path.join(outputDirectory, POSTGRES_MIGRATION_LEDGER_AUTHORITY_MANIFEST_FILE),
      bundle.manifestBytes,
    ),
    writeNewPrivateBytes(path.join(outputDirectory, bundle.manifest.current.file), bundle.currentBytes),
    writeNewPrivateBytes(path.join(outputDirectory, bundle.manifest.genesis.file), bundle.genesisBytes),
    writeNewPrivateBytes(path.join(outputDirectory, bundle.manifest.checkpoint.file), bundle.checkpointBytes),
  ]);
  await fsyncDirectory(outputDirectory);
}

function assertNormalizedUtcInstant(value: string, label: string): string {
  try {
    return normalizeUtcInstant(value);
  } catch {
    throw sourceError("ARGUMENT_INVALID", `${label} must be an unambiguous UTC timestamp.`);
  }
}

export async function createPostgresMigrationSnapshot(input: {
  sourceSqlite: string;
  sourceEvidence: string;
  deletionLedgerAuthorityManifest: string;
  outputDirectory: string;
  candidateSha: string;
  operatorId: string;
  maintenanceReference: string;
  maintenanceConfirmed: boolean;
  capturedAt?: string;
}): Promise<{
  snapshotDirectory: string;
  databasePath: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: PostgresMigrationSnapshotManifest;
}> {
  assertContractInventory();
  if (!input.maintenanceConfirmed) {
    throw sourceError(
      "MAINTENANCE_REQUIRED",
      `Snapshot requires ${POSTGRES_MIGRATION_MAINTENANCE_ENV}=${POSTGRES_MIGRATION_MAINTENANCE_VALUE} and a signed maintenance reference.`,
    );
  }
  const sourceSqlite = assertCanonicalAbsolutePath(input.sourceSqlite, "SQLite source database");
  const sourceEvidence = assertCanonicalAbsolutePath(input.sourceEvidence, "Source evidence directory");
  const deletionLedgerAuthorityManifest = assertCanonicalAbsolutePath(
    input.deletionLedgerAuthorityManifest,
    "Deletion ledger authority manifest",
  );
  const deletionLedgerAuthorityDirectory = path.dirname(deletionLedgerAuthorityManifest);
  const outputDirectory = assertNewCanonicalDirectory(input.outputDirectory);
  if (
    outputDirectory === sourceEvidence
    || outputDirectory.startsWith(`${sourceEvidence}${path.sep}`)
    || outputDirectory === deletionLedgerAuthorityDirectory
    || outputDirectory.startsWith(`${deletionLedgerAuthorityDirectory}${path.sep}`)
    || sourceSqlite.startsWith(`${outputDirectory}${path.sep}`)
    || deletionLedgerAuthorityManifest.startsWith(`${outputDirectory}${path.sep}`)
  ) {
    throw sourceError("ARTIFACT_INVALID", "Snapshot output must be separate from every source artifact.");
  }
  assertSafeRegularFile(sourceSqlite, "SQLite source database");
  assertSafeDirectory(sourceEvidence, "Source evidence directory");

  const candidateSha = normalizeCandidateSha(input.candidateSha);
  const operatorIdSha256 = sha256Identity(input.operatorId, "operator-id");
  const maintenanceReferenceSha256 = sha256Identity(input.maintenanceReference, "maintenance-reference");
  const capturedAt = assertNormalizedUtcInstant(input.capturedAt ?? new Date().toISOString(), "Captured at");
  const contractSha256 = sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT);
  const databasePath = path.join(outputDirectory, POSTGRES_MIGRATION_SNAPSHOT_DATABASE_FILE);
  const manifestPath = path.join(outputDirectory, POSTGRES_MIGRATION_SNAPSHOT_MANIFEST_FILE);
  let outputCreated = false;
  let source: BetterSqlite3.Database | undefined;

  try {
    await fs.promises.mkdir(outputDirectory, { mode: 0o700 });
    outputCreated = true;
    await fs.promises.chmod(outputDirectory, 0o700);
    assertSafeDirectory(outputDirectory, "Snapshot output directory", 0o700);
    await fsyncDirectory(path.dirname(outputDirectory));

    source = openValidatedReadOnlySqlite(sourceSqlite);
    const sourceDataVersionBefore = Number(source.pragma("data_version", { simple: true }));
    const sourceInspectionBefore = inspectAndValidateSqlite(source);
    const evidenceBefore = await inspectEvidenceTree(sourceEvidence);
    const ledgerBefore = await readSourceLedgerAuthority(deletionLedgerAuthorityManifest);

    await source.backup(databasePath);
    await fs.promises.chmod(databasePath, 0o600);
    await copyLedgerAuthorityIntoSnapshot(ledgerBefore, outputDirectory);

    const sourceDataVersionAfter = Number(source.pragma("data_version", { simple: true }));
    const sourceInspectionAfter = inspectAndValidateSqlite(source);
    const evidenceAfter = await inspectEvidenceTree(sourceEvidence);
    const ledgerAfter = await readSourceLedgerAuthority(deletionLedgerAuthorityManifest);
    if (
      sourceDataVersionBefore !== sourceDataVersionAfter
      || sourceInspectionBefore.fingerprint !== sourceInspectionAfter.fingerprint
      || !sameEvidenceTree(evidenceBefore, evidenceAfter)
      || !sameLedgerAuthority(ledgerBefore, ledgerAfter)
    ) {
      throw sourceError("SOURCE_CHANGED", "A migration source changed during the snapshot window.");
    }
    source.close();
    source = undefined;

    const normalized = new BetterSqlite3(databasePath, { fileMustExist: true });
    try {
      normalized.pragma("foreign_keys = ON");
      const journalMode = String(normalized.pragma("journal_mode = DELETE", { simple: true })).toLowerCase();
      if (journalMode !== "delete") {
        throw sourceError("ARTIFACT_INVALID", "Snapshot journal mode could not be normalized.");
      }
    } finally {
      normalized.close();
    }
    await fs.promises.rm(`${databasePath}-wal`, { force: true });
    await fs.promises.rm(`${databasePath}-shm`, { force: true });
    await fs.promises.rm(`${databasePath}-journal`, { force: true });
    await fs.promises.chmod(databasePath, 0o600);
    assertSafeRegularFile(databasePath, "Snapshot database", 0o600);

    const snapshot = openValidatedReadOnlySqlite(databasePath);
    let snapshotInspection: PostgresMigrationSchemaInspection;
    try {
      snapshotInspection = inspectAndValidateSqlite(snapshot);
    } finally {
      snapshot.close();
    }
    const database = await readStableRegularFile(databasePath, "Snapshot database", { requiredMode: 0o600 });
    const copiedLedger = await readPostgresMigrationLedgerAuthority(path.join(
      outputDirectory,
      POSTGRES_MIGRATION_SNAPSHOT_LEDGER_DIRECTORY,
      POSTGRES_MIGRATION_LEDGER_AUTHORITY_MANIFEST_FILE,
    ));
    if (!sameLedgerAuthority(ledgerAfter, copiedLedger)) {
      throw sourceError("ARTIFACT_INVALID", "Snapshot ledger authority copy differs from its verified source.");
    }
    const databaseHandle = await fs.promises.open(databasePath, fs.constants.O_RDONLY);
    try {
      await databaseHandle.sync();
    } finally {
      await databaseHandle.close();
    }
    const manifest: PostgresMigrationSnapshotManifest = {
      kind: POSTGRES_MIGRATION_SNAPSHOT_KIND,
      version: POSTGRES_MIGRATION_SNAPSHOT_VERSION,
      capturedAt,
      candidateSha,
      contractSha256,
      operatorIdSha256,
      maintenanceReferenceSha256,
      schema: {
        sourceVersion: snapshotInspection.descriptor.userVersion,
        fingerprint: snapshotInspection.fingerprint,
        counts: snapshotInspection.counts,
      },
      database: {
        file: POSTGRES_MIGRATION_SNAPSHOT_DATABASE_FILE,
        bytes: database.bytes,
        sha256: database.sha256,
      },
      evidence: evidenceAfter,
      deletionLedger: {
        directory: POSTGRES_MIGRATION_SNAPSHOT_LEDGER_DIRECTORY,
        authorityManifestFile: POSTGRES_MIGRATION_LEDGER_AUTHORITY_MANIFEST_FILE,
        authorityManifestSha256: ledgerAfter.manifestSha256,
        currentLedgerSha256: ledgerAfter.manifest.current.sha256,
        genesisSha256: ledgerAfter.manifest.genesis.sha256,
        checkpointSha256: ledgerAfter.manifest.checkpoint.sha256,
        immutableObjectCount: ledgerAfter.manifest.checkpoint.immutableObjectCount,
        immutableSetSha256: ledgerAfter.manifest.checkpoint.immutableSetSha256,
        tombstoneCount: ledgerAfter.manifest.checkpoint.tombstoneCount,
        latestCompletedAt: ledgerAfter.manifest.checkpoint.latestCompletedAt,
      },
    };
    const manifestSha256 = await writeNewCanonicalJson(manifestPath, manifest);
    await fsyncDirectory(outputDirectory);
    return { snapshotDirectory: outputDirectory, databasePath, manifestPath, manifestSha256, manifest };
  } catch (error) {
    source?.close();
    if (outputCreated) await fs.promises.rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

function assertJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw sourceError("ARTIFACT_INVALID", `${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...keys].sort(compareStrings);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw sourceError("ARTIFACT_INVALID", `${label} has an unexpected shape.`);
  }
}

function assertSafeNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw sourceError("ARTIFACT_INVALID", `${label} must be a safe nonnegative integer.`);
  }
  return value;
}

function assertCanonicalLedgerUtc(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw sourceError("ARTIFACT_INVALID", `${label} must be a canonical millisecond UTC instant.`);
  }
  return value;
}

function normalizeSnapshotManifest(value: unknown): PostgresMigrationSnapshotManifest {
  const manifest = assertJsonObject(value, "Snapshot manifest");
  assertExactKeys(manifest, [
    "candidateSha",
    "capturedAt",
    "contractSha256",
    "database",
    "deletionLedger",
    "evidence",
    "kind",
    "maintenanceReferenceSha256",
    "operatorIdSha256",
    "schema",
    "version",
  ], "Snapshot manifest");
  if (manifest.kind !== POSTGRES_MIGRATION_SNAPSHOT_KIND || manifest.version !== POSTGRES_MIGRATION_SNAPSHOT_VERSION) {
    throw sourceError("ARTIFACT_INVALID", "Snapshot manifest kind or version is unsupported.");
  }
  const schema = assertJsonObject(manifest.schema, "Snapshot schema");
  const counts = assertJsonObject(schema.counts, "Snapshot schema counts");
  const database = assertJsonObject(manifest.database, "Snapshot database");
  const evidence = assertJsonObject(manifest.evidence, "Snapshot evidence");
  const deletionLedger = assertJsonObject(manifest.deletionLedger, "Snapshot deletion ledger");
  assertExactKeys(schema, ["counts", "fingerprint", "sourceVersion"], "Snapshot schema");
  assertExactKeys(counts, ["automaticIndexes", "columns", "explicitIndexes", "foreignKeys", "tables", "triggers"], "Snapshot schema counts");
  assertExactKeys(database, ["bytes", "file", "sha256"], "Snapshot database");
  assertExactKeys(evidence, ["bytes", "directories", "files", "treeSha256"], "Snapshot evidence");
  assertExactKeys(deletionLedger, [
    "authorityManifestFile",
    "authorityManifestSha256",
    "checkpointSha256",
    "currentLedgerSha256",
    "directory",
    "genesisSha256",
    "immutableObjectCount",
    "immutableSetSha256",
    "latestCompletedAt",
    "tombstoneCount",
  ], "Snapshot deletion ledger");

  const normalized: PostgresMigrationSnapshotManifest = {
    kind: POSTGRES_MIGRATION_SNAPSHOT_KIND,
    version: POSTGRES_MIGRATION_SNAPSHOT_VERSION,
    capturedAt: assertNormalizedUtcInstant(String(manifest.capturedAt ?? ""), "Snapshot capturedAt"),
    candidateSha: normalizeCandidateSha(String(manifest.candidateSha ?? "")),
    contractSha256: assertSha256(String(manifest.contractSha256 ?? ""), "Contract hash"),
    operatorIdSha256: assertSha256(String(manifest.operatorIdSha256 ?? ""), "Operator identity hash"),
    maintenanceReferenceSha256: assertSha256(String(manifest.maintenanceReferenceSha256 ?? ""), "Maintenance reference hash"),
    schema: {
      sourceVersion: assertSafeNonnegativeInteger(schema.sourceVersion, "Source schema version"),
      fingerprint: assertSha256(String(schema.fingerprint ?? ""), "Source schema fingerprint"),
      counts: {
        tables: assertSafeNonnegativeInteger(counts.tables, "Source table count"),
        columns: assertSafeNonnegativeInteger(counts.columns, "Source column count"),
        foreignKeys: assertSafeNonnegativeInteger(counts.foreignKeys, "Source foreign-key count"),
        explicitIndexes: assertSafeNonnegativeInteger(counts.explicitIndexes, "Source explicit-index count"),
        automaticIndexes: assertSafeNonnegativeInteger(counts.automaticIndexes, "Source automatic-index count"),
        triggers: assertSafeNonnegativeInteger(counts.triggers, "Source trigger count"),
      },
    },
    database: {
      file: database.file === POSTGRES_MIGRATION_SNAPSHOT_DATABASE_FILE
        ? POSTGRES_MIGRATION_SNAPSHOT_DATABASE_FILE
        : (() => { throw sourceError("ARTIFACT_INVALID", "Snapshot database filename is invalid."); })(),
      bytes: assertSafeNonnegativeInteger(database.bytes, "Snapshot database bytes"),
      sha256: assertSha256(String(database.sha256 ?? ""), "Snapshot database hash"),
    },
    evidence: {
      bytes: assertSafeNonnegativeInteger(evidence.bytes, "Evidence bytes"),
      directories: assertSafeNonnegativeInteger(evidence.directories, "Evidence directory count"),
      files: assertSafeNonnegativeInteger(evidence.files, "Evidence file count"),
      treeSha256: assertSha256(String(evidence.treeSha256 ?? ""), "Evidence tree hash"),
    },
    deletionLedger: {
      directory: deletionLedger.directory === POSTGRES_MIGRATION_SNAPSHOT_LEDGER_DIRECTORY
        ? POSTGRES_MIGRATION_SNAPSHOT_LEDGER_DIRECTORY
        : (() => { throw sourceError("ARTIFACT_INVALID", "Snapshot ledger directory is invalid."); })(),
      authorityManifestFile: deletionLedger.authorityManifestFile === POSTGRES_MIGRATION_LEDGER_AUTHORITY_MANIFEST_FILE
        ? POSTGRES_MIGRATION_LEDGER_AUTHORITY_MANIFEST_FILE
        : (() => { throw sourceError("ARTIFACT_INVALID", "Snapshot ledger manifest filename is invalid."); })(),
      authorityManifestSha256: assertSha256(
        String(deletionLedger.authorityManifestSha256 ?? ""),
        "Ledger authority manifest hash",
      ),
      currentLedgerSha256: assertSha256(
        String(deletionLedger.currentLedgerSha256 ?? ""),
        "Current deletion ledger hash",
      ),
      genesisSha256: assertSha256(String(deletionLedger.genesisSha256 ?? ""), "Ledger genesis hash"),
      checkpointSha256: assertSha256(
        String(deletionLedger.checkpointSha256 ?? ""),
        "Ledger checkpoint hash",
      ),
      immutableObjectCount: assertSafeNonnegativeInteger(
        deletionLedger.immutableObjectCount,
        "Immutable ledger object count",
      ),
      immutableSetSha256: assertSha256(
        String(deletionLedger.immutableSetSha256 ?? ""),
        "Immutable ledger set hash",
      ),
      tombstoneCount: assertSafeNonnegativeInteger(
        deletionLedger.tombstoneCount,
        "Ledger tombstone count",
      ),
      latestCompletedAt: deletionLedger.latestCompletedAt === null
        ? null
        : assertCanonicalLedgerUtc(deletionLedger.latestCompletedAt, "Ledger latestCompletedAt"),
    },
  };
  if (
    normalized.contractSha256 !== sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT)
    || normalized.schema.sourceVersion !== POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion
    || normalized.schema.fingerprint !== POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint
    || JSON.stringify(normalized.schema.counts) !== JSON.stringify(POSTGRES_MIGRATION_CONTRACT.expectedCounts)
  ) {
    throw sourceError("ARTIFACT_INVALID", "Snapshot manifest is bound to a different migration contract.");
  }
  if (
    (normalized.deletionLedger.tombstoneCount === 0) !== (normalized.deletionLedger.latestCompletedAt === null)
  ) {
    throw sourceError("ARTIFACT_INVALID", "Snapshot ledger count and latest completion time disagree.");
  }
  return normalized;
}

async function readSnapshotLedgerAuthority(
  snapshotDirectory: string,
  expected: PostgresMigrationSnapshotManifest["deletionLedger"],
): Promise<ReadPostgresMigrationLedgerAuthorityBundle> {
  let bundle: ReadPostgresMigrationLedgerAuthorityBundle;
  try {
    bundle = await readPostgresMigrationLedgerAuthority(path.join(
      snapshotDirectory,
      expected.directory,
      expected.authorityManifestFile,
    ));
  } catch {
    throw sourceError("ARTIFACT_INVALID", "Snapshot ledger authority bundle is missing or invalid.");
  }
  if (
    bundle.manifestSha256 !== expected.authorityManifestSha256
    || bundle.manifest.current.sha256 !== expected.currentLedgerSha256
    || bundle.manifest.genesis.sha256 !== expected.genesisSha256
    || bundle.manifest.checkpoint.sha256 !== expected.checkpointSha256
    || bundle.manifest.checkpoint.immutableObjectCount !== expected.immutableObjectCount
    || bundle.manifest.checkpoint.immutableSetSha256 !== expected.immutableSetSha256
    || bundle.manifest.checkpoint.tombstoneCount !== expected.tombstoneCount
    || bundle.manifest.checkpoint.latestCompletedAt !== expected.latestCompletedAt
  ) {
    throw sourceError("ARTIFACT_INVALID", "Snapshot ledger authority differs from its snapshot manifest.");
  }
  return bundle;
}

function assertValidUnicodeText(value: string): void {
  if (value.includes("\0")) throw new Error("NUL is not supported by Postgres text.");
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("Unpaired high surrogate.");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("Unpaired low surrogate.");
    }
  }
}

function normalizeExactDecimalToken(token: string): string {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) throw new Error("Invalid decimal token.");
  const negative = match[1] === "-";
  const integer = match[2]!;
  const fraction = match[3] ?? "";
  const suppliedExponent = BigInt(match[4] ?? "0");
  let digits = `${integer}${fraction}`.replace(/^0+/, "");
  if (!digits) return "0";
  let trailingZeros = 0;
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    trailingZeros += 1;
  }
  const exponent = suppliedExponent - BigInt(fraction.length) + BigInt(trailingZeros);
  const digitsBeforeDecimal = BigInt(digits.length) + exponent;
  const digitsAfterDecimal = exponent < 0n ? -exponent : 0n;
  if (digitsBeforeDecimal > 131072n || digitsAfterDecimal > 16383n) {
    throw new Error("Decimal is outside the Postgres numeric range.");
  }
  return `${negative ? "-" : ""}${digits}${exponent === 0n ? "" : `e${exponent}`}`;
}

type ParsedLosslessJson = {
  canonical: string;
  kind: "array" | "boolean" | "null" | "number" | "object" | "string";
};

class LosslessJsonParser {
  private index = 0;

  constructor(private readonly source: string) {
    if (Buffer.byteLength(source, "utf8") > 64 * 1024 * 1024) throw new Error("JSON cell is too large.");
  }

  parse(): ParsedLosslessJson {
    const result = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) throw new Error("Trailing JSON content.");
    return result;
  }

  private skipWhitespace(): void {
    while (/[\t\n\r ]/.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private parseValue(depth: number): ParsedLosslessJson {
    if (depth > 128) throw new Error("JSON nesting is too deep.");
    this.skipWhitespace();
    const character = this.source[this.index];
    if (character === "{") return this.parseObject(depth + 1);
    if (character === "[") return this.parseArray(depth + 1);
    if (character === '"') return { canonical: JSON.stringify(this.parseString()), kind: "string" };
    for (const [literal, kind] of [["true", "boolean"], ["false", "boolean"], ["null", "null"]] as const) {
      if (this.source.startsWith(literal, this.index)) {
        this.index += literal.length;
        return { canonical: literal, kind };
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index))?.[0];
    if (!number) throw new Error("Invalid JSON value.");
    this.index += number.length;
    return { canonical: normalizeExactDecimalToken(number), kind: "number" };
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.source.length) {
      const character = this.source[this.index]!;
      const code = this.source.charCodeAt(this.index);
      if (!escaped && character === '"') {
        this.index += 1;
        const value = JSON.parse(this.source.slice(start, this.index)) as string;
        assertValidUnicodeText(value);
        return value;
      }
      if (!escaped && code < 0x20) throw new Error("Unescaped JSON control character.");
      if (!escaped && character === "\\") escaped = true;
      else escaped = false;
      this.index += 1;
    }
    throw new Error("Unterminated JSON string.");
  }

  private parseObject(depth: number): ParsedLosslessJson {
    this.index += 1;
    this.skipWhitespace();
    const entries: Array<[string, string]> = [];
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return { canonical: "{}", kind: "object" };
    }
    while (true) {
      this.skipWhitespace();
      if (this.source[this.index] !== '"') throw new Error("JSON object key must be a string.");
      const key = this.parseString();
      if (keys.has(key)) throw new Error("JSON object contains a duplicate key.");
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") throw new Error("JSON object is missing a colon.");
      this.index += 1;
      const value = this.parseValue(depth);
      entries.push([key, value.canonical]);
      this.skipWhitespace();
      const separator = this.source[this.index];
      if (separator === "}") {
        this.index += 1;
        break;
      }
      if (separator !== ",") throw new Error("JSON object is missing a separator.");
      this.index += 1;
    }
    entries.sort(([left], [right]) => compareStrings(left, right));
    return {
      canonical: `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`,
      kind: "object",
    };
  }

  private parseArray(depth: number): ParsedLosslessJson {
    this.index += 1;
    this.skipWhitespace();
    const values: string[] = [];
    if (this.source[this.index] === "]") {
      this.index += 1;
      return { canonical: "[]", kind: "array" };
    }
    while (true) {
      values.push(this.parseValue(depth).canonical);
      this.skipWhitespace();
      const separator = this.source[this.index];
      if (separator === "]") {
        this.index += 1;
        break;
      }
      if (separator !== ",") throw new Error("JSON array is missing a separator.");
      this.index += 1;
    }
    return { canonical: `[${values.join(",")}]`, kind: "array" };
  }
}

function normalizeUtcInstant(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) throw new Error("Invalid UTC instant.");
  const legacySpace = value[10] === " ";
  const zone = match[8];
  if (!zone && !legacySpace) throw new Error("Timestamp offset is required.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) throw new Error("Invalid UTC instant fields.");
  const base = new Date(0);
  base.setUTCFullYear(year, month - 1, day);
  base.setUTCHours(hour, minute, second, 0);
  if (
    base.getUTCFullYear() !== year
    || base.getUTCMonth() !== month - 1
    || base.getUTCDate() !== day
    || base.getUTCHours() !== hour
    || base.getUTCMinutes() !== minute
    || base.getUTCSeconds() !== second
  ) {
    throw new Error("Invalid UTC calendar date.");
  }
  let offsetMinutes = 0;
  if (zone && zone !== "Z") {
    const sign = zone[0] === "+" ? 1 : -1;
    const offsetHours = Number(zone.slice(1, 3));
    const offsetRemainder = Number(zone.slice(4, 6));
    if (offsetHours > 14 || offsetRemainder > 59 || (offsetHours === 14 && offsetRemainder !== 0)) {
      throw new Error("Invalid UTC offset.");
    }
    offsetMinutes = sign * (offsetHours * 60 + offsetRemainder);
  }
  const shifted = new Date(base.getTime() - offsetMinutes * 60_000);
  const fraction = (match[7] ?? "").padEnd(6, "0");
  return `${shifted.toISOString().slice(0, 19)}.${fraction}Z`;
}

function normalizeLocalTime(value: string): string {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/.exec(value);
  if (!match) throw new Error("Invalid local time.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? "0");
  if (hour > 23 || minute > 59 || second > 59) throw new Error("Invalid local time fields.");
  return `${match[1]}:${match[2]}:${match[3] ?? "00"}.${(match[4] ?? "").padEnd(6, "0")}`;
}

function canonicalSourceValue(value: unknown, column: PostgresMigrationColumnContract): string {
  if (value === null) {
    if (!column[3]) throw new Error("Required source value is null.");
    return "N";
  }
  switch (column[2]) {
    case "binary":
      if (!Buffer.isBuffer(value)) throw new Error("Expected binary source value.");
      return `X${value.toString("base64")}`;
    case "boolean":
      if (typeof value !== "bigint" || (value !== 0n && value !== 1n)) throw new Error("Expected 0/1 source boolean.");
      return `B${value === 1n ? "1" : "0"}`;
    case "calendar-month":
      if (typeof value !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) throw new Error("Invalid calendar month.");
      return `T${value}`;
    case "decimal":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected finite source decimal.");
      return `D${normalizeExactDecimalToken(value.toString())}`;
    case "float64": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected finite source float.");
      const bytes = Buffer.allocUnsafe(8);
      bytes.writeDoubleBE(value);
      return `F${bytes.toString("hex")}`;
    }
    case "integer":
      if (typeof value !== "bigint") throw new Error("Expected exact source integer.");
      return `I${value}`;
    case "json-array":
    case "json-object": {
      if (typeof value !== "string") throw new Error("Expected JSON source text.");
      const parsed = new LosslessJsonParser(value).parse();
      const expectedKind = column[2] === "json-array" ? "array" : "object";
      if (parsed.kind !== expectedKind) throw new Error("JSON root type does not match the contract.");
      return `J${parsed.canonical}`;
    }
    case "local-time":
      if (typeof value !== "string") throw new Error("Expected local-time source text.");
      return `t${normalizeLocalTime(value)}`;
    case "text":
      if (typeof value !== "string") throw new Error("Expected source text.");
      assertValidUnicodeText(value);
      return `T${value}`;
    case "utc-instant":
      if (typeof value !== "string") throw new Error("Expected timestamp source text.");
      return `Z${normalizeUtcInstant(value)}`;
  }
}

function canonicalRawKey(values: readonly unknown[]): Buffer {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, "pint-path-source-primary-key-v1");
  for (const value of values) {
    if (value === null) updateLengthFramed(hash, "N");
    else if (Buffer.isBuffer(value)) updateLengthFramed(hash, `X${value.toString("base64")}`);
    else if (typeof value === "bigint") updateLengthFramed(hash, `I${value}`);
    else if (typeof value === "number") {
      const bytes = Buffer.allocUnsafe(8);
      bytes.writeDoubleBE(value);
      updateLengthFramed(hash, `F${bytes.toString("hex")}`);
    } else if (typeof value === "string") updateLengthFramed(hash, `T${value}`);
    else updateLengthFramed(hash, "U");
  }
  return hash.digest();
}

function encodeCanonicalRow(table: PostgresMigrationTableContract, row: Record<string, unknown>): Buffer {
  const hash = crypto.createHash("sha256");
  updateLengthFramed(hash, "pint-path-postgres-transformed-row-v1");
  updateLengthFramed(hash, table.name);
  for (const column of table.columns) {
    updateLengthFramed(hash, column[0]);
    updateLengthFramed(hash, canonicalSourceValue(row[column[0]], column));
  }
  return hash.digest();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function emptyConversionCounts(): Record<PostgresMigrationConversion, number> {
  return {
    binary: 0,
    boolean: 0,
    "calendar-month": 0,
    decimal: 0,
    float64: 0,
    integer: 0,
    "json-array": 0,
    "json-object": 0,
    "local-time": 0,
    text: 0,
    "utc-instant": 0,
  };
}

function scanMigrationTable(
  database: BetterSqlite3.Database,
  table: PostgresMigrationTableContract,
  chunkRows: number,
  contractSha256: string,
): PostgresMigrationPlanTable {
  const primaryKey = table.columns
    .filter((column) => column[4] > 0)
    .sort((left, right) => left[4] - right[4]);
  const select = table.columns.map((column) => quoteIdentifier(column[0])).join(", ");
  const order = primaryKey.map((column) => (
    column[1] === "TEXT"
      ? `${quoteIdentifier(column[0])} COLLATE BINARY ASC`
      : `${quoteIdentifier(column[0])} ASC`
  )).join(", ");
  const statement = database.prepare(
    `SELECT ${select} FROM ${quoteIdentifier(table.name)} ORDER BY ${order}`,
  ).safeIntegers(true);
  const fullHash = crypto.createHash("sha256");
  updateLengthFramed(fullHash, "pint-path-postgres-transformed-table-v1");
  updateLengthFramed(fullHash, contractSha256);
  updateLengthFramed(fullHash, table.name);
  for (const column of table.columns) updateLengthFramed(fullHash, column[0]);
  const chunks: PostgresMigrationPlanChunk[] = [];
  const conversionCounts = emptyConversionCounts();
  let chunkHash: crypto.Hash | null = null;
  let chunkCount = 0;
  let firstPrimaryKeySha256 = "";
  let lastPrimaryKeySha256 = "";
  let rowCount = 0;

  function beginChunk(): void {
    chunkHash = crypto.createHash("sha256");
    updateLengthFramed(chunkHash, "pint-path-postgres-transformed-chunk-v1");
    updateLengthFramed(chunkHash, contractSha256);
    updateLengthFramed(chunkHash, table.name);
    updateLengthFramed(chunkHash, String(chunks.length));
    chunkCount = 0;
    firstPrimaryKeySha256 = "";
    lastPrimaryKeySha256 = "";
  }

  function finishChunk(): void {
    if (!chunkHash || chunkCount === 0) return;
    chunks.push({
      ordinal: chunks.length,
      rowCount: chunkCount,
      transformedSha256: chunkHash.digest("hex"),
      firstPrimaryKeySha256,
      lastPrimaryKeySha256,
    });
    chunkHash = null;
  }

  for (const rawRow of statement.iterate() as IterableIterator<Record<string, unknown>>) {
    const primaryKeyValues = primaryKey.map((column) => rawRow[column[0]]);
    const primaryKeySha256 = canonicalRawKey(primaryKeyValues).toString("hex");
    let canonicalRow: Buffer;
    try {
      canonicalRow = encodeCanonicalRow(table, rawRow);
    } catch {
      const failedColumn = table.columns.find((column) => {
        try {
          canonicalSourceValue(rawRow[column[0]], column);
          return false;
        } catch {
          return true;
        }
      });
      throw sourceError(
        "SOURCE_DATA_INVALID",
        `Source conversion failed in ${table.name}.${failedColumn?.[0] ?? "unknown"} at row ${rowCount + 1} (primary-key SHA-256 ${primaryKeySha256}).`,
      );
    }
    if (!chunkHash) beginChunk();
    if (chunkCount === 0) firstPrimaryKeySha256 = primaryKeySha256;
    lastPrimaryKeySha256 = primaryKeySha256;
    updateLengthFramed(fullHash, canonicalRow);
    updateLengthFramed(chunkHash!, canonicalRow);
    for (const column of table.columns) {
      if (rawRow[column[0]] !== null) conversionCounts[column[2]] += 1;
    }
    rowCount += 1;
    chunkCount += 1;
    if (!Number.isSafeInteger(rowCount)) {
      throw sourceError("SOURCE_DATA_INVALID", `Source table ${table.name} exceeds the supported row count.`);
    }
    if (chunkCount === chunkRows) finishChunk();
  }
  finishChunk();
  return {
    name: table.name,
    columnCount: table.columns.length,
    rowCount,
    transformedSha256: fullHash.digest("hex"),
    conversionCounts,
    chunks,
  };
}

function normalizeChunkRows(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw sourceError("ARGUMENT_INVALID", "Chunk rows must be an integer from 1 through 10000.");
  }
  return value;
}

export async function createPostgresMigrationPlan(input: {
  snapshotManifestPath: string;
  expectedSnapshotManifestSha256: string;
  outputPlanPath: string;
  chunkRows: number;
}): Promise<{
  plan: PostgresMigrationPlan;
  planPath: string;
  planSha256: string;
}> {
  assertContractInventory();
  const manifestPath = assertCanonicalAbsolutePath(input.snapshotManifestPath, "Snapshot manifest");
  const expectedManifestSha256 = assertSha256(input.expectedSnapshotManifestSha256, "Snapshot manifest hash");
  const outputPlanPath = assertNewCanonicalFile(input.outputPlanPath, "Migration plan");
  const chunkRows = normalizeChunkRows(input.chunkRows);
  const snapshotDirectory = path.dirname(manifestPath);
  assertSafeDirectory(snapshotDirectory, "Snapshot directory", 0o700);
  const manifestFile = await readStableRegularFile(manifestPath, "Snapshot manifest", {
    includeContents: true,
    maxBytes: 1024 * 1024,
    requiredMode: 0o600,
  });
  if (manifestFile.sha256 !== expectedManifestSha256 || !manifestFile.contents) {
    throw sourceError("ARTIFACT_INVALID", "Snapshot manifest hash does not match the expected digest.");
  }
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(manifestFile.contents.toString("utf8"));
  } catch {
    throw sourceError("ARTIFACT_INVALID", "Snapshot manifest is not valid JSON.");
  }
  const manifest = normalizeSnapshotManifest(parsedManifest);
  if (!manifestFile.contents.equals(serializeCanonicalPostgresMigrationJson(manifest))) {
    throw sourceError("ARTIFACT_INVALID", "Snapshot manifest is not in deterministic canonical form.");
  }
  const ledgerBefore = await readSnapshotLedgerAuthority(snapshotDirectory, manifest.deletionLedger);
  const databasePath = path.join(snapshotDirectory, manifest.database.file);
  const databaseBefore = await readStableRegularFile(databasePath, "Snapshot database", { requiredMode: 0o600 });
  if (databaseBefore.sha256 !== manifest.database.sha256 || databaseBefore.bytes !== manifest.database.bytes) {
    throw sourceError("ARTIFACT_INVALID", "Snapshot database does not match its manifest.");
  }

  const database = openValidatedReadOnlySqlite(databasePath);
  let tables: PostgresMigrationPlanTable[];
  try {
    const dataVersionBefore = Number(database.pragma("data_version", { simple: true }));
    const inspectionBefore = inspectAndValidateSqlite(database);
    const contractSha256 = sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT);
    const contractByTable = new Map<string, PostgresMigrationTableContract>(
      POSTGRES_MIGRATION_CONTRACT.tables.map((table) => [table.name, table]),
    );
    tables = POSTGRES_MIGRATION_CONTRACT.importOrder.map((tableName) => {
      const table = contractByTable.get(tableName);
      if (!table) throw sourceError("SOURCE_SCHEMA_MISMATCH", "Migration import order references an unknown table.");
      return scanMigrationTable(database, table, chunkRows, contractSha256);
    });
    const dataVersionAfter = Number(database.pragma("data_version", { simple: true }));
    const inspectionAfter = inspectAndValidateSqlite(database);
    if (
      dataVersionBefore !== dataVersionAfter
      || inspectionBefore.fingerprint !== inspectionAfter.fingerprint
    ) {
      throw sourceError("SOURCE_CHANGED", "Snapshot database changed during the planning scan.");
    }
  } finally {
    database.close();
  }
  const databaseAfter = await readStableRegularFile(databasePath, "Snapshot database", { requiredMode: 0o600 });
  const ledgerAfter = await readSnapshotLedgerAuthority(snapshotDirectory, manifest.deletionLedger);
  if (
    databaseAfter.sha256 !== databaseBefore.sha256
    || databaseAfter.bytes !== databaseBefore.bytes
    || !sameLedgerAuthority(ledgerBefore, ledgerAfter)
  ) {
    throw sourceError("SOURCE_CHANGED", "A sealed snapshot artifact changed during the planning scan.");
  }
  const totalRows = tables.reduce((total, table) => total + table.rowCount, 0);
  if (!Number.isSafeInteger(totalRows)) {
    throw sourceError("SOURCE_DATA_INVALID", "Snapshot exceeds the supported total row count.");
  }
  const plan: PostgresMigrationPlan = {
    kind: POSTGRES_MIGRATION_PLAN_KIND,
    version: POSTGRES_MIGRATION_PLAN_VERSION,
    candidateSha: manifest.candidateSha,
    contractSha256: manifest.contractSha256,
    snapshotManifestSha256: expectedManifestSha256,
    sourceDatabaseSha256: manifest.database.sha256,
    sourceSchemaVersion: manifest.schema.sourceVersion,
    sourceSchemaFingerprint: manifest.schema.fingerprint,
    chunkRows,
    tableCount: tables.length,
    columnCount: tables.reduce((total, table) => total + table.columnCount, 0),
    totalRows,
    importOrder: [...POSTGRES_MIGRATION_CONTRACT.importOrder],
    tables,
  };
  const planSha256 = await writeNewCanonicalJson(outputPlanPath, plan);
  return { plan, planPath: outputPlanPath, planSha256 };
}

export const postgresMigrationSourceInternals = {
  canonicalSourceValue,
  canonicalizePostgresMigrationJson,
  inspectEvidenceTree,
  normalizeExactDecimalToken,
  normalizeLocalTime,
  normalizeSnapshotManifest,
  normalizeUtcInstant,
};
