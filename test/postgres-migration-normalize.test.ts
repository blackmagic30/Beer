import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeLegacyPostgresMigrationSource, POSTGRES_MIGRATION_LEGACY_NORMALIZATION_FINGERPRINT } from "../src/db/postgres-migration-source.js";
import { inspectPostgresMigrationSchema, sha256PostgresMigrationBytes } from "../src/db/postgres-migration-schema.js";
import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { runPostgresMigrationSourceCli } from "../scripts/postgres-migration.js";

const roots: string[] = [];
const timestamp = "2026-09-11T09:00:00.000Z";
const schema = fs.readFileSync(new URL("./fixtures/postgres-migration-legacy-normalization-schema.sql", import.meta.url), "utf8");
const hashFile = (file: string) => sha256PostgresMigrationBytes(fs.readFileSync(file));
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-legacy-normalize-"))); roots.push(root);
  const sourceSqlite = path.join(root, "sealed-upgraded.sqlite");
  const database = new Database(sourceSqlite); database.exec(schema);
  expect(inspectPostgresMigrationSchema(database).fingerprint).toBe(POSTGRES_MIGRATION_LEGACY_NORMALIZATION_FINGERPRINT);
  database.prepare("INSERT INTO accounts(id,email,password_hash,created_at,updated_at,contribution_points_current_month) VALUES(?,?,?,?,?,?)")
    .run("account", "private@example.test", "PRIVATE_PASSWORD_HASH", timestamp, timestamp, 7);
  database.prepare("INSERT INTO account_privacy_settings(user_id,created_at,updated_at) VALUES(?,?,?)").run("account", timestamp, timestamp);
  database.prepare("INSERT INTO venue_profiles(venue_id,name,created_at,updated_at) VALUES(?,?,?,?)").run("venue", "Preserved venue", timestamp, timestamp);
  database.prepare("INSERT INTO venue_price_records(id,venue_id,venue_name,beer_name,serving_size,price,source_type,last_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("price", "venue", "Preserved venue", "Carlton Draught", "pint", 13.5, "venue_manager", timestamp, timestamp, timestamp);
  database.prepare("INSERT INTO beer_price_results(venue_name,phone_number,suburb,beer_name,timestamp,raw_transcript,confidence,call_sid) VALUES(?,?,?,?,?,?,?,?)")
    .run("Archived venue", "PRIVATE_PHONE", "Test suburb", "Archived beer", timestamp, Buffer.from([0, 255, 65]), 0.75, "call");
  database.prepare("INSERT INTO call_runs(id,venue_name,phone_number,suburb,started_at,created_at,updated_at,raw_transcript) VALUES(?,?,?,?,?,?,?,?)")
    .run("run", "Archived venue", "PRIVATE_PHONE", "Test suburb", timestamp, timestamp, timestamp, "PRIVATE_TRANSCRIPT");
  database.prepare("INSERT INTO call_sessions(session_id,venue_name,phone_number,suburb,requested_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run("session", "Archived venue", "PRIVATE_PHONE", "Test suburb", timestamp, timestamp);
  database.close(); fs.chmodSync(sourceSqlite, 0o600);
  return { root, sourceSqlite, expectedSourceSha256: hashFile(sourceSqlite), outputDirectory: path.join(root, "normalized"),
    candidateSha: "a".repeat(40), operatorId: "private-operator", now: new Date(timestamp) };
}

describe("reviewed legacy physical-schema normalization", () => {
  it("preserves every canonical value and archives every legacy cell while reaching the unchanged native contract", async () => {
    const input = fixture(); const result = await normalizeLegacyPostgresMigrationSource(input);
    expect(hashFile(input.sourceSqlite)).toBe(input.expectedSourceSha256);
    const source = new Database(input.sourceSqlite, { readonly: true });
    const normalized = new Database(result.databasePath, { readonly: true });
    try {
      expect(inspectPostgresMigrationSchema(normalized).fingerprint).toBe(POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint);
      for (const table of POSTGRES_MIGRATION_CONTRACT.tables.filter(table => table.name !== "migration_quarantined_records")) {
        const columns = table.columns.map(column => `"${column[0]}"`).join(",");
        expect(normalized.prepare(`SELECT ${columns} FROM "${table.name}"`).all()).toEqual(source.prepare(`SELECT ${columns} FROM "${table.name}"`).all());
      }
      const archived = normalized.prepare("SELECT entity_type,payload_json FROM migration_quarantined_records ORDER BY entity_type").all() as Array<{ entity_type: string; payload_json: string }>;
      expect(archived.map(row => row.entity_type)).toEqual(["beer_price_results", "call_runs", "call_sessions"]);
      for (const row of archived) {
        const payload = JSON.parse(row.payload_json);
        expect(payload.sourceSha256).toBe(input.expectedSourceSha256);
        expect(payload.candidateSha).toBe(input.candidateSha);
        expect(payload.columns).toHaveLength(payload.cells.length);
        const original = source.prepare(`SELECT * FROM "${row.entity_type}"`).get() as Record<string, unknown>;
        for (let index = 0; index < payload.columns.length; index += 1) {
          const [type, value] = payload.cells[index];
          const decoded = type === "null" ? null : type === "blob" ? Buffer.from(value, "base64")
            : type === "integer" ? Number(value) : type === "float64" ? Buffer.from(value, "hex").readDoubleBE() : value;
          expect(decoded).toEqual(original[payload.columns[index]]);
        }
      }
      expect(normalized.pragma("foreign_key_check")).toEqual([]);
      expect(result.receipt).toMatchObject({ sourceUnchanged: true, canonicalValuesReconciled: true,
        archivedValuesReconciled: true, archivedRowCount: 3 });
      expect(fs.readFileSync(result.receiptPath, "utf8")).not.toContain("PRIVATE_");
      expect(fs.statSync(result.databasePath).mode & 0o777).toBe(0o600);
    } finally { source.close(); normalized.close(); }
    await expect(normalizeLegacyPostgresMigrationSource(input)).rejects.toThrow();
    expect(hashFile(result.databasePath)).toBe(result.receipt.normalizedSha256);
  });

  it.each(["CREATE TABLE unexpected_private_data(id TEXT)", "ALTER TABLE accounts ADD COLUMN unknown_private_data TEXT"])(
    "fails unknown metadata instead of omitting its data", async sql => {
      const input = fixture(); const source = new Database(input.sourceSqlite); source.exec(sql); source.close();
      input.expectedSourceSha256 = hashFile(input.sourceSqlite);
      await expect(normalizeLegacyPostgresMigrationSource(input)).rejects.toThrow(/reviewed normalization profile/);
      expect(fs.existsSync(input.outputDirectory)).toBe(false);
    },
  );

  it("rejects a wrong sealed source commitment before creating output", async () => {
    const input = fixture(); input.expectedSourceSha256 = "b".repeat(64);
    await expect(normalizeLegacyPostgresMigrationSource(input)).rejects.toThrow(/hash does not match/);
    expect(fs.existsSync(input.outputDirectory)).toBe(false);
  });

  it("rejects integer-to-REAL precision loss and removes only its private failed copy", async () => {
    const input = fixture(); const source = new Database(input.sourceSqlite);
    source.prepare("UPDATE accounts SET contribution_points_current_month=?").run(9007199254740993n); source.close();
    input.expectedSourceSha256 = hashFile(input.sourceSqlite);
    await expect(normalizeLegacyPostgresMigrationSource(input)).rejects.toThrow(/lossless value/);
    expect(hashFile(input.sourceSqlite)).toBe(input.expectedSourceSha256);
    expect(fs.existsSync(input.outputDirectory)).toBe(false);
  });

  it("requires closed private input rather than a live WAL source", async () => {
    const input = fixture(); fs.writeFileSync(`${input.sourceSqlite}-wal`, "not-a-sealed-source", { mode: 0o600 });
    await expect(normalizeLegacyPostgresMigrationSource(input)).rejects.toThrow(/sidecar-free isolated source/);
    expect(fs.existsSync(input.outputDirectory)).toBe(false);
  });

  it("rejects rows violating new canonical constraints without inventing replacement values", async () => {
    const input = fixture(); const source = new Database(input.sourceSqlite);
    source.prepare("INSERT INTO stripe_webhook_events(id,event_type,processed_at,received_at) VALUES(?,?,?,NULL)")
      .run("legacy-webhook", "private.test", timestamp); source.close();
    input.expectedSourceSha256 = hashFile(input.sourceSqlite);
    await expect(normalizeLegacyPostgresMigrationSource(input)).rejects.toThrow(/lossless value|constraint/);
    expect(hashFile(input.sourceSqlite)).toBe(input.expectedSourceSha256);
    expect(fs.existsSync(input.outputDirectory)).toBe(false);
  });

  it("rejects source symlinks and public file modes without producing usable output", async () => {
    const input = fixture(); const alias = path.join(input.root, "alias.sqlite"); fs.symlinkSync(input.sourceSqlite, alias);
    await expect(normalizeLegacyPostgresMigrationSource({ ...input, sourceSqlite: alias })).rejects.toThrow();
    fs.chmodSync(input.sourceSqlite, 0o644);
    await expect(normalizeLegacyPostgresMigrationSource(input)).rejects.toThrow();
    expect(fs.existsSync(input.outputDirectory)).toBe(false);
  });

  it("is callable through existing native importer preparation without granting cutover authority", async () => {
    const input = fixture();
    const result = await runPostgresMigrationSourceCli(["normalize-source", "--source-sqlite", input.sourceSqlite,
      "--source-sha256", input.expectedSourceSha256, "--output-dir", input.outputDirectory,
      "--candidate-sha", input.candidateSha, "--operator-id", input.operatorId]);
    expect(result).toMatchObject({ ok: true, command: "normalize-source", kind: "pint-path-postgres-source-normalization" });
    expect(result).not.toHaveProperty("status", "ready");
  });
});
