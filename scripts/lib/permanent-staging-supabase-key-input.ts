import { timingSafeEqual } from "node:crypto";

import {
  deepFreeze,
  exactDataRecord,
  freezeExact,
} from "./permanent-staging-supabase-containment-primitives.js";

export const PERMANENT_STAGING_SUPABASE_KEY_INPUT_SCHEMA =
  "pintpath-permanent-staging-supabase-two-key-input/v1" as const;
export const PERMANENT_STAGING_SUPABASE_KEY_MAXIMUM_BYTES = 256 as const;

export const PERMANENT_STAGING_SUPABASE_KEY_NAMES = freezeExact([
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const);

export type PermanentStagingSupabaseKeyName =
  typeof PERMANENT_STAGING_SUPABASE_KEY_NAMES[number];

export interface PermanentStagingSupabaseKeyBuffers {
  readonly SUPABASE_ANON_KEY: Buffer;
  readonly SUPABASE_SERVICE_ROLE_KEY: Buffer;
}

export interface PermanentStagingSupabaseKeyInputInspection {
  readonly schemaVersion: typeof PERMANENT_STAGING_SUPABASE_KEY_INPUT_SCHEMA;
  readonly keyNames: typeof PERMANENT_STAGING_SUPABASE_KEY_NAMES;
  readonly formatsExact: true;
  readonly keysDistinct: true;
  readonly bounded: true;
  readonly secretMaterialPublished: false;
  readonly secretDerivedCommitmentsPublished: false;
}

export interface PermanentStagingSupabaseKeyCustody {
  inspect(): PermanentStagingSupabaseKeyInputInspection;
  useExactlyOnce<T>(
    writer: (
      keys: Readonly<PermanentStagingSupabaseKeyBuffers>,
      signal: AbortSignal,
    ) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
  close(): void;
}

export type PermanentStagingSupabaseKeyInputErrorCode =
  | "key_input_invalid"
  | "key_input_unavailable";

const OBJECT_DEFINE_PROPERTY_EXACT = Object.defineProperty;

export class PermanentStagingSupabaseKeyInputError extends Error {
  readonly code!: PermanentStagingSupabaseKeyInputErrorCode;

  constructor(code: PermanentStagingSupabaseKeyInputErrorCode) {
    super(code);
    OBJECT_DEFINE_PROPERTY_EXACT(this, "name", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: "PermanentStagingSupabaseKeyInputError",
    });
    OBJECT_DEFINE_PROPERTY_EXACT(this, "message", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: code,
    });
    OBJECT_DEFINE_PROPERTY_EXACT(this, "code", {
      configurable: false,
      enumerable: true,
      writable: false,
      value: code,
    });
  }
}

const ABORT_SIGNAL_PROTOTYPE_EXACT = AbortSignal.prototype;
const ABORTED_GETTER_EXACT = Object.getOwnPropertyDescriptor(
  ABORT_SIGNAL_PROTOTYPE_EXACT,
  "aborted",
)?.get;
const ADD_EVENT_LISTENER_EXACT = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER_EXACT = EventTarget.prototype.removeEventListener;
const BUFFER_FROM_EXACT = Buffer.from;
const BUFFER_IS_BUFFER_EXACT = Buffer.isBuffer;
const BUFFER_PROTOTYPE_EXACT = Buffer.prototype;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT =
  Object.getOwnPropertyDescriptors;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR_EXACT =
  Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF_EXACT = Object.getPrototypeOf;
