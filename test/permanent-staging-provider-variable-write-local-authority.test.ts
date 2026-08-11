import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  PermanentStagingProviderVariableWriteInputSource,
} from "../scripts/lib/permanent-staging-provider-variable-write-input.js";
import type {
  PermanentStagingProviderVariableWriteCommand,
  PermanentStagingProviderVariableWriteInjectedChild,
  PermanentStagingProviderVariableWriteInjectedChildResult,
  PermanentStagingProviderVariableWriteLocalAuthorityDependencies,
  PermanentStagingProviderVariableWriteLocalAuthorityHandle,
  PermanentStagingProviderVariableWriteLocalInspection,
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
  readonly openPermanentStagingProviderVariableWriteLocalAuthority: (
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

let temporaryRoot = "";
let binaryPath = "";
let authorityModule: LocalAuthorityModule;
let inputModule: InputModule;

function source(value: Buffer): PermanentStagingProviderVariableWriteInputSource {
  return {
    async *[Symbol.asyncIterator]() {
      yield value;
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
  readonly result?: PermanentStagingProviderVariableWriteInjectedChildResult;
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
  const pendingWrite = options.settleOnAbort ? deferred<void>() : undefined;
  const writes: Buffer[] = [];
  const retainedWrites: Buffer[] = [];
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    close.resolve(options.result ?? { exitCode: 0, signal: null });
  };
  const abort = vi.fn(() => {
    pendingWrite?.reject(new Error("fixture child aborted"));
    if (options.settleOnAbort) {
      setImmediate(() => {
        if (settled) return;
        settled = true;
        close.resolve({ exitCode: null, signal: "SIGTERM" });
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
  return await authorityModule
    .openPermanentStagingProviderVariableWriteLocalAuthority(dependencies);
}

function realDependencies(
  closeHandle: PermanentStagingProviderVariableWriteLocalAuthorityDependencies[
    "closeHandle"
  ] = (handle) => handle.close(),
): PermanentStagingProviderVariableWriteLocalAuthorityDependencies {
  return {
    open: (filename, flags) => fs.promises.open(filename, flags),
    lstat: (filename) => fs.promises.lstat(filename, { bigint: true }),
    realpath: (filename) => fs.promises.realpath(filename),
    effectiveUid: () => {
      if (typeof process.geteuid !== "function") throw new Error("no euid");
      return process.geteuid();
    },
    closeHandle,
  };
}

beforeAll(async () => {
  const createdRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pintpath-provider-variable-local-authority."),
  );
  temporaryRoot = await fs.promises.realpath(createdRoot);
  binaryPath = path.join(temporaryRoot, "railway-fixture-never-executed");
  await fs.promises.writeFile(binaryPath, TEST_BINARY_BYTES, {
    flag: "wx",
    mode: 0o555,
  });
  await fs.promises.chmod(binaryPath, 0o555);

  vi.resetModules();
  vi.doMock(
    "../scripts/lib/permanent-staging-provider-variable-write-executor.js",
    () => {
      const operations = Object.freeze([
        Object.freeze({ variableName: "GOOGLE_MAPS_API_KEY" }),
        Object.freeze({ variableName: "GOOGLE_MAPS_MAP_ID" }),
        Object.freeze({ variableName: "GOOGLE_PLACES_API_KEY" }),
        Object.freeze({ variableName: "OPENAI_API_KEY" }),
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
  inputModule = await import(
    "../scripts/lib/permanent-staging-provider-variable-write-input.js"
  ) as InputModule;
});

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await fs.promises.chmod(binaryPath, 0o755);
    await fs.promises.writeFile(binaryPath, TEST_BINARY_BYTES, { flag: "w" });
    await fs.promises.chmod(binaryPath, 0o555);
  } catch {
    // Individual tests must report their own fixture damage.
  }
});

afterAll(async () => {
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
  it("holds and repeatedly hashes one exact regular non-writable binary descriptor", async () => {
    const authority = await freshAuthority();
    const inspection = await authority.inspect(NEVER_ABORTED_SIGNAL);
    expect(inspection).toMatchObject({
      schemaVersion:
        "pintpath-permanent-staging-provider-variable-write-local-authority/v1",
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
      providerInvoked: false,
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
        "pintpath-permanent-staging-provider-variable-write-command/v1",
      executable: binaryPath,
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
        exactNames: ["RAILWAY_TOKEN"],
        valuesHandledByThisModule: false,
      },
      shell: false,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      maximumCapturedStdoutBytes: 0,
      maximumCapturedStderrBytes: 0,
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
    const launch = vi.fn((_command: PermanentStagingProviderVariableWriteCommand) =>
      fixture.child);

    const receipt = await authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      input,
      launch,
      NEVER_ABORTED_SIGNAL,
    );
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        executable: binaryPath,
        shell: false,
        stdout: "ignore",
        stderr: "ignore",
        maximumCapturedStdoutBytes: 0,
        maximumCapturedStderrBytes: 0,
      }),
    );
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]!.toString("utf8")).toBe("fixture-provider-value");
    expect(fixture.retainedWrites[0]!.equals(
      Buffer.alloc(fixture.retainedWrites[0]!.length),
    )).toBe(true);
    expect(fixture.abort).not.toHaveBeenCalled();
    expect(receipt).toEqual({
      schemaVersion:
        "pintpath-permanent-staging-provider-variable-write-local-receipt/v1",
      variableName: "OPENAI_API_KEY",
      inputCommitmentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      localAuthoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      commandSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      childAttempts: 1,
      stdinWrites: 1,
      exitCode: 0,
      signal: null,
      stdoutBytesCaptured: 0,
      stderrBytesCaptured: 0,
      childCloseAwaited: true,
      providerAcknowledgementInspected: false,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    await expect(authority.reassert(NEVER_ABORTED_SIGNAL)).resolves.toEqual(
      expect.objectContaining({ railwayCliSha256: TEST_BINARY_SHA256 }),
    );
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      await freshInput("second"),
      launch,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({ code: "local_authority_invalid" });
    expect(launch).toHaveBeenCalledTimes(1);
    await authority.close();
  });

  it("uses captured hash primitives after an input source poisons live Hash methods", async () => {
    const authority = await freshAuthority();
    const inspection = await authority.inspect(NEVER_ABORTED_SIGNAL);
    const command = authority.buildCreateOnlyCommand("OPENAI_API_KEY");
    const expectedLocalAuthoritySha256 = canonicalSha256(
      "pintpath/permanent-staging/provider-variable-write/local-authority/v1",
      inspection,
    );
    const expectedCommandSha256 = canonicalSha256(
      "pintpath/permanent-staging/provider-variable-write/command/v1",
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
            async *[Symbol.asyncIterator]() {
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
              yield Buffer.from("fixture-provider-value", "utf8");
            },
          },
          NEVER_ABORTED_SIGNAL,
        );
      receipt = await authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        () => fakeChild().child,
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

  it("does not dispatch inherited toJSON while hashing local evidence", async () => {
    const authority = await freshAuthority();
    const inspection = await authority.inspect(NEVER_ABORTED_SIGNAL);
    const command = authority.buildCreateOnlyCommand("OPENAI_API_KEY");
    const expectedLocalAuthoritySha256 = canonicalSha256(
      "pintpath/permanent-staging/provider-variable-write/local-authority/v1",
      inspection,
    );
    const expectedCommandSha256 = canonicalSha256(
      "pintpath/permanent-staging/provider-variable-write/command/v1",
      command,
    );
    const originalToJSON = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "toJSON",
    );
    const poisonedToJSON = vi.fn(() => ({
      railwayCliSha256: "0".repeat(64),
    }));
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
            async *[Symbol.asyncIterator]() {
              Object.defineProperty(Object.prototype, "toJSON", {
                configurable: true,
                enumerable: false,
                value: poisonedToJSON,
                writable: true,
              });
              yield Buffer.from("fixture-provider-value", "utf8");
            },
          },
          NEVER_ABORTED_SIGNAL,
        );
      receipt = await authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        () => fakeChild().child,
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
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const probeHandle = await fs.promises.open(binaryPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as object;
    await probeHandle.close();
    const statsBasePrototype = Object.getPrototypeOf(fs.Stats.prototype) as
      object;
    const targets: readonly (readonly [object, PropertyKey])[] = [
      [Buffer, "alloc"],
      [Buffer, "byteLength"],
      [Buffer.prototype, "fill"],
      [Buffer.prototype, "subarray"],
      [fileHandlePrototype, "read"],
      [fileHandlePrototype, "stat"],
      [fs.promises, "lstat"],
      [fs.promises, "realpath"],
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
    const poison = () => {
      throw new Error("live primitive must not be reached");
    };
    let receipt: unknown;
    let failure: unknown;
    try {
      const input = await inputModule
        .readPermanentStagingProviderVariableWriteInput(
          "OPENAI_API_KEY",
          {
            async *[Symbol.asyncIterator]() {
              for (let index = 0; index < targets.length; index += 1) {
                const [target, key] = targets[index]!;
                Object.defineProperty(target, key, {
                  ...originals[index],
                  value: poison,
                });
              }
              yield Buffer.from("fixture-provider-value", "utf8");
            },
          },
          NEVER_ABORTED_SIGNAL,
        );
      receipt = await authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        () => ({
          async writeStdin() {},
          abort: vi.fn(),
          closed: Promise.resolve({ exitCode: 0, signal: null }),
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
    expect(failure).toBeUndefined();
    expect(receipt).toMatchObject({
      localAuthoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      commandSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("does not dispatch live Buffer view accessors while hashing or wiping", async () => {
    const authority = await freshAuthority();
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
        () => ({
          async writeStdin() {},
          abort: vi.fn(),
          closed: Promise.resolve({ exitCode: 0, signal: null }),
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
        () => ({
          async writeStdin() {},
          abort: vi.fn(),
          closed: Promise.resolve({ exitCode: 0, signal: null }),
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
      closed: Promise.resolve({ exitCode: 0, signal: null }),
    };
    let receipt: unknown;
    let failure: unknown;
    try {
      receipt = await authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        () => child,
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
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      await freshInput(),
      () => child,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "cleanup_failed",
      message: "cleanup_failed",
    });
    expect(detached).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
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
    await fs.promises.chmod(binaryPath, 0o755);
    await fs.promises.writeFile(binaryPath, "drifted-never-executed\n", {
      flag: "w",
    });
    await fs.promises.chmod(binaryPath, 0o555);
    const launch = vi.fn(() => fakeChild().child);
    const input = await freshInput();
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      input,
      launch,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({ code: "local_authority_invalid" });
    expect(launch).not.toHaveBeenCalled();
    expect(() => input.inspect()).toThrow(expect.objectContaining({
      code: "input_unavailable",
    }));
    await authority.close();
  });

  it("treats nonzero close and synchronous launch failure as terminal one-attempt failures", async () => {
    for (const launch of [
      vi.fn(() => fakeChild({ result: { exitCode: 7, signal: null } }).child),
      vi.fn((): PermanentStagingProviderVariableWriteInjectedChild => {
        throw new Error("fixture spawn failure with unsafe output");
      }),
    ]) {
      const authority = await freshAuthority();
      await authority.inspect(NEVER_ABORTED_SIGNAL);
      const input = await freshInput();
      await expect(authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        input,
        launch,
        NEVER_ABORTED_SIGNAL,
      )).rejects.toMatchObject({
        code: "write_failed",
        message: "write_failed",
      });
      expect(launch).toHaveBeenCalledTimes(1);
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
    const launch = vi.fn((): PermanentStagingProviderVariableWriteInjectedChild => {
      throw forged;
    });
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      await freshInput(),
      launch,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "write_failed",
      message: "write_failed",
    });
    expect(launch).toHaveBeenCalledTimes(1);
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
    const launch = vi.fn(() => fixture.child);
    const controller = new AbortController();
    const pending = authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      input,
      launch,
      controller.signal,
    );
    await vi.waitFor(() => expect(fixture.writes).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "write_failed" });
    expect(fixture.abort).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(1);
    await expect(authority.reassert(NEVER_ABORTED_SIGNAL)).resolves.toEqual(
      expect.objectContaining({ railwayCliSha256: TEST_BINARY_SHA256 }),
    );
    await authority.close();
  });

  it("keeps the descriptor for postflight, then reports cleanup failure at close", async () => {
    let heldHandle: fs.promises.FileHandle | undefined;
    let firstClose = true;
    const dependencies = realDependencies(async (handle) => {
      heldHandle = handle;
      if (firstClose) {
        firstClose = false;
        throw new Error("injected close failure");
      }
      await handle.close();
    });
    const authority = await freshAuthority(dependencies);
    await authority.inspect(NEVER_ABORTED_SIGNAL);
    const fixture = fakeChild();
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      await freshInput(),
      () => fixture.child,
      NEVER_ABORTED_SIGNAL,
    )).resolves.toMatchObject({ childCloseAwaited: true });
    await expect(authority.close()).rejects.toMatchObject({
      code: "cleanup_failed",
    });
    await expect(authority.close()).rejects.toMatchObject({
      code: "cleanup_failed",
    });
    expect(heldHandle).toBeDefined();
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
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      poison,
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
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      forged,
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

  it("rejects accessor-backed child capabilities without invoking getters", async () => {
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
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      await freshInput(),
      () => child as PermanentStagingProviderVariableWriteInjectedChild,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "write_failed",
      message: "write_failed",
    });
    expect(writeGetter).not.toHaveBeenCalled();
    expect(closeGetter).not.toHaveBeenCalled();
    await expect(authority.reassert(NEVER_ABORTED_SIGNAL)).resolves.toEqual(
      expect.objectContaining({ railwayCliSha256: TEST_BINARY_SHA256 }),
    );
    await authority.close();
  });

  it("rejects accessor-backed child results without invoking result getters", async () => {
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
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      await freshInput(),
      () => child,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "write_failed",
      message: "write_failed",
    });
    expect(resultGetter).not.toHaveBeenCalled();
    await authority.close();
  });

  it("rejects proxied child results before invoking reflective traps", async () => {
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
    await expect(authority.writeExactlyOnceWithInjectedChild(
      "OPENAI_API_KEY",
      await freshInput(),
      () => child,
      NEVER_ABORTED_SIGNAL,
    )).rejects.toMatchObject({
      code: "write_failed",
      message: "write_failed",
    });
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
    try {
      await authority.writeExactlyOnceWithInjectedChild(
        "OPENAI_API_KEY",
        await freshInput(),
        () => child,
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
