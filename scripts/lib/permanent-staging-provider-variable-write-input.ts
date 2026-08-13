import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK,
  type PermanentStagingProviderVariableName,
} from "./permanent-staging-provider-variable-write-railway-contract.js";

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-input/v2" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_COMMITMENT_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/input-commitment/v1" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_MAXIMUM_VALUE_BYTES =
  4_096 as const;

export type PermanentStagingProviderVariableWriteInputFailureCode =
  | "input_invalid"
  | "input_unavailable"
  | "cleanup_failed";

export class PermanentStagingProviderVariableWriteInputError extends Error {
  readonly code!: PermanentStagingProviderVariableWriteInputFailureCode;

  constructor(code: PermanentStagingProviderVariableWriteInputFailureCode) {
    super(code);
    OBJECT_DEFINE_PROPERTY(this, "name", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: "PermanentStagingProviderVariableWriteInputError",
    });
    OBJECT_DEFINE_PROPERTY(this, "message", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: code,
    });
    OBJECT_DEFINE_PROPERTY(this, "code", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: code,
    });
  }
}

export interface PermanentStagingProviderVariableWriteInputInspection {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_SCHEMA;
  readonly variableName: PermanentStagingProviderVariableName;
  readonly byteLength: number;
  readonly commitmentDomain:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_COMMITMENT_DOMAIN;
  readonly commitmentSha256: string;
  readonly callbackIngressOnly: true;
  readonly stdinSourceAuthorityAvailable: false;
  readonly validUtf8: true;
  readonly controlCharactersAbsent: true;
}

export interface PermanentStagingProviderVariableWriteInputSource {
  readonly isTTY?: boolean;
  readonly readExactlyOnce: (
    consumeChunk: (chunk: Uint8Array) => void,
    settle: (failure?: unknown) => void,
    signal: AbortSignal,
  ) => void;
}

