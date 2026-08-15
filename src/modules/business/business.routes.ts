import { Router, type Request, type Response } from "express";

import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { success } from "../../lib/http.js";
import { getClientIp, getRateLimitIdentity } from "../../lib/client-ip.js";
import {
  getSessionAuthorization,
  hasSessionCredential,
  SESSION_COOKIE_NAME,
} from "../../lib/session-cookie.js";
import { parseWithSchema } from "../../lib/validation.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";

import {
  accountPreferencesSchema,
  adminReasonSchema,
  accountDeletionNotificationResolutionSchema,
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
  browserEmailReauthenticationStartSchema,
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
  PUBLIC_VENUE_DIRECTORY_PAGE_LIMIT,
  venuesQuerySchema,
  wrongPriceReportSchema,
  versionedVenueDeleteSchema,
} from "./business.schemas.js";
import type { BusinessService } from "./business.service.js";

const deferredCommercialVenueRoutePatterns = [
  /^\/account\/(?:discount-pass|free-pint-reward-code)\/?$/,
  /^\/account\/counter-staff-invitations\/[^/]+\/respond\/?$/,
  /^\/beta\/pub-golf\/plan\/?$/,
  /^\/billing(?:\/|$)/,
  /^\/admin\/(?:leaderboard-prizes|reward-vouchers)(?:\/|$)/,
  /^\/admin\/reports\/monthly\/(?:generate|deliver)\/?$/,
  /^\/pos\/discount-redemptions\/?$/,
  /^\/venue-portal\/[^/]+\/(?:reports(?:\/|$)|report-delivery\/?$|reconciliation\/?$)/,
  /^\/venue-portal\/[^/]+\/(?:specials|member-preview|discount-redemptions|pint-point-drinks|counter-staff|free-pint-rewards|pos-integration|billing)(?:\/|$)/,
];

const BROWSER_EMAIL_REAUTHENTICATION_COOKIE_NAME = "pint_path_email_reauth";
const BROWSER_EMAIL_REAUTHENTICATION_COOKIE_PATH = "/api/business/auth/supabase-session";

function exactCookieValue(req: Request, name: string): string | null {
  const matches = String(req.header("cookie") || "")
    .split(";")
    .flatMap((part) => {
      const separator = part.indexOf("=");
      return separator >= 0 && part.slice(0, separator).trim() === name
        ? [part.slice(separator + 1).trim()]
        : [];
    });
  if (matches.length !== 1 || !matches[0]) return null;
  try {
    return decodeURIComponent(matches[0]);
  } catch {
    return null;
  }
}

function trustedNativeSupabaseExchangeClient(req: Request): "ios-native-v1" | "android-native-v1" | null {
  if (req.header("origin") !== undefined) return null;
  if (Object.keys(req.headers).some((name) => name.toLowerCase().startsWith("sec-fetch-"))) return null;
  const marker = req.header("sec-pint-path-client");
  return marker === "ios-native-v1" || marker === "android-native-v1" ? marker : null;
}

export function isDeferredCommercialVenueRoute(pathname: string): boolean {
  const normalizedPath = pathname.toLowerCase();
  return deferredCommercialVenueRoutePatterns.some((pattern) => pattern.test(normalizedPath));
}

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

function setBrowserEmailReauthenticationCookie(res: Response, token: string, expiresAt: string): void {
  res.cookie(BROWSER_EMAIL_REAUTHENTICATION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: BROWSER_EMAIL_REAUTHENTICATION_COOKIE_PATH,
    expires: new Date(expiresAt),
  });
}

