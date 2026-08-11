import asyncHooks, * as asyncHooksNamespace from "node:async_hooks";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import diagnosticsChannel from "node:diagnostics_channel";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import events from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import inspector, * as inspectorNamespace from "node:inspector";
import inspectorPromises, * as inspectorPromisesNamespace from "node:inspector/promises";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import processObject, * as processNamespace from "node:process";
import stream from "node:stream";
import tls from "node:tls";
import util from "node:util";
import { fileURLToPath } from "node:url";
import v8, * as v8Namespace from "node:v8";
import wasi, * as wasiNamespace from "node:wasi";

const APPLY = Reflect.apply;
const DEFINE_PROPERTY = Object.defineProperty;
const FREEZE = Object.freeze;
const GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const IS_EXTENSIBLE = Object.isExtensible;
const IS_FROZEN = Object.isFrozen;
const OWN_KEYS = Reflect.ownKeys;
const PREVENT_EXTENSIONS = Object.preventExtensions;
const MARKER = "__PINTPATH_LOCKED_SENSITIVE_PRIMORDIALS_V1__";

// Materialize stdio's own shadow methods before inherited stream prototypes
// become non-writable. Node initializes these lazily.
const standardOutput = processObject.stdout;
const standardError = processObject.stderr;
if (standardOutput?.fd !== 1 || standardError?.fd !== 2) {
  throw new Error("locked_sensitive_worker_stdio_invalid");
}

function fail() {
  throw new Error("locked_sensitive_worker_primordial_invalid");
}

function exactObject(value) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") fail();
  return value;
}

function freezeExact(value) {
  exactObject(value);
  FREEZE(value);
  if (!IS_FROZEN(value)) fail();
  return value;
}

function freezeConstructor(value) {
  if (typeof value !== "function") fail();
  if (value.prototype !== undefined) freezeExact(value.prototype);
  freezeExact(value);
  return value;
}

// Core transports create per-instance and derived-prototype shadows with plain
// assignment. A frozen data property would break that. These accessors keep the
// shared prototype immutable while allowing an own receiver slot to be created.
function lockShadowableConstructor(value) {
  if (typeof value !== "function" || typeof value.prototype !== "object") fail();
  const prototype = value.prototype;
  const keys = OWN_KEYS(prototype);
  const mutableNonconfigurable = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(prototype, key);
    if (!descriptor) fail();
    if ("value" in descriptor) {
      if (descriptor.configurable === false) {
        if (descriptor.writable === true) {
          mutableNonconfigurable[mutableNonconfigurable.length] = freezeExact({
            key,
            value: descriptor.value,
          });
        }
        continue;
      }
      const captured = descriptor.value;
      const get = function lockedPrototypeValue() { return captured; };
      const set = function defineReceiverShadow(replacement) {
        if (this === prototype || (typeof this !== "object" && typeof this !== "function")
          || this === null) fail();
        DEFINE_PROPERTY(this, key, {
          configurable: true,
          enumerable: descriptor.enumerable,
          value: replacement,
          writable: true,
        });
      };
      freezeExact(get);
      freezeExact(set);
      DEFINE_PROPERTY(prototype, key, {
        configurable: false,
        enumerable: descriptor.enumerable,
        get,
        set,
      });
    } else {
      if (descriptor.configurable === true) {
        DEFINE_PROPERTY(prototype, key, { ...descriptor, configurable: false });
      }
    }
  }
  freezeExact(mutableNonconfigurable);
  PREVENT_EXTENSIONS(prototype);
  if (IS_EXTENSIBLE(prototype)) fail();
  if (mutableNonconfigurable.length === 0) freezeExact(prototype);
  freezeExact(value);
  return freezeExact({ mutableNonconfigurable, prototype });
}

