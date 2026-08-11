import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS,
  type PermanentStagingProviderVariableName,
} from "./permanent-staging-provider-variable-write-executor.js";
import {
  PermanentStagingProviderVariableWriteInputError,
  isPermanentStagingProviderVariableWriteInputHandleAuthority,
  type PermanentStagingProviderVariableWriteInputHandle,
  type PermanentStagingProviderVariableWriteInputInspection,
} from "./permanent-staging-provider-variable-write-input.js";

const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const ARRAY_IS_ARRAY = Array.isArray;
const BIGINT_CONSTRUCTOR = BigInt;
const BIGINT_TO_STRING = BigInt.prototype.toString;
const BUFFER_ALLOC = Buffer.alloc;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const CRYPTO_CREATE_HASH = crypto.createHash;
const EVENT_TARGET_ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const EVENT_TARGET_REMOVE_EVENT_LISTENER =
  EventTarget.prototype.removeEventListener;
const JSON_STRINGIFY = JSON.stringify;
const MATH_MIN = Math.min;
const NUMBER_CONSTRUCTOR = Number;
const NUMBER_IS_INTEGER = Number.isInteger;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_DEFINE_PROPERTIES = Object.defineProperties;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const PATH_IS_ABSOLUTE = path.isAbsolute;
const PATH_NORMALIZE = path.normalize;
const PATH_PARSE = path.parse;
const PATH_RESOLVE = path.resolve;
const REGEXP_EXEC = RegExp.prototype.exec;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_INCLUDES = String.prototype.includes;
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const UTIL_IS_PROMISE = utilTypes.isPromise;
const UTIL_IS_PROXY = utilTypes.isProxy;
const FS_PROMISES = fs.promises;
const FS_OPEN = FS_PROMISES.open;
const FS_LSTAT = FS_PROMISES.lstat;
const FS_REALPATH = FS_PROMISES.realpath;
const PROCESS_GETEUID = process.geteuid;
const O_NOFOLLOW_EXACT = fs.constants.O_NOFOLLOW;
const O_RDONLY_EXACT = fs.constants.O_RDONLY;
const HASH_PROBE = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
const HASH_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(HASH_PROBE) as {
  readonly update: (...args: never[]) => unknown;
  readonly digest: (...args: never[]) => unknown;
};
const HASH_UPDATE = HASH_PROTOTYPE.update;
const HASH_DIGEST = HASH_PROTOTYPE.digest;
REFLECT_APPLY(HASH_DIGEST, HASH_PROBE, []);
const STAT_MODE_MASK = BIGINT_CONSTRUCTOR(fs.constants.S_IFMT);
const STAT_MODE_REGULAR = BIGINT_CONSTRUCTOR(fs.constants.S_IFREG);
const LINE_BREAK_PATTERN = /[\r\n]/;
const DECIMAL_BIGINT_PATTERN = /^-?[0-9]+$/;
const OCTAL_BIGINT_PATTERN = /^[0-7]+$/;
const LOWERCASE_HEX_64_PATTERN = /^[a-f0-9]{64}$/;

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCAL_AUTHORITY_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-local-authority/v1" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_COMMAND_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-command/v1" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCAL_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-local-receipt/v1" as const;

export type PermanentStagingProviderVariableWriteLocalAuthorityFailureCode =
  | "local_authority_invalid"
  | "write_failed"
  | "cleanup_failed";

