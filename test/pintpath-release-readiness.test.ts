import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

import BetterSqlite3 from "better-sqlite3";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BusinessRepository, type BusinessAccount } from "../src/db/business.repository.js";
import { AccountSessionRepository } from "../src/db/account-session.repository.js";
import { AccountProfilePreferencesRepository } from "../src/db/account-profile-preferences.repository.js";
import { AccountDeletionQueueRepository } from "../src/db/account-deletion-queue.repository.js";
import { AccountPrivacyRepository } from "../src/db/account-privacy.repository.js";
import { PrivacyRetentionRepository } from "../src/db/privacy-retention.repository.js";
import { CommunitySubmissionRepository } from "../src/db/community-submission.repository.js";
import { VenueManagerInternalSubmissionRepository } from "../src/db/venue-manager-internal-submission.repository.js";
import { SourceEvidenceObjectRepository } from "../src/db/source-evidence-object.repository.js";
import { SourceEvidenceRetentionRepository } from "../src/db/source-evidence-retention.repository.js";
import { VenuePendingChangeRepository } from "../src/db/venue-pending-change.repository.js";
import { VenueDataReadRepository } from "../src/db/venue-data-read.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { PublicVenueDirectoryRepository } from "../src/db/public-venue-directory.repository.js";
import { PublicPriceRepository } from "../src/db/public-price.repository.js";
import { asAsyncSqliteDatabase } from "../src/db/sql-database.js";
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
import { errorHandler } from "../src/middleware/error-handler.js";
import { createBusinessRouter } from "../src/modules/business/business.routes.js";
import { BusinessService } from "../src/modules/business/business.service.js";
import { createSqliteAccountDeletionSecretPhysicalCheckpoint } from "../src/lib/account-deletion-secret-checkpoint.js";

