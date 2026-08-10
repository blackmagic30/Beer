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
import {
  sha256PostgresMigrationTargetIdentity,
  type PostgresMigrationReceipt,
  type PostgresMigrationTargetIdentity,
} from "../src/db/postgres-migration-receipt.js";
import { sha256PostgresMigrationBytes } from "../src/db/postgres-migration-schema.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
  POSTGRES_REVIEWED_PRICE_PROMOTION_PRIVATE_INPUT_KIND,
  buildPostgresReviewedPricePromotionPlanCandidate,
  sha256PostgresReviewedPricePromotionIdentity,
  sha256PostgresReviewedPricePromotionValue,
} from "../src/lib/postgres-reviewed-price-promotion-plan.js";
import type { VerifiedAccountDeletionLedger } from "../src/lib/offsite-backup.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const REQUIRED_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_REQUIRED";
const TEST_DATABASE = "pintpath_migration_integration_test";
const TEST_LOGIN = "pintpath_migration_integration_login";
const PLANNER_ROLE = "pintpath_reviewed_price_planner";
const PLANNER_APPLICATION_NAME = "pintpath-reviewed-price-planner-integration";
const CANDIDATE_SHA = "c".repeat(40);
const INGESTION_ID = "11111111-1111-4111-8111-111111111111";
const VENUE_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-08T00:00:00.000Z";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const configuredRequired = process.env[REQUIRED_ENV]?.trim() ?? "";

if (configuredRequired !== "" && configuredRequired !== "true") {
  throw new Error(`${REQUIRED_ENV} must be true when set.`);
}
if (configuredRequired === "true" && !configuredAdminUrl) {
  throw new Error(`${ADMIN_URL_ENV} is mandatory when ${REQUIRED_ENV}=true.`);
}

const PLANNER_RELATIONS = Object.freeze([
  {
    columns: ["key", "value"],
    policy: "schema_metadata_reviewed_price_planner_select",
    schema: "pintpath_app",
    table: "schema_metadata",
  },
  {
    columns: [
      "run_id", "source_snapshot_sha256", "source_schema_fingerprint", "contract_sha256",
      "manifest_sha256", "target_ddl_sha256", "source_schema_version", "candidate_commit_sha",
      "target_binding_sha256", "expected_environment", "approval_reference_sha256",
      "operator_id_sha256", "status", "started_at", "completed_at", "verifier_id_sha256",
      "receipt_sha256", "failure_code",
    ],
    policy: "migration_runs_reviewed_price_planner_select",
    schema: "pintpath_ops",
    table: "migration_runs",
  },
  {
    columns: [
      "id", "venue_id", "venue_name", "source_type", "source_url",
      "image_retention_expires_at", "image_redacted_at", "image_redaction_reason", "note",
      "status", "review_claim_token", "review_claimed_at", "venue_name_guess",
      "captured_notes", "overall_confidence", "extracted_beers_json", "review_beers_json",
      "created_at", "updated_at", "published_at", "rejected_at",
    ],
    policy: "admin_ingestion_queue_reviewed_price_planner_select",
    schema: "pintpath_app",
    table: "admin_ingestion_queue",
  },
  {
    columns: ["venue_id", "name", "address", "suburb", "area", "active", "updated_at"],
    policy: "venue_profiles_reviewed_price_planner_select",
    schema: "pintpath_app",
    table: "venue_profiles",
  },
  {
    columns: ["alias_key", "alias", "beer_key"],
    policy: "beer_catalog_aliases_reviewed_price_planner_select",
    schema: "pintpath_app",
    table: "beer_catalog_aliases",
  },
  {
    columns: ["key", "name", "brewery", "style", "abv", "status", "source", "updated_at"],
    policy: "beer_catalog_items_reviewed_price_planner_select",
    schema: "pintpath_app",
    table: "beer_catalog_items",
  },
  {
    columns: ["id", "venue_id", "source_ingestion_id", "confidence", "source_type", "updated_at"],
    policy: "venue_price_records_reviewed_price_planner_select",
    schema: "pintpath_app",
    table: "venue_price_records",
  },
  {
    columns: ["id", "venue_id", "source_ingestion_id", "normalized_beer_id", "updated_at"],
    policy: "venue_beers_reviewed_price_planner_select",
    schema: "pintpath_app",
    table: "venue_beers",
  },
  {
    columns: [
      "id", "venue_id", "price_record_id", "beer_name", "reason", "notes",
      "source_photo_url", "status", "assigned_to", "resolution_note", "resolved_at",
      "resolved_by", "created_at", "updated_at",
    ],
    policy: "wrong_price_reports_reviewed_price_planner_select",
    schema: "pintpath_app",
    table: "wrong_price_reports",
  },
] as const);

