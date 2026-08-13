import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  PRODUCTION_PROMOTION_RECOVERY_APPROVAL_SCHEMA,
  PRODUCTION_PROMOTION_RECOVERY_AUTHORITY_SCHEMA,
  PRODUCTION_PROMOTION_RECOVERY_RECEIPT_SCHEMA,
  buildProductionPromotionRecoveryReceipt,
  productionPromotionRecoveryAuthoritySchema,
  sha256ProductionPromotionRecoveryBytes,
  verifyProductionPromotionRecoveryApproval,
} from "../src/lib/production-promotion-recovery.js";
import {
  verifyProductionPromotionRecoveryReceiptBytes,
  verifyProductionPromotionRecoveryReceiptFile,
} from "../scripts/verify-production-promotion-recovery-receipt.js";

const CANDIDATE = "c".repeat(40);
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function validReceipt() {
  return buildProductionPromotionRecoveryReceipt({
    schemaVersion: PRODUCTION_PROMOTION_RECOVERY_RECEIPT_SCHEMA,
    outcome: "verified",
    candidateSha: CANDIDATE,
    githubEnvironment: "production-promotion-recovery",
    policySha256: HASH,
    authorityManifestSha256: HASH,
    productionDeploymentReceiptSha256: HASH,
    productionDeploymentIdSha256: HASH,
    productionScaleReceiptSha256: OTHER_HASH,
    closedRouteReceiptSha256: OTHER_HASH,
    closedRouteTerminalEvidenceSha256: HASH,
    applyAuthorizationReceiptSha256: HASH,
    applyOperationReceiptSha256: HASH,
    promotionOperationId: "11111111-1111-4111-8111-111111111111",
    promotionCommittedAt: "2026-08-14T00:03:00.000Z",
    quarantineReceiptSha256: null,
    pitrReceiptSha256: HASH,
    pitrObservedAt: "2026-08-14T00:04:00.000Z",
    logicalBackupManifestSha256: HASH,
    logicalBackupCreatedAt: "2026-08-14T00:04:30.000Z",
    offsiteSuccessStateSha256: HASH,
    offsiteCompletedAt: "2026-08-14T00:05:00.000Z",
    wormReceiptSha256: HASH,
    wormCompletedAt: "2026-08-14T00:05:30.000Z",
    privateStorageCaptureReceiptSha256: HASH,
    privateStorageCapturedAt: "2026-08-14T00:06:00.000Z",
    offsiteRetrievalReceiptSha256: HASH,
    offsiteRetrievedAt: "2026-08-14T00:07:00.000Z",
    logicalRestoreReceiptSha256: HASH,
    logicalRestoreRestoredAt: "2026-08-14T00:08:00.000Z",
    privateStorageRestoreReceiptSha256: HASH,
    privateStorageRestoredAt: "2026-08-14T00:09:00.000Z",
    deletionReplayFirstReceiptSha256: HASH,
    deletionReplaySecondReceiptSha256: OTHER_HASH,
    deletionReplayCompletedAt: "2026-08-14T00:10:00.000Z",
    recoveryTargetIdentitySha256: HASH,
    recoveryPointAt: "2026-08-14T00:04:30.000Z",
    rpoSeconds: 90,
    rtoSeconds: 180,
    reviewerApprovalSetSha256: HASH,
    reviewerIdSha256s: [HASH, OTHER_HASH],
    attestedAt: "2026-08-14T00:11:00.000Z",
    chronologySha256: HASH,
    checks: {
      authorityExact: true,
      candidateExact: true,
      productionDeploymentExact: true,
      productionScaleExact: true,
      closedRouteExact: true,
      promotionAuthorizationExact: true,
      promotionApplyExact: true,
      quarantineAbsent: true,
      pitrExact: true,
      logicalBackupExact: true,
      operationalOffsiteExact: true,
      wormIndependentReaderExact: true,
      privateStorageCaptureExact: true,
      offsiteRetrievalExact: true,
      disposableLogicalRestoreExact: true,
      disposablePrivateStorageRestoreExact: true,
      deletionReplayAppliedExact: true,
      deletionReplayIdempotentExact: true,
      transportAndRoleExact: true,
      recoveryStateBindingsExact: true,
      rpoRtoExact: true,
      twoPersonApprovalExact: true,
      chronologyExact: true,
    },
  });
}

