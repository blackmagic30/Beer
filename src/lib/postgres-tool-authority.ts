import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Buffer as NodeBuffer } from "node:buffer";
import { types as utilTypes } from "node:util";

/*
 * Review boundary: this module holds and hashes the reviewed binary, but Node
 * still launches an executable by pathname. A hostile current-UID actor could
 * swap that pathname after preflight and restore it before postflight. These
 * authorities therefore remain review-only until the launch command runs in a
 * protected immutable runtime that also binds the dynamic loader and complete
 * shared-library dependency tree (or uses an equivalently reviewed native
 * fexecve/execveat launcher and dependency closure). Hashing only pg_dump or
 * pg_restore does not bind libpq, OpenSSL, zstd, or other loaded code. The
 * checks below must not be represented as atomic execution.
 *
 * The activated worker must also evaluate this module in a pristine realm and
 * lock its Promise primordials before untrusted code can run. Captured methods
 * prevent later global-property dispatch, but arbitrary mutation of the
 * intrinsic Promise prototype is outside this module's standalone authority.
 */

const GLOBAL_THIS_INTRINSIC = globalThis;
const ARRAY_INTRINSIC = GLOBAL_THIS_INTRINSIC.Array;
const BIGINT_INTRINSIC = BigInt;
const BUFFER_INTRINSIC = NodeBuffer;
const CRYPTO_INTRINSIC = crypto;
const MATH_INTRINSIC = Math;
const NUMBER_INTRINSIC = Number;
const OBJECT_INTRINSIC = GLOBAL_THIS_INTRINSIC.Object;
const PATH_INTRINSIC = path;
const PROCESS_INTRINSIC = process;
const PROMISE_INTRINSIC = GLOBAL_THIS_INTRINSIC.Promise;
const REFLECT_INTRINSIC = Reflect;
const STRING_INTRINSIC = String;
const SYMBOL_INTRINSIC = Symbol;
const UTIL_TYPES_INTRINSIC = utilTypes;

const ARRAY_INCLUDES = ARRAY_INTRINSIC.prototype.includes;
const ARRAY_IS_ARRAY = ARRAY_INTRINSIC.isArray;
const ARRAY_SOME = ARRAY_INTRINSIC.prototype.some;
const ARRAY_VALUES = ARRAY_INTRINSIC.prototype.values;
const BUFFER_ALLOC = BUFFER_INTRINSIC.alloc;
const BUFFER_BYTE_LENGTH = BUFFER_INTRINSIC.byteLength;
const CRYPTO_CREATE_HASH = CRYPTO_INTRINSIC.createHash;
const MATH_MIN = MATH_INTRINSIC.min;
const NUMBER_IS_SAFE_INTEGER = NUMBER_INTRINSIC.isSafeInteger;
const OBJECT_CREATE = OBJECT_INTRINSIC.create;
const OBJECT_DEFINE_PROPERTIES = OBJECT_INTRINSIC.defineProperties;
const OBJECT_FREEZE = OBJECT_INTRINSIC.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  OBJECT_INTRINSIC.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  OBJECT_INTRINSIC.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = OBJECT_INTRINSIC.getPrototypeOf;
const OBJECT_HAS_OWN = OBJECT_INTRINSIC.hasOwn;
const OBJECT_SET_PROTOTYPE_OF = OBJECT_INTRINSIC.setPrototypeOf;
const PATH_BASENAME = PATH_INTRINSIC.basename;
const PATH_IS_ABSOLUTE = PATH_INTRINSIC.isAbsolute;
const PATH_NORMALIZE = PATH_INTRINSIC.normalize;
const PATH_RESOLVE = PATH_INTRINSIC.resolve;
const PROMISE_REJECT = PROMISE_INTRINSIC.reject;
const PROMISE_PROTOTYPE = PROMISE_INTRINSIC.prototype;
const REFLECT_APPLY = REFLECT_INTRINSIC.apply;
const REFLECT_OWN_KEYS = REFLECT_INTRINSIC.ownKeys;
const REGEXP_EXEC = RegExp.prototype.exec;
const STRING_INCLUDES = STRING_INTRINSIC.prototype.includes;
const STRING_SLICE = STRING_INTRINSIC.prototype.slice;
const STRING_STARTS_WITH = STRING_INTRINSIC.prototype.startsWith;
const STRING_TRIM = STRING_INTRINSIC.prototype.trim;
const SYMBOL_ITERATOR = SYMBOL_INTRINSIC.iterator;
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const UTIL_IS_PROMISE = UTIL_TYPES_INTRINSIC.isPromise;
const UTIL_IS_PROXY = UTIL_TYPES_INTRINSIC.isProxy;

const FS_LSTAT_SYNC = fs.lstatSync;
const FS_REALPATH_SYNC_RECEIVER = fs.realpathSync;
const FS_REALPATH_SYNC = fs.realpathSync.native;
const FS_OPEN_SYNC = fs.openSync;
const FS_FSTAT_SYNC = fs.fstatSync;
const FS_READ_SYNC = fs.readSync;
const FS_CLOSE_SYNC = fs.closeSync;
const PROCESS_GETEUID = PROCESS_INTRINSIC.geteuid;

const HASH_PROBE = REFLECT_APPLY(
  CRYPTO_CREATE_HASH,
  CRYPTO_INTRINSIC,
  ["sha256"],
);
const HASH_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(HASH_PROBE) as {
  readonly update: (...args: never[]) => unknown;
  readonly digest: (...args: never[]) => unknown;
};
const HASH_UPDATE = HASH_PROTOTYPE.update;
const HASH_DIGEST = HASH_PROTOTYPE.digest;
REFLECT_APPLY(HASH_DIGEST, HASH_PROBE, []);

const O_NOFOLLOW_EXACT = fs.constants.O_NOFOLLOW;
const O_NONBLOCK_EXACT = fs.constants.O_NONBLOCK;
const O_RDONLY_EXACT = fs.constants.O_RDONLY;
const STAT_MODE_MASK = BIGINT_INTRINSIC(fs.constants.S_IFMT);
const STAT_MODE_REGULAR = BIGINT_INTRINSIC(fs.constants.S_IFREG);
const LOWERCASE_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SNAPSHOT_IDENTIFIER_PATTERN = /^[a-fA-F0-9-]{1,128}$/;
const BACKUP_ROLE_PATTERN = /^pintpath_logical_backup_d[1-9][0-9]{0,9}$/;
const POSTGRES_17_VERSION_PATTERN =
  /^17\.[0-9]+(?:\.[0-9]+){0,2}(?:(?:[-+._~:][a-zA-Z0-9+._~:-]{0,95})|(?: \([a-zA-Z0-9+._~: -]{1,94}\)))?$/;

export const POSTGRES_TOOL_AUTHORITY_MAXIMUM_BYTES = 67_108_864 as const;