export class PermanentStagingProviderVariableWriteLocalAuthorityError
  extends Error {
  readonly code!: PermanentStagingProviderVariableWriteLocalAuthorityFailureCode;

  constructor(
    code: PermanentStagingProviderVariableWriteLocalAuthorityFailureCode,
  ) {
    super(code);
    REFLECT_APPLY(OBJECT_DEFINE_PROPERTIES, Object, [this, {
      name: {
        configurable: true,
        enumerable: true,
        value: "PermanentStagingProviderVariableWriteLocalAuthorityError",
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

const LOCAL_ERROR_AUTHORITIES = new WeakMap<
  object,
  PermanentStagingProviderVariableWriteLocalAuthorityFailureCode
>();
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const INPUT_ERROR_PROTOTYPE =
  PermanentStagingProviderVariableWriteInputError.prototype;

export interface PermanentStagingProviderVariableWriteLocalInspection {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCAL_AUTHORITY_SCHEMA;
  readonly railwayCliVersion: string;
  readonly railwayCliAbsolutePath: string;
  readonly railwayCliSha256: string;
  readonly railwayCliBytes: number;
  readonly railwayCliIdentitySha256: string;
  readonly absoluteCanonicalNonSymlinkPath: true;
  readonly regularFile: true;
  readonly currentUid: true;
  readonly mode0555: true;
  readonly nlinkOne: true;
  readonly descriptorHeld: true;
  readonly pathAndDescriptorIdentityExact: true;
  readonly bytesHashedFromHeldDescriptor: true;
  readonly providerInvoked: false;
}

export interface PermanentStagingProviderVariableWriteCommand {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_COMMAND_SCHEMA;
  readonly executable: string;
  readonly argv: readonly [
    "variable",
    "set",
    PermanentStagingProviderVariableName,
    "--stdin",
    "--skip-deploys",
    "--project",
    string,
    "--environment",
    string,
    "--service",
    string,
  ];
  readonly environment: {
    readonly inherit: false;
    readonly exactNames: readonly ["RAILWAY_TOKEN"];
    readonly valuesHandledByThisModule: false;
  };
  readonly shell: false;
  readonly stdin: "pipe";
  readonly stdout: "ignore";
  readonly stderr: "ignore";
  readonly maximumCapturedStdoutBytes: 0;
  readonly maximumCapturedStderrBytes: 0;
}

export interface PermanentStagingProviderVariableWriteInjectedChildResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Capability supplied only by an isolated fixture in this disabled slice.
 * A live process adapter is deliberately absent: this module imports no
 * process-launch capability or credentials and never constructs an environment.
 */
export interface PermanentStagingProviderVariableWriteInjectedChild {
  writeStdin(value: Buffer): Promise<void>;
  abort(): void;
  readonly closed: Promise<PermanentStagingProviderVariableWriteInjectedChildResult>;
}

interface CapturedInjectedChild {
  readonly receiver: object;
  readonly writeStdin: (value: Buffer) => Promise<void>;
  readonly abort: () => void;
  readonly closed: Promise<PermanentStagingProviderVariableWriteInjectedChildResult>;
}

function ownDataDescriptors(
  value: unknown,
  expectedKeys: readonly string[],
): Record<PropertyKey, PropertyDescriptor> | null {
  try {
    if (
      typeof value !== "object"
      || value === null
      || REFLECT_APPLY(ARRAY_IS_ARRAY, Array, [value]) === true
      || REFLECT_APPLY(UTIL_IS_PROXY, utilTypes, [value]) === true
    ) {
      return null;
    }
    const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
      Object,
      [value],
    ) as Record<PropertyKey, PropertyDescriptor>;
    const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]) as
      PropertyKey[];
    if (keys.length !== expectedKeys.length) return null;
    for (let index = 0; index < keys.length; index += 1) {
      if (keys[index] !== expectedKeys[index]) return null;
    }
    for (let index = 0; index < expectedKeys.length; index += 1) {
      const key = expectedKeys[index]!;
      const descriptor = descriptors[key];
      if (
        descriptor === undefined
        || REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, "value"]) !== true
        || descriptor.enumerable !== true
      ) return null;
    }
    return descriptors;
  } catch {
    return null;
  }
}

function captureInjectedChild(value: unknown): CapturedInjectedChild | null {
  const descriptors = ownDataDescriptors(value, [
    "writeStdin",
    "abort",
    "closed",
  ]);
  if (descriptors === null) return null;
  const writeStdin = descriptors.writeStdin?.value;
  const abort = descriptors.abort?.value;
  const closed = descriptors.closed?.value;
  if (
    typeof writeStdin !== "function"
    || typeof abort !== "function"
    || !REFLECT_APPLY(UTIL_IS_PROMISE, utilTypes, [closed])
  ) return null;
  return OBJECT_FREEZE({
    receiver: value as object,
    writeStdin: writeStdin as (value: Buffer) => Promise<void>,
    abort: abort as () => void,
    closed: closed as Promise<PermanentStagingProviderVariableWriteInjectedChildResult>,
  });
}

function exactChildResult(
  value: unknown,
): PermanentStagingProviderVariableWriteInjectedChildResult | null {
  const descriptors = ownDataDescriptors(value, ["exitCode", "signal"]);
  if (descriptors === null) return null;
  const exitCode = descriptors.exitCode?.value;
  const signal = descriptors.signal?.value;
  if (
    !(exitCode === null || NUMBER_IS_SAFE_INTEGER(exitCode))
    || !(signal === null || typeof signal === "string")
  ) return null;
  return OBJECT_FREEZE({ exitCode, signal }) as
    PermanentStagingProviderVariableWriteInjectedChildResult;
}

export type PermanentStagingProviderVariableWriteInjectedChildLauncher = (
  command: PermanentStagingProviderVariableWriteCommand,
) => PermanentStagingProviderVariableWriteInjectedChild;

export interface PermanentStagingProviderVariableWriteLocalReceipt {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCAL_RECEIPT_SCHEMA;
  readonly variableName: PermanentStagingProviderVariableName;
  readonly inputCommitmentSha256: string;
  readonly localAuthoritySha256: string;
  readonly commandSha256: string;
  readonly childAttempts: 1;
  readonly stdinWrites: 1;
  readonly exitCode: 0;
  readonly signal: null;
  readonly stdoutBytesCaptured: 0;
  readonly stderrBytesCaptured: 0;
  readonly childCloseAwaited: true;
  readonly providerAcknowledgementInspected: false;
}

type FileHandle = fs.promises.FileHandle;

export interface PermanentStagingProviderVariableWriteLocalAuthorityDependencies {
  readonly open: (filename: string, flags: number) => Promise<FileHandle>;
  readonly lstat: (filename: string) => Promise<fs.BigIntStats>;
  readonly realpath: (filename: string) => Promise<string>;
  readonly effectiveUid: () => number;
  readonly closeHandle: (handle: FileHandle) => Promise<void>;
}

export interface PermanentStagingProviderVariableWriteLocalAuthorityHandle {
  inspect(
    signal: AbortSignal,
  ): Promise<PermanentStagingProviderVariableWriteLocalInspection>;
  reassert(
    signal: AbortSignal,
  ): Promise<PermanentStagingProviderVariableWriteLocalInspection>;
  buildCreateOnlyCommand(
    variableName: PermanentStagingProviderVariableName,
  ): PermanentStagingProviderVariableWriteCommand;
  /**
   * Exercises one child attempt through an injected fixture capability. This
   * repository intentionally provides no real launcher or credential adapter.
   */
  writeExactlyOnceWithInjectedChild(
    variableName: PermanentStagingProviderVariableName,
    input: PermanentStagingProviderVariableWriteInputHandle,
    launchChild: PermanentStagingProviderVariableWriteInjectedChildLauncher,
    signal: AbortSignal,
  ): Promise<PermanentStagingProviderVariableWriteLocalReceipt>;
  close(): Promise<void>;
}

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

interface CapturedFileHandle {
  readonly receiver: FileHandle;
  readonly read: FileHandle["read"];
  readonly stat: FileHandle["stat"];
}

interface CapturedFailure {
  readonly caught: true;
  readonly error: unknown;
}

interface NoFailure {
  readonly caught: false;
}

type FailureState = CapturedFailure | NoFailure;
type AuthorityState =
  | "open"
  | "inspecting"
  | "writing"
  | "closing"
  | "closed"
  | "failed";

const NO_FAILURE: NoFailure = OBJECT_FREEZE({ caught: false });
const MAX_PATH_BYTES = 4_096;
const MAX_BINARY_BYTES = 32 * 1_024 * 1_024;
const READ_CHUNK_BYTES = 64 * 1_024;
const LOCAL_AUTHORITY_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/local-authority/v1\0";
const COMMAND_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/command/v1\0";

const DEFAULT_DEPENDENCIES:
PermanentStagingProviderVariableWriteLocalAuthorityDependencies = {
  open: (filename, flags) => REFLECT_APPLY(FS_OPEN, FS_PROMISES, [
    filename,
    flags,
  ]),
  lstat: (filename) => REFLECT_APPLY(FS_LSTAT, FS_PROMISES, [
    filename,
    { bigint: true },
  ]) as Promise<fs.BigIntStats>,
  realpath: (filename) => REFLECT_APPLY(FS_REALPATH, FS_PROMISES, [
    filename,
  ]) as Promise<string>,
  effectiveUid: () => {
    if (typeof PROCESS_GETEUID !== "function") throw invalid();
    return REFLECT_APPLY(PROCESS_GETEUID, process, []);
  },
  closeHandle: (handle) => handle.close(),
};

function invalid(): PermanentStagingProviderVariableWriteLocalAuthorityError {
  return internalError("local_authority_invalid");
}

function writeFailed(): PermanentStagingProviderVariableWriteLocalAuthorityError {
  return internalError("write_failed");
}

function cleanupFailed():
PermanentStagingProviderVariableWriteLocalAuthorityError {
  return internalError("cleanup_failed");
}

function internalError(
  code: PermanentStagingProviderVariableWriteLocalAuthorityFailureCode,
): PermanentStagingProviderVariableWriteLocalAuthorityError {
  const error = new PermanentStagingProviderVariableWriteLocalAuthorityError(
    code,
  );
  REFLECT_APPLY(WEAK_MAP_SET, LOCAL_ERROR_AUTHORITIES, [error, code]);
  return error;
}

function normalizeFailure(error: unknown): never {
  if (typeof error === "object" && error !== null) {
    const code = REFLECT_APPLY(WEAK_MAP_GET, LOCAL_ERROR_AUTHORITIES, [error]);
    if (
      code === "local_authority_invalid"
      || code === "write_failed"
      || code === "cleanup_failed"
    ) throw internalError(code);
  }
  throw invalid();
}

function isGenuineInputCleanupFailure(error: unknown): boolean {
  try {
    if (
      typeof error !== "object"
      || error === null
      || REFLECT_APPLY(UTIL_IS_PROXY, utilTypes, [error]) === true
      || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [error])
        !== INPUT_ERROR_PROTOTYPE
    ) return false;
    const descriptors = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
      Object,
      [error],
    ) as Record<PropertyKey, PropertyDescriptor>;
    return descriptors.code?.value === "cleanup_failed"
      && descriptors.message?.value === "cleanup_failed"
      && descriptors.name?.value
        === "PermanentStagingProviderVariableWriteInputError";
  } catch {
    return false;
  }
}

