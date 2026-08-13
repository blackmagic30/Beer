import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { VerifiedAccountDeletionLedger } from "../src/lib/offsite-backup.js";
import { sha256Bytes } from "../src/lib/data-backup.js";
import {
  POSTGRES_MIGRATION_LEDGER_AUTHORITY_MANIFEST_FILE,
  exportPostgresMigrationLedgerAuthority,
  readPostgresMigrationLedgerAuthority,
  writePostgresMigrationLedgerAuthority,
} from "../src/db/postgres-migration-ledger.js";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-postgres-ledger-test-")),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function serialize(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function verifiedLedger(): VerifiedAccountDeletionLedger {
  const tombstones = [
    {
      requestId: "private-request-id",
      userId: "private-user-id",
      completedAt: "2026-08-07T01:02:03.000Z",
    },
  ];
  const current = serialize({
    version: 1,
    generatedAt: "2026-08-07T01:02:03.000Z",
    tombstones,
  });
  const genesis = serialize({
    version: 1,
    kind: "pint-path-account-deletion-ledger-genesis",
    createdAt: "2026-07-01T00:00:00.000Z",
    immutablePrefix: "_control/account-deletion-ledger/v1",
    currentLedgerPath: "_control/account-deletion-tombstones.json",
  });
  const checkpoint = {
    version: 2 as const,
    generatedAt: "2026-08-07T01:02:03.000Z",
    genesisPath: "_control/account-deletion-ledger-genesis.json",
    genesisSha256: sha256Bytes(genesis),
    currentLedgerPath: "_control/account-deletion-tombstones.json",
    currentLedgerSha256: sha256Bytes(current),
    immutableObjectCount: 1,
    immutableSetSha256: "a".repeat(64),
    tombstoneCount: 1,
    latestCompletedAt: "2026-08-07T01:02:03.000Z",
  };
  const checkpointBytes = serialize(checkpoint);
  return {
    bytes: current,
    sha256: sha256Bytes(current),
    genesisBytes: genesis,
    genesisSha256: sha256Bytes(genesis),
    checkpointBytes,
    checkpointSha256: sha256Bytes(checkpointBytes),
    tombstones,
    checkpoint,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Postgres migration account-deletion ledger authority export", () => {
  it("writes the mutually verified current, genesis, and checkpoint views as a private bundle", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "ledger-authority");
    const bundle = await writePostgresMigrationLedgerAuthority({
      sourceSupabaseUrl: "https://production-project.supabase.co",
      destinationSupabaseUrl: "https://independent-backup.supabase.co",
      bucketName: "pintpath-backups",
      outputDirectory,
      verified: verifiedLedger(),
    });

    expect(fs.statSync(outputDirectory).mode & 0o777).toBe(0o700);
    for (const file of [
      bundle.currentPath,
      bundle.genesisPath,
      bundle.checkpointPath,
      bundle.manifestPath,
    ]) {
      const stat = fs.statSync(file);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.nlink).toBe(1);
    }
    expect(path.basename(bundle.manifestPath)).toBe(POSTGRES_MIGRATION_LEDGER_AUTHORITY_MANIFEST_FILE);
    expect(bundle.manifest.checkpoint).toMatchObject({
      immutableObjectCount: 1,
      tombstoneCount: 1,
      latestCompletedAt: "2026-08-07T01:02:03.000Z",
    });
    const manifestText = fs.readFileSync(bundle.manifestPath, "utf8");
    expect(manifestText).not.toContain("private-request-id");
    expect(manifestText).not.toContain("private-user-id");
    expect(manifestText).not.toContain("production-project");
    expect(manifestText).not.toContain("independent-backup");
    expect(manifestText).not.toContain("pintpath-backups");

    const reread = await readPostgresMigrationLedgerAuthority(bundle.manifestPath);
    expect(reread.manifestSha256).toBe(bundle.manifestSha256);
    expect(reread.currentBytes).toEqual(verifiedLedger().bytes);
  });

  it("downloads through the verified remote-ledger reader without persisting the credential", async () => {
    const root = makeTemporaryDirectory();
    const fetchLedger = vi.fn(async () => verifiedLedger());
    const bundle = await exportPostgresMigrationLedgerAuthority({
      sourceSupabaseUrl: "https://production-project.supabase.co",
      destinationSupabaseUrl: "https://independent-backup.supabase.co",
      destinationServiceRoleKey: "private-service-role-secret",
      bucketName: "pintpath-backups",
      outputDirectory: path.join(root, "downloaded-ledger-authority"),
      fetchLedger,
    });

    expect(fetchLedger).toHaveBeenCalledWith(expect.objectContaining({
      destinationServiceRoleKey: "private-service-role-secret",
    }));
    for (const filename of fs.readdirSync(bundle.directory)) {
      expect(fs.readFileSync(path.join(bundle.directory, filename), "utf8"))
        .not.toContain("private-service-role-secret");
    }
  });

  it("fails closed on mismatched authority bytes, reused output, and non-independent projects", async () => {
    const root = makeTemporaryDirectory();
    const corrupt = verifiedLedger();
    corrupt.checkpointBytes = Buffer.from(corrupt.checkpointBytes);
    corrupt.checkpointBytes[0] = 0x20;
    await expect(writePostgresMigrationLedgerAuthority({
      sourceSupabaseUrl: "https://production-project.supabase.co",
      destinationSupabaseUrl: "https://independent-backup.supabase.co",
      bucketName: "pintpath-backups",
      outputDirectory: path.join(root, "corrupt"),
      verified: corrupt,
    })).rejects.toThrow("do not match their supplied hashes");
    expect(fs.existsSync(path.join(root, "corrupt"))).toBe(false);

    const existing = path.join(root, "existing");
    fs.mkdirSync(existing, { mode: 0o700 });
    await expect(writePostgresMigrationLedgerAuthority({
      sourceSupabaseUrl: "https://production-project.supabase.co",
      destinationSupabaseUrl: "https://independent-backup.supabase.co",
      bucketName: "pintpath-backups",
      outputDirectory: existing,
      verified: verifiedLedger(),
    })).rejects.toThrow("must not already exist");

    await expect(writePostgresMigrationLedgerAuthority({
      sourceSupabaseUrl: "https://same-project.supabase.co",
      destinationSupabaseUrl: "https://SAME-PROJECT.SUPABASE.CO/",
      bucketName: "pintpath-backups",
      outputDirectory: path.join(root, "same-project"),
      verified: verifiedLedger(),
    })).rejects.toThrow("must be independent");
  });

  it("rejects tampered or incomplete exported authority bundles", async () => {
    const root = makeTemporaryDirectory();
    const bundle = await writePostgresMigrationLedgerAuthority({
      sourceSupabaseUrl: "https://production-project.supabase.co",
      destinationSupabaseUrl: "https://independent-backup.supabase.co",
      bucketName: "pintpath-backups",
      outputDirectory: path.join(root, "tampered"),
      verified: verifiedLedger(),
    });
    fs.appendFileSync(bundle.currentPath, " ");
    await expect(readPostgresMigrationLedgerAuthority(bundle.manifestPath))
      .rejects.toThrow("differs from its manifest binding");

    const incomplete = await writePostgresMigrationLedgerAuthority({
      sourceSupabaseUrl: "https://production-project.supabase.co",
      destinationSupabaseUrl: "https://independent-backup.supabase.co",
      bucketName: "pintpath-backups",
      outputDirectory: path.join(root, "incomplete"),
      verified: verifiedLedger(),
    });
    fs.writeFileSync(path.join(incomplete.directory, "unexpected.txt"), "no", { mode: 0o600 });
    await expect(readPostgresMigrationLedgerAuthority(incomplete.manifestPath))
      .rejects.toThrow("exactly the four reviewed artifacts");
  });
});
