import { Router, type Request, type Response } from "express";

import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { success } from "../../lib/http.js";
import { getClientIp, getRateLimitIdentity } from "../../lib/client-ip.js";
import { getSessionAuthorization, SESSION_COOKIE_NAME } from "../../lib/session-cookie.js";
import { parseWithSchema } from "../../lib/validation.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";

import {
  accountPreferencesSchema,
  adminReasonSchema,
  accountDeletionRequestSchema,
  accountPrivacySettingsSchema,
  adminAccountSearchSchema,
  adminDashboardQuerySchema,
  adminPaginationSchema,
  adminMissionUpdateSchema,
  adminUserStatusSchema,
  ageConfirmSchema,
  barBeerSchema,
  barBeerBulkSchema,
  barHappyHourSchema,
  barProfileSchema,
  barSpecialSchema,
  barTierCheckoutSchema,
  authLoginSchema,
  billingRecoveryPortalSchema,
  authSupabaseSessionSchema,
  authSignupSchema,
  beerCatalogApproveSchema,
  beerCatalogAdminQuerySchema,
  beerCatalogBulkRejectSchema,
  beerCatalogMergeSchema,
  beerCatalogRejectSchema,
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
  rewardVoucherTransitionSchema,
  leaderboardQuerySchema,
  legalAcceptanceSchema,
  missionsQuerySchema,
  monthlyReportDeliverySchema,
  monthlyReportExportQuerySchema,
  monthlyReportGenerateSchema,
  monthlyReportParamsSchema,
  logoutAllSchema,
  passwordResetCompleteSchema,
  pintPointMemberPreviewSchema,
  pintPointDrinkRecordSchema,
  pintPointDrinkVoidSchema,
  posDiscountRedemptionSchema,
  priceRecordsQuerySchema,
  pubGolfPlanSchema,
  removeSavedItemSchema,
  retentionQuerySchema,
  reviewSubmissionSchema,
  saveItemSchema,
  submissionsQuerySchema,
  trustWorkflowUpdateSchema,
  venueRequestSchema,
  venueClaimRequestSchema,
  venueClaimReviewSchema,
  verificationSchema,
  verificationCandidatesQuerySchema,
  venuePendingChangeReviewSchema,
  venueInterestSchema,
  venueInterestStatusSchema,
  venueManagerAssignmentSchema,
  venueManagerRevokeSchema,
  venueCounterStaffAssignmentSchema,
  venueCounterStaffInvitationResponseSchema,
  venueOutreachSchema,
  venuePortalQuerySchema,
  venueReportDeliverySettingsSchema,
  venueReconciliationQuerySchema,
  venuePlaceSearchQuerySchema,
  venuesQuerySchema,
  wrongPriceReportSchema,
  versionedVenueDeleteSchema,
} from "./business.schemas.js";
import type { BusinessService } from "./business.service.js";

function getAuthorization(req: Request): string | undefined {
  return getSessionAuthorization(req);
}

