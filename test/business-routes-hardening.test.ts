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
    ].forEach((route) => expect(source).toContain(route));
  });
});