function capture(error: unknown): CapturedFailure {
  return { caught: true, error };
}

function signalAborted(signal: AbortSignal): boolean {
  if (
    typeof ABORT_SIGNAL_ABORTED_GETTER !== "function"
    || typeof signal !== "object"
    || signal === null
    || REFLECT_APPLY(UTIL_IS_PROXY, utilTypes, [signal]) === true
  ) throw invalid();
  const aborted = REFLECT_APPLY(
    ABORT_SIGNAL_ABORTED_GETTER,
    signal,
    [],
  );
  if (typeof aborted !== "boolean") throw invalid();
  return aborted;
}

function checkSignal(signal: AbortSignal): void {
  if (signalAborted(signal)) throw invalid();
}

function regexpMatches(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY(REGEXP_EXEC, pattern, [value]) !== null;
}

function exactAbsolutePath(value: unknown): string {
  if (
    typeof value !== "string"
    || !REFLECT_APPLY(PATH_IS_ABSOLUTE, path, [value])
    || REFLECT_APPLY(PATH_NORMALIZE, path, [value]) !== value
    || REFLECT_APPLY(PATH_RESOLVE, path, [value]) !== value
    || value === (REFLECT_APPLY(PATH_PARSE, path, [value]) as path.ParsedPath)
      .root
    || REFLECT_APPLY(STRING_INCLUDES, value, ["\0"])
    || regexpMatches(LINE_BREAK_PATTERN, value)
    || REFLECT_APPLY(BUFFER_BYTE_LENGTH, Buffer, [value, "utf8"])
      > MAX_PATH_BYTES
  ) throw invalid();
  return value;
}

