import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

afterEach(() => {
  vi.doUnmock("better-sqlite3");
  vi.doUnmock("../src/lib/data-backup.js");
  vi.doUnmock("../src/lib/offsite-backup.js");
  vi.resetModules();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("data restore rehearsal CLI", () => {
  it("persists only a scrubbed provider failure and rejects with a fixed outer error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-rehearse-cli-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "pint-path.sqlite"), "fixture", { mode: 0o600 });

    const expectedManifestSha256 = "a".repeat(64);
    const loadedCredential = `sb_secret_${"q".repeat(220)}`;
    const recordedStates: Array<Record<string, unknown>> = [];
    const previousEnvironment = process.env;
    const previousArguments = process.argv;
    process.env = {
      ...previousEnvironment,
      SUPABASE_URL: "https://auth.pintpath.au",
      OFFSITE_BACKUP_SUPABASE_URL: "https://hfbmhdxrwtihukmixxta.supabase.co",
      OFFSITE_BACKUP_SERVICE_ROLE_KEY: loadedCredential,
    };
    process.argv = [
      "node",
      path.resolve("scripts/rehearse-data-restore.ts"),
      "--backup=/private/verified-backup",
      "--backup-id=pint-path-20260812T000000Z",
      `--source-manifest-sha256=${expectedManifestSha256}`,
      `--output=${root}`,
    ];

    vi.resetModules();
    vi.doMock("better-sqlite3", () => ({
      default: class FakeDatabase {
        prepare(sql: string) {
          if (sql.includes("sqlite_master")) {
            return { get: () => ({ name: "system_state" }) };
          }
          return {
            run: (valueJson: string) => {
              recordedStates.push(JSON.parse(valueJson) as Record<string, unknown>);
            },
          };
        }

        close() {}
      },
    }));
    vi.doMock("../src/lib/data-backup.js", () => ({
      sha256File: vi.fn(async () => expectedManifestSha256),
      rehearseDataRestore: vi.fn(async () => {
        throw new Error("restore must not start after ledger failure");
      }),
    }));
    vi.doMock("../src/lib/offsite-backup.js", () => ({
      fetchVerifiedAccountDeletionLedger: vi.fn(async () => {
        throw new Error(`provider echoed ${loadedCredential}x`);
      }),
    }));

    let failure: unknown;
    try {
      await import("../scripts/rehearse-data-restore.js");
    } catch (error) {
      failure = error;
    } finally {
      process.env = previousEnvironment;
      process.argv = previousArguments;
    }

    expect(failure).toEqual(expect.objectContaining({
      message: "Restore rehearsal failed.",
    }));
    expect(recordedStates).toHaveLength(2);
    expect(recordedStates[0]).toMatchObject({ state: "running" });
    expect(recordedStates[1]).toMatchObject({
      state: "failed",
      error: "provider echoed [REDACTED]x",
    });
    expect(JSON.stringify({ failure, recordedStates })).not.toContain(loadedCredential);
  });
});
