import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import BetterSqlite3 from "better-sqlite3";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BusinessRepository, type BarPendingChange, type SubmissionType, type SubscriptionStatus } from "../src/db/business.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { authSignupSchema, barHappyHourSchema, createSubmissionSchema, normalizeHappyHourTime } from "../src/modules/business/business.schemas.js";
import { createBusinessRouter } from "../src/modules/business/business.routes.js";
import { BusinessService, canAccessAgeGatedRewards } from "../src/modules/business/business.service.js";

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

let openDatabases: BetterSqlite3.Database[] = [];
let evidenceStorageDirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

function createRepository() {
  const database = new BetterSqlite3(":memory:");
  const schemaPath = path.resolve(process.cwd(), "src/db/schema.sql");
  database.exec(fs.readFileSync(schemaPath, "utf8"));
  openDatabases.push(database);

  return {
    database,
    repository: new BusinessRepository(database),
  };
}

function createBusinessService(
  repository: BusinessRepository,
  overrides: Partial<ConstructorParameters<typeof BusinessService>[1]> = {},
) {
  const evidenceStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-evidence-"));
  evidenceStorageDirs.push(evidenceStorageDir);

  return new BusinessService(repository, {
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
    SOURCE_EVIDENCE_SIGNING_SECRET: "test-source-evidence-signing-secret-32-bytes",
    SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS: 300,
    POS_WEBHOOK_SIGNING_SECRET: "test-pos-webhook-signing-secret-32-bytes",
    NODE_ENV: "test",
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_PRICE_MONTHLY: undefined,
    STRIPE_PRICE_YEARLY: undefined,
    STRIPE_PLUS_PRICE_ID: undefined,
    STRIPE_PRO_PRICE_ID: undefined,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: undefined,
    SUPABASE_URL: undefined,
    SUPABASE_ANON_KEY: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SUPABASE_OAUTH_PROVIDERS: "google,apple",
    ADMIN_EMAILS: "admin@example.com",
    GOOGLE_MAPS_API_KEY: undefined,
    GOOGLE_PLACES_API_KEY: undefined,
    ...overrides,
  });
}

function createAccount(repository: BusinessRepository, id: string, role: "user" | "admin" = "user") {
  const account = repository.createAccount({
    id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    role,
    subscriptionStatus: role === "admin" ? "admin" : "free",
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
  return repository.createSubmission({
    id: input.id,
    userId: input.userId,
    venueId: input.venueId,
    venueName: input.venueName ?? "Test Bar",
    suburb: "Melbourne",
    submissionType: input.submissionType ?? "full_venue_update",
    observedAt: NOW,
    sourcePhotoUrl: input.sourcePhotoUrl ?? JPEG_DATA_URL,
    notes: "Menu board photo supplied.",
    now: NOW,
    items: [
      {
        id: `${input.id}:item-1`,
        beerName: input.beerName ?? "Carlton Draught",
        normalizedBeerId: null,
        servingSize: input.servingSize ?? "pint",
        price: input.price ?? 14,
        isHappyHourPrice: false,
        happyHourDetails: null,
        isOnTap: "yes",
        confidence: 0.88,
      },
    ],
  });
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

  it("allows photo/source uploads without manual beer rows", () => {
    const parsed = createSubmissionSchema.parse({
      ...baseSubmission,
      clientSubmissionId: "queued-test-001",
      submissionType: "photo_upload",
      items: [],
    });

    expect(parsed.items).toEqual([]);
    expect(parsed.clientSubmissionId).toBe("queued-test-001");
  });

  it("rejects unsafe client submission IDs", () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      clientSubmissionId: "queued bad/id",
      submissionType: "photo_upload",
      items: [],
    });

    expect(result.success).toBe(false);
  });

  it("still requires a beer row for single beer price submissions", () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "single_beer_price",
      items: [],
    });

    expect(result.success).toBe(false);
  });

  it("requires three beer rows for full venue updates", () => {
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

  it("requires source evidence for photo/source uploads", () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "photo_upload",
      sourcePhotoDataUrl: null,
      items: [],
    });

    expect(result.success).toBe(false);
  });

  it("allows happy-hour updates without forcing a source photo upload", () => {
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

  it("accepts new venue details without coercing blank coordinates to zero", () => {
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
  });
});

