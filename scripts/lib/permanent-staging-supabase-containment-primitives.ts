const ARRAY_IS_ARRAY_EXACT = Array.isArray;
const ARRAY_PROTOTYPE_EXACT = Array.prototype;
const BUFFER_BYTE_LENGTH_EXACT = Buffer.byteLength;
const ERROR_EXACT = Error;
const JSON_PARSE_EXACT = JSON.parse;
const JSON_STRINGIFY_EXACT = JSON.stringify;
const NUMBER_IS_FINITE_EXACT = Number.isFinite;
const NUMBER_IS_SAFE_INTEGER_EXACT = Number.isSafeInteger;
const OBJECT_EXACT = Object;
const OBJECT_DEFINE_PROPERTY_EXACT = Object.defineProperty;
const OBJECT_FREEZE_EXACT = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR_EXACT =
  Object.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT =
  Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF_EXACT = Object.getPrototypeOf;
const OBJECT_HAS_OWN_EXACT = Object.hasOwn;
const OBJECT_IS_FROZEN_EXACT = Object.isFrozen;
const OBJECT_PROTOTYPE_EXACT = Object.prototype;
const OBJECT_VALUES_EXACT = Object.values;
const REFLECT_APPLY_EXACT = Reflect.apply;
const REFLECT_OWN_KEYS_EXACT = Reflect.ownKeys;
const REGEXP_EXEC_EXACT = RegExp.prototype.exec;
const SET_EXACT = Set;
const SET_ADD_EXACT = Set.prototype.add;
const SET_SIZE_GETTER_EXACT = Object.getOwnPropertyDescriptor(
  Set.prototype,
  "size",
)?.get;
const STRING_REPLACE_EXACT = String.prototype.replace;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOWERCASE_HEX_PATTERN = /^[0-9a-f]+$/;
const MAXIMUM_SECURITY_ARRAY_LENGTH = 100_000;

interface DenseArraySnapshot<T> {
  readonly length: number;
  readonly descriptors: Record<PropertyKey, PropertyDescriptor>;
}

function denseArraySnapshot<T>(
  value: readonly T[],
  maximumLength: number,
): DenseArraySnapshot<T> | null {
  if (
    !ARRAY_IS_ARRAY_EXACT(value)
    || OBJECT_GET_PROTOTYPE_OF_EXACT(value) !== ARRAY_PROTOTYPE_EXACT
    || !NUMBER_IS_SAFE_INTEGER_EXACT(maximumLength)
    || maximumLength < 0
  ) return null;
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT(value) as
    unknown as Record<PropertyKey, PropertyDescriptor>;
  const ownKeys = REFLECT_OWN_KEYS_EXACT(descriptors);
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined
    || !OBJECT_HAS_OWN_EXACT(lengthDescriptor, "value")
    || !NUMBER_IS_SAFE_INTEGER_EXACT(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximumLength
    || ownKeys.length !== lengthDescriptor.value + 1
    || ownKeys[ownKeys.length - 1] !== "length"
  ) return null;
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || !OBJECT_HAS_OWN_EXACT(descriptor, "value")
      || descriptor.enumerable !== true
      || ownKeys[index] !== String(index)
    ) return null;
  }
  return { length: lengthDescriptor.value, descriptors };
}

function requiredDenseArraySnapshot<T>(
  value: readonly T[],
): DenseArraySnapshot<T> {
  const snapshot = denseArraySnapshot(value, MAXIMUM_SECURITY_ARRAY_LENGTH);
  if (snapshot === null) throw new ERROR_EXACT("dense_array_required");
  return snapshot;
}

function denseSlotValue<T>(
  snapshot: DenseArraySnapshot<T>,
  index: number,
): T {
  return snapshot.descriptors[String(index)]!.value as T;
}