const NOW = "2026-05-21T09:00:00.000Z";
const PASSWORD = "release-pass-123";
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]).toString("base64")}`;

type Harness = {
  database: BetterSqlite3.Database;
  repository: BusinessRepository;
  activityAuditRepository: ActivityAuditRepository;
  venueAccessRepository: VenueAccessRepository;
  service: BusinessService;
  app: express.Express;
};

const openDatabases: BetterSqlite3.Database[] = [];
const evidenceStorageDirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
  while (evidenceStorageDirs.length > 0) {
    fs.rmSync(evidenceStorageDirs.pop()!, { recursive: true, force: true });
  }
});

function createHarness(overrides: Partial<ConstructorParameters<typeof BusinessService>[1]> = {}): Harness {
  const database = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(database);
  openDatabases.push(database);
  const evidenceStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-release-evidence-"));
  evidenceStorageDirs.push(evidenceStorageDir);

  const repository = new BusinessRepository(database);
  const sqlDatabase = asAsyncSqliteDatabase(database);
  const activityAuditRepository = new ActivityAuditRepository(sqlDatabase);
  const venueAccessRepository = new VenueAccessRepository(sqlDatabase);
  const service = new BusinessService(repository, {
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
    ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: false,
    SOURCE_EVIDENCE_STORAGE_DIR: evidenceStorageDir,
    SOURCE_EVIDENCE_SIGNING_SECRET: "release-readiness-source-evidence-secret",
    SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS: 300,
    POS_WEBHOOK_SIGNING_SECRET: "release-readiness-pos-webhook-secret",
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
    ADMIN_EMAILS: "admin@pintpath.test",
    GOOGLE_MAPS_API_KEY: undefined,
    GOOGLE_PLACES_API_KEY: undefined,
    ...overrides,
  }, new PublicVenueDirectoryRepository(sqlDatabase), new PublicPriceRepository(sqlDatabase), new SystemStateRepository(sqlDatabase), activityAuditRepository, new SupportFeedbackRepository(sqlDatabase), new AccountSessionRepository(sqlDatabase), new AccountProfilePreferencesRepository(sqlDatabase), new VenueInventoryRepository(sqlDatabase), new VenueIdentityRepository(sqlDatabase), new BillingCheckoutRepository(sqlDatabase), venueAccessRepository, new MissionLifecycleRepository(sqlDatabase), new MissionDiscoveryAutomationRepository(sqlDatabase), new StripeSubscriptionRepository(sqlDatabase), new VenueRequestRepository(sqlDatabase), new VenuePartnerRepository(sqlDatabase), new AdminAnalyticsRepository(sqlDatabase), new VenueManagerInsightsRepository(sqlDatabase), new AdminAccountRepository(sqlDatabase), new AccountDeletionQueueRepository(sqlDatabase), new AccountPrivacyRepository(sqlDatabase), new PrivacyRetentionRepository(sqlDatabase), new CommunitySubmissionRepository(sqlDatabase), new VenueManagerInternalSubmissionRepository(sqlDatabase), new SourceEvidenceObjectRepository(sqlDatabase), new SourceEvidenceRetentionRepository(sqlDatabase), new VenuePendingChangeRepository(sqlDatabase), new VenueDataReadRepository(sqlDatabase), createSqliteAccountDeletionSecretPhysicalCheckpoint(database));

  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use("/api/business", createBusinessRouter(service));
  app.use(errorHandler);

  return { database, repository, activityAuditRepository, venueAccessRepository, service, app };
}

async function withHttpServer(app: express.Express, callback: (baseUrl: string) => Promise<void>) {
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

async function requestJson(
  baseUrl: string,
  pathName: string,
  input: {
    method?: string;
    token?: string | undefined;
    body?: unknown;
  } = {},
) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: input.method ?? "GET",
    headers: {
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const json = await response.json().catch(() => null);
  return { response, json: json as { ok: boolean; data?: unknown; error?: { message: string } } | null };
}

async function signup(
  harness: Harness,
  email: string,
  input: { ageConfirmed?: boolean | undefined; termsAccepted?: boolean | undefined; privacyAccepted?: boolean | undefined } = {},
): Promise<{ token: string; account: BusinessAccount }> {
  const session = await harness.service.signup({
    email,
    password: PASSWORD,
    ageConfirmed: input.ageConfirmed ?? true,
    termsAccepted: input.termsAccepted ?? true,
    privacyAccepted: input.privacyAccepted ?? true,
  });
  if (email.trim().toLowerCase() === "admin@pintpath.test") {
    harness.database
      .prepare("UPDATE accounts SET role = 'admin', subscription_status = 'admin', updated_at = ? WHERE id = ?")
      .run(NOW, session.account.id);
    harness.database
      .prepare("UPDATE profiles SET role = 'admin', updated_at = ? WHERE id = ?")
      .run(NOW, session.account.id);
  }
  return {
    token: session.token,
    account: harness.repository.getAccountById(session.account.id)!,
  };
}

function validSubmission(overrides: Record<string, unknown> = {}) {
  return {
    venueId: "venue-half-moon",
    venueName: "Half Moon",
    suburb: "Brighton",
    submissionType: "single_beer_price",
    observedAt: NOW,
    sourcePhotoDataUrl: null,
    sourcePhotoUrl: null,
    notes: "Synthetic release-readiness submission.",
    items: [
      {
        beerName: "Guinness",
        servingSize: "pint",
        price: 13,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
      },
    ],
    ...overrides,
  };
}

function venueProfileInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Half Moon",
    address: "120 Church St",
    suburb: "Brighton",
    area: "Brighton",
    phone: null,
    website: "https://halfmoon.example",
    instagram: null,
    description: "Synthetic venue profile.",
    openingHours: {},
    venueTags: ["pub", "happy hour"],
    membershipTier: "basic",
    active: true,
    ...overrides,
  };
}

async function recordSearchEvents(
  repository: ActivityAuditRepository,
  input: { count: number; beerId: string; suburb: string; prefix: string },
): Promise<void> {
  for (let index = 0; index < input.count; index += 1) {
    await repository.recordEvent({
      id: `${input.prefix}:${index}`,
      userId: null,
      anonymousSessionId: `anon:${input.prefix}:${index}`,
      eventType: "beer_search_performed",
      venueId: null,
      beerId: input.beerId,
      suburb: input.suburb,
      metadata: { query: input.beerId, synthetic: true },
      createdAt: NOW,
    });
  }
}

describe("Pint Path release-readiness security gates", () => {
  it("requires login for uploads and prevents submission ownership/verification bypasses", async () => {
    const harness = createHarness();
    const uploader = await signup(harness, "uploader@pintpath.test");
    const verifier = await signup(harness, "verifier@pintpath.test");

    await withHttpServer(harness.app, async (baseUrl) => {
      const anonymousUpload = await requestJson(baseUrl, "/api/business/submissions", {
        method: "POST",
        body: validSubmission(),
      });
      expect(anonymousUpload.response.status).toBe(401);

      const created = await requestJson(baseUrl, "/api/business/submissions", {
        method: "POST",
        token: uploader.token,
        body: validSubmission(),
      });
      expect(created.response.status).toBe(201);
      const submission = (created.json?.data as { submission: { id: string; userId: string } }).submission;
      expect(submission.userId).toBe(uploader.account.id);

      const otherQueue = await requestJson(baseUrl, "/api/business/submissions", {
        token: verifier.token,
      });
      expect(otherQueue.response.status).toBe(200);
      expect((otherQueue.json?.data as { submissions: unknown[] }).submissions).toEqual([]);

      const selfVerify = await requestJson(baseUrl, `/api/business/submissions/${submission.id}/verifications`, {
        method: "POST",
        token: uploader.token,
        body: { result: "confirmed", notes: null },
      });
      expect(selfVerify.response.status).toBe(403);

      const verified = await requestJson(baseUrl, `/api/business/submissions/${submission.id}/verifications`, {
        method: "POST",
        token: verifier.token,
        body: { result: "confirmed", notes: "Looks accurate." },
      });
      expect(verified.response.status).toBe(201);
      expect((verified.json?.data as { verification: { verifierUserId: string; uploadId: string } }).verification)
        .toMatchObject({ verifierUserId: verifier.account.id, uploadId: submission.id });

      const dashboard = await requestJson(baseUrl, "/api/business/account", {
        token: uploader.token,
      });
      expect(dashboard.response.status).toBe(200);
      expect((dashboard.json?.data as { dashboardStats: { totalUploads: number; pendingVerificationCount: number } }).dashboardStats)
        .toMatchObject({ totalUploads: 1, pendingVerificationCount: 1 });
    });
  });

  it("runs a dummy upload-to-publication journey through admin and community approval", async () => {
    const harness = createHarness();
    const uploader = await signup(harness, "dummy-uploader@pintpath.test");
    const admin = await signup(harness, "admin@pintpath.test");
    const verifierOne = await signup(harness, "dummy-verifier-one@pintpath.test");
    const verifierTwo = await signup(harness, "dummy-verifier-two@pintpath.test");

    await withHttpServer(harness.app, async (baseUrl) => {
      const photoUpload = await requestJson(baseUrl, "/api/business/submissions", {
        method: "POST",
        token: uploader.token,
        body: validSubmission({
          clientSubmissionId: "dummy-photo-upload-1",
          venueId: "dummy-admin-venue",
          venueName: "Dummy Admin Approval Bar",
          suburb: "Richmond",
          submissionType: "photo_upload",
          sourcePhotoDataUrl: PNG_DATA_URL,
          sourcePhotoUrl: null,
          items: [],
        }),
      });
      expect(photoUpload.response.status).toBe(201);
      expect((photoUpload.json?.data as { ocrStatus: string; submission: { status: string; sourcePhotoUrl: string } }))
        .toMatchObject({
          ocrStatus: "manual_review_required",
          submission: {
            status: "pending",
            sourcePhotoUrl: expect.stringMatching(/^private:evidence:/),
          },
        });

      const manualUpload = await requestJson(baseUrl, "/api/business/submissions", {
        method: "POST",
        token: uploader.token,
        body: validSubmission({
          clientSubmissionId: "dummy-admin-beer-1",
          venueId: "dummy-admin-venue",
          venueName: "Dummy Admin Approval Bar",
          suburb: "Richmond",
          sourcePhotoDataUrl: PNG_DATA_URL,
          items: [{
            beerName: "Carlton Draught",
            servingSize: "pint",
            price: 12,
            isHappyHourPrice: false,
            happyHourDetails: null,
            isOnTap: "yes",
          }],
        }),
      });
      expect(manualUpload.response.status).toBe(201);
      const manualSubmission = (manualUpload.json?.data as { submission: { id: string; status: string } }).submission;
      expect(manualSubmission.status).toBe("pending");

      const pendingBeforeAdmin = await requestJson(baseUrl, "/api/business/submissions?status=pending&includeReviewData=true", {
        token: admin.token,
      });
      expect(pendingBeforeAdmin.response.status).toBe(200);
      expect((pendingBeforeAdmin.json?.data as { submissions: Array<{ id: string }> }).submissions.map((submission) => submission.id))
        .toEqual(expect.arrayContaining([manualSubmission.id]));

      const hiddenBeforeApproval = await requestJson(
        baseUrl,
        "/api/business/price-records?venueId=dummy-admin-venue&anonymousSessionId=dummy-before-admin",
        { token: admin.token },
      );
      expect(hiddenBeforeApproval.response.status).toBe(200);
      expect((hiddenBeforeApproval.json?.data as { records: Array<{ beerName: string }> }).records)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ beerName: "Carlton Draught" })]));

      const adminReview = await requestJson(baseUrl, `/api/business/submissions/${manualSubmission.id}/review`, {
        method: "POST",
        token: admin.token,
        body: {
          status: "approved",
          rejectionReason: null,
          fraudFlagged: false,
          pointsAwarded: 5,
          confidence: "photo_verified",
        },
      });
      expect(adminReview.response.status).toBe(200);
      expect((adminReview.json?.data as { submission: { status: string }; pointsAwarded: number }))
        .toMatchObject({ submission: { status: "approved" }, pointsAwarded: 0 });

      const publishedAfterAdmin = await requestJson(
        baseUrl,
        "/api/business/price-records?venueId=dummy-admin-venue&anonymousSessionId=dummy-after-admin",
        { token: admin.token },
      );
      expect(publishedAfterAdmin.response.status).toBe(200);
      expect((publishedAfterAdmin.json?.data as { records: Array<{ beerName: string; price: number; confidence: string; sourceSubmissionId: string }> }).records)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            beerName: "Carlton Draught",
            price: 12,
            confidence: "photo_verified",
            sourceSubmissionId: manualSubmission.id,
          }),
        ]));

      const communityUpload = await requestJson(baseUrl, "/api/business/submissions", {
        method: "POST",
        token: uploader.token,
        body: validSubmission({
          clientSubmissionId: "dummy-community-beer-1",
          venueId: "dummy-community-venue",
          venueName: "Dummy Community Bar",
          suburb: "Fitzroy",
          items: [{
            beerName: "Guinness",
            servingSize: "pint",
            price: 13,
            isHappyHourPrice: false,
            happyHourDetails: null,
            isOnTap: "yes",
          }],
        }),
      });
      expect(communityUpload.response.status).toBe(201);
      const communitySubmission = (communityUpload.json?.data as { submission: { id: string; status: string } }).submission;
      expect(communitySubmission.status).toBe("pending");

      const communityHiddenBeforeConsensus = await requestJson(
        baseUrl,
        "/api/business/price-records?venueId=dummy-community-venue&anonymousSessionId=dummy-before-community",
        { token: admin.token },
      );
      expect((communityHiddenBeforeConsensus.json?.data as { records: Array<{ beerName: string }> }).records)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ beerName: "Guinness" })]));

      const firstVerification = await requestJson(baseUrl, `/api/business/submissions/${communitySubmission.id}/verifications`, {
        method: "POST",
        token: verifierOne.token,
        body: { result: "confirmed", notes: "Dummy first verifier saw the menu." },
      });
      expect(firstVerification.response.status).toBe(201);
      expect((firstVerification.json?.data as { autoApproved: boolean }).autoApproved).toBe(false);

      const stillHiddenAfterOne = await requestJson(
        baseUrl,
        "/api/business/price-records?venueId=dummy-community-venue&anonymousSessionId=dummy-after-one",
        { token: admin.token },
      );
      expect((stillHiddenAfterOne.json?.data as { records: Array<{ beerName: string }> }).records)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ beerName: "Guinness" })]));

      const secondVerification = await requestJson(baseUrl, `/api/business/submissions/${communitySubmission.id}/verifications`, {
        method: "POST",
        token: verifierTwo.token,
        body: { result: "confirmed", notes: "Dummy second verifier saw the same price." },
      });
      expect(secondVerification.response.status).toBe(201);
      expect((secondVerification.json?.data as { autoApproved: boolean; confirmedCount: number; message: string })).toMatchObject({
        autoApproved: false,
        confirmedCount: 2,
        message: "Verification saved for admin review. Community confirmations never publish a price automatically.",
      });

      const adminPublication = await requestJson(baseUrl, `/api/business/submissions/${communitySubmission.id}/review`, {
        method: "POST",
        token: admin.token,
        body: {
          status: "approved",
          rejectionReason: null,
          fraudFlagged: false,
          confidence: "community_confirmed",
        },
      });
      expect(adminPublication.response.status).toBe(200);

      const publishedByCommunity = await requestJson(
        baseUrl,
        "/api/business/price-records?venueId=dummy-community-venue&anonymousSessionId=dummy-community-live",
        { token: admin.token },
      );
      expect(publishedByCommunity.response.status).toBe(200);
      expect((publishedByCommunity.json?.data as { records: Array<{ beerName: string; price: number; confidence: string; sourceSubmissionId: string }> }).records)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            beerName: "Guinness",
            price: 13,
            confidence: "community_confirmed",
            sourceSubmissionId: communitySubmission.id,
          }),
        ]));

      const uploaderDashboard = await requestJson(baseUrl, "/api/business/account", { token: uploader.token });
      expect(uploaderDashboard.response.status).toBe(200);
      expect((uploaderDashboard.json?.data as { dashboardStats: { totalUploads: number; verifiedCount: number; pendingVerificationCount: number } }).dashboardStats)
        .toMatchObject({
          totalUploads: 3,
          verifiedCount: 2,
          pendingVerificationCount: 1,
        });
    });
  });

  it("keeps admin and analytics APIs protected from anonymous and normal users", async () => {
    const harness = createHarness();
    const user = await signup(harness, "normal@pintpath.test");
    const admin = await signup(harness, "admin@pintpath.test");

    await withHttpServer(harness.app, async (baseUrl) => {
      const anonymous = await requestJson(baseUrl, "/api/business/admin/kpis");
      expect(anonymous.response.status).toBe(401);

      const normal = await requestJson(baseUrl, "/api/business/admin/kpis", {
        token: user.token,
      });
      expect(normal.response.status).toBe(403);

      const preview = await requestJson(baseUrl, "/api/business/analytics/preview", {
        token: user.token,
      });
      expect(preview.response.status).toBe(403);

      const adminPreview = await requestJson(baseUrl, "/api/business/analytics/preview", {
        token: admin.token,
      });
      expect(adminPreview.response.status).toBe(200);
    });
  });

  it("awaits admin-account search and atomically contains suspended sessions over HTTP", async () => {
    const harness = createHarness();
    const user = await signup(harness, "admin-account-target@pintpath.test");
    const admin = await signup(harness, "admin@pintpath.test");
    const tokenHash = crypto.createHash("sha256").update(user.token).digest("hex");
    harness.repository.createDiscountPass({
      id: "admin-account-http-pass",
      userId: user.account.id,
      sessionTokenHash: tokenHash,
      codeHash: "admin-account-http-code-hash",
      createdAt: NOW,
      expiresAt: "2026-06-21T09:00:00.000Z",
    });

    await withHttpServer(harness.app, async (baseUrl) => {
      const unauthorized = await requestJson(
        baseUrl,
        "/api/business/admin/accounts?q=admin-account-target&limit=25",
        { token: user.token },
      );
      expect(unauthorized.response.status).toBe(403);

      const search = await requestJson(
        baseUrl,
        "/api/business/admin/accounts?q=admin-account-target&limit=25",
        { token: admin.token },
      );
      expect(search.response.status).toBe(200);
      expect((search.json?.data as { accounts: Array<{ id: string }> }).accounts)
        .toEqual([expect.objectContaining({ id: user.account.id })]);

      const suspended = await requestJson(
        baseUrl,
        `/api/business/admin/users/${encodeURIComponent(user.account.id)}/status`,
        {
          method: "POST",
          token: admin.token,
          body: {
            status: "suspended",
            reason: "Release-gate atomic containment regression.",
          },
        },
      );
      expect(suspended.response.status).toBe(200);
      expect(suspended.json?.data).toEqual(expect.objectContaining({
        account: expect.objectContaining({ id: user.account.id, status: "suspended" }),
      }));

      const containedSession = await requestJson(baseUrl, "/api/business/account", {
        token: user.token,
      });
      expect(containedSession.response.status).toBe(401);
    });

    expect(harness.database.prepare(
      `SELECT account.status, profile.account_status AS profile_status,
              session.revoked_at, pass.status AS pass_status, pass.revoked_at AS pass_revoked_at
         FROM accounts account
         JOIN profiles profile ON profile.id = account.id
         JOIN auth_sessions session ON session.user_id = account.id
         JOIN account_discount_passes pass ON pass.user_id = account.id
        WHERE account.id = ? AND session.token_hash = ?`,
    ).get(user.account.id, tokenHash)).toEqual({
      status: "suspended",
      profile_status: "suspended",
      revoked_at: "2026-05-21T09:00:00.001Z",
      pass_status: "revoked",
      pass_revoked_at: "2026-05-21T09:00:00.001Z",
    });
    expect((await harness.activityAuditRepository.listSecurityAuditLogs({
      action: "admin_user_status_override",
      limit: 10,
    })).items).toEqual([
      expect.objectContaining({ actorUserId: admin.account.id, targetId: user.account.id }),
    ]);
  });

  it("keeps source evidence private and rejects obvious SSRF source URLs", async () => {
    const harness = createHarness();
    const owner = await signup(harness, "evidence-owner@pintpath.test");
    const other = await signup(harness, "evidence-other@pintpath.test");

    await expect(harness.service.createSubmission(owner.account, validSubmission({
      sourcePhotoUrl: "http://127.0.0.1:8080/menu.jpg",
    }))).rejects.toThrow("local, private, or metadata network hosts");
    await expect(harness.service.createSubmission(owner.account, validSubmission({
      sourcePhotoUrl: "http://169.254.169.254/latest/meta-data/menu.jpg",
    }))).rejects.toThrow("local, private, or metadata network hosts");

    const result = await harness.service.createSubmission(owner.account, validSubmission({
      submissionType: "photo_upload",
      sourcePhotoDataUrl: PNG_DATA_URL,
      sourcePhotoUrl: null,
      items: [],
    }));
    expect(result.submission.sourcePhotoUrl).toMatch(/^private:evidence:/);

    await expect(harness.service.getSubmissionSourceEvidenceUrl(other.account, result.submission.id))
      .rejects.toThrow("own source evidence");

    const signed = await harness.service.getSubmissionSourceEvidenceUrl(owner.account, result.submission.id);
    expect(signed.signedUrl).toContain("/api/business/source-evidence/");

    await withHttpServer(harness.app, async (baseUrl) => {
      const evidenceId = new URL(signed.signedUrl!).pathname.split("/").pop()!;
      const unsigned = await fetch(`${baseUrl}/api/business/source-evidence/${evidenceId}`);
      expect(unsigned.status).toBe(403);
    });
  });
});

describe("Pint Path release-readiness venue-manager approval workflow", () => {
  it("serializes concurrent manager happy-hour intake without public or reward effects", async () => {
    const harness = createHarness({ COMMERCIAL_LAUNCH_ENABLED: false });
    const admin = await signup(harness, "admin@pintpath.test");
    const manager = await signup(harness, "internal-happy-hour-manager@pintpath.test");
    const venueId = "venue-internal-happy-hour";
    await harness.service.assignVenueManager(admin.account, {
      userId: manager.account.id,
      venueId,
      venueName: "Internal Happy Hour Hotel",
      suburb: "Richmond",
    });

    const payload = validSubmission({
      clientSubmissionId: "http-manager-happy-hour-1",
      venueId,
      venueName: "Internal Happy Hour Hotel",
      suburb: "Richmond",
      submissionType: "happy_hour_update",
      sourcePhotoDataUrl: PNG_DATA_URL,
      items: [{
        beerName: "Guinness",
        servingSize: "pint",
        price: 10,
        isHappyHourPrice: true,
        happyHourDetails: "Monday to Friday, 4pm-6pm",
        isOnTap: "yes",
      }],
    });

    await withHttpServer(harness.app, async (baseUrl) => {
      const responses = await Promise.all([
        requestJson(baseUrl, `/api/business/venue-portal/${venueId}/submissions`, {
          method: "POST",
          token: manager.token,
          body: payload,
        }),
        requestJson(baseUrl, `/api/business/venue-portal/${venueId}/submissions`, {
          method: "POST",
          token: manager.token,
          body: payload,
        }),
      ]);
      expect(responses.map(({ response }) => response.status)).toEqual([201, 201]);
      const results = responses.map(({ json }) => json?.data as {
        submission: { id: string; internalOnly: boolean; pointsAwarded: number };
        idempotentReplay?: boolean;
      });
      expect(new Set(results.map((result) => result.submission.id)).size).toBe(1);
      expect(results.map((result) => Boolean(result.idempotentReplay)).sort()).toEqual([false, true]);
      expect(results[0]?.submission).toEqual(expect.objectContaining({
        internalOnly: true,
        pointsAwarded: 0,
      }));

      const conflict = await requestJson(baseUrl, `/api/business/venue-portal/${venueId}/submissions`, {
        method: "POST",
        token: manager.token,
        body: {
          ...payload,
          items: [{ ...payload.items[0], price: 11 }],
        },
      });
      expect(conflict.response.status).toBe(409);
      expect(conflict.json?.error?.message).toBe("Internal venue submission state changed. Refresh and try again.");
    });

    const submissionId = (harness.database.prepare(
      "SELECT id FROM submissions WHERE user_id = ? AND client_submission_id = ?",
    ).get(manager.account.id, "http-manager-happy-hour-1") as { id: string }).id;
    expect(harness.database.prepare(
      "SELECT count(*) AS count FROM submissions WHERE id = ?",
    ).get(submissionId)).toEqual({ count: 1 });
    expect(harness.database.prepare(
      "SELECT count(*) AS count FROM submission_items WHERE submission_id = ?",
    ).get(submissionId)).toEqual({ count: 1 });
    expect(harness.database.prepare(
      "SELECT count(*) AS count FROM submission_source_evidence WHERE submission_id = ?",
    ).get(submissionId)).toEqual({ count: 1 });
    expect(harness.database.prepare(
      "SELECT count(*) AS count FROM source_evidence_objects WHERE owner_user_id = ? AND deleted_at IS NULL",
    ).get(manager.account.id)).toEqual({ count: 1 });
    expect(harness.database.prepare(
      "SELECT count(*) AS count FROM venue_price_records WHERE source_submission_id = ?",
    ).get(submissionId)).toEqual({ count: 0 });
    expect(harness.database.prepare(
      "SELECT count(*) AS count FROM venue_happy_hours WHERE venue_id = ?",
    ).get(venueId)).toEqual({ count: 0 });
    expect(harness.database.prepare(
      "SELECT count(*) AS count FROM contribution_ledger WHERE submission_id = ?",
    ).get(submissionId)).toEqual({ count: 0 });
  });

  it("keeps scoped manager access while publishing assigned venue edits directly", async () => {
    const harness = createHarness({ ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = (await signup(harness, "admin@pintpath.test")).account;
    const managerA = (await signup(harness, "manager-a@pintpath.test")).account;
    const managerB = (await signup(harness, "manager-b@pintpath.test")).account;

    await harness.service.assignVenueManager(admin, {
      userId: managerA.id,
      venueId: "venue-a",
      venueName: "Half Moon",
      suburb: "Brighton",
    });
    await harness.service.assignVenueManager(admin, {
      userId: managerB.id,
      venueId: "venue-b",
      venueName: "Neighbour Pub",
      suburb: "Fitzroy",
    });
    const updatedManagerA = harness.repository.getAccountById(managerA.id)!;
    const updatedManagerB = harness.repository.getAccountById(managerB.id)!;

    await harness.service.upsertBarProfile(admin, "venue-a", venueProfileInput({ membershipTier: "basic" }));
    const directBeer = await harness.service.upsertBarBeer(updatedManagerA, "venue-a", {
      id: null,
      beerName: "Asahi Super Dry",
      brewery: "Asahi",
      style: "Lager",
      abv: 5,
      serveSize: "pint",
      price: 12,
      onTap: true,
      inStock: true,
      notes: "Synthetic venue-manager edit.",
    }) as { beer: { id: string; beerName: string; price: number } };

    expect(directBeer.beer).toMatchObject({ beerName: "Asahi Super Dry", price: 12 });
    expect((await harness.service.listPriceRecords(null, {
      venueId: "venue-a",
      anonymousSessionId: "anon-release",
      limit: 20,
    })).records.some((record) => record.beerName === "Asahi Super Dry")).toBe(true);

    expect((await harness.service.getVenuePortal(updatedManagerA, { venueId: "venue-a" })).pendingChanges)
      .toHaveLength(0);
    await expect(harness.service.getVenuePortal(updatedManagerB, { venueId: "venue-a" }))
      .rejects.toThrow("assigned venues");

    const savedHappyHour = await harness.service.upsertBarHappyHour(updatedManagerA, "venue-a", {
      id: null,
      title: "Synthetic reviewed happy hour",
      daysOfWeek: ["fri"],
      startTime: "16:00",
      endTime: "18:00",
      description: "$10 selected pints.",
      active: true,
    }) as { happyHour: { id: string; title: string } };

    expect(savedHappyHour.happyHour).toMatchObject({ title: "Synthetic reviewed happy hour" });
    expect((await harness.service.getVenuePartnerAdmin(admin)).pendingChanges).toHaveLength(0);
    const publishedRecords = (await harness.service.listPriceRecords(admin, {
      venueId: "venue-a",
      anonymousSessionId: null,
      limit: 20,
    })).records;
    expect(publishedRecords.some((record) => record.beerName === "Asahi Super Dry" && record.price === 12))
      .toBe(true);

    await expect(harness.service.upsertBarSpecial(updatedManagerA, "venue-a", {
      id: null,
      title: "Synthetic rejected special",
      description: "Should not publish.",
      price: 8,
      discount: null,
      startsAt: null,
      endsAt: null,
      startTime: "17:00",
      endTime: "19:00",
      scheduleNote: null,
      exclusive: false,
      active: true,
    })).rejects.toThrow("Pro venue tier required");
    expect((await harness.service.getVenuePortal(updatedManagerA, { venueId: "venue-a" })).inventory.specials)
      .toEqual([]);

    const basicPortal = await harness.service.getVenuePortal(updatedManagerA, { venueId: "venue-a" });
    expect(basicPortal.tier?.analyticsLocked).toBe(true);
    expect(basicPortal.analytics).toBeNull();
  });

  it("exercises the authenticated owner portal HTTP journey with safe pending-review boundaries", async () => {
    const harness = createHarness({ ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = await signup(harness, "admin@pintpath.test");
    const owner = await signup(harness, "owner-journey@pintpath.test");
    const otherOwner = await signup(harness, "owner-journey-other@pintpath.test");

    await harness.service.assignVenueManager(admin.account, {
      userId: owner.account.id,
      venueId: "venue-owner-journey",
      venueName: "Owner Journey Bar",
      suburb: "Richmond",
    });
    await harness.service.assignVenueManager(admin.account, {
      userId: otherOwner.account.id,
      venueId: "venue-owner-other",
      venueName: "Other Owner Bar",
      suburb: "Carlton",
    });
    await harness.service.upsertBarProfile(admin.account, "venue-owner-journey", venueProfileInput({
      name: "Owner Journey Bar",
      suburb: "Richmond",
      area: "Richmond",
      membershipTier: "pro",
    }));

    await withHttpServer(harness.app, async (baseUrl) => {
      const loggedIn = await requestJson(baseUrl, "/api/business/auth/login", {
        method: "POST",
        body: { email: owner.account.email, password: PASSWORD },
      });
      expect(loggedIn.response.status).toBe(200);
      const ownerToken = (loggedIn.json?.data as { token: string }).token;

      const portal = await requestJson(baseUrl, "/api/business/venue-portal?venueId=venue-owner-journey", {
        token: ownerToken,
      });
      expect(portal.response.status).toBe(200);
      expect((portal.json?.data as { profile: { name: string }; tier: { analyticsLocked: boolean } }).profile.name)
        .toBe("Owner Journey Bar");
      expect((portal.json?.data as { tier: { analyticsLocked: boolean } }).tier.analyticsLocked).toBe(false);
      const profileUpdatedAt = (portal.json?.data as { profile: { updatedAt: string } }).profile.updatedAt;

      const profileUpdate = await requestJson(baseUrl, "/api/business/venue-portal/venue-owner-journey/profile", {
        method: "POST",
        token: ownerToken,
        body: venueProfileInput({
          name: "Owner Journey Bar",
          address: "1 Launch Lane",
          suburb: "Richmond",
          area: "Richmond",
          phone: "0399999999",
          website: "https://owner-journey.example",
          description: "Synthetic owner journey profile update.",
          membershipTier: "pro",
          expectedUpdatedAt: profileUpdatedAt,
        }),
      });
      expect(profileUpdate.response.status).toBe(200);
      expect((profileUpdate.json?.data as { profile: { name: string; membershipTier: string } }).profile)
        .toMatchObject({ name: "Owner Journey Bar", membershipTier: "pro" });

      const staleProfileUpdate = await requestJson(baseUrl, "/api/business/venue-portal/venue-owner-journey/profile", {
        method: "POST",
        token: ownerToken,
        body: venueProfileInput({
          name: "Stale Owner Journey Bar",
          suburb: "Richmond",
          area: "Richmond",
          membershipTier: "pro",
          expectedUpdatedAt: profileUpdatedAt,
        }),
      });
      expect(staleProfileUpdate.response.status).toBe(409);
      expect((staleProfileUpdate.json?.error as { message: string }).message)
        .toContain("changed in another session");

      const beerUpdate = await requestJson(baseUrl, "/api/business/venue-portal/venue-owner-journey/beers", {
        method: "POST",
        token: ownerToken,
        body: {
          id: null,
          beerName: "Carlton Draught",
          brewery: "Carlton & United Breweries",
          style: "Lager",
          abv: 4.6,
          serveSize: "pint",
          price: 12.5,
          onTap: true,
          inStock: true,
          notes: "Synthetic owner journey tap row.",
        },
      });
      expect(beerUpdate.response.status).toBe(201);
      const savedBeer = (beerUpdate.json?.data as { beer: { id: string; beerName: string; price: number } }).beer;
      expect(savedBeer)
        .toMatchObject({ beerName: "Carlton Draught", price: 12.5 });

      const happyHourUpdate = await requestJson(baseUrl, "/api/business/venue-portal/venue-owner-journey/happy-hours", {
        method: "POST",
        token: ownerToken,
        body: {
          id: null,
          title: "After-work pints",
          daysOfWeek: ["thu", "fri"],
          startTime: "17:00",
          endTime: "19:00",
          description: "$10 selected pints after work.",
          happyHourBeers: [{
            beerId: savedBeer.id,
            beerName: savedBeer.beerName,
            normalizedBeerId: "carlton_draught",
            servingSize: "pint",
            happyHourPrice: 10,
            offerText: "Selected pints",
            onTap: true,
            inStock: true,
          }],
          active: true,
        },
      });
      expect(happyHourUpdate.response.status).toBe(201);
      expect((happyHourUpdate.json?.data as { happyHour: { title: string; happyHourBeers: unknown } }).happyHour)
        .toEqual(expect.objectContaining({
          title: "After-work pints",
          happyHourBeers: expect.arrayContaining([
            expect.objectContaining({ beerName: "Carlton Draught", servingSize: "pint", happyHourPrice: 10, offerText: "Selected pints" }),
          ]),
        }));

      const specialUpdate = await requestJson(baseUrl, "/api/business/venue-portal/venue-owner-journey/specials", {
        method: "POST",
        token: ownerToken,
        body: {
          id: null,
          title: "Launch burger and pint",
          description: "Synthetic Pro venue special for launch QA.",
          price: 25,
          discount: null,
          startsAt: null,
          endsAt: null,
          startTime: "17:00",
          endTime: "20:00",
          scheduleNote: "Thursdays only",
          exclusive: false,
          active: true,
        },
      });
      expect(specialUpdate.response.status).toBe(201);
      expect((specialUpdate.json?.data as { special: { title: string } }).special.title).toBe("Launch burger and pint");

      const supportRequest = await requestJson(baseUrl, "/api/business/feedback", {
        method: "POST",
        token: ownerToken,
        body: {
          anonymousSessionId: null,
          feedbackType: "venue_partner_interest",
          venueId: "venue-owner-journey",
          venueName: "Owner Journey Bar",
          message: "Synthetic launch QA support request from the owner dashboard.",
        },
      });
      expect(supportRequest.response.status).toBe(201);
      expect((supportRequest.json?.data as { feedback: { priority: string } }).feedback.priority).toBe("medium");

      const crossOwnerPortal = await requestJson(baseUrl, "/api/business/venue-portal?venueId=venue-owner-journey", {
        token: otherOwner.token,
      });
      expect(crossOwnerPortal.response.status).toBe(403);

      const afterUpdates = await requestJson(baseUrl, "/api/business/venue-portal?venueId=venue-owner-journey", {
        token: ownerToken,
      });
      const pendingChanges = (afterUpdates.json?.data as { pendingChanges: Array<{ changeType: string }> }).pendingChanges;
      expect(pendingChanges).toEqual([]);
      expect((afterUpdates.json?.data as { inventory: { beers: Array<{ beerName: string; price: number }> } }).inventory.beers)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ beerName: "Carlton Draught", price: 12.5 }),
        ]));
      expect((afterUpdates.json?.data as { inventory: { specials: Array<{ title: string }> } }).inventory.specials)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ title: "Launch burger and pint" }),
        ]));
    });
  });
});

describe("Pint Path release-readiness analytics and report privacy", () => {
  it("fences account-preference HTTP writes while keeping first-time clients compatible", async () => {
    const harness = createHarness();
    const { token } = await signup(harness, "preference-occ@pintpath.test");

    await withHttpServer(harness.app, async (baseUrl) => {
      const first = await requestJson(baseUrl, "/api/business/account/preferences", {
        method: "POST",
        token,
        body: {
          preferredSuburbs: ["Fitzroy"],
          preferredBeers: ["Guinness"],
          preferredUseCases: ["specific_beers"],
          onboardingCompleted: true,
        },
      });
      expect(first.response.status).toBe(200);
      const firstPreferences = (first.json?.data as { preferences: { updatedAt: string } }).preferences;
      expect(firstPreferences.updatedAt).toBe(NOW);

      const omittedRevision = await requestJson(baseUrl, "/api/business/account/preferences", {
        method: "POST",
        token,
        body: {
          preferredSuburbs: ["Carlton"],
          preferredBeers: [],
          preferredUseCases: [],
          onboardingCompleted: true,
        },
      });
      expect(omittedRevision.response.status).toBe(409);
      expect(omittedRevision.json?.error?.message).toBe("Account settings changed. Refresh and try again.");

      const staleRevision = await requestJson(baseUrl, "/api/business/account/preferences", {
        method: "POST",
        token,
        body: {
          preferredSuburbs: ["Richmond"],
          preferredBeers: [],
          preferredUseCases: [],
          onboardingCompleted: true,
          expectedUpdatedAt: "2026-05-21T08:59:59.999Z",
        },
      });
      expect(staleRevision.response.status).toBe(409);

      const currentRevision = await requestJson(baseUrl, "/api/business/account/preferences", {
        method: "POST",
        token,
        body: {
          preferredSuburbs: ["Richmond"],
          preferredBeers: ["Carlton Draught"],
          preferredUseCases: ["recently_verified"],
          onboardingCompleted: true,
          expectedUpdatedAt: firstPreferences.updatedAt,
        },
      });
      expect(currentRevision.response.status).toBe(200);
      const updatedPreferences = (currentRevision.json?.data as { preferences: { updatedAt: string } }).preferences;
      expect(updatedPreferences.updatedAt).toBe("2026-05-21T09:00:00.001Z");

      const replayedRevision = await requestJson(baseUrl, "/api/business/account/preferences", {
        method: "POST",
        token,
        body: {
          preferredSuburbs: ["Brunswick"],
          preferredBeers: [],
          preferredUseCases: [],
          onboardingCompleted: true,
          expectedUpdatedAt: firstPreferences.updatedAt,
        },
      });
      expect(replayedRevision.response.status).toBe(409);
    });
  });

  it("suppresses low-count admin analytics buckets and redacts sensitive event metadata", async () => {
    const harness = createHarness({ ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = (await signup(harness, "admin@pintpath.test")).account;
    const user = (await signup(harness, "privacy-user@pintpath.test")).account;
    await harness.service.savePrivacySettings(user, {
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
      expectedUpdatedAt: null,
    });

    await recordSearchEvents(harness.activityAuditRepository, {
      count: 4,
      beerId: "rare-private-beer",
      suburb: "Carlton",
      prefix: "rare",
    });
    await recordSearchEvents(harness.activityAuditRepository, {
      count: 5,
      beerId: "guinness",
      suburb: "Fitzroy",
      prefix: "guinness",
    });
    await harness.service.trackEvent(user, {
      anonymousSessionId: null,
      eventType: "map_viewed",
      venueId: null,
      beerId: null,
      suburb: "Fitzroy",
      metadata: {
        query: "Guinness",
        email: "person@example.com",
        token: "secret-token",
        latitude: -37.8136,
        longitude: 144.9631,
      },
    });

    const preview = await harness.service.getAnalyticsPreview(admin);
    expect(preview.topSearchedBeers).toEqual([{ key: "guinness", count: 5 }]);
    expect(JSON.stringify(preview)).not.toContain("rare-private-beer");

    const eventRows = harness.database
      .prepare("SELECT metadata_json FROM events WHERE event_type = 'map_viewed'")
      .all() as Array<{ metadata_json: string }>;
    expect(eventRows).toHaveLength(1);
    const metadataJson = eventRows[0].metadata_json;
    expect(metadataJson).toContain("Guinness");
    expect(metadataJson).not.toContain("person@example.com");
    expect(metadataJson).not.toContain("secret-token");
    expect(metadataJson).not.toContain("latitude");
    expect(metadataJson).not.toContain("longitude");
  });

  it("gates venue analytics by tier and hides suburb trends until the privacy floor is met", async () => {
    const harness = createHarness({ ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = (await signup(harness, "admin@pintpath.test")).account;
    const manager = (await signup(harness, "pro-manager@pintpath.test")).account;

    await harness.service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "venue-pro",
      venueName: "Pro Venue",
      suburb: "Fitzroy",
    });
    await harness.service.upsertBarProfile(admin, "venue-pro", venueProfileInput({
      name: "Pro Venue",
      suburb: "Fitzroy",
      area: "Fitzroy",
      membershipTier: "pro",
    }));
    const updatedManager = harness.repository.getAccountById(manager.id)!;

    for (let index = 0; index < 9; index += 1) {
      await harness.activityAuditRepository.recordEvent({
        id: `below-floor:${index}`,
        userId: null,
        anonymousSessionId: `anon-floor:${index}`,
        eventType: "search_performed",
        venueId: null,
        beerId: null,
        suburb: "Fitzroy",
        metadata: { query: "lager" },
        createdAt: NOW,
      });
    }
    await harness.activityAuditRepository.recordEvent({
      id: "style-below-floor",
      userId: null,
      anonymousSessionId: "anon-floor:0",
      eventType: "style_search",
      venueId: null,
      beerId: null,
      suburb: "Fitzroy",
      metadata: { query: "lager", searchKind: "style" },
      createdAt: NOW,
    });

    const belowFloorPortal = await harness.service.getVenuePortal(updatedManager, { venueId: "venue-pro" });
    expect(belowFloorPortal.tier?.analyticsLocked).toBe(false);
    expect(belowFloorPortal.analytics?.privacyFloorMet).toBe(false);
    expect(belowFloorPortal.analytics?.areaStyleSearches).toEqual([]);
    expect(JSON.stringify(belowFloorPortal.analytics)).not.toContain("@");

    await harness.activityAuditRepository.recordEvent({
      id: "at-floor",
      userId: null,
      anonymousSessionId: "anon-floor:at",
      eventType: "search_performed",
      venueId: null,
      beerId: null,
      suburb: "Fitzroy",
      metadata: { query: "lager" },
      createdAt: NOW,
    });
    for (let index = 0; index < 10; index += 1) {
      await harness.activityAuditRepository.recordEvent({
        id: `style-at-floor:${index}`,
        userId: null,
        anonymousSessionId: `anon-floor:${index}`,
        eventType: "style_search",
        venueId: null,
        beerId: null,
        suburb: "Fitzroy",
        metadata: { query: "lager", searchKind: "style" },
        createdAt: NOW,
      });
    }

    const atFloorPortal = await harness.service.getVenuePortal(updatedManager, { venueId: "venue-pro" });
    expect(atFloorPortal.analytics?.privacyFloorMet).toBe(true);
    expect(atFloorPortal.monthlyReport?.data).toBeTruthy();
    expect(atFloorPortal.analytics?.areaStyleSearches).toEqual([{ key: "lager", count: 10 }]);
  });

  it("counts distinct venue actors, suppresses unsafe trend buckets, and never widens a missing area globally", async () => {
    const harness = createHarness({ ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const venueId = "venue-distinct-reporting";
    const suburb = "Fitzroy";
    const customerSession = "distinct-customer";
    const record = async (id: string, eventType: string, anonymousSessionId: string | null, metadata: Record<string, unknown> = {}) => {
      await harness.activityAuditRepository.recordEvent({
        id,
        userId: null,
        anonymousSessionId,
        eventType,
        venueId: eventType.includes("search") ? null : venueId,
        beerId: eventType === "beer_search_performed" ? "lager" : null,
        suburb,
        metadata,
        createdAt: NOW,
      });
    };

    await record("distinct-pin-1", "map_pin_click", customerSession);
    await record("distinct-pin-2", "map_pin_click", customerSession);
    await record("distinct-detail-1", "venue_detail_opened", customerSession);
    await record("distinct-detail-2", "venue_detail_opened", customerSession);
    await record("distinct-beer-list-1", "beer_list_viewed", customerSession);
    await record("distinct-beer-list-2", "beer_list_viewed", customerSession);
    await record("distinct-price", "free_preview_viewed", customerSession);
    await record("distinct-directions", "directions_clicked", customerSession);
    await record("distinct-directions-legacy", "venue_lookup", customerSession, { interactionType: "directions_click" });
    await record("distinct-share", "venue_shared", customerSession);
    await record("distinct-share-copy", "share_link_copied", customerSession);
    await record("owner-portal", "venue_portal_viewed", "venue-owner-session");
    await record("unknown-actor-pin", "map_pin_click", null);

    for (let index = 0; index < 12; index += 1) {
      await record(`repeat-beer-search:${index}`, "beer_search_performed", customerSession, { query: "lager" });
      await record(`repeat-style-search:${index}`, "style_search", customerSession, { query: "lager", searchKind: "style" });
    }
    for (let index = 0; index < 12; index += 1) {
      harness.repository.recordVenueAnalyticsEvent({
        id: `legacy-style-without-actor:${index}`,
        venueId: null,
        area: suburb,
        suburb,
        eventType: "beer_style_search",
        queryText: "private-style",
        beerName: null,
        beerStyle: "private-style",
        createdAt: NOW,
      });
    }

    const distinctCounts = harness.repository.getVenueAreaAnalytics({
      venueId,
      venueName: "Distinct Reporting Venue",
      area: suburb,
      month: "2026-05",
      privacyThreshold: 1,
    });
    expect(distinctCounts).toEqual(expect.objectContaining({
      barLookups: 1,
      profileViews: 1,
      beerListViews: 1,
      pricePreviewViews: 1,
      directionsClicks: 1,
      shares: 1,
    }));

    const belowFloor = harness.repository.getVenueAreaAnalytics({
      venueId,
      venueName: "Distinct Reporting Venue",
      area: suburb,
      month: "2026-05",
      privacyThreshold: 10,
    });
    expect(belowFloor).toEqual(expect.objectContaining({
      barLookups: 0,
      profileViews: 0,
      beerListViews: 0,
      pricePreviewViews: 0,
      directionsClicks: 0,
      shares: 0,
      areaSearches: 0,
      privacyFloorMet: false,
      areaBeerSearches: [],
      areaStyleSearches: [],
    }));
    expect(belowFloor.suppressedVenueMetrics).toEqual(expect.arrayContaining([
      "barLookups",
      "profileViews",
      "beerListViews",
      "pricePreviewViews",
      "directionsClicks",
      "shares",
    ]));

    for (let index = 1; index < 10; index += 1) {
      const actor = `distinct-area-actor:${index}`;
      await record(`distinct-area-beer:${index}`, "beer_search_performed", actor, { query: "lager" });
      await record(`distinct-area-style:${index}`, "style_search", actor, { query: "lager", searchKind: "style" });
    }

    const atFloor = harness.repository.getVenueAreaAnalytics({
      venueId,
      venueName: "Distinct Reporting Venue",
      area: suburb,
      month: "2026-05",
      privacyThreshold: 10,
    });
    expect(atFloor.areaSearches).toBe(10);
    expect(atFloor.areaBeerSearches).toEqual([{ key: "lager", count: 10 }]);
    expect(atFloor.areaStyleSearches).toEqual([{ key: "lager", count: 10 }]);
    expect(JSON.stringify(atFloor)).not.toContain("private-style");
    expect(atFloor.searchTimesByDay[0]?.count).toBe(10);
    expect(atFloor.searchTimesByHour[0]?.count).toBe(10);

    const missingArea = harness.repository.getVenueAreaAnalytics({
      venueId,
      venueName: "Distinct Reporting Venue",
      area: null,
      month: "2026-05",
      privacyThreshold: 10,
    });
    expect(missingArea.areaSearches).toBe(0);
    expect(missingArea.privacyFloorMet).toBe(false);
    expect(missingArea.areaBeerSearches).toEqual([]);
    expect(missingArea.areaStyleSearches).toEqual([]);
  });

  it("freezes saved reports, omits present-day operational snapshots, and refreshes regeneration timestamps", async () => {
    vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
    const harness = createHarness({ ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = await signup(harness, "admin@pintpath.test");
    const owner = await signup(harness, "historical-report-owner@pintpath.test");
    const venueId = "venue-historical-report";
    await harness.service.assignVenueManager(admin.account, {
      userId: owner.account.id,
      venueId,
      venueName: "Historical Report Venue",
      suburb: "Richmond",
    });
    await harness.service.upsertBarProfile(admin.account, venueId, venueProfileInput({
      name: "Historical Report Venue",
      suburb: "Richmond",
      area: "Inner East",
      membershipTier: "pro",
    }));
    for (let index = 0; index < 10; index += 1) {
      await harness.activityAuditRepository.recordEvent({
        id: `historical-report-open:${index}`,
        userId: null,
        anonymousSessionId: `historical-report-actor:${index}`,
        eventType: "venue_detail_opened",
        venueId,
        beerId: null,
        suburb: "Richmond",
        metadata: {},
        createdAt: "2026-05-10T10:00:00.000Z",
      });
      await harness.activityAuditRepository.recordEvent({
        id: `historical-report-area-search:${index}`,
        userId: null,
        anonymousSessionId: `historical-report-actor:${index}`,
        eventType: "beer_search_performed",
        venueId: null,
        beerId: "lager",
        suburb: "Richmond",
        metadata: { query: "lager" },
        createdAt: "2026-05-10T10:05:00.000Z",
      });
    }

    const generated = await harness.service.generateVenueMonthlyReports(admin.account, {
      month: "2026-05",
      venueId,
      dryRun: false,
    });
    expect(generated.generatedCount).toBe(1);
    const firstSaved = harness.repository.getVenueMonthlyReport({ venueId, month: "2026-05" })!;
    const firstSummary = firstSaved.data.summary as Record<string, unknown>;
    expect(firstSummary.uniqueProfileViews).toBe(10);
    expect(firstSummary.mostSearchedBeersInArea).toEqual([{ key: "lager", count: 10 }]);
    expect(firstSummary.operationalSnapshotExcluded).toBe(true);
    expect(firstSummary.historicalDataScope).toContain("Current listing quality");
    expect(firstSummary).not.toHaveProperty("listingQualityScore");
    expect(firstSummary).not.toHaveProperty("openWrongPriceReports");
    expect(firstSummary).not.toHaveProperty("openVenueRequests");
    expect(firstSummary).not.toHaveProperty("discoveryPlacement");

    await harness.activityAuditRepository.recordEvent({
      id: "historical-report-late-open",
      userId: null,
      anonymousSessionId: "historical-report-late-actor",
      eventType: "venue_detail_opened",
      venueId,
      beerId: null,
      suburb: "Richmond",
      metadata: {},
      createdAt: "2026-05-11T10:00:00.000Z",
    });
    const scheduledRetry = await harness.service.generateScheduledVenueMonthlyReports({
      month: "2026-05",
      venueId,
      dryRun: false,
    });
    expect((scheduledRetry.reports[0]?.data.summary as Record<string, unknown>).uniqueProfileViews).toBe(10);
    expect(harness.repository.getVenueMonthlyReport({ venueId, month: "2026-05" })?.createdAt)
      .toBe(firstSaved.createdAt);
    const ownerAccount = harness.repository.getAccountById(owner.account.id)!;
    const frozen = await harness.service.getVenueMonthlyReport(ownerAccount, venueId, "2026-05");
    expect((frozen.data.summary as Record<string, unknown>).uniqueProfileViews).toBe(10);
    await expect(harness.service.getVenueMonthlyReport(ownerAccount, venueId, "2026-13"))
      .rejects.toThrow("valid YYYY-MM");
    await expect(harness.service.getVenueMonthlyReport(ownerAccount, venueId, "0000-01"))
      .rejects.toThrow("valid YYYY-MM");

    const refreshedAt = "2026-07-01T00:00:00.000Z";
    harness.repository.upsertVenueMonthlyReport({
      id: "ignored-on-conflict",
      venueId,
      month: "2026-05",
      data: firstSaved.data,
      createdAt: refreshedAt,
    });
    expect(harness.repository.getVenueMonthlyReport({ venueId, month: "2026-05" })?.createdAt).toBe(refreshedAt);
  });

  it("keeps monthly reports scoped to the exact month, assigned owner, and privacy-safe fields", async () => {
    vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
    const harness = createHarness({ ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = (await signup(harness, "admin@pintpath.test")).account;
    const owner = (await signup(harness, "report-owner@pintpath.test")).account;
    const otherOwner = (await signup(harness, "report-other-owner@pintpath.test")).account;

    await harness.service.assignVenueManager(admin, {
      userId: owner.id,
      venueId: "venue-monthly",
      venueName: "Monthly Venue",
      suburb: "Richmond",
    });
    await harness.service.assignVenueManager(admin, {
      userId: otherOwner.id,
      venueId: "venue-other",
      venueName: "Other Venue",
      suburb: "Carlton",
    });
    await harness.service.upsertBarProfile(admin, "venue-monthly", venueProfileInput({
      name: "Monthly Venue",
      suburb: "Richmond",
      area: "Richmond",
      membershipTier: "pro",
    }));
    const ownerAccount = harness.repository.getAccountById(owner.id)!;
    const otherOwnerAccount = harness.repository.getAccountById(otherOwner.id)!;

    for (let index = 0; index < 3; index += 1) {
      await harness.activityAuditRepository.recordEvent({
        id: `may-click:${index}`,
        userId: null,
        anonymousSessionId: `anon-may-click:${index}`,
        eventType: "map_pin_click",
        venueId: "venue-monthly",
        beerId: null,
        suburb: "Richmond",
        metadata: { synthetic: true },
        createdAt: `2026-05-${String(index + 2).padStart(2, "0")}T10:00:00.000Z`,
      });
    }
    for (let index = 0; index < 4; index += 1) {
      await harness.activityAuditRepository.recordEvent({
        id: `june-click:${index}`,
        userId: null,
        anonymousSessionId: `anon-june-click:${index}`,
        eventType: "map_pin_click",
        venueId: "venue-monthly",
        beerId: null,
        suburb: "Richmond",
        metadata: { synthetic: true },
        createdAt: `2026-06-${String(index + 2).padStart(2, "0")}T10:00:00.000Z`,
      });
    }
    for (let index = 0; index < 10; index += 1) {
      await harness.activityAuditRepository.recordEvent({
        id: `may-search:${index}`,
        userId: null,
        anonymousSessionId: `anon-may-search:${index}`,
        eventType: "beer_search_performed",
        venueId: null,
        beerId: "stout",
        suburb: "Richmond",
        metadata: { query: "stout" },
        createdAt: `2026-05-${String(index + 3).padStart(2, "0")}T11:00:00.000Z`,
      });
      await harness.activityAuditRepository.recordEvent({
        id: `may-style:${index}`,
        userId: null,
        anonymousSessionId: `anon-may-search:${index}`,
        eventType: "style_search",
        venueId: null,
        beerId: null,
        suburb: "Richmond",
        metadata: { query: "stout", searchKind: "style" },
        createdAt: `2026-05-${String(index + 3).padStart(2, "0")}T11:00:00.000Z`,
      });
      await harness.activityAuditRepository.recordEvent({
        id: `june-search:${index}`,
        userId: null,
        anonymousSessionId: `anon-june-search:${index}`,
        eventType: "beer_search_performed",
        venueId: null,
        beerId: "lager",
        suburb: "Richmond",
        metadata: { query: "lager" },
        createdAt: `2026-06-${String(index + 3).padStart(2, "0")}T11:00:00.000Z`,
      });
      await harness.activityAuditRepository.recordEvent({
        id: `june-style:${index}`,
        userId: null,
        anonymousSessionId: `anon-june-search:${index}`,
        eventType: "style_search",
        venueId: null,
        beerId: null,
        suburb: "Richmond",
        metadata: { query: "lager", searchKind: "style" },
        createdAt: `2026-06-${String(index + 3).padStart(2, "0")}T11:00:00.000Z`,
      });
    }
    for (let index = 0; index < 10; index += 1) {
      await harness.activityAuditRepository.recordEvent({
        id: `may-contact-beer:${index}`,
        userId: null,
        anonymousSessionId: `anon-may-contact:${index}`,
        eventType: "beer_search_performed",
        venueId: null,
        beerId: "call_0412_345_678",
        suburb: "Richmond",
        metadata: { query: "Call 0412 345 678" },
        createdAt: `2026-05-${String(index + 3).padStart(2, "0")}T12:00:00.000Z`,
      });
      await harness.activityAuditRepository.recordEvent({
        id: `may-contact-style:${index}`,
        userId: null,
        anonymousSessionId: `anon-may-contact:${index}`,
        eventType: "style_search",
        venueId: null,
        beerId: null,
        suburb: "Richmond",
        metadata: { query: "text@example.com", beerStyle: "text@example.com", searchKind: "style" },
        createdAt: `2026-05-${String(index + 3).padStart(2, "0")}T12:01:00.000Z`,
      });
    }
    harness.repository.upsertVenueMonthlyReport({
      id: "monthly-report-sensitive",
      venueId: "venue-monthly",
      month: "2026-05",
      createdAt: NOW,
      data: {
        summary: {
          totalBarLookups: 999,
          userId: "should-not-leak",
          topTerms: ["stout", "person@example.com", "Call 0412 345 678"],
          nested: { anonymousSessionId: "anon-secret", safeAggregate: 12 },
        },
      },
    });
    harness.repository.upsertVenueMonthlyReport({
      id: "monthly-report-sensitive-embedded",
      venueId: "venue-monthly",
      month: "2026-04",
      createdAt: NOW,
      data: {
        summary: {
          totalBarLookups: 888,
          safeAggregate: 8,
          listingQualityScore: 100,
        },
      },
    });

    const directMayAnalytics = harness.repository.getVenueAreaAnalytics({
      venueId: "venue-monthly",
      area: "Richmond",
      month: "2026-05",
      privacyThreshold: 10,
    });
    expect(directMayAnalytics.barLookups).toBe(0);
    expect(directMayAnalytics.suppressedVenueMetrics).toContain("barLookups");
    expect(directMayAnalytics.areaBeerSearches).toEqual([{ key: "stout", count: 10 }]);
    expect(directMayAnalytics.areaStyleSearches).toEqual([{ key: "stout", count: 10 }]);
    expect(JSON.stringify(directMayAnalytics)).not.toContain("lager");
    expect(JSON.stringify(directMayAnalytics)).not.toContain("0412");
    expect(JSON.stringify(directMayAnalytics)).not.toContain("example.com");

    const ownerPortal = await harness.service.getVenuePortal(ownerAccount, { venueId: "venue-monthly" });
    expect(ownerPortal.monthlyReport?.month).toBe("2026-06");
    expect(ownerPortal.monthlyReport?.data.schemaVersion).toBe(2);
    expect(JSON.stringify(ownerPortal.monthlyReport)).not.toContain("safeAggregate");
    expect(JSON.stringify(ownerPortal.monthlyReport)).not.toContain("listingQualityScore");
    const selectedMayReport = await harness.service.getVenueMonthlyReport(ownerAccount, "venue-monthly", "2026-05");
    const serializedReport = JSON.stringify(selectedMayReport);
    expect(selectedMayReport.data.schemaVersion).toBe(2);
    expect(serializedReport).not.toContain("should-not-leak");
    expect(serializedReport).not.toContain("anon-secret");
    expect(serializedReport).not.toContain("person@example.com");
    expect(serializedReport).not.toContain("0412 345 678");
    expect(serializedReport).not.toContain("safeAggregate");

    const regeneratedExport = await harness.service.exportVenueMonthlyReport(
      ownerAccount,
      "venue-monthly",
      "2026-05",
      { format: "json" },
    );
    expect(regeneratedExport.body).toContain('"schemaVersion": 2');
    expect(regeneratedExport.body).not.toContain("safeAggregate");
    expect(harness.repository.getVenueMonthlyReport({ venueId: "venue-monthly", month: "2026-05" })?.data.schemaVersion).toBe(2);

    const currentPreview = await harness.service.getVenueMonthlyReport(ownerAccount, "venue-monthly", "2026-07");
    expect(currentPreview.data.generated).toBe(false);
    expect(harness.repository.getVenueMonthlyReport({ venueId: "venue-monthly", month: "2026-07" })).toBeNull();
    await expect(harness.service.exportVenueMonthlyReport(
      ownerAccount,
      "venue-monthly",
      "2026-07",
      { format: "json" },
    )).rejects.toThrow("completed calendar months");
    await expect(harness.service.getVenueMonthlyReport(ownerAccount, "venue-monthly", "2026-08"))
      .rejects.toThrow("Future monthly reports");

    harness.repository.upsertVenueMonthlyReport({
      id: "premature-june-embedded-snapshot",
      venueId: "venue-monthly",
      month: "2026-06",
      createdAt: "2026-06-15T00:00:00.000Z",
      data: {
        schemaVersion: 2,
        generated: true,
        generatedAt: "2026-06-15T00:00:00.000Z",
        reportingPeriod: { endIso: "2026-06-30T14:00:00.000Z" },
        summary: { prematureEmbeddedSnapshot: true },
      },
    });
    const portalWithPrematureSavedReport = await harness.service.getVenuePortal(ownerAccount, { venueId: "venue-monthly" });
    expect(portalWithPrematureSavedReport.monthlyReport?.month).toBe("2026-06");
    expect(portalWithPrematureSavedReport.monthlyReport?.data.generated).toBe(false);
    expect(JSON.stringify(portalWithPrematureSavedReport.monthlyReport)).not.toContain("prematureEmbeddedSnapshot");

    harness.repository.upsertVenueMonthlyReport({
      id: "premature-july-snapshot",
      venueId: "venue-monthly",
      month: "2026-07",
      createdAt: "2026-07-14T00:00:00.000Z",
      data: {
        schemaVersion: 2,
        generated: true,
        generatedAt: "2026-07-14T00:00:00.000Z",
        reportingPeriod: { endIso: "2026-07-31T14:00:00.000Z" },
        summary: { prematureSnapshot: true },
      },
    });
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
    const regeneratedJuly = await harness.service.generateScheduledVenueMonthlyReports({
      month: "2026-07",
      venueId: "venue-monthly",
      dryRun: false,
    });
    expect(JSON.stringify(regeneratedJuly.reports[0])).not.toContain("prematureSnapshot");
    expect(Date.parse(String(regeneratedJuly.reports[0]?.data.generatedAt)))
      .toBeGreaterThanOrEqual(Date.parse("2026-07-31T14:00:00.000Z"));

    await expect(harness.service.getVenuePortal(otherOwnerAccount, { venueId: "venue-monthly" }))
      .rejects.toThrow("assigned venues");
  });

  it("generates, mock-delivers, and exports monthly reports only to authorised venue owners", async () => {
    vi.setSystemTime(new Date("2026-07-14T00:00:00.000Z"));
    const harness = createHarness({ ANALYTICS_MIN_BUCKET_SIZE: 5, REPORT_EMAIL_MODE: "mock" });
    const admin = await signup(harness, "admin@pintpath.test");
    const owner = await signup(harness, "http-report-owner@pintpath.test");
    const unverifiedManager = await signup(harness, "http-report-unverified@pintpath.test");
    const counterStaff = await signup(harness, "http-report-counter@pintpath.test");
    const otherOwner = await signup(harness, "http-report-other-owner@pintpath.test");
    const basicOwner = await signup(harness, "http-report-basic-owner@pintpath.test");

    await harness.service.assignVenueManager(admin.account, {
      userId: owner.account.id,
      venueId: "venue-http-report",
      venueName: "HTTP Report Venue",
      suburb: "Richmond",
    });
    await harness.service.assignVenueManager(admin.account, {
      userId: unverifiedManager.account.id,
      venueId: "venue-http-report",
      venueName: "HTTP Report Venue",
      suburb: "Richmond",
    });
    const counterInvitation = await harness.venueAccessRepository.inviteCounterStaff({
      invitationToken: crypto.randomUUID(),
      inviterAccountId: admin.account.id,
      userId: counterStaff.account.id,
      venueId: "venue-http-report",
      venueName: "HTTP Report Venue",
      suburb: "Richmond",
      now: NOW,
      expiresAt: "2026-05-24T09:00:00.000Z",
    });
    await harness.venueAccessRepository.respondToCounterStaffInvitation({
      invitationToken: counterInvitation.assignment.id,
      userId: counterStaff.account.id,
      decision: "accept",
      now: NOW,
    });
    harness.repository.updateAccountSecurityClaims({
      userId: owner.account.id,
      emailVerifiedAt: NOW,
      now: NOW,
    });
    harness.repository.updateAccountSecurityClaims({
      userId: counterStaff.account.id,
      emailVerifiedAt: NOW,
      now: NOW,
    });
    await harness.service.assignVenueManager(admin.account, {
      userId: otherOwner.account.id,
      venueId: "venue-http-other",
      venueName: "Other HTTP Report Venue",
      suburb: "Carlton",
    });
    await harness.service.assignVenueManager(admin.account, {
      userId: basicOwner.account.id,
      venueId: "venue-http-basic",
      venueName: "HTTP Basic Venue",
      suburb: "Richmond",
    });
    await harness.service.upsertBarProfile(admin.account, "venue-http-report", venueProfileInput({
      name: "HTTP Report Venue",
      suburb: "Richmond",
      area: "Richmond",
      membershipTier: "pro",
    }));
    await harness.service.upsertBarProfile(admin.account, "venue-http-basic", venueProfileInput({
      name: "HTTP Basic Venue",
      suburb: "Richmond",
      area: "Richmond",
      membershipTier: "basic",
    }));

    for (let index = 0; index < 12; index += 1) {
      await harness.activityAuditRepository.recordEvent({
        id: `http-report-search:${index}`,
        userId: null,
        anonymousSessionId: `http-report-anon:${index}`,
        eventType: "beer_search_performed",
        venueId: null,
        beerId: "guinness",
        suburb: "Richmond",
        metadata: { query: "guinness" },
        createdAt: `2026-05-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
      });
      await harness.activityAuditRepository.recordEvent({
        id: `http-report-direction:${index}`,
        userId: null,
        anonymousSessionId: `http-report-direction-anon:${index}`,
        eventType: "directions_clicked",
        venueId: "venue-http-report",
        beerId: null,
        suburb: "Richmond",
        metadata: { source: "test" },
        createdAt: `2026-05-${String(index + 1).padStart(2, "0")}T11:00:00.000Z`,
      });
    }

    await withHttpServer(harness.app, async (baseUrl) => {
      const generated = await requestJson(baseUrl, "/api/business/admin/reports/monthly/generate", {
        method: "POST",
        token: admin.token,
        body: { month: "2026-05" },
      });
      expect(generated.response.status).toBe(200);
      expect((generated.json?.data as { generatedCount: number }).generatedCount).toBe(1);
      expect(JSON.stringify(generated.json)).not.toContain("venue-http-basic");

      const ownerPreview = await requestJson(
        baseUrl,
        "/api/business/venue-portal/venue-http-report/reports/2026-05",
        { token: owner.token },
      );
      expect(ownerPreview.response.status).toBe(200);
      expect(ownerPreview.response.headers.get("cache-control")).toContain("private");
      expect(ownerPreview.response.headers.get("cache-control")).toContain("no-store");
      expect((ownerPreview.json?.data as { report: { month: string } }).report.month).toBe("2026-05");

      const crossOwnerPreview = await requestJson(
        baseUrl,
        "/api/business/venue-portal/venue-http-report/reports/2026-05",
        { token: otherOwner.token },
      );
      expect(crossOwnerPreview.response.status).toBe(403);

      const basicOwnerPreview = await requestJson(
        baseUrl,
        "/api/business/venue-portal/venue-http-basic/reports/2026-05",
        { token: basicOwner.token },
      );
      expect(basicOwnerPreview.response.status).toBe(403);

      const invalidMonthPreview = await requestJson(
        baseUrl,
        "/api/business/venue-portal/venue-http-report/reports/2026-13",
        { token: owner.token },
      );
      expect(invalidMonthPreview.response.status).toBe(400);

      const delivered = await requestJson(baseUrl, "/api/business/admin/reports/monthly/deliver", {
        method: "POST",
        token: admin.token,
        body: { month: "2026-05", deliver: true },
      });
      expect(delivered.response.status).toBe(200);
      expect(delivered.json?.data).toEqual(expect.objectContaining({
        month: "2026-05",
        dryRun: false,
        generatedCount: 1,
        eligibleRecipientCount: 1,
        mockedCount: 1,
        rejectedCount: 0,
        uncertainCount: 0,
        processedCount: 1,
        emailMode: "mock",
      }));
      const deliveryPayload = JSON.stringify(delivered.json?.data);
      expect(deliveryPayload).not.toContain(owner.account.email);
      expect(deliveryPayload).not.toContain(otherOwner.account.email);
      expect(deliveryPayload).not.toContain(basicOwner.account.email);
      expect(deliveryPayload).not.toContain(unverifiedManager.account.email);
      expect(deliveryPayload).not.toContain(counterStaff.account.email);

      const ownerExport = await fetch(`${baseUrl}/api/business/venue-portal/venue-http-report/reports/2026-05/export?format=json`, {
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(ownerExport.status).toBe(200);
      expect(ownerExport.headers.get("cache-control")).toContain("private");
      const report = await ownerExport.json() as { data: { summary: { directionsClicks: number } } };
      expect(report.data.summary.directionsClicks).toBe(12);
      expect(JSON.stringify(report)).not.toContain("http-report-anon");

      const csvExport = await fetch(`${baseUrl}/api/business/venue-portal/venue-http-report/reports/2026-05/export?format=csv`, {
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(csvExport.status).toBe(200);
      const csv = await csvExport.text();
      expect(csv).toContain('"directionsClicks","12"');
      expect(csv).not.toContain("http-report-anon");

      const crossOwnerExport = await fetch(`${baseUrl}/api/business/venue-portal/venue-http-report/reports/2026-05/export?format=json`, {
        headers: { authorization: `Bearer ${otherOwner.token}` },
      });
      expect(crossOwnerExport.status).toBe(403);

      const basicOwnerExport = await fetch(`${baseUrl}/api/business/venue-portal/venue-http-basic/reports/2026-05/export?format=json`, {
        headers: { authorization: `Bearer ${basicOwner.token}` },
      });
      expect(basicOwnerExport.status).toBe(403);
      const basicError = await basicOwnerExport.json() as { error?: { message?: string } };
      expect(basicError.error?.message).toContain("Pro venue tier required");
    });
  });
});

