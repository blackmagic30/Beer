import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function routesSource() {
  return fs.readFileSync(path.resolve(process.cwd(), "src/modules/business/business.routes.ts"), "utf8");
}

describe("business route hardening", () => {
  it("rate limits admin mutation routes", () => {
    const source = routesSource();

    expect(source).toContain('const adminWriteLimiter = createRateLimiter({');
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
});