const OBJECT_HAS_OWN_EXACT = Object.hasOwn;
const PROMISE_EXACT = Promise;
const PROMISE_RESOLVE_EXACT = Promise.resolve;
const PROMISE_THEN_EXACT = Promise.prototype.then;
const REFLECT_APPLY_EXACT = Reflect.apply;
const REFLECT_OWN_KEYS_EXACT = Reflect.ownKeys;
const TIMING_SAFE_EQUAL_EXACT = timingSafeEqual;
const UINT8_ARRAY_FILL_EXACT = Uint8Array.prototype.fill;
const TYPED_ARRAY_PROTOTYPE_EXACT = OBJECT_GET_PROTOTYPE_OF_EXACT(
  Uint8Array.prototype,
);
const TYPED_ARRAY_BYTE_LENGTH_GETTER_EXACT =
  OBJECT_GET_OWN_PROPERTY_DESCRIPTOR_EXACT(
    TYPED_ARRAY_PROTOTYPE_EXACT,
    "byteLength",
  )?.get;
const WEAK_SET_EXACT = WeakSet;
const WEAK_SET_ADD_EXACT = WeakSet.prototype.add;
const WEAK_SET_HAS_EXACT = WeakSet.prototype.has;
const AUTHORITY = new WEAK_SET_EXACT<object>();
const PUBLISHABLE_PREFIX = BUFFER_FROM_EXACT("sb_publishable_", "ascii");
const SECRET_PREFIX = BUFFER_FROM_EXACT("sb_secret_", "ascii");
const INSPECTION = deepFreeze({
  schemaVersion: PERMANENT_STAGING_SUPABASE_KEY_INPUT_SCHEMA,
  keyNames: PERMANENT_STAGING_SUPABASE_KEY_NAMES,
  formatsExact: true,
  keysDistinct: true,
  bounded: true,
  secretMaterialPublished: false,
  secretDerivedCommitmentsPublished: false,
} as const);

function bufferLength(value: Buffer): number {
  if (typeof TYPED_ARRAY_BYTE_LENGTH_GETTER_EXACT !== "function") return -1;
  return REFLECT_APPLY_EXACT(
    TYPED_ARRAY_BYTE_LENGTH_GETTER_EXACT,
    value,
    [],
  ) as number;
}

function signalAborted(signal: AbortSignal): boolean {
  if (
    typeof ABORTED_GETTER_EXACT !== "function"
    || OBJECT_GET_PROTOTYPE_OF_EXACT(signal) !== ABORT_SIGNAL_PROTOTYPE_EXACT
  ) return true;
  return REFLECT_APPLY_EXACT(ABORTED_GETTER_EXACT, signal, []) === true;
}

export function isExactPermanentStagingSupabaseAbortSignal(
  value: unknown,
): value is AbortSignal {
  return typeof value === "object"
    && value !== null
    && typeof ABORTED_GETTER_EXACT === "function"
    && OBJECT_GET_PROTOTYPE_OF_EXACT(value) === ABORT_SIGNAL_PROTOTYPE_EXACT;
}

export function isPermanentStagingSupabaseSignalAborted(
  value: AbortSignal,
): boolean {
  return !isExactPermanentStagingSupabaseAbortSignal(value)
    || signalAborted(value);
}

function wipe(value: Buffer | null): void {
  if (value === null) return;
  try {
    REFLECT_APPLY_EXACT(UINT8_ARRAY_FILL_EXACT, value, [0]);
  } catch {
    // A detached view is already unavailable; all ordinary paths are wiped.
  }
}

function wipeKeys(values: PermanentStagingSupabaseKeyBuffers): void {
  wipe(values.SUPABASE_ANON_KEY);
  wipe(values.SUPABASE_SERVICE_ROLE_KEY);
}

function wipeOwnBuffers(input: unknown): void {
  if (typeof input !== "object" || input === null) return;
  try {
    const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT(input) as
      Record<PropertyKey, PropertyDescriptor>;
    const keys = REFLECT_OWN_KEYS_EXACT(descriptors);
    for (let index = 0; index < keys.length; index += 1) {
      const descriptor = descriptors[keys[index]!];
      if (
        descriptor
        && OBJECT_HAS_OWN_EXACT(descriptor, "value")
        && BUFFER_IS_BUFFER_EXACT(descriptor.value)
      ) wipe(descriptor.value as Buffer);
    }
  } catch {
    // Never fall back to property reads that could invoke an accessor.
  }
}

