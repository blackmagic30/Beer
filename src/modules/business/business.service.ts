import crypto from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as QRCode from "qrcode";

import { CONTRIBUTION_POINTS, PREMIUM_PRICING, SUBMISSION_LIMITS } from "../../config/business-rules.js";
import type { Env } from "../../config/env.js";
import {
  BusinessRepository,
  type AgeVerification,
  type AccountPreferences,
  type BarPendingChange,
  type BarPendingChangeAction,
  type BarPendingChangeType,
  type BusinessAccount,
  type BarMembershipTier,
  type BarProfile,
  type MonthlyBarReport,
  type BusinessMission,
  type MissionVenueCandidate,
  type BusinessSubmission,
  type BusinessSubmissionItem,
  type ConfidenceLabel,
  type FeedbackPriority,
  type LeaderboardPrizeCampaign,
  type PendingVenueDetails,
  type PubGolfVenueCandidate,
  type PublicVenuePriceRecord,
  type SavedItem,
  type ServingSize,
  type SourceEvidenceObject,
  type SubscriptionStatus,
} from "../../db/business.repository.js";
import { SUPPORTED_BEERS, VIEWER_TRACKED_BEERS, canonicalizeTrackedBeerName, findTrackedBeerByName, normalizeBeerSearchKey } from "../../constants/beers.js";
import { AppError, ExternalServiceError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { redactSecrets } from "../../lib/redact.js";
import {
  DEFAULT_REPORT_TIMEZONE,
  getPreviousZonedMonthKey,
  getZonedDayRangeIso,
  getZonedMonthKey,
  getZonedMonthRangeIso,
  getZonedWeekRangeIso,
} from "../../lib/time.js";
import {
  type GoogleAddressComponent,
  type GooglePlaceCandidate,
  hasStrongBarOrPubNameSignal,
  isExcludedVenueName,
  shouldImportBarOrPubPlace,
} from "../../lib/venue-directory.js";

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
  DisplayNameUpdateInput,
  DiscountRedemptionInput,
  EventTrackInput,
  FeedbackInput,
  AdminAccountSearchInput,
  LegalAcceptanceInput,
  LeaderboardPrizeCampaignInput,
  LeaderboardPrizeFinalizeInput,
  LeaderboardQuery,
  FreePintRewardCodeInput,
  FreePintRewardDecisionInput,
  MonthlyReportDeliveryInput,
  MonthlyReportExportQuery,
  MonthlyReportGenerateInput,
  PintPointDrinkRecordInput,
  PosDiscountRedemptionInput,
  PriceRecordsQuery,
  PubGolfPlanInput,
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
  membershipTier?: BarMembershipTier;
  highlightedName?: boolean;
  premiumBadge?: string | null;
  promoted?: boolean;
  featuredSpecialEligible?: boolean;
  venueTags?: string[];
  isUserSubmittedVenue?: boolean;
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

interface GooglePlacesSearchResponse {
  places?: GooglePlaceCandidate[];
  error?: { message?: string; code?: number; status?: string };
}

interface UserGoogleVenueLookup {
  googlePlaceId: string;
  name: string;
  address: string;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
  businessStatus: string | null;
  primaryType: string | null;
  types: string[];
  recommended: boolean;
  alreadyExists: boolean;
  existingVenue: Pick<VenueRow, "id" | "name" | "address" | "suburb"> | null;
}

const AUTO_MISSION_VENUE_LIMIT = 2_000;
const AUTO_MISSION_TARGET_BEERS = [
  SUPPORTED_BEERS.guinness,
  SUPPORTED_BEERS.carlton_draft,
  SUPPORTED_BEERS.stone_and_wood,
] as const;
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const USER_GOOGLE_VENUE_TYPES = ["bar", "pub", "restaurant", "brewery", "night_club"] as const;
const USER_GOOGLE_VENUE_TYPE_SET = new Set<string>(USER_GOOGLE_VENUE_TYPES);
const COMMUNITY_SUBMISSION_CONFIRMATIONS_REQUIRED = 2;

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

function addMinutes(baseIso: string, minutes: number): string {
  const date = new Date(baseIso);
  date.setUTCMinutes(date.getUTCMinutes() + minutes);
  return date.toISOString();
}

function endOfMonthIso(baseIso: string): string {
  const date = new Date(baseIso);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999)).toISOString();
}

function monthKeyFromIso(value: string): string {
  return value.slice(0, 7);
}

function getGoogleVenueAddressComponent(
  components: GoogleAddressComponent[] | undefined,
  type: string,
  value: "longText" | "shortText" = "longText",
): string | null {
  const component = components?.find((item) => item.types?.includes(type));
  const text = component?.[value]?.trim() || component?.longText?.trim() || component?.shortText?.trim();
  return text && text.length > 0 ? text : null;
}

function cleanGoogleVenueAddress(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/,\s*Australia$/i, "")
    .trim();
}

function getGoogleVenueTypes(place: GooglePlaceCandidate): string[] {
  return [
    place.primaryType,
    ...(place.types ?? []),
  ]
    .filter((type): type is string => Boolean(type))
    .map((type) => type.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedUserGoogleVenue(place: GooglePlaceCandidate): boolean {
  const name = place.displayName?.text?.trim() ?? "";
  const address = place.formattedAddress?.trim() ?? "";
  const businessStatus = place.businessStatus ?? "OPERATIONAL";

  if (!name || !address || businessStatus === "CLOSED_PERMANENTLY") {
    return false;
  }

  if (isExcludedVenueName(name)) {
    return false;
  }

  return getGoogleVenueTypes(place).some((type) => USER_GOOGLE_VENUE_TYPE_SET.has(type));
}

function hasUserVenuePlaceSignal(place: GooglePlaceCandidate): boolean {
  const name = place.displayName?.text?.trim() ?? "";
  return shouldImportBarOrPubPlace(place) ||
    hasStrongBarOrPubNameSignal(name) ||
    isAllowedUserGoogleVenue(place);
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

const DISPLAY_NAME_MAX_LENGTH = 28;
const DISPLAY_NAME_DENY_PATTERNS = [
  /\b(?:admin|moderator|staff|support|pint\s*path|pintpath)\b/i,
  /\b(?:n[i1!]+g+(?:e|a|3)?r?|c[o0]on|g[o0]{2}k|ch[i1!]+nk|p[a4]k[i1!]|r[a4]ghead|sp[i1!]c|k[i1!]ke)\b/i,
  /\b(?:f[a4]g+(?:ot)?|tr[a4]nny|dyke|h[o0]m[o0])\b/i,
  /\b(?:ret[a4]rd|sp[a4]stic|mongoloid)\b/i,
  /\b(?:wh[o0]re|sl[uü]t|c[uü]nt|b[i1!]tch)\b/i,
  /(?:https?:\/\/|www\.|@)/i,
] as const;

const PUB_GOLF_DEFAULT_DRINKS = [
  "Guinness",
  "Carlton Draught",
  "Stone & Wood Pacific Ale",
  "Lager",
  "Pale Ale",
  "IPA",
  "Cider",
  "Red wine",
  "Vodka soda",
];

const MELBOURNE_AREA_COORDINATES: Record<string, { latitude: number; longitude: number; label: string }> = {
  cbd: { latitude: -37.8136, longitude: 144.9631, label: "Melbourne CBD" },
  melbourne: { latitude: -37.8136, longitude: 144.9631, label: "Melbourne CBD" },
  fitzroy: { latitude: -37.7984, longitude: 144.9780, label: "Fitzroy" },
  collingwood: { latitude: -37.8024, longitude: 144.9886, label: "Collingwood" },
  richmond: { latitude: -37.8230, longitude: 145.0027, label: "Richmond" },
  brunswick: { latitude: -37.7667, longitude: 144.9612, label: "Brunswick" },
  "brunswick east": { latitude: -37.7726, longitude: 144.9733, label: "Brunswick East" },
  prahran: { latitude: -37.8510, longitude: 144.9937, label: "Prahran" },
  southbank: { latitude: -37.8239, longitude: 144.9640, label: "Southbank" },
  st_kilda: { latitude: -37.8676, longitude: 144.9785, label: "St Kilda" },
  "st kilda": { latitude: -37.8676, longitude: 144.9785, label: "St Kilda" },
  brighton: { latitude: -37.9050, longitude: 144.9993, label: "Brighton" },
};

function normalizePublicDisplayName(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\s+/g, " ") ?? "";
  return trimmed || null;
}

function validatePublicDisplayName(value: string | null | undefined): string | null {
  const displayName = normalizePublicDisplayName(value);
  if (!displayName) {
    return null;
  }

  if (displayName.length < 2 || displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new AppError(`Display name must be 2-${DISPLAY_NAME_MAX_LENGTH} characters.`, 400);
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9 ._'’-]*[A-Za-z0-9]$/.test(displayName)) {
    throw new AppError("Display name can use letters, numbers, spaces, dots, apostrophes, underscores, and hyphens.", 400);
  }

  const normalized = displayName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (DISPLAY_NAME_DENY_PATTERNS.some((pattern) => pattern.test(displayName) || pattern.test(normalized))) {
    throw new AppError("Choose a display name that follows the community rules.", 400);
  }

  return displayName;
}

function safeProviderDisplayName(value: string | null): string | null {
  try {
    return validatePublicDisplayName(value);
  } catch {
    return null;
  }
}

function prizeAmountForRank(campaign: LeaderboardPrizeCampaign, rank: number): number {
  if (rank === 1) {
    return campaign.firstPlaceCents;
  }
  if (rank === 2) {
    return campaign.secondPlaceCents;
  }
  if (rank === 3) {
    return campaign.thirdPlaceCents;
  }
  return 0;
}

function formatAudCents(cents: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function monthKeyRange(monthKey: string, timezone: string) {
  const range = getZonedMonthRangeIso(monthKey, timezone || DEFAULT_REPORT_TIMEZONE);
  return {
    startsAt: range.startIso,
    endsAt: range.endIso,
  };
}

function hasCoordinates(value: { latitude: number | null; longitude: number | null }): value is { latitude: number; longitude: number } {
  return typeof value.latitude === "number" && typeof value.longitude === "number";
}

function routeLegCopy(distanceMeters: number | null, requestedMode: "auto" | "walking" | "transit"): string {
  if (distanceMeters == null) {
    return "Open Maps for the best walking or public transport leg.";
  }
  const distanceKm = distanceMeters / 1000;
  if (requestedMode === "walking" || (requestedMode === "auto" && distanceKm <= 1.4)) {
    return `${distanceKm.toFixed(distanceKm < 1 ? 1 : 1)} km walk`;
  }
  if (requestedMode === "transit" || distanceKm > 2.2) {
    return `${distanceKm.toFixed(1)} km, public transport suggested`;
  }
  return `${distanceKm.toFixed(1)} km, walkable if the group is comfortable`;
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

function normalizeTrackedBeerId(value: string): string {
  return findTrackedBeerByName(value)?.key ?? normalizeBeerId(value);
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const DISCOUNT_PASS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FREE_PINT_REWARD_POINTS = 50;
const FREE_PINT_REWARD_CODE_MINUTES = 10;

function generateDiscountCode(): string {
  return Array.from({ length: 6 }, () =>
    DISCOUNT_PASS_CODE_ALPHABET[crypto.randomInt(DISCOUNT_PASS_CODE_ALPHABET.length)]!,
  ).join("");
}

function hashDiscountCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function createPosWebhookToken(secret: string, venueId: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`pint-path-pos-redemption:${venueId.trim()}`)
    .digest("hex");
}

function timingSafeStringEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
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
    publicAccountId: account.publicAccountId,
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
const FILESYSTEM_EVIDENCE_PROVIDER = "filesystem_private";
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

function sourceEvidenceExtensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return "bin";
  }
}

function safeRelativeEvidencePath(objectPath: string): string | null {
  const normalized = objectPath.replace(/\\/g, "/");
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return normalized;
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

function buildConsumerPremiumToolkit(input: {
  account: BusinessAccount | null;
  savedItems?: SavedItem[];
  preferences?: AccountPreferences | null;
  discountStats?: { totalRedemptions: number; estimatedSavingsCents: number; uniqueVenues: number } | null;
}) {
  const hasFullAccess = isFullAccess(input.account);
  const savedItems = input.savedItems ?? [];
  const savedCounts = savedItems.reduce(
    (counts, item) => {
      if (item.itemType === "venue") {
        counts.venues += 1;
      } else if (item.itemType === "beer") {
        counts.beers += 1;
      } else if (item.itemType === "suburb") {
        counts.suburbs += 1;
      } else if (item.itemType === "night_plan") {
        counts.nightPlans += 1;
      }
      return counts;
    },
    { venues: 0, beers: 0, suburbs: 0, nightPlans: 0 },
  );
  const preferredShortcuts =
    (input.preferences?.preferredSuburbs.length ?? 0) +
    (input.preferences?.preferredBeers.length ?? 0) +
    (input.preferences?.preferredUseCases.length ?? 0);
  const upgradeCopy = "Upgrade for A$4.99/month, A$50/year, or earn 15 approved points this month.";

  return {
    enabled: hasFullAccess,
    status: hasFullAccess ? "active" : "locked",
    title: hasFullAccess ? "Premium member toolkit" : "Unlock the premium member toolkit",
    summary: hasFullAccess
      ? "Your paid/contributor tools are active: exact prices, value rings, premium filters, discount-pass access, saved night shortcuts, and savings tracking."
      : `Paid users get exact prices, value rings, premium filters, discount-pass access, saved night shortcuts, and savings tracking. ${upgradeCopy}`,
    lockedCopy: hasFullAccess ? null : upgradeCopy,
    primaryAction: hasFullAccess
      ? { label: "Open value map", href: "/index.html" }
      : { label: "Upgrade monthly", href: "/account.html?checkoutPlan=monthly" },
    secondaryAction: hasFullAccess
      ? { label: "Manage watchlist", href: "/account.html?settings=watchlist" }
      : { label: "Earn with missions", href: "/missions.html" },
    counts: {
      savedVenues: savedCounts.venues,
      savedBeers: savedCounts.beers,
      savedSuburbs: savedCounts.suburbs,
      savedNightPlans: savedCounts.nightPlans,
      preferredShortcuts,
      totalRedemptions: input.discountStats?.totalRedemptions ?? 0,
      uniqueDiscountVenues: input.discountStats?.uniqueVenues ?? 0,
      estimatedSavingsCents: input.discountStats?.estimatedSavingsCents ?? 0,
      estimatedSavingsDollars: Number(((input.discountStats?.estimatedSavingsCents ?? 0) / 100).toFixed(2)),
    },
    perks: [
      {
        id: "exact_price_mode",
        title: "Exact price and value rings",
        unlocked: hasFullAccess,
        badge: hasFullAccess ? "Active" : "Paid",
        copy: "See every verified beer price and the green-to-red value ring around venue pins when comparing the same beer.",
        href: "/index.html",
        ctaLabel: "Open map",
      },
      {
        id: "premium_filters",
        title: "Cheapest-night filters",
        unlocked: hasFullAccess,
        badge: hasFullAccess ? "Active" : "Paid",
        copy: "Use beer search, cheapest sort, verified-only, under-A$10, nearby, and saved-suburb filters without daily reveal limits.",
        href: "/index.html",
        ctaLabel: "Find value",
      },
      {
        id: "discount_pass",
        title: "Rotating special pass",
        unlocked: hasFullAccess,
        badge: hasFullAccess ? "Ready" : "Paid",
        copy: "Generate a session-based QR/code for Pint Path specials, then track venue-confirmed savings in your account.",
        href: "/account.html",
        ctaLabel: "Open pass",
      },
      {
        id: "night_shortlist",
        title: "Saved night shortcuts",
        unlocked: hasFullAccess,
        badge: `${savedCounts.venues + savedCounts.beers + savedCounts.suburbs + savedCounts.nightPlans} saved`,
        copy: "Keep favourite venues, beers, suburbs, and night-plan ideas synced to your account for faster repeat searches.",
        href: "/account.html?settings=watchlist",
        ctaLabel: "Manage list",
      },
      {
        id: "personal_preferences",
        title: "Personal discovery defaults",
        unlocked: hasFullAccess,
        badge: `${preferredShortcuts} set`,
        copy: "Save preferred suburbs, beers, and use cases so missions and discovery tools start closer to how you go out.",
        href: "/account.html?settings=preferences",
        ctaLabel: "Tune profile",
      },
      {
        id: "savings_tracker",
        title: "Savings and access tracker",
        unlocked: hasFullAccess,
        badge: hasFullAccess ? "Dashboard" : "Preview",
        copy: "See estimated savings from redeemed specials, contribution progress, trust score, and current access status together.",
        href: "/account.html?settings=stats",
        ctaLabel: "View stats",
      },
    ],
  };
}

function redactPriceRecord(record: PublicVenuePriceRecord): PublicVenuePriceRecord & { priceRedacted: true } {
  const isSpecial = record.displayKind === "special";

  return {
    ...record,
    beerName: isSpecial
      ? record.specialExclusive
        ? "Pint Path special"
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
        ? "Pint Path special"
        : "Venue special"
      : record.specialTitle ?? null,
    specialDescription: isSpecial ? null : record.specialDescription ?? null,
    specialDiscount: isSpecial ? null : record.specialDiscount ?? null,
    specialStartsAt: isSpecial ? null : record.specialStartsAt ?? null,
    specialEndsAt: isSpecial ? null : record.specialEndsAt ?? null,
    specialStartTime: isSpecial ? null : record.specialStartTime ?? null,
    specialEndTime: isSpecial ? null : record.specialEndTime ?? null,
    specialScheduleNote: isSpecial ? null : record.specialScheduleNote ?? null,
    sourceSubmissionId: null,
    priceRedacted: true,
  };
}

const FREE_PREVIEW_BEER_KEYS = new Set([
  "guinness",
  "carlton_draft",
  "carlton_draught",
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
  const canonicalBeerKey = findTrackedBeerByName(record.beerName)?.key ?? normalizeBeerSearchKey(canonicalizeTrackedBeerName(record.beerName));
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
    premiumBadge: tier === "pro" ? "Pro" : null,
    promoted: tier === "pro",
    featuredSpecialEligible: tier === "pro",
  };
}

function getBarTierCapabilities(tier: BarMembershipTier, admin = false) {
  const analytics = admin || tier === "pro";
  const canManageSpecials = admin || tier === "pro";
  const pro = tier === "pro";
  return {
    tier,
    canManageProfile: true,
    canManageInventory: true,
    canManageHappyHours: true,
    canManageSpecials,
    analytics,
    monthlyReports: analytics,
    premiumDisplay: pro,
    featuredSpecials: pro,
    posWebhookIntegration: admin || pro,
    priorityReview: pro,
    advancedRecommendations: pro,
    discoveryBoost: pro,
    upgradeCopy: analytics
      ? null
      : "Upgrade to Pro to add Pint Path specials, see privacy-safe suburb analytics, and export generated monthly reports.",
  };
}

function getTotalVenueActionIntent(analytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]>): number {
  return analytics.directionsClicks + analytics.saves + analytics.shares;
}

interface CommercialVenueInsights {
  aggregateInsights: {
    missingBeerSearches: Array<{ key: string; count: number }>;
  } | null;
  listingQuality: {
    score: number;
  };
  wrongPriceReports: Array<{
    status: string;
  }>;
}

function buildVenueDemandSnapshot(input: {
  analytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]>;
  insights: CommercialVenueInsights;
}) {
  const { analytics, insights } = input;
  const actionIntent = getTotalVenueActionIntent(analytics);
  const interactionTotal = analytics.barLookups + analytics.profileViews + analytics.beerListViews + analytics.specialsViews;
  const topBeer = analytics.privacyFloorMet ? analytics.areaBeerSearches[0] ?? null : null;
  const topStyle = analytics.privacyFloorMet ? analytics.areaStyleSearches[0] ?? null : null;
  const missingBeer = insights.aggregateInsights?.missingBeerSearches?.[0] ?? null;
  const listingQualityScore = insights.listingQuality.score;
  const opportunityScore = Math.max(
    1,
    Math.min(
      100,
      Math.round(
        listingQualityScore * 0.45 +
        Math.min(interactionTotal, 80) * 0.35 +
        Math.min(actionIntent * 4, 20),
      ),
    ),
  );
  const demandHighlights = [
    topBeer
      ? `${topBeer.key} is the strongest privacy-safe beer search near this venue.`
      : `Area search volume has not reached the ${analytics.privacyThreshold}-event privacy floor yet.`,
    topStyle
      ? `${topStyle.key} style searches are showing enough demand to guide tap-list wording.`
      : "Beer-style demand will appear once enough users search nearby.",
    missingBeer
      ? `${missingBeer.key} is searched nearby but is not covered by this venue's current verified rows.`
      : "No high-confidence missing beer opportunity is available yet.",
  ];

  return {
    title: analytics.privacyFloorMet ? "Suburb demand snapshot" : "Demand snapshot building",
    privacyFloorMet: analytics.privacyFloorMet,
    privacyThreshold: analytics.privacyThreshold,
    opportunityScore,
    funnel: [
      { label: "Discovery interest", value: analytics.barLookups, helper: "Map pins, cards, detail opens and lookups." },
      { label: "Beer-price intent", value: analytics.beerListViews + analytics.priceReveals, helper: "Beer-list views and price reveals." },
      { label: "Specials intent", value: analytics.specialsViews, helper: "Pint Path special and happy-hour interest." },
      { label: "Action intent", value: actionIntent, helper: "Directions, saves, night-plan adds and shares." },
    ],
    demandHighlights,
    recommendedNextActions: [
      topBeer
        ? `Keep ${topBeer.key} pricing fresh and visible before peak weekend search windows.`
        : "Keep the three highest-volume tap-list rows current while nearby demand grows.",
      analytics.specialsViews > 0
        ? "Refresh one clear weekly special so demand from Pint Path special and happy-hour views lands on a current offer."
        : "Add one simple reviewed special to create a stronger reason to choose this venue.",
      listingQualityScore < 80
        ? "Improve listing quality before paid campaigns; missing profile details reduce conversion."
        : "Use the monthly report export in staff or owner meetings to track demand shifts.",
    ],
  };
}

function getProVenueRecommendations(input: {
  analytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]>;
  insights: { listingQuality: { score: number } };
}): string[] {
  const searchedBeer = input.analytics.privacyFloorMet ? input.analytics.areaBeerSearches[0]?.key : null;
  const searchedStyle = input.analytics.privacyFloorMet ? input.analytics.areaStyleSearches[0]?.key : null;
  const qualityScore = input.insights.listingQuality.score;

  return [
    searchedBeer
      ? `Feature one high-margin special around nearby "${searchedBeer}" demand, then keep the offer current through the weekend.`
      : "Run one tightly scoped Pro Pint Path special each week so Pro placement points to a real current offer.",
    searchedStyle
      ? `Refresh your tap-list rows for ${searchedStyle} before Thursday afternoon so discovery placement has fresh matching data.`
      : "Add beer styles and serve sizes to every current row so Pro discovery can match more search intent.",
    qualityScore < 80
      ? "Lift the listing quality score before pushing Pro specials; missing profile details weaken Pro visibility."
      : "Use Pro priority review for specials and profile edits that support Friday-Saturday trading.",
  ];
}