const READ_CHUNK_BYTES = 64 * 1_024;
const MAX_PATH_BYTES = 4_096;
const MAX_ENVIRONMENT_VALUE_BYTES = 32 * 1_024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1_024 * 1_024;
const MAX_ARCHIVE_BYTES = 1_099_511_627_776n;
const VERSION_TIMEOUT_MS = 15_000;
const VERSION_OUTPUT_LIMIT = 4 * 1_024;
const DUMP_TIMEOUT_MS = 60 * 60 * 1_000;
const DUMP_OUTPUT_LIMIT = 512 * 1_024;
const LIST_TIMEOUT_MS = 5 * 60 * 1_000;
const BACKUP_LIST_OUTPUT_LIMIT = 32 * 1_024 * 1_024;
const RESTORE_LIST_OUTPUT_LIMIT = 64 * 1_024 * 1_024;
const RESTORE_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const RESTORE_OUTPUT_LIMIT = 1 * 1_024 * 1_024;

export type PostgresToolAuthorityPurpose = "dump" | "list" | "restore";

export type PostgresToolAuthorityFailureCode =
  | "invalid_arguments"
  | "unsafe_executable"
  | "sha256_mismatch"
  | "tool_drift"
  | "archive_drift"
  | "process_failed"
  | "cleanup_failed";

export class PostgresToolAuthorityError extends Error {
  readonly code!: PostgresToolAuthorityFailureCode;

  constructor(code: PostgresToolAuthorityFailureCode) {
    super(code);
    REFLECT_APPLY(OBJECT_DEFINE_PROPERTIES, OBJECT_INTRINSIC, [this, {
      name: {
        configurable: true,
        enumerable: true,
        value: "PostgresToolAuthorityError",
        writable: true,
      },
      message: {
        configurable: true,
        enumerable: false,
        value: code,
        writable: true,
      },
      code: {
        configurable: true,
        enumerable: true,
        value: code,
        writable: false,
      },
    }]);
  }
}

export interface OpenPostgresToolAuthorityOptions {
  readonly purpose: PostgresToolAuthorityPurpose;
  readonly executableFile: string;
  readonly expectedSha256: string;
}

export interface PostgresToolProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

declare const POSTGRES_TOOL_PROCESS_RESULT_CARRIER_BRAND: unique symbol;

export interface PostgresToolProcessResultCarrier extends PostgresToolProcessResult {
  readonly [POSTGRES_TOOL_PROCESS_RESULT_CARRIER_BRAND]: true;
}

export interface PostgresToolAuthorityProcessInvocation {
  readonly operation: "version" | "dump" | "list" | "restore";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly stdinFileDescriptor?: number;
  readonly stdoutFileDescriptor?: number;
}

export type PostgresToolAuthorityProcessRunner = (
  invocation: PostgresToolAuthorityProcessInvocation,
) => Promise<PostgresToolProcessResultCarrier>;

/**
 * Test-only fault-injection seam. Passing this object replaces the captured
 * native raw-FD custody implementation and provides no production provenance.
 */
export interface PostgresToolAuthorityTestFileSystemDependencies {
  readonly effectiveUid: () => number;
  readonly lstat: (filename: string) => fs.BigIntStats;
  readonly realpath: (filename: string) => string;
  readonly open: (filename: string, flags: number) => number;
  readonly fstat: (fileDescriptor: number) => fs.BigIntStats;
  readonly read: (
    fileDescriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly close: (fileDescriptor: number) => void;
}

export interface PostgresDumpOperationInput {
  readonly snapshotIdentifier: string;
  readonly roleName: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly archiveOutputFileDescriptor: number;
}

export interface PostgresRestoreOperationInput {
  readonly environment: Readonly<Record<string, string>>;
  readonly archiveInputFileDescriptor: number;
}

interface PostgresToolAuthorityBase {
  version(): Promise<PostgresToolProcessResult>;
  assertExact(): Promise<void>;
  close(): Promise<void>;
}

export interface PostgresDumpToolAuthority extends PostgresToolAuthorityBase {
  dump(input: PostgresDumpOperationInput): Promise<PostgresToolProcessResult>;
}

export interface PostgresListToolAuthority extends PostgresToolAuthorityBase {
  list(archiveInputFileDescriptor: number): Promise<PostgresToolProcessResult>;
}

export interface PostgresRestoreToolAuthority extends PostgresListToolAuthority {
  restore(input: PostgresRestoreOperationInput): Promise<PostgresToolProcessResult>;
}

export type PostgresToolAuthority =
  | PostgresDumpToolAuthority
  | PostgresListToolAuthority
  | PostgresRestoreToolAuthority;

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

interface CapturedFailure {
  readonly caught: true;
  readonly error: unknown;
}

interface NoFailure {
  readonly caught: false;
}

type FailureState = CapturedFailure | NoFailure;
type SequencePhase = "version" | "operation" | "restore" | "spent";
type AuthorityState = "idle" | "operating" | "failed" | "closing" | "closed";

const ERROR_AUTHORITIES = new WeakMap<object, PostgresToolAuthorityFailureCode>();
const PROCESS_RESULT_CARRIERS = new WeakSet<object>();
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;

function freezeNullRecord<T extends object>(value: T): T {
  REFLECT_APPLY(OBJECT_SET_PROTOTYPE_OF, OBJECT_INTRINSIC, [value, null]);
  return REFLECT_APPLY(OBJECT_FREEZE, OBJECT_INTRINSIC, [value]) as T;
}

const NO_FAILURE: NoFailure = freezeNullRecord({ caught: false });

function internalError(
  code: PostgresToolAuthorityFailureCode,
): PostgresToolAuthorityError {
  const error = new PostgresToolAuthorityError(code);
  REFLECT_APPLY(WEAK_MAP_SET, ERROR_AUTHORITIES, [error, code]);
  return error;
}

function capturedErrorCode(error: unknown): PostgresToolAuthorityFailureCode | null {
  if (typeof error !== "object" || error === null) return null;
  return REFLECT_APPLY(WEAK_MAP_GET, ERROR_AUTHORITIES, [error]) ?? null;
}

function normalizeOpenFailure(error: unknown): never {
  throw internalError(capturedErrorCode(error) ?? "unsafe_executable");
}

function capture(error: unknown): CapturedFailure {
  return freezeNullRecord({ caught: true, error });
}

function regexpMatches(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY(REGEXP_EXEC, pattern, [value]) !== null;
}

function stringIncludes(value: string, search: string): boolean {
  return REFLECT_APPLY(STRING_INCLUDES, value, [search]);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return REFLECT_APPLY(OBJECT_HAS_OWN, OBJECT_INTRINSIC, [value, key]);
}

function ownDescriptor(
  descriptors: PropertyDescriptorMap | null,
  key: PropertyKey,
): PropertyDescriptor | null {
  if (descriptors === null || !hasOwn(descriptors, key)) return null;
  const descriptor = descriptors[key as keyof typeof descriptors];
  return descriptor !== undefined && hasOwn(descriptor, "value")
    ? descriptor
    : null;
}

function ownValue(
  descriptors: PropertyDescriptorMap | null,
  key: PropertyKey,
): unknown {
  return ownDescriptor(descriptors, key)?.value;
}

function ownDataDescriptors(
  value: unknown,
  exactKeys: readonly string[],
): Record<string, PropertyDescriptor> | null {
  try {
    if (
      typeof value !== "object"
      || value === null
      || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [value]) === true
    ) return null;
    const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, REFLECT_INTRINSIC, [value]);
    if (
      !REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_INTRINSIC, [keys])
      || keys.length !== exactKeys.length
    ) return null;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (
        typeof key !== "string"
        || !REFLECT_APPLY(ARRAY_INCLUDES, exactKeys, [key])
      ) return null;
    }
    const descriptors = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
      OBJECT_INTRINSIC,
      [value],
    ) as Record<string, PropertyDescriptor>;
    for (let index = 0; index < exactKeys.length; index += 1) {
      const key = exactKeys[index]!;
      if (ownDescriptor(descriptors, key) === null) return null;
    }
    return descriptors;
  } catch {
    return null;
  }
}