function pinGlobal(name) {
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(globalThis, name);
  if (!descriptor || descriptor.configurable !== true) fail();
  const value = "value" in descriptor
    ? descriptor.value
    : typeof descriptor.get === "function"
      ? APPLY(descriptor.get, globalThis, [])
      : undefined;
  if (value === undefined) fail();
  DEFINE_PROPERTY(globalThis, name, {
    configurable: false,
    enumerable: descriptor.enumerable,
    value,
    writable: false,
  });
  return value;
}

function pinOwnData(object, name, expected) {
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(object, name);
  if (!descriptor || !("value" in descriptor) || descriptor.value !== expected) fail();
  DEFINE_PROPERTY(object, name, {
    configurable: false,
    enumerable: descriptor.enumerable,
    value: expected,
    writable: false,
  });
}

const ecmaGlobals = [
  "AggregateError", "Array", "ArrayBuffer", "Atomics", "BigInt",
  "BigInt64Array", "BigUint64Array", "Boolean", "DataView", "Date",
  "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent",
  "Error", "eval", "EvalError", "FinalizationRegistry", "Float32Array",
  "Float64Array", "Int8Array", "Int16Array", "Int32Array", "Intl",
  "isFinite", "isNaN", "JSON", "Map", "Math", "Number", "Object",
  "parseFloat", "parseInt", "Promise", "RangeError", "ReferenceError",
  "Reflect", "RegExp", "Set", "SharedArrayBuffer", "String", "Symbol",
  "SyntaxError", "TypeError", "Uint8Array", "Uint8ClampedArray",
  "Uint16Array", "Uint32Array", "URIError", "WeakMap", "WeakRef", "WeakSet",
  "Function", "Proxy", "WebAssembly",
];
for (let index = 0; index < ecmaGlobals.length; index += 1) pinGlobal(ecmaGlobals[index]);

const webConstructors = [
  "AbortController", "AbortSignal", "Blob", "Buffer", "Crypto", "CryptoKey",
  "CustomEvent", "DOMException", "Event", "EventTarget", "FormData", "Headers",
  "MessageEvent", "Navigator", "Performance", "PerformanceEntry", "PerformanceMark",
  "PerformanceMeasure", "PerformanceObserver", "PerformanceObserverEntryList",
  "Request", "Response", "SubtleCrypto", "TextDecoder", "TextEncoder", "URL",
  "URLSearchParams",
];
for (let index = 0; index < webConstructors.length; index += 1) {
  freezeConstructor(pinGlobal(webConstructors[index]));
}

const webStreamNames = [
  "ReadableStream", "ReadableStreamBYOBReader", "ReadableStreamDefaultReader",
  "TransformStream", "WritableStream",
];
const webStreamPrototypes = [];
for (let index = 0; index < webStreamNames.length; index += 1) {
  webStreamPrototypes[index] = lockShadowableConstructor(pinGlobal(webStreamNames[index]));
}
freezeExact(webStreamPrototypes);

const globalFunctions = [
  "clearImmediate", "clearInterval", "clearTimeout", "fetch", "queueMicrotask",
  "setImmediate", "setInterval", "setTimeout", "structuredClone",
];
for (let index = 0; index < globalFunctions.length; index += 1) {
  freezeExact(pinGlobal(globalFunctions[index]));
}

function denyProcessSensitiveCapability() {
  throw new Error("locked_sensitive_worker_process_capability_disabled");
}
freezeExact(denyProcessSensitiveCapability);
const deniedProcessCapabilityNames = freezeExact([
  "_getActiveHandles",
  "_getActiveRequests",
  "_debugEnd",
  "_debugProcess",
  "_linkedBinding",
  "binding",
  "dlopen",
  "execve",
  "loadEnvFile",
]);
for (let index = 0; index < deniedProcessCapabilityNames.length; index += 1) {
  const name = deniedProcessCapabilityNames[index];
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(processObject, name);
  if (
    !descriptor
    || !("value" in descriptor)
    || typeof descriptor.value !== "function"
    || descriptor.configurable !== true
  ) fail();
  DEFINE_PROPERTY(processObject, name, {
    configurable: false,
    enumerable: descriptor.enumerable,
    value: denyProcessSensitiveCapability,
    writable: false,
  });
}

