import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  POSTGRES_MIGRATION_APPLY_CONFIRMATION_ENV,
  POSTGRES_MIGRATION_APPLY_CONFIRMATION_VALUE,
  runPostgresMigrationSourceCli,
} from "../scripts/postgres-migration.js";
import type {
  PostgresMigrationReceipt,
  PostgresMigrationTargetInput,
} from "../src/db/postgres-migration-target.js";

const temporaryDirectories: string[] = [];
const sha = (character: string) => character.repeat(64);

function temporaryDirectory(): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-postgres-cli-test-")),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function targetArguments(root: string, command: "apply" | "verify-target"): string[] {
  return [
    command,
    "--snapshot-manifest", path.join(root, "snapshot-manifest.json"),
    "--snapshot-manifest-sha256", sha("a"),
    "--plan", path.join(root, "plan.json"),
    "--plan-sha256", sha("b"),
    "--target-ddl", path.join(root, "postgres-schema.sql"),
    "--target-ddl-sha256", sha("c"),
    "--target-url-file", path.join(root, "target-url.secret"),
    "--target-url-sha256", sha("d"),
    "--target-identity-sha256", sha("e"),
    "--expected-environment", "permanent-staging",
    "--candidate-sha", "f".repeat(40),
    "--approval-reference", "approved-migration-change-001",
    "--operator-id", "migration-operator-001",
    "--verifier-id", "migration-verifier-001",
    "--output-receipt", path.join(root, `${command}-receipt.json`),
  ];
}

function receipt(): PostgresMigrationReceipt {
  return {
    kind: "pint-path-postgres-migration-receipt",
    version: 1,
    status: "ready",
    expectedEnvironment: "permanent-staging",
    approvalReferenceSha256: sha("1"),
    operatorIdSha256: sha("2"),
    verifierIdSha256: sha("3"),
    runIdSha256: sha("4"),
    runBindingSha256: sha("5"),
    targetIdentitySha256: sha("e"),
    targetUrlSha256: sha("d"),
    targetDdlSha256: sha("c"),
    sourceSnapshotSha256: sha("6"),
    sourceSchemaFingerprint: sha("7"),
    contractSha256: sha("8"),
    manifestSha256: sha("a"),
    planSha256: sha("b"),
    candidateSha: "f".repeat(40),
    tableSetSha256: sha("9"),
    transformedDataSha256: sha("a"),
    keyRangesSha256: sha("b"),
    stateTotalsSha256: sha("c"),
    schemaMetadataSha256: sha("d"),
    tableCount: 56,
    columnCount: 717,
    rowCount: 435,
    chunkCount: 219,
    zeroRowTableCount: 8,
    foreignKeyCount: 76,
    receiptSha256: sha("0"),
  };
}

function interceptCreatedReceiptHandle(
  configure: (handle: FileHandle, filePath: string) => void,
): void {
  const nativeOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, "open").mockImplementation(async (filePath, flags, mode) => {
    const handle = await nativeOpen(filePath, flags, mode);
    if (typeof flags === "number" && (flags & fs.constants.O_CREAT) !== 0) {
      configure(handle, String(filePath));
    }
    return handle;
  });
}

