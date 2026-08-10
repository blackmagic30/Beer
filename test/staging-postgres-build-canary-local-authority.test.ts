import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

interface LocalAuthorityModule {
  readonly STAGING_POSTGRES_BUILD_CANARY_SOURCE_MANIFEST_ALGORITHM: string;
  readonly STAGING_POSTGRES_BUILD_CANARY_LOCAL_AUTHORITY_TRUST_BOUNDARY: string;
  readonly STAGING_POSTGRES_BUILD_CANARY_LOCAL_AUTHORITY_ACTIVATION_BLOCKER: string;
  readonly StagingPostgresBuildCanaryLocalAuthorityError: new (
    code: "local_authority_invalid" | "cleanup_failed",
  ) => Error & { readonly code: string };
  readonly openStagingPostgresBuildCanaryLocalAuthority: (
    sourceRoot: string,
  ) => Promise<{
    inspect(signal?: AbortSignal): Promise<Record<string, unknown>>;
    close(): Promise<void>;
  }>;
}

const PRIVATE_TMP = "/private/tmp";
const retainedSource =
  "/private/tmp/pintpath-postgres-ca-canary-b14bf9a.eyZ3Mp";

let sourceRoot = "";
let binaryRoot = "";
let binaryPath = "";
let binarySha256 = "";
let authorityModule: LocalAuthorityModule;

