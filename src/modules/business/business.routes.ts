import { Router, type Request } from "express";

import { success } from "../../lib/http.js";
import { parseWithSchema } from "../../lib/validation.js";

import {
  adminUserStatusSchema,
  ageConfirmSchema,
  authLoginSchema,
  authSignupSchema,
  checkoutSchema,
  createMissionSchema,
  createSubmissionSchema,
  eventTrackSchema,
  missionsQuerySchema,
  reviewSubmissionSchema,
  submissionsQuerySchema,
} from "./business.schemas.js";
import type { BusinessService } from "./business.service.js";

function getAuthorization(req: Request): string | undefined {
  return req.header("authorization") ?? undefined;
}

function getOptionalAccount(req: Request, businessService: BusinessService) {
  return businessService.getAccountFromAuthorization(getAuthorization(req));
}

export function createBusinessRouter(businessService: BusinessService): Router {
  const router = Router();

  router.get("/config", (_req, res) => {
    res.json(success(businessService.getPublicConfig()));
  });

  router.post("/auth/signup", (req, res) => {
    const body = parseWithSchema(authSignupSchema, req.body, "Invalid signup payload");
    res.status(201).json(success(businessService.signup(body)));
  });

  router.post("/auth/login", (req, res) => {
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

  router.post("/submissions", (req, res) => {
    const account = businessService.requireAccount(getAuthorization(req));
    const body = parseWithSchema(createSubmissionSchema, req.body, "Invalid submission payload");
    const result = businessService.createSubmission(account, body);
    res.status(201).json(success(result));
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

  router.get("/price-records", (_req, res) => {
    res.json(success({ records: businessService.listPriceRecords() }));
  });

  router.post("/events", (req, res) => {
    const account = getOptionalAccount(req, businessService);
    const body = parseWithSchema(eventTrackSchema, req.body, "Invalid analytics event payload");
    businessService.trackEvent(account, body);
    res.status(201).json(success({ recorded: true }));
  });

  router.get("/analytics/preview", (req, res) => {
    const admin = businessService.requireAdmin(getAuthorization(req));
    res.json(success(businessService.getAnalyticsPreview(admin)));
  });

  router.post("/billing/checkout", async (req, res, next) => {
    try {
      const account = businessService.requireAccount(getAuthorization(req));
      const body = parseWithSchema(checkoutSchema, req.body, "Invalid checkout payload");
      const result = await businessService.createCheckout(account, body);
      res.status(201).json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/billing/demo-subscribe", (req, res) => {
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
