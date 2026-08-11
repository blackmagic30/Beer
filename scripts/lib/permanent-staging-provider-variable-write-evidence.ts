import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder, TextEncoder, types as utilTypes } from "node:util";

import type { PermanentStagingProviderVariableName } from
  "./permanent-staging-provider-variable-write-executor.js";

interface PermanentStagingProviderVariableWriteEvidenceLeafPair {
  readonly intent: string;
  readonly terminalEvidence: string;
}

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES =
  Object.freeze({
    GOOGLE_MAPS_API_KEY: Object.freeze({
      intent:
        "pintpath-permanent-staging-provider-variable-google-maps-api-key-intent.json",
      terminalEvidence:
        "pintpath-permanent-staging-provider-variable-google-maps-api-key-terminal-evidence.json",
    }),
    GOOGLE_MAPS_MAP_ID: Object.freeze({
      intent:
        "pintpath-permanent-staging-provider-variable-google-maps-map-id-intent.json",
      terminalEvidence:
        "pintpath-permanent-staging-provider-variable-google-maps-map-id-terminal-evidence.json",
    }),
    GOOGLE_PLACES_API_KEY: Object.freeze({
      intent:
        "pintpath-permanent-staging-provider-variable-google-places-api-key-intent.json",
      terminalEvidence:
        "pintpath-permanent-staging-provider-variable-google-places-api-key-terminal-evidence.json",
    }),
    OPENAI_API_KEY: Object.freeze({ // security-scan allow: nonsecret fixed variable-name key
      intent:
        "pintpath-permanent-staging-provider-variable-openai-api-key-intent.json",
      terminalEvidence:
        "pintpath-permanent-staging-provider-variable-openai-api-key-terminal-evidence.json",
    }),
  } as const satisfies Readonly<Record<
    PermanentStagingProviderVariableName,
    PermanentStagingProviderVariableWriteEvidenceLeafPair
  >>);

const FIXED_EVIDENCE_LEAVES = Object.freeze([
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES
    .GOOGLE_MAPS_API_KEY.intent,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES
    .GOOGLE_MAPS_API_KEY.terminalEvidence,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES
    .GOOGLE_MAPS_MAP_ID.intent,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES
    .GOOGLE_MAPS_MAP_ID.terminalEvidence,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES
    .GOOGLE_PLACES_API_KEY.intent,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES
    .GOOGLE_PLACES_API_KEY.terminalEvidence,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES
    .OPENAI_API_KEY.intent,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES
    .OPENAI_API_KEY.terminalEvidence,
] as const);

export type PermanentStagingProviderVariableWriteEvidenceLeaf =
  (typeof FIXED_EVIDENCE_LEAVES)[number];

export interface PermanentStagingProviderVariableWriteDurableArtifactEvidence {
  readonly publication: "created-durable" | "existing-exact";
  readonly sha256: string;
  readonly canonicalPathExact: true;
  readonly parentMode0700: true;
  readonly fileMode0600: true;
  readonly currentUid: true;
  readonly regularFile: true;
  readonly nonSymlink: true;
  readonly nlinkOne: true;
  readonly exclusiveCreate: boolean;
  readonly fileFsync: true;
  readonly parentFsync: true;
  readonly identityHeld: true;
  readonly readbackExact: true;
}

export type PermanentStagingProviderVariableWriteEvidenceFailureCode =
  | "evidence_invalid"
  | "cleanup_failed";

export class PermanentStagingProviderVariableWriteEvidenceError extends Error {
  readonly code!: PermanentStagingProviderVariableWriteEvidenceFailureCode;