function safeUid(value: number): bigint {
  if (!NUMBER_IS_SAFE_INTEGER(value) || value < 0) throw invalid();
  return REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [value]);
}

function exactSize(value: bigint): number {
  if (
    value <= 0n
    || value > REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [MAX_BINARY_BYTES])
  ) throw invalid();
  const size = REFLECT_APPLY(NUMBER_CONSTRUCTOR, undefined, [value]);
  if (!NUMBER_IS_SAFE_INTEGER(size)) throw invalid();
  return size;
}

function identity(stat: unknown): StableIdentity {
  if (
    typeof stat !== "object"
    || stat === null
    || REFLECT_APPLY(UTIL_IS_PROXY, utilTypes, [stat]) === true
  ) throw invalid();
  const descriptors = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    Object,
    [stat],
  ) as Record<PropertyKey, PropertyDescriptor>;
  const field = (key: keyof StableIdentity): bigint => {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, "value"]) !== true
      || typeof descriptor.value !== "bigint"
    ) throw invalid();
    return descriptor.value;
  };
  return {
    dev: field("dev"),
    ino: field("ino"),
    uid: field("uid"),
    gid: field("gid"),
    mode: field("mode"),
    nlink: field("nlink"),
    size: field("size"),
    mtimeNs: field("mtimeNs"),
    ctimeNs: field("ctimeNs"),
  };
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

function assertBinary(stat: unknown, uid: bigint): StableIdentity {
  const observed = identity(stat);
  if (
    (observed.mode & STAT_MODE_MASK) !== STAT_MODE_REGULAR
    || observed.uid !== uid
    || observed.nlink !== 1n
    || (observed.mode & 0o7777n) !== 0o555n
  ) throw invalid();
  exactSize(observed.size);
  return observed;
}

function captureFileHandle(handle: FileHandle): CapturedFileHandle {
  if (
    typeof handle !== "object"
    || handle === null
    || REFLECT_APPLY(UTIL_IS_PROXY, utilTypes, [handle]) === true
  ) throw invalid();
  const read = handle.read;
  const stat = handle.stat;
  if (typeof read !== "function" || typeof stat !== "function") {
    throw invalid();
  }
  return OBJECT_FREEZE({ receiver: handle, read, stat });
}

function exactLowercaseHex64(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index]) as number;
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) {
      return false;
    }
  }
  return true;
}

function jsonPrimitive(value: string | number | boolean | null): string {
  const rendered = REFLECT_APPLY(JSON_STRINGIFY, JSON, [value]);
  if (typeof rendered !== "string") throw invalid();
  return rendered;
}

function bigintDecimal(value: bigint): string {
  const rendered = REFLECT_APPLY(BIGINT_TO_STRING, value, [10]);
  if (
    typeof rendered !== "string"
    || !regexpMatches(DECIMAL_BIGINT_PATTERN, rendered)
  ) {
    throw invalid();
  }
  return rendered;
}

function bigintOctal(value: bigint): string {
  const rendered = REFLECT_APPLY(BIGINT_TO_STRING, value, [8]);
  if (
    typeof rendered !== "string"
    || !regexpMatches(OCTAL_BIGINT_PATTERN, rendered)
  ) {
    throw invalid();
  }
  return rendered;
}

function sha256Utf8(domain: string, canonical: string): string {
  const hash = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
  REFLECT_APPLY(HASH_UPDATE, hash, [domain, "utf8"]);
  REFLECT_APPLY(HASH_UPDATE, hash, [canonical, "utf8"]);
  const digest = REFLECT_APPLY(HASH_DIGEST, hash, ["hex"]);
  if (!exactLowercaseHex64(digest)) throw invalid();
  return digest;
}

function identityCanonical(value: StableIdentity): string {
  return `{"dev":${jsonPrimitive(bigintDecimal(value.dev))},`
    + `"ino":${jsonPrimitive(bigintDecimal(value.ino))},`
    + `"uid":${jsonPrimitive(bigintDecimal(value.uid))},`
    + `"gid":${jsonPrimitive(bigintDecimal(value.gid))},`
    + `"mode":${jsonPrimitive(bigintOctal(value.mode))},`
    + `"nlink":${jsonPrimitive(bigintDecimal(value.nlink))},`
    + `"size":${jsonPrimitive(bigintDecimal(value.size))},`
    + `"mtimeNs":${jsonPrimitive(bigintDecimal(value.mtimeNs))},`
    + `"ctimeNs":${jsonPrimitive(bigintDecimal(value.ctimeNs))}}`;
}

