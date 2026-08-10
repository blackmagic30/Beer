import { z } from "zod";

import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "./postgres-migration-schema.js";

export const POSTGRES_MIGRATION_RECEIPT_KIND =
  "pint-path-postgres-migration-receipt" as const;
export const POSTGRES_MIGRATION_RECEIPT_VERSION = 1 as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANDIDATE_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha256Schema = z.string().regex(SHA256_PATTERN);

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
  targetUrlSha256: sha256Schema,
  verifierIdSha256: sha256Schema,
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
  runIdSha256: sha256Schema,
  runBindingSha256: sha256Schema,
  targetIdentitySha256: sha256Schema,
  targetUrlSha256: sha256Schema,
  targetDdlSha256: sha256Schema,
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
}).strict();

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
