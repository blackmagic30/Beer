import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { CURRENT_LEGAL_POLICY_VERSION } from "../src/config/legal.js";
import { AccountDeletionQueueRepository } from "../src/db/account-deletion-queue.repository.js";
import { AccountPrivacyRepository } from "../src/db/account-privacy.repository.js";
import { AccountProfilePreferencesRepository } from "../src/db/account-profile-preferences.repository.js";
import { AccountSessionRepository } from "../src/db/account-session.repository.js";
import { ActivityAuditRepository } from "../src/db/activity-audit.repository.js";
import { AdminAccountRepository } from "../src/db/admin-account.repository.js";
import { AdminAnalyticsRepository } from "../src/db/admin-analytics.repository.js";
import { BillingCheckoutRepository } from "../src/db/billing-checkout.repository.js";
import {
  BusinessRepository,
  type BusinessAccount,
  type PublicVenuePriceRecord,
} from "../src/db/business.repository.js";
import { CommunitySubmissionRepository } from "../src/db/community-submission.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { MissionDiscoveryAutomationRepository } from "../src/db/mission-discovery-automation.repository.js";
import { MissionLifecycleRepository } from "../src/db/mission-lifecycle.repository.js";
import { PrivacyRetentionRepository } from "../src/db/privacy-retention.repository.js";
import { PublicPriceRepository } from "../src/db/public-price.repository.js";
import { PublicVenueDirectoryRepository } from "../src/db/public-venue-directory.repository.js";
import { asAsyncSqliteDatabase } from "../src/db/sql-database.js";
import { SourceEvidenceObjectRepository } from "../src/db/source-evidence-object.repository.js";
import { SourceEvidenceRetentionRepository } from "../src/db/source-evidence-retention.repository.js";
import { StripeSubscriptionRepository } from "../src/db/stripe-subscription.repository.js";
import { SupportFeedbackRepository } from "../src/db/support-feedback.repository.js";
import { SystemStateRepository } from "../src/db/system-state.repository.js";
import { VenueAccessRepository } from "../src/db/venue-access.repository.js";
import { VenueDataReadRepository } from "../src/db/venue-data-read.repository.js";
import { VenueIdentityRepository } from "../src/db/venue-identity.repository.js";
import { VenueInventoryRepository } from "../src/db/venue-inventory.repository.js";
import { VenueManagerInsightsRepository } from "../src/db/venue-manager-insights.repository.js";
import { VenueManagerInternalSubmissionRepository } from "../src/db/venue-manager-internal-submission.repository.js";
import { VenuePartnerRepository } from "../src/db/venue-partner.repository.js";
import { VenuePendingChangeRepository } from "../src/db/venue-pending-change.repository.js";
import { VenueRequestRepository } from "../src/db/venue-request.repository.js";
import { createSqliteAccountDeletionSecretPhysicalCheckpoint } from "../src/lib/account-deletion-secret-checkpoint.js";
import { AppError } from "../src/lib/errors.js";
import { priceConfirmationVersion } from "../src/lib/price-confirmation.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { createBusinessRouter } from "../src/modules/business/business.routes.js";
import { BusinessService } from "../src/modules/business/business.service.js";

const NOW = "2026-08-27T08:00:00.000Z";
const LATER = "2026-08-27T08:10:00.000Z";

type Harness = {
  database: BetterSqlite3.Database;
  repository: BusinessRepository;
  service: BusinessService;
  activityAuditRepository: ActivityAuditRepository;
  supportFeedbackRepository: SupportFeedbackRepository;
  accountProfilePreferencesRepository: AccountProfilePreferencesRepository;
  publicPriceRepository: PublicPriceRepository;
  venueInventoryRepository: VenueInventoryRepository;
  app: express.Express;
  evidenceStorageDir: string;
};

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.database.close();
    fs.rmSync(harness.evidenceStorageDir, { recursive: true, force: true });
  }
});

