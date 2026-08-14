import crypto, { type KeyObject } from "node:crypto";

import { z } from "zod";

import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "../db/postgres-migration-schema.js";
import {
  postgresReviewedPricePromotionReviewPacketSchema,
} from "./postgres-reviewed-price-promotion-authority.js";
import {
  postgresReviewedPricePromotionPlanCandidateSchema,
  sha256PostgresReviewedPricePromotionValue,
} from "./postgres-reviewed-price-promotion-plan.js";

export const POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_PAYLOAD_KIND =
  "pintpath-postgres-reviewed-price-operation-approval-payload" as const;
export const POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_KIND =
  "pintpath-postgres-reviewed-price-operation-signed-approval" as const;
export const POSTGRES_REVIEWED_PRICE_OPERATION_RECEIPT_KIND =
  "pintpath-postgres-reviewed-price-operation-receipt" as const;
export const POSTGRES_REVIEWED_PRICE_OPERATION_AUTHORIZATION_RECEIPT_KIND =
  "pintpath-postgres-reviewed-price-operation-authorization-receipt" as const;
export const POSTGRES_REVIEWED_PRICE_OPERATION_REQUEST_VERSION = 1 as const;
export const POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_VERSION = 1 as const;
export const POSTGRES_REVIEWED_PRICE_OPERATION_RECEIPT_VERSION = 1 as const;
export const POSTGRES_REVIEWED_PRICE_OPERATION_MAX_APPROVAL_VALIDITY_MS =
  86_400_000 as const;
export const POSTGRES_REVIEWED_PRICE_OPERATION_MAX_PLAN_BYTES = 16 * 1_024 * 1_024;
export const POSTGRES_REVIEWED_PRICE_OPERATION_MAX_REVIEW_PACKET_BYTES =
  128 * 1_024 * 1_024;
export const POSTGRES_REVIEWED_PRICE_OPERATION_MAX_APPROVAL_BYTES = 128 * 1_024;
export const POSTGRES_REVIEWED_PRICE_OPERATION_MAX_RECEIPT_BYTES = 2 * 1_024 * 1_024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANDIDATE_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CANONICAL_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const candidateSchema = z.string().regex(CANDIDATE_PATTERN);
const uuidSchema = z.string().regex(UUID_PATTERN);
const canonicalUtcSchema = z.string().regex(CANONICAL_UTC_PATTERN).refine(
  (value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  },
);

export const postgresReviewedPriceOperationApprovalPayloadSchema = z.object({
  approvalReferenceSha256: sha256Schema,
  authorizationId: uuidSchema,
  authorityBundleSha256: sha256Schema,
  candidateSha: candidateSchema,
  deploymentBindingSha256: sha256Schema,
  evidenceAuthoritySha256: sha256Schema,
  expectedEnvironment: z.enum(["permanent-staging", "production"]),
  expiresAt: canonicalUtcSchema,
  issuedAt: canonicalUtcSchema,
  kind: z.literal(POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_PAYLOAD_KIND),
  operationId: uuidSchema,
  operationKind: z.enum(["apply", "quarantine"]),
  operatorIdSha256: sha256Schema,
  operatorLoginSha256: sha256Schema,
  planCandidateSha256: sha256Schema,
  planFileSha256: sha256Schema,
  recoveryAuthoritySha256: sha256Schema,
  reviewPacketCandidateSha256: sha256Schema,
  reviewPacketFileSha256: sha256Schema,
  reviewerIdSha256: sha256Schema,
  reviewerLoginSha256: sha256Schema,
  reviewerPublicKeySha256: sha256Schema,
  sourceApplyOperationId: uuidSchema.nullable(),
  sourceApplyReceiptFileSha256: sha256Schema.nullable(),
  sourceApplyReceiptSha256: sha256Schema.nullable(),
  sourceSnapshotSha256: sha256Schema,
  targetPhysicalIdentitySha256: sha256Schema,
  transportRootCaSha256: sha256Schema,
  version: z.literal(POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_VERSION),
}).strict().superRefine((value, context) => {
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (
    !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > POSTGRES_REVIEWED_PRICE_OPERATION_MAX_APPROVAL_VALIDITY_MS
  ) {
    context.addIssue({ code: "custom", message: "approval validity window mismatch" });
  }
  if (value.operatorIdSha256 === value.reviewerIdSha256) {
    context.addIssue({ code: "custom", message: "operator and reviewer must differ" });
  }
  if (value.operatorLoginSha256 === value.reviewerLoginSha256) {
    context.addIssue({ code: "custom", message: "operator and reviewer logins must differ" });
  }
  if (value.authorizationId === value.operationId) {
    context.addIssue({ code: "custom", message: "authorization and operation IDs must differ" });
  }
  const isApply = value.operationKind === "apply";
  const sourceValues = [
    value.sourceApplyOperationId,
    value.sourceApplyReceiptFileSha256,
    value.sourceApplyReceiptSha256,
  ];
  if (
    (isApply && sourceValues.some((entry) => entry !== null))
    || (!isApply && sourceValues.some((entry) => entry === null))
  ) {
    context.addIssue({ code: "custom", message: "source apply authority mismatch" });
  }
});