export interface PermanentStagingProviderVariableWriteInputHandle {
  /** Returns only non-secret binding metadata. */
  inspect(): PermanentStagingProviderVariableWriteInputInspection;
  /** Re-hashes the held bytes and fails if their original binding changed. */
  reassert(): PermanentStagingProviderVariableWriteInputInspection;
  /**
   * Gives one ephemeral Buffer to one writer. The Buffer and held source are
   * zeroized after the attempt, including when the writer rejects.
   */
  writeExactlyOnce(
    writer: (value: Buffer, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  /** Idempotently zeroizes the held value without writing it. */
  close(): void;
}

const INPUT_HANDLE_AUTHORITIES = new WeakSet<object>();
const INPUT_ERROR_AUTHORITIES = new WeakMap<
  object,
  PermanentStagingProviderVariableWriteInputFailureCode
>();
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;

/**
 * Confirms that a handle was created by this module without exposing any way
 * for callers to add a forged handle to the private authority registry.
 */
export function isPermanentStagingProviderVariableWriteInputHandleAuthority(
  value: unknown,
): value is PermanentStagingProviderVariableWriteInputHandle {
  return typeof value === "object"
    && value !== null
    && REFLECT_APPLY(WEAK_SET_HAS, INPUT_HANDLE_AUTHORITIES, [value]) === true;
}

type InputState = "open" | "writing" | "closed" | "failed";

interface CapturedFailure {
  readonly caught: true;
  readonly error: unknown;
}

interface NoFailure {
  readonly caught: false;
}

type FailureState = CapturedFailure | NoFailure;

const ARRAY_BUFFER_EXACT = ArrayBuffer;
const BUFFER_EXACT = Buffer;
const CRYPTO_EXACT = crypto;
const OBJECT_EXACT = Object;
const REFLECT_EXACT = Reflect;
const STRING_EXACT = String;
const UINT8_ARRAY_EXACT = Uint8Array;
const UTIL_TYPES_EXACT = utilTypes;
const ARRAY_BUFFER_IS_VIEW = ARRAY_BUFFER_EXACT.isView;
const ARRAY_BUFFER_PROTOTYPE = ARRAY_BUFFER_EXACT.prototype;
const BUFFER_ALLOC = BUFFER_EXACT.alloc;
const BUFFER_IS_BUFFER = BUFFER_EXACT.isBuffer;
const BUFFER_PROTOTYPE = BUFFER_EXACT.prototype;
const BUFFER_WRITE_UINT32_BE = BUFFER_PROTOTYPE.writeUInt32BE;
const CRYPTO_CREATE_HASH = CRYPTO_EXACT.createHash;
const CRYPTO_TIMING_SAFE_EQUAL = CRYPTO_EXACT.timingSafeEqual;
const OBJECT_DEFINE_PROPERTY = OBJECT_EXACT.defineProperty;
const OBJECT_FREEZE = OBJECT_EXACT.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  OBJECT_EXACT.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS =
  OBJECT_EXACT.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = OBJECT_EXACT.getPrototypeOf;
const OBJECT_HAS_OWN = OBJECT_EXACT.hasOwn;
const OBJECT_SET_PROTOTYPE_OF = OBJECT_EXACT.setPrototypeOf;
const PROMISE_EXACT = Promise;
const PROMISE_PROTOTYPE = PROMISE_EXACT.prototype;
const PROMISE_THEN = PROMISE_PROTOTYPE.then;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const REFLECT_APPLY = REFLECT_EXACT.apply;
const SET_HAS = Set.prototype.has;
const STRING_CONSTRUCTOR = STRING_EXACT;
const STRING_CHAR_CODE_AT = STRING_EXACT.prototype.charCodeAt;
const UINT8_ARRAY_PROTOTYPE = UINT8_ARRAY_EXACT.prototype;
const UINT8_ARRAY_FILL = UINT8_ARRAY_PROTOTYPE.fill;
const UINT8_ARRAY_SET = UINT8_ARRAY_PROTOTYPE.set;
const UTIL_IS_PROXY = UTIL_TYPES_EXACT.isProxy;
function freezeNullRecord<T extends object>(value: T): T {
  REFLECT_APPLY(OBJECT_SET_PROTOTYPE_OF, OBJECT_EXACT, [value, null]);
  return OBJECT_FREEZE(value);
}

const NO_FAILURE: NoFailure = freezeNullRecord({ caught: false });
const ALLOWED_VARIABLE_NAMES = new Set<string>(
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK
    .allowedVariableNames,
);
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(UINT8_ARRAY_PROTOTYPE) as
  object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const TYPED_ARRAY_BUFFER_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset",
)?.get;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  ARRAY_BUFFER_PROTOTYPE,
  "byteLength",
)?.get;
const EVENT_TARGET_PROTOTYPE = EventTarget.prototype;
const EVENT_TARGET_ADD_EVENT_LISTENER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  EVENT_TARGET_PROTOTYPE,
  "addEventListener",
)?.value;
const EVENT_TARGET_REMOVE_EVENT_LISTENER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  EVENT_TARGET_PROTOTYPE,
  "removeEventListener",
)?.value;
const ABORT_SIGNAL_PROTOTYPE = AbortSignal.prototype;
const ABORT_SIGNAL_ABORTED_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  ABORT_SIGNAL_PROTOTYPE,
  "aborted",
)?.get;
const HASH_PROBE = REFLECT_APPLY(CRYPTO_CREATE_HASH, CRYPTO_EXACT, ["sha256"]);
const HASH_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(HASH_PROBE) as {
  readonly update: (...args: never[]) => unknown;
  readonly digest: (...args: never[]) => unknown;
};
const HASH_UPDATE = HASH_PROTOTYPE.update;
const HASH_DIGEST = HASH_PROTOTYPE.digest;
REFLECT_APPLY(HASH_DIGEST, HASH_PROBE, []);
const LOWERCASE_HEX = "0123456789abcdef";

function invalid(): PermanentStagingProviderVariableWriteInputError {
  return internalError("input_invalid");
}

function unavailable(): PermanentStagingProviderVariableWriteInputError {
  return internalError("input_unavailable");
}

function cleanupFailed(): PermanentStagingProviderVariableWriteInputError {
  return internalError("cleanup_failed");
}

function internalError(
  code: PermanentStagingProviderVariableWriteInputFailureCode,
): PermanentStagingProviderVariableWriteInputError {
  const error = new PermanentStagingProviderVariableWriteInputError(code);
  REFLECT_APPLY(WEAK_MAP_SET, INPUT_ERROR_AUTHORITIES, [error, code]);
  return error;
}

