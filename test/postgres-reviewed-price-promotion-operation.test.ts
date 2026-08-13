import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_PAYLOAD_KIND,
  POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_VERSION,
  POSTGRES_REVIEWED_PRICE_OPERATION_RECEIPT_KIND,
  POSTGRES_REVIEWED_PRICE_OPERATION_RECEIPT_VERSION,
  postgresReviewedPriceOperationApprovalPayloadSchema,
  postgresReviewedPriceOperationReceiptSchema,
  sha256PostgresReviewedPriceOperationReceipt,
  sha256PostgresReviewedPriceOperatorLogin,
  sha256PostgresReviewedPriceReviewerLogin,
  validatePostgresReviewedPriceOperationArtifacts,
} from "../src/lib/postgres-reviewed-price-promotion-operation.js";
import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "../src/db/postgres-migration-schema.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_VERSION,
  finalizePostgresReviewedPricePromotionReviewPacket,
} from "../src/lib/postgres-reviewed-price-promotion-authority.js";
import {
  postgresReviewedPriceDeploymentBindingSha256,
  postgresReviewedPriceEvidenceAuthoritySha256,
} from "../src/lib/postgres-reviewed-price-promotion-operation.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
  POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_VERSION,
  postgresReviewedPricePromotionPlanCandidateSchema,
  sha256PostgresReviewedPricePromotionValue,
} from "../src/lib/postgres-reviewed-price-promotion-plan.js";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const AUTHORIZATION_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const VENUE_ID = "44444444-4444-4444-8444-444444444444";