function defineDenseSlot<T>(target: T[], index: number, value: T): void {
  OBJECT_DEFINE_PROPERTY_EXACT(target, String(index), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function verifiedDenseResult<T>(value: T[], expectedLength: number): T[] {
  const snapshot = denseArraySnapshot(value, expectedLength);
  if (snapshot === null || snapshot.length !== expectedLength) {
    throw new ERROR_EXACT("dense_array_result_invalid");
  }
  return value;
}

function canonicalizeJsonValue(
  value: unknown,
  depth: number,
  budget: { remaining: number },
): string | null {
  if (depth > 128 || budget.remaining <= 0) return null;
  budget.remaining -= 1;
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    return JSON_STRINGIFY_EXACT(value) as string;
  }
  if (typeof value === "number") {
    if (!NUMBER_IS_FINITE_EXACT(value)) return null;
    return JSON_STRINGIFY_EXACT(value) as string;
  }
  if (typeof value !== "object") return null;

  const prototype = OBJECT_GET_PROTOTYPE_OF_EXACT(value);
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT(value) as
    unknown as Record<PropertyKey, PropertyDescriptor>;
  const keys = REFLECT_OWN_KEYS_EXACT(descriptors);
  if (ARRAY_IS_ARRAY_EXACT(value)) {
    if (prototype !== ARRAY_PROTOTYPE_EXACT) return null;
    const lengthDescriptor = descriptors.length;
    if (
      lengthDescriptor === undefined
      || !OBJECT_HAS_OWN_EXACT(lengthDescriptor, "value")
      || !NUMBER_IS_SAFE_INTEGER_EXACT(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || keys.length !== lengthDescriptor.value + 1
      || keys[keys.length - 1] !== "length"
    ) return null;
    let result = "[";
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined
        || !OBJECT_HAS_OWN_EXACT(descriptor, "value")
        || descriptor.enumerable !== true
        || keys[index] !== String(index)
      ) return null;
      const encoded = canonicalizeJsonValue(
        descriptor.value,
        depth + 1,
        budget,
      );
      if (encoded === null) return null;
      if (index > 0) result += ",";
      result += encoded;
    }
    return `${result}]`;
  }
  if (prototype !== OBJECT_PROTOTYPE_EXACT && prototype !== null) return null;
  let result = "{";
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") return null;
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !OBJECT_HAS_OWN_EXACT(descriptor, "value")
      || descriptor.enumerable !== true
    ) return null;
    const encoded = canonicalizeJsonValue(
      descriptor.value,
      depth + 1,
      budget,
    );
    if (encoded === null) return null;
    if (index > 0) result += ",";
    result += `${JSON_STRINGIFY_EXACT(key) as string}:${encoded}`;
  }
  return `${result}}`;
}

export function arrayEvery<T, S extends T>(
  values: readonly T[],
  predicate: (value: T, index: number) => value is S,
): values is readonly S[];
export function arrayEvery<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean,
): boolean;
export function arrayEvery<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean,
): boolean {
  const snapshot = requiredDenseArraySnapshot(values);
  for (let index = 0; index < snapshot.length; index += 1) {
    if (!predicate(denseSlotValue(snapshot, index), index)) return false;
  }
  return true;
}

export function arrayFilter<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean,
): T[] {
  const snapshot = requiredDenseArraySnapshot(values);
  const result: T[] = [];
  let resultIndex = 0;
  for (let index = 0; index < snapshot.length; index += 1) {
    const value = denseSlotValue(snapshot, index);
    if (!predicate(value, index)) continue;
    defineDenseSlot(result, resultIndex, value);
    resultIndex += 1;
  }
  return verifiedDenseResult(result, resultIndex);
}

export function arrayFind<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean,
): T | undefined {
  const snapshot = requiredDenseArraySnapshot(values);
  for (let index = 0; index < snapshot.length; index += 1) {
    const value = denseSlotValue(snapshot, index);
    if (predicate(value, index)) return value;
  }
  return undefined;
}

export function arrayIncludes<T>(values: readonly T[], candidate: T): boolean {
  const snapshot = requiredDenseArraySnapshot(values);
  for (let index = 0; index < snapshot.length; index += 1) {
    const value = denseSlotValue(snapshot, index);
    if (value === candidate || (value !== value && candidate !== candidate)) {
      return true;
    }
  }
  return false;
}

export function arrayMap<T, R>(
  values: readonly T[],
  mapper: (value: T, index: number) => R,
): R[] {
  const snapshot = requiredDenseArraySnapshot(values);
  const result: R[] = [];
  for (let index = 0; index < snapshot.length; index += 1) {
    defineDenseSlot(
      result,
      index,
      mapper(denseSlotValue(snapshot, index), index),
    );
  }
  return verifiedDenseResult(result, snapshot.length);
}

