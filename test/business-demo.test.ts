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
import { BeerCatalogRepository } from "../src/db/beer-catalog.repository.js";
import { AdminIngestionQueueRepository } from "../src/db/admin-ingestion-queue.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { AppError } from "../src/lib/errors.js";
import { scheduleMissionMaintenance } from "../src/lib/mission-maintenance.js";
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
} from "../src/modules/business/business.schemas.js";
import { createBusinessRouter } from "../src/modules/business/business.routes.js";
import { BusinessService, canAccessAgeGatedRewards, sanitizePostgrestIlikeTerm } from "../src/modules/business/business.service.js";

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

it("accepts and normalizes consent source identifiers from every active client", () => {
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

let openDatabases: BetterSqlite3.Database[] = [];
let evidenceStorageDirs: string[] = [];
const repositoryDatabases = new WeakMap<BusinessRepository, BetterSqlite3.Database>();

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

  return {
    database,
    repository,
  };
}

function createBusinessService(
  repository: BusinessRepository,
  overrides: Partial<ConstructorParameters<typeof BusinessService>[1]> = {},
  menuPhotoOcr?: ConstructorParameters<typeof BusinessService>[3],
  supabaseClientOverride?: ConstructorParameters<typeof BusinessService>[4],
) {
  const evidenceStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-evidence-"));
  evidenceStorageDirs.push(evidenceStorageDir);

  return new BusinessService(repository, {
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
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
    STRIPE_PRO_PRICE_ID: undefined,
    SUPABASE_URL: undefined,
    SUPABASE_ANON_KEY: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SUPABASE_OAUTH_PROVIDERS: "google,apple",
    ADMIN_EMAILS: "admin@example.com",
    GOOGLE_MAPS_API_KEY: undefined,
    GOOGLE_PLACES_API_KEY: undefined,
    ...overrides,
  }, new BeerCatalogRepository(repositoryDatabases.get(repository)!), menuPhotoOcr, supabaseClientOverride);
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
    expect(service.listSubmissions(user, { mine: false, limit: 10, includeReviewData: true })).toEqual([ownSubmission]);
    expect(service.listSubmissions(admin, { mine: false, limit: 10, includeReviewData: true })).toEqual(expect.arrayContaining([
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

  it("adds idempotency columns before creating their indexes on legacy production tables", () => {
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
    expect(database.pragma("user_version", { simple: true })).toBe(11);
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
    const profile = repository.getProfileById(result.account.id);

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
    expect(repository.listUserActivityEvents(result.account.id, 10).map((event) => event.eventType))
      .toEqual(expect.arrayContaining(["user_signup", "user_login"]));

    const repeated = await service.loginWithSupabaseAccessToken(
      { accessToken },
      undefined,
      `Bearer ${result.token}`,
    );
    expect(repeated).toEqual(expect.objectContaining({ token: result.token, reused: true }));
    expect(repositoryDatabases.get(repository)!
      .prepare("SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL")
      .get(result.account.id)).toEqual({ count: 1 });
    expect(repository.listUserActivityEvents(result.account.id, 20).filter((event) => event.eventType === "user_login"))
      .toHaveLength(1);

    const session = service.listAccountSessions(linkedAccount!, `Bearer ${result.token}`, { limit: 10, offset: 0 }).sessions[0]!;
    expect(session.providerBacked).toBe(true);
    expect(service.revokeAccountSession(linkedAccount!, linkedAccount!.id, session.id).revoked).toBe(true);

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
    expect((await service.logoutAll(refreshedAccount, { accessToken: newProviderAccessToken })).revokedCount).toBeGreaterThan(0);
    expect(globalSignOut).toHaveBeenCalledWith(newProviderAccessToken, "global");
    await expect(service.loginWithSupabaseAccessToken({ accessToken: newProviderAccessToken }))
      .rejects.toThrow("sign-in provider session was revoked");

    const suspensionAccessToken = [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({ aal: "aal1", session_id: "provider-session-before-suspension" })).toString("base64url"),
      "suspension-test-signature-value",
    ].join(".");
    await service.loginWithSupabaseAccessToken({ accessToken: suspensionAccessToken });
    const admin = createAccount(repository, "provider-session-admin", "admin");
    service.adminOverrideUser(admin, refreshedAccount.id, {
      status: "suspended",
      reason: "Confirmed account-security incident.",
    });
    await expect(service.loginWithSupabaseAccessToken({ accessToken: suspensionAccessToken }))
      .rejects.toThrow("sign-in provider session was revoked");
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
        body: JSON.stringify({ accessToken: recoveryToken }),
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
    expect(resetAccount.providerTokensValidAfter).toBe(NOW);
    expect(repository.listSecurityAuditLogs({ action: "password_reset_completed" })).toHaveLength(1);
    expect(providerRefreshTokensRevoked).toBe(true);
    const refreshUnknownNeverSyncedProviderSession = () => providerRefreshTokensRevoked
      ? { data: null, error: { message: "refresh token revoked" } }
      : { data: { accessToken: token("password-reset-never-synced", "password", issuedAt + 120) }, error: null };
    expect(refreshUnknownNeverSyncedProviderSession()).toEqual(expect.objectContaining({ data: null }));
    await expect(service.loginWithSupabaseAccessToken({
      accessToken: token("password-reset-unseen-stale", "password", issuedAt + 90),
    })).rejects.toThrow("predates a security reset");
    await expect(service.loginWithSupabaseAccessToken({
      accessToken: token(
        "password-reset-fresh-sign-in",
        "password",
        Math.floor(new Date(NOW).getTime() / 1000) + 60,
      ),
    })).resolves.toEqual(expect.objectContaining({ token: expect.any(String) }));
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

  it("lists privacy-safe community verification candidates without owner identity or private evidence", () => {
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

    const firstPage = service.getCommunityVerificationCandidates(verifier, { limit: 20, offset: 0 });

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

    service.verifySubmission(verifier, candidate.id, { result: "confirmed", notes: null });
    expect(service.getCommunityVerificationCandidates(verifier, { limit: 20, offset: 0 }).candidates).toEqual([]);
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

  it("keeps dashboard history bounded while reporting exact lifetime totals above 1,000 submissions", () => {
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
    const listSpy = vi.spyOn(repository, "listSubmissions");
    const detailSpy = vi.spyOn(repository, "getSubmissionById");

    const dashboard = service.getAccountDashboard(repository.getAccountById(account.id)!);

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
    expect(detailSpy).toHaveBeenCalledTimes(12);
  });

  it("exports all account location fields while excluding raw private evidence", () => {
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
    expect(exported.submissions[0]).toEqual(expect.objectContaining({
      uploadLatitude: null,
      uploadLongitude: null,
      uploadLocationCapturedAt: null,
    }));
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
    const partnerInterest = service.submitFeedback(account, {
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
    expect(repository.listFeedback(10).map((item) => item.feedbackType))
      .toEqual(expect.arrayContaining(["security_report", "venue_partner_interest"]));
    expect(repository.listUserActivityEvents(account.id, 10).map((event) => event.eventType))
      .toContain("account_deletion_requested");
  });

  it("prevents stale trust-queue overwrites and rejects non-admin assignees", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "trust-admin", "admin");
    const user = createAccount(repository, "trust-user");
    const feedback = service.submitFeedback(user, {
      anonymousSessionId: null,
      feedbackType: "bug",
      message: "The trust queue needs concurrency protection.",
      venueId: null,
      venueName: null,
    }).feedback;

    expect(() => service.updateTrustQueueItem(admin, "feedback", feedback.id, {
      status: "in_progress",
      assignedTo: user.id,
      resolutionNote: null,
      expectedUpdatedAt: feedback.updatedAt,
    })).toThrow("active, authorised administrator");

    const updated = service.updateTrustQueueItem(admin, "feedback", feedback.id, {
      status: "in_progress",
      assignedTo: "self",
      resolutionNote: "Investigating.",
      expectedUpdatedAt: feedback.updatedAt,
    }).item;
    expect(updated).toEqual(expect.objectContaining({
      status: "in_progress",
      assignedTo: admin.id,
      resolutionNote: "Investigating.",
    }));
    expect(updated.updatedAt).not.toBe(feedback.updatedAt);

    expect(() => service.updateTrustQueueItem(admin, "feedback", feedback.id, {
      status: "resolved",
      assignedTo: null,
      resolutionNote: "Stale overwrite.",
      expectedUpdatedAt: feedback.updatedAt,
    })).toThrow("changed. Refresh");
    expect(repository.listFeedback(10)[0]).toEqual(expect.objectContaining({
      status: "in_progress",
      resolutionNote: "Investigating.",
    }));
  });

  it("enforces the deletion safety window before anonymising the account and purging evidence", async () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const account = createAccount(repository, "deletion-workflow-user");
    const admin = createAccount(repository, "deletion-workflow-admin", "admin");
    createSession(repository, account.id, "deletion-workflow-session-token");

    const submission = service.createSubmission(account, createSubmissionSchema.parse({
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
    })).submission;
    const evidenceId = submission.sourcePhotoUrl!.replace("private:evidence:", "");
    repository.recordEvent({
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
    repository.insertSecurityAuditLog({
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
    const deletion = service.requestAccountDeletion(account, { message: "Delete my account." });
    const requestId = String(deletion.request.id);

    await expect(service.executeAccountDeletion(admin, requestId)).rejects.toThrow(
      "seven-day account deletion safety window",
    );

    database
      .prepare("UPDATE account_deletion_requests SET execute_after = ? WHERE id = ?")
      .run("2026-05-03T08:00:00.000Z", requestId);
    const result = await service.executeAccountDeletion(admin, requestId);

    expect(result).toEqual(expect.objectContaining({ requestId, status: "completed" }));
    expect(repository.getAccountById(account.id)).toEqual(expect.objectContaining({
      email: `deleted-${account.id}@invalid.pintpath.local`,
      status: "suspended",
      subscriptionStatus: "free",
    }));
    expect(repository.getSourceEvidenceObject(evidenceId)).toEqual(expect.objectContaining({
      dataBase64: null,
      deletedAt: NOW,
    }));
    expect(repository.getSubmissionById(submission.id)?.submission).toEqual(expect.objectContaining({
      notes: null,
      sourcePhotoUrl: null,
      uploadLatitude: null,
      uploadLongitude: null,
    }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?").get(account.id))
      .toEqual({ count: 0 });
    expect(repository.listAccountDeletionRequests({ limit: 10 })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: requestId, status: "completed", reviewed_by: admin.id }),
    ]));
    const scrubbedMetadata = JSON.stringify([
      database.prepare("SELECT metadata_json FROM events WHERE id = ?").get("deletion-cross-actor-event"),
      database.prepare("SELECT metadata_json FROM security_audit_log WHERE id = ?").get("deletion-cross-actor-audit"),
    ]).toLowerCase();
    expect(scrubbedMetadata).not.toContain(account.email.toLowerCase());
    expect(scrubbedMetadata).not.toContain(account.id.toLowerCase());
    expect(scrubbedMetadata).toContain("deleted-email");
  });

  it("saves account privacy settings and suppresses opted-out optional analytics", () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const account = createAccount(repository, "privacy-settings-user");

    expect(service.getAccountDashboard(account).privacySettings).toEqual(expect.objectContaining({
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
    }));

    service.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "map_pin_click",
      venueId: "privacy-venue-before-consent",
      beerId: null,
      suburb: "Richmond",
      metadata: { privacyScope: "venue_insight" },
    });
    service.trackClientEvent(account, {
      anonymousSessionId: "forged-client-id",
      eventType: "beer_search_performed",
      venueId: null,
      beerId: "guinness",
      suburb: "Richmond",
      metadata: { privacyScope: "essential", query: "forged scope" },
    }, { ip: "203.0.113.10" });
    service.trackClientEvent(account, {
      anonymousSessionId: "another-forged-id",
      eventType: "map_pin_click",
      venueId: "privacy-venue-forged",
      beerId: null,
      suburb: "Richmond",
      metadata: {},
    }, { ip: "203.0.113.10" });
    for (const eventType of ["free_preview_viewed", "venue_portal_viewed", "venue_insights_viewed"] as const) {
      service.trackEvent(account, {
        anonymousSessionId: null,
        eventType,
        venueId: "privacy-internal-venue",
        beerId: null,
        suburb: "Richmond",
        metadata: {},
      });
    }

    const saved = service.savePrivacySettings(account, {
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: true,
      productResearchEnabled: true,
      emailUpdatesEnabled: true,
    });

    expect(saved.privacySettings).toEqual(expect.objectContaining({
      userId: account.id,
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
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
      eventType: "venue_portal_viewed",
      venueId: "privacy-venue-after-opt-in",
      beerId: null,
      suburb: "Richmond",
      metadata: {},
    });
    service.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "feedback_submitted",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { feedbackType: "privacy_request" },
    });
    service.saveItem(account, {
      itemType: "venue",
      itemId: "privacy-venue",
      label: "Privacy Venue",
      suburb: "Richmond",
      metadata: {},
    });
    service.savePrivacySettings(account, {
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
    });
    service.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "map_pin_click",
      venueId: "privacy-venue-after-opt-in",
      beerId: null,
      suburb: "Richmond",
      metadata: { privacyScope: "venue_insight" },
    });
    expect(database.prepare("SELECT count(*) AS count FROM events WHERE venue_id = ?").get("privacy-venue-after-opt-in"))
      .toEqual({ count: 1 });
    service.savePrivacySettings(account, {
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
    });

    const eventRows = database
      .prepare("SELECT event_type FROM events ORDER BY created_at")
      .all() as Array<{ event_type: string }>;
    expect(eventRows.map((row) => row.event_type)).toEqual(["feedback_submitted"]);
    expect(repository.listUserActivityEvents(account.id, 10).map((event) => event.eventType))
      .toContain("account_privacy_settings_updated");
  });

  it("does not let forged anonymous IDs satisfy venue analytics privacy floors", () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository, { ANALYTICS_MIN_BUCKET_SIZE: 5 });
    const admin = createAccount(repository, "sybil-floor-admin", "admin");
    service.upsertBarProfile(admin, "sybil-floor-venue", {
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
      service.trackClientEvent(null, {
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
    const portal = service.getVenuePortal(admin, { venueId: "sybil-floor-venue" });
    expect(portal.analytics).toEqual(expect.objectContaining({ privacyFloorMet: false }));
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
    const service = createBusinessService(repository);
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
      limit: 20,
      venueId: null,
    });
    expect(preview.records).toHaveLength(3);
    expect(preview.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ beerName: "Carlton Draught", servingSize: "pint", price: 14, freePreviewIncluded: true }),
      expect.objectContaining({ beerName: "Asahi Super Dry", price: null, priceRedacted: true }),
      expect.objectContaining({ beerName: "Guinness", servingSize: "schooner", price: null, priceRedacted: true }),
    ]));

    const venuePreview = service.listPriceRecords(null, {
      anonymousSessionId: "anon-price-test",
      limit: 20,
      venueId: "venue-1",
    });
    expect(venuePreview.preview).toEqual({ model: "fixed_preview", includedCount: 1, lockedCount: 0 });
    expect(venuePreview).not.toHaveProperty("revealed");
    expect(venuePreview).not.toHaveProperty("blocked");
    expect(venuePreview.records[0]?.price).toBe(14);

    const lockedPreview = service.listPriceRecords(null, {
      anonymousSessionId: "anon-price-test",
      limit: 20,
      venueId: "venue-2",
    });
    expect(lockedPreview.preview).toEqual({ model: "fixed_preview", includedCount: 0, lockedCount: 1 });
    expect(lockedPreview.records[0]?.price).toBeNull();
    expect((lockedPreview.records[0] as { priceRedacted?: boolean } | undefined)?.priceRedacted).toBe(true);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    expect(repository.countEvents({
      eventType: "free_preview_viewed",
      userId: null,
      anonymousSessionId: "anon-price-test",
      since: todayStart.toISOString(),
    })).toBe(0);
  });

  it("filters obvious crawler noise out of public price records", () => {
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

    expect(service.listPriceRecords(admin, {
      anonymousSessionId: null,
      limit: 20,
      venueId: "venue-noise",
    }).records.map((record) => record.beerName)).toEqual(["Very Local Hazy Pint"]);
  });

  it("keeps non-preview prices locked for free users while allowing premium, contributor, and admin exact price access", () => {
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

    expect(service.listPriceRecords(freeUser, {
      anonymousSessionId: null,
      limit: 20,
      venueId: "venue-1",
    }).records[0]?.price).toBe(12);
    expect(service.listPriceRecords(freeUser, {
      anonymousSessionId: null,
      limit: 20,
      venueId: "venue-2",
    }).records[0]?.price).toBeNull();

    expect(service.listPriceRecords(premiumUser, {
      anonymousSessionId: null,
      limit: 20,
      venueId: "venue-2",
    }).records[0]?.price).toBe(17);
    expect(service.listPriceRecords(contributor, {
      anonymousSessionId: null,
      limit: 20,
      venueId: "venue-2",
    }).records[0]?.price).toBe(17);
    expect(service.listPriceRecords(admin, {
      anonymousSessionId: null,
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
      isAuthenticated: true,
      accountRole: "user",
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

    expect(() => service.requireAdmin(userAuthorization)).toThrow("Admin access required");
    expect(() => service.requireAdmin(undefined)).toThrow("Login required");
    expect(() => service.requireAdmin(adminAuthorization)).toThrow("Admin email verification");

    repository.updateAccountSecurityClaims({
      userId: admin.id,
      emailVerifiedAt: NOW,
      now: NOW,
    });
    expect(() => service.requireAdmin(adminAuthorization)).toThrow("Admin MFA step-up");

    repository.updateAccountSecurityClaims({
      userId: admin.id,
      mfaLevel: "aal2",
      mfaVerifiedAt: new Date().toISOString(),
      now: NOW,
    });
    expect(service.requireAdmin(adminAuthorization).id).toBe(admin.id);
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

    expect(() => service.requireAdmin(adminAuthorization)).toThrow("Admin email verification");

    repository.updateAccountSecurityClaims({
      userId: admin.id,
      emailVerifiedAt: NOW,
      now: NOW,
    });

    expect(service.requireAdmin(adminAuthorization).id).toBe(admin.id);
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

    expect(() => serviceWithoutAllowlist.requireAdmin(adminAuthorization)).toThrow(
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

    service.assignVenueManager(currentAdmin, {
      userId: manager.id,
      venueId: "authority-venue",
      venueName: "Authority Taproom",
      suburb: "Fitzroy",
    });
    service.upsertBarProfile(currentAdmin, "authority-venue", {
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

    expect(service.getVenuePortal(currentAdmin, { venueId: "authority-venue" }).selectedVenue?.venueId).toBe("authority-venue");
    expect(service.getSubmissionSourceEvidenceUrl(currentAdmin, submission.id).signedUrl).toContain("/source-evidence/");
    expect(service.listSubmissions(currentAdmin, { mine: false, limit: 10 })).toHaveLength(1);
    expect(service.getAccessState(currentAdmin, null)).toEqual(expect.objectContaining({
      isAdmin: true,
      hasFullAccess: true,
      canViewAllPrices: true,
    }));
    const createValidAdminSession = service as unknown as {
      createSessionResponse(account: BusinessAccount): { expiresAt: string };
    };
    expect(createValidAdminSession.createSessionResponse(currentAdmin).expiresAt).toBe("2026-05-11T08:00:00.000Z");

    const removedAllowlistService = createBusinessService(repository, {
      NODE_ENV: "production",
      ADMIN_EMAILS: undefined,
      REQUIRE_ADMIN_MFA_IN_PRODUCTION: true,
      ADMIN_MFA_MAX_AGE_MINUTES: 5,
      REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
      SOURCE_EVIDENCE_SIGNING_SECRET: "production-authority-source-evidence-secret-32",
    });
    expect(removedAllowlistService.getVenuePortal(currentAdmin, { venueId: "authority-venue" })).toEqual(
      expect.objectContaining({ accessState: "claim_required", isAdmin: false, selectedVenue: null }),
    );
    expect(() => removedAllowlistService.upsertBarBeer(currentAdmin, "authority-venue", {
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
    })).toThrow("Venue manager access required");
    expect(() => removedAllowlistService.getSubmissionSourceEvidenceUrl(currentAdmin, submission.id)).toThrow("own source evidence");
    expect(removedAllowlistService.listSubmissions(currentAdmin, { mine: false, limit: 10 })).toEqual([]);
    expect(removedAllowlistService.getAccessState(currentAdmin, null)).toEqual(expect.objectContaining({
      isAdmin: false,
      hasFullAccess: false,
      canViewAllPrices: false,
      premiumToolkit: expect.objectContaining({ enabled: false, status: "locked" }),
    }));
    const createStaleAdminSession = removedAllowlistService as unknown as {
      createSessionResponse(account: BusinessAccount): { expiresAt: string };
    };
    expect(createStaleAdminSession.createSessionResponse(currentAdmin).expiresAt).toBe("2026-07-03T08:00:00.000Z");

    repository.updateAccountSecurityClaims({
      userId: admin.id,
      mfaLevel: "aal2",
      mfaVerifiedAt: "2026-05-03T00:00:00.000Z",
      now: NOW,
    });
    const staleMfaAdmin = repository.getAccountById(admin.id)!;
    expect(service.getVenuePortal(staleMfaAdmin, { venueId: "authority-venue" })).toEqual(
      expect.objectContaining({ accessState: "claim_required", isAdmin: false, selectedVenue: null }),
    );
    expect(() => service.getSubmissionSourceEvidenceUrl(staleMfaAdmin, submission.id)).toThrow("own source evidence");
    expect(service.listSubmissions(staleMfaAdmin, { mine: false, limit: 10 })).toEqual([]);
    expect(service.getAccessState(staleMfaAdmin, null)).toEqual(expect.objectContaining({
      isAdmin: false,
      hasFullAccess: false,
      canUseDiscountPass: false,
    }));

    const currentManager = repository.getAccountById(manager.id)!;
    expect(service.getVenuePortal(currentManager, { venueId: "authority-venue" }).selectedVenue?.venueId).toBe("authority-venue");
    expect(service.upsertBarBeer(currentManager, "authority-venue", {
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
    }).beer).toEqual(expect.objectContaining({ barId: "authority-venue", beerName: "Guinness" }));
  });

  it("live-probes and caches every required Supabase readiness dependency", async () => {
    const { repository } = createRepository();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
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
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const service = createBusinessService(repository, {
        NODE_ENV: "production",
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_ANON_KEY: "supabase-anon-readiness-key",
        SUPABASE_SERVICE_ROLE_KEY: "supabase-service-readiness-key",
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
      }));
      expect(second.dependencies).toEqual(first.dependencies);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(expect.arrayContaining([
        "https://project.supabase.co/auth/v1/health",
        "https://project.supabase.co/rest/v1/venues?select=id&limit=1",
        "https://project.supabase.co/storage/v1/bucket/beermap-source-evidence",
      ]));
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
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
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
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      String(input).includes("/storage/v1/bucket/")
        ? new Response(JSON.stringify({ public: true }), { status: 200 })
        : new Response("{}", { status: 200 })));
    try {
      const publicBucketReadiness = await createBusinessService(repository, config).getOperationalReadiness();
      expect(publicBucketReadiness.ready).toBe(false);
      expect(publicBucketReadiness.dependencies.supabaseEvidenceStorage).toEqual(expect.objectContaining({
        status: "failed",
        error: "bucket_not_private",
      }));

      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
        String(input).includes("/storage/v1/bucket/")
          ? new Response(JSON.stringify({
              public: false,
              file_size_limit: 6 * 1024 * 1024,
              allowed_mime_types: ["image/jpeg", "image/png"],
            }), { status: 200 })
          : new Response("{}", { status: 200 })));
      const undersizedReadiness = await createBusinessService(repository, config).getOperationalReadiness();
      expect(undersizedReadiness.dependencies.supabaseEvidenceStorage).toEqual(expect.objectContaining({
        status: "failed",
        error: "bucket_size_limit_too_small",
      }));

      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
        String(input).includes("/storage/v1/bucket/")
          ? new Response(JSON.stringify({
              public: false,
              file_size_limit: 8 * 1024 * 1024,
              allowed_mime_types: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
            }), { status: 200 })
          : new Response("{}", { status: 200 })));
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
    const productionEvidence = repository.getSourceEvidenceObject(productionEvidenceId)!;
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
    } as unknown as ConstructorParameters<typeof BusinessService>[4];
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
    const supabaseEvidence = repository.getSourceEvidenceObject(supabaseEvidenceId)!;
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
    const supabasePdfEvidence = repository.getSourceEvidenceObject(
      supabasePdfStored.sourcePhotoUrl!.replace("private:evidence:", ""),
    )!;
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
    expect(productionOverrideService.createSubmission(
      verifiedProductionUser,
      createSubmissionSchema.parse({
        ...baseSubmission,
        venueId: "venue-photo-prod-override",
        sourcePhotoDataUrl: PNG_DATA_URL,
      }),
    ).submission.sourcePhotoUrl).toMatch(/^private:evidence:/);
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
    const original = repository.createSourceEvidenceObject.bind(repository);
    repository.createSourceEvidenceObject = (() => {
      throw new Error("forced metadata failure");
    }) as typeof repository.createSourceEvidenceObject;

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
    repository.createSourceEvidenceObject = original;
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
    const originalCreate = repository.createSourceEvidenceObject.bind(repository);
    let metadataInsertCount = 0;
    repository.createSourceEvidenceObject = ((input) => {
      metadataInsertCount += 1;
      if (metadataInsertCount === 2) throw new Error("forced second metadata failure");
      return originalCreate(input);
    }) as typeof repository.createSourceEvidenceObject;

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
      repository.createSourceEvidenceObject = originalCreate;
    }

    const files = fs.existsSync(root)
      ? fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    expect(metadataInsertCount).toBe(2);
    expect(repository.listSourceEvidenceForOwner(user.id)).toHaveLength(0);
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
    const existing = service.createSubmission(user, createSubmissionSchema.parse({
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
    })).submission;
    const originalGet = repository.getSubmissionByClientSubmissionId.bind(repository);
    let idempotencyLookupCount = 0;
    repository.getSubmissionByClientSubmissionId = ((userId, id) => {
      idempotencyLookupCount += 1;
      return idempotencyLookupCount === 1 ? null : originalGet(userId, id);
    }) as typeof repository.getSubmissionByClientSubmissionId;

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
      repository.getSubmissionByClientSubmissionId = originalGet;
    }

    const files = fs.existsSync(root)
      ? fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
      : [];
    expect(replay).toEqual(expect.objectContaining({
      idempotentReplay: true,
      submission: expect.objectContaining({ id: existing.id }),
    }));
    expect(idempotencyLookupCount).toBeGreaterThanOrEqual(2);
    expect(repository.listSourceEvidenceForOwner(user.id)).toHaveLength(0);
    expect(files).toHaveLength(0);
    expect(repository.listSubmissions({ userId: user.id, limit: 10 })).toHaveLength(1);
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

    expect(() => service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      sourcePhotoUrl: "https://example.com/menu-photo.jpg",
    }))).toThrow("upload the source image directly");
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

    expect(service.listSubmissions(admin, { status: "pending", mine: false, limit: 100 }))
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

    expect(service.listPriceRecords(admin, {
      limit: 20,
      venueId,
      anonymousSessionId: null,
    }).records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        venueId,
        venueName: "Moonlit Taproom",
        beerName: "Guinness",
        price: 13,
      }),
    ]));

    const remoteVenues = [
      { id: "remote-venue-1", name: "Remote Venue One", address: "1 Remote St", suburb: "Melbourne", state: "VIC", postcode: "3000", latitude: -37.81, longitude: 144.96 },
      { id: "remote-venue-2", name: "Remote Venue Two", address: "2 Remote St", suburb: "Richmond", state: "VIC", postcode: "3121", latitude: -37.82, longitude: 144.99 },
    ];
    const supabaseVenueBuilder = {
      select: vi.fn(() => supabaseVenueBuilder),
      not: vi.fn(() => supabaseVenueBuilder),
      in: vi.fn(() => supabaseVenueBuilder),
      limit: vi.fn(() => supabaseVenueBuilder),
      order: vi.fn(async () => ({ data: remoteVenues, error: null })),
    };
    (service as unknown as { supabase: unknown }).supabase = {
      from: vi.fn(() => supabaseVenueBuilder),
    };

    expect(await service.listVenues(undefined, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: venueId,
        name: "Moonlit Taproom",
        latitude: -37.798,
        longitude: 144.979,
      }),
    ]));

    const records = repository.listVenueManagerPriceRecords(20, venueId);
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
    };
    const supabaseVenueBuilder = {
      select: vi.fn(() => supabaseVenueBuilder),
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

  it("reconciles text-keyed local venue IDs without sending them through Supabase filters", async () => {
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

    const remoteIn = vi.fn();
    const remoteNot = vi.fn();
    const remoteBuilder = {
      select: vi.fn(() => remoteBuilder),
      in: vi.fn((column: string, ids: string[]) => {
        remoteIn(column, ids);
        return remoteBuilder;
      }),
      not: vi.fn((column: string, operator: string, value: string) => {
        remoteNot(column, operator, value);
        return remoteBuilder;
      }),
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

    expect(result.venues.map((venue) => venue.id)).toEqual(expect.arrayContaining([
      textVenueId,
      uuidVenueId,
    ]));
    expect(remoteIn).not.toHaveBeenCalled();
    expect(remoteNot).not.toHaveBeenCalled();

    const supabaseCallsBeforeLocalLookup = from.mock.calls.length;
    expect(await service.getPublicVenueById(textVenueId)).toEqual(expect.objectContaining({
      id: textVenueId,
      name: "Release Venue 044",
    }));
    expect(from).toHaveBeenCalledTimes(supabaseCallsBeforeLocalLookup);
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
      },
    ];
    const builder = {
      select: vi.fn(() => builder),
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
    const canonicalVenueId = "9102aedc-de45-4784-a2ce-f89b7d194c01";
    upsertProfile(canonicalVenueId, "Rooftop Bar");
    upsertProfile("demo:rooftop-bar", "Rooftop Bar");
    upsertProfile("unique-local", "Unique Local Venue");
    const service = createBusinessService(repository);

    const firstPage = await service.listVenuesPage(undefined, 1, 0);
    const secondPage = await service.listVenuesPage(undefined, 1, 1);

    expect(firstPage.venues.map((venue) => venue.id)).toEqual([canonicalVenueId]);
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
    }));
    let requestedRange = { from: 0, to: 0 };
    const builder = {
      select: vi.fn(() => builder),
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
      })),
    ];
    let requestedRange = { from: 0, to: 0 };
    let remoteSearchActive = false;
    const remoteNot = vi.fn();
    const remoteIn = vi.fn();
    const remoteOrderColumns: string[] = [];
    const remoteBuilder = {
      select: vi.fn(() => {
        remoteSearchActive = false;
        return remoteBuilder;
      }),
      in: vi.fn((column: string, ids: string[]) => {
        remoteIn(column, ids);
        return remoteBuilder;
      }),
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
    expect(remoteIn).not.toHaveBeenCalled();
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

  it("deduplicates public price records that are also present in venue inventory", () => {
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

    const records = service.listPriceRecords(admin, {
      limit: 20,
      venueId: "dedupe-venue",
      anonymousSessionId: null,
    }).records;

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

  it("keeps one authoritative semantic price record across every cursor page", () => {
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
    repository.upsertBarBeer({
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
      const page = service.listPriceRecords(admin, {
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
    expect(() => service.createSubmission(uploader, staleInput)).toThrow("last 12 hours");

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
    const inaccurate = service.createSubmission(uploader, inaccurateInput).submission;
    expect(inaccurate).toEqual(expect.objectContaining({
      pointsEligibleByLocation: false,
      pointsEligibilityReason: "location_accuracy_over_100m",
    }));
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
    const expectedMonthEnd = getZonedMonthRangeIso(getZonedMonthKey(now, "Australia/Melbourne"), "Australia/Melbourne").endIso;
    expect(updated.contributionPointsCurrentMonth).toBe(15);
    expect(updated.subscriptionStatus).toBe("contributor_unlocked");
    expect(updated.premiumUntil).toBe(expectedMonthEnd);
  });

  it("uses the Melbourne contribution month for boundary reviews and unlock expiry", () => {
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
      const submission = service.createSubmission(user, createSubmissionSchema.parse({
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
      })).submission;
      service.reviewSubmission(admin, submission.id, {
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

  it("shows zero current-month progress after rollover even before another review", () => {
    vi.setSystemTime(new Date("2026-07-31T14:30:00.000Z"));
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "dashboard-rollover-user");
    database.prepare("UPDATE accounts SET contribution_points_current_month = 15 WHERE id = ?").run(user.id);
    database.prepare(
      `INSERT INTO contribution_ledger (id, user_id, submission_id, venue_id, points, reason, month_key, created_at)
       VALUES ('dashboard-rollover-ledger', ?, NULL, 'previous-month-venue', 15, 'historical', '2026-07', ?)`,
    ).run(user.id, "2026-07-15T00:00:00.000Z");

    const dashboard = service.getAccountDashboard(repository.getAccountById(user.id)!);
    expect(dashboard.account.contributionPointsCurrentMonth).toBe(0);
    expect(dashboard.dashboardStats.pointsThisMonth).toBe(0);
    expect(dashboard.contributorProgress).toEqual(expect.objectContaining({
      pointsThisMonth: 0,
      pointsNeeded: 15,
    }));
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

  it("drains source-evidence retention beyond 100 rows and purges evidence that expires after startup", async () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const createEvidence = (id: string, retentionExpiresAt: string) => repository.createSourceEvidenceObject({
      id,
      ownerUserId: null,
      storageProvider: "sqlite_private",
      objectPath: `evidence/${id}`,
      mimeType: "image/png",
      byteSize: 8,
      dataBase64: "aGVsbG8=",
      externalUrl: null,
      retentionExpiresAt,
      createdAt: NOW,
    });
    for (let index = 0; index < 205; index += 1) {
      createEvidence(`expired-evidence-${index}`, "2026-05-03T08:00:00.000Z");
    }

    await expect(service.purgeExpiredSourceEvidence(100)).resolves.toEqual(expect.objectContaining({
      purged: 205,
      failed: 0,
      remaining: 0,
      backlogBefore: 205,
      passes: 3,
      stalled: false,
    }));

    createEvidence("expires-after-startup", "2026-05-04T08:30:00.000Z");
    const statuses: unknown[] = [];
    const scheduler = scheduleMissionMaintenance({
      run: () => service.purgeExpiredSourceEvidence(100),
      intervalMinutes: 60,
      onStatus: (status) => statuses.push(status),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.getSourceEvidenceObject("expires-after-startup")?.deletedAt).toBeNull();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    expect(repository.getSourceEvidenceObject("expires-after-startup")?.deletedAt).toBe("2026-05-04T09:00:00.000Z");
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: "succeeded",
        trigger: "interval",
        result: expect.objectContaining({ purged: 1, remaining: 0 }),
      }),
    ]));
    await scheduler.stop();
  });

  it("extracts multi-image photo submissions, matches catalogue names, and quarantines new OCR beers", async () => {
    const { repository } = createRepository();
    const menuPhotoOcr: NonNullable<ConstructorParameters<typeof BusinessService>[3]> = {
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
      items: [],
    }));

    expect(menuPhotoOcr.extract).toHaveBeenCalledWith(expect.objectContaining({
      imageDataUrls: [PNG_DATA_URL, JPEG_DATA_URL],
    }));
    expect(result.ocrStatus).toBe("processed");
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
    expect(service.getAdminBeerCatalog(admin).pending).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "moonbeam_rice_lager",
        name: "Moonbeam Rice Lager",
        brewery: "Moonbeam Brewing",
        abv: 5.1,
      }),
      expect.objectContaining({ key: "decorative_house_lager", name: "Decorative House Lager" }),
    ]));
    expect(service.getAdminBeerCatalog(admin).pending).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: expect.stringMatching(/T bone/i) }),
    ]));

    const signedEvidence = service.getSubmissionSourceEvidenceUrl(owner, result.submission.id);
    expect(signedEvidence.signedUrls).toHaveLength(2);
    expect(() => service.reviewSubmission(admin, result.submission.id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    })).toThrow("Approve, merge, or reject every new beer name");

    service.rejectBeerCatalogItem(admin, "decorative_house_lager", { reviewNote: "Decorative OCR copy, not a beer." });
    expect(repository.getSubmissionById(result.submission.id)!.items.map((item) => item.beerName))
      .not.toContain("Decorative House Lager");
    service.approveBeerCatalogItem(admin, "moonbeam_rice_lager", { reviewNote: "Verified from source image." });
    expect(repository.getSubmissionById(result.submission.id)!.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ beerName: "Moonbeam Rice Lager", requiresCatalogApproval: false }),
    ]));
    expect(service.reviewSubmission(admin, result.submission.id, {
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      confidence: "photo_verified",
    }).submission.status).toBe("approved");
    expect(repository.listLatestPriceRecords(20, "venue-photo-ocr").map((record) => record.beerName))
      .toEqual(expect.arrayContaining(["Carlton Draught", "Moonbeam Rice Lager"]));
    expect(repository.listLatestPriceRecords(20, "venue-photo-ocr").map((record) => record.beerName))
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

    const second = await service.login({ email: "session-user@example.com", password: "password123" });
    expect((await service.logoutAll(service.requireAccount(`Bearer ${second.token}`))).revokedCount).toBeGreaterThanOrEqual(1);
    expect(service.getAccountFromAuthorization(`Bearer ${second.token}`)).toBeNull();

    const expired = await service.login({ email: "session-user@example.com", password: "password123" });
    database
      .prepare("UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?")
      .run("2020-01-01T00:00:00.000Z", crypto.createHash("sha256").update(expired.token).digest("hex"));
    expect(service.getAccountFromAuthorization(`Bearer ${expired.token}`)).toBeNull();

    const suspended = await service.login({ email: "session-user@example.com", password: "password123" });
    repository.overrideUserStatus({
      userId: signup.account.id,
      status: "suspended",
      now: NOW,
    });
    expect(service.getAccountFromAuthorization(`Bearer ${suspended.token}`)).toBeNull();
  });

  it("keeps only the ten most recently used active app sessions per account", () => {
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

  it("atomically preserves a newly issued session while enforcing the account cap", () => {
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

  it("keeps a credential-verified billing-only portal available after suspension", async () => {
    const { repository } = createRepository();
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
    repository.overrideUserStatus({ userId: account.id, status: "suspended", now: NOW });

    await expect(service.login({ email: account.email, password: "password123" })).rejects.toMatchObject({
      statusCode: 403,
      details: expect.objectContaining({ billingRecoveryEligible: true }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(String(init?.body)).toContain("customer=cus_suspended_billing");
      return new Response(JSON.stringify({ url: "https://billing.stripe.test/session" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await expect(service.createSuspendedAccountBillingPortal({
        email: account.email,
        password: "password123",
      })).resolves.toEqual(expect.objectContaining({
        portalUrl: "https://billing.stripe.test/session",
        accountId: account.publicAccountId,
        message: expect.stringContaining("without restoring application access"),
      }));
      await expect(service.createSuspendedAccountBillingPortal({
        email: account.email,
        password: "wrong-password",
      })).rejects.toMatchObject({ statusCode: 401 });
      expect(service.getAccountFromAuthorization(`Bearer ${signup.token}`)).toBeNull();
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
      expect(service.getAccountFromAuthorization(`Bearer ${token}`)).toBeNull();
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
    const queueRepository = new AdminIngestionQueueRepository(database);
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const imageDataUrl = `data:image/jpeg;base64,${imageBytes.toString("base64")}`;
    const item = queueRepository.create({
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
    const payload = {
      id: "evt_checkout_completed",
      type: "checkout.session.completed",
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
    expect(repository.listSecurityAuditLogs(10).filter((row) => row.action === "stripe_subscription_update")).toHaveLength(1);
    for (const [suffix, validFirst] of [["first", true], ["last", false]] as const) {
      const rotatedPayload = {
        ...payload,
        id: `evt_checkout_rotated_${suffix}`,
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
    await expect(service.handleStripeWebhook(deletedSigned.body, deletedSigned.header)).resolves.toEqual({ received: true });
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
    await expect(service.handleStripeWebhook(failedSigned.body, failedSigned.header)).resolves.toEqual({ received: true });
    expect(repository.getAccountById(user.id)?.subscriptionStatus).toBe("free");
    await expect(createBusinessService(repository, {
      DEMO_BILLING_MODE: false,
      STRIPE_WEBHOOK_SECRET: undefined,
    }).handleStripeWebhook(signed.body, signed.header)).rejects.toThrow("Stripe webhook secret is not configured");
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
    service.upsertBarProfile(admin, "stripe-recovery-venue", {
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

    const deliver = async (payload: object) => {
      const signed = createStripeSignature(payload, webhookSecret);
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
    }));
    await deliver({
      id: "evt_recovery_venue_active",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_recovery_venue", customer: "cus_recovery_venue", status: "active" } },
    });
    expect(repository.getBarProfile("stripe-recovery-venue")?.membershipTier).toBe("pro");
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
    service.upsertBarProfile(admin, "stripe-state-venue", {
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
    const deliver = async (payload: object) => {
      const signed = createStripeSignature(payload, webhookSecret);
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
    service.upsertBarProfile(admin, "stripe-order-venue", {
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
    service.upsertBarProfile(admin, "stripe-cancel-checkout-venue", {
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

  it("returns an exact leaderboard rank beyond 10,000 contributors", () => {
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

  it("moderates public display names before they appear on leaderboards", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "display-name-user");
    const otherUser = createAccount(repository, "display-name-other");

    const updated = service.updateDisplayName(user, { displayName: "Tap Legend" });
    expect(updated.account.displayName).toBe("Tap Legend");
    expect(repository.getProfileById(user.id)?.displayName).toBe("Tap Legend");
    expect(repository.getAccountByDisplayNameKey("tap legend")?.id).toBe(user.id);

    expect(() => service.updateDisplayName(otherUser, { displayName: "Tap   Legend" }))
      .toThrow("already taken");

    expect(() => service.updateDisplayName(user, { displayName: "PintPath Admin" }))
      .toThrow("community rules");
    expect(() => service.updateDisplayName(user, { displayName: "www.bad-name.test" }))
      .toThrow("community rules");
  });

  it("rejects SQL-looking public display names before they reach leaderboard storage", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "display-name-injection-user");

    expect(() => service.updateDisplayName(user, { displayName: "Rob');--" }))
      .toThrow("Display name can use letters");

    const updated = service.updateDisplayName(user, { displayName: "Safe Pint Tester" });
    expect(updated.account.displayName).toBe("Safe Pint Tester");
    expect(repository.getAccountById(user.id)?.displayName).toBe("Safe Pint Tester");
  });

  it("sanitizes venue search text before building Supabase filter strings", () => {
    expect(sanitizePostgrestIlikeTerm("Half Moon%),id.not.is.null")).toBe("Half Moon id not is null");
    expect(sanitizePostgrestIlikeTerm("Robert'); DROP TABLE venues;--")).toBe("Robert DROP TABLE venues --");
    expect(sanitizePostgrestIlikeTerm("  Carlton   Draught · Brighton, VIC  ")).toBe("Carlton Draught Brighton VIC");
    expect(sanitizePostgrestIlikeTerm("x".repeat(120))).toHaveLength(80);
  });

  it("lets admins finalize monthly leaderboard prizes into private account vouchers", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "prize-admin", "admin");
    const firstUser = createAccount(repository, "prize-first");
    const secondUser = createAccount(repository, "prize-second");
    const thirdUser = createAccount(repository, "prize-third");

    service.updateDisplayName(firstUser, { displayName: "First Pint" });
    service.updateDisplayName(secondUser, { displayName: "Second Pint" });
    service.updateDisplayName(thirdUser, { displayName: "Third Pint" });

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

    service.saveLeaderboardPrizeCampaign(admin, {
      monthKey: MONTH_KEY,
      title: "June beta prize race",
      affiliateBar: "Half Moon",
      terms: "Prize vouchers are venue tab credits for eligible partner venues.",
      firstPlaceCents: 10_000,
      secondPlaceCents: 5_000,
      thirdPlaceCents: 2_500,
    });

    const result = service.finalizeLeaderboardPrizeCampaign(admin, { monthKey: MONTH_KEY, force: true });
    expect(result.awards).toHaveLength(3);
    expect(result.vouchers.map((voucher) => voucher.amountCents)).toEqual([10_000, 5_000, 2_500]);
    expect(result.awards[0]).toEqual(expect.objectContaining({
      rank: 1,
      publicAccountId: firstUser.publicAccountId,
      displayName: "First Pint",
    }));

    const dashboard = service.getAccountDashboard(firstUser);
    expect(dashboard.rewards.vouchers[0]).toEqual(expect.objectContaining({
      title: "June beta prize race winner",
      amountLabel: "$100",
      venueScope: "Half Moon",
      status: "active",
    }));
    expect(JSON.stringify(dashboard.rewards.vouchers)).not.toContain(firstUser.email);
  });

  it("revalidates prize eligibility, reranks winners, and supports audited manual fulfillment", () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "prize-fair-admin", "admin");
    const firstStaff = createAccount(repository, "prize-fair-staff-one");
    const secondStaff = createAccount(repository, "prize-fair-staff-two");
    const firstEligible = createAccount(repository, "prize-fair-eligible-one");
    const secondEligible = createAccount(repository, "prize-fair-eligible-two");
    const thirdEligible = createAccount(repository, "prize-fair-eligible-three");

    service.assignVenueManager(admin, {
      userId: firstStaff.id,
      venueId: "prize-fair-venue-one",
      venueName: "Prize Fair Venue One",
      suburb: "Fitzroy",
    });
    service.assignVenueManager(admin, {
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

    const fulfilled = service.transitionRewardVoucher(admin, result.vouchers[0].id, {
      action: "fulfill",
      reason: "Support verified the winner and partner receipt.",
    });
    expect(fulfilled).toEqual(expect.objectContaining({
      idempotent: false,
      voucher: expect.objectContaining({ status: "redeemed", statusLabel: "Fulfilled" }),
    }));
    expect(service.transitionRewardVoucher(admin, result.vouchers[0].id, {
      action: "fulfill",
      reason: "Retry after the response timed out.",
    }).idempotent).toBe(true);
    expect(() => service.transitionRewardVoucher(admin, result.vouchers[0].id, {
      action: "void",
      reason: "Conflicting transition must fail.",
    })).toThrow("already redeemed");
    const audit = database.prepare(
      "SELECT action, target_id FROM security_audit_log WHERE target_id = ? ORDER BY created_at",
    ).all(result.vouchers[0].id) as Array<{ action: string; target_id: string }>;
    expect(audit.map((entry) => entry.action)).toEqual([
      "reward_voucher_fulfilled",
      "reward_voucher_fulfilled",
    ]);

    database.prepare("UPDATE account_reward_vouchers SET expires_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", result.vouchers[1].id);
    expect(() => service.transitionRewardVoucher(admin, result.vouchers[1].id, {
      action: "fulfill",
      reason: "An expired voucher must not be fulfilled.",
    })).toThrow("expired");
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

    drinks.forEach((drink, index) => {
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
      repository.upsertBarBeer({
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
    });

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
    service.upsertBarProfile(admin, "discount-venue-a", {
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
    repository.upsertBarSpecial({
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
    const replay = service.redeemDiscountPass(assignedManager, "discount-venue-a", {
        code: pass.code,
        specialId: "special-1",
        itemName: "Second attempt",
        quantity: 1,
        estimatedSavingsCents: 300,
        notes: "Replay attempt",
      });
    expect(replay).toEqual(expect.objectContaining({ idempotentReplay: true, pointsEarned: 0 }));

    const dashboard = service.getAccountDashboard(premiumUser);
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

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "pint-points-venue",
      venueName: "Pint Points Venue",
      suburb: "Fitzroy",
    });
    service.assignVenueManager(admin, {
      userId: otherManager.id,
      venueId: "pint-points-other-venue",
      venueName: "Other Pint Points Venue",
      suburb: "Brunswick",
    });
    service.upsertBarProfile(admin, "pint-points-venue", {
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
    const memberPreview = service.previewPintPointMember(assignedManager, "pint-points-venue", {
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
    expect(() => service.previewPintPointMember(unassignedManager, "pint-points-venue", {
      code: memberPass.code,
      transactionReference: "receipt-points-blocked",
    })).toThrow("You can only access assigned venues.");
    service.assignVenueManager(admin, {
      userId: otherManager.id,
      venueId: "pint-points-venue",
      venueName: "Pint Points Venue",
      suburb: "Fitzroy",
    });
    expect(() => service.recordPintPointDrink(repository.getAccountById(otherManager.id)!, "pint-points-venue", {
      checkoutToken: memberPreview.checkoutToken,
      code: undefined,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 2,
      transactionReference: "receipt-points-1",
      notes: null,
    })).toThrow("does not match this purchase");
    service.revokeVenueManager(admin, { userId: otherManager.id, venueId: "pint-points-venue" });

    const firstDrink = service.recordPintPointDrink(assignedManager, "pint-points-venue", {
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

    const firstDrinkRetry = service.recordPintPointDrink(assignedManager, "pint-points-venue", {
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
    expect(() => service.recordPintPointDrink(assignedManager, "pint-points-venue", {
      checkoutToken: memberPreview.checkoutToken,
      code: undefined,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 2,
      transactionReference: "receipt-points-different",
      notes: null,
    })).toThrow("does not match this purchase");
    const unusedPreview = service.previewPintPointMember(assignedManager, "pint-points-venue", {
      code: memberPass.code,
      transactionReference: "receipt-expired-unrecorded",
    });
    vi.setSystemTime(new Date("2026-05-04T08:31:00.000Z"));
    expect(service.recordPintPointDrink(assignedManager, "pint-points-venue", {
      checkoutToken: memberPreview.checkoutToken,
      code: undefined,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 2,
      transactionReference: "receipt-points-1",
      notes: null,
    })).toEqual(expect.objectContaining({ idempotentReplay: true, pointsEarned: 2 }));
    expect(() => service.recordPintPointDrink(assignedManager, "pint-points-venue", {
      checkoutToken: unusedPreview.checkoutToken,
      code: undefined,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 1,
      transactionReference: "receipt-expired-unrecorded",
      notes: null,
    })).toThrow("authorization expired");
    vi.setSystemTime(new Date(NOW));
    expect(() => service.recordPintPointDrink(assignedManager, "pint-points-venue", {
      checkoutToken: memberPreview.checkoutToken,
      code: undefined,
      itemName: "Different purchase",
      beverageCategory: "alcoholic",
      quantity: 1,
      transactionReference: "receipt-points-1",
      notes: null,
    })).toThrow("already attached to a different purchase");

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
    const zeroPointDrink = service.recordPintPointDrink(assignedManager, "pint-points-venue", foodPayload);
    expect(zeroPointDrink.pointsEarned).toBe(0);
    expect(zeroPointDrink.wallet.available).toBe(2);

    for (const [index, quantity] of [4, 4].entries()) {
      service.recordPintPointDrink(assignedManager, "pint-points-venue", {
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

    const dashboardBeforeReward = service.getAccountDashboard(repository.getAccountById(user.id)!);
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
    expect(reward.wallet).toEqual(expect.objectContaining({
      balance: 50,
      available: 0,
      reserved: 50,
      rewardAvailable: false,
    }));

    expect(() =>
      service.handleFreePintRewardCode(unassignedManager, "pint-points-venue", {
        code: reward.code,
        action: "confirm",
        reason: null,
      }),
    ).toThrow("You can only access assigned venues.");

    const rejected = service.handleFreePintRewardCode(assignedManager, "pint-points-venue", {
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
    const redemption = service.handleFreePintRewardCode(assignedManager, "pint-points-venue", {
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
    expect(() =>
      service.handleFreePintRewardCode(assignedManager, "pint-points-venue", {
        code: secondReward.code,
        action: "confirm",
        reason: null,
      }),
    ).toThrow("already used");

    const portal = service.getVenuePortal(assignedManager, { venueId: "pint-points-venue" });
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

  it("expires counter-staff invitations after 72 hours and allows a fresh invitation", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "expiring-counter-admin", "admin");
    const manager = createAccount(repository, "expiring-counter-manager");
    const staff = createAccount(repository, "expiring-counter-staff");

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "expiring-counter-venue",
      venueName: "Expiring Counter Venue",
      suburb: "Carlton",
    });
    const managerAccount = repository.getAccountById(manager.id)!;
    const invitation = service.assignVenueCounterStaff(managerAccount, "expiring-counter-venue", {
      accountId: staff.publicAccountId,
    });
    expect(invitation.assignment).toEqual(expect.objectContaining({
      status: "pending",
      expiresAt: "2026-05-07T08:00:00.000Z",
    }));

    vi.setSystemTime(new Date("2026-05-07T09:00:00.000Z"));
    expect(service.getAccountDashboard(repository.getAccountById(staff.id)!).counterStaffInvitations).toEqual([]);
    expect(() => service.respondToVenueCounterStaffInvitation(
      repository.getAccountById(staff.id)!,
      invitation.assignment.id,
      { decision: "accept" },
    )).toThrow("not found or it has expired");

    const replacement = service.assignVenueCounterStaff(managerAccount, "expiring-counter-venue", {
      accountId: staff.publicAccountId,
    });
    expect(replacement.assignment).toEqual(expect.objectContaining({
      status: "pending",
      expiresAt: "2026-05-10T09:00:00.000Z",
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

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "counter-venue",
      venueName: "Counter Venue",
      suburb: "Richmond",
    });
    service.upsertBarProfile(admin, "counter-venue", {
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
    const staffAssignment = service.assignVenueCounterStaff(managerAccount, "counter-venue", {
      accountId: staff.publicAccountId,
    });
    const secondStaffAssignment = service.assignVenueCounterStaff(managerAccount, "counter-venue", {
      accountId: secondStaff.publicAccountId,
    });
    expect(staffAssignment.assignment).toEqual(expect.objectContaining({
      venueId: "counter-venue",
      accessLevel: "counter_staff",
      publicAccountId: staff.publicAccountId,
      status: "pending",
    }));
    expect(staffAssignment.assignment.userId).toBeUndefined();
    expect(service.getAccountDashboard(repository.getAccountById(staff.id)!).counterStaffInvitations).toContainEqual(
      expect.objectContaining({ id: staffAssignment.assignment.id, venueId: "counter-venue" }),
    );
    service.respondToVenueCounterStaffInvitation(repository.getAccountById(staff.id)!, staffAssignment.assignment.id, {
      decision: "accept",
    });
    service.respondToVenueCounterStaffInvitation(repository.getAccountById(secondStaff.id)!, secondStaffAssignment.assignment.id, {
      decision: "accept",
    });

    const staffAccount = repository.getAccountById(staff.id)!;
    const secondStaffAccount = repository.getAccountById(secondStaff.id)!;
    const staffDashboard = service.getAccountDashboard(staffAccount);
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
    expect(service.getAuthSession(staffAccount).counterStaffAssignments)
      .toEqual(staffDashboard.counterStaffAssignments);
    const counterPortal = service.getVenuePortal(staffAccount, { venueId: "counter-venue" });
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
    expect(() => service.upsertBarProfile(staffAccount, "counter-venue", {
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
    })).toThrow("Venue manager access required");

    const session = createSession(repository, member.id, "counter-member-session");
    const pass = await service.getDiscountPass(member, session);
    const firstPreview = service.previewPintPointMember(staffAccount, "counter-venue", {
      code: pass.code,
      transactionReference: "counter-receipt-1",
    });
    expect(firstPreview.eligible).toBe(true);
    const first = service.recordPintPointDrink(staffAccount, "counter-venue", {
      code: undefined,
      checkoutToken: firstPreview.checkoutToken,
      itemName: "Guinness pint",
      beverageCategory: "alcoholic",
      quantity: 2,
      transactionReference: "counter-receipt-1",
      notes: null,
    });
    expect(first.wallet.available).toBe(2);
    expect(() => service.voidPintPointDrink(secondStaffAccount, "counter-venue", first.record.id, {
      reason: "Trying another staff record",
    })).toThrow("only reverse purchases they recorded themselves");

    const reversed = service.voidPintPointDrink(staffAccount, "counter-venue", first.record.id, {
      reason: "Wrong member selected",
    });
    expect(reversed).toEqual(expect.objectContaining({
      pointsReversed: 2,
      idempotentReplay: false,
      wallet: expect.objectContaining({ available: 0, lifetimeRedeemed: 0 }),
      record: expect.objectContaining({ status: "void", voidReason: "Wrong member selected" }),
    }));
    expect(service.voidPintPointDrink(staffAccount, "counter-venue", first.record.id, {
      reason: "Safe retry",
    }).idempotentReplay).toBe(true);
    expect(service.recordPintPointDrink(staffAccount, "counter-venue", {
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

    const secondPreview = service.previewPintPointMember(staffAccount, "counter-venue", {
      code: pass.code,
      transactionReference: "counter-receipt-2",
    });
    const second = service.recordPintPointDrink(staffAccount, "counter-venue", {
      code: undefined,
      checkoutToken: secondPreview.checkoutToken,
      itemName: "Carlton Draught pint",
      beverageCategory: "alcoholic",
      quantity: 1,
      transactionReference: "counter-receipt-2",
      notes: null,
    });
    vi.setSystemTime(new Date("2026-05-04T08:16:00.000Z"));
    expect(() => service.voidPintPointDrink(staffAccount, "counter-venue", second.record.id, {
      reason: "Late staff correction",
    })).toThrow("Ask a venue manager");
    expect(service.voidPintPointDrink(managerAccount, "counter-venue", second.record.id, {
      reason: "Manager approved correction",
    }).idempotentReplay).toBe(false);

    const managerPortal = service.getVenuePortal(managerAccount, { venueId: "counter-venue" });
    expect(managerPortal.pintPoints.today).toEqual(expect.objectContaining({
      pointsIssued: 0,
      drinkRecords: 0,
      alcoholicDrinks: 0,
    }));
    expect(managerPortal.pintPoints.recentActivity).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.record.id, status: "void", canVoid: false }),
      expect.objectContaining({ id: second.record.id, status: "void", canVoid: false }),
    ]));

    service.revokeVenueCounterStaff(managerAccount, "counter-venue", { accountId: staff.publicAccountId });
    expect(service.getAuthSession(repository.getAccountById(staff.id)!).counterStaffAssignments).toEqual([]);
    expect(service.getVenuePortal(repository.getAccountById(staff.id)!, { venueId: "counter-venue" })).toEqual(
      expect.objectContaining({ accessState: "claim_required" }),
    );
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
      acceptsPintPathCodes: true,
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
    repository.upsertBarSpecial({
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
    const integration = service.getVenuePosIntegration(assignedManager, "pos-discount-venue");
    expect(integration.enabled).toBe(true);
    expect(integration).not.toHaveProperty("token");
    expect(integration.tokenPreview).toMatch(/^[a-f0-9]{8}\.\.\.[a-f0-9]{8}$/);
    expect(integration.payloadExample).toEqual(expect.objectContaining({
      venueId: "pos-discount-venue",
      specialId: "special_venue_offer_id",
      discountAmountCents: 200,
    }));

    const rotatedIntegration = service.rotateVenuePosIntegrationToken(assignedManager, "pos-discount-venue");
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

    const redemption = service.redeemDiscountPassFromPos({
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

    const passReplay = service.redeemDiscountPassFromPos({
        venueId: "pos-discount-venue",
        code: pass.code,
        itemName: "Replay",
        quantity: 1,
        discountAmountCents: 200,
      }, webhookToken);
    expect(passReplay).toEqual(expect.objectContaining({ idempotentReplay: true, pointsEarned: 0 }));

    expect(() =>
      service.redeemDiscountPassFromPos({
        venueId: "pos-basic-venue",
        code: pass.code,
        itemName: "Wrong venue",
        quantity: 1,
        discountAmountCents: 200,
      }, webhookToken),
    ).toThrow("Invalid POS webhook token.");

    const basicIntegration = service.getVenuePosIntegration(admin, "pos-basic-venue");
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

  it("standardises submitted beer names and adds new beers to the system catalogue", () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "catalog-submit-user");
    const admin = createAccount(repository, "catalog-submit-admin", "admin");

    const aliasSubmission = service.createSubmission(user, createSubmissionSchema.parse({
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

    const firstUnknown = service.createSubmission(user, createSubmissionSchema.parse({
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

    const secondUnknown = service.createSubmission(user, createSubmissionSchema.parse({
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
    expect(service.getPublicConfig().trackedBeers).not.toContainEqual(expect.objectContaining({
      key: "very_local_hazy_pint",
    }));
    expect(service.getAdminBeerCatalog(admin).pending).toContainEqual(expect.objectContaining({
      key: "very_local_hazy_pint",
      name: "Very Local Hazy Pint",
      aliases: expect.arrayContaining(["Very Local Hazy Pint"]),
    }));
  });

  it("lets admins approve or merge pending beer catalogue names without leaving duplicate IDs", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "catalog-review-user");
    const admin = createAccount(repository, "catalog-review-admin", "admin");

    const targetSubmission = service.createSubmission(user, createSubmissionSchema.parse({
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

    const approved = service.approveBeerCatalogItem(admin, "very_local_hazy_pint", {
      reviewNote: "Real local beer.",
    });
    expect(approved.beer).toEqual(expect.objectContaining({
      key: "very_local_hazy_pint",
      name: "Very Local Hazy Pint",
      status: "active",
    }));
    expect(service.getPublicConfig().trackedBeers).toContainEqual(expect.objectContaining({
      key: "very_local_hazy_pint",
      name: "Very Local Hazy Pint",
      aliases: expect.arrayContaining(["Very Local Hazy Pint"]),
    }));

    const typoSubmission = service.createSubmission(user, createSubmissionSchema.parse({
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
    expect(service.getAdminBeerCatalog(admin).pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "very_locl_hazy_pint" }),
    ]));

    const merged = service.mergeBeerCatalogItem(admin, "very_locl_hazy_pint", {
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
    expect(service.getAdminBeerCatalog(admin).pending).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "very_locl_hazy_pint" }),
    ]));

    service.createSubmission(user, createSubmissionSchema.parse({
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
    expect(service.getAdminBeerCatalog(admin).pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "website_copy_lager" }),
    ]));

    const rejected = service.rejectBeerCatalogItem(admin, "website_copy_lager", {
      reviewNote: "Not a real beer name.",
    });
    expect(rejected.beer).toEqual(expect.objectContaining({
      key: "website_copy_lager",
      name: "Website Copy Lager",
      reviewNote: "Not a real beer name.",
    }));
    expect(service.getAdminBeerCatalog(admin).pending).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "website_copy_lager" }),
    ]));
    expect(() => service.rejectBeerCatalogItem(admin, "very_local_hazy_pint", {
      reviewNote: "Do not delete active beers.",
    })).toThrow("Pending beer was not found.");
  });

  it("lets admins bulk reject pending beer catalogue junk", () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "catalog-bulk-admin", "admin");
    const catalogRepository = new BeerCatalogRepository(database);

    catalogRepository.resolveBeerName({
      name: "Footer Copy Ale",
      source: "menu_crawler_import",
      now: NOW,
    });
    catalogRepository.resolveBeerName({
      name: "Website Nav Lager",
      source: "menu_crawler_import",
      now: NOW,
    });

    const result = service.rejectBeerCatalogItems(admin, {
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
    expect(service.getAdminBeerCatalog(admin).pending).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "footer_copy_ale" }),
      expect.objectContaining({ key: "website_nav_lager" }),
    ]));
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

  it("keeps needs-more-evidence neutral, distinguishes disputes, and canonicalises fraud outcomes", () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "review-outcome-user");
    const admin = createAccount(repository, "review-outcome-admin", "admin");
    const needsEvidence = createSubmission(repository, {
      id: "review-needs-evidence",
      userId: user.id,
      venueId: "review-venue-1",
    });

    service.reviewSubmission(admin, needsEvidence.id, {
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

    service.reviewSubmission(admin, needsEvidence.id, {
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
    service.reviewSubmission(admin, disputed.id, {
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
    service.reviewSubmission(admin, fraud.id, {
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
          headers: expect.objectContaining({
            "X-Goog-Api-Key": "test-google-places-key",
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("publishes Google-verified venues immediately but keeps beer rows admin-gated after community confirmation", async () => {
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

      const requestResult = service.createVenueRequest(user, {
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
      const duplicateRequest = service.createVenueRequest(user, {
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
      expect(repository.listVenueRequests(10)).toHaveLength(1);

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
      expect(result.statusCopy).toContain("Venue added to the public map");
      expect(result.statusCopy).toContain("Drink data is saved for review");
      expect(result.linkedVenueRequestCount).toBe(1);
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

      const venues = await service.listVenues("Locked Google", 10);
      expect(venues).toContainEqual(expect.objectContaining({
        id: result.submission.venueId,
        name: "Locked Google Bar",
        address: "12 Lock St, Fitzroy VIC 3065",
        suburb: "Fitzroy",
        isUserSubmittedVenue: true,
      }));
      expect(repository.listVenueManagerPriceRecords(20, result.submission.venueId)).toEqual([]);
      expect(repository.getVenueRequestById(requestResult.request.id)).toEqual(expect.objectContaining({
        status: "resolved",
        venueId: result.submission.venueId,
        googlePlaceId: "google-place-locked-venue",
        sourceSubmissionId: result.submission.id,
        resolvedAt: NOW,
      }));

      const firstVerification = service.verifySubmission(firstVerifier, result.submission.id, {
        result: "confirmed",
        notes: "Matches the venue menu board.",
      });
      expect(firstVerification.autoApproved).toBe(false);
      expect(repository.listVenueManagerPriceRecords(20, result.submission.venueId)).toEqual([]);

      const secondVerification = service.verifySubmission(secondVerifier, result.submission.id, {
        result: "confirmed",
        notes: "Same pint price seen tonight.",
      });
      expect(secondVerification.autoApproved).toBe(false);
      expect(secondVerification.confirmedCount).toBe(2);
      expect(repository.getSubmissionById(result.submission.id)?.submission.status).toBe("pending");
      expect(repository.listVenueManagerPriceRecords(20, result.submission.venueId)).toEqual([]);

      service.reviewSubmission(admin, result.submission.id, {
        status: "approved",
        rejectionReason: null,
        reviewNote: "Two independent confirmations reviewed by admin.",
      });
      expect(repository.getSubmissionById(result.submission.id)?.submission.status).toBe("approved");
      expect(repository.listVenueManagerPriceRecords(20, result.submission.venueId))
        .toEqual([expect.objectContaining({
          beerName: "Guinness",
          venueName: "Locked Google Bar",
          price: 13,
        })]);
      const publishedRecord = database
        .prepare("SELECT confidence FROM venue_price_records WHERE source_submission_id = ?")
        .get(result.submission.id) as { confidence: string } | undefined;
      expect(publishedRecord?.confidence).toBe("admin_verified");
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

  it("pages a dense mission board with two bounded queries and no per-mission lookups", () => {
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

    const page = service.getMissionsPage({ limit: 25, offset: 100, sort: "stale" });

    expect(page.missions).toHaveLength(25);
    expect(page.pagination).toEqual({ total: 2_500, limit: 25, offset: 100, hasMore: true });
    expect(prepareSpy).toHaveBeenCalledTimes(2);
    prepareSpy.mockRestore();
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

    service.runMissionMaintenance({ forceRefresh: true });
    const missions = service.listMissions({ limit: 50, sort: "points" });
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
    expect(byId.get("auto:venue:auto-fresh:happy-hour")).toEqual(expect.objectContaining({
      points: 5,
      reason: "Missing happy-hour details - add current specials",
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
    service.savePrivacySettings(user, {
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
    });

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
    service.savePrivacySettings(user, {
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
    });

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

  it("creates missing venue requests through the public request service", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "missing-venue-request-user");

    const result = service.createVenueRequest(user, {
      anonymousSessionId: "anon-newbay",
      requestType: "missing_venue",
      venueId: null,
      venueName: "Newbay Hotel",
      beerName: null,
      suburb: "Brighton",
      notes: "Address: 329 New St, Brighton VIC 3186",
    });

    expect(result.message).toBe("Newbay Hotel has been added to the admin review queue.");
    expect(repository.listVenueRequests(10)).toEqual([
      expect.objectContaining({
        requestType: "missing_venue",
        venueName: "Newbay Hotel",
        suburb: "Brighton",
        status: "open",
      }),
    ]);
  });

  it("creates exactly one mission from a pending venue request", () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const user = createAccount(repository, "mission-request-user");
    const admin = createAccount(repository, "mission-request-admin", "admin");
    const created = service.createVenueRequest(user, {
      anonymousSessionId: null,
      requestType: "missing_venue",
      venueId: null,
      venueName: "Only Once Hotel",
      beerName: null,
      suburb: "Richmond",
      notes: null,
    });

    const first = service.createMissionFromRequest(admin, created.request.id);

    expect(first).toEqual(expect.objectContaining({
      mission: expect.objectContaining({ venueName: "Only Once Hotel" }),
      request: expect.objectContaining({ status: "mission_created" }),
    }));
    expect(() => service.createMissionFromRequest(admin, created.request.id))
      .toThrow("already has a mission");
    expect(database.prepare("SELECT count(*) AS count FROM missions WHERE venue_name = ?")
      .get("Only Once Hotel")).toEqual({ count: 1 });
    expect(repository.getVenueRequestById(created.request.id)?.missionId).toBe(first.mission.id);
  });

  it("deduplicates partner leads that use venue aliases for the same venue", () => {
    const { repository } = createRepository();

    repository.recordEvent({
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
    repository.recordEvent({
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
    repository.recordEvent({
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

    const leads = repository.getPotentialPartnerLeads({
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
      accessState: "claim_required",
      selectedVenue: null,
    }));
    const claimResult = service.createBarClaimRequest(normalUser, {
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
    expect(service.getVenuePortal(normalUser, { venueId: "venue-1" }).claimRequests).toHaveLength(1);
    expect(service.createBarClaimRequest(normalUser, {
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

    const reviewedClaim = service.reviewVenueClaimRequest(admin, claimResult.claim.id, {
      status: "approved",
      reviewNote: "Verified with the venue's published phone number.",
    });
    expect(reviewedClaim.assignment).toEqual(expect.objectContaining({
      userId: normalUser.id,
      venueId: "venue-1",
      accessLevel: "manager",
    }));
    expect(service.getVenuePortal(repository.getAccountById(normalUser.id)!, { venueId: "venue-1" }))
      .toEqual(expect.objectContaining({ accessLevel: "manager" }));

    const assignment = service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "venue-1",
      venueName: "Rooftop Bar",
      suburb: "Melbourne",
    });
    const managerAccount = repository.getAccountById(manager.id)!;

    expect(assignment.assignment.status).toBe("active");
    expect(managerAccount.role).toBe("venue_manager");
    expect(() => service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "venue-1",
      venueName: "Rooftop Bar",
      suburb: "Melbourne",
      accessLevel: "counter_staff",
    })).toThrow("already a manager");
    expect(repository.getVenueManagerAssignment({
      userId: manager.id,
      venueId: "venue-1",
      activeOnly: false,
    })).toEqual(expect.objectContaining({ accessLevel: "manager", status: "active" }));
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

    const partnerAdmin = service.getVenuePartnerAdmin(admin);
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
    const outreach = service.upsertVenueOutreach(admin, {
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
      lastContactedAt: "2026-06-15",
    }));
    service.upsertVenueOutreach(admin, {
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
    const partnerAdminWithContext = service.getVenuePartnerAdmin(admin, { limit: 1, offset: 1 });
    expect(partnerAdminWithContext.totals).toEqual(expect.objectContaining({
      outreach: 2,
      openOutreach: 1,
    }));
    expect(partnerAdminWithContext.leadRelationshipContext.assignedVenueIds).toContain("venue-1");
    expect(partnerAdminWithContext.leadRelationshipContext.outreachByVenueId["venue-1"]).toEqual(
      expect.objectContaining({ status: "contacted", tierFit: "pro" }),
    );

    const revoked = service.revokeVenueManager(admin, { userId: manager.id, venueId: "venue-1" });
    expect(revoked.assignment.status).toBe("revoked");
  });

  it("treats admin account search text as literal text instead of executable query syntax", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "account-search-admin", "admin");
    const target = createAccount(repository, "account-search-target");
    createAccount(repository, "account-search-decoy");

    expect(service.searchAccountsForAdmin(admin, { q: "' OR 1=1 --", limit: 25 }).accounts).toEqual([]);
    expect(service.searchAccountsForAdmin(admin, { q: "%' OR role = 'admin", limit: 25 }).accounts).toEqual([]);

    const normalSearch = service.searchAccountsForAdmin(admin, { q: "account-search-target", limit: 25 });
    expect(normalSearch.accounts).toEqual([
      expect.objectContaining({
        id: target.id,
        email: "account-search-target@example.com",
      }),
    ]);
  });

  it("standardises venue inventory beer rows before they are saved or reviewed", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "inventory-admin", "admin");
    const manager = createAccount(repository, "inventory-manager");

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "inventory-venue",
      venueName: "Inventory Bar",
      suburb: "Brunswick",
    });
    service.upsertBarProfile(admin, "inventory-venue", {
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

    const adminBeer = service.upsertBarBeer(admin, "inventory-venue", {
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
    }).beer;
    expect(adminBeer).toEqual(expect.objectContaining({
      beerName: "Stone & Wood Pacific Ale",
      normalizedBeerId: "stone_and_wood_pacific_ale",
      brewery: "Stone & Wood",
      style: "Pacific ale",
    }));

    const managerBeer = service.upsertBarBeer(repository.getAccountById(manager.id)!, "inventory-venue", {
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
    }).beer;
    expect(managerBeer).toEqual(expect.objectContaining({
      beerName: "Very Local Hazy Pint",
      normalizedBeerId: "very_local_hazy_pint",
    }));
    expect(repository.listBarPendingChanges({ barId: "inventory-venue", status: "pending", limit: 10 })).toHaveLength(0);
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

  it("scopes venue-manager access while letting assigned managers maintain beer prices directly", () => {
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

    expect(() => service.createSubmission(managerAccount, createSubmissionSchema.parse({
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
    }))).toThrow("Venue accounts use the venue dashboard instead of reward submissions.");

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
    expect(profile).toEqual(expect.objectContaining({
      profile: expect.objectContaining({ name: "Corner Hotel", membershipTier: "basic" }),
      message: "Bar profile saved.",
    }));
    expect(repository.getBarProfile("bar-1")).toEqual(expect.objectContaining({ name: "Corner Hotel", membershipTier: "basic" }));

    expect(() => service.upsertBarSpecial(managerAccount, "bar-1", {
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
    })).toThrow("Pro venue tier required");

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
      membershipTier: "pro",
      active: true,
      expectedUpdatedAt: profile.profile.updatedAt,
    });
    expect(repository.getBarProfile("bar-1")?.membershipTier).toBe("pro");

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
      priceConfirmed: true,
      stockConfirmed: true,
    });
    const happyHour = service.upsertBarHappyHour(managerAccount, "bar-1", {
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
    const special = service.upsertBarSpecial(managerAccount, "bar-1", {
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

    const portal = service.getVenuePortal(managerAccount, { venueId: "bar-1" });
    expect(portal.pendingChanges).toHaveLength(0);
    expect(portal.inventory.beers).toHaveLength(1);
    expect(portal.inventory.happyHours).toHaveLength(1);
    expect(portal.inventory.specials).toHaveLength(1);
    expect(portal.tier.analyticsLocked).toBe(false);

    const adminPortal = service.getVenuePortal(admin, { venueId: "bar-1" });
    expect(adminPortal.pendingChanges).toHaveLength(0);
    expect(service.getVenuePartnerAdmin(admin).pendingChanges).toHaveLength(0);
    expect(service.getVenuePortal(otherManagerAccount, { venueId: "bar-2" }).pendingChanges).toHaveLength(0);
    expect(() => service.getVenuePortal(otherManagerAccount, { venueId: "bar-1" })).toThrow("assigned venues");

    const publicBeforeApproval = service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-before-approval",
    });
    expect(publicBeforeApproval.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        beerName: "Carlton Draught",
        price: 13,
        sourceType: "venue_manager_portal",
      }),
      expect.objectContaining({
        displayKind: "special",
        specialTitle: "Venue special",
        priceRedacted: true,
        sourceType: "venue_manager_portal:special",
      }),
    ]));
    expect(publicBeforeApproval.records.some((record) => record.displayKind === "happy_hour")).toBe(true);

    const approvedPortal = service.getVenuePortal(managerAccount, { venueId: "bar-1" });
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

    const publicPreview = service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-preview-anon",
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
        happyHourBeers: expect.arrayContaining([
          expect.objectContaining({ beerName: "Carlton Draught", servingSize: "pint", happyHourPrice: 9, offerText: "House pint" }),
        ]),
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
    const previewHappyHour = publicPreview.records.find((record) => record.displayKind === "happy_hour");
    expect(previewHappyHour?.happyHourBeers?.[0]).toMatchObject({
      beerName: "Carlton Draught",
      happyHourPrice: 9,
      offerText: "House pint",
    });
    expect(previewHappyHour?.happyHourBeers?.[0]).not.toHaveProperty("price");

    const venuePreview = service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-reveal-anon",
    });
    expect(venuePreview.preview).toEqual(expect.objectContaining({ model: "fixed_preview", lockedCount: 1 }));
    expect(venuePreview.records).toEqual(expect.arrayContaining([
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
        happyHourBeers: expect.arrayContaining([
          expect.objectContaining({ beerName: "Carlton Draught", servingSize: "pint", happyHourPrice: 9, offerText: "House pint" }),
        ]),
      }),
    ]));
    expect(venuePreview.records).toEqual(expect.arrayContaining([
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
      expectedUpdatedAt: repository.getBarProfile("bar-1")!.updatedAt,
    });
    expect(hideAttempt.profile).toEqual(expect.objectContaining({ active: true }));

    expect(service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-inactive-preview",
    }).records.length).toBeGreaterThan(0);

    expect(service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-rejected-preview",
    }).records.length).toBeGreaterThan(0);

    const approvedBeerId = beer.beer.id;
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
      expectedUpdatedAt: beer.beer.updatedAt,
    });
    expect(priceBypassAttempt).toEqual(expect.objectContaining({
      beer: expect.objectContaining({ id: approvedBeerId, price: 15.5 }),
      message: "Beer row saved.",
    }));
    const afterDirectPriceUpdate = service.listPriceRecords(null, {
      limit: 20,
      venueId: "bar-1",
      anonymousSessionId: "bar-direct-bypass",
    });
    expect(afterDirectPriceUpdate.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ beerName: "Carlton Draught", price: 15.5 }),
    ]));

    expect(service.deleteBarBeer(managerAccount, "bar-1", approvedBeerId, repository.getBarBeerById(approvedBeerId)!.updatedAt))
      .toEqual(expect.objectContaining({ deleted: true, message: "Beer row removed." }));
    expect(service.deleteBarHappyHour(managerAccount, "bar-1", happyHour.happyHour.id, happyHour.happyHour.updatedAt))
      .toEqual(expect.objectContaining({ deleted: true, message: "Happy hour removed." }));
    expect(service.deleteBarSpecial(managerAccount, "bar-1", special.special.id, special.special.updatedAt))
      .toEqual(expect.objectContaining({ deleted: true, message: "Pint Path special removed." }));
    const afterDirectDelete = service.getVenuePortal(managerAccount, { venueId: "bar-1" });
    expect(afterDirectDelete.inventory.beers).toHaveLength(0);
    expect(afterDirectDelete.inventory.happyHours).toHaveLength(0);
    expect(afterDirectDelete.inventory.specials).toHaveLength(0);
    expect(afterDirectDelete.pendingChanges).toHaveLength(0);
  });

  it("holds burst venue-manager deletes for admin review after three deletes in an hour", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "delete-guard-admin", "admin");
    const manager = createAccount(repository, "delete-guard-manager");

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "delete-guard-bar",
      venueName: "Delete Guard Bar",
      suburb: "Brighton",
    });
    const managerAccount = repository.getAccountById(manager.id)!;

    const beerIds = ["guard-beer-1", "guard-beer-2", "guard-beer-3", "guard-beer-4"];
    for (const [index, beerId] of beerIds.entries()) {
      service.upsertBarBeer(admin, "delete-guard-bar", {
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
    const happyHour = service.upsertBarHappyHour(admin, "delete-guard-bar", {
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
      expect(service.deleteBarBeer(managerAccount, "delete-guard-bar", beerId, repository.getBarBeerById(beerId)!.updatedAt))
        .toEqual(expect.objectContaining({ deleted: true, message: "Beer row removed." }));
    }

    expect(service.deleteBarHappyHour(managerAccount, "delete-guard-bar", happyHour.happyHour.id, happyHour.happyHour.updatedAt))
      .toEqual(expect.objectContaining({ deleted: true, message: "Happy hour removed." }));

    const heldDelete = service.deleteBarBeer(managerAccount, "delete-guard-bar", beerIds[3], repository.getBarBeerById(beerIds[3])!.updatedAt);
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
      repository.createBarPendingChange({
        id: `delete-guard-filler-${index}`,
        barId: "delete-guard-bar",
        changeType: "beer",
        action: "delete",
        targetId: `unrelated-target-${index}`,
        payload: { beerName: `Unrelated Beer ${index}` },
        submittedBy: managerAccount.id,
        now: `2026-05-04T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
      });
    }
    expect(pendingBarChangeFrom(service.deleteBarBeer(managerAccount, "delete-guard-bar", beerIds[3], repository.getBarBeerById(beerIds[3])!.updatedAt)).id)
      .toBe(pendingDelete.id);
    expect(repository.listBarPendingChanges({ barId: "delete-guard-bar", status: "pending", limit: -1 })
      .filter((change) => change.targetId === beerIds[3])).toHaveLength(1);

    const portalAfterHeldDelete = service.getVenuePortal(managerAccount, { venueId: "delete-guard-bar" });
    expect(portalAfterHeldDelete.inventory.beers).toHaveLength(1);
    expect(portalAfterHeldDelete.inventory.beers[0]?.id).toBe(beerIds[3]);
    expect(portalAfterHeldDelete.pendingChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pendingDelete.id, action: "delete", targetId: beerIds[3] }),
    ]));

    service.reviewBarPendingChange(admin, pendingDelete.id, { status: "approved", rejectionReason: null });
    expect(service.getVenuePortal(managerAccount, { venueId: "delete-guard-bar" }).inventory.beers).toHaveLength(0);
  });

  it("owns pending review atomically and rolls the review back when publishing fails", () => {
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
    const beer = repository.upsertBarBeer({
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
    const pending = repository.createBarPendingChange({
      id: "atomic-review-change",
      barId: "atomic-review-venue",
      changeType: "beer",
      action: "delete",
      targetId: beer.id,
      payload: { id: beer.id, beerName: beer.beerName, expectedUpdatedAt: beer.updatedAt },
      submittedBy: admin.id,
      now: NOW,
    });
    const internals = service as unknown as { applyApprovedBarChange: () => void };
    const applySpy = vi.spyOn(internals, "applyApprovedBarChange").mockImplementation(() => {
      expect(repository.getBarPendingChangeById(pending.id)?.status).toBe("approved");
      throw new Error("simulated publish failure");
    });

    expect(() => service.reviewBarPendingChange(admin, pending.id, { status: "approved", rejectionReason: null }))
      .toThrow("simulated publish failure");
    expect(repository.getBarPendingChangeById(pending.id)?.status).toBe("pending");
    expect(repository.getBarBeerById(beer.id)).not.toBeNull();

    applySpy.mockRestore();
    expect(service.reviewBarPendingChange(admin, pending.id, { status: "approved", rejectionReason: null }).pendingChange?.status)
      .toBe("approved");
    expect(repository.getBarBeerById(beer.id)).toBeNull();
    expect(() => service.reviewBarPendingChange(admin, pending.id, { status: "approved", rejectionReason: null }))
      .toThrow("already been reviewed");
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
    expect(freePortal.tier.monthlyReports).toBe(false);
    expect(freePortal.tier.analyticsLocked).toBe(true);
    expect(freePortal.analytics).toBeNull();
    expect(freePortal.monthlyReport).toBeNull();

    const freeBeer = service.upsertBarBeer(managerAccount, "free-bar-1", {
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
    expect(service.getVenuePortal(managerAccount, { venueId: "free-bar-1" }).inventory.beers).toHaveLength(1);
    expect(service.upsertBarHappyHour(managerAccount, "free-bar-1", {
      id: null,
      title: "Weekday happy hour",
      daysOfWeek: ["mon"],
      startTime: "16:00",
      endTime: "18:00",
      description: "$9 pints.",
      active: true,
    })).toEqual(expect.objectContaining({ happyHour: expect.objectContaining({ title: "Weekday happy hour" }) }));
    expect(() => service.upsertBarSpecial(managerAccount, "free-bar-1", {
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
    })).toThrow("Pro venue tier required");
    expect(() => service.exportVenueMonthlyReport(managerAccount, "free-bar-1", "2026-05", {
      format: "json",
    })).toThrow("Pro venue tier required");
  });

  it("saves direct venue-portal beer API writes without admin approval", async () => {
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
      expect(repository.listBarClaimRequests({ limit: 10 })).toHaveLength(1);
      expect(repository.listVenueManagerAssignments({ userId: user.id, activeOnly: true, limit: 10 })).toHaveLength(0);

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
      expect(repository.listBarClaimRequests({ limit: 10 })).toHaveLength(1);
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
    repository.recordEvent({
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
      repository.recordEvent({
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
      repository.recordEvent({
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
      repository.recordEvent({
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
    expect(proProfile.profile.membershipTier).toBe("pro");
    expect(proProfile.profile.highlightedName).toBe(true);
    expect(proProfile.profile.premiumBadge).toBe("Pro");
    expect(proProfile.profile.promoted).toBe(true);
    expect(proProfile.profile.featuredSpecialEligible).toBe(true);
    repository.upsertBarBeer({
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
    service.upsertBarProfile(admin, "bar-tier-local-1", {
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
    repository.upsertBarBeer({
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
    service.upsertBarProfile(admin, "bar-tier-local-2", {
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
    repository.upsertBarBeer({
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

    const proPortal = service.getVenuePortal(managerAccount, { venueId: "bar-tier-1" });
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

    const proSpecial = service.upsertBarSpecial(managerAccount, "bar-tier-1", {
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

  it("prioritises Pro venue changes in the admin review queue", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "priority-review-admin", "admin");
    const proManager = createAccount(repository, "priority-pro-manager");
    const basicManager = createAccount(repository, "priority-basic-manager");

    service.assignVenueManager(admin, {
      userId: proManager.id,
      venueId: "priority-pro-bar",
      venueName: "Priority Pro Bar",
      suburb: "Fitzroy",
    });
    service.assignVenueManager(admin, {
      userId: basicManager.id,
      venueId: "priority-basic-bar",
      venueName: "Priority Basic Bar",
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
    service.upsertBarProfile(admin, "priority-basic-bar", {
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

    const queueFourthDelete = (managerId: string, venueId: string) => {
      const manager = repository.getAccountById(managerId)!;
      const beers = Array.from({ length: 4 }, (_, index) => service.upsertBarBeer(manager, venueId, {
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
      }).beer);
      beers.slice(0, 3).forEach((beer) => {
        expect(service.deleteBarBeer(manager, venueId, beer.id, beer.updatedAt)).toEqual(expect.objectContaining({ deleted: true }));
      });
      return service.deleteBarBeer(manager, venueId, beers[3]!.id, beers[3]!.updatedAt);
    };

    expect(queueFourthDelete(basicManager.id, "priority-basic-bar"))
      .toEqual(expect.objectContaining({ pendingChange: expect.objectContaining({ changeType: "beer", action: "delete" }) }));
    expect(queueFourthDelete(proManager.id, "priority-pro-bar"))
      .toEqual(expect.objectContaining({ pendingChange: expect.objectContaining({ changeType: "beer", action: "delete" }) }));

    const pending = service.getVenuePartnerAdmin(admin).pendingChanges;
    expect(pending).toHaveLength(2);
    expect(pending[0]?.barId).toBe("priority-pro-bar");
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

    service.upsertBarProfile(admin, "venue-detail-1", {
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
    expect(await service.getPublicVenueById("missing-venue")).toBeNull();
  });

  it("activates the Pro bar tier through demo checkout without Stripe keys", async () => {
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

    const proCheckout = await service.createBarTierCheckout(managerAccount, "bar-checkout-1", { tier: "pro" });
    expect(proCheckout.mode).toBe("demo");
    expect(proCheckout.profile.membershipTier).toBe("pro");
    expect(proCheckout.tier.analyticsLocked).toBe(false);
    expect(proCheckout.profile.highlightedName).toBe(true);
    expect(proCheckout.profile.premiumBadge).toBe("Pro");
  });

  it("preserves dedicated verification timestamps and exposes durable report/reconciliation settings", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "integrity-settings-admin", "admin");
    const manager = createAccount(repository, "integrity-settings-manager");
    repository.updateAccountSecurityClaims({ userId: manager.id, emailVerifiedAt: NOW, now: NOW });
    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "integrity-settings-venue",
      venueName: "Integrity Hotel",
      suburb: "Fitzroy",
    });
    service.upsertBarProfile(admin, "integrity-settings-venue", {
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
    const created = service.upsertBarBeer(managerAccount, "integrity-settings-venue", {
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
    }).beer;
    const noteOnly = service.upsertBarBeer(managerAccount, "integrity-settings-venue", {
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
    }).beer;
    expect(noteOnly.priceVerifiedAt).toBe(created.priceVerifiedAt);
    expect(noteOnly.stockVerifiedAt).toBe(created.stockVerifiedAt);
    const changedPrice = service.upsertBarBeer(managerAccount, "integrity-settings-venue", {
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
    }).beer;
    expect(changedPrice.priceVerifiedAt).toBeNull();
    expect(changedPrice.stockVerifiedAt).toBe(created.stockVerifiedAt);

    const settings = service.updateVenueReportDeliverySettings(managerAccount, "integrity-settings-venue", {
      enabled: true,
      recipients: [managerAccount.email],
    });
    expect(settings).toEqual(expect.objectContaining({
      recipients: [managerAccount.email],
      effectiveRecipients: [managerAccount.email],
      recipientMode: "custom",
    }));
    expect(service.getVenueReconciliation(managerAccount, "integrity-settings-venue", { limit: 25, offset: 0 }))
      .toEqual(expect.objectContaining({
        discountRedemptions: expect.objectContaining({ total: 0, hasMore: false }),
        pintPointActivity: expect.objectContaining({ total: 0, hasMore: false }),
      }));
  });

  it("removes rejected pending catalogue names from immediately managed venue inventory", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "catalog-integrity-admin", "admin");
    const manager = createAccount(repository, "catalog-integrity-manager");
    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "catalog-integrity-venue",
      venueName: "Catalogue Hotel",
      suburb: "Richmond",
    });
    const managerAccount = repository.getAccountById(manager.id)!;
    service.upsertBarBeer(managerAccount, "catalog-integrity-venue", {
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
    const pending = service.getAdminBeerCatalog(admin).pending.find((item) => item.name === "Website Navigation Lager");
    expect(pending).toBeTruthy();
    service.rejectBeerCatalogItem(admin, pending!.key, { reviewNote: "Navigation copy, not a real beer." });
    expect(repository.listBarBeers("catalog-integrity-venue")).toEqual([]);
  });
});
