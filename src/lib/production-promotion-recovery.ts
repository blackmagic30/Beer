import crypto from "node:crypto";

import { z } from "zod";

import { canonicalPostgresBackupJson } from "./postgres-logical-backup.js";

export const PRODUCTION_PROMOTION_RECOVERY_AUTHORITY_SCHEMA =
  "pintpath-production-promotion-recovery-authority/v1" as const;
export const PRODUCTION_PROMOTION_RECOVERY_APPROVAL_SCHEMA =
  "pintpath-production-promotion-recovery-signed-approval/v1" as const;
export const PRODUCTION_PROMOTION_RECOVERY_RECEIPT_SCHEMA =
  "pintpath-production-promotion-recovery-receipt/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE = /^[a-f0-9]{40}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const sha = z.string().regex(SHA256);
const candidate = z.string().regex(CANDIDATE);
const timestamp = z.string().datetime({ offset: false, precision: 3 }).refine(
  (value) => new Date(value).toISOString() === value,
);

export const productionPromotionRecoveryAuthoritySchema = z.object({
  schemaVersion: z.literal(PRODUCTION_PROMOTION_RECOVERY_AUTHORITY_SCHEMA),
  candidateSha: candidate,
  productionDeploymentReceiptSha256: sha,
  productionDeploymentIdSha256: sha,
  productionScaleReceiptSha256: sha,
  closedRouteReceiptSha256: sha,
  closedRouteTerminalEvidenceSha256: sha,
  applyAuthorizationReceiptSha256: sha,
  applyOperationReceiptSha256: sha,
  pitrReceiptSha256: sha,
  pitrObservedAt: timestamp,
  logicalBackupManifestSha256: sha,
  logicalOffsiteResultSha256: sha,
  logicalWormResultSha256: sha,
  privateStorageCaptureReceiptSha256: sha,
  offsiteRetrievalReceiptSha256: sha,
  logicalRestoreReceiptSha256: sha,
  privateStorageRestoreReceiptSha256: sha,
  deletionReplayFirstReceiptSha256: sha,
  deletionReplaySecondReceiptSha256: sha,
  recoveryPointAt: timestamp,
  recoveryStartedAt: timestamp,
  recoveryCompletedAt: timestamp,
  rpoSeconds: z.number().int().min(0).max(3_600),
  rtoSeconds: z.number().int().min(1).max(14_400),
  reviewerPublicKeySha256s: z.tuple([sha, sha]).refine(
    ([first, second]) => first < second,
    "reviewer public keys must be distinct and bytewise sorted",
  ),
}).strict().superRefine((value, context) => {
  const recoveryPoint = Date.parse(value.recoveryPointAt);
  const started = Date.parse(value.recoveryStartedAt);
  const completed = Date.parse(value.recoveryCompletedAt);
  if (
    recoveryPoint > started
    || started >= completed
    || Math.floor((completed - started) / 1_000) !== value.rtoSeconds
  ) context.addIssue({ code: "custom", message: "RPO/RTO chronology mismatch" });
});

export type ProductionPromotionRecoveryAuthority = z.infer<
  typeof productionPromotionRecoveryAuthoritySchema
>;

export const productionPromotionRecoveryApprovalSchema = z.object({
  schemaVersion: z.literal(PRODUCTION_PROMOTION_RECOVERY_APPROVAL_SCHEMA),
  payload: z.object({
    schemaVersion: z.literal("pintpath-production-promotion-recovery-approval-payload/v1"),
    authorityManifestSha256: sha,
    candidateSha: candidate,
    reviewerIdSha256: sha,
    reviewerPublicKeySha256: sha,
    approvedAt: timestamp,
  }).strict(),
  signatureBase64: z.string().min(1).max(256).regex(BASE64),
}).strict();

export type ProductionPromotionRecoveryApproval = z.infer<
  typeof productionPromotionRecoveryApprovalSchema
>;

export const productionPromotionRecoveryChecksSchema = z.object({
  authorityExact: z.literal(true),
  candidateExact: z.literal(true),
  productionDeploymentExact: z.literal(true),
  productionScaleExact: z.literal(true),
  closedRouteExact: z.literal(true),
  promotionAuthorizationExact: z.literal(true),
  promotionApplyExact: z.literal(true),
  quarantineAbsent: z.literal(true),
  pitrExact: z.literal(true),
  logicalBackupExact: z.literal(true),
  operationalOffsiteExact: z.literal(true),
  wormIndependentReaderExact: z.literal(true),
  privateStorageCaptureExact: z.literal(true),
  offsiteRetrievalExact: z.literal(true),
  disposableLogicalRestoreExact: z.literal(true),
  disposablePrivateStorageRestoreExact: z.literal(true),
  deletionReplayAppliedExact: z.literal(true),
  deletionReplayIdempotentExact: z.literal(true),
  transportAndRoleExact: z.literal(true),
  recoveryStateBindingsExact: z.literal(true),
  rpoRtoExact: z.literal(true),
  twoPersonApprovalExact: z.literal(true),
  chronologyExact: z.literal(true),
}).strict();

