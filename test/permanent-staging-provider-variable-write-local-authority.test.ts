import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  PermanentStagingProviderVariableWriteInputSource,
} from "../scripts/lib/permanent-staging-provider-variable-write-input.js";
import type {
  PermanentStagingProviderVariableName,
} from "../scripts/lib/permanent-staging-provider-variable-write-executor.js";
import type {
  PermanentStagingProviderVariableWriteCommand,
  PermanentStagingProviderVariableWriteInjectedChild,
  PermanentStagingProviderVariableWriteInjectedChildResult,
  PermanentStagingProviderVariableWriteLocalAuthorityDependencies,
  PermanentStagingProviderVariableWriteLocalAuthorityHandle,
  PermanentStagingProviderVariableWriteLocalInspection,
  PermanentStagingProviderVariableWriteProcessAdapterBinding,
} from "../scripts/lib/permanent-staging-provider-variable-write-local-authority.js";

interface LocalAuthorityModule {
  readonly PermanentStagingProviderVariableWriteLocalAuthorityError:
    typeof import("../scripts/lib/permanent-staging-provider-variable-write-local-authority.js")
      .PermanentStagingProviderVariableWriteLocalAuthorityError;
  readonly PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_COMMAND_SCHEMA: string;
  readonly PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCAL_AUTHORITY_SCHEMA:
    string;
  readonly PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCAL_RECEIPT_SCHEMA:
    string;
  readonly createPermanentStagingProviderVariableWriteLocalAttemptAuthority:
    typeof import("../scripts/lib/permanent-staging-provider-variable-write-local-authority.js")
      .createPermanentStagingProviderVariableWriteLocalAttemptAuthority;
  readonly openPermanentStagingProviderVariableWriteLocalAuthority: (
    processAdapterBinding:
      PermanentStagingProviderVariableWriteProcessAdapterBinding,
    dependencies?: PermanentStagingProviderVariableWriteLocalAuthorityDependencies,
  ) => Promise<PermanentStagingProviderVariableWriteLocalAuthorityHandle>;
}

interface InputModule {
  readonly PermanentStagingProviderVariableWriteInputError:
    typeof import("../scripts/lib/permanent-staging-provider-variable-write-input.js")
      .PermanentStagingProviderVariableWriteInputError;
  readonly readPermanentStagingProviderVariableWriteInput:
    typeof import("../scripts/lib/permanent-staging-provider-variable-write-input.js")
      .readPermanentStagingProviderVariableWriteInput;
}

const NEVER_ABORTED_SIGNAL = new AbortController().signal;
const TEST_BINARY_BYTES = Buffer.from(
  "isolated-fixture-bytes-that-are-never-executed\n",
  "utf8",
);
const TEST_BINARY_SHA256 = crypto.createHash("sha256")
  .update(TEST_BINARY_BYTES)
  .digest("hex");
const TEST_INTENT_SHA256 = "d".repeat(64);

let temporaryRoot = "";
let binaryPath = "";
let privateCopyPath = "";
let authorityModule: LocalAuthorityModule;
let inputModule: InputModule;
let adapterModule: typeof import(
  "../scripts/lib/permanent-staging-provider-variable-write-process-adapter.js"
);
let processAdapterHandle: import(
  "../scripts/lib/permanent-staging-provider-variable-write-process-adapter.js"
).PermanentStagingProviderVariableWriteProcessAdapterHandle;
let processAdapterBindingValue:
  PermanentStagingProviderVariableWriteProcessAdapterBinding;
const adapterHandles: Array<import(
  "../scripts/lib/permanent-staging-provider-variable-write-process-adapter.js"
).PermanentStagingProviderVariableWriteProcessAdapterHandle> = [];
const authoritySessions = new WeakMap<object, {
  readonly adapter: import(
    "../scripts/lib/permanent-staging-provider-variable-write-process-adapter.js"
  ).PermanentStagingProviderVariableWriteProcessAdapterHandle;
  child: PermanentStagingProviderVariableWriteInjectedChild | null;
  beforeSpawn: (() => void) | null;
  groupEmpty: boolean;
  spawnCalls: number;
}>();
const TEST_TOKEN = "offline-local-authority-token-never-sent";

function source(value: Buffer): PermanentStagingProviderVariableWriteInputSource {
  return {
    readExactlyOnce(consumeChunk, settle) {
      consumeChunk(value);
      settle();
    },
  };
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

function canonicalSha256(domain: string, value: unknown): string {
  return crypto.createHash("sha256")
    .update(`${domain}\0`, "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function processAdapterBinding():
PermanentStagingProviderVariableWriteProcessAdapterBinding {
  return processAdapterBindingValue;
}

function childResult(
  exitCode: number | null = 0,
  signal: NodeJS.Signals | null = null,
): PermanentStagingProviderVariableWriteInjectedChildResult {
  const binding = processAdapterBinding();
  const processAdapterReceipt = {
    schemaVersion:
      "pintpath-permanent-staging-provider-variable-write-process-adapter-receipt/v1",
    processAdapterAuthoritySha256: binding.processAdapterAuthoritySha256,
    privateExecutableCopyAuthoritySha256:
      binding.privateExecutableCopyAuthoritySha256,
    environmentAuthoritySha256: binding.environmentAuthoritySha256,
    stdinAuthoritySha256: binding.stdinAuthoritySha256,
    processGroupAuthoritySha256: binding.processGroupAuthoritySha256,
    childAttempts: 1,
    shell: false,
    environmentNullPrototype: true,
    environmentExactNames: Object.freeze(["RAILWAY_TOKEN"] as const),
    stdinWrites: 1,
    stdinWriteCompleted: true,
    stdinEof: true,
    stdoutBytesCaptured: 0,
    stderrBytesCaptured: 0,
    detachedProcessGroup: true,
    abortTermThenKill: true,
    processGroupReaped: true,
    processGroupEmpty: true,
    closeAndErrorSettled: true,
    exitCode,
    signal,
  } as const;
  return {
    exitCode,
    signal,
    processAdapterReceipt,
    processAdapterReceiptSha256: canonicalSha256(
      "pintpath/permanent-staging/provider-variable-write/process-receipt/v1",
      processAdapterReceipt,
    ),
  };
}

function restoreOwnProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
  } else {
    Object.defineProperty(target, key, descriptor);
  }
}

function fakeChild(options: {
  readonly result?: Pick<
    PermanentStagingProviderVariableWriteInjectedChildResult,
    "exitCode" | "signal"
  >;
  readonly writeFailure?: unknown;
  readonly settleOnAbort?: boolean;
} = {}): {
  readonly child: PermanentStagingProviderVariableWriteInjectedChild;
  readonly writes: Buffer[];
  readonly retainedWrites: Buffer[];
  readonly abort: ReturnType<typeof vi.fn>;
  readonly settle: () => void;
} {
  const close = deferred<PermanentStagingProviderVariableWriteInjectedChildResult>();
  const successfulResult = childResult(
    options.result === undefined ? 0 : options.result.exitCode,
    options.result === undefined ? null : options.result.signal,
  );
  const abortedResult = childResult(null, "SIGTERM");
  const pendingWrite = options.settleOnAbort ? deferred<void>() : undefined;
  const writes: Buffer[] = [];
  const retainedWrites: Buffer[] = [];
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    close.resolve(successfulResult);
  };
  const abort = vi.fn(() => {
    pendingWrite?.reject(new Error("fixture child aborted"));
    if (options.settleOnAbort) {
      setImmediate(() => {
        if (settled) return;
        settled = true;
        close.resolve(abortedResult);
      });
    }
  });
  return {
    writes,
    retainedWrites,
    abort,
    settle,
    child: {
      async writeStdin(value) {
        retainedWrites.push(value);
        writes.push(Buffer.from(value));
        if (options.writeFailure !== undefined) throw options.writeFailure;
        if (pendingWrite !== undefined) await pendingWrite.promise;
        else queueMicrotask(settle);
      },
      abort,
      closed: close.promise,
    },
  };
}

async function freshInput(value = "fixture-provider-value") {
  return await inputModule.readPermanentStagingProviderVariableWriteInput(
    "OPENAI_API_KEY",
    source(Buffer.from(value, "utf8")),
    NEVER_ABORTED_SIGNAL,
  );
}

