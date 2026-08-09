import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function routesSource() {
  return fs.readFileSync(path.resolve(process.cwd(), "src/modules/business/business.routes.ts"), "utf8");
}

function adminRoutesSource() {
  return fs.readFileSync(path.resolve(process.cwd(), "src/modules/admin/admin.routes.ts"), "utf8");
}

describe("business route hardening", () => {
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
