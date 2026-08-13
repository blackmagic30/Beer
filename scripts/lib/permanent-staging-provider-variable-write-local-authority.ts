import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";

import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS,
  type PermanentStagingProviderVariableName,
  type PermanentStagingProviderVariableWriteOperation,
} from "./permanent-staging-provider-variable-write-executor.js";
import {
  PermanentStagingProviderVariableWriteInputError,
  isPermanentStagingProviderVariableWriteInputHandleAuthority,
  type PermanentStagingProviderVariableWriteInputHandle,
  type PermanentStagingProviderVariableWriteInputInspection,
} from "./permanent-staging-provider-variable-write-input.js";
import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_ADAPTER_SCHEMA,
  claimPermanentStagingProviderVariableWriteProcessChildAuthority,
  claimPermanentStagingProviderVariableWriteProcessChildResultAuthority,
  claimPermanentStagingProviderVariableWriteProcessLauncherAuthority,
  isPermanentStagingProviderVariableWriteProcessAdapterBinding,
  type PermanentStagingProviderVariableWriteProcessAdapterBinding as BrandedProcessAdapterBinding,
} from "./permanent-staging-provider-variable-write-process-adapter.js";

const ARRAY_INTRINSIC = Array;
const BUFFER_INTRINSIC = Buffer;
const CRYPTO_INTRINSIC = crypto;
const FS_INTRINSIC = fs;
const JSON_INTRINSIC = JSON;
const MATH_INTRINSIC = Math;
const OBJECT_INTRINSIC = Object;
const PATH_INTRINSIC = path;
const PROCESS_INTRINSIC = process;
const PROMISE_INTRINSIC = Promise;
const REFLECT_INTRINSIC = Reflect;
const UTIL_TYPES_INTRINSIC = utilTypes;
const ABORT_SIGNAL_ABORTED_GETTER = OBJECT_INTRINSIC.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const ARRAY_IS_ARRAY = ARRAY_INTRINSIC.isArray;
const BIGINT_CONSTRUCTOR = BigInt;
const BIGINT_TO_STRING = BigInt.prototype.toString;
const BUFFER_ALLOC = BUFFER_INTRINSIC.alloc;
const BUFFER_BYTE_LENGTH = BUFFER_INTRINSIC.byteLength;
const CRYPTO_CREATE_HASH = CRYPTO_INTRINSIC.createHash;
const EVENT_TARGET_ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const EVENT_TARGET_REMOVE_EVENT_LISTENER =
  EventTarget.prototype.removeEventListener;
