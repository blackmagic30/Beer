import crypto from "node:crypto";

import { z } from "zod";

import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "./postgres-migration-schema.js";

export const POSTGRES_MIGRATION_RECEIPT_KIND =
  "pint-path-postgres-migration-receipt" as const;
export const POSTGRES_MIGRATION_RECEIPT_VERSION = 3 as const;
export const POSTGRES_MIGRATION_VERIFICATION_APPROVAL_KIND =
  "pint-path-postgres-migration-verification-approval" as const;
export const POSTGRES_MIGRATION_VERIFICATION_APPROVAL_VERSION = 1 as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANDIDATE_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha256Schema = z.string().regex(SHA256_PATTERN);
const timestampSchema = z.string().datetime({ offset: false, precision: 3 }).refine(
  (value) => new Date(value).toISOString() === value,
);

export const postgresMigrationTargetIdentitySchema = z.object({
  currentUser: z.string().min(1).max(128).refine((value) => !/[\r\n\0]/.test(value)),
  databaseName: z.string().min(1).max(128).refine((value) => !/[\r\n\0]/.test(value)),
  databaseOid: z.string().regex(/^\d+$/),
  serverVersionNum: z.string().regex(/^\d+$/),
  sessionUser: z.string().min(1).max(128).refine((value) => !/[\r\n\0]/.test(value)),
  systemIdentifier: z.string().regex(/^\d+$/),
}).strict();

export type PostgresMigrationTargetIdentity = z.infer<
  typeof postgresMigrationTargetIdentitySchema
>;

export function sha256PostgresMigrationTargetIdentity(
  value: PostgresMigrationTargetIdentity,
): string {
  const parsed = postgresMigrationTargetIdentitySchema.parse(value);
  return sha256PostgresMigrationBytes(serializeCanonicalPostgresMigrationJson(parsed));
}

export const postgresMigrationTransportAuthoritySchema = z.object({
  expectedRootCaDerSha256: sha256Schema,
  profile: z.literal("railway-stock-localhost-ca-v1"),
  sourceUrlAuthority: z.object({
    hostname: z.string().regex(
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.railway\.internal$/,
    ),
    port: z.literal(5432),
  }).strict(),
}).strict();

export type PostgresMigrationTransportAuthority = z.infer<
  typeof postgresMigrationTransportAuthoritySchema
>;

export function sha256PostgresMigrationTransportAuthority(
  value: PostgresMigrationTransportAuthority,
): string {
  const parsed = postgresMigrationTransportAuthoritySchema.parse(value);
  return sha256PostgresMigrationBytes(
    serializeCanonicalPostgresMigrationJson(parsed),
  );
}

export const postgresMigrationRunBindingSchema = z.object({
  approvalReferenceSha256: sha256Schema,
  candidateSha: z.string().regex(CANDIDATE_PATTERN),
  contractSha256: sha256Schema,
  expectedEnvironment: z.enum(["permanent-staging", "production"]),
  manifestSha256: sha256Schema,
  operatorIdSha256: sha256Schema,
  planSha256: sha256Schema,
  sourceSchemaFingerprint: sha256Schema,
  sourceSchemaVersion: z.number().int().positive(),
  sourceSnapshotSha256: sha256Schema,
  targetDdlSha256: sha256Schema,
  targetIdentitySha256: sha256Schema,
  liveSchemaSha256: sha256Schema,
  transportAuthoritySha256: sha256Schema,
  targetUrlSha256: sha256Schema,
  verifierIdSha256: sha256Schema,
  verifierAuthoritySha256: sha256Schema,
  verifierAuthorityPolicySha256: sha256Schema,
  verifierPublicKeySha256: sha256Schema,
}).strict();

export type PostgresMigrationRunBinding = z.infer<
  typeof postgresMigrationRunBindingSchema
>;

export function sha256PostgresMigrationRunBinding(
  value: PostgresMigrationRunBinding,
): string {
  const parsed = postgresMigrationRunBindingSchema.parse(value);
  return sha256PostgresMigrationBytes(serializeCanonicalPostgresMigrationJson(parsed));
}

export function derivePostgresMigrationRunId(runBindingSha256: string): string {
  const parsed = sha256Schema.parse(runBindingSha256);
  return sha256PostgresMigrationBytes(`pint-path-postgres-migration-run-v1\0${parsed}`);
}

export const postgresMigrationReadyMetadataSchema = z.object({
  import_state: z.literal("ready"),
  migration_candidate_sha: z.string().regex(CANDIDATE_PATTERN),
  migration_contract_sha256: sha256Schema,
  migration_manifest_sha256: sha256Schema,
  migration_plan_sha256: sha256Schema,
  migration_run_sha256: sha256Schema,
  source_schema_fingerprint: sha256Schema,
  source_schema_version: z.string().regex(/^[1-9]\d*$/),
  source_snapshot_sha256: sha256Schema,
  target_ddl_sha256: sha256Schema,
  live_schema_sha256: sha256Schema,
}).strict();