async function expectVerifyReceiptFailure(
  root: string,
  code: "ARGUMENT_INVALID" | "ARTIFACT_INVALID" | "SOURCE_CHANGED",
): Promise<void> {
  await expect(runPostgresMigrationSourceCli(targetArguments(root, "verify-target"), {}, {
    readSecretFile: async () => "postgresql://fixture:fixture@example.invalid/pintpath?sslmode=require",
    verifyTarget: async () => receipt(),
  })).rejects.toMatchObject({ code });
  expect(fs.existsSync(path.join(root, "verify-target-receipt.json"))).toBe(false);
  expect(fs.readdirSync(root).filter((name) => name.startsWith(".pint-path-postgres-receipt-"))).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Postgres migration operator CLI", () => {
  it("inspects a target through a private URL-file seam and emits hashes only", async () => {
    const root = temporaryDirectory();
    const privateUrl = "postgresql://private-user:private-password@db.example.test/pintpath?sslmode=verify-full";
    const readSecretFile = vi.fn(async () => privateUrl);
    const inspectTarget = vi.fn(async () => ({
      targetIdentitySha256: sha("1"),
      targetUrlSha256: sha("2"),
      targetDdlSha256: sha("3"),
      tableCount: 56,
      columnCount: 717,
      foreignKeyCount: 76,
    }));
    const output = await runPostgresMigrationSourceCli([
      "inspect-target",
      "--target-ddl", path.join(root, "postgres-schema.sql"),
      "--target-ddl-sha256", sha("3"),
      "--target-url-file", path.join(root, "target-url.secret"),
    ], {}, { readSecretFile, inspectTarget });

    expect(inspectTarget).toHaveBeenCalledWith(expect.objectContaining({ targetUrl: privateUrl }));
    expect(JSON.stringify(output)).not.toContain("private-user");
    expect(JSON.stringify(output)).not.toContain("private-password");
    expect(output).toMatchObject({ ok: true, command: "inspect-target", tableCount: 56 });
  });

  it.each(["apply", "verify-target"] as const)(
    "%s writes a new mode-600 canonical hash-only receipt without exposing the URL",
    async (command) => {
      const root = temporaryDirectory();
      const privateUrl = "postgresql://private-user:private-password@db.example.test/pintpath?sslmode=verify-full";
      let captured: PostgresMigrationTargetInput | undefined;
      const execute = vi.fn(async (input: PostgresMigrationTargetInput) => {
        captured = input;
        return receipt();
      });
      const output = await runPostgresMigrationSourceCli(
        targetArguments(root, command),
        command === "apply"
          ? { [POSTGRES_MIGRATION_APPLY_CONFIRMATION_ENV]: POSTGRES_MIGRATION_APPLY_CONFIRMATION_VALUE }
          : {},
        {
          readSecretFile: async () => privateUrl,
          ...(command === "apply" ? { applyTarget: execute } : { verifyTarget: execute }),
        },
      );
      const receiptPath = path.join(root, `${command}-receipt.json`);
      const receiptText = fs.readFileSync(receiptPath, "utf8");

      expect(captured?.targetUrl).toBe(privateUrl);
      expect(captured?.expectedEnvironment).toBe("permanent-staging");
      const receiptStat = fs.statSync(receiptPath);
      expect(receiptStat.mode & 0o7777).toBe(0o600);
      expect(receiptStat.nlink).toBe(1);
      if (typeof process.geteuid === "function") expect(receiptStat.uid).toBe(process.geteuid());
      expect(JSON.parse(receiptText)).toEqual(receipt());
      expect(receiptText).not.toContain("private-user");
      expect(receiptText).not.toContain("private-password");
      expect(JSON.stringify(output)).not.toContain("private-password");
      expect(output).toMatchObject({ ok: true, command, status: "ready", rowCount: 435 });

      await expect(runPostgresMigrationSourceCli(
        targetArguments(root, command),
        command === "apply"
          ? { [POSTGRES_MIGRATION_APPLY_CONFIRMATION_ENV]: POSTGRES_MIGRATION_APPLY_CONFIRMATION_VALUE }
          : {},
        {
          readSecretFile: async () => privateUrl,
          ...(command === "apply" ? { applyTarget: execute } : { verifyTarget: execute }),
        },
      )).rejects.toThrow("must not already exist");
    },
  );

  it("rejects an unreviewed target environment before executing", async () => {
    const root = temporaryDirectory();
    const args = targetArguments(root, "verify-target");
    args[args.indexOf("--expected-environment") + 1] = "staging";
    const verifyTarget = vi.fn(async () => receipt());
    await expect(runPostgresMigrationSourceCli(args, {}, {
      readSecretFile: async () => "postgresql://user:password@db.example.test/pintpath?sslmode=require",
      verifyTarget,
    })).rejects.toThrow("permanent-staging or production");
    expect(verifyTarget).not.toHaveBeenCalled();
  });

  it("requires a separate exact apply confirmation before mutating a target", async () => {
    const root = temporaryDirectory();
    const applyTarget = vi.fn(async () => receipt());
    await expect(runPostgresMigrationSourceCli(targetArguments(root, "apply"), {}, {
      readSecretFile: async () => "postgresql://user:password@db.example.test/pintpath?sslmode=require",
      applyTarget,
    })).rejects.toThrow(`${POSTGRES_MIGRATION_APPLY_CONFIRMATION_ENV}=confirmed`);
    expect(applyTarget).not.toHaveBeenCalled();
  });

  it("atomically refuses an existing receipt without replacing it or leaving a partial artifact", async () => {
    const root = temporaryDirectory();
    const output = path.join(root, "verify-target-receipt.json");
    fs.writeFileSync(output, "reviewed-existing-receipt\n", { mode: 0o600 });

    await expect(runPostgresMigrationSourceCli(targetArguments(root, "verify-target"), {}, {
      readSecretFile: async () => "postgresql://fixture:fixture@example.invalid/pintpath?sslmode=require",
      verifyTarget: async () => receipt(),
    })).rejects.toMatchObject({ code: "ARGUMENT_INVALID" });

    expect(fs.readFileSync(output, "utf8")).toBe("reviewed-existing-receipt\n");
    expect(fs.readdirSync(root).filter((name) => name.startsWith(".pint-path-postgres-receipt-"))).toEqual([]);
  });

  it("atomically refuses a symlink receipt path without following or replacing it", async () => {
    const root = temporaryDirectory();
    const target = path.join(root, "symlink-target");
    const output = path.join(root, "verify-target-receipt.json");
    fs.writeFileSync(target, "unchanged\n", { mode: 0o600 });
    fs.symlinkSync(target, output);

    await expect(runPostgresMigrationSourceCli(targetArguments(root, "verify-target"), {}, {
      readSecretFile: async () => "postgresql://fixture:fixture@example.invalid/pintpath?sslmode=require",
      verifyTarget: async () => receipt(),
    })).rejects.toMatchObject({ code: "ARGUMENT_INVALID" });

    expect(fs.lstatSync(output).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("unchanged\n");
    expect(fs.readdirSync(root).filter((name) => name.startsWith(".pint-path-postgres-receipt-"))).toEqual([]);
  });

  it("atomically refuses a non-regular receipt path", async () => {
    const root = temporaryDirectory();
    const output = path.join(root, "verify-target-receipt.json");
    fs.mkdirSync(output, { mode: 0o700 });

    await expect(runPostgresMigrationSourceCli(targetArguments(root, "verify-target"), {}, {
      readSecretFile: async () => "postgresql://fixture:fixture@example.invalid/pintpath?sslmode=require",
      verifyTarget: async () => receipt(),
    })).rejects.toMatchObject({ code: "ARGUMENT_INVALID" });

    expect(fs.lstatSync(output).isDirectory()).toBe(true);
    expect(fs.readdirSync(root).filter((name) => name.startsWith(".pint-path-postgres-receipt-"))).toEqual([]);
  });

  it("rejects a group-writable receipt parent before creating any artifact", async () => {
    const root = temporaryDirectory();
    fs.chmodSync(root, 0o770);

    await expectVerifyReceiptFailure(root, "ARTIFACT_INVALID");
  });

  it("rejects a receipt descriptor whose owner does not match the operator", async () => {
    const root = temporaryDirectory();
    interceptCreatedReceiptHandle((handle) => {
      const nativeStat = handle.stat.bind(handle);
      handle.stat = (async (options?: fs.StatOptions) => {
        const stat = await nativeStat({ ...options, bigint: true });
        return new Proxy(stat, {
          get(target, property) {
            if (property === "uid") return target.uid + 1n;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }) as typeof handle.stat;
    });

    await expectVerifyReceiptFailure(root, "ARTIFACT_INVALID");
  });

  it("rejects a receipt whose mode changes before descriptor verification", async () => {
    const root = temporaryDirectory();
    interceptCreatedReceiptHandle((handle) => {
      const nativeSync = handle.sync.bind(handle);
      handle.sync = async () => {
        await nativeSync();
        await handle.chmod(0o640);
      };
    });

    await expectVerifyReceiptFailure(root, "ARTIFACT_INVALID");
  });

  it("rejects a receipt whose link count changes before descriptor verification", async () => {
    const root = temporaryDirectory();
    const injectedLink = path.join(root, "injected-receipt-hard-link");
    interceptCreatedReceiptHandle((handle, temporaryPath) => {
      const nativeSync = handle.sync.bind(handle);
      handle.sync = async () => {
        await nativeSync();
        await fs.promises.link(temporaryPath, injectedLink);
      };
    });

    await expectVerifyReceiptFailure(root, "ARTIFACT_INVALID");
    expect(fs.statSync(injectedLink).nlink).toBe(1);
  });

  it("detects in-place receipt mutation during descriptor verification", async () => {
    const root = temporaryDirectory();
    interceptCreatedReceiptHandle((handle) => {
      const nativeStat = handle.stat.bind(handle);
      let calls = 0;
      handle.stat = (async (options?: fs.StatOptions) => {
        calls += 1;
        if (calls === 2) {
          await handle.write(Buffer.from("!"), 0, 1, 0);
        }
        return await nativeStat({ ...options, bigint: true });
      }) as typeof handle.stat;
    });

    await expectVerifyReceiptFailure(root, "SOURCE_CHANGED");
  });
});