const receiptWithoutHashSchema = z.object({
  schemaVersion: z.literal(PRODUCTION_PROMOTION_RECOVERY_RECEIPT_SCHEMA),
  outcome: z.literal("verified"),
  candidateSha: candidate,
  githubEnvironment: z.literal("production-promotion-recovery"),
  policySha256: sha,
  authorityManifestSha256: sha,
  productionDeploymentReceiptSha256: sha,
  productionDeploymentIdSha256: sha,
  productionScaleReceiptSha256: sha,
  closedRouteReceiptSha256: sha,
  closedRouteTerminalEvidenceSha256: sha,
  applyAuthorizationReceiptSha256: sha,
  applyOperationReceiptSha256: sha,
  promotionOperationId: z.string().uuid(),
  promotionCommittedAt: timestamp,
  quarantineReceiptSha256: z.null(),
  pitrReceiptSha256: sha,
  pitrObservedAt: timestamp,
  logicalBackupManifestSha256: sha,
  logicalBackupCreatedAt: timestamp,
  offsiteSuccessStateSha256: sha,
  offsiteCompletedAt: timestamp,
  wormReceiptSha256: sha,
  wormCompletedAt: timestamp,
  privateStorageCaptureReceiptSha256: sha,
  privateStorageCapturedAt: timestamp,
  offsiteRetrievalReceiptSha256: sha,
  offsiteRetrievedAt: timestamp,
  logicalRestoreReceiptSha256: sha,
  logicalRestoreRestoredAt: timestamp,
  privateStorageRestoreReceiptSha256: sha,
  privateStorageRestoredAt: timestamp,
  deletionReplayFirstReceiptSha256: sha,
  deletionReplaySecondReceiptSha256: sha,
  deletionReplayCompletedAt: timestamp,
  recoveryTargetIdentitySha256: sha,
  recoveryPointAt: timestamp,
  rpoSeconds: z.number().int().min(0).max(3_600),
  rtoSeconds: z.number().int().min(1).max(14_400),
  reviewerApprovalSetSha256: sha,
  reviewerIdSha256s: z.tuple([sha, sha]).refine(
    ([first, second]) => first < second,
    "reviewer IDs must be distinct and bytewise sorted",
  ),
  attestedAt: timestamp,
  chronologySha256: sha,
  checks: productionPromotionRecoveryChecksSchema,
}).strict();

export const productionPromotionRecoveryReceiptSchema = receiptWithoutHashSchema.extend({
  receiptSha256: sha,
}).strict().superRefine((value, context) => {
  const { receiptSha256, ...withoutHash } = value;
  if (sha256ProductionPromotionRecoveryValue(withoutHash) !== receiptSha256) {
    context.addIssue({ code: "custom", message: "receipt hash mismatch" });
  }
});

export type ProductionPromotionRecoveryReceipt = z.infer<
  typeof productionPromotionRecoveryReceiptSchema
>;
export type ProductionPromotionRecoveryReceiptWithoutHash = z.infer<
  typeof receiptWithoutHashSchema
>;

export function sha256ProductionPromotionRecoveryBytes(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256ProductionPromotionRecoveryValue(value: unknown): string {
  return sha256ProductionPromotionRecoveryBytes(canonicalPostgresBackupJson(value));
}

export function buildProductionPromotionRecoveryReceipt(
  value: ProductionPromotionRecoveryReceiptWithoutHash,
): ProductionPromotionRecoveryReceipt {
  const checked = receiptWithoutHashSchema.parse(value);
  return productionPromotionRecoveryReceiptSchema.parse({
    ...checked,
    receiptSha256: sha256ProductionPromotionRecoveryValue(checked),
  });
}

export function parseProductionPromotionRecoveryReceipt(
  value: unknown,
): ProductionPromotionRecoveryReceipt {
  return productionPromotionRecoveryReceiptSchema.parse(value);
}

export function verifyProductionPromotionRecoveryApproval(input: {
  readonly approval: unknown;
  readonly authorityManifestSha256: string;
  readonly candidateSha: string;
  readonly publicKeyPem: Buffer;
}): ProductionPromotionRecoveryApproval {
  const approval = productionPromotionRecoveryApprovalSchema.parse(input.approval);
  const publicKeySha256 = sha256ProductionPromotionRecoveryBytes(input.publicKeyPem);
  if (
    approval.payload.authorityManifestSha256 !== input.authorityManifestSha256
    || approval.payload.candidateSha !== input.candidateSha
    || approval.payload.reviewerPublicKeySha256 !== publicKeySha256
  ) throw new Error("approval authority mismatch");
  const key = crypto.createPublicKey(input.publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("approval key mismatch");
  const signature = Buffer.from(approval.signatureBase64, "base64");
  const payload = Buffer.from(canonicalPostgresBackupJson(approval.payload), "utf8");
  if (!crypto.verify(null, payload, key, signature)) throw new Error("approval signature mismatch");
  return approval;
}