const JSON_STRINGIFY = JSON_INTRINSIC.stringify;
const MATH_MIN = MATH_INTRINSIC.min;
const NUMBER_CONSTRUCTOR = Number;
const NUMBER_IS_INTEGER = Number.isInteger;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_FREEZE = OBJECT_INTRINSIC.freeze;
const OBJECT_CREATE = OBJECT_INTRINSIC.create;
const OBJECT_DEFINE_PROPERTIES = OBJECT_INTRINSIC.defineProperties;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  OBJECT_INTRINSIC.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  OBJECT_INTRINSIC.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = OBJECT_INTRINSIC.getPrototypeOf;
const OBJECT_HAS_OWN = OBJECT_INTRINSIC.hasOwn;
const OBJECT_SET_PROTOTYPE_OF = OBJECT_INTRINSIC.setPrototypeOf;
const OBJECT_PROTOTYPE = OBJECT_INTRINSIC.prototype;
const PATH_IS_ABSOLUTE = PATH_INTRINSIC.isAbsolute;
const PATH_NORMALIZE = PATH_INTRINSIC.normalize;
const PATH_PARSE = PATH_INTRINSIC.parse;
const PATH_RESOLVE = PATH_INTRINSIC.resolve;
const REGEXP_EXEC = RegExp.prototype.exec;
const REFLECT_APPLY = REFLECT_INTRINSIC.apply;
const REFLECT_OWN_KEYS = REFLECT_INTRINSIC.ownKeys;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_INCLUDES = String.prototype.includes;
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const UTIL_IS_PROMISE = UTIL_TYPES_INTRINSIC.isPromise;
const UTIL_IS_PROXY = UTIL_TYPES_INTRINSIC.isProxy;
const FS_PROMISES = FS_INTRINSIC.promises;
const FS_CLOSE_CALLBACK = FS_INTRINSIC.close;
const FS_FSTAT_CALLBACK = FS_INTRINSIC.fstat;
const FS_LSTAT_CALLBACK = FS_INTRINSIC.lstat;
const FS_OPEN_CALLBACK = FS_INTRINSIC.open;
const FS_READ_CALLBACK = FS_INTRINSIC.read;
const FS_REALPATH_CALLBACK = FS_INTRINSIC.realpath.native;
const FS_LSTAT = FS_PROMISES.lstat;
const FS_REALPATH = FS_PROMISES.realpath;
const PROCESS_GETEUID = PROCESS_INTRINSIC.geteuid;
const PROMISE_CONSTRUCTOR = PROMISE_INTRINSIC;
const O_NOFOLLOW_EXACT = fs.constants.O_NOFOLLOW;
const O_RDONLY_EXACT = fs.constants.O_RDONLY;
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
const STAT_MODE_MASK = BIGINT_CONSTRUCTOR(fs.constants.S_IFMT);
const STAT_MODE_REGULAR = BIGINT_CONSTRUCTOR(fs.constants.S_IFREG);
const LINE_BREAK_PATTERN = /[\r\n]/;
const DECIMAL_BIGINT_PATTERN = /^-?[0-9]+$/;
const OCTAL_BIGINT_PATTERN = /^[0-7]+$/;
const LOWERCASE_HEX_64_PATTERN = /^[a-f0-9]{64}$/;

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCAL_AUTHORITY_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-local-authority/v2" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_COMMAND_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-command/v2" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCAL_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-local-receipt/v3" as const;
const PROCESS_ADAPTER_SCHEMA =
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_ADAPTER_SCHEMA;
const PROCESS_ADAPTER_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-process-adapter-receipt/v1" as const;

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
    REFLECT_APPLY(OBJECT_DEFINE_PROPERTIES, OBJECT_INTRINSIC, [this, {
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

function freezeNullRecord<T extends object>(value: T): T {
  REFLECT_APPLY(OBJECT_SET_PROTOTYPE_OF, OBJECT_INTRINSIC, [value, null]);
  return OBJECT_FREEZE(value);
}

const LOCAL_ERROR_AUTHORITIES = new WeakMap<
  object,
  PermanentStagingProviderVariableWriteLocalAuthorityFailureCode
>();
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const LOCAL_RECEIPT_AUTHORITIES = new WeakSet<object>();
const LOCAL_WRITE_ATTEMPT_AUTHORITIES = new WeakSet<object>();
const CLAIMED_LOCAL_WRITE_ATTEMPT_AUTHORITIES = new WeakSet<object>();
const LOCAL_WRITE_ATTEMPT_BINDINGS = new WeakMap<object, object>();
const LOCAL_RECEIPT_WRITE_ATTEMPTS = new WeakMap<object, object>();
const CONSUMED_LOCAL_RECEIPT_AUTHORITIES = new WeakSet<object>();
const DEFAULT_NATIVE_FILE_HANDLES = new WeakSet<object>();
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;
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
  readonly processAdapterInjectedSpawnOnly: true;
  readonly providerInvokedDuringInspection: false;
}

export type PermanentStagingProviderVariableWriteProcessAdapterBinding =
  BrandedProcessAdapterBinding;

export interface PermanentStagingProviderVariableWriteCommand {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_COMMAND_SCHEMA;
  readonly executable: string;
  readonly executableAuthority: {
    readonly privateExecutableCopySha256: string;
    readonly privateExecutableCopyIdentitySha256: string;
    readonly privateExecutableCopyAuthoritySha256: string;
    readonly descriptorHeld: true;
  };
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

export interface PermanentStagingProviderVariableWriteInjectedChildResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly processAdapterReceipt: {
    readonly schemaVersion: typeof PROCESS_ADAPTER_RECEIPT_SCHEMA;
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
  };
  readonly processAdapterReceiptSha256: string;
}

/**
 * Explicitly injected child capability. The separate offline supervisor
 * foundation remains unwired: this module imports no process-launch capability,
 * token source, or environment constructor.
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
      || REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_INTRINSIC, [value]) === true
      || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [value]) === true
    ) {
      return null;
    }
    const prototype = REFLECT_APPLY(
      OBJECT_GET_PROTOTYPE_OF,
      OBJECT_INTRINSIC,
      [value],
    );
    if (prototype !== OBJECT_PROTOTYPE && prototype !== null) return null;
    const descriptors = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
      OBJECT_INTRINSIC,
      [value],
    ) as Record<PropertyKey, PropertyDescriptor>;
    const keys = REFLECT_APPLY(
      REFLECT_OWN_KEYS,
      REFLECT_INTRINSIC,
      [descriptors],
    ) as
      PropertyKey[];
    if (keys.length !== expectedKeys.length) return null;
    for (let index = 0; index < keys.length; index += 1) {
      if (keys[index] !== expectedKeys[index]) return null;
    }
    for (let index = 0; index < expectedKeys.length; index += 1) {
      const key = expectedKeys[index]!;
      const descriptor = descriptors[key];
      if (
        REFLECT_APPLY(
          OBJECT_HAS_OWN,
          OBJECT_INTRINSIC,
          [descriptors, key],
        ) !== true
        || descriptor === undefined
        || REFLECT_APPLY(
          OBJECT_HAS_OWN,
          OBJECT_INTRINSIC,
          [descriptor, "value"],
        ) !== true
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
    || !REFLECT_APPLY(UTIL_IS_PROMISE, UTIL_TYPES_INTRINSIC, [closed])
  ) return null;
  return freezeNullRecord({
    receiver: value as object,
    writeStdin: writeStdin as (value: Buffer) => Promise<void>,
    abort: abort as () => void,
    closed: closed as Promise<PermanentStagingProviderVariableWriteInjectedChildResult>,
  });
}

function exactProcessAdapterBinding(
  value: unknown,
): PermanentStagingProviderVariableWriteProcessAdapterBinding {
  if (!isPermanentStagingProviderVariableWriteProcessAdapterBinding(value)) {
    throw invalid();
  }
  const descriptors = ownDataDescriptors(value, [
    "schemaVersion",
    "privateExecutableCopyAbsolutePath",
    "privateExecutableCopySha256",
    "privateExecutableCopyBytes",
    "privateExecutableCopyIdentitySha256",
    "privateExecutableCopyAuthoritySha256",
    "environmentAuthoritySha256",
    "stdinAuthoritySha256",
    "processGroupAuthoritySha256",
    "processAdapterAuthoritySha256",
    "privateExecutableCopyDescriptorHeld",
    "privateExecutableCopyParentMode0700",
    "injectedSpawnOnly",
    "providerInvokedDuringInspection",
  ]);
  if (descriptors === null) throw invalid();
  const read = (key: string): unknown => descriptors[key]?.value;
  const digests = [
    read("privateExecutableCopySha256"),
    read("privateExecutableCopyIdentitySha256"),
    read("privateExecutableCopyAuthoritySha256"),
    read("environmentAuthoritySha256"),
    read("stdinAuthoritySha256"),
    read("processGroupAuthoritySha256"),
    read("processAdapterAuthoritySha256"),
  ];
  for (let index = 0; index < digests.length; index += 1) {
    if (!exactLowercaseHex64(digests[index])) throw invalid();
  }
  const bytes = read("privateExecutableCopyBytes");
  if (
    read("schemaVersion") !== PROCESS_ADAPTER_SCHEMA
    || !NUMBER_IS_SAFE_INTEGER(bytes)
    || (bytes as number) < 1
    || (bytes as number) > MAX_BINARY_BYTES
    || read("privateExecutableCopyDescriptorHeld") !== true
    || read("privateExecutableCopyParentMode0700") !== true
    || read("injectedSpawnOnly") !== true
    || read("providerInvokedDuringInspection") !== false
  ) throw invalid();
  return freezeNullRecord({
    schemaVersion: PROCESS_ADAPTER_SCHEMA,
    privateExecutableCopyAbsolutePath: exactAbsolutePath(
      read("privateExecutableCopyAbsolutePath"),
    ),
    privateExecutableCopySha256: digests[0] as string,
    privateExecutableCopyBytes: bytes as number,
    privateExecutableCopyIdentitySha256: digests[1] as string,
    privateExecutableCopyAuthoritySha256: digests[2] as string,
    environmentAuthoritySha256: digests[3] as string,
    stdinAuthoritySha256: digests[4] as string,
    processGroupAuthoritySha256: digests[5] as string,
    processAdapterAuthoritySha256: digests[6] as string,
    privateExecutableCopyDescriptorHeld: true,
    privateExecutableCopyParentMode0700: true,
    injectedSpawnOnly: true,
    providerInvokedDuringInspection: false,
  });
}

function exactSingleRailwayTokenName(value: unknown): boolean {
  if (
    !REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_INTRINSIC, [value])
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [value]) === true
  ) return false;
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
  const keys = REFLECT_APPLY(
    REFLECT_OWN_KEYS,
    REFLECT_INTRINSIC,
    [descriptors],
  );
  const item = descriptors["0"];
  const length = descriptors.length;
  return keys.length === 2
    && keys[0] === "0"
    && keys[1] === "length"
    && REFLECT_APPLY(
      OBJECT_HAS_OWN,
      OBJECT_INTRINSIC,
      [descriptors, "0"],
    ) === true
    && REFLECT_APPLY(
      OBJECT_HAS_OWN,
      OBJECT_INTRINSIC,
      [descriptors, "length"],
    ) === true
    && item !== undefined
    && REFLECT_APPLY(
      OBJECT_HAS_OWN,
      OBJECT_INTRINSIC,
      [item, "value"],
    ) === true
    && item.enumerable === true
    && item.value === "RAILWAY_TOKEN"
    && length !== undefined
    && REFLECT_APPLY(
      OBJECT_HAS_OWN,
      OBJECT_INTRINSIC,
      [length, "value"],
    ) === true
    && length.enumerable === false
    && length.value === 1;
}

function processReceiptCanonical(
  receipt: Readonly<{
    readonly schemaVersion: typeof PROCESS_ADAPTER_RECEIPT_SCHEMA;
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
    readonly signal: string | null;
  }>,
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

function exactChildResult(
  value: unknown,
  binding: PermanentStagingProviderVariableWriteProcessAdapterBinding,
): PermanentStagingProviderVariableWriteInjectedChildResult | null {
  const descriptors = ownDataDescriptors(value, [
    "exitCode",
    "signal",
    "processAdapterReceipt",
    "processAdapterReceiptSha256",
  ]);
  if (descriptors === null) return null;
  const exitCode = descriptors.exitCode?.value;
  const signal = descriptors.signal?.value;
  const receiptDescriptors = ownDataDescriptors(
    descriptors.processAdapterReceipt?.value,
    [
      "schemaVersion",
      "processAdapterAuthoritySha256",
      "privateExecutableCopyAuthoritySha256",
      "environmentAuthoritySha256",
      "stdinAuthoritySha256",
      "processGroupAuthoritySha256",
      "childAttempts",
      "shell",
      "environmentNullPrototype",
      "environmentExactNames",
      "stdinWrites",
      "stdinWriteCompleted",
      "stdinEof",
      "stdoutBytesCaptured",
      "stderrBytesCaptured",
      "detachedProcessGroup",
      "abortTermThenKill",
      "processGroupReaped",
      "processGroupEmpty",
      "closeAndErrorSettled",
      "exitCode",
      "signal",
    ],
  );
  if (receiptDescriptors === null) return null;
  const read = (key: string): unknown => receiptDescriptors[key]?.value;
  if (
    !(exitCode === null || NUMBER_IS_SAFE_INTEGER(exitCode))
    || !(signal === null || typeof signal === "string")
    || read("schemaVersion") !== PROCESS_ADAPTER_RECEIPT_SCHEMA
    || read("processAdapterAuthoritySha256")
      !== binding.processAdapterAuthoritySha256
    || read("privateExecutableCopyAuthoritySha256")
      !== binding.privateExecutableCopyAuthoritySha256
    || read("environmentAuthoritySha256")
      !== binding.environmentAuthoritySha256
    || read("stdinAuthoritySha256") !== binding.stdinAuthoritySha256
    || read("processGroupAuthoritySha256")
      !== binding.processGroupAuthoritySha256
    || read("childAttempts") !== 1
    || read("shell") !== false
    || read("environmentNullPrototype") !== true
    || !exactSingleRailwayTokenName(read("environmentExactNames"))
    || read("stdinWrites") !== 1
    || read("stdinWriteCompleted") !== true
    || read("stdinEof") !== true
    || read("stdoutBytesCaptured") !== 0
    || read("stderrBytesCaptured") !== 0
    || read("detachedProcessGroup") !== true
    || read("abortTermThenKill") !== true
    || read("processGroupReaped") !== true
    || read("processGroupEmpty") !== true
    || read("closeAndErrorSettled") !== true
    || read("exitCode") !== exitCode
    || read("signal") !== signal
  ) return null;
  const processAdapterReceipt = freezeNullRecord({
    schemaVersion: PROCESS_ADAPTER_RECEIPT_SCHEMA,
    processAdapterAuthoritySha256: binding.processAdapterAuthoritySha256,
    privateExecutableCopyAuthoritySha256:
      binding.privateExecutableCopyAuthoritySha256,
    environmentAuthoritySha256: binding.environmentAuthoritySha256,
    stdinAuthoritySha256: binding.stdinAuthoritySha256,
    processGroupAuthoritySha256: binding.processGroupAuthoritySha256,
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
    exitCode,
    signal,
  } as const);
  const canonical = processReceiptCanonical(processAdapterReceipt);
  const processAdapterReceiptSha256 =
    descriptors.processAdapterReceiptSha256?.value;
  if (
    !exactLowercaseHex64(processAdapterReceiptSha256)
    || sha256Utf8(PROCESS_RECEIPT_HASH_DOMAIN, canonical)
      !== processAdapterReceiptSha256
  ) return null;
  return freezeNullRecord({
    exitCode,
    signal,
    processAdapterReceipt,
    processAdapterReceiptSha256,
  }) as PermanentStagingProviderVariableWriteInjectedChildResult;
}

export type PermanentStagingProviderVariableWriteInjectedChildLauncher = (
  command: PermanentStagingProviderVariableWriteCommand,
  signal: AbortSignal,
) => PermanentStagingProviderVariableWriteInjectedChild
  | Promise<PermanentStagingProviderVariableWriteInjectedChild>;

export interface PermanentStagingProviderVariableWriteLocalReceipt {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCAL_RECEIPT_SCHEMA;
  readonly variableName: PermanentStagingProviderVariableName;
  readonly inputCommitmentSha256: string;
  readonly intentSha256: string;
  readonly localAuthoritySha256: string;
  readonly commandSha256: string;
  readonly processAdapterAuthoritySha256: string;
  readonly privateExecutableCopyAuthoritySha256: string;
  readonly environmentAuthoritySha256: string;
  readonly stdinAuthoritySha256: string;
  readonly processGroupAuthoritySha256: string;
  readonly processAdapterReceiptSha256: string;
  readonly childAttempts: 1;
  readonly stdinWrites: 1;
  readonly exitCode: 0;
  readonly signal: null;
  readonly stdoutBytesCaptured: 0;
  readonly stderrBytesCaptured: 0;
  readonly childCloseAwaited: true;
  readonly environmentNullPrototype: true;
  readonly stdinWriteCompleted: true;
  readonly stdinEof: true;
  readonly detachedProcessGroup: true;
  readonly processGroupEmpty: true;
  readonly closeAndErrorSettled: true;
  readonly providerAcknowledgementInspected: false;
}

/**
 * Opaque per-kernel-invocation authority. Its identity, rather than any
 * caller-computable digest, proves that a local write began after intent was
 * made durable.
 */
export interface PermanentStagingProviderVariableWriteLocalAttemptAuthority {}

export interface PermanentStagingProviderVariableWriteLocalAttemptBinding {
  readonly operationId: string;
  readonly variableName: PermanentStagingProviderVariableName;
  readonly inputCommitmentSha256: string;
  readonly inputByteLength: number;
  readonly intentSha256: string;
  readonly localAuthoritySha256: string;
  readonly commandSha256: string;
  readonly processAdapterAuthoritySha256: string;
  readonly privateExecutableCopyAuthoritySha256: string;
  readonly environmentAuthoritySha256: string;
  readonly stdinAuthoritySha256: string;
  readonly processGroupAuthoritySha256: string;
}

function operationForAttempt(
  operationId: unknown,
  variableName: unknown,
): PermanentStagingProviderVariableWriteOperation | null {
  for (
    let index = 0;
    index < PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS.length;
    index += 1
  ) {
    const operation = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS[index];
    if (
      operation !== undefined
      && operation.operationId === operationId
      && operation.variableName === variableName
    ) return operation;
  }
  return null;
}

function exactAttemptBinding(
  value: unknown,
): PermanentStagingProviderVariableWriteLocalAttemptBinding {
  const descriptors = ownDataDescriptors(value, [
    "operationId",
    "variableName",
    "inputCommitmentSha256",
    "inputByteLength",
    "intentSha256",
    "localAuthoritySha256",
    "commandSha256",
    "processAdapterAuthoritySha256",
    "privateExecutableCopyAuthoritySha256",
    "environmentAuthoritySha256",
    "stdinAuthoritySha256",
    "processGroupAuthoritySha256",
  ]);
  if (descriptors === null) throw invalid();
  const read = (key: string): unknown => descriptors[key]?.value;
  const operation = operationForAttempt(
    read("operationId"),
    read("variableName"),
  );
  const inputByteLength = read("inputByteLength");
  const digests = [
    read("inputCommitmentSha256"),
    read("intentSha256"),
    read("localAuthoritySha256"),
    read("commandSha256"),
    read("processAdapterAuthoritySha256"),
    read("privateExecutableCopyAuthoritySha256"),
    read("environmentAuthoritySha256"),
    read("stdinAuthoritySha256"),
    read("processGroupAuthoritySha256"),
  ];
  if (
    operation === null
    || !NUMBER_IS_SAFE_INTEGER(inputByteLength)
    || (inputByteLength as number) < 1
    || (inputByteLength as number)
      > PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.writeContract
        .maximumValueBytes
  ) throw invalid();
  for (let index = 0; index < digests.length; index += 1) {
    if (!exactLowercaseHex64(digests[index])) throw invalid();
  }
  return freezeNullRecord({
    operationId: operation.operationId,
    variableName: operation.variableName,
    inputCommitmentSha256: digests[0] as string,
    inputByteLength: inputByteLength as number,
    intentSha256: digests[1] as string,
    localAuthoritySha256: digests[2] as string,
    commandSha256: digests[3] as string,
    processAdapterAuthoritySha256: digests[4] as string,
    privateExecutableCopyAuthoritySha256: digests[5] as string,
    environmentAuthoritySha256: digests[6] as string,
    stdinAuthoritySha256: digests[7] as string,
    processGroupAuthoritySha256: digests[8] as string,
  });
}

export function createPermanentStagingProviderVariableWriteLocalAttemptAuthority(
  bindingInput: PermanentStagingProviderVariableWriteLocalAttemptBinding,
): PermanentStagingProviderVariableWriteLocalAttemptAuthority {
  const binding = exactAttemptBinding(bindingInput);
  const authority = freezeNullRecord({});
  REFLECT_APPLY(WEAK_SET_ADD, LOCAL_WRITE_ATTEMPT_AUTHORITIES, [authority]);
  REFLECT_APPLY(WEAK_MAP_SET, LOCAL_WRITE_ATTEMPT_BINDINGS, [authority, binding]);
  return authority;
}

function sameAttemptBinding(
  left: PermanentStagingProviderVariableWriteLocalAttemptBinding,
  right: PermanentStagingProviderVariableWriteLocalAttemptBinding,
): boolean {
  return left.operationId === right.operationId
    && left.variableName === right.variableName
    && left.inputCommitmentSha256 === right.inputCommitmentSha256
    && left.inputByteLength === right.inputByteLength
    && left.intentSha256 === right.intentSha256
    && left.localAuthoritySha256 === right.localAuthoritySha256
    && left.commandSha256 === right.commandSha256
    && left.processAdapterAuthoritySha256
      === right.processAdapterAuthoritySha256
    && left.privateExecutableCopyAuthoritySha256
      === right.privateExecutableCopyAuthoritySha256
    && left.environmentAuthoritySha256 === right.environmentAuthoritySha256
    && left.stdinAuthoritySha256 === right.stdinAuthoritySha256
    && left.processGroupAuthoritySha256 === right.processGroupAuthoritySha256;
}

function claimLocalWriteAttemptAuthority(
  value: unknown,
  expectedBinding: PermanentStagingProviderVariableWriteLocalAttemptBinding,
): value is PermanentStagingProviderVariableWriteLocalAttemptAuthority {
  try {
    const binding = typeof value === "object" && value !== null
      ? REFLECT_APPLY(WEAK_MAP_GET, LOCAL_WRITE_ATTEMPT_BINDINGS, [value])
      : undefined;
    if (
      typeof value !== "object"
      || value === null
      || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [value]) === true
      || REFLECT_APPLY(WEAK_SET_HAS, LOCAL_WRITE_ATTEMPT_AUTHORITIES, [value])
        !== true
      || REFLECT_APPLY(
        WEAK_SET_HAS,
        CLAIMED_LOCAL_WRITE_ATTEMPT_AUTHORITIES,
        [value],
      ) === true
      || typeof binding !== "object"
      || binding === null
      || !sameAttemptBinding(
        binding as PermanentStagingProviderVariableWriteLocalAttemptBinding,
        expectedBinding,
      )
    ) return false;
    REFLECT_APPLY(
      WEAK_SET_ADD,
      CLAIMED_LOCAL_WRITE_ATTEMPT_AUTHORITIES,
      [value],
    );
    return true;
  } catch {
    return false;
  }
}

/** Atomically consumes a genuine receipt bound to the exact fresh attempt. */
export function consumePermanentStagingProviderVariableWriteLocalReceiptAuthority(
  value: unknown,
  attemptAuthority: unknown,
): value is PermanentStagingProviderVariableWriteLocalReceipt {
  try {
    if (
      !isPermanentStagingProviderVariableWriteLocalReceiptAuthority(value)
      || typeof attemptAuthority !== "object"
      || attemptAuthority === null
      || REFLECT_APPLY(
        UTIL_IS_PROXY,
        UTIL_TYPES_INTRINSIC,
        [attemptAuthority],
      ) === true
      || REFLECT_APPLY(
        WEAK_SET_HAS,
        CLAIMED_LOCAL_WRITE_ATTEMPT_AUTHORITIES,
        [attemptAuthority],
      ) !== true
      || REFLECT_APPLY(WEAK_SET_HAS, CONSUMED_LOCAL_RECEIPT_AUTHORITIES, [value])
        === true
      || REFLECT_APPLY(WEAK_MAP_GET, LOCAL_RECEIPT_WRITE_ATTEMPTS, [value])
        !== attemptAuthority
    ) return false;
    REFLECT_APPLY(WEAK_SET_ADD, CONSUMED_LOCAL_RECEIPT_AUTHORITIES, [value]);
    return true;
  } catch {
    return false;
  }
}

export function isPermanentStagingProviderVariableWriteLocalReceiptAuthority(
  value: unknown,
): value is PermanentStagingProviderVariableWriteLocalReceipt {
  try {
    return typeof value === "object"
      && value !== null
      && REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [value]) === false
      && REFLECT_APPLY(WEAK_SET_HAS, LOCAL_RECEIPT_AUTHORITIES, [value]) === true;
  } catch {
    return false;
  }
}

