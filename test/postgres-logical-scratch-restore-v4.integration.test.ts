import crypto from "node:crypto";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { POSTGRES_MIGRATION_EXPECTED_LIVE_SCHEMA_SHA256 } from "../src/db/postgres-migration-live-schema.js";
import { sha256PostgresMigrationContract } from "../src/db/postgres-migration-schema.js";
import {
  POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS,
  POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_SCRATCH_RESTORE_OPTIONS,
} from "../src/lib/postgres-logical-backup-v4.js";
import { POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS } from "../src/lib/postgres-logical-backup-v4-table-data-contract.js";
import { parsePostgresLogicalBackupV4TocListing } from "../src/lib/postgres-logical-backup-v4-toc.js";
import {
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEYS,
  POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL,
  projectPostgresLogicalScratchRestoreV4V2ShapeComparison,
  validatePostgresLogicalScratchRestoreV4DisposalObservation,
  validatePostgresLogicalScratchRestoreV4PostLoadObservation,
  validatePostgresLogicalScratchRestoreV4PreLoadObservation,
  type PostgresLogicalScratchRestoreV4CatalogCounts,
  type PostgresLogicalScratchRestoreV4RelationRowCount,
  type PostgresLogicalScratchRestoreV4SeedRow,
} from "../src/lib/postgres-logical-scratch-restore-v4.js";
import {
  canonicalPostgresLogicalStateJson,
  capturePostgresLogicalStateV2,
  exactPostgresLogicalStateMatchV2,
  postgresLogicalStateInternals,
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalStateCaptureV2,
  type PostgresLogicalStateV2Connection,
} from "../src/lib/postgres-logical-state.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_TEST_ADMIN_URL";
const PG_BIN_ENV = "PINTPATH_POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_TEST_PG_BIN";
const REQUIRED_ENV = "PINTPATH_POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_TEST_REQUIRED";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const configuredPgBin = process.env[PG_BIN_ENV]?.trim() ?? "";
const configuredRequired = process.env[REQUIRED_ENV]?.trim() ?? "";
const suffix = `${process.pid}_${crypto.randomBytes(5).toString("hex")}`;
const sourceDatabase = `pintpath_scratch_v4_source_${suffix}`;
const targetDatabase = `pintpath_scratch_v4_target_${suffix}`;
const schemaSql = fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8");
const kernelSql = fs.readFileSync(path.resolve(
  "supabase/migrations/20260812022314_add_inert_reviewed_price_promotion_kernel.sql",
), "utf8");
const PROCESS_TIMEOUT_MS = 60_000;

if (configuredRequired !== "" && configuredRequired !== "true") {
  throw new Error(`${REQUIRED_ENV} must be true when set.`);
}
if (configuredRequired === "true" && (!configuredAdminUrl || !configuredPgBin)) {
  throw new Error(`${ADMIN_URL_ENV} and ${PG_BIN_ENV} are mandatory when ${REQUIRED_ENV}=true.`);
}
if ((configuredAdminUrl && !configuredPgBin) || (!configuredAdminUrl && configuredPgBin)) {
  throw new Error(`${ADMIN_URL_ENV} and ${PG_BIN_ENV} must be configured together.`);
}

function validateAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} must be a disposable loopback PostgreSQL URL.`);
  }
  if (!(["postgres:", "postgresql:"].includes(url.protocol))
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase())
    || decodeURIComponent(url.pathname.slice(1)) !== "postgres"
    || !url.username || !url.password || url.searchParams.get("sslmode") !== "disable"
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")
    || url.hash || /[\r\n\0]/.test(value)) {
    throw new Error(`${ADMIN_URL_ENV} must target a disposable loopback PG17 database.`);
  }
  return url;
}

function validatePgBin(value: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || path.resolve(value) !== value
    || fs.realpathSync.native(value) !== value || !fs.statSync(value).isDirectory()) {
    throw new Error(`${PG_BIN_ENV} must be a canonical absolute PostgreSQL 17 bin directory.`);
  }
  return value;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe_test_identifier");
  return `"${value}"`;
}

function quoteSystemIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    throw new Error("unsafe_system_identifier");
  }
  return `"${value}"`;
}

function quoteQualifiedName(value: string): string {
  const [schemaName, relationName, ...extra] = value.split(".");
  if (!schemaName || !relationName || extra.length !== 0) {
    throw new Error("unsafe_qualified_name");
  }
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(relationName)}`;
}

function quoteLiteral(value: string): string {
  if (/[/\r\n\0]/.test(value)) throw new Error("unsafe_test_literal");
  return `'${value.replaceAll("'", "''")}'`;
}

function withDatabase(url: URL, database: string): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  return result.toString();
}

function scopedRoleNames(databaseOid: string): readonly string[] {
  if (!/^[1-9][0-9]{0,9}$/.test(databaseOid)) throw new Error("unsafe_test_database_oid");
  return [
    `pintpath_logical_backup_d${databaseOid}`,
    `pintpath_reviewed_price_apply_owner_d${databaseOid}`,
    `pintpath_reviewed_price_apply_execute_d${databaseOid}`,
    `pintpath_reviewed_price_quarantine_owner_d${databaseOid}`,
    `pintpath_reviewed_price_quarantine_execute_d${databaseOid}`,
  ];
}

