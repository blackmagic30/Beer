import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_ADAPTER_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-process-adapter-authority/v1" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PRIVATE_COPY_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-private-executable-copy/v1" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-process-adapter-receipt/v1" as const;

const PRIVATE_COPY_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/private-executable-copy/v1\0";
const ENVIRONMENT_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/process-environment/v1\0";
const STDIN_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/process-stdin/v1\0";
const PROCESS_GROUP_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/process-group/v1\0";
const PROCESS_ADAPTER_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/process-adapter/v1\0";
const PROCESS_RECEIPT_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/process-receipt/v1\0";
const MAX_PATH_BYTES = 4_096;
const MAX_EXECUTABLE_BYTES = 32 * 1_024 * 1_024;
const MAX_TOKEN_BYTES = 4_096;
const READ_CHUNK_BYTES = 64 * 1_024;
const TERM_GRACE_MS = 1_000;
const REAP_RETRY_MS = 25;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VARIABLE_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

const ARRAY_INTRINSIC = Array;
const BUFFER_INTRINSIC = Buffer;
const CRYPTO_INTRINSIC = crypto;
const FS_INTRINSIC = fs;
const GLOBAL_THIS_INTRINSIC = globalThis;
const JSON_INTRINSIC = JSON;
const MATH_INTRINSIC = Math;
const OBJECT_INTRINSIC = Object;
const PATH_INTRINSIC = path;
const PROCESS_INTRINSIC = process;
const REFLECT_INTRINSIC = Reflect;
const UTIL_TYPES_INTRINSIC = utilTypes;
const ARRAY_IS_ARRAY = ARRAY_INTRINSIC.isArray;
const ABORT_SIGNAL_ABORTED_GETTER = OBJECT_INTRINSIC.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const BIGINT_CONSTRUCTOR = BigInt;
const BIGINT_TO_STRING = BigInt.prototype.toString;
const BUFFER_ALLOC = BUFFER_INTRINSIC.alloc;
const BUFFER_BYTE_LENGTH = BUFFER_INTRINSIC.byteLength;
const BUFFER_IS_BUFFER = BUFFER_INTRINSIC.isBuffer;
const BUFFER_PROTOTYPE = BUFFER_INTRINSIC.prototype;
const CRYPTO_CREATE_HASH = CRYPTO_INTRINSIC.createHash;
const FS_PROMISES = FS_INTRINSIC.promises;
const FS_CLOSE_CALLBACK = FS_INTRINSIC.close;
const FS_FSTAT_CALLBACK = FS_INTRINSIC.fstat;
const FS_LSTAT_CALLBACK = FS_INTRINSIC.lstat;
const FS_OPEN_CALLBACK = FS_INTRINSIC.open;
const FS_READ_CALLBACK = FS_INTRINSIC.read;
const FS_REALPATH_CALLBACK = FS_INTRINSIC.realpath.native;
const FS_LSTAT = FS_PROMISES.lstat;
const FS_REALPATH = FS_PROMISES.realpath;
const FS_O_RDONLY = fs.constants.O_RDONLY;
const FS_O_NOFOLLOW = fs.constants.O_NOFOLLOW;
const JSON_STRINGIFY = JSON_INTRINSIC.stringify;
const MATH_MIN = MATH_INTRINSIC.min;
const NUMBER_CONSTRUCTOR = Number;
const NUMBER_IS_INTEGER = Number.isInteger;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_CREATE = OBJECT_INTRINSIC.create;
const OBJECT_DEFINE_PROPERTY = OBJECT_INTRINSIC.defineProperty;
const OBJECT_FREEZE = OBJECT_INTRINSIC.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  OBJECT_INTRINSIC.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  OBJECT_INTRINSIC.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = OBJECT_INTRINSIC.getPrototypeOf;
const OBJECT_HAS_OWN = OBJECT_INTRINSIC.hasOwn;
const OBJECT_SET_PROTOTYPE_OF = OBJECT_INTRINSIC.setPrototypeOf;
const PATH_DIRNAME = PATH_INTRINSIC.dirname;
const PATH_IS_ABSOLUTE = PATH_INTRINSIC.isAbsolute;
const PATH_NORMALIZE = PATH_INTRINSIC.normalize;
const PATH_PARSE = PATH_INTRINSIC.parse;
const PATH_RESOLVE = PATH_INTRINSIC.resolve;
const PROMISE_CONSTRUCTOR = Promise;
const PROMISE_CATCH = Promise.prototype.catch;
const PROCESS_GETEUID = PROCESS_INTRINSIC.geteuid;
const REFLECT_APPLY = REFLECT_INTRINSIC.apply;
const REFLECT_DELETE_PROPERTY = REFLECT_INTRINSIC.deleteProperty;
const REFLECT_OWN_KEYS = REFLECT_INTRINSIC.ownKeys;
const REGEXP_EXEC = RegExp.prototype.exec;
const SET_TIMEOUT = GLOBAL_THIS_INTRINSIC.setTimeout;
const STRING_CONSTRUCTOR = String;
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const UTIL_IS_PROMISE = UTIL_TYPES_INTRINSIC.isPromise;
const UTIL_IS_PROXY = UTIL_TYPES_INTRINSIC.isProxy;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;
const HASH_PROBE = REFLECT_APPLY(
  CRYPTO_CREATE_HASH,
  CRYPTO_INTRINSIC,
  ["sha256"],
) as
  ReturnType<typeof crypto.createHash>;
const HASH_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(HASH_PROBE) as {
  readonly update: (...args: never[]) => unknown;
  readonly digest: (...args: never[]) => unknown;
};
const HASH_UPDATE = HASH_PROTOTYPE.update;
const HASH_DIGEST = HASH_PROTOTYPE.digest;
REFLECT_APPLY(HASH_DIGEST, HASH_PROBE, []);
const STAT_MODE_MASK = REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [
  fs.constants.S_IFMT,
]) as bigint;
const STAT_MODE_DIRECTORY = REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [
  fs.constants.S_IFDIR,
]) as bigint;
const STAT_MODE_REGULAR = REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [
  fs.constants.S_IFREG,
]) as bigint;
const MAX_EXECUTABLE_BYTES_BIGINT = REFLECT_APPLY(
  BIGINT_CONSTRUCTOR,
  undefined,
  [MAX_EXECUTABLE_BYTES],
) as bigint;

type FileHandle = fs.promises.FileHandle;
type ProcessSignal = "SIGTERM" | "SIGKILL";

interface CapturedFileHandle {
  readonly receiver: FileHandle;
  readonly read: FileHandle["read"];
  readonly stat: FileHandle["stat"];
  readonly close: FileHandle["close"];
}

export type PermanentStagingProviderVariableWriteProcessAdapterFailureCode =
  | "process_adapter_invalid"
  | "process_write_failed"
  | "cleanup_failed";

export class PermanentStagingProviderVariableWriteProcessAdapterError
  extends Error {
  readonly code!: PermanentStagingProviderVariableWriteProcessAdapterFailureCode;

  constructor(code: PermanentStagingProviderVariableWriteProcessAdapterFailureCode) {
    super(code);
    OBJECT_DEFINE_PROPERTY(this, "name", {
      configurable: true,
      enumerable: true,
      value: "PermanentStagingProviderVariableWriteProcessAdapterError",
      writable: true,
    });
    OBJECT_DEFINE_PROPERTY(this, "message", {
      configurable: true,
      enumerable: false,
      value: code,
      writable: true,
    });
    OBJECT_DEFINE_PROPERTY(this, "code", {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    });
  }
}

export interface PermanentStagingProviderVariableWriteProcessSpawnOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly stdio: readonly ["pipe", "ignore", "ignore"];
  readonly detached: true;
}

export interface PermanentStagingProviderVariableWriteSpawnedChildFacade {
  readonly pid: number;
  readonly stdin: {
    readonly write: (value: Buffer, callback: (error?: unknown) => void) => unknown;
    readonly end: (callback: (error?: unknown) => void) => unknown;
    readonly once: (event: "error", listener: () => void) => unknown;
    readonly removeListener: (event: "error", listener: () => void) => unknown;
  };
  readonly once: (
    event: "error" | "close",
    listener: (...args: unknown[]) => void,
  ) => unknown;
  readonly removeListener: (
    event: "error" | "close",
    listener: (...args: unknown[]) => void,
  ) => unknown;
}

/**
 * Explicit activation capability. This module deliberately has no native
 * default. A thrown call must mean no child was created; a created child must
 * return the complete own-data facade, including its positive process-group id.
 */
export type PermanentStagingProviderVariableWriteProcessSpawn = (
  privateExecutableCopyPath: string,
  argv: readonly string[],
  options: PermanentStagingProviderVariableWriteProcessSpawnOptions,
) => PermanentStagingProviderVariableWriteSpawnedChildFacade;

/** Sends a signal to the detached group whose positive id equals the child pid. */
export type PermanentStagingProviderVariableWriteProcessGroupKill = (
  processGroupId: number,
  signal: ProcessSignal,
) => unknown;

/** Returns true only when the detached process group no longer exists. */
export type PermanentStagingProviderVariableWriteProcessGroupProbe = (
  processGroupId: number,
) => boolean | Promise<boolean>;

