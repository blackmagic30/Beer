import childProcess, * as childProcessNamespace from "node:child_process";
import cluster, * as clusterNamespace from "node:cluster";
import diagnosticsChannel from "node:diagnostics_channel";
import fs, * as fsNamespace from "node:fs";
import Module, {
  syncBuiltinESMExports,
  type Module as NodeModule,
} from "node:module";
import * as moduleNamespace from "node:module";
import net from "node:net";
import tls from "node:tls";
import workerThreads, * as workerThreadsNamespace from "node:worker_threads";

import postgresRuntime from "pg";

const FINAL_MARKER = "__PINTPATH_LOCKED_SENSITIVE_FINALIZED_V1__";
const PRIMORDIAL_MARKER = "__PINTPATH_LOCKED_SENSITIVE_PRIMORDIALS_V1__";
const UNDICI_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

const APPLY = Reflect.apply;
const ARRAY_IS_ARRAY = Array.isArray;
const DIAGNOSTIC_CHANNEL = diagnosticsChannel.channel;
const DIAGNOSTIC_HAS_SUBSCRIBERS = diagnosticsChannel.hasSubscribers;
const DEFINE_PROPERTY = Object.defineProperty;
const FREEZE = Object.freeze;
const GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const IS_FROZEN = Object.isFrozen;
const IS_EXTENSIBLE = Object.isExtensible;
const KEYS = Object.keys;
const OWN_KEYS = Reflect.ownKeys;
const PREVENT_EXTENSIONS = Object.preventExtensions;
const SET_PROTOTYPE_OF = Object.setPrototypeOf;

type CommonJsModule = NodeModule & {
  readonly children: CommonJsModule[];
  readonly exports: unknown;
  readonly filename: string;
};

type ModuleInternals = typeof Module & {
  _cache: Record<string, CommonJsModule>;
  _extensions: Record<string, (...args: unknown[]) => unknown>;
  _findPath: (...args: unknown[]) => unknown;
  _initPaths: (...args: unknown[]) => unknown;
  _load: (request: string, parent: CommonJsModule | null, isMain: boolean) => unknown;
  _nodeModulePaths: (...args: unknown[]) => unknown;
  _preloadModules: (...args: unknown[]) => unknown;
  _resolveFilename: (...args: unknown[]) => unknown;
  _resolveLookupPaths: (...args: unknown[]) => unknown;
  runMain: (...args: unknown[]) => unknown;
};

type ModulePrototype = NodeModule & {
  _compile: (...args: unknown[]) => unknown;
  load: (...args: unknown[]) => unknown;
  require: (request: string) => unknown;
};

const MODULE = Module as ModuleInternals;
const MODULE_PROTOTYPE = Module.prototype as ModulePrototype;
const NATIVE_MODULE_REQUIRE = MODULE_PROTOTYPE.require;
const PRIVATE_MODULE_CACHE = MODULE._cache;
const PG_RUNTIME = postgresRuntime as typeof postgresRuntime & {
  readonly defaults: object;
  readonly types: { readonly setTypeParser?: unknown };
};

const EMPTY_CACHE = FREEZE(Object.create(null) as Record<string, never>);
const EMPTY_EXTENSIONS = FREEZE(Object.create(null) as Record<string, never>);
const HARDENED_VALUES = new WeakSet<object>();
const PG_LAZY_PARENTS = new Map<object, ReadonlySet<string>>();

let finalized = false;
let marker: Readonly<{ readonly version: 1 }> | null = null;
let dispatcherFacade: Readonly<{ dispatch: (...args: unknown[]) => unknown }> | null = null;

function fail(): never {
  throw new Error("locked_sensitive_worker_finalization_invalid");
}

function assertPrimordialMarker(): void {
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(globalThis, PRIMORDIAL_MARKER);
  if (
    !descriptor
    || !("value" in descriptor)
    || !exactObject(descriptor.value)
    || descriptor.configurable !== false
    || descriptor.writable !== false
    || !IS_FROZEN(descriptor.value)
  ) fail();
  const exactMarker = descriptor.value as {
    readonly diagnosticChannels?: unknown;
    readonly diagnosticNames?: unknown;
  };
  if (
    !ARRAY_IS_ARRAY(exactMarker.diagnosticChannels)
    || !ARRAY_IS_ARRAY(exactMarker.diagnosticNames)
    || exactMarker.diagnosticChannels.length !== exactMarker.diagnosticNames.length
    || exactMarker.diagnosticNames.length !== 18
    || !IS_FROZEN(exactMarker.diagnosticChannels)
    || !IS_FROZEN(exactMarker.diagnosticNames)
  ) fail();
  for (let index = 0; index < exactMarker.diagnosticNames.length; index += 1) {
    const name = exactMarker.diagnosticNames[index];
    const channel = exactMarker.diagnosticChannels[index];
    if (
      typeof name !== "string"
      || !exactObject(channel)
      || !IS_FROZEN(channel)
      || IS_EXTENSIBLE(channel)
      || GET_OWN_PROPERTY_DESCRIPTOR(channel, "hasSubscribers") !== undefined
      || GET_OWN_PROPERTY_DESCRIPTOR(channel, "publish") !== undefined
      || APPLY(DIAGNOSTIC_CHANNEL, diagnosticsChannel, [name]) !== channel
      || APPLY(DIAGNOSTIC_HAS_SUBSCRIBERS, diagnosticsChannel, [name]) !== false
    ) fail();
  }
}

