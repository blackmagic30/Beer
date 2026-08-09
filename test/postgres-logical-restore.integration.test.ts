import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPostgresLogicalBackup,
  runPostgresBackupProcess,
} from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE,
  inspectPostgresLogicalRestoreTarget,
  restorePostgresLogicalBackup,
} from "../src/lib/postgres-logical-restore.js";
import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_LOGICAL_RESTORE_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const UNIQUE_SUFFIX = `${process.pid}_${Date.now().toString(36)}`.toLowerCase();
const SOURCE_DATABASE = `pintpath_lr_source_${UNIQUE_SUFFIX}`;
const TARGET_DATABASE = `pintpath_lr_target_${UNIQUE_SUFFIX}`;
const BACKUP_LOGIN = `pintpath_lr_backup_${UNIQUE_SUFFIX}`;
const BACKUP_PASSWORD = `PintpathLogicalReceipt_${UNIQUE_SUFFIX}`;

function validateAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} must be a loopback PostgreSQL admin URL.`);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase())
    || decodeURIComponent(url.pathname.slice(1)) !== "postgres"
    || !url.username
    || !url.password
    || url.searchParams.get("sslmode") !== "disable"
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")
    || url.hash
  ) throw new Error(`${ADMIN_URL_ENV} must target a disposable loopback maintenance database.`);
  return url;
}

function withDatabase(url: URL, database: string): URL {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  return result;
}

async function createLogicalBackup(
  sourceUrl: URL,
  sourceAdminUrl: URL,
  root: string,
): Promise<{
  directory: string;
  manifestSha256: string;
}> {
  const directory = path.join(root, "backup");
  const sourceUrlFile = path.join(root, "source-url");
  fs.writeFileSync(sourceUrlFile, `${sourceUrl.toString()}\n`, { mode: 0o600 });
  fs.chmodSync(sourceUrlFile, 0o600);
  let concurrentWriteCommitted = false;
  const result = await createPostgresLogicalBackup({
    connectionFile: sourceUrlFile,
    outputDirectory: directory,
  }, {
    env: { ...process.env, NODE_ENV: "test" },
    allowInsecureLoopbackForTests: true,
    runProcess: async (invocation) => {
      if (
        !concurrentWriteCommitted
        && invocation.command.endsWith("pg_dump")
        && invocation.args[0] !== "--version"
      ) {
        const writer = new Client({ connectionString: sourceAdminUrl.toString() });
        await writer.connect();
        try {
          await writer.query(`INSERT INTO pintpath_app.system_state
            (key, value_json, revision, updated_at)
            VALUES ('outside-exported-snapshot', '{"outside":true}'::jsonb,
                    'outside-snapshot', clock_timestamp())`);
          concurrentWriteCommitted = true;
        } finally {
          await writer.end();
        }
      }
      return runPostgresBackupProcess(invocation);
    },
  });
  if (!concurrentWriteCommitted) throw new Error("Concurrent snapshot test write was not committed.");
  return { directory, manifestSha256: result.manifestSha256 };
}

describe.skipIf(!configuredAdminUrl)("real PostgreSQL logical restore rehearsal", () => {
  let adminUrl: URL;
  let admin: Client;
  let root = "";
  let runtimeRoleExisted = false;
  let migratorRoleExisted = false;
  let backupLoginCreated = false;

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const version = await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    );
    if (!/^17\d{4}$/.test(version.rows[0]?.version ?? "")) {
      throw new Error("The disposable logical restore integration requires PostgreSQL 17.");
    }
    const roles = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [["pintpath_runtime", "pintpath_migrator"]],
    );
    runtimeRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_runtime");
    migratorRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_migrator");
    for (const database of [SOURCE_DATABASE, TARGET_DATABASE]) {
      await admin.query(`CREATE DATABASE ${database}`);
    }
    await admin.query(
      `ALTER DATABASE ${TARGET_DATABASE} SET pintpath.logical_restore_target_class TO 'disposable-rehearsal'`,
    );
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-logical-restore-integration-")));
    fs.chmodSync(root, 0o700);

    const source = new Client({ connectionString: withDatabase(adminUrl, SOURCE_DATABASE).toString() });
    await source.connect();
    try {
      await source.query(fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"));
      await source.query(`UPDATE pintpath_app.schema_metadata
        SET value = CASE key
          WHEN 'import_state' THEN 'ready'
          WHEN 'migration_candidate_sha' THEN $1
          WHEN 'migration_manifest_sha256' THEN $2
          WHEN 'migration_plan_sha256' THEN $3
          WHEN 'migration_run_sha256' THEN $4
          WHEN 'source_schema_fingerprint' THEN $5
          WHEN 'source_schema_version' THEN $6
          WHEN 'source_snapshot_sha256' THEN $7
          WHEN 'target_ddl_sha256' THEN $8
          ELSE value
        END`, [
        "c".repeat(40), "1".repeat(64), "2".repeat(64), "3".repeat(64),
        POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
        String(POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion),
        "4".repeat(64), "5".repeat(64),
      ]);
      const revision = await source.query<{ exists: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'pintpath_app'
          AND relation.relname = 'system_state'
          AND attribute.attname = 'revision'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      ) AS exists`);
      if (revision.rows[0]?.exists) {
        await source.query(`INSERT INTO pintpath_app.system_state
          (key, value_json, revision, updated_at)
          VALUES ('restore-integration', '{"ok":true}'::jsonb, 'integration-revision', clock_timestamp())`);
      } else {
        await source.query(`INSERT INTO pintpath_app.system_state
          (key, value_json, updated_at)
          VALUES ('restore-integration', '{"ok":true}'::jsonb, clock_timestamp())`);
      }
      await source.query(`CREATE ROLE ${BACKUP_LOGIN}
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD '${BACKUP_PASSWORD}'`);
      backupLoginCreated = true;
      await source.query(`GRANT pintpath_migrator TO ${BACKUP_LOGIN}`);
      await source.query(`GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${BACKUP_LOGIN}`);
    } finally {
      await source.end();
    }
  }, 30_000);

  afterAll(async () => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (admin) {
      for (const database of [SOURCE_DATABASE, TARGET_DATABASE]) {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [database],
        ).catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS ${database}`).catch(() => undefined);
      }
      if (backupLoginCreated) {
        await admin.query(`DROP ROLE IF EXISTS ${BACKUP_LOGIN}`).catch(() => undefined);
      }
      if (!runtimeRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_runtime").catch(() => undefined);
      if (!migratorRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_migrator").catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 30_000);

  it("restores a real PG17 custom archive and verifies the native private schema", async () => {
    const sourceAdminUrl = withDatabase(adminUrl, SOURCE_DATABASE);
    const sourceUrl = withDatabase(adminUrl, SOURCE_DATABASE);
    sourceUrl.username = BACKUP_LOGIN;
    sourceUrl.password = BACKUP_PASSWORD;
    const targetUrl = withDatabase(adminUrl, TARGET_DATABASE);
    const backup = await createLogicalBackup(sourceUrl, sourceAdminUrl, root);
    const targetUrlFile = path.join(root, "target-url");
    fs.writeFileSync(targetUrlFile, `${targetUrl.toString()}\n`, { mode: 0o600 });
    fs.chmodSync(targetUrlFile, 0o600);
    const dependencyOverrides = {
      env: { ...process.env, NODE_ENV: "test" },
      allowInsecureLoopbackForTests: true,
    } as const;
    const inspection = await inspectPostgresLogicalRestoreTarget(
      { targetUrlFile },
      dependencyOverrides,
    );
    const receiptFile = path.join(root, "restore-receipt.json");
    const restored = await restorePostgresLogicalBackup({
      backupDirectory: backup.directory,
      expectedBackupManifestSha256: backup.manifestSha256,
      targetUrlFile,
      expectedTargetIdentitySha256: inspection.targetIdentitySha256,
      receiptFile,
      confirmation: POSTGRES_LOGICAL_RESTORE_CONFIRMATION_VALUE,
    }, dependencyOverrides);
    expect(restored).toMatchObject({
      ok: true,
      authoritativeRowCount: "1",
      nonEmptyAuthoritativeTableCount: 1,
      promotionReconciliationReady: true,
      sourceStateBindingStatus: "exact-match",
    });
    const target = new Client({ connectionString: targetUrl.toString() });
    await target.connect();
    try {
      const row = await target.query<{ value_json: { ok: boolean } }>(
        "SELECT value_json FROM pintpath_app.system_state WHERE key = 'restore-integration'",
      );
      expect(row.rows).toEqual([{ value_json: { ok: true } }]);
      const outside = await target.query<{ present: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pintpath_app.system_state WHERE key = 'outside-exported-snapshot'
      ) AS present`);
      expect(outside.rows).toEqual([{ present: false }]);
    } finally {
      await target.end();
    }
    expect(fs.statSync(receiptFile).mode & 0o7777).toBe(0o600);
  }, 120_000);
});