function dataPropertyDescriptors(value: unknown): PropertyDescriptorMap | null {
  try {
    if (
      typeof value !== "object"
      || value === null
      || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [value]) === true
    ) return null;
    const descriptors = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
      OBJECT_INTRINSIC,
      [value],
    );
    const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, REFLECT_INTRINSIC, [descriptors]);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      if (ownDescriptor(descriptors, key) === null) return null;
    }
    return descriptors;
  } catch {
    return null;
  }
}

function exactOptions(value: unknown): {
  readonly purpose: PostgresToolAuthorityPurpose;
  readonly executableFile: string;
  readonly expectedSha256: string;
} {
  const descriptors = ownDataDescriptors(value, [
    "purpose",
    "executableFile",
    "expectedSha256",
  ]);
  const purpose = ownValue(descriptors, "purpose");
  const executableFile = ownValue(descriptors, "executableFile");
  const expectedSha256 = ownValue(descriptors, "expectedSha256");
  if (
    (purpose !== "dump" && purpose !== "list" && purpose !== "restore")
    || typeof executableFile !== "string"
    || typeof expectedSha256 !== "string"
    || !regexpMatches(LOWERCASE_SHA256_PATTERN, expectedSha256)
  ) throw internalError("invalid_arguments");
  return freezeNullRecord({ purpose, executableFile, expectedSha256 });
}

function exactTestDependencies(
  value: unknown,
): PostgresToolAuthorityTestFileSystemDependencies {
  const keys = [
    "effectiveUid",
    "lstat",
    "realpath",
    "open",
    "fstat",
    "read",
    "close",
  ] as const;
  const descriptors = ownDataDescriptors(value, keys);
  const dependencies = {
    effectiveUid: ownValue(descriptors, "effectiveUid"),
    lstat: ownValue(descriptors, "lstat"),
    realpath: ownValue(descriptors, "realpath"),
    open: ownValue(descriptors, "open"),
    fstat: ownValue(descriptors, "fstat"),
    read: ownValue(descriptors, "read"),
    close: ownValue(descriptors, "close"),
  };
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const callback = dependencies[key];
    if (
      typeof callback !== "function"
      || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [callback]) === true
    ) throw internalError("invalid_arguments");
  }
  return freezeNullRecord(
    dependencies as PostgresToolAuthorityTestFileSystemDependencies,
  );
}

const CAPTURED_NATIVE_DEPENDENCIES:
PostgresToolAuthorityTestFileSystemDependencies = freezeNullRecord({
  effectiveUid(): number {
    if (typeof PROCESS_GETEUID !== "function") throw internalError("unsafe_executable");
    return REFLECT_APPLY(PROCESS_GETEUID, PROCESS_INTRINSIC, []);
  },
  lstat(filename: string): fs.BigIntStats {
    return REFLECT_APPLY(
      FS_LSTAT_SYNC,
      fs,
      [filename, { bigint: true }],
    ) as fs.BigIntStats;
  },
  realpath(filename: string): string {
    return REFLECT_APPLY(
      FS_REALPATH_SYNC,
      FS_REALPATH_SYNC_RECEIVER,
      [filename],
    ) as string;
  },
  open(filename: string, flags: number): number {
    return REFLECT_APPLY(FS_OPEN_SYNC, fs, [filename, flags]);
  },
  fstat(fileDescriptor: number): fs.BigIntStats {
    return REFLECT_APPLY(
      FS_FSTAT_SYNC,
      fs,
      [fileDescriptor, { bigint: true }],
    ) as fs.BigIntStats;
  },
  read(
    fileDescriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): number {
    return REFLECT_APPLY(FS_READ_SYNC, fs, [
      fileDescriptor,
      buffer,
      offset,
      length,
      position,
    ]);
  },
  close(fileDescriptor: number): void {
    REFLECT_APPLY(FS_CLOSE_SYNC, fs, [fileDescriptor]);
  },
});

function exactExecutablePath(
  value: string,
  purpose: PostgresToolAuthorityPurpose,
): string {
  const expectedBasename = purpose === "dump" ? "pg_dump" : "pg_restore";
  if (
    value.length < 1
    || REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_INTRINSIC, [value, "utf8"])
      > MAX_PATH_BYTES
    || stringIncludes(value, "\0")
    || !REFLECT_APPLY(PATH_IS_ABSOLUTE, PATH_INTRINSIC, [value])
    || REFLECT_APPLY(PATH_NORMALIZE, PATH_INTRINSIC, [value]) !== value
    || REFLECT_APPLY(PATH_RESOLVE, PATH_INTRINSIC, [value]) !== value
    || REFLECT_APPLY(PATH_BASENAME, PATH_INTRINSIC, [value])
      !== expectedBasename
  ) throw internalError("unsafe_executable");
  return value;
}

function invokeSync(
  callback: (...args: never[]) => unknown,
  args: unknown[],
): unknown {
  try {
    return REFLECT_APPLY(callback, undefined, args);
  } catch {
    throw internalError("unsafe_executable");
  }
}

function safeEffectiveUid(value: unknown): bigint {
  if (
    typeof value !== "number"
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_INTRINSIC, [value])
    || value < 0
  ) throw internalError("unsafe_executable");
  return BIGINT_INTRINSIC(value);
}

