import childProcess, { type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LOCKED_ATTESTOR_KEYCHAIN_ACCOUNT,
  LOCKED_ATTESTOR_KEYCHAIN_PATH,
  LOCKED_ATTESTOR_KEYCHAIN_SERVICE,
  readFixedAttestorTokenFromKeychain,
  type LockedKeychainSpawnSync,
} from "../scripts/lib/locked-sensitive-worker-keychain.js";
import { lockedSensitiveWorkerInternals } from
  "../scripts/run-locked-sensitive-worker.js";

const ROOT = path.resolve(".");
const NODE22 = "/Users/zac/.nvm/versions/node/v22.23.2/bin/node";
const PRELOAD = path.join(
  ROOT,
  "scripts/lib/locked-sensitive-worker-primordials.mjs",
);
const TSX_LOADER = path.join(
  ROOT,
  "node_modules/.pnpm/tsx@4.23.11/node_modules/tsx/dist/loader.mjs",
);
const FINALIZER_URL = pathToFileURL(path.join(
  ROOT,
  "scripts/lib/locked-sensitive-worker-finalizer.ts",
)).href;
const LOCKED_ENVIRONMENT = Object.freeze({
  __CF_USER_TEXT_ENCODING: "0x1F5:0:0",
  HOME: "/Users/zac",
  LANG: "C",
  LOGNAME: "zac",
  PATH: "/usr/bin:/bin",
  USER: "zac",
});
const KEYCHAIN_TEST_ENVIRONMENT = Object.freeze({
  HOME: "/Users/zac",
  LOGNAME: "zac",
  USER: "zac",
});
const HAS_EXACT_NODE22 = fs.existsSync(NODE22)
  && childProcess.spawnSync(NODE22, ["--version"], { encoding: "utf8" }).stdout.trim()
    === "v22.23.2";

function lockedEval(source: string) {
  return childProcess.spawnSync(NODE22, [
    "--disable-warning=ExperimentalWarning",
    "--frozen-intrinsics",
    "--import",
    PRELOAD,
    "--input-type=module",
    "--eval",
    source,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: LOCKED_ENVIRONMENT,
    timeout: 20_000,
  });
}

function finalizedEval(source: string, imports = "", beforeFinalize = "") {
  return childProcess.spawnSync(NODE22, [
    "--disable-sigusr1",
    "--disable-warning=ExperimentalWarning",
    "--frozen-intrinsics",
    "--import",
    PRELOAD,
    "--import",
    TSX_LOADER,
    "--input-type=module",
    "--eval",
    `${imports}
      import {
        assertLockedSensitiveWorkerFinalization,
        finalizeLockedSensitiveWorkerCapabilities,
      } from ${JSON.stringify(FINALIZER_URL)};
      ${beforeFinalize}
      await finalizeLockedSensitiveWorkerCapabilities();
      ${source}`,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: LOCKED_ENVIRONMENT,
    timeout: 20_000,
  });
}

function nativeSpawnResult(stdout: Buffer, status = 0): SpawnSyncReturns<Buffer> {
  return {
    output: [null, stdout, null],
    pid: 12_345,
    signal: null,
    status,
    stderr: Buffer.alloc(0),
    stdout,
  };
}