type FileHandle = fs.promises.FileHandle;

export interface PermanentStagingProviderVariableWriteLocalAuthorityDependencies {
  readonly open: (filename: string, flags: number) => Promise<FileHandle>;
  readonly lstat: (filename: string) => Promise<fs.BigIntStats>;
  readonly realpath: (filename: string) => Promise<string>;
  readonly effectiveUid: () => number;
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
   * Exercises one child attempt through an injected capability, so this module
   * never gains independent process or credential reachability.
   */
  writeExactlyOnceWithInjectedChild(
    variableName: PermanentStagingProviderVariableName,
    input: PermanentStagingProviderVariableWriteInputHandle,
    intentSha256: string,
    attemptAuthority:
      PermanentStagingProviderVariableWriteLocalAttemptAuthority,
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
  readonly close: FileHandle["close"];
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

const NO_FAILURE: NoFailure = freezeNullRecord({ caught: false });
const MAX_PATH_BYTES = 4_096;
const MAX_BINARY_BYTES = 32 * 1_024 * 1_024;
const READ_CHUNK_BYTES = 64 * 1_024;
const LOCAL_AUTHORITY_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/local-authority/v2\0";
const COMMAND_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/command/v2\0";
const PROCESS_RECEIPT_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/process-receipt/v1\0";

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
                    if (readError !== null) rejectRead(readError);
                    else if (
                      returnedBuffer !== buffer
                      || !NUMBER_IS_SAFE_INTEGER(bytesRead)
                      || bytesRead < 0
                      || bytesRead > length
                    ) rejectRead(invalid());
                    else resolveRead(freezeNullRecord({ bytesRead, buffer }));
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
PermanentStagingProviderVariableWriteLocalAuthorityDependencies = {
  open: openDefaultNativeFile,
  lstat: defaultNativeLstat,
  realpath: defaultNativeRealpath,
  effectiveUid: () => {
    if (typeof PROCESS_GETEUID !== "function") throw invalid();
    return REFLECT_APPLY(PROCESS_GETEUID, PROCESS_INTRINSIC, []);
  },
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
      || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [error]) === true
      || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_INTRINSIC, [error])
        !== INPUT_ERROR_PROTOTYPE
    ) return false;
    const descriptors = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
      OBJECT_INTRINSIC,
      [error],
    ) as Record<PropertyKey, PropertyDescriptor>;
    const read = (key: "code" | "message" | "name"): unknown => {
      if (
        REFLECT_APPLY(
          OBJECT_HAS_OWN,
          OBJECT_INTRINSIC,
          [descriptors, key],
        ) !== true
      ) return undefined;
      const descriptor = descriptors[key];
      return descriptor !== undefined
        && REFLECT_APPLY(
          OBJECT_HAS_OWN,
          OBJECT_INTRINSIC,
          [descriptor, "value"],
        ) === true
        ? descriptor.value
        : undefined;
    };
    return read("code") === "cleanup_failed"
      && read("message") === "cleanup_failed"
      && read("name")
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
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [signal]) === true
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
    || !REFLECT_APPLY(PATH_IS_ABSOLUTE, PATH_INTRINSIC, [value])
    || REFLECT_APPLY(PATH_NORMALIZE, PATH_INTRINSIC, [value]) !== value
    || REFLECT_APPLY(PATH_RESOLVE, PATH_INTRINSIC, [value]) !== value
    || value === (REFLECT_APPLY(
      PATH_PARSE,
      PATH_INTRINSIC,
      [value],
    ) as path.ParsedPath)
      .root
    || REFLECT_APPLY(STRING_INCLUDES, value, ["\0"])
    || regexpMatches(LINE_BREAK_PATTERN, value)
    || REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_INTRINSIC, [value, "utf8"])
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
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [stat]) === true
  ) throw invalid();
  const descriptors = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTORS,
    OBJECT_INTRINSIC,
    [stat],
  ) as Record<PropertyKey, PropertyDescriptor>;
  const field = (key: keyof StableIdentity): bigint => {
    const descriptor = descriptors[key];
    if (
      REFLECT_APPLY(
        OBJECT_HAS_OWN,
        OBJECT_INTRINSIC,
        [descriptors, key],
      ) !== true
      || descriptor === undefined
      || REFLECT_APPLY(
        OBJECT_HAS_OWN,
        OBJECT_INTRINSIC,
        [descriptor, "value"],
      ) !== true
      || typeof descriptor.value !== "bigint"
    ) throw invalid();
    return descriptor.value;
  };
  return freezeNullRecord({
    dev: field("dev"),
    ino: field("ino"),
    uid: field("uid"),
    gid: field("gid"),
    mode: field("mode"),
    nlink: field("nlink"),
    size: field("size"),
    mtimeNs: field("mtimeNs"),
    ctimeNs: field("ctimeNs"),
  });
}

