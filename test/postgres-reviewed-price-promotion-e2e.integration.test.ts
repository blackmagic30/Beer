import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  postgresReviewedPricePromotionOperatorInternals,
} from "../scripts/postgres-reviewed-price-promotion-operator.js";
import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "../src/db/postgres-migration-schema.js";
import { sha256PostgresDatabaseIdentity } from
  "../src/lib/postgres-database-identity.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_VERSION,
  finalizePostgresReviewedPricePromotionReviewPacket,
  type PostgresReviewedPricePromotionReviewPacket,
} from "../src/lib/postgres-reviewed-price-promotion-authority.js";
import {
  POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_KIND,
  POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_PAYLOAD_KIND,
  POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_VERSION,
  postgresReviewedPriceOperationApprovalPayloadSchema,
  postgresReviewedPriceOperationAuthorizationResponseSchema,
  postgresReviewedPriceOperationDatabaseResponseSchema,
  postgresReviewedPriceDeploymentBindingSha256,
  postgresReviewedPriceEvidenceAuthoritySha256,
  sha256PostgresReviewedPriceOperatorLogin,
  sha256PostgresReviewedPriceReviewerLogin,
  validatePostgresReviewedPriceOperationArtifacts,
  type PostgresReviewedPriceOperationRequest,
  type PostgresReviewedPriceOperationReceipt,
} from "../src/lib/postgres-reviewed-price-promotion-operation.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
  POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_VERSION,
  postgresReviewedPricePromotionPlanCandidateSchema,
  sha256PostgresReviewedPricePromotionIdentity,
  sha256PostgresReviewedPricePromotionValue,
  type PostgresReviewedPricePromotionPlanCandidate,
} from "../src/lib/postgres-reviewed-price-promotion-plan.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_REVIEWED_PRICE_KERNEL_TEST_ADMIN_URL";
const REQUIRED_ENV = "PINTPATH_POSTGRES_REVIEWED_PRICE_KERNEL_TEST_REQUIRED";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const configuredRequired = process.env[REQUIRED_ENV]?.trim() ?? "";

if (configuredRequired !== "" && configuredRequired !== "true") {
  throw new Error(`${REQUIRED_ENV} must be true when set.`);
}
if (configuredRequired === "true" && !configuredAdminUrl) {
  throw new Error(`${ADMIN_URL_ENV} is mandatory when ${REQUIRED_ENV}=true.`);
}

const suffix = crypto.randomBytes(6).toString("hex");
const databaseName = `pintpath_promotion_e2e_${suffix}`;
const reviewerLogin = `pintpath_e2e_reviewer_${suffix}`;
const operatorLogin = `pintpath_e2e_operator_${suffix}`;
const password = `PintpathE2e-${suffix}-Password`;
const candidateSha = "c".repeat(40);
const sqlFiles = [
  "src/db/postgres-schema.sql",
  "supabase/migrations/20260810003612_add_pintpath_logical_backup_role.sql",
  "supabase/migrations/20260812022314_add_inert_reviewed_price_promotion_kernel.sql",
  "supabase/migrations/20260812235959_add_privacy_maintenance_role.sql",
  "supabase/migrations/20260813000000_activate_reviewed_price_promotion_kernel.sql",
] as const;

const SUCCESS_SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const SUCCESS_VENUE_ID = "22222222-2222-4222-8222-222222222222";
const MISSING_SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const MISSING_VENUE_ID = "44444444-4444-4444-8444-444444444444";
const ROLLBACK_SOURCE_ID = "55555555-5555-4555-8555-555555555555";
const ROLLBACK_VENUE_ID = "66666666-6666-4666-8666-666666666666";

interface FixtureRow {
  readonly beerName: string;
  readonly brewery: string;
  readonly normalizedBeerId: string;
  readonly price: number;
  readonly style: string;
}

interface SourceFixture {
  readonly label: string;
  readonly rows: readonly FixtureRow[];
  readonly sourceIngestionId: string;
  readonly venueId: string;
  readonly venueName: string;
}

interface PromotionArtifacts {
  readonly packet: PostgresReviewedPricePromotionReviewPacket;
  readonly packetBytes: Buffer;
  readonly plan: PostgresReviewedPricePromotionPlanCandidate;
  readonly planBytes: Buffer;
}

interface SignedOperation {
  readonly request: PostgresReviewedPriceOperationRequest;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("unsafe_test_identifier");
  }
  return `"${value}"`;
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
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      url.hostname.toLowerCase(),
    )
    || decodeURIComponent(url.pathname.slice(1)) !== "postgres"
    || !url.username
    || url.searchParams.get("sslmode") !== "disable"
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")
    || url.hash
    || /[\r\n\0]/.test(value)
  ) {
    throw new Error(`${ADMIN_URL_ENV} must target a disposable loopback PG17 database.`);
  }
  return url;
}

function withDatabase(url: URL, database: string): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  return result.toString();
}

function loginUrl(adminUrl: URL, role: string): string {
  const result = new URL(withDatabase(adminUrl, databaseName));
  result.username = role;
  result.password = password;
  return result.toString();
}

function digest(label: string): string {
  return sha256PostgresMigrationBytes(`pintpath-reviewed-price-e2e:${label}`);
}