export interface PermanentStagingProviderVariableWriteProcessCommand {
  readonly schemaVersion:
    "pintpath-permanent-staging-provider-variable-write-command/v2";
  /** Deliberately ignored; execution is authorized only by the held private copy. */
  readonly executable: unknown;
  readonly executableAuthority: {
    readonly privateExecutableCopySha256: string;
    readonly privateExecutableCopyIdentitySha256: string;
    readonly privateExecutableCopyAuthoritySha256: string;
    readonly descriptorHeld: true;
  };
  readonly argv: readonly string[];
  readonly environment: {
    readonly inherit: false;
    readonly prototype: "null";
    readonly ownEnumerableDataPropertiesOnly: true;
    readonly exactNames: readonly ["RAILWAY_TOKEN"];
    readonly valuesHandledByThisModule: false;
  };
  readonly shell: false;
  readonly stdin: "pipe";
  readonly stdinWrites: 1;
  readonly stdinEndCalls: 1;
  readonly stdout: "ignore";
  readonly stderr: "ignore";
  readonly maximumCapturedStdoutBytes: 0;
  readonly maximumCapturedStderrBytes: 0;
  readonly detached: true;
  readonly abortSignalSequence: readonly ["SIGTERM", "SIGKILL"];
  readonly processGroupEmptyBeforeSettlement: true;
}

export interface PermanentStagingProviderVariableWritePrivateCopyAuthority {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PRIVATE_COPY_SCHEMA;
  readonly absolutePath: string;
  readonly sourceSha256: string;
  readonly copySha256: string;
  readonly bytes: number;
  readonly identitySha256: string;
  readonly parentMode0700: true;
  readonly absoluteCanonicalNonSymlinkPath: true;
  readonly regularFile: true;
  readonly currentUid: true;
  readonly mode0500: true;
  readonly nlinkOne: true;
  readonly descriptorHeld: true;
  readonly pathAndDescriptorIdentityExact: true;
  readonly bytesHashedFromHeldDescriptor: true;
  readonly sourceDigestExact: true;
}

export interface PermanentStagingProviderVariableWriteProcessAdapterAuthority {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_ADAPTER_SCHEMA;
  readonly privateExecutableCopy:
    PermanentStagingProviderVariableWritePrivateCopyAuthority;
  readonly privateExecutableCopyAuthoritySha256: string;
  readonly environmentAuthoritySha256: string;
  readonly stdinAuthoritySha256: string;
  readonly processGroupAuthoritySha256: string;
  readonly exactlyOneChild: true;
  readonly injectedSpawnOnly: true;
  readonly shell: false;
  readonly environmentNullPrototype: true;
  readonly environmentExactNames: readonly ["RAILWAY_TOKEN"];
  readonly stdinPipe: true;
  readonly stdinCompleteWriteBeforeEof: true;
  readonly stdoutDiscarded: true;
  readonly stderrDiscarded: true;
  readonly detachedProcessGroup: true;
  readonly abortTermThenKill: true;
  readonly closeAndErrorSettled: true;
  readonly providerInvokedDuringInspection: false;
  readonly processAdapterAuthoritySha256: string;
}

export interface PermanentStagingProviderVariableWriteProcessAdapterBinding {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_ADAPTER_SCHEMA;
  readonly privateExecutableCopyAbsolutePath: string;
  readonly privateExecutableCopySha256: string;
  readonly privateExecutableCopyBytes: number;
  readonly privateExecutableCopyIdentitySha256: string;
  readonly privateExecutableCopyAuthoritySha256: string;
  readonly environmentAuthoritySha256: string;
  readonly stdinAuthoritySha256: string;
  readonly processGroupAuthoritySha256: string;
  readonly processAdapterAuthoritySha256: string;
  readonly privateExecutableCopyDescriptorHeld: true;
  readonly privateExecutableCopyParentMode0700: true;
  readonly injectedSpawnOnly: true;
  readonly providerInvokedDuringInspection: false;
}

export interface PermanentStagingProviderVariableWriteProcessAdapterReceipt {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_RECEIPT_SCHEMA;
  readonly processAdapterAuthoritySha256: string;
  readonly privateExecutableCopyAuthoritySha256: string;
  readonly environmentAuthoritySha256: string;
  readonly stdinAuthoritySha256: string;
  readonly processGroupAuthoritySha256: string;
  readonly childAttempts: 1;
  readonly shell: false;
  readonly environmentNullPrototype: true;
  readonly environmentExactNames: readonly ["RAILWAY_TOKEN"];
  readonly stdinWrites: 1;
  readonly stdinWriteCompleted: true;
  readonly stdinEof: true;
  readonly stdoutBytesCaptured: 0;
  readonly stderrBytesCaptured: 0;
  readonly detachedProcessGroup: true;
  readonly abortTermThenKill: true;
  readonly processGroupReaped: true;
  readonly processGroupEmpty: true;
  readonly closeAndErrorSettled: true;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface PermanentStagingProviderVariableWriteProcessChildResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly processAdapterReceipt:
    PermanentStagingProviderVariableWriteProcessAdapterReceipt;
  readonly processAdapterReceiptSha256: string;
}

export interface PermanentStagingProviderVariableWriteProcessChild {
  writeStdin(value: Buffer): Promise<void>;
  abort(): void;
  readonly closed: Promise<PermanentStagingProviderVariableWriteProcessChildResult>;
}

export type PermanentStagingProviderVariableWriteProcessLauncher = (
  command: PermanentStagingProviderVariableWriteProcessCommand,
  signal: AbortSignal,
) => Promise<PermanentStagingProviderVariableWriteProcessChild>;

export interface PermanentStagingProviderVariableWriteProcessAdapterHandle {
  inspect(signal: AbortSignal):
    Promise<PermanentStagingProviderVariableWriteProcessAdapterAuthority>;
  reassert(signal: AbortSignal):
    Promise<PermanentStagingProviderVariableWriteProcessAdapterAuthority>;
  inspectLocalAuthorityBinding(signal: AbortSignal):
    Promise<PermanentStagingProviderVariableWriteProcessAdapterBinding>;
  createLauncher(railwayToken: string):
    PermanentStagingProviderVariableWriteProcessLauncher;
  close(): Promise<void>;
}

export interface PermanentStagingProviderVariableWriteProcessAdapterDependencies {
  readonly open: (filename: string, flags: number) => Promise<FileHandle>;
  readonly lstat: (filename: string) => Promise<fs.BigIntStats>;
  readonly realpath: (filename: string) => Promise<string>;
  readonly effectiveUid: () => number;
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

const ERRORS = new WeakMap<object, PermanentStagingProviderVariableWriteProcessAdapterFailureCode>();
const PROCESS_ADAPTER_BINDING_BRANDS = new WeakSet<object>();
const PROCESS_ADAPTER_ATTEMPT_BINDINGS = new WeakMap<object, object>();
const PROCESS_ADAPTER_LAUNCHER_ATTEMPTS = new WeakMap<object, object>();
const PROCESS_ADAPTER_CHILD_ATTEMPTS = new WeakMap<object, object>();
const PROCESS_ADAPTER_RESULT_ATTEMPTS = new WeakMap<object, object>();
const CLAIMED_PROCESS_ADAPTER_LAUNCHERS = new WeakSet<object>();
const CLAIMED_PROCESS_ADAPTER_CHILDREN = new WeakSet<object>();
const CLAIMED_PROCESS_ADAPTER_RESULTS = new WeakSet<object>();
const DEFAULT_NATIVE_FILE_HANDLES = new WeakSet<object>();
const ERROR_GET = WeakMap.prototype.get;
const ERROR_SET = WeakMap.prototype.set;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;

function failure(
  code: PermanentStagingProviderVariableWriteProcessAdapterFailureCode,
): PermanentStagingProviderVariableWriteProcessAdapterError {
  const error = new PermanentStagingProviderVariableWriteProcessAdapterError(code);
  REFLECT_APPLY(ERROR_SET, ERRORS, [error, code]);
  return error;
}

function invalid(): PermanentStagingProviderVariableWriteProcessAdapterError {
  return failure("process_adapter_invalid");
}

function writeFailed(): PermanentStagingProviderVariableWriteProcessAdapterError {
  return failure("process_write_failed");
}

function cleanupFailed(): PermanentStagingProviderVariableWriteProcessAdapterError {
  return failure("cleanup_failed");
}

function normalize(error: unknown): PermanentStagingProviderVariableWriteProcessAdapterError {
  if (typeof error === "object" && error !== null) {
    const code = REFLECT_APPLY(ERROR_GET, ERRORS, [error]);
    if (
      code === "process_adapter_invalid"
      || code === "process_write_failed"
      || code === "cleanup_failed"
    ) return failure(code);
  }
  return invalid();
}

function freezeNullRecord<T extends object>(value: T): T {
  REFLECT_APPLY(OBJECT_SET_PROTOTYPE_OF, OBJECT_INTRINSIC, [value, null]);
  return OBJECT_FREEZE(value);
}

export function isPermanentStagingProviderVariableWriteProcessAdapterBinding(
  value: unknown,
): value is PermanentStagingProviderVariableWriteProcessAdapterBinding {
  return typeof value === "object"
    && value !== null
    && REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [value]) === false
    && REFLECT_APPLY(WEAK_SET_HAS, PROCESS_ADAPTER_BINDING_BRANDS, [value])
      === true;
}

function exactUnproxiedReference(value: unknown): value is object {
  try {
    return (typeof value === "object" && value !== null
      || typeof value === "function")
      && REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [value]) === false;
  } catch {
    return false;
  }
}

/**
 * Consumes the one launcher authority minted by the exact adapter binding.
 * Digest equality alone is deliberately insufficient.
 */