function byteAt(value: Buffer, index: number): number {
  return value[index] ?? -1;
}

function hasExactKeyShape(value: Buffer, prefix: Buffer): boolean {
  const valueLength = bufferLength(value);
  const prefixLength = bufferLength(prefix);
  const suffixLength = valueLength - prefixLength;
  if (
    valueLength < 1
    || valueLength > PERMANENT_STAGING_SUPABASE_KEY_MAXIMUM_BYTES
    || prefixLength < 1
    || suffixLength < 20
    || suffixLength > 220
  ) return false;
  for (let index = 0; index < prefixLength; index += 1) {
    if (byteAt(value, index) !== byteAt(prefix, index)) return false;
  }
  for (let index = prefixLength; index < valueLength; index += 1) {
    const byte = byteAt(value, index);
    const allowed = (byte >= 0x30 && byte <= 0x39)
      || (byte >= 0x41 && byte <= 0x5a)
      || byte === 0x5f
      || (byte >= 0x61 && byte <= 0x7a)
      || byte === 0x2d;
    if (!allowed) return false;
  }
  return true;
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  const leftLength = bufferLength(left);
  const rightLength = bufferLength(right);
  return leftLength >= 0
    && leftLength === rightLength
    && TIMING_SAFE_EQUAL_EXACT(left, right);
}

function invalid(): PermanentStagingSupabaseKeyInputError {
  return new PermanentStagingSupabaseKeyInputError("key_input_invalid");
}

function unavailable(): PermanentStagingSupabaseKeyInputError {
  return new PermanentStagingSupabaseKeyInputError("key_input_unavailable");
}

function rejectedUnavailable<T>(): Promise<T> {
  return new PROMISE_EXACT<T>((_resolve, reject) => reject(unavailable()));
}

function runAbortableWriter<T>(input: {
  readonly writer: (
    keys: Readonly<PermanentStagingSupabaseKeyBuffers>,
    signal: AbortSignal,
  ) => Promise<T>;
  readonly publication: Readonly<PermanentStagingSupabaseKeyBuffers>;
  readonly signal: AbortSignal;
  readonly close: () => void;
}): Promise<T> {
  return new PROMISE_EXACT<T>((resolve, reject) => {
    let finished = false;
    let listenerAttached = false;
    const removeListener = (): void => {
      if (!listenerAttached) return;
      listenerAttached = false;
      try {
        REFLECT_APPLY_EXACT(REMOVE_EVENT_LISTENER_EXACT, input.signal, [
          "abort",
          onAbort,
          false,
        ]);
      } catch {
        // Removal failure cannot restore access to already-zeroized buffers.
      }
    };
    const settle = (
      mode: "resolve" | "reject",
      value: T | unknown,
    ): void => {
      if (finished) return;
      finished = true;
      removeListener();
      input.close();
      if (mode === "resolve") resolve(value as T);
      else reject(value);
    };
    function onAbort(): void {
      settle("reject", unavailable());
    }

    try {
      REFLECT_APPLY_EXACT(ADD_EVENT_LISTENER_EXACT, input.signal, [
        "abort",
        onAbort,
        false,
      ]);
      listenerAttached = true;
    } catch {
      input.close();
      reject(unavailable());
      return;
    }
    if (signalAborted(input.signal)) {
      onAbort();
      return;
    }

    let writerResult: Promise<T>;
    try {
      writerResult = input.writer(input.publication, input.signal);
    } catch (error) {
      settle("reject", error);
      return;
    }

    let normalized: Promise<T>;
    try {
      normalized = REFLECT_APPLY_EXACT(
        PROMISE_RESOLVE_EXACT,
        PROMISE_EXACT,
        [writerResult],
      ) as Promise<T>;
      REFLECT_APPLY_EXACT(PROMISE_THEN_EXACT, normalized, [
        (value: T) => settle("resolve", value),
        (error: unknown) => settle("reject", error),
      ]);
    } catch (error) {
      settle("reject", error);
      return;
    }
    if (signalAborted(input.signal)) onAbort();
  });
}