  constructor(code: PermanentStagingProviderVariableWriteEvidenceFailureCode) {
    super(code);
    REFLECT_APPLY(OBJECT_DEFINE_PROPERTIES, Object, [this, {
      name: {
        configurable: true,
        enumerable: true,
        value: "PermanentStagingProviderVariableWriteEvidenceError",
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

const MAX_CANONICAL_CONTENT_BYTES = 64 * 1_024;
const MAX_PARENT_PATH_BYTES = 4_096;
const RANDOM_TEMPORARY_BYTES = 16;
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 131_072;
const ALLOWED_LEAVES = new Set<string>(FIXED_EVIDENCE_LEAVES);
const ARRAY_BUFFER_EXACT = ArrayBuffer;
const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const BIGINT_EXACT = BigInt;
const ABORT_SIGNAL_PROTOTYPE = AbortSignal.prototype;
const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  ABORT_SIGNAL_PROTOTYPE,
  "aborted",
)?.get;
const BUFFER_ALLOC = Buffer.alloc;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BUFFER_EQUALS = Buffer.prototype.equals;
const BUFFER_IS_BUFFER = Buffer.isBuffer;
const BUFFER_PROTOTYPE = Buffer.prototype;
const BUFFER_EXACT = Buffer;
const CRYPTO_CREATE_HASH = crypto.createHash;
const CRYPTO_RANDOM_BYTES = crypto.randomBytes;
const FS_PROMISES = fs.promises;
const FS_LSTAT = FS_PROMISES.lstat;
const FS_LINK = FS_PROMISES.link;
const FS_OPEN = FS_PROMISES.open;
const FS_REALPATH = FS_PROMISES.realpath;
const FS_UNLINK = FS_PROMISES.unlink;
const FS_O_CREAT = fs.constants.O_CREAT;
const FS_O_EXCL = fs.constants.O_EXCL;
const FS_O_RDONLY = fs.constants.O_RDONLY;
const FS_O_WRONLY = fs.constants.O_WRONLY;
const HASH_PROTOTYPE = Object.getPrototypeOf(CRYPTO_CREATE_HASH("sha256")) as
  object;
const HASH_UPDATE = Object.getOwnPropertyDescriptor(
  HASH_PROTOTYPE,
  "update",
)?.value;
const HASH_DIGEST = Object.getOwnPropertyDescriptor(
  HASH_PROTOTYPE,
  "digest",
)?.value;
const JSON_PARSE = JSON.parse;
const JSON_STRINGIFY = JSON.stringify;
const JSON_EXACT = JSON;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const NUMBER_EXACT = Number;
const OBJECT_DEFINE_PROPERTIES = Object.defineProperties;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_PROTOTYPE = Object.prototype;
const PROCESS_GETEUID = process.geteuid;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_EXEC = RegExp.prototype.exec;
const SET_HAS = Set.prototype.has;
const STRING_CHAR_AT = String.prototype.charAt;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_EXACT = String;
const STRING_INCLUDES = String.prototype.includes;
const TEXT_DECODER_DECODE = TextDecoder.prototype.decode;
const TEXT_ENCODER_EXACT = TextEncoder;
const TEXT_ENCODER_ENCODE = TextEncoder.prototype.encode;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as
  object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;
const UTIL_IS_PROMISE = utilTypes.isPromise;
const UTIL_IS_PROXY = utilTypes.isProxy;
const WEAK_MAP_EXACT = WeakMap;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const EVIDENCE_ERROR_AUTHORITIES = new WEAK_MAP_EXACT<
  object,
  PermanentStagingProviderVariableWriteEvidenceFailureCode
>();
const LINE_BREAK_PATTERN = /[\r\n]/;
const STAT_MODE_MASK = BIGINT_EXACT(fs.constants.S_IFMT);
const STAT_MODE_DIRECTORY = BIGINT_EXACT(fs.constants.S_IFDIR);
const STAT_MODE_REGULAR = BIGINT_EXACT(fs.constants.S_IFREG);
const STAT_MODE_SYMLINK = BIGINT_EXACT(fs.constants.S_IFLNK);
const PATH_BASENAME = path.basename;
const PATH_DIRNAME = path.dirname;
const PATH_IS_ABSOLUTE = path.isAbsolute;
const PATH_JOIN = path.join;
const PATH_NORMALIZE = path.normalize;
const PATH_PARSE = path.parse;
const PATH_RESOLVE = path.resolve;
const LOWERCASE_HEX = "0123456789abcdef";

// This layer is deliberately schema-neutral: it receives only secret-free
// intent or terminal-evidence JSON from the kernel and never a provider value.
// Its authority is limited to canonical bytes, fixed leaves, and durability.

type FileHandle = fs.promises.FileHandle;

export interface PermanentStagingProviderVariableWriteEvidenceDependencies {
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

const DEFAULT_DEPENDENCIES: PermanentStagingProviderVariableWriteEvidenceDependencies = {
  open: (filename, flags, mode) => mode === undefined
    ? REFLECT_APPLY(FS_OPEN, FS_PROMISES, [filename, flags])
    : REFLECT_APPLY(FS_OPEN, FS_PROMISES, [filename, flags, mode]),
  lstat: (filename) => REFLECT_APPLY(FS_LSTAT, FS_PROMISES, [
    filename,
    { bigint: true },
  ]) as Promise<fs.BigIntStats>,
  realpath: (filename) => REFLECT_APPLY(
    FS_REALPATH,
    FS_PROMISES,
    [filename],
  ) as Promise<string>,
  link: (existingPath, newPath) => REFLECT_APPLY(FS_LINK, FS_PROMISES, [
    existingPath,
    newPath,
  ]),
  unlink: (filename) => REFLECT_APPLY(FS_UNLINK, FS_PROMISES, [filename]),
  randomBytes: (size) => REFLECT_APPLY(CRYPTO_RANDOM_BYTES, crypto, [size]),
  effectiveUid: () => {
    if (typeof PROCESS_GETEUID !== "function") throw invalid();
    return REFLECT_APPLY(PROCESS_GETEUID, process, []);
  },
  syncHandle: async () => {
    throw invalid();
  },
  closeHandle: async () => {
    throw invalid();
  },
};

const DEPENDENCY_KEYS = OBJECT_FREEZE([
  "open",
  "lstat",
  "realpath",
  "link",
  "unlink",
  "randomBytes",
  "effectiveUid",
  "syncHandle",
  "closeHandle",
] as const);

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

interface StableStat {
  readonly prototype: object;
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

interface FileHandleIntrinsics {
  readonly prototype: object;
  readonly closeByHandle: WeakMap<object, Function>;
  readonly stat: (options?: { bigint?: boolean }) => Promise<fs.BigIntStats>;
  readonly read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ readonly bytesRead: number }>;
  readonly write: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ readonly bytesWritten: number }>;
  readonly chmod: (mode: number) => Promise<void>;
  readonly sync: () => Promise<void>;
}

function invalid(): PermanentStagingProviderVariableWriteEvidenceError {
  return internalError("evidence_invalid");
}

function cleanupFailed(): PermanentStagingProviderVariableWriteEvidenceError {
  return internalError("cleanup_failed");
}

function internalError(
  code: PermanentStagingProviderVariableWriteEvidenceFailureCode,
): PermanentStagingProviderVariableWriteEvidenceError {
  const error = new PermanentStagingProviderVariableWriteEvidenceError(code);
  REFLECT_APPLY(WEAK_MAP_SET, EVIDENCE_ERROR_AUTHORITIES, [error, code]);
  return error;
}

function fixedErrorCode(
  error: unknown,
): PermanentStagingProviderVariableWriteEvidenceFailureCode | null {
  if (typeof error !== "object" || error === null) return null;
  const code = REFLECT_APPLY(WEAK_MAP_GET, EVIDENCE_ERROR_AUTHORITIES, [error]);
  return code === "evidence_invalid" || code === "cleanup_failed"
    ? code
    : null;
}

function normalizeFailure(
  error: unknown,
): PermanentStagingProviderVariableWriteEvidenceError {
  return fixedErrorCode(error) === "cleanup_failed"
    ? cleanupFailed()
    : invalid();
}

function isProxy(value: unknown): boolean {
  if (
    !(typeof value === "object" && value !== null)
    && typeof value !== "function"
  ) return false;
  return REFLECT_APPLY(UTIL_IS_PROXY, utilTypes, [value]) === true;
}

function nativePromise<T>(value: unknown): Promise<T> {
  if (REFLECT_APPLY(UTIL_IS_PROMISE, utilTypes, [value]) !== true) {
    throw invalid();
  }
  return value as Promise<T>;
}

function regexpTest(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY(REGEXP_EXEC, pattern, [value]) !== null;
}

function dataDescriptorValue(
  value: object,
  key: PropertyKey,
): unknown {
  const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
  if (
    descriptor === undefined
    || !OBJECT_HAS_OWN(descriptor, "value")
  ) throw invalid();
  return descriptor.value;
}

function captureDependencies(
  overrides: Partial<PermanentStagingProviderVariableWriteEvidenceDependencies>,
): {
  readonly dependencies: PermanentStagingProviderVariableWriteEvidenceDependencies;
  readonly syncOverridden: boolean;
  readonly closeOverridden: boolean;
} {
  const prototype = typeof overrides === "object" && overrides !== null
    && !isProxy(overrides)
    ? OBJECT_GET_PROTOTYPE_OF(overrides)
    : undefined;
  if (
    typeof overrides !== "object"
    || overrides === null
    || isProxy(overrides)
    || prototype !== OBJECT_PROTOTYPE && prototype !== null
  ) throw invalid();
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(overrides);
  const keys = REFLECT_OWN_KEYS(descriptors);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    let allowed = false;
    for (
      let allowedIndex = 0;
      allowedIndex < DEPENDENCY_KEYS.length;
      allowedIndex += 1
    ) {
      if (key === DEPENDENCY_KEYS[allowedIndex]) {
        allowed = true;
        break;
      }
    }
    if (!allowed || typeof key !== "string") throw invalid();
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !OBJECT_HAS_OWN(descriptor, "value")
      || descriptor.enumerable !== true
      || typeof descriptor.value !== "function"
      || isProxy(descriptor.value)
    ) throw invalid();
  }
  const read = <K extends keyof PermanentStagingProviderVariableWriteEvidenceDependencies>(
    key: K,
  ): PermanentStagingProviderVariableWriteEvidenceDependencies[K] => {
    const descriptor = descriptors[key];
    return (descriptor === undefined
      ? DEFAULT_DEPENDENCIES[key]
      : descriptor.value) as
      PermanentStagingProviderVariableWriteEvidenceDependencies[K];
  };
  const dependencies = OBJECT_FREEZE({
    open: read("open"),
    lstat: read("lstat"),
    realpath: read("realpath"),
    link: read("link"),
    unlink: read("unlink"),
    randomBytes: read("randomBytes"),
    effectiveUid: read("effectiveUid"),
    syncHandle: read("syncHandle"),
    closeHandle: read("closeHandle"),
  });
  return OBJECT_FREEZE({
    dependencies,
    syncOverridden: descriptors.syncHandle !== undefined,
    closeOverridden: descriptors.closeHandle !== undefined,
  });
}

function captureFileHandleIntrinsics(handle: unknown): FileHandleIntrinsics {
  if (typeof handle !== "object" || handle === null || isProxy(handle)) {
    throw invalid();
  }
  const prototype = OBJECT_GET_PROTOTYPE_OF(handle);
  if (typeof prototype !== "object" || prototype === null) throw invalid();
  const method = (name: string): Function => {
    const value = dataDescriptorValue(prototype, name);
    if (typeof value !== "function" || isProxy(value)) throw invalid();
    return value;
  };
  const close = dataDescriptorValue(handle, "close");
  if (typeof close !== "function" || isProxy(close)) throw invalid();
  const closeByHandle = new WEAK_MAP_EXACT<object, Function>();
  REFLECT_APPLY(WEAK_MAP_SET, closeByHandle, [handle, close]);
  return OBJECT_FREEZE({
    prototype,
    closeByHandle,
    stat: method("stat"),
    read: method("read"),
    write: method("write"),
    chmod: method("chmod"),
    sync: method("sync"),
  }) as FileHandleIntrinsics;
}

function registerFileHandle(
  handle: unknown,
  intrinsics: FileHandleIntrinsics,
): asserts handle is FileHandle {
  if (
    typeof handle !== "object"
    || handle === null
    || isProxy(handle)
    || OBJECT_GET_PROTOTYPE_OF(handle) !== intrinsics.prototype
  ) throw invalid();
  const close = dataDescriptorValue(handle, "close");
  if (typeof close !== "function" || isProxy(close)) throw invalid();
  REFLECT_APPLY(WEAK_MAP_SET, intrinsics.closeByHandle, [handle, close]);
}

function assertFileHandleExact(
  handle: unknown,
  intrinsics: FileHandleIntrinsics,
): asserts handle is FileHandle {
  if (
    typeof handle !== "object"
    || handle === null
    || isProxy(handle)
    || OBJECT_GET_PROTOTYPE_OF(handle) !== intrinsics.prototype
    || typeof REFLECT_APPLY(
      WEAK_MAP_GET,
      intrinsics.closeByHandle,
      [handle],
    ) !== "function"
  ) throw invalid();
}

async function closeHandleExact(
  handle: FileHandle,
  intrinsics: FileHandleIntrinsics,
): Promise<void> {
  assertFileHandleExact(handle, intrinsics);
  const close = REFLECT_APPLY(
    WEAK_MAP_GET,
    intrinsics.closeByHandle,
    [handle],
  );
  if (typeof close !== "function") throw cleanupFailed();
  await nativePromise(REFLECT_APPLY(close, handle, []));
}

function snapshotStat(
  value: unknown,
  expectedPrototype?: object,
): StableStat {
  if (typeof value !== "object" || value === null || isProxy(value)) {
    throw invalid();
  }
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  if (
    typeof prototype !== "object"
    || prototype === null
    || expectedPrototype !== undefined && prototype !== expectedPrototype
  ) throw invalid();
  const bigint = (key: string): bigint => {
    const candidate = dataDescriptorValue(value, key);
    if (typeof candidate !== "bigint") throw invalid();
    return candidate;
  };
  return OBJECT_FREEZE({
    prototype,
    dev: bigint("dev"),
    ino: bigint("ino"),
    uid: bigint("uid"),
    gid: bigint("gid"),
    mode: bigint("mode"),
    nlink: bigint("nlink"),
    size: bigint("size"),
    mtimeNs: bigint("mtimeNs"),
    ctimeNs: bigint("ctimeNs"),
  });
}

async function handleStat(
  handle: FileHandle,
  intrinsics: FileHandleIntrinsics,
  statPrototype: object,
): Promise<StableStat> {
  assertFileHandleExact(handle, intrinsics);
  const result = REFLECT_APPLY(intrinsics.stat, handle, [{ bigint: true }]);
  return snapshotStat(await nativePromise(result), statPrototype);
}

function exactIoCount(
  value: unknown,
  key: "bytesRead" | "bytesWritten",
  maximum: number,
): number {
  if (typeof value !== "object" || value === null || isProxy(value)) {
    throw invalid();
  }
  const count = dataDescriptorValue(value, key);
  if (
    !NUMBER_IS_SAFE_INTEGER(count)
    || (count as number) < 0
    || (count as number) > maximum
  ) throw invalid();
  return count as number;
}

function viewByteLength(value: Uint8Array): number {
  if (typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function") throw invalid();
  const length = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
  if (!NUMBER_IS_SAFE_INTEGER(length) || (length as number) < 0) throw invalid();
  return length as number;
}

function bufferLength(value: Buffer): number {
  return viewByteLength(value);
}

function wipeBytes(value: Uint8Array): void {
  try {
    REFLECT_APPLY(UINT8_ARRAY_FILL, value, [0]);
  } catch {
    throw cleanupFailed();
  }
}

function wipeBuffer(value: Buffer): void {
  wipeBytes(value);
}

function requiredOpenFlag(value: unknown): number {
  if (!NUMBER_IS_SAFE_INTEGER(value) || (value as number) <= 0) throw invalid();
  return value as number;
}

const O_NOFOLLOW_EXACT = requiredOpenFlag(fs.constants.O_NOFOLLOW);
const O_DIRECTORY_EXACT = requiredOpenFlag(fs.constants.O_DIRECTORY);

function exactLowercaseHex32(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 32) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index]) as number;
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) {
      return false;
    }
  }
  return true;
}

