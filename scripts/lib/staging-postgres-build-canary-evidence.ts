import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import type { StagingPostgresBuildCanaryDurableArtifactEvidence } from
  "./staging-postgres-build-canary-executor.js";

export const STAGING_POSTGRES_BUILD_CANARY_EVIDENCE_LEAVES = Object.freeze({
  intent: "pintpath-staging-postgres-build-canary-intent.json",
  terminalEvidence:
    "pintpath-staging-postgres-build-canary-terminal-evidence.json",
} as const);

export type StagingPostgresBuildCanaryEvidenceLeaf =
  typeof STAGING_POSTGRES_BUILD_CANARY_EVIDENCE_LEAVES[keyof
    typeof STAGING_POSTGRES_BUILD_CANARY_EVIDENCE_LEAVES];

export type StagingPostgresBuildCanaryEvidenceFailureCode =
  | "evidence_invalid"
  | "cleanup_failed";

export class StagingPostgresBuildCanaryEvidenceError extends Error {
  readonly code: StagingPostgresBuildCanaryEvidenceFailureCode;

  constructor(code: StagingPostgresBuildCanaryEvidenceFailureCode) {
    super(code);
    this.name = "StagingPostgresBuildCanaryEvidenceError";
    this.code = code;
  }
}

const MAX_CANONICAL_CONTENT_BYTES = 64 * 1_024;
const MAX_PARENT_PATH_BYTES = 4_096;
const RANDOM_TEMPORARY_BYTES = 16;
const ALLOWED_LEAVES = new Set<string>(
  Object.values(STAGING_POSTGRES_BUILD_CANARY_EVIDENCE_LEAVES),
);

type FileHandle = fs.promises.FileHandle;

export interface StagingPostgresBuildCanaryEvidenceDependencies {
  readonly open: (
    filename: string,
    flags: number,
    mode?: number,
  ) => Promise<FileHandle>;
  readonly lstat: (filename: string) => Promise<fs.BigIntStats>;
  readonly realpath: (filename: string) => Promise<string>;
  readonly link: (existingPath: string, newPath: string) => Promise<void>;
  readonly unlink: (filename: string) => Promise<void>;
  readonly randomBytes: (size: number) => Buffer;
  readonly effectiveUid: () => number;
  readonly syncHandle: (handle: FileHandle) => Promise<void>;
  readonly closeHandle: (handle: FileHandle) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: StagingPostgresBuildCanaryEvidenceDependencies = {
  open: (filename, flags, mode) => mode === undefined
    ? fs.promises.open(filename, flags)
    : fs.promises.open(filename, flags, mode),
  lstat: (filename) => fs.promises.lstat(filename, { bigint: true }),
  realpath: (filename) => fs.promises.realpath(filename),
  link: (existingPath, newPath) => fs.promises.link(existingPath, newPath),
  unlink: (filename) => fs.promises.unlink(filename),
  randomBytes: (size) => crypto.randomBytes(size),
  effectiveUid: () => {
    if (typeof process.geteuid !== "function") throw invalid();
    return process.geteuid();
  },
  syncHandle: (handle) => handle.sync(),
  closeHandle: (handle) => handle.close(),
};

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
}

function invalid(): StagingPostgresBuildCanaryEvidenceError {
  return new StagingPostgresBuildCanaryEvidenceError("evidence_invalid");
}

function cleanupFailed(): StagingPostgresBuildCanaryEvidenceError {
  return new StagingPostgresBuildCanaryEvidenceError("cleanup_failed");
}

function checkSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal) || signal.aborted) throw invalid();
}

function errnoIs(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function directoryIdentity(stat: fs.BigIntStats): DirectoryIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
  };
}

function fileIdentity(stat: fs.BigIntStats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
  };
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid;
}

function sameStableFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameFileIdentity(fileIdentity(left), fileIdentity(right))
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertPrivateParent(stat: fs.BigIntStats, uid: bigint): void {
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.uid !== uid
    || stat.nlink < 1n
    || (stat.mode & 0o7777n) !== 0o700n
  ) throw invalid();
}