describe("bar happy-hour time validation", () => {
  it("normalises human-friendly bar times into 24-hour storage values", () => {
    expect(normalizeHappyHourTime("7:30 pm")).toBe("19:30");
    expect(normalizeHappyHourTime("07.30pm")).toBe("19:30");
    expect(normalizeHappyHourTime("730pm")).toBe("19:30");
    expect(normalizeHappyHourTime("1930")).toBe("19:30");
    expect(normalizeHappyHourTime("12:30 am")).toBe("00:30");
  });

  it("accepts friendly happy-hour times through the bar portal schema", () => {
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
  it("defaults non-admin submission listing to the caller's own queue", () => {
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

    expect(() => service.listSubmissions(null, { mine: false, limit: 10 })).toThrow("Login required.");
    expect(service.listSubmissions(user, { mine: false, limit: 10 })).toEqual([ownSubmission]);
    expect(service.listSubmissions(admin, { mine: false, limit: 10 })).toHaveLength(2);
  });
});

describe("Supabase account and verification foundation", () => {
  it("upgrades legacy local databases before login/account queries need new columns", () => {
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

  it("migrates legacy feedback tables before creating priority indexes", () => {
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

  it("creates an app-facing profile row when an account is created", () => {
    const { repository } = createRepository();
    const account = createAccount(repository, "profile-user");
    const profile = repository.getProfileById(account.id);

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
    const service = createBusinessService(repository, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "placeholder-anon-key",
    });

    (service as unknown as { supabase: unknown }).supabase = {
      auth: {
        getUser: async () => ({
          data: {
            user: {
              id: "supabase-user-1",
              email: "oauth-user@example.com",
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

    const result = await service.loginWithSupabaseAccessToken({ accessToken: "x".repeat(32) });
    const linkedAccount = repository.getAccountBySupabaseUserId("supabase-user-1");
    const profile = repository.getProfileById(result.account.id);

    expect(result.token.length).toBeGreaterThan(30);
    expect(result.account.email).toBe("oauth-user@example.com");
    expect(linkedAccount?.id).toBe(result.account.id);
    expect(linkedAccount?.ageConfirmedAt).toBeNull();
    expect(linkedAccount?.termsAcceptedAt).toBeNull();
    expect(linkedAccount?.privacyAcceptedAt).toBeNull();
    expect(profile).toEqual(expect.objectContaining({
      id: result.account.id,
      email: "oauth-user@example.com",
      displayName: "OAuth User",
      avatarUrl: "https://example.com/avatar.png",
    }));
    expect(repository.listUserActivityEvents(result.account.id, 10).map((event) => event.eventType))
      .toEqual(expect.arrayContaining(["user_signup", "user_login"]));
  });

  it("links uploads and verifications to authenticated users and blocks self-verification", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const uploader = createAccount(repository, "uploader");
    const verifier = createAccount(repository, "verifier");
    const secondVerifier = createAccount(repository, "second-verifier");
    const admin = createAccount(repository, "verification-admin", "admin");

    const submissionResult = service.createSubmission(uploader, createSubmissionSchema.parse({
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
    expect(repository.listUserActivityEvents(uploader.id, 10).map((event) => event.eventType))
      .toContain("data_upload_created");
    expect(() => service.verifySubmission(uploader, submission.id, { result: "confirmed", notes: null }))
      .toThrow("You cannot verify your own upload.");

    const verified = service.verifySubmission(verifier, submission.id, {
      result: "confirmed",
      notes: "Matches the posted tap list.",
    });

    expect(verified.verification.verifierUserId).toBe(verifier.id);
    expect(verified.verification.uploadId).toBe(submission.id);
    expect(() => service.verifySubmission(verifier, submission.id, {
      result: "confirmed",
      notes: "Second try should not count twice.",
    })).toThrow("already verified");
    expect(repository.listUserActivityEvents(verifier.id, 10)).toEqual([
      expect.objectContaining({
        eventType: "data_verified",
        relatedEntityType: "submission",
        relatedEntityId: submission.id,
      }),
    ]);

    approve(repository, submission.id, admin.id);
    expect(() => service.verifySubmission(secondVerifier, submission.id, {
      result: "confirmed",
      notes: null,
    })).toThrow("Only pending submissions");
  });

  it("deduplicates retried queued submissions by client submission ID", () => {
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

    const first = service.createSubmission(uploader, payload);
    const replay = service.createSubmission(uploader, payload);

    expect(replay.submission.id).toBe(first.submission.id);
    expect(replay.submission.clientSubmissionId).toBe("queued-submit-123");
    expect(replay).toMatchObject({ idempotentReplay: true });
    expect(repository.listSubmissions({ userId: uploader.id, limit: 10 })).toHaveLength(1);
  });

  it("blocks new venue submissions that duplicate a known venue", () => {
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

    expect(() => service.createSubmission(uploader, createSubmissionSchema.parse({
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
    }))).toThrow("already appears to be on Pint Path");

    expect(repository.listSubmissions({ userId: uploader.id, limit: 10 })).toHaveLength(0);
  });

  it("returns contributor dashboard stats and redacts raw evidence references", () => {
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

    const dashboard = service.getAccountDashboard(repository.getAccountById(submitter.id)!);

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

  it("exports account data without raw private evidence or exact upload coordinates", () => {
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

    const exported = service.exportAccountData(account);
    const serialized = JSON.stringify(exported);

    expect(exported).toEqual(expect.objectContaining({
      exportFormat: "pint_path_account_export_v1",
      account: expect.objectContaining({ id: account.id }),
    }));
    expect(serialized).toContain("hasPrivateEvidence");
    expect(serialized).not.toContain("private:evidence");
    expect(serialized).not.toContain("sourcePhotoUrl");
    expect(serialized).not.toContain("uploadLatitude");
    expect(repository.listUserActivityEvents(account.id, 10).map((event) => event.eventType))
      .toContain("account_data_exported");
  });

  it("triages sensitive feedback and creates deletion requests through the support queue", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const account = createAccount(repository, "delete-request-user");

    const security = service.submitFeedback(account, {
      anonymousSessionId: null,
      feedbackType: "security_report",
      message: "Suspicious account activity.",
      venueId: null,
      venueName: null,
    });
    const deletion = service.requestAccountDeletion(account, {
      message: "Please remove my contributor account.",
    });

    expect(security.feedback).toEqual(expect.objectContaining({
      priority: "high",
      triageReason: expect.stringContaining("Sensitive account/security"),
    }));
    expect(deletion.feedback).toEqual(expect.objectContaining({
      feedbackType: "account_deletion_request",
      priority: "high",
    }));
    expect(repository.listFeedback(10).map((item) => item.feedbackType))
      .toEqual(expect.arrayContaining(["security_report", "account_deletion_request"]));
    expect(repository.listUserActivityEvents(account.id, 10).map((event) => event.eventType))
      .toContain("account_deletion_requested");
  });

  it("saves account privacy settings and suppresses opted-out optional analytics", () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const account = createAccount(repository, "privacy-settings-user");

    expect(service.getAccountDashboard(account).privacySettings).toEqual(expect.objectContaining({
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
      productResearchEnabled: true,
      emailUpdatesEnabled: false,
    }));

    const saved = service.savePrivacySettings(account, {
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      productResearchEnabled: false,
      emailUpdatesEnabled: true,
    });

    expect(saved.privacySettings).toEqual(expect.objectContaining({
      userId: account.id,
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      productResearchEnabled: false,
      emailUpdatesEnabled: true,
    }));

    service.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "beer_search_performed",
      venueId: null,
      beerId: "guinness",
      suburb: "Richmond",
      metadata: { privacyScope: "optional_analytics", query: "Guinness pint" },
    });
    service.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "map_pin_click",
      venueId: "privacy-venue",
      beerId: null,
      suburb: "Richmond",
      metadata: { privacyScope: "venue_insight" },
    });
    service.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "feedback_submitted",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { feedbackType: "privacy_request" },
    });

    const eventRows = database
      .prepare("SELECT event_type FROM events ORDER BY created_at")
      .all() as Array<{ event_type: string }>;
    expect(eventRows.map((row) => row.event_type)).toEqual(["feedback_submitted"]);
    expect(repository.listUserActivityEvents(account.id, 10).map((event) => event.eventType))
      .toContain("account_privacy_settings_updated");
  });

  it("only allows age-gated reward eligibility for verified 18+ records that have not expired", () => {
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

  it("keeps raw proof-of-ID fields out of the age verification schema", () => {
    const schema = fs.readFileSync(path.resolve(process.cwd(), "src/db/schema.sql"), "utf8");
    const ageVerificationSchema = schema.match(/CREATE TABLE IF NOT EXISTS age_verifications[\s\S]*?\);/i)?.[0] ?? "";

    expect(ageVerificationSchema.toLowerCase()).not.toMatch(
      /passport|licen[sc]e|driver|medicare|date_of_birth|dob|id_image|document|birthdate/,
    );
  });
});

describe("production hardening", () => {
  it("limits free users to happy hours and core pint price previews server-side", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, { FREE_PRICE_REVEALS_PER_DAY: 1 });
    const submitter = createAccount(repository, "submitter");
    const admin = createAccount(repository, "admin", "admin");
    const first = createSubmission(repository, { id: "submission-1", userId: submitter.id, venueId: "venue-1", price: 14 });
    const second = createSubmission(repository, { id: "submission-2", userId: submitter.id, venueId: "venue-2", beerName: "Asahi Super Dry", price: 16 });
    const third = createSubmission(repository, { id: "submission-3", userId: submitter.id, venueId: "venue-3", beerName: "Guinness", servingSize: "schooner", price: 11 });

    approve(repository, first.id, admin.id);
    approve(repository, second.id, admin.id);
    approve(repository, third.id, admin.id);

    const preview = service.listPriceRecords(null, {
      anonymousSessionId: "anon-price-test",
      reveal: false,
      limit: 20,
      venueId: null,
    });
    expect(preview.records).toHaveLength(3);
    expect(preview.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ beerName: "Carlton Draught", servingSize: "pint", price: 14, freePreviewIncluded: true }),
      expect.objectContaining({ beerName: "Asahi Super Dry", price: null, priceRedacted: true }),
      expect.objectContaining({ beerName: "Guinness", servingSize: "schooner", price: null, priceRedacted: true }),
    ]));

    const revealed = service.listPriceRecords(null, {
      anonymousSessionId: "anon-price-test",
      reveal: true,
      limit: 20,
      venueId: "venue-1",
    });
    expect(revealed.revealed).toBe(true);
    expect(revealed.blocked).toBe(false);
    expect(revealed.records[0]?.price).toBe(14);

    const blocked = service.listPriceRecords(null, {
      anonymousSessionId: "anon-price-test",
      reveal: true,
      limit: 20,
      venueId: "venue-2",
    });
    expect(blocked.revealed).toBe(false);
    expect(blocked.blocked).toBe(true);
    expect(blocked.records[0]?.price).toBeNull();
    expect((blocked.records[0] as { priceRedacted?: boolean } | undefined)?.priceRedacted).toBe(true);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    expect(repository.countEvents({
      eventType: "price_view_revealed",
      userId: null,
      anonymousSessionId: "anon-price-test",
      since: todayStart.toISOString(),
    })).toBe(0);
    expect(repository.countEvents({
      eventType: "price_view_blocked_free_limit",
      userId: null,
      anonymousSessionId: "anon-price-test",
      since: todayStart.toISOString(),
    })).toBe(1);
  });

  it("keeps non-preview prices locked for free users while allowing premium, contributor, and admin exact price access", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, { FREE_PRICE_REVEALS_PER_DAY: 1 });
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

    expect(service.listPriceRecords(freeUser, {
      anonymousSessionId: null,
      reveal: false,
      limit: 20,
      venueId: "venue-1",
    }).records[0]?.price).toBe(12);
    expect(service.listPriceRecords(freeUser, {
      anonymousSessionId: null,
      reveal: true,
      limit: 20,
      venueId: "venue-2",
    }).records[0]?.price).toBeNull();

    expect(service.listPriceRecords(premiumUser, {
      anonymousSessionId: null,
      reveal: false,
      limit: 20,
      venueId: "venue-2",
    }).records[0]?.price).toBe(17);
    expect(service.listPriceRecords(contributor, {
      anonymousSessionId: null,
      reveal: false,
      limit: 20,
      venueId: "venue-2",
    }).records[0]?.price).toBe(17);
    expect(service.listPriceRecords(admin, {
      anonymousSessionId: null,
      reveal: false,
      limit: 20,
      venueId: "venue-2",
    }).records[0]?.price).toBe(17);
  });

  it("includes special-discount details only in the full-access entitlement state", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const freeUser = createAccount(repository, "specials-free-user");
    const premiumUser = updateSubscription(
      repository,
      createAccount(repository, "specials-premium-user").id,
      "premium_monthly",
    );

    expect(service.getAccessState(freeUser, null)).toMatchObject({
      hasFullAccess: false,
      canViewSpecialDiscounts: false,
      freePreviewScope: "Happy hours plus pint prices for Guinness, Carlton Draught, and Stone & Wood Pacific Ale.",
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

  it("keeps exact price reads behind the business API in the public viewer", () => {
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
    expect(adminHtml).toContain("id=\"adminBeerRows\"");
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
    app.use(errorHandler);

    try {
      await withHttpServer(app, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/boom`);
        const body = await response.text();
        expect(response.status).toBe(500);
        expect(body).toContain("Internal server error");
        expect(body).not.toContain("sk_test_supersecret");
        expect(body).not.toContain("Bearer abcdefghijk.abcdefghijk.abcdefghijk");
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

  it("requires age, terms, and privacy acceptance before local account signup", () => {
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

  it("requires production admin email verification and MFA step-up", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      ADMIN_EMAILS: "prod-admin@example.com",
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: true,
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
    });
    const adminSession = service.signup({
      email: "prod-admin@example.com",
      password: "password123",
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
    });
    const userSession = service.signup({
      email: "prod-user@example.com",
      password: "password123",
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
    });

    expect(() => service.requireAdmin(`Bearer ${userSession.token}`)).toThrow("Admin access required");
    expect(() => service.requireAdmin(undefined)).toThrow("Login required");
    expect(() => service.requireAdmin(`Bearer ${adminSession.token}`)).toThrow("Admin email verification");

    repository.updateAccountSecurityClaims({
      userId: adminSession.account.id,
      emailVerifiedAt: NOW,
      now: NOW,
    });
    expect(() => service.requireAdmin(`Bearer ${adminSession.token}`)).toThrow("Admin MFA step-up");

    repository.updateAccountSecurityClaims({
      userId: adminSession.account.id,
      mfaLevel: "aal2",
      mfaVerifiedAt: new Date().toISOString(),
      now: NOW,
    });
    expect(service.requireAdmin(`Bearer ${adminSession.token}`).id).toBe(adminSession.account.id);
  });

  it("allows verified allowlisted production admins without MFA when the field-test flag disables it", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      ADMIN_EMAILS: "field-admin@example.com",
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: false,
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
    });
    const adminSession = service.signup({
      email: "field-admin@example.com",
      password: "password123",
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
    });

    expect(() => service.requireAdmin(`Bearer ${adminSession.token}`)).toThrow("Admin email verification");

    repository.updateAccountSecurityClaims({
      userId: adminSession.account.id,
      emailVerifiedAt: NOW,
      now: NOW,
    });

    expect(service.requireAdmin(`Bearer ${adminSession.token}`).id).toBe(adminSession.account.id);
  });

  it("keeps production admin routes locked until an admin email allowlist is configured", () => {
    const { repository } = createRepository();
    const serviceWithAllowlist = createBusinessService(repository, {
      NODE_ENV: "production",
      ADMIN_EMAILS: "pending-admin@example.com",
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: true,
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
    });
    const adminSession = serviceWithAllowlist.signup({
      email: "pending-admin@example.com",
      password: "password123",
      ageConfirmed: true,
      termsAccepted: true,
      privacyAccepted: true,
    });
    repository.updateAccountSecurityClaims({
      userId: adminSession.account.id,
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

    expect(() => serviceWithoutAllowlist.requireAdmin(`Bearer ${adminSession.token}`)).toThrow(
      "Admin access is not configured",
    );
  });

  it("blocks production uploads and verifications until email verification is recorded", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      NODE_ENV: "production",
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
    });
    const uploader = createAccount(repository, "prod-upload");
    const verifier = createAccount(repository, "prod-verifier");
    expect(() => service.createSubmission(uploader, createSubmissionSchema.parse({
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
    }))).toThrow("Verify your email");

    const verifiedUploader = repository.updateAccountSecurityClaims({
      userId: uploader.id,
      emailVerifiedAt: NOW,
      now: NOW,
    });
    const submission = service.createSubmission(verifiedUploader, createSubmissionSchema.parse({
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
    })).submission;

    expect(() => service.verifySubmission(verifier, submission.id, { result: "confirmed", notes: null }))
      .toThrow("Verify your email");

    const verifiedVerifier = repository.updateAccountSecurityClaims({
      userId: verifier.id,
      emailVerifiedAt: NOW,
      now: NOW,
    });
    expect(service.verifySubmission(verifiedVerifier, submission.id, { result: "confirmed", notes: null }).verification.uploadId)
      .toBe(submission.id);
  });

  it("validates source photo type and size before storing demo uploads", () => {
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

    expect(() => service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoDataUrl: "data:image/gif;base64,abc",
    }))).toThrow("Upload must be a JPEG");

    expect(() => service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoDataUrl: `data:image/png;base64,${Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64")}`,
    }))).toThrow("safe image file");

    expect(() => service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoDataUrl: `data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64")}`,
    }))).toThrow("does not match");

    const oversizedImage = `data:image/png;base64,${Buffer.alloc((6 * 1024 * 1024) + 64).toString("base64")}`;
    expect(() => service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoDataUrl: oversizedImage,
    }))).toThrow("6MB or smaller");

    const storedPng = service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      venueId: "venue-photo-valid",
      sourcePhotoDataUrl: PNG_DATA_URL,
    })).submission.sourcePhotoUrl;
    expect(storedPng).toMatch(/^private:evidence:/);

    const storedWebp = service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      venueId: "venue-photo-webp",
      sourcePhotoDataUrl: WEBP_DATA_URL,
    })).submission.sourcePhotoUrl;
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
    const productionStored = productionFileService.createSubmission(
      verifiedProductionUser,
      createSubmissionSchema.parse({
        ...baseSubmission,
        venueId: "venue-photo-prod-file",
        sourcePhotoDataUrl: PNG_DATA_URL,
      }),
    ).submission;
    expect(productionStored.sourcePhotoUrl).toMatch(/^private:evidence:/);
    const productionEvidenceId = productionStored.sourcePhotoUrl!.replace("private:evidence:", "");
    const productionEvidence = repository.getSourceEvidenceObject(productionEvidenceId)!;
    expect(productionEvidence.storageProvider).toBe("filesystem_private");
    expect(productionEvidence.dataBase64).toBeNull();
    expect(productionFileService.getSourceEvidenceDelivery(productionEvidence)).toMatchObject({
      kind: "bytes",
      mimeType: "image/png",
    });

    const productionOverrideService = createBusinessService(repository, {
      NODE_ENV: "production",
      ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-source-evidence-signing-secret-32",
    });
    expect(productionOverrideService.createSubmission(
      verifiedProductionUser,
      createSubmissionSchema.parse({
        ...baseSubmission,
        venueId: "venue-photo-prod-override",
        sourcePhotoDataUrl: PNG_DATA_URL,
      }),
    ).submission.sourcePhotoUrl).toMatch(/^private:evidence:/);
  });

  it("rejects unsafe external source URLs before review storage", () => {
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

    expect(() => service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoUrl: "javascript:alert(1)",
    }))).toThrow("HTTP or HTTPS");
    expect(() => service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoUrl: "https://example.com/menu.svg",
    }))).toThrow("safe image source");

    expect(service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoUrl: "https://example.com/menu-photo.jpg",
    })).submission.sourcePhotoUrl).toMatch(/^private:evidence:/);
  });

  it("lets admins review their own submissions and returns clean errors for already-reviewed submissions", () => {
    const { repository } = createRepository();
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
      confidence: "photo_verified" as const,
    };

    const ownReview = service.reviewSubmission(admin, ownSubmission.id, approvePayload);
    expect(ownReview.submission.status).toBe("approved");
    expect(ownReview.submission.reviewedBy).toBe(admin.id);

    service.reviewSubmission(admin, submission.id, approvePayload);
    expect(() => service.reviewSubmission(otherAdmin, submission.id, approvePayload)).toThrow("Submission has already been reviewed");
    const auditLogs = repository.listSecurityAuditLogs(10);
    expect(auditLogs.some((log) =>
      log.action === "admin_submission_review" &&
      log.actorUserId === admin.id &&
      log.targetId === submission.id,
    )).toBe(true);
    expect(auditLogs.some((log) =>
      log.action === "admin_submission_review" &&
      log.actorUserId === admin.id &&
      log.targetId === ownSubmission.id,
    )).toBe(true);
  });

  it("publishes a user-requested new venue and its beer rows only after admin approval", async () => {
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

    const submission = service.createSubmission(uploader, payload);

    expect(submission.submission.pendingVenue?.name).toBe("Moonlit Taproom");
    expect(submission.statusCopy).toContain("only after approval");
    expect(await service.listVenues("Moonlit", 10)).toEqual([]);
    expect(repository.listVenueManagerPriceRecords(20, venueId)).toEqual([]);

    service.reviewSubmission(admin, submission.submission.id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    });

    const venues = await service.listVenues("Moonlit", 10);
    const publishedVenue = venues.find((venue) => venue.id === venueId);
    expect(publishedVenue).toEqual(expect.objectContaining({
      id: venueId,
      name: "Moonlit Taproom",
      address: "10 Test Lane",
      suburb: "Fitzroy",
      membershipTier: "basic",
    }));

    const records = repository.listVenueManagerPriceRecords(20, venueId);
    expect(records.map((record) => record.beerName).sort()).toEqual([
      "Carlton Draught",
      "Guinness",
      "Stone & Wood Pacific Ale",
    ]);
  });

  it("stores upload location proof and awards dynamic points only inside the 200m venue radius", () => {
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

    const submission = service.createSubmission(uploader, createSubmissionSchema.parse({
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
    })).submission;

    expect(submission.pointsEligibleByLocation).toBe(true);
    expect(submission.distanceToVenueMeters).toBe(0);

    const reviewed = service.reviewSubmission(admin, submission.id, {
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
    const farSubmission = service.createSubmission(uploader, createSubmissionSchema.parse({
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
    })).submission;

    expect(farSubmission.pointsEligibleByLocation).toBe(false);
    expect(farSubmission.pointsEligibilityReason).toBe("outside_200m");
    const farReviewed = service.reviewSubmission(admin, farSubmission.id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      pointsAwarded: 25,
      confidence: "photo_verified",
    });
    expect(farReviewed.pointsAwarded).toBe(0);
  });

  it("scales contribution points by venue freshness", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "freshness-user");
    const admin = createAccount(repository, "freshness-admin", "admin");

    const seedExistingRecord = (venueId: string, observedAt: string) => {
      const seedUser = createAccount(repository, `seed-${venueId}`);
      const seedSubmission = repository.createSubmission({
        id: `seed-submission-${venueId}`,
        userId: seedUser.id,
        venueId,
        venueName: `Venue ${venueId}`,
        suburb: "Melbourne",
        submissionType: "single_beer_price",
        observedAt,
        sourcePhotoUrl: null,
        notes: null,
        now: observedAt,
        items: [{
          id: `seed-submission-${venueId}:item`,
          beerName: "Guinness",
          normalizedBeerId: "guinness",
          servingSize: "pint",
          price: 12,
          isHappyHourPrice: false,
          happyHourDetails: null,
          isOnTap: "yes",
          confidence: 0.9,
        }],
      });
      repository.reviewSubmission({
        submissionId: seedSubmission.id,
        reviewerId: admin.id,
        status: "approved",
        rejectionReason: null,
        fraudFlagged: false,
        pointsAwarded: 0,
        confidence: "photo_verified",
        now: observedAt,
        monthKey: observedAt.slice(0, 7),
        premiumUntil: PREMIUM_UNTIL,
        contributorUnlockPoints: 15,
      });
    };

    const makeSubmission = (venueId: string, submitter = user, beerName = "Guinness") => {
      repository.upsertVenueLocationCache({
        venueId,
        venueName: `Venue ${venueId}`,
        suburb: "Melbourne",
        latitude: -37.8,
        longitude: 144.9,
        now: NOW,
      });
      return service.createSubmission(submitter, createSubmissionSchema.parse({
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
      })).submission;
    };

    seedExistingRecord("fresh-venue", new Date().toISOString());
    seedExistingRecord("week-venue", new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString());
    seedExistingRecord("stale-venue", new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString());

    const fresh = service.reviewSubmission(admin, makeSubmission("fresh-venue").id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    });
    const week = service.reviewSubmission(admin, makeSubmission("week-venue").id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    });
    const stale = service.reviewSubmission(admin, makeSubmission("stale-venue").id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    });
    const missing = service.reviewSubmission(admin, makeSubmission("new-venue").id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    });
    const newDrinkUser = createAccount(repository, "new-drink-user");
    const newDrink = service.reviewSubmission(admin, makeSubmission("fresh-venue", newDrinkUser, "Stone & Wood Pacific Ale").id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    });

    expect(fresh.pointsAwarded).toBe(0.1);
    expect(week.pointsAwarded).toBe(0.5);
    expect(stale.pointsAwarded).toBe(1);
    expect(missing.pointsAwarded).toBe(5);
    expect(newDrink.pointsAwarded).toBe(5);
  });

  it("unlocks contributor premium at 15 monthly points until month end", () => {
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
      const submission = service.createSubmission(user, createSubmissionSchema.parse({
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
      })).submission;
      service.reviewSubmission(admin, submission.id, {
        status: "approved",
        rejectionReason: null,
        fraudFlagged: false,
        confidence: "photo_verified",
      });
    }

    const updated = repository.getAccountById(user.id)!;
    const now = new Date();
    const expectedMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999)).toISOString();
    expect(updated.contributionPointsCurrentMonth).toBe(15);
    expect(updated.subscriptionStatus).toBe("contributor_unlocked");
    expect(updated.premiumUntil).toBe(expectedMonthEnd);
  });

  it("redacts sensitive metadata before writing security audit rows", () => {
    const { repository } = createRepository();

    repository.insertSecurityAuditLog({
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

    const metadata = repository.listSecurityAuditLogs(1)[0]?.metadata ?? {};
    expect(metadata.safe).toBe("kept");
    expect(metadata.token).toBe("[REDACTED]");
    expect(metadata.email).toBe("[REDACTED]");
    expect(metadata.phone).toBe("[REDACTED]");
  });

  it("does not expose another user's source upload through the non-admin submission queue", () => {
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

    expect(service.listSubmissions(otherUser, { mine: false, limit: 10 })).toEqual([]);
  });

  it("keeps source evidence private and serves it only through short-lived signed URLs", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      PUBLIC_BASE_URL: "https://beer.example.test",
      SOURCE_EVIDENCE_SIGNING_SECRET: "test-source-evidence-signing-secret-32-bytes",
      SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS: 120,
    });
    const owner = createAccount(repository, "source-private-owner");
    const otherUser = createAccount(repository, "source-private-other");
    const admin = createAccount(repository, "source-private-admin", "admin");
    const submission = service.createSubmission(owner, createSubmissionSchema.parse({
      venueId: "venue-source-private",
      venueName: "Source Private Bar",
      suburb: "Melbourne",
      submissionType: "photo_upload",
      observedAt: NOW,
      sourcePhotoDataUrl: PNG_DATA_URL,
      sourcePhotoUrl: null,
      notes: null,
      items: [],
    })).submission;

    expect(submission.sourcePhotoUrl).toMatch(/^private:evidence:/);
    expect(submission.sourcePhotoUrl).not.toContain("data:image");
    expect(() => service.getSubmissionSourceEvidenceUrl(otherUser, submission.id)).toThrow("own source evidence");

    const ownerSigned = service.getSubmissionSourceEvidenceUrl(owner, submission.id);
    const adminSigned = service.getSubmissionSourceEvidenceUrl(admin, submission.id);
    expect(ownerSigned.signedUrl).toContain("/api/business/source-evidence/");
    expect(adminSigned.signedUrl).toContain("/api/business/source-evidence/");

    const signedUrl = new URL(ownerSigned.signedUrl!);
    const evidence = service.getSourceEvidenceForSignedRequest({
      evidenceId: signedUrl.pathname.split("/").pop()!,
      expires: signedUrl.searchParams.get("expires") ?? undefined,
      signature: signedUrl.searchParams.get("signature") ?? undefined,
    });
    expect(evidence.mimeType).toBe("image/png");
    expect(evidence.dataBase64).toBeTruthy();
    expect(() => service.getSourceEvidenceForSignedRequest({
      evidenceId: evidence.id,
      expires: "1",
      signature: signedUrl.searchParams.get("signature") ?? undefined,
    })).toThrow("expired");
    expect(() => service.getSourceEvidenceForSignedRequest({
      evidenceId: evidence.id,
      expires: signedUrl.searchParams.get("expires") ?? undefined,
      signature: "0".repeat(64),
    })).toThrow("Invalid source evidence signature");
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
    expect(demoService.handleDemoSubscription(user, "monthly").account.subscriptionStatus).toBe("premium_monthly");
    await expect(stripeService.createCheckout(user, { plan: "monthly" })).rejects.toThrow("Stripe checkout is not configured");
    expect(() => stripeService.handleDemoSubscription(user, "monthly")).toThrow("Demo billing is not enabled");
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
      globalThis.fetch = (async (_url, init) => {
        checkoutRequestBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_return" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      await expect(service.createCheckout(user, { plan: "monthly" })).resolves.toMatchObject({ mode: "stripe" });
      expect(decodeURIComponent(checkoutRequestBody)).toContain("checkout=success");
      expect(decodeURIComponent(checkoutRequestBody)).toContain("session_id={CHECKOUT_SESSION_ID}");

      globalThis.fetch = (async (url) => {
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
      expect(repository.listSecurityAuditLogs(10).some((row) => row.action === "stripe_subscription_update")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
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
        "has not completed yet",
      );
      expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("free");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects expired, revoked, and suspended sessions and supports logout flows", () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const signup = service.signup({
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

    expect(service.getAccountFromAuthorization(authHeader, {
      ip: "203.0.113.10",
      userAgent: "Vitest Browser",
    })?.email).toBe("session-user@example.com");
    const touched = database
      .prepare("SELECT last_used_at, last_ip_hash, user_agent_hash FROM auth_sessions LIMIT 1")
      .get() as { last_used_at: string | null; last_ip_hash: string | null; user_agent_hash: string | null } | undefined;
    expect(touched?.last_used_at).toBeTruthy();
    expect(touched?.last_ip_hash).toHaveLength(32);
    expect(touched?.user_agent_hash).toHaveLength(32);

    expect(service.logout(authHeader).revoked).toBe(true);
    expect(service.getAccountFromAuthorization(authHeader)).toBeNull();

    const second = service.login({ email: "session-user@example.com", password: "password123" });
    expect(service.logoutAll(service.requireAccount(`Bearer ${second.token}`)).revokedCount).toBeGreaterThanOrEqual(1);
    expect(service.getAccountFromAuthorization(`Bearer ${second.token}`)).toBeNull();

    const expired = service.login({ email: "session-user@example.com", password: "password123" });
    database
      .prepare("UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?")
      .run("2020-01-01T00:00:00.000Z", crypto.createHash("sha256").update(expired.token).digest("hex"));
    expect(service.getAccountFromAuthorization(`Bearer ${expired.token}`)).toBeNull();

    const suspended = service.login({ email: "session-user@example.com", password: "password123" });
    repository.overrideUserStatus({
      userId: signup.account.id,
      status: "suspended",
      now: NOW,
    });
    expect(service.getAccountFromAuthorization(`Bearer ${suspended.token}`)).toBeNull();
  });

  it("verifies Stripe webhook signatures before updating subscriptions", () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "stripe-user");
    const service = createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_WEBHOOK_SECRET: "whsec_test",
    });
    const payload = {
      id: "evt_checkout_completed",
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_test",
          metadata: {
            user_id: user.id,
            subscription_status: "premium_yearly",
          },
        },
      },
    };
    const signed = createStripeSignature(payload, "whsec_test");

    expect(service.handleStripeWebhook(signed.body, signed.header)).toEqual({ received: true });
    expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("premium_yearly");
    expect(repository.getAccountById(user.id)?.stripeCustomerId).toBe("cus_test");
    expect(service.handleStripeWebhook(signed.body, signed.header)).toEqual({ received: true });
    expect(repository.listSecurityAuditLogs(10).filter((row) => row.action === "stripe_subscription_update")).toHaveLength(1);
    expect(() => service.handleStripeWebhook(signed.body, undefined)).toThrow("Missing Stripe webhook signature");
    const freshTimestamp = String(Math.floor(Date.now() / 1000));
    expect(() => service.handleStripeWebhook(signed.body, `t=${freshTimestamp},v1=bad`)).toThrow("Invalid Stripe webhook signature");
    expect(() => service.handleStripeWebhook(signed.body, `t=${freshTimestamp},v1=${"z".repeat(64)}`)).toThrow("Invalid Stripe webhook signature");
    const staleTimestamp = String(Math.floor(new Date(NOW).getTime() / 1000) - 600);
    const staleSigned = createStripeSignature({ ...payload, id: "evt_checkout_stale" }, "whsec_test", staleTimestamp);
    expect(() => service.handleStripeWebhook(staleSigned.body, staleSigned.header)).toThrow("Invalid Stripe webhook signature");
    expect(repository.listSecurityAuditLogs(10).some((row) => row.action === "stripe_webhook_signature_failed")).toBe(true);

    const deletedPayload = {
      id: "evt_subscription_deleted",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_user",
          customer: "cus_test",
        },
      },
    };
    const deletedSigned = createStripeSignature(deletedPayload, "whsec_test");
    expect(service.handleStripeWebhook(deletedSigned.body, deletedSigned.header)).toEqual({ received: true });
    expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("free");

    updateSubscription(repository, user.id, "premium_monthly");
    const failedPayload = {
      id: "evt_invoice_failed",
      type: "invoice.payment_failed",
      data: {
        object: {
          subscription: "sub_user",
          customer: "cus_test",
        },
      },
    };
    const failedSigned = createStripeSignature(failedPayload, "whsec_test");
    expect(service.handleStripeWebhook(failedSigned.body, failedSigned.header)).toEqual({ received: true });
    expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("free");
    expect(() => createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_WEBHOOK_SECRET: undefined,
    }).handleStripeWebhook(signed.body, signed.header)).toThrow("Stripe webhook secret is not configured");
  });
});