function denyCapability(): never {
  throw new Error("locked_sensitive_worker_capability_disabled");
}
FREEZE(denyCapability);

function exactObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function pinData(
  object: object,
  name: PropertyKey,
  value: unknown,
): void {
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(object, name);
  if (!descriptor || !("value" in descriptor) || descriptor.configurable !== true) fail();
  DEFINE_PROPERTY(object, name, {
    configurable: false,
    enumerable: descriptor.enumerable ?? false,
    value,
    writable: false,
  });
}

function denyDataFunction(object: object, name: PropertyKey): void {
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(object, name);
  if (
    !descriptor
    || !("value" in descriptor)
    || typeof descriptor.value !== "function"
    || descriptor.configurable !== true
  ) fail();
  DEFINE_PROPERTY(object, name, {
    configurable: false,
    enumerable: descriptor.enumerable ?? false,
    value: denyCapability,
    writable: false,
  });
}

function revokeCallableOwnProperties(object: object): readonly PropertyKey[] {
  const revoked: PropertyKey[] = [];
  for (const key of OWN_KEYS(object)) {
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(object, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
      continue;
    }
    if (descriptor.configurable !== true) fail();
    DEFINE_PROPERTY(object, key, {
      configurable: false,
      enumerable: descriptor.enumerable ?? false,
      value: denyCapability,
      writable: false,
    });
    revoked.push(key);
  }
  return FREEZE(revoked);
}

function revokeFunctionAccessors(
  object: object,
  names: readonly PropertyKey[],
): readonly PropertyKey[] {
  const revoked: PropertyKey[] = [];
  for (const name of names) {
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(object, name);
    if (
      !descriptor
      || "value" in descriptor
      || typeof descriptor.get !== "function"
      || descriptor.configurable !== true
    ) fail();
    DEFINE_PROPERTY(object, name, {
      configurable: false,
      enumerable: descriptor.enumerable ?? false,
      value: denyCapability,
      writable: false,
    });
    revoked.push(name);
  }
  return FREEZE(revoked);
}

function hardenPrototype(prototype: object): void {
  if (HARDENED_VALUES.has(prototype)) return;
  HARDENED_VALUES.add(prototype);
  for (const key of OWN_KEYS(prototype)) {
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(prototype, key);
    if (!descriptor) fail();
    if ("value" in descriptor) {
      hardenValue(descriptor.value);
      if (descriptor.configurable === true) {
        const captured = descriptor.value;
        const get = function lockedPgPrototypeValue(): unknown { return captured; };
        const set = function definePgInstanceShadow(
          this: object,
          replacement: unknown,
        ): void {
          if (!exactObject(this) || this === prototype) fail();
          DEFINE_PROPERTY(this, key, {
            configurable: true,
            enumerable: descriptor.enumerable ?? false,
            value: replacement,
            writable: true,
          });
        };
        FREEZE(get);
        FREEZE(set);
        DEFINE_PROPERTY(prototype, key, {
          configurable: false,
          enumerable: descriptor.enumerable ?? false,
          get,
          set,
        });
      } else if (descriptor.writable === true) {
        fail();
      }
    } else {
      hardenValue(descriptor.get);
      hardenValue(descriptor.set);
      if (descriptor.configurable === true) {
        DEFINE_PROPERTY(prototype, key, { ...descriptor, configurable: false });
      }
    }
  }
  PREVENT_EXTENSIONS(prototype);
  if (!IS_FROZEN(prototype)) fail();
}

function hardenValue(value: unknown): void {
  if (!exactObject(value) || HARDENED_VALUES.has(value)) return;
  HARDENED_VALUES.add(value);
  const functionPrototype = typeof value === "function"
    ? GET_OWN_PROPERTY_DESCRIPTOR(value, "prototype")
    : undefined;
  if (
    functionPrototype
    && "value" in functionPrototype
    && exactObject(functionPrototype.value)
  ) hardenPrototype(functionPrototype.value);
  for (const key of OWN_KEYS(value)) {
    if (key === "prototype" && functionPrototype) continue;
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(value, key);
    if (!descriptor) fail();
    if ("value" in descriptor) {
      hardenValue(descriptor.value);
    } else {
      hardenValue(descriptor.get);
      hardenValue(descriptor.set);
      if (descriptor.configurable === true && typeof descriptor.set === "function") {
        DEFINE_PROPERTY(value, key, {
          ...descriptor,
          configurable: false,
          set: denyCapability,
        });
      }
    }
  }
  FREEZE(value);
  if (!IS_FROZEN(value)) fail();
}