function stableIdentity(value: unknown): StableIdentity {
  const descriptors = dataPropertyDescriptors(value);
  const read = (key: keyof StableIdentity): bigint | null => {
    const candidate = ownValue(descriptors, key);
    return typeof candidate === "bigint" ? candidate : null;
  };
  const identity = {
    dev: read("dev"),
    ino: read("ino"),
    uid: read("uid"),
    gid: read("gid"),
    mode: read("mode"),
    nlink: read("nlink"),
    size: read("size"),
    mtimeNs: read("mtimeNs"),
    ctimeNs: read("ctimeNs"),
  };
  if (
    identity.dev === null
    || identity.ino === null
    || identity.uid === null
    || identity.gid === null
    || identity.mode === null
    || identity.nlink === null
    || identity.size === null
    || identity.mtimeNs === null
    || identity.ctimeNs === null
  ) throw internalError("unsafe_executable");
  return freezeNullRecord(identity as StableIdentity);
}

function assertExecutableIdentity(identity: StableIdentity, effectiveUid: bigint): void {
  const permissions = identity.mode & 0o7777n;
  const currentUidPolicy = identity.uid === effectiveUid && permissions === 0o555n;
  const rootPolicy = identity.uid === 0n
    && (permissions === 0o555n || permissions === 0o755n);
  if (
    (identity.mode & STAT_MODE_MASK) !== STAT_MODE_REGULAR
    || identity.dev < 0n
    || identity.ino < 1n
    || identity.uid < 0n
    || identity.gid < 0n
    || identity.nlink !== 1n
    || identity.size < 1n
    || identity.size > BIGINT_INTRINSIC(POSTGRES_TOOL_AUTHORITY_MAXIMUM_BYTES)
    || (permissions & 0o022n) !== 0n
    || (!currentUidPolicy && !rootPolicy)
  ) throw internalError("unsafe_executable");
}

function archiveIdentity(
  dependencies: PostgresToolAuthorityTestFileSystemDependencies,
  fileDescriptor: number,
  effectiveUid: bigint,
): StableIdentity {
  let identity: StableIdentity;
  try {
    identity = fstatExact(dependencies, fileDescriptor);
  } catch {
    throw internalError("archive_drift");
  }
  if (
    (identity.mode & STAT_MODE_MASK) !== STAT_MODE_REGULAR
    || identity.dev < 0n
    || identity.ino < 1n
    || identity.uid !== effectiveUid
    || identity.gid < 0n
    || identity.nlink !== 1n
    || identity.size < 1n
    || identity.size > MAX_ARCHIVE_BYTES
    || (identity.mode & 0o7777n) !== 0o600n
  ) throw internalError("archive_drift");
  return identity;
}

function sameIdentity(left: StableIdentity, right: StableIdentity): boolean {
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

function exactSize(value: bigint): number {
  const size = NUMBER_INTRINSIC(value);
  if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_INTRINSIC, [size]) || size < 1) {
    throw internalError("unsafe_executable");
  }
  return size;
}

function lstatExact(
  dependencies: PostgresToolAuthorityTestFileSystemDependencies,
  executableFile: string,
): StableIdentity {
  return stableIdentity(invokeSync(
    dependencies.lstat as (...args: never[]) => unknown,
    [executableFile],
  ));
}

function fstatExact(
  dependencies: PostgresToolAuthorityTestFileSystemDependencies,
  fileDescriptor: number,
): StableIdentity {
  return stableIdentity(invokeSync(
    dependencies.fstat as (...args: never[]) => unknown,
    [fileDescriptor],
  ));
}

function realpathExact(
  dependencies: PostgresToolAuthorityTestFileSystemDependencies,
  executableFile: string,
): string {
  const result = invokeSync(
    dependencies.realpath as (...args: never[]) => unknown,
    [executableFile],
  );
  if (typeof result !== "string") throw internalError("unsafe_executable");
  return result;
}

function hashDescriptor(
  dependencies: PostgresToolAuthorityTestFileSystemDependencies,
  fileDescriptor: number,
  expectedBytes: number,
): string {
  const hash = REFLECT_APPLY(CRYPTO_CREATE_HASH, CRYPTO_INTRINSIC, ["sha256"]);
  const capacity = REFLECT_APPLY(MATH_MIN, MATH_INTRINSIC, [
    READ_CHUNK_BYTES,
    expectedBytes,
  ]);
  let position = 0;
  while (position < expectedBytes) {
    const requested = REFLECT_APPLY(MATH_MIN, MATH_INTRINSIC, [
      capacity,
      expectedBytes - position,
    ]);
    const chunk = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_INTRINSIC, [requested]) as Buffer;
    try {
      let filled = 0;
      while (filled < requested) {
        const bytesRead = invokeSync(
          dependencies.read as (...args: never[]) => unknown,
          [
            fileDescriptor,
            chunk,
            filled,
            requested - filled,
            position + filled,
          ],
        );
        if (
          typeof bytesRead !== "number"
          || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_INTRINSIC, [bytesRead])
          || bytesRead < 1
          || bytesRead > requested - filled
        ) throw internalError("unsafe_executable");
        filled += bytesRead;
      }
      REFLECT_APPLY(HASH_UPDATE, hash, [chunk]);
      position += requested;
    } finally {
      REFLECT_APPLY(UINT8_ARRAY_FILL, chunk, [0]);
    }
  }
  const eof = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_INTRINSIC, [1]) as Buffer;
  try {
    const extra = invokeSync(
      dependencies.read as (...args: never[]) => unknown,
      [fileDescriptor, eof, 0, 1, expectedBytes],
    );
    if (extra !== 0) throw internalError("unsafe_executable");
  } finally {
    REFLECT_APPLY(UINT8_ARRAY_FILL, eof, [0]);
  }
  const digest = REFLECT_APPLY(HASH_DIGEST, hash, ["hex"]);
  if (typeof digest !== "string") throw internalError("unsafe_executable");
  return digest;
}

function closeDescriptor(
  dependencies: PostgresToolAuthorityTestFileSystemDependencies,
  fileDescriptor: number,
): boolean {
  let exact = true;
  try {
    REFLECT_APPLY(dependencies.close, undefined, [fileDescriptor]);
  } catch {
    // POSIX close failure is ambiguous: the descriptor may already have been
    // released and reused. Never retry the same numeric descriptor.
    exact = false;
  }
  return exact;
}

