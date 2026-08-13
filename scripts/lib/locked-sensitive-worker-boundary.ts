import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import nodeProcess from "node:process";
import { fileURLToPath } from "node:url";

import { assertLockedSensitiveWorkerFinalization } from
  "./locked-sensitive-worker-finalizer.js";

export type LockedSensitiveWorkerMode = "attestor" | "planner";

export const LOCKED_SENSITIVE_WORKER_NODE_VERSION = "22.23.2" as const;
export const LOCKED_SENSITIVE_WORKER_TSX_VERSION = "4.23.12" as const;
export const LOCKED_SENSITIVE_WORKER_TSX_LOADER_SHA256 =
  "49fb46730ddeb226ac4fa9fb990d3573ac8f18fa4de02f1bf723c61d715710c2" as const;

const ARRAY_CONSTRUCTOR = Array;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const CRYPTO_HASH = crypto.hash;
const CRYPTO_OBJECT = crypto;
const ERROR_CONSTRUCTOR = Error;
const FS_OBJECT = fs;
const FS_READ_FILE_SYNC = fs.readFileSync;
const JSON_OBJECT = JSON;
const JSON_PARSE = JSON.parse;
const OBJECT_CONSTRUCTOR = Object;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_IS_EXTENSIBLE = Object.isExtensible;
const OBJECT_IS_FROZEN = Object.isFrozen;
const OBJECT_KEYS = Object.keys;
const PATH_OBJECT = path;
const PATH_RESOLVE = path.resolve;
const REAL_GLOBAL = globalThis;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const STRING_INCLUDES = String.prototype.includes;
const STRING_STARTS_WITH = String.prototype.startsWith;
const PRIMORDIAL_MARKER = "__PINTPATH_LOCKED_SENSITIVE_PRIMORDIALS_V1__";
const EXPECTED_PRELOAD_PATH = fileURLToPath(new URL(
  "./locked-sensitive-worker-primordials.mjs",
  import.meta.url,
));
const EXPECTED_TSX_PACKAGE_PATH = fileURLToPath(new URL(
  "../../node_modules/tsx/package.json",
  import.meta.url,
));
const EXPECTED_TSX_PATH = fileURLToPath(new URL(
  "../../node_modules/tsx/dist/loader.mjs",
  import.meta.url,
));
const EXPECTED_WORKER_PATH = fileURLToPath(new URL(
  "../run-locked-sensitive-worker.ts",
  import.meta.url,
));
const EXPECTED_EXEC_ARGV = Object.freeze([
  "--disable-sigusr1",
  "--disable-warning=ExperimentalWarning",
  "--frozen-intrinsics",
  "--import",
  EXPECTED_PRELOAD_PATH,
  "--import",
  EXPECTED_TSX_PATH,
]);
const PINNED_GLOBAL_NAMES = Object.freeze([
  "AbortController", "AbortSignal", "AggregateError", "Array", "ArrayBuffer",
  "Atomics", "BigInt", "BigInt64Array", "BigUint64Array", "Blob", "Boolean",
  "Buffer", "Crypto", "CryptoKey", "CustomEvent", "DataView", "Date",
  "decodeURI", "decodeURIComponent", "DOMException", "encodeURI",
  "encodeURIComponent", "Error", "eval", "EvalError", "Event", "EventTarget",
  "fetch", "FinalizationRegistry", "Float32Array", "Float64Array", "FormData",
  "Function",
  "Headers", "Int8Array", "Int16Array", "Int32Array", "Intl", "isFinite",
  "isNaN", "JSON", "Map", "Math", "MessageEvent", "Navigator", "Number",
  "Object", "parseFloat", "parseInt", "Performance", "PerformanceEntry",
  "PerformanceMark", "PerformanceMeasure", "PerformanceObserver",
  "PerformanceObserverEntryList", "Promise", "RangeError", "ReadableStream",
  "ReadableStreamBYOBReader", "ReadableStreamDefaultReader", "ReferenceError",
  "Proxy", "Reflect", "RegExp", "Request", "Response", "Set", "SharedArrayBuffer",
  "String", "SubtleCrypto", "Symbol", "SyntaxError", "TextDecoder", "TextEncoder",
  "TransformStream", "TypeError", "Uint8Array", "Uint8ClampedArray", "Uint16Array",
  "Uint32Array", "URIError", "URL", "URLSearchParams", "WeakMap", "WeakRef",
  "WeakSet", "WebAssembly", "WritableStream",
]);
const EXPECTED_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  __CF_USER_TEXT_ENCODING: "0x1F5:0:0",
  HOME: "/Users/zac",
  LANG: "C",
  LOGNAME: "zac",
  PATH: "/usr/bin:/bin",
  USER: "zac",
});
const EXPECTED_ENVIRONMENT_NAMES = Object.freeze([
  "__CF_USER_TEXT_ENCODING",
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "USER",
]);