describe("Pint Path release-readiness public contracts and accessibility smoke", () => {
  it("keeps Supabase evidence storage private and avoids new public bars tables", () => {
    const migrations = fs.readdirSync(path.resolve(process.cwd(), "supabase/migrations"))
      .filter((file) => file.endsWith(".sql"))
      .map((file) => fs.readFileSync(path.resolve(process.cwd(), "supabase/migrations", file), "utf8"))
      .join("\n");

    expect(migrations).toContain("beermap-source-evidence");
    expect(migrations).toMatch(/insert into storage\.buckets[\s\S]*'beermap-source-evidence'[\s\S]*false/i);
    expect(migrations).toMatch(/enable row level security/i);
    expect(migrations).not.toMatch(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.bars\b/i);

    const hardening = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/20260714000000_harden_source_evidence_storage.sql"),
      "utf8",
    );
    expect(hardening).toMatch(/drop policy if exists "source_evidence_owner_insert" on storage\.objects/i);
    expect(hardening).toMatch(/drop policy if exists "source_evidence_owner_select" on storage\.objects/i);
    expect(hardening).toMatch(/drop policy if exists "source_evidence_owner_update" on storage\.objects/i);
    expect(hardening).toMatch(/'beermap-source-evidence'[\s\S]*false[\s\S]*8388608/i);
    expect(hardening).toContain("'application/pdf'");
    expect(hardening).not.toMatch(/create\s+policy/i);
    expect(hardening).not.toMatch(/to\s+(?:anon|authenticated)/i);

    const backupHardening = fs.readFileSync(
      path.resolve(process.cwd(), "ops/supabase/independent-backup-project-storage.sql"),
      "utf8",
    );
    expect(backupHardening).toContain("'pintpath-backups'");
    expect(backupHardening).toContain("'application/pdf'");
    expect(backupHardening).toMatch(/file_size_limit\s*=\s*null/i);
    expect(backupHardening).not.toContain("104857600");
  });

  it("keeps critical public pages semantic, navigable, and free of prototype/admin leakage", () => {
    const pages = [
      "viewer/index.html",
      "viewer/account.html",
      "viewer/submit.html",
      "viewer/venue-portal.html",
      "viewer/trust.html",
      "viewer/community.html",
      "viewer/security.html",
    ];

    for (const page of pages) {
      const html = fs.readFileSync(path.resolve(process.cwd(), page), "utf8");
      expect(html).toMatch(/<title>[^<]*(?:Pint Path|Melbourne Beer Map)/i);
      expect(html).toMatch(/<main\b|role="main"/i);
      expect(html).toMatch(/<button\b|<a\b/i);
      expect(html).not.toContain("adminSecret");
      expect(html).not.toContain("Unlock admin actions");
      expect(html).not.toContain("Twilio");
      expect(html).not.toContain("ElevenLabs");
    }
  });
});