export type PostgresMigrationReadyMetadata = z.infer<
  typeof postgresMigrationReadyMetadataSchema
>;

export function buildPostgresMigrationReadyMetadata(
  value: PostgresMigrationReadyMetadata,
): PostgresMigrationReadyMetadata {
  return postgresMigrationReadyMetadataSchema.parse(value);
}

export function sha256PostgresMigrationReadyMetadata(
  value: PostgresMigrationReadyMetadata,
): string {
  const parsed = postgresMigrationReadyMetadataSchema.parse(value);
  return sha256PostgresMigrationBytes(serializeCanonicalPostgresMigrationJson(parsed));
}

export const postgresMigrationReceiptWithoutHashSchema = z.object({
  kind: z.literal(POSTGRES_MIGRATION_RECEIPT_KIND),
  version: z.literal(POSTGRES_MIGRATION_RECEIPT_VERSION),
  status: z.literal("ready"),
  expectedEnvironment: z.enum(["permanent-staging", "production"]),
  approvalReferenceSha256: sha256Schema,
  operatorIdSha256: sha256Schema,
  verifierIdSha256: sha256Schema,
  verifierAuthoritySha256: sha256Schema,
  verifierAuthorityPolicySha256: sha256Schema,
  runIdSha256: sha256Schema,
  runBindingSha256: sha256Schema,
  targetIdentitySha256: sha256Schema,
  transportAuthoritySha256: sha256Schema,
  targetUrlSha256: sha256Schema,
  targetDdlSha256: sha256Schema,
  liveSchemaSha256: sha256Schema,
  sourceSnapshotSha256: sha256Schema,
  sourceSchemaFingerprint: sha256Schema,
  contractSha256: sha256Schema,
  manifestSha256: sha256Schema,
  planSha256: sha256Schema,
  candidateSha: z.string().regex(CANDIDATE_PATTERN),
  tableSetSha256: sha256Schema,
  transformedDataSha256: sha256Schema,
  keyRangesSha256: sha256Schema,
  stateTotalsSha256: sha256Schema,
  schemaMetadataSha256: sha256Schema,
  tableCount: z.number().int().positive(),
  columnCount: z.number().int().positive(),
  rowCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  zeroRowTableCount: z.number().int().nonnegative(),
  foreignKeyCount: z.number().int().nonnegative(),
  applyReceiptSha256: sha256Schema,
  verificationApprovalFileSha256: sha256Schema,
  verifierPublicKeySha256: sha256Schema,
  verifiedAt: timestampSchema,
}).strict();

const postgresMigrationApplyReceiptWithoutHashSchema =
  postgresMigrationReceiptWithoutHashSchema.omit({
    applyReceiptSha256: true,
    verificationApprovalFileSha256: true,
    verifierPublicKeySha256: true,
    verifiedAt: true,
  }).extend({
    status: z.literal("awaiting-verification"),
  }).strict();

export const postgresMigrationApplyReceiptSchema =
  postgresMigrationApplyReceiptWithoutHashSchema.extend({
    receiptSha256: sha256Schema,
  }).strict().superRefine((value, context) => {
    const { receiptSha256, ...withoutReceiptSha256 } = value;
    const expected = sha256PostgresMigrationBytes(
      serializeCanonicalPostgresMigrationJson(withoutReceiptSha256),
    );
    if (receiptSha256 !== expected) {
      context.addIssue({ code: "custom", message: "apply receipt hash mismatch" });
    }
  });

export type PostgresMigrationApplyReceiptWithoutHash = z.infer<
  typeof postgresMigrationApplyReceiptWithoutHashSchema
>;
export type PostgresMigrationApplyReceipt = z.infer<
  typeof postgresMigrationApplyReceiptSchema
>;

export function finalizePostgresMigrationApplyReceipt(
  value: PostgresMigrationApplyReceiptWithoutHash,
): PostgresMigrationApplyReceipt {
  const withoutReceiptSha256 = postgresMigrationApplyReceiptWithoutHashSchema.parse(value);
  return postgresMigrationApplyReceiptSchema.parse({
    ...withoutReceiptSha256,
    receiptSha256: sha256PostgresMigrationBytes(
      serializeCanonicalPostgresMigrationJson(withoutReceiptSha256),
    ),
  });
}

export const postgresMigrationVerificationApprovalSchema = z.object({
  kind: z.literal(POSTGRES_MIGRATION_VERIFICATION_APPROVAL_KIND),
  version: z.literal(POSTGRES_MIGRATION_VERIFICATION_APPROVAL_VERSION),
  payload: z.object({
    applyReceiptSha256: sha256Schema,
    approvedAt: timestampSchema,
    candidateSha: z.string().regex(CANDIDATE_PATTERN),
    expectedEnvironment: z.enum(["permanent-staging", "production"]),
    expiresAt: timestampSchema,
    liveSchemaSha256: sha256Schema,
    targetIdentitySha256: sha256Schema,
    verifierIdSha256: sha256Schema,
    verifierAuthoritySha256: sha256Schema,
    verifierAuthorityPolicySha256: sha256Schema,
    verifierPublicKeySha256: sha256Schema,
  }).strict(),
  signatureBase64: z.string().min(1).max(256).regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
  ),
}).strict();

