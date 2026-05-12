import crypto from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { CONTRIBUTION_POINTS, PREMIUM_PRICING, SUBMISSION_LIMITS } from "../../config/business-rules.js";
import type { Env } from "../../config/env.js";
import {
  BusinessRepository,
  type BusinessAccount,
  type BarMembershipTier,
  type BarProfile,
  type BusinessSubmission,
  type BusinessSubmissionItem,
  type ConfidenceLabel,
  type PublicVenuePriceRecord,
  type SubscriptionStatus,
} from "../../db/business.repository.js";
import { VIEWER_TRACKED_BEERS, canonicalizeTrackedBeerName } from "../../constants/beers.js";
import { AppError, ExternalServiceError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { redactSecrets } from "../../lib/redact.js";

import type {
  AccountPreferencesInput,
  AdminDashboardQuery,
  AuthLoginInput,
  AuthSignupInput,
  BarBeerInput,
  BarClaimRequestInput,
  BarHappyHourInput,
  BarProfileInput,
  BarSpecialInput,
  BarTierCheckoutInput,
  CheckoutInput,
  CreateSubmissionInput,
  EventTrackInput,
  FeedbackInput,
  PriceRecordsQuery,
  RemoveSavedItemInput,
  ReviewSubmissionInput,
  RetentionQuery,
  SaveItemInput,
  VenueInterestInput,
  VenueInterestStatusInput,
  VenueManagerAssignmentInput,
  VenueManagerRevokeInput,
  VenueOutreachInput,
  VenuePortalQuery,
  VenueRequestInput,
  WrongPriceReportInput,
} from "./business.schemas.js";

interface VenueRow {
  id: string;
  name: string;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
}

interface StripeEvent {
  id: string;
  type: string;
  data?: {
    object?: Record<string, unknown>;
  };
}

export interface SessionRequestContext {
  ip?: string | null | undefined;
  userAgent?: string | null | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function addDays(baseIso: string, days: number): string {
  const date = new Date(baseIso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function monthKeyFromIso(value: string): string {
  return value.slice(0, 7);
}

function startOfTodayIso(): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function daysAgoIso(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

function startOfMonthIso(): string {
  const date = new Date();
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function startOfAdminRange(range: AdminDashboardQuery["range"]): string | null {
  switch (range) {
    case "today":
      return startOfTodayIso();
    case "7d":
      return daysAgoIso(7);
    case "30d":
      return daysAgoIso(30);
    case "month":
      return startOfMonthIso();
    case "all":
      return null;
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeBeerId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashRequestFingerprint(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(":");

  if (scheme !== "scrypt" || !salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sanitizeAccount(account: BusinessAccount) {
  return {
    id: account.id,
    email: account.email,
    role: account.role,
    ageConfirmedAt: account.ageConfirmedAt,
    subscriptionStatus: account.subscriptionStatus,
    premiumUntil: account.premiumUntil,
    trustScore: account.trustScore,
    contributionPointsCurrentMonth: account.contributionPointsCurrentMonth,
    approvedSubmissionCount: account.approvedSubmissionCount,
    rejectedSubmissionCount: account.rejectedSubmissionCount,
    fraudStrikeCount: account.fraudStrikeCount,
    status: account.status,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function getSourcePhotoBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    return 0;
  }

  return Buffer.byteLength(dataUrl.slice(commaIndex + 1), "base64");
}

function getSourcePhotoBuffer(dataUrl: string): Buffer {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    return Buffer.alloc(0);
  }

  return Buffer.from(dataUrl.slice(commaIndex + 1), "base64");
}

function getSourcePhotoMimeType(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:([^;]+);base64,/i);
  return match?.[1]?.toLowerCase() ?? null;
}

const BLOCKED_SOURCE_URL_EXTENSIONS = /\.(?:svg|html?|xhtml|xml|js|mjs|css)(?:[?#].*)?$/i;

function detectImageMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  if (bytes.length >= 12 && bytes.toString("ascii", 4, 12).includes("ftyphei")) {
    return "image/heic";
  }

  return null;
}

function looksLikeActiveTextPayload(bytes: Buffer): boolean {
  const head = bytes.toString("utf8", 0, Math.min(bytes.length, 512)).trimStart().toLowerCase();
  return /^(?:<!doctype\s+html|<html|<script|<svg|<\?xml|@import|body\s*\{|\/\*)/.test(head);
}

function getBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function isFullAccess(account: BusinessAccount | null): boolean {
  if (!account) {
    return false;
  }

  if (account.role === "admin" || account.subscriptionStatus === "admin") {
    return true;
  }

  if (!account.ageConfirmedAt) {
    return false;
  }

  if (account.subscriptionStatus === "premium_monthly" || account.subscriptionStatus === "premium_yearly") {
    return true;
  }

  if (account.subscriptionStatus === "contributor_unlocked" && account.premiumUntil) {
    return new Date(account.premiumUntil).getTime() > Date.now();
  }

  return false;
}

function redactPriceRecord(record: PublicVenuePriceRecord): PublicVenuePriceRecord & { priceRedacted: true } {
  return {
    ...record,
    price: null,
    happyHourDetails: null,
    sourceSubmissionId: null,
    priceRedacted: true,
  };
}

function hashAnonymousFallback(value: string): string {
  return `ip:${crypto.createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function formEncode(value: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, entry] of Object.entries(value)) {
    params.set(key, entry);
  }

  return params;
}

function cleanStringList(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ).slice(0, 20);
}

function tierFlags(tier: BarMembershipTier) {
  return {
    highlightedName: tier === "pro",
    premiumBadge: tier === "pro" ? "Pro" : tier === "plus" ? "Plus" : null,
    promoted: tier === "pro",
    featuredSpecialEligible: tier === "pro",
  };
}

function getBarTierCapabilities(tier: BarMembershipTier, admin = false) {
  const analytics = admin || tier === "plus" || tier === "pro";
  return {
    tier,
    canManageProfile: true,
    canManageInventory: true,
    canManageHappyHours: true,
    canManageSpecials: true,
    analytics,
    monthlyReports: analytics,
    premiumDisplay: tier === "pro",
    upgradeCopy: analytics
      ? null
      : "Upgrade to Plus to see privacy-safe suburb analytics, search trends, and monthly report previews.",
  };
}

function sanitizeEventMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const blockedKeyPattern = /(email|phone|token|secret|password|authorization|auth|api.?key|photo|image|dataurl|latitude|longitude|\blat\b|\blng\b|coordinates?|gps|precise.?location)/i;
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata).slice(0, 30)) {
    if (blockedKeyPattern.test(key)) {
      continue;
    }

    if (value == null || typeof value === "boolean" || typeof value === "number") {
      sanitized[key] = value;
      continue;
    }

    if (typeof value === "string") {
      sanitized[key] = value.slice(0, 220);
      continue;
    }

    if (Array.isArray(value)) {
      sanitized[key] = value
        .slice(0, 12)
        .map((entry) => (typeof entry === "string" ? entry.slice(0, 120) : entry))
        .filter((entry) => entry == null || ["string", "number", "boolean"].includes(typeof entry));
      continue;
    }

    sanitized[key] = "[object]";
  }

  return sanitized;
}

export class BusinessService {
  private readonly supabase?: SupabaseClient;

  constructor(
    private readonly repository: BusinessRepository,
    private readonly config: Pick<
      Env,
      | "PUBLIC_BASE_URL"
      | "FREE_PRICE_REVEALS_PER_DAY"
      | "CONTRIBUTOR_UNLOCK_POINTS"
      | "CONTRIBUTOR_UNLOCK_DAYS"
      | "DEMO_BILLING_MODE"
      | "FIELD_TEST_MODE"
      | "SESSION_TTL_DAYS"
      | "ADMIN_SESSION_TTL_DAYS"
      | "ANALYTICS_MIN_BUCKET_SIZE"
      | "ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION"
      | "NODE_ENV"
      | "STRIPE_SECRET_KEY"
      | "STRIPE_WEBHOOK_SECRET"
      | "STRIPE_PRICE_MONTHLY"
      | "STRIPE_PRICE_YEARLY"
      | "STRIPE_PLUS_PRICE_ID"
      | "STRIPE_PRO_PRICE_ID"
      | "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"
      | "SUPABASE_URL"
      | "SUPABASE_SERVICE_ROLE_KEY"
      | "ADMIN_EMAILS"
    >,
  ) {
    if (config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY) {
      this.supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
    }
  }

  private getRequestHashes(context?: SessionRequestContext | undefined) {
    return {
      ipHash: hashRequestFingerprint(context?.ip),
      userAgentHash: hashRequestFingerprint(context?.userAgent),
    };
  }

  private auditSecurity(input: {
    actor?: BusinessAccount | null | undefined;
    action: string;
    targetType?: string | null | undefined;
    targetId?: string | null | undefined;
    metadata?: Record<string, unknown> | undefined;
    context?: SessionRequestContext | undefined;
  }): void {
    const requestHashes = this.getRequestHashes(input.context);

    try {
      this.repository.insertSecurityAuditLog({
        id: crypto.randomUUID(),
        actorUserId: input.actor?.id ?? null,
        actorRole: input.actor?.role ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: sanitizeEventMetadata(redactSecrets(input.metadata ?? {})),
        ipHash: requestHashes.ipHash,
        userAgentHash: requestHashes.userAgentHash,
        createdAt: nowIso(),
      });
    } catch (error) {
      logger.warn("Security audit log write failed", {
        action: input.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private applyAnalyticsThreshold<T extends { count: number }>(rows: T[]): T[] {
    return rows.filter((row) => row.count >= this.config.ANALYTICS_MIN_BUCKET_SIZE);
  }

  getPublicConfig() {
    return {
      pricing: PREMIUM_PRICING,
      freePriceRevealsPerDay: this.config.FREE_PRICE_REVEALS_PER_DAY,
      contributorUnlockPoints: this.config.CONTRIBUTOR_UNLOCK_POINTS,
      contributorUnlockDays: this.config.CONTRIBUTOR_UNLOCK_DAYS,
      stripePublishableKey: this.config.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null,
      demoBillingMode: this.config.DEMO_BILLING_MODE,
      fieldTestMode: this.config.FIELD_TEST_MODE,
      rewards: {
        partnerVenueCredit: "disabled",
        copy: "Partner venue credit is coming soon and is not active in this demo.",
      },
      trackedBeers: VIEWER_TRACKED_BEERS,
    };
  }

  getAccountFromAuthorization(
    authorizationHeader: string | undefined,
    context?: SessionRequestContext | undefined,
  ): BusinessAccount | null {
    const token = getBearerToken(authorizationHeader);
    if (!token) {
      return null;
    }

    const tokenHash = hashToken(token);
    const account = this.repository.getAccountBySessionTokenHash(tokenHash, nowIso());
    if (!account) {
      return null;
    }

    if (account.status === "suspended") {
      return null;
    }

    const requestHashes = this.getRequestHashes(context);
    this.repository.touchSession({
      tokenHash,
      lastUsedAt: nowIso(),
      lastIpHash: requestHashes.ipHash,
      userAgentHash: requestHashes.userAgentHash,
    });
    return account;
  }

  requireAccount(
    authorizationHeader: string | undefined,
    context?: SessionRequestContext | undefined,
  ): BusinessAccount {
    const account = this.getAccountFromAuthorization(authorizationHeader, context);

    if (!account) {
      throw new AppError("Login required.", 401);
    }

    return account;
  }

  requireAdmin(
    authorizationHeader: string | undefined,
    context?: SessionRequestContext | undefined,
  ): BusinessAccount {
    const account = this.requireAccount(authorizationHeader, context);

    if (account.role !== "admin" && account.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    return account;
  }

  private requireVerifiedBarAccount(account: BusinessAccount): void {
    if (account.status !== "active") {
      throw new AppError("Your account must be active to manage a bar.", 403);
    }

    if (!account.ageConfirmedAt) {
      throw new AppError("Verify your account before managing a bar. Confirm 18+ from your account page first.", 403);
    }
  }

  private isAdmin(account: BusinessAccount): boolean {
    return account.role === "admin" || account.subscriptionStatus === "admin";
  }

  private requireAssignedVenue(account: BusinessAccount, venueId: string) {
    if (this.isAdmin(account)) {
      return null;
    }

    this.requireVerifiedBarAccount(account);

    if (account.role !== "venue_manager") {
      throw new AppError("Venue manager access required.", 403);
    }

    const assignment = this.repository.getVenueManagerAssignment({
      userId: account.id,
      venueId,
      activeOnly: true,
    });

    if (!assignment) {
      this.auditSecurity({
        actor: account,
        action: "venue_manager_cross_venue_blocked",
        targetType: "venue",
        targetId: venueId,
        metadata: { accountRole: account.role },
      });
      throw new AppError("You can only access assigned venues.", 403);
    }

    return assignment;
  }

  private buildDefaultBarProfile(input: { barId: string; name: string; suburb: string | null }): BarProfile {
    const now = nowIso();
    return {
      barId: input.barId,
      name: input.name,
      address: null,
      suburb: input.suburb,
      area: input.suburb,
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      highlightedName: false,
      premiumBadge: null,
      promoted: false,
      featuredSpecialEligible: false,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      tierManualOverride: false,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  private getOrBuildBarProfile(input: { barId: string; name: string; suburb: string | null }): BarProfile {
    return this.repository.getBarProfile(input.barId) ?? this.buildDefaultBarProfile(input);
  }

  private ensureBarProfile(input: { barId: string; name: string; suburb: string | null }): BarProfile {
    const existing = this.repository.getBarProfile(input.barId);
    if (existing) {
      return existing;
    }

    const flags = tierFlags("basic");
    return this.repository.upsertBarProfile({
      barId: input.barId,
      name: input.name,
      address: null,
      suburb: input.suburb,
      area: input.suburb,
      phone: null,
      website: null,
      instagram: null,
      description: null,
      openingHours: {},
      venueTags: [],
      membershipTier: "basic",
      active: true,
      now: nowIso(),
      ...flags,
    });
  }

  signup(input: AuthSignupInput, context?: SessionRequestContext | undefined) {
    const email = normalizeEmail(input.email);

    if (this.repository.getAccountByEmail(email)) {
      throw new AppError("An account already exists for that email.", 409);
    }

    const now = nowIso();
    const adminEmails = new Set(
      (this.config.ADMIN_EMAILS ?? "")
        .split(",")
        .map((value) => normalizeEmail(value))
        .filter(Boolean),
    );
    const account = this.repository.createAccount({
      id: crypto.randomUUID(),
      email,
      passwordHash: hashPassword(input.password),
      role: adminEmails.has(email) ? "admin" : "user",
      subscriptionStatus: adminEmails.has(email) ? "admin" : "free",
      now,
    });
    const confirmed = input.ageConfirmed ? this.repository.updateAgeConfirmed(account.id, now) : account;

    this.trackEvent(confirmed, {
      anonymousSessionId: null,
      eventType: "signup_completed",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { role: confirmed.role },
    });

    if (input.ageConfirmed) {
      this.trackEvent(confirmed, {
        anonymousSessionId: null,
        eventType: "age_confirmed",
        venueId: null,
        beerId: null,
        suburb: null,
        metadata: { source: "signup" },
      });
    }

    return this.createSessionResponse(confirmed, context);
  }

  login(input: AuthLoginInput, context?: SessionRequestContext | undefined) {
    const account = this.repository.getAccountByEmail(normalizeEmail(input.email));

    if (!account || !verifyPassword(input.password, account.passwordHash)) {
      throw new AppError("Invalid email or password.", 401);
    }

    if (account.status === "suspended") {
      throw new AppError("Account access is suspended.", 403);
    }

    const session = this.createSessionResponse(account, context);
    this.auditSecurity({
      actor: account,
      action: "login_success",
      targetType: "account",
      targetId: account.id,
      metadata: { role: account.role },
      context,
    });
    return session;
  }

  confirmAge(account: BusinessAccount) {
    const confirmedAt = nowIso();
    const updated = this.repository.updateAgeConfirmed(account.id, confirmedAt);
    this.trackEvent(updated, {
      anonymousSessionId: null,
      eventType: "age_confirmed",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { source: "account" },
    });
    return {
      account: sanitizeAccount(updated),
    };
  }

  private createSessionResponse(account: BusinessAccount, context?: SessionRequestContext | undefined) {
    const now = nowIso();
    const token = crypto.randomBytes(32).toString("base64url");
    const ttlDays = account.role === "admin" || account.subscriptionStatus === "admin"
      ? this.config.ADMIN_SESSION_TTL_DAYS
      : this.config.SESSION_TTL_DAYS;
    const requestHashes = this.getRequestHashes(context);

    this.repository.createSession({
      tokenHash: hashToken(token),
      userId: account.id,
      createdAt: now,
      expiresAt: addDays(now, ttlDays),
      lastUsedAt: now,
      lastIpHash: requestHashes.ipHash,
      userAgentHash: requestHashes.userAgentHash,
    });

    return {
      token,
      account: sanitizeAccount(account),
      access: this.getAccessState(account, null),
    };
  }

  logout(authorizationHeader: string | undefined, context?: SessionRequestContext | undefined) {
    const token = getBearerToken(authorizationHeader);
    if (!token) {
      throw new AppError("Login required.", 401);
    }

    const account = this.requireAccount(authorizationHeader, context);
    const revoked = this.repository.revokeSession({
      tokenHash: hashToken(token),
      revokedAt: nowIso(),
    });
    this.auditSecurity({
      actor: account,
      action: "logout",
      targetType: "account",
      targetId: account.id,
      metadata: { revoked },
      context,
    });
    return { revoked };
  }

  logoutAll(account: BusinessAccount, context?: SessionRequestContext | undefined) {
    const revokedCount = this.repository.revokeUserSessions({
      userId: account.id,
      revokedAt: nowIso(),
    });
    this.auditSecurity({
      actor: account,
      action: "logout_all",
      targetType: "account",
      targetId: account.id,
      metadata: { revokedCount },
      context,
    });
    return { revokedCount };
  }

  getAccessState(account: BusinessAccount | null, anonymousSessionId: string | null) {
    const hasFullAccess = isFullAccess(account);
    const used = hasFullAccess
      ? 0
      : this.repository.countEvents({
          eventType: "price_view_revealed",
          userId: account?.id ?? null,
          anonymousSessionId,
          since: startOfTodayIso(),
        });
    const remaining = Math.max(0, this.config.FREE_PRICE_REVEALS_PER_DAY - used);

    return {
      status: account?.subscriptionStatus ?? "free",
      hasFullAccess,
      isAdmin: account?.role === "admin" || account?.subscriptionStatus === "admin",
      ageConfirmed: Boolean(account?.ageConfirmedAt),
      freePriceRevealsPerDay: this.config.FREE_PRICE_REVEALS_PER_DAY,
      freePriceRevealsUsedToday: used,
      freePriceRevealsRemainingToday: remaining,
      canRevealPrice: hasFullAccess || remaining > 0,
      canUseCheapestSort: hasFullAccess,
      canUseBeerSearch: hasFullAccess,
      canUseHappyHourActiveNow: hasFullAccess,
      canUseVerifiedOnly: hasFullAccess,
      premiumUntil: account?.premiumUntil ?? null,
    };
  }

  getAccountDashboard(account: BusinessAccount) {
    const preferences = this.repository.getAccountPreferences(account.id);
    const savedItems = this.repository.listSavedItems(account.id);
    const savedSuburbs = savedItems
      .filter((item) => item.itemType === "suburb")
      .map((item) => item.label);
    const suggestedSuburb = savedSuburbs[0] ?? preferences?.preferredSuburbs[0];
    const suggestedMissions = this.listMissions({ suburb: suggestedSuburb, sort: "saved", limit: 6 });

    return {
      account: sanitizeAccount(account),
      access: this.getAccessState(account, null),
      submissions: this.repository.listSubmissions({ userId: account.id, limit: 100 }),
      preferences: preferences ?? {
        userId: account.id,
        preferredSuburbs: [],
        preferredBeers: [],
        preferredUseCases: [],
        onboardingCompletedAt: null,
        createdAt: null,
        updatedAt: null,
      },
      savedItems,
      recentSearches: this.repository.listRecentSearches(account.id, 10),
      suggestedMissions,
      contributorProgress: {
        pointsThisMonth: account.contributionPointsCurrentMonth,
        unlockThreshold: this.config.CONTRIBUTOR_UNLOCK_POINTS,
        pointsNeeded: Math.max(0, this.config.CONTRIBUTOR_UNLOCK_POINTS - account.contributionPointsCurrentMonth),
      },
      rewards: {
        status: "coming_soon",
        eligiblePlaceholder: account.approvedSubmissionCount > 0,
      },
    };
  }

  createSubmission(account: BusinessAccount, input: CreateSubmissionInput) {
    if (account.status === "suspended") {
      throw new AppError("Suspended accounts cannot submit reward-eligible data.", 403);
    }

    if (!account.ageConfirmedAt) {
      throw new AppError("Please confirm you are 18+ before submitting venue data.", 403);
    }

    const sourcePhotoUrl = this.resolveSourcePhoto(input);
    const now = nowIso();
    const submission = this.repository.createSubmission({
      id: crypto.randomUUID(),
      userId: account.id,
      venueId: input.venueId,
      venueName: input.venueName,
      suburb: input.suburb,
      submissionType: input.submissionType,
      observedAt: input.observedAt,
      sourcePhotoUrl,
      notes: input.notes,
      now,
      items: input.items.map((item) => {
        const beerName = canonicalizeTrackedBeerName(item.beerName);
        return {
          id: crypto.randomUUID(),
          beerName,
          normalizedBeerId: normalizeBeerId(beerName),
          servingSize: item.servingSize,
          price: item.price,
          isHappyHourPrice: item.isHappyHourPrice,
          happyHourDetails: item.happyHourDetails,
          isOnTap: item.isOnTap,
          confidence: sourcePhotoUrl ? 0.72 : 0.52,
        };
      }),
    });

    const firstItemBeerName = input.items[0] ? canonicalizeTrackedBeerName(input.items[0].beerName) : null;
    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "submission_completed",
      venueId: submission.venueId,
      beerId: firstItemBeerName ? normalizeBeerId(firstItemBeerName) : null,
      suburb: submission.suburb,
      metadata: {
        submissionId: submission.id,
        submissionType: submission.submissionType,
        itemCount: input.items.length,
        hasSourcePhoto: Boolean(sourcePhotoUrl),
      },
    });

    return {
      submission,
      statusCopy: "Submitted for review. Approved data can earn points and may unlock contributor access.",
      ocrStatus: sourcePhotoUrl ? "queued_for_review" : "not_requested",
    };
  }

  private resolveSourcePhoto(input: Pick<CreateSubmissionInput, "sourcePhotoDataUrl" | "sourcePhotoUrl">): string | null {
    if (input.sourcePhotoDataUrl) {
      if (this.config.NODE_ENV === "production" && !this.config.ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION) {
        throw new AppError("Inline demo image storage is disabled in production. Use private object storage for evidence uploads.", 503);
      }

      const mimeType = getSourcePhotoMimeType(input.sourcePhotoDataUrl);
      if (!mimeType || !SUBMISSION_LIMITS.allowedImageMimeTypes.includes(mimeType as never)) {
        throw new AppError("Upload must be a JPEG, PNG, WebP, HEIC, or HEIF image.", 400);
      }

      if (getSourcePhotoBytes(input.sourcePhotoDataUrl) > SUBMISSION_LIMITS.maxPhotoBytes) {
        throw new AppError("Upload image must be 6MB or smaller.", 400);
      }

      const bytes = getSourcePhotoBuffer(input.sourcePhotoDataUrl);
      if (looksLikeActiveTextPayload(bytes)) {
        throw new AppError("Upload must be a safe image file, not SVG, HTML, XML, script, or style content.", 400);
      }

      const detectedMimeType = detectImageMimeType(bytes);
      if (!detectedMimeType || detectedMimeType !== mimeType) {
        throw new AppError("Upload image content does not match the declared file type.", 400);
      }

      // Demo storage: keep the data URL with the pending submission. Production should move this
      // to object storage and keep only a private object key.
      return input.sourcePhotoDataUrl;
    }

    if (!input.sourcePhotoUrl) {
      return null;
    }

    let parsed: URL;
    try {
      parsed = new URL(input.sourcePhotoUrl);
    } catch {
      throw new AppError("Source photo URL must be a valid HTTP or HTTPS URL.", 400);
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new AppError("Source photo URL must use HTTP or HTTPS.", 400);
    }

    if (BLOCKED_SOURCE_URL_EXTENSIONS.test(parsed.pathname)) {
      throw new AppError("Source photo URL must point to a safe image source, not HTML, SVG, script, or style content.", 400);
    }

    return parsed.toString();
  }

  savePreferences(account: BusinessAccount, input: AccountPreferencesInput) {
    const now = nowIso();
    const preferences = this.repository.upsertAccountPreferences({
      userId: account.id,
      preferredSuburbs: cleanStringList(input.preferredSuburbs),
      preferredBeers: cleanStringList(input.preferredBeers),
      preferredUseCases: cleanStringList(input.preferredUseCases),
      onboardingCompletedAt: input.onboardingCompleted ? now : null,
      now,
    });

    return { preferences };
  }

  saveItem(account: BusinessAccount, input: SaveItemInput) {
    const now = nowIso();
    const savedItem = this.repository.saveItem({
      id: crypto.randomUUID(),
      userId: account.id,
      itemType: input.itemType,
      itemId: input.itemId,
      label: input.label,
      suburb: input.suburb,
      metadata: sanitizeEventMetadata(input.metadata),
      now,
    });
    const eventTypeByItem: Record<SaveItemInput["itemType"], EventTrackInput["eventType"]> = {
      venue: "saved_venue_added",
      beer: "saved_beer_added",
      suburb: "saved_suburb_added",
    };

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: eventTypeByItem[input.itemType],
      venueId: input.itemType === "venue" ? input.itemId : null,
      beerId: input.itemType === "beer" ? normalizeBeerId(input.label) : null,
      suburb: input.itemType === "suburb" ? input.label : input.suburb,
      metadata: { itemId: input.itemId, label: input.label },
    });

    return { savedItem };
  }

  removeSavedItem(account: BusinessAccount, input: RemoveSavedItemInput) {
    const removed = this.repository.removeSavedItem({
      userId: account.id,
      itemType: input.itemType,
      itemId: input.itemId,
    });
    const eventTypeByItem: Record<RemoveSavedItemInput["itemType"], EventTrackInput["eventType"]> = {
      venue: "saved_venue_removed",
      beer: "saved_beer_removed",
      suburb: "saved_suburb_removed",
    };

    if (removed) {
      this.trackEvent(account, {
        anonymousSessionId: null,
        eventType: eventTypeByItem[input.itemType],
        venueId: input.itemType === "venue" ? input.itemId : null,
        beerId: input.itemType === "beer" ? normalizeBeerId(input.itemId) : null,
        suburb: input.itemType === "suburb" ? input.itemId : null,
        metadata: { itemId: input.itemId },
      });
    }

    return { removed };
  }

  submitFeedback(account: BusinessAccount | null, input: FeedbackInput) {
    const now = nowIso();
    const feedback = this.repository.createFeedback({
      id: crypto.randomUUID(),
      userId: account?.id ?? null,
      anonymousSessionId: input.anonymousSessionId,
      feedbackType: input.feedbackType,
      message: input.message,
      venueId: input.venueId,
      venueName: input.venueName,
      now,
    });

    this.trackEvent(account, {
      anonymousSessionId: input.anonymousSessionId,
      eventType: "feedback_submitted",
      venueId: input.venueId,
      beerId: null,
      suburb: null,
      metadata: { feedbackType: input.feedbackType, feedbackId: feedback.id },
    });

    return {
      feedback,
      message: "Thanks. Feedback is saved for admin review.",
    };
  }

  reportWrongPrice(account: BusinessAccount | null, input: WrongPriceReportInput) {
    const now = nowIso();
    const sourcePhotoUrl = this.resolveSourcePhoto(input);
    const result = this.repository.createWrongPriceReport({
      id: crypto.randomUUID(),
      userId: account?.id ?? null,
      anonymousSessionId: input.anonymousSessionId,
      venueId: input.venueId,
      venueName: input.venueName,
      priceRecordId: input.priceRecordId,
      beerName: input.beerName,
      reason: input.reason,
      notes: input.notes,
      sourcePhotoUrl,
      now,
    });

    this.trackEvent(account, {
      anonymousSessionId: input.anonymousSessionId,
      eventType: "wrong_price_reported",
      venueId: input.venueId,
      beerId: input.beerName ? normalizeBeerId(input.beerName) : null,
      suburb: null,
      metadata: {
        reportId: result.report.id,
        reason: input.reason,
        hasSourcePhoto: Boolean(sourcePhotoUrl),
        markedDisputed: result.markedDisputed,
      },
    });

    return {
      ...result,
      message: result.markedDisputed
        ? "Report saved. This price is now marked for review."
        : "Report saved for review. One report will not remove high-confidence data by itself.",
    };
  }

  createVenueRequest(account: BusinessAccount | null, input: VenueRequestInput) {
    const now = nowIso();
    const request = this.repository.createVenueRequest({
      id: crypto.randomUUID(),
      userId: account?.id ?? null,
      anonymousSessionId: input.anonymousSessionId,
      requestType: input.requestType,
      venueId: input.venueId,
      venueName: input.venueName,
      beerName: input.beerName,
      suburb: input.suburb,
      notes: input.notes,
      now,
    });
    const isBeerRequest = input.requestType === "missing_beer" || input.requestType === "verify_beer_at_venue";

    this.trackEvent(account, {
      anonymousSessionId: input.anonymousSessionId,
      eventType: isBeerRequest ? "beer_requested" : "venue_requested",
      venueId: input.venueId,
      beerId: input.beerName ? normalizeBeerId(input.beerName) : null,
      suburb: input.suburb,
      metadata: {
        requestId: request.id,
        requestType: input.requestType,
        venueName: input.venueName,
      },
    });

    return {
      request,
      message: "Request saved. Admin can turn high-demand requests into missions.",
    };
  }

  createVenueInterest(account: BusinessAccount | null, input: VenueInterestInput) {
    const now = nowIso();
    const interest = this.repository.createVenueInterestRequest({
      id: crypto.randomUUID(),
      userId: account?.id ?? null,
      venueId: input.venueId,
      venueName: input.venueName,
      managerName: input.managerName,
      email: normalizeEmail(input.email),
      phone: input.phone,
      role: input.role,
      notes: input.notes,
      now,
    });

    this.trackEvent(account, {
      anonymousSessionId: input.anonymousSessionId,
      eventType: input.claimListing ? "venue_claim_requested" : "venue_interest_submitted",
      venueId: input.venueId,
      beerId: null,
      suburb: null,
      metadata: {
        interestId: interest.id,
        venueName: interest.venueName,
        role: interest.role,
        claimListing: input.claimListing,
      },
    });

    return {
      interest,
      message: "Thanks. Your venue interest is saved for admin follow-up.",
    };
  }

  listSubmissions(account: BusinessAccount | null, input: { status?: string | undefined; mine: boolean; limit: number }) {
    if (!account) {
      throw new AppError("Login required.", 401);
    }

    const isAdmin = account.role === "admin" || account.subscriptionStatus === "admin";
    if (input.mine || !isAdmin) {
      return this.repository.listSubmissions({
        userId: account.id,
        status: input.status as never,
        limit: input.limit,
      });
    }

    return this.repository.listSubmissions({
      status: input.status as never,
      limit: input.limit,
    });
  }

  reviewSubmission(admin: BusinessAccount, submissionId: string, input: ReviewSubmissionInput) {
    const submission = this.repository.getSubmissionById(submissionId);

    if (!submission) {
      throw new AppError("Submission not found.", 404);
    }

    if (submission.submission.userId === admin.id) {
      throw new AppError("Admins cannot review their own submissions.", 403);
    }

    if (submission.submission.status !== "pending" && submission.submission.status !== "needs_more_evidence") {
      throw new AppError("Submission has already been reviewed.", 409);
    }

    const points = input.pointsAwarded ?? this.calculatePoints(submission.submission, submission.items);
    const result = this.repository.reviewSubmission({
      submissionId,
      reviewerId: admin.id,
      status: input.status,
      rejectionReason: input.rejectionReason,
      fraudFlagged: input.fraudFlagged || input.status === "fraud_flagged",
      pointsAwarded: input.status === "approved" ? points : 0,
      confidence: input.confidence,
      now: nowIso(),
      monthKey: monthKeyFromIso(submission.submission.observedAt),
      premiumUntil: addDays(nowIso(), this.config.CONTRIBUTOR_UNLOCK_DAYS),
      contributorUnlockPoints: this.config.CONTRIBUTOR_UNLOCK_POINTS,
    });
    this.auditSecurity({
      actor: admin,
      action: "admin_submission_review",
      targetType: "submission",
      targetId: submissionId,
      metadata: {
        status: input.status,
        fraudFlagged: input.fraudFlagged,
        pointsAwarded: input.status === "approved" ? result.pointsAwarded : 0,
        venueId: result.submission.venueId,
      },
    });
    const eventType: EventTrackInput["eventType"] =
      input.status === "approved" ? "submission_approved" : "submission_rejected";

    this.trackEvent(result.account, {
      anonymousSessionId: null,
      eventType,
      venueId: result.submission.venueId,
      beerId: null,
      suburb: result.submission.suburb,
      metadata: {
        submissionId,
        reviewedByAdmin: true,
        pointsAwarded: result.pointsAwarded,
        status: input.status,
      },
    });

    if (result.account.subscriptionStatus === "contributor_unlocked" && result.pointsAwarded > 0) {
      this.trackEvent(result.account, {
        anonymousSessionId: null,
        eventType: "contributor_access_unlocked",
        venueId: result.submission.venueId,
        beerId: null,
        suburb: result.submission.suburb,
        metadata: {
          pointsThisMonth: result.account.contributionPointsCurrentMonth,
          premiumUntil: result.account.premiumUntil,
        },
      });
    }

    return {
      ...result,
      account: sanitizeAccount(result.account),
    };
  }

  calculatePoints(submission: BusinessSubmission, items: BusinessSubmissionItem[]): number {
    const hasSource = Boolean(submission.sourcePhotoUrl);
    const hasHappyHour = items.some((item) => item.isHappyHourPrice || item.happyHourDetails);
    const hasThreePrices = items.filter((item) => item.price != null).length >= 3;

    if (hasHappyHour && hasSource) {
      return CONTRIBUTION_POINTS.happyHourWithSource;
    }

    if (submission.submissionType === "full_venue_update" && (hasSource || hasThreePrices)) {
      return CONTRIBUTION_POINTS.fullVenueUpdate;
    }

    if (hasSource) {
      return CONTRIBUTION_POINTS.menuPhoto;
    }

    if (items.some((item) => item.price != null)) {
      return CONTRIBUTION_POINTS.stalePriceUpdate;
    }

    return CONTRIBUTION_POINTS.recentConfirmation;
  }

  async listVenues(query: string | undefined, limit: number): Promise<VenueRow[]> {
    if (!this.supabase) {
      const rawQuery = query?.trim();
      const labelStem = rawQuery?.split("·")[0] ?? "";
      const normalizedQuery = (labelStem.split(",")[0] ?? "").trim().toLowerCase();
      return this.repository
        .listMissions({ activeOnly: true, limit, suburb: undefined })
        .filter((mission) => {
          if (!normalizedQuery) {
            return true;
          }

          return [mission.venueName, mission.suburb, mission.reason]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery);
        })
        .map((mission) => ({
          id: mission.venueId,
          name: mission.venueName,
          address: null,
          suburb: mission.suburb,
          state: "VIC",
          postcode: null,
          latitude: null,
          longitude: null,
        }));
    }

    let request = this.supabase
      .from("venues")
      .select("id, name, address, suburb, state, postcode, latitude, longitude")
      .limit(limit);

    if (query && query.trim().length > 0) {
      const labelStem = query.trim().split("·")[0] ?? "";
      const searchQuery = (labelStem.split(",")[0] ?? "").trim();
      const safeQuery = searchQuery.replace(/[%,()]/g, " ").replace(/\s+/g, " ").trim();
      if (safeQuery) {
        request = request.or(`name.ilike.%${safeQuery}%,suburb.ilike.%${safeQuery}%,address.ilike.%${safeQuery}%`);
      }
    }

    const { data, error } = await request.order("name", { ascending: true });

    if (error) {
      throw new ExternalServiceError("Failed to fetch venues", {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
    }

    return (data ?? []) as VenueRow[];
  }

  seedDemoMissions() {
    if (this.repository.countMissions() > 0) {
      return { created: 0 };
    }

    const now = nowIso();
    const missions = [
      ["mission:rooftop-bar", "demo:rooftop-bar", "Rooftop Bar", "Melbourne", "no prices", 5, 2],
      ["mission:railway-hotel-south-melb", "demo:railway-south-melb", "Railway Hotel", "South Melbourne", "stale prices", 3, 1],
      ["mission:fitzroy-beer-garden", "demo:fitzroy-beer-garden", "Fitzroy Beer Garden", "Fitzroy", "missing happy hour", 4, 1],
      ["mission:brighton-pub", "demo:brighton-pub", "Brighton Pub", "Brighton", "outside dense CBD cluster", 5, 1.5],
      ["mission:sandringham-hotel", "demo:sandringham-hotel", "Sandringham Hotel", "Sandringham", "high demand", 5, 2],
    ] as const;

    missions.forEach(([id, venueId, venueName, suburb, reason, points, multiplier]) => {
      this.repository.createMission({
        id,
        venueId,
        venueName,
        suburb,
        reason,
        priority: multiplier > 1 ? "high" : "normal",
        points,
        multiplier,
        lastVerifiedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    });

    return { created: missions.length };
  }

  listMissions(query: { suburb?: string | undefined; sort?: string | undefined; limit: number }) {
    this.seedDemoMissions();
    const missions = this.repository.listMissions({ activeOnly: true, suburb: query.suburb, limit: query.limit });

    switch (query.sort) {
      case "stale":
        return missions
          .slice()
          .sort((left, right) => String(left.lastVerifiedAt ?? "").localeCompare(String(right.lastVerifiedAt ?? "")));
      case "no_data":
        return missions
          .slice()
          .sort((left, right) => Number(Boolean(left.lastVerifiedAt)) - Number(Boolean(right.lastVerifiedAt)));
      case "missing_happy_hour":
        return missions
          .slice()
          .sort((left, right) => Number(/happy/i.test(right.reason)) - Number(/happy/i.test(left.reason)));
      case "most_requested":
      case "high_demand":
      case "saved":
      case "points":
      default:
        return missions;
    }
  }

  createMission(input: {
    venueId: string;
    venueName: string;
    suburb: string | null;
    reason: string;
    priority: "low" | "normal" | "high";
    points: number;
    multiplier: number;
    active: boolean;
  }) {
    const now = nowIso();
    return this.repository.createMission({
      id: crypto.randomUUID(),
      venueId: input.venueId,
      venueName: input.venueName,
      suburb: input.suburb,
      reason: input.reason,
      priority: input.priority,
      points: input.points,
      multiplier: input.multiplier,
      active: input.active,
      lastVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  listPriceRecords(
    account: BusinessAccount | null,
    input: PriceRecordsQuery & { clientIp?: string | undefined },
  ) {
    const anonymousSessionId = input.anonymousSessionId
      || (account ? null : hashAnonymousFallback(input.clientIp || "unknown-client"));
    const records = this.repository.listLatestPriceRecords(input.limit, input.venueId);
    const hasFullAccess = isFullAccess(account);

    if (hasFullAccess) {
      return {
        records,
        access: this.getAccessState(account, anonymousSessionId),
        revealed: true,
        blocked: false,
      };
    }

    const redactedRecords = records.map(redactPriceRecord);
    if (!input.reveal || !input.venueId || records.length === 0) {
      return {
        records: redactedRecords,
        access: this.getAccessState(account, anonymousSessionId),
        revealed: false,
        blocked: false,
      };
    }

    const identity = {
      userId: account?.id ?? null,
      anonymousSessionId,
    };
    const since = startOfTodayIso();
    const alreadyRevealed = this.repository.countEvents({
      eventType: "price_view_revealed",
      userId: identity.userId,
      anonymousSessionId: identity.anonymousSessionId,
      venueId: input.venueId,
      since,
    }) > 0;
    const accessBeforeReveal = this.getAccessState(account, anonymousSessionId);

    if (alreadyRevealed || accessBeforeReveal.freePriceRevealsRemainingToday > 0) {
      if (!alreadyRevealed) {
        this.trackEvent(account, {
          anonymousSessionId,
          eventType: "price_view_revealed",
          venueId: input.venueId,
          beerId: null,
          suburb: records[0]?.suburb ?? null,
          metadata: {
            source: "server_price_records",
            recordCount: records.length,
          },
        });
      }

      return {
        records,
        access: this.getAccessState(account, anonymousSessionId),
        revealed: true,
        blocked: false,
      };
    }

    this.trackEvent(account, {
      anonymousSessionId,
      eventType: "price_view_blocked_free_limit",
      venueId: input.venueId,
      beerId: null,
      suburb: records[0]?.suburb ?? null,
      metadata: {
        source: "server_price_records",
        recordCount: records.length,
      },
    });

    return {
      records: redactedRecords,
      access: this.getAccessState(account, anonymousSessionId),
      revealed: false,
      blocked: true,
    };
  }

  trackEvent(account: BusinessAccount | null, input: EventTrackInput): void {
    try {
      this.repository.recordEvent({
        id: crypto.randomUUID(),
        userId: account?.id ?? null,
        anonymousSessionId: input.anonymousSessionId,
        eventType: input.eventType,
        venueId: input.venueId,
        beerId: input.beerId,
        suburb: input.suburb,
        metadata: sanitizeEventMetadata(input.metadata),
        createdAt: nowIso(),
      });
    } catch (error) {
      logger.warn("Analytics event capture failed", {
        eventType: input.eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getAnalyticsPreview(admin: BusinessAccount) {
    if (admin.role !== "admin" && admin.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    const preview = this.repository.getAnalyticsPreview();
    return {
      ...preview,
      topSearchedBeers: this.applyAnalyticsThreshold(preview.topSearchedBeers),
      topClickedVenues: this.applyAnalyticsThreshold(preview.topClickedVenues),
      topSuburbs: this.applyAnalyticsThreshold(preview.topSuburbs),
      suppressedBelowCount: this.config.ANALYTICS_MIN_BUCKET_SIZE,
    };
  }

  getVenuePortal(account: BusinessAccount, query: VenuePortalQuery) {
    this.requireVerifiedBarAccount(account);
    const isAdmin = this.isAdmin(account);
    const assignments = isAdmin
      ? this.repository.listVenueManagerAssignments({ activeOnly: true, limit: 100 })
      : this.repository.listVenueManagerAssignments({ userId: account.id, activeOnly: true, limit: 100 });

    if (!isAdmin && assignments.length === 0) {
      return {
        accessState: "claim_required",
        assignments: [],
        selectedVenue: null,
        profile: null,
        tier: null,
        inventory: { beers: [], happyHours: [], specials: [] },
        insights: null,
        analytics: null,
        monthlyReport: null,
        updateLink: null,
        claimRequests: this.repository.listBarClaimRequests({ userId: account.id, limit: 10 }),
        message: "Request access to a bar and admin will manually review the claim.",
        privacyCopy: "Venue insights are aggregated and privacy-safe. Individual user clickstream and exact location are never shown.",
      };
    }

    const selectedVenueId = query.venueId ?? assignments[0]?.venueId;
    if (!selectedVenueId) {
      return {
        assignments,
        selectedVenue: null,
        insights: null,
        updateLink: null,
        privacyCopy: "Venue insights are aggregated and privacy-safe. Individual user clickstream and exact location are never shown.",
      };
    }

    const assignment = isAdmin
      ? assignments.find((item) => item.venueId === selectedVenueId) ?? null
      : this.requireAssignedVenue(account, selectedVenueId);
    if (!isAdmin && !assignment) {
      throw new AppError("You can only access assigned venues.", 403);
    }

    const venueName = assignment?.venueName ?? selectedVenueId;
    const suburb = assignment?.suburb ?? null;
    const rawInsights = this.repository.getVenueManagerInsights({
      venueId: selectedVenueId,
      suburb,
      staleBefore: daysAgoIso(30),
    });
    const profile = this.getOrBuildBarProfile({ barId: selectedVenueId, name: venueName, suburb });
    const capabilities = getBarTierCapabilities(profile.membershipTier, isAdmin);
    const analytics = capabilities.analytics
      ? this.repository.getBarAreaAnalytics({
          barId: selectedVenueId,
          area: profile.area ?? profile.suburb ?? suburb,
          month: monthKeyFromIso(nowIso()),
          privacyThreshold: Math.max(10, this.config.ANALYTICS_MIN_BUCKET_SIZE),
        })
      : null;
    const savedMonthlyReport = capabilities.monthlyReports
      ? this.repository.getMonthlyBarReport({ barId: selectedVenueId, month: monthKeyFromIso(nowIso()) })
      : null;
    const monthlyReport = capabilities.monthlyReports
      ? savedMonthlyReport ?? {
          id: null,
          barId: selectedVenueId,
          month: monthKeyFromIso(nowIso()),
          data: {
            generated: false,
            summary: analytics
              ? {
                  totalBarLookups: analytics.barLookups,
                  totalProfileViews: analytics.profileViews,
                  totalBeerListViews: analytics.beerListViews,
                  totalSpecialsDealsViews: analytics.specialsViews,
                  mostSearchedBeerStylesInArea: analytics.privacyFloorMet ? analytics.areaStyleSearches : [],
                  mostSearchedBeersInArea: analytics.privacyFloorMet ? analytics.areaBeerSearches : [],
                  suggestedActions: analytics.privacyFloorMet
                    ? [
                        "Keep your tap list current so nearby search demand has an accurate listing to land on.",
                        "Add happy-hour details if they are missing; users often filter by active specials.",
                      ]
                    : ["Not enough suburb data yet. Your report will become more useful as more users search nearby."],
                }
              : null,
          },
          createdAt: null,
        }
      : null;
    const insights = capabilities.analytics
      ? rawInsights
      : {
          ...rawInsights,
          aggregateInsights: null,
        };
    const updateLink = `/submit.html?venueId=${encodeURIComponent(selectedVenueId)}&venueName=${encodeURIComponent(venueName)}${suburb ? `&suburb=${encodeURIComponent(suburb)}` : ""}`;

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_portal_viewed",
      venueId: selectedVenueId,
      beerId: null,
      suburb,
      metadata: { assignmentCount: assignments.length },
    });
    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_insights_viewed",
      venueId: selectedVenueId,
      beerId: null,
      suburb,
      metadata: { source: "venue_portal" },
    });

    return {
      assignments,
      selectedVenue: {
        venueId: selectedVenueId,
        venueName,
        suburb,
      },
      profile,
      tier: {
        ...capabilities,
        analyticsLocked: !capabilities.analytics,
      },
      inventory: {
        beers: this.repository.listBarBeers(selectedVenueId),
        happyHours: this.repository.listBarHappyHours(selectedVenueId),
        specials: this.repository.listBarSpecials(selectedVenueId),
      },
      insights,
      analytics,
      monthlyReport,
      updateLink,
      qrCopy: "Copy this update link or turn it into a QR code for your bar/tap-list area.",
      privacyCopy: "Venue insights are aggregated and privacy-safe. Individual user clickstream and exact location are never shown.",
    };
  }

  createBarClaimRequest(account: BusinessAccount, input: BarClaimRequestInput) {
    this.requireVerifiedBarAccount(account);
    const now = nowIso();
    const claim = this.repository.createBarClaimRequest({
      id: crypto.randomUUID(),
      userId: account.id,
      barId: input.barId,
      barName: input.barName,
      address: input.address,
      suburb: input.suburb,
      requesterName: input.requesterName,
      requesterRole: input.requesterRole,
      contactEmail: normalizeEmail(input.contactEmail),
      contactPhone: input.contactPhone,
      message: input.message,
      now,
    });

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_claim_requested",
      venueId: claim.barId,
      beerId: null,
      suburb: claim.suburb,
      metadata: {
        claimId: claim.id,
        barName: claim.barName,
        requesterRole: claim.requesterRole,
      },
    });

    return {
      claim,
      message: "Claim request submitted. Admin will manually verify and assign access if approved.",
    };
  }

  createVenueManagerSubmission(account: BusinessAccount, venueId: string, input: CreateSubmissionInput) {
    const assignment = this.requireAssignedVenue(account, venueId);

    if (input.venueId !== venueId) {
      throw new AppError("Venue update must match the assigned venue.", 403);
    }

    const result = this.createSubmission(account, {
      ...input,
      notes: [
        input.notes,
        "Venue manager submitted update. Keep pending for admin/data-quality review unless manually approved.",
      ].filter(Boolean).join(" "),
    });

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId: input.items[0]?.beerName ? normalizeBeerId(input.items[0].beerName) : null,
      suburb: assignment?.suburb ?? input.suburb,
      metadata: {
        submissionId: result.submission.id,
        submissionType: input.submissionType,
      },
    });

    return {
      ...result,
      message: "Venue update submitted for review. Approved updates can be shown as venue-confirmed data.",
    };
  }

  upsertBarProfile(account: BusinessAccount, venueId: string, input: BarProfileInput) {
    const assignment = this.requireAssignedVenue(account, venueId);
    const existing = this.repository.getBarProfile(venueId);
    const existingTier = existing?.membershipTier ?? "basic";
    const membershipTier = this.isAdmin(account) ? input.membershipTier ?? existingTier : existingTier;
    const flags = tierFlags(membershipTier);
    const now = nowIso();
    const profile = this.repository.upsertBarProfile({
      barId: venueId,
      name: input.name,
      address: input.address,
      suburb: input.suburb ?? assignment?.suburb ?? existing?.suburb ?? null,
      area: input.area ?? input.suburb ?? assignment?.suburb ?? existing?.area ?? existing?.suburb ?? null,
      phone: input.phone,
      website: input.website,
      instagram: input.instagram,
      description: input.description,
      openingHours: input.openingHours,
      venueTags: cleanStringList(input.venueTags),
      membershipTier,
      active: input.active,
      tierManualOverride: this.isAdmin(account) && input.membershipTier !== undefined ? true : existing?.tierManualOverride ?? false,
      now,
      ...flags,
    });

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId: null,
      suburb: profile.suburb,
      metadata: { section: "profile", membershipTier: profile.membershipTier },
    });

    return {
      profile,
      tier: getBarTierCapabilities(profile.membershipTier, this.isAdmin(account)),
      message: "Bar profile saved.",
    };
  }

  upsertBarBeer(account: BusinessAccount, venueId: string, input: BarBeerInput) {
    const assignment = this.requireAssignedVenue(account, venueId);
    const existing = input.id ? this.repository.getBarBeerById(input.id) : null;
    if (existing && existing.barId !== venueId) {
      throw new AppError("Beer row belongs to another venue.", 403);
    }

    const profile = this.ensureBarProfile({
      barId: venueId,
      name: assignment?.venueName ?? this.repository.getBarProfile(venueId)?.name ?? venueId,
      suburb: assignment?.suburb ?? this.repository.getBarProfile(venueId)?.suburb ?? null,
    });
    const beer = this.repository.upsertBarBeer({
      id: input.id ?? crypto.randomUUID(),
      barId: venueId,
      beerName: input.beerName,
      brewery: input.brewery,
      style: input.style,
      abv: input.abv,
      serveSize: input.serveSize,
      price: input.price,
      currency: "AUD",
      onTap: input.onTap,
      inStock: input.inStock,
      notes: input.notes,
      now: nowIso(),
    });

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId: normalizeBeerId(beer.beerName),
      suburb: profile.suburb,
      metadata: { section: "beer_inventory", onTap: beer.onTap, inStock: beer.inStock, hasPrice: beer.price != null },
    });

    return { beer, message: "Beer row saved." };
  }

  deleteBarBeer(account: BusinessAccount, venueId: string, beerId: string) {
    const assignment = this.requireAssignedVenue(account, venueId);
    const deleted = this.repository.deleteBarBeer({ id: beerId, barId: venueId });
    if (!deleted) {
      throw new AppError("Beer row not found for this venue.", 404);
    }

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId,
      suburb: assignment?.suburb ?? null,
      metadata: { section: "beer_inventory", action: "delete" },
    });

    return { deleted: true, message: "Beer row removed." };
  }

  upsertBarHappyHour(account: BusinessAccount, venueId: string, input: BarHappyHourInput) {
    const assignment = this.requireAssignedVenue(account, venueId);
    const existing = input.id ? this.repository.getBarHappyHourById(input.id) : null;
    if (existing && existing.barId !== venueId) {
      throw new AppError("Happy-hour row belongs to another venue.", 403);
    }

    const profile = this.ensureBarProfile({
      barId: venueId,
      name: assignment?.venueName ?? this.repository.getBarProfile(venueId)?.name ?? venueId,
      suburb: assignment?.suburb ?? this.repository.getBarProfile(venueId)?.suburb ?? null,
    });
    const happyHour = this.repository.upsertBarHappyHour({
      id: input.id ?? crypto.randomUUID(),
      barId: venueId,
      title: input.title,
      daysOfWeek: input.daysOfWeek,
      startTime: input.startTime,
      endTime: input.endTime,
      description: input.description,
      active: input.active,
      now: nowIso(),
    });

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId: null,
      suburb: profile.suburb,
      metadata: { section: "happy_hours", active: happyHour.active, days: happyHour.daysOfWeek },
    });

    return { happyHour, message: "Happy hour saved." };
  }

  deleteBarHappyHour(account: BusinessAccount, venueId: string, happyHourId: string) {
    const assignment = this.requireAssignedVenue(account, venueId);
    const deleted = this.repository.deleteBarHappyHour({ id: happyHourId, barId: venueId });
    if (!deleted) {
      throw new AppError("Happy hour not found for this venue.", 404);
    }

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId: null,
      suburb: assignment?.suburb ?? null,
      metadata: { section: "happy_hours", action: "delete" },
    });

    return { deleted: true, message: "Happy hour removed." };
  }

  upsertBarSpecial(account: BusinessAccount, venueId: string, input: BarSpecialInput) {
    const assignment = this.requireAssignedVenue(account, venueId);
    const existing = input.id ? this.repository.getBarSpecialById(input.id) : null;
    if (existing && existing.barId !== venueId) {
      throw new AppError("Special belongs to another venue.", 403);
    }

    const profile = this.ensureBarProfile({
      barId: venueId,
      name: assignment?.venueName ?? this.repository.getBarProfile(venueId)?.name ?? venueId,
      suburb: assignment?.suburb ?? this.repository.getBarProfile(venueId)?.suburb ?? null,
    });
    const special = this.repository.upsertBarSpecial({
      id: input.id ?? crypto.randomUUID(),
      barId: venueId,
      title: input.title,
      description: input.description,
      price: input.price,
      discount: input.discount,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      scheduleNote: input.scheduleNote,
      exclusive: input.exclusive,
      active: input.active,
      now: nowIso(),
    });

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId: null,
      suburb: profile.suburb,
      metadata: { section: "specials", active: special.active, exclusive: special.exclusive, hasPrice: special.price != null },
    });

    return { special, message: "Deal or special saved." };
  }

  deleteBarSpecial(account: BusinessAccount, venueId: string, specialId: string) {
    const assignment = this.requireAssignedVenue(account, venueId);
    const deleted = this.repository.deleteBarSpecial({ id: specialId, barId: venueId });
    if (!deleted) {
      throw new AppError("Special not found for this venue.", 404);
    }

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId: null,
      suburb: assignment?.suburb ?? null,
      metadata: { section: "specials", action: "delete" },
    });

    return { deleted: true, message: "Deal or special removed." };
  }

  assignVenueManager(admin: BusinessAccount, input: VenueManagerAssignmentInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const user = this.repository.getAccountById(input.userId);
    if (!user) {
      throw new AppError("User account not found.", 404);
    }

    const assignment = this.repository.assignVenueManager({
      id: crypto.randomUUID(),
      userId: user.id,
      venueId: input.venueId,
      venueName: input.venueName,
      suburb: input.suburb,
      approvedBy: admin.id,
      now: nowIso(),
    });
    this.auditSecurity({
      actor: admin,
      action: "admin_venue_manager_assignment",
      targetType: "venue_manager_assignment",
      targetId: assignment.id,
      metadata: {
        managerUserId: assignment.userId,
        venueId: assignment.venueId,
        venueName: assignment.venueName,
      },
    });

    this.trackEvent(admin, {
      anonymousSessionId: null,
      eventType: "venue_manager_assigned",
      venueId: assignment.venueId,
      beerId: null,
      suburb: assignment.suburb,
      metadata: { managerUserId: assignment.userId, venueName: assignment.venueName },
    });

    return { assignment };
  }

  revokeVenueManager(admin: BusinessAccount, input: VenueManagerRevokeInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const assignment = this.repository.revokeVenueManager({
      userId: input.userId,
      venueId: input.venueId,
      now: nowIso(),
    });

    if (!assignment) {
      throw new AppError("Venue manager assignment not found.", 404);
    }
    this.auditSecurity({
      actor: admin,
      action: "admin_venue_manager_revoke",
      targetType: "venue_manager_assignment",
      targetId: assignment.id,
      metadata: {
        managerUserId: assignment.userId,
        venueId: assignment.venueId,
        venueName: assignment.venueName,
      },
    });

    this.trackEvent(admin, {
      anonymousSessionId: null,
      eventType: "venue_manager_revoked",
      venueId: assignment.venueId,
      beerId: null,
      suburb: assignment.suburb,
      metadata: { managerUserId: assignment.userId, venueName: assignment.venueName },
    });

    return { assignment };
  }

  getVenuePartnerAdmin(admin: BusinessAccount) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    return {
      interests: this.repository.listVenueInterestRequests(100),
      claimRequests: this.repository.listBarClaimRequests({ limit: 100 }),
      assignments: this.repository.listVenueManagerAssignments({ limit: 100 }),
      outreach: this.repository.listVenuePartnerOutreach(100),
      leads: this.repository.getPotentialPartnerLeads({
        staleBefore: daysAgoIso(90),
        limit: 25,
      }),
    };
  }

  updateVenueInterestStatus(admin: BusinessAccount, interestId: string, input: VenueInterestStatusInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const interest = this.repository.updateVenueInterestStatus({
      id: interestId,
      status: input.status,
      now: nowIso(),
    });

    if (!interest) {
      throw new AppError("Venue interest request not found.", 404);
    }
    this.auditSecurity({
      actor: admin,
      action: "admin_venue_interest_status_update",
      targetType: "venue_interest",
      targetId: interest.id,
      metadata: { status: interest.status, venueId: interest.venueId, venueName: interest.venueName },
    });

    this.trackEvent(admin, {
      anonymousSessionId: null,
      eventType: "outreach_status_updated",
      venueId: interest.venueId,
      beerId: null,
      suburb: null,
      metadata: { interestId: interest.id, status: interest.status },
    });

    return { interest };
  }

  upsertVenueOutreach(admin: BusinessAccount, input: VenueOutreachInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const outreach = this.repository.upsertVenuePartnerOutreach({
      id: crypto.randomUUID(),
      venueId: input.venueId,
      venueName: input.venueName,
      suburb: input.suburb,
      status: input.status,
      contactName: input.contactName,
      notes: input.notes,
      updatedBy: admin.id,
      now: nowIso(),
    });
    this.auditSecurity({
      actor: admin,
      action: "admin_venue_outreach_update",
      targetType: "venue",
      targetId: outreach.venueId,
      metadata: { status: outreach.status, venueName: outreach.venueName },
    });

    this.trackEvent(admin, {
      anonymousSessionId: null,
      eventType: "outreach_status_updated",
      venueId: outreach.venueId,
      beerId: null,
      suburb: outreach.suburb,
      metadata: { status: outreach.status },
    });

    return { outreach };
  }

  getAdminKpis(admin: BusinessAccount, query: AdminDashboardQuery) {
    if (admin.role !== "admin" && admin.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    const totalVenues = Math.max(this.repository.countKnownVenues(), this.repository.countMissions());
    const dashboard = this.repository.getAdminKpiDashboard({
      since: startOfAdminRange(query.range),
      sevenDaysAgo: daysAgoIso(7),
      thirtyDaysAgo: daysAgoIso(30),
      staleBefore: daysAgoIso(90),
      totalVenues,
    });
    return {
      ...dashboard,
      topSearchedBeers: this.applyAnalyticsThreshold(dashboard.topSearchedBeers),
      topSearchedSuburbs: this.applyAnalyticsThreshold(dashboard.topSearchedSuburbs),
      topClickedVenues: this.applyAnalyticsThreshold(dashboard.topClickedVenues),
      highDemandVenuesWithStaleOrMissingData: this.applyAnalyticsThreshold(
        dashboard.highDemandVenuesWithStaleOrMissingData,
      ),
      suppressedBelowCount: this.config.ANALYTICS_MIN_BUCKET_SIZE,
    };
  }

  getRetentionCohorts(admin: BusinessAccount, query: RetentionQuery) {
    if (admin.role !== "admin" && admin.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    return {
      groupBy: query.groupBy,
      cohorts: this.repository.getRetentionCohorts(query),
    };
  }

  getCoverageDashboard(admin: BusinessAccount) {
    if (admin.role !== "admin" && admin.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    const totalVenues = Math.max(this.repository.countKnownVenues(), this.repository.countMissions());
    return this.repository.getCoverageDashboard({
      staleBefore: daysAgoIso(90),
      totalVenues,
    });
  }

  getPotentialPartnerLeads(admin: BusinessAccount) {
    if (admin.role !== "admin" && admin.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    return {
      leads: this.repository.getPotentialPartnerLeads({
        staleBefore: daysAgoIso(90),
        limit: 20,
      }),
    };
  }

  getAdminQueues(admin: BusinessAccount) {
    if (admin.role !== "admin" && admin.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    return {
      feedback: this.repository.listFeedback(50),
      wrongPriceReports: this.repository.listWrongPriceReports(50),
      venueRequests: this.repository.listVenueRequests(50),
    };
  }

  createMissionFromRequest(admin: BusinessAccount, requestId: string) {
    if (admin.role !== "admin" && admin.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    const request = this.repository.getVenueRequestById(requestId);
    if (!request) {
      throw new AppError("Request not found.", 404);
    }

    const mission = this.createMission({
      venueId: request.venueId ?? `request:${request.id}`,
      venueName: request.venueName ?? request.beerName ?? "Requested venue",
      suburb: request.suburb,
      reason: request.requestType.replaceAll("_", " "),
      priority: "normal",
      points: request.requestType === "verify_beer_at_venue" ? 2 : 4,
      multiplier: 1,
      active: true,
    });
    const updatedRequest = this.repository.markVenueRequestMission({
      requestId: request.id,
      missionId: mission.id,
      now: nowIso(),
    });

    this.trackEvent(admin, {
      anonymousSessionId: null,
      eventType: "mission_created_from_request",
      venueId: mission.venueId,
      beerId: request.beerName ? normalizeBeerId(request.beerName) : null,
      suburb: request.suburb,
      metadata: { requestId: request.id, missionId: mission.id },
    });

    return { mission, request: updatedRequest };
  }

  async createCheckout(account: BusinessAccount, input: CheckoutInput) {
    if (!account.ageConfirmedAt) {
      throw new AppError("Please confirm you are 18+ before starting checkout.", 403);
    }

    const priceId = input.plan === "monthly" ? this.config.STRIPE_PRICE_MONTHLY : this.config.STRIPE_PRICE_YEARLY;
    const subscriptionStatus: SubscriptionStatus = input.plan === "monthly" ? "premium_monthly" : "premium_yearly";

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "checkout_started",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { plan: input.plan },
    });

    if (this.config.DEMO_BILLING_MODE) {
      return {
        mode: "demo",
        checkoutUrl: `/account.html?checkout=demo&plan=${input.plan}`,
        message: "Stripe is not configured, so this demo returns a simulated checkout URL.",
      };
    }

    if (!this.config.STRIPE_SECRET_KEY || !priceId) {
      throw new AppError("Stripe checkout is not configured for this plan.", 503);
    }

    const successUrl = new URL("/account.html?checkout=success", this.config.PUBLIC_BASE_URL).toString();
    const cancelUrl = new URL("/pricing.html?checkout=cancelled", this.config.PUBLIC_BASE_URL).toString();
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formEncode({
        mode: "subscription",
        success_url: successUrl,
        cancel_url: cancelUrl,
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        "metadata[user_id]": account.id,
        "metadata[subscription_status]": subscriptionStatus,
        customer_email: account.email,
      }),
    });

    const payload = (await response.json().catch(() => null)) as { url?: string; error?: { message?: string } } | null;

    if (!response.ok || !payload?.url) {
      throw new ExternalServiceError("Stripe checkout session failed", {
        status: response.status,
        message: payload?.error?.message,
      });
    }

    return {
      mode: "stripe",
      checkoutUrl: payload.url,
    };
  }

  async createBarTierCheckout(account: BusinessAccount, venueId: string, input: BarTierCheckoutInput) {
    this.requireVerifiedBarAccount(account);
    const assignment = this.requireAssignedVenue(account, venueId);
    const profile = this.ensureBarProfile({
      barId: venueId,
      name: assignment?.venueName ?? this.repository.getBarProfile(venueId)?.name ?? venueId,
      suburb: assignment?.suburb ?? this.repository.getBarProfile(venueId)?.suburb ?? null,
    });
    const priceId = input.tier === "plus" ? this.config.STRIPE_PLUS_PRICE_ID : this.config.STRIPE_PRO_PRICE_ID;
    const flags = tierFlags(input.tier);

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "checkout_started",
      venueId,
      beerId: null,
      suburb: profile.suburb,
      metadata: { billingContext: "bar", tier: input.tier },
    });

    if (this.config.DEMO_BILLING_MODE) {
      const updatedProfile = this.repository.updateBarSubscription({
        barId: venueId,
        membershipTier: input.tier,
        subscriptionStatus: "active_demo",
        now: nowIso(),
        ...flags,
      });
      this.auditSecurity({
        actor: account,
        action: "demo_subscription_grant",
        targetType: "bar",
        targetId: venueId,
        metadata: { tier: input.tier, mode: "demo" },
      });
      const tierCapabilities = getBarTierCapabilities(updatedProfile.membershipTier, this.isAdmin(account));
      return {
        mode: "demo",
        checkoutUrl: `/venue-portal?checkout=demo&tier=${input.tier}&venueId=${encodeURIComponent(venueId)}`,
        profile: updatedProfile,
        tier: {
          ...tierCapabilities,
          analyticsLocked: !tierCapabilities.analytics,
        },
        message: `${input.tier === "plus" ? "Plus" : "Pro"} demo tier activated for this bar.`,
      };
    }

    if (!this.config.STRIPE_SECRET_KEY || !priceId) {
      throw new AppError("Stripe checkout is not configured for this bar tier.", 503);
    }

    const successUrl = new URL(`/venue-portal?checkout=success&venueId=${encodeURIComponent(venueId)}`, this.config.PUBLIC_BASE_URL).toString();
    const cancelUrl = new URL(`/venue-portal?checkout=cancelled&venueId=${encodeURIComponent(venueId)}`, this.config.PUBLIC_BASE_URL).toString();
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formEncode({
        mode: "subscription",
        success_url: successUrl,
        cancel_url: cancelUrl,
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        "metadata[billing_context]": "bar",
        "metadata[user_id]": account.id,
        "metadata[bar_id]": venueId,
        "metadata[bar_membership_tier]": input.tier,
        customer_email: account.email,
      }),
    });

    const payload = (await response.json().catch(() => null)) as { url?: string; error?: { message?: string } } | null;

    if (!response.ok || !payload?.url) {
      throw new ExternalServiceError("Stripe bar tier checkout session failed", {
        status: response.status,
        message: payload?.error?.message,
      });
    }

    return {
      mode: "stripe",
      checkoutUrl: payload.url,
      message: "Stripe checkout created for this bar tier.",
    };
  }

  handleDemoSubscription(account: BusinessAccount, plan: "monthly" | "yearly") {
    if (!this.config.DEMO_BILLING_MODE) {
      throw new AppError("Demo billing is not enabled.", 503);
    }

    const now = nowIso();
    const status: SubscriptionStatus = plan === "monthly" ? "premium_monthly" : "premium_yearly";
    const updated = this.repository.updateSubscription({
      userId: account.id,
      subscriptionStatus: status,
      premiumUntil: null,
      now,
    });
    this.auditSecurity({
      actor: updated,
      action: "demo_subscription_grant",
      targetType: "account",
      targetId: updated.id,
      metadata: { plan, mode: "demo", subscriptionStatus: status },
    });
    this.trackEvent(updated, {
      anonymousSessionId: null,
      eventType: "subscription_created",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { plan, mode: "demo" },
    });
    return { account: sanitizeAccount(updated), access: this.getAccessState(updated, null) };
  }

  handleStripeWebhook(rawBody: Buffer | undefined, signature: string | undefined): { received: true } {
    if (!this.config.STRIPE_WEBHOOK_SECRET) {
      throw new AppError("Stripe webhook secret is not configured.", 503);
    }

    if (!rawBody || !signature) {
      this.auditSecurity({
        action: "stripe_webhook_signature_failed",
        targetType: "stripe_webhook",
        metadata: { reason: !rawBody ? "missing_raw_body" : "missing_signature" },
      });
      throw new AppError("Missing Stripe webhook signature.", 400);
    }

    let event: StripeEvent;
    try {
      event = this.verifyStripeWebhook(rawBody, signature);
    } catch (error) {
      this.auditSecurity({
        action: "stripe_webhook_signature_failed",
        targetType: "stripe_webhook",
        metadata: { reason: error instanceof Error ? error.message : "invalid_signature" },
      });
      throw error;
    }
    const inserted = this.repository.rememberStripeEvent({
      id: event.id,
      eventType: event.type,
      processedAt: nowIso(),
    });

    if (!inserted) {
      return { received: true };
    }

    this.applyStripeEvent(event);
    return { received: true };
  }

  private verifyStripeWebhook(rawBody: Buffer, signature: string): StripeEvent {
    const entries = Object.fromEntries(
      signature.split(",").map((part) => {
        const [key, value] = part.split("=");
        return [key, value];
      }),
    );
    const timestamp = entries.t;
    const signed = entries.v1;

    if (!timestamp || !signed) {
      throw new AppError("Invalid Stripe webhook signature.", 400);
    }

    if (!/^[a-f0-9]{64}$/i.test(signed)) {
      throw new AppError("Invalid Stripe webhook signature.", 401);
    }

    const expected = crypto
      .createHmac("sha256", this.config.STRIPE_WEBHOOK_SECRET!)
      .update(`${timestamp}.${rawBody.toString("utf8")}`)
      .digest("hex");

    if (
      expected.length !== signed.length ||
      !crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signed, "hex"))
    ) {
      throw new AppError("Invalid Stripe webhook signature.", 401);
    }

    return JSON.parse(rawBody.toString("utf8")) as StripeEvent;
  }

  private applyStripeEvent(event: StripeEvent): void {
    const object = event.data?.object;
    if (!object) {
      return;
    }

    if (event.type === "checkout.session.completed") {
      const metadata = object.metadata as Record<string, string> | undefined;
      const billingContext = metadata?.billing_context;
      const barId = metadata?.bar_id;
      const barMembershipTier = metadata?.bar_membership_tier as BarMembershipTier | undefined;
      const subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
      const userId = metadata?.user_id;
      const subscriptionStatus = metadata?.subscription_status as SubscriptionStatus | undefined;
      const customer = typeof object.customer === "string" ? object.customer : null;

      if (billingContext === "bar" && barId && (barMembershipTier === "plus" || barMembershipTier === "pro")) {
        const flags = tierFlags(barMembershipTier);
        this.repository.updateBarSubscription({
          barId,
          membershipTier: barMembershipTier,
          stripeCustomerId: customer,
          stripeSubscriptionId: subscriptionId,
          subscriptionStatus: "active",
          now: nowIso(),
          ...flags,
        });
        this.trackEvent(null, {
          anonymousSessionId: null,
          eventType: "subscription_created",
          venueId: barId,
          beerId: null,
          suburb: null,
          metadata: { mode: "stripe", billingContext: "bar", tier: barMembershipTier },
        });
        this.auditSecurity({
          action: "stripe_subscription_update",
          targetType: "bar",
          targetId: barId,
          metadata: { eventType: event.type, tier: barMembershipTier, status: "active" },
        });
        return;
      }

      if (userId && subscriptionStatus) {
        const updated = this.repository.updateSubscription({
          userId,
          subscriptionStatus,
          stripeCustomerId: customer,
          premiumUntil: null,
          now: nowIso(),
        });
        this.trackEvent(updated, {
          anonymousSessionId: null,
          eventType: "subscription_created",
          venueId: null,
          beerId: null,
          suburb: null,
          metadata: { mode: "stripe", subscriptionStatus },
        });
        this.auditSecurity({
          actor: updated,
          action: "stripe_subscription_update",
          targetType: "account",
          targetId: updated.id,
          metadata: { eventType: event.type, subscriptionStatus },
        });
      }
    }

    if (
      event.type === "customer.subscription.deleted" ||
      event.type === "customer.subscription.updated" ||
      event.type === "invoice.payment_failed"
    ) {
      const customer = typeof object.customer === "string" ? object.customer : null;
      const subscriptionId = typeof object.subscription === "string"
        ? object.subscription
        : typeof object.id === "string"
          ? object.id
          : null;
      const stripeStatus = typeof object.status === "string" ? object.status : null;
      const shouldDowngrade =
        event.type === "customer.subscription.deleted" ||
        event.type === "invoice.payment_failed" ||
        ["canceled", "cancelled", "past_due", "unpaid", "incomplete_expired"].includes(stripeStatus ?? "");
      const barProfile = subscriptionId ? this.repository.getBarProfileByStripeSubscriptionId(subscriptionId) : null;
      if (barProfile) {
        const nextTier = shouldDowngrade ? "basic" : barProfile.membershipTier;
        const flags = tierFlags(nextTier);
        this.repository.updateBarSubscription({
          barId: barProfile.barId,
          membershipTier: nextTier,
          stripeCustomerId: customer,
          stripeSubscriptionId: subscriptionId,
          subscriptionStatus: shouldDowngrade ? "cancelled_or_past_due" : stripeStatus ?? "active",
          now: nowIso(),
          ...flags,
        });
        this.trackEvent(null, {
          anonymousSessionId: null,
          eventType: "subscription_cancelled",
          venueId: barProfile.barId,
          beerId: null,
          suburb: barProfile.suburb,
          metadata: { mode: "stripe", billingContext: "bar" },
        });
        this.auditSecurity({
          action: shouldDowngrade ? "stripe_subscription_downgrade" : "stripe_subscription_update",
          targetType: "bar",
          targetId: barProfile.barId,
          metadata: { eventType: event.type, stripeStatus, shouldDowngrade },
        });
        return;
      }

      const account = customer ? this.repository.getAccountByStripeCustomerId(customer) : null;

      if (account) {
        const updated = this.repository.updateSubscription({
          userId: account.id,
          subscriptionStatus: shouldDowngrade ? "free" : account.subscriptionStatus,
          premiumUntil: null,
          now: nowIso(),
        });
        this.trackEvent(updated, {
          anonymousSessionId: null,
          eventType: "subscription_cancelled",
          venueId: null,
          beerId: null,
          suburb: null,
          metadata: { mode: "stripe" },
        });
        this.auditSecurity({
          actor: updated,
          action: shouldDowngrade ? "stripe_subscription_downgrade" : "stripe_subscription_update",
          targetType: "account",
          targetId: updated.id,
          metadata: { eventType: event.type, stripeStatus, shouldDowngrade },
        });
      }
    }
  }

  adminOverrideUser(admin: BusinessAccount, userId: string, input: { status: "active" | "warned" | "suspended"; trustScore?: number | undefined; fraudStrikeCount?: number | undefined }) {
    if (admin.role !== "admin" && admin.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    const account = this.repository.overrideUserStatus({
      userId,
      status: input.status,
      trustScore: input.trustScore,
      fraudStrikeCount: input.fraudStrikeCount,
      now: nowIso(),
    });
    this.auditSecurity({
      actor: admin,
      action: "admin_user_status_override",
      targetType: "account",
      targetId: userId,
      metadata: { status: input.status, fraudStrikeCount: input.fraudStrikeCount },
    });
    return {
      account: sanitizeAccount(account),
    };
  }

  logStartupSummary() {
    logger.info("Business demo service ready", {
      freePriceRevealsPerDay: this.config.FREE_PRICE_REVEALS_PER_DAY,
      contributorUnlockPoints: this.config.CONTRIBUTOR_UNLOCK_POINTS,
      demoBillingMode: this.config.DEMO_BILLING_MODE,
      fieldTestMode: this.config.FIELD_TEST_MODE,
    });
  }
}
