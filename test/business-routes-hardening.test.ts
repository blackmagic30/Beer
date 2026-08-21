import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import express from "express";
import { beforeEach, describe, expect, it } from "vitest";

import { clearRateLimitBucketsForTests } from "../src/middleware/rate-limit.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { createBusinessRouter } from "../src/modules/business/business.routes.js";
import type { BusinessService } from "../src/modules/business/business.service.js";

function routesSource() {
  return fs.readFileSync(path.resolve(process.cwd(), "src/modules/business/business.routes.ts"), "utf8");
}

function adminRoutesSource() {
  return fs.readFileSync(path.resolve(process.cwd(), "src/modules/admin/admin.routes.ts"), "utf8");
}

async function withBusinessRouter(callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const service = {
    assertCommercialVenueFeatureOpen: () => undefined,
    requireAccount: () => {
      throw new Error("test authentication stop");
    },
  } as unknown as BusinessService;
  const app = express();
  app.use(express.json());
  app.use("/api/business", createBusinessRouter(service));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
}

beforeEach(() => {
  clearRateLimitBucketsForTests();
});

describe("business route hardening", () => {
  it("rate limits and safely cache-partitions the public venue directory", () => {
    const source = routesSource();
    const limiter = source.slice(
      source.indexOf("const venueDirectoryReadLimiter"),
      source.indexOf("const writeLimiter"),
    );

    expect(source).toContain("const venueDirectoryReadLimiter = createRateLimiter({");
    expect(limiter).toContain('keyPrefix: "business:venue-directory"');
    expect(limiter).toContain("windowMs: 60_000");
    expect(limiter).toContain("max: 120");
    expect(source).toContain('router.get("/venues", venueDirectoryReadLimiter');
    expect(source).toContain('res.vary("Origin")');
    expect(source).toContain('res.vary("Authorization")');
    expect(source).toContain('res.vary("Cookie")');
    expect(source).toContain("Math.min(query.limit, PUBLIC_VENUE_DIRECTORY_PAGE_LIMIT)");
  });

  it("rate limits admin mutation routes", () => {
    const source = routesSource();

    expect(source).toContain('const adminWriteLimiter = createRateLimiter({');
    expect(source).toContain('const adminReviewLimiter = createRateLimiter({');
    expect(source).toContain('router.get("/admin/accounts"');
    [
      'router.post("/admin/reports/monthly/generate", adminWriteLimiter',
      'router.post("/admin/reports/monthly/deliver", adminWriteLimiter',
      'router.post("/admin/venue-pending-changes/:id/review", adminWriteLimiter',
      'router.post("/admin/venue-managers", adminWriteLimiter',
      'router.post("/admin/venue-managers/revoke", adminWriteLimiter',
      'router.post("/admin/venue-interest/:id/status", adminWriteLimiter',
      'router.post("/admin/venue-outreach", adminWriteLimiter',
      'router.post("/admin/requests/:id/mission", adminWriteLimiter',
      'router.post("/admin/users/:id/status", adminWriteLimiter',
      'router.post("/demo/seed", adminWriteLimiter',
      'router.post("/missions", adminWriteLimiter',
    ].forEach((route) => expect(source).toContain(route));

    [
      'router.post("/admin/beer-catalog/reject-pending", adminReviewLimiter',
      'router.post("/admin/beer-catalog/:key/approve", adminReviewLimiter',
      'router.post("/admin/beer-catalog/:key/merge", adminReviewLimiter',
      'router.post("/admin/beer-catalog/:key/reject", adminReviewLimiter',
    ].forEach((route) => expect(source).toContain(route));
  });

  it("rate limits account mutation routes", () => {
    const source = routesSource();

    [
      'router.post("/account/display-name", writeLimiter',
      'router.post("/account/discount-pass", writeLimiter',
      'router.post("/account/free-pint-reward-code", writeLimiter',
      'router.post("/account/age-confirm", writeLimiter',
      'router.post("/account/legal-acceptance", writeLimiter',
      'router.post("/account/preferences", writeLimiter',
      'router.post("/account/privacy-settings", writeLimiter',
      'router.post("/account/delete-request", writeLimiter',
      'router.post("/account/saved-items", writeLimiter',
      'router.delete("/account/saved-items", writeLimiter',
    ].forEach((route) => expect(source).toContain(route));

    expect(source).toContain('router.get("/verification-candidates", lookupLimiter');
    expect(source).toContain('router.post("/submissions/:id/verifications", writeLimiter');
  });

  it("rate limits every account route that performs credential reauthentication", () => {
    const source = routesSource();

    [
      'router.post("/auth/browser-email-reauthentication", authLimiter',
      'router.post("/auth/logout-all", authLimiter',
      'router.get("/account/sessions", authLimiter',
      'router.delete("/account/sessions/:sessionId", writeLimiter',
      'router.get("/account/export", accountExportLimiter',
      'router.post("/account/delete-request", writeLimiter',
      'router.delete("/account/delete-request/:id", writeLimiter',
      'router.post("/venue-portal/:venueId/billing/portal", billingLimiter',
      'router.post("/billing/portal", billingLimiter',
    ].forEach((route) => expect(source).toContain(route));
  });

  it.each([
    ["browser email reauthentication", "/auth/browser-email-reauthentication", 12, { purpose: "account_export" }],
    ["account billing portal", "/billing/portal", 8, {}],
    ["venue billing portal", "/venue-portal/venue-1/billing/portal", 8, {}],
  ])("enforces the shared limiter before %s service work", async (_label, route, maximum, body) => {
    await withBusinessRouter(async (baseUrl) => {
      for (let request = 0; request < maximum; request += 1) {
        const response = await fetch(`${baseUrl}/api/business${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).not.toBe(429);
      }
      const limited = await fetch(`${baseUrl}/api/business${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(limited.status).toBe(429);
      await expect(limited.json()).resolves.toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: "Too many requests. Please wait a moment and try again.",
        }),
      }));
    });
  });

  it("documents that challenge-cookie cleanup cannot bypass the authenticated exchange", () => {
    const source = routesSource();
    const supabaseSessionRoute = source.slice(
      source.indexOf('router.post("/auth/supabase-session"'),
      source.indexOf('router.post("/auth/password-reset-complete"'),
    );

    const serviceCall = supabaseSessionRoute.indexOf(
      "await businessService.loginWithSupabaseAccessToken",
    );
    const cleanup = supabaseSessionRoute.indexOf(
      "if (browserEmailChallenge !== null)",
    );
    expect(serviceCall).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(serviceCall);
    expect(supabaseSessionRoute).toContain(
      "branch only expires the narrow challenge after a successful exchange",
    );
    expect(supabaseSessionRoute).toContain("codeql[js/user-controlled-bypass]");
    expect(supabaseSessionRoute).toContain("lgtm[js/user-controlled-bypass]");
  });

  it("does not let caller-controlled anonymous session ids or auth headers split rate limit buckets", () => {
    const source = routesSource();
    const identityFunction = source.slice(
      source.indexOf("function rateLimitIdentity"),
      source.indexOf("const priceReadLimiter"),
    );

    expect(identityFunction).not.toContain("anonymousSessionId");
    expect(identityFunction).not.toContain("authorization");
    expect(identityFunction).not.toContain("getAuthorization");
    expect(identityFunction).not.toContain("req.query");
    expect(identityFunction).not.toContain("req.body");
  });

  it("rate limits signed source-evidence creation and delivery", () => {
    const source = routesSource();

    expect(source).toContain('const sourceEvidenceLimiter = createRateLimiter({');
    expect(source).toContain('router.get("/submissions/:id/source-evidence-url", sourceEvidenceLimiter');
    expect(source).toContain('router.get("/source-evidence/:id", sourceEvidenceLimiter');
  });

  it("validates bounded venue and month params before monthly report exports", () => {
    const source = routesSource();
    const exportRoute = source.slice(
      source.indexOf('router.get("/venue-portal/:venueId/reports/:month/export"'),
      source.indexOf('router.get("/venue-portal/:venueId/reports/:month"'),
    );

    expect(exportRoute).toContain(
      'parseWithSchema(monthlyReportParamsSchema, req.params, "Invalid monthly report export request")',
    );
    expect(exportRoute).not.toContain("String(req.params.venueId");
    expect(exportRoute).not.toContain("String(req.params.month");
  });

  it("rate limits admin source-ingestion, OCR, review, and lookup routes", () => {
    const source = adminRoutesSource();

    expect(source).toContain('const adminLookupLimiter = createRateLimiter({');
    expect(source).toContain('const adminOcrLimiter = createRateLimiter({');
    expect(source).toContain('const adminReviewLimiter = createRateLimiter({');
    expect(source).toContain('const adminWriteLimiter = createRateLimiter({');
    [
      'router.get("/places/search", adminLookupLimiter',
      'router.get("/places/:placeId", adminLookupLimiter',
      'router.post("/venues", adminWriteLimiter',
      'router.post("/captures/manual", adminWriteLimiter',
      'router.post("/captures/menu-photo-ocr", adminOcrLimiter',
      'router.post("/ingestions/queue", adminOcrLimiter',
      'router.post("/ingestions/reject", adminReviewLimiter',
      'router.post("/ingestions/:id/publish", adminReviewLimiter',
      'router.post("/ingestions/:id/reject", adminReviewLimiter',
    ].forEach((route) => expect(source).toContain(route));
  });

  it("passes request context into standalone admin authorization checks", () => {
    const source = adminRoutesSource();

    expect(source).toContain("function getRequestContext");
    expect(source).toContain("await businessService.requireAdmin(getSessionAuthorization(req), getRequestContext(req));");
    expect(source).toContain('import { getSessionAuthorization } from "../../lib/session-cookie.js";');
  });
});
