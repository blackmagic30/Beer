import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../src/db/database.js";
import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { writePostgresMigrationLedgerAuthority } from "../src/db/postgres-migration-ledger.js";
import {
  createPostgresMigrationPlan,
  createPostgresMigrationSnapshot,
} from "../src/db/postgres-migration-source.js";
import {
  applyPostgresMigrationWithConnection,
  inspectPostgresMigrationTargetWithConnection,
  verifyPostgresMigrationWithConnection,
  type PostgresMigrationTargetConnection,
  type PostgresMigrationTargetInput,
  type PostgresMigrationTargetQueryResult,
} from "../src/db/postgres-migration-target.js";
import { sha256PostgresMigrationBytes } from "../src/db/postgres-migration-schema.js";
import type { VerifiedAccountDeletionLedger } from "../src/lib/offsite-backup.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const TEST_DATABASE = "pintpath_migration_integration_test";
const TEST_LOGIN = "pintpath_migration_integration_login";
const NOW = "2026-08-08T00:00:00.000Z";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";

function validateDisposableAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} must be an explicit loopback Postgres admin URL.`);
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase())
    || databaseName !== "postgres"
    || !url.username
    || !url.password
    || url.hash
    || /[\r\n\0]/.test(value)
  ) {
    throw new Error(`${ADMIN_URL_ENV} must target the loopback postgres maintenance database with explicit test credentials.`);
  }
  return url;
}

function withDatabase(url: URL, database: string, username?: string, password?: string): string {
  const target = new URL(url.toString());
  target.pathname = `/${database}`;
  if (username !== undefined) target.username = username;
  if (password !== undefined) target.password = password;
  return target.toString();
}

function queryConnection(client: Client): PostgresMigrationTargetConnection {
  return {
    async query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<PostgresMigrationTargetQueryResult<Row>> {
      const result = await client.query<Row>(text, [...values]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

function serialize(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function verifiedLedger(): VerifiedAccountDeletionLedger {
  const tombstones: VerifiedAccountDeletionLedger["tombstones"] = [];
  const current = serialize({ version: 1, generatedAt: NOW, tombstones });
  const genesis = serialize({
    version: 1,
    kind: "pint-path-account-deletion-ledger-genesis",
    createdAt: "2026-07-01T00:00:00.000Z",
    immutablePrefix: "_control/account-deletion-ledger/v1",
    currentLedgerPath: "_control/account-deletion-tombstones.json",
  });
  const checkpoint = {
    version: 2 as const,
    generatedAt: NOW,
    genesisPath: "_control/account-deletion-ledger-genesis.json",
    genesisSha256: sha256PostgresMigrationBytes(genesis),
    currentLedgerPath: "_control/account-deletion-tombstones.json",
    currentLedgerSha256: sha256PostgresMigrationBytes(current),
    immutableObjectCount: 0,
    immutableSetSha256: "0".repeat(64),
    tombstoneCount: 0,
    latestCompletedAt: null,
  };
  const checkpointBytes = serialize(checkpoint);
  return {
    bytes: current,
    sha256: sha256PostgresMigrationBytes(current),
    genesisBytes: genesis,
    genesisSha256: sha256PostgresMigrationBytes(genesis),
    checkpointBytes,
    checkpointSha256: sha256PostgresMigrationBytes(checkpointBytes),
    tombstones,
    checkpoint,
  };
}

async function createMigrationInput(
  root: string,
  targetUrl: string,
  targetIdentitySha256: string,
): Promise<PostgresMigrationTargetInput> {
  const databasePath = path.join(root, "source.sqlite");
  const evidencePath = path.join(root, "source-evidence");
  fs.mkdirSync(evidencePath, { mode: 0o700 });
  fs.writeFileSync(path.join(evidencePath, "proof.bin"), "INTEGRATION_PRIVATE_EVIDENCE", { mode: 0o600 });
  const source = createDatabase(databasePath);
  source.prepare(
    `INSERT INTO accounts (
       id, email, password_hash, display_name, is_over_18_verified,
       contribution_points_current_month, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "integration-account",
    "integration-private@example.test",
    "INTEGRATION_PRIVATE_PASSWORD_HASH",
    "Integration Account",
    1,
    1.25,
    NOW,
    NOW,
  );
  source.prepare(
    "INSERT INTO system_state (key, value_json, updated_at, revision) VALUES (?, ?, ?, ?)",
  ).run("integration-state", '{"z":1.00,"a":2e0}', NOW, `${NOW}#integration`);
  source.close();

  const authority = await writePostgresMigrationLedgerAuthority({
    sourceSupabaseUrl: "https://production-integration.supabase.co",
    destinationSupabaseUrl: "https://backup-integration.supabase.co",
    bucketName: "pintpath-integration-backups",
    outputDirectory: path.join(root, "ledger-authority"),
    verified: verifiedLedger(),
  });
  const artifactParent = path.join(root, "artifacts");
  fs.mkdirSync(artifactParent, { mode: 0o700 });
  const snapshot = await createPostgresMigrationSnapshot({
    sourceSqlite: databasePath,
    sourceEvidence: evidencePath,
    deletionLedgerAuthorityManifest: authority.manifestPath,
    outputDirectory: path.join(artifactParent, "snapshot"),
    candidateSha: "c".repeat(40),
    operatorId: "postgres-integration-operator",
    maintenanceReference: "postgres-integration-maintenance",
    maintenanceConfirmed: true,
    capturedAt: NOW,
  });
  const plan = await createPostgresMigrationPlan({
    snapshotManifestPath: snapshot.manifestPath,
    expectedSnapshotManifestSha256: snapshot.manifestSha256,
    outputPlanPath: path.join(snapshot.snapshotDirectory, "plan.json"),
    chunkRows: 1_000,
  });
  const targetDdlPath = path.resolve("src/db/postgres-schema.sql");
  const targetDdlSha256 = sha256PostgresMigrationBytes(fs.readFileSync(targetDdlPath));
  return {
    snapshotManifestPath: snapshot.manifestPath,
    expectedSnapshotManifestSha256: snapshot.manifestSha256,
    planPath: plan.planPath,
    expectedPlanSha256: plan.planSha256,
    targetDdlPath,
    expectedTargetDdlSha256: targetDdlSha256,
    targetUrl,
    expectedTargetUrlSha256: sha256PostgresMigrationBytes(targetUrl),
    expectedTargetIdentitySha256: targetIdentitySha256,
    expectedEnvironment: "permanent-staging",
    candidateSha: "c".repeat(40),
    approvalReference: "postgres-integration-approval",
    operatorId: "postgres-integration-operator",
    verifierId: "postgres-integration-verifier",
  };
}

