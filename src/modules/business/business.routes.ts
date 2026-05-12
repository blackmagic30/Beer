import crypto from "node:crypto";

import { Router, type Request } from "express";

import { success } from "../../lib/http.js";
import { parseWithSchema } from "../../lib/validation.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";

import {
  accountPreferencesSchema,
  adminDashboardQuerySchema,
  adminUserStatusSchema,
  ageConfirmSchema,
  barBeerSchema,
  barClaimRequestSchema,
  barHappyHourSchema,
  barProfileSchema,
  barSpecialSchema,
  barTierCheckoutSchema,
  authLoginSchema,
  authSignupSchema,
  checkoutSchema,
  createMissionSchema,
  createSubmissionSchema,
  eventTrackSchema,
  feedbackSchema,
  missionsQuerySchema,
  priceRecordsQuerySchema,
  removeSavedItemSchema,
  retentionQuerySchema,
  reviewSubmissionSchema,
  saveItemSchema,
  submissionsQuerySchema,
  venueRequestSchema,
  venueInterestSchema,
  venueInterestStatusSchema,
  venueManagerAssignmentSchema,
  venueManagerRevokeSchema,
  venueOutreachSchema,
  venuePortalQuerySchema,
  wrongPriceReportSchema,
} from "./business.schemas.js";
import type { BusinessService } from "./business.service.js";

function getAuthorization(req: Request): string | undefined {
  return req.header("authorization") ?? undefined;
}

function getOptionalAccount(req: Request, businessService: BusinessService) {
  return businessService.getAccountFromAuthorization(getAuthorization(req), getRequestContext(req));
}

function getRequestContext(req: Request) {
  return {
    ip: req.ip ?? req.socket.remoteAddress ?? null,
    userAgent: req.get("user-agent") ?? null,
  };
}

function requireAccount(req: Request, businessService: BusinessService) {
  return businessService.requireAccount(getAuthorization(req), getRequestContext(req));
}

function requireAdmin(req: Request, businessService: BusinessService) {
  return businessService.requireAdmin(getAuthorization(req), getRequestContext(req));
}

function stableIdentityPart(value: string): string {
  return value ? crypto.createHash("sha256").update(value).digest("hex").slice(0, 24) : "";
}

function rateLimitIdentity(req: Request): string {
  const authorization = getAuthorization(req) ?? "";
  const anonymousSessionId =
    typeof req.query.anonymousSessionId === "string"
      ? req.query.anonymousSessionId
      : typeof req.body?.anonymousSessionId === "string"
        ? req.body.anonymousSessionId
        : "";
  return [
    req.ip ?? req.socket.remoteAddress ?? "unknown-ip",
    stableIdentityPart(authorization),
    stableIdentityPart(anonymousSessionId),
  ].join(":");
}

const priceReadLimiter = createRateLimiter({
  keyPrefix: "business:price-records",
  windowMs: 60_000,
  max: 120,
  keyGenerator: rateLimitIdentity,
});

const writeLimiter = createRateLimiter({
  keyPrefix: "business:writes",
  windowMs: 10 * 60_000,
  max: 30,
  keyGenerator: rateLimitIdentity,
});

const authLimiter = createRateLimiter({
  keyPrefix: "business:auth",
  windowMs: 10 * 60_000,
  max: 12,
  keyGenerator: rateLimitIdentity,
});

const billingLimiter = createRateLimiter({
  keyPrefix: "business:billing",
  windowMs: 10 * 60_000,
  max: 8,
  keyGenerator: rateLimitIdentity,
});

const eventLimiter = createRateLimiter({
  keyPrefix: "business:events",
  windowMs: 10 * 60_000,
  max: 240,
  keyGenerator: rateLimitIdentity,
});

