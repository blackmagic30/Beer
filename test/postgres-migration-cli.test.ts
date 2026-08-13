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
import {
  POSTGRES_MIGRATION_VERIFICATION_APPROVAL_KIND,
  POSTGRES_MIGRATION_VERIFICATION_APPROVAL_VERSION,
  finalizePostgresMigrationApplyReceipt,
} from "../src/db/postgres-migration-receipt.js";
import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "../src/db/postgres-migration-schema.js";

const temporaryDirectories: string[] = [];
const sha = (character: string) => character.repeat(64);
const PRODUCTION_SUPABASE_ORIGIN = "https://auth.pintpath.au";
const OFFSITE_BACKUP_SUPABASE_ORIGIN = "https://hfbmhdxrwtihukmixxta.supabase.co";
const SUPABASE_SECRET_KEY = `sb_secret_${"s".repeat(32)}`;

function legacySupabaseJwt(role: "anon" | "service_role"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role })).toString("base64url");
  const signature = Buffer.alloc(32, 0x51).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function temporaryDirectory(): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-postgres-cli-test-")),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function targetArguments(root: string, command: "apply" | "verify-target"): string[] {
  if (command === "verify-target") writeVerificationFixtures(root);
  return [
    command,
    "--snapshot-manifest", path.join(root, "snapshot-manifest.json"),
    "--snapshot-manifest-sha256", sha("a"),
    "--plan", path.join(root, "plan.json"),
    "--plan-sha256", sha("b"),
    "--root-ca-file", path.join(root, "railway-root-ca.pem"),
    "--root-ca-der-sha256", sha("f"),
    "--target-ddl", path.join(root, "postgres-schema.sql"),
    "--target-ddl-sha256", sha("c"),
    "--target-url-file", path.join(root, "target-url.secret"),
    "--target-url-sha256", sha("d"),
    "--transport-authority-sha256", sha("9"),
    "--target-identity-sha256", sha("e"),
    "--expected-environment", "permanent-staging",
    "--candidate-sha", "f".repeat(40),
    "--approval-reference", "approved-migration-change-001",
    "--operator-id", "migration-operator-001",
    "--output-receipt", path.join(root, `${command}-receipt.json`),
    ...(command === "verify-target" ? [
      "--apply-receipt", path.join(root, "apply-receipt.json"),
      "--apply-receipt-sha256", sha("8"),
      "--verification-approval", path.join(root, "verification-approval.json"),
      "--verification-approval-sha256", sha("9"),
      "--verifier-public-key", path.join(root, "verifier-public-key.pem"),
    ] : []),
  ];
}

function applyReceiptFixture() {
  const final = receipt();
  const {
    applyReceiptSha256: _applyReceiptSha256,
    receiptSha256: _receiptSha256,
    status: _status,
    verificationApprovalFileSha256: _verificationApprovalFileSha256,
    verifiedAt: _verifiedAt,
    verifierPublicKeySha256: _verifierPublicKeySha256,
    ...common
  } = final;
  return finalizePostgresMigrationApplyReceipt({
    ...common,
    status: "awaiting-verification",
  });
}

function writeVerificationFixtures(root: string): void {
  const applyReceipt = applyReceiptFixture();
  const publicKeySha256 = sha("7");
  const payload = {
    applyReceiptSha256: applyReceipt.receiptSha256,
    approvedAt: "2026-08-08T00:00:00.000Z",
    candidateSha: applyReceipt.candidateSha,
    expectedEnvironment: applyReceipt.expectedEnvironment,
    expiresAt: "2026-08-08T01:00:00.000Z",
    liveSchemaSha256: applyReceipt.liveSchemaSha256,
    targetIdentitySha256: applyReceipt.targetIdentitySha256,
    verifierIdSha256: applyReceipt.verifierIdSha256,
    verifierAuthoritySha256: applyReceipt.verifierAuthoritySha256,
    verifierAuthorityPolicySha256: applyReceipt.verifierAuthorityPolicySha256,
    verifierPublicKeySha256: publicKeySha256,
  };
  const approval = {
    kind: POSTGRES_MIGRATION_VERIFICATION_APPROVAL_KIND,
    version: POSTGRES_MIGRATION_VERIFICATION_APPROVAL_VERSION,
    payload,
    signatureBase64: Buffer.alloc(64, 1).toString("base64"),
  };
  const applyBytes = serializeCanonicalPostgresMigrationJson(applyReceipt);
  const approvalBytes = serializeCanonicalPostgresMigrationJson(approval);
  fs.writeFileSync(path.join(root, "apply-receipt.json"), applyBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "verification-approval.json"), approvalBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "verifier-public-key.pem"), "fixture-key", { mode: 0o600 });
}