describe.skipIf(!configuredAdminUrl)("real PostgreSQL migration target", () => {
  let adminUrl: URL;
  let admin: Client;
  let targetAdmin: Client | null = null;
  let target: Client | null = null;
  let temporaryRoot = "";
  let migratorRoleExisted = false;
  let runtimeRoleExisted = false;

  beforeAll(async () => {
    adminUrl = validateDisposableAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const roles = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [["pintpath_migrator", "pintpath_runtime"]],
    );
    migratorRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_migrator");
    runtimeRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_runtime");
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    await targetAdmin.query(fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"));
    const loginPassword = crypto.randomBytes(24).toString("hex");
    await admin.query(
      `CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${loginPassword}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`GRANT pintpath_migrator TO ${TEST_LOGIN}`);
    target = new Client({
      connectionString: withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, loginPassword),
    });
    await target.connect();
    temporaryRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-postgres-integration-")),
    );
  }, 30_000);

  afterAll(async () => {
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
    await target?.end().catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    if (admin) {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [TEST_DATABASE],
      ).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
      await admin.query(`REVOKE pintpath_migrator FROM ${TEST_LOGIN}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
      if (!migratorRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_migrator").catch(() => undefined);
      if (!runtimeRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_runtime").catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  it("inspects, imports, and independently verifies the native 56-table target", async () => {
    expect(target).not.toBeNull();
    const connection = queryConnection(target!);
    const targetDdlPath = path.resolve("src/db/postgres-schema.sql");
    const targetDdlSha256 = sha256PostgresMigrationBytes(fs.readFileSync(targetDdlPath));
    const bindingUrl = "postgresql://integration-login:binding-only-secret@127.0.0.1:5432/pintpath?sslmode=verify-full";
    const inspection = await inspectPostgresMigrationTargetWithConnection({
      targetUrl: bindingUrl,
      targetDdlPath,
      expectedTargetDdlSha256: targetDdlSha256,
    }, connection);
    expect(inspection).toMatchObject({
      tableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables,
      columnCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns,
      foreignKeyCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys,
    });

    const input = await createMigrationInput(temporaryRoot, bindingUrl, inspection.targetIdentitySha256);
    const receipt = await applyPostgresMigrationWithConnection(input, connection);
    expect(receipt).toMatchObject({
      status: "ready",
      expectedEnvironment: "permanent-staging",
      tableCount: 56,
      columnCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns,
      foreignKeyCount: 76,
    });
    expect(receipt.rowCount).toBeGreaterThan(0);
    expect(receipt.chunkCount).toBeGreaterThan(0);
    expect(receipt.zeroRowTableCount).toBeGreaterThan(0);
    expect(await verifyPostgresMigrationWithConnection(input, connection)).toEqual(receipt);
    const metadata = await target!.query<{ value: string }>(
      "SELECT value FROM pintpath_app.schema_metadata WHERE key = 'import_state'",
    );
    expect(metadata.rows).toEqual([{ value: "ready" }]);
  }, 30_000);
});