function sha256Bytes(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function executable(file: string): string {
  const resolved = fs.realpathSync.native(file);
  const stat = fs.statSync(resolved);
  if (resolved !== file || !stat.isFile() || (stat.mode & 0o022) !== 0) {
    throw new Error("reviewed_pg17_tool_unavailable");
  }
  return resolved;
}

function toolEnvironment(adminUrl: URL, database: string): NodeJS.ProcessEnv {
  const host = adminUrl.hostname.replace(/^\[|\]$/g, "");
  return {
    LC_ALL: "C",
    TZ: "UTC",
    PGHOST: host,
    ...(host === "127.0.0.1" || host === "::1" ? { PGHOSTADDR: host } : {}),
    PGPORT: adminUrl.port || "5432",
    PGDATABASE: database,
    PGUSER: decodeURIComponent(adminUrl.username),
    PGPASSWORD: decodeURIComponent(adminUrl.password),
    PGSSLMODE: "disable",
    PGGSSENCMODE: "disable",
    PGCONNECT_TIMEOUT: "15",
    PGAPPNAME: "pintpath-v4-scratch-restore-mechanism-observation",
    PGPASSFILE: "/dev/null",
    PGSERVICEFILE: "/dev/null",
    PGSYSCONFDIR: "/dev/null",
  };
}

async function observeExactSetOnlyMembership(
  admin: Client,
  backupGroupRoleName: string,
  loginRoleName: string,
): Promise<{ total: number; exact: number }> {
  const result = await admin.query<{ total: number; exact: number }>(`SELECT
    pg_catalog.count(*)::pg_catalog.int4 AS total,
    pg_catalog.count(*) FILTER (
      WHERE membership.set_option
        AND NOT membership.inherit_option
        AND NOT membership.admin_option
    )::pg_catalog.int4 AS exact
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS parent ON parent.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS child ON child.oid = membership.member
    WHERE parent.rolname = $1 AND child.rolname = $2`, [
    backupGroupRoleName,
    loginRoleName,
  ]);
  const row = result.rows[0];
  if (result.rowCount !== 1 || !row) throw new Error("membership_observation_unavailable");
  return row;
}

async function waitForZeroActiveRoleSessions(admin: Client, roleOid: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    const result = await admin.query<{ count: number }>(`SELECT
      pg_catalog.count(*)::pg_catalog.int4 AS count
      FROM pg_catalog.pg_stat_activity AS activity
      WHERE activity.usesysid = $1::pg_catalog.oid
        AND activity.pid <> pg_catalog.pg_backend_pid()`, [roleOid]);
    if (result.rows[0]?.count === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("ephemeral_login_sessions_survived_termination");
}

function toolVersion(file: string, prefix: string): string {
  const output = execFileSync(file, ["--version"], {
    encoding: "utf8",
    env: { LC_ALL: "C", TZ: "UTC" },
    killSignal: "SIGKILL",
    timeout: PROCESS_TIMEOUT_MS,
  }).trim();
  if (!output.startsWith(prefix)) throw new Error("postgres_tool_version_invalid");
  const version = output.slice(prefix.length);
  if (!/^17\.[^\r\n]{1,120}$/.test(version)) throw new Error("postgres_tool_version_invalid");
  return version;
}

function assertSpawnSuccess(
  result: SpawnSyncReturns<string | Buffer>,
  label: string,
): void {
  if (result.error) throw result.error;
  const stderr = typeof result.stderr === "string"
    ? result.stderr
    : result.stderr?.toString("utf8") ?? "";
  if (result.status !== 0 || result.signal !== null || stderr !== "") {
    throw new Error(`${label}_failed:${result.status ?? "null"}:${result.signal ?? "none"}:${stderr}`);
  }
}

async function databaseOid(client: Client): Promise<string> {
  const result = await client.query<{ oid: string }>(`SELECT database.oid::pg_catalog.text AS oid
    FROM pg_catalog.pg_database AS database
    WHERE database.datname = pg_catalog.current_database()`);
  const oid = result.rows[0]?.oid;
  if (result.rows.length !== 1 || !oid || !/^[1-9][0-9]{0,9}$/.test(oid)) {
    throw new Error("test_database_oid_unavailable");
  }
  return oid;
}

function asV2Connection(client: Client): PostgresLogicalStateV2Connection {
  const processID = (client as Client & { readonly processID?: unknown }).processID;
  if (!Number.isSafeInteger(processID) || Number(processID) < 1) {
    throw new Error("test_backend_pid_unavailable");
  }
  return client as Client & PostgresLogicalStateV2Connection;
}

async function captureReadOnlyV2(client: Client): Promise<PostgresLogicalStateCaptureV2> {
  const oid = await databaseOid(client);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(`pintpath_logical_backup_d${oid}`)}`);
    await client.query("SET LOCAL search_path = pg_catalog, pg_temp");
    const capture = await capturePostgresLogicalStateV2(asV2Connection(client), { pageRows: 1 });
    await client.query("COMMIT");
    return capture;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function configureReviewedMetadata(client: Client): Promise<void> {
  const values = {
    import_state: "ready",
    live_schema_sha256: POSTGRES_MIGRATION_EXPECTED_LIVE_SCHEMA_SHA256,
    migration_candidate_sha: "a".repeat(40),
    migration_contract_sha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
    migration_manifest_sha256: "b".repeat(64),
    migration_plan_sha256: "c".repeat(64),
    migration_run_sha256: "d".repeat(64),
    schema_version: "1",
    source_schema_fingerprint: POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
    source_schema_sha256: POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.staticAuthority
      .sourceSchemaSha256,
    source_schema_version: String(POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion),
    source_snapshot_sha256: "f".repeat(64),
    target_ddl_sha256: POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.staticAuthority
      .baseDdlSha256,
  } as const;
  for (const [key, value] of Object.entries(values)) {
    const result = await client.query(
      `UPDATE pintpath_app.schema_metadata
       SET value = $2, updated_at = '2026-08-12T00:00:00.000Z'::pg_catalog.timestamptz
       WHERE key = $1`,
      [key, value],
    );
    if (result.rowCount !== 1) throw new Error("reviewed_metadata_update_failed");
  }
}

async function seedSourceRows(client: Client): Promise<void> {
  await client.query(`INSERT INTO pintpath_app.system_state (key, value_json, updated_at, revision)
    VALUES ('scratch_restore_probe', '{"source":"exported-snapshot"}'::pg_catalog.jsonb,
      '2026-08-12T01:00:00.000Z'::pg_catalog.timestamptz, 'v1')`);
  await client.query(`INSERT INTO pintpath_ops.migration_runs (
      run_id, source_snapshot_sha256, source_schema_fingerprint, contract_sha256,
      manifest_sha256, target_ddl_sha256, source_schema_version, candidate_commit_sha,
      target_binding_sha256, expected_environment, approval_reference_sha256,
      operator_id_sha256, verifier_id_sha256, status, started_at, completed_at,
      receipt_sha256, failure_code
    ) VALUES (
      'scratch-run', $1, $2, $3, $4, $5, $6, $7, $8, 'permanent-staging',
      $9, $10, $11, 'ready', $12::pg_catalog.timestamptz,
      $13::pg_catalog.timestamptz, $14, NULL
    )`, [
    "1".repeat(64),
    POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
    sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
    "2".repeat(64),
    POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.staticAuthority.baseDdlSha256,
    POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion,
    "a".repeat(40),
    "3".repeat(64),
    "4".repeat(64),
    "5".repeat(64),
    "6".repeat(64),
    "2026-08-12T01:00:00.000Z",
    "2026-08-12T01:00:01.000Z",
    "7".repeat(64),
  ]);
  await client.query(`INSERT INTO pintpath_ops.migration_chunks (
      run_id, table_name, chunk_ordinal, row_count, source_transformed_sha256,
      target_sha256, completed_at
    ) VALUES ('scratch-run', 'system_state', 0, 1, $1, $2,
      '2026-08-12T01:00:01.000Z'::pg_catalog.timestamptz)`, [
    "8".repeat(64), "9".repeat(64),
  ]);
}

interface BoundaryEvidence {
  readonly databaseOid: string;
  readonly physicalReadBoundarySha256: string;
  readonly portableReadBoundarySha256: string;
}

async function readBoundaryEvidence(client: Client): Promise<BoundaryEvidence> {
  const result = await client.query<{ databaseOid: string; descriptorJson: string }>(
    postgresLogicalStateInternals.sourceReadBoundarySql,
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || !row || typeof row.descriptorJson !== "string"
    || Buffer.byteLength(row.descriptorJson, "utf8") > 4 * 1024 * 1024) {
    throw new Error("source_read_boundary_unavailable");
  }
  const descriptor = JSON.parse(row.descriptorJson) as Record<string, unknown>;
  if (typeof descriptor.databaseOwner !== "string") {
    throw new Error("source_read_boundary_owner_unavailable");
  }
  const normalized = postgresLogicalStateInternals.normalizeSourceReadBoundaryValue(
    descriptor,
    row.databaseOid,
  );
  const expected = postgresLogicalStateInternals.expectedSourceReadBoundaryDescriptor(
    descriptor.databaseOwner,
  );
  expect(canonicalPostgresLogicalStateJson(normalized))
    .toBe(canonicalPostgresLogicalStateJson(expected));
  return {
    databaseOid: row.databaseOid,
    physicalReadBoundarySha256: sha256CanonicalPostgresLogicalState({
      kind: "pintpath-postgres-logical-state-physical-source-read-boundary",
      version: 1,
      databaseOid: row.databaseOid,
      descriptor,
    }),
    portableReadBoundarySha256: sha256CanonicalPostgresLogicalState(
      postgresLogicalStateInternals.sourceReadBoundaryHashProjection(expected),
    ),
  };
}

function normalizeSeedRows(rows: readonly Record<string, unknown>[]): PostgresLogicalScratchRestoreV4SeedRow[] {
  return rows.map((row) => {
    const updatedAt = row.updatedAt;
    if (!(updatedAt instanceof Date) || !Number.isFinite(updatedAt.valueOf())) {
      throw new Error("seed_timestamp_invalid");
    }
    return {
      key: String(row.key),
      value: String(row.value),
      updatedAt: updatedAt.toISOString(),
    };
  }).sort((left, right) => Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)));
}

async function readCatalogCounts(client: Client): Promise<PostgresLogicalScratchRestoreV4CatalogCounts> {
  const result = await client.query<PostgresLogicalScratchRestoreV4CatalogCounts & QueryResultRow>(
    POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.catalogCountsSql,
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || !row) throw new Error("catalog_counts_unavailable");
  return row;
}

async function readRelationRows(client: Client): Promise<PostgresLogicalScratchRestoreV4RelationRowCount[]> {
  const result = await client.query<PostgresLogicalScratchRestoreV4RelationRowCount & QueryResultRow>(
    POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.relationRowsSql,
  );
  if (result.rows.length !== POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS.length) {
    throw new Error("relation_counts_unavailable");
  }
  return result.rows;
}

function accessShareLockSql(): string {
  return `LOCK TABLE ${POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_ALL_RELATIONS.map(
    (name) => `ONLY ${quoteQualifiedName(name)}`,
  ).join(", ")} IN ACCESS SHARE MODE`;
}

interface ApplicationTriggerProof {
  readonly disabledParentRiConstraintNames: readonly [
    "pint_point_drink_records_voided_by_user_id_fkey",
    "venue_claim_requests_reviewed_by_fkey",
  ];
  readonly applicationTriggerName: "clear_added_account_references_before_delete";
  readonly applicationTriggerFunction: "pintpath_app.clear_account_references_before_delete";
  readonly exactDisabledParentRiTriggerCount: 2;
  readonly applicationTriggerEnabled: true;
  readonly fixtureAccountRowsInserted: 2;
  readonly fixtureChildRowsInserted: 2;
  readonly reviewerAccountRowsDeleted: 1;
  readonly survivingChildRows: 2;
  readonly nullReferenceRows: 2;
  readonly transactionRolledBack: true;
  readonly fixtureResidueRows: 0;
  readonly postRollbackEnabledPrivateTriggerCount: 317;
  readonly postRollbackSchemaUnchanged: true;
}

async function proveApplicationTrigger(client: Client): Promise<ApplicationTriggerProof> {
  const fixtureUser = `scratch_fixture_user_${suffix}`;
  const fixtureReviewer = `scratch_fixture_reviewer_${suffix}`;
  const drinkId = `scratch_fixture_drink_${suffix}`;
  const claimId = `scratch_fixture_claim_${suffix}`;
  let disabledConstraintNames: string[] = [];
  let applicationTriggerEnabled = false;
  let accountRows = 0;
  let childRows = 0;
  let deletedRows = 0;
  let survivingRows = 0;
  let nullRows = 0;

  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL search_path = pg_catalog, pg_temp");
    const selected = await client.query<{
      triggerName: string;
      constraintName: string;
      functionSchema: string;
      functionName: string;
    }>(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.triggerSelectorSql);
    disabledConstraintNames = selected.rows.map((row) => row.constraintName);
    expect(disabledConstraintNames).toEqual([
      "pint_point_drink_records_voided_by_user_id_fkey",
      "venue_claim_requests_reviewed_by_fkey",
    ]);
    for (const row of selected.rows) {
      expect(`${row.functionSchema}.${row.functionName}`).toBe("pg_catalog.RI_FKey_setnull_del");
      await client.query(`ALTER TABLE ONLY pintpath_app.accounts DISABLE TRIGGER ${
        quoteSystemIdentifier(row.triggerName)
      }`);
    }
    const applicationTrigger = await client.query<{ enabled: boolean }>(`SELECT
      trigger_object.tgenabled = 'O' AS enabled
      FROM pg_catalog.pg_trigger AS trigger_object
      WHERE trigger_object.tgrelid = 'pintpath_app.accounts'::pg_catalog.regclass
        AND trigger_object.tgname = 'clear_added_account_references_before_delete'
        AND NOT trigger_object.tgisinternal`);
    applicationTriggerEnabled = applicationTrigger.rows.length === 1
      && applicationTrigger.rows[0]?.enabled === true;

    const insertedAccounts = await client.query(`INSERT INTO pintpath_app.accounts
      (id, email, password_hash, created_at, updated_at) VALUES
      ($1, $2, 'fixture-hash', '2026-08-12T02:00:00Z', '2026-08-12T02:00:00Z'),
      ($3, $4, 'fixture-hash', '2026-08-12T02:00:00Z', '2026-08-12T02:00:00Z')`, [
      fixtureUser, `${fixtureUser}@example.invalid`,
      fixtureReviewer, `${fixtureReviewer}@example.invalid`,
    ]);
    accountRows = insertedAccounts.rowCount ?? 0;
    const drink = await client.query(`INSERT INTO pintpath_app.pint_point_drink_records
      (id, user_id, venue_id, venue_name, item_name, voided_by_user_id, recorded_at, created_at)
      VALUES ($1, $2, 'fixture-venue', 'Fixture Venue', 'Fixture Pint', $3,
        '2026-08-12T02:00:00Z', '2026-08-12T02:00:00Z')`, [
      drinkId, fixtureUser, fixtureReviewer,
    ]);
    const claim = await client.query(`INSERT INTO pintpath_app.venue_claim_requests
      (id, user_id, venue_name, requester_name, requester_role, contact_email,
       status, reviewed_by, reviewed_at, created_at, updated_at)
      VALUES ($1, $2, 'Fixture Venue', 'Fixture User', 'owner', $3,
        'approved', $4, '2026-08-12T02:00:00Z', '2026-08-12T02:00:00Z',
        '2026-08-12T02:00:00Z')`, [
      claimId, fixtureUser, `${fixtureUser}@example.invalid`, fixtureReviewer,
    ]);
    childRows = (drink.rowCount ?? 0) + (claim.rowCount ?? 0);
    const deleted = await client.query("DELETE FROM pintpath_app.accounts WHERE id = $1", [
      fixtureReviewer,
    ]);
    deletedRows = deleted.rowCount ?? 0;
    const childState = await client.query<{ surviving: number; nulls: number }>(`SELECT
      ((SELECT pg_catalog.count(*) FROM ONLY pintpath_app.pint_point_drink_records WHERE id = $1)
       + (SELECT pg_catalog.count(*) FROM ONLY pintpath_app.venue_claim_requests WHERE id = $2))::pg_catalog.int4 AS surviving,
      ((SELECT pg_catalog.count(*) FROM ONLY pintpath_app.pint_point_drink_records
          WHERE id = $1 AND voided_by_user_id IS NULL)
       + (SELECT pg_catalog.count(*) FROM ONLY pintpath_app.venue_claim_requests
          WHERE id = $2 AND reviewed_by IS NULL))::pg_catalog.int4 AS nulls`, [drinkId, claimId]);
    survivingRows = childState.rows[0]?.surviving ?? -1;
    nullRows = childState.rows[0]?.nulls ?? -1;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }

  const residue = await client.query<{ count: number }>(`SELECT (
    (SELECT pg_catalog.count(*) FROM ONLY pintpath_app.accounts WHERE id = ANY($1::pg_catalog.text[]))
    + (SELECT pg_catalog.count(*) FROM ONLY pintpath_app.pint_point_drink_records WHERE id = $2)
    + (SELECT pg_catalog.count(*) FROM ONLY pintpath_app.venue_claim_requests WHERE id = $3)
  )::pg_catalog.int4 AS count`, [[fixtureUser, fixtureReviewer], drinkId, claimId]);
  const catalog = await readCatalogCounts(client);
  return {
    disabledParentRiConstraintNames: disabledConstraintNames as ApplicationTriggerProof[
      "disabledParentRiConstraintNames"
    ],
    applicationTriggerName: "clear_added_account_references_before_delete",
    applicationTriggerFunction: "pintpath_app.clear_account_references_before_delete",
    exactDisabledParentRiTriggerCount: disabledConstraintNames.length as 2,
    applicationTriggerEnabled: applicationTriggerEnabled as true,
    fixtureAccountRowsInserted: accountRows as 2,
    fixtureChildRowsInserted: childRows as 2,
    reviewerAccountRowsDeleted: deletedRows as 1,
    survivingChildRows: survivingRows as 2,
    nullReferenceRows: nullRows as 2,
    transactionRolledBack: true,
    fixtureResidueRows: (residue.rows[0]?.count ?? -1) as 0,
    postRollbackEnabledPrivateTriggerCount: catalog.enabledRiConstraintTriggers
      + catalog.enabledApplicationTriggers as 317,
    postRollbackSchemaUnchanged: true,
  };
}

interface CleanupObservation {
  readonly residualDatabaseCount: number;
  readonly residualScopedRoleCount: number;
  readonly residualSessionCount: number;
  readonly residualArtifactCount: number;
}

const describeIntegration = configuredAdminUrl && configuredPgBin ? describe : describe.skip;

// Mechanism evidence only. This does not establish source-recorder authority,
// native tool runtime closure, retained-inode authority, or operational V4 restore authority.
describeIntegration("PostgreSQL 17 V4 cross-OID scratch restore mechanism", () => {
  let adminUrl: URL;
  let pgDump = "";
  let pgRestore = "";
  let pgDumpVersion = "";
  let pgRestoreVersion = "";
  let maintenance: Client | null = null;
  let runtimeRoleExisted = false;
  let migratorRoleExisted = false;
  const openClients = new Set<Client>();
  const databaseOids = new Set<string>();
  const ephemeralLoginRoleNames = new Set<string>();
  const temporaryRoots = new Set<string>();

  async function cleanup(): Promise<CleanupObservation> {
    const failures: unknown[] = [];
    for (const client of [...openClients]) {
      openClients.delete(client);
      await client.end().catch((error) => failures.push(error));
    }
    const activeMaintenance = maintenance;
    if (activeMaintenance) {
      try {
        const recoverOids = await activeMaintenance.query<{ oid: string }>(`SELECT oid::pg_catalog.text AS oid
          FROM pg_catalog.pg_database WHERE datname = ANY($1::pg_catalog.text[])`, [
          [sourceDatabase, targetDatabase],
        ]);
        for (const row of recoverOids.rows) databaseOids.add(row.oid);
      } catch (error) {
        failures.push(error);
      }
      for (const database of [sourceDatabase, targetDatabase]) {
        try {
          await activeMaintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
        } catch (error) {
          failures.push(error);
        }
      }
      for (const role of [...ephemeralLoginRoleNames]) {
        try {
          const exists = await activeMaintenance.query<{ exists: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS exists",
            [role],
          );
          if (exists.rows[0]?.exists) {
            await activeMaintenance.query(`ALTER ROLE ${quoteIdentifier(role)} NOLOGIN`);
            await activeMaintenance.query(`DROP ROLE ${quoteIdentifier(role)}`);
          }
        } catch (error) {
          failures.push(error);
        }
      }
      for (const oid of databaseOids) {
        for (const role of scopedRoleNames(oid)) {
          try {
            await activeMaintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      try {
        if (!runtimeRoleExisted) await activeMaintenance.query("DROP ROLE IF EXISTS pintpath_runtime");
        if (!migratorRoleExisted) await activeMaintenance.query("DROP ROLE IF EXISTS pintpath_migrator");
      } catch (error) {
        failures.push(error);
      }
    }
    for (const root of [...temporaryRoots]) {
      try {
        const canonicalRoot = path.resolve(root);
        if (!path.basename(canonicalRoot).startsWith("pintpath-scratch-v4-")) {
          throw new Error("unsafe_temporary_root");
        }
        fs.rmSync(canonicalRoot, { recursive: true, force: true });
        temporaryRoots.delete(root);
      } catch (error) {
        failures.push(error);
      }
    }
    let observation: CleanupObservation = {
      residualDatabaseCount: 0,
      residualScopedRoleCount: 0,
      residualSessionCount: 0,
      residualArtifactCount: temporaryRoots.size,
    };
    if (activeMaintenance) {
      try {
        const roleNames = [
          ...[...databaseOids].flatMap((oid) => scopedRoleNames(oid)),
          ...ephemeralLoginRoleNames,
        ];
        const result = await activeMaintenance.query<CleanupObservation & QueryResultRow>(`SELECT
          (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_database
            WHERE datname = ANY($1::pg_catalog.text[])) AS "residualDatabaseCount",
          (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_roles
            WHERE rolname = ANY($2::pg_catalog.text[])) AS "residualScopedRoleCount",
          (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_stat_activity
            WHERE datname = ANY($1::pg_catalog.text[])) AS "residualSessionCount",
          $3::pg_catalog.int4 AS "residualArtifactCount"`, [
          [sourceDatabase, targetDatabase], roleNames, temporaryRoots.size,
        ]);
        if (result.rowCount !== 1 || !result.rows[0]) throw new Error("cleanup_audit_unavailable");
        observation = result.rows[0];
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
    return observation;
  }

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    const pgBin = validatePgBin(configuredPgBin);
    pgDump = executable(path.join(pgBin, "pg_dump"));
    pgRestore = executable(path.join(pgBin, "pg_restore"));
    pgDumpVersion = toolVersion(pgDump, "pg_dump (PostgreSQL) ");
    pgRestoreVersion = toolVersion(pgRestore, "pg_restore (PostgreSQL) ");
    maintenance = new Client({ connectionString: adminUrl.toString() });
    await maintenance.connect();
    const server = await maintenance.query<{ version: string; superuser: boolean }>(`SELECT
      pg_catalog.current_setting('server_version_num') AS version,
      role.rolsuper AS superuser FROM pg_catalog.pg_roles AS role WHERE role.rolname = CURRENT_USER`);
    if (!/^17\d{4}$/.test(server.rows[0]?.version ?? "") || server.rows[0]?.superuser !== true) {
      throw new Error("scratch_restore_integration_requires_disposable_pg17_superuser");
    }
    const roles = await maintenance.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::pg_catalog.text[])",
      [["pintpath_runtime", "pintpath_migrator"]],
    );
    runtimeRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_runtime");
    migratorRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_migrator");
    await cleanup();
  }, 30_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    await cleanup().catch((error) => failures.push(error));
    await maintenance?.end().catch((error) => failures.push(error));
    maintenance = null;
    if (failures.length > 0) throw failures[0];
  }, 30_000);

  it("restores the exact exported V2 snapshot into a different-OID canonical target and proves integrity", async () => {
    expect(sha256Bytes(schemaSql)).toBe(
      POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.staticAuthority.baseDdlSha256,
    );
    expect(sha256Bytes(kernelSql)).toBe(
      POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.staticAuthority.kernelMigrationSha256,
    );
    expect(POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS).toHaveLength(59);
    const activeMaintenance = maintenance;
    if (!activeMaintenance) throw new Error("maintenance_unavailable");

    for (const database of [sourceDatabase, targetDatabase]) {
      await activeMaintenance.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
      const oidResult = await activeMaintenance.query<{ oid: string }>(
        "SELECT oid::pg_catalog.text AS oid FROM pg_catalog.pg_database WHERE datname = $1",
        [database],
      );
      const oid = oidResult.rows[0]?.oid;
      if (!oid) throw new Error("created_database_oid_unavailable");
      databaseOids.add(oid);
      const client = new Client({ connectionString: withDatabase(adminUrl, database) });
      await client.connect();
      openClients.add(client);
      await client.query(schemaSql);
      await client.query(kernelSql);
    }

    const [source, target] = [...openClients];
    if (!source || !target) throw new Error("scratch_clients_unavailable");
    const sourceOid = await databaseOid(source);
    const targetOid = await databaseOid(target);
    expect(sourceOid).not.toBe(targetOid);
    await configureReviewedMetadata(source);
    await seedSourceRows(source);

    const backupGroupRoleName = `pintpath_logical_backup_d${sourceOid}`;
    const loginVersion = `${Date.now()}${String(process.pid % 100_000).padStart(5, "0")}`;
    const ephemeralLoginRoleName = `${backupGroupRoleName}_v${loginVersion}`;
    if (Buffer.byteLength(ephemeralLoginRoleName, "utf8") > 63) {
      throw new Error("ephemeral_login_role_name_too_long");
    }
    ephemeralLoginRoleNames.add(ephemeralLoginRoleName);
    const ephemeralLoginPassword = crypto.randomBytes(32).toString("base64url");
    const expiry = await activeMaintenance.query<{ expiresAt: string }>(
      `SELECT (pg_catalog.clock_timestamp() + interval '600 seconds')::pg_catalog.text
        AS "expiresAt"`,
    );
    const expiresAt = new Date(expiry.rows[0]?.expiresAt ?? "").toISOString();
    await activeMaintenance.query("BEGIN");
    try {
      await activeMaintenance.query("SET LOCAL password_encryption = 'scram-sha-256'");
      await activeMaintenance.query(`CREATE ROLE ${quoteIdentifier(ephemeralLoginRoleName)}
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
        CONNECTION LIMIT 2 PASSWORD ${quoteLiteral(ephemeralLoginPassword)}
        VALID UNTIL ${quoteLiteral(expiresAt)}`);
      await activeMaintenance.query("COMMIT");
    } catch (error) {
      await activeMaintenance.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    await activeMaintenance.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(sourceDatabase)}
      TO ${quoteIdentifier(ephemeralLoginRoleName)}`);
    await activeMaintenance.query(`GRANT ${quoteIdentifier(backupGroupRoleName)}
      TO ${quoteIdentifier(ephemeralLoginRoleName)}
      WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
    const loginCatalog = await activeMaintenance.query<{
      oid: string;
      login: boolean;
      inherit: boolean;
      connectionLimit: number;
      scramSha256Verifier: boolean;
      validUntilFuture: boolean;
    }>(`SELECT role.oid::pg_catalog.text AS oid,
      role.rolcanlogin AS login,
      role.rolinherit AS inherit,
      role.rolconnlimit AS "connectionLimit",
      authentication.rolpassword LIKE 'SCRAM-SHA-256$4096:%' AS "scramSha256Verifier",
      role.rolvaliduntil > pg_catalog.clock_timestamp() AS "validUntilFuture"
      FROM pg_catalog.pg_roles AS role
      JOIN pg_catalog.pg_authid AS authentication ON authentication.oid = role.oid
      WHERE role.rolname = $1`, [ephemeralLoginRoleName]);
    expect(loginCatalog.rows[0]).toMatchObject({
      login: true,
      inherit: false,
      connectionLimit: 2,
      scramSha256Verifier: true,
      validUntilFuture: true,
    });
    const ephemeralLoginRoleOid = loginCatalog.rows[0]?.oid;
    if (!ephemeralLoginRoleOid || !/^[1-9][0-9]{0,9}$/.test(ephemeralLoginRoleOid)) {
      throw new Error("ephemeral_login_role_oid_unavailable");
    }
    expect(await observeExactSetOnlyMembership(
      activeMaintenance,
      backupGroupRoleName,
      ephemeralLoginRoleName,
    )).toEqual({ total: 1, exact: 1 });

    const sourceLoginUrl = new URL(withDatabase(adminUrl, sourceDatabase));
    sourceLoginUrl.username = ephemeralLoginRoleName;
    sourceLoginUrl.password = ephemeralLoginPassword;
    let sourceExporter: Client | null = new Client({
      connectionString: sourceLoginUrl.toString(),
      application_name: "pintpath-v4-scratch-source-exporter",
    });
    sourceExporter.on("error", () => undefined);
    await sourceExporter.connect();
    openClients.add(sourceExporter);
    await sourceExporter.query(`SET ROLE ${quoteIdentifier(backupGroupRoleName)}`);
    await sourceExporter.query("SET SESSION search_path = pg_catalog, pg_temp");
    await activeMaintenance.query(`REVOKE ${quoteIdentifier(backupGroupRoleName)}
      FROM ${quoteIdentifier(ephemeralLoginRoleName)}`);
    expect(await observeExactSetOnlyMembership(
      activeMaintenance,
      backupGroupRoleName,
      ephemeralLoginRoleName,
    )).toEqual({ total: 0, exact: 0 });

    const sourceMutator = new Client({ connectionString: withDatabase(adminUrl, sourceDatabase) });
    await sourceMutator.connect();
    openClients.add(sourceMutator);
    let sourceCapture: PostgresLogicalStateCaptureV2;
    let exportedSnapshot = "";
    await sourceExporter.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      sourceCapture = await capturePostgresLogicalStateV2(
        asV2Connection(sourceExporter),
        { pageRows: 1 },
      );
      const snapshot = await sourceExporter.query<{ snapshot: string }>(
        "SELECT pg_catalog.pg_export_snapshot() AS snapshot",
      );
      exportedSnapshot = snapshot.rows[0]?.snapshot ?? "";
      expect(exportedSnapshot).toMatch(/^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/);

      await sourceMutator.query(`INSERT INTO pintpath_app.system_state
        (key, value_json, updated_at, revision) VALUES
        ('after_export_probe', '{"excluded":true}'::pg_catalog.jsonb,
         '2026-08-12T01:00:02Z', 'after-export')`);
      const currentRows = await sourceMutator.query<{ count: string }>(
        "SELECT pg_catalog.count(*)::pg_catalog.text AS count FROM ONLY pintpath_app.system_state",
      );
      expect(currentRows.rows[0]?.count).toBe("2");

      await activeMaintenance.query(`GRANT ${quoteIdentifier(backupGroupRoleName)}
        TO ${quoteIdentifier(ephemeralLoginRoleName)}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      expect(await observeExactSetOnlyMembership(
        activeMaintenance,
        backupGroupRoleName,
        ephemeralLoginRoleName,
      )).toEqual({ total: 1, exact: 1 });

      const root = fs.realpathSync(fs.mkdtempSync(path.join(
        fs.realpathSync(os.tmpdir()),
        "pintpath-scratch-v4-",
      )));
      fs.chmodSync(root, 0o700);
      temporaryRoots.add(root);
      const archivePath = path.join(root, "source-data.dump");
      const archiveOutput = fs.openSync(
        archivePath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      try {
        const dump = spawnSync(pgDump, [
          ...POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS,
          `--snapshot=${exportedSnapshot}`,
          `--role=${backupGroupRoleName}`,
        ], {
          encoding: "utf8",
          env: toolEnvironment(sourceLoginUrl, sourceDatabase),
          killSignal: "SIGKILL",
          timeout: PROCESS_TIMEOUT_MS,
          stdio: ["ignore", archiveOutput, "pipe"],
        });
        assertSpawnSuccess(dump, "pg_dump_v4_scratch");
        fs.fsyncSync(archiveOutput);
      } finally {
        fs.closeSync(archiveOutput);
      }

      const archiveBefore = fs.statSync(archivePath);
      expect(archiveBefore.isFile()).toBe(true);
      expect(archiveBefore.mode & 0o777).toBe(0o600);
      expect(archiveBefore.nlink).toBe(1);
      expect(archiveBefore.size).toBeGreaterThan(0);
      expect(sha256Bytes(fs.readFileSync(archivePath))).toMatch(/^[a-f0-9]{64}$/);

      const listingInput = fs.openSync(archivePath, "r");
      let listing: SpawnSyncReturns<Buffer>;
      try {
        listing = spawnSync(pgRestore, ["--list"], {
          encoding: null,
          env: { LC_ALL: "C", TZ: "UTC" },
          killSignal: "SIGKILL",
          timeout: PROCESS_TIMEOUT_MS,
          stdio: [listingInput, "pipe", "pipe"],
        });
      } finally {
        fs.closeSync(listingInput);
      }
      assertSpawnSuccess(listing, "pg_restore_v4_list");
      expect(Buffer.isBuffer(listing.stdout)).toBe(true);
      const parsedListing = parsePostgresLogicalBackupV4TocListing(listing.stdout);
      expect(parsedListing.databaseName).toBe(sourceDatabase);
      expect(parsedListing.dumpedFromDatabaseVersion).toMatch(/^17\./);
      expect(parsedListing.dumpedByPgDumpVersion).toBe(pgDumpVersion);
      expect(pgRestoreVersion).toMatch(/^17\./);
      expect(parsedListing.unauthenticatedListingProjectionOnly.observedTableDataShape)
        .toMatchObject({
          observedTocEntries: 63,
          observedListedEntries: 59,
          observedTableDataEntries: 59,
        });

      await sourceExporter.query("ROLLBACK");
      await sourceExporter.query("RESET ROLE");
      await activeMaintenance.query(`ALTER ROLE ${quoteIdentifier(ephemeralLoginRoleName)} NOLOGIN`);
      await activeMaintenance.query(`REVOKE ${quoteIdentifier(backupGroupRoleName)}
        FROM ${quoteIdentifier(ephemeralLoginRoleName)}`);
      await activeMaintenance.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(sourceDatabase)}
        FROM ${quoteIdentifier(ephemeralLoginRoleName)}`);
      expect(await observeExactSetOnlyMembership(
        activeMaintenance,
        backupGroupRoleName,
        ephemeralLoginRoleName,
      )).toEqual({ total: 0, exact: 0 });
      const terminated = await activeMaintenance.query<{ terminated: boolean }>(`SELECT
        pg_catalog.pg_terminate_backend(activity.pid, 5000) AS terminated
        FROM pg_catalog.pg_stat_activity AS activity
        WHERE activity.usesysid = $1::pg_catalog.oid
          AND activity.pid <> pg_catalog.pg_backend_pid()
        ORDER BY activity.pid`, [ephemeralLoginRoleOid]);
      expect(terminated.rows).toHaveLength(1);
      expect(terminated.rows[0]?.terminated).toBe(true);
      await waitForZeroActiveRoleSessions(activeMaintenance, ephemeralLoginRoleOid);
      openClients.delete(sourceExporter);
      await sourceExporter.end().catch(() => undefined);
      sourceExporter = null;
      await activeMaintenance.query(`DROP ROLE ${quoteIdentifier(ephemeralLoginRoleName)}`);
      const loginGone = await activeMaintenance.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS exists",
        [ephemeralLoginRoleName],
      );
      expect(loginGone.rows[0]?.exists).toBe(false);

      await target.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE");
      let preLoadBoundary: BoundaryEvidence;
      try {
        await target.query(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.trustedSearchPathSql);
        await target.query(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.relationLockSql);
        await target.query(
          "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ WRITE, NOT DEFERRABLE",
        );
        await target.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ WRITE, NOT DEFERRABLE",
        );
        const searchPath = await target.query<{ firstSchema: string }>(
          POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.trustedSearchPathPreflightSql,
        );
        expect(searchPath.rows[0]?.firstSchema).toBe("pg_catalog");
        preLoadBoundary = await readBoundaryEvidence(target);
        expect(preLoadBoundary.databaseOid).toBe(targetOid);
        expect(preLoadBoundary.portableReadBoundarySha256).toBe(
          POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_CONTRACT.staticAuthority
            .portableReadBoundarySha256,
        );
        const targetIdentity = await target.query<{ name: string; oid: string; superuser: boolean }>(`SELECT
          pg_catalog.current_database() AS name, database.oid::pg_catalog.text AS oid,
          role.rolsuper AS superuser
          FROM pg_catalog.pg_database AS database
          JOIN pg_catalog.pg_roles AS role ON role.rolname = CURRENT_USER
          WHERE database.datname = pg_catalog.current_database()`);
        expect(targetIdentity.rows[0]).toEqual({
          name: targetDatabase,
          oid: targetOid,
          superuser: true,
        });
        const catalog = await readCatalogCounts(target);
        const seedRowsBefore = await target.query<Record<string, unknown>>(
          POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.seedRowsSql,
        );
        const seedRowsDeleted = await target.query<Record<string, unknown>>(
          POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.seedDeleteSql,
        );
        const relationRows = await readRelationRows(target);
        const preLoadProjection = validatePostgresLogicalScratchRestoreV4PreLoadObservation({
          targetDatabaseOid: targetOid,
          targetPhysicalReadBoundarySha256: preLoadBoundary.physicalReadBoundarySha256,
          portableReadBoundarySha256: preLoadBoundary.portableReadBoundarySha256,
          currentUserSuperuser: true,
          disposableTargetIdentityVerified: true,
          catalog,
          seedRowsBeforeRemoval: normalizeSeedRows(seedRowsBefore.rows),
          seedRowsDeleted: normalizeSeedRows(seedRowsDeleted.rows),
          relationRowsAfterSeedRemoval: relationRows,
        });
        expect(preLoadProjection).toMatchObject({
          emptyRelationCount: 61,
          totalRowsAfterSeedRemoval: "0",
          operationallyAccepted: false,
        });
        await target.query("COMMIT");
      } catch (error) {
        await target.query("ROLLBACK").catch(() => undefined);
        throw error;
      }

      const restoreInput = fs.openSync(archivePath, "r");
      try {
        const restore = spawnSync(pgRestore, [
          ...POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_SCRATCH_RESTORE_OPTIONS,
          `--dbname=${targetDatabase}`,
        ], {
          encoding: "utf8",
          env: toolEnvironment(adminUrl, targetDatabase),
          killSignal: "SIGKILL",
          timeout: PROCESS_TIMEOUT_MS,
          stdio: [restoreInput, "pipe", "pipe"],
        });
        assertSpawnSuccess(restore, "pg_restore_v4_scratch");
        expect(restore.stdout).toBe("");
      } finally {
        fs.closeSync(restoreInput);
      }
      const archiveAfter = fs.statSync(archivePath);
      expect({
        dev: archiveAfter.dev,
        ino: archiveAfter.ino,
        uid: archiveAfter.uid,
        mode: archiveAfter.mode,
        nlink: archiveAfter.nlink,
        size: archiveAfter.size,
      }).toEqual({
        dev: archiveBefore.dev,
        ino: archiveBefore.ino,
        uid: archiveBefore.uid,
        mode: archiveBefore.mode,
        nlink: archiveBefore.nlink,
        size: archiveBefore.size,
      });

      const targetBeforeTriggerProof = await captureReadOnlyV2(target);
      expect(exactPostgresLogicalStateMatchV2(
        sourceCapture.inventory,
        targetBeforeTriggerProof.inventory,
      )).toBe(true);
      expect(targetBeforeTriggerProof.sourceDatabaseOid).toBe(targetOid);
      expect(targetBeforeTriggerProof.sourcePhysicalReadBoundarySha256)
        .toBe(preLoadBoundary.physicalReadBoundarySha256);
      expect(targetBeforeTriggerProof.sourcePhysicalReadBoundarySha256)
        .not.toBe(sourceCapture.sourcePhysicalReadBoundarySha256);
      const shapeComparison = projectPostgresLogicalScratchRestoreV4V2ShapeComparison(
        sourceCapture,
        targetBeforeTriggerProof,
      );
      expect(shapeComparison).toMatchObject({
        exactInventoryMatch: true,
        independentFullV2ValidationPerformed: false,
        operationallyAccepted: false,
      });

      const applicationTriggerProof = await proveApplicationTrigger(target);
      expect(applicationTriggerProof).toMatchObject({
        exactDisabledParentRiTriggerCount: 2,
        applicationTriggerEnabled: true,
        fixtureAccountRowsInserted: 2,
        fixtureChildRowsInserted: 2,
        reviewerAccountRowsDeleted: 1,
        survivingChildRows: 2,
        nullReferenceRows: 2,
        transactionRolledBack: true,
        fixtureResidueRows: 0,
        postRollbackEnabledPrivateTriggerCount: 317,
      });
      const finalTargetCapture = await captureReadOnlyV2(target);
      expect(finalTargetCapture).toEqual(targetBeforeTriggerProof);

      await target.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      let catalog: PostgresLogicalScratchRestoreV4CatalogCounts;
      let relationRows: PostgresLogicalScratchRestoreV4RelationRowCount[];
      const violationRows: Array<{ constraintName: string; violationRowCount: string }> = [];
      try {
        await target.query("SET LOCAL search_path = pg_catalog, pg_temp");
        await target.query(accessShareLockSql());
        await target.query(
          "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY, NOT DEFERRABLE",
        );
        await target.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY, NOT DEFERRABLE",
        );
        catalog = await readCatalogCounts(target);
        relationRows = await readRelationRows(target);
        const foreignKeyCatalog = await target.query<{
          constraintName: string;
          validated: boolean;
          deferrable: boolean;
          initiallyDeferred: boolean;
          keyColumnCount: number;
        }>(POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_SQL.foreignKeyCatalogSql);
        expect(foreignKeyCatalog.rows).toHaveLength(79);
        const byName = new Map(foreignKeyCatalog.rows.map((row) => [row.constraintName, row]));
        for (const descriptor of POSTGRES_LOGICAL_SCRATCH_RESTORE_V4_FOREIGN_KEYS) {
          expect(byName.get(descriptor.constraintName)).toEqual({
            constraintName: descriptor.constraintName,
            validated: true,
            deferrable: false,
            initiallyDeferred: false,
            keyColumnCount: 1,
          });
          const violations = await target.query<{ violationRowCount: string }>(
            descriptor.antiJoinSql,
          );
          violationRows.push({
            constraintName: descriptor.constraintName,
            violationRowCount: violations.rows[0]?.violationRowCount ?? "invalid",
          });
        }
        await target.query("COMMIT");
      } catch (error) {
        await target.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      expect(violationRows).toHaveLength(79);
      expect(violationRows.every((row) => row.violationRowCount === "0")).toBe(true);
      const archiveRowCount = (
        BigInt(sourceCapture.inventory.authoritativeRowCount)
        + sourceCapture.inventory.controlTables.slice(0, 3)
          .reduce((sum, receipt) => sum + BigInt(receipt.rowCount), 0n)
      ).toString();
      const postLoadProjection = validatePostgresLogicalScratchRestoreV4PostLoadObservation({
        targetDatabaseOid: targetOid,
        preLoadPhysicalReadBoundarySha256: preLoadBoundary.physicalReadBoundarySha256,
        postLoadPhysicalReadBoundarySha256: finalTargetCapture.sourcePhysicalReadBoundarySha256,
        portableReadBoundarySha256: finalTargetCapture.inventory.sourceReadBoundarySha256,
        catalog,
        relationRows,
        expectedArchiveRowCount: archiveRowCount,
        foreignKeyViolationRows: violationRows,
        applicationTriggerProof,
      }, sourceCapture);
      expect(postLoadProjection).toMatchObject({
        archiveRowCount,
        kernelRowCount: "0",
        foreignKeyViolationRowCount: "0",
        physicalReadBoundaryIndependentlyVerified: false,
        completePhysicalSchemaCatalogDigestVerified: false,
        sourceCaptureIndependentFullV2ValidationPerformed: false,
        operationallyAccepted: false,
      });
    } finally {
      if (sourceExporter) {
        await sourceExporter.query("ROLLBACK").catch(() => undefined);
        await sourceExporter.query("RESET ROLE").catch(() => undefined);
        openClients.delete(sourceExporter);
        await sourceExporter.end().catch(() => undefined);
      }
    }

    const cleanupObservation = await cleanup();
    expect(cleanupObservation).toEqual({
      residualDatabaseCount: 0,
      residualScopedRoleCount: 0,
      residualSessionCount: 0,
      residualArtifactCount: 0,
    });
    const disposal = validatePostgresLogicalScratchRestoreV4DisposalObservation({
      allConnectionsClosed: true,
      archiveDescriptorsClosed: true,
      toolProcessReaped: true,
      disposableDatabaseDropped: true,
      fiveTargetOidScopedRolesDropped: true,
      temporaryArtifactsDisposed: true,
      ...cleanupObservation,
    });
    expect(disposal.permitsSuccessReceipt).toBe(false);
  }, 180_000);
});
