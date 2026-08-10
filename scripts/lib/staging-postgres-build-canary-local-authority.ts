import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK } from
  "./staging-postgres-build-canary-executor.js";

export const STAGING_POSTGRES_BUILD_CANARY_SOURCE_MANIFEST_ALGORITHM =
  "sha256-json-depth-first-bytewise-siblings-path-type-mode-size-content-v1" as const;

export const STAGING_POSTGRES_BUILD_CANARY_LOCAL_AUTHORITY_TRUST_BOUNDARY =
  "hostile-current-uid-and-privileged-actors-excluded" as const;

export const STAGING_POSTGRES_BUILD_CANARY_LOCAL_AUTHORITY_ACTIVATION_BLOCKER =
  "acl-free-source-and-ancestor-authority-required" as const;

export type StagingPostgresBuildCanaryLocalAuthorityFailureCode =
  | "local_authority_invalid"
  | "cleanup_failed";

export class StagingPostgresBuildCanaryLocalAuthorityError extends Error {
  readonly code: StagingPostgresBuildCanaryLocalAuthorityFailureCode;

  constructor(code: StagingPostgresBuildCanaryLocalAuthorityFailureCode) {
    super(code);
    this.name = "StagingPostgresBuildCanaryLocalAuthorityError";
    this.code = code;
  }
}

export interface StagingPostgresBuildCanaryStructuralAuthority {
  readonly nodeVersion: string;
  readonly trustBoundary:
    typeof STAGING_POSTGRES_BUILD_CANARY_LOCAL_AUTHORITY_TRUST_BOUNDARY;
  readonly activationBlocker:
    typeof STAGING_POSTGRES_BUILD_CANARY_LOCAL_AUTHORITY_ACTIVATION_BLOCKER;
  readonly sourceDirectoryAbsolute: true;
  readonly sourceDirectoryCanonical: true;
  readonly sourceDirectChildOfPrivateTmp: true;
  readonly sourceRootCurrentUid: true;
  readonly sourceRootMode0700: true;
  readonly sourceRootNonSymlink: true;
  readonly sourceRootSameDeviceAsPrivateTmp: true;
  readonly privateTmpRootOwnedSticky01777: true;
  readonly privateAncestorsRootOwnedNonWritable: true;
  readonly sourceRootIdentityHeldWithinTrustedCurrentUidBoundary: true;
  readonly sourceRootIdentityReassertedWithinTrustedCurrentUidBoundary: true;
  readonly sourcePathObservationWithinTrustedCurrentUidBoundary: true;
  readonly sourceTreeSnapshotAtomic: false;
  readonly sourceAclAuthorityInspected: false;
  readonly sourceManifestSha256: string;
  readonly sourceManifestAlgorithm:
    typeof STAGING_POSTGRES_BUILD_CANARY_SOURCE_MANIFEST_ALGORITHM;
  readonly sourceEntryCount: number;
  readonly sourceDirectoryCount: number;
  readonly sourceFileCount: number;
  readonly sourceFileBytes: number;
  readonly railwayVersion: string;
  readonly railwayVersionProvenance: "reviewed-binary-sha256-lock";
  readonly railwayBinary: string;
  readonly railwayBinarySha256: string;
  readonly railwayBinaryBytesObservedAtInspection: true;
  readonly railwayBinaryPathReassertedAtInspection: true;
  readonly railwayBinaryMode0555AtInspection: true;
  readonly railwayBinaryAclAuthorityInspected: false;
  readonly railwayBinaryExecuted: false;
}

export interface StagingPostgresBuildCanaryLocalAuthorityHandle {
  /** Calls are serial-only. A concurrent close fails rather than cancelling inspect. */
  inspect(signal?: AbortSignal): Promise<StagingPostgresBuildCanaryStructuralAuthority>;
  close(): Promise<void>;
}

type FileHandle = fs.promises.FileHandle;
type DirectoryHandle = fs.Dir;