function assertHeldExact(input: {
  readonly dependencies: PostgresToolAuthorityTestFileSystemDependencies;
  readonly executableFile: string;
  readonly fileDescriptor: number;
  readonly baseline: StableIdentity;
  readonly effectiveUid: bigint;
  readonly expectedSha256: string;
}): void {
  const beforePath = lstatExact(input.dependencies, input.executableFile);
  const beforeDescriptor = fstatExact(input.dependencies, input.fileDescriptor);
  const canonicalBefore = realpathExact(input.dependencies, input.executableFile);
  assertExecutableIdentity(beforePath, input.effectiveUid);
  assertExecutableIdentity(beforeDescriptor, input.effectiveUid);
  if (
    canonicalBefore !== input.executableFile
    || !sameIdentity(input.baseline, beforePath)
    || !sameIdentity(input.baseline, beforeDescriptor)
  ) throw internalError("tool_drift");

  const digest = hashDescriptor(
    input.dependencies,
    input.fileDescriptor,
    exactSize(input.baseline.size),
  );
  const afterDescriptor = fstatExact(input.dependencies, input.fileDescriptor);
  const afterPath = lstatExact(input.dependencies, input.executableFile);
  const canonicalAfter = realpathExact(input.dependencies, input.executableFile);
  assertExecutableIdentity(afterDescriptor, input.effectiveUid);
  assertExecutableIdentity(afterPath, input.effectiveUid);
  if (
    digest !== input.expectedSha256
    || canonicalAfter !== input.executableFile
    || !sameIdentity(input.baseline, afterDescriptor)
    || !sameIdentity(input.baseline, afterPath)
  ) throw internalError("tool_drift");
}

function exactFileDescriptor(value: unknown): number {
  if (
    typeof value !== "number"
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_INTRINSIC, [value])
    || value <= 2
    || value > 0x7fff_ffff
  ) throw internalError("invalid_arguments");
  return value;
}

function fixedArray(values: string[]): readonly string[] {
  REFLECT_APPLY(OBJECT_DEFINE_PROPERTIES, OBJECT_INTRINSIC, [values, {
    [SYMBOL_ITERATOR]: {
      configurable: false,
      enumerable: false,
      value: ARRAY_VALUES,
      writable: false,
    },
    some: {
      configurable: false,
      enumerable: false,
      value: ARRAY_SOME,
      writable: false,
    },
  }]);
  return REFLECT_APPLY(OBJECT_FREEZE, OBJECT_INTRINSIC, [values]) as
    readonly string[];
}

function defineFrozenString(
  record: Record<string, string>,
  key: string,
  value: string,
): void {
  REFLECT_APPLY(OBJECT_DEFINE_PROPERTIES, OBJECT_INTRINSIC, [record, {
    [key]: {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    },
  }]);
}

const DUMP_ENVIRONMENT_KEYS = OBJECT_FREEZE([
  "PGHOST",
  "PGHOSTADDR",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGSSLMODE",
  "PGSSLROOTCERT",
  "PGSSLMINPROTOCOLVERSION",
  "PGSSLSNI",
  "PGGSSENCMODE",
  "PGCONNECT_TIMEOUT",
  "PGAPPNAME",
  "PGPASSFILE",
] as const);

const RESTORE_ENVIRONMENT_KEYS = OBJECT_FREEZE([
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGSSLMODE",
  "PGGSSENCMODE",
  "PGCONNECT_TIMEOUT",
  "PGAPPNAME",
] as const);

function closedEnvironment(
  value: unknown,
  requiredKeys: readonly string[],
): Readonly<Record<string, string>> {
  const descriptors = dataPropertyDescriptors(value);
  if (descriptors === null) throw internalError("invalid_arguments");
  const result = REFLECT_APPLY(OBJECT_CREATE, OBJECT_INTRINSIC, [null]) as
    Record<string, string>;
  defineFrozenString(result, "LC_ALL", "C");
  for (let index = 0; index < requiredKeys.length; index += 1) {
    const key = requiredKeys[index]!;
    const candidate = ownValue(descriptors, key);
    if (
      typeof candidate !== "string"
      || candidate.length < 1
      || stringIncludes(candidate, "\0")
      || REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_INTRINSIC, [candidate, "utf8"])
        > MAX_ENVIRONMENT_VALUE_BYTES
    ) throw internalError("invalid_arguments");
    defineFrozenString(result, key, candidate);
  }
  return REFLECT_APPLY(OBJECT_FREEZE, OBJECT_INTRINSIC, [result]);
}

function fixedEnvironment(): Readonly<Record<string, string>> {
  const result = REFLECT_APPLY(OBJECT_CREATE, OBJECT_INTRINSIC, [null]) as
    Record<string, string>;
  defineFrozenString(result, "LC_ALL", "C");
  return REFLECT_APPLY(OBJECT_FREEZE, OBJECT_INTRINSIC, [result]);
}

function exactDumpInput(value: unknown): {
  readonly snapshotIdentifier: string;
  readonly roleName: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly archiveOutputFileDescriptor: number;
} {
  const descriptors = ownDataDescriptors(value, [
    "snapshotIdentifier",
    "roleName",
    "environment",
    "archiveOutputFileDescriptor",
  ]);
  const snapshotIdentifier = ownValue(descriptors, "snapshotIdentifier");
  const roleName = ownValue(descriptors, "roleName");
  if (
    typeof snapshotIdentifier !== "string"
    || !regexpMatches(SNAPSHOT_IDENTIFIER_PATTERN, snapshotIdentifier)
    || typeof roleName !== "string"
    || !regexpMatches(BACKUP_ROLE_PATTERN, roleName)
  ) throw internalError("invalid_arguments");
  return freezeNullRecord({
    snapshotIdentifier,
    roleName,
    environment: closedEnvironment(
      ownValue(descriptors, "environment"),
      DUMP_ENVIRONMENT_KEYS,
    ),
    archiveOutputFileDescriptor: exactFileDescriptor(
      ownValue(descriptors, "archiveOutputFileDescriptor"),
    ),
  });
}

function exactRestoreInput(value: unknown): {
  readonly environment: Readonly<Record<string, string>>;
  readonly archiveInputFileDescriptor: number;
} {
  const descriptors = ownDataDescriptors(value, [
    "environment",
    "archiveInputFileDescriptor",
  ]);
  return freezeNullRecord({
    environment: closedEnvironment(
      ownValue(descriptors, "environment"),
      RESTORE_ENVIRONMENT_KEYS,
    ),
    archiveInputFileDescriptor: exactFileDescriptor(
      ownValue(descriptors, "archiveInputFileDescriptor"),
    ),
  });
}

function exactProcessResultFields(value: unknown): PostgresToolProcessResult {
  const descriptors = ownDataDescriptors(value, ["exitCode", "stdout", "stderr"]);
  const exitCode = ownValue(descriptors, "exitCode");
  const stdout = ownValue(descriptors, "stdout");
  const stderr = ownValue(descriptors, "stderr");
  if (
    typeof exitCode !== "number"
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_INTRINSIC, [exitCode])
    || exitCode < 0
    || exitCode > 255
    || typeof stdout !== "string"
    || typeof stderr !== "string"
    || REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_INTRINSIC, [stdout, "utf8"])
      > MAX_PROCESS_OUTPUT_BYTES
    || REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_INTRINSIC, [stderr, "utf8"])
      > MAX_PROCESS_OUTPUT_BYTES
  ) throw internalError("process_failed");
  return freezeNullRecord({ exitCode, stdout, stderr });
}