function assertPrivateFile(
  stat: fs.BigIntStats,
  uid: bigint,
  expectedSize: number,
  expectedLinks: bigint,
): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== uid
    || stat.nlink !== expectedLinks
    || (stat.mode & 0o7777n) !== 0o600n
    || stat.size !== BigInt(expectedSize)
  ) throw invalid();
}

function exactParentPath(value: string): string {
  if (
    !path.isAbsolute(value)
    || path.normalize(value) !== value
    || path.resolve(value) !== value
    || value === path.parse(value).root
    || value.includes("\0")
    || /[\r\n]/.test(value)
    || Buffer.byteLength(value, "utf8") > MAX_PARENT_PATH_BYTES
  ) throw invalid();
  return value;
}

function exactLeaf(value: string): StagingPostgresBuildCanaryEvidenceLeaf {
  if (
    !ALLOWED_LEAVES.has(value)
    || path.basename(value) !== value
    || value.includes("\0")
    || /[\r\n]/.test(value)
  ) throw invalid();
  return value as StagingPostgresBuildCanaryEvidenceLeaf;
}

function canonicalUtf8Bytes(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_CANONICAL_CONTENT_BYTES) {
    throw invalid();
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalid();
  }
  if (
    decoded !== value
    || typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || JSON.stringify(parsed) !== value
  ) throw invalid();
  return bytes;
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function lstatIfPresent(
  dependencies: StagingPostgresBuildCanaryEvidenceDependencies,
  filename: string,
): Promise<fs.BigIntStats | null> {
  try {
    return await dependencies.lstat(filename);
  } catch (error) {
    if (errnoIs(error, "ENOENT")) return null;
    throw invalid();
  }
}

async function readExactStable(
  handle: FileHandle,
  expected: Buffer,
  uid: bigint,
  expectedLinks: bigint,
  signal?: AbortSignal,
): Promise<fs.BigIntStats> {
  if (signal) checkSignal(signal);
  const before = await handle.stat({ bigint: true });
  if (signal) checkSignal(signal);
  assertPrivateFile(before, uid, expected.length, expectedLinks);
  const actual = Buffer.alloc(expected.length);
  try {
    let offset = 0;
    while (offset < actual.length) {
      if (signal) checkSignal(signal);
      const result = await handle.read(
        actual,
        offset,
        actual.length - offset,
        offset,
      );
      if (signal) checkSignal(signal);
      if (result.bytesRead === 0) throw invalid();
      offset += result.bytesRead;
    }
    const overflow = Buffer.alloc(1);
    try {
      if (signal) checkSignal(signal);
      const extra = await handle.read(overflow, 0, 1, actual.length);
      if (signal) checkSignal(signal);
      if (extra.bytesRead !== 0) throw invalid();
    } finally {
      overflow.fill(0);
    }
    const after = await handle.stat({ bigint: true });
    if (signal) checkSignal(signal);
    if (!sameStableFile(before, after) || !actual.equals(expected)) throw invalid();
    return after;
  } finally {
    actual.fill(0);
  }
}

function evidence(
  publication: StagingPostgresBuildCanaryDurableArtifactEvidence["publication"],
  digest: string,
): StagingPostgresBuildCanaryDurableArtifactEvidence {
  return {
    publication,
    sha256: digest,
    canonicalPathExact: true,
    parentMode0700: true,
    fileMode0600: true,
    currentUid: true,
    regularFile: true,
    nonSymlink: true,
    nlinkOne: true,
    exclusiveCreate: publication === "created-durable",
    fileFsync: true,
    parentFsync: true,
    identityHeld: true,
    readbackExact: true,
  };
}

export interface StagingPostgresBuildCanaryEvidenceStore {
  inspect(
    leaf: StagingPostgresBuildCanaryEvidenceLeaf,
    canonicalContent: string,
    signal: AbortSignal,
  ): Promise<StagingPostgresBuildCanaryDurableArtifactEvidence | null>;
  persist(
    leaf: StagingPostgresBuildCanaryEvidenceLeaf,
    canonicalContent: string,
    signal: AbortSignal,
  ): Promise<StagingPostgresBuildCanaryDurableArtifactEvidence>;
  close(): Promise<void>;
}