export function arraySome<T>(
  values: readonly T[],
  predicate: (value: T, index: number) => boolean,
): boolean {
  const snapshot = requiredDenseArraySnapshot(values);
  for (let index = 0; index < snapshot.length; index += 1) {
    if (predicate(denseSlotValue(snapshot, index), index)) return true;
  }
  return false;
}

export function objectValues<T>(value: object): T[] {
  return REFLECT_APPLY_EXACT(OBJECT_VALUES_EXACT, OBJECT_EXACT, [value]) as T[];
}

export function regexpTest(pattern: RegExp, value: string): boolean {
  return REFLECT_APPLY_EXACT(REGEXP_EXEC_EXACT, pattern, [value]) !== null;
}

export function stringReplace(
  value: string,
  search: string | RegExp,
  replacement: string,
): string {
  return REFLECT_APPLY_EXACT(STRING_REPLACE_EXACT, value, [
    search,
    replacement,
  ]) as string;
}

export function uniqueStrings(values: readonly string[]): boolean {
  if (typeof SET_SIZE_GETTER_EXACT !== "function") return false;
  const seen = new SET_EXACT<string>();
  for (let index = 0; index < values.length; index += 1) {
    REFLECT_APPLY_EXACT(SET_ADD_EXACT, seen, [values[index]!]);
  }
  return REFLECT_APPLY_EXACT(SET_SIZE_GETTER_EXACT, seen, [])
    === values.length;
}

export function freezeExact<T>(value: T): Readonly<T> {
  return OBJECT_FREEZE_EXACT(value);
}

export function isSafeInteger(value: unknown): value is number {
  return NUMBER_IS_SAFE_INTEGER_EXACT(value);
}

export function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || ARRAY_IS_ARRAY_EXACT(value)
  ) return false;
  const prototype = OBJECT_GET_PROTOTYPE_OF_EXACT(value);
  if (prototype !== OBJECT_PROTOTYPE_EXACT && prototype !== null) return false;
  const descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS_EXACT(value) as
    unknown as Record<PropertyKey, PropertyDescriptor>;
  const ownKeys = REFLECT_OWN_KEYS_EXACT(descriptors);
  if (ownKeys.length !== keys.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || ownKeys[index] !== key) return false;
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !OBJECT_HAS_OWN_EXACT(descriptor, "value")
      || descriptor.enumerable !== true
    ) return false;
  }
  return true;
}

export function denseArray(
  value: unknown,
  maximumLength: number,
): value is readonly unknown[] {
  return ARRAY_IS_ARRAY_EXACT(value)
    && denseArraySnapshot(value, maximumLength) !== null;
}

export function parseCanonicalJson(
  source: unknown,
  maximumBytes = 1_048_576,
): unknown | null {
  if (
    typeof source !== "string"
    || BUFFER_BYTE_LENGTH_EXACT(source, "utf8") > maximumBytes
    || source.length < 2
  ) return null;
  try {
    const value = JSON_PARSE_EXACT(source) as unknown;
    const canonical = canonicalizeJsonValue(value, 0, { remaining: 100_000 });
    return canonical === source ? value : null;
  } catch {
    return null;
  }
}

export function deepFreeze<T>(value: T): T {
  if (
    typeof value !== "object"
    || value === null
    || OBJECT_IS_FROZEN_EXACT(value)
  ) return value;
  const keys = REFLECT_OWN_KEYS_EXACT(value);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR_EXACT(
      value,
      keys[index]!,
    );
    if (descriptor && OBJECT_HAS_OWN_EXACT(descriptor, "value")) {
      deepFreeze(descriptor.value);
    }
  }
  return OBJECT_FREEZE_EXACT(value);
}

export function isExactUuid(value: unknown): value is string {
  return typeof value === "string" && regexpTest(UUID_PATTERN, value);
}

export function isLowercaseHex(value: unknown, length: number): value is string {
  return typeof value === "string"
    && value.length === length
    && regexpTest(LOWERCASE_HEX_PATTERN, value);
}

export function canonicalJson(value: unknown): string {
  const canonical = canonicalizeJsonValue(value, 0, { remaining: 100_000 });
  if (canonical === null) throw new ERROR_EXACT("canonical_json_invalid");
  return canonical;
}