export function isPermanentStagingSupabaseKeyCustody(
  value: unknown,
): value is PermanentStagingSupabaseKeyCustody {
  return typeof value === "object"
    && value !== null
    && REFLECT_APPLY_EXACT(WEAK_SET_HAS_EXACT, AUTHORITY, [value]) === true;
}

export function createPermanentStagingSupabaseKeyCustody(
  input: unknown,
): PermanentStagingSupabaseKeyCustody {
  let anonCopy: Buffer | null = null;
  let serviceCopy: Buffer | null = null;
  try {
    if (!exactDataRecord(input, PERMANENT_STAGING_SUPABASE_KEY_NAMES)) {
      throw invalid();
    }
    const anon = input.SUPABASE_ANON_KEY;
    const service = input.SUPABASE_SERVICE_ROLE_KEY;
    const candidates = [anon, service];
    for (let index = 0; index < candidates.length; index += 1) {
      const value = candidates[index];
      if (
        !BUFFER_IS_BUFFER_EXACT(value)
        || OBJECT_GET_PROTOTYPE_OF_EXACT(value) !== BUFFER_PROTOTYPE_EXACT
      ) throw invalid();
      const length = bufferLength(value as Buffer);
      if (
        length < 1
        || length > PERMANENT_STAGING_SUPABASE_KEY_MAXIMUM_BYTES
      ) throw invalid();
    }
    anonCopy = BUFFER_FROM_EXACT(anon as Buffer);
    serviceCopy = BUFFER_FROM_EXACT(service as Buffer);
  } catch {
    wipeOwnBuffers(input);
    wipe(anonCopy);
    wipe(serviceCopy);
    throw invalid();
  }
  wipeOwnBuffers(input);

  const held: PermanentStagingSupabaseKeyBuffers = {
    SUPABASE_ANON_KEY: anonCopy,
    SUPABASE_SERVICE_ROLE_KEY: serviceCopy,
  };
  if (
    !hasExactKeyShape(held.SUPABASE_ANON_KEY, PUBLISHABLE_PREFIX)
    || !hasExactKeyShape(held.SUPABASE_SERVICE_ROLE_KEY, SECRET_PREFIX)
    || sameBytes(held.SUPABASE_ANON_KEY, held.SUPABASE_SERVICE_ROLE_KEY)
  ) {
    wipeKeys(held);
    throw invalid();
  }

  let state: "open" | "using" | "closed" = "open";
  const close = (): void => {
    if (state === "closed") return;
    state = "closed";
    wipeKeys(held);
  };
  const custody: PermanentStagingSupabaseKeyCustody = {
    inspect() {
      if (state !== "open") throw unavailable();
      return INSPECTION;
    },
    useExactlyOnce<T>(writer: (
      keys: Readonly<PermanentStagingSupabaseKeyBuffers>,
      signal: AbortSignal,
    ) => Promise<T>, signal: AbortSignal): Promise<T> {
      if (
        state !== "open"
        || typeof writer !== "function"
        || !isExactPermanentStagingSupabaseAbortSignal(signal)
        || signalAborted(signal)
      ) {
        close();
        return rejectedUnavailable<T>();
      }
      state = "using";
      const publication = freezeExact({
        SUPABASE_ANON_KEY: held.SUPABASE_ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: held.SUPABASE_SERVICE_ROLE_KEY,
      });
      return runAbortableWriter({ writer, publication, signal, close });
    },
    close,
  };
  REFLECT_APPLY_EXACT(WEAK_SET_ADD_EXACT, AUTHORITY, [custody]);
  return freezeExact(custody);
}