export type PostgresMigrationVerificationApproval = z.infer<
  typeof postgresMigrationVerificationApprovalSchema
>;

export function verifyPostgresMigrationVerificationApproval(input: {
  readonly approval: unknown;
  readonly approvalFileSha256: string;
  readonly applyReceipt: PostgresMigrationApplyReceipt;
  readonly expectedApprovalFileSha256: string;
  readonly expectedVerifierPublicKeySha256: string;
  readonly expectedVerifierAuthoritySha256: string;
  readonly expectedVerifierAuthorityPolicySha256: string;
  readonly now: Date;
  readonly verifierPublicKeyBytes: Buffer;
}): PostgresMigrationVerificationApproval {
  const approval = postgresMigrationVerificationApprovalSchema.parse(input.approval);
  const applyReceipt = postgresMigrationApplyReceiptSchema.parse(input.applyReceipt);
  const publicKeySha256 = sha256PostgresMigrationBytes(input.verifierPublicKeyBytes);
  const approvedAt = Date.parse(approval.payload.approvedAt);
  const expiresAt = Date.parse(approval.payload.expiresAt);
  const now = input.now.getTime();
  if (
    !Number.isFinite(now)
    || input.approvalFileSha256 !== input.expectedApprovalFileSha256
    || publicKeySha256 !== input.expectedVerifierPublicKeySha256
    || approval.payload.verifierPublicKeySha256 !== publicKeySha256
    || approval.payload.verifierAuthoritySha256
      !== input.expectedVerifierAuthoritySha256
    || approval.payload.verifierAuthorityPolicySha256
      !== input.expectedVerifierAuthorityPolicySha256
    || approval.payload.verifierAuthoritySha256
      !== applyReceipt.verifierAuthoritySha256
    || approval.payload.verifierAuthorityPolicySha256
      !== applyReceipt.verifierAuthorityPolicySha256
    || approval.payload.applyReceiptSha256 !== applyReceipt.receiptSha256
    || approval.payload.candidateSha !== applyReceipt.candidateSha
    || approval.payload.expectedEnvironment !== applyReceipt.expectedEnvironment
    || approval.payload.liveSchemaSha256 !== applyReceipt.liveSchemaSha256
    || approval.payload.targetIdentitySha256 !== applyReceipt.targetIdentitySha256
    || approval.payload.verifierIdSha256 !== applyReceipt.verifierIdSha256
    || approvedAt > now
    || expiresAt < now
    || approvedAt >= expiresAt
    || expiresAt - approvedAt > 24 * 60 * 60 * 1_000
  ) {
    throw new TypeError("Postgres migration verification approval authority mismatch.");
  }
  const publicKey = crypto.createPublicKey(input.verifierPublicKeyBytes);
  const signature = Buffer.from(approval.signatureBase64, "base64");
  if (
    publicKey.asymmetricKeyType !== "ed25519"
    || signature.length !== 64
    || !crypto.verify(
      null,
      serializeCanonicalPostgresMigrationJson(approval.payload),
      publicKey,
      signature,
    )
  ) {
    throw new TypeError("Postgres migration verification signature mismatch.");
  }
  return approval;
}

export const postgresMigrationReceiptSchema = postgresMigrationReceiptWithoutHashSchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { receiptSha256, ...withoutReceiptSha256 } = value;
  const expected = sha256PostgresMigrationBytes(
    serializeCanonicalPostgresMigrationJson(withoutReceiptSha256),
  );
  if (receiptSha256 !== expected) {
    context.addIssue({ code: "custom", message: "receipt hash mismatch" });
  }
  if (
    value.zeroRowTableCount > value.tableCount
    || value.chunkCount > value.rowCount
    || (value.rowCount === 0) !== (value.chunkCount === 0)
    || (value.rowCount === 0) !== (value.zeroRowTableCount === value.tableCount)
  ) {
    context.addIssue({ code: "custom", message: "receipt count relationship mismatch" });
  }
});

export type PostgresMigrationReceiptWithoutHash = z.infer<
  typeof postgresMigrationReceiptWithoutHashSchema
>;
export type PostgresMigrationReceipt = z.infer<typeof postgresMigrationReceiptSchema>;

export function finalizePostgresMigrationReceipt(
  value: PostgresMigrationReceiptWithoutHash,
): PostgresMigrationReceipt {
  const withoutReceiptSha256 = postgresMigrationReceiptWithoutHashSchema.parse(value);
  return postgresMigrationReceiptSchema.parse({
    ...withoutReceiptSha256,
    receiptSha256: sha256PostgresMigrationBytes(
      serializeCanonicalPostgresMigrationJson(withoutReceiptSha256),
    ),
  });
}