function signedArtifacts() {
  const packet = finalizePostgresReviewedPricePromotionReviewPacket({
    authorityBundleSha256: HASH,
    candidateSha: "c".repeat(40),
    expectedEnvironment: "permanent-staging",
    expiresAt: "2026-08-13T01:00:00.000Z",
    generatedAt: "2026-08-13T00:00:00.000Z",
    itemCount: 1,
    items: [{
      evidenceContentSha256: HASH,
      evidenceReference: `source-ingestion:${SOURCE_ID}`,
      evidenceReferenceSha256: HASH,
      rows: [{
        ordinal: 0,
        priceRecord: {
          beerName: "Fixture Lager",
          confidence: "admin_verified",
          happyHourDetails: null,
          id: `source-ingestion:${SOURCE_ID}:0`,
          isHappyHourPrice: false,
          isOnTap: "yes",
          normalizedBeerId: "fixture_lager",
          price: 13.5,
          servingSize: "pint",
          sourceEvidenceReference: `source-ingestion:${SOURCE_ID}`,
          sourceIngestionId: SOURCE_ID,
          sourceSubmissionId: null,
          sourceType: "source_ingestion",
          suburb: "Fitzroy",
          venueId: VENUE_ID,
          venueName: "Fixture Hotel",
        },
        venueBeer: {
          abv: "4.5",
          beerName: "Fixture Lager",
          brewery: "Fixture Brewery",
          currency: "AUD",
          id: `admin-reviewed:${VENUE_ID}:fixture-lager:pint`,
          inStock: true,
          normalizedBeerId: "fixture_lager",
          notes: "Published from admin source review.",
          onTap: true,
          price: 13.5,
          serveSize: "pint",
          sourceIngestionId: SOURCE_ID,
          style: "Lager",
          venueId: VENUE_ID,
        },
      }],
      sourceIngestionId: SOURCE_ID,
      venue: {
        address: "123 Private Street",
        area: "inner-north",
        id: VENUE_ID,
        name: "Fixture Hotel",
        suburb: "Fitzroy",
      },
    }],
    kind: POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_KIND,
    marketedSuburb: "Fitzroy",
    mutationEnabled: false,
    privateInputManifestSha256: HASH,
    rowCount: 1,
    sourceSnapshotSha256: HASH,
    targetPhysicalIdentitySha256: HASH,
    targetProfileSha256: HASH,
    temporalPolicy: "single-apply-transaction-timestamp",
    version: POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_VERSION,
    wrongPricePolicySha256: HASH,
  });
  const planWithoutHash = {
    activationBlockers: POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
    authority: {
      authorityBundleSha256: HASH,
      authorityMode: "offline-plan-bindings-only" as const,
      evidenceReferencesSha256: HASH,
      expiresAt: "2026-08-13T01:00:00.000Z",
      generatedAt: "2026-08-13T00:00:00.000Z",
      mutationAuthorized: false as const,
      providerAuthorityObserved: false as const,
      recoveryReferencesSha256: HASH,
      reviewBindingsSha256: HASH,
      supabaseProjectIdentitySha256: HASH,
      targetProfileSha256: HASH,
    },
    candidateSha: "c".repeat(40),
    expectedDeployment: {
      attestationFileSha256: HASH,
      attestationPolicySha256: HASH,
      deploymentIdSha256: HASH,
      environmentIdSha256: HASH,
      imageDigestSha256: HASH,
      projectIdSha256: HASH,
      serviceIdSha256: HASH,
    },
    expectedEnvironment: "permanent-staging" as const,
    kind: POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_KIND,
    migration: {
      approvalReferenceSha256: HASH,
      completedAt: "2026-08-13T00:00:00.000Z",
      contractSha256: HASH,
      manifestSha256: HASH,
      operatorIdSha256: HASH,
      planSha256: HASH,
      receiptFileSha256: HASH,
      receiptSha256: HASH,
      runId: HASH,
      runSnapshotSha256: HASH,
      schemaMetadataSha256: HASH,
      sourceSchemaFingerprint: HASH,
      sourceSchemaSha256: HASH,
      sourceSchemaVersion: 1,
      sourceSnapshotSha256: HASH,
      startedAt: "2026-08-13T00:00:00.000Z",
      targetBindingSha256: HASH,
      targetDdlSha256: HASH,
      verifierIdSha256: HASH,
    },
    mutationEnabled: false as const,
    privateInput: {
      evidenceSetSha256: HASH,
      itemCount: 1,
      manifestSha256: HASH,
      marketedSuburb: "Fitzroy",
    },
    reviewPacket: {
      itemCount: 1,
      reviewPacketCandidateSha256: packet.reviewPacketCandidateSha256,
      rowCount: 1,
    },
    sourceSnapshot: {
      combinedSha256: HASH,
      items: [{
        catalogRowsSha256: HASH,
        queueSnapshotSha256: HASH,
        selectedRowCount: 1,
        selectedRowsSha256: HASH,
        sourceIngestionId: SOURCE_ID,
        venueIdSha256: HASH,
        venueProfileSha256: HASH,
      }],
      publicConflicts: {
        priceRecordCount: 0,
        rowsSha256: HASH,
        venueBeerCount: 0,
      },
      selectionPolicySha256: HASH,
      wrongPriceReports: {
        blockingCount: 0,
        blockingStatuses: ["in_progress", "open"] as const,
        openOrInProgressCount: 0,
        policySha256: HASH,
        rejectedCount: 0,
        resolvedCount: 0,
        rowsSha256: HASH,
        totalCount: 0,
      },
    },
    target: {
      catalogIdentity: {
        currentUserSha256: HASH,
        databaseNameSha256: HASH,
        databaseOidSha256: HASH,
        roleSafetySha256: HASH,
        serverVersionNum: "170010",
        sessionUserSha256: HASH,
        systemIdentifierSha256: HASH,
      },
      physicalIdentitySha256: HASH,
      plannerLoginIdentitySha256: HASH,
    },
    version: POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_VERSION,
  };
  const plan = postgresReviewedPricePromotionPlanCandidateSchema.parse({
    ...planWithoutHash,
    planCandidateSha256: sha256PostgresReviewedPricePromotionValue(planWithoutHash),
  });
  const planBytes = serializeCanonicalPostgresMigrationJson(plan);
  const packetBytes = serializeCanonicalPostgresMigrationJson(packet);
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const publicKeyBytes = Buffer.from(keyPair.publicKey.export({
    format: "pem",
    type: "spki",
  }));
  const rootCaSha256 = sha256PostgresMigrationBytes("fixture-root-ca");
  const payload = postgresReviewedPriceOperationApprovalPayloadSchema.parse({
    ...approvalPayload(),
    deploymentBindingSha256: postgresReviewedPriceDeploymentBindingSha256(plan),
    evidenceAuthoritySha256: postgresReviewedPriceEvidenceAuthoritySha256(plan, packet),
    planCandidateSha256: plan.planCandidateSha256,
    planFileSha256: sha256PostgresMigrationBytes(planBytes),
    reviewPacketCandidateSha256: packet.reviewPacketCandidateSha256,
    reviewPacketFileSha256: sha256PostgresMigrationBytes(packetBytes),
    reviewerPublicKeySha256: sha256PostgresMigrationBytes(publicKeyBytes),
    transportRootCaSha256: rootCaSha256,
  });
  const approval = {
    kind: "pintpath-postgres-reviewed-price-operation-signed-approval" as const,
    payload,
    signatureBase64: crypto.sign(
      null,
      serializeCanonicalPostgresMigrationJson(payload),
      keyPair.privateKey,
    ).toString("base64"),
    version: POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_VERSION,
  };
  const approvalBytes = serializeCanonicalPostgresMigrationJson(approval);
  return {
    approvalBytes,
    packetBytes,
    planBytes,
    publicKey: keyPair.publicKey,
    publicKeyBytes,
    rootCaSha256,
  };
}