export function claimPermanentStagingProviderVariableWriteProcessLauncherAuthority(
  binding: unknown,
  launcher: unknown,
): launcher is PermanentStagingProviderVariableWriteProcessLauncher {
  try {
    if (
      !isPermanentStagingProviderVariableWriteProcessAdapterBinding(binding)
      || !exactUnproxiedReference(launcher)
      || REFLECT_APPLY(WEAK_SET_HAS, CLAIMED_PROCESS_ADAPTER_LAUNCHERS, [launcher])
        === true
    ) return false;
    const attempt = REFLECT_APPLY(
      WEAK_MAP_GET,
      PROCESS_ADAPTER_LAUNCHER_ATTEMPTS,
      [launcher],
    );
    if (
      !exactUnproxiedReference(attempt)
      || REFLECT_APPLY(WEAK_MAP_GET, PROCESS_ADAPTER_ATTEMPT_BINDINGS, [attempt])
        !== binding
    ) return false;
    REFLECT_APPLY(WEAK_SET_ADD, CLAIMED_PROCESS_ADAPTER_LAUNCHERS, [launcher]);
    return true;
  } catch {
    return false;
  }
}

/** Consumes the exact child produced by a previously claimed launcher. */
export function claimPermanentStagingProviderVariableWriteProcessChildAuthority(
  launcher: unknown,
  child: unknown,
): child is PermanentStagingProviderVariableWriteProcessChild {
  try {
    if (
      !exactUnproxiedReference(launcher)
      || !exactUnproxiedReference(child)
      || REFLECT_APPLY(WEAK_SET_HAS, CLAIMED_PROCESS_ADAPTER_LAUNCHERS, [launcher])
        !== true
      || REFLECT_APPLY(WEAK_SET_HAS, CLAIMED_PROCESS_ADAPTER_CHILDREN, [child])
        === true
    ) return false;
    const launcherAttempt = REFLECT_APPLY(
      WEAK_MAP_GET,
      PROCESS_ADAPTER_LAUNCHER_ATTEMPTS,
      [launcher],
    );
    if (
      !exactUnproxiedReference(launcherAttempt)
      || REFLECT_APPLY(WEAK_MAP_GET, PROCESS_ADAPTER_CHILD_ATTEMPTS, [child])
        !== launcherAttempt
    ) return false;
    REFLECT_APPLY(WEAK_SET_ADD, CLAIMED_PROCESS_ADAPTER_CHILDREN, [child]);
    return true;
  } catch {
    return false;
  }
}

/** Consumes the exact result produced by a previously claimed child. */
export function claimPermanentStagingProviderVariableWriteProcessChildResultAuthority(
  child: unknown,
  result: unknown,
): result is PermanentStagingProviderVariableWriteProcessChildResult {
  try {
    if (
      !exactUnproxiedReference(child)
      || !exactUnproxiedReference(result)
      || REFLECT_APPLY(WEAK_SET_HAS, CLAIMED_PROCESS_ADAPTER_CHILDREN, [child])
        !== true
      || REFLECT_APPLY(WEAK_SET_HAS, CLAIMED_PROCESS_ADAPTER_RESULTS, [result])
        === true
    ) return false;
    const childAttempt = REFLECT_APPLY(
      WEAK_MAP_GET,
      PROCESS_ADAPTER_CHILD_ATTEMPTS,
      [child],
    );
    if (
      !exactUnproxiedReference(childAttempt)
      || REFLECT_APPLY(WEAK_MAP_GET, PROCESS_ADAPTER_RESULT_ATTEMPTS, [result])
        !== childAttempt
    ) return false;
    REFLECT_APPLY(WEAK_SET_ADD, CLAIMED_PROCESS_ADAPTER_RESULTS, [result]);
    return true;
  } catch {
    return false;
  }
}

function regexp(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY(REGEXP_EXEC, pattern, [value]) !== null;
}

function sha256Exact(value: unknown): value is string {
  return typeof value === "string" && regexp(SHA256_PATTERN, value);
}

function jsonPrimitive(value: string | number | boolean | null): string {
  const rendered = REFLECT_APPLY(JSON_STRINGIFY, JSON_INTRINSIC, [value]);
  if (typeof rendered !== "string") throw invalid();
  return rendered;
}

function hashCanonical(domain: string, canonical: string): string {
  const digest = REFLECT_APPLY(
    CRYPTO_CREATE_HASH,
    CRYPTO_INTRINSIC,
    ["sha256"],
  );
  REFLECT_APPLY(HASH_UPDATE, digest, [domain, "utf8"]);
  REFLECT_APPLY(HASH_UPDATE, digest, [canonical, "utf8"]);
  const rendered = REFLECT_APPLY(HASH_DIGEST, digest, ["hex"]);
  if (!sha256Exact(rendered)) throw invalid();
  return rendered;
}

function checkSignal(signal: AbortSignal): void {
  if (
    typeof signal !== "object"
    || signal === null
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [signal])
    || typeof ABORT_SIGNAL_ABORTED_GETTER !== "function"
  ) throw invalid();
  let aborted: unknown;
  try {
    aborted = REFLECT_APPLY(ABORT_SIGNAL_ABORTED_GETTER, signal, []);
  } catch {
    throw invalid();
  }
  if (aborted !== false) throw invalid();
}

function absolutePath(value: unknown): string {
  if (
    typeof value !== "string"
    || !REFLECT_APPLY(PATH_IS_ABSOLUTE, PATH_INTRINSIC, [value])
    || REFLECT_APPLY(PATH_NORMALIZE, PATH_INTRINSIC, [value]) !== value
    || REFLECT_APPLY(PATH_RESOLVE, PATH_INTRINSIC, [value]) !== value
    || value === (REFLECT_APPLY(
      PATH_PARSE,
      PATH_INTRINSIC,
      [value],
    ) as path.ParsedPath).root
    || regexp(CONTROL_PATTERN, value)
    || REFLECT_APPLY(
      BUFFER_BYTE_LENGTH,
      BUFFER_INTRINSIC,
      [value, "utf8"],
    ) > MAX_PATH_BYTES
  ) throw invalid();
  return value;
}

function safeUid(value: number): bigint {
  if (!NUMBER_IS_SAFE_INTEGER(value) || value < 0) throw invalid();
  return REFLECT_APPLY(BIGINT_CONSTRUCTOR, undefined, [value]) as bigint;
}

function stableIdentity(stat: unknown): StableIdentity {
  if (
    typeof stat !== "object"
    || stat === null
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [stat])
  ) throw invalid();
  const descriptors = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    OBJECT_INTRINSIC,
    [stat],
  ) as Record<PropertyKey, PropertyDescriptor>;
  const read = (key: keyof StableIdentity): bigint => {
    const descriptor = descriptors[key];
    if (
      !REFLECT_APPLY(
        OBJECT_HAS_OWN,
        OBJECT_INTRINSIC,
        [descriptors, key],
      )
      || descriptor === undefined
      || !REFLECT_APPLY(
        OBJECT_HAS_OWN,
        OBJECT_INTRINSIC,
        [descriptor, "value"],
      )
      || typeof descriptor.value !== "bigint"
    ) throw invalid();
    return descriptor.value;
  };
  return freezeNullRecord({
    dev: read("dev"),
    ino: read("ino"),
    uid: read("uid"),
    gid: read("gid"),
    mode: read("mode"),
    nlink: read("nlink"),
    size: read("size"),
    mtimeNs: read("mtimeNs"),
    ctimeNs: read("ctimeNs"),
  });
}

function nativeStatSnapshot(stat: unknown): fs.BigIntStats {
  return freezeNullRecord({ ...stableIdentity(stat) }) as unknown as
    fs.BigIntStats;
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

function assertPrivateParent(stat: unknown, uid: bigint): StableIdentity {
  const value = stableIdentity(stat);
  if (
    (value.mode & STAT_MODE_MASK) !== STAT_MODE_DIRECTORY
    || value.uid !== uid
    || (value.mode & 0o7777n) !== 0o700n
  ) throw invalid();
  return value;
}

function assertPrivateCopy(stat: unknown, uid: bigint): StableIdentity {
  const value = stableIdentity(stat);
  if (
    (value.mode & STAT_MODE_MASK) !== STAT_MODE_REGULAR
    || value.uid !== uid
    || value.nlink !== 1n
    || (value.mode & 0o7777n) !== 0o500n
    || value.size < 1n
    || value.size > MAX_EXECUTABLE_BYTES_BIGINT
  ) throw invalid();
  return value;
}

function identitySha256(value: StableIdentity): string {
  const bigintString = (input: bigint, radix: number): string => {
    const rendered = REFLECT_APPLY(BIGINT_TO_STRING, input, [radix]);
    if (typeof rendered !== "string") throw invalid();
    return rendered;
  };
  const canonical = `{"dev":${jsonPrimitive(bigintString(value.dev, 10))},`
    + `"ino":${jsonPrimitive(bigintString(value.ino, 10))},`
    + `"uid":${jsonPrimitive(bigintString(value.uid, 10))},`
    + `"gid":${jsonPrimitive(bigintString(value.gid, 10))},`
    + `"mode":${jsonPrimitive(bigintString(value.mode, 8))},`
    + `"nlink":${jsonPrimitive(bigintString(value.nlink, 10))},`
    + `"size":${jsonPrimitive(bigintString(value.size, 10))},`
    + `"mtimeNs":${jsonPrimitive(bigintString(value.mtimeNs, 10))},`
    + `"ctimeNs":${jsonPrimitive(bigintString(value.ctimeNs, 10))}}`;
  return hashCanonical(PRIVATE_COPY_HASH_DOMAIN, canonical);
}

function captureFileHandle(handle: FileHandle): CapturedFileHandle {
  if (
    typeof handle !== "object"
    || handle === null
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [handle])
  ) throw invalid();
  const prototype = OBJECT_GET_PROTOTYPE_OF(handle);
  if (
    prototype !== null
    && (typeof prototype !== "object"
      || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [prototype]))
  ) throw invalid();
  const descriptors = prototype === null
    ? OBJECT_CREATE(null) as Record<PropertyKey, PropertyDescriptor>
    : REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
      OBJECT_INTRINSIC,
      [prototype],
    ) as Record<PropertyKey, PropertyDescriptor>;
  const method = (key: "read" | "stat" | "close"): Function => {
    const own = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(handle, key);
    const inherited = REFLECT_APPLY(
      OBJECT_HAS_OWN,
      OBJECT_INTRINSIC,
      [descriptors, key],
    ) ? descriptors[key] : undefined;
    const descriptor = own ?? inherited;
    const candidate = descriptor !== undefined
      && REFLECT_APPLY(
        OBJECT_HAS_OWN,
        OBJECT_INTRINSIC,
        [descriptor, "value"],
      )
      ? descriptor.value
      : undefined;
    if (typeof candidate !== "function") throw invalid();
    return candidate;
  };
  return freezeNullRecord({
    receiver: handle,
    read: method("read") as FileHandle["read"],
    stat: method("stat") as FileHandle["stat"],
    close: method("close") as FileHandle["close"],
  });
}