export type PostgresReviewedPriceOperationApprovalPayload = z.infer<
  typeof postgresReviewedPriceOperationApprovalPayloadSchema
>;

export const postgresReviewedPriceOperationApprovalSchema = z.object({
  kind: z.literal(POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_KIND),
  payload: postgresReviewedPriceOperationApprovalPayloadSchema,
  signatureBase64: z.string().min(1).max(256).regex(BASE64_PATTERN),
  version: z.literal(POSTGRES_REVIEWED_PRICE_OPERATION_APPROVAL_VERSION),
}).strict();

export type PostgresReviewedPriceOperationApproval = z.infer<
  typeof postgresReviewedPriceOperationApprovalSchema
>;

const receiptWithoutHashSchema = z.object({
  approvalFileSha256: sha256Schema,
  approvalReferenceSha256: sha256Schema,
  authorizationId: uuidSchema,
  authorityBundleSha256: sha256Schema,
  candidateSha: candidateSchema,
  committedAt: canonicalUtcSchema,
  expectedEnvironment: z.enum(["permanent-staging", "production"]),
  itemCount: z.number().int().min(1).max(50),
  kind: z.literal(POSTGRES_REVIEWED_PRICE_OPERATION_RECEIPT_KIND),
  operationId: uuidSchema,
  operationKind: z.enum(["apply", "quarantine"]),
  operatorIdSha256: sha256Schema,
  planCandidateSha256: sha256Schema,
  requestSha256: sha256Schema,
  requestedRowCount: z.number().int().min(1).max(5_000),
  resultStateSha256: sha256Schema,
  reviewPacketCandidateSha256: sha256Schema,
  reviewerIdSha256: sha256Schema,
  sourceApplyOperationId: uuidSchema.nullable(),
  sourceIngestionIds: z.array(uuidSchema).min(1).max(50),
  targetPhysicalIdentitySha256: sha256Schema,
  version: z.literal(POSTGRES_REVIEWED_PRICE_OPERATION_RECEIPT_VERSION),
}).strict().superRefine((value, context) => {
  if (
    (value.operationKind === "apply" && value.sourceApplyOperationId !== null)
    || (value.operationKind === "quarantine" && value.sourceApplyOperationId === null)
  ) {
    context.addIssue({ code: "custom", message: "receipt source operation mismatch" });
  }
  if (
    value.itemCount !== value.sourceIngestionIds.length
    || new Set(value.sourceIngestionIds).size !== value.sourceIngestionIds.length
    || value.sourceIngestionIds.some(
      (id, index) => index > 0 && value.sourceIngestionIds[index - 1]! >= id,
    )
  ) {
    context.addIssue({ code: "custom", message: "receipt source IDs mismatch" });
  }
});

export const postgresReviewedPriceOperationReceiptSchema =
  receiptWithoutHashSchema.extend({ receiptSha256: sha256Schema }).strict()
    .superRefine((value, context) => {
      const { receiptSha256, ...withoutHash } = value;
      if (sha256PostgresReviewedPriceOperationReceipt(withoutHash) !== receiptSha256) {
        context.addIssue({ code: "custom", message: "receipt hash mismatch" });
      }
    });

export type PostgresReviewedPriceOperationReceipt = z.infer<
  typeof postgresReviewedPriceOperationReceiptSchema
>;

export const postgresReviewedPriceOperationDatabaseResponseSchema = z.object({
  receipt: postgresReviewedPriceOperationReceiptSchema,
  replayed: z.boolean(),
}).strict();