type ManifestEntry =
  | readonly [string, "d", number, 0, null]
  | readonly [string, "f", number, number, string];

interface StableIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface AnchorIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
}

interface SourceCounters {
  entries: number;
  directories: number;
  files: number;
  bytes: number;
}

interface CapturedFailure {
  readonly caught: true;
  readonly error: unknown;
}

interface NoFailure {
  readonly caught: false;
}

type FailureState = CapturedFailure | NoFailure;

const NO_FAILURE: NoFailure = Object.freeze({ caught: false });

const PRIVATE_TMP = "/private/tmp";
const ROOT_ANCESTORS = Object.freeze(["/", "/private"] as const);

const LIMITS = Object.freeze({
  maxRootPathBytes: 4_096,
  maxRelativePathBytes: 4_096,
  maxNameBytes: 255,
  maxDepth: 64,
  maxEntries: 4_096,
  maxFileBytes: 32 * 1_024 * 1_024,
  maxTotalFileBytes: 64 * 1_024 * 1_024,
  maxBinaryBytes: 32 * 1_024 * 1_024,
  readChunkBytes: 64 * 1_024,
});

function invalid(): StagingPostgresBuildCanaryLocalAuthorityError {
  return new StagingPostgresBuildCanaryLocalAuthorityError(
    "local_authority_invalid",
  );
}

function cleanupFailed(): StagingPostgresBuildCanaryLocalAuthorityError {
  return new StagingPostgresBuildCanaryLocalAuthorityError("cleanup_failed");
}

function capture(error: unknown): CapturedFailure {
  return { caught: true, error };
}

function normalizeFailure(error: unknown): never {
  if (error instanceof StagingPostgresBuildCanaryLocalAuthorityError) {
    throw error;
  }
  throw invalid();
}

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw invalid();
}

function assertRequiredOpenFlags(): void {
  if (
    !Number.isInteger(fs.constants.O_NOFOLLOW)
    || fs.constants.O_NOFOLLOW <= 0
    || !Number.isInteger(fs.constants.O_DIRECTORY)
    || fs.constants.O_DIRECTORY <= 0
  ) throw invalid();
}

function exactAbsolutePath(value: string): string {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || path.resolve(value) !== value
    || value === path.parse(value).root
    || value.includes("\0")
    || /[\r\n]/.test(value)
    || Buffer.byteLength(value, "utf8") > LIMITS.maxRootPathBytes
  ) throw invalid();
  return value;
}

function assertDirectPrivateTmpChild(value: string): void {
  if (
    path.dirname(value) !== PRIVATE_TMP
    || path.basename(value).length === 0
    || path.basename(value) === "."
    || path.basename(value) === ".."
  ) throw invalid();
}

function safeUid(value: number): bigint {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid();
  return BigInt(value);
}

function currentUid(): bigint {
  if (typeof process.geteuid !== "function") throw invalid();
  return safeUid(process.geteuid());
}

function stableIdentity(stat: fs.BigIntStats): StableIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function anchorIdentity(stat: fs.BigIntStats): AnchorIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
  };
}

function sameStableIdentity(left: StableIdentity, right: StableIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameAnchorIdentity(left: AnchorIdentity, right: AnchorIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

function assertRootOwnedAncestor(stat: fs.BigIntStats): void {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== 0n
    || stat.nlink < 1n
    || (stat.mode & 0o022n) !== 0n
  ) throw invalid();
}

function assertPrivateTmp(stat: fs.BigIntStats): void {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== 0n
    || stat.nlink < 1n
    || (stat.mode & 0o7777n) !== 0o1777n
  ) throw invalid();
}

function assertSourceDirectory(stat: fs.BigIntStats, uid: bigint): void {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== uid
    || stat.nlink < 1n
    || (stat.mode & 0o7777n) !== 0o700n
  ) throw invalid();
}

function assertSourceFile(stat: fs.BigIntStats, uid: bigint): void {
  const mode = stat.mode & 0o7777n;
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== uid
    || stat.nlink !== 1n
    || (mode !== 0o600n && mode !== 0o700n)
  ) throw invalid();
}