async function writeFile(
  filename: string,
  content: string,
  mode: 0o600 | 0o700,
): Promise<void> {
  await fs.promises.writeFile(filename, content, { mode, flag: "wx" });
  await fs.promises.chmod(filename, mode);
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function freshAuthority() {
  return await authorityModule.openStagingPostgresBuildCanaryLocalAuthority(
    sourceRoot,
  );
}

beforeAll(async () => {
  if (process.platform !== "darwin") return;
  sourceRoot = await fs.promises.mkdtemp(
    path.join(PRIVATE_TMP, "pintpath-local-authority-source."),
  );
  binaryRoot = await fs.promises.mkdtemp(
    path.join(PRIVATE_TMP, "pintpath-local-authority-binary."),
  );
  await fs.promises.chmod(sourceRoot, 0o700);
  await fs.promises.chmod(binaryRoot, 0o700);
  await writeFile(path.join(sourceRoot, "a.txt"), "abc", 0o600);
  await fs.promises.mkdir(path.join(sourceRoot, "nested"), { mode: 0o700 });
  await fs.promises.chmod(path.join(sourceRoot, "nested"), 0o700);
  await writeFile(
    path.join(sourceRoot, "nested", "run.sh"),
    "#!/bin/sh\nexit 0\n",
    0o700,
  );
  binaryPath = path.join(binaryRoot, "railway");
  const binaryBytes = Buffer.from("reviewed-test-railway-binary\n", "utf8");
  await fs.promises.writeFile(binaryPath, binaryBytes, { mode: 0o555, flag: "wx" });
  await fs.promises.chmod(binaryPath, 0o555);
  binarySha256 = sha256(binaryBytes);

  vi.resetModules();
  vi.doMock(
    "../scripts/lib/staging-postgres-build-canary-executor.js",
    () => ({
      STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK: Object.freeze({
        expectedNodeVersion: process.version,
        railwayBinary: binaryPath,
        railwayBinarySha256: binarySha256,
        railwayVersion: "5.32.0",
      }),
    }),
  );
  authorityModule = await import(
    "../scripts/lib/staging-postgres-build-canary-local-authority.js"
  ) as LocalAuthorityModule;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  vi.doUnmock("../scripts/lib/staging-postgres-build-canary-executor.js");
  vi.resetModules();
  for (const directory of [sourceRoot, binaryRoot]) {
    if (directory.length === 0) continue;
    await fs.promises.rm(directory, { recursive: true, force: false });
  }
});

describe.skipIf(process.platform !== "darwin")(
  "staging Postgres build canary local authority",
  () => {
    it("exports only the fixed public authority surface", async () => {
      const runtime = await import(
        "../scripts/lib/staging-postgres-build-canary-local-authority.js"
      );
      expect(Object.keys(runtime).sort()).toEqual([
        "STAGING_POSTGRES_BUILD_CANARY_LOCAL_AUTHORITY_ACTIVATION_BLOCKER",
        "STAGING_POSTGRES_BUILD_CANARY_LOCAL_AUTHORITY_TRUST_BOUNDARY",
        "STAGING_POSTGRES_BUILD_CANARY_SOURCE_MANIFEST_ALGORITHM",
        "StagingPostgresBuildCanaryLocalAuthorityError",
        "openStagingPostgresBuildCanaryLocalAuthority",
      ]);
      expect(runtime).not.toHaveProperty("openWithDependencies");
      expect(runtime).not.toHaveProperty(
        "stagingPostgresBuildCanaryLocalAuthorityInternals",
      );
    });

    it("returns narrowly scoped structural evidence without executing Railway", async () => {
      const authority = await freshAuthority();
      const result = await authority.inspect();
      const entries = [
        ["a.txt", "f", 0o600, 3, sha256("abc")],
        ["nested", "d", 0o700, 0, null],
        [
          "nested/run.sh",
          "f",
          0o700,
          Buffer.byteLength("#!/bin/sh\nexit 0\n"),
          sha256("#!/bin/sh\nexit 0\n"),
        ],
      ];
      expect(result).toEqual({
        nodeVersion: process.version,
        trustBoundary: "hostile-current-uid-and-privileged-actors-excluded",
        activationBlocker: "acl-free-source-and-ancestor-authority-required",
        sourceDirectoryAbsolute: true,
        sourceDirectoryCanonical: true,
        sourceDirectChildOfPrivateTmp: true,
        sourceRootCurrentUid: true,
        sourceRootMode0700: true,
        sourceRootNonSymlink: true,
        sourceRootSameDeviceAsPrivateTmp: true,
        privateTmpRootOwnedSticky01777: true,
        privateAncestorsRootOwnedNonWritable: true,
        sourceRootIdentityHeldWithinTrustedCurrentUidBoundary: true,
        sourceRootIdentityReassertedWithinTrustedCurrentUidBoundary: true,
        sourcePathObservationWithinTrustedCurrentUidBoundary: true,
        sourceTreeSnapshotAtomic: false,
        sourceAclAuthorityInspected: false,
        sourceManifestSha256: sha256(JSON.stringify(entries)),
        sourceManifestAlgorithm:
          "sha256-json-depth-first-bytewise-siblings-path-type-mode-size-content-v1",
        sourceEntryCount: 3,
        sourceDirectoryCount: 1,
        sourceFileCount: 2,
        sourceFileBytes: 20,
        railwayVersion: "5.32.0",
        railwayVersionProvenance: "reviewed-binary-sha256-lock",
        railwayBinary: binaryPath,
        railwayBinarySha256: binarySha256,
        railwayBinaryBytesObservedAtInspection: true,
        railwayBinaryPathReassertedAtInspection: true,
        railwayBinaryMode0555AtInspection: true,
        railwayBinaryAclAuthorityInspected: false,
        railwayBinaryExecuted: false,
      });
      await authority.close();
      await authority.close();
    });

    it.each([
      ["wrong temporary root", () => "/tmp/not-private"],
      ["nested source", () => path.join(sourceRoot, "nested")],
      [
        "noncanonical source",
        () => `${sourceRoot}/../${path.basename(sourceRoot)}`,
      ],
      ["relative source", () => "relative/source"],
      ["filesystem root", () => "/"],
    ])("rejects a source outside the exact direct-child boundary: %s", async (_label, makeValue) => {
      const value = makeValue();
      await expect(
        authorityModule.openStagingPostgresBuildCanaryLocalAuthority(value),
      ).rejects.toMatchObject({ code: "local_authority_invalid" });
    });

    it("rejects source mode drift", async () => {
      await fs.promises.chmod(sourceRoot, 0o755);
      try {
        await expect(freshAuthority()).rejects.toMatchObject({
          code: "local_authority_invalid",
        });
      } finally {
        await fs.promises.chmod(sourceRoot, 0o700);
      }
    });

    it("rejects execution as root", async () => {
      vi.spyOn(process, "geteuid").mockReturnValue(0);
      await expect(freshAuthority()).rejects.toMatchObject({
        code: "local_authority_invalid",
      });
    });

    it("rejects a symlinked source", async () => {
      const link = path.join(PRIVATE_TMP, `pintpath-authority-link-${process.pid}`);
      await fs.promises.symlink(sourceRoot, link);
      try {
        await expect(
          authorityModule.openStagingPostgresBuildCanaryLocalAuthority(link),
        ).rejects.toMatchObject({ code: "local_authority_invalid" });
      } finally {
        await fs.promises.unlink(link);
      }
    });

    it("does not swallow a null directory-iteration failure", async () => {
      const original = fs.promises.opendir;
      vi.spyOn(fs.promises, "opendir").mockImplementation(async (filename, options) => {
        if (filename === sourceRoot) throw null;
        return await original(filename, options);
      });
      const authority = await freshAuthority();
      await expect(authority.inspect()).rejects.toMatchObject({
        code: "local_authority_invalid",
      });
      await authority.close();
    });

    it("does not swallow an undefined child-open failure", async () => {
      const original = fs.promises.open;
      vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        if (args[0] === path.join(sourceRoot, "a.txt")) throw undefined;
        return await original(...args);
      });
      const authority = await freshAuthority();
      await expect(authority.inspect()).rejects.toMatchObject({
        code: "local_authority_invalid",
      });
      await authority.close();
    });

    it("bounds directory iteration before opening any child", async () => {
      const original = fs.promises.opendir;
      let reads = 0;
      vi.spyOn(fs.promises, "opendir").mockImplementation(async (filename, options) => {
        if (filename !== sourceRoot) return await original(filename, options);
        return {
          async read() {
            reads += 1;
            return { name: Buffer.from(`entry-${reads}`, "utf8") };
          },
          async close() {},
        } as unknown as fs.Dir;
      });
      const authority = await freshAuthority();
      await expect(authority.inspect()).rejects.toMatchObject({
        code: "local_authority_invalid",
      });
      expect(reads).toBe(4_097);
      await authority.close();
    });

    it("poisons the handle after a directory cleanup failure", async () => {
      const original = fs.promises.opendir;
      let retained: fs.Dir | undefined;
      vi.spyOn(fs.promises, "opendir").mockImplementation(async (filename, options) => {
        const directory = await original(filename, options);
        if (filename === sourceRoot) {
          retained = directory;
          const close = directory.close.bind(directory);
          let first = true;
          vi.spyOn(directory, "close").mockImplementation(async () => {
            if (first) {
              first = false;
              throw undefined;
            }
            await close();
          });
        }
        return directory;
      });
      const authority = await freshAuthority();
      await expect(authority.inspect()).rejects.toMatchObject({
        code: "cleanup_failed",
      });
      await expect(authority.inspect()).rejects.toMatchObject({
        code: "local_authority_invalid",
      });
      await expect(authority.close()).rejects.toMatchObject({
        code: "cleanup_failed",
      });
      expect(retained).toBeDefined();
    });

    it("rejects an already-aborted inspection without opening the binary", async () => {
      const original = fs.promises.open;
      const binaryOpen = vi.fn();
      vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        if (args[0] === binaryPath) binaryOpen();
        return await original(...args);
      });
      const authority = await freshAuthority();
      const controller = new AbortController();
      controller.abort();
      await expect(authority.inspect(controller.signal)).rejects.toMatchObject({
        code: "local_authority_invalid",
      });
      expect(binaryOpen).not.toHaveBeenCalled();
      await authority.close();
    });

    it("rejects binary digest drift without executing the file", async () => {
      await fs.promises.chmod(binaryPath, 0o700);
      await fs.promises.writeFile(binaryPath, "drifted-binary\n", { flag: "w" });
      await fs.promises.chmod(binaryPath, 0o555);
      try {
        const authority = await freshAuthority();
        await expect(authority.inspect()).rejects.toMatchObject({
          code: "local_authority_invalid",
        });
        await authority.close();
      } finally {
        const bytes = Buffer.from("reviewed-test-railway-binary\n", "utf8");
        await fs.promises.chmod(binaryPath, 0o700);
        await fs.promises.writeFile(binaryPath, bytes, { flag: "w" });
        await fs.promises.chmod(binaryPath, 0o555);
      }
    });

    it("contains no child-process or dependency-injection production surface", async () => {
      const filename = path.resolve(
        process.cwd(),
        "scripts/lib/staging-postgres-build-canary-local-authority.ts",
      );
      const source = await fs.promises.readFile(filename, "utf8");
      expect(source).not.toContain("node:child_process");
      expect(source).not.toMatch(/\bspawn\s*\(/);
      expect(source).not.toContain("openWithDependencies");
      expect(source).not.toContain("LocalAuthorityInternals");
    });

    it("makes cleanup failure dominant and never reports a later success", async () => {
      const original = fs.promises.open;
      let rootHandle: fs.promises.FileHandle | undefined;
      vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        const handle = await original(...args);
        if (args[0] === sourceRoot) {
          rootHandle = handle;
          const close = handle.close.bind(handle);
          let first = true;
          vi.spyOn(handle, "close").mockImplementation(async () => {
            if (first) {
              first = false;
              throw new Error("injected-before-close");
            }
            await close();
          });
        }
        return handle;
      });
      const authority = await freshAuthority();
      await expect(authority.close()).rejects.toMatchObject({
        code: "cleanup_failed",
      });
      await expect(authority.close()).rejects.toMatchObject({
        code: "cleanup_failed",
      });
      expect(rootHandle).toBeDefined();
    });

    it.skipIf(!fs.existsSync(retainedSource))(
      "reproduces the retained reviewed source manifest",
      async () => {
        const authority = await authorityModule
          .openStagingPostgresBuildCanaryLocalAuthority(retainedSource);
        const result = await authority.inspect();
        expect(result).toMatchObject({
          sourceManifestSha256:
            "388abd36d7f64f01b717659acfb37b63b7589d3c9342fb0fa65455be30192c76",
          sourceEntryCount: 684,
          sourceDirectoryCount: 82,
          sourceFileCount: 602,
          sourceFileBytes: 14_904_195,
        });
        await authority.close();
      },
      30_000,
    );
  },
);

describe.skipIf(process.platform === "darwin")(
  "staging Postgres build canary local authority platform boundary",
  () => {
    it("is macOS-only because the reviewed trust boundary is /private/tmp", () => {
      expect(os.platform()).not.toBe("darwin");
    });
  },
);