function approvalPayload() {
  return {
    approvalReferenceSha256: HASH,
    authorizationId: AUTHORIZATION_ID,
    authorityBundleSha256: HASH,
    candidateSha: "c".repeat(40),
    deploymentBindingSha256: HASH,
    evidenceAuthoritySha256: HASH,
    expectedEnvironment: "permanent-staging" as const,
    expiresAt: "2026-08-13T01:00:00.000Z",
    issuedAt: "2026-08-13T00:00:00.000Z",
    kind: POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_PAYLOAD_KIND,
    operationId: OPERATION_ID,
    operationKind: "apply" as const,
    operatorIdSha256: HASH,
    operatorLoginSha256: sha256PostgresReviewedPriceOperatorLogin("price_operator"),
    planCandidateSha256: HASH,
    planFileSha256: HASH,
    recoveryAuthoritySha256: HASH,
    reviewPacketCandidateSha256: HASH,
    reviewPacketFileSha256: HASH,
    reviewerIdSha256: OTHER_HASH,
    reviewerLoginSha256: sha256PostgresReviewedPriceReviewerLogin("price_reviewer"),
    reviewerPublicKeySha256: HASH,
    sourceApplyOperationId: null,
    sourceApplyReceiptFileSha256: null,
    sourceApplyReceiptSha256: null,
    sourceSnapshotSha256: HASH,
    targetPhysicalIdentitySha256: HASH,
    transportRootCaSha256: HASH,
    version: POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_VERSION,
  };
}

