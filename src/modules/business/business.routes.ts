import { Router, type Request } from "express";

import { success } from "../../lib/http.js";
import { parseWithSchema } from "../../lib/validation.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";

import {
  accountPreferencesSchema,
  adminDashboardQuerySchema,
  adminUserStatusSchema,
  ageConfirmSchema,
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
  wrongPriceReportSchema,
} from "./business.schemas.js";
import type { BusinessService } from "./business.service.js";

function getAuthorization(req: Request): string | undefined {
  return req.header("authorization") ?? undefined;
}

function getOptionalAccount(req: Request, businessService: BusinessService) {
  return businessService.getAccountFromAuthorization(getAuthorization(req));
}

function rateLimitIdentity(req: Request): string {
  const authorization = getAuthorization(req) ?? "";
  const anonymousSessionId =
    typeof req.query.anonymousSessionId === "string"
      ? req.query.anonymousSessionId
      : typeof req.body?.anonymousSessionId === "string"
        ? req.body.anonymousSessionId
        : "";
  return [req.ip ?? req.socket.remoteAddress ?? "unknown-ip", authorization, anonymousSessionId].join(":");
}

const priceReadLimiter = createRateLimiter({
  keyPrefix: "business:price-records",
  windowMs: 60_000,
  max: 180,
  keyGenerator: rateLimitIdentity,
});

const writeLimiter = createRateLimiter({
  keyPrefix: "business:writes",
  windowMs: 10 * 60_000,
  max: 45,
  keyGenerator: rateLimitIdentity,
});

const authLimiter = createRateLimiter({
  keyPrefix: "business:auth",
  windowMs: 10 * 60_000,
  max: 25,
  keyGenerator: rateLimitIdentity,
});

const billingLimiter = createRateLimiter({
  keyPrefix: "business:billing",
  windowMs: 10 * 60_000,
  max: 20,
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
    res.status(201).json(success(businessService.signup(body)));
  });

  router.post("/auth/login", authLimiter, (req, res) => {
    const body = parseWithSchema(authLoginSchema, req.body, "Invalid login payload");
    res.json(success(businessService.login(body)));
  });

  router.get("/account", (req, res) => {
    const account = businessService.requireAccount(getAuthorization(req));
    res.json(success(businessService.getAccountDashboard(account)));
  });

  router.post("/account/age-confirm", (req, res) => {
    parseWithSchema(ageConfirmSchema, req.body, "Invalid age confirmation payload");
    const account = businessService.requireAccount(getAuthorization(req));
    res.json(success(businessService.confirmAge(account)));
  });

  router.post("/account/preferences", (req, res) => {
    const account = businessService.requireAccount(getAuthorization(req));
    const body = parseWithSchema(accountPreferencesSchema, req.body, "Invalid preferences payload");
    res.json(success(businessService.savePreferences(account, body)));
  });

  router.post("/account/saved-items", (req, res) => {
    const account = businessService.requireAccount(getAuthorization(req));
    const body = parseWithSchema(saveItemSchema, req.body, "Invalid saved item payload");
    res.status(201).json(success(businessService.saveItem(account, body)));
  });

  router.delete("/account/saved-items", (req, res) => {
    const account = businessService.requireAccount(getAuthorization(req));
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
    const account = businessService.requireAccount(getAuthorization(req));
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

  router.get("/submissions", (req, res) => {
    const account = getOptionalAccount(req, businessService);
    const query = parseWithSchema(submissionsQuerySchema, req.query, "Invalid submissions query");
    const submissions = businessService.listSubmissions(account, query);
    res.json(success({ submissions }));
  });

  router.post("/submissions/:id/review", (req, res) => {
    const admin = businessService.requireAdmin(getAuthorization(req));
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
    businessService.requireAdmin(getAuthorization(req));
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
    const admin = businessService.requireAdmin(getAuthorization(req));
    res.json(success(businessService.getAnalyticsPreview(admin)));
  });

  router.get("/admin/kpis", (req, res) => {
    const admin = businessService.requireAdmin(getAuthorization(req));
    const query = parseWithSchema(adminDashboardQuerySchema, req.query, "Invalid KPI dashboard query");
    res.json(success(businessService.getAdminKpis(admin, query)));
  });

  router.get("/admin/retention", (req, res) => {
    const admin = businessService.requireAdmin(getAuthorization(req));
    const query = parseWithSchema(retentionQuerySchema, req.query, "Invalid retention query");
    res.json(success(businessService.getRetentionCohorts(admin, query)));
  });

  router.get("/admin/coverage", (req, res) => {
    const admin = businessService.requireAdmin(getAuthorization(req));
    res.json(success(businessService.getCoverageDashboard(admin)));
  });

  router.get("/admin/partner-leads", (req, res) => {
    const admin = businessService.requireAdmin(getAuthorization(req));
    res.json(success(businessService.getPotentialPartnerLeads(admin)));
  });

  router.get("/admin/queues", (req, res) => {
    const admin = businessService.requireAdmin(getAuthorization(req));
    res.json(success(businessService.getAdminQueues(admin)));
  });

  router.post("/admin/requests/:id/mission", (req, res) => {
    const admin = businessService.requireAdmin(getAuthorization(req));
    res.status(201).json(success(businessService.createMissionFromRequest(admin, req.params.id)));
  });

  router.post("/billing/checkout", billingLimiter, async (req, res, next) => {
    try {
      const account = businessService.requireAccount(getAuthorization(req));
      const body = parseWithSchema(checkoutSchema, req.body, "Invalid checkout payload");
      const result = await businessService.createCheckout(account, body);
      res.status(201).json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/billing/demo-subscribe", billingLimiter, (req, res) => {
    const account = businessService.requireAccount(getAuthorization(req));
    const body = parseWithSchema(checkoutSchema, req.body, "Invalid demo subscription payload");
    res.json(success(businessService.handleDemoSubscription(account, body.plan)));
  });

  router.post("/billing/webhook", (req, res) => {
    const raw = req.rawBody ? Buffer.from(req.rawBody) : Buffer.from(JSON.stringify(req.body ?? {}));
    const result = businessService.handleStripeWebhook(raw, req.header("stripe-signature") ?? undefined);
    res.json(success(result));
  });

  router.post("/admin/users/:id/status", (req, res) => {
    const admin = businessService.requireAdmin(getAuthorization(req));
    const body = parseWithSchema(adminUserStatusSchema, req.body, "Invalid user status payload");
    res.json(success(businessService.adminOverrideUser(admin, req.params.id, body)));
  });

  router.post("/demo/seed", (req, res) => {
    businessService.requireAdmin(getAuthorization(req));
    res.json(success(businessService.seedDemoMissions()));
  });

  return router;
}
