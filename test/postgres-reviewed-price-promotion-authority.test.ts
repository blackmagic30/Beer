import { describe, expect, it } from "vitest";

import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_VERSION,
  POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_MODE,
  POSTGRES_REVIEWED_PRICE_PROMOTION_MAX_REVIEW_PACKET_BYTES,
  POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_MODE,
  POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_VERSION,
  canonicalPostgresReviewedPricePromotionAuthorityJson,
  finalizePostgresReviewedPricePromotionReviewPacket,
  postgresReviewedPricePromotionAuthorityBundleFreshAt,
  postgresReviewedPricePromotionAuthorityBundleSchema,
  postgresReviewedPricePromotionReviewPacketSchema,
  sha256PostgresReviewedPricePromotionAuthorityValue,
  type PostgresReviewedPricePromotionAuthorityBundle,
  type PostgresReviewedPricePromotionReviewPacketWithoutHash,
} from "../src/lib/postgres-reviewed-price-promotion-authority.js";
import {
  REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES,
  REVIEWED_PRICE_WRONG_PRICE_POLICY,
  REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256,
  reviewedPriceWrongPriceStatusBlocksPromotion,
} from "../src/lib/reviewed-price-wrong-price-policy.js";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const CANDIDATE_SHA = "c".repeat(40);
const INGESTION_ID = "11111111-1111-4111-8111-111111111111";
const VENUE_ID = "22222222-2222-4222-8222-222222222222";
const GENERATED_AT = "2026-08-12T00:00:00.000Z";
const EXPIRES_AT = "2026-08-12T01:00:00.000Z";

function authorityBundle(): PostgresReviewedPricePromotionAuthorityBundle {
  return {
    authorityMode: POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_MODE,
    candidateSha: CANDIDATE_SHA,
    evidenceReferences: {
      privateEvidenceManifestSha256: HASH,
      restoreReceiptSha256: HASH,
      retrievalReceiptSha256: HASH,
      storageSnapshotManifestSha256: HASH,
      wormManifestSha256: HASH,
    },
    expectedEnvironment: "permanent-staging",
    expiresAt: EXPIRES_AT,
    generatedAt: GENERATED_AT,
    kind: POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_KIND,
    mutationAuthorized: false,
    privateInputManifestSha256: HASH,
    providerAuthorityObserved: false,
    recoveryReferences: {
      accountDeletionRecoveryManifestSha256: HASH,
      logicalBackupManifestSha256: HASH,
      pitrAttestationSha256: HASH,
      privateStorageRecoveryManifestSha256: HASH,
      restoreReceiptSha256: HASH,
      wormManifestSha256: HASH,
    },
    reviewBindings: {
      approvalArtifactSha256: HASH,
      approvalReferenceSha256: HASH,
      cryptographicApprovalVerified: false,
      operatorIdSha256: HASH,
      reviewMode: POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_MODE,
      reviewerIdSha256: OTHER_HASH,
      trustRootPolicySha256: HASH,
    },
    targetProfile: {
      deploymentAttestationFileSha256: HASH,
      physicalDatabaseIdentitySha256: HASH,
      railwayEnvironmentIdSha256: HASH,
      railwayProjectIdSha256: HASH,
      railwayServiceIdSha256: HASH,
      supabaseProjectIdentitySha256: HASH,
    },
    version: POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_VERSION,
  };
}