function collectPgGraph(): readonly CommonJsModule[] {
  const root = Object.values(PRIVATE_MODULE_CACHE).find(
    (candidate) => candidate.exports === postgresRuntime,
  );
  if (!root) fail();
  const result: CommonJsModule[] = [];
  const seen = new Set<CommonJsModule>();
  const pending: CommonJsModule[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    result.push(current);
    for (const child of current.children) pending.push(child);
  }
  return FREEZE(result);
}

function sealPgGraph(): void {
  const graph = collectPgGraph();
  const streamModule = graph.find((entry) => entry.filename.endsWith("/pg/lib/stream.js"));
  const connectionModule = graph.find(
    (entry) => entry.filename.endsWith("/pg/lib/connection.js"),
  );
  if (!streamModule || !connectionModule) fail();
  PG_LAZY_PARENTS.set(streamModule, FREEZE(new Set(["net", "tls"])));
  PG_LAZY_PARENTS.set(connectionModule, FREEZE(new Set(["net"])));
  const setTypeParser = GET_OWN_PROPERTY_DESCRIPTOR(PG_RUNTIME.types, "setTypeParser");
  if (setTypeParser && "value" in setTypeParser && typeof setTypeParser.value === "function") {
    denyDataFunction(PG_RUNTIME.types, "setTypeParser");
  }
  for (const entry of graph) hardenValue(entry.exports);
  FREEZE(PG_LAZY_PARENTS);
}

function lockedModuleLoad(
  request: string,
  parent: CommonJsModule | null,
  isMain: boolean,
): unknown {
  if (typeof request !== "string" || isMain !== false || !parent) fail();
  const allowed = PG_LAZY_PARENTS.get(parent);
  if (!allowed || !allowed.has(request)) fail();
  if (request === "net") return net;
  if (request === "tls") return tls;
  fail();
}
FREEZE(lockedModuleLoad);

function sealModuleLoader(): void {
  pinData(MODULE, "_load", lockedModuleLoad);
  for (const name of [
    "_findPath",
    "_initPaths",
    "_nodeModulePaths",
    "_preloadModules",
    "_resolveFilename",
    "_resolveLookupPaths",
    "createRequire",
    "register",
    "registerHooks",
    "runMain",
  ] as const) denyDataFunction(MODULE, name);
  pinData(MODULE, "_cache", EMPTY_CACHE);
  pinData(MODULE, "_extensions", EMPTY_EXTENSIONS);
  pinData(MODULE_PROTOTYPE, "require", NATIVE_MODULE_REQUIRE);
  denyDataFunction(MODULE_PROTOTYPE, "_compile");
  denyDataFunction(MODULE_PROTOTYPE, "load");
  FREEZE(MODULE_PROTOTYPE);
  FREEZE(MODULE);
}

function installOpaqueDispatcher(): Promise<Response> {
  // Calling fetch installs Undici's native dispatcher synchronously. Keep the
  // Promise pending, replace the public Agent in this same stack, and do not
  // yield until every other capability below has also been revoked.
  const warm = fetch("data:text/plain,pintpath-locked-dispatcher");
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(globalThis, UNDICI_DISPATCHER);
  if (
    !descriptor
    || !("value" in descriptor)
    || !exactObject(descriptor.value)
    || descriptor.configurable !== false
    || descriptor.writable !== true
  ) fail();
  const dispatcher = descriptor.value as { dispatch?: unknown };
  const dispatch = dispatcher.dispatch;
  if (typeof dispatch !== "function") fail();
  const opaqueDispatch = function lockedUndiciDispatch(...args: unknown[]): unknown {
    return APPLY(dispatch, dispatcher, args);
  };
  FREEZE(opaqueDispatch);
  const facade = SET_PROTOTYPE_OF({ dispatch: opaqueDispatch }, null) as {
    dispatch: (...args: unknown[]) => unknown;
  };
  FREEZE(facade);
  DEFINE_PROPERTY(globalThis, UNDICI_DISPATCHER, {
    configurable: false,
    enumerable: descriptor.enumerable ?? false,
    value: facade,
    writable: false,
  });
  dispatcherFacade = facade;
  return warm;
}

function assertNamespaceRevoked(
  namespace: object,
  names: readonly PropertyKey[],
): void {
  for (const name of names) {
    if (typeof name !== "string") continue;
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(namespace, name);
    if (descriptor && (!("value" in descriptor) || descriptor.value !== denyCapability)) fail();
  }
}