export const postgresReviewedPriceOperationAuthorizationReceiptSchema = z.object({
  approvalFileSha256: sha256Schema,
  approvalPayloadSha256: sha256Schema,
  authorizationId: uuidSchema,
  authorizedAt: canonicalUtcSchema,
  kind: z.literal(POSTGRES_REVIEWED_PRICE_OPERATION_AUTHORIZATION_RECEIPT_KIND),
  operationId: uuidSchema,
  operationKind: z.enum(["apply", "quarantine"]),
  reviewerIdSha256: sha256Schema,
  version: z.literal(POSTGRES_REVIEWED_PRICE_OPERATION_RECEIPT_VERSION),
}).strict();

export type PostgresReviewedPriceOperationAuthorizationReceipt = z.infer<
  typeof postgresReviewedPriceOperationAuthorizationReceiptSchema
>;

export const postgresReviewedPriceOperationAuthorizationResponseSchema = z.object({
  authorization: postgresReviewedPriceOperationAuthorizationReceiptSchema,
  replayed: z.boolean(),
}).strict();

export interface PostgresReviewedPriceOperationArtifactInput {
  readonly approvalBytes: Buffer;
  readonly approvalFileSha256: string;
  readonly applyReceiptBytes?: Buffer;
  readonly applyReceiptFileSha256?: string;
  readonly expectedApprovalFileSha256: string;
  readonly expectedApplyReceiptFileSha256?: string;
  readonly expectedPlanFileSha256: string;
  readonly expectedReviewPacketFileSha256: string;
  readonly expectedReviewerPublicKeySha256: string;
  readonly expectedRootCaSha256: string;
  readonly now: Date;
  readonly operatorLogin?: string;
  readonly planBytes: Buffer;
  readonly planFileSha256: string;
  readonly reviewPacketBytes: Buffer;
  readonly reviewPacketFileSha256: string;
  readonly reviewerPublicKey: KeyObject;
  readonly reviewerPublicKeyBytes: Buffer;
  readonly reviewerLogin?: string;
}

export interface PostgresReviewedPriceOperationRequest {
  readonly approvalEnvelopeCanonical: string;
  readonly approvalFileSha256: string;
  readonly approvalPayloadCanonical: string;
  readonly approvalSignatureSha256: string;
  readonly operationId: string;
  readonly operationKind: "apply" | "quarantine";
  readonly planCandidateCanonical: string;
  readonly planCanonical: string;
  readonly reviewPacketCandidateCanonical: string;
  readonly reviewPacketCanonical: string;
  readonly sourceApplyReceiptCanonical: string | null;
  readonly version: typeof POSTGRES_REVIEWED_PRICE_OPERATION_REQUEST_VERSION;
}

export interface ValidatedPostgresReviewedPriceOperation {
  readonly approval: PostgresReviewedPriceOperationApproval;
  readonly request: PostgresReviewedPriceOperationRequest;
}

export class PostgresReviewedPriceOperationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PostgresReviewedPriceOperationError";
  }
}

function fail(code: string): never {
  throw new PostgresReviewedPriceOperationError(code);
}

function canonicalBytes(value: unknown): Buffer {
  return serializeCanonicalPostgresMigrationJson(value);
}

function exactCanonicalArtifact<Value>(
  bytes: Buffer,
  maximumBytes: number,
  schema: z.ZodType<Value>,
  code: string,
): Value {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > maximumBytes) fail(code);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail(code);
  }
  const result = schema.safeParse(parsed);
  if (!result.success || !bytes.equals(canonicalBytes(result.data))) fail(code);
  return result.data;
}

function sha256PostgresReviewedPriceDatabaseLogin(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) fail("database_login_invalid");
  return sha256PostgresMigrationBytes(
    `pintpath-reviewed-price-database-login-v1\0${value}`,
  );
}

export function sha256PostgresReviewedPriceOperatorLogin(value: string): string {
  return sha256PostgresReviewedPriceDatabaseLogin(value);
}

export function sha256PostgresReviewedPriceReviewerLogin(value: string): string {
  return sha256PostgresReviewedPriceDatabaseLogin(value);
}

export function postgresReviewedPriceDeploymentBindingSha256(
  plan: z.infer<typeof postgresReviewedPricePromotionPlanCandidateSchema>,
): string {
  return sha256PostgresReviewedPricePromotionValue(plan.expectedDeployment);
}

