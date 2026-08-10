import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import {
  buildPostgresMigrationReadyMetadata,
  derivePostgresMigrationRunId,
  finalizePostgresMigrationReceipt,
  postgresMigrationReceiptSchema,
  sha256PostgresMigrationReadyMetadata,
  sha256PostgresMigrationRunBinding,
  sha256PostgresMigrationTargetIdentity,
  type PostgresMigrationReadyMetadata,
  type PostgresMigrationReceipt,
  type PostgresMigrationReceiptWithoutHash,
  type PostgresMigrationTargetIdentity,
} from "../src/db/postgres-migration-receipt.js";
import { sha256PostgresMigrationContract } from "../src/db/postgres-migration-schema.js";
import type {
  SqlDatabase,
  SqlPoolMetrics,
  SqlRunResult,
  SqlStatement,
} from "../src/db/sql-database.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
  POSTGRES_REVIEWED_PRICE_PROMOTION_IDENTITY_QUERY,
  POSTGRES_REVIEWED_PRICE_PROMOTION_PRIVATE_INPUT_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_READ_ONLY_TRANSACTION,
  POSTGRES_REVIEWED_PRICE_PROMOTION_ROW_SECURITY,
  POSTGRES_REVIEWED_PRICE_PROMOTION_SEARCH_PATH,
  POSTGRES_REVIEWED_PRICE_PROMOTION_SOURCE_SCHEMA_SHA256,
  PostgresReviewedPricePromotionPlanError,
  buildPostgresReviewedPricePromotionPlanCandidate,
  canonicalPostgresReviewedPricePromotionJson,
  postgresReviewedPricePromotionPlanCandidateSchema,
  sha256PostgresReviewedPricePromotionIdentity,
  sha256PostgresReviewedPricePromotionValue,
  type BuildPostgresReviewedPricePromotionPlanInput,
} from "../src/lib/postgres-reviewed-price-promotion-plan.js";
import { REVIEWED_PRICE_SELECTION_POLICY_SHA256 } from "../src/lib/reviewed-price-selection-policy.js";

const INGESTION_ID = "11111111-1111-4111-8111-111111111111";
const VENUE_ID = "22222222-2222-4222-8222-222222222222";
const CANDIDATE_SHA = "c".repeat(40);
const MIGRATION_PLAN_SHA = "4".repeat(64);
const SOURCE_SNAPSHOT_SHA = "7".repeat(64);
const MANIFEST_SHA = "9".repeat(64);
const TARGET_DDL_SHA = "a".repeat(64);
const EVIDENCE_CONTENT_SHA = "b".repeat(64);
const NOW = "2026-08-11T00:00:00.000Z";
const CONTRACT_SHA = sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT);
const SOURCE_SCHEMA_FINGERPRINT = POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint;
const SOURCE_SCHEMA_VERSION = POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion;
const APPROVAL_REFERENCE_SHA = "1".repeat(64);
const OPERATOR_ID_SHA = "2".repeat(64);
const VERIFIER_ID_SHA = "3".repeat(64);
const TARGET_URL_SHA = "d".repeat(64);
const FROZEN_CONTRACT_SHA =
  "78f49d0af57a19f92154f717c3b5c9c7e3bdc02bbda68809a8f2257bf7ef879d";
const FROZEN_SOURCE_SCHEMA_FINGERPRINT =
  "6dadd6082a06129dbaf05d73a62a7b2e6c2b590127d1c524c844afe54e1ebdb5";
const FROZEN_SOURCE_SCHEMA_SHA =
  "b5a093844709f725bd71415dadb37062b75e40dbd6475082732fa28b1ef1fcc9";
const FROZEN_SELECTION_POLICY_SHA =
  "eb45b42b2c3a75c4b76a14ddcf5dc0053658cec5de5c69025a4319da67a0fa3a";
const FROZEN_TARGET_IDENTITY_SHA =
  "2fd0c64c56749ae487ab0a509084b5063d8e5ba62638a2e875c1191aef395a45";
const FROZEN_RUN_BINDING_SHA =
  "266385249bcd07c5aae52dfad609047a698a80c232e07d1d47045d1414c5c228";
const FROZEN_RUN_ID_SHA =
  "20c6ab718c77c529b5d27c878fc02425da929b43c507e061b147938b76363acd";
const FROZEN_READY_METADATA_SHA =
  "59241c4980549ee89b4064c3bb0d20667d9e4002115fcaa0fe6a8e5a622fcf9c";
const FROZEN_INTERNAL_RECEIPT_SHA =
  "9d1d4f907a8106a6ec4c903c1d19df391ae7997ac48b14f65dce903975daf0b3";
const FROZEN_RECEIPT_FILE_SHA =
  "b7472be77c445ddd87b37cf34abcdb0487a9612af66c5389304e9a51aed70f00";
const PLANNER_ROLE_OID = 16_385;
const LOGICAL_BACKUP_SELECT_POLICY_EXPRESSION =
  "(CURRENT_USER = ('pintpath_logical_backup_d'::text || ( SELECT (database.oid)::text AS oid\n"
  + "   FROM pg_database database\n"
  + "  WHERE (database.datname = current_database()))))";

interface PolicyInventoryRow {
  readonly command: string;
  readonly name: string;
  readonly permissive: boolean;
  readonly roles: readonly number[];
  readonly usingExpression: string;
  readonly withCheckExpression: string | null;
}

function exactPolicyRoles(actual: readonly number[], expected: number): boolean {
  return actual.length === 1 && actual[0] === expected;
}

function policyInventoryPassesIdentityGuard(
  relationName: string,
  plannerPolicyName: string,
  policies: readonly PolicyInventoryRow[],
): boolean {
  const applicablePolicies = policies.filter((policy) => (
    policy.roles.includes(0) || policy.roles.includes(PLANNER_ROLE_OID)
  ));
  const exactPlannerPolicy = applicablePolicies.some((policy) => (
    policy.name === plannerPolicyName
    && policy.command === "r"
    && policy.permissive
    && exactPolicyRoles(policy.roles, PLANNER_ROLE_OID)
    && policy.usingExpression === "true"
    && policy.withCheckExpression === null
  ));
  const exactLogicalBackupPolicy = applicablePolicies.some((policy) => (
    policy.name === `${relationName}_logical_backup_select`
    && policy.command === "r"
    && policy.permissive
    && exactPolicyRoles(policy.roles, 0)
    && policy.usingExpression === LOGICAL_BACKUP_SELECT_POLICY_EXPRESSION
    && policy.withCheckExpression === null
  ));
  return applicablePolicies.length === 2 && exactPlannerPolicy && exactLogicalBackupPolicy;
}