const PLANNER_COLUMN_COUNT = PLANNER_RELATIONS.reduce(
  (total, relation) => total + relation.columns.length,
  0,
);
const LOGICAL_BACKUP_SELECT_POLICY_EXPRESSION =
  "(CURRENT_USER = ('pintpath_logical_backup_d'::text || ( SELECT (database.oid)::text AS oid\n"
  + "   FROM pg_database database\n"
  + "  WHERE (database.datname = current_database()))))";

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
  source.prepare(
    `INSERT INTO venue_profiles (
       venue_id, name, address, suburb, area, active, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    VENUE_ID,
    "Fixture Hotel",
    "123 Private Street",
    "Fitzroy",
    "inner-north",
    1,
    NOW,
    NOW,
  );
  source.prepare(
    `INSERT INTO admin_ingestion_queue (
       id, venue_id, venue_name, source_type, source_url, note, status,
       venue_name_guess, captured_notes, overall_confidence, extracted_beers_json,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    INGESTION_ID,
    VENUE_ID,
    "Fixture Hotel",
    "source_reference",
    "https://menu.example.test/drinks/menu.pdf?token=PRIVATE_SOURCE_TOKEN",
    "Reviewed ordinary drinks menu.",
    "pending_review",
    "Fixture Hotel",
    "PRIVATE_QUEUE_NOTE",
    0.93,
    JSON.stringify([{
      availabilityStatus: "on_tap",
      availableOnTap: true,
      availablePackageOnly: false,
      confidence: 0.94,
      name: "Carlton Draught",
      needsReview: false,
      notes: null,
      priceNumeric: 13.5,
      priceText: "$13.50 pint",
      servingSize: "pint",
      unavailableReason: null,
    }]),
    NOW,
    NOW,
  );
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
    candidateSha: CANDIDATE_SHA,
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
    candidateSha: CANDIDATE_SHA,
    approvalReference: "postgres-integration-approval",
    operatorId: "postgres-integration-operator",
    verifierId: "postgres-integration-verifier",
  };
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`unsafe_identifier:${value}`);
  return `"${value}"`;
}

function normalizePlannerRow<Row extends QueryResultRow>(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ])) as Row;
}

class PlannerPostgresDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private activeTransaction = false;
  private closed = false;
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;

  constructor(readonly client: Client) {}

  private async query<Row extends QueryResultRow>(sql: string, bindings: SqlBindings) {
    if (this.closed) throw new Error("planner_database_closed");
    const compiled = sqlDatabaseInternals.compilePostgresQuery(sql, bindings);
    try {
      const result = await this.client.query<Row>(compiled.text, compiled.values);
      this.completedQueries += 1;
      return {
        rowCount: result.rowCount ?? 0,
        rows: result.rows.map(normalizePlannerRow),
      };
    } catch (error) {
      this.failedQueries += 1;
      throw error;
    }
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async (...bindings: unknown[]) => {
        const result = await this.query(sql, bindings);
        return { changes: result.rowCount };
      },
      get: async <Row extends QueryResultRow = QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, bindings);
        return result.rows[0];
      },
      all: async <Row extends QueryResultRow = QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, bindings);
        return result.rows;
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql, []);
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      if (this.activeTransaction) throw new Error("nested_planner_transaction_forbidden");
      this.activeTransaction = true;
      await this.client.query("BEGIN");
      try {
        const result = await work();
        await this.client.query("COMMIT");
        return result;
      } catch (error) {
        this.transactionFailures += 1;
        await this.client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        this.activeTransaction = false;
      }
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.end();
  }

  metrics(): SqlPoolMetrics {
    return {
      completedQueries: this.completedQueries,
      dialect: "postgres",
      failedQueries: this.failedQueries,
      idleConnections: this.closed ? 0 : 1,
      lastQueryDurationMs: null,
      totalConnections: this.closed ? 0 : 1,
      transactionFailures: this.transactionFailures,
      waitingRequests: 0,
    };
  }
}

async function readMigrationTargetIdentity(client: Client): Promise<PostgresMigrationTargetIdentity> {
  const result = await client.query<PostgresMigrationTargetIdentity>(`
    SELECT
      control.system_identifier::text AS "systemIdentifier",
      database.oid::text AS "databaseOid",
      current_database() AS "databaseName",
      session_user::text AS "sessionUser",
      current_user::text AS "currentUser",
      current_setting('server_version_num') AS "serverVersionNum"
    FROM pg_catalog.pg_database AS database
    CROSS JOIN pg_catalog.pg_control_system() AS control
    WHERE database.datname = current_database()
  `);
  if (result.rows.length !== 1) throw new Error("migration_target_identity_missing");
  return result.rows[0]!;
}

async function snapshotUserTableHashes(client: Client): Promise<Readonly<Record<string, string>>> {
  const relations = await client.query<{ schemaName: string; tableName: string }>(`
    SELECT namespace.nspname AS "schemaName", relation.relname AS "tableName"
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE relation.relkind = 'r'
      AND namespace.nspname IN ('pintpath_app', 'pintpath_ops')
    ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C"
  `);
  const hashes: Record<string, string> = {};
  for (const relation of relations.rows) {
    const qualified = `${quoteIdentifier(relation.schemaName)}.${quoteIdentifier(relation.tableName)}`;
    const snapshot = await client.query<{ snapshotJson: string }>(`
      SELECT COALESCE(
        jsonb_agg(to_jsonb(snapshot_row) ORDER BY to_jsonb(snapshot_row)::text),
        '[]'::jsonb
      )::text AS "snapshotJson"
      FROM ${qualified} AS snapshot_row
    `);
    hashes[`${relation.schemaName}.${relation.tableName}`] = sha256PostgresMigrationBytes(
      snapshot.rows[0]?.snapshotJson ?? "",
    );
  }
  return Object.freeze(hashes);
}

