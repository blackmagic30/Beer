import { describe, expect, it } from "vitest";

import { isBarPilotRoute } from "../src/modules/business/business.routes.js";

describe("bar pilot route scope", () => {
  it.each([
    "/account/pint-point-pass",
    "/account/free-pint-reward-code",
    "/account/counter-staff-invitations/invite-1/respond",
    "/venue-portal/venue-1/member-preview",
    "/venue-portal/venue-1/pint-point-drinks",
    "/venue-portal/venue-1/pint-point-drinks/purchase-1/void",
    "/venue-portal/venue-1/counter-staff",
    "/venue-portal/venue-1/counter-staff/revoke",
    "/venue-portal/venue-1/free-pint-rewards",
    "/venue-portal/venue-1/reconciliation",
    "/venue-portal/venue-1/pilot-demo-threshold",
  ])("allows the scoped route %s to reach service authorization", (pathname) => {
    expect(isBarPilotRoute(pathname)).toBe(true);
  });

  it.each([
    "/account/discount-pass",
    "/billing/checkout",
    "/beta/pub-golf/plan",
    "/admin/leaderboard-prizes",
    "/admin/reward-vouchers",
    "/venue-portal/venue-1/discount-redemptions",
    "/venue-portal/venue-1/reports",
    "/venue-portal/venue-1/report-delivery",
    "/venue-portal/venue-1/billing",
    "/venue-portal/venue-1/pos-integration",
    "/venue-portal/venue-1/specials",
    "/pos/discount-redemptions",
  ])("does not enable the deferred route %s", (pathname) => {
    expect(isBarPilotRoute(pathname)).toBe(false);
  });
});