function createHarness(options: { nodeEnv?: "test" | "production" } = {}): Harness {
  const database = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(database);
  const sqlDatabase = asAsyncSqliteDatabase(database);
  const repository = new BusinessRepository(database);
  const evidenceStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-price-confirmation-"));
  const activityAuditRepository = new ActivityAuditRepository(sqlDatabase);
  const supportFeedbackRepository = new SupportFeedbackRepository(sqlDatabase);
  const accountProfilePreferencesRepository = new AccountProfilePreferencesRepository(sqlDatabase);
  const publicPriceRepository = new PublicPriceRepository(sqlDatabase);
  const venueInventoryRepository = new VenueInventoryRepository(sqlDatabase);
  const service = new BusinessService(repository, {
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    CONTRIBUTOR_UNLOCK_POINTS: 15,
    CONTRIBUTOR_UNLOCK_DAYS: 30,
    DEMO_BILLING_MODE: false,
    COMMERCIAL_LAUNCH_ENABLED: false,
    CONSUMER_PAID_ENROLLMENT_ENABLED: false,
    FIELD_TEST_MODE: false,
    SESSION_TTL_DAYS: 60,
    ADMIN_SESSION_TTL_DAYS: 7,
    REQUIRE_ADMIN_MFA_IN_PRODUCTION: true,
    ADMIN_MFA_MAX_AGE_MINUTES: 720,
    REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
    ANALYTICS_MIN_BUCKET_SIZE: 5,
    REPORT_TIMEZONE: "Australia/Melbourne",
    REPORT_EMAIL_MODE: "disabled",
    ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: false,
    SOURCE_EVIDENCE_STORAGE_DIR: evidenceStorageDir,
    SOURCE_EVIDENCE_SIGNING_SECRET: "price-confirmation-source-evidence-secret",
    SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS: 300,
    POS_WEBHOOK_SIGNING_SECRET: "price-confirmation-pos-secret",
    NODE_ENV: options.nodeEnv ?? "test",
    PINT_POINTS_REWARDS_ENABLED: false,
    ALCOHOL_GAMIFICATION_ENABLED: false,
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_PRICE_MONTHLY: undefined,
    STRIPE_PRICE_YEARLY: undefined,
    STRIPE_PRO_PRICE_ID: undefined,
    VENUE_PRO_TRIAL_DAYS: 60,
    VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD: false,
    SUPABASE_URL: undefined,
    SUPABASE_ANON_KEY: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SUPABASE_OAUTH_PROVIDERS: "google,apple",
    ADMIN_EMAILS: "admin@pintpath.test",
    GOOGLE_MAPS_API_KEY: undefined,
    GOOGLE_PLACES_API_KEY: undefined,
  }, new PublicVenueDirectoryRepository(sqlDatabase), publicPriceRepository,
  new SystemStateRepository(sqlDatabase), activityAuditRepository, supportFeedbackRepository,
  new AccountSessionRepository(sqlDatabase), accountProfilePreferencesRepository,
  venueInventoryRepository, new VenueIdentityRepository(sqlDatabase),
  new BillingCheckoutRepository(sqlDatabase), new VenueAccessRepository(sqlDatabase),
  new MissionLifecycleRepository(sqlDatabase), new MissionDiscoveryAutomationRepository(sqlDatabase),
  new StripeSubscriptionRepository(sqlDatabase), new VenueRequestRepository(sqlDatabase),
  new VenuePartnerRepository(sqlDatabase), new AdminAnalyticsRepository(sqlDatabase),
  new VenueManagerInsightsRepository(sqlDatabase), new AdminAccountRepository(sqlDatabase),
  new AccountDeletionQueueRepository(sqlDatabase), new AccountPrivacyRepository(sqlDatabase),
  new PrivacyRetentionRepository(sqlDatabase), new CommunitySubmissionRepository(sqlDatabase),
  new VenueManagerInternalSubmissionRepository(sqlDatabase), new SourceEvidenceObjectRepository(sqlDatabase),
  new SourceEvidenceRetentionRepository(sqlDatabase), new VenuePendingChangeRepository(sqlDatabase),
  new VenueDataReadRepository(sqlDatabase), createSqliteAccountDeletionSecretPhysicalCheckpoint(database));
  const app = express();
  app.use(express.json());
  app.use("/api/business", createBusinessRouter(service));
  app.use(errorHandler);
  const harness = {
    database,
    repository,
    service,
    activityAuditRepository,
    supportFeedbackRepository,
    accountProfilePreferencesRepository,
    publicPriceRepository,
    venueInventoryRepository,
    app,
    evidenceStorageDir,
  };
  harnesses.push(harness);
  return harness;
}

