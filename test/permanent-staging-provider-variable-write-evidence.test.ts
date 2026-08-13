import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder, TextEncoder, types as utilTypes } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES,
  PermanentStagingProviderVariableWriteEvidenceError,
  openPermanentStagingProviderVariableWriteEvidenceStore as openEvidenceStore,
  permanentStagingProviderVariableWriteEvidenceInternals,
  type PermanentStagingProviderVariableWriteEvidenceDependencies,
  type PermanentStagingProviderVariableWriteEvidenceLeaf,
  type PermanentStagingProviderVariableWriteEvidenceStore,
} from "../scripts/lib/permanent-staging-provider-variable-write-evidence.js";
import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_NAMES,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS,
} from
  "../scripts/lib/permanent-staging-provider-variable-write-executor.js";

const roots: string[] = [];
const intentLeaf = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES
  .GOOGLE_MAPS_API_KEY.intent;
const terminalLeaf =
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES
    .OPENAI_API_KEY.terminalEvidence;
const intent = JSON.stringify({
  schemaVersion: "pintpath-permanent-staging-provider-variable-intent/v1",
  operation: "permanent-staging-provider-variable-single-write",
  sequentialNotAtomic: true,
});
const alternateIntent = JSON.stringify({
  schemaVersion: "pintpath-permanent-staging-provider-variable-intent/v1",
  operation: "permanent-staging-provider-variable-single-write",
  sequentialNotAtomic: false,
});
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface TestEvidenceStore extends Omit<
  PermanentStagingProviderVariableWriteEvidenceStore,
  "inspect" | "persist" | "read"
> {
  read(
    leaf: PermanentStagingProviderVariableWriteEvidenceLeaf,
    signal?: AbortSignal,
  ): ReturnType<PermanentStagingProviderVariableWriteEvidenceStore["read"]>;
  inspect(
    leaf: PermanentStagingProviderVariableWriteEvidenceLeaf,
    canonicalContent: string,
    signal?: AbortSignal,
  ): ReturnType<PermanentStagingProviderVariableWriteEvidenceStore["inspect"]>;
  persist(
    leaf: PermanentStagingProviderVariableWriteEvidenceLeaf,
    canonicalContent: string,
    signal?: AbortSignal,
  ): ReturnType<PermanentStagingProviderVariableWriteEvidenceStore["persist"]>;
}

async function openPermanentStagingProviderVariableWriteEvidenceStore(
  parentDirectory: string,
  overrides: Partial<PermanentStagingProviderVariableWriteEvidenceDependencies> = {},
): Promise<TestEvidenceStore> {
  const store = await openEvidenceStore(parentDirectory, overrides);
  return {
    read: (leaf, signal = NEVER_ABORTED_SIGNAL) => store.read(leaf, signal),
    inspect: (leaf, canonicalContent, signal = NEVER_ABORTED_SIGNAL) =>
      store.inspect(leaf, canonicalContent, signal),
    persist: (leaf, canonicalContent, signal = NEVER_ABORTED_SIGNAL) =>
      store.persist(leaf, canonicalContent, signal),
    close: () => store.close(),
  };
}

function privateRoot(): string {
  const created = fs.mkdtempSync(
    path.join(os.tmpdir(), "pintpath-provider-variable-evidence-test-"),
  );
  fs.chmodSync(created, 0o700);
  const real = fs.realpathSync(created);
  roots.push(real);
  return real;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function expectCode(
  value: Promise<unknown>,
  code: "evidence_invalid" | "cleanup_failed",
): Promise<void> {
  return expect(value).rejects.toMatchObject({
    name: "PermanentStagingProviderVariableWriteEvidenceError",
    code,
    message: code,
  });
}

const DEFINE_PROPERTY_EXACT = Object.defineProperty;
const GET_OWN_PROPERTY_DESCRIPTOR_EXACT = Object.getOwnPropertyDescriptor;
const DELETE_PROPERTY_EXACT = Reflect.deleteProperty;

function restoreOwnProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    DELETE_PROPERTY_EXACT(target, key);
  } else {
    DEFINE_PROPERTY_EXACT(target, key, descriptor);
  }
}

interface PropertyPoison {
  readonly target: object;
  readonly key: PropertyKey;
  readonly descriptor: PropertyDescriptor;
}

async function withPoisonedProperties<T>(
  poisons: readonly PropertyPoison[],
  operation: () => Promise<T>,
): Promise<T> {
  const originals: Array<PropertyDescriptor | undefined> = [];
  let applied = 0;
  try {
    for (let index = 0; index < poisons.length; index += 1) {
      const poison = poisons[index]!;
      originals[index] = GET_OWN_PROPERTY_DESCRIPTOR_EXACT(
        poison.target,
        poison.key,
      );
      DEFINE_PROPERTY_EXACT(poison.target, poison.key, poison.descriptor);
      applied = index + 1;
    }
    return await operation();
  } finally {
    for (let index = applied - 1; index >= 0; index -= 1) {
      const poison = poisons[index]!;
      const original = originals[index];
      if (original === undefined) {
        DELETE_PROPERTY_EXACT(poison.target, poison.key);
      } else {
        DEFINE_PROPERTY_EXACT(poison.target, poison.key, original);
      }
    }
  }
}