function priceRecordId(fixture: SourceFixture, ordinal: number): string {
  return `source-ingestion:${fixture.sourceIngestionId}:${ordinal}`;
}

function venueBeerId(fixture: SourceFixture, row: FixtureRow): string {
  return `admin-reviewed:${fixture.venueId}:${row.normalizedBeerId}:pint`;
}

function buildArtifacts(
  fixture: SourceFixture,
  physicalIdentitySha256: string,
  serverVersionNum: string,
): PromotionArtifacts {
  const generatedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 55 * 60_000).toISOString();
  const authorityBundleSha256 = digest(`${fixture.label}:authority-bundle`);
  const targetProfileSha256 = digest(`${fixture.label}:target-profile`);
  const sourceWithoutCombined = {
    items: [{
      catalogRowsSha256: digest(`${fixture.label}:catalog-rows`),
      queueSnapshotSha256: digest(`${fixture.label}:queue-snapshot`),
      selectedRowCount: fixture.rows.length,
      selectedRowsSha256: digest(`${fixture.label}:selected-rows`),
      sourceIngestionId: fixture.sourceIngestionId,
      venueIdSha256: sha256PostgresReviewedPricePromotionIdentity(
        "venue-id",
        fixture.venueId,
      ),
      venueProfileSha256: digest(`${fixture.label}:venue-profile`),
    }],
    publicConflicts: {
      priceRecordCount: 0,
      rowsSha256: sha256PostgresReviewedPricePromotionValue([]),
      venueBeerCount: 0,
    },
    selectionPolicySha256: digest(`${fixture.label}:selection-policy`),
    wrongPriceReports: {
      blockingCount: 0,
      blockingStatuses: ["in_progress", "open"] as const,
      openOrInProgressCount: 0,
      policySha256: digest(`${fixture.label}:wrong-price-policy`),
      rejectedCount: 0,
      resolvedCount: 0,
      rowsSha256: sha256PostgresReviewedPricePromotionValue([]),
      totalCount: 0,
    },
  };
  const sourceSnapshot = {
    ...sourceWithoutCombined,
    combinedSha256: sha256PostgresReviewedPricePromotionValue(
      sourceWithoutCombined,
    ),
  };
  const packet = finalizePostgresReviewedPricePromotionReviewPacket({
    authorityBundleSha256,
    candidateSha,
    expectedEnvironment: "permanent-staging",
    expiresAt,
    generatedAt,
    itemCount: 1,
    items: [{
      evidenceContentSha256: digest(`${fixture.label}:evidence-content`),
      evidenceReference: `source-ingestion:${fixture.sourceIngestionId}`,
      evidenceReferenceSha256: sha256PostgresReviewedPricePromotionIdentity(
        "evidence-reference",
        `source-ingestion:${fixture.sourceIngestionId}`,
      ),
      rows: fixture.rows.map((row, ordinal) => ({
        ordinal,
        priceRecord: {
          beerName: row.beerName,
          confidence: "admin_verified" as const,
          happyHourDetails: null,
          id: priceRecordId(fixture, ordinal),
          isHappyHourPrice: false as const,
          isOnTap: "yes" as const,
          normalizedBeerId: row.normalizedBeerId,
          price: row.price,
          servingSize: "pint" as const,
          sourceEvidenceReference: `source-ingestion:${fixture.sourceIngestionId}`,
          sourceIngestionId: fixture.sourceIngestionId,
          sourceSubmissionId: null,
          sourceType: "source_ingestion" as const,
          suburb: "Fitzroy",
          venueId: fixture.venueId,
          venueName: fixture.venueName,
        },
        venueBeer: {
          abv: "4.5",
          beerName: row.beerName,
          brewery: row.brewery,
          currency: "AUD" as const,
          id: venueBeerId(fixture, row),
          inStock: true as const,
          normalizedBeerId: row.normalizedBeerId,
          notes: "Published from admin source review." as const,
          onTap: true as const,
          price: row.price,
          serveSize: "pint" as const,
          sourceIngestionId: fixture.sourceIngestionId,
          style: row.style,
          venueId: fixture.venueId,
        },
      })),
      sourceIngestionId: fixture.sourceIngestionId,
      venue: {
        address: "123 Private Street",
        area: "inner-north",
        id: fixture.venueId,
        name: fixture.venueName,
        suburb: "Fitzroy",
      },
    }],
    kind: POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_KIND,
    marketedSuburb: "Fitzroy",
    mutationEnabled: false,
    privateInputManifestSha256: digest(`${fixture.label}:private-input`),
    rowCount: fixture.rows.length,
    sourceSnapshotSha256: sourceSnapshot.combinedSha256,
    targetPhysicalIdentitySha256: physicalIdentitySha256,
    targetProfileSha256,
    temporalPolicy: "single-apply-transaction-timestamp",
    version: POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_VERSION,
    wrongPricePolicySha256: sourceSnapshot.wrongPriceReports.policySha256,
  });
  const runId = digest(`${fixture.label}:migration-run`);
  const planWithoutHash = {
    activationBlockers: POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
    authority: {
      authorityBundleSha256,
      authorityMode: "offline-plan-bindings-only" as const,
      evidenceReferencesSha256: digest(`${fixture.label}:evidence-references`),
      expiresAt,
      generatedAt,
      mutationAuthorized: false as const,
      providerAuthorityObserved: false as const,
      recoveryReferencesSha256: digest(`${fixture.label}:recovery-references`),
      reviewBindingsSha256: digest(`${fixture.label}:review-bindings`),
      supabaseProjectIdentitySha256: digest(`${fixture.label}:supabase-project`),
      targetProfileSha256,
    },
    candidateSha,
    expectedDeployment: {
      attestationFileSha256: digest(`${fixture.label}:attestation-file`),
      attestationPolicySha256: digest(`${fixture.label}:attestation-policy`),
      deploymentIdSha256: digest(`${fixture.label}:deployment`),
      environmentIdSha256: digest(`${fixture.label}:environment`),
      imageDigestSha256: digest(`${fixture.label}:image`),
      projectIdSha256: digest(`${fixture.label}:project`),
      serviceIdSha256: digest(`${fixture.label}:service`),
    },
    expectedEnvironment: "permanent-staging" as const,
    kind: POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_KIND,
    migration: {
      approvalReferenceSha256: digest(`${fixture.label}:migration-approval`),
      completedAt: generatedAt,
      contractSha256: digest(`${fixture.label}:migration-contract`),
      manifestSha256: digest(`${fixture.label}:migration-manifest`),
      operatorIdSha256: digest(`${fixture.label}:migration-operator`),
      planSha256: digest(`${fixture.label}:migration-plan`),
      receiptFileSha256: digest(`${fixture.label}:migration-receipt-file`),
      receiptSha256: digest(`${fixture.label}:migration-receipt`),
      runId,
      runSnapshotSha256: digest(`${fixture.label}:migration-run-snapshot`),
      schemaMetadataSha256: digest(`${fixture.label}:schema-metadata`),
      sourceSchemaFingerprint: digest(`${fixture.label}:schema-fingerprint`),
      sourceSchemaSha256: digest(`${fixture.label}:source-schema`),
      sourceSchemaVersion: 16,
      sourceSnapshotSha256: digest(`${fixture.label}:migration-source-snapshot`),
      startedAt: generatedAt,
      targetBindingSha256: digest(`${fixture.label}:migration-target-binding`),
      targetDdlSha256: digest(`${fixture.label}:target-ddl`),
      verifierIdSha256: digest(`${fixture.label}:migration-verifier`),
    },
    mutationEnabled: false as const,
    privateInput: {
      evidenceSetSha256: sha256PostgresReviewedPricePromotionValue(
        packet.items.map((item) => ({
          evidenceContentSha256: item.evidenceContentSha256,
          evidenceReferenceSha256: item.evidenceReferenceSha256,
          sourceIngestionId: item.sourceIngestionId,
        })),
      ),
      itemCount: 1,
      manifestSha256: packet.privateInputManifestSha256,
      marketedSuburb: "Fitzroy",
    },
    reviewPacket: {
      itemCount: 1,
      reviewPacketCandidateSha256: packet.reviewPacketCandidateSha256,
      rowCount: fixture.rows.length,
    },
    sourceSnapshot,
    target: {
      catalogIdentity: {
        currentUserSha256: digest(`${fixture.label}:planner-current-user`),
        databaseNameSha256: digest(`${fixture.label}:database-name`),
        databaseOidSha256: digest(`${fixture.label}:database-oid`),
        roleSafetySha256: digest(`${fixture.label}:role-safety`),
        serverVersionNum,
        sessionUserSha256: digest(`${fixture.label}:planner-session-user`),
        systemIdentifierSha256: digest(`${fixture.label}:system-identifier`),
      },
      physicalIdentitySha256,
      plannerLoginIdentitySha256: digest(`${fixture.label}:planner-login`),
    },
    version: POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_VERSION,
  };
  const plan = postgresReviewedPricePromotionPlanCandidateSchema.parse({
    ...planWithoutHash,
    planCandidateSha256: sha256PostgresReviewedPricePromotionValue(
      planWithoutHash,
    ),
  });
  return {
    packet,
    packetBytes: serializeCanonicalPostgresMigrationJson(packet),
    plan,
    planBytes: serializeCanonicalPostgresMigrationJson(plan),
  };
}