const pinnedProcess = pinGlobal("process");
if (pinnedProcess !== processObject) fail();
const pinnedGlobalAlias = pinGlobal("global");
if (pinnedGlobalAlias !== globalThis) fail();
const globalThisDescriptor = GET_OWN_PROPERTY_DESCRIPTOR(globalThis, "globalThis");
if (
  !globalThisDescriptor
  || !("value" in globalThisDescriptor)
  || globalThisDescriptor.value !== globalThis
  || globalThisDescriptor.configurable !== false
  || globalThisDescriptor.writable !== false
) fail();
freezeExact(globalThis.WebAssembly);
pinOwnData(processObject, "env", processObject.env);
pinOwnData(processObject, "argv", processObject.argv);
pinOwnData(processObject, "execArgv", processObject.execArgv);
pinOwnData(processObject, "versions", processObject.versions);
freezeExact(processObject.argv);
freezeExact(processObject.execArgv);
freezeExact(processObject.versions);

const navigatorObject = pinGlobal("navigator");
if (navigatorObject.userAgent !== "Node.js/22") fail();
freezeExact(GET_PROTOTYPE_OF(navigatorObject));
freezeExact(navigatorObject);

const performanceObject = pinGlobal("performance");
freezeExact(GET_PROTOTYPE_OF(performanceObject));
freezeExact(performanceObject);

const globalCrypto = pinGlobal("crypto");
freezeExact(globalCrypto.subtle);
freezeExact(GET_PROTOTYPE_OF(globalCrypto.subtle));
freezeExact(globalCrypto);

const hash = APPLY(crypto.createHash, crypto, ["sha256"]);
const hashPrototype = GET_PROTOTYPE_OF(hash);
APPLY(hash.digest, hash, []);
freezeExact(hashPrototype);
const hmac = APPLY(crypto.createHmac, crypto, ["sha256", "locked-worker-probe"]);
const hmacPrototype = GET_PROTOTYPE_OF(hmac);
APPLY(hmac.digest, hmac, []);
freezeExact(hmacPrototype);
freezeConstructor(crypto.X509Certificate);

function denyAsyncHookCreation() {
  throw new Error("locked_sensitive_worker_async_hooks_disabled");
}
freezeExact(denyAsyncHookCreation);
DEFINE_PROPERTY(asyncHooks, "createHook", {
  configurable: false,
  enumerable: true,
  value: denyAsyncHookCreation,
  writable: false,
});

function denyInspectorCapability() {
  throw new Error("locked_sensitive_worker_inspector_disabled");
}
freezeExact(denyInspectorCapability);

function denyCallableOwnProperties(object) {
  exactObject(object);
  const keys = OWN_KEYS(object);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(object, key);
    if (!descriptor) fail();
    if (!("value" in descriptor) || typeof descriptor.value !== "function") continue;
    if (descriptor.configurable !== true) fail();
    DEFINE_PROPERTY(object, key, {
      configurable: false,
      enumerable: descriptor.enumerable,
      value: denyInspectorCapability,
      writable: false,
    });
  }
  freezeExact(object);
}

const inspectorSessionConstructors = [inspector.Session, inspectorPromises.Session];
for (let index = 0; index < inspectorSessionConstructors.length; index += 1) {
  const constructor = inspectorSessionConstructors[index];
  if (typeof constructor !== "function" || typeof constructor.prototype !== "object") fail();
  denyCallableOwnProperties(constructor.prototype);
  freezeExact(constructor);
}
freezeExact(inspectorSessionConstructors);
if (
  inspector.console !== inspectorPromises.console
  || inspector.Network !== inspectorPromises.Network
  || inspector.NetworkResources !== inspectorPromises.NetworkResources
) fail();
const inspectorCallableObjects = [
  inspector.console,
  inspector.Network,
  inspector.NetworkResources,
];
for (let index = 0; index < inspectorCallableObjects.length; index += 1) {
  denyCallableOwnProperties(inspectorCallableObjects[index]);
}
freezeExact(inspectorCallableObjects);

