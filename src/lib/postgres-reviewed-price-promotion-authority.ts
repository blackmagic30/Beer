import { z } from "zod";

import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "../db/postgres-migration-schema.js";

export const POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_KIND =
  "pintpath-postgres-reviewed-price-promotion-authority-bundle" as const;
export const POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_VERSION = 1 as const;
export const POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_KIND =
  "pintpath-postgres-reviewed-price-promotion-private-review-packet" as const;
export const POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_VERSION = 1 as const;
export const POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_MODE =
  "offline-plan-bindings-only" as const;
export const POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_MODE =
  "identity-and-artifact-hash-binding-only" as const;
export const POSTGRES_REVIEWED_PRICE_PROMOTION_MAX_AUTHORITY_VALIDITY_MS =
  86_400_000 as const;
// The packet schema permits at most 50 * 100 rows. Every string below has a
// finite UTF-16 length, and JSON can expand each code unit to at most six
// bytes. The complete schema maximum, including keys and indentation, remains
// below this deliberately rounded hard cap.
export const POSTGRES_REVIEWED_PRICE_PROMOTION_MAX_REVIEW_PACKET_BYTES =
  128 * 1_024 * 1_024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANDIDATE_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CANONICAL_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_PARSE = Date.parse;
const DATE_GET_TIME = Date.prototype.getTime;
const REFLECT_APPLY = Reflect.apply;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const candidateSchema = z.string().regex(CANDIDATE_PATTERN);
const sourceIdSchema = z.string().regex(UUID_PATTERN);
const canonicalUtcSchema = z.string().regex(CANONICAL_UTC_PATTERN).refine((value) => {
  const parsed = REFLECT_APPLY(DATE_PARSE, Date, [value]) as number;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
});
const boundedText = (maximum: number) => z.string().min(1).max(maximum);
const nullableBoundedText = (maximum: number) => boundedText(maximum).nullable();
const catalogAbvSchema = z.string()
  .min(1)
  .max(32)
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= 25;
  }, "catalog ABV must be between 0 and 25");

const recoveryReferencesSchema = z.object({
  accountDeletionRecoveryManifestSha256: sha256Schema,
  logicalBackupManifestSha256: sha256Schema,
  pitrAttestationSha256: sha256Schema,
  privateStorageRecoveryManifestSha256: sha256Schema,
  restoreReceiptSha256: sha256Schema,
  wormManifestSha256: sha256Schema,
}).strict();

const evidenceReferencesSchema = z.object({
  privateEvidenceManifestSha256: sha256Schema,
  restoreReceiptSha256: sha256Schema,
  retrievalReceiptSha256: sha256Schema,
  storageSnapshotManifestSha256: sha256Schema,
  wormManifestSha256: sha256Schema,
}).strict();

const reviewBindingsSchema = z.object({
  approvalArtifactSha256: sha256Schema,
  approvalReferenceSha256: sha256Schema,
  cryptographicApprovalVerified: z.literal(false),
  operatorIdSha256: sha256Schema,
  reviewMode: z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_MODE),
  reviewerIdSha256: sha256Schema,
  trustRootPolicySha256: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.operatorIdSha256 === value.reviewerIdSha256) {
    context.addIssue({
      code: "custom",
      message: "operator and reviewer identities must be independent",
    });
  }
});

const targetProfileSchema = z.object({
  deploymentAttestationFileSha256: sha256Schema,
  physicalDatabaseIdentitySha256: sha256Schema,
  railwayEnvironmentIdSha256: sha256Schema,
  railwayProjectIdSha256: sha256Schema,
  railwayServiceIdSha256: sha256Schema,
  supabaseProjectIdentitySha256: sha256Schema,
}).strict();