function normalizeFailure(error: unknown): never {
  if (typeof error === "object" && error !== null) {
    const code = REFLECT_APPLY(WEAK_MAP_GET, INPUT_ERROR_AUTHORITIES, [error]);
    if (
      code === "input_invalid"
      || code === "input_unavailable"
      || code === "cleanup_failed"
    ) throw internalError(code);
  }
  throw invalid();
}

function checkSignal(signal: AbortSignal): void {
  try {
    if (
      typeof signal !== "object"
      || signal === null
      || typeof ABORT_SIGNAL_ABORTED_GETTER !== "function"
      || OBJECT_GET_PROTOTYPE_OF(signal) !== ABORT_SIGNAL_PROTOTYPE
      || REFLECT_APPLY(ABORT_SIGNAL_ABORTED_GETTER, signal, []) !== false
    ) throw invalid();
  } catch (error) {
    normalizeFailure(error);
  }
}

function capture(error: unknown): CapturedFailure {
  return { caught: true, error };
}

function zeroize(value: Uint8Array): void {
  REFLECT_APPLY(UINT8_ARRAY_FILL, value, [0]);
}

function exactChunkLength(value: Uint8Array): number {
  if (typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function") throw invalid();
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  if (prototype !== UINT8_ARRAY_PROTOTYPE && prototype !== BUFFER_PROTOTYPE) {
    throw invalid();
  }
  const length = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
  if (!NUMBER_IS_SAFE_INTEGER(length) || length < 0) throw invalid();
  return length;
}

function exactDedicatedBuffer(value: unknown, expectedLength: number): value is Buffer {
  if (
    typeof TYPED_ARRAY_BUFFER_GETTER !== "function"
    || typeof TYPED_ARRAY_BYTE_OFFSET_GETTER !== "function"
    || typeof ARRAY_BUFFER_BYTE_LENGTH_GETTER !== "function"
    || !REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_EXACT, [value])
    || !REFLECT_APPLY(ARRAY_BUFFER_IS_VIEW, ARRAY_BUFFER_EXACT, [value])
    || OBJECT_GET_PROTOTYPE_OF(value) !== BUFFER_PROTOTYPE
    || exactChunkLength(value as Buffer) !== expectedLength
  ) return false;
  const offset = REFLECT_APPLY(TYPED_ARRAY_BYTE_OFFSET_GETTER, value, []);
  const backing = REFLECT_APPLY(TYPED_ARRAY_BUFFER_GETTER, value, []);
  const backingLength = REFLECT_APPLY(
    ARRAY_BUFFER_BYTE_LENGTH_GETTER,
    backing,
    [],
  );
  return offset === 0 && backingLength === expectedLength;
}

function asciiBuffer(value: string): Buffer {
  const output = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_EXACT, [value.length]) as Buffer;
  if (!exactDedicatedBuffer(output, value.length)) throw invalid();
  for (let index = 0; index < value.length; index += 1) {
    const code = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index]) as number;
    if (!NUMBER_IS_SAFE_INTEGER(code) || code < 0 || code > 0x7f) {
      zeroize(output);
      throw invalid();
    }
    output[index] = code;
  }
  return output;
}

function exactLowercaseHex(value: Buffer, expectedLength: number): string {
  if (exactChunkLength(value) !== expectedLength) throw invalid();
  let output = "";
  for (let index = 0; index < expectedLength; index += 1) {
    const byte = value[index];
    if (
      typeof byte !== "number"
      || !NUMBER_IS_SAFE_INTEGER(byte)
      || byte < 0
      || byte > 0xff
    ) {
      throw invalid();
    }
    output += LOWERCASE_HEX[byte >>> 4] ?? "";
    output += LOWERCASE_HEX[byte & 0x0f] ?? "";
  }
  if (output.length !== expectedLength * 2) throw invalid();
  return output;
}

function zeroizeChunks(values: readonly Buffer[]): boolean {
  let exact = true;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) {
      exact = false;
      continue;
    }
    try {
      zeroize(value);
    } catch {
      exact = false;
    }
  }
  return exact;
}