async function descriptorSha256(
  handle: CapturedFileHandle,
  size: number,
): Promise<string> {
  const digest = REFLECT_APPLY(
    CRYPTO_CREATE_HASH,
    CRYPTO_INTRINSIC,
    ["sha256"],
  );
  let offset = 0;
  while (offset < size) {
    const length = REFLECT_APPLY(
      MATH_MIN,
      MATH_INTRINSIC,
      [READ_CHUNK_BYTES, size - offset],
    );
    const buffer = REFLECT_APPLY(
      BUFFER_ALLOC,
      BUFFER_INTRINSIC,
      [length],
    ) as Buffer;
    try {
      let filled = 0;
      while (filled < length) {
        const pending = REFLECT_APPLY(handle.read, handle.receiver, [
          buffer,
          filled,
          length - filled,
          offset + filled,
        ]) as unknown;
        if (!REFLECT_APPLY(UTIL_IS_PROMISE, UTIL_TYPES_INTRINSIC, [pending])) {
          throw invalid();
        }
        const result = await pending;
        const resultDescriptors = ownDescriptors(result);
        const bytesRead = dataValue(resultDescriptors, "bytesRead");
        const returnedBuffer = dataValue(resultDescriptors, "buffer");
        if (
          returnedBuffer !== buffer
          || !NUMBER_IS_SAFE_INTEGER(bytesRead)
          || (bytesRead as number) < 1
          || (bytesRead as number) > length - filled
        ) throw invalid();
        filled += bytesRead as number;
      }
      REFLECT_APPLY(HASH_UPDATE, digest, [buffer]);
      offset += length;
    } finally {
      REFLECT_APPLY(UINT8_ARRAY_FILL, buffer, [0]);
    }
  }
  const rendered = REFLECT_APPLY(HASH_DIGEST, digest, ["hex"]);
  if (!sha256Exact(rendered)) throw invalid();
  return rendered;
}

function exactSize(value: bigint): number {
  const rendered = REFLECT_APPLY(NUMBER_CONSTRUCTOR, undefined, [value]);
  if (!NUMBER_IS_SAFE_INTEGER(rendered) || rendered < 1) throw invalid();
  return rendered;
}

function exactToken(value: unknown): string {
  if (
    typeof value !== "string"
    || REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_INTRINSIC, [value, "utf8"]) < 1
    || REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_INTRINSIC, [value, "utf8"])
      > MAX_TOKEN_BYTES
    || regexp(CONTROL_PATTERN, value)
  ) throw invalid();
  return value;
}

function ownDescriptors(value: unknown): Record<PropertyKey, PropertyDescriptor> {
  if (
    typeof value !== "object"
    || value === null
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [value])
  ) throw invalid();
  return REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    OBJECT_INTRINSIC,
    [value],
  ) as Record<PropertyKey, PropertyDescriptor>;
}

function dataValue(
  descriptors: Record<PropertyKey, PropertyDescriptor>,
  key: string,
  enumerable = true,
): unknown {
  const descriptor = descriptors[key];
  if (
    !REFLECT_APPLY(
      OBJECT_HAS_OWN,
      OBJECT_INTRINSIC,
      [descriptors, key],
    )
    || descriptor === undefined
    || !REFLECT_APPLY(
      OBJECT_HAS_OWN,
      OBJECT_INTRINSIC,
      [descriptor, "value"],
    )
    || descriptor.enumerable !== enumerable
  ) throw invalid();
  return descriptor.value;
}

function exactDescriptorKeys(
  descriptors: Record<PropertyKey, PropertyDescriptor>,
  expected: readonly PropertyKey[],
): void {
  const keys = REFLECT_APPLY(
    REFLECT_OWN_KEYS,
    REFLECT_INTRINSIC,
    [descriptors],
  );
  if (keys.length !== expected.length) throw invalid();
  for (let index = 0; index < expected.length; index += 1) {
    if (keys[index] !== expected[index]) throw invalid();
  }
}

function defineDenseString(
  output: string[],
  index: number,
  value: string,
): void {
  const key = REFLECT_APPLY(STRING_CONSTRUCTOR, undefined, [index]) as string;
  REFLECT_APPLY(OBJECT_DEFINE_PROPERTY, OBJECT_INTRINSIC, [output, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  }]);
}

function exactArrayValues(value: unknown): readonly string[] {
  if (!REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_INTRINSIC, [value])) throw invalid();
  const descriptors = ownDescriptors(value);
  exactDescriptorKeys(descriptors, [
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "length",
  ]);
  const length = dataValue(descriptors, "length", false);
  if (!NUMBER_IS_SAFE_INTEGER(length) || length !== 11) throw invalid();
  const output: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = REFLECT_APPLY(STRING_CONSTRUCTOR, undefined, [index]) as string;
    const item = dataValue(descriptors, key);
    if (typeof item !== "string" || regexp(CONTROL_PATTERN, item)) throw invalid();
    defineDenseString(output, index, item);
  }
  return OBJECT_FREEZE(output);
}

function commandArgv(
  command: unknown,
  binding: {
    readonly privateExecutableCopySha256: string;
    readonly privateExecutableCopyIdentitySha256: string;
    readonly privateExecutableCopyAuthoritySha256: string;
  },
): readonly string[] {
  const descriptors = ownDescriptors(command);
  const expected = [
    "schemaVersion",
    "executable",
    "executableAuthority",
    "argv",
    "environment",
    "shell",
    "stdin",
    "stdinWrites",
    "stdinEndCalls",
    "stdout",
    "stderr",
    "maximumCapturedStdoutBytes",
    "maximumCapturedStderrBytes",
    "detached",
    "abortSignalSequence",
    "processGroupEmptyBeforeSettlement",
  ];
  exactDescriptorKeys(descriptors, expected);
  // The executable descriptor is intentionally never read.
  if (descriptors.executable === undefined) throw invalid();
  if (
    dataValue(descriptors, "schemaVersion")
      !== "pintpath-permanent-staging-provider-variable-write-command/v2"
  ) throw invalid();
  const executableAuthority = ownDescriptors(
    dataValue(descriptors, "executableAuthority"),
  );
  exactDescriptorKeys(executableAuthority, [
    "privateExecutableCopySha256",
    "privateExecutableCopyIdentitySha256",
    "privateExecutableCopyAuthoritySha256",
    "descriptorHeld",
  ]);
  if (
    dataValue(executableAuthority, "privateExecutableCopySha256")
      !== binding.privateExecutableCopySha256
    || dataValue(executableAuthority, "privateExecutableCopyIdentitySha256")
      !== binding.privateExecutableCopyIdentitySha256
    || dataValue(executableAuthority, "privateExecutableCopyAuthoritySha256")
      !== binding.privateExecutableCopyAuthoritySha256
    || dataValue(executableAuthority, "descriptorHeld") !== true
  ) throw invalid();
  const argv = exactArrayValues(dataValue(descriptors, "argv"));
  const environment = ownDescriptors(dataValue(descriptors, "environment"));
  exactDescriptorKeys(environment, [
    "inherit",
    "prototype",
    "ownEnumerableDataPropertiesOnly",
    "exactNames",
    "valuesHandledByThisModule",
  ]);
  if (
    dataValue(environment, "inherit") !== false
    || dataValue(environment, "prototype") !== "null"
    || dataValue(environment, "ownEnumerableDataPropertiesOnly") !== true
    || dataValue(environment, "valuesHandledByThisModule") !== false
  ) throw invalid();
  const exactNames = exactArrayValuesForEnvironment(
    dataValue(environment, "exactNames"),
  );
  if (exactNames[0] !== "RAILWAY_TOKEN") throw invalid();
  if (
    dataValue(descriptors, "shell") !== false
    || dataValue(descriptors, "stdin") !== "pipe"
    || dataValue(descriptors, "stdinWrites") !== 1
    || dataValue(descriptors, "stdinEndCalls") !== 1
    || dataValue(descriptors, "stdout") !== "ignore"
    || dataValue(descriptors, "stderr") !== "ignore"
    || dataValue(descriptors, "maximumCapturedStdoutBytes") !== 0
    || dataValue(descriptors, "maximumCapturedStderrBytes") !== 0
    || dataValue(descriptors, "detached") !== true
    || dataValue(descriptors, "processGroupEmptyBeforeSettlement") !== true
    || argv[0] !== "variable"
    || argv[1] !== "set"
    || !regexp(VARIABLE_NAME_PATTERN, argv[2]!)
    || argv[3] !== "--stdin"
    || argv[4] !== "--skip-deploys"
    || argv[5] !== "--project"
    || argv[7] !== "--environment"
    || argv[9] !== "--service"
    || argv[6]!.length < 1
    || argv[8]!.length < 1
    || argv[10]!.length < 1
  ) throw invalid();
  const abortSignals = exactArrayValuesForSignals(
    dataValue(descriptors, "abortSignalSequence"),
  );
  if (abortSignals[0] !== "SIGTERM" || abortSignals[1] !== "SIGKILL") {
    throw invalid();
  }
  return argv;
}