describe("ActivityAudit admin HTTP cutover", () => {
  it("authorizes and traverses deterministic audit pages with paired cursors", async () => {
    const harness = createHarness();
    const admin = await signup(harness, "admin@pintpath.test");
    for (const id of ["audit-page-a", "audit-page-c", "audit-page-b"]) {
      await harness.activityAuditRepository.insertSecurityAuditLog({
        id,
        actorUserId: admin.account.id,
        actorRole: "admin",
        action: "admin_test_event",
        targetType: "account",
        targetId: admin.account.id,
        metadata: { id },
        ipHash: null,
        userAgentHash: null,
        createdAt: NOW,
      });
    }

    await withHttpServer(harness.app, async (baseUrl) => {
      const unauthorized = await requestJson(baseUrl, "/api/business/admin/security-audit?limit=2");
      expect(unauthorized.response.status).toBe(401);

      const first = await requestJson(
        baseUrl,
        "/api/business/admin/security-audit?limit=2&offset=0&action=admin_test_event",
        { token: admin.token },
      );
      expect(first.response.status).toBe(200);
      const firstData = first.json?.data as {
        logs: Array<{ id: string }>;
        pagination: {
          total: number;
          limit: number;
          offset: number;
          hasMore: boolean;
          nextCursor: { createdAt: string; id: string } | null;
        };
      };
      expect(firstData.logs.map((log) => log.id)).toEqual(["audit-page-c", "audit-page-b"]);
      expect(firstData.pagination).toEqual(expect.objectContaining({
        total: 3,
        limit: 2,
        offset: 0,
        hasMore: true,
      }));
      expect(firstData.pagination.nextCursor).toEqual({ createdAt: NOW, id: "audit-page-b" });

      const cursor = firstData.pagination.nextCursor!;
      const second = await requestJson(
        baseUrl,
        `/api/business/admin/security-audit?limit=2&offset=2&action=admin_test_event&cursorCreatedAt=${encodeURIComponent(cursor.createdAt)}&cursorId=${encodeURIComponent(cursor.id)}`,
        { token: admin.token },
      );
      expect(second.response.status).toBe(200);
      const secondData = second.json?.data as typeof firstData;
      expect(secondData.logs.map((log) => log.id)).toEqual(["audit-page-a"]);
      expect(secondData.pagination).toEqual(expect.objectContaining({
        total: 3,
        limit: 2,
        offset: 2,
        hasMore: false,
        nextCursor: null,
      }));
      expect(new Set([...firstData.logs, ...secondData.logs].map((log) => log.id)).size).toBe(3);

      const incomplete = await requestJson(
        baseUrl,
        `/api/business/admin/security-audit?cursorCreatedAt=${encodeURIComponent(NOW)}`,
        { token: admin.token },
      );
      expect(incomplete.response.status).toBe(400);
      expect(incomplete.json?.error?.message).toBe("Both security audit cursor fields are required.");

      harness.database.prepare(
        `INSERT INTO security_audit_log (
           id, actor_user_id, actor_role, action, target_type, target_id,
           metadata_json, ip_hash, user_agent_hash, created_at
         ) VALUES ('malformed-audit-row', ?, 'admin', 'malformed_audit_test',
                   'account', ?, '[]', NULL, NULL, ?)`,
      ).run(admin.account.id, admin.account.id, NOW);
      const malformed = await requestJson(
        baseUrl,
        "/api/business/admin/security-audit?action=malformed_audit_test",
        { token: admin.token },
      );
      expect(malformed.response.status).toBe(500);
      expect(malformed.json?.error?.message).toBe("Internal server error");
      expect(JSON.stringify(malformed.json)).not.toContain("metadata_json");
    });
  });
});