async function freshAuthority(
  dependencies?: PermanentStagingProviderVariableWriteLocalAuthorityDependencies,
) {
  const session = {
    adapter: null as unknown as import(
      "../scripts/lib/permanent-staging-provider-variable-write-process-adapter.js"
    ).PermanentStagingProviderVariableWriteProcessAdapterHandle,
    child: null as PermanentStagingProviderVariableWriteInjectedChild | null,
    beforeSpawn: null as (() => void) | null,
    groupEmpty: false,
    spawnCalls: 0,
  };
  session.adapter = await adapterModule
    .openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: privateCopyPath,
      expectedSourceSha256: TEST_BINARY_SHA256,
      spawn: () => {
        session.spawnCalls += 1;
        session.beforeSpawn?.();
        const child = session.child;
        if (child === null) throw new Error("fixture launcher not armed");
        const emitter = new EventEmitter();
        const stdinEmitter = new EventEmitter();
        void child.closed.then((result) => {
          setImmediate(() => {
            session.groupEmpty = true;
            emitter.emit("close", result.exitCode, result.signal);
          });
        }, () => {
          setImmediate(() => {
            session.groupEmpty = true;
            emitter.emit("error");
            emitter.emit("close", null, "SIGTERM");
          });
        });
        return {
          pid: 31_337,
          stdin: {
            write(value: Buffer, callback: (error?: unknown) => void) {
              void child.writeStdin(value).then(
                () => callback(),
                (error) => callback(error),
              );
              return true;
            },
            end(callback: (error?: unknown) => void) {
              callback();
            },
            once: stdinEmitter.once.bind(stdinEmitter),
            removeListener: stdinEmitter.removeListener.bind(stdinEmitter),
          },
          once: emitter.once.bind(emitter),
          removeListener: emitter.removeListener.bind(emitter),
        };
      },
      killProcessGroup: () => {
        session.child?.abort();
      },
      probeProcessGroupEmpty: () => session.groupEmpty,
    });
  adapterHandles.push(session.adapter);
  processAdapterBindingValue = await session.adapter
    .inspectLocalAuthorityBinding(NEVER_ABORTED_SIGNAL);
  const authority = await authorityModule
    .openPermanentStagingProviderVariableWriteLocalAuthority(
      processAdapterBinding(),
      dependencies,
    );
  authoritySessions.set(authority, session);
  return authority;
}

function operationIdFor(variableName: PermanentStagingProviderVariableName): string {
  switch (variableName) {
    case "GOOGLE_MAPS_API_KEY":
      return "permanent-staging-provider-variable-create/google-maps-api-key";
    case "GOOGLE_MAPS_MAP_ID":
      return "permanent-staging-provider-variable-create/google-maps-map-id";
    case "GOOGLE_PLACES_API_KEY":
      return "permanent-staging-provider-variable-create/google-places-api-key";
    case "OPENAI_API_KEY":
      return "permanent-staging-provider-variable-create/openai-api-key";
  }
}

async function freshAttemptBinding(
  authority: PermanentStagingProviderVariableWriteLocalAuthorityHandle,
  input: Awaited<ReturnType<typeof freshInput>>,
  intentSha256 = TEST_INTENT_SHA256,
  variableName: PermanentStagingProviderVariableName = "OPENAI_API_KEY",
): Promise<Parameters<
  LocalAuthorityModule[
    "createPermanentStagingProviderVariableWriteLocalAttemptAuthority"
  ]
>[0]> {
  const inputInspection = input.inspect();
  const local = await authority.inspect(NEVER_ABORTED_SIGNAL);
  const command = authority.buildCreateOnlyCommand(variableName);
  return {
    operationId: operationIdFor(variableName),
    variableName,
    inputCommitmentSha256: inputInspection.commitmentSha256,
    inputByteLength: inputInspection.byteLength,
    intentSha256,
    localAuthoritySha256: canonicalSha256(
      "pintpath/permanent-staging/provider-variable-write/local-authority/v2",
      local,
    ),
    commandSha256: canonicalSha256(
      "pintpath/permanent-staging/provider-variable-write/command/v2",
      command,
    ),
    processAdapterAuthoritySha256: local.processAdapterAuthoritySha256,
    privateExecutableCopyAuthoritySha256:
      local.privateExecutableCopyAuthoritySha256,
    environmentAuthoritySha256: local.environmentAuthoritySha256,
    stdinAuthoritySha256: local.stdinAuthoritySha256,
    processGroupAuthoritySha256: local.processGroupAuthoritySha256,
  };
}

async function freshAttempt(
  authority: PermanentStagingProviderVariableWriteLocalAuthorityHandle,
  input: Awaited<ReturnType<typeof freshInput>>,
  intentSha256 = TEST_INTENT_SHA256,
  variableName: PermanentStagingProviderVariableName = "OPENAI_API_KEY",
) {
  return authorityModule
    .createPermanentStagingProviderVariableWriteLocalAttemptAuthority(
      await freshAttemptBinding(authority, input, intentSha256, variableName),
    );
}

function genuineLauncher(
  authority: PermanentStagingProviderVariableWriteLocalAuthorityHandle,
  child: PermanentStagingProviderVariableWriteInjectedChild,
  beforeSpawn: (() => void) | null = null,
) {
  const session = authoritySessions.get(authority);
  if (session === undefined) throw new Error("missing adapter session");
  session.child = child;
  session.beforeSpawn = beforeSpawn;
  session.groupEmpty = false;
  return session.adapter.createLauncher(TEST_TOKEN);
}

function spawnCallsFor(
  authority: PermanentStagingProviderVariableWriteLocalAuthorityHandle,
): number {
  const session = authoritySessions.get(authority);
  if (session === undefined) throw new Error("missing adapter session");
  return session.spawnCalls;
}

function realDependencies():
PermanentStagingProviderVariableWriteLocalAuthorityDependencies {
  return {
    open: (filename, flags) => fs.promises.open(filename, flags),
    lstat: (filename) => fs.promises.lstat(filename, { bigint: true }),
    realpath: (filename) => fs.promises.realpath(filename),
    effectiveUid: () => {
      if (typeof process.geteuid !== "function") throw new Error("no euid");
      return process.geteuid();
    },
  };
}

beforeAll(async () => {
  const createdRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pintpath-provider-variable-local-authority."),
  );
  temporaryRoot = await fs.promises.realpath(createdRoot);
  binaryPath = path.join(temporaryRoot, "railway-fixture-never-executed");
  privateCopyPath = path.join(temporaryRoot, "railway-private-copy-never-executed");
  await fs.promises.writeFile(binaryPath, TEST_BINARY_BYTES, {
    flag: "wx",
    mode: 0o555,
  });
  await fs.promises.chmod(binaryPath, 0o555);
  await fs.promises.writeFile(privateCopyPath, TEST_BINARY_BYTES, {
    flag: "wx",
    mode: 0o500,
  });
  await fs.promises.chmod(privateCopyPath, 0o500);

  vi.resetModules();
  vi.doMock(
    "../scripts/lib/permanent-staging-provider-variable-write-executor.js",
    () => {
      const operations = Object.freeze([
        Object.freeze({
          operationId:
            "permanent-staging-provider-variable-create/google-maps-api-key",
          variableName: "GOOGLE_MAPS_API_KEY",
        }),
        Object.freeze({
          operationId:
            "permanent-staging-provider-variable-create/google-maps-map-id",
          variableName: "GOOGLE_MAPS_MAP_ID",
        }),
        Object.freeze({
          operationId:
            "permanent-staging-provider-variable-create/google-places-api-key",
          variableName: "GOOGLE_PLACES_API_KEY",
        }),
        Object.freeze({
          operationId:
            "permanent-staging-provider-variable-create/openai-api-key",
          variableName: "OPENAI_API_KEY",
        }),
      ]);
      return {
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS: operations,
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK: Object.freeze({
          projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
          stagingEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
          serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
          railwayCli: Object.freeze({
            version: "5.32.0",
            absolutePath: binaryPath,
            sha256: TEST_BINARY_SHA256,
          }),
          writeContract: Object.freeze({ maximumValueBytes: 4_096 }),
        }),
      };
    },
  );
  authorityModule = await import(
    "../scripts/lib/permanent-staging-provider-variable-write-local-authority.js"
  ) as LocalAuthorityModule;
  adapterModule = await import(
    "../scripts/lib/permanent-staging-provider-variable-write-process-adapter.js"
  );
  processAdapterHandle = await adapterModule
    .openPermanentStagingProviderVariableWriteProcessAdapter({
      privateExecutableCopyPath: privateCopyPath,
      expectedSourceSha256: TEST_BINARY_SHA256,
      spawn: () => {
        throw new Error("local-authority fixture never spawns through adapter");
      },
      killProcessGroup: () => undefined,
      probeProcessGroupEmpty: () => true,
    });
  processAdapterBindingValue = await processAdapterHandle
    .inspectLocalAuthorityBinding(NEVER_ABORTED_SIGNAL);
  inputModule = await import(
    "../scripts/lib/permanent-staging-provider-variable-write-input.js"
  ) as InputModule;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of adapterHandles.splice(0)) {
    try {
      await handle.close();
    } catch {
      // The individual lifecycle test owns any expected adapter failure.
    }
  }
  try {
    await fs.promises.chmod(binaryPath, 0o755);
    await fs.promises.writeFile(binaryPath, TEST_BINARY_BYTES, { flag: "w" });
    await fs.promises.chmod(binaryPath, 0o555);
  } catch {
    // Individual tests must report their own fixture damage.
  }
});