function exactRandomHex(
  dependencies: PermanentStagingProviderVariableWriteEvidenceDependencies,
): string {
  let candidate: unknown;
  let hex: string | null = null;
  let caught = false;
  let failure: unknown;
  let wipeRequired = false;
  try {
    candidate = dependencies.randomBytes(RANDOM_TEMPORARY_BYTES);
    const isView = REFLECT_APPLY(ARRAY_BUFFER_IS_VIEW, ARRAY_BUFFER_EXACT, [
      candidate,
    ]) as boolean;
    const isBuffer = REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_EXACT, [candidate]) as
      boolean;
    if (!isView || !isBuffer) throw invalid();
    if (OBJECT_GET_PROTOTYPE_OF(candidate) !== BUFFER_PROTOTYPE) throw invalid();
    wipeRequired = true;
    if (typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function") throw invalid();
    const length = REFLECT_APPLY(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      candidate,
      [],
    ) as number;
    if (length !== RANDOM_TEMPORARY_BYTES) throw invalid();
    const random = candidate as Buffer;
    let rendered = "";
    for (let index = 0; index < RANDOM_TEMPORARY_BYTES; index += 1) {
      const byte = random[index];
      if (
        !NUMBER_IS_SAFE_INTEGER(byte)
        || (byte as number) < 0
        || (byte as number) > 255
      ) throw invalid();
      rendered += REFLECT_APPLY(
        STRING_CHAR_AT,
        LOWERCASE_HEX,
        [(byte as number) >>> 4],
      ) as string;
      rendered += REFLECT_APPLY(
        STRING_CHAR_AT,
        LOWERCASE_HEX,
        [(byte as number) & 0x0f],
      ) as string;
    }
    if (!exactLowercaseHex32(rendered)) throw invalid();
    hex = rendered;
  } catch (error) {
    caught = true;
    failure = error;
  }
  if (wipeRequired) {
    try {
      wipeBuffer(candidate as Buffer);
    } catch {
      throw cleanupFailed();
    }
  }
  if (caught) {
    throw normalizeFailure(failure);
  }
  if (hex === null) throw invalid();
  return hex;
}

