import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { postgresAccountDeletionReplayTargetIdentitySha256 } from "../src/lib/postgres-account-deletion-replay.js";
import {
  createPostgresPrivateStorageDatabaseInspector,
  postgresPrivateStorageRecoveryInternals,
} from "../src/lib/postgres-private-storage-recovery.js";

const ADMIN_URL_ENV =
  "PINTPATH_POSTGRES_PRIVATE_STORAGE_RECOVERY_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const SUFFIX =
  `${process.pid}_${crypto.randomBytes(5).toString("hex")}`.toLowerCase();
const TEST_DATABASE = `pintpath_storage_recovery_${SUFFIX}`;
const TEST_LOGIN = `pintpath_storage_recovery_login_${SUFFIX}`;
const TEST_PASSWORD = `StorageRecovery_${crypto.randomBytes(24).toString("base64url")}`;
const USER_ID = `storage-recovery-user-${SUFFIX}`;
const OBJECT_PATH = `accounts/${USER_ID}/evidence.pdf`;
const OBJECT_BYTES = 21;
const CREATED_AT = "2026-08-09T06:30:00.000Z";

function validateAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${ADMIN_URL_ENV} must be an explicit loopback PostgreSQL admin URL.`,
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      url.hostname.toLowerCase(),
    ) ||
    decodeURIComponent(url.pathname.slice(1)) !== "postgres" ||
    !url.username ||
    !url.password ||
    url.searchParams.get("sslmode") !== "disable" ||
    [...url.searchParams.keys()].some((key) => key !== "sslmode") ||
    url.hash ||
    /[\r\n\0]/.test(value)
  )
    throw new Error(
      `${ADMIN_URL_ENV} must target a disposable loopback PG17 database.`,
    );
  return url;
}

function withDatabase(
  url: URL,
  database: string,
  username?: string,
  password?: string,
): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  if (username !== undefined) result.username = username;
  if (password !== undefined) result.password = password;
  return result.toString();
}

describe.skipIf(!configuredAdminUrl)(
  "restricted PG17 private Storage recovery inspection",
  () => {
    let adminUrl: URL;
    let maintenance: Client | null = null;
    let databaseAdmin: Client | null = null;
    let restrictedUrl = "";
    let runtimeRoleExisted = false;
    let migratorRoleExisted = false;

    beforeAll(async () => {
      adminUrl = validateAdminUrl(configuredAdminUrl);
      maintenance = new Client({ connectionString: adminUrl.toString() });
      await maintenance.connect();
      const version = await maintenance.query<{ version: string }>(
        "SELECT current_setting('server_version_num') AS version",
      );
      if (!/^17\d{4}$/.test(version.rows[0]?.version ?? "")) {
        throw new Error(
          "Private Storage recovery integration requires PostgreSQL 17.",
        );
      }
      const roles = await maintenance.query<{ rolname: string }>(
        "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
        [["pintpath_runtime", "pintpath_migrator"]],
      );
      runtimeRoleExisted = roles.rows.some(
        (row) => row.rolname === "pintpath_runtime",
      );
      migratorRoleExisted = roles.rows.some(
        (row) => row.rolname === "pintpath_migrator",
      );
      await maintenance.query(`CREATE DATABASE ${TEST_DATABASE}`);
      databaseAdmin = new Client({
        connectionString: withDatabase(adminUrl, TEST_DATABASE),
      });
      await databaseAdmin.connect();
      await databaseAdmin.query(
        fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"),
      );
      await databaseAdmin.query(
        `UPDATE pintpath_app.schema_metadata
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
      END`,
        [
          "c".repeat(40),
          "1".repeat(64),
          "2".repeat(64),
          "3".repeat(64),
          POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
          String(POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion),
          "4".repeat(64),
          "5".repeat(64),
        ],
      );
      await databaseAdmin.query(
        `INSERT INTO pintpath_app.accounts (
      id, public_account_id, email, password_hash, auth_provider, role,
      subscription_status, status, created_at, updated_at
    ) VALUES ($1, $1, $2, 'integration-password-hash', 'local', 'user',
              'free', 'active', $3::timestamptz, $3::timestamptz)`,
        [USER_ID, `${USER_ID}@example.test`, CREATED_AT],
      );
      await databaseAdmin.query(
        `INSERT INTO pintpath_app.source_evidence_objects (
      id, owner_user_id, storage_provider, object_path, mime_type, byte_size, created_at
    ) VALUES ($1, $2, 'supabase_private', $3, 'application/pdf', $4, $5::timestamptz)`,
        [`evidence-${SUFFIX}`, USER_ID, OBJECT_PATH, OBJECT_BYTES, CREATED_AT],
      );
      await maintenance.query(`CREATE ROLE ${TEST_LOGIN}
      LOGIN PASSWORD '${TEST_PASSWORD}' INHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await maintenance.query(`GRANT pintpath_migrator TO ${TEST_LOGIN}`);
      await databaseAdmin.query(
        `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${TEST_LOGIN}`,
      );
      restrictedUrl = withDatabase(
        adminUrl,
        TEST_DATABASE,
        TEST_LOGIN,
        TEST_PASSWORD,
      );
    }, 30_000);

    afterAll(async () => {
      await databaseAdmin?.end().catch(() => undefined);
      if (maintenance) {
        await maintenance
          .query(
            "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
            [TEST_DATABASE],
          )
          .catch(() => undefined);
        await maintenance
          .query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`)
          .catch(() => undefined);
        await maintenance
          .query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`)
          .catch(() => undefined);
        if (!runtimeRoleExisted) {
          await maintenance
            .query("DROP ROLE IF EXISTS pintpath_runtime")
            .catch(() => undefined);
        }
        if (!migratorRoleExisted) {
          await maintenance
            .query("DROP ROLE IF EXISTS pintpath_migrator")
            .catch(() => undefined);
        }
        await maintenance.end().catch(() => undefined);
      }
    }, 30_000);

    it("reads exact state and live private-Storage references under a restricted backup login", async () => {
      const expectedConnectionUrlSha256 = crypto
        .createHash("sha256")
        .update(restrictedUrl)
        .digest("hex");
      const inspect = createPostgresPrivateStorageDatabaseInspector({
        connectionString: restrictedUrl,
        expectedConnectionUrlSha256,
        allowInsecureLoopbackForTests: true,
        environment: { NODE_ENV: "test" },
      });
      const source = await inspect();
      expect(source).toMatchObject({
        connectionUrlSha256: expectedConnectionUrlSha256,
        targetClass: null,
        references: [
          {
            objectPath: OBJECT_PATH,
            mimeType: "application/pdf",
            byteSize: OBJECT_BYTES,
          },
        ],
      });
      expect(source.databaseIdentitySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(
        source.state.tables.find(
          (table) => table.tableName === "source_evidence_objects",
        ),
      ).toMatchObject({ rowCount: "1" });

      const identity = await databaseAdmin!.query<{
        systemIdentifier: string;
        databaseOid: string;
        databaseName: string;
        serverVersionNum: string;
      }>(`SELECT control.system_identifier::text AS "systemIdentifier",
              database.oid::text AS "databaseOid",
              current_database() AS "databaseName",
              current_setting('server_version_num') AS "serverVersionNum"
         FROM pg_catalog.pg_database AS database
         CROSS JOIN pg_catalog.pg_control_system() AS control
        WHERE database.datname = current_database()`);
      await maintenance!.query(
        `ALTER DATABASE ${TEST_DATABASE}
         SET pintpath.logical_restore_target_class TO 'disposable-rehearsal'`,
      );
      const disposable = await inspect();
      expect(disposable.targetClass).toBe("disposable-rehearsal");
      expect(disposable.databaseIdentitySha256).toBe(
        postgresAccountDeletionReplayTargetIdentitySha256({
          ...identity.rows[0]!,
          targetClass: "disposable-rehearsal",
        }),
      );
      expect(disposable.databaseIdentitySha256).not.toBe(
        source.databaseIdentitySha256,
      );

      await databaseAdmin!.query(
        `UPDATE pintpath_app.source_evidence_objects
      SET deleted_at = $1::timestamptz WHERE object_path = $2`,
        [CREATED_AT, OBJECT_PATH],
      );
      const afterDeletion = await inspect();
      expect(afterDeletion.references).toEqual([]);
      expect(afterDeletion.state.overallStateSha256).not.toBe(
        source.state.overallStateSha256,
      );
      expect(
        postgresPrivateStorageRecoveryInternals.connectionUrl({
          value: restrictedUrl,
          allowInsecureLoopbackForTests: true,
          environment: { NODE_ENV: "test" },
        }).urlSha256,
      ).toBe(expectedConnectionUrlSha256);
    }, 60_000);
  },
);