function assertFinalState(): void {
  assertPrimordialMarker();
  if (!finalized || !marker || !dispatcherFacade) fail();
  const finalDescriptor = GET_OWN_PROPERTY_DESCRIPTOR(globalThis, FINAL_MARKER);
  const dispatcherDescriptor = GET_OWN_PROPERTY_DESCRIPTOR(globalThis, UNDICI_DISPATCHER);
  if (
    !finalDescriptor
    || !("value" in finalDescriptor)
    || finalDescriptor.value !== marker
    || finalDescriptor.configurable !== false
    || finalDescriptor.writable !== false
    || !dispatcherDescriptor
    || !("value" in dispatcherDescriptor)
    || dispatcherDescriptor.value !== dispatcherFacade
    || dispatcherDescriptor.configurable !== false
    || dispatcherDescriptor.writable !== false
    || GET_PROTOTYPE_OF(dispatcherFacade) !== null
    || !IS_FROZEN(dispatcherFacade)
    || KEYS(dispatcherFacade).length !== 1
    || MODULE._load !== lockedModuleLoad
    || MODULE._cache !== EMPTY_CACHE
    || MODULE._extensions !== EMPTY_EXTENSIONS
    || MODULE_PROTOTYPE.require !== NATIVE_MODULE_REQUIRE
    || MODULE_PROTOTYPE._compile !== denyCapability
    || MODULE_PROTOTYPE.load !== denyCapability
    || !IS_FROZEN(fs)
    || !IS_FROZEN(fs.promises)
    || fs.readFileSync !== denyCapability
    || fs.promises.readFile !== denyCapability
    || (fs.ReadStream as unknown) !== denyCapability
    || !IS_FROZEN(childProcess)
    || childProcess.spawnSync !== denyCapability
    || !IS_FROZEN(workerThreads)
    || (workerThreads.Worker as unknown) !== denyCapability
    || !IS_FROZEN(cluster)
    || cluster.fork !== denyCapability
    || !IS_FROZEN(PG_RUNTIME)
    || !IS_FROZEN(PG_RUNTIME.Client)
    || !IS_FROZEN(PG_RUNTIME.Client.prototype)
  ) fail();
}

export async function finalizeLockedSensitiveWorkerCapabilities(): Promise<void> {
  if (finalized || marker !== null || dispatcherFacade !== null) fail();
  assertPrimordialMarker();
  const warmDispatcherProbe = installOpaqueDispatcher();
  sealPgGraph();
  sealModuleLoader();

  const fsPromiseNames = revokeCallableOwnProperties(fs.promises);
  FREEZE(fs.promises);
  const fsNames = FREEZE([
    ...revokeCallableOwnProperties(fs),
    ...revokeFunctionAccessors(fs, [
      "FileReadStream",
      "FileWriteStream",
      "ReadStream",
      "WriteStream",
    ]),
  ]);
  const childNames = revokeCallableOwnProperties(childProcess);
  const workerNames = revokeCallableOwnProperties(workerThreads);
  const clusterNames = revokeCallableOwnProperties(cluster);

  FREEZE(fs);
  FREEZE(childProcess);
  FREEZE(workerThreads);
  FREEZE(cluster);

  APPLY(syncBuiltinESMExports, undefined, []);
  assertNamespaceRevoked(fsNamespace, fsNames);
  assertNamespaceRevoked(childProcessNamespace, childNames);
  assertNamespaceRevoked(workerThreadsNamespace, workerNames);
  assertNamespaceRevoked(clusterNamespace, clusterNames);
  const exactModuleNamespace = moduleNamespace as unknown as Record<string, unknown>;
  if (
    exactModuleNamespace._load !== lockedModuleLoad
    || exactModuleNamespace._cache !== EMPTY_CACHE
    || exactModuleNamespace._extensions !== EMPTY_EXTENSIONS
    || exactModuleNamespace.createRequire !== denyCapability
    || exactModuleNamespace.register !== denyCapability
    || exactModuleNamespace.registerHooks !== denyCapability
  ) fail();
  if (fsPromiseNames.length < 1 || fsNames.length < 1 || childNames.length < 1) fail();

  marker = FREEZE({ version: 1 as const });
  DEFINE_PROPERTY(globalThis, FINAL_MARKER, {
    configurable: false,
    enumerable: false,
    value: marker,
    writable: false,
  });
  finalized = true;
  const warmResponse = await warmDispatcherProbe;
  if (
    !warmResponse.ok
    || await warmResponse.text() !== "pintpath-locked-dispatcher"
  ) fail();
  assertFinalState();
}

export function assertLockedSensitiveWorkerFinalization(): void {
  assertFinalState();
}