function checkSignal(signal: AbortSignal): void {
  if (
    typeof signal !== "object"
    || signal === null
    || isProxy(signal)
    || OBJECT_GET_PROTOTYPE_OF(signal) !== ABORT_SIGNAL_PROTOTYPE
    || typeof ABORT_SIGNAL_ABORTED_GETTER !== "function"
    || REFLECT_APPLY(ABORT_SIGNAL_ABORTED_GETTER, signal, []) !== false
  ) throw invalid();
}

function errnoIs(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || isProxy(error)) return false;
  try {
    return dataDescriptorValue(error, "code") === code;
  } catch {
    return false;
  }
}

function directoryIdentity(stat: StableStat): DirectoryIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
  };
}

function fileIdentity(stat: StableStat): FileIdentity {
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

function sameStableFile(left: StableStat, right: StableStat): boolean {
  return sameFileIdentity(fileIdentity(left), fileIdentity(right))
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertPrivateParent(stat: StableStat, uid: bigint): void {
  if (
    (stat.mode & STAT_MODE_MASK) !== STAT_MODE_DIRECTORY
    || (stat.mode & STAT_MODE_MASK) === STAT_MODE_SYMLINK
    || stat.uid !== uid
    || stat.nlink < 1n
    || (stat.mode & 0o7777n) !== 0o700n
  ) throw invalid();
}

function assertPrivateFile(
  stat: StableStat,
  uid: bigint,
  expectedSize: number,
  expectedLinks: bigint,
): void {
  if (
    (stat.mode & STAT_MODE_MASK) !== STAT_MODE_REGULAR
    || (stat.mode & STAT_MODE_MASK) === STAT_MODE_SYMLINK
    || stat.uid !== uid
    || stat.nlink !== expectedLinks
    || (stat.mode & 0o7777n) !== 0o600n
    || stat.size !== BIGINT_EXACT(expectedSize)
  ) throw invalid();
}

function exactParentPath(value: unknown): string {
  if (
    typeof value !== "string"
    || !PATH_IS_ABSOLUTE(value)
    || PATH_NORMALIZE(value) !== value
    || PATH_RESOLVE(value) !== value
    || value === PATH_PARSE(value).root
    || REFLECT_APPLY(STRING_INCLUDES, value, ["\0"]) === true
    || regexpTest(LINE_BREAK_PATTERN, value)
    || REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_EXACT, [value, "utf8"])
      > MAX_PARENT_PATH_BYTES
  ) throw invalid();
  return value;
}

function exactLeaf(value: string): PermanentStagingProviderVariableWriteEvidenceLeaf {
  if (
    REFLECT_APPLY(SET_HAS, ALLOWED_LEAVES, [value]) !== true
    || PATH_BASENAME(value) !== value
    || REFLECT_APPLY(STRING_INCLUDES, value, ["\0"]) === true
    || regexpTest(LINE_BREAK_PATTERN, value)
  ) throw invalid();
  return value as PermanentStagingProviderVariableWriteEvidenceLeaf;
}

function canonicalUtf8Bytes(value: string): Buffer {
  const encoder = new TEXT_ENCODER_EXACT();
  const encoded = REFLECT_APPLY(
    TEXT_ENCODER_ENCODE,
    encoder,
    [value],
  ) as unknown;
  if (
    typeof encoded !== "object"
    || encoded === null
    || isProxy(encoded)
    || REFLECT_APPLY(ARRAY_BUFFER_IS_VIEW, ARRAY_BUFFER_EXACT, [encoded])
      !== true
    || OBJECT_GET_PROTOTYPE_OF(encoded) !== UINT8_ARRAY_PROTOTYPE
  ) throw invalid();
  const source = encoded as Uint8Array;
  let bytes: Buffer | null = null;
  try {
    const sourceLength = viewByteLength(source);
    bytes = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_EXACT, [sourceLength]) as Buffer;
    if (
      REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_EXACT, [bytes]) !== true
      || OBJECT_GET_PROTOTYPE_OF(bytes) !== BUFFER_PROTOTYPE
      || bufferLength(bytes) !== sourceLength
    ) throw invalid();
    REFLECT_APPLY(UINT8_ARRAY_SET, bytes, [source, 0]);
    if (canonicalUtf8Json(bytes) !== value) throw invalid();
    return bytes;
  } catch (error) {
    if (bytes !== null) wipeBuffer(bytes);
    throw normalizeFailure(error);
  } finally {
    wipeBytes(source);
  }
}

function canonicalJson(value: unknown): string {
  let nodes = 0;
  const serialize = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
      throw invalid();
    }
    if (candidate === null) return "null";
    if (typeof candidate === "boolean") return candidate ? "true" : "false";
    if (typeof candidate === "string") {
      const encoded = REFLECT_APPLY(JSON_STRINGIFY, JSON_EXACT, [candidate]);
      if (typeof encoded !== "string") throw invalid();
      return encoded;
    }
    if (typeof candidate === "number") {
      if (!NUMBER_IS_FINITE(candidate)) throw invalid();
      const encoded = REFLECT_APPLY(JSON_STRINGIFY, JSON_EXACT, [candidate]);
      if (typeof encoded !== "string") throw invalid();
      return encoded;
    }
    if (typeof candidate !== "object" || isProxy(candidate)) throw invalid();
    const prototype = OBJECT_GET_PROTOTYPE_OF(candidate);
    const keys = REFLECT_OWN_KEYS(candidate);
    if (ARRAY_IS_ARRAY(candidate)) {
      if (prototype !== ARRAY_PROTOTYPE) throw invalid();
      const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
        candidate,
        "length",
      );
      if (
        lengthDescriptor === undefined
        || !OBJECT_HAS_OWN(lengthDescriptor, "value")
        || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || keys.length !== lengthDescriptor.value + 1
      ) throw invalid();
      let output = "[";
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
          candidate,
          STRING_EXACT(index),
        );
        if (
          descriptor === undefined
          || !OBJECT_HAS_OWN(descriptor, "value")
          || descriptor.enumerable !== true
        ) throw invalid();
        if (index > 0) output += ",";
        output += serialize(descriptor.value, depth + 1);
      }
      return `${output}]`;
    }
    if (prototype !== OBJECT_PROTOTYPE && prototype !== null) throw invalid();
    let output = "{";
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") throw invalid();
      const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(candidate, key);
      if (
        descriptor === undefined
        || !OBJECT_HAS_OWN(descriptor, "value")
        || descriptor.enumerable !== true
      ) throw invalid();
      const encodedKey = REFLECT_APPLY(JSON_STRINGIFY, JSON_EXACT, [key]);
      if (typeof encodedKey !== "string") throw invalid();
      if (index > 0) output += ",";
      output += `${encodedKey}:${serialize(descriptor.value, depth + 1)}`;
    }
    return `${output}}`;
  };
  return serialize(value, 0);
}