function setSessionCookie(res: Response, token: string, expiresAt: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

function getOptionalAccount(req: Request, businessService: BusinessService) {
  return businessService.getAccountFromAuthorization(getAuthorization(req), getRequestContext(req));
}

function getRequestContext(req: Request) {
  return {
    ip: getClientIp(req),
    userAgent: req.get("user-agent") ?? null,
  };
}

function getReauthenticationProof(req: Request) {
  return {
    accessToken: req.get("x-pint-path-reauth-token"),
    password: req.get("x-pint-path-current-password"),
  };
}

function requireAccount(req: Request, businessService: BusinessService) {
  return businessService.requireAccount(getAuthorization(req), getRequestContext(req));
}

function requireAdmin(req: Request, businessService: BusinessService) {
  return businessService.requireAdmin(getAuthorization(req), getRequestContext(req));
}

function rateLimitIdentity(req: Request): string | null {
  return getRateLimitIdentity(req);
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

const adminReviewLimiter = createRateLimiter({
  keyPrefix: "business:admin-review-writes",
  windowMs: 10 * 60_000,
  max: 180,
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

const venueCounterLimiter = createRateLimiter({
  keyPrefix: "business:venue-counter",
  windowMs: 10 * 60_000,
  max: 240,
  keyGenerator: rateLimitIdentity,
});

const sourceEvidenceLimiter = createRateLimiter({
  keyPrefix: "business:source-evidence",
  windowMs: 60_000,
  max: 120,
  keyGenerator: rateLimitIdentity,
});

const posVenueLimiter = createRateLimiter({
  keyPrefix: "business:pos-venue",
  windowMs: 10 * 60_000,
  max: 600,
  keyGenerator: (req) => {
    const venueId = typeof req.body?.venueId === "string" ? req.body.venueId.trim() : "unknown-venue";
    const bearerToken = getSessionAuthorization(req)?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    const token = req.header("x-pint-path-pos-token") ?? bearerToken;
    return `${venueId}:${token || "missing-token"}`;
  },
});

const posIpGuardLimiter = createRateLimiter({
  keyPrefix: "business:pos-ip-guard",
  windowMs: 10 * 60_000,
  max: 1_200,
  keyGenerator: rateLimitIdentity,
});

const accountExportLimiter = createRateLimiter({
  keyPrefix: "business:account-export",
  windowMs: 60 * 60_000,
  max: 2,
  keyGenerator: rateLimitIdentity,
});

export function createBusinessRouter(businessService: BusinessService): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  router.get("/config", (_req, res) => {
    res.setHeader(
      "Cache-Control",
      env.RESTORE_REHEARSAL_MODE ? "private, no-store" : "public, max-age=300, stale-while-revalidate=600",
    );
    res.json(success(businessService.getPublicConfig()));
  });

  router.post("/auth/signup", authLimiter, async (req, res, next) => {
    try {
      const body = parseWithSchema(authSignupSchema, req.body, "Invalid signup payload");
      const result = await businessService.signup(body, getRequestContext(req));
      setSessionCookie(res, result.token, result.expiresAt);
      res.status(201).json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/login", authLimiter, async (req, res, next) => {
    try {
      const body = parseWithSchema(authLoginSchema, req.body, "Invalid login payload");
      const result = await businessService.login(body, getRequestContext(req));
      setSessionCookie(res, result.token, result.expiresAt);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/supabase-session", authLimiter, async (req, res, next) => {
    try {
      const body = parseWithSchema(authSupabaseSessionSchema, req.body, "Invalid Supabase auth payload");
      const result = await businessService.loginWithSupabaseAccessToken(body, getRequestContext(req), getAuthorization(req));
      setSessionCookie(res, result.token, result.expiresAt);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/password-reset-complete", authLimiter, async (req, res, next) => {
    try {
      const body = parseWithSchema(passwordResetCompleteSchema, req.body, "Invalid password reset completion payload");
      const result = await businessService.completePasswordReset(body, getRequestContext(req));
      clearSessionCookie(res);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/session-cookie", authLimiter, (req, res) => {
    const authorization = getAuthorization(req);
    requireAccount(req, businessService);
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    const expiresAt = businessService.getSessionExpiresAt(authorization);
    if (!token || !expiresAt) {
      res.status(401).json({ ok: false, error: { message: "Login required." } });
      return;
    }
    setSessionCookie(res, token, expiresAt);
    res.json(success({ migrated: true, expiresAt }));
  });

  router.get("/auth/session", (req, res) => {
    const account = getOptionalAccount(req, businessService);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(success(businessService.getAuthSession(account)));
  });

  router.post("/auth/logout", authLimiter, (req, res) => {
    const result = businessService.logout(getAuthorization(req), getRequestContext(req));
    clearSessionCookie(res);
    res.json(success(result));
  });

  router.post("/auth/logout-all", authLimiter, async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      await businessService.requireRecentAuthentication(account, getAuthorization(req), getReauthenticationProof(req));
      const body = parseWithSchema(logoutAllSchema, req.body ?? {}, "Invalid logout-all payload");
      const result = await businessService.logoutAll(account, body, getRequestContext(req));
      clearSessionCookie(res);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.get("/account/sessions", async (req, res) => {
    const account = requireAccount(req, businessService);
    await businessService.requireRecentAuthentication(account, getAuthorization(req), getReauthenticationProof(req));
    const query = parseWithSchema(adminPaginationSchema, req.query, "Invalid session pagination");
    res.json(success(businessService.listAccountSessions(account, getAuthorization(req), query)));
  });

  router.delete("/account/sessions/:sessionId", writeLimiter, async (req, res) => {
    const account = requireAccount(req, businessService);
    await businessService.requireRecentAuthentication(account, getAuthorization(req), getReauthenticationProof(req));
    res.json(success(businessService.revokeAccountSession(
      account,
      account.id,
      String(req.params.sessionId ?? ""),
      getRequestContext(req),
    )));
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

  router.post("/account/discount-pass", writeLimiter, async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      res.json(success(await businessService.getDiscountPass(account, getAuthorization(req))));
    } catch (error) {
      next(error);
    }
  });

  router.post("/account/free-pint-reward-code", writeLimiter, async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      const body = parseWithSchema(freePintRewardCodeSchema, req.body, "Invalid Free Pint Reward payload");
      res.json(success(await businessService.createFreePintRewardCode(account, body)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/account/counter-staff-invitations/:assignmentId/respond", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(
      venueCounterStaffInvitationResponseSchema,
      req.body,
      "Invalid counter-staff invitation response",
    );
    const assignmentId = String(req.params.assignmentId ?? "");
    res.json(success(businessService.respondToVenueCounterStaffInvitation(account, assignmentId, body)));
  });

  router.post("/account/age-confirm", writeLimiter, (req, res) => {
    parseWithSchema(ageConfirmSchema, req.body, "Invalid age confirmation payload");
    const account = requireAccount(req, businessService);
    res.json(success(businessService.confirmAge(account)));
  });

  router.post("/account/legal-acceptance", writeLimiter, (req, res) => {
    const body = parseWithSchema(legalAcceptanceSchema, req.body, "Invalid legal acceptance payload");
    const account = requireAccount(req, businessService);
    res.json(success(businessService.acceptLegal(account, body)));
  });

  router.post("/account/preferences", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(accountPreferencesSchema, req.body, "Invalid preferences payload");
    res.json(success(businessService.savePreferences(account, body)));
  });

  router.post("/account/privacy-settings", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(accountPrivacySettingsSchema, req.body, "Invalid privacy settings payload");
    res.json(success(businessService.savePrivacySettings(account, body)));
  });

  router.get("/account/export", accountExportLimiter, async (req, res) => {
    const account = requireAccount(req, businessService);
    await businessService.requireRecentAuthentication(account, getAuthorization(req), getReauthenticationProof(req));
    const encoded = JSON.stringify(success(businessService.exportAccountData(account)));
    if (Buffer.byteLength(encoded) > 25 * 1024 * 1024) {
      throw new AppError("Account export is too large for self-service delivery. Contact privacy support for a secure export.", 413);
    }
    res.type("application/json").send(encoded);
  });

  router.post("/account/delete-request", writeLimiter, async (req, res) => {
    const account = requireAccount(req, businessService);
    await businessService.requireRecentAuthentication(account, getAuthorization(req), getReauthenticationProof(req));
    const body = parseWithSchema(accountDeletionRequestSchema, req.body, "Invalid deletion request payload");
    res.json(success(businessService.requestAccountDeletion(account, body)));
  });

  router.get("/account/delete-request", (req, res) => {
    const account = requireAccount(req, businessService);
    res.json(success(businessService.getAccountDeletionStatus(account)));
  });

  router.delete("/account/delete-request/:id", writeLimiter, async (req, res) => {
    const account = requireAccount(req, businessService);
    await businessService.requireRecentAuthentication(account, getAuthorization(req), getReauthenticationProof(req));
    res.json(success(businessService.cancelAccountDeletion(account, String(req.params.id ?? ""))));
  });

  router.get("/admin/account-deletions", adminReviewLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const query = parseWithSchema(adminPaginationSchema, req.query, "Invalid account deletion pagination");
    res.json(success(businessService.listAccountDeletionRequests(admin, query)));
  });

  router.get("/admin/accounts/:userId/sessions", adminReviewLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const query = parseWithSchema(adminPaginationSchema, req.query, "Invalid session pagination");
    res.json(success(businessService.listAdminAccountSessions(admin, String(req.params.userId ?? ""), query)));
  });

  router.delete("/admin/accounts/:userId/sessions/:sessionId", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(adminReasonSchema, req.body, "A reason is required to revoke another account's session");
    res.json(success(businessService.revokeAccountSession(
      admin,
      String(req.params.userId ?? ""),
      String(req.params.sessionId ?? ""),
      getRequestContext(req),
      body.reason,
    )));
  });

  router.get("/admin/security-audit", adminReviewLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
    const offset = typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
    const action = typeof req.query.action === "string" ? req.query.action.trim().slice(0, 120) : null;
    const actorUserId = typeof req.query.actorUserId === "string" ? req.query.actorUserId.trim().slice(0, 180) : null;
    res.json(success(businessService.getAdminSecurityAuditLogs(admin, {
      limit: Number.isFinite(limit) ? limit : 100,
      offset: Number.isFinite(offset) ? offset : 0,
      action: action || null,
      actorUserId: actorUserId || null,
    })));
  });

  router.post("/admin/account-deletions/:id/execute", adminReviewLimiter, async (req, res, next) => {
    try {
      const admin = requireAdmin(req, businessService);
      const body = parseWithSchema(adminReasonSchema, req.body, "A reason is required to execute account deletion");
      res.json(success(await businessService.executeAccountDeletion(admin, String(req.params.id ?? ""), body.reason)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/account/saved-items", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(saveItemSchema, req.body, "Invalid saved item payload");
    res.status(201).json(success(businessService.saveItem(account, body)));
  });

  router.delete("/account/saved-items", writeLimiter, (req, res) => {
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
      const query = parseWithSchema(venuesQuerySchema, req.query, "Invalid venue query");
      const result = await businessService.listVenuesPage(query.q, query.limit, query.offset);
      res.setHeader(
        "Cache-Control",
        env.RESTORE_REHEARSAL_MODE ? "private, no-store" : "public, max-age=30, stale-while-revalidate=120",
      );
      res.json(success(result));
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

  router.post("/wrong-price-reports", writeLimiter, async (req, res, next) => {
    try {
      const account = getOptionalAccount(req, businessService);
      const body = parseWithSchema(wrongPriceReportSchema, req.body, "Invalid wrong price report payload");
      res.status(201).json(success(await businessService.reportWrongPrice(account, body)));
    } catch (error) {
      next(error);
    }
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
    res.json(success(businessService.getSubmissionsPage(account, query)));
  });

  router.get("/verification-candidates", lookupLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const query = parseWithSchema(
      verificationCandidatesQuerySchema,
      req.query,
      "Invalid verification candidate query",
    );
    res.json(success(businessService.getCommunityVerificationCandidates(account, query)));
  });

  router.get("/submissions/:id/source-evidence-url", sourceEvidenceLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    res.json(success(businessService.getSubmissionSourceEvidenceUrl(account, String(req.params.id ?? ""))));
  });

  router.get("/source-evidence/:id", sourceEvidenceLimiter, async (req, res, next) => {
    try {
    const evidence = businessService.getSourceEvidenceForSignedRequest({
      evidenceId: String(req.params.id ?? ""),
      expires: typeof req.query.expires === "string" ? req.query.expires : undefined,
      signature: typeof req.query.signature === "string" ? req.query.signature : undefined,
    });

    const delivery = await businessService.getSourceEvidenceDelivery(evidence);
    if (!delivery) {
      res.sendStatus(404);
      return;
    }

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (delivery.mimeType === "application/pdf") {
      const safeId = String(req.params.id ?? "evidence").replace(/[^a-z0-9_-]/gi, "").slice(0, 80) || "evidence";
      res.setHeader("Content-Disposition", `attachment; filename="${safeId}.pdf"`);
    }
    res.type(delivery.mimeType).send(delivery.bytes);
    } catch (error) {
      next(error);
    }
  });

  router.post("/submissions/:id/review", adminReviewLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(reviewSubmissionSchema, req.body, "Invalid review payload");
    const result = businessService.reviewSubmission(admin, String(req.params.id ?? ""), body);
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
    const account = getOptionalAccount(req, businessService);
    const query = parseWithSchema(missionsQuerySchema, req.query, "Invalid missions query");
    res.json(success(businessService.getMissionsPage(query, account)));
  });

  router.post("/missions/:id/accept", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    res.json(success(businessService.acceptMission(account, String(req.params.id ?? ""))));
  });

  router.delete("/missions/:id/accept", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    res.json(success(businessService.releaseMission(account, String(req.params.id ?? ""))));
  });

  router.post("/missions/:id/release", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    res.json(success(businessService.releaseMission(account, String(req.params.id ?? ""))));
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

  router.post("/missions", adminWriteLimiter, (req, res) => {
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
      clientIp: getClientIp(req) ?? undefined,
    })));
  });

  router.get("/leaderboard", (req, res) => {
    const account = getOptionalAccount(req, businessService);
    const query = parseWithSchema(leaderboardQuerySchema, req.query, "Invalid leaderboard query");
    res.json(success(businessService.getLeaderboard(account, query)));
  });

  router.post("/beta/pub-golf/plan", writeLimiter, async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      const body = parseWithSchema(pubGolfPlanSchema, req.body, "Invalid Pub Golf planner payload");
      res.json(success(await businessService.planPubGolf(account, body)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/events", eventLimiter, (req, res) => {
    const account = getOptionalAccount(req, businessService);
    const body = parseWithSchema(eventTrackSchema, req.body, "Invalid analytics event payload");
    businessService.trackClientEvent(account, body, getRequestContext(req));
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

  router.get("/venue-portal/:venueId/reports/:month", (req, res) => {
    const account = requireAccount(req, businessService);
    const params = parseWithSchema(monthlyReportParamsSchema, req.params, "Invalid monthly report request");
    const report = businessService.getVenueMonthlyReport(account, params.venueId, params.month);
    res
      .setHeader("Cache-Control", "private, no-store")
      .json(success({ report }));
  });

  router.get("/venue-portal/:venueId/report-delivery", (req, res) => {
    const account = requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    res
      .setHeader("Cache-Control", "private, no-store")
      .json(success(businessService.getVenueReportDeliverySettings(account, venueId)));
  });

  router.get("/venue-portal/:venueId/reconciliation", (req, res) => {
    const account = requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    const query = parseWithSchema(
      venueReconciliationQuerySchema,
      req.query,
      "Invalid reconciliation pagination",
    );
    res
      .setHeader("Cache-Control", "private, no-store")
      .json(success(businessService.getVenueReconciliation(account, venueId, query)));
  });

  router.put("/venue-portal/:venueId/report-delivery", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    const body = parseWithSchema(
      venueReportDeliverySettingsSchema,
      req.body,
      "Invalid monthly report delivery settings",
    );
    res.json(success(businessService.updateVenueReportDeliverySettings(account, venueId, body)));
  });

  router.post("/pos/discount-redemptions", posIpGuardLimiter, posVenueLimiter, (req, res) => {
    const body = parseWithSchema(posDiscountRedemptionSchema, req.body, "Invalid POS discount redemption payload");
    const bearerToken = getAuthorization(req)?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    const token = req.header("x-pint-path-pos-token") ?? bearerToken;
    res.status(201).json(success(businessService.redeemDiscountPassFromPos(body, token, getRequestContext(req))));
  });

  router.post("/venue-claim-requests", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(venueClaimRequestSchema, req.body, "Invalid venue claim request payload");
    const result = businessService.createVenueClaimRequest(account, body);
    res.status(result.duplicate ? 200 : 201).json(success(result));
  });

  router.post("/venue-portal/:venueId/submissions", writeLimiter, async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      const body = parseWithSchema(createSubmissionSchema, req.body, "Invalid venue update payload");
      const venueId = String(req.params.venueId ?? "");
      res.status(201).json(success(await businessService.createVenueManagerSubmission(account, venueId, body)));
    } catch (error) {
      next(error);
    }
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

  router.post("/venue-portal/:venueId/beers/bulk", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(barBeerBulkSchema, req.body, "Invalid bulk beer inventory payload");
    const venueId = String(req.params.venueId ?? "");
    res.json(success(businessService.bulkUpsertBarBeers(account, venueId, body)));
  });

  router.delete("/venue-portal/:venueId/beers/:beerId", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    const beerId = String(req.params.beerId ?? "");
    const body = parseWithSchema(versionedVenueDeleteSchema, req.body, "A current beer-row version is required");
    res.json(success(businessService.deleteBarBeer(account, venueId, beerId, body.expectedUpdatedAt)));
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
    const body = parseWithSchema(versionedVenueDeleteSchema, req.body, "A current happy-hour version is required");
    res.json(success(businessService.deleteBarHappyHour(account, venueId, happyHourId, body.expectedUpdatedAt)));
  });

  router.post("/venue-portal/:venueId/specials", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(barSpecialSchema, req.body, "Invalid deal or special payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(businessService.upsertBarSpecial(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/member-preview", venueCounterLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(pintPointMemberPreviewSchema, req.body, "Invalid Pint Path member code");
    const venueId = String(req.params.venueId ?? "");
    res.json(success(businessService.previewPintPointMember(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/discount-redemptions", venueCounterLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(discountRedemptionSchema, req.body, "Invalid discount redemption payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(businessService.redeemDiscountPass(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/pint-point-drinks", venueCounterLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(pintPointDrinkRecordSchema, req.body, "Invalid Pint Points drink payload");
    const venueId = String(req.params.venueId ?? "");
    const result = businessService.recordPintPointDrink(account, venueId, body);
    res.status(result.idempotentReplay ? 200 : 201).json(success(result));
  });

  router.post("/venue-portal/:venueId/pint-point-drinks/:recordId/void", venueCounterLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(pintPointDrinkVoidSchema, req.body, "Invalid Pint Points correction payload");
    const venueId = String(req.params.venueId ?? "");
    const recordId = String(req.params.recordId ?? "");
    res.json(success(businessService.voidPintPointDrink(account, venueId, recordId, body)));
  });

  router.post("/venue-portal/:venueId/counter-staff", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(venueCounterStaffAssignmentSchema, req.body, "Invalid counter-staff assignment payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(businessService.assignVenueCounterStaff(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/counter-staff/revoke", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(venueCounterStaffAssignmentSchema, req.body, "Invalid counter-staff revoke payload");
    const venueId = String(req.params.venueId ?? "");
    res.json(success(businessService.revokeVenueCounterStaff(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/free-pint-rewards", venueCounterLimiter, (req, res) => {
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

  router.post("/venue-portal/:venueId/pos-integration/rotate", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    res.json(success(businessService.rotateVenuePosIntegrationToken(account, venueId)));
  });

  router.delete("/venue-portal/:venueId/specials/:specialId", writeLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    const specialId = String(req.params.specialId ?? "");
    const body = parseWithSchema(versionedVenueDeleteSchema, req.body, "A current special version is required");
    res.json(success(businessService.deleteBarSpecial(account, venueId, specialId, body.expectedUpdatedAt)));
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

  router.post("/venue-portal/:venueId/billing/portal", billingLimiter, async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      const venueId = String(req.params.venueId ?? "");
      res.status(201).json(success(await businessService.createBarBillingPortal(account, venueId)));
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

  router.post("/admin/reports/monthly/deliver", adminWriteLimiter, async (req, res, next) => {
    try {
      const admin = requireAdmin(req, businessService);
      const body = parseWithSchema(monthlyReportDeliverySchema, req.body, "Invalid monthly report delivery payload");
      res.json(success(await businessService.deliverVenueMonthlyReports(admin, body)));
    } catch (error) {
      next(error);
    }
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
    const query = parseWithSchema(adminPaginationSchema, req.query, "Invalid admin queue pagination");
    res.json(success(businessService.getAdminQueues(admin, query)));
  });

  router.get("/admin/operational-health", (req, res) => {
    const admin = requireAdmin(req, businessService);
    res.json(success(businessService.getOperationalHealth(admin)));
  });

  router.get("/admin/beer-catalog", (req, res) => {
    const admin = requireAdmin(req, businessService);
    const query = parseWithSchema(beerCatalogAdminQuerySchema, req.query, "Invalid beer catalogue pagination");
    res.json(success(businessService.getAdminBeerCatalog(admin, query)));
  });

  router.post("/admin/beer-catalog/reject-pending", adminReviewLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(beerCatalogBulkRejectSchema, req.body, "Invalid beer catalogue bulk rejection payload");
    res.json(success(businessService.rejectBeerCatalogItems(admin, body)));
  });

  router.post("/admin/beer-catalog/:key/approve", adminReviewLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(beerCatalogApproveSchema, req.body, "Invalid beer catalogue approval payload");
    const key = String(req.params.key ?? "");
    res.json(success(businessService.approveBeerCatalogItem(admin, key, body)));
  });

  router.post("/admin/beer-catalog/:key/merge", adminReviewLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(beerCatalogMergeSchema, req.body, "Invalid beer catalogue merge payload");
    const key = String(req.params.key ?? "");
    res.json(success(businessService.mergeBeerCatalogItem(admin, key, body)));
  });

  router.post("/admin/beer-catalog/:key/reject", adminReviewLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(beerCatalogRejectSchema, req.body, "Invalid beer catalogue rejection payload");
    const key = String(req.params.key ?? "");
    res.json(success(businessService.rejectBeerCatalogItem(admin, key, body)));
  });

  router.get("/admin/venue-partners", (req, res) => {
    const admin = requireAdmin(req, businessService);
    const query = parseWithSchema(adminPaginationSchema, req.query, "Invalid venue partner pagination");
    res.json(success(businessService.getVenuePartnerAdmin(admin, query)));
  });

  router.post("/admin/venue-claims/:id/review", adminReviewLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(venueClaimReviewSchema, req.body, "Invalid venue claim review payload");
    const claimId = String(req.params.id ?? "");
    res.json(success(businessService.reviewVenueClaimRequest(admin, claimId, body)));
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

  router.post("/admin/reward-vouchers/:id/transition", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(rewardVoucherTransitionSchema, req.body, "Invalid reward voucher transition payload");
    const voucherId = String(req.params.id ?? "");
    res.json(success(businessService.transitionRewardVoucher(admin, voucherId, body)));
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

  router.get("/admin/missions", adminReviewLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const query = parseWithSchema(adminPaginationSchema, req.query, "Invalid mission pagination");
    res.json(success(businessService.listAdminMissions(admin, query)));
  });

  router.patch("/admin/missions/:id", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(adminMissionUpdateSchema, req.body, "Invalid mission lifecycle payload");
    res.json(success(businessService.updateAdminMission(admin, String(req.params.id ?? ""), body)));
  });

  router.delete("/admin/missions/:id", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const body = parseWithSchema(adminReasonSchema, req.body, "A reason is required to delete a mission");
    res.json(success(businessService.deleteAdminMission(admin, String(req.params.id ?? ""), body.reason)));
  });

  router.post("/admin/trust/:kind/:id", adminWriteLimiter, (req, res) => {
    const admin = requireAdmin(req, businessService);
    const kind = String(req.params.kind ?? "");
    if (!(["feedback", "wrong_price", "venue_request"] as const).includes(kind as never)) {
      res.status(404).json({ ok: false, error: { message: "Trust queue type not found." } });
      return;
    }
    const body = parseWithSchema(trustWorkflowUpdateSchema, req.body, "Invalid trust queue update");
    res.json(success(businessService.updateTrustQueueItem(
      admin,
      kind as "feedback" | "wrong_price" | "venue_request",
      String(req.params.id ?? ""),
      body,
    )));
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

  router.post("/billing/portal", billingLimiter, async (req, res, next) => {
    try {
      const account = requireAccount(req, businessService);
      res.status(201).json(success(await businessService.createBillingPortal(account)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/billing/recovery-portal", authLimiter, billingLimiter, async (req, res, next) => {
    try {
      const body = parseWithSchema(billingRecoveryPortalSchema, req.body, "Invalid billing recovery payload");
      res.status(201).json(success(await businessService.createSuspendedAccountBillingPortal(
        body,
        getRequestContext(req),
      )));
    } catch (error) {
      next(error);
    }
  });

  router.post("/billing/demo-subscribe", billingLimiter, (req, res) => {
    const account = requireAccount(req, businessService);
    const body = parseWithSchema(checkoutSchema, req.body, "Invalid demo subscription payload");
    res.json(success(businessService.handleDemoSubscription(account, body.plan)));
  });

  router.post("/billing/webhook", async (req, res, next) => {
    try {
      const raw = req.rawBody ? Buffer.from(req.rawBody) : Buffer.from(JSON.stringify(req.body ?? {}));
      const result = await businessService.handleStripeWebhook(raw, req.header("stripe-signature") ?? undefined);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
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