function nativeStatSnapshot(stat: unknown): fs.BigIntStats {
  return freezeNullRecord({ ...identity(stat) }) as unknown as fs.BigIntStats;
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
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [handle]) === true
  ) throw invalid();
  const prototype = OBJECT_GET_PROTOTYPE_OF(handle);
  if (
    prototype !== null
    && (typeof prototype !== "object"
      || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_INTRINSIC, [prototype]) === true)
  ) throw invalid();
  const prototypeDescriptors = prototype === null
    ? OBJECT_CREATE(null) as Record<PropertyKey, PropertyDescriptor>
    : OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(
      prototype,
    ) as Record<PropertyKey, PropertyDescriptor>;
  const method = (key: "read" | "stat" | "close"): Function => {
    const own = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(handle, key);
    const inherited = REFLECT_APPLY(
      OBJECT_HAS_OWN,
      OBJECT_INTRINSIC,
      [prototypeDescriptors, key],
    ) === true ? prototypeDescriptors[key] : undefined;
    const descriptor = own ?? inherited;
    if (
      descriptor === undefined
      || REFLECT_APPLY(
        OBJECT_HAS_OWN,
        OBJECT_INTRINSIC,
        [descriptor, "value"],
      ) !== true
      || typeof descriptor.value !== "function"
    ) throw invalid();
    return descriptor.value as Function;
  };
  const read = method("read") as FileHandle["read"];
  const stat = method("stat") as FileHandle["stat"];
  const close = method("close") as FileHandle["close"];
  return freezeNullRecord({ receiver: handle, read, stat, close });
}

