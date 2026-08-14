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
import { sha256PostgresDatabaseIdentity } from "../src/lib/postgres-database-identity.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_VERSION,
  POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_MODE,
  POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_MODE,
  postgresReviewedPricePromotionAuthorityBundleSchema,
  postgresReviewedPricePromotionReviewPacketSchema,
} from "../src/lib/postgres-reviewed-price-promotion-authority.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
  POSTGRES_REVIEWED_PRICE_PROMOTION_IDENTITY_QUERY,
  POSTGRES_REVIEWED_PRICE_PROMOTION_PRIVATE_INPUT_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_PRIVATE_INPUT_VERSION,
  POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_VERSION,
  POSTGRES_REVIEWED_PRICE_PROMOTION_READ_ONLY_TRANSACTION,
  POSTGRES_REVIEWED_PRICE_PROMOTION_ROW_SECURITY,
  POSTGRES_REVIEWED_PRICE_PROMOTION_SEARCH_PATH,
  POSTGRES_REVIEWED_PRICE_PROMOTION_SOURCE_SCHEMA_SHA256,
  PostgresReviewedPricePromotionPlanError,
  buildPostgresReviewedPricePromotionPlanArtifacts,
  buildPostgresReviewedPricePromotionPlanCandidate,
  canonicalPostgresReviewedPricePromotionJson,
  postgresReviewedPricePromotionPlanCandidateSchema,
  sha256PostgresReviewedPricePromotionIdentity,
  sha256PostgresReviewedPricePromotionValue,
  type BuildPostgresReviewedPricePromotionPlanInput,
} from "../src/lib/postgres-reviewed-price-promotion-plan.js";
import { REVIEWED_PRICE_SELECTION_POLICY_SHA256 } from "../src/lib/reviewed-price-selection-policy.js";
import {
  REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES,
  REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256,
} from "../src/lib/reviewed-price-wrong-price-policy.js";

const INGESTION_ID = "11111111-1111-4111-8111-111111111111";
const VENUE_ID = "22222222-2222-4222-8222-222222222222";
const CANDIDATE_SHA = "c".repeat(40);
const MIGRATION_PLAN_SHA = "4".repeat(64);
const SOURCE_SNAPSHOT_SHA = "7".repeat(64);
const MANIFEST_SHA = "9".repeat(64);
const TARGET_DDL_SHA = "a".repeat(64);
const EVIDENCE_CONTENT_SHA = "b".repeat(64);
const NOW = "2026-08-11T00:00:00.000Z";
const AUTHORITY_EXPIRES_AT = "2026-08-11T01:00:00.000Z";
const CONTRACT_SHA = sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT);
const SOURCE_SCHEMA_FINGERPRINT = POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint;
const SOURCE_SCHEMA_VERSION = POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion;
const APPROVAL_REFERENCE_SHA = "1".repeat(64);
const OPERATOR_ID_SHA = "2".repeat(64);
const VERIFIER_ID_SHA = "3".repeat(64);
const VERIFIER_AUTHORITY_SHA = "e".repeat(64);
const VERIFIER_AUTHORITY_POLICY_SHA = "f".repeat(64);
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
  "03fbdaa72703644204677e36f2aaacfdb4be913cccbec8f612245bb5f99f3bb8";
const FROZEN_RUN_ID_SHA =
  "05a70c823831b8236d0acb264b7d47c7210183a7b365cb414c5845e116e0dea5";
const FROZEN_READY_METADATA_SHA =
  "33f4b18f5ff02efb2517d4fbf55489acb404c31fa4fd86a82b3997064a6c13f2";
const FROZEN_INTERNAL_RECEIPT_SHA =
  "225d8870121cf97cfeffc622371b8f2d9cae43a46d0572006b96288e6c6ee299";
const FROZEN_RECEIPT_FILE_SHA =
  "20aec9c417388909f7d1a2542736e4142a008e16dc57901e0c189b982e634177";
const PLANNER_ROLE_OID = 16_385;
const PHYSICAL_IDENTITY_DRIFT_CASES = [
  ["systemIdentifier", "7521976435570874595"],
  ["databaseOid", "24576"],
  ["databaseName", "railway_clone"],
  ["serverVersionNum", "170007"],
] as const;
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
  onRead: ((tag: QueryTag) => void) | null = null;
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
        this.onRead?.(tag);
        return this.rows[tag][0] as Row | undefined;
      },
      all: async <Row extends QueryResultRow = QueryResultRow>(
        ...bindings: unknown[]
      ): Promise<Row[]> => {
        this.events.push({ bindings, method: "all", sql });
        this.onRead?.(tag);
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
    live_schema_sha256: "a".repeat(64),
  });
}

