import fs from "node:fs";
import path from "node:path";

interface TrustedReadOptions {
  readonly minBytes: number;
  readonly maxBytes: number;
  readonly requireOwner?: boolean;
  readonly requirePrivate?: boolean;
  readonly requireExecutable?: boolean;
}

interface PrivateWriteOptions {
  readonly requireExactDirectoryMode?: boolean;
  readonly requireOwner?: boolean;
}

type BigIntStats = fs.BigIntStats;

function requiredFlag(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value <= 0) {
    throw new Error("filesystem_capability_unavailable");
  }
  return value;
}

const O_NOFOLLOW = requiredFlag(fs.constants.O_NOFOLLOW);
const O_DIRECTORY = requiredFlag(fs.constants.O_DIRECTORY);

function exactAbsolutePath(filename: string): boolean {
  return path.isAbsolute(filename)
    && path.normalize(filename) === filename
    && path.resolve(filename) === filename
    && !filename.includes("\0");
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
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

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

function currentUid(): bigint | null {
  const uid = process.geteuid?.() ?? process.getuid?.();
  return Number.isSafeInteger(uid) ? BigInt(uid!) : null;
}

function pathMatchesDescriptor(filename: string, descriptorStat: BigIntStats): boolean {
  const pathnameStat = fs.lstatSync(filename, { bigint: true });
  return !pathnameStat.isSymbolicLink()
    && pathnameStat.dev === descriptorStat.dev
    && pathnameStat.ino === descriptorStat.ino
    && fs.realpathSync(filename) === filename;
}

/**
 * Reads only from an already-open, no-follow descriptor. Pathname inspection is
 * used after open solely to bind the held inode to its canonical pathname; the
 * pathname is never reopened for content.
 */
export function readTrustedRegularFile(
  filename: string,
  options: TrustedReadOptions,
): Buffer {
  if (!exactAbsolutePath(filename)
    || !Number.isSafeInteger(options.minBytes) || options.minBytes < 0
    || !Number.isSafeInteger(options.maxBytes)
    || options.maxBytes < options.minBytes) throw new Error("trusted_file_invalid");

  let descriptor: number | null = null;
  let bytes: Buffer | null = null;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | O_NOFOLLOW);
    const before = fs.fstatSync(descriptor, { bigint: true });
    const uid = currentUid();
    if (!before.isFile() || before.nlink !== 1n
      || before.size < BigInt(options.minBytes)
      || before.size > BigInt(options.maxBytes)
      || options.requirePrivate && (before.mode & 0o077n) !== 0n
      || options.requireExecutable && (before.mode & 0o111n) === 0n
      || options.requireExecutable && (before.mode & 0o022n) !== 0n
      || options.requireOwner && (uid === null || before.uid !== uid)) {
      throw new Error("trusted_file_invalid");
    }

    bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count < 1) throw new Error("trusted_file_invalid");
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, after) || !pathMatchesDescriptor(filename, after)) {
      throw new Error("trusted_file_invalid");
    }
    const result = bytes;
    bytes = null;
    return result;
  } catch {
    bytes?.fill(0);
    throw new Error("trusted_file_invalid");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

/**
 * Opens and retains the evidence directory before reserving a no-follow child.
 * Both pathname identities are rebound to held descriptors before any bytes are
 * written, so a rename/symlink swap can only make the operation fail closed.
 */
export function writePrivateExclusiveFile(
  directory: string,
  leaf: string,
  source: string | Buffer,
  options: PrivateWriteOptions = {},
): void {
  if (!exactAbsolutePath(directory) || path.basename(leaf) !== leaf
    || leaf === "." || leaf === ".." || leaf.includes("\0")) {
    throw new Error("private_output_invalid");
  }
  const filename = path.join(directory, leaf);
  let directoryDescriptor: number | null = null;
  let fileDescriptor: number | null = null;
  try {
    directoryDescriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
    );
    const directoryBefore = fs.fstatSync(directoryDescriptor, { bigint: true });
    const uid = currentUid();
    const permissionBits = directoryBefore.mode & 0o777n;
    if (!directoryBefore.isDirectory()
      || (permissionBits & 0o077n) !== 0n
      || options.requireExactDirectoryMode && permissionBits !== 0o700n
      || options.requireOwner && (uid === null || directoryBefore.uid !== uid)) {
      throw new Error("private_output_invalid");
    }

    fileDescriptor = fs.openSync(
      filename,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW,
      0o600,
    );
    const fileBefore = fs.fstatSync(fileDescriptor, { bigint: true });
    const directoryRebound = fs.fstatSync(directoryDescriptor, { bigint: true });
    if (!sameDirectoryIdentity(directoryBefore, directoryRebound)
      || !pathMatchesDescriptor(directory, directoryRebound)
      || !fileBefore.isFile() || fileBefore.nlink !== 1n || fileBefore.size !== 0n
      || (fileBefore.mode & 0o777n) !== 0o600n
      || options.requireOwner && (uid === null || fileBefore.uid !== uid)
      || !pathMatchesDescriptor(filename, fileBefore)) {
      throw new Error("private_output_invalid");
    }

    const bytes = typeof source === "string" ? Buffer.from(source, "utf8") : source;
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(fileDescriptor, bytes, offset, bytes.length - offset, offset);
      if (count < 1) throw new Error("private_output_invalid");
      offset += count;
    }
    fs.fsyncSync(fileDescriptor);
    const fileAfter = fs.fstatSync(fileDescriptor, { bigint: true });
    const directoryAfter = fs.fstatSync(directoryDescriptor, { bigint: true });
    if (fileAfter.dev !== fileBefore.dev || fileAfter.ino !== fileBefore.ino
      || fileAfter.nlink !== 1n || fileAfter.size !== BigInt(bytes.length)
      || (fileAfter.mode & 0o777n) !== 0o600n
      || !sameDirectoryIdentity(directoryBefore, directoryAfter)
      || !pathMatchesDescriptor(directory, directoryAfter)
      || !pathMatchesDescriptor(filename, fileAfter)) {
      throw new Error("private_output_invalid");
    }
    fs.fsyncSync(directoryDescriptor);
  } catch {
    throw new Error("private_output_invalid");
  } finally {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
    if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor);
  }
}