async function expectPermissionDenied(client: Client, sql: string): Promise<void> {
  let failure: unknown;
  try {
    await client.query(sql);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "42501" });
}

interface PublicAclRow {
  readonly key: string;
  readonly restoreSql: string;
  readonly revokeSql: string;
}

interface LogicalBackupPolicyRow {
  readonly command: string;
  readonly name: string;
  readonly permissive: boolean;
  readonly relation: string;
  readonly roles: string;
  readonly usingExpression: string;
  readonly withCheckExpression: string | null;
}

interface PlannerAuthorityState {
  backendPid: number | null;
  databaseConnectGranted: boolean;
  database: PlannerPostgresDatabase | null;
  grantedRelations: number[];
  logicalPoliciesBefore: readonly LogicalBackupPolicyRow[] | null;
  plannerPolicyRelations: number[];
  publicAclBefore: readonly PublicAclRow[] | null;
  publicHardened: boolean;
  roleCreated: boolean;
  roleDisabled: boolean;
  roleOid: string | null;
  schemaUsageGranted: boolean;
}

function userNamespacePredicate(alias: string): string {
  return `${alias}.nspname <> 'information_schema'
    AND ${alias}.nspname <> 'pg_catalog'
    AND ${alias}.nspname NOT LIKE 'pg_toast%'
    AND ${alias}.nspname NOT LIKE 'pg_temp_%'
    AND ${alias}.nspname NOT LIKE 'pg_toast_temp_%'`;
}

async function capturePublicAcl(client: Client): Promise<readonly PublicAclRow[]> {
  const result = await client.query<PublicAclRow>(`
    WITH public_acl AS (
      SELECT
        pg_catalog.format(
          'database:%s:%s:%s', object.datname, privilege.privilege_type,
          privilege.is_grantable::text
        ) AS key,
        pg_catalog.format(
          'GRANT %s ON DATABASE %I TO PUBLIC%s',
          privilege.privilege_type,
          object.datname,
          CASE WHEN privilege.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
        ) AS "restoreSql",
        pg_catalog.format(
          'REVOKE %s ON DATABASE %I FROM PUBLIC', privilege.privilege_type, object.datname
        ) AS "revokeSql"
      FROM pg_catalog.pg_database AS object
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(object.datacl, pg_catalog.acldefault('d'::"char", object.datdba))
      ) AS privilege
      WHERE object.datallowconn AND privilege.grantee = 0

      UNION ALL

      SELECT
        pg_catalog.format(
          'schema:%s:%s:%s', object.nspname, privilege.privilege_type,
          privilege.is_grantable::text
        ),
        pg_catalog.format(
          'GRANT %s ON SCHEMA %I TO PUBLIC%s',
          privilege.privilege_type,
          object.nspname,
          CASE WHEN privilege.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
        ),
        pg_catalog.format(
          'REVOKE %s ON SCHEMA %I FROM PUBLIC', privilege.privilege_type, object.nspname
        )
      FROM pg_catalog.pg_namespace AS object
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(object.nspacl, pg_catalog.acldefault('n'::"char", object.nspowner))
      ) AS privilege
      WHERE ${userNamespacePredicate("object")} AND privilege.grantee = 0

      UNION ALL

      SELECT
        pg_catalog.format(
          'relation:%s.%s:%s:%s', namespace.nspname, object.relname,
          privilege.privilege_type, privilege.is_grantable::text
        ),
        pg_catalog.format(
          'GRANT %s ON %s %I.%I TO PUBLIC%s',
          privilege.privilege_type,
          CASE WHEN object.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
          namespace.nspname,
          object.relname,
          CASE WHEN privilege.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
        ),
        pg_catalog.format(
          'REVOKE %s ON %s %I.%I FROM PUBLIC',
          privilege.privilege_type,
          CASE WHEN object.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
          namespace.nspname,
          object.relname
        )
      FROM pg_catalog.pg_class AS object
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = object.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        object.relacl,
        pg_catalog.acldefault(
          CASE WHEN object.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
          object.relowner
        )
      )) AS privilege
      WHERE ${userNamespacePredicate("namespace")}
        AND object.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND privilege.grantee = 0

      UNION ALL

      SELECT
        pg_catalog.format(
          'column:%s.%s.%s:%s:%s', namespace.nspname, relation.relname,
          attribute.attname, privilege.privilege_type, privilege.is_grantable::text
        ),
        pg_catalog.format(
          'GRANT %s (%I) ON TABLE %I.%I TO PUBLIC%s',
          privilege.privilege_type,
          attribute.attname,
          namespace.nspname,
          relation.relname,
          CASE WHEN privilege.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
        ),
        pg_catalog.format(
          'REVOKE %s (%I) ON TABLE %I.%I FROM PUBLIC',
          privilege.privilege_type,
          attribute.attname,
          namespace.nspname,
          relation.relname
        )
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      WHERE ${userNamespacePredicate("namespace")}
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND privilege.grantee = 0

      UNION ALL

      SELECT
        pg_catalog.format(
          'routine:%s.%s(%s):%s:%s', namespace.nspname, object.proname,
          pg_catalog.pg_get_function_identity_arguments(object.oid),
          privilege.privilege_type, privilege.is_grantable::text
        ),
        pg_catalog.format(
          'GRANT %s ON %s %I.%I(%s) TO PUBLIC%s',
          privilege.privilege_type,
          CASE WHEN object.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
          namespace.nspname,
          object.proname,
          pg_catalog.pg_get_function_identity_arguments(object.oid),
          CASE WHEN privilege.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
        ),
        pg_catalog.format(
          'REVOKE %s ON %s %I.%I(%s) FROM PUBLIC',
          privilege.privilege_type,
          CASE WHEN object.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
          namespace.nspname,
          object.proname,
          pg_catalog.pg_get_function_identity_arguments(object.oid)
        )
      FROM pg_catalog.pg_proc AS object
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = object.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        object.proacl, pg_catalog.acldefault('f'::"char", object.proowner)
      )) AS privilege
      WHERE ${userNamespacePredicate("namespace")} AND privilege.grantee = 0
    )
    SELECT key, "restoreSql", "revokeSql"
    FROM (
      SELECT DISTINCT key, "restoreSql", "revokeSql"
      FROM public_acl
    ) AS deduplicated
    ORDER BY key COLLATE "C"
  `);
  return Object.freeze(result.rows.map((row) => Object.freeze(row)));
}