function canonicalUtf8Json(bytes: Buffer): string {
  const length = bufferLength(bytes);
  if (length === 0 || length > MAX_CANONICAL_CONTENT_BYTES) {
    throw invalid();
  }
  let decoded: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoded = REFLECT_APPLY(TEXT_DECODER_DECODE, decoder, [bytes]) as string;
  } catch {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = REFLECT_APPLY(JSON_PARSE, JSON_EXACT, [decoded]) as unknown;
  } catch {
    throw invalid();
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || ARRAY_IS_ARRAY(parsed)
    || canonicalJson(parsed) !== decoded
  ) throw invalid();
  return decoded;
}

function sha256(bytes: Buffer | string): string {
  if (typeof HASH_UPDATE !== "function" || typeof HASH_DIGEST !== "function") {
    throw invalid();
  }
  const hash = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
  REFLECT_APPLY(HASH_UPDATE, hash, [bytes]);
  const digest = REFLECT_APPLY(HASH_DIGEST, hash, ["hex"]);
  if (typeof digest !== "string" || digest.length !== 64) throw invalid();
  for (let index = 0; index < digest.length; index += 1) {
    const code = REFLECT_APPLY(STRING_CHAR_CODE_AT, digest, [index]) as number;
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) {
      throw invalid();
    }
  }
  return digest;
}

async function lstatIfPresent(
  dependencies: PermanentStagingProviderVariableWriteEvidenceDependencies,
  filename: string,
  statPrototype: object,
): Promise<StableStat | null> {
  try {
    return snapshotStat(await dependencies.lstat(filename), statPrototype);
  } catch (error) {
    if (errnoIs(error, "ENOENT")) return null;
    throw invalid();
  }
}

async function readExactStable(
  handle: FileHandle,
  fileHandleIntrinsics: FileHandleIntrinsics,
  statPrototype: object,
  expected: Buffer,
  uid: bigint,
  expectedLinks: bigint,
  signal?: AbortSignal,
): Promise<StableStat> {
  if (signal) checkSignal(signal);
  const before = await handleStat(handle, fileHandleIntrinsics, statPrototype);
  if (signal) checkSignal(signal);
  const expectedLength = bufferLength(expected);
  assertPrivateFile(before, uid, expectedLength, expectedLinks);
  const actual = REFLECT_APPLY(
    BUFFER_ALLOC,
    BUFFER_EXACT,
    [expectedLength],
  ) as Buffer;
  if (
    REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_EXACT, [actual]) !== true
    || OBJECT_GET_PROTOTYPE_OF(actual) !== BUFFER_PROTOTYPE
    || bufferLength(actual) !== expectedLength
  ) throw invalid();
  try {
    let offset = 0;
    while (offset < bufferLength(actual)) {
      if (signal) checkSignal(signal);
      assertFileHandleExact(handle, fileHandleIntrinsics);
      const maximum = bufferLength(actual) - offset;
      const result = await nativePromise(REFLECT_APPLY(
        fileHandleIntrinsics.read,
        handle,
        [actual, offset, maximum, offset],
      ));
      if (signal) checkSignal(signal);
      const bytesRead = exactIoCount(result, "bytesRead", maximum);
      if (bytesRead === 0) throw invalid();
      offset += bytesRead;
    }
    const overflow = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_EXACT, [1]) as Buffer;
    if (
      REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_EXACT, [overflow]) !== true
      || OBJECT_GET_PROTOTYPE_OF(overflow) !== BUFFER_PROTOTYPE
      || bufferLength(overflow) !== 1
    ) throw invalid();
    try {
      if (signal) checkSignal(signal);
      assertFileHandleExact(handle, fileHandleIntrinsics);
      const extra = await nativePromise(REFLECT_APPLY(
        fileHandleIntrinsics.read,
        handle,
        [overflow, 0, 1, bufferLength(actual)],
      ));
      if (signal) checkSignal(signal);
      if (exactIoCount(extra, "bytesRead", 1) !== 0) throw invalid();
    } finally {
      wipeBuffer(overflow);
    }
    const after = await handleStat(handle, fileHandleIntrinsics, statPrototype);
    if (signal) checkSignal(signal);
    if (
      !sameStableFile(before, after)
      || !REFLECT_APPLY(BUFFER_EQUALS, actual, [expected])
    ) throw invalid();
    return after;
  } finally {
    wipeBuffer(actual);
  }
}

async function readCanonicalStable(
  handle: FileHandle,
  fileHandleIntrinsics: FileHandleIntrinsics,
  statPrototype: object,
  pathStat: StableStat,
  uid: bigint,
  signal: AbortSignal,
): Promise<{ readonly canonical: string; readonly stat: StableStat }> {
  checkSignal(signal);
  if (
    pathStat.size < 1n
    || pathStat.size > BIGINT_EXACT(MAX_CANONICAL_CONTENT_BYTES)
  ) throw invalid();
  const size = NUMBER_EXACT(pathStat.size);
  assertPrivateFile(pathStat, uid, size, 1n);
  const before = await handleStat(handle, fileHandleIntrinsics, statPrototype);
  checkSignal(signal);
  assertPrivateFile(before, uid, size, 1n);
  if (!sameStableFile(before, pathStat)) throw invalid();
  const actual = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_EXACT, [size]) as Buffer;
  if (
    REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_EXACT, [actual]) !== true
    || OBJECT_GET_PROTOTYPE_OF(actual) !== BUFFER_PROTOTYPE
    || bufferLength(actual) !== size
  ) throw invalid();
  try {
    let offset = 0;
    while (offset < bufferLength(actual)) {
      checkSignal(signal);
      assertFileHandleExact(handle, fileHandleIntrinsics);
      const maximum = bufferLength(actual) - offset;
      const result = await nativePromise(REFLECT_APPLY(
        fileHandleIntrinsics.read,
        handle,
        [actual, offset, maximum, offset],
      ));
      checkSignal(signal);
      const bytesRead = exactIoCount(result, "bytesRead", maximum);
      if (bytesRead === 0) throw invalid();
      offset += bytesRead;
    }
    const overflow = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_EXACT, [1]) as Buffer;
    if (
      REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_EXACT, [overflow]) !== true
      || OBJECT_GET_PROTOTYPE_OF(overflow) !== BUFFER_PROTOTYPE
      || bufferLength(overflow) !== 1
    ) throw invalid();
    try {
      checkSignal(signal);
      assertFileHandleExact(handle, fileHandleIntrinsics);
      const extra = await nativePromise(REFLECT_APPLY(
        fileHandleIntrinsics.read,
        handle,
        [overflow, 0, 1, bufferLength(actual)],
      ));
      checkSignal(signal);
      if (exactIoCount(extra, "bytesRead", 1) !== 0) throw invalid();
    } finally {
      wipeBuffer(overflow);
    }
    const after = await handleStat(handle, fileHandleIntrinsics, statPrototype);
    checkSignal(signal);
    if (!sameStableFile(before, after)) throw invalid();
    return { canonical: canonicalUtf8Json(actual), stat: after };
  } finally {
    wipeBuffer(actual);
  }
}