describe.skipIf(!HAS_EXACT_NODE22)("locked sensitive production worker", () => {
  it("locks token/password hooks while preserving native fetch and instance shadows", async () => {
    const serverSource = `
      const http = require("node:http");
      const server = http.createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const exact = request.headers["project-access-token"] === "fake-token-123456"
            && body === "payload";
          response.writeHead(exact ? 200 : 400, { "Content-Type": "text/plain" });
          response.end(exact ? "ok" : "bad");
          server.close();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        process.stdout.write(String(server.address().port) + "\\n");
      });
      setTimeout(() => process.exit(70), 15000).unref();
    `;
    const server = childProcess.spawn(NODE22, ["--eval", serverSource], {
      cwd: ROOT,
      env: LOCKED_ENVIRONMENT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const port = await new Promise<number>((resolve, reject) => {
      let value = "";
      const timeout = setTimeout(() => reject(new Error("server timeout")), 5_000);
      server.once("error", reject);
      server.stderr.on("data", (chunk) => { value += String(chunk); });
      server.stdout.on("data", (chunk) => {
        const line = String(chunk).trim();
        if (/^[0-9]+$/.test(line)) {
          clearTimeout(timeout);
          resolve(Number(line));
        }
      });
      server.once("exit", (code) => {
        if (code && code !== 0) reject(new Error(`server ${code}: ${value}`));
      });
    });

    const client = finalizedEval(`
      import asyncHooks, { createHook as createNamedHook } from "node:async_hooks";
      import diagnostics, { channel as namedDiagnosticChannel } from
        "node:diagnostics_channel";
      import stream from "node:stream";
      let asyncHookCallbacks = 0;
      let diagnosticCaptured = false;
      let diagnosticShadowBlocks = 0;
      let inspectionCallbacks = 0;
      let observations = 0;
      let blocked = 0;
      const undiciChannelNames = [
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
      const undiciChannelsSealed = undiciChannelNames.every((name) => {
        const channel = diagnostics.channel(name);
        return channel === diagnostics.channel(name)
          && channel === namedDiagnosticChannel(name)
          && Object.isFrozen(channel)
          && !Object.isExtensible(channel)
          && !Object.hasOwn(channel, "hasSubscribers")
          && !Object.hasOwn(channel, "publish");
      });
      const graphSeen = new Set();
      const graphWalk = (value, depth = 0) => {
        if (typeof value === "string") {
          if (value.includes("fake-token-123456")) diagnosticCaptured = true;
          return;
        }
        if ((typeof value !== "object" && typeof value !== "function")
          || value === null || depth > 10 || graphSeen.has(value)) return;
        graphSeen.add(value);
        for (const key of Reflect.ownKeys(value)) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor && "value" in descriptor) graphWalk(descriptor.value, depth + 1);
        }
      };
      const requestCreateChannel = diagnostics.channel("undici:request:create");
      try {
        Object.defineProperty(requestCreateChannel, "hasSubscribers", {
          configurable: true,
          value: true,
          writable: true,
        });
      } catch { diagnosticShadowBlocks += 1; }
      try {
        Object.defineProperty(requestCreateChannel, "publish", {
          configurable: true,
          value(message) { graphWalk(message); },
          writable: true,
        });
      } catch { diagnosticShadowBlocks += 1; }
      let attackerChannelPublished = false;
      const attackerChannel = diagnostics.channel("pintpath:attacker-controlled");
      Object.defineProperty(attackerChannel, "hasSubscribers", {
        configurable: true,
        value: true,
        writable: true,
      });
      Object.defineProperty(attackerChannel, "publish", {
        configurable: true,
        value() { attackerChannelPublished = true; },
        writable: true,
      });
      const attempts = [
        [String.prototype, "includes"],
        [String.prototype, "replace"],
        [String.prototype, "normalize"],
        [TextEncoder.prototype, "encode"],
        [SubtleCrypto.prototype, "importKey"],
        [stream.Duplex.prototype, "write"],
        [ReadableStream.prototype, "constructor"],
      ];
      for (const [prototype, name] of attempts) {
        const original = prototype[name];
        try {
          prototype[name] = function (...args) {
            observations += 1;
            return Reflect.apply(original, this, args);
          };
        } catch { blocked += 1; }
      }
      try {
        diagnostics.channel("undici:request:create").subscribe(() => {
          observations += 1;
        });
      } catch { blocked += 1; }
      try {
        diagnostics.subscribe("undici:request:create", () => {
          observations += 1;
        });
      } catch { blocked += 1; }
      const tryAsyncHook = (createHook) => {
        try {
          createHook({
            init(_asyncId, type, _triggerAsyncId, resource) {
              asyncHookCallbacks += 1;
              if (type !== "TCPWRAP") return;
              for (const symbol of Object.getOwnPropertySymbols(resource)) {
                if (symbol.description !== "owner_symbol") continue;
                const socket = resource[symbol];
                const originalWrite = socket?.write;
                if (typeof originalWrite !== "function") continue;
                socket.write = function (chunk, ...args) {
                  const text = typeof chunk === "string"
                    ? chunk
                    : Buffer.from(chunk).toString("latin1");
                  if (text.includes("fake-token-123456")) observations += 1;
                  return Reflect.apply(originalWrite, this, [chunk, ...args]);
                };
              }
            },
          }).enable();
        } catch { blocked += 1; }
      };
      tryAsyncHook(createNamedHook);
      tryAsyncHook(asyncHooks.createHook);
      const patchedResources = new WeakSet();
      const startInspectionPoll = (inspect) => {
        try {
          inspect();
          return setInterval(() => {
            inspectionCallbacks += 1;
            for (const resource of inspect()) {
              if (resource === null || typeof resource !== "object"
                || patchedResources.has(resource)
                || typeof resource.write !== "function") continue;
              patchedResources.add(resource);
              const originalWrite = resource.write;
              resource.write = function (chunk, ...args) {
                const text = typeof chunk === "string"
                  ? chunk
                  : Buffer.from(chunk).toString("latin1");
                if (text.includes("fake-token-123456")) observations += 1;
                return Reflect.apply(originalWrite, this, [chunk, ...args]);
              };
            }
          }, 0);
        } catch {
          blocked += 1;
          return undefined;
        }
      };
      const handlePoll = startInspectionPoll(process._getActiveHandles);
      const requestPoll = startInspectionPoll(process._getActiveRequests);
      const readable = new ReadableStream({ start(controller) { controller.close(); } });
      const LocalReadable = function LocalReadable() {};
      readable.constructor = LocalReadable;
      const duplex = new stream.Duplex({
        read() { this.push(null); },
        write(_chunk, _encoding, callback) { callback(); },
      });
      const localWrite = function localWrite() { return true; };
      duplex.write = localWrite;
      const request = new Request("http://127.0.0.1:${port}/", {
        method: "POST",
        headers: { "Project-Access-Token": "fake-token-123456" },
        body: "payload",
      });
      const response = await fetch(request);
      const body = await response.text();
      if (handlePoll !== undefined) clearInterval(handlePoll);
      if (requestPoll !== undefined) clearInterval(requestPoll);
      duplex.destroy();
      console.log(JSON.stringify({
        attackerChannelExtensible: Object.isExtensible(attackerChannel),
        attackerChannelPublished,
        asyncHookCallbacks,
        blocked,
        body,
        diagnosticCaptured,
        diagnosticShadowBlocks,
        duplexShadow: Object.hasOwn(duplex, "write") && duplex.write === localWrite,
        env: Object.keys(process.env).sort(),
        inspectionCallbacks,
        observations,
        readableShadow: Object.hasOwn(readable, "constructor")
          && readable.constructor === LocalReadable,
        status: response.status,
        undiciChannelsSealed,
      }));
    `, `
      import ${JSON.stringify(pathToFileURL(path.join(
        ROOT,
        "scripts/attest-railway-application-deployment.ts",
      )).href)};
      import ${JSON.stringify(pathToFileURL(path.join(
        ROOT,
        "scripts/postgres-reviewed-price-promotion.ts",
      )).href)};
    `);
    if (client.status !== 0) server.kill("SIGKILL");
    expect(client.stderr).toBe("");
    expect(client.status).toBe(0);
    expect(JSON.parse(client.stdout.trim())).toEqual({
      attackerChannelExtensible: true,
      attackerChannelPublished: false,
      asyncHookCallbacks: 0,
      blocked: 13,
      body: "ok",
      diagnosticCaptured: false,
      diagnosticShadowBlocks: 2,
      duplexShadow: true,
      env: ["HOME", "LANG", "LOGNAME", "PATH", "USER", "__CF_USER_TEXT_ENCODING"]
        .sort(),
      inspectionCallbacks: 0,
      observations: 0,
      readableShadow: true,
      status: 200,
      undiciChannelsSealed: true,
    });
  });

  it("keeps pg SCRAM password operations on the locked originals", () => {
    const result = lockedEval(`
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const sasl = require(${JSON.stringify(path.join(ROOT, "node_modules/pg/lib/crypto/sasl.js"))});
      const pg = require(${JSON.stringify(path.join(ROOT, "node_modules/pg"))});
      let observations = 0;
      let blocked = 0;
      for (const [prototype, name] of [
        [String.prototype, "replace"],
        [String.prototype, "normalize"],
        [TextEncoder.prototype, "encode"],
        [SubtleCrypto.prototype, "importKey"],
      ]) {
        const original = prototype[name];
        try {
          prototype[name] = function (...args) {
            observations += 1;
            return Reflect.apply(original, this, args);
          };
        } catch { blocked += 1; }
      }
      const session = sasl.startSession(["SCRAM-SHA-256"]);
      await sasl.continueSession(
        session,
        "fake-planner-password-123",
        "r=" + session.clientNonce + "server,s=c2FsdHNhbHQ=,i=4096",
      );
      const pool = new pg.Pool({ max: 1 });
      await pool.end();
      console.log(JSON.stringify({ blocked, message: session.message, observations }));
    `);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      blocked: 4,
      message: "SASLResponse",
      observations: 0,
    });
    expect(result.stdout).not.toContain("fake-planner-password-123");
  });

  it("seals public file, process, isolate, WASI, and loader capabilities before yielding", () => {
    const internalSaslUrl = pathToFileURL(path.join(
      ROOT,
      "node_modules/pg/lib/crypto/sasl.js",
    )).href;
    const result = finalizedEval(`
      const packagePath = ${JSON.stringify(path.join(ROOT, "package.json"))};
      const attempts = {
        childProcess: async () => {
          const child = await import("node:child_process");
          child.spawnSync("/usr/bin/printf", ["CHILD_OPEN"]);
        },
        createRequire: async () => {
          const module = await import("node:module");
          module.createRequire(import.meta.url);
        },
        execve: async () => {
          process.execve("/usr/bin/printf", ["printf", "EXECVE_OPEN"], process.env);
        },
        fsAccessor: async () => {
          const fileSystem = (await import("node:fs")).default;
          new fileSystem.ReadStream(packagePath);
        },
        fsPromise: async () => {
          const fileSystem = (await import("node:fs")).default;
          await fileSystem.promises.readFile(packagePath);
        },
        fsPromiseNamespace: async () => {
          const fileSystem = await import("node:fs/promises");
          await fileSystem.readFile(packagePath);
        },
        fsSync: async () => {
          const fileSystem = await import("node:fs");
          fileSystem.readFileSync(packagePath);
        },
        internalPg: async () => {
          await import(${JSON.stringify(internalSaslUrl)});
        },
        loadEnvFile: async () => {
          process.loadEnvFile(packagePath);
        },
        moduleRegister: async () => {
          const module = await import("node:module");
          module.register("data:text/javascript,export default 1");
        },
        wasi: async () => {
          const wasi = await import("node:wasi");
          new wasi.WASI({ version: "preview1" });
        },
        worker: async () => {
          const workers = await import("node:worker_threads");
          new workers.Worker("", { eval: true });
        },
      };
      const blocked = {};
      for (const [name, attempt] of Object.entries(attempts)) {
        try {
          await attempt();
          blocked[name] = false;
        } catch {
          blocked[name] = true;
        }
      }
      const module = await import("node:module");
      const dispatcherDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        Symbol.for("undici.globalDispatcher.1"),
      );
      const dispatcher = dispatcherDescriptor?.value;
      const fetchBody = await (await fetch("data:text/plain,facade-ok")).text();
      assertLockedSensitiveWorkerFinalization();
      console.log(JSON.stringify({
        blocked,
        cacheKeys: Object.keys(module.default._cache),
        dispatcherFrozen: Object.isFrozen(dispatcher),
        dispatcherKeys: Reflect.ownKeys(dispatcher).map(String),
        dispatcherPrototype: Object.getPrototypeOf(dispatcher),
        dispatcherWritable: dispatcherDescriptor?.writable,
        extensionKeys: Object.keys(module.default._extensions),
        fetchBody,
        scheduledFsBlocked,
      }));
    `, `import fileSystemForScheduled from "node:fs";`, `
      let scheduledFsBlocked = false;
      queueMicrotask(() => {
        try {
          fileSystemForScheduled.readFileSync(
            ${JSON.stringify(path.join(ROOT, "package.json"))},
          );
        } catch {
          scheduledFsBlocked = true;
        }
      });
    `);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      blocked: {
        childProcess: true,
        createRequire: true,
        execve: true,
        fsAccessor: true,
        fsPromise: true,
        fsPromiseNamespace: true,
        fsSync: true,
        internalPg: true,
        loadEnvFile: true,
        moduleRegister: true,
        wasi: true,
        worker: true,
      },
      cacheKeys: [],
      dispatcherFrozen: true,
      dispatcherKeys: ["dispatch"],
      dispatcherPrototype: null,
      dispatcherWritable: false,
      extensionKeys: [],
      fetchBody: "facade-ok",
      scheduledFsBlocked: true,
    });
  });

  it("revokes every V8 hook installer before a pg Client promise can expose its password", () => {
    const result = finalizedEval(`
      const fakeSecret = "fake-planner-password-123";
      let captured = null;
      let arming = false;
      const installedStops = [];
      const observePromise = (promise) => {
        if (arming) return;
        arming = true;
        try {
          Reflect.apply(Promise.prototype.then, promise, [
            (value) => {
              if (value instanceof pg.Client && value.password === fakeSecret) {
                captured = value.password;
              }
            },
            () => {},
          ]);
        } finally {
          arming = false;
        }
      };
      const promiseHookNames = [
        "createHook",
        "onInit",
        "onBefore",
        "onAfter",
        "onSettled",
      ];
      const builtinV8 = process.getBuiltinModule("v8");
      let promiseHookBlocks = 0;
      for (const hooks of [v8.promiseHooks, namedPromiseHooks, builtinV8.promiseHooks]) {
        for (const name of promiseHookNames) {
          try {
            const callback = name === "createHook"
              ? { init: observePromise }
              : observePromise;
            const stop = Reflect.apply(hooks[name], hooks, [callback]);
            if (typeof stop === "function") installedStops.push(stop);
          } catch {
            promiseHookBlocks += 1;
          }
        }
      }

      const snapshotCallbackNames = [
        "addDeserializeCallback",
        "addSerializeCallback",
        "setDeserializeMainFunction",
      ];
      let snapshotCallbackBlocks = 0;
      for (const snapshot of [
        v8.startupSnapshot,
        namedStartupSnapshot,
        builtinV8.startupSnapshot,
      ]) {
        for (const name of snapshotCallbackNames) {
          try {
            Reflect.apply(snapshot[name], snapshot, [() => {}]);
          } catch {
            snapshotCallbackBlocks += 1;
          }
        }
      }

      class FakeConnection extends EventEmitter {
        constructor() {
          super();
          this.stream = { destroy() {} };
        }
        connect() {
          queueMicrotask(() => {
            this.emit("connect");
            this.emit("readyForQuery", { status: "I" });
          });
        }
        startup() {}
      }
      const client = new pg.Client({
        connection: new FakeConnection(),
        database: "railway",
        host: "127.0.0.1",
        password: fakeSecret,
        port: 5432,
        user: "pintpath_planner",
      });
      const connected = await client.connect();
      await new Promise((resolve) => setImmediate(resolve));
      for (const stop of installedStops) stop();
      const pool = new pg.Pool({ max: 1 });
      await pool.end();
      assertLockedSensitiveWorkerFinalization();
      console.log(JSON.stringify({
        builtinV8Same: builtinV8 === v8,
        captured: captured === fakeSecret,
        connected: connected === client,
        poolEnded: pool.ended,
        promiseHookBlocks,
        promiseHookKeys: Object.keys(v8.promiseHooks).sort(),
        promiseHooksFrozen: Object.isFrozen(v8.promiseHooks),
        snapshotBuilding: v8.startupSnapshot.isBuildingSnapshot(),
        snapshotCallbackBlocks,
        startupSnapshotFrozen: Object.isFrozen(v8.startupSnapshot),
      }));
    `, `
      import { EventEmitter } from "node:events";
      import v8, {
        promiseHooks as namedPromiseHooks,
        startupSnapshot as namedStartupSnapshot,
      } from "node:v8";
      import pg from "pg";
      import ${JSON.stringify(pathToFileURL(path.join(
        ROOT,
        "scripts/attest-railway-application-deployment.ts",
      )).href)};
      import ${JSON.stringify(pathToFileURL(path.join(
        ROOT,
        "scripts/postgres-reviewed-price-promotion.ts",
      )).href)};
    `);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      builtinV8Same: true,
      captured: false,
      connected: true,
      poolEnded: true,
      promiseHookBlocks: 15,
      promiseHookKeys: ["createHook", "onAfter", "onBefore", "onInit", "onSettled"],
      promiseHooksFrozen: true,
      snapshotBuilding: 0,
      snapshotCallbackBlocks: 9,
      startupSnapshotFrozen: true,
    });
    expect(result.stdout).not.toContain("fake-planner-password-123");
  });

  it("freezes the pg credential graph while preserving SCRAM, Pool, net, and TLS", () => {
    const result = finalizedEval(`
      let blocked = 0;
      try {
        sasl.continueSession = () => { throw new Error("credential capture"); };
      } catch { blocked += 1; }
      try {
        pg.Client.prototype._handleAuthSASLContinue = () => {
          throw new Error("credential capture");
        };
      } catch { blocked += 1; }
      const session = sasl.startSession(["SCRAM-SHA-256"]);
      await sasl.continueSession(
        session,
        "fake-planner-password-123",
        "r=" + session.clientNonce + "server,s=c2FsdHNhbHQ=,i=4096",
      );
      const pool = new pg.Pool({ max: 1 });
      await pool.end();
      const plain = new pg.Connection({ ssl: false });
      const plainName = plain.stream.constructor.name;
      plain.stream.destroy();
      const secure = new pg.Connection({ ssl: { rejectUnauthorized: false } });
      let tlsName = "";
      try {
        secure.upgradeToSSL("127.0.0.1", () => {});
        tlsName = secure.stream.constructor.name;
      } finally {
        secure.stream.destroy();
      }
      assertLockedSensitiveWorkerFinalization();
      console.log(JSON.stringify({
        blocked,
        message: session.message,
        plainName,
        poolEnded: pool.ended,
        tlsName,
      }));
    `, `
      import pg from "pg";
      import sasl from ${JSON.stringify(pathToFileURL(path.join(
        ROOT,
        "node_modules/pg/lib/crypto/sasl.js",
      )).href)};
    `);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      blocked: 2,
      message: "SASLResponse",
      plainName: "Socket",
      poolEnded: true,
      tlsName: "TLSSocket",
    });
    expect(result.stdout).not.toContain("fake-planner-password-123");
  });

  it("uses the trusted shell child and rejects invalid args before Keychain", () => {
    const launcherSource = fs.readFileSync(
      path.join(ROOT, "scripts/run-locked-sensitive-worker.sh"),
      "utf8",
    );
    expect(launcherSource).toContain("--disable-sigusr1");
    expect(launcherSource).toContain("#!/usr/bin/env -S -i /bin/zsh -f");
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { readonly scripts?: Readonly<Record<string, string>> };
    expect(packageJson.scripts?.["readiness:railway:staging-app-deployment"])
      .toBeUndefined();
    expect(packageJson.scripts?.["menus:promote-reviewed:postgres"])
      .toBeUndefined();
    expect(lockedSensitiveWorkerInternals.exactAttestorArgumentShape([])).toBe(false);
    let keychainCalls = 0;
    if (lockedSensitiveWorkerInternals.exactAttestorArgumentShape([])) keychainCalls += 1;
    expect(keychainCalls).toBe(0);

    const markerRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-locked-launcher-"),
    );
    try {
      const cdMarker = path.join(markerRoot, "cd");
      const testMarker = path.join(markerRoot, "test");
      const result = childProcess.spawnSync(
        "./scripts/run-locked-sensitive-worker.sh",
        ["attestor", "--bogus"],
        {
          cwd: ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            "BASH_FUNC_cd%%": `() { /usr/bin/touch '${cdMarker}'; }`,
            "BASH_FUNC_[%%": `() { /usr/bin/touch '${testMarker}'; }`,
            BASH_ENV: "/definitely/not/loaded-by-zsh",
            ENV: "/definitely/not/loaded-by-zsh",
            NODE_OPTIONS: "--import=/definitely/not/loaded/by-the-clean-child.mjs",
            NODE_TLS_REJECT_UNAUTHORIZED: "0",
            PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "must-not-cross-launcher",
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(fs.existsSync(cdMarker)).toBe(false);
      expect(fs.existsSync(testMarker)).toBe(false);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        command: "attest",
        failureCode: "argument_invalid",
        ok: false,
      });

    } finally {
      fs.rmSync(markerRoot, { force: true, recursive: true });
    }
  });

  it("fails direct unsafe CLI entrypoints before private-file or token custody", () => {
    for (const entry of [
      "scripts/attest-railway-application-deployment.ts",
      "scripts/postgres-reviewed-price-promotion.ts",
    ]) {
      const result = childProcess.spawnSync(NODE22, [
        "--import",
        TSX_LOADER,
        path.join(ROOT, entry),
      ], {
        cwd: ROOT,
        encoding: "utf8",
        env: LOCKED_ENVIRONMENT,
        timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
    }
  });
});