function buildSignedOperation(input: {
  readonly applyReceipt?: PostgresReviewedPriceOperationReceipt;
  readonly artifacts: PromotionArtifacts;
  readonly authorizationId: string;
  readonly keyPair: ReturnType<typeof crypto.generateKeyPairSync>;
  readonly operationId: string;
  readonly operationKind: "apply" | "quarantine";
  readonly publicKeyBytes: Buffer;
}): SignedOperation {
  const applyReceiptBytes = input.applyReceipt
    ? serializeCanonicalPostgresMigrationJson(input.applyReceipt)
    : undefined;
  const issuedAt = new Date(Date.now() - 2 * 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const planFileSha256 = sha256PostgresMigrationBytes(input.artifacts.planBytes);
  const packetFileSha256 = sha256PostgresMigrationBytes(input.artifacts.packetBytes);
  const publicKeySha256 = sha256PostgresMigrationBytes(input.publicKeyBytes);
  const rootCaSha256 = digest("transport-root-ca");
  const payload = postgresReviewedPriceOperationApprovalPayloadSchema.parse({
    approvalReferenceSha256: digest(`${input.operationId}:approval-reference`),
    authorizationId: input.authorizationId,
    authorityBundleSha256:
      input.artifacts.plan.authority.authorityBundleSha256,
    candidateSha: input.artifacts.plan.candidateSha,
    deploymentBindingSha256: postgresReviewedPriceDeploymentBindingSha256(
      input.artifacts.plan,
    ),
    evidenceAuthoritySha256: postgresReviewedPriceEvidenceAuthoritySha256(
      input.artifacts.plan,
      input.artifacts.packet,
    ),
    expectedEnvironment: input.artifacts.plan.expectedEnvironment,
    expiresAt,
    issuedAt,
    kind: POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_PAYLOAD_KIND,
    operationId: input.operationId,
    operationKind: input.operationKind,
    operatorIdSha256: digest("operator-id"),
    operatorLoginSha256: sha256PostgresReviewedPriceOperatorLogin(operatorLogin),
    planCandidateSha256: input.artifacts.plan.planCandidateSha256,
    planFileSha256,
    recoveryAuthoritySha256:
      input.artifacts.plan.authority.recoveryReferencesSha256,
    reviewPacketCandidateSha256:
      input.artifacts.packet.reviewPacketCandidateSha256,
    reviewPacketFileSha256: packetFileSha256,
    reviewerIdSha256: digest("reviewer-id"),
    reviewerLoginSha256: sha256PostgresReviewedPriceReviewerLogin(reviewerLogin),
    reviewerPublicKeySha256: publicKeySha256,
    sourceApplyOperationId: input.applyReceipt?.operationId ?? null,
    sourceApplyReceiptFileSha256: applyReceiptBytes
      ? sha256PostgresMigrationBytes(applyReceiptBytes)
      : null,
    sourceApplyReceiptSha256: input.applyReceipt?.receiptSha256 ?? null,
    sourceSnapshotSha256: input.artifacts.plan.sourceSnapshot.combinedSha256,
    targetPhysicalIdentitySha256:
      input.artifacts.plan.target.physicalIdentitySha256,
    transportRootCaSha256: rootCaSha256,
    version: POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_VERSION,
  });
  const signature = crypto.sign(
    null,
    serializeCanonicalPostgresMigrationJson(payload),
    input.keyPair.privateKey,
  );
  const approvalBytes = serializeCanonicalPostgresMigrationJson({
    kind: POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_KIND,
    payload,
    signatureBase64: signature.toString("base64"),
    version: POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_VERSION,
  });
  const common = {
    approvalBytes,
    approvalFileSha256: sha256PostgresMigrationBytes(approvalBytes),
    ...(applyReceiptBytes ? {
      applyReceiptBytes,
      applyReceiptFileSha256: sha256PostgresMigrationBytes(applyReceiptBytes),
      expectedApplyReceiptFileSha256:
        sha256PostgresMigrationBytes(applyReceiptBytes),
    } : {}),
    expectedApprovalFileSha256: sha256PostgresMigrationBytes(approvalBytes),
    expectedPlanFileSha256: planFileSha256,
    expectedReviewPacketFileSha256: packetFileSha256,
    expectedReviewerPublicKeySha256: publicKeySha256,
    expectedRootCaSha256: rootCaSha256,
    now: new Date(),
    planBytes: input.artifacts.planBytes,
    planFileSha256,
    reviewPacketBytes: input.artifacts.packetBytes,
    reviewPacketFileSha256: packetFileSha256,
    reviewerPublicKey: input.keyPair.publicKey,
    reviewerPublicKeyBytes: input.publicKeyBytes,
  };
  const reviewerRequest = validatePostgresReviewedPriceOperationArtifacts({
    ...common,
    reviewerLogin,
  }).request;
  const operatorRequest = validatePostgresReviewedPriceOperationArtifacts({
    ...common,
    operatorLogin,
  }).request;
  expect(operatorRequest).toEqual(reviewerRequest);
  return { request: operatorRequest };
}

function expiredAuthorizationRequest(
  request: PostgresReviewedPriceOperationRequest,
): PostgresReviewedPriceOperationRequest {
  const payload = JSON.parse(request.approvalPayloadCanonical) as Record<string, unknown>;
  payload.issuedAt = "2000-01-01T00:00:00.000Z";
  payload.expiresAt = "2000-01-01T01:00:00.000Z";
  const envelope = JSON.parse(request.approvalEnvelopeCanonical) as {
    payload: unknown;
  };
  envelope.payload = payload;
  const approvalPayloadCanonical = serializeCanonicalPostgresMigrationJson(payload)
    .toString("utf8");
  const approvalEnvelopeCanonical = serializeCanonicalPostgresMigrationJson(envelope)
    .toString("utf8");
  return {
    ...request,
    approvalEnvelopeCanonical,
    approvalFileSha256: sha256PostgresMigrationBytes(approvalEnvelopeCanonical),
    approvalPayloadCanonical,
  };
}

describe.skipIf(!configuredAdminUrl)(
  "activated reviewed-price promotion end to end on real PostgreSQL 17",
  () => {
    let cluster: Client;
    let database: Client;
    let reviewer: Client;
    let operator: Client;
    let databaseOid = "";
    let serverVersionNum = "";
    let physicalIdentitySha256 = "";
    let reviewerExecute = "";
    let applyExecute = "";
    let quarantineExecute = "";
    let applyOwner = "";
    let quarantineOwner = "";
    let backupRole = "";
    let ownsRoleNamespace = false;
    const keyPair = crypto.generateKeyPairSync("ed25519");
    const publicKeyBytes = Buffer.from(keyPair.publicKey.export({
      format: "pem",
      type: "spki",
    }));

    async function protectedCall(
      client: Client,
      role: string,
      functionName: "authorize_reviewed_price_promotion"
        | "apply_reviewed_price_promotion"
        | "quarantine_reviewed_price_promotion",
      request: PostgresReviewedPriceOperationRequest,
    ): Promise<unknown> {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      try {
        await client.query("SET LOCAL search_path = pg_catalog");
        await client.query("SET LOCAL row_security = on");
        await client.query(`SET LOCAL ROLE ${quoteIdentifier(role)}`);
        const result = await client.query<{ response: unknown }>(
          `SELECT pintpath_ops.${functionName}($1::pg_catalog.jsonb) AS response`,
          [JSON.stringify(request)],
        );
        await client.query("COMMIT");
        return result.rows[0]?.response;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    async function expectKernelError(
      work: () => Promise<unknown>,
      code: string,
      message: string,
    ): Promise<void> {
      const error = await work().then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code, message });
    }

    async function seedFixture(fixture: SourceFixture): Promise<void> {
      await database.query(`INSERT INTO pintpath_app.venue_profiles (
        venue_id, name, address, suburb, area, active, created_at, updated_at
      ) VALUES ($1, $2, '123 Private Street', 'Fitzroy', 'inner-north', true,
        clock_timestamp(), clock_timestamp())`, [fixture.venueId, fixture.venueName]);
      await database.query(`INSERT INTO pintpath_app.admin_ingestion_queue (
        id, venue_id, venue_name, source_type, image_data_url, status,
        extracted_beers_json, created_at, updated_at
      ) VALUES ($1, $2, $3, 'source_reference',
        'data:image/png;base64,cHJpdmF0ZQ==', 'pending_review', '[]'::jsonb,
        clock_timestamp(), clock_timestamp())`, [
        fixture.sourceIngestionId,
        fixture.venueId,
        fixture.venueName,
      ]);
      for (const row of fixture.rows) {
        await database.query(`INSERT INTO pintpath_app.beer_catalog_items (
          key, name, brewery, style, abv, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 4.5, 'active',
          clock_timestamp(), clock_timestamp())`, [
          row.normalizedBeerId,
          row.beerName,
          row.brewery,
          row.style,
        ]);
      }
    }

    async function registerMigrationRun(
      artifacts: PromotionArtifacts,
    ): Promise<void> {
      const migration = artifacts.plan.migration;
      await database.query(`INSERT INTO pintpath_ops.migration_runs (
        run_id, source_snapshot_sha256, source_schema_fingerprint,
        contract_sha256, manifest_sha256, target_ddl_sha256,
        source_schema_version, candidate_commit_sha, target_binding_sha256,
        expected_environment, approval_reference_sha256, operator_id_sha256,
        verifier_id_sha256, status, started_at, completed_at, receipt_sha256
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
        $13, 'ready', $14, $15, $16)`, [
        migration.runId,
        migration.sourceSnapshotSha256,
        migration.sourceSchemaFingerprint,
        migration.contractSha256,
        migration.manifestSha256,
        migration.targetDdlSha256,
        migration.sourceSchemaVersion,
        artifacts.plan.candidateSha,
        migration.targetBindingSha256,
        artifacts.plan.expectedEnvironment,
        migration.approvalReferenceSha256,
        migration.operatorIdSha256,
        migration.verifierIdSha256,
        migration.startedAt,
        migration.completedAt,
        migration.receiptSha256,
      ]);
    }

    beforeAll(async () => {
      const adminUrl = validateAdminUrl(configuredAdminUrl);
      cluster = new Client({ connectionString: adminUrl.toString() });
      await cluster.connect();
      const version = await cluster.query<{ version: string }>(
        "SELECT current_setting('server_version_num') AS version",
      );
      serverVersionNum = version.rows[0]?.version ?? "";
      if (!/^17\d{4}$/.test(serverVersionNum)) {
        throw new Error("Reviewed-price E2E integration requires PostgreSQL 17.");
      }
      const fixedRoles = [
        "pintpath_runtime",
        "pintpath_migrator",
        "pintpath_migration_verifier_authority",
        "pintpath_maintenance",
      ];
      const existing = await cluster.query<{ roleName: string }>(
        `SELECT rolname AS "roleName" FROM pg_catalog.pg_roles
          WHERE rolname = ANY($1::pg_catalog.text[])`,
        [fixedRoles],
      );
      if (existing.rowCount !== 0) throw new Error("promotion_e2e_role_collision");
      ownsRoleNamespace = true;
      await cluster.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      for (const role of [reviewerLogin, operatorLogin]) {
        await cluster.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
      }
      await cluster.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      database = new Client({
        connectionString: withDatabase(adminUrl, databaseName),
      });
      await database.connect();
      await database.query("CREATE SCHEMA IF NOT EXISTS extensions");
      await database.query(
        "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions",
      );
      for (const filename of sqlFiles) {
        await database.query(fs.readFileSync(path.resolve(filename), "utf8"));
      }
      const identity = await database.query<{
        databaseName: string;
        databaseOid: string;
        serverVersionNum: string;
        systemIdentifier: string;
      }>(`SELECT current_database() AS "databaseName",
          database.oid::text AS "databaseOid",
          current_setting('server_version_num') AS "serverVersionNum",
          control.system_identifier::text AS "systemIdentifier"
        FROM pg_catalog.pg_database AS database
        CROSS JOIN pg_catalog.pg_control_system() AS control
        WHERE database.datname = current_database()`);
      const identityRow = identity.rows[0];
      if (!identityRow) throw new Error("promotion_e2e_identity_unavailable");
      databaseOid = identityRow.databaseOid;
      physicalIdentitySha256 = sha256PostgresDatabaseIdentity(identityRow);
      reviewerExecute = `pintpath_reviewed_price_reviewer_execute_d${databaseOid}`;
      applyExecute = `pintpath_reviewed_price_apply_execute_d${databaseOid}`;
      quarantineExecute =
        `pintpath_reviewed_price_quarantine_execute_d${databaseOid}`;
      applyOwner = `pintpath_reviewed_price_apply_owner_d${databaseOid}`;
      quarantineOwner = `pintpath_reviewed_price_quarantine_owner_d${databaseOid}`;
      backupRole = `pintpath_logical_backup_d${databaseOid}`;

      await database.query(
        `REVOKE ALL ON DATABASE ${quoteIdentifier(databaseName)} FROM PUBLIC`,
      );
      const validUntil = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
      for (const role of [reviewerLogin, operatorLogin]) {
        await database.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN
          PASSWORD '${password}' VALID UNTIL '${validUntil}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
          NOBYPASSRLS CONNECTION LIMIT 1`);
        await database.query(
          `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)}
            TO ${quoteIdentifier(role)}`,
        );
      }
      await database.query(`GRANT ${quoteIdentifier(reviewerExecute)}
        TO ${quoteIdentifier(reviewerLogin)}
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      for (const role of [applyExecute, quarantineExecute]) {
        await database.query(`GRANT ${quoteIdentifier(role)}
          TO ${quoteIdentifier(operatorLogin)}
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      }
      reviewer = new Client({
        connectionString: loginUrl(adminUrl, reviewerLogin),
      });
      operator = new Client({
        connectionString: loginUrl(adminUrl, operatorLogin),
      });
      await reviewer.connect();
      await operator.connect();
      await postgresReviewedPricePromotionOperatorInternals
        .verifyReviewedPriceLoginAuthority(reviewer, {
          databaseOid,
          kind: "reviewer",
          loginRole: reviewerLogin,
        });
      await postgresReviewedPricePromotionOperatorInternals
        .verifyReviewedPriceLoginAuthority(operator, {
          databaseOid,
          kind: "operator",
          loginRole: operatorLogin,
        });
      await database.query(`UPDATE pintpath_app.schema_metadata
        SET value = $1, updated_at = clock_timestamp()
        WHERE key = 'migration_candidate_sha'`, [candidateSha]);
    }, 45_000);

    afterAll(async () => {
      const failures: unknown[] = [];
      for (const client of [reviewer, operator, database]) {
        await client?.end().catch((error) => failures.push(error));
      }
      try {
        await cluster?.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
        );
        if (ownsRoleNamespace) {
          for (const role of [
            reviewerLogin,
            operatorLogin,
            reviewerExecute,
            applyExecute,
            quarantineExecute,
            applyOwner,
            quarantineOwner,
            backupRole,
            "pintpath_maintenance",
            "pintpath_migration_verifier_authority",
            "pintpath_migrator",
            "pintpath_runtime",
          ]) {
            if (role) {
              await cluster.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
            }
          }
        }
      } catch (error) {
        failures.push(error);
      }
      await cluster?.end().catch((error) => failures.push(error));
      if (failures.length > 0) throw failures[0];
    }, 45_000);

    it("authorizes, applies, replays, and receipt-binds quarantine", async () => {
      const fixture: SourceFixture = {
        label: "success",
        rows: [{
          beerName: "Fixture Lager",
          brewery: "Fixture Brewery",
          normalizedBeerId: "fixture_lager_e2e",
          price: 13.5,
          style: "Lager",
        }],
        sourceIngestionId: SUCCESS_SOURCE_ID,
        venueId: SUCCESS_VENUE_ID,
        venueName: "Successful Fixture Hotel",
      };
      await seedFixture(fixture);
      const artifacts = buildArtifacts(
        fixture,
        physicalIdentitySha256,
        serverVersionNum,
      );
      await registerMigrationRun(artifacts);
      const apply = buildSignedOperation({
        artifacts,
        authorizationId: "77777777-7777-4777-8777-777777777777",
        keyPair,
        operationId: "88888888-8888-4888-8888-888888888888",
        operationKind: "apply",
        publicKeyBytes,
      });

      const authorization = postgresReviewedPriceOperationAuthorizationResponseSchema
        .parse(await protectedCall(
          reviewer,
          reviewerExecute,
          "authorize_reviewed_price_promotion",
          apply.request,
        ));
      expect(authorization).toMatchObject({
        authorization: {
          authorizationId: "77777777-7777-4777-8777-777777777777",
          operationId: "88888888-8888-4888-8888-888888888888",
          operationKind: "apply",
        },
        replayed: false,
      });

      const applied = postgresReviewedPriceOperationDatabaseResponseSchema.parse(
        await protectedCall(
          operator,
          applyExecute,
          "apply_reviewed_price_promotion",
          apply.request,
        ),
      );
      expect(applied).toMatchObject({
        receipt: {
          authorizationId: authorization.authorization.authorizationId,
          operationId: "88888888-8888-4888-8888-888888888888",
          operationKind: "apply",
          requestedRowCount: 1,
          sourceApplyOperationId: null,
        },
        replayed: false,
      });
      const replayed = postgresReviewedPriceOperationDatabaseResponseSchema.parse(
        await protectedCall(
          operator,
          applyExecute,
          "apply_reviewed_price_promotion",
          apply.request,
        ),
      );
      expect(replayed).toEqual({ receipt: applied.receipt, replayed: true });

      const published = await database.query<{
        confidence: string;
        inStock: boolean;
        onTap: boolean;
        queueStatus: string;
        sourceType: string;
      }>(`SELECT price.confidence, price.source_type AS "sourceType",
          beer.in_stock AS "inStock", beer.on_tap AS "onTap",
          queue.status AS "queueStatus"
        FROM pintpath_app.venue_price_records AS price
        JOIN pintpath_app.venue_beers AS beer
          ON beer.source_ingestion_id = price.source_ingestion_id
        JOIN pintpath_app.admin_ingestion_queue AS queue
          ON queue.id = price.source_ingestion_id
        WHERE price.source_ingestion_id = $1`, [fixture.sourceIngestionId]);
      expect(published.rows).toEqual([{
        confidence: "admin_verified",
        inStock: true,
        onTap: true,
        queueStatus: "published",
        sourceType: "source_ingestion",
      }]);

      const quarantine = buildSignedOperation({
        applyReceipt: applied.receipt,
        artifacts,
        authorizationId: "99999999-9999-4999-8999-999999999999",
        keyPair,
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        operationKind: "quarantine",
        publicKeyBytes,
      });
      const quarantineAuthorization =
        postgresReviewedPriceOperationAuthorizationResponseSchema.parse(
          await protectedCall(
            reviewer,
            reviewerExecute,
            "authorize_reviewed_price_promotion",
            quarantine.request,
          ),
        );
      expect(quarantineAuthorization).toMatchObject({
        authorization: {
          authorizationId: "99999999-9999-4999-8999-999999999999",
          operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          operationKind: "quarantine",
        },
        replayed: false,
      });
      const quarantined = postgresReviewedPriceOperationDatabaseResponseSchema.parse(
        await protectedCall(
          operator,
          quarantineExecute,
          "quarantine_reviewed_price_promotion",
          quarantine.request,
        ),
      );
      expect(quarantined).toMatchObject({
        receipt: {
          authorizationId: quarantineAuthorization.authorization.authorizationId,
          operationKind: "quarantine",
          requestedRowCount: 1,
          sourceApplyOperationId: applied.receipt.operationId,
        },
        replayed: false,
      });
      const finalState = await database.query<{
        confidence: string;
        inStock: boolean;
        onTap: boolean;
        operationCount: string;
        rowLedgerCount: string;
        sourceType: string;
      }>(`SELECT price.confidence, price.source_type AS "sourceType",
          beer.in_stock AS "inStock", beer.on_tap AS "onTap",
          (SELECT count(*)::text
             FROM pintpath_ops.reviewed_price_promotion_operations
            WHERE candidate_sha = $2) AS "operationCount",
          (SELECT count(*)::text
             FROM pintpath_ops.reviewed_price_promotion_rows
            WHERE operation_id = ANY($3::uuid[])) AS "rowLedgerCount"
        FROM pintpath_app.venue_price_records AS price
        JOIN pintpath_app.venue_beers AS beer
          ON beer.source_ingestion_id = price.source_ingestion_id
        WHERE price.source_ingestion_id = $1`, [
        fixture.sourceIngestionId,
        candidateSha,
        [applied.receipt.operationId, quarantined.receipt.operationId],
      ]);
      expect(finalState.rows).toEqual([{
        confidence: "disputed",
        inStock: false,
        onTap: false,
        operationCount: "4",
        rowLedgerCount: "2",
        sourceType: "source_ingestion_quarantined",
      }]);
    }, 30_000);

    it("rejects missing and invalid authorization without residue", async () => {
      const fixture: SourceFixture = {
        label: "missing-authorization",
        rows: [{
          beerName: "Missing Authority Ale",
          brewery: "Fixture Brewery",
          normalizedBeerId: "missing_authority_ale_e2e",
          price: 14,
          style: "Ale",
        }],
        sourceIngestionId: MISSING_SOURCE_ID,
        venueId: MISSING_VENUE_ID,
        venueName: "Missing Authority Hotel",
      };
      await seedFixture(fixture);
      const artifacts = buildArtifacts(
        fixture,
        physicalIdentitySha256,
        serverVersionNum,
      );
      await registerMigrationRun(artifacts);
      const signed = buildSignedOperation({
        artifacts,
        authorizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        keyPair,
        operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        operationKind: "apply",
        publicKeyBytes,
      });

      await expectKernelError(
        () => protectedCall(
          operator,
          applyExecute,
          "apply_reviewed_price_promotion",
          signed.request,
        ),
        "42501",
        "reviewed_price_promotion_authorization_missing",
      );
      await expectKernelError(
        () => protectedCall(
          reviewer,
          reviewerExecute,
          "authorize_reviewed_price_promotion",
          expiredAuthorizationRequest(signed.request),
        ),
        "42501",
        "reviewed_price_promotion_approval_invalid",
      );
      const residue = await database.query<{
        beerCount: string;
        operationCount: string;
        priceCount: string;
        queueStatus: string;
      }>(`SELECT queue.status AS "queueStatus",
          (SELECT count(*)::text FROM pintpath_app.venue_price_records
            WHERE source_ingestion_id = $1) AS "priceCount",
          (SELECT count(*)::text FROM pintpath_app.venue_beers
            WHERE source_ingestion_id = $1) AS "beerCount",
          (SELECT count(*)::text
             FROM pintpath_ops.reviewed_price_promotion_operations
            WHERE operation_id = ANY($2::uuid[])) AS "operationCount"
        FROM pintpath_app.admin_ingestion_queue AS queue
        WHERE queue.id = $1`, [
        fixture.sourceIngestionId,
        ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
      ]);
      expect(residue.rows).toEqual([{
        beerCount: "0",
        operationCount: "0",
        priceCount: "0",
        queueStatus: "pending_review",
      }]);
    }, 30_000);

    it("rolls back earlier row writes when a later row fails", async () => {
      const fixture: SourceFixture = {
        label: "transaction-rollback",
        rows: [{
          beerName: "Rollback First Lager",
          brewery: "Fixture Brewery",
          normalizedBeerId: "rollback_first_lager_e2e",
          price: 12.5,
          style: "Lager",
        }, {
          beerName: "Rollback Second Stout",
          brewery: "Fixture Brewery",
          normalizedBeerId: "rollback_second_stout_e2e",
          price: 15,
          style: "Stout",
        }],
        sourceIngestionId: ROLLBACK_SOURCE_ID,
        venueId: ROLLBACK_VENUE_ID,
        venueName: "Rollback Fixture Hotel",
      };
      await seedFixture(fixture);
      const artifacts = buildArtifacts(
        fixture,
        physicalIdentitySha256,
        serverVersionNum,
      );
      await registerMigrationRun(artifacts);
      const signed = buildSignedOperation({
        artifacts,
        authorizationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        keyPair,
        operationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        operationKind: "apply",
        publicKeyBytes,
      });
      await protectedCall(
        reviewer,
        reviewerExecute,
        "authorize_reviewed_price_promotion",
        signed.request,
      );
      await database.query(`UPDATE pintpath_app.beer_catalog_items
        SET status = 'inactive', updated_at = clock_timestamp()
        WHERE key = $1`, [fixture.rows[1]!.normalizedBeerId]);

      await expectKernelError(
        () => protectedCall(
          operator,
          applyExecute,
          "apply_reviewed_price_promotion",
          signed.request,
        ),
        "55000",
        "reviewed_price_promotion_catalog_changed",
      );
      const residue = await database.query<{
        authorizationCount: string;
        beerCount: string;
        operationCount: string;
        priceCount: string;
        rowLedgerCount: string;
        queueStatus: string;
      }>(`SELECT queue.status AS "queueStatus",
          (SELECT count(*)::text FROM pintpath_app.venue_price_records
            WHERE source_ingestion_id = $1) AS "priceCount",
          (SELECT count(*)::text FROM pintpath_app.venue_beers
            WHERE source_ingestion_id = $1) AS "beerCount",
          (SELECT count(*)::text
             FROM pintpath_ops.reviewed_price_promotion_operations
            WHERE operation_id = $2::uuid) AS "authorizationCount",
          (SELECT count(*)::text
             FROM pintpath_ops.reviewed_price_promotion_operations
            WHERE operation_id = $3::uuid) AS "operationCount",
          (SELECT count(*)::text
             FROM pintpath_ops.reviewed_price_promotion_rows
            WHERE operation_id = $3::uuid) AS "rowLedgerCount"
        FROM pintpath_app.admin_ingestion_queue AS queue
        WHERE queue.id = $1`, [
        fixture.sourceIngestionId,
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ]);
      expect(residue.rows).toEqual([{
        authorizationCount: "1",
        beerCount: "0",
        operationCount: "0",
        priceCount: "0",
        queueStatus: "pending_review",
        rowLedgerCount: "0",
      }]);
    }, 30_000);
  },
);