function identitySha256(value: StableIdentity): string {
  return sha256Utf8(LOCAL_AUTHORITY_HASH_DOMAIN, identityCanonical(value));
}

async function hashDescriptor(
  descriptor: CapturedFileHandle,
  size: number,
  signal: AbortSignal,
): Promise<string> {
  const digest = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
  let offset = 0;
  while (offset < size) {
    checkSignal(signal);
    const requested = REFLECT_APPLY(MATH_MIN, Math, [
      READ_CHUNK_BYTES,
      size - offset,
    ]);
    const buffer = REFLECT_APPLY(BUFFER_ALLOC, Buffer, [requested]) as Buffer;
    if (
      REFLECT_APPLY(BUFFER_BYTE_LENGTH, Buffer, [buffer]) !== requested
    ) throw invalid();
    let filled = 0;
    try {
      while (filled < requested) {
        checkSignal(signal);
        const remaining = requested - filled;
        const pendingRead = REFLECT_APPLY(
          descriptor.read,
          descriptor.receiver,
          [buffer, filled, remaining, offset + filled],
        ) as unknown;
        if (!REFLECT_APPLY(UTIL_IS_PROMISE, utilTypes, [pendingRead])) {
          throw invalid();
        }
        const result = await pendingRead;
        const resultDescriptors = ownDataDescriptors(result, [
          "bytesRead",
          "buffer",
        ]);
        const bytesRead = resultDescriptors?.bytesRead?.value;
        if (
          resultDescriptors === null
          || resultDescriptors.buffer?.value !== buffer
          || !NUMBER_IS_SAFE_INTEGER(bytesRead)
          || bytesRead <= 0
          || bytesRead > remaining
        ) throw invalid();
        filled += bytesRead;
      }
      checkSignal(signal);
      REFLECT_APPLY(HASH_UPDATE, digest, [buffer]);
      offset += requested;
    } finally {
      REFLECT_APPLY(UINT8_ARRAY_FILL, buffer, [0]);
    }
  }
  checkSignal(signal);
  const rendered = REFLECT_APPLY(HASH_DIGEST, digest, ["hex"]);
  if (!exactLowercaseHex64(rendered)) throw invalid();
  return rendered;
}

async function stablePathAndDescriptor(
  absolutePath: string,
  descriptor: CapturedFileHandle,
  expected: StableIdentity,
  uid: bigint,
  dependencies: PermanentStagingProviderVariableWriteLocalAuthorityDependencies,
): Promise<StableIdentity> {
  const pathStat = await dependencies.lstat(absolutePath);
  const pendingStat = REFLECT_APPLY(
    descriptor.stat,
    descriptor.receiver,
    [{ bigint: true }],
  ) as unknown;
  if (!REFLECT_APPLY(UTIL_IS_PROMISE, utilTypes, [pendingStat])) {
    throw invalid();
  }
  const descriptorStat = await pendingStat;
  const pathIdentity = assertBinary(pathStat, uid);
  const descriptorIdentity = assertBinary(descriptorStat, uid);
  if (
    !sameIdentity(pathIdentity, expected)
    || !sameIdentity(descriptorIdentity, expected)
    || await dependencies.realpath(absolutePath) !== absolutePath
  ) throw invalid();
  return descriptorIdentity;
}

function exactVariableName(
  value: unknown,
): asserts value is PermanentStagingProviderVariableName {
  if (typeof value !== "string") throw invalid();
  for (
    let index = 0;
    index < PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS.length;
    index += 1
  ) {
    if (
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS[index]?.variableName
        === value
    ) return;
  }
  throw invalid();
}

function commandFor(
  variableName: PermanentStagingProviderVariableName,
): PermanentStagingProviderVariableWriteCommand {
  const lock = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK;
  const argv = OBJECT_FREEZE([
    "variable",
    "set",
    variableName,
    "--stdin",
    "--skip-deploys",
    "--project",
    lock.projectId,
    "--environment",
    lock.stagingEnvironmentId,
    "--service",
    lock.serviceId,
  ] as const);
  return OBJECT_FREEZE({
    schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_COMMAND_SCHEMA,
    executable: exactAbsolutePath(lock.railwayCli.absolutePath),
    argv,
    environment: OBJECT_FREEZE({
      inherit: false,
      exactNames: OBJECT_FREEZE(["RAILWAY_TOKEN"] as const),
      valuesHandledByThisModule: false,
    }),
    shell: false,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    maximumCapturedStdoutBytes: 0,
    maximumCapturedStderrBytes: 0,
  });
}

function commandSha256(
  command: PermanentStagingProviderVariableWriteCommand,
): string {
  return sha256Utf8(COMMAND_HASH_DOMAIN, commandCanonical(command));
}