interface PrimordialMarker {
  readonly bigintStatsPrototype: unknown;
  readonly diagnosticChannelPrototype: unknown;
  readonly fileHandlePrototype: unknown;
  readonly hashPrototype: unknown;
  readonly hmacPrototype: unknown;
  readonly navigatorObject: unknown;
  readonly nodeConstructorPrototypes: unknown;
  readonly performanceObject: unknown;
  readonly version: unknown;
  readonly webStreamPrototypes: unknown;
}

function fail(): never {
  throw new ERROR_CONSTRUCTOR("locked_sensitive_worker_boundary_invalid");
}

function ownData(object: object, name: PropertyKey): unknown {
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [object, name],
  ) as PropertyDescriptor | undefined;
  if (!descriptor || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function exactStringArray(
  actual: unknown,
  expected: readonly string[],
): boolean {
  if (
    !REFLECT_APPLY(ARRAY_IS_ARRAY, ARRAY_CONSTRUCTOR, [actual])
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [actual])
      !== ARRAY_PROTOTYPE
    || (actual as readonly unknown[]).length !== expected.length
  ) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if ((actual as readonly unknown[])[index] !== expected[index]) return false;
  }
  return true;
}

function exactPinnedGlobal(name: string): unknown {
  const descriptor = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [REAL_GLOBAL, name],
  ) as PropertyDescriptor | undefined;
  if (
    !descriptor
    || !("value" in descriptor)
    || descriptor.configurable !== false
    || descriptor.writable !== false
  ) return undefined;
  return descriptor.value;
}

function frozenObject(value: unknown): boolean {
  return ((typeof value === "object" && value !== null) || typeof value === "function")
    && REFLECT_APPLY(OBJECT_IS_FROZEN, OBJECT_CONSTRUCTOR, [value]) === true;
}

function lockedShadowablePrototype(value: unknown): boolean {
  if (!frozenObject(value)) return false;
  const prototype = ownData(value as object, "prototype");
  const mutable = ownData(value as object, "mutableNonconfigurable");
  if (
    typeof prototype !== "object"
    || prototype === null
    || !frozenObject(mutable)
    || REFLECT_APPLY(OBJECT_IS_EXTENSIBLE, OBJECT_CONSTRUCTOR, [prototype]) === true
  ) return false;
  const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [prototype]) as PropertyKey[];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const descriptor = REFLECT_APPLY(
      OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
      OBJECT_CONSTRUCTOR,
      [prototype, key],
    ) as PropertyDescriptor | undefined;
    if (!descriptor || descriptor.configurable !== false) return false;
    if ("value" in descriptor && descriptor.writable === true) {
      let found = false;
      const mutableEntries = mutable as readonly unknown[];
      for (let slot = 0; slot < mutableEntries.length; slot += 1) {
        const expected = mutableEntries[slot];
        if (
          frozenObject(expected)
          && ownData(expected as object, "key") === key
          && ownData(expected as object, "value") === descriptor.value
        ) found = true;
      }
      if (!found) return false;
    }
  }
  return true;
}