class EvidenceStore implements StagingPostgresBuildCanaryEvidenceStore {
  private closed = false;
  private active = false;

  constructor(
    private readonly parentPath: string,
    private readonly parentHandle: FileHandle,
    private readonly parentIdentity: DirectoryIdentity,
    private readonly uid: bigint,
    private readonly dependencies: StagingPostgresBuildCanaryEvidenceDependencies,
  ) {}

  private async assertParentExact(signal?: AbortSignal): Promise<void> {
    if (signal) checkSignal(signal);
    const [descriptor, atPath, real] = await Promise.all([
      this.parentHandle.stat({ bigint: true }),
      this.dependencies.lstat(this.parentPath),
      this.dependencies.realpath(this.parentPath),
    ]);
    if (signal) checkSignal(signal);
    assertPrivateParent(descriptor, this.uid);
    assertPrivateParent(atPath, this.uid);
    if (
      real !== this.parentPath
      || !sameDirectoryIdentity(
        this.parentIdentity,
        directoryIdentity(descriptor),
      )
      || !sameDirectoryIdentity(
        this.parentIdentity,
        directoryIdentity(atPath),
      )
    ) throw invalid();
  }

  private enter(): void {
    if (this.closed || this.active) throw invalid();
    this.active = true;
  }

  private leave(): void {
    this.active = false;
  }

  private async closeFileWithPrecedence(handle: FileHandle): Promise<void> {
    try {
      await this.dependencies.closeHandle(handle);
    } catch {
      throw cleanupFailed();
    }
  }