const deniedInspectorExportNames = freezeExact([
  "Session",
  "close",
  "open",
  "url",
  "waitForDebugger",
]);
const inspectorModules = [inspector, inspectorPromises];
for (let moduleIndex = 0; moduleIndex < inspectorModules.length; moduleIndex += 1) {
  const module = inspectorModules[moduleIndex];
  for (let index = 0; index < deniedInspectorExportNames.length; index += 1) {
    const name = deniedInspectorExportNames[index];
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(module, name);
    if (
      !descriptor
      || !("value" in descriptor)
      || typeof descriptor.value !== "function"
      || descriptor.configurable !== true
    ) fail();
    DEFINE_PROPERTY(module, name, {
      configurable: false,
      enumerable: descriptor.enumerable,
      value: denyInspectorCapability,
      writable: false,
    });
  }
}
freezeExact(inspectorModules);

function denyV8HeapInspection() {
  throw new Error("locked_sensitive_worker_heap_inspection_disabled");
}

function denyV8HookRegistration() {
  throw new Error("locked_sensitive_worker_v8_hooks_disabled");
}

function denyWasiCapability() {
  throw new Error("locked_sensitive_worker_wasi_disabled");
}
freezeExact(denyWasiCapability);
const wasiDescriptor = GET_OWN_PROPERTY_DESCRIPTOR(wasi, "WASI");
if (
  !wasiDescriptor
  || !("value" in wasiDescriptor)
  || typeof wasiDescriptor.value !== "function"
  || wasiDescriptor.configurable !== true
) fail();
DEFINE_PROPERTY(wasi, "WASI", {
  configurable: false,
  enumerable: wasiDescriptor.enumerable,
  value: denyWasiCapability,
  writable: false,
});
freezeExact(wasi);
freezeExact(denyV8HeapInspection);
freezeExact(denyV8HookRegistration);
const deniedV8ExportNames = freezeExact([
  "getHeapSnapshot",
  "queryObjects",
  "setHeapSnapshotNearHeapLimit",
  "writeHeapSnapshot",
]);
for (let index = 0; index < deniedV8ExportNames.length; index += 1) {
  const name = deniedV8ExportNames[index];
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(v8, name);
  if (
    !descriptor
    || !("value" in descriptor)
    || typeof descriptor.value !== "function"
    || descriptor.configurable !== true
  ) fail();
  DEFINE_PROPERTY(v8, name, {
    configurable: false,
    enumerable: descriptor.enumerable,
    value: denyV8HeapInspection,
    writable: false,
  });
}

const v8PromiseHooks = exactObject(v8.promiseHooks);
const deniedV8PromiseHookNames = freezeExact([
  "createHook",
  "onInit",
  "onBefore",
  "onAfter",
  "onSettled",
]);
if (OWN_KEYS(v8PromiseHooks).length !== deniedV8PromiseHookNames.length) fail();
for (let index = 0; index < deniedV8PromiseHookNames.length; index += 1) {
  const name = deniedV8PromiseHookNames[index];
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(v8PromiseHooks, name);
  if (
    !descriptor
    || !("value" in descriptor)
    || typeof descriptor.value !== "function"
    || descriptor.configurable !== true
  ) fail();
  DEFINE_PROPERTY(v8PromiseHooks, name, {
    configurable: false,
    enumerable: descriptor.enumerable,
    value: denyV8HookRegistration,
    writable: false,
  });
}
freezeExact(v8PromiseHooks);
pinOwnData(v8, "promiseHooks", v8PromiseHooks);