function assertBinary(stat: fs.BigIntStats): void {
  const mode = stat.mode & 0o7777n;
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1n
    || stat.size <= 0n
    || stat.size > BigInt(LIMITS.maxBinaryBytes)
    || mode !== 0o555n
  ) throw invalid();
}

function exactSize(value: bigint, maximum: number): number {
  if (
    value < 0n
    || value > BigInt(maximum)
    || value > BigInt(Number.MAX_SAFE_INTEGER)
  ) throw invalid();
  return Number(value);
}

function decodeName(bytes: Buffer): string {
  if (
    !Buffer.isBuffer(bytes)
    || bytes.length === 0
    || bytes.length > LIMITS.maxNameBytes
    || bytes.includes(0)
    || bytes.includes(0x2f)
  ) throw invalid();
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid();
  }
  if (
    Buffer.compare(Buffer.from(name, "utf8"), bytes) !== 0
    || name === "."
    || name === ".."
    || path.basename(name) !== name
    || name.includes("\\")
    || /[\r\n]/.test(name)
  ) throw invalid();
  return name;
}

async function lstatBigInt(filename: string): Promise<fs.BigIntStats> {
  return await fs.promises.lstat(filename, { bigint: true });
}

async function openDirectory(filename: string): Promise<FileHandle> {
  return await fs.promises.open(
    filename,
    fs.constants.O_RDONLY
      | fs.constants.O_DIRECTORY
      | fs.constants.O_NOFOLLOW,
  );
}

async function stablePathAndDescriptor(
  filename: string,
  handle: FileHandle,
  before: fs.BigIntStats,
): Promise<fs.BigIntStats> {
  const descriptor = await handle.stat({ bigint: true });
  const after = await lstatBigInt(filename);
  if (
    !sameStableIdentity(stableIdentity(before), stableIdentity(descriptor))
    || !sameStableIdentity(stableIdentity(descriptor), stableIdentity(after))
  ) throw invalid();
  return descriptor;
}

async function stableAnchorPathAndDescriptor(
  filename: string,
  handle: FileHandle,
  before: fs.BigIntStats,
  validator: (stat: fs.BigIntStats) => void,
): Promise<void> {
  const descriptor = await handle.stat({ bigint: true });
  const after = await lstatBigInt(filename);
  validator(descriptor);
  validator(after);
  if (
    !sameAnchorIdentity(anchorIdentity(before), anchorIdentity(descriptor))
    || !sameAnchorIdentity(anchorIdentity(descriptor), anchorIdentity(after))
    || await fs.promises.realpath(filename) !== filename
  ) throw invalid();
}

