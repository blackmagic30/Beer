import crypto from "node:crypto";
import fs from "node:fs";
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
  type PintPointDrinkRecord,
  type VenueManagerAssignment,
  type VenuePintPointActivity,
  type PubGolfVenueCandidate,
  type PublicVenuePriceRecord,
  type SavedItem,
  type ServingSize,
  type SubmissionItemCaptureSource,
  type SubmissionOcrStatus,
  type SubmissionOcrSummary,
  type SourceEvidenceObject,
  type SubscriptionStatus,
} from "../../db/business.repository.js";
import { BeerCatalogRepository, type BeerCatalogAdminItem, type ResolvedBeerCatalogItem } from "../../db/beer-catalog.repository.js";
import {
  SUPPORTED_BEERS,
  VIEWER_TRACKED_BEERS,
  canonicalizeTrackedBeerName,
  findTrackedBeerByName,
  isLikelyBeerName,
  normalizeBeerSearchKey,
} from "../../constants/beers.js";
import { AppError, ExternalServiceError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import type { MenuPhotoOcrBeer, MenuPhotoOcrProcessor, MenuPhotoOcrResult } from "../../lib/menu-photo-ocr.js";
import { redactSecrets } from "../../lib/redact.js";
import {
  parseSafeImageSourceUrl,
  validateImageDataUrl,
} from "../../lib/source-image-safety.js";
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
  VenueClaimReviewInput,
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
  PintPointMemberPreviewInput,
  PintPointDrinkRecordInput,
  PintPointDrinkVoidInput,
  PosDiscountRedemptionInput,
  PriceRecordsQuery,
  PubGolfPlanInput,
  RemoveSavedItemInput,
  ReviewSubmissionInput,
  RetentionQuery,
  SaveItemInput,
  TrustWorkflowUpdateInput,
  VenueInterestInput,
  VenueInterestStatusInput,
  VenueManagerAssignmentInput,
  VenueManagerRevokeInput,
  VenueCounterStaffAssignmentInput,
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
  acceptsPintPathCodes?: boolean;
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
const AUTO_MISSION_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const AUTO_MISSION_REFRESH_STATE_KEY = "auto_missions_refresh";
const AUTO_MISSION_TARGET_BEERS = [
  SUPPORTED_BEERS.guinness,
  SUPPORTED_BEERS.carlton_draft,
  SUPPORTED_BEERS.stone_and_wood,
] as const;
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const USER_GOOGLE_VENUE_TYPES = ["bar", "pub", "restaurant", "brewery", "night_club"] as const;
const USER_GOOGLE_VENUE_TYPE_SET = new Set<string>(USER_GOOGLE_VENUE_TYPES);

interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  data?: {
    object?: Record<string, unknown>;
  };
}