export function createBusinessRouter(businessService: BusinessService): Router {
  const router = Router();

  router.get("/config", (_req, res) => {
    res.json(success(businessService.getPublicConfig()));
  });

  router.post("/auth/signup", authLimiter, (req, res) => {
    const body = parseWithSchema(authSignupSchema, req.body, "Invalid signup payload");
    res.status(201).json(success(businessService.signup(body, getRequestContext(req))));
  });

  router.post("/auth/login", authLimiter, (req, res) => {
    const body = parseWithSchema(authLoginSchema, req.body, "Invalid login payload");
    res.json(success(businessService.login(body, getRequestContext(req))));
  });

  router.post("/auth/logout", authLimiter, (req, res) => {
    res.json(success(businessService.logout(getAuthorization(req), getRequestContext(req))));
  });

  router.post("/auth/logout-all", authLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    res.json(success(businessService.logoutAll(account, getRequestContext(req))));
  });

  router.get("/account", (req, res) => {
    const account = requireAccount(req, businessService);
    res.json(success(businessService.getAccountDashboard(account)));
  });

  router.post("/account/age-confirm", (req, res) => {
    parseWithSchema(ageConfirmSchema, req.body, "Invalid age confirmation payload");
    const account = requireAccount(req, businessService);
    res.json(success(businessService.confirmAge(account)));
  });

  router.post("/account/preferences", (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(accountPreferencesSchema, req.body, "Invalid preferences payload");
    res.json(success(businessService.savePreferences(account, body)));
  });

  router.post("/account/saved-items", (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(saveItemSchema, req.body, "Invalid saved item payload");
    res.status(201).json(success(businessService.saveItem(account, body)));
  });

  router.delete("/account/saved-items", (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(removeSavedItemSchema, req.body, "Invalid saved item removal payload");
    res.json(success(businessService.removeSavedItem(account, body)));
  });

  router.get("/access", (req, res) => {
    const account = getOptionalAccount(req, businessService);
    const anonymousSessionId =
      typeof req.query.anonymousSessionId === "string" ? req.query.anonymousSessionId : null;
    res.json(success(businessService.getAccessState(account, anonymousSessionId)));
  });

  router.get("/venues", async (req, res, next) => {
    try {
      const query = typeof req.query.q === "string" ? req.query.q : undefined;
      const limit =
        typeof req.query.limit === "string" && Number.isFinite(Number(req.query.limit))
          ? Math.min(1000, Math.max(1, Number(req.query.limit)))
          : 50;
      const venues = await businessService.listVenues(query, limit);
      res.json(success({ venues }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/submissions", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(createSubmissionSchema, req.body, "Invalid submission payload");
    const result = businessService.createSubmission(account, body);
    res.status(201).json(success(result));
  });

  router.post("/feedback", writeLimiter, (req, res) => {
    const account = getOptionalAccount(req, businessService);
    const body = parseWithSchema(feedbackSchema, req.body, "Invalid feedback payload");
    res.status(201).json(success(businessService.submitFeedback(account, body)));
  });

  router.post("/wrong-price-reports", writeLimiter, (req, res) => {
    const account = getOptionalAccount(req, businessService);
    const body = parseWithSchema(wrongPriceReportSchema, req.body, "Invalid wrong price report payload");
    res.status(201).json(success(businessService.reportWrongPrice(account, body)));
  });

  router.post("/requests", writeLimiter, (req, res) => {
    const account = getOptionalAccount(req, businessService);
    const body = parseWithSchema(venueRequestSchema, req.body, "Invalid request payload");
    res.status(201).json(success(businessService.createVenueRequest(account, body)));
  });

  router.post("/venue-interest", writeLimiter, (req, res) => {
    const account = getOptionalAccount(req, businessService);
    const body = parseWithSchema(venueInterestSchema, req.body, "Invalid venue interest payload");
    res.status(201).json(success(businessService.createVenueInterest(account, body)));
  });

  router.get("/submissions", (req, res) => {
    const account = getOptionalAccount(req, businessService);
    const query = parseWithSchema(submissionsQuerySchema, req.query, "Invalid submissions query");
    const submissions = businessService.listSubmissions(account, query);
    res.json(success({ submissions }));
  });

  router.post("/submissions/:id/review", (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(reviewSubmissionSchema, req.body, "Invalid review payload");
    const result = businessService.reviewSubmission(admin, req.params.id, body);
    res.json(success(result));
  });

  router.get("/missions", (req, res) => {
    const query = parseWithSchema(missionsQuerySchema, req.query, "Invalid missions query");
    const missions = businessService.listMissions(query);
    res.json(success({ missions }));
  });

  router.post("/missions", (req, res) => {
    requireAdmin(req, businessService);
    const body = parseWithSchema(createMissionSchema, req.body, "Invalid mission payload");
    const mission = businessService.createMission(body);
    res.status(201).json(success({ mission }));
  });

  router.get("/price-records", priceReadLimiter, (req, res) => {
    const account = getOptionalAccount(req, businessService);
    const query = parseWithSchema(priceRecordsQuerySchema, req.query, "Invalid price records query");
    res.json(success(businessService.listPriceRecords(account, {
      ...query,
      clientIp: req.ip,
    })));
  });

  router.post("/events", eventLimiter, (req, res) => {
    const account = getOptionalAccount(req, businessService);
    const body = parseWithSchema(eventTrackSchema, req.body, "Invalid analytics event payload");
    businessService.trackEvent(account, body);
    res.status(201).json(success({ recorded: true }));
  });

  router.get("/analytics/preview", (req, res) => {
    const admin = requireAdmin(req, businessService);
    res.json(success(businessService.getAnalyticsPreview(admin)));
  });

  router.get("/venue-portal", (req, res) => {
    const account = requireAccount(req, businessService);
    const query = parseWithSchema(venuePortalQuerySchema, req.query, "Invalid venue portal query");
    res.json(success(businessService.getVenuePortal(account, query)));
  });

  router.post("/bar-claim-requests", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(barClaimRequestSchema, req.body, "Invalid bar claim request payload");
    res.status(201).json(success(businessService.createBarClaimRequest(account, body)));
  });

  router.post("/venue-portal/:venueId/submissions", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(createSubmissionSchema, req.body, "Invalid venue update payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(businessService.createVenueManagerSubmission(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/profile", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(barProfileSchema, req.body, "Invalid bar profile payload");
    const venueId = String(req.params.venueId ?? "");
    res.json(success(businessService.upsertBarProfile(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/beers", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(barBeerSchema, req.body, "Invalid beer inventory payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(businessService.upsertBarBeer(account, venueId, body)));
  });

  router.delete("/venue-portal/:venueId/beers/:beerId", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    const beerId = String(req.params.beerId ?? "");
    res.json(success(businessService.deleteBarBeer(account, venueId, beerId)));
  });

  router.post("/venue-portal/:venueId/happy-hours", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(barHappyHourSchema, req.body, "Invalid happy-hour payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(businessService.upsertBarHappyHour(account, venueId, body)));
  });

  router.delete("/venue-portal/:venueId/happy-hours/:happyHourId", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    const happyHourId = String(req.params.happyHourId ?? "");
    res.json(success(businessService.deleteBarHappyHour(account, venueId, happyHourId)));
  });

  router.post("/venue-portal/:venueId/specials", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(barSpecialSchema, req.body, "Invalid deal or special payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(businessService.upsertBarSpecial(account, venueId, body)));
  });

  router.delete("/venue-portal/:venueId/specials/:specialId", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    const specialId = String(req.params.specialId ?? "");
    res.json(success(businessService.deleteBarSpecial(account, venueId, specialId)));
  });

  router.post("/venue-portal/:venueId/billing/checkout", billingLimiter, async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      const body = parseWithSchema(barTierCheckoutSchema, req.body, "Invalid bar tier checkout payload");
      const venueId = String(req.params.venueId ?? "");
      const result = await businessService.createBarTierCheckout(account, venueId, body);
      res.status(201).json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/kpis", (req, res) => {
    const admin = requireAdmin(req, businessService);
    const query = parseWithSchema(adminDashboardQuerySchema, req.query, "Invalid KPI dashboard query");
    res.json(success(businessService.getAdminKpis(admin, query)));
  });

  router.get("/admin/retention", (req, res) => {
    const admin = requireAdmin(req, businessService);
    const query = parseWithSchema(retentionQuerySchema, req.query, "Invalid retention query");
    res.json(success(businessService.getRetentionCohorts(admin, query)));
  });

  router.get("/admin/coverage", (req, res) => {
    const admin = requireAdmin(req, businessService);
    res.json(success(businessService.getCoverageDashboard(admin)));
  });

  router.get("/admin/partner-leads", (req, res) => {
    const admin = requireAdmin(req, businessService);
    res.json(success(businessService.getPotentialPartnerLeads(admin)));
  });

  router.get("/admin/queues", (req, res) => {
    const admin = requireAdmin(req, businessService);
    res.json(success(businessService.getAdminQueues(admin)));
  });

  router.get("/admin/venue-partners", (req, res) => {
    const admin = requireAdmin(req, businessService);
    res.json(success(businessService.getVenuePartnerAdmin(admin)));
  });

  router.post("/admin/venue-managers", (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(venueManagerAssignmentSchema, req.body, "Invalid venue manager assignment payload");
    res.status(201).json(success(businessService.assignVenueManager(admin, body)));
  });

  router.post("/admin/venue-managers/revoke", (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(venueManagerRevokeSchema, req.body, "Invalid venue manager revoke payload");
    res.json(success(businessService.revokeVenueManager(admin, body)));
  });

  router.post("/admin/venue-interest/:id/status", (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(venueInterestStatusSchema, req.body, "Invalid venue interest status payload");
    const interestId = String(req.params.id ?? "");
    res.json(success(businessService.updateVenueInterestStatus(admin, interestId, body)));
  });

  router.post("/admin/venue-outreach", (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(venueOutreachSchema, req.body, "Invalid venue outreach payload");
    res.json(success(businessService.upsertVenueOutreach(admin, body)));
  });

  router.post("/admin/requests/:id/mission", (req, res) => {
    const admin = requireAdmin(req, businessService);
    const requestId = String(req.params.id ?? "");
    res.status(201).json(success(businessService.createMissionFromRequest(admin, requestId)));
  });

  router.post("/billing/checkout", billingLimiter, async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      const body = parseWithSchema(checkoutSchema, req.body, "Invalid checkout payload");
      const result = await businessService.createCheckout(account, body);
      res.status(201).json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/billing/demo-subscribe", billingLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(checkoutSchema, req.body, "Invalid demo subscription payload");
    res.json(success(businessService.handleDemoSubscription(account, body.plan)));
  });

  router.post("/billing/webhook", (req, res) => {
    const raw = req.rawBody ? Buffer.from(req.rawBody) : Buffer.from(JSON.stringify(req.body ?? {}));
    const result = businessService.handleStripeWebhook(raw, req.header("stripe-signature") ?? undefined);
    res.json(success(result));
  });

  router.post("/admin/users/:id/status", (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(adminUserStatusSchema, req.body, "Invalid user status payload");
    res.json(success(businessService.adminOverrideUser(admin, req.params.id, body)));
  });

  router.post("/demo/seed", (req, res) => {
    requireAdmin(req, businessService);
    res.json(success(businessService.seedDemoMissions()));
  });

  return router;
}