async function readAndHash(
  handle: FileHandle,
  expectedSize: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(
    Math.min(LIMITS.readChunkBytes, Math.max(expectedSize, 1)),
  );
  let offset = 0;
  while (offset < expectedSize) {
    checkSignal(signal);
    const wanted = Math.min(buffer.length, expectedSize - offset);
    const result = await handle.read(buffer, 0, wanted, offset);
    if (result.bytesRead <= 0 || result.bytesRead > wanted) throw invalid();
    hash.update(buffer.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  const overflow = Buffer.allocUnsafe(1);
  const extra = await handle.read(overflow, 0, 1, expectedSize);
  if (extra.bytesRead !== 0) throw invalid();
  return hash.digest("hex");
}

function addEntry(
  entries: ManifestEntry[],
  counters: SourceCounters,
  entry: ManifestEntry,
): void {
  counters.entries += 1;
  if (counters.entries > LIMITS.maxEntries) throw invalid();
  entries.push(entry);
}

async function closeDirectoryHandle(
  directory: DirectoryHandle,
  ownedDirectories: Set<DirectoryHandle>,
  prior: FailureState,
): Promise<void> {
  let closeFailed = false;
  try {
    await directory.close();
    ownedDirectories.delete(directory);
  } catch {
    closeFailed = true;
  }
  if (closeFailed) throw cleanupFailed();
  if (prior.caught) normalizeFailure(prior.error);
}

async function readBoundedDirectoryNames(
  absoluteDirectory: string,
  maximum: number,
  ownedDirectories: Set<DirectoryHandle>,
  signal: AbortSignal | undefined,
): Promise<Buffer[]> {
  let directory: DirectoryHandle;
  try {
    directory = await fs.promises.opendir(absoluteDirectory, {
      encoding: "buffer" as BufferEncoding,
    });
  } catch (error) {
    normalizeFailure(error);
  }
  ownedDirectories.add(directory!);
  const names: Buffer[] = [];
  let prior: FailureState = NO_FAILURE;
  try {
    for (;;) {
      checkSignal(signal);
      const entry = await directory!.read();
      if (entry === null) break;
      const rawName = entry.name;
      if (!Buffer.isBuffer(rawName)) throw invalid();
      names.push(Buffer.from(rawName));
      if (names.length > maximum) throw invalid();
    }
  } catch (error) {
    prior = capture(error);
  }
  await closeDirectoryHandle(directory!, ownedDirectories, prior);
  names.sort((left, right) => Buffer.compare(left, right));
  for (let index = 1; index < names.length; index += 1) {
    if (Buffer.compare(names[index - 1]!, names[index]!) === 0) throw invalid();
  }
  return names;
}

async function closeFileWithPrecedence(
  handle: FileHandle,
  ownedHandles: Set<FileHandle>,
  prior: FailureState,
): Promise<void> {
  let closeFailed = false;
  try {
    await handle.close();
    ownedHandles.delete(handle);
  } catch {
    closeFailed = true;
  }
  if (closeFailed) throw cleanupFailed();
  if (prior.caught) normalizeFailure(prior.error);
}

async function walkSourceDirectory(input: {
  readonly uid: bigint;
  readonly absoluteDirectory: string;
  readonly relativeDirectory: string;
  readonly directoryHandle: FileHandle;
  readonly directoryBefore: fs.BigIntStats;
  readonly depth: number;
  readonly entries: ManifestEntry[];
  readonly counters: SourceCounters;
  readonly ownedHandles: Set<FileHandle>;
  readonly ownedDirectories: Set<DirectoryHandle>;
  readonly signal: AbortSignal | undefined;
}): Promise<void> {
  checkSignal(input.signal);
  if (input.depth > LIMITS.maxDepth) throw invalid();
  assertSourceDirectory(input.directoryBefore, input.uid);
  await stablePathAndDescriptor(
    input.absoluteDirectory,
    input.directoryHandle,
    input.directoryBefore,
  );
  const names = await readBoundedDirectoryNames(
    input.absoluteDirectory,
    LIMITS.maxEntries - input.counters.entries,
    input.ownedDirectories,
    input.signal,
  );
  for (const rawName of names) {
    checkSignal(input.signal);
    const name = decodeName(rawName);
    const relative = input.relativeDirectory.length === 0
      ? name
      : `${input.relativeDirectory}/${name}`;
    if (Buffer.byteLength(relative, "utf8") > LIMITS.maxRelativePathBytes) {
      throw invalid();
    }
    const absolute = path.join(input.absoluteDirectory, name);
    const before = await lstatBigInt(absolute);
    if (before.isSymbolicLink()) throw invalid();
    if (before.isDirectory()) {
      assertSourceDirectory(before, input.uid);
      const handle = await openDirectory(absolute);
      input.ownedHandles.add(handle);
      let prior: FailureState = NO_FAILURE;
      try {
        await stablePathAndDescriptor(absolute, handle, before);
        input.counters.directories += 1;
        addEntry(
          input.entries,
          input.counters,
          [relative, "d", Number(before.mode & 0o7777n), 0, null],
        );
        await walkSourceDirectory({
          ...input,
          absoluteDirectory: absolute,
          relativeDirectory: relative,
          directoryHandle: handle,
          directoryBefore: before,
          depth: input.depth + 1,
        });
        await stablePathAndDescriptor(absolute, handle, before);
      } catch (error) {
        prior = capture(error);
      }
      await closeFileWithPrecedence(handle, input.ownedHandles, prior);
      continue;
    }
    if (!before.isFile()) throw invalid();
    assertSourceFile(before, input.uid);
    const size = exactSize(before.size, LIMITS.maxFileBytes);
    if (input.counters.bytes + size > LIMITS.maxTotalFileBytes) throw invalid();
    const handle = await fs.promises.open(
      absolute,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    input.ownedHandles.add(handle);
    let prior: FailureState = NO_FAILURE;
    try {
      await stablePathAndDescriptor(absolute, handle, before);
      const digest = await readAndHash(handle, size, input.signal);
      await stablePathAndDescriptor(absolute, handle, before);
      input.counters.files += 1;
      input.counters.bytes += size;
      addEntry(
        input.entries,
        input.counters,
        [relative, "f", Number(before.mode & 0o7777n), size, digest],
      );
    } catch (error) {
      prior = capture(error);
    }
    await closeFileWithPrecedence(handle, input.ownedHandles, prior);
  }
  await stablePathAndDescriptor(
    input.absoluteDirectory,
    input.directoryHandle,
    input.directoryBefore,
  );
}

async function inspectBinary(
  ownedHandles: Set<FileHandle>,
  signal: AbortSignal | undefined,
): Promise<string> {
  checkSignal(signal);
  const binary = exactAbsolutePath(
    STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK.railwayBinary,
  );
  const expectedSha256 =
    STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK.railwayBinarySha256;
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw invalid();
  const before = await lstatBigInt(binary);
  if (await fs.promises.realpath(binary) !== binary) throw invalid();
  assertBinary(before);
  const size = exactSize(before.size, LIMITS.maxBinaryBytes);
  const handle = await fs.promises.open(
    binary,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  ownedHandles.add(handle);
  let digest: string | undefined;
  let prior: FailureState = NO_FAILURE;
  try {
    await stablePathAndDescriptor(binary, handle, before);
    digest = await readAndHash(handle, size, signal);
    if (digest !== expectedSha256) throw invalid();
    await stablePathAndDescriptor(binary, handle, before);
    if (await fs.promises.realpath(binary) !== binary) throw invalid();
  } catch (error) {
    prior = capture(error);
  }
  await closeFileWithPrecedence(handle, ownedHandles, prior);
  if (digest === undefined) throw invalid();
  return digest;
}

async function closeOutstandingHandles(
  ownedHandles: Set<FileHandle>,
): Promise<boolean> {
  let failed = false;
  const handles = [...ownedHandles].reverse();
  for (const handle of handles) {
    try {
      await handle.close();
      ownedHandles.delete(handle);
    } catch {
      failed = true;
    }
  }
  return !failed && ownedHandles.size === 0;
}

async function closeOutstandingDirectories(
  ownedDirectories: Set<DirectoryHandle>,
): Promise<boolean> {
  let failed = false;
  for (const directory of [...ownedDirectories]) {
    try {
      await directory.close();
      ownedDirectories.delete(directory);
    } catch {
      failed = true;
    }
  }
  return !failed && ownedDirectories.size === 0;
}

/**
 * This primitive observes source and binary bytes without invoking Railway.
 * Its path guarantees deliberately exclude hostile processes running as the
 * current uid and privileged actors. Node does not expose macOS ACL inspection;
 * ACL-free authority remains a mandatory activation blocker for a later adapter.
 */
export async function openStagingPostgresBuildCanaryLocalAuthority(
  sourceRootInput: string,
): Promise<StagingPostgresBuildCanaryLocalAuthorityHandle> {
  if (process.platform !== "darwin") throw invalid();
  assertRequiredOpenFlags();
  const sourceRoot = exactAbsolutePath(sourceRootInput);
  assertDirectPrivateTmpChild(sourceRoot);
  const uid = currentUid();
  const ownedHandles = new Set<FileHandle>();
  const ownedDirectories = new Set<DirectoryHandle>();
  const anchorHandles = new Map<string, FileHandle>();
  const anchorStats = new Map<string, fs.BigIntStats>();
  let sourceHandle: FileHandle | undefined;
  let sourceBefore: fs.BigIntStats | undefined;
  let initialFailure: FailureState = NO_FAILURE;

  try {
    for (const ancestor of ROOT_ANCESTORS) {
      const before = await lstatBigInt(ancestor);
      if (await fs.promises.realpath(ancestor) !== ancestor) throw invalid();
      assertRootOwnedAncestor(before);
      const handle = await openDirectory(ancestor);
      ownedHandles.add(handle);
      anchorHandles.set(ancestor, handle);
      anchorStats.set(ancestor, before);
      await stableAnchorPathAndDescriptor(
        ancestor,
        handle,
        before,
        assertRootOwnedAncestor,
      );
    }
    const privateTmpBefore = await lstatBigInt(PRIVATE_TMP);
    if (await fs.promises.realpath(PRIVATE_TMP) !== PRIVATE_TMP) throw invalid();
    assertPrivateTmp(privateTmpBefore);
    const privateTmpHandle = await openDirectory(PRIVATE_TMP);
    ownedHandles.add(privateTmpHandle);
    anchorHandles.set(PRIVATE_TMP, privateTmpHandle);
    anchorStats.set(PRIVATE_TMP, privateTmpBefore);
    await stableAnchorPathAndDescriptor(
      PRIVATE_TMP,
      privateTmpHandle,
      privateTmpBefore,
      assertPrivateTmp,
    );

    sourceBefore = await lstatBigInt(sourceRoot);
    if (await fs.promises.realpath(sourceRoot) !== sourceRoot) throw invalid();
    assertSourceDirectory(sourceBefore, uid);
    if (sourceBefore.dev !== privateTmpBefore.dev) throw invalid();
    sourceHandle = await openDirectory(sourceRoot);
    ownedHandles.add(sourceHandle);
    await stablePathAndDescriptor(sourceRoot, sourceHandle, sourceBefore);
  } catch (error) {
    initialFailure = capture(error);
  }

  if (initialFailure.caught) {
    const directoriesExact = await closeOutstandingDirectories(ownedDirectories);
    const handlesExact = await closeOutstandingHandles(ownedHandles);
    const cleanupExact = directoriesExact && handlesExact;
    if (!cleanupExact) throw cleanupFailed();
    normalizeFailure(initialFailure.error);
  }
  if (sourceHandle === undefined || sourceBefore === undefined) throw invalid();

  let state: "open" | "inspecting" | "closing" | "closed" | "failed" = "open";

  const reassertAnchors = async (): Promise<void> => {
    for (const ancestor of [...ROOT_ANCESTORS, PRIVATE_TMP]) {
      const handle = anchorHandles.get(ancestor);
      const before = anchorStats.get(ancestor);
      if (handle === undefined || before === undefined) throw invalid();
      await stableAnchorPathAndDescriptor(
        ancestor,
        handle,
        before,
        ancestor === PRIVATE_TMP ? assertPrivateTmp : assertRootOwnedAncestor,
      );
    }
  };

  const reassertSource = async (): Promise<void> => {
    assertDirectPrivateTmpChild(sourceRoot);
    await stablePathAndDescriptor(sourceRoot, sourceHandle!, sourceBefore!);
    if (await fs.promises.realpath(sourceRoot) !== sourceRoot) throw invalid();
  };

  return {
    async inspect(signal) {
      if (state !== "open") throw invalid();
      state = "inspecting";
      try {
        checkSignal(signal);
        const nodeVersion = process.version;
        if (
          nodeVersion
          !== STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK.expectedNodeVersion
        ) throw invalid();
        await reassertAnchors();
        await reassertSource();
        const entries: ManifestEntry[] = [];
        const counters: SourceCounters = {
          entries: 0,
          directories: 0,
          files: 0,
          bytes: 0,
        };
        await walkSourceDirectory({
          uid,
          absoluteDirectory: sourceRoot,
          relativeDirectory: "",
          directoryHandle: sourceHandle!,
          directoryBefore: sourceBefore!,
          depth: 0,
          entries,
          counters,
          ownedHandles,
          ownedDirectories,
          signal,
        });
        await reassertSource();
        await reassertAnchors();
        const sourceManifestSha256 = crypto.createHash("sha256")
          .update(JSON.stringify(entries), "utf8")
          .digest("hex");
        const railwayBinarySha256 = await inspectBinary(ownedHandles, signal);
        await reassertSource();
        await reassertAnchors();
        checkSignal(signal);
        return {
          nodeVersion,
          trustBoundary:
            STAGING_POSTGRES_BUILD_CANARY_LOCAL_AUTHORITY_TRUST_BOUNDARY,
          activationBlocker:
            STAGING_POSTGRES_BUILD_CANARY_LOCAL_AUTHORITY_ACTIVATION_BLOCKER,
          sourceDirectoryAbsolute: true,
          sourceDirectoryCanonical: true,
          sourceDirectChildOfPrivateTmp: true,
          sourceRootCurrentUid: true,
          sourceRootMode0700: true,
          sourceRootNonSymlink: true,
          sourceRootSameDeviceAsPrivateTmp: true,
          privateTmpRootOwnedSticky01777: true,
          privateAncestorsRootOwnedNonWritable: true,
          sourceRootIdentityHeldWithinTrustedCurrentUidBoundary: true,
          sourceRootIdentityReassertedWithinTrustedCurrentUidBoundary: true,
          sourcePathObservationWithinTrustedCurrentUidBoundary: true,
          sourceTreeSnapshotAtomic: false,
          sourceAclAuthorityInspected: false,
          sourceManifestSha256,
          sourceManifestAlgorithm:
            STAGING_POSTGRES_BUILD_CANARY_SOURCE_MANIFEST_ALGORITHM,
          sourceEntryCount: counters.entries,
          sourceDirectoryCount: counters.directories,
          sourceFileCount: counters.files,
          sourceFileBytes: counters.bytes,
          railwayVersion:
            STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK.railwayVersion,
          railwayVersionProvenance: "reviewed-binary-sha256-lock",
          railwayBinary:
            STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK.railwayBinary,
          railwayBinarySha256,
          railwayBinaryBytesObservedAtInspection: true,
          railwayBinaryPathReassertedAtInspection: true,
          railwayBinaryMode0555AtInspection: true,
          railwayBinaryAclAuthorityInspected: false,
          railwayBinaryExecuted: false,
        };
      } catch (error) {
        if (
          error instanceof StagingPostgresBuildCanaryLocalAuthorityError
          && error.code === "cleanup_failed"
        ) state = "failed";
        normalizeFailure(error);
      } finally {
        if (state === "inspecting") state = "open";
      }
    },
    async close() {
      if (state === "closed") return;
      if (state === "inspecting" || state === "closing") throw cleanupFailed();
      if (state === "failed") {
        await closeOutstandingDirectories(ownedDirectories);
        await closeOutstandingHandles(ownedHandles);
        throw cleanupFailed();
      }
      state = "closing";
      let reassertionExact = true;
      try {
        await reassertSource();
        await reassertAnchors();
      } catch {
        reassertionExact = false;
      }
      const directoriesExact = await closeOutstandingDirectories(ownedDirectories);
      const handlesExact = await closeOutstandingHandles(ownedHandles);
      const cleanupExact = directoriesExact && handlesExact;
      if (!reassertionExact || !cleanupExact) {
        state = "failed";
        throw cleanupFailed();
      }
      state = "closed";
    },
  };
}