async function captureLogicalBackupPolicies(
  client: Client,
): Promise<readonly LogicalBackupPolicyRow[]> {
  const relations = PLANNER_RELATIONS.map((relation) => `${relation.schema}.${relation.table}`);
  const result = await client.query<LogicalBackupPolicyRow>(`
    SELECT
      (namespace.nspname || '.' || relation.relname) AS relation,
      policy.polname AS name,
      policy.polcmd AS command,
      policy.polpermissive AS permissive,
      policy.polroles::text AS roles,
      pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) AS "usingExpression",
      pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, false) AS "withCheckExpression"
    FROM pg_catalog.pg_policy AS policy
    JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE (namespace.nspname || '.' || relation.relname) = ANY($1::text[])
      AND policy.polname = (relation.relname || '_logical_backup_select')::name
    ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C"
  `, [relations]);
  return Object.freeze(result.rows.map((row) => Object.freeze(row)));
}

async function hardenPublicAcl(
  client: Client,
  snapshot: readonly PublicAclRow[],
): Promise<void> {
  for (const row of snapshot) await client.query(row.revokeSql);
  const remaining = await capturePublicAcl(client);
  if (remaining.length !== 0) throw new Error("public_acl_hardening_incomplete");
}

async function restorePublicAcl(
  client: Client,
  snapshot: readonly PublicAclRow[],
): Promise<void> {
  for (const row of snapshot) await client.query(row.restoreSql);
}