function buildProVenueGrowthPlan(input: {
  analytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]>;
  insights: CommercialVenueInsights;
}) {
  const { analytics, insights } = input;
  const recommendations = getProVenueRecommendations({ analytics, insights });
  const listingQualityScore = insights.listingQuality.score;
  const openDisputes = insights.wrongPriceReports.filter((report) => report.status === "open").length;

  return {
    title: "Pro growth studio",
    premiumPlacement: {
      mapHalo: true,
      listingBadge: true,
      bestMatchBoost: true,
      priorityReview: true,
      featuredExclusiveEligible: true,
    },
    spotlightReadiness: [
      { label: "Premium map/listing halo active", complete: true },
      { label: "Pro Pint Path special treatment active", complete: true },
      { label: "Priority review active for venue edits", complete: true },
      { label: "Listing quality at 80% or better", complete: listingQualityScore >= 80 },
      { label: "No open wrong-price disputes", complete: openDisputes === 0 },
    ],
    priorityMoves: recommendations,
    weekendPlaybook: [
      analytics.privacyFloorMet && analytics.areaBeerSearches[0]
        ? `Build the next Pro Pint Path special around ${analytics.areaBeerSearches[0].key} demand.`
        : "Use a broad, easy-to-understand Pint Path special until nearby search demand matures.",
      analytics.specialsViews > 0
        ? "Refresh the active Pint Path special before Friday afternoon so premium attention lands on a current offer."
        : "Submit a clean Pint Path special and use priority review so it is ready for weekend traffic.",
      getTotalVenueActionIntent(analytics) > 0
        ? "Keep address, opening hours and happy-hour conditions exact because users are showing action intent."
        : "Add a stronger call-to-action in the profile copy so premium attention has a clear next step.",
    ],
  };
}

function getVenueDemandPeriodRanges(timezone: string) {
  const now = new Date();
  const month = getZonedMonthKey(now, timezone);
  return [
    {
      key: "today",
      label: "Today",
      helper: "Since local midnight",
      ...getZonedDayRangeIso(now, timezone),
    },
    {
      key: "week",
      label: "This week",
      helper: "Monday to Sunday",
      ...getZonedWeekRangeIso(now, timezone),
    },
    {
      key: "month",
      label: "This month",
      helper: month,
      ...getZonedMonthRangeIso(month, timezone),
    },
  ];
}

function buildVenueDemandPeriod(input: {
  key: string;
  label: string;
  helper: string;
  analytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]>;
}) {
  const { analytics } = input;
  const actionIntent = getTotalVenueActionIntent(analytics);
  const beerIntent = analytics.beerListViews + analytics.priceReveals;
  const topBeer = analytics.privacyFloorMet ? analytics.areaBeerSearches[0] ?? null : null;
  const topStyle = analytics.privacyFloorMet ? analytics.areaStyleSearches[0] ?? null : null;
  const recommendedAction = topBeer
    ? `Keep ${topBeer.key} current and consider a simple special around that demand.`
    : analytics.barLookups > 0
      ? "Turn venue interest into action with fresh beer prices and one clear Pint Path special."
      : "Keep prices fresh so the venue is ready when nearby demand appears.";

  return {
    key: input.key,
    label: input.label,
    helper: input.helper,
    venueSearchQueries: analytics.venueSearchQueries,
    venueOpens: analytics.barLookups,
    venueSearches: analytics.venueSearchQueries + analytics.barLookups,
    profileViews: analytics.profileViews,
    beerIntent,
    specialsIntent: analytics.specialsViews,
    actionIntent,
    areaSearches: analytics.areaSearches,
    topAreaBeer: topBeer ? { key: topBeer.key, count: topBeer.count } : null,
    topAreaStyle: topStyle ? { key: topStyle.key, count: topStyle.count } : null,
    privacyFloorMet: analytics.privacyFloorMet,
    privacyThreshold: analytics.privacyThreshold,
    recommendedAction,
  };
}

function buildVenueDemandDashboard(input: {
  tier: BarMembershipTier;
  area: string | null;
  periods: Array<{
    key: string;
    label: string;
    helper: string;
    analytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]>;
  }>;
}) {
  const isPro = input.tier === "pro";
  const periodCards = input.periods.map((period) => buildVenueDemandPeriod(period));
  const month = periodCards.find((period) => period.key === "month") ?? periodCards[periodCards.length - 1];
  const topBeer = month?.topAreaBeer ?? null;
  const topStyle = month?.topAreaStyle ?? null;

  return {
    title: isPro ? "Pro demand cockpit" : "Paid demand snapshot",
    tier: input.tier,
    area: input.area,
    proActive: isPro,
    privacyCopy: "Aggregate only. No individual users, emails, or exact locations are shown.",
    periodOrder: periodCards.map((period) => period.key),
    periods: periodCards.reduce<Record<string, ReturnType<typeof buildVenueDemandPeriod>>>((accumulator, period) => {
      accumulator[period.key] = period;
      return accumulator;
    }, {}),
    headline: topBeer
      ? `${topBeer.key} is the strongest beer search near ${input.area || "this venue"}.`
      : topStyle
        ? `${topStyle.key} style searches are building near ${input.area || "this venue"}.`
        : "Nearby demand is still building toward the privacy threshold.",
    proAdvantage: isPro
      ? [
          "Premium map/listing treatment is active.",
          "Priority review keeps Pint Path specials fresher before peak nights.",
          "Use the top searched beer signal to choose the next app-only special.",
        ]
      : [],
  };
}

function formatBeerInsightName(value: string | null | undefined): string {
  const tracked = findTrackedBeerByName(value);
  if (tracked) {
    return tracked.name;
  }

  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "Unspecified beer";
  }

  return trimmed
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) {
    return current > 0 ? null : 0;
  }

  return Math.round(((current - previous) / previous) * 100);
}

function trendDirection(change: number | null): "up" | "down" | "flat" | "new" {
  if (change == null) {
    return "new";
  }
  if (change > 5) {
    return "up";
  }
  if (change < -5) {
    return "down";
  }
  return "flat";
}

function buildPaidVenueIntelligence(input: {
  area: string | null;
  analytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]>;
  previousAnalytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]> | null;
  inventoryBeers: ReturnType<BusinessRepository["listBarBeers"]>;
  purchasedBeers: ReturnType<BusinessRepository["listVenueAreaPurchasedBeers"]>;
  priceBenchmarks: ReturnType<BusinessRepository["listVenueAreaPriceBenchmarks"]>;
}) {
  const area = input.area?.trim() || "your suburb";
  const stockKeys = new Set(input.inventoryBeers.map((beer) => normalizeTrackedBeerId(beer.beerName)));
  const topSearchedBeers = input.analytics.privacyFloorMet
    ? input.analytics.areaBeerSearches.map((row) => {
        const beerName = formatBeerInsightName(row.key);
        return {
          key: normalizeTrackedBeerId(row.key),
          beerName,
          searchCount: row.count,
          copy: `${beerName} was searched ${row.count} time${row.count === 1 ? "" : "s"} in ${area}.`,
        };
      })
    : [];

  const topPurchasedBeers = input.purchasedBeers.map((row) => {
    const beerName = formatBeerInsightName(row.label || row.key);
    return {
      key: normalizeTrackedBeerId(row.key),
      beerName,
      purchaseCount: row.quantity,
      eventCount: row.count,
      estimatedSavingsCents: row.estimatedSavingsCents,
      estimatedSavingsDollars: Number((row.estimatedSavingsCents / 100).toFixed(2)),
      copy: `${beerName} was logged ${row.quantity} time${row.quantity === 1 ? "" : "s"} through Pint Path in ${area}.`,
    };
  });

  const searchStockGaps = topSearchedBeers
    .filter((row) => !stockKeys.has(row.key))
    .map((row) => ({
      ...row,
      copy: `${row.beerName} was searched ${row.searchCount} time${row.searchCount === 1 ? "" : "s"} in ${area}, but your venue does not list it.`,
    }));

  const previousStyleCounts = new Map((input.previousAnalytics?.areaStyleSearches ?? []).map((row) => [row.key, row.count]));
  const localTrendReport = (input.analytics.privacyFloorMet ? input.analytics.areaStyleSearches : [])
    .slice(0, 4)
    .map((row) => {
      const previous = previousStyleCounts.get(row.key) ?? 0;
      const change = percentChange(row.count, previous);
      const direction = trendDirection(change);
      const label = formatBeerInsightName(row.label || row.key);
      const copy = direction === "new"
        ? `${label} searches are newly visible in ${area} this month.`
        : direction === "flat"
          ? `${label} searches are steady in ${area}.`
          : `${label} searches are ${direction} ${Math.abs(change ?? 0)}% in ${area}.`;
      return {
        key: row.key,
        label,
        count: row.count,
        previousCount: previous,
        percentChange: change,
        direction,
        copy,
      };
    });

  const peakAfterSix = (input.analytics.searchTimesByHour ?? [])
    .filter((row) => row.sort >= 18)
    .sort((a, b) => b.count - a.count)[0] ?? null;
  if (peakAfterSix) {
    const peakSubject = topSearchedBeers[0]?.beerName ?? localTrendReport[0]?.label ?? "Beer";
    localTrendReport.push({
      key: `after_${peakAfterSix.key}`,
      label: peakSubject,
      count: peakAfterSix.count,
      previousCount: 0,
      percentChange: null,
      direction: "new",
      copy: `${peakSubject} searches spike after ${peakAfterSix.label} in ${area}.`,
    });
  }

  const priceBenchmarks = input.priceBenchmarks.map((benchmark) => {
    const differenceAbs = Math.abs(benchmark.difference);
    const serveCopy = benchmark.serveSize ? `${benchmark.serveSize} ` : "";
    const comparisonCopy = benchmark.comparison === "at"
      ? "matches"
      : benchmark.comparison === "above"
        ? "is above"
        : "is below";
    return {
      ...benchmark,
      differenceAbs,
      copy: benchmark.comparison === "at"
        ? `Your listed ${serveCopy}price for ${benchmark.beerName} matches the ${area} median.`
        : `Your listed ${serveCopy}price for ${benchmark.beerName} ${comparisonCopy} the ${area} median by A$${differenceAbs.toFixed(2)}.`,
    };
  });

  return {
    area,
    privacyFloorMet: input.analytics.privacyFloorMet,
    privacyThreshold: input.analytics.privacyThreshold,
    topSearchedBeers,
    topPurchasedBeers,
    searchStockGaps,
    localTrendReport: localTrendReport.slice(0, 5),
    priceBenchmarks,
    searchTimesByDay: input.analytics.searchTimesByDay ?? [],
    searchTimesByHour: input.analytics.searchTimesByHour ?? [],
    peakSearchDay: input.analytics.searchTimesByDay?.[0] ?? null,
    peakSearchHour: input.analytics.searchTimesByHour?.[0] ?? null,
    generatedAt: nowIso(),
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

const SENSITIVE_REPORT_KEY_PATTERN =
  /(^|[_-])(user_?id|account_?id|email|phone|anonymous_?session_?id|session_?id|token|secret|authorization|source_?photo|image|dataurl|latitude|longitude|lat|lng|coordinates?|gps|clickstream|raw)([_-]|$)|^(userId|accountId|email|phone|anonymousSessionId|sessionId|sourcePhotoUrl|sourcePhotoDataUrl|latitude|longitude|lat|lng)$/i;

function sanitizeMonthlyReportValue(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "[redacted]";
  }

  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return redactSecrets(value.slice(0, 500)).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]");
  }

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeMonthlyReportValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_REPORT_KEY_PATTERN.test(key)) {
        continue;
      }
      sanitized[key] = sanitizeMonthlyReportValue(nested, depth + 1);
    }
    return sanitized;
  }

  return null;
}

function sanitizeMonthlyReport(report: MonthlyBarReport | null): MonthlyBarReport | null {
  if (!report) {
    return null;
  }

  return {
    ...report,
    data: sanitizeMonthlyReportValue(report.data) as Record<string, unknown>,
  };
}

function csvEscape(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return `"${String(text).replaceAll('"', '""')}"`;
}