function canonicalPolicyInventory(): readonly PolicyInventoryRow[] {
  return [
    {
      command: "r",
      name: "schema_metadata_reviewed_price_planner_select",
      permissive: true,
      roles: [PLANNER_ROLE_OID],
      usingExpression: "true",
      withCheckExpression: null,
    },
    {
      command: "r",
      name: "schema_metadata_logical_backup_select",
      permissive: true,
      roles: [0],
      usingExpression: LOGICAL_BACKUP_SELECT_POLICY_EXPRESSION,
      withCheckExpression: null,
    },
  ];
}

type QueryTag =
  | "identity"
  | "metadata"
  | "migration-run"
  | "queue"
  | "profiles"
  | "catalog"
  | "price-conflicts"
  | "venue-beer-conflicts"
  | "wrong-prices";

interface DatabaseEvent {
  readonly bindings: readonly unknown[];
  readonly method: "all" | "exec" | "get" | "run";
  readonly sql: string;
}

function queryTag(sql: string): QueryTag {
  const match = /\/\* pintpath:reviewed-price-plan:([a-z-]+) \*\//.exec(sql);
  if (!match) throw new Error(`unexpected_query:${sql}`);
  return match[1] as QueryTag;
}

class FakeSqlDatabase implements SqlDatabase {
  readonly events: DatabaseEvent[] = [];
  transactionCount = 0;

  constructor(
    readonly dialect: "sqlite" | "postgres",
    readonly rows: Record<QueryTag, QueryResultRow[]>,
  ) {}

  prepare(sql: string): SqlStatement {
    const tag = queryTag(sql);
    return {
      run: async (...bindings: unknown[]): Promise<SqlRunResult> => {
        this.events.push({ bindings, method: "run", sql });
        throw new Error("mutation_attempted");
      },
      get: async <Row extends QueryResultRow = QueryResultRow>(
        ...bindings: unknown[]
      ): Promise<Row | undefined> => {
        this.events.push({ bindings, method: "get", sql });
        return this.rows[tag][0] as Row | undefined;
      },
      all: async <Row extends QueryResultRow = QueryResultRow>(
        ...bindings: unknown[]
      ): Promise<Row[]> => {
        this.events.push({ bindings, method: "all", sql });
        return this.rows[tag] as Row[];
      },
    };
  }

  async exec(sql: string): Promise<void> {
    this.events.push({ bindings: [], method: "exec", sql });
    if (
      sql !== POSTGRES_REVIEWED_PRICE_PROMOTION_READ_ONLY_TRANSACTION
      && sql !== POSTGRES_REVIEWED_PRICE_PROMOTION_SEARCH_PATH
      && sql !== POSTGRES_REVIEWED_PRICE_PROMOTION_ROW_SECURITY
    ) {
      throw new Error("mutation_attempted");
    }
  }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      this.transactionCount += 1;
      return work();
    };
  }

  async close(): Promise<void> {
    throw new Error("planner_must_not_close_injected_database");
  }

  metrics(): SqlPoolMetrics {
    return {
      completedQueries: 0,
      dialect: this.dialect,
      failedQueries: 0,
      idleConnections: 1,
      lastQueryDurationMs: null,
      totalConnections: 1,
      transactionFailures: 0,
      waitingRequests: 0,
    };
  }
}

function digest(value: string): string {
  return sha256PostgresReviewedPricePromotionValue(value);
}

function migrationTargetIdentity(): PostgresMigrationTargetIdentity {
  return {
    currentUser: "pintpath_migration_operator",
    databaseName: "railway",
    databaseOid: "16384",
    serverVersionNum: "170006",
    sessionUser: "pintpath_migration_operator",
    systemIdentifier: "7521976435570874594",
  };
}

function readyMetadata(
  runId: string,
): PostgresMigrationReadyMetadata {
  return buildPostgresMigrationReadyMetadata({
    import_state: "ready",
    migration_candidate_sha: CANDIDATE_SHA,
    migration_contract_sha256: CONTRACT_SHA,
    migration_manifest_sha256: MANIFEST_SHA,
    migration_plan_sha256: MIGRATION_PLAN_SHA,
    migration_run_sha256: runId,
    source_schema_fingerprint: SOURCE_SCHEMA_FINGERPRINT,
    source_schema_version: String(SOURCE_SCHEMA_VERSION),
    source_snapshot_sha256: SOURCE_SNAPSHOT_SHA,
    target_ddl_sha256: TARGET_DDL_SHA,
  });
}

function metadataRows(ready: PostgresMigrationReadyMetadata): QueryResultRow[] {
  return [
    ["import_state", ready.import_state],
    ["migration_candidate_sha", ready.migration_candidate_sha],
    ["migration_contract_sha256", ready.migration_contract_sha256],
    ["migration_manifest_sha256", ready.migration_manifest_sha256],
    ["migration_plan_sha256", ready.migration_plan_sha256],
    ["migration_run_sha256", ready.migration_run_sha256],
    ["schema_version", "1"],
    ["source_schema_fingerprint", ready.source_schema_fingerprint],
    ["source_schema_sha256", POSTGRES_REVIEWED_PRICE_PROMOTION_SOURCE_SCHEMA_SHA256],
    ["source_schema_version", ready.source_schema_version],
    ["source_snapshot_sha256", ready.source_snapshot_sha256],
    ["target_ddl_sha256", ready.target_ddl_sha256],
  ].map(([key, value]) => ({ key, value }));
}

function metadataObject(rows: readonly QueryResultRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
}

function safeIdentityRow(): QueryResultRow {
  return {
    currentUser: "pintpath_reviewed_price_planner",
    databaseName: "railway",
    databaseOid: "16384",
    requiredColumnCount: 84,
    requiredRelationCount: 9,
    roleAuthorityValid: true,
    searchPathSchemas: ["pg_catalog"],
    serverVersionNum: "170006",
    sessionUser: "pintpath_reviewed_price_planner",
    systemIdentifier: "7521976435570874594",
    transactionIsolation: "repeatable read",
    transactionReadOnly: true,
  };
}