async function closeCapturedFileHandle(
  descriptor: CapturedFileHandle,
): Promise<void> {
  const pending = REFLECT_APPLY(
    descriptor.close,
    descriptor.receiver,
    [],
  ) as unknown;
  if (!REFLECT_APPLY(UTIL_IS_PROMISE, UTIL_TYPES_INTRINSIC, [pending])) {
    throw cleanupFailed();
  }
  await pending;
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
  const rendered = REFLECT_APPLY(JSON_STRINGIFY, JSON_INTRINSIC, [value]);
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
  const hash = REFLECT_APPLY(
    CRYPTO_CREATE_HASH,
    CRYPTO_INTRINSIC,
    ["sha256"],
  );
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
  const digest = REFLECT_APPLY(
    CRYPTO_CREATE_HASH,
    CRYPTO_INTRINSIC,
    ["sha256"],
  );
  let offset = 0;
  while (offset < size) {
    checkSignal(signal);
    const requested = REFLECT_APPLY(MATH_MIN, MATH_INTRINSIC, [
      READ_CHUNK_BYTES,
      size - offset,
    ]);
    const buffer = REFLECT_APPLY(
      BUFFER_ALLOC,
      BUFFER_INTRINSIC,
      [requested],
    ) as Buffer;
    if (
      REFLECT_APPLY(BUFFER_BYTE_LENGTH, BUFFER_INTRINSIC, [buffer]) !== requested
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
        if (!REFLECT_APPLY(
          UTIL_IS_PROMISE,
          UTIL_TYPES_INTRINSIC,
          [pendingRead],
        )) {
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
  lstat: PermanentStagingProviderVariableWriteLocalAuthorityDependencies["lstat"],
  realpath: PermanentStagingProviderVariableWriteLocalAuthorityDependencies["realpath"],
): Promise<StableIdentity> {
  const pathStat = await REFLECT_APPLY(lstat, undefined, [absolutePath]);
  const pendingStat = REFLECT_APPLY(
    descriptor.stat,
    descriptor.receiver,
    [{ bigint: true }],
  ) as unknown;
  if (!REFLECT_APPLY(UTIL_IS_PROMISE, UTIL_TYPES_INTRINSIC, [pendingStat])) {
    throw invalid();
  }
  const descriptorStat = await pendingStat;
  const pathIdentity = assertBinary(pathStat, uid);
  const descriptorIdentity = assertBinary(descriptorStat, uid);
  if (
    !sameIdentity(pathIdentity, expected)
    || !sameIdentity(descriptorIdentity, expected)
    || await REFLECT_APPLY(realpath, undefined, [absolutePath]) !== absolutePath
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

function operationForVariableName(
  value: PermanentStagingProviderVariableName,
): PermanentStagingProviderVariableWriteOperation {
  for (
    let index = 0;
    index < PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS.length;
    index += 1
  ) {
    const operation = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS[index];
    if (operation?.variableName === value) return operation;
  }
  throw invalid();
}

function commandFor(
  variableName: PermanentStagingProviderVariableName,
  binding: PermanentStagingProviderVariableWriteProcessAdapterBinding,
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
  return freezeNullRecord({
    schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_COMMAND_SCHEMA,
    executable: binding.privateExecutableCopyAbsolutePath,
    executableAuthority: freezeNullRecord({
      privateExecutableCopySha256: binding.privateExecutableCopySha256,
      privateExecutableCopyIdentitySha256:
        binding.privateExecutableCopyIdentitySha256,
      privateExecutableCopyAuthoritySha256:
        binding.privateExecutableCopyAuthoritySha256,
      descriptorHeld: true,
    }),
    argv,
    environment: freezeNullRecord({
      inherit: false,
      prototype: "null",
      ownEnumerableDataPropertiesOnly: true,
      exactNames: OBJECT_FREEZE(["RAILWAY_TOKEN"] as const),
      valuesHandledByThisModule: false,
    }),
    shell: false,
    stdin: "pipe",
    stdinWrites: 1,
    stdinEndCalls: 1,
    stdout: "ignore",
    stderr: "ignore",
    maximumCapturedStdoutBytes: 0,
    maximumCapturedStderrBytes: 0,
    detached: true,
    abortSignalSequence: OBJECT_FREEZE(["SIGTERM", "SIGKILL"] as const),
    processGroupEmptyBeforeSettlement: true,
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
    + `"executableAuthority":{"privateExecutableCopySha256":${
      jsonPrimitive(command.executableAuthority.privateExecutableCopySha256)
    },"privateExecutableCopyIdentitySha256":${
      jsonPrimitive(
        command.executableAuthority.privateExecutableCopyIdentitySha256,
      )
    },"privateExecutableCopyAuthoritySha256":${
      jsonPrimitive(
        command.executableAuthority.privateExecutableCopyAuthoritySha256,
      )
    },"descriptorHeld":true},`
    + `"argv":${argv},`
    + `"environment":{"inherit":false,"prototype":"null",`
    + `"ownEnumerableDataPropertiesOnly":true,"exactNames":[${
      jsonPrimitive(command.environment.exactNames[0])
    }],`
    + `"valuesHandledByThisModule":false},`
    + `"shell":false,"stdin":"pipe","stdinWrites":1,"stdinEndCalls":1,`
    + `"stdout":"ignore","stderr":"ignore",`
    + `"maximumCapturedStdoutBytes":0,"maximumCapturedStderrBytes":0,`
    + `"detached":true,"abortSignalSequence":["SIGTERM","SIGKILL"],`
    + `"processGroupEmptyBeforeSettlement":true}`;
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
    + `"bytesHashedFromHeldDescriptor":true,`
    + `"privateExecutableCopyAbsolutePath":${
      jsonPrimitive(value.privateExecutableCopyAbsolutePath)
    },`
    + `"privateExecutableCopySha256":${
      jsonPrimitive(value.privateExecutableCopySha256)
    },`
    + `"privateExecutableCopyBytes":${
      jsonPrimitive(value.privateExecutableCopyBytes)
    },`
    + `"privateExecutableCopyIdentitySha256":${
      jsonPrimitive(value.privateExecutableCopyIdentitySha256)
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
    + `"processAdapterAuthoritySha256":${
      jsonPrimitive(value.processAdapterAuthoritySha256)
    },`
    + `"privateExecutableCopyDescriptorHeld":true,`
    + `"privateExecutableCopyParentMode0700":true,`
    + `"processAdapterInjectedSpawnOnly":true,`
    + `"providerInvokedDuringInspection":false}`;
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
    && left.privateExecutableCopyAbsolutePath
      === right.privateExecutableCopyAbsolutePath
    && left.privateExecutableCopySha256 === right.privateExecutableCopySha256
    && left.privateExecutableCopyBytes === right.privateExecutableCopyBytes
    && left.privateExecutableCopyIdentitySha256
      === right.privateExecutableCopyIdentitySha256
    && left.privateExecutableCopyAuthoritySha256
      === right.privateExecutableCopyAuthoritySha256
    && left.environmentAuthoritySha256 === right.environmentAuthoritySha256
    && left.stdinAuthoritySha256 === right.stdinAuthoritySha256
    && left.processGroupAuthoritySha256 === right.processGroupAuthoritySha256
    && left.processAdapterAuthoritySha256
      === right.processAdapterAuthoritySha256
    && left.privateExecutableCopyDescriptorHeld
      === right.privateExecutableCopyDescriptorHeld
    && left.privateExecutableCopyParentMode0700
      === right.privateExecutableCopyParentMode0700
    && left.processAdapterInjectedSpawnOnly
      === right.processAdapterInjectedSpawnOnly
    && left.providerInvokedDuringInspection
      === right.providerInvokedDuringInspection;
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
    || value.callbackIngressOnly !== true
    || value.stdinSourceAuthorityAvailable !== false
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
  processAdapterBindingInput:
    PermanentStagingProviderVariableWriteProcessAdapterBinding,
  dependencies:
  PermanentStagingProviderVariableWriteLocalAuthorityDependencies =
  DEFAULT_DEPENDENCIES,
): Promise<PermanentStagingProviderVariableWriteLocalAuthorityHandle> {
  const usesDefaultDependencies = dependencies === DEFAULT_DEPENDENCIES;
  const dependencyDescriptors = ownDataDescriptors(dependencies, [
    "open",
    "lstat",
    "realpath",
    "effectiveUid",
  ]);
  if (dependencyDescriptors === null) throw invalid();
  const openFile = dependencyDescriptors.open?.value;
  const lstat = dependencyDescriptors.lstat?.value;
  const realpath = dependencyDescriptors.realpath?.value;
  const effectiveUid = dependencyDescriptors.effectiveUid?.value;
  if (
    typeof openFile !== "function"
    || typeof lstat !== "function"
    || typeof realpath !== "function"
    || typeof effectiveUid !== "function"
  ) throw invalid();
  const cli = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.railwayCli;
  const absolutePath = exactAbsolutePath(cli.absolutePath);
  const processAdapterBinding = exactProcessAdapterBinding(
    processAdapterBindingInput,
  );
  const processAdapterBindingAuthority = processAdapterBindingInput;
  if (!regexpMatches(LOWERCASE_HEX_64_PATTERN, cli.sha256)) {
    throw invalid();
  }
  if (
    processAdapterBinding.privateExecutableCopyAbsolutePath === absolutePath
    || processAdapterBinding.privateExecutableCopySha256 !== cli.sha256
  ) throw invalid();
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
    uid = safeUid(REFLECT_APPLY(effectiveUid, undefined, []));
    const before = await REFLECT_APPLY(lstat, undefined, [absolutePath]);
    const beforeIdentity = assertBinary(before, uid);
    if (await REFLECT_APPLY(realpath, undefined, [absolutePath]) !== absolutePath) {
      throw invalid();
    }
    baseline = beforeIdentity;
    const opened = await REFLECT_APPLY(openFile, undefined, [
      absolutePath,
      O_RDONLY_EXACT | O_NOFOLLOW_EXACT,
    ]) as FileHandle;
    if (
      usesDefaultDependencies
      && !defaultNativeFileHandleExact(opened)
    ) throw invalid();
    handle = opened;
    descriptor = captureFileHandle(opened);
    await stablePathAndDescriptor(
      absolutePath,
      descriptor,
      baseline,
      uid,
      lstat,
      realpath,
    );
  } catch (error) {
    initialFailure = capture(error);
  }
  if (initialFailure.caught) {
    if (handle !== undefined) {
      try {
        await closeCapturedFileHandle(
          descriptor ?? captureFileHandle(handle),
        );
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
  if (processAdapterBinding.privateExecutableCopyBytes !== exactSize(baseline.size)) {
    try {
      await closeCapturedFileHandle(descriptor);
    } catch {
      throw cleanupFailed();
    }
    throw invalid();
  }

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
      lstat,
      realpath,
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
      lstat,
      realpath,
    );
    checkSignal(signal);
    return freezeNullRecord({
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
      privateExecutableCopyAbsolutePath:
        processAdapterBinding.privateExecutableCopyAbsolutePath,
      privateExecutableCopySha256:
        processAdapterBinding.privateExecutableCopySha256,
      privateExecutableCopyBytes:
        processAdapterBinding.privateExecutableCopyBytes,
      privateExecutableCopyIdentitySha256:
        processAdapterBinding.privateExecutableCopyIdentitySha256,
      privateExecutableCopyAuthoritySha256:
        processAdapterBinding.privateExecutableCopyAuthoritySha256,
      environmentAuthoritySha256:
        processAdapterBinding.environmentAuthoritySha256,
      stdinAuthoritySha256: processAdapterBinding.stdinAuthoritySha256,
      processGroupAuthoritySha256:
        processAdapterBinding.processGroupAuthoritySha256,
      processAdapterAuthoritySha256:
        processAdapterBinding.processAdapterAuthoritySha256,
      privateExecutableCopyDescriptorHeld: true,
      privateExecutableCopyParentMode0700: true,
      processAdapterInjectedSpawnOnly: true,
      providerInvokedDuringInspection: false,
    } as const satisfies PermanentStagingProviderVariableWriteLocalInspection);
  };

  const closeHeld = async (): Promise<void> => {
    try {
      await closeCapturedFileHandle(heldDescriptor);
      state = "closed";
    } catch {
      state = "failed";
      throw cleanupFailed();
    }
  };

  return freezeNullRecord({
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
      return commandFor(variableNameInput, processAdapterBinding);
    },
    async writeExactlyOnceWithInjectedChild(
      variableNameInput,
      input,
      intentSha256Input,
      attemptAuthority,
      launchChild,
      signal,
    ) {
      if (
        state !== "open"
        || inspected === undefined
        || childAttempted
        || !exactLowercaseHex64(intentSha256Input)
        || typeof launchChild !== "function"
        || !isPermanentStagingProviderVariableWriteInputHandleAuthority(input)
      ) throw invalid();
      exactVariableName(variableNameInput);
      const writeOperation = operationForVariableName(variableNameInput);
      checkSignal(signal);
      state = "writing";
      let inputInspection:
      PermanentStagingProviderVariableWriteInputInspection | undefined;
      let child: CapturedInjectedChild | undefined;
      let childAuthority: object | undefined;
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
          || reassertedInput.byteLength !== inputInspection.byteLength
        ) throw invalid();
        const command = commandFor(variableNameInput, processAdapterBinding);
        const localAuthorityDigest = localAuthoritySha256(local);
        const commandDigest = commandSha256(command);
        if (
          !claimLocalWriteAttemptAuthority(attemptAuthority, {
            operationId: writeOperation.operationId,
            variableName: variableNameInput,
            inputCommitmentSha256: inputInspection.commitmentSha256,
            inputByteLength: inputInspection.byteLength,
            intentSha256: intentSha256Input,
            localAuthoritySha256: localAuthorityDigest,
            commandSha256: commandDigest,
            processAdapterAuthoritySha256:
              processAdapterBinding.processAdapterAuthoritySha256,
            privateExecutableCopyAuthoritySha256:
              processAdapterBinding.privateExecutableCopyAuthoritySha256,
            environmentAuthoritySha256:
              processAdapterBinding.environmentAuthoritySha256,
            stdinAuthoritySha256: processAdapterBinding.stdinAuthoritySha256,
            processGroupAuthoritySha256:
              processAdapterBinding.processGroupAuthoritySha256,
          })
          || !claimPermanentStagingProviderVariableWriteProcessLauncherAuthority(
            processAdapterBindingAuthority,
            launchChild,
          )
        ) throw invalid();
        childAttempted = true;
        const launched = REFLECT_APPLY(
          launchChild,
          undefined,
          [command, signal],
        ) as unknown;
        const launchedChild = REFLECT_APPLY(
          UTIL_IS_PROMISE,
          UTIL_TYPES_INTRINSIC,
          [launched],
        )
          ? await launched
          : launched;
        if (!claimPermanentStagingProviderVariableWriteProcessChildAuthority(
          launchChild,
          launchedChild,
        )) throw invalid();
        childAuthority = launchedChild;
        child = captureInjectedChild(launchedChild) ?? undefined;
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
                  if (!REFLECT_APPLY(
                    UTIL_IS_PROMISE,
                    UTIL_TYPES_INTRINSIC,
                    [writeResult],
                  )) {
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
          if (!claimPermanentStagingProviderVariableWriteProcessChildResultAuthority(
            childAuthority,
            observedResult,
          )) throw writeFailed();
          childResult = exactChildResult(
            observedResult,
            processAdapterBinding,
          ) ?? undefined;
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
        const receipt = freezeNullRecord({
          schemaVersion:
            PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCAL_RECEIPT_SCHEMA,
          variableName: variableNameInput,
          inputCommitmentSha256: inputInspection.commitmentSha256,
          intentSha256: intentSha256Input,
          localAuthoritySha256: localAuthorityDigest,
          commandSha256: commandDigest,
          processAdapterAuthoritySha256:
            processAdapterBinding.processAdapterAuthoritySha256,
          privateExecutableCopyAuthoritySha256:
            processAdapterBinding.privateExecutableCopyAuthoritySha256,
          environmentAuthoritySha256:
            processAdapterBinding.environmentAuthoritySha256,
          stdinAuthoritySha256: processAdapterBinding.stdinAuthoritySha256,
          processGroupAuthoritySha256:
            processAdapterBinding.processGroupAuthoritySha256,
          processAdapterReceiptSha256:
            childResult.processAdapterReceiptSha256,
          childAttempts: 1,
          stdinWrites: 1,
          exitCode: 0,
          signal: null,
          stdoutBytesCaptured: 0,
          stderrBytesCaptured: 0,
          childCloseAwaited: true,
          environmentNullPrototype: true,
          stdinWriteCompleted: true,
          stdinEof: true,
          detachedProcessGroup: true,
          processGroupEmpty: true,
          closeAndErrorSettled: true,
          providerAcknowledgementInspected: false,
        } as const satisfies PermanentStagingProviderVariableWriteLocalReceipt);
        REFLECT_APPLY(WEAK_SET_ADD, LOCAL_RECEIPT_AUTHORITIES, [receipt]);
        REFLECT_APPLY(
          WEAK_MAP_SET,
          LOCAL_RECEIPT_WRITE_ATTEMPTS,
          [receipt, attemptAuthority],
        );
        return receipt;
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
          await closeCapturedFileHandle(heldDescriptor);
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