function monthlyReportToCsv(report: MonthlyBarReport): string {
  const summary = objectFromUnknown(report.data.summary);
  const rows = [
    ["metric", "value"],
    ["venue_id", report.barId],
    ["month", report.month],
    ...Object.entries(summary).map(([key, value]) => [key, value]),
  ];
  return `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

function getMonthlyReportFilename(input: { venueId: string; month: string; format: "json" | "csv" }): string {
  const safeVenue = input.venueId.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "venue";
  return `pint-path-${safeVenue}-${input.month}-monthly-report.${input.format}`;
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
      | "REPORT_TIMEZONE"
      | "REPORT_EMAIL_MODE"
      | "ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION"
      | "SOURCE_EVIDENCE_STORAGE_DIR"
      | "SOURCE_EVIDENCE_SIGNING_SECRET"
      | "SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS"
      | "POS_WEBHOOK_SIGNING_SECRET"
      | "NODE_ENV"
      | "STRIPE_SECRET_KEY"
      | "STRIPE_WEBHOOK_SECRET"
      | "STRIPE_PRICE_MONTHLY"
      | "STRIPE_PRICE_YEARLY"
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
      throw new AppError("Your account must be active to manage a venue.", 403);
    }

    this.requireVerifiedEmail(account, "Verify your email before managing a venue.");

    if (!account.ageConfirmedAt) {
      throw new AppError("Verify your account before managing a venue. Confirm 18+ from your account page first.", 403);
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

  private requireBarSpecialsTier(account: BusinessAccount, venueId: string): void {
    if (this.isAdmin(account)) {
      return;
    }

    const membershipTier = this.repository.getBarProfile(venueId)?.membershipTier ?? "basic";
    if (!getBarTierCapabilities(membershipTier).canManageSpecials) {
      throw new AppError("Pro venue tier required to manage Pint Path specials.", 403);
    }
  }

  private requireFeaturedSpecialsTier(account: BusinessAccount, venueId: string): void {
    const membershipTier = this.repository.getBarProfile(venueId)?.membershipTier ?? "basic";
    if (!getBarTierCapabilities(membershipTier).featuredSpecials) {
      throw new AppError("Pro venue tier required for premium Pint Path special treatment.", 403);
    }
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
      beerId: input.changeType === "beer" ? normalizeTrackedBeerId(String(input.payload.beerName ?? input.targetId ?? "")) : null,
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

  private maybeQueueVenueDeleteForReview(input: {
    account: BusinessAccount;
    venueId: string;
    changeType: Exclude<BarPendingChangeType, "profile">;
    targetId: string;
    payload: Record<string, unknown>;
    suburb?: string | null | undefined;
  }) {
    if (this.isAdmin(input.account)) {
      return null;
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recentDeletes = this.repository.countRecentVenueManagerDeletes({
      userId: input.account.id,
      venueId: input.venueId,
      since: oneHourAgo,
    });
    if (recentDeletes < 3) {
      return null;
    }

    const existingPendingDelete = this.repository
      .listBarPendingChanges({ barId: input.venueId, status: "pending", limit: 100 })
      .find((change) =>
        change.action === "delete" &&
        change.changeType === input.changeType &&
        change.targetId === input.targetId
      );
    if (existingPendingDelete) {
      return {
        pendingChange: existingPendingDelete,
        message: "Delete held for admin review because several venue items were removed in the last hour.",
      };
    }

    const result = this.createPendingBarChange({
      account: input.account,
      venueId: input.venueId,
      changeType: input.changeType,
      action: "delete",
      targetId: input.targetId,
      payload: input.payload,
      suburb: input.suburb,
    });

    return {
      ...result,
      message: "Delete held for admin review because several venue items were removed in the last hour.",
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
        const membershipTier = this.repository.getBarProfile(change.barId)?.membershipTier ?? "basic";
        if (!getBarTierCapabilities(membershipTier).canManageSpecials) {
          throw new AppError("Pro venue tier required to publish Pint Path specials.", 403);
        }
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
      const membershipTier = this.repository.getBarProfile(change.barId)?.membershipTier ?? "basic";
      const capabilities = getBarTierCapabilities(membershipTier);
      if (!capabilities.canManageSpecials) {
        throw new AppError("Pro venue tier required to publish Pint Path specials.", 403);
      }
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
        startTime: stringOrNull(payload.startTime),
        endTime: stringOrNull(payload.endTime),
        scheduleNote: stringOrNull(payload.scheduleNote),
        exclusive: capabilities.featuredSpecials && booleanFromUnknown(payload.exclusive, false),
        active: booleanFromUnknown(payload.active, true),
        now,
      });
      return;
    }

    this.auditSecurity({
      actor: admin,
      action: "admin_venue_pending_change_unknown_type",
      targetType: "venue_pending_change",
      targetId: change.id,
      metadata: { changeType: change.changeType },
    });
    throw new AppError("Unsupported pending venue change type.", 400);
  }

  signup(input: AuthSignupInput, context?: SessionRequestContext | undefined) {
    const email = normalizeEmail(input.email);

    if (this.repository.getAccountByEmail(email)) {
      throw new AppError("An account already exists for that email.", 409);
    }

    const now = nowIso();
    const adminEmails = this.getAdminEmailAllowlist();
    const displayName = validatePublicDisplayName(input.displayName);
    const account = this.repository.createAccount({
      id: crypto.randomUUID(),
      email,
      passwordHash: hashPassword(input.password),
      displayName,
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
    const providerDisplayName =
      typeof metadata.full_name === "string"
        ? metadata.full_name
        : typeof metadata.name === "string"
          ? metadata.name
          : typeof metadata.display_name === "string"
            ? metadata.display_name
            : null;
    const displayName = safeProviderDisplayName(providerDisplayName);
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
        termsAcceptedAt: null,
        privacyAcceptedAt: null,
        termsVersion: null,
        privacyVersion: null,
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
    } else if (!account.supabaseUserId || account.authProvider !== "supabase" || (!account.displayName && displayName) || account.avatarUrl !== avatarUrl) {
      const nextDisplayName = account.displayName ?? displayName;
      account = this.repository.linkSupabaseAccount({
        userId: account.id,
        supabaseUserId: supabaseUser.id,
        authProvider: "supabase",
        displayName: nextDisplayName,
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

  updateDisplayName(account: BusinessAccount, input: DisplayNameUpdateInput) {
    const displayName = validatePublicDisplayName(input.displayName);
    const updated = this.repository.updateAccountDisplayName({
      userId: account.id,
      displayName,
      now: nowIso(),
    });
    this.recordUserActivity({
      account: updated,
      eventType: "display_name_updated",
      relatedEntityType: "account",
      relatedEntityId: updated.id,
      metadata: { hasDisplayName: Boolean(displayName) },
    });
    return {
      account: sanitizeAccount(updated),
      profile: this.repository.getProfileById(updated.id),
      message: displayName
        ? "Display name saved for the contributor leaderboard."
        : "Display name cleared. Your public account ID will show on the leaderboard.",
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
    const now = nowIso();
    const tokenHash = hashToken(token);
    const revoked = this.repository.revokeSession({
      tokenHash,
      revokedAt: now,
    });
    const revokedDiscountPasses = this.repository.revokeDiscountPassesForSession({
      sessionTokenHash: tokenHash,
      revokedAt: now,
    });
    this.auditSecurity({
      actor: account,
      action: "logout",
      targetType: "account",
      targetId: account.id,
      metadata: { revoked, revokedDiscountPasses },
      context,
    });
    return { revoked, revokedDiscountPasses };
  }

  logoutAll(account: BusinessAccount, context?: SessionRequestContext | undefined) {
    const now = nowIso();
    const revokedCount = this.repository.revokeUserSessions({
      userId: account.id,
      revokedAt: now,
    });
    const revokedDiscountPasses = this.repository.revokeDiscountPassesForUser({
      userId: account.id,
      revokedAt: now,
    });
    this.auditSecurity({
      actor: account,
      action: "logout_all",
      targetType: "account",
      targetId: account.id,
      metadata: { revokedCount, revokedDiscountPasses },
      context,
    });
    return { revokedCount, revokedDiscountPasses };
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
      canUseDiscountPass: hasFullAccess,
      freePreviewScope: "Happy hours plus pint prices for Guinness, Carlton Draught, and Stone & Wood Pacific Ale.",
      premiumScope: "Every verified beer price, value rings, premium filters, saved night shortcuts, discount-pass access, and venue special-discount details.",
      premiumToolkit: buildConsumerPremiumToolkit({ account }),
      premiumUntil: account?.premiumUntil ?? null,
    };
  }

  getLeaderboard(account: BusinessAccount | null, query: LeaderboardQuery) {
    const now = nowIso();
    const timezone = this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE;
    const monthKey = getZonedMonthKey(new Date(now), timezone);
    const campaign = this.getOrCreateLeaderboardPrizeCampaign(monthKey, now);
    const entries = this.repository.listLeaderboard({ period: query.period, limit: query.limit, now, monthKey });
    const me = account ? this.repository.getLeaderboardRank({ userId: account.id, period: query.period, now, monthKey }) : null;
    const podium = entries.slice(0, 3).map((entry) => ({
      ...entry,
      prizeCents: prizeAmountForRank(campaign, entry.rank),
      prizeLabel: formatAudCents(prizeAmountForRank(campaign, entry.rank)),
    }));

    if (account) {
      this.recordUserActivity({
        account,
        eventType: "leaderboard_viewed",
        relatedEntityType: "leaderboard",
        relatedEntityId: query.period,
        metadata: { period: query.period },
      });
    }

    return {
      period: query.period,
      monthKey,
      campaign: this.sanitizeLeaderboardPrizeCampaign(campaign),
      podium,
      entries,
      me,
      copy: "Leaderboard rankings count approved Pint Path contribution points only. Rejected, pending, and fraud-flagged updates do not count.",
    };
  }

  private getOrCreateLeaderboardPrizeCampaign(monthKey: string, now: string): LeaderboardPrizeCampaign {
    const existing = this.repository.getLeaderboardPrizeCampaign(monthKey);
    if (existing) {
      return existing;
    }

    const range = monthKeyRange(monthKey, this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE);
    return this.repository.upsertLeaderboardPrizeCampaign({
      monthKey,
      title: "Monthly contributor leaderboard",
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      firstPlaceCents: 10_000,
      secondPlaceCents: 5_000,
      thirdPlaceCents: 2_500,
      affiliateBar: "Affiliated Pint Path venue",
      terms: "Prizes are awarded as account vouchers after admin review. Venue redemption depends on partner availability and RSA obligations.",
      now,
    });
  }

  private sanitizeLeaderboardPrizeCampaign(campaign: LeaderboardPrizeCampaign) {
    return {
      monthKey: campaign.monthKey,
      title: campaign.title,
      startsAt: campaign.startsAt,
      endsAt: campaign.endsAt,
      firstPlaceCents: campaign.firstPlaceCents,
      secondPlaceCents: campaign.secondPlaceCents,
      thirdPlaceCents: campaign.thirdPlaceCents,
      firstPlaceLabel: formatAudCents(campaign.firstPlaceCents),
      secondPlaceLabel: formatAudCents(campaign.secondPlaceCents),
      thirdPlaceLabel: formatAudCents(campaign.thirdPlaceCents),
      affiliateBar: campaign.affiliateBar,
      terms: campaign.terms,
      status: campaign.status,
      finalizedAt: campaign.finalizedAt,
    };
  }

  getLeaderboardPrizeAdmin(_admin: BusinessAccount) {
    const now = nowIso();
    const timezone = this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE;
    const monthKey = getZonedMonthKey(new Date(now), timezone);
    const campaign = this.getOrCreateLeaderboardPrizeCampaign(monthKey, now);
    const leaderboard = this.getLeaderboard(_admin, { period: "month", limit: 25 });
    return {
      campaign: this.sanitizeLeaderboardPrizeCampaign(campaign),
      awards: this.repository.listLeaderboardPrizeAwards(campaign.monthKey),
      leaderboard,
      copy: "Edit the monthly prize amounts before finalizing. Finalization snapshots the top three and creates account vouchers once per month.",
    };
  }

  saveLeaderboardPrizeCampaign(admin: BusinessAccount, input: LeaderboardPrizeCampaignInput) {
    const now = nowIso();
    const range = monthKeyRange(input.monthKey, this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE);
    const campaign = this.repository.upsertLeaderboardPrizeCampaign({
      monthKey: input.monthKey,
      title: input.title,
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      firstPlaceCents: input.firstPlaceCents,
      secondPlaceCents: input.secondPlaceCents,
      thirdPlaceCents: input.thirdPlaceCents,
      affiliateBar: input.affiliateBar,
      terms: input.terms,
      now,
    });
    this.auditSecurity({
      actor: admin,
      action: "leaderboard_prize_campaign_saved",
      targetType: "leaderboard_prize_campaign",
      targetId: campaign.monthKey,
      metadata: {
        firstPlaceCents: campaign.firstPlaceCents,
        secondPlaceCents: campaign.secondPlaceCents,
        thirdPlaceCents: campaign.thirdPlaceCents,
      },
    });
    return {
      campaign: this.sanitizeLeaderboardPrizeCampaign(campaign),
      leaderboard: this.getLeaderboard(admin, { period: "month", limit: 25 }),
    };
  }

  finalizeLeaderboardPrizeCampaign(admin: BusinessAccount, input: LeaderboardPrizeFinalizeInput) {
    const now = nowIso();
    const campaign = this.repository.getLeaderboardPrizeCampaign(input.monthKey) ??
      this.getOrCreateLeaderboardPrizeCampaign(input.monthKey, now);
    if (campaign.status === "finalized") {
      return {
        campaign: this.sanitizeLeaderboardPrizeCampaign(campaign),
        awards: this.repository.listLeaderboardPrizeAwards(campaign.monthKey),
        vouchers: [],
        message: "This leaderboard month has already been finalized.",
      };
    }
    if (!input.force && new Date(now).getTime() < new Date(campaign.endsAt).getTime()) {
      throw new AppError("This leaderboard month is still running. Use force only after manually confirming the campaign should close early.", 400);
    }
    const entries = this.repository.listLeaderboard({
      period: "month",
      limit: 3,
      now,
      monthKey: campaign.monthKey,
    });
    const result = this.repository.finalizeLeaderboardPrizeCampaign({
      campaign,
      entries,
      finalizedBy: admin.id,
      now,
    });
    this.auditSecurity({
      actor: admin,
      action: "leaderboard_prize_campaign_finalized",
      targetType: "leaderboard_prize_campaign",
      targetId: campaign.monthKey,
      metadata: { awardCount: result.awards.length, voucherCount: result.vouchers.length },
    });
    return {
      campaign: this.sanitizeLeaderboardPrizeCampaign(result.campaign),
      awards: result.awards,
      vouchers: result.vouchers,
      message: `Finalized ${campaign.monthKey}. ${result.vouchers.length} voucher${result.vouchers.length === 1 ? "" : "s"} created.`,
    };
  }

  async planPubGolf(account: BusinessAccount, input: PubGolfPlanInput) {
    if (!isFullAccess(account)) {
      throw new AppError("Pub Golf beta planning is for premium or contributor accounts.", 403);
    }

    const start = await this.resolvePubGolfLocation(input.startLocation);
    const finish = await this.resolvePubGolfLocation(input.finishLocation);
    const requestedDrinks = input.drinks.map((drink) => drink.trim()).filter(Boolean).slice(0, 9);
    if (requestedDrinks.length !== 9) {
      throw new AppError("Choose exactly nine drinks for Pub Golf.", 400);
    }

    const candidates = this.repository.listPubGolfVenueCandidates(requestedDrinks, 16);
    const usedVenueIds = new Set<string>();
    let current = start;
    let totalDistanceMeters = 0;
    const warnings: string[] = [];

    const holes = requestedDrinks.map((drink, index) => {
      const drinkKey = normalizeBeerSearchKey(drink);
      const directMatches = candidates.filter((candidate) =>
        normalizeBeerSearchKey(candidate.beerName).includes(drinkKey) ||
        drinkKey.includes(normalizeBeerSearchKey(candidate.beerName)),
      );
      const unusedMatches = directMatches.filter((candidate) => !usedVenueIds.has(candidate.venueId));
      const pool = unusedMatches.length ? unusedMatches : directMatches;
      const chosen = this.choosePubGolfCandidate(pool, current, finish, input.mode);
      if (!chosen) {
        warnings.push(`No verified Pint Path venue currently has ${drink}.`);
        return {
          hole: index + 1,
          drink,
          status: "needs_data",
          venue: null,
          leg: {
            distanceMeters: null,
            distanceKm: null,
            guidance: "No verified match yet. Try another drink or use this as a field-test data mission.",
          },
        };
      }

      usedVenueIds.add(chosen.venueId);
      const legDistance = current && hasCoordinates(current) && hasCoordinates(chosen)
        ? Math.round(distanceMetersBetween(current, chosen))
        : null;
      if (legDistance != null) {
        totalDistanceMeters += legDistance;
      }
      current = hasCoordinates(chosen)
        ? { latitude: chosen.latitude, longitude: chosen.longitude, label: chosen.venueName, source: "venue_data" }
        : current;

      return {
        hole: index + 1,
        drink,
        status: unusedMatches.length ? "planned" : "repeat_venue",
        venue: {
          id: chosen.venueId,
          name: chosen.venueName,
          address: chosen.address,
          suburb: chosen.suburb,
          latitude: chosen.latitude,
          longitude: chosen.longitude,
          membershipTier: chosen.membershipTier,
          beerName: chosen.beerName,
          servingSize: chosen.servingSize,
          price: chosen.price,
          updatedAt: chosen.updatedAt,
          mapsUrl: this.googleMapsSearchUrl(chosen),
        },
        leg: {
          distanceMeters: legDistance,
          distanceKm: legDistance == null ? null : Number((legDistance / 1000).toFixed(2)),
          guidance: routeLegCopy(legDistance, input.mode),
        },
      };
    });

    const plannedCount = holes.filter((hole) => hole.status !== "needs_data").length;
    const completion = plannedCount === 9
      ? "Route ready"
      : `${plannedCount}/9 stops matched from verified Pint Path data`;
    const destinationLeg = current && finish && hasCoordinates(current) && hasCoordinates(finish)
      ? Math.round(distanceMetersBetween(current, finish))
      : null;
    if (destinationLeg != null) {
      totalDistanceMeters += destinationLeg;
    }

    this.recordUserActivity({
      account,
      eventType: "pub_golf_plan_generated",
      relatedEntityType: "beta_feature",
      relatedEntityId: "pub_golf",
      metadata: {
        startLocation: input.startLocation,
        finishLocation: input.finishLocation,
        plannedCount,
        mode: input.mode,
      },
    });

    return {
      status: plannedCount === 9 ? "ready" : "partial",
      completion,
      start,
      finish,
      requestedDrinks,
      holes,
      summary: {
        plannedStops: plannedCount,
        missingStops: 9 - plannedCount,
        totalDistanceMeters: Math.round(totalDistanceMeters),
        totalDistanceKm: Number((totalDistanceMeters / 1000).toFixed(2)),
        destinationLeg: destinationLeg == null
          ? null
          : {
              distanceMeters: destinationLeg,
              distanceKm: Number((destinationLeg / 1000).toFixed(2)),
              guidance: routeLegCopy(destinationLeg, input.mode),
            },
        travelMode: input.mode,
      },
      warnings,
      safetyCopy: "Plan the route before drinking, use public transport or walking, pace the night, drink water, and follow RSA rules at every venue.",
    };
  }

  private choosePubGolfCandidate(
    candidates: PubGolfVenueCandidate[],
    current: { latitude: number | null; longitude: number | null } | null,
    finish: { latitude: number | null; longitude: number | null } | null,
    mode: "auto" | "walking" | "transit",
  ): PubGolfVenueCandidate | null {
    if (!candidates.length) {
      return null;
    }

    return [...candidates].sort((left, right) => {
      const leftScore = this.pubGolfCandidateScore(left, current, finish, mode);
      const rightScore = this.pubGolfCandidateScore(right, current, finish, mode);
      return leftScore - rightScore || left.venueName.localeCompare(right.venueName);
    })[0] ?? null;
  }

  private pubGolfCandidateScore(
    candidate: PubGolfVenueCandidate,
    current: { latitude: number | null; longitude: number | null } | null,
    finish: { latitude: number | null; longitude: number | null } | null,
    mode: "auto" | "walking" | "transit",
  ): number {
    const tierScore = candidate.membershipTier === "pro" ? -150 : 0;
    if (!hasCoordinates(candidate)) {
      return 900_000 + tierScore;
    }
    const fromCurrent = current && hasCoordinates(current)
      ? distanceMetersBetween(current, candidate)
      : 0;
    const toFinish = finish && hasCoordinates(finish)
      ? distanceMetersBetween(candidate, finish)
      : 0;
    const distancePenalty = mode === "walking" ? fromCurrent * 1.25 : fromCurrent;
    return distancePenalty + toFinish * 0.28 + tierScore;
  }

  private async resolvePubGolfLocation(query: string): Promise<{ latitude: number | null; longitude: number | null; label: string; source: string } | null> {
    const normalized = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!normalized) {
      return null;
    }

    const keyed = MELBOURNE_AREA_COORDINATES[normalized] ?? MELBOURNE_AREA_COORDINATES[normalized.replace(/\s+/g, "_")];
    if (keyed) {
      return { ...keyed, source: "area_hint" };
    }

    const missionArea = this.resolveMissionAreaFromLocalCache(query);
    if (missionArea) {
      return {
        latitude: missionArea.latitude,
        longitude: missionArea.longitude,
        label: missionArea.label,
        source: missionArea.source,
      };
    }

    const venue = this.repository.listLocalVenues({ query, limit: 8 })
      .find((candidate) => typeof candidate.latitude === "number" && typeof candidate.longitude === "number");
    if (venue) {
      return {
        latitude: venue.latitude,
        longitude: venue.longitude,
        label: [venue.name, venue.suburb].filter(Boolean).join(", "),
        source: "venue_data",
      };
    }

    const googleLocation = await this.resolveMissionAreaWithGoogle(query);
    if (googleLocation) {
      return {
        latitude: googleLocation.latitude,
        longitude: googleLocation.longitude,
        label: googleLocation.label,
        source: googleLocation.source,
      };
    }

    return {
      latitude: null,
      longitude: null,
      label: query.trim(),
      source: "text_only",
    };
  }

  private googleMapsSearchUrl(candidate: PubGolfVenueCandidate): string {
    const query = [candidate.venueName, candidate.address, candidate.suburb, "Victoria Australia"]
      .filter(Boolean)
      .join(", ");
    const url = new URL("https://www.google.com/maps/search/");
    url.searchParams.set("api", "1");
    url.searchParams.set("query", query);
    return url.toString();
  }

  async getDiscountPass(account: BusinessAccount, authorizationHeader: string | undefined) {
    if (!isFullAccess(account)) {
      throw new AppError("Discount passes are for premium or contributor accounts.", 403);
    }

    const token = getBearerToken(authorizationHeader);
    if (!token) {
      throw new AppError("Login required.", 401);
    }

    const now = nowIso();
    const sessionTokenHash = hashToken(token);
    this.repository.revokeDiscountPassesForSession({ sessionTokenHash, revokedAt: now });

    let passId = "";
    let code = "";
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        code = generateDiscountCode();
        passId = crypto.randomUUID();
        this.repository.createDiscountPass({
          id: passId,
          userId: account.id,
          sessionTokenHash,
          codeHash: hashDiscountCode(code),
          createdAt: now,
          expiresAt: addMinutes(now, 30),
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError || !passId || !code) {
      throw new AppError("Could not generate a discount pass right now.", 500);
    }

    const pass = this.repository.getDiscountPassById(passId);
    if (!pass) {
      throw new AppError("Could not generate a discount pass right now.", 500);
    }

    const redeemUrl = new URL("/venue-portal.html", this.config.PUBLIC_BASE_URL);
    redeemUrl.searchParams.set("discountCode", code);
    redeemUrl.searchParams.set("accountId", account.publicAccountId);
    redeemUrl.searchParams.set("tab", "redemption");
    const qrDataUrl = await QRCode.toDataURL(redeemUrl.toString(), {
      margin: 1,
      width: 240,
    });

    this.recordUserActivity({
      account,
      eventType: "discount_pass_viewed",
      relatedEntityType: "discount_pass",
      relatedEntityId: pass.id,
      metadata: { expiresAt: pass.expiresAt },
    });

    return {
      accountId: account.publicAccountId,
      code,
      qrDataUrl,
      redeemUrl: redeemUrl.toString(),
      expiresAt: pass.expiresAt,
      validMinutes: 30,
      copy: "This code is personal, rotates per session, and should only be shown to venue staff when redeeming a Pint Path special.",
    };
  }

  private getDiscountVenueIdentity(
    venueId: string,
    assignment?: { venueName?: string | null; suburb?: string | null } | null,
    requireKnownVenue = false,
  ) {
    const profile = this.repository.getBarProfile(venueId);
    const location = this.repository.getVenueLocationCache(venueId);
    const activeAssignment = assignment
      ? null
      : this.repository.listVenueManagerAssignments({ venueId, activeOnly: true, limit: 1 })[0] ?? null;

    if (requireKnownVenue && !profile && !location && !assignment && !activeAssignment) {
      throw new AppError("Venue is not configured for Pint Path POS redemptions.", 404);
    }

    return {
      venueName: assignment?.venueName ?? profile?.name ?? location?.venueName ?? activeAssignment?.venueName ?? venueId,
      suburb: assignment?.suburb ?? profile?.suburb ?? location?.suburb ?? activeAssignment?.suburb ?? null,
    };
  }

  private redeemDiscountPassForVenue(input: {
    actor: BusinessAccount | null;
    venueId: string;
    venueName: string;
    suburb: string | null;
    code: string;
    specialId: string | null;
    itemName: string | null;
    quantity: number;
    estimatedSavingsCents: number;
    notes?: string | null | undefined;
    source: "venue_portal" | "pos_webhook";
    redeemedByRole: string;
    posReference?: string | null | undefined;
    terminalId?: string | null | undefined;
    posRedeemedAt?: string | null | undefined;
    metadata?: Record<string, unknown> | undefined;
    context?: SessionRequestContext | undefined;
  }) {
    const now = nowIso();
    const pass = this.repository.getActiveDiscountPassByCodeHash({
      codeHash: hashDiscountCode(input.code),
      now,
    });

    if (!pass) {
      throw new AppError("Discount code expired or not found. Ask the user to refresh their Pint Path discount pass.", 404);
    }

    const user = this.repository.getAccountById(pass.userId);
    if (!user || !isFullAccess(user)) {
      throw new AppError("This account does not currently have discount access.", 403);
    }

    const redemption = this.repository.createDiscountRedemption({
      id: crypto.randomUUID(),
      userId: user.id,
      publicAccountId: user.publicAccountId,
      venueId: input.venueId,
      venueName: input.venueName,
      suburb: input.suburb,
      specialId: input.specialId,
      itemName: input.itemName,
      quantity: input.quantity,
      estimatedSavingsCents: input.estimatedSavingsCents,
      discountPassId: pass.id,
      redeemedByUserId: input.actor?.id ?? null,
      redeemedAt: now,
      metadata: sanitizeEventMetadata(redactSecrets({
        ...input.metadata,
        notes: input.notes,
        source: input.source,
        redeemedByRole: input.redeemedByRole,
        posReference: input.posReference,
        terminalId: input.terminalId,
        posRedeemedAt: input.posRedeemedAt,
      })),
    });

    const pintPointRecord = this.repository.createPintPointDrinkRecord({
      id: crypto.randomUUID(),
      userId: user.id,
      venueId: input.venueId,
      venueName: input.venueName,
      suburb: input.suburb,
      itemName: input.itemName,
      beverageCategory: "alcoholic",
      quantity: input.quantity,
      isAlcoholic: true,
      source: input.source,
      recordedByUserId: input.actor?.id ?? null,
      recordedAt: now,
      metadata: sanitizeEventMetadata(redactSecrets({
        discountRedemptionId: redemption.id,
        discountPassId: pass.id,
        specialId: input.specialId,
        source: input.source,
        redeemedByRole: input.redeemedByRole,
        posReference: input.posReference,
        terminalId: input.terminalId,
      })),
    });
    const pointsEarned = input.quantity;

    this.repository.markDiscountPassUsed({ id: pass.id, lastUsedAt: now });
    this.recordUserActivity({
      account: user,
      eventType: "discount_redeemed",
      relatedEntityType: "venue",
      relatedEntityId: input.venueId,
      metadata: {
        venueName: input.venueName,
        suburb: input.suburb,
        itemName: input.itemName,
        quantity: input.quantity,
        estimatedSavingsCents: input.estimatedSavingsCents,
        source: input.source,
      },
    });
    this.recordUserActivity({
      account: user,
      eventType: "pint_point_drink_recorded",
      relatedEntityType: "venue",
      relatedEntityId: input.venueId,
      metadata: {
        venueName: input.venueName,
        suburb: input.suburb,
        itemName: input.itemName,
        quantity: input.quantity,
        pointsEarned,
        source: input.source,
        discountRedemptionId: redemption.id,
      },
    });
    this.auditSecurity({
      actor: input.actor,
      action: "discount_redeemed",
      targetType: "venue",
      targetId: input.venueId,
      metadata: {
        publicAccountId: user.publicAccountId,
        itemName: input.itemName,
        quantity: input.quantity,
        estimatedSavingsCents: input.estimatedSavingsCents,
        pointsEarned,
        pintPointDrinkRecordId: pintPointRecord.id,
        source: input.source,
        posReference: input.posReference,
      },
      context: input.context,
    });

    return {
      redemption,
      accountId: user.publicAccountId,
      venueId: input.venueId,
      venueName: input.venueName,
      suburb: input.suburb,
      estimatedSavingsDollars: Number((redemption.estimatedSavingsCents / 100).toFixed(2)),
      pointsEarned,
      copy: "Redemption logged and Pint Points added automatically.",
    };
  }

  redeemDiscountPass(account: BusinessAccount, venueId: string, input: DiscountRedemptionInput) {
    const assignment = this.requireAssignedVenue(account, venueId);
    const venue = this.getDiscountVenueIdentity(venueId, assignment);
    return this.redeemDiscountPassForVenue({
      actor: account,
      venueId,
      venueName: venue.venueName,
      suburb: venue.suburb,
      code: input.code,
      specialId: input.specialId,
      itemName: input.itemName,
      quantity: input.quantity,
      estimatedSavingsCents: input.estimatedSavingsCents,
      notes: input.notes,
      source: "venue_portal",
      redeemedByRole: account.role,
    });
  }

  getVenuePosIntegration(account: BusinessAccount, venueId: string) {
    const assignment = this.requireAssignedVenue(account, venueId);
    const venue = this.getDiscountVenueIdentity(venueId, assignment);
    const endpoint = new URL("/api/business/pos/discount-redemptions", this.config.PUBLIC_BASE_URL).toString();
    const membershipTier = this.repository.getBarProfile(venueId)?.membershipTier ?? "basic";
    const tierCapabilities = getBarTierCapabilities(membershipTier);
    const token = this.config.POS_WEBHOOK_SIGNING_SECRET && tierCapabilities.posWebhookIntegration
      ? createPosWebhookToken(this.config.POS_WEBHOOK_SIGNING_SECRET, venueId)
      : null;

    return {
      enabled: Boolean(token),
      tier: membershipTier,
      proRequired: !tierCapabilities.posWebhookIntegration,
      venueId,
      venueName: venue.venueName,
      suburb: venue.suburb,
      endpoint,
      method: "POST",
      authHeader: "X-Pint-Path-POS-Token",
      token,
      tokenPreview: token ? `${token.slice(0, 8)}...${token.slice(-8)}` : null,
      payloadExample: {
        venueId,
        code: "ABC123",
        specialId: "special_venue_offer_id",
        itemName: "House pint",
        quantity: 1,
        discountAmountCents: 200,
        posReference: "receipt-12345",
        terminalId: "front-bar-1",
      },
      copy: tierCapabilities.posWebhookIntegration
        ? token
          ? "Give this endpoint and token only to the venue POS integration. It can redeem one user code at this venue and records item, quantity, savings and server time."
          : "POS webhooks are disabled until POS_WEBHOOK_SIGNING_SECRET is configured on the server. Manual staff redemption still works."
        : "POS webhook automation is a Pro venue feature. Staff can still redeem codes manually from the portal.",
    };
  }

  redeemDiscountPassFromPos(
    input: PosDiscountRedemptionInput,
    token: string | undefined,
    context?: SessionRequestContext | undefined,
  ) {
    const secret = this.config.POS_WEBHOOK_SIGNING_SECRET;
    if (!secret) {
      throw new AppError("Pint Path POS webhooks are not configured yet.", 503);
    }

    const suppliedToken = token?.trim() ?? "";
    const expectedToken = createPosWebhookToken(secret, input.venueId);
    if (!suppliedToken || !timingSafeStringEqual(expectedToken, suppliedToken)) {
      this.auditSecurity({
        actor: null,
        action: "pos_discount_redeem_blocked",
        targetType: "venue",
        targetId: input.venueId,
        metadata: { reason: "invalid_pos_token" },
        context,
      });
      throw new AppError("Invalid POS webhook token.", 401);
    }

    const venue = this.getDiscountVenueIdentity(input.venueId, null, true);
    const membershipTier = this.repository.getBarProfile(input.venueId)?.membershipTier ?? "basic";
    const capabilities = getBarTierCapabilities(membershipTier);
    if (!capabilities.posWebhookIntegration) {
      throw new AppError("Pro venue tier required for POS webhook redemptions.", 403);
    }

    return this.redeemDiscountPassForVenue({
      actor: null,
      venueId: input.venueId,
      venueName: venue.venueName,
      suburb: venue.suburb,
      code: input.code,
      specialId: input.specialId,
      itemName: input.itemName,
      quantity: input.quantity,
      estimatedSavingsCents: input.estimatedSavingsCents ?? input.discountAmountCents,
      source: "pos_webhook",
      redeemedByRole: "pos_webhook",
      posReference: input.posReference,
      terminalId: input.terminalId,
      posRedeemedAt: input.redeemedAt ?? null,
      metadata: input.metadata,
      context,
    });
  }

  private expirePintPointRewardCodesForAccount(accountId: string, now = nowIso()) {
    this.repository.expireFreePintRewardCodesForUser({ userId: accountId, now });
  }

  private getPintPointWalletForAccount(account: BusinessAccount, now = nowIso()) {
    this.expirePintPointRewardCodesForAccount(account.id, now);
    const balance = this.repository.getPintPointBalance(account.id);
    const rewardProgress = Math.min(FREE_PINT_REWARD_POINTS, balance.available);
    const activeCodes = this.repository
      .listFreePintRewardCodesForUser(account.id, 10)
      .filter((code) => code.status === "active" && code.expiresAt > now);
    const recentDrinkRecords = this.repository.listPintPointDrinkRecordsForUser(account.id, 10);
    const recentLedger = this.repository.listPintPointLedgerForUser(account.id, 20);
    const rewardRedemptions = this.repository.listFreePintRewardRedemptionsForUser(account.id, 10);

    return {
      balance: balance.balance,
      reserved: balance.reserved,
      available: balance.available,
      lifetimeEarned: balance.lifetimeEarned,
      lifetimeRedeemed: balance.lifetimeRedeemed,
      threshold: FREE_PINT_REWARD_POINTS,
      progress: rewardProgress,
      pointsUntilReward: Math.max(0, FREE_PINT_REWARD_POINTS - balance.available),
      rewardAvailable: balance.available >= FREE_PINT_REWARD_POINTS,
      activeCodes: activeCodes.map((code) => ({
        id: code.id,
        status: code.status,
        expiresAt: code.expiresAt,
        pointsReserved: code.pointsReserved,
      })),
      recentDrinkRecords,
      recentLedger,
      rewardRedemptions,
      copy: {
        earnRule: "Earn 1 Pint Point for each alcoholic beverage recorded at a venue.",
        rewardRule: "50 Pint Points unlocks 1 Free Pint Reward at affiliated bars.",
        freePintRule: "Free Pint Reward redemptions do not earn Pint Points.",
      },
    };
  }

  private resolvePintPointUser(input: { code?: string | undefined; accountId?: string | null | undefined; now: string }) {
    if (input.code) {
      const pass = this.repository.getActiveDiscountPassByCodeHash({
        codeHash: hashDiscountCode(input.code),
        now: input.now,
      });
      if (!pass) {
        throw new AppError("Pint Path code expired or not found. Ask the user to refresh their code.", 404);
      }
      const user = this.repository.getAccountById(pass.userId);
      if (!user) {
        throw new AppError("Pint Path account not found.", 404);
      }
      return user;
    }

    if (input.accountId) {
      const user = this.repository.getAccountByPublicAccountId(input.accountId);
      if (!user) {
        throw new AppError("Pint Path account ID not found.", 404);
      }
      return user;
    }

    throw new AppError("Enter a Pint Path code or public account ID.", 400);
  }

  async createFreePintRewardCode(account: BusinessAccount, input: FreePintRewardCodeInput) {
    if (account.status !== "active") {
      throw new AppError("Suspended accounts cannot create Free Pint Reward codes.", 403);
    }

    const now = nowIso();
    const wallet = this.getPintPointWalletForAccount(account, now);
    if (wallet.available < FREE_PINT_REWARD_POINTS) {
      throw new AppError(`${FREE_PINT_REWARD_POINTS} Pint Points are required for a Free Pint Reward.`, 403);
    }

    let code = "";
    let rewardCodeId = "";
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        code = generateDiscountCode();
        rewardCodeId = crypto.randomUUID();
        this.repository.createFreePintRewardCode({
          id: rewardCodeId,
          userId: account.id,
          publicAccountId: account.publicAccountId,
          codeHash: hashDiscountCode(code),
          createdAt: now,
          expiresAt: addMinutes(now, FREE_PINT_REWARD_CODE_MINUTES),
          metadata: {
            requestedVenueId: input.venueId,
            reward: "free_pint",
          },
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError || !code || !rewardCodeId) {
      throw new AppError("Could not create a Free Pint Reward code right now.", 500);
    }

    const rewardCode = this.repository.getFreePintRewardCodeById(rewardCodeId);
    if (!rewardCode) {
      throw new AppError("Could not create a Free Pint Reward code right now.", 500);
    }

    const redeemUrl = new URL("/venue-portal.html", this.config.PUBLIC_BASE_URL);
    redeemUrl.searchParams.set("freePintCode", code);
    redeemUrl.searchParams.set("accountId", account.publicAccountId);
    redeemUrl.searchParams.set("tab", "redemption");
    if (input.venueId) {
      redeemUrl.searchParams.set("venueId", input.venueId);
    }

    const qrDataUrl = await QRCode.toDataURL(redeemUrl.toString(), {
      margin: 1,
      width: 240,
    });

    this.recordUserActivity({
      account,
      eventType: "free_pint_reward_code_created",
      relatedEntityType: "free_pint_reward",
      relatedEntityId: rewardCode.id,
      metadata: { expiresAt: rewardCode.expiresAt },
    });

    const updatedWallet = this.getPintPointWalletForAccount(account, now);
    return {
      accountId: account.publicAccountId,
      code,
      qrDataUrl,
      redeemUrl: redeemUrl.toString(),
      expiresAt: rewardCode.expiresAt,
      validMinutes: FREE_PINT_REWARD_CODE_MINUTES,
      pointsReserved: FREE_PINT_REWARD_POINTS,
      wallet: updatedWallet,
      copy: "Show this one-time Free Pint Reward code to staff at an affiliated Pint Path bar. Venue staff must still complete age, ID, and responsible service checks.",
    };
  }

  recordPintPointDrink(account: BusinessAccount, venueId: string, input: PintPointDrinkRecordInput) {
    const assignment = this.requireAssignedVenue(account, venueId);
    const venue = this.getDiscountVenueIdentity(venueId, assignment);
    const now = nowIso();
    const user = this.resolvePintPointUser({
      code: input.code,
      accountId: input.accountId,
      now,
    });

    if (user.status !== "active") {
      throw new AppError("This Pint Path account cannot receive Pint Points right now.", 403);
    }

    const isAlcoholic = input.isAlcoholic ?? input.beverageCategory === "alcoholic";
    const record = this.repository.createPintPointDrinkRecord({
      id: crypto.randomUUID(),
      userId: user.id,
      venueId,
      venueName: venue.venueName,
      suburb: venue.suburb,
      itemName: input.itemName,
      beverageCategory: input.beverageCategory,
      quantity: input.quantity,
      isAlcoholic,
      source: "venue_portal",
      recordedByUserId: account.id,
      recordedAt: now,
      metadata: {
        notes: input.notes,
        enteredByRole: account.role,
      },
    });

    const wallet = this.getPintPointWalletForAccount(user, now);
    const pointsEarned = isAlcoholic ? input.quantity : 0;
    this.recordUserActivity({
      account: user,
      eventType: "pint_point_drink_recorded",
      relatedEntityType: "venue",
      relatedEntityId: venueId,
      metadata: {
        venueName: venue.venueName,
        suburb: venue.suburb,
        itemName: input.itemName,
        quantity: input.quantity,
        pointsEarned,
      },
    });
    this.auditSecurity({
      actor: account,
      action: "pint_point_drink_recorded",
      targetType: "venue",
      targetId: venueId,
      metadata: {
        publicAccountId: user.publicAccountId,
        quantity: input.quantity,
        pointsEarned,
        beverageCategory: input.beverageCategory,
      },
    });

    return {
      record,
      accountId: user.publicAccountId,
      pointsEarned,
      wallet,
      copy: pointsEarned > 0
        ? `Nice — you earned ${pointsEarned} Pint Point${pointsEarned === 1 ? "" : "s"}.`
        : "Recorded. Food and non-alcoholic drinks do not earn Pint Points.",
      progressCopy: `You now have ${wallet.available} / ${FREE_PINT_REWARD_POINTS} Pint Points.`,
      rewardCopy: wallet.pointsUntilReward === 0
        ? "You have enough Pint Points for a Free Pint Reward."
        : `${wallet.pointsUntilReward} Pint Point${wallet.pointsUntilReward === 1 ? "" : "s"} until your Free Pint Reward.`,
    };
  }

  handleFreePintRewardCode(account: BusinessAccount, venueId: string, input: FreePintRewardDecisionInput) {
    const assignment = this.requireAssignedVenue(account, venueId);
    const venue = this.getDiscountVenueIdentity(venueId, assignment);
    const profile = this.repository.getBarProfile(venueId);
    const tier = profile?.membershipTier ?? "basic";
    const capabilities = getBarTierCapabilities(tier, this.isAdmin(account));

    if (!capabilities.canManageSpecials) {
      throw new AppError("Free Pint Rewards can only be redeemed at affiliated Pro Pint Path venues.", 403);
    }

    const now = nowIso();
    const codeHash = hashDiscountCode(input.code);
    const code = this.repository.getFreePintRewardCodeByCodeHash(codeHash);
    if (!code) {
      throw new AppError("Free Pint Reward code not found.", 404);
    }

    if (code.status === "active" && code.expiresAt <= now) {
      this.repository.expireFreePintRewardCodesForUser({ userId: code.userId, now });
      throw new AppError("Free Pint Reward code has expired. Ask the user to generate a new one.", 410);
    }

    if (code.status !== "active") {
      throw new AppError(`Free Pint Reward code is already ${code.status}.`, 409);
    }

    const user = this.repository.getAccountById(code.userId);
    if (!user || user.status !== "active") {
      throw new AppError("This Pint Path account cannot redeem rewards right now.", 403);
    }

    const wallet = this.repository.getPintPointBalance(user.id);
    if (wallet.balance < FREE_PINT_REWARD_POINTS || wallet.reserved < FREE_PINT_REWARD_POINTS) {
      throw new AppError("This Free Pint Reward no longer has enough reserved Pint Points.", 409);
    }

    if (input.action === "reject") {
      const rejected = this.repository.rejectFreePintRewardCode({
        codeId: code.id,
        venueId,
        actorUserId: account.id,
        reason: input.reason,
        now,
        metadata: {
          venueName: venue.venueName,
          suburb: venue.suburb,
        },
      });
      return {
        status: "rejected",
        code: rejected,
        accountId: user.publicAccountId,
        venueId,
        venueName: venue.venueName,
        wallet: this.getPintPointWalletForAccount(user, now),
        copy: "Free Pint Reward rejected and reserved Pint Points released.",
      };
    }

    const redemption = this.repository.redeemFreePintRewardCode({
      codeId: code.id,
      userId: user.id,
      publicAccountId: user.publicAccountId,
      venueId,
      venueName: venue.venueName,
      suburb: venue.suburb,
      redeemedByUserId: account.id,
      redeemedAt: now,
      metadata: {
        instruction: "Serve only if age, ID and responsible service checks are satisfied.",
      },
    });

    if (!redemption) {
      throw new AppError("Free Pint Reward could not be redeemed. Refresh and try again.", 409);
    }

    this.recordUserActivity({
      account: user,
      eventType: "free_pint_reward_redeemed",
      relatedEntityType: "venue",
      relatedEntityId: venueId,
      metadata: {
        venueName: venue.venueName,
        suburb: venue.suburb,
        rewardCodeId: code.id,
      },
    });
    this.auditSecurity({
      actor: account,
      action: "free_pint_reward_redeemed",
      targetType: "venue",
      targetId: venueId,
      metadata: {
        publicAccountId: user.publicAccountId,
        rewardCodeId: code.id,
      },
    });

    return {
      status: "redeemed",
      redemption,
      accountId: user.publicAccountId,
      venueId,
      venueName: venue.venueName,
      wallet: this.getPintPointWalletForAccount(user, now),
      title: "Valid Pint Path Reward",
      reward: "Free Pint Reward",
      instruction: "Serve only if age, ID and responsible service checks are satisfied.",
      copy: "Free Pint Reward redeemed. No Pint Point is earned for this free pint.",
    };
  }

  private getVenueDiscountSummary(input: {
    venueId: string;
    startIso?: string | null | undefined;
    endIso?: string | null | undefined;
    includeRecent?: boolean | undefined;
    recentLimit?: number | undefined;
  }) {
    const stats = this.repository.getDiscountRedemptionStatsForVenue({
      venueId: input.venueId,
      startIso: input.startIso,
      endIso: input.endIso,
    });
    const topItems = this.repository.listDiscountItemStatsForVenue({
      venueId: input.venueId,
      startIso: input.startIso,
      endIso: input.endIso,
      limit: 8,
    });
    const recentRedemptions = input.includeRecent
      ? this.repository.listDiscountRedemptionsForVenue(input.venueId, input.recentLimit ?? 10).map((redemption) => ({
          id: redemption.id,
          accountId: redemption.publicAccountId,
          itemName: redemption.itemName,
          quantity: redemption.quantity,
          estimatedSavingsCents: redemption.estimatedSavingsCents,
          estimatedSavingsDollars: Number((redemption.estimatedSavingsCents / 100).toFixed(2)),
          redeemedAt: redemption.redeemedAt,
          source: typeof redemption.metadata.source === "string" ? redemption.metadata.source : "venue_portal",
          posReference: typeof redemption.metadata.posReference === "string" ? redemption.metadata.posReference : null,
        }))
      : [];

    return {
      ...stats,
      estimatedSavingsDollars: Number((stats.estimatedSavingsCents / 100).toFixed(2)),
      topItems: topItems.map((item) => ({
        ...item,
        estimatedSavingsDollars: Number((item.estimatedSavingsCents / 100).toFixed(2)),
      })),
      recentRedemptions,
      copy: "Discount data is created only when a user shows a rotating Pint Path code or QR. Venue reporting uses aggregate redemption counts, items and savings.",
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
        isNewVenue: Boolean(submission.pendingVenue),
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
    const dashboardNow = nowIso();
    const timezone = this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE;
    const monthKey = getZonedMonthKey(new Date(dashboardNow), timezone);
    const campaign = this.getOrCreateLeaderboardPrizeCampaign(monthKey, dashboardNow);
    const leaderboardRank = this.repository.getLeaderboardRank({ userId: account.id, period: "month", now: dashboardNow, monthKey });
    const leaderboardEntries = this.repository.listLeaderboard({ period: "month", limit: 25, now: dashboardNow, monthKey });
    const discountStats = this.repository.getDiscountRedemptionStats(account.id);
    const recentDiscountRedemptions = this.repository.listDiscountRedemptionsForUser(account.id, 10);
    const rewardVouchers = this.repository.listAccountRewardVouchers(account.id, 10);
    const pintPointsWallet = this.getPintPointWalletForAccount(account, dashboardNow);
    const hasFullAccess = isFullAccess(account);

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
      premiumMemberToolkit: buildConsumerPremiumToolkit({
        account,
        savedItems,
        preferences,
        discountStats,
      }),
      contributorProgress: {
        pointsThisMonth: roundPoints(account.contributionPointsCurrentMonth),
        unlockThreshold: this.config.CONTRIBUTOR_UNLOCK_POINTS,
        pointsNeeded: roundPoints(Math.max(0, this.config.CONTRIBUTOR_UNLOCK_POINTS - account.contributionPointsCurrentMonth)),
        unlockCopy: "Earn 15 approved points in a month to unlock premium until the end of that month.",
      },
      leaderboard: {
        accountId: account.publicAccountId,
        monthRank: leaderboardRank,
        monthKey,
        campaign: this.sanitizeLeaderboardPrizeCampaign(campaign),
        podium: leaderboardEntries.slice(0, 3).map((entry) => ({
          ...entry,
          prizeCents: prizeAmountForRank(campaign, entry.rank),
          prizeLabel: formatAudCents(prizeAmountForRank(campaign, entry.rank)),
        })),
        entries: leaderboardEntries,
        copy: "Leaderboard counts approved contribution points only.",
      },
      discounts: {
        eligible: isFullAccess(account),
        totalRedemptions: discountStats.totalRedemptions,
        estimatedSavingsCents: discountStats.estimatedSavingsCents,
        estimatedSavingsDollars: Number((discountStats.estimatedSavingsCents / 100).toFixed(2)),
        uniqueVenues: discountStats.uniqueVenues,
        recentRedemptions: recentDiscountRedemptions,
        copy: "Discount redemptions are logged only when you show your rotating code or QR at a venue.",
      },
      pintPoints: pintPointsWallet,
      rewards: {
        status: rewardVouchers.length ? "active" : "leaderboard_monthly",
        eligiblePlaceholder: canAccessAgeGatedRewards({ account, latestAgeVerification }),
        ageGatedEligible: canAccessAgeGatedRewards({ account, latestAgeVerification }),
        ageThreshold: 18,
        vouchers: rewardVouchers.map((voucher) => ({
          ...voucher,
          amountDollars: Number((voucher.amountCents / 100).toFixed(2)),
          amountLabel: formatAudCents(voucher.amountCents),
        })),
      },
      betaTesting: {
        enabled: hasFullAccess,
        label: hasFullAccess ? "BetaTesting unlocked" : "Premium feature",
        leaderboard: {
          monthKey,
          campaign: this.sanitizeLeaderboardPrizeCampaign(campaign),
          podium: leaderboardEntries.slice(0, 3).map((entry) => ({
            ...entry,
            prizeCents: prizeAmountForRank(campaign, entry.rank),
            prizeLabel: formatAudCents(prizeAmountForRank(campaign, entry.rank)),
          })),
          entries: leaderboardEntries,
          me: leaderboardRank,
        },
        pubGolf: {
          enabled: hasFullAccess,
          defaultDrinks: PUB_GOLF_DEFAULT_DRINKS,
          copy: "Build a nine-stop Pub Golf route from real venue drink data. Beta routing uses Pint Path venue coordinates with walking/transit hints.",
        },
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

    const pendingVenue = this.normalizePendingVenue(input);
    const venueLocation = pendingVenue?.latitude != null && pendingVenue.longitude != null
      ? {
          latitude: pendingVenue.latitude,
          longitude: pendingVenue.longitude,
        }
      : this.repository.getVenueLocationCache(input.venueId);
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

  private normalizePendingVenue(input: CreateSubmissionInput): PendingVenueDetails | null {
    if (!input.newVenue) {
      return null;
    }

    return {
      googlePlaceId: input.newVenue.googlePlaceId,
      name: input.newVenue.name.trim(),
      address: input.newVenue.address,
      suburb: input.newVenue.suburb ?? input.suburb,
      state: input.newVenue.state ?? "VIC",
      postcode: input.newVenue.postcode,
      phone: input.newVenue.phone,
      website: input.newVenue.website,
      latitude: input.newVenue.latitude,
      longitude: input.newVenue.longitude,
    };
  }

  private assertPendingVenueIsNotKnownDuplicate(pendingVenue: PendingVenueDetails | null): void {
    if (!pendingVenue) {
      return;
    }

    const duplicate = this.repository.findLikelyVenueDuplicate({
      name: pendingVenue.name,
      suburb: pendingVenue.suburb,
    });
    if (!duplicate) {
      return;
    }

    const suburbCopy = duplicate.suburb ? ` in ${duplicate.suburb}` : "";
    throw new AppError(
      `${duplicate.venueName}${suburbCopy} already appears to be on Pint Path. Search and choose the existing venue, then submit the beer or happy-hour data there.`,
      409,
    );
  }

  private mergeVenueRows(primary: VenueRow[], secondary: VenueRow[], limit: number): VenueRow[] {
    const merged = new Map<string, VenueRow>();
    [...primary, ...secondary].forEach((venue) => {
      merged.set(venue.id, {
        ...venue,
        ...this.getPublicVenueTierMetadata(venue.id),
      });
    });
    return Array.from(merged.values()).slice(0, limit);
  }

  private assertAccountCanSubmit(account: BusinessAccount, options: { allowVenueManager?: boolean } = {}): void {
    if (account.status === "suspended") {
      throw new AppError("Suspended accounts cannot submit reward-eligible data.", 403);
    }

    if (account.role === "venue_manager" && !options.allowVenueManager) {
      throw new AppError("Venue accounts use the venue dashboard instead of reward submissions.", 403);
    }

    this.requireVerifiedEmail(account, "Verify your email before uploading venue data.");

    if (!account.ageConfirmedAt) {
      throw new AppError("Please confirm you are 18+ before submitting venue data.", 403);
    }
  }

  private createVerifiedGoogleVenueId(googlePlaceId: string): string {
    const hash = crypto.createHash("sha256").update(googlePlaceId).digest("hex").slice(0, 24);
    return `venue-google-${hash}`;
  }

  private async withVerifiedPendingGoogleVenue(
    account: BusinessAccount,
    input: CreateSubmissionInput,
  ): Promise<CreateSubmissionInput> {
    if (!input.newVenue) {
      return input;
    }

    const googlePlaceId = input.newVenue.googlePlaceId?.trim();
    if (!googlePlaceId) {
      throw new AppError("Choose the new venue from Google Maps before submitting. Manual entry is only available after a Google venue is selected.", 400);
    }

    const result = await this.getVenuePlaceForSubmission(account, googlePlaceId);
    if (!result.configured) {
      throw new AppError("New venue submissions require Google Places lookup. Set GOOGLE_PLACES_API_KEY on the server.", 503);
    }

    const place = result.place;
    if (!place) {
      throw new AppError("That Google result is not eligible for Pint Path. Choose a bar, pub, restaurant, brewery, or night club.", 400);
    }

    if (place.alreadyExists && place.existingVenue) {
      const suburbCopy = place.existingVenue.suburb ? ` in ${place.existingVenue.suburb}` : "";
      throw new AppError(
        `${place.existingVenue.name}${suburbCopy} is already on Pint Path. Search and choose the existing venue, then submit the beer or happy-hour data there.`,
        409,
      );
    }

    return {
      ...input,
      venueId: this.createVerifiedGoogleVenueId(place.googlePlaceId),
      venueName: place.name,
      suburb: place.suburb,
      newVenue: {
        googlePlaceId: place.googlePlaceId,
        name: place.name,
        address: place.address,
        suburb: place.suburb,
        state: place.state ?? "VIC",
        postcode: place.postcode,
        phone: place.phone,
        website: place.website,
        latitude: place.latitude,
        longitude: place.longitude,
      },
    };
  }

  private shouldPublishSubmittedVenueImmediately(pendingVenue: PendingVenueDetails | null): boolean {
    return Boolean(pendingVenue?.googlePlaceId);
  }

  async createUserSubmission(account: BusinessAccount, input: CreateSubmissionInput) {
    this.assertAccountCanSubmit(account);
    const verifiedInput = await this.withVerifiedPendingGoogleVenue(account, input);
    return this.createSubmission(account, verifiedInput);
  }

  createSubmission(account: BusinessAccount, input: CreateSubmissionInput, options: { allowVenueManager?: boolean; rewardEligible?: boolean } = {}) {
    this.assertAccountCanSubmit(account, { allowVenueManager: options.allowVenueManager === true });
    const rewardEligible = options.rewardEligible ?? true;

    if (input.clientSubmissionId) {
      const existingSubmission = this.repository.getSubmissionByClientSubmissionId(account.id, input.clientSubmissionId);
      if (existingSubmission) {
        return {
          submission: existingSubmission.submission,
          statusCopy: `${existingSubmission.submission.venueName} is already saved for review from this device.`,
          ocrStatus: existingSubmission.submission.sourcePhotoUrl ? "queued_for_review" : "not_requested",
          idempotentReplay: true,
        };
      }
    }

    const now = nowIso();
    const pendingVenue = this.normalizePendingVenue(input);
    this.assertPendingVenueIsNotKnownDuplicate(pendingVenue);
    const sourcePhotoUrl = this.resolveSourcePhoto(account, input);
    const rawLocationEligibility = this.getSubmissionLocationEligibility(input);
    const locationEligibility = rewardEligible
      ? rawLocationEligibility
      : {
          ...rawLocationEligibility,
          pointsEligibleByLocation: false,
          pointsEligibilityReason: "venue_manager_not_reward_eligible",
        };
    const submission = this.repository.createSubmission({
      id: crypto.randomUUID(),
      clientSubmissionId: input.clientSubmissionId,
      userId: account.id,
      venueId: input.venueId,
      venueName: pendingVenue?.name ?? input.venueName,
      suburb: pendingVenue?.suburb ?? input.suburb,
      submissionType: input.submissionType,
      observedAt: input.observedAt,
      sourcePhotoUrl,
      notes: input.notes,
      now,
      ...locationEligibility,
      pendingVenue,
      items: input.items.map((item) => {
        const beerName = canonicalizeTrackedBeerName(item.beerName);
        return {
          id: crypto.randomUUID(),
          beerName,
          normalizedBeerId: normalizeTrackedBeerId(beerName),
          servingSize: item.servingSize,
          price: item.price,
          isHappyHourPrice: item.isHappyHourPrice,
          happyHourDetails: item.happyHourDetails,
          isOnTap: item.isOnTap,
          confidence: sourcePhotoUrl ? 0.72 : 0.52,
        };
      }),
    });
    const publishedVenueImmediately = this.shouldPublishSubmittedVenueImmediately(pendingVenue);

    if (publishedVenueImmediately) {
      this.repository.publishPendingVenue({
        venueId: submission.venueId,
        venueName: submission.venueName,
        suburb: submission.suburb,
        pendingVenue,
        now,
      });
    }

    const firstItemBeerName = input.items[0] ? canonicalizeTrackedBeerName(input.items[0].beerName) : null;
    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "submission_completed",
      venueId: submission.venueId,
      beerId: firstItemBeerName ? normalizeTrackedBeerId(firstItemBeerName) : null,
      suburb: submission.suburb,
      metadata: {
        submissionId: submission.id,
        submissionType: submission.submissionType,
        itemCount: input.items.length,
        hasSourcePhoto: Boolean(sourcePhotoUrl),
        pointsEligibleByLocation: submission.pointsEligibleByLocation,
        rewardEligible,
        newVenue: Boolean(pendingVenue),
        venuePublishedImmediately: publishedVenueImmediately,
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
        rewardEligible,
        newVenue: Boolean(pendingVenue),
        venuePublishedImmediately: publishedVenueImmediately,
      },
    });

    return {
      submission,
      statusCopy: publishedVenueImmediately
        ? "Venue added to the public map. Beer data is saved for review before prices appear publicly."
        : pendingVenue
        ? "New venue and beer data submitted for admin review. It will appear on the global map only after approval."
        : !rewardEligible
        ? "Venue update submitted for review. Venue-manager updates do not earn contributor points."
        : submission.pointsEligibleByLocation
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

      if (this.config.NODE_ENV === "production" && !this.config.ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION) {
        const evidence = this.createFilesystemSourceEvidence(account, bytes, mimeType);
        return privateEvidenceRef(evidence.id);
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

  private getSourceEvidenceStorageRoot(): string {
    return this.config.SOURCE_EVIDENCE_STORAGE_DIR;
  }

  private getSourceEvidenceFilePath(objectPath: string): string {
    const safePath = safeRelativeEvidencePath(objectPath);
    if (!safePath) {
      throw new AppError("Source evidence not found.", 404);
    }

    const root = path.resolve(this.getSourceEvidenceStorageRoot());
    const filePath = path.resolve(root, safePath);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      throw new AppError("Source evidence not found.", 404);
    }
    return filePath;
  }

  private createFilesystemSourceEvidence(
    account: Pick<BusinessAccount, "id"> | null,
    bytes: Buffer,
    mimeType: string,
  ): SourceEvidenceObject {
    const id = crypto.randomUUID();
    const monthKey = getZonedMonthKey(new Date(nowIso()), this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE);
    const objectPath = `evidence/${monthKey}/${id}.${sourceEvidenceExtensionForMimeType(mimeType)}`;
    const filePath = this.getSourceEvidenceFilePath(objectPath);

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      logger.error("Failed to store private source evidence file", {
        provider: FILESYSTEM_EVIDENCE_PROVIDER,
        objectPath,
        error,
      });
      throw new AppError("Source evidence storage is unavailable. Keep the upload queued and retry shortly.", 503);
    }

    return this.repository.createSourceEvidenceObject({
      id,
      ownerUserId: account?.id ?? null,
      storageProvider: FILESYSTEM_EVIDENCE_PROVIDER,
      objectPath,
      mimeType,
      byteSize: bytes.length,
      dataBase64: null,
      externalUrl: null,
      createdAt: nowIso(),
    });
  }

  getSourceEvidenceDelivery(evidence: SourceEvidenceObject):
    | { kind: "redirect"; url: string }
    | { kind: "bytes"; mimeType: string; bytes: Buffer }
    | null {
    if (evidence.externalUrl) {
      return { kind: "redirect", url: evidence.externalUrl };
    }

    if (evidence.dataBase64 && evidence.mimeType) {
      return {
        kind: "bytes",
        mimeType: evidence.mimeType,
        bytes: Buffer.from(evidence.dataBase64, "base64"),
      };
    }

    if (evidence.storageProvider === FILESYSTEM_EVIDENCE_PROVIDER && evidence.mimeType) {
      const filePath = this.getSourceEvidenceFilePath(evidence.objectPath);
      try {
        return {
          kind: "bytes",
          mimeType: evidence.mimeType,
          bytes: fs.readFileSync(filePath),
        };
      } catch (error) {
        logger.warn("Private source evidence file missing or unreadable", {
          evidenceId: evidence.id,
          provider: evidence.storageProvider,
          objectPath: evidence.objectPath,
          error,
        });
        throw new AppError("Source evidence not found.", 404);
      }
    }

    return null;
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
      night_plan: "saved_night_plan_added",
    };

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: eventTypeByItem[input.itemType],
      venueId: input.itemType === "venue" ? input.itemId : null,
      beerId: input.itemType === "beer" ? normalizeTrackedBeerId(input.label) : null,
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
      night_plan: "saved_night_plan_removed",
    };

    if (removed) {
      this.trackEvent(account, {
        anonymousSessionId: null,
        eventType: eventTypeByItem[input.itemType],
        venueId: input.itemType === "venue" ? input.itemId : null,
        beerId: input.itemType === "beer" ? normalizeTrackedBeerId(input.itemId) : null,
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
      case "venue_partner_interest":
        return {
          priority: "medium",
          triageReason: "Venue partner wants to join, claim, or manage a Pint Path venue account.",
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
      message: input.feedbackType === "venue_partner_interest"
        ? "Thanks. Venue support request is saved in the Pint Path support inbox."
        : "Thanks. Feedback is saved for admin review.",
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
      beerId: input.beerName ? normalizeTrackedBeerId(input.beerName) : null,
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
      beerId: input.beerName ? normalizeTrackedBeerId(input.beerName) : null,
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

    const communityReview = input.result === "confirmed"
      ? this.maybeApproveSubmissionByCommunityConsensus(submissionId, account)
      : null;

    return {
      verification,
      autoApproved: Boolean(communityReview),
      message: communityReview
        ? "Verification saved. This price has enough community confirmations and is now live."
        : "Verification saved. Community confirmations help improve data confidence.",
    };
  }

  private maybeApproveSubmissionByCommunityConsensus(submissionId: string, verifier: BusinessAccount) {
    const confirmedCount = this.repository.countConfirmedVerificationsForSubmission(submissionId);
    if (confirmedCount < COMMUNITY_SUBMISSION_CONFIRMATIONS_REQUIRED) {
      return null;
    }

    const submission = this.repository.getSubmissionById(submissionId);
    if (!submission) {
      return null;
    }

    if (submission.submission.status !== "pending" && submission.submission.status !== "needs_more_evidence") {
      return null;
    }

    const suggestedPoints = this.calculatePoints(submission.submission, submission.items);
    const points = submission.submission.pointsEligibleByLocation
      ? roundPoints(suggestedPoints)
      : 0;
    const reviewedAt = nowIso();
    const result = this.repository.reviewSubmission({
      submissionId,
      reviewerId: verifier.id,
      status: "approved",
      rejectionReason: null,
      fraudFlagged: false,
      pointsAwarded: points,
      confidence: "community_confirmed",
      now: reviewedAt,
      monthKey: monthKeyFromIso(submission.submission.observedAt),
      premiumUntil: endOfMonthIso(reviewedAt),
      contributorUnlockPoints: this.config.CONTRIBUTOR_UNLOCK_POINTS,
    });

    this.trackEvent(result.account, {
      anonymousSessionId: null,
      eventType: "submission_approved",
      venueId: result.submission.venueId,
      beerId: submission.items[0]?.normalizedBeerId ?? null,
      suburb: result.submission.suburb,
      metadata: {
        submissionId,
        reviewedByAdmin: false,
        reviewSource: "community_consensus",
        confirmedVerifications: confirmedCount,
        pointsAwarded: result.pointsAwarded,
        suggestedPoints,
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
          reviewSource: "community_consensus",
        },
      });
    }

    return result;
  }

  reviewSubmission(admin: BusinessAccount, submissionId: string, input: ReviewSubmissionInput) {
    const submission = this.repository.getSubmissionById(submissionId);

    if (!submission) {
      throw new AppError("Submission not found.", 404);
    }

    const allowOwnReview =
      submission.submission.userId === admin.id &&
      this.canAdminReviewOwnSubmission(admin);

    if (submission.submission.userId === admin.id && !allowOwnReview) {
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
      allowOwnReview,
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
        selfReview: submission.submission.userId === admin.id,
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

  private canAdminReviewOwnSubmission(admin: BusinessAccount): boolean {
    if (!this.isAdmin(admin)) {
      return false;
    }

    if (this.config.NODE_ENV !== "production") {
      return true;
    }

    const adminEmails = this.getAdminEmailAllowlist();
    return adminEmails.size > 0 && adminEmails.has(normalizeEmail(admin.email));
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
    const localVenues = this.repository.listLocalVenues({ query, limit }).map((venue) => ({
      ...venue,
      ...this.getPublicVenueTierMetadata(venue.id),
    }));

    if (!this.supabase) {
      const rawQuery = query?.trim();
      const labelStem = rawQuery?.split("·")[0] ?? "";
      const normalizedQuery = (labelStem.split(",")[0] ?? "").trim().toLowerCase();
      const missionVenues = this.repository
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
          ...this.getPublicVenueTierMetadata(mission.venueId),
        }));
      return this.mergeVenueRows(localVenues, missionVenues, limit);
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

    return this.mergeVenueRows(venues.map((venue) => ({
      ...venue,
      ...this.getPublicVenueTierMetadata(venue.id),
    })), localVenues, limit);
  }

  async getPublicVenueById(venueId: string): Promise<VenueRow | null> {
    const normalizedVenueId = venueId.trim();
    if (!normalizedVenueId) {
      return null;
    }

    if (!this.supabase) {
      const profile = this.repository.getBarProfile(normalizedVenueId);
      const location = this.repository.getVenueLocationCache(normalizedVenueId);
      if (!profile && !location) {
        return null;
      }

      return {
        id: normalizedVenueId,
        name: profile?.name || location?.venueName || normalizedVenueId,
        address: profile?.address || null,
        suburb: profile?.suburb || location?.suburb || null,
        state: "VIC",
        postcode: null,
        latitude: location?.latitude || null,
        longitude: location?.longitude || null,
        ...this.getPublicVenueTierMetadata(normalizedVenueId),
      };
    }

    const { data, error } = await this.supabase
      .from("venues")
      .select("id, name, address, suburb, state, postcode, latitude, longitude")
      .eq("id", normalizedVenueId)
      .maybeSingle();

    if (error) {
      throw new ExternalServiceError("Failed to fetch venue", {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
    }

    if (!data) {
      const profile = this.repository.getBarProfile(normalizedVenueId);
      const location = this.repository.getVenueLocationCache(normalizedVenueId);
      if (!profile && !location) {
        return null;
      }

      return {
        id: normalizedVenueId,
        name: profile?.name || location?.venueName || normalizedVenueId,
        address: profile?.address || null,
        suburb: profile?.suburb || location?.suburb || null,
        state: "VIC",
        postcode: null,
        latitude: location?.latitude || null,
        longitude: location?.longitude || null,
        ...this.getPublicVenueTierMetadata(normalizedVenueId),
      };
    }

    const venue = data as VenueRow;
    const now = nowIso();
    this.repository.upsertVenueLocationCache({
      venueId: venue.id,
      venueName: venue.name,
      suburb: venue.suburb,
      latitude: venue.latitude,
      longitude: venue.longitude,
      now,
    });

    return {
      ...venue,
      ...this.getPublicVenueTierMetadata(venue.id),
    };
  }

  private async fetchGoogleVenuePlaces<T>(
    url: string,
    init: RequestInit & { fieldMask: string },
  ): Promise<T> {
    const apiKey = this.config.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      throw new AppError("Google Places lookup is not configured. Set GOOGLE_PLACES_API_KEY on the server.", 503);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6500);
    const { fieldMask, headers, ...requestInit } = init;
    try {
      const response = await fetch(url, {
        ...requestInit,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": fieldMask,
          ...(headers ?? {}),
        },
      });

      const payload = await response.json().catch(() => ({})) as T & GooglePlacesSearchResponse;
      if (!response.ok) {
        throw new ExternalServiceError("Google Places lookup failed", {
          status: response.status,
          message: payload.error?.message ? redactSecrets(payload.error.message) : response.statusText,
        });
      }

      return payload as T;
    } catch (error) {
      if (error instanceof AppError || error instanceof ExternalServiceError) {
        throw error;
      }

      logger.warn("Google Places submit lookup failed", {
        error: error instanceof Error ? redactSecrets(error.message) : "unknown",
      });
      throw new ExternalServiceError("Google Places lookup failed. Try again or use manual entry.");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async findExistingUserGoogleVenue(place: GooglePlaceCandidate): Promise<UserGoogleVenueLookup["existingVenue"]> {
    const columns = "id, name, address, suburb";
    if (this.supabase && place.id) {
      const { data, error } = await this.supabase
        .from("venues")
        .select(columns)
        .eq("google_place_id", place.id)
        .maybeSingle();

      if (error) {
        logger.warn("Failed to check user venue duplicate by Google place ID", {
          error: redactSecrets(error.message),
        });
      } else if (data) {
        return data as UserGoogleVenueLookup["existingVenue"];
      }
    }

    const name = place.displayName?.text?.trim();
    const address = cleanGoogleVenueAddress(place.formattedAddress);
    if (this.supabase && name && address) {
      const { data, error } = await this.supabase
        .from("venues")
        .select(columns)
        .eq("name", name)
        .eq("address", address)
        .maybeSingle();

      if (error) {
        logger.warn("Failed to check user venue duplicate by name and address", {
          error: redactSecrets(error.message),
        });
      } else if (data) {
        return data as UserGoogleVenueLookup["existingVenue"];
      }
    }

    if (!name) {
      return null;
    }

    const suburb =
      getGoogleVenueAddressComponent(place.addressComponents, "locality") ??
      getGoogleVenueAddressComponent(place.addressComponents, "postal_town") ??
      getGoogleVenueAddressComponent(place.addressComponents, "sublocality") ??
      getGoogleVenueAddressComponent(place.addressComponents, "sublocality_level_1") ??
      getGoogleVenueAddressComponent(place.addressComponents, "neighborhood");
    const duplicate = this.repository.findLikelyVenueDuplicate({ name, suburb });
    return duplicate
      ? {
          id: duplicate.venueId,
          name: duplicate.venueName,
          address: null,
          suburb: duplicate.suburb,
        }
      : null;
  }

  private async normalizeUserGoogleVenueLookup(place: GooglePlaceCandidate): Promise<UserGoogleVenueLookup | null> {
    const googlePlaceId = place.id?.trim();
    const name = place.displayName?.text?.trim();
    const address = cleanGoogleVenueAddress(place.formattedAddress);
    const latitude = place.location?.latitude;
    const longitude = place.location?.longitude;

    if (!googlePlaceId || !name || !address) {
      return null;
    }

    const suburb =
      getGoogleVenueAddressComponent(place.addressComponents, "locality") ??
      getGoogleVenueAddressComponent(place.addressComponents, "postal_town") ??
      getGoogleVenueAddressComponent(place.addressComponents, "sublocality") ??
      getGoogleVenueAddressComponent(place.addressComponents, "sublocality_level_1") ??
      getGoogleVenueAddressComponent(place.addressComponents, "neighborhood");
    const state = getGoogleVenueAddressComponent(place.addressComponents, "administrative_area_level_1", "shortText");
    const postcode = getGoogleVenueAddressComponent(place.addressComponents, "postal_code");
    const existingVenue = await this.findExistingUserGoogleVenue(place);

    return {
      googlePlaceId,
      name,
      address,
      suburb,
      state,
      postcode,
      phone: place.internationalPhoneNumber?.trim() || place.nationalPhoneNumber?.trim() || null,
      website: place.websiteUri?.trim() || null,
      latitude: typeof latitude === "number" ? latitude : null,
      longitude: typeof longitude === "number" ? longitude : null,
      businessStatus: place.businessStatus ?? null,
      primaryType: place.primaryType ?? null,
      types: place.types ?? [],
      recommended: hasUserVenuePlaceSignal(place),
      alreadyExists: Boolean(existingVenue),
      existingVenue,
    };
  }

  async searchVenuePlacesForSubmission(_account: BusinessAccount, query: string): Promise<{
    configured: boolean;
    places: UserGoogleVenueLookup[];
  }> {
    const normalizedQuery = query.trim().replace(/\s+/g, " ");
    if (normalizedQuery.length < 2) {
      throw new AppError("Search a venue name, suburb, or address.", 400);
    }

    if (!this.config.GOOGLE_PLACES_API_KEY) {
      return { configured: false, places: [] };
    }

    const textQuery = /(?:melbourne|victoria|\bvic\b|australia)/i.test(normalizedQuery)
      ? normalizedQuery
      : `${normalizedQuery}, Melbourne VIC, Australia`;
    const searchByType = async (includedType: typeof USER_GOOGLE_VENUE_TYPES[number]) => {
      const payload = await this.fetchGoogleVenuePlaces<GooglePlacesSearchResponse>(
        "https://places.googleapis.com/v1/places:searchText",
        {
          method: "POST",
          body: JSON.stringify({
            textQuery,
            pageSize: 5,
            languageCode: "en-AU",
            regionCode: "AU",
            includedType,
            strictTypeFiltering: true,
            includePureServiceAreaBusinesses: false,
            locationBias: {
              rectangle: {
                low: { latitude: -38.5, longitude: 144.3 },
                high: { latitude: -37.4, longitude: 145.6 },
              },
            },
          }),
          fieldMask: [
            "places.id",
            "places.displayName",
            "places.formattedAddress",
            "places.addressComponents",
            "places.location",
            "places.businessStatus",
            "places.primaryType",
            "places.types",
          ].join(","),
        },
      );

      return payload.places ?? [];
    };

    const typedResults = await Promise.all(
      USER_GOOGLE_VENUE_TYPES.map((includedType) => searchByType(includedType)),
    );
    const candidatesById = new Map<string, GooglePlaceCandidate>();
    for (const place of typedResults.flat()) {
      if (!place.id || !isAllowedUserGoogleVenue(place)) {
        continue;
      }

      if (!candidatesById.has(place.id)) {
        candidatesById.set(place.id, place);
      }
    }

    const ranked = Array.from(candidatesById.values()).sort((left, right) => {
      const leftRecommended = hasUserVenuePlaceSignal(left) ? 1 : 0;
      const rightRecommended = hasUserVenuePlaceSignal(right) ? 1 : 0;
      if (leftRecommended !== rightRecommended) {
        return rightRecommended - leftRecommended;
      }

      return (left.displayName?.text ?? "").localeCompare(right.displayName?.text ?? "");
    });
    const normalized = await Promise.all(ranked.slice(0, 8).map((place) => this.normalizeUserGoogleVenueLookup(place)));

    return {
      configured: true,
      places: normalized.filter((place): place is UserGoogleVenueLookup => Boolean(place)),
    };
  }

  async getVenuePlaceForSubmission(_account: BusinessAccount, placeId: string): Promise<{
    configured: boolean;
    place: UserGoogleVenueLookup | null;
  }> {
    const normalizedPlaceId = placeId.trim();
    if (!normalizedPlaceId) {
      throw new AppError("Choose a Google venue result first.", 400);
    }

    if (!this.config.GOOGLE_PLACES_API_KEY) {
      return { configured: false, place: null };
    }

    const payload = await this.fetchGoogleVenuePlaces<GooglePlaceCandidate>(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(normalizedPlaceId)}`,
      {
        method: "GET",
        fieldMask: [
          "id",
          "displayName",
          "formattedAddress",
          "addressComponents",
          "location",
          "nationalPhoneNumber",
          "internationalPhoneNumber",
          "websiteUri",
          "businessStatus",
          "primaryType",
          "types",
        ].join(","),
      },
    );

    return {
      configured: true,
      place: isAllowedUserGoogleVenue(payload)
        ? await this.normalizeUserGoogleVenueLookup(payload)
        : null,
    };
  }

  private getPublicVenueTierMetadata(venueId: string): Pick<
    VenueRow,
    "membershipTier" | "highlightedName" | "premiumBadge" | "promoted" | "featuredSpecialEligible"
  > {
    const profile = this.repository.getBarProfile(venueId);

    if (!profile?.active) {
      return {
        membershipTier: "basic",
        highlightedName: false,
        premiumBadge: null,
        promoted: false,
        featuredSpecialEligible: false,
      };
    }

    const flags = tierFlags(profile.membershipTier);
    return {
      membershipTier: profile.membershipTier,
      highlightedName: flags.highlightedName && profile.highlightedName,
      premiumBadge: profile.premiumBadge || flags.premiumBadge,
      promoted: flags.promoted && profile.promoted,
      featuredSpecialEligible: flags.featuredSpecialEligible && profile.featuredSpecialEligible,
    };
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

  private missionPriorityForPoints(points: number): "low" | "normal" | "high" {
    if (points >= CONTRIBUTION_POINTS.staleUpdate) {
      return "high";
    }

    if (points >= CONTRIBUTION_POINTS.weekOldUpdate) {
      return "normal";
    }

    return "low";
  }

  private missionReasonForFreshness(scope: string, lastVerifiedAt: string | null): string {
    if (!lastVerifiedAt) {
      return `Missing ${scope} - add current venue data`;
    }

    const points = this.calculateFreshnessPoints(lastVerifiedAt);
    if (points <= CONTRIBUTION_POINTS.veryFreshUpdate) {
      return `Confirm current ${scope} - recently updated`;
    }

    if (points <= CONTRIBUTION_POINTS.weekOldUpdate) {
      return `Weekly ${scope} check - confirm it is still current`;
    }

    return `Stale ${scope} - update with current venue data`;
  }

  private buildAutoMissionsForVenue(
    candidate: MissionVenueCandidate,
    now: string,
  ): Array<Omit<BusinessMission, "active" | "sponsorFlag"> & { active?: boolean; sponsorFlag?: boolean }> {
    const baseMission = (
      suffix: string,
      reason: string,
      points: number,
      lastVerifiedAt: string | null,
      multiplier = 1,
    ) => ({
      id: `auto:venue:${candidate.venueId}:${suffix}`,
      venueId: candidate.venueId,
      venueName: candidate.venueName,
      suburb: candidate.suburb,
      reason,
      priority: this.missionPriorityForPoints(points),
      points,
      multiplier,
      lastVerifiedAt,
      createdAt: now,
      updatedAt: now,
      active: true,
      sponsorFlag: false,
    });

    if (candidate.recordCount === 0) {
      return [
        baseMission(
          "coverage",
          "New or empty venue - add first verified beer prices",
          CONTRIBUTION_POINTS.newVenue,
          null,
          1.2,
        ),
      ];
    }

    const missions = [
      baseMission(
        "menu-freshness",
        this.missionReasonForFreshness("drink menu", candidate.latestVerifiedAt),
        this.calculateFreshnessPoints(candidate.latestVerifiedAt),
        candidate.latestVerifiedAt,
      ),
    ];

    for (const beer of AUTO_MISSION_TARGET_BEERS) {
      const lastVerifiedAt = this.repository.getLatestVenueBeerTimestamp({
        venueId: candidate.venueId,
        normalizedBeerId: beer.key,
        beerNames: [beer.name, ...beer.aliases],
      });
      const points = this.calculateFreshnessPoints(lastVerifiedAt);
      const reason = lastVerifiedAt
        ? this.missionReasonForFreshness(`${beer.name} price`, lastVerifiedAt)
        : `Missing ${beer.name} price - add this drink`;

      missions.push(baseMission(`beer:${beer.key}`, reason, points, lastVerifiedAt));
    }

    const happyHourLastVerifiedAt = candidate.happyHourLastVerifiedAt ?? candidate.latestVerifiedAt;
    const happyHourPoints = this.calculateFreshnessPoints(happyHourLastVerifiedAt);
    missions.push(baseMission(
      "happy-hour",
      candidate.happyHourLastVerifiedAt
        ? this.missionReasonForFreshness("happy-hour details", candidate.happyHourLastVerifiedAt)
        : "Missing happy-hour details - add current specials",
      happyHourPoints,
      happyHourLastVerifiedAt,
    ));

    return missions;
  }

  private refreshAutoMissions(): { candidates: number; generated: number } {
    const candidates = this.repository.listMissionVenueCandidates(AUTO_MISSION_VENUE_LIMIT);
    if (!candidates.length) {
      return { candidates: 0, generated: 0 };
    }

    const now = nowIso();
    const missions = candidates.flatMap((candidate) => this.buildAutoMissionsForVenue(candidate, now));
    return {
      candidates: candidates.length,
      generated: this.repository.replaceAutoMissions(missions, now),
    };
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
    this.refreshAutoMissions();

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

    const uniqueMatches = Array.from(
      new Map(matches.map((entry) => [entry.mission.venueId, entry])).values(),
    );

    if (!uniqueMatches.length) {
      return null;
    }

    const bestMatches = uniqueMatches.slice(0, 20);
    const latitude = bestMatches.reduce((sum, entry) => sum + entry.location!.latitude!, 0) / bestMatches.length;
    const longitude = bestMatches.reduce((sum, entry) => sum + entry.location!.longitude!, 0) / bestMatches.length;
    const first = bestMatches[0]!;
    const suburb = first.profile?.suburb ?? first.mission.suburb;
    const label = uniqueMatches.length === 1
      ? [first.mission.venueName, suburb].filter(Boolean).join(", ")
      : suburb ?? query;

    return {
      latitude,
      longitude,
      label,
      source: "local_cache",
      confidence: uniqueMatches.length === 1 ? "exact" : "approximate",
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
    const refreshed = this.refreshAutoMissions();
    if (refreshed.candidates === 0 && this.repository.countMissions() === 0) {
      this.seedDemoMissions();
    }

    const hasLocation = typeof query.latitude === "number" && typeof query.longitude === "number";
    const radiusMeters = Math.max(100, Math.min(50_000, Number(query.radiusKm || 5) * 1000));
    const resultLimit = Math.max(1, query.limit);
    const missionFetchLimit = Math.max(resultLimit * 8, 100);
    const searchTerms = String(query.q || "")
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);
    const missions = this.repository
      .listMissions({ activeOnly: true, suburb: query.suburb, limit: missionFetchLimit })
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
          })
          .slice(0, resultLimit);
      case "stale":
        return missions
          .slice()
          .sort((left, right) => String(left.lastVerifiedAt ?? "").localeCompare(String(right.lastVerifiedAt ?? "")))
          .slice(0, resultLimit);
      case "no_data":
        return missions
          .slice()
          .sort((left, right) => Number(Boolean(left.lastVerifiedAt)) - Number(Boolean(right.lastVerifiedAt)))
          .slice(0, resultLimit);
      case "missing_happy_hour":
        return missions
          .slice()
          .sort((left, right) => Number(/happy/i.test(right.reason)) - Number(/happy/i.test(left.reason)))
          .slice(0, resultLimit);
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
          )
          .slice(0, resultLimit);
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
        beerId: input.beerId ? normalizeTrackedBeerId(input.beerId) : null,
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

  private getReportTimezone(): string {
    return this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE;
  }

  private getDefaultReportMonth(): string {
    return getPreviousZonedMonthKey(new Date(), this.getReportTimezone());
  }

  private buildVenueMonthlyReportData(profile: BarProfile, month: string) {
    const timezone = this.getReportTimezone();
    const privacyThreshold = Math.max(10, this.config.ANALYTICS_MIN_BUCKET_SIZE);
    const range = getZonedMonthRangeIso(month, timezone);
    const analytics = this.repository.getVenueAreaAnalytics({
      venueId: profile.barId,
      venueName: profile.name,
      area: profile.area ?? profile.suburb,
      month,
      timezone,
      privacyThreshold,
    });
    const insights = this.sanitizeVenueManagerInsights(
      this.repository.getVenueManagerInsights({
        venueId: profile.barId,
        suburb: profile.suburb,
        staleBefore: range.startIso,
      }),
      { includeAggregate: true, privacyThreshold },
    );
    const suggestedActions = analytics.privacyFloorMet
      ? [
          analytics.directionsClicks > 0
            ? "Keep your address, opening hours, and happy-hour conditions current because users are requesting directions."
            : "Improve your listing call-to-action by keeping beer rows and happy-hour details fresh.",
          analytics.areaBeerSearches.length > 0
            ? "Match your tap-list updates to the top privacy-safe beer searches in your area."
            : "Add clearer beer styles and specials so nearby search demand has more useful matches.",
        ]
      : ["Not enough suburb data yet. Your report will become more useful as more users search nearby."];
    const capabilities = getBarTierCapabilities(profile.membershipTier);
    const demandSnapshot = capabilities.analytics
      ? buildVenueDemandSnapshot({ analytics, insights })
      : null;
    const proRecommendations = capabilities.advancedRecommendations
      ? getProVenueRecommendations({ analytics, insights })
      : [];
    const proGrowthPlan = capabilities.advancedRecommendations
      ? buildProVenueGrowthPlan({ analytics, insights })
      : null;
    const discountSummary = this.getVenueDiscountSummary({
      venueId: profile.barId,
      startIso: range.startIso,
      endIso: range.endIso,
    });

    return sanitizeMonthlyReportValue({
      generated: true,
      generatedAt: nowIso(),
      reportingPeriod: {
        month,
        timezone,
        startIso: range.startIso,
        endIso: range.endIso,
      },
      venue: {
        id: profile.barId,
        name: profile.name,
        suburb: profile.suburb,
        tier: profile.membershipTier,
      },
      summary: {
        totalBarLookups: analytics.barLookups,
        totalProfileViews: analytics.profileViews,
        totalBeerListViews: analytics.beerListViews,
        totalSpecialsDealsViews: analytics.specialsViews,
        mapMarkerClicks: analytics.markerClicks,
        directionsClicks: analytics.directionsClicks,
        priceReveals: analytics.priceReveals,
        savesAndNightPlanAdds: analytics.saves,
        shares: analytics.shares,
        areaSearches: analytics.areaSearches,
        discountRedemptions: discountSummary.totalRedemptions,
        discountItemsRedeemed: discountSummary.totalQuantity,
        uniqueDiscountRedeemers: discountSummary.uniqueAccounts,
        estimatedDiscountSavingsCents: discountSummary.estimatedSavingsCents,
        topDiscountItems: discountSummary.topItems,
        mostSearchedBeerStylesInArea: analytics.privacyFloorMet ? analytics.areaStyleSearches : [],
        mostSearchedBeersInArea: analytics.privacyFloorMet ? analytics.areaBeerSearches : [],
        listingQualityScore: insights.listingQuality.score,
        openWrongPriceReports: insights.wrongPriceReports.filter((report) => report.status === "open").length,
        openVenueRequests: insights.requests.filter((request) => request.status === "open").length,
        suggestedActions,
        demandSnapshot,
        proRecommendations,
        proGrowthPlan,
        discoveryPlacement: capabilities.discoveryBoost
          ? {
              premiumDisplay: true,
              discoveryBoost: true,
              featuredSpecials: true,
              priorityReview: true,
            }
          : null,
      },
      privacy: {
        aggregateOnly: true,
        suppressedBelowCount: privacyThreshold,
        excludesUserEmails: true,
        excludesSessionIds: true,
        excludesExactLocation: true,
        excludesRawClickstream: true,
      },
    }) as Record<string, unknown>;
  }

  private generateVenueMonthlyReportsInternal(input: MonthlyReportGenerateInput) {
    const month = input.month ?? this.getDefaultReportMonth();
    const venues = this.repository.listReportableBarProfiles({
      venueId: input.venueId,
      limit: input.venueId ? 1 : 1000,
    });

    const reports = venues.map((profile) => {
      const data = this.buildVenueMonthlyReportData(profile, month);
      if (input.dryRun) {
        return {
          id: null,
          barId: profile.barId,
          month,
          data,
          createdAt: null,
        };
      }

      return this.repository.upsertVenueMonthlyReport({
        id: crypto.randomUUID(),
        venueId: profile.barId,
        month,
        data,
        createdAt: nowIso(),
      });
    });

    return {
      month,
      timezone: this.getReportTimezone(),
      requestedVenueId: input.venueId,
      dryRun: input.dryRun,
      generatedCount: reports.length,
      skippedReason: reports.length === 0
        ? input.venueId
          ? "No active Pro venue matched that venue ID."
          : "No active Pro venues are reportable yet."
        : null,
      reports: reports.map((report) => sanitizeMonthlyReport(report as MonthlyBarReport) ?? report),
    };
  }

  generateVenueMonthlyReports(admin: BusinessAccount, input: MonthlyReportGenerateInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const result = this.generateVenueMonthlyReportsInternal(input);
    this.auditSecurity({
      actor: admin,
      action: "venue_monthly_reports_generated",
      targetType: input.venueId ? "venue" : "venue_monthly_reports",
      targetId: input.venueId,
      metadata: {
        month: result.month,
        generatedCount: result.generatedCount,
        dryRun: input.dryRun,
      },
    });
    return result;
  }

  generateScheduledVenueMonthlyReports(input: MonthlyReportGenerateInput) {
    const result = this.generateVenueMonthlyReportsInternal(input);
    this.auditSecurity({
      actor: null,
      action: "venue_monthly_reports_generated",
      targetType: input.venueId ? "venue" : "venue_monthly_reports",
      targetId: input.venueId,
      metadata: {
        month: result.month,
        generatedCount: result.generatedCount,
        dryRun: input.dryRun,
        source: "scheduled_script",
      },
    });
    return result;
  }

  private getVenueReportRecipients(venueId: string) {
    return this.repository
      .listVenueManagerAssignments({ venueId, activeOnly: true, limit: 50 })
      .map((assignment) => this.repository.getAccountById(assignment.userId))
      .filter((account): account is BusinessAccount => Boolean(account && account.status === "active" && account.email));
  }

  deliverVenueMonthlyReports(admin: BusinessAccount, input: MonthlyReportDeliveryInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const generated = this.generateVenueMonthlyReports(admin, input);
    const deliveries = generated.reports.flatMap((report) => {
      const monthlyReport = report as MonthlyBarReport;
      const recipients = this.getVenueReportRecipients(monthlyReport.barId);
      if (recipients.length === 0) {
        return [{
          venueId: monthlyReport.barId,
          month: monthlyReport.month,
          status: "skipped_no_recipients",
          recipients: [],
          subject: `Pint Path monthly venue report - ${monthlyReport.month}`,
          attachmentName: getMonthlyReportFilename({
            venueId: monthlyReport.barId,
            month: monthlyReport.month,
            format: "json",
          }),
        }];
      }

      return recipients.map((recipient) => {
        const status = input.dryRun || !input.deliver
          ? "dry_run"
          : this.config.REPORT_EMAIL_MODE === "mock"
            ? "mocked"
            : "skipped_email_disabled";
        const delivery = {
          venueId: monthlyReport.barId,
          month: monthlyReport.month,
          status,
          recipients: [recipient.email],
          subject: `Pint Path monthly venue report - ${monthlyReport.month}`,
          attachmentName: getMonthlyReportFilename({
            venueId: monthlyReport.barId,
            month: monthlyReport.month,
            format: "json",
          }),
        };

        if (status === "mocked") {
          this.auditSecurity({
            actor: admin,
            action: "venue_monthly_report_delivery_mocked",
            targetType: "venue",
            targetId: monthlyReport.barId,
            metadata: {
              month: monthlyReport.month,
              recipientCount: 1,
              recipientDomain: recipient.email.split("@")[1] ?? "unknown",
            },
          });
        }

        return delivery;
      });
    });

    return {
      ...generated,
      emailMode: this.config.REPORT_EMAIL_MODE,
      deliveries,
    };
  }

  deliverScheduledVenueMonthlyReports(input: MonthlyReportDeliveryInput) {
    const generated = this.generateScheduledVenueMonthlyReports(input);
    const deliveries = generated.reports.flatMap((report) => {
      const monthlyReport = report as MonthlyBarReport;
      const recipients = this.getVenueReportRecipients(monthlyReport.barId);
      if (recipients.length === 0) {
        return [{
          venueId: monthlyReport.barId,
          month: monthlyReport.month,
          status: "skipped_no_recipients",
          recipientCount: 0,
        }];
      }

      return recipients.map((recipient) => {
        const status = input.dryRun || !input.deliver
          ? "dry_run"
          : this.config.REPORT_EMAIL_MODE === "mock"
            ? "mocked"
            : "skipped_email_disabled";

        if (status === "mocked") {
          this.auditSecurity({
            actor: null,
            action: "venue_monthly_report_delivery_mocked",
            targetType: "venue",
            targetId: monthlyReport.barId,
            metadata: {
              month: monthlyReport.month,
              recipientCount: 1,
              recipientDomain: recipient.email.split("@")[1] ?? "unknown",
              source: "scheduled_script",
            },
          });
        }

        return {
          venueId: monthlyReport.barId,
          month: monthlyReport.month,
          status,
          recipientCount: 1,
          subject: `Pint Path monthly venue report - ${monthlyReport.month}`,
          attachmentName: getMonthlyReportFilename({
            venueId: monthlyReport.barId,
            month: monthlyReport.month,
            format: "json",
          }),
        };
      });
    });

    return {
      ...generated,
      emailMode: this.config.REPORT_EMAIL_MODE,
      deliveries,
    };
  }

  exportVenueMonthlyReport(account: BusinessAccount, venueId: string, month: string, query: MonthlyReportExportQuery) {
    this.requireVerifiedBarAccount(account);
    this.requireAssignedVenue(account, venueId);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      throw new AppError("Report month must use YYYY-MM format.", 400);
    }

    const profile = this.repository.getBarProfile(venueId);
    const capabilities = getBarTierCapabilities(profile?.membershipTier ?? "basic", this.isAdmin(account));
    if (!capabilities.monthlyReports) {
      throw new AppError("Pro venue tier required to export monthly reports.", 403);
    }

    const report = sanitizeMonthlyReport(
      this.repository.getVenueMonthlyReport({ venueId, month }) ??
        this.repository.upsertVenueMonthlyReport({
          id: crypto.randomUUID(),
          venueId,
          month,
          data: this.buildVenueMonthlyReportData(
            profile ?? this.getOrBuildBarProfile({ barId: venueId, name: venueId, suburb: null }),
            month,
          ),
          createdAt: nowIso(),
        }),
    );

    if (!report) {
      throw new AppError("Monthly report not found.", 404);
    }

    if (query.format === "csv") {
      return {
        filename: getMonthlyReportFilename({ venueId, month, format: "csv" }),
        mimeType: "text/csv; charset=utf-8",
        body: monthlyReportToCsv(report),
      };
    }

    return {
      filename: getMonthlyReportFilename({ venueId, month, format: "json" }),
      mimeType: "application/json; charset=utf-8",
      body: `${JSON.stringify(report, null, 2)}\n`,
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
        businessToolkit: null,
        demandDashboard: null,
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
        businessToolkit: null,
        demandDashboard: null,
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
    const venueArea = profile.suburb ?? suburb ?? profile.area ?? null;
    const capabilities = getBarTierCapabilities(profile.membershipTier, isAdmin);
    const venueInsightPrivacyThreshold = Math.max(10, this.config.ANALYTICS_MIN_BUCKET_SIZE);
    const reportTimezone = this.getReportTimezone();
    const reportMonth = getZonedMonthKey(new Date(), reportTimezone);
    const reportMonthRange = monthKeyRange(reportMonth, reportTimezone);
    const analytics = capabilities.analytics
      ? this.repository.getVenueAreaAnalytics({
          venueId: selectedVenueId,
          venueName: profile.name,
          area: venueArea,
          month: reportMonth,
          timezone: reportTimezone,
          privacyThreshold: venueInsightPrivacyThreshold,
        })
      : null;
    const previousAnalytics = capabilities.analytics
      ? this.repository.getVenueAreaAnalytics({
          venueId: selectedVenueId,
          venueName: profile.name,
          area: venueArea,
          month: getPreviousZonedMonthKey(new Date(), reportTimezone),
          timezone: reportTimezone,
          privacyThreshold: venueInsightPrivacyThreshold,
        })
      : null;
    const inventoryBeers = this.repository.listBarBeers(selectedVenueId);
    const inventoryHappyHours = this.repository.listBarHappyHours(selectedVenueId);
    const inventorySpecials = capabilities.canManageSpecials ? this.repository.listBarSpecials(selectedVenueId) : [];
    const areaPurchasedBeers = capabilities.analytics
      ? this.repository.listVenueAreaPurchasedBeers({
          area: venueArea,
          startIso: reportMonthRange.startsAt,
          endIso: reportMonthRange.endsAt,
          privacyThreshold: venueInsightPrivacyThreshold,
          limit: 8,
        })
      : [];
    const priceBenchmarks = capabilities.analytics
      ? this.repository.listVenueAreaPriceBenchmarks({
          venueId: selectedVenueId,
          area: venueArea,
          limit: 8,
        })
      : [];
    const insights = this.sanitizeVenueManagerInsights(rawInsights, {
      includeAggregate: capabilities.analytics,
      privacyThreshold: venueInsightPrivacyThreshold,
    });
    const savedMonthlyReport = capabilities.monthlyReports
      ? sanitizeMonthlyReport(this.repository.getVenueMonthlyReport({ venueId: selectedVenueId, month: reportMonth }))
      : null;
    const demandSnapshot = analytics && capabilities.analytics
      ? buildVenueDemandSnapshot({ analytics, insights })
      : null;
    const proGrowthPlan = analytics && capabilities.advancedRecommendations
      ? buildProVenueGrowthPlan({ analytics, insights })
      : null;
    const demandDashboard = analytics && capabilities.analytics
      ? buildVenueDemandDashboard({
          tier: profile.membershipTier,
          area: venueArea,
          periods: getVenueDemandPeriodRanges(this.getReportTimezone()).map((period) => ({
            key: period.key,
            label: period.label,
            helper: period.helper,
            analytics: period.key === "month"
              ? analytics
              : this.repository.getVenueAreaAnalytics({
                venueId: selectedVenueId,
                venueName: profile.name,
                  area: venueArea,
                  startIso: period.startIso,
                  endIso: period.endIso,
                  timezone: reportTimezone,
                  privacyThreshold: venueInsightPrivacyThreshold,
                }),
          })),
        })
      : null;
    const paidVenueIntelligence = analytics && capabilities.analytics
      ? buildPaidVenueIntelligence({
          area: venueArea,
          analytics,
          previousAnalytics,
          inventoryBeers,
          purchasedBeers: areaPurchasedBeers,
          priceBenchmarks,
        })
      : null;
    const discountSummary = this.getVenueDiscountSummary({
      venueId: selectedVenueId,
      includeRecent: true,
      recentLimit: 10,
    });
    const todayRange = getZonedDayRangeIso(new Date(), this.getReportTimezone());
    const pintPointTodayStats = this.repository.getPintPointStatsForVenue({
      venueId: selectedVenueId,
      startIso: todayRange.startIso,
      endIso: todayRange.endIso,
    });
    const pintPointMonthStats = this.repository.getPintPointStatsForVenue({
      venueId: selectedVenueId,
      startIso: reportMonthRange.startsAt,
      endIso: reportMonthRange.endsAt,
    });
    const posIntegration = this.getVenuePosIntegration(account, selectedVenueId);
    const monthlyReport = capabilities.monthlyReports
      ? savedMonthlyReport ?? {
          id: null,
          barId: selectedVenueId,
          month: reportMonth,
          data: {
            generated: false,
            summary: analytics
              ? {
                  totalBarLookups: analytics.barLookups,
                  totalProfileViews: analytics.profileViews,
                  totalBeerListViews: analytics.beerListViews,
                  totalSpecialsDealsViews: analytics.specialsViews,
                  discountRedemptions: discountSummary.totalRedemptions,
                  discountItemsRedeemed: discountSummary.totalQuantity,
                  uniqueDiscountRedeemers: discountSummary.uniqueAccounts,
                  estimatedDiscountSavingsCents: discountSummary.estimatedSavingsCents,
                  topDiscountItems: discountSummary.topItems,
                  mostSearchedBeerStylesInArea: analytics.privacyFloorMet ? analytics.areaStyleSearches : [],
                  mostSearchedBeersInArea: analytics.privacyFloorMet ? analytics.areaBeerSearches : [],
                  topBeersBoughtInArea: paidVenueIntelligence?.topPurchasedBeers ?? [],
                  searchTimesByDay: paidVenueIntelligence?.searchTimesByDay ?? [],
                  searchTimesByHour: paidVenueIntelligence?.searchTimesByHour ?? [],
                  searchVsStockGap: paidVenueIntelligence?.searchStockGaps ?? [],
                  localBeerTrendReport: paidVenueIntelligence?.localTrendReport ?? [],
                  priceBenchmarks: paidVenueIntelligence?.priceBenchmarks ?? [],
                  demandSnapshot,
                  suggestedActions: analytics.privacyFloorMet
                    ? [
                        "Keep your tap list current so nearby search demand has an accurate listing to land on.",
                        "Add happy-hour details if they are missing; users often filter by active specials.",
                      ]
                    : ["Not enough suburb data yet. Your report will become more useful as more users search nearby."],
                  proRecommendations: capabilities.advancedRecommendations
                    ? getProVenueRecommendations({ analytics, insights })
                    : [],
                  proGrowthPlan,
                  discoveryPlacement: capabilities.discoveryBoost
                    ? {
                        premiumDisplay: true,
                        discoveryBoost: true,
                        featuredSpecials: true,
                        priorityReview: true,
                      }
                    : null,
                }
              : null,
          },
          createdAt: null,
        }
      : null;
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
        beers: inventoryBeers,
        happyHours: inventoryHappyHours,
        specials: inventorySpecials,
      },
      pendingChanges: this.repository.listBarPendingChanges({ barId: selectedVenueId, status: "pending", limit: 100 }),
      insights,
      analytics,
      demandDashboard,
      paidVenueIntelligence,
      discounts: discountSummary,
      pintPoints: {
        today: pintPointTodayStats,
        month: pintPointMonthStats,
        rewardThreshold: FREE_PINT_REWARD_POINTS,
        copy: "Pint Points count only paid alcoholic beverages. Free Pint Rewards do not earn another point.",
      },
      posIntegration,
      monthlyReport,
      businessToolkit: {
        demandSnapshot,
        proGrowthPlan,
        demandDashboard,
        paidVenueIntelligence,
        updateLink,
        qrCopy: "Copy this update link or turn it into a QR code for your venue/tap-list area.",
      },
      updateLink,
      qrCopy: "Copy this update link or turn it into a QR code for your venue/tap-list area.",
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

  createVenueClaimRequest(account: BusinessAccount, input: BarClaimRequestInput) {
    return this.createBarClaimRequest(account, input);
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
    }, { allowVenueManager: true, rewardEligible: false });

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId: input.items[0]?.beerName ? normalizeTrackedBeerId(input.items[0].beerName) : null,
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
      beerId: normalizeTrackedBeerId(beer.beerName),
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

    const queuedDelete = this.maybeQueueVenueDeleteForReview({
      account,
      venueId,
      changeType: "beer",
      targetId: beerId,
      payload: {
        id: existing.id,
        beerName: existing.beerName,
        serveSize: existing.serveSize,
        price: existing.price,
      },
      suburb: assignment?.suburb ?? null,
    });
    if (queuedDelete) {
      return queuedDelete;
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

    const queuedDelete = this.maybeQueueVenueDeleteForReview({
      account,
      venueId,
      changeType: "happy_hour",
      targetId: happyHourId,
      payload: {
        id: existing.id,
        title: existing.title,
        daysOfWeek: existing.daysOfWeek,
        startTime: existing.startTime,
        endTime: existing.endTime,
      },
      suburb: assignment?.suburb ?? null,
    });
    if (queuedDelete) {
      return queuedDelete;
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
    this.requireBarSpecialsTier(account, venueId);
    if (input.exclusive) {
      this.requireFeaturedSpecialsTier(account, venueId);
    }
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
      startTime: input.startTime,
      endTime: input.endTime,
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

    return { special, message: "Pint Path special saved." };
  }

  deleteBarSpecial(account: BusinessAccount, venueId: string, specialId: string) {
    const assignment = this.requireAssignedVenue(account, venueId);
    this.requireBarSpecialsTier(account, venueId);
    const existing = this.repository.getBarSpecialById(specialId);
    if (!existing || existing.barId !== venueId) {
      throw new AppError("Special not found for this venue.", 404);
    }

    const queuedDelete = this.maybeQueueVenueDeleteForReview({
      account,
      venueId,
      changeType: "special",
      targetId: specialId,
      payload: {
        id: existing.id,
        title: existing.title,
        price: existing.price,
        discount: existing.discount,
      },
      suburb: assignment?.suburb ?? null,
    });
    if (queuedDelete) {
      return queuedDelete;
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

    return { deleted: true, message: "Pint Path special removed." };
  }

  reviewBarPendingChange(admin: BusinessAccount, changeId: string, input: BarPendingChangeReviewInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const change = this.repository.getBarPendingChangeById(changeId);
    if (!change) {
      throw new AppError("Pending venue change not found.", 404);
    }

    if (change.status !== "pending") {
      throw new AppError("Pending venue change has already been reviewed.", 409);
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
      rejectionReason: input.status === "rejected" ? input.rejectionReason ?? "Rejected by admin review." : input.rejectionReason,
    });

    this.auditSecurity({
      actor: admin,
      action: "admin_venue_pending_change_review",
      targetType: "venue_pending_change",
      targetId: change.id,
      metadata: {
        venueId: change.barId,
        changeType: change.changeType,
        action: change.action,
        status: input.status,
      },
    });

    return {
      pendingChange: reviewed,
      message: input.status === "approved" ? "Venue change approved and published." : "Venue change rejected. Public data was not changed.",
    };
  }

  reviewVenuePendingChange(admin: BusinessAccount, changeId: string, input: BarPendingChangeReviewInput) {
    return this.reviewBarPendingChange(admin, changeId, input);
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

    const assignments = this.repository.listVenueManagerAssignments({ limit: 100 }).map((assignment) => {
      const manager = this.repository.getAccountById(assignment.userId);
      return {
        ...assignment,
        managerEmail: manager?.email ?? null,
        managerDisplayName: manager?.displayName ?? null,
        managerPublicAccountId: manager?.publicAccountId ?? null,
      };
    });

    return {
      interests: this.repository.listVenueInterestRequests(100),
      claimRequests: this.repository.listBarClaimRequests({ limit: 100 }),
      assignments,
      pendingChanges: this.repository.listBarPendingChanges({ status: "pending", limit: 100 }),
      outreach: this.repository.listVenuePartnerOutreach(100),
      leads: this.repository.getPotentialPartnerLeads({
        staleBefore: daysAgoIso(90),
        limit: 25,
      }),
    };
  }

  searchAccountsForAdmin(admin: BusinessAccount, query: AdminAccountSearchInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    return {
      accounts: this.repository.searchAccountsForAdmin({
        query: query.q,
        limit: query.limit,
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
      tierFit: input.tierFit,
      nextAction: input.nextAction,
      lastContactedAt: input.lastContactedAt,
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
      beerId: request.beerName ? normalizeTrackedBeerId(request.beerName) : null,
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
    const priceId = this.config.STRIPE_PRO_PRICE_ID;
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
        message: "Pro demo tier activated for this venue.",
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

    if (!/^\d+$/.test(timestamp)) {
      throw new AppError("Invalid Stripe webhook signature.", 401);
    }

    const timestampSeconds = Number(timestamp);
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      Math.abs(nowSeconds - timestampSeconds) > STRIPE_WEBHOOK_TOLERANCE_SECONDS
    ) {
      throw new AppError("Invalid Stripe webhook signature.", 401);
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
      const rawBarMembershipTier = metadata?.venue_membership_tier;
      const barMembershipTier: BarMembershipTier | null = rawBarMembershipTier === "pro" || rawBarMembershipTier === "plus"
        ? "pro"
        : null;
      const subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
      const userId = metadata?.user_id;
      const subscriptionStatus = metadata?.subscription_status as SubscriptionStatus | undefined;
      const customer = typeof object.customer === "string" ? object.customer : null;

      if ((billingContext === "venue" || billingContext === "bar") && barId && barMembershipTier) {
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
