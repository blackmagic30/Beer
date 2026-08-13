import fs from "node:fs";
import path from "node:path";

import {
  fetchVerifiedAccountDeletionLedger,
  type AccountDeletionLedgerCheckpoint,
  type AccountDeletionLedgerConfig,
  type VerifiedAccountDeletionLedger,
} from "../lib/offsite-backup.js";
import { parseAccountDeletionTombstones, sha256Bytes } from "../lib/data-backup.js";
import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "./postgres-migration-schema.js";

export const POSTGRES_MIGRATION_LEDGER_AUTHORITY_KIND =
  "pint-path-postgres-migration-account-deletion-ledger-authority" as const;
export const POSTGRES_MIGRATION_LEDGER_AUTHORITY_VERSION = 1 as const;
export const POSTGRES_MIGRATION_LEDGER_AUTHORITY_MANIFEST_FILE = "authority-manifest.json" as const;
export const POSTGRES_MIGRATION_LEDGER_CURRENT_FILE = "account-deletion-tombstones.json" as const;
export const POSTGRES_MIGRATION_LEDGER_GENESIS_FILE = "account-deletion-ledger-genesis.json" as const;
export const POSTGRES_MIGRATION_LEDGER_CHECKPOINT_FILE = "account-deletion-ledger-checkpoint.json" as const;

interface LedgerAuthorityArtifact {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PostgresMigrationLedgerAuthorityManifest {
  readonly kind: typeof POSTGRES_MIGRATION_LEDGER_AUTHORITY_KIND;
  readonly version: typeof POSTGRES_MIGRATION_LEDGER_AUTHORITY_VERSION;
  readonly sourceOriginSha256: string;
  readonly destinationOriginSha256: string;
  readonly destinationBucketSha256: string;
  readonly current: LedgerAuthorityArtifact;
  readonly genesis: LedgerAuthorityArtifact;
  readonly checkpoint: LedgerAuthorityArtifact & {
    readonly immutableObjectCount: number;
    readonly immutableSetSha256: string;
    readonly tombstoneCount: number;
    readonly latestCompletedAt: string | null;
  };
}

export interface PostgresMigrationLedgerAuthorityBundle {
  readonly directory: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifest: PostgresMigrationLedgerAuthorityManifest;
  readonly currentPath: string;
  readonly genesisPath: string;
  readonly checkpointPath: string;
}

export interface ReadPostgresMigrationLedgerAuthorityBundle
  extends PostgresMigrationLedgerAuthorityBundle {
  readonly manifestBytes: Buffer;
  readonly currentBytes: Buffer;
  readonly genesisBytes: Buffer;
  readonly checkpointBytes: Buffer;
}

export class PostgresMigrationLedgerAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresMigrationLedgerAuthorityError";
  }
}

function authorityError(message: string): PostgresMigrationLedgerAuthorityError {
  return new PostgresMigrationLedgerAuthorityError(message);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedOrigin(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("unsafe");
    }
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    throw authorityError(`${label} must be a credential-free HTTPS project origin.`);
  }
}

function identitySha256(label: string, value: string): string {
  return sha256PostgresMigrationBytes(`${label}\0${value}`);
}

function assertCanonicalAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    throw authorityError(`${label} must be a canonical absolute path.`);
  }
  return value;
}

