import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import BetterSqlite3 from "better-sqlite3";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BusinessRepository, type BusinessAccount } from "../src/db/business.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { createBusinessRouter } from "../src/modules/business/business.routes.js";
import { BusinessService } from "../src/modules/business/business.service.js";

const NOW = "2026-05-21T09:00:00.000Z";
const PASSWORD = "release-pass-123";
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]).toString("base64")}`;

type Harness = {
  database: BetterSqlite3.Database;
  repository: BusinessRepository;
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
  const service = new BusinessService(repository, {
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    FREE_PRICE_REVEALS_PER_DAY: 5,
    CONTRIBUTOR_UNLOCK_POINTS: 15,
    CONTRIBUTOR_UNLOCK_DAYS: 30,
    DEMO_BILLING_MODE: true,
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
    SOURCE_EVIDENCE_SIGNING_SECRET: "release-readiness-source-evidence-secret",
    SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS: 300,
    POS_WEBHOOK_SIGNING_SECRET: "release-readiness-pos-webhook-secret",
    NODE_ENV: "test",
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_PRICE_MONTHLY: undefined,
    STRIPE_PRICE_YEARLY: undefined,
    STRIPE_PRO_PRICE_ID: undefined,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: undefined,
    SUPABASE_URL: undefined,
    SUPABASE_ANON_KEY: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SUPABASE_OAUTH_PROVIDERS: "google,apple",
    ADMIN_EMAILS: "admin@pintpath.test",
    GOOGLE_MAPS_API_KEY: undefined,
    GOOGLE_PLACES_API_KEY: undefined,
    ...overrides,
  });

  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use("/api/business", createBusinessRouter(service));
  app.use(errorHandler);

  return { database, repository, service, app };
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

function signup(
  harness: Harness,
  email: string,
  input: { ageConfirmed?: boolean | undefined; termsAccepted?: boolean | undefined; privacyAccepted?: boolean | undefined } = {},
): { token: string; account: BusinessAccount } {
  const session = harness.service.signup({
    email,
    password: PASSWORD,
    ageConfirmed: input.ageConfirmed ?? true,
    termsAccepted: input.termsAccepted ?? true,
    privacyAccepted: input.privacyAccepted ?? true,
  });
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

function recordSearchEvents(
  repository: BusinessRepository,
  input: { count: number; beerId: string; suburb: string; prefix: string },
) {
  for (let index = 0; index < input.count; index += 1) {
    repository.recordEvent({
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
    const uploader = signup(harness, "uploader@pintpath.test");
    const verifier = signup(harness, "verifier@pintpath.test");

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

  it("keeps admin and analytics APIs protected from anonymous and normal users", async () => {
    const harness = createHarness();
    const user = signup(harness, "normal@pintpath.test");
    const admin = signup(harness, "admin@pintpath.test");

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

  it("keeps source evidence private and rejects obvious SSRF source URLs", async () => {
    const harness = createHarness();
    const owner = signup(harness, "evidence-owner@pintpath.test");
    const other = signup(harness, "evidence-other@pintpath.test");

    expect(() => harness.service.createSubmission(owner.account, validSubmission({
      sourcePhotoUrl: "http://127.0.0.1:8080/menu.jpg",
    }))).toThrow("local, private, or metadata network hosts");
    expect(() => harness.service.createSubmission(owner.account, validSubmission({
      sourcePhotoUrl: "http://169.254.169.254/latest/meta-data/menu.jpg",
    }))).toThrow("local, private, or metadata network hosts");

    const result = harness.service.createSubmission(owner.account, validSubmission({
      submissionType: "photo_upload",
      sourcePhotoDataUrl: PNG_DATA_URL,
      sourcePhotoUrl: null,
      items: [],
    }));
    expect(result.submission.sourcePhotoUrl).toMatch(/^private:evidence:/);

    expect(() => harness.service.getSubmissionSourceEvidenceUrl(other.account, result.submission.id))
      .toThrow("own source evidence");

    const signed = harness.service.getSubmissionSourceEvidenceUrl(owner.account, result.submission.id);
    expect(signed.signedUrl).toContain("/api/business/source-evidence/");

    await withHttpServer(harness.app, async (baseUrl) => {
      const evidenceId = new URL(signed.signedUrl!).pathname.split("/").pop()!;
      const unsigned = await fetch(`${baseUrl}/api/business/source-evidence/${evidenceId}`);
      expect(unsigned.status).toBe(403);
    });
  });
});

describe("Pint Path release-readiness venue-manager approval workflow", () => {
  it("keeps manager edits pending until admin approval and blocks cross-venue access", () => {
    const harness = createHarness({ ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = signup(harness, "admin@pintpath.test").account;
    const managerA = signup(harness, "manager-a@pintpath.test").account;
    const managerB = signup(harness, "manager-b@pintpath.test").account;

    harness.service.assignVenueManager(admin, {
      userId: managerA.id,
      venueId: "venue-a",
      venueName: "Half Moon",
      suburb: "Brighton",
    });
    harness.service.assignVenueManager(admin, {
      userId: managerB.id,
      venueId: "venue-b",
      venueName: "Neighbour Pub",
      suburb: "Fitzroy",
    });
    const updatedManagerA = harness.repository.getAccountById(managerA.id)!;
    const updatedManagerB = harness.repository.getAccountById(managerB.id)!;

    harness.service.upsertBarProfile(admin, "venue-a", venueProfileInput({ membershipTier: "basic" }));
    const pendingBeer = harness.service.upsertBarBeer(updatedManagerA, "venue-a", {
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
    }) as { pendingChange: { id: string; status: string; submittedBy: string } };

    expect(pendingBeer.pendingChange).toMatchObject({
      status: "pending",
      submittedBy: managerA.id,
    });
    expect(harness.service.listPriceRecords(null, {
      venueId: "venue-a",
      anonymousSessionId: "anon-release",
      reveal: true,
      limit: 20,
    }).records.some((record) => record.beerName === "Asahi Super Dry")).toBe(false);

    expect(harness.service.getVenuePortal(updatedManagerA, { venueId: "venue-a" }).pendingChanges)
      .toHaveLength(1);
    expect(() => harness.service.getVenuePortal(updatedManagerB, { venueId: "venue-a" }))
      .toThrow("assigned venues");
    expect(harness.service.getVenuePartnerAdmin(admin).pendingChanges.map((change) => change.id))
      .toContain(pendingBeer.pendingChange.id);

    harness.service.reviewBarPendingChange(admin, pendingBeer.pendingChange.id, {
      status: "approved",
      rejectionReason: null,
    });
    const publishedRecords = harness.service.listPriceRecords(admin, {
      venueId: "venue-a",
      anonymousSessionId: null,
      reveal: true,
      limit: 20,
    }).records;
    expect(publishedRecords.some((record) => record.beerName === "Asahi Super Dry" && record.price === 12))
      .toBe(true);

    expect(() => harness.service.upsertBarSpecial(updatedManagerA, "venue-a", {
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
    })).toThrow("Pro venue tier required");
    expect(harness.service.getVenuePortal(updatedManagerA, { venueId: "venue-a" }).inventory.specials)
      .toEqual([]);

    const basicPortal = harness.service.getVenuePortal(updatedManagerA, { venueId: "venue-a" });
    expect(basicPortal.tier?.analyticsLocked).toBe(true);
    expect(basicPortal.analytics).toBeNull();
  });
});

describe("Pint Path release-readiness analytics and report privacy", () => {
  it("suppresses low-count admin analytics buckets and redacts sensitive event metadata", () => {
    const harness = createHarness({ ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = signup(harness, "admin@pintpath.test").account;
    const user = signup(harness, "privacy-user@pintpath.test").account;

    recordSearchEvents(harness.repository, {
      count: 4,
      beerId: "rare-private-beer",
      suburb: "Carlton",
      prefix: "rare",
    });
    recordSearchEvents(harness.repository, {
      count: 5,
      beerId: "guinness",
      suburb: "Fitzroy",
      prefix: "guinness",
    });
    harness.service.trackEvent(user, {
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

    const preview = harness.service.getAnalyticsPreview(admin);
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

  it("gates venue analytics by tier and hides suburb trends until the privacy floor is met", () => {
    const harness = createHarness({ ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = signup(harness, "admin@pintpath.test").account;
    const manager = signup(harness, "pro-manager@pintpath.test").account;

    harness.service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "venue-pro",
      venueName: "Pro Venue",
      suburb: "Fitzroy",
    });
    harness.service.upsertBarProfile(admin, "venue-pro", venueProfileInput({
      name: "Pro Venue",
      suburb: "Fitzroy",
      area: "Fitzroy",
      membershipTier: "pro",
    }));
    const updatedManager = harness.repository.getAccountById(manager.id)!;

    for (let index = 0; index < 9; index += 1) {
      harness.repository.recordEvent({
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
    harness.repository.recordVenueAnalyticsEvent({
      id: "style-below-floor",
      venueId: null,
      area: "Fitzroy",
      suburb: "Fitzroy",
      eventType: "beer_style_search",
      queryText: "lager",
      beerName: null,
      beerStyle: "lager",
      createdAt: NOW,
    });

    const belowFloorPortal = harness.service.getVenuePortal(updatedManager, { venueId: "venue-pro" });
    expect(belowFloorPortal.tier?.analyticsLocked).toBe(false);
    expect(belowFloorPortal.analytics?.privacyFloorMet).toBe(false);
    expect(belowFloorPortal.analytics?.areaStyleSearches).toEqual([]);
    expect(JSON.stringify(belowFloorPortal.analytics)).not.toContain("@");

    harness.repository.recordEvent({
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
      harness.repository.recordVenueAnalyticsEvent({
        id: `style-at-floor:${index}`,
        venueId: null,
        area: "Fitzroy",
        suburb: "Fitzroy",
        eventType: "beer_style_search",
        queryText: "lager",
        beerName: null,
        beerStyle: "lager",
        createdAt: NOW,
      });
    }

    const atFloorPortal = harness.service.getVenuePortal(updatedManager, { venueId: "venue-pro" });
    expect(atFloorPortal.analytics?.privacyFloorMet).toBe(true);
    expect(atFloorPortal.monthlyReport?.data).toBeTruthy();
    expect(atFloorPortal.analytics?.areaStyleSearches).toEqual([{ key: "lager", count: 11 }]);
  });

  it("keeps monthly reports scoped to the exact month, assigned owner, and privacy-safe fields", () => {
    const harness = createHarness({ ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = signup(harness, "admin@pintpath.test").account;
    const owner = signup(harness, "report-owner@pintpath.test").account;
    const otherOwner = signup(harness, "report-other-owner@pintpath.test").account;

    harness.service.assignVenueManager(admin, {
      userId: owner.id,
      venueId: "venue-monthly",
      venueName: "Monthly Venue",
      suburb: "Richmond",
    });
    harness.service.assignVenueManager(admin, {
      userId: otherOwner.id,
      venueId: "venue-other",
      venueName: "Other Venue",
      suburb: "Carlton",
    });
    harness.service.upsertBarProfile(admin, "venue-monthly", venueProfileInput({
      name: "Monthly Venue",
      suburb: "Richmond",
      area: "Richmond",
      membershipTier: "pro",
    }));
    const ownerAccount = harness.repository.getAccountById(owner.id)!;
    const otherOwnerAccount = harness.repository.getAccountById(otherOwner.id)!;

    for (let index = 0; index < 3; index += 1) {
      harness.repository.recordEvent({
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
      harness.repository.recordEvent({
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
      harness.repository.recordEvent({
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
      harness.repository.recordVenueAnalyticsEvent({
        id: `may-style:${index}`,
        venueId: null,
        area: "Richmond",
        suburb: "Richmond",
        eventType: "beer_style_search",
        queryText: "stout",
        beerName: null,
        beerStyle: "stout",
        createdAt: `2026-05-${String(index + 3).padStart(2, "0")}T11:00:00.000Z`,
      });
      harness.repository.recordEvent({
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
      harness.repository.recordVenueAnalyticsEvent({
        id: `june-style:${index}`,
        venueId: null,
        area: "Richmond",
        suburb: "Richmond",
        eventType: "beer_style_search",
        queryText: "lager",
        beerName: null,
        beerStyle: "lager",
        createdAt: `2026-06-${String(index + 3).padStart(2, "0")}T11:00:00.000Z`,
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
          topTerms: ["stout", "person@example.com"],
          nested: { anonymousSessionId: "anon-secret", safeAggregate: 12 },
        },
      },
    });

    const directMayAnalytics = harness.repository.getVenueAreaAnalytics({
      venueId: "venue-monthly",
      area: "Richmond",
      month: "2026-05",
      privacyThreshold: 10,
    });
    expect(directMayAnalytics.barLookups).toBe(3);
    expect(directMayAnalytics.areaBeerSearches).toEqual([{ key: "stout", count: 10 }]);
    expect(directMayAnalytics.areaStyleSearches).toEqual([{ key: "stout", count: 10 }]);
    expect(JSON.stringify(directMayAnalytics)).not.toContain("lager");

    const ownerPortal = harness.service.getVenuePortal(ownerAccount, { venueId: "venue-monthly" });
    expect(ownerPortal.monthlyReport?.month).toBe("2026-05");
    const serializedReport = JSON.stringify(ownerPortal.monthlyReport);
    expect(serializedReport).not.toContain("should-not-leak");
    expect(serializedReport).not.toContain("anon-secret");
    expect(serializedReport).not.toContain("person@example.com");
    expect(serializedReport).toContain("safeAggregate");

    expect(() => harness.service.getVenuePortal(otherOwnerAccount, { venueId: "venue-monthly" }))
      .toThrow("assigned venues");
  });

  it("generates, mock-delivers, and exports monthly reports only to authorised venue owners", async () => {
    const harness = createHarness({ ANALYTICS_MIN_BUCKET_SIZE: 5, REPORT_EMAIL_MODE: "mock" });
    const admin = signup(harness, "admin@pintpath.test");
    const owner = signup(harness, "http-report-owner@pintpath.test");
    const otherOwner = signup(harness, "http-report-other-owner@pintpath.test");

    harness.service.assignVenueManager(admin.account, {
      userId: owner.account.id,
      venueId: "venue-http-report",
      venueName: "HTTP Report Venue",
      suburb: "Richmond",
    });
    harness.service.assignVenueManager(admin.account, {
      userId: otherOwner.account.id,
      venueId: "venue-http-other",
      venueName: "Other HTTP Report Venue",
      suburb: "Carlton",
    });
    harness.service.upsertBarProfile(admin.account, "venue-http-report", venueProfileInput({
      name: "HTTP Report Venue",
      suburb: "Richmond",
      area: "Richmond",
      membershipTier: "pro",
    }));
    harness.service.upsertBarProfile(admin.account, "venue-http-basic", venueProfileInput({
      name: "HTTP Basic Venue",
      suburb: "Richmond",
      area: "Richmond",
      membershipTier: "basic",
    }));

    for (let index = 0; index < 12; index += 1) {
      harness.repository.recordEvent({
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
      harness.repository.recordEvent({
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

      const delivered = await requestJson(baseUrl, "/api/business/admin/reports/monthly/deliver", {
        method: "POST",
        token: admin.token,
        body: { month: "2026-05", deliver: true },
      });
      expect(delivered.response.status).toBe(200);
      const deliveries = (delivered.json?.data as { deliveries: Array<{ status: string; recipients: string[]; venueId: string }> }).deliveries;
      expect(deliveries).toEqual([
        expect.objectContaining({
          venueId: "venue-http-report",
          status: "mocked",
          recipients: [owner.account.email],
        }),
      ]);
      expect(JSON.stringify(deliveries)).not.toContain(otherOwner.account.email);

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