function targetIdentitySha256(identity: QueryResultRow): string {
  return sha256PostgresMigrationTargetIdentity({
    currentUser: identity.currentUser,
    databaseName: identity.databaseName,
    databaseOid: identity.databaseOid,
    serverVersionNum: identity.serverVersionNum,
    sessionUser: identity.sessionUser,
    systemIdentifier: identity.systemIdentifier,
  });
}

function sourceBeer(): Record<string, unknown> {
  return {
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
  };
}

function canonicalReceipt(
  historicalIdentity: PostgresMigrationTargetIdentity,
): {
  readonly ready: PostgresMigrationReadyMetadata;
  readonly receipt: PostgresMigrationReceipt;
  readonly runBindingSha256: string;
  readonly runIdSha256: string;
} {
  const targetIdentitySha256 = sha256PostgresMigrationTargetIdentity(historicalIdentity);
  const runBindingSha256 = sha256PostgresMigrationRunBinding({
    approvalReferenceSha256: APPROVAL_REFERENCE_SHA,
    candidateSha: CANDIDATE_SHA,
    contractSha256: CONTRACT_SHA,
    expectedEnvironment: "permanent-staging",
    manifestSha256: MANIFEST_SHA,
    operatorIdSha256: OPERATOR_ID_SHA,
    planSha256: MIGRATION_PLAN_SHA,
    sourceSchemaFingerprint: SOURCE_SCHEMA_FINGERPRINT,
    sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
    sourceSnapshotSha256: SOURCE_SNAPSHOT_SHA,
    targetDdlSha256: TARGET_DDL_SHA,
    targetIdentitySha256,
    targetUrlSha256: TARGET_URL_SHA,
    verifierIdSha256: VERIFIER_ID_SHA,
  });
  const runIdSha256 = derivePostgresMigrationRunId(runBindingSha256);
  const ready = readyMetadata(runIdSha256);
  const receipt = finalizePostgresMigrationReceipt({
    approvalReferenceSha256: APPROVAL_REFERENCE_SHA,
    candidateSha: CANDIDATE_SHA,
    chunkCount: 219,
    columnCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns,
    contractSha256: CONTRACT_SHA,
    expectedEnvironment: "permanent-staging",
    foreignKeyCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys,
    keyRangesSha256: "6".repeat(64),
    kind: "pint-path-postgres-migration-receipt",
    manifestSha256: MANIFEST_SHA,
    operatorIdSha256: OPERATOR_ID_SHA,
    planSha256: MIGRATION_PLAN_SHA,
    rowCount: 435,
    runBindingSha256,
    runIdSha256,
    schemaMetadataSha256: sha256PostgresMigrationReadyMetadata(ready),
    sourceSchemaFingerprint: SOURCE_SCHEMA_FINGERPRINT,
    sourceSnapshotSha256: SOURCE_SNAPSHOT_SHA,
    stateTotalsSha256: "8".repeat(64),
    status: "ready",
    tableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables,
    tableSetSha256: "5".repeat(64),
    targetDdlSha256: TARGET_DDL_SHA,
    targetIdentitySha256,
    targetUrlSha256: TARGET_URL_SHA,
    transformedDataSha256: "7".repeat(64),
    verifierIdSha256: VERIFIER_ID_SHA,
    version: 1,
    zeroRowTableCount: 8,
  });
  return { ready, receipt, runBindingSha256, runIdSha256 };
}

function receiptFileSha256(receipt: PostgresMigrationReceipt): string {
  return sha256PostgresReviewedPricePromotionValue(receipt);
}

function refinalizeReceipt(
  receipt: PostgresMigrationReceipt,
  patch: Partial<PostgresMigrationReceiptWithoutHash>,
): PostgresMigrationReceipt {
  const { receiptSha256: _receiptSha256, ...withoutHash } = receipt;
  return finalizePostgresMigrationReceipt({ ...withoutHash, ...patch });
}

function wrongPriceRow(
  status: string,
  overrides: Readonly<Record<string, unknown>> = {},
): QueryResultRow {
  const terminal = status === "resolved" || status === "rejected";
  return {
    assignedTo: null,
    beerName: "Carlton Draught",
    createdAt: NOW,
    id: `wrong-price-${status}`,
    notes: "PRIVATE_WRONG_PRICE_NOTE",
    priceRecordId: null,
    reason: "price_changed",
    resolutionNote: terminal ? "Reviewed by operator" : null,
    resolvedAt: terminal ? NOW : null,
    resolvedBy: terminal ? "reviewer-1" : null,
    sourcePhotoUrl: "https://private.example.test/photo.jpg?token=PRIVATE",
    status,
    updatedAt: NOW,
    venueId: VENUE_ID,
    ...overrides,
  };
}

