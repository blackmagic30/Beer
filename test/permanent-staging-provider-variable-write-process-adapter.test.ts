import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PRIVATE_COPY_SCHEMA,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_ADAPTER_SCHEMA,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_RECEIPT_SCHEMA,
  claimPermanentStagingProviderVariableWriteProcessChildAuthority,
  claimPermanentStagingProviderVariableWriteProcessChildResultAuthority,
  claimPermanentStagingProviderVariableWriteProcessLauncherAuthority,
  openPermanentStagingProviderVariableWriteProcessAdapter,
  type PermanentStagingProviderVariableWriteProcessCommand,
  type PermanentStagingProviderVariableWriteProcessAdapterAuthority,
  type PermanentStagingProviderVariableWriteProcessAdapterDependencies,
  type PermanentStagingProviderVariableWriteProcessSpawn,
  type PermanentStagingProviderVariableWriteProcessSpawnOptions,
  type PermanentStagingProviderVariableWriteSpawnedChildFacade,
} from "../scripts/lib/permanent-staging-provider-variable-write-process-adapter.js";

const roots: string[] = [];
const NEVER_ABORTED_SIGNAL = new AbortController().signal;
const TOKEN = "fixture-railway-token-never-sent-to-a-provider";
const VALUE = "fixture-provider-value";

function privateRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(
    os.tmpdir(),
    "pintpath-provider-process-adapter.",
  )));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function command(
  authority: PermanentStagingProviderVariableWriteProcessAdapterAuthority,
  executable: unknown = "/mutable/untrusted/railway",
): PermanentStagingProviderVariableWriteProcessCommand {
  return Object.freeze({
    schemaVersion: "pintpath-permanent-staging-provider-variable-write-command/v2",
    executable,
    executableAuthority: Object.freeze({
      privateExecutableCopySha256:
        authority.privateExecutableCopy.copySha256,
      privateExecutableCopyIdentitySha256:
        authority.privateExecutableCopy.identitySha256,
      privateExecutableCopyAuthoritySha256:
        authority.privateExecutableCopyAuthoritySha256,
      descriptorHeld: true,
    }),
    argv: Object.freeze([
      "variable",
      "set",
      "OPENAI_API_KEY",
      "--stdin",
      "--skip-deploys",
      "--project",
      "fixture-project",
      "--environment",
      "fixture-environment",
      "--service",
      "fixture-service",
    ]),
    environment: Object.freeze({
      inherit: false,
      prototype: "null",
      ownEnumerableDataPropertiesOnly: true,
      exactNames: Object.freeze(["RAILWAY_TOKEN"] as const),
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
    abortSignalSequence: Object.freeze(["SIGTERM", "SIGKILL"] as const),
    processGroupEmptyBeforeSettlement: true,
  });
}

function writePrivateCopy(root: string, source: string): string {
  const copyPath = path.join(root, "railway-private-copy");
  fs.writeFileSync(copyPath, source, { flag: "wx", mode: 0o500 });
  fs.chmodSync(copyPath, 0o500);
  return copyPath;
}

function nativeChildWrapper(child: ReturnType<typeof spawn>) {
  return {
    pid: child.pid,
    stdin: {
      write: child.stdin.write.bind(child.stdin),
      end: child.stdin.end.bind(child.stdin),
      once: child.stdin.once.bind(child.stdin),
      removeListener: child.stdin.removeListener.bind(child.stdin),
    },
    once: child.once.bind(child),
    removeListener: child.removeListener.bind(child),
  };
}

interface ControlledChild {
  readonly spawned: PermanentStagingProviderVariableWriteSpawnedChildFacade;
  readonly emitter: EventEmitter;
  readonly writes: Buffer[];
  readonly writeCallbacks: Array<(error?: unknown) => void>;
  readonly endCallbacks: Array<(error?: unknown) => void>;
}

function controlledChild(pid = 4242): ControlledChild {
  const emitter = new EventEmitter();
  const stdinEmitter = new EventEmitter();
  const writes: Buffer[] = [];
  const writeCallbacks: Array<(error?: unknown) => void> = [];
  const endCallbacks: Array<(error?: unknown) => void> = [];
  return {
    emitter,
    writes,
    writeCallbacks,
    endCallbacks,
    spawned: {
      pid,
      stdin: {
        write(value: Buffer, callback: (error?: unknown) => void) {
          writes.push(Buffer.from(value));
          writeCallbacks.push(callback);
          return true;
        },
        end(callback: (error?: unknown) => void) {
          endCallbacks.push(callback);
        },
        once: stdinEmitter.once.bind(stdinEmitter),
        removeListener: stdinEmitter.removeListener.bind(stdinEmitter),
      },
      once: emitter.once.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${root}-held`, { recursive: true, force: true });
  }
});

describe("permanent staging provider-variable process adapter", () => {
  it("does not evaluate post-import global Object, Reflect, or Buffer receivers", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const ObjectExact = Object;
    const ReflectExact = Reflect;
    const BufferExact = Buffer;
    const descriptors = ["Object", "Reflect", "Buffer"].map((key) =>
      ObjectExact.getOwnPropertyDescriptor(globalThis, key));
    const spawnCapability = vi.fn();
    const input = {
      privateExecutableCopyPath: "relative-invalid",
      expectedSourceSha256: "0".repeat(64),
      spawn: spawnCapability,
      killProcessGroup: vi.fn(),
      probeProcessGroupEmpty: () => true,
    };
    let traps = 0;
    const mutate = () => {
      traps += 1;
      input.privateExecutableCopyPath = copyPath;
      input.expectedSourceSha256 = sha256(bytes);
    };
    const values = [ObjectExact, ReflectExact, BufferExact];
    let pending!: ReturnType<
      typeof openPermanentStagingProviderVariableWriteProcessAdapter
    >;
    try {
      for (let index = 0; index < values.length; index += 1) {
        ObjectExact.defineProperty(globalThis, ["Object", "Reflect", "Buffer"][index]!, {
          configurable: true,
          get() {
            mutate();
            return values[index];
          },
        });
      }
      pending = openPermanentStagingProviderVariableWriteProcessAdapter(input);
    } finally {
      for (let index = 0; index < descriptors.length; index += 1) {
        const key = ["Object", "Reflect", "Buffer"][index]!;
        const descriptor = descriptors[index];
        if (descriptor === undefined) ReflectExact.deleteProperty(globalThis, key);
        else ObjectExact.defineProperty(globalThis, key, descriptor);
      }
    }
    await expect(pending).rejects.toMatchObject({
      code: "process_adapter_invalid",
    });
    expect(traps).toBe(0);
    expect(input.privateExecutableCopyPath).toBe("relative-invalid");
    expect(spawnCapability).not.toHaveBeenCalled();
  });

  it("executes one local fake CLI through the held private copy with exact isolation", async () => {
    const root = privateRoot();
    const report = path.join(privateRoot(), "fake-cli-report");
    const script = `#!/bin/sh\nIFS= read -r VALUE || true\n{\nprintf '%s\\n' "$RAILWAY_TOKEN"\nprintf '%s\\n' "$VALUE"\nprintf '%s\\n' "$#"\nfor ARG in "$@"; do printf '%s\\n' "$ARG"; done\n} > '${report}'\n`;
    const copyPath = writePrivateCopy(root, script);
    const spawnCalls: Array<{
      readonly executable: string;
      readonly argv: readonly string[];
      readonly options: PermanentStagingProviderVariableWriteProcessSpawnOptions;
      readonly tokenExactAtSpawn: boolean;
    }> = [];
    const spawnCapability: PermanentStagingProviderVariableWriteProcessSpawn = (
      executable,
      argv,
      options,
    ) => {
      const tokenDescriptor = Object.getOwnPropertyDescriptor(
        options.env,
        "RAILWAY_TOKEN",
      );
      spawnCalls.push({
        executable,
        argv,
        options,
        tokenExactAtSpawn: Object.getPrototypeOf(options.env) === null
          && Reflect.ownKeys(options.env).length === 1
          && Reflect.ownKeys(options.env)[0] === "RAILWAY_TOKEN"
          && tokenDescriptor?.enumerable === true
          && tokenDescriptor.value === TOKEN
          && tokenDescriptor.writable === false,
      });
      return nativeChildWrapper(spawn(executable, [...argv], {
        detached: options.detached,
        env: options.env,
        shell: options.shell,
        stdio: ["pipe", "ignore", "ignore"],
      }));
    };
    const killProcessGroup = vi.fn((pid: number, signal: "SIGTERM" | "SIGKILL") =>
      process.kill(-pid, signal));
    const probeProcessGroupEmpty = vi.fn((pid: number) => {
      try {
        process.kill(-pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    });
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(script),
      spawn: spawnCapability,
      killProcessGroup,
      probeProcessGroupEmpty,
    });

    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    expect(authority).toMatchObject({
      schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_ADAPTER_SCHEMA,
      privateExecutableCopy: {
        schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PRIVATE_COPY_SCHEMA,
        absolutePath: copyPath,
        sourceSha256: sha256(script),
        copySha256: sha256(script),
        parentMode0700: true,
        mode0500: true,
        descriptorHeld: true,
        sourceDigestExact: true,
      },
      exactlyOneChild: true,
      injectedSpawnOnly: true,
      environmentNullPrototype: true,
      stdinCompleteWriteBeforeEof: true,
      detachedProcessGroup: true,
      abortTermThenKill: true,
      providerInvokedDuringInspection: false,
    });
    for (const digest of [
      authority.privateExecutableCopyAuthoritySha256,
      authority.environmentAuthoritySha256,
      authority.stdinAuthoritySha256,
      authority.processGroupAuthoritySha256,
      authority.processAdapterAuthoritySha256,
    ]) expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(authority)).not.toContain(TOKEN);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(spawnCalls).toHaveLength(0);

    const executableGetter = vi.fn(() => "/attacker/replacement");
    const hostileCommand = command(authority);
    const descriptors = Object.getOwnPropertyDescriptors(hostileCommand);
    Object.defineProperty(descriptors, "executable", {
      configurable: true,
      enumerable: true,
      value: {
        configurable: false,
        enumerable: true,
        get: executableGetter,
      },
      writable: true,
    });
    const commandWithGetter = Object.create(
      Object.prototype,
      descriptors,
    ) as PermanentStagingProviderVariableWriteProcessCommand;
    const launch = adapter.createLauncher(TOKEN);
    const child = await launch(commandWithGetter, NEVER_ABORTED_SIGNAL);
    await child.writeStdin(Buffer.from(VALUE, "utf8"));
    const result = await child.closed;

    expect(executableGetter).not.toHaveBeenCalled();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.executable).toBe(copyPath);
    expect(spawnCalls[0]!.options).toMatchObject({
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    });
    const childEnvironment = spawnCalls[0]!.options.env;
    expect(Object.getPrototypeOf(childEnvironment)).toBeNull();
    expect(spawnCalls[0]!.tokenExactAtSpawn).toBe(true);
    expect(Reflect.ownKeys(childEnvironment)).toEqual([]);
    expect(killProcessGroup).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      processAdapterReceipt: {
        schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_PROCESS_RECEIPT_SCHEMA,
        processAdapterAuthoritySha256: authority.processAdapterAuthoritySha256,
        childAttempts: 1,
        environmentNullPrototype: true,
        stdinWrites: 1,
        stdinWriteCompleted: true,
        stdinEof: true,
        stdoutBytesCaptured: 0,
        stderrBytesCaptured: 0,
        detachedProcessGroup: true,
        processGroupReaped: true,
        processGroupEmpty: true,
        closeAndErrorSettled: true,
      },
    });
    expect(result.processAdapterReceiptSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(fs.readFileSync(report, "utf8").split("\n")).toEqual([
      TOKEN,
      VALUE,
      "11",
      ...command(authority).argv,
      "",
    ]);
    await expect(launch(command(authority), NEVER_ABORTED_SIGNAL)).rejects.toMatchObject({
      code: "process_adapter_invalid",
    });
    await adapter.close();
  });

  it("waits for the complete write and EOF callback before accepting close", async () => {
    const root = privateRoot();
    const copyPath = writePrivateCopy(root, "#!/bin/sh\nexit 0\n");
    const controlled = controlledChild();
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256("#!/bin/sh\nexit 0\n"),
      spawn: () => controlled.spawned,
      killProcessGroup: vi.fn(),
      probeProcessGroupEmpty: () => true,
    });
    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    const child = await adapter.createLauncher(TOKEN)(
      command(authority),
      NEVER_ABORTED_SIGNAL,
    );
    let writeSettled = false;
    const write = child.writeStdin(Buffer.from(VALUE)).then(() => {
      writeSettled = true;
    });
    let closeSettled = false;
    const closed = child.closed.then((result) => {
      closeSettled = true;
      return result;
    });
    expect(controlled.writes.map(String)).toEqual([VALUE]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writeSettled).toBe(false);
    expect(closeSettled).toBe(false);
    controlled.writeCallbacks[0]!();
    expect(controlled.endCallbacks).toHaveLength(1);
    expect(writeSettled).toBe(false);
    expect(closeSettled).toBe(false);
    controlled.endCallbacks[0]!();
    await write;
    expect(closeSettled).toBe(false);
    controlled.emitter.emit("close", 0, null);
    await expect(closed).resolves.toMatchObject({ exitCode: 0, signal: null });
    await adapter.close();
  });

  it("creates at most one token-bearing launcher capability", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const spawnCapability = vi.fn();
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: spawnCapability,
      killProcessGroup: vi.fn(),
      probeProcessGroupEmpty: () => true,
    });
    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    const first = adapter.createLauncher(TOKEN);
    const tokenGet = vi.fn(() => {
      throw new Error("second token object must not be inspected");
    });
    const tokenCall = vi.fn(() => {
      throw new Error("second token callable must not be invoked");
    });
    const second = new Proxy(tokenCall, { get: tokenGet }) as unknown as string;
    expect(() => adapter.createLauncher(second)).toThrow(expect.objectContaining({
      code: "process_adapter_invalid",
    }));
    expect(tokenGet).not.toHaveBeenCalled();
    expect(tokenCall).not.toHaveBeenCalled();
    await adapter.close();
    await expect(first(command(authority), NEVER_ABORTED_SIGNAL)).rejects
      .toMatchObject({ code: "process_adapter_invalid" });
    expect(spawnCapability).not.toHaveBeenCalled();
  });

  it("does not let a post-import Buffer getter reenter close during launcher creation", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const controlled = controlledChild();
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: () => controlled.spawned,
      killProcessGroup: vi.fn(),
      probeProcessGroupEmpty: () => true,
    });
    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    const ObjectExact = Object;
    const BufferExact = Buffer;
    const descriptor = ObjectExact.getOwnPropertyDescriptor(globalThis, "Buffer");
    let traps = 0;
    let reentrantClose: Promise<void> | undefined;
    let launcher!: ReturnType<typeof adapter.createLauncher>;
    try {
      ObjectExact.defineProperty(globalThis, "Buffer", {
        configurable: true,
        get() {
          traps += 1;
          reentrantClose = adapter.close();
          return BufferExact;
        },
      });
      launcher = adapter.createLauncher(TOKEN);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "Buffer");
      else ObjectExact.defineProperty(globalThis, "Buffer", descriptor);
    }
    expect(traps).toBe(0);
    expect(reentrantClose).toBeUndefined();
    const child = await launcher(command(authority), NEVER_ABORTED_SIGNAL);
    const write = child.writeStdin(Buffer.from(VALUE));
    controlled.writeCallbacks[0]!();
    controlled.endCallbacks[0]!();
    await write;
    controlled.emitter.emit("close", 0, null);
    await expect(child.closed).resolves.toMatchObject({ exitCode: 0 });
    await adapter.close();
  });

  it("privately couples and consumes the exact binding, launcher, child, and result chain", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const controlled = controlledChild(22_222);
    const adapterA = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: () => controlled.spawned,
      killProcessGroup: vi.fn(),
      probeProcessGroupEmpty: () => true,
    });
    const adapterB = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: () => controlledChild(22_223).spawned,
      killProcessGroup: vi.fn(),
      probeProcessGroupEmpty: () => true,
    });
    const bindingA = await adapterA.inspectLocalAuthorityBinding(
      NEVER_ABORTED_SIGNAL,
    );
    const bindingB = await adapterB.inspectLocalAuthorityBinding(
      NEVER_ABORTED_SIGNAL,
    );
    const authorityA = await adapterA.inspect(NEVER_ABORTED_SIGNAL);
    const launcher = adapterA.createLauncher(TOKEN);
    const wrapper = ((...args: Parameters<typeof launcher>) => launcher(...args));

    expect(claimPermanentStagingProviderVariableWriteProcessLauncherAuthority(
      bindingB,
      launcher,
    )).toBe(false);
    expect(claimPermanentStagingProviderVariableWriteProcessLauncherAuthority(
      bindingA,
      wrapper,
    )).toBe(false);
    expect(claimPermanentStagingProviderVariableWriteProcessLauncherAuthority(
      bindingA,
      launcher,
    )).toBe(true);
    expect(claimPermanentStagingProviderVariableWriteProcessLauncherAuthority(
      bindingA,
      launcher,
    )).toBe(false);

    const child = await launcher(command(authorityA), NEVER_ABORTED_SIGNAL);
    const childWrapper = Object.freeze({
      writeStdin: child.writeStdin.bind(child),
      abort: child.abort.bind(child),
      closed: child.closed,
    });
    expect(claimPermanentStagingProviderVariableWriteProcessChildAuthority(
      launcher,
      childWrapper,
    )).toBe(false);
    expect(claimPermanentStagingProviderVariableWriteProcessChildAuthority(
      launcher,
      child,
    )).toBe(true);
    expect(claimPermanentStagingProviderVariableWriteProcessChildAuthority(
      launcher,
      child,
    )).toBe(false);

    const write = child.writeStdin(Buffer.from(VALUE));
    controlled.writeCallbacks[0]!();
    controlled.endCallbacks[0]!();
    await write;
    controlled.emitter.emit("close", 0, null);
    const result = await child.closed;
    const spreadResult = {
      ...result,
      processAdapterReceiptSha256: sha256("rehashed-forgery"),
    };
    expect(claimPermanentStagingProviderVariableWriteProcessChildResultAuthority(
      child,
      spreadResult,
    )).toBe(false);
    expect(claimPermanentStagingProviderVariableWriteProcessChildResultAuthority(
      child,
      result,
    )).toBe(true);
    expect(claimPermanentStagingProviderVariableWriteProcessChildResultAuthority(
      child,
      result,
    )).toBe(false);
    await adapterA.close();
    await adapterB.close();
  });

  it("does not signal an already-empty group when abort begins", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const controlled = controlledChild(23_001);
    const signals: string[] = [];
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: () => controlled.spawned,
      killProcessGroup: (pid, signal) => signals.push(`${pid}:${signal}`),
      probeProcessGroupEmpty: () => true,
    });
    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    const child = await adapter.createLauncher(TOKEN)(
      command(authority),
      NEVER_ABORTED_SIGNAL,
    );
    const write = child.writeStdin(Buffer.from(VALUE));
    controlled.writeCallbacks[0]!();
    controlled.endCallbacks[0]!();
    await write;
    child.abort();
    controlled.emitter.emit("close", null, "SIGTERM");
    await expect(child.closed).resolves.toMatchObject({ signal: "SIGTERM" });
    expect(signals).toEqual([]);
    await adapter.close();
  });

  it("skips SIGKILL when the group becomes empty during TERM grace", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const controlled = controlledChild(23_002);
    const signals: string[] = [];
    let groupEmpty = false;
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: () => controlled.spawned,
      killProcessGroup: (pid, signal) => {
        signals.push(`${pid}:${signal}`);
        if (signal === "SIGTERM") groupEmpty = true;
      },
      probeProcessGroupEmpty: () => groupEmpty,
    });
    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    const child = await adapter.createLauncher(TOKEN)(
      command(authority),
      NEVER_ABORTED_SIGNAL,
    );
    const write = child.writeStdin(Buffer.from(VALUE));
    controlled.writeCallbacks[0]!();
    controlled.endCallbacks[0]!();
    await write;
    child.abort();
    await vi.waitFor(() => expect(signals).toEqual(["23002:SIGTERM"]));
    controlled.emitter.emit("close", null, "SIGTERM");
    await expect(child.closed).resolves.toMatchObject({ signal: "SIGTERM" });
    expect(signals).toEqual(["23002:SIGTERM"]);
    await adapter.close();
  });

  it("uses SIGTERM then SIGKILL for the detached group and awaits close", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const controlled = controlledChild(9876);
    const signals: string[] = [];
    let groupEmpty = false;
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: () => controlled.spawned,
      killProcessGroup: (pid, signal) => {
        signals.push(`${pid}:${signal}`);
        if (signal === "SIGKILL") groupEmpty = true;
      },
      probeProcessGroupEmpty: () => groupEmpty,
    });
    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    const child = await adapter.createLauncher(TOKEN)(
      command(authority),
      NEVER_ABORTED_SIGNAL,
    );
    const write = child.writeStdin(Buffer.from(VALUE));
    controlled.writeCallbacks[0]!();
    controlled.endCallbacks[0]!();
    await write;
    let closedSettled = false;
    const closed = child.closed.finally(() => {
      closedSettled = true;
    });
    child.abort();
    child.abort();
    await vi.waitFor(() => expect(signals).toEqual(["9876:SIGTERM"]));
    controlled.emitter.emit("close", null, "SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closedSettled).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    expect(signals).toEqual(["9876:SIGTERM", "9876:SIGKILL"]);
    await expect(closed).resolves.toMatchObject({
      exitCode: null,
      signal: "SIGTERM",
    });
    await adapter.close();
  });

  it("does not settle a child error until close is observed", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const controlled = controlledChild();
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: () => controlled.spawned,
      killProcessGroup: vi.fn(),
      probeProcessGroupEmpty: () => true,
    });
    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    const child = await adapter.createLauncher(TOKEN)(
      command(authority),
      NEVER_ABORTED_SIGNAL,
    );
    const write = child.writeStdin(Buffer.from(VALUE));
    controlled.writeCallbacks[0]!();
    controlled.endCallbacks[0]!();
    await write;
    let settled = false;
    const closed = child.closed.finally(() => {
      settled = true;
    });
    controlled.emitter.emit("error", new Error("unsafe child error"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    controlled.emitter.emit("close", null, null);
    await expect(closed).rejects.toMatchObject({ code: "process_write_failed" });
    await adapter.close();
  });

  it("reaps a surviving group before rejecting a non-exact close probe", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const controlled = controlledChild();
    const signals: string[] = [];
    let groupEmpty = false;
    let probeCalls = 0;
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: () => controlled.spawned,
      killProcessGroup: (pid, signal) => {
        signals.push(`${pid}:${signal}`);
        if (signal === "SIGKILL") groupEmpty = true;
      },
      probeProcessGroupEmpty: async () => {
        probeCalls += 1;
        return probeCalls === 1
          ? "true" as unknown as boolean
          : groupEmpty;
      },
    });
    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    const child = await adapter.createLauncher(TOKEN)(
      command(authority),
      NEVER_ABORTED_SIGNAL,
    );
    const write = child.writeStdin(Buffer.from(VALUE));
    controlled.writeCallbacks[0]!();
    controlled.endCallbacks[0]!();
    await write;
    controlled.emitter.emit("close", 0, null);
    await expect(child.closed).rejects.toMatchObject({
      code: "process_write_failed",
    });
    expect(signals).toEqual(["4242:SIGTERM", "4242:SIGKILL"]);
    expect(probeCalls).toBeGreaterThanOrEqual(3);
    await adapter.close();
  });

  it.each(["stdin facade", "child listener"] as const)(
    "reaps the group when post-spawn %s validation fails",
    async (failurePoint) => {
      const root = privateRoot();
      const bytes = "#!/bin/sh\nexit 0\n";
      const copyPath = writePrivateCopy(root, bytes);
      const controlled = controlledChild(5151);
      const signals: string[] = [];
      let groupEmpty = false;
      const malformed = failurePoint === "stdin facade"
        ? {
          ...controlled.spawned,
          stdin: {},
        }
        : {
          ...controlled.spawned,
          once() {
            throw new Error("fixture listener setup failure");
          },
        };
      const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
        privateExecutableCopyPath: copyPath,
        expectedSourceSha256: sha256(bytes),
        spawn: () => malformed as unknown as
          PermanentStagingProviderVariableWriteSpawnedChildFacade,
        killProcessGroup: (pid, signal) => {
          signals.push(`${pid}:${signal}`);
          if (signal === "SIGKILL") groupEmpty = true;
        },
        probeProcessGroupEmpty: () => groupEmpty,
      });
      const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
      await expect(adapter.createLauncher(TOKEN)(
        command(authority),
        NEVER_ABORTED_SIGNAL,
      )).rejects.toMatchObject({ code: "process_write_failed" });
      expect(signals).toEqual(["5151:SIGTERM", "5151:SIGKILL"]);
      await expect(adapter.close()).resolves.toBeUndefined();
    },
  );

  it("retains PID custody and reaps when spawn makes token scrubbing fail", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const controlled = controlledChild(51_515);
    const signals: string[] = [];
    let groupEmpty = false;
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: (_executable, _argv, options) => {
        const token = options.env.RAILWAY_TOKEN;
        Object.defineProperty(options.env, "RAILWAY_TOKEN", {
          configurable: false,
          enumerable: true,
          value: token,
          writable: false,
        });
        return controlled.spawned;
      },
      killProcessGroup: (pid, signal) => {
        signals.push(`${pid}:${signal}`);
        if (signal === "SIGKILL") groupEmpty = true;
      },
      probeProcessGroupEmpty: () => groupEmpty,
    });
    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    await expect(adapter.createLauncher(TOKEN)(
      command(authority),
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({ code: "process_write_failed" });
    expect(signals).toEqual(["51515:SIGTERM", "51515:SIGKILL"]);
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it("blocks private-copy replacement without deleting either inode or spawning", async () => {
    const root = privateRoot();
    const held = `${root}-held`;
    const bytes = "#!/bin/sh\nexit 0\n";
    const replacement = "#!/bin/sh\nexit 7\n";
    const copyPath = writePrivateCopy(root, bytes);
    const spawnCapability = vi.fn(() => controlledChild().spawned);
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: spawnCapability,
      killProcessGroup: vi.fn(),
      probeProcessGroupEmpty: () => true,
    });
    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    fs.renameSync(root, held);
    fs.mkdirSync(root, { mode: 0o700 });
    fs.chmodSync(root, 0o700);
    const replacementPath = writePrivateCopy(root, replacement);

    await expect(adapter.createLauncher(TOKEN)(
      command(authority),
      NEVER_ABORTED_SIGNAL,
    ))
      .rejects.toMatchObject({ code: "process_adapter_invalid" });
    expect(spawnCapability).not.toHaveBeenCalled();
    expect(fs.readFileSync(replacementPath, "utf8")).toBe(replacement);
    expect(fs.readFileSync(path.join(held, path.basename(copyPath)), "utf8"))
      .toBe(bytes);
    await adapter.close();
  });

  it("rejects a private-copy replacement made after spawn and preserves both inodes", async () => {
    const root = privateRoot();
    const held = `${root}-held`;
    const bytes = "#!/bin/sh\nexit 0\n";
    const replacement = "#!/bin/sh\nexit 9\n";
    const copyPath = writePrivateCopy(root, bytes);
    const controlled = controlledChild();
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: () => controlled.spawned,
      killProcessGroup: vi.fn(),
      probeProcessGroupEmpty: () => true,
    });
    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    const child = await adapter.createLauncher(TOKEN)(
      command(authority),
      NEVER_ABORTED_SIGNAL,
    );
    const write = child.writeStdin(Buffer.from(VALUE));
    controlled.writeCallbacks[0]!();
    controlled.endCallbacks[0]!();
    await write;

    fs.renameSync(root, held);
    fs.mkdirSync(root, { mode: 0o700 });
    fs.chmodSync(root, 0o700);
    const replacementPath = writePrivateCopy(root, replacement);
    controlled.emitter.emit("close", 0, null);

    await expect(child.closed).rejects.toMatchObject({
      code: "process_write_failed",
    });
    expect(fs.readFileSync(replacementPath, "utf8")).toBe(replacement);
    expect(fs.readFileSync(path.join(held, path.basename(copyPath)), "utf8"))
      .toBe(bytes);
    await adapter.close();
  });

  it("uses hardened canonical hashes and captured file-handle methods", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const controlled = controlledChild();
    const inheritedToJSON = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    const toJSON = vi.fn(() => ({ forged: true }));
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      enumerable: false,
      value: toJSON,
      writable: true,
    });
    let adapter: Awaited<ReturnType<
      typeof openPermanentStagingProviderVariableWriteProcessAdapter
    >> | undefined;
    try {
      adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
        privateExecutableCopyPath: copyPath,
        expectedSourceSha256: sha256(bytes),
        spawn: () => controlled.spawned,
        killProcessGroup: vi.fn(),
        probeProcessGroupEmpty: () => true,
      });
      const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);

      const probe = await fs.promises.open(copyPath, "r");
      const prototype = Object.getPrototypeOf(probe) as object;
      await probe.close();
      const pathResolveDescriptor = Object.getOwnPropertyDescriptor(
        path,
        "resolve",
      )!;
      const realpathExact = fs.realpath;
      const realpathDescriptor = Object.getOwnPropertyDescriptor(fs, "realpath")!;
      const realpathNativeDescriptor = Object.getOwnPropertyDescriptor(
        realpathExact,
        "native",
      )!;
      const pathResolvePoison = vi.fn(() => {
        throw new Error("live path.resolve must not run");
      });
      const realpathPoison = vi.fn(() => {
        throw new Error("live fs.realpath must not run");
      });
      const originals = ["read", "stat", "close"].map((key) =>
        Object.getOwnPropertyDescriptor(prototype, key));
      const poisons = ["read", "stat", "close"].map((key) => vi.fn(() => {
        throw new Error(`live FileHandle.${key} must not run`);
      }));
      try {
        Object.defineProperty(path, "resolve", {
          ...pathResolveDescriptor,
          value: pathResolvePoison,
        });
        Object.defineProperty(fs, "realpath", {
          ...realpathDescriptor,
          value: realpathPoison,
        });
        Object.defineProperty(realpathExact, "native", {
          ...realpathNativeDescriptor,
          value: realpathPoison,
        });
        for (let index = 0; index < poisons.length; index += 1) {
          Object.defineProperty(prototype, ["read", "stat", "close"][index]!, {
            ...originals[index],
            value: poisons[index],
          });
        }
        await expect(adapter.reassert(NEVER_ABORTED_SIGNAL)).resolves.toEqual(
          authority,
        );
        const child = await adapter.createLauncher(TOKEN)(
          command(authority),
          NEVER_ABORTED_SIGNAL,
        );
        const write = child.writeStdin(Buffer.from(VALUE));
        controlled.writeCallbacks[0]!();
        controlled.endCallbacks[0]!();
        await write;
        controlled.emitter.emit("close", 0, null);
        await expect(child.closed).resolves.toMatchObject({ exitCode: 0 });
        await adapter.close();
        for (const poison of poisons) expect(poison).not.toHaveBeenCalled();
        expect(pathResolvePoison).not.toHaveBeenCalled();
        expect(realpathPoison).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(path, "resolve", pathResolveDescriptor);
        Object.defineProperty(fs, "realpath", realpathDescriptor);
        Object.defineProperty(realpathExact, "native", realpathNativeDescriptor);
        for (let index = 0; index < originals.length; index += 1) {
          const descriptor = originals[index];
          const key = ["read", "stat", "close"][index]!;
          if (descriptor === undefined) Reflect.deleteProperty(prototype, key);
          else Object.defineProperty(prototype, key, descriptor);
        }
      }
    } finally {
      if (inheritedToJSON === undefined) {
        Reflect.deleteProperty(Object.prototype, "toJSON");
      } else {
        Object.defineProperty(Object.prototype, "toJSON", inheritedToJSON);
      }
    }
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("does not accept inherited FileHandle read authority from a poisoned descriptor table", async () => {
    const root = privateRoot();
    const trusted = "#!/bin/sh\nexit 0\n";
    const malicious = "#!/bin/sh\nexit 9\n";
    const copyPath = writePrivateCopy(root, malicious);
    const probe = await fs.promises.open(copyPath, "r");
    const prototype = Object.getPrototypeOf(probe) as object;
    await probe.close();
    const nativeRead = Object.getOwnPropertyDescriptor(prototype, "read");
    const inheritedRead = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "read",
    );
    const fakeRead = vi.fn(async (
      buffer: Buffer,
      offset: number,
      length: number,
    ) => {
      Buffer.from(trusted).copy(buffer, offset, 0, length);
      return { bytesRead: length, buffer };
    });
    let opened: Awaited<ReturnType<
      typeof openPermanentStagingProviderVariableWriteProcessAdapter
    >> | undefined;
    let failure: unknown;
    try {
      Reflect.deleteProperty(prototype, "read");
      Object.defineProperty(Object.prototype, "read", {
        configurable: true,
        value: fakeRead,
        writable: true,
      });
      opened = await openPermanentStagingProviderVariableWriteProcessAdapter({
        privateExecutableCopyPath: copyPath,
        expectedSourceSha256: sha256(trusted),
        spawn: vi.fn(),
        killProcessGroup: vi.fn(),
        probeProcessGroupEmpty: () => true,
      });
    } catch (error) {
      failure = error;
    } finally {
      if (nativeRead !== undefined) {
        Object.defineProperty(prototype, "read", nativeRead);
      }
      if (inheritedRead === undefined) {
        Reflect.deleteProperty(Object.prototype, "read");
      } else {
        Object.defineProperty(Object.prototype, "read", inheritedRead);
      }
    }
    await opened?.close();
    expect(failure).toMatchObject({ code: "process_adapter_invalid" });
    expect(fakeRead).not.toHaveBeenCalled();
    expect(fs.readFileSync(copyPath, "utf8")).toBe(malicious);
  });

  it("snapshots exact dependency capabilities before they self-mutate", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const poisons = {
      open: vi.fn(() => Promise.reject(new Error("mutated open"))),
      lstat: vi.fn(() => Promise.reject(new Error("mutated lstat"))),
      realpath: vi.fn(() => Promise.reject(new Error("mutated realpath"))),
      effectiveUid: vi.fn(() => -1),
    };
    let heldHandle: fs.promises.FileHandle | undefined;
    let mutated = false;
    let dependencies!: PermanentStagingProviderVariableWriteProcessAdapterDependencies;
    const originals = {
      async open(filename: string, flags: number) {
        heldHandle = await fs.promises.open(filename, flags);
        return heldHandle;
      },
      async lstat(filename: string) {
        if (!mutated) {
          mutated = true;
          for (const key of Object.keys(poisons) as Array<keyof typeof poisons>) {
            Object.defineProperty(dependencies, key, {
              configurable: true,
              enumerable: true,
              value: poisons[key],
              writable: true,
            });
          }
        }
        return fs.promises.lstat(filename, { bigint: true });
      },
      realpath: (filename: string) => fs.promises.realpath(filename),
      effectiveUid: () => process.geteuid!(),
    } satisfies PermanentStagingProviderVariableWriteProcessAdapterDependencies;
    dependencies = { ...originals };
    try {
      const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
        privateExecutableCopyPath: copyPath,
        expectedSourceSha256: sha256(bytes),
        spawn: () => controlledChild().spawned,
        killProcessGroup: vi.fn(),
        probeProcessGroupEmpty: () => true,
      }, dependencies);
      await expect(adapter.inspect(NEVER_ABORTED_SIGNAL)).resolves.toMatchObject({
        privateExecutableCopy: { absolutePath: copyPath },
      });
      await adapter.close();
      expect(mutated).toBe(true);
      for (const poison of Object.values(poisons)) {
        expect(poison).not.toHaveBeenCalled();
      }
      await expect(heldHandle!.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      for (const key of Object.keys(originals) as Array<keyof typeof originals>) {
        Object.defineProperty(dependencies, key, {
          configurable: true,
          enumerable: true,
          value: originals[key],
          writable: true,
        });
      }
    }
  });

  it("leases inspection across awaits and rejects concurrent launch or close", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const entered = deferred<void>();
    const release = deferred<void>();
    let pause = false;
    const dependencies: PermanentStagingProviderVariableWriteProcessAdapterDependencies = {
      open: (filename, flags) => fs.promises.open(filename, flags),
      async lstat(filename) {
        if (pause && filename === copyPath) {
          entered.resolve();
          await release.promise;
        }
        return fs.promises.lstat(filename, { bigint: true });
      },
      realpath: (filename) => fs.promises.realpath(filename),
      effectiveUid: () => process.geteuid!(),
    };
    const controlled = controlledChild(61_616);
    const spawnCapability = vi.fn(() => controlled.spawned);
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: spawnCapability,
      killProcessGroup: vi.fn(),
      probeProcessGroupEmpty: () => true,
    }, dependencies);
    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    const launcher = adapter.createLauncher(TOKEN);
    pause = true;
    const pendingInspection = adapter.inspect(NEVER_ABORTED_SIGNAL);
    await entered.promise;
    await expect(launcher(
      command(authority),
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "process_adapter_invalid",
    });
    await expect(adapter.close()).rejects.toMatchObject({
      code: "cleanup_failed",
    });
    expect(spawnCapability).not.toHaveBeenCalled();
    release.resolve();
    await expect(pendingInspection).resolves.toEqual(authority);
    pause = false;
    const child = await launcher(command(authority), NEVER_ABORTED_SIGNAL);
    const write = child.writeStdin(Buffer.from(VALUE));
    controlled.writeCallbacks[0]!();
    controlled.endCallbacks[0]!();
    await write;
    controlled.emitter.emit("close", 0, null);
    await expect(child.closed).resolves.toMatchObject({
      exitCode: 0,
      signal: null,
    });
    expect(spawnCapability).toHaveBeenCalledOnce();
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it("ignores own AbortSignal getters and inherited array mutation hooks", async () => {
    const root = privateRoot();
    const bytes = "#!/bin/sh\nexit 0\n";
    const copyPath = writePrivateCopy(root, bytes);
    const controlled = controlledChild();
    const adapter = await openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256(bytes),
      spawn: () => controlled.spawned,
      killProcessGroup: vi.fn(),
      probeProcessGroupEmpty: () => true,
    });
    const authority = await adapter.inspect(NEVER_ABORTED_SIGNAL);
    const exactCommand = command(authority);
    const controller = new AbortController();
    const abortedGetter = vi.fn(() => {
      throw new Error("own aborted getter must not run");
    });
    Object.defineProperty(controller.signal, "aborted", {
      configurable: true,
      get: abortedGetter,
    });
    const priorPush = Object.getOwnPropertyDescriptor(Array.prototype, "push");
    const priorZero = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    const priorString = Object.getOwnPropertyDescriptor(globalThis, "String");
    let pushCalls = 0;
    let zeroSetterCalls = 0;
    const liveString = vi.fn(() => {
      throw new Error("live String constructor must not run");
    });
    Object.defineProperties(Array.prototype, {
      push: {
        configurable: true,
        value() {
          pushCalls += 1;
          throw new Error("live Array.push must not run");
        },
        writable: true,
      },
      0: {
        configurable: true,
        set() {
          zeroSetterCalls += 1;
          throw new Error("inherited numeric setter must not run");
        },
      },
    });
    Object.defineProperty(globalThis, "String", {
      configurable: true,
      value: liveString,
      writable: true,
    });
    let pending: ReturnType<
      ReturnType<typeof adapter.createLauncher>
    > | undefined;
    try {
      pending = adapter.createLauncher(TOKEN)(exactCommand, controller.signal);
    } finally {
      if (priorPush === undefined) Reflect.deleteProperty(Array.prototype, "push");
      else Object.defineProperty(Array.prototype, "push", priorPush);
      if (priorZero === undefined) Reflect.deleteProperty(Array.prototype, "0");
      else Object.defineProperty(Array.prototype, "0", priorZero);
      if (priorString === undefined) Reflect.deleteProperty(globalThis, "String");
      else Object.defineProperty(globalThis, "String", priorString);
    }
    const child = await pending!;
    const write = child.writeStdin(Buffer.from(VALUE));
    controlled.writeCallbacks[0]!();
    controlled.endCallbacks[0]!();
    await write;
    controlled.emitter.emit("close", 0, null);
    await expect(child.closed).resolves.toMatchObject({ exitCode: 0 });
    expect(abortedGetter).not.toHaveBeenCalled();
    expect(pushCalls).toBe(0);
    expect(zeroSetterCalls).toBe(0);
    expect(liveString).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("rejects non-private copy modes and wrong source digests before spawn", async () => {
    const root = privateRoot();
    const copyPath = writePrivateCopy(root, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(copyPath, 0o555);
    const spawnCapability = vi.fn();
    await expect(openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: sha256("#!/bin/sh\nexit 0\n"),
      spawn: spawnCapability,
      killProcessGroup: vi.fn(),
      probeProcessGroupEmpty: () => true,
    })).rejects.toMatchObject({ code: "process_adapter_invalid" });
    expect(spawnCapability).not.toHaveBeenCalled();

    fs.chmodSync(copyPath, 0o500);
    await expect(openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: copyPath,
      expectedSourceSha256: "a".repeat(64),
      spawn: spawnCapability,
      killProcessGroup: vi.fn(),
      probeProcessGroupEmpty: () => true,
    })).rejects.toMatchObject({ code: "process_adapter_invalid" });
    expect(spawnCapability).not.toHaveBeenCalled();
  });

  it("is unreachable from the hard-disabled public graph and exposes no native launcher", () => {
    const adapterSource = fs.readFileSync(path.resolve(
      "scripts/lib/permanent-staging-provider-variable-write-process-adapter.ts",
    ), "utf8");
    const publicCore = fs.readFileSync(path.resolve(
      "scripts/lib/permanent-staging-provider-variable-write-executor.ts",
    ), "utf8");
    const publicWrapper = fs.readFileSync(path.resolve(
      "scripts/execute-permanent-staging-provider-variable-write.ts",
    ), "utf8");
    const packageSource = fs.readFileSync(path.resolve("package.json"), "utf8");
    for (const forbidden of [
      "permanent-staging-provider-variable-write-executor",
      "locked-sensitive-worker",
      "node:child_process",
      "process.env",
      "fetch(",
      "package.json",
      ".github/",
    ]) expect(adapterSource).not.toContain(forbidden);
    expect(publicCore).not.toContain("process-adapter");
    expect(publicWrapper).not.toContain("process-adapter");
    expect(packageSource).not.toContain("provider-variable:process-adapter");
    expect(publicCore).toContain("HARD_DISABLED_REVIEW_REQUIRED");
  });
});