export const postgresReviewedPricePromotionAuthorityBundleSchema = z.object({
  authorityMode: z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_MODE),
  candidateSha: candidateSchema,
  evidenceReferences: evidenceReferencesSchema,
  expectedEnvironment: z.enum(["permanent-staging", "production"]),
  expiresAt: canonicalUtcSchema,
  generatedAt: canonicalUtcSchema,
  kind: z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_KIND),
  mutationAuthorized: z.literal(false),
  privateInputManifestSha256: sha256Schema,
  providerAuthorityObserved: z.literal(false),
  recoveryReferences: recoveryReferencesSchema,
  reviewBindings: reviewBindingsSchema,
  targetProfile: targetProfileSchema,
  version: z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_VERSION),
}).strict().superRefine((value, context) => {
  const generatedAt = REFLECT_APPLY(DATE_PARSE, Date, [value.generatedAt]) as number;
  const expiresAt = REFLECT_APPLY(DATE_PARSE, Date, [value.expiresAt]) as number;
  if (
    !Number.isFinite(generatedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= generatedAt
    || expiresAt - generatedAt
      > POSTGRES_REVIEWED_PRICE_PROMOTION_MAX_AUTHORITY_VALIDITY_MS
  ) {
    context.addIssue({ code: "custom", message: "authority validity window mismatch" });
  }
});

export type PostgresReviewedPricePromotionAuthorityBundle = z.infer<
  typeof postgresReviewedPricePromotionAuthorityBundleSchema
>;

const priceRecordProjectionSchema = z.object({
  beerName: boundedText(180),
  confidence: z.literal("admin_verified"),
  happyHourDetails: z.null(),
  id: boundedText(500),
  isHappyHourPrice: z.literal(false),
  isOnTap: z.literal("yes"),
  normalizedBeerId: boundedText(180),
  price: z.number().finite().positive(),
  servingSize: z.literal("pint"),
  sourceEvidenceReference: boundedText(500),
  sourceIngestionId: sourceIdSchema,
  sourceSubmissionId: z.null(),
  sourceType: z.literal("source_ingestion"),
  suburb: nullableBoundedText(180),
  venueId: sourceIdSchema,
  venueName: boundedText(180),
}).strict();

const venueBeerProjectionSchema = z.object({
  abv: catalogAbvSchema.nullable(),
  beerName: boundedText(180),
  brewery: nullableBoundedText(180),
  currency: z.literal("AUD"),
  id: boundedText(500),
  inStock: z.literal(true),
  normalizedBeerId: boundedText(180),
  notes: z.literal("Published from admin source review."),
  onTap: z.literal(true),
  price: z.number().finite().positive(),
  serveSize: z.literal("pint"),
  sourceIngestionId: sourceIdSchema,
  style: nullableBoundedText(180),
  venueId: sourceIdSchema,
}).strict();

const reviewRowSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  priceRecord: priceRecordProjectionSchema,
  venueBeer: venueBeerProjectionSchema,
}).strict();

const reviewItemSchema = z.object({
  evidenceContentSha256: sha256Schema,
  evidenceReference: boundedText(500),
  evidenceReferenceSha256: sha256Schema,
  rows: z.array(reviewRowSchema).min(1).max(100),
  sourceIngestionId: sourceIdSchema,
  venue: z.object({
    address: nullableBoundedText(500),
    area: nullableBoundedText(180),
    id: sourceIdSchema,
    name: boundedText(180),
    suburb: boundedText(180),
  }).strict(),
}).strict().superRefine((value, context) => {
  const rowIds = new Set<string>();
  for (let index = 0; index < value.rows.length; index += 1) {
    const row = value.rows[index];
    if (
      !row
      || row.ordinal !== index
      || row.priceRecord.sourceIngestionId !== value.sourceIngestionId
      || row.priceRecord.venueId !== value.venue.id
      || row.venueBeer.sourceIngestionId !== value.sourceIngestionId
      || row.venueBeer.venueId !== value.venue.id
      || row.priceRecord.price !== row.venueBeer.price
      || row.priceRecord.beerName !== row.venueBeer.beerName
      || row.priceRecord.normalizedBeerId !== row.venueBeer.normalizedBeerId
      || row.priceRecord.sourceEvidenceReference !== value.evidenceReference
      || rowIds.has(row.priceRecord.id)
      || rowIds.has(row.venueBeer.id)
    ) {
      context.addIssue({ code: "custom", message: "review row authority mismatch" });
      return;
    }
    rowIds.add(row.priceRecord.id);
    rowIds.add(row.venueBeer.id);
  }
});