function metadataRows(ready: PostgresMigrationReadyMetadata): QueryResultRow[] {
  return [
    ["import_state", ready.import_state],
    ["live_schema_sha256", ready.live_schema_sha256],
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

function plannerLoginIdentitySha256(identity: QueryResultRow): string {
  return sha256PostgresMigrationTargetIdentity({
    currentUser: identity.currentUser,
    databaseName: identity.databaseName,
    databaseOid: identity.databaseOid,
    serverVersionNum: identity.serverVersionNum,
    sessionUser: identity.sessionUser,
    systemIdentifier: identity.systemIdentifier,
  });
}

function physicalIdentitySha256(identity: {
  readonly databaseName: unknown;
  readonly databaseOid: unknown;
  readonly serverVersionNum: unknown;
  readonly systemIdentifier: unknown;
}): string {
  return sha256PostgresDatabaseIdentity({
    databaseName: String(identity.databaseName),
    databaseOid: String(identity.databaseOid),
    serverVersionNum: String(identity.serverVersionNum),
    systemIdentifier: String(identity.systemIdentifier),
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
    liveSchemaSha256: "a".repeat(64),
    transportAuthoritySha256: "9".repeat(64),
    targetUrlSha256: TARGET_URL_SHA,
    verifierIdSha256: VERIFIER_ID_SHA,
    verifierAuthoritySha256: VERIFIER_AUTHORITY_SHA,
    verifierAuthorityPolicySha256: VERIFIER_AUTHORITY_POLICY_SHA,
    verifierPublicKeySha256: "b".repeat(64),
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
    liveSchemaSha256: "a".repeat(64),
    targetIdentitySha256,
    transportAuthoritySha256: "9".repeat(64),
    targetUrlSha256: TARGET_URL_SHA,
    transformedDataSha256: "7".repeat(64),
    verifierIdSha256: VERIFIER_ID_SHA,
    verifierAuthoritySha256: VERIFIER_AUTHORITY_SHA,
    verifierAuthorityPolicySha256: VERIFIER_AUTHORITY_POLICY_SHA,
    verifierPublicKeySha256: "b".repeat(64),
    applyReceiptSha256: "c".repeat(64),
    verificationApprovalFileSha256: "d".repeat(64),
    verifiedAt: "2026-08-08T00:00:00.000Z",
    version: 3,
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
    version: POSTGRES_REVIEWED_PRICE_PROMOTION_PRIVATE_INPUT_VERSION,
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
  const expectedDeployment = {
    attestationFileSha256: digest("deployment-attestation-file"),
    attestationPolicySha256: digest("deployment-attestation-policy"),
    deploymentIdSha256: digest("deployment"),
    environmentIdSha256: digest("environment"),
    imageDigestSha256: digest("image"),
    projectIdSha256: digest("project"),
    serviceIdSha256: digest("service"),
  };
  const privateInputSha256 = sha256PostgresReviewedPricePromotionValue(privateInput);
  const expectedPhysicalDatabaseIdentitySha256 = physicalIdentitySha256(identity);
  const authorityBundle = {
    authorityMode: POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_MODE,
    candidateSha: CANDIDATE_SHA,
    evidenceReferences: {
      privateEvidenceManifestSha256: digest("private-evidence-manifest"),
      restoreReceiptSha256: digest("evidence-restore-receipt"),
      retrievalReceiptSha256: digest("evidence-retrieval-receipt"),
      storageSnapshotManifestSha256: digest("storage-snapshot-manifest"),
      wormManifestSha256: digest("evidence-worm-manifest"),
    },
    expectedEnvironment: "permanent-staging" as const,
    expiresAt: AUTHORITY_EXPIRES_AT,
    generatedAt: NOW,
    kind: POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_KIND,
    mutationAuthorized: false as const,
    privateInputManifestSha256: privateInputSha256,
    providerAuthorityObserved: false as const,
    recoveryReferences: {
      accountDeletionRecoveryManifestSha256: digest("account-deletion-recovery"),
      logicalBackupManifestSha256: digest("logical-backup-manifest"),
      pitrAttestationSha256: digest("pitr-attestation"),
      privateStorageRecoveryManifestSha256: digest("private-storage-recovery"),
      restoreReceiptSha256: digest("recovery-restore-receipt"),
      wormManifestSha256: digest("recovery-worm-manifest"),
    },
    reviewBindings: {
      approvalArtifactSha256: digest("approval-artifact"),
      approvalReferenceSha256: digest("promotion-approval-reference"),
      cryptographicApprovalVerified: false as const,
      operatorIdSha256: digest("promotion-operator"),
      reviewMode: POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_MODE,
      reviewerIdSha256: digest("promotion-reviewer"),
      trustRootPolicySha256: digest("approval-trust-root-policy"),
    },
    targetProfile: {
      deploymentAttestationFileSha256: expectedDeployment.attestationFileSha256,
      physicalDatabaseIdentitySha256: expectedPhysicalDatabaseIdentitySha256,
      railwayEnvironmentIdSha256: expectedDeployment.environmentIdSha256,
      railwayProjectIdSha256: expectedDeployment.projectIdSha256,
      railwayServiceIdSha256: expectedDeployment.serviceIdSha256,
      supabaseProjectIdentitySha256: digest("supabase-project-identity"),
    },
    version: POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_VERSION,
  };
  expect(postgresReviewedPricePromotionAuthorityBundleSchema.safeParse(
    authorityBundle,
  ).success).toBe(true);
  const input: BuildPostgresReviewedPricePromotionPlanInput = {
    authorityBundle,
    candidateSha: CANDIDATE_SHA,
    database,
    expectedDeployment,
    expectedEnvironment: "permanent-staging",
    expectedAuthorityBundleSha256:
      sha256PostgresReviewedPricePromotionValue(authorityBundle),
    expectedMigration: {
      receiptFileSha256: receiptFileSha256(authority.receipt),
    },
    migrationReceipt: authority.receipt,
    migrationTargetIdentity: historicalIdentity,
    expectedPrivateInputSha256: privateInputSha256,
    expectedPhysicalDatabaseIdentitySha256,
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

function rebindAuthority(
  input: BuildPostgresReviewedPricePromotionPlanInput,
): BuildPostgresReviewedPricePromotionPlanInput {
  const current = postgresReviewedPricePromotionAuthorityBundleSchema.parse(
    input.authorityBundle,
  );
  const authorityBundle = {
    ...current,
    candidateSha: input.candidateSha,
    expectedEnvironment: input.expectedEnvironment,
    privateInputManifestSha256: input.expectedPrivateInputSha256,
    targetProfile: {
      ...current.targetProfile,
      deploymentAttestationFileSha256:
        input.expectedDeployment.attestationFileSha256,
      physicalDatabaseIdentitySha256:
        input.expectedPhysicalDatabaseIdentitySha256,
      railwayEnvironmentIdSha256: input.expectedDeployment.environmentIdSha256,
      railwayProjectIdSha256: input.expectedDeployment.projectIdSha256,
      railwayServiceIdSha256: input.expectedDeployment.serviceIdSha256,
    },
  };
  return {
    ...input,
    authorityBundle,
    expectedAuthorityBundleSha256:
      sha256PostgresReviewedPricePromotionValue(authorityBundle),
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
    expect(plan.activationBlockers).toHaveLength(7);
    expect(plan.activationBlockers).not.toContain(
      "role_neutral_migration_target_identity_authority",
    );
    expect(plan.activationBlockers).toContain(
      "dedicated_read_only_planner_role_and_complete_acl_rls_visibility",
    );
    expect(plan.activationBlockers).not.toContain(
      "exact_wrong_price_severity_semantics",
    );
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
    await expectPlanError(rebindAuthority({
      ...mismatch.input,
      expectedPhysicalDatabaseIdentitySha256: digest("wrong-target"),
    }), "identity_mismatch");
  });

  it("rejects environment, candidate, ready-run, receipt, target-binding, and metadata drift", async () => {
    const environment = fixture();
    await expectPlanError(rebindAuthority({
      ...environment.input,
      expectedEnvironment: "production",
    }), "environment_mismatch");

    const candidate = fixture();
    await expectPlanError(rebindAuthority({
      ...candidate.input,
      candidateSha: "d".repeat(40),
    }), "migration_mismatch");

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

  it("hashes only the exact eleven ready-metadata fields committed by the receipt", async () => {
    const target = fixture();
    const fullMetadata = metadataObject(target.rows.metadata);
    const readyHash = sha256PostgresMigrationReadyMetadata(target.readyMetadata);
    const twelveRowHash = sha256PostgresReviewedPricePromotionValue(fullMetadata);

    expect(Object.keys(target.readyMetadata)).toHaveLength(11);
    expect(Object.keys(fullMetadata)).toHaveLength(13);
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
      liveSchemaSha256: receipt.liveSchemaSha256,
      transportAuthoritySha256: receipt.transportAuthoritySha256,
      targetUrlSha256: receipt.targetUrlSha256,
      verifierIdSha256: receipt.verifierIdSha256,
      verifierAuthoritySha256: receipt.verifierAuthoritySha256,
      verifierAuthorityPolicySha256: receipt.verifierAuthorityPolicySha256,
      verifierPublicKeySha256: receipt.verifierPublicKeySha256,
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
    expect(target.receipt.targetIdentitySha256).not.toBe(
      plannerLoginIdentitySha256(liveIdentity),
    );
    expect(plan.target.plannerLoginIdentitySha256).toBe(
      plannerLoginIdentitySha256(liveIdentity),
    );
    expect(plan.target.physicalIdentitySha256).toBe(
      physicalIdentitySha256(target.migrationTargetIdentity),
    );
    expect(plan.target.physicalIdentitySha256).toBe(physicalIdentitySha256(liveIdentity));
    expect(plan.target.physicalIdentitySha256).toBe(
      target.input.expectedPhysicalDatabaseIdentitySha256,
    );
  });

  it.each(PHYSICAL_IDENTITY_DRIFT_CASES)(
    "rejects historical %s drift from the live and expected physical identity",
    async (field, changedValue) => {
      const target = fixture();
      await expectPlanError({
        ...target.input,
        migrationTargetIdentity: {
          ...target.migrationTargetIdentity,
          [field]: changedValue,
        },
      }, "identity_mismatch");
    },
  );

  it.each(PHYSICAL_IDENTITY_DRIFT_CASES)(
    "rejects live %s drift from the historical and expected physical identity",
    async (field, changedValue) => {
      const target = fixture();
      target.rows.identity[0]![field] = changedValue;
      await expectPlanError(target.input, "identity_mismatch");
    },
  );

  it.each(PHYSICAL_IDENTITY_DRIFT_CASES)(
    "rejects expected %s drift from the historical and live physical identity",
    async (field, changedValue) => {
      const target = fixture();
      const changedExpectedIdentity = {
        ...target.migrationTargetIdentity,
        [field]: changedValue,
      };
      await expectPlanError(rebindAuthority({
        ...target.input,
        expectedPhysicalDatabaseIdentitySha256:
          physicalIdentitySha256(changedExpectedIdentity),
      }), "identity_mismatch");
    },
  );

  it("maps historical and live physical-identity parser failures to fixed errors", async () => {
    const historical = fixture();
    await expectPlanError({
      ...historical.input,
      migrationTargetIdentity: {
        ...historical.migrationTargetIdentity,
        databaseName: "d".repeat(64),
      },
    }, "argument_invalid");
    expect(historical.database.transactionCount).toBe(0);

    const live = fixture();
    live.rows.identity[0]!.databaseName = "d".repeat(64);
    await expectPlanError(live.input, "identity_mismatch");
    expect(live.database.transactionCount).toBe(1);
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
    await expectPlanError(rebindAuthority({
      ...wrongHash.input,
      expectedPrivateInputSha256: digest("wrong-private-input"),
    }), "private_input_mismatch");
    expect(wrongHash.database.transactionCount).toBe(0);

    const venueMismatch = fixture();
    const privateInput = venueMismatch.privateInput;
    const items = privateInput.items as Array<Record<string, unknown>>;
    items[0]!.venueIdSha256 = digest("wrong-venue");
    await expectPlanError(rebindAuthority({
      ...venueMismatch.input,
      expectedPrivateInputSha256: sha256PostgresReviewedPricePromotionValue(privateInput),
    }), "private_input_mismatch");
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

  it("bounds inspected confidence to 0..1 and catalog ABV to 0..25", async () => {
    for (const confidence of [1.01, "1.01", `0.${"1".repeat(31)}`]) {
      const target = fixture();
      target.rows.queue[0]!.overallConfidence = confidence;
      await expectPlanError(target.input, "source_mismatch");
    }
    for (const abv of [25.01, "25.01", "-1", `0.${"1".repeat(31)}`]) {
      const target = fixture();
      target.rows.catalog[0]!.abv = abv;
      await expectPlanError(target.input, "catalog_mismatch");
    }
    const maximum = fixture();
    maximum.rows.queue[0]!.overallConfidence = "1.000";
    maximum.rows.catalog[0]!.abv = "25.000";
    await expect(buildPostgresReviewedPricePromotionPlanCandidate(maximum.input))
      .resolves.toBeDefined();
  });

  it.each(["open", "in_progress"])(
    "conservatively rejects a %s wrong-price report for an affected venue",
    async (status) => {
      const target = fixture();
      target.rows["wrong-prices"].push(wrongPriceRow(status));
      await expectPlanError(target.input, "wrong_price_open");
    },
  );

  it("rejects persistent collection intrinsic replacement before it can bypass authority", async () => {
    const filterTarget = fixture();
    filterTarget.rows["wrong-prices"].push(wrongPriceRow("open"));
    const originalFilter = Array.prototype.filter;
    let filterCalls = 0;
    filterTarget.database.onRead = (tag) => {
      if (tag !== "wrong-prices" || Array.prototype.filter !== originalFilter) return;
      Array.prototype.filter = function poisonedFilter(
        this: unknown[],
        predicate: (value: unknown, index: number, array: unknown[]) => unknown,
      ): unknown[] {
        filterCalls += 1;
        if (this.length === 1 && (this[0] as { status?: unknown } | undefined)?.status === "open") {
          return [];
        }
        return Reflect.apply(originalFilter, this, [predicate]) as unknown[];
      } as typeof Array.prototype.filter;
    };
    let filterFailure: unknown;
    try {
      await buildPostgresReviewedPricePromotionPlanCandidate(filterTarget.input);
    } catch (error) {
      filterFailure = error;
    } finally {
      Array.prototype.filter = originalFilter;
    }
    expect(filterCalls).toBe(0);
    expect(filterFailure).toMatchObject({ code: "inspection_invalid" });

    const mapTarget = fixture();
    const originalMapGet = Map.prototype.get;
    let mapGetCalls = 0;
    mapTarget.database.onRead = (tag) => {
      if (tag !== "queue" || Map.prototype.get !== originalMapGet) return;
      Map.prototype.get = function poisonedMapGet<Key, Value>(
        this: Map<Key, Value>,
        key: Key,
      ): Value | undefined {
        mapGetCalls += 1;
        return Reflect.apply(originalMapGet, this, [key]) as Value | undefined;
      } as typeof Map.prototype.get;
    };
    let mapFailure: unknown;
    try {
      await buildPostgresReviewedPricePromotionPlanCandidate(mapTarget.input);
    } catch (error) {
      mapFailure = error;
    } finally {
      Map.prototype.get = originalMapGet;
    }
    expect(mapGetCalls).toBe(0);
    expect(mapFailure).toMatchObject({ code: "source_mismatch" });
  });

  it("keeps source selection pinned when a late URL constructor tries a self-restoring poison", async () => {
    const target = fixture();
    target.rows.queue[0]!.sourceUrl = "https://example.test/about";
    const originalUrl = globalThis.URL;
    const originalFilter = Array.prototype.filter;
    const safeUrl = new originalUrl("https://safe.example.test/menu.pdf");
    let proxyInstalled = false;
    let constructCalls = 0;
    let targetedFilterCalls = 0;
    target.database.onRead = (tag) => {
      if (tag !== "queue" || proxyInstalled) return;
      proxyInstalled = true;
      globalThis.URL = new Proxy(originalUrl, {
        construct() {
          constructCalls += 1;
          Array.prototype.filter = function poisonedFilter(
            this: unknown[],
            predicate: (value: unknown, index: number, array: unknown[]) => unknown,
          ): unknown[] {
            targetedFilterCalls += 1;
            Array.prototype.filter = originalFilter;
            if (
              this.length === 1
              && typeof this[0] === "object"
              && this[0] !== null
              && "priceNumeric" in this[0]
            ) return [this[0]];
            return Reflect.apply(originalFilter, this, [predicate]) as unknown[];
          } as typeof Array.prototype.filter;
          return safeUrl;
        },
      }) as typeof URL;
    };

    let failure: unknown;
    try {
      await buildPostgresReviewedPricePromotionPlanCandidate(target.input);
    } catch (error) {
      failure = error;
    } finally {
      globalThis.URL = originalUrl;
      Array.prototype.filter = originalFilter;
    }
    expect(proxyInstalled).toBe(true);
    expect(constructCalls).toBe(0);
    expect(targetedFilterCalls).toBe(0);
    expect(failure).toMatchObject({ code: "source_mismatch" });
  });

  it("rejects unknown wrong-price states and inconsistent terminal timestamps", async () => {
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

  it("accepts privacy-anonymized terminal wrong-price authority", async () => {
    const target = fixture();
    target.rows["wrong-prices"].push(
      wrongPriceRow("resolved", {
        resolutionNote: null,
        resolvedBy: null,
      }),
      wrongPriceRow("rejected", {
        id: "wrong-price-rejected-anonymized",
        resolutionNote: null,
        resolvedBy: null,
      }),
    );

    const plan = await buildPostgresReviewedPricePromotionPlanCandidate(target.input);

    expect(plan.sourceSnapshot.wrongPriceReports).toMatchObject({
      blockingCount: 0,
      openOrInProgressCount: 0,
      rejectedCount: 1,
      resolvedCount: 1,
      totalCount: 2,
    });
  });

  it("counts only valid resolved and rejected wrong-price terminal records", async () => {
    const target = fixture();
    target.rows["wrong-prices"].push(
      wrongPriceRow("resolved"),
      wrongPriceRow("rejected", { id: "wrong-price-rejected" }),
    );
    const plan = await buildPostgresReviewedPricePromotionPlanCandidate(target.input);

    expect(plan.sourceSnapshot.wrongPriceReports).toMatchObject({
      blockingCount: 0,
      blockingStatuses: REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES,
      openOrInProgressCount: 0,
      policySha256: REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256,
      rejectedCount: 1,
      resolvedCount: 1,
      totalCount: 2,
    });
  });

  it("uses bounded array queries and exact presence-only conflict checks", async () => {
    const target = fixture();
    await buildPostgresReviewedPricePromotionPlanCandidate(target.input);

    expect(eventFor(target.database, "metadata").sql).toMatch(/LIMIT 14/);
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
    expect(metadata.rows.metadata).toHaveLength(14);
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

  it("binds the deployment attestation and changes the candidate on authority drift", async () => {
    for (const field of [
      "attestationFileSha256",
      "attestationPolicySha256",
      "deploymentIdSha256",
    ] as const) {
      const first = fixture();
      const second = fixture();
      const secondInput = rebindAuthority({
        ...second.input,
        expectedDeployment: {
          ...second.input.expectedDeployment,
          [field]: digest(`other-${field}`),
        },
      });
      const firstPlan = await buildPostgresReviewedPricePromotionPlanCandidate(first.input);
      const secondPlan = await buildPostgresReviewedPricePromotionPlanCandidate(secondInput);

      expect(firstPlan.expectedDeployment).toEqual(first.input.expectedDeployment);
      expect(secondPlan.expectedDeployment).toEqual(secondInput.expectedDeployment);
      expect(secondPlan.planCandidateSha256).not.toBe(firstPlan.planCandidateSha256);
    }
  });

  it("requires the exact offline authority bundle without treating it as live approval", async () => {
    const wrongHash = fixture();
    await expectPlanError({
      ...wrongHash.input,
      expectedAuthorityBundleSha256: digest("wrong-authority-bundle"),
    }, "authority_mismatch");
    expect(wrongHash.database.transactionCount).toBe(0);

    const targetDrift = fixture();
    const authorityBundle = {
      ...(targetDrift.input.authorityBundle as Record<string, unknown>),
      targetProfile: {
        ...((targetDrift.input.authorityBundle as Record<string, unknown>)
          .targetProfile as Record<string, unknown>),
        supabaseProjectIdentitySha256: digest("different-supabase-project"),
      },
    };
    const first = await buildPostgresReviewedPricePromotionPlanCandidate(targetDrift.input);
    const secondTarget = fixture();
    const second = await buildPostgresReviewedPricePromotionPlanCandidate({
      ...secondTarget.input,
      authorityBundle,
      expectedAuthorityBundleSha256:
        sha256PostgresReviewedPricePromotionValue(authorityBundle),
    });
    expect(first.authority.authorityMode).toBe("offline-plan-bindings-only");
    expect(first.authority.mutationAuthorized).toBe(false);
    expect(first.authority.providerAuthorityObserved).toBe(false);
    expect(second.authority.supabaseProjectIdentitySha256)
      .toBe(digest("different-supabase-project"));
    expect(second.planCandidateSha256).not.toBe(first.planCandidateSha256);
  });

  it("emits a separate exact-row private review packet and binds it into the public plan", async () => {
    const target = fixture();
    const { plan, reviewPacket } =
      await buildPostgresReviewedPricePromotionPlanArtifacts(target.input);

    expect(postgresReviewedPricePromotionReviewPacketSchema.safeParse(
      reviewPacket,
    ).success).toBe(true);
    expect(reviewPacket).toMatchObject({
      itemCount: 1,
      marketedSuburb: "Fitzroy",
      mutationEnabled: false,
      rowCount: 1,
      targetPhysicalIdentitySha256: plan.target.physicalIdentitySha256,
      temporalPolicy: "single-apply-transaction-timestamp",
      wrongPricePolicySha256: REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256,
    });
    expect(reviewPacket.items[0]).toMatchObject({
      evidenceContentSha256: EVIDENCE_CONTENT_SHA,
      evidenceReference: `source-ingestion:${INGESTION_ID}`,
      sourceIngestionId: INGESTION_ID,
      venue: {
        address: "123 Private Street",
        id: VENUE_ID,
        name: "Fixture Hotel",
        suburb: "Fitzroy",
      },
    });
    expect(reviewPacket.items[0]!.rows[0]).toEqual({
      ordinal: 0,
      priceRecord: {
        beerName: "Carlton Draught",
        confidence: "admin_verified",
        happyHourDetails: null,
        id: `source-ingestion:${INGESTION_ID}:0`,
        isHappyHourPrice: false,
        isOnTap: "yes",
        normalizedBeerId: "carlton_draught",
        price: 13.5,
        servingSize: "pint",
        sourceEvidenceReference: `source-ingestion:${INGESTION_ID}`,
        sourceIngestionId: INGESTION_ID,
        sourceSubmissionId: null,
        sourceType: "source_ingestion",
        suburb: "Fitzroy",
        venueId: VENUE_ID,
        venueName: "Fixture Hotel",
      },
      venueBeer: {
        abv: "4.6",
        beerName: "Carlton Draught",
        brewery: "Carlton & United",
        currency: "AUD",
        id: `admin-reviewed:${VENUE_ID}:carlton-draught:pint`,
        inStock: true,
        normalizedBeerId: "carlton_draught",
        notes: "Published from admin source review.",
        onTap: true,
        price: 13.5,
        serveSize: "pint",
        sourceIngestionId: INGESTION_ID,
        style: "Lager",
        venueId: VENUE_ID,
      },
    });
    expect(plan.reviewPacket).toEqual({
      itemCount: 1,
      reviewPacketCandidateSha256: reviewPacket.reviewPacketCandidateSha256,
      rowCount: 1,
    });

    const publicPlan = canonicalPostgresReviewedPricePromotionJson(plan).toString("utf8");
    const privatePacket = canonicalPostgresReviewedPricePromotionJson(reviewPacket)
      .toString("utf8");
    expect(publicPlan).not.toContain("123 Private Street");
    expect(privatePacket).toContain("123 Private Street");
    expect(privatePacket).toContain("Carlton Draught");
    expect(privatePacket).not.toContain("PRIVATE_QUEUE_NOTE");
    expect(privatePacket).not.toContain("PRIVATE_SOURCE_TOKEN");
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
    expect(firstPlan.version).toBe(POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_VERSION);
    expect(firstPlan.version).toBe(4);
    expect(firstPlan.target.physicalIdentitySha256).toBe(
      physicalIdentitySha256(first.rows.identity[0]!),
    );
    expect(firstPlan.target.plannerLoginIdentitySha256).toBe(
      plannerLoginIdentitySha256(first.rows.identity[0]!),
    );
    expect(Object.keys(firstPlan.target).sort()).toEqual([
      "catalogIdentity",
      "physicalIdentitySha256",
      "plannerLoginIdentitySha256",
    ]);
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
      version: 1,
    }).success).toBe(false);
    expect(postgresReviewedPricePromotionPlanCandidateSchema.safeParse({
      ...firstPlan,
      target: {
        ...firstPlan.target,
        identitySha256: plannerLoginIdentitySha256(first.rows.identity[0]!),
      },
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

  it("keeps validation, canonical bytes, and hashes pinned after JSON intrinsic replacement", async () => {
    const target = fixture();
    const cleanPlan = await buildPostgresReviewedPricePromotionPlanCandidate(target.input);
    const cleanBytes = canonicalPostgresReviewedPricePromotionJson(cleanPlan);
    const cleanHash = sha256PostgresReviewedPricePromotionValue(cleanPlan);
    const { planCandidateSha256: _cleanPlanCandidateSha256, ...cleanWithoutHash } = cleanPlan;
    const forgedWithoutHash = {
      ...cleanWithoutHash,
      candidateSha: "d".repeat(40),
      expectedDeployment: {
        ...cleanWithoutHash.expectedDeployment,
        serviceIdSha256: "8".repeat(64),
      },
    };
    const forgedPlan = {
      ...forgedWithoutHash,
      planCandidateSha256: sha256PostgresReviewedPricePromotionValue(forgedWithoutHash),
    };
    const forgedWithoutHashText = canonicalPostgresReviewedPricePromotionJson(
      forgedWithoutHash,
    ).toString("utf8").slice(0, -1);
    const forgedPlanText = canonicalPostgresReviewedPricePromotionJson(
      forgedPlan,
    ).toString("utf8").slice(0, -1);
    const originalStringify = JSON.stringify;
    const originalToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    let matchedPoison = 0;
    let inheritedToJsonCalls = 0;
    let parsedUnderPoison: ReturnType<
      typeof postgresReviewedPricePromotionPlanCandidateSchema.safeParse
    > | null = null;
    let bytesUnderPoison: Buffer | null = null;
    let hashUnderPoison: string | null = null;
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value: () => {
          inheritedToJsonCalls += 1;
          return forgedPlan;
        },
      });
      JSON.stringify = ((value: unknown, replacer?: unknown, space?: unknown): string => {
        if (
          value
          && typeof value === "object"
          && (value as { kind?: unknown }).kind === POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_KIND
        ) {
          matchedPoison += 1;
          return Object.hasOwn(value, "planCandidateSha256")
            ? forgedPlanText
            : forgedWithoutHashText;
        }
        return Reflect.apply(originalStringify, JSON, [value, replacer, space]) as string;
      }) as typeof JSON.stringify;
      parsedUnderPoison = postgresReviewedPricePromotionPlanCandidateSchema.safeParse(cleanPlan);
      bytesUnderPoison = canonicalPostgresReviewedPricePromotionJson(cleanPlan);
      hashUnderPoison = sha256PostgresReviewedPricePromotionValue(cleanPlan);
    } finally {
      JSON.stringify = originalStringify;
      if (originalToJson) {
        Object.defineProperty(Object.prototype, "toJSON", originalToJson);
      } else {
        Reflect.deleteProperty(Object.prototype, "toJSON");
      }
    }

    expect(matchedPoison).toBe(0);
    expect(inheritedToJsonCalls).toBe(0);
    expect(parsedUnderPoison?.success).toBe(true);
    expect(bytesUnderPoison).toEqual(cleanBytes);
    expect(hashUnderPoison).toBe(cleanHash);
    expect(bytesUnderPoison).not.toEqual(Buffer.from(`${forgedPlanText}\n`, "utf8"));

    const unsafeIdentity = fixture();
    unsafeIdentity.rows.identity[0]!.searchPathSchemas = ["public"];
    let identityPoisonInstalled = false;
    unsafeIdentity.database.onRead = (tag) => {
      if (tag !== "identity" || identityPoisonInstalled) return;
      identityPoisonInstalled = true;
      JSON.stringify = (() => "[\"pg_catalog\"]") as typeof JSON.stringify;
    };
    let failure: unknown;
    try {
      await buildPostgresReviewedPricePromotionPlanCandidate(unsafeIdentity.input);
    } catch (error) {
      failure = error;
    } finally {
      JSON.stringify = originalStringify;
    }
    expect(identityPoisonInstalled).toBe(true);
    expect(failure).toMatchObject({ code: "inspection_invalid" });
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
