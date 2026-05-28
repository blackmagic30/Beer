import crypto from "node:crypto";
import { isIP } from "node:net";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { CONTRIBUTION_POINTS, PREMIUM_PRICING, SUBMISSION_LIMITS } from "../../config/business-rules.js";
import type { Env } from "../../config/env.js";
import {
  BusinessRepository,
  type AgeVerification,
  type BarPendingChange,
  type BarPendingChangeAction,
  type BarPendingChangeType,
  type BusinessAccount,
  type BarMembershipTier,
  type BarProfile,
  type BusinessMission,
  type BusinessSubmission,
  type BusinessSubmissionItem,
  type ConfidenceLabel,
  type FeedbackPriority,
  type PublicVenuePriceRecord,
  type ServingSize,
  type SourceEvidenceObject,
  type SubscriptionStatus,
} from "../../db/business.repository.js";
import { VIEWER_TRACKED_BEERS, canonicalizeTrackedBeerName, normalizeBeerSearchKey } from "../../constants/beers.js";
import { AppError, ExternalServiceError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { redactSecrets } from "../../lib/redact.js";

import type {
  AccountPreferencesInput,
  AccountPrivacySettingsInput,
  AdminDashboardQuery,
  AuthLoginInput,
  AuthSignupInput,
  AuthSupabaseSessionInput,
  BarBeerInput,
  BarClaimRequestInput,
  BarHappyHourInput,
  BarPendingChangeReviewInput,
  BarProfileInput,
  BarSpecialInput,
  BarTierCheckoutInput,
  CheckoutInput,
  CheckoutSessionInput,
  CreateSubmissionInput,
  EventTrackInput,
  FeedbackInput,
  LegalAcceptanceInput,
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
  VerificationInput,
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

interface MissionAreaLookup {
  latitude: number;
  longitude: number;
  label: string;
  source: "google_geocode" | "local_cache";
  confidence: "exact" | "approximate";
}

interface GoogleGeocodeResponse {
  status?: string;
  error_message?: string;
  results?: Array<{
    formatted_address?: string;
    geometry?: {
      location?: {
        lat?: number;
        lng?: number;
      };
      location_type?: string;
    };
  }>;
}

interface StripeEvent {
  id: string;
  type: string;
  data?: {
    object?: Record<string, unknown>;
  };
}

interface StripeCheckoutSession {
  id?: string;
  status?: string | null;
  payment_status?: string | null;
  customer?: string | { id?: string | null } | null;
  subscription?: string | { id?: string | null } | null;
  metadata?: Record<string, string> | null;
  error?: {
    message?: string;
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

function endOfMonthIso(baseIso: string): string {
  const date = new Date(baseIso);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999)).toISOString();
}

function monthKeyFromIso(value: string): string {
  return value.slice(0, 7);
}

function roundPoints(value: number): number {
  return Math.round(value * 10) / 10;
}

function distanceMetersBetween(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number },
): number {
  const radiusMeters = 6_371_000;
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const deltaLat = toRadians(second.latitude - first.latitude);
  const deltaLon = toRadians(second.longitude - first.longitude);
  const lat1 = toRadians(first.latitude);
  const lat2 = toRadians(second.latitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return radiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

function describeStripeCheckoutFailure(status: number, stripeMessage?: string | null): string {
  const message = stripeMessage?.trim() ?? "";
  const normalized = message.toLowerCase();

  if (status === 401 || normalized.includes("api key")) {
    return "Stripe rejected the secret key. Check STRIPE_SECRET_KEY and confirm it is from the same test/live mode as your Price IDs.";
  }

  if (
    normalized.includes("no such price") ||
    normalized.includes("price does not exist") ||
    normalized.includes("price id")
  ) {
    return "Stripe price ID was not found. Check STRIPE_PRICE_MONTHLY and STRIPE_PRICE_YEARLY in Railway, and make sure they match the same test/live mode as STRIPE_SECRET_KEY.";
  }

  if (normalized.includes("inactive") && normalized.includes("price")) {
    return "Stripe price is inactive. Activate the monthly/yearly Stripe Price or update Railway to use an active recurring Price ID.";
  }

  if (
    normalized.includes("recurring") ||
    normalized.includes("subscription") && normalized.includes("price")
  ) {
    return "Stripe checkout needs a recurring subscription Price. Use Stripe recurring monthly/yearly Price IDs, not one-time product prices.";
  }

  if (status === 403) {
    return "Stripe refused this request. Check that the Stripe key has permission to create Checkout Sessions.";
  }

  if (status >= 500) {
    return "Stripe is temporarily unavailable. Please try again shortly.";
  }

  return "Stripe checkout session failed. Check the Stripe Dashboard request log for the exact setup issue.";
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
    termsAcceptedAt: account.termsAcceptedAt,
    privacyAcceptedAt: account.privacyAcceptedAt,
    termsVersion: account.termsVersion,
    privacyVersion: account.privacyVersion,
    subscriptionStatus: account.subscriptionStatus,
    premiumUntil: account.premiumUntil,
    trustScore: account.trustScore,
    contributionPointsCurrentMonth: account.contributionPointsCurrentMonth,
    approvedSubmissionCount: account.approvedSubmissionCount,
    rejectedSubmissionCount: account.rejectedSubmissionCount,
    fraudStrikeCount: account.fraudStrikeCount,
    status: account.status,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    authProvider: account.authProvider,
    ageVerificationStatus: account.ageVerificationStatus,
    isOver18Verified: account.isOver18Verified,
    emailVerifiedAt: account.emailVerifiedAt,
    mfaLevel: account.mfaLevel,
    mfaVerifiedAt: account.mfaVerifiedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export function canAccessAgeGatedRewards(input: {
  account: Pick<BusinessAccount, "isOver18Verified" | "ageVerificationStatus"> | null;
  latestAgeVerification: Pick<AgeVerification, "status" | "isOver18" | "ageThreshold" | "expiresAt"> | null;
  now?: string | undefined;
}): boolean {
  if (!input.account || !input.account.isOver18Verified || input.account.ageVerificationStatus !== "verified") {
    return false;
  }

  const latest = input.latestAgeVerification;
  if (!latest || latest.status !== "verified" || !latest.isOver18 || latest.ageThreshold !== 18) {
    return false;
  }

  if (latest.expiresAt && new Date(latest.expiresAt).getTime() <= new Date(input.now ?? nowIso()).getTime()) {
    return false;
  }

  return true;
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
const PRIVATE_EVIDENCE_PREFIX = "private:evidence:";
const BLOCKED_SOURCE_URL_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

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

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const first = parts[0]!;
  const second = parts[1]!;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

function isBlockedSourcePhotoHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized || BLOCKED_SOURCE_URL_HOSTNAMES.has(normalized) || normalized.endsWith(".localhost")) {
    return true;
  }

  const ipType = isIP(normalized);
  if (ipType === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipType === 6) {
    return isPrivateIpv6(normalized);
  }

  return false;
}

function getBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function privateEvidenceRef(id: string): string {
  return `${PRIVATE_EVIDENCE_PREFIX}${id}`;
}

function getPrivateEvidenceId(value: string | null): string | null {
  return value?.startsWith(PRIVATE_EVIDENCE_PREFIX) ? value.slice(PRIVATE_EVIDENCE_PREFIX.length) : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split(".");
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getSupabaseEmailVerifiedAt(user: unknown): string | null {
  const record = user as Record<string, unknown>;
  const value = record.email_confirmed_at ?? record.confirmed_at;
  return typeof value === "string" && value ? value : null;
}

function getSupabaseMfaClaims(accessToken: string, now: string): { mfaLevel: string; mfaVerifiedAt: string | null } {
  const payload = decodeJwtPayload(accessToken);
  const aal = typeof payload?.aal === "string" ? payload.aal : "aal1";
  return {
    mfaLevel: aal,
    mfaVerifiedAt: aal === "aal2" ? now : null,
  };
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
  const isSpecial = record.displayKind === "special";

  return {
    ...record,
    beerName: isSpecial
      ? record.specialExclusive
        ? "Pint Path exclusive"
        : "Venue special"
      : record.beerName,
    price: null,
    happyHourDetails: null,
    happyHourTitle: null,
    happyHourDays: [],
    happyHourStartTime: null,
    happyHourEndTime: null,
    specialTitle: isSpecial
      ? record.specialExclusive
        ? "Pint Path exclusive"
        : "Venue special"
      : record.specialTitle ?? null,
    specialDescription: isSpecial ? null : record.specialDescription ?? null,
    specialDiscount: isSpecial ? null : record.specialDiscount ?? null,
    specialStartsAt: isSpecial ? null : record.specialStartsAt ?? null,
    specialEndsAt: isSpecial ? null : record.specialEndsAt ?? null,
    specialScheduleNote: isSpecial ? null : record.specialScheduleNote ?? null,
    sourceSubmissionId: null,
    priceRedacted: true,
  };
}

const FREE_PREVIEW_BEER_KEYS = new Set([
  "guinness",
  "carlton_draft",
  "stone_and_wood",
  "stone_and_wood_pacific_ale",
]);

function isHappyHourRecord(record: PublicVenuePriceRecord): boolean {
  return record.displayKind === "happy_hour" || record.isHappyHourPrice;
}

function isPintServing(record: PublicVenuePriceRecord): boolean {
  return normalizeBeerSearchKey(record.servingSize) === "pint";
}

function isFreePreviewBeerRecord(record: PublicVenuePriceRecord): boolean {
  const canonicalBeerKey = normalizeBeerSearchKey(canonicalizeTrackedBeerName(record.beerName));
  return isPintServing(record) && FREE_PREVIEW_BEER_KEYS.has(canonicalBeerKey);
}

function canFreeUserSeeRecord(record: PublicVenuePriceRecord): boolean {
  return isHappyHourRecord(record) || isFreePreviewBeerRecord(record);
}

function freePreviewPriceRecord(record: PublicVenuePriceRecord):
  | (PublicVenuePriceRecord & { freePreviewIncluded: true })
  | (PublicVenuePriceRecord & { priceRedacted: true }) {
  if (!canFreeUserSeeRecord(record)) {
    return redactPriceRecord(record);
  }

  return {
    ...record,
    sourceSubmissionId: null,
    freePreviewIncluded: true,
  };
}

function redactUserVisibleFreeText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const redacted = redactSecrets(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]")
    .replace(/(?:\+?61|0)[\s.-]?(?:\d[\s.-]?){8,10}\d/g, "[redacted phone]")
    .trim();

  return redacted.length > 0 ? redacted.slice(0, 500) : null;
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

function stripeObjectId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" && id.trim().length > 0 ? id : null;
  }

  return null;
}

function cleanStringList(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ).slice(0, 20);
}

function stringArrayFromUnknown(value: unknown): string[] {
  return Array.isArray(value)
    ? cleanStringList(value.filter((item): item is string => typeof item === "string"))
    : [];
}

function objectFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanFromUnknown(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
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
      | "REQUIRE_ADMIN_MFA_IN_PRODUCTION"
      | "ADMIN_MFA_MAX_AGE_MINUTES"
      | "REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION"
      | "ANALYTICS_MIN_BUCKET_SIZE"
      | "ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION"
      | "SOURCE_EVIDENCE_SIGNING_SECRET"
      | "SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS"
      | "NODE_ENV"
      | "STRIPE_SECRET_KEY"
      | "STRIPE_WEBHOOK_SECRET"
      | "STRIPE_PRICE_MONTHLY"
      | "STRIPE_PRICE_YEARLY"
      | "STRIPE_PLUS_PRICE_ID"
      | "STRIPE_PRO_PRICE_ID"
      | "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"
      | "SUPABASE_URL"
      | "SUPABASE_ANON_KEY"
      | "SUPABASE_SERVICE_ROLE_KEY"
      | "SUPABASE_OAUTH_PROVIDERS"
      | "ADMIN_EMAILS"
      | "GOOGLE_MAPS_API_KEY"
      | "GOOGLE_PLACES_API_KEY"
    >,
  ) {
    const supabaseServerKey = config.SUPABASE_SERVICE_ROLE_KEY ?? config.SUPABASE_ANON_KEY;
    if (config.SUPABASE_URL && supabaseServerKey) {
      this.supabase = createClient(config.SUPABASE_URL, supabaseServerKey, {
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

  private recordUserActivity(input: {
    account: BusinessAccount;
    eventType: string;
    relatedEntityType?: string | null | undefined;
    relatedEntityId?: string | null | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): void {
    try {
      this.repository.createUserActivityEvent({
        id: crypto.randomUUID(),
        userId: input.account.id,
        eventType: input.eventType,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        metadata: sanitizeEventMetadata(redactSecrets(input.metadata ?? {})),
        now: nowIso(),
      });
    } catch (error) {
      logger.warn("User activity write failed", {
        eventType: input.eventType,
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
      supabaseUrl: this.config.SUPABASE_URL ?? null,
      supabaseAnonKey: this.config.SUPABASE_ANON_KEY ?? null,
      supabaseOauthProviders: this.config.SUPABASE_OAUTH_PROVIDERS.split(",").map((provider) => provider.trim()).filter(Boolean),
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
    const adminEmails = this.getAdminEmailAllowlist();

    if (account.role !== "admin" && account.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    if (this.config.NODE_ENV === "production") {
      if (adminEmails.size === 0 || !adminEmails.has(normalizeEmail(account.email))) {
        this.auditSecurity({
          actor: account,
          action: "admin_allowlist_required",
          targetType: "account",
          targetId: account.id,
          metadata: { configured: adminEmails.size > 0 },
          context,
        });
        throw new AppError("Admin access is not configured.", 403);
      }

      this.requireVerifiedEmail(account, "Admin email verification is required in production.");

      if (this.config.REQUIRE_ADMIN_MFA_IN_PRODUCTION && !this.hasFreshAdminMfa(account)) {
        this.auditSecurity({
          actor: account,
          action: "admin_mfa_step_up_required",
          targetType: "account",
          targetId: account.id,
          metadata: { mfaLevel: account.mfaLevel },
          context,
        });
        throw new AppError("Admin MFA step-up required.", 403);
      }
    }

    return account;
  }

  private getAdminEmailAllowlist(): Set<string> {
    return new Set(
      (this.config.ADMIN_EMAILS ?? "")
        .split(",")
        .map((value) => normalizeEmail(value))
        .filter(Boolean),
    );
  }

  private requireVerifiedEmail(account: BusinessAccount, message = "Verify your email before continuing."): void {
    if (
      this.config.NODE_ENV === "production" &&
      this.config.REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION &&
      !account.emailVerifiedAt
    ) {
      throw new AppError(message, 403);
    }
  }

  private hasFreshAdminMfa(account: BusinessAccount): boolean {
    if (account.mfaLevel !== "aal2" || !account.mfaVerifiedAt) {
      return false;
    }

    const ageMs = Date.now() - new Date(account.mfaVerifiedAt).getTime();
    return ageMs >= 0 && ageMs <= this.config.ADMIN_MFA_MAX_AGE_MINUTES * 60_000;
  }

  private requireVerifiedBarAccount(account: BusinessAccount): void {
    if (account.status !== "active") {
      throw new AppError("Your account must be active to manage a bar.", 403);
    }

    this.requireVerifiedEmail(account, "Verify your email before managing a bar.");

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

  private sanitizeVenueManagerInsights(
    rawInsights: ReturnType<BusinessRepository["getVenueManagerInsights"]>,
    input: { includeAggregate: boolean; privacyThreshold: number },
  ) {
    const aggregateInsights = input.includeAggregate && rawInsights.aggregateInsights
      ? {
          ...rawInsights.aggregateInsights,
          topSearchedBeersNearby: rawInsights.aggregateInsights.topSearchedBeersNearby
            .filter((row) => row.count >= input.privacyThreshold),
          missingBeerSearches: rawInsights.aggregateInsights.missingBeerSearches
            .filter((row) => row.count >= input.privacyThreshold),
          suppressedBelowCount: input.privacyThreshold,
        }
      : null;

    return {
      ...rawInsights,
      wrongPriceReports: rawInsights.wrongPriceReports.map((report) => ({
        id: report.id,
        venueId: report.venueId,
        venueName: report.venueName,
        priceRecordId: report.priceRecordId,
        beerName: report.beerName,
        reason: report.reason,
        notes: redactUserVisibleFreeText(report.notes),
        hasSourcePhoto: Boolean(report.sourcePhotoUrl),
        status: report.status,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
      })),
      requests: rawInsights.requests.map((request) => ({
        id: request.id,
        requestType: request.requestType,
        venueId: request.venueId,
        venueName: request.venueName,
        beerName: request.beerName,
        suburb: request.suburb,
        notes: redactUserVisibleFreeText(request.notes),
        status: request.status,
        missionId: request.missionId,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      })),
      submissions: rawInsights.submissions.map((submission) => ({
        id: submission.id,
        venueId: submission.venueId,
        venueName: submission.venueName,
        suburb: submission.suburb,
        status: submission.status,
        submissionType: submission.submissionType,
        observedAt: submission.observedAt,
        hasSourcePhoto: Boolean(submission.sourcePhotoUrl),
        reviewedAt: submission.reviewedAt,
        createdAt: submission.createdAt,
        updatedAt: submission.updatedAt,
      })),
      aggregateInsights,
    };
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

  private createPendingBarChange(input: {
    account: BusinessAccount;
    venueId: string;
    changeType: BarPendingChangeType;
    action: BarPendingChangeAction;
    targetId: string | null;
    payload: Record<string, unknown>;
    suburb?: string | null | undefined;
  }) {
    const now = nowIso();
    const pendingChange = this.repository.createBarPendingChange({
      id: crypto.randomUUID(),
      barId: input.venueId,
      changeType: input.changeType,
      action: input.action,
      targetId: input.targetId,
      payload: input.payload,
      submittedBy: input.account.id,
      now,
    });

    this.trackEvent(input.account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId: input.venueId,
      beerId: input.changeType === "beer" ? normalizeBeerId(String(input.payload.beerName ?? input.targetId ?? "")) : null,
      suburb: input.suburb ?? null,
      metadata: {
        section: input.changeType,
        action: input.action,
        pendingChangeId: pendingChange.id,
      },
    });

    return {
      pendingChange,
      message: "Saved for admin review. It will not appear publicly until approved.",
    };
  }

  private applyApprovedBarChange(change: BarPendingChange, admin: BusinessAccount, now: string): void {
    if (change.action === "delete") {
      if (!change.targetId) {
        throw new AppError("Pending delete change is missing a target.", 409);
      }

      if (change.changeType === "beer") {
        this.repository.deleteBarBeer({ id: change.targetId, barId: change.barId });
        return;
      }

      if (change.changeType === "happy_hour") {
        this.repository.deleteBarHappyHour({ id: change.targetId, barId: change.barId });
        return;
      }

      if (change.changeType === "special") {
        this.repository.deleteBarSpecial({ id: change.targetId, barId: change.barId });
        return;
      }

      throw new AppError("Profile changes cannot be deleted through pending review.", 400);
    }

    if (change.changeType === "profile") {
      const existing = this.repository.getBarProfile(change.barId);
      const payload = change.payload;
      const membershipTier = existing?.membershipTier ?? "basic";
      const flags = tierFlags(membershipTier);
      this.repository.upsertBarProfile({
        barId: change.barId,
        name: stringOrNull(payload.name) ?? existing?.name ?? change.barId,
        address: stringOrNull(payload.address),
        suburb: stringOrNull(payload.suburb) ?? existing?.suburb ?? null,
        area: stringOrNull(payload.area) ?? stringOrNull(payload.suburb) ?? existing?.area ?? existing?.suburb ?? null,
        phone: stringOrNull(payload.phone),
        website: stringOrNull(payload.website),
        instagram: stringOrNull(payload.instagram),
        description: stringOrNull(payload.description),
        openingHours: objectFromUnknown(payload.openingHours),
        venueTags: stringArrayFromUnknown(payload.venueTags),
        membershipTier,
        tierManualOverride: existing?.tierManualOverride ?? false,
        active: booleanFromUnknown(payload.active, existing?.active ?? true),
        now,
        ...flags,
      });
      return;
    }

    if (change.changeType === "beer") {
      const payload = change.payload;
      const targetId = change.targetId ?? stringOrNull(payload.id) ?? crypto.randomUUID();
      this.ensureBarProfile({
        barId: change.barId,
        name: this.repository.getBarProfile(change.barId)?.name ?? change.barId,
        suburb: this.repository.getBarProfile(change.barId)?.suburb ?? null,
      });
      this.repository.upsertBarBeer({
        id: targetId,
        barId: change.barId,
        beerName: stringOrNull(payload.beerName) ?? "Unnamed beer",
        brewery: stringOrNull(payload.brewery),
        style: stringOrNull(payload.style),
        abv: numberOrNull(payload.abv),
        serveSize: stringOrNull(payload.serveSize) as ServingSize | null,
        price: numberOrNull(payload.price),
        currency: "AUD",
        onTap: booleanFromUnknown(payload.onTap, false),
        inStock: booleanFromUnknown(payload.inStock, true),
        notes: stringOrNull(payload.notes),
        now,
      });
      return;
    }

    if (change.changeType === "happy_hour") {
      const payload = change.payload;
      const targetId = change.targetId ?? stringOrNull(payload.id) ?? crypto.randomUUID();
      this.ensureBarProfile({
        barId: change.barId,
        name: this.repository.getBarProfile(change.barId)?.name ?? change.barId,
        suburb: this.repository.getBarProfile(change.barId)?.suburb ?? null,
      });
      this.repository.upsertBarHappyHour({
        id: targetId,
        barId: change.barId,
        title: stringOrNull(payload.title) ?? "Happy hour",
        daysOfWeek: stringArrayFromUnknown(payload.daysOfWeek),
        startTime: stringOrNull(payload.startTime) ?? "00:00",
        endTime: stringOrNull(payload.endTime) ?? "00:00",
        description: stringOrNull(payload.description) ?? "Details pending.",
        active: booleanFromUnknown(payload.active, true),
        now,
      });
      return;
    }

    if (change.changeType === "special") {
      const payload = change.payload;
      const targetId = change.targetId ?? stringOrNull(payload.id) ?? crypto.randomUUID();
      this.ensureBarProfile({
        barId: change.barId,
        name: this.repository.getBarProfile(change.barId)?.name ?? change.barId,
        suburb: this.repository.getBarProfile(change.barId)?.suburb ?? null,
      });
      this.repository.upsertBarSpecial({
        id: targetId,
        barId: change.barId,
        title: stringOrNull(payload.title) ?? "Venue special",
        description: stringOrNull(payload.description) ?? "Details pending.",
        price: numberOrNull(payload.price),
        discount: stringOrNull(payload.discount),
        startsAt: stringOrNull(payload.startsAt),
        endsAt: stringOrNull(payload.endsAt),
        scheduleNote: stringOrNull(payload.scheduleNote),
        exclusive: booleanFromUnknown(payload.exclusive, false),
        active: booleanFromUnknown(payload.active, true),
        now,
      });
      return;
    }

    this.auditSecurity({
      actor: admin,
      action: "admin_bar_pending_change_unknown_type",
      targetType: "bar_pending_change",
      targetId: change.id,
      metadata: { changeType: change.changeType },
    });
    throw new AppError("Unsupported pending bar change type.", 400);
  }

  signup(input: AuthSignupInput, context?: SessionRequestContext | undefined) {
    const email = normalizeEmail(input.email);

    if (this.repository.getAccountByEmail(email)) {
      throw new AppError("An account already exists for that email.", 409);
    }

    const now = nowIso();
    const adminEmails = this.getAdminEmailAllowlist();
    const account = this.repository.createAccount({
      id: crypto.randomUUID(),
      email,
      passwordHash: hashPassword(input.password),
      role: adminEmails.has(email) ? "admin" : "user",
      subscriptionStatus: adminEmails.has(email) ? "admin" : "free",
      termsAcceptedAt: now,
      privacyAcceptedAt: now,
      termsVersion: "2026-05-24",
      privacyVersion: "2026-05-24",
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
    this.recordUserActivity({
      account: confirmed,
      eventType: "user_signup",
      relatedEntityType: "account",
      relatedEntityId: confirmed.id,
      metadata: {
        authProvider: confirmed.authProvider,
        termsVersion: confirmed.termsVersion,
        privacyVersion: confirmed.privacyVersion,
      },
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
    this.recordUserActivity({
      account,
      eventType: "user_login",
      relatedEntityType: "account",
      relatedEntityId: account.id,
      metadata: { authProvider: account.authProvider },
    });
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

  async loginWithSupabaseAccessToken(input: AuthSupabaseSessionInput, context?: SessionRequestContext | undefined) {
    if (!this.supabase) {
      throw new AppError("Supabase authentication is not configured.", 503);
    }

    const { data, error } = await this.supabase.auth.getUser(input.accessToken);
    if (error || !data.user?.id || !data.user.email) {
      throw new AppError("Invalid Supabase session.", 401);
    }

    const supabaseUser = data.user;
    const supabaseEmail = supabaseUser.email;
    if (!supabaseEmail) {
      throw new AppError("Invalid Supabase session.", 401);
    }

    const email = normalizeEmail(supabaseEmail);
    const metadata = (supabaseUser.user_metadata ?? {}) as Record<string, unknown>;
    const displayName =
      typeof metadata.full_name === "string"
        ? metadata.full_name
        : typeof metadata.name === "string"
          ? metadata.name
          : null;
    const avatarUrl = typeof metadata.avatar_url === "string" ? metadata.avatar_url : null;

    let account = this.repository.getAccountBySupabaseUserId(supabaseUser.id) ?? this.repository.getAccountByEmail(email);
    const now = nowIso();
    const emailVerifiedAt = getSupabaseEmailVerifiedAt(supabaseUser);
    const mfaClaims = getSupabaseMfaClaims(input.accessToken, now);

    if (!account) {
      const adminEmails = this.getAdminEmailAllowlist();
      account = this.repository.createAccount({
        id: supabaseUser.id,
        email,
        passwordHash: "supabase-auth",
        displayName,
        avatarUrl,
        authProvider: "supabase",
        supabaseUserId: supabaseUser.id,
        emailVerifiedAt,
        mfaLevel: mfaClaims.mfaLevel,
        mfaVerifiedAt: mfaClaims.mfaVerifiedAt,
        termsAcceptedAt: metadata.terms_accepted === true ? now : null,
        privacyAcceptedAt: metadata.privacy_accepted === true ? now : null,
        termsVersion: typeof metadata.terms_version === "string" ? metadata.terms_version : null,
        privacyVersion: typeof metadata.privacy_version === "string" ? metadata.privacy_version : null,
        role: adminEmails.has(email) ? "admin" : "user",
        subscriptionStatus: adminEmails.has(email) ? "admin" : "free",
        now,
      });
      this.recordUserActivity({
        account,
        eventType: "user_signup",
        relatedEntityType: "account",
        relatedEntityId: account.id,
        metadata: { authProvider: "supabase" },
      });
    } else if (!account.supabaseUserId || account.authProvider !== "supabase" || account.displayName !== displayName || account.avatarUrl !== avatarUrl) {
      account = this.repository.linkSupabaseAccount({
        userId: account.id,
        supabaseUserId: supabaseUser.id,
        authProvider: "supabase",
        displayName,
        avatarUrl,
        emailVerifiedAt,
        mfaLevel: mfaClaims.mfaLevel,
        mfaVerifiedAt: mfaClaims.mfaVerifiedAt,
        now,
      });
    } else {
      account = this.repository.updateAccountSecurityClaims({
        userId: account.id,
        emailVerifiedAt,
        mfaLevel: mfaClaims.mfaLevel,
        mfaVerifiedAt: mfaClaims.mfaVerifiedAt,
        now,
      });
    }

    if (account.status === "suspended") {
      throw new AppError("Account access is suspended.", 403);
    }

    if (metadata.age_confirmed === true && !account.ageConfirmedAt) {
      account = this.repository.updateAgeConfirmed(account.id, now);
    }

    if ((metadata.terms_accepted === true || metadata.privacy_accepted === true) && (!account.termsAcceptedAt || !account.privacyAcceptedAt)) {
      account = this.repository.updateLegalAcceptance({
        userId: account.id,
        acceptedAt: now,
        termsVersion: typeof metadata.terms_version === "string" ? metadata.terms_version : "2026-05-24",
        privacyVersion: typeof metadata.privacy_version === "string" ? metadata.privacy_version : "2026-05-24",
      });
    }

    this.recordUserActivity({
      account,
      eventType: "user_login",
      relatedEntityType: "account",
      relatedEntityId: account.id,
      metadata: { authProvider: "supabase" },
    });
    this.auditSecurity({
      actor: account,
      action: "login_success",
      targetType: "account",
      targetId: account.id,
      metadata: { authProvider: "supabase", role: account.role },
      context,
    });

    return this.createSessionResponse(account, context);
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
    this.recordUserActivity({
      account: updated,
      eventType: "age_verification_started",
      relatedEntityType: "account",
      relatedEntityId: updated.id,
      metadata: { method: "self_attestation", ageThreshold: 18 },
    });
    return {
      account: sanitizeAccount(updated),
    };
  }

  acceptLegal(account: BusinessAccount, input: LegalAcceptanceInput) {
    const acceptedAt = nowIso();
    const updated = this.repository.updateLegalAcceptance({
      userId: account.id,
      acceptedAt,
      termsVersion: input.termsVersion,
      privacyVersion: input.privacyVersion,
    });
    this.recordUserActivity({
      account: updated,
      eventType: "legal_terms_accepted",
      relatedEntityType: "account",
      relatedEntityId: updated.id,
      metadata: {
        termsVersion: updated.termsVersion,
        privacyVersion: updated.privacyVersion,
      },
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
      canUseHappyHourActiveNow: true,
      canUseVerifiedOnly: hasFullAccess,
      canViewSpecialDiscounts: hasFullAccess,
      freePreviewScope: "Happy hours plus pint prices for Guinness, Carlton Draft, and Stone & Wood.",
      premiumScope: "Every verified beer price, premium filters, and venue special-discount details.",
      premiumUntil: account?.premiumUntil ?? null,
    };
  }

  getAccountDashboard(account: BusinessAccount) {
    const preferences = this.repository.getAccountPreferences(account.id);
    const privacySettings =
      this.repository.getAccountPrivacySettings(account.id) ??
      this.repository.getDefaultAccountPrivacySettings(account.id);
    const savedItems = this.repository.listSavedItems(account.id);
    const savedSuburbs = savedItems
      .filter((item) => item.itemType === "suburb")
      .map((item) => item.label);
    const suggestedSuburb = savedSuburbs[0] ?? preferences?.preferredSuburbs[0];
    const suggestedMissions = this.listMissions({ suburb: suggestedSuburb, sort: "saved", limit: 6 });
    const latestAgeVerification = this.repository.getLatestAgeVerification(account.id);
    const submissions = this.repository.listSubmissions({ userId: account.id, limit: 100 });
    const recentSubmissions = submissions.slice(0, 12).map((submission) => {
      const detail = this.repository.getSubmissionById(submission.id);
      return {
        id: submission.id,
        venueId: submission.venueId,
        venueName: submission.venueName,
        suburb: submission.suburb,
        status: submission.status,
        submissionType: submission.submissionType,
        observedAt: submission.observedAt,
        createdAt: submission.createdAt,
        reviewedAt: submission.reviewedAt,
        rejectionReason: submission.rejectionReason,
        pointsAwarded: submission.pointsAwarded,
        fraudFlagged: submission.fraudFlagged,
        hasEvidence: Boolean(submission.sourcePhotoUrl),
        verificationResult: submission.status === "approved"
          ? "verified"
          : submission.status === "needs_more_evidence"
            ? "needs more info"
            : submission.status,
        items: (detail?.items ?? []).map((item) => ({
          id: item.id,
          beerName: item.beerName,
          servingSize: item.servingSize,
          price: item.price,
          isHappyHourPrice: item.isHappyHourPrice,
          happyHourDetails: item.happyHourDetails,
          isOnTap: item.isOnTap,
        })),
      };
    });
    const pendingCount = submissions.filter((submission) => submission.status === "pending").length;
    const needsMoreInfoCount = submissions.filter((submission) => submission.status === "needs_more_evidence").length;
    const verifiedCount = submissions.filter((submission) => submission.status === "approved").length;
    const rejectedCount = submissions.filter((submission) =>
      ["rejected", "disputed", "fraud_flagged"].includes(submission.status),
    ).length;

    return {
      account: sanitizeAccount(account),
      profile: this.repository.getProfileById(account.id),
      access: this.getAccessState(account, null),
      submissions,
      recentSubmissions,
      dashboardStats: {
        totalUploads: submissions.length,
        pendingCount,
        pendingVerificationCount: pendingCount + needsMoreInfoCount,
        needsMoreInfoCount,
        verifiedCount,
        rejectedCount,
        fraudStrikes: account.fraudStrikeCount,
        pointsThisMonth: account.contributionPointsCurrentMonth,
        trustScore: account.trustScore,
      },
      verifications: this.repository.listVerificationsForUser(account.id, 100),
      activity: this.repository.listUserActivityEvents(account.id, 25),
      preferences: preferences ?? {
        userId: account.id,
        preferredSuburbs: [],
        preferredBeers: [],
        preferredUseCases: [],
        onboardingCompletedAt: null,
        createdAt: null,
        updatedAt: null,
      },
      privacySettings,
      savedItems,
      recentSearches: this.repository.listRecentSearches(account.id, 10),
      suggestedMissions,
      contributorProgress: {
        pointsThisMonth: roundPoints(account.contributionPointsCurrentMonth),
        unlockThreshold: this.config.CONTRIBUTOR_UNLOCK_POINTS,
        pointsNeeded: roundPoints(Math.max(0, this.config.CONTRIBUTOR_UNLOCK_POINTS - account.contributionPointsCurrentMonth)),
        unlockCopy: "Earn 15 approved points in a month to unlock premium until the end of that month.",
      },
      rewards: {
        status: "coming_soon",
        eligiblePlaceholder: canAccessAgeGatedRewards({ account, latestAgeVerification }),
        ageGatedEligible: canAccessAgeGatedRewards({ account, latestAgeVerification }),
        ageThreshold: 18,
      },
      ageVerification: {
        latest: latestAgeVerification,
        status: account.ageVerificationStatus,
        isOver18Verified: account.isOver18Verified,
        copy: "18+ verification will be required for some future rewards. Pint Path does not store raw ID documents.",
      },
    };
  }

  exportAccountData(account: BusinessAccount) {
    const preferences = this.repository.getAccountPreferences(account.id);
    const privacySettings =
      this.repository.getAccountPrivacySettings(account.id) ??
      this.repository.getDefaultAccountPrivacySettings(account.id);
    const submissions = this.repository.listSubmissions({ userId: account.id, limit: 1000 }).map((submission) => {
      const detail = this.repository.getSubmissionById(submission.id);
      return {
        id: submission.id,
        venueId: submission.venueId,
        venueName: submission.venueName,
        suburb: submission.suburb,
        status: submission.status,
        submissionType: submission.submissionType,
        observedAt: submission.observedAt,
        notes: submission.notes,
        pointsAwarded: submission.pointsAwarded,
        pointsEligibleByLocation: submission.pointsEligibleByLocation,
        pointsEligibilityReason: submission.pointsEligibilityReason,
        distanceToVenueMeters: submission.distanceToVenueMeters,
        uploadLocationCapturedAt: submission.uploadLocationCapturedAt,
        uploadAccuracyMeters: submission.uploadAccuracyMeters,
        hasPrivateEvidence: Boolean(submission.sourcePhotoUrl),
        reviewedAt: submission.reviewedAt,
        rejectionReason: submission.rejectionReason,
        fraudFlagged: submission.fraudFlagged,
        createdAt: submission.createdAt,
        updatedAt: submission.updatedAt,
        items: (detail?.items ?? []).map((item) => ({
          id: item.id,
          beerName: item.beerName,
          servingSize: item.servingSize,
          price: item.price,
          isHappyHourPrice: item.isHappyHourPrice,
          happyHourDetails: item.happyHourDetails,
          isOnTap: item.isOnTap,
          confidence: item.confidence,
          createdAt: item.createdAt,
        })),
      };
    });

    this.recordUserActivity({
      account,
      eventType: "account_data_exported",
      relatedEntityType: "account",
      relatedEntityId: account.id,
      metadata: { format: "json", submissionCount: submissions.length },
    });
    this.auditSecurity({
      actor: account,
      action: "account_data_exported",
      targetType: "account",
      targetId: account.id,
      metadata: { submissionCount: submissions.length },
    });

    return {
      exportedAt: nowIso(),
      exportFormat: "pint_path_account_export_v1",
      note: "Private evidence files, raw photo data, raw tokens, passwords, and exact stored upload coordinates are not included in this quick self-service export.",
      account: sanitizeAccount(account),
      profile: this.repository.getProfileById(account.id),
      privacySettings,
      preferences: preferences ?? null,
      savedItems: this.repository.listSavedItems(account.id),
      recentSearches: this.repository.listRecentSearches(account.id, 100),
      submissions,
      verifications: this.repository.listVerificationsForUser(account.id, 1000),
      activity: this.repository.listUserActivityEvents(account.id, 1000),
      ageVerification: {
        latest: this.repository.getLatestAgeVerification(account.id),
        status: account.ageVerificationStatus,
        isOver18Verified: account.isOver18Verified,
      },
    };
  }

  private getSubmissionLocationEligibility(input: CreateSubmissionInput): {
    uploadLatitude: number | null;
    uploadLongitude: number | null;
    uploadAccuracyMeters: number | null;
    uploadLocationCapturedAt: string | null;
    distanceToVenueMeters: number | null;
    pointsEligibleByLocation: boolean;
    pointsEligibilityReason: string;
  } {
    if (!input.uploadLocation) {
      return {
        uploadLatitude: null,
        uploadLongitude: null,
        uploadAccuracyMeters: null,
        uploadLocationCapturedAt: null,
        distanceToVenueMeters: null,
        pointsEligibleByLocation: false,
        pointsEligibilityReason: "location_missing",
      };
    }

    const venueLocation = this.repository.getVenueLocationCache(input.venueId);
    const uploadLatitude = input.uploadLocation.latitude;
    const uploadLongitude = input.uploadLocation.longitude;

    if (
      !venueLocation ||
      venueLocation.latitude == null ||
      venueLocation.longitude == null
    ) {
      return {
        uploadLatitude,
        uploadLongitude,
        uploadAccuracyMeters: input.uploadLocation.accuracyMeters,
        uploadLocationCapturedAt: input.uploadLocation.capturedAt,
        distanceToVenueMeters: null,
        pointsEligibleByLocation: false,
        pointsEligibilityReason: "venue_location_unavailable",
      };
    }

    const distanceToVenueMeters = Math.round(distanceMetersBetween(
      { latitude: uploadLatitude, longitude: uploadLongitude },
      { latitude: venueLocation.latitude, longitude: venueLocation.longitude },
    ));
    const pointsEligibleByLocation = distanceToVenueMeters <= CONTRIBUTION_POINTS.locationRadiusMeters;

    return {
      uploadLatitude,
      uploadLongitude,
      uploadAccuracyMeters: input.uploadLocation.accuracyMeters,
      uploadLocationCapturedAt: input.uploadLocation.capturedAt,
      distanceToVenueMeters,
      pointsEligibleByLocation,
      pointsEligibilityReason: pointsEligibleByLocation ? "within_200m" : "outside_200m",
    };
  }

  createSubmission(account: BusinessAccount, input: CreateSubmissionInput) {
    if (account.status === "suspended") {
      throw new AppError("Suspended accounts cannot submit reward-eligible data.", 403);
    }

    this.requireVerifiedEmail(account, "Verify your email before uploading venue data.");

    if (!account.ageConfirmedAt) {
      throw new AppError("Please confirm you are 18+ before submitting venue data.", 403);
    }

    const sourcePhotoUrl = this.resolveSourcePhoto(account, input);
    const now = nowIso();
    const locationEligibility = this.getSubmissionLocationEligibility(input);
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
      ...locationEligibility,
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
        pointsEligibleByLocation: submission.pointsEligibleByLocation,
      },
    });
    this.recordUserActivity({
      account,
      eventType: "data_upload_created",
      relatedEntityType: "submission",
      relatedEntityId: submission.id,
      metadata: {
        submissionType: submission.submissionType,
        venueId: submission.venueId,
        itemCount: input.items.length,
        pointsEligibleByLocation: submission.pointsEligibleByLocation,
      },
    });

    return {
      submission,
      statusCopy: submission.pointsEligibleByLocation
        ? "Submitted for review. If approved, this can earn points toward this month's contributor unlock."
        : "Submitted for review. Points need a saved upload location within 200m of the venue.",
      ocrStatus: sourcePhotoUrl ? "queued_for_review" : "not_requested",
    };
  }

  private resolveSourcePhoto(
    account: Pick<BusinessAccount, "id"> | null,
    input: Pick<CreateSubmissionInput, "sourcePhotoDataUrl" | "sourcePhotoUrl">,
  ): string | null {
    if (input.sourcePhotoDataUrl) {
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

      const evidence = this.repository.createSourceEvidenceObject({
        id: crypto.randomUUID(),
        ownerUserId: account?.id ?? null,
        storageProvider: "sqlite_private",
        objectPath: `evidence/${crypto.randomUUID()}`,
        mimeType,
        byteSize: bytes.length,
        dataBase64: bytes.toString("base64"),
        externalUrl: null,
        createdAt: nowIso(),
      });
      return privateEvidenceRef(evidence.id);
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

    if (isBlockedSourcePhotoHost(parsed.hostname)) {
      throw new AppError("Source photo URL must not target local, private, or metadata network hosts.", 400);
    }

    if (BLOCKED_SOURCE_URL_EXTENSIONS.test(parsed.pathname)) {
      throw new AppError("Source photo URL must point to a safe image source, not HTML, SVG, script, or style content.", 400);
    }

    const evidence = this.repository.createSourceEvidenceObject({
      id: crypto.randomUUID(),
      ownerUserId: account?.id ?? null,
      storageProvider: "external_private_reference",
      objectPath: `external/${crypto.randomUUID()}`,
      mimeType: null,
      byteSize: null,
      dataBase64: null,
      externalUrl: parsed.toString(),
      createdAt: nowIso(),
    });
    return privateEvidenceRef(evidence.id);
  }

  private getEvidenceSigningSecret(): string {
    if (this.config.SOURCE_EVIDENCE_SIGNING_SECRET) {
      return this.config.SOURCE_EVIDENCE_SIGNING_SECRET;
    }

    if (this.config.NODE_ENV === "production") {
      throw new AppError("Source evidence signing is not configured.", 503);
    }

    return "development-source-evidence-signing-secret";
  }

  private signEvidenceUrl(evidenceId: string, expiresAt: number): string {
    return crypto
      .createHmac("sha256", this.getEvidenceSigningSecret())
      .update(`${evidenceId}.${expiresAt}`)
      .digest("hex");
  }

  getSubmissionSourceEvidenceUrl(account: BusinessAccount, submissionId: string) {
    const submission = this.repository.getSubmissionById(submissionId);
    if (!submission) {
      throw new AppError("Submission not found.", 404);
    }

    if (!this.isAdmin(account) && submission.submission.userId !== account.id) {
      throw new AppError("You can only access your own source evidence.", 403);
    }

    const evidenceId = getPrivateEvidenceId(submission.submission.sourcePhotoUrl);
    if (!evidenceId) {
      return { signedUrl: null, expiresAt: null };
    }

    const evidence = this.repository.getSourceEvidenceObject(evidenceId);
    if (!evidence) {
      throw new AppError("Source evidence not found.", 404);
    }

    const expiresAt = Math.floor(Date.now() / 1000) + this.config.SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS;
    const signature = this.signEvidenceUrl(evidence.id, expiresAt);
    const signedUrl = new URL(`/api/business/source-evidence/${encodeURIComponent(evidence.id)}`, this.config.PUBLIC_BASE_URL);
    signedUrl.searchParams.set("expires", String(expiresAt));
    signedUrl.searchParams.set("signature", signature);

    this.auditSecurity({
      actor: account,
      action: "source_evidence_signed_url_created",
      targetType: "source_evidence",
      targetId: evidence.id,
      metadata: { submissionId },
    });

    return {
      signedUrl: signedUrl.toString(),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }

  getSourceEvidenceForSignedRequest(input: {
    evidenceId: string;
    expires: string | undefined;
    signature: string | undefined;
  }): SourceEvidenceObject {
    const expiresAt = Number(input.expires);
    if (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new AppError("Source evidence link has expired.", 403);
    }

    if (!input.signature || !/^[a-f0-9]{64}$/i.test(input.signature)) {
      throw new AppError("Invalid source evidence signature.", 403);
    }

    const expected = this.signEvidenceUrl(input.evidenceId, expiresAt);
    if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(input.signature, "hex"))) {
      throw new AppError("Invalid source evidence signature.", 403);
    }

    const evidence = this.repository.getSourceEvidenceObject(input.evidenceId);
    if (!evidence) {
      throw new AppError("Source evidence not found.", 404);
    }

    return evidence;
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

  savePrivacySettings(account: BusinessAccount, input: AccountPrivacySettingsInput) {
    const now = nowIso();
    const privacySettings = this.repository.upsertAccountPrivacySettings({
      userId: account.id,
      optionalAnalyticsEnabled: input.optionalAnalyticsEnabled,
      venueReportInclusionEnabled: input.venueReportInclusionEnabled,
      productResearchEnabled: input.productResearchEnabled,
      emailUpdatesEnabled: input.emailUpdatesEnabled,
      now,
    });
    this.recordUserActivity({
      account,
      eventType: "account_privacy_settings_updated",
      relatedEntityType: "account",
      relatedEntityId: account.id,
      metadata: {
        optionalAnalyticsEnabled: privacySettings.optionalAnalyticsEnabled,
        venueReportInclusionEnabled: privacySettings.venueReportInclusionEnabled,
        productResearchEnabled: privacySettings.productResearchEnabled,
        emailUpdatesEnabled: privacySettings.emailUpdatesEnabled,
      },
    });

    return { privacySettings };
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

  private classifyFeedback(input: FeedbackInput): {
    priority: FeedbackPriority;
    triageReason: string;
  } {
    switch (input.feedbackType) {
      case "security_report":
      case "account_deletion_request":
        return {
          priority: "high",
          triageReason: "Sensitive account/security request requires priority admin review.",
        };
      case "privacy_request":
      case "data_export_request":
      case "abuse_report":
      case "moderation_appeal":
      case "billing_support":
        return {
          priority: "medium",
          triageReason: "Privacy, billing, abuse, or moderation workflow needs tracked follow-up.",
        };
      case "wrong_data":
      case "venue_suggestion":
        return {
          priority: "normal",
          triageReason: "Product/data quality feedback for normal triage.",
        };
      default:
        return {
          priority: "low",
          triageReason: "General product feedback.",
        };
    }
  }

  submitFeedback(account: BusinessAccount | null, input: FeedbackInput) {
    const now = nowIso();
    const triage = this.classifyFeedback(input);
    const feedback = this.repository.createFeedback({
      id: crypto.randomUUID(),
      userId: account?.id ?? null,
      anonymousSessionId: input.anonymousSessionId,
      feedbackType: input.feedbackType,
      message: input.message,
      venueId: input.venueId,
      venueName: input.venueName,
      priority: triage.priority,
      triageReason: triage.triageReason,
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

    if (["security_report", "privacy_request", "data_export_request", "account_deletion_request"].includes(input.feedbackType)) {
      this.auditSecurity({
        actor: account,
        action: `feedback_${input.feedbackType}`,
        targetType: "feedback",
        targetId: feedback.id,
        metadata: {
          feedbackType: input.feedbackType,
          priority: feedback.priority,
          venueId: input.venueId,
        },
      });
    }

    return {
      feedback,
      message: "Thanks. Feedback is saved for admin review.",
    };
  }

  requestAccountDeletion(account: BusinessAccount, input: { message?: string | null | undefined }) {
    const message = [
      "Account deletion request from signed-in account.",
      input.message ? `User note: ${input.message}` : null,
      "Admin must verify ownership, retain legally required moderation/billing/security records, and confirm deletion manually.",
    ].filter(Boolean).join("\n\n");

    const result = this.submitFeedback(account, {
      anonymousSessionId: null,
      feedbackType: "account_deletion_request",
      message,
      venueId: null,
      venueName: null,
    });

    this.recordUserActivity({
      account,
      eventType: "account_deletion_requested",
      relatedEntityType: "feedback",
      relatedEntityId: result.feedback.id,
      metadata: { requestType: "account_deletion_request" },
    });

    return {
      ...result,
      message: "Deletion request saved. An admin will review retention requirements before removing account data.",
    };
  }

  reportWrongPrice(account: BusinessAccount | null, input: WrongPriceReportInput) {
    const now = nowIso();
    const sourcePhotoUrl = this.resolveSourcePhoto(account, input);
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

  verifySubmission(account: BusinessAccount, submissionId: string, input: VerificationInput) {
    if (account.status === "suspended") {
      throw new AppError("Suspended accounts cannot verify venue data.", 403);
    }

    this.requireVerifiedEmail(account, "Verify your email before verifying venue data.");

    const submission = this.repository.getSubmissionById(submissionId);
    if (!submission) {
      throw new AppError("Submission not found.", 404);
    }

    if (submission.submission.userId === account.id) {
      throw new AppError("You cannot verify your own upload.", 403);
    }

    if (submission.submission.status !== "pending" && submission.submission.status !== "needs_more_evidence") {
      throw new AppError("Only pending submissions can be community verified.", 409);
    }

    if (this.repository.getVerificationByUserAndUpload({ verifierUserId: account.id, uploadId: submissionId })) {
      throw new AppError("You have already verified this upload.", 409);
    }

    const verification = this.repository.createVerification({
      id: crypto.randomUUID(),
      verifierUserId: account.id,
      uploadId: submissionId,
      targetEntityType: "submission",
      targetEntityId: submissionId,
      result: input.result,
      notes: input.notes,
      now: nowIso(),
    });

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "data_verified",
      venueId: submission.submission.venueId,
      beerId: submission.items[0]?.normalizedBeerId ?? null,
      suburb: submission.submission.suburb,
      metadata: {
        verificationId: verification.id,
        submissionId,
        result: input.result,
      },
    });
    this.recordUserActivity({
      account,
      eventType: "data_verified",
      relatedEntityType: "submission",
      relatedEntityId: submissionId,
      metadata: {
        verificationId: verification.id,
        result: input.result,
        venueId: submission.submission.venueId,
      },
    });

    return {
      verification,
      message: "Verification saved. Community confirmations help improve data confidence.",
    };
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

    const suggestedPoints = this.calculatePoints(submission.submission, submission.items);
    const requestedPoints = input.pointsAwarded ?? suggestedPoints;
    const points = submission.submission.pointsEligibleByLocation
      ? roundPoints(Math.min(requestedPoints, suggestedPoints))
      : 0;
    const reviewedAt = nowIso();
    const result = this.repository.reviewSubmission({
      submissionId,
      reviewerId: admin.id,
      status: input.status,
      rejectionReason: input.rejectionReason,
      fraudFlagged: input.fraudFlagged || input.status === "fraud_flagged",
      pointsAwarded: input.status === "approved" ? points : 0,
      confidence: input.confidence,
      now: reviewedAt,
      monthKey: monthKeyFromIso(submission.submission.observedAt),
      premiumUntil: endOfMonthIso(reviewedAt),
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
        suggestedPoints,
        pointsEligibilityReason: submission.submission.pointsEligibilityReason,
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
        suggestedPoints,
        pointsEligibilityReason: result.submission.pointsEligibilityReason,
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
    const freshnessPoints = this.calculateFreshnessPoints(this.repository.getLatestVenueDataTimestamp(submission.venueId));
    const includesNewDrink = items.some((item) => !this.repository.venueHasPublishedBeerRecord({
      venueId: submission.venueId,
      beerName: item.beerName,
      normalizedBeerId: item.normalizedBeerId,
    }));

    return includesNewDrink ? Math.max(freshnessPoints, CONTRIBUTION_POINTS.newVenue) : freshnessPoints;
  }

  private calculateFreshnessPoints(lastVerifiedAt: string | null): number {
    if (!lastVerifiedAt) {
      return CONTRIBUTION_POINTS.newVenue;
    }

    const ageMs = Date.now() - new Date(lastVerifiedAt).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours <= CONTRIBUTION_POINTS.veryFreshHours) {
      return CONTRIBUTION_POINTS.veryFreshUpdate;
    }

    const ageDays = ageHours / 24;
    if (ageDays <= CONTRIBUTION_POINTS.weekOldDays) {
      return CONTRIBUTION_POINTS.weekOldUpdate;
    }

    return CONTRIBUTION_POINTS.staleUpdate;
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

    const venues = (data ?? []) as VenueRow[];
    const now = nowIso();
    venues.forEach((venue) => {
      this.repository.upsertVenueLocationCache({
        venueId: venue.id,
        venueName: venue.name,
        suburb: venue.suburb,
        latitude: venue.latitude,
        longitude: venue.longitude,
        now,
      });
    });

    return venues;
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

  private missionFreshnessLabel(lastVerifiedAt: string | null): string {
    if (!lastVerifiedAt) {
      return "No approved data yet";
    }

    const ageMs = Date.now() - new Date(lastVerifiedAt).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours <= CONTRIBUTION_POINTS.veryFreshHours) {
      return "Updated in the last 24 hours";
    }

    const ageDays = ageHours / 24;
    if (ageDays <= CONTRIBUTION_POINTS.weekOldDays) {
      return "Updated this week";
    }

    return "Stale for 7+ days";
  }

  private missionDynamicPoints(mission: Pick<BusinessMission, "lastVerifiedAt" | "reason">): number {
    const freshnessPoints = this.calculateFreshnessPoints(mission.lastVerifiedAt);
    const reason = mission.reason.toLowerCase();
    const isNewHighValueWork = !mission.lastVerifiedAt
      || reason.includes("no data")
      || reason.includes("no prices")
      || reason.includes("new venue")
      || /(?:new|missing).*(?:beer|drink|price)/i.test(reason);

    return isNewHighValueWork
      ? Math.max(freshnessPoints, CONTRIBUTION_POINTS.newVenue)
      : freshnessPoints;
  }

  async resolveMissionArea(query: string): Promise<{
    location: MissionAreaLookup | null;
    message: string;
  }> {
    const normalizedQuery = query.trim().replace(/\s+/g, " ");
    if (normalizedQuery.length < 2) {
      throw new AppError("Enter a suburb, street, or venue to find nearby missions.", 400);
    }

    const googleLocation = await this.resolveMissionAreaWithGoogle(normalizedQuery);
    if (googleLocation) {
      return {
        location: googleLocation,
        message: `Showing missions near ${googleLocation.label}.`,
      };
    }

    const cachedLocation = this.resolveMissionAreaFromLocalCache(normalizedQuery);
    if (cachedLocation) {
      return {
        location: cachedLocation,
        message: `Showing missions near ${cachedLocation.label}.`,
      };
    }

    return {
      location: null,
      message: "We could not find that Melbourne area yet. Try a nearby suburb, street, or venue name.",
    };
  }

  private async resolveMissionAreaWithGoogle(query: string): Promise<MissionAreaLookup | null> {
    const apiKey = this.config.GOOGLE_PLACES_API_KEY ?? this.config.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return null;
    }

    const address = /(?:melbourne|victoria|\bvic\b|australia)/i.test(query)
      ? query
      : `${query}, Melbourne VIC, Australia`;
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    url.searchParams.set("components", "country:AU|administrative_area:VIC");
    url.searchParams.set("bounds", "-38.5,144.3|-37.4,145.6");
    url.searchParams.set("key", apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }

      const body = await response.json() as GoogleGeocodeResponse;
      const result = body.results?.find((candidate) => {
        const latitude = candidate.geometry?.location?.lat;
        const longitude = candidate.geometry?.location?.lng;
        return typeof latitude === "number" && typeof longitude === "number";
      });

      if (!result) {
        if (body.status && body.status !== "ZERO_RESULTS") {
          logger.warn("Google geocode lookup did not return a usable result", {
            status: body.status,
            error: body.error_message ? redactSecrets(body.error_message) : undefined,
          });
        }
        return null;
      }

      const latitude = result.geometry!.location!.lat!;
      const longitude = result.geometry!.location!.lng!;
      return {
        latitude,
        longitude,
        label: result.formatted_address?.replace(/,\s*Australia$/i, "") ?? query,
        source: "google_geocode",
        confidence: result.geometry?.location_type === "ROOFTOP" ? "exact" : "approximate",
      };
    } catch (error) {
      logger.warn("Google geocode lookup failed; falling back to cached venue locations", {
        error: error instanceof Error ? redactSecrets(error.message) : "unknown",
      });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveMissionAreaFromLocalCache(query: string): MissionAreaLookup | null {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);
    if (!terms.length) {
      return null;
    }

    const matches = this.repository
      .listMissions({ activeOnly: true, suburb: undefined, limit: 500 })
      .map((mission) => {
        const profile = this.repository.getBarProfile(mission.venueId);
        const location = this.repository.getVenueLocationCache(mission.venueId);
        return {
          mission,
          profile,
          location,
          searchable: [mission.venueName, mission.suburb, mission.reason, profile?.address, profile?.suburb]
            .filter(Boolean)
            .join(" ")
            .toLowerCase(),
        };
      })
      .filter((entry) =>
        typeof entry.location?.latitude === "number" &&
        typeof entry.location?.longitude === "number" &&
        terms.every((term) => entry.searchable.includes(term)),
      );

    if (!matches.length) {
      return null;
    }

    const bestMatches = matches.slice(0, 20);
    const latitude = bestMatches.reduce((sum, entry) => sum + entry.location!.latitude!, 0) / bestMatches.length;
    const longitude = bestMatches.reduce((sum, entry) => sum + entry.location!.longitude!, 0) / bestMatches.length;
    const first = bestMatches[0]!;
    const suburb = first.profile?.suburb ?? first.mission.suburb;
    const label = matches.length === 1
      ? [first.mission.venueName, suburb].filter(Boolean).join(", ")
      : suburb ?? query;

    return {
      latitude,
      longitude,
      label,
      source: "local_cache",
      confidence: matches.length === 1 ? "exact" : "approximate",
    };
  }

  listMissions(query: {
    suburb?: string | undefined;
    q?: string | undefined;
    latitude?: number | undefined;
    longitude?: number | undefined;
    radiusKm?: number | undefined;
    sort?: string | undefined;
    limit: number;
  }): BusinessMission[] {
    this.seedDemoMissions();
    const hasLocation = typeof query.latitude === "number" && typeof query.longitude === "number";
    const radiusMeters = Math.max(100, Math.min(50_000, Number(query.radiusKm || 5) * 1000));
    const searchTerms = String(query.q || "")
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);
    const missions = this.repository
      .listMissions({ activeOnly: true, suburb: query.suburb, limit: query.limit })
      .map((mission) => ({
        ...mission,
        lastVerifiedAt: this.repository.getLatestVenueDataTimestamp(mission.venueId) ?? mission.lastVerifiedAt,
        venueAddress: this.repository.getBarProfile(mission.venueId)?.address ?? null,
      }))
      .map((mission) => {
        const venueLocation = this.repository.getVenueLocationCache(mission.venueId);
        const canMeasureDistance = hasLocation
          && typeof venueLocation?.latitude === "number"
          && typeof venueLocation?.longitude === "number";
        const distanceMeters = canMeasureDistance
          ? Math.round(distanceMetersBetween(
            { latitude: query.latitude!, longitude: query.longitude! },
            { latitude: venueLocation!.latitude!, longitude: venueLocation!.longitude! },
          ))
          : null;

        return {
          ...mission,
          points: this.missionDynamicPoints(mission),
          distanceMeters,
          distanceKm: distanceMeters == null ? null : Math.round((distanceMeters / 1000) * 10) / 10,
          freshnessLabel: this.missionFreshnessLabel(mission.lastVerifiedAt),
        };
      })
      .filter((mission) => {
        if (hasLocation && (mission.distanceMeters == null || mission.distanceMeters > radiusMeters)) {
          return false;
        }

        if (!searchTerms.length) {
          return true;
        }

        const searchable = [mission.venueName, mission.suburb, mission.venueAddress, mission.reason]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return searchTerms.every((term) => searchable.includes(term));
      });

    switch (query.sort) {
      case "nearby":
        return missions
          .slice()
          .sort((left, right) => {
            if (left.distanceMeters == null && right.distanceMeters == null) {
              return (Number(right.points) * Number(right.multiplier || 1)) -
                (Number(left.points) * Number(left.multiplier || 1));
            }
            if (left.distanceMeters == null) {
              return 1;
            }
            if (right.distanceMeters == null) {
              return -1;
            }
            return left.distanceMeters - right.distanceMeters;
          });
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
        return missions
          .slice()
          .sort((left, right) =>
            (Number(right.points) * Number(right.multiplier || 1)) -
            (Number(left.points) * Number(left.multiplier || 1)),
          );
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
    const records = [
      ...this.repository.listLatestPriceRecords(input.limit, input.venueId),
      ...this.repository.listVenueManagerPriceRecords(input.limit, input.venueId),
    ]
      .sort((left, right) => new Date(right.lastVerifiedAt).getTime() - new Date(left.lastVerifiedAt).getTime())
      .slice(0, input.limit);
    const hasFullAccess = isFullAccess(account);

    if (hasFullAccess) {
      return {
        records,
        access: this.getAccessState(account, anonymousSessionId),
        revealed: true,
        blocked: false,
      };
    }

    const freePreviewRecords = records.map(freePreviewPriceRecord);
    if (!input.reveal || !input.venueId || records.length === 0) {
      return {
        records: freePreviewRecords,
        access: this.getAccessState(account, anonymousSessionId),
        revealed: false,
        blocked: false,
      };
    }

    const visibleCount = freePreviewRecords.filter((record) => "freePreviewIncluded" in record).length;
    const lockedCount = freePreviewRecords.filter((record) => "priceRedacted" in record).length;
    if (lockedCount > 0) {
      this.trackEvent(account, {
        anonymousSessionId,
        eventType: "price_view_blocked_free_limit",
        venueId: input.venueId,
        beerId: null,
        suburb: records[0]?.suburb ?? null,
        metadata: {
          source: "server_free_preview_scope",
          recordCount: records.length,
          visibleFreePreviewCount: visibleCount,
          lockedPremiumCount: lockedCount,
        },
      });
    }
    return {
      records: freePreviewRecords,
      access: this.getAccessState(account, anonymousSessionId),
      revealed: visibleCount > 0,
      blocked: lockedCount > 0,
    };
  }

  trackEvent(account: BusinessAccount | null, input: EventTrackInput): void {
    try {
      const privacyScope = typeof input.metadata.privacyScope === "string" ? input.metadata.privacyScope : null;
      if (account && privacyScope === "optional_analytics") {
        const settings = this.repository.getAccountPrivacySettings(account.id);
        if (settings && !settings.optionalAnalyticsEnabled) {
          return;
        }
      }
      if (account && privacyScope === "venue_insight") {
        const settings = this.repository.getAccountPrivacySettings(account.id);
        if (settings && (!settings.optionalAnalyticsEnabled || !settings.venueReportInclusionEnabled)) {
          return;
        }
      }
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
        accessState: "invite_required",
        assignments: [],
        selectedVenue: null,
        profile: null,
        tier: null,
        inventory: { beers: [], happyHours: [], specials: [] },
        pendingChanges: [],
        insights: null,
        analytics: null,
        monthlyReport: null,
        updateLink: null,
        claimRequests: [],
        message: "Venue management is invite-only during beta. Ask the Pint Path admin to assign your account to a venue.",
        privacyCopy: "Venue insights are aggregated and privacy-safe. Individual user clickstream and exact location are never shown.",
      };
    }

    const selectedVenueId = query.venueId ?? assignments[0]?.venueId;
    if (!selectedVenueId) {
      return {
        assignments,
        selectedVenue: null,
        pendingChanges: [],
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
    const venueInsightPrivacyThreshold = Math.max(10, this.config.ANALYTICS_MIN_BUCKET_SIZE);
    const analytics = capabilities.analytics
      ? this.repository.getBarAreaAnalytics({
          barId: selectedVenueId,
          area: profile.area ?? profile.suburb ?? suburb,
          month: monthKeyFromIso(nowIso()),
          privacyThreshold: venueInsightPrivacyThreshold,
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
    const insights = this.sanitizeVenueManagerInsights(rawInsights, {
      includeAggregate: capabilities.analytics,
      privacyThreshold: venueInsightPrivacyThreshold,
    });
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
      pendingChanges: this.repository.listBarPendingChanges({ barId: selectedVenueId, status: "pending", limit: 100 }),
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
    if (!this.isAdmin(account)) {
      throw new AppError("Venue manager access is invite-only during beta.", 403);
    }

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
    if (!this.isAdmin(account)) {
      return this.createPendingBarChange({
        account,
        venueId,
        changeType: "profile",
        action: "upsert",
        targetId: venueId,
        payload: {
          ...input,
          membershipTier,
          venueTags: cleanStringList(input.venueTags),
          area: input.area ?? input.suburb ?? assignment?.suburb ?? existing?.area ?? existing?.suburb ?? null,
        },
        suburb: input.suburb ?? assignment?.suburb ?? existing?.suburb ?? null,
      });
    }

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

    if (!this.isAdmin(account)) {
      const targetId = input.id ?? crypto.randomUUID();
      return this.createPendingBarChange({
        account,
        venueId,
        changeType: "beer",
        action: "upsert",
        targetId,
        payload: { ...input, id: targetId },
        suburb: assignment?.suburb ?? this.repository.getBarProfile(venueId)?.suburb ?? null,
      });
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
    const existing = this.repository.getBarBeerById(beerId);
    if (!existing || existing.barId !== venueId) {
      throw new AppError("Beer row not found for this venue.", 404);
    }

    if (!this.isAdmin(account)) {
      return this.createPendingBarChange({
        account,
        venueId,
        changeType: "beer",
        action: "delete",
        targetId: beerId,
        payload: { id: beerId, beerName: existing.beerName },
        suburb: assignment?.suburb ?? this.repository.getBarProfile(venueId)?.suburb ?? null,
      });
    }

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

    if (!this.isAdmin(account)) {
      const targetId = input.id ?? crypto.randomUUID();
      return this.createPendingBarChange({
        account,
        venueId,
        changeType: "happy_hour",
        action: "upsert",
        targetId,
        payload: { ...input, id: targetId },
        suburb: assignment?.suburb ?? this.repository.getBarProfile(venueId)?.suburb ?? null,
      });
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
    const existing = this.repository.getBarHappyHourById(happyHourId);
    if (!existing || existing.barId !== venueId) {
      throw new AppError("Happy hour not found for this venue.", 404);
    }

    if (!this.isAdmin(account)) {
      return this.createPendingBarChange({
        account,
        venueId,
        changeType: "happy_hour",
        action: "delete",
        targetId: happyHourId,
        payload: { id: happyHourId, title: existing.title },
        suburb: assignment?.suburb ?? this.repository.getBarProfile(venueId)?.suburb ?? null,
      });
    }

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

    if (!this.isAdmin(account)) {
      const targetId = input.id ?? crypto.randomUUID();
      return this.createPendingBarChange({
        account,
        venueId,
        changeType: "special",
        action: "upsert",
        targetId,
        payload: { ...input, id: targetId },
        suburb: assignment?.suburb ?? this.repository.getBarProfile(venueId)?.suburb ?? null,
      });
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
    const existing = this.repository.getBarSpecialById(specialId);
    if (!existing || existing.barId !== venueId) {
      throw new AppError("Special not found for this venue.", 404);
    }

    if (!this.isAdmin(account)) {
      return this.createPendingBarChange({
        account,
        venueId,
        changeType: "special",
        action: "delete",
        targetId: specialId,
        payload: { id: specialId, title: existing.title },
        suburb: assignment?.suburb ?? this.repository.getBarProfile(venueId)?.suburb ?? null,
      });
    }

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

  reviewBarPendingChange(admin: BusinessAccount, changeId: string, input: BarPendingChangeReviewInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const change = this.repository.getBarPendingChangeById(changeId);
    if (!change) {
      throw new AppError("Pending bar change not found.", 404);
    }

    if (change.status !== "pending") {
      throw new AppError("Pending bar change has already been reviewed.", 409);
    }

    const now = nowIso();
    if (input.status === "approved") {
      this.applyApprovedBarChange(change, admin, now);
    }

    const reviewed = this.repository.reviewBarPendingChange({
      id: change.id,
      status: input.status,
      reviewedBy: admin.id,
      reviewedAt: now,
      rejectionReason: input.status === "rejected" ? input.rejectionReason ?? "Rejected by admin review." : null,
    });

    this.auditSecurity({
      actor: admin,
      action: "admin_bar_pending_change_review",
      targetType: "bar_pending_change",
      targetId: change.id,
      metadata: {
        barId: change.barId,
        changeType: change.changeType,
        action: change.action,
        status: input.status,
      },
    });

    return {
      pendingChange: reviewed,
      message: input.status === "approved" ? "Bar change approved and published." : "Bar change rejected. Public data was not changed.",
    };
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
      pendingChanges: this.repository.listBarPendingChanges({ status: "pending", limit: 100 }),
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

    const successUrl = new URL("/account.html?checkout=success", this.config.PUBLIC_BASE_URL);
    successUrl.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}");
    const successUrlWithSession = successUrl.toString().replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}");
    const cancelUrl = new URL("/pricing.html?checkout=cancelled", this.config.PUBLIC_BASE_URL).toString();
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formEncode({
        mode: "subscription",
        success_url: successUrlWithSession,
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
      throw new ExternalServiceError(describeStripeCheckoutFailure(response.status, payload?.error?.message), {
        status: response.status,
        message: payload?.error?.message,
      });
    }

    return {
      mode: "stripe",
      checkoutUrl: payload.url,
    };
  }

  async reconcileCheckoutSession(account: BusinessAccount, input: CheckoutSessionInput) {
    if (this.config.DEMO_BILLING_MODE) {
      return {
        account: sanitizeAccount(account),
        access: this.getAccessState(account, null),
        message: "Demo billing is active. No Stripe checkout confirmation is needed.",
      };
    }

    if (!this.config.STRIPE_SECRET_KEY) {
      throw new AppError("Stripe checkout confirmation is not configured.", 503);
    }

    const response = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(input.sessionId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.STRIPE_SECRET_KEY}`,
        },
      },
    );
    const payload = (await response.json().catch(() => null)) as StripeCheckoutSession | null;

    if (!response.ok || !payload) {
      throw new ExternalServiceError(describeStripeCheckoutFailure(response.status, payload?.error?.message), {
        status: response.status,
        message: payload?.error?.message,
      });
    }

    const metadata = payload.metadata ?? {};
    if (metadata.user_id !== account.id) {
      this.auditSecurity({
        actor: account,
        action: "stripe_checkout_session_mismatch",
        targetType: "account",
        targetId: account.id,
        metadata: { sessionPrefix: input.sessionId.slice(0, 12), checkoutUserIdPresent: Boolean(metadata.user_id) },
      });
      throw new AppError("This Stripe checkout session does not belong to your account.", 403);
    }

    const subscriptionStatus = metadata.subscription_status;
    if (subscriptionStatus !== "premium_monthly" && subscriptionStatus !== "premium_yearly") {
      throw new AppError("Stripe checkout session is missing Pint Path subscription metadata.", 400);
    }

    const sessionComplete = payload.status === "complete" || payload.payment_status === "paid";
    if (!sessionComplete) {
      throw new AppError("Stripe checkout has not completed yet. Please wait a few seconds and refresh Account.", 409);
    }

    const updated = this.repository.updateSubscription({
      userId: account.id,
      subscriptionStatus,
      stripeCustomerId: stripeObjectId(payload.customer),
      premiumUntil: null,
      now: nowIso(),
    });
    this.trackEvent(updated, {
      anonymousSessionId: null,
      eventType: "subscription_created",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { mode: "stripe", source: "checkout_return", subscriptionStatus },
    });
    this.auditSecurity({
      actor: updated,
      action: "stripe_subscription_update",
      targetType: "account",
      targetId: updated.id,
      metadata: { source: "checkout_return", subscriptionStatus },
    });

    return {
      account: sanitizeAccount(updated),
      access: this.getAccessState(updated, null),
      message: "Stripe checkout confirmed. Premium access is now active.",
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
      metadata: { billingContext: "venue", tier: input.tier },
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
        targetType: "venue",
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
        message: `${input.tier === "plus" ? "Plus" : "Pro"} demo tier activated for this venue.`,
      };
    }

    if (!this.config.STRIPE_SECRET_KEY || !priceId) {
      throw new AppError("Stripe checkout is not configured for this venue tier.", 503);
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
        "metadata[billing_context]": "venue",
        "metadata[user_id]": account.id,
        "metadata[venue_id]": venueId,
        "metadata[venue_membership_tier]": input.tier,
        customer_email: account.email,
      }),
    });

    const payload = (await response.json().catch(() => null)) as { url?: string; error?: { message?: string } } | null;

    if (!response.ok || !payload?.url) {
      throw new ExternalServiceError(describeStripeCheckoutFailure(response.status, payload?.error?.message), {
        status: response.status,
        message: payload?.error?.message,
      });
    }

    return {
      mode: "stripe",
      checkoutUrl: payload.url,
      message: "Stripe checkout created for this venue tier.",
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
      const barId = metadata?.venue_id;
      const barMembershipTier = metadata?.venue_membership_tier as BarMembershipTier | undefined;
      const subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
      const userId = metadata?.user_id;
      const subscriptionStatus = metadata?.subscription_status as SubscriptionStatus | undefined;
      const customer = typeof object.customer === "string" ? object.customer : null;

      if ((billingContext === "venue" || billingContext === "bar") && barId && (barMembershipTier === "plus" || barMembershipTier === "pro")) {
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
          metadata: { mode: "stripe", billingContext: "venue", tier: barMembershipTier },
        });
        this.auditSecurity({
          action: "stripe_subscription_update",
          targetType: "venue",
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
          metadata: { mode: "stripe", billingContext: "venue" },
        });
        this.auditSecurity({
          action: shouldDowngrade ? "stripe_subscription_downgrade" : "stripe_subscription_update",
          targetType: "venue",
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
