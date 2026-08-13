import crypto from "node:crypto";
import fs from "node:fs";
import { TextEncoder, types as utilTypes } from "node:util";

import { assertLockedSensitiveWorkerBoundary } from
  "./locked-sensitive-worker-boundary.js";

const CRYPTO_RANDOM_BYTES = crypto.randomBytes;
const CRYPTO_OBJECT = crypto;
const DATE_CONSTRUCTOR = Date;
const ERROR_CONSTRUCTOR = Error;
const FS_OBJECT = fs;
const FS_WRITE_SYNC = fs.writeSync;
const FETCH_IMPL = fetch;
const NUMBER_CONSTRUCTOR = Number;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_CONSTRUCTOR = Object;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const REFLECT_APPLY = Reflect.apply;
const TEXT_ENCODER = new TextEncoder();
const TEXT_ENCODER_ENCODE = TextEncoder.prototype.encode;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const UINT8_ARRAY_PROTOTYPE = Uint8Array.prototype;
const UTIL_IS_PROXY = utilTypes.isProxy;
const UTIL_TYPES_OBJECT = utilTypes;

function writeStandardOutputExact(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw new ERROR_CONSTRUCTOR("deployment_attestation_summary_write_failed");
  }
  const bytes = REFLECT_APPLY(TEXT_ENCODER_ENCODE, TEXT_ENCODER, [value]) as unknown;
  if (
    typeof bytes !== "object"
    || bytes === null
    || REFLECT_APPLY(UTIL_IS_PROXY, UTIL_TYPES_OBJECT, [bytes])
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [bytes])
      !== UINT8_ARRAY_PROTOTYPE
    || typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function"
  ) throw new ERROR_CONSTRUCTOR("deployment_attestation_summary_write_failed");
  const byteLength = REFLECT_APPLY(
    TYPED_ARRAY_BYTE_LENGTH_GETTER,
    bytes,
    [],
  ) as unknown;
  if (
    typeof byteLength !== "number"
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [byteLength])
    || byteLength < 1
    || byteLength > 4_096
  ) throw new ERROR_CONSTRUCTOR("deployment_attestation_summary_write_failed");
  let offset = 0;
  while (offset < byteLength) {
    const written = REFLECT_APPLY(FS_WRITE_SYNC, FS_OBJECT, [
      1,
      bytes,
      offset,
      byteLength - offset,
    ]) as unknown;
    if (
      typeof written !== "number"
      || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, NUMBER_CONSTRUCTOR, [written])
      || written <= 0
      || written > byteLength - offset
    ) {
      throw new ERROR_CONSTRUCTOR("deployment_attestation_summary_write_failed");
    }
    offset += written;
  }
}

function assertProductionBoundary(): void {
  assertLockedSensitiveWorkerBoundary("attestor");
}

function lockedFetch(
  input: string | URL | globalThis.Request,
  init?: RequestInit,
): Promise<Response> {
  assertProductionBoundary();
  return REFLECT_APPLY(FETCH_IMPL, undefined, [input, init]) as Promise<Response>;
}

export const RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_RUNTIME = OBJECT_FREEZE({
  assertProductionBoundary,
  environment: process.env as Readonly<Record<string, string | undefined>>,
  fetchImpl: lockedFetch as typeof fetch,
  now: () => new DATE_CONSTRUCTOR(),
  randomBytes: (size: number) => REFLECT_APPLY(
    CRYPTO_RANDOM_BYTES,
    CRYPTO_OBJECT,
    [size],
  ) as Buffer,
  writeOutput: writeStandardOutputExact,
});