function exactMarker(value: unknown): value is PrimordialMarker {
  if (!frozenObject(value)) return false;
  const marker = value as PrimordialMarker;
  if (
    marker.version !== 1
    || !frozenObject(marker.bigintStatsPrototype)
    || !frozenObject(marker.diagnosticChannelPrototype)
    || !frozenObject(marker.fileHandlePrototype)
    || !frozenObject(marker.hashPrototype)
    || !frozenObject(marker.hmacPrototype)
    || !frozenObject(marker.navigatorObject)
    || !frozenObject(marker.performanceObject)
    || !frozenObject(marker.nodeConstructorPrototypes)
    || !frozenObject(marker.webStreamPrototypes)
  ) return false;
  const nodePrototypes = marker.nodeConstructorPrototypes as readonly unknown[];
  for (let index = 0; index < nodePrototypes.length; index += 1) {
    if (!lockedShadowablePrototype(nodePrototypes[index])) return false;
  }
  const webPrototypes = marker.webStreamPrototypes as readonly unknown[];
  for (let index = 0; index < webPrototypes.length; index += 1) {
    if (!lockedShadowablePrototype(webPrototypes[index])) return false;
  }
  return true;
}

const markerDescriptor = REFLECT_APPLY(
  OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
  OBJECT_CONSTRUCTOR,
  [REAL_GLOBAL, PRIMORDIAL_MARKER],
) as PropertyDescriptor | undefined;
const INITIAL_MARKER = markerDescriptor && "value" in markerDescriptor
  ? markerDescriptor.value
  : undefined;
const INITIAL_GLOBAL_VALUES: unknown[] = [];
for (let index = 0; index < PINNED_GLOBAL_NAMES.length; index += 1) {
  INITIAL_GLOBAL_VALUES[index] = exactPinnedGlobal(PINNED_GLOBAL_NAMES[index]!);
}
Object.freeze(INITIAL_GLOBAL_VALUES);

function exactProcessEnvironment(): boolean {
  const names = REFLECT_APPLY(
    OBJECT_KEYS,
    OBJECT_CONSTRUCTOR,
    [nodeProcess.env],
  ) as string[];
  if (names.length !== EXPECTED_ENVIRONMENT_NAMES.length) return false;
  for (let index = 0; index < EXPECTED_ENVIRONMENT_NAMES.length; index += 1) {
    const name = EXPECTED_ENVIRONMENT_NAMES[index]!;
    if (nodeProcess.env[name] !== EXPECTED_ENVIRONMENT[name]) return false;
  }
  for (let index = 0; index < names.length; index += 1) {
    let found = false;
    for (let slot = 0; slot < EXPECTED_ENVIRONMENT_NAMES.length; slot += 1) {
      if (names[index] === EXPECTED_ENVIRONMENT_NAMES[slot]) found = true;
    }
    if (!found) return false;
  }
  return true;
}

function exactTsxIdentity(
  version: unknown,
  loaderBytes: Uint8Array,
): boolean {
  try {
    const digest = REFLECT_APPLY(
      CRYPTO_HASH,
      CRYPTO_OBJECT,
      ["sha256", loaderBytes, "hex"],
    ) as unknown;
    return version === LOCKED_SENSITIVE_WORKER_TSX_VERSION
      && digest === LOCKED_SENSITIVE_WORKER_TSX_LOADER_SHA256;
  } catch {
    return false;
  }
}

function exactInstalledTsxIdentity(): boolean {
  try {
    const packageSource = REFLECT_APPLY(
      FS_READ_FILE_SYNC,
      FS_OBJECT,
      [EXPECTED_TSX_PACKAGE_PATH, "utf8"],
    ) as unknown;
    if (typeof packageSource !== "string") return false;
    const packageJson = REFLECT_APPLY(
      JSON_PARSE,
      JSON_OBJECT,
      [packageSource],
    ) as unknown;
    if (
      typeof packageJson !== "object"
      || packageJson === null
      || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, OBJECT_CONSTRUCTOR, [packageJson])
        !== OBJECT_CONSTRUCTOR.prototype
    ) return false;
    const loaderBytes = REFLECT_APPLY(
      FS_READ_FILE_SYNC,
      FS_OBJECT,
      [EXPECTED_TSX_PATH],
    ) as unknown;
    if (!(loaderBytes instanceof Uint8Array)) return false;
    return exactTsxIdentity(
      ownData(packageJson, "version"),
      loaderBytes,
    );
  } catch {
    return false;
  }
}