function exactVariableName(
  value: unknown,
): asserts value is PermanentStagingProviderVariableName {
  if (
    typeof value !== "string"
    || REFLECT_APPLY(SET_HAS, ALLOWED_VARIABLE_NAMES, [value]) !== true
  ) {
    throw invalid();
  }
}

function continuation(value: number | undefined): value is number {
  return value !== undefined && value >= 0x80 && value <= 0xbf;
}

function assertAllowedCodePoint(codePoint: number): void {
  if (
    codePoint === 0
    || codePoint === 0x0a
    || codePoint === 0x0d
    || codePoint <= 0x1f
    || codePoint >= 0x7f && codePoint <= 0x9f
  ) throw invalid();
}

/** Validates UTF-8 without materializing the secret as an immutable JS string. */
function assertValidUtf8WithoutControls(value: Buffer): void {
  const valueLength = exactChunkLength(value);
  let offset = 0;
  while (offset < valueLength) {
    const first = value[offset];
    if (first === undefined) throw invalid();
    if (first <= 0x7f) {
      assertAllowedCodePoint(first);
      offset += 1;
      continue;
    }

    const second = value[offset + 1];
    if (first >= 0xc2 && first <= 0xdf && continuation(second)) {
      assertAllowedCodePoint(((first & 0x1f) << 6) | (second & 0x3f));
      offset += 2;
      continue;
    }

    const third = value[offset + 2];
    if (
      first >= 0xe0
      && first <= 0xef
      && continuation(second)
      && continuation(third)
      && !(first === 0xe0 && second < 0xa0)
      && !(first === 0xed && second > 0x9f)
    ) {
      const codePoint = ((first & 0x0f) << 12)
        | ((second & 0x3f) << 6)
        | (third & 0x3f);
      assertAllowedCodePoint(codePoint);
      offset += 3;
      continue;
    }

    const fourth = value[offset + 3];
    if (
      first >= 0xf0
      && first <= 0xf4
      && continuation(second)
      && continuation(third)
      && continuation(fourth)
      && !(first === 0xf0 && second < 0x90)
      && !(first === 0xf4 && second > 0x8f)
    ) {
      const codePoint = ((first & 0x07) << 18)
        | ((second & 0x3f) << 12)
        | ((third & 0x3f) << 6)
        | (fourth & 0x3f);
      assertAllowedCodePoint(codePoint);
      offset += 4;
      continue;
    }

    throw invalid();
  }
}

function commitment(
  variableName: PermanentStagingProviderVariableName,
  value: Buffer,
): Buffer {
  const domain = asciiBuffer(
    `${PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_COMMITMENT_DOMAIN}\0`,
  );
  const name = asciiBuffer(variableName);
  const nameLength = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_EXACT, [4]) as Buffer;
  const valueLength = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_EXACT, [4]) as Buffer;
  REFLECT_APPLY(BUFFER_WRITE_UINT32_BE, nameLength, [exactChunkLength(name)]);
  REFLECT_APPLY(BUFFER_WRITE_UINT32_BE, valueLength, [exactChunkLength(value)]);
  try {
    const hash = REFLECT_APPLY(CRYPTO_CREATE_HASH, CRYPTO_EXACT, ["sha256"]);
    REFLECT_APPLY(HASH_UPDATE, hash, [domain]);
    REFLECT_APPLY(HASH_UPDATE, hash, [nameLength]);
    REFLECT_APPLY(HASH_UPDATE, hash, [name]);
    REFLECT_APPLY(HASH_UPDATE, hash, [valueLength]);
    REFLECT_APPLY(HASH_UPDATE, hash, [value]);
    const digest = REFLECT_APPLY(HASH_DIGEST, hash, []);
    if (
      !REFLECT_APPLY(BUFFER_IS_BUFFER, BUFFER_EXACT, [digest])
      || !REFLECT_APPLY(ARRAY_BUFFER_IS_VIEW, ARRAY_BUFFER_EXACT, [digest])
      || OBJECT_GET_PROTOTYPE_OF(digest) !== BUFFER_PROTOTYPE
      || !exactDedicatedBuffer(digest, 32)
    ) throw invalid();
    return digest as Buffer;
  } finally {
    zeroize(domain);
    zeroize(name);
    zeroize(nameLength);
    zeroize(valueLength);
  }
}