function evidence(
  publication: PermanentStagingProviderVariableWriteDurableArtifactEvidence["publication"],
  digest: string,
): PermanentStagingProviderVariableWriteDurableArtifactEvidence {
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

export interface PermanentStagingProviderVariableWriteEvidenceStore {
  read(
    leaf: PermanentStagingProviderVariableWriteEvidenceLeaf,
    signal: AbortSignal,
  ): Promise<PermanentStagingProviderVariableWriteEvidenceRead | null>;
  inspect(
    leaf: PermanentStagingProviderVariableWriteEvidenceLeaf,
    canonicalContent: string,
    signal: AbortSignal,
  ): Promise<PermanentStagingProviderVariableWriteDurableArtifactEvidence | null>;
  persist(
    leaf: PermanentStagingProviderVariableWriteEvidenceLeaf,
    canonicalContent: string,
    signal: AbortSignal,
  ): Promise<PermanentStagingProviderVariableWriteDurableArtifactEvidence>;
  close(): Promise<void>;
}

export interface PermanentStagingProviderVariableWriteEvidenceRead {
  readonly canonical: string;
  readonly evidence: PermanentStagingProviderVariableWriteDurableArtifactEvidence;
}

class EvidenceStore implements PermanentStagingProviderVariableWriteEvidenceStore {
  private state: "open" | "closing" | "closed" | "failed" = "open";
  private active = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly parentPath: string,
    private readonly parentHandle: FileHandle,
    private readonly fileHandleIntrinsics: FileHandleIntrinsics,
    private readonly statPrototype: object,
    private readonly parentIdentity: DirectoryIdentity,
    private readonly uid: bigint,
    private readonly dependencies: PermanentStagingProviderVariableWriteEvidenceDependencies,
  ) {}

  private async assertParentExact(signal?: AbortSignal): Promise<void> {
    if (signal) checkSignal(signal);
    const descriptor = await handleStat(
      this.parentHandle,
      this.fileHandleIntrinsics,
      this.statPrototype,
    );
    const atPathRaw = await nativePromise(
      this.dependencies.lstat(this.parentPath),
    );
    const real = await nativePromise(
      this.dependencies.realpath(this.parentPath),
    );
    if (signal) checkSignal(signal);
    const atPath = snapshotStat(atPathRaw, this.statPrototype);
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
    if (this.state !== "open" || this.active) throw invalid();
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
  ): Promise<PermanentStagingProviderVariableWriteDurableArtifactEvidence> {
    let handle: FileHandle | null = null;
    let failure: unknown = null;
    try {
      await this.assertParentExact(signal);
      const initialPath = snapshotStat(
        await this.dependencies.lstat(filePath),
        this.statPrototype,
      );
      checkSignal(signal);
      assertPrivateFile(initialPath, this.uid, bufferLength(expected), 1n);
      handle = await this.dependencies.open(
        filePath,
        FS_O_RDONLY | O_NOFOLLOW_EXACT,
      );
      registerFileHandle(handle, this.fileHandleIntrinsics);
      checkSignal(signal);
      const descriptor = await readExactStable(
        handle,
        this.fileHandleIntrinsics,
        this.statPrototype,
        expected,
        this.uid,
        1n,
        signal,
      );
      if (!sameStableFile(descriptor, initialPath)) throw invalid();
      const atPath = snapshotStat(
        await this.dependencies.lstat(filePath),
        this.statPrototype,
      );
      checkSignal(signal);
      assertPrivateFile(atPath, this.uid, bufferLength(expected), 1n);
      if (!sameStableFile(descriptor, atPath)) throw invalid();
      await this.dependencies.syncHandle(handle);
      checkSignal(signal);
      await this.dependencies.syncHandle(this.parentHandle);
      checkSignal(signal);
      await this.assertParentExact(signal);
      const finalDescriptor = await readExactStable(
        handle,
        this.fileHandleIntrinsics,
        this.statPrototype,
        expected,
        this.uid,
        1n,
        signal,
      );
      const finalPath = snapshotStat(
        await this.dependencies.lstat(filePath),
        this.statPrototype,
      );
      checkSignal(signal);
      if (!sameStableFile(finalDescriptor, finalPath)) throw invalid();
      return evidence("existing-exact", sha256(expected));
    } catch (error) {
      failure = error;
      throw normalizeFailure(error);
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

  private async readExisting(
    filePath: string,
    signal: AbortSignal,
  ): Promise<PermanentStagingProviderVariableWriteEvidenceRead> {
    let handle: FileHandle | null = null;
    let failure: unknown = null;
    try {
      await this.assertParentExact(signal);
      const initialPath = snapshotStat(
        await this.dependencies.lstat(filePath),
        this.statPrototype,
      );
      checkSignal(signal);
      if (
        initialPath.size < 1n
        || initialPath.size > BIGINT_EXACT(MAX_CANONICAL_CONTENT_BYTES)
      ) throw invalid();
      assertPrivateFile(
        initialPath,
        this.uid,
        NUMBER_EXACT(initialPath.size),
        1n,
      );
      handle = await this.dependencies.open(
        filePath,
        FS_O_RDONLY | O_NOFOLLOW_EXACT,
      );
      registerFileHandle(handle, this.fileHandleIntrinsics);
      checkSignal(signal);
      const first = await readCanonicalStable(
        handle,
        this.fileHandleIntrinsics,
        this.statPrototype,
        initialPath,
        this.uid,
        signal,
      );
      const atPath = snapshotStat(
        await this.dependencies.lstat(filePath),
        this.statPrototype,
      );
      checkSignal(signal);
      assertPrivateFile(
        atPath,
        this.uid,
        NUMBER_EXACT(initialPath.size),
        1n,
      );
      if (!sameStableFile(first.stat, atPath)) throw invalid();
      await this.dependencies.syncHandle(handle);
      checkSignal(signal);
      await this.dependencies.syncHandle(this.parentHandle);
      checkSignal(signal);
      await this.assertParentExact(signal);
      const finalPath = snapshotStat(
        await this.dependencies.lstat(filePath),
        this.statPrototype,
      );
      checkSignal(signal);
      const final = await readCanonicalStable(
        handle,
        this.fileHandleIntrinsics,
        this.statPrototype,
        finalPath,
        this.uid,
        signal,
      );
      if (
        first.canonical !== final.canonical
        || !sameStableFile(first.stat, final.stat)
      ) throw invalid();
      return {
        canonical: final.canonical,
        evidence: evidence("existing-exact", sha256(final.canonical)),
      };
    } catch (error) {
      failure = error;
      throw normalizeFailure(error);
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

  async read(
    leafInput: PermanentStagingProviderVariableWriteEvidenceLeaf,
    signal: AbortSignal,
  ): Promise<PermanentStagingProviderVariableWriteEvidenceRead | null> {
    checkSignal(signal);
    this.enter();
    try {
      const leaf = exactLeaf(leafInput);
      const filePath = PATH_JOIN(this.parentPath, leaf);
      await this.assertParentExact(signal);
      if (!await lstatIfPresent(
        this.dependencies,
        filePath,
        this.statPrototype,
      )) {
        checkSignal(signal);
        await this.assertParentExact(signal);
        return null;
      }
      checkSignal(signal);
      return await this.readExisting(filePath, signal);
    } catch (error) {
      throw normalizeFailure(error);
    } finally {
      this.leave();
    }
  }

  async inspect(
    leafInput: PermanentStagingProviderVariableWriteEvidenceLeaf,
    canonicalContent: string,
    signal: AbortSignal,
  ): Promise<PermanentStagingProviderVariableWriteDurableArtifactEvidence | null> {
    checkSignal(signal);
    this.enter();
    let expected: Buffer | null = null;
    try {
      expected = canonicalUtf8Bytes(canonicalContent);
      checkSignal(signal);
      const leaf = exactLeaf(leafInput);
      const filePath = PATH_JOIN(this.parentPath, leaf);
      await this.assertParentExact(signal);
      if (!await lstatIfPresent(
        this.dependencies,
        filePath,
        this.statPrototype,
      )) {
        checkSignal(signal);
        await this.assertParentExact(signal);
        return null;
      }
      checkSignal(signal);
      return await this.verifyExisting(filePath, expected, signal);
    } catch (error) {
      throw normalizeFailure(error);
    } finally {
      if (expected) wipeBuffer(expected);
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
    // This path-based cleanup is exact only inside the documented non-hostile
    // current-UID boundary. Node exposes no unlinkat-style descriptor-relative
    // primitive here; activation requires a native identity-bound replacement
    // or an explicitly reviewed continuation of that trust boundary.
    try {
      const descriptor = await handleStat(
        handle,
        this.fileHandleIntrinsics,
        this.statPrototype,
      );
      const temporaryRaw = await nativePromise(
        this.dependencies.lstat(temporaryPath),
      );
      const temporary = snapshotStat(temporaryRaw, this.statPrototype);
      if (
        descriptor.size < 0n
        || descriptor.size > BIGINT_EXACT(MAX_CANONICAL_CONTENT_BYTES)
      ) return false;
      assertPrivateFile(
        descriptor,
        this.uid,
        NUMBER_EXACT(descriptor.size),
        expectedLinks,
      );
      assertPrivateFile(
        temporary,
        this.uid,
        NUMBER_EXACT(descriptor.size),
        expectedLinks,
      );
      if (
        !sameFileIdentity(identity, fileIdentity(descriptor))
        || !sameFileIdentity(identity, fileIdentity(temporary))
      ) return false;
      if (finalPath) {
        const final = snapshotStat(
          await this.dependencies.lstat(finalPath),
          this.statPrototype,
        );
        assertPrivateFile(
          final,
          this.uid,
          NUMBER_EXACT(descriptor.size),
          expectedLinks,
        );
        if (!sameFileIdentity(identity, fileIdentity(final))) return false;
      }
      await this.dependencies.unlink(temporaryPath);
      const after = await handleStat(
        handle,
        this.fileHandleIntrinsics,
        this.statPrototype,
      );
      if (
        !sameFileIdentity(identity, fileIdentity(after))
        || after.nlink !== expectedLinks - 1n
      ) return false;
      if (await lstatIfPresent(
        this.dependencies,
        temporaryPath,
        this.statPrototype,
      )) return false;
      if (!finalPath) return after.nlink === 0n;
      const final = snapshotStat(
        await this.dependencies.lstat(finalPath),
        this.statPrototype,
      );
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
      let atPath: StableStat | null = null;
      try {
        atPath = await lstatIfPresent(
          this.dependencies,
          input.temporaryPath,
          this.statPrototype,
        );
      } catch {
        exact = false;
      }
      if (atPath) {
        if (!cleanupIdentity && cleanupHandle) {
          try {
            const descriptor = await handleStat(
              cleanupHandle,
              this.fileHandleIntrinsics,
              this.statPrototype,
            );
            if (
              descriptor.size < 0n
              || descriptor.size > BIGINT_EXACT(MAX_CANONICAL_CONTENT_BYTES)
            ) throw invalid();
            assertPrivateFile(
              descriptor,
              this.uid,
              NUMBER_EXACT(descriptor.size),
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
            && atPath.size <= BIGINT_EXACT(MAX_CANONICAL_CONTENT_BYTES);
          try {
            if (pathExact) {
              assertPrivateFile(
                atPath,
                this.uid,
                NUMBER_EXACT(atPath.size),
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
                const descriptor = await handleStat(
                  cleanupHandle,
                  this.fileHandleIntrinsics,
                  this.statPrototype,
                );
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
                  FS_O_RDONLY | O_NOFOLLOW_EXACT,
                );
                registerFileHandle(
                  cleanupHandle,
                  this.fileHandleIntrinsics,
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
    leaf: PermanentStagingProviderVariableWriteEvidenceLeaf,
    expected: Buffer,
    signal: AbortSignal,
  ): Promise<PermanentStagingProviderVariableWriteDurableArtifactEvidence> {
    checkSignal(signal);
    const randomHex = exactRandomHex(this.dependencies);
    const temporaryLeaf = `.${leaf}.${randomHex}.tmp`;
    const temporaryPath = PATH_JOIN(this.parentPath, temporaryLeaf);
    if (
      PATH_DIRNAME(temporaryPath) !== this.parentPath
      || PATH_BASENAME(temporaryPath) !== temporaryLeaf
    ) throw invalid();

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
          FS_O_WRONLY
            | FS_O_CREAT
            | FS_O_EXCL
            | O_NOFOLLOW_EXACT,
          0o600,
        );
        registerFileHandle(writeHandle, this.fileHandleIntrinsics);
      } catch (error) {
        if (errnoIs(error, "EEXIST")) throw invalid();
        let possiblePartial: StableStat | null;
        try {
          possiblePartial = await lstatIfPresent(
            this.dependencies,
            temporaryPath,
            this.statPrototype,
          );
        } catch {
          throw cleanupFailed();
        }
        if (possiblePartial) throw cleanupFailed();
        throw invalid();
      }
      temporaryCreated = true;
      assertFileHandleExact(writeHandle, this.fileHandleIntrinsics);
      await nativePromise(REFLECT_APPLY(
        this.fileHandleIntrinsics.chmod,
        writeHandle,
        [0o600],
      ));
      const created = await handleStat(
        writeHandle,
        this.fileHandleIntrinsics,
        this.statPrototype,
      );
      assertPrivateFile(created, this.uid, 0, 1n);
      identity = fileIdentity(created);
      checkSignal(signal);
      let offset = 0;
      while (offset < bufferLength(expected)) {
        checkSignal(signal);
        assertFileHandleExact(writeHandle, this.fileHandleIntrinsics);
        const maximum = bufferLength(expected) - offset;
        const result = await nativePromise(REFLECT_APPLY(
          this.fileHandleIntrinsics.write,
          writeHandle,
          [expected, offset, maximum, offset],
        ));
        checkSignal(signal);
        const bytesWritten = exactIoCount(result, "bytesWritten", maximum);
        if (bytesWritten === 0) throw invalid();
        offset += bytesWritten;
      }
      await this.dependencies.syncHandle(writeHandle);
      checkSignal(signal);
      const written = await handleStat(
        writeHandle,
        this.fileHandleIntrinsics,
        this.statPrototype,
      );
      checkSignal(signal);
      const writtenPath = snapshotStat(
        await this.dependencies.lstat(temporaryPath),
        this.statPrototype,
      );
      checkSignal(signal);
      assertPrivateFile(written, this.uid, bufferLength(expected), 1n);
      assertPrivateFile(writtenPath, this.uid, bufferLength(expected), 1n);
      if (
        !sameFileIdentity(identity, fileIdentity(written))
        || !sameStableFile(written, writtenPath)
      ) throw invalid();
      await this.closeFileWithPrecedence(writeHandle);
      writeHandle = null;
      checkSignal(signal);

      readHandle = await this.dependencies.open(
        temporaryPath,
        FS_O_RDONLY | O_NOFOLLOW_EXACT,
      );
      registerFileHandle(readHandle, this.fileHandleIntrinsics);
      checkSignal(signal);
      const readback = await readExactStable(
        readHandle,
        this.fileHandleIntrinsics,
        this.statPrototype,
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
        let descriptor: StableStat;
        let final: StableStat | null;
        try {
          descriptor = await handleStat(
            readHandle,
            this.fileHandleIntrinsics,
            this.statPrototype,
          );
          final = await lstatIfPresent(
            this.dependencies,
            filePath,
            this.statPrototype,
          );
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

      const linkedDescriptor = await handleStat(
        readHandle,
        this.fileHandleIntrinsics,
        this.statPrototype,
      );
      const linkedTemporaryRaw = await nativePromise(
        this.dependencies.lstat(temporaryPath),
      );
      const linkedFinalRaw = await nativePromise(
        this.dependencies.lstat(filePath),
      );
      const linkedTemporary = snapshotStat(
        linkedTemporaryRaw,
        this.statPrototype,
      );
      const linkedFinal = snapshotStat(linkedFinalRaw, this.statPrototype);
      assertPrivateFile(linkedDescriptor, this.uid, bufferLength(expected), 2n);
      assertPrivateFile(linkedTemporary, this.uid, bufferLength(expected), 2n);
      assertPrivateFile(linkedFinal, this.uid, bufferLength(expected), 2n);
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
        this.fileHandleIntrinsics,
        this.statPrototype,
        expected,
        this.uid,
        1n,
      );
      const finalPath = snapshotStat(
        await this.dependencies.lstat(filePath),
        this.statPrototype,
      );
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
      if (
        linked
        || !cleanupExact
        || fixedErrorCode(error) === "cleanup_failed"
      ) {
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
    leafInput: PermanentStagingProviderVariableWriteEvidenceLeaf,
    canonicalContent: string,
    signal: AbortSignal,
  ): Promise<PermanentStagingProviderVariableWriteDurableArtifactEvidence> {
    checkSignal(signal);
    this.enter();
    let expected: Buffer | null = null;
    try {
      expected = canonicalUtf8Bytes(canonicalContent);
      checkSignal(signal);
      const leaf = exactLeaf(leafInput);
      const filePath = PATH_JOIN(this.parentPath, leaf);
      await this.assertParentExact(signal);
      if (await lstatIfPresent(
        this.dependencies,
        filePath,
        this.statPrototype,
      )) {
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
      throw normalizeFailure(error);
    } finally {
      if (expected) wipeBuffer(expected);
      this.leave();
    }
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "failed") throw cleanupFailed();
    if (this.state === "closing") {
      if (this.closePromise === null) throw cleanupFailed();
      return await this.closePromise;
    }
    if (this.active) throw cleanupFailed();
    this.state = "closing";
    const closeOperation = (async (): Promise<void> => {
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
      this.state = exact ? "closed" : "failed";
      if (!exact) throw cleanupFailed();
    })();
    this.closePromise = closeOperation;
    return await closeOperation;
  }
}

export async function openPermanentStagingProviderVariableWriteEvidenceStore(
  parentDirectory: string,
  overrides: Partial<PermanentStagingProviderVariableWriteEvidenceDependencies> = {},
): Promise<PermanentStagingProviderVariableWriteEvidenceStore> {
  const capturedDependencies = captureDependencies(overrides);
  let dependencies = capturedDependencies.dependencies;
  const parentPath = exactParentPath(parentDirectory);
  let parentHandle: FileHandle | null = null;
  let fileHandleIntrinsics: FileHandleIntrinsics | null = null;
  let failure: unknown = null;
  try {
    const effectiveUid = dependencies.effectiveUid();
    if (!NUMBER_IS_SAFE_INTEGER(effectiveUid) || effectiveUid < 0) throw invalid();
    const uid = BIGINT_EXACT(effectiveUid);
    const real = await nativePromise(dependencies.realpath(parentPath));
    const beforeRaw = await nativePromise(dependencies.lstat(parentPath));
    const before = snapshotStat(beforeRaw);
    const statPrototype = before.prototype;
    assertPrivateParent(before, uid);
    if (real !== parentPath) throw invalid();
    parentHandle = await dependencies.open(
      parentPath,
      FS_O_RDONLY
        | O_DIRECTORY_EXACT
        | O_NOFOLLOW_EXACT,
    );
    fileHandleIntrinsics = captureFileHandleIntrinsics(parentHandle);
    const opened = await handleStat(
      parentHandle,
      fileHandleIntrinsics,
      statPrototype,
    );
    assertPrivateParent(opened, uid);
    const identity = directoryIdentity(before);
    if (!sameDirectoryIdentity(identity, directoryIdentity(opened))) throw invalid();
    const capturedHandleMethods = fileHandleIntrinsics;
    const originalDependencies = dependencies;
    dependencies = OBJECT_FREEZE({
      open: originalDependencies.open,
      lstat: originalDependencies.lstat,
      realpath: originalDependencies.realpath,
      link: originalDependencies.link,
      unlink: originalDependencies.unlink,
      randomBytes: originalDependencies.randomBytes,
      effectiveUid: originalDependencies.effectiveUid,
      syncHandle: capturedDependencies.syncOverridden
        ? originalDependencies.syncHandle
        : async (handle: FileHandle): Promise<void> => {
          assertFileHandleExact(handle, capturedHandleMethods);
          await nativePromise(REFLECT_APPLY(
            capturedHandleMethods.sync,
            handle,
            [],
          ));
        },
      closeHandle: capturedDependencies.closeOverridden
        ? originalDependencies.closeHandle
        : async (handle: FileHandle): Promise<void> => {
          await closeHandleExact(handle, capturedHandleMethods);
        },
    });
    return new EvidenceStore(
      parentPath,
      parentHandle,
      fileHandleIntrinsics,
      statPrototype,
      identity,
      uid,
      dependencies,
    );
  } catch (error) {
    failure = error;
    throw normalizeFailure(error);
  } finally {
    if (failure && parentHandle) {
      try {
        if (fileHandleIntrinsics && !capturedDependencies.closeOverridden) {
          await closeHandleExact(parentHandle, fileHandleIntrinsics);
        } else {
          await dependencies.closeHandle(parentHandle);
        }
      } catch {
        throw cleanupFailed();
      }
    }
  }
}

export const permanentStagingProviderVariableWriteEvidenceInternals = {
  MAX_CANONICAL_CONTENT_BYTES,
};