function fixture(): {
  database: FakeSqlDatabase;
  input: BuildPostgresReviewedPricePromotionPlanInput;
  migrationTargetIdentity: PostgresMigrationTargetIdentity;
  privateInput: Record<string, unknown>;
  readyMetadata: PostgresMigrationReadyMetadata;
  receipt: PostgresMigrationReceipt;
  rows: Record<QueryTag, QueryResultRow[]>;
} {
  const identity = safeIdentityRow();
  const historicalIdentity = migrationTargetIdentity();
  const authority = canonicalReceipt(historicalIdentity);
  const metadata = metadataRows(authority.ready);
  const privateInput = {
    itemCount: 1,
    items: [{
      evidenceContentSha256: EVIDENCE_CONTENT_SHA,
      evidenceReferenceSha256: sha256PostgresReviewedPricePromotionIdentity(
        "evidence-reference",
        `source-ingestion:${INGESTION_ID}`,
      ),
      sourceIngestionId: INGESTION_ID,
      venueIdSha256: sha256PostgresReviewedPricePromotionIdentity("venue-id", VENUE_ID),
    }],
    kind: POSTGRES_REVIEWED_PRICE_PROMOTION_PRIVATE_INPUT_KIND,
    marketedSuburb: "Fitzroy",
    version: 1,
  };
  const rows: Record<QueryTag, QueryResultRow[]> = {
    catalog: [{
      abv: 4.6,
      alias: "Carlton Draught",
      aliasKey: "carlton_draught",
      brewery: "Carlton & United",
      itemKey: "carlton_draught",
      itemName: "Carlton Draught",
      source: "system_catalog",
      status: "active",
      style: "Lager",
      updatedAt: NOW,
    }],
    identity: [identity],
    metadata,
    "migration-run": [{
      approvalReferenceSha256: APPROVAL_REFERENCE_SHA,
      candidateSha: CANDIDATE_SHA,
      completedAt: NOW,
      contractSha256: CONTRACT_SHA,
      expectedEnvironment: "permanent-staging",
      failureCode: null,
      manifestSha256: MANIFEST_SHA,
      operatorIdSha256: OPERATOR_ID_SHA,
      receiptSha256: authority.receipt.receiptSha256,
      runId: authority.runIdSha256,
      sourceSchemaFingerprint: SOURCE_SCHEMA_FINGERPRINT,
      sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
      sourceSnapshotSha256: SOURCE_SNAPSHOT_SHA,
      startedAt: NOW,
      status: "ready",
      targetBindingSha256: authority.runBindingSha256,
      targetDdlSha256: TARGET_DDL_SHA,
      verifierIdSha256: VERIFIER_ID_SHA,
    }],
    profiles: [{
      active: true,
      address: "123 Private Street",
      area: "inner-north",
      name: "Fixture Hotel",
      suburb: "Fitzroy",
      updatedAt: NOW,
      venueId: VENUE_ID,
    }],
    "price-conflicts": [{ present: false }],
    queue: [{
      capturedNotes: "PRIVATE_QUEUE_NOTE",
      createdAt: NOW,
      extractedBeersJson: JSON.stringify([sourceBeer()]),
      id: INGESTION_ID,
      imageRedactedAt: null,
      imageRedactionReason: null,
      imageRetentionExpiresAt: null,
      note: "Reviewed ordinary drinks menu.",
      overallConfidence: 0.93,
      publishedAt: null,
      rejectedAt: null,
      reviewBeersJson: null,
      reviewClaimToken: null,
      reviewClaimedAt: null,
      sourceType: "source_reference",
      sourceUrl: "https://menu.example.test/drinks/menu.pdf?token=PRIVATE_SOURCE_TOKEN",
      status: "pending_review",
      updatedAt: NOW,
      venueId: VENUE_ID,
      venueName: "Fixture Hotel",
      venueNameGuess: "Fixture Hotel",
    }],
    "venue-beer-conflicts": [{ present: false }],
    "wrong-prices": [],
  };
  const database = new FakeSqlDatabase("postgres", rows);
  const input: BuildPostgresReviewedPricePromotionPlanInput = {
    candidateSha: CANDIDATE_SHA,
    database,
    expectedDeployment: {
      deploymentIdSha256: digest("deployment"),
      environmentIdSha256: digest("environment"),
      imageDigestSha256: digest("image"),
      projectIdSha256: digest("project"),
      serviceIdSha256: digest("service"),
    },
    expectedEnvironment: "permanent-staging",
    expectedMigration: {
      receiptFileSha256: receiptFileSha256(authority.receipt),
    },
    migrationReceipt: authority.receipt,
    migrationTargetIdentity: historicalIdentity,
    expectedPrivateInputSha256: sha256PostgresReviewedPricePromotionValue(privateInput),
    expectedTargetIdentitySha256: targetIdentitySha256(identity),
    privateInput,
  };
  return {
    database,
    input,
    migrationTargetIdentity: historicalIdentity,
    privateInput,
    readyMetadata: authority.ready,
    receipt: authority.receipt,
    rows,
  };
}

async function expectPlanError(
  input: BuildPostgresReviewedPricePromotionPlanInput,
  code: PostgresReviewedPricePromotionPlanError["code"],
): Promise<void> {
  await expect(buildPostgresReviewedPricePromotionPlanCandidate(input)).rejects.toMatchObject({
    code,
    name: "PostgresReviewedPricePromotionPlanError",
  });
}

function inputWithReceipt(
  target: ReturnType<typeof fixture>,
  receipt: PostgresMigrationReceipt,
): BuildPostgresReviewedPricePromotionPlanInput {
  target.rows["migration-run"][0]!.receiptSha256 = receipt.receiptSha256;
  return {
    ...target.input,
    expectedMigration: { receiptFileSha256: receiptFileSha256(receipt) },
    migrationReceipt: receipt,
  };
}

function eventFor(database: FakeSqlDatabase, tag: QueryTag): DatabaseEvent {
  const event = database.events.find((candidate) => (
    candidate.method !== "exec" && queryTag(candidate.sql) === tag
  ));
  if (!event) throw new Error(`missing_event:${tag}`);
  return event;
}

