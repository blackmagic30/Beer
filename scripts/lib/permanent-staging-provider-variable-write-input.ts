import crypto from "node:crypto";

import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK,
  type PermanentStagingProviderVariableName,
} from "./permanent-staging-provider-variable-write-railway-contract.js";

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-input/v1" as const;
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
  readonly stdinOnly: true;
  readonly validUtf8: true;
  readonly controlCharactersAbsent: true;
}

export interface PermanentStagingProviderVariableWriteInputSource
  extends AsyncIterable<Uint8Array> {
  readonly isTTY?: boolean;
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

const ARRAY_BUFFER_IS_VIEW = ArrayBuffer.isView;
const BUFFER_ALLOC = Buffer.alloc;
const BUFFER_IS_BUFFER = Buffer.isBuffer;
const BUFFER_WRITE_UINT32_BE = Buffer.prototype.writeUInt32BE;
const CRYPTO_CREATE_HASH = crypto.createHash;
const CRYPTO_TIMING_SAFE_EQUAL = crypto.timingSafeEqual;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const REFLECT_APPLY = Reflect.apply;
const SET_HAS = Set.prototype.has;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;
const NO_FAILURE: NoFailure = OBJECT_FREEZE({ caught: false });
const ALLOWED_VARIABLE_NAMES = new Set<string>(
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_RAILWAY_CONTRACT_LOCK
    .allowedVariableNames,
);
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(Uint8Array.prototype) as
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
  ArrayBuffer.prototype,
  "byteLength",
)?.get;
const ABORT_SIGNAL_PROTOTYPE = AbortSignal.prototype;
const ABORT_SIGNAL_ABORTED_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  ABORT_SIGNAL_PROTOTYPE,
  "aborted",
)?.get;
const HASH_PROBE = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
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
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) {
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
    || !REFLECT_APPLY(BUFFER_IS_BUFFER, Buffer, [value])
    || !REFLECT_APPLY(ARRAY_BUFFER_IS_VIEW, ArrayBuffer, [value])
    || OBJECT_GET_PROTOTYPE_OF(value) !== Buffer.prototype
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
  const output = REFLECT_APPLY(BUFFER_ALLOC, Buffer, [value.length]) as Buffer;
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
  const nameLength = REFLECT_APPLY(BUFFER_ALLOC, Buffer, [4]) as Buffer;
  const valueLength = REFLECT_APPLY(BUFFER_ALLOC, Buffer, [4]) as Buffer;
  REFLECT_APPLY(BUFFER_WRITE_UINT32_BE, nameLength, [exactChunkLength(name)]);
  REFLECT_APPLY(BUFFER_WRITE_UINT32_BE, valueLength, [exactChunkLength(value)]);
  try {
    const hash = REFLECT_APPLY(CRYPTO_CREATE_HASH, crypto, ["sha256"]);
    REFLECT_APPLY(HASH_UPDATE, hash, [domain]);
    REFLECT_APPLY(HASH_UPDATE, hash, [nameLength]);
    REFLECT_APPLY(HASH_UPDATE, hash, [name]);
    REFLECT_APPLY(HASH_UPDATE, hash, [valueLength]);
    REFLECT_APPLY(HASH_UPDATE, hash, [value]);
    const digest = REFLECT_APPLY(HASH_DIGEST, hash, []);
    if (
      !REFLECT_APPLY(BUFFER_IS_BUFFER, Buffer, [digest])
      || !REFLECT_APPLY(ARRAY_BUFFER_IS_VIEW, ArrayBuffer, [digest])
      || OBJECT_GET_PROTOTYPE_OF(digest) !== Buffer.prototype
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
): Promise<Buffer> {
  if (
    typeof source !== "object"
    || source === null
    || source.isTTY === true
    || typeof source[Symbol.asyncIterator] !== "function"
  ) throw invalid();
  checkSignal(signal);

  const chunks: Buffer[] = [];
  let byteLength = 0;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let prior: FailureState = NO_FAILURE;
  let iteratorDone = false;
  try {
    iterator = source[Symbol.asyncIterator]();
    while (true) {
      checkSignal(signal);
      const item = await iterator.next();
      checkSignal(signal);
      const itemDone = item.done;
      checkSignal(signal);
      if (itemDone === true) {
        iteratorDone = true;
        break;
      }
      const chunk = item.value;
      checkSignal(signal);
      if (!REFLECT_APPLY(ARRAY_BUFFER_IS_VIEW, ArrayBuffer, [chunk])) {
        throw invalid();
      }
      let owned: Buffer | undefined;
      let transferred = false;
      try {
        const chunkLength = exactChunkLength(chunk);
        if (chunkLength === 0) throw invalid();
        const nextLength = byteLength + chunkLength;
        if (
          !NUMBER_IS_SAFE_INTEGER(nextLength)
          || nextLength
            > PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_MAXIMUM_VALUE_BYTES
        ) throw invalid();
        try {
          owned = REFLECT_APPLY(BUFFER_ALLOC, Buffer, [chunkLength]) as Buffer;
          if (!exactDedicatedBuffer(owned, chunkLength)) throw invalid();
          REFLECT_APPLY(UINT8_ARRAY_SET, owned, [chunk]);
        } catch (error) {
          if (owned !== undefined) zeroize(owned);
          throw error;
        }
        const chunkIndex = chunks.length;
        OBJECT_DEFINE_PROPERTY(chunks, String(chunkIndex), {
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
          zeroize(chunk);
        } catch {
          cleanupExact = false;
        }
        if (!cleanupExact) throw cleanupFailed();
      }
      // Let cancellation queued by hostile iterator-result getters settle
      // before another source read can retain the owned copy indefinitely.
      await undefined;
      checkSignal(signal);
    }
  } catch (error) {
    prior = capture(error);
  }

  const retainedWipeExact = !prior.caught || zeroizeChunks(chunks);
  if (!iteratorDone && iterator !== undefined) {
    try {
      const returnIterator = iterator.return;
      if (returnIterator !== undefined) {
        await REFLECT_APPLY(returnIterator, iterator, []);
      }
    } catch {
      zeroizeChunks(chunks);
      throw cleanupFailed();
    }
  }
  if (prior.caught) {
    if (!retainedWipeExact || !zeroizeChunks(chunks)) throw cleanupFailed();
    normalizeFailure(prior.error);
  }

  if (byteLength === 0) throw invalid();
  let value: Buffer | undefined;
  try {
    value = REFLECT_APPLY(BUFFER_ALLOC, Buffer, [byteLength]) as Buffer;
    if (!exactDedicatedBuffer(value, byteLength)) throw invalid();
    let offset = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk === undefined) throw invalid();
      REFLECT_APPLY(UINT8_ARRAY_SET, value, [chunk, offset]);
      offset += exactChunkLength(chunk);
    }
    return value;
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
    value = await readBoundedValue(source, signal);
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
    inspection = OBJECT_FREEZE({
      schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_SCHEMA,
      variableName,
      byteLength: exactChunkLength(heldValue),
      commitmentDomain:
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INPUT_COMMITMENT_DOMAIN,
      commitmentSha256: exactLowercaseHex(originalCommitment, 32),
      stdinOnly: true,
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
        || !REFLECT_APPLY(CRYPTO_TIMING_SAFE_EQUAL, crypto, [
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

  const handle = OBJECT_FREEZE({
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
        outbound = REFLECT_APPLY(BUFFER_ALLOC, Buffer, [heldLength]) as Buffer;
        if (
          !exactDedicatedBuffer(outbound, heldLength)
        ) throw invalid();
        REFLECT_APPLY(UINT8_ARRAY_SET, outbound, [heldValue]);
        if (
          !REFLECT_APPLY(CRYPTO_TIMING_SAFE_EQUAL, crypto, [
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