describe("locked attestor Keychain adapter", () => {
  it("uses the exact account, service, and login Keychain and wipes success", () => {
    const stdout = Buffer.from("fake-keychain-token-123\n", "utf8");
    let calls = 0;
    const spawn: LockedKeychainSpawnSync = (file, args, options) => {
      calls += 1;
      expect(file).toBe("/usr/bin/security");
      expect(args).toEqual([
        "find-generic-password",
        "-w",
        "-a",
        LOCKED_ATTESTOR_KEYCHAIN_ACCOUNT,
        "-s",
        LOCKED_ATTESTOR_KEYCHAIN_SERVICE,
        LOCKED_ATTESTOR_KEYCHAIN_PATH,
      ]);
      expect(options.env).toEqual({
        HOME: "/Users/zac",
        LANG: "C",
        LOGNAME: "zac",
        PATH: "/usr/bin:/bin",
        USER: "zac",
      });
      expect(JSON.stringify(options)).not.toContain("fake-keychain-token-123");
      return nativeSpawnResult(stdout);
    };
    expect(readFixedAttestorTokenFromKeychain(
      spawn,
      "darwin",
      KEYCHAIN_TEST_ENVIRONMENT,
    ))
      .toBe("fake-keychain-token-123");
    expect(calls).toBe(1);
    expect([...stdout]).toEqual(new Array(stdout.length).fill(0));
  });

  it("wipes partial and nonzero Keychain stdout before fixed failure", () => {
    const partial = Buffer.from("partial-without-newline", "utf8");
    const nonzero = Buffer.from("partial-secret\n", "utf8");
    const errored = Buffer.from("error-partial-secret\n", "utf8");
    const fixtures: Array<{
      readonly result: SpawnSyncReturns<Buffer>;
      readonly stdout: Buffer;
    }> = [
      { result: nativeSpawnResult(partial), stdout: partial },
      { result: nativeSpawnResult(nonzero, 1), stdout: nonzero },
      {
        result: {
          ...nativeSpawnResult(errored),
          error: new Error("synthetic timeout"),
          status: null,
        },
        stdout: errored,
      },
    ];
    for (const fixture of fixtures) {
      const spawn: LockedKeychainSpawnSync = () => fixture.result;
      expect(() => readFixedAttestorTokenFromKeychain(
        spawn,
        "darwin",
        KEYCHAIN_TEST_ENVIRONMENT,
      ))
        .toThrow("locked_sensitive_worker_keychain_failed");
      expect([...fixture.stdout]).toEqual(new Array(fixture.stdout.length).fill(0));
    }
  });
});