describe("Postgres reviewed-price no-write plan candidate", () => {
  it("rejects a non-Postgres database before opening a transaction", async () => {
    const target = fixture();
    const sqlite = new FakeSqlDatabase("sqlite", target.rows);
    await expectPlanError({ ...target.input, database: sqlite }, "not_postgres");
    expect(sqlite.transactionCount).toBe(0);
    expect(sqlite.events).toEqual([]);
  });

  it("hardens the transaction before identity inspection and exposes no mutation seam", async () => {
    const target = fixture();
    const plan = await buildPostgresReviewedPricePromotionPlanCandidate(target.input);

    expect(target.database.transactionCount).toBe(1);
    expect(target.database.events[0]).toEqual({
      bindings: [],
      method: "exec",
      sql: POSTGRES_REVIEWED_PRICE_PROMOTION_READ_ONLY_TRANSACTION,
    });
    expect(target.database.events[1]).toEqual({
      bindings: [],
      method: "exec",
      sql: POSTGRES_REVIEWED_PRICE_PROMOTION_SEARCH_PATH,
    });
    expect(target.database.events[2]).toEqual({
      bindings: [],
      method: "exec",
      sql: POSTGRES_REVIEWED_PRICE_PROMOTION_ROW_SECURITY,
    });
    expect(target.database.events[3]).toMatchObject({ method: "get" });
    expect(queryTag(target.database.events[3]!.sql)).toBe("identity");
    expect(target.database.events.filter((event) => event.method === "run")).toEqual([]);
    expect(target.database.events.filter((event) => event.method === "exec")).toHaveLength(3);
    expect(plan.mutationEnabled).toBe(false);
    expect(plan.activationBlockers).toEqual(POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS);
    expect(plan.sourceSnapshot.publicConflicts).toMatchObject({
      priceRecordCount: 0,
      venueBeerCount: 0,
    });
  });

  it("requires the exact canonical PUBLIC and planner-only RLS policy inventory", () => {
    const identitySql = POSTGRES_REVIEWED_PRICE_PROMOTION_IDENTITY_QUERY
      .replace(/\s+/g, " ")
      .trim();
    const logicalBackupExpression = LOGICAL_BACKUP_SELECT_POLICY_EXPRESSION
      .replace(/\s+/g, " ");

    expect(identitySql).toContain(
      "WHERE policy.polrelid = relation.oid "
      + "AND (0::oid = ANY(policy.polroles) OR planner.oid = ANY(policy.polroles)) "
      + ") <> 2",
    );
    expect(identitySql).toContain(
      "policy.polname = relation.planner_policy_name "
      + "AND policy.polcmd = 'r' "
      + "AND policy.polpermissive "
      + "AND policy.polroles = ARRAY[planner.oid]::oid[] "
      + "AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) = 'true' "
      + "AND policy.polwithcheck IS NULL",
    );
    expect(identitySql).toContain(
      "policy.polname = (relation.relname || '_logical_backup_select')::name "
      + "AND policy.polcmd = 'r' "
      + "AND policy.polpermissive "
      + "AND policy.polroles = ARRAY[0]::oid[] "
      + "AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, false) "
      + `= $pintpath_policy$${logicalBackupExpression}$pintpath_policy$ `
      + "AND policy.polwithcheck IS NULL",
    );
  });

  it.each([
    ["a missing logical-backup policy", canonicalPolicyInventory().slice(0, 1)],
    ["a renamed logical-backup policy", canonicalPolicyInventory().map((policy, index) => (
      index === 1 ? { ...policy, name: "schema_metadata_logical_backup_select_renamed" } : policy
    ))],
    ["a wrong logical-backup expression", canonicalPolicyInventory().map((policy, index) => (
      index === 1 ? { ...policy, usingExpression: "true" } : policy
    ))],
    ["a third applicable policy", [
      ...canonicalPolicyInventory(),
      {
        command: "r",
        name: "schema_metadata_unexpected_select",
        permissive: true,
        roles: [0],
        usingExpression: "true",
        withCheckExpression: null,
      },
    ]],
  ] satisfies ReadonlyArray<readonly [string, readonly PolicyInventoryRow[]]>)(
    "rejects %s in the required relation policy inventory",
    (_description, policies) => {
      expect(policyInventoryPassesIdentityGuard(
        "schema_metadata",
        "schema_metadata_reviewed_price_planner_select",
        policies,
      )).toBe(false);
    },
  );

  it("accepts only the two canonical policies in the unit policy model", () => {
    expect(policyInventoryPassesIdentityGuard(
      "schema_metadata",
      "schema_metadata_reviewed_price_planner_select",
      canonicalPolicyInventory(),
    )).toBe(true);
  });

  it("rejects unsafe roles and an exact catalog identity mismatch", async () => {
    const unsafe = fixture();
    unsafe.rows.identity[0]!.roleAuthorityValid = false;
    await expectPlanError(unsafe.input, "role_unsafe");

    const mismatch = fixture();
    await expectPlanError({
      ...mismatch.input,
      expectedTargetIdentitySha256: digest("wrong-target"),
    }, "identity_mismatch");
  });

  it("rejects environment, candidate, ready-run, receipt, target-binding, and metadata drift", async () => {
    const environment = fixture();
    await expectPlanError({
      ...environment.input,
      expectedEnvironment: "production",
    }, "environment_mismatch");

    const candidate = fixture();
    await expectPlanError({
      ...candidate.input,
      candidateSha: "d".repeat(40),
    }, "migration_mismatch");

    const receipt = fixture();
    await expectPlanError({
      ...receipt.input,
      expectedMigration: {
        receiptFileSha256: digest("wrong-receipt-file"),
      },
    }, "migration_mismatch");

    const binding = fixture();
    binding.rows["migration-run"][0]!.targetBindingSha256 = digest("changed-binding");
    await expectPlanError(binding.input, "migration_mismatch");

    const metadata = fixture();
    metadata.rows.metadata[0]!.value = "importing";
    await expectPlanError(metadata.input, "migration_mismatch");

    const chronology = fixture();
    chronology.rows["migration-run"][0]!.completedAt = "2026-08-10T23:59:59.999Z";
    await expectPlanError(chronology.input, "migration_mismatch");
  });

  it("hashes only the exact ten ready-metadata fields committed by the receipt", async () => {
    const target = fixture();
    const fullMetadata = metadataObject(target.rows.metadata);
    const readyHash = sha256PostgresMigrationReadyMetadata(target.readyMetadata);
    const twelveRowHash = sha256PostgresReviewedPricePromotionValue(fullMetadata);

    expect(Object.keys(target.readyMetadata)).toHaveLength(10);
    expect(Object.keys(fullMetadata)).toHaveLength(12);
    expect(target.receipt.schemaMetadataSha256).toBe(readyHash);
    expect(readyHash).not.toBe(twelveRowHash);

    const wrongDomainReceipt = refinalizeReceipt(target.receipt, {
      schemaMetadataSha256: twelveRowHash,
    });
    await expectPlanError(
      inputWithReceipt(target, wrongDomainReceipt),
      "migration_mismatch",
    );
  });

  it("distinguishes the internal receipt hash from the canonical full-file hash", async () => {
    const target = fixture();
    const { receiptSha256, ...withoutReceiptSha256 } = target.receipt;
    const fileSha256 = receiptFileSha256(target.receipt);

    expect(postgresMigrationReceiptSchema.parse(target.receipt)).toEqual(target.receipt);
    expect(receiptSha256).toBe(sha256PostgresReviewedPricePromotionValue(withoutReceiptSha256));
    expect(fileSha256).not.toBe(receiptSha256);

    await expectPlanError({
      ...target.input,
      expectedMigration: { receiptFileSha256: receiptSha256 },
    }, "migration_mismatch");
    expect(target.database.transactionCount).toBe(0);

    const tampered = { ...target.receipt, planSha256: digest("tampered-plan") };
    await expectPlanError({
      ...target.input,
      expectedMigration: {
        receiptFileSha256: sha256PostgresReviewedPricePromotionValue(tampered),
      },
      migrationReceipt: tampered,
    }, "migration_mismatch");
    expect(target.database.transactionCount).toBe(0);

    await expectPlanError({
      ...target.input,
      migrationReceipt: { ...target.receipt, unexpected: true },
    }, "migration_mismatch");

    expect(() => finalizePostgresMigrationReceipt({
      ...withoutReceiptSha256,
      chunkCount: withoutReceiptSha256.rowCount + 1,
    })).toThrow();
  });

  it("recomputes the exact migration binding and domain-separated run id", async () => {
    const target = fixture();
    const receipt = target.receipt;
    const expectedBinding = sha256PostgresMigrationRunBinding({
      approvalReferenceSha256: receipt.approvalReferenceSha256,
      candidateSha: receipt.candidateSha,
      contractSha256: receipt.contractSha256,
      expectedEnvironment: receipt.expectedEnvironment,
      manifestSha256: receipt.manifestSha256,
      operatorIdSha256: receipt.operatorIdSha256,
      planSha256: receipt.planSha256,
      sourceSchemaFingerprint: receipt.sourceSchemaFingerprint,
      sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
      sourceSnapshotSha256: receipt.sourceSnapshotSha256,
      targetDdlSha256: receipt.targetDdlSha256,
      targetIdentitySha256: receipt.targetIdentitySha256,
      targetUrlSha256: receipt.targetUrlSha256,
      verifierIdSha256: receipt.verifierIdSha256,
    });
    expect(receipt.runBindingSha256).toBe(expectedBinding);
    expect(receipt.runIdSha256).toBe(derivePostgresMigrationRunId(expectedBinding));

    const forgedBindingTarget = fixture();
    const forgedBinding = digest("forged-binding");
    const forgedBindingReceipt = refinalizeReceipt(forgedBindingTarget.receipt, {
      runBindingSha256: forgedBinding,
    });
    forgedBindingTarget.rows["migration-run"][0]!.targetBindingSha256 = forgedBinding;
    await expectPlanError(
      inputWithReceipt(forgedBindingTarget, forgedBindingReceipt),
      "migration_mismatch",
    );

    const forgedRunTarget = fixture();
    const forgedRunId = digest("forged-run-id");
    const forgedReady = buildPostgresMigrationReadyMetadata({
      ...forgedRunTarget.readyMetadata,
      migration_run_sha256: forgedRunId,
    });
    const forgedRunReceipt = refinalizeReceipt(forgedRunTarget.receipt, {
      runIdSha256: forgedRunId,
      schemaMetadataSha256: sha256PostgresMigrationReadyMetadata(forgedReady),
    });
    forgedRunTarget.rows["migration-run"][0]!.runId = forgedRunId;
    const runMetadata = forgedRunTarget.rows.metadata.find(
      (row) => row.key === "migration_run_sha256",
    )!;
    runMetadata.value = forgedRunId;
    await expectPlanError(
      inputWithReceipt(forgedRunTarget, forgedRunReceipt),
      "migration_mismatch",
    );
  });

  it("accepts a historical migrator identity while binding the live planner identity separately", async () => {
    const target = fixture();
    const liveIdentity = target.rows.identity[0]!;
    const plan = await buildPostgresReviewedPricePromotionPlanCandidate(target.input);

    expect(target.migrationTargetIdentity.currentUser).toBe("pintpath_migration_operator");
    expect(liveIdentity.currentUser).toBe("pintpath_reviewed_price_planner");
    expect(target.receipt.targetIdentitySha256).toBe(
      sha256PostgresMigrationTargetIdentity(target.migrationTargetIdentity),
    );
    expect(target.receipt.targetIdentitySha256).not.toBe(targetIdentitySha256(liveIdentity));
    expect(plan.target.identitySha256).toBe(targetIdentitySha256(liveIdentity));
  });

  it("rejects a receipt transplanted onto a different physical database identity", async () => {
    const target = fixture();
    target.rows.identity[0]!.databaseOid = "24576";
    const changedLiveIdentitySha256 = targetIdentitySha256(target.rows.identity[0]!);

    await expectPlanError({
      ...target.input,
      expectedTargetIdentitySha256: changedLiveIdentitySha256,
    }, "migration_mismatch");
  });

  it("contains raw receipt and binding parser failures behind static migration errors", async () => {
    const invalidVersion = fixture();
    invalidVersion.rows["migration-run"][0]!.sourceSchemaVersion = 15;
    await expectPlanError(invalidVersion.input, "migration_mismatch");

    const poisoned = fixture();
    const rawMessage = "PRIVATE_RAW_RECEIPT_GETTER";
    const migrationReceipt = new Proxy({}, {
      get() {
        throw new Error(rawMessage);
      },
    });
    const error = await buildPostgresReviewedPricePromotionPlanCandidate({
      ...poisoned.input,
      migrationReceipt,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostgresReviewedPricePromotionPlanError);
    expect(error).toMatchObject({ code: "migration_mismatch" });
    expect(String(error)).not.toContain(rawMessage);
  });

  it("rejects noncanonical or mismatched private input before trusting source rows", async () => {
    const wrongHash = fixture();
    await expectPlanError({
      ...wrongHash.input,
      expectedPrivateInputSha256: digest("wrong-private-input"),
    }, "private_input_mismatch");
    expect(wrongHash.database.transactionCount).toBe(0);

    const venueMismatch = fixture();
    const privateInput = venueMismatch.privateInput;
    const items = privateInput.items as Array<Record<string, unknown>>;
    items[0]!.venueIdSha256 = digest("wrong-venue");
    await expectPlanError({
      ...venueMismatch.input,
      expectedPrivateInputSha256: sha256PostgresReviewedPricePromotionValue(privateInput),
    }, "private_input_mismatch");
  });

  it("rejects stale or ineligible source, venue, catalog, and public-conflict snapshots", async () => {
    const source = fixture();
    source.rows.queue[0]!.status = "publishing";
    await expectPlanError(source.input, "source_mismatch");

    const profile = fixture();
    profile.rows.profiles[0]!.suburb = "Carlton";
    await expectPlanError(profile.input, "source_mismatch");

    const catalog = fixture();
    catalog.rows.catalog[0]!.status = "pending_review";
    await expectPlanError(catalog.input, "catalog_mismatch");

    const conflict = fixture();
    conflict.rows["price-conflicts"][0]!.present = true;
    await expectPlanError(conflict.input, "public_conflict");
  });

  it.each(["open", "in_progress"])(
    "conservatively rejects a %s wrong-price report for an affected venue",
    async (status) => {
      const target = fixture();
      target.rows["wrong-prices"].push(wrongPriceRow(status));
      await expectPlanError(target.input, "wrong_price_open");
    },
  );

  it("rejects unknown wrong-price states and inconsistent terminal authority", async () => {
    const unknown = fixture();
    unknown.rows["wrong-prices"].push(wrongPriceRow("closed"));
    await expectPlanError(unknown.input, "inspection_invalid");

    const terminalWithoutAuthority = fixture();
    terminalWithoutAuthority.rows["wrong-prices"].push(wrongPriceRow("resolved", {
      resolvedAt: null,
      resolvedBy: null,
    }));
    await expectPlanError(terminalWithoutAuthority.input, "inspection_invalid");

    const openWithTerminalAuthority = fixture();
    openWithTerminalAuthority.rows["wrong-prices"].push(wrongPriceRow("open", {
      resolvedAt: NOW,
      resolvedBy: "reviewer-1",
    }));
    await expectPlanError(openWithTerminalAuthority.input, "inspection_invalid");

    const openWithOnlyResolvedAt = fixture();
    openWithOnlyResolvedAt.rows["wrong-prices"].push(wrongPriceRow("open", {
      resolvedAt: NOW,
      resolvedBy: null,
    }));
    await expectPlanError(openWithOnlyResolvedAt.input, "inspection_invalid");

    const inProgressWithOnlyResolvedBy = fixture();
    inProgressWithOnlyResolvedBy.rows["wrong-prices"].push(wrongPriceRow("in_progress", {
      resolvedAt: null,
      resolvedBy: "reviewer-1",
    }));
    await expectPlanError(inProgressWithOnlyResolvedBy.input, "inspection_invalid");
  });

  it("counts only valid resolved and rejected wrong-price terminal records", async () => {
    const target = fixture();
    target.rows["wrong-prices"].push(
      wrongPriceRow("resolved"),
      wrongPriceRow("rejected", { id: "wrong-price-rejected" }),
    );
    const plan = await buildPostgresReviewedPricePromotionPlanCandidate(target.input);

    expect(plan.sourceSnapshot.wrongPriceReports).toMatchObject({
      openOrInProgressCount: 0,
      rejectedCount: 1,
      resolvedCount: 1,
      totalCount: 2,
    });
  });

  it("uses bounded array queries and exact presence-only conflict checks", async () => {
    const target = fixture();
    await buildPostgresReviewedPricePromotionPlanCandidate(target.input);

    expect(eventFor(target.database, "metadata").sql).toMatch(/LIMIT 13/);
    expect(eventFor(target.database, "migration-run").sql).toMatch(/LIMIT 2/);
    expect(eventFor(target.database, "queue").sql).toMatch(/LIMIT 51/);
    expect(eventFor(target.database, "profiles").sql).toMatch(/LIMIT 51/);
    expect(eventFor(target.database, "catalog").sql).toMatch(/LIMIT 5001/);
    expect(eventFor(target.database, "wrong-prices").sql).toMatch(/LIMIT 1001/);
    expect(eventFor(target.database, "price-conflicts")).toMatchObject({
      bindings: [
        [INGESTION_ID],
        [VENUE_ID],
        ["admin_verified", "venue_confirmed", "photo_verified", "community_confirmed"],
      ],
      method: "get",
    });
    expect(eventFor(target.database, "venue-beer-conflicts")).toMatchObject({
      bindings: [[VENUE_ID]],
      method: "get",
    });
    expect(eventFor(target.database, "price-conflicts").sql).toContain("SELECT EXISTS");
    expect(eventFor(target.database, "venue-beer-conflicts").sql).toContain("SELECT EXISTS");
    expect(eventFor(target.database, "queue").bindings).toEqual([[INGESTION_ID]]);
    expect(eventFor(target.database, "profiles").bindings).toEqual([[VENUE_ID]]);
    expect(eventFor(target.database, "catalog").bindings).toEqual([["carlton_draught"]]);
    expect(eventFor(target.database, "wrong-prices").bindings).toEqual([[VENUE_ID]]);
  });

  it("fails closed at the source JSON and wrong-price row caps", async () => {
    const tooManySourceRows = fixture();
    tooManySourceRows.rows.queue[0]!.extractedBeersJson = JSON.stringify(
      Array.from({ length: 101 }, () => sourceBeer()),
    );
    await expectPlanError(tooManySourceRows.input, "source_mismatch");

    const oversizedSourceJson = fixture();
    oversizedSourceJson.rows.queue[0]!.extractedBeersJson = JSON.stringify([{
      ...sourceBeer(),
      notes: "x".repeat(262_144),
    }]);
    await expectPlanError(oversizedSourceJson.input, "source_mismatch");

    const tooManyWrongPrices = fixture();
    tooManyWrongPrices.rows["wrong-prices"] = Array.from(
      { length: 1_001 },
      (_, index) => wrongPriceRow("resolved", { id: `wrong-price-${index}` }),
    );
    await expectPlanError(tooManyWrongPrices.input, "inspection_invalid");

    const malformedPresence = fixture();
    malformedPresence.rows["price-conflicts"] = [{ present: "false" }];
    await expectPlanError(malformedPresence.input, "inspection_invalid");
  });

  it("fails closed when any bounded query returns its truncation sentinel", async () => {
    const metadata = fixture();
    metadata.rows.metadata.push({ key: "unexpected_metadata", value: "unexpected" });
    expect(metadata.rows.metadata).toHaveLength(13);
    await expectPlanError(metadata.input, "migration_mismatch");

    const migrationRuns = fixture();
    migrationRuns.rows["migration-run"].push({ ...migrationRuns.rows["migration-run"][0] });
    expect(migrationRuns.rows["migration-run"]).toHaveLength(2);
    await expectPlanError(migrationRuns.input, "migration_mismatch");

    const queues = fixture();
    queues.rows.queue = Array.from({ length: 51 }, () => ({ ...queues.rows.queue[0] }));
    await expectPlanError(queues.input, "source_mismatch");

    const profiles = fixture();
    profiles.rows.profiles = Array.from(
      { length: 51 },
      () => ({ ...profiles.rows.profiles[0] }),
    );
    await expectPlanError(profiles.input, "source_mismatch");

    const catalog = fixture();
    catalog.rows.catalog = Array.from(
      { length: 5_001 },
      () => ({ ...catalog.rows.catalog[0] }),
    );
    await expectPlanError(catalog.input, "catalog_mismatch");
  });

  it("rejects sparse, augmented, and non-exact database result shapes", async () => {
    const sparse = fixture();
    sparse.rows["wrong-prices"] = new Array<QueryResultRow>(1);
    await expectPlanError(sparse.input, "inspection_invalid");

    const augmentedArray = fixture();
    Object.defineProperty(augmentedArray.rows["wrong-prices"], "unexpected", {
      enumerable: true,
      value: true,
    });
    await expectPlanError(augmentedArray.input, "inspection_invalid");

    const augmentedPresence = fixture();
    augmentedPresence.rows["venue-beer-conflicts"] = [{
      present: false,
      unexpected: true,
    }];
    await expectPlanError(augmentedPresence.input, "inspection_invalid");
  });

  it("binds expected deployment hashes and changes the candidate when deployment changes", async () => {
    const first = fixture();
    const second = fixture();
    const secondInput = {
      ...second.input,
      expectedDeployment: {
        ...second.input.expectedDeployment,
        deploymentIdSha256: digest("other-deployment"),
      },
    };
    const firstPlan = await buildPostgresReviewedPricePromotionPlanCandidate(first.input);
    const secondPlan = await buildPostgresReviewedPricePromotionPlanCandidate(secondInput);

    expect(firstPlan.expectedDeployment).toEqual(first.input.expectedDeployment);
    expect(secondPlan.expectedDeployment).toEqual(secondInput.expectedDeployment);
    expect(secondPlan.planCandidateSha256).not.toBe(firstPlan.planCandidateSha256);
  });

  it("emits a deterministic, strict, canonical candidate without raw URLs or private values", async () => {
    const first = fixture();
    const second = fixture();
    const firstPlan = await buildPostgresReviewedPricePromotionPlanCandidate(first.input);
    const secondPlan = await buildPostgresReviewedPricePromotionPlanCandidate(second.input);

    expect(firstPlan).toEqual(secondPlan);
    expect(canonicalPostgresReviewedPricePromotionJson(firstPlan)).toEqual(
      canonicalPostgresReviewedPricePromotionJson(secondPlan),
    );
    expect(firstPlan.target.identitySha256).toBe(targetIdentitySha256(first.rows.identity[0]!));
    expect(firstPlan.sourceSnapshot.combinedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(firstPlan.sourceSnapshot.selectionPolicySha256).toBe(REVIEWED_PRICE_SELECTION_POLICY_SHA256);
    expect(firstPlan.planCandidateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(firstPlan.migration.receiptSha256).toBe(first.receipt.receiptSha256);
    expect(firstPlan.migration.receiptFileSha256).toBe(receiptFileSha256(first.receipt));
    expect(postgresReviewedPricePromotionPlanCandidateSchema.safeParse(firstPlan).success).toBe(true);
    expect(postgresReviewedPricePromotionPlanCandidateSchema.safeParse({
      ...firstPlan,
      unexpected: true,
    }).success).toBe(false);
    expect(postgresReviewedPricePromotionPlanCandidateSchema.safeParse({
      ...firstPlan,
      mutationEnabled: true,
    }).success).toBe(false);
    expect(postgresReviewedPricePromotionPlanCandidateSchema.safeParse({
      ...firstPlan,
      planCandidateSha256: digest("tampered"),
    }).success).toBe(false);

    const serialized = canonicalPostgresReviewedPricePromotionJson(firstPlan).toString("utf8");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain("PRIVATE_");
    expect(serialized).not.toContain("123 Private Street");
    expect(serialized).not.toContain("pintpath_reviewed_price_planner");
  });

  it("freezes the v16 schema, selection policy, and canonical receipt hash chain", () => {
    const target = fixture();

    expect(SOURCE_SCHEMA_VERSION).toBe(16);
    expect(SOURCE_SCHEMA_FINGERPRINT).toBe(FROZEN_SOURCE_SCHEMA_FINGERPRINT);
    expect(CONTRACT_SHA).toBe(FROZEN_CONTRACT_SHA);
    expect(POSTGRES_MIGRATION_CONTRACT.expectedCounts).toMatchObject({
      columns: 717,
      foreignKeys: 76,
      tables: 56,
    });
    expect(POSTGRES_REVIEWED_PRICE_PROMOTION_SOURCE_SCHEMA_SHA256).toBe(
      FROZEN_SOURCE_SCHEMA_SHA,
    );
    expect(REVIEWED_PRICE_SELECTION_POLICY_SHA256).toBe(FROZEN_SELECTION_POLICY_SHA);
    expect(sha256PostgresMigrationTargetIdentity(target.migrationTargetIdentity)).toBe(
      FROZEN_TARGET_IDENTITY_SHA,
    );
    expect(target.rows["migration-run"][0]!.targetBindingSha256).toBe(
      FROZEN_RUN_BINDING_SHA,
    );
    expect(target.rows["migration-run"][0]!.runId).toBe(FROZEN_RUN_ID_SHA);
    expect(target.receipt.schemaMetadataSha256).toBe(FROZEN_READY_METADATA_SHA);
    expect(target.receipt.receiptSha256).toBe(FROZEN_INTERNAL_RECEIPT_SHA);
    expect(receiptFileSha256(target.receipt)).toBe(FROZEN_RECEIPT_FILE_SHA);
  });
});