afterAll(async () => {
  await processAdapterHandle.close();
  vi.doUnmock(
    "../scripts/lib/permanent-staging-provider-variable-write-executor.js",
  );
  vi.resetModules();
  if (temporaryRoot.length > 0) {
    await fs.promises.chmod(binaryPath, 0o755);
    await fs.promises.rm(temporaryRoot, { recursive: true, force: false });
  }
});

describe("permanent staging provider-variable local authority", () => {
  it("rejects an unbranded self-consistent process-adapter binding before filesystem access", async () => {
    const genuine = processAdapterBinding();
    const forged = Object.freeze({
      ...genuine,
    }) as PermanentStagingProviderVariableWriteProcessAdapterBinding;
    const raw = realDependencies();
    const dependencies = {
      open: vi.fn(raw.open),
      lstat: vi.fn(raw.lstat),
      realpath: vi.fn(raw.realpath),
      effectiveUid: vi.fn(raw.effectiveUid),
    };
    await expect(authorityModule
      .openPermanentStagingProviderVariableWriteLocalAuthority(
        forged,
        dependencies,
      )).rejects.toMatchObject({
      code: "local_authority_invalid",
      message: "local_authority_invalid",
    });
    expect(dependencies.effectiveUid).not.toHaveBeenCalled();
    expect(dependencies.lstat).not.toHaveBeenCalled();
    expect(dependencies.realpath).not.toHaveBeenCalled();
    expect(dependencies.open).not.toHaveBeenCalled();
  });

  it("holds and repeatedly hashes one exact regular non-writable binary descriptor", async () => {
    const authority = await freshAuthority();
    const inspection = await authority.inspect(NEVER_ABORTED_SIGNAL);
    expect(inspection).toMatchObject({
      schemaVersion:
        "pintpath-permanent-staging-provider-variable-write-local-authority/v2",
      railwayCliVersion: "5.32.0",
      railwayCliAbsolutePath: binaryPath,
      railwayCliSha256: TEST_BINARY_SHA256,
      railwayCliBytes: TEST_BINARY_BYTES.length,
      railwayCliIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      absoluteCanonicalNonSymlinkPath: true,
      regularFile: true,
      currentUid: true,
      mode0555: true,
      nlinkOne: true,
      descriptorHeld: true,
      pathAndDescriptorIdentityExact: true,
      bytesHashedFromHeldDescriptor: true,
      privateExecutableCopyAbsolutePath: privateCopyPath,
      privateExecutableCopySha256: TEST_BINARY_SHA256,
      privateExecutableCopyBytes: TEST_BINARY_BYTES.length,
      privateExecutableCopyIdentitySha256:
        processAdapterBinding().privateExecutableCopyIdentitySha256,
      privateExecutableCopyAuthoritySha256:
        processAdapterBinding().privateExecutableCopyAuthoritySha256,
      environmentAuthoritySha256:
        processAdapterBinding().environmentAuthoritySha256,
      stdinAuthoritySha256: processAdapterBinding().stdinAuthoritySha256,
      processGroupAuthoritySha256:
        processAdapterBinding().processGroupAuthoritySha256,
      processAdapterAuthoritySha256:
        processAdapterBinding().processAdapterAuthoritySha256,
      privateExecutableCopyDescriptorHeld: true,
      privateExecutableCopyParentMode0700: true,
      processAdapterInjectedSpawnOnly: true,
      providerInvokedDuringInspection: false,
    } satisfies Partial<PermanentStagingProviderVariableWriteLocalInspection>);
    expect(Object.isFrozen(inspection)).toBe(true);
    await expect(authority.reassert(NEVER_ABORTED_SIGNAL)).resolves.toEqual(
      inspection,
    );
    await authority.close();
    await authority.close();
  });

  it("rejects a non-regular mode before open without Stats helper dispatch", async () => {
    const dependencies = realDependencies();
    const open = vi.fn(dependencies.open);
    const statsPrototype = fs.Stats.prototype as object;
    const originalCheckMode = Object.getOwnPropertyDescriptor(
      statsPrototype,
      "_checkModeProperty",
    );
    const poisonedCheckMode = vi.fn(() => true);
    Object.defineProperty(statsPrototype, "_checkModeProperty", {
      ...originalCheckMode,
      value: poisonedCheckMode,
    });
    let failure: unknown;
    try {
      await freshAuthority({
        ...dependencies,
        open,
        async lstat(filename) {
          const stat = await dependencies.lstat(filename);
          Object.defineProperty(stat, "mode", {
            ...Object.getOwnPropertyDescriptor(stat, "mode"),
            value: (stat.mode & ~BigInt(fs.constants.S_IFMT))
              | BigInt(fs.constants.S_IFDIR),
          });
          return stat;
        },
      });
    } catch (error) {
      failure = error;
    } finally {
      restoreOwnProperty(
        statsPrototype,
        "_checkModeProperty",
        originalCheckMode,
      );
    }
    expect(failure).toMatchObject({
      code: "local_authority_invalid",
      message: "local_authority_invalid",
    });
    expect(open).not.toHaveBeenCalled();
    expect(poisonedCheckMode).not.toHaveBeenCalled();
  });

  it("builds one frozen absolute create-only argv and a name-only minimal environment contract", async () => {
    const authority = await freshAuthority();
    const command = authority.buildCreateOnlyCommand("OPENAI_API_KEY");
    expect(command).toEqual({
      schemaVersion:
        "pintpath-permanent-staging-provider-variable-write-command/v2",
      executable: privateCopyPath,
      executableAuthority: {
        privateExecutableCopySha256: TEST_BINARY_SHA256,
        privateExecutableCopyIdentitySha256:
          processAdapterBinding().privateExecutableCopyIdentitySha256,
        privateExecutableCopyAuthoritySha256:
          processAdapterBinding().privateExecutableCopyAuthoritySha256,
        descriptorHeld: true,
      },
      argv: [
        "variable",
        "set",
        "OPENAI_API_KEY",
        "--stdin",
        "--skip-deploys",
        "--project",
        "48d8c6cd-1c66-4148-874b-20877f48e1a5",
        "--environment",
        "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
        "--service",
        "6816c4a2-e392-4ee5-826f-2584cb599ec0",
      ],
      environment: {
        inherit: false,
        prototype: "null",
        ownEnumerableDataPropertiesOnly: true,
        exactNames: ["RAILWAY_TOKEN"],
        valuesHandledByThisModule: false,
      },
      shell: false,
      stdin: "pipe",
      stdinWrites: 1,
      stdinEndCalls: 1,
      stdout: "ignore",
      stderr: "ignore",
      maximumCapturedStdoutBytes: 0,
      maximumCapturedStderrBytes: 0,
      detached: true,
      abortSignalSequence: ["SIGTERM", "SIGKILL"],
      processGroupEmptyBeforeSettlement: true,
    });
    expect(command.argv).not.toContain("--json");
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.argv)).toBe(true);
    expect(Object.isFrozen(command.environment)).toBe(true);
    expect(Object.isFrozen(command.environment.exactNames)).toBe(true);
    expect(JSON.stringify(command)).not.toContain("fixture-provider-value");
    expect(() => authority.buildCreateOnlyCommand(
      "DATABASE_URL" as "OPENAI_API_KEY",
    )).toThrow(expect.objectContaining({ code: "local_authority_invalid" }));
    await authority.close();
  });

  it("reasserts binary authority, makes one injected child attempt, discards output, and awaits close", async () => {
    const authority = await freshAuthority();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const input = await freshInput();
    const fixture = fakeChild();
    const launch = genuineLauncher(authority, fixture.child);

    const receipt = await authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      input,
      TEST_INTENT_SHA256,
      await freshAttempt(authority, input),
      launch,
      NEVER_ABORTED_SIGNAL,
    );
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]!.toString("utf8")).toBe("fixture-provider-value");
    expect(fixture.retainedWrites[0]!.equals(
      Buffer.alloc(fixture.retainedWrites[0]!.length),
    )).toBe(true);
    expect(fixture.abort).not.toHaveBeenCalled();
    expect(receipt).toEqual({
      schemaVersion:
        "pintpath-permanent-staging-provider-variable-write-local-receipt/v3",
      variableName: "OPENAI_API_KEY",
      inputCommitmentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      intentSha256: TEST_INTENT_SHA256,
      localAuthoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      commandSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      processAdapterAuthoritySha256:
        processAdapterBinding().processAdapterAuthoritySha256,
      privateExecutableCopyAuthoritySha256:
        processAdapterBinding().privateExecutableCopyAuthoritySha256,
      environmentAuthoritySha256:
        processAdapterBinding().environmentAuthoritySha256,
      stdinAuthoritySha256: processAdapterBinding().stdinAuthoritySha256,
      processGroupAuthoritySha256:
        processAdapterBinding().processGroupAuthoritySha256,
      processAdapterReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      childAttempts: 1,
      stdinWrites: 1,
      exitCode: 0,
      signal: null,
      stdoutBytesCaptured: 0,
      stderrBytesCaptured: 0,
      childCloseAwaited: true,
      environmentNullPrototype: true,
      stdinWriteCompleted: true,
      stdinEof: true,
      detachedProcessGroup: true,
      processGroupEmpty: true,
      closeAndErrorSettled: true,
      providerAcknowledgementInspected: false,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    await expect(authority.reassert(NEVER_ABORTED_SIGNAL)).resolves.toEqual(
      expect.objectContaining({ railwayCliSha256: TEST_BINARY_SHA256 }),
    );
    const secondInput = await freshInput("second");
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      secondInput,
      TEST_INTENT_SHA256,
      await freshAttempt(authority, secondInput),
      launch,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({ code: "local_authority_invalid" });
    await authority.close();
  });

  it("rejects a non-exact durable intent digest before the child attempt", async () => {
    const authority = await freshAuthority();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const input = await freshInput();
    const fixture = fakeChild();
    const launch = genuineLauncher(authority, fixture.child);
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      input,
      "D".repeat(64),
      await freshAttempt(authority, input),
      launch,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({ code: "local_authority_invalid" });
    expect(fixture.writes).toHaveLength(0);
    input.close();
    await authority.close();
  });

  it("uses captured hash primitives after an input source poisons live Hash methods", async () => {
    const authority = await freshAuthority();
    const fixture = fakeChild();
    const inspection = await authority.inspect(NEVER_ABORTED_SIGNAL);
    const command = authority.buildCreateOnlyCommand("OPENAI_API_KEY");
    const expectedLocalAuthoritySha256 = canonicalSha256(
      "pintpath/permanent-staging/provider-variable-write/local-authority/v2",
      inspection,
    );
    const expectedCommandSha256 = canonicalSha256(
      "pintpath/permanent-staging/provider-variable-write/command/v2",
      command,
    );
    const hashPrototype = Object.getPrototypeOf(
      crypto.createHash("sha256"),
    ) as object;
    const originalUpdate = Object.getOwnPropertyDescriptor(
      hashPrototype,
      "update",
    );
    const originalDigest = Object.getOwnPropertyDescriptor(
      hashPrototype,
      "digest",
    );
    const poisonedUpdate = vi.fn(() => {
      throw new Error("live Hash.update must not be reached");
    });
    const poisonedDigest = vi.fn(() => {
      throw new Error("live Hash.digest must not be reached");
    });
    const attemptInput = await freshInput();
    const attempt = await freshAttempt(authority, attemptInput);
    attemptInput.close();
    let receipt: Awaited<ReturnType<
      PermanentStagingProviderVariableWriteLocalAuthorityHandle[
        "writeExactlyOnceWithInjectedChild"
      ]
    >> | undefined;
    let failure: unknown;
    try {
      const input = await inputModule
        .readPermanentStagingProviderVariableWriteInput(
          "OPENAI_API_KEY",
          {
            readExactlyOnce(consumeChunk, settle) {
              Object.defineProperties(hashPrototype, {
                update: {
                  ...originalUpdate,
                  value: poisonedUpdate,
                },
                digest: {
                  ...originalDigest,
                  value: poisonedDigest,
                },
              });
              consumeChunk(Buffer.from("fixture-provider-value", "utf8"));
              settle();
            },
          },
          NEVER_ABORTED_SIGNAL,
        );
      receipt = await authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        TEST_INTENT_SHA256,
        attempt,
        genuineLauncher(authority, fixture.child),
        NEVER_ABORTED_SIGNAL,
      );
    } catch (error) {
      failure = error;
    } finally {
      restoreOwnProperty(hashPrototype, "update", originalUpdate);
      restoreOwnProperty(hashPrototype, "digest", originalDigest);
      await authority.close();
    }
    expect(failure).toBeUndefined();
    expect(poisonedUpdate).not.toHaveBeenCalled();
    expect(poisonedDigest).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      localAuthoritySha256: expectedLocalAuthoritySha256,
      commandSha256: expectedCommandSha256,
    });
  });

  it("rejects an unbranded launcher before accepting its recomputable result", async () => {
    const authority = await freshAuthority();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const original = childResult();
    const processAdapterReceipt = {
      ...original.processAdapterReceipt,
      processGroupAuthoritySha256: "f".repeat(64),
    };
    const forgedResult = {
      exitCode: 0,
      signal: null,
      processAdapterReceipt,
      processAdapterReceiptSha256: canonicalSha256(
        "pintpath/permanent-staging/provider-variable-write/process-receipt/v1",
        processAdapterReceipt,
      ),
    } as unknown as PermanentStagingProviderVariableWriteInjectedChildResult;
    const child: PermanentStagingProviderVariableWriteInjectedChild = {
      async writeStdin() {},
      abort: vi.fn(),
      closed: Promise.resolve(forgedResult),
    };
    const launch = vi.fn(() => child);
    const input = await freshInput();
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      input,
      TEST_INTENT_SHA256,
      await freshAttempt(authority, input),
      launch,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "local_authority_invalid",
      message: "local_authority_invalid",
    });
    expect(launch).not.toHaveBeenCalled();
    expect(() => input.inspect()).toThrow(expect.objectContaining({
      code: "input_unavailable",
    }));
    await authority.close();
  });

  it("rejects every fresh-attempt tuple mismatch before spawn and wipes input", async () => {
    const cases = [
      "operation-variable",
      "input-commitment",
      "input-length",
      "intent",
      "local",
      "command",
      "process-adapter",
      "private-copy",
      "environment",
      "stdin",
      "process-group",
    ] as const;
    for (const mismatch of cases) {
      const authority = await freshAuthority();
      await authority.inspect(NEVER_ABORTED_SIGNAL);
      const input = await freshInput();
      const binding = await freshAttemptBinding(authority, input);
      const mismatched = (() => {
        switch (mismatch) {
          case "operation-variable":
            return {
              ...binding,
              operationId:
                "permanent-staging-provider-variable-create/google-maps-api-key",
              variableName: "GOOGLE_MAPS_API_KEY" as const,
            };
          case "input-commitment":
            return { ...binding, inputCommitmentSha256: "e".repeat(64) };
          case "input-length":
            return { ...binding, inputByteLength: binding.inputByteLength + 1 };
          case "intent":
            return { ...binding, intentSha256: "e".repeat(64) };
          case "local":
            return { ...binding, localAuthoritySha256: "e".repeat(64) };
          case "command":
            return { ...binding, commandSha256: "e".repeat(64) };
          case "process-adapter":
            return { ...binding, processAdapterAuthoritySha256: "e".repeat(64) };
          case "private-copy":
            return {
              ...binding,
              privateExecutableCopyAuthoritySha256: "e".repeat(64),
            };
          case "environment":
            return { ...binding, environmentAuthoritySha256: "e".repeat(64) };
          case "stdin":
            return { ...binding, stdinAuthoritySha256: "e".repeat(64) };
          case "process-group":
            return { ...binding, processGroupAuthoritySha256: "e".repeat(64) };
        }
      })();
      const attempt = authorityModule
        .createPermanentStagingProviderVariableWriteLocalAttemptAuthority(
          mismatched,
        );
      const fixture = fakeChild();
      const launcher = genuineLauncher(authority, fixture.child);
      await expect(authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        TEST_INTENT_SHA256,
        attempt,
        launcher,
        NEVER_ABORTED_SIGNAL,
      )).rejects.toMatchObject({
        code: "local_authority_invalid",
        message: "local_authority_invalid",
      });
      expect(spawnCallsFor(authority)).toBe(0);
      expect(fixture.writes).toHaveLength(0);
      expect(() => input.inspect()).toThrow(expect.objectContaining({
        code: "input_unavailable",
      }));
      await authority.close();
    }
  });

  it("rejects launcher wrappers and equal-digest cross-adapter launchers", async () => {
    for (const mode of ["wrapper", "cross-adapter"] as const) {
      const authority = await freshAuthority();
      await authority.inspect(NEVER_ABORTED_SIGNAL);
      const input = await freshInput();
      const attempt = await freshAttempt(authority, input);
      const fixture = fakeChild();
      const exactLauncher = genuineLauncher(authority, fixture.child);
      let observedAuthority = authority;
      let launcher: typeof exactLauncher;
      if (mode === "wrapper") {
        launcher = (...args) => exactLauncher(...args);
      } else {
        const otherAuthority = await freshAuthority();
        observedAuthority = otherAuthority;
        await otherAuthority.inspect(NEVER_ABORTED_SIGNAL);
        launcher = genuineLauncher(otherAuthority, fakeChild().child);
      }
      await expect(authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        TEST_INTENT_SHA256,
        attempt,
        launcher,
        NEVER_ABORTED_SIGNAL,
      )).rejects.toMatchObject({
        code: "local_authority_invalid",
      });
      expect(spawnCallsFor(authority)).toBe(0);
      expect(spawnCallsFor(observedAuthority)).toBe(0);
      expect(fixture.writes).toHaveLength(0);
      expect(() => input.inspect()).toThrow(expect.objectContaining({
        code: "input_unavailable",
      }));
      await authority.close();
      if (observedAuthority !== authority) await observedAuthority.close();
    }
  });

  it("does not dispatch inherited toJSON while hashing local evidence", async () => {
    const authority = await freshAuthority();
    const fixture = fakeChild();
    const inspection = await authority.inspect(NEVER_ABORTED_SIGNAL);
    const command = authority.buildCreateOnlyCommand("OPENAI_API_KEY");
    const expectedLocalAuthoritySha256 = canonicalSha256(
      "pintpath/permanent-staging/provider-variable-write/local-authority/v2",
      inspection,
    );
    const expectedCommandSha256 = canonicalSha256(
      "pintpath/permanent-staging/provider-variable-write/command/v2",
      command,
    );
    const originalToJSON = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    const poisonedToJSON = vi.fn(() => ({
      railwayCliSha256: "0".repeat(64),
    }));
    const attemptInput = await freshInput();
    const attempt = await freshAttempt(authority, attemptInput);
    attemptInput.close();
    let receipt: Awaited<ReturnType<
      PermanentStagingProviderVariableWriteLocalAuthorityHandle[
        "writeExactlyOnceWithInjectedChild"
      ]
    >> | undefined;
    let failure: unknown;
    try {
      const input = await inputModule
        .readPermanentStagingProviderVariableWriteInput(
          "OPENAI_API_KEY",
          {
            readExactlyOnce(consumeChunk, settle) {
              Object.defineProperty(Object.prototype, "toJSON", {
                configurable: true,
                enumerable: false,
                value: poisonedToJSON,
                writable: true,
              });
              consumeChunk(Buffer.from("fixture-provider-value", "utf8"));
              settle();
            },
          },
          NEVER_ABORTED_SIGNAL,
        );
      receipt = await authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        TEST_INTENT_SHA256,
        attempt,
        genuineLauncher(authority, fixture.child),
        NEVER_ABORTED_SIGNAL,
      );
    } catch (error) {
      failure = error;
    } finally {
      restoreOwnProperty(Object.prototype, "toJSON", originalToJSON);
      await authority.close();
    }
    expect(failure).toBeUndefined();
    expect(poisonedToJSON).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      localAuthoritySha256: expectedLocalAuthoritySha256,
      commandSha256: expectedCommandSha256,
    });
  });

  it("uses captured byte, stat, filesystem, path, and regex primitives", async () => {
    const authority = await freshAuthority();
    const successfulChildResult = childResult();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const probeHandle = await fs.promises.open(binaryPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as object;
    await probeHandle.close();
    const statsBasePrototype = Object.getPrototypeOf(fs.Stats.prototype) as
      object;
    const realpathExact = fs.realpath;
    const targets: readonly (readonly [object, PropertyKey])[] = [
      [Buffer, "alloc"],
      [Buffer, "byteLength"],
      [Buffer.prototype, "fill"],
      [Buffer.prototype, "subarray"],
      [fileHandlePrototype, "read"],
      [fileHandlePrototype, "stat"],
      [fs.promises, "lstat"],
      [fs.promises, "realpath"],
      [fs, "realpath"],
      [realpathExact, "native"],
      [path, "isAbsolute"],
      [path, "normalize"],
      [path, "parse"],
      [path, "resolve"],
      [RegExp.prototype, "exec"],
      [RegExp.prototype, "test"],
      [fs.Stats.prototype, "_checkModeProperty"],
      [statsBasePrototype, "isFile"],
    ];
    const originals = targets.map(([target, key]) =>
      Object.getOwnPropertyDescriptor(target, key));
    const poison = vi.fn(() => {
      throw new Error("live primitive must not be reached");
    });
    let receipt: unknown;
    let failure: unknown;
    try {
      const input = await inputModule
        .readPermanentStagingProviderVariableWriteInput(
          "OPENAI_API_KEY",
          source(Buffer.from("fixture-provider-value", "utf8")),
          NEVER_ABORTED_SIGNAL,
        );
      const attempt = await freshAttempt(authority, input);
      for (let index = 0; index < targets.length; index += 1) {
        const [target, key] = targets[index]!;
        Object.defineProperty(target, key, {
          ...originals[index],
          value: poison,
        });
      }
      receipt = await authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        TEST_INTENT_SHA256,
        attempt,
        genuineLauncher(authority, {
          async writeStdin() {},
          abort: vi.fn(),
          closed: Promise.resolve(successfulChildResult),
        }),
        NEVER_ABORTED_SIGNAL,
      );
    } catch (error) {
      failure = error;
    } finally {
      for (let index = 0; index < targets.length; index += 1) {
        const [target, key] = targets[index]!;
        restoreOwnProperty(target, key, originals[index]);
      }
      await authority.close();
    }
    expect(poison).not.toHaveBeenCalled();
    expect(failure).toBeUndefined();
    expect(receipt).toMatchObject({
      localAuthoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      commandSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("does not dispatch live Buffer view accessors while hashing or wiping", async () => {
    const authority = await freshAuthority();
    const successfulChildResult = childResult();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const input = await freshInput();
    const typedArrayPrototype = Object.getPrototypeOf(
      Uint8Array.prototype,
    ) as object;
    const keys = ["buffer", "byteOffset", "length"] as const;
    const originals = keys.map((key) =>
      Object.getOwnPropertyDescriptor(Buffer.prototype, key));
    const accessors = keys.map((key) => {
      const intrinsic = Object.getOwnPropertyDescriptor(
        typedArrayPrototype,
        key,
      )?.get;
      if (typeof intrinsic !== "function") {
        throw new Error(`missing typed-array ${key} getter`);
      }
      return vi.fn(function (this: Buffer) {
        return Reflect.apply(intrinsic, this, []);
      });
    });
    let receipt: unknown;
    let failure: unknown;
    try {
      for (let index = 0; index < keys.length; index += 1) {
        Object.defineProperty(Buffer.prototype, keys[index]!, {
          configurable: true,
          get: accessors[index],
        });
      }
      receipt = await authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        TEST_INTENT_SHA256,
        await freshAttempt(authority, input),
        genuineLauncher(authority, {
          async writeStdin() {},
          abort: vi.fn(),
          closed: Promise.resolve(successfulChildResult),
        }),
        NEVER_ABORTED_SIGNAL,
      );
    } catch (error) {
      failure = error;
    } finally {
      for (let index = 0; index < keys.length; index += 1) {
        restoreOwnProperty(
          Buffer.prototype,
          keys[index]!,
          originals[index],
        );
      }
      await authority.close();
    }
    expect(failure).toBeUndefined();
    expect(receipt).toMatchObject({ childCloseAwaited: true });
    for (const accessor of accessors) expect(accessor).not.toHaveBeenCalled();
  });

  it("does not dispatch Buffer constructor or species while hashing", async () => {
    const authority = await freshAuthority();
    const successfulChildResult = childResult();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const input = await freshInput();
    const originalConstructor = Object.getOwnPropertyDescriptor(
      Buffer.prototype,
      "constructor",
    );
    const originalSpecies = Object.getOwnPropertyDescriptor(
      Buffer,
      Symbol.species,
    );
    const constructorGetter = vi.fn(() => Buffer);
    const speciesGetter = vi.fn(() => class SubstitutedBytes
      extends Uint8Array {
      constructor(length: number) {
        super(length);
        for (let index = 0; index < length; index += 1) this[index] = 0x41;
      }
    });
    let receipt: unknown;
    let failure: unknown;
    try {
      Object.defineProperty(Buffer.prototype, "constructor", {
        configurable: true,
        get: constructorGetter,
      });
      Object.defineProperty(Buffer, Symbol.species, {
        configurable: true,
        get: speciesGetter,
      });
      receipt = await authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        TEST_INTENT_SHA256,
        await freshAttempt(authority, input),
        genuineLauncher(authority, {
          async writeStdin() {},
          abort: vi.fn(),
          closed: Promise.resolve(successfulChildResult),
        }),
        NEVER_ABORTED_SIGNAL,
      );
    } catch (error) {
      failure = error;
    } finally {
      restoreOwnProperty(
        Buffer.prototype,
        "constructor",
        originalConstructor,
      );
      restoreOwnProperty(Buffer, Symbol.species, originalSpecies);
      await authority.close();
    }
    expect(failure).toBeUndefined();
    expect(receipt).toMatchObject({ childCloseAwaited: true });
    expect(constructorGetter).not.toHaveBeenCalled();
    expect(speciesGetter).not.toHaveBeenCalled();
  });

  it("uses captured AbortSignal and EventTarget primitives through cleanup", async () => {
    const authority = await freshAuthority();
    const successfulChildResult = childResult();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const input = await freshInput();
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAborted = Object.getOwnPropertyDescriptor(signal, "aborted");
    const originalAdd = Object.getOwnPropertyDescriptor(
      signal,
      "addEventListener",
    );
    const originalRemove = Object.getOwnPropertyDescriptor(
      signal,
      "removeEventListener",
    );
    const poisonedAborted = vi.fn(() => {
      throw new Error("own aborted getter must not run");
    });
    const poisonedAdd = vi.fn(() => {
      throw new Error("own addEventListener must not run");
    });
    const poisonedRemove = vi.fn(() => {
      throw new Error("own removeEventListener must not run");
    });
    Object.defineProperties(signal, {
      aborted: { configurable: true, get: poisonedAborted },
      addEventListener: {
        configurable: true,
        value: poisonedAdd,
        writable: true,
      },
    });
    const child: PermanentStagingProviderVariableWriteInjectedChild = {
      async writeStdin() {
        Object.defineProperty(signal, "removeEventListener", {
          configurable: true,
          value: poisonedRemove,
          writable: true,
        });
      },
      abort: vi.fn(),
      closed: Promise.resolve(successfulChildResult),
    };
    let receipt: unknown;
    let failure: unknown;
    try {
      receipt = await authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        TEST_INTENT_SHA256,
        await freshAttempt(authority, input),
        genuineLauncher(authority, child),
        signal,
      );
    } catch (error) {
      failure = error;
    } finally {
      restoreOwnProperty(signal, "aborted", originalAborted);
      restoreOwnProperty(signal, "addEventListener", originalAdd);
      restoreOwnProperty(signal, "removeEventListener", originalRemove);
      await authority.close();
    }
    expect(poisonedAborted).not.toHaveBeenCalled();
    expect(poisonedAdd).not.toHaveBeenCalled();
    expect(poisonedRemove).not.toHaveBeenCalled();
    expect(failure).toBeUndefined();
    expect(receipt).toMatchObject({ childCloseAwaited: true });
  });

  it("uses the captured Object prototype after global Object replacement", async () => {
    const authority = await freshAuthority();
    try {
      await authority.inspect(NEVER_ABORTED_SIGNAL);
      const input = await freshInput();
      const attemptBinding = await freshAttemptBinding(authority, input);
      const priorObject = Object.getOwnPropertyDescriptor(globalThis, "Object");
      const defineProperty = Object.defineProperty;
      let prototypeGetterCalls = 0;
      const prototypeGetter = () => {
        prototypeGetterCalls += 1;
        throw new Error("live Object.prototype must not be reached");
      };
      const replacement = Object.create(null) as Record<PropertyKey, unknown>;
      defineProperty(replacement, "prototype", {
        configurable: true,
        get: prototypeGetter,
      });
      let attempt: ReturnType<
        LocalAuthorityModule[
          "createPermanentStagingProviderVariableWriteLocalAttemptAuthority"
        ]
      >;
      try {
        Reflect.defineProperty(globalThis, "Object", {
          configurable: true,
          value: replacement,
          writable: true,
        });
        attempt = authorityModule
          .createPermanentStagingProviderVariableWriteLocalAttemptAuthority(
            attemptBinding,
          );
      } finally {
        if (priorObject === undefined) {
          Reflect.deleteProperty(globalThis, "Object");
        } else {
          Reflect.defineProperty(globalThis, "Object", priorObject);
        }
      }
      expect(prototypeGetterCalls).toBe(0);

      const receipt = await authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        TEST_INTENT_SHA256,
        attempt,
        genuineLauncher(authority, fakeChild().child),
        NEVER_ABORTED_SIGNAL,
      );
      expect(receipt).toMatchObject({ childCloseAwaited: true });
    } finally {
      await authority.close();
    }
  });

  it("makes genuine branded input cleanup failure dominate child success", async () => {
    const authority = await freshAuthority();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const abort = vi.fn();
    let detached = false;
    const child: PermanentStagingProviderVariableWriteInjectedChild = {
      async writeStdin(value) {
        structuredClone(value.buffer, { transfer: [value.buffer] });
        detached = value.byteLength === 0;
      },
      abort,
      closed: Promise.resolve({ exitCode: 0, signal: null }),
    };
    const input = await freshInput();
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      input,
      TEST_INTENT_SHA256,
      await freshAttempt(authority, input),
      genuineLauncher(authority, child),
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "cleanup_failed",
      message: "cleanup_failed",
    });
    expect(detached).toBe(true);
    await expect(authority.close()).rejects.toMatchObject({
      code: "cleanup_failed",
      message: "cleanup_failed",
    });
  });

  it("returns fresh fixed errors without dispatching poisoned prototype setters", async () => {
    const ErrorConstructor = authorityModule
      .PermanentStagingProviderVariableWriteLocalAuthorityError;
    const prototype = ErrorConstructor.prototype;
    const originalName = Object.getOwnPropertyDescriptor(prototype, "name");
    const originalCode = Object.getOwnPropertyDescriptor(prototype, "code");
    const nameSetter = vi.fn();
    const codeSetter = vi.fn();
    Object.defineProperties(prototype, {
      name: { configurable: true, set: nameSetter },
      code: { configurable: true, set: codeSetter },
    });
    let failure: unknown;
    try {
      const dependencies = realDependencies();
      await freshAuthority({
        ...dependencies,
        effectiveUid: () => -1,
      });
    } catch (error) {
      failure = error;
    } finally {
      restoreOwnProperty(prototype, "name", originalName);
      restoreOwnProperty(prototype, "code", originalCode);
    }
    expect(nameSetter).not.toHaveBeenCalled();
    expect(codeSetter).not.toHaveBeenCalled();
    expect(failure).toMatchObject({
      name: "PermanentStagingProviderVariableWriteLocalAuthorityError",
      code: "local_authority_invalid",
      message: "local_authority_invalid",
    });
    const forged = new ErrorConstructor("cleanup_failed");
    Object.defineProperties(forged, {
      code: { configurable: true, value: "write_failed" },
      message: { configurable: true, value: "secret-bearing-forgery" },
    });
    const dependencies = realDependencies();
    let normalized: unknown;
    try {
      await freshAuthority({
        ...dependencies,
        effectiveUid: () => {
          throw forged;
        },
      });
    } catch (error) {
      normalized = error;
    }
    expect(normalized).not.toBe(forged);
    expect(normalized).toMatchObject({
      name: "PermanentStagingProviderVariableWriteLocalAuthorityError",
      code: "local_authority_invalid",
      message: "local_authority_invalid",
    });
  });

  it("fails closed on path/stat/hash drift before launching a child", async () => {
    const authority = await freshAuthority();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const input = await freshInput();
    const attempt = await freshAttempt(authority, input);
    await fs.promises.chmod(binaryPath, 0o755);
    await fs.promises.writeFile(binaryPath, "drifted-never-executed\n", {
      flag: "w",
    });
    await fs.promises.chmod(binaryPath, 0o555);
    const fixture = fakeChild();
    const launch = genuineLauncher(authority, fixture.child);
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      input,
      TEST_INTENT_SHA256,
      attempt,
      launch,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({ code: "local_authority_invalid" });
    expect(fixture.writes).toHaveLength(0);
    expect(() => input.inspect()).toThrow(expect.objectContaining({
      code: "input_unavailable",
    }));
    await authority.close();
  });

  it("treats nonzero close and synchronous launch failure as terminal one-attempt failures", async () => {
    for (const mode of ["nonzero", "spawn_failure"] as const) {
      const authority = await freshAuthority();
      await authority.inspect(NEVER_ABORTED_SIGNAL);
      const input = await freshInput();
      const fixture = fakeChild({ result: { exitCode: 7, signal: null } });
      const launch = genuineLauncher(
        authority,
        fixture.child,
        mode === "spawn_failure"
          ? () => { throw new Error("fixture spawn failure with unsafe output"); }
          : null,
      );
      await expect(authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        TEST_INTENT_SHA256,
        await freshAttempt(authority, input),
        launch,
        NEVER_ABORTED_SIGNAL,
      )).rejects.toMatchObject({
        code: "write_failed",
        message: "write_failed",
      });
      expect(() => input.inspect()).toThrow(expect.objectContaining({
        code: "input_unavailable",
      }));
      await expect(authority.reassert(NEVER_ABORTED_SIGNAL)).resolves.toEqual(
        expect.objectContaining({ railwayCliSha256: TEST_BINARY_SHA256 }),
      );
      await authority.close();
    }
  });

  it("does not accept a launcher-forged input cleanup error as genuine", async () => {
    const authority = await freshAuthority();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const forged = new inputModule
      .PermanentStagingProviderVariableWriteInputError("cleanup_failed");
    const fixture = fakeChild();
    const launch = genuineLauncher(authority, fixture.child, () => {
      throw forged;
    });
    const input = await freshInput();
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      input,
      TEST_INTENT_SHA256,
      await freshAttempt(authority, input),
      launch,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "write_failed",
      message: "write_failed",
    });
    await expect(authority.reassert(NEVER_ABORTED_SIGNAL)).resolves.toEqual(
      expect.objectContaining({ railwayCliSha256: TEST_BINARY_SHA256 }),
    );
    await authority.close();
  });

  it("aborts an in-flight child exactly once and waits for its close settlement", async () => {
    const authority = await freshAuthority();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const input = await freshInput();
    const fixture = fakeChild({ settleOnAbort: true });
    const launch = genuineLauncher(authority, fixture.child);
    const controller = new AbortController();
    const pending = authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      input,
      TEST_INTENT_SHA256,
      await freshAttempt(authority, input),
      launch,
      controller.signal,
    );
    await vi.waitFor(() => expect(fixture.writes).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "write_failed" });
    expect(fixture.abort).toHaveBeenCalledTimes(1);
    await expect(authority.reassert(NEVER_ABORTED_SIGNAL)).resolves.toEqual(
      expect.objectContaining({ railwayCliSha256: TEST_BINARY_SHA256 }),
    );
    await authority.close();
  });

  it("uses one snapshotted dependency capability set across every await", async () => {
    const dependencies = realDependencies();
    const originalOpen = dependencies.open;
    const originalLstat = dependencies.lstat;
    const originalRealpath = dependencies.realpath;
    const originalEffectiveUid = dependencies.effectiveUid;
    const poison = vi.fn(() => {
      throw new Error("mutated dependency must not be invoked");
    });
    let heldHandle: fs.promises.FileHandle | undefined;
    let mutated = false;
    Object.defineProperties(dependencies, {
      open: {
        configurable: true,
        enumerable: true,
        value: async (filename: string, flags: number) => {
          const opened = await originalOpen(filename, flags);
          heldHandle = opened;
          return opened;
        },
        writable: true,
      },
      lstat: {
        configurable: true,
        enumerable: true,
        value: async (filename: string) => {
          const observed = await originalLstat(filename);
          if (!mutated) {
            mutated = true;
            Object.defineProperties(dependencies, {
              open: { configurable: true, enumerable: true, value: poison },
              lstat: { configurable: true, enumerable: true, value: poison },
              realpath: {
                configurable: true,
                enumerable: true,
                value: poison,
              },
              effectiveUid: {
                configurable: true,
                enumerable: true,
                value: poison,
              },
            });
          }
          return observed;
        },
        writable: true,
      },
    });
    try {
      const authority = await freshAuthority(dependencies);
      await authority.inspect(NEVER_ABORTED_SIGNAL);
      await authority.reassert(NEVER_ABORTED_SIGNAL);
      await authority.close();
      expect(poison).not.toHaveBeenCalled();
      expect(heldHandle).toBeDefined();
      await expect(heldHandle!.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      Object.defineProperties(dependencies, {
        open: { configurable: true, enumerable: true, value: originalOpen },
        lstat: { configurable: true, enumerable: true, value: originalLstat },
        realpath: {
          configurable: true,
          enumerable: true,
          value: originalRealpath,
        },
        effectiveUid: {
          configurable: true,
          enumerable: true,
          value: originalEffectiveUid,
        },
      });
    }
  });

  it("closes through the captured handle capability after live close poisoning", async () => {
    const dependencies = realDependencies();
    const originalOpen = dependencies.open;
    let heldHandle: fs.promises.FileHandle | undefined;
    Object.defineProperty(dependencies, "open", {
      configurable: true,
      enumerable: true,
      value: async (filename: string, flags: number) => {
        const opened = await originalOpen(filename, flags);
        heldHandle = opened;
        return opened;
      },
      writable: true,
    });
    const authority = await freshAuthority(dependencies);
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    expect(heldHandle).toBeDefined();
    const originalOwnClose = Object.getOwnPropertyDescriptor(
      heldHandle!,
      "close",
    );
    const poisonedClose = vi.fn(async () => {
      throw new Error("live close must not be invoked");
    });
    Object.defineProperty(heldHandle!, "close", {
      configurable: true,
      value: poisonedClose,
      writable: true,
    });
    try {
      await expect(authority.close()).resolves.toBeUndefined();
      expect(poisonedClose).not.toHaveBeenCalled();
      await expect(heldHandle!.stat()).rejects.toMatchObject({ code: "EBADF" });
    } finally {
      if (originalOwnClose === undefined) {
        Reflect.deleteProperty(heldHandle!, "close");
      } else {
        Object.defineProperty(heldHandle!, "close", originalOwnClose);
      }
    }
  });

  it("rejects unbranded poison input without invoking attacker capabilities", async () => {
    const authority = await freshAuthority();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const close = vi.fn();
    const poison = {
      get inspect() {
        throw new Error("raw secret-bearing getter failure");
      },
      reassert: vi.fn(),
      writeExactlyOnce: vi.fn(),
      close,
    } as unknown as Awaited<ReturnType<typeof freshInput>>;
    const launch = vi.fn(() => fakeChild().child);
    const attemptInput = await freshInput();
    const attempt = await freshAttempt(authority, attemptInput);
    attemptInput.close();
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      poison,
      TEST_INTENT_SHA256,
      attempt,
      launch,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "local_authority_invalid",
      message: "local_authority_invalid",
    });
    expect(close).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    await expect(authority.reassert(NEVER_ABORTED_SIGNAL)).resolves.toEqual(
      expect.objectContaining({ railwayCliSha256: TEST_BINARY_SHA256 }),
    );
    await authority.close();
  });

  it("rejects an unbranded input that would invoke the stdin writer twice", async () => {
    const authority = await freshAuthority();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const genuine = await freshInput();
    const inspection = genuine.inspect();
    genuine.close();
    const writes = vi.fn();
    const forged = {
      inspect: () => inspection,
      reassert: () => inspection,
      async writeExactlyOnce(
        writer: (value: Buffer, signal: AbortSignal) => Promise<void>,
        signal: AbortSignal,
      ) {
        await writer(Buffer.from("first"), signal);
        await writer(Buffer.from("second"), signal);
      },
      close: vi.fn(),
    };
    const launch = vi.fn(() => ({
      writeStdin: async () => {
        writes();
      },
      abort: vi.fn(),
      closed: Promise.resolve({ exitCode: 0, signal: null }),
    }));
    const attemptInput = await freshInput();
    const attempt = await freshAttempt(authority, attemptInput);
    attemptInput.close();
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      forged,
      TEST_INTENT_SHA256,
      attempt,
      launch,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "local_authority_invalid",
      message: "local_authority_invalid",
    });
    expect(launch).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(forged.close).not.toHaveBeenCalled();
    await authority.close();
  });

  it("rejects an unbranded launcher without invoking child getters", async () => {
    const authority = await freshAuthority();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const writeGetter = vi.fn(() => async () => undefined);
    const closeGetter = vi.fn(() => Promise.resolve({ exitCode: 0, signal: null }));
    const child = {};
    Object.defineProperties(child, {
      writeStdin: { enumerable: true, get: writeGetter },
      abort: { enumerable: true, value: vi.fn() },
      closed: { enumerable: true, get: closeGetter },
    });
    const launch = vi.fn(
      () => child as PermanentStagingProviderVariableWriteInjectedChild,
    );
    const input = await freshInput();
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      input,
      TEST_INTENT_SHA256,
      await freshAttempt(authority, input),
      launch,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "local_authority_invalid",
      message: "local_authority_invalid",
    });
    expect(launch).not.toHaveBeenCalled();
    expect(writeGetter).not.toHaveBeenCalled();
    expect(closeGetter).not.toHaveBeenCalled();
    await expect(authority.reassert(NEVER_ABORTED_SIGNAL)).resolves.toEqual(
      expect.objectContaining({ railwayCliSha256: TEST_BINARY_SHA256 }),
    );
    await authority.close();
  });

  it("rejects an unbranded launcher without invoking result getters", async () => {
    const authority = await freshAuthority();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const resultGetter = vi.fn(() => 0);
    const result = {};
    Object.defineProperties(result, {
      exitCode: { enumerable: true, get: resultGetter },
      signal: { enumerable: true, value: null },
    });
    const child: PermanentStagingProviderVariableWriteInjectedChild = {
      async writeStdin() {},
      abort: vi.fn(),
      closed: Promise.resolve(
        result as PermanentStagingProviderVariableWriteInjectedChildResult,
      ),
    };
    const launch = vi.fn(() => child);
    const input = await freshInput();
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      input,
      TEST_INTENT_SHA256,
      await freshAttempt(authority, input),
      launch,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "local_authority_invalid",
      message: "local_authority_invalid",
    });
    expect(launch).not.toHaveBeenCalled();
    expect(resultGetter).not.toHaveBeenCalled();
    await authority.close();
  });

  it("rejects an unbranded launcher before invoking result proxy traps", async () => {
    const authority = await freshAuthority();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const trap = vi.fn(() => {
      throw new Error("result proxy trap must not run");
    });
    const result = new Proxy({ exitCode: 7, signal: null }, {
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
    });
    const child: PermanentStagingProviderVariableWriteInjectedChild = {
      async writeStdin() {},
      abort: vi.fn(),
      closed: Promise.resolve(result),
    };
    const launch = vi.fn(() => child);
    const input = await freshInput();
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      input,
      TEST_INTENT_SHA256,
      await freshAttempt(authority, input),
      launch,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "local_authority_invalid",
      message: "local_authority_invalid",
    });
    expect(launch).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
    await authority.close();
  });

  it("uses captured result intrinsics after the sole child write poisons globals", async () => {
    const authority = await freshAuthority();
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const originalFreeze = Object.freeze;
    const originalDescriptors = Object.getOwnPropertyDescriptors;
    const child: PermanentStagingProviderVariableWriteInjectedChild = {
      async writeStdin() {
        Object.freeze = ((value: object) => {
          if ("exitCode" in value) return { exitCode: 0, signal: null };
          return value;
        }) as typeof Object.freeze;
        Object.getOwnPropertyDescriptors = (() => ({
          exitCode: {
            configurable: true,
            enumerable: true,
            value: 0,
            writable: true,
          },
          signal: {
            configurable: true,
            enumerable: true,
            value: null,
            writable: true,
          },
        })) as typeof Object.getOwnPropertyDescriptors;
      },
      abort: vi.fn(),
      closed: Promise.resolve({ exitCode: 7, signal: null }),
    };
    let failure: unknown;
    const input = await freshInput();
    try {
      await authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        TEST_INTENT_SHA256,
        await freshAttempt(authority, input),
        genuineLauncher(authority, child),
        NEVER_ABORTED_SIGNAL,
      );
    } catch (error) {
      failure = error;
    } finally {
      Object.freeze = originalFreeze;
      Object.getOwnPropertyDescriptors = originalDescriptors;
    }
    expect(failure).toMatchObject({
      code: "write_failed",
      message: "write_failed",
    });
    await authority.close();
  });

  it("has no real child process, provider, token value, ambient env, or output capture capability", async () => {
    const sourceText = await fs.promises.readFile(
      path.resolve(
        "scripts/lib/permanent-staging-provider-variable-write-local-authority.ts",
      ),
      "utf8",
    );
    for (const forbidden of [
      "node:child_process",
      "process.env",
      "process.argv",
      "fetch(",
      "execFile(",
      "spawn(",
      "RAILWAY_API_TOKEN",
      "stdout.on",
      "stderr.on",
    ]) {
      expect(sourceText).not.toContain(forbidden);
    }
    expect(sourceText).toContain('exactNames: OBJECT_FREEZE(["RAILWAY_TOKEN"]');
    expect(sourceText).toContain("valuesHandledByThisModule: false");
    expect(sourceText).not.toMatch(/RAILWAY_TOKEN\s*:/);
  });
});