function createAccount(
  repository: BusinessRepository,
  id: string,
  options: { emailVerified?: boolean; ageConfirmed?: boolean; currentLegal?: boolean } = {},
): BusinessAccount {
  const legalVersion = options.currentLegal === false ? "outdated-policy" : CURRENT_LEGAL_POLICY_VERSION;
  const account = repository.createAccount({
    id,
    email: `${id}@example.test`,
    passwordHash: "hash",
    role: "user",
    subscriptionStatus: "free",
    termsAcceptedAt: NOW,
    privacyAcceptedAt: NOW,
    termsVersion: legalVersion,
    privacyVersion: legalVersion,
    emailVerifiedAt: options.emailVerified === false ? null : NOW,
    now: NOW,
  });
  return options.ageConfirmed === false ? account : repository.updateAgeConfirmed(account.id, NOW);
}

function insertPriceRecord(
  database: BetterSqlite3.Database,
  input: {
    id: string;
    venueId?: string;
    beerName?: string;
    normalizedBeerId?: string;
    servingSize?: string;
    price?: number | null;
    happyHour?: boolean;
    isOnTap?: string;
    verifiedAt?: string;
  },
): void {
  const venueId = input.venueId ?? `venue-${input.id}`;
  const beerName = input.beerName ?? "Guinness";
  database.prepare(
    `INSERT INTO venue_price_records (
       id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, serving_size,
       price, is_happy_hour_price, happy_hour_details, is_on_tap, confidence,
       source_type, source_submission_id, last_verified_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'Fitzroy', ?, ?, ?, ?, ?, ?, ?, 'photo_verified',
               'approved_submission', NULL, ?, ?, ?)`,
  ).run(
    input.id,
    venueId,
    `${venueId} Hotel`,
    beerName,
    input.normalizedBeerId ?? beerName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
    input.servingSize ?? "pint",
    input.price === undefined ? 13 : input.price,
    input.happyHour ? 1 : 0,
    input.happyHour ? "5-7pm" : null,
    input.isOnTap ?? "yes",
    input.verifiedAt ?? NOW,
    input.verifiedAt ?? NOW,
    input.verifiedAt ?? NOW,
  );
}

function insertManagerPriceRecord(
  database: BetterSqlite3.Database,
  input: {
    id: string;
    venueId: string;
    beerName?: string;
    normalizedBeerId?: string;
    price?: number;
    verifiedAt?: string;
  },
): void {
  database.prepare(
    `INSERT INTO venue_profiles (
       venue_id, name, address, suburb, membership_tier, active, created_at, updated_at
     ) VALUES (?, ?, '1 Test Street', 'Fitzroy', 'basic', 1, ?, ?)`,
  ).run(input.venueId, `${input.venueId} Hotel`, NOW, NOW);
  database.prepare(
    `INSERT INTO venue_beers (
       id, venue_id, beer_name, normalized_beer_id, serve_size, price,
       on_tap, in_stock, price_verified_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pint', ?, 1, 1, ?, ?, ?)`,
  ).run(
    input.id,
    input.venueId,
    input.beerName ?? "Guinness",
    input.normalizedBeerId ?? "guinness",
    input.price ?? 12,
    input.verifiedAt ?? NOW,
    NOW,
    NOW,
  );
}