interface StripeCheckoutSession {
  id?: string;
  status?: string | null;
  payment_status?: string | null;
  customer?: string | { id?: string | null } | null;
  subscription?: string | { id?: string | null; current_period_end?: number | null } | null;
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

async function fetchWithTimeout(url: string | URL, init: RequestInit = {}, timeoutMs = 8_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
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

function publicDisplayNameKey(value: string | null | undefined): string | null {
  const displayName = normalizePublicDisplayName(value);
  if (!displayName) {
    return null;
  }

  const key = displayName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return key || null;
}

export function sanitizePostgrestIlikeTerm(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 &-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
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

function normalizeVenueIdentityPart(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\b(?:victoria|vic|australia)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function venueIdentityKey(venue: Pick<VenueRow, "name" | "address" | "suburb">): string | null {
  const name = normalizeVenueIdentityPart(venue.name);
  if (!name) return null;
  const address = normalizeVenueIdentityPart(venue.address);
  if (address) return `${name}|address:${address}`;
  const suburb = normalizeVenueIdentityPart(venue.suburb);
  return suburb ? `${name}|suburb:${suburb}` : null;
}

function encodePriceCursor(record: Pick<PublicVenuePriceRecord, "id" | "lastVerifiedAt">): string {
  return Buffer.from(JSON.stringify({ id: record.id, verifiedAt: record.lastVerifiedAt })).toString("base64url");
}

function decodePriceCursor(value: string | undefined): { id: string; verifiedAt: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof parsed.id === "string" && typeof parsed.verifiedAt === "string"
      ? { id: parsed.id, verifiedAt: parsed.verifiedAt }
      : null;
  } catch {
    throw new AppError("Price cursor is invalid or expired.", 400);
  }
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

function shouldCatalogBeerName(value: string | null | undefined, isHappyHour = false): boolean {
  return !isHappyHour && isLikelyBeerName(value);
}

type PreparedSubmissionItem = CreateSubmissionInput["items"][number] & {
  captureSource: SubmissionItemCaptureSource;
  sourceText: string | null;
  confidence: number;
  catalogBrewery: string | null;
  catalogAbv: number | null;
};

interface PreparedPhotoOcr {
  status: SubmissionOcrStatus;
  summary: SubmissionOcrSummary;
  items: PreparedSubmissionItem[];
}

function submissionServingSizeForOcrBeer(beer: MenuPhotoOcrBeer): ServingSize {
  if (beer.availabilityStatus !== "package_only") return "pint";
  if (beer.unavailableReason === "cans_only") return "can";
  if (beer.unavailableReason === "bottles_only") return "bottle";
  return "other";
}

function submissionTapStatusForOcrBeer(beer: MenuPhotoOcrBeer): "yes" | "no" | "unknown" {
  if (beer.availabilityStatus === "on_tap" || beer.availableOnTap === true) return "yes";
  if (beer.availabilityStatus === "package_only" || beer.availabilityStatus === "unavailable") return "no";
  return "unknown";
}

function preparedSubmissionItemFromOcr(beer: MenuPhotoOcrBeer): PreparedSubmissionItem | null {
  if (!isLikelyBeerName(beer.name) || beer.confidence < 0.58) return null;
  const isOnTap = submissionTapStatusForOcrBeer(beer);
  if (beer.priceNumeric == null && isOnTap === "unknown") return null;

  return {
    beerName: beer.name,
    servingSize: submissionServingSizeForOcrBeer(beer),
    price: beer.priceNumeric,
    isHappyHourPrice: false,
    happyHourDetails: null,
    isOnTap,
    captureSource: "photo_ocr",
    sourceText: beer.sourceText?.slice(0, 800) ?? null,
    confidence: beer.confidence,
    catalogBrewery: beer.brewery,
    catalogAbv: beer.abv,
  };
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const DISCOUNT_PASS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FREE_PINT_REWARD_POINTS = 50;
const FREE_PINT_REWARD_CODE_MINUTES = 10;
const PINT_POINTS_DAILY_CAP = 8;
const COUNTER_STAFF_VOID_WINDOW_MINUTES = 15;

function generateDiscountCode(): string {
  return Array.from({ length: 6 }, () =>
    DISCOUNT_PASS_CODE_ALPHABET[crypto.randomInt(DISCOUNT_PASS_CODE_ALPHABET.length)]!,
  ).join("");
}

function hashDiscountCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function createPosWebhookToken(secret: string, venueId: string, version: number): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`pint-path-pos-redemption:${venueId.trim()}:v${version}`)
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

function derivePasswordHash(password: string, salt: string, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, length, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await derivePasswordHash(password, salt, 64)).toString("hex");
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

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split(":");

  if (scheme !== "scrypt" || !salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, "hex");
  const actual = await derivePasswordHash(password, salt, expected.length);
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

function sanitizeVenuePintPointDrinkRecord(record: PintPointDrinkRecord) {
  return {
    id: record.id,
    venueId: record.venueId,
    venueName: record.venueName,
    itemName: record.itemName,
    beverageCategory: record.beverageCategory,
    quantity: record.quantity,
    isAlcoholic: record.isAlcoholic,
    pointsAwarded: record.pointsAwarded,
    source: record.source,
    status: record.status,
    voidedAt: record.voidedAt,
    voidReason: record.voidReason,
    recordedAt: record.recordedAt,
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

const PRIVATE_EVIDENCE_PREFIX = "private:evidence:";
const FILESYSTEM_EVIDENCE_PROVIDER = "filesystem_private";
const SUPABASE_EVIDENCE_PROVIDER = "supabase_private";
const SUPABASE_EVIDENCE_BUCKET = "beermap-source-evidence";

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
    case "application/pdf":
      return "pdf";
    default:
      return "bin";
  }
}

function validateSubmissionPdfDataUrl(value: string): { mimeType: "application/pdf"; bytes: Buffer } {
  const prefix = "data:application/pdf;base64,";
  if (!value.startsWith(prefix)) {
    throw new AppError("Menu document must be a PDF.", 400);
  }
  const bytes = Buffer.from(value.slice(prefix.length), "base64");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) {
    throw new AppError("Menu PDF must be 8MB or smaller.", 400);
  }
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new AppError("Menu document content does not match the PDF file type.", 400);
  }
  const structure = bytes.toString("latin1").toLowerCase();
  if (["/javascript", "/launch", "/embeddedfile", "/openaction", "/aa"].some((token) => structure.includes(token))) {
    throw new AppError("Menu PDF contains active or embedded content. Export a flat menu PDF and try again.", 400);
  }
  return { mimeType: "application/pdf", bytes };
}

function validateSubmissionEvidenceDataUrl(value: string): { mimeType: string; bytes: Buffer } {
  if (value.startsWith("data:application/pdf;base64,")) {
    return validateSubmissionPdfDataUrl(value);
  }
  return validateImageDataUrl(value, {
    allowedMimeTypes: SUBMISSION_LIMITS.allowedImageMimeTypes,
    maxBytes: SUBMISSION_LIMITS.maxPhotoBytes,
    invalidMimeMessage: "Upload must be a JPEG, PNG, WebP, HEIC, HEIF, or PDF file.",
    tooLargeMessage: "Each upload image must be 6MB or smaller.",
    activePayloadMessage: "Upload must be a safe image file, not SVG, HTML, XML, script, or style content.",
    mismatchMessage: "Upload image content does not match the declared file type.",
  });
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

function getSupabaseMfaClaims(accessToken: string): { mfaLevel: string; mfaVerifiedAt: string | null } {
  const payload = decodeJwtPayload(accessToken);
  const aal = typeof payload?.aal === "string" ? payload.aal : "aal1";
  const amr = Array.isArray(payload?.amr) ? payload.amr : [];
  const latestTotpTimestamp = amr.reduce<number | null>((latest, entry) => {
    if (!entry || typeof entry !== "object") {
      return latest;
    }
    const record = entry as Record<string, unknown>;
    if (record.method !== "totp" || typeof record.timestamp !== "number" || !Number.isSafeInteger(record.timestamp)) {
      return latest;
    }
    return latest == null || record.timestamp > latest ? record.timestamp : latest;
  }, null);
  return {
    mfaLevel: aal,
    mfaVerifiedAt: aal === "aal2" && latestTotpTimestamp != null
      ? new Date(latestTotpTimestamp * 1000).toISOString()
      : null,
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
        copy: "Use beer search, cheapest sort, verified-only, under-A$10, nearby, and saved-area filters without daily reveal limits.",
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
        copy: "Keep favourite venues, beers, areas, and night-plan ideas synced to your account for faster repeat searches.",
        href: "/account.html?settings=watchlist",
        ctaLabel: "Manage list",
      },
      {
        id: "personal_preferences",
        title: "Personal discovery defaults",
        unlocked: hasFullAccess,
        badge: `${preferredShortcuts} set`,
        copy: "Save preferred areas, beers, and use cases so missions and discovery tools start closer to how you go out.",
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
    happyHourBeers: [],
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

function isSpecialRecord(record: PublicVenuePriceRecord): boolean {
  return record.displayKind === "special";
}

function shouldExposePriceRecord(record: PublicVenuePriceRecord): boolean {
  return isHappyHourRecord(record) || isSpecialRecord(record) || isLikelyBeerName(record.beerName);
}

function priceRecordIdentityKey(record: PublicVenuePriceRecord): string {
  if (isHappyHourRecord(record) || isSpecialRecord(record)) {
    return `${record.displayKind ?? "record"}:${record.id}`;
  }

  const beerKey = record.normalizedBeerId
    || findTrackedBeerByName(record.beerName)?.key
    || normalizeBeerSearchKey(canonicalizeTrackedBeerName(record.beerName));
  return [
    "beer",
    record.venueId,
    beerKey,
    normalizeBeerSearchKey(record.servingSize || "other"),
  ].join(":");
}

function priceRecordSourcePriority(record: PublicVenuePriceRecord): number {
  if (record.sourceType === "venue_manager_portal") {
    return 3;
  }

  if (record.sourceType === "source_ingestion") {
    return 2;
  }

  return 1;
}

function comparePriceRecordPriority(left: PublicVenuePriceRecord, right: PublicVenuePriceRecord): number {
  const dateDelta = new Date(right.lastVerifiedAt).getTime() - new Date(left.lastVerifiedAt).getTime();
  if (dateDelta !== 0) {
    return dateDelta;
  }

  return priceRecordSourcePriority(right) - priceRecordSourcePriority(left);
}

function dedupePublicPriceRecords(records: PublicVenuePriceRecord[]): PublicVenuePriceRecord[] {
  const selected = new Map<string, PublicVenuePriceRecord>();
  for (const record of [...records].sort(comparePriceRecordPriority)) {
    const key = priceRecordIdentityKey(record);
    if (!selected.has(key)) {
      selected.set(key, record);
    }
  }

  return [...selected.values()];
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

function stripePeriodEndIso(value: unknown): string | null {
  const object = objectFromUnknown(value);
  const direct = numberOrNull(object.current_period_end)
    ?? numberOrNull(object.period_end)
    ?? numberOrNull(object.cancel_at);
  const items = objectFromUnknown(object.items);
  const itemRows = Array.isArray(items.data) ? items.data : [];
  const itemPeriodEnd = itemRows
    .map((item) => numberOrNull(objectFromUnknown(item).current_period_end))
    .find((entry): entry is number => entry != null);
  const timestamp = direct ?? itemPeriodEnd;
  if (timestamp == null || !Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp * 1000).toISOString();
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

function happyHourBeersFromUnknown(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      beerId: stringOrNull(item.beerId),
      beerName: stringOrNull(item.beerName) ?? "",
      normalizedBeerId: stringOrNull(item.normalizedBeerId),
      servingSize: stringOrNull(item.servingSize) as BarBeerInput["serveSize"],
      happyHourPrice: numberOrNull(item.happyHourPrice),
      offerText: stringOrNull(item.offerText),
      onTap: booleanFromUnknown(item.onTap, false),
      inStock: booleanFromUnknown(item.inStock, true),
    }))
    .filter((item) => item.beerName.length > 0)
    .slice(0, 60);
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
      : "Upgrade to Pro to add Pint Path specials, see privacy-safe area analytics, and export generated monthly reports.",
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
    title: analytics.privacyFloorMet ? "Area demand snapshot" : "Demand snapshot building",
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

const SPECIALS_PLANNER_HOURS = Array.from({ length: 12 }, (_value, index) => index + 12);

function buildPaidVenueIntelligence(input: {
  area: string | null;
  analytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]>;
  previousAnalytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]> | null;
  inventoryBeers: ReturnType<BusinessRepository["listBarBeers"]>;
  purchasedBeers: ReturnType<BusinessRepository["listVenueAreaPurchasedBeers"]>;
  priceBenchmarks: ReturnType<BusinessRepository["listVenueAreaPriceBenchmarks"]>;
}) {
  const area = input.area?.trim() || "your area";
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

function formatPlannerHour(hour: number): string {
  const normalized = ((hour % 24) + 24) % 24;
  if (normalized === 0) {
    return "12 am";
  }
  if (normalized === 12) {
    return "12 pm";
  }
  return normalized > 12 ? `${normalized - 12} pm` : `${normalized} am`;
}

function formatPlannerTime(hour: number): string {
  return `${String(((hour % 24) + 24) % 24).padStart(2, "0")}:00`;
}

function getZonedDateKey(date: Date, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone || DEFAULT_REPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function buildSpecialsPlannerWindows(analytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]>) {
  const countsByHour = new Map<number, number>();
  for (const row of analytics.searchTimesByHour ?? []) {
    const hour = Number(row.sort ?? row.key);
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
      countsByHour.set(hour, (countsByHour.get(hour) ?? 0) + row.count);
    }
  }

  const windows = SPECIALS_PLANNER_HOURS.slice(0, -1).map((startHour) => {
    const endHour = startHour + 2;
    const count = (countsByHour.get(startHour) ?? 0) + (countsByHour.get(startHour + 1) ?? 0);
    return {
      label: `${formatPlannerHour(startHour)}-${formatPlannerHour(endHour)}`,
      startTime: formatPlannerTime(startHour),
      endTime: formatPlannerTime(endHour),
      count,
      sort: startHour,
    };
  });
  const maxCount = Math.max(0, ...windows.map((window) => window.count));

  return {
    popular: windows
      .filter((window) => window.count > 0)
      .sort((left, right) => right.count - left.count || left.sort - right.sort)
      .slice(0, 3)
      .map((window) => ({
        ...window,
        helper: `${window.count} local search${window.count === 1 ? "" : "es"} touched this window.`,
        confidence: window.count >= analytics.privacyThreshold ? "high" : "directional",
      })),
    quiet: windows
      .filter((window) => maxCount === 0 || window.count < maxCount)
      .sort((left, right) => left.count - right.count || left.sort - right.sort)
      .slice(0, 3)
      .map((window) => ({
        ...window,
        helper: window.count > 0
          ? `${window.count} local search${window.count === 1 ? "" : "es"} touched this quieter window.`
          : "No local searches in this window yet.",
        confidence: window.count >= analytics.privacyThreshold ? "high" : "directional",
      })),
  };
}

function buildDailySpecialsPlanner(input: {
  venueName: string;
  area: string | null;
  timezone: string;
  todayAnalytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]>;
  monthAnalytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]>;
  paidVenueIntelligence: ReturnType<typeof buildPaidVenueIntelligence> | null;
  activeSpecialCount: number;
}) {
  const area = input.area?.trim() || "your local area";
  const sourceAnalytics = input.todayAnalytics.privacyFloorMet
    ? input.todayAnalytics
    : input.monthAnalytics.privacyFloorMet
      ? input.monthAnalytics
      : input.todayAnalytics;
  const sourcePeriod = input.todayAnalytics.privacyFloorMet
    ? "today"
    : input.monthAnalytics.privacyFloorMet
      ? "this_month"
      : "building";
  const windows = sourceAnalytics.privacyFloorMet
    ? buildSpecialsPlannerWindows(sourceAnalytics)
    : { popular: [], quiet: [] };
  const topSearchedBeers = input.paidVenueIntelligence?.topSearchedBeers?.length
    ? input.paidVenueIntelligence.topSearchedBeers
    : sourceAnalytics.areaBeerSearches.map((row) => ({
        key: normalizeTrackedBeerId(row.key),
        beerName: formatBeerInsightName(row.label || row.key),
        searchCount: row.count,
      }));
  const topBeer = topSearchedBeers[0] ?? null;
  const topStyle = sourceAnalytics.areaStyleSearches[0] ?? null;
  const popularWindow = windows.popular[0] ?? null;
  const quietWindow = windows.quiet[0] ?? null;
  const confidenceCopy = sourcePeriod === "today"
    ? "Using today's suburb search pattern."
    : sourcePeriod === "this_month"
      ? "Today is still building, so this uses the current month suburb pattern."
      : `Waiting for at least ${sourceAnalytics.privacyThreshold} local searches before showing exact time windows.`;
  const focusBeer = topBeer?.beerName ?? (topStyle ? formatBeerInsightName(topStyle.label || topStyle.key) : "selected taps");
  const recommendations = sourceAnalytics.privacyFloorMet
    ? [
        quietWindow
          ? {
              title: `Fill the ${quietWindow.label} lull`,
              type: "foot_traffic",
              window: quietWindow.label,
              startTime: quietWindow.startTime,
              endTime: quietWindow.endTime,
              offerIdea: `Run a simple ${focusBeer} or selected-tap special in this lower-demand window.`,
              reason: `${quietWindow.label} is the least popular visible Pint Path search window for ${area}.`,
              action: "Use a clear time-boxed offer to pull in earlier foot traffic before peak demand.",
            }
          : null,
        popularWindow
          ? {
              title: `Convert the ${popularWindow.label} peak`,
              type: "conversion",
              window: popularWindow.label,
              startTime: popularWindow.startTime,
              endTime: popularWindow.endTime,
              offerIdea: `Keep a headline ${focusBeer} offer visible while users are actively searching.`,
              reason: `${popularWindow.label} is the strongest visible Pint Path search window around ${area}.`,
              action: "Keep prices, stock, and staff redemption flow fresh so demand turns into visits.",
            }
          : null,
        topBeer
          ? {
              title: `Match ${topBeer.beerName} demand`,
              type: "local_search_match",
              window: quietWindow?.label ?? popularWindow?.label ?? "Tonight",
              startTime: quietWindow?.startTime ?? popularWindow?.startTime ?? null,
              endTime: quietWindow?.endTime ?? popularWindow?.endTime ?? null,
              offerIdea: `Feature ${topBeer.beerName} in one Pint Path special if it is on tap or a close substitute is available.`,
              reason: `${topBeer.beerName} is the top suburb beer search signal for ${area}.`,
              action: "Use the local search term in the special title so users recognise the match.",
            }
          : null,
      ].filter((item): item is NonNullable<typeof item> => Boolean(item))
    : [
        {
          title: "Start with a flexible off-peak special",
          type: "building",
          window: "Tonight",
          startTime: null,
          endTime: null,
          offerIdea: "Run one easy staff-friendly offer, such as selected taps or a house pint special.",
          reason: `Pint Path is still collecting enough ${area} searches for a privacy-safe daily time split.`,
          action: "Keep the special simple while the daily summary builds.",
        },
      ];

  return {
    title: "Specials planner",
    venueName: input.venueName,
    area,
    summaryDate: getZonedDateKey(new Date(), input.timezone),
    sourcePeriod,
    generatedAt: nowIso(),
    privacyFloorMet: sourceAnalytics.privacyFloorMet,
    privacyThreshold: sourceAnalytics.privacyThreshold,
    activeSpecialCount: input.activeSpecialCount,
    confidenceCopy,
    summary: sourceAnalytics.privacyFloorMet && popularWindow && quietWindow
      ? `${area} Pint Path users are most active around ${popularWindow.label}. The quietest visible window is ${quietWindow.label}, so use a focused special there to lift foot traffic.`
      : `Pint Path is building a daily ${area} summary. Keep one simple special live until enough local search activity clears the privacy floor.`,
    demandSignals: [
      { label: "Area searches", value: sourceAnalytics.areaSearches, helper: sourcePeriod === "today" ? "Today" : "Current month" },
      { label: "Popular window", value: popularWindow?.label ?? "Building", helper: popularWindow?.helper ?? confidenceCopy },
      { label: "Least popular window", value: quietWindow?.label ?? "Building", helper: quietWindow?.helper ?? confidenceCopy },
      { label: "Active specials", value: input.activeSpecialCount, helper: "Live Pint Path offers" },
    ],
    popularWindows: windows.popular,
    quietWindows: windows.quiet,
    localSearchSignals: [
      ...topSearchedBeers.slice(0, 3).map((row) => ({
        label: row.beerName,
        value: row.searchCount,
        helper: `${area} beer search`,
      })),
      ...sourceAnalytics.areaStyleSearches.slice(0, 2).map((row) => ({
        label: formatBeerInsightName(row.label || row.key),
        value: row.count,
        helper: `${area} style search`,
      })),
    ],
    recommendations: recommendations.slice(0, 3),
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
  private readonly useSupabaseEvidenceStorage: boolean;
  private publicVenueCache: { rows: VenueRow[]; fetchedAt: number; fetchLimit: number } | null = null;

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
      | "SOURCE_EVIDENCE_RETENTION_DAYS"
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
    private readonly beerCatalogRepository?: BeerCatalogRepository,
    private readonly menuPhotoOcr?: MenuPhotoOcrProcessor,
    supabaseClientOverride?: SupabaseClient,
  ) {
    const supabaseServerKey = config.SUPABASE_SERVICE_ROLE_KEY ?? config.SUPABASE_ANON_KEY;
    if (supabaseClientOverride) {
      this.supabase = supabaseClientOverride;
    } else if (config.SUPABASE_URL && supabaseServerKey) {
      this.supabase = createClient(config.SUPABASE_URL, supabaseServerKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
    }
    this.useSupabaseEvidenceStorage = Boolean(this.supabase && config.SUPABASE_SERVICE_ROLE_KEY);
  }

  private getTrackedBeerCatalogForViewer() {
    return this.beerCatalogRepository?.listForViewer() ?? VIEWER_TRACKED_BEERS;
  }

  private resolveSystemBeer(input: {
    name: string;
    source: string;
    now: string;
    createIfMissing?: boolean;
    matchMode?: "exact" | "ocr";
    brewery?: string | null;
    abv?: number | null;
  }): ResolvedBeerCatalogItem {
    if (this.beerCatalogRepository) {
      return this.beerCatalogRepository.resolveBeerName(input);
    }

    const beerName = canonicalizeTrackedBeerName(input.name);
    const trackedBeer = findTrackedBeerByName(beerName);
    return {
      key: trackedBeer?.key ?? normalizeTrackedBeerId(beerName),
      name: trackedBeer?.name ?? beerName,
      brewery: trackedBeer?.brewery ?? null,
      style: trackedBeer?.style ?? null,
      abv: trackedBeer?.abv ?? null,
      status: trackedBeer ? "active" : "pending_review",
      source: trackedBeer ? "system_catalog" : input.source,
      created: false,
      matchedExisting: Boolean(trackedBeer),
    };
  }

  private standardizeBeerReference(input: {
    name: string;
    source: string;
    now: string;
    isHappyHour?: boolean;
    createIfMissing?: boolean;
    matchMode?: "exact" | "ocr";
    brewery?: string | null;
    abv?: number | null;
  }): {
    key: string | null;
    name: string;
    brewery: string | null;
    style: string | null;
    abv: number | null;
    status: "active" | "pending_review";
    created: boolean;
    matchedExisting: boolean;
  } {
    const fallbackName = canonicalizeTrackedBeerName(input.name);
    if (!shouldCatalogBeerName(fallbackName, input.isHappyHour === true)) {
      return {
        key: null,
        name: fallbackName,
        brewery: null,
        style: null,
        abv: null,
        status: "pending_review",
        created: false,
        matchedExisting: false,
      };
    }

    const resolveInput = {
      name: fallbackName,
      source: input.source,
      now: input.now,
      matchMode: input.matchMode,
      brewery: input.brewery,
      abv: input.abv,
    } as {
      name: string;
      source: string;
      now: string;
      createIfMissing?: boolean;
      matchMode?: "exact" | "ocr";
      brewery?: string | null;
      abv?: number | null;
    };
    if (input.createIfMissing !== undefined) {
      resolveInput.createIfMissing = input.createIfMissing;
    }
    const resolved = this.resolveSystemBeer(resolveInput);

    return {
      key: resolved.key,
      name: resolved.name,
      brewery: resolved.brewery,
      style: resolved.style,
      abv: resolved.abv,
      status: resolved.status,
      created: resolved.created,
      matchedExisting: resolved.matchedExisting,
    };
  }

  private standardizeBarBeerInput(input: BarBeerInput, source: string, now: string): BarBeerInput & { normalizedBeerId: string | null } {
    const resolved = this.standardizeBeerReference({
      name: input.beerName,
      source,
      now,
    });

    return {
      ...input,
      beerName: resolved.name,
      normalizedBeerId: resolved.key,
      brewery: input.brewery || resolved.brewery,
      style: input.style || resolved.style,
      abv: input.abv ?? resolved.abv,
    };
  }

  private getRequestHashes(context?: SessionRequestContext | undefined) {
    return {
      ipHash: hashRequestFingerprint(context?.ip),
      userAgentHash: hashRequestFingerprint(context?.userAgent),
    };
  }

  private assertDisplayNameAvailable(displayName: string | null, currentUserId: string | null = null): string | null {
    const displayNameKey = publicDisplayNameKey(displayName);
    if (!displayNameKey) {
      return null;
    }

    const existing = this.repository.getAccountByDisplayNameKey(displayNameKey);
    if (existing && existing.id !== currentUserId) {
      throw new AppError("That display name is already taken. Choose another leaderboard name.", 409);
    }

    return displayNameKey;
  }

  private providerDisplayNameIfAvailable(displayName: string | null, currentUserId: string | null = null): { displayName: string | null; displayNameKey: string | null } {
    const displayNameKey = publicDisplayNameKey(displayName);
    if (!displayName || !displayNameKey) {
      return { displayName: null, displayNameKey: null };
    }

    const existing = this.repository.getAccountByDisplayNameKey(displayNameKey);
    if (existing && existing.id !== currentUserId) {
      return { displayName: null, displayNameKey: null };
    }

    return { displayName, displayNameKey };
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
      trackedBeers: this.getTrackedBeerCatalogForViewer(),
    };
  }

  getAdminBeerCatalog(account: BusinessAccount): {
    pending: BeerCatalogAdminItem[];
    active: BeerCatalogAdminItem[];
  } {
    if (!this.isAdmin(account)) {
      throw new AppError("Admin access required.", 403);
    }
    if (!this.beerCatalogRepository) {
      throw new AppError("Beer catalogue review is not configured.", 503);
    }

    return {
      pending: this.beerCatalogRepository.listForAdmin("pending_review", 100),
      active: this.beerCatalogRepository.listForAdmin("active", 500),
    };
  }

  approveBeerCatalogItem(
    account: BusinessAccount,
    key: string,
    input: { reviewNote?: string | null },
  ): { beer: BeerCatalogAdminItem } {
    if (!this.isAdmin(account)) {
      throw new AppError("Admin access required.", 403);
    }
    if (!this.beerCatalogRepository) {
      throw new AppError("Beer catalogue review is not configured.", 503);
    }

    const beer = this.beerCatalogRepository.approvePendingBeer({
      key,
      reviewNote: input.reviewNote ?? null,
      now: nowIso(),
    });
    if (!beer) {
      throw new AppError("Pending beer was not found.", 404);
    }

    return { beer };
  }

  mergeBeerCatalogItem(
    account: BusinessAccount,
    key: string,
    input: { targetKey: string; reviewNote?: string | null },
  ): { source: BeerCatalogAdminItem; target: BeerCatalogAdminItem } {
    if (!this.isAdmin(account)) {
      throw new AppError("Admin access required.", 403);
    }
    if (!this.beerCatalogRepository) {
      throw new AppError("Beer catalogue review is not configured.", 503);
    }

    const result = this.beerCatalogRepository.mergePendingBeer({
      sourceKey: key,
      targetKey: input.targetKey,
      reviewNote: input.reviewNote ?? null,
      now: nowIso(),
    });
    if (!result) {
      throw new AppError("Pending beer could not be merged into that catalogue item.", 404);
    }

    return result;
  }

  rejectBeerCatalogItem(
    account: BusinessAccount,
    key: string,
    input: { reviewNote?: string | null },
  ): { beer: BeerCatalogAdminItem } {
    if (!this.isAdmin(account)) {
      throw new AppError("Admin access required.", 403);
    }
    if (!this.beerCatalogRepository) {
      throw new AppError("Beer catalogue review is not configured.", 503);
    }

    const beer = this.beerCatalogRepository.rejectPendingBeer({
      key,
      reviewNote: input.reviewNote ?? null,
      now: nowIso(),
    });
    if (!beer) {
      throw new AppError("Pending beer was not found.", 404);
    }

    return { beer };
  }

  rejectBeerCatalogItems(
    account: BusinessAccount,
    input: { keys: string[]; reviewNote?: string | null },
  ): { beers: BeerCatalogAdminItem[]; rejectedCount: number } {
    if (!this.isAdmin(account)) {
      throw new AppError("Admin access required.", 403);
    }
    if (!this.beerCatalogRepository) {
      throw new AppError("Beer catalogue review is not configured.", 503);
    }

    const beers = input.keys.map((key) => {
      const beer = this.beerCatalogRepository!.rejectPendingBeer({
        key,
        reviewNote: input.reviewNote ?? null,
        now: nowIso(),
      });
      if (!beer) {
        throw new AppError("Pending beer was not found.", 404);
      }
      return beer;
    });

    return {
      beers,
      rejectedCount: beers.length,
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

  private requireAssignedVenue(
    account: BusinessAccount,
    venueId: string,
    requiredAccess: "manager" | "counter" = "manager",
  ) {
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

    if (requiredAccess === "manager" && assignment.accessLevel !== "manager") {
      this.auditSecurity({
        actor: account,
        action: "venue_counter_staff_privilege_blocked",
        targetType: "venue",
        targetId: venueId,
        metadata: { accessLevel: assignment.accessLevel },
      });
      throw new AppError("Venue manager access required for this action.", 403);
    }

    return assignment;
  }

  private canVoidVenuePintPointActivity(
    account: BusinessAccount,
    assignment: VenueManagerAssignment | null,
    activity: VenuePintPointActivity,
    now = Date.now(),
  ): boolean {
    if (activity.status !== "active") {
      return false;
    }
    if (this.isAdmin(account) || assignment?.accessLevel === "manager") {
      return true;
    }
    const recordedAt = Date.parse(activity.recordedAt);
    return activity.recordedByUserId === account.id
      && Number.isFinite(recordedAt)
      && now - recordedAt >= 0
      && now - recordedAt <= COUNTER_STAFF_VOID_WINDOW_MINUTES * 60_000;
  }

  private sanitizeVenuePintPointActivity(
    account: BusinessAccount,
    assignment: VenueManagerAssignment | null,
    activity: VenuePintPointActivity,
  ) {
    return {
      id: activity.id,
      publicAccountId: activity.publicAccountId,
      itemName: activity.itemName,
      beverageCategory: activity.beverageCategory,
      quantity: activity.quantity,
      pointsAwarded: activity.pointsAwarded,
      source: activity.source,
      status: activity.status,
      voidedAt: activity.voidedAt,
      voidReason: activity.voidReason,
      recordedAt: activity.recordedAt,
      canVoid: this.canVoidVenuePintPointActivity(account, assignment, activity),
    };
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
      acceptsPintPathCodes: false,
      stripeEventCreatedAt: null,
      posWebhookTokenVersion: 1,
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
      acceptsPintPathCodes: false,
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
      beerId: input.changeType === "beer"
        ? stringOrNull(input.payload.normalizedBeerId) ?? normalizeTrackedBeerId(String(input.payload.beerName ?? input.targetId ?? ""))
        : null,
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

    if (input.changeType !== "beer") {
      return null;
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recentDeletes = this.repository.countRecentVenueManagerDeletes({
      venueId: input.venueId,
      since: oneHourAgo,
      changeType: input.changeType,
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
        message: input.changeType === "beer"
          ? "Beer delete held for admin review because 3 beers were already removed in the last hour."
          : "Delete held for admin review because several venue items were removed in the last hour.",
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
      message: input.changeType === "beer"
        ? "Beer delete held for admin review because 3 beers were already removed in the last hour."
        : "Delete held for admin review because several venue items were removed in the last hour.",
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
        acceptsPintPathCodes: existing?.acceptsPintPathCodes ?? false,
        active: booleanFromUnknown(payload.active, existing?.active ?? true),
        now,
        ...flags,
      });
      return;
    }

    if (change.changeType === "beer") {
      const payload = change.payload;
      const targetId = change.targetId ?? stringOrNull(payload.id) ?? crypto.randomUUID();
      const beerInput = this.standardizeBarBeerInput({
        id: targetId,
        beerName: stringOrNull(payload.beerName) ?? "Unnamed beer",
        brewery: stringOrNull(payload.brewery),
        style: stringOrNull(payload.style),
        abv: numberOrNull(payload.abv),
        serveSize: stringOrNull(payload.serveSize) as ServingSize | null,
        price: numberOrNull(payload.price),
        onTap: booleanFromUnknown(payload.onTap, false),
        inStock: booleanFromUnknown(payload.inStock, true),
        notes: stringOrNull(payload.notes),
      }, "approved_venue_inventory_change", now);
      this.ensureBarProfile({
        barId: change.barId,
        name: this.repository.getBarProfile(change.barId)?.name ?? change.barId,
        suburb: this.repository.getBarProfile(change.barId)?.suburb ?? null,
      });
      this.repository.upsertBarBeer({
        id: targetId,
        barId: change.barId,
        beerName: beerInput.beerName,
        normalizedBeerId: beerInput.normalizedBeerId,
        brewery: beerInput.brewery,
        style: beerInput.style,
        abv: beerInput.abv,
        serveSize: beerInput.serveSize,
        price: beerInput.price,
        currency: "AUD",
        onTap: beerInput.onTap,
        inStock: beerInput.inStock,
        notes: beerInput.notes,
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
        happyHourBeers: happyHourBeersFromUnknown(payload.happyHourBeers),
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

  async signup(input: AuthSignupInput, context?: SessionRequestContext | undefined) {
    const email = normalizeEmail(input.email);

    if (this.repository.getAccountByEmail(email)) {
      throw new AppError("An account already exists for that email.", 409);
    }

    const now = nowIso();
    const adminEmails = this.getAdminEmailAllowlist();
    const displayName = validatePublicDisplayName(input.displayName);
    const displayNameKey = this.assertDisplayNameAvailable(displayName);
    const account = this.repository.createAccount({
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(input.password),
      displayName,
      displayNameKey,
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

  async login(input: AuthLoginInput, context?: SessionRequestContext | undefined) {
    const account = this.repository.getAccountByEmail(normalizeEmail(input.email));

    if (!account || !await verifyPassword(input.password, account.passwordHash)) {
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
    const mfaClaims = getSupabaseMfaClaims(input.accessToken);

    if (!account) {
      const adminEmails = this.getAdminEmailAllowlist();
      const providerIdentity = this.providerDisplayNameIfAvailable(displayName);
      account = this.repository.createAccount({
        id: supabaseUser.id,
        email,
        passwordHash: "supabase-auth",
        displayName: providerIdentity.displayName,
        displayNameKey: providerIdentity.displayNameKey,
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
      const providerIdentity = this.providerDisplayNameIfAvailable(nextDisplayName, account.id);
      account = this.repository.linkSupabaseAccount({
        userId: account.id,
        supabaseUserId: supabaseUser.id,
        authProvider: "supabase",
        displayName: providerIdentity.displayName,
        displayNameKey: providerIdentity.displayNameKey,
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
    const displayNameKey = this.assertDisplayNameAvailable(displayName, account.id);
    const updated = this.repository.updateAccountDisplayName({
      userId: account.id,
      displayName,
      displayNameKey,
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

    const expiresAt = addDays(now, ttlDays);
    this.repository.createSession({
      tokenHash: hashToken(token),
      userId: account.id,
      createdAt: now,
      expiresAt,
      lastUsedAt: now,
      lastIpHash: requestHashes.ipHash,
      userAgentHash: requestHashes.userAgentHash,
    });

    return {
      token,
      expiresAt,
      account: sanitizeAccount(account),
      access: this.getAccessState(account, null),
    };
  }

  getSessionExpiresAt(authorizationHeader: string | undefined): string | null {
    const token = getBearerToken(authorizationHeader);
    return token ? this.repository.getSessionExpiresAt(hashToken(token), nowIso()) : null;
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

    return {
      status: account?.subscriptionStatus ?? "free",
      isAuthenticated: Boolean(account),
      accountRole: account?.role ?? null,
      hasFullAccess,
      isAdmin: account?.role === "admin" || account?.subscriptionStatus === "admin",
      ageConfirmed: Boolean(account?.ageConfirmedAt),
      priceAccessModel: hasFullAccess ? "full" : "fixed_preview",
      freePriceRevealsPerDay: 0,
      freePriceRevealsUsedToday: 0,
      freePriceRevealsRemainingToday: 0,
      canRevealPrice: hasFullAccess,
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
    const profile = this.repository.getBarProfile(input.venueId);
    if (!profile?.acceptsPintPathCodes) {
      throw new AppError("This venue is not currently enabled to accept Pint Path codes.", 403);
    }
    const idempotencyKey = input.source === "pos_webhook"
      ? `pos:${String(input.posReference ?? "").trim()}`
      : `pass:${hashDiscountCode(input.code)}`;
    const existingRedemption = this.repository.getDiscountRedemptionByIdempotencyKey({
      venueId: input.venueId,
      idempotencyKey,
    });
    if (existingRedemption) {
      return {
        redemption: existingRedemption,
        accountId: existingRedemption.publicAccountId,
        venueId: existingRedemption.venueId,
        venueName: existingRedemption.venueName,
        suburb: existingRedemption.suburb,
        estimatedSavingsDollars: Number((existingRedemption.estimatedSavingsCents / 100).toFixed(2)),
        pointsEarned: Number(existingRedemption.metadata.pointsEarned ?? 0),
        idempotentReplay: true,
        copy: "This transaction was already recorded. No duplicate Pint Points were added.",
      };
    }
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

    const dailyPoints = this.repository.countPintPointsAwardedSince({
      userId: user.id,
      since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const pointsEarned = Math.min(input.quantity, Math.max(0, PINT_POINTS_DAILY_CAP - dailyPoints));
    const { redemption, pintPointRecord } = this.repository.runInTransaction(() => {
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
        idempotencyKey,
        redeemedAt: now,
        metadata: sanitizeEventMetadata(redactSecrets({
          ...input.metadata,
          notes: input.notes,
          source: input.source,
          redeemedByRole: input.redeemedByRole,
          posReference: input.posReference,
          terminalId: input.terminalId,
          posRedeemedAt: input.posRedeemedAt,
          pointsEarned,
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
        pointsAwarded: pointsEarned,
        source: input.source,
        recordedByUserId: input.actor?.id ?? null,
        idempotencyKey,
        recordedAt: now,
        metadata: sanitizeEventMetadata(redactSecrets({
          discountRedemptionId: redemption.id,
          discountPassId: pass.id,
          specialId: input.specialId,
          source: input.source,
          redeemedByRole: input.redeemedByRole,
          posReference: input.posReference,
          terminalId: input.terminalId,
          dailyCap: PINT_POINTS_DAILY_CAP,
        })),
      });
      this.repository.markDiscountPassUsed({ id: pass.id, lastUsedAt: now });
      return { redemption, pintPointRecord };
    });
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
    const assignment = this.requireAssignedVenue(account, venueId, "counter");
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
    const profile = this.repository.getBarProfile(venueId);
    const tokenVersion = profile?.posWebhookTokenVersion ?? 1;
    const token = this.config.POS_WEBHOOK_SIGNING_SECRET && tierCapabilities.posWebhookIntegration
      ? createPosWebhookToken(this.config.POS_WEBHOOK_SIGNING_SECRET, venueId, tokenVersion)
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
      tokenVersion,
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

  rotateVenuePosIntegrationToken(account: BusinessAccount, venueId: string) {
    this.requireAssignedVenue(account, venueId);
    const profile = this.repository.getBarProfile(venueId);
    if (!profile) {
      throw new AppError("Venue profile not found.", 404);
    }
    this.repository.rotateBarPosWebhookToken({ barId: venueId, now: nowIso() });
    this.auditSecurity({
      actor: account,
      action: "venue_pos_token_rotated",
      targetType: "venue",
      targetId: venueId,
      metadata: { previousVersion: profile.posWebhookTokenVersion },
    });
    return this.getVenuePosIntegration(account, venueId);
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
    const profile = this.repository.getBarProfile(input.venueId);
    const expectedToken = createPosWebhookToken(secret, input.venueId, profile?.posWebhookTokenVersion ?? 1);
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
    const recentDrinkRecords = this.repository.listPintPointDrinkRecordsForUser(account.id, 25);
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

  previewPintPointMember(account: BusinessAccount, venueId: string, input: PintPointMemberPreviewInput) {
    const assignment = this.requireAssignedVenue(account, venueId, "counter");
    const venue = this.getDiscountVenueIdentity(venueId, assignment);
    const profile = this.repository.getBarProfile(venueId);
    if (!profile?.acceptsPintPathCodes) {
      throw new AppError("This venue is not currently enabled to accept Pint Path codes.", 403);
    }

    const now = nowIso();
    const pass = this.repository.getActiveDiscountPassByCodeHash({
      codeHash: hashDiscountCode(input.code),
      now,
    });
    if (!pass) {
      throw new AppError("Pint Path code expired or not found. Ask the user to refresh their code.", 404);
    }
    const user = this.repository.getAccountById(pass.userId);
    if (!user || !isFullAccess(user)) {
      throw new AppError("This Pint Path account cannot receive Pint Points right now.", 403);
    }

    const pointsToday = this.repository.countPintPointsAwardedSince({
      userId: user.id,
      since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const wallet = this.getPintPointWalletForAccount(user, now);

    return {
      accountId: user.publicAccountId,
      eligible: true,
      expiresAt: pass.expiresAt,
      pointsToday,
      pointsRemainingToday: Math.max(0, PINT_POINTS_DAILY_CAP - pointsToday),
      wallet: {
        available: wallet.available,
        threshold: wallet.threshold,
        progress: wallet.progress,
        pointsUntilReward: wallet.pointsUntilReward,
        rewardAvailable: wallet.rewardAvailable,
      },
      venue: {
        venueId,
        venueName: venue.venueName,
      },
      privacyCopy: "Only the public member ID and Pint Points eligibility are shown to venue staff.",
    };
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
    const assignment = this.requireAssignedVenue(account, venueId, "counter");
    const venue = this.getDiscountVenueIdentity(venueId, assignment);
    const profile = this.repository.getBarProfile(venueId);
    if (!profile?.acceptsPintPathCodes) {
      throw new AppError("This venue is not currently enabled to accept Pint Path codes.", 403);
    }
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
    const idempotencyKey = `manual:${input.transactionReference.trim().toLowerCase()}`;
    const existingRecord = this.repository.getPintPointDrinkRecordByIdempotencyKey({ venueId, idempotencyKey });
    if (existingRecord) {
      const itemMatches = (existingRecord.itemName ?? "") === (input.itemName ?? "");
      const payloadMatches = existingRecord.userId === user.id
        && existingRecord.beverageCategory === input.beverageCategory
        && existingRecord.quantity === input.quantity
        && itemMatches;
      if (!payloadMatches) {
        throw new AppError("That receipt reference is already attached to a different purchase.", 409);
      }
      const wallet = this.getPintPointWalletForAccount(user, now);
      return {
        record: sanitizeVenuePintPointDrinkRecord(existingRecord),
        accountId: user.publicAccountId,
        pointsEarned: existingRecord.pointsAwarded,
        wallet,
        idempotentReplay: true,
        copy: "Already recorded. No duplicate Pint Points were added.",
        progressCopy: `You now have ${wallet.available} / ${FREE_PINT_REWARD_POINTS} Pint Points.`,
        rewardCopy: wallet.pointsUntilReward === 0
          ? "You have enough Pint Points for a Free Pint Reward."
          : `${wallet.pointsUntilReward} Pint Point${wallet.pointsUntilReward === 1 ? "" : "s"} until your Free Pint Reward.`,
      };
    }
    const dailyPoints = this.repository.countPintPointsAwardedSince({
      userId: user.id,
      since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const pointsEarned = isAlcoholic
      ? Math.min(input.quantity, Math.max(0, PINT_POINTS_DAILY_CAP - dailyPoints))
      : 0;
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
      pointsAwarded: pointsEarned,
      source: "venue_portal",
      recordedByUserId: account.id,
      idempotencyKey,
      recordedAt: now,
      metadata: {
        notes: input.notes,
        enteredByRole: account.role,
      },
    });

    const wallet = this.getPintPointWalletForAccount(user, now);
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
      record: sanitizeVenuePintPointDrinkRecord(record),
      accountId: user.publicAccountId,
      pointsEarned,
      wallet,
      idempotentReplay: false,
      copy: pointsEarned > 0
        ? `Nice — you earned ${pointsEarned} Pint Point${pointsEarned === 1 ? "" : "s"}.`
        : "Recorded. Food and non-alcoholic drinks do not earn Pint Points.",
      progressCopy: `You now have ${wallet.available} / ${FREE_PINT_REWARD_POINTS} Pint Points.`,
      rewardCopy: wallet.pointsUntilReward === 0
        ? "You have enough Pint Points for a Free Pint Reward."
        : `${wallet.pointsUntilReward} Pint Point${wallet.pointsUntilReward === 1 ? "" : "s"} until your Free Pint Reward.`,
    };
  }

  voidPintPointDrink(
    account: BusinessAccount,
    venueId: string,
    recordId: string,
    input: PintPointDrinkVoidInput,
  ) {
    const assignment = this.requireAssignedVenue(account, venueId, "counter");
    const record = this.repository.getPintPointDrinkRecordById(recordId);
    if (!record || record.venueId !== venueId) {
      throw new AppError("Pint Points purchase record not found for this venue.", 404);
    }

    const isManager = this.isAdmin(account) || assignment?.accessLevel === "manager";
    if (!isManager && record.recordedByUserId !== account.id) {
      throw new AppError("Counter staff can only reverse purchases they recorded themselves.", 403);
    }

    if (!isManager && record.status === "active") {
      const recordedAt = Date.parse(record.recordedAt);
      const ageMs = Date.now() - recordedAt;
      if (!Number.isFinite(recordedAt) || ageMs < 0 || ageMs > COUNTER_STAFF_VOID_WINDOW_MINUTES * 60_000) {
        throw new AppError(
          `Counter staff can reverse a purchase for ${COUNTER_STAFF_VOID_WINDOW_MINUTES} minutes. Ask a venue manager after that.`,
          403,
        );
      }
    }

    const now = nowIso();
    const result = this.repository.voidPintPointDrinkRecord({
      recordId,
      venueId,
      actorUserId: account.id,
      reason: input.reason,
      voidedAt: now,
    });
    if (!result) {
      throw new AppError("Pint Points purchase record not found for this venue.", 404);
    }

    const member = this.repository.getAccountById(result.record.userId);
    const wallet = member ? this.getPintPointWalletForAccount(member, now) : null;
    if (!result.idempotentReplay) {
      if (member) {
        this.recordUserActivity({
          account: member,
          eventType: "pint_point_drink_voided",
          relatedEntityType: "venue",
          relatedEntityId: venueId,
          metadata: {
            drinkRecordId: recordId,
            pointsReversed: result.record.pointsAwarded,
          },
        });
      }
      this.auditSecurity({
        actor: account,
        action: "pint_point_drink_voided",
        targetType: "pint_point_drink_record",
        targetId: recordId,
        metadata: {
          venueId,
          pointsReversed: result.record.pointsAwarded,
          reason: input.reason,
          accessLevel: assignment?.accessLevel ?? "admin",
        },
      });
    }

    return {
      record: sanitizeVenuePintPointDrinkRecord(result.record),
      accountId: member?.publicAccountId ?? null,
      pointsReversed: result.record.pointsAwarded,
      wallet,
      idempotentReplay: result.idempotentReplay,
      copy: result.idempotentReplay
        ? "This purchase was already reversed. No further points changed."
        : `${result.record.pointsAwarded} Pint Point${result.record.pointsAwarded === 1 ? " was" : "s were"} reversed with an audit record.`,
    };
  }

  handleFreePintRewardCode(account: BusinessAccount, venueId: string, input: FreePintRewardDecisionInput) {
    const assignment = this.requireAssignedVenue(account, venueId, "counter");
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
    const leaderboardEntries = this.repository.listLeaderboard({ period: "month", limit: 50, now: dashboardNow, monthKey });
    const discountStats = this.repository.getDiscountRedemptionStats(account.id);
    const recentDiscountRedemptions = this.repository.listDiscountRedemptionsForUser(account.id, 10);
    const rewardVouchers = this.repository.listAccountRewardVouchers(account.id, 10);
    const pintPointsWallet = this.getPintPointWalletForAccount(account, dashboardNow);
    const hasFullAccess = isFullAccess(account);
    const missionHistory = this.repository.listMissionProgressForUser(account.id, 12).map((progress) => {
      const mission = this.repository.getMissionById(progress.missionId);
      return {
        id: progress.id,
        missionId: progress.missionId,
        submissionId: progress.submissionId,
        status: progress.status,
        acceptedAt: progress.acceptedAt,
        submittedAt: progress.submittedAt,
        completedAt: progress.completedAt,
        updatedAt: progress.updatedAt,
        venueId: mission?.venueId ?? null,
        venueName: mission?.venueName ?? "Pint Path mission",
        suburb: mission?.suburb ?? null,
        reason: mission?.reason ?? "Mission details are no longer active.",
        points: mission?.points ?? null,
        multiplier: mission?.multiplier ?? null,
      };
    });

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
      missionHistory,
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
        canIDrive: {
          enabled: hasFullAccess,
          sourceDrinkLimit: 25,
          copy: "Review standard drinks only when exact ABV and serving volume are available. Pint Path does not estimate BAC or provide driving clearance.",
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
      let sourceEvidence: ReturnType<BusinessService["getSubmissionSourceEvidenceUrl"]> | null = null;
      if (submission.sourcePhotoUrl) {
        try {
          sourceEvidence = this.getSubmissionSourceEvidenceUrl(account, submission.id);
        } catch (error) {
          if (!(error instanceof AppError) || error.statusCode !== 404) throw error;
        }
      }
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
        uploadLatitude: submission.uploadLatitude,
        uploadLongitude: submission.uploadLongitude,
        hasPrivateEvidence: Boolean(submission.sourcePhotoUrl),
        sourceEvidence,
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
    const byIdentity = new Map<string, VenueRow>();
    const byId = new Map<string, VenueRow>();
    const now = nowIso();

    for (const venue of [...primary, ...secondary]) {
      const enriched = { ...venue, ...this.getPublicVenueTierMetadata(venue.id) };
      const identity = venueIdentityKey(enriched) ?? `id:${enriched.id}`;
      const existing = byIdentity.get(identity);
      if (!existing) {
        byIdentity.set(identity, enriched);
        byId.set(enriched.id, enriched);
        this.repository.upsertVenueIdentityAlias({
          aliasVenueId: enriched.id,
          canonicalVenueId: enriched.id,
          identityKey: identity,
          now,
        });
        continue;
      }

      const canonical = {
        ...enriched,
        ...existing,
        address: existing.address ?? enriched.address,
        suburb: existing.suburb ?? enriched.suburb,
        state: existing.state ?? enriched.state,
        postcode: existing.postcode ?? enriched.postcode,
        latitude: existing.latitude ?? enriched.latitude,
        longitude: existing.longitude ?? enriched.longitude,
        membershipTier: existing.membershipTier === "pro" || enriched.membershipTier === "pro" ? "pro" : "basic",
        highlightedName: Boolean(existing.highlightedName || enriched.highlightedName),
        premiumBadge: existing.premiumBadge ?? enriched.premiumBadge ?? null,
        promoted: Boolean(existing.promoted || enriched.promoted),
        featuredSpecialEligible: Boolean(existing.featuredSpecialEligible || enriched.featuredSpecialEligible),
        acceptsPintPathCodes: Boolean(existing.acceptsPintPathCodes || enriched.acceptsPintPathCodes),
      } satisfies VenueRow;
      byIdentity.set(identity, canonical);
      byId.set(existing.id, canonical);
      this.repository.upsertVenueIdentityAlias({
        aliasVenueId: enriched.id,
        canonicalVenueId: existing.id,
        identityKey: identity,
        now,
      });
    }

    return Array.from(byIdentity.values()).slice(0, limit);
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

  private validatedSubmissionImageDataUrls(input: CreateSubmissionInput): string[] {
    const candidates = [input.sourcePhotoDataUrl, ...(input.sourcePhotoDataUrls ?? [])].filter(
      (value): value is string => Boolean(value),
    );
    const uniqueCandidates = Array.from(new Set(candidates));
    let totalBytes = 0;
    const validated = uniqueCandidates.map((imageDataUrl) => {
      const { mimeType, bytes } = validateImageDataUrl(imageDataUrl, {
        allowedMimeTypes: SUBMISSION_LIMITS.allowedImageMimeTypes,
        maxBytes: SUBMISSION_LIMITS.maxPhotoBytes,
        invalidMimeMessage: "Upload must be a JPEG, PNG, WebP, HEIC, or HEIF image.",
        tooLargeMessage: "Each upload image must be 6MB or smaller.",
        activePayloadMessage: "Upload must be a safe image file, not SVG, HTML, XML, script, or style content.",
        mismatchMessage: "Upload image content does not match the declared file type.",
      });
      totalBytes += bytes.length;
      return `data:${mimeType};base64,${bytes.toString("base64")}`;
    });

    // Base64 adds roughly one third to the request size; stay below Express' 12MB body limit.
    if (totalBytes > 8 * 1024 * 1024) {
      throw new AppError("Source images must be 8MB or smaller in total after compression.", 400);
    }
    return validated;
  }

  private validatedSubmissionDocumentDataUrl(input: CreateSubmissionInput): string | null {
    if (!input.sourceDocumentDataUrl) return null;
    const { bytes } = validateSubmissionPdfDataUrl(input.sourceDocumentDataUrl);
    return `data:application/pdf;base64,${bytes.toString("base64")}`;
  }

  private decodedDataUrlBytes(dataUrl: string): number {
    const separatorIndex = dataUrl.indexOf(",");
    if (separatorIndex < 0) return 0;
    return Buffer.from(dataUrl.slice(separatorIndex + 1), "base64").length;
  }

  private async preparePhotoOcr(input: CreateSubmissionInput): Promise<PreparedPhotoOcr | null> {
    if (input.submissionType !== "photo_upload") return null;
    const imageDataUrls = input.sourcePhotoDataUrls ?? [];
    const documentDataUrls = input.sourceDocumentDataUrl ? [input.sourceDocumentDataUrl] : [];
    const sourceCount = imageDataUrls.length + documentDataUrls.length;
    if (!sourceCount || !this.menuPhotoOcr) {
      return {
        status: "manual_review_required",
        summary: {
          model: null,
          imageCount: sourceCount || (input.sourcePhotoUrl ? 1 : 0),
          extractedRowCount: 0,
          rejectedCandidateCount: 0,
          pendingCatalogCount: 0,
          message: this.menuPhotoOcr
            ? "The source is attached for admin review, but it could not be sent to OCR."
            : "OCR is unavailable on this deployment. The source is attached for manual admin review.",
        },
        items: [],
      };
    }

    try {
      const startedAt = nowIso();
      this.repository.setSystemState("job:menu_ocr", { state: "running", startedAt }, startedAt);
      const result: MenuPhotoOcrResult = await this.menuPhotoOcr.extract({
        venueNameHint: input.newVenue?.name ?? input.venueName,
        imageDataUrls,
        documentDataUrls,
      });
      const items = result.beers
        .map(preparedSubmissionItemFromOcr)
        .filter((item): item is PreparedSubmissionItem => Boolean(item));
      const deduplicated = Array.from(new Map(items.map((item) => [
        [normalizeBeerSearchKey(item.beerName), item.servingSize, item.price ?? "none", item.isOnTap].join(":"),
        item,
      ])).values()).slice(0, 60);
      const completedAt = nowIso();
      this.repository.setSystemState("job:menu_ocr", {
        state: "succeeded",
        startedAt,
        completedAt,
        sourceCount,
        extractedRowCount: deduplicated.length,
        rejectedCandidateCount: result.rejectedCandidateCount,
      }, completedAt);

      return {
        status: deduplicated.length ? "processed" : "manual_review_required",
        summary: {
          model: result.model,
          imageCount: result.imageCount,
          extractedRowCount: deduplicated.length,
          rejectedCandidateCount: result.rejectedCandidateCount + Math.max(0, result.beers.length - items.length),
          pendingCatalogCount: 0,
          message: deduplicated.length
            ? "OCR rows are attached for admin verification before publication."
            : "No reliable beer rows were found. The images remain attached for manual admin review.",
        },
        items: deduplicated,
      };
    } catch (error) {
      const completedAt = nowIso();
      this.repository.setSystemState("job:menu_ocr", {
        state: "failed",
        completedAt,
        sourceCount,
        error: error instanceof Error ? redactSecrets(error.message).slice(0, 300) : "Menu OCR failed",
      }, completedAt);
      logger.warn("User submission photo OCR failed; preserving evidence for manual review", {
        venueId: input.venueId,
        imageCount: sourceCount,
        error: error instanceof Error ? redactSecrets(error.message) : "unknown",
      });
      return {
        status: "failed",
        summary: {
          model: null,
          imageCount: sourceCount,
          extractedRowCount: 0,
          rejectedCandidateCount: 0,
          pendingCatalogCount: 0,
          message: "Automatic reading failed. The original images are attached for manual admin review.",
        },
        items: [],
      };
    }
  }

  async createUserSubmission(account: BusinessAccount, input: CreateSubmissionInput) {
    this.assertAccountCanSubmit(account);
    if (input.clientSubmissionId) {
      const existing = this.repository.getSubmissionByClientSubmissionId(account.id, input.clientSubmissionId);
      if (existing) {
        return {
          submission: existing.submission,
          statusCopy: `${existing.submission.venueName} is already saved for review from this device.`,
          ocrStatus: existing.submission.ocrStatus,
          idempotentReplay: true,
        };
      }
    }

    const imageDataUrls = this.validatedSubmissionImageDataUrls(input);
    const sourceDocumentDataUrl = this.validatedSubmissionDocumentDataUrl(input);
    const sourceBytes = imageDataUrls.reduce((total, value) => total + this.decodedDataUrlBytes(value), 0) +
      (sourceDocumentDataUrl ? this.decodedDataUrlBytes(sourceDocumentDataUrl) : 0);
    if (sourceBytes > 11 * 1024 * 1024) {
      throw new AppError("Combined menu evidence is too large. Upload fewer images or one smaller PDF.", 400);
    }
    const normalizedInput: CreateSubmissionInput = {
      ...input,
      sourcePhotoDataUrl: null,
      sourcePhotoDataUrls: imageDataUrls,
      sourceDocumentDataUrl,
    };
    const verifiedInput = await this.withVerifiedPendingGoogleVenue(account, normalizedInput);
    const photoOcr = await this.preparePhotoOcr(verifiedInput);
    const sourcePhotoRefs = await this.resolveSubmissionSourcePhotos(account, verifiedInput);
    return this.createSubmission(account, verifiedInput, { photoOcr, sourcePhotoRefs });
  }

  createSubmission(
    account: BusinessAccount,
    input: CreateSubmissionInput,
    options: {
      allowVenueManager?: boolean;
      rewardEligible?: boolean;
      photoOcr?: PreparedPhotoOcr | null;
      sourcePhotoRefs?: string[];
    } = {},
  ) {
    this.assertAccountCanSubmit(account, { allowVenueManager: options.allowVenueManager === true });
    const rewardEligible = options.rewardEligible ?? true;

    if (input.clientSubmissionId) {
      const existingSubmission = this.repository.getSubmissionByClientSubmissionId(account.id, input.clientSubmissionId);
      if (existingSubmission) {
        return {
          submission: existingSubmission.submission,
          statusCopy: `${existingSubmission.submission.venueName} is already saved for review from this device.`,
          ocrStatus: existingSubmission.submission.ocrStatus,
          idempotentReplay: true,
        };
      }
    }

    const now = nowIso();
    if (input.missionId) {
      const mission = this.repository.getMissionById(input.missionId);
      if (!mission || !mission.active) {
        throw new AppError("This mission is no longer active. Refresh Missions and choose a current task.", 409);
      }
      if (mission.venueId !== input.venueId) {
        throw new AppError("The selected venue does not match this mission.", 400);
      }
      const progress = this.repository.getMissionProgress({ missionId: mission.id, userId: account.id });
      if (progress?.status === "completed") {
        throw new AppError("You have already completed this mission.", 409);
      }
    }
    const pendingVenue = this.normalizePendingVenue(input);
    this.assertPendingVenueIsNotKnownDuplicate(pendingVenue);
    const sourcePhotoRefs = options.sourcePhotoRefs ?? this.resolveInlineSubmissionSourcePhotos(account, input);
    const sourcePhotoUrl = sourcePhotoRefs[0] ?? null;
    const rawLocationEligibility = this.getSubmissionLocationEligibility(input);
    const locationEligibility = rewardEligible
      ? rawLocationEligibility
      : {
          ...rawLocationEligibility,
          pointsEligibleByLocation: false,
          pointsEligibilityReason: "venue_manager_not_reward_eligible",
        };
    const preparedItems: PreparedSubmissionItem[] = [
      ...input.items.map((item) => ({
        ...item,
        captureSource: "manual" as const,
        sourceText: null,
        confidence: sourcePhotoUrl ? 0.72 : 0.52,
        catalogBrewery: null,
        catalogAbv: null,
      })),
      ...(options.photoOcr?.items ?? []),
    ];
    const standardizedCandidates = preparedItems.map((item) => {
      const isPhotoOcr = item.captureSource === "photo_ocr";
      const beer = this.standardizeBeerReference({
        name: item.beerName,
        source: isPhotoOcr
          ? "user_photo_ocr"
          : item.isHappyHourPrice
            ? "happy_hour_submission"
            : "user_submission",
        now,
        isHappyHour: item.isHappyHourPrice,
        matchMode: isPhotoOcr ? "ocr" : "exact",
        brewery: item.catalogBrewery,
        abv: item.catalogAbv,
      });
      return {
        ...item,
        beerName: beer.name,
        normalizedBeerId: beer.key,
        requiresCatalogApproval: beer.status !== "active",
      };
    });
    const standardizedItems = Array.from(standardizedCandidates.reduce((byKey, item) => {
      const key = [
        item.normalizedBeerId ?? normalizeBeerSearchKey(item.beerName),
        item.servingSize,
        item.price ?? "none",
        item.isOnTap,
      ].join(":");
      const existing = byKey.get(key);
      if (!existing || item.confidence > existing.confidence) {
        byKey.set(key, item);
      }
      return byKey;
    }, new Map<string, (typeof standardizedCandidates)[number]>()).values());
    const pendingCatalogCount = new Set(
      standardizedItems
        .filter((item) => item.requiresCatalogApproval)
        .map((item) => item.normalizedBeerId)
        .filter((key): key is string => Boolean(key)),
    ).size;
    const ocrSummary = options.photoOcr
      ? {
          ...options.photoOcr.summary,
          extractedRowCount: standardizedItems.filter((item) => item.captureSource === "photo_ocr").length,
          pendingCatalogCount,
        }
      : null;
    const submission = this.repository.createSubmission({
      id: crypto.randomUUID(),
      clientSubmissionId: input.clientSubmissionId,
      missionId: input.missionId,
      userId: account.id,
      venueId: input.venueId,
      venueName: pendingVenue?.name ?? input.venueName,
      suburb: pendingVenue?.suburb ?? input.suburb,
      submissionType: input.submissionType,
      observedAt: input.observedAt,
      sourcePhotoUrl,
      sourceEvidenceIds: sourcePhotoRefs
        .map(getPrivateEvidenceId)
        .filter((id): id is string => Boolean(id)),
      ocrStatus: options.photoOcr?.status ?? "not_requested",
      ocrSummary,
      notes: input.notes,
      now,
      ...locationEligibility,
      pendingVenue,
      items: standardizedItems.map((item) => ({
        id: crypto.randomUUID(),
        beerName: item.beerName,
        normalizedBeerId: item.normalizedBeerId,
        servingSize: item.servingSize,
        price: item.price,
        isHappyHourPrice: item.isHappyHourPrice,
        happyHourDetails: item.happyHourDetails,
        isOnTap: item.isOnTap,
        confidence: item.confidence,
        captureSource: item.captureSource,
        sourceText: item.sourceText,
        requiresCatalogApproval: item.requiresCatalogApproval,
      })),
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

    const firstItem = standardizedItems[0] ?? null;
    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "submission_completed",
      venueId: submission.venueId,
      beerId: firstItem?.normalizedBeerId ?? (firstItem?.beerName ? normalizeTrackedBeerId(firstItem.beerName) : null),
      suburb: submission.suburb,
      metadata: {
        submissionId: submission.id,
        submissionType: submission.submissionType,
        itemCount: standardizedItems.length,
        hasSourcePhoto: Boolean(sourcePhotoUrl),
        ocrStatus: submission.ocrStatus,
        pendingCatalogCount,
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
        itemCount: standardizedItems.length,
        ocrStatus: submission.ocrStatus,
        pendingCatalogCount,
        pointsEligibleByLocation: submission.pointsEligibleByLocation,
        rewardEligible,
        newVenue: Boolean(pendingVenue),
        venuePublishedImmediately: publishedVenueImmediately,
      },
    });

    return {
      submission,
      statusCopy: options.photoOcr
        ? standardizedItems.length
          ? `OCR read ${standardizedItems.length} beer row${standardizedItems.length === 1 ? "" : "s"}. ${pendingCatalogCount ? `${pendingCatalogCount} new beer name${pendingCatalogCount === 1 ? " needs" : "s need"} catalogue approval. ` : ""}Everything remains pending admin review before publication.`
          : options.photoOcr.summary.message ?? "Images attached for manual admin review."
        : publishedVenueImmediately
        ? "Venue added to the public map. Drink data is saved for review before prices appear publicly."
        : pendingVenue
        ? "New venue and drink data submitted for admin review. It will appear on the global map only after approval."
        : !rewardEligible
        ? "Venue update submitted for review. Venue-manager updates do not earn contributor points."
        : submission.pointsEligibleByLocation
        ? "Submitted for review. If approved, this can earn points toward this month's contributor unlock."
        : "Submitted for review. Points need a saved upload location within 200m of the venue.",
      ocrStatus: submission.ocrStatus,
    };
  }

  private async resolveSubmissionSourcePhotos(
    account: Pick<BusinessAccount, "id">,
    input: CreateSubmissionInput,
  ): Promise<string[]> {
    const refs: string[] = [];
    const dataUrls = Array.from(new Set([
      input.sourcePhotoDataUrl,
      ...(input.sourcePhotoDataUrls ?? []),
      input.sourceDocumentDataUrl,
    ].filter((value): value is string => Boolean(value))));
    for (const sourcePhotoDataUrl of dataUrls) {
      const ref = await this.resolveSourcePhoto(account, {
        sourcePhotoDataUrl: sourcePhotoDataUrl.startsWith("data:application/pdf") ? null : sourcePhotoDataUrl,
        sourceDocumentDataUrl: sourcePhotoDataUrl.startsWith("data:application/pdf") ? sourcePhotoDataUrl : null,
        sourcePhotoUrl: null,
      });
      if (ref) refs.push(ref);
    }

    if (input.sourcePhotoUrl) {
      const ref = await this.resolveSourcePhoto(account, {
        sourcePhotoDataUrl: null,
        sourceDocumentDataUrl: null,
        sourcePhotoUrl: input.sourcePhotoUrl,
      });
      if (ref) refs.push(ref);
    }

    return refs;
  }

  private resolveInlineSubmissionSourcePhotos(
    account: Pick<BusinessAccount, "id">,
    input: CreateSubmissionInput,
  ): string[] {
    const refs: string[] = [];
    const dataUrls = Array.from(new Set([
      input.sourcePhotoDataUrl,
      ...(input.sourcePhotoDataUrls ?? []),
      input.sourceDocumentDataUrl,
    ].filter((value): value is string => Boolean(value))));
    for (const sourcePhotoDataUrl of dataUrls) {
      const { mimeType, bytes } = validateSubmissionEvidenceDataUrl(sourcePhotoDataUrl);
      if (this.config.NODE_ENV === "production" && !this.config.ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION) {
        throw new AppError("Production evidence uploads must use the asynchronous submission endpoint.", 500, undefined, false);
      }
      const createdAt = nowIso();
      const evidence = this.repository.createSourceEvidenceObject({
        id: crypto.randomUUID(),
        ownerUserId: account.id,
        storageProvider: "sqlite_private",
        objectPath: `evidence/${crypto.randomUUID()}`,
        mimeType,
        byteSize: bytes.length,
        dataBase64: bytes.toString("base64"),
        externalUrl: null,
        retentionExpiresAt: addDays(createdAt, this.config.SOURCE_EVIDENCE_RETENTION_DAYS ?? 90),
        createdAt,
      });
      refs.push(privateEvidenceRef(evidence.id));
    }
    if (input.sourcePhotoUrl) {
      parseSafeImageSourceUrl(input.sourcePhotoUrl, "Source photo URL");
      throw new AppError("For reviewer safety, upload the source image directly instead of linking to an external site.", 400);
    }
    return refs;
  }

  private async resolveSourcePhoto(
    account: Pick<BusinessAccount, "id"> | null,
    input: Pick<CreateSubmissionInput, "sourcePhotoDataUrl" | "sourcePhotoUrl"> & {
      sourceDocumentDataUrl?: string | null;
    },
  ): Promise<string | null> {
    const dataUrl = input.sourceDocumentDataUrl ?? input.sourcePhotoDataUrl;
    if (dataUrl) {
      const { mimeType, bytes } = validateSubmissionEvidenceDataUrl(dataUrl);

      if (this.config.NODE_ENV === "production" && !this.config.ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION) {
        if (this.useSupabaseEvidenceStorage) {
          const evidence = await this.createSupabaseSourceEvidence(account, bytes, mimeType);
          return privateEvidenceRef(evidence.id);
        }
        const evidence = await this.createFilesystemSourceEvidence(account, bytes, mimeType);
        return privateEvidenceRef(evidence.id);
      }

      const createdAt = nowIso();
      const evidence = this.repository.createSourceEvidenceObject({
        id: crypto.randomUUID(),
        ownerUserId: account?.id ?? null,
        storageProvider: "sqlite_private",
        objectPath: `evidence/${crypto.randomUUID()}`,
        mimeType,
        byteSize: bytes.length,
        dataBase64: bytes.toString("base64"),
        externalUrl: null,
        retentionExpiresAt: addDays(createdAt, this.config.SOURCE_EVIDENCE_RETENTION_DAYS ?? 90),
        createdAt,
      });
      return privateEvidenceRef(evidence.id);
    }

    if (!input.sourcePhotoUrl) {
      return null;
    }

    parseSafeImageSourceUrl(input.sourcePhotoUrl, "Source photo URL");
    throw new AppError("For reviewer safety, upload the source image directly instead of linking to an external site.", 400);
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

  private async createFilesystemSourceEvidence(
    account: Pick<BusinessAccount, "id"> | null,
    bytes: Buffer,
    mimeType: string,
  ): Promise<SourceEvidenceObject> {
    const id = crypto.randomUUID();
    const monthKey = getZonedMonthKey(new Date(nowIso()), this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE);
    const objectPath = `evidence/${monthKey}/${id}.${sourceEvidenceExtensionForMimeType(mimeType)}`;
    const filePath = this.getSourceEvidenceFilePath(objectPath);

    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      logger.error("Failed to store private source evidence file", {
        provider: FILESYSTEM_EVIDENCE_PROVIDER,
        objectPath,
        error,
      });
      throw new AppError("Source evidence storage is unavailable. Keep the upload queued and retry shortly.", 503);
    }

    const createdAt = nowIso();
    return this.repository.createSourceEvidenceObject({
      id,
      ownerUserId: account?.id ?? null,
      storageProvider: FILESYSTEM_EVIDENCE_PROVIDER,
      objectPath,
      mimeType,
      byteSize: bytes.length,
      dataBase64: null,
      externalUrl: null,
      retentionExpiresAt: addDays(createdAt, this.config.SOURCE_EVIDENCE_RETENTION_DAYS ?? 90),
      createdAt,
    });
  }

  private async createSupabaseSourceEvidence(
    account: Pick<BusinessAccount, "id"> | null,
    bytes: Buffer,
    mimeType: string,
  ): Promise<SourceEvidenceObject> {
    if (!this.supabase || !this.useSupabaseEvidenceStorage) {
      throw new AppError("Source evidence storage is unavailable. Keep the upload queued and retry shortly.", 503);
    }

    const id = crypto.randomUUID();
    const monthKey = getZonedMonthKey(new Date(nowIso()), this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE);
    const ownerPath = account?.id ?? "anonymous";
    const objectPath = `${ownerPath}/${monthKey}/${id}.${sourceEvidenceExtensionForMimeType(mimeType)}`;
    const { error: uploadError } = await this.supabase.storage
      .from(SUPABASE_EVIDENCE_BUCKET)
      .upload(objectPath, bytes, { contentType: mimeType, upsert: false });
    if (uploadError) {
      logger.error("Failed to store private source evidence file", {
        provider: SUPABASE_EVIDENCE_PROVIDER,
        error: redactSecrets(uploadError.message),
      });
      throw new AppError("Source evidence storage is unavailable. Keep the upload queued and retry shortly.", 503);
    }

    const createdAt = nowIso();
    try {
      return this.repository.createSourceEvidenceObject({
        id,
        ownerUserId: account?.id ?? null,
        storageProvider: SUPABASE_EVIDENCE_PROVIDER,
        objectPath,
        mimeType,
        byteSize: bytes.length,
        dataBase64: null,
        externalUrl: null,
        retentionExpiresAt: addDays(createdAt, this.config.SOURCE_EVIDENCE_RETENTION_DAYS ?? 90),
        createdAt,
      });
    } catch (error) {
      await this.supabase.storage.from(SUPABASE_EVIDENCE_BUCKET).remove([objectPath]).catch(() => null);
      throw error;
    }
  }

  private async removeSupabaseSourceEvidence(objectPath: string): Promise<void> {
    if (!this.supabase || !this.useSupabaseEvidenceStorage) {
      throw new AppError("Source evidence storage is unavailable.", 503);
    }
    const { error } = await this.supabase.storage.from(SUPABASE_EVIDENCE_BUCKET).remove([objectPath]);
    if (error) throw new Error(redactSecrets(error.message));
  }

  async getSourceEvidenceDelivery(evidence: SourceEvidenceObject): Promise<
    | { kind: "bytes"; mimeType: string; bytes: Buffer }
    | null
  > {
    if (evidence.deletedAt) {
      return null;
    }
    if (evidence.externalUrl) {
      return null;
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
          bytes: await fs.promises.readFile(filePath),
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

    if (evidence.storageProvider === SUPABASE_EVIDENCE_PROVIDER && evidence.mimeType) {
      if (!this.supabase || !this.useSupabaseEvidenceStorage) {
        throw new AppError("Source evidence storage is unavailable.", 503);
      }
      const { data, error } = await this.supabase.storage
        .from(SUPABASE_EVIDENCE_BUCKET)
        .download(evidence.objectPath);
      if (error || !data) {
        logger.warn("Private source evidence file missing or unreadable", {
          evidenceId: evidence.id,
          provider: evidence.storageProvider,
          error: error ? redactSecrets(error.message) : "missing_object",
        });
        throw new AppError("Source evidence not found.", 404);
      }
      return {
        kind: "bytes",
        mimeType: evidence.mimeType,
        bytes: Buffer.from(await data.arrayBuffer()),
      };
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

    const linkedEvidenceIds = this.repository.listSubmissionSourceEvidenceIds(submissionId);
    const legacyEvidenceId = getPrivateEvidenceId(submission.submission.sourcePhotoUrl);
    const evidenceIds = linkedEvidenceIds.length
      ? linkedEvidenceIds
      : legacyEvidenceId
        ? [legacyEvidenceId]
        : [];
    if (!evidenceIds.length) {
      return { signedUrl: null, signedUrls: [], evidence: [], expiresAt: null };
    }

    const expiresAt = Math.floor(Date.now() / 1000) + this.config.SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS;
    const signedEvidence = evidenceIds.map((evidenceId) => {
      const evidence = this.repository.getSourceEvidenceObject(evidenceId);
      if (!evidence) {
        throw new AppError("Source evidence not found.", 404);
      }
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
      return { url: signedUrl.toString(), mimeType: evidence.mimeType };
    });
    const signedUrls = signedEvidence.map((item) => item.url);

    return {
      signedUrl: signedUrls[0] ?? null,
      signedUrls,
      evidence: signedEvidence,
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
      consentVersion: input.consentVersion ?? "2026-07-11",
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
      contactEmail: input.contactEmail ?? account?.email ?? null,
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
    const requestedAt = nowIso();
    const request = this.repository.createAccountDeletionRequest({
      id: crypto.randomUUID(),
      userId: account.id,
      userMessage: input.message ?? null,
      requestedAt,
      executeAfter: addDays(requestedAt, 7),
    });

    this.recordUserActivity({
      account,
      eventType: "account_deletion_requested",
      relatedEntityType: "account_deletion_request",
      relatedEntityId: String(request.id),
      metadata: { requestType: "account_deletion_request" },
    });
    this.auditSecurity({
      actor: account,
      action: "account_deletion_requested",
      targetType: "account_deletion_request",
      targetId: String(request.id),
      metadata: { executeAfter: request.execute_after },
    });

    return {
      request,
      message: "Deletion request saved with a seven-day review window. An admin can execute the documented anonymisation workflow after checking legal retention requirements.",
    };
  }

  async purgeExpiredSourceEvidence(limit = 100): Promise<{ purged: number; failed: number }> {
    const expired = this.repository.listExpiredSourceEvidence({ now: nowIso(), limit });
    let purged = 0;
    let failed = 0;
    for (const evidence of expired) {
      try {
        if (evidence.storageProvider === FILESYSTEM_EVIDENCE_PROVIDER) {
          await fs.promises.rm(this.getSourceEvidenceFilePath(evidence.objectPath), { force: true });
        } else if (evidence.storageProvider === SUPABASE_EVIDENCE_PROVIDER) {
          await this.removeSupabaseSourceEvidence(evidence.objectPath);
        }
        this.repository.markSourceEvidenceDeleted({ id: evidence.id, deletedAt: nowIso() });
        purged += 1;
      } catch (error) {
        failed += 1;
        logger.warn("Source evidence retention purge failed", {
          evidenceId: evidence.id,
          error: error instanceof Error ? redactSecrets(error.message) : "unknown",
        });
      }
    }
    return { purged, failed };
  }

  listAccountDeletionRequests(admin: BusinessAccount) {
    if (!this.isAdmin(admin)) throw new AppError("Admin access required.", 403);
    return { requests: this.repository.listAccountDeletionRequests({ limit: 100 }) };
  }

  async executeAccountDeletion(admin: BusinessAccount, requestId: string) {
    if (!this.isAdmin(admin)) throw new AppError("Admin access required.", 403);
    const requests = this.repository.listAccountDeletionRequests({ limit: 500 });
    const request = requests.find((item) => item.id === requestId);
    if (!request) throw new AppError("Deletion request not found.", 404);
    if (!['pending_review', 'approved'].includes(String(request.status))) {
      throw new AppError("This account deletion request has already been processed.", 409);
    }
    if (new Date(String(request.execute_after)).getTime() > Date.now()) {
      throw new AppError("The seven-day account deletion safety window has not finished yet.", 409);
    }
    const account = this.repository.getAccountById(String(request.user_id));
    if (!account) throw new AppError("Account not found.", 404);

    if (account.supabaseUserId && this.supabase) {
      const { error } = await this.supabase.auth.admin.deleteUser(account.supabaseUserId);
      if (error) {
        throw new ExternalServiceError("Supabase account deletion failed; local data was left unchanged.", {
          message: redactSecrets(error.message),
        });
      }
    }

    const evidence = this.repository.listSourceEvidenceForOwner(account.id);
    for (const item of evidence) {
      if (item.storageProvider === FILESYSTEM_EVIDENCE_PROVIDER) {
        await fs.promises.rm(this.getSourceEvidenceFilePath(item.objectPath), { force: true });
      } else if (item.storageProvider === SUPABASE_EVIDENCE_PROVIDER) {
        await this.removeSupabaseSourceEvidence(item.objectPath);
      }
    }
    const summary = this.repository.executeAccountAnonymisation({
      requestId,
      reviewedBy: admin.id,
      now: nowIso(),
    });
    for (const evidenceId of (summary.evidenceIds as string[] | undefined) ?? []) {
      this.repository.markSourceEvidenceDeleted({ id: evidenceId, deletedAt: nowIso() });
    }
    this.auditSecurity({
      actor: admin,
      action: "account_deletion_executed",
      targetType: "account_deletion_request",
      targetId: requestId,
      metadata: { anonymisedUserId: account.id },
    });
    return { requestId, status: "completed", summary };
  }

  async reportWrongPrice(account: BusinessAccount | null, input: WrongPriceReportInput) {
    const now = nowIso();
    const sourcePhotoUrl = await this.resolveSourcePhoto(account, input);
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

    const message = input.requestType === "missing_venue"
      ? `${input.venueName || "This venue"} has been added to the admin review queue.`
      : "Request saved. Admin can turn high-demand requests into missions.";

    return {
      request,
      message,
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

  listSubmissions(account: BusinessAccount | null, input: { status?: string | undefined; mine: boolean; limit: number; includeReviewData?: boolean | undefined }) {
    if (!account) {
      throw new AppError("Login required.", 401);
    }

    const isAdmin = account.role === "admin" || account.subscriptionStatus === "admin";
    const listMethod = input.includeReviewData && isAdmin
      ? this.repository.listSubmissionsWithItems.bind(this.repository)
      : this.repository.listSubmissions.bind(this.repository);
    if (input.mine || !isAdmin) {
      return listMethod({
        userId: account.id,
        status: input.status as never,
        limit: input.limit,
      });
    }

    return listMethod({
      status: input.status as never,
      limit: input.limit,
    });
  }

  private hasUnapprovedCatalogItems(items: BusinessSubmissionItem[]): boolean {
    return items.some(
      (item) => item.requiresCatalogApproval && !this.beerCatalogRepository?.isActiveBeer(item.normalizedBeerId),
    );
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

    const confirmedCount = input.result === "confirmed"
      ? this.repository.countConfirmedVerificationsForSubmission(submissionId)
      : 0;

    return {
      verification,
      autoApproved: false,
      confirmedCount,
      message: input.result === "confirmed"
        ? "Verification saved for admin review. Community confirmations never publish a price automatically."
        : "Verification saved for admin review.",
    };
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

    if (input.status === "approved" && this.hasUnapprovedCatalogItems(submission.items)) {
      throw new AppError(
        "Approve, merge, or reject every new beer name in the catalogue before publishing this submission.",
        409,
      );
    }

    const suggestedPoints = this.calculatePoints(submission.submission, submission.items);
    const requestedPoints = input.pointsAwarded ?? suggestedPoints;
    const points = submission.submission.pointsEligibleByLocation
      ? roundPoints(Math.min(requestedPoints, suggestedPoints))
      : 0;
    const reviewedAt = nowIso();
    const reviewConfidence = input.confidence ?? "admin_verified";
    const result = this.repository.reviewSubmission({
      submissionId,
      reviewerId: admin.id,
      status: input.status,
      rejectionReason: input.rejectionReason,
      fraudFlagged: input.fraudFlagged || input.status === "fraud_flagged",
      pointsAwarded: input.status === "approved" ? points : 0,
      confidence: reviewConfidence,
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

    const normalizedSearch = query?.trim() ?? "";
    const cachedRows = !normalizedSearch
      && this.publicVenueCache
      && Date.now() - this.publicVenueCache.fetchedAt < 60_000
      && this.publicVenueCache.fetchLimit >= limit
        ? this.publicVenueCache.rows.slice(0, limit)
        : null;

    let request = this.supabase
      .from("venues")
      .select("id, name, address, suburb, state, postcode, latitude, longitude")
      .limit(limit);

    if (query && query.trim().length > 0) {
      const labelStem = query.trim().split("·")[0] ?? "";
      const searchQuery = (labelStem.split(",")[0] ?? "").trim();
      const safeQuery = sanitizePostgrestIlikeTerm(searchQuery);
      if (safeQuery) {
        request = request.or(`name.ilike.%${safeQuery}%,suburb.ilike.%${safeQuery}%,address.ilike.%${safeQuery}%`);
      }
    }

    const { data, error } = cachedRows
      ? { data: cachedRows, error: null }
      : await request.order("name", { ascending: true });

    if (error) {
      throw new ExternalServiceError("Failed to fetch venues", {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });
    }

    const venues = (data ?? []) as VenueRow[];
    if (!normalizedSearch && !cachedRows) {
      this.publicVenueCache = { rows: venues, fetchedAt: Date.now(), fetchLimit: limit };
    }
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

    return this.mergeVenueRows(localVenues, venues.map((venue) => ({
      ...venue,
      ...this.getPublicVenueTierMetadata(venue.id),
    })), limit);
  }

  async getPublicVenueById(venueId: string): Promise<VenueRow | null> {
    const normalizedVenueId = this.repository.getCanonicalVenueId(venueId.trim());
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
      throw new AppError("Search a venue name, area, or address.", 400);
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
    "membershipTier" | "highlightedName" | "premiumBadge" | "promoted" | "featuredSpecialEligible" | "acceptsPintPathCodes"
  > {
    const profile = this.repository.getBarProfile(venueId);

    if (!profile?.active) {
      return {
        membershipTier: "basic",
        highlightedName: false,
        premiumBadge: null,
        promoted: false,
        featuredSpecialEligible: false,
        acceptsPintPathCodes: false,
      };
    }

    const flags = tierFlags(profile.membershipTier);
    return {
      membershipTier: profile.membershipTier,
      highlightedName: flags.highlightedName && profile.highlightedName,
      premiumBadge: profile.premiumBadge || flags.premiumBadge,
      promoted: flags.promoted && profile.promoted,
      featuredSpecialEligible: flags.featuredSpecialEligible && profile.featuredSpecialEligible,
      acceptsPintPathCodes: profile.acceptsPintPathCodes,
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
    const cycleSuffix = (lastVerifiedAt: string | null) => lastVerifiedAt
      ? `:${lastVerifiedAt.replace(/[^0-9]/g, "").slice(0, 14)}`
      : "";
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
        `menu-freshness${cycleSuffix(candidate.latestVerifiedAt)}`,
        this.missionReasonForFreshness("drink menu", candidate.latestVerifiedAt),
        this.calculateFreshnessPoints(candidate.latestVerifiedAt),
        candidate.latestVerifiedAt,
      ),
    ];

    for (const beer of AUTO_MISSION_TARGET_BEERS) {
      const lastVerifiedAt = this.repository.getLatestVenueBeerTimestamp({
        venueId: candidate.venueId,
        venueIds: this.repository.listVenueIdentityIds(candidate.venueId),
        normalizedBeerId: beer.key,
        beerNames: [beer.name, ...beer.aliases],
      });
      const points = this.calculateFreshnessPoints(lastVerifiedAt);
      const reason = lastVerifiedAt
        ? this.missionReasonForFreshness(`${beer.name} price`, lastVerifiedAt)
        : `Missing ${beer.name} price - add this drink`;

      missions.push(baseMission(`beer:${beer.key}${cycleSuffix(lastVerifiedAt)}`, reason, points, lastVerifiedAt));
    }

    const happyHourLastVerifiedAt = candidate.happyHourLastVerifiedAt;
    const happyHourPoints = happyHourLastVerifiedAt
      ? this.calculateFreshnessPoints(happyHourLastVerifiedAt)
      : CONTRIBUTION_POINTS.newVenue;
    missions.push(baseMission(
      `happy-hour${cycleSuffix(happyHourLastVerifiedAt)}`,
      happyHourLastVerifiedAt
        ? this.missionReasonForFreshness("happy-hour details", happyHourLastVerifiedAt)
        : "Missing happy-hour details - add current specials",
      happyHourPoints,
      happyHourLastVerifiedAt,
    ));

    return missions;
  }

  private refreshAutoMissions(force = false): { candidates: number; generated: number; refreshed: boolean } {
    const state = this.repository.getSystemState<{ refreshedAt?: string }>(AUTO_MISSION_REFRESH_STATE_KEY);
    const lastRefreshMs = state?.value.refreshedAt ? new Date(state.value.refreshedAt).getTime() : 0;
    if (!force && Number.isFinite(lastRefreshMs) && Date.now() - lastRefreshMs < AUTO_MISSION_REFRESH_INTERVAL_MS) {
      return { candidates: this.repository.countMissions(), generated: 0, refreshed: false };
    }
    const rawCandidates = this.repository.listMissionVenueCandidates(AUTO_MISSION_VENUE_LIMIT);
    const candidateByVenue = new Map<string, MissionVenueCandidate>();
    const newestIso = (left: string | null, right: string | null) => {
      if (!left) return right;
      if (!right) return left;
      return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
    };
    for (const candidate of rawCandidates) {
      const venueId = this.repository.getCanonicalVenueId(candidate.venueId);
      const existing = candidateByVenue.get(venueId);
      if (!existing) {
        candidateByVenue.set(venueId, { ...candidate, venueId });
        continue;
      }
      candidateByVenue.set(venueId, {
        ...existing,
        venueName: existing.venueName || candidate.venueName,
        suburb: existing.suburb ?? candidate.suburb,
        latestVerifiedAt: newestIso(existing.latestVerifiedAt, candidate.latestVerifiedAt),
        recordCount: existing.recordCount + candidate.recordCount,
        happyHourLastVerifiedAt: newestIso(existing.happyHourLastVerifiedAt, candidate.happyHourLastVerifiedAt),
      });
    }
    const candidates = Array.from(candidateByVenue.values());
    if (!candidates.length) {
      return { candidates: 0, generated: 0, refreshed: false };
    }

    const now = nowIso();
    const missions = candidates
      .flatMap((candidate) => this.buildAutoMissionsForVenue(candidate, now))
      .filter((mission) => mission.points > CONTRIBUTION_POINTS.veryFreshUpdate);
    const generated = this.repository.replaceAutoMissions(missions, now);
    this.repository.setSystemState(AUTO_MISSION_REFRESH_STATE_KEY, {
      refreshedAt: now,
      candidates: candidates.length,
      generated,
    }, now);
    return {
      candidates: candidates.length,
      generated,
      refreshed: true,
    };
  }

  async resolveMissionArea(query: string): Promise<{
    location: MissionAreaLookup | null;
    message: string;
  }> {
    const normalizedQuery = query.trim().replace(/\s+/g, " ");
    if (normalizedQuery.length < 2) {
      throw new AppError("Enter an area, street, or venue to find nearby missions.", 400);
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
      message: "We could not find that Melbourne area yet. Try a nearby area, street, or venue name.",
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
  }, account: BusinessAccount | null = null): BusinessMission[] {
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
    const progressByMission = new Map(
      account
        ? this.repository.listMissionProgressForUser(account.id).map((progress) => [progress.missionId, progress.status] as const)
        : [],
    );
    const missions = this.repository
      .listMissions({ activeOnly: true, suburb: query.suburb, limit: missionFetchLimit })
      .map((mission) => ({
        ...mission,
        lastVerifiedAt: mission.id.startsWith("auto:")
          ? mission.lastVerifiedAt
          : this.repository.getLatestVenueDataTimestamp(mission.venueId) ?? mission.lastVerifiedAt,
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
          userProgress: progressByMission.get(mission.id) ?? null,
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

  acceptMission(account: BusinessAccount, missionId: string) {
    this.assertAccountCanSubmit(account);
    const mission = this.repository.getMissionById(missionId);
    if (!mission || !mission.active) {
      throw new AppError("This mission is no longer active.", 404);
    }
    const progress = this.repository.acceptMission({ missionId, userId: account.id, now: nowIso() });
    const params = new URLSearchParams({
      missionId: mission.id,
      venueId: mission.venueId,
      venueName: mission.venueName,
      missionReason: mission.reason,
      type: mission.reason.toLowerCase().includes("happy")
        ? "happy_hour_update"
        : !mission.lastVerifiedAt || /no data|empty venue/i.test(mission.reason)
          ? "full_venue_update"
          : "single_beer_price",
    });
    return {
      mission: { ...mission, userProgress: progress.status },
      progress,
      submitUrl: `/submit.html?${params.toString()}`,
    };
  }

  listPriceRecords(
    account: BusinessAccount | null,
    input: PriceRecordsQuery & { clientIp?: string | undefined },
  ) {
    const anonymousSessionId = input.anonymousSessionId
      || (account ? null : hashAnonymousFallback(input.clientIp || "unknown-client"));
    const requestedVenueId = input.venueId ? this.repository.getCanonicalVenueId(input.venueId) : null;
    const identityVenueIds = requestedVenueId ? this.repository.listVenueIdentityIds(requestedVenueId) : [];
    const canonicalizeRecord = (record: PublicVenuePriceRecord): PublicVenuePriceRecord => {
      const canonicalVenueId = this.repository.getCanonicalVenueId(record.venueId);
      return canonicalVenueId === record.venueId ? record : { ...record, venueId: canonicalVenueId };
    };
    const venueManagerRecords = this.repository
      .listVenueManagerPriceRecords(5_000, null)
      .filter((record) => !requestedVenueId || this.repository.getCanonicalVenueId(record.venueId) === requestedVenueId);
    const records = [
      ...this.repository.listCurrentPriceRecords(identityVenueIds),
      ...venueManagerRecords,
    ]
      .map(canonicalizeRecord)
      .filter(shouldExposePriceRecord)
      .filter((record) =>
        !record.sourceType.startsWith("venue_manager_portal") ||
        record.displayKind !== "beer" ||
        record.price != null,
      );
    const publicVenueMetadata = new Map<string, Pick<
      VenueRow,
      "membershipTier" | "highlightedName" | "premiumBadge" | "promoted" | "featuredSpecialEligible" | "acceptsPintPathCodes"
    >>();
    const getCachedVenueMetadata = (venueId: string) => {
      const cached = publicVenueMetadata.get(venueId);
      if (cached) {
        return cached;
      }
      const metadata = this.getPublicVenueTierMetadata(venueId);
      publicVenueMetadata.set(venueId, metadata);
      return metadata;
    };
    const addVenueMetadata = (record: PublicVenuePriceRecord): PublicVenuePriceRecord => ({
      ...record,
      ...getCachedVenueMetadata(record.venueId),
    });
    const allCurrentRecords = dedupePublicPriceRecords(records.map(addVenueMetadata))
      .sort((left, right) => {
        const timestampDifference = new Date(right.lastVerifiedAt).getTime() - new Date(left.lastVerifiedAt).getTime();
        return timestampDifference || right.id.localeCompare(left.id);
      });
    const cursor = decodePriceCursor(input.cursor);
    const cursorIndex = cursor
      ? allCurrentRecords.findIndex((record) => record.id === cursor.id && record.lastVerifiedAt === cursor.verifiedAt)
      : -1;
    if (cursor && cursorIndex < 0) {
      throw new AppError("Price cursor is no longer current. Refresh the map to continue.", 409);
    }
    const recordsAfterCursor = cursorIndex >= 0 ? allCurrentRecords.slice(cursorIndex + 1) : allCurrentRecords;
    const dedupedRecords = recordsAfterCursor.slice(0, input.limit);
    const nextCursor = recordsAfterCursor.length > input.limit && dedupedRecords.length
      ? encodePriceCursor(dedupedRecords[dedupedRecords.length - 1]!)
      : null;
    const hasFullAccess = isFullAccess(account);

    if (hasFullAccess) {
      return {
        records: dedupedRecords,
        access: this.getAccessState(account, anonymousSessionId),
        revealed: true,
        blocked: false,
        nextCursor,
      };
    }

    const freePreviewRecords = dedupedRecords.map(freePreviewPriceRecord);
    if (!input.reveal || !input.venueId || dedupedRecords.length === 0) {
      return {
        records: freePreviewRecords,
        access: this.getAccessState(account, anonymousSessionId),
        revealed: false,
        blocked: false,
        nextCursor,
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
      nextCursor,
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
      : ["Not enough area data yet. Your report will become more useful as more users search nearby."];
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
      const claimRequests = this.repository
        .listBarClaimRequests({ userId: account.id, limit: 20 })
        .map((claim) => ({
          id: claim.id,
          barId: claim.barId,
          barName: claim.barName,
          suburb: claim.suburb,
          requesterRole: claim.requesterRole,
          status: claim.status,
          reviewNote: claim.reviewNote,
          createdAt: claim.createdAt,
          reviewedAt: claim.reviewedAt,
        }));
      return {
        accessState: "claim_required",
        isAdmin,
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
        dailySpecialsPlanner: null,
        updateLink: null,
        claimRequests,
        message: claimRequests.some((claim) => claim.status === "pending")
          ? "Your venue claim is waiting for manual verification. You will get dashboard access only after an admin approves it."
          : "Request access to a known Pint Path venue. Every claim is manually verified before dashboard access is granted.",
        privacyCopy: "Venue insights are aggregated and privacy-safe. Individual user clickstream and exact location are never shown.",
      };
    }

    const selectedVenueId = query.venueId ?? assignments[0]?.venueId;
    if (!selectedVenueId) {
      return {
        isAdmin,
        assignments,
        selectedVenue: null,
        pendingChanges: [],
        insights: null,
        updateLink: null,
        businessToolkit: null,
        demandDashboard: null,
        dailySpecialsPlanner: null,
        privacyCopy: "Venue insights are aggregated and privacy-safe. Individual user clickstream and exact location are never shown.",
      };
    }

    const assignment = isAdmin
      ? assignments.find((item) => item.venueId === selectedVenueId) ?? null
      : this.requireAssignedVenue(account, selectedVenueId, "counter");
    if (!isAdmin && !assignment) {
      throw new AppError("You can only access assigned venues.", 403);
    }

    const venueName = assignment?.venueName ?? selectedVenueId;
    const suburb = assignment?.suburb ?? null;
    const accessLevel = isAdmin ? "manager" : assignment?.accessLevel ?? "counter_staff";
    const profile = this.getOrBuildBarProfile({ barId: selectedVenueId, name: venueName, suburb });

    if (accessLevel === "counter_staff") {
      const recentActivity = this.repository
        .listPintPointDrinkRecordsForVenue(selectedVenueId, 12)
        .map((activity) => this.sanitizeVenuePintPointActivity(account, assignment, activity));
      const counterBeers = this.repository
        .listBarBeers(selectedVenueId)
        .filter((beer) => beer.inStock)
        .map((beer) => ({
          id: beer.id,
          beerName: beer.beerName,
          serveSize: beer.serveSize,
          price: beer.price,
          onTap: beer.onTap,
          inStock: beer.inStock,
        }));
      const counterSpecials = this.repository
        .listBarSpecials(selectedVenueId)
        .filter((special) => special.active !== false)
        .map((special) => ({ id: special.id, title: special.title }));

      this.trackEvent(account, {
        anonymousSessionId: null,
        eventType: "venue_portal_viewed",
        venueId: selectedVenueId,
        beerId: null,
        suburb,
        metadata: { accessLevel },
      });

      return {
        accessState: "counter_staff",
        accessLevel,
        isAdmin: false,
        assignments: assignments.map((item) => ({
          venueId: item.venueId,
          venueName: item.venueName,
          suburb: item.suburb,
          accessLevel: item.accessLevel,
        })),
        selectedVenue: { venueId: selectedVenueId, venueName, suburb },
        profile: {
          barId: profile.barId,
          name: profile.name,
          suburb: profile.suburb,
          membershipTier: profile.membershipTier,
          acceptsPintPathCodes: profile.acceptsPintPathCodes,
        },
        tier: null,
        inventory: { beers: counterBeers, happyHours: [], specials: counterSpecials },
        pendingChanges: [],
        insights: null,
        analytics: null,
        demandDashboard: null,
        paidVenueIntelligence: null,
        dailySpecialsPlanner: null,
        discounts: null,
        pintPoints: {
          today: null,
          month: null,
          recentActivity,
          rewardThreshold: FREE_PINT_REWARD_POINTS,
          copy: "Counter access records member purchases and rewards only. It cannot edit venue data or view private business analytics.",
        },
        posIntegration: null,
        monthlyReport: null,
        businessToolkit: null,
        staffAssignments: [],
        updateLink: null,
        privacyCopy: "Counter staff see only the public member ID needed to record a purchase.",
      };
    }

    const rawInsights = this.repository.getVenueManagerInsights({
      venueId: selectedVenueId,
      suburb,
      staleBefore: daysAgoIso(30),
    });
    const venueArea = profile.suburb ?? suburb ?? profile.area ?? null;
    const capabilities = getBarTierCapabilities(profile.membershipTier, isAdmin);
    const venueInsightPrivacyThreshold = Math.max(10, this.config.ANALYTICS_MIN_BUCKET_SIZE);
    const reportTimezone = this.getReportTimezone();
    const reportMonth = getZonedMonthKey(new Date(), reportTimezone);
    const reportMonthRange = monthKeyRange(reportMonth, reportTimezone);
    const todayRange = getZonedDayRangeIso(new Date(), reportTimezone);
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
    const dailyAnalytics = capabilities.analytics
      ? this.repository.getVenueAreaAnalytics({
          venueId: selectedVenueId,
          venueName: profile.name,
          area: venueArea,
          startIso: todayRange.startIso,
          endIso: todayRange.endIso,
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
    const dailySpecialsPlanner = analytics && dailyAnalytics && capabilities.analytics
      ? buildDailySpecialsPlanner({
          venueName: profile.name,
          area: venueArea,
          timezone: reportTimezone,
          todayAnalytics: dailyAnalytics,
          monthAnalytics: analytics,
          paidVenueIntelligence,
          activeSpecialCount: inventorySpecials.filter((special) => special.active !== false).length,
        })
      : null;
    const discountSummary = this.getVenueDiscountSummary({
      venueId: selectedVenueId,
      includeRecent: true,
      recentLimit: 10,
    });
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
    const recentPintPointActivity = this.repository
      .listPintPointDrinkRecordsForVenue(selectedVenueId, 12)
      .map((activity) => this.sanitizeVenuePintPointActivity(account, assignment, activity));
    const staffAssignments = this.repository
      .listVenueManagerAssignments({ venueId: selectedVenueId, activeOnly: true, limit: 100 })
      .filter((item) => item.accessLevel === "counter_staff")
      .map((item) => {
        const staffAccount = this.repository.getAccountById(item.userId);
        return {
          id: item.id,
          publicAccountId: staffAccount?.publicAccountId ?? null,
          displayName: staffAccount?.displayName ?? null,
          accessLevel: item.accessLevel,
          createdAt: item.createdAt,
        };
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
                  dailySpecialsPlanner,
                  suggestedActions: analytics.privacyFloorMet
                    ? [
                        "Keep your tap list current so nearby search demand has an accurate listing to land on.",
                        "Add happy-hour details if they are missing; users often filter by active specials.",
                      ]
                    : ["Not enough area data yet. Your report will become more useful as more users search nearby."],
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
      isAdmin,
      accessLevel,
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
      dailySpecialsPlanner,
      discounts: discountSummary,
      pintPoints: {
        today: pintPointTodayStats,
        month: pintPointMonthStats,
        recentActivity: recentPintPointActivity,
        rewardThreshold: FREE_PINT_REWARD_POINTS,
        copy: "Pint Points count only paid alcoholic beverages. Free Pint Rewards do not earn another point.",
      },
      posIntegration,
      staffAssignments,
      monthlyReport,
      businessToolkit: {
        demandSnapshot,
        proGrowthPlan,
        demandDashboard,
        paidVenueIntelligence,
        dailySpecialsPlanner,
        updateLink,
        qrCopy: "Copy this update link or turn it into a QR code for your venue/tap-list area.",
      },
      updateLink,
      qrCopy: "Copy this update link or turn it into a QR code for your venue/tap-list area.",
      privacyCopy: "Venue insights are aggregated and privacy-safe. Individual user clickstream and exact location are never shown.",
    };
  }

  assignVenueCounterStaff(
    account: BusinessAccount,
    venueId: string,
    input: VenueCounterStaffAssignmentInput,
  ) {
    const managerAssignment = this.requireAssignedVenue(account, venueId);
    const staffAccount = this.repository.getAccountByPublicAccountId(input.accountId);
    if (!staffAccount) {
      throw new AppError("Pint Path account ID not found.", 404);
    }
    if (staffAccount.id === account.id) {
      throw new AppError("Your manager assignment already includes counter access.", 409);
    }
    this.requireVerifiedBarAccount(staffAccount);

    const existing = this.repository.getVenueManagerAssignment({
      userId: staffAccount.id,
      venueId,
      activeOnly: true,
    });
    if (existing?.accessLevel === "manager") {
      throw new AppError("That account is already a manager for this venue.", 409);
    }

    const assignment = this.repository.assignVenueManager({
      id: crypto.randomUUID(),
      userId: staffAccount.id,
      venueId,
      venueName: managerAssignment?.venueName ?? this.repository.getBarProfile(venueId)?.name ?? venueId,
      suburb: managerAssignment?.suburb ?? this.repository.getBarProfile(venueId)?.suburb ?? null,
      accessLevel: "counter_staff",
      approvedBy: account.id,
      now: nowIso(),
    });

    this.auditSecurity({
      actor: account,
      action: "venue_counter_staff_assigned",
      targetType: "venue_manager_assignment",
      targetId: assignment.id,
      metadata: {
        venueId,
        staffPublicAccountId: staffAccount.publicAccountId,
      },
    });

    return {
      assignment: {
        ...assignment,
        userId: undefined,
        publicAccountId: staffAccount.publicAccountId,
        displayName: staffAccount.displayName,
      },
    };
  }

  revokeVenueCounterStaff(
    account: BusinessAccount,
    venueId: string,
    input: VenueCounterStaffAssignmentInput,
  ) {
    this.requireAssignedVenue(account, venueId);
    const staffAccount = this.repository.getAccountByPublicAccountId(input.accountId);
    if (!staffAccount) {
      throw new AppError("Pint Path account ID not found.", 404);
    }
    const existing = this.repository.getVenueManagerAssignment({
      userId: staffAccount.id,
      venueId,
      activeOnly: true,
    });
    if (!existing || existing.accessLevel !== "counter_staff") {
      throw new AppError("Active counter-staff assignment not found.", 404);
    }
    const assignment = this.repository.revokeVenueManager({
      userId: staffAccount.id,
      venueId,
      now: nowIso(),
    });
    if (!assignment) {
      throw new AppError("Counter-staff assignment not found.", 404);
    }

    this.auditSecurity({
      actor: account,
      action: "venue_counter_staff_revoked",
      targetType: "venue_manager_assignment",
      targetId: assignment.id,
      metadata: {
        venueId,
        staffPublicAccountId: staffAccount.publicAccountId,
      },
    });

    return {
      assignment: {
        ...assignment,
        userId: undefined,
        publicAccountId: staffAccount.publicAccountId,
        displayName: staffAccount.displayName,
      },
    };
  }

  createBarClaimRequest(account: BusinessAccount, input: BarClaimRequestInput) {
    this.requireVerifiedBarAccount(account);
    const barId = input.barId?.trim();
    if (!barId) {
      throw new AppError("Choose a known Pint Path venue before requesting access.", 400);
    }

    const contactEmail = normalizeEmail(input.contactEmail);
    if (contactEmail !== normalizeEmail(account.email)) {
      throw new AppError("Use the verified email address for your signed-in Pint Path account.", 400);
    }

    const profile = this.repository.getBarProfile(barId);
    const location = this.repository.getVenueLocationCache(barId);
    const priceRecord = this.repository.listLatestPriceRecords(1, barId)[0] ?? null;
    if (!profile && !location && !priceRecord) {
      throw new AppError("That venue is not in Pint Path yet. Submit it as a missing venue before claiming it.", 404);
    }

    const existingClaim = this.repository.getPendingBarClaimRequest({ userId: account.id, barId });
    if (existingClaim) {
      return {
        claim: existingClaim,
        duplicate: true,
        message: "This venue claim is already waiting for manual verification.",
      };
    }

    const now = nowIso();
    const claim = this.repository.createBarClaimRequest({
      id: crypto.randomUUID(),
      userId: account.id,
      barId,
      barName: profile?.name ?? location?.venueName ?? priceRecord?.venueName ?? input.barName,
      address: profile?.address ?? input.address,
      suburb: profile?.suburb ?? location?.suburb ?? priceRecord?.suburb ?? input.suburb,
      requesterName: input.requesterName,
      requesterRole: input.requesterRole,
      contactEmail,
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

  reviewVenueClaimRequest(admin: BusinessAccount, claimId: string, input: VenueClaimReviewInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const claim = this.repository.getBarClaimRequestById(claimId);
    if (!claim) {
      throw new AppError("Venue claim not found.", 404);
    }
    if (claim.status !== "pending") {
      if (claim.status === input.status) {
        return {
          claim,
          assignment: claim.status === "approved" && claim.barId
            ? this.repository.getVenueManagerAssignment({ userId: claim.userId, venueId: claim.barId })
            : null,
          duplicate: true,
          message: `This venue claim was already ${claim.status}.`,
        };
      }
      throw new AppError(`This venue claim was already ${claim.status}.`, 409);
    }

    const claimant = this.repository.getAccountById(claim.userId);
    if (!claimant || claimant.status !== "active") {
      throw new AppError("The claimant account is no longer active.", 409);
    }
    if (input.status === "approved" && !claim.barId) {
      throw new AppError("Choose a known venue before approving this claim.", 400);
    }

    const reviewedAt = nowIso();
    const result = this.repository.runInTransaction(() => {
      const assignment = input.status === "approved" && claim.barId
        ? this.repository.assignVenueManager({
            id: crypto.randomUUID(),
            userId: claim.userId,
            venueId: claim.barId,
            venueName: claim.barName,
            suburb: claim.suburb,
            accessLevel: "manager",
            approvedBy: admin.id,
            now: reviewedAt,
          })
        : null;
      const reviewed = this.repository.reviewBarClaimRequest({
        id: claim.id,
        status: input.status,
        reviewNote: input.reviewNote,
        reviewedBy: admin.id,
        reviewedAt,
      });
      if (!reviewed) {
        throw new AppError("Venue claim could not be reviewed.", 409);
      }
      return { claim: reviewed, assignment };
    });

    this.auditSecurity({
      actor: admin,
      action: "admin_venue_claim_review",
      targetType: "venue_claim_request",
      targetId: claim.id,
      metadata: {
        status: input.status,
        venueId: claim.barId,
        claimantUserId: claim.userId,
      },
    });

    return {
      ...result,
      message: input.status === "approved"
        ? "Venue claim approved and manager access assigned."
        : "Venue claim rejected without granting venue access.",
    };
  }

  async createVenueManagerSubmission(account: BusinessAccount, venueId: string, input: CreateSubmissionInput) {
    const assignment = this.requireAssignedVenue(account, venueId);

    if (input.venueId !== venueId) {
      throw new AppError("Venue update must match the assigned venue.", 403);
    }

    const sourcePhotoRefs = await this.resolveSubmissionSourcePhotos(account, input);
    const result = this.createSubmission(account, {
      ...input,
      notes: [
        input.notes,
        "Venue manager submitted update. Keep pending for admin/data-quality review unless manually approved.",
      ].filter(Boolean).join(" "),
    }, { allowVenueManager: true, rewardEligible: false, sourcePhotoRefs });

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
    const acceptsPintPathCodes = this.isAdmin(account)
      ? input.acceptsPintPathCodes ?? existing?.acceptsPintPathCodes ?? false
      : existing?.acceptsPintPathCodes ?? false;
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
      acceptsPintPathCodes,
      active: this.isAdmin(account) ? input.active : existing?.active ?? true,
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

    const now = nowIso();
    const beerInput = this.standardizeBarBeerInput(
      input,
      this.isAdmin(account) ? "venue_inventory_admin" : "venue_inventory_manager",
      now,
    );

    const profile = this.ensureBarProfile({
      barId: venueId,
      name: assignment?.venueName ?? this.repository.getBarProfile(venueId)?.name ?? venueId,
      suburb: assignment?.suburb ?? this.repository.getBarProfile(venueId)?.suburb ?? null,
    });
    const beer = this.repository.upsertBarBeer({
      id: beerInput.id ?? crypto.randomUUID(),
      barId: venueId,
      beerName: beerInput.beerName,
      normalizedBeerId: beerInput.normalizedBeerId,
      brewery: beerInput.brewery,
      style: beerInput.style,
      abv: beerInput.abv,
      serveSize: beerInput.serveSize,
      price: beerInput.price,
      currency: "AUD",
      onTap: beerInput.onTap,
      inStock: beerInput.inStock,
      notes: beerInput.notes,
      now,
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

    if (!this.isAdmin(account)) {
      this.auditSecurity({
        actor: account,
        action: "venue_manager_delete",
        targetType: "venue_beer",
        targetId: beerId,
        metadata: { venueId, changeType: "beer" },
      });
    }

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId,
      suburb: assignment?.suburb ?? null,
      metadata: { section: "beer_inventory", action: "delete", changeType: "beer" },
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
      happyHourBeers: input.happyHourBeers,
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
        happyHourBeers: existing.happyHourBeers,
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
      metadata: { section: "happy_hours", action: "delete", changeType: "happy_hour" },
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
      savingsAmountCents: input.savingsAmountCents,
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
      metadata: { section: "specials", action: "delete", changeType: "special" },
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
      accessLevel: input.accessLevel ?? "manager",
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
        accessLevel: assignment.accessLevel,
      },
    });

    this.trackEvent(admin, {
      anonymousSessionId: null,
      eventType: "venue_manager_assigned",
      venueId: assignment.venueId,
      beerId: null,
      suburb: assignment.suburb,
      metadata: {
        managerUserId: assignment.userId,
        venueName: assignment.venueName,
        accessLevel: assignment.accessLevel,
      },
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

  getOperationalHealth(admin: BusinessAccount) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }
    const keys = [
      "job:offsite_backup",
      "job:restore_rehearsal",
      "job:evidence_retention",
      "job:menu_ocr",
      "job:stripe_webhook",
      AUTO_MISSION_REFRESH_STATE_KEY,
    ];
    return {
      checkedAt: nowIso(),
      jobs: keys.map((key) => {
        const state = this.repository.getSystemState<Record<string, unknown>>(key);
        return {
          key,
          state: state?.value ?? { state: "not_run" },
          updatedAt: state?.updatedAt ?? null,
        };
      }),
    };
  }

  updateTrustQueueItem(
    admin: BusinessAccount,
    kind: "feedback" | "wrong_price" | "venue_request",
    id: string,
    input: TrustWorkflowUpdateInput,
  ) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }
    const item = this.repository.updateTrustWorkflow({
      kind,
      id,
      status: input.status,
      assignedTo: input.assignedTo === "self" ? admin.id : input.assignedTo,
      resolutionNote: input.resolutionNote,
      resolvedBy: admin.id,
      now: nowIso(),
    });
    this.auditSecurity({
      actor: admin,
      action: "admin_trust_queue_update",
      targetType: kind,
      targetId: id,
      metadata: {
        status: input.status,
        assigned: Boolean(input.assignedTo),
        hasResolutionNote: Boolean(input.resolutionNote),
      },
    });
    return { item };
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
    const response = await fetchWithTimeout("https://api.stripe.com/v1/checkout/sessions", {
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

  private async createStripeBillingPortalSession(customerId: string, returnPath: string) {
    if (this.config.DEMO_BILLING_MODE) {
      return {
        mode: "demo",
        portalUrl: new URL(returnPath, this.config.PUBLIC_BASE_URL).toString(),
        message: "Demo billing has no external payment profile.",
      };
    }
    if (!this.config.STRIPE_SECRET_KEY) {
      throw new AppError("Stripe billing management is not configured.", 503);
    }
    if (!customerId) {
      throw new AppError("This subscription is not linked to a Stripe customer yet. Contact support with your account ID.", 409);
    }

    const response = await fetchWithTimeout("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formEncode({
        customer: customerId,
        return_url: new URL(returnPath, this.config.PUBLIC_BASE_URL).toString(),
      }),
    });
    const payload = await response.json().catch(() => null) as { url?: string; error?: { message?: string } } | null;
    if (!response.ok || !payload?.url) {
      throw new ExternalServiceError("Stripe billing management could not be opened. Try again shortly.", {
        status: response.status,
        message: payload?.error?.message,
      });
    }
    return { mode: "stripe", portalUrl: payload.url };
  }

  async createBillingPortal(account: BusinessAccount) {
    if (!["premium_monthly", "premium_yearly"].includes(account.subscriptionStatus)) {
      throw new AppError("A paid Pint Path subscription is required to manage billing.", 409);
    }
    const result = await this.createStripeBillingPortalSession(account.stripeCustomerId ?? "", "/account.html?billing=returned");
    this.auditSecurity({
      actor: account,
      action: "stripe_billing_portal_opened",
      targetType: "account",
      targetId: account.id,
      metadata: { billingContext: "user" },
    });
    return result;
  }

  async createBarBillingPortal(account: BusinessAccount, venueId: string) {
    this.requireVerifiedBarAccount(account);
    this.requireAssignedVenue(account, venueId);
    const profile = this.repository.getBarProfile(venueId);
    if (!profile || profile.membershipTier !== "pro") {
      throw new AppError("This venue does not have an active Pro billing profile.", 409);
    }
    const result = await this.createStripeBillingPortalSession(
      profile.stripeCustomerId ?? "",
      `/venue-portal.html?venueId=${encodeURIComponent(venueId)}&billing=returned`,
    );
    this.auditSecurity({
      actor: account,
      action: "stripe_billing_portal_opened",
      targetType: "venue",
      targetId: venueId,
      metadata: { billingContext: "venue" },
    });
    return result;
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

    const response = await fetchWithTimeout(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(input.sessionId)}?expand%5B%5D=subscription`,
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
      premiumUntil: stripePeriodEndIso(payload.subscription),
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
    const response = await fetchWithTimeout("https://api.stripe.com/v1/checkout/sessions", {
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
    if (!event.id || !event.type) {
      throw new AppError("Invalid Stripe webhook event.", 400);
    }
    const receivedAt = nowIso();
    const eventCreatedAt = Number.isSafeInteger(event.created)
      ? new Date(Number(event.created) * 1000).toISOString()
      : null;
    const shouldProcess = this.repository.beginStripeEvent({
      id: event.id,
      eventType: event.type,
      eventCreatedAt,
      payload: event as unknown as Record<string, unknown>,
      receivedAt,
    });

    if (!shouldProcess) {
      this.repository.setSystemState("job:stripe_webhook", {
        state: "succeeded",
        completedAt: receivedAt,
        eventType: event.type,
        replay: true,
      }, receivedAt);
      return { received: true };
    }

    try {
      this.repository.runInTransaction(() => {
        this.applyStripeEvent(event, eventCreatedAt);
        this.repository.markStripeEventApplied({ id: event.id, appliedAt: nowIso() });
      });
    } catch (error) {
      this.repository.markStripeEventFailed({
        id: event.id,
        failedAt: nowIso(),
        error: error instanceof Error ? redactSecrets(error.message) : "Stripe event application failed",
      });
      const failedAt = nowIso();
      this.repository.setSystemState("job:stripe_webhook", {
        state: "failed",
        completedAt: failedAt,
        eventType: event.type,
        error: error instanceof Error ? redactSecrets(error.message).slice(0, 300) : "Stripe event application failed",
      }, failedAt);
      throw error;
    }
    const completedAt = nowIso();
    this.repository.setSystemState("job:stripe_webhook", {
      state: "succeeded",
      completedAt,
      eventType: event.type,
      replay: false,
    }, completedAt);
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

  private applyStripeEvent(event: StripeEvent, eventCreatedAt: string | null): void {
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
        const currentProfile = this.repository.getBarProfile(barId);
        if (eventCreatedAt && currentProfile?.stripeEventCreatedAt && currentProfile.stripeEventCreatedAt > eventCreatedAt) {
          return;
        }
        const flags = tierFlags(barMembershipTier);
        this.repository.updateBarSubscription({
          barId,
          membershipTier: barMembershipTier,
          stripeCustomerId: customer,
          stripeSubscriptionId: subscriptionId,
          subscriptionStatus: "active",
          now: nowIso(),
          stripeEventCreatedAt: eventCreatedAt,
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
        const currentAccount = this.repository.getAccountById(userId);
        if (eventCreatedAt && currentAccount?.stripeEventCreatedAt && currentAccount.stripeEventCreatedAt > eventCreatedAt) {
          return;
        }
        const updated = this.repository.updateSubscription({
          userId,
          subscriptionStatus,
          stripeCustomerId: customer,
          premiumUntil: null,
          now: nowIso(),
          stripeEventCreatedAt: eventCreatedAt,
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
        ["canceled", "cancelled", "past_due", "unpaid", "incomplete_expired"].includes(stripeStatus ?? "");
      const premiumUntil = stripePeriodEndIso(object);
      const barProfile = subscriptionId ? this.repository.getBarProfileByStripeSubscriptionId(subscriptionId) : null;
      if (barProfile) {
        if (eventCreatedAt && barProfile.stripeEventCreatedAt && barProfile.stripeEventCreatedAt > eventCreatedAt) {
          return;
        }
        const nextTier = shouldDowngrade ? "basic" : barProfile.membershipTier;
        const flags = tierFlags(nextTier);
        this.repository.updateBarSubscription({
          barId: barProfile.barId,
          membershipTier: nextTier,
          stripeCustomerId: customer,
          stripeSubscriptionId: subscriptionId,
          subscriptionStatus: shouldDowngrade ? "cancelled_or_past_due" : stripeStatus ?? "active",
          now: nowIso(),
          stripeEventCreatedAt: eventCreatedAt,
          ...flags,
        });
        if (shouldDowngrade) {
          this.trackEvent(null, {
            anonymousSessionId: null,
            eventType: "subscription_cancelled",
            venueId: barProfile.barId,
            beerId: null,
            suburb: barProfile.suburb,
            metadata: { mode: "stripe", billingContext: "venue" },
          });
        }
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
        if (eventCreatedAt && account.stripeEventCreatedAt && account.stripeEventCreatedAt > eventCreatedAt) {
          return;
        }
        const updated = this.repository.updateSubscription({
          userId: account.id,
          subscriptionStatus: shouldDowngrade ? "free" : account.subscriptionStatus,
          premiumUntil,
          now: nowIso(),
          stripeEventCreatedAt: eventCreatedAt,
        });
        if (shouldDowngrade) {
          this.trackEvent(updated, {
            anonymousSessionId: null,
            eventType: "subscription_cancelled",
            venueId: null,
            beerId: null,
            suburb: null,
            metadata: { mode: "stripe" },
          });
        }
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
