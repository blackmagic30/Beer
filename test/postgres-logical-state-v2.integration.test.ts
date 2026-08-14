import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { POSTGRES_MIGRATION_EXPECTED_LIVE_SCHEMA_SHA256 } from "../src/db/postgres-migration-live-schema.js";
import {
  POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE,
  POSTGRES_MIGRATION_VERIFIER_AUTHORITY_TABLE,
  sha256PostgresMigrationVerifierAuthorityBinding,
} from "../src/db/postgres-migration-verifier-authority.js";
import { sha256PostgresMigrationContract } from "../src/db/postgres-migration-schema.js";
import {
  capturePostgresLogicalStateV2,
  computePostgresLogicalStateInventory,
  PostgresLogicalStateError,
  type PostgresLogicalStateCaptureV2,
  type PostgresLogicalStateV2Connection,
} from "../src/lib/postgres-logical-state.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_LOGICAL_STATE_V2_TEST_ADMIN_URL";
const REQUIRED_ENV = "PINTPATH_POSTGRES_LOGICAL_STATE_V2_TEST_REQUIRED";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const configuredRequired = process.env[REQUIRED_ENV]?.trim() ?? "";
const suffix = `${process.pid}_${crypto.randomBytes(5).toString("hex")}`;
const firstDatabase = `pintpath_state_v2_first_${suffix}`;
const secondDatabase = `pintpath_state_v2_second_${suffix}`;
const secondDatabaseOwner = `pintpath_state_v2_owner_${suffix}`;
const schemaPublication = `pintpath_state_v2_schema_${suffix}`;
const hostileSchema = `pintpath_state_v2_evil_${suffix}`;
const inheritedTable = `pintpath_state_v2_inherited_${suffix}`;
const schemaSql = fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8");
const kernelSql = fs.readFileSync(
  path.resolve(
    "supabase/migrations/20260812022314_add_inert_reviewed_price_promotion_kernel.sql",
  ),
  "utf8",
);

if (configuredRequired !== "" && configuredRequired !== "true") {
  throw new Error(`${REQUIRED_ENV} must be true when set.`);
}
if (configuredRequired === "true" && !configuredAdminUrl) {
  throw new Error(`${ADMIN_URL_ENV} is mandatory when ${REQUIRED_ENV}=true.`);
}

function validateAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${ADMIN_URL_ENV} must be a disposable loopback PostgreSQL URL.`);
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
    || /[\r\n\0]/.test(value)
  ) {
    throw new Error(`${ADMIN_URL_ENV} must target a disposable loopback PG17 database.`);
  }
  return url;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe_test_identifier");
  return `"${value}"`;
}

function withDatabase(url: URL, database: string): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  return result.toString();
}

function scopedRoleNames(databaseOid: string): readonly string[] {
  if (!/^[1-9][0-9]{0,9}$/.test(databaseOid)) throw new Error("unsafe_test_database_oid");
  return [
    `pintpath_reviewed_price_apply_execute_d${databaseOid}`,
    `pintpath_reviewed_price_quarantine_execute_d${databaseOid}`,
    `pintpath_reviewed_price_apply_owner_d${databaseOid}`,
    `pintpath_reviewed_price_quarantine_owner_d${databaseOid}`,
    `pintpath_logical_backup_d${databaseOid}`,
  ];
}

async function databaseOid(client: Client): Promise<string> {
  const result = await client.query<{ oid: string }>(`SELECT database.oid::text AS oid
    FROM pg_catalog.pg_database AS database
    WHERE database.datname = pg_catalog.current_database()`);
  const oid = result.rows[0]?.oid;
  if (result.rows.length !== 1 || !oid || !/^[1-9][0-9]{0,9}$/.test(oid)) {
    throw new Error("test_database_oid_unavailable");
  }
  return oid;
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
    source_schema_sha256: "e".repeat(64),
    source_schema_version: String(POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion),
    source_snapshot_sha256: "f".repeat(64),
    target_ddl_sha256: "1".repeat(64),
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

async function seedMigrationVerifierAuthority(client: Client): Promise<void> {
  const binding = {
    expectedEnvironment: "permanent-staging",
    candidateSha: "a".repeat(40),
    operatorIdSha256: "1".repeat(64),
    verifierIdSha256: "2".repeat(64),
    verifierPublicKeySha256: "3".repeat(64),
    authorityPolicySha256: "4".repeat(64),
  } as const;
  const result = await client.query(`INSERT INTO
    pintpath_ops.${POSTGRES_MIGRATION_VERIFIER_AUTHORITY_TABLE} (
      authority_id, expected_environment, candidate_commit_sha, operator_id_sha256,
      verifier_id_sha256, verifier_public_key_sha256, authority_policy_sha256,
      authority_sha256, installed_at
    ) VALUES (
      'active', 'permanent-staging', $1, $2, $3, $4, $5, $6,
      '2026-08-12T00:30:00.000Z'::pg_catalog.timestamptz
    )`, [
    binding.candidateSha,
    binding.operatorIdSha256,
    binding.verifierIdSha256,
    binding.verifierPublicKeySha256,
    binding.authorityPolicySha256,
    sha256PostgresMigrationVerifierAuthorityBinding(binding),
  ]);
  if (result.rowCount !== 1) throw new Error("verifier_authority_insert_failed");
}

async function seedReviewedPriceControls(client: Client): Promise<void> {
  const applyOperation = "00000000-0000-4000-8000-0000000000ff";
  const quarantineOperation = "00000000-0000-4000-8000-000000000100";
  const operations = [
    {
      operationId: applyOperation,
      operationKind: "apply",
      sourceApplyOperationId: null,
      candidateSha: "a".repeat(40),
      requestedRowCount: 2,
      hashes: ["1", "2", "3", "4", "5", "6", "7", "8"],
      committedAt: "2026-08-12T01:00:00.000Z",
    },
    {
      operationId: quarantineOperation,
      operationKind: "quarantine",
      sourceApplyOperationId: applyOperation,
      candidateSha: "b".repeat(40),
      requestedRowCount: 1,
      hashes: ["9", "a", "b", "c", "d", "e", "f", "0"],
      committedAt: "2026-08-12T01:00:01.000Z",
    },
  ] as const;
  for (const operation of operations) {
    const hashes = operation.hashes.map((token) => token.repeat(64));
    const result = await client.query(
      `INSERT INTO pintpath_ops.reviewed_price_promotion_operations (
        operation_id, operation_kind, source_apply_operation_id, candidate_sha,
        expected_environment, authority_bundle_sha256, plan_candidate_sha256,
        review_packet_candidate_sha256, target_physical_identity_sha256,
        source_snapshot_sha256, request_sha256, requested_row_count, committed_at,
        result_state_sha256, receipt_sha256
      ) VALUES (
        $1, $2, $3, $4, 'permanent-staging', $5, $6, $7, $8, $9, $10, $11,
        $12::pg_catalog.timestamptz, $13, $14
      )`,
      [
        operation.operationId,
        operation.operationKind,
        operation.sourceApplyOperationId,
        operation.candidateSha,
        ...hashes.slice(0, 6),
        operation.requestedRowCount,
        operation.committedAt,
        ...hashes.slice(6),
      ],
    );
    if (result.rowCount !== 1) throw new Error("reviewed_operation_insert_failed");
  }

  const rows = [
    {
      operationId: applyOperation,
      rowOrdinal: 1,
      sourceIngestionId: "00000000-0000-4000-8000-0000000000b0",
      venueId: "00000000-0000-4000-8000-0000000000c0",
      priceRecordId: "price-b",
      venueBeerId: "venue-beer-b",
      hashTokens: ["5", "6", "7", "8"],
    },
    {
      operationId: applyOperation,
      rowOrdinal: 0,
      sourceIngestionId: "00000000-0000-4000-8000-0000000000a0",
      venueId: "00000000-0000-4000-8000-0000000000d0",
      priceRecordId: "price-a",
      venueBeerId: "venue-beer-a",
      hashTokens: ["1", "2", "3", "4"],
    },
    {
      operationId: quarantineOperation,
      rowOrdinal: 0,
      sourceIngestionId: "00000000-0000-4000-8000-0000000000e0",
      venueId: "00000000-0000-4000-8000-0000000000f0",
      priceRecordId: "price-c",
      venueBeerId: "venue-beer-c",
      hashTokens: ["9", "a", "b", "c"],
    },
  ] as const;
  for (const row of rows) {
    const result = await client.query(
      `INSERT INTO pintpath_ops.reviewed_price_promotion_rows (
        operation_id, row_ordinal, source_ingestion_id, venue_id, price_record_id,
        venue_beer_id, normalized_beer_id, row_request_sha256, before_state_sha256,
        after_state_sha256, row_receipt_sha256
      ) VALUES ($1, $2, $3, $4, $5, $6, 'beer', $7, $8, $9, $10)`,
      [
        row.operationId,
        row.rowOrdinal,
        row.sourceIngestionId,
        row.venueId,
        row.priceRecordId,
        row.venueBeerId,
        ...row.hashTokens.map((token) => token.repeat(64)),
      ],
    );
    if (result.rowCount !== 1) throw new Error("reviewed_row_insert_failed");
  }
}

interface AuditRow extends QueryResultRow {
  readonly currentUser: string;
  readonly sessionUser: string;
  readonly kernelRowCount: string;
  readonly membershipCount: string;
  readonly publicationCount: string;
  readonly scopedRoleState: string;
}

async function auditState(
  client: Client,
  roles: readonly string[],
  publications: readonly string[],
): Promise<AuditRow> {
  const result = await client.query<AuditRow>(`WITH scoped_roles AS (
      SELECT role.oid, role.rolname, role.rolcanlogin, role.rolsuper,
             role.rolcreatedb, role.rolcreaterole, role.rolinherit,
             role.rolreplication, role.rolbypassrls
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = ANY($1::text[])
    )
    SELECT
      current_user AS "currentUser",
      session_user AS "sessionUser",
      ((SELECT count(*) FROM pintpath_ops.reviewed_price_promotion_operations)
        + (SELECT count(*) FROM pintpath_ops.reviewed_price_promotion_rows))::text
        AS "kernelRowCount",
      (SELECT count(*)::text FROM pg_catalog.pg_auth_members AS membership
       WHERE membership.roleid IN (SELECT oid FROM scoped_roles)
          OR membership.member IN (SELECT oid FROM scoped_roles)) AS "membershipCount",
      (SELECT count(*)::text FROM pg_catalog.pg_publication AS publication
       WHERE publication.pubname = ANY($2::text[])) AS "publicationCount",
      (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          role.rolname, role.rolcanlogin, role.rolsuper, role.rolcreatedb,
          role.rolcreaterole, role.rolinherit, role.rolreplication, role.rolbypassrls
        ) ORDER BY role.rolname COLLATE "C")::text FROM scoped_roles AS role)
        AS "scopedRoleState"`, [roles, publications]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row) throw new Error("catalog_audit_unavailable");
  return row;
}

async function expectContractInvalid(work: () => Promise<unknown>): Promise<void> {
  let captured: unknown;
  try {
    await work();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(PostgresLogicalStateError);
  expect(captured).toMatchObject({ code: "contract_invalid" });
}

function asV2Connection(client: Client): PostgresLogicalStateV2Connection {
  const processID = (client as Client & { readonly processID?: unknown }).processID;
  if (!Number.isSafeInteger(processID) || Number(processID) < 1) {
    throw new Error("test_backend_pid_unavailable");
  }
  return client as Client & PostgresLogicalStateV2Connection;
}

function observedV2Connection(
  client: Client,
  queries: string[],
): PostgresLogicalStateV2Connection {
  const connection = asV2Connection(client);
  return {
    processID: connection.processID,
    query: async <Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ) => {
      queries.push(text);
      const result = await client.query<Row>(text, [...values]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

async function captureReadOnly(
  client: Client,
  work: (connection: PostgresLogicalStateV2Connection) => Promise<unknown>,
): Promise<unknown> {
  const oid = await databaseOid(client);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query(`SET LOCAL ROLE ${quoteIdentifier(`pintpath_logical_backup_d${oid}`)}`);
    await client.query("SET LOCAL search_path = pg_catalog, pg_temp");
    const result = await work(asV2Connection(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function expectRejectedCatalogDrift(
  client: Client,
  roles: readonly string[],
  publications: readonly string[],
  mutate: () => Promise<unknown>,
  restore: () => Promise<unknown>,
): Promise<void> {
  const before = await auditState(client, roles, publications);
  try {
    await mutate();
    const queries: string[] = [];
    await expectContractInvalid(() => captureReadOnly(
      client,
      () => capturePostgresLogicalStateV2(
        observedV2Connection(client, queries), { pageRows: 1 },
      ),
    ));
    expect(queries[0]).toContain("logical-state:v2:relation-lock");
    expect(queries[1]).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(queries[2]).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    expect(queries.some((text) => text.includes("logical-state:v2:source-read-boundary"))).toBe(true);
  } finally {
    await restore();
  }
  expect(await auditState(client, roles, publications)).toEqual(before);
}

describe.skipIf(!configuredAdminUrl)(
  "logical-state V2 data/read attestation on real PostgreSQL 17",
  () => {
    let adminUrl: URL;
    let maintenance: Client;
    let runtimeRoleExisted = false;
    let migratorRoleExisted = false;
    let verifierAuthorityRoleExisted = false;
    const databaseOids = new Map<string, string>();
    const openClients = new Set<Client>();

    async function createSuccessorDatabase(
      database: string,
      owner?: string,
    ): Promise<Client> {
      await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`);
      await maintenance.query(`CREATE DATABASE ${quoteIdentifier(database)}${
        owner ? ` OWNER ${quoteIdentifier(owner)}` : ""
      }`);
      const client = new Client({ connectionString: withDatabase(adminUrl, database) });
      await client.connect();
      openClients.add(client);
      if (owner) {
        await client.query(`SET ROLE ${quoteIdentifier(owner)}`);
        try {
          await client.query(schemaSql);
          await client.query(kernelSql);
        } finally {
          await client.query("RESET ROLE");
        }
        await client.query(kernelSql);
      } else {
        await client.query(schemaSql);
        await client.query(kernelSql);
      }
      databaseOids.set(database, await databaseOid(client));
      await configureReviewedMetadata(client);
      return client;
    }

    async function closeClient(client: Client): Promise<void> {
      openClients.delete(client);
      await client.end();
    }

    beforeAll(async () => {
      adminUrl = validateAdminUrl(configuredAdminUrl);
      maintenance = new Client({ connectionString: adminUrl.toString() });
      await maintenance.connect();
      const version = await maintenance.query<{ version: string; superuser: boolean }>(`SELECT
        pg_catalog.current_setting('server_version_num') AS version,
        role.rolsuper AS superuser
        FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = current_user`);
      if (!/^17\d{4}$/.test(version.rows[0]?.version ?? "")) {
        throw new Error("Logical-state v2 integration requires PostgreSQL 17.");
      }
      if (version.rows[0]?.superuser !== true) {
        throw new Error("Logical-state v2 integration requires a disposable superuser.");
      }
      const roles = await maintenance.query<{ rolname: string }>(
        "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
        [[
          "pintpath_runtime",
          "pintpath_migrator",
          POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE,
        ]],
      );
      runtimeRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_runtime");
      migratorRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_migrator");
      verifierAuthorityRoleExisted = roles.rows.some(
        (row) => row.rolname === POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE,
      );
      for (const database of [firstDatabase, secondDatabase]) {
        await maintenance.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`,
        );
      }
      await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(secondDatabaseOwner)}`);
    }, 30_000);

    afterAll(async () => {
      const failures: unknown[] = [];
      for (const client of openClients) {
        await client.end().catch((error) => failures.push(error));
      }
      openClients.clear();
      for (const database of [firstDatabase, secondDatabase]) {
        try {
          await maintenance.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`,
          );
        } catch (error) {
          failures.push(error);
        }
      }
      for (const oid of databaseOids.values()) {
        for (const role of scopedRoleNames(oid)) {
          try {
            await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      try {
        await maintenance.query(`DROP ROLE IF EXISTS ${quoteIdentifier(secondDatabaseOwner)}`);
        if (!runtimeRoleExisted) await maintenance.query("DROP ROLE IF EXISTS pintpath_runtime");
        if (!migratorRoleExisted) await maintenance.query("DROP ROLE IF EXISTS pintpath_migrator");
        if (!verifierAuthorityRoleExisted) {
          await maintenance.query(
            `DROP ROLE IF EXISTS ${POSTGRES_MIGRATION_VERIFIER_AUTHORITY_ROLE}`,
          );
        }
      } catch (error) {
        failures.push(error);
      }
      await maintenance.end().catch((error) => failures.push(error));
      if (failures.length > 0) throw failures[0];
    }, 30_000);

    it("binds portable and physical catalogs while rejecting catalog drift without mutation", async () => {
      const first = await createSuccessorDatabase(firstDatabase);
      await seedMigrationVerifierAuthority(first);
      await maintenance.query(
        `CREATE ROLE ${quoteIdentifier(secondDatabaseOwner)}
         NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      const second = await createSuccessorDatabase(secondDatabase, secondDatabaseOwner);
      try {
        const firstOid = databaseOids.get(firstDatabase);
        const secondOid = databaseOids.get(secondDatabase);
        expect(firstOid).toMatch(/^[1-9][0-9]{0,9}$/);
        expect(secondOid).toMatch(/^[1-9][0-9]{0,9}$/);
        expect(firstOid).not.toBe(secondOid);

        await expectContractInvalid(
          () => computePostgresLogicalStateInventory(first, { pageRows: 1 }),
        );
        await expectContractInvalid(
          () => computePostgresLogicalStateInventory(second, { pageRows: 1 }),
        );

        const emptyFirstQueries: string[] = [];
        const emptyFirst = await captureReadOnly(
          first, (connection) => capturePostgresLogicalStateV2(
            observedV2Connection(first, emptyFirstQueries), { pageRows: 1 },
          ),
        ) as PostgresLogicalStateCaptureV2;
        const emptySecond = await captureReadOnly(
          second, (connection) => capturePostgresLogicalStateV2(connection, { pageRows: 1 }),
        ) as PostgresLogicalStateCaptureV2;
        expect(emptyFirst.sourceDatabaseOid).toBe(firstOid);
        expect(emptySecond.sourceDatabaseOid).toBe(secondOid);
        expect(emptyFirst.inventory.sourceReadBoundarySha256)
          .toBe(emptySecond.inventory.sourceReadBoundarySha256);
        expect(emptyFirst.sourcePhysicalReadBoundarySha256)
          .not.toBe(emptySecond.sourcePhysicalReadBoundarySha256);
        expect(emptyFirst.inventory).toEqual(emptySecond.inventory);
        expect((await first.query<{ count: string }>(`SELECT pg_catalog.count(*)::text AS count
          FROM pintpath_ops.${POSTGRES_MIGRATION_VERIFIER_AUTHORITY_TABLE}`)).rows[0]?.count)
          .toBe("1");
        expect((await second.query<{ count: string }>(`SELECT pg_catalog.count(*)::text AS count
          FROM pintpath_ops.${POSTGRES_MIGRATION_VERIFIER_AUTHORITY_TABLE}`)).rows[0]?.count)
          .toBe("0");
        expect(emptyFirstQueries.some((text) => text.includes(
          `logical-state:page:pintpath_ops:${POSTGRES_MIGRATION_VERIFIER_AUTHORITY_TABLE}`,
        ))).toBe(false);
        expect(emptyFirst.inventory.controlTables.map((table) => table.tableName)).toEqual([
          "pintpath_app.schema_metadata",
          "pintpath_ops.migration_chunks",
          "pintpath_ops.migration_runs",
          "pintpath_ops.reviewed_price_promotion_operations",
          "pintpath_ops.reviewed_price_promotion_rows",
        ]);
        expect(emptyFirst.inventory.controlTables.map((table) => table.tableName))
          .not.toContain(`pintpath_ops.${POSTGRES_MIGRATION_VERIFIER_AUTHORITY_TABLE}`);

        const firstRoles = scopedRoleNames(firstOid!);
        const publications = [schemaPublication];
        const stableAudit = await auditState(first, firstRoles, publications);
        expect(stableAudit).toMatchObject({
          kernelRowCount: "0",
          membershipCount: "0",
          publicationCount: "0",
        });

        await first.query(`CREATE SCHEMA ${quoteIdentifier(hostileSchema)}`);
        try {
          await first.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          try {
            await first.query(
              `SET LOCAL search_path = ${quoteIdentifier(hostileSchema)}, pg_catalog`,
            );
            const hostileQueries: string[] = [];
            await expectContractInvalid(() => capturePostgresLogicalStateV2(
              observedV2Connection(first, hostileQueries), { pageRows: 1 },
            ));
            expect(hostileQueries).toHaveLength(4);
            expect(hostileQueries[0]).toContain("logical-state:v2:relation-lock");
            expect(hostileQueries[1]).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
            expect(hostileQueries[2]).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
            expect(hostileQueries[3]).toContain("logical-state:v2:session-preflight");
          } finally {
            await first.query("ROLLBACK").catch(() => undefined);
          }
        } finally {
          await first.query(`DROP SCHEMA ${quoteIdentifier(hostileSchema)}`);
        }

        await first.query("CREATE TEMP TABLE pintpath_state_v2_temp_probe (value integer)");
        await first.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          await first.query("SET LOCAL search_path = pg_catalog");
          const implicitTempQueries: string[] = [];
          await expectContractInvalid(() => capturePostgresLogicalStateV2(
            observedV2Connection(first, implicitTempQueries), { pageRows: 1 },
          ));
          expect(implicitTempQueries).toHaveLength(4);
        } finally {
          await first.query("ROLLBACK").catch(() => undefined);
        }
        const explicitCatalogCapture = await captureReadOnly(
          first, (connection) => capturePostgresLogicalStateV2(connection, { pageRows: 1 }),
        ) as PostgresLogicalStateCaptureV2;
        expect(explicitCatalogCapture).toEqual(emptyFirst);

        const concurrent = new Client({ connectionString: withDatabase(adminUrl, firstDatabase) });
        await concurrent.connect();
        openClients.add(concurrent);
        await first.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          await first.query(
            `SET LOCAL ROLE ${quoteIdentifier(`pintpath_logical_backup_d${firstOid}`)}`,
          );
          await first.query("SET LOCAL search_path = pg_catalog, pg_temp");
          await capturePostgresLogicalStateV2(asV2Connection(first), { pageRows: 1 });
          await concurrent.query("SET lock_timeout = '100ms'");
          let lockError: unknown;
          try {
            await concurrent.query(`ALTER POLICY accounts_runtime_all
              ON pintpath_app.accounts USING (false)`);
          } catch (error) {
            lockError = error;
          }
          expect(lockError).toMatchObject({ code: "55P03" });
        } finally {
          await first.query("ROLLBACK").catch(() => undefined);
          await closeClient(concurrent).catch(() => undefined);
        }

        await first.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          await first.query(
            `SET LOCAL ROLE ${quoteIdentifier(`pintpath_logical_backup_d${firstOid}`)}`,
          );
          await first.query("SET LOCAL search_path = pg_catalog, pg_temp");
          await first.query("SELECT 1 FROM pg_catalog.pg_class LIMIT 1");
          const staleSnapshotQueries: string[] = [];
          await expectContractInvalid(() => capturePostgresLogicalStateV2(
            observedV2Connection(first, staleSnapshotQueries), { pageRows: 1 },
          ));
          expect(staleSnapshotQueries).toHaveLength(2);
          expect(staleSnapshotQueries[0]).toContain("logical-state:v2:relation-lock");
          expect(staleSnapshotQueries[1]).toContain(
            "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
          );
        } finally {
          await first.query("ROLLBACK").catch(() => undefined);
        }

        await first.query("SET SESSION default_transaction_isolation = 'repeatable read'");
        await first.query("SET SESSION default_transaction_read_only = on");
        await first.query("SET SESSION search_path = pg_catalog, pg_temp");
        try {
          const autocommitQueries: string[] = [];
          await expectContractInvalid(() => capturePostgresLogicalStateV2(
            observedV2Connection(first, autocommitQueries), { pageRows: 1 },
          ));
          expect(autocommitQueries).toHaveLength(1);
          expect(autocommitQueries[0]).toContain("logical-state:v2:relation-lock");
        } finally {
          await first.query("SET SESSION default_transaction_read_only = off");
          await first.query("SET SESSION default_transaction_isolation = 'read committed'");
          await first.query("RESET search_path");
        }

        await seedReviewedPriceControls(first);
        expect((await auditState(first, firstRoles, publications)).kernelRowCount).toBe("5");
        const nonemptyQueries: string[] = [];
        await expectContractInvalid(() => captureReadOnly(
          first,
          () => capturePostgresLogicalStateV2(
            observedV2Connection(first, nonemptyQueries), { pageRows: 1 },
          ),
        ));
        expect(nonemptyQueries.some(
          (text) => text.includes(
            "logical-state:page:pintpath_ops:reviewed_price_promotion_operations",
          ),
        )).toBe(true);
        await first.query("TRUNCATE TABLE pintpath_ops.reviewed_price_promotion_rows");
        await first.query("TRUNCATE TABLE pintpath_ops.reviewed_price_promotion_operations CASCADE");
        expect(await auditState(first, firstRoles, publications)).toEqual(stableAudit);

        await expectRejectedCatalogDrift(first, firstRoles, publications, () => first.query(
          `CREATE PUBLICATION ${quoteIdentifier(schemaPublication)}
           FOR TABLES IN SCHEMA pintpath_ops`,
        ), () => first.query(`DROP PUBLICATION ${quoteIdentifier(schemaPublication)}`));
        await expectRejectedCatalogDrift(first, firstRoles, publications, () => first.query(
          `CREATE PUBLICATION ${quoteIdentifier(schemaPublication)}
           FOR TABLE pintpath_app.accounts`,
        ), () => first.query(`DROP PUBLICATION ${quoteIdentifier(schemaPublication)}`));
        await expectRejectedCatalogDrift(first, firstRoles, publications, () => first.query(
          "ALTER EXTENSION plpgsql ADD TABLE pintpath_app.accounts",
        ), () => first.query("ALTER EXTENSION plpgsql DROP TABLE pintpath_app.accounts"));
        await expectRejectedCatalogDrift(first, firstRoles, publications, () => first.query(
          `CREATE TABLE public.${quoteIdentifier(inheritedTable)} ()
           INHERITS (pintpath_app.accounts)`,
        ), () => first.query(`DROP TABLE public.${quoteIdentifier(inheritedTable)}`));
        await expectRejectedCatalogDrift(first, firstRoles, publications, async () => {
          const result = await first.query(`UPDATE pg_catalog.pg_index
            SET indisvalid = false, indisready = false
            WHERE indexrelid = 'pintpath_app.accounts_pkey'::pg_catalog.regclass`);
          if (result.rowCount !== 1) throw new Error("application_primary_index_drift_failed");
        }, () => first.query(`UPDATE pg_catalog.pg_index
          SET indisvalid = true, indisready = true
          WHERE indexrelid = 'pintpath_app.accounts_pkey'::pg_catalog.regclass`));
        await expectRejectedCatalogDrift(first, firstRoles, publications, async () => {
          const result = await first.query(`UPDATE pg_catalog.pg_attribute
            SET attgenerated = 's'
            WHERE attrelid = 'pintpath_app.system_state'::pg_catalog.regclass
              AND attname = 'revision'`);
          if (result.rowCount !== 1) throw new Error("generated_column_drift_failed");
        }, () => first.query(`UPDATE pg_catalog.pg_attribute
          SET attgenerated = ''
          WHERE attrelid = 'pintpath_app.system_state'::pg_catalog.regclass
            AND attname = 'revision'`));
        await expectRejectedCatalogDrift(first, firstRoles, publications, async () => {
          const result = await first.query(`UPDATE pg_catalog.pg_attribute
            SET attidentity = 'a'
            WHERE attrelid = 'pintpath_app.accounts'::pg_catalog.regclass
              AND attname = 'trust_score'`);
          if (result.rowCount !== 1) throw new Error("identity_column_drift_failed");
        }, () => first.query(`UPDATE pg_catalog.pg_attribute
          SET attidentity = ''
          WHERE attrelid = 'pintpath_app.accounts'::pg_catalog.regclass
            AND attname = 'trust_score'`));
        await expectRejectedCatalogDrift(first, firstRoles, publications, async () => {
          const result = await first.query(`UPDATE pg_catalog.pg_attribute
            SET attcollation = 'pg_catalog."C"'::pg_catalog.regcollation
            WHERE attrelid = 'pintpath_app.accounts'::pg_catalog.regclass
              AND attname = 'email'`);
          if (result.rowCount !== 1) throw new Error("column_collation_drift_failed");
        }, () => first.query(`UPDATE pg_catalog.pg_attribute AS attribute
          SET attcollation = column_type.typcollation
          FROM pg_catalog.pg_type AS column_type
          WHERE attribute.atttypid = column_type.oid
            AND attribute.attrelid = 'pintpath_app.accounts'::pg_catalog.regclass
            AND attribute.attname = 'email'`));
        await expectRejectedCatalogDrift(first, firstRoles, publications, () => first.query(
          `GRANT SELECT (receipt_sha256)
           ON pintpath_ops.reviewed_price_promotion_operations TO pintpath_runtime`,
        ), () => first.query(`REVOKE SELECT (receipt_sha256)
          ON pintpath_ops.reviewed_price_promotion_operations FROM pintpath_runtime`));
        await expectRejectedCatalogDrift(first, firstRoles, publications, async () => {
          const result = await first.query(`UPDATE pg_catalog.pg_index
            SET indisvalid = false
            WHERE indexrelid =
              'pintpath_ops.reviewed_price_promotion_operations_receipt_uidx'::pg_catalog.regclass`);
          if (result.rowCount !== 1) throw new Error("index_flag_drift_failed");
        }, () => first.query(`UPDATE pg_catalog.pg_index
          SET indisvalid = true
          WHERE indexrelid =
            'pintpath_ops.reviewed_price_promotion_operations_receipt_uidx'::pg_catalog.regclass`));
        await expectRejectedCatalogDrift(first, firstRoles, publications, () => first.query(
          `ALTER TABLE pintpath_ops.reviewed_price_promotion_operations
           ALTER CONSTRAINT reviewed_price_promotion_operations_source_apply_fkey DEFERRABLE`,
        ), () => first.query(`ALTER TABLE pintpath_ops.reviewed_price_promotion_operations
          ALTER CONSTRAINT reviewed_price_promotion_operations_source_apply_fkey NOT DEFERRABLE`));
        await expectRejectedCatalogDrift(first, firstRoles, publications, () => first.query(
          "ALTER TABLE pintpath_ops.reviewed_price_promotion_rows DISABLE TRIGGER ALL",
        ), () => first.query(
          "ALTER TABLE pintpath_ops.reviewed_price_promotion_rows ENABLE TRIGGER ALL",
        ));
        await expectRejectedCatalogDrift(first, firstRoles, publications, () => first.query(
          `ALTER FUNCTION pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) STRICT`,
        ), () => first.query(`ALTER FUNCTION
          pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) CALLED ON NULL INPUT`));
        await expectRejectedCatalogDrift(first, firstRoles, publications, () => first.query(
          `ALTER ROLE ${quoteIdentifier(firstRoles[0]!)} INHERIT`,
        ), () => first.query(`ALTER ROLE ${quoteIdentifier(firstRoles[0]!)} NOINHERIT`));

        const finalCapture = await captureReadOnly(
          first, (connection) => capturePostgresLogicalStateV2(connection, { pageRows: 1 }),
        ) as PostgresLogicalStateCaptureV2;
        expect(finalCapture).toEqual(emptyFirst);
        expect(await auditState(first, firstRoles, publications)).toEqual(stableAudit);
      } finally {
        await closeClient(second).catch(() => undefined);
        await closeClient(first).catch(() => undefined);
      }
    }, 60_000);
  },
);