describe("business demo contribution model", () => {
  it("unlocks contributor access after enough approved unique-venue points", () => {
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

  it("caps reward points to one approved submission per user, venue, and month", () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "repeat-user");
    const admin = createAccount(repository, "admin", "admin");
    const first = createSubmission(repository, { id: "submission-1", userId: user.id, venueId: "venue-1" });
    const second = createSubmission(repository, { id: "submission-2", userId: user.id, venueId: "venue-1" });

    expect(approve(repository, first.id, admin.id).pointsAwarded).toBe(5);
    expect(approve(repository, second.id, admin.id).pointsAwarded).toBe(0);
    expect(repository.getAccountById(user.id)?.contributionPointsCurrentMonth).toBe(5);
  });

  it("assigns public account IDs and ranks approved submissions without exposing email addresses", () => {
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

    const leaderboard = service.getLeaderboard(firstUser, { period: "all_time", limit: 10 });
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
    expect(storedPass.status).toBe("active");
    expect(storedPass.code_hash).not.toBe(pass.code);

    const logout = service.logout(authHeader);
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

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "discount-venue-a",
      venueName: "Discount Venue A",
      suburb: "Fitzroy",
    });
    service.assignVenueManager(admin, {
      userId: otherManager.id,
      venueId: "discount-venue-b",
      venueName: "Discount Venue B",
      suburb: "Brunswick",
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

    expect(() =>
      service.redeemDiscountPass(unassignedManager, "discount-venue-a", {
        code: pass.code,
        specialId: null,
        itemName: "House pint",
        quantity: 1,
        estimatedSavingsCents: 300,
        notes: "Wrong venue attempt",
      }),
    ).toThrow("You can only access assigned venues.");

    const redemption = service.redeemDiscountPass(assignedManager, "discount-venue-a", {
      code: pass.code,
      specialId: "special-1",
      itemName: "House pint",
      quantity: 2,
      estimatedSavingsCents: 600,
      notes: "Staff confirmed at till.",
    });
    expect(() =>
      service.redeemDiscountPass(assignedManager, "discount-venue-a", {
        code: pass.code,
        specialId: "special-1",
        itemName: "Second attempt",
        quantity: 1,
        estimatedSavingsCents: 300,
        notes: "Replay attempt",
      }),
    ).toThrow("Discount code expired or not found.");

    const dashboard = service.getAccountDashboard(premiumUser);
    expect(redemption.accountId).toBe(premiumUser.publicAccountId);
    expect(redemption.venueName).toBe("Discount Venue A");
    expect(redemption.estimatedSavingsDollars).toBe(6);
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
    expect(dashboard.premiumMemberToolkit).toEqual(expect.objectContaining({
      enabled: true,
      status: "active",
      title: "Premium member toolkit",
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

  it("supports Pro venue POS discount webhooks with scoped tokens and privacy-safe venue stats", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "pos-discount-admin", "admin");
    const manager = createAccount(repository, "pos-discount-manager");

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "pos-discount-venue",
      venueName: "POS Discount Venue",
      suburb: "CBD",
    });
    service.upsertBarProfile(admin, "pos-discount-venue", {
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
      active: true,
    });
    service.upsertBarProfile(admin, "pos-basic-venue", {
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

    const assignedManager = repository.getAccountById(manager.id)!;
    const integration = service.getVenuePosIntegration(assignedManager, "pos-discount-venue");
    expect(integration.enabled).toBe(true);
    expect(integration.token).toMatch(/^[a-f0-9]{64}$/);
    expect(integration.payloadExample).toEqual(expect.objectContaining({
      venueId: "pos-discount-venue",
      discountAmountCents: 200,
    }));

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

    const redemption = service.redeemDiscountPassFromPos({
      venueId: "pos-discount-venue",
      code: pass.code,
      specialId: null,
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
    }, integration.token ?? "");

    expect(redemption.accountId).toBe(premiumUser.publicAccountId);
    expect(redemption.estimatedSavingsDollars).toBe(2);
    expect(redemption.redemption.redeemedByUserId).toBeNull();
    expect(redemption.redemption.metadata).toEqual(expect.objectContaining({
      source: "pos_webhook",
      redeemedByRole: "pos_webhook",
      posReference: "receipt-4242",
      terminalId: "front-bar-1",
      note: "safe note",
    }));
    expect(JSON.stringify(redemption.redemption.metadata)).not.toContain("should-not-store@example.com");

    expect(() =>
      service.redeemDiscountPassFromPos({
        venueId: "pos-discount-venue",
        code: pass.code,
        itemName: "Replay",
        quantity: 1,
        discountAmountCents: 200,
      }, integration.token ?? ""),
    ).toThrow("Discount code expired or not found.");

    expect(() =>
      service.redeemDiscountPassFromPos({
        venueId: "pos-basic-venue",
        code: pass.code,
        itemName: "Wrong venue",
        quantity: 1,
        discountAmountCents: 200,
      }, integration.token ?? ""),
    ).toThrow("Invalid POS webhook token.");

    const basicIntegration = service.getVenuePosIntegration(admin, "pos-basic-venue");
    expect(basicIntegration).toEqual(expect.objectContaining({
      enabled: false,
      proRequired: true,
      token: null,
    }));
    const basicVenueToken = crypto
      .createHmac("sha256", "test-pos-webhook-signing-secret-32-bytes")
      .update("pint-path-pos-redemption:pos-basic-venue")
      .digest("hex");
    const secondPass = await service.getDiscountPass(
      premiumUser,
      createSession(repository, premiumUser.id, "pos-discount-second-user-session-token"),
    );
    expect(() =>
      service.redeemDiscountPassFromPos({
        venueId: "pos-basic-venue",
        code: secondPass.code,
        itemName: "Basic venue POS attempt",
        quantity: 1,
        discountAmountCents: 100,
      }, basicVenueToken),
    ).toThrow("Pro venue tier required for POS webhook redemptions.");

    const portal = service.getVenuePortal(assignedManager, { venueId: "pos-discount-venue" });
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

  it("publishes approved submission items as photo-verified public price records", () => {
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

    expect(repository.listLatestPriceRecords(10)).toEqual([
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

  it("increments fraud strikes and suspends reward earning after three fraud flags", () => {
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
          headers: expect.objectContaining({
            "X-Goog-Api-Key": "test-google-places-key",
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requires user new-venue submissions to verify a Google place server-side", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, {
      GOOGLE_PLACES_API_KEY: "test-google-places-key",
    });
    const user = createAccount(repository, "locked-venue-submit-user");
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
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sorts high-value missions by weighted points", () => {
    const { repository } = createRepository();

    repository.createMission({
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
    repository.createMission({
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

    const missions = repository.listMissions({ activeOnly: true, limit: 10 });
    expect(missions.map((mission) => mission.id)).toEqual(["mission-high", "mission-normal"]);
  });

  it("scales mission points by freshness and supports nearby and address search", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const freshAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const staleAt = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();

    repository.createMission({
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
    repository.createMission({
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
    repository.createMission({
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

    const missions = service.listMissions({ limit: 20, sort: "points" });
    const byId = new Map(missions.map((mission) => [mission.id, mission]));
    expect(byId.get("mission-fresh")?.points).toBe(0.1);
    expect(byId.get("mission-stale")?.points).toBe(1);
    expect(byId.get("mission-new-drinks")?.points).toBe(5);
    expect(byId.get("mission-fresh")?.freshnessLabel).toBe("Updated in the last 24 hours");
    expect(byId.get("mission-stale")?.freshnessLabel).toBe("Stale for 7+ days");

    const nearby = service.listMissions({
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

    const searched = service.listMissions({ q: "smith", sort: "points", limit: 20 });
    expect(searched.map((mission) => mission.id)).toContain("mission-new-drinks");

    const area = await service.resolveMissionArea("Smith Street");
    expect(area.location).toEqual(expect.objectContaining({
      latitude: -37.815,
      longitude: 144.984,
      label: "New Tap Room, Collingwood",
      source: "local_cache",
    }));
  });

  it("auto-generates mission values from venue coverage, beer gaps, and freshness", () => {
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

    const missions = service.listMissions({ limit: 50, sort: "points" });
    const byId = new Map(missions.map((mission) => [mission.id, mission]));

    expect(byId.get("auto:venue:auto-empty:coverage")).toEqual(expect.objectContaining({
      points: 5,
      reason: "New or empty venue - add first verified beer prices",
    }));
    expect(byId.get("auto:venue:auto-fresh:beer:guinness")).toEqual(expect.objectContaining({
      points: 0.1,
      reason: expect.stringContaining("recently updated"),
    }));
    expect(byId.get("auto:venue:auto-fresh:beer:carlton_draft")).toEqual(expect.objectContaining({
      points: 5,
      reason: "Missing Carlton Draught price - add this drink",
    }));
    expect(byId.get("auto:venue:auto-stale:menu-freshness")).toEqual(expect.objectContaining({
      points: 1,
      reason: expect.stringContaining("Stale drink menu"),
    }));
  });

  it("stores only aggregate analytics preview counts for admin review", () => {
    const { repository } = createRepository();

    repository.recordEvent({
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
    repository.recordEvent({
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

    const preview = repository.getAnalyticsPreview();
    expect(preview.topSearchedBeers).toEqual([{ key: "carlton_draft", count: 1 }]);
    expect(preview.topClickedVenues).toEqual([{ key: "venue-1", label: "Corner Hotel", count: 1 }]);
    expect(preview.topSuburbs).toEqual([{ key: "Richmond", count: 2 }]);
  });

  it("labels high-demand stale venue buckets for admin review", () => {
    const { repository } = createRepository();

    repository.recordEvent({
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

    const dashboard = repository.getAdminKpiDashboard({
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

  it("suppresses low-count analytics buckets through admin service views", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, { ANALYTICS_MIN_BUCKET_SIZE: 2 });
    const admin = createAccount(repository, "analytics-admin", "admin");

    repository.recordEvent({
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
    repository.recordEvent({
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
    repository.recordEvent({
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

    const preview = service.getAnalyticsPreview(admin);
    expect(preview.topSearchedBeers).toEqual([{ key: "carlton_draft", count: 2 }]);
    expect(preview.suppressedBelowCount).toBe(2);
  });

  it("records near-me events without storing precise coordinates", () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "near-me-user");

    service.trackEvent(user, {
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
    service.trackEvent(user, {
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
    const dashboard = repository.getAdminKpiDashboard({
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

  it("captures privacy-safe search and click intent for paid venue reports", () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "intent-user");

    service.trackEvent(user, {
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
    service.trackEvent(user, {
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

    const dashboard = repository.getAdminKpiDashboard({
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

  it("stores onboarding preferences and saved items for retention shortcuts", () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "saved-user");

    const preferences = repository.upsertAccountPreferences({
      userId: user.id,
      preferredSuburbs: ["Fitzroy", "Richmond"],
      preferredBeers: ["Guinness"],
      preferredUseCases: ["happy_hours"],
      onboardingCompletedAt: NOW,
      now: NOW,
    });
    const saved = repository.saveItem({
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
    expect(repository.listSavedItems(user.id)).toHaveLength(1);
    const nightPlan = repository.saveItem({
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
    expect(repository.listSavedItems(user.id)).toHaveLength(2);
    expect(repository.removeSavedItem({ userId: user.id, itemType: "suburb", itemId: "fitzroy" })).toBe(true);
    expect(repository.removeSavedItem({ userId: user.id, itemType: "night_plan", itemId: "current-night-plan" })).toBe(true);
    expect(repository.listSavedItems(user.id)).toHaveLength(0);
  });

  it("marks a price record disputed after multiple wrong-price reports", () => {
    const { repository } = createRepository();
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
    const priceRecord = repository.listLatestPriceRecords(1)[0]!;
    repository.createWrongPriceReport({
      id: "report-1",
      userId: user.id,
      anonymousSessionId: null,
      venueId: "venue-1",
      venueName: "Price Report Bar",
      priceRecordId: priceRecord.id,
      beerName: priceRecord.beerName,
      reason: "price_changed",
      notes: "Board showed a different price.",
      sourcePhotoUrl: null,
      now: NOW,
    });
    const second = repository.createWrongPriceReport({
      id: "report-2",
      userId: otherUser.id,
      anonymousSessionId: null,
      venueId: "venue-1",
      venueName: "Price Report Bar",
      priceRecordId: priceRecord.id,
      beerName: priceRecord.beerName,
      reason: "price_changed",
      notes: "Confirmed changed.",
      sourcePhotoUrl: null,
      now: NOW,
    });

    expect(second.markedDisputed).toBe(true);
    expect(repository.listLatestPriceRecords(1)[0]?.confidence).toBe("disputed");
  });

  it("records requests, KPI counts, retention cohorts, and partner lead signals", () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "retention-user");

    repository.createVenueRequest({
      id: "request-1",
      userId: user.id,
      anonymousSessionId: null,
      requestType: "verify_venue",
      venueId: "venue-1",
      venueName: "Requested Bar",
      beerName: null,
      suburb: "Richmond",
      notes: "Popular venue.",
      now: NOW,
    });
    repository.recordEvent({
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
    repository.recordEvent({
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
    repository.recordEvent({
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

    const dashboard = repository.getAdminKpiDashboard({
      since: null,
      sevenDaysAgo: "2026-04-27T00:00:00.000Z",
      thirtyDaysAgo: "2026-04-04T00:00:00.000Z",
      staleBefore: "2026-02-04T00:00:00.000Z",
      totalVenues: 3,
    });
    const cohorts = repository.getRetentionCohorts({ groupBy: "week", limit: 4 });
    const leads = repository.getPotentialPartnerLeads({
      staleBefore: "2026-02-04T00:00:00.000Z",
      limit: 5,
    });

    expect(repository.listVenueRequests(10)).toHaveLength(1);
    expect(dashboard.metrics.totalBeerSearches).toBe(1);
    expect(dashboard.topSearchedBeers).toEqual([{ key: "guinness", count: 1 }]);
    expect(cohorts[0]).toEqual(expect.objectContaining({ users: 1, returned7: 1, returned30: 1 }));
    expect(leads[0]).toEqual(expect.objectContaining({
      venueId: "venue-1",
      requests: 1,
      dataFreshness: "stale_or_missing",
    }));
  });

  it("supports venue partner interest, manager assignments, and assigned-venue portal access", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "venue-admin", "admin");
    const manager = createAccount(repository, "venue-manager");
    const normalUser = createAccount(repository, "venue-normal");

    const interest = service.createVenueInterest(null, {
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
    expect(service.getVenuePortal(normalUser, { venueId: "venue-1" })).toEqual(expect.objectContaining({
      accessState: "invite_required",
      selectedVenue: null,
    }));
    expect(() => service.createBarClaimRequest(normalUser, {
      barId: "venue-1",
      barName: "Rooftop Bar",
      address: "Level 7, Melbourne",
      suburb: "Melbourne",
      requesterName: "Normal User",
      requesterRole: "Venue manager",
      contactEmail: "normal@example.com",
      contactPhone: null,
      message: "I manage this venue.",
    })).toThrow("Venue manager access is invite-only");
    expect(service.getVenuePortal(normalUser, { venueId: "venue-1" }).claimRequests).toHaveLength(0);

    const assignment = service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "venue-1",
      venueName: "Rooftop Bar",
      suburb: "Melbourne",
    });
    const managerAccount = repository.getAccountById(manager.id)!;

    expect(assignment.assignment.status).toBe("active");
    expect(managerAccount.role).toBe("venue_manager");
    expect(service.searchAccountsForAdmin(admin, { q: "venue-manager", limit: 10 }).accounts).toEqual([
      expect.objectContaining({
        id: manager.id,
        email: "venue-manager@example.com",
        role: "venue_manager",
      }),
    ]);
    expect(() => service.searchAccountsForAdmin(normalUser, { q: "venue-manager", limit: 10 })).toThrow("Admin access required");

    const portal = service.getVenuePortal(managerAccount, { venueId: "venue-1" });
    expect(portal.selectedVenue).toEqual(expect.objectContaining({
      venueId: "venue-1",
      venueName: "Rooftop Bar",
    }));
    expect(portal.privacyCopy).toContain("privacy-safe");
    expect(() => service.getVenuePortal(managerAccount, { venueId: "venue-2" })).toThrow("assigned venues");

    const update = service.createVenueManagerSubmission(managerAccount, "venue-1", {
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

    const partnerAdmin = service.getVenuePartnerAdmin(admin);
    expect(partnerAdmin.interests[0]).toEqual(expect.objectContaining({ venueName: "Rooftop Bar" }));
    expect(partnerAdmin.claimRequests).toEqual([]);
    expect(partnerAdmin.assignments[0]).toEqual(expect.objectContaining({ userId: manager.id, venueId: "venue-1" }));

    const revoked = service.revokeVenueManager(admin, { userId: manager.id, venueId: "venue-1" });
    expect(revoked.assignment.status).toBe("revoked");
  });

  it("requires a verified account before bar portal or claim access", () => {
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

    expect(() => service.getVenuePortal(unverified, {})).toThrow("Verify your account");
    expect(() => service.createBarClaimRequest(unverified, {
      barId: null,
      barName: "Example Bar",
      address: "1 Test St",
      suburb: "Fitzroy",
      requesterName: "Taylor",
      requesterRole: "Owner",
      contactEmail: "taylor@example.com",
      contactPhone: null,
      message: null,
    })).toThrow("Verify your account");
  });

  it("keeps venue-manager edits pending until admin review publishes them", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "bar-admin", "admin");
    const manager = createAccount(repository, "bar-manager");
    const otherManager = createAccount(repository, "bar-other-manager");
    const normalUser = createAccount(repository, "bar-normal");

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "bar-1",
      venueName: "Corner Hotel",
      suburb: "Richmond",
    });
    service.assignVenueManager(admin, {
      userId: otherManager.id,
      venueId: "bar-2",
      venueName: "Moon Dog OG",
      suburb: "Abbotsford",
    });
    const managerAccount = repository.getAccountById(manager.id)!;
    const otherManagerAccount = repository.getAccountById(otherManager.id)!;

    expect(() => service.upsertBarBeer(normalUser, "bar-1", {
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
    })).toThrow("Venue manager access required.");
    expect(() => service.upsertBarBeer(managerAccount, "bar-2", {
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
    })).toThrow("assigned venues");

    const profile = service.upsertBarProfile(managerAccount, "bar-1", {
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
    const profilePending = pendingBarChangeFrom(profile);
    expect(profilePending.status).toBe("pending");
    expect(profilePending.changeType).toBe("profile");
    expect(repository.getBarProfile("bar-1")).toBeNull();

    expect(() => service.upsertBarSpecial(managerAccount, "bar-1", {
      id: null,
      title: "Free tier special attempt",
      description: "Should not be accepted on the Free tier.",
      price: 20,
      discount: null,
      startsAt: null,
      endsAt: null,
      scheduleNote: null,
      exclusive: true,
      active: true,
    })).toThrow("Plus or Pro venue tier required");

    service.upsertBarProfile(admin, "bar-1", {
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
      membershipTier: "plus",
      active: true,
    });
    expect(repository.getBarProfile("bar-1")?.membershipTier).toBe("plus");

    expect(() => service.upsertBarSpecial(managerAccount, "bar-1", {
      id: null,
      title: "Featured Plus attempt",
      description: "Plus can add specials, but featured exclusives require Pro.",
      price: 25,
      discount: null,
      startsAt: null,
      endsAt: null,
      scheduleNote: "Thursdays from 5pm",
      exclusive: true,
      active: true,
    })).toThrow("Pro venue tier required");

    const beer = service.upsertBarBeer(managerAccount, "bar-1", {
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
    });
    const happyHour = service.upsertBarHappyHour(managerAccount, "bar-1", {
      id: null,
      title: "Weekday happy hour",
      daysOfWeek: ["mon", "tue", "wed", "thu", "fri"],
      startTime: "16:00",
      endTime: "18:00",
      description: "$9 house pints, selected taps only.",
      active: true,
    });
    const special = service.upsertBarSpecial(managerAccount, "bar-1", {
      id: null,
      title: "Thursday burger and pint",
      description: "Burger and selected pint special.",
      price: 25,
      discount: null,
      startsAt: null,
      endsAt: null,
      scheduleNote: "Thursdays from 5pm",
      exclusive: false,
      active: true,
    });

    const beerPending = pendingBarChangeFrom(beer);
    const happyHourPending = pendingBarChangeFrom(happyHour);
    const specialPending = pendingBarChangeFrom(special);
    expect(beerPending).toEqual(expect.objectContaining({ status: "pending", changeType: "beer", action: "upsert" }));
    expect(happyHourPending).toEqual(expect.objectContaining({ status: "pending", changeType: "happy_hour", action: "upsert" }));
    expect(specialPending).toEqual(expect.objectContaining({ status: "pending", changeType: "special", action: "upsert" }));

    const portal = service.getVenuePortal(managerAccount, { venueId: "bar-1" });
    expect(portal.pendingChanges).toHaveLength(4);
    expect(portal.pendingChanges.map((change) => change.changeType)).toEqual(expect.arrayContaining(["profile", "beer", "happy_hour", "special"]));
    expect(portal.inventory.beers).toHaveLength(0);
    expect(portal.inventory.happyHours).toHaveLength(0);
    expect(portal.inventory.specials).toHaveLength(0);
    expect(portal.tier.analyticsLocked).toBe(false);

    const adminPortal = service.getVenuePortal(admin, { venueId: "bar-1" });
    expect(adminPortal.pendingChanges).toHaveLength(4);
    expect(service.getVenuePartnerAdmin(admin).pendingChanges).toHaveLength(4);
    expect(service.getVenuePortal(otherManagerAccount, { venueId: "bar-2" }).pendingChanges).toHaveLength(0);
    expect(() => service.getVenuePortal(otherManagerAccount, { venueId: "bar-1" })).toThrow("assigned venues");

    const publicBeforeApproval = service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-before-approval",
      reveal: true,
    });
    expect(publicBeforeApproval.records).toEqual([]);

    for (const change of [profilePending, beerPending, happyHourPending, specialPending]) {
      const review = service.reviewBarPendingChange(admin, change.id, { status: "approved", rejectionReason: null });
      expect(review.pendingChange?.status).toBe("approved");
    }

    const approvedPortal = service.getVenuePortal(managerAccount, { venueId: "bar-1" });
    expect(approvedPortal.profile.membershipTier).toBe("plus");
    expect(approvedPortal.profile.highlightedName).toBe(false);
    expect(approvedPortal.inventory.beers).toHaveLength(1);
    expect(approvedPortal.inventory.happyHours).toHaveLength(1);
    expect(approvedPortal.inventory.specials).toHaveLength(1);
    expect(approvedPortal.pendingChanges).toHaveLength(0);
    expect(approvedPortal.tier.analyticsLocked).toBe(false);

    const publicPreview = service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-preview-anon",
      reveal: false,
    });
    expect(publicPreview.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        beerName: "Carlton Draught",
        price: 13,
        freePreviewIncluded: true,
        sourceType: "venue_manager_portal",
      }),
      expect.objectContaining({
        displayKind: "happy_hour",
        happyHourDetails: "$9 house pints, selected taps only.",
        happyHourStartTime: "16:00",
        happyHourEndTime: "18:00",
        sourceType: "venue_manager_portal",
        freePreviewIncluded: true,
      }),
      expect.objectContaining({
        displayKind: "special",
        beerName: "Venue special",
        price: null,
        priceRedacted: true,
        specialExclusive: false,
        specialDescription: null,
        specialDiscount: null,
        sourceType: "venue_manager_portal:special",
      }),
    ]));

    const revealed = service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-reveal-anon",
      reveal: true,
    });
    expect(revealed.revealed).toBe(true);
    expect(revealed.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        beerName: "Carlton Draught",
        price: 13,
        confidence: "venue_confirmed",
        sourceType: "venue_manager_portal",
      }),
      expect.objectContaining({
        displayKind: "happy_hour",
        happyHourDetails: "$9 house pints, selected taps only.",
        happyHourStartTime: "16:00",
        happyHourEndTime: "18:00",
      }),
    ]));
    expect(revealed.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        displayKind: "special",
        beerName: "Venue special",
        priceRedacted: true,
        specialDescription: null,
      }),
    ]));

    const adminRecords = service.listPriceRecords(admin, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: null,
      reveal: true,
    });
    expect(adminRecords.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        displayKind: "special",
        beerName: "Thursday burger and pint",
        price: 25,
        specialTitle: "Thursday burger and pint",
        specialDescription: "Burger and selected pint special.",
        specialScheduleNote: "Thursdays from 5pm",
        specialExclusive: false,
      }),
    ]));

    const hideAttempt = service.upsertBarProfile(managerAccount, "bar-1", {
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
    });
    const hidePending = pendingBarChangeFrom(hideAttempt);
    expect(hidePending.status).toBe("pending");

    expect(service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-inactive-preview",
      reveal: true,
    }).records.length).toBeGreaterThan(0);

    const rejected = service.reviewBarPendingChange(admin, hidePending.id, {
      status: "rejected",
      rejectionReason: "Keep listing live until confirmed by admin.",
    });
    expect(rejected.pendingChange?.status).toBe("rejected");
    expect(service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-rejected-preview",
      reveal: true,
    }).records.length).toBeGreaterThan(0);

    const approvedBeerId = beerPending.targetId!;
    const priceBypassAttempt = service.upsertBarBeer(managerAccount, "bar-1", {
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
    });
    const priceBypassPending = pendingBarChangeFrom(priceBypassAttempt);
    expect(priceBypassPending.status).toBe("pending");
    const beforePriceApproval = service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-direct-bypass",
      reveal: true,
    });
    expect(beforePriceApproval.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ beerName: "Carlton Draught", price: 13 }),
    ]));

    service.reviewBarPendingChange(admin, priceBypassPending.id, {
      status: "approved",
      rejectionReason: null,
    });
    const afterPriceApproval = service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-after-price-approval",
      reveal: true,
    });
    expect(afterPriceApproval.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ beerName: "Carlton Draught", price: 15.5 }),
    ]));
  });

  it("limits Free venue accounts to beer and happy-hour data", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "free-bar-admin", "admin");
    const manager = createAccount(repository, "free-bar-manager");

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "free-bar-1",
      venueName: "Free Bar",
      suburb: "Brunswick",
    });
    service.upsertBarProfile(admin, "free-bar-1", {
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

    const freePortal = service.getVenuePortal(managerAccount, { venueId: "free-bar-1" });
    expect(freePortal.tier.canManageSpecials).toBe(false);
    expect(freePortal.tier.analyticsLocked).toBe(true);
    expect(freePortal.analytics).toBeNull();

    expect(service.upsertBarBeer(managerAccount, "free-bar-1", {
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
    })).toEqual(expect.objectContaining({ pendingChange: expect.objectContaining({ changeType: "beer" }) }));
    expect(service.upsertBarHappyHour(managerAccount, "free-bar-1", {
      id: null,
      title: "Weekday happy hour",
      daysOfWeek: ["mon"],
      startTime: "16:00",
      endTime: "18:00",
      description: "$9 pints.",
      active: true,
    })).toEqual(expect.objectContaining({ pendingChange: expect.objectContaining({ changeType: "happy_hour" }) }));
    expect(() => service.upsertBarSpecial(managerAccount, "free-bar-1", {
      id: null,
      title: "Free tier special attempt",
      description: "Should not be accepted on Free.",
      price: 20,
      discount: null,
      startsAt: null,
      endsAt: null,
      scheduleNote: null,
      exclusive: true,
      active: true,
    })).toThrow("Plus or Pro venue tier required");
  });

  it("keeps direct venue-portal API writes pending until admin approval", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "api-bar-admin", "admin");
    const manager = createAccount(repository, "api-bar-manager");

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "api-bar-1",
      venueName: "API Bar",
      suburb: "Carlton",
    });
    service.upsertBarProfile(admin, "api-bar-1", {
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
      const body = await response.json() as { data: { pendingChange: BarPendingChange } };
      expect(body.data.pendingChange).toEqual(expect.objectContaining({ status: "pending", changeType: "beer" }));

      const publicBefore = await fetch(`${baseUrl}/api/business/price-records?venueId=api-bar-1&limit=20&reveal=true&anonymousSessionId=api-api-before`);
      expect((await publicBefore.json()).data.records).toEqual([]);

      service.reviewBarPendingChange(admin, body.data.pendingChange.id, { status: "approved", rejectionReason: null });

      const publicAfter = await fetch(`${baseUrl}/api/business/price-records?venueId=api-bar-1&limit=20&reveal=true&anonymousSessionId=api-api-after`);
      expect((await publicAfter.json()).data.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ beerName: "Asahi Super Dry", price: null, priceRedacted: true }),
      ]));
    });
  });

  it("blocks normal users from direct venue-manager claim API access", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "direct-claim-user");
    const token = "direct-claim-user-token";
    createSession(repository, user.id, token);

    const app = express();
    app.use(express.json());
    app.use("/api/business", createBusinessRouter(service));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/business/venue-claim-requests`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          venueName: "Direct Claim Pub",
          address: "1 Test Street",
          suburb: "Fitzroy",
          requesterName: "Normal User",
          requesterRole: "Owner",
          contactEmail: "normal@example.com",
          contactPhone: null,
          message: "Trying to bypass the invite-only portal.",
        }),
      });

      expect(response.status).toBe(403);
      const body = await response.json() as { error: { message: string } };
      expect(body.error.message).toContain("Admin access required");
      expect(repository.listBarClaimRequests({ limit: 10 })).toHaveLength(0);
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

  it("keeps venue-manager insights privacy-safe and suppresses low-count suburb demand buckets", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, { ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = createAccount(repository, "portal-privacy-admin", "admin");
    const manager = createAccount(repository, "portal-privacy-manager");
    const submitter = createAccount(repository, "portal-privacy-submitter");

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "privacy-bar",
      venueName: "Privacy Bar",
      suburb: "Fitzroy",
    });
    const managerAccount = repository.getAccountById(manager.id)!;
    service.upsertBarProfile(admin, "privacy-bar", {
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
      membershipTier: "plus",
      active: true,
    });
    createSubmission(repository, {
      id: "private-submission",
      userId: submitter.id,
      venueId: "privacy-bar",
      venueName: "Privacy Bar",
      sourcePhotoUrl: PNG_DATA_URL,
    });
    repository.createWrongPriceReport({
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
    repository.createVenueRequest({
      id: "private-request",
      userId: submitter.id,
      anonymousSessionId: "request-anon-session",
      requestType: "verify_venue",
      venueId: "privacy-bar",
      venueName: "Privacy Bar",
      beerName: null,
      suburb: "Fitzroy",
      notes: "Please verify. Contact test@example.com.",
      now: NOW,
    });

    for (let index = 0; index < 9; index += 1) {
      repository.recordEvent({
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
      repository.recordEvent({
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

    const portal = service.getVenuePortal(managerAccount, { venueId: "privacy-bar" });
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

  it("gates bar analytics by tier and enables Pro display metadata", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "bar-tier-admin", "admin");
    const manager = createAccount(repository, "bar-tier-manager");

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "bar-tier-1",
      venueName: "Railway Hotel",
      suburb: "South Melbourne",
    });
    const managerAccount = repository.getAccountById(manager.id)!;

    for (let index = 0; index < 10; index += 1) {
      repository.recordEvent({
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
    repository.recordEvent({
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

    const plusProfile = service.upsertBarProfile(admin, "bar-tier-1", {
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
      membershipTier: "plus",
      active: true,
    });
    expect(plusProfile.profile.membershipTier).toBe("plus");

    const plusPortal = service.getVenuePortal(managerAccount, { venueId: "bar-tier-1" });
    expect(plusPortal.tier.analyticsLocked).toBe(false);
    expect(plusPortal.tier.canManageSpecials).toBe(true);
    expect(plusPortal.tier.featuredSpecials).toBe(false);
    expect(plusPortal.tier.priorityReview).toBe(false);
    expect(plusPortal.tier.advancedRecommendations).toBe(false);
    expect(plusPortal.analytics?.barLookups).toBe(1);
    expect(plusPortal.analytics?.privacyFloorMet).toBe(true);
    expect(plusPortal.analytics?.areaBeerSearches.length).toBeGreaterThan(0);
    expect(plusPortal.monthlyReport?.data).toBeTruthy();
    expect(plusPortal.businessToolkit?.plusDemandSnapshot).toEqual(expect.objectContaining({
      title: "Suburb demand snapshot",
      privacyFloorMet: true,
      recommendedNextActions: expect.arrayContaining([expect.any(String)]),
    }));
    expect(plusPortal.businessToolkit?.proGrowthPlan).toBeNull();
    expect(plusPortal.monthlyReport?.data?.summary).toEqual(expect.objectContaining({
      plusDemandSnapshot: expect.objectContaining({
        opportunityScore: expect.any(Number),
      }),
    }));

    const proProfile = service.upsertBarProfile(admin, "bar-tier-1", {
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
    expect(proProfile.profile.highlightedName).toBe(true);
    expect(proProfile.profile.premiumBadge).toBe("Pro");
    expect(proProfile.profile.promoted).toBe(true);
    expect(proProfile.profile.featuredSpecialEligible).toBe(true);

    const proPortal = service.getVenuePortal(managerAccount, { venueId: "bar-tier-1" });
    expect(proPortal.tier.featuredSpecials).toBe(true);
    expect(proPortal.tier.priorityReview).toBe(true);
    expect(proPortal.tier.advancedRecommendations).toBe(true);
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
      proRecommendations: expect.arrayContaining([
        expect.any(String),
      ]),
      proGrowthPlan: expect.objectContaining({
        title: "Pro growth studio",
      }),
      discoveryPlacement: expect.objectContaining({
        premiumDisplay: true,
        discoveryBoost: true,
        featuredSpecials: true,
        priorityReview: true,
      }),
    }));

    const proSpecial = service.upsertBarSpecial(managerAccount, "bar-tier-1", {
      id: null,
      title: "Friday Pint Path exclusive",
      description: "A genuine Pro-only offer ready for review.",
      price: 18,
      discount: null,
      startsAt: null,
      endsAt: null,
      scheduleNote: "Friday 5pm-7pm",
      exclusive: true,
      active: true,
    });
    expect(pendingBarChangeFrom(proSpecial).payload.exclusive).toBe(true);
  });

  it("prioritises Pro venue changes in the admin review queue", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "priority-review-admin", "admin");
    const proManager = createAccount(repository, "priority-pro-manager");
    const plusManager = createAccount(repository, "priority-plus-manager");

    service.assignVenueManager(admin, {
      userId: proManager.id,
      venueId: "priority-pro-bar",
      venueName: "Priority Pro Bar",
      suburb: "Fitzroy",
    });
    service.assignVenueManager(admin, {
      userId: plusManager.id,
      venueId: "priority-plus-bar",
      venueName: "Priority Plus Bar",
      suburb: "Richmond",
    });
    service.upsertBarProfile(admin, "priority-pro-bar", {
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
    service.upsertBarProfile(admin, "priority-plus-bar", {
      name: "Priority Plus Bar",
      address: null,
      suburb: "Richmond",
      area: "Richmond",
      phone: null,
      website: null,
      instagram: null,
      description: "Plus review queue smoke venue.",
      openingHours: {},
      venueTags: [],
      membershipTier: "plus",
      active: true,
    });

    service.upsertBarBeer(repository.getAccountById(proManager.id)!, "priority-pro-bar", {
      id: null,
      beerName: "Pro Lager",
      brewery: null,
      style: "Lager",
      abv: null,
      serveSize: "pint",
      price: 14,
      onTap: true,
      inStock: true,
      notes: null,
    });
    service.upsertBarBeer(repository.getAccountById(plusManager.id)!, "priority-plus-bar", {
      id: null,
      beerName: "Plus Lager",
      brewery: null,
      style: "Lager",
      abv: null,
      serveSize: "pint",
      price: 13,
      onTap: true,
      inStock: true,
      notes: null,
    });

    expect(service.getVenuePartnerAdmin(admin).pendingChanges[0]?.barId).toBe("priority-pro-bar");
  });

  it("exposes only public tier metadata on venue discovery rows", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "public-tier-admin", "admin");

    service.seedDemoMissions();
    service.upsertBarProfile(admin, "demo:rooftop-bar", {
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
      active: true,
    });

    const venues = await service.listVenues(undefined, 20);
    const proVenue = venues.find((venue) => venue.id === "demo:rooftop-bar");
    const freeVenue = venues.find((venue) => venue.id === "demo:fitzroy-beer-garden");

    expect(proVenue?.membershipTier).toBe("pro");
    expect(proVenue?.premiumBadge).toBe("Pro");
    expect(proVenue?.highlightedName).toBe(true);
    expect(proVenue?.promoted).toBe(true);
    expect(proVenue).not.toHaveProperty("stripeCustomerId");
    expect(proVenue).not.toHaveProperty("stripeSubscriptionId");
    expect(freeVenue?.membershipTier).toBe("basic");
    expect(freeVenue?.premiumBadge).toBeNull();
  });

  it("serves a public venue detail lookup without private billing metadata", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "public-venue-detail-admin", "admin");

    service.upsertBarProfile(admin, "venue-detail-1", {
      name: "Moonlit Taproom",
      address: "10 Test Lane",
      suburb: "Fitzroy",
      area: "Fitzroy",
      phone: null,
      website: null,
      instagram: null,
      description: "A launch-ready venue.",
      openingHours: {},
      venueTags: [],
      membershipTier: "plus",
      active: true,
    });

    const venue = await service.getPublicVenueById("venue-detail-1");

    expect(venue?.name).toBe("Moonlit Taproom");
    expect(venue?.suburb).toBe("Fitzroy");
    expect(venue?.membershipTier).toBe("plus");
    expect(venue).not.toHaveProperty("stripeCustomerId");
    expect(await service.getPublicVenueById("missing-venue")).toBeNull();
  });

  it("activates Plus and Pro bar tiers through demo checkout without Stripe keys", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "bar-checkout-admin", "admin");
    const manager = createAccount(repository, "bar-checkout-manager");

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "bar-checkout-1",
      venueName: "Checkout Hotel",
      suburb: "Collingwood",
    });
    const managerAccount = repository.getAccountById(manager.id)!;

    const plusCheckout = await service.createBarTierCheckout(managerAccount, "bar-checkout-1", { tier: "plus" });
    expect(plusCheckout.mode).toBe("demo");
    expect(plusCheckout.profile.membershipTier).toBe("plus");
    expect(plusCheckout.tier.analyticsLocked).toBe(false);

    const proCheckout = await service.createBarTierCheckout(managerAccount, "bar-checkout-1", { tier: "pro" });
    expect(proCheckout.profile.membershipTier).toBe("pro");
    expect(proCheckout.profile.highlightedName).toBe(true);
    expect(proCheckout.profile.premiumBadge).toBe("Pro");
  });
});
