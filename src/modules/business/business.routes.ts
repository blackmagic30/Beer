import crypto from "node:crypto";

import { Router, type Request } from "express";

import { success } from "../../lib/http.js";
import { parseWithSchema } from "../../lib/validation.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";

import {
  accountPreferencesSchema,
  accountDeletionRequestSchema,
  accountPrivacySettingsSchema,
  adminAccountSearchSchema,
  adminDashboardQuerySchema,
  adminUserStatusSchema,
  ageConfirmSchema,
  barBeerSchema,
  barHappyHourSchema,
  barProfileSchema,
  barSpecialSchema,
  barTierCheckoutSchema,
  authLoginSchema,
  authSupabaseSessionSchema,
  authSignupSchema,
  checkoutSchema,
  checkoutSessionSchema,
  createMissionSchema,
  createSubmissionSchema,
  displayNameUpdateSchema,
  discountRedemptionSchema,
  eventTrackSchema,
  feedbackSchema,
  freePintRewardCodeSchema,
  freePintRewardDecisionSchema,
  geocodeQuerySchema,
  leaderboardPrizeCampaignSchema,
  leaderboardPrizeFinalizeSchema,
  leaderboardQuerySchema,
  legalAcceptanceSchema,
  missionsQuerySchema,
  monthlyReportDeliverySchema,
  monthlyReportExportQuerySchema,
  monthlyReportGenerateSchema,
  pintPointDrinkRecordSchema,
  posDiscountRedemptionSchema,
  priceRecordsQuerySchema,
  pubGolfPlanSchema,
  removeSavedItemSchema,
  retentionQuerySchema,
  reviewSubmissionSchema,
  saveItemSchema,
  submissionsQuerySchema,
  venueRequestSchema,
  venueClaimRequestSchema,
  verificationSchema,
  venuePendingChangeReviewSchema,
  venueInterestSchema,
  venueInterestStatusSchema,
  venueManagerAssignmentSchema,
  venueManagerRevokeSchema,
  venueOutreachSchema,
  venuePortalQuerySchema,
  venuePlaceSearchQuerySchema,
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

const adminWriteLimiter = createRateLimiter({
  keyPrefix: "business:admin-writes",
  windowMs: 10 * 60_000,
  max: 30,
  keyGenerator: rateLimitIdentity,
});

const eventLimiter = createRateLimiter({
  keyPrefix: "business:events",
  windowMs: 10 * 60_000,
  max: 240,
  keyGenerator: rateLimitIdentity,
});

const lookupLimiter = createRateLimiter({
  keyPrefix: "business:lookups",
  windowMs: 10 * 60_000,
  max: 60,
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

  router.post("/auth/supabase-session", authLimiter, async (req, res, next) => {
    try {
      const body = parseWithSchema(authSupabaseSessionSchema, req.body, "Invalid Supabase auth payload");
      const result = await businessService.loginWithSupabaseAccessToken(body, getRequestContext(req));
      res.json(success(result));
    } catch (error) {
      next(error);
    }
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

  router.post("/account/display-name", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(displayNameUpdateSchema, req.body, "Invalid display name payload");
    res.json(success(businessService.updateDisplayName(account, body)));
  });

  router.post("/account/discount-pass", async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      res.json(success(await businessService.getDiscountPass(account, getAuthorization(req))));
    } catch (error) {
      next(error);
    }
  });

  router.post("/account/free-pint-reward-code", async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      const body = parseWithSchema(freePintRewardCodeSchema, req.body, "Invalid Free Pint Reward payload");
      res.json(success(await businessService.createFreePintRewardCode(account, body)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/account/age-confirm", (req, res) => {
    parseWithSchema(ageConfirmSchema, req.body, "Invalid age confirmation payload");
    const account = requireAccount(req, businessService);
    res.json(success(businessService.confirmAge(account)));
  });

  router.post("/account/legal-acceptance", (req, res) => {
    const body = parseWithSchema(legalAcceptanceSchema, req.body, "Invalid legal acceptance payload");
    const account = requireAccount(req, businessService);
    res.json(success(businessService.acceptLegal(account, body)));
  });

  router.post("/account/preferences", (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(accountPreferencesSchema, req.body, "Invalid preferences payload");
    res.json(success(businessService.savePreferences(account, body)));
  });

  router.post("/account/privacy-settings", (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(accountPrivacySettingsSchema, req.body, "Invalid privacy settings payload");
    res.json(success(businessService.savePrivacySettings(account, body)));
  });

  router.get("/account/export", (req, res) => {
    const account = requireAccount(req, businessService);
    res.json(success(businessService.exportAccountData(account)));
  });

  router.post("/account/delete-request", (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(accountDeletionRequestSchema, req.body, "Invalid deletion request payload");
    res.json(success(businessService.requestAccountDeletion(account, body)));
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

  router.post("/submissions", writeLimiter, async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      const body = parseWithSchema(createSubmissionSchema, req.body, "Invalid submission payload");
      const result = await businessService.createUserSubmission(account, body);
      res.status(result.idempotentReplay ? 200 : 201).json(success(result));
    } catch (error) {
      next(error);
    }
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

  router.get("/submissions/:id/source-evidence-url", (req, res) => {
    const account = requireAccount(req, businessService);
    res.json(success(businessService.getSubmissionSourceEvidenceUrl(account, String(req.params.id ?? ""))));
  });

  router.get("/source-evidence/:id", (req, res) => {
    const evidence = businessService.getSourceEvidenceForSignedRequest({
      evidenceId: String(req.params.id ?? ""),
      expires: typeof req.query.expires === "string" ? req.query.expires : undefined,
      signature: typeof req.query.signature === "string" ? req.query.signature : undefined,
    });

    const delivery = businessService.getSourceEvidenceDelivery(evidence);
    if (!delivery) {
      res.sendStatus(404);
      return;
    }

    res.setHeader("Cache-Control", "private, no-store");
    if (delivery.kind === "redirect") {
      res.redirect(delivery.url);
      return;
    }

    res.type(delivery.mimeType).send(delivery.bytes);
  });

  router.post("/submissions/:id/review", (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(reviewSubmissionSchema, req.body, "Invalid review payload");
    const result = businessService.reviewSubmission(admin, req.params.id, body);
    res.json(success(result));
  });

  router.post("/submissions/:id/verifications", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(verificationSchema, req.body, "Invalid verification payload");
    const submissionId = String(req.params.id ?? "");
    const result = businessService.verifySubmission(account, submissionId, body);
    res.status(201).json(success(result));
  });

  router.get("/missions", (req, res) => {
    const query = parseWithSchema(missionsQuerySchema, req.query, "Invalid missions query");
    const missions = businessService.listMissions(query);
    res.json(success({ missions }));
  });

  router.get("/geocode", lookupLimiter, async (req, res, next) => {
    try {
      const query = parseWithSchema(geocodeQuerySchema, req.query, "Invalid geocode query");
      const result = await businessService.resolveMissionArea(query.q);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.get("/venue-places/search", lookupLimiter, async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      const query = parseWithSchema(venuePlaceSearchQuerySchema, req.query, "Invalid venue lookup query");
      const result = await businessService.searchVenuePlacesForSubmission(account, query.q);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.get("/venue-places/:placeId", lookupLimiter, async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      const placeId = String(req.params.placeId ?? "");
      const result = await businessService.getVenuePlaceForSubmission(account, placeId);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
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

  router.get("/leaderboard", (req, res) => {
    const account = getOptionalAccount(req, businessService);
    const query = parseWithSchema(leaderboardQuerySchema, req.query, "Invalid leaderboard query");
    res.json(success(businessService.getLeaderboard(account, query)));
  });

  router.post("/beta/pub-golf/plan", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(pubGolfPlanSchema, req.body, "Invalid Pub Golf planner payload");
    res.json(success(businessService.planPubGolf(account, body)));
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

  router.get("/venue-portal/:venueId/reports/:month/export", (req, res) => {
    const account = requireAccount(req, businessService);
    const query = parseWithSchema(monthlyReportExportQuerySchema, req.query, "Invalid monthly report export query");
    const venueId = String(req.params.venueId ?? "");
    const month = String(req.params.month ?? "");
    const result = businessService.exportVenueMonthlyReport(account, venueId, month, query);
    res
      .type(result.mimeType)
      .setHeader("Cache-Control", "private, no-store")
      .setHeader("Content-Disposition", `attachment; filename="${result.filename}"`)
      .send(result.body);
  });

  router.post("/pos/discount-redemptions", writeLimiter, (req, res) => {
    const body = parseWithSchema(posDiscountRedemptionSchema, req.body, "Invalid POS discount redemption payload");
    const bearerToken = getAuthorization(req)?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    const token = req.header("x-pint-path-pos-token") ?? bearerToken;
    res.status(201).json(success(businessService.redeemDiscountPassFromPos(body, token, getRequestContext(req))));
  });

  router.post("/venue-claim-requests", writeLimiter, (req, res) => {
    const account = requireAdmin(req, businessService);
    const body = parseWithSchema(venueClaimRequestSchema, req.body, "Invalid venue claim request payload");
    res.status(201).json(success(businessService.createVenueClaimRequest(account, body)));
  });

  router.post("/venue-portal/:venueId/submissions", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(createSubmissionSchema, req.body, "Invalid venue update payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(businessService.createVenueManagerSubmission(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/profile", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(barProfileSchema, req.body, "Invalid venue profile payload");
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

  router.post("/venue-portal/:venueId/discount-redemptions", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(discountRedemptionSchema, req.body, "Invalid discount redemption payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(businessService.redeemDiscountPass(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/pint-point-drinks", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(pintPointDrinkRecordSchema, req.body, "Invalid Pint Points drink payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(businessService.recordPintPointDrink(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/free-pint-rewards", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(freePintRewardDecisionSchema, req.body, "Invalid Free Pint Reward payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(businessService.handleFreePintRewardCode(account, venueId, body)));
  });

  router.get("/venue-portal/:venueId/pos-integration", (req, res) => {
    const account = requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    res.json(success(businessService.getVenuePosIntegration(account, venueId)));
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
      const body = parseWithSchema(barTierCheckoutSchema, req.body, "Invalid venue tier checkout payload");
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

  router.post("/admin/reports/monthly/generate", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(monthlyReportGenerateSchema, req.body, "Invalid monthly report generation payload");
    res.json(success(businessService.generateVenueMonthlyReports(admin, body)));
  });

  router.post("/admin/reports/monthly/deliver", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(monthlyReportDeliverySchema, req.body, "Invalid monthly report delivery payload");
    res.json(success(businessService.deliverVenueMonthlyReports(admin, body)));
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

  router.get("/admin/leaderboard-prizes", (req, res) => {
    const admin = requireAdmin(req, businessService);
    res.json(success(businessService.getLeaderboardPrizeAdmin(admin)));
  });

  router.post("/admin/leaderboard-prizes", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(leaderboardPrizeCampaignSchema, req.body, "Invalid leaderboard prize payload");
    res.json(success(businessService.saveLeaderboardPrizeCampaign(admin, body)));
  });

  router.post("/admin/leaderboard-prizes/finalize", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(leaderboardPrizeFinalizeSchema, req.body, "Invalid leaderboard finalization payload");
    res.json(success(businessService.finalizeLeaderboardPrizeCampaign(admin, body)));
  });

  router.get("/admin/accounts", (req, res) => {
    const admin = requireAdmin(req, businessService);
    const query = parseWithSchema(adminAccountSearchSchema, req.query, "Invalid admin account search query");
    res.json(success(businessService.searchAccountsForAdmin(admin, query)));
  });

  router.post("/admin/venue-pending-changes/:id/review", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(venuePendingChangeReviewSchema, req.body, "Invalid pending venue change review payload");
    const changeId = String(req.params.id ?? "");
    res.json(success(businessService.reviewVenuePendingChange(admin, changeId, body)));
  });

  router.post("/admin/venue-managers", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(venueManagerAssignmentSchema, req.body, "Invalid venue manager assignment payload");
    res.status(201).json(success(businessService.assignVenueManager(admin, body)));
  });

  router.post("/admin/venue-managers/revoke", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(venueManagerRevokeSchema, req.body, "Invalid venue manager revoke payload");
    res.json(success(businessService.revokeVenueManager(admin, body)));
  });

  router.post("/admin/venue-interest/:id/status", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(venueInterestStatusSchema, req.body, "Invalid venue interest status payload");
    const interestId = String(req.params.id ?? "");
    res.json(success(businessService.updateVenueInterestStatus(admin, interestId, body)));
  });

  router.post("/admin/venue-outreach", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(venueOutreachSchema, req.body, "Invalid venue outreach payload");
    res.json(success(businessService.upsertVenueOutreach(admin, body)));
  });

  router.post("/admin/requests/:id/mission", adminWriteLimiter, (req, res) => {
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

  router.post("/billing/checkout/reconcile", billingLimiter, async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      const body = parseWithSchema(checkoutSessionSchema, req.body, "Invalid checkout confirmation payload");
      const result = await businessService.reconcileCheckoutSession(account, body);
      res.json(success(result));
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

  router.post("/admin/users/:id/status", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(adminUserStatusSchema, req.body, "Invalid user status payload");
    res.json(success(businessService.adminOverrideUser(admin, String(req.params.id ?? ""), body)));
  });

  router.post("/demo/seed", adminWriteLimiter, (req, res) => {
    requireAdmin(req, businessService);
    res.json(success(businessService.seedDemoMissions()));
  });

  return router;
}
