import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import BetterSqlite3 from "better-sqlite3";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { BusinessRepository, type SubmissionType, type SubscriptionStatus } from "../src/db/business.repository.js";
import { AppError } from "../src/lib/errors.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { createCallsRouter } from "../src/modules/calls/calls.routes.js";
import { createSubmissionSchema } from "../src/modules/business/business.schemas.js";
import { BusinessService } from "../src/modules/business/business.service.js";
import { createResultsRouter } from "../src/modules/results/results.routes.js";

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
  return new BusinessService(repository, {
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    FREE_PRICE_REVEALS_PER_DAY: 5,
    CONTRIBUTOR_UNLOCK_POINTS: 15,
    CONTRIBUTOR_UNLOCK_DAYS: 30,
    DEMO_BILLING_MODE: true,
    FIELD_TEST_MODE: false,
    SESSION_TTL_DAYS: 60,
    ADMIN_SESSION_TTL_DAYS: 7,
    ANALYTICS_MIN_BUCKET_SIZE: 5,
    ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: false,
    NODE_ENV: "test",
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_PRICE_MONTHLY: undefined,
    STRIPE_PRICE_YEARLY: undefined,
    STRIPE_PLUS_PRICE_ID: undefined,
    STRIPE_PRO_PRICE_ID: undefined,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: undefined,
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    ADMIN_EMAILS: "admin@example.com",
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

function createSubmission(
  repository: BusinessRepository,
  input: {
    id: string;
    userId: string;
    venueId: string;
    venueName?: string;
    submissionType?: SubmissionType;
    beerName?: string;
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
        beerName: input.beerName ?? "Carlton Draft",
        normalizedBeerId: null,
        servingSize: "pint",
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

function createStripeSignature(payload: object, secret: string, timestamp = "1777881600") {
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
  openDatabases.forEach((database) => database.close());
  openDatabases = [];
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
      submissionType: "photo_upload",
      items: [],
    });

    expect(parsed.items).toEqual([]);
  });

  it("still requires a beer row for single beer price submissions", () => {
    const result = createSubmissionSchema.safeParse({
      ...baseSubmission,
      submissionType: "single_beer_price",
      items: [],
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

describe("production hardening", () => {
  it("redacts price records by default and enforces anonymous daily reveals server-side", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, { FREE_PRICE_REVEALS_PER_DAY: 1 });
    const submitter = createAccount(repository, "submitter");
    const admin = createAccount(repository, "admin", "admin");
    const first = createSubmission(repository, { id: "submission-1", userId: submitter.id, venueId: "venue-1", price: 14 });
    const second = createSubmission(repository, { id: "submission-2", userId: submitter.id, venueId: "venue-2", price: 16 });

    approve(repository, first.id, admin.id);
    approve(repository, second.id, admin.id);

    const preview = service.listPriceRecords(null, {
      anonymousSessionId: "anon-price-test",
      reveal: false,
      limit: 20,
      venueId: null,
    });
    expect(preview.records).toHaveLength(2);
    expect(preview.records.every((record) => record.price === null)).toBe(true);
    expect(preview.records.every((record) => Boolean((record as { priceRedacted?: boolean }).priceRedacted))).toBe(true);

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
    })).toBe(1);
    expect(repository.countEvents({
      eventType: "price_view_blocked_free_limit",
      userId: null,
      anonymousSessionId: "anon-price-test",
      since: todayStart.toISOString(),
    })).toBe(1);
  });

  it("limits free users while allowing premium, contributor, and admin exact price access", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository, { FREE_PRICE_REVEALS_PER_DAY: 1 });
    const submitter = createAccount(repository, "submitter");
    const freeUser = createAccount(repository, "free-user");
    let premiumUser = createAccount(repository, "premium-user");
    let contributor = createAccount(repository, "contributor-user");
    const admin = createAccount(repository, "admin", "admin");
    const first = createSubmission(repository, { id: "submission-1", userId: submitter.id, venueId: "venue-1", price: 12 });
    const second = createSubmission(repository, { id: "submission-2", userId: submitter.id, venueId: "venue-2", price: 17 });

    approve(repository, first.id, admin.id);
    approve(repository, second.id, admin.id);
    premiumUser = updateSubscription(repository, premiumUser.id, "premium_monthly");
    contributor = updateSubscription(repository, contributor.id, "contributor_unlocked", PREMIUM_UNTIL);

    expect(service.listPriceRecords(freeUser, {
      anonymousSessionId: null,
      reveal: true,
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

  it("keeps exact price reads behind the business API in the public viewer", () => {
    const viewerHtml = fs.readFileSync(path.resolve(process.cwd(), "viewer/index.html"), "utf8");
    const adminHtml = fs.readFileSync(path.resolve(process.cwd(), "viewer/admin.html"), "utf8");
    const legacyMapHtml = fs.readFileSync(path.resolve(process.cwd(), "viewer/google-map.html"), "utf8");

    expect(viewerHtml).not.toContain(".from(\"call_results\")");
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
    expect(adminHtml).not.toContain("Admin secret");
    expect(adminHtml).not.toContain("Unlock admin actions");
    expect(legacyMapHtml).not.toContain("Fetching venues from Supabase");
    expect(legacyMapHtml).not.toContain("<div id=\"debug\"");
  });

  it("protects legacy call and result APIs behind admin auth", async () => {
    const businessService = {
      requireAdmin(authorization: string | undefined) {
        if (!authorization) {
          throw new AppError("Login required.", 401);
        }

        if (authorization !== "Bearer admin-token") {
          throw new AppError("Admin access required.", 403);
        }

        return { id: "admin", role: "admin", subscriptionStatus: "admin" };
      },
    } as unknown as BusinessService;
    const app = express();
    app.use(express.json());
    app.use("/api/calls", createCallsRouter({
      listCallRuns: () => [],
      getCallRun: () => null,
      createOutboundCall: async () => ({ callRun: null }),
    } as never, businessService));
    app.use("/api/results", createResultsRouter({
      list: () => [],
    } as never, businessService));
    app.use(errorHandler);

    await withHttpServer(app, async (baseUrl) => {
      expect((await fetch(`${baseUrl}/api/calls`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/api/results`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/api/calls`, {
        headers: { Authorization: "Bearer user-token" },
      })).status).toBe(403);
      expect((await fetch(`${baseUrl}/api/results`, {
        headers: { Authorization: "Bearer user-token" },
      })).status).toBe(403);
      expect((await fetch(`${baseUrl}/api/calls`, {
        headers: { Authorization: "Bearer admin-token" },
      })).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/results`, {
        headers: { Authorization: "Bearer admin-token" },
      })).status).toBe(200);
    });
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

    expect(service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      venueId: "venue-photo-valid",
      sourcePhotoDataUrl: PNG_DATA_URL,
    })).submission.sourcePhotoUrl).toBe(PNG_DATA_URL);

    expect(service.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      venueId: "venue-photo-webp",
      sourcePhotoDataUrl: WEBP_DATA_URL,
    })).submission.sourcePhotoUrl).toBe(WEBP_DATA_URL);

    const productionService = createBusinessService(repository, {
      NODE_ENV: "production",
      ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: false,
    });
    expect(() => productionService.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      venueId: "venue-photo-prod",
      sourcePhotoDataUrl: PNG_DATA_URL,
    }))).toThrow("disabled in production");

    const productionOverrideService = createBusinessService(repository, {
      NODE_ENV: "production",
      ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: true,
    });
    expect(productionOverrideService.createSubmission(user, createSubmissionSchema.parse({
      ...baseSubmission,
      venueId: "venue-photo-prod-override",
      sourcePhotoDataUrl: PNG_DATA_URL,
    })).submission.sourcePhotoUrl).toBe(PNG_DATA_URL);
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
    })).submission.sourcePhotoUrl).toBe("https://example.com/menu-photo.jpg");
  });

  it("returns clean access errors for self-review and already-reviewed submissions", () => {
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

    expect(() => service.reviewSubmission(admin, ownSubmission.id, approvePayload)).toThrow("Admins cannot review their own submissions");
    service.reviewSubmission(admin, submission.id, approvePayload);
    expect(() => service.reviewSubmission(otherAdmin, submission.id, approvePayload)).toThrow("Submission has already been reviewed");
    expect(repository.listSecurityAuditLogs(10)[0]).toEqual(expect.objectContaining({
      action: "admin_submission_review",
      actorUserId: admin.id,
      targetId: submission.id,
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

  it("rejects expired, revoked, and suspended sessions and supports logout flows", () => {
    const { database, repository } = createRepository();
    const service = createBusinessService(repository);
    const signup = service.signup({
      email: "session-user@example.com",
      password: "password123",
      ageConfirmed: true,
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
    expect(() => service.handleStripeWebhook(signed.body, "t=1777881600,v1=bad")).toThrow("Invalid Stripe webhook signature");
    expect(() => service.handleStripeWebhook(signed.body, `t=1777881600,v1=${"z".repeat(64)}`)).toThrow("Invalid Stripe webhook signature");
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

  it("publishes approved submission items as photo-verified public price records", () => {
    const { repository } = createRepository();
    const user = createAccount(repository, "submitter");
    const admin = createAccount(repository, "admin", "admin");
    const submission = createSubmission(repository, {
      id: "submission-1",
      userId: user.id,
      venueId: "venue-1",
      beerName: "Stone & Wood",
      price: 15.5,
    });

    approve(repository, submission.id, admin.id);

    expect(repository.listLatestPriceRecords(10)).toEqual([
      expect.objectContaining({
        venueId: "venue-1",
        beerName: "Stone & Wood",
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
      metadata: { query: "Carlton Draft" },
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
      metadata: {},
      createdAt: NOW,
    });

    const preview = repository.getAnalyticsPreview();
    expect(preview.topSearchedBeers).toEqual([{ key: "carlton_draft", count: 1 }]);
    expect(preview.topClickedVenues).toEqual([{ key: "venue-1", count: 1 }]);
    expect(preview.topSuburbs).toEqual([{ key: "Richmond", count: 2 }]);
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
    expect(preview.topSearchedBeers).toEqual([{ key: "carlton_draught", count: 2 }]);
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
    expect(repository.removeSavedItem({ userId: user.id, itemType: "suburb", itemId: "fitzroy" })).toBe(true);
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
      accessState: "claim_required",
      selectedVenue: null,
    }));
    const claim = service.createBarClaimRequest(normalUser, {
      barId: "venue-1",
      barName: "Rooftop Bar",
      address: "Level 7, Melbourne",
      suburb: "Melbourne",
      requesterName: "Normal User",
      requesterRole: "Venue manager",
      contactEmail: "normal@example.com",
      contactPhone: null,
      message: "I manage this venue.",
    });
    expect(claim.claim.status).toBe("pending");
    expect(service.getVenuePortal(normalUser, { venueId: "venue-1" }).claimRequests).toHaveLength(1);

    const assignment = service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "venue-1",
      venueName: "Rooftop Bar",
      suburb: "Melbourne",
    });
    const managerAccount = repository.getAccountById(manager.id)!;

    expect(assignment.assignment.status).toBe("active");
    expect(managerAccount.role).toBe("venue_manager");

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
    expect(partnerAdmin.claimRequests[0]).toEqual(expect.objectContaining({ barName: "Rooftop Bar", status: "pending" }));
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

  it("lets assigned bar managers maintain profile, inventory, happy hours, and specials", () => {
    const { repository } = createRepository();
    const service = createBusinessService(repository);
    const admin = createAccount(repository, "bar-admin", "admin");
    const manager = createAccount(repository, "bar-manager");
    const normalUser = createAccount(repository, "bar-normal");

    service.assignVenueManager(admin, {
      userId: manager.id,
      venueId: "bar-1",
      venueName: "Corner Hotel",
      suburb: "Richmond",
    });
    const managerAccount = repository.getAccountById(manager.id)!;

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
      venueTags: ["has food", "live music", "near public transport"],
      membershipTier: "pro",
      active: true,
    });
    expect(profile.profile.membershipTier).toBe("basic");
    expect(profile.profile.highlightedName).toBe(false);

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

    expect(beer.beer.onTap).toBe(true);
    expect(happyHour.happyHour.daysOfWeek).toContain("fri");
    expect(special.special.price).toBe(25);

    const portal = service.getVenuePortal(managerAccount, { venueId: "bar-1" });
    expect(portal.inventory.beers).toHaveLength(1);
    expect(portal.inventory.happyHours).toHaveLength(1);
    expect(portal.inventory.specials).toHaveLength(1);
    expect(portal.tier.analyticsLocked).toBe(true);
    expect(portal.insights.aggregateInsights).toBeNull();
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
    expect(plusPortal.analytics?.barLookups).toBe(1);
    expect(plusPortal.analytics?.privacyFloorMet).toBe(true);
    expect(plusPortal.analytics?.areaBeerSearches.length).toBeGreaterThan(0);
    expect(plusPortal.monthlyReport?.data).toBeTruthy();

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