async function provisionPlannerAuthority(
  state: PlannerAuthorityState,
  admin: Client,
  targetAdmin: Client,
  adminUrl: URL,
): Promise<void> {
  if (PLANNER_COLUMN_COUNT !== 84 || PLANNER_RELATIONS.length !== 9) {
    throw new Error("planner_acl_contract_mismatch");
  }
  const existing = await admin.query(
    "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
    [PLANNER_ROLE],
  );
  if (existing.rowCount !== 0) throw new Error("planner_role_preexists");

  state.publicAclBefore = await capturePublicAcl(targetAdmin);
  state.logicalPoliciesBefore = await captureLogicalBackupPolicies(targetAdmin);
  if (
    state.logicalPoliciesBefore.length !== PLANNER_RELATIONS.length
    || state.logicalPoliciesBefore.some((policy) => (
      policy.command !== "r"
      || !policy.permissive
      || policy.roles !== "{0}"
      || policy.usingExpression !== LOGICAL_BACKUP_SELECT_POLICY_EXPRESSION
      || policy.withCheckExpression !== null
    ))
  ) {
    throw new Error("canonical_logical_backup_policy_missing");
  }

  state.publicHardened = true;
  await hardenPublicAcl(targetAdmin, state.publicAclBefore);

  const password = crypto.randomBytes(32).toString("hex");
  await admin.query(
    `CREATE ROLE ${PLANNER_ROLE} LOGIN NOINHERIT PASSWORD '${password}'
     NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
  );
  state.roleCreated = true;
  const role = await admin.query<{ oid: string }>(
    "SELECT oid::text AS oid FROM pg_catalog.pg_roles WHERE rolname = $1",
    [PLANNER_ROLE],
  );
  if (role.rows.length !== 1) throw new Error("planner_role_oid_missing");
  state.roleOid = role.rows[0]!.oid;
  await admin.query(`GRANT CONNECT ON DATABASE ${TEST_DATABASE} TO ${PLANNER_ROLE}`);
  state.databaseConnectGranted = true;
  await targetAdmin.query(
    `GRANT USAGE ON SCHEMA pintpath_app, pintpath_ops TO ${PLANNER_ROLE}`,
  );
  state.schemaUsageGranted = true;
  for (const [index, relation] of PLANNER_RELATIONS.entries()) {
    const qualified = `${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.table)}`;
    const columns = relation.columns.map(quoteIdentifier).join(", ");
    await targetAdmin.query(
      `GRANT SELECT (${columns}) ON TABLE ${qualified} TO ${PLANNER_ROLE}`,
    );
    state.grantedRelations.push(index);
    await targetAdmin.query(
      `CREATE POLICY ${quoteIdentifier(relation.policy)} ON ${qualified}
       FOR SELECT TO ${PLANNER_ROLE} USING (true)`,
    );
    state.plannerPolicyRelations.push(index);
  }

  const plannerClient = new Client({
    application_name: PLANNER_APPLICATION_NAME,
    connectionString: withDatabase(adminUrl, TEST_DATABASE, PLANNER_ROLE, password),
    types: sqlDatabaseInternals.createPostgresTypeOverrides(),
  });
  await plannerClient.connect();
  const backend = await plannerClient.query<{ pid: number }>(
    "SELECT pg_catalog.pg_backend_pid() AS pid",
  );
  state.backendPid = backend.rows[0]?.pid ?? null;
  if (!Number.isSafeInteger(state.backendPid)) throw new Error("planner_backend_pid_missing");
  state.database = new PlannerPostgresDatabase(plannerClient);
}

async function cleanupPlannerAuthority(
  state: PlannerAuthorityState,
  admin: Client,
  targetAdmin: Client,
  assertExact: boolean,
): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
  };

  if (state.roleCreated) {
    await attempt(async () => {
      await admin.query(`ALTER ROLE ${PLANNER_ROLE} NOLOGIN PASSWORD NULL`);
      state.roleDisabled = true;
    });
  }
  await attempt(async () => {
    await state.database?.close();
    state.database = null;
  });
  if (state.roleCreated && state.backendPid !== null) {
    await attempt(async () => {
      await admin.query(`
        SELECT pg_catalog.pg_terminate_backend(pid)
        FROM pg_catalog.pg_stat_activity
        WHERE pid = $1
          AND datname = $2
          AND usename = $3
          AND application_name = $4
          AND backend_type = 'client backend'
          AND pid <> pg_catalog.pg_backend_pid()
      `, [state.backendPid, TEST_DATABASE, PLANNER_ROLE, PLANNER_APPLICATION_NAME]);
      const remaining = await admin.query(`
        SELECT pid
        FROM pg_catalog.pg_stat_activity
        WHERE datname = $1
          AND usename = $2
          AND application_name = $3
          AND backend_type = 'client backend'
      `, [TEST_DATABASE, PLANNER_ROLE, PLANNER_APPLICATION_NAME]);
      expect(remaining.rows).toEqual([]);
      state.backendPid = null;
    });
  }
  if (state.roleCreated) {
    for (const index of [...state.plannerPolicyRelations].reverse()) {
      const relation = PLANNER_RELATIONS[index]!;
      await attempt(async () => {
        const qualified = `${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.table)}`;
        await targetAdmin.query(
          `DROP POLICY ${quoteIdentifier(relation.policy)} ON ${qualified}`,
        );
        state.plannerPolicyRelations = state.plannerPolicyRelations.filter(
          (candidate) => candidate !== index,
        );
      });
    }
    for (const index of [...state.grantedRelations].reverse()) {
      const relation = PLANNER_RELATIONS[index]!;
      await attempt(async () => {
        const qualified = `${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.table)}`;
        const columns = relation.columns.map(quoteIdentifier).join(", ");
        await targetAdmin.query(
          `REVOKE SELECT (${columns}) ON TABLE ${qualified} FROM ${PLANNER_ROLE}`,
        );
        state.grantedRelations = state.grantedRelations.filter(
          (candidate) => candidate !== index,
        );
      });
    }
    if (state.schemaUsageGranted) {
      await attempt(async () => {
        await targetAdmin.query(
          `REVOKE USAGE ON SCHEMA pintpath_app, pintpath_ops FROM ${PLANNER_ROLE}`,
        );
        state.schemaUsageGranted = false;
      });
    }
    if (state.databaseConnectGranted) {
      await attempt(async () => {
        await admin.query(`REVOKE CONNECT ON DATABASE ${TEST_DATABASE} FROM ${PLANNER_ROLE}`);
        state.databaseConnectGranted = false;
      });
    }
    if (state.roleOid !== null) {
      await attempt(async () => {
        const dependencies = await targetAdmin.query<{ count: string }>(`
          SELECT count(*)::text AS count
          FROM pg_catalog.pg_shdepend
          WHERE refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
            AND refobjid = $1::oid
        `, [state.roleOid]);
        expect(dependencies.rows).toEqual([{ count: "0" }]);
      });
    }
    await attempt(async () => {
      await admin.query(`DROP ROLE ${PLANNER_ROLE}`);
      state.roleCreated = false;
      state.roleDisabled = false;
      state.roleOid = null;
    });
  }
  if (
    state.publicHardened
    && state.publicAclBefore
    && (!state.roleCreated || state.roleDisabled && state.backendPid === null)
  ) {
    await attempt(async () => {
      await restorePublicAcl(targetAdmin, state.publicAclBefore!);
      expect(await capturePublicAcl(targetAdmin)).toEqual(state.publicAclBefore);
      state.publicHardened = false;
    });
  }
  if (state.publicHardened) {
    failures.push(new Error("public_acl_restore_blocked_by_active_planner_authority"));
  }

  if (assertExact && state.publicAclBefore && !state.publicHardened) {
    await attempt(async () => {
      expect(await capturePublicAcl(targetAdmin)).toEqual(state.publicAclBefore);
    });
  }
  if (assertExact && state.logicalPoliciesBefore) {
    await attempt(async () => {
      expect(await captureLogicalBackupPolicies(targetAdmin)).toEqual(
        state.logicalPoliciesBefore,
      );
    });
  }
  if (assertExact) {
    await attempt(async () => {
      const role = await admin.query(
        "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
        [PLANNER_ROLE],
      );
      expect(role.rowCount).toBe(0);
      const policies = await targetAdmin.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM pg_catalog.pg_policy
        WHERE polname LIKE '%_reviewed_price_planner_select'
      `);
      expect(policies.rows).toEqual([{ count: "0" }]);
    });
  }
  if (failures.length > 0) throw failures[0];
}