describe("Postgres reviewed-price operation authority", () => {
  it("requires independent database principals and a bounded signed authority window", () => {
    const payload = approvalPayload();
    expect(postgresReviewedPriceOperationApprovalPayloadSchema.parse(payload))
      .toEqual(payload);
    expect(postgresReviewedPriceOperationApprovalPayloadSchema.safeParse({
      ...payload,
      reviewerLoginSha256: payload.operatorLoginSha256,
    }).success).toBe(false);
    expect(postgresReviewedPriceOperationApprovalPayloadSchema.safeParse({
      ...payload,
      expiresAt: "2026-08-14T00:00:00.001Z",
    }).success).toBe(false);
  });

  it("verifies the canonical Ed25519 envelope for separate reviewer and operator logins", () => {
    const artifacts = signedArtifacts();
    const input = {
      approvalBytes: artifacts.approvalBytes,
      approvalFileSha256: sha256PostgresMigrationBytes(artifacts.approvalBytes),
      expectedApprovalFileSha256: sha256PostgresMigrationBytes(artifacts.approvalBytes),
      expectedPlanFileSha256: sha256PostgresMigrationBytes(artifacts.planBytes),
      expectedReviewPacketFileSha256: sha256PostgresMigrationBytes(artifacts.packetBytes),
      expectedReviewerPublicKeySha256: sha256PostgresMigrationBytes(
        artifacts.publicKeyBytes,
      ),
      expectedRootCaSha256: artifacts.rootCaSha256,
      now: new Date("2026-08-13T00:30:00.000Z"),
      planBytes: artifacts.planBytes,
      planFileSha256: sha256PostgresMigrationBytes(artifacts.planBytes),
      reviewPacketBytes: artifacts.packetBytes,
      reviewPacketFileSha256: sha256PostgresMigrationBytes(artifacts.packetBytes),
      reviewerPublicKey: artifacts.publicKey,
      reviewerPublicKeyBytes: artifacts.publicKeyBytes,
    };
    expect(validatePostgresReviewedPriceOperationArtifacts({
      ...input,
      reviewerLogin: "price_reviewer",
    }).request.operationKind).toBe("apply");
    expect(validatePostgresReviewedPriceOperationArtifacts({
      ...input,
      operatorLogin: "price_operator",
    }).request.operationId).toBe(OPERATION_ID);
    const tampered = Buffer.from(artifacts.approvalBytes);
    tampered[tampered.length - 3] = tampered[tampered.length - 3]! === 65 ? 66 : 65;
    expect(() => validatePostgresReviewedPriceOperationArtifacts({
      ...input,
      approvalBytes: tampered,
      approvalFileSha256: sha256PostgresMigrationBytes(tampered),
      expectedApprovalFileSha256: sha256PostgresMigrationBytes(tampered),
      operatorLogin: "price_operator",
    })).toThrow();
  });

  it("binds authorization, mutation, result, row set, and approval into the receipt hash", () => {
    const receipt = {
      approvalFileSha256: HASH,
      approvalReferenceSha256: HASH,
      authorizationId: AUTHORIZATION_ID,
      authorityBundleSha256: HASH,
      candidateSha: "c".repeat(40),
      committedAt: "2026-08-13T00:30:00.000Z",
      expectedEnvironment: "permanent-staging" as const,
      itemCount: 1,
      kind: POSTGRES_REVIEWED_PRICE_OPERATION_RECEIPT_KIND,
      operationId: OPERATION_ID,
      operationKind: "apply" as const,
      operatorIdSha256: HASH,
      planCandidateSha256: HASH,
      requestSha256: HASH,
      requestedRowCount: 1,
      resultStateSha256: HASH,
      reviewPacketCandidateSha256: HASH,
      reviewerIdSha256: OTHER_HASH,
      sourceApplyOperationId: null,
      sourceIngestionIds: [SOURCE_ID],
      targetPhysicalIdentitySha256: HASH,
      version: POSTGRES_REVIEWED_PRICE_OPERATION_RECEIPT_VERSION,
    };
    const receiptSha256 = sha256PostgresReviewedPriceOperationReceipt(receipt);
    expect(postgresReviewedPriceOperationReceiptSchema.parse({
      ...receipt,
      receiptSha256,
    }).receiptSha256).toBe(receiptSha256);
    expect(postgresReviewedPriceOperationReceiptSchema.safeParse({
      ...receipt,
      authorizationId: "44444444-4444-4444-8444-444444444444",
      receiptSha256,
    }).success).toBe(false);
  });

  it("activates only scoped functions while retaining required shared-runtime DML", () => {
    const migration = fs.readFileSync(path.join(
      process.cwd(),
      "supabase/migrations/20260813000000_activate_reviewed_price_promotion_kernel.sql",
    ), "utf8");
    expect(migration).toContain("authorize_reviewed_price_promotion");
    expect(migration).toContain("pintpath_reviewed_price_reviewer_execute_d");
    expect(migration).toContain("transaction_isolation') <> 'serializable'");
    expect(migration).toContain("pg_advisory_xact_lock(-1516610544307388179)");
    expect(migration).toContain("reviewed_price_promotion_authorization_missing");
    expect(migration).toContain("reviewed_price_promotion_operation_id_conflict");
    expect(migration).not.toMatch(
      /revoke\s+insert\s*,\s*update\s*,\s*delete[\s\S]{0,180}from\s+pintpath_runtime/i,
    );
  });
});