export function postgresReviewedPriceEvidenceAuthoritySha256(
  plan: z.infer<typeof postgresReviewedPricePromotionPlanCandidateSchema>,
  packet: z.infer<typeof postgresReviewedPricePromotionReviewPacketSchema>,
): string {
  return sha256PostgresReviewedPricePromotionValue({
    evidenceSetSha256: plan.privateInput.evidenceSetSha256,
    items: packet.items.map((item) => ({
      evidenceContentSha256: item.evidenceContentSha256,
      evidenceReferenceSha256: item.evidenceReferenceSha256,
      sourceIngestionId: item.sourceIngestionId,
    })),
    privateInputManifestSha256: packet.privateInputManifestSha256,
  });
}

export function sha256PostgresReviewedPriceOperationReceipt(
  receipt: z.infer<typeof receiptWithoutHashSchema>,
): string {
  const parsed = receiptWithoutHashSchema.parse(receipt);
  const fields = [
    "pintpath-reviewed-price-operation-receipt-v1",
    parsed.operationKind,
    parsed.authorizationId,
    parsed.operationId,
    parsed.sourceApplyOperationId ?? "",
    parsed.requestSha256,
    parsed.resultStateSha256,
    parsed.committedAt,
    String(parsed.requestedRowCount),
    parsed.sourceIngestionIds.join(","),
    parsed.approvalFileSha256,
  ];
  return sha256PostgresMigrationBytes(fields.join("\x1f"));
}