// Node 22 exposes no accessor properties on the v8 namespace. Its adjacent
// startupSnapshot object does expose callback installers, however, so revoke
// those equivalent registration surfaces before any application graph loads.
const v8StartupSnapshot = exactObject(v8.startupSnapshot);
const deniedV8SnapshotCallbackNames = freezeExact([
  "addDeserializeCallback",
  "addSerializeCallback",
  "setDeserializeMainFunction",
]);
for (let index = 0; index < deniedV8SnapshotCallbackNames.length; index += 1) {
  const name = deniedV8SnapshotCallbackNames[index];
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(v8StartupSnapshot, name);
  if (
    !descriptor
    || !("value" in descriptor)
    || typeof descriptor.value !== "function"
    || descriptor.configurable !== true
  ) fail();
  DEFINE_PROPERTY(v8StartupSnapshot, name, {
    configurable: false,
    enumerable: descriptor.enumerable,
    value: denyV8HookRegistration,
    writable: false,
  });
}
freezeExact(v8StartupSnapshot);
pinOwnData(v8, "startupSnapshot", v8StartupSnapshot);

const v8ModuleSurfaces = freezeExact([v8, v8Namespace]);
for (let surfaceIndex = 0; surfaceIndex < v8ModuleSurfaces.length; surfaceIndex += 1) {
  const surface = v8ModuleSurfaces[surfaceIndex];
  const keys = OWN_KEYS(surface);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(surface, keys[index]);
    if (!descriptor || !("value" in descriptor)) fail();
  }
}

APPLY(syncBuiltinESMExports, undefined, []);
const asyncHookCreateDescriptor = GET_OWN_PROPERTY_DESCRIPTOR(asyncHooks, "createHook");
const asyncHookNamespaceDescriptor = GET_OWN_PROPERTY_DESCRIPTOR(
  asyncHooksNamespace,
  "createHook",
);
if (
  !asyncHookCreateDescriptor
  || !("value" in asyncHookCreateDescriptor)
  || asyncHookCreateDescriptor.value !== denyAsyncHookCreation
  || asyncHookCreateDescriptor.configurable !== false
  || asyncHookCreateDescriptor.writable !== false
  || !asyncHookNamespaceDescriptor
  || !("value" in asyncHookNamespaceDescriptor)
  || asyncHookNamespaceDescriptor.value !== denyAsyncHookCreation
) fail();

function assertDeniedModuleBindings(module, namespace, names, denial) {
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(module, name);
    const namespaceDescriptor = GET_OWN_PROPERTY_DESCRIPTOR(namespace, name);
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.value !== denial
      || descriptor.configurable !== false
      || descriptor.writable !== false
      || !namespaceDescriptor
      || !("value" in namespaceDescriptor)
      || namespaceDescriptor.value !== denial
    ) fail();
  }
}
assertDeniedModuleBindings(
  inspector,
  inspectorNamespace,
  deniedInspectorExportNames,
  denyInspectorCapability,
);
assertDeniedModuleBindings(
  inspectorPromises,
  inspectorPromisesNamespace,
  deniedInspectorExportNames,
  denyInspectorCapability,
);
assertDeniedModuleBindings(v8, v8Namespace, deniedV8ExportNames, denyV8HeapInspection);
assertDeniedModuleBindings(
  v8PromiseHooks,
  v8Namespace.promiseHooks,
  deniedV8PromiseHookNames,
  denyV8HookRegistration,
);
assertDeniedModuleBindings(
  v8StartupSnapshot,
  v8Namespace.startupSnapshot,
  deniedV8SnapshotCallbackNames,
  denyV8HookRegistration,
);
if (
  v8.promiseHooks !== v8PromiseHooks
  || v8Namespace.promiseHooks !== v8PromiseHooks
  || v8.startupSnapshot !== v8StartupSnapshot
  || v8Namespace.startupSnapshot !== v8StartupSnapshot
) fail();
if (wasi.WASI !== denyWasiCapability || wasiNamespace.WASI !== denyWasiCapability) fail();
for (let index = 0; index < deniedProcessCapabilityNames.length; index += 1) {
  const name = deniedProcessCapabilityNames[index];
  const namespaceDescriptor = GET_OWN_PROPERTY_DESCRIPTOR(processNamespace, name);
  if (
    namespaceDescriptor
    && (!("value" in namespaceDescriptor)
      || namespaceDescriptor.value !== denyProcessSensitiveCapability)
  ) fail();
}