function exactArrayValuesForEnvironment(value: unknown): readonly string[] {
  if (!REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_INTRINSIC, [value])) throw invalid();
  const descriptors = ownDescriptors(value);
  exactDescriptorKeys(descriptors, ["0", "length"]);
  if (dataValue(descriptors, "length", false) !== 1) throw invalid();
  const item = dataValue(descriptors, "0");
  if (typeof item !== "string") throw invalid();
  const output: string[] = [];
  defineDenseString(output, 0, item);
  return OBJECT_FREEZE(output);
}

function exactArrayValuesForSignals(value: unknown): readonly string[] {
  if (!REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_INTRINSIC, [value])) throw invalid();
  const descriptors = ownDescriptors(value);
  exactDescriptorKeys(descriptors, ["0", "1", "length"]);
  if (dataValue(descriptors, "length", false) !== 2) throw invalid();
  const first = dataValue(descriptors, "0");
  const second = dataValue(descriptors, "1");
  if (typeof first !== "string" || typeof second !== "string") throw invalid();
  const output: string[] = [];
  defineDenseString(output, 0, first);
  defineDenseString(output, 1, second);
  return OBJECT_FREEZE(output);
}

function processEnvironment(token: string): Readonly<Record<string, string>> {
  const environment = REFLECT_APPLY(
    OBJECT_CREATE,
    OBJECT_INTRINSIC,
    [null],
  ) as
    Record<string, string>;
  OBJECT_DEFINE_PROPERTY(environment, "RAILWAY_TOKEN", {
    configurable: true,
    enumerable: true,
    value: token,
    writable: false,
  });
  return environment;
}

function privateCopyCanonical(
  value: PermanentStagingProviderVariableWritePrivateCopyAuthority,
): string {
  return `{"schemaVersion":${jsonPrimitive(value.schemaVersion)},`
    + `"absolutePath":${jsonPrimitive(value.absolutePath)},`
    + `"sourceSha256":${jsonPrimitive(value.sourceSha256)},`
    + `"copySha256":${jsonPrimitive(value.copySha256)},`
    + `"bytes":${jsonPrimitive(value.bytes)},`
    + `"identitySha256":${jsonPrimitive(value.identitySha256)},`
    + `"parentMode0700":true,"absoluteCanonicalNonSymlinkPath":true,`
    + `"regularFile":true,"currentUid":true,"mode0500":true,`
    + `"nlinkOne":true,"descriptorHeld":true,`
    + `"pathAndDescriptorIdentityExact":true,`
    + `"bytesHashedFromHeldDescriptor":true,"sourceDigestExact":true}`;
}

function processAdapterCanonical(value: Readonly<{
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_ADAPTER_SCHEMA;
  readonly privateExecutableCopy:
    PermanentStagingProviderVariableWritePrivateCopyAuthority;
  readonly privateExecutableCopyAuthoritySha256: string;
  readonly environmentAuthoritySha256: string;
  readonly stdinAuthoritySha256: string;
  readonly processGroupAuthoritySha256: string;
}>): string {
  return `{"schemaVersion":${jsonPrimitive(value.schemaVersion)},`
    + `"privateExecutableCopy":${
      privateCopyCanonical(value.privateExecutableCopy)
    },`
    + `"privateExecutableCopyAuthoritySha256":${
      jsonPrimitive(value.privateExecutableCopyAuthoritySha256)
    },`
    + `"environmentAuthoritySha256":${
      jsonPrimitive(value.environmentAuthoritySha256)
    },`
    + `"stdinAuthoritySha256":${jsonPrimitive(value.stdinAuthoritySha256)},`
    + `"processGroupAuthoritySha256":${
      jsonPrimitive(value.processGroupAuthoritySha256)
    },`
    + `"exactlyOneChild":true,"injectedSpawnOnly":true,"shell":false,`
    + `"environmentNullPrototype":true,`
    + `"environmentExactNames":["RAILWAY_TOKEN"],"stdinPipe":true,`
    + `"stdinCompleteWriteBeforeEof":true,"stdoutDiscarded":true,`
    + `"stderrDiscarded":true,"detachedProcessGroup":true,`
    + `"abortTermThenKill":true,"closeAndErrorSettled":true,`
    + `"providerInvokedDuringInspection":false}`;
}

function processReceiptCanonical(
  receipt: PermanentStagingProviderVariableWriteProcessAdapterReceipt,
): string {
  return `{"schemaVersion":${jsonPrimitive(receipt.schemaVersion)},`
    + `"processAdapterAuthoritySha256":${
      jsonPrimitive(receipt.processAdapterAuthoritySha256)
    },`
    + `"privateExecutableCopyAuthoritySha256":${
      jsonPrimitive(receipt.privateExecutableCopyAuthoritySha256)
    },`
    + `"environmentAuthoritySha256":${
      jsonPrimitive(receipt.environmentAuthoritySha256)
    },`
    + `"stdinAuthoritySha256":${jsonPrimitive(receipt.stdinAuthoritySha256)},`
    + `"processGroupAuthoritySha256":${
      jsonPrimitive(receipt.processGroupAuthoritySha256)
    },`
    + `"childAttempts":1,"shell":false,"environmentNullPrototype":true,`
    + `"environmentExactNames":["RAILWAY_TOKEN"],"stdinWrites":1,`
    + `"stdinWriteCompleted":true,"stdinEof":true,`
    + `"stdoutBytesCaptured":0,"stderrBytesCaptured":0,`
    + `"detachedProcessGroup":true,"abortTermThenKill":true,`
    + `"processGroupReaped":true,"processGroupEmpty":true,`
    + `"closeAndErrorSettled":true,`
    + `"exitCode":${jsonPrimitive(receipt.exitCode)},`
    + `"signal":${jsonPrimitive(receipt.signal)}}`;
}

function processReceiptSha256(
  receipt: PermanentStagingProviderVariableWriteProcessAdapterReceipt,
): string {
  return hashCanonical(PROCESS_RECEIPT_HASH_DOMAIN, processReceiptCanonical(receipt));
}

function openDefaultNativeFile(
  filename: string,
  flags: number,
): Promise<FileHandle> {
  return new PROMISE_CONSTRUCTOR<FileHandle>((resolve, reject) => {
    REFLECT_APPLY(FS_OPEN_CALLBACK, FS_INTRINSIC, [
      filename,
      flags,
      (error: NodeJS.ErrnoException | null, fd: number): void => {
        if (error !== null) {
          reject(error);
          return;
        }
        let open = true;
        try {
          if (!NUMBER_IS_SAFE_INTEGER(fd) || fd < 0) throw invalid();
          const handle = freezeNullRecord({
            read(
              buffer: Buffer,
              offset: number,
              length: number,
              position: number | null,
            ): Promise<{ readonly bytesRead: number; readonly buffer: Buffer }> {
              if (!open) throw invalid();
              return new PROMISE_CONSTRUCTOR((resolveRead, rejectRead) => {
                REFLECT_APPLY(FS_READ_CALLBACK, FS_INTRINSIC, [
                  fd,
                  buffer,
                  offset,
                  length,
                  position,
                  (
                    readError: NodeJS.ErrnoException | null,
                    bytesRead: number,
                    returnedBuffer: Buffer,
                  ): void => {
                    if (readError !== null) {
                      rejectRead(readError);
                    } else if (
                      returnedBuffer !== buffer
                      || !NUMBER_IS_SAFE_INTEGER(bytesRead)
                      || bytesRead < 0
                      || bytesRead > length
                    ) {
                      rejectRead(invalid());
                    } else {
                      resolveRead(freezeNullRecord({ bytesRead, buffer }));
                    }
                  },
                ]);
              });
            },
            stat(): Promise<fs.BigIntStats> {
              if (!open) throw invalid();
              return new PROMISE_CONSTRUCTOR((resolveStat, rejectStat) => {
                REFLECT_APPLY(FS_FSTAT_CALLBACK, FS_INTRINSIC, [
                  fd,
                  { bigint: true },
                  (
                    statError: NodeJS.ErrnoException | null,
                    stat: fs.BigIntStats,
                  ): void => {
                    if (statError !== null) rejectStat(statError);
                    else {
                      try {
                        resolveStat(nativeStatSnapshot(stat));
                      } catch (snapshotError) {
                        rejectStat(snapshotError);
                      }
                    }
                  },
                ]);
              });
            },
            close(): Promise<void> {
              if (!open) throw invalid();
              open = false;
              return new PROMISE_CONSTRUCTOR((resolveClose, rejectClose) => {
                REFLECT_APPLY(FS_CLOSE_CALLBACK, FS_INTRINSIC, [
                  fd,
                  (closeError: NodeJS.ErrnoException | null): void => {
                    if (closeError !== null) rejectClose(closeError);
                    else resolveClose();
                  },
                ]);
              });
            },
          });
          REFLECT_APPLY(WEAK_SET_ADD, DEFAULT_NATIVE_FILE_HANDLES, [handle]);
          resolve(handle as unknown as FileHandle);
        } catch (failure) {
          try {
            REFLECT_APPLY(FS_CLOSE_CALLBACK, FS_INTRINSIC, [fd, () => undefined]);
          } catch {
            // The descriptor is recovery-only if native close itself throws.
          }
          reject(failure);
        }
      },
    ]);
  });
}