function reviewPacketWithoutHash(): PostgresReviewedPricePromotionReviewPacketWithoutHash {
  return {
    authorityBundleSha256: HASH,
    candidateSha: CANDIDATE_SHA,
    expectedEnvironment: "permanent-staging",
    expiresAt: EXPIRES_AT,
    generatedAt: GENERATED_AT,
    itemCount: 1,
    items: [{
      evidenceContentSha256: HASH,
      evidenceReference: `source-ingestion:${INGESTION_ID}`,
      evidenceReferenceSha256: HASH,
      rows: [{
        ordinal: 0,
        priceRecord: {
          beerName: "Fixture Beer",
          confidence: "admin_verified",
          happyHourDetails: null,
          id: `source-ingestion:${INGESTION_ID}:0`,
          isHappyHourPrice: false,
          isOnTap: "yes",
          normalizedBeerId: "fixture_beer",
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
          abv: "4.5",
          beerName: "Fixture Beer",
          brewery: "Fixture Brewery",
          currency: "AUD",
          id: `admin-reviewed:${VENUE_ID}:fixture-beer:pint`,
          inStock: true,
          normalizedBeerId: "fixture_beer",
          notes: "Published from admin source review.",
          onTap: true,
          price: 13.5,
          serveSize: "pint",
          sourceIngestionId: INGESTION_ID,
          style: "Lager",
          venueId: VENUE_ID,
        },
      }],
      sourceIngestionId: INGESTION_ID,
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
    wrongPricePolicySha256: REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256,
  };
}

describe("Postgres reviewed-price promotion offline authority", () => {
  it("is explicitly plan-only, bounded, canonical, and never claims live verification", () => {
    const bundle = authorityBundle();
    expect(postgresReviewedPricePromotionAuthorityBundleSchema.parse(bundle))
      .toEqual(bundle);
    expect(postgresReviewedPricePromotionAuthorityBundleFreshAt(
      bundle,
      new Date(GENERATED_AT),
    )).toBe(true);
    expect(postgresReviewedPricePromotionAuthorityBundleFreshAt(
      bundle,
      new Date(EXPIRES_AT),
    )).toBe(true);
    expect(postgresReviewedPricePromotionAuthorityBundleFreshAt(
      bundle,
      new Date("2026-08-12T01:00:00.001Z"),
    )).toBe(false);
    expect(bundle).toMatchObject({
      authorityMode: "offline-plan-bindings-only",
      mutationAuthorized: false,
      providerAuthorityObserved: false,
      reviewBindings: {
        cryptographicApprovalVerified: false,
        reviewMode: "identity-and-artifact-hash-binding-only",
      },
    });
    const bytes = canonicalPostgresReviewedPricePromotionAuthorityJson(bundle);
    expect(sha256PostgresReviewedPricePromotionAuthorityValue(bundle))
      .toMatch(/^[a-f0-9]{64}$/);
    expect(bytes.toString("utf8")).not.toContain("undefined");
  });

  it("rejects excessive validity, shared operator/reviewer identity, and authority escalation", () => {
    const bundle = authorityBundle();
    expect(postgresReviewedPricePromotionAuthorityBundleSchema.safeParse({
      ...bundle,
      expiresAt: "2026-08-13T00:00:00.001Z",
    }).success).toBe(false);
    expect(postgresReviewedPricePromotionAuthorityBundleSchema.safeParse({
      ...bundle,
      reviewBindings: {
        ...bundle.reviewBindings,
        reviewerIdSha256: bundle.reviewBindings.operatorIdSha256,
      },
    }).success).toBe(false);
    expect(postgresReviewedPricePromotionAuthorityBundleSchema.safeParse({
      ...bundle,
      mutationAuthorized: true,
    }).success).toBe(false);
    expect(postgresReviewedPricePromotionAuthorityBundleSchema.safeParse({
      ...bundle,
      providerAuthorityObserved: true,
    }).success).toBe(false);
  });

  it("finalizes a strict exact-row private packet and detects row, count, and hash drift", () => {
    const withoutHash = reviewPacketWithoutHash();
    const packet = finalizePostgresReviewedPricePromotionReviewPacket(withoutHash);
    expect(postgresReviewedPricePromotionReviewPacketSchema.parse(packet))
      .toEqual(packet);
    expect(packet.reviewPacketCandidateSha256)
      .toBe(sha256PostgresReviewedPricePromotionAuthorityValue(withoutHash));
    expect(postgresReviewedPricePromotionReviewPacketSchema.safeParse({
      ...packet,
      rowCount: 2,
    }).success).toBe(false);
    expect(postgresReviewedPricePromotionReviewPacketSchema.safeParse({
      ...packet,
      reviewPacketCandidateSha256: OTHER_HASH,
    }).success).toBe(false);
    expect(() => finalizePostgresReviewedPricePromotionReviewPacket({
      ...withoutHash,
      items: [{
        ...withoutHash.items[0]!,
        rows: [{
          ...withoutHash.items[0]!.rows[0]!,
          ordinal: 1,
        }],
      }],
    })).toThrow();
  });

  it("bounds catalog ABV to the publishable 0..25 authority", () => {
    const withoutHash = reviewPacketWithoutHash();
    const withAbv = (abv: string) => ({
      ...withoutHash,
      items: [{
        ...withoutHash.items[0]!,
        rows: [{
          ...withoutHash.items[0]!.rows[0]!,
          venueBeer: {
            ...withoutHash.items[0]!.rows[0]!.venueBeer,
            abv,
          },
        }],
      }],
    });
    expect(() => finalizePostgresReviewedPricePromotionReviewPacket(withAbv("25")))
      .not.toThrow();
    for (const abv of ["26", "-1", "00.1", `0.${"1".repeat(31)}`]) {
      expect(() => finalizePostgresReviewedPricePromotionReviewPacket(withAbv(abv)))
        .toThrow();
    }
  });

  it("accepts a near-worst-case 5,000-row packet below its honest hard cap", () => {
    const fill = (prefix: string, maximum: number) =>
      prefix + "\u0001".repeat(maximum - prefix.length);
    const uuid = (prefix: string, value: number) =>
      `${prefix}0000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
    const items = Array.from({ length: 50 }, (_, itemIndex) => {
      const sourceIngestionId = uuid("1", itemIndex + 1);
      const venueId = uuid("2", itemIndex + 1);
      const evidenceReference = fill(`evidence-${itemIndex}-`, 500);
      const rows = Array.from({ length: 100 }, (_, ordinal) => {
        const beerName = fill(`beer-${ordinal}-`, 180);
        const normalizedBeerId = fill(`normalized-${ordinal}-`, 180);
        return {
          ordinal,
          priceRecord: {
            beerName,
            confidence: "admin_verified" as const,
            happyHourDetails: null,
            id: fill(`price-${ordinal}-`, 500),
            isHappyHourPrice: false as const,
            isOnTap: "yes" as const,
            normalizedBeerId,
            price: 13.5,
            servingSize: "pint" as const,
            sourceEvidenceReference: evidenceReference,
            sourceIngestionId,
            sourceSubmissionId: null,
            sourceType: "source_ingestion" as const,
            suburb: fill(`suburb-${ordinal}-`, 180),
            venueId,
            venueName: fill(`venue-${ordinal}-`, 180),
          },
          venueBeer: {
            abv: `0.${"1".repeat(30)}`,
            beerName,
            brewery: fill(`brewery-${ordinal}-`, 180),
            currency: "AUD" as const,
            id: fill(`inventory-${ordinal}-`, 500),
            inStock: true as const,
            normalizedBeerId,
            notes: "Published from admin source review." as const,
            onTap: true as const,
            price: 13.5,
            serveSize: "pint" as const,
            sourceIngestionId,
            style: fill(`style-${ordinal}-`, 180),
            venueId,
          },
        };
      });
      return {
        evidenceContentSha256: HASH,
        evidenceReference,
        evidenceReferenceSha256: HASH,
        rows,
        sourceIngestionId,
        venue: {
          address: fill(`address-${itemIndex}-`, 500),
          area: fill(`area-${itemIndex}-`, 180),
          id: venueId,
          name: fill(`name-${itemIndex}-`, 180),
          suburb: fill(`suburb-${itemIndex}-`, 180),
        },
      };
    });
    const packet = finalizePostgresReviewedPricePromotionReviewPacket({
      ...reviewPacketWithoutHash(),
      itemCount: 50,
      items,
      rowCount: 5_000,
    });
    const byteCount = canonicalPostgresReviewedPricePromotionAuthorityJson(packet).length;
    expect(byteCount).toBeGreaterThan(4 * 1_024 * 1_024);
    expect(byteCount).toBeLessThanOrEqual(
      POSTGRES_REVIEWED_PRICE_PROMOTION_MAX_REVIEW_PACKET_BYTES,
    );
  }, 30_000);

  it("pins the conservative all-reason unresolved-report policy", () => {
    expect(REVIEWED_PRICE_BLOCKING_WRONG_PRICE_STATUSES)
      .toEqual(["in_progress", "open"]);
    expect(REVIEWED_PRICE_WRONG_PRICE_POLICY).toMatchObject({
      blockingReasonSemantics: "all_known_reasons_when_unresolved",
      noSeverityInference: true,
    });
    expect(REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256).toBe(
      sha256PostgresReviewedPricePromotionAuthorityValue(
        REVIEWED_PRICE_WRONG_PRICE_POLICY,
      ),
    );
    expect(reviewedPriceWrongPriceStatusBlocksPromotion("open")).toBe(true);
    expect(reviewedPriceWrongPriceStatusBlocksPromotion("in_progress")).toBe(true);
    expect(reviewedPriceWrongPriceStatusBlocksPromotion("resolved")).toBe(false);
    expect(reviewedPriceWrongPriceStatusBlocksPromotion("rejected")).toBe(false);
  });
});