async function withHttpServer(app: express.Express, callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("one-tap price confirmation", () => {
  it("keeps exported confirmation evidence free of exact prices after access expires", async () => {
    const { database, repository, service } = createHarness();
    let account = createAccount(repository, "confirmation-export-user");
    account = repository.updateSubscription({
      userId: account.id,
      subscriptionStatus: "contributor_unlocked",
      premiumUntil: "2099-01-01T00:00:00.000Z",
      now: NOW,
    });
    insertManagerPriceRecord(database, {
      id: "manager-export-price-row",
      venueId: "manager-export-price-venue",
      beerName: "Asahi Super Dry",
      normalizedBeerId: "asahi_super_dry",
      price: 17.35,
    });

    const confirmation = await service.answerPriceConfirmation(
      account,
      "bar_beer:manager-export-price-row",
      { outcome: "yes" },
    );
    account = repository.updateSubscription({
      userId: account.id,
      subscriptionStatus: "free",
      premiumUntil: null,
      now: LATER,
    });

    const exported = await service.exportAccountData(account);
    const exportedConfirmation = exported.relatedData.analyticsEvents.find(
      (event) => event.event_type === "price_confirmation_answered",
    );
    expect(exportedConfirmation).toBeDefined();
    const metadata = JSON.parse(String(exportedConfirmation?.metadata_json ?? "{}")) as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("price");
    expect(metadata).toMatchObject({
      priceRecordId: "bar_beer:manager-export-price-row",
      priceVersion: confirmation.priceVersion,
    });
    expect(JSON.stringify(exportedConfirmation)).not.toContain("17.35");
  });

  it("binds confirmation versions to non-sensitive row authority rather than exact price", async () => {
    const {
      database,
      publicPriceRepository,
      venueInventoryRepository,
    } = createHarness();
    insertManagerPriceRecord(database, {
      id: "safe-version",
      venueId: "safe-version-venue",
      beerName: "Asahi Super Dry",
      normalizedBeerId: "asahi_super_dry",
      price: 17.35,
    });
    const before = await publicPriceRepository.getCurrentVenueManagerPriceRecordById("bar_beer:safe-version");
    expect(before).not.toBeNull();

    expect(priceConfirmationVersion({ ...before!, price: 9.5 } satisfies PublicVenuePriceRecord))
      .toBe(priceConfirmationVersion({ ...before!, price: 99.95 } satisfies PublicVenuePriceRecord));

    await venueInventoryRepository.upsertBarBeer({
      id: "safe-version",
      barId: "safe-version-venue",
      beerName: "Asahi Super Dry",
      normalizedBeerId: "asahi_super_dry",
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 18.25,
      currency: "AUD",
      onTap: true,
      inStock: true,
      notes: null,
      priceVerifiedAt: LATER,
      stockVerifiedAt: null,
      expectedUpdatedAt: NOW,
      now: LATER,
    });
    const after = await publicPriceRepository.getCurrentVenueManagerPriceRecordById("bar_beer:safe-version");
    expect(after).toMatchObject({ price: 18.25, updatedAt: LATER });
    expect(priceConfirmationVersion(after!)).not.toBe(priceConfirmationVersion(before!));
  });

  it("idempotently records Yes without changing public trust or freshness and still permits a later No", async () => {
    const {
      database,
      repository,
      service,
      activityAuditRepository,
      supportFeedbackRepository,
    } = createHarness();
    const account = createAccount(repository, "confirmation-yes-user");
    insertPriceRecord(database, { id: "confirmation-yes" });
    const before = database.prepare(
      `SELECT confidence, last_verified_at AS "lastVerifiedAt", updated_at AS "updatedAt"
         FROM venue_price_records WHERE id = ?`,
    ).get("confirmation-yes");

    const first = await service.answerPriceConfirmation(account, "confirmation-yes", { outcome: "yes" });
    const replay = await service.answerPriceConfirmation(account, "confirmation-yes", { outcome: "yes" });

    expect(first).toMatchObject({ outcome: "yes", idempotentReplay: false, publicTrustMutated: false });
    expect(replay).toMatchObject({ outcome: "yes", idempotentReplay: true, recordedAt: first.recordedAt });
    expect(first.priceVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(database.prepare(
      "SELECT count(*) AS count FROM events WHERE event_type = 'price_confirmation_answered'",
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      `SELECT confidence, last_verified_at AS "lastVerifiedAt", updated_at AS "updatedAt"
         FROM venue_price_records WHERE id = ?`,
    ).get("confirmation-yes")).toEqual(before);
    await expect(activityAuditRepository.listLatestPositivePriceConfirmations({
      priceRecordIds: ["confirmation-yes"],
      since: "2026-08-27T00:00:00.000Z",
      asOf: "2026-08-28T00:00:00.000Z",
    })).resolves.toEqual([
      expect.objectContaining({
        priceRecordId: "confirmation-yes",
        priceVersion: first.priceVersion,
        confirmedAt: first.recordedAt,
        sourceType: "approved_submission",
        verificationEffect: "signal_only",
      }),
    ]);
    await expect(service.answerPriceConfirmation(account, "confirmation-yes", { outcome: "no" }))
      .resolves.toMatchObject({ outcome: "no", idempotentReplay: false });
    await expect(supportFeedbackRepository.countWrongPriceReports()).resolves.toBe(1);
    await expect(activityAuditRepository.listLatestPositivePriceConfirmations({
      priceRecordIds: ["confirmation-yes"],
      since: "2026-08-27T00:00:00.000Z",
      asOf: "2026-08-28T00:00:00.000Z",
    })).resolves.toEqual([]);
  });

  it("confirms and reports current venue-manager beer rows without mutating venue trust", async () => {
    const {
      database,
      repository,
      service,
      activityAuditRepository,
      supportFeedbackRepository,
    } = createHarness();
    const firstAccount = createAccount(repository, "manager-confirmation-first");
    const secondAccount = createAccount(repository, "manager-confirmation-second");
    insertManagerPriceRecord(database, {
      id: "manager-price-row",
      venueId: "manager-confirmation-venue",
    });
    const publicPriceRecordId = "bar_beer:manager-price-row";
    const before = database.prepare(
      `SELECT price, price_verified_at AS "priceVerifiedAt", updated_at AS "updatedAt"
         FROM venue_beers WHERE id = ?`,
    ).get("manager-price-row");

    const yes = await service.answerPriceConfirmation(firstAccount, publicPriceRecordId, { outcome: "yes" });
    expect(yes).toMatchObject({
      priceRecordId: publicPriceRecordId,
      outcome: "yes",
      analyticsRecorded: true,
      publicTrustMutated: false,
    });
    await expect(activityAuditRepository.listLatestPositivePriceConfirmations({
      priceRecordIds: [publicPriceRecordId],
      since: "2026-08-27T00:00:00.000Z",
      asOf: "2026-08-28T00:00:00.000Z",
    })).resolves.toEqual([
      expect.objectContaining({
        priceRecordId: publicPriceRecordId,
        priceVersion: yes.priceVersion,
        sourceType: "venue_manager_portal",
        verificationEffect: "signal_only",
      }),
    ]);

    const firstNo = await service.answerPriceConfirmation(firstAccount, publicPriceRecordId, { outcome: "no" });
    const secondNo = await service.answerPriceConfirmation(secondAccount, publicPriceRecordId, { outcome: "no" });
    expect(firstNo).toMatchObject({ wrongPriceReport: { duplicate: false, markedDisputed: false } });
    expect(secondNo).toMatchObject({ wrongPriceReport: { duplicate: false, markedDisputed: false } });
    await expect(supportFeedbackRepository.countWrongPriceReports()).resolves.toBe(2);
    expect(database.prepare(
      `SELECT price, price_verified_at AS "priceVerifiedAt", updated_at AS "updatedAt"
         FROM venue_beers WHERE id = ?`,
    ).get("manager-price-row")).toEqual(before);
    await expect(activityAuditRepository.listLatestPositivePriceConfirmations({
      priceRecordIds: [publicPriceRecordId],
      since: "2026-08-27T00:00:00.000Z",
      asOf: "2026-08-28T00:00:00.000Z",
    })).resolves.toEqual([]);

    insertManagerPriceRecord(database, {
      id: "manager-hidden-price-row",
      venueId: "manager-hidden-confirmation-venue",
      beerName: "Asahi Super Dry",
      normalizedBeerId: "asahi_super_dry",
    });
    await expect(service.answerPriceConfirmation(
      secondAccount,
      "bar_beer:manager-hidden-price-row",
      { outcome: "yes" },
    )).rejects.toThrow("not available for confirmation");
  });

  it("deduplicates No reports and keeps Didn't order analytics-only", async () => {
    const {
      database,
      repository,
      service,
      supportFeedbackRepository,
      accountProfilePreferencesRepository,
    } = createHarness();
    const noAccount = createAccount(repository, "confirmation-no-user");
    const skippedAccount = createAccount(repository, "confirmation-skipped-user");
    const optedInSkippedAccount = createAccount(repository, "confirmation-opted-in-skipped-user");
    insertPriceRecord(database, { id: "confirmation-no" });
    insertPriceRecord(database, {
      id: "confirmation-skipped",
      beerName: "Carlton Draught",
      normalizedBeerId: "carlton_draft",
    });
    insertPriceRecord(database, {
      id: "confirmation-opted-in-skipped",
      beerName: "Stone & Wood Pacific Ale",
      normalizedBeerId: "stone_wood_pacific_ale",
    });
    await accountProfilePreferencesRepository.upsertAccountPrivacySettings({
      userId: optedInSkippedAccount.id,
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: false,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
      consentVersion: CURRENT_LEGAL_POLICY_VERSION,
      now: NOW,
      expectedUpdatedAt: null,
    });

    const firstNo = await service.answerPriceConfirmation(noAccount, "confirmation-no", { outcome: "no" });
    const replayNo = await service.answerPriceConfirmation(noAccount, "confirmation-no", { outcome: "no" });
    const skipped = await service.answerPriceConfirmation(skippedAccount, "confirmation-skipped", {
      outcome: "didnt_order",
    });
    const optedInSkipped = await service.answerPriceConfirmation(
      optedInSkippedAccount,
      "confirmation-opted-in-skipped",
      { outcome: "didnt_order" },
    );

    expect(firstNo).toMatchObject({
      idempotentReplay: false,
      wrongPriceReport: { duplicate: false, markedDisputed: false },
    });
    expect(replayNo).toMatchObject({
      idempotentReplay: true,
      wrongPriceReport: { duplicate: true, markedDisputed: false },
    });
    expect(skipped).toMatchObject({
      publicTrustMutated: false,
      wrongPriceReport: null,
      recordedAt: null,
      analyticsRecorded: false,
    });
    expect(optedInSkipped).toMatchObject({
      publicTrustMutated: false,
      wrongPriceReport: null,
      analyticsRecorded: true,
    });
    await expect(supportFeedbackRepository.countWrongPriceReports()).resolves.toBe(1);
    expect(database.prepare(
      "SELECT count(*) AS count FROM events WHERE event_type = 'price_confirmation_answered'",
    ).get()).toEqual({ count: 2 });
    const optionalEvent = database.prepare(
      `SELECT metadata_json AS metadataJson FROM events
        WHERE user_id = ? AND event_type = 'price_confirmation_answered'`,
    ).get(optedInSkippedAccount.id) as { metadataJson: string };
    expect(JSON.parse(optionalEvent.metadataJson)).toMatchObject({
      outcome: "didnt_order",
      privacyScope: "optional_analytics",
    });
    expect(database.prepare(
      "SELECT count(*) AS count FROM events WHERE event_type = 'wrong_price_reported'",
    ).get()).toEqual({ count: 1 });
  });

  it("rejects hidden, non-actionable, and superseded prices", async () => {
    const { database, repository, service } = createHarness();
    const account = createAccount(repository, "confirmation-boundary-user");
    insertPriceRecord(database, {
      id: "confirmation-locked",
      beerName: "Asahi Super Dry",
      normalizedBeerId: "asahi_super_dry",
    });
    insertPriceRecord(database, { id: "confirmation-null", price: null });
    insertPriceRecord(database, { id: "confirmation-pot", servingSize: "pot" });
    insertPriceRecord(database, { id: "confirmation-off-tap", isOnTap: "no" });
    insertPriceRecord(database, { id: "confirmation-happy", happyHour: true });
    insertPriceRecord(database, { id: "confirmation-old", venueId: "confirmation-versioned", verifiedAt: NOW });
    insertPriceRecord(database, { id: "confirmation-new", venueId: "confirmation-versioned", verifiedAt: LATER });
    insertPriceRecord(database, { id: "confirmation-alias-old", venueId: "confirmation-alias", verifiedAt: NOW });
    insertPriceRecord(database, { id: "confirmation-alias-new", venueId: "confirmation-canonical", verifiedAt: LATER });
    database.prepare(
      `INSERT INTO venue_identity_aliases (
         alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
       ) VALUES (?, ?, ?, 'test', ?, ?)`,
    ).run(
      "confirmation-alias",
      "confirmation-canonical",
      "confirmation-hotel-identity",
      NOW,
      NOW,
    );

    for (const id of [
      "confirmation-locked",
      "confirmation-null",
      "confirmation-pot",
      "confirmation-off-tap",
      "confirmation-happy",
    ]) {
      await expect(service.answerPriceConfirmation(account, id, { outcome: "yes" }))
        .rejects.toThrow("not available for confirmation");
    }
    await expect(service.answerPriceConfirmation(account, "confirmation-old", { outcome: "yes" }))
      .rejects.toThrow("no longer the current public record");
    await expect(service.answerPriceConfirmation(account, "confirmation-alias-old", { outcome: "yes" }))
      .rejects.toThrow("no longer the current public record");
  });

  it("confirms only the alias-aware combined manager/community authority", async () => {
    const { database, repository, service } = createHarness();
    const account = createAccount(repository, "confirmation-combined-authority-user");

    insertManagerPriceRecord(database, {
      id: "confirmation-manager-new",
      venueId: "confirmation-manager-new-canonical",
      verifiedAt: LATER,
    });
    insertPriceRecord(database, {
      id: "confirmation-community-old",
      venueId: "confirmation-manager-new-alias",
      verifiedAt: NOW,
    });
    insertManagerPriceRecord(database, {
      id: "confirmation-manager-old",
      venueId: "confirmation-community-new-canonical",
      verifiedAt: NOW,
    });
    insertPriceRecord(database, {
      id: "confirmation-community-new",
      venueId: "confirmation-community-new-alias",
      verifiedAt: LATER,
    });
    const insertAlias = database.prepare(
      `INSERT INTO venue_identity_aliases (
         alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
       ) VALUES (?, ?, ?, 'test', ?, ?)`,
    );
    insertAlias.run(
      "confirmation-manager-new-alias",
      "confirmation-manager-new-canonical",
      "confirmation-manager-new-identity",
      NOW,
      NOW,
    );
    insertAlias.run(
      "confirmation-community-new-alias",
      "confirmation-community-new-canonical",
      "confirmation-community-new-identity",
      NOW,
      NOW,
    );

    await expect(service.answerPriceConfirmation(account, "confirmation-community-old", { outcome: "yes" }))
      .rejects.toThrow("no longer the current public record");
    await expect(service.answerPriceConfirmation(account, "bar_beer:confirmation-manager-old", { outcome: "yes" }))
      .rejects.toThrow("not available for confirmation");
    await expect(service.answerPriceConfirmation(account, "confirmation-community-new", { outcome: "yes" }))
      .resolves.toMatchObject({ outcome: "yes" });
  });

  it("accepts No for a current alias price and records the canonical venue identity", async () => {
    const { database, repository, service, supportFeedbackRepository } = createHarness();
    const account = createAccount(repository, "confirmation-current-alias-user");
    insertPriceRecord(database, {
      id: "confirmation-current-alias",
      venueId: "confirmation-current-alias-source",
    });
    database.prepare(
      `INSERT INTO venue_identity_aliases (
         alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
       ) VALUES (?, ?, ?, 'test', ?, ?)`,
    ).run(
      "confirmation-current-alias-source",
      "confirmation-current-alias-canonical",
      "confirmation-current-alias-identity",
      NOW,
      NOW,
    );

    await expect(service.answerPriceConfirmation(account, "confirmation-current-alias", { outcome: "no" }))
      .resolves.toMatchObject({
        outcome: "no",
        wrongPriceReport: { duplicate: false, markedDisputed: false },
      });
    await expect(supportFeedbackRepository.listWrongPriceReports({ limit: 10, offset: 0 }))
      .resolves.toEqual([
        expect.objectContaining({
          venueId: "confirmation-current-alias-canonical",
          priceRecordId: "confirmation-current-alias",
        }),
      ]);
  });

  it("requires verified-email, current-policy, 18+ contribution eligibility", async () => {
    const { database, repository, service } = createHarness({ nodeEnv: "production" });
    insertPriceRecord(database, { id: "confirmation-eligibility" });
    const unverified = createAccount(repository, "confirmation-unverified", { emailVerified: false });
    const noAge = createAccount(repository, "confirmation-no-age", { ageConfirmed: false });
    const staleLegal = createAccount(repository, "confirmation-stale-legal", { currentLegal: false });

    await expect(service.answerPriceConfirmation(unverified, "confirmation-eligibility", { outcome: "yes" }))
      .rejects.toThrow("Verify your email");
    await expect(service.answerPriceConfirmation(noAge, "confirmation-eligibility", { outcome: "yes" }))
      .rejects.toThrow("18+");
    await expect(service.answerPriceConfirmation(staleLegal, "confirmation-eligibility", { outcome: "yes" }))
      .rejects.toThrow(/current|terms|policy/i);
  });

  it("requires authentication, validates outcomes, and blocks client event spoofing", async () => {
    const token = "confirmation-route-token";
    const account = { id: "confirmation-route-user" } as BusinessAccount;
    let confirmationCalls = 0;
    const service = {
      assertCommercialVenueFeatureOpen: () => undefined,
      requireAccount: async (authorization: string | null) => {
        if (authorization !== `Bearer ${token}`) throw new AppError("Login required.", 401);
        return account;
      },
      getAccountFromAuthorization: async () => null,
      answerPriceConfirmation: async (_account: BusinessAccount, priceRecordId: string, input: { outcome: string }) => {
        confirmationCalls += 1;
        return {
          priceRecordId,
          priceVersion: "a".repeat(64),
          outcome: input.outcome,
          recordedAt: NOW,
          idempotentReplay: confirmationCalls > 1,
          analyticsRecorded: true,
          publicTrustMutated: false,
          wrongPriceReport: null,
          message: "Recorded.",
        };
      },
      trackClientEvent: async (_account: BusinessAccount | null, input: { eventType: string }) => {
        if (input.eventType === "price_confirmation_answered") {
          throw new AppError("This event can only be recorded through its dedicated product action.", 400);
        }
      },
    } as unknown as BusinessService;
    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      const endpoint = `${baseUrl}/api/business/price-records/confirmation-route/confirmation`;
      const post = (outcome: string, authenticated = true) => fetch(endpoint, {
        method: "POST",
        headers: {
          ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ outcome }),
      });
      expect((await post("yes", false)).status).toBe(401);
      expect((await post("maybe")).status).toBe(400);

      const spoofed = await fetch(`${baseUrl}/api/business/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anonymousSessionId: "spoofed-confirmation",
          eventType: "price_confirmation_answered",
          venueId: "venue-confirmation-route",
          beerId: "guinness",
          suburb: "Fitzroy",
          metadata: { outcome: "yes", priceRecordId: "confirmation-route" },
        }),
      });
      expect(spoofed.status).toBe(400);
      const spoofedBody = await spoofed.json() as { error: { message: string } };
      expect(spoofedBody.error.message).toContain("dedicated product action");

      const first = await post("yes");
      expect(first.status).toBe(201);
      expect(await first.json()).toEqual(expect.objectContaining({
        data: expect.objectContaining({ outcome: "yes", idempotentReplay: false }),
      }));
      const replay = await post("yes");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(expect.objectContaining({
        data: expect.objectContaining({ outcome: "yes", idempotentReplay: true }),
      }));
    });
  });
});