function localAuthoritySha256(
  inspection: PermanentStagingProviderVariableWriteLocalInspection,
): string {
  return sha256Utf8(
    LOCAL_AUTHORITY_HASH_DOMAIN,
    localInspectionCanonical(inspection),
  );
}

function commandCanonical(
  command: PermanentStagingProviderVariableWriteCommand,
): string {
  if (
    command.argv.length !== 11
    || command.environment.exactNames.length !== 1
  ) {
    throw invalid();
  }
  let argv = "[";
  for (let index = 0; index < command.argv.length; index += 1) {
    const value = command.argv[index];
    if (typeof value !== "string") throw invalid();
    if (index > 0) argv += ",";
    argv += jsonPrimitive(value);
  }
  argv += "]";
  return `{"schemaVersion":${jsonPrimitive(command.schemaVersion)},`
    + `"executable":${jsonPrimitive(command.executable)},`
    + `"argv":${argv},`
    + `"environment":{"inherit":false,"exactNames":[${
      jsonPrimitive(command.environment.exactNames[0])
    }],`
    + `"valuesHandledByThisModule":false},`
    + `"shell":false,"stdin":"pipe","stdout":"ignore","stderr":"ignore",`
    + `"maximumCapturedStdoutBytes":0,"maximumCapturedStderrBytes":0}`;
}

function localInspectionCanonical(
  value: PermanentStagingProviderVariableWriteLocalInspection,
): string {
  return `{"schemaVersion":${jsonPrimitive(value.schemaVersion)},`
    + `"railwayCliVersion":${jsonPrimitive(value.railwayCliVersion)},`
    + `"railwayCliAbsolutePath":${jsonPrimitive(value.railwayCliAbsolutePath)},`
    + `"railwayCliSha256":${jsonPrimitive(value.railwayCliSha256)},`
    + `"railwayCliBytes":${jsonPrimitive(value.railwayCliBytes)},`
    + `"railwayCliIdentitySha256":${jsonPrimitive(value.railwayCliIdentitySha256)},`
    + `"absoluteCanonicalNonSymlinkPath":true,"regularFile":true,`
    + `"currentUid":true,"mode0555":true,"nlinkOne":true,`
    + `"descriptorHeld":true,"pathAndDescriptorIdentityExact":true,`
    + `"bytesHashedFromHeldDescriptor":true,"providerInvoked":false}`;
}

function sameLocalInspection(
  left: PermanentStagingProviderVariableWriteLocalInspection,
  right: PermanentStagingProviderVariableWriteLocalInspection,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.railwayCliVersion === right.railwayCliVersion
    && left.railwayCliAbsolutePath === right.railwayCliAbsolutePath
    && left.railwayCliSha256 === right.railwayCliSha256
    && left.railwayCliBytes === right.railwayCliBytes
    && left.railwayCliIdentitySha256 === right.railwayCliIdentitySha256
    && left.absoluteCanonicalNonSymlinkPath
      === right.absoluteCanonicalNonSymlinkPath
    && left.regularFile === right.regularFile
    && left.currentUid === right.currentUid
    && left.mode0555 === right.mode0555
    && left.nlinkOne === right.nlinkOne
    && left.descriptorHeld === right.descriptorHeld
    && left.pathAndDescriptorIdentityExact
      === right.pathAndDescriptorIdentityExact
    && left.bytesHashedFromHeldDescriptor
      === right.bytesHashedFromHeldDescriptor
    && left.providerInvoked === right.providerInvoked;
}

function validateInputInspection(
  value: PermanentStagingProviderVariableWriteInputInspection,
  variableName: PermanentStagingProviderVariableName,
): void {
  if (
    value.variableName !== variableName
    || !NUMBER_IS_SAFE_INTEGER(value.byteLength)
    || value.byteLength < 1
    || value.byteLength
      > PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.writeContract
        .maximumValueBytes
    || !regexpMatches(LOWERCASE_HEX_64_PATTERN, value.commitmentSha256)
    || value.stdinOnly !== true
    || value.validUtf8 !== true
    || value.controlCharactersAbsent !== true
  ) throw invalid();
}

/**
 * Opens and holds the exact pinned Railway binary for read-only observation.
 * Dependencies are raw filesystem primitives; the expected path and digest
 * remain the non-overridable canonical executor lock.
 */