function ledgerExportArguments(root: string): string[] {
  return [
    "ledger-export",
    "--output-dir", path.join(root, "ledger-authority"),
    "--service-role-key-file", path.join(root, "service-role.secret"),
  ];
}

function ledgerExportEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SUPABASE_URL: PRODUCTION_SUPABASE_ORIGIN,
    OFFSITE_BACKUP_SUPABASE_URL: OFFSITE_BACKUP_SUPABASE_ORIGIN,
    OFFSITE_BACKUP_BUCKET: "pintpath-backups",
    ...overrides,
  };
}

function receipt(): PostgresMigrationReceipt {
  return {
    kind: "pint-path-postgres-migration-receipt",
    version: 3,
    status: "ready",
    expectedEnvironment: "permanent-staging",
    approvalReferenceSha256: sha("1"),
    operatorIdSha256: sha("2"),
    verifierIdSha256: sha("3"),
    verifierAuthoritySha256: sha("4"),
    verifierAuthorityPolicySha256: sha("5"),
    runIdSha256: sha("4"),
    runBindingSha256: sha("5"),
    targetIdentitySha256: sha("e"),
    transportAuthoritySha256: sha("f"),
    targetUrlSha256: sha("d"),
    targetDdlSha256: sha("c"),
    liveSchemaSha256: sha("0"),
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
    applyReceiptSha256: sha("4"),
    verificationApprovalFileSha256: sha("5"),
    verifierPublicKeySha256: sha("7"),
    verifiedAt: "2026-08-08T00:00:00.000Z",
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
      targetIdentity: {
        currentUser: "pintpath_migrator",
        databaseName: "pintpath",
        databaseOid: "42",
        serverVersionNum: "170010",
        sessionUser: "migration-login",
        systemIdentifier: "123456789",
      },
      targetIdentitySha256: sha("1"),
      targetUrlSha256: sha("2"),
      transportAuthoritySha256: sha("4"),
      targetDdlSha256: sha("3"),
      liveSchemaSha256: sha("5"),
      liveSchemaObjectCount: 1532,
      tableCount: 56,
      columnCount: 717,
      foreignKeyCount: 76,
    }));
    const output = await runPostgresMigrationSourceCli([
      "inspect-target",
      "--output-target-identity", path.join(root, "target-identity.json"),
      "--target-ddl", path.join(root, "postgres-schema.sql"),
      "--target-ddl-sha256", sha("3"),
      "--target-url-file", path.join(root, "target-url.secret"),
      "--root-ca-file", path.join(root, "railway-root-ca.pem"),
      "--root-ca-der-sha256", sha("4"),
    ], {}, { readSecretFile, inspectTarget });

    expect(inspectTarget).toHaveBeenCalledWith(expect.objectContaining({ targetUrl: privateUrl }));
    expect(JSON.stringify(output)).not.toContain("private-user");
    expect(JSON.stringify(output)).not.toContain("private-password");
    expect(output).toMatchObject({ ok: true, command: "inspect-target", tableCount: 56 });
    expect(output).not.toHaveProperty("targetIdentity");
    const identityPath = path.join(root, "target-identity.json");
    expect(fs.statSync(identityPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(identityPath, "utf8"))).toMatchObject({
      currentUser: "pintpath_migrator",
      sessionUser: "migration-login",
    });
  });

  it.each([
    ["hostile production origin", "SUPABASE_URL", "https://attacker.invalid"],
    ["padded production origin", "SUPABASE_URL", ` ${PRODUCTION_SUPABASE_ORIGIN}`],
    ["case-changed production origin", "SUPABASE_URL", "https://AUTH.PINTPATH.AU"],
    ["production origin with a path", "SUPABASE_URL", `${PRODUCTION_SUPABASE_ORIGIN}/rest/v1`],
    ["production origin with an explicit default port", "SUPABASE_URL", "https://auth.pintpath.au:443"],
    ["hostile off-site origin", "OFFSITE_BACKUP_SUPABASE_URL", "https://attacker.invalid"],
    ["padded off-site origin", "OFFSITE_BACKUP_SUPABASE_URL", ` ${OFFSITE_BACKUP_SUPABASE_ORIGIN}`],
    ["case-changed off-site origin", "OFFSITE_BACKUP_SUPABASE_URL", "https://HFBMHDXRWTIHUKMIXTXA.SUPABASE.CO"],
    ["off-site origin with a path", "OFFSITE_BACKUP_SUPABASE_URL", `${OFFSITE_BACKUP_SUPABASE_ORIGIN}/storage/v1`],
    ["off-site origin with an explicit default port", "OFFSITE_BACKUP_SUPABASE_URL", "https://hfbmhdxrwtihukmixxta.supabase.co:443"],
  ] as const)(
    "rejects a %s before reading or exporting with a service credential",
    async (_description, name, candidate) => {
      const root = temporaryDirectory();
      const readSecretFile = vi.fn(async () => SUPABASE_SECRET_KEY);
      const exportLedger = vi.fn(async () => {
        throw new Error("The ledger export transport must not be reached.");
      });
      let error: unknown;
      try {
        await runPostgresMigrationSourceCli(
          ledgerExportArguments(root),
          ledgerExportEnvironment({ [name]: candidate }),
          { readSecretFile, exportLedger },
        );
      } catch (cause) {
        error = cause;
      }

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("exact reviewed Supabase HTTPS origin");
      expect((error as Error).message).not.toContain(candidate);
      expect(readSecretFile).not.toHaveBeenCalled();
      expect(exportLedger).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["padded secret key", ` ${SUPABASE_SECRET_KEY}`],
    ["multiline secret key", `${SUPABASE_SECRET_KEY}\nmalformed`],
    ["publishable key", `sb_publishable_${"p".repeat(32)}`],
    ["wrong-role legacy JWT", legacySupabaseJwt("anon")],
    ["arbitrary credential", "arbitrary-service-role-key"],
  ])("rejects a %s before the ledger export transport", async (_description, candidate) => {
    const root = temporaryDirectory();
    const readSecretFile = vi.fn(async () => candidate);
    const exportLedger = vi.fn(async () => {
      throw new Error("The ledger export transport must not be reached.");
    });
    let error: unknown;
    try {
      await runPostgresMigrationSourceCli(
        ledgerExportArguments(root),
        ledgerExportEnvironment(),
        { readSecretFile, exportLedger },
      );
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("role=service_role");
    expect((error as Error).message).not.toContain(candidate);
    expect(readSecretFile).toHaveBeenCalledOnce();
    expect(exportLedger).not.toHaveBeenCalled();
  });

  it.each([
    ["new secret key", SUPABASE_SECRET_KEY],
    ["legacy service-role JWT", legacySupabaseJwt("service_role")],
  ])("reaches the ledger export seam with a reviewed %s", async (_description, credential) => {
    const root = temporaryDirectory();
    const sentinel = new Error("Reviewed ledger export seam reached.");
    const exportLedger = vi.fn(async () => {
      throw sentinel;
    });

    await expect(runPostgresMigrationSourceCli(
      ledgerExportArguments(root),
      ledgerExportEnvironment(),
      {
        readSecretFile: async () => credential,
        exportLedger,
      },
    )).rejects.toBe(sentinel);
    expect(exportLedger).toHaveBeenCalledWith(expect.objectContaining({
      sourceSupabaseUrl: PRODUCTION_SUPABASE_ORIGIN,
      destinationSupabaseUrl: OFFSITE_BACKUP_SUPABASE_ORIGIN,
      destinationServiceRoleKey: credential,
    }));
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
      expect(captured?.rootCaFile).toBe(path.join(root, "railway-root-ca.pem"));
      expect(captured?.expectedRootCaDerSha256).toBe(sha("f"));
      expect(captured?.expectedTransportAuthoritySha256).toBe(sha("9"));
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