const nodeConstructors = [
  asyncHooks.AsyncLocalStorage,
  asyncHooks.AsyncResource,
  dns.Resolver,
  dnsPromises.Resolver,
  events.EventEmitter,
  events.EventEmitterAsyncResource,
  fs.Stats,
  http.Agent,
  http.ClientRequest,
  http.IncomingMessage,
  http.Server,
  http.ServerResponse,
  https.Agent,
  https.Server,
  net.Server,
  net.Socket,
  stream.Stream,
  stream.Readable,
  stream.Writable,
  stream.Duplex,
  stream.Transform,
  stream.PassThrough,
  tls.Server,
  tls.TLSSocket,
];
const nodeConstructorPrototypes = [];
for (let index = 0; index < nodeConstructors.length; index += 1) {
  nodeConstructorPrototypes[index] = lockShadowableConstructor(nodeConstructors[index]);
}
freezeExact(nodeConstructorPrototypes);

const preloadPath = fileURLToPath(import.meta.url);
const bigintStats = APPLY(fs.statSync, fs, [preloadPath, { bigint: true }]);
const bigintStatsPrototype = GET_PROTOTYPE_OF(bigintStats);
freezeExact(bigintStatsPrototype);

const fileHandle = await APPLY(fs.promises.open, fs.promises, [
  preloadPath,
  fs.constants.O_RDONLY,
]);
const fileHandlePrototype = GET_PROTOTYPE_OF(fileHandle);
const fileHandleClose = fileHandle.close;
await APPLY(fileHandleClose, fileHandle, []);
freezeExact(fileHandlePrototype);

function denyDiagnosticsSubscription() {
  throw new Error("locked_sensitive_worker_diagnostics_disabled");
}
const diagnosticNames = [
  "http.client.request.start",
  "http.client.response.finish",
  "net.client.socket",
  "tls.client.connection.start",
  "undici:client:beforeConnect",
  "undici:client:connected",
  "undici:client:connectError",
  "undici:client:sendHeaders",
  "undici:request:create",
  "undici:request:bodySent",
  "undici:request:headers",
  "undici:request:trailers",
  "undici:request:error",
  "undici:websocket:open",
  "undici:websocket:close",
  "undici:websocket:socket_error",
  "undici:websocket:ping",
  "undici:websocket:pong",
];
const diagnosticChannels = [];
let diagnosticChannelPrototype;
for (let index = 0; index < diagnosticNames.length; index += 1) {
  const name = diagnosticNames[index];
  if (APPLY(diagnosticsChannel.hasSubscribers, diagnosticsChannel, [name])) fail();
  const channel = APPLY(diagnosticsChannel.channel, diagnosticsChannel, [name]);
  const prototype = GET_PROTOTYPE_OF(channel);
  if (
    channel.name !== name
    || GET_OWN_PROPERTY_DESCRIPTOR(channel, "hasSubscribers") !== undefined
    || GET_OWN_PROPERTY_DESCRIPTOR(channel, "publish") !== undefined
    || (diagnosticChannelPrototype !== undefined && prototype !== diagnosticChannelPrototype)
  ) fail();
  diagnosticChannelPrototype = prototype;
  diagnosticChannels[index] = channel;
}
if (diagnosticChannelPrototype === undefined) fail();
DEFINE_PROPERTY(diagnosticChannelPrototype, "subscribe", {
  configurable: false,
  enumerable: false,
  value: denyDiagnosticsSubscription,
  writable: false,
});
DEFINE_PROPERTY(diagnosticChannelPrototype, "bindStore", {
  configurable: false,
  enumerable: false,
  value: denyDiagnosticsSubscription,
  writable: false,
});
freezeExact(diagnosticChannelPrototype);
freezeExact(diagnosticsChannel.Channel);
for (let index = 0; index < diagnosticChannels.length; index += 1) {
  freezeExact(diagnosticChannels[index]);
}
freezeExact(diagnosticNames);
freezeExact(diagnosticChannels);

