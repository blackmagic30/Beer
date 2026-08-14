import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkPostgresMigrationContract } from "../scripts/generate-postgres-migration-contract.js";
import { createDatabase } from "../src/db/database.js";
import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { writePostgresMigrationLedgerAuthority } from "../src/db/postgres-migration-ledger.js";
import {
  POSTGRES_MIGRATION_SNAPSHOT_EVIDENCE_DIRECTORY,
  createPostgresMigrationPlan,
  createPostgresMigrationSnapshot,
} from "../src/db/postgres-migration-source.js";
import { sha256Bytes } from "../src/lib/data-backup.js";
import type { VerifiedAccountDeletionLedger } from "../src/lib/offsite-backup.js";

const temporaryDirectories: string[] = [];
const now = "2026-08-08T00:00:00.000Z";

function makeTemporaryDirectory(): string {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pint-path-postgres-plan-test-")),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function migrationLedgerFixture(): VerifiedAccountDeletionLedger {
  const current = Buffer.from(`${JSON.stringify({ version: 1, generatedAt: now, tombstones: [] }, null, 2)}\n`);
  const genesis = Buffer.from(`${JSON.stringify({
    version: 1,
    kind: "pint-path-account-deletion-ledger-genesis",
    createdAt: now,
    immutablePrefix: "_control/account-deletion-ledger/v1",
    currentLedgerPath: "_control/account-deletion-tombstones.json",
  }, null, 2)}\n`);
  const checkpoint = {
    version: 2 as const,
    generatedAt: now,
    genesisPath: "_control/account-deletion-ledger-genesis.json",
    genesisSha256: sha256Bytes(genesis),
    currentLedgerPath: "_control/account-deletion-tombstones.json",
    currentLedgerSha256: sha256Bytes(current),
    immutableObjectCount: 0,
    immutableSetSha256: "a".repeat(64),
    tombstoneCount: 0,
    latestCompletedAt: null,
  };
  const checkpointBytes = Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`);
  return {
    bytes: current,
    sha256: sha256Bytes(current),
    genesisBytes: genesis,
    genesisSha256: sha256Bytes(genesis),
    checkpointBytes,
    checkpointSha256: sha256Bytes(checkpointBytes),
    tombstones: [],
    checkpoint,
  };
}

async function createSourceFixture(input: {
  root: string;
  preferredBeersJson?: string;
  analyticsEnabled?: number;
}): Promise<{
  databasePath: string;
  evidencePath: string;
  ledgerAuthorityManifestPath: string;
}> {
  const databasePath = path.join(input.root, "live.sqlite");
  const evidencePath = path.join(input.root, "source-evidence");
  fs.mkdirSync(evidencePath, { mode: 0o700 });
  fs.writeFileSync(path.join(evidencePath, "private-evidence.txt"), "PLAN_PRIVATE_EVIDENCE_MARKER", { mode: 0o600 });
  const database = createDatabase(databasePath);
  database.prepare(
    `INSERT INTO accounts (
       id, email, password_hash, display_name, is_over_18_verified, contribution_points_current_month,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 1.25, ?, ?)`,
  ).run("plan-private-account", "plan-private@example.test", "plan-private-password", "Plan Private", now, now);
  database.prepare(
    `INSERT INTO account_preferences (
       user_id, preferred_suburbs_json, preferred_beers_json, preferred_use_cases_json,
       onboarding_completed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "plan-private-account",
    '["Fitzroy","Carlton"]',
    input.preferredBeersJson ?? '["Stout","Lager"]',
    '["map"]',
    now,
    now,
    now,
  );
  database.prepare(
    `INSERT INTO account_privacy_settings (
       user_id, optional_analytics_enabled, consented_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run("plan-private-account", input.analyticsEnabled ?? 1, now, now, now);
  database.prepare(
    "INSERT INTO system_state (key, value_json, updated_at, revision) VALUES (?, ?, ?, ?)",
  ).run("private-plan-state", '{"z":1.00,"a":2e0,"nested":{"b":true,"a":null}}', now, `${now}#plan`);
  database.prepare(
    `INSERT INTO account_deletion_requests (
       id, user_id, requested_at, execute_after, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("plan-private-deletion", "plan-private-account", now, "2026-08-15T00:00:00.000Z", now, now);
  database.prepare(
    `INSERT INTO account_deletion_completion_outbox (
       request_id, template_version, idempotency_key, status, created_at, updated_at
     ) VALUES (?, 'account-deletion-complete-v1', ?, 'held', ?, ?)`,
  ).run("plan-private-deletion", "plan-private-outbox-key", now, now);
  database.prepare(
    `INSERT INTO account_deletion_notice_recipient_secrets (
       request_id, key_id, nonce, ciphertext, auth_tag, created_at, purge_after
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "plan-private-deletion",
    "plan-private-key-id",
    Buffer.alloc(12, 3),
    Buffer.from("PLAN_PRIVATE_CIPHERTEXT_MARKER", "utf8"),
    Buffer.alloc(16, 4),
    now,
    "2026-10-07T00:00:00.000Z",
  );
  database.prepare(
    `INSERT INTO leaderboard_prize_campaigns (
       month_key, title, starts_at, ends_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("2026-08", "Private campaign", now, "2026-08-31T23:59:59.999Z", now, now);
  database.prepare(
    `INSERT INTO venue_location_cache (
       venue_id, venue_name, latitude, longitude, updated_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run("private-venue", "Private Venue", -37.8136, 144.9631, now);
  database.prepare(
    `INSERT INTO venue_profiles (
       venue_id, name, opening_hours_json, venue_tags_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("private-venue", "Private Venue", '{}', '["pub"]', now, now);
  database.prepare(
    `INSERT INTO venue_happy_hours (
       id, venue_id, title, days_of_week_json, start_time, end_time,
       description, happy_hour_beers_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "private-happy-hour",
    "private-venue",
    "Private Happy Hour",
    '["monday"]',
    "16:30",
    "18:00:00",
    "Private description",
    '["Lager"]',
    now,
    now,
  );
  database.close();
  const ledgerAuthority = await writePostgresMigrationLedgerAuthority({
    sourceSupabaseUrl: "https://production-project.supabase.co",
    destinationSupabaseUrl: "https://independent-backup.supabase.co",
    bucketName: "pintpath-backups",
    outputDirectory: path.join(input.root, "deletion-ledger-authority"),
    verified: migrationLedgerFixture(),
  });
  return { databasePath, evidencePath, ledgerAuthorityManifestPath: ledgerAuthority.manifestPath };
}

async function snapshotFixture(root: string, source: Awaited<ReturnType<typeof createSourceFixture>>) {
  const artifactParent = path.join(root, "postgres-migration-artifacts");
  fs.mkdirSync(artifactParent, { mode: 0o700 });
  return createPostgresMigrationSnapshot({
    sourceSqlite: source.databasePath,
    sourceEvidence: source.evidencePath,
    deletionLedgerAuthorityManifest: source.ledgerAuthorityManifestPath,
    outputDirectory: path.join(artifactParent, "snapshot"),
    candidateSha: "d".repeat(40),
    operatorId: "migration-operator-plan",
    maintenanceReference: "approved-plan-change-reference",
    maintenanceConfirmed: true,
    capturedAt: now,
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("deterministic SQLite-to-Postgres migration plans", () => {
  it("keeps an explicit, generated 56-table and 717-column contract", () => {
    expect(checkPostgresMigrationContract()).toBe(true);
    expect(POSTGRES_MIGRATION_CONTRACT.tables).toHaveLength(56);
    expect(POSTGRES_MIGRATION_CONTRACT.tables.reduce(
      (total, table) => total + table.columns.length,
      0,
    )).toBe(717);
    expect(POSTGRES_MIGRATION_CONTRACT.importOrder).toHaveLength(56);
    const accounts = POSTGRES_MIGRATION_CONTRACT.tables.find((table) => table.name === "accounts")!;
    expect(accounts.columns.find((column) => column[0] === "is_over_18_verified")?.[2]).toBe("boolean");
    expect(accounts.columns.find((column) => column[0] === "created_at")?.[2]).toBe("utc-instant");
    const webhook = POSTGRES_MIGRATION_CONTRACT.tables.find((table) => table.name === "stripe_webhook_events")!;
    expect(webhook.columns.find((column) => column[0] === "payload_json")?.[2]).toBe("json-object");
  });

  it("fully scans every table and produces byte-identical secret-free commitments", async () => {
    const root = makeTemporaryDirectory();
    const source = await createSourceFixture({ root });
    const snapshot = await snapshotFixture(root, source);
    const firstPlanPath = path.join(snapshot.snapshotDirectory, "plan-a.json");
    const secondPlanPath = path.join(snapshot.snapshotDirectory, "plan-b.json");
    const first = await createPostgresMigrationPlan({
      snapshotManifestPath: snapshot.manifestPath,
      expectedSnapshotManifestSha256: snapshot.manifestSha256,
      outputPlanPath: firstPlanPath,
      chunkRows: 2,
    });
    const second = await createPostgresMigrationPlan({
      snapshotManifestPath: snapshot.manifestPath,
      expectedSnapshotManifestSha256: snapshot.manifestSha256,
      outputPlanPath: secondPlanPath,
      chunkRows: 2,
    });

    expect(first.planSha256).toBe(second.planSha256);
    expect(fs.readFileSync(firstPlanPath)).toEqual(fs.readFileSync(secondPlanPath));
    expect(fs.statSync(firstPlanPath).mode & 0o777).toBe(0o600);
    expect(first.plan.tableCount).toBe(56);
    expect(first.plan.columnCount).toBe(717);
    expect(first.plan.importOrder).toEqual(POSTGRES_MIGRATION_CONTRACT.importOrder);
    expect(first.plan.tables).toHaveLength(56);
    expect(first.plan.tables.every((table) => /^[a-f0-9]{64}$/.test(table.transformedSha256))).toBe(true);
    expect(first.plan.tables.flatMap((table) => table.chunks).every((chunk) => (
      chunk.rowCount >= 1
      && chunk.rowCount <= 2
      && /^[a-f0-9]{64}$/.test(chunk.transformedSha256)
      && /^[a-f0-9]{64}$/.test(chunk.firstPrimaryKeySha256)
      && /^[a-f0-9]{64}$/.test(chunk.lastPrimaryKeySha256)
    ))).toBe(true);
    expect(first.plan.tables.find((table) => table.name === "accounts")?.rowCount).toBe(1);
    expect(first.plan.tables.find((table) => table.name === "account_preferences")?.conversionCounts["json-array"]).toBe(3);
    expect(first.plan.tables.find(
      (table) => table.name === "account_deletion_notice_recipient_secrets",
    )?.conversionCounts.binary).toBe(3);
    expect(first.plan.tables.find((table) => table.name === "venue_location_cache")?.conversionCounts.float64).toBe(2);
    expect(first.plan.tables.find((table) => table.name === "venue_happy_hours")?.conversionCounts["local-time"]).toBe(2);
    expect(first.plan.tables.find(
      (table) => table.name === "leaderboard_prize_campaigns",
    )?.conversionCounts["calendar-month"]).toBe(1);

    const planText = fs.readFileSync(firstPlanPath, "utf8");
    for (const secret of [
      root,
      "plan-private-account",
      "plan-private@example.test",
      "Plan Private",
      "Stout",
      "Fitzroy",
      "private-plan-state",
      "Private Venue",
      "Private Happy Hour",
      "Private campaign",
      "PLAN_PRIVATE_EVIDENCE_MARKER",
      "PLAN_PRIVATE_LEDGER_MARKER",
      "PLAN_PRIVATE_CIPHERTEXT_MARKER",
    ]) {
      expect(planText).not.toContain(secret);
    }
  });

  it("rejects duplicate-key JSON and non-boolean integer flags during the full scan", async () => {
    const jsonRoot = makeTemporaryDirectory();
    const invalidJsonSource = await createSourceFixture({
      root: jsonRoot,
      preferredBeersJson: '[{"beer":"one","beer":"two"}]',
    });
    const invalidJsonSnapshot = await snapshotFixture(jsonRoot, invalidJsonSource);
    await expect(createPostgresMigrationPlan({
      snapshotManifestPath: invalidJsonSnapshot.manifestPath,
      expectedSnapshotManifestSha256: invalidJsonSnapshot.manifestSha256,
      outputPlanPath: path.join(invalidJsonSnapshot.snapshotDirectory, "invalid-json-plan.json"),
      chunkRows: 500,
    })).rejects.toMatchObject({
      code: "SOURCE_DATA_INVALID",
      message: expect.stringContaining("account_preferences.preferred_beers_json"),
    });

    const booleanRoot = makeTemporaryDirectory();
    const invalidBooleanSource = await createSourceFixture({ root: booleanRoot, analyticsEnabled: 2 });
    const invalidBooleanSnapshot = await snapshotFixture(booleanRoot, invalidBooleanSource);
    await expect(createPostgresMigrationPlan({
      snapshotManifestPath: invalidBooleanSnapshot.manifestPath,
      expectedSnapshotManifestSha256: invalidBooleanSnapshot.manifestSha256,
      outputPlanPath: path.join(invalidBooleanSnapshot.snapshotDirectory, "invalid-boolean-plan.json"),
      chunkRows: 500,
    })).rejects.toMatchObject({
      code: "SOURCE_DATA_INVALID",
      message: expect.stringContaining("account_privacy_settings.optional_analytics_enabled"),
    });
  });

  it("refuses to plan from a snapshot whose deletion-ledger authority copy changed", async () => {
    const root = makeTemporaryDirectory();
    const source = await createSourceFixture({ root });
    const snapshot = await snapshotFixture(root, source);
    const ledgerPath = path.join(
      snapshot.snapshotDirectory,
      "account-deletion-ledger-authority",
      "account-deletion-tombstones.json",
    );
    fs.appendFileSync(ledgerPath, " ");

    await expect(createPostgresMigrationPlan({
      snapshotManifestPath: snapshot.manifestPath,
      expectedSnapshotManifestSha256: snapshot.manifestSha256,
      outputPlanPath: path.join(snapshot.snapshotDirectory, "tampered-ledger-plan.json"),
      chunkRows: 500,
    })).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  });

  it("refuses to plan from a snapshot whose copied evidence tree changed", async () => {
    const root = makeTemporaryDirectory();
    const source = await createSourceFixture({ root });
    const snapshot = await snapshotFixture(root, source);
    const evidencePath = path.join(
      snapshot.snapshotDirectory,
      POSTGRES_MIGRATION_SNAPSHOT_EVIDENCE_DIRECTORY,
      "private-evidence.txt",
    );
    fs.appendFileSync(evidencePath, "tampered");

    await expect(createPostgresMigrationPlan({
      snapshotManifestPath: snapshot.manifestPath,
      expectedSnapshotManifestSha256: snapshot.manifestSha256,
      outputPlanPath: path.join(snapshot.snapshotDirectory, "tampered-evidence-plan.json"),
      chunkRows: 500,
    })).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  });
});