function clearBrowserEmailReauthenticationCookie(res: Response): void {
  res.clearCookie(BROWSER_EMAIL_REAUTHENTICATION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: BROWSER_EMAIL_REAUTHENTICATION_COOKIE_PATH,
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

const venueDirectoryReadLimiter = createRateLimiter({
  keyPrefix: "business:venue-directory",
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

const accountReadLimiter = createRateLimiter({
  keyPrefix: "business:account-reads",
  windowMs: 60_000,
  max: 120,
  keyGenerator: rateLimitIdentity,
});

export function createBusinessRouter(businessService: BusinessService): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  router.use((req, _res, next) => {
    if (!isDeferredCommercialVenueRoute(req.path)) {
      next();
      return;
    }
    try {
      businessService.assertCommercialVenueFeatureOpen();
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get("/config", async (_req, res) => {
    // Authentication provider availability and public Supabase keys can change
    // independently of an app release. Never let a CDN or device keep a stale
    // provider list that hides or disables a working sign-in option.
    res.setHeader("Cache-Control", "private, no-store");
    res.json(success(await businessService.getPublicConfig()));
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

  router.post("/auth/browser-email-reauthentication", authLimiter, async (req, res, next) => {
    try {
      const body = parseWithSchema(
        browserEmailReauthenticationStartSchema,
        req.body,
        "Invalid email reauthentication request",
      );
      const account = await requireAccount(req, businessService);
      const result = await businessService.beginBrowserEmailReauthentication(
        account,
        getAuthorization(req),
        body.purpose,
      );
      setBrowserEmailReauthenticationCookie(res, result.challengeToken, result.expiresAt);
      res.json(success({ email: result.email, expiresAt: result.expiresAt }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/supabase-session", authLimiter, async (req, res, next) => {
    try {
      const body = parseWithSchema(authSupabaseSessionSchema, req.body, "Invalid Supabase auth payload");
      const browserEmailChallenge = exactCookieValue(req, BROWSER_EMAIL_REAUTHENTICATION_COOKIE_NAME);
      const result = await businessService.loginWithSupabaseAccessToken(
        body,
        getRequestContext(req),
        getAuthorization(req),
        browserEmailChallenge ?? undefined,
        trustedNativeSupabaseExchangeClient(req),
      );
      // Keep the narrow HttpOnly challenge through a possible MFA step-up and
      // consume it only after the account-locked purpose-session rotation has
      // committed. Invalid or abandoned challenges expire after ten minutes
      // and a newly started ceremony atomically overwrites the cookie.
      if (browserEmailChallenge !== null) {
        clearBrowserEmailReauthenticationCookie(res);
      }
      setSessionCookie(res, result.token, result.expiresAt);
      // Provider-backed app sessions are cookie-only on every client. Keeping
      // token delivery independent of a caller-controlled body flag prevents a
      // browser from downgrading the exchange and reading its HttpOnly session
      // credential from JSON. Native clients consume the same Set-Cookie value
      // through their platform-protected cookie stores.
      const { token: _httpOnlyToken, ...cookieSessionResult } = result;
      void _httpOnlyToken;
      res.json(success(cookieSessionResult));
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

  router.post("/auth/provider-global-signout-resume", authLimiter, async (req, res, next) => {
    try {
      const body = parseWithSchema(
        passwordResetCompleteSchema,
        req.body,
        "Invalid provider sign-out recovery payload",
      );
      const result = await businessService.resumeProviderGlobalRevocation(body, getRequestContext(req));
      clearSessionCookie(res);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/session-cookie", authLimiter, async (req, res) => {
    const authorization = getAuthorization(req);
    await requireAccount(req, businessService);
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    const expiresAt = await businessService.getSessionExpiresAt(authorization);
    if (!token || !expiresAt) {
      res.status(401).json({ ok: false, error: { message: "Login required." } });
      return;
    }
    setSessionCookie(res, token, expiresAt);
    res.json(success({ migrated: true, expiresAt }));
  });

  router.get("/auth/session", async (req, res) => {
    const account = await getOptionalAccount(req, businessService);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(success(await businessService.getAuthSession(account)));
  });

  router.post("/auth/logout", authLimiter, async (req, res, next) => {
    try {
      const result = await businessService.logout(getAuthorization(req), getRequestContext(req));
      clearSessionCookie(res);
      res.json(success(result));
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 401) {
        clearSessionCookie(res);
        res.json(success({ revoked: false, revokedDiscountPasses: 0 }));
        return;
      }
      next(error);
    }
  });

  // authLimiter is the first route-specific handler and uses the shared,
  // production-fail-closed Redis rate-limit authority.
  // codeql[js/missing-rate-limiting]
  router.post("/auth/logout-all", authLimiter, async (req, res, next) => { // lgtm[js/missing-rate-limiting]
    try {
      const account = await requireAccount(req, businessService);
      await businessService.requireRecentAuthentication(
        account,
        getAuthorization(req),
        getReauthenticationProof(req),
        "logout_all",
      );
      const body = parseWithSchema(logoutAllSchema, req.body ?? {}, "Invalid logout-all payload");
      const result = await businessService.logoutAll(account, body, getRequestContext(req));
      clearSessionCookie(res);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  // authLimiter is the first route-specific handler and uses the shared,
  // production-fail-closed Redis rate-limit authority.
  // codeql[js/missing-rate-limiting]
  router.get("/account/sessions", authLimiter, async (req, res) => { // lgtm[js/missing-rate-limiting]
    const account = await requireAccount(req, businessService);
    await businessService.requireRecentAuthentication(
      account,
      getAuthorization(req),
      getReauthenticationProof(req),
      "session_management",
    );
    const query = parseWithSchema(adminPaginationSchema, req.query, "Invalid session pagination");
    res.json(success(await businessService.listAccountSessions(account, getAuthorization(req), query)));
  });

  // writeLimiter is the first route-specific handler and uses the shared,
  // production-fail-closed Redis rate-limit authority.
  // codeql[js/missing-rate-limiting]
  router.delete("/account/sessions/:sessionId", writeLimiter, async (req, res) => { // lgtm[js/missing-rate-limiting]
    const account = await requireAccount(req, businessService);
    await businessService.requireRecentAuthentication(
      account,
      getAuthorization(req),
      getReauthenticationProof(req),
      "session_management",
    );
    res.json(success(await businessService.revokeAccountSession(
      account,
      account.id,
      String(req.params.sessionId ?? ""),
      getRequestContext(req),
    )));
  });

  // accountReadLimiter is the first route-specific handler and uses the shared,
  // production-fail-closed Redis rate-limit authority.
  // codeql[js/missing-rate-limiting]
  router.get("/account", accountReadLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    res.json(success(await businessService.getAccountDashboard(account)));
  });

  router.post("/account/display-name", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(displayNameUpdateSchema, req.body, "Invalid display name payload");
    res.json(success(await businessService.updateDisplayName(account, body)));
  });

  router.post("/account/discount-pass", writeLimiter, async (req, res, next) => {
    try {
      const account = await requireAccount(req, businessService);
      res.json(success(await businessService.getDiscountPass(account, getAuthorization(req))));
    } catch (error) {
      next(error);
    }
  });

  router.post("/account/free-pint-reward-code", writeLimiter, async (req, res, next) => {
    try {
      const account = await requireAccount(req, businessService);
      const body = parseWithSchema(freePintRewardCodeSchema, req.body, "Invalid Free Pint Reward payload");
      res.json(success(await businessService.createFreePintRewardCode(account, body)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/account/counter-staff-invitations/:assignmentId/respond", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(
      venueCounterStaffInvitationResponseSchema,
      req.body,
      "Invalid counter-staff invitation response",
    );
    const assignmentId = String(req.params.assignmentId ?? "");
    res.json(success(await businessService.respondToVenueCounterStaffInvitation(account, assignmentId, body)));
  });

  router.post("/account/age-confirm", writeLimiter, async (req, res) => {
    parseWithSchema(ageConfirmSchema, req.body, "Invalid age confirmation payload");
    const account = await requireAccount(req, businessService);
    res.json(success(await businessService.confirmAge(account)));
  });

  router.post("/account/legal-acceptance", writeLimiter, async (req, res) => {
    const body = parseWithSchema(legalAcceptanceSchema, req.body, "Invalid legal acceptance payload");
    const account = await requireAccount(req, businessService);
    res.json(success(await businessService.acceptLegal(account, body)));
  });

  router.post("/account/preferences", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(accountPreferencesSchema, req.body, "Invalid preferences payload");
    res.json(success(await businessService.savePreferences(account, body)));
  });

  router.post("/account/privacy-settings", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(accountPrivacySettingsSchema, req.body, "Invalid privacy settings payload");
    res.json(success(await businessService.savePrivacySettings(account, body)));
  });

  // accountExportLimiter is the first route-specific handler and uses the shared,
  // production-fail-closed Redis rate-limit authority.
  // codeql[js/missing-rate-limiting]
  router.get("/account/export", accountExportLimiter, async (req, res) => { // lgtm[js/missing-rate-limiting]
    const account = await requireAccount(req, businessService);
    await businessService.requireRecentAuthentication(
      account,
      getAuthorization(req),
      getReauthenticationProof(req),
      "account_export",
    );
    const encoded = JSON.stringify(success(await businessService.exportAccountData(account)));
    if (Buffer.byteLength(encoded) > 25 * 1024 * 1024) {
      throw new AppError("Account export is too large for self-service delivery. Contact privacy support for a secure export.", 413);
    }
    res.type("application/json").send(encoded);
  });

  // writeLimiter is the first route-specific handler and uses the shared,
  // production-fail-closed Redis rate-limit authority.
  // codeql[js/missing-rate-limiting]
  router.post("/account/delete-request", writeLimiter, async (req, res) => { // lgtm[js/missing-rate-limiting]
    const account = await requireAccount(req, businessService);
    await businessService.requireRecentAuthentication(
      account,
      getAuthorization(req),
      getReauthenticationProof(req),
      "account_deletion",
    );
    const body = parseWithSchema(accountDeletionRequestSchema, req.body, "Invalid deletion request payload");
    res.json(success(await businessService.requestAccountDeletion(account, body)));
  });

  // accountReadLimiter is the first route-specific handler and uses the shared,
  // production-fail-closed Redis rate-limit authority.
  // codeql[js/missing-rate-limiting]
  router.get("/account/delete-request", accountReadLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    res.json(success(await businessService.getAccountDeletionStatus(account)));
  });

  // writeLimiter is the first route-specific handler and uses the shared,
  // production-fail-closed Redis rate-limit authority.
  // codeql[js/missing-rate-limiting]
  router.delete("/account/delete-request/:id", writeLimiter, async (req, res) => { // lgtm[js/missing-rate-limiting]
    const account = await requireAccount(req, businessService);
    await businessService.requireRecentAuthentication(
      account,
      getAuthorization(req),
      getReauthenticationProof(req),
      "account_deletion",
    );
    res.json(success(await businessService.cancelAccountDeletion(account, String(req.params.id ?? ""))));
  });

  router.get("/admin/account-deletions", adminReviewLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const query = parseWithSchema(adminPaginationSchema, req.query, "Invalid account deletion pagination");
    res.json(success(await businessService.listAccountDeletionRequests(admin, query)));
  });

  router.get("/admin/accounts/:userId/sessions", adminReviewLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const query = parseWithSchema(adminPaginationSchema, req.query, "Invalid session pagination");
    res.json(success(await businessService.listAdminAccountSessions(admin, String(req.params.userId ?? ""), query)));
  });

  router.delete("/admin/accounts/:userId/sessions/:sessionId", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(adminReasonSchema, req.body, "A reason is required to revoke another account's session");
    res.json(success(await businessService.revokeAccountSession(
      admin,
      String(req.params.userId ?? ""),
      String(req.params.sessionId ?? ""),
      getRequestContext(req),
      body.reason,
    )));
  });

  router.get("/admin/security-audit", adminReviewLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
    const offset = typeof req.query.offset === "string" ? Number(req.query.offset) : 0;
    const action = typeof req.query.action === "string" ? req.query.action.trim().slice(0, 120) : null;
    const actorUserId = typeof req.query.actorUserId === "string" ? req.query.actorUserId.trim().slice(0, 180) : null;
    const cursorCreatedAt = typeof req.query.cursorCreatedAt === "string"
      ? req.query.cursorCreatedAt.trim() || null
      : null;
    const cursorId = typeof req.query.cursorId === "string"
      ? req.query.cursorId.trim().slice(0, 255) || null
      : null;
    if ((cursorCreatedAt === null) !== (cursorId === null)) {
      throw new AppError("Both security audit cursor fields are required.", 400);
    }
    res.json(success(await businessService.getAdminSecurityAuditLogs(admin, {
      limit: Number.isFinite(limit) ? limit : 100,
      offset: Number.isFinite(offset) ? offset : 0,
      cursor: cursorCreatedAt && cursorId ? { createdAt: cursorCreatedAt, id: cursorId } : null,
      action: action || null,
      actorUserId: actorUserId || null,
    })));
  });

  router.post("/admin/account-deletions/:id/execute", adminReviewLimiter, async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, businessService);
      const body = parseWithSchema(adminReasonSchema, req.body, "A reason is required to execute account deletion");
      res.json(success(await businessService.executeAccountDeletion(admin, String(req.params.id ?? ""), body.reason)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/account-deletions/:id/notification-retry", adminReviewLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(adminReasonSchema, req.body, "A reason is required to retry a completion notice");
    res.json(success(await businessService.retryFailedAccountDeletionCompletionNotification(
      admin,
      String(req.params.id ?? ""),
      body.reason,
    )));
  });

  router.post("/admin/account-deletions/:id/notification-resolution", adminReviewLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(
      accountDeletionNotificationResolutionSchema,
      req.body,
      "A resolution and audit reason are required for a completion notice",
    );
    res.json(success(await businessService.resolveAccountDeletionCompletionNotification(
      admin,
      String(req.params.id ?? ""),
      body.resolution,
      body.reason,
    )));
  });

  router.post("/account/saved-items", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(saveItemSchema, req.body, "Invalid saved item payload");
    res.status(201).json(success(await businessService.saveItem(account, body)));
  });

  router.delete("/account/saved-items", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(removeSavedItemSchema, req.body, "Invalid saved item removal payload");
    res.json(success(await businessService.removeSavedItem(account, body)));
  });

  router.get("/access", async (req, res) => {
    const account = await getOptionalAccount(req, businessService);
    const anonymousSessionId =
      typeof req.query.anonymousSessionId === "string" ? req.query.anonymousSessionId : null;
    res.json(success(businessService.getAccessState(account, anonymousSessionId)));
  });

  router.get("/venues", venueDirectoryReadLimiter, async (req, res, next) => {
    try {
      const credentialsSupplied = hasSessionCredential(req);
      res.vary("Origin");
      res.vary("Authorization");
      res.vary("Cookie");
      if (credentialsSupplied) {
        res.setHeader("Cache-Control", "private, no-store");
      }
      const account = await getOptionalAccount(req, businessService);
      if (credentialsSupplied && !account) {
        throw new AppError("Login required.", 401);
      }
      const query = parseWithSchema(venuesQuerySchema, req.query, "Invalid venue query");
      const result = await businessService.listVenuesPage(
        query.q,
        Math.min(query.limit, PUBLIC_VENUE_DIRECTORY_PAGE_LIMIT),
        query.offset,
        account,
      );
      if (!credentialsSupplied) {
        res.setHeader(
          "Cache-Control",
          env.RESTORE_REHEARSAL_MODE ? "private, no-store" : "public, max-age=30, stale-while-revalidate=120",
        );
      }
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/submissions", writeLimiter, async (req, res, next) => {
    try {
      const account = await requireAccount(req, businessService);
      const body = parseWithSchema(createSubmissionSchema, req.body, "Invalid submission payload");
      const result = await businessService.createUserSubmission(account, body);
      res.status(result.idempotentReplay ? 200 : 201).json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/feedback", writeLimiter, async (req, res) => {
    const account = await getOptionalAccount(req, businessService);
    const body = parseWithSchema(feedbackSchema, req.body, "Invalid feedback payload");
    res.status(201).json(success(await businessService.submitFeedback(account, body)));
  });

  router.post("/wrong-price-reports", writeLimiter, async (req, res, next) => {
    try {
      const account = await getOptionalAccount(req, businessService);
      const body = parseWithSchema(wrongPriceReportSchema, req.body, "Invalid wrong price report payload");
      res.status(201).json(success(await businessService.reportWrongPrice(account, body)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/requests", writeLimiter, async (req, res) => {
    const account = await getOptionalAccount(req, businessService);
    const body = parseWithSchema(venueRequestSchema, req.body, "Invalid request payload");
    res.status(201).json(success(await businessService.createVenueRequest(account, body)));
  });

  router.post("/venue-interest", writeLimiter, async (req, res) => {
    const account = await getOptionalAccount(req, businessService);
    const body = parseWithSchema(venueInterestSchema, req.body, "Invalid venue interest payload");
    res.status(201).json(success(await businessService.createVenueInterest(account, body)));
  });

  router.get("/submissions", async (req, res) => {
    const account = await getOptionalAccount(req, businessService);
    const query = parseWithSchema(submissionsQuerySchema, req.query, "Invalid submissions query");
    res.json(success(await businessService.getSubmissionsPage(account, query)));
  });

  router.get("/verification-candidates", lookupLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const query = parseWithSchema(
      verificationCandidatesQuerySchema,
      req.query,
      "Invalid verification candidate query",
    );
    res.json(success(await businessService.getCommunityVerificationCandidates(account, query)));
  });

  router.get("/submissions/:id/source-evidence-url", sourceEvidenceLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    res.json(success(await businessService.getSubmissionSourceEvidenceUrl(account, String(req.params.id ?? ""))));
  });

  router.get("/source-evidence/:id", sourceEvidenceLimiter, async (req, res, next) => {
    try {
      const evidence = await businessService.getSourceEvidenceForSignedRequest({
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

  router.post("/submissions/:id/review", adminReviewLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(reviewSubmissionSchema, req.body, "Invalid review payload");
    const result = await businessService.reviewSubmission(admin, String(req.params.id ?? ""), body);
    res.json(success(result));
  });

  // writeLimiter is the first route-specific handler and uses the shared,
  // production-fail-closed Redis rate-limit authority.
  // codeql[js/missing-rate-limiting]
  router.post("/submissions/:id/verifications", writeLimiter, async (req, res) => { // lgtm[js/missing-rate-limiting]
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(verificationSchema, req.body, "Invalid verification payload");
    const submissionId = String(req.params.id ?? "");
    const result = await businessService.verifySubmission(account, submissionId, body);
    res.status(201).json(success(result));
  });

  router.get("/missions", async (req, res) => {
    const account = await getOptionalAccount(req, businessService);
    const query = parseWithSchema(missionsQuerySchema, req.query, "Invalid missions query");
    res.json(success(await businessService.getMissionsPage(query, account)));
  });

  router.post("/missions/:id/accept", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    res.json(success(await businessService.acceptMission(account, String(req.params.id ?? ""))));
  });

  router.delete("/missions/:id/accept", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    res.json(success(await businessService.releaseMission(account, String(req.params.id ?? ""))));
  });

  router.post("/missions/:id/release", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    res.json(success(await businessService.releaseMission(account, String(req.params.id ?? ""))));
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
      const account = await requireAccount(req, businessService);
      const query = parseWithSchema(venuePlaceSearchQuerySchema, req.query, "Invalid venue lookup query");
      const result = await businessService.searchVenuePlacesForSubmission(account, query.q);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.get("/venue-places/:placeId", lookupLimiter, async (req, res, next) => {
    try {
      const account = await requireAccount(req, businessService);
      const placeId = String(req.params.placeId ?? "");
      const result = await businessService.getVenuePlaceForSubmission(account, placeId);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/missions", adminWriteLimiter, async (req, res) => {
    await requireAdmin(req, businessService);
    const body = parseWithSchema(createMissionSchema, req.body, "Invalid mission payload");
    const mission = await businessService.createMission(body);
    res.status(201).json(success({ mission }));
  });

  router.get("/price-records", priceReadLimiter, async (req, res) => {
    const account = await getOptionalAccount(req, businessService);
    const query = parseWithSchema(priceRecordsQuerySchema, req.query, "Invalid price records query");
    res.json(success(await businessService.listPriceRecords(account, {
      ...query,
      clientIp: getClientIp(req) ?? undefined,
    })));
  });

  router.get("/leaderboard", async (req, res) => {
    const account = await getOptionalAccount(req, businessService);
    const query = parseWithSchema(leaderboardQuerySchema, req.query, "Invalid leaderboard query");
    res.json(success(await businessService.getLeaderboard(account, query)));
  });

  router.post("/beta/pub-golf/plan", writeLimiter, async (req, res, next) => {
    try {
      const account = await requireAccount(req, businessService);
      const body = parseWithSchema(pubGolfPlanSchema, req.body, "Invalid Pub Golf planner payload");
      res.json(success(await businessService.planPubGolf(account, body)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/events", eventLimiter, async (req, res) => {
    const account = await getOptionalAccount(req, businessService);
    const body = parseWithSchema(eventTrackSchema, req.body, "Invalid analytics event payload");
    await businessService.trackClientEvent(account, body, getRequestContext(req));
    res.status(201).json(success({ recorded: true }));
  });

  router.get("/analytics/preview", async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    res.json(success(await businessService.getAnalyticsPreview(admin)));
  });

  router.get("/venue-portal", async (req, res) => {
    const account = await requireAccount(req, businessService);
    const query = parseWithSchema(venuePortalQuerySchema, req.query, "Invalid venue portal query");
    res.json(success(await businessService.getVenuePortal(account, query)));
  });

  router.get("/venue-portal/:venueId/reports/:month/export", async (req, res) => {
    const account = await requireAccount(req, businessService);
    const params = parseWithSchema(monthlyReportParamsSchema, req.params, "Invalid monthly report export request");
    const query = parseWithSchema(monthlyReportExportQuerySchema, req.query, "Invalid monthly report export query");
    const result = await businessService.exportVenueMonthlyReport(account, params.venueId, params.month, query);
    res
      .type(result.mimeType)
      .setHeader("Cache-Control", "private, no-store")
      .setHeader("Content-Disposition", `attachment; filename="${result.filename}"`)
      .send(result.body);
  });

  router.get("/venue-portal/:venueId/reports/:month", async (req, res) => {
    const account = await requireAccount(req, businessService);
    const params = parseWithSchema(monthlyReportParamsSchema, req.params, "Invalid monthly report request");
    const report = await businessService.getVenueMonthlyReport(account, params.venueId, params.month);
    res
      .setHeader("Cache-Control", "private, no-store")
      .json(success({ report }));
  });

  router.get("/venue-portal/:venueId/report-delivery", async (req, res) => {
    const account = await requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    res
      .setHeader("Cache-Control", "private, no-store")
      .json(success(await businessService.getVenueReportDeliverySettings(account, venueId)));
  });

  router.get("/venue-portal/:venueId/reconciliation", async (req, res) => {
    const account = await requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    const query = parseWithSchema(
      venueReconciliationQuerySchema,
      req.query,
      "Invalid reconciliation pagination",
    );
    res
      .setHeader("Cache-Control", "private, no-store")
      .json(success(await businessService.getVenueReconciliation(account, venueId, query)));
  });

  router.put("/venue-portal/:venueId/report-delivery", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    const body = parseWithSchema(
      venueReportDeliverySettingsSchema,
      req.body,
      "Invalid monthly report delivery settings",
    );
    res.json(success(await businessService.updateVenueReportDeliverySettings(account, venueId, body)));
  });

  router.post("/pos/discount-redemptions", posIpGuardLimiter, posVenueLimiter, async (req, res) => {
    const body = parseWithSchema(posDiscountRedemptionSchema, req.body, "Invalid POS discount redemption payload");
    const bearerToken = getAuthorization(req)?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    const token = req.header("x-pint-path-pos-token") ?? bearerToken;
    res.status(201).json(success(await businessService.redeemDiscountPassFromPos(body, token, getRequestContext(req))));
  });

  router.post("/venue-claim-requests", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(venueClaimRequestSchema, req.body, "Invalid venue claim request payload");
    const result = await businessService.createVenueClaimRequest(account, body);
    res.status(result.duplicate ? 200 : 201).json(success(result));
  });

  router.post("/venue-portal/:venueId/submissions", writeLimiter, async (req, res, next) => {
    try {
      const account = await requireAccount(req, businessService);
      const body = parseWithSchema(createSubmissionSchema, req.body, "Invalid venue update payload");
      const venueId = String(req.params.venueId ?? "");
      res.status(201).json(success(await businessService.createVenueManagerSubmission(account, venueId, body)));
    } catch (error) {
      next(error);
    }
  });

  router.post("/venue-portal/:venueId/profile", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(barProfileSchema, req.body, "Invalid venue profile payload");
    const venueId = String(req.params.venueId ?? "");
    res.json(success(await businessService.upsertBarProfile(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/beers", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(barBeerSchema, req.body, "Invalid beer inventory payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(await businessService.upsertBarBeer(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/beers/bulk", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(barBeerBulkSchema, req.body, "Invalid bulk beer inventory payload");
    const venueId = String(req.params.venueId ?? "");
    res.json(success(await businessService.bulkUpsertBarBeers(account, venueId, body)));
  });

  router.delete("/venue-portal/:venueId/beers/:beerId", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    const beerId = String(req.params.beerId ?? "");
    const body = parseWithSchema(versionedVenueDeleteSchema, req.body, "A current beer-row version is required");
    res.json(success(await businessService.deleteBarBeer(account, venueId, beerId, body.expectedUpdatedAt)));
  });

  router.post("/venue-portal/:venueId/happy-hours", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(barHappyHourSchema, req.body, "Invalid happy-hour payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(await businessService.upsertBarHappyHour(account, venueId, body)));
  });

  router.delete("/venue-portal/:venueId/happy-hours/:happyHourId", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    const happyHourId = String(req.params.happyHourId ?? "");
    const body = parseWithSchema(versionedVenueDeleteSchema, req.body, "A current happy-hour version is required");
    res.json(success(await businessService.deleteBarHappyHour(account, venueId, happyHourId, body.expectedUpdatedAt)));
  });

  router.post("/venue-portal/:venueId/specials", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(barSpecialSchema, req.body, "Invalid deal or special payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(await businessService.upsertBarSpecial(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/member-preview", venueCounterLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(pintPointMemberPreviewSchema, req.body, "Invalid Pint Path member code");
    const venueId = String(req.params.venueId ?? "");
    res.json(success(await businessService.previewPintPointMember(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/discount-redemptions", venueCounterLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(discountRedemptionSchema, req.body, "Invalid discount redemption payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(await businessService.redeemDiscountPass(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/pint-point-drinks", venueCounterLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(pintPointDrinkRecordSchema, req.body, "Invalid Pint Points drink payload");
    const venueId = String(req.params.venueId ?? "");
    const result = await businessService.recordPintPointDrink(account, venueId, body);
    res.status(result.idempotentReplay ? 200 : 201).json(success(result));
  });

  router.post("/venue-portal/:venueId/pint-point-drinks/:recordId/void", venueCounterLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(pintPointDrinkVoidSchema, req.body, "Invalid Pint Points correction payload");
    const venueId = String(req.params.venueId ?? "");
    const recordId = String(req.params.recordId ?? "");
    res.json(success(await businessService.voidPintPointDrink(account, venueId, recordId, body)));
  });

  router.post("/venue-portal/:venueId/counter-staff", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(venueCounterStaffAssignmentSchema, req.body, "Invalid counter-staff assignment payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(await businessService.assignVenueCounterStaff(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/counter-staff/revoke", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(venueCounterStaffAssignmentSchema, req.body, "Invalid counter-staff revoke payload");
    const venueId = String(req.params.venueId ?? "");
    res.json(success(await businessService.revokeVenueCounterStaff(account, venueId, body)));
  });

  router.post("/venue-portal/:venueId/free-pint-rewards", venueCounterLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(freePintRewardDecisionSchema, req.body, "Invalid Free Pint Reward payload");
    const venueId = String(req.params.venueId ?? "");
    res.status(201).json(success(await businessService.handleFreePintRewardCode(account, venueId, body)));
  });

  router.get("/venue-portal/:venueId/pos-integration", async (req, res) => {
    const account = await requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    res.json(success(await businessService.getVenuePosIntegration(account, venueId)));
  });

  router.post("/venue-portal/:venueId/pos-integration/rotate", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    res.json(success(await businessService.rotateVenuePosIntegrationToken(account, venueId)));
  });

  router.delete("/venue-portal/:venueId/specials/:specialId", writeLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const venueId = String(req.params.venueId ?? "");
    const specialId = String(req.params.specialId ?? "");
    const body = parseWithSchema(versionedVenueDeleteSchema, req.body, "A current special version is required");
    res.json(success(await businessService.deleteBarSpecial(account, venueId, specialId, body.expectedUpdatedAt)));
  });

  router.post("/venue-portal/:venueId/billing/checkout", billingLimiter, async (req, res, next) => {
    try {
      const account = await requireAccount(req, businessService);
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
      const account = await requireAccount(req, businessService);
      const venueId = String(req.params.venueId ?? "");
      await businessService.requireRecentAuthentication(
        account,
        getAuthorization(req),
        getReauthenticationProof(req),
        "venue_billing_portal",
      );
      res.status(201).json(success(await businessService.createBarBillingPortal(account, venueId)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/kpis", async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const query = parseWithSchema(adminDashboardQuerySchema, req.query, "Invalid KPI dashboard query");
    res.json(success(await businessService.getAdminKpis(admin, query)));
  });

  router.post("/admin/reports/monthly/generate", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(monthlyReportGenerateSchema, req.body, "Invalid monthly report generation payload");
    res.json(success(await businessService.generateVenueMonthlyReports(admin, body)));
  });

  router.post("/admin/reports/monthly/deliver", adminWriteLimiter, async (req, res, next) => {
    try {
      const admin = await requireAdmin(req, businessService);
      const body = parseWithSchema(monthlyReportDeliverySchema, req.body, "Invalid monthly report delivery payload");
      res.json(success(await businessService.deliverVenueMonthlyReports(admin, body)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/admin/retention", async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const query = parseWithSchema(retentionQuerySchema, req.query, "Invalid retention query");
    res.json(success(await businessService.getRetentionCohorts(admin, query)));
  });

  router.get("/admin/coverage", async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    res.json(success(await businessService.getCoverageDashboard(admin)));
  });

  router.get("/admin/partner-leads", async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    res.json(success(await businessService.getPotentialPartnerLeads(admin)));
  });

  router.get("/admin/queues", async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const query = parseWithSchema(adminPaginationSchema, req.query, "Invalid admin queue pagination");
    res.json(success(await businessService.getAdminQueues(admin, query)));
  });

  router.get("/admin/operational-health", async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    res.json(success(await businessService.getOperationalHealth(admin)));
  });

  router.get("/admin/beer-catalog", async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const query = parseWithSchema(beerCatalogAdminQuerySchema, req.query, "Invalid beer catalogue pagination");
    res.json(success(await businessService.getAdminBeerCatalog(admin, query)));
  });

  router.post("/admin/beer-catalog/reject-pending", adminReviewLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(beerCatalogBulkRejectSchema, req.body, "Invalid beer catalogue bulk rejection payload");
    res.json(success(await businessService.rejectBeerCatalogItems(admin, body)));
  });

  router.post("/admin/beer-catalog/:key/approve", adminReviewLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(beerCatalogApproveSchema, req.body, "Invalid beer catalogue approval payload");
    const key = String(req.params.key ?? "");
    res.json(success(await businessService.approveBeerCatalogItem(admin, key, body)));
  });

  router.post("/admin/beer-catalog/:key/merge", adminReviewLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(beerCatalogMergeSchema, req.body, "Invalid beer catalogue merge payload");
    const key = String(req.params.key ?? "");
    res.json(success(await businessService.mergeBeerCatalogItem(admin, key, body)));
  });

  router.post("/admin/beer-catalog/:key/reject", adminReviewLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(beerCatalogRejectSchema, req.body, "Invalid beer catalogue rejection payload");
    const key = String(req.params.key ?? "");
    res.json(success(await businessService.rejectBeerCatalogItem(admin, key, body)));
  });

  router.get("/admin/venue-partners", async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const query = parseWithSchema(adminPaginationSchema, req.query, "Invalid venue partner pagination");
    res.json(success(await businessService.getVenuePartnerAdmin(admin, query)));
  });

  router.post("/admin/venue-claims/:id/review", adminReviewLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(venueClaimReviewSchema, req.body, "Invalid venue claim review payload");
    const claimId = String(req.params.id ?? "");
    res.json(success(await businessService.reviewVenueClaimRequest(admin, claimId, body)));
  });

  router.get("/admin/leaderboard-prizes", async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    res.json(success(await businessService.getLeaderboardPrizeAdmin(admin)));
  });

  router.post("/admin/leaderboard-prizes", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(leaderboardPrizeCampaignSchema, req.body, "Invalid leaderboard prize payload");
    res.json(success(await businessService.saveLeaderboardPrizeCampaign(admin, body)));
  });

  router.post("/admin/leaderboard-prizes/finalize", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(leaderboardPrizeFinalizeSchema, req.body, "Invalid leaderboard finalization payload");
    res.json(success(await businessService.finalizeLeaderboardPrizeCampaign(admin, body)));
  });

  router.post("/admin/reward-vouchers/:id/transition", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(rewardVoucherTransitionSchema, req.body, "Invalid reward voucher transition payload");
    const voucherId = String(req.params.id ?? "");
    res.json(success(await businessService.transitionRewardVoucher(admin, voucherId, body)));
  });

  router.get("/admin/accounts", async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const query = parseWithSchema(adminAccountSearchSchema, req.query, "Invalid admin account search query");
    res.json(success(await businessService.searchAccountsForAdmin(admin, query)));
  });

  router.post("/admin/venue-pending-changes/:id/review", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(venuePendingChangeReviewSchema, req.body, "Invalid pending venue change review payload");
    const changeId = String(req.params.id ?? "");
    res.json(success(await businessService.reviewVenuePendingChange(admin, changeId, body)));
  });

  router.post("/admin/venue-managers", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(venueManagerAssignmentSchema, req.body, "Invalid venue manager assignment payload");
    res.status(201).json(success(await businessService.assignVenueManager(admin, body)));
  });

  router.post("/admin/venue-managers/revoke", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(venueManagerRevokeSchema, req.body, "Invalid venue manager revoke payload");
    res.json(success(await businessService.revokeVenueManager(admin, body)));
  });

  router.post("/admin/venue-interest/:id/status", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(venueInterestStatusSchema, req.body, "Invalid venue interest status payload");
    const interestId = String(req.params.id ?? "");
    res.json(success(await businessService.updateVenueInterestStatus(admin, interestId, body)));
  });

  router.post("/admin/venue-outreach", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(venueOutreachSchema, req.body, "Invalid venue outreach payload");
    res.json(success(await businessService.upsertVenueOutreach(admin, body)));
  });

  router.post("/admin/requests/:id/mission", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const requestId = String(req.params.id ?? "");
    res.status(201).json(success(await businessService.createMissionFromRequest(admin, requestId)));
  });

  router.get("/admin/missions", adminReviewLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const query = parseWithSchema(adminPaginationSchema, req.query, "Invalid mission pagination");
    res.json(success(await businessService.listAdminMissions(admin, query)));
  });

  router.patch("/admin/missions/:id", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(adminMissionUpdateSchema, req.body, "Invalid mission lifecycle payload");
    res.json(success(await businessService.updateAdminMission(admin, String(req.params.id ?? ""), body)));
  });

  router.delete("/admin/missions/:id", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(adminReasonSchema, req.body, "A reason is required to delete a mission");
    res.json(success(await businessService.deleteAdminMission(admin, String(req.params.id ?? ""), body.reason)));
  });

  router.post("/admin/trust/:kind/:id", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const kind = String(req.params.kind ?? "");
    if (!(["feedback", "wrong_price", "venue_request"] as const).includes(kind as never)) {
      res.status(404).json({ ok: false, error: { message: "Trust queue type not found." } });
      return;
    }
    const body = parseWithSchema(trustWorkflowUpdateSchema, req.body, "Invalid trust queue update");
    res.json(success(await businessService.updateTrustQueueItem(
      admin,
      kind as "feedback" | "wrong_price" | "venue_request",
      String(req.params.id ?? ""),
      body,
    )));
  });

  router.post("/billing/checkout", billingLimiter, async (req, res, next) => {
    try {
      const account = await requireAccount(req, businessService);
      const body = parseWithSchema(checkoutSchema, req.body, "Invalid checkout payload");
      const result = await businessService.createCheckout(account, body);
      res.status(201).json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/billing/checkout/reconcile", billingLimiter, async (req, res, next) => {
    try {
      const account = await requireAccount(req, businessService);
      const body = parseWithSchema(checkoutSessionSchema, req.body, "Invalid checkout confirmation payload");
      const result = await businessService.reconcileCheckoutSession(account, body);
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/billing/portal", billingLimiter, async (req, res, next) => {
    try {
      const account = await requireAccount(req, businessService);
      await businessService.requireRecentAuthentication(
        account,
        getAuthorization(req),
        getReauthenticationProof(req),
        "billing_portal",
      );
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

  router.post("/billing/demo-subscribe", billingLimiter, async (req, res) => {
    const account = await requireAccount(req, businessService);
    const body = parseWithSchema(checkoutSchema, req.body, "Invalid demo subscription payload");
    res.json(success(await businessService.handleDemoSubscription(account, body.plan)));
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

  router.post("/account-deletion-notifications/resend-webhook", async (req, res, next) => {
    try {
      const rawBody = req.rawBody ? Buffer.from(req.rawBody) : Buffer.from(JSON.stringify(req.body ?? {}));
      const result = await businessService.handleResendAccountDeletionWebhook({
        rawBody,
        id: req.header("svix-id") ?? undefined,
        timestamp: req.header("svix-timestamp") ?? undefined,
        signature: req.header("svix-signature") ?? undefined,
      });
      res.json(success(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/admin/users/:id/status", adminWriteLimiter, async (req, res) => {
    const admin = await requireAdmin(req, businessService);
    const body = parseWithSchema(adminUserStatusSchema, req.body, "Invalid user status payload");
    res.json(success(await businessService.adminOverrideUser(admin, String(req.params.id ?? ""), body)));
  });

  router.post("/demo/seed", adminWriteLimiter, async (req, res) => {
    await requireAdmin(req, businessService);
    res.json(success(await businessService.seedDemoMissions()));
  });

  return router;
}