/**
 * Builds the only process-result carrier accepted by an authority runner. It is
 * synchronously snapshotted, null-prototype, frozen, and branded before it can
 * cross a Promise resolution boundary, so inherited `then` is never consulted.
 * The private brand proves only this then-safe in-process shape; it does not
 * prove native-process provenance or that the reviewed executable ran.
 */
export function createPostgresToolProcessResultCarrier(
  value: PostgresToolProcessResult,
): PostgresToolProcessResultCarrier {
  const exact = exactProcessResultFields(value);
  REFLECT_APPLY(WEAK_SET_ADD, PROCESS_RESULT_CARRIERS, [exact]);
  return exact as PostgresToolProcessResultCarrier;
}

async function exactProcessPromise(value: unknown): Promise<PostgresToolProcessResult> {
  if (
    typeof value !== "object"
    || value === null
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [value]) === true
    || !REFLECT_APPLY(UTIL_IS_PROMISE, UTIL_TYPES_INTRINSIC, [value])
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_INTRINSIC, [value])
      !== PROMISE_PROTOTYPE
  ) throw internalError("process_failed");
  const promiseKeys = REFLECT_APPLY(REFLECT_OWN_KEYS, REFLECT_INTRINSIC, [value]);
  const promiseConstructorDescriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_INTRINSIC,
    [PROMISE_PROTOTYPE, "constructor"],
  );
  if (
    !REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_INTRINSIC, [promiseKeys])
    || promiseKeys.length !== 0
    || promiseConstructorDescriptor === undefined
    || !hasOwn(promiseConstructorDescriptor, "value")
    || promiseConstructorDescriptor.value !== PROMISE_INTRINSIC
  ) throw internalError("process_failed");
  const result = await (value as Promise<unknown>);
  if (
    typeof result !== "object"
    || result === null
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [result]) === true
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_INTRINSIC, [result]) !== null
    || !REFLECT_APPLY(WEAK_SET_HAS, PROCESS_RESULT_CARRIERS, [result])
  ) throw internalError("process_failed");
  return exactProcessResultFields(result);
}

function invocation(input: {
  readonly operation: PostgresToolAuthorityProcessInvocation["operation"];
  readonly executableFile: string;
  readonly args: string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly stdinFileDescriptor?: number;
  readonly stdoutFileDescriptor?: number;
}): PostgresToolAuthorityProcessInvocation {
  const value: Record<PropertyKey, unknown> = {
    operation: input.operation,
    command: input.executableFile,
    args: fixedArray(input.args),
    env: input.env,
    timeoutMs: input.timeoutMs,
    maxStdoutBytes: input.maxStdoutBytes,
    maxStderrBytes: input.maxStderrBytes,
  };
  if (input.stdinFileDescriptor !== undefined) {
    value.stdinFileDescriptor = input.stdinFileDescriptor;
  }
  if (input.stdoutFileDescriptor !== undefined) {
    value.stdoutFileDescriptor = input.stdoutFileDescriptor;
  }
  return freezeNullRecord(value) as unknown as PostgresToolAuthorityProcessInvocation;
}

function directPromise<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return operation();
  } catch (error) {
    return REFLECT_APPLY(PROMISE_REJECT, PROMISE_INTRINSIC, [error]) as Promise<T>;
  }
}

function versionInvocation(executableFile: string): PostgresToolAuthorityProcessInvocation {
  return invocation({
    operation: "version",
    executableFile,
    args: ["--version"],
    env: fixedEnvironment(),
    timeoutMs: VERSION_TIMEOUT_MS,
    maxStdoutBytes: VERSION_OUTPUT_LIMIT,
    maxStderrBytes: VERSION_OUTPUT_LIMIT,
  });
}

function dumpInvocation(
  executableFile: string,
  input: ReturnType<typeof exactDumpInput>,
): PostgresToolAuthorityProcessInvocation {
  return invocation({
    operation: "dump",
    executableFile,
    args: [
      "--format=custom",
      `--snapshot=${input.snapshotIdentifier}`,
      `--role=${input.roleName}`,
      "--no-owner",
      "--no-acl",
      "--enable-row-security",
      "--strict-names",
      "--lock-wait-timeout=30s",
      "--no-password",
      "--schema=pintpath_app",
      "--schema=pintpath_ops",
    ],
    env: input.environment,
    timeoutMs: DUMP_TIMEOUT_MS,
    maxStdoutBytes: DUMP_OUTPUT_LIMIT,
    maxStderrBytes: DUMP_OUTPUT_LIMIT,
    stdoutFileDescriptor: input.archiveOutputFileDescriptor,
  });
}

function listInvocation(
  executableFile: string,
  archiveInputFileDescriptor: number,
  purpose: "list" | "restore",
): PostgresToolAuthorityProcessInvocation {
  return invocation({
    operation: "list",
    executableFile,
    args: ["--list", "--format=custom"],
    env: fixedEnvironment(),
    timeoutMs: LIST_TIMEOUT_MS,
    maxStdoutBytes: purpose === "list"
      ? BACKUP_LIST_OUTPUT_LIMIT
      : RESTORE_LIST_OUTPUT_LIMIT,
    maxStderrBytes: purpose === "list" ? DUMP_OUTPUT_LIMIT : RESTORE_OUTPUT_LIMIT,
    stdinFileDescriptor: archiveInputFileDescriptor,
  });
}

function restoreInvocation(
  executableFile: string,
  input: ReturnType<typeof exactRestoreInput>,
): PostgresToolAuthorityProcessInvocation {
  return invocation({
    operation: "restore",
    executableFile,
    args: [
      "--format=custom",
      "--dbname=",
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
      "--single-transaction",
      "--no-password",
    ],
    env: input.environment,
    timeoutMs: RESTORE_TIMEOUT_MS,
    maxStdoutBytes: RESTORE_OUTPUT_LIMIT,
    maxStderrBytes: RESTORE_OUTPUT_LIMIT,
    stdinFileDescriptor: input.archiveInputFileDescriptor,
  });
}

function versionAuthorizesOperation(
  result: PostgresToolProcessResult,
  purpose: PostgresToolAuthorityPurpose,
): boolean {
  if (result.exitCode !== 0 || result.stderr.length !== 0) return false;
  const line = REFLECT_APPLY(STRING_TRIM, result.stdout, []);
  const name = purpose === "dump" ? "pg_dump" : "pg_restore";
  const prefix = `${name} (PostgreSQL) `;
  if (
    typeof line !== "string"
    || (result.stdout !== line && result.stdout !== `${line}\n`)
    || stringIncludes(line, "\n")
    || stringIncludes(line, "\r")
    || !REFLECT_APPLY(STRING_STARTS_WITH, line, [prefix])
  ) return false;
  const version = REFLECT_APPLY(STRING_SLICE, line, [prefix.length]);
  return typeof version === "string"
    && regexpMatches(POSTGRES_17_VERSION_PATTERN, version);
}