function defaultNativeFileHandleExact(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && REFLECT_APPLY(WEAK_SET_HAS, DEFAULT_NATIVE_FILE_HANDLES, [value]) === true;
}

function defaultNativeLstat(filename: string): Promise<fs.BigIntStats> {
  return new PROMISE_CONSTRUCTOR((resolve, reject) => {
    REFLECT_APPLY(FS_LSTAT_CALLBACK, FS_INTRINSIC, [
      filename,
      { bigint: true },
      (error: NodeJS.ErrnoException | null, stat: fs.BigIntStats): void => {
        if (error !== null) reject(error);
        else {
          try {
            resolve(nativeStatSnapshot(stat));
          } catch (snapshotError) {
            reject(snapshotError);
          }
        }
      },
    ]);
  });
}

function defaultNativeRealpath(filename: string): Promise<string> {
  return new PROMISE_CONSTRUCTOR((resolve, reject) => {
    REFLECT_APPLY(FS_REALPATH_CALLBACK, FS_INTRINSIC, [
      filename,
      (error: NodeJS.ErrnoException | null, resolvedPath: string): void => {
        if (error !== null) reject(error);
        else if (typeof resolvedPath !== "string") reject(invalid());
        else resolve(resolvedPath);
      },
    ]);
  });
}

const DEFAULT_DEPENDENCIES:
PermanentStagingProviderVariableWriteProcessAdapterDependencies = {
  open: openDefaultNativeFile,
  lstat: defaultNativeLstat,
  realpath: defaultNativeRealpath,
  effectiveUid: () => {
    if (typeof PROCESS_GETEUID !== "function") throw invalid();
    return REFLECT_APPLY(PROCESS_GETEUID, PROCESS_INTRINSIC, []);
  },
};

/**
 * Verifies and holds a pre-existing private executable copy. The caller must
 * separately prove that the copy was materialized from the already-held source
 * descriptor; this foundation proves held-copy identity and equal bytes only.
 * Native spawn, process-group, token-source, and cleanup capabilities are
 * deliberately absent. Node still spawns by pathname, so a hostile same-UID
 * replacement remains outside the guarantee of the held descriptor.
 */