export async function openPermanentStagingProviderVariableWriteLocalAuthority(
  dependencies:
  PermanentStagingProviderVariableWriteLocalAuthorityDependencies =
  DEFAULT_DEPENDENCIES,
): Promise<PermanentStagingProviderVariableWriteLocalAuthorityHandle> {
  const cli = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.railwayCli;
  const absolutePath = exactAbsolutePath(cli.absolutePath);
  if (!regexpMatches(LOWERCASE_HEX_64_PATTERN, cli.sha256)) {
    throw invalid();
  }
  if (
    !NUMBER_IS_INTEGER(O_NOFOLLOW_EXACT)
    || O_NOFOLLOW_EXACT <= 0
    || !NUMBER_IS_INTEGER(O_RDONLY_EXACT)
    || O_RDONLY_EXACT < 0
  ) throw invalid();
  let uid: bigint | undefined;
  let handle: FileHandle | undefined;
  let descriptor: CapturedFileHandle | undefined;
  let baseline: StableIdentity | undefined;
  let initialFailure: FailureState = NO_FAILURE;
  try {
    uid = safeUid(dependencies.effectiveUid());
    const before = await dependencies.lstat(absolutePath);
    const beforeIdentity = assertBinary(before, uid);
    if (await dependencies.realpath(absolutePath) !== absolutePath) {
      throw invalid();
    }
    baseline = beforeIdentity;
    handle = await dependencies.open(
      absolutePath,
      O_RDONLY_EXACT | O_NOFOLLOW_EXACT,
    );
    descriptor = captureFileHandle(handle);
    await stablePathAndDescriptor(
      absolutePath,
      descriptor,
      baseline,
      uid,
      dependencies,
    );
  } catch (error) {
    initialFailure = capture(error);
  }
  if (initialFailure.caught) {
    if (handle !== undefined) {
      try {
        await dependencies.closeHandle(handle);
      } catch {
        throw cleanupFailed();
      }
    }
    normalizeFailure(initialFailure.error);
  }
  if (
    handle === undefined
    || descriptor === undefined
    || baseline === undefined
    || uid === undefined
  ) {
    throw invalid();
  }

  const heldHandle = handle;
  const heldDescriptor = descriptor;
  const heldBaseline = baseline;
  let state: AuthorityState = "open";
  let inspected: PermanentStagingProviderVariableWriteLocalInspection
    | undefined;
  let childAttempted = false;

  const inspectExact = async (
    signal: AbortSignal,
  ): Promise<PermanentStagingProviderVariableWriteLocalInspection> => {
    checkSignal(signal);
    const descriptorIdentity = await stablePathAndDescriptor(
      absolutePath,
      heldDescriptor,
      heldBaseline,
      uid,
      dependencies,
    );
    const sha256 = await hashDescriptor(
      heldDescriptor,
      exactSize(descriptorIdentity.size),
      signal,
    );
    if (sha256 !== cli.sha256) throw invalid();
    await stablePathAndDescriptor(
      absolutePath,
      heldDescriptor,
      heldBaseline,
      uid,
      dependencies,
    );
    checkSignal(signal);
    return OBJECT_FREEZE({
      schemaVersion:
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCAL_AUTHORITY_SCHEMA,
      railwayCliVersion: cli.version,
      railwayCliAbsolutePath: absolutePath,
      railwayCliSha256: sha256,
      railwayCliBytes: exactSize(heldBaseline.size),
      railwayCliIdentitySha256: identitySha256(heldBaseline),
      absoluteCanonicalNonSymlinkPath: true,
      regularFile: true,
      currentUid: true,
      mode0555: true,
      nlinkOne: true,
      descriptorHeld: true,
      pathAndDescriptorIdentityExact: true,
      bytesHashedFromHeldDescriptor: true,
      providerInvoked: false,
    } as const satisfies PermanentStagingProviderVariableWriteLocalInspection);
  };

  const closeHeld = async (): Promise<void> => {
    try {
      await dependencies.closeHandle(heldHandle);
      state = "closed";
    } catch {
      state = "failed";
      throw cleanupFailed();
    }
  };

  return OBJECT_FREEZE({
    async inspect(signal) {
      if (state !== "open") throw invalid();
      state = "inspecting";
      try {
        const observation = await inspectExact(signal);
        inspected = observation;
        return observation;
      } catch (error) {
        normalizeFailure(error);
      } finally {
        if (state === "inspecting") state = "open";
      }
    },
    async reassert(signal) {
      if (state !== "open" || inspected === undefined) throw invalid();
      state = "inspecting";
      try {
        const observation = await inspectExact(signal);
        if (!sameLocalInspection(observation, inspected)) {
          throw invalid();
        }
        return observation;
      } catch (error) {
        normalizeFailure(error);
      } finally {
        if (state === "inspecting") state = "open";
      }
    },
    buildCreateOnlyCommand(variableNameInput) {
      if (state !== "open") throw invalid();
      exactVariableName(variableNameInput);
      return commandFor(variableNameInput);
    },
    async writeExactlyOnceWithInjectedChild(
      variableNameInput,
      input,
      launchChild,
      signal,
    ) {
      if (
        state !== "open"
        || inspected === undefined
        || childAttempted
        || typeof launchChild !== "function"
        || !isPermanentStagingProviderVariableWriteInputHandleAuthority(input)
      ) throw invalid();
      exactVariableName(variableNameInput);
      checkSignal(signal);
      state = "writing";
      let inputInspection:
      PermanentStagingProviderVariableWriteInputInspection | undefined;
      let child: CapturedInjectedChild | undefined;
      let childResult:
      PermanentStagingProviderVariableWriteInjectedChildResult | undefined;
      let operationFailure: FailureState = NO_FAILURE;
      let cleanupFailure = false;
      let abortObserved = false;
      let abortIssued = false;
      let abortListenerAdded = false;
      let writerWindowOpen = false;
      let writerProtocolViolation = false;
      let stdinWriteAttempts = 0;
      let stdinWriteSettlement: Promise<void> | null = null;
      const abortChild = (): void => {
        abortObserved = true;
        if (child !== undefined && !abortIssued) {
          abortIssued = true;
          try {
            REFLECT_APPLY(child.abort, child.receiver, []);
          } catch {
            // The close promise below remains the authoritative settlement.
          }
        }
      };

      try {
        try {
          inputInspection = input.inspect();
        } catch (error) {
          if (isGenuineInputCleanupFailure(error)) cleanupFailure = true;
          throw error;
        }
        validateInputInspection(inputInspection, variableNameInput);
        const local = await inspectExact(signal);
        if (!sameLocalInspection(local, inspected)) throw invalid();
        let reassertedInput: PermanentStagingProviderVariableWriteInputInspection;
        try {
          reassertedInput = input.reassert();
        } catch (error) {
          if (isGenuineInputCleanupFailure(error)) cleanupFailure = true;
          throw error;
        }
        validateInputInspection(reassertedInput, variableNameInput);
        if (
          reassertedInput.commitmentSha256
          !== inputInspection.commitmentSha256
        ) throw invalid();
        const command = commandFor(variableNameInput);
        const localAuthorityDigest = localAuthoritySha256(local);
        const commandDigest = commandSha256(command);
        childAttempted = true;
        child = captureInjectedChild(launchChild(command)) ?? undefined;
        if (child === undefined) throw invalid();
        REFLECT_APPLY(EVENT_TARGET_ADD_EVENT_LISTENER, signal, [
          "abort",
          abortChild,
          { once: true },
        ]);
        abortListenerAdded = true;
        if (signalAborted(signal)) abortChild();
        try {
          writerWindowOpen = true;
          try {
            await input.writeExactlyOnce(
              async (value) => {
                if (!writerWindowOpen || stdinWriteAttempts !== 0) {
                  writerProtocolViolation = true;
                  return;
                }
                stdinWriteAttempts = 1;
                const settlement = (async (): Promise<void> => {
                  if (signalAborted(signal)) throw writeFailed();
                  const writeResult = REFLECT_APPLY(
                    child!.writeStdin,
                    child!.receiver,
                    [value],
                  ) as unknown;
                  if (!REFLECT_APPLY(UTIL_IS_PROMISE, utilTypes, [writeResult])) {
                    throw writeFailed();
                  }
                  await writeResult;
                })();
                stdinWriteSettlement = settlement;
                await settlement;
              },
              signal,
            );
          } finally {
            writerWindowOpen = false;
          }
          const settlement = stdinWriteSettlement;
          if (
            stdinWriteAttempts !== 1
            || settlement === null
            || writerProtocolViolation
          ) throw writeFailed();
          await settlement;
          if (writerProtocolViolation) throw writeFailed();
        } catch (error) {
          if (isGenuineInputCleanupFailure(error)) cleanupFailure = true;
          operationFailure = capture(error);
          abortChild();
        }
        try {
          const observedResult = await child.closed;
          childResult = exactChildResult(observedResult) ?? undefined;
          if (childResult === undefined && !operationFailure.caught) {
            operationFailure = capture(writeFailed());
          }
        } catch (error) {
          if (!operationFailure.caught) operationFailure = capture(error);
        }
        if (
          operationFailure.caught
          || abortObserved
          || childResult?.exitCode !== 0
          || childResult.signal !== null
        ) throw writeFailed();
        return OBJECT_FREEZE({
          schemaVersion:
            PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCAL_RECEIPT_SCHEMA,
          variableName: variableNameInput,
          inputCommitmentSha256: inputInspection.commitmentSha256,
          localAuthoritySha256: localAuthorityDigest,
          commandSha256: commandDigest,
          childAttempts: 1,
          stdinWrites: 1,
          exitCode: 0,
          signal: null,
          stdoutBytesCaptured: 0,
          stderrBytesCaptured: 0,
          childCloseAwaited: true,
          providerAcknowledgementInspected: false,
        } as const satisfies PermanentStagingProviderVariableWriteLocalReceipt);
      } catch (error) {
        if (child !== undefined && childResult === undefined) {
          abortChild();
          try {
            await child.closed;
          } catch {
            // A failed child still settles the one ambiguous attempt.
          }
        }
        if (childAttempted) throw writeFailed();
        normalizeFailure(error);
      } finally {
        if (abortListenerAdded) {
          try {
            REFLECT_APPLY(EVENT_TARGET_REMOVE_EVENT_LISTENER, signal, [
              "abort",
              abortChild,
            ]);
          } catch {
            cleanupFailure = true;
          }
        }
        try {
          input.close();
        } catch {
          cleanupFailure = true;
        }
        if (cleanupFailure) {
          state = "failed";
          throw cleanupFailed();
        }
        state = "open";
      }
    },
    async close() {
      if (state === "closed") return;
      if (state === "inspecting" || state === "writing" || state === "closing") {
        throw cleanupFailed();
      }
      if (state === "failed") {
        try {
          await dependencies.closeHandle(heldHandle);
        } catch {
          // Preserve the dominant cleanup failure below.
        }
        throw cleanupFailed();
      }
      state = "closing";
      await closeHeld();
    },
  } satisfies PermanentStagingProviderVariableWriteLocalAuthorityHandle);
}