async function retryPublicAclRestoration(
  state: PlannerAuthorityState,
  admin: Client,
  targetAdmin: Client,
): Promise<void> {
  if (!state.publicHardened) return;
  if (!state.publicAclBefore) throw new Error("public_acl_recovery_snapshot_missing");

  if (state.roleCreated) {
    await admin.query(`ALTER ROLE ${PLANNER_ROLE} NOLOGIN PASSWORD NULL`);
    state.roleDisabled = true;
    await state.database?.close();
    state.database = null;
    if (state.backendPid !== null) {
      await admin.query(`
        SELECT pg_catalog.pg_terminate_backend(pid)
        FROM pg_catalog.pg_stat_activity
        WHERE pid = $1
          AND datname = $2
          AND usename = $3
          AND application_name = $4
          AND backend_type = 'client backend'
          AND pid <> pg_catalog.pg_backend_pid()
      `, [state.backendPid, TEST_DATABASE, PLANNER_ROLE, PLANNER_APPLICATION_NAME]);
    }
    const sessions = await admin.query(`
      SELECT pid
      FROM pg_catalog.pg_stat_activity
      WHERE datname = $1
        AND usename = $2
        AND backend_type = 'client backend'
    `, [TEST_DATABASE, PLANNER_ROLE]);
    expect(sessions.rows).toEqual([]);
    state.backendPid = null;
    const disabledRole = await admin.query<{
      passwordCleared: boolean;
      rolcanlogin: boolean;
    }>(`
      SELECT rolcanlogin, (rolpassword IS NULL) AS "passwordCleared"
      FROM pg_catalog.pg_authid
      WHERE rolname = $1
    `, [PLANNER_ROLE]);
    expect(disabledRole.rows).toEqual([{
      passwordCleared: true,
      rolcanlogin: false,
    }]);
  }

  await restorePublicAcl(targetAdmin, state.publicAclBefore);
  expect(await capturePublicAcl(targetAdmin)).toEqual(state.publicAclBefore);
  state.publicHardened = false;
}

describe("PUBLIC ACL recovery state", () => {
  it("keeps the recovery marker set when exact post-restore verification fails", async () => {
    const state: PlannerAuthorityState = {
      backendPid: null,
      database: null,
      databaseConnectGranted: false,
      grantedRelations: [],
      logicalPoliciesBefore: null,
      plannerPolicyRelations: [],
      publicAclBefore: [],
      publicHardened: true,
      roleCreated: false,
      roleDisabled: false,
      roleOid: null,
      schemaUsageGranted: false,
    };
    const unexpectedAcl: PublicAclRow = {
      key: "database:unexpected:CONNECT:false",
      restoreSql: "GRANT CONNECT ON DATABASE unexpected TO PUBLIC",
      revokeSql: "REVOKE CONNECT ON DATABASE unexpected FROM PUBLIC",
    };
    const mismatchedCapture = {
      async query() {
        return { rows: [unexpectedAcl] };
      },
    } as unknown as Client;

    await expect(retryPublicAclRestoration(
      state,
      mismatchedCapture,
      mismatchedCapture,
    )).rejects.toThrow();
    expect(state.publicHardened).toBe(true);
  });
});