export async function openPermanentStagingProviderVariableWriteProcessAdapter(
  input: {
    readonly privateExecutableCopyPath: string;
    readonly expectedSourceSha256: string;
    readonly spawn: PermanentStagingProviderVariableWriteProcessSpawn;
    readonly killProcessGroup:
      PermanentStagingProviderVariableWriteProcessGroupKill;
    readonly probeProcessGroupEmpty:
      PermanentStagingProviderVariableWriteProcessGroupProbe;
  },
  dependencies:
  PermanentStagingProviderVariableWriteProcessAdapterDependencies =
  DEFAULT_DEPENDENCIES,
): Promise<PermanentStagingProviderVariableWriteProcessAdapterHandle> {
  const usesDefaultDependencies = dependencies === DEFAULT_DEPENDENCIES;
  const dependencyDescriptors = ownDescriptors(dependencies);
  exactDescriptorKeys(dependencyDescriptors, [
    "open",
    "lstat",
    "realpath",
    "effectiveUid",
  ]);
  const openFile = dataValue(dependencyDescriptors, "open");
  const lstat = dataValue(dependencyDescriptors, "lstat");
  const realpath = dataValue(dependencyDescriptors, "realpath");
  const effectiveUid = dataValue(dependencyDescriptors, "effectiveUid");
  if (
    typeof openFile !== "function"
    || typeof lstat !== "function"
    || typeof realpath !== "function"
    || typeof effectiveUid !== "function"
  ) throw invalid();
  const inputDescriptors = ownDescriptors(input);
  exactDescriptorKeys(inputDescriptors, [
    "privateExecutableCopyPath",
    "expectedSourceSha256",
    "spawn",
    "killProcessGroup",
    "probeProcessGroupEmpty",
  ]);
  const copyPath = absolutePath(dataValue(
    inputDescriptors,
    "privateExecutableCopyPath",
  ));
  const expectedSourceSha256 = dataValue(
    inputDescriptors,
    "expectedSourceSha256",
  );
  const spawnCapability = dataValue(inputDescriptors, "spawn");
  const killProcessGroup = dataValue(inputDescriptors, "killProcessGroup");
  const probeProcessGroupEmpty = dataValue(
    inputDescriptors,
    "probeProcessGroupEmpty",
  );
  const parentPath = absolutePath(REFLECT_APPLY(
    PATH_DIRNAME,
    PATH_INTRINSIC,
    [copyPath],
  ));
  if (
    !sha256Exact(expectedSourceSha256)
    || typeof spawnCapability !== "function"
    || typeof killProcessGroup !== "function"
    || typeof probeProcessGroupEmpty !== "function"
    || !NUMBER_IS_INTEGER(FS_O_NOFOLLOW)
    || FS_O_NOFOLLOW <= 0
  ) throw invalid();
  const uid = safeUid(REFLECT_APPLY(effectiveUid, undefined, []));
  let handle: FileHandle | null = null;
  let capturedHandle: CapturedFileHandle | null = null;
  try {
    const parentBefore = assertPrivateParent(
      await REFLECT_APPLY(lstat, undefined, [parentPath]),
      uid,
    );
    if (await REFLECT_APPLY(realpath, undefined, [parentPath]) !== parentPath) {
      throw invalid();
    }
    const before = assertPrivateCopy(
      await REFLECT_APPLY(lstat, undefined, [copyPath]),
      uid,
    );
    if (await REFLECT_APPLY(realpath, undefined, [copyPath]) !== copyPath) {
      throw invalid();
    }
    const opened = await REFLECT_APPLY(openFile, undefined, [
      copyPath,
      FS_O_RDONLY | FS_O_NOFOLLOW,
    ]) as FileHandle;
    if (
      usesDefaultDependencies
      && !defaultNativeFileHandleExact(opened)
    ) throw invalid();
    handle = opened;
    const held = captureFileHandle(opened);
    capturedHandle = held;
    const pendingDescriptorBefore = REFLECT_APPLY(held.stat, held.receiver, [
      { bigint: true },
    ]) as unknown;
    if (!REFLECT_APPLY(
      UTIL_IS_PROMISE,
      UTIL_TYPES_INTRINSIC,
      [pendingDescriptorBefore],
    )) {
      throw invalid();
    }
    const descriptorBefore = assertPrivateCopy(
      await pendingDescriptorBefore,
      uid,
    );
    if (!sameIdentity(before, descriptorBefore)) throw invalid();
    const copySha256 = await descriptorSha256(held, exactSize(before.size));
    if (copySha256 !== expectedSourceSha256) throw invalid();
    const parentAfter = assertPrivateParent(
      await REFLECT_APPLY(lstat, undefined, [parentPath]),
      uid,
    );
    if (!sameIdentity(parentBefore, parentAfter)) throw invalid();

    const privateCopy = freezeNullRecord({
      schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PRIVATE_COPY_SCHEMA,
      absolutePath: copyPath,
      sourceSha256: expectedSourceSha256,
      copySha256,
      bytes: exactSize(before.size),
      identitySha256: identitySha256(before),
      parentMode0700: true,
      absoluteCanonicalNonSymlinkPath: true,
      regularFile: true,
      currentUid: true,
      mode0500: true,
      nlinkOne: true,
      descriptorHeld: true,
      pathAndDescriptorIdentityExact: true,
      bytesHashedFromHeldDescriptor: true,
      sourceDigestExact: true,
    } as const satisfies PermanentStagingProviderVariableWritePrivateCopyAuthority);
    const privateExecutableCopyAuthoritySha256 = hashCanonical(
      PRIVATE_COPY_HASH_DOMAIN,
      privateCopyCanonical(privateCopy),
    );
    const environmentAuthoritySha256 = hashCanonical(
      ENVIRONMENT_HASH_DOMAIN,
      `{"inherit":false,"nullPrototype":true,`
        + `"exactNames":["RAILWAY_TOKEN"],"valuesSerialized":false}`,
    );
    const stdinAuthoritySha256 = hashCanonical(
      STDIN_HASH_DOMAIN,
      `{"pipe":true,"writes":1,"completeWriteBeforeEof":true,`
        + `"eofRequired":true}`,
    );
    const processGroupAuthoritySha256 = hashCanonical(
      PROCESS_GROUP_HASH_DOMAIN,
      `{"detached":true,"exactlyOneChild":true,`
        + `"abortSignals":["SIGTERM","SIGKILL"],`
        + `"termGraceMs":${jsonPrimitive(TERM_GRACE_MS)},`
        + `"closeAndErrorSettled":true}`,
    );
    const authorityWithoutDigest = {
      schemaVersion:
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_ADAPTER_SCHEMA,
      privateExecutableCopy: privateCopy,
      privateExecutableCopyAuthoritySha256,
      environmentAuthoritySha256,
      stdinAuthoritySha256,
      processGroupAuthoritySha256,
      exactlyOneChild: true,
      injectedSpawnOnly: true,
      shell: false,
      environmentNullPrototype: true,
      environmentExactNames: ["RAILWAY_TOKEN"] as const,
      stdinPipe: true,
      stdinCompleteWriteBeforeEof: true,
      stdoutDiscarded: true,
      stderrDiscarded: true,
      detachedProcessGroup: true,
      abortTermThenKill: true,
      closeAndErrorSettled: true,
      providerInvokedDuringInspection: false,
    } as const;
    const processAdapterAuthoritySha256 = hashCanonical(
      PROCESS_ADAPTER_HASH_DOMAIN,
      processAdapterCanonical(authorityWithoutDigest),
    );
    const authority = freezeNullRecord({
      ...authorityWithoutDigest,
      environmentExactNames: OBJECT_FREEZE(["RAILWAY_TOKEN"] as const),
      processAdapterAuthoritySha256,
    } as const satisfies PermanentStagingProviderVariableWriteProcessAdapterAuthority);
    const localAuthorityBinding = freezeNullRecord({
      schemaVersion:
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_ADAPTER_SCHEMA,
      privateExecutableCopyAbsolutePath: privateCopy.absolutePath,
      privateExecutableCopySha256: privateCopy.copySha256,
      privateExecutableCopyBytes: privateCopy.bytes,
      privateExecutableCopyIdentitySha256: privateCopy.identitySha256,
      privateExecutableCopyAuthoritySha256,
      environmentAuthoritySha256,
      stdinAuthoritySha256,
      processGroupAuthoritySha256,
      processAdapterAuthoritySha256,
      privateExecutableCopyDescriptorHeld: true,
      privateExecutableCopyParentMode0700: true,
      injectedSpawnOnly: true,
      providerInvokedDuringInspection: false,
    } as const satisfies PermanentStagingProviderVariableWriteProcessAdapterBinding);
    REFLECT_APPLY(
      WEAK_SET_ADD,
      PROCESS_ADAPTER_BINDING_BRANDS,
      [localAuthorityBinding],
    );

    const delay = (milliseconds: number): Promise<void> =>
      new PROMISE_CONSTRUCTOR<void>((resolve) => {
        REFLECT_APPLY(
          SET_TIMEOUT,
          GLOBAL_THIS_INTRINSIC,
          [resolve, milliseconds],
        );
      });
    const signalGroup = (pid: number, signal: ProcessSignal): void => {
      try {
        REFLECT_APPLY(killProcessGroup, undefined, [pid, signal]);
      } catch {
        // Exact group-empty probing, not the signal return, is authoritative.
      }
    };
    const groupEmptyExact = async (pid: number): Promise<boolean> => {
      try {
        const probe = REFLECT_APPLY(probeProcessGroupEmpty, undefined, [pid]);
        const observed = REFLECT_APPLY(
          UTIL_IS_PROMISE,
          UTIL_TYPES_INTRINSIC,
          [probe],
        )
          ? await probe
          : probe;
        return observed === true;
      } catch {
        return false;
      }
    };
    const killUntilEmpty = async (pid: number): Promise<void> => {
      for (;;) {
        await delay(REAP_RETRY_MS);
        if (await groupEmptyExact(pid)) return;
        signalGroup(pid, "SIGKILL");
      }
    };
    const terminateThenKillUntilEmpty = async (pid: number): Promise<void> => {
      if (await groupEmptyExact(pid)) return;
      signalGroup(pid, "SIGTERM");
      await delay(TERM_GRACE_MS);
      if (await groupEmptyExact(pid)) return;
      signalGroup(pid, "SIGKILL");
      await killUntilEmpty(pid);
    };

    let state:
      | "open"
      | "inspecting"
      | "launching"
      | "launched"
      | "closing"
      | "closed"
      | "failed" = "open";
    let launcherCreated = false;
    let launchAttempted = false;
    let childSettled = false;
    let retainedLauncherToken: string | null = null;

    const verifyHeldCopy = async (): Promise<void> => {
      const parentStat = assertPrivateParent(
        await REFLECT_APPLY(lstat, undefined, [parentPath]),
        uid,
      );
      const pathStat = assertPrivateCopy(
        await REFLECT_APPLY(lstat, undefined, [copyPath]),
        uid,
      );
      const pendingDescriptorStat = REFLECT_APPLY(held.stat, held.receiver, [
        { bigint: true },
      ]) as unknown;
      if (!REFLECT_APPLY(
        UTIL_IS_PROMISE,
        UTIL_TYPES_INTRINSIC,
        [pendingDescriptorStat],
      )) {
        throw invalid();
      }
      const descriptorStat = assertPrivateCopy(
        await pendingDescriptorStat,
        uid,
      );
      if (
        !sameIdentity(parentBefore, parentStat)
        || !sameIdentity(before, pathStat)
        || !sameIdentity(before, descriptorStat)
        || await REFLECT_APPLY(realpath, undefined, [parentPath]) !== parentPath
        || await REFLECT_APPLY(realpath, undefined, [copyPath]) !== copyPath
        || await descriptorSha256(held, exactSize(before.size)) !== copySha256
      ) throw invalid();
    };

    const verify = async (
      signal: AbortSignal,
    ): Promise<PermanentStagingProviderVariableWriteProcessAdapterAuthority> => {
      checkSignal(signal);
      await verifyHeldCopy();
      checkSignal(signal);
      return authority;
    };

    const launchWithToken = ():
    PermanentStagingProviderVariableWriteProcessLauncher => {
      const attemptAuthority = freezeNullRecord({});
      const launcher: PermanentStagingProviderVariableWriteProcessLauncher =
        OBJECT_FREEZE(async (command, signal) => {
        if (state !== "open" || launchAttempted) throw invalid();
        state = "launching";
        launchAttempted = true;
        let tokenForAttempt: string | null = retainedLauncherToken;
        retainedLauncherToken = null;
        if (tokenForAttempt === null) throw invalid();
        let spawnReturned = false;
        let spawnedPid: number | null = null;
        try {
          const argv = commandArgv(command, {
            privateExecutableCopySha256: copySha256,
            privateExecutableCopyIdentitySha256: privateCopy.identitySha256,
            privateExecutableCopyAuthoritySha256,
          });
          await verify(signal);
          checkSignal(signal);
          const environment = processEnvironment(tokenForAttempt);
          const options = freezeNullRecord({
            env: environment,
            shell: false,
            stdio: OBJECT_FREEZE(["pipe", "ignore", "ignore"] as const),
            detached: true,
          } as const satisfies PermanentStagingProviderVariableWriteProcessSpawnOptions);
          let spawned: unknown;
          let child: Record<PropertyKey, PropertyDescriptor> | null = null;
          try {
            spawned = REFLECT_APPLY(spawnCapability, undefined, [
              copyPath,
              argv,
              options,
            ]);
            spawnReturned = true;
            child = ownDescriptors(spawned);
            exactDescriptorKeys(child, [
              "pid",
              "stdin",
              "once",
              "removeListener",
            ]);
            const observedPid = dataValue(child, "pid");
            if (
              !NUMBER_IS_SAFE_INTEGER(observedPid)
              || (observedPid as number) < 1
            ) throw writeFailed();
            spawnedPid = observedPid as number;
          } finally {
            const environmentScrubbed = REFLECT_APPLY(
              REFLECT_DELETE_PROPERTY,
              REFLECT_INTRINSIC,
              [environment, "RAILWAY_TOKEN"],
            );
            tokenForAttempt = null;
            if (!environmentScrubbed) throw writeFailed();
          }
          if (child === null || spawnedPid === null) throw writeFailed();
          const pid = spawnedPid;
          const stdin = dataValue(child, "stdin");
          const once = dataValue(child, "once");
          const removeListener = dataValue(child, "removeListener");
          if (
            typeof stdin !== "object"
            || stdin === null
            || typeof once !== "function"
            || typeof removeListener !== "function"
          ) throw writeFailed();
          const stdinDescriptors = ownDescriptors(stdin);
          exactDescriptorKeys(stdinDescriptors, [
            "write",
            "end",
            "once",
            "removeListener",
          ]);
          const write = dataValue(stdinDescriptors, "write");
          const end = dataValue(stdinDescriptors, "end");
          const stdinOnce = dataValue(stdinDescriptors, "once");
          const stdinRemoveListener = dataValue(stdinDescriptors, "removeListener");
          if (
            typeof write !== "function"
            || typeof end !== "function"
            || typeof stdinOnce !== "function"
            || typeof stdinRemoveListener !== "function"
          ) throw writeFailed();

          let closeObserved = false;
          let errorObserved = false;
          let closeCode: number | null = null;
          let closeSignal: NodeJS.Signals | null = null;
          let closeTupleExact = false;
          let stdinAttempted = false;
          let stdinWriteCompleted = false;
          let stdinEof = false;
          let stdinSettled = false;
          let stdinReject: ((error: unknown) => void) | null = null;
          let resultSettled = false;
          let abortIssued = false;
          let abortEscalationPending = false;
          let resolveClosed!: (
            value: PermanentStagingProviderVariableWriteProcessChildResult,
          ) => void;
          let rejectClosed!: (error: unknown) => void;
          const closed = new PROMISE_CONSTRUCTOR<
            PermanentStagingProviderVariableWriteProcessChildResult
          >((resolve, reject) => {
            resolveClosed = resolve;
            rejectClosed = reject;
          });
          let settlementStarted = false;
          const settleClosed = (): void => {
            if (
              resultSettled
              || settlementStarted
              || !closeObserved
              || !stdinSettled
              || abortEscalationPending
            ) return;
            settlementStarted = true;
            const pendingSettlement = (async () => {
              try {
                if (
                  errorObserved
                  || !closeTupleExact
                  || !stdinWriteCompleted
                  || !stdinEof
                  || closeCode !== null && !NUMBER_IS_SAFE_INTEGER(closeCode)
                ) throw writeFailed();
                await verifyHeldCopy();
                if (!await groupEmptyExact(pid as number)) {
                  if (abortIssued) await killUntilEmpty(pid as number);
                  else await terminateThenKillUntilEmpty(pid as number);
                  throw writeFailed();
                }
                const processAdapterReceipt = freezeNullRecord({
                  schemaVersion:
                    PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_RECEIPT_SCHEMA,
                  processAdapterAuthoritySha256,
                  privateExecutableCopyAuthoritySha256,
                  environmentAuthoritySha256,
                  stdinAuthoritySha256,
                  processGroupAuthoritySha256,
                  childAttempts: 1,
                  shell: false,
                  environmentNullPrototype: true,
                  environmentExactNames: OBJECT_FREEZE(["RAILWAY_TOKEN"] as const),
                  stdinWrites: 1,
                  stdinWriteCompleted: true,
                  stdinEof: true,
                  stdoutBytesCaptured: 0,
                  stderrBytesCaptured: 0,
                  detachedProcessGroup: true,
                  abortTermThenKill: true,
                  processGroupReaped: true,
                  processGroupEmpty: true,
                  closeAndErrorSettled: true,
                  exitCode: closeCode,
                  signal: closeSignal,
                } as const satisfies PermanentStagingProviderVariableWriteProcessAdapterReceipt);
                const result = freezeNullRecord({
                  exitCode: closeCode,
                  signal: closeSignal,
                  processAdapterReceipt,
                  processAdapterReceiptSha256:
                    processReceiptSha256(processAdapterReceipt),
                });
                REFLECT_APPLY(
                  WEAK_MAP_SET,
                  PROCESS_ADAPTER_RESULT_ATTEMPTS,
                  [result, attemptAuthority],
                );
                resolveClosed(result);
              } catch {
                if (!await groupEmptyExact(pid as number)) {
                  if (abortIssued) await killUntilEmpty(pid as number);
                  else await terminateThenKillUntilEmpty(pid as number);
                }
                rejectClosed(writeFailed());
              } finally {
                resultSettled = true;
                childSettled = true;
              }
            })();
            void REFLECT_APPLY(PROMISE_CATCH, pendingSettlement, [() => {
              // Reaping helpers deliberately remain pending until an exact
              // empty-group observation, so this path is unreachable for
              // ordinary capability failures.
            }]);
          };
          const onError = (): void => {
            errorObserved = true;
          };
          const onClose = (...args: unknown[]): void => {
            closeObserved = true;
            const code = args[0];
            const signalValue = args[1];
            closeTupleExact = args.length === 2 && ((
              NUMBER_IS_SAFE_INTEGER(code)
              && (code as number) >= 0
              && signalValue === null
            ) || (code === null && typeof signalValue === "string"));
            if (closeTupleExact) {
              closeCode = code as number | null;
              closeSignal = signalValue as NodeJS.Signals | null;
            }
            if (!stdinSettled) {
              stdinSettled = true;
              stdinReject?.(writeFailed());
            }
            settleClosed();
          };
          REFLECT_APPLY(once as Function, spawned, ["error", onError]);
          REFLECT_APPLY(once as Function, spawned, ["close", onClose]);
          state = "launched";

          const abort = (): void => {
            if (abortIssued || resultSettled || settlementStarted) return;
            abortIssued = true;
            abortEscalationPending = true;
            const pendingEscalation = (async () => {
              try {
                await terminateThenKillUntilEmpty(pid as number);
              } finally {
                abortEscalationPending = false;
                settleClosed();
              }
            })();
            void REFLECT_APPLY(PROMISE_CATCH, pendingEscalation, [() => {
              abortEscalationPending = false;
              settleClosed();
            }]);
          };

          const processChild = freezeNullRecord({
            async writeStdin(value: Buffer): Promise<void> {
              if (
                stdinAttempted
                || closeObserved
                || !REFLECT_APPLY(
                  BUFFER_IS_BUFFER,
                  BUFFER_INTRINSIC,
                  [value],
                )
                || OBJECT_GET_PROTOTYPE_OF(value) !== BUFFER_PROTOTYPE
              ) throw writeFailed();
              stdinAttempted = true;
              await new PROMISE_CONSTRUCTOR<void>((resolve, reject) => {
                stdinReject = reject;
                let settled = false;
                const finish = (error?: unknown): void => {
                  if (settled) return;
                  settled = true;
                  stdinSettled = true;
                  try {
                    REFLECT_APPLY(
                      stdinRemoveListener as Function,
                      stdin,
                      ["error", onStdinError],
                    );
                  } catch {
                    // Settlement is already fail-closed below.
                  }
                  if (error !== undefined && error !== null) reject(writeFailed());
                  else resolve();
                  settleClosed();
                };
                const onStdinError = (): void => finish(writeFailed());
                try {
                  REFLECT_APPLY(stdinOnce as Function, stdin, ["error", onStdinError]);
                  REFLECT_APPLY(write as Function, stdin, [
                    value,
                    (error?: unknown) => {
                      if (error !== undefined && error !== null) {
                        finish(error);
                        return;
                      }
                      stdinWriteCompleted = true;
                      try {
                        REFLECT_APPLY(end as Function, stdin, [
                          (endError?: unknown) => {
                            if (endError === undefined || endError === null) {
                              stdinEof = true;
                            }
                            finish(endError);
                          },
                        ]);
                      } catch (endFailure) {
                        finish(endFailure);
                      }
                    },
                  ]);
                } catch (error) {
                  finish(error);
                }
              });
            },
            abort,
            closed,
          } satisfies PermanentStagingProviderVariableWriteProcessChild);
          REFLECT_APPLY(
            WEAK_MAP_SET,
            PROCESS_ADAPTER_CHILD_ATTEMPTS,
            [processChild, attemptAuthority],
          );
          return processChild;
        } catch (error) {
          if (spawnReturned && spawnedPid !== null) {
            await terminateThenKillUntilEmpty(spawnedPid);
            childSettled = true;
            state = "failed";
            throw writeFailed();
          }
          if (state === "launching") state = "failed";
          throw normalize(error);
        } finally {
          tokenForAttempt = null;
          retainedLauncherToken = null;
        }
      });
      REFLECT_APPLY(
        WEAK_MAP_SET,
        PROCESS_ADAPTER_ATTEMPT_BINDINGS,
        [attemptAuthority, localAuthorityBinding],
      );
      REFLECT_APPLY(
        WEAK_MAP_SET,
        PROCESS_ADAPTER_LAUNCHER_ATTEMPTS,
        [launcher, attemptAuthority],
      );
      return launcher;
    };

    const inspectWhileOpen = async <T>(
      signal: AbortSignal,
      value: T,
    ): Promise<T> => {
      if (state !== "open") throw invalid();
      state = "inspecting";
      try {
        await verify(signal);
        if (state !== "inspecting") throw invalid();
        return value;
      } catch (error) {
        throw normalize(error);
      } finally {
        if (state === "inspecting") state = "open";
      }
    };

    return freezeNullRecord({
      async inspect(signal) {
        return inspectWhileOpen(signal, authority);
      },
      async reassert(signal) {
        return inspectWhileOpen(signal, authority);
      },
      async inspectLocalAuthorityBinding(signal) {
        return inspectWhileOpen(signal, localAuthorityBinding);
      },
      createLauncher(token) {
        if (state !== "open" || launcherCreated || launchAttempted) {
          throw invalid();
        }
        launcherCreated = true;
        retainedLauncherToken = exactToken(token);
        return launchWithToken();
      },
      async close() {
        if (state === "closed") return;
        if (
          state === "inspecting"
          || state === "launching"
          || state === "closing"
        ) throw cleanupFailed();
        if (state === "launched" && !childSettled) throw cleanupFailed();
        retainedLauncherToken = null;
        state = "closing";
        try {
          await REFLECT_APPLY(held.close, held.receiver, []);
          state = "closed";
        } catch {
          state = "failed";
          throw cleanupFailed();
        }
      },
    } satisfies PermanentStagingProviderVariableWriteProcessAdapterHandle);
  } catch (error) {
    if (handle !== null && capturedHandle !== null) {
      try {
        await REFLECT_APPLY(
          capturedHandle.close,
          capturedHandle.receiver,
          [],
        );
      } catch {
        throw cleanupFailed();
      }
    } else if (handle !== null) {
      throw cleanupFailed();
    }
    throw normalize(error);
  }
}