function assertSensitiveDiagnosticChannels() {
  for (let index = 0; index < diagnosticNames.length; index += 1) {
    const name = diagnosticNames[index];
    const channel = diagnosticChannels[index];
    const nameDescriptor = GET_OWN_PROPERTY_DESCRIPTOR(channel, "name");
    if (
      APPLY(diagnosticsChannel.channel, diagnosticsChannel, [name]) !== channel
      || APPLY(diagnosticsChannel.hasSubscribers, diagnosticsChannel, [name]) !== false
      || !IS_FROZEN(channel)
      || IS_EXTENSIBLE(channel)
      || GET_PROTOTYPE_OF(channel) !== diagnosticChannelPrototype
      || GET_OWN_PROPERTY_DESCRIPTOR(channel, "hasSubscribers") !== undefined
      || GET_OWN_PROPERTY_DESCRIPTOR(channel, "publish") !== undefined
      || !nameDescriptor
      || !("value" in nameDescriptor)
      || nameDescriptor.value !== name
      || nameDescriptor.configurable !== false
      || nameDescriptor.writable !== false
    ) fail();
  }
}
assertSensitiveDiagnosticChannels();

freezeExact(asyncHooks);
freezeExact(crypto.webcrypto.subtle);
freezeExact(GET_PROTOTYPE_OF(crypto.webcrypto.subtle));
freezeExact(crypto.webcrypto);
freezeExact(crypto);
freezeExact(diagnosticsChannel);
freezeExact(dnsPromises);
freezeExact(dns.promises);
freezeExact(dns);
freezeExact(events);
freezeExact(http);
freezeExact(https);
freezeExact(inspector);
freezeExact(inspectorPromises);
freezeExact(net);
freezeExact(os);
freezeExact(path);
freezeExact(stream.promises);
freezeExact(stream);
freezeExact(tls);
freezeExact(util.types);
freezeExact(util);
freezeExact(v8);

const marker = freezeExact({
  bigintStatsPrototype,
  deniedInspectorExportNames,
  deniedProcessCapabilityNames,
  deniedV8ExportNames,
  deniedV8PromiseHookNames,
  deniedV8SnapshotCallbackNames,
  diagnosticChannels,
  diagnosticChannelPrototype,
  diagnosticNames,
  fileHandlePrototype,
  hashPrototype,
  hmacPrototype,
  navigatorObject,
  nodeConstructorPrototypes,
  performanceObject,
  version: 1,
  webStreamPrototypes,
});
DEFINE_PROPERTY(globalThis, MARKER, {
  configurable: false,
  enumerable: false,
  value: marker,
  writable: false,
});

function assertShadowableLock(lock) {
  if (typeof lock !== "object" || lock === null || !IS_FROZEN(lock)
    || typeof lock.prototype !== "object" || lock.prototype === null
    || !IS_FROZEN(lock.mutableNonconfigurable)
    || IS_EXTENSIBLE(lock.prototype)) fail();
  const keys = OWN_KEYS(lock.prototype);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(lock.prototype, key);
    if (!descriptor || descriptor.configurable !== false) fail();
    if ("value" in descriptor && descriptor.writable === true) {
      let found = false;
      for (let slot = 0; slot < lock.mutableNonconfigurable.length; slot += 1) {
        const expected = lock.mutableNonconfigurable[slot];
        if (expected.key === key && expected.value === descriptor.value) found = true;
      }
      if (!found) fail();
    }
  }
}