function throwingValue(label: string): PropertyDescriptor {
  return {
    configurable: true,
    enumerable: false,
    writable: true,
    value: vi.fn(() => {
      throw new Error(`poison-called:${label}`);
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${root}-original`, { recursive: true, force: true });
  }
});

describe("permanent staging provider-variable durable evidence", () => {
  it("pins two literal leaves for each allowed variable without deriving a path", () => {
    expect(Object.keys(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES,
    )).toEqual(PERMANENT_STAGING_PROVIDER_VARIABLE_NAMES);
    for (const operation of PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS) {
      expect(PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES[
        operation.variableName
      ]).toEqual({
        intent: operation.intentLeaf,
        terminalEvidence: operation.terminalEvidenceLeaf,
      });
    }
    expect(PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES).toEqual({
      GOOGLE_MAPS_API_KEY: {
        intent:
          "pintpath-permanent-staging-provider-variable-google-maps-api-key-intent.json",
        terminalEvidence:
          "pintpath-permanent-staging-provider-variable-google-maps-api-key-terminal-evidence.json",
      },
      GOOGLE_MAPS_MAP_ID: {
        intent:
          "pintpath-permanent-staging-provider-variable-google-maps-map-id-intent.json",
        terminalEvidence:
          "pintpath-permanent-staging-provider-variable-google-maps-map-id-terminal-evidence.json",
      },
      GOOGLE_PLACES_API_KEY: {
        intent:
          "pintpath-permanent-staging-provider-variable-google-places-api-key-intent.json",
        terminalEvidence:
          "pintpath-permanent-staging-provider-variable-google-places-api-key-terminal-evidence.json",
      },
      OPENAI_API_KEY: {
        intent:
          "pintpath-permanent-staging-provider-variable-openai-api-key-intent.json",
        terminalEvidence:
          "pintpath-permanent-staging-provider-variable-openai-api-key-terminal-evidence.json",
      },
    });
    expect(Object.isFrozen(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES,
    )).toBe(true);
    for (const leaves of Object.values(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EVIDENCE_LEAVES,
    )) {
      expect(Object.isFrozen(leaves)).toBe(true);
      expect(path.basename(leaves.intent)).toBe(leaves.intent);
      expect(path.basename(leaves.terminalEvidence)).toBe(
        leaves.terminalEvidence,
      );
    }
  });

  it("publishes one private durable leaf without overwriting and holds the parent", async () => {
    const root = privateRoot();
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
    const created = await store.persist(intentLeaf, intent);
    expect(created).toEqual({
      publication: "created-durable",
      sha256: sha256(intent),
      canonicalPathExact: true,
      parentMode0700: true,
      fileMode0600: true,
      currentUid: true,
      regularFile: true,
      nonSymlink: true,
      nlinkOne: true,
      exclusiveCreate: true,
      fileFsync: true,
      parentFsync: true,
      identityHeld: true,
      readbackExact: true,
    });
    const finalPath = path.join(root, intentLeaf);
    const stat = fs.lstatSync(finalPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o7777).toBe(0o600);
    expect(stat.nlink).toBe(1);
    expect(fs.readFileSync(finalPath, "utf8")).toBe(intent);
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);

    const inspected = await store.inspect(intentLeaf, intent);
    expect(inspected).toEqual({
      ...created,
      publication: "existing-exact",
      exclusiveCreate: false,
    });
    const existing = await store.persist(intentLeaf, intent);
    expect(existing).toEqual(inspected);
    await expect(store.read(intentLeaf)).resolves.toEqual({
      canonical: intent,
      evidence: inspected,
    });
    expect(fs.readFileSync(finalPath, "utf8")).toBe(intent);
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
    await expectCode(store.read(intentLeaf), "evidence_invalid");
    await expectCode(store.inspect(intentLeaf, intent), "evidence_invalid");
    await expectCode(store.persist(intentLeaf, intent), "evidence_invalid");
  });

  it("exposes only a frozen null-prototype store facade and no raw filesystem authority", async () => {
    const root = privateRoot();
    const store = await openEvidenceStore(root);
    expect(Object.getPrototypeOf(store)).toBeNull();
    expect(Object.isFrozen(store)).toBe(true);
    expect(Reflect.ownKeys(store)).toEqual([
      "read",
      "inspect",
      "persist",
      "close",
    ]);
    expect((store as unknown as Record<string, unknown>).parentHandle)
      .toBeUndefined();
    expect((store as unknown as Record<string, unknown>).dependencies)
      .toBeUndefined();
    expect((store as unknown as Record<string, unknown>).constructor)
      .toBeUndefined();
    expect((store as unknown as Record<string, unknown>).open).toBeUndefined();
    await store.close();
    expect((store as unknown as Record<string, unknown>).open).toBeUndefined();
    await expectCode(
      store.read(intentLeaf, NEVER_ABORTED_SIGNAL),
      "evidence_invalid",
    );
  });

  it("returns null for an absent inspected leaf without creating anything", async () => {
    const root = privateRoot();
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
    await expect(store.inspect(terminalLeaf, intent)).resolves.toBeNull();
    await expect(store.read(terminalLeaf)).resolves.toBeNull();
    expect(fs.readdirSync(root)).toEqual([]);
    await store.close();
  });

  it("rejects a missing or already-aborted signal before any evidence filesystem action", async () => {
    const root = privateRoot();
    const open = vi.fn<PermanentStagingProviderVariableWriteEvidenceDependencies["open"]>(
      async (filename, flags, mode) => mode === undefined
        ? fs.promises.open(filename, flags)
        : fs.promises.open(filename, flags, mode),
    );
    const lstat = vi.fn(async (filename: string) =>
      fs.promises.lstat(filename, { bigint: true })
    );
    const realpath = vi.fn(async (filename: string) =>
      fs.promises.realpath(filename)
    );
    const syncHandle = vi.fn(async (handle: fs.promises.FileHandle) =>
      handle.sync()
    );
    const store = await openEvidenceStore(root, {
      lstat,
      open,
      realpath,
      syncHandle,
    });
    const callsAtRest = {
      lstat: lstat.mock.calls.length,
      open: open.mock.calls.length,
      realpath: realpath.mock.calls.length,
      syncHandle: syncHandle.mock.calls.length,
    };
    const controller = new AbortController();
    controller.abort();

    await expectCode(
      store.inspect(intentLeaf, intent, controller.signal),
      "evidence_invalid",
    );
    await expectCode(
      store.read(intentLeaf, controller.signal),
      "evidence_invalid",
    );
    await expectCode(
      store.persist(intentLeaf, intent, controller.signal),
      "evidence_invalid",
    );
    await expectCode(
      store.persist(intentLeaf, intent, undefined as unknown as AbortSignal),
      "evidence_invalid",
    );
    await expectCode(
      store.inspect(intentLeaf, intent, undefined as unknown as AbortSignal),
      "evidence_invalid",
    );
    await expectCode(
      store.read(intentLeaf, undefined as unknown as AbortSignal),
      "evidence_invalid",
    );

    expect({
      lstat: lstat.mock.calls.length,
      open: open.mock.calls.length,
      realpath: realpath.mock.calls.length,
      syncHandle: syncHandle.mock.calls.length,
    }).toEqual(callsAtRest);
    expect(fs.readdirSync(root)).toEqual([]);
    await store.close();
  });

  it("retains an exclusive-create marker when aborted and blocks replay", async () => {
    const root = privateRoot();
    const finalPath = path.join(root, intentLeaf);
    const controller = new AbortController();
    const open: PermanentStagingProviderVariableWriteEvidenceDependencies["open"] = async (
      filename,
      flags,
      mode,
    ) => {
      const handle = mode === undefined
        ? await fs.promises.open(filename, flags)
        : await fs.promises.open(filename, flags, mode);
      if (mode === 0o600) controller.abort();
      return handle;
    };
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, {
      open,
    });

    await expectCode(
      store.persist(intentLeaf, intent, controller.signal),
      "cleanup_failed",
    );
    expect(controller.signal.aborted).toBe(true);
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);
    expect(fs.lstatSync(finalPath).size).toBe(0);
    await expectCode(store.persist(intentLeaf, intent), "evidence_invalid");
    expect(fs.lstatSync(finalPath).size).toBe(0);
    await store.close();
  });

  it("retains a partial final marker after file fsync failure and blocks replay", async () => {
    const root = privateRoot();
    const finalPath = path.join(root, intentLeaf);
    let failed = false;
    const open: PermanentStagingProviderVariableWriteEvidenceDependencies["open"] =
      async (filename, flags, mode) => mode === undefined
        ? await fs.promises.open(filename, flags)
        : await fs.promises.open(filename, flags, mode);
    const syncHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
      const stat = await handle.stat();
      if (stat.isFile() && !failed) {
        failed = true;
        await handle.truncate(7);
        await handle.sync();
        throw errno("EIO");
      }
      await handle.sync();
    });
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, {
      open,
      syncHandle,
      closeHandle: async (handle) => await handle.close(),
    });

    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);
    expect(fs.readFileSync(finalPath, "utf8")).toBe(intent.slice(0, 7));
    await expectCode(store.persist(intentLeaf, intent), "evidence_invalid");
    expect(fs.readFileSync(finalPath, "utf8")).toBe(intent.slice(0, 7));
    await store.close();
  });

  it("fails closed when cancellation arrives during final path validation", async () => {
    const root = privateRoot();
    const finalPath = path.join(root, intentLeaf);
    const controller = new AbortController();
    let finalPathStats = 0;
    const lstat = vi.fn(async (filename: string) => {
      const stat = await fs.promises.lstat(filename, { bigint: true });
      if (filename === finalPath) {
        finalPathStats += 1;
        if (finalPathStats === 3) controller.abort();
      }
      return stat;
    });
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, {
      lstat,
    });

    await expectCode(
      store.persist(intentLeaf, intent, controller.signal),
      "cleanup_failed",
    );
    expect(controller.signal.aborted).toBe(true);
    expect(finalPathStats).toBe(3);
    expect(fs.readFileSync(finalPath, "utf8")).toBe(intent);
    await expect(store.persist(intentLeaf, intent)).resolves.toMatchObject({
      publication: "existing-exact",
      sha256: sha256(intent),
    });
    await store.close();
  });

  it("never deletes a same-path replacement after exclusive creation", async () => {
    const root = privateRoot();
    const finalPath = path.join(root, intentLeaf);
    const displacedPath = path.join(root, "held-original.json");
    let replaced = false;
    const replacement = alternateIntent;
    const syncHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
      const stat = await handle.stat();
      if (stat.isFile() && !replaced) {
        replaced = true;
        fs.renameSync(finalPath, displacedPath);
        fs.writeFileSync(finalPath, replacement, { mode: 0o600 });
        fs.chmodSync(finalPath, 0o600);
      }
      await handle.sync();
    });
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, {
      syncHandle,
    });

    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(fs.readFileSync(finalPath, "utf8")).toBe(replacement);
    expect(fs.readFileSync(displacedPath, "utf8")).toBe(intent);
    await expectCode(store.persist(intentLeaf, intent), "evidence_invalid");
    expect(fs.readFileSync(finalPath, "utf8")).toBe(replacement);
    await store.close();
  });

  it("reports cleanup failure when parent replacement retains the direct marker", async () => {
    const root = privateRoot();
    const original = `${root}-original`;
    const controller = new AbortController();
    let replaced = false;
    const syncHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
      const stat = await handle.stat();
      await handle.sync();
      if (stat.isFile() && !replaced) {
        replaced = true;
        fs.renameSync(root, original);
        fs.mkdirSync(root, { mode: 0o700 });
        fs.chmodSync(root, 0o700);
        controller.abort();
      }
    });
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, {
      syncHandle,
    });

    await expectCode(
      store.persist(intentLeaf, intent, controller.signal),
      "cleanup_failed",
    );
    expect(controller.signal.aborted).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(fs.readdirSync(original)).toEqual([intentLeaf]);
    await expectCode(store.close(), "cleanup_failed");
  });

  it.each(["inspect", "persist", "read"] as const)(
    "closes the existing-leaf descriptor when %s is aborted mid-verification",
    async (operation) => {
      const root = privateRoot();
      const setup = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
      await setup.persist(intentLeaf, intent);
      await setup.close();

      const controller = new AbortController();
      let aborted = false;
      let closedFileDescriptors = 0;
      const syncHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
        const stat = await handle.stat();
        if (stat.isFile() && !aborted) {
          aborted = true;
          controller.abort();
        }
        await handle.sync();
      });
      const closeHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
        const stat = await handle.stat();
        if (stat.isFile()) closedFileDescriptors += 1;
        await handle.close();
      });
      const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, {
        closeHandle,
        syncHandle,
      });
      const pending = operation === "read"
        ? store.read(intentLeaf, controller.signal)
        : operation === "inspect"
          ? store.inspect(intentLeaf, intent, controller.signal)
          : store.persist(intentLeaf, intent, controller.signal);

      await expectCode(pending, "evidence_invalid");
      expect(controller.signal.aborted).toBe(true);
      expect(closedFileDescriptors).toBe(1);
      expect(fs.readdirSync(root)).toEqual([intentLeaf]);
      expect(fs.readFileSync(path.join(root, intentLeaf), "utf8")).toBe(intent);
      await store.close();
    },
  );

  it("allows close only after an aborted exclusive-create operation has quiesced", async () => {
    const root = privateRoot();
    const controller = new AbortController();
    let releaseSync!: () => void;
    let reachedSync!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reachedSync = resolve;
    });
    let held = false;
    const syncHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
      const stat = await handle.stat();
      if (stat.isFile() && !held) {
        held = true;
        controller.abort();
        reachedSync();
        await release;
      }
      await handle.sync();
    });
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, {
      syncHandle,
    });
    const pending = store.persist(intentLeaf, intent, controller.signal);

    await reached;
    await expectCode(store.close(), "cleanup_failed");
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);

    releaseSync();
    await expectCode(pending, "cleanup_failed");
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("rejects existing content drift without changing the authoritative leaf", async () => {
    const root = privateRoot();
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
    await store.persist(intentLeaf, intent);
    await expectCode(store.persist(intentLeaf, alternateIntent), "evidence_invalid");
    await expectCode(store.inspect(intentLeaf, alternateIntent), "evidence_invalid");
    expect(fs.readFileSync(path.join(root, intentLeaf), "utf8")).toBe(intent);
    await store.close();
  });

  it("does not trust a poisoned live Buffer.equals for existing evidence", async () => {
    const root = privateRoot();
    const original = '{"x":1}';
    const replacement = '{"x":2}';
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
    await store.persist(intentLeaf, original);
    const equals = vi.spyOn(Buffer.prototype, "equals").mockReturnValue(true);
    try {
      await expectCode(
        store.persist(intentLeaf, replacement),
        "evidence_invalid",
      );
    } finally {
      equals.mockRestore();
    }
    expect(fs.readFileSync(path.join(root, intentLeaf), "utf8")).toBe(original);
    await store.close();
  });

  it("keeps fixed leaves under the held parent when live path.join is poisoned", async () => {
    const root = privateRoot();
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
    const join = vi.spyOn(path, "join").mockImplementation(() => {
      throw new Error("poisoned live path.join");
    });
    try {
      await expect(store.persist(intentLeaf, intent)).resolves.toMatchObject({
        publication: "created-durable",
      });
    } finally {
      join.mockRestore();
    }
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);
    await store.close();
  });

  it("uses captured byte, canonical-JSON, hash, path, and async intrinsics", async () => {
    const root = privateRoot();
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
    const hashPrototype = Object.getPrototypeOf(crypto.createHash("sha256"));
    const fsPromises = fs.promises;
    const realpathExact = fs.realpath;
    const poison = (label: string): PropertyDescriptor => throwingValue(label);
    const poisons: PropertyPoison[] = [
      { target: Buffer, key: "alloc", descriptor: poison("Buffer.alloc") },
      { target: Buffer, key: "from", descriptor: poison("Buffer.from") },
      {
        target: Buffer,
        key: "byteLength",
        descriptor: poison("Buffer.byteLength"),
      },
      {
        target: Buffer,
        key: "isBuffer",
        descriptor: poison("Buffer.isBuffer"),
      },
      {
        target: Buffer.prototype,
        key: "equals",
        descriptor: poison("Buffer.equals"),
      },
      {
        target: Buffer.prototype,
        key: "toString",
        descriptor: poison("Buffer.toString"),
      },
      {
        target: Buffer.prototype,
        key: "hexSlice",
        descriptor: poison("Buffer.hexSlice"),
      },
      {
        target: Buffer.prototype,
        key: "utf8Write",
        descriptor: poison("Buffer.utf8Write"),
      },
      {
        target: Uint8Array.prototype,
        key: "fill",
        descriptor: poison("Uint8Array.fill"),
      },
      {
        target: Uint8Array.prototype,
        key: "set",
        descriptor: poison("Uint8Array.set"),
      },
      { target: JSON, key: "parse", descriptor: poison("JSON.parse") },
      {
        target: JSON,
        key: "stringify",
        descriptor: poison("JSON.stringify"),
      },
      {
        target: Object.prototype,
        key: "toJSON",
        descriptor: poison("Object.prototype.toJSON"),
      },
      {
        target: crypto,
        key: "createHash",
        descriptor: poison("crypto.createHash"),
      },
      {
        target: crypto,
        key: "randomBytes",
        descriptor: poison("crypto.randomBytes"),
      },
      {
        target: hashPrototype,
        key: "update",
        descriptor: poison("Hash.update"),
      },
      {
        target: hashPrototype,
        key: "digest",
        descriptor: poison("Hash.digest"),
      },
      { target: Set.prototype, key: "has", descriptor: poison("Set.has") },
      {
        target: RegExp.prototype,
        key: "test",
        descriptor: poison("RegExp.test"),
      },
      {
        target: RegExp.prototype,
        key: "exec",
        descriptor: poison("RegExp.exec"),
      },
      {
        target: String.prototype,
        key: "includes",
        descriptor: poison("String.includes"),
      },
      {
        target: String.prototype,
        key: "charAt",
        descriptor: poison("String.charAt"),
      },
      {
        target: String.prototype,
        key: "charCodeAt",
        descriptor: poison("String.charCodeAt"),
      },
      {
        target: TextDecoder.prototype,
        key: "decode",
        descriptor: poison("TextDecoder.decode"),
      },
      {
        target: TextEncoder.prototype,
        key: "encode",
        descriptor: poison("TextEncoder.encode"),
      },
      {
        target: Number,
        key: "isFinite",
        descriptor: poison("Number.isFinite"),
      },
      {
        target: Number,
        key: "isSafeInteger",
        descriptor: poison("Number.isSafeInteger"),
      },
      { target: Promise, key: "all", descriptor: poison("Promise.all") },
      {
        target: Promise,
        key: "resolve",
        descriptor: poison("Promise.resolve"),
      },
      {
        target: Array.prototype,
        key: Symbol.iterator,
        descriptor: poison("Array iterator"),
      },
      {
        target: Array,
        key: "isArray",
        descriptor: poison("Array.isArray"),
      },
      {
        target: Object,
        key: "getPrototypeOf",
        descriptor: poison("Object.getPrototypeOf"),
      },
      {
        target: Object,
        key: "getOwnPropertyDescriptor",
        descriptor: poison("Object.getOwnPropertyDescriptor"),
      },
      {
        target: Object,
        key: "getOwnPropertyDescriptors",
        descriptor: poison("Object.getOwnPropertyDescriptors"),
      },
      {
        target: Object,
        key: "hasOwn",
        descriptor: poison("Object.hasOwn"),
      },
      { target: Object, key: "freeze", descriptor: poison("Object.freeze") },
      {
        target: Reflect,
        key: "apply",
        descriptor: poison("Reflect.apply"),
      },
      {
        target: Reflect,
        key: "ownKeys",
        descriptor: poison("Reflect.ownKeys"),
      },
      {
        target: utilTypes,
        key: "isPromise",
        descriptor: poison("util.types.isPromise"),
      },
      {
        target: utilTypes,
        key: "isProxy",
        descriptor: poison("util.types.isProxy"),
      },
      { target: path, key: "join", descriptor: poison("path.join") },
      { target: path, key: "dirname", descriptor: poison("path.dirname") },
      { target: path, key: "basename", descriptor: poison("path.basename") },
      { target: path, key: "resolve", descriptor: poison("path.resolve") },
      { target: fsPromises, key: "open", descriptor: poison("fs.open") },
      { target: fsPromises, key: "lstat", descriptor: poison("fs.lstat") },
      {
        target: fsPromises,
        key: "realpath",
        descriptor: poison("fs.realpath"),
      },
      { target: fs, key: "realpath", descriptor: poison("fs.realpath callback") },
      {
        target: realpathExact,
        key: "native",
        descriptor: poison("fs.realpath.native"),
      },
    ];

    const created = await withPoisonedProperties(poisons, async () => {
      const result = await store.persist(intentLeaf, intent);
      await store.close();
      return result;
    });

    expect(created).toMatchObject({
      publication: "created-durable",
      sha256: sha256(intent),
      canonicalPathExact: true,
      readbackExact: true,
    });
    expect(fs.readFileSync(path.join(root, intentLeaf), "utf8")).toBe(intent);
    for (const entry of poisons) {
      const poisoned = entry.descriptor.value;
      if (typeof poisoned === "function") expect(poisoned).not.toHaveBeenCalled();
    }
  });

  it("uses captured FileHandle methods and direct stat mode bits", async () => {
    const root = privateRoot();
    const probe = await fs.promises.open(root, fs.constants.O_RDONLY);
    const fileHandlePrototype = Object.getPrototypeOf(probe);
    await probe.close();
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
    const poison = (label: string): PropertyDescriptor => throwingValue(label);
    const poisons: PropertyPoison[] = [
      {
        target: fileHandlePrototype,
        key: "stat",
        descriptor: poison("FileHandle.stat"),
      },
      {
        target: fileHandlePrototype,
        key: "read",
        descriptor: poison("FileHandle.read"),
      },
      {
        target: fileHandlePrototype,
        key: "write",
        descriptor: poison("FileHandle.write"),
      },
      {
        target: fileHandlePrototype,
        key: "chmod",
        descriptor: poison("FileHandle.chmod"),
      },
      {
        target: fileHandlePrototype,
        key: "sync",
        descriptor: poison("FileHandle.sync"),
      },
      {
        target: fs.Stats.prototype,
        key: "isFile",
        descriptor: poison("Stats.isFile"),
      },
      {
        target: fs.Stats.prototype,
        key: "isDirectory",
        descriptor: poison("Stats.isDirectory"),
      },
      {
        target: fs.Stats.prototype,
        key: "isSymbolicLink",
        descriptor: poison("Stats.isSymbolicLink"),
      },
    ];

    const created = await withPoisonedProperties(poisons, async () => {
      const result = await store.persist(intentLeaf, intent);
      await store.close();
      return result;
    });
    expect(created).toMatchObject({
      publication: "created-durable",
      sha256: sha256(intent),
      identityHeld: true,
      readbackExact: true,
    });
    for (const entry of poisons) {
      expect(entry.descriptor.value).not.toHaveBeenCalled();
    }
  });

  it("does not capture poisoned native FileHandle methods as default authority", async () => {
    const root = privateRoot();
    const probe = await fs.promises.open(root, fs.constants.O_RDONLY);
    const prototype = Object.getPrototypeOf(probe) as object;
    await probe.close();
    const keys = ["stat", "read", "write", "chmod", "sync"] as const;
    const originals = keys.map((key) =>
      Object.getOwnPropertyDescriptor(prototype, key));
    const poisons = keys.map((key) => vi.fn(() => {
      throw new Error(`poisoned native FileHandle.${key}`);
    }));
    let store: Awaited<ReturnType<typeof openEvidenceStore>> | undefined;
    try {
      for (let index = 0; index < keys.length; index += 1) {
        Object.defineProperty(prototype, keys[index], {
          ...originals[index],
          value: poisons[index],
        });
      }
      store = await openEvidenceStore(root);
      await store.persist(intentLeaf, intent, NEVER_ABORTED_SIGNAL);
      await store.close();
    } finally {
      for (let index = 0; index < keys.length; index += 1) {
        const descriptor = originals[index];
        if (descriptor === undefined) Reflect.deleteProperty(prototype, keys[index]);
        else Object.defineProperty(prototype, keys[index], descriptor);
      }
    }
    await store?.close();
    for (const poison of poisons) expect(poison).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(root, intentLeaf), "utf8")).toBe(intent);
  });

  it.each([
    ["an empty value", ""],
    ["non-JSON", "not-json"],
    ["whitespace around JSON", ` ${intent}`],
    ["an array root", "[]"],
    ["duplicate keys", '{"a":1,"a":2}'],
    ["an unpaired surrogate", JSON.stringify({ value: "\ud800" }).replace("\\ud800", "\ud800")],
    [
      "more than 64 KiB",
      JSON.stringify({ value: "x".repeat(
        permanentStagingProviderVariableWriteEvidenceInternals.MAX_CANONICAL_CONTENT_BYTES,
      ) }),
    ],
  ])("rejects %s and remains usable", async (_label, value) => {
    const root = privateRoot();
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
    await expectCode(store.persist(intentLeaf, value), "evidence_invalid");
    await expect(store.persist(intentLeaf, intent)).resolves.toMatchObject({
      publication: "created-durable",
    });
    await store.close();
  });

  it("accepts canonical content at exactly the 64 KiB boundary", async () => {
    const root = privateRoot();
    const overhead = Buffer.byteLength('{"value":""}', "utf8");
    const value = JSON.stringify({
      value: "x".repeat(
        permanentStagingProviderVariableWriteEvidenceInternals.MAX_CANONICAL_CONTENT_BYTES
          - overhead,
      ),
    });
    expect(Buffer.byteLength(value, "utf8")).toBe(64 * 1_024);
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
    await expect(store.persist(terminalLeaf, value)).resolves.toMatchObject({
      sha256: sha256(value),
    });
    await store.close();
  });

  it.each([
    ["a relative parent", "relative/path"],
    ["the filesystem root", path.parse(process.cwd()).root],
  ])("rejects %s", async (_label, parent) => {
    await expectCode(
      openPermanentStagingProviderVariableWriteEvidenceStore(parent),
      "evidence_invalid",
    );
  });

  it("rejects a non-canonical, permissive, symlinked, or wrong-UID parent", async () => {
    const root = privateRoot();
    const permissive = privateRoot();
    fs.chmodSync(permissive, 0o755);
    const link = `${root}-link`;
    fs.symlinkSync(root, link);
    roots.push(link);
    await expectCode(
      openPermanentStagingProviderVariableWriteEvidenceStore(`${root}${path.sep}`),
      "evidence_invalid",
    );
    await expectCode(
      openPermanentStagingProviderVariableWriteEvidenceStore(permissive),
      "evidence_invalid",
    );
    await expectCode(
      openPermanentStagingProviderVariableWriteEvidenceStore(link),
      "evidence_invalid",
    );
    await expectCode(
      openPermanentStagingProviderVariableWriteEvidenceStore(root, {
        effectiveUid: () => process.geteuid!() + 1,
      }),
      "evidence_invalid",
    );
  });

  it("rejects leaves outside the fixed allowlist and remains usable", async () => {
    const root = privateRoot();
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
    await expectCode(
      store.persist("../replacement.json" as PermanentStagingProviderVariableWriteEvidenceLeaf, intent),
      "evidence_invalid",
    );
    await expectCode(
      store.read(
        "../replacement.json" as PermanentStagingProviderVariableWriteEvidenceLeaf,
      ),
      "evidence_invalid",
    );
    await expect(store.persist(intentLeaf, intent)).resolves.toMatchObject({
      publication: "created-durable",
    });
    await store.close();
  });

  it.each([
    ["symlink", (filePath: string, root: string) => {
      const target = path.join(root, "target.json");
      fs.writeFileSync(target, intent, { mode: 0o600 });
      fs.symlinkSync(target, filePath);
    }],
    ["hardlink", (filePath: string, root: string) => {
      fs.writeFileSync(filePath, intent, { mode: 0o600 });
      fs.linkSync(filePath, path.join(root, "retained.json"));
    }],
    ["wrong mode", (filePath: string) => {
      fs.writeFileSync(filePath, intent, { mode: 0o644 });
      fs.chmodSync(filePath, 0o644);
    }],
  ])("rejects an existing %s without replacing it", async (_label, setup) => {
    const root = privateRoot();
    const finalPath = path.join(root, intentLeaf);
    setup(finalPath, root);
    const before = fs.lstatSync(finalPath);
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
    await expectCode(store.persist(intentLeaf, intent), "evidence_invalid");
    await expectCode(store.read(intentLeaf), "evidence_invalid");
    const after = fs.lstatSync(finalPath);
    expect(after.ino).toBe(before.ino);
    await store.close();
  });

  it("read rejects non-canonical JSON at a fixed authoritative leaf", async () => {
    const root = privateRoot();
    const finalPath = path.join(root, terminalLeaf);
    fs.writeFileSync(finalPath, ` ${intent}`, { mode: 0o600 });
    fs.chmodSync(finalPath, 0o600);
    const before = fs.lstatSync(finalPath);
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
    await expectCode(store.read(terminalLeaf), "evidence_invalid");
    const after = fs.lstatSync(finalPath);
    expect(after.ino).toBe(before.ino);
    expect(fs.readFileSync(finalPath, "utf8")).toBe(` ${intent}`);
    await store.close();
  });

  it("handles a matching concurrent publication as existing-exact", async () => {
    const root = privateRoot();
    const finalPath = path.join(root, intentLeaf);
    let concurrentCreate = true;
    const open: PermanentStagingProviderVariableWriteEvidenceDependencies["open"] = async (
      filename,
      flags,
      mode,
    ) => {
      if (mode === 0o600 && concurrentCreate) {
        concurrentCreate = false;
        fs.writeFileSync(finalPath, intent, { flag: "wx", mode: 0o600 });
        fs.chmodSync(finalPath, 0o600);
        throw errno("EEXIST");
      }
      return mode === undefined
        ? fs.promises.open(filename, flags)
        : fs.promises.open(filename, flags, mode);
    };
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, { open });
    const result = await store.persist(intentLeaf, intent);
    expect(result).toMatchObject({
      publication: "existing-exact",
      exclusiveCreate: false,
      sha256: sha256(intent),
    });
    expect(concurrentCreate).toBe(false);
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);
    await store.close();
  });

  it("fails closed on a partial concurrent creator without changing it", async () => {
    const root = privateRoot();
    const finalPath = path.join(root, intentLeaf);
    const partial = intent.slice(0, 11);
    let concurrentCreate = true;
    const open: PermanentStagingProviderVariableWriteEvidenceDependencies["open"] = async (
      filename,
      flags,
      mode,
    ) => {
      if (mode === 0o600 && concurrentCreate) {
        concurrentCreate = false;
        fs.writeFileSync(finalPath, partial, { flag: "wx", mode: 0o600 });
        fs.chmodSync(finalPath, 0o600);
        throw errno("EEXIST");
      }
      return mode === undefined
        ? fs.promises.open(filename, flags)
        : fs.promises.open(filename, flags, mode);
    };
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, { open });
    await expectCode(store.persist(intentLeaf, intent), "evidence_invalid");
    expect(fs.readFileSync(finalPath, "utf8")).toBe(partial);
    await expectCode(store.persist(intentLeaf, intent), "evidence_invalid");
    expect(fs.readFileSync(finalPath, "utf8")).toBe(partial);
    await store.close();
  });

  it("treats an ambiguous success-then-error final open as cleanup_failed", async () => {
    const root = privateRoot();
    const finalPath = path.join(root, intentLeaf);
    let injected = false;
    const open: PermanentStagingProviderVariableWriteEvidenceDependencies["open"] = async (
      filename,
      flags,
      mode,
    ) => {
      const handle = mode === undefined
        ? await fs.promises.open(filename, flags)
        : await fs.promises.open(filename, flags, mode);
      if (mode === 0o600 && !injected) {
        injected = true;
        await handle.close();
        throw errno("EIO");
      }
      return handle;
    };
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, { open });
    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);
    expect(fs.lstatSync(finalPath).size).toBe(0);
    await expectCode(store.persist(intentLeaf, intent), "evidence_invalid");
    await store.close();
  });

  it("makes zero unlink calls on every path by exposing no unlink capability", () => {
    const source = fs.readFileSync(path.resolve(
      "scripts/lib/permanent-staging-provider-variable-write-evidence.ts",
    ), "utf8");
    expect(source).not.toMatch(/\bunlink\b/u);
    expect(source).not.toMatch(/FS_(?:LINK|UNLINK)/u);
    expect(source).not.toMatch(/dependencies\.(?:link|unlink)\b/u);
    expect(source).not.toMatch(/readonly\s+(?:link|unlink)\s*:/u);
    expect(source).not.toMatch(/FS_PROMISES\.(?:link|unlink)\b/u);
  });

  it("reports parent fsync ambiguity after publication and preserves the final", async () => {
    const root = privateRoot();
    const syncHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
      const stat = await handle.stat();
      if (stat.isDirectory()) throw errno("EIO");
      await handle.sync();
    });
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, {
      syncHandle,
    });
    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(fs.readFileSync(path.join(root, intentLeaf), "utf8")).toBe(intent);
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);
    await store.close();
  });

  it("retains the exact final artifact when file fsync fails after the write", async () => {
    const root = privateRoot();
    const syncHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
      const stat = await handle.stat();
      if (stat.isFile()) throw errno("EIO");
      await handle.sync();
    });
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, {
      syncHandle,
    });
    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(fs.readFileSync(path.join(root, intentLeaf), "utf8")).toBe(intent);
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);
    await store.close();
  });

  it("normalizes an unexpected filesystem failure", async () => {
    const inspectRoot = privateRoot();
    let realpathCalls = 0;
    const inspectStore = await openPermanentStagingProviderVariableWriteEvidenceStore(
      inspectRoot,
      {
        realpath: async (filename) => {
          realpathCalls += 1;
          if (realpathCalls > 1) throw new Error(`raw-${intent}`);
          return fs.promises.realpath(filename);
        },
      },
    );
    await expectCode(
      inspectStore.inspect(intentLeaf, intent),
      "evidence_invalid",
    );
    await expectCode(inspectStore.close(), "cleanup_failed");
  });

  it("retains the final artifact when its descriptor close reports failure", async () => {
    const root = privateRoot();
    let failed = false;
    const closeHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
      const stat = await handle.stat();
      await handle.close();
      if (stat.isFile() && !failed) {
        failed = true;
        throw errno("EIO");
      }
    });
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, {
      closeHandle,
    });
    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(fs.readFileSync(path.join(root, intentLeaf), "utf8")).toBe(intent);
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);
    await store.close();
  });

  it("detects parent replacement across calls and closes with cleanup precedence", async () => {
    const root = privateRoot();
    const original = `${root}-original`;
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root);
    fs.renameSync(root, original);
    fs.mkdirSync(root, { mode: 0o700 });
    fs.chmodSync(root, 0o700);
    await expectCode(store.persist(intentLeaf, intent), "evidence_invalid");
    await expectCode(store.close(), "cleanup_failed");
  });

  it("reports parent descriptor close failure as cleanup_failed", async () => {
    const root = privateRoot();
    const closeHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
      const stat = await handle.stat();
      if (stat.isDirectory()) throw errno("EIO");
      await handle.close();
    });
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, {
      closeHandle,
    });
    await store.persist(intentLeaf, intent);
    await expectCode(store.close(), "cleanup_failed");
    await expectCode(store.close(), "cleanup_failed");
  });

  it("makes concurrent close callers await the same exact settlement", async () => {
    const root = privateRoot();
    const closeStarted = deferred<void>();
    const allowClose = deferred<void>();
    const closeHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
      const stat = await handle.stat();
      if (stat.isDirectory()) {
        closeStarted.resolve();
        await allowClose.promise;
      }
      await handle.close();
    });
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, {
      closeHandle,
    });
    const first = store.close();
    await closeStarted.promise;
    let secondSettled = false;
    const second = store.close().then(() => {
      secondSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    allowClose.resolve();
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
    expect(closeHandle).toHaveBeenCalledTimes(1);
  });

  it("uses fixed errors without paths or raw filesystem details", () => {
    const failure = new PermanentStagingProviderVariableWriteEvidenceError("cleanup_failed");
    expect(failure.message).toBe("cleanup_failed");
    expect(JSON.stringify(failure)).not.toContain(os.tmpdir());
  });

  it("rejects override accessors without invoking them", async () => {
    const root = privateRoot();
    const getter = vi.fn(() => {
      throw new Error("secret-from-override-getter");
    });
    const overrides = {} as Partial<
      PermanentStagingProviderVariableWriteEvidenceDependencies
    >;
    Object.defineProperty(overrides, "open", {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    await expectCode(openEvidenceStore(root, overrides), "evidence_invalid");
    expect(getter).not.toHaveBeenCalled();
  });

  it("normalizes constructor-forged and proxied dependency failures into fresh fixed errors", async () => {
    const root = privateRoot();
    const hostile = new PermanentStagingProviderVariableWriteEvidenceError(
      "cleanup_failed",
    );
    hostile.message = "secret-from-mutated-branded-error";
    const codeGetter = vi.fn(() => {
      throw new Error("secret-from-code-getter");
    });
    Object.defineProperty(hostile, "code", {
      configurable: true,
      enumerable: true,
      get: codeGetter,
    });
    let brandedResult: unknown;
    try {
      await openEvidenceStore(root, {
        realpath: async () => {
          throw hostile;
        },
      });
    } catch (error) {
      brandedResult = error;
    }
    expect(brandedResult).not.toBe(hostile);
    expect(brandedResult).toMatchObject({
      code: "evidence_invalid",
      message: "evidence_invalid",
    });
    expect(codeGetter).not.toHaveBeenCalled();
    expect(JSON.stringify(brandedResult)).not.toContain("secret-from");

    let lstatCalls = 0;
    const proxyTrap = vi.fn(() => {
      throw new Error("secret-from-error-proxy");
    });
    const hostileProxy = new Proxy({}, {
      get: proxyTrap,
      getOwnPropertyDescriptor: proxyTrap,
      getPrototypeOf: proxyTrap,
      ownKeys: proxyTrap,
    });
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(
      root,
      {
        lstat: async (filename) => {
          lstatCalls += 1;
          if (lstatCalls === 2) throw hostileProxy;
          return fs.promises.lstat(filename, { bigint: true });
        },
      },
    );
    let proxyResult: unknown;
    try {
      await store.read(intentLeaf);
    } catch (error) {
      proxyResult = error;
    }
    expect(proxyResult).toMatchObject({
      code: "evidence_invalid",
      message: "evidence_invalid",
    });
    expect(proxyTrap).not.toHaveBeenCalled();
    expect(JSON.stringify(proxyResult)).not.toContain("secret-from");
    await store.close();
  });

  it("uses a private fixed-error classifier and bypasses poisoned name setters", async () => {
    const root = privateRoot();
    const ErrorConstructor = PermanentStagingProviderVariableWriteEvidenceError;
    const originalFixedCode = Object.getOwnPropertyDescriptor(
      ErrorConstructor,
      "fixedCode",
    );
    const originalName = Object.getOwnPropertyDescriptor(
      ErrorConstructor.prototype,
      "name",
    );
    const staticPoison = vi.fn(() => "cleanup_failed");
    const nameSetter = vi.fn(() => {
      throw new Error("poisoned evidence error name setter");
    });
    Object.defineProperties(ErrorConstructor, {
      fixedCode: {
        configurable: true,
        value: staticPoison,
        writable: true,
      },
    });
    Object.defineProperty(ErrorConstructor.prototype, "name", {
      configurable: true,
      set: nameSetter,
    });
    let failure: unknown;
    try {
      await openEvidenceStore(root, {
        realpath: async () => {
          throw new Error("unsafe dependency detail");
        },
      });
    } catch (error) {
      failure = error;
    } finally {
      restoreOwnProperty(ErrorConstructor, "fixedCode", originalFixedCode);
      restoreOwnProperty(ErrorConstructor.prototype, "name", originalName);
    }
    expect(staticPoison).not.toHaveBeenCalled();
    expect(nameSetter).not.toHaveBeenCalled();
    expect(failure).toMatchObject({
      name: "PermanentStagingProviderVariableWriteEvidenceError",
      code: "evidence_invalid",
      message: "evidence_invalid",
    });
  });

  it("requests O_RDWR, O_CREAT, O_EXCL, and O_NOFOLLOW for the final leaf", async () => {
    const root = privateRoot();
    const opened: Array<{ filename: string; flags: number; mode?: number }> = [];
    const open: PermanentStagingProviderVariableWriteEvidenceDependencies["open"] = async (
      filename,
      flags,
      mode,
    ) => {
      opened.push({ filename, flags, ...(mode === undefined ? {} : { mode }) });
      return mode === undefined
        ? fs.promises.open(filename, flags)
        : fs.promises.open(filename, flags, mode);
    };
    const store = await openPermanentStagingProviderVariableWriteEvidenceStore(root, { open });
    await store.persist(intentLeaf, intent);
    await store.close();
    const final = opened.find((entry) => entry.filename === path.join(root, intentLeaf));
    expect(final).toMatchObject({ mode: 0o600 });
    expect(final!.flags & fs.constants.O_RDWR).toBe(fs.constants.O_RDWR);
    expect(final!.flags & fs.constants.O_CREAT).toBe(fs.constants.O_CREAT);
    expect(final!.flags & fs.constants.O_EXCL).toBe(fs.constants.O_EXCL);
    expect(final!.flags & fs.constants.O_NOFOLLOW).toBe(
      fs.constants.O_NOFOLLOW,
    );
    const parent = opened.find((entry) => entry.filename === root);
    expect(fs.constants.O_NOFOLLOW).toBeGreaterThan(0);
    expect(fs.constants.O_DIRECTORY).toBeGreaterThan(0);
    expect(parent!.flags & fs.constants.O_NOFOLLOW).toBe(
      fs.constants.O_NOFOLLOW,
    );
    expect(parent!.flags & fs.constants.O_DIRECTORY).toBe(
      fs.constants.O_DIRECTORY,
    );
  });
});