function listAuthorizesRestore(result: PostgresToolProcessResult): boolean {
  return result.exitCode === 0
    && result.stderr.length === 0
    && result.stdout.length > 0
    && !stringIncludes(result.stdout, "\0");
}

/**
 * Opens one ordered, one-shot PostgreSQL tool purpose. The returned frozen,
 * null-prototype facade never publishes the executable pathname, retained raw
 * descriptor, arbitrary argv, environment builder, or generic process runner.
 * A production wrapper must pre-bind the exact reviewed process runner and must
 * not expose or forward either that runner or the test-only filesystem seam.
 */
export async function openPostgresToolAuthority(
  options: OpenPostgresToolAuthorityOptions & { readonly purpose: "dump" },
  runProcess: PostgresToolAuthorityProcessRunner,
  testFileSystemDependencies?: PostgresToolAuthorityTestFileSystemDependencies,
): Promise<PostgresDumpToolAuthority>;
export async function openPostgresToolAuthority(
  options: OpenPostgresToolAuthorityOptions & { readonly purpose: "list" },
  runProcess: PostgresToolAuthorityProcessRunner,
  testFileSystemDependencies?: PostgresToolAuthorityTestFileSystemDependencies,
): Promise<PostgresListToolAuthority>;
export async function openPostgresToolAuthority(
  options: OpenPostgresToolAuthorityOptions & { readonly purpose: "restore" },
  runProcess: PostgresToolAuthorityProcessRunner,
  testFileSystemDependencies?: PostgresToolAuthorityTestFileSystemDependencies,
): Promise<PostgresRestoreToolAuthority>;
export async function openPostgresToolAuthority(
  options: OpenPostgresToolAuthorityOptions,
  runProcess: PostgresToolAuthorityProcessRunner,
  testFileSystemDependencies?: PostgresToolAuthorityTestFileSystemDependencies,
): Promise<PostgresToolAuthority>;
export async function openPostgresToolAuthority(
  optionsInput: OpenPostgresToolAuthorityOptions,
  runProcessInput: PostgresToolAuthorityProcessRunner,
  testFileSystemDependenciesInput?:
  PostgresToolAuthorityTestFileSystemDependencies,
): Promise<PostgresToolAuthority> {
  const options = exactOptions(optionsInput);
  if (
    typeof runProcessInput !== "function"
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [runProcessInput]) === true
  ) throw internalError("invalid_arguments");
  const runProcess = runProcessInput;
  const dependencies = testFileSystemDependenciesInput === undefined
    ? CAPTURED_NATIVE_DEPENDENCIES
    : exactTestDependencies(testFileSystemDependenciesInput);
  const executableFile = exactExecutablePath(options.executableFile, options.purpose);
  if (
    typeof O_NOFOLLOW_EXACT !== "number"
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_INTRINSIC, [O_NOFOLLOW_EXACT])
    || O_NOFOLLOW_EXACT <= 0
    || typeof O_NONBLOCK_EXACT !== "number"
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_INTRINSIC, [O_NONBLOCK_EXACT])
    || O_NONBLOCK_EXACT <= 0
    || typeof O_RDONLY_EXACT !== "number"
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_INTRINSIC, [O_RDONLY_EXACT])
    || O_RDONLY_EXACT < 0
  ) throw internalError("unsafe_executable");

  let fileDescriptor: number | null = null;
  let baseline: StableIdentity | null = null;
  let effectiveUid: bigint | null = null;
  let initialFailure: FailureState = NO_FAILURE;
  try {
    effectiveUid = safeEffectiveUid(invokeSync(
      dependencies.effectiveUid as (...args: never[]) => unknown,
      [],
    ));
    const opened = invokeSync(
      dependencies.open as (...args: never[]) => unknown,
      [
        executableFile,
        O_RDONLY_EXACT | O_NOFOLLOW_EXACT | O_NONBLOCK_EXACT,
      ],
    );
    if (
      typeof opened !== "number"
      || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_INTRINSIC, [opened])
      || opened < 0
      || opened > 0x7fff_ffff
    ) throw internalError("unsafe_executable");
    fileDescriptor = opened;
    if (fileDescriptor <= 2) throw internalError("unsafe_executable");
    const openedIdentity = fstatExact(dependencies, fileDescriptor);
    assertExecutableIdentity(openedIdentity, effectiveUid);
    const beforePath = lstatExact(dependencies, executableFile);
    const middleDescriptor = fstatExact(dependencies, fileDescriptor);
    const afterPath = lstatExact(dependencies, executableFile);
    if (realpathExact(dependencies, executableFile) !== executableFile) {
      throw internalError("unsafe_executable");
    }
    assertExecutableIdentity(beforePath, effectiveUid);
    assertExecutableIdentity(middleDescriptor, effectiveUid);
    assertExecutableIdentity(afterPath, effectiveUid);
    if (
      !sameIdentity(openedIdentity, beforePath)
      || !sameIdentity(openedIdentity, middleDescriptor)
      || !sameIdentity(openedIdentity, afterPath)
    ) {
      throw internalError("unsafe_executable");
    }
    baseline = openedIdentity;
    const digest = hashDescriptor(
      dependencies,
      fileDescriptor,
      exactSize(openedIdentity.size),
    );
    const hashedDescriptor = fstatExact(dependencies, fileDescriptor);
    const hashedPath = lstatExact(dependencies, executableFile);
    if (
      digest !== options.expectedSha256
      || !sameIdentity(openedIdentity, hashedDescriptor)
      || !sameIdentity(openedIdentity, hashedPath)
      || realpathExact(dependencies, executableFile) !== executableFile
    ) {
      throw internalError(
        digest === options.expectedSha256
          ? "unsafe_executable"
          : "sha256_mismatch",
      );
    }
  } catch (error) {
    initialFailure = capture(error);
  }

  if (initialFailure.caught) {
    if (fileDescriptor !== null && !closeDescriptor(dependencies, fileDescriptor)) {
      throw internalError("cleanup_failed");
    }
    normalizeOpenFailure(initialFailure.error);
  }
  if (fileDescriptor === null || baseline === null || effectiveUid === null) {
    throw internalError("unsafe_executable");
  }

  const retainedDescriptor = fileDescriptor;
  const retainedBaseline = baseline;
  const retainedUid = effectiveUid;
  let state: AuthorityState = "idle";
  let phase: SequencePhase = "version";
  // This is a stable held-descriptor metadata join, not a content digest. The
  // production restore caller must retain its separately reviewed digest-bound
  // archive guard across list and restore; this layer prevents substituting a
  // different descriptor/inode or an ordinarily mutated held inode.
  let listedArchiveIdentity: StableIdentity | null = null;
  let listedArchiveDescriptor: number | null = null;
  let closePromise: Promise<void> | null = null;

  const assertExactInternal = (): void => {
    try {
      assertHeldExact({
        dependencies,
        executableFile,
        fileDescriptor: retainedDescriptor,
        baseline: retainedBaseline,
        effectiveUid: retainedUid,
        expectedSha256: options.expectedSha256,
      });
    } catch {
      throw internalError("tool_drift");
    }
  };

  const execute = async (
    expectedPhase: SequencePhase,
    nextPhase: SequencePhase,
    operationInvocation: PostgresToolAuthorityProcessInvocation,
    authorizesNextPhase: (
      result: PostgresToolProcessResult,
    ) => boolean = () => true,
    additionalPreflight?: () => void,
    additionalPostflight?: () => void,
  ): Promise<PostgresToolProcessResult> => {
    if (state !== "idle" || phase !== expectedPhase) {
      throw internalError("invalid_arguments");
    }
    state = "operating";
    let operationFailure: FailureState = NO_FAILURE;
    let result: PostgresToolProcessResult | null = null;
    try {
      assertExactInternal();
      additionalPreflight?.();
    } catch (error) {
      state = "failed";
      throw internalError(
        capturedErrorCode(error) === "archive_drift"
          ? "archive_drift"
          : "tool_drift",
      );
    }
    try {
      let pending: unknown;
      try {
        pending = REFLECT_APPLY(runProcess, undefined, [operationInvocation]);
      } catch (error) {
        operationFailure = capture(error);
      }
      if (!operationFailure.caught) {
        try {
          result = await exactProcessPromise(pending);
        } catch (error) {
          operationFailure = capture(error);
        }
      }
    } finally {
      let archivePostflightFailed = false;
      try {
        additionalPostflight?.();
      } catch {
        archivePostflightFailed = true;
      }
      let toolPostflightFailed = false;
      try {
        assertExactInternal();
      } catch {
        toolPostflightFailed = true;
      }
      if (archivePostflightFailed || toolPostflightFailed) {
        state = "failed";
        throw internalError(
          archivePostflightFailed ? "archive_drift" : "tool_drift",
        );
      }
    }
    if (operationFailure.caught || result === null) {
      state = "failed";
      throw internalError("process_failed");
    }
    let authorized = false;
    try {
      authorized = authorizesNextPhase(result);
    } catch {
      authorized = false;
    }
    if (!authorized) {
      phase = "spent";
      state = "failed";
      throw internalError("process_failed");
    }
    phase = nextPhase;
    state = "idle";
    return result;
  };

  const version = OBJECT_FREEZE((): Promise<PostgresToolProcessResult> =>
    directPromise(() => execute(
      "version",
      "operation",
      versionInvocation(executableFile),
      (result) => versionAuthorizesOperation(result, options.purpose),
    )));
  const assertExact = OBJECT_FREEZE(async (): Promise<void> => {
    if (state !== "idle") throw internalError("invalid_arguments");
    state = "operating";
    try {
      assertExactInternal();
      state = "idle";
    } catch {
      state = "failed";
      throw internalError("tool_drift");
    }
  });
  const close = OBJECT_FREEZE((): Promise<void> => {
    if (closePromise !== null) return closePromise;
    if (state === "operating" || state === "closing") {
      return REFLECT_APPLY(PROMISE_REJECT, PROMISE_INTRINSIC, [
        internalError("cleanup_failed"),
      ]);
    }
    state = "closing";
    closePromise = (async (): Promise<void> => {
      const exact = closeDescriptor(dependencies, retainedDescriptor);
      state = exact ? "closed" : "failed";
      if (!exact) throw internalError("cleanup_failed");
    })();
    return closePromise;
  });

  if (options.purpose === "dump") {
    const dump = OBJECT_FREEZE((
      input: PostgresDumpOperationInput,
    ): Promise<PostgresToolProcessResult> => directPromise(() => execute(
      "operation",
      "spent",
      dumpInvocation(executableFile, exactDumpInput(input)),
    )));
    return freezeNullRecord({ version, dump, assertExact, close });
  }

  const listNextPhase: SequencePhase = options.purpose === "restore"
    ? "restore"
    : "spent";
  const list = OBJECT_FREEZE(async (
    archiveInputFileDescriptor: number,
  ): Promise<PostgresToolProcessResult> => {
    const descriptor = exactFileDescriptor(archiveInputFileDescriptor);
    let candidate: StableIdentity | null = null;
    const observed = await execute(
      "operation",
      listNextPhase,
      listInvocation(
        executableFile,
        descriptor,
        options.purpose === "restore" ? "restore" : "list",
      ),
      options.purpose === "restore" ? listAuthorizesRestore : () => true,
      () => {
        candidate = archiveIdentity(dependencies, descriptor, retainedUid);
      },
      () => {
        const after = archiveIdentity(dependencies, descriptor, retainedUid);
        if (candidate === null || !sameIdentity(candidate, after)) {
          throw internalError("archive_drift");
        }
      },
    );
    if (options.purpose === "restore") {
      if (candidate === null) throw internalError("archive_drift");
      listedArchiveIdentity = candidate;
      listedArchiveDescriptor = descriptor;
    }
    return observed;
  });
  if (options.purpose === "list") {
    return freezeNullRecord({ version, list, assertExact, close });
  }
  const restore = OBJECT_FREEZE((
    input: PostgresRestoreOperationInput,
  ): Promise<PostgresToolProcessResult> => directPromise(() => {
    const exact = exactRestoreInput(input);
    // The restore sequence must receive a separately opened descriptor at
    // offset zero. A distinct number is a necessary guard, but cannot prove the
    // caller did not use dup(2); the production wrapper must open a new OFD.
    if (
      listedArchiveIdentity === null
      || listedArchiveDescriptor === null
      || exact.archiveInputFileDescriptor === listedArchiveDescriptor
    ) throw internalError("archive_drift");
    return execute(
      "restore",
      "spent",
      restoreInvocation(executableFile, exact),
      () => true,
      () => {
        const before = archiveIdentity(
          dependencies,
          exact.archiveInputFileDescriptor,
          retainedUid,
        );
        if (!sameIdentity(listedArchiveIdentity!, before)) {
          throw internalError("archive_drift");
        }
      },
      () => {
        const after = archiveIdentity(
          dependencies,
          exact.archiveInputFileDescriptor,
          retainedUid,
        );
        if (!sameIdentity(listedArchiveIdentity!, after)) {
          throw internalError("archive_drift");
        }
      },
    );
  }));
  return freezeNullRecord({ version, list, restore, assertExact, close });
}