describe.skipIf(!configuredAdminUrl)("real PostgreSQL migration target", () => {
  let adminUrl: URL;
  let admin: Client;
  let targetAdmin: Client | null = null;
  let target: Client | null = null;
  let temporaryRoot = "";
  let migratorRoleExisted = false;
  let runtimeRoleExisted = false;
  const plannerState: PlannerAuthorityState = {
    backendPid: null,
    database: null,
    databaseConnectGranted: false,
    grantedRelations: [],
    logicalPoliciesBefore: null,
    plannerPolicyRelations: [],
    publicAclBefore: null,
    publicHardened: false,
    roleCreated: false,
    roleDisabled: false,
    roleOid: null,
    schemaUsageGranted: false,
  };

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
    const failures: unknown[] = [];
    const attempt = async (work: () => void | Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await attempt(() => {
      if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });
    if (
      targetAdmin
      && admin
      && (plannerState.roleCreated || plannerState.publicHardened || plannerState.database)
    ) {
      await attempt(() => cleanupPlannerAuthority(plannerState, admin, targetAdmin!, false));
    }
    if (targetAdmin && admin && plannerState.publicHardened) {
      await attempt(() => retryPublicAclRestoration(plannerState, admin, targetAdmin!));
    }
    await attempt(async () => target?.end());
    if (plannerState.publicHardened) {
      failures.push(new Error(
        "public_acl_recovery_preserved_disposable_database_and_roles",
      ));
      await attempt(async () => targetAdmin?.end());
      if (admin) await attempt(async () => admin.end());
      throw failures[0];
    }
    await attempt(async () => targetAdmin?.end());
    if (admin) {
      await attempt(async () => {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [TEST_DATABASE],
        );
      });
      await attempt(async () => admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`));
      if (plannerState.roleCreated) {
        await attempt(async () => {
          await admin.query(`ALTER ROLE ${PLANNER_ROLE} NOLOGIN PASSWORD NULL`);
          await admin.query(`DROP ROLE ${PLANNER_ROLE}`);
          plannerState.roleCreated = false;
          plannerState.roleDisabled = false;
          plannerState.roleOid = null;
        });
      }
      await attempt(async () => admin.query(`REVOKE pintpath_migrator FROM ${TEST_LOGIN}`));
      await attempt(async () => admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`));
      if (!migratorRoleExisted) {
        await attempt(async () => admin.query("DROP ROLE IF EXISTS pintpath_migrator"));
      }
      if (!runtimeRoleExisted) {
        await attempt(async () => admin.query("DROP ROLE IF EXISTS pintpath_runtime"));
      }
      await attempt(async () => admin.end());
    }
    if (failures.length > 0) throw failures[0];
  }, 30_000);

  it("imports, reconciles, and proves the reviewed-price planner is exact and no-write", async () => {
    expect(target).not.toBeNull();
    expect(targetAdmin).not.toBeNull();
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
    const receipt: PostgresMigrationReceipt = await applyPostgresMigrationWithConnection(
      input,
      connection,
    );
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

    const historicalIdentity = await readMigrationTargetIdentity(target!);
    expect(sha256PostgresMigrationTargetIdentity(historicalIdentity)).toBe(
      receipt.targetIdentitySha256,
    );
    const beforeTableHashes = await snapshotUserTableHashes(targetAdmin!);
    expect(Object.keys(beforeTableHashes)).toHaveLength(
      POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables + 3,
    );

    try {
      await provisionPlannerAuthority(plannerState, admin, targetAdmin!, adminUrl);
      expect(plannerState.database).not.toBeNull();
      expect(plannerState.roleOid).toMatch(/^\d+$/);
      expect(plannerState.grantedRelations).toHaveLength(PLANNER_RELATIONS.length);
      expect(plannerState.plannerPolicyRelations).toHaveLength(PLANNER_RELATIONS.length);

      const policyInventory = await targetAdmin!.query<{
        name: string;
        relation: string;
        roles: string;
      }>(`
        SELECT
          (namespace.nspname || '.' || relation.relname) AS relation,
          policy.polname AS name,
          policy.polroles::text AS roles
        FROM pg_catalog.pg_policy AS policy
        JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE (namespace.nspname || '.' || relation.relname) = ANY($1::text[])
          AND (0::oid = ANY(policy.polroles) OR $2::oid = ANY(policy.polroles))
        ORDER BY namespace.nspname COLLATE "C", relation.relname COLLATE "C",
          policy.polname COLLATE "C"
      `, [
        PLANNER_RELATIONS.map((relation) => `${relation.schema}.${relation.table}`),
        plannerState.roleOid,
      ]);
      expect(policyInventory.rows).toHaveLength(PLANNER_RELATIONS.length * 2);
      for (const relation of PLANNER_RELATIONS) {
        const qualified = `${relation.schema}.${relation.table}`;
        expect(policyInventory.rows.filter((row) => row.relation === qualified)).toEqual([
          {
            name: `${relation.table}_logical_backup_select`,
            relation: qualified,
            roles: "{0}",
          },
          {
            name: relation.policy,
            relation: qualified,
            roles: `{${plannerState.roleOid}}`,
          },
        ].sort((left, right) => left.name.localeCompare(right.name)));
      }
      expect(await captureLogicalBackupPolicies(targetAdmin!)).toEqual(
        plannerState.logicalPoliciesBefore,
      );

      const privateInput = {
        itemCount: 1,
        items: [{
          evidenceContentSha256: sha256PostgresMigrationBytes(
            "INTEGRATION_PRIVATE_EVIDENCE",
          ),
          evidenceReferenceSha256: sha256PostgresReviewedPricePromotionIdentity(
            "evidence-reference",
            `source-ingestion:${INGESTION_ID}`,
          ),
          sourceIngestionId: INGESTION_ID,
          venueIdSha256: sha256PostgresReviewedPricePromotionIdentity(
            "venue-id",
            VENUE_ID,
          ),
        }],
        kind: POSTGRES_REVIEWED_PRICE_PROMOTION_PRIVATE_INPUT_KIND,
        marketedSuburb: "Fitzroy",
        version: 1,
      };
      const plannerIdentity = {
        ...historicalIdentity,
        currentUser: PLANNER_ROLE,
        sessionUser: PLANNER_ROLE,
      };
      const plan = await buildPostgresReviewedPricePromotionPlanCandidate({
        candidateSha: CANDIDATE_SHA,
        database: plannerState.database!,
        expectedDeployment: {
          deploymentIdSha256: sha256PostgresReviewedPricePromotionValue(
            "integration-deployment",
          ),
          environmentIdSha256: sha256PostgresReviewedPricePromotionValue(
            "integration-environment",
          ),
          imageDigestSha256: sha256PostgresReviewedPricePromotionValue(
            "integration-image",
          ),
          projectIdSha256: sha256PostgresReviewedPricePromotionValue(
            "integration-project",
          ),
          serviceIdSha256: sha256PostgresReviewedPricePromotionValue(
            "integration-service",
          ),
        },
        expectedEnvironment: "permanent-staging",
        expectedMigration: {
          receiptFileSha256: sha256PostgresReviewedPricePromotionValue(receipt),
        },
        expectedPrivateInputSha256: sha256PostgresReviewedPricePromotionValue(privateInput),
        expectedTargetIdentitySha256: sha256PostgresReviewedPricePromotionValue(
          plannerIdentity,
        ),
        migrationReceipt: receipt,
        migrationTargetIdentity: historicalIdentity,
        privateInput,
      });
      expect(plan).toMatchObject({
        activationBlockers: POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
        candidateSha: CANDIDATE_SHA,
        expectedEnvironment: "permanent-staging",
        mutationEnabled: false,
        privateInput: {
          itemCount: 1,
          marketedSuburb: "Fitzroy",
        },
        sourceSnapshot: {
          publicConflicts: {
            priceRecordCount: 0,
            venueBeerCount: 0,
          },
          wrongPriceReports: {
            openOrInProgressCount: 0,
            totalCount: 0,
          },
        },
        target: {
          catalogIdentity: {
            serverVersionNum: expect.stringMatching(/^17\d{4}$/),
          },
        },
      });
      expect(plan.sourceSnapshot.items).toEqual([
        expect.objectContaining({
          selectedRowCount: 1,
          sourceIngestionId: INGESTION_ID,
        }),
      ]);
      expect(plan.activationBlockers).toEqual(
        POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
      );
      const serializedPlan = JSON.stringify(plan);
      expect(serializedPlan).not.toContain("PRIVATE_SOURCE_TOKEN");
      expect(serializedPlan).not.toContain("PRIVATE_QUEUE_NOTE");
      expect(serializedPlan).not.toContain("binding-only-secret");
      expect(serializedPlan).not.toContain("123 Private Street");
      expect(serializedPlan).not.toContain(VENUE_ID);

      const plannerClient = plannerState.database!.client;
      await expectPermissionDenied(
        plannerClient,
        "INSERT INTO pintpath_app.admin_ingestion_queue (id) VALUES ('forbidden')",
      );
      await expectPermissionDenied(
        plannerClient,
        `UPDATE pintpath_app.admin_ingestion_queue SET note = note WHERE id = '${INGESTION_ID}'`,
      );
      await expectPermissionDenied(
        plannerClient,
        `DELETE FROM pintpath_app.admin_ingestion_queue WHERE id = '${INGESTION_ID}'`,
      );
      await expectPermissionDenied(
        plannerClient,
        "TRUNCATE TABLE pintpath_app.admin_ingestion_queue",
      );
      await expectPermissionDenied(
        plannerClient,
        `SELECT * FROM pintpath_app.admin_ingestion_queue WHERE id = '${INGESTION_ID}'`,
      );
      await expectPermissionDenied(
        plannerClient,
        `SELECT image_data_url FROM pintpath_app.admin_ingestion_queue WHERE id = '${INGESTION_ID}'`,
      );
      await expectPermissionDenied(
        plannerClient,
        "SELECT email, password_hash FROM pintpath_app.accounts LIMIT 1",
      );

      expect(await snapshotUserTableHashes(targetAdmin!)).toEqual(beforeTableHashes);
      expect(await captureLogicalBackupPolicies(targetAdmin!)).toEqual(
        plannerState.logicalPoliciesBefore,
      );
    } finally {
      await cleanupPlannerAuthority(plannerState, admin, targetAdmin!, true);
    }
    expect(await snapshotUserTableHashes(targetAdmin!)).toEqual(beforeTableHashes);
  }, 60_000);
});