async function readBoundedValue(
  source: PermanentStagingProviderVariableWriteInputSource,
  signal: AbortSignal,
): Promise<{ readonly value: Buffer }> {
  if (
    typeof source !== "object"
    || source === null
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_EXACT, [source]) === true
  ) throw invalid();
  const sourceDescriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(source) as
    Record<PropertyKey, PropertyDescriptor>;
  const readDescriptor = OBJECT_HAS_OWN(sourceDescriptors, "readExactlyOnce")
    ? sourceDescriptors.readExactlyOnce
    : undefined;
  const ttyDescriptor = OBJECT_HAS_OWN(sourceDescriptors, "isTTY")
    ? sourceDescriptors.isTTY
    : undefined;
  if (
    readDescriptor === undefined
    || !OBJECT_HAS_OWN(readDescriptor, "value")
    || typeof readDescriptor.value !== "function"
    || ttyDescriptor !== undefined
      && (!OBJECT_HAS_OWN(ttyDescriptor, "value") || ttyDescriptor.value !== false)
  ) throw invalid();
  const readExactlyOnce = readDescriptor.value as
    PermanentStagingProviderVariableWriteInputSource["readExactlyOnce"];
  checkSignal(signal);

  const chunks: Buffer[] = [];
  let byteLength = 0;
  let prior: FailureState = NO_FAILURE;
  let accepting = true;
  let consuming = false;
  let settled = false;
  let abortObserved = false;
  let completionResolved = false;
  let listenerInstalled = false;
  let resolveCompletion!: () => void;
  const completion = new PROMISE_EXACT<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const finishCompletion = (): void => {
    if (completionResolved) return;
    completionResolved = true;
    resolveCompletion();
  };
  const latchFailure = (error: unknown): void => {
    const code = typeof error === "object" && error !== null
      ? REFLECT_APPLY(WEAK_MAP_GET, INPUT_ERROR_AUTHORITIES, [error])
      : undefined;
    if (code === "cleanup_failed" || !prior.caught) prior = capture(error);
  };
  const consumeChunk = (chunk: Uint8Array): void => {
    try {
      if (!accepting || consuming) {
        try {
          if (REFLECT_APPLY(ARRAY_BUFFER_IS_VIEW, ARRAY_BUFFER_EXACT, [chunk])) {
            zeroize(chunk);
          }
        } catch {
          throw cleanupFailed();
        }
        throw invalid();
      }
      consuming = true;
      let owned: Buffer | undefined;
      let transferred = false;
      try {
        checkSignal(signal);
        if (!REFLECT_APPLY(ARRAY_BUFFER_IS_VIEW, ARRAY_BUFFER_EXACT, [chunk])) {
          throw invalid();
        }
        const chunkLength = exactChunkLength(chunk);
        if (chunkLength === 0) throw invalid();
        const nextLength = byteLength + chunkLength;
        if (
          !NUMBER_IS_SAFE_INTEGER(nextLength)
          || nextLength
            > PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_MAXIMUM_VALUE_BYTES
        ) throw invalid();
        owned = REFLECT_APPLY(
          BUFFER_ALLOC,
          BUFFER_EXACT,
          [chunkLength],
        ) as Buffer;
        if (!exactDedicatedBuffer(owned, chunkLength)) throw invalid();
        REFLECT_APPLY(UINT8_ARRAY_SET, owned, [chunk]);
        const chunkIndex = chunks.length;
        const chunkKey = REFLECT_APPLY(
          STRING_CONSTRUCTOR,
          undefined,
          [chunkIndex],
        ) as string;
        OBJECT_DEFINE_PROPERTY(chunks, chunkKey, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: owned,
        });
        if (
          chunks.length !== chunkIndex + 1
          || chunks[chunkIndex] !== owned
        ) throw invalid();
        transferred = true;
        byteLength = nextLength;
      } finally {
        let cleanupExact = true;
        if (owned !== undefined && !transferred) {
          try {
            zeroize(owned);
          } catch {
            cleanupExact = false;
          }
        }
        try {
          if (REFLECT_APPLY(ARRAY_BUFFER_IS_VIEW, ARRAY_BUFFER_EXACT, [chunk])) {
            zeroize(chunk);
          }
        } catch {
          cleanupExact = false;
        }
        consuming = false;
        if (!cleanupExact) throw cleanupFailed();
      }
    } catch (error) {
      accepting = false;
      latchFailure(error);
      finishCompletion();
      throw error;
    }
  };
  const settle = (failure?: unknown): void => {
    if (abortObserved) return;
    if (settled || consuming) {
      const error = invalid();
      accepting = false;
      latchFailure(error);
      finishCompletion();
      throw error;
    }
    settled = true;
    accepting = false;
    if (failure !== undefined) latchFailure(failure);
    finishCompletion();
  };
  const onAbort = (): void => {
    if (abortObserved) return;
    abortObserved = true;
    accepting = false;
    latchFailure(invalid());
    try {
      if (!zeroizeChunks(chunks)) latchFailure(cleanupFailed());
    } catch {
      latchFailure(cleanupFailed());
    }
    finishCompletion();
  };
  try {
    try {
      if (
        typeof EVENT_TARGET_ADD_EVENT_LISTENER !== "function"
        || typeof EVENT_TARGET_REMOVE_EVENT_LISTENER !== "function"
      ) throw invalid();
      REFLECT_APPLY(EVENT_TARGET_ADD_EVENT_LISTENER, signal, [
        "abort",
        onAbort,
        false,
      ]);
      listenerInstalled = true;
      if (
        typeof ABORT_SIGNAL_ABORTED_GETTER !== "function"
        || REFLECT_APPLY(ABORT_SIGNAL_ABORTED_GETTER, signal, []) !== false
      ) onAbort();
      const returned = REFLECT_APPLY(readExactlyOnce, source, [
        consumeChunk,
        settle,
        signal,
      ]) as unknown;
      if (returned !== undefined) {
        if (
          typeof returned === "object"
          && returned !== null
          && REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_EXACT, [returned]) !== true
          && OBJECT_GET_PROTOTYPE_OF(returned) === PROMISE_PROTOTYPE
        ) {
          REFLECT_APPLY(PROMISE_THEN, returned, [
            undefined,
            () => undefined,
          ]);
        }
        accepting = false;
        latchFailure(invalid());
        finishCompletion();
      }
    } catch (error) {
      accepting = false;
      latchFailure(error);
      finishCompletion();
    }
    await completion;
    checkSignal(signal);
  } catch (error) {
    latchFailure(error);
  } finally {
    accepting = false;
    if (listenerInstalled) {
      try {
        REFLECT_APPLY(EVENT_TARGET_REMOVE_EVENT_LISTENER, signal, [
          "abort",
          onAbort,
          false,
        ]);
      } catch {
        latchFailure(cleanupFailed());
      }
    }
  }

  const finalFailure = prior as FailureState;
  if (finalFailure.caught) {
    if (!zeroizeChunks(chunks)) throw cleanupFailed();
    normalizeFailure(finalFailure.error);
  }

  if (byteLength === 0) throw invalid();
  let value: Buffer | undefined;
  try {
    value = REFLECT_APPLY(BUFFER_ALLOC, BUFFER_EXACT, [byteLength]) as Buffer;
    if (!exactDedicatedBuffer(value, byteLength)) throw invalid();
    let offset = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk === undefined) throw invalid();
      REFLECT_APPLY(UINT8_ARRAY_SET, value, [chunk, offset]);
      offset += exactChunkLength(chunk);
    }
    return freezeNullRecord({ value });
  } catch (error) {
    if (value !== undefined) zeroize(value);
    throw error;
  } finally {
    if (!zeroizeChunks(chunks)) throw cleanupFailed();
  }
}