const globalThisDescriptor = REFLECT_APPLY(
  OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
  OBJECT_CONSTRUCTOR,
  [REAL_GLOBAL, "globalThis"],
) as PropertyDescriptor | undefined;
const LOCKED_AT_MODULE_INITIALIZATION =
  nodeProcess.versions.node === LOCKED_SENSITIVE_WORKER_NODE_VERSION
  && exactStringArray(nodeProcess.execArgv, EXPECTED_EXEC_ARGV)
  && exactInstalledTsxIdentity()
  && REFLECT_APPLY(PATH_RESOLVE, PATH_OBJECT, [nodeProcess.argv[1] ?? ""])
    === EXPECTED_WORKER_PATH
  && exactProcessEnvironment()
  && markerDescriptor !== undefined
  && markerDescriptor.configurable === false
  && "value" in markerDescriptor
  && markerDescriptor.writable === false
  && exactMarker(INITIAL_MARKER)
  && exactPinnedGlobal("process") === nodeProcess
  && exactPinnedGlobal("global") === REAL_GLOBAL
  && globalThisDescriptor !== undefined
  && "value" in globalThisDescriptor
  && globalThisDescriptor.value === REAL_GLOBAL
  && globalThisDescriptor.configurable === false
  && globalThisDescriptor.writable === false;

let activeMode: LockedSensitiveWorkerMode | null = null;

function assertCurrentLocks(): void {
  assertLockedSensitiveWorkerFinalization();
  if (
    !LOCKED_AT_MODULE_INITIALIZATION
    || !exactMarker(INITIAL_MARKER)
    || !exactProcessEnvironment()
  ) fail();
  const currentMarker = REFLECT_APPLY(
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR,
    OBJECT_CONSTRUCTOR,
    [REAL_GLOBAL, PRIMORDIAL_MARKER],
  ) as PropertyDescriptor | undefined;
  if (
    !currentMarker
    || !("value" in currentMarker)
    || currentMarker.value !== INITIAL_MARKER
    || currentMarker.configurable !== false
    || currentMarker.writable !== false
    || exactPinnedGlobal("process") !== nodeProcess
    || exactPinnedGlobal("global") !== REAL_GLOBAL
  ) fail();
  for (let index = 0; index < PINNED_GLOBAL_NAMES.length; index += 1) {
    const value = exactPinnedGlobal(PINNED_GLOBAL_NAMES[index]!);
    if (value === undefined || value !== INITIAL_GLOBAL_VALUES[index]) fail();
  }
  if (
    !frozenObject(String.prototype)
    || !frozenObject(RegExp.prototype)
    || !frozenObject(Array.prototype)
    || (INITIAL_MARKER as PrimordialMarker).navigatorObject !== navigator
    || navigator.userAgent !== "Node.js/22"
  ) fail();
}

export function assertNoSensitiveTokenEnvironment(): void {
  const names = REFLECT_APPLY(OBJECT_KEYS, OBJECT_CONSTRUCTOR, [nodeProcess.env]) as string[];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    if (
      (
        REFLECT_APPLY(STRING_STARTS_WITH, name, ["PINTPATH_"])
        || REFLECT_APPLY(STRING_STARTS_WITH, name, ["RAILWAY_"])
      )
      && REFLECT_APPLY(STRING_INCLUDES, name, ["TOKEN"])
    ) fail();
  }
}

export function activateLockedSensitiveWorkerBoundary(
  mode: LockedSensitiveWorkerMode,
): void {
  if (activeMode !== null || (mode !== "attestor" && mode !== "planner")) fail();
  assertCurrentLocks();
  assertNoSensitiveTokenEnvironment();
  activeMode = mode;
}

export function assertLockedSensitiveWorkerBoundary(
  mode: LockedSensitiveWorkerMode,
): void {
  if (activeMode !== mode) fail();
  assertCurrentLocks();
  assertNoSensitiveTokenEnvironment();
}

export const lockedSensitiveWorkerBoundaryInternals = Object.freeze({
  exactTsxIdentity,
});