function assertSafeDirectory(directory: string, label: string, requiredMode?: number): fs.Stats {
  assertCanonicalAbsolutePath(directory, label);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw authorityError(`${label} must be an existing real directory.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw authorityError(`${label} must be an existing real directory.`);
  }
  if (fs.realpathSync(directory) !== directory) {
    throw authorityError(`${label} must not resolve through a symbolic link.`);
  }
  if (requiredMode !== undefined && (stat.mode & 0o777) !== requiredMode) {
    throw authorityError(`${label} must have mode ${requiredMode.toString(8)}.`);
  }
  return stat;
}

function assertNewOutputDirectory(directory: string): string {
  assertCanonicalAbsolutePath(directory, "Ledger authority output directory");
  if (fs.existsSync(directory)) {
    throw authorityError("Ledger authority output directory must not already exist.");
  }
  assertSafeDirectory(path.dirname(directory), "Ledger authority output parent");
  return directory;
}

function assertSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw authorityError(`${label} must be an exact lowercase SHA-256 digest.`);
  }
  return value;
}

function assertNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw authorityError(`${label} must be a safe nonnegative integer.`);
  }
  return value;
}

function assertNullableUtc(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    throw authorityError(`${label} must be null or a valid UTC instant.`);
  }
  const normalized = new Date(value).toISOString();
  if (normalized !== value) throw authorityError(`${label} must be a canonical UTC instant.`);
  return value;
}

function assertUtc(value: unknown, label: string): string {
  const normalized = assertNullableUtc(value, label);
  if (normalized === null) throw authorityError(`${label} must be a canonical UTC instant.`);
  return normalized;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareStrings);
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort(compareStrings))) {
    throw authorityError(`${label} has an unexpected shape.`);
  }
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw authorityError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function normalizeArtifact(
  value: unknown,
  expectedFile: string,
  label: string,
): LedgerAuthorityArtifact {
  const artifact = assertObject(value, label);
  assertExactKeys(artifact, ["bytes", "file", "sha256"], label);
  if (artifact.file !== expectedFile) {
    throw authorityError(`${label} filename is invalid.`);
  }
  return {
    file: expectedFile,
    bytes: assertNonnegativeInteger(artifact.bytes, `${label} bytes`),
    sha256: assertSha256(artifact.sha256, `${label} hash`),
  };
}

function normalizeAuthorityManifest(value: unknown): PostgresMigrationLedgerAuthorityManifest {
  const manifest = assertObject(value, "Ledger authority manifest");
  assertExactKeys(manifest, [
    "checkpoint",
    "current",
    "destinationBucketSha256",
    "destinationOriginSha256",
    "genesis",
    "kind",
    "sourceOriginSha256",
    "version",
  ], "Ledger authority manifest");
  if (
    manifest.kind !== POSTGRES_MIGRATION_LEDGER_AUTHORITY_KIND
    || manifest.version !== POSTGRES_MIGRATION_LEDGER_AUTHORITY_VERSION
  ) {
    throw authorityError("Ledger authority manifest kind or version is unsupported.");
  }
  const checkpointValue = assertObject(manifest.checkpoint, "Ledger authority checkpoint artifact");
  assertExactKeys(checkpointValue, [
    "bytes",
    "file",
    "immutableObjectCount",
    "immutableSetSha256",
    "latestCompletedAt",
    "sha256",
    "tombstoneCount",
  ], "Ledger authority checkpoint artifact");
  if (checkpointValue.file !== POSTGRES_MIGRATION_LEDGER_CHECKPOINT_FILE) {
    throw authorityError("Ledger authority checkpoint filename is invalid.");
  }
  return {
    kind: POSTGRES_MIGRATION_LEDGER_AUTHORITY_KIND,
    version: POSTGRES_MIGRATION_LEDGER_AUTHORITY_VERSION,
    sourceOriginSha256: assertSha256(manifest.sourceOriginSha256, "Source origin identity"),
    destinationOriginSha256: assertSha256(
      manifest.destinationOriginSha256,
      "Destination origin identity",
    ),
    destinationBucketSha256: assertSha256(
      manifest.destinationBucketSha256,
      "Destination bucket identity",
    ),
    current: normalizeArtifact(
      manifest.current,
      POSTGRES_MIGRATION_LEDGER_CURRENT_FILE,
      "Current ledger artifact",
    ),
    genesis: normalizeArtifact(
      manifest.genesis,
      POSTGRES_MIGRATION_LEDGER_GENESIS_FILE,
      "Ledger genesis artifact",
    ),
    checkpoint: {
      file: POSTGRES_MIGRATION_LEDGER_CHECKPOINT_FILE,
      bytes: assertNonnegativeInteger(checkpointValue.bytes, "Ledger checkpoint bytes"),
      sha256: assertSha256(checkpointValue.sha256, "Ledger checkpoint hash"),
      immutableObjectCount: assertNonnegativeInteger(
        checkpointValue.immutableObjectCount,
        "Immutable ledger object count",
      ),
      immutableSetSha256: assertSha256(
        checkpointValue.immutableSetSha256,
        "Immutable ledger set hash",
      ),
      tombstoneCount: assertNonnegativeInteger(
        checkpointValue.tombstoneCount,
        "Ledger tombstone count",
      ),
      latestCompletedAt: assertNullableUtc(
        checkpointValue.latestCompletedAt,
        "Ledger latestCompletedAt",
      ),
    },
  };
}

function parseGenesis(bytes: Buffer): void {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw authorityError("The ledger genesis document is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw authorityError("The ledger genesis document is invalid.");
  }
  const genesis = value as Record<string, unknown>;
  assertExactKeys(
    genesis,
    ["createdAt", "currentLedgerPath", "immutablePrefix", "kind", "version"],
    "Ledger genesis document",
  );
  if (
    genesis.version !== 1
    || genesis.kind !== "pint-path-account-deletion-ledger-genesis"
    || genesis.immutablePrefix !== "_control/account-deletion-ledger/v1"
    || genesis.currentLedgerPath !== "_control/account-deletion-tombstones.json"
    || assertUtc(genesis.createdAt, "Ledger genesis createdAt") !== genesis.createdAt
  ) {
    throw authorityError("The ledger genesis document is invalid.");
  }
}

function parseCheckpoint(bytes: Buffer): AccountDeletionLedgerCheckpoint {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw authorityError("The ledger checkpoint is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw authorityError("The ledger checkpoint is invalid.");
  }
  const checkpoint = value as Record<string, unknown>;
  assertExactKeys(checkpoint, [
    "currentLedgerPath",
    "currentLedgerSha256",
    "generatedAt",
    "genesisPath",
    "genesisSha256",
    "immutableObjectCount",
    "immutableSetSha256",
    "latestCompletedAt",
    "tombstoneCount",
    "version",
  ], "Ledger checkpoint");
  const generatedAt = assertNullableUtc(checkpoint.generatedAt, "Ledger checkpoint generatedAt");
  if (
    checkpoint.version !== 2
    || generatedAt === null
    || checkpoint.genesisPath !== "_control/account-deletion-ledger-genesis.json"
    || checkpoint.currentLedgerPath !== "_control/account-deletion-tombstones.json"
  ) {
    throw authorityError("The ledger checkpoint is invalid.");
  }
  return {
    version: 2,
    generatedAt,
    genesisPath: checkpoint.genesisPath,
    genesisSha256: assertSha256(checkpoint.genesisSha256, "Ledger genesis hash"),
    currentLedgerPath: checkpoint.currentLedgerPath,
    currentLedgerSha256: assertSha256(checkpoint.currentLedgerSha256, "Current ledger hash"),
    immutableObjectCount: assertNonnegativeInteger(
      checkpoint.immutableObjectCount,
      "Immutable ledger object count",
    ),
    immutableSetSha256: assertSha256(checkpoint.immutableSetSha256, "Immutable ledger set hash"),
    tombstoneCount: assertNonnegativeInteger(checkpoint.tombstoneCount, "Ledger tombstone count"),
    latestCompletedAt: assertNullableUtc(checkpoint.latestCompletedAt, "Ledger latestCompletedAt"),
  };
}

function validateVerifiedLedger(verified: VerifiedAccountDeletionLedger): AccountDeletionLedgerCheckpoint {
  const currentSha256 = sha256Bytes(verified.bytes);
  const genesisSha256 = sha256Bytes(verified.genesisBytes);
  const checkpointSha256 = sha256Bytes(verified.checkpointBytes);
  if (
    currentSha256 !== verified.sha256
    || genesisSha256 !== verified.genesisSha256
    || checkpointSha256 !== verified.checkpointSha256
  ) {
    throw authorityError("The verified ledger bytes do not match their supplied hashes.");
  }
  parseGenesis(verified.genesisBytes);
  const checkpoint = parseCheckpoint(verified.checkpointBytes);
  const current = parseAccountDeletionTombstones(verified.bytes);
  const expectedLatestCompletedAt = current.tombstones.reduce<string | null>(
    (latest, tombstone) => latest === null || Date.parse(tombstone.completedAt) > Date.parse(latest)
      ? tombstone.completedAt
      : latest,
    null,
  );
  if (
    checkpoint.currentLedgerSha256 !== currentSha256
    || checkpoint.genesisSha256 !== genesisSha256
    || checkpoint.generatedAt !== current.generatedAt
    || checkpoint.tombstoneCount !== current.tombstones.length
    || checkpoint.latestCompletedAt !== expectedLatestCompletedAt
    || JSON.stringify(current.tombstones) !== JSON.stringify(verified.tombstones)
  ) {
    throw authorityError("The verified ledger authority views are inconsistent.");
  }
  const suppliedCheckpoint = verified.checkpoint;
  if (
    suppliedCheckpoint.version !== checkpoint.version
    || suppliedCheckpoint.generatedAt !== checkpoint.generatedAt
    || suppliedCheckpoint.genesisPath !== checkpoint.genesisPath
    || suppliedCheckpoint.genesisSha256 !== checkpoint.genesisSha256
    || suppliedCheckpoint.currentLedgerPath !== checkpoint.currentLedgerPath
    || suppliedCheckpoint.currentLedgerSha256 !== checkpoint.currentLedgerSha256
    || suppliedCheckpoint.immutableObjectCount !== checkpoint.immutableObjectCount
    || suppliedCheckpoint.immutableSetSha256 !== checkpoint.immutableSetSha256
    || suppliedCheckpoint.tombstoneCount !== checkpoint.tombstoneCount
    || suppliedCheckpoint.latestCompletedAt !== checkpoint.latestCompletedAt
  ) {
    throw authorityError("The supplied ledger checkpoint differs from its verified bytes.");
  }
  return checkpoint;
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeNewPrivateFile(filePath: string, bytes: Buffer): Promise<void> {
  const handle = await fs.promises.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    throw authorityError("A ledger authority artifact was not created as a private single-link file.");
  }
}

function sameBigIntFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readStablePrivateFile(
  filePath: string,
  label: string,
  maxBytes: number,
): Promise<Buffer> {
  assertCanonicalAbsolutePath(filePath, label);
  let pathStat: fs.BigIntStats;
  try {
    pathStat = fs.lstatSync(filePath, { bigint: true });
  } catch {
    throw authorityError(`${label} must be an existing private file.`);
  }
  if (
    !pathStat.isFile()
    || pathStat.isSymbolicLink()
    || pathStat.nlink !== 1n
    || Number(pathStat.mode & 0o777n) !== 0o600
    || pathStat.size > BigInt(maxBytes)
  ) {
    throw authorityError(`${label} must be a bounded mode-600 single-link regular file.`);
  }
  if (fs.realpathSync(filePath) !== filePath) {
    throw authorityError(`${label} must not resolve through a symbolic link.`);
  }
  // The O_NOFOLLOW descriptor is bound to the pre-open lstat by full file
  // identity and is revalidated after the descriptor-only read.
  // codeql[js/file-system-race]
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameBigIntFileIdentity(pathStat, before)) {
      throw authorityError(`${label} changed while it was opened.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameBigIntFileIdentity(before, after) || BigInt(bytes.length) !== before.size) {
      throw authorityError(`${label} changed while it was read.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readPostgresMigrationLedgerAuthority(
  manifestPathInput: string,
): Promise<ReadPostgresMigrationLedgerAuthorityBundle> {
  const manifestPath = assertCanonicalAbsolutePath(
    manifestPathInput,
    "Ledger authority manifest",
  );
  if (path.basename(manifestPath) !== POSTGRES_MIGRATION_LEDGER_AUTHORITY_MANIFEST_FILE) {
    throw authorityError("Ledger authority manifest filename is invalid.");
  }
  const directory = path.dirname(manifestPath);
  assertSafeDirectory(directory, "Ledger authority directory", 0o700);
  const expectedFiles = [
    POSTGRES_MIGRATION_LEDGER_AUTHORITY_MANIFEST_FILE,
    POSTGRES_MIGRATION_LEDGER_CHECKPOINT_FILE,
    POSTGRES_MIGRATION_LEDGER_CURRENT_FILE,
    POSTGRES_MIGRATION_LEDGER_GENESIS_FILE,
  ].sort(compareStrings);
  const actualFiles = fs.readdirSync(directory).sort(compareStrings);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw authorityError("Ledger authority directory must contain exactly the four reviewed artifacts.");
  }
  const manifestBytes = await readStablePrivateFile(manifestPath, "Ledger authority manifest", 1024 * 1024);
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw authorityError("Ledger authority manifest is not valid JSON.");
  }
  const manifest = normalizeAuthorityManifest(manifestValue);
  if (!serializeCanonicalPostgresMigrationJson(manifest).equals(manifestBytes)) {
    throw authorityError("Ledger authority manifest is not canonical.");
  }
  const currentPath = path.join(directory, manifest.current.file);
  const genesisPath = path.join(directory, manifest.genesis.file);
  const checkpointPath = path.join(directory, manifest.checkpoint.file);
  const [currentBytes, genesisBytes, checkpointBytes] = await Promise.all([
    readStablePrivateFile(currentPath, "Current deletion ledger", 64 * 1024 * 1024),
    readStablePrivateFile(genesisPath, "Deletion ledger genesis", 1024 * 1024),
    readStablePrivateFile(checkpointPath, "Deletion ledger checkpoint", 1024 * 1024),
  ]);
  const actual = [
    [manifest.current, currentBytes],
    [manifest.genesis, genesisBytes],
    [manifest.checkpoint, checkpointBytes],
  ] as const;
  for (const [artifact, bytes] of actual) {
    if (artifact.bytes !== bytes.length || artifact.sha256 !== sha256Bytes(bytes)) {
      throw authorityError("A ledger authority artifact differs from its manifest binding.");
    }
  }
  const current = parseAccountDeletionTombstones(currentBytes);
  const checkpoint = parseCheckpoint(checkpointBytes);
  validateVerifiedLedger({
    bytes: currentBytes,
    sha256: manifest.current.sha256,
    genesisBytes,
    genesisSha256: manifest.genesis.sha256,
    checkpointBytes,
    checkpointSha256: manifest.checkpoint.sha256,
    tombstones: current.tombstones,
    checkpoint,
  });
  if (
    manifest.checkpoint.immutableObjectCount !== checkpoint.immutableObjectCount
    || manifest.checkpoint.immutableSetSha256 !== checkpoint.immutableSetSha256
    || manifest.checkpoint.tombstoneCount !== checkpoint.tombstoneCount
    || manifest.checkpoint.latestCompletedAt !== checkpoint.latestCompletedAt
  ) {
    throw authorityError("Ledger authority manifest checkpoint summary is inconsistent.");
  }
  return {
    directory,
    manifestPath,
    manifestSha256: sha256PostgresMigrationBytes(manifestBytes),
    manifest,
    currentPath,
    genesisPath,
    checkpointPath,
    manifestBytes,
    currentBytes,
    genesisBytes,
    checkpointBytes,
  };
}

export async function writePostgresMigrationLedgerAuthority(input: {
  readonly sourceSupabaseUrl: string;
  readonly destinationSupabaseUrl: string;
  readonly bucketName: string;
  readonly outputDirectory: string;
  readonly verified: VerifiedAccountDeletionLedger;
}): Promise<PostgresMigrationLedgerAuthorityBundle> {
  const outputDirectory = assertNewOutputDirectory(input.outputDirectory);
  const sourceOrigin = normalizedOrigin(input.sourceSupabaseUrl, "Source Supabase URL");
  const destinationOrigin = normalizedOrigin(input.destinationSupabaseUrl, "Destination Supabase URL");
  if (sourceOrigin === destinationOrigin) {
    throw authorityError("Ledger authority destination must be independent from the source Supabase project.");
  }
  const bucketName = input.bucketName.trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/.test(bucketName)) {
    throw authorityError("Ledger authority bucket name is invalid.");
  }
  const checkpoint = validateVerifiedLedger(input.verified);
  const currentPath = path.join(outputDirectory, POSTGRES_MIGRATION_LEDGER_CURRENT_FILE);
  const genesisPath = path.join(outputDirectory, POSTGRES_MIGRATION_LEDGER_GENESIS_FILE);
  const checkpointPath = path.join(outputDirectory, POSTGRES_MIGRATION_LEDGER_CHECKPOINT_FILE);
  const manifestPath = path.join(outputDirectory, POSTGRES_MIGRATION_LEDGER_AUTHORITY_MANIFEST_FILE);
  let outputCreated = false;
  try {
    await fs.promises.mkdir(outputDirectory, { mode: 0o700 });
    outputCreated = true;
    await fs.promises.chmod(outputDirectory, 0o700);
    assertSafeDirectory(outputDirectory, "Ledger authority output directory", 0o700);
    await fsyncDirectory(path.dirname(outputDirectory));
    await writeNewPrivateFile(currentPath, input.verified.bytes);
    await writeNewPrivateFile(genesisPath, input.verified.genesisBytes);
    await writeNewPrivateFile(checkpointPath, input.verified.checkpointBytes);
    const manifest: PostgresMigrationLedgerAuthorityManifest = {
      kind: POSTGRES_MIGRATION_LEDGER_AUTHORITY_KIND,
      version: POSTGRES_MIGRATION_LEDGER_AUTHORITY_VERSION,
      sourceOriginSha256: identitySha256("source-origin", sourceOrigin),
      destinationOriginSha256: identitySha256("destination-origin", destinationOrigin),
      destinationBucketSha256: identitySha256("destination-bucket", `${destinationOrigin}/${bucketName}`),
      current: {
        file: POSTGRES_MIGRATION_LEDGER_CURRENT_FILE,
        bytes: input.verified.bytes.length,
        sha256: input.verified.sha256,
      },
      genesis: {
        file: POSTGRES_MIGRATION_LEDGER_GENESIS_FILE,
        bytes: input.verified.genesisBytes.length,
        sha256: input.verified.genesisSha256,
      },
      checkpoint: {
        file: POSTGRES_MIGRATION_LEDGER_CHECKPOINT_FILE,
        bytes: input.verified.checkpointBytes.length,
        sha256: input.verified.checkpointSha256,
        immutableObjectCount: checkpoint.immutableObjectCount,
        immutableSetSha256: checkpoint.immutableSetSha256,
        tombstoneCount: checkpoint.tombstoneCount,
        latestCompletedAt: checkpoint.latestCompletedAt,
      },
    };
    const manifestBytes = serializeCanonicalPostgresMigrationJson(manifest);
    await writeNewPrivateFile(manifestPath, manifestBytes);
    await fsyncDirectory(outputDirectory);
    return {
      directory: outputDirectory,
      manifestPath,
      manifestSha256: sha256PostgresMigrationBytes(manifestBytes),
      manifest,
      currentPath,
      genesisPath,
      checkpointPath,
    };
  } catch (error) {
    if (outputCreated) await fs.promises.rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function exportPostgresMigrationLedgerAuthority(input: {
  readonly sourceSupabaseUrl: string;
  readonly destinationSupabaseUrl: string;
  readonly destinationServiceRoleKey: string;
  readonly bucketName: string;
  readonly outputDirectory: string;
  readonly requestTimeoutMs?: number;
  readonly fetchLedger?: (
    config: AccountDeletionLedgerConfig,
  ) => Promise<VerifiedAccountDeletionLedger>;
}): Promise<PostgresMigrationLedgerAuthorityBundle> {
  const verified = await (input.fetchLedger ?? fetchVerifiedAccountDeletionLedger)({
    sourceSupabaseUrl: input.sourceSupabaseUrl,
    destinationSupabaseUrl: input.destinationSupabaseUrl,
    destinationServiceRoleKey: input.destinationServiceRoleKey,
    bucketName: input.bucketName,
    requestTimeoutMs: input.requestTimeoutMs,
  });
  return writePostgresMigrationLedgerAuthority({
    sourceSupabaseUrl: input.sourceSupabaseUrl,
    destinationSupabaseUrl: input.destinationSupabaseUrl,
    bucketName: input.bucketName,
    outputDirectory: input.outputDirectory,
    verified,
  });
}