export async function readPermanentStagingProviderVariableWriteInput(
  variableNameInput: unknown,
  source: PermanentStagingProviderVariableWriteInputSource,
  signal: AbortSignal,
): Promise<PermanentStagingProviderVariableWriteInputHandle> {
  exactVariableName(variableNameInput);
  let value: Buffer | undefined;
  try {
    value = (await readBoundedValue(source, signal)).value;
    checkSignal(signal);
    assertValidUtf8WithoutControls(value);
  } catch (error) {
    if (value !== undefined) zeroize(value);
    normalizeFailure(error);
  }

  const variableName = variableNameInput;
  const heldValue = value;
  let originalCommitment: Buffer;
  try {
    originalCommitment = commitment(variableName, heldValue);
  } catch (error) {
    zeroize(heldValue);
    normalizeFailure(error);
  }
  let inspection: PermanentStagingProviderVariableWriteInputInspection;
  try {
    inspection = freezeNullRecord({
      schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_SCHEMA,
      variableName,
      byteLength: exactChunkLength(heldValue),
      commitmentDomain:
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_COMMITMENT_DOMAIN,
      commitmentSha256: exactLowercaseHex(originalCommitment, 32),
      callbackIngressOnly: true,
      stdinSourceAuthorityAvailable: false,
      validUtf8: true,
      controlCharactersAbsent: true,
    } as const satisfies PermanentStagingProviderVariableWriteInputInspection);
  } catch (error) {
    let cleanupExact = true;
    try {
      zeroize(heldValue);
    } catch {
      cleanupExact = false;
    }
    try {
      zeroize(originalCommitment);
    } catch {
      cleanupExact = false;
    }
    if (!cleanupExact) throw cleanupFailed();
    normalizeFailure(error);
  }
  let state: InputState = "open";

  const destroy = (): void => {
    let exact = true;
    try {
      zeroize(heldValue);
    } catch {
      exact = false;
    }
    try {
      zeroize(originalCommitment);
    } catch {
      exact = false;
    }
    state = exact ? "closed" : "failed";
    if (!exact) throw cleanupFailed();
  };

  const assertHeldCommitment = (): void => {
    let observed: Buffer | undefined;
    try {
      observed = commitment(variableName, heldValue);
      if (
        exactChunkLength(observed) !== exactChunkLength(originalCommitment)
        || !REFLECT_APPLY(CRYPTO_TIMING_SAFE_EQUAL, CRYPTO_EXACT, [
          observed,
          originalCommitment,
        ])
      ) {
        throw invalid();
      }
    } catch (error) {
      let cleanupExact = true;
      if (observed !== undefined) {
        try {
          zeroize(observed);
        } catch {
          cleanupExact = false;
        }
      }
      try {
        destroy();
      } catch {
        cleanupExact = false;
      }
      state = "failed";
      if (!cleanupExact) throw cleanupFailed();
      normalizeFailure(error);
    }
    zeroize(observed);
  };

  const reassert = (): PermanentStagingProviderVariableWriteInputInspection => {
    if (state !== "open") throw unavailable();
    assertHeldCommitment();
    return inspection;
  };

  const handle = freezeNullRecord({
    inspect() {
      if (state !== "open") throw unavailable();
      return inspection;
    },
    reassert,
    async writeExactlyOnce(writer, writeSignal) {
      if (state !== "open" || typeof writer !== "function") {
        throw unavailable();
      }
      checkSignal(writeSignal);
      state = "writing";
      let outbound: Buffer | undefined;
      try {
        assertHeldCommitment();
        const heldLength = exactChunkLength(heldValue);
        outbound = REFLECT_APPLY(
          BUFFER_ALLOC,
          BUFFER_EXACT,
          [heldLength],
        ) as Buffer;
        if (
          !exactDedicatedBuffer(outbound, heldLength)
        ) throw invalid();
        REFLECT_APPLY(UINT8_ARRAY_SET, outbound, [heldValue]);
        if (
          !REFLECT_APPLY(CRYPTO_TIMING_SAFE_EQUAL, CRYPTO_EXACT, [
            outbound,
            heldValue,
          ])
        ) throw invalid();
        await writer(outbound, writeSignal);
      } catch (error) {
        state = "failed";
        normalizeFailure(error);
      } finally {
        let cleanupExact = true;
        if (outbound !== undefined) {
          try {
            zeroize(outbound);
          } catch {
            cleanupExact = false;
          }
        }
        try {
          destroy();
        } catch {
          cleanupExact = false;
        }
        if (!cleanupExact) {
          state = "failed";
          throw cleanupFailed();
        }
      }
    },
    close() {
      if (state === "closed") return;
      if (state === "writing") throw cleanupFailed();
      destroy();
    },
  } satisfies PermanentStagingProviderVariableWriteInputHandle);
  REFLECT_APPLY(WEAK_SET_ADD, INPUT_HANDLE_AUTHORITIES, [handle]);
  return handle;
}