  private async verifyExisting(
    filePath: string,
    expected: Buffer,
    signal: AbortSignal,
  ): Promise<StagingPostgresBuildCanaryDurableArtifactEvidence> {
    let handle: FileHandle | null = null;
    let failure: unknown = null;
    try {
      await this.assertParentExact(signal);
      const initialPath = await this.dependencies.lstat(filePath);
      checkSignal(signal);
      assertPrivateFile(initialPath, this.uid, expected.length, 1n);
      handle = await this.dependencies.open(
        filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      checkSignal(signal);
      const descriptor = await readExactStable(
        handle,
        expected,
        this.uid,
        1n,
        signal,
      );
      if (!sameStableFile(descriptor, initialPath)) throw invalid();
      const atPath = await this.dependencies.lstat(filePath);
      checkSignal(signal);
      assertPrivateFile(atPath, this.uid, expected.length, 1n);
      if (!sameStableFile(descriptor, atPath)) throw invalid();
      await this.dependencies.syncHandle(handle);
      checkSignal(signal);
      await this.dependencies.syncHandle(this.parentHandle);
      checkSignal(signal);
      await this.assertParentExact(signal);
      const finalDescriptor = await readExactStable(
        handle,
        expected,
        this.uid,
        1n,
        signal,
      );
      const finalPath = await this.dependencies.lstat(filePath);
      checkSignal(signal);
      if (!sameStableFile(finalDescriptor, finalPath)) throw invalid();
      return evidence("existing-exact", sha256(expected));
    } catch (error) {
      failure = error;
      throw error instanceof StagingPostgresBuildCanaryEvidenceError
        ? error
        : invalid();
    } finally {
      if (handle) {
        try {
          await this.closeFileWithPrecedence(handle);
        } catch (closeError) {
          if (failure) throw cleanupFailed();
          throw closeError;
        }
      }
    }
  }

  async inspect(
    leafInput: StagingPostgresBuildCanaryEvidenceLeaf,
    canonicalContent: string,
    signal: AbortSignal,
  ): Promise<StagingPostgresBuildCanaryDurableArtifactEvidence | null> {
    checkSignal(signal);
    this.enter();
    let expected: Buffer | null = null;
    try {
      expected = canonicalUtf8Bytes(canonicalContent);
      checkSignal(signal);
      const leaf = exactLeaf(leafInput);
      const filePath = path.join(this.parentPath, leaf);
      await this.assertParentExact(signal);
      if (!await lstatIfPresent(this.dependencies, filePath)) {
        checkSignal(signal);
        await this.assertParentExact(signal);
        return null;
      }
      checkSignal(signal);
      return await this.verifyExisting(filePath, expected, signal);
    } catch (error) {
      throw error instanceof StagingPostgresBuildCanaryEvidenceError
        ? error
        : invalid();
    } finally {
      expected?.fill(0);
      this.leave();
    }
  }

  private async unlinkExactTemporary(
    temporaryPath: string,
    handle: FileHandle,
    identity: FileIdentity,
    expectedLinks: bigint,
    finalPath: string | null,
  ): Promise<boolean> {
    try {
      const [descriptor, temporary] = await Promise.all([
        handle.stat({ bigint: true }),
        this.dependencies.lstat(temporaryPath),
      ]);
      if (
        descriptor.size < 0n
        || descriptor.size > BigInt(MAX_CANONICAL_CONTENT_BYTES)
      ) return false;
      assertPrivateFile(descriptor, this.uid, Number(descriptor.size), expectedLinks);
      assertPrivateFile(temporary, this.uid, Number(descriptor.size), expectedLinks);
      if (
        !sameFileIdentity(identity, fileIdentity(descriptor))
        || !sameFileIdentity(identity, fileIdentity(temporary))
      ) return false;
      if (finalPath) {
        const final = await this.dependencies.lstat(finalPath);
        assertPrivateFile(final, this.uid, Number(descriptor.size), expectedLinks);
        if (!sameFileIdentity(identity, fileIdentity(final))) return false;
      }
      await this.dependencies.unlink(temporaryPath);
      const after = await handle.stat({ bigint: true });
      if (
        !sameFileIdentity(identity, fileIdentity(after))
        || after.nlink !== expectedLinks - 1n
      ) return false;
      if (await lstatIfPresent(this.dependencies, temporaryPath)) return false;
      if (!finalPath) return after.nlink === 0n;
      const final = await this.dependencies.lstat(finalPath);
      return after.nlink === 1n
        && final.nlink === 1n
        && sameFileIdentity(identity, fileIdentity(final));
    } catch {
      return false;
    }
  }

  private async cleanupTemporary(input: {
    temporaryPath: string;
    identity: FileIdentity | null;
    handle: FileHandle | null;
    linked: boolean;
    finalPath: string;
    alreadyUnlinked: boolean;
    temporaryCreated: boolean;
  }): Promise<boolean> {
    if (!input.temporaryCreated) return true;
    let exact = true;
    let cleanupHandle = input.handle;
    let cleanupIdentity = input.identity;
    try {
      await this.assertParentExact();
    } catch {
      exact = false;
    }
    if (!exact) {
      if (cleanupHandle) {
        try {
          await this.dependencies.closeHandle(cleanupHandle);
        } catch {
          // Cleanup is already inexact; retain failure precedence.
        }
      }
      return false;
    }
    if (!input.alreadyUnlinked) {
      let atPath: fs.BigIntStats | null = null;
      try {
        atPath = await lstatIfPresent(this.dependencies, input.temporaryPath);
      } catch {
        exact = false;
      }
      if (atPath) {
        if (!cleanupIdentity && cleanupHandle) {
          try {
            const descriptor = await cleanupHandle.stat({ bigint: true });
            if (
              descriptor.size < 0n
              || descriptor.size > BigInt(MAX_CANONICAL_CONTENT_BYTES)
            ) throw invalid();
            assertPrivateFile(
              descriptor,
              this.uid,
              Number(descriptor.size),
              input.linked ? 2n : 1n,
            );
            cleanupIdentity = fileIdentity(descriptor);
          } catch {
            cleanupIdentity = null;
          }
        }
        if (!cleanupIdentity) {
          exact = false;
        } else {
          let pathExact = atPath.size >= 0n
            && atPath.size <= BigInt(MAX_CANONICAL_CONTENT_BYTES);
          try {
            if (pathExact) {
              assertPrivateFile(
                atPath,
                this.uid,
                Number(atPath.size),
                input.linked ? 2n : 1n,
              );
            }
          } catch {
            pathExact = false;
          }
          pathExact = pathExact
            && sameFileIdentity(cleanupIdentity, fileIdentity(atPath));
          if (!pathExact) {
            exact = false;
          } else {
            if (cleanupHandle) {
              let descriptorExact = false;
              try {
                const descriptor = await cleanupHandle.stat({ bigint: true });
                descriptorExact = sameFileIdentity(
                  cleanupIdentity,
                  fileIdentity(descriptor),
                );
              } catch {
                descriptorExact = false;
              }
              if (!descriptorExact) {
                try {
                  await this.dependencies.closeHandle(cleanupHandle);
                } catch {
                  exact = false;
                }
                cleanupHandle = null;
                exact = false;
              }
            }
            if (!cleanupHandle) {
              try {
                cleanupHandle = await this.dependencies.open(
                  input.temporaryPath,
                  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
                );
              } catch {
                cleanupHandle = null;
              }
            }
            if (
              !cleanupHandle
              || !await this.unlinkExactTemporary(
                input.temporaryPath,
                cleanupHandle,
                cleanupIdentity,
                input.linked ? 2n : 1n,
                input.linked ? input.finalPath : null,
              )
            ) exact = false;
          }
        }
      }
    }
    if (cleanupHandle) {
      try {
        await this.dependencies.closeHandle(cleanupHandle);
      } catch {
        exact = false;
      }
    }
    try {
      await this.assertParentExact();
    } catch {
      exact = false;
    }
    return exact;
  }

  private async createOrVerifyExisting(
    filePath: string,
    leaf: StagingPostgresBuildCanaryEvidenceLeaf,
    expected: Buffer,
    signal: AbortSignal,
  ): Promise<StagingPostgresBuildCanaryDurableArtifactEvidence> {
    checkSignal(signal);
    const random = this.dependencies.randomBytes(RANDOM_TEMPORARY_BYTES);
    if (!Buffer.isBuffer(random) || random.length !== RANDOM_TEMPORARY_BYTES) {
      throw invalid();
    }
    const temporaryPath = path.join(
      this.parentPath,
      `.${leaf}.${random.toString("hex")}.tmp`,
    );
    random.fill(0);

    let writeHandle: FileHandle | null = null;
    let readHandle: FileHandle | null = null;
    let identity: FileIdentity | null = null;
    let temporaryCreated = false;
    let linked = false;
    let temporaryUnlinked = false;
    let normalResult = false;
    try {
      await this.assertParentExact(signal);
      checkSignal(signal);
      try {
        writeHandle = await this.dependencies.open(
          temporaryPath,
          fs.constants.O_WRONLY
            | fs.constants.O_CREAT
            | fs.constants.O_EXCL
            | (fs.constants.O_NOFOLLOW ?? 0),
          0o600,
        );
      } catch (error) {
        if (errnoIs(error, "EEXIST")) throw invalid();
        let possiblePartial: fs.BigIntStats | null;
        try {
          possiblePartial = await lstatIfPresent(
            this.dependencies,
            temporaryPath,
          );
        } catch {
          throw cleanupFailed();
        }
        if (possiblePartial) throw cleanupFailed();
        throw invalid();
      }
      temporaryCreated = true;
      await writeHandle.chmod(0o600);
      const created = await writeHandle.stat({ bigint: true });
      assertPrivateFile(created, this.uid, 0, 1n);
      identity = fileIdentity(created);
      checkSignal(signal);
      let offset = 0;
      while (offset < expected.length) {
        checkSignal(signal);
        const result = await writeHandle.write(
          expected,
          offset,
          expected.length - offset,
          offset,
        );
        checkSignal(signal);
        if (result.bytesWritten === 0) throw invalid();
        offset += result.bytesWritten;
      }
      await this.dependencies.syncHandle(writeHandle);
      checkSignal(signal);
      const written = await writeHandle.stat({ bigint: true });
      checkSignal(signal);
      const writtenPath = await this.dependencies.lstat(temporaryPath);
      checkSignal(signal);
      assertPrivateFile(written, this.uid, expected.length, 1n);
      assertPrivateFile(writtenPath, this.uid, expected.length, 1n);
      if (
        !sameFileIdentity(identity, fileIdentity(written))
        || !sameStableFile(written, writtenPath)
      ) throw invalid();
      await this.closeFileWithPrecedence(writeHandle);
      writeHandle = null;
      checkSignal(signal);

      readHandle = await this.dependencies.open(
        temporaryPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      checkSignal(signal);
      const readback = await readExactStable(
        readHandle,
        expected,
        this.uid,
        1n,
        signal,
      );
      if (!sameFileIdentity(identity, fileIdentity(readback))) throw invalid();
      await this.assertParentExact(signal);
      checkSignal(signal);

      // The hard link is the publication commit point. Cancellation is checked
      // immediately before it. Once the link succeeds, the store must finish
      // unlinking the temporary name, fsyncing the parent, and stable readback;
      // returning early would leave publication durability ambiguous.
      try {
        await this.dependencies.link(temporaryPath, filePath);
        linked = true;
      } catch (error) {
        if (errnoIs(error, "EEXIST")) {
          if (!await this.unlinkExactTemporary(
            temporaryPath,
            readHandle,
            identity,
            1n,
            null,
          )) throw cleanupFailed();
          temporaryUnlinked = true;
          await this.closeFileWithPrecedence(readHandle);
          readHandle = null;
          checkSignal(signal);
          normalResult = true;
          return await this.verifyExisting(filePath, expected, signal);
        }
        let descriptor: fs.BigIntStats;
        let final: fs.BigIntStats | null;
        try {
          descriptor = await readHandle.stat({ bigint: true });
          final = await lstatIfPresent(this.dependencies, filePath);
        } catch {
          throw cleanupFailed();
        }
        linked = final !== null
          && descriptor.nlink >= 1n
          && sameFileIdentity(identity, fileIdentity(descriptor))
          && sameFileIdentity(identity, fileIdentity(final));
        if (linked) throw cleanupFailed();
        throw invalid();
      }

      const [linkedDescriptor, linkedTemporary, linkedFinal] = await Promise.all([
        readHandle.stat({ bigint: true }),
        this.dependencies.lstat(temporaryPath),
        this.dependencies.lstat(filePath),
      ]);
      assertPrivateFile(linkedDescriptor, this.uid, expected.length, 2n);
      assertPrivateFile(linkedTemporary, this.uid, expected.length, 2n);
      assertPrivateFile(linkedFinal, this.uid, expected.length, 2n);
      if (
        !sameFileIdentity(identity, fileIdentity(linkedDescriptor))
        || !sameFileIdentity(identity, fileIdentity(linkedTemporary))
        || !sameFileIdentity(identity, fileIdentity(linkedFinal))
      ) throw cleanupFailed();
      if (!await this.unlinkExactTemporary(
        temporaryPath,
        readHandle,
        identity,
        2n,
        filePath,
      )) throw cleanupFailed();
      temporaryUnlinked = true;
      await this.dependencies.syncHandle(this.parentHandle);
      await this.assertParentExact();
      const finalDescriptor = await readExactStable(
        readHandle,
        expected,
        this.uid,
        1n,
      );
      const finalPath = await this.dependencies.lstat(filePath);
      if (
        !sameStableFile(finalDescriptor, finalPath)
        || !sameFileIdentity(identity, fileIdentity(finalPath))
      ) throw cleanupFailed();
      await this.closeFileWithPrecedence(readHandle);
      readHandle = null;
      normalResult = true;
      return evidence("created-durable", sha256(expected));
    } catch (error) {
      const cleanupExact = await this.cleanupTemporary({
        temporaryPath,
        identity,
        handle: readHandle ?? writeHandle,
        linked,
        finalPath: filePath,
        alreadyUnlinked: temporaryUnlinked,
        temporaryCreated,
      });
      readHandle = null;
      writeHandle = null;
      if (linked || !cleanupExact || error instanceof StagingPostgresBuildCanaryEvidenceError
        && error.code === "cleanup_failed") {
        throw cleanupFailed();
      }
      throw invalid();
    } finally {
      if (!normalResult && (readHandle || writeHandle)) {
        const dangling = readHandle ?? writeHandle;
        if (dangling) {
          try {
            await this.dependencies.closeHandle(dangling);
          } catch {
            throw cleanupFailed();
          }
        }
      }
    }
  }

  async persist(
    leafInput: StagingPostgresBuildCanaryEvidenceLeaf,
    canonicalContent: string,
    signal: AbortSignal,
  ): Promise<StagingPostgresBuildCanaryDurableArtifactEvidence> {
    checkSignal(signal);
    this.enter();
    let expected: Buffer | null = null;
    try {
      expected = canonicalUtf8Bytes(canonicalContent);
      checkSignal(signal);
      const leaf = exactLeaf(leafInput);
      const filePath = path.join(this.parentPath, leaf);
      await this.assertParentExact(signal);
      if (await lstatIfPresent(this.dependencies, filePath)) {
        checkSignal(signal);
        return await this.verifyExisting(filePath, expected, signal);
      }
      checkSignal(signal);
      return await this.createOrVerifyExisting(
        filePath,
        leaf,
        expected,
        signal,
      );
    } catch (error) {
      throw error instanceof StagingPostgresBuildCanaryEvidenceError
        ? error
        : invalid();
    } finally {
      expected?.fill(0);
      this.leave();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.active) throw cleanupFailed();
    this.closed = true;
    let exact = true;
    try {
      await this.assertParentExact();
    } catch {
      exact = false;
    }
    try {
      await this.dependencies.closeHandle(this.parentHandle);
    } catch {
      exact = false;
    }
    if (!exact) throw cleanupFailed();
  }
}

export async function openStagingPostgresBuildCanaryEvidenceStore(
  parentDirectory: string,
  overrides: Partial<StagingPostgresBuildCanaryEvidenceDependencies> = {},
): Promise<StagingPostgresBuildCanaryEvidenceStore> {
  const dependencies: StagingPostgresBuildCanaryEvidenceDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  const parentPath = exactParentPath(parentDirectory);
  let parentHandle: FileHandle | null = null;
  let failure: unknown = null;
  try {
    const effectiveUid = dependencies.effectiveUid();
    if (!Number.isSafeInteger(effectiveUid) || effectiveUid < 0) throw invalid();
    const uid = BigInt(effectiveUid);
    const [real, before] = await Promise.all([
      dependencies.realpath(parentPath),
      dependencies.lstat(parentPath),
    ]);
    assertPrivateParent(before, uid);
    if (real !== parentPath) throw invalid();
    parentHandle = await dependencies.open(
      parentPath,
      fs.constants.O_RDONLY
        | (fs.constants.O_DIRECTORY ?? 0)
        | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = await parentHandle.stat({ bigint: true });
    assertPrivateParent(opened, uid);
    const identity = directoryIdentity(before);
    if (!sameDirectoryIdentity(identity, directoryIdentity(opened))) throw invalid();
    return new EvidenceStore(
      parentPath,
      parentHandle,
      identity,
      uid,
      dependencies,
    );
  } catch (error) {
    failure = error;
    throw error instanceof StagingPostgresBuildCanaryEvidenceError
      ? error
      : invalid();
  } finally {
    if (failure && parentHandle) {
      try {
        await dependencies.closeHandle(parentHandle);
      } catch {
        throw cleanupFailed();
      }
    }
  }
}

export const stagingPostgresBuildCanaryEvidenceInternals = {
  MAX_CANONICAL_CONTENT_BYTES,
};