const reviewPacketWithoutHashSchema = z.object({
  authorityBundleSha256: sha256Schema,
  candidateSha: candidateSchema,
  expectedEnvironment: z.enum(["permanent-staging", "production"]),
  expiresAt: canonicalUtcSchema,
  generatedAt: canonicalUtcSchema,
  itemCount: z.number().int().min(1).max(50),
  items: z.array(reviewItemSchema).min(1).max(50),
  kind: z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_KIND),
  marketedSuburb: boundedText(120),
  mutationEnabled: z.literal(false),
  privateInputManifestSha256: sha256Schema,
  rowCount: z.number().int().min(1).max(5_000),
  sourceSnapshotSha256: sha256Schema,
  targetPhysicalIdentitySha256: sha256Schema,
  targetProfileSha256: sha256Schema,
  temporalPolicy: z.literal("single-apply-transaction-timestamp"),
  version: z.literal(POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_VERSION),
  wrongPricePolicySha256: sha256Schema,
}).strict().superRefine((value, context) => {
  let rowCount = 0;
  let priorSourceId: string | null = null;
  for (const item of value.items) {
    rowCount += item.rows.length;
    if (priorSourceId !== null && priorSourceId >= item.sourceIngestionId) {
      context.addIssue({ code: "custom", message: "review items must be bytewise sorted" });
      return;
    }
    priorSourceId = item.sourceIngestionId;
  }
  if (value.itemCount !== value.items.length || value.rowCount !== rowCount) {
    context.addIssue({ code: "custom", message: "review packet counts mismatch" });
  }
});

export const postgresReviewedPricePromotionReviewPacketSchema =
  reviewPacketWithoutHashSchema.extend({
    reviewPacketCandidateSha256: sha256Schema,
  }).strict().superRefine((value, context) => {
    const { reviewPacketCandidateSha256, ...withoutHash } = value;
    if (
      sha256PostgresReviewedPricePromotionAuthorityValue(withoutHash)
        !== reviewPacketCandidateSha256
    ) {
      context.addIssue({ code: "custom", message: "review packet hash mismatch" });
    }
  });

export type PostgresReviewedPricePromotionReviewPacket = z.infer<
  typeof postgresReviewedPricePromotionReviewPacketSchema
>;
export type PostgresReviewedPricePromotionReviewPacketWithoutHash = z.infer<
  typeof reviewPacketWithoutHashSchema
>;

export function canonicalPostgresReviewedPricePromotionAuthorityJson(
  value: unknown,
): Buffer {
  return serializeCanonicalPostgresMigrationJson(value);
}

export function sha256PostgresReviewedPricePromotionAuthorityValue(
  value: unknown,
): string {
  return sha256PostgresMigrationBytes(
    canonicalPostgresReviewedPricePromotionAuthorityJson(value),
  );
}

export function finalizePostgresReviewedPricePromotionReviewPacket(
  input: PostgresReviewedPricePromotionReviewPacketWithoutHash,
): PostgresReviewedPricePromotionReviewPacket {
  const withoutHash = reviewPacketWithoutHashSchema.parse(input);
  return postgresReviewedPricePromotionReviewPacketSchema.parse({
    ...withoutHash,
    reviewPacketCandidateSha256:
      sha256PostgresReviewedPricePromotionAuthorityValue(withoutHash),
  });
}

export function postgresReviewedPricePromotionAuthorityBundleFreshAt(
  value: unknown,
  now: Date,
): value is PostgresReviewedPricePromotionAuthorityBundle {
  const parsed = postgresReviewedPricePromotionAuthorityBundleSchema.safeParse(value);
  if (!parsed.success || !(now instanceof Date)) return false;
  const nowMs = REFLECT_APPLY(DATE_GET_TIME, now, []) as number;
  const generatedAt = REFLECT_APPLY(
    DATE_PARSE,
    Date,
    [parsed.data.generatedAt],
  ) as number;
  const expiresAt = REFLECT_APPLY(DATE_PARSE, Date, [parsed.data.expiresAt]) as number;
  return Number.isFinite(nowMs)
    && Number.isFinite(generatedAt)
    && Number.isFinite(expiresAt)
    && generatedAt <= nowMs
    && nowMs <= expiresAt;
}
