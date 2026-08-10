import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  STAGING_POSTGRES_BUILD_CANARY_EVIDENCE_LEAVES,
  StagingPostgresBuildCanaryEvidenceError,
  openStagingPostgresBuildCanaryEvidenceStore,
  stagingPostgresBuildCanaryEvidenceInternals,
  type StagingPostgresBuildCanaryEvidenceDependencies,
  type StagingPostgresBuildCanaryEvidenceLeaf,
} from "../scripts/lib/staging-postgres-build-canary-evidence.js";

const roots: string[] = [];
const intentLeaf = STAGING_POSTGRES_BUILD_CANARY_EVIDENCE_LEAVES.intent;
const terminalLeaf =
  STAGING_POSTGRES_BUILD_CANARY_EVIDENCE_LEAVES.terminalEvidence;
const intent = JSON.stringify({
  schemaVersion: "pintpath-staging-postgres-build-canary-intent/v1",
  operation: "staging-postgres-build-canary-upload",
  sequentialNotAtomic: true,
});
const alternateIntent = JSON.stringify({
  schemaVersion: "pintpath-staging-postgres-build-canary-intent/v1",
  operation: "staging-postgres-build-canary-upload",
  sequentialNotAtomic: false,
});

function privateRoot(): string {
  const created = fs.mkdtempSync(
    path.join(os.tmpdir(), "pintpath-build-canary-evidence-test-"),
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
    name: "StagingPostgresBuildCanaryEvidenceError",
    code,
    message: code,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${root}-original`, { recursive: true, force: true });
  }
});

describe("staging Postgres build-canary durable evidence", () => {
  it("publishes one private durable leaf without overwriting and holds the parent", async () => {
    const root = privateRoot();
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root);
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
    expect(fs.readFileSync(finalPath, "utf8")).toBe(intent);
    await store.close();
  });

  it("returns null for an absent inspected leaf without creating anything", async () => {
    const root = privateRoot();
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root);
    await expect(store.inspect(terminalLeaf, intent)).resolves.toBeNull();
    expect(fs.readdirSync(root)).toEqual([]);
    await store.close();
  });

  it("rejects existing content drift without changing the authoritative leaf", async () => {
    const root = privateRoot();
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root);
    await store.persist(intentLeaf, intent);
    await expectCode(store.persist(intentLeaf, alternateIntent), "evidence_invalid");
    await expectCode(store.inspect(intentLeaf, alternateIntent), "evidence_invalid");
    expect(fs.readFileSync(path.join(root, intentLeaf), "utf8")).toBe(intent);
    await store.close();
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
        stagingPostgresBuildCanaryEvidenceInternals.MAX_CANONICAL_CONTENT_BYTES,
      ) }),
    ],
  ])("rejects %s and remains usable", async (_label, value) => {
    const root = privateRoot();
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root);
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
        stagingPostgresBuildCanaryEvidenceInternals.MAX_CANONICAL_CONTENT_BYTES
          - overhead,
      ),
    });
    expect(Buffer.byteLength(value, "utf8")).toBe(64 * 1_024);
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root);
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
      openStagingPostgresBuildCanaryEvidenceStore(parent),
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
      openStagingPostgresBuildCanaryEvidenceStore(`${root}${path.sep}`),
      "evidence_invalid",
    );
    await expectCode(
      openStagingPostgresBuildCanaryEvidenceStore(permissive),
      "evidence_invalid",
    );
    await expectCode(
      openStagingPostgresBuildCanaryEvidenceStore(link),
      "evidence_invalid",
    );
    await expectCode(
      openStagingPostgresBuildCanaryEvidenceStore(root, {
        effectiveUid: () => process.geteuid!() + 1,
      }),
      "evidence_invalid",
    );
  });

  it("rejects leaves outside the fixed allowlist and remains usable", async () => {
    const root = privateRoot();
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root);
    await expectCode(
      store.persist("../replacement.json" as StagingPostgresBuildCanaryEvidenceLeaf, intent),
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
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root);
    await expectCode(store.persist(intentLeaf, intent), "evidence_invalid");
    const after = fs.lstatSync(finalPath);
    expect(after.ino).toBe(before.ino);
    await store.close();
  });

  it("handles a matching concurrent publication as existing-exact", async () => {
    const root = privateRoot();
    const link = vi.fn(async (temporaryPath: string, finalPath: string) => {
      fs.copyFileSync(temporaryPath, finalPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(finalPath, 0o600);
      throw errno("EEXIST");
    });
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, { link });
    const result = await store.persist(intentLeaf, intent);
    expect(result).toMatchObject({
      publication: "existing-exact",
      exclusiveCreate: false,
      sha256: sha256(intent),
    });
    expect(link).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);
    await store.close();
  });

  it("leaves a colliding foreign temporary leaf untouched", async () => {
    const root = privateRoot();
    const random = Buffer.alloc(16, 0xcd);
    const temporaryPath = path.join(
      root,
      `.${intentLeaf}.${random.toString("hex")}.tmp`,
    );
    const foreign = "foreign-private-content";
    fs.writeFileSync(temporaryPath, foreign, { mode: 0o600 });
    const before = fs.lstatSync(temporaryPath);
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, {
      randomBytes: () => Buffer.from(random),
    });
    await expectCode(store.persist(intentLeaf, intent), "evidence_invalid");
    const after = fs.lstatSync(temporaryPath);
    expect(after.ino).toBe(before.ino);
    expect(fs.readFileSync(temporaryPath, "utf8")).toBe(foreign);
    await store.close();
  });

  it("treats an ambiguous success-then-error temporary open as cleanup_failed", async () => {
    const root = privateRoot();
    let injected = false;
    const open: StagingPostgresBuildCanaryEvidenceDependencies["open"] = async (
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
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, { open });
    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(fs.readdirSync(root).some((entry) => entry.endsWith(".tmp"))).toBe(true);
    await store.close();
  });

  it("cleans its exact temporary leaf when publication fails before linking", async () => {
    const root = privateRoot();
    const link = vi.fn(async () => {
      throw errno("EPERM");
    });
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, { link });
    await expectCode(store.persist(intentLeaf, intent), "evidence_invalid");
    expect(fs.readdirSync(root)).toEqual([]);
    await store.close();
  });

  it("closes its held temp descriptor when cleanup inspection fails", async () => {
    const root = privateRoot();
    let publicationFailed = false;
    const lstat: StagingPostgresBuildCanaryEvidenceDependencies["lstat"] = async (
      filename,
    ) => {
      if (publicationFailed && filename.endsWith(".tmp")) throw errno("EIO");
      return fs.promises.lstat(filename, { bigint: true });
    };
    const link = vi.fn(async () => {
      publicationFailed = true;
      throw errno("EPERM");
    });
    const closedFiles: bigint[] = [];
    const closeHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
      const stat = await handle.stat({ bigint: true });
      if (stat.isFile()) closedFiles.push(stat.ino);
      await handle.close();
    });
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, {
      closeHandle,
      link,
      lstat,
    });
    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(closedFiles).toHaveLength(2);
    expect(closedFiles[0]).toBe(closedFiles[1]);
    expect(fs.readdirSync(root).some((entry) => entry.endsWith(".tmp"))).toBe(true);
    await store.close();
  });

  it("treats a link that succeeded but returned an error as cleanup_failed", async () => {
    const root = privateRoot();
    const link = vi.fn(async (temporaryPath: string, finalPath: string) => {
      fs.linkSync(temporaryPath, finalPath);
      throw errno("EIO");
    });
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, { link });
    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(fs.readFileSync(path.join(root, intentLeaf), "utf8")).toBe(intent);
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);
    await store.close();
  });

  it("never removes a replacement final or an ambiguous temporary leaf", async () => {
    const root = privateRoot();
    const replacement = alternateIntent;
    const link = vi.fn(async (temporaryPath: string, finalPath: string) => {
      fs.linkSync(temporaryPath, finalPath);
      fs.unlinkSync(finalPath);
      fs.writeFileSync(finalPath, replacement, { mode: 0o600 });
    });
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, { link });
    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(fs.readFileSync(path.join(root, intentLeaf), "utf8")).toBe(replacement);
    expect(fs.readdirSync(root).some((entry) => entry.endsWith(".tmp"))).toBe(true);
    await store.close();
  });

  it("gives temporary unlink failure precedence and never removes the final", async () => {
    const root = privateRoot();
    const unlink = vi.fn(async () => {
      throw errno("EIO");
    });
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, { unlink });
    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(fs.readFileSync(path.join(root, intentLeaf), "utf8")).toBe(intent);
    expect(fs.readdirSync(root).some((entry) => entry.endsWith(".tmp"))).toBe(true);
    await store.close();
  });

  it("reports parent fsync ambiguity after publication and preserves the final", async () => {
    const root = privateRoot();
    const syncHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
      const stat = await handle.stat();
      if (stat.isDirectory()) throw errno("EIO");
      await handle.sync();
    });
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, {
      syncHandle,
    });
    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(fs.readFileSync(path.join(root, intentLeaf), "utf8")).toBe(intent);
    expect(fs.readdirSync(root)).toEqual([intentLeaf]);
    await store.close();
  });

  it("cleans only its exact temporary inode when file fsync fails", async () => {
    const root = privateRoot();
    const syncHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
      const stat = await handle.stat();
      if (stat.isFile()) throw errno("EIO");
      await handle.sync();
    });
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, {
      syncHandle,
    });
    await expectCode(store.persist(intentLeaf, intent), "evidence_invalid");
    expect(fs.readdirSync(root)).toEqual([]);
    await store.close();
  });

  it("normalizes unexpected filesystem and randomness failures", async () => {
    const inspectRoot = privateRoot();
    let realpathCalls = 0;
    const inspectStore = await openStagingPostgresBuildCanaryEvidenceStore(
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

    const persistRoot = privateRoot();
    const persistStore = await openStagingPostgresBuildCanaryEvidenceStore(
      persistRoot,
      {
        randomBytes: () => {
          throw new Error(`raw-${intent}`);
        },
      },
    );
    await expectCode(
      persistStore.persist(intentLeaf, intent),
      "evidence_invalid",
    );
    expect(fs.readdirSync(persistRoot)).toEqual([]);
    await persistStore.close();
  });

  it("makes a temporary descriptor close failure dominate the original result", async () => {
    const root = privateRoot();
    let failed = false;
    const closeHandle = vi.fn(async (handle: fs.promises.FileHandle) => {
      const stat = await handle.stat();
      if (stat.isFile() && !failed) {
        failed = true;
        throw errno("EIO");
      }
      await handle.close();
    });
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, {
      closeHandle,
    });
    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(fs.readdirSync(root)).toEqual([]);
    await store.close();
  });

  it("removes the exact temp after a close succeeds and then reports failure", async () => {
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
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, {
      closeHandle,
    });
    await expectCode(store.persist(intentLeaf, intent), "cleanup_failed");
    expect(fs.readdirSync(root)).toEqual([]);
    await store.close();
  });

  it("detects parent replacement across calls and closes with cleanup precedence", async () => {
    const root = privateRoot();
    const original = `${root}-original`;
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root);
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
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, {
      closeHandle,
    });
    await store.persist(intentLeaf, intent);
    await expectCode(store.close(), "cleanup_failed");
  });

  it("uses fixed errors without paths or raw filesystem details", () => {
    const failure = new StagingPostgresBuildCanaryEvidenceError("cleanup_failed");
    expect(failure.message).toBe("cleanup_failed");
    expect(JSON.stringify(failure)).not.toContain(os.tmpdir());
  });

  it("requests O_NOFOLLOW and O_EXCL for the random private temporary leaf", async () => {
    const root = privateRoot();
    const opened: Array<{ filename: string; flags: number; mode?: number }> = [];
    const open: StagingPostgresBuildCanaryEvidenceDependencies["open"] = async (
      filename,
      flags,
      mode,
    ) => {
      opened.push({ filename, flags, ...(mode === undefined ? {} : { mode }) });
      return mode === undefined
        ? fs.promises.open(filename, flags)
        : fs.promises.open(filename, flags, mode);
    };
    const store = await openStagingPostgresBuildCanaryEvidenceStore(root, {
      open,
      randomBytes: () => Buffer.alloc(16, 0xab),
    });
    await store.persist(intentLeaf, intent);
    await store.close();
    const temporary = opened.find((entry) => entry.filename.endsWith(".tmp"));
    expect(temporary).toMatchObject({ mode: 0o600 });
    expect(temporary!.flags & fs.constants.O_WRONLY).toBe(fs.constants.O_WRONLY);
    expect(temporary!.flags & fs.constants.O_CREAT).toBe(fs.constants.O_CREAT);
    expect(temporary!.flags & fs.constants.O_EXCL).toBe(fs.constants.O_EXCL);
    expect(temporary!.flags & fs.constants.O_NOFOLLOW).toBe(
      fs.constants.O_NOFOLLOW,
    );
  });
});