export function validatePostgresReviewedPriceOperationArtifacts(
  input: PostgresReviewedPriceOperationArtifactInput,
): ValidatedPostgresReviewedPriceOperation {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) fail("clock_invalid");
  if (
    (input.operatorLogin === undefined && input.reviewerLogin === undefined)
    || (input.operatorLogin !== undefined && input.reviewerLogin !== undefined)
  ) fail("database_login_authority_invalid");
  const expectedHashes = [
    input.expectedApprovalFileSha256,
    input.expectedPlanFileSha256,
    input.expectedReviewPacketFileSha256,
    input.expectedReviewerPublicKeySha256,
    input.expectedRootCaSha256,
    input.approvalFileSha256,
    input.planFileSha256,
    input.reviewPacketFileSha256,
  ];
  if (expectedHashes.some((hash) => !SHA256_PATTERN.test(hash))) fail("hash_invalid");
  if (
    input.approvalFileSha256 !== input.expectedApprovalFileSha256
    || input.planFileSha256 !== input.expectedPlanFileSha256
    || input.reviewPacketFileSha256 !== input.expectedReviewPacketFileSha256
    || sha256PostgresMigrationBytes(input.reviewerPublicKeyBytes)
      !== input.expectedReviewerPublicKeySha256
  ) fail("artifact_hash_mismatch");

  const plan = exactCanonicalArtifact(
    input.planBytes,
    POSTGRES_REVIEWED_PRICE_OPERATION_MAX_PLAN_BYTES,
    postgresReviewedPricePromotionPlanCandidateSchema,
    "plan_invalid",
  );
  const packet = exactCanonicalArtifact(
    input.reviewPacketBytes,
    POSTGRES_REVIEWED_PRICE_OPERATION_MAX_REVIEW_PACKET_BYTES,
    postgresReviewedPricePromotionReviewPacketSchema,
    "review_packet_invalid",
  );
  const approval = exactCanonicalArtifact(
    input.approvalBytes,
    POSTGRES_REVIEWED_PRICE_OPERATION_MAX_APPROVAL_BYTES,
    postgresReviewedPriceOperationApprovalSchema,
    "approval_invalid",
  );
  const payload = approval.payload;
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  const now = input.now.getTime();
  if (now < issuedAt || now > expiresAt) fail("approval_expired");
  if (
    input.reviewerPublicKey.asymmetricKeyType !== "ed25519"
    || payload.reviewerPublicKeySha256 !== input.expectedReviewerPublicKeySha256
  ) fail("reviewer_key_invalid");
  const signature = Buffer.from(approval.signatureBase64, "base64");
  if (
    signature.length !== 64
    || !crypto.verify(null, canonicalBytes(payload), input.reviewerPublicKey, signature)
  ) fail("approval_signature_invalid");

  if (
    payload.planFileSha256 !== input.planFileSha256
    || payload.reviewPacketFileSha256 !== input.reviewPacketFileSha256
    || payload.planCandidateSha256 !== plan.planCandidateSha256
    || payload.reviewPacketCandidateSha256 !== packet.reviewPacketCandidateSha256
    || payload.authorityBundleSha256 !== plan.authority.authorityBundleSha256
    || payload.authorityBundleSha256 !== packet.authorityBundleSha256
    || payload.candidateSha !== plan.candidateSha
    || payload.candidateSha !== packet.candidateSha
    || payload.expectedEnvironment !== plan.expectedEnvironment
    || payload.expectedEnvironment !== packet.expectedEnvironment
    || payload.targetPhysicalIdentitySha256 !== plan.target.physicalIdentitySha256
    || payload.targetPhysicalIdentitySha256 !== packet.targetPhysicalIdentitySha256
    || payload.sourceSnapshotSha256 !== plan.sourceSnapshot.combinedSha256
    || payload.sourceSnapshotSha256 !== packet.sourceSnapshotSha256
    || payload.deploymentBindingSha256 !== postgresReviewedPriceDeploymentBindingSha256(plan)
    || payload.evidenceAuthoritySha256
      !== postgresReviewedPriceEvidenceAuthoritySha256(plan, packet)
    || payload.recoveryAuthoritySha256 !== plan.authority.recoveryReferencesSha256
    || payload.transportRootCaSha256 !== input.expectedRootCaSha256
    || (input.operatorLogin !== undefined && payload.operatorLoginSha256
      !== sha256PostgresReviewedPriceOperatorLogin(input.operatorLogin))
    || (input.reviewerLogin !== undefined && payload.reviewerLoginSha256
      !== sha256PostgresReviewedPriceReviewerLogin(input.reviewerLogin))
  ) fail("approval_binding_mismatch");

  let sourceApplyReceiptCanonical: string | null = null;
  if (payload.operationKind === "apply") {
    if (input.applyReceiptBytes || input.applyReceiptFileSha256) fail("source_receipt_unexpected");
  } else {
    if (
      !input.applyReceiptBytes
      || !input.applyReceiptFileSha256
      || !input.expectedApplyReceiptFileSha256
      || input.applyReceiptFileSha256 !== input.expectedApplyReceiptFileSha256
      || payload.sourceApplyReceiptFileSha256 !== input.applyReceiptFileSha256
    ) fail("source_receipt_invalid");
    const sourceReceipt = exactCanonicalArtifact(
      input.applyReceiptBytes,
      POSTGRES_REVIEWED_PRICE_OPERATION_MAX_RECEIPT_BYTES,
      postgresReviewedPriceOperationReceiptSchema,
      "source_receipt_invalid",
    );
    if (
      sourceReceipt.operationKind !== "apply"
      || sourceReceipt.operationId !== payload.sourceApplyOperationId
      || sourceReceipt.receiptSha256 !== payload.sourceApplyReceiptSha256
      || sourceReceipt.planCandidateSha256 !== plan.planCandidateSha256
      || sourceReceipt.reviewPacketCandidateSha256 !== packet.reviewPacketCandidateSha256
      || sourceReceipt.candidateSha !== plan.candidateSha
      || sourceReceipt.targetPhysicalIdentitySha256 !== plan.target.physicalIdentitySha256
    ) fail("source_receipt_binding_mismatch");
    sourceApplyReceiptCanonical = input.applyReceiptBytes.toString("utf8");
  }

  const { planCandidateSha256: _planHash, ...planCandidate } = plan;
  const { reviewPacketCandidateSha256: _packetHash, ...packetCandidate } = packet;
  return {
    approval,
    request: {
      approvalEnvelopeCanonical: input.approvalBytes.toString("utf8"),
      approvalFileSha256: input.approvalFileSha256,
      approvalPayloadCanonical: canonicalBytes(payload).toString("utf8"),
      approvalSignatureSha256: sha256PostgresMigrationBytes(signature),
      operationId: payload.operationId,
      operationKind: payload.operationKind,
      planCandidateCanonical: canonicalBytes(planCandidate).toString("utf8"),
      planCanonical: input.planBytes.toString("utf8"),
      reviewPacketCandidateCanonical: canonicalBytes(packetCandidate).toString("utf8"),
      reviewPacketCanonical: input.reviewPacketBytes.toString("utf8"),
      sourceApplyReceiptCanonical,
      version: POSTGRES_REVIEWED_PRICE_OPERATION_REQUEST_VERSION,
    },
  };
}