export function assertLockedSensitivePrimordials() {
  for (let index = 0; index < deniedProcessCapabilityNames.length; index += 1) {
    const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(
      processObject,
      deniedProcessCapabilityNames[index],
    );
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.value !== denyProcessSensitiveCapability
      || descriptor.configurable !== false
      || descriptor.writable !== false
    ) fail();
  }
  const descriptor = GET_OWN_PROPERTY_DESCRIPTOR(globalThis, MARKER);
  if (
    !descriptor
    || !("value" in descriptor)
    || descriptor.value !== marker
    || descriptor.configurable !== false
    || descriptor.writable !== false
    || !IS_FROZEN(marker)
    || navigatorObject.userAgent !== "Node.js/22"
    || !IS_FROZEN(String.prototype)
    || !IS_FROZEN(RegExp.prototype)
    || !IS_FROZEN(Array.prototype)
    || !IS_FROZEN(Buffer)
    || !IS_FROZEN(Buffer.prototype)
    || !IS_FROZEN(TextEncoder)
    || !IS_FROZEN(TextEncoder.prototype)
    || !IS_FROZEN(TextDecoder)
    || !IS_FROZEN(TextDecoder.prototype)
    || !IS_FROZEN(Headers)
    || !IS_FROZEN(Headers.prototype)
    || !IS_FROZEN(Request)
    || !IS_FROZEN(Request.prototype)
    || !IS_FROZEN(Response)
    || !IS_FROZEN(Response.prototype)
    || !IS_FROZEN(URL)
    || !IS_FROZEN(URL.prototype)
    || !IS_FROZEN(URLSearchParams)
    || !IS_FROZEN(URLSearchParams.prototype)
    || !IS_FROZEN(EventTarget)
    || !IS_FROZEN(EventTarget.prototype)
    || !IS_FROZEN(Event)
    || !IS_FROZEN(Event.prototype)
    || !IS_FROZEN(DOMException)
    || !IS_FROZEN(DOMException.prototype)
    || !IS_FROZEN(Performance)
    || !IS_FROZEN(Performance.prototype)
    || !IS_FROZEN(performanceObject)
    || !IS_FROZEN(AbortController)
    || !IS_FROZEN(AbortController.prototype)
    || !IS_FROZEN(AbortSignal)
    || !IS_FROZEN(AbortSignal.prototype)
    || !IS_FROZEN(globalThis.crypto)
    || !IS_FROZEN(globalThis.crypto.subtle)
    || !IS_FROZEN(GET_PROTOTYPE_OF(globalThis.crypto.subtle))
    || !IS_FROZEN(fileHandlePrototype)
    || !IS_FROZEN(bigintStatsPrototype)
    || !IS_FROZEN(hashPrototype)
    || !IS_FROZEN(hmacPrototype)
    || !IS_FROZEN(diagnosticChannelPrototype)
    || GET_OWN_PROPERTY_DESCRIPTOR(asyncHooks, "createHook")?.value
      !== denyAsyncHookCreation
    || asyncHooksNamespace.createHook !== denyAsyncHookCreation
    || v8.promiseHooks !== v8PromiseHooks
    || v8Namespace.promiseHooks !== v8PromiseHooks
    || !IS_FROZEN(v8PromiseHooks)
    || v8.startupSnapshot !== v8StartupSnapshot
    || v8Namespace.startupSnapshot !== v8StartupSnapshot
    || !IS_FROZEN(v8StartupSnapshot)
    || wasi.WASI !== denyWasiCapability
    || wasiNamespace.WASI !== denyWasiCapability
  ) fail();
  assertSensitiveDiagnosticChannels();
  assertDeniedModuleBindings(
    v8PromiseHooks,
    v8Namespace.promiseHooks,
    deniedV8PromiseHookNames,
    denyV8HookRegistration,
  );
  assertDeniedModuleBindings(
    v8StartupSnapshot,
    v8Namespace.startupSnapshot,
    deniedV8SnapshotCallbackNames,
    denyV8HookRegistration,
  );
  for (let index = 0; index < nodeConstructorPrototypes.length; index += 1) {
    assertShadowableLock(nodeConstructorPrototypes[index]);
  }
  for (let index = 0; index < webStreamPrototypes.length; index += 1) {
    assertShadowableLock(webStreamPrototypes[index]);
  }
}

assertLockedSensitivePrimordials();
