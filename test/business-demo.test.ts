import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import BetterSqlite3 from "better-sqlite3";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BusinessRepository, type BarPendingChange, type BusinessAccount, type SubmissionType, type SubscriptionStatus } from "../src/db/business.repository.js";
import { CURRENT_LEGAL_POLICY_VERSION } from "../src/config/legal.js";
import { normalizeBeerSearchKey } from "../src/constants/beers.js";
import { BeerCatalogRepository } from "../src/db/beer-catalog.repository.js";
import { AccountSessionRepository } from "../src/db/account-session.repository.js";
import { AccountProfilePreferencesRepository } from "../src/db/account-profile-preferences.repository.js";
import { AccountDeletionQueueRepository } from "../src/db/account-deletion-queue.repository.js";
import { AccountPrivacyRepository } from "../src/db/account-privacy.repository.js";
import {
  PrivacyRetentionRepository,
  type PrivacyRetentionResult,
} from "../src/db/privacy-retention.repository.js";
import { CommunitySubmissionRepository } from "../src/db/community-submission.repository.js";
import { VenueManagerInternalSubmissionRepository } from "../src/db/venue-manager-internal-submission.repository.js";
import { SourceEvidenceObjectRepository } from "../src/db/source-evidence-object.repository.js";
import { SourceEvidenceRetentionRepository } from "../src/db/source-evidence-retention.repository.js";
import { VenuePendingChangeRepository } from "../src/db/venue-pending-change.repository.js";
import { VenueDataReadRepository } from "../src/db/venue-data-read.repository.js";
import { AdminIngestionQueueRepository } from "../src/db/admin-ingestion-queue.repository.js";
import { PublicVenueDirectoryRepository } from "../src/db/public-venue-directory.repository.js";
import { PublicPriceRepository } from "../src/db/public-price.repository.js";
import { SystemStateRepository } from "../src/db/system-state.repository.js";
import { ActivityAuditRepository } from "../src/db/activity-audit.repository.js";
import { SupportFeedbackRepository } from "../src/db/support-feedback.repository.js";
import { VenueInventoryRepository } from "../src/db/venue-inventory.repository.js";
import { VenueIdentityRepository } from "../src/db/venue-identity.repository.js";
import { BillingCheckoutRepository } from "../src/db/billing-checkout.repository.js";
import { VenueAccessRepository } from "../src/db/venue-access.repository.js";
import { MissionLifecycleRepository } from "../src/db/mission-lifecycle.repository.js";
import { MissionDiscoveryAutomationRepository } from "../src/db/mission-discovery-automation.repository.js";
import { StripeSubscriptionRepository } from "../src/db/stripe-subscription.repository.js";
import { VenueRequestRepository } from "../src/db/venue-request.repository.js";
import { VenuePartnerRepository } from "../src/db/venue-partner.repository.js";
import { AdminAnalyticsRepository } from "../src/db/admin-analytics.repository.js";
import { VenueManagerInsightsRepository } from "../src/db/venue-manager-insights.repository.js";
import { AdminAccountRepository } from "../src/db/admin-account.repository.js";
import { CURRENT_DATABASE_SCHEMA_VERSION, initializeDatabaseSchema } from "../src/db/database.js";
import { asAsyncSqliteDatabase, type SqlDatabase } from "../src/db/sql-database.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { AppError } from "../src/lib/errors.js";
import { scheduleMissionMaintenance } from "../src/lib/mission-maintenance.js";
import { createMockAccountDeletionNotificationProvider } from "../src/lib/account-deletion-notification.js";
import { AccountDeletionNotificationCoordinator } from "../src/lib/account-deletion-notification-worker.js";
import { createSqliteAccountDeletionSecretPhysicalCheckpoint } from "../src/lib/account-deletion-secret-checkpoint.js";
import { createPublicVenuePageHandler } from "../src/app.js";
import { SESSION_COOKIE_NAME } from "../src/lib/session-cookie.js";
import { getZonedMonthKey, getZonedMonthRangeIso } from "../src/lib/time.js";
import { createAdminRouter } from "../src/modules/admin/admin.routes.js";
import { AdminService } from "../src/modules/admin/admin.service.js";
import {
  authSignupSchema,
  authSupabaseSessionSchema,
  barHappyHourSchema,
  createSubmissionSchema,
  normalizeHappyHourTime,
  pintPointDrinkRecordSchema,
  reviewSubmissionSchema,
} from "../src/modules/business/business.schemas.js";
import {
  createBusinessRouter,
  isDeferredCommercialVenueRoute,
} from "../src/modules/business/business.routes.js";
import {
  BusinessService,
  canAccessAgeGatedRewards,
  getMonthlyReportFilename,
  sanitizePostgrestIlikeTerm,
} from "../src/modules/business/business.service.js";

const NOW = "2026-05-04T08:00:00.000Z";
const MONTH_KEY = "2026-05";
const PREMIUM_UNTIL = "2026-06-03T08:00:00.000Z";
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]).toString("base64")}`;
const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]).toString("base64")}`;
const WEBP_DATA_URL = `data:image/webp;base64,${Buffer.from("RIFF0000WEBPVP8 ", "ascii").toString("base64")}`;
const PDF_DATA_URL = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF", "ascii").toString("base64")}`;

function testSupabaseAccessToken(
  payload: Record<string, unknown>,
  signature = "test-signature-value",
): string {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    signature,
  ].join(".");
}

function responseCookie(headers: Headers, name: string): string {
  return headers.getSetCookie()
    .map((value) => value.split(";", 1)[0] ?? "")
    .find((value) => value.startsWith(`${name}=`)) ?? "";
}

it("accepts and normalizes consent source identifiers from every active client", async () => {
  const base = {
    accessToken: "x".repeat(32),
    ageConfirmed: true,
    termsAccepted: true,
    privacyAccepted: true,
    termsVersion: CURRENT_LEGAL_POLICY_VERSION,
    privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
  };
  expect(authSupabaseSessionSchema.parse({ ...base, consentSource: "web_oauth" }).consentSource).toBe("web");
  expect(authSupabaseSessionSchema.parse({ ...base, consentSource: "ios_app" }).consentSource).toBe("ios");
  expect(authSupabaseSessionSchema.parse({ ...base, consentSource: "android_app" }).consentSource).toBe("android");
  expect(authSupabaseSessionSchema.parse({
    accessToken: "x".repeat(32),
    legalAcceptance: { ...base, source: "web_oauth", accessToken: undefined },
  }).legalAcceptance?.source).toBe("web");
});

it("accepts only versioned memory ceremonies and binds email/native ceremonies to exact purposes", () => {
  const accessToken = "x".repeat(32);
  expect(authSupabaseSessionSchema.parse({
    accessToken,
    credentialCeremony: "browser_memory_v1",
  })).toEqual(expect.objectContaining({
    credentialCeremony: "browser_memory_v1",
  }));
  expect(authSupabaseSessionSchema.parse({
    accessToken,
    credentialCeremony: "browser_memory_v1",
    reauthPurpose: "account_export",
  })).toEqual(expect.objectContaining({
    credentialCeremony: "browser_memory_v1",
    reauthPurpose: "account_export",
  }));
  expect(authSupabaseSessionSchema.parse({
    accessToken,
    credentialCeremony: "browser_memory_v1",
    reauthPurpose: "venue_billing_portal",
  }).reauthPurpose).toBe("venue_billing_portal");
  expect(authSupabaseSessionSchema.parse({
    accessToken,
    credentialCeremony: "browser_email_otp_v1",
    reauthPurpose: "account_export",
  }).credentialCeremony).toBe("browser_email_otp_v1");
  expect(authSupabaseSessionSchema.parse({
    accessToken,
    credentialCeremony: "native_memory_v1",
    reauthPurpose: "logout_all",
  }).credentialCeremony).toBe("native_memory_v1");
  for (const credentialCeremony of ["browser_email_otp_v1", "native_memory_v1"] as const) {
    expect(authSupabaseSessionSchema.safeParse({ accessToken, credentialCeremony }).success).toBe(false);
  }
  expect(authSupabaseSessionSchema.safeParse({
    accessToken,
    reauthPurpose: "account_export",
  }).success).toBe(false);
  expect(authSupabaseSessionSchema.safeParse({
    accessToken,
    credentialCeremony: "browser_storage_v0",
    reauthPurpose: "account_export",
  }).success).toBe(false);
  expect(authSupabaseSessionSchema.safeParse({
    accessToken,
    credentialCeremony: "browser_memory_v1",
    reauthPurpose: "arbitrary_sensitive_action",
  }).success).toBe(false);
});

it("bounds monthly report filenames and removes long boundary separator runs", async () => {
  expect(getMonthlyReportFilename({
    venueId: `${"-".repeat(250)}Carlton Hotel${"-".repeat(250)}`,
    month: "2026-05",
    format: "json",
  })).toBe("pint-path-Carlton-Hotel-2026-05-monthly-report.json");
  expect(getMonthlyReportFilename({
    venueId: "---Carlton Hotel---",
    month: "2026-05",
    format: "csv",
  })).toBe("pint-path-Carlton-Hotel-2026-05-monthly-report.csv");
});

it("classifies only deferred commercial venue API routes as launch-blocked", async () => {
  [
    "/account/discount-pass",
    "/account/free-pint-reward-code",
    "/account/counter-staff-invitations/assignment-1/respond",
    "/beta/pub-golf/plan",
    "/billing",
    "/billing/checkout",
    "/billing/checkout/reconcile",
    "/billing/portal",
    "/billing/recovery-portal",
    "/billing/demo-subscribe",
    "/billing/webhook",
    "/admin/leaderboard-prizes",
    "/admin/leaderboard-prizes/finalize",
    "/admin/reward-vouchers/voucher-1/transition",
    "/admin/reports/monthly/generate",
    "/admin/reports/monthly/deliver",
    "/pos/discount-redemptions",
    "/venue-portal/venue-1/reports/2026-05",
    "/venue-portal/venue-1/report-delivery",
    "/venue-portal/venue-1/reconciliation",
    "/venue-portal/venue-1/specials",
    "/venue-portal/venue-1/member-preview",
    "/venue-portal/venue-1/discount-redemptions",
    "/venue-portal/venue-1/pint-point-drinks",
    "/venue-portal/venue-1/counter-staff",
    "/venue-portal/venue-1/free-pint-rewards",
    "/venue-portal/venue-1/pos-integration",
    "/venue-portal/venue-1/billing/checkout",
    "/VENUE-PORTAL/venue-1/SPECIALS",
  ].forEach((pathName) => expect(isDeferredCommercialVenueRoute(pathName)).toBe(true));

  [
    "/venue-portal",
    "/venue-portal/venue-1/profile",
    "/venue-portal/venue-1/beers",
    "/venue-portal/venue-1/happy-hours",
    "/venue-claim-requests",
    "/wrong-price-reports",
    "/feedback",
    "/account-deletion-notifications/resend-webhook",
  ].forEach((pathName) => expect(isDeferredCommercialVenueRoute(pathName)).toBe(false));
});

let openDatabases: BetterSqlite3.Database[] = [];
let evidenceStorageDirs: string[] = [];
const repositoryDatabases = new WeakMap<BusinessRepository, BetterSqlite3.Database>();
const asyncDatabases = new WeakMap<BetterSqlite3.Database, SqlDatabase>();
const publicVenueDirectoryRepositories = new WeakMap<BusinessRepository, PublicVenueDirectoryRepository>();
const publicPriceRepositories = new WeakMap<BusinessRepository, PublicPriceRepository>();
const systemStateRepositories = new WeakMap<BusinessRepository, SystemStateRepository>();
const venueInventoryRepositories = new WeakMap<BusinessRepository, VenueInventoryRepository>();
const venueIdentityRepositories = new WeakMap<BusinessRepository, VenueIdentityRepository>();
const billingCheckoutRepositories = new WeakMap<BusinessRepository, BillingCheckoutRepository>();
const venueAccessRepositories = new WeakMap<BusinessRepository, VenueAccessRepository>();
const missionLifecycleRepositories = new WeakMap<BusinessRepository, MissionLifecycleRepository>();
const stripeSubscriptionRepositories = new WeakMap<BusinessRepository, StripeSubscriptionRepository>();
const venueRequestRepositories = new WeakMap<BusinessRepository, VenueRequestRepository>();
const venuePartnerRepositories = new WeakMap<BusinessRepository, VenuePartnerRepository>();
const adminAnalyticsRepositories = new WeakMap<BusinessRepository, AdminAnalyticsRepository>();
const venueManagerInsightsRepositories = new WeakMap<BusinessRepository, VenueManagerInsightsRepository>();
const accountDeletionQueueRepositories = new WeakMap<BusinessRepository, AccountDeletionQueueRepository>();
const accountPrivacyRepositories = new WeakMap<BusinessRepository, AccountPrivacyRepository>();
const privacyRetentionRepositories = new WeakMap<BusinessRepository, PrivacyRetentionRepository>();
const accountProfilePreferencesRepositories = new WeakMap<BusinessRepository, AccountProfilePreferencesRepository>();
const communitySubmissionRepositories = new WeakMap<BusinessRepository, CommunitySubmissionRepository>();
const venueManagerInternalSubmissionRepositories = new WeakMap<BusinessRepository, VenueManagerInternalSubmissionRepository>();
const sourceEvidenceObjectRepositories = new WeakMap<BusinessRepository, SourceEvidenceObjectRepository>();
const sourceEvidenceRetentionRepositories = new WeakMap<BusinessRepository, SourceEvidenceRetentionRepository>();
const venuePendingChangeRepositories = new WeakMap<BusinessRepository, VenuePendingChangeRepository>();
const venueDataReadRepositories = new WeakMap<BusinessRepository, VenueDataReadRepository>();
const activityAuditRepositories = new WeakMap<BusinessRepository, ActivityAuditRepository>();
const supportFeedbackRepositories = new WeakMap<BusinessRepository, SupportFeedbackRepository>();

function privacyRetentionBatch(
  overrides: Partial<PrivacyRetentionResult> = {},
): PrivacyRetentionResult {
  return {
    authSessionsDeleted: 0,
    providerRevocationsDeleted: 0,
    stripePayloadsRedacted: 0,
    stripeEnvelopesDeleted: 0,
    securityFingerprintsRedacted: 0,
    securityEnvelopesDeleted: 0,
    reviewedLocationsPurged: 0,
    migrationQuarantinePayloadsRedacted: 0,
    deletionNotificationEventsDeleted: 0,
    processedCount: 0,
    progressed: false,
    hasMore: false,
    hasActionableMore: false,
    stalled: false,
    stripeEnvelopeDeletionDeferred: true,
    stripeEnvelopesAwaitingTombstoneInBatch: 0,
    ...overrides,
  };
}

function getAsyncDatabase(database: BetterSqlite3.Database): SqlDatabase {
  const existing = asyncDatabases.get(database);
  if (existing) return existing;
  const created = asAsyncSqliteDatabase(database);
  asyncDatabases.set(database, created);
  return created;
}

function getVenueInventoryRepository(repository: BusinessRepository): VenueInventoryRepository {
  const inventory = venueInventoryRepositories.get(repository);
  if (!inventory) throw new Error("Venue inventory repository is not initialized for this test fixture.");
  return inventory;
}

function getVenueIdentityRepository(repository: BusinessRepository): VenueIdentityRepository {
  const identity = venueIdentityRepositories.get(repository);
  if (!identity) throw new Error("Venue identity repository is not initialized for this test fixture.");
  return identity;
}

function getBillingCheckoutRepository(repository: BusinessRepository): BillingCheckoutRepository {
  const billingCheckout = billingCheckoutRepositories.get(repository);
  if (!billingCheckout) throw new Error("Billing checkout repository is not initialized for this test fixture.");
  return billingCheckout;
}

function getVenueAccessRepository(repository: BusinessRepository): VenueAccessRepository {
  const venueAccess = venueAccessRepositories.get(repository);
  if (!venueAccess) throw new Error("Venue access repository is not initialized for this test fixture.");
  return venueAccess;
}

function getMissionLifecycleRepository(repository: BusinessRepository): MissionLifecycleRepository {
  const missionLifecycle = missionLifecycleRepositories.get(repository);
  if (!missionLifecycle) throw new Error("Mission lifecycle repository is not initialized for this test fixture.");
  return missionLifecycle;
}

function getStripeSubscriptionRepository(repository: BusinessRepository): StripeSubscriptionRepository {
  const stripeSubscription = stripeSubscriptionRepositories.get(repository);
  if (!stripeSubscription) throw new Error("Stripe subscription repository is not initialized for this test fixture.");
  return stripeSubscription;
}

function getVenueRequestRepository(repository: BusinessRepository): VenueRequestRepository {
  const venueRequest = venueRequestRepositories.get(repository);
  if (!venueRequest) throw new Error("Venue-request repository is not initialized for this test fixture.");
  return venueRequest;
}

function getVenuePartnerRepository(repository: BusinessRepository): VenuePartnerRepository {
  const venuePartner = venuePartnerRepositories.get(repository);
  if (!venuePartner) throw new Error("Venue-partner repository is not initialized for this test fixture.");
  return venuePartner;
}

function getAdminAnalyticsRepository(repository: BusinessRepository): AdminAnalyticsRepository {
  const adminAnalytics = adminAnalyticsRepositories.get(repository);
  if (!adminAnalytics) throw new Error("Admin analytics repository is not initialized for this test fixture.");
  return adminAnalytics;
}

function getVenueManagerInsightsRepository(repository: BusinessRepository): VenueManagerInsightsRepository {
  const venueManagerInsights = venueManagerInsightsRepositories.get(repository);
  if (!venueManagerInsights) throw new Error("Venue-manager insights repository is not initialized for this test fixture.");
  return venueManagerInsights;
}

function getSourceEvidenceObjectRepository(repository: BusinessRepository): SourceEvidenceObjectRepository {
  const sourceEvidenceObject = sourceEvidenceObjectRepositories.get(repository);
  if (!sourceEvidenceObject) throw new Error("Source-evidence object repository is not initialized for this test fixture.");
  return sourceEvidenceObject;
}

function getActivityAuditRepository(repository: BusinessRepository): ActivityAuditRepository {
  const activityAudit = activityAuditRepositories.get(repository);
  if (!activityAudit) throw new Error("Activity audit repository is not initialized for this test fixture.");
  return activityAudit;
}

function getSupportFeedbackRepository(repository: BusinessRepository): SupportFeedbackRepository {
  const supportFeedback = supportFeedbackRepositories.get(repository);
  if (!supportFeedback) throw new Error("Support feedback repository is not initialized for this test fixture.");
  return supportFeedback;
}

async function listSecurityAuditLogs(
  repository: BusinessRepository,
  input: number | { action?: string | null; actorUserId?: string | null } = 100,
) {
  const query = typeof input === "number" ? { limit: input } : { ...input, limit: 100 };
  return (await getActivityAuditRepository(repository).listSecurityAuditLogs(query)).items;
}

function databaseRowsForOwner(database: BetterSqlite3.Database, ownerUserId: string) {
  return database.prepare(
    `SELECT storage_provider, object_path, data_base64, external_url, byte_size, deleted_at
       FROM source_evidence_objects
      WHERE owner_user_id = ?
      ORDER BY id ASC`,
  ).all(ownerUserId);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

function createRepository() {
  const database = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(database);
  openDatabases.push(database);

  const repository = new BusinessRepository(database);
  repositoryDatabases.set(repository, database);
  publicVenueDirectoryRepositories.set(
    repository,
    new PublicVenueDirectoryRepository(getAsyncDatabase(database)),
  );
  publicPriceRepositories.set(
    repository,
    new PublicPriceRepository(getAsyncDatabase(database)),
  );
  systemStateRepositories.set(
    repository,
    new SystemStateRepository(getAsyncDatabase(database)),
  );
  activityAuditRepositories.set(
    repository,
    new ActivityAuditRepository(getAsyncDatabase(database)),
  );
  supportFeedbackRepositories.set(
    repository,
    new SupportFeedbackRepository(getAsyncDatabase(database)),
  );
  venueInventoryRepositories.set(
    repository,
    new VenueInventoryRepository(getAsyncDatabase(database)),
  );
  venueIdentityRepositories.set(
    repository,
    new VenueIdentityRepository(getAsyncDatabase(database)),
  );
  billingCheckoutRepositories.set(
    repository,
    new BillingCheckoutRepository(getAsyncDatabase(database)),
  );
  venueAccessRepositories.set(
    repository,
    new VenueAccessRepository(getAsyncDatabase(database)),
  );
  missionLifecycleRepositories.set(
    repository,
    new MissionLifecycleRepository(getAsyncDatabase(database)),
  );
  stripeSubscriptionRepositories.set(
    repository,
    new StripeSubscriptionRepository(getAsyncDatabase(database)),
  );
  venueRequestRepositories.set(
    repository,
    new VenueRequestRepository(getAsyncDatabase(database)),
  );
  venuePartnerRepositories.set(
    repository,
    new VenuePartnerRepository(getAsyncDatabase(database)),
  );
  adminAnalyticsRepositories.set(
    repository,
    new AdminAnalyticsRepository(getAsyncDatabase(database)),
  );
  venueManagerInsightsRepositories.set(
    repository,
    new VenueManagerInsightsRepository(getAsyncDatabase(database)),
  );
  accountDeletionQueueRepositories.set(
    repository,
    new AccountDeletionQueueRepository(getAsyncDatabase(database)),
  );
  accountPrivacyRepositories.set(
    repository,
    new AccountPrivacyRepository(getAsyncDatabase(database)),
  );
  privacyRetentionRepositories.set(
    repository,
    new PrivacyRetentionRepository(getAsyncDatabase(database)),
  );
  accountProfilePreferencesRepositories.set(
    repository,
    new AccountProfilePreferencesRepository(getAsyncDatabase(database)),
  );
  communitySubmissionRepositories.set(
    repository,
    new CommunitySubmissionRepository(getAsyncDatabase(database)),
  );
  venueManagerInternalSubmissionRepositories.set(
    repository,
    new VenueManagerInternalSubmissionRepository(getAsyncDatabase(database)),
  );
  sourceEvidenceObjectRepositories.set(
    repository,
    new SourceEvidenceObjectRepository(getAsyncDatabase(database)),
  );
  sourceEvidenceRetentionRepositories.set(
    repository,
    new SourceEvidenceRetentionRepository(getAsyncDatabase(database)),
  );
  venuePendingChangeRepositories.set(
    repository,
    new VenuePendingChangeRepository(getAsyncDatabase(database)),
  );
  venueDataReadRepositories.set(
    repository,
    new VenueDataReadRepository(getAsyncDatabase(database)),
  );

  return {
    database,
    repository,
  };
}

function createBusinessService(
  repository: BusinessRepository,
  overrides: Partial<ConstructorParameters<typeof BusinessService>[1]> = {},
  menuPhotoOcr?: ConstructorParameters<typeof BusinessService>[31],
  supabaseClientOverride?: ConstructorParameters<typeof BusinessService>[32],
  accountDeletionTombstoneWriter?: ConstructorParameters<typeof BusinessService>[33],
) {
  const evidenceStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-evidence-"));
  evidenceStorageDirs.push(evidenceStorageDir);

  const database = repositoryDatabases.get(repository)!;
  const accountDeletionQueueRepository = accountDeletionQueueRepositories.get(repository)!;
  const accountPrivacyRepository = accountPrivacyRepositories.get(repository)!;
  const privacyRetentionRepository = privacyRetentionRepositories.get(repository)!;
  const performAccountDeletionSecretPhysicalCheckpoint =
    createSqliteAccountDeletionSecretPhysicalCheckpoint(database);
  const deletionNotificationCoordinator = new AccountDeletionNotificationCoordinator(accountDeletionQueueRepository, {
    provider: createMockAccountDeletionNotificationProvider(),
    keyring: {
      activeKeyId: "test-v1",
      keys: new Map([["test-v1", Buffer.alloc(32, 7)]]),
    },
    performRecipientSecretPhysicalCheckpoint: performAccountDeletionSecretPhysicalCheckpoint,
    publicBaseUrl: "http://127.0.0.1:3000",
    from: "account@mock.pintpath.local",
    replyTo: "admin@pintpath.au",
    supportEmail: "admin@pintpath.au",
  });

  return new BusinessService(repository, {
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    CONTRIBUTOR_UNLOCK_POINTS: 15,
    CONTRIBUTOR_UNLOCK_DAYS: 30,
    DEMO_BILLING_MODE: true,
    COMMERCIAL_LAUNCH_ENABLED: true,
    CONSUMER_PAID_ENROLLMENT_ENABLED: true,
    FIELD_TEST_MODE: false,
    PINT_POINTS_REWARDS_ENABLED: true,
    ALCOHOL_GAMIFICATION_ENABLED: true,
    SESSION_TTL_DAYS: 60,
    ADMIN_SESSION_TTL_DAYS: 7,
    REQUIRE_ADMIN_MFA_IN_PRODUCTION: true,
    ADMIN_MFA_MAX_AGE_MINUTES: 720,
    REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
    ANALYTICS_MIN_BUCKET_SIZE: 5,
    REPORT_TIMEZONE: "Australia/Melbourne",
    REPORT_EMAIL_MODE: "disabled",
    ACCOUNT_DELETION_NOTICE_MODE: "mock",
    RESEND_WEBHOOK_SIGNING_SECRET: `whsec_${Buffer.alloc(32, 8).toString("base64")}`,
    ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: false,
    SOURCE_EVIDENCE_STORAGE_DIR: evidenceStorageDir,
    SOURCE_EVIDENCE_SIGNING_SECRET: "test-source-evidence-signing-secret-32-bytes",
    SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS: 300,
    POS_WEBHOOK_SIGNING_SECRET: "test-pos-webhook-signing-secret-32-bytes",
    NODE_ENV: "test",
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
    ADMIN_EMAILS: "admin@example.com",
    GOOGLE_MAPS_API_KEY: undefined,
    GOOGLE_PLACES_API_KEY: undefined,
    ...overrides,
  }, publicVenueDirectoryRepositories.get(repository)!,
  publicPriceRepositories.get(repository)!,
  systemStateRepositories.get(repository)!,
  getActivityAuditRepository(repository),
  getSupportFeedbackRepository(repository),
  new AccountSessionRepository(getAsyncDatabase(repositoryDatabases.get(repository)!)),
  accountProfilePreferencesRepositories.get(repository)!,
  venueInventoryRepositories.get(repository)!,
  venueIdentityRepositories.get(repository)!,
  billingCheckoutRepositories.get(repository)!,
  venueAccessRepositories.get(repository)!,
  getMissionLifecycleRepository(repository),
  new MissionDiscoveryAutomationRepository(getAsyncDatabase(database)),
  getStripeSubscriptionRepository(repository),
  getVenueRequestRepository(repository),
  getVenuePartnerRepository(repository),
  getAdminAnalyticsRepository(repository),
  getVenueManagerInsightsRepository(repository),
  new AdminAccountRepository(getAsyncDatabase(database)),
  accountDeletionQueueRepository,
  accountPrivacyRepository,
  privacyRetentionRepository,
  communitySubmissionRepositories.get(repository)!,
  venueManagerInternalSubmissionRepositories.get(repository)!,
  sourceEvidenceObjectRepositories.get(repository)!,
  sourceEvidenceRetentionRepositories.get(repository)!,
  venuePendingChangeRepositories.get(repository)!,
  venueDataReadRepositories.get(repository)!,
  performAccountDeletionSecretPhysicalCheckpoint,
  new BeerCatalogRepository(getAsyncDatabase(repositoryDatabases.get(repository)!)), menuPhotoOcr, supabaseClientOverride,
  accountDeletionTombstoneWriter,
  deletionNotificationCoordinator);
}

function createAccount(repository: BusinessRepository, id: string, role: "user" | "admin" = "user") {
  const account = repository.createAccount({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    role,
    subscriptionStatus: role === "admin" ? "admin" : "free",
    termsAcceptedAt: NOW,
    privacyAcceptedAt: NOW,
    termsVersion: CURRENT_LEGAL_POLICY_VERSION,
    privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
    now: NOW,
  });

  return repository.updateAgeConfirmed(account.id, NOW);
}

function pendingBarChangeFrom(result: unknown): BarPendingChange {
  return (result as { pendingChange: BarPendingChange }).pendingChange;
}

function createSubmission(
  repository: BusinessRepository,
  input: {
    id: string;
    userId: string;
    venueId: string;
    venueName?: string;
    submissionType?: SubmissionType;
    beerName?: string;
    servingSize?: string;
    price?: number | null;
    sourcePhotoUrl?: string | null;
  },
) {
  const database = repositoryDatabases.get(repository)!;
  const requestedBeerName = input.beerName ?? "Carlton Draught";
  const aliasKey = normalizeBeerSearchKey(requestedBeerName);
  let catalog = database.prepare(
    `SELECT item.key AS key, item.name AS name
       FROM beer_catalog_aliases alias
       INNER JOIN beer_catalog_items item ON item.key = alias.beer_key
      WHERE alias.alias_key = ?
      LIMIT 1`,
  ).get(aliasKey) as { key: string; name: string } | undefined;
  if (!catalog) {
    const key = aliasKey || `test_beer_${input.id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
    database.prepare(
      `INSERT OR IGNORE INTO beer_catalog_items (
        key, name, brewery, style, abv, status, source, review_note, created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, NULL, 'active', 'test_fixture', NULL, ?, ?)`,
    ).run(key, requestedBeerName, NOW, NOW);
    database.prepare(
      `INSERT OR IGNORE INTO beer_catalog_aliases (alias_key, beer_key, alias, source, created_at)
       VALUES (?, ?, ?, 'test_fixture', ?)`,
    ).run(aliasKey || key, key, requestedBeerName, NOW);
    catalog = { key, name: requestedBeerName };
  }

  const requestedEvidence = input.sourcePhotoUrl ?? JPEG_DATA_URL;
  const evidenceId = requestedEvidence.startsWith("private:evidence:")
    ? requestedEvidence.slice("private:evidence:".length)
    : `${input.id}:evidence`;
  database.prepare(
    `INSERT OR IGNORE INTO source_evidence_objects (
       id, owner_user_id, storage_provider, object_path, mime_type, byte_size,
       data_base64, external_url, retention_expires_at, deleted_at, created_at
     ) VALUES (?, ?, 'filesystem_private', ?, 'image/jpeg', 10, NULL, NULL, ?, NULL, ?)`,
  ).run(
    evidenceId,
    input.userId,
    `test-fixtures/${evidenceId.replace(/[^a-z0-9._-]+/gi, "_")}.jpg`,
    "2027-05-04T08:00:00.000Z",
    NOW,
  );
  const sourcePhotoUrl = `private:evidence:${evidenceId}`;
  const insert = database.transaction(() => {
    database.prepare(
      `INSERT INTO submissions (
         id, client_submission_id, mission_id, user_id, venue_id, venue_name, suburb,
         status, submission_type, observed_at, source_photo_url, ocr_status,
         ocr_summary_json, notes, points_awarded, upload_latitude, upload_longitude,
         upload_accuracy_meters, upload_location_captured_at, distance_to_venue_meters,
         points_eligible_by_location, points_eligibility_reason, pending_venue_json,
         reviewed_by, reviewed_at, rejection_reason, fraud_flagged, created_at, updated_at
       ) VALUES (
         ?, NULL, NULL, ?, ?, ?, 'Melbourne',
         'pending', ?, ?, ?, 'not_requested',
         NULL, 'Menu board photo supplied.', 0, NULL, NULL,
         NULL, NULL, NULL, 0, NULL, NULL,
         NULL, NULL, NULL, 0, ?, ?
       )`,
    ).run(
      input.id,
      input.userId,
      input.venueId,
      input.venueName ?? "Test Bar",
      input.submissionType ?? "full_venue_update",
      NOW,
      sourcePhotoUrl,
      NOW,
      NOW,
    );
    database.prepare(
      `INSERT INTO submission_items (
         id, submission_id, beer_name, normalized_beer_id, serving_size, price,
         is_happy_hour_price, happy_hour_details, is_on_tap, confidence,
         capture_source, source_text, requires_catalog_approval, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 'yes', 0.88, 'manual', NULL, 0, ?)`,
    ).run(
      `${input.id}:item-1`,
      input.id,
      catalog.name,
      catalog.key,
      input.servingSize ?? "pint",
      input.price ?? 14,
      NOW,
    );
    database.prepare(
      `INSERT INTO submission_source_evidence (submission_id, evidence_id, sort_order, created_at)
       VALUES (?, ?, 0, ?)`,
    ).run(input.id, evidenceId, NOW);
  });
  insert.immediate();
  return repository.getSubmissionById(input.id)!.submission;
}

function approve(
  repository: BusinessRepository,
  submissionId: string,
  reviewerId: string,
  pointsAwarded = 5,
) {
  return repository.reviewSubmission({
    submissionId,
    reviewerId,
    status: "approved",
    rejectionReason: null,
    fraudFlagged: false,
    pointsAwarded,
    confidence: "photo_verified",
    now: NOW,
    monthKey: MONTH_KEY,
    premiumUntil: PREMIUM_UNTIL,
    contributorUnlockPoints: 15,
  });
}

function flagFraud(repository: BusinessRepository, submissionId: string, reviewerId: string) {
  return repository.reviewSubmission({
    submissionId,
    reviewerId,
    status: "fraud_flagged",
    rejectionReason: "Fraud flagged in review.",
    fraudFlagged: true,
    pointsAwarded: 0,
    confidence: "disputed",
    now: NOW,
    monthKey: MONTH_KEY,
    premiumUntil: PREMIUM_UNTIL,
    contributorUnlockPoints: 15,
  });
}

function updateSubscription(
  repository: BusinessRepository,
  userId: string,
  subscriptionStatus: SubscriptionStatus,
  premiumUntil: string | null = null,
) {
  return repository.updateSubscription({
    userId,
    subscriptionStatus,
    premiumUntil,
    now: NOW,
  });
}

function createSession(repository: BusinessRepository, userId: string, token: string, expiresAt = PREMIUM_UNTIL) {
  repository.createSession({
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    userId,
    createdAt: NOW,
    expiresAt,
  });

  return `Bearer ${token}`;
}

function createStripeSignature(payload: object, secret: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body.toString("utf8")}`)
    .digest("hex");

  return {
    body,
    header: `t=${timestamp},v1=${signature}`,
  };
}

async function withHttpServer(
  app: express.Express,
  callback: (baseUrl: string) => Promise<void>,
) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  openDatabases.forEach((database) => database.close());
  openDatabases = [];
  evidenceStorageDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  evidenceStorageDirs = [];
});

describe("submission payload validation", () => {
  const baseSubmission = {
    venueId: "venue-1",
    venueName: "Test Bar",
    suburb: "Melbourne",
    observedAt: NOW,
    sourcePhotoDataUrl: JPEG_DATA_URL,
    sourcePhotoUrl: null,
    notes: null,
  };
  const submissionItem = (overrides: Record<string, unknown> = {}) => ({
    beerName: "Guinness",
    servingSize: "pint",
    price: 13,
    isHappyHourPrice: false,
    happyHourDetails: null,
    isOnTap: "yes",
    ...overrides,
  });

  it("allows photo/source uploads without manual beer rows", async () => {
    const parsed = createSubmissionSchema.parse({
      ...baseSubmission,
      clientSubmissionId: "queued-test-001",
      submissionType: "photo_upload",
      items: [],
    });

    expect(parsed.items).toEqual([]);
    expect(parsed.clientSubmissionId).toBe("queued-test-001");
  });

  it("rejects unsafe client submission IDs", async () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      clientSubmissionId: "queued bad/id",
      submissionType: "photo_upload",
      items: [],
    });

    expect(result.success).toBe(false);
  });

  it("still requires a beer row for single beer price submissions", async () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "single_beer_price",
      items: [],
    });

    expect(result.success).toBe(false);
  });

  it("requires exactly one beer row for single beer price submissions", async () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "single_beer_price",
      items: [submissionItem(), submissionItem({ beerName: "Carlton Draught" })],
    });

    expect(result.success).toBe(false);
  });

  it.each([
    [0, "zero"],
    [-1, "negative"],
    [250.01, "over the maximum"],
    [12.345, "more than two decimal places"],
  ])("rejects a %s price (%s)", (price) => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "single_beer_price",
      items: [submissionItem({ price })],
    });

    expect(result.success).toBe(false);
  });

  it.each([0.01, 12.3, 12.34, 250, "12.30"])("accepts a valid price of %s", (price) => {
    const parsed = createSubmissionSchema.parse({
      ...baseSubmission,
      submissionType: "single_beer_price",
      items: [submissionItem({ price })],
    });

    expect(parsed.items[0]?.price).toBe(Number(price));
  });

  it("requires three beer rows for full venue updates", async () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "full_venue_update",
      items: [{
        beerName: "Guinness",
        servingSize: "pint",
        price: 13,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }, {
        beerName: "Carlton Draught",
        servingSize: "pint",
        price: 12,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    });

    expect(result.success).toBe(false);
  });

  it("requires every full venue update row to contain a meaningful observation", async () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "full_venue_update",
      items: [
        submissionItem(),
        submissionItem({
          beerName: "Carlton Draught",
          price: null,
          isHappyHourPrice: true,
          isOnTap: "unknown",
        }),
        submissionItem({ beerName: "Stone & Wood Pacific Ale" }),
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["items", 1, "price"] }),
      ]));
    }
  });

  it("rejects duplicate normalized beer and serving rows", async () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "full_venue_update",
      items: [
        submissionItem({ beerName: "Stone & Wood Pacific Ale", price: 14 }),
        submissionItem({ beerName: " stone and wood pacific ale ", price: 15 }),
        submissionItem({ beerName: "Guinness" }),
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["items", 1, "beerName"] }),
      ]));
    }
  });

  it("allows the same normalized beer in different serving sizes", async () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "full_venue_update",
      items: [
        submissionItem({ beerName: "Stone & Wood Pacific Ale", price: 14 }),
        submissionItem({ beerName: "stone and wood pacific ale", servingSize: "pot", price: 8 }),
        submissionItem({ beerName: "Guinness" }),
      ],
    });

    expect(result.success).toBe(true);
  });

  it("requires source evidence for photo/source uploads", async () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "photo_upload",
      sourcePhotoDataUrl: null,
      items: [],
    });

    expect(result.success).toBe(false);
  });

  it("allows happy-hour updates without forcing a source photo upload", async () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "happy_hour_update",
      sourcePhotoDataUrl: null,
      items: [{
        beerName: "Happy hour specials",
        servingSize: "pint",
        price: null,
        isHappyHourPrice: true,
        happyHourDetails: "Mon-Fri, 5pm-7pm. $9 house pints.",
        isOnTap: "unknown",
      }],
    });

    expect(result.success).toBe(true);
  });

  it("accepts new venue details without coercing blank coordinates to zero", async () => {
    const parsed = createSubmissionSchema.parse({
      ...baseSubmission,
      venueId: "venue-new",
      venueName: "Moonlit Taproom",
      suburb: "Fitzroy",
      newVenue: {
        name: "Moonlit Taproom",
        address: "10 Test Lane",
        suburb: "Fitzroy",
        state: "VIC",
        postcode: "",
        phone: "",
        website: "",
        latitude: "",
        longitude: "",
      },
      submissionType: "full_venue_update",
      items: [
        { beerName: "Guinness", servingSize: "pint", price: 13, isHappyHourPrice: false, happyHourDetails: null, isOnTap: "yes" },
        { beerName: "Carlton Draught", servingSize: "pint", price: 12, isHappyHourPrice: false, happyHourDetails: null, isOnTap: "yes" },
        { beerName: "Stone & Wood Pacific Ale", servingSize: "pint", price: 14, isHappyHourPrice: false, happyHourDetails: null, isOnTap: "yes" },
      ],
    });

    expect(parsed.newVenue?.latitude).toBeNull();
    expect(parsed.newVenue?.longitude).toBeNull();
    expect(createSubmissionSchema.safeParse({
      ...parsed,
      newVenue: {
        ...parsed.newVenue!,
        postcode: "3OOO",
      },
    }).success).toBe(false);
  });
});

describe("bar happy-hour time validation", () => {
  it("normalises human-friendly bar times into 24-hour storage values", async () => {
    expect(normalizeHappyHourTime("7:30 pm")).toBe("19:30");
    expect(normalizeHappyHourTime("07.30pm")).toBe("19:30");
    expect(normalizeHappyHourTime("730pm")).toBe("19:30");
    expect(normalizeHappyHourTime("1930")).toBe("19:30");
    expect(normalizeHappyHourTime("12:30 am")).toBe("00:30");
  });

  it("accepts friendly happy-hour times through the bar portal schema", async () => {
    const parsed = barHappyHourSchema.parse({
      title: "Weekend Happy Hour",
      daysOfWeek: ["sat", "sun"],
      startTime: "7:30 pm",
      endTime: "12.30 am",
      description: "$5 basics and selected pints.",
      active: true,
    });

    expect(parsed.startTime).toBe("19:30");
    expect(parsed.endTime).toBe("00:30");
  });
});

describe("submission queue access checks", () => {
  it("defaults non-admin submission listing to the caller's own queue", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "user");
    const otherUser = createAccount(repository, "other-user");
    const admin = createAccount(repository, "admin", "admin");

    const ownSubmission = createSubmission(repository, {
      id: "own-submission",
      userId: user.id,
      venueId: "venue-1",
    });
    createSubmission(repository, {
      id: "other-submission",
      userId: otherUser.id,
      venueId: "venue-2",
    });

    await expect(service.listSubmissions(null, { mine: false, limit: 10 })).rejects.toThrow("Login required.");
    expect(await service.listSubmissions(user, { mine: false, limit: 10 })).toEqual([ownSubmission]);
    expect(await service.listSubmissions(admin, { mine: false, limit: 10 })).toHaveLength(2);
    expect(await service.listSubmissions(user, { mine: false, limit: 10, includeReviewData: true })).toEqual([ownSubmission]);
    expect(await service.listSubmissions(admin, { mine: false, limit: 10, includeReviewData: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: ownSubmission.id,
        items: expect.arrayContaining([
          expect.objectContaining({
            beerName: "Carlton Draught",
            price: 14,
          }),
        ]),
      }),
    ]));
  });
});

describe("Supabase account and verification foundation", () => {
  it("upgrades legacy local databases before login/account queries need new columns", async () => {
    const database = new BetterSqlite3(":memory:");
    openDatabases.push(database);
    database.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        age_confirmed_at TEXT,
        subscription_status TEXT NOT NULL DEFAULT 'free',
        stripe_customer_id TEXT,
        premium_until TEXT,
        trust_score INTEGER NOT NULL DEFAULT 50,
        contribution_points_current_month INTEGER NOT NULL DEFAULT 0,
        approved_submission_count INTEGER NOT NULL DEFAULT 0,
        rejected_submission_count INTEGER NOT NULL DEFAULT 0,
        fraud_strike_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);

    initializeDatabaseSchema(database);

    const accountColumns = database.prepare("PRAGMA table_info(accounts)").all().map((column: { name: string }) => column.name);
    const sessionColumns = database.prepare("PRAGMA table_info(auth_sessions)").all().map((column: { name: string }) => column.name);

    expect(accountColumns).toEqual(expect.arrayContaining([
      "public_account_id",
      "display_name",
      "avatar_url",
      "auth_provider",
      "supabase_user_id",
      "email_verified_at",
      "mfa_level",
      "mfa_verified_at",
      "age_verification_status",
      "is_over_18_verified",
    ]));
    expect(sessionColumns).toEqual(expect.arrayContaining([
      "revoked_at",
      "last_used_at",
      "last_ip_hash",
      "user_agent_hash",
    ]));
    expect(database.prepare("PRAGMA table_info(profiles)").all()).not.toHaveLength(0);
    expect(database.prepare("PRAGMA table_info(user_activity_events)").all()).not.toHaveLength(0);
  });

  it("migrates legacy feedback tables before creating priority indexes", async () => {
    const database = new BetterSqlite3(":memory:");
    openDatabases.push(database);
    database.exec(`
      CREATE TABLE feedback (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        anonymous_session_id TEXT,
        feedback_type TEXT NOT NULL,
        message TEXT NOT NULL,
        venue_id TEXT,
        venue_name TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    initializeDatabaseSchema(database);

    const feedbackColumns = database
      .prepare("PRAGMA table_info(feedback)")
      .all()
      .map((column: { name: string }) => column.name);
    const feedbackIndexes = database
      .prepare("PRAGMA index_list(feedback)")
      .all()
      .map((index: { name: string }) => index.name);

    expect(feedbackColumns).toEqual(expect.arrayContaining(["priority", "triage_reason"]));
    expect(feedbackIndexes).toContain("idx_feedback_priority_created");
  });

  it("adds idempotency columns before creating their indexes on legacy production tables", async () => {
    const database = new BetterSqlite3(":memory:");
    openDatabases.push(database);
    database.exec(`
      CREATE TABLE discount_redemptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        public_account_id TEXT NOT NULL,
        venue_id TEXT NOT NULL,
        venue_name TEXT NOT NULL,
        suburb TEXT,
        special_id TEXT,
        item_name TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        estimated_savings_cents INTEGER NOT NULL DEFAULT 0,
        discount_pass_id TEXT,
        redeemed_by_user_id TEXT,
        redeemed_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE pint_point_drink_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        venue_id TEXT NOT NULL,
        venue_name TEXT NOT NULL,
        suburb TEXT,
        item_name TEXT,
        beverage_category TEXT NOT NULL DEFAULT 'alcoholic',
        quantity INTEGER NOT NULL DEFAULT 1,
        is_alcoholic INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL DEFAULT 'venue_portal',
        reward_code_id TEXT,
        recorded_by_user_id TEXT,
        recorded_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);

    initializeDatabaseSchema(database);

    const redemptionColumns = database
      .prepare("PRAGMA table_info(discount_redemptions)")
      .all()
      .map((column: { name: string }) => column.name);
    const drinkColumns = database
      .prepare("PRAGMA table_info(pint_point_drink_records)")
      .all()
      .map((column: { name: string }) => column.name);
    const redemptionIndexes = database
      .prepare("PRAGMA index_list(discount_redemptions)")
      .all()
      .map((index: { name: string }) => index.name);
    const drinkIndexes = database
      .prepare("PRAGMA index_list(pint_point_drink_records)")
      .all()
      .map((index: { name: string }) => index.name);

    expect(redemptionColumns).toContain("idempotency_key");
    expect(drinkColumns).toEqual(expect.arrayContaining(["points_awarded", "idempotency_key"]));
    expect(redemptionIndexes).toContain("idx_discount_redemptions_idempotency");
    expect(drinkIndexes).toContain("idx_pint_point_drink_records_idempotency");
    expect(database.pragma("user_version", { simple: true })).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
    database.prepare(
      `INSERT INTO pint_point_drink_records (
        id, user_id, venue_id, venue_name, recorded_at, created_at
      ) VALUES ('migration-record', 'legacy-user', 'legacy-venue', 'Legacy Venue', ?, ?)`,
    ).run(NOW, NOW);
    expect(() => database.prepare("UPDATE pint_point_drink_records SET status = 'broken' WHERE id = 'migration-record'").run()).toThrow(
      "invalid pint point record status",
    );
    const migrationRepository = new BusinessRepository(database);
    const migrationAccount = createAccount(migrationRepository, "migration-assignment-user");
    expect(() => database.prepare(
      `INSERT INTO venue_manager_assignments (
        id, user_id, venue_id, venue_name, access_level, status, expires_at, created_at, updated_at
      ) VALUES ('invalid-pending-manager', ?, 'migration-venue', 'Migration Venue', 'manager', 'pending', ?, ?, ?)`,
    ).run(migrationAccount.id, PREMIUM_UNTIL, NOW, NOW)).toThrow("invalid venue assignment state");
    expect(() => database.prepare(
      `INSERT INTO venue_manager_assignments (
        id, user_id, venue_id, venue_name, access_level, status, expires_at, created_at, updated_at
      ) VALUES ('invalid-invitation-expiry', ?, 'migration-venue', 'Migration Venue', 'counter_staff', 'pending', 'not-a-date', ?, ?)`,
    ).run(migrationAccount.id, NOW, NOW)).toThrow("invalid venue assignment state");
    expect(() => database.prepare(
      `INSERT INTO venue_claim_requests (
        id, user_id, venue_name, requester_name, requester_role, contact_email,
        status, reviewed_at, created_at, updated_at
      ) VALUES ('invalid-approved-claim', ?, 'Migration Venue', 'Manager', 'Owner', 'owner@example.com',
        'approved', NULL, ?, ?)`,
    ).run(migrationAccount.id, NOW, NOW)).toThrow("invalid venue claim review state");
    expect(() => database.prepare(
      `INSERT INTO venue_claim_requests (
        id, user_id, venue_name, requester_name, requester_role, contact_email,
        status, reviewed_at, created_at, updated_at
      ) VALUES ('invalid-claim-review-time', ?, 'Migration Venue', 'Manager', 'Owner', 'owner@example.com',
        'approved', 'not-a-date', ?, ?)`,
    ).run(migrationAccount.id, NOW, NOW)).toThrow("invalid venue claim review state");
  });

  it("creates an app-facing profile row when an account is created", async () => {
    const { repository } = createRepository();
    const account = createAccount(repository, "profile-user");
    const profile = await accountProfilePreferencesRepositories.get(repository)!.getProfileById(account.id);

    expect(profile).toEqual(expect.objectContaining({
      id: account.id,
      email: "profile-user@example.com",
      role: "user",
      accountStatus: "active",
      ageVerificationStatus: "not_started",
      isOver18Verified: false,
    }));
  });

  it("exchanges a Supabase Auth session for the local Pint Path session", async () => {
    const { repository } = createRepository();
    const totpVerifiedAtSeconds = Math.floor(new Date(NOW).getTime() / 1000) - 300;
    const accessToken = [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({
        aal: "aal2",
        session_id: "provider-session-original",
        amr: [
          { method: "password", timestamp: totpVerifiedAtSeconds - 60 },
          { method: "totp", timestamp: totpVerifiedAtSeconds },
        ],
      })).toString("base64url"),
      "test-signature-value",
    ].join(".");
    const globalSignOut = vi.fn(async () => ({ data: null, error: null }));
    const service = createBusinessService(repository, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "placeholder-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
    });
    (service as unknown as { supabase: unknown }).supabase = {
      auth: {
        admin: { signOut: globalSignOut },
        getUser: async () => ({
          data: {
            user: {
              id: "supabase-user-1",
              email: "oauth-user@example.com",
              factors: [{ id: "totp-factor-1", factor_type: "totp", status: "verified" }],
              user_metadata: {
                full_name: "OAuth User",
                avatar_url: "https://example.com/avatar.png",
                age_confirmed: true,
                terms_accepted: true,
                privacy_accepted: true,
                terms_version: "user-controlled",
                privacy_version: "user-controlled",
              },
            },
          },
          error: null,
        }),
      },
    };

    await expect(service.loginWithSupabaseAccessToken({ accessToken }))
      .rejects.toThrow("Accept the current Terms and Privacy Policy");
    expect(repository.getAccountBySupabaseUserId("supabase-user-1")).toBeNull();

    const result = await service.loginWithSupabaseAccessToken({
      accessToken,
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: CURRENT_LEGAL_POLICY_VERSION,
      privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentSource: "web",
    });
    const linkedAccount = repository.getAccountBySupabaseUserId("supabase-user-1");
    const profile = await accountProfilePreferencesRepositories.get(repository)!.getProfileById(result.account.id);

    expect(result.token.length).toBeGreaterThan(30);
    expect(result.account.email).toBe("oauth-user@example.com");
    expect(linkedAccount?.id).toBe(result.account.id);
    expect(linkedAccount?.ageConfirmedAt).toBe(NOW);
    expect(linkedAccount?.termsAcceptedAt).toBe(NOW);
    expect(linkedAccount?.privacyAcceptedAt).toBe(NOW);
    expect(linkedAccount?.mfaLevel).toBe("aal2");
    expect(linkedAccount?.mfaVerifiedAt).toBe(new Date(totpVerifiedAtSeconds * 1000).toISOString());
    expect(profile).toEqual(expect.objectContaining({
      id: result.account.id,
      email: "oauth-user@example.com",
      displayName: "OAuth User",
      avatarUrl: "https://example.com/avatar.png",
    }));
    expect((await getActivityAuditRepository(repository).listUserActivityEvents({ userId: result.account.id, limit: 10 })).items.map((event) => event.eventType))
      .toEqual(expect.arrayContaining(["user_signup", "user_login"]));

    const repeated = await service.loginWithSupabaseAccessToken(
      { accessToken },
      undefined,
      `Bearer ${result.token}`,
    );
    expect(repeated.token).not.toBe(result.token);
    expect(repeated).not.toHaveProperty("reused");
    expect(repositoryDatabases.get(repository)!
      .prepare("SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL")
      .get(result.account.id)).toEqual({ count: 1 });
    expect((await getActivityAuditRepository(repository).listUserActivityEvents({ userId: result.account.id, limit: 20 })).items.filter((event) => event.eventType === "user_login"))
      .toHaveLength(2);

    const session = (await service.listAccountSessions(linkedAccount!, `Bearer ${repeated.token}`, { limit: 10, offset: 0 })).sessions[0]!;
    expect(session.providerBacked).toBe(true);
    expect((await service.revokeAccountSession(linkedAccount!, linkedAccount!.id, session.id)).revoked).toBe(true);

    await expect(service.loginWithSupabaseAccessToken({ accessToken }))
      .rejects.toThrow("sign-in provider session was revoked");

    const newProviderAccessToken = [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({
        aal: "aal2",
        session_id: "provider-session-new-device-login",
        amr: [{ method: "totp", timestamp: totpVerifiedAtSeconds }],
      })).toString("base64url"),
      "new-test-signature-value",
    ].join(".");
    const newProviderSession = await service.loginWithSupabaseAccessToken({ accessToken: newProviderAccessToken });
    expect(newProviderSession).toEqual(expect.objectContaining({ token: expect.any(String) }));
    const refreshedAccount = repository.getAccountBySupabaseUserId("supabase-user-1")!;
    const logoutSessionRepository = (service as unknown as {
      accountSessionRepository: AccountSessionRepository;
    }).accountSessionRepository;
    const originalRevokeUserSessions = logoutSessionRepository.revokeUserSessionsWithSummary
      .bind(logoutSessionRepository);
    const failedLogoutContainment = vi.spyOn(logoutSessionRepository, "revokeUserSessionsWithSummary")
      .mockRejectedValueOnce(new Error("simulated logout containment failure"));
    await expect(service.logoutAll(refreshedAccount, { accessToken: newProviderAccessToken }))
      .rejects.toThrow("simulated logout containment failure");
    expect(globalSignOut).not.toHaveBeenCalled();
    expect(await service.getAccountFromAuthorization(`Bearer ${newProviderSession.token}`))
      .toEqual(expect.objectContaining({ id: refreshedAccount.id }));
    failedLogoutContainment.mockImplementation(originalRevokeUserSessions);
    expect((await service.logoutAll(refreshedAccount, { accessToken: newProviderAccessToken })).revokedCount).toBeGreaterThan(0);
    expect(globalSignOut).toHaveBeenCalledWith(newProviderAccessToken, "global");
    expect(repository.getAccountBySupabaseUserId("supabase-user-1")?.providerTokensValidAfter)
      .toBe(new Date(Date.parse(NOW) + 60_000).toISOString());
    expect(await repository.isProviderSessionRevoked({
      userId: refreshedAccount.id,
      providerSessionIdHash: crypto.createHash("sha256")
        .update("supabase-session:provider-session-new-device-login")
        .digest("hex"),
    })).toBe(true);
    await expect(service.loginWithSupabaseAccessToken({ accessToken: newProviderAccessToken }))
      .rejects.toThrow("predates a security reset");

    const suspensionAccessToken = [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({
        aal: "aal2",
        session_id: "provider-session-before-suspension",
        iat: totpVerifiedAtSeconds + 421,
        amr: [{ method: "totp", timestamp: totpVerifiedAtSeconds + 421 }],
      })).toString("base64url"),
      "suspension-test-signature-value",
    ].join(".");
    await service.loginWithSupabaseAccessToken({ accessToken: suspensionAccessToken });
    const admin = createAccount(repository, "provider-session-admin", "admin");
    await service.adminOverrideUser(admin, refreshedAccount.id, {
      status: "suspended",
      reason: "Confirmed account-security incident.",
    });
    await expect(service.loginWithSupabaseAccessToken({ accessToken: suspensionAccessToken }))
      .rejects.toThrow("sign-in provider session was revoked");
  });

  it("requires AAL2 before any verified provider factor can create, refresh, or prove an app session", async () => {
    const { database, repository } = createRepository();
    const nowSeconds = Math.floor(Date.parse(NOW) / 1000);
    const providerUser = {
      id: "mfa-gated-provider-user",
      email: "mfa-gated-provider-user@example.com",
      email_confirmed_at: NOW,
      user_metadata: {},
      factors: [
        { id: "verified-totp-factor", factor_type: "totp", status: "verified" },
      ],
    };
    const getUser = vi.fn(async () => ({ data: { user: providerUser }, error: null }));
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "placeholder-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
    });
    (service as unknown as { supabase: unknown }).supabase = { auth: { getUser } };
    const token = (input: { sessionId: string; aal: "aal1" | "aal2"; method: "password" | "totp" }) =>
      testSupabaseAccessToken({
        sub: providerUser.id,
        iat: nowSeconds - 30,
        auth_time: nowSeconds - 30,
        session_id: input.sessionId,
        aal: input.aal,
        amr: [{ method: input.method, timestamp: nowSeconds - 30 }],
      }, `mfa-gated-${input.sessionId}`);
    const aal1Token = token({ sessionId: "mfa-aal1-create", aal: "aal1", method: "password" });

    await expect(service.loginWithSupabaseAccessToken({
      accessToken: aal1Token,
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: CURRENT_LEGAL_POLICY_VERSION,
      privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentSource: "web",
    })).rejects.toMatchObject({
      statusCode: 403,
      details: expect.objectContaining({
        publicCode: "MFA_STEP_UP_REQUIRED",
        mfaRequired: true,
      }),
    });
    expect(repository.getAccountBySupabaseUserId(providerUser.id)).toBeNull();

    const aal2Token = token({ sessionId: "mfa-aal2-create", aal: "aal2", method: "totp" });
    let login = await service.loginWithSupabaseAccessToken({
      accessToken: aal2Token,
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: CURRENT_LEGAL_POLICY_VERSION,
      privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentSource: "web",
    });
    let account = repository.getAccountBySupabaseUserId(providerUser.id)!;
    expect(account.mfaLevel).toBe("aal2");

    await expect(service.loginWithSupabaseAccessToken({ accessToken: aal1Token }, undefined, `Bearer ${login.token}`))
      .rejects.toMatchObject({
        statusCode: 403,
        details: expect.objectContaining({ publicCode: "MFA_STEP_UP_REQUIRED" }),
      });
    expect(repository.getAccountBySupabaseUserId(providerUser.id)?.mfaLevel).toBe("aal2");

    const providerReadsBeforeRawProof = getUser.mock.calls.length;
    await expect(service.requireRecentAuthentication(
      account,
      `Bearer ${login.token}`,
      { accessToken: aal1Token, password: undefined },
      "account_export",
    )).rejects.toMatchObject({
      statusCode: 403,
      details: expect.objectContaining({ reauthPurpose: "account_export" }),
    });
    await expect(service.requireRecentAuthentication(
      account,
      `Bearer ${login.token}`,
      { accessToken: aal2Token, password: undefined },
      "account_export",
    )).rejects.toMatchObject({
      statusCode: 403,
      details: expect.objectContaining({ reauthPurpose: "account_export" }),
    });
    expect(getUser).toHaveBeenCalledTimes(providerReadsBeforeRawProof);

    providerUser.factors = [];
    login = await service.loginWithSupabaseAccessToken({
      accessToken: token({ sessionId: "mfa-last-factor-removed", aal: "aal2", method: "totp" }),
    }, undefined, `Bearer ${login.token}`);
    account = repository.getAccountBySupabaseUserId(providerUser.id)!;
    expect(account.mfaLevel).toBe("aal1");
    expect(account.mfaVerifiedAt).toBeNull();

    providerUser.factors = [
      { id: "verified-phone-factor", factor_type: "phone", status: "verified" },
    ];
    await expect(service.loginWithSupabaseAccessToken({
      accessToken: token({ sessionId: "mfa-phone-aal1", aal: "aal1", method: "password" }),
    }, undefined, `Bearer ${login.token}`)).rejects.toMatchObject({
      statusCode: 403,
      details: expect.objectContaining({ publicCode: "MFA_STEP_UP_REQUIRED" }),
    });

    providerUser.id = "different-provider-user";
    providerUser.email = "different-provider-user@example.com";
    providerUser.factors = [];
    await expect(service.loginWithSupabaseAccessToken({
      accessToken: token({ sessionId: "different-provider-reauth", aal: "aal2", method: "totp" }),
      credentialCeremony: "browser_memory_v1",
      reauthPurpose: "account_export",
    }, undefined, `Bearer ${login.token}`)).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ reauthPurpose: "account_export" }),
    });
    expect(repository.getAccountBySupabaseUserId("different-provider-user")).toBeNull();
    providerUser.id = "mfa-gated-provider-user";
    providerUser.email = "mfa-gated-provider-user@example.com";
    providerUser.factors = [
      { id: "verified-phone-factor", factor_type: "phone", status: "verified" },
    ];

    database.prepare("UPDATE accounts SET status = 'suspended', updated_at = ? WHERE id = ?")
      .run(NOW, account.id);
    database.prepare("UPDATE profiles SET account_status = 'suspended', updated_at = ? WHERE id = ?")
      .run(NOW, account.id);
    account = repository.getAccountById(account.id)!;
    expect(account.status).toBe("suspended");
    await expect(service.createSuspendedAccountBillingPortal({ accessToken: aal1Token }))
      .rejects.toMatchObject({
        statusCode: 403,
        details: expect.objectContaining({ publicCode: "MFA_STEP_UP_REQUIRED" }),
      });
  });

  it.each(["returned error", "transport error"] as const)(
    "contains every app session and reports incomplete provider cleanup after a %s",
    async (failureMode) => {
      const { database, repository } = createRepository();
      const nowSeconds = Math.floor(Date.parse(NOW) / 1000);
      const providerUser = {
        id: `provider-signout-${failureMode.replaceAll(" ", "-")}`,
        email: `provider-signout-${failureMode.replaceAll(" ", "-")}@example.com`,
        email_confirmed_at: NOW,
        user_metadata: {},
      };
      const globalSignOut = vi.fn();
      if (failureMode === "returned error") {
        globalSignOut.mockResolvedValueOnce({ data: null, error: { code: "provider_unavailable" } });
      } else {
        globalSignOut.mockRejectedValueOnce(Object.assign(new Error("provider transport unavailable"), {
          code: "provider_transport_unavailable",
        }));
      }
      globalSignOut.mockResolvedValue({ data: null, error: null });
      const service = createBusinessService(repository, {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_ANON_KEY: "placeholder-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
      });
      (service as unknown as { supabase: unknown }).supabase = {
        auth: {
          admin: { signOut: globalSignOut },
          getUser: vi.fn(async () => ({ data: { user: providerUser }, error: null })),
        },
      };
      const providerToken = (sessionId: string, issuedAt: number) => testSupabaseAccessToken({
        sub: providerUser.id,
        iat: issuedAt,
        auth_time: issuedAt,
        session_id: sessionId,
        amr: [{ method: "password", timestamp: issuedAt }],
      }, `provider-signout-${sessionId}`);
      const firstProviderToken = providerToken("initial", nowSeconds - 60);
      const initial = await service.loginWithSupabaseAccessToken({
        accessToken: firstProviderToken,
        ageConfirmed: true,
        termsAccepted: true,
        privacyAccepted: true,
        termsVersion: CURRENT_LEGAL_POLICY_VERSION,
        privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
        consentSource: "web",
      });

      const linkedAccount = repository.getAccountBySupabaseUserId(providerUser.id)!;
      const partial = await service.logoutAll(linkedAccount, { accessToken: firstProviderToken });
      expect(partial).toEqual(expect.objectContaining({
        revokedCount: 1,
        providerSessionsRevoked: false,
      }));
      expect(database.prepare(
        "SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL",
      ).get(initial.account.id)).toEqual({ count: 0 });
      expect(repository.getAccountById(initial.account.id)).toMatchObject({
        providerTokensValidAfter: new Date(Date.parse(NOW) + 60_000).toISOString(),
      });
      expect(await listSecurityAuditLogs(repository, { action: "provider_global_signout_failed" }))
        .toEqual([
          expect.objectContaining({
            metadata: expect.objectContaining({
              operation: "logout_all",
              appSessionsContained: true,
            }),
          }),
        ]);
      await expect(service.loginWithSupabaseAccessToken({ accessToken: firstProviderToken }))
        .rejects.toThrow();

      const resumeProviderToken = providerToken("resume-cleanup", nowSeconds + 60);
      await expect(service.resumeProviderGlobalRevocation({ accessToken: resumeProviderToken }))
        .resolves.toEqual(expect.objectContaining({ providerSessionsRevoked: true }));
      await expect(service.loginWithSupabaseAccessToken({ accessToken: resumeProviderToken }))
        .rejects.toThrow("predates a security reset");

      const freshProviderToken = providerToken("fresh-retry", nowSeconds + 120);
      const fresh = await service.loginWithSupabaseAccessToken({ accessToken: freshProviderToken });
      await expect(service.logoutAll(
        repository.getAccountById(fresh.account.id)!,
        { accessToken: freshProviderToken },
      ))
        .resolves.toEqual(expect.objectContaining({ providerSessionsRevoked: true }));
      expect(database.prepare(
        "SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL",
      ).get(initial.account.id)).toEqual({ count: 0 });
    },
  );

  it("blocks app-session minting while provider-wide logout is in flight", async () => {
    const { database, repository } = createRepository();
    const nowSeconds = Math.floor(Date.parse(NOW) / 1000);
    const providerUser = {
      id: "logout-provider-race-user",
      email: "logout-provider-race-user@example.com",
      email_confirmed_at: NOW,
      user_metadata: {},
    };
    let releaseProviderSignout!: () => void;
    let markProviderSignoutStarted!: () => void;
    const providerSignoutStarted = new Promise<void>((resolve) => { markProviderSignoutStarted = resolve; });
    const providerSignoutRelease = new Promise<void>((resolve) => { releaseProviderSignout = resolve; });
    const globalSignOut = vi.fn(async () => {
      markProviderSignoutStarted();
      await providerSignoutRelease;
      return { data: null, error: null };
    });
    const service = createBusinessService(repository, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "placeholder-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
    });
    (service as unknown as { supabase: unknown }).supabase = {
      auth: {
        admin: { signOut: globalSignOut },
        getUser: vi.fn(async () => ({ data: { user: providerUser }, error: null })),
      },
    };
    const providerToken = (sessionId: string, issuedAt: number) => testSupabaseAccessToken({
      sub: providerUser.id,
      iat: issuedAt,
      auth_time: issuedAt,
      session_id: sessionId,
      amr: [{ method: "password", timestamp: issuedAt }],
    }, `logout-provider-race-${sessionId}`);
    const initialToken = providerToken("initial", nowSeconds - 60);
    const initial = await service.loginWithSupabaseAccessToken({
      accessToken: initialToken,
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: CURRENT_LEGAL_POLICY_VERSION,
      privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentSource: "web",
    });
    const logout = service.logoutAll(
      repository.getAccountBySupabaseUserId(providerUser.id)!,
      { accessToken: initialToken },
    );
    await providerSignoutStarted;

    vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
    const racingToken = providerToken("racing-refresh", nowSeconds + 60);
    await expect(service.loginWithSupabaseAccessToken({ accessToken: racingToken }))
      .rejects.toMatchObject({
        statusCode: 409,
        details: expect.objectContaining({ publicCode: "PROVIDER_GLOBAL_REVOCATION_PENDING" }),
      });
    expect(database.prepare(
      "SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL",
    ).get(initial.account.id)).toEqual({ count: 0 });

    releaseProviderSignout();
    await expect(logout).resolves.toEqual(expect.objectContaining({
      revokedCount: 1,
      providerSessionsRevoked: true,
    }));
    expect(database.prepare(
      "SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL",
    ).get(initial.account.id)).toEqual({ count: 0 });
    await expect(service.loginWithSupabaseAccessToken({ accessToken: racingToken }))
      .rejects.toThrow("predates a security reset");
  });

  it("blocks app-session minting while password-reset provider signout is in flight", async () => {
    const { database, repository } = createRepository();
    const nowSeconds = Math.floor(Date.parse(NOW) / 1000);
    const providerUser = {
      id: "password-reset-provider-race-user",
      email: "password-reset-provider-race-user@example.com",
      email_confirmed_at: NOW,
      user_metadata: {},
    };
    let releaseProviderSignout!: () => void;
    let markProviderSignoutStarted!: () => void;
    const providerSignoutStarted = new Promise<void>((resolve) => { markProviderSignoutStarted = resolve; });
    const providerSignoutRelease = new Promise<void>((resolve) => { releaseProviderSignout = resolve; });
    const globalSignOut = vi.fn(async () => {
      markProviderSignoutStarted();
      await providerSignoutRelease;
      return { data: null, error: null };
    });
    const service = createBusinessService(repository, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "placeholder-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
    });
    (service as unknown as { supabase: unknown }).supabase = {
      auth: {
        admin: { signOut: globalSignOut },
        getUser: vi.fn(async () => ({ data: { user: providerUser }, error: null })),
      },
    };
    const providerToken = (sessionId: string, method: string, issuedAt: number) => testSupabaseAccessToken({
      sub: providerUser.id,
      iat: issuedAt,
      auth_time: issuedAt,
      session_id: sessionId,
      amr: [{ method, timestamp: issuedAt }],
    }, `password-reset-provider-race-${sessionId}`);
    const initialToken = providerToken("initial", "password", nowSeconds - 60);
    const initial = await service.loginWithSupabaseAccessToken({
      accessToken: initialToken,
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: CURRENT_LEGAL_POLICY_VERSION,
      privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentSource: "web",
    });
    const recoveryToken = providerToken("recovery", "recovery", nowSeconds - 30);
    const reset = service.completePasswordReset({ accessToken: recoveryToken });
    await providerSignoutStarted;

    vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
    const racingToken = providerToken("racing-refresh", "password", nowSeconds + 60);
    await expect(service.loginWithSupabaseAccessToken({ accessToken: racingToken }))
      .rejects.toMatchObject({
        statusCode: 409,
        details: expect.objectContaining({ publicCode: "PROVIDER_GLOBAL_REVOCATION_PENDING" }),
      });
    expect(database.prepare(
      "SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL",
    ).get(initial.account.id)).toEqual({ count: 0 });

    releaseProviderSignout();
    await expect(reset).resolves.toEqual(expect.objectContaining({
      revokedSessions: 1,
      providerSessionsRevoked: true,
    }));
    expect(database.prepare(
      "SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL",
    ).get(initial.account.id)).toEqual({ count: 0 });
    await expect(service.loginWithSupabaseAccessToken({ accessToken: racingToken }))
      .rejects.toThrow("predates a security reset");
  });

  it.each(["logout_all", "password_reset"] as const)(
    "keeps the provider revocation fence after %s final-containment failure and resumes without minting",
    async (operation) => {
      const { database, repository } = createRepository();
      const nowSeconds = Math.floor(Date.parse(NOW) / 1000);
      const providerUser = {
        id: `provider-final-containment-${operation}`,
        email: `provider-final-containment-${operation}@example.com`,
        email_confirmed_at: NOW,
        user_metadata: {},
      };
      const globalSignOut = vi.fn(async () => ({ data: null, error: null }));
      const service = createBusinessService(repository, {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_ANON_KEY: "placeholder-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
      });
      (service as unknown as { supabase: unknown }).supabase = {
        auth: {
          admin: { signOut: globalSignOut },
          getUser: vi.fn(async () => ({ data: { user: providerUser }, error: null })),
        },
      };
      const providerToken = (sessionId: string, issuedAt: number, method = "password") =>
        testSupabaseAccessToken({
          sub: providerUser.id,
          iat: issuedAt,
          auth_time: issuedAt,
          session_id: sessionId,
          amr: [{ method, timestamp: issuedAt }],
        }, `provider-final-containment-${operation}-${sessionId}`);
      const initialToken = providerToken("initial", nowSeconds - 60);
      const initial = await service.loginWithSupabaseAccessToken({
        accessToken: initialToken,
        ageConfirmed: true,
        termsAccepted: true,
        privacyAccepted: true,
        termsVersion: CURRENT_LEGAL_POLICY_VERSION,
        privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
        consentSource: "web",
      });
      const accountSessionRepository = (service as unknown as {
        accountSessionRepository: AccountSessionRepository;
      }).accountSessionRepository;
      const finalFailure = new Error(`simulated ${operation} final containment failure`);
      let containmentSpy;
      let operationPromise: Promise<unknown>;
      if (operation === "logout_all") {
        const original = accountSessionRepository.revokeUserSessionsWithSummary
          .bind(accountSessionRepository);
        containmentSpy = vi.spyOn(accountSessionRepository, "revokeUserSessionsWithSummary")
          .mockImplementationOnce(original)
          .mockRejectedValueOnce(finalFailure);
        operationPromise = service.logoutAll(
          repository.getAccountBySupabaseUserId(providerUser.id)!,
          { accessToken: initialToken },
        );
      } else {
        const original = accountSessionRepository.completePasswordResetContainment
          .bind(accountSessionRepository);
        containmentSpy = vi.spyOn(accountSessionRepository, "completePasswordResetContainment")
          .mockImplementationOnce(original)
          .mockRejectedValueOnce(finalFailure);
        operationPromise = service.completePasswordReset({
          accessToken: providerToken("recovery", nowSeconds - 30, "recovery"),
        });
      }

      await expect(operationPromise).rejects.toThrow(finalFailure.message);
      containmentSpy.mockRestore();
      expect(globalSignOut).toHaveBeenCalledTimes(1);
      expect(await accountSessionRepository.hasProviderGlobalRevocationPending(initial.account.id)).toBe(true);
      expect(database.prepare(
        "SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL",
      ).get(initial.account.id)).toEqual({ count: 0 });
      const tokenDuringFence = providerToken("during-fence", nowSeconds + 120);
      await expect(service.loginWithSupabaseAccessToken({ accessToken: tokenDuringFence }))
        .rejects.toMatchObject({
          statusCode: 409,
          details: expect.objectContaining({ publicCode: "PROVIDER_GLOBAL_REVOCATION_PENDING" }),
        });

      vi.setSystemTime(new Date(Date.parse(NOW) + 6 * 60_000));
      const resumeToken = providerToken("resume", nowSeconds + 6 * 60);
      await expect(service.resumeProviderGlobalRevocation({ accessToken: resumeToken }))
        .resolves.toEqual(expect.objectContaining({
          completed: true,
          providerSessionsRevoked: true,
          revokedCount: 0,
        }));
      expect(await accountSessionRepository.hasProviderGlobalRevocationPending(initial.account.id)).toBe(false);
      await expect(service.loginWithSupabaseAccessToken({ accessToken: resumeToken }))
        .rejects.toThrow("predates a security reset");
      await expect(service.loginWithSupabaseAccessToken({
        accessToken: providerToken("fresh-after-resume", nowSeconds + 8 * 60),
      })).resolves.toEqual(expect.objectContaining({ token: expect.any(String) }));
      expect(await listSecurityAuditLogs(repository, { action: "provider_global_signout_resumed" }))
        .toEqual([
          expect.objectContaining({
            metadata: expect.objectContaining({ operation }),
          }),
        ]);
    },
  );

  it("mints fresh purpose-bound browser sessions without reusing or changing the provider-session family", async () => {
    const { database, repository } = createRepository();
    const nowSeconds = Math.floor(Date.parse(NOW) / 1000);
    const providerSessionId = "browser-memory-provider-session";
    const providerUser = {
      id: "browser-memory-user",
      email: "browser-memory-user@example.com",
      email_confirmed_at: NOW,
      user_metadata: {},
    };
    const service = createBusinessService(repository, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "placeholder-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
    });
    (service as unknown as { supabase: unknown }).supabase = {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: providerUser }, error: null })),
      },
    };
    const freshAccessToken = testSupabaseAccessToken({
      iat: nowSeconds - 60,
      auth_time: nowSeconds - 60,
      session_id: providerSessionId,
      amr: [{ method: "password", timestamp: nowSeconds - 60 }],
    });
    const initial = await service.loginWithSupabaseAccessToken({
      accessToken: freshAccessToken,
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: CURRENT_LEGAL_POLICY_VERSION,
      privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentSource: "web",
    });

    await expect(service.loginWithSupabaseAccessToken({
      accessToken: freshAccessToken,
      credentialCeremony: "browser_memory_v1",
      reauthPurpose: "account_export",
    })).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ reauthPurpose: "account_export" }),
    });

    const sessionCount = () => database.prepare(
      "SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL",
    ).get(providerUser.id) as { count: number };
    const malformedRefreshOnly = testSupabaseAccessToken({
      iat: nowSeconds,
      session_id: "refresh-only-session",
      amr: [{ method: "token_refresh", timestamp: nowSeconds }],
    }, "refresh-only-signature");
    const staleCredential = testSupabaseAccessToken({
      iat: nowSeconds - 16 * 60,
      auth_time: nowSeconds - 16 * 60,
      session_id: "stale-credential-session",
      amr: [{ method: "password", timestamp: nowSeconds - 16 * 60 }],
    }, "stale-signature");
    const futureCredential = testSupabaseAccessToken({
      iat: nowSeconds,
      auth_time: nowSeconds + 61,
      session_id: "future-credential-session",
      amr: [{ method: "password", timestamp: nowSeconds + 61 }],
    }, "future-signature");
    const nonAuthenticationEventCredential = testSupabaseAccessToken({
      iat: nowSeconds,
      auth_time: nowSeconds,
      session_id: "non-authentication-event-session",
      amr: [
        { method: "password", timestamp: nowSeconds - 16 * 60 },
        { method: "email_change", timestamp: nowSeconds },
      ],
    }, "non-authentication-event-signature");

    for (const accessToken of [
      malformedRefreshOnly,
      staleCredential,
      futureCredential,
      nonAuthenticationEventCredential,
    ]) {
      await expect(service.loginWithSupabaseAccessToken({
        accessToken,
        credentialCeremony: "browser_memory_v1",
        reauthPurpose: "account_export",
      }, undefined, `Bearer ${initial.token}`)).rejects.toMatchObject({
        statusCode: 403,
        details: expect.objectContaining({ reauthenticationRequired: true }),
      });
    }
    expect(sessionCount()).toEqual({ count: 1 });

    const credentialSession = await service.loginWithSupabaseAccessToken({
      accessToken: freshAccessToken,
      credentialCeremony: "browser_memory_v1",
      reauthPurpose: "account_export",
    }, undefined, `Bearer ${initial.token}`);
    expect(credentialSession).toEqual(expect.objectContaining({
      token: expect.stringMatching(new RegExp(`^credential-v1\\.account_export\\.${nowSeconds - 60}\\.[A-Za-z0-9_-]{43}$`)),
    }));
    expect(credentialSession).not.toHaveProperty("reused");
    expect(credentialSession.token).not.toBe(initial.token);
    expect(sessionCount()).toEqual({ count: 1 });

    const rotatedAgain = await service.loginWithSupabaseAccessToken({
      accessToken: freshAccessToken,
      credentialCeremony: "browser_memory_v1",
      reauthPurpose: "account_export",
    }, undefined, `Bearer ${credentialSession.token}`);
    expect(rotatedAgain.token).toMatch(new RegExp(`^credential-v1\\.account_export\\.${nowSeconds - 60}\\.[A-Za-z0-9_-]{43}$`));
    expect(rotatedAgain.token).not.toBe(credentialSession.token);
    expect(rotatedAgain).not.toHaveProperty("reused");
    expect(sessionCount()).toEqual({ count: 1 });

    const expectedProviderHash = crypto
      .createHash("sha256")
      .update(`supabase-session:${providerSessionId}`)
      .digest("hex");
    const credentialTokenHash = crypto.createHash("sha256").update(rotatedAgain.token).digest("hex");
    expect(database.prepare(
      `SELECT provider_session_id_hash AS "providerSessionIdHash"
       FROM auth_sessions WHERE token_hash = ?`,
    ).get(credentialTokenHash)).toEqual({ providerSessionIdHash: expectedProviderHash });
    expect(database.prepare(
      `SELECT count(*) AS count, max(revoked_at) AS "revokedAt"
       FROM auth_sessions WHERE token_hash = ?`,
    ).get(crypto.createHash("sha256").update(credentialSession.token).digest("hex"))).toEqual({
      count: 1,
      revokedAt: NOW,
    });

    const account = repository.getAccountBySupabaseUserId(providerUser.id)!;
    await expect(service.requireRecentAuthentication(
      account,
      `Bearer ${rotatedAgain.token}`,
      undefined,
      "account_export",
    )).resolves.toBeUndefined();
    await expect(service.requireRecentAuthentication(
      account,
      `Bearer ${rotatedAgain.token}`,
      undefined,
      "session_management",
    )).rejects.toMatchObject({
      statusCode: 403,
      details: expect.objectContaining({ reauthPurpose: "session_management" }),
    });

    const forgedToken = `credential-v1.account_export.${nowSeconds - 60}.${Buffer.alloc(32, 9).toString("base64url")}`;
    await expect(service.requireRecentAuthentication(
      account,
      `Bearer ${forgedToken}`,
      undefined,
      "account_export",
    )).rejects.toMatchObject({ statusCode: 401 });

    vi.setSystemTime(new Date(Date.parse(NOW) + 14 * 60_000 + 1));
    await expect(service.requireRecentAuthentication(
      account,
      `Bearer ${rotatedAgain.token}`,
      undefined,
      "account_export",
    )).rejects.toMatchObject({
      statusCode: 403,
      details: expect.objectContaining({ reauthPurpose: "account_export" }),
    });

    vi.setSystemTime(new Date(NOW));
    const concurrentCeremonies = await Promise.allSettled([
      service.loginWithSupabaseAccessToken({
        accessToken: freshAccessToken,
        credentialCeremony: "browser_memory_v1",
        reauthPurpose: "account_export",
      }, undefined, `Bearer ${rotatedAgain.token}`),
      service.loginWithSupabaseAccessToken({
        accessToken: freshAccessToken,
        credentialCeremony: "browser_memory_v1",
        reauthPurpose: "account_export",
      }, undefined, `Bearer ${rotatedAgain.token}`),
    ]);
    expect(concurrentCeremonies.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejectedCeremony = concurrentCeremonies.find((result) => result.status === "rejected");
    expect(rejectedCeremony).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        statusCode: 409,
        details: expect.objectContaining({ reauthenticationRequired: true }),
      }),
    });
    expect(sessionCount()).toEqual({ count: 1 });
  });

  it("sets a purpose-bound HttpOnly cookie, omits its token from JSON, and enforces route purposes", async () => {
    const { repository } = createRepository();
    const nowSeconds = Math.floor(Date.parse(NOW) / 1000);
    const providerUser = {
      id: "browser-cookie-user",
      email: "browser-cookie-user@example.com",
      email_confirmed_at: NOW,
      user_metadata: {},
    };
    const service = createBusinessService(repository, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "placeholder-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
    });
    (service as unknown as { supabase: unknown }).supabase = {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: providerUser }, error: null })),
      },
    };
    const accessToken = testSupabaseAccessToken({
      iat: nowSeconds - 30,
      auth_time: nowSeconds - 30,
      session_id: "browser-cookie-provider-session",
      amr: [{ method: "password", timestamp: nowSeconds - 30 }],
    }, "browser-cookie-signature");
    const initial = await service.loginWithSupabaseAccessToken({
      accessToken,
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: CURRENT_LEGAL_POLICY_VERSION,
      privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentSource: "web",
    });
    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);
    const createBarBillingPortal = vi.spyOn(service, "createBarBillingPortal")
      .mockResolvedValue({ url: "https://billing.stripe.test/venue" });

    await withHttpServer(app, async (baseUrl) => {
      const downgradeResponse = await fetch(`${baseUrl}/api/business/auth/supabase-session`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${initial.token}`,
          "content-type": "application/json",
          origin: "https://pintpath.au",
        },
        body: JSON.stringify({ accessToken }),
      });
      const downgradePayload = await downgradeResponse.json() as {
        ok: boolean;
        data: Record<string, unknown>;
      };
      const upgradedCookie = responseCookie(downgradeResponse.headers, "pint_path_session");
      expect(downgradeResponse.status).toBe(200);
      expect(downgradePayload.ok).toBe(true);
      expect(downgradePayload.data).not.toHaveProperty("token");
      expect(upgradedCookie).toMatch(/^pint_path_session=[A-Za-z0-9_-]{43}$/);

      const replayWithoutCookie = await fetch(`${baseUrl}/api/business/auth/supabase-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken }),
      });
      expect(replayWithoutCookie.status).toBe(409);
      expect(replayWithoutCookie.headers.get("set-cookie")).toBeNull();
      await expect(replayWithoutCookie.json()).resolves.toEqual(expect.objectContaining({
        error: expect.objectContaining({
          message: "The cookie session changed while authentication was completing. Sign in again and retry.",
        }),
      }));

      const purposeWithoutCookie = await fetch(`${baseUrl}/api/business/auth/supabase-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessToken,
          credentialCeremony: "browser_memory_v1",
          reauthPurpose: "account_export",
        }),
      });
      expect(purposeWithoutCookie.status).toBe(409);
      expect(purposeWithoutCookie.headers.get("set-cookie")).toBeNull();
      await expect(purposeWithoutCookie.json()).resolves.toEqual(expect.objectContaining({
        error: expect.objectContaining({
          message: "Your Pint Path session expired before reauthentication completed. Sign in again, then retry the sensitive action.",
        }),
      }));

      const ceremonyResponse = await fetch(`${baseUrl}/api/business/auth/supabase-session`, {
        method: "POST",
        headers: {
          cookie: upgradedCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accessToken,
          credentialCeremony: "browser_memory_v1",
          reauthPurpose: "account_export",
        }),
      });
      const payload = await ceremonyResponse.json() as {
        ok: boolean;
        data: Record<string, unknown>;
      };
      const setCookie = ceremonyResponse.headers.get("set-cookie") ?? "";
      const cookie = responseCookie(ceremonyResponse.headers, "pint_path_session");
      expect(ceremonyResponse.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.data).not.toHaveProperty("token");
      expect(setCookie).toMatch(new RegExp(`pint_path_session=credential-v1\\.account_export\\.${nowSeconds - 30}\\.[A-Za-z0-9_-]{43}`));
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/");

      const exportResponse = await fetch(`${baseUrl}/api/business/account/export`, {
        headers: { cookie },
      });
      expect(exportResponse.status).toBe(200);

      const wrongPurposeResponse = await fetch(`${baseUrl}/api/business/account/sessions`, {
        headers: { cookie },
      });
      expect(wrongPurposeResponse.status).toBe(403);
      await expect(wrongPurposeResponse.json()).resolves.toEqual(expect.objectContaining({
        error: expect.objectContaining({
          message: "Purpose-bound reauthentication is required for this sensitive action.",
        }),
      }));

      const wrongVenuePurposeResponse = await fetch(`${baseUrl}/api/business/venue-portal/venue-1/billing/portal`, {
        method: "POST",
        headers: { cookie },
      });
      expect(wrongVenuePurposeResponse.status).toBe(403);
      expect(createBarBillingPortal).not.toHaveBeenCalled();

      vi.setSystemTime(new Date(Date.parse(NOW) + 14 * 60_000 + 30_001));
      const staleResponse = await fetch(`${baseUrl}/api/business/account/export`, {
        headers: { cookie },
      });
      expect(staleResponse.status).toBe(403);

      vi.setSystemTime(new Date(NOW));
      const venueCeremonyResponse = await fetch(`${baseUrl}/api/business/auth/supabase-session`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accessToken,
          credentialCeremony: "browser_memory_v1",
          reauthPurpose: "venue_billing_portal",
        }),
      });
      const venueCookie = responseCookie(venueCeremonyResponse.headers, "pint_path_session");
      expect(venueCeremonyResponse.status).toBe(200);
      expect(venueCookie).toMatch(new RegExp(`pint_path_session=credential-v1\\.venue_billing_portal\\.${nowSeconds - 30}\\.[A-Za-z0-9_-]{43}`));
      const venuePortalResponse = await fetch(`${baseUrl}/api/business/venue-portal/venue-1/billing/portal`, {
        method: "POST",
        headers: { cookie: venueCookie },
      });
      expect(venuePortalResponse.status).toBe(201);
      expect(createBarBillingPortal).toHaveBeenCalledWith(expect.objectContaining({ id: providerUser.id }), "venue-1");
    });
  });

  it("binds browser email reauthentication to the active cookie, purpose, fresh OTP, and MFA-upgraded session", async () => {
    vi.stubEnv("RAILWAY_REPLICA_ID", "browser-email-reauth-test-replica");
    const { repository } = createRepository();
    const nowSeconds = Math.floor(Date.parse(NOW) / 1000);
    const providerUser = {
      id: "browser-email-reauth-user",
      email: "browser-email-reauth-user@example.com",
      email_confirmed_at: NOW,
      factors: [{ id: "browser-email-totp", factor_type: "totp", status: "verified" }],
      user_metadata: {},
    };
    const service = createBusinessService(repository, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "placeholder-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
    });
    (service as unknown as { supabase: unknown }).supabase = {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: providerUser }, error: null })),
      },
    };
    const initialProviderToken = testSupabaseAccessToken({
      sub: providerUser.id,
      iat: nowSeconds - 30,
      auth_time: nowSeconds - 30,
      session_id: "browser-email-initial-session",
      aal: "aal2",
      amr: [
        { method: "oauth", timestamp: nowSeconds - 60 },
        { method: "totp", timestamp: nowSeconds - 30 },
      ],
    }, "browser-email-initial-signature");
    const initial = await service.loginWithSupabaseAccessToken({
      accessToken: initialProviderToken,
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: CURRENT_LEGAL_POLICY_VERSION,
      privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentSource: "web",
    });
    const appCookie = `pint_path_session=${initial.token}`;
    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      providerUser.factors = [];
      const oauthAal1Token = testSupabaseAccessToken({
        sub: providerUser.id,
        iat: nowSeconds,
        auth_time: nowSeconds,
        session_id: "browser-email-oauth-aal1-session",
        aal: "aal1",
        amr: [{ method: "oauth", timestamp: nowSeconds }],
      }, "browser-email-oauth-aal1-signature");
      const oauthPurpose = await fetch(`${baseUrl}/api/business/auth/supabase-session`, {
        method: "POST",
        headers: {
          cookie: appCookie,
          "content-type": "application/json",
          origin: "https://pintpath.au",
          "x-real-ip": "203.0.113.44",
        },
        body: JSON.stringify({
          accessToken: oauthAal1Token,
          credentialCeremony: "browser_memory_v1",
          reauthPurpose: "account_export",
        }),
      });
      expect(oauthPurpose.status).toBe(403);
      await expect(oauthPurpose.json()).resolves.toEqual(expect.objectContaining({
        error: expect.objectContaining({ code: "EMAIL_REAUTHENTICATION_REQUIRED" }),
      }));
      providerUser.factors = [{ id: "browser-email-totp", factor_type: "totp", status: "verified" }];
      const oauthAal2Purpose = await fetch(`${baseUrl}/api/business/auth/supabase-session`, {
        method: "POST",
        headers: {
          cookie: appCookie,
          "content-type": "application/json",
          origin: "https://pintpath.au",
          "x-real-ip": "203.0.113.44",
        },
        body: JSON.stringify({
          accessToken: initialProviderToken,
          credentialCeremony: "browser_memory_v1",
          reauthPurpose: "account_export",
        }),
      });
      expect(oauthAal2Purpose.status).toBe(403);
      await expect(oauthAal2Purpose.json()).resolves.toEqual(expect.objectContaining({
        error: expect.objectContaining({ code: "EMAIL_REAUTHENTICATION_REQUIRED" }),
      }));

      const start = await fetch(`${baseUrl}/api/business/auth/browser-email-reauthentication`, {
        method: "POST",
        headers: {
          cookie: appCookie,
          "content-type": "application/json",
          origin: "https://pintpath.au",
          "x-real-ip": "203.0.113.44",
        },
        body: JSON.stringify({ purpose: "account_export" }),
      });
      const startPayload = await start.json() as {
        ok: boolean;
        data: { email: string; expiresAt: string; challengeToken?: string };
      };
      const challengeCookie = responseCookie(start.headers, "pint_path_email_reauth");
      const startSetCookie = start.headers.get("set-cookie") ?? "";
      expect(start.status).toBe(200);
      expect(startPayload).toEqual(expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          email: providerUser.email,
          expiresAt: new Date((nowSeconds + 10 * 60) * 1000).toISOString(),
        }),
      }));
      expect(startPayload.data).not.toHaveProperty("challengeToken");
      expect(challengeCookie).toMatch(/^pint_path_email_reauth=v1\./);
      expect(startSetCookie).toContain("HttpOnly");
      expect(startSetCookie).toContain("SameSite=Lax");
      expect(startSetCookie).toContain("Path=/api/business/auth/supabase-session");
      expect(startSetCookie).not.toContain("Domain=");

      const token = (input: {
        timestamp: number;
        aal: "aal1" | "aal2";
        otpTimestamp?: number;
      }) => testSupabaseAccessToken({
        sub: providerUser.id,
        iat: input.timestamp,
        auth_time: input.timestamp,
        session_id: "browser-email-otp-session",
        aal: input.aal,
        amr: input.aal === "aal2"
          ? [
              { method: "otp", timestamp: input.otpTimestamp ?? input.timestamp },
              { method: "totp", timestamp: input.timestamp },
            ]
          : [{ method: "otp", timestamp: input.timestamp }],
      }, `browser-email-${input.aal}-${input.timestamp}`);
      const exchange = (accessToken: string, cookie = `${appCookie}; ${challengeCookie}`) =>
        fetch(`${baseUrl}/api/business/auth/supabase-session`, {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            origin: "https://pintpath.au",
            "x-real-ip": "203.0.113.44",
          },
          body: JSON.stringify({
            accessToken,
            credentialCeremony: "browser_email_otp_v1",
            reauthPurpose: "account_export",
          }),
        });

      const duplicateChallenge = await exchange(
        token({ timestamp: nowSeconds, aal: "aal2" }),
        `${appCookie}; ${challengeCookie}; ${challengeCookie}`,
      );
      expect(duplicateChallenge.status).toBe(409);
      expect(responseCookie(duplicateChallenge.headers, "pint_path_session")).toBe("");

      const preChallengeCredential = await exchange(token({
        timestamp: nowSeconds,
        otpTimestamp: nowSeconds - 1,
        aal: "aal2",
      }));
      expect(preChallengeCredential.status).toBe(403);
      expect(responseCookie(preChallengeCredential.headers, "pint_path_session")).toBe("");

      const mfaRequired = await exchange(token({ timestamp: nowSeconds, aal: "aal1" }));
      expect(mfaRequired.status).toBe(403);
      expect(responseCookie(mfaRequired.headers, "pint_path_email_reauth")).toBe("");
      await expect(mfaRequired.json()).resolves.toEqual(expect.objectContaining({
        error: expect.objectContaining({ code: "MFA_STEP_UP_REQUIRED" }),
      }));

      const completed = await exchange(token({ timestamp: nowSeconds, aal: "aal2" }));
      const completedPayload = await completed.json() as { ok: boolean; data: Record<string, unknown> };
      const purposeCookie = responseCookie(completed.headers, "pint_path_session");
      expect(completed.status).toBe(200);
      expect(completedPayload.ok).toBe(true);
      expect(completedPayload.data).not.toHaveProperty("token");
      expect(purposeCookie).toMatch(new RegExp(
        `^pint_path_session=credential-v1\\.account_export\\.${nowSeconds}\\.[A-Za-z0-9_-]{43}$`,
      ));
      expect(completed.headers.getSetCookie()).toEqual(expect.arrayContaining([
        expect.stringMatching(/^pint_path_email_reauth=;/),
      ]));

      const replay = await exchange(token({ timestamp: nowSeconds, aal: "aal2" }));
      expect(replay.status).toBe(409);
      expect(responseCookie(replay.headers, "pint_path_session")).toBe("");
    });
  });

  it("accepts a native purpose ceremony only on the exact forbidden-browser-header channel", async () => {
    vi.stubEnv("RAILWAY_REPLICA_ID", "native-purpose-channel-test-replica");
    const { repository } = createRepository();
    const nowSeconds = Math.floor(Date.parse(NOW) / 1000);
    const providerUser = {
      id: "native-purpose-channel-user",
      email: "native-purpose-channel-user@example.com",
      email_confirmed_at: NOW,
      user_metadata: {},
    };
    const service = createBusinessService(repository, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "placeholder-anon-key",
    });
    (service as unknown as { supabase: unknown }).supabase = {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: providerUser }, error: null })),
      },
    };
    const accessToken = testSupabaseAccessToken({
      sub: providerUser.id,
      iat: nowSeconds,
      auth_time: nowSeconds,
      session_id: "native-purpose-provider-session",
      aal: "aal1",
      amr: [{ method: "password", timestamp: nowSeconds }],
    }, "native-purpose-provider-signature");
    const initial = await service.loginWithSupabaseAccessToken({
      accessToken,
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: CURRENT_LEGAL_POLICY_VERSION,
      privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentSource: "ios",
    });
    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);
    const body = JSON.stringify({
      accessToken,
      credentialCeremony: "native_memory_v1",
      reauthPurpose: "account_export",
    });

    await withHttpServer(app, async (baseUrl) => {
      const endpoint = `${baseUrl}/api/business/auth/supabase-session`;
      const headers = {
        cookie: `pint_path_session=${initial.token}`,
        "content-type": "application/json",
        "x-real-ip": "203.0.113.45",
      };
      const post = (extra: Record<string, string> = {}) => fetch(endpoint, {
        method: "POST",
        headers: { ...headers, ...extra },
        body,
      });

      const missingMarker = await post();
      expect(missingMarker.status).toBe(403);
      expect(responseCookie(missingMarker.headers, "pint_path_session")).toBe("");

      const browserSpoof = await post({
        origin: "null",
        "sec-pint-path-client": "ios-native-v1",
      });
      expect(browserSpoof.status).toBe(403);
      expect(responseCookie(browserSpoof.headers, "pint_path_session")).toBe("");

      const fetchMetadataSpoof = await post({
        "sec-fetch-site": "same-origin",
        "sec-pint-path-client": "ios-native-v1",
      });
      expect(fetchMetadataSpoof.status).toBe(403);
      expect(responseCookie(fetchMetadataSpoof.headers, "pint_path_session")).toBe("");

      const completed = await new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
        payload: { ok: boolean; data: Record<string, unknown> };
      }>((resolve, reject) => {
        const target = new URL(endpoint);
        const request = http.request({
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: "POST",
          headers: {
            ...headers,
            "content-length": Buffer.byteLength(body),
            "sec-pint-path-client": "ios-native-v1",
          },
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              ok: boolean;
              data: Record<string, unknown>;
            },
          }));
        });
        request.on("error", reject);
        request.end(body);
      });
      const setCookie = completed.headers["set-cookie"] ?? [];
      expect(setCookie).toHaveLength(1);
      const nativeSessionCookie = setCookie
        .map((value) => value.split(";", 1)[0] ?? "")
        .find((value) => value.startsWith("pint_path_session=")) ?? "";
      expect(completed.status).toBe(200);
      const payload = completed.payload;
      expect(payload.ok).toBe(true);
      expect(payload.data).not.toHaveProperty("token");
      expect(nativeSessionCookie).toMatch(new RegExp(
        `^pint_path_session=credential-v1\\.account_export\\.${nowSeconds}\\.[A-Za-z0-9_-]{43}$`,
      ));
    });
  });

  it("rejects raw hosted-provider reauthentication proof while enforcing suspended-billing revocation", async () => {
    const { database, repository } = createRepository();
    const initialSeconds = Math.floor(Date.parse(NOW) / 1000);
    const providerUser = {
      id: "legacy-native-proof-user",
      email: "legacy-native-proof-user@example.com",
      email_confirmed_at: NOW,
      user_metadata: {},
    };
    const getUser = vi.fn(async () => ({ data: { user: providerUser }, error: null }));
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "placeholder-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
    });
    (service as unknown as { supabase: unknown }).supabase = { auth: { getUser } };
    const initialProviderToken = testSupabaseAccessToken({
      iat: initialSeconds - 30,
      auth_time: initialSeconds - 30,
      session_id: "legacy-native-initial-session",
      amr: [{ method: "password", timestamp: initialSeconds - 30 }],
    }, "legacy-native-initial-signature");
    const initial = await service.loginWithSupabaseAccessToken({
      accessToken: initialProviderToken,
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: CURRENT_LEGAL_POLICY_VERSION,
      privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentSource: "ios",
    });

    const laterMs = Date.parse(NOW) + 31 * 60_000;
    const laterSeconds = Math.floor(laterMs / 1000);
    vi.setSystemTime(new Date(laterMs));
    const freshNativeProof = testSupabaseAccessToken({
      iat: laterSeconds - 10,
      auth_time: laterSeconds - 10,
      session_id: "legacy-native-fresh-session",
      amr: [{ method: "totp", timestamp: laterSeconds - 10 }],
    }, "legacy-native-fresh-signature");
    let account = repository.getAccountBySupabaseUserId(providerUser.id)!;
    await expect(service.requireRecentAuthentication(
      account,
      `Bearer ${initial.token}`,
      { accessToken: freshNativeProof, password: undefined },
      "account_export",
    )).rejects.toMatchObject({
      statusCode: 403,
      details: expect.objectContaining({ reauthPurpose: "account_export" }),
    });
    expect(getUser).toHaveBeenCalledTimes(1);

    const validAfter = new Date(laterMs - 60_000).toISOString();
    database.prepare("UPDATE accounts SET provider_tokens_valid_after = ?, updated_at = ? WHERE id = ?")
      .run(validAfter, validAfter, account.id);
    account = repository.getAccountById(account.id)!;

    const revokedProviderSessionId = "legacy-native-revoked-session";
    const revokedProof = testSupabaseAccessToken({
      iat: laterSeconds,
      auth_time: laterSeconds,
      session_id: revokedProviderSessionId,
      amr: [{ method: "password", timestamp: laterSeconds }],
    }, "legacy-native-revoked-signature");
    const revokedProviderHash = crypto
      .createHash("sha256")
      .update(`supabase-session:${revokedProviderSessionId}`)
      .digest("hex");
    database.prepare(
      `INSERT INTO revoked_provider_sessions (
         user_id, provider_session_id_hash, revoked_at, reason
       ) VALUES (?, ?, ?, ?)`,
    ).run(account.id, revokedProviderHash, new Date(laterMs).toISOString(), "test_revocation");
    database.prepare("UPDATE accounts SET status = 'suspended', updated_at = ? WHERE id = ?")
      .run(new Date(laterMs).toISOString(), account.id);
    database.prepare("UPDATE profiles SET account_status = 'suspended', updated_at = ? WHERE id = ?")
      .run(new Date(laterMs).toISOString(), account.id);
    await expect(service.createSuspendedAccountBillingPortal({
      accessToken: revokedProof,
    })).rejects.toMatchObject({ statusCode: 401 });
  });

  it("contains password resets by revoking every app session and invalidating older provider tokens", async () => {
    const { repository } = createRepository();
    const issuedAt = Math.floor(new Date(NOW).getTime() / 1000) - 300;
    const providerUser = {
      id: "password-reset-user",
      email: "password-reset-user@example.com",
      email_confirmed_at: NOW,
      user_metadata: {},
    };
    let providerRefreshTokensRevoked = false;
    const globalSignOut = vi.fn(async () => {
      providerRefreshTokensRevoked = true;
      return { data: null, error: null };
    });
    const service = createBusinessService(repository, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "placeholder-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
    });
    (service as unknown as { supabase: unknown }).supabase = {
      auth: {
        admin: { signOut: globalSignOut },
        getUser: async () => ({ data: { user: providerUser }, error: null }),
      },
    };
    const token = (sessionId: string, method: string, iat: number) => [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({
        sub: providerUser.id,
        session_id: sessionId,
        iat,
        amr: [{ method, timestamp: iat }],
      })).toString("base64url"),
      "password-reset-test-signature",
    ].join(".");
    const initialProviderToken = token("password-reset-initial", "password", issuedAt);
    const login = await service.loginWithSupabaseAccessToken({
      accessToken: initialProviderToken,
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: CURRENT_LEGAL_POLICY_VERSION,
      privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentSource: "web",
    });
    const secondProviderToken = token("password-reset-second-device", "password", issuedAt + 30);
    const secondLogin = await service.loginWithSupabaseAccessToken({ accessToken: secondProviderToken });
    repository.createDiscountPass({
      id: "password-reset-discount-pass",
      userId: login.account.id,
      sessionTokenHash: crypto.createHash("sha256").update(login.token).digest("hex"),
      codeHash: "password-reset-discount-code-hash",
      createdAt: NOW,
      expiresAt: PREMIUM_UNTIL,
    });
    expect(repositoryDatabases.get(repository)!
      .prepare("SELECT token_hash, provider_session_id_hash, revoked_at FROM auth_sessions WHERE user_id = ?")
      .all(login.account.id)).toHaveLength(2);

    const recoveryToken = token("password-reset-recovery", "otp", issuedAt + 60);
    providerUser.factors = [
      { id: "password-reset-totp", factor_type: "totp", status: "verified" },
    ];
    const mfaRecoveryToken = testSupabaseAccessToken({
      sub: providerUser.id,
      session_id: "password-reset-recovery",
      iat: issuedAt + 60,
      aal: "aal2",
      amr: [
        { method: "otp", timestamp: issuedAt + 60 },
        { method: "totp", timestamp: issuedAt + 60 },
      ],
    }, "password-reset-mfa-signature");
    const wrongSessionMfaToken = testSupabaseAccessToken({
      sub: providerUser.id,
      session_id: "password-reset-wrong-session",
      iat: issuedAt + 60,
      aal: "aal2",
      amr: [{ method: "totp", timestamp: issuedAt + 60 }],
    }, "password-reset-wrong-session-signature");
    const resetSessionRepository = (service as unknown as {
      accountSessionRepository: AccountSessionRepository;
    }).accountSessionRepository;
    const originalPasswordResetContainment = resetSessionRepository.completePasswordResetContainment
      .bind(resetSessionRepository);
    const passwordResetContainment = vi.spyOn(resetSessionRepository, "completePasswordResetContainment");
    await expect(service.completePasswordReset({ accessToken: recoveryToken }))
      .rejects.toMatchObject({
        statusCode: 403,
        details: expect.objectContaining({ publicCode: "MFA_STEP_UP_REQUIRED" }),
      });
    await expect(service.completePasswordReset({
      accessToken: recoveryToken,
      mfaAccessToken: wrongSessionMfaToken,
    })).rejects.toMatchObject({
      statusCode: 403,
      details: expect.objectContaining({ publicCode: "MFA_STEP_UP_REQUIRED" }),
    });
    expect(passwordResetContainment).not.toHaveBeenCalled();
    const failedPasswordResetContainment = vi.spyOn(resetSessionRepository, "completePasswordResetContainment")
      .mockRejectedValueOnce(new Error("simulated password-reset containment failure"));
    await expect(service.completePasswordReset({
      accessToken: recoveryToken,
      mfaAccessToken: mfaRecoveryToken,
    }))
      .rejects.toThrow("simulated password-reset containment failure");
    expect(globalSignOut).not.toHaveBeenCalled();
    expect(repositoryDatabases.get(repository)!
      .prepare("SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL")
      .get(login.account.id)).toEqual({ count: 2 });
    expect(providerRefreshTokensRevoked).toBe(false);
    failedPasswordResetContainment.mockImplementation(originalPasswordResetContainment);
    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);
    await withHttpServer(app, async (baseUrl) => {
      const completed = await fetch(`${baseUrl}/api/business/auth/password-reset-complete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `pint_path_session=${login.token}`,
        },
        body: JSON.stringify({ accessToken: recoveryToken, mfaAccessToken: mfaRecoveryToken }),
      });
      const payload = await completed.json() as { data: Record<string, unknown> };
      expect(completed.status).toBe(200);
      expect(completed.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970");
      expect(payload.data).toEqual(expect.objectContaining({
        completed: true,
        reauthenticationRequired: true,
        revokedSessions: 2,
        revokedDiscountPasses: 1,
      }));
      expect(globalSignOut).toHaveBeenCalledWith(recoveryToken, "global");

      for (const oldAppToken of [login.token, secondLogin.token]) {
        const protectedResponse = await fetch(`${baseUrl}/api/business/account`, {
          headers: { authorization: `Bearer ${oldAppToken}` },
        });
        expect(protectedResponse.status).toBe(401);
      }
    });

    const resetAccount = repository.getAccountById(login.account.id)!;
    expect(resetAccount.providerTokensValidAfter)
      .toBe(new Date(Date.parse(NOW) + 60_000).toISOString());
    expect(await listSecurityAuditLogs(repository, { action: "password_reset_completed" })).toHaveLength(1);
    expect(providerRefreshTokensRevoked).toBe(true);
    const refreshUnknownNeverSyncedProviderSession = () => providerRefreshTokensRevoked
      ? { data: null, error: { message: "refresh token revoked" } }
      : { data: { accessToken: token("password-reset-never-synced", "password", issuedAt + 120) }, error: null };
    expect(refreshUnknownNeverSyncedProviderSession()).toEqual(expect.objectContaining({ data: null }));
    providerUser.factors = [];
    await expect(service.loginWithSupabaseAccessToken({
      accessToken: token("password-reset-unseen-stale", "password", issuedAt + 90),
    })).rejects.toThrow("predates a security reset");
    await expect(service.loginWithSupabaseAccessToken({
      accessToken: token(
        "password-reset-fresh-sign-in",
        "password",
        Math.floor(new Date(NOW).getTime() / 1000) + 120,
      ),
    })).resolves.toEqual(expect.objectContaining({ token: expect.any(String) }));
  });

  it("rejects a provider exchange already in flight when the account token epoch advances", async () => {
    const { repository } = createRepository();
    const nowSeconds = Math.floor(Date.parse(NOW) / 1000);
    const providerUser = {
      id: "provider-epoch-race-user",
      email: "provider-epoch-race-user@example.com",
      email_confirmed_at: NOW,
      user_metadata: {},
    };
    const service = createBusinessService(repository, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "placeholder-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
    });
    const accountSessionRepository = (service as unknown as {
      accountSessionRepository: AccountSessionRepository;
    }).accountSessionRepository;
    (service as unknown as { supabase: unknown }).supabase = {
      auth: {
        getUser: vi.fn(async () => ({ data: { user: providerUser }, error: null })),
      },
    };
    const providerToken = (sessionId: string, issuedAt: number) => testSupabaseAccessToken({
      sub: providerUser.id,
      iat: issuedAt,
      auth_time: issuedAt,
      session_id: sessionId,
      amr: [{ method: "password", timestamp: issuedAt }],
    }, `provider-epoch-race-${sessionId}`);
    const initial = await service.loginWithSupabaseAccessToken({
      accessToken: providerToken("initial", nowSeconds - 120),
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
      termsVersion: CURRENT_LEGAL_POLICY_VERSION,
      privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentSource: "web",
    });
    const accountBeforeInFlight = repository.getAccountById(initial.account.id)!;
    const profileBeforeInFlight = await accountProfilePreferencesRepositories
      .get(repository)!
      .getProfileById(initial.account.id);

    Object.assign(providerUser, {
      email: "provider-epoch-race-changed@example.com",
      user_metadata: {
        full_name: "Rejected Provider Mutation",
        avatar_url: "https://example.test/rejected-provider-avatar.png",
      },
      factors: [
        { id: "rejected-provider-factor", factor_type: "totp", status: "verified" },
      ],
    });

    let releaseExchange!: () => void;
    let markExchangePaused!: () => void;
    const exchangePaused = new Promise<void>((resolve) => { markExchangePaused = resolve; });
    const exchangeRelease = new Promise<void>((resolve) => { releaseExchange = resolve; });
    const originalRotateOrCreate = accountSessionRepository
      .rotateOrCreateSessionTokenWithSupabaseAccountMutation
      .bind(accountSessionRepository);
    vi.spyOn(accountSessionRepository, "rotateOrCreateSessionTokenWithSupabaseAccountMutation")
      .mockImplementation(async (input) => {
      markExchangePaused();
      await exchangeRelease;
      return originalRotateOrCreate(input);
      });

    const inFlightExchange = service.loginWithSupabaseAccessToken({
      accessToken: testSupabaseAccessToken({
        sub: providerUser.id,
        iat: nowSeconds - 60,
        auth_time: nowSeconds - 60,
        session_id: "in-flight",
        aal: "aal2",
        amr: [{ method: "totp", timestamp: nowSeconds - 60 }],
      }, "provider-epoch-race-in-flight"),
    });
    await exchangePaused;
    await accountSessionRepository.completePasswordResetContainment({
      userId: initial.account.id,
      providerSessionIdHash: crypto.createHash("sha256").update("reset-provider-session").digest("hex"),
      providerTokensValidAfter: NOW,
      revokedAt: NOW,
    });
    releaseExchange();

    await expect(inFlightExchange).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ reauthenticationRequired: true }),
    });
    expect(repositoryDatabases.get(repository)!.prepare(
      "SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL",
    ).get(initial.account.id)).toEqual({ count: 0 });
    const accountAfterRejectedExchange = repository.getAccountById(initial.account.id)!;
    expect(accountAfterRejectedExchange).toMatchObject({
      email: accountBeforeInFlight.email,
      displayName: accountBeforeInFlight.displayName,
      displayNameKey: accountBeforeInFlight.displayNameKey,
      avatarUrl: accountBeforeInFlight.avatarUrl,
      authProvider: accountBeforeInFlight.authProvider,
      supabaseUserId: accountBeforeInFlight.supabaseUserId,
      emailVerifiedAt: accountBeforeInFlight.emailVerifiedAt,
      mfaLevel: accountBeforeInFlight.mfaLevel,
      mfaVerifiedAt: accountBeforeInFlight.mfaVerifiedAt,
      termsAcceptedAt: accountBeforeInFlight.termsAcceptedAt,
      privacyAcceptedAt: accountBeforeInFlight.privacyAcceptedAt,
      termsVersion: accountBeforeInFlight.termsVersion,
      privacyVersion: accountBeforeInFlight.privacyVersion,
      ageConfirmedAt: accountBeforeInFlight.ageConfirmedAt,
    });
    expect(await accountProfilePreferencesRepositories
      .get(repository)!
      .getProfileById(initial.account.id)).toEqual(profileBeforeInFlight);
    expect((await getActivityAuditRepository(repository).listUserActivityEvents({
      userId: initial.account.id,
      limit: 20,
    })).items.filter((event) => event.eventType === "user_login")).toHaveLength(1);
    expect(await listSecurityAuditLogs(repository, { action: "login_success" })).toHaveLength(1);
  });

  it("links uploads and verifications to authenticated users and blocks self-verification", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const uploader = createAccount(repository, "uploader");
    const verifier = createAccount(repository, "verifier");
    const secondVerifier = createAccount(repository, "second-verifier");
    const admin = createAccount(repository, "verification-admin", "admin");

    const submissionResult = await service.createSubmission(uploader, createSubmissionSchema.parse({
      venueId: "venue-auth",
      venueName: "Auth Bar",
      suburb: "Carlton",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: PNG_DATA_URL,
      sourcePhotoUrl: null,
      notes: null,
      items: [{
        beerName: "Carlton Draught",
        servingSize: "pint",
        price: 13,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }));

    const submission = submissionResult.submission;
    expect(submission.userId).toBe(uploader.id);
    expect((await getActivityAuditRepository(repository).listUserActivityEvents({ userId: uploader.id, limit: 10 })).items.map((event) => event.eventType))
      .toContain("data_upload_created");
    await expect(service.verifySubmission(uploader, submission.id, { result: "confirmed", notes: null }))
      .rejects.toThrow("You cannot verify your own upload.");

    const verified = await service.verifySubmission(verifier, submission.id, {
      result: "confirmed",
      notes: "Matches the posted tap list.",
    });

    expect(verified.verification.verifierUserId).toBe(verifier.id);
    expect(verified.verification.uploadId).toBe(submission.id);
    await expect(service.verifySubmission(verifier, submission.id, {
      result: "confirmed",
      notes: "Second try should not count twice.",
    })).rejects.toThrow("already verified");
    expect((await getActivityAuditRepository(repository).listUserActivityEvents({ userId: verifier.id, limit: 10 })).items).toEqual([
      expect.objectContaining({
        eventType: "data_verified",
        relatedEntityType: "submission",
        relatedEntityId: submission.id,
      }),
    ]);

    approve(repository, submission.id, admin.id);
    await expect(service.verifySubmission(secondVerifier, submission.id, {
      result: "confirmed",
      notes: null,
    })).rejects.toThrow("Only pending submissions");
  });

  it("lists privacy-safe community verification candidates without owner identity or private evidence", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const uploader = createAccount(repository, "candidate-uploader");
    const verifier = createAccount(repository, "candidate-verifier");
    const candidate = createSubmission(repository, {
      id: "candidate-submission",
      userId: uploader.id,
      venueId: "candidate-venue",
      venueName: "Candidate Hotel",
      beerName: "Guinness",
      price: 14,
    });
    createSubmission(repository, {
      id: "candidate-own-submission",
      userId: verifier.id,
      venueId: "candidate-own-venue",
    });

    const firstPage = await service.getCommunityVerificationCandidates(verifier, { limit: 20, offset: 0 });

    expect(firstPage.pagination).toEqual({ total: 1, limit: 20, offset: 0, hasMore: false });
    expect(firstPage.candidates).toEqual([expect.objectContaining({
      id: candidate.id,
      venueId: "candidate-venue",
      venueName: "Candidate Hotel",
      hasSourceEvidence: true,
      confirmationCount: 0,
      verificationPath: "/api/business/submissions/candidate-submission/verifications",
      items: [expect.objectContaining({ beerName: "Guinness", servingSize: "pint", price: 14 })],
    })]);
    const candidateJson = JSON.stringify(firstPage.candidates[0]);
    expect(candidateJson).not.toContain(uploader.id);
    expect(candidateJson).not.toContain(uploader.email);
    expect(candidateJson).not.toContain(JPEG_DATA_URL);
    expect(firstPage.candidates[0]).not.toHaveProperty("userId");
    expect(firstPage.candidates[0]).not.toHaveProperty("sourcePhotoUrl");
    expect(firstPage.candidates[0]).not.toHaveProperty("notes");
    expect(firstPage.candidates[0]).not.toHaveProperty("uploadLatitude");
    expect(firstPage.candidates[0]).not.toHaveProperty("pendingVenue");

    await service.verifySubmission(verifier, candidate.id, { result: "confirmed", notes: null });
    expect((await service.getCommunityVerificationCandidates(verifier, { limit: 20, offset: 0 })).candidates).toEqual([]);
  });

  it("deduplicates retried queued submissions by client submission ID", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const uploader = createAccount(repository, "queued-uploader");
    const payload = createSubmissionSchema.parse({
      clientSubmissionId: "queued-submit-123",
      venueId: "venue-queued",
      venueName: "Queued Bar",
      suburb: "Carlton",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: null,
      sourcePhotoUrl: null,
      notes: null,
      uploadLocation: {
        latitude: -37.801,
        longitude: 144.967,
        accuracyMeters: 25,
        capturedAt: NOW,
      },
      items: [{
        beerName: "Carlton Draught",
        servingSize: "pint",
        price: 13,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    });

    const first = await service.createSubmission(uploader, payload);
    const replay = await service.createSubmission(uploader, payload);

    expect(replay.submission.id).toBe(first.submission.id);
    expect(replay.submission.clientSubmissionId).toBe("queued-submit-123");
    expect(replay).toMatchObject({ idempotentReplay: true });
    expect(repository.listSubmissions({ userId: uploader.id, limit: 10 })).toHaveLength(1);
  });

  it("blocks new venue submissions that duplicate a known venue", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const uploader = createAccount(repository, "duplicate-venue-uploader");
    repository.upsertVenueLocationCache({
      venueId: "venue-known-half-moon",
      venueName: "Half Moon",
      suburb: "Brighton",
      latitude: -37.913,
      longitude: 144.991,
      now: NOW,
    });

    await expect(service.createSubmission(uploader, createSubmissionSchema.parse({
      clientSubmissionId: "queued-new-venue-duplicate",
      venueId: "pending-half-moon",
      venueName: "Half Moon",
      suburb: "Brighton",
      newVenue: {
        name: "Half Moon",
        address: "120 Church Street",
        suburb: "Brighton",
        state: "VIC",
        postcode: "3186",
        phone: null,
        website: null,
        latitude: null,
        longitude: null,
      },
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: null,
      sourcePhotoUrl: null,
      notes: null,
      uploadLocation: {
        latitude: -37.913,
        longitude: 144.991,
        accuracyMeters: 20,
        capturedAt: NOW,
      },
      items: [{
        beerName: "Guinness",
        servingSize: "pint",
        price: 14,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }))).rejects.toThrow("already appears to be on Pint Path");

    expect(repository.listSubmissions({ userId: uploader.id, limit: 10 })).toHaveLength(0);
  });

  it("returns contributor dashboard stats and redacts raw evidence references", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const submitter = createAccount(repository, "dashboard-contributor");
    const admin = createAccount(repository, "dashboard-admin", "admin");

    const pending = createSubmission(repository, {
      id: "dashboard-pending",
      userId: submitter.id,
      venueId: "venue-dashboard-1",
      venueName: "Dashboard Bar",
      beerName: "Guinness",
      price: 12,
      sourcePhotoUrl: "private:evidence:evidence-1",
    });
    const approved = createSubmission(repository, {
      id: "dashboard-approved",
      userId: submitter.id,
      venueId: "venue-dashboard-2",
      venueName: "Approved Bar",
      beerName: "Carlton Draught",
      price: 13,
      sourcePhotoUrl: "private:evidence:evidence-2",
    });
    approve(repository, approved.id, admin.id);

    const dashboard = await service.getAccountDashboard(repository.getAccountById(submitter.id)!);

    expect(dashboard.dashboardStats).toEqual(expect.objectContaining({
      totalUploads: 2,
      pendingVerificationCount: 1,
      verifiedCount: 1,
      rejectedCount: 0,
    }));
    expect(dashboard.recentSubmissions[0]).toEqual(expect.objectContaining({
      venueName: pending.venueName,
      hasEvidence: true,
      items: [expect.objectContaining({
        beerName: "Guinness",
        servingSize: "pint",
        price: 12,
      })],
    }));
    expect(JSON.stringify(dashboard.recentSubmissions)).not.toContain("private:evidence");
  });

  it("keeps dashboard history bounded while reporting exact lifetime totals above 1,000 submissions", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const account = createAccount(repository, "large-dashboard-contributor");
    const insert = database.prepare(
      `INSERT INTO submissions (
        id, user_id, venue_id, venue_name, suburb, status, submission_type,
        observed_at, source_photo_url, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'single_beer_price', ?, NULL, NULL, ?, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < 1_001; index += 1) {
        const status = index === 1_000 ? "approved" : "pending";
        const timestamp = new Date(new Date(NOW).getTime() - index * 1_000).toISOString();
        insert.run(
          `large-dashboard-${index}`,
          account.id,
          `large-dashboard-venue-${index}`,
          `Large Dashboard Venue ${index}`,
          "Melbourne",
          status,
          NOW,
          timestamp,
          timestamp,
        );
      }
    })();
    const activityAuditRepository = getActivityAuditRepository(repository);
    for (let index = 0; index < 30; index += 1) {
      await activityAuditRepository.createUserActivityEvent({
        id: `dashboard-activity-${String(index).padStart(2, "0")}`,
        userId: account.id,
        eventType: "dashboard_contract_event",
        relatedEntityType: "account",
        relatedEntityId: account.id,
        metadata: { index },
        createdAt: new Date(new Date(NOW).getTime() - index * 1_000).toISOString(),
      });
    }
    const communityRepository = communitySubmissionRepositories.get(repository)!;
    const listSpy = vi.spyOn(communityRepository, "listSubmissions");

    const dashboard = await service.getAccountDashboard(repository.getAccountById(account.id)!);

    expect(dashboard.dashboardStats).toEqual(expect.objectContaining({
      totalUploads: 1_001,
      pendingCount: 1_000,
      pendingVerificationCount: 1_000,
      verifiedCount: 1,
    }));
    expect(dashboard.submissions).toHaveLength(12);
    expect(dashboard.submissionHistory).toHaveLength(12);
    expect(dashboard.recentSubmissions).toHaveLength(12);
    expect(dashboard.submissionPagination).toEqual({
      total: 1_001,
      limit: 12,
      offset: 0,
      hasMore: true,
    });
    expect(listSpy).toHaveBeenCalledWith({ userId: account.id, limit: 12, offset: 0 });
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(dashboard.activity).toHaveLength(25);
    expect(dashboard.activity.map((event) => event.id)).toEqual(
      Array.from({ length: 25 }, (_, index) => `dashboard-activity-${String(index).padStart(2, "0")}`),
    );
    expect(dashboard.activity[0]).toEqual(expect.objectContaining({
      userId: account.id,
      eventType: "dashboard_contract_event",
      createdAt: NOW,
    }));
  });

  it("exports all account location fields while excluding raw private evidence", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const account = createAccount(repository, "export-user");

    createSubmission(repository, {
      id: "export-submission",
      userId: account.id,
      venueId: "export-venue",
      venueName: "Export Venue",
      beerName: "Stone & Wood Pacific Ale",
      price: 11,
      sourcePhotoUrl: "private:evidence:export-evidence",
    });
    const activityAuditRepository = getActivityAuditRepository(repository);
    for (let index = 0; index < 205; index += 1) {
      await activityAuditRepository.createUserActivityEvent({
        id: `export-history-${String(index).padStart(3, "0")}`,
        userId: account.id,
        eventType: "export_history_event",
        relatedEntityType: "account",
        relatedEntityId: account.id,
        metadata: { index },
        createdAt: new Date(new Date(NOW).getTime() - (index + 1) * 1_000).toISOString(),
      });
    }

    const exported = await service.exportAccountData(account);
    const serialized = JSON.stringify(exported);

    expect(exported).toEqual(expect.objectContaining({
      exportFormat: "pint_path_account_export_v1",
      account: expect.objectContaining({ id: account.id }),
    }));
    expect(serialized).toContain("hasPrivateEvidence");
    expect(serialized).not.toContain("private:evidence");
    expect(serialized).not.toContain("sourcePhotoUrl");
    expect(exported.submissions[0]).toEqual(expect.objectContaining({
      uploadLatitude: null,
      uploadLongitude: null,
      uploadLocationCapturedAt: null,
    }));
    expect(exported.activity).toHaveLength(206);
    expect(exported.activity[0]?.eventType).toBe("account_data_exported");
    expect(exported.activity.slice(1).map((event) => event.id)).toEqual(
      Array.from({ length: 205 }, (_, index) => `export-history-${String(index).padStart(3, "0")}`),
    );
    expect(new Set(exported.activity.map((event) => event.id)).size).toBe(206);
    expect((await getActivityAuditRepository(repository).listUserActivityEvents({ userId: account.id, limit: 10 })).items.map((event) => event.eventType))
      .toContain("account_data_exported");
  });

  it("triages sensitive feedback and creates deletion requests through the support queue", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const account = createAccount(repository, "delete-request-user");

    const security = await service.submitFeedback(account, {
      anonymousSessionId: null,
      feedbackType: "security_report",
      message: "Suspicious account activity.",
      venueId: null,
      venueName: null,
    });
    const deletion = await service.requestAccountDeletion(account, {
      message: "Please remove my contributor account.",
    });
    const partnerInterest = await service.submitFeedback(account, {
      anonymousSessionId: null,
      feedbackType: "venue_partner_interest",
      message: "I manage Half Moon and want to join Pint Path.",
      venueId: null,
      venueName: "Half Moon",
    });

    expect(security.feedback).toEqual(expect.objectContaining({
      priority: "high",
      triageReason: expect.stringContaining("Sensitive account/security"),
    }));
    expect(deletion.request).toEqual(expect.objectContaining({
      user_id: account.id,
      status: "pending_review",
    }));
    expect(partnerInterest.feedback).toEqual(expect.objectContaining({
      feedbackType: "venue_partner_interest",
      priority: "medium",
      triageReason: expect.stringContaining("Venue partner wants to join"),
    }));
    expect((await getSupportFeedbackRepository(repository).listFeedback({ limit: 10 })).map((item) => item.feedbackType))
      .toEqual(expect.arrayContaining(["security_report", "venue_partner_interest"]));
    expect((await getActivityAuditRepository(repository).listUserActivityEvents({ userId: account.id, limit: 10 })).items.map((event) => event.eventType))
      .toContain("account_deletion_requested");
  });

  it("prevents stale trust-queue overwrites and rejects non-admin assignees", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "trust-admin", "admin");
    const user = createAccount(repository, "trust-user");
    const feedback = (await service.submitFeedback(user, {
      anonymousSessionId: null,
      feedbackType: "bug",
      message: "The trust queue needs concurrency protection.",
      venueId: null,
      venueName: null,
    })).feedback;

    await expect(service.updateTrustQueueItem(admin, "feedback", feedback.id, {
      status: "in_progress",
      assignedTo: user.id,
      resolutionNote: null,
      expectedUpdatedAt: feedback.updatedAt,
    })).rejects.toThrow("active, authorised administrator");

    const updated = (await service.updateTrustQueueItem(admin, "feedback", feedback.id, {
      status: "in_progress",
      assignedTo: "self",
      resolutionNote: "Investigating.",
      expectedUpdatedAt: feedback.updatedAt,
    })).item;
    expect(updated).toEqual(expect.objectContaining({
      status: "in_progress",
      assignedTo: admin.id,
      resolutionNote: "Investigating.",
    }));
    expect(updated.updatedAt).not.toBe(feedback.updatedAt);

    await expect(service.updateTrustQueueItem(admin, "feedback", feedback.id, {
      status: "resolved",
      assignedTo: null,
      resolutionNote: "Stale overwrite.",
      expectedUpdatedAt: feedback.updatedAt,
    })).rejects.toThrow("changed. Refresh");
    expect((await getSupportFeedbackRepository(repository).listFeedback({ limit: 10 }))[0]).toEqual(expect.objectContaining({
      status: "in_progress",
      resolutionNote: "Investigating.",
    }));
  });

  it("refuses production deletion without a ledger writer before any destructive side effect", async () => {
    const { database, repository } = createRepository();
    const stripeDelete = vi.fn(async () => new Response(null, { status: 200 }));
    const deleteIdentity = vi.fn(async () => ({ data: null, error: null }));
    vi.stubGlobal("fetch", stripeDelete);
    const service = createBusinessService(
      repository,
      {
        NODE_ENV: "production",
        DEMO_BILLING_MODE: false,
        STRIPE_SECRET_KEY: "test-stripe-secret-key", // security-scan allow: synthetic no-call fixture only
      },
      undefined,
      {
        auth: { admin: { deleteUser: deleteIdentity } },
      } as ConstructorParameters<typeof BusinessService>[32],
    );
    const account = createAccount(repository, "deletion-ledger-guard-user");
    const admin = createAccount(repository, "admin", "admin");
    repository.updateAccountSecurityClaims({
      userId: admin.id,
      emailVerifiedAt: NOW,
      mfaLevel: "aal2",
      mfaVerifiedAt: NOW,
      now: NOW,
    });
    const authorisedAdmin = repository.getAccountById(admin.id)!;
    database.prepare(
      `UPDATE accounts
          SET stripe_customer_id = ?, supabase_user_id = ?
        WHERE id = ?`,
    ).run("cus_must_remain", "supabase-user-must-remain", account.id);
    createSession(repository, account.id, "deletion-ledger-guard-session");
    const deletion = await service.requestAccountDeletion(account, { message: "Delete only when safe." });
    const requestId = String(deletion.request.id);
    database
      .prepare("UPDATE account_deletion_requests SET execute_after = ? WHERE id = ?")
      .run("2026-05-03T08:00:00.000Z", requestId);

    await expect(service.executeAccountDeletion(authorisedAdmin, requestId, "guard regression"))
      .rejects.toThrow("Independent account-deletion ledger is not configured");

    expect(stripeDelete).not.toHaveBeenCalled();
    expect(deleteIdentity).not.toHaveBeenCalled();
    expect(database.prepare(
      `SELECT status, processing_started_at, attempt_count, last_error
         FROM account_deletion_requests WHERE id = ?`,
    ).get(requestId)).toEqual({
      status: "pending_review",
      processing_started_at: null,
      attempt_count: 0,
      last_error: null,
    });
    expect(database.prepare(
      "SELECT revoked_at FROM auth_sessions WHERE user_id = ?",
    ).get(account.id)).toEqual({ revoked_at: null });
    database.prepare(
      "UPDATE account_deletion_requests SET deletion_tombstone_recorded_at = ? WHERE id = ?",
    ).run(NOW, requestId);
    await expect(service.executeAccountDeletion(authorisedAdmin, requestId, "cloned tombstone guard"))
      .rejects.toThrow("Independent account-deletion ledger is not configured");
    expect(stripeDelete).not.toHaveBeenCalled();
    expect(deleteIdentity).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, processing_started_at, attempt_count FROM account_deletion_requests WHERE id = ?",
    ).get(requestId)).toEqual({
      status: "pending_review",
      processing_started_at: null,
      attempt_count: 0,
    });
    expect(database.prepare(
      "SELECT revoked_at FROM auth_sessions WHERE user_id = ?",
    ).get(account.id)).toEqual({ revoked_at: null });
    expect(repository.getAccountById(account.id)).toEqual(expect.objectContaining({
      stripeCustomerId: "cus_must_remain",
      supabaseUserId: "supabase-user-must-remain",
      status: "active",
    }));
  });

  it("requires and persists the independent tombstone receipt in canonical production", async () => {
    const { database, repository } = createRepository();
    const tombstoneWriter = vi.fn(async () => undefined);
    const service = createBusinessService(
      repository,
      {
        NODE_ENV: "production",
        DEMO_BILLING_MODE: false,
        ADMIN_EMAILS: "deletion-strict-policy-admin@example.com",
      },
      undefined,
      undefined,
      tombstoneWriter,
    );
    const account = createAccount(repository, "deletion-strict-policy-user");
    const admin = createAccount(repository, "deletion-strict-policy-admin", "admin");
    repository.updateAccountSecurityClaims({
      userId: admin.id,
      emailVerifiedAt: NOW,
      mfaLevel: "aal2",
      mfaVerifiedAt: NOW,
      now: NOW,
    });
    const request = await service.requestAccountDeletion(account, {});
    database.prepare(
      "UPDATE account_deletion_requests SET execute_after = ? WHERE id = ?",
    ).run("2026-05-03T08:00:00.000Z", request.request.id);

    await expect(service.executeAccountDeletion(
      repository.getAccountById(admin.id)!,
      request.request.id,
      "strict production policy regression",
    )).resolves.toEqual(expect.objectContaining({ status: "completed" }));
    expect(tombstoneWriter).toHaveBeenCalledWith({
      requestId: request.request.id,
      userId: account.id,
      completedAt: NOW,
    });
    expect(await accountDeletionQueueRepositories.get(repository)!
      .getAccountDeletionRequestById(request.request.id)).toEqual(expect.objectContaining({
      status: "completed",
      deletion_tombstone_recorded_at: NOW,
    }));
  });

  it("enforces the deletion safety window before anonymising the account and purging evidence", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const account = createAccount(repository, "deletion-workflow-user");
    const admin = createAccount(repository, "deletion-workflow-admin", "admin");
    createSession(repository, account.id, "deletion-workflow-session-token");

    const submission = (await service.createSubmission(account, createSubmissionSchema.parse({
      venueId: "deletion-workflow-venue",
      venueName: "Deletion Workflow Venue",
      suburb: "Melbourne",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: PNG_DATA_URL,
      sourcePhotoUrl: null,
      notes: "Remove this private note.",
      items: [{
        beerName: "Guinness",
        servingSize: "pint",
        price: 13,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }))).submission;
    const evidenceId = submission.sourcePhotoUrl!.replace("private:evidence:", "");
    approve(repository, submission.id, admin.id);
    expect(database.prepare(
      "SELECT count(*) AS count FROM venue_price_records WHERE source_submission_id = ?",
    ).get(submission.id)).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM contribution_ledger WHERE submission_id = ?",
    ).get(submission.id)).toEqual({ count: 1 });
    const activityAuditRepository = new ActivityAuditRepository(getAsyncDatabase(database));
    await activityAuditRepository.recordEvent({
      id: "deletion-cross-actor-event",
      userId: admin.id,
      anonymousSessionId: null,
      eventType: "feedback_submitted",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: {
        [account.email.toUpperCase()]: "historical identifying key",
        nested: { [`owner:${account.id}`]: account.email },
      },
      createdAt: NOW,
    });
    await activityAuditRepository.insertSecurityAuditLog({
      id: "deletion-cross-actor-audit",
      actorUserId: admin.id,
      actorRole: "admin",
      action: "historical_cross_actor_reference",
      targetType: "support_case",
      targetId: "case-1",
      metadata: { [`email:${account.email}`]: { [`user:${account.id}`]: true } },
      ipHash: null,
      userAgentHash: null,
      createdAt: NOW,
    });
    const deletion = await service.requestAccountDeletion(account, { message: "Delete my account." });
    const requestId = String(deletion.request.id);

    await expect(service.executeAccountDeletion(admin, requestId)).rejects.toThrow(
      "seven-day account deletion safety window",
    );
    expect(await accountDeletionQueueRepositories.get(repository)!
      .getAccountDeletionCompletionOutbox(requestId)).toBeNull();

    database
      .prepare("UPDATE account_deletion_requests SET execute_after = ? WHERE id = ?")
      .run("2026-05-03T08:00:00.000Z", requestId);
    const result = await service.executeAccountDeletion(admin, requestId);

    expect(result).toEqual(expect.objectContaining({ requestId, status: "completed" }));
    expect(await accountDeletionQueueRepositories.get(repository)!
      .getAccountDeletionCompletionOutbox(requestId)).toEqual(expect.objectContaining({
      request_id: requestId,
      status: "pending",
      provider_message_id: null,
    }));
    const notificationSecret = await accountDeletionQueueRepositories.get(repository)!
      .getAccountDeletionNoticeRecipientSecret(requestId);
    expect(notificationSecret).toEqual(expect.objectContaining({ key_id: "test-v1" }));
    expect(Buffer.concat([
      notificationSecret!.nonce,
      notificationSecret!.ciphertext,
      notificationSecret!.auth_tag,
    ]).includes(Buffer.from(account.email, "utf8"))).toBe(false);
    expect(repository.getAccountById(account.id)).toEqual(expect.objectContaining({
      email: `deleted-${account.id}@invalid.pintpath.local`,
      status: "suspended",
      subscriptionStatus: "free",
    }));
    expect(await getSourceEvidenceObjectRepository(repository).getSourceEvidenceObject(evidenceId)).toEqual(expect.objectContaining({
      dataBase64: null,
      deletedAt: NOW,
    }));
    expect(repository.getSubmissionById(submission.id)).toBeNull();
    expect(database.prepare(
      "SELECT count(*) AS count FROM submission_items WHERE submission_id = ?",
    ).get(submission.id)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM contribution_ledger WHERE user_id = ? OR submission_id = ?",
    ).get(account.id, submission.id)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM venue_price_records WHERE source_submission_id = ?",
    ).get(submission.id)).toEqual({ count: 0 });
    expect(result).toEqual(expect.objectContaining({
      summary: expect.objectContaining({
        removedSubmissions: 1,
        removedSubmissionItems: 1,
        removedContributionRows: 1,
        removedDerivedPriceRecords: 1,
      }),
    }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?").get(account.id))
      .toEqual({ count: 0 });
    expect(await accountDeletionQueueRepositories.get(repository)!
      .listAccountDeletionRequests({ limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: requestId,
        status: "completed",
        reviewed_by: admin.id,
        deletion_tombstone_recorded_at: null,
      }),
    ]));
    const scrubbedMetadata = JSON.stringify([
      database.prepare("SELECT metadata_json FROM events WHERE id = ?").get("deletion-cross-actor-event"),
      database.prepare("SELECT metadata_json FROM security_audit_log WHERE id = ?").get("deletion-cross-actor-audit"),
    ]).toLowerCase();
    expect(scrubbedMetadata).not.toContain(account.email.toLowerCase());
    expect(scrubbedMetadata).not.toContain(account.id.toLowerCase());
    expect(scrubbedMetadata).toContain("deleted-email");
  });

  it("commits local evidence scrubbing before the post-commit deletion cleanup can fail", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const account = createAccount(repository, "deletion-atomic-evidence-user");
    const admin = createAccount(repository, "deletion-atomic-evidence-admin", "admin");

    const submission = (await service.createSubmission(account, createSubmissionSchema.parse({
      venueId: "deletion-atomic-evidence-venue",
      venueName: "Deletion Atomic Evidence Venue",
      suburb: "Melbourne",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: PNG_DATA_URL,
      sourcePhotoUrl: null,
      notes: "This evidence must be scrubbed atomically.",
      items: [{
        beerName: "Guinness",
        servingSize: "pint",
        price: 13,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }))).submission;
    const evidenceId = submission.sourcePhotoUrl!.replace("private:evidence:", "");
    database.prepare(
      "UPDATE source_evidence_objects SET external_url = ? WHERE id = ?",
    ).run("https://private.example.test/account-evidence.png", evidenceId);
    const insertAdditionalEvidence = database.prepare(
      `INSERT INTO source_evidence_objects (
         id, owner_user_id, storage_provider, object_path, mime_type, byte_size,
         data_base64, external_url, retention_expires_at, deleted_at, created_at
       ) VALUES (?, ?, 'sqlite_private', ?, 'image/png', 7, 'cHJpdmF0ZQ==', NULL, ?, NULL, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < 500; index += 1) {
        insertAdditionalEvidence.run(
          `deletion-extra-evidence-${String(index).padStart(3, "0")}`,
          account.id,
          `evidence/deletion-extra-${index}.png`,
          "2026-08-01T08:00:00.000Z",
          NOW,
        );
      }
    })();

    const requestId = String((await service.requestAccountDeletion(account, {})).request.id);
    database.prepare(
      "UPDATE account_deletion_requests SET execute_after = ? WHERE id = ?",
    ).run("2026-05-03T08:00:00.000Z", requestId);
    const retentionRepository = sourceEvidenceRetentionRepositories.get(repository)!;
    const ownerEnumeration = vi.spyOn(retentionRepository, "listSourceEvidenceForOwner");
    vi.spyOn(retentionRepository, "markSourceEvidenceDeleted").mockImplementation(() => {
      throw new Error("simulated post-commit evidence cleanup failure");
    });

    await expect(service.executeAccountDeletion(admin, requestId)).resolves.toEqual(
      expect.objectContaining({ requestId, status: "completed" }),
    );

    expect(database.prepare(
      `SELECT owner_user_id, data_base64, external_url, byte_size, deleted_at
         FROM source_evidence_objects WHERE id = ?`,
    ).get(evidenceId)).toEqual({
      owner_user_id: null,
      data_base64: null,
      external_url: null,
      byte_size: null,
      deleted_at: NOW,
    });
    expect(ownerEnumeration).toHaveBeenCalledTimes(2);
    expect(database.prepare(
      "SELECT status, completed_at FROM account_deletion_requests WHERE id = ?",
    ).get(requestId)).toEqual({ status: "completed", completed_at: NOW });
  });

  it("orders eligible account deletions oldest-first and reports actionable queue health", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "deletion-queue-admin", "admin");
    const dueOldestAccount = createAccount(repository, "deletion-queue-due-oldest");
    const dueFailedAccount = createAccount(repository, "deletion-queue-due-failed");
    const futureProcessingAccount = createAccount(repository, "deletion-queue-future-processing");
    const completedAccount = createAccount(repository, "deletion-queue-completed");

    const dueOldestId = String((await service.requestAccountDeletion(dueOldestAccount, {})).request.id);
    const dueFailedId = String((await service.requestAccountDeletion(dueFailedAccount, {})).request.id);
    const futureProcessingId = String((await service.requestAccountDeletion(futureProcessingAccount, {})).request.id);
    const completedId = String((await service.requestAccountDeletion(completedAccount, {})).request.id);
    const updateQueueRow = database.prepare(
      `UPDATE account_deletion_requests
          SET status = ?, requested_at = ?, execute_after = ?
        WHERE id = ?`,
    );
    updateQueueRow.run("pending_review", "2026-04-20T08:00:00.000Z", "2026-04-27T08:00:00.000Z", dueOldestId);
    updateQueueRow.run("failed", "2026-04-25T08:00:00.000Z", "2026-05-02T08:00:00.000Z", dueFailedId);
    updateQueueRow.run("processing", "2026-05-03T08:00:00.000Z", "2026-05-10T08:00:00.000Z", futureProcessingId);
    updateQueueRow.run("completed", "2026-04-01T08:00:00.000Z", "2026-04-08T08:00:00.000Z", completedId);

    const firstPage = await service.listAccountDeletionRequests(admin, { limit: 3, offset: 0 });
    expect(firstPage.requests.map((request) => request.id)).toEqual([
      dueOldestId,
      dueFailedId,
      futureProcessingId,
    ]);
    expect(firstPage.summary).toEqual({
      asOf: NOW,
      actionableCount: 3,
      dueCount: 2,
      failedCount: 1,
      processingCount: 1,
      oldestDueAt: "2026-04-27T08:00:00.000Z",
      nextDueAt: "2026-05-10T08:00:00.000Z",
      notifications: {
        pendingCount: 0,
        acceptedCount: 0,
        manualReviewCount: 0,
        overdueRetentionCount: 0,
        securePurgeCheckpointPendingCount: 0,
        oldestSecurePurgeCheckpointAt: null,
        oldestPendingAt: null,
      },
    });
    expect(firstPage.pagination).toEqual({ limit: 3, offset: 0, hasMore: true });

    const secondPage = await service.listAccountDeletionRequests(admin, { limit: 3, offset: 3 });
    expect(secondPage.requests.map((request) => request.id)).toEqual([completedId]);
    expect(secondPage.pagination.hasMore).toBe(false);
  });

  it("saves account privacy settings and suppresses opted-out optional analytics", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const account = createAccount(repository, "privacy-settings-user");

    expect((await service.getAccountDashboard(account)).privacySettings).toEqual(expect.objectContaining({
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
    }));

    await service.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "map_pin_click",
      venueId: "privacy-venue-before-consent",
      beerId: null,
      suburb: "Richmond",
      metadata: { privacyScope: "venue_insight" },
    });
    await service.trackClientEvent(account, {
      anonymousSessionId: "forged-client-id",
      eventType: "beer_search_performed",
      venueId: null,
      beerId: "guinness",
      suburb: "Richmond",
      metadata: { privacyScope: "essential", query: "forged scope" },
    }, { ip: "203.0.113.10" });
    await service.trackClientEvent(account, {
      anonymousSessionId: "another-forged-id",
      eventType: "map_pin_click",
      venueId: "privacy-venue-forged",
      beerId: null,
      suburb: "Richmond",
      metadata: {},
    }, { ip: "203.0.113.10" });
    for (const eventType of ["free_preview_viewed", "venue_portal_viewed", "venue_insights_viewed"] as const) {
      await service.trackEvent(account, {
        anonymousSessionId: null,
        eventType,
        venueId: "privacy-internal-venue",
        beerId: null,
        suburb: "Richmond",
        metadata: {},
      });
    }

    const saved = await service.savePrivacySettings(account, {
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: true,
      productResearchEnabled: true,
      emailUpdatesEnabled: true,
      expectedUpdatedAt: null,
    });

    expect(saved.privacySettings).toEqual(expect.objectContaining({
      userId: account.id,
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
    }));

    await service.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "beer_search_performed",
      venueId: null,
      beerId: "guinness",
      suburb: "Richmond",
      metadata: { privacyScope: "optional_analytics", query: "Guinness pint" },
    });
    await service.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "map_pin_click",
      venueId: "privacy-venue",
      beerId: null,
      suburb: "Richmond",
      metadata: { privacyScope: "venue_insight" },
    });
    await service.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_portal_viewed",
      venueId: "privacy-venue-after-opt-in",
      beerId: null,
      suburb: "Richmond",
      metadata: {},
    });
    await service.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "feedback_submitted",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { feedbackType: "privacy_request" },
    });
    await service.saveItem(account, {
      itemType: "venue",
      itemId: "privacy-venue",
      label: "Privacy Venue",
      suburb: "Richmond",
      metadata: {},
    });
    const optedIn = await service.savePrivacySettings(account, {
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
      expectedUpdatedAt: saved.privacySettings.updatedAt,
    });
    await service.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "map_pin_click",
      venueId: "privacy-venue-after-opt-in",
      beerId: null,
      suburb: "Richmond",
      metadata: { privacyScope: "venue_insight" },
    });
    expect(database.prepare("SELECT count(*) AS count FROM events WHERE venue_id = ?").get("privacy-venue-after-opt-in"))
      .toEqual({ count: 1 });
    await service.savePrivacySettings(account, {
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
      expectedUpdatedAt: optedIn.privacySettings.updatedAt,
    });

    const eventRows = database
      .prepare("SELECT event_type FROM events ORDER BY created_at")
      .all() as Array<{ event_type: string }>;
    expect(eventRows.map((row) => row.event_type)).toEqual(["feedback_submitted"]);
    expect((await getActivityAuditRepository(repository).listUserActivityEvents({ userId: account.id, limit: 10 })).items.map((event) => event.eventType))
      .toContain("account_privacy_settings_updated");
  });

  it("does not let forged anonymous IDs satisfy venue analytics privacy floors", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository, { ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = createAccount(repository, "sybil-floor-admin", "admin");
    await service.upsertBarProfile(admin, "sybil-floor-venue", {
      name: "Sybil Floor Hotel",
      address: null,
      suburb: "Richmond",
      area: "Richmond",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "pro",
      acceptsPintPathCodes: false,
      active: true,
    });

    for (let index = 0; index < 20; index += 1) {
      await service.trackClientEvent(null, {
        anonymousSessionId: `caller-forged-${index}`,
        eventType: "search_performed",
        venueId: "sybil-floor-venue",
        beerId: null,
        suburb: "Richmond",
        metadata: {},
      }, { ip: "198.51.100.24" });
    }

    expect(database.prepare(
      "SELECT count(DISTINCT anonymous_session_id) AS count FROM events WHERE venue_id = ?",
    ).get("sybil-floor-venue")).toEqual({ count: 1 });
    const portal = await service.getVenuePortal(admin, { venueId: "sybil-floor-venue" });
    expect(portal.analytics).toEqual(expect.objectContaining({ privacyFloorMet: false }));
  });

  it("only allows age-gated reward eligibility for verified 18+ records that have not expired", async () => {
    const { repository } = createRepository();
    const account = createAccount(repository, "age-user");

    expect(canAccessAgeGatedRewards({
      account,
      latestAgeVerification: repository.getLatestAgeVerification(account.id),
      now: NOW,
    })).toBe(false);

    const verified = repository.upsertAgeVerification({
      id: "age-verification-1",
      userId: account.id,
      status: "verified",
      ageThreshold: 18,
      isOver18: true,
      providerName: "future-provider",
      providerReferenceId: "provider-ref-1",
      checkedAt: NOW,
      expiresAt: "2026-12-31T00:00:00.000Z",
      now: NOW,
    });
    const updatedAccount = repository.getAccountById(account.id)!;

    expect(canAccessAgeGatedRewards({
      account: updatedAccount,
      latestAgeVerification: verified,
      now: NOW,
    })).toBe(true);

    const expired = repository.upsertAgeVerification({
      id: "age-verification-1",
      userId: account.id,
      status: "verified",
      ageThreshold: 18,
      isOver18: true,
      providerName: "future-provider",
      providerReferenceId: "provider-ref-1",
      checkedAt: NOW,
      expiresAt: "2026-01-01T00:00:00.000Z",
      now: NOW,
    });

    expect(canAccessAgeGatedRewards({
      account: repository.getAccountById(account.id)!,
      latestAgeVerification: expired,
      now: NOW,
    })).toBe(false);
  });

  it("keeps raw proof-of-ID fields out of the age verification schema", async () => {
    const schema = fs.readFileSync(path.resolve(process.cwd(), "src/db/schema.sql"), "utf8");
    const ageVerificationSchema = schema.match(/CREATE TABLE IF NOT EXISTS age_verifications[\s\S]*?\);/i)?.[0] ?? "";

    expect(ageVerificationSchema.toLowerCase()).not.toMatch(
      /passport|licen[sc]e|driver|medicare|date_of_birth|dob|id_image|document|birthdate/,
    );
  });
});

describe("production hardening", () => {
  it("limits free users to core pint price previews server-side", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const submitter = createAccount(repository, "submitter");
    const admin = createAccount(repository, "admin", "admin");
    const first = createSubmission(repository, { id: "submission-1", userId: submitter.id, venueId: "venue-1", price: 14 });
    const second = createSubmission(repository, { id: "submission-2", userId: submitter.id, venueId: "venue-2", beerName: "Asahi Super Dry", price: 16 });
    const third = createSubmission(repository, { id: "submission-3", userId: submitter.id, venueId: "venue-3", beerName: "Guinness", servingSize: "schooner", price: 11 });

    approve(repository, first.id, admin.id);
    approve(repository, second.id, admin.id);
    approve(repository, third.id, admin.id);

    const preview = await service.listPriceRecords(null, {
      anonymousSessionId: "anon-price-test",
      limit: 20,
      venueId: null,
    });
    expect(preview.records).toHaveLength(3);
    expect(preview.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ beerName: "Carlton Draught", servingSize: "pint", price: 14, freePreviewIncluded: true }),
      expect.objectContaining({ beerName: "Asahi Super Dry", price: null, priceRedacted: true }),
      expect.objectContaining({ beerName: "Guinness", servingSize: "schooner", price: null, priceRedacted: true }),
    ]));

    const venuePreview = await service.listPriceRecords(null, {
      anonymousSessionId: "anon-price-test",
      limit: 20,
      venueId: "venue-1",
    });
    expect(venuePreview.preview).toEqual({ model: "fixed_preview", includedCount: 1, lockedCount: 0 });
    expect(venuePreview).not.toHaveProperty("revealed");
    expect(venuePreview).not.toHaveProperty("blocked");
    expect(venuePreview.records[0]?.price).toBe(14);

    const lockedPreview = await service.listPriceRecords(null, {
      anonymousSessionId: "anon-price-test",
      limit: 20,
      venueId: "venue-2",
    });
    expect(lockedPreview.preview).toEqual({ model: "fixed_preview", includedCount: 0, lockedCount: 1 });
    expect(lockedPreview.records[0]?.price).toBeNull();
    expect((lockedPreview.records[0] as { priceRedacted?: boolean } | undefined)?.priceRedacted).toBe(true);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    expect(database.prepare(
      `SELECT count(*) AS count FROM events
        WHERE event_type = ? AND created_at >= ? AND anonymous_session_id = ?`,
    ).get("free_preview_viewed", todayStart.toISOString(), "anon-price-test")).toEqual({ count: 0 });
  });

  it("rejects public happy-hour contribution payloads while preserving venue-manager collection", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "launch-scope-user");
    const manager = createAccount(repository, "launch-scope-manager");
    const admin = createAccount(repository, "launch-scope-admin", "admin");
    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "launch-scope-venue",
      venueName: "Launch Scope Hotel",
      suburb: "Melbourne",
    });

    const submission = (overrides: Record<string, unknown> = {}) => createSubmissionSchema.parse({
      clientSubmissionId: null,
      missionId: null,
      venueId: "launch-scope-venue",
      venueName: "Launch Scope Hotel",
      suburb: "Melbourne",
      newVenue: null,
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: null,
      sourcePhotoDataUrls: [],
      sourceDocumentDataUrl: null,
      sourcePhotoUrl: null,
      uploadLocation: null,
      notes: null,
      items: [{
        beerName: "Carlton Draught",
        servingSize: "pint",
        price: 9,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
      ...overrides,
    });

    await expect(service.createSubmission(user, submission({
      submissionType: "happy_hour_update",
    }))).rejects.toThrow("Happy-hour contributions are not available");
    await expect(service.createSubmission(user, submission({
      items: [{
        beerName: "Carlton Draught",
        servingSize: "pint",
        price: 9,
        isHappyHourPrice: true,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }))).rejects.toThrow("Happy-hour contributions are not available");
    await expect(service.createSubmission(user, submission({
      items: [{
        beerName: "Carlton Draught",
        servingSize: "pint",
        price: 9,
        isHappyHourPrice: false,
        happyHourDetails: "Weekdays 5pm-7pm",
        isOnTap: "yes",
      }],
    }))).rejects.toThrow("Happy-hour contributions are not available");
    await expect(service.createUserSubmission(user, submission({
      submissionType: "happy_hour_update",
    }))).rejects.toThrow("Happy-hour contributions are not available");

    const internalPayload = submission({
      clientSubmissionId: "manager-happy-hour-replay-1",
      submissionType: "happy_hour_update",
      items: [{
        beerName: "Carlton Draught",
        servingSize: "pint",
        price: 9,
        isHappyHourPrice: true,
        happyHourDetails: "Weekdays 5pm-7pm",
        isOnTap: "yes",
      }],
    });
    const [venueResult, venueReplay] = await Promise.all([
      service.createVenueManagerSubmission(
        repository.getAccountById(manager.id)!,
        "launch-scope-venue",
        internalPayload,
      ),
      service.createVenueManagerSubmission(
        repository.getAccountById(manager.id)!,
        "launch-scope-venue",
        internalPayload,
      ),
    ]);
    expect([Boolean(venueResult.idempotentReplay), Boolean(venueReplay.idempotentReplay)].sort())
      .toEqual([false, true]);
    expect(venueReplay.submission.id).toBe(venueResult.submission.id);
    expect(venueResult.submission).toEqual(expect.objectContaining({
      submissionType: "happy_hour_update",
      userId: manager.id,
      pointsAwarded: 0,
      pointsEligibleByLocation: false,
      pointsEligibilityReason: "venue_manager_not_reward_eligible",
      internalOnly: true,
    }));
    expect(await communitySubmissionRepositories.get(repository)!
      .countCommunityVerificationCandidates(user.id)).toBe(0);
    expect(database.prepare(
      "SELECT count(*) AS count FROM venue_price_records WHERE source_submission_id = ?",
    ).get(venueResult.submission.id)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM contribution_ledger WHERE submission_id = ?",
    ).get(venueResult.submission.id)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM submission_items WHERE submission_id = ?",
    ).get(venueResult.submission.id)).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM venue_happy_hours WHERE venue_id = ?",
    ).get("launch-scope-venue")).toEqual({ count: 0 });

    await service.revokeVenueManager(admin, {
      userId: manager.id,
      venueId: "launch-scope-venue",
    });
    await expect(service.createVenueManagerSubmission(
      repository.getAccountById(manager.id)!,
      "launch-scope-venue",
      { ...internalPayload, clientSubmissionId: "manager-happy-hour-revoked-1" },
    )).rejects.toThrow("Venue manager access required");
    expect(database.prepare(
      "SELECT count(*) AS count FROM submissions WHERE client_submission_id = ?",
    ).get("manager-happy-hour-revoked-1")).toEqual({ count: 0 });

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "launch-scope-venue",
      venueName: "Launch Scope Hotel",
      suburb: "Melbourne",
    });
    const deletionRepository = accountDeletionQueueRepositories.get(repository)!;
    await deletionRepository.createAccountDeletionRequest({
      id: "manager-happy-hour-deletion",
      userId: manager.id,
      userMessage: null,
      requestedAt: NOW,
      executeAfter: new Date(Date.parse(NOW) + 60_000).toISOString(),
    });
    await deletionRepository.beginAccountDeletion({
      requestId: "manager-happy-hour-deletion",
      reviewedBy: admin.id,
      now: new Date(Date.parse(NOW) + 120_000).toISOString(),
      staleBefore: new Date(Date.parse(NOW) - 60_000).toISOString(),
    });
    await expect(service.createVenueManagerSubmission(
      repository.getAccountById(manager.id)!,
      "launch-scope-venue",
      { ...internalPayload, clientSubmissionId: "manager-happy-hour-deletion-1" },
    )).rejects.toThrow("Internal venue submission state changed");
    expect(database.prepare(
      "SELECT count(*) AS count FROM submissions WHERE client_submission_id = ?",
    ).get("manager-happy-hour-deletion-1")).toEqual({ count: 0 });
  });

  it("filters obvious crawler noise out of public price records", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "admin", "admin");
    const insertPriceRecord = database.prepare(
      `INSERT INTO venue_price_records (
        id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, serving_size, price,
        is_happy_hour_price, is_on_tap, confidence, source_type, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pint', ?, 0, 'yes', 'photo_verified', 'source_ingestion', ?, ?, ?)`,
    );

    insertPriceRecord.run("noise-included", "venue-noise", "Noise Bar", "Fitzroy", "INCLUDED YOU'LL FIND *", "included_you_ll_find", 13, NOW, NOW, NOW);
    insertPriceRecord.run("noise-ipa", "venue-noise", "Noise Bar", "Fitzroy", "IPA", "ipa", 14, NOW, NOW, NOW);
    insertPriceRecord.run("good-local", "venue-noise", "Noise Bar", "Fitzroy", "Very Local Hazy Pint", "very_local_hazy_pint", 15, NOW, NOW, NOW);

    expect((await service.listPriceRecords(admin, {
      anonymousSessionId: null,
      limit: 20,
      venueId: "venue-noise",
    })).records.map((record) => record.beerName)).toEqual(["Very Local Hazy Pint"]);
  });

  it("keeps non-preview prices locked for free users while allowing premium, contributor, and admin exact price access", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const submitter = createAccount(repository, "submitter");
    const freeUser = createAccount(repository, "free-user");
    let premiumUser = createAccount(repository, "premium-user");
    let contributor = createAccount(repository, "contributor-user");
    const admin = createAccount(repository, "admin", "admin");
    const first = createSubmission(repository, { id: "submission-1", userId: submitter.id, venueId: "venue-1", price: 12 });
    const second = createSubmission(repository, { id: "submission-2", userId: submitter.id, venueId: "venue-2", beerName: "Asahi Super Dry", price: 17 });

    approve(repository, first.id, admin.id);
    approve(repository, second.id, admin.id);
    premiumUser = updateSubscription(repository, premiumUser.id, "premium_monthly");
    contributor = updateSubscription(repository, contributor.id, "contributor_unlocked", PREMIUM_UNTIL);

    expect((await service.listPriceRecords(freeUser, {
      anonymousSessionId: null,
      limit: 20,
      venueId: "venue-1",
    })).records[0]?.price).toBe(12);
    expect((await service.listPriceRecords(freeUser, {
      anonymousSessionId: null,
      limit: 20,
      venueId: "venue-2",
    })).records[0]?.price).toBeNull();

    expect((await service.listPriceRecords(premiumUser, {
      anonymousSessionId: null,
      limit: 20,
      venueId: "venue-2",
    })).records[0]?.price).toBe(17);
    expect((await service.listPriceRecords(contributor, {
      anonymousSessionId: null,
      limit: 20,
      venueId: "venue-2",
    })).records[0]?.price).toBe(17);
    expect((await service.listPriceRecords(admin, {
      anonymousSessionId: null,
      limit: 20,
      venueId: "venue-2",
    })).records[0]?.price).toBe(17);
  });

  it("includes special-discount details only in the full-access entitlement state", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const freeUser = createAccount(repository, "specials-free-user");
    const premiumUser = updateSubscription(
      repository,
      createAccount(repository, "specials-premium-user").id,
      "premium_monthly",
    );

    expect(service.getAccessState(freeUser, null)).toMatchObject({
      isAuthenticated: true,
      accountRole: "user",
      isAdminAccount: false,
      hasFullAccess: false,
      canViewSpecialDiscounts: false,
      freePreviewScope: "Pint prices for Guinness, Carlton Draught, and Stone & Wood Pacific Ale.",
      premiumScope: "Every verified beer price, value rings, premium filters, saved night shortcuts, discount-pass access, and venue special-discount details.",
      premiumToolkit: expect.objectContaining({
        enabled: false,
        status: "locked",
        lockedCopy: expect.stringContaining("A$4.99/month"),
      }),
    });
    expect(service.getAccessState(premiumUser, null)).toMatchObject({
      hasFullAccess: true,
      canViewSpecialDiscounts: true,
      canUseDiscountPass: true,
      premiumScope: "Every verified beer price, value rings, premium filters, saved night shortcuts, discount-pass access, and venue special-discount details.",
      premiumToolkit: expect.objectContaining({
        enabled: true,
        status: "active",
        summary: expect.stringContaining("value rings"),
      }),
    });
    expect(service.getAccessState(premiumUser, null).premiumToolkit.perks.map((perk) => perk.id)).toContain("savings_tracker");
  });

  it("keeps exact price reads behind the business API in the public viewer", async () => {
    const viewerHtml = fs.readFileSync(path.resolve(process.cwd(), "viewer/index.html"), "utf8");
    const adminHtml = fs.readFileSync(path.resolve(process.cwd(), "viewer/admin.html"), "utf8");
    const legacyMapHtml = fs.readFileSync(path.resolve(process.cwd(), "viewer/google-map.html"), "utf8");

    expect(viewerHtml).not.toContain(".from(\"venue_menu_captures\")");
    expect(viewerHtml).not.toContain("@supabase/supabase-js");
    expect(viewerHtml).not.toContain("supabaseAnonKey");
    expect(viewerHtml).not.toContain("Admin secret");
    expect(viewerHtml).not.toContain("ADMIN_SHARED_SECRET");
    expect(viewerHtml).not.toContain("x-admin-secret");
    expect(viewerHtml).not.toContain("/api/admin");
    expect(viewerHtml).not.toContain("adminPanel");
    expect(viewerHtml).not.toContain("adminSecret");
    expect(viewerHtml).not.toContain("debugToggle");
    expect(viewerHtml).not.toContain("legacy-review");
    expect(viewerHtml).not.toContain("Unlock admin actions");
    expect(viewerHtml).not.toMatch(/<aside[^>]+id="adminPanel"/);
    expect(viewerHtml).not.toMatch(/<button[^>]+id="adminToggle"/);
    expect(viewerHtml).not.toMatch(/<div[^>]+id="debug"/);
    expect(viewerHtml).not.toMatch(/<button[^>]+id="debugToggle"/);
    expect(adminHtml).toMatch(/<div[^>]+id="adminContent" hidden>/);
    expect(adminHtml).toContain("/api/admin/status");
    expect(adminHtml).toContain("/api/admin/captures/manual");
    expect(adminHtml).toContain("/api/admin/ingestions/queue");
    expect(adminHtml).toContain("/api/admin/ingestions/reject");
    expect(adminHtml).toContain('id="rejectVisibleIngestionsButton"');
    expect(adminHtml).toContain("ADMIN_FAST_REJECT_SOURCE_NOTE");
    expect(adminHtml).toContain("id=\"adminBeerRows\"");
    expect(adminHtml).toContain("id=\"pendingBeerCatalog\"");
    expect(adminHtml).toContain("/api/business/admin/beer-catalog");
    expect(adminHtml).toContain("/api/business/admin/beer-catalog/reject-pending");
    expect(adminHtml).toContain('id="rejectPendingBeerCatalogButton"');
    expect(adminHtml).toContain("ADMIN_FAST_REJECT_BEER_NOTE");
    expect(adminHtml).toContain("data-approve-catalog-beer");
    expect(adminHtml).toContain("data-merge-catalog-beer");
    expect(adminHtml).toContain("data-reject-catalog-beer");
    expect(adminHtml).toContain("includeReviewData=true");
    expect(adminHtml).toContain("data-submission-evidence-preview");
    expect(adminHtml).toContain("Captured rows for review");
    expect(adminHtml).toContain("const formElement = event.currentTarget");
    expect(adminHtml).toContain("new FormData(formElement)");
    expect(adminHtml).not.toContain("event.currentTarget.reset()");
    expect(adminHtml).not.toContain("Admin secret");
    expect(adminHtml).not.toContain("Unlock admin actions");
    expect(adminHtml).not.toContain("x-admin-secret");
    expect(legacyMapHtml).not.toContain("Fetching venues from Supabase");
    expect(legacyMapHtml).not.toContain("<div id=\"debug\"");
  });

  it("redacts sensitive production error details from responses and logs", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalConsoleError = console.error;
    const logLines: string[] = [];
    process.env.NODE_ENV = "production";
    console.error = (...args: unknown[]) => {
      logLines.push(args.map((arg) => String(arg)).join(" "));
    };

    const app = express();
    app.get("/boom", () => {
      throw new Error("Stripe key sk_test_supersecret leaked with Bearer abcdefghijk.abcdefghijk.abcdefghijk");
    });
    app.get("/suspended", () => {
      throw new AppError("Account access is suspended.", 403, {
        publicCode: "ACCOUNT_SUSPENDED_BILLING_RECOVERY",
        billingRecoveryEligible: true,
        billingRecoveryConsumer: false,
        billingRecoveryVenues: [{ venueId: "venue-safe", venueName: "Safe Hotel" }],
        internalSecret: "do-not-expose",
      });
    });
    app.use(errorHandler);

    try {
      await withHttpServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/boom`);
        const body = await response.text();
        expect(response.status).toBe(500);
        expect(body).toContain("Internal server error");
        expect(body).not.toContain("sk_test_supersecret");
        expect(body).not.toContain("Bearer abcdefghijk.abcdefghijk.abcdefghijk");

        const suspendedResponse = await fetch(`${baseUrl}/suspended`);
        const suspended = await suspendedResponse.json() as Record<string, any>;
        expect(suspendedResponse.status).toBe(403);
        expect(suspended.error).toEqual(expect.objectContaining({
          code: "ACCOUNT_SUSPENDED_BILLING_RECOVERY",
          recovery: {
            eligible: true,
            endpoint: "/api/business/billing/recovery-portal",
            consumer: false,
            venues: [{ venueId: "venue-safe", venueName: "Safe Hotel" }],
          },
        }));
        expect(JSON.stringify(suspended)).not.toContain("do-not-expose");
      });

      const serializedLogs = logLines.join("\n");
      expect(serializedLogs).not.toContain("sk_test_supersecret");
      expect(serializedLogs).not.toContain("Bearer abcdefghijk.abcdefghijk.abcdefghijk");
      expect(serializedLogs).toContain("[REDACTED]");
    } finally {
      console.error = originalConsoleError;
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it("requires age, terms, and privacy acceptance before local account signup", async () => {
    expect(() => authSignupSchema.parse({
      email: "legal@example.com",
      password: "password123",
      ageConfirmed: true,
      termsAccepted: false,
      privacyAccepted: true,
    })).toThrow("You must accept the Terms and Conditions");

    expect(() => authSignupSchema.parse({
      email: "legal@example.com",
      password: "password123",
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: false,
    })).toThrow("You must accept the Privacy Policy");
  });

  it("requires production admin email verification and MFA step-up", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      ADMIN_EMAILS: "prod-admin@example.com",
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: true,
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
    });
    const admin = createAccount(repository, "prod-admin", "admin");
    const user = createAccount(repository, "prod-user");
    const adminAuthorization = createSession(repository, admin.id, "prod-admin-session-token");
    const userAuthorization = createSession(repository, user.id, "prod-user-session-token");

    await expect(service.requireAdmin(userAuthorization)).rejects.toThrow("Admin access required");
    await expect(service.requireAdmin(undefined)).rejects.toThrow("Login required");
    await expect(service.requireAdmin(adminAuthorization)).rejects.toThrow("Admin email verification");

    repository.updateAccountSecurityClaims({
      userId: admin.id,
      emailVerifiedAt: NOW,
      now: NOW,
    });
    await expect(service.requireAdmin(adminAuthorization)).rejects.toThrow("Admin MFA step-up");

    repository.updateAccountSecurityClaims({
      userId: admin.id,
      mfaLevel: "aal2",
      mfaVerifiedAt: new Date().toISOString(),
      now: NOW,
    });
    expect((await service.requireAdmin(adminAuthorization)).id).toBe(admin.id);
    await expect(service.signup({
      email: "blocked@example.com",
      password: "password123",
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
    })).rejects.toThrow("Password signup is disabled");
  });

  it("allows verified allowlisted production admins without MFA when the field-test flag disables it", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      ADMIN_EMAILS: "field-admin@example.com",
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: false,
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
    });
    const admin = createAccount(repository, "field-admin", "admin");
    const adminAuthorization = createSession(repository, admin.id, "field-admin-session-token");

    await expect(service.requireAdmin(adminAuthorization)).rejects.toThrow("Admin email verification");

    repository.updateAccountSecurityClaims({
      userId: admin.id,
      emailVerifiedAt: NOW,
      now: NOW,
    });

    expect((await service.requireAdmin(adminAuthorization)).id).toBe(admin.id);
  });

  it("revalidates hosted admin factors with Supabase before every production admin authorization", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      ADMIN_EMAILS: "provider-admin@example.com",
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: true,
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "placeholder-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "placeholder-service-role-key",
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
    });
    const admin = createAccount(repository, "provider-admin", "admin");
    repository.linkSupabaseAccount({
      userId: admin.id,
      supabaseUserId: "00000000-0000-4000-8000-000000000401",
      email: admin.email,
      authProvider: "supabase",
      displayName: null,
      avatarUrl: null,
      emailVerifiedAt: NOW,
      mfaLevel: "aal2",
      mfaVerifiedAt: new Date().toISOString(),
      now: NOW,
    });
    const adminAuthorization = createSession(repository, admin.id, "provider-admin-session-token");
    const listFactors = vi.fn(async () => ({
      data: {
        factors: [{ id: "provider-admin-factor", factor_type: "totp", status: "verified" }],
      },
      error: null,
    }));
    (service as unknown as { supabase: unknown }).supabase = {
      auth: { admin: { mfa: { listFactors } } },
    };

    await expect(service.requireAdmin(adminAuthorization)).resolves.toEqual(expect.objectContaining({ id: admin.id }));
    expect(listFactors).toHaveBeenCalledWith({ userId: "00000000-0000-4000-8000-000000000401" });

    listFactors.mockResolvedValueOnce({ data: { factors: [] }, error: null });
    await expect(service.requireAdmin(adminAuthorization)).rejects.toThrow("Admin MFA step-up required");

    listFactors.mockResolvedValueOnce({ data: null, error: { message: "provider unavailable" } });
    await expect(service.requireAdmin(adminAuthorization)).rejects.toMatchObject({ statusCode: 503 });
  });

  it("keeps production admin routes locked until an admin email allowlist is configured", async () => {
    const { repository } = createRepository();
    const serviceWithAllowlist = createBusinessService(repository, {
      NODE_ENV: "production",
      ADMIN_EMAILS: "pending-admin@example.com",
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: true,
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
    });
    const admin = createAccount(repository, "pending-admin", "admin");
    const adminAuthorization = createSession(repository, admin.id, "pending-admin-session-token");
    repository.updateAccountSecurityClaims({
      userId: admin.id,
      emailVerifiedAt: NOW,
      mfaLevel: "aal2",
      mfaVerifiedAt: new Date().toISOString(),
      now: NOW,
    });

    const serviceWithoutAllowlist = createBusinessService(repository, {
      NODE_ENV: "production",
      ADMIN_EMAILS: undefined,
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: true,
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
    });

    await expect(serviceWithoutAllowlist.requireAdmin(adminAuthorization)).rejects.toThrow(
      "Admin access is not configured",
    );
  });

  it("applies current production admin authority to every direct service access path", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      ADMIN_EMAILS: "authority-admin@example.com",
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: true,
      ADMIN_MFA_MAX_AGE_MINUTES: 5,
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-authority-source-evidence-secret-32",
    });
    const admin = createAccount(repository, "authority-admin", "admin");
    const manager = createAccount(repository, "authority-manager");
    const owner = createAccount(repository, "authority-owner");
    repository.updateAccountSecurityClaims({
      userId: admin.id,
      emailVerifiedAt: NOW,
      mfaLevel: "aal2",
      mfaVerifiedAt: NOW,
      now: NOW,
    });
    repository.updateAccountSecurityClaims({ userId: manager.id, emailVerifiedAt: NOW, now: NOW });
    repository.updateAccountSecurityClaims({ userId: owner.id, emailVerifiedAt: NOW, now: NOW });
    const currentAdmin = repository.getAccountById(admin.id)!;

    await service.assignVenueManager(currentAdmin, {
      userId: manager.id,
      venueId: "authority-venue",
      venueName: "Authority Taproom",
      suburb: "Fitzroy",
    });
    await service.upsertBarProfile(currentAdmin, "authority-venue", {
      name: "Authority Taproom",
      address: null,
      suburb: "Fitzroy",
      area: "Fitzroy",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      active: true,
    });
    const submission = (await service.createUserSubmission(repository.getAccountById(owner.id)!, createSubmissionSchema.parse({
      venueId: "authority-venue",
      venueName: "Authority Taproom",
      suburb: "Fitzroy",
      submissionType: "photo_upload",
      observedAt: NOW,
      sourcePhotoDataUrl: PNG_DATA_URL,
      sourcePhotoUrl: null,
      notes: null,
      items: [],
    }))).submission;

    expect((await service.getVenuePortal(currentAdmin, { venueId: "authority-venue" })).selectedVenue?.venueId).toBe("authority-venue");
    expect((await service.getSubmissionSourceEvidenceUrl(currentAdmin, submission.id)).signedUrl).toContain("/source-evidence/");
    expect(await service.listSubmissions(currentAdmin, { mine: false, limit: 10 })).toHaveLength(1);
    expect(service.getAccessState(currentAdmin, null)).toEqual(expect.objectContaining({
      isAdminAccount: true,
      isAdmin: true,
      hasFullAccess: true,
      canViewAllPrices: true,
    }));
    const createValidAdminSession = service as unknown as {
      createSessionResponse(account: BusinessAccount): Promise<{ expiresAt: string }>;
    };
    expect((await createValidAdminSession.createSessionResponse(currentAdmin)).expiresAt).toBe("2026-05-11T08:00:00.000Z");

    const removedAllowlistService = createBusinessService(repository, {
      NODE_ENV: "production",
      ADMIN_EMAILS: undefined,
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: true,
      ADMIN_MFA_MAX_AGE_MINUTES: 5,
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-authority-source-evidence-secret-32",
    });
    expect(await removedAllowlistService.getVenuePortal(currentAdmin, { venueId: "authority-venue" })).toEqual(
      expect.objectContaining({ accessState: "claim_required", isAdmin: false, selectedVenue: null }),
    );
    await expect(removedAllowlistService.upsertBarBeer(currentAdmin, "authority-venue", {
      id: null,
      beerName: "Guinness",
      brewery: null,
      style: "stout",
      abv: 4.2,
      serveSize: "pint",
      price: 14,
      onTap: true,
      inStock: true,
      notes: null,
    })).rejects.toThrow("Venue manager access required");
    await expect(removedAllowlistService.getSubmissionSourceEvidenceUrl(currentAdmin, submission.id))
      .rejects.toThrow("own source evidence");
    expect(await removedAllowlistService.listSubmissions(currentAdmin, { mine: false, limit: 10 })).toEqual([]);
    expect(removedAllowlistService.getAccessState(currentAdmin, null)).toEqual(expect.objectContaining({
      isAdminAccount: true,
      isAdmin: false,
      hasFullAccess: false,
      canViewAllPrices: false,
      premiumToolkit: expect.objectContaining({ enabled: false, status: "locked" }),
    }));
    const createStaleAdminSession = removedAllowlistService as unknown as {
      createSessionResponse(account: BusinessAccount): Promise<{ expiresAt: string }>;
    };
    expect((await createStaleAdminSession.createSessionResponse(currentAdmin)).expiresAt).toBe("2026-07-03T08:00:00.000Z");

    repository.updateAccountSecurityClaims({
      userId: admin.id,
      mfaLevel: "aal2",
      mfaVerifiedAt: "2026-05-03T00:00:00.000Z",
      now: NOW,
    });
    const staleMfaAdmin = repository.getAccountById(admin.id)!;
    expect(await service.getVenuePortal(staleMfaAdmin, { venueId: "authority-venue" })).toEqual(
      expect.objectContaining({ accessState: "claim_required", isAdmin: false, selectedVenue: null }),
    );
    await expect(service.getSubmissionSourceEvidenceUrl(staleMfaAdmin, submission.id)).rejects.toThrow("own source evidence");
    expect(await service.listSubmissions(staleMfaAdmin, { mine: false, limit: 10 })).toEqual([]);
    expect(service.getAccessState(staleMfaAdmin, null)).toEqual(expect.objectContaining({
      isAdminAccount: true,
      isAdmin: false,
      hasFullAccess: false,
      canUseDiscountPass: false,
    }));

    const currentManager = repository.getAccountById(manager.id)!;
    expect((await service.getVenuePortal(currentManager, { venueId: "authority-venue" })).selectedVenue?.venueId).toBe("authority-venue");
    expect((await service.upsertBarBeer(currentManager, "authority-venue", {
      id: null,
      beerName: "Guinness",
      brewery: null,
      style: "stout",
      abv: 4.2,
      serveSize: "pint",
      price: 14,
      onTap: true,
      inStock: true,
      notes: null,
    })).beer).toEqual(expect.objectContaining({ barId: "authority-venue", beerName: "Guinness" }));
  });

  it("live-probes and caches every required Supabase readiness dependency", async () => {
    const { repository } = createRepository();
    const legacyAnonKey = [
      Buffer.from('  {"typ":"JWT","alg":"HS256"}').toString("base64url"),
      Buffer.from('  {"role":"anon"}').toString("base64url"),
      Buffer.alloc(32, 1).toString("base64url"),
    ].join(".");
    const legacyServiceRoleKey = [
      Buffer.from('  {"typ":"JWT","alg":"HS256"}').toString("base64url"),
      Buffer.from('  {"role":"service_role"}').toString("base64url"),
      Buffer.alloc(32, 2).toString("base64url"),
    ].join(".");
    expect(legacyAnonKey.startsWith("eyJ")).toBe(false);
    expect(legacyServiceRoleKey.startsWith("eyJ")).toBe(false);
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/storage/v1/bucket/")) {
        return new Response(JSON.stringify({
          id: "beermap-source-evidence",
          public: false,
          file_size_limit: 8 * 1024 * 1024,
          allowed_mime_types: [
            "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf",
          ],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/rest/v1/pintpath_storage_policy_posture")) {
        return new Response(JSON.stringify([{
          object_policy_count: 0,
          object_rls_enabled: true,
          bucket_policy_count: 0,
          bucket_rls_enabled: true,
          public_bucket_count: 0,
        }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "production");
    try {
      const service = createBusinessService(repository, {
        NODE_ENV: "production",
        DEMO_BILLING_MODE: false,
        COMMERCIAL_LAUNCH_ENABLED: false,
        CONSUMER_PAID_ENROLLMENT_ENABLED: false,
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: legacyAnonKey,
        SUPABASE_SERVICE_ROLE_KEY: legacyServiceRoleKey,
        SOURCE_EVIDENCE_STORAGE_DIR: "/dev/null/pintpath-managed-evidence",
        SOURCE_EVIDENCE_SIGNING_SECRET: "production-readiness-source-evidence-secret-32",
        GOOGLE_PLACES_API_KEY: "google-places-readiness-key",
        OPENAI_API_KEY: "test-openai-api-key", // security-scan allow: synthetic readiness fixture only
      });

      const first = await service.getOperationalReadiness();
      const second = await service.getOperationalReadiness();

      expect(first.ready).toBe(true);
      expect(first.dependencies).toEqual(expect.objectContaining({
        supabaseAuth: expect.objectContaining({ status: "ok", required: true, liveProbe: true }),
        supabaseDatabase: expect.objectContaining({ status: "ok", required: true, liveProbe: true }),
        supabaseEvidenceStorage: expect.objectContaining({ status: "ok", required: true, liveProbe: true }),
        evidenceStorage: { status: "ok" },
        billingProvider: { status: "deferred", required: false },
      }));
      expect(second.dependencies).toEqual(first.dependencies);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining([
        "https://project.supabase.co/auth/v1/health",
        "https://project.supabase.co/rest/v1/venues?select=id&limit=1",
        "https://project.supabase.co/storage/v1/bucket/beermap-source-evidence",
        "https://project.supabase.co/rest/v1/pintpath_storage_policy_posture?select=object_policy_count,object_rls_enabled,bucket_policy_count,bucket_rls_enabled,public_bucket_count&limit=2",
      ]));
      for (const [input, init] of fetchMock.mock.calls) {
        const headers = new Headers(init?.headers);
        const expectedKey = String(input).includes("/auth/v1/") ? legacyAnonKey : legacyServiceRoleKey;
        expect(init?.redirect).toBe("error");
        expect(headers.get("apikey")).toBe(expectedKey);
        expect(headers.get("authorization")).toBe(`Bearer ${expectedKey}`);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["commercial launch", { COMMERCIAL_LAUNCH_ENABLED: true, CONSUMER_PAID_ENROLLMENT_ENABLED: false }],
    ["consumer paid enrollment", { COMMERCIAL_LAUNCH_ENABLED: false, CONSUMER_PAID_ENROLLMENT_ENABLED: true }],
  ])("requires complete Stripe configuration when %s is enabled", async (_label, paidFlags) => {
    const { repository } = createRepository();
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "production");

    const readiness = await createBusinessService(repository, {
      NODE_ENV: "production",
      DEMO_BILLING_MODE: true,
      ...paidFlags,
    }).getOperationalReadiness();

    expect(readiness.ready).toBe(false);
    expect(readiness.dependencies.billingProvider).toEqual({
      status: "missing",
      required: true,
    });
  });

  it("requires Stripe when paid enrollment is enabled in a production-mode staging runtime", async () => {
    const { repository } = createRepository();
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "staging");

    const readiness = await createBusinessService(repository, {
      NODE_ENV: "production",
      COMMERCIAL_LAUNCH_ENABLED: true,
      CONSUMER_PAID_ENROLLMENT_ENABLED: false,
    }).getOperationalReadiness();

    expect(readiness.ready).toBe(false);
    expect(readiness.dependencies.billingProvider).toEqual({
      status: "missing",
      required: true,
    });
    expect(readiness.dependencies.venueLookupProvider.required).toBe(false);
    expect(readiness.dependencies.menuExtractionProvider.required).toBe(false);
  });

  it("keeps deferred commercial providers optional during a Railway staging deletion rehearsal", async () => {
    const { repository } = createRepository();
    const publishableKey = ["sb", "publishable", "deletion_rehearsal_fixture"].join("_");
    const secretKey = ["sb", "secret", "deletion_rehearsal_fixture"].join("_");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/rest/v1/pintpath_storage_policy_posture")) {
        return new Response(JSON.stringify([{
          object_policy_count: 0,
          object_rls_enabled: true,
          bucket_policy_count: 0,
          bucket_rls_enabled: true,
          public_bucket_count: 0,
        }]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(input).includes("/storage/v1/bucket/")) {
        return new Response(JSON.stringify({
          public: false,
          file_size_limit: 8 * 1024 * 1024,
          allowed_mime_types: [
            "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf",
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "staging");

    const readiness = await createBusinessService(repository, {
      NODE_ENV: "production",
      ACCOUNT_DELETION_REHEARSAL_ENABLED: true,
      DEMO_BILLING_MODE: false,
      COMMERCIAL_LAUNCH_ENABLED: false,
      CONSUMER_PAID_ENROLLMENT_ENABLED: false,
      SUPABASE_URL: "https://deletion-staging.supabase.co",
      SUPABASE_ANON_KEY: publishableKey,
      SUPABASE_SERVICE_ROLE_KEY: secretKey,
      GOOGLE_PLACES_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    }).getOperationalReadiness();

    expect(readiness.ready).toBe(true);
    expect(readiness.dependencies.billingProvider).toEqual({
      status: "deferred",
      required: false,
    });
    expect(readiness.dependencies.venueLookupProvider).toEqual({
      status: "missing",
      required: false,
    });
    expect(readiness.dependencies.menuExtractionProvider).toEqual({
      status: "missing",
      required: false,
    });
    expect(readiness.dependencies.accountDeletionNotifications).toEqual(expect.objectContaining({
      status: "operator_attention_required",
      required: true,
    }));
    expect(readiness.dependencies.supabaseDatabase).toEqual(expect.objectContaining({
      status: "ok",
      required: true,
      liveProbe: true,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(
      "https://deletion-staging.supabase.co/rest/v1/profiles?select=id&limit=1",
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(
      "https://deletion-staging.supabase.co/rest/v1/venues?select=id&limit=1",
    );
  });

  it.each([
    ["failed scheduler", "failed", NOW, "scheduler_failed"],
    ["stale scheduler", "succeeded", "2026-05-04T07:00:00.000Z", "scheduler_stale"],
  ])("fails deletion operational readiness for a %s", async (_label, state, updatedAt, reason) => {
    const { repository } = createRepository();
    await systemStateRepositories.get(repository)!.set("job:account_deletion_notifications", { state }, updatedAt);

    const readiness = await createBusinessService(repository, {
      ACCOUNT_DELETION_REHEARSAL_ENABLED: true,
      COMMERCIAL_LAUNCH_ENABLED: false,
      CONSUMER_PAID_ENROLLMENT_ENABLED: false,
    }).getOperationalReadiness();

    expect(readiness.ready).toBe(false);
    expect(readiness.dependencies.accountDeletionNotifications).toEqual(expect.objectContaining({
      required: true,
      operationalGateReady: false,
      operationalBlockingReasons: [reason],
    }));
  });

  it.each([
    ["overdue recipient ciphertext", { overdueRetentionCount: 1 }, "recipient_retention_overdue"],
    [
      "persistent WAL purge checkpoint",
      {
        securePurgeCheckpointPendingCount: 1,
        oldestSecurePurgeCheckpointAt: "2026-05-04T07:00:00.000Z",
      },
      "secure_purge_checkpoint_persistent",
    ],
  ])("fails deletion operational readiness for %s", async (_label, queueOverrides, reason) => {
    const { repository } = createRepository();
    await systemStateRepositories.get(repository)!.set("job:account_deletion_notifications", { state: "succeeded" }, NOW);
    const queueRepository = accountDeletionQueueRepositories.get(repository)!;
    const queueSummary = await queueRepository.getAccountDeletionNotificationQueueSummary(NOW);
    vi.spyOn(queueRepository, "getAccountDeletionNotificationQueueSummary").mockResolvedValue({
      ...queueSummary,
      ...queueOverrides,
    });

    const readiness = await createBusinessService(repository, {
      ACCOUNT_DELETION_REHEARSAL_ENABLED: true,
      COMMERCIAL_LAUNCH_ENABLED: false,
      CONSUMER_PAID_ENROLLMENT_ENABLED: false,
    }).getOperationalReadiness();

    expect(readiness.ready).toBe(false);
    expect(readiness.dependencies.accountDeletionNotifications).toEqual(expect.objectContaining({
      required: true,
      operationalGateReady: false,
      operationalBlockingReasons: [reason],
    }));
  });

  it("keeps manual-review notifications visible but nonfatal to deletion operational readiness", async () => {
    const { repository } = createRepository();
    await systemStateRepositories.get(repository)!.set("job:account_deletion_notifications", { state: "succeeded" }, NOW);
    const queueRepository = accountDeletionQueueRepositories.get(repository)!;
    const queueSummary = await queueRepository.getAccountDeletionNotificationQueueSummary(NOW);
    vi.spyOn(queueRepository, "getAccountDeletionNotificationQueueSummary").mockResolvedValue({
      ...queueSummary,
      manualReviewCount: 1,
    });

    const readiness = await createBusinessService(repository, {
      ACCOUNT_DELETION_REHEARSAL_ENABLED: true,
      COMMERCIAL_LAUNCH_ENABLED: false,
      CONSUMER_PAID_ENROLLMENT_ENABLED: false,
    }).getOperationalReadiness();

    expect(readiness.ready).toBe(true);
    expect(readiness.dependencies.accountDeletionNotifications).toEqual(expect.objectContaining({
      status: "operator_attention_required",
      required: true,
      manualReviewCount: 1,
      operationalGateReady: true,
      operationalBlockingReasons: [],
    }));
  });

  it("keeps local startup readiness restart-safe before the deletion scheduler's first tick", async () => {
    const { repository } = createRepository();
    const startup = await createBusinessService(repository, {
      NODE_ENV: "production",
      ACCOUNT_DELETION_NOTICE_MODE: "resend",
    }).getLocalStartupReadiness();

    expect(startup.ready).toBe(true);
    expect(startup.dependencies.accountDeletionNotifications).toEqual({
      required: true,
      configured: true,
      schedulerState: "not_run",
    });
  });

  it("keeps restore Supabase blocked until independent destination authority exists", async () => {
    const { repository } = createRepository();
    const publishableKey = ["sb", "publishable", "restore_readiness_fixture"].join("_");
    const secretKey = ["sb", "secret", "restore_readiness_fixture"].join("_");
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).includes("/storage/v1/bucket/")) {
        return new Response(JSON.stringify({
          public: false,
          file_size_limit: 8 * 1024 * 1024,
          allowed_mime_types: [
            "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf",
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const service = createBusinessService(repository, {
        NODE_ENV: "production",
        RESTORE_REHEARSAL_MODE: true,
        DEMO_BILLING_MODE: false,
        SUPABASE_URL: "https://attacker.invalid",
        SUPABASE_ANON_KEY: publishableKey,
        SUPABASE_SERVICE_ROLE_KEY: secretKey,
        GOOGLE_PLACES_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      });

      const readiness = await service.getOperationalReadiness();
      const directory = await service.listVenuesPage(undefined, 20, 0);

      expect(readiness.ready).toBe(false);
      expect(readiness.dependencies.supabaseDatabase).toEqual(expect.objectContaining({
        status: "required_unconfigured",
        required: true,
        liveProbe: false,
      }));
      expect(readiness.dependencies.supabaseAuth).toEqual(expect.objectContaining({
        status: "required_unconfigured",
        required: true,
        liveProbe: false,
      }));
      expect(readiness.dependencies.supabaseEvidenceStorage).toEqual(expect.objectContaining({
        status: "required_unconfigured",
        required: true,
        liveProbe: false,
      }));
      expect(readiness.dependencies.billingProvider).toEqual({
        status: "disabled_for_restore_rehearsal",
        required: false,
      });
      expect(readiness.dependencies.venueLookupProvider).toEqual({
        status: "disabled_for_restore_rehearsal",
        required: false,
      });
      expect(readiness.dependencies.menuExtractionProvider).toEqual({
        status: "disabled_for_restore_rehearsal",
        required: false,
      });
      expect(readiness.dependencies.restoreRehearsal).toEqual({
        enabled: true,
        externalWritesAllowed: false,
        httpMutationRoutesAllowed: false,
        runtimeDatabase: "read_only_attested_restored_copy",
        remoteVenueDirectoryEnabled: false,
      });
      expect(directory.venues).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("live-probes configured Supabase dependencies during production field testing", async () => {
    const { repository } = createRepository();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const readiness = await createBusinessService(repository, {
        NODE_ENV: "production",
        FIELD_TEST_MODE: true,
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "supabase-anon-field-test-key",
        SUPABASE_SERVICE_ROLE_KEY: "supabase-service-field-test-key",
        SOURCE_EVIDENCE_SIGNING_SECRET: "production-readiness-source-evidence-secret-32",
        GOOGLE_PLACES_API_KEY: "google-places-readiness-key",
        OPENAI_API_KEY: "test-openai-api-key", // security-scan allow: synthetic readiness fixture only
      }).getOperationalReadiness();

      expect(readiness.ready).toBe(false);
      expect(readiness.dependencies.supabaseAuth).toEqual(expect.objectContaining({
        status: "failed",
        required: false,
        liveProbe: true,
        error: "http_503",
      }));
      expect(readiness.dependencies.supabaseDatabase).toEqual(expect.objectContaining({
        status: "failed",
        required: false,
        liveProbe: true,
      }));
      expect(readiness.dependencies.supabaseEvidenceStorage).toEqual(expect.objectContaining({
        status: "failed",
        required: false,
        liveProbe: true,
      }));
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    [
      "an object policy",
      JSON.stringify([{ object_policy_count: 1, object_rls_enabled: true, bucket_policy_count: 0, bucket_rls_enabled: true, public_bucket_count: 0 }]),
      200,
      "storage_browser_policy_present",
    ],
    [
      "a bucket policy",
      JSON.stringify([{ object_policy_count: 0, object_rls_enabled: true, bucket_policy_count: 1, bucket_rls_enabled: true, public_bucket_count: 0 }]),
      200,
      "storage_browser_policy_present",
    ],
    [
      "disabled object RLS",
      JSON.stringify([{ object_policy_count: 0, object_rls_enabled: false, bucket_policy_count: 0, bucket_rls_enabled: true, public_bucket_count: 0 }]),
      200,
      "storage_rls_disabled",
    ],
    [
      "disabled bucket RLS",
      JSON.stringify([{ object_policy_count: 0, object_rls_enabled: true, bucket_policy_count: 0, bucket_rls_enabled: false, public_bucket_count: 0 }]),
      200,
      "storage_rls_disabled",
    ],
    [
      "a public bucket",
      JSON.stringify([{ object_policy_count: 0, object_rls_enabled: true, bucket_policy_count: 0, bucket_rls_enabled: true, public_bucket_count: 1 }]),
      200,
      "storage_public_bucket_present",
    ],
    ["an empty result", "[]", 200, "invalid_storage_policy_posture"],
    [
      "multiple rows",
      JSON.stringify([
        { object_policy_count: 0, object_rls_enabled: true, bucket_policy_count: 0, bucket_rls_enabled: true, public_bucket_count: 0 },
        { object_policy_count: 0, object_rls_enabled: true, bucket_policy_count: 0, bucket_rls_enabled: true, public_bucket_count: 0 },
      ]),
      200,
      "invalid_storage_policy_posture",
    ],
    ["a null row", "[null]", 200, "invalid_storage_policy_posture"],
    [
      "a missing field",
      JSON.stringify([{ object_policy_count: 0, object_rls_enabled: true, bucket_policy_count: 0, public_bucket_count: 0 }]),
      200,
      "invalid_storage_policy_posture",
    ],
    [
      "an extra field",
      JSON.stringify([{ object_policy_count: 0, object_rls_enabled: true, bucket_policy_count: 0, bucket_rls_enabled: true, public_bucket_count: 0, policy_name: "hidden" }]),
      200,
      "invalid_storage_policy_posture",
    ],
    [
      "a string count",
      JSON.stringify([{ object_policy_count: "0", object_rls_enabled: true, bucket_policy_count: 0, bucket_rls_enabled: true, public_bucket_count: 0 }]),
      200,
      "invalid_storage_policy_posture",
    ],
    [
      "a fractional count",
      JSON.stringify([{ object_policy_count: 0.5, object_rls_enabled: true, bucket_policy_count: 0, bucket_rls_enabled: true, public_bucket_count: 0 }]),
      200,
      "invalid_storage_policy_posture",
    ],
    [
      "a negative count",
      JSON.stringify([{ object_policy_count: 0, object_rls_enabled: true, bucket_policy_count: -1, bucket_rls_enabled: true, public_bucket_count: 0 }]),
      200,
      "invalid_storage_policy_posture",
    ],
    [
      "an unsafe count",
      JSON.stringify([{ object_policy_count: 9_007_199_254_740_992, object_rls_enabled: true, bucket_policy_count: 0, bucket_rls_enabled: true, public_bucket_count: 0 }]),
      200,
      "invalid_storage_policy_posture",
    ],
    [
      "a non-boolean RLS flag",
      JSON.stringify([{ object_policy_count: 0, object_rls_enabled: true, bucket_policy_count: 0, bucket_rls_enabled: "true", public_bucket_count: 0 }]),
      200,
      "invalid_storage_policy_posture",
    ],
    ["malformed JSON", "{", 200, "invalid_storage_policy_posture"],
    ["an HTTP failure", "{}", 503, "http_503"],
  ] as const)("fails Supabase readiness when Storage posture reports %s", async (_label, body, status, error) => {
    const { repository } = createRepository();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/rest/v1/pintpath_storage_policy_posture")) {
        return new Response(body, { status, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/storage/v1/bucket/")) {
        return new Response(JSON.stringify({
          public: false,
          file_size_limit: 8 * 1024 * 1024,
          allowed_mime_types: [
            "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf",
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const readiness = await createBusinessService(repository, {
      NODE_ENV: "production",
      DEMO_BILLING_MODE: false,
      COMMERCIAL_LAUNCH_ENABLED: false,
      CONSUMER_PAID_ENROLLMENT_ENABLED: false,
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "supabase-anon-posture-key",
      SUPABASE_SERVICE_ROLE_KEY: "supabase-service-posture-key",
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-readiness-source-evidence-secret-32",
      GOOGLE_PLACES_API_KEY: "google-places-readiness-key",
      OPENAI_API_KEY: "test-openai-api-key", // security-scan allow: synthetic readiness fixture only
    }).getOperationalReadiness();

    expect(readiness.ready).toBe(false);
    expect(readiness.dependencies.supabaseEvidenceStorage).toEqual(expect.objectContaining({
      status: "failed",
      required: true,
      liveProbe: true,
      error,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(readiness)).not.toContain("hidden");
  });

  it("bounds Storage posture body parsing and retries after the failed readiness cache expires", async () => {
    const { repository } = createRepository();
    let stallPostureBody = true;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/rest/v1/pintpath_storage_policy_posture")) {
        if (!stallPostureBody) {
          return new Response(JSON.stringify([{
            object_policy_count: 0,
            object_rls_enabled: true,
            bucket_policy_count: 0,
            bucket_rls_enabled: true,
            public_bucket_count: 0,
          }]), { status: 200, headers: { "content-type": "application/json" } });
        }
        return {
          ok: true,
          status: 200,
          json: () => new Promise((_resolve, reject) => {
            const rejectAbort = () => {
              const abortError = new Error("posture body timed out");
              abortError.name = "AbortError";
              reject(abortError);
            };
            if (init?.signal?.aborted) rejectAbort();
            else init?.signal?.addEventListener("abort", rejectAbort, { once: true });
          }),
        } as Response;
      }
      if (url.includes("/storage/v1/bucket/")) {
        return new Response(JSON.stringify({
          public: false,
          file_size_limit: 8 * 1024 * 1024,
          allowed_mime_types: [
            "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf",
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      DEMO_BILLING_MODE: false,
      COMMERCIAL_LAUNCH_ENABLED: false,
      CONSUMER_PAID_ENROLLMENT_ENABLED: false,
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "supabase-anon-posture-key",
      SUPABASE_SERVICE_ROLE_KEY: "supabase-service-posture-key",
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-readiness-source-evidence-secret-32",
      GOOGLE_PLACES_API_KEY: "google-places-readiness-key",
      OPENAI_API_KEY: "test-openai-api-key", // security-scan allow: synthetic readiness fixture only
    });

    const stalledReadiness = service.getOperationalReadiness();
    await vi.advanceTimersByTimeAsync(2_501);
    const timedOut = await stalledReadiness;
    expect(timedOut.dependencies.supabaseEvidenceStorage).toEqual(expect.objectContaining({
      status: "failed",
      error: "timeout",
    }));

    stallPostureBody = false;
    await vi.advanceTimersByTimeAsync(15_001);
    const recovered = await service.getOperationalReadiness();
    expect(recovered.dependencies.supabaseEvidenceStorage).toEqual(expect.objectContaining({
      status: "ok",
    }));
  });

  it("fails Supabase readiness on a public evidence bucket or a bounded probe timeout without leaking secrets", async () => {
    const { repository } = createRepository();
    const config = {
      NODE_ENV: "production" as const,
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "supabase-anon-secret-value",
      SUPABASE_SERVICE_ROLE_KEY: "supabase-service-secret-value",
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-readiness-source-evidence-secret-32",
    };
    const withBucketResponse = (bucket: unknown) => vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/storage/v1/bucket/")) {
        return new Response(JSON.stringify(bucket), { status: 200 });
      }
      if (url.includes("/rest/v1/pintpath_storage_policy_posture")) {
        return new Response(JSON.stringify([{
          object_policy_count: 0,
          object_rls_enabled: true,
          bucket_policy_count: 0,
          bucket_rls_enabled: true,
          public_bucket_count: 0,
        }]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", withBucketResponse({ public: true }));
    try {
      const publicBucketReadiness = await createBusinessService(repository, config).getOperationalReadiness();
      expect(publicBucketReadiness.ready).toBe(false);
      expect(publicBucketReadiness.dependencies.supabaseEvidenceStorage).toEqual(expect.objectContaining({
        status: "failed",
        error: "bucket_not_private",
      }));

      vi.stubGlobal("fetch", withBucketResponse({
        public: false,
        file_size_limit: 6 * 1024 * 1024,
        allowed_mime_types: ["image/jpeg", "image/png"],
      }));
      const undersizedReadiness = await createBusinessService(repository, config).getOperationalReadiness();
      expect(undersizedReadiness.dependencies.supabaseEvidenceStorage).toEqual(expect.objectContaining({
        status: "failed",
        error: "bucket_size_limit_too_small",
      }));

      vi.stubGlobal("fetch", withBucketResponse({
        public: false,
        file_size_limit: 8 * 1024 * 1024,
        allowed_mime_types: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
      }));
      const missingPdfReadiness = await createBusinessService(repository, config).getOperationalReadiness();
      expect(missingPdfReadiness.dependencies.supabaseEvidenceStorage).toEqual(expect.objectContaining({
        status: "failed",
        error: "bucket_mime_types_incomplete",
      }));
    } finally {
      vi.unstubAllGlobals();
    }

    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("supabase-service-secret-value timed out");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      })));
    try {
      const readinessPromise = createBusinessService(repository, config).getOperationalReadiness();
      await vi.advanceTimersByTimeAsync(2_501);
      const timeoutReadiness = await readinessPromise;
      expect(timeoutReadiness.ready).toBe(false);
      expect(timeoutReadiness.dependencies.supabaseAuth).toEqual(expect.objectContaining({ status: "failed", error: "timeout" }));
      expect(JSON.stringify(timeoutReadiness)).not.toContain("secret-value");
      expect(JSON.stringify(timeoutReadiness)).not.toContain("project.supabase.co");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("blocks production uploads and verifications until email verification is recorded", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
    });
    const uploader = createAccount(repository, "prod-upload");
    const verifier = createAccount(repository, "prod-verifier");
    await expect(service.createSubmission(uploader, createSubmissionSchema.parse({
      venueId: "venue-prod",
      venueName: "Prod Venue",
      suburb: "Melbourne",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: null,
      sourcePhotoUrl: null,
      notes: null,
      items: [{
        beerName: "Guinness",
        servingSize: "pint",
        price: 12,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
        confidence: 0.8,
      }],
    }))).rejects.toThrow("Verify your email");

    const verifiedUploader = repository.updateAccountSecurityClaims({
      userId: uploader.id,
      emailVerifiedAt: NOW,
      now: NOW,
    });
    const submission = (await service.createSubmission(verifiedUploader, createSubmissionSchema.parse({
      venueId: "venue-prod",
      venueName: "Prod Venue",
      suburb: "Melbourne",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: null,
      sourcePhotoUrl: null,
      notes: null,
      items: [{
        beerName: "Guinness",
        servingSize: "pint",
        price: 12,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
        confidence: 0.8,
      }],
    }))).submission;

    await expect(service.verifySubmission(verifier, submission.id, { result: "confirmed", notes: null }))
      .rejects.toThrow("Verify your email");

    const verifiedVerifier = repository.updateAccountSecurityClaims({
      userId: verifier.id,
      emailVerifiedAt: NOW,
      now: NOW,
    });
    expect((await service.verifySubmission(verifiedVerifier, submission.id, { result: "confirmed", notes: null })).verification.uploadId)
      .toBe(submission.id);
  });

  it("validates source photo type and size before storing demo uploads", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "photo-user");
    const baseSubmission = {
      venueId: "venue-photo",
      venueName: "Photo Bar",
      suburb: "Melbourne",
      submissionType: "photo_upload" as const,
      observedAt: NOW,
      sourcePhotoUrl: null,
      notes: null,
      items: [],
    };

    await expect(service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoDataUrl: "data:image/gif;base64,abc",
    }))).rejects.toThrow("Upload must be a JPEG");

    await expect(service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoDataUrl: `data:image/png;base64,${Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64")}`,
    }))).rejects.toThrow("safe image file");

    await expect(service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoDataUrl: `data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64")}`,
    }))).rejects.toThrow("does not match");

    const oversizedImage = `data:image/png;base64,${Buffer.alloc((6 * 1024 * 1024) + 64).toString("base64")}`;
    await expect(service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoDataUrl: oversizedImage,
    }))).rejects.toThrow("6MB or smaller");

    const storedPng = (await service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      venueId: "venue-photo-valid",
      sourcePhotoDataUrl: PNG_DATA_URL,
    }))).submission.sourcePhotoUrl;
    expect(storedPng).toMatch(/^private:evidence:/);

    const storedWebp = (await service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      venueId: "venue-photo-webp",
      sourcePhotoDataUrl: WEBP_DATA_URL,
    }))).submission.sourcePhotoUrl;
    expect(storedWebp).toMatch(/^private:evidence:/);

    const verifiedProductionUser = repository.updateAccountSecurityClaims({
      userId: user.id,
      emailVerifiedAt: NOW,
      now: NOW,
    });
    const productionFileService = createBusinessService(repository, {
      NODE_ENV: "production",
      ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: false,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
    });
    const productionStored = (await productionFileService.createUserSubmission(
      verifiedProductionUser,
      createSubmissionSchema.parse({
        ...baseSubmission,
        venueId: "venue-photo-prod-file",
        sourcePhotoDataUrl: PNG_DATA_URL,
      }),
    )).submission;
    expect(productionStored.sourcePhotoUrl).toMatch(/^private:evidence:/);
    const productionEvidenceId = productionStored.sourcePhotoUrl!.replace("private:evidence:", "");
    const productionEvidence = (await getSourceEvidenceObjectRepository(repository)
      .getSourceEvidenceObject(productionEvidenceId))!;
    expect(productionEvidence.storageProvider).toBe("filesystem_private");
    expect(productionEvidence.dataBase64).toBeNull();
    expect(await productionFileService.getSourceEvidenceDelivery(productionEvidence)).toMatchObject({
      kind: "bytes",
      mimeType: "image/png",
    });

    const supabaseObjects = new Map<string, Buffer>();
    const supabaseContentTypes = new Map<string, string>();
    const supabaseUpload = vi.fn(async (
      objectPath: string,
      bytes: Buffer,
      options?: { contentType?: string },
    ) => {
      supabaseObjects.set(objectPath, Buffer.from(bytes));
      if (options?.contentType) supabaseContentTypes.set(objectPath, options.contentType);
      return { data: { path: objectPath }, error: null };
    });
    const supabaseStorageClient = {
      storage: {
        from: () => ({
          upload: supabaseUpload,
          download: vi.fn(async (objectPath: string) => ({
            data: supabaseObjects.has(objectPath) ? new Blob([supabaseObjects.get(objectPath)!]) : null,
            error: supabaseObjects.has(objectPath) ? null : { message: "missing" },
          })),
          remove: vi.fn(async (objectPaths: string[]) => {
            objectPaths.forEach((objectPath) => supabaseObjects.delete(objectPath));
            return { data: [], error: null };
          }),
        }),
      },
    } as unknown as ConstructorParameters<typeof BusinessService>[32];
    const productionSupabaseService = createBusinessService(repository, {
      NODE_ENV: "production",
      ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: false,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
    }, undefined, supabaseStorageClient);
    const supabaseStored = (await productionSupabaseService.createUserSubmission(
      verifiedProductionUser,
      createSubmissionSchema.parse({
        ...baseSubmission,
        venueId: "venue-photo-prod-supabase",
        sourcePhotoDataUrl: PNG_DATA_URL,
      }),
    )).submission;
    const supabaseEvidenceId = supabaseStored.sourcePhotoUrl!.replace("private:evidence:", "");
    const supabaseEvidence = (await getSourceEvidenceObjectRepository(repository)
      .getSourceEvidenceObject(supabaseEvidenceId))!;
    expect(supabaseEvidence.storageProvider).toBe("supabase_private");
    expect(supabaseEvidence.dataBase64).toBeNull();
    expect(supabaseObjects.get(supabaseEvidence.objectPath)).toEqual(Buffer.from(PNG_DATA_URL.split(",")[1]!, "base64"));
    expect(await productionSupabaseService.getSourceEvidenceDelivery(supabaseEvidence)).toMatchObject({
      kind: "bytes",
      mimeType: "image/png",
    });

    const supabasePdfStored = (await productionSupabaseService.createUserSubmission(
      verifiedProductionUser,
      createSubmissionSchema.parse({
        ...baseSubmission,
        venueId: "venue-pdf-prod-supabase",
        sourcePhotoDataUrl: null,
        sourceDocumentDataUrl: PDF_DATA_URL,
      }),
    )).submission;
    const supabasePdfEvidence = (await getSourceEvidenceObjectRepository(repository).getSourceEvidenceObject(
      supabasePdfStored.sourcePhotoUrl!.replace("private:evidence:", ""),
    ))!;
    expect(supabasePdfEvidence).toEqual(expect.objectContaining({
      storageProvider: "supabase_private",
      mimeType: "application/pdf",
    }));
    expect(supabaseContentTypes.get(supabasePdfEvidence.objectPath)).toBe("application/pdf");
    expect(supabaseObjects.get(supabasePdfEvidence.objectPath)?.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    const productionOverrideService = createBusinessService(repository, {
      NODE_ENV: "production",
      ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
    });
    expect((await productionOverrideService.createSubmission(
      verifiedProductionUser,
      createSubmissionSchema.parse({
        ...baseSubmission,
        venueId: "venue-photo-prod-override",
        sourcePhotoDataUrl: PNG_DATA_URL,
      }),
    )).submission.sourcePhotoUrl).toMatch(/^private:evidence:/);
  });

  it("removes a filesystem evidence object when its metadata insert fails", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: false,
    });
    const user = createAccount(repository, "filesystem-compensation-user");
    const root = (service as unknown as { config: { SOURCE_EVIDENCE_STORAGE_DIR: string } })
      .config.SOURCE_EVIDENCE_STORAGE_DIR;
    const sourceEvidenceObjectRepository = getSourceEvidenceObjectRepository(repository);
    vi.spyOn(sourceEvidenceObjectRepository, "registerSourceEvidenceObject")
      .mockRejectedValueOnce(new Error("forced metadata failure"));

    await expect((service as unknown as {
      createFilesystemSourceEvidence: (
        account: BusinessAccount,
        bytes: Buffer,
        mimeType: string,
      ) => Promise<unknown>;
    }).createFilesystemSourceEvidence(user, Buffer.from(PNG_DATA_URL.split(",")[1]!, "base64"), "image/png"))
      .rejects.toThrow("forced metadata failure");
    const files = fs.existsSync(root)
      ? fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    expect(files).toHaveLength(0);
  });

  it("compensates every earlier evidence object when a later file in the same submission fails", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: false,
    });
    const user = repository.updateAccountSecurityClaims({
      userId: createAccount(repository, "multi-evidence-compensation-user").id,
      emailVerifiedAt: NOW,
      now: NOW,
    });
    const root = (service as unknown as { config: { SOURCE_EVIDENCE_STORAGE_DIR: string } })
      .config.SOURCE_EVIDENCE_STORAGE_DIR;
    const sourceEvidenceObjectRepository = getSourceEvidenceObjectRepository(repository);
    const originalCreate = sourceEvidenceObjectRepository.registerSourceEvidenceObject
      .bind(sourceEvidenceObjectRepository);
    let metadataInsertCount = 0;
    vi.spyOn(sourceEvidenceObjectRepository, "registerSourceEvidenceObject").mockImplementation(async (input) => {
      metadataInsertCount += 1;
      if (metadataInsertCount === 2) throw new Error("forced second metadata failure");
      return originalCreate(input);
    });

    try {
      await expect(service.createUserSubmission(user, createSubmissionSchema.parse({
        clientSubmissionId: "multi-evidence-compensation-1",
        venueId: "venue-multi-evidence-compensation",
        venueName: "Evidence Compensation Bar",
        suburb: "Melbourne",
        submissionType: "photo_upload",
        observedAt: NOW,
        sourcePhotoDataUrl: null,
        sourcePhotoDataUrls: [PNG_DATA_URL, WEBP_DATA_URL],
        sourcePhotoUrl: null,
        notes: null,
        items: [],
    }))).rejects.toThrow("forced second metadata failure");
    } finally {
      vi.mocked(sourceEvidenceObjectRepository.registerSourceEvidenceObject).mockRestore();
    }

    const files = fs.existsSync(root)
      ? fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    expect(metadataInsertCount).toBe(2);
    await expect(sourceEvidenceRetentionRepositories.get(repository)!.listSourceEvidenceForOwner({
      ownerUserId: user.id,
      limit: 500,
    })).resolves.toHaveLength(0);
    expect(databaseRowsForOwner(repositoryDatabases.get(repository)!, user.id)).toEqual([
      expect.objectContaining({
        storage_provider: "filesystem_private",
        object_path: expect.stringMatching(/^evidence\//),
        data_base64: null,
        external_url: null,
        byte_size: null,
        deleted_at: NOW,
      }),
    ]);
    expect(files).toHaveLength(0);
    expect(repository.listSubmissions({ userId: user.id, limit: 10 })).toHaveLength(0);
  });

  it("removes loser evidence when an idempotent submission wins between upload and insert", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: false,
    });
    const user = repository.updateAccountSecurityClaims({
      userId: createAccount(repository, "idempotent-evidence-compensation-user").id,
      emailVerifiedAt: NOW,
      now: NOW,
    });
    const root = (service as unknown as { config: { SOURCE_EVIDENCE_STORAGE_DIR: string } })
      .config.SOURCE_EVIDENCE_STORAGE_DIR;
    const clientSubmissionId = "idempotent-evidence-compensation-1";
    const existing = (await service.createSubmission(user, createSubmissionSchema.parse({
      clientSubmissionId,
      venueId: "venue-idempotent-evidence-compensation",
      venueName: "Idempotent Evidence Bar",
      suburb: "Melbourne",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: null,
      sourcePhotoUrl: null,
      notes: null,
      items: [{
        beerName: "Guinness",
        servingSize: "pint",
        price: 14,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }))).submission;
    const communityRepository = communitySubmissionRepositories.get(repository)!;
    const originalGet = communityRepository.getSubmissionByClientSubmissionId.bind(communityRepository);
    let idempotencyLookupCount = 0;
    communityRepository.getSubmissionByClientSubmissionId = (async (userId, id) => {
      idempotencyLookupCount += 1;
      return idempotencyLookupCount === 1 ? null : originalGet(userId, id);
    }) as typeof communityRepository.getSubmissionByClientSubmissionId;

    let replay;
    try {
      replay = await service.createUserSubmission(user, createSubmissionSchema.parse({
        clientSubmissionId,
        venueId: "venue-idempotent-evidence-compensation",
        venueName: "Idempotent Evidence Bar",
        suburb: "Melbourne",
        submissionType: "photo_upload",
        observedAt: NOW,
        sourcePhotoDataUrl: PNG_DATA_URL,
        sourcePhotoUrl: null,
        notes: null,
        items: [],
      }));
    } finally {
      communityRepository.getSubmissionByClientSubmissionId = originalGet;
    }

    const files = fs.existsSync(root)
      ? fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    expect(replay).toEqual(expect.objectContaining({
      idempotentReplay: true,
      submission: expect.objectContaining({ id: existing.id }),
    }));
    expect(idempotencyLookupCount).toBeGreaterThanOrEqual(2);
    await expect(sourceEvidenceRetentionRepositories.get(repository)!.listSourceEvidenceForOwner({
      ownerUserId: user.id,
      limit: 500,
    })).resolves.toHaveLength(0);
    expect(databaseRowsForOwner(repositoryDatabases.get(repository)!, user.id)).toEqual([
      expect.objectContaining({
        storage_provider: "filesystem_private",
        object_path: expect.stringMatching(/^evidence\//),
        data_base64: null,
        external_url: null,
        byte_size: null,
        deleted_at: NOW,
      }),
    ]);
    expect(files).toHaveLength(0);
    expect(repository.listSubmissions({ userId: user.id, limit: 10 })).toHaveLength(1);
  });

  it("rejects unsafe external source URLs before review storage", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "url-source-user");
    const baseSubmission = {
      venueId: "venue-url",
      venueName: "URL Source Bar",
      suburb: "Melbourne",
      submissionType: "photo_upload" as const,
      observedAt: NOW,
      sourcePhotoDataUrl: null,
      notes: null,
      items: [],
    };

    await expect(service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoUrl: "javascript:alert(1)",
    }))).rejects.toThrow("HTTP or HTTPS");
    await expect(service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoUrl: "https://example.com/menu.svg",
    }))).rejects.toThrow("safe image source");

    await expect(service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoUrl: "https://example.com/menu-photo.jpg",
    }))).rejects.toThrow("upload the source image directly");
  });

  it("requires an independent admin review and derives confidence instead of trusting the request", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "admin", "admin");
    const otherAdmin = createAccount(repository, "other-admin", "admin");
    const ownSubmission = createSubmission(repository, {
      id: "own-admin-submission",
      userId: admin.id,
      venueId: "venue-own",
    });
    const submission = createSubmission(repository, {
      id: "reviewed-submission",
      userId: createAccount(repository, "submitter").id,
      venueId: "venue-reviewed",
    });
    const approvePayload = {
      status: "approved" as const,
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "community_confirmed" as const,
    };

    expect(reviewSubmissionSchema.parse(approvePayload)).not.toHaveProperty("confidence");
    await expect(service.reviewSubmission(admin, ownSubmission.id, approvePayload))
      .rejects.toThrow("Admins cannot review their own submissions");

    const ownReview = await service.reviewSubmission(otherAdmin, ownSubmission.id, approvePayload);
    expect(ownReview.submission.status).toBe("approved");
    expect(ownReview.submission.reviewedBy).toBe(otherAdmin.id);

    await service.reviewSubmission(admin, submission.id, approvePayload);
    await expect(service.reviewSubmission(otherAdmin, submission.id, approvePayload))
      .rejects.toThrow("Submission has already been reviewed");
    const auditLogs = await listSecurityAuditLogs(repository, 10);
    expect(auditLogs.some((log) =>
      log.action === "admin_submission_review" &&
      log.actorUserId === admin.id &&
      log.targetId === submission.id,
    )).toBe(true);
    expect(auditLogs.some((log) =>
      log.action === "admin_submission_review" &&
      log.actorUserId === otherAdmin.id &&
      log.targetId === ownSubmission.id,
    )).toBe(true);
    expect(database.prepare(
      "SELECT confidence FROM venue_price_records WHERE source_submission_id = ?",
    ).get(ownSubmission.id)).toEqual({ confidence: "photo_verified" });
  });

  it("serializes concurrent service approvals into one public effect", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const submitter = createAccount(repository, "concurrent-review-submitter");
    const firstAdmin = createAccount(repository, "concurrent-review-admin-a", "admin");
    const secondAdmin = createAccount(repository, "concurrent-review-admin-b", "admin");
    const submission = createSubmission(repository, {
      id: "concurrent-review-submission",
      userId: submitter.id,
      venueId: "concurrent-review-venue",
      beerName: "Guinness",
    });
    const review = {
      status: "approved" as const,
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "admin_verified" as const,
    };

    const results = await Promise.allSettled([
      service.reviewSubmission(firstAdmin, submission.id, review),
      service.reviewSubmission(secondAdmin, submission.id, review),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(database.prepare(
      "SELECT count(*) AS count FROM venue_price_records WHERE source_submission_id = ?",
    ).get(submission.id)).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM security_audit_log WHERE action = 'community_submission_approved' AND target_id = ?",
    ).get(submission.id)).toEqual({ count: 1 });
    expect(repository.getSubmissionById(submission.id)?.submission.status).toBe("approved");
    expect(repository.getAccountById(submitter.id)?.approvedSubmissionCount).toBe(1);
  });

  it("surfaces an approval failure only after the Community transaction rolls every public effect back", async () => {
    const { database, repository } = createRepository();
    const failingRepository = new CommunitySubmissionRepository(getAsyncDatabase(database), {
      allowApprovalFailureInjection: true,
    });
    const approveAndPublish = failingRepository.approveAndPublishSubmission.bind(failingRepository);
    failingRepository.approveAndPublishSubmission = ((input) => approveAndPublish({
      ...input,
      failureInjection: "before_finalize",
    })) as typeof failingRepository.approveAndPublishSubmission;
    communitySubmissionRepositories.set(repository, failingRepository);
    const service = createBusinessService(repository);
    const submitter = createAccount(repository, "rollback-review-submitter");
    const admin = createAccount(repository, "rollback-review-admin", "admin");
    const submission = createSubmission(repository, {
      id: "rollback-review-submission",
      userId: submitter.id,
      venueId: "rollback-review-venue",
      beerName: "Guinness",
    });

    await expect(service.reviewSubmission(admin, submission.id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "admin_verified",
    })).rejects.toThrow("Community submission persistence failed");

    expect(repository.getSubmissionById(submission.id)?.submission).toEqual(expect.objectContaining({
      status: "pending",
      reviewedBy: null,
      reviewedAt: null,
    }));
    expect(database.prepare(
      "SELECT count(*) AS count FROM venue_price_records WHERE source_submission_id = ?",
    ).get(submission.id)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM contribution_ledger WHERE submission_id = ?",
    ).get(submission.id)).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM security_audit_log WHERE action = 'community_submission_approved' AND target_id = ?",
    ).get(submission.id)).toEqual({ count: 0 });
    expect(repository.getAccountById(submitter.id)?.approvedSubmissionCount).toBe(0);
  });

  it("keeps manually-created new venues and beer rows pending until admin approval", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const uploader = createAccount(repository, "new-venue-uploader");
    const admin = createAccount(repository, "new-venue-admin", "admin");
    const venueId = "venue-user-requested";
    const payload = createSubmissionSchema.parse({
      venueId,
      venueName: "Moonlit Taproom",
      suburb: "Fitzroy",
      newVenue: {
        name: "Moonlit Taproom",
        address: "10 Test Lane",
        suburb: "Fitzroy",
        state: "VIC",
        postcode: null,
        phone: "0399990000",
        website: "https://moonlit.example.com",
        latitude: -37.798,
        longitude: 144.979,
      },
      submissionType: "full_venue_update",
      observedAt: NOW,
      sourcePhotoDataUrl: null,
      sourcePhotoUrl: null,
      uploadLocation: {
        latitude: -37.7981,
        longitude: 144.9791,
        accuracyMeters: 20,
        capturedAt: NOW,
      },
      notes: "User added a missing venue with menu board prices.",
      items: [
        { beerName: "Guinness", servingSize: "pint", price: 13, isHappyHourPrice: false, happyHourDetails: null, isOnTap: "yes" },
        { beerName: "Carlton Draught", servingSize: "pint", price: 12, isHappyHourPrice: false, happyHourDetails: null, isOnTap: "yes" },
        { beerName: "Stone & Wood Pacific Ale", servingSize: "pint", price: 14, isHappyHourPrice: false, happyHourDetails: null, isOnTap: "yes" },
      ],
    });

    const submission = await service.createSubmission(uploader, payload);

    expect(submission.submission.pendingVenue?.name).toBe("Moonlit Taproom");
    expect(submission.statusCopy).toContain("only after approval");
    expect(await service.listVenues("Moonlit", 10)).toEqual([]);
    expect(await publicPriceRepositories.get(repository)!.listVenueManagerPriceRecords(20, venueId)).toEqual([]);

    await service.reviewSubmission(admin, submission.submission.id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    });

    expect(await service.listSubmissions(admin, { status: "pending", mine: false, limit: 100 }))
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: submission.submission.id }),
      ]));

    const venues = await service.listVenues("Moonlit", 10);
    const publishedVenue = venues.find((venue) => venue.id === venueId);
    expect(publishedVenue).toEqual(expect.objectContaining({
      id: venueId,
      name: "Moonlit Taproom",
      address: "10 Test Lane",
      suburb: "Fitzroy",
      membershipTier: "basic",
      latitude: -37.798,
      longitude: 144.979,
    }));
    expect(publishedVenue?.beerKeys).toEqual([
      "carlton_draft",
      "guinness",
      "stone_and_wood_pacific_ale",
    ]);

    expect((await service.listPriceRecords(admin, {
      limit: 20,
      venueId,
      anonymousSessionId: null,
    })).records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        venueId,
        venueName: "Moonlit Taproom",
        beerName: "Guinness",
        price: 13,
      }),
    ]));

    const remoteVenues = [
      { id: "remote-venue-1", name: "Remote Venue One", address: "1 Remote St", suburb: "Melbourne", state: "VIC", postcode: "3000", latitude: -37.81, longitude: 144.96, business_status: "OPERATIONAL" },
      { id: "remote-venue-2", name: "Remote Venue Two", address: "2 Remote St", suburb: "Richmond", state: "VIC", postcode: "3121", latitude: -37.82, longitude: 144.99, business_status: "OPERATIONAL" },
    ];
    const supabaseVenueBuilder = {
      select: vi.fn(() => supabaseVenueBuilder),
      eq: vi.fn(() => supabaseVenueBuilder),
      gte: vi.fn(() => supabaseVenueBuilder),
      not: vi.fn(() => supabaseVenueBuilder),
      in: vi.fn(() => supabaseVenueBuilder),
      limit: vi.fn(() => supabaseVenueBuilder),
      order: vi.fn(async () => ({ data: remoteVenues, error: null })),
    };
    (service as unknown as { supabase: unknown }).supabase = {
      from: vi.fn(() => supabaseVenueBuilder),
    };

    expect(await service.listVenues(undefined, 2)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: venueId }),
    ]));

    const records = await publicPriceRepositories.get(repository)!.listVenueManagerPriceRecords(20, venueId);
    expect(records.map((record) => record.beerName).sort()).toEqual([
      "Carlton Draught",
      "Guinness",
      "Stone & Wood Pacific Ale",
    ]);
  });

  it("deduplicates local and Supabase venue rows while preserving manager-authored public profile details", async () => {
    const { repository } = createRepository();
    const venueId = "north-port-hotel";

    repository.upsertBarProfile({
      barId: venueId,
      name: "North Port Hotel",
      address: "146 Evans St",
      suburb: "Port Melbourne",
      area: "Port Melbourne",
      phone: "03 9000 1111",
      website: "https://northport.example.com",
      instagram: "https://instagram.com/northporthotel",
      description: "A manager-maintained public venue profile.",
      openingHours: { monday: { open: "12:00", close: "23:00" } },
      venueTags: [],
      membershipTier: "pro",
      highlightedName: true,
      premiumBadge: "Local Pro",
      promoted: true,
      featuredSpecialEligible: true,
      acceptsPintPathCodes: true,
      active: true,
      now: NOW,
    });

    const officialVenue = {
      id: venueId,
      name: "North Port Hotel",
      address: "146 Evans Street, Port Melbourne VIC 3207",
      suburb: "Port Melbourne",
      state: "VIC",
      postcode: "3207",
      latitude: -37.8308,
      longitude: 144.9497,
      business_status: "OPERATIONAL",
    };
    const supabaseVenueBuilder = {
      select: vi.fn(() => supabaseVenueBuilder),
      eq: vi.fn(() => supabaseVenueBuilder),
      gte: vi.fn(() => supabaseVenueBuilder),
      not: vi.fn(() => supabaseVenueBuilder),
      in: vi.fn(() => supabaseVenueBuilder),
      limit: vi.fn(() => supabaseVenueBuilder),
      order: vi.fn(async () => ({ data: [officialVenue], error: null })),
    };
    const service = createBusinessService(
      repository,
      {},
      undefined,
      { from: vi.fn(() => supabaseVenueBuilder) } as never,
    );

    const venues = await service.listVenues(undefined, 10);

    expect(venues).toHaveLength(1);
    expect(venues[0]).toEqual(expect.objectContaining({
      id: venueId,
      name: "North Port Hotel",
      address: "146 Evans St",
      suburb: "Port Melbourne",
      state: "VIC",
      postcode: "3207",
      latitude: -37.8308,
      longitude: 144.9497,
      phone: "03 9000 1111",
      website: "https://northport.example.com",
      instagram: "https://instagram.com/northporthotel",
      description: "A manager-maintained public venue profile.",
      openingHours: { monday: { open: "12:00", close: "23:00" } },
      membershipTier: "pro",
      highlightedName: true,
      premiumBadge: "Local Pro",
      promoted: true,
      featuredSpecialEligible: true,
      acceptsPintPathCodes: true,
    }));
  });

  it("batch-loads public venue tier metadata instead of issuing one profile read per venue", async () => {
    const { repository } = createRepository();
    for (const [index, venueId] of ["venue-a", "venue-b", "venue-c", "venue-d"].entries()) {
      repository.upsertBarProfile({
        barId: venueId,
        name: `Venue ${String.fromCharCode(65 + index)}`,
        address: null,
        suburb: "Melbourne",
        area: "Melbourne",
        phone: null,
        website: null,
        instagram: null,
        description: null,
        openingHours: {},
        venueTags: [],
        membershipTier: venueId === "venue-a" ? "pro" : "basic",
        highlightedName: venueId === "venue-a",
        premiumBadge: null,
        promoted: venueId === "venue-a",
        featuredSpecialEligible: venueId === "venue-a",
        acceptsPintPathCodes: venueId === "venue-a",
        active: true,
        now: NOW,
      });
    }

    const inventory = venueInventoryRepositories.get(repository)!;
    const batchMetadata = vi.spyOn(inventory, "listBarProfilePublicMetadata");
    const pointMetadata = vi.spyOn(inventory, "getBarProfile");
    const service = createBusinessService(repository);
    const result = await service.listVenuesPage(undefined, 2, 0);

    expect(result.venues).toHaveLength(2);
    expect(result.venues[0]).toEqual(expect.objectContaining({
      id: "venue-a",
      membershipTier: "pro",
      highlightedName: true,
      promoted: true,
      featuredSpecialEligible: true,
      acceptsPintPathCodes: true,
    }));
    expect(batchMetadata).toHaveBeenCalledTimes(1);
    expect(batchMetadata.mock.calls[0]?.[0]).toEqual(["venue-a", "venue-b", "venue-c", "venue-d"]);
    expect(pointMetadata).not.toHaveBeenCalled();

    batchMetadata.mockClear();
    const prelaunchService = createBusinessService(repository, { COMMERCIAL_LAUNCH_ENABLED: false });
    const prelaunchResult = await prelaunchService.listVenuesPage(undefined, 2, 0);
    expect(prelaunchResult.venues.every((venue) => venue.membershipTier === "basic")).toBe(true);
    expect(batchMetadata).not.toHaveBeenCalled();
    expect(pointMetadata).not.toHaveBeenCalled();
  });

  it("exposes remote contact provenance while filtering closed venues and withholding malformed postcodes", async () => {
    const { repository } = createRepository();
    const selectedColumns: string[] = [];
    const equalityFilters: Array<{ column: string; value: unknown }> = [];
    const remoteVenues = [
      {
        id: "remote-operational",
        name: "Operational Hotel",
        address: "1 Open St",
        suburb: "Melbourne",
        state: "VIC",
        postcode: "3000",
        phone: "03 9000 1000",
        website: "https://operational.example.com/",
        latitude: -37.81,
        longitude: 144.96,
        directory_eligible: true,
        business_status: "OPERATIONAL",
        last_checked_at: NOW,
      },
      {
        id: "remote-temporarily-closed",
        name: "Temporarily Closed Hotel",
        address: "2 Closed St",
        suburb: "Melbourne",
        state: "VIC",
        postcode: "3000",
        phone: "03 9000 2000",
        website: "https://closed.example.com/",
        latitude: -37.82,
        longitude: 144.97,
        directory_eligible: true,
        business_status: "CLOSED_TEMPORARILY",
        last_checked_at: NOW,
      },
      {
        id: "remote-permanently-closed",
        name: "Permanently Closed Hotel",
        address: "4 Closed St",
        suburb: "Melbourne",
        state: "VIC",
        postcode: "3000",
        phone: "03 9000 4000",
        website: "https://permanently-closed.example.com/",
        latitude: -37.825,
        longitude: 144.975,
        directory_eligible: true,
        business_status: "CLOSED_PERMANENTLY",
        last_checked_at: NOW,
      },
      {
        id: "remote-malformed-postcode",
        name: "Malformed Postcode Hotel",
        address: "3 Review St",
        suburb: "Melbourne",
        state: "VIC",
        postcode: "3OOO",
        phone: null,
        website: "javascript:alert(1)",
        latitude: -37.83,
        longitude: 144.98,
        directory_eligible: true,
        business_status: "OPERATIONAL",
        last_checked_at: "not-a-timestamp",
      },
      {
        id: "remote-unknown-status",
        name: "Unchecked Legacy Venue",
        address: "8 Unknown St",
        suburb: "Melbourne",
        state: "VIC",
        postcode: "3000",
        phone: null,
        website: null,
        latitude: -37.84,
        longitude: 144.99,
        directory_eligible: false,
        business_status: null,
        last_checked_at: null,
      },
    ];
    const builder = {
      select: vi.fn((columns: string) => {
        selectedColumns.push(columns);
        return builder;
      }),
      eq: vi.fn((column: string, value: unknown) => {
        equalityFilters.push({ column, value });
        return builder;
      }),
      gte: vi.fn(() => builder),
      in: vi.fn(() => builder),
      range: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      order: vi.fn((column: string) => column === "name"
        ? builder
        : Promise.resolve({ data: remoteVenues, error: null, count: remoteVenues.length })),
    };
    const service = createBusinessService(
      repository,
      {},
      undefined,
      { from: vi.fn(() => builder) } as never,
    );

    const result = await service.listVenuesPage(undefined, 10);

    expect(selectedColumns[0]).toContain("phone");
    expect(selectedColumns[0]).toContain("website");
    expect(selectedColumns[0]).toContain("business_status");
    expect(selectedColumns[0]).toContain("last_checked_at");
    expect(selectedColumns[0]).toContain("directory_eligible");
    expect(equalityFilters).toContainEqual({ column: "directory_eligible", value: true });
    expect(equalityFilters).toContainEqual({ column: "business_status", value: "OPERATIONAL" });
    expect(result.venues.map((venue) => venue.id)).toEqual([
      "remote-operational",
    ]);
    expect(result.venues.map((venue) => venue.id)).not.toContain("remote-unknown-status");
    expect(result.venues[0]).toEqual(expect.objectContaining({
      phone: "03 9000 1000",
      website: "https://operational.example.com/",
      businessStatus: "OPERATIONAL",
      lastCheckedAt: NOW,
    }));
  });

  it("fails closed for text-keyed and UUID local venues absent from the operational Supabase directory", async () => {
    const { repository } = createRepository();
    const textVenueId = "pintpath-release:venue:044";
    const uuidVenueId = "00000000-0000-4000-8000-000000000044";
    const upsertProfile = (barId: string, name: string) => repository.upsertBarProfile({
      barId,
      name,
      address: null,
      suburb: "Melbourne",
      area: "Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      highlightedName: false,
      premiumBadge: null,
      promoted: false,
      featuredSpecialEligible: false,
      active: true,
      now: NOW,
    });
    upsertProfile(textVenueId, "Release Venue 044");
    upsertProfile(uuidVenueId, "UUID Venue 044");

    const remoteEq = vi.fn();
    const remoteNot = vi.fn();
    const remoteBuilder = {
      select: vi.fn(() => remoteBuilder),
      eq: vi.fn((column: string, value: unknown) => {
        remoteEq(column, value);
        return remoteBuilder;
      }),
      gte: vi.fn(() => remoteBuilder),
      in: vi.fn(() => remoteBuilder),
      not: vi.fn((column: string, operator: string, value: string) => {
        remoteNot(column, operator, value);
        return remoteBuilder;
      }),
      or: vi.fn(() => remoteBuilder),
      range: vi.fn(() => remoteBuilder),
      limit: vi.fn(() => remoteBuilder),
      order: vi.fn((column: string) => column === "name"
        ? remoteBuilder
        : Promise.resolve({ data: [], error: null, count: 0 })),
    };
    const from = vi.fn(() => remoteBuilder);
    const service = createBusinessService(
      repository,
      {},
      undefined,
      { from } as never,
    );

    const result = await service.listVenuesPage(undefined, 10);

    expect(result.venues).toEqual([]);
    expect(remoteEq).toHaveBeenCalledWith("directory_eligible", true);
    expect(remoteEq).toHaveBeenCalledWith("business_status", "OPERATIONAL");
    expect(remoteNot).not.toHaveBeenCalled();

    const supabaseCallsBeforeLocalLookup = from.mock.calls.length;
    expect(await service.getPublicVenueById(textVenueId)).toBeNull();
    expect(from.mock.calls.length).toBeGreaterThan(supabaseCallsBeforeLocalLookup);
  });

  it("deduplicates local and remote identities before applying page offsets", async () => {
    const { repository } = createRepository();
    const localVenueId = "demo:rooftop-bar";
    repository.upsertBarProfile({
      barId: localVenueId,
      name: "Rooftop Bar",
      address: null,
      suburb: "Melbourne",
      area: "Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      highlightedName: false,
      premiumBadge: null,
      promoted: false,
      featuredSpecialEligible: false,
      active: true,
      now: NOW,
    });
    const remoteVenues = [
      {
        id: "9102aedc-de45-4784-a2ce-f89b7d194c01",
        name: "Rooftop Bar",
        address: null,
        suburb: "Melbourne",
        state: "VIC",
        postcode: "3000",
        latitude: -37.81,
        longitude: 144.96,
        business_status: "OPERATIONAL",
      },
      {
        id: "remote-unique",
        name: "Unique Remote Venue",
        address: "1 Remote St",
        suburb: "Melbourne",
        state: "VIC",
        postcode: "3000",
        latitude: -37.82,
        longitude: 144.97,
        business_status: "OPERATIONAL",
      },
    ];
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      gte: vi.fn(() => builder),
      range: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      order: vi.fn((column: string) => column === "name"
        ? builder
        : Promise.resolve({ data: remoteVenues, error: null, count: remoteVenues.length })),
    };
    const service = createBusinessService(
      repository,
      {},
      undefined,
      { from: vi.fn(() => builder) } as never,
    );

    const firstPage = await service.listVenuesPage(undefined, 1, 0);
    const secondPage = await service.listVenuesPage(undefined, 1, 1);

    expect(firstPage.venues.map((venue) => venue.id)).toEqual([localVenueId]);
    expect(firstPage.pagination).toEqual({ total: 2, limit: 1, offset: 0, hasMore: true });
    expect(secondPage.venues.map((venue) => venue.id)).toEqual(["remote-unique"]);
    expect(secondPage.pagination).toEqual({ total: 2, limit: 1, offset: 1, hasMore: false });
  });

  it("deduplicates the complete local directory before applying page offsets", async () => {
    const { repository } = createRepository();
    const upsertProfile = (barId: string, name: string, pro = false) => repository.upsertBarProfile({
      barId,
      name,
      address: null,
      suburb: "Melbourne",
      area: "Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: pro ? "pro" : "basic",
      highlightedName: pro,
      premiumBadge: pro ? "Identity Pro" : null,
      promoted: pro,
      featuredSpecialEligible: pro,
      acceptsPintPathCodes: pro,
      active: true,
      now: NOW,
    });
    const canonicalVenueId = "9102aedc-de45-4784-a2ce-f89b7d194c01";
    upsertProfile(canonicalVenueId, "Rooftop Bar");
    upsertProfile("demo:rooftop-bar", "Rooftop Bar", true);
    upsertProfile("unique-local", "Unique Local Venue");
    const service = createBusinessService(repository);

    const firstPage = await service.listVenuesPage(undefined, 1, 0);
    const secondPage = await service.listVenuesPage(undefined, 1, 1);

    expect(firstPage.venues.map((venue) => venue.id)).toEqual([canonicalVenueId]);
    expect(firstPage.venues[0]).toEqual(expect.objectContaining({
      membershipTier: "pro",
      highlightedName: true,
      premiumBadge: "Identity Pro",
      promoted: true,
      featuredSpecialEligible: true,
      acceptsPintPathCodes: true,
    }));
    expect(firstPage.pagination).toEqual({ total: 2, limit: 1, offset: 0, hasMore: true });
    expect(secondPage.venues.map((venue) => venue.id)).toEqual(["unique-local"]);
    expect(secondPage.pagination).toEqual({ total: 2, limit: 1, offset: 1, hasMore: false });
  });

  it("fetches only the requested bounded Supabase venue page at deep offsets", async () => {
    const { repository } = createRepository();
    const remoteVenues = Array.from({ length: 50 }, (_, index) => ({
      id: `remote-page-${String(index).padStart(2, "0")}`,
      name: `Remote Venue ${String(index).padStart(2, "0")}`,
      address: `${index} Remote St`,
      suburb: "Melbourne",
      state: "VIC",
      postcode: "3000",
      latitude: -37.8,
      longitude: 144.9,
      business_status: "OPERATIONAL",
    }));
    let requestedRange = { from: 0, to: 0 };
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      gte: vi.fn(() => builder),
      or: vi.fn(() => builder),
      range: vi.fn((from: number, to: number) => {
        requestedRange = { from, to };
        return builder;
      }),
      limit: vi.fn(() => builder),
      order: vi.fn(async () => ({
        data: remoteVenues.slice(requestedRange.from, requestedRange.to + 1),
        error: null,
        count: remoteVenues.length,
      })),
    };
    const service = createBusinessService(
      repository,
      {},
      undefined,
      { from: vi.fn(() => builder) } as never,
    );

    const result = await service.listVenuesPage(undefined, 5, 20);

    expect(builder.range).toHaveBeenCalledWith(20, 24);
    expect(result.venues.map((venue) => venue.id)).toEqual([
      "remote-page-20",
      "remote-page-21",
      "remote-page-22",
      "remote-page-23",
      "remote-page-24",
    ]);
    expect(result.pagination).toEqual({ total: 50, limit: 5, offset: 20, hasMore: true });
  });

  it("reconciles large local UUID directories without an oversized PostgREST exclusion filter", async () => {
    const { repository } = createRepository();
    const localVenueIds = Array.from({ length: 612 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    localVenueIds.forEach((barId, index) => {
      repository.upsertBarProfile({
        barId,
        name: `Local Venue ${String(index).padStart(3, "0")}`,
        address: null,
        suburb: "Melbourne",
        area: "Melbourne",
        phone: null,
        website: null,
        instagram: null,
        description: null,
        openingHours: {},
        venueTags: [],
        membershipTier: "basic",
        highlightedName: false,
        premiumBadge: null,
        promoted: false,
        featuredSpecialEligible: false,
        active: true,
        now: NOW,
      });
    });
    repository.upsertBarProfile({
      barId: "demo:local-venue-001",
      name: "Local Venue 001",
      address: null,
      suburb: "Melbourne",
      area: "Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      highlightedName: false,
      premiumBadge: null,
      promoted: false,
      featuredSpecialEligible: false,
      active: true,
      now: NOW,
    });
    const remoteVenues = [
      ...localVenueIds.map((id, index) => ({
        id,
        name: `Local Venue ${String(index).padStart(3, "0")}`,
        address: `${index} Hydrated St`,
        suburb: "Melbourne",
        state: "VIC",
        postcode: "3000",
        latitude: -37.8,
        longitude: 144.9,
        business_status: "OPERATIONAL",
      })),
      {
        id: "remote-shadow-local-identity",
        name: "Local Venue 001",
        address: null,
        suburb: "Melbourne",
        state: "VIC",
        postcode: "3000",
        latitude: -37.8,
        longitude: 144.9,
        business_status: "OPERATIONAL",
      },
      ...["a", "b", "c"].map((suffix, index) => ({
        id: `remote-${suffix}`,
        name: `Remote Venue ${suffix.toUpperCase()}`,
        address: `${index + 1} Remote St`,
        suburb: "Melbourne",
        state: "VIC",
        postcode: "3000",
        latitude: -37.8,
        longitude: 144.9,
        business_status: "OPERATIONAL",
      })),
    ];
    let requestedRange = { from: 0, to: 0 };
    let remoteSearchActive = false;
    const remoteNot = vi.fn();
    const remoteEq = vi.fn();
    const remoteOrderColumns: string[] = [];
    const remoteBuilder = {
      select: vi.fn(() => {
        remoteSearchActive = false;
        return remoteBuilder;
      }),
      eq: vi.fn((column: string, value: unknown) => {
        remoteEq(column, value);
        return remoteBuilder;
      }),
      gte: vi.fn(() => remoteBuilder),
      in: vi.fn(() => remoteBuilder),
      not: vi.fn((column: string, operator: string, value: string) => {
        remoteNot(column, operator, value);
        return remoteBuilder;
      }),
      or: vi.fn(() => {
        remoteSearchActive = true;
        return remoteBuilder;
      }),
      range: vi.fn((from: number, to: number) => {
        requestedRange = { from, to };
        return remoteBuilder;
      }),
      limit: vi.fn(() => remoteBuilder),
      order: vi.fn((column: string) => {
        remoteOrderColumns.push(column);
        const matchingRemoteVenues = remoteSearchActive
          ? remoteVenues.filter((venue) => venue.name.includes("Local Venue 000"))
          : remoteVenues;
        return column === "name"
          ? remoteBuilder
          : Promise.resolve({
              data: matchingRemoteVenues.slice(
                requestedRange.from,
                Math.min(requestedRange.to + 1, requestedRange.from + 200),
              ),
              error: null,
              count: matchingRemoteVenues.length,
            });
      }),
    };
    const from = vi.fn(() => remoteBuilder);
    const service = createBusinessService(
      repository,
      {},
      undefined,
      { from } as never,
    );

    const localPage = await service.listVenuesPage(undefined, localVenueIds.length, 0);
    const firstRemotePage = await service.listVenuesPage(undefined, 2, localVenueIds.length);
    const secondRemotePage = await service.listVenuesPage(undefined, 2, localVenueIds.length + 2);
    const searchedPage = await service.listVenuesPage("Local Venue 000", 10, 0);

    expect(remoteNot).not.toHaveBeenCalled();
    expect(remoteEq).toHaveBeenCalledTimes(26);
    expect(remoteEq.mock.calls.filter(([column, value]) =>
      column === "business_status" && value === "OPERATIONAL"
    )).toHaveLength(13);
    expect(remoteEq.mock.calls.filter(([column, value]) =>
      column === "directory_eligible" && value === true
    )).toHaveLength(13);
    expect(from).toHaveBeenCalledTimes(13);
    expect(remoteBuilder.range.mock.calls).toEqual([
      [0, 999],
      [200, 1199],
      [400, 1399],
      [600, 1599],
      [0, 999],
      [200, 1199],
      [400, 1399],
      [600, 1599],
      [0, 999],
      [200, 1199],
      [400, 1399],
      [600, 1599],
      [0, 999],
    ]);
    expect(remoteOrderColumns).toEqual(Array.from({ length: 13 }, () => ["name", "id"]).flat());
    expect(localPage.venues.map((venue) => venue.id)).toEqual(localVenueIds);
    expect(localPage.venues[0]).toEqual(expect.objectContaining({
      address: "0 Hydrated St",
      postcode: "3000",
      latitude: -37.8,
      longitude: 144.9,
    }));
    expect(searchedPage.venues).toEqual([
      expect.objectContaining({
        id: localVenueIds[0],
        address: "0 Hydrated St",
        postcode: "3000",
      }),
    ]);
    expect(searchedPage.pagination).toEqual({ total: 1, limit: 10, offset: 0, hasMore: false });
    expect(localPage.pagination).toEqual({
      total: localVenueIds.length + 3,
      limit: localVenueIds.length,
      offset: 0,
      hasMore: true,
    });
    expect(firstRemotePage.venues.map((venue) => venue.id)).toEqual(["remote-a", "remote-b"]);
    expect(firstRemotePage.pagination).toEqual({
      total: localVenueIds.length + 3,
      limit: 2,
      offset: localVenueIds.length,
      hasMore: true,
    });
    expect(secondRemotePage.venues.map((venue) => venue.id)).toEqual(["remote-c"]);
    expect(secondRemotePage.pagination).toEqual({
      total: localVenueIds.length + 3,
      limit: 2,
      offset: localVenueIds.length + 2,
      hasMore: false,
    });
  });

  it("fails safely before a large-directory reconciliation can issue unbounded remote requests", async () => {
    const { repository } = createRepository();
    Array.from({ length: 101 }, (_, index) =>
      `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
    ).forEach((barId, index) => {
      repository.upsertBarProfile({
        barId,
        name: `Bounded Local Venue ${String(index).padStart(3, "0")}`,
        address: null,
        suburb: "Melbourne",
        area: "Melbourne",
        phone: null,
        website: null,
        instagram: null,
        description: null,
        openingHours: {},
        venueTags: [],
        membershipTier: "basic",
        highlightedName: false,
        premiumBadge: null,
        promoted: false,
        featuredSpecialEligible: false,
        active: true,
        now: NOW,
      });
    });
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      gte: vi.fn(() => builder),
      or: vi.fn(() => builder),
      range: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      order: vi.fn(async () => ({
        data: [{
          id: "remote-first",
          name: "Remote First",
          address: "1 Remote St",
          suburb: "Melbourne",
          state: "VIC",
          postcode: "3000",
          latitude: -37.8,
          longitude: 144.9,
        }],
        error: null,
        count: 5001,
      })),
    };
    const from = vi.fn(() => builder);
    const service = createBusinessService(
      repository,
      {},
      undefined,
      { from } as never,
    );

    await expect(service.listVenuesPage(undefined, 2, 101)).rejects.toMatchObject({
      statusCode: 503,
      details: expect.objectContaining({ code: "VENUE_DIRECTORY_SCAN_LIMIT" }),
    });
    expect(from).toHaveBeenCalledTimes(1);
    expect(builder.range).toHaveBeenCalledTimes(1);
  });

  it("hydrates each venue page with deduplicated tracked beer keys in one bounded repository query", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const canonicalVenueId = "beer-summary-canonical";
    const aliasVenueId = "beer-summary-alias";
    const upsertProfile = (barId: string, active: boolean) => repository.upsertBarProfile({
      barId,
      name: active ? "Beer Summary Hotel" : "Old Beer Summary Hotel",
      address: null,
      suburb: "Melbourne",
      area: "Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      highlightedName: false,
      premiumBadge: null,
      promoted: false,
      featuredSpecialEligible: false,
      active,
      now: NOW,
    });
    upsertProfile(canonicalVenueId, true);
    upsertProfile(aliasVenueId, false);
    await getVenueIdentityRepository(repository).upsertVenueIdentityAlias({
      aliasVenueId,
      canonicalVenueId,
      identityKey: "beer-summary-hotel|melbourne",
      expectedUpdatedAt: null,
      now: NOW,
    });

    const insertCommunityPrice = database.prepare(
      `INSERT INTO venue_price_records (
        id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, serving_size,
        price, is_happy_hour_price, happy_hour_details, is_on_tap, confidence,
        source_type, source_submission_id, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, 'Beer Summary Hotel', 'Melbourne', ?, ?, 'pint', 12, 0, NULL, 'yes',
        'photo_verified', 'source_ingestion', NULL, ?, ?, ?)`,
    );
    insertCommunityPrice.run(
      "beer-summary-community-guinness",
      aliasVenueId,
      "Guinness",
      "guinness",
      NOW,
      NOW,
      NOW,
    );
    insertCommunityPrice.run(
      "beer-summary-community-stone-wood",
      canonicalVenueId,
      "Stone & Wood Pacific Ale",
      "stone_and_wood",
      NOW,
      NOW,
      NOW,
    );
    insertCommunityPrice.run(
      "beer-summary-community-non-beer",
      canonicalVenueId,
      "House Red",
      "house_red",
      NOW,
      NOW,
      NOW,
    );

    const upsertInventoryBeer = (input: {
      id: string;
      barId: string;
      beerName: string;
      normalizedBeerId: string;
      inStock: boolean;
    }) => getVenueInventoryRepository(repository).upsertBarBeer({
      ...input,
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 13,
      currency: "AUD",
      onTap: true,
      notes: null,
      now: NOW,
    });
    await upsertInventoryBeer({
      id: "beer-summary-manager-carlton",
      barId: canonicalVenueId,
      beerName: "Carlton Draught",
      normalizedBeerId: "carlton_draft",
      inStock: true,
    });
    await upsertInventoryBeer({
      id: "beer-summary-manager-guinness-duplicate",
      barId: canonicalVenueId,
      beerName: "Guinness",
      normalizedBeerId: "guinness",
      inStock: true,
    });
    await upsertInventoryBeer({
      id: "beer-summary-manager-out-of-stock",
      barId: canonicalVenueId,
      beerName: "Hahn Super Dry",
      normalizedBeerId: "hahn_super_dry",
      inStock: false,
    });
    await upsertInventoryBeer({
      id: "beer-summary-manager-paid-only",
      barId: canonicalVenueId,
      beerName: "Victoria Bitter",
      normalizedBeerId: "victoria_bitter",
      inStock: true,
    });
    await upsertInventoryBeer({
      id: "beer-summary-manager-inactive-alias",
      barId: aliasVenueId,
      beerName: "Victoria Bitter",
      normalizedBeerId: "victoria_bitter",
      inStock: true,
    });

    const summarySpy = vi.spyOn(
      publicVenueDirectoryRepositories.get(repository)!,
      "listPublicVenueBeerKeys",
    );
    const result = await service.listVenuesPage(undefined, 20, 0);

    expect(summarySpy).toHaveBeenCalledTimes(1);
    expect(summarySpy).toHaveBeenCalledWith([canonicalVenueId]);
    expect(result.venues).toEqual([
      expect.objectContaining({
        id: canonicalVenueId,
        beerKeys: [
          "carlton_draft",
          "guinness",
          "stone_and_wood_pacific_ale",
        ],
      }),
    ]);

    const premiumAccount = updateSubscription(
      repository,
      createAccount(repository, "beer-summary-premium").id,
      "premium_monthly",
    );
    const premiumResult = await service.listVenuesPage(undefined, 20, 0, premiumAccount);
    expect(premiumResult.venues).toEqual([
      expect.objectContaining({
        id: canonicalVenueId,
        beerKeys: [
          "carlton_draft",
          "guinness",
          "stone_and_wood_pacific_ale",
          "victoria_bitter",
        ],
      }),
    ]);

    const premiumAuthorization = createSession(
      repository,
      premiumAccount.id,
      "beer-summary-premium-session-token",
    );
    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      const anonymousResponse = await fetch(`${baseUrl}/api/business/venues?limit=20`);
      expect(anonymousResponse.status).toBe(200);
      expect(anonymousResponse.headers.get("cache-control")).toBe(
        "public, max-age=30, stale-while-revalidate=120",
      );
      expect(anonymousResponse.headers.get("vary")).toContain("Authorization");
      expect(anonymousResponse.headers.get("vary")).toContain("Cookie");
      expect(anonymousResponse.headers.get("vary")).toContain("Origin");
      expect(await anonymousResponse.json()).toEqual(expect.objectContaining({
        data: expect.objectContaining({
          venues: [
            expect.objectContaining({
              beerKeys: [
                "carlton_draft",
                "guinness",
                "stone_and_wood_pacific_ale",
              ],
            }),
          ],
        }),
      }));

      const legacyPageResponse = await fetch(`${baseUrl}/api/business/venues?limit=500`);
      expect(legacyPageResponse.status).toBe(200);
      expect(await legacyPageResponse.json()).toEqual(expect.objectContaining({
        data: expect.objectContaining({
          pagination: expect.objectContaining({ limit: 250 }),
        }),
      }));

      const premiumResponse = await fetch(`${baseUrl}/api/business/venues?limit=20`, {
        headers: { authorization: premiumAuthorization },
      });
      expect(premiumResponse.status).toBe(200);
      expect(premiumResponse.headers.get("cache-control")).toBe("private, no-store");
      expect(premiumResponse.headers.get("vary")).toContain("Authorization");
      expect(premiumResponse.headers.get("vary")).toContain("Cookie");
      expect(await premiumResponse.json()).toEqual(expect.objectContaining({
        data: expect.objectContaining({
          venues: [
            expect.objectContaining({
              beerKeys: [
                "carlton_draft",
                "guinness",
                "stone_and_wood_pacific_ale",
                "victoria_bitter",
              ],
            }),
          ],
        }),
      }));

      const invalidBearerResponse = await fetch(`${baseUrl}/api/business/venues?limit=20`, {
        headers: { authorization: "Bearer invalid-session-token" },
      });
      expect(invalidBearerResponse.status).toBe(401);

      const invalidCookieResponse = await fetch(`${baseUrl}/api/business/venues?limit=20`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=invalid-session-token` },
      });
      expect(invalidCookieResponse.status).toBe(401);
    });
  });

  it("deduplicates public price records that are also present in venue inventory", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "dedupe-admin", "admin");
    const now = new Date().toISOString();

    database.prepare(
      `INSERT INTO venue_price_records (
        id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, serving_size,
        price, is_happy_hour_price, happy_hour_details, is_on_tap, confidence,
        source_type, source_submission_id, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      "source-record-1",
      "dedupe-venue",
      "Dedupe Hotel",
      "Melbourne",
      "Carlton Draught",
      "carlton_draft",
      "pint",
      13,
      "yes",
      "photo_verified",
      "source_ingestion",
      now,
      now,
      now,
    );
    database.prepare(
      `INSERT INTO venue_price_records (
        id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, serving_size,
        price, is_happy_hour_price, happy_hour_details, is_on_tap, confidence,
        source_type, source_submission_id, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(
      "source-record-2",
      "dedupe-venue",
      "Dedupe Hotel",
      "Melbourne",
      "Guinness",
      "guinness",
      "pint",
      13,
      "yes",
      "photo_verified",
      "source_ingestion",
      now,
      now,
      now,
    );
    database.prepare(
      `INSERT INTO venue_profiles (
        venue_id, name, address, suburb, area, opening_hours_json, venue_tags_json, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, '{}', '[]', ?, ?)`,
    ).run("dedupe-venue", "Dedupe Hotel", "Melbourne", "Melbourne", now, now);
    database.prepare(
      `INSERT INTO venue_beers (
        id, venue_id, beer_name, normalized_beer_id, brewery, style, abv, serve_size,
        price, currency, on_tap, in_stock, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 'AUD', 1, 1, NULL, ?, ?)`,
    ).run(
      "admin-reviewed:dedupe-venue:carlton-draft:pint",
      "dedupe-venue",
      "Carlton Draught",
      "carlton_draft",
      "pint",
      13,
      now,
      now,
    );
    database.prepare(
      `INSERT INTO venue_beers (
        id, venue_id, beer_name, normalized_beer_id, brewery, style, abv, serve_size,
        price, currency, on_tap, in_stock, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 'AUD', 0, 0, NULL, ?, ?)`,
    ).run(
      "admin-reviewed:dedupe-venue:hahn-super-dry:pint",
      "dedupe-venue",
      "Hahn Super Dry",
      "hahn_super_dry",
      "pint",
      14,
      now,
      now,
    );

    const records = (await service.listPriceRecords(admin, {
      limit: 20,
      venueId: "dedupe-venue",
      anonymousSessionId: null,
    })).records;

    expect(records.filter((record) => record.beerName === "Carlton Draught")).toHaveLength(1);
    expect(records.find((record) => record.beerName === "Carlton Draught")).toEqual(expect.objectContaining({
      venueId: "dedupe-venue",
      beerName: "Carlton Draught",
      sourceType: "venue_manager_portal",
    }));
    expect(records.filter((record) => record.price === 13)).toEqual(expect.arrayContaining([
      expect.objectContaining({ beerName: "Carlton Draught" }),
      expect.objectContaining({ beerName: "Guinness" }),
    ]));
    expect(records).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        beerName: "Hahn Super Dry",
        sourceType: "venue_manager_portal",
      }),
    ]));
  });

  it("keeps one authoritative semantic price record across every cursor page", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "cursor-dedupe-admin", "admin");
    const managerVerifiedAt = "2026-05-04T08:00:00.000Z";
    const otherVerifiedAt = "2026-05-04T07:00:00.000Z";
    const staleDuplicateAt = "2026-05-04T06:00:00.000Z";

    repository.upsertBarProfile({
      barId: "cursor-dedupe-venue",
      name: "Cursor Dedupe Hotel",
      address: null,
      suburb: "Melbourne",
      area: "Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      acceptsPintPathCodes: false,
      active: true,
      now: managerVerifiedAt,
    });
    await getVenueInventoryRepository(repository).upsertBarBeer({
      id: "cursor-manager-carlton",
      barId: "cursor-dedupe-venue",
      beerName: "Carlton Draught",
      normalizedBeerId: "carlton_draft",
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 14,
      currency: "AUD",
      onTap: true,
      inStock: true,
      notes: null,
      priceVerifiedAt: managerVerifiedAt,
      now: managerVerifiedAt,
    });
    const insertPrice = database.prepare(
      `INSERT INTO venue_price_records (
        id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, serving_size,
        price, is_happy_hour_price, happy_hour_details, is_on_tap, confidence,
        source_type, source_submission_id, last_verified_at, created_at, updated_at
      ) VALUES (?, 'cursor-dedupe-venue', 'Cursor Dedupe Hotel', 'Melbourne', ?, ?, 'pint', ?, 0, NULL, 'yes',
        'photo_verified', 'source_ingestion', NULL, ?, ?, ?)`,
    );
    insertPrice.run("cursor-other-guinness", "Guinness", "guinness", 13, otherVerifiedAt, otherVerifiedAt, otherVerifiedAt);
    insertPrice.run("cursor-stale-carlton", "Carlton Draught", "carlton_draft", 12, staleDuplicateAt, staleDuplicateAt, staleDuplicateAt);

    const allRecords: Array<{ id: string; beerName: string; sourceType: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await service.listPriceRecords(admin, {
        limit: 1,
        venueId: "cursor-dedupe-venue",
        anonymousSessionId: null,
        ...(cursor ? { cursor } : {}),
      });
      allRecords.push(...page.records);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(allRecords.filter((record) => record.beerName === "Carlton Draught")).toEqual([
      expect.objectContaining({ id: "bar_beer:cursor-manager-carlton", sourceType: "venue_manager_portal" }),
    ]);
    expect(allRecords.map((record) => record.beerName)).toContain("Guinness");
    expect(allRecords.map((record) => record.id)).not.toContain("cursor-stale-carlton");
  });

  it("stores upload location proof and awards dynamic points only inside the 200m venue radius", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const uploader = createAccount(repository, "dynamic-points-user");
    const admin = createAccount(repository, "dynamic-points-admin", "admin");
    const baseLocation = {
      latitude: -37.9069,
      longitude: 144.9964,
      accuracyMeters: 18,
      capturedAt: new Date().toISOString(),
    };

    repository.upsertVenueLocationCache({
      venueId: "half-moon",
      venueName: "Half Moon",
      suburb: "Brighton",
      latitude: -37.9069,
      longitude: 144.9964,
      now: NOW,
    });

    const submission = (await service.createSubmission(uploader, createSubmissionSchema.parse({
      venueId: "half-moon",
      venueName: "Half Moon",
      suburb: "Brighton",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: PNG_DATA_URL,
      sourcePhotoUrl: null,
      uploadLocation: baseLocation,
      notes: null,
      items: [{
        beerName: "Guinness",
        servingSize: "pint",
        price: 13,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }))).submission;

    expect(submission.pointsEligibleByLocation).toBe(true);
    expect(submission.distanceToVenueMeters).toBe(0);

    const reviewed = await service.reviewSubmission(admin, submission.id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      pointsAwarded: 25,
      confidence: "photo_verified",
    });

    expect(reviewed.pointsAwarded).toBe(5);
    expect(reviewed.account.contributionPointsCurrentMonth).toBe(5);

    repository.upsertVenueLocationCache({
      venueId: "far-away",
      venueName: "Far Away Bar",
      suburb: "Melbourne",
      latitude: -37.8136,
      longitude: 144.9631,
      now: NOW,
    });
    const farSubmission = (await service.createSubmission(uploader, createSubmissionSchema.parse({
      venueId: "far-away",
      venueName: "Far Away Bar",
      suburb: "Melbourne",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: PNG_DATA_URL,
      sourcePhotoUrl: null,
      uploadLocation: baseLocation,
      notes: null,
      items: [{
        beerName: "Carlton Draught",
        servingSize: "pint",
        price: 12,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }))).submission;

    expect(farSubmission.pointsEligibleByLocation).toBe(false);
    expect(farSubmission.pointsEligibilityReason).toBe("outside_200m");
    const farReviewed = await service.reviewSubmission(admin, farSubmission.id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      pointsAwarded: 25,
      confidence: "photo_verified",
    });
    expect(farReviewed.pointsAwarded).toBe(0);

    expect(() => createSubmissionSchema.parse({
      venueId: "half-moon",
      venueName: "Half Moon",
      suburb: "Brighton",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: PNG_DATA_URL,
      uploadLocation: { ...baseLocation, accuracyMeters: null },
      items: [{ beerName: "Guinness", servingSize: "pint", price: 13, isOnTap: "yes" }],
    })).toThrow();
    expect(() => createSubmissionSchema.parse({
      venueId: "half-moon",
      venueName: "Half Moon",
      suburb: "Brighton",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: PNG_DATA_URL,
      uploadLocation: { ...baseLocation, accuracyMeters: 101 },
      items: [{ beerName: "Guinness", servingSize: "pint", price: 13, isOnTap: "yes" }],
    })).toThrow();

    const staleInput = createSubmissionSchema.parse({
      venueId: "half-moon",
      venueName: "Half Moon",
      suburb: "Brighton",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: PNG_DATA_URL,
      uploadLocation: {
        ...baseLocation,
        capturedAt: new Date(new Date(NOW).getTime() - (13 * 60 * 60_000)).toISOString(),
      },
      items: [{ beerName: "Guinness", servingSize: "pint", price: 13, isOnTap: "yes" }],
    });
    await expect(service.createSubmission(uploader, staleInput)).rejects.toThrow("last 12 hours");

    const inaccurateInput = createSubmissionSchema.parse({
      venueId: "half-moon",
      venueName: "Half Moon",
      suburb: "Brighton",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: PNG_DATA_URL,
      uploadLocation: baseLocation,
      items: [{ beerName: "Guinness", servingSize: "pint", price: 13, isOnTap: "yes" }],
    });
    inaccurateInput.uploadLocation!.accuracyMeters = 150;
    const inaccurate = (await service.createSubmission(uploader, inaccurateInput)).submission;
    expect(inaccurate).toEqual(expect.objectContaining({
      pointsEligibleByLocation: false,
      pointsEligibilityReason: "location_accuracy_over_100m",
    }));
  });

  it("scales contribution points by venue freshness", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "freshness-user");
    const admin = createAccount(repository, "freshness-admin", "admin");

    const seedExistingRecord = (venueId: string, observedAt: string) => {
      database.prepare(
        `INSERT INTO venue_price_records (
           id, venue_id, venue_name, suburb, beer_name, normalized_beer_id,
           serving_size, price, is_happy_hour_price, is_on_tap, confidence,
           source_type, source_submission_id,
           last_verified_at, created_at, updated_at
         ) VALUES (
           ?, ?, ?, 'Melbourne', 'Guinness', 'guinness',
           'pint', 12, 0, 'yes', 'photo_verified',
           'test_fixture', NULL, ?, ?, ?
         )`,
      ).run(
        `seed-price-${venueId}`,
        venueId,
        `Venue ${venueId}`,
        observedAt,
        observedAt,
        observedAt,
      );
    };

    const makeSubmission = async (venueId: string, submitter = user, beerName = "Guinness") => {
      repository.upsertVenueLocationCache({
        venueId,
        venueName: `Venue ${venueId}`,
        suburb: "Melbourne",
        latitude: -37.8,
        longitude: 144.9,
        now: NOW,
      });
      return (await service.createSubmission(submitter, createSubmissionSchema.parse({
        venueId,
        venueName: `Venue ${venueId}`,
        suburb: "Melbourne",
        submissionType: "single_beer_price",
        observedAt: NOW,
        sourcePhotoDataUrl: PNG_DATA_URL,
        sourcePhotoUrl: null,
        uploadLocation: {
          latitude: -37.8,
          longitude: 144.9,
          accuracyMeters: 12,
          capturedAt: new Date().toISOString(),
        },
        notes: null,
        items: [{
          beerName,
          servingSize: "pint",
          price: 13,
          isHappyHourPrice: false,
          happyHourDetails: null,
          isOnTap: "yes",
        }],
      }))).submission;
    };

    seedExistingRecord("fresh-venue", new Date().toISOString());
    seedExistingRecord("week-venue", new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString());
    seedExistingRecord("stale-venue", new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());

    const fresh = await service.reviewSubmission(admin, (await makeSubmission("fresh-venue")).id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    });
    const week = await service.reviewSubmission(admin, (await makeSubmission("week-venue")).id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    });
    const stale = await service.reviewSubmission(admin, (await makeSubmission("stale-venue")).id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    });
    const missing = await service.reviewSubmission(admin, (await makeSubmission("new-venue")).id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    });
    const newDrinkUser = createAccount(repository, "new-drink-user");
    const newDrink = await service.reviewSubmission(
      admin,
      (await makeSubmission("fresh-venue", newDrinkUser, "Stone & Wood Pacific Ale")).id,
      {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
      },
    );

    expect(fresh.pointsAwarded).toBe(0.1);
    expect(week.pointsAwarded).toBe(0.5);
    expect(stale.pointsAwarded).toBe(1);
    expect(missing.pointsAwarded).toBe(5);
    expect(newDrink.pointsAwarded).toBe(5);
  });

  it("unlocks contributor premium at 15 monthly points until month end", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "monthly-unlock-user");
    const admin = createAccount(repository, "monthly-unlock-admin", "admin");
    const uploadLocation = {
      latitude: -37.82,
      longitude: 144.96,
      accuracyMeters: 10,
      capturedAt: new Date().toISOString(),
    };

    for (const venueId of ["unlock-venue-1", "unlock-venue-2", "unlock-venue-3"]) {
      repository.upsertVenueLocationCache({
        venueId,
        venueName: venueId,
        suburb: "Melbourne",
        latitude: uploadLocation.latitude,
        longitude: uploadLocation.longitude,
        now: NOW,
      });
      const submission = (await service.createSubmission(user, createSubmissionSchema.parse({
        venueId,
        venueName: venueId,
        suburb: "Melbourne",
        submissionType: "single_beer_price",
        observedAt: NOW,
        sourcePhotoDataUrl: PNG_DATA_URL,
        sourcePhotoUrl: null,
        uploadLocation,
        notes: null,
        items: [{
          beerName: "Stone & Wood Pacific Ale",
          servingSize: "pint",
          price: 13,
          isHappyHourPrice: false,
          happyHourDetails: null,
          isOnTap: "yes",
        }],
      }))).submission;
      await service.reviewSubmission(admin, submission.id, {
        status: "approved",
        rejectionReason: null,
        fraudFlagged: false,
        confidence: "photo_verified",
      });
    }

    const updated = repository.getAccountById(user.id)!;
    const now = new Date();
    const expectedMonthEnd = getZonedMonthRangeIso(getZonedMonthKey(now, "Australia/Melbourne"), "Australia/Melbourne").endIso;
    expect(updated.contributionPointsCurrentMonth).toBe(15);
    expect(updated.subscriptionStatus).toBe("contributor_unlocked");
    expect(updated.premiumUntil).toBe(expectedMonthEnd);
  });

  it("uses the Melbourne contribution month for boundary reviews and unlock expiry", async () => {
    vi.setSystemTime(new Date("2026-07-31T14:30:00.000Z"));
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "melbourne-boundary-user");
    const admin = createAccount(repository, "melbourne-boundary-admin", "admin");

    for (const venueId of ["boundary-venue-1", "boundary-venue-2", "boundary-venue-3"]) {
      repository.upsertVenueLocationCache({
        venueId,
        venueName: venueId,
        suburb: "Melbourne",
        latitude: -37.81,
        longitude: 144.96,
        now: new Date().toISOString(),
      });
      const submission = (await service.createSubmission(user, createSubmissionSchema.parse({
        venueId,
        venueName: venueId,
        suburb: "Melbourne",
        submissionType: "single_beer_price",
        observedAt: new Date().toISOString(),
        sourcePhotoDataUrl: PNG_DATA_URL,
        sourcePhotoUrl: null,
        uploadLocation: {
          latitude: -37.81,
          longitude: 144.96,
          accuracyMeters: 10,
          capturedAt: new Date().toISOString(),
        },
        notes: null,
        items: [{
          beerName: "Guinness",
          servingSize: "pint",
          price: 13,
          isHappyHourPrice: false,
          happyHourDetails: null,
          isOnTap: "yes",
        }],
      }))).submission;
      await service.reviewSubmission(admin, submission.id, {
        status: "approved",
        rejectionReason: null,
        fraudFlagged: false,
        confidence: "photo_verified",
      });
    }

    expect(database.prepare("SELECT DISTINCT month_key FROM contribution_ledger WHERE user_id = ?").all(user.id))
      .toEqual([{ month_key: "2026-08" }]);
    expect(repository.getAccountById(user.id)).toEqual(expect.objectContaining({
      contributionPointsCurrentMonth: 15,
      subscriptionStatus: "contributor_unlocked",
      premiumUntil: getZonedMonthRangeIso("2026-08", "Australia/Melbourne").endIso,
    }));
  });

  it("shows zero current-month progress after rollover even before another review", async () => {
    vi.setSystemTime(new Date("2026-07-31T14:30:00.000Z"));
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "dashboard-rollover-user");
    database.prepare("UPDATE accounts SET contribution_points_current_month = 15 WHERE id = ?").run(user.id);
    database.prepare(
      `INSERT INTO contribution_ledger (id, user_id, submission_id, venue_id, points, reason, month_key, created_at)
       VALUES ('dashboard-rollover-ledger', ?, NULL, 'previous-month-venue', 15, 'historical', '2026-07', ?)`,
    ).run(user.id, "2026-07-15T00:00:00.000Z");

    const dashboard = await service.getAccountDashboard(repository.getAccountById(user.id)!);
    expect(dashboard.account.contributionPointsCurrentMonth).toBe(0);
    expect(dashboard.dashboardStats.pointsThisMonth).toBe(0);
    expect(dashboard.contributorProgress).toEqual(expect.objectContaining({
      pointsThisMonth: 0,
      pointsNeeded: 15,
    }));
  });

  it("redacts sensitive metadata before writing security audit rows", async () => {
    const { database, repository } = createRepository();
    const activityAuditRepository = new ActivityAuditRepository(getAsyncDatabase(database));

    await activityAuditRepository.insertSecurityAuditLog({
      id: "audit-sensitive",
      actorUserId: "admin",
      actorRole: "admin",
      action: "test_sensitive_metadata",
      targetType: "submission",
      targetId: "submission-1",
      metadata: {
        token: "super-secret-token",
        email: "person@example.com",
        phone: "+61400000000",
        safe: "kept",
      },
      ipHash: null,
      userAgentHash: null,
      createdAt: NOW,
    });

    const metadata = (await activityAuditRepository.listSecurityAuditLogs({ limit: 1 })).items[0]?.metadata ?? {};
    expect(metadata.safe).toBe("kept");
    expect(metadata.token).toBe("[REDACTED]");
    expect(metadata.email).toBe("[REDACTED]");
    expect(metadata.phone).toBe("[REDACTED]");
  });

  it("does not expose another user's source upload through the non-admin submission queue", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "source-owner");
    const otherUser = createAccount(repository, "source-viewer");
    createSubmission(repository, {
      id: "source-submission",
      userId: user.id,
      venueId: "venue-source",
      sourcePhotoUrl: PNG_DATA_URL,
    });

    expect(await service.listSubmissions(otherUser, { mine: false, limit: 10 })).toEqual([]);
  });

  it("keeps source evidence private and serves it only through short-lived signed URLs", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      PUBLIC_BASE_URL: "https://beer.example.test",
      SOURCE_EVIDENCE_SIGNING_SECRET: "test-source-evidence-signing-secret-32-bytes",
      SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS: 120,
    });
    const owner = createAccount(repository, "source-private-owner");
    const otherUser = createAccount(repository, "source-private-other");
    const admin = createAccount(repository, "source-private-admin", "admin");
    const submission = (await service.createSubmission(owner, createSubmissionSchema.parse({
      venueId: "venue-source-private",
      venueName: "Source Private Bar",
      suburb: "Melbourne",
      submissionType: "photo_upload",
      observedAt: NOW,
      sourcePhotoDataUrl: PNG_DATA_URL,
      sourcePhotoUrl: null,
      notes: null,
      items: [],
    }))).submission;

    expect(submission.sourcePhotoUrl).toMatch(/^private:evidence:/);
    expect(submission.sourcePhotoUrl).not.toContain("data:image");
    await expect(service.getSubmissionSourceEvidenceUrl(otherUser, submission.id)).rejects.toThrow("own source evidence");

    const ownerSigned = await service.getSubmissionSourceEvidenceUrl(owner, submission.id);
    const adminSigned = await service.getSubmissionSourceEvidenceUrl(admin, submission.id);
    expect(ownerSigned.signedUrl).toContain("/api/business/source-evidence/");
    expect(adminSigned.signedUrl).toContain("/api/business/source-evidence/");

    const signedUrl = new URL(ownerSigned.signedUrl!);
    const evidence = await service.getSourceEvidenceForSignedRequest({
      evidenceId: signedUrl.pathname.split("/").pop()!,
      expires: signedUrl.searchParams.get("expires") ?? undefined,
      signature: signedUrl.searchParams.get("signature") ?? undefined,
    });
    expect(evidence.mimeType).toBe("image/png");
    expect(evidence.dataBase64).toBeTruthy();
    await expect(service.getSourceEvidenceForSignedRequest({
      evidenceId: evidence.id,
      expires: "1",
      signature: signedUrl.searchParams.get("signature") ?? undefined,
    })).rejects.toThrow("expired");
    await expect(service.getSourceEvidenceForSignedRequest({
      evidenceId: evidence.id,
      expires: signedUrl.searchParams.get("expires") ?? undefined,
      signature: "0".repeat(64),
    })).rejects.toThrow("Invalid source evidence signature");
  });

  it("drains source-evidence retention beyond 100 rows and purges evidence that expires after startup", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const createEvidence = (id: string, retentionExpiresAt: string) =>
      getSourceEvidenceObjectRepository(repository).registerSourceEvidenceObject({
      id,
      ownerUserId: null,
      storageProvider: "sqlite_private",
      objectPath: `evidence/${id}`,
      mimeType: "image/png",
      byteSize: 5,
      dataBase64: "aGVsbG8=",
      externalUrl: null,
      retentionExpiresAt,
      createdAt: "2026-04-01T08:00:00.000Z",
    });
    await Promise.all(Array.from({ length: 205 }, (_, index) =>
      createEvidence(`expired-evidence-${index}`, "2026-05-03T08:00:00.000Z")));

    await expect(service.purgeExpiredSourceEvidence(100)).resolves.toEqual(expect.objectContaining({
      purged: 205,
      failed: 0,
      remaining: 0,
      backlogBefore: 205,
      passes: 3,
      stalled: false,
    }));

    await createEvidence("expires-after-startup", "2026-05-04T08:30:00.000Z");
    const statuses: unknown[] = [];
    const scheduler = scheduleMissionMaintenance({
      run: () => service.purgeExpiredSourceEvidence(100),
      intervalMinutes: 60,
      onStatus: (status) => statuses.push(status),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((await getSourceEvidenceObjectRepository(repository)
      .getSourceEvidenceObject("expires-after-startup"))?.deletedAt).toBeNull();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    expect((await getSourceEvidenceObjectRepository(repository)
      .getSourceEvidenceObject("expires-after-startup"))?.deletedAt).toBe("2026-05-04T09:00:00.000Z");
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: "succeeded",
        trigger: "interval",
        result: expect.objectContaining({ purged: 1, remaining: 0 }),
      }),
    ]));
    await scheduler.stop();
  });

  it("drains bounded privacy batches using one as-of and stops on deferred Stripe envelopes", async () => {
    const { database, repository } = createRepository();
    const account = createAccount(repository, "privacy-retention-drain");
    const insertSession = database.prepare(
      `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
       VALUES (?, ?, '2025-12-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    database.transaction(() => {
      for (let index = 0; index < 1_001; index += 1) {
        insertSession.run(`privacy-expired-${String(index).padStart(4, "0")}`, account.id);
      }
    })();
    database.prepare(
      `INSERT INTO stripe_webhook_events (
         id, event_type, status, event_created_at, payload_json, attempts,
         last_error, received_at, applied_at, processed_at, processing_token
       ) VALUES (?, 'customer.updated', 'applied', ?, NULL, 1, NULL, ?, ?, ?, NULL)`,
    ).run(
      "privacy-durable-envelope",
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
    );

    const service = createBusinessService(repository);
    await expect(service.runPrivacyRetention()).resolves.toMatchObject({
      asOf: NOW,
      policyVersion: "2026-08-03",
      authSessionsDeleted: 1_001,
      stripeEnvelopesDeleted: 0,
      processedCount: 1_001,
      progressed: true,
      batches: 3,
      batchSize: 500,
      batchBudget: 20,
      batchBudgetExhausted: false,
      hasMore: true,
      hasActionableMore: false,
      stalled: false,
      stopReason: "deferred_stripe_envelopes",
      stripeEnvelopeDeletionDeferred: true,
      stripeEnvelopesAwaitingTombstoneInBatch: 1,
    });
    expect(database.prepare(
      "SELECT count(*) AS count FROM auth_sessions WHERE token_hash LIKE 'privacy-expired-%'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT count(*) AS count FROM stripe_webhook_events WHERE id = 'privacy-durable-envelope'",
    ).get()).toEqual({ count: 1 });
    await expect(service.runPrivacyRetention()).resolves.toMatchObject({
      processedCount: 0,
      batches: 1,
      hasMore: true,
      hasActionableMore: false,
      stalled: true,
      stopReason: "deferred_stripe_envelopes",
    });
  });

  it("stops repeated privacy batches without double-counting and surfaces the stall", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const repeated = privacyRetentionBatch({
      authSessionsDeleted: 1,
      processedCount: 1,
      progressed: true,
      hasMore: true,
      hasActionableMore: true,
    });
    const prune = vi.spyOn(privacyRetentionRepositories.get(repository)!, "prunePrivacyRetention")
      .mockResolvedValue(repeated);

    await expect(service.runPrivacyRetention()).resolves.toMatchObject({
      authSessionsDeleted: 1,
      processedCount: 1,
      batches: 1,
      hasMore: true,
      hasActionableMore: true,
      stalled: true,
      stopReason: "duplicate_batch",
      batchBudgetExhausted: false,
    });
    expect(prune).toHaveBeenCalledTimes(2);
    expect(prune.mock.calls[0]?.[0]).toMatchObject({
      asOf: NOW,
      authSessionCutoff: "2026-04-04T08:00:00.000Z",
      batchLimit: 500,
    });
  });

  it("caps actionable privacy work at the per-run batch budget", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const prune = vi.spyOn(privacyRetentionRepositories.get(repository)!, "prunePrivacyRetention")
      .mockImplementation(async () => privacyRetentionBatch({
        authSessionsDeleted: 1,
        processedCount: 1,
        progressed: true,
        hasMore: true,
        hasActionableMore: true,
      }));

    await expect(service.runPrivacyRetention()).resolves.toMatchObject({
      authSessionsDeleted: 20,
      processedCount: 20,
      batches: 20,
      hasMore: true,
      hasActionableMore: true,
      stalled: false,
      stopReason: "batch_budget_exhausted",
      batchBudgetExhausted: true,
    });
    expect(prune).toHaveBeenCalledTimes(20);
    expect(new Set(prune.mock.calls.map(([input]) => input.asOf))).toEqual(new Set([NOW]));
  });

  it("stops an actionable privacy backlog that makes no progress", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const prune = vi.spyOn(privacyRetentionRepositories.get(repository)!, "prunePrivacyRetention")
      .mockResolvedValue(privacyRetentionBatch({
        hasMore: true,
        hasActionableMore: true,
        stalled: true,
      }));

    await expect(service.runPrivacyRetention()).resolves.toMatchObject({
      processedCount: 0,
      batches: 1,
      hasMore: true,
      hasActionableMore: true,
      stalled: true,
      stopReason: "actionable_stall",
      batchBudgetExhausted: false,
    });
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it("extracts multi-image photo submissions, matches catalogue names, and quarantines new OCR beers", async () => {
    const { repository } = createRepository();
    const menuPhotoOcr: NonNullable<ConstructorParameters<typeof BusinessService>[31]> = {
      extract: vi.fn(async ({ imageDataUrls }) => ({
        model: "gpt-5.5",
        imageCount: imageDataUrls.length,
        venueNameGuess: "OCR Review Bar",
        capturedNotes: null,
        overallConfidence: 0.93,
        rejectedCandidateCount: 1,
        beers: [
          {
            name: "Carlton Draughr",
            brewery: "Carlton & United Breweries",
            abv: 4.6,
            servingSize: "pint",
            priceNumeric: 14,
            priceText: "$7 / $10 / $14",
            availabilityStatus: "on_tap",
            availableOnTap: true,
            availablePackageOnly: false,
            unavailableReason: null,
            needsReview: false,
            confidence: 0.95,
            notes: "ABV: 4.6%.",
            sourceText: "Carlton Draughr 4.6% $7 / $10 / $14",
          },
          {
            name: "Moonbeam Rice Lager",
            brewery: "Moonbeam Brewing",
            abv: 5.1,
            servingSize: "pint",
            priceNumeric: 16,
            priceText: "$16 pint",
            availabilityStatus: "on_tap",
            availableOnTap: true,
            availablePackageOnly: false,
            unavailableReason: null,
            needsReview: true,
            confidence: 0.9,
            notes: null,
            sourceText: "Moonbeam Rice Lager - pint $16",
          },
          {
            name: "Decorative House Lager",
            brewery: null,
            abv: null,
            servingSize: "pint",
            priceNumeric: 15,
            priceText: "$15",
            availabilityStatus: "on_tap",
            availableOnTap: true,
            availablePackageOnly: false,
            unavailableReason: null,
            needsReview: true,
            confidence: 0.86,
            notes: null,
            sourceText: "Decorative House Lager $15",
          },
          {
            name: "Premium Northern Victorian T bone",
            brewery: null,
            abv: null,
            servingSize: "pint",
            priceNumeric: 30,
            priceText: "$30",
            availabilityStatus: "unknown",
            availableOnTap: null,
            availablePackageOnly: false,
            unavailableReason: null,
            needsReview: true,
            confidence: 0.88,
            notes: null,
            sourceText: "Premium Northern Victorian T bone $30",
          },
        ],
      })),
    };
    const service = createBusinessService(repository, {
      PUBLIC_BASE_URL: "https://beer.example.test",
    }, menuPhotoOcr);
    const owner = createAccount(repository, "photo-ocr-owner");
    const admin = createAccount(repository, "photo-ocr-admin", "admin");

    const result = await service.createUserSubmission(owner, createSubmissionSchema.parse({
      clientSubmissionId: "photo-ocr-submission-1",
      venueId: "venue-photo-ocr",
      venueName: "OCR Review Bar",
      suburb: "Melbourne",
      submissionType: "photo_upload",
      observedAt: NOW,
      sourcePhotoDataUrl: null,
      sourcePhotoDataUrls: [PNG_DATA_URL, JPEG_DATA_URL],
      sourcePhotoUrl: null,
      notes: null,
      items: [{
        beerName: "Guinness",
        servingSize: "pint",
        price: 15,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }));

    expect(menuPhotoOcr.extract).toHaveBeenCalledWith(expect.objectContaining({
      imageDataUrls: [PNG_DATA_URL, JPEG_DATA_URL],
    }));
    expect(result.ocrStatus).toBe("processed");
    expect(result.statusCopy).toContain("OCR read 3 beer rows");
    expect(result.statusCopy).not.toContain("OCR read 4 beer rows");
    expect(result.statusCopy).toContain("Carlton Draught ($14 pint)");
    expect(result.statusCopy).toContain("Moonbeam Rice Lager ($16 pint)");
    expect(result.submission.ocrSummary).toEqual(expect.objectContaining({
      model: "gpt-5.5",
      imageCount: 2,
      extractedRowCount: 3,
      pendingCatalogCount: 2,
    }));
    const detail = repository.getSubmissionById(result.submission.id)!;
    expect(detail.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        beerName: "Carlton Draught",
        normalizedBeerId: "carlton_draft",
        captureSource: "photo_ocr",
        requiresCatalogApproval: false,
      }),
      expect.objectContaining({
        beerName: "Moonbeam Rice Lager",
        normalizedBeerId: "moonbeam_rice_lager",
        requiresCatalogApproval: true,
        sourceText: "Moonbeam Rice Lager - pint $16",
      }),
    ]));
    expect(detail.items.map((item) => item.beerName)).not.toContain("Premium Northern Victorian T bone");
    const adminCatalog = await service.getAdminBeerCatalog(admin);
    expect(adminCatalog.pending).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "moonbeam_rice_lager",
        name: "Moonbeam Rice Lager",
        brewery: "Moonbeam Brewing",
        abv: 5.1,
      }),
      expect.objectContaining({ key: "decorative_house_lager", name: "Decorative House Lager" }),
    ]));
    expect(adminCatalog.pending).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: expect.stringMatching(/T bone/i) }),
    ]));

    const signedEvidence = await service.getSubmissionSourceEvidenceUrl(owner, result.submission.id);
    expect(signedEvidence.signedUrls).toHaveLength(2);
    await expect(service.reviewSubmission(admin, result.submission.id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    })).rejects.toThrow("Approve, merge, or reject every new beer name");

    await service.rejectBeerCatalogItem(admin, "decorative_house_lager", {
      reviewNote: "Decorative OCR copy, not a beer.",
    });
    expect(repository.getSubmissionById(result.submission.id)!.items.map((item) => item.beerName))
      .not.toContain("Decorative House Lager");
    await service.approveBeerCatalogItem(admin, "moonbeam_rice_lager", {
      reviewNote: "Verified from source image.",
    });
    expect(repository.getSubmissionById(result.submission.id)!.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ beerName: "Moonbeam Rice Lager", requiresCatalogApproval: false }),
    ]));
    expect((await service.reviewSubmission(admin, result.submission.id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    })).submission.status).toBe("approved");
    expect((await publicPriceRepositories.get(repository)!.listLatestPriceRecords(20, "venue-photo-ocr")).map((record) => record.beerName))
      .toEqual(expect.arrayContaining(["Carlton Draught", "Moonbeam Rice Lager"]));
    expect((await publicPriceRepositories.get(repository)!.listLatestPriceRecords(20, "venue-photo-ocr")).map((record) => record.beerName))
      .not.toContain("Decorative House Lager");
  });

  it("supports demo billing without Stripe keys and requires Stripe config when demo billing is off", async () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "billing-user");
    const demoService = createBusinessService(repository);
    const stripeService = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: undefined,
      STRIPE_PRICE_MONTHLY: undefined,
    });

    await expect(demoService.createCheckout(user, { plan: "monthly" })).resolves.toMatchObject({ mode: "demo" });
    expect((await demoService.handleDemoSubscription(user, "monthly")).account.subscriptionStatus).toBe("premium_monthly");
    await expect(stripeService.createCheckout(user, { plan: "monthly" })).rejects.toThrow("Stripe checkout is not configured");
    await expect(stripeService.handleDemoSubscription(user, "monthly")).rejects.toThrow("Demo billing is not enabled");
  });

  it("fails closed for every deferred venue surface when commercial launch is disabled", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository, {
      COMMERCIAL_LAUNCH_ENABLED: false,
      CONSUMER_PAID_ENROLLMENT_ENABLED: false,
    });
    const user = repository.updateSubscription({
      userId: createAccount(repository, "commercial-gate-user").id,
      subscriptionStatus: "free",
      stripePaidSubscriptionStatus: null,
      stripeCustomerId: "cus_commercial_gate_existing",
      premiumUntil: null,
      now: NOW,
    });
    const admin = createAccount(repository, "commercial-gate-admin", "admin");
    const manager = createAccount(repository, "commercial-gate-manager");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "commercial-gate-venue",
      venueName: "Commercial Gate Hotel",
      suburb: "Carlton",
    });
    await service.upsertBarProfile(admin, "commercial-gate-venue", {
      name: "Commercial Gate Hotel",
      address: null,
      suburb: "Carlton",
      area: "Carlton",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      acceptsPintPathCodes: false,
      active: true,
    });
    database.prepare(
      `UPDATE venue_profiles
       SET stripe_customer_id = ?,
           stripe_subscription_id = ?,
           subscription_status = ?
       WHERE venue_id = ?`,
    ).run(
      "cus_commercial_gate_venue_existing",
      "sub_commercial_gate_venue_cancelled",
      "canceled",
      "commercial-gate-venue",
    );

    expect(await service.getPublicConfig()).toEqual(expect.objectContaining({
      commercialLaunchEnabled: false,
      consumerPaidEnrollmentEnabled: false,
      demoBillingMode: false,
      pintPointsRewardsEnabled: false,
      alcoholGamificationEnabled: false,
      pricing: null,
      venueProTrialDays: 0,
      venueProTrialRequiresPaymentMethod: false,
    }));
    const deferredAccess = service.getAccessState(user, null);
    expect(deferredAccess).toEqual(expect.objectContaining({
      canUseHappyHourActiveNow: false,
      canViewSpecialDiscounts: false,
      canUseDiscountPass: false,
      premiumToolkit: expect.objectContaining({
        title: "Unlock the full map toolkit",
        primaryAction: { label: "Upload venue data", href: "/submit.html" },
      }),
    }));
    expect(JSON.stringify(deferredAccess)).not.toMatch(/A\$(?:4\.99|50|149)/);
    expect(JSON.stringify(deferredAccess)).not.toContain("Upgrade monthly");
    const freePortal = await service.getVenuePortal(repository.getAccountById(manager.id)!, {
      venueId: "commercial-gate-venue",
    });
    expect(freePortal).toEqual(expect.objectContaining({
      billing: null,
      profile: expect.objectContaining({
        membershipTier: "basic",
        acceptsPintPathCodes: false,
        stripeCustomerId: null,
      }),
      tier: expect.objectContaining({
        tier: "basic",
        canManageSpecials: false,
        analytics: false,
        monthlyReports: false,
        upgradeCopy: null,
      }),
      inventory: expect.objectContaining({ specials: [] }),
      analytics: null,
      monthlyReport: null,
      businessToolkit: null,
      discounts: null,
      pintPoints: null,
      posIntegration: null,
      staffAssignments: [],
    }));
    const freeCounterInvitation = await getVenueAccessRepository(repository).inviteCounterStaff({
      invitationToken: crypto.randomUUID(),
      inviterAccountId: admin.id,
      userId: user.id,
      venueId: "commercial-gate-venue",
      venueName: "Commercial Gate Hotel",
      suburb: "Carlton",
      now: NOW,
      expiresAt: "2026-05-07T08:00:00.000Z",
    });
    await getVenueAccessRepository(repository).respondToCounterStaffInvitation({
      invitationToken: freeCounterInvitation.assignment.id,
      userId: user.id,
      decision: "accept",
      now: NOW,
    });
    const freeAccount = repository.getAccountById(user.id)!;
    const freeAccountDashboard = await service.getAccountDashboard(freeAccount);
    expect((await service.getAuthSession(freeAccount)).counterStaffAssignments).toEqual([]);
    expect(freeAccountDashboard).toEqual(expect.objectContaining({
      billing: null,
      counterStaffInvitations: [],
      counterStaffAssignments: [],
      discounts: expect.objectContaining({
        eligible: false,
        totalRedemptions: 0,
        recentRedemptions: [],
      }),
      pintPoints: null,
      rewards: expect.objectContaining({ vouchers: [] }),
      betaTesting: expect.objectContaining({
        enabled: false,
        pubGolf: expect.objectContaining({ enabled: false, defaultDrinks: [] }),
        canIDrive: expect.objectContaining({ enabled: false, sourceDrinkLimit: 0 }),
      }),
    }));
    expect(freeAccountDashboard.rewards).toEqual(expect.objectContaining({
      status: "paused",
      eligiblePlaceholder: false,
      ageGatedEligible: false,
      vouchers: [],
    }));
    expect(freeAccountDashboard.premiumMemberToolkit.perks.map((perk) => perk.id))
      .not.toContain("discount_pass");
    expect(await service.getLeaderboard(freeAccount, { period: "month", limit: 50 }))
      .toEqual(expect.objectContaining({ disabled: true, campaign: null, podium: [], entries: [] }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM leaderboard_prize_campaigns").get())
      .toEqual({ count: 0 });
    expect(JSON.stringify(freeAccountDashboard)).not.toContain("openCounter");

    await service.upsertBarBeer(repository.getAccountById(manager.id)!, "commercial-gate-venue", {
      id: null,
      beerName: "Guinness",
      brewery: "Guinness",
      style: "Stout",
      abv: 4.2,
      serveSize: "pint",
      price: 13,
      onTap: true,
      inStock: true,
      notes: null,
      priceConfirmed: true,
      stockConfirmed: true,
    });
    database.prepare(
      `UPDATE venue_profiles
       SET membership_tier = 'pro',
           highlighted_name = 1,
           premium_badge = 'Stored Pro',
           promoted = 1,
           featured_special_eligible = 1,
           accepts_pint_path_codes = 1
       WHERE venue_id = ?`,
    ).run("commercial-gate-venue");
    const expectFreePublicVenueMetadata = (value: unknown) => expect(value).toEqual(expect.objectContaining({
      membershipTier: "basic",
      highlightedName: false,
      premiumBadge: null,
      promoted: false,
      featuredSpecialEligible: false,
      acceptsPintPathCodes: false,
    }));
    expectFreePublicVenueMetadata(await service.getPublicVenueById("commercial-gate-venue"));
    const publicVenueRow = (await service.listVenues("Commercial Gate Hotel", 20))
      .find((venue) => venue.id === "commercial-gate-venue");
    expectFreePublicVenueMetadata(publicVenueRow);
    const publicPriceRow = (await service.listPriceRecords(null, {
      venueId: "commercial-gate-venue",
      limit: 20,
      anonymousSessionId: "commercial-gate-public-prices",
    })).records.find((record) => record.venueId === "commercial-gate-venue");
    expectFreePublicVenueMetadata(publicPriceRow);
    database.prepare(
      `UPDATE venue_profiles
       SET membership_tier = 'basic',
           highlighted_name = 0,
           premium_badge = NULL,
           promoted = 0,
           featured_special_eligible = 0,
           accepts_pint_path_codes = 0
       WHERE venue_id = ?`,
    ).run("commercial-gate-venue");
    const expectDeferredVenueFeature = async (callback: () => unknown) => {
      await expect(Promise.resolve().then(callback)).rejects.toMatchObject({
        statusCode: 404,
        details: { publicCode: "COMMERCIAL_VENUE_FEATURE_DISABLED" },
      });
    };
    await expectDeferredVenueFeature(() => service.getVenueReconciliation(
      repository.getAccountById(manager.id)!,
      "commercial-gate-venue",
      { limit: 20, offset: 0 },
    ));
    await expectDeferredVenueFeature(() => service.getVenueMonthlyReport(
      repository.getAccountById(manager.id)!,
      "commercial-gate-venue",
      "2026-04",
    ));
    await expectDeferredVenueFeature(() => service.getVenuePosIntegration(
      repository.getAccountById(manager.id)!,
      "commercial-gate-venue",
    ));
    await expectDeferredVenueFeature(() => service.upsertBarSpecial(
      repository.getAccountById(manager.id)!,
      "commercial-gate-venue",
      {} as never,
    ));
    await expectDeferredVenueFeature(() => service.getLeaderboardPrizeAdmin(admin));
    await expectDeferredVenueFeature(() => service.transitionRewardVoucher(admin, "missing-reward", {} as never));
    await expect(service.planPubGolf(freeAccount, {} as never)).rejects.toMatchObject({
      statusCode: 404,
      details: { publicCode: "COMMERCIAL_VENUE_FEATURE_DISABLED" },
    });
    await expect(service.handleStripeWebhook(undefined, undefined)).rejects.toMatchObject({
      statusCode: 404,
      details: { publicCode: "COMMERCIAL_VENUE_FEATURE_DISABLED" },
    });
    await expect(service.createSuspendedAccountBillingPortal({} as never)).rejects.toMatchObject({
      statusCode: 404,
      details: { publicCode: "COMMERCIAL_VENUE_FEATURE_DISABLED" },
    });
    await expect(service.createCheckout(user, { plan: "monthly" })).rejects.toMatchObject({
      statusCode: 404,
      details: { publicCode: "COMMERCIAL_VENUE_FEATURE_DISABLED" },
      message: expect.stringContaining("current Free release"),
    });
    await expect(service.handleDemoSubscription(user, "monthly"))
      .rejects.toThrow("current Free release");
    await expect(service.createBarTierCheckout(
      repository.getAccountById(manager.id)!,
      "commercial-gate-venue",
      { tier: "pro" },
    )).rejects.toMatchObject({
      statusCode: 404,
      details: { publicCode: "COMMERCIAL_VENUE_FEATURE_DISABLED" },
    });
    expect(repository.getAccountById(user.id)?.stripeCustomerId).toBe("cus_commercial_gate_existing");
    expect(repository.getBarProfile("commercial-gate-venue")?.membershipTier).toBe("basic");
    expect(repository.getBarProfile("commercial-gate-venue")?.stripeCustomerId)
      .toBe("cus_commercial_gate_venue_existing");
  });

  it("can open the venue offer without opening out-of-scope consumer paid enrollment", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      COMMERCIAL_LAUNCH_ENABLED: true,
      CONSUMER_PAID_ENROLLMENT_ENABLED: false,
    });
    const user = createAccount(repository, "venue-only-launch-user");
    const admin = createAccount(repository, "venue-only-launch-admin", "admin");
    const manager = createAccount(repository, "venue-only-launch-manager");
    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "venue-only-launch-venue",
      venueName: "Venue Only Launch Hotel",
      suburb: "Carlton",
    });

    await expect(service.createCheckout(user, { plan: "monthly" })).rejects.toMatchObject({
      details: { publicCode: "CONSUMER_PAID_ENROLLMENT_DISABLED" },
    });
    await expect(service.createBarTierCheckout(
      repository.getAccountById(manager.id)!,
      "venue-only-launch-venue",
      { tier: "pro" },
    )).resolves.toMatchObject({
      mode: "demo",
      profile: { membershipTier: "pro" },
    });
  });

  it("surfaces actionable Stripe checkout setup failures without exposing secrets", async () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "stripe-setup-user");
    const originalFetch = globalThis.fetch;
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRICE_MONTHLY: "price_missing_monthly",
      STRIPE_PRICE_YEARLY: "price_missing_yearly",
    });

    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        error: {
          message: "No such price: 'price_missing_monthly'",
        },
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

      await expect(service.createCheckout(user, { plan: "monthly" })).rejects.toThrow(
        "Stripe price ID was not found",
      );

      globalThis.fetch = (async () => new Response(JSON.stringify({
        error: {
          message: "Invalid API Key provided",
        },
      }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

      await expect(service.createCheckout(user, { plan: "yearly" })).rejects.toThrow(
        "Stripe rejected the secret key",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("adds a Checkout Session ID to Stripe success returns and can reconcile completed sessions", async () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "stripe-return-user");
    const originalFetch = globalThis.fetch;
    let checkoutRequestBody = "";
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRICE_MONTHLY: "price_test_monthly",
      STRIPE_PRICE_YEARLY: "price_test_yearly",
    });

    try {
      const checkoutFetch = vi.fn(async (_url, init) => {
        checkoutRequestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({
          id: "cs_test_return",
          url: "https://checkout.stripe.com/c/pay/cs_test_return",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      globalThis.fetch = checkoutFetch as typeof fetch;

      await expect(service.createCheckout(user, { plan: "monthly" })).resolves.toMatchObject({ mode: "stripe" });
      await expect(service.createCheckout(user, { plan: "monthly" })).resolves.toMatchObject({
        mode: "stripe",
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_return",
        message: expect.stringContaining("existing Stripe Checkout session"),
      });
      expect(checkoutFetch).toHaveBeenCalledTimes(1);
      const checkoutParams = new URLSearchParams(checkoutRequestBody);
      expect(checkoutParams.get("mode")).toBe("subscription");
      expect(checkoutParams.get("automatic_tax[enabled]")).toBe("true");
      expect(Number(checkoutParams.get("expires_at"))).toBe(
        Math.floor((Date.parse(NOW) + 35 * 60 * 1_000) / 1_000),
      );
      expect(checkoutParams.get("billing_address_collection")).toBeNull();
      expect(checkoutParams.get("tax_id_collection[enabled]")).toBeNull();
      expect(checkoutParams.get("line_items[0][price]")).toBe("price_test_monthly");
      expect(decodeURIComponent(checkoutRequestBody)).toContain("checkout=success");
      expect(decodeURIComponent(checkoutRequestBody)).toContain("session_id={CHECKOUT_SESSION_ID}");

      globalThis.fetch = (async (url) => {
        if (String(url).includes("/v1/subscriptions/sub_test_return")) {
          return new Response(JSON.stringify({
            id: "sub_test_return",
            status: "active",
            customer: "cus_test_return",
            current_period_end: Math.floor(Date.now() / 1000) + 3600,
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        expect(String(url)).toContain("/v1/checkout/sessions/cs_test_return");
        return new Response(JSON.stringify({
          id: "cs_test_return",
          status: "complete",
          payment_status: "paid",
          customer: "cus_test_return",
          subscription: "sub_test_return",
          metadata: {
            user_id: user.id,
            subscription_status: "premium_monthly",
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const reconciled = await service.reconcileCheckoutSession(user, { sessionId: "cs_test_return" });
      expect(reconciled.account.subscriptionStatus).toBe("premium_monthly");
      expect(reconciled.message).toContain("Premium access");
      expect(repository.getAccountById(user.id)?.stripeCustomerId).toBe("cus_test_return");
      expect((await listSecurityAuditLogs(repository, 10)).some((row) => row.action === "stripe_subscription_update")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reuses one durable token when overlapping HTTP checkout requests reach Stripe together", async () => {
    const { database, repository } = createRepository();
    const user = createAccount(repository, "http-checkout-race-user");
    const authorization = createSession(
      repository,
      user.id,
      "http-checkout-race-token-with-enough-entropy-123456789",
    );
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRICE_MONTHLY: "price_test_monthly",
      STRIPE_PRICE_YEARLY: "price_test_yearly",
    });
    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);

    const networkFetch = globalThis.fetch;
    let releaseProviders!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProviders = resolve;
    });
    const providerIdempotencyKeys: string[] = [];
    let secondProviderStarted!: () => void;
    const bothProvidersStarted = new Promise<void>((resolve) => {
      secondProviderStarted = resolve;
    });
    const routedFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("http://127.0.0.1:")) return networkFetch(url, init);
      expect(String(url)).toBe("https://api.stripe.com/v1/checkout/sessions");
      const headers = init?.headers as Record<string, string> | undefined;
      providerIdempotencyKeys.push(headers?.["Idempotency-Key"] ?? "");
      if (providerIdempotencyKeys.length === 2) secondProviderStarted();
      await providerGate;
      return new Response(JSON.stringify({
        id: "cs_http_checkout_race",
        url: "https://checkout.stripe.com/c/pay/cs_http_checkout_race",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = routedFetch as typeof fetch;

    try {
      await withHttpServer(app, async (baseUrl) => {
        const request = () => fetch(`${baseUrl}/api/business/billing/checkout`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ plan: "monthly" }),
        });
        const first = request();
        const second = request();
        await bothProvidersStarted;
        releaseProviders();
        const responses = await Promise.all([first, second]);
        expect(responses.map((response) => response.status)).toEqual([201, 201]);
        const payloads = await Promise.all(responses.map((response) => response.json()));
        expect(payloads).toEqual([
          expect.objectContaining({
            data: expect.objectContaining({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_http_checkout_race" }),
          }),
          expect.objectContaining({
            data: expect.objectContaining({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_http_checkout_race" }),
          }),
        ]);
      });

      expect(providerIdempotencyKeys).toHaveLength(2);
      expect(new Set(providerIdempotencyKeys).size).toBe(1);
      expect(providerIdempotencyKeys[0]).toMatch(/^[a-f0-9]{64}$/);
      expect(database.prepare(
        `SELECT count(*) AS count
           FROM billing_checkout_reservations
          WHERE subject_type = 'consumer' AND subject_id = ?`,
      ).get(user.id)).toEqual({ count: 1 });
    } finally {
      globalThis.fetch = networkFetch;
    }
  });

  it("rejects HTTP checkout finalization when deletion starts during provider I/O", async () => {
    const { database, repository } = createRepository();
    const user = createAccount(repository, "http-checkout-deletion-race-user");
    const admin = createAccount(repository, "http-checkout-deletion-race-admin", "admin");
    const authorization = createSession(
      repository,
      user.id,
      "http-checkout-deletion-race-token-with-enough-entropy-123456789",
    );
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRICE_MONTHLY: "price_test_monthly",
      STRIPE_PRICE_YEARLY: "price_test_yearly",
    });
    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);

    const networkFetch = globalThis.fetch;
    let providerStarted!: () => void;
    const providerStart = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerCalls = 0;
    globalThis.fetch = (async (url, init) => {
      if (String(url).startsWith("http://127.0.0.1:")) return networkFetch(url, init);
      expect(String(url)).toBe("https://api.stripe.com/v1/checkout/sessions");
      providerCalls += 1;
      providerStarted();
      await providerGate;
      return new Response(JSON.stringify({
        id: "cs_http_checkout_deletion_race",
        url: "https://checkout.stripe.com/c/pay/cs_http_checkout_deletion_race",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      await withHttpServer(app, async (baseUrl) => {
        const checkout = fetch(`${baseUrl}/api/business/billing/checkout`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ plan: "monthly" }),
        });
        await providerStart;

        const deletionQueue = accountDeletionQueueRepositories.get(repository)!;
        const request = await deletionQueue.createAccountDeletionRequest({
          id: "http-checkout-deletion-race-request",
          userId: user.id,
          userMessage: null,
          requestedAt: NOW,
          executeAfter: new Date(Date.parse(NOW) + 7 * 24 * 60 * 60_000).toISOString(),
        });
        await expect(deletionQueue.beginAccountDeletion({
          requestId: request.id,
          reviewedBy: admin.id,
          now: NOW,
          staleBefore: new Date(Date.parse(NOW) - 60_000).toISOString(),
        })).resolves.toMatchObject({ status: "processing" });

        releaseProvider();
        const response = await checkout;
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual(expect.objectContaining({
          error: expect.objectContaining({
            message: "Billing changes are unavailable while account deletion is being processed.",
          }),
        }));
      });

      expect(providerCalls).toBe(1);
      expect(database.prepare(
        `SELECT stripe_checkout_session_id, checkout_url
           FROM billing_checkout_reservations
          WHERE subject_type = 'consumer' AND subject_id = ?`,
      ).get(user.id)).toEqual({ stripe_checkout_session_id: null, checkout_url: null });
    } finally {
      releaseProvider();
      globalThis.fetch = networkFetch;
    }
  });

  it("rejects Checkout Session reconciliation for wrong users or incomplete payments", async () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "stripe-owner-user");
    const otherUser = createAccount(repository, "stripe-other-user");
    const originalFetch = globalThis.fetch;
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
    });

    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        id: "cs_test_wrong_user",
        status: "complete",
        payment_status: "paid",
        customer: "cus_wrong",
        metadata: {
          user_id: otherUser.id,
          subscription_status: "premium_yearly",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

      await expect(service.reconcileCheckoutSession(user, { sessionId: "cs_test_wrong_user" })).rejects.toThrow(
        "does not belong to your account",
      );
      expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("free");

      globalThis.fetch = (async () => new Response(JSON.stringify({
        id: "cs_test_incomplete",
        status: "open",
        payment_status: "unpaid",
        metadata: {
          user_id: user.id,
          subscription_status: "premium_yearly",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

      await expect(service.reconcileCheckoutSession(user, { sessionId: "cs_test_incomplete" })).rejects.toThrow(
        "payment is not settled",
      );
      expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("free");

      globalThis.fetch = (async () => new Response(JSON.stringify({
        id: "cs_test_complete_unpaid",
        status: "complete",
        payment_status: "unpaid",
        customer: "cus_unpaid",
        metadata: {
          user_id: user.id,
          subscription_status: "premium_monthly",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
      await expect(service.reconcileCheckoutSession(user, { sessionId: "cs_test_complete_unpaid" }))
        .rejects.toThrow("payment is not settled");
      expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("free");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("serves provider configuration without reusable browser or CDN caching", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      SUPABASE_URL: "https://pint-path-auth.supabase.co",
      SUPABASE_ANON_KEY: "public-anon-key",
      SUPABASE_OAUTH_PROVIDERS: "google,apple",
    });
    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/business/config`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual(expect.objectContaining({
        data: expect.objectContaining({
          supabaseOauthProviders: ["google", "apple"],
        }),
      }));
    });
  });

  it("disconnects restored sessions and browser Supabase config without touching session state", async () => {
    const { database, repository } = createRepository();
    const account = createAccount(repository, "restore-session-user");
    const token = "restore-session-token-with-enough-entropy-123456789";
    const authorization = createSession(repository, account.id, token);
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const sessionBefore = database.prepare(
      "SELECT last_used_at, last_ip_hash, user_agent_hash FROM auth_sessions WHERE token_hash = ?",
    ).get(tokenHash);
    const service = createBusinessService(repository, {
      RESTORE_REHEARSAL_MODE: true,
      SUPABASE_URL: "https://restore-staging.supabase.co",
      SUPABASE_ANON_KEY: "restore-staging-browser-key",
      SUPABASE_OAUTH_PROVIDERS: "google,apple",
    });

    expect(await service.getAccountFromAuthorization(authorization, {
      ip: "203.0.113.10",
      userAgent: "Restore rehearsal browser",
    })).toBeNull();
    expect(await service.getPublicConfig()).toEqual(expect.objectContaining({
      supabaseUrl: null,
      supabaseAnonKey: null,
      supabaseOauthProviders: [],
    }));

    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);
    await withHttpServer(app, async (baseUrl) => {
      const configResponse = await fetch(`${baseUrl}/api/business/config`);
      expect(configResponse.status).toBe(200);
      expect(await configResponse.json()).toEqual(expect.objectContaining({
        data: expect.objectContaining({
          supabaseUrl: null,
          supabaseAnonKey: null,
          supabaseOauthProviders: [],
        }),
      }));

      const accessResponse = await fetch(`${baseUrl}/api/business/access`, {
        headers: { authorization },
      });
      expect(accessResponse.status).toBe(200);
    });

    expect(database.prepare(
      "SELECT last_used_at, last_ip_hash, user_agent_hash FROM auth_sessions WHERE token_hash = ?",
    ).get(tokenHash)).toEqual(sessionBefore);
  });

  it("rejects expired, revoked, and suspended sessions and supports logout flows", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const signup = await service.signup({
      email: "session-user@example.com",
      password: "password123",
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
    }, {
      ip: "203.0.113.10",
      userAgent: "Vitest Browser",
    });
    const authHeader = `Bearer ${signup.token}`;

    expect((await service.getAccountFromAuthorization(authHeader, {
      ip: "203.0.113.10",
      userAgent: "Vitest Browser",
    }))?.email).toBe("session-user@example.com");
    const touched = database
      .prepare("SELECT last_used_at, last_ip_hash, user_agent_hash FROM auth_sessions LIMIT 1")
      .get() as { last_used_at: string | null; last_ip_hash: string | null; user_agent_hash: string | null } | undefined;
    expect(touched?.last_used_at).toBeTruthy();
    expect(touched?.last_ip_hash).toHaveLength(32);
    expect(touched?.user_agent_hash).toHaveLength(32);

    expect((await service.logout(authHeader)).revoked).toBe(true);
    expect(await service.getAccountFromAuthorization(authHeader)).toBeNull();

    const second = await service.login({ email: "session-user@example.com", password: "password123" });
    expect((await service.logoutAll(await service.requireAccount(`Bearer ${second.token}`))).revokedCount).toBeGreaterThanOrEqual(1);
    expect(await service.getAccountFromAuthorization(`Bearer ${second.token}`)).toBeNull();

    const expired = await service.login({ email: "session-user@example.com", password: "password123" });
    database
      .prepare("UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?")
      .run("2020-01-01T00:00:00.000Z", crypto.createHash("sha256").update(expired.token).digest("hex"));
    expect(await service.getAccountFromAuthorization(`Bearer ${expired.token}`)).toBeNull();

    const suspended = await service.login({ email: "session-user@example.com", password: "password123" });
    database.prepare("UPDATE accounts SET status = 'suspended', updated_at = ? WHERE id = ?")
      .run(NOW, signup.account.id);
    database.prepare("UPDATE profiles SET account_status = 'suspended', updated_at = ? WHERE id = ?")
      .run(NOW, signup.account.id);
    expect(await service.getAccountFromAuthorization(`Bearer ${suspended.token}`)).toBeNull();
  });

  it("keeps only the ten most recently used active app sessions per account", async () => {
    const { database, repository } = createRepository();
    const account = createAccount(repository, "session-cap-user");
    for (let index = 0; index < 12; index += 1) {
      const createdAt = new Date(Date.parse(NOW) + index * 1000).toISOString();
      repository.createSession({
        tokenHash: `session-cap-${String(index).padStart(2, "0")}`,
        userId: account.id,
        createdAt,
        expiresAt: PREMIUM_UNTIL,
        lastUsedAt: createdAt,
        providerSessionIdHash: index === 0 ? "provider-session-evicted-by-cap" : null,
      });
    }
    repository.createDiscountPass({
      id: "session-cap-discount-pass",
      userId: account.id,
      sessionTokenHash: "session-cap-00",
      codeHash: "session-cap-discount-code-hash",
      createdAt: NOW,
      expiresAt: PREMIUM_UNTIL,
    });

    expect(repository.revokeExcessActiveSessions({
      userId: account.id,
      now: NOW,
      maxActiveSessions: 10,
    })).toEqual({
      revokedSessions: 2,
      revokedDiscountPasses: 1,
      revokedProviderSessions: 1,
    });
    expect(database.prepare(
      `SELECT token_hash FROM auth_sessions
       WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY last_used_at DESC`,
    ).all(account.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => ({
        token_hash: `session-cap-${String(11 - index).padStart(2, "0")}`,
      })),
    );
    expect(repository.getAccountBySessionTokenHash("session-cap-00", NOW)).toBeNull();
    expect(repository.getAccountBySessionTokenHash("session-cap-11", NOW)?.id).toBe(account.id);
    expect(repository.isProviderSessionRevoked({
      userId: account.id,
      providerSessionIdHash: "provider-session-evicted-by-cap",
    })).toBe(true);
    expect(database.prepare(
      "SELECT status, revoked_at FROM account_discount_passes WHERE id = ?",
    ).get("session-cap-discount-pass")).toEqual({ status: "revoked", revoked_at: NOW });
  });

  it("atomically preserves a newly issued session while enforcing the account cap", async () => {
    const { database, repository } = createRepository();
    const account = createAccount(repository, "atomic-session-cap-user");
    for (let index = 1; index <= 10; index += 1) {
      repository.createSession({
        tokenHash: `atomic-session-${String(index).padStart(2, "0")}`,
        userId: account.id,
        createdAt: NOW,
        expiresAt: PREMIUM_UNTIL,
        lastUsedAt: NOW,
      });
    }

    expect(repository.createSessionWithLimit({
      tokenHash: "atomic-session-00",
      userId: account.id,
      createdAt: NOW,
      expiresAt: PREMIUM_UNTIL,
      lastUsedAt: NOW,
      maxActiveSessions: 10,
    }).revokedSessions).toBe(1);
    expect(repository.getAccountBySessionTokenHash("atomic-session-00", NOW)?.id).toBe(account.id);
    expect(repository.getAccountBySessionTokenHash("atomic-session-01", NOW)).toBeNull();

    expect(() => repository.createSessionWithLimit({
      tokenHash: "atomic-session-rollback",
      userId: account.id,
      createdAt: NOW,
      expiresAt: PREMIUM_UNTIL,
      lastUsedAt: NOW,
      maxActiveSessions: 0,
    })).toThrow("positive integer");
    expect(database.prepare(
      "SELECT 1 FROM auth_sessions WHERE token_hash = ?",
    ).get("atomic-session-rollback")).toBeUndefined();
  });

  it("exposes safe billing-management state and opens only trusted Stripe customer portals", async () => {
    const { database, repository } = createRepository();
    const closedService = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      COMMERCIAL_LAUNCH_ENABLED: false,
      CONSUMER_PAID_ENROLLMENT_ENABLED: false,
      STRIPE_SECRET_KEY: "test-fixture-not-a-real-billing-portal-key",
    });
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      COMMERCIAL_LAUNCH_ENABLED: true,
      CONSUMER_PAID_ENROLLMENT_ENABLED: false,
      STRIPE_SECRET_KEY: "test-fixture-not-a-real-billing-portal-key",
    });
    const unlinkedAccount = updateSubscription(
      repository,
      createAccount(repository, "unlinked-billing-user").id,
      "premium_monthly",
    );
    const linkedAccount = repository.updateSubscription({
      userId: createAccount(repository, "linked-billing-user").id,
      subscriptionStatus: "premium_monthly",
      stripePaidSubscriptionStatus: "premium_monthly",
      stripeCustomerId: "cus_linked_billing_user",
      premiumUntil: null,
      now: NOW,
    });

    expect(await closedService.getAccountDashboard(unlinkedAccount)).toEqual(expect.objectContaining({
      account: expect.not.objectContaining({ stripeCustomerId: expect.anything() }),
      billing: null,
    }));
    expect(await closedService.getAccountDashboard(linkedAccount)).toEqual(expect.objectContaining({
      account: expect.not.objectContaining({ stripeCustomerId: expect.anything() }),
      billing: null,
    }));
    await expect(closedService.createBillingPortal(linkedAccount)).rejects.toMatchObject({
      statusCode: 404,
      details: { publicCode: "COMMERCIAL_VENUE_FEATURE_DISABLED" },
    });
    await expect(closedService.createCheckout(linkedAccount, { plan: "yearly" })).rejects.toMatchObject({
      statusCode: 404,
      details: { publicCode: "COMMERCIAL_VENUE_FEATURE_DISABLED" },
    });

    expect(await service.getAccountDashboard(unlinkedAccount)).toEqual(expect.objectContaining({
      account: expect.not.objectContaining({ stripeCustomerId: expect.anything() }),
      billing: { mode: "unlinked", managementAvailable: false },
    }));
    expect(await service.getAccountDashboard(linkedAccount)).toEqual(expect.objectContaining({
      account: expect.not.objectContaining({ stripeCustomerId: expect.anything() }),
      billing: { mode: "stripe", managementAvailable: true },
    }));
    await expect(service.createBillingPortal(unlinkedAccount)).rejects.toMatchObject({
      statusCode: 409,
      details: { publicCode: "BILLING_CUSTOMER_UNLINKED" },
      message: expect.stringContaining("no Stripe billing profile"),
    });

    const originalFetch = globalThis.fetch;
    const stripeFetch = vi.fn();
    globalThis.fetch = stripeFetch as typeof fetch;
    try {
      stripeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        url: "https://billing.stripe.com/p/session/test_session",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await expect(service.createBillingPortal(linkedAccount)).resolves.toEqual({
        mode: "stripe",
        portalUrl: "https://billing.stripe.com/p/session/test_session",
      });
      const [portalEndpoint, portalInit] = stripeFetch.mock.calls[0] as [string, RequestInit];
      const portalBody = new URLSearchParams(String(portalInit.body));
      expect(portalEndpoint).toBe("https://api.stripe.com/v1/billing_portal/sessions");
      expect(portalBody.get("customer")).toBe("cus_linked_billing_user");
      expect(portalBody.get("return_url")).toBe("http://127.0.0.1:3000/account.html?billing=returned");

      await expect(service.createCheckout(linkedAccount, { plan: "yearly" })).rejects.toMatchObject({
        statusCode: 503,
        details: { publicCode: "CONSUMER_PAID_ENROLLMENT_DISABLED" },
      });

      stripeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: "resource_missing",
          message: "No such customer; a similar object exists in test mode.",
          param: "customer",
          type: "invalid_request_error",
        },
      }), {
        status: 400,
        headers: { "content-type": "application/json", "request-id": "req_mode_mismatch" },
      }));
      await expect(service.createBillingPortal(linkedAccount)).rejects.toMatchObject({
        statusCode: 409,
        details: expect.objectContaining({
          publicCode: "BILLING_CUSTOMER_NOT_FOUND_OR_MODE_MISMATCH",
          stripeRequestId: "req_mode_mismatch",
        }),
      });

      stripeFetch.mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: "No configuration provided and your live mode default configuration has not been created.",
          type: "invalid_request_error",
        },
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }));
      await expect(service.createBillingPortal(linkedAccount)).rejects.toMatchObject({
        statusCode: 503,
        details: expect.objectContaining({ publicCode: "BILLING_PORTAL_NOT_CONFIGURED" }),
      });

      stripeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://example.com/not-stripe" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await expect(service.createBillingPortal(linkedAccount)).rejects.toMatchObject({
        statusCode: 502,
        details: expect.objectContaining({
          publicCode: "BILLING_PORTAL_UNAVAILABLE",
          reason: "untrusted_portal_url",
        }),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a credential-verified billing-only portal available after suspension", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "test-fixture-not-a-real-suspended-billing-key",
    });
    const signup = await service.signup({
      email: "suspended-billing@example.com",
      password: "password123",
      displayName: "Suspended Billing",
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
    });
    const account = repository.getAccountById(signup.account.id)!;
    repository.updateSubscription({
      userId: account.id,
      subscriptionStatus: "premium_monthly",
      stripePaidSubscriptionStatus: "premium_monthly",
      stripeCustomerId: "cus_suspended_billing",
      premiumUntil: null,
      now: NOW,
    });
    database.prepare("UPDATE accounts SET status = 'suspended', updated_at = ? WHERE id = ?")
      .run(NOW, account.id);
    database.prepare("UPDATE profiles SET account_status = 'suspended', updated_at = ? WHERE id = ?")
      .run(NOW, account.id);

    await expect(service.login({ email: account.email, password: "password123" })).rejects.toMatchObject({
      statusCode: 403,
      details: expect.objectContaining({ billingRecoveryEligible: true }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(String(init?.body)).toContain("customer=cus_suspended_billing");
      return new Response(JSON.stringify({ url: "https://billing.stripe.com/p/session/suspended_test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await expect(service.createSuspendedAccountBillingPortal({
        email: account.email,
        password: "password123",
      })).resolves.toEqual(expect.objectContaining({
        portalUrl: "https://billing.stripe.com/p/session/suspended_test",
        accountId: account.publicAccountId,
        message: expect.stringContaining("without restoring application access"),
      }));
      await expect(service.createSuspendedAccountBillingPortal({
        email: account.email,
        password: "wrong-password",
      })).rejects.toMatchObject({ statusCode: 401 });
      expect(await service.getAccountFromAuthorization(`Bearer ${signup.token}`)).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("migrates bearer sessions into HttpOnly cookies and clears them on logout", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const account = createAccount(repository, "session-cookie-user", "admin");
    const token = "session-cookie-token-with-enough-entropy-123456789";
    createSession(repository, account.id, token);
    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use("/api/admin", createAdminRouter({
      getStatus: () => ({ status: "ok" }),
    } as unknown as AdminService, service));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      const migration = await fetch(`${baseUrl}/api/business/auth/session-cookie`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const setCookie = migration.headers.get("set-cookie") ?? "";
      const cookie = setCookie.split(";", 1)[0] ?? "";

      expect(migration.status).toBe(200);
      expect(setCookie).toContain("pint_path_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain("Expires=");

      const accountResponse = await fetch(`${baseUrl}/api/business/account`, {
        headers: { cookie },
      });
      expect(accountResponse.status).toBe(200);
      expect(await accountResponse.json()).toEqual(expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ account: expect.objectContaining({ id: account.id }) }),
      }));

      const adminResponse = await fetch(`${baseUrl}/api/admin/status`, {
        headers: { cookie },
      });
      expect(adminResponse.status).toBe(200);
      expect(await adminResponse.json()).toEqual(expect.objectContaining({
        ok: true,
        data: { status: "ok" },
      }));

      const logout = await fetch(`${baseUrl}/api/business/auth/logout`, {
        method: "POST",
        headers: { cookie },
      });
      const clearedCookie = logout.headers.get("set-cookie") ?? "";
      expect(logout.status).toBe(200);
      expect(clearedCookie).toContain("pint_path_session=");
      expect(clearedCookie).toContain("Expires=Thu, 01 Jan 1970");
      expect(await service.getAccountFromAuthorization(`Bearer ${token}`)).toBeNull();

      const repeatedLogout = await fetch(`${baseUrl}/api/business/auth/logout`, {
        method: "POST",
        headers: { cookie },
      });
      expect(repeatedLogout.status).toBe(200);
      expect(repeatedLogout.headers.get("set-cookie") ?? "").toContain("Expires=Thu, 01 Jan 1970");
      await expect(repeatedLogout.json()).resolves.toEqual(expect.objectContaining({
        ok: true,
        data: { revoked: false, revokedDiscountPasses: 0 },
      }));
    });
  });

  it("keeps admin ingestion pages reachable beyond the old 10,000-row offset ceiling", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "deep-ingestion-admin", "admin");
    const token = "deep-ingestion-admin-session-token-with-enough-entropy";
    createSession(repository, admin.id, token);
    const listQueuedIngestions = vi.fn(() => []);
    const adminService = {
      listQueuedIngestions,
      countQueuedIngestions: vi.fn(() => 250_005),
      getQueuedIngestionImageRetentionStatus: vi.fn(() => ({
        heldForOpenReview: 0,
        pastHardCap: 0,
        retainedCharacters: 0,
      })),
    } as unknown as AdminService;
    const app = express();
    app.use("/api/admin", createAdminRouter(adminService, service));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/admin/ingestions?limit=50&offset=250001`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const payload = await response.json() as { data: { limit: number; offset: number; total: number } };

      expect(response.status).toBe(200);
      expect(payload.data).toEqual(expect.objectContaining({ limit: 50, offset: 250_001, total: 250_005 }));
      expect(listQueuedIngestions).toHaveBeenCalledWith(undefined, 50, 250_001);
    });
  });

  it("keeps ingestion image bytes out of lists and requires admin auth for lazy evidence", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "evidence-endpoint-admin", "admin");
    const token = "evidence-endpoint-admin-token-with-enough-entropy";
    createSession(repository, admin.id, token);
    const queueRepository = new AdminIngestionQueueRepository(getAsyncDatabase(database));
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const imageDataUrl = `data:image/jpeg;base64,${imageBytes.toString("base64")}`;
    const item = await queueRepository.create({
      venueId: "lazy-evidence-venue",
      venueName: "Lazy Evidence Venue",
      sourceType: "menu_photo_upload",
      sourceUrl: null,
      imageDataUrl,
      note: null,
      status: "pending_review",
      venueNameGuess: null,
      capturedNotes: null,
      overallConfidence: 0.9,
      extractedBeers: [],
      errorMessage: null,
    });
    const adminService = new AdminService(queueRepository);
    const app = express();
    app.use("/api/admin", createAdminRouter(adminService, service));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      const unauthorized = await fetch(`${baseUrl}/api/admin/ingestions/${item.id}/evidence`);
      expect(unauthorized.status).toBe(401);

      const list = await fetch(`${baseUrl}/api/admin/ingestions?status=pending_review`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const listText = await list.text();
      expect(list.status).toBe(200);
      expect(listText).not.toContain(imageDataUrl);
      expect(JSON.parse(listText)).toEqual(expect.objectContaining({
        data: expect.objectContaining({
          items: [expect.objectContaining({ id: item.id, hasImageData: true, imageDataUrl: null })],
        }),
      }));

      const evidence = await fetch(`${baseUrl}/api/admin/ingestions/${item.id}/evidence`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(evidence.status).toBe(200);
      expect(evidence.headers.get("cache-control")).toContain("no-store");
      expect(evidence.headers.get("content-type")).toContain("image/jpeg");
      expect(Buffer.from(await evidence.arrayBuffer())).toEqual(imageBytes);
    });
  });

  it("verifies Stripe webhook signatures before updating subscriptions", async () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "stripe-user");
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    });
    const stripeEventSecond = Math.floor(new Date(NOW).getTime() / 1000);
    const payload = {
      id: "evt_checkout_completed",
      type: "checkout.session.completed",
      created: stripeEventSecond,
      data: {
        object: {
          customer: "cus_test",
          payment_status: "paid",
          metadata: {
            user_id: user.id,
            subscription_status: "premium_yearly",
          },
        },
      },
    };
    const signed = createStripeSignature(payload, "whsec_test");

    await expect(service.handleStripeWebhook(signed.body, signed.header)).resolves.toEqual({ received: true });
    expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("premium_yearly");
    expect(repository.getAccountById(user.id)?.stripeCustomerId).toBe("cus_test");
    await expect(service.handleStripeWebhook(signed.body, signed.header)).resolves.toEqual({ received: true });
    expect((await listSecurityAuditLogs(repository, 10)).filter((row) => row.action === "stripe_subscription_update")).toHaveLength(1);
    for (const [index, [suffix, validFirst]] of [["first", true], ["last", false]].entries()) {
      const rotatedPayload = {
        ...payload,
        id: `evt_checkout_rotated_${suffix}`,
        created: stripeEventSecond + index + 1,
      };
      const rotated = createStripeSignature(rotatedPayload, "whsec_test");
      const [timestampPart, validPart] = rotated.header.split(",");
      const invalidPart = `v1=${"0".repeat(64)}`;
      const rotatedHeader = [timestampPart, ...(validFirst ? [validPart, invalidPart] : [invalidPart, validPart])].join(",");
      await expect(service.handleStripeWebhook(rotated.body, rotatedHeader)).resolves.toEqual({ received: true });
    }
    await expect(service.handleStripeWebhook(signed.body, undefined)).rejects.toThrow("Missing Stripe webhook signature");
    const freshTimestamp = String(Math.floor(Date.now() / 1000));
    await expect(service.handleStripeWebhook(signed.body, `t=${freshTimestamp},v1=bad`)).rejects.toThrow("Invalid Stripe webhook signature");
    await expect(service.handleStripeWebhook(signed.body, `t=${freshTimestamp},v1=${"z".repeat(64)}`)).rejects.toThrow("Invalid Stripe webhook signature");
    const staleTimestamp = String(Math.floor(new Date(NOW).getTime() / 1000) - 600);
    const staleSigned = createStripeSignature({ ...payload, id: "evt_checkout_stale" }, "whsec_test", staleTimestamp);
    await expect(service.handleStripeWebhook(staleSigned.body, staleSigned.header)).rejects.toThrow("Invalid Stripe webhook signature");
    expect((await listSecurityAuditLogs(repository, 10)).some((row) => row.action === "stripe_webhook_signature_failed")).toBe(true);

    const deletedPayload = {
      id: "evt_subscription_deleted",
      type: "customer.subscription.deleted",
      created: stripeEventSecond + 3,
      data: {
        object: {
          id: "sub_user",
          customer: "cus_test",
        },
      },
    };
    const deletedSigned = createStripeSignature(deletedPayload, "whsec_test");
    await expect(service.handleStripeWebhook(deletedSigned.body, deletedSigned.header)).resolves.toEqual({ received: true });
    expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("free");

    updateSubscription(repository, user.id, "premium_monthly");
    const failedPayload = {
      id: "evt_invoice_failed",
      type: "invoice.payment_failed",
      created: stripeEventSecond + 4,
      data: {
        object: {
          subscription: "sub_user",
          customer: "cus_test",
        },
      },
    };
    const invoiceService = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      STRIPE_SECRET_KEY: "test-fixture-not-a-real-invoice-authority-key",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: "sub_user",
      customer: "cus_test",
      status: "past_due",
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const failedSigned = createStripeSignature(failedPayload, "whsec_test");
      await expect(invoiceService.handleStripeWebhook(failedSigned.body, failedSigned.header))
        .resolves.toEqual({ received: true });
      expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("free");
    } finally {
      globalThis.fetch = originalFetch;
    }
    await expect(createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_WEBHOOK_SECRET: undefined,
    }).handleStripeWebhook(signed.body, signed.header)).rejects.toThrow("Stripe webhook secret is not configured");
  });

  it("fails closed over HTTP without event.created and safely serializes duplicate delivery", async () => {
    const { database, repository } = createRepository();
    const user = createAccount(repository, "stripe-http-fence-user");
    const webhookSecret = "test-stripe-http-fence-secret";
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_WEBHOOK_SECRET: webhookSecret, // security-scan allow: generated test fixture only
    });
    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);
    const payload = {
      id: "evt_http_created_fence",
      type: "checkout.session.completed",
      data: { object: {
        customer: "cus_http_created_fence",
        subscription: "sub_http_created_fence",
        payment_status: "paid",
        metadata: { user_id: user.id, subscription_status: "premium_monthly" },
      } },
    };

    await withHttpServer(app, async (baseUrl) => {
      const unsignedTimestamp = String(Math.floor(Date.now() / 1000));
      const missingCreated = createStripeSignature(payload, webhookSecret, unsignedTimestamp);
      const failed = await fetch(`${baseUrl}/api/business/billing/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": missingCreated.header },
        body: missingCreated.body,
      });
      expect(failed.status).toBe(400);
      expect(await failed.text()).not.toContain("stripe_webhook_events");
    });
    expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("free");
    expect(database.prepare("SELECT status, attempts FROM stripe_webhook_events WHERE id = ?").get(payload.id))
      .toEqual({ status: "failed", attempts: 1 });

    const created = Math.floor(new Date(NOW).getTime() / 1000);
    const retryPayload = { ...payload, created };
    const retry = createStripeSignature(retryPayload, webhookSecret);
    await expect(service.handleStripeWebhook(retry.body, retry.header)).resolves.toEqual({ received: true });
    expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("premium_monthly");
    expect(database.prepare("SELECT status, attempts FROM stripe_webhook_events WHERE id = ?").get(payload.id))
      .toEqual({ status: "applied", attempts: 2 });

    const duplicatePayload = { ...retryPayload, id: "evt_http_concurrent_duplicate", created: created + 1 };
    const duplicate = createStripeSignature(duplicatePayload, webhookSecret);
    const outcomes = await Promise.allSettled([
      service.handleStripeWebhook(duplicate.body, duplicate.header),
      service.handleStripeWebhook(duplicate.body, duplicate.header),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ statusCode: 409 });
    }
    expect(await getStripeSubscriptionRepository(repository).getWebhookEvent(duplicatePayload.id))
      .toMatchObject({ status: "applied", attempts: 1 });
  });

  it("restores consumer and venue entitlements after a past-due subscription becomes active", async () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "stripe-recovery-user");
    const admin = createAccount(repository, "admin", "admin");
    const webhookSecret = "test-stripe-recovery-webhook-secret";
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_WEBHOOK_SECRET: webhookSecret, // security-scan allow: generated test fixture only
      STRIPE_PRICE_MONTHLY: "price_consumer_monthly",
      STRIPE_PRICE_YEARLY: "price_consumer_yearly",
      STRIPE_PRO_PRICE_ID: "price_venue_pro",
    });
    await service.upsertBarProfile(admin, "stripe-recovery-venue", {
      name: "Recovery Hotel",
      address: null,
      suburb: "Melbourne",
      area: "Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      active: true,
    });
    repositoryDatabases.get(repository)!
      .prepare("UPDATE venue_profiles SET tier_manual_override = 0 WHERE venue_id = ?")
      .run("stripe-recovery-venue");

    let recoveryEventSecond = Math.floor(new Date(NOW).getTime() / 1000);
    const deliver = async (payload: object) => {
      const signed = createStripeSignature({ ...payload, created: recoveryEventSecond++ }, webhookSecret);
      await expect(service.handleStripeWebhook(signed.body, signed.header)).resolves.toEqual({ received: true });
    };

    await deliver({
      id: "evt_recovery_consumer_checkout",
      type: "checkout.session.completed",
      data: { object: {
        customer: "cus_recovery_consumer",
        subscription: "sub_recovery_consumer",
        payment_status: "paid",
        metadata: { user_id: user.id, subscription_status: "premium_yearly" },
      } },
    });
    expect(repository.getAccountById(user.id)).toEqual(expect.objectContaining({
      subscriptionStatus: "premium_yearly",
      stripePaidSubscriptionStatus: "premium_yearly",
    }));
    await deliver({
      id: "evt_recovery_consumer_past_due",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_recovery_consumer", customer: "cus_recovery_consumer", status: "past_due" } },
    });
    expect(repository.getAccountById(user.id)).toEqual(expect.objectContaining({
      subscriptionStatus: "free",
      stripePaidSubscriptionStatus: "premium_yearly",
    }));
    await deliver({
      id: "evt_recovery_consumer_active",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_recovery_consumer", customer: "cus_recovery_consumer", status: "active" } },
    });
    expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("premium_yearly");

    await deliver({
      id: "evt_recovery_venue_checkout",
      type: "checkout.session.completed",
      data: { object: {
        customer: "cus_recovery_venue",
        subscription: "sub_recovery_venue",
        payment_status: "paid",
        metadata: {
          billing_context: "venue",
          venue_id: "stripe-recovery-venue",
          venue_membership_tier: "pro",
        },
      } },
    });
    expect(repository.getBarProfile("stripe-recovery-venue")).toEqual(expect.objectContaining({
      membershipTier: "pro",
      stripePaidMembershipTier: "pro",
    }));
    await deliver({
      id: "evt_recovery_venue_past_due",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_recovery_venue", customer: "cus_recovery_venue", status: "past_due" } },
    });
    expect(repository.getBarProfile("stripe-recovery-venue")).toEqual(expect.objectContaining({
      membershipTier: "basic",
      stripePaidMembershipTier: "pro",
      subscriptionCurrentPeriodEnd: null,
    }));
    await deliver({
      id: "evt_recovery_venue_active",
      type: "customer.subscription.updated",
      data: { object: {
        id: "sub_recovery_venue",
        customer: "cus_recovery_venue",
        status: "active",
        current_period_end: 1_786_665_600,
      } },
    });
    expect(repository.getBarProfile("stripe-recovery-venue")).toEqual(expect.objectContaining({
      membershipTier: "pro",
      subscriptionCurrentPeriodEnd: "2026-08-14T00:00:00.000Z",
    }));
  });

  it("grants only settled checkout and allowlisted subscription states for consumers and venues", async () => {
    const { database, repository } = createRepository();
    const user = createAccount(repository, "stripe-state-user");
    const admin = createAccount(repository, "admin", "admin");
    const webhookSecret = "test-stripe-state-webhook-secret";
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_WEBHOOK_SECRET: webhookSecret, // security-scan allow: generated test fixture only
    });
    await service.upsertBarProfile(admin, "stripe-state-venue", {
      name: "State Hotel",
      address: null,
      suburb: "Melbourne",
      area: "Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      active: true,
    });
    database.prepare("UPDATE venue_profiles SET tier_manual_override = 0 WHERE venue_id = ?").run("stripe-state-venue");
    let stateEventSecond = Math.floor(new Date(NOW).getTime() / 1000);
    const deliver = async (payload: object) => {
      const signed = createStripeSignature({ ...payload, created: stateEventSecond++ }, webhookSecret);
      await expect(service.handleStripeWebhook(signed.body, signed.header)).resolves.toEqual({ received: true });
    };

    const consumerCheckoutObject = {
      customer: "cus_state_consumer",
      subscription: "sub_state_consumer",
      metadata: { user_id: user.id, subscription_status: "premium_monthly" },
    };
    const venueCheckoutObject = {
      customer: "cus_state_venue",
      subscription: "sub_state_venue",
      metadata: {
        billing_context: "venue",
        venue_id: "stripe-state-venue",
        venue_membership_tier: "pro",
      },
    };
    await deliver({
      id: "evt_state_consumer_unpaid",
      type: "checkout.session.completed",
      data: { object: { ...consumerCheckoutObject, status: "complete", payment_status: "unpaid" } },
    });
    await deliver({
      id: "evt_state_venue_unpaid",
      type: "checkout.session.completed",
      data: { object: { ...venueCheckoutObject, status: "complete", payment_status: "unpaid" } },
    });
    expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("free");
    expect(repository.getBarProfile("stripe-state-venue")?.membershipTier).toBe("basic");

    await deliver({
      id: "evt_state_consumer_async_paid",
      type: "checkout.session.async_payment_succeeded",
      data: { object: { ...consumerCheckoutObject, payment_status: "paid" } },
    });
    await deliver({
      id: "evt_state_venue_async_paid",
      type: "checkout.session.async_payment_succeeded",
      data: { object: { ...venueCheckoutObject, payment_status: "paid" } },
    });
    expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("premium_monthly");
    expect(repository.getBarProfile("stripe-state-venue")?.membershipTier).toBe("pro");

    for (const status of ["paused", "incomplete", "future_unknown_status"] as const) {
      await deliver({
        id: `evt_state_consumer_${status}`,
        type: "customer.subscription.updated",
        data: { object: { id: "sub_state_consumer", customer: "cus_state_consumer", status } },
      });
      await deliver({
        id: `evt_state_venue_${status}`,
        type: "customer.subscription.updated",
        data: { object: { id: "sub_state_venue", customer: "cus_state_venue", status } },
      });
      expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("free");
      expect(repository.getBarProfile("stripe-state-venue")?.membershipTier).toBe("basic");
      await deliver({
        id: `evt_state_consumer_${status}_active`,
        type: "customer.subscription.updated",
        data: { object: { id: "sub_state_consumer", customer: "cus_state_consumer", status: "active" } },
      });
      await deliver({
        id: `evt_state_venue_${status}_active`,
        type: "customer.subscription.updated",
        data: { object: { id: "sub_state_venue", customer: "cus_state_venue", status: "active" } },
      });
      expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("premium_monthly");
      expect(repository.getBarProfile("stripe-state-venue")?.membershipTier).toBe("pro");
    }
  });

  it("uses Stripe subscription authority for conflicting same-second consumer and venue events", async () => {
    const { database, repository } = createRepository();
    const user = createAccount(repository, "stripe-order-user");
    const admin = createAccount(repository, "admin", "admin");
    const webhookSecret = "test-stripe-order-webhook-secret";
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_WEBHOOK_SECRET: webhookSecret, // security-scan allow: generated test fixture only
      STRIPE_SECRET_KEY: "test-fixture-not-a-real-order-authority-key",
    });
    await service.upsertBarProfile(admin, "stripe-order-venue", {
      name: "Order Hotel",
      address: null,
      suburb: "Melbourne",
      area: "Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      active: true,
    });
    database.prepare("UPDATE venue_profiles SET tier_manual_override = 0 WHERE venue_id = ?").run("stripe-order-venue");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      const subscriptionId = String(url).split("/").pop()!;
      return new Response(JSON.stringify({
        id: subscriptionId,
        customer: subscriptionId.includes("venue") ? "cus_order_venue" : "cus_order_consumer",
        status: "active",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const deliver = async (payload: object) => {
      const signed = createStripeSignature(payload, webhookSecret);
      await expect(service.handleStripeWebhook(signed.body, signed.header)).resolves.toEqual({ received: true });
    };
    const eventSecond = Math.floor(new Date(NOW).getTime() / 1000);

    try {
      await deliver({
        id: "evt_order_consumer_checkout",
        type: "checkout.session.completed",
        created: eventSecond - 1,
        data: { object: {
          customer: "cus_order_consumer",
          subscription: "sub_order_consumer",
          payment_status: "paid",
          metadata: { user_id: user.id, subscription_status: "premium_yearly" },
        } },
      });
      await deliver({
        id: "evt_order_venue_checkout",
        type: "checkout.session.completed",
        created: eventSecond - 1,
        data: { object: {
          customer: "cus_order_venue",
          subscription: "sub_order_venue",
          payment_status: "paid",
          metadata: {
            billing_context: "venue",
            venue_id: "stripe-order-venue",
            venue_membership_tier: "pro",
          },
        } },
      });

      // Consumer: active arrives first, stale-looking past_due arrives second.
      await deliver({
        id: "evt_order_consumer_active",
        type: "customer.subscription.updated",
        created: eventSecond,
        data: { object: { id: "sub_order_consumer", customer: "cus_order_consumer", status: "active" } },
      });
      await deliver({
        id: "evt_order_consumer_past_due_same_second",
        type: "customer.subscription.updated",
        created: eventSecond,
        data: { object: { id: "sub_order_consumer", customer: "cus_order_consumer", status: "past_due" } },
      });

      // Venue: reverse delivery order; the second event must still consult authority.
      await deliver({
        id: "evt_order_venue_past_due",
        type: "customer.subscription.updated",
        created: eventSecond,
        data: { object: { id: "sub_order_venue", customer: "cus_order_venue", status: "past_due" } },
      });
      await deliver({
        id: "evt_order_venue_active_same_second",
        type: "customer.subscription.updated",
        created: eventSecond,
        data: { object: { id: "sub_order_venue", customer: "cus_order_venue", status: "active" } },
      });

      expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("premium_yearly");
      expect(repository.getBarProfile("stripe-order-venue")?.membershipTier).toBe("pro");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not regrant consumer or venue access from a same-second checkout after cancellation", async () => {
    const { database, repository } = createRepository();
    const user = createAccount(repository, "stripe-cancel-checkout-user");
    const admin = createAccount(repository, "stripe-cancel-checkout-admin", "admin");
    const webhookSecret = "test-stripe-cancel-checkout-secret";
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_WEBHOOK_SECRET: webhookSecret, // security-scan allow: generated test fixture only
      STRIPE_SECRET_KEY: "test-fixture-not-a-real-cancel-authority-key",
    });
    await service.upsertBarProfile(admin, "stripe-cancel-checkout-venue", {
      name: "Cancellation Hotel",
      address: null,
      suburb: "Melbourne",
      area: "Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      active: true,
    });
    database.prepare("UPDATE venue_profiles SET tier_manual_override = 0 WHERE venue_id = ?")
      .run("stripe-cancel-checkout-venue");
    const originalFetch = globalThis.fetch;
    let authorityStatus = "active";
    globalThis.fetch = (async (url) => {
      const subscriptionId = String(url).split("/").pop()!;
      return new Response(JSON.stringify({
        id: subscriptionId,
        customer: subscriptionId.includes("venue") ? "cus_cancel_checkout_venue" : "cus_cancel_checkout_consumer",
        status: authorityStatus,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const deliver = async (payload: object) => {
      const signed = createStripeSignature(payload, webhookSecret);
      await expect(service.handleStripeWebhook(signed.body, signed.header)).resolves.toEqual({ received: true });
    };
    const priorSecond = Math.floor(new Date(NOW).getTime() / 1000) - 1;
    const cancellationSecond = priorSecond + 1;
    const consumerCheckoutObject = {
      customer: "cus_cancel_checkout_consumer",
      subscription: "sub_cancel_checkout_consumer",
      payment_status: "paid",
      metadata: { user_id: user.id, subscription_status: "premium_monthly" },
    };
    const venueCheckoutObject = {
      customer: "cus_cancel_checkout_venue",
      subscription: "sub_cancel_checkout_venue",
      payment_status: "paid",
      metadata: {
        billing_context: "venue",
        venue_id: "stripe-cancel-checkout-venue",
        venue_membership_tier: "pro",
      },
    };

    try {
      await deliver({ id: "evt_cancel_checkout_consumer_initial", type: "checkout.session.completed", created: priorSecond, data: { object: consumerCheckoutObject } });
      await deliver({ id: "evt_cancel_checkout_venue_initial", type: "checkout.session.completed", created: priorSecond, data: { object: venueCheckoutObject } });
      authorityStatus = "canceled";
      await deliver({
        id: "evt_cancel_checkout_consumer_deleted",
        type: "customer.subscription.deleted",
        created: cancellationSecond,
        data: { object: { id: "sub_cancel_checkout_consumer", customer: "cus_cancel_checkout_consumer", status: "canceled" } },
      });
      await deliver({
        id: "evt_cancel_checkout_venue_deleted",
        type: "customer.subscription.deleted",
        created: cancellationSecond,
        data: { object: { id: "sub_cancel_checkout_venue", customer: "cus_cancel_checkout_venue", status: "canceled" } },
      });

      await deliver({ id: "evt_cancel_checkout_consumer_stale", type: "checkout.session.completed", created: cancellationSecond, data: { object: consumerCheckoutObject } });
      await deliver({ id: "evt_cancel_checkout_venue_stale", type: "checkout.session.completed", created: cancellationSecond, data: { object: venueCheckoutObject } });

      expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("free");
      expect(repository.getBarProfile("stripe-cancel-checkout-venue")?.membershipTier).toBe("basic");
      expect(database.prepare(
        "SELECT count(*) AS count FROM security_audit_log WHERE action = 'stripe_checkout_authority_rejected'",
      ).get()).toEqual({ count: 2 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries failed Stripe events and ignores older events after a newer subscription update", async () => {
    const { database, repository } = createRepository();
    const webhookSecret = "test-stripe-retry-webhook-secret";
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_WEBHOOK_SECRET: webhookSecret, // security-scan allow: generated test fixture only
    });
    const created = Math.floor(new Date(NOW).getTime() / 1000);
    const checkoutPayload = {
      id: "evt_retry_checkout",
      type: "checkout.session.completed",
      created,
      data: {
        object: {
          customer: "cus_retry_test",
          payment_status: "paid",
          metadata: {
            user_id: "stripe-retry-user",
            subscription_status: "premium_monthly",
          },
        },
      },
    };
    const checkoutSigned = createStripeSignature(checkoutPayload, webhookSecret);

    await expect(service.handleStripeWebhook(checkoutSigned.body, checkoutSigned.header)).rejects.toThrow();
    expect(database.prepare("SELECT status, attempts FROM stripe_webhook_events WHERE id = ?").get(checkoutPayload.id))
      .toEqual({ status: "failed", attempts: 1 });

    createAccount(repository, "stripe-retry-user");
    await expect(service.handleStripeWebhook(checkoutSigned.body, checkoutSigned.header)).resolves.toEqual({ received: true });
    expect(repository.getAccountById("stripe-retry-user")).toEqual(expect.objectContaining({
      subscriptionStatus: "premium_monthly",
      stripeCustomerId: "cus_retry_test",
      stripeEventCreatedAt: new Date(created * 1000).toISOString(),
    }));
    expect(database.prepare("SELECT status, attempts FROM stripe_webhook_events WHERE id = ?").get(checkoutPayload.id))
      .toEqual({ status: "applied", attempts: 2 });

    const olderFailurePayload = {
      id: "evt_older_invoice_failure",
      type: "invoice.payment_failed",
      created: created - 60,
      data: { object: { customer: "cus_retry_test", subscription: "sub_retry_test" } },
    };
    const olderFailureSigned = createStripeSignature(olderFailurePayload, webhookSecret);
    await expect(service.handleStripeWebhook(olderFailureSigned.body, olderFailureSigned.header)).resolves.toEqual({ received: true });
    expect(repository.getAccountById("stripe-retry-user")?.subscriptionStatus).toBe("premium_monthly");
  });
});

describe("business demo contribution model", () => {
  it("unlocks contributor access after enough approved unique-venue points", async () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "contributor");
    const admin = createAccount(repository, "admin", "admin");

    ["venue-1", "venue-2", "venue-3"].forEach((venueId, index) => {
      const submission = createSubmission(repository, {
        id: `submission-${index + 1}`,
        userId: user.id,
        venueId,
        venueName: `Venue ${index + 1}`,
      });

      const result = approve(repository, submission.id, admin.id);
      expect(result.pointsAwarded).toBe(5);
    });

    const updated = repository.getAccountById(user.id);
    expect(updated?.contributionPointsCurrentMonth).toBe(15);
    expect(updated?.subscriptionStatus).toBe("contributor_unlocked");
    expect(updated?.premiumUntil).toBe(PREMIUM_UNTIL);
  });

  it("caps reward points to one approved submission per user, venue, and month", async () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "repeat-user");
    const admin = createAccount(repository, "admin", "admin");
    const first = createSubmission(repository, { id: "submission-1", userId: user.id, venueId: "venue-1" });
    const second = createSubmission(repository, { id: "submission-2", userId: user.id, venueId: "venue-1" });

    expect(approve(repository, first.id, admin.id).pointsAwarded).toBe(5);
    expect(approve(repository, second.id, admin.id).pointsAwarded).toBe(0);
    expect(repository.getAccountById(user.id)?.contributionPointsCurrentMonth).toBe(5);
  });

  it("assigns public account IDs and ranks approved submissions without exposing email addresses", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "leaderboard-admin", "admin");
    const firstUser = createAccount(repository, "leaderboard-first");
    const secondUser = createAccount(repository, "leaderboard-second");

    ["leaderboard-venue-1", "leaderboard-venue-2"].forEach((venueId, index) => {
      const submission = createSubmission(repository, {
        id: `leaderboard-first-${index}`,
        userId: firstUser.id,
        venueId,
        venueName: `Leaderboard Venue ${index}`,
      });
      approve(repository, submission.id, admin.id);
    });

    const approvedSecond = createSubmission(repository, {
      id: "leaderboard-second-approved",
      userId: secondUser.id,
      venueId: "leaderboard-venue-3",
    });
    approve(repository, approvedSecond.id, admin.id);
    createSubmission(repository, {
      id: "leaderboard-second-pending",
      userId: secondUser.id,
      venueId: "leaderboard-venue-4",
    });

    const leaderboard = await service.getLeaderboard(firstUser, { period: "all_time", limit: 10 });
    expect(leaderboard.disabled).toBe(false);
    expect(firstUser.publicAccountId).toMatch(/^PP-[A-Z0-9]{8}$/);
    expect(secondUser.publicAccountId).toMatch(/^PP-[A-Z0-9]{8}$/);
    expect(leaderboard.entries[0]).toEqual(expect.objectContaining({
      accountId: firstUser.publicAccountId,
      rank: 1,
      approvedSubmissions: 2,
    }));
    expect(leaderboard.entries[1]).toEqual(expect.objectContaining({
      accountId: secondUser.publicAccountId,
      rank: 2,
      approvedSubmissions: 1,
    }));
    expect(leaderboard.me?.accountId).toBe(firstUser.publicAccountId);
    expect(JSON.stringify(leaderboard)).not.toContain(firstUser.email);
    expect(JSON.stringify(leaderboard)).not.toContain(secondUser.email);
  });

  it("returns an exact leaderboard rank beyond 10,000 contributors", async () => {
    const { database, repository } = createRepository();
    const target = createAccount(repository, "leaderboard-deep-target");
    const insertAccount = database.prepare(
      `INSERT INTO accounts (
        id, public_account_id, email, password_hash, role, subscription_status, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'hash', 'user', 'free', 'active', ?, ?)`,
    );
    const insertLedger = database.prepare(
      `INSERT INTO contribution_ledger (
        id, user_id, submission_id, venue_id, points, reason, month_key, created_at
      ) VALUES (?, ?, NULL, 'leaderboard-deep-venue', ?, 'rank regression', ?, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        const suffix = String(index).padStart(5, "0");
        const userId = `leaderboard-ahead-${suffix}`;
        insertAccount.run(
          userId,
          `PP-AHEAD-${suffix}`,
          `${userId}@example.com`,
          NOW,
          NOW,
        );
        insertLedger.run(`leaderboard-ledger-${suffix}`, userId, 2, MONTH_KEY, NOW);
      }
      insertLedger.run("leaderboard-ledger-target", target.id, 1, MONTH_KEY, NOW);
    })();

    expect(repository.getLeaderboardRank({
      userId: target.id,
      period: "month",
      now: NOW,
      monthKey: MONTH_KEY,
    })).toEqual(expect.objectContaining({
      rank: 10_001,
      accountId: target.publicAccountId,
      points: 1,
    }));
  });

  it("moderates public display names before they appear on leaderboards", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "display-name-user");
    const otherUser = createAccount(repository, "display-name-other");

    const updated = await service.updateDisplayName(user, { displayName: "Tap Legend" });
    expect(updated.account.displayName).toBe("Tap Legend");
    expect((await accountProfilePreferencesRepositories.get(repository)!.getProfileById(user.id))?.displayName)
      .toBe("Tap Legend");
    expect(repository.getAccountByDisplayNameKey("tap legend")?.id).toBe(user.id);

    await expect(service.updateDisplayName(otherUser, { displayName: "Tap   Legend" }))
      .rejects.toThrow("already taken");

    await expect(service.updateDisplayName(user, { displayName: "PintPath Admin" }))
      .rejects.toThrow("community rules");
    await expect(service.updateDisplayName(user, { displayName: "www.bad-name.test" }))
      .rejects.toThrow("community rules");
  });

  it("rejects SQL-looking public display names before they reach leaderboard storage", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "display-name-injection-user");

    await expect(service.updateDisplayName(user, { displayName: "Rob');--" }))
      .rejects.toThrow("Display name can use letters");

    const updated = await service.updateDisplayName(user, { displayName: "Safe Pint Tester" });
    expect(updated.account.displayName).toBe("Safe Pint Tester");
    expect(repository.getAccountById(user.id)?.displayName).toBe("Safe Pint Tester");
  });

  it("sanitizes venue search text before building Supabase filter strings", async () => {
    expect(sanitizePostgrestIlikeTerm("Half Moon%),id.not.is.null")).toBe("Half Moon id not is null");
    expect(sanitizePostgrestIlikeTerm("Robert'); DROP TABLE venues;--")).toBe("Robert DROP TABLE venues --");
    expect(sanitizePostgrestIlikeTerm("  Carlton   Draught · Brighton, VIC  ")).toBe("Carlton Draught Brighton VIC");
    expect(sanitizePostgrestIlikeTerm("x".repeat(120))).toHaveLength(80);
  });

  it("lets admins finalize monthly leaderboard prizes into private account vouchers", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "prize-admin", "admin");
    const firstUser = createAccount(repository, "prize-first");
    const secondUser = createAccount(repository, "prize-second");
    const thirdUser = createAccount(repository, "prize-third");

    await service.updateDisplayName(firstUser, { displayName: "First Pint" });
    await service.updateDisplayName(secondUser, { displayName: "Second Pint" });
    await service.updateDisplayName(thirdUser, { displayName: "Third Pint" });

    [
      [firstUser.id, "prize-venue-1"],
      [firstUser.id, "prize-venue-2"],
      [firstUser.id, "prize-venue-3"],
      [secondUser.id, "prize-venue-4"],
      [secondUser.id, "prize-venue-5"],
      [thirdUser.id, "prize-venue-6"],
    ].forEach(([userId, venueId], index) => {
      const submission = createSubmission(repository, {
        id: `prize-submission-${index}`,
        userId,
        venueId,
      });
      approve(repository, submission.id, admin.id);
    });

    await service.saveLeaderboardPrizeCampaign(admin, {
      monthKey: MONTH_KEY,
      title: "June beta prize race",
      affiliateBar: "Half Moon",
      terms: "Prize vouchers are venue tab credits for eligible partner venues.",
      firstPlaceCents: 10_000,
      secondPlaceCents: 5_000,
      thirdPlaceCents: 2_500,
    });

    const result = await service.finalizeLeaderboardPrizeCampaign(admin, { monthKey: MONTH_KEY, force: true });
    expect(result.awards).toHaveLength(3);
    expect(result.vouchers.map((voucher) => voucher.amountCents)).toEqual([10_000, 5_000, 2_500]);
    expect(result.awards[0]).toEqual(expect.objectContaining({
      rank: 1,
      publicAccountId: firstUser.publicAccountId,
      displayName: "First Pint",
    }));

    const dashboard = await service.getAccountDashboard(firstUser);
    expect(dashboard.rewards.vouchers[0]).toEqual(expect.objectContaining({
      title: "June beta prize race winner",
      amountLabel: "$100",
      venueScope: "Half Moon",
      status: "active",
    }));
    expect(JSON.stringify(dashboard.rewards.vouchers)).not.toContain(firstUser.email);
  });

  it("revalidates prize eligibility, reranks winners, and supports audited manual fulfillment", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "prize-fair-admin", "admin");
    const firstStaff = createAccount(repository, "prize-fair-staff-one");
    const secondStaff = createAccount(repository, "prize-fair-staff-two");
    const firstEligible = createAccount(repository, "prize-fair-eligible-one");
    const secondEligible = createAccount(repository, "prize-fair-eligible-two");
    const thirdEligible = createAccount(repository, "prize-fair-eligible-three");

    await service.assignVenueManager(admin, {
      userId: firstStaff.id,
      venueId: "prize-fair-venue-one",
      venueName: "Prize Fair Venue One",
      suburb: "Fitzroy",
    });
    await service.assignVenueManager(admin, {
      userId: secondStaff.id,
      venueId: "prize-fair-venue-two",
      venueName: "Prize Fair Venue Two",
      suburb: "Brunswick",
    });
    const campaign = repository.upsertLeaderboardPrizeCampaign({
      monthKey: MONTH_KEY,
      title: "Fair prize campaign",
      startsAt: "2026-07-01T00:00:00.000Z",
      endsAt: "2026-07-31T23:59:59.999Z",
      firstPlaceCents: 10_000,
      secondPlaceCents: 5_000,
      thirdPlaceCents: 2_500,
      affiliateBar: "Manual partner network",
      terms: "Manual support fulfillment within 90 days.",
      now: NOW,
    });

    const result = repository.finalizeLeaderboardPrizeCampaign({
      campaign,
      finalizedBy: admin.id,
      now: NOW,
      entries: [
        { rank: 1, accountId: firstStaff.publicAccountId, displayName: "Staff one", points: 99, approvedSubmissions: 9 },
        { rank: 2, accountId: admin.publicAccountId, displayName: "Admin", points: 98, approvedSubmissions: 8 },
        { rank: 3, accountId: secondStaff.publicAccountId, displayName: "Staff two", points: 97, approvedSubmissions: 7 },
        { rank: 4, accountId: firstEligible.publicAccountId, displayName: "Eligible one", points: 96, approvedSubmissions: 6 },
        { rank: 5, accountId: secondEligible.publicAccountId, displayName: "Eligible two", points: 95, approvedSubmissions: 5 },
        { rank: 6, accountId: thirdEligible.publicAccountId, displayName: "Eligible three", points: 94, approvedSubmissions: 4 },
      ],
    });

    expect(result.awards.map((award) => [award.rank, award.publicAccountId])).toEqual([
      [1, firstEligible.publicAccountId],
      [2, secondEligible.publicAccountId],
      [3, thirdEligible.publicAccountId],
    ]);
    expect(result.vouchers.map((voucher) => voucher.amountCents)).toEqual([10_000, 5_000, 2_500]);
    expect(result.vouchers[0].expiresAt).toBe("2026-08-02T08:00:00.000Z");
    expect(result.vouchers[0].metadata).toEqual(expect.objectContaining({
      fulfillmentMethod: "manual_support",
      claimReference: expect.stringMatching(/^PP-202605-[A-F0-9]{8}$/),
    }));

    const fulfilled = await service.transitionRewardVoucher(admin, result.vouchers[0].id, {
      action: "fulfill",
      reason: "Support verified the winner and partner receipt.",
    });
    expect(fulfilled).toEqual(expect.objectContaining({
      idempotent: false,
      voucher: expect.objectContaining({ status: "redeemed", statusLabel: "Fulfilled" }),
    }));
    expect((await service.transitionRewardVoucher(admin, result.vouchers[0].id, {
      action: "fulfill",
      reason: "Retry after the response timed out.",
    })).idempotent).toBe(true);
    await expect(service.transitionRewardVoucher(admin, result.vouchers[0].id, {
      action: "void",
      reason: "Conflicting transition must fail.",
    })).rejects.toThrow("already redeemed");
    const audit = database.prepare(
      "SELECT action, target_id FROM security_audit_log WHERE target_id = ? ORDER BY created_at",
    ).all(result.vouchers[0].id) as Array<{ action: string; target_id: string }>;
    expect(audit.map((entry) => entry.action)).toEqual([
      "reward_voucher_fulfilled",
      "reward_voucher_fulfilled",
    ]);

    database.prepare("UPDATE account_reward_vouchers SET expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", result.vouchers[1].id);
    await expect(service.transitionRewardVoucher(admin, result.vouchers[1].id, {
      action: "fulfill",
      reason: "An expired voucher must not be fulfilled.",
    })).rejects.toThrow("expired");
  });

  it("keeps Pub Golf beta premium-only and plans nine drink stops from verified venue data", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "pub-golf-admin", "admin");
    const freeUser = createAccount(repository, "pub-golf-free");
    const premiumUser = updateSubscription(
      repository,
      createAccount(repository, "pub-golf-premium").id,
      "premium_monthly",
      PREMIUM_UNTIL,
    );
    const drinks = [
      "Guinness",
      "Carlton Draught",
      "Stone & Wood Pacific Ale",
      "Lager",
      "Pale Ale",
      "IPA",
      "Cider",
      "Red wine",
      "Vodka soda",
    ];

    for (const [index, drink] of drinks.entries()) {
      const venueId = `pub-golf-venue-${index}`;
      repository.upsertBarProfile({
        barId: venueId,
        name: `Pub Golf Stop ${index + 1}`,
        address: `${index + 1} Test Street, Melbourne`,
        suburb: index < 4 ? "Melbourne" : "Richmond",
        area: index < 4 ? "CBD" : "Richmond",
        phone: null,
        website: null,
        instagram: null,
        description: null,
        openingHours: {},
        venueTags: ["pub"],
        membershipTier: index < 2 ? "pro" : "basic",
        highlightedName: false,
        premiumBadge: null,
        promoted: false,
        featuredSpecialEligible: false,
        active: true,
        now: NOW,
      });
      repository.upsertVenueLocationCache({
        venueId,
        venueName: `Pub Golf Stop ${index + 1}`,
        suburb: index < 4 ? "Melbourne" : "Richmond",
        latitude: -37.8136 + index * 0.004,
        longitude: 144.9631 + index * 0.004,
        now: NOW,
      });
      await getVenueInventoryRepository(repository).upsertBarBeer({
        id: `pub-golf-beer-${index}`,
        barId: venueId,
        beerName: drink,
        brewery: null,
        style: null,
        abv: null,
        serveSize: "pint",
        price: 12 + index,
        currency: "AUD",
        onTap: true,
        inStock: true,
        notes: null,
        now: NOW,
      });
    }

    await expect(service.planPubGolf(freeUser, {
      startLocation: "Melbourne CBD",
      finishLocation: "Richmond",
      drinks,
      mode: "auto",
    })).rejects.toThrow("premium or contributor");

    const plan = await service.planPubGolf(premiumUser, {
      startLocation: "Melbourne CBD",
      finishLocation: "Richmond",
      drinks,
      mode: "auto",
    });

    expect(plan.status).toBe("ready");
    expect(plan.holes).toHaveLength(9);
    expect(plan.summary.plannedStops).toBe(9);
    expect(plan.warnings).toEqual([]);
    expect(plan.holes[0].venue?.name).toBe("Pub Golf Stop 1");
    expect(plan.holes[0].venue?.latitude).toBeCloseTo(-37.8136);
    expect(plan.holes.every((hole) => hole.venue?.mapsUrl.includes("www.google.com/maps/search/"))).toBe(true);
    expect(repository.getAccountById(admin.id)).toBeTruthy();
  });

  it("generates rotating discount passes without storing raw codes and revokes them on logout", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const premiumUser = updateSubscription(
      repository,
      createAccount(repository, "discount-pass-user").id,
      "premium_monthly",
      PREMIUM_UNTIL,
    );
    const authHeader = createSession(repository, premiumUser.id, "discount-pass-session-token");

    const pass = await service.getDiscountPass(premiumUser, authHeader);
    const storedPass = database
      .prepare("SELECT code_hash, status FROM account_discount_passes WHERE user_id = ?")
      .get(premiumUser.id) as { code_hash: string; status: string };

    expect(pass.accountId).toBe(premiumUser.publicAccountId);
    expect(pass.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(pass.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(pass.redeemUrl).toContain("venue-portal.html");
    expect(pass.redeemUrl).toContain("tab=redemption");
    const passUrl = new URL(pass.redeemUrl);
    expect(passUrl.searchParams.get("discountCode")).toBeNull();
    expect(new URLSearchParams(passUrl.hash.slice(1)).get("discountCode")).toBe(pass.code);
    expect(storedPass.status).toBe("active");
    expect(storedPass.code_hash).not.toBe(pass.code);

    const logout = await service.logout(authHeader);
    const revokedPass = database
      .prepare("SELECT status, revoked_at FROM account_discount_passes WHERE user_id = ?")
      .get(premiumUser.id) as { status: string; revoked_at: string | null };
    expect(logout.revokedDiscountPasses).toBe(1);
    expect(revokedPass.status).toBe("revoked");
    expect(revokedPass.revoked_at).toBeTruthy();
  });

  it("logs explicit discount redemptions only for assigned venues and adds savings to the account dashboard", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "discount-admin", "admin");
    const manager = createAccount(repository, "discount-manager");
    const otherManager = createAccount(repository, "discount-other-manager");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "discount-venue-a",
      venueName: "Discount Venue A",
      suburb: "Fitzroy",
    });
    await service.assignVenueManager(admin, {
      userId: otherManager.id,
      venueId: "discount-venue-b",
      venueName: "Discount Venue B",
      suburb: "Brunswick",
    });
    await service.upsertBarProfile(admin, "discount-venue-a", {
      name: "Discount Venue A",
      address: null,
      suburb: "Fitzroy",
      area: "Fitzroy",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      acceptsPintPathCodes: true,
      active: true,
    });
    await getVenueInventoryRepository(repository).upsertBarSpecial({
      id: "special-1",
      barId: "discount-venue-a",
      title: "House pint",
      description: "$3 off the verified house pint.",
      price: null,
      discount: "$3 off",
      savingsAmountCents: 300,
      startsAt: null,
      endsAt: null,
      startTime: null,
      endTime: null,
      scheduleNote: null,
      exclusive: false,
      active: true,
      now: NOW,
    });

    const premiumUser = updateSubscription(
      repository,
      createAccount(repository, "discount-premium-user").id,
      "premium_yearly",
      PREMIUM_UNTIL,
    );
    const pass = await service.getDiscountPass(
      premiumUser,
      createSession(repository, premiumUser.id, "discount-redemption-token"),
    );
    const assignedManager = repository.getAccountById(manager.id)!;
    const unassignedManager = repository.getAccountById(otherManager.id)!;

    await expect(
      service.redeemDiscountPass(unassignedManager, "discount-venue-a", {
        code: pass.code,
        specialId: null,
        itemName: "House pint",
        quantity: 1,
        estimatedSavingsCents: 300,
        notes: "Wrong venue attempt",
      }),
    ).rejects.toThrow("You can only access assigned venues.");

    const redemption = await service.redeemDiscountPass(assignedManager, "discount-venue-a", {
      code: pass.code,
      specialId: "special-1",
      itemName: "House pint",
      quantity: 2,
      estimatedSavingsCents: 600,
      notes: "Staff confirmed at till.",
    });
    const replay = await service.redeemDiscountPass(assignedManager, "discount-venue-a", {
        code: pass.code,
        specialId: "special-1",
        itemName: "Second attempt",
        quantity: 1,
        estimatedSavingsCents: 300,
        notes: "Replay attempt",
      });
    expect(replay).toEqual(expect.objectContaining({ idempotentReplay: true, pointsEarned: 0 }));

    const dashboard = await service.getAccountDashboard(premiumUser);
    expect(redemption.accountId).toBe(premiumUser.publicAccountId);
    expect(redemption.venueName).toBe("Discount Venue A");
    expect(redemption.estimatedSavingsDollars).toBe(6);
    expect(redemption.pointsEarned).toBe(0);
    expect(dashboard.discounts).toEqual(expect.objectContaining({
      totalRedemptions: 1,
      estimatedSavingsCents: 600,
      estimatedSavingsDollars: 6,
      uniqueVenues: 1,
    }));
    expect(dashboard.discounts.recentRedemptions[0]).toEqual(expect.objectContaining({
      venueName: "Discount Venue A",
      itemName: "House pint",
      estimatedSavingsCents: 600,
    }));
    expect(dashboard.pintPoints).toEqual(expect.objectContaining({
      balance: 0,
      available: 0,
    }));
    expect(dashboard.premiumMemberToolkit).toEqual(expect.objectContaining({
      enabled: true,
      status: "active",
      title: "Full map toolkit",
      counts: expect.objectContaining({
        totalRedemptions: 1,
        uniqueDiscountVenues: 1,
        estimatedSavingsCents: 600,
        estimatedSavingsDollars: 6,
      }),
    }));
    expect(dashboard.premiumMemberToolkit.perks.map((perk) => perk.id)).toEqual(expect.arrayContaining([
      "exact_price_mode",
      "premium_filters",
      "discount_pass",
      "night_shortlist",
      "personal_preferences",
      "savings_tracker",
    ]));
  });

  it("fails closed for Pint Points and Free Pint Rewards when launch approval is not enabled", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository, {
      PINT_POINTS_REWARDS_ENABLED: false,
      ALCOHOL_GAMIFICATION_ENABLED: false,
    });
    const admin = createAccount(repository, "disabled-pint-points-admin", "admin");
    const manager = createAccount(repository, "disabled-pint-points-manager");
    const user = createAccount(repository, "disabled-pint-points-user");
    await service.updateDisplayName(user, { displayName: "Private Contributor" });
    const contribution = createSubmission(repository, {
      id: "disabled-leaderboard-submission",
      userId: user.id,
      venueId: "disabled-leaderboard-venue",
    });
    approve(repository, contribution.id, admin.id);

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "disabled-pint-points-venue",
      venueName: "Disabled Rewards Hotel",
      suburb: "Carlton",
    });

    const publicConfig = await service.getPublicConfig();
    expect(publicConfig.pintPointsRewardsEnabled).toBe(false);
    expect(publicConfig.alcoholGamificationEnabled).toBe(false);
    expect(publicConfig.happyHourDiscoveryEnabled).toBe(false);
    expect(publicConfig.happyHourContributionsEnabled).toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS count FROM leaderboard_prize_campaigns").get()).toEqual({ count: 0 });
    const publicLeaderboard = await service.getLeaderboard(null, { period: "month", limit: 50 });
    expect(publicLeaderboard).toEqual(expect.objectContaining({
      disabled: true,
      campaign: null,
      podium: [],
      entries: [],
      me: null,
    }));
    expect(JSON.stringify(publicLeaderboard)).not.toContain("Private Contributor");
    const accountDashboard = await service.getAccountDashboard(user);
    expect(accountDashboard.pintPoints).toBeNull();
    expect(accountDashboard.leaderboard).toEqual(expect.objectContaining({
      disabled: true,
      accountId: null,
      monthRank: null,
      campaign: null,
      entries: [],
    }));
    expect(accountDashboard.betaTesting.leaderboard).toEqual(expect.objectContaining({
      disabled: true,
      campaign: null,
      entries: [],
      me: null,
    }));
    expect(accountDashboard.rewards.status).toBe("paused");
    expect(JSON.stringify(accountDashboard.leaderboard)).not.toContain("Private Contributor");
    expect(await service.getLeaderboardPrizeAdmin(admin)).toEqual(expect.objectContaining({
      disabled: true,
      campaign: null,
      awards: [],
      vouchers: [],
    }));
    await expect(service.saveLeaderboardPrizeCampaign(admin, {
      monthKey: MONTH_KEY,
      title: "Must stay paused",
      affiliateBar: null,
      terms: null,
      firstPlaceCents: 10_000,
      secondPlaceCents: 5_000,
      thirdPlaceCents: 2_500,
    })).rejects.toThrow("paused while the launch promotion completes legal and venue approval");
    await expect(service.finalizeLeaderboardPrizeCampaign(admin, {
      monthKey: MONTH_KEY,
      force: true,
    })).rejects.toThrow("paused while the launch promotion completes legal and venue approval");
    expect(database.prepare("SELECT COUNT(*) AS count FROM leaderboard_prize_campaigns").get()).toEqual({ count: 0 });
    expect((await service.getVenuePortal(
      repository.getAccountById(manager.id)!,
      { venueId: "disabled-pint-points-venue" },
    )).pintPoints).toBeNull();
    await expect(service.createFreePintRewardCode(user, {})).rejects.toThrow(
      "paused while the launch promotion completes legal and venue approval",
    );
    await expect(
      service.previewPintPointMember(
        repository.getAccountById(manager.id)!,
        "disabled-pint-points-venue",
        { code: "ABC123", transactionReference: "disabled-rewards-check" },
      ),
    ).rejects.toThrow("paused while the launch promotion completes legal and venue approval");
    await expect(service.planPubGolf(user, {
      startLocation: "Fitzroy",
      finishLocation: "Richmond",
      mode: "auto",
      drinks: Array.from({ length: 9 }, () => "Non-alcoholic beer"),
    })).rejects.toThrow("paused pending App Store and Victorian responsible-promotion approval");
  });

  it("tracks Pint Points, reserves 50 points for one-time Free Pint Rewards, and scopes venue redemption", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "pint-points-admin", "admin");
    const manager = createAccount(repository, "pint-points-manager");
    const otherManager = createAccount(repository, "pint-points-other-manager");
    const user = updateSubscription(
      repository,
      createAccount(repository, "pint-points-user").id,
      "premium_monthly",
      PREMIUM_UNTIL,
    );

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "pint-points-venue",
      venueName: "Pint Points Venue",
      suburb: "Fitzroy",
    });
    await service.assignVenueManager(admin, {
      userId: otherManager.id,
      venueId: "pint-points-other-venue",
      venueName: "Other Pint Points Venue",
      suburb: "Brunswick",
    });
    await service.upsertBarProfile(admin, "pint-points-venue", {
      name: "Pint Points Venue",
      address: "1 Test St",
      suburb: "Fitzroy",
      area: "Fitzroy",
      phone: null,
      website: null,
      instagram: null,
      description: "Affiliated Pro venue.",
      openingHours: {},
      venueTags: [],
      membershipTier: "pro",
      acceptsPintPathCodes: true,
      active: true,
    });

    const assignedManager = repository.getAccountById(manager.id)!;
    const unassignedManager = repository.getAccountById(otherManager.id)!;
    const memberSession = createSession(repository, user.id, "pint-points-member-session");
    const memberPass = await service.getDiscountPass(user, memberSession);
    const memberPreview = await service.previewPintPointMember(assignedManager, "pint-points-venue", {
      code: memberPass.code,
      transactionReference: "receipt-points-1",
    });
    expect(memberPreview).toEqual(expect.objectContaining({
      accountId: user.publicAccountId,
      eligible: true,
      pointsToday: 0,
      pointsRemainingToday: 8,
      wallet: expect.objectContaining({ available: 0, threshold: 50 }),
    }));
    expect(memberPreview).not.toHaveProperty("userId");
    expect(memberPreview).not.toHaveProperty("email");
    expect(memberPreview).not.toHaveProperty("displayName");
    expect(memberPreview.checkoutToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(pintPointDrinkRecordSchema.safeParse({
      accountId: user.publicAccountId,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 1,
      transactionReference: "receipt-public-id-bypass",
    }).success).toBe(false);
    expect(pintPointDrinkRecordSchema.safeParse({
      code: memberPass.code,
      checkoutToken: memberPreview.checkoutToken,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 1,
      transactionReference: "receipt-ambiguous-auth",
    }).success).toBe(false);
    await expect(service.previewPintPointMember(unassignedManager, "pint-points-venue", {
      code: memberPass.code,
      transactionReference: "receipt-points-blocked",
    })).rejects.toThrow("You can only access assigned venues.");
    await service.assignVenueManager(admin, {
      userId: otherManager.id,
      venueId: "pint-points-venue",
      venueName: "Pint Points Venue",
      suburb: "Fitzroy",
    });
    await expect(service.recordPintPointDrink(repository.getAccountById(otherManager.id)!, "pint-points-venue", {
      checkoutToken: memberPreview.checkoutToken,
      code: undefined,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 2,
      transactionReference: "receipt-points-1",
      notes: null,
    })).rejects.toThrow("does not match this purchase");
    await service.revokeVenueManager(admin, { userId: otherManager.id, venueId: "pint-points-venue" });

    const firstDrink = await service.recordPintPointDrink(assignedManager, "pint-points-venue", {
      checkoutToken: memberPreview.checkoutToken,
      code: undefined,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 2,
      transactionReference: "receipt-points-1",
      notes: null,
    });
    expect(firstDrink.pointsEarned).toBe(2);
    expect(firstDrink.wallet.available).toBe(2);
    expect(firstDrink.idempotentReplay).toBe(false);
    expect(firstDrink.record).not.toHaveProperty("userId");
    expect(firstDrink.record).not.toHaveProperty("recordedByUserId");

    const firstDrinkRetry = await service.recordPintPointDrink(assignedManager, "pint-points-venue", {
      checkoutToken: memberPreview.checkoutToken,
      code: undefined,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 2,
      transactionReference: "receipt-points-1",
      notes: null,
    });
    expect(firstDrinkRetry.idempotentReplay).toBe(true);
    expect(firstDrinkRetry.record.id).toBe(firstDrink.record.id);
    expect(firstDrinkRetry.wallet.available).toBe(2);
    await expect(service.recordPintPointDrink(assignedManager, "pint-points-venue", {
      checkoutToken: memberPreview.checkoutToken,
      code: undefined,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 2,
      transactionReference: "receipt-points-different",
      notes: null,
    })).rejects.toThrow("does not match this purchase");
    const unusedPreview = await service.previewPintPointMember(assignedManager, "pint-points-venue", {
      code: memberPass.code,
      transactionReference: "receipt-expired-unrecorded",
    });
    vi.setSystemTime(new Date("2026-05-04T08:31:00.000Z"));
    expect(await service.recordPintPointDrink(assignedManager, "pint-points-venue", {
      checkoutToken: memberPreview.checkoutToken,
      code: undefined,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 2,
      transactionReference: "receipt-points-1",
      notes: null,
    })).toEqual(expect.objectContaining({ idempotentReplay: true, pointsEarned: 2 }));
    await expect(service.recordPintPointDrink(assignedManager, "pint-points-venue", {
      checkoutToken: unusedPreview.checkoutToken,
      code: undefined,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 1,
      transactionReference: "receipt-expired-unrecorded",
      notes: null,
    })).rejects.toThrow("authorization expired");
    vi.setSystemTime(new Date(NOW));
    await expect(service.recordPintPointDrink(assignedManager, "pint-points-venue", {
      checkoutToken: memberPreview.checkoutToken,
      code: undefined,
      itemName: "Different purchase",
      beverageCategory: "alcoholic",
      quantity: 1,
      transactionReference: "receipt-points-1",
      notes: null,
    })).rejects.toThrow("already attached to a different purchase");

    const foodPayload = pintPointDrinkRecordSchema.parse({
      checkoutToken: undefined,
      code: memberPass.code,
      itemName: "Burger",
      beverageCategory: "food",
      quantity: 3,
      isAlcoholic: true,
      transactionReference: "receipt-food-1",
      notes: "Food should not earn points.",
    });
    expect(foodPayload).not.toHaveProperty("isAlcoholic");
    const zeroPointDrink = await service.recordPintPointDrink(assignedManager, "pint-points-venue", foodPayload);
    expect(zeroPointDrink.pointsEarned).toBe(0);
    expect(zeroPointDrink.wallet.available).toBe(2);

    for (const [index, quantity] of [4, 4].entries()) {
      await service.recordPintPointDrink(assignedManager, "pint-points-venue", {
        checkoutToken: undefined,
        code: memberPass.code,
        itemName: "Carlton Draught pint",
        beverageCategory: "alcoholic",
        quantity,
        transactionReference: `receipt-points-${index + 2}`,
        notes: null,
      });
    }

    repository.createPintPointLedgerEntry({
      id: "pint-points-historical-credit",
      userId: user.id,
      venueId: null,
      drinkRecordId: null,
      rewardCodeId: null,
      type: "admin_adjustment",
      pointsDelta: 42,
      pointsReservedDelta: 0,
      description: "Historical verified Pint Points imported for reward-flow testing.",
      createdAt: "2026-05-01T08:00:00.000Z",
      metadata: { testFixture: true },
    });

    const dashboardBeforeReward = await service.getAccountDashboard(repository.getAccountById(user.id)!);
    expect(dashboardBeforeReward.pintPoints).toEqual(expect.objectContaining({
      balance: 50,
      available: 50,
      reserved: 0,
      rewardAvailable: true,
    }));

    const reward = await service.createFreePintRewardCode(repository.getAccountById(user.id)!, { venueId: "pint-points-venue" });
    expect(reward.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(reward.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(reward.redeemUrl).toContain("freePintCode=");
    const rewardUrl = new URL(reward.redeemUrl);
    expect(rewardUrl.searchParams.get("freePintCode")).toBeNull();
    expect(new URLSearchParams(rewardUrl.hash.slice(1)).get("freePintCode")).toBe(reward.code);
    expect(reward.wallet).toEqual(expect.objectContaining({
      balance: 50,
      available: 0,
      reserved: 50,
      rewardAvailable: false,
    }));

    await expect(
      service.handleFreePintRewardCode(unassignedManager, "pint-points-venue", {
        code: reward.code,
        action: "confirm",
        reason: null,
      }),
    ).rejects.toThrow("You can only access assigned venues.");

    const rejected = await service.handleFreePintRewardCode(assignedManager, "pint-points-venue", {
      code: reward.code,
      action: "reject",
      reason: "User could not complete venue checks.",
    });
    expect(rejected).toEqual(expect.objectContaining({
      status: "rejected",
      accountId: user.publicAccountId,
      venueId: "pint-points-venue",
    }));
    expect(rejected.wallet).toEqual(expect.objectContaining({
      balance: 50,
      available: 50,
      reserved: 0,
      rewardAvailable: true,
    }));

    const secondReward = await service.createFreePintRewardCode(repository.getAccountById(user.id)!, { venueId: "pint-points-venue" });
    const redemption = await service.handleFreePintRewardCode(assignedManager, "pint-points-venue", {
      code: secondReward.code,
      action: "confirm",
      reason: null,
    });
    expect(redemption).toEqual(expect.objectContaining({
      status: "redeemed",
      reward: "Free Pint Reward",
      accountId: user.publicAccountId,
      venueId: "pint-points-venue",
      instruction: expect.stringContaining("responsible service"),
    }));
    expect(redemption.wallet).toEqual(expect.objectContaining({
      balance: 0,
      available: 0,
      reserved: 0,
      lifetimeRedeemed: 50,
    }));
    await expect(
      service.handleFreePintRewardCode(assignedManager, "pint-points-venue", {
        code: secondReward.code,
        action: "confirm",
        reason: null,
      }),
    ).rejects.toThrow("already used");

    const portal = await service.getVenuePortal(assignedManager, { venueId: "pint-points-venue" });
    expect(portal.pintPoints.today).toEqual(expect.objectContaining({
      pointsIssued: 8,
      drinkRecords: 4,
      alcoholicDrinks: 10,
      freeRewardsRedeemed: 1,
      expiredOrRejectedCodes: 1,
    }));
    expect(portal.pintPoints.copy).toContain("Free Pint Rewards do not earn another point");
    expect(portal.pintPoints.recentActivity).toContainEqual(expect.objectContaining({
      publicAccountId: user.publicAccountId,
      itemName: "Guinness pint",
      quantity: 2,
      pointsAwarded: 2,
    }));
    expect(JSON.stringify(portal.pintPoints.recentActivity)).not.toContain(user.id);
  });

  it("expires counter-staff invitations after 72 hours and allows a fresh invitation", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "expiring-counter-admin", "admin");
    const manager = createAccount(repository, "expiring-counter-manager");
    const staff = createAccount(repository, "expiring-counter-staff");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "expiring-counter-venue",
      venueName: "Expiring Counter Venue",
      suburb: "Carlton",
    });
    const managerAccount = repository.getAccountById(manager.id)!;
    const invitation = await service.assignVenueCounterStaff(managerAccount, "expiring-counter-venue", {
      accountId: staff.publicAccountId,
    });
    expect(invitation.assignment).toEqual(expect.objectContaining({
      status: "pending",
      expiresAt: "2026-05-07T08:00:00.000Z",
    }));

    vi.setSystemTime(new Date("2026-05-07T09:00:00.000Z"));
    expect((await service.getAccountDashboard(repository.getAccountById(staff.id)!)).counterStaffInvitations).toEqual([]);
    await expect(service.respondToVenueCounterStaffInvitation(
      repository.getAccountById(staff.id)!,
      invitation.assignment.id,
      { decision: "accept" },
    )).rejects.toThrow("not found or it has expired");

    const replacement = await service.assignVenueCounterStaff(managerAccount, "expiring-counter-venue", {
      accountId: staff.publicAccountId,
    });
    expect(replacement.assignment).toEqual(expect.objectContaining({
      status: "pending",
      expiresAt: "2026-05-10T09:00:00.000Z",
    }));
  });

  it("defaults mixed manager and counter accounts to their manager dashboard", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "mixed-access-admin", "admin");
    const mixedAccount = createAccount(repository, "mixed-access-manager");
    const secondManager = createAccount(repository, "mixed-access-second-manager");

    await service.assignVenueManager(admin, {
      userId: mixedAccount.id,
      venueId: "mixed-manager-venue",
      venueName: "Mixed Manager Venue",
      suburb: "Carlton",
    });
    await service.assignVenueManager(admin, {
      userId: secondManager.id,
      venueId: "mixed-counter-venue",
      venueName: "Mixed Counter Venue",
      suburb: "Fitzroy",
    });

    vi.setSystemTime(new Date("2026-05-04T08:15:00.000Z"));
    const invitation = await service.assignVenueCounterStaff(
      repository.getAccountById(secondManager.id)!,
      "mixed-counter-venue",
      { accountId: mixedAccount.publicAccountId },
    );
    await service.respondToVenueCounterStaffInvitation(
      repository.getAccountById(mixedAccount.id)!,
      invitation.assignment.id,
      { decision: "accept" },
    );

    const account = repository.getAccountById(mixedAccount.id)!;
    expect(await service.getVenuePortal(account, {})).toEqual(expect.objectContaining({
      accessLevel: "manager",
      selectedVenue: expect.objectContaining({ venueId: "mixed-manager-venue" }),
    }));
    expect(await service.getVenuePortal(account, { venueId: "mixed-counter-venue" })).toEqual(expect.objectContaining({
      accessState: "counter_staff",
      accessLevel: "counter_staff",
      selectedVenue: expect.objectContaining({ venueId: "mixed-counter-venue" }),
    }));
  });

  it("scopes counter staff to checkout tools and reverses mistaken Pint Points with an audit trail", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "counter-admin", "admin");
    const manager = createAccount(repository, "counter-manager");
    const staff = createAccount(repository, "counter-staff");
    const secondStaff = createAccount(repository, "counter-staff-two");
    const member = updateSubscription(
      repository,
      createAccount(repository, "counter-member").id,
      "premium_monthly",
      PREMIUM_UNTIL,
    );

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "counter-venue",
      venueName: "Counter Venue",
      suburb: "Richmond",
    });
    await service.upsertBarProfile(admin, "counter-venue", {
      name: "Counter Venue",
      address: "1 Swan St",
      suburb: "Richmond",
      area: "Richmond",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "pro",
      acceptsPintPathCodes: true,
      active: true,
    });

    const managerAccount = repository.getAccountById(manager.id)!;
    const staffAssignment = await service.assignVenueCounterStaff(managerAccount, "counter-venue", {
      accountId: staff.publicAccountId,
    });
    const secondStaffAssignment = await service.assignVenueCounterStaff(managerAccount, "counter-venue", {
      accountId: secondStaff.publicAccountId,
    });
    expect(staffAssignment.assignment).toEqual(expect.objectContaining({
      venueId: "counter-venue",
      accessLevel: "counter_staff",
      publicAccountId: staff.publicAccountId,
      status: "pending",
    }));
    expect(staffAssignment.assignment.userId).toBeUndefined();
    expect((await service.getAccountDashboard(repository.getAccountById(staff.id)!)).counterStaffInvitations).toContainEqual(
      expect.objectContaining({ id: staffAssignment.assignment.id, venueId: "counter-venue" }),
    );
    await service.respondToVenueCounterStaffInvitation(repository.getAccountById(staff.id)!, staffAssignment.assignment.id, {
      decision: "accept",
    });
    await service.respondToVenueCounterStaffInvitation(repository.getAccountById(secondStaff.id)!, secondStaffAssignment.assignment.id, {
      decision: "accept",
    });

    const staffAccount = repository.getAccountById(staff.id)!;
    const secondStaffAccount = repository.getAccountById(secondStaff.id)!;
    const staffDashboard = await service.getAccountDashboard(staffAccount);
    expect(staffDashboard.counterStaffInvitations).toEqual([]);
    expect(staffDashboard.counterStaffAssignments).toEqual([{
      id: staffAssignment.assignment.id,
      venueId: "counter-venue",
      venueName: "Counter Venue",
      suburb: "Richmond",
      accessLevel: "counter_staff",
      status: "active",
      portalPath: "/venue-portal.html?venueId=counter-venue&tab=redemption",
      capabilities: {
        openCounter: true,
        recordPintPointPurchases: true,
        redeemFreePintRewards: true,
        voidOwnRecentPurchases: true,
        manageVenue: false,
        viewVenueAnalytics: false,
      },
    }]);
    expect(staffDashboard.counterStaffAssignments[0]).not.toHaveProperty("userId");
    expect(staffDashboard.counterStaffAssignments[0]).not.toHaveProperty("approvedBy");
    expect((await service.getAuthSession(staffAccount)).counterStaffAssignments)
      .toEqual(staffDashboard.counterStaffAssignments);
    const counterPortal = await service.getVenuePortal(staffAccount, { venueId: "counter-venue" });
    expect(counterPortal).toEqual(expect.objectContaining({
      accessState: "counter_staff",
      accessLevel: "counter_staff",
      analytics: null,
      monthlyReport: null,
      posIntegration: null,
      businessToolkit: null,
    }));
    expect(counterPortal.profile).toEqual({
      barId: "counter-venue",
      name: "Counter Venue",
      suburb: "Richmond",
      membershipTier: "pro",
      acceptsPintPathCodes: true,
    });
    expect(JSON.stringify(counterPortal)).not.toContain("posWebhookToken");
    await expect(service.upsertBarProfile(staffAccount, "counter-venue", {
      name: "Escalated Venue",
      address: null,
      suburb: "Richmond",
      area: "Richmond",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      acceptsPintPathCodes: true,
      active: true,
    })).rejects.toThrow("Venue manager access required");

    const session = createSession(repository, member.id, "counter-member-session");
    const pass = await service.getDiscountPass(member, session);
    const firstPreview = await service.previewPintPointMember(staffAccount, "counter-venue", {
      code: pass.code,
      transactionReference: "counter-receipt-1",
    });
    expect(firstPreview.eligible).toBe(true);
    const first = await service.recordPintPointDrink(staffAccount, "counter-venue", {
      code: undefined,
      checkoutToken: firstPreview.checkoutToken,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 2,
      transactionReference: "counter-receipt-1",
      notes: null,
    });
    expect(first.wallet.available).toBe(2);
    await expect(service.voidPintPointDrink(secondStaffAccount, "counter-venue", first.record.id, {
      reason: "Trying another staff record",
    })).rejects.toThrow("only reverse purchases they recorded themselves");

    const reversed = await service.voidPintPointDrink(staffAccount, "counter-venue", first.record.id, {
      reason: "Wrong member selected",
    });
    expect(reversed).toEqual(expect.objectContaining({
      pointsReversed: 2,
      idempotentReplay: false,
      wallet: expect.objectContaining({ available: 0, lifetimeRedeemed: 0 }),
      record: expect.objectContaining({ status: "void", voidReason: "Wrong member selected" }),
    }));
    expect((await service.voidPintPointDrink(staffAccount, "counter-venue", first.record.id, {
      reason: "Safe retry",
    })).idempotentReplay).toBe(true);
    expect(await service.recordPintPointDrink(staffAccount, "counter-venue", {
      code: undefined,
      checkoutToken: firstPreview.checkoutToken,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 2,
      transactionReference: "counter-receipt-1",
      notes: null,
    })).toEqual(expect.objectContaining({ idempotentReplay: true, voided: true, pointsEarned: 0 }));
    expect(repository.listPintPointDrinkRecordsForUser(member.id, 25)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: first.record.id })]),
    );

    const secondPreview = await service.previewPintPointMember(staffAccount, "counter-venue", {
      code: pass.code,
      transactionReference: "counter-receipt-2",
    });
    const second = await service.recordPintPointDrink(staffAccount, "counter-venue", {
      code: undefined,
      checkoutToken: secondPreview.checkoutToken,
      itemName: "Carlton Draught pint",
      beverageCategory: "alcoholic",
      quantity: 1,
      transactionReference: "counter-receipt-2",
      notes: null,
    });
    vi.setSystemTime(new Date("2026-05-04T08:16:00.000Z"));
    await expect(service.voidPintPointDrink(staffAccount, "counter-venue", second.record.id, {
      reason: "Late staff correction",
    })).rejects.toThrow("Ask a venue manager");
    expect((await service.voidPintPointDrink(managerAccount, "counter-venue", second.record.id, {
      reason: "Manager approved correction",
    })).idempotentReplay).toBe(false);

    const managerPortal = await service.getVenuePortal(managerAccount, { venueId: "counter-venue" });
    expect(managerPortal.pintPoints.today).toEqual(expect.objectContaining({
      pointsIssued: 0,
      drinkRecords: 0,
      alcoholicDrinks: 0,
    }));
    expect(managerPortal.pintPoints.recentActivity).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.record.id, status: "void", canVoid: false }),
      expect.objectContaining({ id: second.record.id, status: "void", canVoid: false }),
    ]));

    await service.revokeVenueCounterStaff(managerAccount, "counter-venue", { accountId: staff.publicAccountId });
    expect((await service.getAuthSession(repository.getAccountById(staff.id)!)).counterStaffAssignments).toEqual([]);
    expect(await service.getVenuePortal(repository.getAccountById(staff.id)!, { venueId: "counter-venue" })).toEqual(
      expect.objectContaining({ accessState: "claim_required" }),
    );
  });

  it("supports Pro venue POS discount webhooks with scoped tokens and privacy-safe venue stats", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "pos-discount-admin", "admin");
    const manager = createAccount(repository, "pos-discount-manager");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "pos-discount-venue",
      venueName: "POS Discount Venue",
      suburb: "CBD",
    });
    await service.upsertBarProfile(admin, "pos-discount-venue", {
      name: "POS Discount Venue",
      address: "1 Collins St",
      suburb: "CBD",
      area: "CBD",
      phone: null,
      website: null,
      instagram: null,
      description: "A Pro venue testing POS redemptions.",
      openingHours: {},
      venueTags: ["sports bar"],
      membershipTier: "pro",
      acceptsPintPathCodes: true,
      active: true,
    });
    await service.upsertBarProfile(admin, "pos-basic-venue", {
      name: "POS Basic Venue",
      address: "2 Collins St",
      suburb: "CBD",
      area: "CBD",
      phone: null,
      website: null,
      instagram: null,
      description: "A basic venue should not use POS automation.",
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      active: true,
    });
    await getVenueInventoryRepository(repository).upsertBarSpecial({
      id: "pos-special-1",
      barId: "pos-discount-venue",
      title: "Pint Path $2 house pint",
      description: "$2 off a verified purchase.",
      price: null,
      discount: "$2 off",
      savingsAmountCents: 200,
      startsAt: null,
      endsAt: null,
      startTime: null,
      endTime: null,
      scheduleNote: null,
      exclusive: false,
      active: true,
      now: NOW,
    });

    const assignedManager = repository.getAccountById(manager.id)!;
    const integration = await service.getVenuePosIntegration(assignedManager, "pos-discount-venue");
    expect(integration.enabled).toBe(true);
    expect(integration).not.toHaveProperty("token");
    expect(integration.tokenPreview).toMatch(/^[a-f0-9]{8}\.\.\.[a-f0-9]{8}$/);
    expect(integration.payloadExample).toEqual(expect.objectContaining({
      venueId: "pos-discount-venue",
      specialId: "special_venue_offer_id",
      discountAmountCents: 200,
    }));

    const rotatedIntegration = await service.rotateVenuePosIntegrationToken(assignedManager, "pos-discount-venue");
    expect(rotatedIntegration.token).toMatch(/^[a-f0-9]{64}$/);
    const webhookToken = rotatedIntegration.token ?? "";

    const premiumUser = updateSubscription(
      repository,
      createAccount(repository, "pos-discount-premium-user").id,
      "premium_monthly",
      PREMIUM_UNTIL,
    );
    const pass = await service.getDiscountPass(
      premiumUser,
      createSession(repository, premiumUser.id, "pos-discount-user-session-token"),
    );

    const redemption = await service.redeemDiscountPassFromPos({
      venueId: "pos-discount-venue",
      code: pass.code,
      specialId: "pos-special-1",
      itemName: "Pint Path $2 house pint",
      quantity: 1,
      discountAmountCents: 200,
      posReference: "receipt-4242",
      terminalId: "front-bar-1",
      redeemedAt: "2026-05-04T08:02:00.000Z",
      metadata: {
        cashierEmail: "should-not-store@example.com",
        note: "safe note",
      },
    }, webhookToken);

    expect(redemption.accountId).toBe(premiumUser.publicAccountId);
    expect(redemption.estimatedSavingsDollars).toBe(2);
    expect(redemption.pointsEarned).toBe(0);
    expect(redemption.redemption.redeemedByUserId).toBeNull();
    expect(redemption.redemption.metadata).toEqual(expect.objectContaining({
      source: "pos_webhook",
      redeemedByRole: "pos_webhook",
      posReference: "receipt-4242",
      terminalId: "front-bar-1",
      note: "safe note",
    }));
    expect(JSON.stringify(redemption.redemption.metadata)).not.toContain("should-not-store@example.com");

    const passReplay = await service.redeemDiscountPassFromPos({
        venueId: "pos-discount-venue",
        code: pass.code,
        itemName: "Replay",
        quantity: 1,
        discountAmountCents: 200,
      }, webhookToken);
    expect(passReplay).toEqual(expect.objectContaining({ idempotentReplay: true, pointsEarned: 0 }));

    await expect(
      service.redeemDiscountPassFromPos({
        venueId: "pos-basic-venue",
        code: pass.code,
        itemName: "Wrong venue",
        quantity: 1,
        discountAmountCents: 200,
      }, webhookToken),
    ).rejects.toThrow("Invalid POS webhook token.");

    const basicIntegration = await service.getVenuePosIntegration(admin, "pos-basic-venue");
    expect(basicIntegration).toEqual(expect.objectContaining({
      enabled: false,
      proRequired: true,
      tokenPreview: null,
    }));
    expect(basicIntegration).not.toHaveProperty("token");
    const basicVenueToken = crypto
      .createHmac("sha256", "test-pos-webhook-signing-secret-32-bytes")
      .update("pint-path-pos-redemption:pos-basic-venue:v1")
      .digest("hex");
    const secondPass = await service.getDiscountPass(
      premiumUser,
      createSession(repository, premiumUser.id, "pos-discount-second-user-session-token"),
    );
    await expect(
      service.redeemDiscountPassFromPos({
        venueId: "pos-basic-venue",
        code: secondPass.code,
        itemName: "Basic venue POS attempt",
        quantity: 1,
        discountAmountCents: 100,
      }, basicVenueToken),
    ).rejects.toThrow("Pro venue tier required for POS webhook redemptions.");

    const portal = await service.getVenuePortal(assignedManager, { venueId: "pos-discount-venue" });
    expect(portal.posIntegration).toEqual(expect.objectContaining({
      enabled: true,
      venueId: "pos-discount-venue",
      authHeader: "X-Pint-Path-POS-Token",
    }));
    expect(portal.discounts).toEqual(expect.objectContaining({
      totalRedemptions: 1,
      estimatedSavingsCents: 200,
      estimatedSavingsDollars: 2,
      uniqueAccounts: 1,
      totalQuantity: 1,
    }));
    expect(portal.discounts.topItems[0]).toEqual(expect.objectContaining({
      itemName: "Pint Path $2 house pint",
      redemptions: 1,
    }));
    expect(portal.discounts.recentRedemptions[0]).toEqual(expect.objectContaining({
      accountId: premiumUser.publicAccountId,
      itemName: "Pint Path $2 house pint",
      source: "pos_webhook",
      posReference: "receipt-4242",
    }));
  });

  it("publishes approved submission items as photo-verified public price records", async () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "submitter");
    const admin = createAccount(repository, "admin", "admin");
    const submission = createSubmission(repository, {
      id: "submission-1",
      userId: user.id,
      venueId: "venue-1",
      beerName: "Stone & Wood Pacific Ale",
      price: 15.5,
    });

    approve(repository, submission.id, admin.id);

    expect(await publicPriceRepositories.get(repository)!.listLatestPriceRecords(10)).toEqual([
      expect.objectContaining({
        venueId: "venue-1",
        beerName: "Stone & Wood Pacific Ale",
        servingSize: "pint",
        price: 15.5,
        confidence: "photo_verified",
        sourceSubmissionId: submission.id,
      }),
    ]);
  });

  it("standardises submitted beer names and adds new beers to the system catalogue", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "catalog-submit-user");
    const admin = createAccount(repository, "catalog-submit-admin", "admin");

    const aliasSubmission = await service.createSubmission(user, createSubmissionSchema.parse({
      venueId: "catalog-venue-1",
      venueName: "Catalog Bar",
      suburb: "Melbourne",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoUrl: null,
      sourcePhotoDataUrl: null,
      notes: null,
      items: [{
        beerName: "Carlton Draft",
        servingSize: "pint",
        price: 13,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }));
    const aliasItem = repository.getSubmissionById(aliasSubmission.submission.id)!.items[0]!;
    expect(aliasItem.beerName).toBe("Carlton Draught");
    expect(aliasItem.normalizedBeerId).toBe("carlton_draft");

    const firstUnknown = await service.createSubmission(user, createSubmissionSchema.parse({
      venueId: "catalog-venue-2",
      venueName: "Local Taproom",
      suburb: "Fitzroy",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoUrl: null,
      sourcePhotoDataUrl: null,
      notes: null,
      items: [{
        beerName: "Very Local Hazy Pint",
        servingSize: "pint",
        price: 15,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }));
    const unknownItem = repository.getSubmissionById(firstUnknown.submission.id)!.items[0]!;
    expect(unknownItem).toEqual(expect.objectContaining({
      beerName: "Very Local Hazy Pint",
      normalizedBeerId: "very_local_hazy_pint",
    }));
    expect(database.prepare("SELECT key, name, status FROM beer_catalog_items WHERE key = ?").get("very_local_hazy_pint")).toEqual(expect.objectContaining({
      key: "very_local_hazy_pint",
      name: "Very Local Hazy Pint",
      status: "pending_review",
    }));

    const secondUnknown = await service.createSubmission(user, createSubmissionSchema.parse({
      venueId: "catalog-venue-3",
      venueName: "Second Taproom",
      suburb: "Collingwood",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoUrl: null,
      sourcePhotoDataUrl: null,
      notes: null,
      items: [{
        beerName: "very local hazy pint",
        servingSize: "pint",
        price: 16,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }));
    expect(repository.getSubmissionById(secondUnknown.submission.id)!.items[0]).toEqual(expect.objectContaining({
      beerName: "Very Local Hazy Pint",
      normalizedBeerId: "very_local_hazy_pint",
    }));
    expect((await service.getPublicConfig()).trackedBeers).not.toContainEqual(expect.objectContaining({
      key: "very_local_hazy_pint",
    }));
    expect((await service.getAdminBeerCatalog(admin)).pending).toContainEqual(expect.objectContaining({
      key: "very_local_hazy_pint",
      name: "Very Local Hazy Pint",
      aliases: expect.arrayContaining(["Very Local Hazy Pint"]),
    }));
  });

  it("lets admins approve or merge pending beer catalogue names without leaving duplicate IDs", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "catalog-review-user");
    const admin = createAccount(repository, "catalog-review-admin", "admin");

    const targetSubmission = await service.createSubmission(user, createSubmissionSchema.parse({
      venueId: "catalog-review-venue-1",
      venueName: "Review Bar",
      suburb: "Melbourne",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoUrl: null,
      sourcePhotoDataUrl: null,
      notes: null,
      items: [{
        beerName: "Very Local Hazy Pint",
        servingSize: "pint",
        price: 15,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }));
    expect(repository.getSubmissionById(targetSubmission.submission.id)!.items[0]).toEqual(expect.objectContaining({
      beerName: "Very Local Hazy Pint",
      normalizedBeerId: "very_local_hazy_pint",
    }));

    const approved = await service.approveBeerCatalogItem(admin, "very_local_hazy_pint", {
      reviewNote: "Real local beer.",
    });
    expect(approved.beer).toEqual(expect.objectContaining({
      key: "very_local_hazy_pint",
      name: "Very Local Hazy Pint",
      status: "active",
    }));
    expect((await service.getPublicConfig()).trackedBeers).toContainEqual(expect.objectContaining({
      key: "very_local_hazy_pint",
      name: "Very Local Hazy Pint",
      aliases: expect.arrayContaining(["Very Local Hazy Pint"]),
    }));

    const typoSubmission = await service.createSubmission(user, createSubmissionSchema.parse({
      venueId: "catalog-review-venue-2",
      venueName: "Typo Bar",
      suburb: "Fitzroy",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoUrl: null,
      sourcePhotoDataUrl: null,
      notes: null,
      items: [{
        beerName: "Very Locl Hazy Pint",
        servingSize: "pint",
        price: 16,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }));
    expect(repository.getSubmissionById(typoSubmission.submission.id)!.items[0]).toEqual(expect.objectContaining({
      beerName: "Very Locl Hazy Pint",
      normalizedBeerId: "very_locl_hazy_pint",
    }));
    expect((await service.getAdminBeerCatalog(admin)).pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "very_locl_hazy_pint" }),
    ]));

    const merged = await service.mergeBeerCatalogItem(admin, "very_locl_hazy_pint", {
      targetKey: "very_local_hazy_pint",
      reviewNote: "Typo merged.",
    });
    expect(merged.target).toEqual(expect.objectContaining({
      key: "very_local_hazy_pint",
      aliases: expect.arrayContaining(["Very Locl Hazy Pint"]),
    }));
    expect(repository.getSubmissionById(typoSubmission.submission.id)!.items[0]).toEqual(expect.objectContaining({
      beerName: "Very Local Hazy Pint",
      normalizedBeerId: "very_local_hazy_pint",
    }));
    expect((await service.getAdminBeerCatalog(admin)).pending).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "very_locl_hazy_pint" }),
    ]));

    await service.createSubmission(user, createSubmissionSchema.parse({
      venueId: "catalog-review-venue-3",
      venueName: "Crawler Noise Bar",
      suburb: "Richmond",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoUrl: null,
      sourcePhotoDataUrl: null,
      notes: null,
      items: [{
        beerName: "Website Copy Lager",
        servingSize: "pint",
        price: 14,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }));
    expect((await service.getAdminBeerCatalog(admin)).pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "website_copy_lager" }),
    ]));

    const rejected = await service.rejectBeerCatalogItem(admin, "website_copy_lager", {
      reviewNote: "Not a real beer name.",
    });
    expect(rejected.beer).toEqual(expect.objectContaining({
      key: "website_copy_lager",
      name: "Website Copy Lager",
      reviewNote: "Not a real beer name.",
    }));
    expect((await service.getAdminBeerCatalog(admin)).pending).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "website_copy_lager" }),
    ]));
    await expect(service.rejectBeerCatalogItem(admin, "very_local_hazy_pint", {
      reviewNote: "Do not delete active beers.",
    })).rejects.toThrow("Pending beer was not found.");
  });

  it("lets admins bulk reject pending beer catalogue junk", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "catalog-bulk-admin", "admin");
    const catalogRepository = new BeerCatalogRepository(getAsyncDatabase(database));

    await catalogRepository.resolveBeerName({
      name: "Footer Copy Ale",
      source: "menu_crawler_import",
      now: NOW,
    });
    await catalogRepository.resolveBeerName({
      name: "Website Nav Lager",
      source: "menu_crawler_import",
      now: NOW,
    });

    const result = await service.rejectBeerCatalogItems(admin, {
      keys: ["footer_copy_ale", "website_nav_lager"],
      reviewNote: "Fast rejected as beer catalogue cleanup noise.",
    });

    expect(result.rejectedCount).toBe(2);
    expect(result.beers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "footer_copy_ale",
        reviewNote: "Fast rejected as beer catalogue cleanup noise.",
      }),
      expect.objectContaining({
        key: "website_nav_lager",
        reviewNote: "Fast rejected as beer catalogue cleanup noise.",
      }),
    ]));
    expect((await service.getAdminBeerCatalog(admin)).pending).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "footer_copy_ale" }),
      expect.objectContaining({ key: "website_nav_lager" }),
    ]));
  });

  it("increments fraud strikes and suspends reward earning after three fraud flags", async () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "fraud-user");
    const admin = createAccount(repository, "admin", "admin");

    ["venue-1", "venue-2", "venue-3"].forEach((venueId, index) => {
      const submission = createSubmission(repository, {
        id: `submission-${index + 1}`,
        userId: user.id,
        venueId,
      });
      flagFraud(repository, submission.id, admin.id);
    });

    const updated = repository.getAccountById(user.id);
    expect(updated?.fraudStrikeCount).toBe(3);
    expect(updated?.status).toBe("suspended");
    expect(updated?.contributionPointsCurrentMonth).toBe(0);
  });

  it("keeps needs-more-evidence neutral, distinguishes disputes, and canonicalises fraud outcomes", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "review-outcome-user");
    const admin = createAccount(repository, "review-outcome-admin", "admin");
    const needsEvidence = createSubmission(repository, {
      id: "review-needs-evidence",
      userId: user.id,
      venueId: "review-venue-1",
    });

    await service.reviewSubmission(admin, needsEvidence.id, {
      status: "needs_more_evidence",
      rejectionReason: "Please add a clearer menu photo.",
      fraudFlagged: false,
      confidence: "user_reported_pending",
    });
    expect(repository.getAccountById(user.id)).toEqual(expect.objectContaining({
      approvedSubmissionCount: 0,
      rejectedSubmissionCount: 0,
      fraudStrikeCount: 0,
      trustScore: 50,
    }));
    expect(database.prepare("SELECT count(*) AS count FROM events WHERE event_type = 'submission_rejected'").get())
      .toEqual({ count: 0 });

    await service.reviewSubmission(admin, needsEvidence.id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    });
    expect(repository.getAccountById(user.id)).toEqual(expect.objectContaining({
      approvedSubmissionCount: 1,
      rejectedSubmissionCount: 0,
      trustScore: 53,
    }));

    const disputed = createSubmission(repository, {
      id: "review-disputed",
      userId: user.id,
      venueId: "review-venue-2",
    });
    await service.reviewSubmission(admin, disputed.id, {
      status: "disputed",
      rejectionReason: "Conflicting current menu evidence.",
      fraudFlagged: false,
      confidence: "disputed",
    });
    expect(repository.getAccountById(user.id)).toEqual(expect.objectContaining({
      rejectedSubmissionCount: 1,
      fraudStrikeCount: 0,
      trustScore: 51,
    }));

    const fraud = createSubmission(repository, {
      id: "review-fraud",
      userId: user.id,
      venueId: "review-venue-3",
    });
    await service.reviewSubmission(admin, fraud.id, {
      status: "fraud_flagged",
      rejectionReason: "Evidence was deliberately falsified.",
      fraudFlagged: false,
      confidence: "disputed",
    });
    expect(repository.getSubmissionById(fraud.id)?.submission.fraudFlagged).toBe(true);
    expect(repository.getAccountById(user.id)).toEqual(expect.objectContaining({
      rejectedSubmissionCount: 2,
      fraudStrikeCount: 1,
      trustScore: 31,
      status: "warned",
    }));
    const outcomes = database.prepare(
      "SELECT event_type, metadata_json FROM events WHERE event_type IN ('submission_approved', 'submission_rejected') ORDER BY created_at, id",
    ).all() as Array<{ event_type: string; metadata_json: string }>;
    expect(outcomes.filter((event) => event.event_type === "submission_approved")).toHaveLength(1);
    expect(outcomes.filter((event) => event.event_type === "submission_rejected")).toHaveLength(2);
    expect(outcomes.some((event) => event.metadata_json.includes('"reviewOutcome":"disputed"'))).toBe(true);
  });

  it("filters and normalizes Google venue lookup results for user new-bar submissions", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      GOOGLE_PLACES_API_KEY: "test-google-places-key",
    });
    const user = createAccount(repository, "venue-lookup-user");
    const googlePlace = {
      id: "google-place-german-restaurant",
      displayName: { text: "German Restaurant" },
      formattedAddress: "650 Bridge Rd, Richmond VIC 3121, Australia",
      addressComponents: [
        { longText: "Richmond", shortText: "Richmond", types: ["locality"] },
        { longText: "Victoria", shortText: "VIC", types: ["administrative_area_level_1"] },
        { longText: "3121", shortText: "3121", types: ["postal_code"] },
      ],
      location: { latitude: -37.81931, longitude: 145.01123 },
      businessStatus: "OPERATIONAL",
      primaryType: "restaurant",
      types: ["restaurant", "bar"],
    };
    const junkPlace = {
      id: "google-place-shirt-shop",
      displayName: { text: "Bridge Road T Shirt Shop" },
      formattedAddress: "650 Bridge Rd, Richmond VIC 3121, Australia",
      businessStatus: "OPERATIONAL",
      primaryType: "clothing_store",
      types: ["clothing_store", "store"],
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlText = String(url);
      if (urlText.includes("places:searchText")) {
        return new Response(JSON.stringify({ places: [googlePlace, junkPlace] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({
        ...googlePlace,
        nationalPhoneNumber: "(03) 9428 1234",
        websiteUri: "https://example.com/german-restaurant",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const search = await service.searchVenuePlacesForSubmission(user, "German Restaurant 650 Bridge Rd");
      expect(search.configured).toBe(true);
      expect(search.places).toHaveLength(1);
      expect(search.places[0]).toEqual(expect.objectContaining({
        googlePlaceId: "google-place-german-restaurant",
        name: "German Restaurant",
        address: "650 Bridge Rd, Richmond VIC 3121",
        suburb: "Richmond",
        state: "VIC",
        postcode: "3121",
        latitude: -37.81931,
        longitude: 145.01123,
        alreadyExists: false,
      }));

      const detail = await service.getVenuePlaceForSubmission(user, "google-place-german-restaurant");
      expect(detail.place).toEqual(expect.objectContaining({
        phone: "(03) 9428 1234",
        website: "https://example.com/german-restaurant",
      }));
      expect(fetchMock).toHaveBeenCalledWith(
        "https://places.googleapis.com/v1/places:searchText",
        expect.objectContaining({
          method: "POST",
          redirect: "error",
          headers: expect.objectContaining({
            "X-Goog-Api-Key": "test-google-places-key",
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps Google-verified venues and beer rows private until one atomic admin approval", async () => {
    const { repository, database } = createRepository();
    const service = createBusinessService(repository, {
      GOOGLE_PLACES_API_KEY: "test-google-places-key",
    });
    const user = createAccount(repository, "locked-venue-submit-user");
    const firstVerifier = createAccount(repository, "google-venue-first-verifier");
    const secondVerifier = createAccount(repository, "google-venue-second-verifier");
    const admin = createAccount(repository, "google-venue-review-admin", "admin");
    const googlePlace = {
      id: "google-place-locked-venue",
      displayName: { text: "Locked Google Bar" },
      formattedAddress: "12 Lock St, Fitzroy VIC 3065, Australia",
      addressComponents: [
        { longText: "Fitzroy", shortText: "Fitzroy", types: ["locality"] },
        { longText: "Victoria", shortText: "VIC", types: ["administrative_area_level_1"] },
        { longText: "3065", shortText: "3065", types: ["postal_code"] },
      ],
      location: { latitude: -37.798, longitude: 144.979 },
      nationalPhoneNumber: "(03) 9000 1000",
      websiteUri: "https://locked-google-bar.example.com",
      businessStatus: "OPERATIONAL",
      primaryType: "bar",
      types: ["bar", "restaurant"],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(googlePlace), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const basePayload = {
      venueId: "browser-tampered-id",
      venueName: "T Shirt Shop Payload",
      suburb: "Wrong",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: null,
      sourcePhotoUrl: null,
      notes: null,
      uploadLocation: null,
      items: [{
        beerName: "Guinness",
        servingSize: "pint",
        price: 13,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    } as const;

    try {
      await expect(service.createUserSubmission(user, createSubmissionSchema.parse({
        ...basePayload,
        newVenue: {
          googlePlaceId: null,
          name: "Manual Only Venue",
          address: "1 Manual St",
          suburb: "Fitzroy",
          state: "VIC",
          postcode: "3065",
          phone: null,
          website: null,
          latitude: -37.798,
          longitude: 144.979,
        },
      }))).rejects.toThrow("Choose the new venue from Google Maps");

      const requestResult = await service.createVenueRequest(user, {
        anonymousSessionId: "anon-locked-google-bar",
        requestType: "missing_venue",
        venueId: null,
        venueName: "Locked Google Bar",
        googlePlaceId: "google-place-locked-venue",
        beerName: null,
        suburb: "Fitzroy",
        notes: "Google-selected venue request before adding drink rows.",
      });
      expect(requestResult.message).toBe("Locked Google Bar has been added to the admin review queue.");
      expect(requestResult.duplicate).toBe(false);
      expect(requestResult.request.googlePlaceId).toBe("google-place-locked-venue");
      const duplicateRequest = await service.createVenueRequest(user, {
        anonymousSessionId: "anon-locked-google-bar",
        requestType: "missing_venue",
        venueId: null,
        venueName: "Locked Google Bar",
        googlePlaceId: "google-place-locked-venue",
        beerName: null,
        suburb: "Fitzroy",
        notes: "Safe retry from the same device.",
      });
      expect(duplicateRequest).toEqual(expect.objectContaining({
        duplicate: true,
        message: "Locked Google Bar is already in the admin review queue.",
        request: expect.objectContaining({ id: requestResult.request.id }),
      }));
      expect((await getVenueRequestRepository(repository).listVenueRequests({ limit: 10 })).requests)
        .toHaveLength(1);

      const result = await service.createUserSubmission(user, createSubmissionSchema.parse({
        ...basePayload,
        newVenue: {
          googlePlaceId: "google-place-locked-venue",
          name: "Tampered Browser Name",
          address: "1 Wrong Road",
          suburb: "Wrong",
          state: "VIC",
          postcode: "3000",
          phone: null,
          website: null,
          latitude: null,
          longitude: null,
        },
      }));

      expect(result.submission.venueId).toMatch(/^venue-google-[a-f0-9]{24}$/);
      expect(result.submission.venueName).toBe("Locked Google Bar");
      expect(result.submission.suburb).toBe("Fitzroy");
      expect(result.statusCopy).toContain("New venue and drink data submitted for admin review");
      expect(result.statusCopy).toContain("global map only after approval");
      expect(result.linkedVenueRequestCount).toBe(0);
      expect(result.submission.pendingVenue).toEqual(expect.objectContaining({
        googlePlaceId: "google-place-locked-venue",
        name: "Locked Google Bar",
        address: "12 Lock St, Fitzroy VIC 3065",
        suburb: "Fitzroy",
        postcode: "3065",
        phone: "(03) 9000 1000",
        website: "https://locked-google-bar.example.com",
        latitude: -37.798,
        longitude: 144.979,
      }));

      expect(database.prepare("SELECT 1 AS present FROM venue_profiles WHERE venue_id = ?")
        .get(result.submission.venueId)).toBeUndefined();
      expect(await publicPriceRepositories.get(repository)!.listVenueManagerPriceRecords(20, result.submission.venueId)).toEqual([]);
      expect(await getVenueRequestRepository(repository).getVenueRequestById(requestResult.request.id))
        .toEqual(expect.objectContaining({
        status: "open",
        venueId: null,
        googlePlaceId: "google-place-locked-venue",
        sourceSubmissionId: null,
        resolvedAt: null,
        }));

      const firstVerification = await service.verifySubmission(firstVerifier, result.submission.id, {
        result: "confirmed",
        notes: "Matches the venue menu board.",
      });
      expect(firstVerification.autoApproved).toBe(false);
      expect(await publicPriceRepositories.get(repository)!.listVenueManagerPriceRecords(20, result.submission.venueId)).toEqual([]);

      const secondVerification = await service.verifySubmission(secondVerifier, result.submission.id, {
        result: "confirmed",
        notes: "Same pint price seen tonight.",
      });
      expect(secondVerification.autoApproved).toBe(false);
      expect(secondVerification.confirmedCount).toBe(2);
      expect(repository.getSubmissionById(result.submission.id)?.submission.status).toBe("pending");
      expect(await publicPriceRepositories.get(repository)!.listVenueManagerPriceRecords(20, result.submission.venueId)).toEqual([]);

      await service.reviewSubmission(admin, result.submission.id, {
        status: "approved",
        rejectionReason: null,
        reviewNote: "Two independent confirmations reviewed by admin.",
      });
      expect(repository.getSubmissionById(result.submission.id)?.submission.status).toBe("approved");
      const venues = await service.listVenues("Locked Google", 10);
      expect(venues).toContainEqual(expect.objectContaining({
        id: result.submission.venueId,
        name: "Locked Google Bar",
        address: "12 Lock St, Fitzroy VIC 3065",
        suburb: "Fitzroy",
        isUserSubmittedVenue: true,
      }));
      expect(await getVenueRequestRepository(repository).getVenueRequestById(requestResult.request.id))
        .toEqual(expect.objectContaining({
        status: "resolved",
        venueId: result.submission.venueId,
        googlePlaceId: "google-place-locked-venue",
        sourceSubmissionId: result.submission.id,
        resolvedAt: NOW,
        }));
      expect(await publicPriceRepositories.get(repository)!.listVenueManagerPriceRecords(20, result.submission.venueId))
        .toEqual([expect.objectContaining({
          beerName: "Guinness",
          venueName: "Locked Google Bar",
          price: 13,
        })]);
      const publishedRecord = database
        .prepare("SELECT confidence FROM venue_price_records WHERE source_submission_id = ?")
        .get(result.submission.id) as { confidence: string } | undefined;
      expect(publishedRecord?.confidence).toBe("community_confirmed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sorts high-value missions by weighted points", async () => {
    const { repository } = createRepository();

    await getMissionLifecycleRepository(repository).createMission({
      id: "mission-normal",
      venueId: "venue-1",
      venueName: "Known Venue",
      suburb: "Fitzroy",
      reason: "stale prices",
      priority: "normal",
      points: 2,
      multiplier: 1,
      lastVerifiedAt: "2026-04-01T00:00:00.000Z",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await getMissionLifecycleRepository(repository).createMission({
      id: "mission-high",
      venueId: "venue-2",
      venueName: "Missing Venue",
      suburb: "South Melbourne",
      reason: "no prices",
      priority: "high",
      points: 5,
      multiplier: 2,
      lastVerifiedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const missions = await getMissionLifecycleRepository(repository).listAdminMissions({ limit: 10, offset: 0 });
    expect(missions.map((mission) => mission.id)).toEqual(["mission-high", "mission-normal"]);
  });

  it("pages a dense mission board with one bounded set-based query and no per-mission lookups", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const insert = database.prepare(
      `INSERT INTO missions (
        id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
        active, sponsor_flag, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Melbourne', 'stale prices', 'normal', 3, 1, 1, 0, ?, ?, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < 2_500; index += 1) {
        const verifiedAt = new Date(Date.parse(NOW) - index * 60_000).toISOString();
        insert.run(`dense-mission-${index}`, `dense-venue-${index}`, `Dense Venue ${index}`, verifiedAt, NOW, NOW);
      }
    })();
    const prepareSpy = vi.spyOn(database, "prepare");

    const page = await service.getMissionsPage({ limit: 25, offset: 100, sort: "stale" });

    expect(page.missions).toHaveLength(25);
    expect(page.pagination).toEqual({ total: 2_500, limit: 25, offset: 100, hasMore: true });
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    prepareSpy.mockRestore();
  });

  it("scales mission points by freshness and supports nearby and address search", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const freshAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const staleAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();

    await getMissionLifecycleRepository(repository).createMission({
      id: "mission-fresh",
      venueId: "venue-fresh",
      venueName: "Fresh Arms",
      suburb: "Fitzroy",
      reason: "recent prices",
      priority: "normal",
      points: 2,
      multiplier: 1,
      lastVerifiedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await getMissionLifecycleRepository(repository).createMission({
      id: "mission-stale",
      venueId: "venue-stale",
      venueName: "Stale Hotel",
      suburb: "Fitzroy",
      reason: "stale prices",
      priority: "normal",
      points: 2,
      multiplier: 1,
      lastVerifiedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await getMissionLifecycleRepository(repository).createMission({
      id: "mission-new-drinks",
      venueId: "venue-new-drinks",
      venueName: "New Tap Room",
      suburb: "Collingwood",
      reason: "missing new beer prices",
      priority: "high",
      points: 2,
      multiplier: 1,
      lastVerifiedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const insertPriceRecord = database.prepare(
      `INSERT INTO venue_price_records (
        id, venue_id, venue_name, suburb, beer_name, serving_size, price,
        is_happy_hour_price, is_on_tap, confidence, source_type, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'yes', 'photo_verified', 'test_fixture', ?, ?, ?)`,
    );
    insertPriceRecord.run("record-fresh", "venue-fresh", "Fresh Arms", "Fitzroy", "Guinness", "pint", 12, freshAt, freshAt, freshAt);
    insertPriceRecord.run("record-stale", "venue-stale", "Stale Hotel", "Fitzroy", "Carlton Draught", "pint", 11, staleAt, staleAt, staleAt);

    repository.upsertVenueLocationCache({
      venueId: "venue-fresh",
      venueName: "Fresh Arms",
      suburb: "Fitzroy",
      latitude: -37.798,
      longitude: 144.978,
      now: NOW,
    });
    repository.upsertVenueLocationCache({
      venueId: "venue-stale",
      venueName: "Stale Hotel",
      suburb: "Fitzroy",
      latitude: -37.805,
      longitude: 144.98,
      now: NOW,
    });
    repository.upsertVenueLocationCache({
      venueId: "venue-new-drinks",
      venueName: "New Tap Room",
      suburb: "Collingwood",
      latitude: -37.815,
      longitude: 144.984,
      now: NOW,
    });
    database.prepare(
      `INSERT INTO venue_profiles (venue_id, name, address, suburb, area, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("venue-new-drinks", "New Tap Room", "99 Smith Street", "Collingwood", "Collingwood", NOW, NOW);

    const missions = await service.listMissions({ limit: 20, sort: "points" });
    const byId = new Map(missions.map((mission) => [mission.id, mission]));
    expect(byId.get("mission-fresh")?.points).toBe(0.1);
    expect(byId.get("mission-stale")?.points).toBe(1);
    expect(byId.get("mission-new-drinks")?.points).toBe(5);
    expect(byId.get("mission-fresh")?.freshnessLabel).toBe("Updated in the last 24 hours");
    expect(byId.get("mission-stale")?.freshnessLabel).toBe("Stale for 7+ days");

    const nearby = await service.listMissions({
      latitude: -37.798,
      longitude: 144.978,
      radiusKm: 1,
      sort: "nearby",
      limit: 20,
    });
    const nearbyManualIds = nearby
      .map((mission) => mission.id)
      .filter((id) => id.startsWith("mission-"));
    expect(nearbyManualIds).toEqual(["mission-fresh", "mission-stale"]);
    expect(nearby.find((mission) => mission.id === "mission-fresh")?.distanceMeters).toBe(0);

    const searched = await service.listMissions({ q: "smith", sort: "points", limit: 20 });
    expect(searched.map((mission) => mission.id)).toContain("mission-new-drinks");

    const area = await service.resolveMissionArea("Smith Street");
    expect(area.location).toEqual(expect.objectContaining({
      latitude: -37.815,
      longitude: 144.984,
      label: "New Tap Room, Collingwood",
      source: "local_cache",
    }));
  });

  it("auto-generates mission values from venue coverage, beer gaps, and freshness", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const freshAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const staleAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();

    repository.upsertVenueLocationCache({
      venueId: "auto-empty",
      venueName: "Empty Mission Bar",
      suburb: "Carlton",
      latitude: -37.8,
      longitude: 144.966,
      now: NOW,
    });
    repository.upsertVenueLocationCache({
      venueId: "auto-fresh",
      venueName: "Fresh Mission Bar",
      suburb: "Fitzroy",
      latitude: -37.802,
      longitude: 144.979,
      now: NOW,
    });
    repository.upsertVenueLocationCache({
      venueId: "auto-stale",
      venueName: "Stale Mission Bar",
      suburb: "Brunswick",
      latitude: -37.766,
      longitude: 144.963,
      now: NOW,
    });

    const insertPriceRecord = database.prepare(
      `INSERT INTO venue_price_records (
        id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, serving_size, price,
        is_happy_hour_price, is_on_tap, confidence, source_type, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'yes', 'photo_verified', 'test_fixture', ?, ?, ?)`,
    );
    insertPriceRecord.run(
      "auto-record-fresh-guinness",
      "auto-fresh",
      "Fresh Mission Bar",
      "Fitzroy",
      "Guinness",
      "guinness",
      "pint",
      13,
      freshAt,
      freshAt,
      freshAt,
    );
    insertPriceRecord.run(
      "auto-record-stale-carlton",
      "auto-stale",
      "Stale Mission Bar",
      "Brunswick",
      "Carlton Draught",
      "carlton_draft",
      "pint",
      12,
      staleAt,
      staleAt,
      staleAt,
    );

    await service.runMissionMaintenance({ forceRefresh: true });
    const missions = await service.listMissions({ limit: 50, sort: "points" });
    const byId = new Map(missions.map((mission) => [mission.id, mission]));

    expect(byId.get("auto:venue:auto-empty:coverage")).toEqual(expect.objectContaining({
      points: 5,
      reason: "New or empty venue - add first verified beer prices",
    }));
    expect(Array.from(byId.keys()).some((id) => id.startsWith("auto:venue:auto-fresh:beer:guinness"))).toBe(false);
    expect(byId.get("auto:venue:auto-fresh:beer:carlton_draft")).toEqual(expect.objectContaining({
      points: 5,
      reason: "Missing Carlton Draught price - add this drink",
    }));
    const staleMenuMission = missions.find((mission) => mission.id.startsWith("auto:venue:auto-stale:menu-freshness:"));
    expect(staleMenuMission).toEqual(expect.objectContaining({
      points: 1,
      reason: expect.stringContaining("Stale drink menu"),
    }));
    expect(byId.get("auto:venue:auto-fresh:happy-hour")).toBeUndefined();
    expect(await getMissionLifecycleRepository(repository).getMissionById("auto:venue:auto-fresh:happy-hour"))
      .toEqual(expect.objectContaining({
      points: 5,
      reason: "Missing happy-hour details - add current specials",
      }));
  });

  it("stores only aggregate analytics preview counts for admin review", async () => {
    const { repository } = createRepository();

    await getActivityAuditRepository(repository).recordEvent({
      id: "event-1",
      userId: null,
      anonymousSessionId: "anon-1",
      eventType: "beer_search_performed",
      venueId: null,
      beerId: "carlton_draft",
      suburb: "Richmond",
      metadata: { query: "Carlton Draught" },
      createdAt: NOW,
    });
    await getActivityAuditRepository(repository).recordEvent({
      id: "event-2",
      userId: null,
      anonymousSessionId: "anon-2",
      eventType: "venue_detail_opened",
      venueId: "venue-1",
      beerId: null,
      suburb: "Richmond",
      metadata: { venueName: "Corner Hotel" },
      createdAt: NOW,
    });

    const preview = await getAdminAnalyticsRepository(repository).getAnalyticsPreview();
    expect(preview.topSearchedBeers).toEqual([{ key: "carlton_draft", count: 1 }]);
    expect(preview.topClickedVenues).toEqual([{ key: "venue-1", label: "Corner Hotel", count: 1 }]);
    expect(preview.topSuburbs).toEqual([{ key: "Richmond", count: 2 }]);
  });

  it("labels high-demand stale venue buckets for admin review", async () => {
    const { repository } = createRepository();

    await getActivityAuditRepository(repository).recordEvent({
      id: "event-stale-demand",
      userId: null,
      anonymousSessionId: "anon-stale-demand",
      eventType: "venue_detail_opened",
      venueId: "venue-stale-demand",
      beerId: null,
      suburb: "Carlton",
      metadata: { venueName: "Lagoon Bar" },
      createdAt: NOW,
    });

    const dashboard = await getAdminAnalyticsRepository(repository).getAdminKpiDashboard({
      since: null,
      sevenDaysAgo: "2026-04-27T00:00:00.000Z",
      thirtyDaysAgo: "2026-04-04T00:00:00.000Z",
      staleBefore: "2026-02-04T00:00:00.000Z",
      totalVenues: 1,
    });

    expect(dashboard.highDemandVenuesWithStaleOrMissingData).toEqual([
      { key: "venue-stale-demand", label: "Lagoon Bar", count: 1 },
    ]);
  });

  it("suppresses low-count analytics buckets through admin service views", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, { ANALYTICS_MIN_BUCKET_SIZE: 2 });
    const admin = createAccount(repository, "analytics-admin", "admin");

    await getActivityAuditRepository(repository).recordEvent({
      id: "event-low",
      userId: null,
      anonymousSessionId: "anon-1",
      eventType: "beer_search_performed",
      venueId: null,
      beerId: "guinness",
      suburb: "Richmond",
      metadata: {},
      createdAt: NOW,
    });
    await getActivityAuditRepository(repository).recordEvent({
      id: "event-high-1",
      userId: null,
      anonymousSessionId: "anon-2",
      eventType: "beer_search_performed",
      venueId: null,
      beerId: "carlton_draught",
      suburb: "Richmond",
      metadata: {},
      createdAt: NOW,
    });
    await getActivityAuditRepository(repository).recordEvent({
      id: "event-high-2",
      userId: null,
      anonymousSessionId: "anon-3",
      eventType: "beer_search_performed",
      venueId: null,
      beerId: "carlton_draught",
      suburb: "Richmond",
      metadata: {},
      createdAt: NOW,
    });

    const preview = await service.getAnalyticsPreview(admin);
    expect(preview.topSearchedBeers).toEqual([{ key: "carlton_draft", count: 2 }]);
    expect(preview.suppressedBelowCount).toBe(2);
  });

  it("records near-me events without storing precise coordinates", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "near-me-user");
    await service.savePrivacySettings(user, {
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
      expectedUpdatedAt: null,
    });

    await service.trackEvent(user, {
      anonymousSessionId: null,
      eventType: "near_me_enabled",
      venueId: null,
      beerId: null,
      suburb: "Richmond",
      metadata: {
        radiusKm: 2,
        locationStatus: "granted",
        latitude: -37.823,
        longitude: 144.998,
        preciseLocation: "-37.823,144.998",
      },
    });
    await service.trackEvent(user, {
      anonymousSessionId: null,
      eventType: "happy_hour_near_me_used",
      venueId: "venue-1",
      beerId: null,
      suburb: "Richmond",
      metadata: { radiusKm: 2 },
    });

    const stored = database
      .prepare("SELECT metadata_json FROM events WHERE event_type = 'near_me_enabled' LIMIT 1")
      .get() as { metadata_json: string } | undefined;
    const metadata = JSON.parse(stored?.metadata_json ?? "{}") as Record<string, unknown>;
    const dashboard = await getAdminAnalyticsRepository(repository).getAdminKpiDashboard({
      since: null,
      sevenDaysAgo: "2026-04-27T00:00:00.000Z",
      thirtyDaysAgo: "2026-04-04T00:00:00.000Z",
      staleBefore: "2026-02-04T00:00:00.000Z",
      totalVenues: 3,
    });

    expect(metadata.radiusKm).toBe(2);
    expect(metadata.locationStatus).toBe("granted");
    expect(metadata.latitude).toBeUndefined();
    expect(metadata.longitude).toBeUndefined();
    expect(metadata.preciseLocation).toBeUndefined();
    expect(dashboard.metrics.totalNearMeUses).toBe(1);
    expect(dashboard.metrics.totalHappyHourNearMeUses).toBe(1);
  });

  it("captures privacy-safe search and click intent for paid venue reports", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "intent-user");
    await service.savePrivacySettings(user, {
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
      expectedUpdatedAt: null,
    });

    await service.trackEvent(user, {
      anonymousSessionId: null,
      eventType: "beer_search_performed",
      venueId: null,
      beerId: "stone_and_wood",
      suburb: "Richmond",
      metadata: {
        query: "Stone & Wood pint",
        searchIntent: "beer",
        approximateSuburb: "Richmond",
        radiusKm: 2,
        distanceBucket: "under_500m",
        localTimeBucket: "evening",
        latitude: -37.82,
        longitude: 144.99,
      },
    });
    await service.trackEvent(user, {
      anonymousSessionId: null,
      eventType: "map_pin_click",
      venueId: "analytics-venue-1",
      beerId: null,
      suburb: "Richmond",
      metadata: {
        venueName: "Analytics Venue",
        source: "marker",
        interactionType: "map_marker",
        listedBeerCount: 3,
        hasHappyHour: true,
        preciseLocation: "-37.82,144.99",
      },
    });

    const dashboard = await getAdminAnalyticsRepository(repository).getAdminKpiDashboard({
      since: null,
      sevenDaysAgo: "2026-04-27T00:00:00.000Z",
      thirtyDaysAgo: "2026-04-04T00:00:00.000Z",
      staleBefore: "2026-02-04T00:00:00.000Z",
      totalVenues: 1,
    });
    const venueAnalytics = repository.getVenueAreaAnalytics({
      venueId: "analytics-venue-1",
      area: "Richmond",
      privacyThreshold: 1,
    });
    const stored = database
      .prepare("SELECT metadata_json FROM events WHERE event_type = 'beer_search_performed' LIMIT 1")
      .get() as { metadata_json: string } | undefined;
    const metadata = JSON.parse(stored?.metadata_json ?? "{}") as Record<string, unknown>;

    expect(dashboard.topSearchedBeers).toEqual([{ key: "stone_and_wood_pacific_ale", count: 1 }]);
    expect(dashboard.topClickedVenues).toEqual([{ key: "analytics-venue-1", label: "Analytics Venue", count: 1 }]);
    expect(venueAnalytics.markerClicks).toBe(1);
    expect(venueAnalytics.barLookups).toBe(1);
    expect(venueAnalytics.areaBeerSearches).toEqual([{ key: "stone_and_wood_pacific_ale", count: 1 }]);
    expect(metadata.approximateSuburb).toBe("Richmond");
    expect(metadata.distanceBucket).toBe("under_500m");
    expect(metadata.latitude).toBeUndefined();
    expect(metadata.longitude).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toContain("-37.82");
  });

  it("stores onboarding preferences and saved items for retention shortcuts", async () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "saved-user");
    const accountProfilePreferencesRepository = accountProfilePreferencesRepositories.get(repository)!;

    const preferences = await accountProfilePreferencesRepository.upsertAccountPreferences({
      userId: user.id,
      preferredSuburbs: ["Fitzroy", "Richmond"],
      preferredBeers: ["Guinness"],
      preferredUseCases: ["happy_hours"],
      onboardingCompletedAt: NOW,
      now: NOW,
      expectedUpdatedAt: null,
    });
    const saved = await accountProfilePreferencesRepository.saveItem({
      id: "saved-1",
      userId: user.id,
      itemType: "suburb",
      itemId: "fitzroy",
      label: "Fitzroy",
      suburb: "Fitzroy",
      metadata: {},
      now: NOW,
    });

    expect(preferences.preferredSuburbs).toEqual(["Fitzroy", "Richmond"]);
    expect(saved.label).toBe("Fitzroy");
    expect(await accountProfilePreferencesRepository.listSavedItems(user.id)).toHaveLength(1);
    const nightPlan = await accountProfilePreferencesRepository.saveItem({
      id: "saved-night-plan-1",
      userId: user.id,
      itemType: "night_plan",
      itemId: "current-night-plan",
      label: "2 stops night plan",
      suburb: "Fitzroy",
      metadata: {
        venueIds: ["venue-1", "venue-2"],
        venueNames: ["Alpha Bar", "Beta Bar"],
        suburbs: ["Fitzroy", "Richmond"],
      },
      now: NOW,
    });
    expect(nightPlan.itemType).toBe("night_plan");
    expect(await accountProfilePreferencesRepository.listSavedItems(user.id)).toHaveLength(2);
    expect(await accountProfilePreferencesRepository.removeSavedItem({ userId: user.id, itemType: "suburb", itemId: "fitzroy" })).toBe(true);
    expect(await accountProfilePreferencesRepository.removeSavedItem({ userId: user.id, itemType: "night_plan", itemId: "current-night-plan" })).toBe(true);
    expect(await accountProfilePreferencesRepository.listSavedItems(user.id)).toHaveLength(0);
  });

  it("marks a price record disputed after multiple wrong-price reports", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "wrong-price-user");
    const otherUser = createAccount(repository, "wrong-price-user-2");
    const admin = createAccount(repository, "admin", "admin");
    const submission = createSubmission(repository, {
      id: "submission-price-report",
      userId: user.id,
      venueId: "venue-1",
      venueName: "Price Report Bar",
    });

    approve(repository, submission.id, admin.id);
    const priceRecord = (await publicPriceRepositories.get(repository)!.listLatestPriceRecords(1))[0]!;
    await service.reportWrongPrice(user, {
      anonymousSessionId: null,
      venueId: "venue-1",
      venueName: "Untrusted client venue name",
      priceRecordId: priceRecord.id,
      beerName: "Untrusted client beer name",
      reason: "price_changed",
      notes: "Board showed a different price.",
      sourcePhotoDataUrl: null,
      sourcePhotoUrl: null,
    });
    const second = await service.reportWrongPrice(otherUser, {
      anonymousSessionId: null,
      venueId: "venue-1",
      venueName: "Another untrusted venue name",
      priceRecordId: priceRecord.id,
      beerName: "Another untrusted beer name",
      reason: "price_changed",
      notes: "Confirmed changed.",
      sourcePhotoDataUrl: null,
      sourcePhotoUrl: null,
    });

    expect(second.markedDisputed).toBe(true);
    expect(await getSupportFeedbackRepository(repository).listWrongPriceReports({ limit: 10, offset: 0 })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        venueName: "Price Report Bar",
        beerName: priceRecord.beerName,
        priceRecordId: priceRecord.id,
      }),
    ]));
    expect((await publicPriceRepositories.get(repository)!.listLatestPriceRecords(1))[0]?.confidence).toBe("disputed");
  });

  it("records requests, KPI counts, retention cohorts, and partner lead signals", async () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "retention-user");

    await getVenueRequestRepository(repository).createOrGetVenueRequest({
      id: "request-1",
      userId: user.id,
      anonymousSessionId: null,
      requestType: "verify_venue",
      venueId: "venue-1",
      venueName: "Requested Bar",
      googlePlaceId: null,
      beerName: null,
      suburb: "Richmond",
      notes: "Popular venue.",
      now: NOW,
    });
    await getActivityAuditRepository(repository).recordEvent({
      id: "event-map",
      userId: user.id,
      anonymousSessionId: null,
      eventType: "map_viewed",
      venueId: "venue-1",
      beerId: null,
      suburb: "Richmond",
      metadata: {},
      createdAt: NOW,
    });
    await getActivityAuditRepository(repository).recordEvent({
      id: "event-beer",
      userId: user.id,
      anonymousSessionId: null,
      eventType: "beer_search_performed",
      venueId: "venue-1",
      beerId: "guinness",
      suburb: "Richmond",
      metadata: { query: "Guinness" },
      createdAt: "2026-05-06T08:00:00.000Z",
    });
    await getActivityAuditRepository(repository).recordEvent({
      id: "event-detail",
      userId: user.id,
      anonymousSessionId: null,
      eventType: "venue_detail_opened",
      venueId: "venue-1",
      beerId: null,
      suburb: "Richmond",
      metadata: {},
      createdAt: "2026-05-06T08:05:00.000Z",
    });

    const dashboard = await getAdminAnalyticsRepository(repository).getAdminKpiDashboard({
      since: null,
      sevenDaysAgo: "2026-04-27T00:00:00.000Z",
      thirtyDaysAgo: "2026-04-04T00:00:00.000Z",
      staleBefore: "2026-02-04T00:00:00.000Z",
      totalVenues: 3,
    });
    const cohorts = await getAdminAnalyticsRepository(repository).getRetentionCohorts({ groupBy: "week", limit: 4 });
    const leads = await getAdminAnalyticsRepository(repository).getPotentialPartnerLeads({
      staleBefore: "2026-02-04T00:00:00.000Z",
      limit: 5,
    });

    expect(await getVenueRequestRepository(repository).countVenueRequests()).toBe(1);
    expect(dashboard.metrics.totalBeerSearches).toBe(1);
    expect(dashboard.topSearchedBeers).toEqual([{ key: "guinness", count: 1 }]);
    expect(cohorts[0]).toEqual(expect.objectContaining({ users: 1, returned7: 1, returned30: 1 }));
    expect(leads[0]).toEqual(expect.objectContaining({
      venueId: "venue-1",
      requests: 1,
      dataFreshness: "stale_or_missing",
    }));
  });

  it("creates missing venue requests through the public request service", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "missing-venue-request-user");

    const result = await service.createVenueRequest(user, {
      anonymousSessionId: "anon-newbay",
      requestType: "missing_venue",
      venueId: null,
      venueName: "Newbay Hotel",
      beerName: null,
      suburb: "Brighton",
      notes: "Address: 329 New St, Brighton VIC 3186",
    });

    expect(result.message).toBe("Newbay Hotel has been added to the admin review queue.");
    expect((await getVenueRequestRepository(repository).listVenueRequests({ limit: 10 })).requests).toEqual([
      expect.objectContaining({
        requestType: "missing_venue",
        venueName: "Newbay Hotel",
        suburb: "Brighton",
        status: "open",
      }),
    ]);
  });

  it("adapts the admin venue-request queue through bounded deterministic keyset pages", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "venue-request-page-admin", "admin");
    for (let index = 0; index < 205; index += 1) {
      await getVenueRequestRepository(repository).createOrGetVenueRequest({
        id: `venue-request-page-${String(index).padStart(3, "0")}`,
        userId: null,
        anonymousSessionId: `venue-request-page-anon-${index}`,
        requestType: "verify_venue",
        venueId: `venue-request-page-venue-${index}`,
        venueName: `Venue Request Page ${index}`,
        googlePlaceId: null,
        beerName: null,
        suburb: "Melbourne",
        notes: null,
        now: NOW,
      });
    }

    const page = await service.getAdminQueues(admin, { limit: 5, offset: 200 });
    expect(page.venueRequests.map((request) => request.id)).toEqual([
      "venue-request-page-200",
      "venue-request-page-201",
      "venue-request-page-202",
      "venue-request-page-203",
      "venue-request-page-204",
    ]);
    expect(page.pagination.hasMore.venueRequests).toBe(false);
    await expect(service.getAdminQueues(admin, { limit: 1, offset: 5_000 }))
      .rejects.toThrow("limited to the first 5000 records");
  });

  it("creates exactly one mission from a pending venue request", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "mission-request-user");
    const admin = createAccount(repository, "mission-request-admin", "admin");
    const created = await service.createVenueRequest(user, {
      anonymousSessionId: null,
      requestType: "missing_venue",
      venueId: null,
      venueName: "Only Once Hotel",
      beerName: null,
      suburb: "Richmond",
      notes: null,
    });

    const first = await service.createMissionFromRequest(admin, created.request.id);

    expect(first).toEqual(expect.objectContaining({
      mission: expect.objectContaining({ venueName: "Only Once Hotel" }),
      request: expect.objectContaining({ status: "mission_created" }),
    }));
    await expect(service.createMissionFromRequest(admin, created.request.id))
      .rejects.toThrow("already has a mission");
    expect(database.prepare("SELECT count(*) AS count FROM missions WHERE venue_name = ?")
      .get("Only Once Hotel")).toEqual({ count: 1 });
    expect((await getVenueRequestRepository(repository).getVenueRequestById(created.request.id))?.missionId)
      .toBe(first.mission.id);
  });

  it("deduplicates partner leads that use venue aliases for the same venue", async () => {
    const { repository } = createRepository();

    await getActivityAuditRepository(repository).recordEvent({
      id: "event-half-uuid-detail",
      userId: null,
      anonymousSessionId: "anon-half-uuid",
      eventType: "venue_detail_opened",
      venueId: "b9714e3b-fece-4f0e-a04b-534c3e57519d",
      beerId: null,
      suburb: "Brighton",
      metadata: { venueName: "Half Moon" },
      createdAt: NOW,
    });
    await getActivityAuditRepository(repository).recordEvent({
      id: "event-half-uuid-card",
      userId: null,
      anonymousSessionId: "anon-half-uuid",
      eventType: "venue_card_viewed",
      venueId: "b9714e3b-fece-4f0e-a04b-534c3e57519d",
      beerId: null,
      suburb: "Brighton",
      metadata: { venueName: "Half Moon" },
      createdAt: NOW,
    });
    await getActivityAuditRepository(repository).recordEvent({
      id: "event-half-slug-search",
      userId: null,
      anonymousSessionId: "anon-half-slug",
      eventType: "beer_search_performed",
      venueId: "half-moon-brighton",
      beerId: "guinness",
      suburb: "Brighton",
      metadata: { venueName: "Half Moon" },
      createdAt: NOW,
    });

    const leads = await getAdminAnalyticsRepository(repository).getPotentialPartnerLeads({
      staleBefore: "2026-02-04T00:00:00.000Z",
      limit: 5,
    });

    const halfMoonLeads = leads.filter((lead) => lead.venueName === "Half Moon" && lead.suburb === "Brighton");
    expect(halfMoonLeads).toHaveLength(1);
    expect(halfMoonLeads[0]).toEqual(expect.objectContaining({
      venueId: "b9714e3b-fece-4f0e-a04b-534c3e57519d",
      venueClicks: 2,
      searchesNearby: 1,
    }));
  });

  it("supports venue partner interest, manager assignments, and assigned-venue portal access", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "venue-admin", "admin");
    const manager = createAccount(repository, "venue-manager");
    const normalUser = createAccount(repository, "venue-normal");
    repository.upsertVenueLocationCache({
      venueId: "venue-1",
      venueName: "Rooftop Bar",
      suburb: "Melbourne",
      latitude: -37.8136,
      longitude: 144.9631,
      now: NOW,
    });

    const interest = await service.createVenueInterest(null, {
      anonymousSessionId: "anon-partner",
      venueId: "venue-1",
      venueName: "Rooftop Bar",
      managerName: "Riley Manager",
      email: "riley@example.com",
      phone: null,
      role: "Venue manager",
      notes: "Interested in keeping happy hours accurate.",
      claimListing: true,
    });

    expect(interest.interest.venueName).toBe("Rooftop Bar");
    expect(await service.getVenuePortal(normalUser, { venueId: "venue-1" })).toEqual(expect.objectContaining({
      accessState: "claim_required",
      selectedVenue: null,
    }));
    const claimResult = await service.createBarClaimRequest(normalUser, {
      barId: "venue-1",
      barName: "Rooftop Bar",
      address: "Level 7, Melbourne",
      suburb: "Melbourne",
      requesterName: "Normal User",
      requesterRole: "Venue manager",
      contactEmail: "venue-normal@example.com",
      contactPhone: null,
      message: "I manage this venue.",
    });
    expect(claimResult.claim).toEqual(expect.objectContaining({
      barId: "venue-1",
      barName: "Rooftop Bar",
      status: "pending",
    }));
    expect((await service.getVenuePortal(normalUser, { venueId: "venue-1" })).claimRequests).toHaveLength(1);
    expect(await service.createBarClaimRequest(normalUser, {
      barId: "venue-1",
      barName: "Rooftop Bar",
      address: "Level 7, Melbourne",
      suburb: "Melbourne",
      requesterName: "Normal User",
      requesterRole: "Venue manager",
      contactEmail: "venue-normal@example.com",
      contactPhone: null,
      message: "Retry after a slow connection.",
    })).toEqual(expect.objectContaining({ duplicate: true }));

    const reviewedClaim = await service.reviewVenueClaimRequest(admin, claimResult.claim.id, {
      status: "approved",
      reviewNote: "Verified with the venue's published phone number.",
    });
    expect(reviewedClaim.assignment).toEqual(expect.objectContaining({
      userId: normalUser.id,
      venueId: "venue-1",
      accessLevel: "manager",
    }));
    expect(await service.getVenuePortal(repository.getAccountById(normalUser.id)!, { venueId: "venue-1" }))
      .toEqual(expect.objectContaining({ accessLevel: "manager" }));

    const assignment = await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "venue-1",
      venueName: "Rooftop Bar",
      suburb: "Melbourne",
    });
    const managerAccount = repository.getAccountById(manager.id)!;

    expect(assignment.assignment.status).toBe("active");
    expect(managerAccount.role).toBe("venue_manager");
    await expect(service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "venue-1",
      venueName: "Rooftop Bar",
      suburb: "Melbourne",
      accessLevel: "counter_staff",
    })).rejects.toThrow("already a manager");
    expect(await getVenueAccessRepository(repository).getVenueAssignment({
      userId: manager.id,
      venueId: "venue-1",
      activeOnly: false,
    })).toEqual(expect.objectContaining({ accessLevel: "manager", status: "active" }));
    expect((await service.searchAccountsForAdmin(admin, { q: "venue-manager", limit: 10 })).accounts).toEqual([
      expect.objectContaining({
        id: manager.id,
        email: "venue-manager@example.com",
        role: "venue_manager",
      }),
    ]);
    await expect(service.searchAccountsForAdmin(normalUser, { q: "venue-manager", limit: 10 }))
      .rejects.toThrow("Admin access required");

    const portal = await service.getVenuePortal(managerAccount, { venueId: "venue-1" });
    expect(portal.selectedVenue).toEqual(expect.objectContaining({
      venueId: "venue-1",
      venueName: "Rooftop Bar",
    }));
    expect(portal.privacyCopy).toContain("privacy-safe");
    await expect(service.getVenuePortal(managerAccount, { venueId: "venue-2" }))
      .rejects.toThrow("assigned venues");

    const update = await service.createVenueManagerSubmission(managerAccount, "venue-1", {
      venueId: "venue-1",
      venueName: "Rooftop Bar",
      suburb: "Melbourne",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: null,
      sourcePhotoUrl: null,
      notes: "Venue manager confirmed tap-list board.",
      items: [
        {
          beerName: "Carlton Draught",
          normalizedBeerId: null,
          servingSize: "pint",
          price: 13,
          isHappyHourPrice: false,
          happyHourDetails: null,
          isOnTap: "yes",
        },
      ],
    });

    expect(update.submission.status).toBe("pending");
    expect(update.message).toContain("submitted for review");
    expect(repository.listSubmissions({ userId: manager.id, limit: 10 })[0]?.notes).toContain("Venue manager submitted update");

    const partnerAdmin = await service.getVenuePartnerAdmin(admin);
    expect(partnerAdmin.interests[0]).toEqual(expect.objectContaining({ venueName: "Rooftop Bar" }));
    expect(partnerAdmin.claimRequests).toEqual([
      expect.objectContaining({
        id: claimResult.claim.id,
        status: "approved",
        reviewedBy: admin.id,
      }),
    ]);
    expect(partnerAdmin.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: manager.id, venueId: "venue-1" }),
      expect.objectContaining({ userId: normalUser.id, venueId: "venue-1" }),
    ]));
    const outreach = await service.upsertVenueOutreach(admin, {
      venueId: "venue-1",
      venueName: "Rooftop Bar",
      suburb: "Melbourne",
      status: "contacted",
      tierFit: "pro",
      nextAction: "Offer Pro demo and Pint Path special setup",
      lastContactedAt: "2026-06-15",
      contactName: "Riley Manager",
      notes: "Strong fit because users requested this venue.",
    });
    expect(outreach.outreach).toEqual(expect.objectContaining({
      venueId: "venue-1",
      status: "contacted",
      tierFit: "pro",
      nextAction: "Offer Pro demo and Pint Path special setup",
      lastContactedAt: "2026-06-15T00:00:00.000Z",
    }));
    await service.upsertVenueOutreach(admin, {
      venueId: "venue-closed",
      venueName: "Closed Lead",
      suburb: "Melbourne",
      status: "closed",
      tierFit: null,
      nextAction: null,
      lastContactedAt: null,
      contactName: null,
      notes: "Closed after venue declined.",
    });
    const assignedContextSpy = vi.spyOn(
      getVenueAccessRepository(repository),
      "listActiveAssignedVenueIds",
    );
    const outreachContextSpy = vi.spyOn(
      getVenuePartnerRepository(repository),
      "listVenuePartnerOutreachByVenueIds",
    );
    const accessClaimCountSpy = vi.spyOn(getVenueAccessRepository(repository), "countVenueClaims");
    const accessAssignmentCountSpy = vi.spyOn(getVenueAccessRepository(repository), "countVenueAssignments");
    const pendingCountSpy = vi.spyOn(
      venuePendingChangeRepositories.get(repository)!,
      "countBarPendingChanges",
    );
    const partnerAdminWithContext = await service.getVenuePartnerAdmin(admin, { limit: 1, offset: 1 });
    expect(partnerAdminWithContext.totals).toEqual(expect.objectContaining({
      outreach: 2,
      openOutreach: 1,
    }));
    expect(partnerAdminWithContext.leadRelationshipContext.assignedVenueIds).toContain("venue-1");
    expect(partnerAdminWithContext.leadRelationshipContext.outreachByVenueId["venue-1"]).toEqual(
      expect.objectContaining({ status: "contacted", tierFit: "pro" }),
    );
    expect(assignedContextSpy).toHaveBeenCalledTimes(1);
    expect(outreachContextSpy).toHaveBeenCalledTimes(1);
    expect(assignedContextSpy.mock.calls[0]?.[0].venueIds.length).toBeLessThanOrEqual(25);
    expect(outreachContextSpy.mock.calls[0]?.[0]).toEqual(assignedContextSpy.mock.calls[0]?.[0]);
    expect(accessClaimCountSpy).toHaveBeenCalledTimes(1);
    expect(accessAssignmentCountSpy).toHaveBeenCalledTimes(1);
    expect(accessAssignmentCountSpy).toHaveBeenCalledWith({ currentOnly: true });
    expect(pendingCountSpy).toHaveBeenCalledTimes(1);
    expect(pendingCountSpy).toHaveBeenCalledWith({ status: "pending" });

    const revoked = await service.revokeVenueManager(admin, { userId: manager.id, venueId: "venue-1" });
    expect(revoked.assignment.status).toBe("revoked");
    const partnerAdminAfterRevoke = await service.getVenuePartnerAdmin(admin);
    expect(partnerAdminAfterRevoke.assignments).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: manager.id, venueId: "venue-1" }),
    ]));
    expect(partnerAdminAfterRevoke.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: normalUser.id, venueId: "venue-1" }),
    ]));
    expect(partnerAdminAfterRevoke.totals.assignments).toBe(partnerAdmin.totals.assignments - 1);
    await expect(service.revokeVenueManager(admin, { userId: manager.id, venueId: "venue-1" }))
      .rejects.toThrow("Venue manager assignment not found");
  });

  it("serializes competing venue-partner OCC writes and suppresses replay side effects", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "venue-partner-occ-admin", "admin");
    const createdInterest = (await service.createVenueInterest(null, {
      anonymousSessionId: "venue-partner-occ-anon",
      venueId: "venue-partner-occ-venue",
      venueName: "OCC Hotel",
      managerName: "Alex Operator",
      email: "alex.operator@example.com",
      phone: null,
      role: "Owner",
      notes: null,
      claimListing: false,
    })).interest;

    const interestOutcomes = await Promise.allSettled([
      service.updateVenueInterestStatus(admin, createdInterest.id, {
        status: "contacted",
        expectedUpdatedAt: createdInterest.updatedAt,
      }),
      service.updateVenueInterestStatus(admin, createdInterest.id, {
        status: "interested",
        expectedUpdatedAt: createdInterest.updatedAt,
      }),
    ]);
    expect(interestOutcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejectedInterest = interestOutcomes.find((outcome) => outcome.status === "rejected");
    expect(rejectedInterest?.status === "rejected" ? rejectedInterest.reason : null)
      .toMatchObject({ statusCode: 409, message: "This venue-partner record changed. Refresh and try again." });
    const persistedInterest = await getVenuePartnerRepository(repository).getVenueInterestById(createdInterest.id);
    expect(["contacted", "interested"]).toContain(persistedInterest?.status);

    const outreachInput = {
      venueId: "venue-partner-occ-venue",
      venueName: "OCC Hotel",
      suburb: "Carlton",
      status: "contacted" as const,
      tierFit: "pro" as const,
      nextAction: "Book a product walkthrough",
      lastContactedAt: "2026-05-04",
      contactName: "Alex Operator",
      notes: "Requested a follow-up.",
      expectedUpdatedAt: null,
    };
    const createdOutreach = await service.upsertVenueOutreach(admin, outreachInput);
    expect(createdOutreach).toEqual(expect.objectContaining({ replayed: false }));
    expect(createdOutreach.outreach.lastContactedAt).toBe("2026-05-04T00:00:00.000Z");

    const replay = await service.upsertVenueOutreach(admin, outreachInput);
    expect(replay).toEqual(expect.objectContaining({
      replayed: true,
      outreach: expect.objectContaining({ id: createdOutreach.outreach.id }),
    }));
    expect(await listSecurityAuditLogs(repository, { action: "admin_venue_outreach_update" })).toHaveLength(1);

    const outreachOutcomes = await Promise.allSettled([
      service.upsertVenueOutreach(admin, {
        ...outreachInput,
        status: "interested",
        notes: "Ready for a proposal.",
        expectedUpdatedAt: createdOutreach.outreach.updatedAt,
      }),
      service.upsertVenueOutreach(admin, {
        ...outreachInput,
        status: "closed",
        notes: "Closed by the competing reviewer.",
        expectedUpdatedAt: createdOutreach.outreach.updatedAt,
      }),
    ]);
    expect(outreachOutcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejectedOutreach = outreachOutcomes.find((outcome) => outcome.status === "rejected");
    expect(rejectedOutreach?.status === "rejected" ? rejectedOutreach.reason : null)
      .toMatchObject({ statusCode: 409, message: "This venue-partner record changed. Refresh and try again." });
    expect(await listSecurityAuditLogs(repository, { action: "admin_venue_outreach_update" })).toHaveLength(2);
  });

  it("enforces venue-partner OCC tokens through the admin HTTP routes", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "venue-partner-http-admin", "admin");
    const authorization = createSession(repository, admin.id, "venue-partner-http-token");
    const interest = (await service.createVenueInterest(null, {
      anonymousSessionId: "venue-partner-http-anon",
      venueId: "venue-partner-http-venue",
      venueName: "HTTP Hotel",
      managerName: "Sam Manager",
      email: "sam.manager@example.com",
      phone: null,
      role: "Manager",
      notes: null,
      claimListing: false,
    })).interest;
    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      const updateInterest = await fetch(`${baseUrl}/api/business/admin/venue-interest/${interest.id}/status`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ status: "contacted", expectedUpdatedAt: interest.updatedAt }),
      });
      expect(updateInterest.status).toBe(200);

      const staleInterest = await fetch(`${baseUrl}/api/business/admin/venue-interest/${interest.id}/status`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ status: "partner", expectedUpdatedAt: interest.updatedAt }),
      });
      expect(staleInterest.status).toBe(409);
      expect(await staleInterest.json()).toEqual(expect.objectContaining({
        error: expect.objectContaining({ message: "This venue-partner record changed. Refresh and try again." }),
      }));

      const createOutreach = await fetch(`${baseUrl}/api/business/admin/venue-outreach`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          venueId: "venue-partner-http-venue",
          venueName: "HTTP Hotel",
          suburb: "Fitzroy",
          status: "contacted",
          tierFit: "basic",
          nextAction: "Send information pack",
          lastContactedAt: "2026-05-04",
          contactName: "Sam Manager",
          notes: null,
        }),
      });
      expect(createOutreach.status).toBe(200);
      const createdBody = await createOutreach.json() as {
        data: { outreach: { updatedAt: string; lastContactedAt: string }; replayed: boolean };
      };
      expect(createdBody.data).toEqual(expect.objectContaining({
        replayed: false,
        outreach: expect.objectContaining({ lastContactedAt: "2026-05-04T00:00:00.000Z" }),
      }));

      const updateOutreach = await fetch(`${baseUrl}/api/business/admin/venue-outreach`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          venueId: "venue-partner-http-venue",
          venueName: "HTTP Hotel",
          suburb: "Fitzroy",
          status: "interested",
          tierFit: "pro",
          nextAction: "Prepare proposal",
          lastContactedAt: "2026-05-04",
          contactName: "Sam Manager",
          notes: "Requested pricing.",
          expectedUpdatedAt: createdBody.data.outreach.updatedAt,
        }),
      });
      expect(updateOutreach.status).toBe(200);

      const staleOutreach = await fetch(`${baseUrl}/api/business/admin/venue-outreach`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          venueId: "venue-partner-http-venue",
          venueName: "HTTP Hotel",
          suburb: "Fitzroy",
          status: "closed",
          tierFit: "basic",
          nextAction: null,
          lastContactedAt: null,
          contactName: "Sam Manager",
          notes: "Stale reviewer write.",
          expectedUpdatedAt: createdBody.data.outreach.updatedAt,
        }),
      });
      expect(staleOutreach.status).toBe(409);
      expect(await staleOutreach.json()).toEqual(expect.objectContaining({
        error: expect.objectContaining({ message: "This venue-partner record changed. Refresh and try again." }),
      }));
    });
  });

  it("adapts venue-partner keyset pages to the bounded shared admin offset", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "venue-partner-page-admin", "admin");
    const partnerRepository = getVenuePartnerRepository(repository);
    for (let index = 0; index < 205; index += 1) {
      const suffix = String(index).padStart(3, "0");
      await partnerRepository.createVenueInterest({
        id: `venue-partner-page-interest-${suffix}`,
        userId: null,
        venueId: `venue-partner-page-venue-${suffix}`,
        venueName: `Venue Partner Page ${suffix}`,
        managerName: `Manager ${suffix}`,
        email: `manager-${suffix}@example.com`,
        phone: null,
        role: "Manager",
        notes: null,
        now: NOW,
      });
      await partnerRepository.upsertVenuePartnerOutreach({
        actorAccountId: admin.id,
        id: `venue-partner-page-outreach-${suffix}`,
        venueId: `venue-partner-page-venue-${suffix}`,
        venueName: `Venue Partner Page ${suffix}`,
        suburb: "Melbourne",
        status: "lead",
        tierFit: null,
        nextAction: null,
        lastContactedAt: null,
        contactName: null,
        notes: null,
        expectedUpdatedAt: null,
        now: NOW,
      });
    }

    const page = await service.getVenuePartnerAdmin(admin, { limit: 5, offset: 200 });
    expect(page.interests.map((record) => record.id)).toEqual([
      "venue-partner-page-interest-200",
      "venue-partner-page-interest-201",
      "venue-partner-page-interest-202",
      "venue-partner-page-interest-203",
      "venue-partner-page-interest-204",
    ]);
    expect(page.outreach.map((record) => record.venueId)).toEqual([
      "venue-partner-page-venue-200",
      "venue-partner-page-venue-201",
      "venue-partner-page-venue-202",
      "venue-partner-page-venue-203",
      "venue-partner-page-venue-204",
    ]);
    await expect(service.getVenuePartnerAdmin(admin, { limit: 1, offset: 5_000 }))
      .rejects.toThrow("limited to the first 5000 records");
  });

  it("treats admin account search text as literal text instead of executable query syntax", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "account-search-admin", "admin");
    const target = createAccount(repository, "account-search-target");
    createAccount(repository, "account-search-decoy");

    expect((await service.searchAccountsForAdmin(admin, { q: "' OR 1=1 --", limit: 25 })).accounts).toEqual([]);
    expect((await service.searchAccountsForAdmin(admin, { q: "%' OR role = 'admin", limit: 25 })).accounts).toEqual([]);

    const normalSearch = await service.searchAccountsForAdmin(admin, { q: "account-search-target", limit: 25 });
    expect(normalSearch.accounts).toEqual([
      expect.objectContaining({
        id: target.id,
        email: "account-search-target@example.com",
      }),
    ]);
  });

  it("maps overlapping admin-account revisions to one commit and one HTTP-safe conflict", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "admin-account-race-admin", "admin");
    const target = createAccount(repository, "admin-account-race-target");
    repository.createSession({
      tokenHash: "admin-account-race-session",
      userId: target.id,
      providerSessionIdHash: "admin-account-race-provider",
      createdAt: NOW,
      expiresAt: PREMIUM_UNTIL,
    });
    repository.createDiscountPass({
      id: "admin-account-race-pass",
      userId: target.id,
      sessionTokenHash: "admin-account-race-session",
      codeHash: "admin-account-race-code-hash",
      createdAt: NOW,
      expiresAt: PREMIUM_UNTIL,
    });

    const decisions = await Promise.allSettled([
      service.adminOverrideUser(admin, target.id, {
        status: "warned",
        trustScore: 41,
        reason: "First concurrent moderation decision.",
      }),
      service.adminOverrideUser(admin, target.id, {
        status: "suspended",
        fraudStrikeCount: 2,
        reason: "Second concurrent moderation decision.",
      }),
    ]);
    expect(decisions.filter((decision) => decision.status === "fulfilled")).toHaveLength(1);
    const rejected = decisions.find((decision) => decision.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ statusCode: 409, expose: true });
      expect(String(rejected.reason.message)).toBe("Account state changed. Refresh and try again.");
    }

    const durable = database.prepare(
      `SELECT account.status, account.updated_at,
              profile.account_status AS profile_status, profile.updated_at AS profile_updated_at,
              session.revoked_at, pass.status AS pass_status,
              (SELECT count(*) FROM revoked_provider_sessions revocation
                WHERE revocation.user_id = account.id) AS provider_revocations
         FROM accounts account
         JOIN profiles profile ON profile.id = account.id
         JOIN auth_sessions session ON session.user_id = account.id
         JOIN account_discount_passes pass ON pass.user_id = account.id
        WHERE account.id = ?`,
    ).get(target.id) as {
      status: string;
      updated_at: string;
      profile_status: string;
      profile_updated_at: string;
      revoked_at: string | null;
      pass_status: string;
      provider_revocations: number;
    };
    expect(durable.profile_status).toBe(durable.status);
    expect(durable.profile_updated_at).toBe(durable.updated_at);
    expect(durable.updated_at).toBe("2026-05-04T08:00:00.001Z");
    if (durable.status === "suspended") {
      expect(durable).toMatchObject({
        revoked_at: "2026-05-04T08:00:00.001Z",
        pass_status: "revoked",
        provider_revocations: 1,
      });
    } else {
      expect(durable).toMatchObject({
        status: "warned",
        revoked_at: null,
        pass_status: "active",
        provider_revocations: 0,
      });
    }
    expect(await listSecurityAuditLogs(repository, { action: "admin_user_status_override" }))
      .toHaveLength(1);
  });

  it("standardises venue inventory beer rows before they are saved or reviewed", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "inventory-admin", "admin");
    const manager = createAccount(repository, "inventory-manager");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "inventory-venue",
      venueName: "Inventory Bar",
      suburb: "Brunswick",
    });
    await service.upsertBarProfile(admin, "inventory-venue", {
      name: "Inventory Bar",
      address: "1 Test St",
      suburb: "Brunswick",
      area: "Brunswick",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "pro",
      active: true,
    });

    const adminBeer = (await service.upsertBarBeer(admin, "inventory-venue", {
      id: null,
      beerName: "stone and wood",
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 14,
      onTap: true,
      inStock: true,
      notes: null,
    })).beer;
    expect(adminBeer).toEqual(expect.objectContaining({
      beerName: "Stone & Wood Pacific Ale",
      normalizedBeerId: "stone_and_wood_pacific_ale",
      brewery: "Stone & Wood",
      style: "Pacific ale",
    }));

    const managerBeer = (await service.upsertBarBeer(repository.getAccountById(manager.id)!, "inventory-venue", {
      id: null,
      beerName: "Very Local Hazy Pint",
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 15,
      onTap: true,
      inStock: true,
      notes: null,
    })).beer;
    expect(managerBeer).toEqual(expect.objectContaining({
      beerName: "Very Local Hazy Pint",
      normalizedBeerId: "very_local_hazy_pint",
    }));
    await expect(venuePendingChangeRepositories.get(repository)!.listBarPendingChanges({
      barId: "inventory-venue",
      status: "pending",
      limit: 10,
    })).resolves.toHaveLength(0);
  });

  it("requires a verified account before bar portal or claim access", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const unverified = repository.createAccount({
      id: "unverified-manager",
      email: "unverified-manager@example.com",
      passwordHash: "hash",
      role: "user",
      subscriptionStatus: "free",
      now: NOW,
    });

    await expect(service.getVenuePortal(unverified, {})).rejects.toThrow("Verify your account");
    await expect(service.createBarClaimRequest(unverified, {
      barId: null,
      barName: "Example Bar",
      address: "1 Test St",
      suburb: "Fitzroy",
      requesterName: "Taylor",
      requesterRole: "Owner",
      contactEmail: "taylor@example.com",
      contactPhone: null,
      message: null,
    })).rejects.toThrow("Verify your account");
  });

  it("scopes venue-manager access while letting assigned managers maintain beer prices directly", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "bar-admin", "admin");
    const manager = createAccount(repository, "bar-manager");
    const otherManager = createAccount(repository, "bar-other-manager");
    const normalUser = createAccount(repository, "bar-normal");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "bar-1",
      venueName: "Corner Hotel",
      suburb: "Richmond",
    });
    await service.assignVenueManager(admin, {
      userId: otherManager.id,
      venueId: "bar-2",
      venueName: "Moon Dog OG",
      suburb: "Abbotsford",
    });
    const managerAccount = repository.getAccountById(manager.id)!;
    const otherManagerAccount = repository.getAccountById(otherManager.id)!;

    await expect(service.createSubmission(managerAccount, createSubmissionSchema.parse({
      venueId: "bar-1",
      venueName: "Corner Hotel",
      suburb: "Richmond",
      submissionType: "single_beer_price",
      observedAt: NOW,
      sourcePhotoDataUrl: PNG_DATA_URL,
      sourcePhotoUrl: null,
      notes: null,
      items: [{
        beerName: "Carlton Draught",
        servingSize: "pint",
        price: 13,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      }],
    }))).rejects.toThrow("Venue accounts use the venue dashboard instead of reward submissions.");

    await expect(service.upsertBarBeer(normalUser, "bar-1", {
      id: null,
      beerName: "Carlton Draught",
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 13,
      onTap: true,
      inStock: true,
      notes: null,
    })).rejects.toThrow("Venue manager access required.");
    await expect(service.upsertBarBeer(managerAccount, "bar-2", {
      id: null,
      beerName: "Carlton Draught",
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 13,
      onTap: true,
      inStock: true,
      notes: null,
    })).rejects.toThrow("assigned venues");

    const profile = await service.upsertBarProfile(managerAccount, "bar-1", {
      name: "Corner Hotel",
      address: "57 Swan St, Richmond",
      suburb: "Richmond",
      area: "Richmond",
      phone: "0399999999",
      website: "https://corner.example",
      instagram: "https://instagram.com/corner",
      description: "Live music venue with a rotating tap list.",
      openingHours: { note: "Mon-Sun midday-late" },
      venueTags: ["has food", "live music"],
      membershipTier: "pro",
      active: true,
    });
    expect(profile).toEqual(expect.objectContaining({
      profile: expect.objectContaining({ name: "Corner Hotel", membershipTier: "basic" }),
      message: "Bar profile saved.",
    }));
    expect(repository.getBarProfile("bar-1")).toEqual(expect.objectContaining({ name: "Corner Hotel", membershipTier: "basic" }));

    await expect(service.upsertBarSpecial(managerAccount, "bar-1", {
      id: null,
      title: "Free tier special attempt",
      description: "Should not be accepted on the Free tier.",
      price: 20,
      discount: null,
      startsAt: null,
      endsAt: null,
      startTime: "17:00",
      endTime: "19:00",
      scheduleNote: null,
      exclusive: true,
      active: true,
    })).rejects.toThrow("Pro venue tier required");

    await service.upsertBarProfile(admin, "bar-1", {
      name: "Corner Hotel",
      address: "57 Swan St, Richmond",
      suburb: "Richmond",
      area: "Richmond",
      phone: "0399999999",
      website: "https://corner.example",
      instagram: "https://instagram.com/corner",
      description: "Live music venue with a rotating tap list.",
      openingHours: { note: "Mon-Sun midday-late" },
      venueTags: ["has food", "live music"],
      membershipTier: "pro",
      active: true,
      expectedUpdatedAt: profile.profile.updatedAt,
    });
    expect(repository.getBarProfile("bar-1")?.membershipTier).toBe("pro");

    await service.upsertBarProfile(admin, "bar-unassigned", {
      name: "Unassigned Test Hotel",
      address: "1 Test Lane, Melbourne",
      suburb: "Melbourne",
      area: "Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      active: true,
    });

    const beer = await service.upsertBarBeer(managerAccount, "bar-1", {
      id: null,
      beerName: "Carlton Draught",
      brewery: "Carlton & United Breweries",
      style: "Lager",
      abv: 4.6,
      serveSize: "pint",
      price: 13,
      onTap: true,
      inStock: true,
      notes: "Main tap",
      priceConfirmed: true,
      stockConfirmed: true,
    });
    const happyHour = await service.upsertBarHappyHour(managerAccount, "bar-1", {
      id: null,
      title: "Weekday happy hour",
      daysOfWeek: ["mon", "tue", "wed", "thu", "fri"],
      startTime: "16:00",
      endTime: "18:00",
      description: "$9 house pints, selected taps only.",
      happyHourBeers: [{
        beerId: beer.beer.id,
        beerName: "Carlton Draught",
        normalizedBeerId: "carlton_draught",
        servingSize: "pint",
        happyHourPrice: 9,
        offerText: "House pint",
        onTap: true,
        inStock: true,
      }],
      active: true,
    });
    const special = await service.upsertBarSpecial(managerAccount, "bar-1", {
      id: null,
      title: "Thursday burger and pint",
      description: "Burger and selected pint special.",
      price: 25,
      discount: null,
      startsAt: null,
      endsAt: null,
      startTime: "17:00",
      endTime: "19:00",
      scheduleNote: "Thursdays from 5pm",
      exclusive: false,
      active: true,
    });

    expect(beer).toEqual(expect.objectContaining({
      beer: expect.objectContaining({ beerName: "Carlton Draught", price: 13 }),
      message: "Beer row saved.",
    }));
    expect(happyHour).toEqual(expect.objectContaining({
      happyHour: expect.objectContaining({
        title: "Weekday happy hour",
        happyHourBeers: expect.arrayContaining([
          expect.objectContaining({ beerName: "Carlton Draught", servingSize: "pint", happyHourPrice: 9, offerText: "House pint" }),
        ]),
      }),
      message: "Happy hour saved.",
    }));
    expect(special).toEqual(expect.objectContaining({
      special: expect.objectContaining({ title: "Thursday burger and pint", active: true }),
      message: "Pint Path special saved.",
    }));

    const portal = await service.getVenuePortal(managerAccount, { venueId: "bar-1" });
    expect(portal.pendingChanges).toHaveLength(0);
    expect(portal.inventory.beers).toHaveLength(1);
    expect(portal.inventory.happyHours).toHaveLength(1);
    expect(portal.inventory.specials).toHaveLength(1);
    expect(portal.tier.analyticsLocked).toBe(false);

    const adminPortal = await service.getVenuePortal(admin, { venueId: "bar-1" });
    expect(adminPortal.pendingChanges).toHaveLength(0);
    expect(adminPortal.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ venueId: "bar-1", venueName: "Corner Hotel" }),
      expect.objectContaining({ venueId: "bar-2", venueName: "Moon Dog OG" }),
      expect.objectContaining({ venueId: "bar-unassigned", venueName: "Unassigned Test Hotel" }),
    ]));
    expect(new Set(adminPortal.assignments.map((assignment) => assignment.venueId)).size).toBe(adminPortal.assignments.length);
    expect((await service.getVenuePartnerAdmin(admin)).pendingChanges).toHaveLength(0);
    expect((await service.getVenuePortal(otherManagerAccount, { venueId: "bar-2" })).pendingChanges).toHaveLength(0);
    await expect(service.getVenuePortal(otherManagerAccount, { venueId: "bar-1" }))
      .rejects.toThrow("assigned venues");

    const publicBeforeApproval = await service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-before-approval",
    });
    expect(publicBeforeApproval.records).toEqual([
      expect.objectContaining({
        beerName: "Carlton Draught",
        price: 13,
        sourceType: "venue_manager_portal",
      }),
    ]);
    expect(publicBeforeApproval.records.some((record) =>
      record.displayKind === "happy_hour" || record.displayKind === "special",
    )).toBe(false);

    const approvedPortal = await service.getVenuePortal(managerAccount, { venueId: "bar-1" });
    expect(approvedPortal.profile.membershipTier).toBe("pro");
    expect(approvedPortal.profile.highlightedName).toBe(true);
    expect(approvedPortal.inventory.beers).toHaveLength(1);
    expect(approvedPortal.inventory.happyHours).toHaveLength(1);
    expect(approvedPortal.inventory.happyHours[0].happyHourBeers).toEqual(expect.arrayContaining([
      expect.objectContaining({ beerName: "Carlton Draught", servingSize: "pint", happyHourPrice: 9, offerText: "House pint" }),
    ]));
    expect(approvedPortal.inventory.specials).toHaveLength(1);
    expect(approvedPortal.pendingChanges).toHaveLength(0);
    expect(approvedPortal.tier.analyticsLocked).toBe(false);

    const publicPreview = await service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-preview-anon",
    });
    expect(publicPreview.records).toEqual([
      expect.objectContaining({
        beerName: "Carlton Draught",
        price: 13,
        freePreviewIncluded: true,
        sourceType: "venue_manager_portal",
      }),
    ]);
    expect(publicPreview.records.some((record) =>
      record.displayKind === "happy_hour" || record.displayKind === "special",
    )).toBe(false);

    const venuePreview = await service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-reveal-anon",
    });
    expect(venuePreview.preview).toEqual({ model: "fixed_preview", includedCount: 1, lockedCount: 0 });
    expect(venuePreview.records).toEqual([
      expect.objectContaining({
        beerName: "Carlton Draught",
        price: 13,
        confidence: "venue_confirmed",
        sourceType: "venue_manager_portal",
      }),
    ]);
    expect(venuePreview.records.some((record) =>
      record.displayKind === "happy_hour" || record.displayKind === "special",
    )).toBe(false);

    const adminRecords = await service.listPriceRecords(admin, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: null,
    });
    expect(adminRecords.records).toEqual([
      expect.objectContaining({
        displayKind: "beer",
        beerName: "Carlton Draught",
        price: 13,
      }),
    ]);
    expect(adminRecords.records.some((record) =>
      record.displayKind === "happy_hour" || record.displayKind === "special",
    )).toBe(false);

    const hideAttempt = await service.upsertBarProfile(managerAccount, "bar-1", {
      name: "Corner Hotel",
      address: "57 Swan St, Richmond",
      suburb: "Richmond",
      area: "Richmond",
      phone: "0399999999",
      website: "https://corner.example",
      instagram: "https://instagram.com/corner",
      description: "Temporarily hidden from public listings.",
      openingHours: { note: "Mon-Sun midday-late" },
      venueTags: ["has food"],
      membershipTier: "pro",
      active: false,
      expectedUpdatedAt: repository.getBarProfile("bar-1")!.updatedAt,
    });
    expect(hideAttempt.profile).toEqual(expect.objectContaining({ active: true }));

    expect((await service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-inactive-preview",
    })).records.length).toBeGreaterThan(0);

    expect((await service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-rejected-preview",
    })).records.length).toBeGreaterThan(0);

    const approvedBeerId = beer.beer.id;
    const priceBypassAttempt = await service.upsertBarBeer(managerAccount, "bar-1", {
      id: approvedBeerId,
      beerName: "Carlton Draught",
      brewery: "Carlton & United Breweries",
      style: "Lager",
      abv: 4.6,
      serveSize: "pint",
      price: 15.5,
      onTap: true,
      inStock: true,
      notes: "Updated main tap",
      expectedUpdatedAt: beer.beer.updatedAt,
    });
    expect(priceBypassAttempt).toEqual(expect.objectContaining({
      beer: expect.objectContaining({ id: approvedBeerId, price: 15.5 }),
      message: "Beer row saved.",
    }));
    const afterDirectPriceUpdate = await service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-direct-bypass",
    });
    expect(afterDirectPriceUpdate.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ beerName: "Carlton Draught", price: 15.5 }),
    ]));

    expect(await service.deleteBarBeer(
      managerAccount,
      "bar-1",
      approvedBeerId,
      (await getVenueInventoryRepository(repository).getBarBeerById(approvedBeerId))!.updatedAt,
    ))
      .toEqual(expect.objectContaining({ deleted: true, message: "Beer row removed." }));
    expect(await service.deleteBarHappyHour(managerAccount, "bar-1", happyHour.happyHour.id, happyHour.happyHour.updatedAt))
      .toEqual(expect.objectContaining({ deleted: true, message: "Happy hour removed." }));
    expect(await service.deleteBarSpecial(managerAccount, "bar-1", special.special.id, special.special.updatedAt))
      .toEqual(expect.objectContaining({ deleted: true, message: "Pint Path special removed." }));
    const afterDirectDelete = await service.getVenuePortal(managerAccount, { venueId: "bar-1" });
    expect(afterDirectDelete.inventory.beers).toHaveLength(0);
    expect(afterDirectDelete.inventory.happyHours).toHaveLength(0);
    expect(afterDirectDelete.inventory.specials).toHaveLength(0);
    expect(afterDirectDelete.pendingChanges).toHaveLength(0);
  });

  it("holds burst venue-manager deletes for admin review after three deletes in an hour", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "delete-guard-admin", "admin");
    const manager = createAccount(repository, "delete-guard-manager");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "delete-guard-bar",
      venueName: "Delete Guard Bar",
      suburb: "Brighton",
    });
    const managerAccount = repository.getAccountById(manager.id)!;

    const beerIds = ["guard-beer-1", "guard-beer-2", "guard-beer-3", "guard-beer-4"];
    for (const [index, beerId] of beerIds.entries()) {
      await service.upsertBarBeer(admin, "delete-guard-bar", {
        id: beerId,
        beerName: `Guard Beer ${index + 1}`,
        brewery: null,
        style: null,
        abv: null,
        serveSize: "pint",
        price: 10 + index,
        onTap: true,
        inStock: true,
        notes: null,
      });
    }
    const happyHour = await service.upsertBarHappyHour(admin, "delete-guard-bar", {
      id: null,
      title: "Delete guard happy hour",
      daysOfWeek: ["fri"],
      startTime: "16:00",
      endTime: "18:00",
      description: "$10 selected pints.",
      happyHourBeers: [],
      active: true,
    });

    for (const beerId of beerIds.slice(0, 3)) {
      expect(await service.deleteBarBeer(
        managerAccount,
        "delete-guard-bar",
        beerId,
        (await getVenueInventoryRepository(repository).getBarBeerById(beerId))!.updatedAt,
      ))
        .toEqual(expect.objectContaining({ deleted: true, message: "Beer row removed." }));
    }

    expect(await service.deleteBarHappyHour(managerAccount, "delete-guard-bar", happyHour.happyHour.id, happyHour.happyHour.updatedAt))
      .toEqual(expect.objectContaining({ deleted: true, message: "Happy hour removed." }));

    const heldDelete = await service.deleteBarBeer(
      managerAccount,
      "delete-guard-bar",
      beerIds[3],
      (await getVenueInventoryRepository(repository).getBarBeerById(beerIds[3]))!.updatedAt,
    );
    const pendingDelete = pendingBarChangeFrom(heldDelete);
    expect(heldDelete).toEqual(expect.objectContaining({
      message: "Beer delete held for admin review because 3 beers were already removed in the last hour.",
    }));
    expect(pendingDelete).toEqual(expect.objectContaining({
      action: "delete",
      changeType: "beer",
      targetId: beerIds[3],
      status: "pending",
    }));

    for (let index = 0; index < 101; index += 1) {
      await venuePendingChangeRepositories.get(repository)!.createBarPendingChange({
        id: `delete-guard-filler-${index}`,
        barId: "delete-guard-bar",
        changeType: "beer",
        action: "delete",
        targetId: `unrelated-target-${index}`,
        payload: { beerName: `Unrelated Beer ${index}`, expectedUpdatedAt: NOW },
        submittedBy: managerAccount.id,
        now: `2026-05-04T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
      });
    }
    expect(pendingBarChangeFrom(await service.deleteBarBeer(
      managerAccount,
      "delete-guard-bar",
      beerIds[3],
      (await getVenueInventoryRepository(repository).getBarBeerById(beerIds[3]))!.updatedAt,
    )).id)
      .toBe(pendingDelete.id);
    expect((await venuePendingChangeRepositories.get(repository)!.listBarPendingChanges({
      barId: "delete-guard-bar",
      status: "pending",
      limit: 200,
    }))
      .filter((change) => change.targetId === beerIds[3])).toHaveLength(1);

    const portalAfterHeldDelete = await service.getVenuePortal(managerAccount, { venueId: "delete-guard-bar" });
    expect(portalAfterHeldDelete.inventory.beers).toHaveLength(1);
    expect(portalAfterHeldDelete.inventory.beers[0]?.id).toBe(beerIds[3]);
    expect(portalAfterHeldDelete.pendingChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pendingDelete.id, action: "delete", targetId: beerIds[3] }),
    ]));

    await service.reviewBarPendingChange(admin, pendingDelete.id, { status: "approved", rejectionReason: null });
    expect((await service.getVenuePortal(managerAccount, { venueId: "delete-guard-bar" })).inventory.beers).toHaveLength(0);
  });

  it("keeps stale pending reviews atomic and allows only one concurrent reviewer", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "atomic-review-admin", "admin");
    repository.upsertBarProfile({
      barId: "atomic-review-venue",
      name: "Atomic Review Hotel",
      address: null,
      suburb: "Melbourne",
      area: "Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      acceptsPintPathCodes: false,
      active: true,
      now: NOW,
    });
    const beer = await getVenueInventoryRepository(repository).upsertBarBeer({
      id: "atomic-review-beer",
      barId: "atomic-review-venue",
      beerName: "Guinness",
      normalizedBeerId: "guinness",
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 13,
      currency: "AUD",
      onTap: true,
      inStock: true,
      notes: null,
      now: NOW,
    });
    const pendingRepository = venuePendingChangeRepositories.get(repository)!;
    const pending = await pendingRepository.createBarPendingChange({
      id: "atomic-review-change",
      barId: "atomic-review-venue",
      changeType: "beer",
      action: "delete",
      targetId: beer.id,
      payload: { id: beer.id, beerName: beer.beerName, expectedUpdatedAt: beer.updatedAt },
      submittedBy: admin.id,
      now: NOW,
    });
    const changedBeer = await getVenueInventoryRepository(repository).upsertBarBeer({
      id: beer.id,
      barId: beer.barId,
      beerName: beer.beerName,
      normalizedBeerId: beer.normalizedBeerId,
      brewery: beer.brewery,
      style: beer.style,
      abv: beer.abv,
      serveSize: beer.serveSize,
      price: 14,
      currency: beer.currency,
      onTap: beer.onTap,
      inStock: beer.inStock,
      notes: beer.notes,
      expectedUpdatedAt: beer.updatedAt,
      now: "2026-05-04T09:05:00.000Z",
    });

    await expect(service.reviewBarPendingChange(admin, pending.id, { status: "approved", rejectionReason: null }))
      .rejects.toThrow("changed after submission");
    expect(await pendingRepository.getBarPendingChangeById(pending.id)).toMatchObject({ status: "pending" });
    expect(await getVenueInventoryRepository(repository).getBarBeerById(beer.id)).not.toBeNull();

    const freshPending = await pendingRepository.createBarPendingChange({
      id: "atomic-review-fresh-change",
      barId: "atomic-review-venue",
      changeType: "beer",
      action: "delete",
      targetId: changedBeer.id,
      payload: {
        id: changedBeer.id,
        beerName: changedBeer.beerName,
        expectedUpdatedAt: changedBeer.updatedAt,
      },
      submittedBy: admin.id,
      now: "2026-05-04T09:06:00.000Z",
    });
    vi.setSystemTime(new Date("2026-05-04T09:06:00.000Z"));
    const reviews = await Promise.allSettled([
      service.reviewBarPendingChange(admin, freshPending.id, { status: "approved", rejectionReason: null }),
      service.reviewBarPendingChange(admin, freshPending.id, { status: "approved", rejectionReason: null }),
    ]);
    expect(reviews.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(reviews.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await pendingRepository.getBarPendingChangeById(freshPending.id)).toMatchObject({ status: "approved" });
    expect(await getVenueInventoryRepository(repository).getBarBeerById(beer.id)).toBeNull();
    await expect(service.reviewBarPendingChange(admin, freshPending.id, { status: "approved", rejectionReason: null }))
      .rejects.toThrow("already been reviewed");
  });

  it("limits Free venue accounts to beer and happy-hour data", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "free-bar-admin", "admin");
    const manager = createAccount(repository, "free-bar-manager");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "free-bar-1",
      venueName: "Free Bar",
      suburb: "Brunswick",
    });
    await service.upsertBarProfile(admin, "free-bar-1", {
      name: "Free Bar",
      address: null,
      suburb: "Brunswick",
      area: "Brunswick",
      phone: null,
      website: null,
      instagram: null,
      description: "Free tier venue.",
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      active: true,
    });
    const managerAccount = repository.getAccountById(manager.id)!;

    const freePortal = await service.getVenuePortal(managerAccount, { venueId: "free-bar-1" });
    expect(freePortal.tier.canManageSpecials).toBe(false);
    expect(freePortal.tier.monthlyReports).toBe(false);
    expect(freePortal.tier.analyticsLocked).toBe(true);
    expect(freePortal.analytics).toBeNull();
    expect(freePortal.monthlyReport).toBeNull();

    const freeBeer = await service.upsertBarBeer(managerAccount, "free-bar-1", {
      id: null,
      beerName: "Asahi Super Dry",
      brewery: "Asahi",
      style: "Lager",
      abv: 5,
      serveSize: "pint",
      price: 12,
      onTap: true,
      inStock: true,
      notes: null,
    });
    expect(freeBeer).toEqual(expect.objectContaining({
      beer: expect.objectContaining({ beerName: "Asahi Super Dry", price: 12 }),
    }));
    expect((await service.getVenuePortal(managerAccount, { venueId: "free-bar-1" })).inventory.beers).toHaveLength(1);
    expect(await service.upsertBarHappyHour(managerAccount, "free-bar-1", {
      id: null,
      title: "Weekday happy hour",
      daysOfWeek: ["mon"],
      startTime: "16:00",
      endTime: "18:00",
      description: "$9 pints.",
      active: true,
    })).toEqual(expect.objectContaining({ happyHour: expect.objectContaining({ title: "Weekday happy hour" }) }));
    await expect(service.upsertBarSpecial(managerAccount, "free-bar-1", {
      id: null,
      title: "Free tier special attempt",
      description: "Should not be accepted on Free.",
      price: 20,
      discount: null,
      startsAt: null,
      endsAt: null,
      startTime: "17:00",
      endTime: "19:00",
      scheduleNote: null,
      exclusive: true,
      active: true,
    })).rejects.toThrow("Pro venue tier required");
    await expect(service.exportVenueMonthlyReport(managerAccount, "free-bar-1", "2026-05", {
      format: "json",
    })).rejects.toThrow("Pro venue tier required");
  });

  it("saves direct venue-portal beer API writes without admin approval", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "api-bar-admin", "admin");
    const manager = createAccount(repository, "api-bar-manager");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "api-bar-1",
      venueName: "API Bar",
      suburb: "Carlton",
    });
    await service.upsertBarProfile(admin, "api-bar-1", {
      name: "API Bar",
      address: "1 API Lane",
      suburb: "Carlton",
      area: "Carlton",
      phone: null,
      website: null,
      instagram: null,
      description: "Route-level approval smoke venue.",
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      active: true,
    });
    const token = "manager-api-token";
    repository.createSession({
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      userId: manager.id,
      createdAt: NOW,
      expiresAt: PREMIUM_UNTIL,
    });

    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/business/venue-portal/api-bar-1/beers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: null,
          beerName: "Asahi Super Dry",
          brewery: "Asahi",
          style: "Lager",
          abv: 5,
          serveSize: "pint",
          price: 12,
          onTap: true,
          inStock: true,
          notes: null,
        }),
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { data: { beer: { beerName: string; price: number } } };
      expect(body.data.beer).toEqual(expect.objectContaining({ beerName: "Asahi Super Dry", price: 12 }));

      const publicAfter = await fetch(`${baseUrl}/api/business/price-records?venueId=api-bar-1&limit=20&anonymousSessionId=api-api-after`);
      expect((await publicAfter.json()).data.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ beerName: "Asahi Super Dry", price: null, priceRedacted: true }),
      ]));
    });
  });

  it("accepts authenticated venue claims without granting access before admin review", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "direct-claim-user");
    const token = "direct-claim-user-token";
    createSession(repository, user.id, token);
    repository.upsertVenueLocationCache({
      venueId: "direct-claim-venue",
      venueName: "Direct Claim Pub",
      suburb: "Fitzroy",
      latitude: -37.798,
      longitude: 144.978,
      now: NOW,
    });

    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      const claimPayload = {
        barId: "direct-claim-venue",
        barName: "Direct Claim Pub",
        address: "1 Test Street",
        suburb: "Fitzroy",
        requesterName: "Normal User",
        requesterRole: "Owner",
        contactEmail: "direct-claim-user@example.com",
        contactPhone: null,
        message: "Trying to bypass the invite-only portal.",
      };
      const response = await fetch(`${baseUrl}/api/business/venue-claim-requests`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(claimPayload),
      });

      expect(response.status).toBe(201);
      const body = await response.json() as { data: { claim: { status: string; barId: string } } };
      expect(body.data.claim).toEqual(expect.objectContaining({ status: "pending", barId: "direct-claim-venue" }));
      expect((await getVenueAccessRepository(repository).listVenueClaims({ limit: 10 })).claims).toHaveLength(1);
      expect((await getVenueAccessRepository(repository).listVenueAssignments({
        userId: user.id,
        status: "active",
        limit: 10,
      })).assignments).toHaveLength(0);

      const replay = await fetch(`${baseUrl}/api/business/venue-claim-requests`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(claimPayload),
      });
      expect(replay.status).toBe(200);
      expect((await replay.json()).data.duplicate).toBe(true);
      expect((await getVenueAccessRepository(repository).listVenueClaims({ limit: 10 })).claims).toHaveLength(1);
    });
  });

  it("rejects anonymous direct submission API attempts", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/business/submissions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          venueId: "venue-1",
          venueName: "Anonymous Test Bar",
          suburb: "Melbourne",
          submissionType: "single_beer_price",
          observedAt: NOW,
          sourcePhotoDataUrl: null,
          sourcePhotoUrl: null,
          notes: null,
          items: [{
            beerName: "Guinness",
            servingSize: "pint",
            price: 12,
            isHappyHourPrice: false,
            happyHourDetails: null,
            isOnTap: "yes",
          }],
        }),
      });

      expect(response.status).toBe(401);
      const body = await response.json() as { error: { message: string } };
      expect(body.error.message).toContain("Login required");
      expect(repository.listSubmissions({ limit: 10 })).toHaveLength(0);
    });
  });

  it("keeps venue-manager insights privacy-safe and suppresses low-count suburb demand buckets", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, { ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = createAccount(repository, "portal-privacy-admin", "admin");
    const manager = createAccount(repository, "portal-privacy-manager");
    const submitter = createAccount(repository, "portal-privacy-submitter");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "privacy-bar",
      venueName: "Privacy Bar",
      suburb: "Fitzroy",
    });
    const managerAccount = repository.getAccountById(manager.id)!;
    await service.upsertBarProfile(admin, "privacy-bar", {
      name: "Privacy Bar",
      address: "1 Privacy Lane",
      suburb: "Fitzroy",
      area: "Fitzroy",
      phone: null,
      website: null,
      instagram: null,
      description: "Privacy-safe venue.",
      openingHours: {},
      venueTags: [],
      membershipTier: "pro",
      active: true,
    });
    createSubmission(repository, {
      id: "private-submission",
      userId: submitter.id,
      venueId: "privacy-bar",
      venueName: "Privacy Bar",
      sourcePhotoUrl: PNG_DATA_URL,
    });
    await getSupportFeedbackRepository(repository).createWrongPriceReport({
      id: "private-report",
      userId: submitter.id,
      anonymousSessionId: "report-anon-session",
      venueId: "privacy-bar",
      venueName: "Privacy Bar",
      priceRecordId: null,
      beerName: "Carlton Draught",
      reason: "price_changed",
      notes: "Menu board looked different. Call me on 0412 345 678 or test@example.com.",
      sourcePhotoUrl: PNG_DATA_URL,
      now: NOW,
    });
    await getVenueRequestRepository(repository).createOrGetVenueRequest({
      id: "private-request",
      userId: submitter.id,
      anonymousSessionId: "request-anon-session",
      requestType: "verify_venue",
      venueId: "privacy-bar",
      venueName: "Privacy Bar",
      googlePlaceId: null,
      beerName: null,
      suburb: "Fitzroy",
      notes: "Please verify. Contact test@example.com.",
      now: NOW,
    });

    for (let index = 0; index < 9; index += 1) {
      await getActivityAuditRepository(repository).recordEvent({
        id: `privacy-low-${index}`,
        userId: null,
        anonymousSessionId: `low-${index}`,
        eventType: "beer_search_performed",
        venueId: null,
        beerId: "single_user_beer",
        suburb: "Fitzroy",
        metadata: {},
        createdAt: NOW,
      });
    }
    for (let index = 0; index < 10; index += 1) {
      await getActivityAuditRepository(repository).recordEvent({
        id: `privacy-high-${index}`,
        userId: null,
        anonymousSessionId: `high-${index}`,
        eventType: "beer_search_performed",
        venueId: null,
        beerId: "guinness",
        suburb: "Fitzroy",
        metadata: {},
        createdAt: NOW,
      });
    }

    const portal = await service.getVenuePortal(managerAccount, { venueId: "privacy-bar" });
    const serializedInsights = JSON.stringify(portal.insights);
    const report = portal.insights?.wrongPriceReports[0] as Record<string, unknown>;
    const request = portal.insights?.requests[0] as Record<string, unknown>;
    const submission = portal.insights?.submissions[0] as Record<string, unknown>;

    expect(report.userId).toBeUndefined();
    expect(report.anonymousSessionId).toBeUndefined();
    expect(report.sourcePhotoUrl).toBeUndefined();
    expect(report.hasSourcePhoto).toBe(true);
    expect(report.notes).toBe("Menu board looked different. Call me on [redacted phone] or [redacted email].");
    expect(request.userId).toBeUndefined();
    expect(request.anonymousSessionId).toBeUndefined();
    expect(request.notes).toBe("Please verify. Contact [redacted email].");
    expect(submission.userId).toBeUndefined();
    expect(submission.sourcePhotoUrl).toBeUndefined();
    expect(submission.hasSourcePhoto).toBe(true);
    expect(serializedInsights).not.toContain(PNG_DATA_URL);
    expect(serializedInsights).not.toContain("portal-privacy-submitter");
    expect(serializedInsights).not.toContain("report-anon-session");
    expect(portal.insights?.aggregateInsights?.topSearchedBeersNearby)
      .toEqual([{ key: "guinness", count: 10 }]);
    expect(portal.insights?.aggregateInsights?.missingBeerSearches)
      .toEqual([{ key: "guinness", count: 10 }]);
  });

  it("gates bar analytics by tier and enables Pro display metadata", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "bar-tier-admin", "admin");
    const manager = createAccount(repository, "bar-tier-manager");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "bar-tier-1",
      venueName: "Railway Hotel",
      suburb: "South Melbourne",
    });
    const managerAccount = repository.getAccountById(manager.id)!;

    for (let index = 0; index < 10; index += 1) {
      await getActivityAuditRepository(repository).recordEvent({
        id: `bar-tier-event-${index}`,
        userId: null,
        anonymousSessionId: `anon-area-${index}`,
        eventType: "beer_search_performed",
        venueId: "bar-tier-1",
        beerId: "lager",
        suburb: "South Melbourne",
        metadata: { query: "lager" },
        createdAt: NOW,
      });
    }
    await getActivityAuditRepository(repository).recordEvent({
      id: "bar-tier-detail-event",
      userId: null,
      anonymousSessionId: "anon-area-2",
      eventType: "venue_detail_opened",
      venueId: "bar-tier-1",
      beerId: null,
      suburb: "South Melbourne",
      metadata: {},
      createdAt: NOW,
    });
    await getActivityAuditRepository(repository).recordEvent({
      id: "bar-tier-venue-search",
      userId: null,
      anonymousSessionId: "anon-area-venue-search",
      eventType: "search_performed",
      venueId: null,
      beerId: null,
      suburb: "South Melbourne",
      metadata: { query: "Railway Hotel" },
      createdAt: NOW,
    });
    for (let index = 0; index < 18; index += 1) {
      await getActivityAuditRepository(repository).recordEvent({
        id: `bar-tier-current-style-${index}`,
        userId: null,
        anonymousSessionId: `bar-tier-current-style-actor-${index}`,
        eventType: "style_search",
        venueId: null,
        beerId: null,
        suburb: "South Melbourne",
        metadata: { query: "lager", searchKind: "style" },
        createdAt: `2026-05-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
      });
    }
    for (let index = 0; index < 10; index += 1) {
      await getActivityAuditRepository(repository).recordEvent({
        id: `bar-tier-previous-search-${index}`,
        userId: null,
        anonymousSessionId: `anon-previous-area-${index}`,
        eventType: "beer_search_performed",
        venueId: null,
        beerId: "lager",
        suburb: "South Melbourne",
        metadata: { query: "lager" },
        createdAt: `2026-04-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
      });
      await getActivityAuditRepository(repository).recordEvent({
        id: `bar-tier-previous-style-${index}`,
        userId: null,
        anonymousSessionId: `bar-tier-previous-style-actor-${index}`,
        eventType: "style_search",
        venueId: null,
        beerId: null,
        suburb: "South Melbourne",
        metadata: { query: "lager", searchKind: "style" },
        createdAt: `2026-04-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
      });
    }

    const proProfile = await service.upsertBarProfile(admin, "bar-tier-1", {
      name: "Railway Hotel",
      address: null,
      suburb: "South Melbourne",
      area: "South Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: "Neighbourhood pub.",
      openingHours: {},
      venueTags: [],
      membershipTier: "pro",
      active: true,
    });
    expect(proProfile.profile.membershipTier).toBe("pro");
    expect(proProfile.profile.highlightedName).toBe(true);
    expect(proProfile.profile.premiumBadge).toBe("Pro");
    expect(proProfile.profile.promoted).toBe(true);
    expect(proProfile.profile.featuredSpecialEligible).toBe(true);
    await getVenueInventoryRepository(repository).upsertBarBeer({
      id: "bar-tier-carlton",
      barId: "bar-tier-1",
      beerName: "Carlton Draught",
      brewery: null,
      style: "lager",
      abv: null,
      serveSize: "pint",
      price: 13.2,
      currency: "AUD",
      onTap: true,
      inStock: true,
      notes: null,
      now: NOW,
    });
    await service.upsertBarProfile(admin, "bar-tier-local-1", {
      name: "Local Benchmark One",
      address: null,
      suburb: "South Melbourne",
      area: "South Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      active: true,
    });
    await getVenueInventoryRepository(repository).upsertBarBeer({
      id: "bar-tier-local-1-carlton",
      barId: "bar-tier-local-1",
      beerName: "Carlton Draught",
      brewery: null,
      style: "lager",
      abv: null,
      serveSize: "pint",
      price: 12,
      currency: "AUD",
      onTap: true,
      inStock: true,
      notes: null,
      now: NOW,
    });
    await service.upsertBarProfile(admin, "bar-tier-local-2", {
      name: "Local Benchmark Two",
      address: null,
      suburb: "South Melbourne",
      area: "South Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      active: true,
    });
    await getVenueInventoryRepository(repository).upsertBarBeer({
      id: "bar-tier-local-2-carlton",
      barId: "bar-tier-local-2",
      beerName: "Carlton Draught",
      brewery: null,
      style: "lager",
      abv: null,
      serveSize: "pint",
      price: 11.8,
      currency: "AUD",
      onTap: true,
      inStock: true,
      notes: null,
      now: NOW,
    });
    const pintPointUser = createAccount(repository, "bar-tier-pint-point-user");
    repository.createPintPointDrinkRecord({
      id: "bar-tier-guinness-purchase",
      userId: pintPointUser.id,
      venueId: "bar-tier-1",
      venueName: "Railway Hotel",
      suburb: "South Melbourne",
      itemName: "Guinness",
      beverageCategory: "alcoholic",
      quantity: 10,
      isAlcoholic: true,
      source: "venue_portal",
      recordedByUserId: manager.id,
      recordedAt: NOW,
      metadata: {},
    });

    const proPortal = await service.getVenuePortal(managerAccount, { venueId: "bar-tier-1" });
    expect(proPortal.tier.analyticsLocked).toBe(false);
    expect(proPortal.tier.canManageSpecials).toBe(true);
    expect(proPortal.tier.featuredSpecials).toBe(true);
    expect(proPortal.tier.priorityReview).toBe(true);
    expect(proPortal.tier.advancedRecommendations).toBe(true);
    expect(proPortal.analytics?.barLookups).toBe(0);
    expect(proPortal.analytics?.privacyFloorMet).toBe(true);
    expect(proPortal.analytics?.areaBeerSearches.length).toBeGreaterThan(0);
    expect(proPortal.monthlyReport?.data).toBeTruthy();
    expect(proPortal.businessToolkit?.demandSnapshot).toEqual(expect.objectContaining({
      title: "Area demand snapshot",
      privacyFloorMet: true,
      recommendedNextActions: expect.arrayContaining([expect.any(String)]),
    }));
    expect(proPortal.demandDashboard).toEqual(expect.objectContaining({
      title: "Pro demand cockpit",
      proActive: true,
      periodOrder: ["today", "week", "month"],
      periods: expect.objectContaining({
        today: expect.objectContaining({
          venueSearches: 0,
          venueSearchQueries: 0,
          venueOpens: 0,
          topAreaBeer: { key: "lager", count: 10 },
        }),
        month: expect.objectContaining({
          venueSearches: 0,
          beerIntent: expect.any(Number),
          recommendedAction: expect.stringContaining("lager"),
        }),
      }),
    }));
    expect(proPortal.businessToolkit?.proGrowthPlan).toEqual(expect.objectContaining({
      title: "Pro growth studio",
      premiumPlacement: expect.objectContaining({
        mapHalo: true,
        priorityReview: true,
        featuredExclusiveEligible: true,
      }),
      weekendPlaybook: expect.arrayContaining([expect.any(String)]),
    }));
    expect(proPortal.monthlyReport?.data?.summary).toEqual(expect.objectContaining({
      demandSnapshot: expect.objectContaining({
        opportunityScore: null,
      }),
    }));
    expect(proPortal.businessToolkit?.demandDashboard).toEqual(expect.objectContaining({
      title: "Pro demand cockpit",
      proActive: true,
      headline: expect.stringContaining("lager"),
      proAdvantage: expect.arrayContaining([
        expect.stringContaining("Premium map/listing treatment"),
      ]),
    }));
    expect(proPortal.paidVenueIntelligence).toEqual(expect.objectContaining({
      area: "South Melbourne",
      topSearchedBeers: expect.arrayContaining([
        expect.objectContaining({ key: "lager", searchCount: 10 }),
      ]),
      topPurchasedBeers: expect.arrayContaining([
        expect.objectContaining({ beerName: "Guinness", purchaseCount: 10 }),
      ]),
      searchStockGaps: expect.arrayContaining([
        expect.objectContaining({
          key: "lager",
          copy: expect.stringContaining("but your venue does not list it"),
        }),
      ]),
      localTrendReport: expect.arrayContaining([
        expect.objectContaining({
          key: "lager",
          direction: "up",
        }),
      ]),
      priceBenchmarks: expect.arrayContaining([
        expect.objectContaining({
          beerName: "Carlton Draught",
          comparison: "above",
          difference: 1.2,
        }),
      ]),
    }));
    expect(proPortal.paidVenueIntelligence?.searchTimesByDay.length).toBeGreaterThan(0);
    expect(proPortal.paidVenueIntelligence?.searchTimesByHour.length).toBeGreaterThan(0);
    expect(proPortal.dailySpecialsPlanner).toEqual(expect.objectContaining({
      title: "Specials planner",
      area: "South Melbourne",
      summaryDate: "2026-05-04",
      sourcePeriod: "today",
      privacyFloorMet: true,
      popularWindows: expect.arrayContaining([
        expect.objectContaining({ label: "6 pm-8 pm", startTime: "18:00", endTime: "20:00" }),
      ]),
      quietWindows: expect.arrayContaining([
        expect.objectContaining({ label: "12 pm-2 pm", startTime: "12:00", endTime: "14:00" }),
      ]),
      recommendations: expect.arrayContaining([
        expect.objectContaining({
          title: "Fill the 12 pm-2 pm lull",
          type: "foot_traffic",
        }),
      ]),
    }));
    expect(proPortal.businessToolkit?.dailySpecialsPlanner).toEqual(proPortal.dailySpecialsPlanner);
    expect(proPortal.monthlyReport?.month).toBe("2026-04");
    const completedMonthSummary = proPortal.monthlyReport?.data?.summary as Record<string, unknown>;
    expect(completedMonthSummary).toEqual(expect.objectContaining({
      operationalSnapshotExcluded: true,
      historicalDataScope: expect.stringContaining("Current listing quality"),
      proRecommendations: expect.arrayContaining([
        expect.any(String),
      ]),
      demandSnapshot: expect.objectContaining({
        title: "Reporting-period demand snapshot",
      }),
    }));
    expect(completedMonthSummary).not.toHaveProperty("dailySpecialsPlanner");
    expect(completedMonthSummary).not.toHaveProperty("priceBenchmarks");
    expect(completedMonthSummary).not.toHaveProperty("proGrowthPlan");
    expect(completedMonthSummary).not.toHaveProperty("discoveryPlacement");

    const proSpecial = await service.upsertBarSpecial(managerAccount, "bar-tier-1", {
      id: null,
      title: "Friday Pint Path exclusive",
      description: "A genuine Pro-only offer ready for review.",
      price: 18,
      discount: null,
      startsAt: null,
      endsAt: null,
      startTime: "17:00",
      endTime: "19:00",
      scheduleNote: "Friday 5pm-7pm",
      exclusive: true,
      active: true,
    });
    expect(proSpecial.special).toEqual(expect.objectContaining({
      title: "Friday Pint Path exclusive",
      exclusive: true,
      active: true,
    }));
  });

  it("prioritises Pro venue changes in the admin review queue", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "priority-review-admin", "admin");
    const proManager = createAccount(repository, "priority-pro-manager");
    const basicManager = createAccount(repository, "priority-basic-manager");

    await service.assignVenueManager(admin, {
      userId: proManager.id,
      venueId: "priority-pro-bar",
      venueName: "Priority Pro Bar",
      suburb: "Fitzroy",
    });
    await service.assignVenueManager(admin, {
      userId: basicManager.id,
      venueId: "priority-basic-bar",
      venueName: "Priority Basic Bar",
      suburb: "Richmond",
    });
    await service.upsertBarProfile(admin, "priority-pro-bar", {
      name: "Priority Pro Bar",
      address: null,
      suburb: "Fitzroy",
      area: "Fitzroy",
      phone: null,
      website: null,
      instagram: null,
      description: "Pro review queue smoke venue.",
      openingHours: {},
      venueTags: [],
      membershipTier: "pro",
      active: true,
    });
    await service.upsertBarProfile(admin, "priority-basic-bar", {
      name: "Priority Basic Bar",
      address: null,
      suburb: "Richmond",
      area: "Richmond",
      phone: null,
      website: null,
      instagram: null,
      description: "Basic review queue smoke venue.",
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      active: true,
    });

    const queueFourthDelete = async (managerId: string, venueId: string) => {
      const manager = repository.getAccountById(managerId)!;
      const beers = [];
      for (let index = 0; index < 4; index += 1) {
        beers.push((await service.upsertBarBeer(manager, venueId, {
          id: null,
          beerName: "Carlton Draught",
          brewery: "Carlton & United Breweries",
          style: "Lager",
          abv: 4.6,
          serveSize: index % 2 ? "pot" : "pint",
          price: 10 + index,
          onTap: true,
          inStock: true,
          notes: `Delete guard row ${index + 1}`,
        })).beer);
      }
      for (const beer of beers.slice(0, 3)) {
        expect(await service.deleteBarBeer(manager, venueId, beer.id, beer.updatedAt))
          .toEqual(expect.objectContaining({ deleted: true }));
      }
      return service.deleteBarBeer(manager, venueId, beers[3]!.id, beers[3]!.updatedAt);
    };

    expect(await queueFourthDelete(basicManager.id, "priority-basic-bar"))
      .toEqual(expect.objectContaining({ pendingChange: expect.objectContaining({ changeType: "beer", action: "delete" }) }));
    expect(await queueFourthDelete(proManager.id, "priority-pro-bar"))
      .toEqual(expect.objectContaining({ pendingChange: expect.objectContaining({ changeType: "beer", action: "delete" }) }));

    const pending = (await service.getVenuePartnerAdmin(admin)).pendingChanges;
    expect(pending).toHaveLength(2);
    expect(pending[0]?.barId).toBe("priority-pro-bar");
  });

  it("exposes only public tier metadata on venue discovery rows", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "public-tier-admin", "admin");

    await service.seedDemoMissions();
    await service.upsertBarProfile(admin, "demo:rooftop-bar", {
      name: "Rooftop Bar",
      address: null,
      suburb: "Melbourne",
      area: "Melbourne",
      phone: null,
      website: null,
      instagram: null,
      description: "Premium skyline venue.",
      openingHours: {},
      venueTags: [],
      membershipTier: "pro",
      acceptsPintPathCodes: true,
      active: true,
    });

    const venues = await service.listVenues(undefined, 20);
    const proVenue = venues.find((venue) => venue.id === "demo:rooftop-bar");
    const freeVenue = venues.find((venue) => venue.id === "demo:fitzroy-beer-garden");

    expect(proVenue?.membershipTier).toBe("pro");
    expect(proVenue?.premiumBadge).toBe("Pro");
    expect(proVenue?.highlightedName).toBe(true);
    expect(proVenue?.promoted).toBe(true);
    expect(proVenue?.acceptsPintPathCodes).toBe(true);
    expect(proVenue).not.toHaveProperty("stripeCustomerId");
    expect(proVenue).not.toHaveProperty("stripeSubscriptionId");
    expect(freeVenue?.membershipTier).toBe("basic");
    expect(freeVenue?.premiumBadge).toBeNull();
    expect(freeVenue?.acceptsPintPathCodes).toBe(false);
    expect(venues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "demo:sandringham-hotel" }),
    ]));
  });

  it("serves a public venue detail lookup without private billing metadata", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "public-venue-detail-admin", "admin");

    await service.upsertBarProfile(admin, "venue-detail-1", {
      name: "Moonlit Taproom",
      address: "10 Test Lane",
      suburb: "Fitzroy",
      area: "Fitzroy",
      phone: "03 9000 2222",
      website: "https://moonlit.example.com",
      instagram: "https://instagram.com/moonlittaproom",
      description: "A launch-ready venue.",
      openingHours: { friday: { open: true, openTime: "16:00", closeTime: "01:00" } },
      venueTags: [],
      membershipTier: "pro",
      acceptsPintPathCodes: true,
      active: true,
    });

    const beerSummarySpy = vi.spyOn(
      publicVenueDirectoryRepositories.get(repository)!,
      "listPublicVenueBeerKeys",
    );
    const venue = await service.getPublicVenueById("venue-detail-1");

    expect(venue?.name).toBe("Moonlit Taproom");
    expect(venue?.suburb).toBe("Fitzroy");
    expect(venue?.membershipTier).toBe("pro");
    expect(venue?.acceptsPintPathCodes).toBe(true);
    expect(venue).toEqual(expect.objectContaining({
      phone: "03 9000 2222",
      website: "https://moonlit.example.com",
      instagram: "https://instagram.com/moonlittaproom",
      description: "A launch-ready venue.",
      openingHours: { friday: { open: true, openTime: "16:00", closeTime: "01:00" } },
    }));
    expect(venue).not.toHaveProperty("stripeCustomerId");
    expect(venue).not.toHaveProperty("beerKeys");
    expect(beerSummarySpy).not.toHaveBeenCalled();
    expect(await service.getPublicVenueById("missing-venue")).toBeNull();
  });

  it("maps a concurrent provider cache OCC loser to a safe service conflict", async () => {
    const { repository } = createRepository();
    const venueId = "00000000-0000-4000-8000-000000000091";
    const pendingReads: Array<(result: { data: Record<string, unknown>; error: null }) => void> = [];
    const from = vi.fn(() => {
      const builder = {} as {
        select: ReturnType<typeof vi.fn>;
        eq: ReturnType<typeof vi.fn>;
        gte: ReturnType<typeof vi.fn>;
        maybeSingle: ReturnType<typeof vi.fn>;
      };
      builder.select = vi.fn(() => builder);
      builder.eq = vi.fn(() => builder);
      builder.gte = vi.fn(() => builder);
      builder.maybeSingle = vi.fn(() => new Promise<{ data: Record<string, unknown>; error: null }>((resolve) => {
        pendingReads.push(resolve);
      }));
      return builder;
    });
    const service = createBusinessService(repository, {}, undefined, { from } as never);
    const requests = [service.getPublicVenueById(venueId), service.getPublicVenueById(venueId)];
    for (let attempt = 0; pendingReads.length < 2 && attempt < 50; attempt += 1) {
      await Promise.resolve();
    }
    expect(pendingReads).toHaveLength(2);

    pendingReads[0]!({
      data: {
        id: venueId,
        name: "OCC Winner One",
        suburb: "Fitzroy",
        latitude: -37.799,
        longitude: 144.978,
        directory_eligible: true,
        business_status: "OPERATIONAL",
        last_checked_at: NOW,
      },
      error: null,
    });
    pendingReads[1]!({
      data: {
        id: venueId,
        name: "OCC Winner Two",
        suburb: "Richmond",
        latitude: -37.818,
        longitude: 144.998,
        directory_eligible: true,
        business_status: "OPERATIONAL",
        last_checked_at: NOW,
      },
      error: null,
    });

    const settled = await Promise.allSettled(requests);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("Expected one location-cache conflict.");
    expect(rejected.reason).toMatchObject({
      statusCode: 409,
      message: "Venue identity or location changed. Refresh and try again.",
    });
    expect(JSON.stringify(rejected.reason)).not.toContain("location_version_conflict");
    const cached = await getVenueIdentityRepository(repository).getVenueLocationCache(venueId);
    expect(["OCC Winner One", "OCC Winner Two"]).toContain(cached?.venueName);
  });

  it("returns one HTML winner and one safe 409 through the public venue route on a cache race", async () => {
    vi.useRealTimers();
    const { repository } = createRepository();
    const venueId = "00000000-0000-4000-8000-000000000092";
    const observedAt = new Date().toISOString();
    const pendingReads: Array<(result: { data: Record<string, unknown>; error: null }) => void> = [];
    const from = vi.fn(() => {
      const builder = {} as {
        select: ReturnType<typeof vi.fn>;
        eq: ReturnType<typeof vi.fn>;
        gte: ReturnType<typeof vi.fn>;
        maybeSingle: ReturnType<typeof vi.fn>;
      };
      builder.select = vi.fn(() => builder);
      builder.eq = vi.fn(() => builder);
      builder.gte = vi.fn(() => builder);
      builder.maybeSingle = vi.fn(() => new Promise<{ data: Record<string, unknown>; error: null }>((resolve) => {
        pendingReads.push(resolve);
      }));
      return builder;
    });
    const service = createBusinessService(repository, {}, undefined, { from } as never);
    const app = express();
    app.use((_req, res, next) => {
      res.locals.cspNonce = "venue-occ-test";
      next();
    });
    app.get("/venues/:venueId", createPublicVenuePageHandler(async () => service));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      const responses = [fetch(`${baseUrl}/venues/${venueId}`), fetch(`${baseUrl}/venues/${venueId}`)];
      for (let attempt = 0; pendingReads.length < 2 && attempt < 100; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(pendingReads).toHaveLength(2);
      pendingReads[0]!({
        data: {
          id: venueId,
          name: "Route OCC One",
          suburb: "Fitzroy",
          latitude: -37.799,
          longitude: 144.978,
          directory_eligible: true,
          business_status: "OPERATIONAL",
          last_checked_at: observedAt,
        },
        error: null,
      });
      pendingReads[1]!({
        data: {
          id: venueId,
          name: "Route OCC Two",
          suburb: "Richmond",
          latitude: -37.818,
          longitude: 144.998,
          directory_eligible: true,
          business_status: "OPERATIONAL",
          last_checked_at: observedAt,
        },
        error: null,
      });

      const completed = await Promise.all(responses);
      expect(completed.map((response) => response.status).sort((left, right) => left - right)).toEqual([200, 409]);
      const winner = completed.find((response) => response.status === 200)!;
      const conflict = completed.find((response) => response.status === 409)!;
      expect(await winner.text()).toMatch(/Route OCC (One|Two)/);
      await expect(conflict.json()).resolves.toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: "Venue identity or location changed. Refresh and try again.",
        }),
      }));
    });
  });

  it("activates the Pro bar tier through demo checkout without Stripe keys", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "bar-checkout-admin", "admin");
    const manager = createAccount(repository, "bar-checkout-manager");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "bar-checkout-1",
      venueName: "Checkout Hotel",
      suburb: "Collingwood",
    });
    const managerAccount = repository.getAccountById(manager.id)!;

    const proCheckout = await service.createBarTierCheckout(managerAccount, "bar-checkout-1", { tier: "pro" });
    expect(proCheckout.mode).toBe("demo");
    expect(proCheckout.profile.membershipTier).toBe("pro");
    expect(proCheckout.tier.analyticsLocked).toBe(false);
    expect(proCheckout.profile.highlightedName).toBe(true);
    expect(proCheckout.profile.premiumBadge).toBe("Pro");
  });

  it("enables automatic tax and venue tax ID collection for live Pro checkout", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRO_PRICE_ID: "price_test_venue_pro",
    });
    const admin = createAccount(repository, "bar-live-checkout-admin", "admin");
    const manager = createAccount(repository, "bar-live-checkout-manager");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "bar-live-checkout-1",
      venueName: "Live Checkout Hotel",
      suburb: "Collingwood",
    });

    const originalFetch = globalThis.fetch;
    let checkoutRequestBody = "";
    try {
      const checkoutFetch = vi.fn(async (url, init) => {
        expect(String(url)).toBe("https://api.stripe.com/v1/checkout/sessions");
        checkoutRequestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({
          id: "cs_test_venue_tax",
          url: "https://checkout.stripe.com/c/pay/cs_test_venue_tax",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      globalThis.fetch = checkoutFetch as typeof fetch;

      await expect(service.createBarTierCheckout(
        repository.getAccountById(manager.id)!,
        "bar-live-checkout-1",
        { tier: "pro" },
      )).resolves.toMatchObject({
        mode: "stripe",
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_venue_tax",
      });
      await expect(service.createBarTierCheckout(
        repository.getAccountById(manager.id)!,
        "bar-live-checkout-1",
        { tier: "pro" },
      )).resolves.toMatchObject({
        mode: "stripe",
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_venue_tax",
        message: expect.stringContaining("existing Stripe Checkout session"),
      });
      expect(checkoutFetch).toHaveBeenCalledTimes(1);

      const checkoutParams = new URLSearchParams(checkoutRequestBody);
      expect(checkoutParams.get("mode")).toBe("subscription");
      expect(checkoutParams.get("automatic_tax[enabled]")).toBe("true");
      expect(Number(checkoutParams.get("expires_at"))).toBe(
        Math.floor((Date.parse(NOW) + 35 * 60 * 1_000) / 1_000),
      );
      expect(checkoutParams.get("billing_address_collection")).toBe("required");
      expect(checkoutParams.get("tax_id_collection[enabled]")).toBe("true");
      expect(checkoutParams.get("line_items[0][price]")).toBe("price_test_venue_pro");
      expect(checkoutParams.get("metadata[billing_context]")).toBe("venue");
      expect(checkoutParams.get("metadata[venue_id]")).toBe("bar-live-checkout-1");
      expect(checkoutParams.get("subscription_data[metadata][billing_context]")).toBe("venue");
      expect(checkoutParams.get("subscription_data[trial_period_days]")).toBe("60");
      expect(checkoutParams.get("payment_method_collection")).toBe("if_required");
      expect(checkoutParams.get("subscription_data[trial_settings][end_behavior][missing_payment_method]")).toBe("cancel");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reconciles a completed venue trial after its reservation expires instead of issuing a second trial", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRO_PRICE_ID: "price_test_venue_pro",
    });
    const admin = createAccount(repository, "delayed-trial-admin", "admin");
    const manager = createAccount(repository, "delayed-trial-manager");
    const venueId = "delayed-trial-venue";

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId,
      venueName: "Delayed Trial Hotel",
      suburb: "Carlton",
    });

    const originalFetch = globalThis.fetch;
    const checkoutBodies: string[] = [];
    try {
      const stripeFetch = vi.fn(async (url, init) => {
        const requestUrl = String(url);
        if (requestUrl === "https://api.stripe.com/v1/checkout/sessions") {
          checkoutBodies.push(String(init?.body ?? ""));
          return new Response(JSON.stringify({
            id: "cs_delayed_trial",
            url: "https://checkout.stripe.com/c/pay/cs_delayed_trial",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (requestUrl.includes("/v1/checkout/sessions/cs_delayed_trial?")) {
          return new Response(JSON.stringify({
            id: "cs_delayed_trial",
            status: "complete",
            customer: "cus_delayed_trial",
            subscription: {
              id: "sub_delayed_trial",
              status: "trialing",
              current_period_end: 1_775_000_000,
            },
            metadata: {
              billing_context: "venue",
              user_id: manager.id,
              venue_id: venueId,
              venue_membership_tier: "pro",
            },
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (requestUrl === "https://api.stripe.com/v1/billing_portal/sessions") {
          return new Response(JSON.stringify({
            url: "https://billing.stripe.com/p/session/delayed-trial",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected Stripe request: ${requestUrl}`);
      });
      globalThis.fetch = stripeFetch as typeof fetch;

      await expect(service.createBarTierCheckout(
        repository.getAccountById(manager.id)!,
        venueId,
        { tier: "pro" },
      )).resolves.toMatchObject({
        mode: "stripe",
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_delayed_trial",
      });

      vi.setSystemTime(new Date(Date.parse(NOW) + 36 * 60 * 1_000));
      await expect(service.createBarTierCheckout(
        repository.getAccountById(manager.id)!,
        venueId,
        { tier: "pro" },
      )).resolves.toMatchObject({
        mode: "portal",
        checkoutUrl: "https://billing.stripe.com/p/session/delayed-trial",
        message: expect.stringContaining("existing venue trial was recovered"),
      });

      expect(checkoutBodies).toHaveLength(1);
      expect(new URLSearchParams(checkoutBodies[0]).get("subscription_data[trial_period_days]")).toBe("60");
      await expect(getBillingCheckoutRepository(repository).hasVenueIntroTrialEverClaimed({
        venueId,
        asOf: new Date(Date.now()).toISOString(),
      })).resolves.toBe(true);
      expect(repository.getBarProfile(venueId)).toMatchObject({
        membershipTier: "pro",
        stripeCustomerId: "cus_delayed_trial",
        stripeSubscriptionId: "sub_delayed_trial",
        subscriptionStatus: "trialing",
      });
      expect(stripeFetch).toHaveBeenCalledTimes(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not re-grant a trial when a newer cancellation races venue checkout reconciliation", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRO_PRICE_ID: "price_test_venue_pro",
    });
    const admin = createAccount(repository, "trial-race-admin", "admin");
    const manager = createAccount(repository, "trial-race-manager");
    const venueId = "trial-race-venue";

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId,
      venueName: "Trial Race Hotel",
      suburb: "Carlton",
    });

    const originalFetch = globalThis.fetch;
    try {
      const stripeFetch = vi.fn(async (url) => {
        const requestUrl = String(url);
        if (requestUrl === "https://api.stripe.com/v1/checkout/sessions") {
          return new Response(JSON.stringify({
            id: "cs_trial_race",
            url: "https://checkout.stripe.com/c/pay/cs_trial_race",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (requestUrl.includes("/v1/checkout/sessions/cs_trial_race?")) {
          const cancellationCursor = new Date(Date.now()).toISOString();
          repository.updateBarSubscription({
            barId: venueId,
            membershipTier: "basic",
            stripePaidMembershipTier: "pro",
            stripeCustomerId: "cus_trial_race",
            stripeSubscriptionId: "sub_trial_race",
            subscriptionStatus: "canceled",
            subscriptionCurrentPeriodEnd: null,
            highlightedName: false,
            premiumBadge: null,
            promoted: false,
            featuredSpecialEligible: false,
            now: cancellationCursor,
            stripeEventCreatedAt: cancellationCursor,
          });
          return new Response(JSON.stringify({
            id: "cs_trial_race",
            status: "complete",
            customer: "cus_trial_race",
            subscription: {
              id: "sub_trial_race",
              status: "trialing",
              current_period_end: 1_775_000_000,
            },
            metadata: {
              billing_context: "venue",
              user_id: manager.id,
              venue_id: venueId,
              venue_membership_tier: "pro",
            },
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected Stripe request: ${requestUrl}`);
      });
      globalThis.fetch = stripeFetch as typeof fetch;

      await service.createBarTierCheckout(
        repository.getAccountById(manager.id)!,
        venueId,
        { tier: "pro" },
      );
      vi.setSystemTime(new Date(Date.parse(NOW) + 36 * 60 * 1_000));

      await expect(service.createBarTierCheckout(
        repository.getAccountById(manager.id)!,
        venueId,
        { tier: "pro" },
      )).rejects.toMatchObject({
        statusCode: 409,
        details: { publicCode: "VENUE_TRIAL_RECONCILIATION_CHANGED" },
        message: expect.stringContaining("billing changed"),
      });

      expect(repository.getBarProfile(venueId)).toMatchObject({
        membershipTier: "basic",
        stripeCustomerId: "cus_trial_race",
        stripeSubscriptionId: "sub_trial_race",
        subscriptionStatus: "canceled",
        stripeEventCreatedAt: new Date(Date.now()).toISOString(),
      });
      await expect(getBillingCheckoutRepository(repository).hasVenueIntroTrialEverClaimed({
        venueId,
        asOf: new Date(Date.now()).toISOString(),
      })).resolves.toBe(true);
      expect(stripeFetch).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("replaces a venue trial checkout only after Stripe confirms the prior session expired", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRO_PRICE_ID: "price_test_venue_pro",
    });
    const admin = createAccount(repository, "expired-session-admin", "admin");
    const manager = createAccount(repository, "expired-session-manager");
    const venueId = "expired-session-venue";

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId,
      venueName: "Expired Session Hotel",
      suburb: "Richmond",
    });

    const originalFetch = globalThis.fetch;
    const checkoutBodies: string[] = [];
    try {
      const stripeFetch = vi.fn(async (url, init) => {
        const requestUrl = String(url);
        if (requestUrl.includes("/v1/checkout/sessions/cs_expired_trial?")) {
          return new Response(JSON.stringify({
            id: "cs_expired_trial",
            status: "expired",
            metadata: {
              billing_context: "venue",
              user_id: manager.id,
              venue_id: venueId,
              venue_membership_tier: "pro",
            },
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (requestUrl === "https://api.stripe.com/v1/checkout/sessions") {
          checkoutBodies.push(String(init?.body ?? ""));
          const sessionId = checkoutBodies.length === 1
            ? "cs_expired_trial"
            : "cs_replacement_trial";
          return new Response(JSON.stringify({
            id: sessionId,
            url: `https://checkout.stripe.com/c/pay/${sessionId}`,
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected Stripe request: ${requestUrl}`);
      });
      globalThis.fetch = stripeFetch as typeof fetch;

      await service.createBarTierCheckout(
        repository.getAccountById(manager.id)!,
        venueId,
        { tier: "pro" },
      );
      vi.setSystemTime(new Date(Date.parse(NOW) + 36 * 60 * 1_000));

      await expect(service.createBarTierCheckout(
        repository.getAccountById(manager.id)!,
        venueId,
        { tier: "pro" },
      )).resolves.toMatchObject({
        mode: "stripe",
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_replacement_trial",
      });

      expect(checkoutBodies).toHaveLength(2);
      for (const body of checkoutBodies) {
        expect(new URLSearchParams(body).get("subscription_data[trial_period_days]")).toBe("60");
      }
      await expect(getBillingCheckoutRepository(repository).hasVenueIntroTrialEverClaimed({
        venueId,
        asOf: new Date(Date.now()).toISOString(),
      })).resolves.toBe(false);
      expect(stripeFetch).toHaveBeenCalledTimes(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when an expired venue trial reservation has no Stripe session authority", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRO_PRICE_ID: "price_test_venue_pro",
    });
    const admin = createAccount(repository, "uncertain-trial-admin", "admin");
    const manager = createAccount(repository, "uncertain-trial-manager");
    const venueId = "uncertain-trial-venue";

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId,
      venueName: "Uncertain Trial Hotel",
      suburb: "Fitzroy",
    });
    await getVenueInventoryRepository(repository).upsertBarProfile({
      barId: venueId,
      name: "Uncertain Trial Hotel",
      address: null,
      suburb: "Fitzroy",
      area: "Fitzroy",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      highlightedName: false,
      premiumBadge: null,
      promoted: false,
      featuredSpecialEligible: false,
      active: true,
      now: NOW,
    });
    await getBillingCheckoutRepository(repository).claimBillingCheckoutReservation({
      actorAccountId: manager.id,
      subjectType: "venue",
      subjectId: venueId,
      productKey: "venue:pro:trial:60",
      reservationToken: "uncertain-trial-reservation",
      expiresAt: new Date(Date.parse(NOW) - 1_000).toISOString(),
      now: new Date(Date.parse(NOW) - 36 * 60 * 1_000).toISOString(),
    });

    const originalFetch = globalThis.fetch;
    try {
      const stripeFetch = vi.fn();
      globalThis.fetch = stripeFetch as typeof fetch;
      await expect(service.createBarTierCheckout(
        repository.getAccountById(manager.id)!,
        venueId,
        { tier: "pro" },
      )).rejects.toMatchObject({
        statusCode: 409,
        details: { publicCode: "VENUE_TRIAL_RECONCILIATION_REQUIRED" },
        message: expect.stringContaining("No second trial was created"),
      });
      expect(stripeFetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("converts an expired venue trial to paid Checkout without granting a second trial", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRO_PRICE_ID: "price_test_venue_pro",
    });
    const admin = createAccount(repository, "expired-trial-admin", "admin");
    const manager = createAccount(repository, "expired-trial-manager");
    const venueId = "expired-trial-venue";

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId,
      venueName: "Expired Trial Hotel",
      suburb: "Carlton",
    });
    await service.upsertBarProfile(admin, venueId, {
      name: "Expired Trial Hotel",
      address: null,
      suburb: "Carlton",
      area: "Carlton",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      acceptsPintPathCodes: false,
      active: true,
    });
    database.prepare(
      `UPDATE venue_profiles
       SET stripe_customer_id = ?,
           stripe_subscription_id = ?,
           subscription_status = ?
       WHERE venue_id = ?`,
    ).run("cus_expired_trial", "sub_expired_trial", "canceled", venueId);

    const originalFetch = globalThis.fetch;
    let checkoutRequestBody = "";
    try {
      globalThis.fetch = vi.fn(async (url, init) => {
        expect(String(url)).toBe("https://api.stripe.com/v1/checkout/sessions");
        checkoutRequestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({
          id: "cs_paid_after_trial",
          url: "https://checkout.stripe.com/c/pay/cs_paid_after_trial",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      await expect(service.createBarTierCheckout(
        repository.getAccountById(manager.id)!,
        venueId,
        { tier: "pro" },
      )).resolves.toMatchObject({
        mode: "stripe",
        message: "Stripe checkout created for this venue tier.",
      });

      const checkoutParams = new URLSearchParams(checkoutRequestBody);
      expect(checkoutParams.get("customer")).toBe("cus_expired_trial");
      expect(checkoutParams.has("customer_email")).toBe(false);
      expect(checkoutParams.has("subscription_data[trial_period_days]")).toBe(false);
      expect(checkoutParams.has("payment_method_collection")).toBe(false);
      expect(checkoutParams.has("subscription_data[trial_settings][end_behavior][missing_payment_method]")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not grant a second venue trial after historical Stripe identifiers are cleared", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRO_PRICE_ID: "price_test_venue_pro",
    });
    const admin = createAccount(repository, "historical-trial-admin", "admin");
    const manager = createAccount(repository, "historical-trial-manager");
    const venueId = "historical-trial-venue";

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId,
      venueName: "Historical Trial Hotel",
      suburb: "Fitzroy",
    });
    await service.upsertBarProfile(admin, venueId, {
      name: "Historical Trial Hotel",
      address: null,
      suburb: "Fitzroy",
      area: "Fitzroy",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      acceptsPintPathCodes: false,
      active: true,
    });
    database.prepare(
      `UPDATE venue_profiles
       SET intro_trial_ever_claimed = 1,
           stripe_customer_id = NULL,
           stripe_subscription_id = NULL,
           subscription_status = 'canceled'
       WHERE venue_id = ?`,
    ).run(venueId);

    const originalFetch = globalThis.fetch;
    let checkoutRequestBody = "";
    try {
      globalThis.fetch = vi.fn(async (_url, init) => {
        checkoutRequestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({
          id: "cs_historical_trial",
          url: "https://checkout.stripe.com/c/pay/cs_historical_trial",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      await service.createBarTierCheckout(
        repository.getAccountById(manager.id)!,
        venueId,
        { tier: "pro" },
      );

      const checkoutParams = new URLSearchParams(checkoutRequestBody);
      expect(checkoutParams.has("subscription_data[trial_period_days]")).toBe(false);
      expect(checkoutParams.has("payment_method_collection")).toBe(false);
      expect(checkoutParams.has("subscription_data[trial_settings][end_behavior][missing_payment_method]")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("enforces one introductory trial and one Checkout reservation across a physical venue identity", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRO_PRICE_ID: "price_test_venue_pro",
    });
    const admin = createAccount(repository, "aliased-trial-admin", "admin");
    const manager = createAccount(repository, "aliased-trial-manager");
    const canonicalVenueId = "aliased-trial-canonical";
    const duplicateVenueId = "aliased-trial-duplicate";

    for (const venueId of [canonicalVenueId, duplicateVenueId]) {
      await service.upsertBarProfile(admin, venueId, {
        name: "One Physical Hotel",
        address: null,
        suburb: "Richmond",
        area: "Richmond",
        phone: null,
        website: null,
        instagram: null,
        description: null,
        openingHours: {},
        venueTags: [],
        membershipTier: "basic",
        acceptsPintPathCodes: false,
        active: true,
      });
    }
    await getVenueIdentityRepository(repository).upsertVenueIdentityAlias({
      aliasVenueId: duplicateVenueId,
      canonicalVenueId,
      identityKey: "one physical hotel|richmond",
      expectedUpdatedAt: null,
      now: NOW,
    });
    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: duplicateVenueId,
      venueName: "One Physical Hotel",
      suburb: "Richmond",
    });
    database.prepare(
      "UPDATE venue_profiles SET intro_trial_ever_claimed = 1 WHERE venue_id = ?",
    ).run(canonicalVenueId);

    const originalFetch = globalThis.fetch;
    let checkoutRequestBody = "";
    try {
      globalThis.fetch = vi.fn(async (_url, init) => {
        checkoutRequestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({
          id: "cs_aliased_physical_venue",
          url: "https://checkout.stripe.com/c/pay/cs_aliased_physical_venue",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      await service.createBarTierCheckout(
        repository.getAccountById(manager.id)!,
        duplicateVenueId,
        { tier: "pro" },
      );

      const checkoutParams = new URLSearchParams(checkoutRequestBody);
      expect(checkoutParams.has("subscription_data[trial_period_days]")).toBe(false);
      expect(database.prepare(
        `SELECT subject_id AS subjectId
         FROM billing_checkout_reservations
         WHERE subject_type = 'venue'`,
      ).get()).toEqual({ subjectId: canonicalVenueId });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses an existing consumer Stripe customer for a deliberate paid resubscription", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRICE_MONTHLY: "price_test_monthly",
    });
    const account = repository.updateSubscription({
      userId: createAccount(repository, "consumer-resubscribe").id,
      subscriptionStatus: "free",
      stripePaidSubscriptionStatus: null,
      stripeCustomerId: "cus_consumer_resubscribe",
      premiumUntil: null,
      now: NOW,
    });

    const originalFetch = globalThis.fetch;
    let checkoutRequestBody = "";
    try {
      globalThis.fetch = vi.fn(async (url, init) => {
        expect(String(url)).toBe("https://api.stripe.com/v1/checkout/sessions");
        checkoutRequestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_consumer_resubscribe" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      await expect(service.createCheckout(account, { plan: "monthly" })).resolves.toMatchObject({
        mode: "stripe",
      });

      const checkoutParams = new URLSearchParams(checkoutRequestBody);
      expect(checkoutParams.get("customer")).toBe("cus_consumer_resubscribe");
      expect(checkoutParams.has("customer_email")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("can require a payment method for a controlled 30-day venue Pro trial", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_SECRET_KEY: "sk_test_xxx",
      STRIPE_PRO_PRICE_ID: "price_test_venue_pro",
      VENUE_PRO_TRIAL_DAYS: 30,
      VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD: true,
    });
    const admin = createAccount(repository, "bar-card-trial-admin", "admin");
    const manager = createAccount(repository, "bar-card-trial-manager");

    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "bar-card-trial-venue",
      venueName: "Card Trial Hotel",
      suburb: "Richmond",
    });

    const originalFetch = globalThis.fetch;
    let checkoutRequestBody = "";
    try {
      globalThis.fetch = vi.fn(async (_url, init) => {
        checkoutRequestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({
          id: "cs_test_card_trial",
          url: "https://checkout.stripe.com/c/pay/cs_test_card_trial",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      await service.createBarTierCheckout(
        repository.getAccountById(manager.id)!,
        "bar-card-trial-venue",
        { tier: "pro" },
      );

      const checkoutParams = new URLSearchParams(checkoutRequestBody);
      expect(checkoutParams.get("subscription_data[trial_period_days]")).toBe("30");
      expect(checkoutParams.get("payment_method_collection")).toBe("always");
      expect(checkoutParams.has("subscription_data[trial_settings][end_behavior][missing_payment_method]")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves dedicated verification timestamps and exposes durable report/reconciliation settings", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "integrity-settings-admin", "admin");
    const manager = createAccount(repository, "integrity-settings-manager");
    repository.updateAccountSecurityClaims({ userId: manager.id, emailVerifiedAt: NOW, now: NOW });
    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "integrity-settings-venue",
      venueName: "Integrity Hotel",
      suburb: "Fitzroy",
    });
    await service.upsertBarProfile(admin, "integrity-settings-venue", {
      name: "Integrity Hotel",
      address: null,
      suburb: "Fitzroy",
      area: "Fitzroy",
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "pro",
      acceptsPintPathCodes: true,
      active: true,
    });
    const managerAccount = repository.getAccountById(manager.id)!;
    const created = (await service.upsertBarBeer(managerAccount, "integrity-settings-venue", {
      id: null,
      beerName: "Carlton Draught",
      brewery: null,
      style: "Lager",
      abv: 4.6,
      serveSize: "pint",
      price: 13,
      onTap: true,
      inStock: true,
      notes: "Main tap",
      priceConfirmed: true,
      stockConfirmed: true,
    })).beer;
    const noteOnly = (await service.upsertBarBeer(managerAccount, "integrity-settings-venue", {
      id: created.id,
      beerName: created.beerName,
      brewery: created.brewery,
      style: created.style,
      abv: created.abv,
      serveSize: created.serveSize,
      price: created.price,
      onTap: created.onTap,
      inStock: created.inStock,
      notes: "Updated note",
      expectedUpdatedAt: created.updatedAt,
    })).beer;
    expect(noteOnly.priceVerifiedAt).toBe(created.priceVerifiedAt);
    expect(noteOnly.stockVerifiedAt).toBe(created.stockVerifiedAt);
    const changedPrice = (await service.upsertBarBeer(managerAccount, "integrity-settings-venue", {
      id: noteOnly.id,
      beerName: noteOnly.beerName,
      brewery: noteOnly.brewery,
      style: noteOnly.style,
      abv: noteOnly.abv,
      serveSize: noteOnly.serveSize,
      price: 14,
      onTap: noteOnly.onTap,
      inStock: noteOnly.inStock,
      notes: noteOnly.notes,
      expectedUpdatedAt: noteOnly.updatedAt,
    })).beer;
    expect(changedPrice.priceVerifiedAt).toBeNull();
    expect(changedPrice.stockVerifiedAt).toBe(created.stockVerifiedAt);

    const settings = await service.updateVenueReportDeliverySettings(managerAccount, "integrity-settings-venue", {
      enabled: true,
      recipients: [managerAccount.email],
    });
    expect(settings).toEqual(expect.objectContaining({
      recipients: [managerAccount.email],
      effectiveRecipients: [managerAccount.email],
      recipientMode: "custom",
    }));
    expect(await service.getVenueReconciliation(managerAccount, "integrity-settings-venue", { limit: 25, offset: 0 }))
      .toEqual(expect.objectContaining({
        discountRedemptions: expect.objectContaining({ total: 0, hasMore: false }),
        pintPointActivity: expect.objectContaining({ total: 0, hasMore: false }),
      }));
  });

  it("removes rejected pending catalogue names from immediately managed venue inventory", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "catalog-integrity-admin", "admin");
    const manager = createAccount(repository, "catalog-integrity-manager");
    await service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "catalog-integrity-venue",
      venueName: "Catalogue Hotel",
      suburb: "Richmond",
    });
    const managerAccount = repository.getAccountById(manager.id)!;
    await service.upsertBarBeer(managerAccount, "catalog-integrity-venue", {
      id: null,
      beerName: "Website Navigation Lager",
      brewery: null,
      style: null,
      abv: null,
      serveSize: "pint",
      price: 12,
      onTap: true,
      inStock: true,
      notes: null,
    });
    const pending = (await service.getAdminBeerCatalog(admin)).pending
      .find((item) => item.name === "Website Navigation Lager");
    expect(pending).toBeTruthy();
    await service.rejectBeerCatalogItem(admin, pending!.key, {
      reviewNote: "Navigation copy, not a real beer.",
    });
    expect(await venueInventoryRepositories.get(repository)!.listBarBeers("catalog-integrity-venue"))
      .toEqual([]);
  });
});