describe("production promotion-recovery authority", () => {
  it("accepts an exact candidate-bound receipt and rejects external predecessor drift", () => {
    const receipt = validReceipt();
    const bytes = Buffer.from(canonicalPostgresBackupJson(receipt));
    const expectation = {
      expectedFileSha256: sha256ProductionPromotionRecoveryBytes(bytes),
      candidateSha: CANDIDATE,
      expectedCloseReceiptSha256: OTHER_HASH,
      expectedCloseTerminalSha256: HASH,
      expectedDeploymentIdSha256: HASH,
    };
    expect(verifyProductionPromotionRecoveryReceiptBytes(bytes, expectation)).toEqual(receipt);
    expect(() => verifyProductionPromotionRecoveryReceiptBytes(bytes, {
      ...expectation,
      expectedCloseReceiptSha256: HASH,
    })).toThrow("production_promotion_recovery_receipt_invalid");
    expect(() => verifyProductionPromotionRecoveryReceiptBytes(
      Buffer.from(JSON.stringify(receipt)),
      { ...expectation, expectedFileSha256: sha256ProductionPromotionRecoveryBytes(JSON.stringify(receipt)) },
    )).toThrow("production_promotion_recovery_receipt_invalid");
  });

  it("requires a current-UID mode-0600 single-link canonical receipt file", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-promotion-")));
    roots.push(root);
    fs.chmodSync(root, 0o700);
    const receipt = validReceipt();
    const bytes = Buffer.from(canonicalPostgresBackupJson(receipt));
    const filename = path.join(root, "receipt.json");
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
    const expectation = {
      receiptFile: filename,
      expectedUid: process.getuid!(),
      expectedFileSha256: sha256ProductionPromotionRecoveryBytes(bytes),
      candidateSha: CANDIDATE,
      expectedCloseReceiptSha256: OTHER_HASH,
      expectedCloseTerminalSha256: HASH,
      expectedDeploymentIdSha256: HASH,
    };
    expect(verifyProductionPromotionRecoveryReceiptFile(expectation)).toEqual(receipt);
    fs.chmodSync(filename, 0o640);
    expect(() => verifyProductionPromotionRecoveryReceiptFile(expectation)).toThrow(
      "production_promotion_recovery_receipt_invalid",
    );
  });

  it("verifies a protected Ed25519 approval over the exact authority file hash", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = Buffer.from(publicKey.export({ type: "spki", format: "pem" }));
    const payload = {
      schemaVersion: "pintpath-production-promotion-recovery-approval-payload/v1" as const,
      authorityManifestSha256: HASH,
      candidateSha: CANDIDATE,
      reviewerIdSha256: HASH,
      reviewerPublicKeySha256: sha256ProductionPromotionRecoveryBytes(publicKeyPem),
      approvedAt: "2026-08-14T00:11:00.000Z",
    };
    const approval = {
      schemaVersion: PRODUCTION_PROMOTION_RECOVERY_APPROVAL_SCHEMA,
      payload,
      signatureBase64: crypto.sign(
        null,
        Buffer.from(canonicalPostgresBackupJson(payload)),
        privateKey,
      ).toString("base64"),
    };
    expect(verifyProductionPromotionRecoveryApproval({
      approval, authorityManifestSha256: HASH, candidateSha: CANDIDATE, publicKeyPem,
    })).toEqual(approval);
    expect(() => verifyProductionPromotionRecoveryApproval({
      approval, authorityManifestSha256: OTHER_HASH, candidateSha: CANDIDATE, publicKeyPem,
    })).toThrow("approval authority mismatch");
  });

  it("rejects duplicate reviewer keys and invalid recovery chronology", () => {
    expect(() => productionPromotionRecoveryAuthoritySchema.parse({
      schemaVersion: PRODUCTION_PROMOTION_RECOVERY_AUTHORITY_SCHEMA,
      candidateSha: CANDIDATE,
      productionDeploymentReceiptSha256: HASH,
      productionDeploymentIdSha256: HASH,
      productionScaleReceiptSha256: HASH,
      closedRouteReceiptSha256: HASH,
      closedRouteTerminalEvidenceSha256: HASH,
      applyAuthorizationReceiptSha256: HASH,
      applyOperationReceiptSha256: HASH,
      pitrReceiptSha256: HASH,
      pitrObservedAt: "2026-08-14T00:04:00.000Z",
      logicalBackupManifestSha256: HASH,
      logicalOffsiteResultSha256: HASH,
      logicalWormResultSha256: HASH,
      privateStorageCaptureReceiptSha256: HASH,
      offsiteRetrievalReceiptSha256: HASH,
      logicalRestoreReceiptSha256: HASH,
      privateStorageRestoreReceiptSha256: HASH,
      deletionReplayFirstReceiptSha256: HASH,
      deletionReplaySecondReceiptSha256: HASH,
      recoveryPointAt: "2026-08-14T00:04:30.000Z",
      recoveryStartedAt: "2026-08-14T00:07:00.000Z",
      recoveryCompletedAt: "2026-08-14T00:06:00.000Z",
      rpoSeconds: 90,
      rtoSeconds: 1,
      reviewerPublicKeySha256s: [HASH, HASH],
    })).toThrow();
  });
});
