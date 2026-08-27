import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import * as QRCode from "qrcode";

import { CONTRIBUTION_POINTS, PREMIUM_PRICING, SUBMISSION_LIMITS } from "../../config/business-rules.js";
import { CURRENT_LEGAL_POLICY_VERSION } from "../../config/legal.js";
import type { Env } from "../../config/env.js";
import { createServerSupabaseClient } from "../../lib/supabase-client.js";
import { hasExactLegacySupabaseRoleJwt } from "../../lib/supabase-key-format.js";
import {
  BusinessRepository,
  MissionReservationError,
  OptimisticConcurrencyError,
  type AgeVerification,
  type AccountSession,
  type AccountRewardVoucher,
  type BarPendingChangeAction,
  type BarPendingChangeType,
  type BusinessAccount,
  type BarBeer,
  type BarMembershipTier,
  type BarProfile,
  type BarSpecial,
  type MonthlyBarReport,
  type BusinessMission,
  type BusinessSubmission,
  type BusinessSubmissionItem,
  type ConfidenceLabel,
  type LeaderboardPrizeCampaign,
  type PendingVenueDetails,
  type PintPointDrinkRecord,
  type VenueLocationCache,
  type VenuePintPointActivity,
  type PubGolfVenueCandidate,
  type PublicVenuePriceRecord,
  type ServingSize,
  type SubmissionItemCaptureSource,
  type SubmissionOcrStatus,
  type SubmissionOcrSummary,
  type SubscriptionStatus,
  type UserVerification,
} from "../../db/business.repository.js";
import {
  ACCOUNT_DATA_RETENTION_POLICY,
  PrivacyRetentionRepository,
  PrivacyRetentionRepositoryError,
  type PrivacyRetentionMutationCounts,
} from "../../db/privacy-retention.repository.js";
import { BeerCatalogRepository, type BeerCatalogAdminItem, type ResolvedBeerCatalogItem } from "../../db/beer-catalog.repository.js";
import {
  AccountSessionRepository,
  AccountSessionRepositoryError,
  type SupabaseAccountSessionMutation,
} from "../../db/account-session.repository.js";
import {
  AccountProfilePreferencesRepository,
  AccountProfilePreferencesRepositoryError,
  RECENT_SEARCH_UNBOUNDED_LIMIT,
  type AccountPreferences,
  type SavedItem,
} from "../../db/account-profile-preferences.repository.js";
import {
  ActivityAuditRepository,
  ActivityAuditRepositoryError,
  type ActivityAuditCursor,
  type UserActivityEventRecord,
} from "../../db/activity-audit.repository.js";
import {
  BillingCheckoutRepository,
  BillingCheckoutRepositoryError,
} from "../../db/billing-checkout.repository.js";
import {
  VenueAccessRepository,
  VenueAccessRepositoryError,
  type VenueAccessAssignmentRecord,
  type VenueAccessLevel,
  type VenueAccessStatus,
  type VenueAssignmentCursor,
  type VenueClaimCursor,
  type VenueClaimRecord,
  type VenueClaimStatus,
} from "../../db/venue-access.repository.js";
import {
  MissionLifecycleRepository,
  MissionLifecycleRepositoryError,
  type MissionLifecycleMission,
  type MissionListCursor,
} from "../../db/mission-lifecycle.repository.js";
import {
  MissionDiscoveryAutomationRepository,
  MissionDiscoveryAutomationRepositoryError,
  type MissionVenueCandidate,
} from "../../db/mission-discovery-automation.repository.js";
import {
  StripeSubscriptionRepository,
  StripeSubscriptionRepositoryError,
  type StripeApplicationEffect,
  type StripeResolvedBillingTarget,
} from "../../db/stripe-subscription.repository.js";
import {
  VenueRequestRepository,
  VenueRequestRepositoryError,
  type VenueRequestListCursor,
  type VenueRequestRecord,
} from "../../db/venue-request.repository.js";
import {
  VenuePartnerRepository,
  VenuePartnerRepositoryError,
  type VenueInterestListCursor,
  type VenueInterestRecord,
  type VenuePartnerOutreachListCursor,
  type VenuePartnerOutreachRecord,
} from "../../db/venue-partner.repository.js";
import {
  AdminAnalyticsRepository,
  AdminAnalyticsRepositoryError,
} from "../../db/admin-analytics.repository.js";
import {
  VenueManagerInsightsRepository,
  VenueManagerInsightsRepositoryError,
  type VenueManagerInsights,
} from "../../db/venue-manager-insights.repository.js";
import {
  AdminAccountRepository,
  AdminAccountRepositoryError,
} from "../../db/admin-account.repository.js";
import {
  SupportFeedbackRepository,
  SupportFeedbackRepositoryError,
  type FeedbackPriority,
} from "../../db/support-feedback.repository.js";
import {
  AccountDeletionQueueRepository,
  AccountDeletionQueueRepositoryError,
  type AccountDeletionSecretPurgeCheckpointEntry,
} from "../../db/account-deletion-queue.repository.js";
import {
  AccountPrivacyRepository,
  AccountPrivacyRepositoryError,
} from "../../db/account-privacy.repository.js";
import {
  CommunitySubmissionRepository,
  CommunitySubmissionRepositoryError,
  type CommunityCatalogDecision,
  type CommunitySubmissionRecord,
} from "../../db/community-submission.repository.js";
import {
  VenueManagerInternalSubmissionRepository,
  VenueManagerInternalSubmissionRepositoryError,
  type VenueManagerInternalMissionFence,
} from "../../db/venue-manager-internal-submission.repository.js";
import {
  SourceEvidenceObjectRepository,
  SourceEvidenceObjectRepositoryError,
  type SourceEvidenceObject,
} from "../../db/source-evidence-object.repository.js";
import { SourceEvidenceRetentionRepository } from "../../db/source-evidence-retention.repository.js";
import {
  VenuePendingChangeRepository,
  VenuePendingChangeRepositoryError,
  type ResolvedVenueBeerPendingPayload,
} from "../../db/venue-pending-change.repository.js";
import {
  VenueDataReadRepository,
  VenueDataReadRepositoryError,
} from "../../db/venue-data-read.repository.js";
import { PublicVenueDirectoryRepository } from "../../db/public-venue-directory.repository.js";
import { PublicPriceRepository } from "../../db/public-price.repository.js";
import { SavedUpdatesReadRepository } from "../../db/saved-updates-read.repository.js";
import { SystemStateRepository } from "../../db/system-state.repository.js";
import {
  VenueIdentityRepository,
  VenueIdentityRepositoryError,
} from "../../db/venue-identity.repository.js";
import {
  VenueInventoryRepository,
  type BarProfilePublicMetadata,
} from "../../db/venue-inventory.repository.js";
import type { SafePostgresApplicationPoolMetrics } from "../../db/postgres-connection-budget.js";
import {
  SUPPORTED_BEERS,
  VIEWER_TRACKED_BEERS,
  canonicalizeTrackedBeerName,
  findTrackedBeerByName,
  isLikelyBeerName,
  normalizeBeerSearchKey,
} from "../../constants/beers.js";
import { AppError, ExternalServiceError } from "../../lib/errors.js";
import { isCanonicalProductionRuntime } from "../../lib/deployment-environment.js";
import type { AccountDeletionNotificationCoordinator } from "../../lib/account-deletion-notification-worker.js";
import { logger } from "../../lib/logger.js";
import { priceConfirmationVersion } from "../../lib/price-confirmation.js";
import {
  createMockReportEmailProvider,
  createResendReportEmailProvider,
  getVenueReportDeliverySettings as readVenueReportDeliverySettings,
  runMonthlyReportDelivery,
  setVenueReportDeliverySettings as writeVenueReportDeliverySettings,
} from "../../lib/monthly-report-delivery.js";
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
  type GoogleVenueBusinessStatus,
  hasStrongBarOrPubNameSignal,
  isAustralianPostcode,
  isExcludedVenueName,
  isOperationalGoogleVenueBusinessStatus,
  normalizeGoogleVenueBusinessStatus,
  shouldImportBarOrPubPlace,
} from "../../lib/venue-directory.js";

import type {
  AccountPreferencesInput,
  AccountPrivacySettingsInput,
  AdminDashboardQuery,
  AdminPaginationInput,
  AuthLoginInput,
  BillingRecoveryPortalInput,
  BrowserReauthenticationPurpose,
  AuthSignupInput,
  AuthSupabaseSessionInput,
  BarBeerInput,
  BarBeerBulkInput,
  BarClaimRequestInput,
  VenueClaimReviewInput,
  BarHappyHourInput,
  BarPendingChangeReviewInput,
  BarProfileInput,
  BarSpecialInput,
  BarTierCheckoutInput,
  BeerCatalogAdminQuery,
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
  RewardVoucherTransitionInput,
  FreePintRewardCodeInput,
  FreePintRewardDecisionInput,
  MonthlyReportDeliveryInput,
  MonthlyReportExportQuery,
  MonthlyReportGenerateInput,
  PintPointMemberPreviewInput,
  LogoutAllInput,
  PasswordResetCompleteInput,
  PintPointDrinkRecordInput,
  PintPointDrinkVoidInput,
  PosDiscountRedemptionInput,
  PriceConfirmationInput,
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
  VenueCounterStaffInvitationResponseInput,
  VenueOutreachInput,
  VenuePortalQuery,
  VenueRequestInput,
  VenueReportDeliverySettingsInput,
  VenueReconciliationQuery,
  VerificationInput,
  WrongPriceReportInput,
  SavedUpdateOpenedInput,
  SavedUpdatesViewedInput,
} from "./business.schemas.js";
import {
  buildSavedUpdatesFeed,
  savedUpdatesExperimentVariant,
  type SavedUpdatesFeed,
} from "./saved-updates.js";

const BROWSER_MEMORY_CREDENTIAL_CEREMONY = "browser_memory_v1";
const BROWSER_CREDENTIAL_SESSION_PREFIX = "credential-v1";
const BROWSER_CREDENTIAL_SESSION_RANDOM_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BROWSER_CREDENTIAL_SESSION_TIMESTAMP_PATTERN = /^[1-9][0-9]{0,10}$/;
const BROWSER_CREDENTIAL_CEREMONY_MAX_AGE_MS = 15 * 60_000;
const BROWSER_CREDENTIAL_FUTURE_SKEW_MS = 60_000;
const BROWSER_EMAIL_REAUTH_CHALLENGE_TTL_SECONDS = 10 * 60;
const BROWSER_EMAIL_REAUTH_CHALLENGE_DOMAIN = "pintpath-browser-email-reauth/v1";
const BROWSER_EMAIL_REAUTH_CHALLENGE_RANDOM_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const SUPABASE_SIGN_IN_CREDENTIAL_METHODS = new Set([
  "oauth",
  "otp",
  "passkey",
  "password",
  "saml",
  "sso",
  "totp",
  "webauthn",
]);
type BrowserCredentialSessionPurpose = BrowserReauthenticationPurpose | "session";

type BrowserEmailReauthenticationChallenge = {
  accountId: string;
  purpose: BrowserReauthenticationPurpose;
  currentTokenHash: string;
  issuedAtSeconds: number;
  expiresAtSeconds: number;
};

function browserEmailReauthenticationChallengeMessage(input: {
  accountId: string;
  purpose: BrowserReauthenticationPurpose;
  currentTokenHash: string;
  issuedAtSeconds: number;
  expiresAtSeconds: number;
  nonce: string;
}): string {
  return [
    BROWSER_EMAIL_REAUTH_CHALLENGE_DOMAIN,
    input.accountId,
    input.purpose,
    input.currentTokenHash,
    String(input.issuedAtSeconds),
    String(input.expiresAtSeconds),
    input.nonce,
  ].join("\0");
}

function createBrowserEmailReauthenticationChallenge(input: {
  secret: string;
  accountId: string;
  purpose: BrowserReauthenticationPurpose;
  currentTokenHash: string;
  issuedAtSeconds: number;
}): { token: string; expiresAt: string } {
  const expiresAtSeconds = input.issuedAtSeconds + BROWSER_EMAIL_REAUTH_CHALLENGE_TTL_SECONDS;
  const nonce = crypto.randomBytes(32).toString("base64url");
  const encodedAccountId = Buffer.from(input.accountId, "utf8").toString("base64url");
  const message = browserEmailReauthenticationChallengeMessage({ ...input, expiresAtSeconds, nonce });
  const signature = crypto.createHmac("sha256", input.secret).update(message).digest("base64url");
  return {
    token: [
      "v1",
      encodedAccountId,
      input.purpose,
      input.currentTokenHash,
      String(input.issuedAtSeconds),
      String(expiresAtSeconds),
      nonce,
      signature,
    ].join("."),
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

function parseBrowserEmailReauthenticationChallenge(
  token: string,
  secret: string,
  nowSeconds: number,
): BrowserEmailReauthenticationChallenge | null {
  const segments = token.split(".");
  if (segments.length !== 8 || segments[0] !== "v1") return null;
  const [, encodedAccountId, purposeValue, currentTokenHash, issuedValue, expiresValue, nonce, signature] = segments;
  if (
    !encodedAccountId
    || !purposeValue
    || !currentTokenHash
    || !issuedValue
    || !expiresValue
    || !nonce
    || !signature
    || !SHA256_HEX_PATTERN.test(currentTokenHash)
    || !/^[1-9][0-9]{0,10}$/.test(issuedValue)
    || !/^[1-9][0-9]{0,10}$/.test(expiresValue)
    || !BROWSER_EMAIL_REAUTH_CHALLENGE_RANDOM_PATTERN.test(nonce)
    || !BROWSER_EMAIL_REAUTH_CHALLENGE_RANDOM_PATTERN.test(signature)
  ) return null;
  let accountId: string;
  try {
    accountId = Buffer.from(encodedAccountId, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (
    !accountId
    || accountId.length > 256
    || Buffer.from(accountId, "utf8").toString("base64url") !== encodedAccountId
    || ![
      "session_management",
      "account_export",
      "account_deletion",
      "billing_portal",
      "venue_billing_portal",
      "logout_all",
    ].includes(purposeValue)
  ) return null;
  const issuedAtSeconds = Number(issuedValue);
  const expiresAtSeconds = Number(expiresValue);
  if (
    !Number.isSafeInteger(issuedAtSeconds)
    || !Number.isSafeInteger(expiresAtSeconds)
    || expiresAtSeconds - issuedAtSeconds !== BROWSER_EMAIL_REAUTH_CHALLENGE_TTL_SECONDS
    || issuedAtSeconds > nowSeconds + Math.floor(BROWSER_CREDENTIAL_FUTURE_SKEW_MS / 1000)
    || expiresAtSeconds <= nowSeconds
  ) return null;
  const purpose = purposeValue as BrowserReauthenticationPurpose;
  const expected = crypto.createHmac("sha256", secret).update(
    browserEmailReauthenticationChallengeMessage({
      accountId,
      purpose,
      currentTokenHash,
      issuedAtSeconds,
      expiresAtSeconds,
      nonce,
    }),
  ).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  return { accountId, purpose, currentTokenHash, issuedAtSeconds, expiresAtSeconds };
}

function browserCredentialSessionToken(
  token: string,
): { purpose: BrowserCredentialSessionPurpose; credentialTimeSeconds: number } | null {
  const segments = token.split(".");
  if (
    segments.length !== 4
    || segments[0] !== BROWSER_CREDENTIAL_SESSION_PREFIX
    || !BROWSER_CREDENTIAL_SESSION_TIMESTAMP_PATTERN.test(segments[2] ?? "")
    || !BROWSER_CREDENTIAL_SESSION_RANDOM_PATTERN.test(segments[3] ?? "")
  ) return null;
  const purpose = segments[1];
  const credentialTimeSeconds = Number(segments[2]);
  if (!Number.isSafeInteger(credentialTimeSeconds) || credentialTimeSeconds <= 0) return null;
  if (purpose === "session") return { purpose, credentialTimeSeconds };
  if (
    purpose !== "session_management"
    && purpose !== "account_export"
    && purpose !== "account_deletion"
    && purpose !== "billing_portal"
    && purpose !== "venue_billing_portal"
    && purpose !== "logout_all"
  ) return null;
  return { purpose, credentialTimeSeconds };
}

interface VenueRow {
  id: string;
  name: string;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  phone?: string | null;
  website?: string | null;
  businessStatus?: GoogleVenueBusinessStatus | null;
  lastCheckedAt?: string | null;
  instagram?: string | null;
  description?: string | null;
  openingHours?: Record<string, unknown>;
  membershipTier?: BarMembershipTier;
  highlightedName?: boolean;
  premiumBadge?: string | null;
  promoted?: boolean;
  featuredSpecialEligible?: boolean;
  acceptsPintPathCodes?: boolean;
  venueTags?: string[];
  isUserSubmittedVenue?: boolean;
  beerKeys?: string[];
}

type PublicVenueTierMetadata = Required<Pick<
  VenueRow,
  | "membershipTier"
  | "highlightedName"
  | "premiumBadge"
  | "promoted"
  | "featuredSpecialEligible"
  | "acceptsPintPathCodes"
>>;

interface MissionAreaLookup {
  latitude: number;
  longitude: number;
  label: string;
  source: "google_geocode" | "local_cache";
  confidence: "exact" | "approximate";
}

interface MissionListQuery {
  suburb?: string | undefined;
  q?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
  radiusKm?: number | undefined;
  sort?: "points" | "saved" | "stale" | "no_data" | "missing_happy_hour" | "most_requested" | "high_demand" | "nearby" | undefined;
  limit: number;
  offset?: number | undefined;
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

type RemoteReadinessDependency = {
  status:
    | "ok"
    | "failed"
    | "configured"
    | "required_unconfigured"
    | "optional_unconfigured"
    | "field_test_unconfigured"
    | "disabled_for_postgres_recovery_rehearsal";
  required: boolean;
  liveProbe: boolean;
  error?: string;
};

type SupabaseReadinessDependencies = {
  ready: boolean;
  supabaseAuth: RemoteReadinessDependency;
  supabaseDatabase: RemoteReadinessDependency;
  supabaseEvidenceStorage: RemoteReadinessDependency;
};

const AUTO_MISSION_VENUE_PAGE_SIZE = 500;
const MAX_AUTO_MISSION_CANDIDATE_SCAN_ROWS = 5_000;
const MAX_AUTO_MISSION_CANDIDATE_PAGES = MAX_AUTO_MISSION_CANDIDATE_SCAN_ROWS / AUTO_MISSION_VENUE_PAGE_SIZE;
const MAX_AUTO_MISSION_DEFINITIONS = 5_000;
const AUTO_MISSION_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const AUTO_MISSION_REFRESH_STATE_KEY = "auto_missions_refresh";
const MISSION_ACCEPTANCE_TTL_MS = 24 * 60 * 60 * 1000;
const MISSION_EXPIRY_BATCH_SIZE = 500;
const MAX_MISSION_EXPIRY_BATCHES = 20;
const MISSION_AUTOMATION_BATCH_SIZE = 500;
const MAX_MISSION_AUTOMATION_BATCHES = 20;
const PRIVACY_RETENTION_BATCH_SIZE = 500;
const MAX_PRIVACY_RETENTION_BATCHES = 20;
const PRIVACY_RETENTION_MUTATION_KEYS = [
  "authSessionsDeleted",
  "providerRevocationsDeleted",
  "stripePayloadsRedacted",
  "stripeEnvelopesDeleted",
  "securityFingerprintsRedacted",
  "securityEnvelopesDeleted",
  "reviewedLocationsPurged",
  "migrationQuarantinePayloadsRedacted",
  "deletionNotificationEventsDeleted",
] as const satisfies ReadonlyArray<keyof PrivacyRetentionMutationCounts>;
const MISSION_LOCAL_CACHE_PAGE_SIZE = 200;
const MAX_MISSION_LOCAL_CACHE_SCAN_ROWS = 5_000;
const VENUE_REQUEST_ADMIN_PAGE_SIZE = 100;
const MAX_VENUE_REQUEST_ADMIN_SCAN_ROWS = 5_000;
const VENUE_PARTNER_ADMIN_PAGE_SIZE = 100;
// The legacy admin panel shares one offset across several datasets. Preserve
// that UI contract without allowing an unbounded cursor-to-offset scan.
const MAX_VENUE_PARTNER_ADMIN_SCAN_ROWS = 5_000;
const PUBLIC_HAPPY_HOUR_DISCOVERY_ENABLED = false;
const PUBLIC_HAPPY_HOUR_CONTRIBUTIONS_ENABLED = false;
const PUBLIC_SPECIAL_DISCOVERY_ENABLED = false;
const PUBLIC_HAPPY_HOUR_MISSIONS_ENABLED =
  PUBLIC_HAPPY_HOUR_DISCOVERY_ENABLED && PUBLIC_HAPPY_HOUR_CONTRIBUTIONS_ENABLED;
const AUTO_MISSION_TARGET_BEERS = [
  SUPPORTED_BEERS.guinness,
  SUPPORTED_BEERS.carlton_draft,
  SUPPORTED_BEERS.stone_and_wood,
] as const;
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const STRIPE_CHECKOUT_RESERVATION_TTL_MS = 35 * 60 * 1000;
const COUNTER_STAFF_INVITATION_TTL_MINUTES = 72 * 60;
const USER_GOOGLE_VENUE_TYPES = ["bar", "pub", "restaurant", "brewery", "night_club"] as const;
const USER_GOOGLE_VENUE_TYPE_SET = new Set<string>(USER_GOOGLE_VENUE_TYPES);
const REMOTE_VENUE_SCAN_PAGE_SIZE = 1000;
const MAX_REMOTE_VENUE_SCAN_ROWS = 5000;
const VENUE_ACCESS_PAGE_SIZE = 200;
const VENUE_ACCESS_EXPIRY_BATCH_SIZE = 500;
const MAX_VENUE_ACCESS_SCAN_ROWS = 20_000;
const MAX_PUBLIC_VENUE_STATUS_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS_PER_ACCOUNT = 10;
const REMOTE_VENUE_PUBLIC_COLUMNS = [
  "id",
  "name",
  "address",
  "suburb",
  "state",
  "postcode",
  "phone",
  "website",
  "latitude",
  "longitude",
  "business_status",
  "last_checked_at",
  "directory_eligible",
].join(", ");

function missionAcceptanceCutoff(now: string): string {
  return new Date(new Date(now).getTime() - MISSION_ACCEPTANCE_TTL_MS).toISOString();
}

function isHappyHourMission(mission: Pick<BusinessMission, "reason">): boolean {
  const normalizedReason = mission.reason.toLowerCase().replace(/[-_]+/g, " ");
  return normalizedReason.includes("happy") || /\bhh\b/.test(normalizedReason);
}

interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  data?: {
    object?: Record<string, unknown>;
  };
}

interface AuthoritativeStripeEvent {
  event: StripeEvent;
  authorityConfirmed: boolean;
}

interface StripeCheckoutSession {
  id?: string;
  url?: string | null;
  status?: string | null;
  payment_status?: string | null;
  customer?: string | { id?: string | null } | null;
  subscription?: string | { id?: string | null; status?: string | null; current_period_end?: number | null } | null;
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

function providerSecurityEpochIso(): string {
  // Supabase access-token timestamps are accepted with a small positive clock
  // skew. Advance the local epoch through that entire window so a token minted
  // before provider-wide sign-out cannot replay merely because the provider's
  // clock was ahead of this process.
  return new Date(Date.now() + BROWSER_CREDENTIAL_FUTURE_SKEW_MS).toISOString();
}

function providerGlobalRevocationClaimId(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function nextRevisionTimestamp(expectedUpdatedAt: string | null): string {
  const current = nowIso();
  if (!expectedUpdatedAt || current > expectedUpdatedAt) return current;
  return new Date(new Date(expectedUpdatedAt).getTime() + 1).toISOString();
}

function canonicalVenueOutreachContactTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? `${normalized}T00:00:00.000Z`
    : normalized;
}

async function fetchWithTimeout(url: string | URL, init: RequestInit = {}, timeoutMs = 8_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getSupabaseReadinessHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    apikey: key,
  };
  const isLegacyJwtKey = hasExactLegacySupabaseRoleJwt(key, "anon")
    || hasExactLegacySupabaseRoleJwt(key, "service_role");
  if (isLegacyJwtKey) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
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

  if (!name || !address || !isOperationalGoogleVenueBusinessStatus(place.businessStatus)) {
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

function isPostgresUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function publicRemoteWebsiteOrNull(value: unknown): string | null {
  const candidate = stringOrNull(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function publicRemoteTimestampOrNull(value: unknown): string | null {
  const candidate = stringOrNull(value);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function normalizePublicRemoteVenueRow(value: unknown): VenueRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const id = stringOrNull(row.id);
  const name = stringOrNull(row.name);
  if (!id || !name) {
    return null;
  }

  const rawBusinessStatus = stringOrNull(row.business_status);
  const businessStatus = normalizeGoogleVenueBusinessStatus(rawBusinessStatus);
  const lastCheckedAt = publicRemoteTimestampOrNull(row.last_checked_at);
  const lastCheckedAtMs = lastCheckedAt ? Date.parse(lastCheckedAt) : Number.NaN;
  const nowMs = Date.now();
  if (
    row.directory_eligible === false ||
    businessStatus !== "OPERATIONAL" ||
    (row.last_checked_at !== undefined && (
      !Number.isFinite(lastCheckedAtMs) ||
      lastCheckedAtMs > nowMs + 5 * 60_000 ||
      nowMs - lastCheckedAtMs > MAX_PUBLIC_VENUE_STATUS_AGE_MS
    ))
  ) {
    return null;
  }

  const rawPostcode = stringOrNull(row.postcode);
  const postcode = rawPostcode && isAustralianPostcode(rawPostcode)
    ? rawPostcode
    : null;

  return {
    id,
    name,
    address: stringOrNull(row.address),
    suburb: stringOrNull(row.suburb),
    state: stringOrNull(row.state),
    postcode,
    phone: stringOrNull(row.phone),
    website: publicRemoteWebsiteOrNull(row.website),
    latitude: numberOrNull(row.latitude),
    longitude: numberOrNull(row.longitude),
    businessStatus,
    lastCheckedAt,
  };
}

function normalizePublicRemoteVenueRows(value: unknown): VenueRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((row) => normalizePublicRemoteVenueRow(row))
    .filter((row): row is VenueRow => row !== null);
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

function startOfTodayIso(asOf = nowIso()): string {
  const date = new Date(asOf);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function daysAgoIso(days: number, asOf = nowIso()): string {
  const date = new Date(asOf);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

function startOfMonthIso(asOf = nowIso()): string {
  const date = new Date(asOf);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function startOfAdminRange(range: AdminDashboardQuery["range"], asOf = nowIso()): string | null {
  switch (range) {
    case "today":
      return startOfTodayIso(asOf);
    case "7d":
      return daysAgoIso(7, asOf);
    case "30d":
      return daysAgoIso(30, asOf);
    case "month":
      return startOfMonthIso(asOf);
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
const PINT_POINT_CHECKOUT_AUTHORIZATION_MINUTES = 30;

interface PintPointCheckoutClaims {
  version: 1;
  userId: string;
  venueId: string;
  authorizedByUserId: string;
  transactionReference: string;
  expiresAt: string;
}

function generateDiscountCode(): string {
  return Array.from({ length: 6 }, () =>
    DISCOUNT_PASS_CODE_ALPHABET[crypto.randomInt(DISCOUNT_PASS_CODE_ALPHABET.length)]!,
  ).join("");
}

function hashDiscountCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function normalizePintPointTransactionReference(value: string): string {
  return value.trim().toLowerCase();
}

function signPintPointCheckoutClaims(secret: string, claims: PintPointCheckoutClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
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
    return "Stripe price is inactive. Activate the monthly/yearly Stripe Price or update the configured recurring Price ID through the reviewed provider-change procedure.";
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

type StripeBillingPortalFailure = {
  message: string;
  publicCode:
    | "BILLING_CUSTOMER_NOT_FOUND_OR_MODE_MISMATCH"
    | "BILLING_PORTAL_NOT_CONFIGURED"
    | "BILLING_PORTAL_UNAVAILABLE";
  statusCode: number;
};

function describeStripeBillingPortalFailure(
  status: number,
  stripeError?: { code?: string | null; message?: string | null; param?: string | null; type?: string | null } | null,
): StripeBillingPortalFailure {
  const normalized = stripeError?.message?.trim().toLowerCase() ?? "";
  const errorCode = stripeError?.code?.trim().toLowerCase() ?? "";
  const errorParam = stripeError?.param?.trim().toLowerCase() ?? "";

  if (
    errorParam === "customer" ||
    (errorCode === "resource_missing" && normalized.includes("customer")) ||
    normalized.includes("no such customer") ||
    (normalized.includes("similar object exists in") && normalized.includes("mode"))
  ) {
    return {
      message: "This Stripe customer could not be found in the current test/live mode. Contact support so the billing link can be repaired.",
      publicCode: "BILLING_CUSTOMER_NOT_FOUND_OR_MODE_MISMATCH",
      statusCode: 409,
    };
  }

  if (
    (normalized.includes("portal") && normalized.includes("configuration")) ||
    normalized.includes("default configuration") ||
    errorParam === "configuration"
  ) {
    return {
      message: "Stripe billing management is not activated yet. Contact support while the Customer Portal setup is completed.",
      publicCode: "BILLING_PORTAL_NOT_CONFIGURED",
      statusCode: 503,
    };
  }

  return {
    message: status >= 500
      ? "Stripe billing management is temporarily unavailable. Try again shortly."
      : "Stripe billing management could not be opened. Contact support if the problem continues.",
    publicCode: "BILLING_PORTAL_UNAVAILABLE",
    statusCode: 502,
  };
}

function requireTrustedStripeBillingPortalUrl(value: string): string {
  let portalUrl: URL;
  try {
    portalUrl = new URL(value);
  } catch {
    throw new AppError("Stripe returned an invalid billing portal address. Try again shortly.", 502, {
      publicCode: "BILLING_PORTAL_UNAVAILABLE",
      reason: "invalid_portal_url",
    });
  }
  if (portalUrl.protocol !== "https:" || portalUrl.hostname !== "billing.stripe.com") {
    throw new AppError("Stripe returned an invalid billing portal address. Try again shortly.", 502, {
      publicCode: "BILLING_PORTAL_UNAVAILABLE",
      reason: "untrusted_portal_url",
      hostname: portalUrl.hostname,
    });
  }
  return portalUrl.toString();
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
    legalAcceptanceCurrent:
      account.termsVersion === CURRENT_LEGAL_POLICY_VERSION &&
      account.privacyVersion === CURRENT_LEGAL_POLICY_VERSION &&
      Boolean(account.termsAcceptedAt) &&
      Boolean(account.privacyAcceptedAt),
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
const SUPABASE_EVIDENCE_BUCKET_MIN_BYTES = 8 * 1024 * 1024;
const SUPABASE_STORAGE_POLICY_POSTURE_ENDPOINT =
  "rest/v1/pintpath_storage_policy_posture?select=object_policy_count,object_rls_enabled,bucket_policy_count,bucket_rls_enabled,public_bucket_count&limit=2";
const SUPABASE_EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
] as const;

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

function getSupabaseSessionIdHash(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const sessionId = payload?.session_id;
  if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 256) {
    return null;
  }
  return hashToken(`supabase-session:${sessionId}`);
}

function getSupabaseTokenIssuedAt(accessToken: string): string | null {
  const issuedAt = decodeJwtPayload(accessToken)?.iat;
  return typeof issuedAt === "number" && Number.isSafeInteger(issuedAt) && issuedAt > 0
    ? new Date(issuedAt * 1000).toISOString()
    : null;
}

function getSupabaseAuthenticationMethods(accessToken: string): string[] {
  const amr = decodeJwtPayload(accessToken)?.amr;
  if (!Array.isArray(amr)) return [];
  return amr.flatMap((entry) => {
    if (typeof entry === "string") return [entry.toLowerCase()];
    if (!entry || typeof entry !== "object") return [];
    const method = (entry as Record<string, unknown>).method;
    return typeof method === "string" ? [method.toLowerCase()] : [];
  });
}

function getSupabaseAuthenticationMethodTimeSeconds(
  accessToken: string,
  requiredMethod: string,
): number | null {
  const payload = decodeJwtPayload(accessToken);
  const normalizedMethod = requiredMethod.trim().toLowerCase();
  const candidates: number[] = [];
  let stringMethodPresent = false;
  if (Array.isArray(payload?.amr)) {
    for (const entry of payload.amr) {
      if (typeof entry === "string") {
        if (entry.trim().toLowerCase() === normalizedMethod) stringMethodPresent = true;
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (
        typeof record.method === "string"
        && record.method.trim().toLowerCase() === normalizedMethod
        && Number.isSafeInteger(record.timestamp)
        && Number(record.timestamp) > 0
      ) candidates.push(Number(record.timestamp));
    }
  }
  if (
    candidates.length === 0
    && stringMethodPresent
    && Number.isSafeInteger(payload?.auth_time)
    && Number(payload?.auth_time) > 0
  ) candidates.push(Number(payload!.auth_time));
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function getSupabaseCredentialTimeSeconds(
  accessToken: string,
  options: { allowRecovery?: boolean } = {},
): number | null {
  const payload = decodeJwtPayload(accessToken);
  const allowedMethods = new Set(SUPABASE_SIGN_IN_CREDENTIAL_METHODS);
  if (options.allowRecovery === true) allowedMethods.add("recovery");
  const candidates: number[] = [];
  let allowedStringMethod = false;
  if (Array.isArray(payload?.amr)) {
    for (const entry of payload.amr) {
      if (typeof entry === "string") {
        if (allowedMethods.has(entry.trim().toLowerCase())) allowedStringMethod = true;
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const method = typeof record.method === "string" ? record.method.trim().toLowerCase() : "";
      if (
        !allowedMethods.has(method)
        || !Number.isSafeInteger(record.timestamp)
        || Number(record.timestamp) <= 0
      ) continue;
      candidates.push(Number(record.timestamp));
    }
  }
  if (
    candidates.length === 0
    && allowedStringMethod
    && Number.isSafeInteger(payload?.auth_time)
    && Number(payload?.auth_time) > 0
  ) {
    candidates.push(Number(payload!.auth_time));
  }
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function requireFreshSupabaseCredentialCeremony(
  accessToken: string,
  maxAgeMs = BROWSER_CREDENTIAL_CEREMONY_MAX_AGE_MS,
  options: { allowRecovery?: boolean } = {},
): number {
  const credentialTimeSeconds = getSupabaseCredentialTimeSeconds(accessToken, options);
  const credentialAgeMs = credentialTimeSeconds === null
    ? Number.POSITIVE_INFINITY
    : Date.now() - credentialTimeSeconds * 1000;
  if (
    credentialTimeSeconds === null
    || !Number.isFinite(credentialAgeMs)
    || credentialAgeMs < -BROWSER_CREDENTIAL_FUTURE_SKEW_MS
    || credentialAgeMs > maxAgeMs
  ) {
    throw new AppError("A fresh provider sign-in or MFA step-up is required.", 403, {
      reauthenticationRequired: true,
      maxAgeMinutes: Math.floor(maxAgeMs / 60_000),
    });
  }
  return credentialTimeSeconds;
}

function getSupabaseEmailVerifiedAt(user: unknown): string | null {
  const record = user as Record<string, unknown>;
  const value = record.email_confirmed_at ?? record.confirmed_at;
  return typeof value === "string" && value ? value : null;
}

function getSupabaseMfaClaims(
  accessToken: string,
  user?: unknown,
): { mfaLevel: string; mfaVerifiedAt: string | null } {
  const payload = decodeJwtPayload(accessToken);
  const aal = typeof payload?.aal === "string" ? payload.aal : "aal1";
  if (user !== undefined && verifiedSupabaseMfaFactorIds(user).length === 0) {
    return { mfaLevel: "aal1", mfaVerifiedAt: null };
  }
  const amr = Array.isArray(payload?.amr) ? payload.amr : [];
  const latestMfaTimestamp = amr.reduce<number | null>((latest, entry) => {
    if (!entry || typeof entry !== "object") {
      return latest;
    }
    const record = entry as Record<string, unknown>;
    if (
      !["totp", "phone", "webauthn", "passkey"].includes(String(record.method || "").toLowerCase())
      || typeof record.timestamp !== "number"
      || !Number.isSafeInteger(record.timestamp)
    ) {
      return latest;
    }
    return latest == null || record.timestamp > latest ? record.timestamp : latest;
  }, null);
  return {
    mfaLevel: aal,
    mfaVerifiedAt: aal === "aal2" && latestMfaTimestamp != null
      ? new Date(latestMfaTimestamp * 1000).toISOString()
      : null,
  };
}

function verifiedSupabaseMfaFactorIds(user: unknown): string[] {
  const factors = (user as Record<string, unknown>)?.factors;
  if (factors == null) return [];
  if (!Array.isArray(factors)) {
    throw new AppError("The sign-in provider returned invalid authenticator state.", 503, undefined, false);
  }
  const verified: string[] = [];
  for (const factor of factors) {
    if (!factor || typeof factor !== "object") continue;
    const record = factor as Record<string, unknown>;
    if (record.status !== "verified") continue;
    if (
      typeof record.id !== "string"
      || !record.id.trim()
      || typeof record.factor_type !== "string"
      || !record.factor_type.trim()
    ) {
      throw new AppError("The sign-in provider returned invalid authenticator state.", 503, undefined, false);
    }
    verified.push(record.id.trim());
  }
  return [...new Set(verified)].sort();
}

function requireSupabaseMfaAssurance(user: unknown, accessToken: string): void {
  if (verifiedSupabaseMfaFactorIds(user).length === 0) return;
  if (getSupabaseMfaClaims(accessToken).mfaLevel !== "aal2") {
    throw new AppError("Complete your authenticator verification before continuing.", 403, {
      publicCode: "MFA_STEP_UP_REQUIRED",
      reauthenticationRequired: true,
      mfaRequired: true,
    });
  }
}

function isFullAccess(account: BusinessAccount | null, currentAdmin = false): boolean {
  if (!account) {
    return false;
  }

  if (account.status !== "active") {
    return false;
  }

  if (account.role === "admin" || account.subscriptionStatus === "admin") {
    return currentAdmin;
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
  currentAdmin?: boolean;
  consumerPaidEnrollmentEnabled: boolean;
  commercialLaunchEnabled: boolean;
  contributorUnlockPoints: number;
  savedItems?: SavedItem[];
  preferences?: AccountPreferences | null;
  discountStats?: { totalRedemptions: number; estimatedSavingsCents: number; uniqueVenues: number } | null;
}) {
  const hasFullAccess = isFullAccess(input.account, input.currentAdmin);
  const paidEnrollmentEnabled = input.commercialLaunchEnabled && input.consumerPaidEnrollmentEnabled;
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
  const contributionCopy = `Earn ${input.contributorUnlockPoints} approved points this month to unlock full map access.`;
  const upgradeCopy = paidEnrollmentEnabled
    ? `Upgrade for ${PREMIUM_PRICING.monthlyLabel}, ${PREMIUM_PRICING.yearlyLabel}, or ${contributionCopy.toLowerCase()}`
    : contributionCopy;

  return {
    enabled: hasFullAccess,
    status: hasFullAccess ? "active" : "locked",
    title: hasFullAccess ? "Full map toolkit" : "Unlock the full map toolkit",
    summary: hasFullAccess
      ? input.commercialLaunchEnabled
        ? "Your full-map tools are active: exact prices, value rings, premium filters, special access, saved night shortcuts, and savings tracking."
        : "Your contributor full-map tools are active: exact prices, value rings, full-map filters, and saved night shortcuts."
      : paidEnrollmentEnabled
        ? `Paid or earned access includes exact prices, value rings, premium filters, and saved night shortcuts. ${upgradeCopy}`
        : `Paid enrolment is closed. ${contributionCopy}`,
    lockedCopy: hasFullAccess ? null : upgradeCopy,
    primaryAction: hasFullAccess
      ? { label: "Open value map", href: "/index.html" }
      : paidEnrollmentEnabled
        ? { label: "Upgrade monthly", href: "/account.html?checkoutPlan=monthly" }
        : { label: "Upload venue data", href: "/submit.html" },
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
        badge: hasFullAccess ? "Active" : paidEnrollmentEnabled ? "Paid or earned" : "Earned",
        copy: "See every verified beer price and the green-to-red value ring around venue pins when comparing the same beer.",
        href: "/index.html",
        ctaLabel: "Open map",
      },
      {
        id: "premium_filters",
        title: "Map value filters",
        unlocked: hasFullAccess,
        badge: hasFullAccess ? "Active" : paidEnrollmentEnabled ? "Paid or earned" : "Earned",
        copy: "Use beer search, cheapest sort, verified-only, under-A$10, nearby, and saved-area filters across the full verified-price catalogue.",
        href: "/index.html",
        ctaLabel: "Find value",
      },
      ...(input.commercialLaunchEnabled ? [{
        id: "discount_pass",
        title: "Rotating special pass",
        unlocked: hasFullAccess,
        badge: hasFullAccess ? "Ready" : paidEnrollmentEnabled ? "Paid or earned" : "Earned",
        copy: "Generate a session-based QR/code for Pint Path specials, then track venue-confirmed savings in your account.",
        href: "/account.html",
        ctaLabel: "Open pass",
      }] : []),
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
        title: input.commercialLaunchEnabled ? "Savings and access tracker" : "Access tracker",
        unlocked: hasFullAccess,
        badge: hasFullAccess ? "Dashboard" : "Preview",
        copy: input.commercialLaunchEnabled
          ? "See estimated savings from redeemed specials, contribution progress, trust score, and current access status together."
          : "See contribution progress, trust score, and current access status together.",
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
  return record.displayKind === "happy_hour" ||
    record.isHappyHourPrice ||
    Boolean(record.happyHourDetails?.trim()) ||
    Boolean(record.happyHourTitle?.trim()) ||
    Boolean(record.happyHourDays?.length) ||
    Boolean(record.happyHourStartTime?.trim()) ||
    Boolean(record.happyHourEndTime?.trim()) ||
    Boolean(record.happyHourBeers?.length);
}

function isSpecialRecord(record: PublicVenuePriceRecord): boolean {
  return record.displayKind === "special" ||
    Boolean(record.specialTitle?.trim()) ||
    Boolean(record.specialDescription?.trim()) ||
    Boolean(record.specialDiscount?.trim()) ||
    Boolean(record.specialStartsAt?.trim()) ||
    Boolean(record.specialEndsAt?.trim()) ||
    Boolean(record.specialStartTime?.trim()) ||
    Boolean(record.specialEndTime?.trim()) ||
    Boolean(record.specialScheduleNote?.trim());
}

function isPublicLaunchPriceRecord(record: PublicVenuePriceRecord): boolean {
  return (PUBLIC_HAPPY_HOUR_DISCOVERY_ENABLED || !isHappyHourRecord(record)) &&
    (PUBLIC_SPECIAL_DISCOVERY_ENABLED || !isSpecialRecord(record));
}

function shouldExposePriceRecord(record: PublicVenuePriceRecord): boolean {
  if (record.sourceType === "source_ingestion_quarantined") {
    return false;
  }
  return isHappyHourRecord(record) || isSpecialRecord(record) || isLikelyBeerName(record.beerName);
}

const ESSENTIAL_EVENT_TYPES = new Set<EventTrackInput["eventType"]>([
  "age_confirmed",
  "age_verification_started",
  "age_verification_status_updated",
  "checkout_started",
  "subscription_created",
  "subscription_cancelled",
  "submission_completed",
  "data_upload_created",
  "data_verified",
  "data_edit_submitted",
  "submission_approved",
  "submission_rejected",
  "contributor_access_unlocked",
  "price_confirmation_answered",
  "wrong_price_reported",
  "venue_requested",
  "beer_requested",
  "mission_created_from_request",
  "feedback_submitted",
  "venue_interest_submitted",
  "venue_claim_requested",
  "venue_update_submitted",
  "venue_manager_assigned",
  "venue_manager_revoked",
  "outreach_status_updated",
]);

const SERVER_ONLY_EVENT_TYPES = new Set<EventTrackInput["eventType"]>([
  "account_dashboard_viewed",
  "price_confirmation_answered",
  "saved_update_opened",
  "saved_updates_viewed",
]);

const SAVED_UPDATES_EXPERIMENT_VERSION = "v1";

function serverEventPrivacyScope(input: EventTrackInput): "optional_analytics" | "venue_insight" | null {
  if (ESSENTIAL_EVENT_TYPES.has(input.eventType)) return null;
  return input.venueId ? "venue_insight" : "optional_analytics";
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

function isActionablePriceConfirmationRecord(record: PublicVenuePriceRecord): boolean {
  return shouldExposePriceRecord(record) &&
    isPublicLaunchPriceRecord(record) &&
    !isHappyHourRecord(record) &&
    !isSpecialRecord(record) &&
    (record.displayKind == null || record.displayKind === "beer") &&
    isPintServing(record) &&
    record.isOnTap === "yes" &&
    typeof record.price === "number" &&
    Number.isFinite(record.price) &&
    record.price > 0;
}

function priceConfirmationEventId(
  accountId: string,
  priceRecordId: string,
  priceVersion: string,
  outcome: PriceConfirmationInput["outcome"],
): string {
  const idempotencyDigest = crypto
    .createHash("sha256")
    .update(["v1", accountId, priceRecordId, priceVersion, outcome].join("\0"))
    .digest("hex");
  return `price_confirmation:${idempotencyDigest}`;
}

function isFreePreviewBeerRecord(record: PublicVenuePriceRecord): boolean {
  const canonicalBeerKey = findTrackedBeerByName(record.beerName)?.key ?? normalizeBeerSearchKey(canonicalizeTrackedBeerName(record.beerName));
  return isPintServing(record) && FREE_PREVIEW_BEER_KEYS.has(canonicalBeerKey);
}

function canFreeUserSeeRecord(record: PublicVenuePriceRecord): boolean {
  return (PUBLIC_HAPPY_HOUR_DISCOVERY_ENABLED && isHappyHourRecord(record)) ||
    isFreePreviewBeerRecord(record);
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

function normalizeVenueTags(existing: string[], incoming: string[], replace: boolean): string[] {
  const values = replace ? incoming : [...existing, ...incoming];
  const byKey = new Map<string, string>();
  for (const value of cleanStringList(values)) {
    const key = value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    if (key && !byKey.has(key)) byKey.set(key, key);
  }
  return Array.from(byKey.values()).slice(0, 20);
}

function normalizeVenueOpeningHours(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const normalizeDay = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const day = value as Record<string, unknown>;
    const legacyOpenTime = typeof day.open === "string" ? day.open : null;
    const legacyCloseTime = typeof day.close === "string" ? day.close : null;
    const openTime = typeof day.openTime === "string"
      ? day.openTime
      : typeof day.opens === "string"
        ? day.opens
        : typeof day.startTime === "string"
          ? day.startTime
          : legacyOpenTime;
    const closeTime = typeof day.closeTime === "string"
      ? day.closeTime
      : typeof day.closes === "string"
        ? day.closes
        : typeof day.endTime === "string"
          ? day.endTime
          : legacyCloseTime;
    return {
      open: typeof day.open === "boolean" ? day.open : Boolean(openTime && closeTime),
      openTime: openTime ?? null,
      closeTime: closeTime ?? null,
    };
  };
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) result[key] = normalizeDay(value);
  for (const [key, value] of Object.entries(incoming)) result[key] = normalizeDay(value);
  return result;
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

function stripePriceIds(value: unknown): Set<string> {
  const object = objectFromUnknown(value);
  const ids = new Set<string>();
  const addPrice = (price: unknown) => {
    const id = stripeObjectId(price);
    if (id) ids.add(id);
  };
  addPrice(object.price);
  addPrice(object.plan);
  for (const container of [objectFromUnknown(object.items), objectFromUnknown(object.lines)]) {
    const rows = Array.isArray(container.data) ? container.data : [];
    for (const row of rows) {
      const item = objectFromUnknown(row);
      addPrice(item.price);
      addPrice(item.plan);
    }
  }
  return ids;
}

function isStripeGrantEligibleStatus(status: unknown): status is "active" | "trialing" {
  return status === "active" || status === "trialing";
}

function hasManageableStripeSubscription(
  subscriptionId: string | null | undefined,
  status: string | null | undefined,
): boolean {
  if (!subscriptionId) return false;
  return status !== "canceled" && status !== "incomplete_expired";
}

function isStripeCheckoutSettled(object: Record<string, unknown>): boolean {
  const subscription = objectFromUnknown(object.subscription);
  if (typeof subscription.status === "string") {
    return isStripeGrantEligibleStatus(subscription.status);
  }
  return object.payment_status === "paid";
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
      : `Area search volume has not reached the ${analytics.privacyThreshold}-contributor privacy floor yet.`,
    topStyle
      ? `${topStyle.key} has enough distinct searching accounts/sessions to guide tap-list wording.`
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
      { label: "Discovery interest", value: analytics.barLookups, helper: "Map pins, venue cards and explicit venue lookups." },
      { label: "Beer-price intent", value: analytics.beerListViews + analytics.pricePreviewViews, helper: "Beer-list views and free-preview views." },
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

function buildHistoricalVenueDemandSnapshot(
  analytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]>,
) {
  const actionIntent = getTotalVenueActionIntent(analytics);
  const interactionTotal = analytics.barLookups + analytics.profileViews + analytics.beerListViews + analytics.specialsViews;
  const topBeer = analytics.privacyFloorMet ? analytics.areaBeerSearches[0] ?? null : null;
  const topStyle = analytics.privacyFloorMet ? analytics.areaStyleSearches[0] ?? null : null;
  const opportunityScore = interactionTotal === 0 && actionIntent === 0
    ? null
    : Math.min(100, Math.round(Math.min(interactionTotal, 100) * 0.75 + Math.min(actionIntent * 5, 25)));

  return {
    title: analytics.privacyFloorMet ? "Reporting-period demand snapshot" : "Reporting-period demand building",
    privacyFloorMet: analytics.privacyFloorMet,
    privacyThreshold: analytics.privacyThreshold,
    opportunityScore,
    funnel: [
      { label: "Discovery accounts/sessions", value: analytics.barLookups, helper: "Distinct signed-in accounts or anonymous sessions that used a map pin, venue card, or explicit lookup." },
      { label: "Beer-list accounts/sessions", value: analytics.beerListViews, helper: "Distinct signed-in accounts or anonymous sessions that opened the beer list." },
      { label: "Specials accounts/sessions", value: analytics.specialsViews, helper: "Distinct signed-in accounts or anonymous sessions that viewed specials or happy-hour offers." },
      { label: "Action accounts/sessions", value: actionIntent, helper: "Distinct accounts/sessions within each directions, save, or share action metric; this combined figure is directional." },
    ],
    demandHighlights: [
      topBeer
        ? `${topBeer.count} distinct accounts/sessions searched for ${formatBeerInsightName(topBeer.key)} in the venue area.`
        : `Area beer demand did not reach the ${analytics.privacyThreshold}-contributor privacy floor.`,
      topStyle
        ? `${topStyle.count} distinct accounts/sessions searched for the ${formatBeerInsightName(topStyle.key)} style in the venue area.`
        : "No beer-style bucket reached the distinct-contributor privacy floor.",
      actionIntent > 0
        ? "Accounts/sessions used at least one directions, save, night-plan, or share action during the reporting period."
        : "No reportable action-intent activity was recorded during the reporting period.",
    ],
    recommendedNextActions: [
      topBeer
        ? `Keep ${formatBeerInsightName(topBeer.key)} availability and pricing current for the next reporting period.`
        : "Keep the highest-priority tap-list rows current while local demand builds.",
      analytics.specialsViews > 0
        ? "Keep one clear special current so specials interest lands on an accurate offer."
        : "Consider one simple reviewed special to create a clearer reason to visit.",
      actionIntent > 0
        ? "Recheck address, hours, and offer conditions because accounts/sessions showed action intent."
        : "Strengthen the venue call-to-action and track whether action intent improves next month.",
    ],
  };
}

function getHistoricalVenueRecommendations(
  analytics: ReturnType<BusinessRepository["getVenueAreaAnalytics"]>,
): string[] {
  const topBeer = analytics.privacyFloorMet ? analytics.areaBeerSearches[0]?.key : null;
  const topStyle = analytics.privacyFloorMet ? analytics.areaStyleSearches[0]?.key : null;
  return [
    topBeer
      ? `Plan the next offer around reporting-period ${formatBeerInsightName(topBeer)} demand and measure the result next month.`
      : "Keep one broad, easy-to-understand offer active while local demand reaches the privacy floor.",
    topStyle
      ? `Use ${formatBeerInsightName(topStyle)} wording consistently in current tap-list rows so future searches can match accurately.`
      : "Add clear beer styles and serve sizes to current rows to improve future discovery matching.",
    getTotalVenueActionIntent(analytics) > 0
      ? "Review the reporting-period action funnel with venue managers and keep customer-facing details accurate."
      : "Test one stronger venue call-to-action and compare distinct action accounts/sessions in the next report.",
  ];
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
  const beerIntent = analytics.beerListViews + analytics.pricePreviewViews;
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
        ? `${topStyle.key} is attracting distinct searching accounts/sessions near ${input.area || "this venue"}.`
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
  inventoryBeers: BarBeer[];
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
          copy: `${row.count} distinct accounts/sessions searched for ${beerName} in ${area}.`,
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
      copy: `${row.searchCount} distinct accounts/sessions searched for ${row.beerName} in ${area}, but your venue does not list it.`,
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
    return redactSecrets(value.slice(0, 500))
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
      .replace(/(?:\+?61|0)[\s().-]?(?:\d[\s().-]?){8,10}\d/g, "[redacted]")
      .replace(/\bhttps?:\/\/\S+/gi, "[redacted]");
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

const MONTHLY_REPORT_SCHEMA_VERSION = 2;

function isValidMonthlyReportMonth(month: string): boolean {
  const match = month.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!match) return false;
  const year = Number(match[1]);
  return year >= 2020 && year <= 2100;
}

function isCurrentMonthlyReportSchema(report: MonthlyBarReport | null): report is MonthlyBarReport {
  return report?.data.schemaVersion === MONTHLY_REPORT_SCHEMA_VERSION;
}

function isCompletedMonthlyReportSnapshot(report: MonthlyBarReport | null): report is MonthlyBarReport {
  if (!isCurrentMonthlyReportSchema(report) || report.data.generated !== true) {
    return false;
  }

  const reportingPeriod = objectFromUnknown(report.data.reportingPeriod);
  const generatedAt = typeof report.data.generatedAt === "string" ? Date.parse(report.data.generatedAt) : Number.NaN;
  const periodEnd = typeof reportingPeriod.endIso === "string" ? Date.parse(reportingPeriod.endIso) : Number.NaN;
  return Number.isFinite(generatedAt) && Number.isFinite(periodEnd) && generatedAt >= periodEnd;
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

export function getMonthlyReportFilename(input: { venueId: string; month: string; format: "json" | "csv" }): string {
  const normalizedVenue = input.venueId.replace(/[^a-z0-9-]+/gi, "-");
  let start = 0;
  let end = normalizedVenue.length;
  while (start < end && normalizedVenue[start] === "-") start += 1;
  while (end > start && normalizedVenue[end - 1] === "-") end -= 1;
  let safeVenue = normalizedVenue.slice(start, end).slice(0, 80);
  while (safeVenue.endsWith("-")) safeVenue = safeVenue.slice(0, -1);
  safeVenue ||= "venue";
  return `pint-path-${safeVenue}-${input.month}-monthly-report.${input.format}`;
}

export class BusinessService {
  private readonly supabase?: SupabaseClient;
  private readonly useSupabaseEvidenceStorage: boolean;
  private readonly accountSessionRepository: AccountSessionRepository;
  private readonly accountProfilePreferencesRepository: AccountProfilePreferencesRepository;
  private readonly activityAuditRepository: ActivityAuditRepository;
  private readonly supportFeedbackRepository: SupportFeedbackRepository;
  private readonly adminAccountRepository: AdminAccountRepository;
  private readonly accountDeletionQueueRepository: AccountDeletionQueueRepository;
  private readonly accountPrivacyRepository: AccountPrivacyRepository;
  private readonly privacyRetentionRepository: PrivacyRetentionRepository;
  private readonly communitySubmissionRepository: CommunitySubmissionRepository;
  private readonly venueManagerInternalSubmissionRepository: VenueManagerInternalSubmissionRepository;
  private readonly sourceEvidenceObjectRepository: SourceEvidenceObjectRepository;
  private readonly venueIdentityRepository: VenueIdentityRepository;
  private readonly billingCheckoutRepository: BillingCheckoutRepository;
  private readonly venueAccessRepository: VenueAccessRepository;
  private readonly missionLifecycleRepository: MissionLifecycleRepository;
  private readonly missionDiscoveryAutomationRepository: MissionDiscoveryAutomationRepository;
  private readonly stripeSubscriptionRepository: StripeSubscriptionRepository;
  private readonly venueRequestRepository: VenueRequestRepository;
  private readonly venuePartnerRepository: VenuePartnerRepository;
  private readonly adminAnalyticsRepository: AdminAnalyticsRepository;
  private readonly venueManagerInsightsRepository: VenueManagerInsightsRepository;
  private readonly venuePendingChangeRepository: VenuePendingChangeRepository;
  private readonly venueDataReadRepository: VenueDataReadRepository;
  private readonly savedUpdatesReadRepository: SavedUpdatesReadRepository | undefined;
  private readonly databaseHealthProbe: () => Promise<{
    ok: boolean;
    foreignKeyViolations: number;
    poolMetrics?: readonly SafePostgresApplicationPoolMetrics[];
  }>;
  private supabaseReadinessCache: { expiresAt: number; value: SupabaseReadinessDependencies } | null = null;
  private supabaseReadinessInFlight: Promise<SupabaseReadinessDependencies> | null = null;

  constructor(
    private readonly repository: BusinessRepository,
    private readonly config: Pick<
      Env,
      | "PUBLIC_BASE_URL"
      | "CONTRIBUTOR_UNLOCK_POINTS"
      | "CONTRIBUTOR_UNLOCK_DAYS"
      | "DEMO_BILLING_MODE"
      | "COMMERCIAL_LAUNCH_ENABLED"
      | "CONSUMER_PAID_ENROLLMENT_ENABLED"
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
      | "PINT_POINTS_REWARDS_ENABLED"
      | "ALCOHOL_GAMIFICATION_ENABLED"
      | "STRIPE_SECRET_KEY"
      | "STRIPE_WEBHOOK_SECRET"
      | "STRIPE_PRICE_MONTHLY"
      | "STRIPE_PRICE_YEARLY"
      | "STRIPE_PRO_PRICE_ID"
      | "VENUE_PRO_TRIAL_DAYS"
      | "VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD"
      | "SUPABASE_URL"
      | "SUPABASE_ANON_KEY"
      | "SUPABASE_SERVICE_ROLE_KEY"
      | "SUPABASE_OAUTH_PROVIDERS"
      | "ADMIN_EMAILS"
      | "GOOGLE_MAPS_API_KEY"
      | "GOOGLE_PLACES_API_KEY"
    > & Partial<Pick<Env,
      | "DATABASE_PATH"
      | "RESTORE_REHEARSAL_MODE"
      | "POSTGRES_RECOVERY_REHEARSAL_MODE"
      | "REPORT_DELIVERY_SCHEDULE_ENABLED"
      | "REPORT_DELIVERY_DAY"
      | "REPORT_DELIVERY_HOUR"
      | "RESEND_API_KEY"
      | "REPORT_EMAIL_FROM"
      | "REPORT_EMAIL_REPLY_TO"
      | "ACCOUNT_DELETION_NOTICE_MODE"
      | "RESEND_WEBHOOK_SIGNING_SECRET"
      | "ACCOUNT_DELETION_REHEARSAL_ENABLED"
      | "ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES"
      | "OPENAI_API_KEY"
    >>,
    private readonly publicVenueDirectoryRepository: PublicVenueDirectoryRepository,
    private readonly publicPriceRepository: PublicPriceRepository,
    private readonly systemStateRepository: SystemStateRepository,
    activityAuditRepository: ActivityAuditRepository,
    supportFeedbackRepository: SupportFeedbackRepository,
    accountSessionRepository: AccountSessionRepository,
    accountProfilePreferencesRepository: AccountProfilePreferencesRepository,
    private readonly venueInventoryRepository: VenueInventoryRepository,
    venueIdentityRepository: VenueIdentityRepository,
    billingCheckoutRepository: BillingCheckoutRepository,
    venueAccessRepository: VenueAccessRepository,
    missionLifecycleRepository: MissionLifecycleRepository,
    missionDiscoveryAutomationRepository: MissionDiscoveryAutomationRepository,
    stripeSubscriptionRepository: StripeSubscriptionRepository,
    venueRequestRepository: VenueRequestRepository,
    venuePartnerRepository: VenuePartnerRepository,
    adminAnalyticsRepository: AdminAnalyticsRepository,
    venueManagerInsightsRepository: VenueManagerInsightsRepository,
    adminAccountRepository: AdminAccountRepository,
    accountDeletionQueueRepository: AccountDeletionQueueRepository,
    accountPrivacyRepository: AccountPrivacyRepository,
    privacyRetentionRepository: PrivacyRetentionRepository,
    communitySubmissionRepository: CommunitySubmissionRepository,
    venueManagerInternalSubmissionRepository: VenueManagerInternalSubmissionRepository,
    sourceEvidenceObjectRepository: SourceEvidenceObjectRepository,
    private readonly sourceEvidenceRetentionRepository: SourceEvidenceRetentionRepository,
    venuePendingChangeRepository: VenuePendingChangeRepository,
    venueDataReadRepository: VenueDataReadRepository,
    private readonly performAccountDeletionSecretPhysicalCheckpoint: (
      snapshot: readonly AccountDeletionSecretPurgeCheckpointEntry[],
    ) => Promise<boolean>,
    private readonly beerCatalogRepository?: BeerCatalogRepository,
    private readonly menuPhotoOcr?: MenuPhotoOcrProcessor,
    supabaseClientOverride?: SupabaseClient,
    private readonly accountDeletionTombstoneWriter?: (tombstone: {
      requestId: string;
      userId: string;
      completedAt: string;
    }) => Promise<void>,
    private readonly accountDeletionNotificationCoordinator?: AccountDeletionNotificationCoordinator,
    databaseHealthProbe?: () => Promise<{
      ok: boolean;
      foreignKeyViolations: number;
      poolMetrics?: readonly SafePostgresApplicationPoolMetrics[];
    }>,
    savedUpdatesReadRepository?: SavedUpdatesReadRepository,
  ) {
    this.activityAuditRepository = this.wrapActivityAuditRepository(activityAuditRepository);
    this.supportFeedbackRepository = this.wrapSupportFeedbackRepository(supportFeedbackRepository);
    this.accountSessionRepository = this.wrapAccountSessionRepository(accountSessionRepository);
    this.accountProfilePreferencesRepository = this.wrapAccountProfilePreferencesRepository(
      accountProfilePreferencesRepository,
    );
    this.venueIdentityRepository = this.wrapVenueIdentityRepository(venueIdentityRepository);
    this.billingCheckoutRepository = this.wrapBillingCheckoutRepository(billingCheckoutRepository);
    this.venueAccessRepository = this.wrapVenueAccessRepository(venueAccessRepository);
    this.missionLifecycleRepository = this.wrapMissionLifecycleRepository(missionLifecycleRepository);
    this.missionDiscoveryAutomationRepository = this.wrapMissionDiscoveryAutomationRepository(
      missionDiscoveryAutomationRepository,
    );
    this.stripeSubscriptionRepository = stripeSubscriptionRepository;
    this.venueRequestRepository = this.wrapVenueRequestRepository(venueRequestRepository);
    this.venuePartnerRepository = this.wrapVenuePartnerRepository(venuePartnerRepository);
    this.adminAnalyticsRepository = this.wrapAdminAnalyticsRepository(adminAnalyticsRepository);
    this.venueManagerInsightsRepository = this.wrapVenueManagerInsightsRepository(
      venueManagerInsightsRepository,
    );
    this.adminAccountRepository = this.wrapAdminAccountRepository(adminAccountRepository);
    this.accountDeletionQueueRepository = this.wrapAccountDeletionQueueRepository(accountDeletionQueueRepository);
    this.accountPrivacyRepository = this.wrapAccountPrivacyRepository(accountPrivacyRepository);
    this.privacyRetentionRepository = this.wrapPrivacyRetentionRepository(privacyRetentionRepository);
    this.communitySubmissionRepository = this.wrapCommunitySubmissionRepository(communitySubmissionRepository);
    this.venueManagerInternalSubmissionRepository = this.wrapVenueManagerInternalSubmissionRepository(
      venueManagerInternalSubmissionRepository,
    );
    this.sourceEvidenceObjectRepository = this.wrapSourceEvidenceObjectRepository(sourceEvidenceObjectRepository);
    this.venuePendingChangeRepository = this.wrapVenuePendingChangeRepository(venuePendingChangeRepository);
    this.venueDataReadRepository = this.wrapVenueDataReadRepository(venueDataReadRepository);
    this.savedUpdatesReadRepository = savedUpdatesReadRepository;
    this.databaseHealthProbe = databaseHealthProbe ?? (async () => this.repository.checkDatabaseHealth());
    const supabaseServerKey = config.SUPABASE_SERVICE_ROLE_KEY ?? config.SUPABASE_ANON_KEY;
    if (supabaseClientOverride && !config.RESTORE_REHEARSAL_MODE) {
      this.supabase = supabaseClientOverride;
    } else if (
      !config.RESTORE_REHEARSAL_MODE
      && config.SUPABASE_URL
      && supabaseServerKey
    ) {
      this.supabase = createServerSupabaseClient(config.SUPABASE_URL, supabaseServerKey);
    }
    this.useSupabaseEvidenceStorage = Boolean(this.supabase && config.SUPABASE_SERVICE_ROLE_KEY);
  }

  /** Maps stable identity/cache failures without exposing stored rows or database details. */
  private wrapVenueIdentityRepository(repository: VenueIdentityRepository): VenueIdentityRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedVenueIdentityError(error));
      },
    });
  }

  private throwMappedVenueIdentityError(error: unknown): never {
    if (!(error instanceof VenueIdentityRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid venue identity or location input.", 400);
      case "alias_version_conflict":
      case "identity_cycle":
      case "identity_limit_exceeded":
      case "location_version_conflict":
        throw new AppError("Venue identity or location changed. Refresh and try again.", 409);
      case "malformed_record":
      case "persistence_failure":
        throw new AppError("Venue identity or location data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable checkout persistence failures without exposing durable/provider details. */
  private wrapBillingCheckoutRepository(repository: BillingCheckoutRepository): BillingCheckoutRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedBillingCheckoutError(error));
      },
    });
  }

  private throwMappedBillingCheckoutError(error: unknown): never {
    if (!(error instanceof BillingCheckoutRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid billing checkout input.", 400);
      case "account_not_found":
      case "reservation_not_found":
      case "venue_not_found":
        throw new AppError("The billing account, venue, or checkout reservation was not found.", 404);
      case "deletion_locked":
        throw new AppError("Billing changes are unavailable while account deletion is being processed.", 409);
      case "finalization_conflict":
      case "intro_trial_already_claimed":
      case "reservation_expired":
      case "reservation_token_conflict":
      case "stale_reservation":
      case "venue_identity_conflict":
        throw new AppError("Billing checkout state changed. Refresh and try again.", 409);
      case "persistence_failure":
        throw new AppError("Billing checkout data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable Stripe persistence failures without exposing stored rows or database details. */
  private throwMappedStripeSubscriptionError(error: unknown): never {
    if (!(error instanceof StripeSubscriptionRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
      case "event_timestamp_required":
        throw new AppError("Invalid Stripe webhook event payload.", 400);
      case "account_not_found":
      case "billing_identity_conflict":
      case "event_claim_lost":
      case "event_conflict":
      case "retry_exhausted":
      case "venue_identity_conflict":
        throw new AppError("Stripe billing state changed. Retry the event safely.", 409);
      case "authoritative_state_required":
        throw new AppError("Stripe subscription authority is required before this event can be applied.", 503);
      case "persistence_failure":
        throw new AppError("Stripe billing data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable venue-access persistence failures without exposing stored rows or database details. */
  private wrapVenueAccessRepository(repository: VenueAccessRepository): VenueAccessRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedVenueAccessError(error));
      },
    });
  }

  private throwMappedVenueAccessError(error: unknown): never {
    if (!(error instanceof VenueAccessRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid venue access input.", 400);
      case "account_not_found":
      case "assignment_not_found":
      case "claim_not_found":
        throw new AppError("The venue claim or assignment was not found.", 404);
      case "invitation_not_found":
      case "invitation_expired":
      case "invitation_stale":
        throw new AppError("Pending counter-staff invitation not found or it has expired.", 404);
      case "forbidden":
        throw new AppError("Venue access permission is required for this change.", 403);
      case "account_not_active":
      case "assignment_conflict":
      case "claim_conflict":
      case "deletion_locked":
      case "invitation_token_conflict":
        throw new AppError("Venue access state changed. Refresh and try again.", 409);
      case "persistence_failure":
        throw new AppError("Venue access data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable mission-authority failures without exposing stored rows or database details. */
  private wrapMissionLifecycleRepository(repository: MissionLifecycleRepository): MissionLifecycleRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedMissionLifecycleError(error));
      },
    });
  }

  private throwMappedMissionLifecycleError(error: unknown): never {
    if (!(error instanceof MissionLifecycleRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid mission lifecycle input.", 400);
      case "account_not_found":
      case "mission_not_found":
      case "progress_not_found":
        throw new AppError("The mission or reservation was not found.", 404);
      case "account_not_eligible":
        throw new AppError("This account is not eligible to change missions.", 403);
      case "deletion_locked":
        throw new AppError("Mission changes are unavailable while account deletion is being processed.", 409);
      case "mission_in_use":
        throw new AppError("Mission has progress, submissions, or request history and can only be deactivated.", 409);
      case "mission_inactive":
        throw new AppError("This mission is no longer active.", 404);
      case "mission_reserved":
        throw new AppError(
          "Another contributor is already working on this mission. It will reopen if they do not submit within 24 hours.",
          409,
        );
      case "mission_version_conflict":
      case "progress_not_releasable":
      case "progress_version_conflict":
        throw new AppError("Mission state changed. Refresh and try again.", 409);
      case "malformed_record":
      case "persistence_failure":
        throw new AppError("Mission lifecycle data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable mission-discovery failures without exposing database details. */
  private wrapMissionDiscoveryAutomationRepository(
    repository: MissionDiscoveryAutomationRepository,
  ): MissionDiscoveryAutomationRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedMissionDiscoveryAutomationError(error));
      },
    });
  }

  private throwMappedMissionDiscoveryAutomationError(error: unknown): never {
    if (!(error instanceof MissionDiscoveryAutomationRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid mission discovery or automation input.", 400);
      case "owner_set_changed":
      case "timestamp_conflict":
        throw new AppError("Mission automation state changed. Retry the maintenance run.", 409);
      case "owner_set_too_large":
        throw new AppError("Mission automation exceeded its bounded owner budget.", 500, undefined, false);
      case "malformed_record":
      case "persistence_failure":
        throw new AppError("Mission discovery or automation data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable venue-request failures without exposing stored rows or database details. */
  private wrapVenueRequestRepository(repository: VenueRequestRepository): VenueRequestRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedVenueRequestError(error));
      },
    });
  }

  private throwMappedVenueRequestError(error: unknown): never {
    if (!(error instanceof VenueRequestRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid venue request input.", 400);
      case "account_not_found":
      case "request_not_found":
        throw new AppError("The venue request or account was not found.", 404);
      case "account_not_eligible":
      case "admin_not_authorized":
        throw new AppError("This account is not authorised to change venue requests.", 403);
      case "deletion_locked":
        throw new AppError("Venue-request changes are unavailable while account deletion is being processed.", 409);
      case "mission_id_conflict":
      case "request_id_conflict":
      case "request_version_conflict":
        throw new AppError("This venue request changed. Refresh and try again.", 409);
      case "request_state_conflict":
        throw new AppError("This request already has a mission or is no longer pending.", 409);
      case "malformed_record":
      case "persistence_failure":
        throw new AppError("Venue-request data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable venue-partner failures without exposing stored rows or database details. */
  private wrapVenuePartnerRepository(repository: VenuePartnerRepository): VenuePartnerRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedVenuePartnerError(error));
      },
    });
  }

  private throwMappedVenuePartnerError(error: unknown): never {
    if (!(error instanceof VenuePartnerRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid venue-partner input.", 400);
      case "account_not_found":
      case "interest_not_found":
      case "outreach_not_found":
        throw new AppError("The venue-partner record or account was not found.", 404);
      case "account_not_eligible":
      case "admin_not_authorized":
        throw new AppError("This account is not authorised to change venue-partner records.", 403);
      case "deletion_locked":
        throw new AppError("Venue-partner changes are unavailable while account deletion is being processed.", 409);
      case "interest_id_conflict":
      case "interest_version_conflict":
      case "outreach_id_conflict":
      case "outreach_version_conflict":
        throw new AppError("This venue-partner record changed. Refresh and try again.", 409);
      case "malformed_record":
      case "persistence_failure":
        throw new AppError("Venue-partner data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable admin-analytics failures without exposing stored rows or database details. */
  private wrapAdminAnalyticsRepository(repository: AdminAnalyticsRepository): AdminAnalyticsRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedAdminAnalyticsError(error));
      },
    });
  }

  private throwMappedAdminAnalyticsError(error: unknown): never {
    if (!(error instanceof AdminAnalyticsRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid admin analytics input.", 400);
      case "malformed_record":
      case "persistence_failure":
        throw new AppError("Admin analytics could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable manager-insights failures without exposing stored private detail or database errors. */
  private wrapVenueManagerInsightsRepository(
    repository: VenueManagerInsightsRepository,
  ): VenueManagerInsightsRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedVenueManagerInsightsError(error));
      },
    });
  }

  private throwMappedVenueManagerInsightsError(error: unknown): never {
    if (!(error instanceof VenueManagerInsightsRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid venue-manager insights input.", 400);
      case "malformed_result":
      case "persistence_failure":
        throw new AppError("Venue-manager insights could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable admin-account failures without exposing account or database details. */
  private wrapAdminAccountRepository(repository: AdminAccountRepository): AdminAccountRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedAdminAccountError(error));
      },
    });
  }

  private throwMappedAdminAccountError(error: unknown): never {
    if (!(error instanceof AdminAccountRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid admin account input.", 400);
      case "actor_not_authorized":
        throw new AppError("Admin access required.", 403);
      case "account_not_found":
        throw new AppError("Account not found.", 404);
      case "account_deletion_locked":
      case "admin_self_override":
      case "write_conflict":
        throw new AppError("Account state changed. Refresh and try again.", 409);
      case "malformed_record":
      case "persistence_failure":
        throw new AppError("Admin account data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable activity/audit failures without exposing stored payloads or database details. */
  private wrapActivityAuditRepository(repository: ActivityAuditRepository): ActivityAuditRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedActivityAuditError(error));
      },
    });
  }

  private throwMappedActivityAuditError(error: unknown): never {
    if (!(error instanceof ActivityAuditRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid activity or audit input.", 400);
      case "account_not_found":
        throw new AppError("Account not found.", 404);
      case "activity_conflict":
      case "audit_conflict":
      case "event_conflict":
        throw new AppError("Activity or audit state changed. Refresh and try again.", 409);
      case "persistence_failure":
      case "stored_record_invalid":
        throw new AppError("Activity or audit data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable support/trust-queue failures without exposing stored data or database details. */
  private wrapSupportFeedbackRepository(repository: SupportFeedbackRepository): SupportFeedbackRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedSupportFeedbackError(error));
      },
    });
  }

  private throwMappedSupportFeedbackError(error: unknown): never {
    if (!(error instanceof SupportFeedbackRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid support or wrong-price input.", 400);
      case "account_not_found":
      case "price_record_not_found":
        throw new AppError("The referenced account or price record was not found.", 404);
      case "feedback_conflict":
      case "wrong_price_report_conflict":
        throw new AppError("Support or wrong-price state changed. Refresh and try again.", 409);
      case "persistence_failure":
      case "stored_record_invalid":
        throw new AppError("Support or wrong-price data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable profile/preference failures without exposing stored or database data. */
  private wrapAccountProfilePreferencesRepository(
    repository: AccountProfilePreferencesRepository,
  ): AccountProfilePreferencesRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedAccountProfilePreferencesError(error));
      },
    });
  }

  private throwMappedAccountProfilePreferencesError(error: unknown): never {
    if (!(error instanceof AccountProfilePreferencesRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid account profile or preference input.", 400);
      case "account_not_found":
        throw new AppError("Account not found.", 404);
      case "write_conflict":
        throw new AppError("Account settings changed. Refresh and try again.", 409);
      case "stored_data_invalid":
      case "persistence_failed":
        throw new AppError("Account settings could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable moderation failures without exposing database/provider details. */
  private wrapCommunitySubmissionRepository(
    repository: CommunitySubmissionRepository,
  ): CommunitySubmissionRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedCommunitySubmissionError(error));
      },
    });
  }

  private throwMappedCommunitySubmissionError(error: unknown): never {
    if (!(error instanceof CommunitySubmissionRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid community submission input.", 400);
      case "account_not_found":
      case "submission_not_found":
      case "evidence_not_found":
        throw new AppError("Submission or source evidence was not found.", 404);
      case "account_not_eligible":
      case "evidence_not_owned":
      case "own_verification":
      case "review_forbidden":
        throw new AppError("This account is not allowed to perform that submission action.", 403);
      case "approval_conflict":
      case "catalog_conflict":
      case "catalog_decision_stale":
      case "catalog_not_active":
      case "idempotency_conflict":
      case "mission_decision_stale":
      case "mission_reservation_invalid":
      case "publication_conflict":
      case "publication_required":
      case "submission_not_reviewable":
      case "venue_decision_stale":
      case "verification_conflict":
        throw new AppError("Submission state changed. Refresh and try again.", 409);
      case "persistence_failure":
        throw new AppError("Community submission persistence failed.", 500, undefined, false);
    }
  }

  /** Maps internal-only venue-manager intake failures without exposing durable rows or database details. */
  private wrapVenueManagerInternalSubmissionRepository(
    repository: VenueManagerInternalSubmissionRepository,
  ): VenueManagerInternalSubmissionRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedVenueManagerInternalSubmissionError(error));
      },
    });
  }

  private throwMappedVenueManagerInternalSubmissionError(error: unknown): never {
    if (!(error instanceof VenueManagerInternalSubmissionRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
      case "mission_not_happy_hour":
        throw new AppError("Invalid internal venue happy-hour submission.", 400);
      case "account_not_found":
      case "assignment_not_found":
      case "evidence_not_found":
      case "mission_not_found":
        throw new AppError("The venue assignment, mission, or source evidence was not found.", 404);
      case "account_ineligible":
      case "evidence_not_owned":
      case "forbidden":
      case "wrong_venue":
        throw new AppError("Venue manager access is required for this internal submission.", 403);
      case "assignment_not_active":
      case "deletion_locked":
      case "evidence_not_live":
      case "mission_inactive":
      case "mission_not_accepted":
      case "mission_stale":
      case "mission_wrong_venue":
      case "submission_conflict":
        throw new AppError("Internal venue submission state changed. Refresh and try again.", 409);
      case "malformed_record":
      case "persistence_failure":
        throw new AppError("Internal venue submission data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable private-object failures without exposing database or object metadata. */
  private wrapSourceEvidenceObjectRepository(
    repository: SourceEvidenceObjectRepository,
  ): SourceEvidenceObjectRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedSourceEvidenceObjectError(error));
      },
    });
  }

  private throwMappedSourceEvidenceObjectError(error: unknown): never {
    if (!(error instanceof SourceEvidenceObjectRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid source evidence input.", 400);
      case "account_not_found":
        throw new AppError("Source evidence owner account not found.", 404);
      case "account_ineligible":
      case "deletion_locked":
        throw new AppError("This account cannot register source evidence.", 403);
      case "evidence_conflict":
        throw new AppError("Source evidence state changed. Refresh and try again.", 409);
      case "malformed_record":
      case "persistence_failure":
        throw new AppError("Source evidence persistence failed.", 500, undefined, false);
    }
  }

  /** Maps stable private-moderation failures without exposing persisted payload or database details. */
  private wrapVenuePendingChangeRepository(
    repository: VenuePendingChangeRepository,
  ): VenuePendingChangeRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedVenuePendingChangeError(error));
      },
    });
  }

  private throwMappedVenuePendingChangeError(error: unknown): never {
    if (!(error instanceof VenuePendingChangeRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid pending venue change input.", 400);
      case "pending_change_not_found":
        throw new AppError("Pending venue change not found.", 404);
      case "pending_change_not_reviewable":
      case "pending_change_version_conflict":
      case "target_not_found":
      case "target_version_conflict":
      case "target_venue_conflict":
        throw new AppError(
          "The venue data or review item changed after submission. Refresh and ask the manager to resubmit it.",
          409,
        );
      case "malformed_payload":
      case "malformed_record":
      case "persistence_failure":
        throw new AppError("Venue pending-change persistence failed.", 500, undefined, false);
    }
  }

  /** Maps stable venue-data read failures without exposing stored rows or database details. */
  private wrapVenueDataReadRepository(repository: VenueDataReadRepository): VenueDataReadRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedVenueDataReadError(error));
      },
    });
  }

  private throwMappedVenueDataReadError(error: unknown): never {
    if (!(error instanceof VenueDataReadRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid venue-data lookup input.", 400);
      case "malformed_record":
      case "persistence_failure":
        throw new AppError("Venue data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps only stable queue failures; unknown/database failures remain internal errors. */
  private wrapAccountDeletionQueueRepository(
    repository: AccountDeletionQueueRepository,
  ): AccountDeletionQueueRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedAccountDeletionQueueError(error));
      },
    });
  }

  private throwMappedAccountDeletionQueueError(error: unknown): never {
    if (!(error instanceof AccountDeletionQueueRepositoryError)) throw error;
    switch (error.code) {
      case "account_not_found":
        throw new AppError("Account not found.", 404);
      case "invalid_input":
        throw new AppError("Invalid account deletion input.", 400);
      case "notification_identity_conflict":
      case "notification_terminal":
      case "notification_recipient_missing":
      case "provider_event_identity_conflict":
      case "operator_audit_conflict":
        throw new AppError("Account deletion state changed. Refresh and try again.", 409);
      case "numeric_range":
        throw new AppError("Account deletion data could not be processed.", 500, undefined, false);
    }
  }

  /** Maps only stable privacy-boundary failures and never exposes stored/provider data. */
  private wrapAccountPrivacyRepository(repository: AccountPrivacyRepository): AccountPrivacyRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedAccountPrivacyError(error));
      },
    });
  }

  private throwMappedAccountPrivacyError(error: unknown): never {
    if (!(error instanceof AccountPrivacyRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid account privacy input.", 400);
      case "account_not_found":
        throw new AppError("Account not found.", 404);
      case "deletion_request_not_found":
        throw new AppError("Deletion request not found.", 404);
      case "deletion_attempt_conflict":
      case "completion_conflict":
        throw new AppError("This account deletion attempt no longer owns the request.", 409);
      case "identity_deletion_unconfirmed":
      case "stripe_deletion_unconfirmed":
      case "tombstone_unconfirmed":
        throw new ExternalServiceError(
          "Account deletion provider confirmation is incomplete; the request is saved for retry.",
        );
      case "notification_not_prepared":
        throw new ExternalServiceError(
          "Account-deletion completion notification preparation is incomplete; the request is saved for retry.",
        );
      case "stored_json_invalid":
        throw new AppError("Stored account deletion state could not be processed.", 500, undefined, false);
    }
  }

  /** Maps stable retention failures without exposing stored rows or database details. */
  private wrapPrivacyRetentionRepository(repository: PrivacyRetentionRepository): PrivacyRetentionRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedPrivacyRetentionError(error));
      },
    });
  }

  private throwMappedPrivacyRetentionError(error: unknown): never {
    if (!(error instanceof PrivacyRetentionRepositoryError)) throw error;
    switch (error.code) {
      case "invalid_input":
        throw new AppError("Invalid privacy-retention input.", 400);
      case "malformed_result":
      case "persistence_failure":
        throw new AppError("Privacy-retention persistence failed.", 500, undefined, false);
    }
  }

  /** Maps only stable repository failures; unknown/database failures remain internal errors. */
  private wrapAccountSessionRepository(repository: AccountSessionRepository): AccountSessionRepository {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => Promise
          .resolve(Reflect.apply(value, target, args))
          .catch((error: unknown) => this.throwMappedAccountSessionError(error));
      },
    });
  }

  private throwMappedAccountSessionError(error: unknown): never {
    if (!(error instanceof AccountSessionRepositoryError)) throw error;
    switch (error.code) {
      case "account_not_found":
        throw new AppError("Account not found.", 404);
      case "account_not_session_eligible":
        throw new AppError("Account access is unavailable.", 403);
      case "account_identity_conflict":
        throw new AppError("This account identity is already linked to another account.", 409);
      case "display_name_conflict":
        throw new AppError("That display name is already taken. Choose another leaderboard name.", 409);
      case "invalid_input":
        throw new AppError("Invalid account or session input.", 400);
      case "provider_global_revocation_pending":
        throw new AppError(
          "Provider-wide sign-out is already being completed. Wait a few minutes, then retry.",
          409,
          { publicCode: "PROVIDER_GLOBAL_REVOCATION_PENDING", reauthenticationRequired: true },
        );
      case "provider_session_revoked":
        throw new AppError("This sign-in provider session was revoked. Sign in again to start a new session.", 401);
      case "session_conflict":
        throw new AppError("Session state changed. Sign in again.", 409);
    }
  }

  private async getTrackedBeerCatalogForViewer() {
    return this.beerCatalogRepository
      ? this.beerCatalogRepository.listForViewer()
      : VIEWER_TRACKED_BEERS;
  }

  private async resolveSystemBeer(input: {
    name: string;
    source: string;
    now: string;
    createIfMissing?: boolean;
    matchMode?: "exact" | "ocr";
    brewery?: string | null;
    abv?: number | null;
  }): Promise<ResolvedBeerCatalogItem> {
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

  private async standardizeBeerReference(input: {
    name: string;
    source: string;
    now: string;
    isHappyHour?: boolean;
    createIfMissing?: boolean;
    matchMode?: "exact" | "ocr";
    brewery?: string | null;
    abv?: number | null;
  }): Promise<{
    key: string | null;
    name: string;
    brewery: string | null;
    style: string | null;
    abv: number | null;
    status: "active" | "pending_review";
    created: boolean;
    matchedExisting: boolean;
  }> {
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
    const resolved = await this.resolveSystemBeer(resolveInput);

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

  private async standardizeBarBeerInput(
    input: BarBeerInput,
    source: string,
    now: string,
  ): Promise<BarBeerInput & { normalizedBeerId: string | null }> {
    const resolved = await this.standardizeBeerReference({
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

  private async assertDisplayNameAvailable(displayName: string | null, currentUserId: string | null = null): Promise<string | null> {
    const displayNameKey = publicDisplayNameKey(displayName);
    if (!displayNameKey) {
      return null;
    }

    const existing = await this.accountSessionRepository.getAccountByDisplayNameKey(displayNameKey);
    if (existing && existing.id !== currentUserId) {
      throw new AppError("That display name is already taken. Choose another leaderboard name.", 409);
    }

    return displayNameKey;
  }

  private async providerDisplayNameIfAvailable(displayName: string | null, currentUserId: string | null = null): Promise<{ displayName: string | null; displayNameKey: string | null }> {
    const displayNameKey = publicDisplayNameKey(displayName);
    if (!displayName || !displayNameKey) {
      return { displayName: null, displayNameKey: null };
    }

    const existing = await this.accountSessionRepository.getAccountByDisplayNameKey(displayNameKey);
    if (existing && existing.id !== currentUserId) {
      return { displayName: null, displayNameKey: null };
    }

    return { displayName, displayNameKey };
  }

  private async auditSecurity(input: {
    actor?: BusinessAccount | null | undefined;
    action: string;
    targetType?: string | null | undefined;
    targetId?: string | null | undefined;
    metadata?: Record<string, unknown> | undefined;
    context?: SessionRequestContext | undefined;
  }): Promise<void> {
    const requestHashes = this.getRequestHashes(input.context);

    try {
      await this.activityAuditRepository.insertSecurityAuditLog({
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

  private async recordUserActivity(input: {
    account: BusinessAccount;
    eventType: string;
    relatedEntityType?: string | null | undefined;
    relatedEntityId?: string | null | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<void> {
    try {
      await this.activityAuditRepository.createUserActivityEvent({
        id: crypto.randomUUID(),
        userId: input.account.id,
        eventType: input.eventType,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        metadata: sanitizeEventMetadata(redactSecrets(input.metadata ?? {})),
        createdAt: nowIso(),
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

  async getPublicConfig() {
    const externalAuthDisconnected = Boolean(this.config.RESTORE_REHEARSAL_MODE);
    const commercialLaunchEnabled = this.config.COMMERCIAL_LAUNCH_ENABLED;
    const consumerPaidEnrollmentEnabled = commercialLaunchEnabled && this.config.CONSUMER_PAID_ENROLLMENT_ENABLED;
    return {
      pricing: consumerPaidEnrollmentEnabled ? PREMIUM_PRICING : null,
      priceAccessModel: "fixed_preview" as const,
      freePreviewScope: "Pint prices for Guinness, Carlton Draught, and Stone & Wood Pacific Ale.",
      happyHourDiscoveryEnabled: PUBLIC_HAPPY_HOUR_DISCOVERY_ENABLED,
      happyHourContributionsEnabled: PUBLIC_HAPPY_HOUR_CONTRIBUTIONS_ENABLED,
      contributorUnlockPoints: this.config.CONTRIBUTOR_UNLOCK_POINTS,
      contributorUnlockDays: this.config.CONTRIBUTOR_UNLOCK_DAYS,
      supabaseUrl: externalAuthDisconnected ? null : this.config.SUPABASE_URL ?? null,
      supabaseAnonKey: externalAuthDisconnected ? null : this.config.SUPABASE_ANON_KEY ?? null,
      supabaseOauthProviders: externalAuthDisconnected
        ? []
        : this.config.SUPABASE_OAUTH_PROVIDERS.split(",").map((provider) => provider.trim()).filter(Boolean),
      demoBillingMode: commercialLaunchEnabled && this.config.DEMO_BILLING_MODE,
      commercialLaunchEnabled,
      consumerPaidEnrollmentEnabled,
      fieldTestMode: this.config.FIELD_TEST_MODE,
      pintPointsRewardsEnabled: commercialLaunchEnabled && this.config.PINT_POINTS_REWARDS_ENABLED,
      alcoholGamificationEnabled: commercialLaunchEnabled && this.config.ALCOHOL_GAMIFICATION_ENABLED,
      venueProTrialDays: commercialLaunchEnabled ? this.config.VENUE_PRO_TRIAL_DAYS : 0,
      venueProTrialRequiresPaymentMethod: commercialLaunchEnabled
        ? this.config.VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD
        : false,
      legalPolicyVersion: CURRENT_LEGAL_POLICY_VERSION,
      trackedBeers: await this.getTrackedBeerCatalogForViewer(),
    };
  }

  async getAdminBeerCatalog(account: BusinessAccount, query: BeerCatalogAdminQuery = { pendingLimit: 100, pendingOffset: 0, activeLimit: 100, activeOffset: 0, activeQ: "" }): Promise<{
    pending: BeerCatalogAdminItem[];
    active: BeerCatalogAdminItem[];
    totals: { pending: number; active: number };
    pagination: Record<string, unknown>;
  }> {
    if (!this.isAdmin(account)) {
      throw new AppError("Admin access required.", 403);
    }
    if (!this.beerCatalogRepository) {
      throw new AppError("Beer catalogue review is not configured.", 503);
    }

    const [pending, active, pendingTotal, activeTotal] = await Promise.all([
      this.beerCatalogRepository.listForAdmin("pending_review", query.pendingLimit, query.pendingOffset),
      this.beerCatalogRepository.listForAdmin("active", query.activeLimit, query.activeOffset, query.activeQ),
      this.beerCatalogRepository.countForAdmin("pending_review"),
      this.beerCatalogRepository.countForAdmin("active", query.activeQ),
    ]);
    const totals = { pending: pendingTotal, active: activeTotal };
    return {
      pending,
      active,
      totals,
      pagination: {
        pending: { limit: query.pendingLimit, offset: query.pendingOffset, hasMore: query.pendingOffset + pending.length < totals.pending },
        active: { limit: query.activeLimit, offset: query.activeOffset, q: query.activeQ, hasMore: query.activeOffset + active.length < totals.active },
      },
    };
  }

  async approveBeerCatalogItem(
    account: BusinessAccount,
    key: string,
    input: { reviewNote?: string | null },
  ): Promise<{ beer: BeerCatalogAdminItem }> {
    if (!this.isAdmin(account)) {
      throw new AppError("Admin access required.", 403);
    }
    if (!this.beerCatalogRepository) {
      throw new AppError("Beer catalogue review is not configured.", 503);
    }

    const beer = await this.beerCatalogRepository.approvePendingBeer({
      key,
      reviewNote: input.reviewNote ?? null,
      now: nowIso(),
    });
    if (!beer) {
      throw new AppError("Pending beer was not found.", 404);
    }

    await this.auditSecurity({
      actor: account,
      action: "beer_catalog_item_approved",
      targetType: "beer_catalog_item",
      targetId: key,
      metadata: { reviewNote: input.reviewNote ?? null },
    });

    return { beer };
  }

  async mergeBeerCatalogItem(
    account: BusinessAccount,
    key: string,
    input: { targetKey: string; reviewNote?: string | null },
  ): Promise<{ source: BeerCatalogAdminItem; target: BeerCatalogAdminItem }> {
    if (!this.isAdmin(account)) {
      throw new AppError("Admin access required.", 403);
    }
    if (!this.beerCatalogRepository) {
      throw new AppError("Beer catalogue review is not configured.", 503);
    }

    const result = await this.beerCatalogRepository.mergePendingBeer({
      sourceKey: key,
      targetKey: input.targetKey,
      reviewNote: input.reviewNote ?? null,
      now: nowIso(),
    });
    if (!result) {
      throw new AppError("Pending beer could not be merged into that catalogue item.", 404);
    }

    await this.auditSecurity({
      actor: account,
      action: "beer_catalog_item_merged",
      targetType: "beer_catalog_item",
      targetId: key,
      metadata: { targetKey: input.targetKey, reviewNote: input.reviewNote ?? null },
    });

    return result;
  }

  async rejectBeerCatalogItem(
    account: BusinessAccount,
    key: string,
    input: { reviewNote?: string | null },
  ): Promise<{ beer: BeerCatalogAdminItem }> {
    if (!this.isAdmin(account)) {
      throw new AppError("Admin access required.", 403);
    }
    if (!this.beerCatalogRepository) {
      throw new AppError("Beer catalogue review is not configured.", 503);
    }

    const beer = await this.beerCatalogRepository.rejectPendingBeer({
      key,
      reviewNote: input.reviewNote ?? null,
      now: nowIso(),
    });
    if (!beer) {
      throw new AppError("Pending beer was not found.", 404);
    }

    await this.auditSecurity({
      actor: account,
      action: "beer_catalog_item_rejected",
      targetType: "beer_catalog_item",
      targetId: key,
      metadata: { reviewNote: input.reviewNote ?? null },
    });

    return { beer };
  }

  async rejectBeerCatalogItems(
    account: BusinessAccount,
    input: { keys: string[]; reviewNote?: string | null },
  ): Promise<{ beers: BeerCatalogAdminItem[]; rejectedCount: number }> {
    if (!this.isAdmin(account)) {
      throw new AppError("Admin access required.", 403);
    }
    if (!this.beerCatalogRepository) {
      throw new AppError("Beer catalogue review is not configured.", 503);
    }

    const beers: BeerCatalogAdminItem[] = [];
    for (const key of input.keys) {
      const beer = await this.beerCatalogRepository.rejectPendingBeer({
        key,
        reviewNote: input.reviewNote ?? null,
        now: nowIso(),
      });
      if (!beer) {
        throw new AppError("Pending beer was not found.", 404);
      }
      beers.push(beer);
    }

    await this.auditSecurity({
      actor: account,
      action: "beer_catalog_items_bulk_rejected",
      targetType: "beer_catalog_item",
      targetId: null,
      metadata: { keys: input.keys, rejectedCount: beers.length, reviewNote: input.reviewNote ?? null },
    });

    return {
      beers,
      rejectedCount: beers.length,
    };
  }

  async getAccountFromAuthorization(
    authorizationHeader: string | undefined,
    context?: SessionRequestContext | undefined,
  ): Promise<BusinessAccount | null> {
    if (this.config.RESTORE_REHEARSAL_MODE) {
      return null;
    }

    const token = getBearerToken(authorizationHeader);
    if (!token) {
      return null;
    }

    const tokenHash = hashToken(token);
    const authenticatedAt = nowIso();
    const account = await this.accountSessionRepository.getAccountBySessionTokenHash(tokenHash, authenticatedAt);
    if (!account) {
      return null;
    }

    if (account.status === "suspended") {
      return null;
    }

    const requestHashes = this.getRequestHashes(context);
    await this.accountSessionRepository.touchSession({
      tokenHash,
      lastUsedAt: authenticatedAt,
      lastIpHash: requestHashes.ipHash,
      userAgentHash: requestHashes.userAgentHash,
    });
    return account;
  }

  async requireAccount(
    authorizationHeader: string | undefined,
    context?: SessionRequestContext | undefined,
  ): Promise<BusinessAccount> {
    const account = await this.getAccountFromAuthorization(authorizationHeader, context);

    if (!account) {
      throw new AppError("Login required.", 401);
    }

    return account;
  }

  async requireRecentAuthentication(
    account: BusinessAccount,
    authorizationHeader: string | undefined,
    proof?: { accessToken: string | undefined; password: string | undefined },
    requiredPurpose: BrowserReauthenticationPurpose = "session_management",
    maxAgeMinutes = 15,
  ): Promise<void> {
    const token = getBearerToken(authorizationHeader);
    if (!token) throw new AppError("Recent sign-in required for this sensitive action.", 401);
    const createdAt = await this.accountSessionRepository.getActiveSessionCreatedAt({
      tokenHash: hashToken(token),
      userId: account.id,
      now: nowIso(),
    });
    if (!createdAt) {
      throw new AppError("Recent sign-in required for this sensitive action.", 401, {
        reauthenticationRequired: true,
        reauthPurpose: requiredPurpose,
        maxAgeMinutes,
      });
    }

    const browserCredential = browserCredentialSessionToken(token);
    if (browserCredential) {
      const createdAtMs = Date.parse(createdAt);
      const credentialTimeMs = browserCredential.credentialTimeSeconds * 1000;
      const ageMs = Date.now() - credentialTimeMs;
      if (
        browserCredential.purpose !== requiredPurpose
        || !Number.isFinite(createdAtMs)
        || credentialTimeMs > createdAtMs + BROWSER_CREDENTIAL_FUTURE_SKEW_MS
        || !Number.isFinite(ageMs)
        || ageMs < -BROWSER_CREDENTIAL_FUTURE_SKEW_MS
        || ageMs > maxAgeMinutes * 60_000
      ) {
        throw new AppError("Purpose-bound reauthentication is required for this sensitive action.", 403, {
          reauthenticationRequired: true,
          reauthPurpose: requiredPurpose,
          maxAgeMinutes,
        });
      }
      return;
    }

    // Hosted accounts use only the purpose-bound HttpOnly capability above.
    // A raw provider bearer is a browser-sendable header and therefore cannot
    // distinguish native secure storage from same-origin script execution.
    if (this.config.NODE_ENV === "test") return;

    if (account.supabaseUserId) {
      throw new AppError("Purpose-bound reauthentication is required for this sensitive action.", 403, {
        reauthenticationRequired: true,
        reauthPurpose: requiredPurpose,
        maxAgeMinutes,
      });
    }

    if (!proof?.password || !await verifyPassword(proof.password, account.passwordHash)) {
      throw new AppError("Current password required for this sensitive action.", 403, {
        reauthenticationRequired: true,
      });
    }
  }

  async requireAdmin(
    authorizationHeader: string | undefined,
    context?: SessionRequestContext | undefined,
  ): Promise<BusinessAccount> {
    const account = await this.requireAccount(authorizationHeader, context);
    const adminEmails = this.getAdminEmailAllowlist();

    if (account.role !== "admin" && account.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    if (this.config.NODE_ENV === "production") {
      this.requireCurrentLegalAcceptance(account);
      if (adminEmails.size === 0 || !adminEmails.has(normalizeEmail(account.email))) {
        await this.auditSecurity({
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
        await this.auditSecurity({
          actor: account,
          action: "admin_mfa_step_up_required",
          targetType: "account",
          targetId: account.id,
          metadata: { mfaLevel: account.mfaLevel },
          context,
        });
        throw new AppError("Admin MFA step-up required.", 403);
      }

      if (this.config.REQUIRE_ADMIN_MFA_IN_PRODUCTION && account.supabaseUserId) {
        const adminMfa = this.supabase?.auth.admin?.mfa;
        if (!adminMfa?.listFactors) {
          throw new AppError("Admin authenticator verification is temporarily unavailable.", 503);
        }
        let factorResult;
        try {
          factorResult = await adminMfa.listFactors({ userId: account.supabaseUserId });
        } catch {
          throw new AppError("Admin authenticator verification is temporarily unavailable.", 503);
        }
        if (factorResult.error || !Array.isArray(factorResult.data?.factors)) {
          throw new AppError("Admin authenticator verification is temporarily unavailable.", 503);
        }
        if (verifiedSupabaseMfaFactorIds({ factors: factorResult.data.factors }).length === 0) {
          await this.auditSecurity({
            actor: account,
            action: "admin_mfa_step_up_required",
            targetType: "account",
            targetId: account.id,
            metadata: { mfaLevel: account.mfaLevel, providerFactorMissing: true },
            context,
          });
          throw new AppError("Admin MFA step-up required.", 403);
        }
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

  private requireCurrentLegalAcceptance(account: BusinessAccount): void {
    if (
      !account.termsAcceptedAt ||
      !account.privacyAcceptedAt ||
      account.termsVersion !== CURRENT_LEGAL_POLICY_VERSION ||
      account.privacyVersion !== CURRENT_LEGAL_POLICY_VERSION
    ) {
      throw new AppError("Accept the current Terms and Privacy Policy before continuing.", 403, {
        currentVersion: CURRENT_LEGAL_POLICY_VERSION,
      });
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
    this.requireCurrentLegalAcceptance(account);
  }

  private isAdmin(account: BusinessAccount): boolean {
    if (account.role !== "admin" && account.subscriptionStatus !== "admin") {
      return false;
    }
    if (this.config.NODE_ENV !== "production") {
      return true;
    }
    const adminEmails = this.getAdminEmailAllowlist();
    if (
      !account.termsAcceptedAt ||
      !account.privacyAcceptedAt ||
      account.termsVersion !== CURRENT_LEGAL_POLICY_VERSION ||
      account.privacyVersion !== CURRENT_LEGAL_POLICY_VERSION ||
      adminEmails.size === 0 ||
      !adminEmails.has(normalizeEmail(account.email)) ||
      !account.emailVerifiedAt
    ) {
      return false;
    }
    return !this.config.REQUIRE_ADMIN_MFA_IN_PRODUCTION || this.hasFreshAdminMfa(account);
  }

  private async assertAdminControlPreserved(actor: BusinessAccount, target: BusinessAccount): Promise<void> {
    const targetHasAdminAuthority = target.role === "admin" || target.subscriptionStatus === "admin";
    if (!targetHasAdminAuthority) return;
    if (actor.id === target.id) {
      throw new AppError("Administrators cannot approve their own deletion or suspension.", 409);
    }
    const remaining = (await this.accountSessionRepository.listActiveAdminAccounts(target.id)).filter((candidate) => this.isAdmin(candidate));
    if (remaining.length === 0) {
      throw new AppError("This action would remove the last active, authorised administrator.", 409);
    }
  }

  private toBarClaimRequest(claim: VenueClaimRecord) {
    const { venueId, venueName, ...rest } = claim;
    return { ...rest, barId: venueId, barName: venueName };
  }

  private async collectVenueAssignments(
    input: {
      userId?: string | undefined;
      venueId?: string | undefined;
      accessLevel?: VenueAccessLevel | undefined;
      status?: VenueAccessStatus | undefined;
      currentOnly?: boolean | undefined;
    },
    maximumRows = MAX_VENUE_ACCESS_SCAN_ROWS,
    requireComplete = true,
  ): Promise<VenueAccessAssignmentRecord[]> {
    if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > MAX_VENUE_ACCESS_SCAN_ROWS) {
      throw new AppError("Invalid venue access page request.", 400);
    }
    const assignments: VenueAccessAssignmentRecord[] = [];
    const seenIds = new Set<string>();
    let cursor: VenueAssignmentCursor | null = null;
    for (;;) {
      const remaining = maximumRows - assignments.length;
      if (remaining === 0) {
        if (requireComplete) {
          throw new AppError("Venue access results exceed the safe processing limit.", 503, undefined, false);
        }
        return assignments;
      }
      const page = await this.venueAccessRepository.listVenueAssignments({
        ...input,
        limit: Math.min(VENUE_ACCESS_PAGE_SIZE, remaining),
        cursor,
      });
      for (const assignment of page.assignments) {
        if (seenIds.has(assignment.id)) {
          throw new AppError("Venue access pagination could not be completed.", 500, undefined, false);
        }
        seenIds.add(assignment.id);
        assignments.push(assignment);
      }
      if (!page.nextCursor) return assignments;
      if (!requireComplete && assignments.length >= maximumRows) return assignments;
      if (
        page.assignments.length === 0
        || (cursor?.updatedAt === page.nextCursor.updatedAt && cursor.id === page.nextCursor.id)
      ) {
        throw new AppError("Venue access pagination could not be completed.", 500, undefined, false);
      }
      cursor = page.nextCursor;
    }
  }

  private async collectVenueClaims(
    input: { userId?: string | undefined; status?: VenueClaimStatus | undefined },
    maximumRows: number,
    requireComplete: boolean,
  ): Promise<VenueClaimRecord[]> {
    if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > MAX_VENUE_ACCESS_SCAN_ROWS) {
      throw new AppError("Invalid venue claim page request.", 400);
    }
    const claims: VenueClaimRecord[] = [];
    const seenIds = new Set<string>();
    let cursor: VenueClaimCursor | null = null;
    for (;;) {
      const remaining = maximumRows - claims.length;
      if (remaining === 0) {
        if (requireComplete) {
          throw new AppError("Venue claim results exceed the safe processing limit.", 503, undefined, false);
        }
        return claims;
      }
      const page = await this.venueAccessRepository.listVenueClaims({
        ...input,
        limit: Math.min(VENUE_ACCESS_PAGE_SIZE, remaining),
        cursor,
      });
      for (const claim of page.claims) {
        if (seenIds.has(claim.id)) {
          throw new AppError("Venue claim pagination could not be completed.", 500, undefined, false);
        }
        seenIds.add(claim.id);
        claims.push(claim);
      }
      if (!page.nextCursor) return claims;
      if (!requireComplete && claims.length >= maximumRows) return claims;
      if (
        page.claims.length === 0
        || (cursor?.createdAt === page.nextCursor.createdAt && cursor.id === page.nextCursor.id)
      ) {
        throw new AppError("Venue claim pagination could not be completed.", 500, undefined, false);
      }
      cursor = page.nextCursor;
    }
  }

  private async getVenueAssignmentOffsetPage(
    input: {
      userId?: string | undefined;
      venueId?: string | undefined;
      accessLevel?: VenueAccessLevel | undefined;
      status?: VenueAccessStatus | undefined;
      currentOnly?: boolean | undefined;
    },
    query: AdminPaginationInput,
    total: number,
  ): Promise<VenueAccessAssignmentRecord[]> {
    if (query.offset >= total) return [];
    const end = query.offset + query.limit;
    if (!Number.isSafeInteger(end) || end > MAX_VENUE_ACCESS_SCAN_ROWS) {
      throw new AppError(
        `Venue access pagination is limited to the first ${MAX_VENUE_ACCESS_SCAN_ROWS} rows.`,
        400,
      );
    }
    return (await this.collectVenueAssignments(input, end, false)).slice(query.offset, end);
  }

  private async getVenueClaimOffsetPage(
    input: { userId?: string | undefined; status?: VenueClaimStatus | undefined },
    query: AdminPaginationInput,
    total: number,
  ): Promise<VenueClaimRecord[]> {
    if (query.offset >= total) return [];
    const end = query.offset + query.limit;
    if (!Number.isSafeInteger(end) || end > MAX_VENUE_ACCESS_SCAN_ROWS) {
      throw new AppError(
        `Venue claim pagination is limited to the first ${MAX_VENUE_ACCESS_SCAN_ROWS} rows.`,
        400,
      );
    }
    return (await this.collectVenueClaims(input, end, false)).slice(query.offset, end);
  }

  private async expireVenueCounterStaffInvitations(asOf: string): Promise<number> {
    const seenTokens = new Set<string>();
    let expiredCount = 0;
    while (expiredCount < MAX_VENUE_ACCESS_SCAN_ROWS) {
      const result = await this.venueAccessRepository.expireCounterStaffInvitations({
        asOf,
        limit: VENUE_ACCESS_EXPIRY_BATCH_SIZE,
      });
      for (const invitationToken of result.invitationTokens) {
        if (seenTokens.has(invitationToken)) {
          throw new AppError("Venue invitation expiry did not make progress.", 500, undefined, false);
        }
        seenTokens.add(invitationToken);
      }
      expiredCount += result.expiredCount;
      if (result.expiredCount < VENUE_ACCESS_EXPIRY_BATCH_SIZE) return expiredCount;
    }
    throw new AppError("Venue invitation expiry exceeds the safe processing limit.", 503, undefined, false);
  }

  private async requireAssignedVenue(
    account: BusinessAccount,
    venueId: string,
    requiredAccess: "manager" | "counter" = "manager",
  ): Promise<VenueAccessAssignmentRecord | null> {
    if (this.isAdmin(account)) {
      return null;
    }

    this.requireVerifiedBarAccount(account);

    const assignment = await this.venueAccessRepository.getVenueAssignment({
      userId: account.id,
      venueId,
      activeOnly: true,
    });

    if (!assignment) {
      await this.auditSecurity({
        actor: account,
        action: "venue_manager_cross_venue_blocked",
        targetType: "venue",
        targetId: venueId,
        metadata: { accountRole: account.role },
      });
      throw new AppError("Venue manager access required. You can only access assigned venues.", 403);
    }

    if (requiredAccess === "manager" && assignment.accessLevel !== "manager") {
      await this.auditSecurity({
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
    assignment: VenueAccessAssignmentRecord | null,
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
    assignment: VenueAccessAssignmentRecord | null,
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

  private async requireBarSpecialsTier(account: BusinessAccount, venueId: string): Promise<void> {
    if (this.isAdmin(account)) {
      return;
    }

    const membershipTier = (await this.venueInventoryRepository.getBarProfile(venueId))?.membershipTier ?? "basic";
    if (!getBarTierCapabilities(membershipTier).canManageSpecials) {
      throw new AppError("Pro venue tier required to manage Pint Path specials.", 403);
    }
  }

  private async requireFeaturedSpecialsTier(account: BusinessAccount, venueId: string): Promise<void> {
    const membershipTier = (await this.venueInventoryRepository.getBarProfile(venueId))?.membershipTier ?? "basic";
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
      stripePaidMembershipTier: null,
      highlightedName: false,
      premiumBadge: null,
      promoted: false,
      featuredSpecialEligible: false,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      subscriptionCurrentPeriodEnd: null,
      tierManualOverride: false,
      acceptsPintPathCodes: false,
      stripeEventCreatedAt: null,
      posWebhookTokenVersion: 1,
      posPreviousTokenVersion: null,
      posPreviousTokenValidUntil: null,
      posLastSuccessAt: null,
      posLastTerminalId: null,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async getOrBuildBarProfile(input: { barId: string; name: string; suburb: string | null }): Promise<BarProfile> {
    return (await this.venueInventoryRepository.getBarProfile(input.barId)) ?? this.buildDefaultBarProfile(input);
  }

  private sanitizeVenueManagerInsights(
    rawInsights: VenueManagerInsights,
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

  private async ensureBarProfileAsync(input: {
    barId: string;
    name: string;
    suburb: string | null;
  }): Promise<BarProfile> {
    const existing = await this.venueInventoryRepository.getBarProfile(input.barId);
    if (existing) {
      return existing;
    }

    const flags = tierFlags("basic");
    return this.venueInventoryRepository.upsertBarProfile({
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

  private async createPendingBarChange(input: {
    account: BusinessAccount;
    venueId: string;
    changeType: BarPendingChangeType;
    action: BarPendingChangeAction;
    targetId: string | null;
    payload: Record<string, unknown>;
    suburb?: string | null | undefined;
  }) {
    const now = nowIso();
    const pendingChange = await this.venuePendingChangeRepository.createBarPendingChange({
      id: crypto.randomUUID(),
      barId: input.venueId,
      changeType: input.changeType,
      action: input.action,
      targetId: input.targetId,
      payload: input.payload,
      submittedBy: input.account.id,
      now,
    });

    await this.trackEvent(input.account, {
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

  private async maybeQueueVenueDeleteForReview(input: {
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
    const recentDeletes = await this.activityAuditRepository.countRecentVenueManagerDeletes({
      venueId: input.venueId,
      since: oneHourAgo,
      changeType: input.changeType,
    });
    if (recentDeletes < 3) {
      return null;
    }

    const existingPendingDelete = await this.venuePendingChangeRepository.getPendingBarChangeForTarget({
      barId: input.venueId,
      changeType: input.changeType,
      action: "delete",
      targetId: input.targetId,
    });
    if (existingPendingDelete) {
      return {
        pendingChange: existingPendingDelete,
        message: input.changeType === "beer"
          ? "Beer delete held for admin review because 3 beers were already removed in the last hour."
          : "Delete held for admin review because several venue items were removed in the last hour.",
      };
    }

    const result = await this.createPendingBarChange({
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

  async signup(input: AuthSignupInput, context?: SessionRequestContext | undefined) {
    if (this.config.NODE_ENV === "production") {
      throw new AppError("Password signup is disabled. Continue with the configured secure sign-in provider.", 410);
    }
    const email = normalizeEmail(input.email);

    if (await this.accountSessionRepository.getAccountByEmail(email)) {
      throw new AppError("An account already exists for that email.", 409);
    }

    const now = nowIso();
    const displayName = validatePublicDisplayName(input.displayName);
    const displayNameKey = await this.assertDisplayNameAvailable(displayName);
    const account = await this.accountSessionRepository.createAccount({
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(input.password),
      displayName,
      displayNameKey,
      // Local development accounts must never gain admin authority merely by
      // presenting an allowlisted but unverified email address.
      role: "user",
      subscriptionStatus: "free",
      termsAcceptedAt: now,
      privacyAcceptedAt: now,
      termsVersion: CURRENT_LEGAL_POLICY_VERSION,
      privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
      now,
    });
    const confirmed = input.ageConfirmed ? await this.accountSessionRepository.updateAgeConfirmed(account.id, now) : account;

    await this.trackEvent(confirmed, {
      anonymousSessionId: null,
      eventType: "signup_completed",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { role: confirmed.role },
    });
    await this.recordUserActivity({
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
      await this.trackEvent(confirmed, {
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
    if (this.config.NODE_ENV === "production") {
      throw new AppError("Password login is disabled. Continue with the configured secure sign-in provider.", 410);
    }
    const account = await this.accountSessionRepository.getAccountByEmail(normalizeEmail(input.email));

    if (!account || !await verifyPassword(input.password, account.passwordHash)) {
      throw new AppError("Invalid email or password.", 401);
    }

    if (account.status === "suspended") {
      const recovery = await this.getSuspendedBillingRecoveryOptions(account);
      const recoveryEligible = recovery.consumer || recovery.venues.length > 0;
      throw new AppError("Account access is suspended. Billing management remains available through secure billing recovery.", 403, {
        publicCode: recoveryEligible ? "ACCOUNT_SUSPENDED_BILLING_RECOVERY" : "ACCOUNT_SUSPENDED",
        billingRecoveryEligible: recoveryEligible,
        billingRecoveryConsumer: recovery.consumer,
        billingRecoveryVenues: recovery.venues,
        billingRecoveryEndpoint: "/api/business/billing/recovery-portal",
      });
    }

    const session = await this.createSessionResponse(account, context);
    await this.recordUserActivity({
      account,
      eventType: "user_login",
      relatedEntityType: "account",
      relatedEntityId: account.id,
      metadata: { authProvider: account.authProvider },
    });
    await this.auditSecurity({
      actor: account,
      action: "login_success",
      targetType: "account",
      targetId: account.id,
      metadata: { role: account.role },
      context,
    });
    return session;
  }

  async beginBrowserEmailReauthentication(
    account: BusinessAccount,
    authorizationHeader: string | undefined,
    purpose: BrowserReauthenticationPurpose,
  ): Promise<{ email: string; expiresAt: string; challengeToken: string }> {
    const currentToken = getBearerToken(authorizationHeader);
    const secret = this.config.SOURCE_EVIDENCE_SIGNING_SECRET;
    if (!currentToken || !secret || !account.supabaseUserId) {
      throw new AppError("Email reauthentication is unavailable for this account.", 503);
    }
    const currentAccount = await this.accountSessionRepository.getAccountBySessionTokenHash(
      hashToken(currentToken),
      nowIso(),
    );
    if (
      !currentAccount
      || currentAccount.id !== account.id
      || currentAccount.supabaseUserId !== account.supabaseUserId
      || normalizeEmail(currentAccount.email) !== normalizeEmail(account.email)
    ) {
      throw new AppError("Your Pint Path session changed before email reauthentication could start.", 409, {
        reauthenticationRequired: true,
        reauthPurpose: purpose,
      });
    }
    const challenge = createBrowserEmailReauthenticationChallenge({
      secret,
      accountId: account.id,
      purpose,
      currentTokenHash: hashToken(currentToken),
      issuedAtSeconds: Math.floor(Date.now() / 1000),
    });
    return {
      email: normalizeEmail(account.email),
      expiresAt: challenge.expiresAt,
      challengeToken: challenge.token,
    };
  }

  async loginWithSupabaseAccessToken(
    input: AuthSupabaseSessionInput,
    context?: SessionRequestContext | undefined,
    existingAuthorization?: string | undefined,
    browserEmailReauthenticationChallenge?: string | undefined,
    trustedNativeClient?: "ios-native-v1" | "android-native-v1" | null | undefined,
  ) {
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
    if (input.credentialCeremony === "native_memory_v1" && !trustedNativeClient) {
      throw new AppError("The native credential ceremony is unavailable on this client channel.", 403, {
        reauthenticationRequired: true,
        reauthPurpose: input.reauthPurpose,
      });
    }
    const browserCredentialPurpose: BrowserCredentialSessionPurpose | null =
      input.credentialCeremony !== undefined
        ? input.reauthPurpose ?? "session"
        : null;
    let currentCookieSessionToken = getBearerToken(existingAuthorization);
    const ordinaryBrowserSessionExchange =
      input.credentialCeremony === BROWSER_MEMORY_CREDENTIAL_CEREMONY
      && browserCredentialPurpose === "session";
    if (
      browserCredentialPurpose !== null
      && browserCredentialPurpose !== "session"
      && !currentCookieSessionToken
    ) {
      throw new AppError("Your Pint Path session expired before reauthentication completed. Sign in again, then retry the sensitive action.", 409, {
        reauthenticationRequired: true,
        reauthPurpose: browserCredentialPurpose,
      });
    }
    let currentAppAccount: BusinessAccount | null = null;
    if (
      currentCookieSessionToken
      && (
        ordinaryBrowserSessionExchange
        || (browserCredentialPurpose !== null && browserCredentialPurpose !== "session")
      )
    ) {
      currentAppAccount = await this.accountSessionRepository.getAccountBySessionTokenHash(
        hashToken(currentCookieSessionToken),
        nowIso(),
      );
    }
    if (browserCredentialPurpose !== null && browserCredentialPurpose !== "session") {
      if (
        !currentAppAccount
        || currentAppAccount.supabaseUserId !== supabaseUser.id
        || normalizeEmail(currentAppAccount.email) !== email
      ) {
        throw new AppError(
          "That provider login does not match the active Pint Path session. Sign in to the original account and retry.",
          409,
          {
            reauthenticationRequired: true,
            reauthPurpose: browserCredentialPurpose,
          },
        );
      }
    }
    if (ordinaryBrowserSessionExchange) {
      if (currentAppAccount) {
        const existingIdentityMatches = currentAppAccount.supabaseUserId !== null
          ? currentAppAccount.supabaseUserId === supabaseUser.id
          : normalizeEmail(currentAppAccount.email) === email
            && Boolean(getSupabaseEmailVerifiedAt(supabaseUser));
        if (!existingIdentityMatches) {
          throw new AppError(
            "That provider login does not match the active Pint Path session. Sign out before switching accounts.",
            409,
          );
        }
      } else {
        // A missing, expired, revoked, or otherwise ineligible cookie is not
        // rotation authority. Continue as a logged-out cross-device exchange.
        currentCookieSessionToken = null;
      }
    }
    if (input.credentialCeremony === "browser_email_otp_v1") {
      const secret = this.config.SOURCE_EVIDENCE_SIGNING_SECRET;
      if (!secret) {
        throw new AppError("The email reauthentication challenge is missing, expired, or does not match this session.", 409, {
          reauthenticationRequired: true,
          reauthPurpose: input.reauthPurpose,
        });
      }
      const parsedChallenge = parseBrowserEmailReauthenticationChallenge(
        browserEmailReauthenticationChallenge ?? "",
        secret,
        Math.floor(Date.now() / 1000),
      );
      if (
        !currentAppAccount
        || !input.reauthPurpose
        || !parsedChallenge
        || parsedChallenge.accountId !== currentAppAccount.id
        || parsedChallenge.purpose !== input.reauthPurpose
        || parsedChallenge.currentTokenHash !== hashToken(currentCookieSessionToken!)
      ) {
        throw new AppError("The email reauthentication challenge is missing, expired, or does not match this session.", 409, {
          reauthenticationRequired: true,
          reauthPurpose: input.reauthPurpose,
        });
      }
      const authenticationMethods = getSupabaseAuthenticationMethods(input.accessToken);
      if (!authenticationMethods.includes("otp")) {
        throw new AppError("Open the latest Pint Path email reauthentication link before continuing.", 403, {
          reauthenticationRequired: true,
          reauthPurpose: input.reauthPurpose,
        });
      }
      const otpTimeSeconds = getSupabaseAuthenticationMethodTimeSeconds(input.accessToken, "otp");
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (
        otpTimeSeconds === null
        || otpTimeSeconds < parsedChallenge.issuedAtSeconds
        || otpTimeSeconds > nowSeconds + Math.floor(BROWSER_CREDENTIAL_FUTURE_SKEW_MS / 1000)
        || nowSeconds - otpTimeSeconds > BROWSER_EMAIL_REAUTH_CHALLENGE_TTL_SECONDS
      ) {
        throw new AppError("Open the latest Pint Path email reauthentication link before continuing.", 403, {
          reauthenticationRequired: true,
          reauthPurpose: input.reauthPurpose,
        });
      }
    }
    let browserCredentialTimeSeconds: number | null = null;
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

    const [accountBySupabaseId, accountByEmail] = await Promise.all([
      this.accountSessionRepository.getAccountBySupabaseUserId(supabaseUser.id),
      this.accountSessionRepository.getAccountByEmail(email),
    ]);
    if (accountBySupabaseId && accountByEmail && accountBySupabaseId.id !== accountByEmail.id) {
      throw new AppError("This provider identity conflicts with another Pint Path account. Contact support before continuing.", 409);
    }
    if (accountByEmail?.supabaseUserId && accountByEmail.supabaseUserId !== supabaseUser.id) {
      throw new AppError("This email is already linked to a different sign-in identity. Contact support before relinking it.", 409);
    }
    let account = accountBySupabaseId ?? accountByEmail;
    if (account && await this.accountSessionRepository.hasProviderGlobalRevocationPending(account.id)) {
      throw new AppError(
        "Provider-wide sign-out is still incomplete. Finish that security cleanup before creating another Pint Path session.",
        409,
        {
          publicCode: "PROVIDER_GLOBAL_REVOCATION_PENDING",
          reauthenticationRequired: true,
        },
      );
    }
    requireSupabaseMfaAssurance(supabaseUser, input.accessToken);
    const now = nowIso();
    const providerTokenIssuedAt = getSupabaseTokenIssuedAt(input.accessToken);
    if (account?.providerTokensValidAfter) {
      if (
        !providerTokenIssuedAt
        || Date.parse(providerTokenIssuedAt) <= Date.parse(account.providerTokensValidAfter)
      ) {
        throw new AppError("This sign-in token predates a security reset. Sign in again to continue.", 401);
      }
    }
    const emailVerifiedAt = getSupabaseEmailVerifiedAt(supabaseUser);
    const mfaClaims = getSupabaseMfaClaims(input.accessToken, supabaseUser);
    if (
      input.credentialCeremony === BROWSER_MEMORY_CREDENTIAL_CEREMONY
      && input.reauthPurpose
      && getSupabaseAuthenticationMethods(input.accessToken).some((method) => ["oauth", "saml", "sso"].includes(method))
    ) {
      throw new AppError("Confirm this sensitive action through the email sent to your verified account.", 403, {
        publicCode: "EMAIL_REAUTHENTICATION_REQUIRED",
        reauthenticationRequired: true,
        reauthPurpose: input.reauthPurpose,
      });
    }
    const providerSessionIdHash = getSupabaseSessionIdHash(input.accessToken);
    if (!providerSessionIdHash) {
      throw new AppError("The sign-in provider session is missing its session identifier. Sign in again before continuing.", 401);
    }
    if (await this.accountSessionRepository.isProviderSessionRevoked({
      userId: account?.id ?? supabaseUser.id,
      providerSessionIdHash,
    })) {
      throw new AppError("This sign-in provider session was revoked. Sign in again to start a new session.", 401);
    }
    if (browserCredentialPurpose) {
      browserCredentialTimeSeconds = requireFreshSupabaseCredentialCeremony(
        input.accessToken,
        BROWSER_CREDENTIAL_CEREMONY_MAX_AGE_MS,
        { allowRecovery: browserCredentialPurpose === "session" },
      );
    }
    const legalAcceptance = input.legalAcceptance ?? (
      input.ageConfirmed === true &&
      input.termsAccepted === true &&
      input.privacyAccepted === true &&
      input.termsVersion === CURRENT_LEGAL_POLICY_VERSION &&
      input.privacyVersion === CURRENT_LEGAL_POLICY_VERSION
        ? {
            ageConfirmed: true as const,
            termsAccepted: true as const,
            privacyAccepted: true as const,
            termsVersion: CURRENT_LEGAL_POLICY_VERSION,
            privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
            source: input.consentSource ?? "web" as const,
          }
        : undefined
    );

    if (
      this.config.NODE_ENV === "production" &&
      this.config.REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION &&
      !emailVerifiedAt
    ) {
      throw new AppError("Verify your email with the sign-in provider before continuing.", 403);
    }

    if (!account && !legalAcceptance) {
      throw new AppError("Accept the current Terms and Privacy Policy before creating your Pint Path account.", 403, {
        currentVersion: CURRENT_LEGAL_POLICY_VERSION,
      });
    }

    let supabaseAccountSessionMutation: SupabaseAccountSessionMutation | null = null;
    if (!account) {
      const adminEmails = this.getAdminEmailAllowlist();
      const providerIdentity = await this.providerDisplayNameIfAvailable(displayName);
      account = await this.accountSessionRepository.createAccount({
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
        termsAcceptedAt: legalAcceptance ? now : null,
        privacyAcceptedAt: legalAcceptance ? now : null,
        termsVersion: legalAcceptance ? CURRENT_LEGAL_POLICY_VERSION : null,
        privacyVersion: legalAcceptance ? CURRENT_LEGAL_POLICY_VERSION : null,
        role: adminEmails.has(email) && Boolean(emailVerifiedAt) ? "admin" : "user",
        subscriptionStatus: adminEmails.has(email) && Boolean(emailVerifiedAt) ? "admin" : "free",
        now,
      });
      if (legalAcceptance?.ageConfirmed) {
        account = await this.accountSessionRepository.updateAgeConfirmed(account.id, now);
      }
      await this.recordUserActivity({
        account,
        eventType: "user_signup",
        relatedEntityType: "account",
        relatedEntityId: account.id,
        metadata: { authProvider: "supabase" },
      });
    } else {
      if (!accountBySupabaseId && accountByEmail && !emailVerifiedAt) {
        throw new AppError("Verify this email with the sign-in provider before linking it to an existing Pint Path account.", 403);
      }
      if (accountBySupabaseId && normalizeEmail(accountBySupabaseId.email) !== email && !emailVerifiedAt) {
        throw new AppError("Verify the changed provider email before updating your Pint Path account.", 403);
      }
      const nextDisplayName = account.displayName ?? displayName;
      const providerIdentity = await this.providerDisplayNameIfAvailable(nextDisplayName, account.id);
      supabaseAccountSessionMutation = {
        authProvider: "supabase",
        supabaseUserId: supabaseUser.id,
        email,
        displayName: providerIdentity.displayName,
        displayNameKey: providerIdentity.displayNameKey,
        avatarUrl,
        emailVerifiedAt,
        mfaLevel: mfaClaims.mfaLevel,
        mfaVerifiedAt: mfaClaims.mfaVerifiedAt,
        legalAcceptance: legalAcceptance
          ? {
              termsVersion: CURRENT_LEGAL_POLICY_VERSION,
              privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
              ageConfirmed: true,
            }
          : null,
      };
    }

    if (!legalAcceptance) this.requireCurrentLegalAcceptance(account);

    if (account.status === "suspended") {
      const recovery = await this.getSuspendedBillingRecoveryOptions(account);
      const recoveryEligible = recovery.consumer || recovery.venues.length > 0;
      throw new AppError("Account access is suspended. Billing management remains available through secure billing recovery.", 403, {
        publicCode: recoveryEligible ? "ACCOUNT_SUSPENDED_BILLING_RECOVERY" : "ACCOUNT_SUSPENDED",
        billingRecoveryEligible: recoveryEligible,
        billingRecoveryConsumer: recovery.consumer,
        billingRecoveryVenues: recovery.venues,
        billingRecoveryEndpoint: "/api/business/billing/recovery-portal",
      });
    }

    const session = await this.createSessionResponse(
      account,
      context,
      providerSessionIdHash,
      {
        currentToken: currentCookieSessionToken,
        providerTokenIssuedAt,
        credential: browserCredentialPurpose && browserCredentialTimeSeconds !== null
          ? {
              purpose: browserCredentialPurpose,
              credentialTimeSeconds: browserCredentialTimeSeconds,
            }
          : null,
        supabaseAccountMutation: supabaseAccountSessionMutation,
        onSupabaseAccountCommitted: (committedAccount) => {
          account = committedAccount;
        },
      },
    );
    // A provider identity is not a successful Pint Path login until the
    // account-locked session rotation/creation has committed. Both audit
    // writers are best-effort, so recording afterwards cannot strand a valid
    // credential if an audit sink is temporarily unavailable.
    await this.recordUserActivity({
      account,
      eventType: "user_login",
      relatedEntityType: "account",
      relatedEntityId: account.id,
      metadata: { authProvider: "supabase" },
    });
    await this.auditSecurity({
      actor: account,
      action: "login_success",
      targetType: "account",
      targetId: account.id,
      metadata: { authProvider: "supabase", role: account.role },
      context,
    });
    return session;
  }

  async completePasswordReset(input: PasswordResetCompleteInput, context?: SessionRequestContext | undefined) {
    if (!this.supabase) {
      throw new AppError("Supabase authentication is not configured.", 503);
    }
    const payload = decodeJwtPayload(input.accessToken);
    const providerSessionIdHash = getSupabaseSessionIdHash(input.accessToken);
    const issuedAt = getSupabaseTokenIssuedAt(input.accessToken);
    const authenticationMethods = getSupabaseAuthenticationMethods(input.accessToken);
    if (
      !providerSessionIdHash ||
      !issuedAt ||
      !authenticationMethods.some((method) => method === "otp" || method === "recovery")
    ) {
      throw new AppError("Invalid password recovery session. Request a new password reset link.", 401);
    }

    const { data, error } = await this.supabase.auth.getUser(input.accessToken);
    if (error || !data.user?.id || !data.user.email || payload?.sub !== data.user.id) {
      throw new AppError("Invalid password recovery session. Request a new password reset link.", 401);
    }
    const account = await this.accountSessionRepository.getAccountBySupabaseUserId(data.user.id);
    if (!account || normalizeEmail(account.email) !== normalizeEmail(data.user.email)) {
      throw new AppError("Invalid password recovery session. Request a new password reset link.", 401);
    }
    const verifiedMfaFactorIds = verifiedSupabaseMfaFactorIds(data.user);
    if (verifiedMfaFactorIds.length > 0) {
      const mfaAccessToken = input.mfaAccessToken ?? input.accessToken;
      let mfaUser = data.user;
      if (mfaAccessToken !== input.accessToken) {
        const mfaIdentity = await this.supabase.auth.getUser(mfaAccessToken);
        if (
          mfaIdentity.error
          || mfaIdentity.data.user?.id !== data.user.id
          || normalizeEmail(mfaIdentity.data.user?.email ?? "") !== normalizeEmail(data.user.email)
          || getSupabaseSessionIdHash(mfaAccessToken) !== providerSessionIdHash
        ) {
          throw new AppError("Authenticator verification does not belong to this recovery session.", 403, {
            publicCode: "MFA_STEP_UP_REQUIRED",
            reauthenticationRequired: true,
            mfaRequired: true,
          });
        }
        mfaUser = mfaIdentity.data.user;
      }
      requireSupabaseMfaAssurance(mfaUser, mfaAccessToken);
    }

    const completedAt = nowIso();
    const revocationClaimId = providerGlobalRevocationClaimId();
    let initialContainment;
    try {
      initialContainment = await this.accountSessionRepository.completePasswordResetContainment({
        userId: account.id,
        providerSessionIdHash,
        providerTokensValidAfter: providerSecurityEpochIso(),
        revokedAt: completedAt,
        beginProviderGlobalRevocation: {
          claimId: revocationClaimId,
          operation: "password_reset",
        },
      });
    } catch (error) {
      if (
        error instanceof AccountSessionRepositoryError
        && error.code === "provider_global_revocation_pending"
      ) {
        throw new AppError(
          "Provider-wide sign-out is already being completed for this account. Wait a few minutes, then retry recovery.",
          409,
          { publicCode: "PROVIDER_GLOBAL_REVOCATION_PENDING", reauthenticationRequired: true },
        );
      }
      throw error;
    }
    const providerRevocation = await this.revokeProviderSessionsGlobally(
      account,
      input.accessToken,
      data.user.id,
    );
    const postProviderCompletedAt = nowIso();
    const postProviderContainment = await this.accountSessionRepository.completePasswordResetContainment({
      userId: account.id,
      providerSessionIdHash,
      providerTokensValidAfter: providerSecurityEpochIso(),
      revokedAt: postProviderCompletedAt,
      finishProviderGlobalRevocation: {
        claimId: revocationClaimId,
        completed: providerRevocation.revoked,
        operation: "password_reset",
      },
    });
    const containment = {
      revokedSessions: initialContainment.revokedSessions + postProviderContainment.revokedSessions,
      revokedDiscountPasses:
        initialContainment.revokedDiscountPasses + postProviderContainment.revokedDiscountPasses,
      cancelledRewardCodes:
        initialContainment.cancelledRewardCodes + postProviderContainment.cancelledRewardCodes,
    };
    if (!providerRevocation.revoked) {
      await this.auditProviderGlobalSignoutFailure(
        account,
        "password_reset",
        providerRevocation.errorCode,
        context,
      );
    }
    await this.recordUserActivity({
      account,
      eventType: "password_reset_completed",
      relatedEntityType: "account",
      relatedEntityId: account.id,
      metadata: { reauthenticationRequired: true },
    });
    await this.auditSecurity({
      actor: account,
      action: "password_reset_completed",
      targetType: "account",
      targetId: account.id,
      metadata: {
        revokedSessions: containment.revokedSessions,
        revokedDiscountPasses: containment.revokedDiscountPasses,
        cancelledRewardCodes: containment.cancelledRewardCodes,
        providerTokenEpochAdvanced: true,
        providerSessionsRevoked: providerRevocation.revoked,
      },
      context,
    });
    return {
      completed: true,
      reauthenticationRequired: true,
      providerSessionsRevoked: providerRevocation.revoked,
      ...containment,
    };
  }

  async resumeProviderGlobalRevocation(
    input: PasswordResetCompleteInput,
    context?: SessionRequestContext | undefined,
  ) {
    if (!this.supabase) {
      throw new AppError("Supabase authentication is not configured.", 503);
    }
    const { data, error } = await this.supabase.auth.getUser(input.accessToken);
    if (error || !data.user?.id || !data.user.email) {
      throw new AppError("A current sign-in provider session is required to finish global sign-out.", 401);
    }
    const account = await this.accountSessionRepository.getAccountBySupabaseUserId(data.user.id);
    if (!account || normalizeEmail(account.email) !== normalizeEmail(data.user.email)) {
      throw new AppError("The sign-in provider session does not belong to this account.", 403);
    }
    const claimedAt = nowIso();
    const claimId = providerGlobalRevocationClaimId();
    const claim = await this.accountSessionRepository.claimProviderGlobalRevocation({
      userId: account.id,
      claimId,
      claimedAt,
    });
    if (claim.status !== "claimed") {
      if (claim.status === "absent") {
        throw new AppError("There is no pending provider-wide sign-out to resume.", 409);
      }
      throw new AppError(
        "Provider-wide sign-out is already being completed. Wait five minutes, then retry if it does not finish.",
        409,
        { publicCode: "PROVIDER_GLOBAL_REVOCATION_PENDING", reauthenticationRequired: true },
      );
    }

    const providerRevocation = await this.revokeProviderSessionsGlobally(
      account,
      input.accessToken,
      data.user.id,
    );
    const completedAt = nowIso();
    const containment = await this.accountSessionRepository.revokeUserSessionsWithSummary({
      userId: account.id,
      revokedAt: completedAt,
      providerTokensValidAfter: providerSecurityEpochIso(),
      finishProviderGlobalRevocation: {
        claimId,
        completed: providerRevocation.revoked,
        operation: claim.operation,
      },
    });
    if (!providerRevocation.revoked) {
      await this.auditProviderGlobalSignoutFailure(
        account,
        claim.operation,
        providerRevocation.errorCode,
        context,
      );
    }
    await this.auditSecurity({
      actor: account,
      action: "provider_global_signout_resumed",
      targetType: "account",
      targetId: account.id,
      metadata: {
        operation: claim.operation,
        providerSessionsRevoked: providerRevocation.revoked,
        revokedCount: containment.revokedSessions,
        revokedDiscountPasses: containment.revokedDiscountPasses,
      },
      context,
    });
    return {
      completed: providerRevocation.revoked,
      providerSessionsRevoked: providerRevocation.revoked,
      revokedCount: containment.revokedSessions,
      revokedDiscountPasses: containment.revokedDiscountPasses,
    };
  }

  private async revokeProviderSessionsGlobally(
    account: BusinessAccount,
    accessToken: string,
    verifiedProviderUserId?: string,
  ): Promise<{ revoked: boolean; errorCode: string | null }> {
    if (!this.supabase) {
      throw new AppError("Supabase authentication is not configured.", 503);
    }

    let providerUserId = verifiedProviderUserId;
    if (!providerUserId) {
      const { data, error } = await this.supabase.auth.getUser(accessToken);
      if (error || !data.user?.id || !data.user.email) {
        throw new AppError("A current sign-in provider session is required to log out every device.", 401);
      }
      providerUserId = data.user.id;
      if (
        providerUserId !== account.supabaseUserId ||
        normalizeEmail(data.user.email) !== normalizeEmail(account.email)
      ) {
        throw new AppError("The sign-in provider session does not belong to this account.", 403);
      }
    }

    if (providerUserId !== account.supabaseUserId) {
      throw new AppError("The sign-in provider session does not belong to this account.", 403);
    }

    let providerError: unknown = this.config.SUPABASE_SERVICE_ROLE_KEY
      ? null
      : { code: "provider_global_signout_not_configured" };
    if (!providerError) {
      try {
        const result = await this.supabase.auth.admin.signOut(accessToken, "global");
        providerError = result.error;
      } catch (error) {
        providerError = error;
      }
    }
    return providerError
      ? {
          revoked: false,
          errorCode: typeof providerError === "object" && providerError !== null && "code" in providerError &&
              typeof providerError.code === "string"
            ? providerError.code
            : null,
        }
      : { revoked: true, errorCode: null };
  }

  private async auditProviderGlobalSignoutFailure(
    account: BusinessAccount,
    operation: "password_reset" | "logout_all",
    errorCode: string | null,
    context?: SessionRequestContext | undefined,
  ): Promise<void> {
    await this.auditSecurity({
      actor: account,
      action: "provider_global_signout_failed",
      targetType: "account",
      targetId: account.id,
      metadata: { operation, appSessionsContained: true, errorCode },
      context,
    });
  }

  async confirmAge(account: BusinessAccount) {
    const confirmedAt = nowIso();
    const updated = await this.accountSessionRepository.updateAgeConfirmed(account.id, confirmedAt);
    await this.trackEvent(updated, {
      anonymousSessionId: null,
      eventType: "age_confirmed",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { source: "account" },
    });
    await this.recordUserActivity({
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

  async acceptLegal(account: BusinessAccount, input: LegalAcceptanceInput) {
    if (
      input.termsVersion !== CURRENT_LEGAL_POLICY_VERSION ||
      input.privacyVersion !== CURRENT_LEGAL_POLICY_VERSION
    ) {
      throw new AppError("Accept the current Terms and Privacy Policy before continuing.", 409, {
        currentVersion: CURRENT_LEGAL_POLICY_VERSION,
      });
    }
    const acceptedAt = nowIso();
    const updated = await this.accountSessionRepository.updateLegalAcceptance({
      userId: account.id,
      acceptedAt,
      termsVersion: input.termsVersion,
      privacyVersion: input.privacyVersion,
    });
    await this.recordUserActivity({
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

  async updateDisplayName(account: BusinessAccount, input: DisplayNameUpdateInput) {
    const displayName = validatePublicDisplayName(input.displayName);
    const displayNameKey = await this.assertDisplayNameAvailable(displayName, account.id);
    const updated = await this.accountSessionRepository.updateAccountDisplayName({
      userId: account.id,
      displayName,
      displayNameKey,
      now: nowIso(),
    });
    await this.recordUserActivity({
      account: updated,
      eventType: "display_name_updated",
      relatedEntityType: "account",
      relatedEntityId: updated.id,
      metadata: { hasDisplayName: Boolean(displayName) },
    });
    return {
      account: sanitizeAccount(updated),
      profile: await this.accountProfilePreferencesRepository.getProfileById(updated.id),
      message: displayName
        ? "Display name saved for the contributor leaderboard."
        : "Display name cleared. Your public account ID will show on the leaderboard.",
    };
  }

  private async createSessionResponse(
    account: BusinessAccount,
    context?: SessionRequestContext | undefined,
    providerSessionIdHash?: string | null,
    cookieSession?: {
      currentToken: string | null;
      providerTokenIssuedAt: string | null;
      credential: {
        purpose: BrowserCredentialSessionPurpose;
        credentialTimeSeconds: number;
      } | null;
      supabaseAccountMutation?: SupabaseAccountSessionMutation | null | undefined;
      onSupabaseAccountCommitted?: ((account: BusinessAccount) => void) | undefined;
    } | null,
  ) {
    const now = nowIso();
    const randomToken = crypto.randomBytes(32).toString("base64url");
    const token = cookieSession?.credential
      ? `${BROWSER_CREDENTIAL_SESSION_PREFIX}.${cookieSession.credential.purpose}.${cookieSession.credential.credentialTimeSeconds}.${randomToken}`
      : randomToken;
    const ttlDays = this.isAdmin(account)
      ? this.config.ADMIN_SESSION_TTL_DAYS
      : this.config.SESSION_TTL_DAYS;
    const requestHashes = this.getRequestHashes(context);

    const expiresAt = addDays(now, ttlDays);
    const tokenHash = hashToken(token);
    let responseAccount = account;
    if (cookieSession && providerSessionIdHash) {
      const suppliedCurrentTokenHash = cookieSession.currentToken
        ? hashToken(cookieSession.currentToken)
        : null;
      const mutationInput = {
          currentTokenHash: suppliedCurrentTokenHash,
          newTokenHash: tokenHash,
          userId: account.id,
          providerSessionIdHash,
          providerTokenIssuedAt: cookieSession.providerTokenIssuedAt,
          createdAt: now,
          expiresAt,
          lastUsedAt: now,
          lastIpHash: requestHashes.ipHash,
          userAgentHash: requestHashes.userAgentHash,
          maxActiveSessions: MAX_ACTIVE_SESSIONS_PER_ACCOUNT,
        };
      const result = cookieSession.supabaseAccountMutation
        ? await this.accountSessionRepository.rotateOrCreateSessionTokenWithSupabaseAccountMutation({
            ...mutationInput,
            supabaseAccountMutation: cookieSession.supabaseAccountMutation,
          })
        : await this.accountSessionRepository.rotateOrCreateSessionToken(mutationInput);
      const sessionConflict = typeof result === "string"
        ? result === "conflict"
        : result.status === "conflict";
      if (sessionConflict) {
        throw new AppError("The cookie session changed while authentication was completing. Sign in again and retry.", 409, {
          reauthenticationRequired: true,
          reauthPurpose: cookieSession.credential?.purpose === "session"
            ? null
            : cookieSession.credential?.purpose ?? null,
        });
      }
      if (typeof result !== "string" && result.status !== "conflict") {
        responseAccount = result.account;
        cookieSession.onSupabaseAccountCommitted?.(responseAccount);
      }
    } else {
      await this.accountSessionRepository.createSessionWithLimit({
        tokenHash,
        userId: account.id,
        createdAt: now,
        expiresAt,
        lastUsedAt: now,
        lastIpHash: requestHashes.ipHash,
        userAgentHash: requestHashes.userAgentHash,
        providerSessionIdHash: providerSessionIdHash ?? null,
        maxActiveSessions: MAX_ACTIVE_SESSIONS_PER_ACCOUNT,
      });
    }

    return {
      token,
      expiresAt,
      account: sanitizeAccount(responseAccount),
      access: this.getAccessState(responseAccount, null),
      counterStaffAssignments: await this.getCounterStaffAssignmentsForAccount(responseAccount.id),
    };
  }

  async getSessionExpiresAt(authorizationHeader: string | undefined): Promise<string | null> {
    const token = getBearerToken(authorizationHeader);
    return token ? this.accountSessionRepository.getSessionExpiresAt(hashToken(token), nowIso()) : null;
  }

  async getAuthSession(account: BusinessAccount | null) {
    return {
      authenticated: Boolean(account),
      account: account ? sanitizeAccount(account) : null,
      access: this.getAccessState(account, null),
      counterStaffAssignments: account ? await this.getCounterStaffAssignmentsForAccount(account.id) : [],
    };
  }

  private async getCounterStaffAssignmentsForAccount(accountId: string) {
    if (!this.config.COMMERCIAL_LAUNCH_ENABLED) {
      return [];
    }
    await this.expireVenueCounterStaffInvitations(nowIso());
    return (await this.collectVenueAssignments({
      userId: accountId,
      accessLevel: "counter_staff",
      status: "active",
    }))
      .map((assignment) => ({
        id: assignment.id,
        venueId: assignment.venueId,
        venueName: assignment.venueName,
        suburb: assignment.suburb,
        accessLevel: "counter_staff" as const,
        status: "active" as const,
        portalPath: `/venue-portal.html?venueId=${encodeURIComponent(assignment.venueId)}&tab=redemption`,
        capabilities: {
          openCounter: true,
          recordPintPointPurchases: this.config.PINT_POINTS_REWARDS_ENABLED,
          redeemFreePintRewards: this.config.PINT_POINTS_REWARDS_ENABLED,
          voidOwnRecentPurchases: this.config.PINT_POINTS_REWARDS_ENABLED,
          manageVenue: false,
          viewVenueAnalytics: false,
        },
      }));
  }

  async logout(authorizationHeader: string | undefined, context?: SessionRequestContext | undefined) {
    const token = getBearerToken(authorizationHeader);
    if (!token) {
      throw new AppError("Login required.", 401);
    }

    const account = await this.requireAccount(authorizationHeader, context);
    const now = nowIso();
    const tokenHash = hashToken(token);
    const { revoked, revokedDiscountPasses } = await this.accountSessionRepository.revokeSessionWithSummary({
      tokenHash,
      revokedAt: now,
    });
    await this.auditSecurity({
      actor: account,
      action: "logout",
      targetType: "account",
      targetId: account.id,
      metadata: { revoked, revokedDiscountPasses },
      context,
    });
    return { revoked, revokedDiscountPasses };
  }

  async logoutAll(
    account: BusinessAccount,
    input: LogoutAllInput = {},
    context?: SessionRequestContext | undefined,
  ) {
    const providerLinked = account.authProvider === "supabase" || Boolean(account.supabaseUserId);
    let verifiedProviderUserId: string | undefined;
    if (providerLinked) {
      if (!input.accessToken) {
        throw new AppError("A current sign-in provider session is required to log out every device.", 400);
      }
      if (!this.supabase) {
        throw new AppError("Supabase authentication is not configured.", 503);
      }
      const { data, error } = await this.supabase.auth.getUser(input.accessToken);
      if (error || !data.user?.id || !data.user.email) {
        throw new AppError("A current sign-in provider session is required to log out every device.", 401);
      }
      if (
        data.user.id !== account.supabaseUserId ||
        normalizeEmail(data.user.email) !== normalizeEmail(account.email)
      ) {
        throw new AppError("The sign-in provider session does not belong to this account.", 403);
      }
      verifiedProviderUserId = data.user.id;
    }
    const now = nowIso();
    const revocationClaimId = providerLinked ? providerGlobalRevocationClaimId() : null;
    let initialContainment;
    try {
      initialContainment = await this.accountSessionRepository.revokeUserSessionsWithSummary({
        userId: account.id,
        revokedAt: now,
        providerTokensValidAfter: providerLinked ? providerSecurityEpochIso() : null,
        ...(revocationClaimId ? {
          beginProviderGlobalRevocation: {
            claimId: revocationClaimId,
            operation: "logout_all" as const,
          },
        } : {}),
      });
    } catch (error) {
      if (
        error instanceof AccountSessionRepositoryError
        && error.code === "provider_global_revocation_pending"
      ) {
        throw new AppError(
          "Provider-wide sign-out is already being completed for this account. Wait a few minutes, then retry.",
          409,
          { publicCode: "PROVIDER_GLOBAL_REVOCATION_PENDING", reauthenticationRequired: true },
        );
      }
      throw error;
    }
    const providerRevocation = providerLinked
      ? await this.revokeProviderSessionsGlobally(
          account,
          input.accessToken!,
          verifiedProviderUserId,
        )
      : { revoked: true, errorCode: null };
    const postProviderCompletedAt = nowIso();
    const postProviderContainment = providerLinked
      ? await this.accountSessionRepository.revokeUserSessionsWithSummary({
          userId: account.id,
          revokedAt: postProviderCompletedAt,
          providerTokensValidAfter: providerSecurityEpochIso(),
          finishProviderGlobalRevocation: {
            claimId: revocationClaimId!,
            completed: providerRevocation.revoked,
            operation: "logout_all",
          },
        })
      : { revokedSessions: 0, revokedDiscountPasses: 0 };
    const revokedCount = initialContainment.revokedSessions + postProviderContainment.revokedSessions;
    const revokedDiscountPasses =
      initialContainment.revokedDiscountPasses + postProviderContainment.revokedDiscountPasses;
    if (!providerRevocation.revoked) {
      await this.auditProviderGlobalSignoutFailure(
        account,
        "logout_all",
        providerRevocation.errorCode,
        context,
      );
    }
    await this.auditSecurity({
      actor: account,
      action: "logout_all",
      targetType: "account",
      targetId: account.id,
      metadata: { revokedCount, revokedDiscountPasses, providerSessionsRevoked: providerRevocation.revoked },
      context,
    });
    return { revokedCount, revokedDiscountPasses, providerSessionsRevoked: providerRevocation.revoked };
  }

  async listAccountSessions(account: BusinessAccount, authorizationHeader?: string, query: AdminPaginationInput = { limit: 50, offset: 0 }) {
    const currentTokenHash = getBearerToken(authorizationHeader)
      ? hashToken(getBearerToken(authorizationHeader)!)
      : null;
    const timestamp = nowIso();
    const now = new Date(timestamp).getTime();
    const present = (session: AccountSession) => ({
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastUsedAt: session.lastUsedAt,
      active: !session.revokedAt && new Date(session.expiresAt).getTime() > now,
      revokedAt: session.revokedAt,
      current: currentTokenHash?.startsWith(session.id) ?? false,
      deviceFingerprint: session.userAgentHash?.slice(0, 12) ?? null,
      networkFingerprint: session.lastIpHash?.slice(0, 12) ?? null,
      providerBacked: session.providerBacked,
    });
    const historyLimit = Math.min(20, query.limit);
    const [currentRows, total, historyRows, historyTotal] = await Promise.all([
      this.accountSessionRepository.listUserSessions({ userId: account.id, now: timestamp, ...query }),
      this.accountSessionRepository.countUserSessions(account.id, timestamp),
      this.accountSessionRepository.listUserSessionHistory({
        userId: account.id,
        now: timestamp,
        limit: historyLimit,
        offset: 0,
      }),
      this.accountSessionRepository.countUserSessionHistory(account.id, timestamp),
    ]);
    const sessions = currentRows.map(present);
    const history = historyRows.map(present);
    return {
      sessions,
      total,
      history,
      historyTotal,
      pagination: { ...query, hasMore: query.offset + sessions.length < total },
      historyPagination: { limit: historyLimit, offset: 0, hasMore: history.length < historyTotal },
    };
  }

  async revokeAccountSession(
    actor: BusinessAccount,
    targetUserId: string,
    sessionId: string,
    context?: SessionRequestContext,
    reason?: string,
  ) {
    if (!/^[a-f0-9]{24}$/.test(sessionId)) {
      throw new AppError("Session not found.", 404);
    }
    if (actor.id !== targetUserId && !this.isAdmin(actor)) {
      throw new AppError("You cannot revoke another account's sessions.", 403);
    }
    if (actor.id !== targetUserId && (!reason || reason.trim().length < 4)) {
      throw new AppError("A reason is required to revoke another account's session.", 400);
    }
    const result = await this.accountSessionRepository.revokeUserSessionById({
      userId: targetUserId,
      sessionId,
      revokedAt: nowIso(),
    });
    if (!result.revoked) {
      throw new AppError("Session not found or already revoked.", 404);
    }
    await this.auditSecurity({
      actor,
      action: actor.id === targetUserId ? "session_revoked" : "admin_session_revoked",
      targetType: "account",
      targetId: targetUserId,
      metadata: { sessionId, revokedDiscountPasses: result.revokedDiscountPasses, reason: reason ?? null },
      context,
    });
    return result;
  }

  async listAdminAccountSessions(admin: BusinessAccount, userId: string, query: AdminPaginationInput = { limit: 50, offset: 0 }) {
    if (!this.isAdmin(admin)) throw new AppError("Admin access required.", 403);
    const account = await this.accountSessionRepository.getAccountById(userId);
    if (!account) throw new AppError("Account not found.", 404);
    return this.listAccountSessions(account, undefined, query);
  }

  async getAdminSecurityAuditLogs(
    admin: BusinessAccount,
    query: {
      limit?: number;
      offset?: number;
      cursor?: ActivityAuditCursor | null;
      action?: string | null;
      actorUserId?: string | null;
    },
  ) {
    if (!this.isAdmin(admin)) throw new AppError("Admin access required.", 403);
    const limit = Math.min(500, Math.max(1, query.limit ?? 100));
    const offset = Math.max(0, query.offset ?? 0);
    const filters = { action: query.action ?? null, actorUserId: query.actorUserId ?? null };
    const [page, total] = await Promise.all([
      this.activityAuditRepository.listSecurityAuditLogs({
        ...filters,
        limit,
        cursor: query.cursor ?? null,
      }),
      this.activityAuditRepository.countSecurityAuditLogs(filters),
    ]);
    return {
      logs: page.items,
      pagination: {
        total,
        limit,
        offset,
        hasMore: page.nextCursor !== null,
        nextCursor: page.nextCursor,
      },
    };
  }

  getAccessState(account: BusinessAccount | null, anonymousSessionId: string | null) {
    const isAdminAccount = Boolean(
      account && (account.role === "admin" || account.subscriptionStatus === "admin"),
    );
    const currentAdmin = account ? this.isAdmin(account) : false;
    const hasFullAccess = isFullAccess(account, currentAdmin);

    return {
      status: account?.subscriptionStatus ?? "free",
      isAuthenticated: Boolean(account),
      accountRole: account?.role ?? null,
      isAdminAccount,
      hasFullAccess,
      isAdmin: currentAdmin,
      ageConfirmed: Boolean(account?.ageConfirmedAt),
      priceAccessModel: hasFullAccess ? "full" : "fixed_preview",
      canViewAllPrices: hasFullAccess,
      canUseCheapestSort: hasFullAccess,
      canUseBeerSearch: hasFullAccess,
      canUseHappyHourActiveNow: false,
      canUseVerifiedOnly: hasFullAccess,
      canViewSpecialDiscounts: hasFullAccess && this.config.COMMERCIAL_LAUNCH_ENABLED,
      canUseDiscountPass: hasFullAccess && this.config.COMMERCIAL_LAUNCH_ENABLED,
      freePreviewScope: "Pint prices for Guinness, Carlton Draught, and Stone & Wood Pacific Ale.",
      premiumScope: this.config.COMMERCIAL_LAUNCH_ENABLED
        ? "Every verified beer price, value rings, premium filters, saved night shortcuts, discount-pass access, and venue special-discount details."
        : "Every verified beer price, value rings, full-map filters, and saved night shortcuts through earned contributor access.",
      premiumToolkit: buildConsumerPremiumToolkit({
        account,
        currentAdmin,
        consumerPaidEnrollmentEnabled: this.config.CONSUMER_PAID_ENROLLMENT_ENABLED,
        commercialLaunchEnabled: this.config.COMMERCIAL_LAUNCH_ENABLED,
        contributorUnlockPoints: this.config.CONTRIBUTOR_UNLOCK_POINTS,
      }),
      premiumUntil: account?.premiumUntil ?? null,
    };
  }

  async getLeaderboard(account: BusinessAccount | null, query: LeaderboardQuery) {
    const now = nowIso();
    const timezone = this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE;
    const monthKey = getZonedMonthKey(new Date(now), timezone);
    if (!this.config.COMMERCIAL_LAUNCH_ENABLED || !this.config.PINT_POINTS_REWARDS_ENABLED) {
      return this.getDisabledLeaderboard(query.period, monthKey);
    }
    const campaign = this.getOrCreateLeaderboardPrizeCampaign(monthKey, now);
    const entries = this.repository.listLeaderboard({ period: query.period, limit: query.limit, now, monthKey });
    const me = account ? this.repository.getLeaderboardRank({ userId: account.id, period: query.period, now, monthKey }) : null;
    const podium = entries.slice(0, 3).map((entry) => ({
      ...entry,
      prizeCents: prizeAmountForRank(campaign, entry.rank),
      prizeLabel: formatAudCents(prizeAmountForRank(campaign, entry.rank)),
    }));

    if (account) {
      await this.recordUserActivity({
        account,
        eventType: "leaderboard_viewed",
        relatedEntityType: "leaderboard",
        relatedEntityId: query.period,
        metadata: { period: query.period },
      });
    }

    return {
      disabled: false,
      period: query.period,
      monthKey,
      campaign: this.sanitizeLeaderboardPrizeCampaign(campaign),
      podium,
      entries,
      me,
      copy: "Leaderboard rankings count approved Pint Path contribution points only. Rejected, pending, and fraud-flagged updates do not count.",
    };
  }

  private getDisabledLeaderboard(period: LeaderboardQuery["period"], monthKey: string) {
    return {
      disabled: true,
      period,
      monthKey,
      campaign: null,
      podium: [],
      entries: [],
      me: null,
      copy: "Contributor leaderboards and prize campaigns are paused for this launch.",
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

  private sanitizeRewardVoucher(voucher: AccountRewardVoucher, includeAdminMetadata = false) {
    const effectiveStatus = voucher.status === "active"
      && voucher.expiresAt
      && Date.parse(voucher.expiresAt) <= Date.now()
      ? "expired"
      : voucher.status;
    const claimReference = typeof voucher.metadata.claimReference === "string"
      ? voucher.metadata.claimReference
      : null;
    const instructions = typeof voucher.metadata.fulfillmentInstructions === "string"
      ? voucher.metadata.fulfillmentInstructions
      : "Contact Pint Path support with the voucher reference so the reward can be verified and fulfilled.";
    return {
      id: voucher.id,
      publicAccountId: voucher.publicAccountId,
      sourceType: voucher.sourceType,
      sourceId: voucher.sourceId,
      title: voucher.title,
      amountCents: voucher.amountCents,
      amountDollars: Number((voucher.amountCents / 100).toFixed(2)),
      amountLabel: formatAudCents(voucher.amountCents),
      currency: voucher.currency,
      venueScope: voucher.venueScope,
      status: effectiveStatus,
      statusLabel: effectiveStatus === "active"
        ? "Ready to claim"
        : effectiveStatus === "redeemed"
          ? "Fulfilled"
          : effectiveStatus === "expired"
            ? "Expired"
            : "Void",
      issuedAt: voucher.issuedAt,
      expiresAt: voucher.expiresAt,
      fulfilledAt: voucher.redeemedAt,
      fulfillmentMethod: "manual_support",
      claimReference,
      instructions,
      ...(includeAdminMetadata ? {
        userId: voucher.userId,
        fulfillmentReason: typeof voucher.metadata.fulfillmentReason === "string"
          ? voucher.metadata.fulfillmentReason
          : null,
        fulfilledBy: typeof voucher.metadata.fulfilledBy === "string"
          ? voucher.metadata.fulfilledBy
          : null,
      } : {}),
    };
  }

  async getLeaderboardPrizeAdmin(_admin: BusinessAccount) {
    this.assertCommercialVenueFeatureOpen();
    const now = nowIso();
    const timezone = this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE;
    const monthKey = getZonedMonthKey(new Date(now), timezone);
    if (!this.config.PINT_POINTS_REWARDS_ENABLED) {
      return {
        disabled: true,
        campaign: null,
        awards: [],
        vouchers: [],
        leaderboard: this.getDisabledLeaderboard("month", monthKey),
        copy: "Contributor leaderboards and prize campaigns are paused for this launch.",
      };
    }
    const campaign = this.getOrCreateLeaderboardPrizeCampaign(monthKey, now);
    const leaderboard = await this.getLeaderboard(_admin, { period: "month", limit: 25 });
    const awards = this.repository.listLeaderboardPrizeAwards(campaign.monthKey);
    return {
      disabled: false,
      campaign: this.sanitizeLeaderboardPrizeCampaign(campaign),
      awards,
      vouchers: awards.flatMap((award) => {
        if (!award.voucherId) {
          return [];
        }
        const voucher = this.repository.getAccountRewardVoucherById(award.voucherId);
        return voucher ? [this.sanitizeRewardVoucher(voucher, true)] : [];
      }),
      leaderboard,
      copy: "Edit prize amounts before finalizing. Winners receive a 90-day manual-fulfillment claim reference; admins must verify support claims and mark each reward fulfilled or void.",
    };
  }

  async saveLeaderboardPrizeCampaign(admin: BusinessAccount, input: LeaderboardPrizeCampaignInput) {
    this.assertCommercialVenueFeatureOpen();
    this.requirePintPointsRewardsEnabled();
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
    await this.auditSecurity({
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
      leaderboard: await this.getLeaderboard(admin, { period: "month", limit: 25 }),
    };
  }

  async finalizeLeaderboardPrizeCampaign(admin: BusinessAccount, input: LeaderboardPrizeFinalizeInput) {
    this.assertCommercialVenueFeatureOpen();
    this.requirePintPointsRewardsEnabled();
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
      limit: 100,
      now,
      monthKey: campaign.monthKey,
    });
    const result = this.repository.finalizeLeaderboardPrizeCampaign({
      campaign,
      entries,
      finalizedBy: admin.id,
      now,
    });
    await this.auditSecurity({
      actor: admin,
      action: "leaderboard_prize_campaign_finalized",
      targetType: "leaderboard_prize_campaign",
      targetId: campaign.monthKey,
      metadata: { awardCount: result.awards.length, voucherCount: result.vouchers.length },
    });
    return {
      campaign: this.sanitizeLeaderboardPrizeCampaign(result.campaign),
      awards: result.awards,
      vouchers: result.vouchers.map((voucher) => this.sanitizeRewardVoucher(voucher, true)),
      message: `Finalized ${campaign.monthKey}. ${result.vouchers.length} voucher${result.vouchers.length === 1 ? "" : "s"} created.`,
    };
  }

  async transitionRewardVoucher(admin: BusinessAccount, voucherId: string, input: RewardVoucherTransitionInput) {
    this.assertCommercialVenueFeatureOpen();
    const now = nowIso();
    const result = this.repository.transitionAccountRewardVoucher({
      id: voucherId,
      action: input.action,
      actorUserId: admin.id,
      reason: input.reason,
      now,
    });
    if (!result) {
      throw new AppError("Reward voucher not found.", 404);
    }
    if (result.conflict) {
      throw new AppError(
        result.voucher.status === "expired"
          ? "This reward voucher has expired and cannot be fulfilled."
          : `This reward voucher is already ${result.voucher.status}.`,
        409,
      );
    }
    await this.auditSecurity({
      actor: admin,
      action: input.action === "fulfill" ? "reward_voucher_fulfilled" : "reward_voucher_voided",
      targetType: "account_reward_voucher",
      targetId: result.voucher.id,
      metadata: {
        userId: result.voucher.userId,
        amountCents: result.voucher.amountCents,
        reason: input.reason,
        idempotent: result.idempotent,
      },
    });
    return {
      voucher: this.sanitizeRewardVoucher(result.voucher),
      idempotent: result.idempotent,
      message: input.action === "fulfill"
        ? "Voucher marked fulfilled."
        : "Voucher voided.",
    };
  }

  async planPubGolf(account: BusinessAccount, input: PubGolfPlanInput) {
    this.assertCommercialVenueFeatureOpen();
    if (!this.config.ALCOHOL_GAMIFICATION_ENABLED) {
      throw new AppError(
        "Pub Golf is paused pending App Store and Victorian responsible-promotion approval.",
        503,
      );
    }
    if (!isFullAccess(account, this.isAdmin(account))) {
      throw new AppError("Pub Golf beta planning is for full-map accounts.", 403);
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

    await this.recordUserActivity({
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

    const missionArea = await this.resolveMissionAreaFromLocalCache(query);
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
    this.assertCommercialVenueFeatureOpen();
    this.requireCurrentLegalAcceptance(account);
    if (!isFullAccess(account, this.isAdmin(account))) {
      throw new AppError("Discount passes are for full-map accounts.", 403);
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
    redeemUrl.hash = new URLSearchParams({
      discountCode: code,
      accountId: account.publicAccountId,
      tab: "redemption",
    }).toString();
    const qrDataUrl = await QRCode.toDataURL(redeemUrl.toString(), {
      margin: 1,
      width: 240,
    });

    await this.recordUserActivity({
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

  private async getDiscountVenueIdentity(
    venueId: string,
    assignment?: { venueName?: string | null; suburb?: string | null } | null,
    requireKnownVenue = false,
  ) {
    const profile = await this.venueInventoryRepository.getBarProfile(venueId);
    const location = await this.venueIdentityRepository.getVenueLocationCache(venueId);
    const activeAssignment = assignment
      ? null
      : (await this.venueAccessRepository.listVenueAssignments({
          venueId,
          status: "active",
          limit: 1,
        })).assignments[0] ?? null;

    if (requireKnownVenue && !profile && !location && !assignment && !activeAssignment) {
      throw new AppError("Venue is not configured for Pint Path POS redemptions.", 404);
    }

    return {
      venueName: assignment?.venueName ?? profile?.name ?? location?.venueName ?? activeAssignment?.venueName ?? venueId,
      suburb: assignment?.suburb ?? profile?.suburb ?? location?.suburb ?? activeAssignment?.suburb ?? null,
    };
  }

  private isBarSpecialActiveNow(special: BarSpecial, now: Date): boolean {
    if (!special.active) return false;
    const time = now.getTime();
    if (special.startsAt && Date.parse(special.startsAt) > time) return false;
    if (special.endsAt && Date.parse(special.endsAt) <= time) return false;
    if (!special.startTime || !special.endTime) return true;

    const timezone = special.recurrence.timezone || this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE;
    if (special.recurrence.frequency === "weekly") {
      const weekday = new Intl.DateTimeFormat("en-AU", { timeZone: timezone, weekday: "short" })
        .format(now)
        .slice(0, 3)
        .toLowerCase();
      if (!special.recurrence.daysOfWeek.includes(weekday)) return false;
    }
    const parts = new Intl.DateTimeFormat("en-AU", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
    const current = hour * 60 + minute;
    const toMinutes = (value: string) => {
      const [hours = "0", minutes = "0"] = value.split(":");
      return Number(hours) * 60 + Number(minutes);
    };
    const start = toMinutes(special.startTime);
    const end = toMinutes(special.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
    return start < end ? current >= start && current < end : current >= start || current < end;
  }

  private async redeemDiscountPassForVenue(input: {
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
    const profile = await this.venueInventoryRepository.getBarProfile(input.venueId);
    if (!profile?.acceptsPintPathCodes) {
      throw new AppError("This venue is not currently enabled to accept Pint Path codes.", 403);
    }
    const normalizedTerminalId = String(input.terminalId ?? "default")
      .trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80) || "default";
    const posReference = String(input.posReference ?? "").trim();
    const idempotencyKey = input.source === "pos_webhook"
      ? `pos:v2:${crypto.createHash("sha256").update(`${normalizedTerminalId}\0${posReference}`).digest("hex").slice(0, 40)}`
      : `pass:${hashDiscountCode(input.code)}`;
    const codeHash = hashDiscountCode(input.code);
    const anyPass = this.repository.getDiscountPassByCodeHash(codeHash);
    let existingRedemption = this.repository.getDiscountRedemptionByIdempotencyKey({
      venueId: input.venueId,
      idempotencyKey,
    });
    if (!existingRedemption && input.source === "pos_webhook") {
      const legacy = this.repository.getDiscountRedemptionByIdempotencyKey({
        venueId: input.venueId,
        idempotencyKey: `pos:${posReference}`,
      });
      const legacyTerminal = typeof legacy?.metadata.terminalId === "string"
        ? legacy.metadata.terminalId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80) || "default"
        : "default";
      if (legacy && legacyTerminal === normalizedTerminalId) existingRedemption = legacy;
    }
    if (existingRedemption) {
      if (!anyPass || existingRedemption.discountPassId !== anyPass.id) {
        throw new AppError("That transaction reference is already attached to a different discount pass.", 409);
      }
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
    const priorPassRedemption = anyPass ? this.repository.getDiscountRedemptionByPassId(anyPass.id) : null;
    if (priorPassRedemption) {
      if (priorPassRedemption.venueId !== input.venueId) {
        throw new AppError("This one-time discount code was already used at another venue.", 409);
      }
      return {
        redemption: priorPassRedemption,
        accountId: priorPassRedemption.publicAccountId,
        venueId: priorPassRedemption.venueId,
        venueName: priorPassRedemption.venueName,
        suburb: priorPassRedemption.suburb,
        estimatedSavingsDollars: Number((priorPassRedemption.estimatedSavingsCents / 100).toFixed(2)),
        pointsEarned: 0,
        idempotentReplay: true,
        copy: "This one-time discount was already recorded. No duplicate saving or Pint Points were added.",
      };
    }
    const pass = this.repository.getActiveDiscountPassByCodeHash({
      codeHash,
      now,
    });

    if (!pass) {
      throw new AppError("Discount code expired or not found. Ask the user to refresh their Pint Path discount pass.", 404);
    }

    const user = await this.accountSessionRepository.getAccountById(pass.userId);
    if (!user || !isFullAccess(user, this.isAdmin(user))) {
      throw new AppError("This account does not currently have discount access.", 403);
    }

    let specialId: string | null = null;
    let itemName = input.itemName;
    let estimatedSavingsCents = 0;
    if (input.specialId) {
      const special = await this.venueInventoryRepository.getBarSpecialById(input.specialId);
      if (!special || special.barId !== input.venueId) {
        throw new AppError("Choose an active Pint Path special from this venue.", 400);
      }
      if (!this.isBarSpecialActiveNow(special, new Date(now))) {
        throw new AppError("That Pint Path special is not active right now.", 409);
      }
      specialId = special.id;
      itemName = special.title;
      estimatedSavingsCents = Math.max(0, special.savingsAmountCents ?? 0) * input.quantity;
    }
    const redemption = this.repository.runInTransaction(() => {
      if (!this.repository.markDiscountPassUsed({ id: pass.id, lastUsedAt: now })) {
        throw new AppError("This one-time discount code was already used or expired.", 409);
      }
      const redemption = this.repository.createDiscountRedemption({
        id: crypto.randomUUID(),
        userId: user.id,
        publicAccountId: user.publicAccountId,
        venueId: input.venueId,
        venueName: input.venueName,
        suburb: input.suburb,
        specialId,
        itemName,
        quantity: input.quantity,
        estimatedSavingsCents,
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
          clientEstimatedSavingsCents: input.estimatedSavingsCents,
          pointsEarned: 0,
        })),
      });
      return redemption;
    });
    await this.recordUserActivity({
      account: user,
      eventType: "discount_redeemed",
      relatedEntityType: "venue",
      relatedEntityId: input.venueId,
      metadata: {
        venueName: input.venueName,
        suburb: input.suburb,
        itemName,
        quantity: input.quantity,
        estimatedSavingsCents,
        source: input.source,
      },
    });
    await this.auditSecurity({
      actor: input.actor,
      action: "discount_redeemed",
      targetType: "venue",
      targetId: input.venueId,
      metadata: {
        publicAccountId: user.publicAccountId,
        itemName,
        quantity: input.quantity,
        estimatedSavingsCents,
        pointsEarned: 0,
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
      pointsEarned: 0,
      copy: "Discount redemption logged. Record the verified alcoholic purchase separately to award Pint Points.",
    };
  }

  async redeemDiscountPass(account: BusinessAccount, venueId: string, input: DiscountRedemptionInput) {
    this.assertCommercialVenueFeatureOpen();
    const assignment = await this.requireAssignedVenue(account, venueId, "counter");
    const venue = await this.getDiscountVenueIdentity(venueId, assignment);
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

  async getVenuePosIntegration(account: BusinessAccount, venueId: string) {
    this.assertCommercialVenueFeatureOpen();
    const assignment = await this.requireAssignedVenue(account, venueId);
    const venue = await this.getDiscountVenueIdentity(venueId, assignment);
    const endpoint = new URL("/api/business/pos/discount-redemptions", this.config.PUBLIC_BASE_URL).toString();
    const profile = await this.venueInventoryRepository.getBarProfile(venueId);
    const membershipTier = profile?.membershipTier ?? "basic";
    const tierCapabilities = getBarTierCapabilities(membershipTier);
    const tokenVersion = profile?.posWebhookTokenVersion ?? 1;
    const token = this.config.POS_WEBHOOK_SIGNING_SECRET && tierCapabilities.posWebhookIntegration
      ? createPosWebhookToken(this.config.POS_WEBHOOK_SIGNING_SECRET, venueId, tokenVersion)
      : null;
    const lastSuccessAt = profile?.posLastSuccessAt ?? null;
    const lastSuccessAgeMs = lastSuccessAt ? Date.now() - Date.parse(lastSuccessAt) : Number.POSITIVE_INFINITY;
    const health = !token
      ? "disabled"
      : !lastSuccessAt
        ? "not_tested"
        : lastSuccessAgeMs <= 30 * 24 * 60 * 60 * 1000
          ? "healthy"
          : "stale";

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
      tokenPreview: token ? `${token.slice(0, 8)}...${token.slice(-8)}` : null,
      tokenVersion,
      tokenAvailableOnlyOnRotation: true,
      previousTokenValidUntil: profile?.posPreviousTokenValidUntil ?? null,
      lastSuccessfulWebhookAt: lastSuccessAt,
      lastTerminalId: profile?.posLastTerminalId ?? null,
      health,
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
          ? "POS webhook is configured. Rotate the token to reveal a new secret once; existing secrets are never returned by normal portal reads."
          : "POS webhooks are disabled until POS_WEBHOOK_SIGNING_SECRET is configured on the server. Manual staff redemption still works."
        : "POS webhook automation is a Pro venue feature. Staff can still redeem codes manually from the portal.",
    };
  }

  async rotateVenuePosIntegrationToken(account: BusinessAccount, venueId: string) {
    this.assertCommercialVenueFeatureOpen();
    await this.requireAssignedVenue(account, venueId);
    const profile = await this.venueInventoryRepository.getBarProfile(venueId);
    if (!profile) {
      throw new AppError("Venue profile not found.", 404);
    }
    const now = nowIso();
    const updated = this.repository.rotateBarPosWebhookToken({
      barId: venueId,
      now,
      previousValidUntil: addMinutes(now, 10),
    });
    await this.auditSecurity({
      actor: account,
      action: "venue_pos_token_rotated",
      targetType: "venue",
      targetId: venueId,
      metadata: { previousVersion: profile.posWebhookTokenVersion },
    });
    const status = await this.getVenuePosIntegration(account, venueId);
    const token = this.config.POS_WEBHOOK_SIGNING_SECRET
      ? createPosWebhookToken(this.config.POS_WEBHOOK_SIGNING_SECRET, venueId, updated.posWebhookTokenVersion)
      : null;
    return {
      ...status,
      token,
      revealedOnce: Boolean(token),
      previousTokenValidUntil: updated.posPreviousTokenValidUntil,
    };
  }

  async redeemDiscountPassFromPos(
    input: PosDiscountRedemptionInput,
    token: string | undefined,
    context?: SessionRequestContext | undefined,
  ) {
    this.assertCommercialVenueFeatureOpen();
    const secret = this.config.POS_WEBHOOK_SIGNING_SECRET;
    if (!secret) {
      throw new AppError("Pint Path POS webhooks are not configured yet.", 503);
    }

    const suppliedToken = token?.trim() ?? "";
    const profile = await this.venueInventoryRepository.getBarProfile(input.venueId);
    const expectedToken = createPosWebhookToken(secret, input.venueId, profile?.posWebhookTokenVersion ?? 1);
    const previousToken = profile?.posPreviousTokenVersion && profile.posPreviousTokenValidUntil && Date.parse(profile.posPreviousTokenValidUntil) > Date.now()
      ? createPosWebhookToken(secret, input.venueId, profile.posPreviousTokenVersion)
      : null;
    const tokenValid = Boolean(suppliedToken) && (
      timingSafeStringEqual(expectedToken, suppliedToken) ||
      Boolean(previousToken && timingSafeStringEqual(previousToken, suppliedToken))
    );
    if (!tokenValid) {
      await this.auditSecurity({
        actor: null,
        action: "pos_discount_redeem_blocked",
        targetType: "venue",
        targetId: input.venueId,
        metadata: { reason: "invalid_pos_token" },
        context,
      });
      throw new AppError("Invalid POS webhook token.", 401);
    }

    const venue = await this.getDiscountVenueIdentity(input.venueId, null, true);
    const membershipTier = profile?.membershipTier ?? "basic";
    const capabilities = getBarTierCapabilities(membershipTier);
    if (!capabilities.posWebhookIntegration) {
      throw new AppError("Pro venue tier required for POS webhook redemptions.", 403);
    }

    const result = await this.redeemDiscountPassForVenue({
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
    this.repository.recordBarPosWebhookSuccess({
      barId: input.venueId,
      terminalId: input.terminalId ?? null,
      now: nowIso(),
    });
    return result;
  }

  private expirePintPointRewardCodesForAccount(accountId: string, now = nowIso()) {
    this.repository.expireFreePintRewardCodesForUser({ userId: accountId, now });
  }

  private requirePintPointsRewardsEnabled(): void {
    if (!this.config.PINT_POINTS_REWARDS_ENABLED) {
      throw new AppError(
        "Pint Points and Free Pint Rewards are paused while the launch promotion completes legal and venue approval.",
        503,
      );
    }
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

  private getPintPointCheckoutSigningSecret(): string {
    const configuredSecret = this.config.SOURCE_EVIDENCE_SIGNING_SECRET;
    if (!configuredSecret && this.config.NODE_ENV === "production") {
      throw new AppError("Pint Points checkout authorization is not configured.", 503);
    }
    return crypto
      .createHash("sha256")
      .update(`pint-point-checkout:v1:${configuredSecret ?? this.config.PUBLIC_BASE_URL}`)
      .digest("hex");
  }

  private createPintPointCheckoutToken(claims: PintPointCheckoutClaims): string {
    return signPintPointCheckoutClaims(this.getPintPointCheckoutSigningSecret(), claims);
  }

  private async verifyPintPointCheckoutToken(input: {
    token: string;
    venueId: string;
    authorizedByUserId: string;
    transactionReference: string;
    now: string;
    allowExpired?: boolean;
  }): Promise<BusinessAccount> {
    const [payload, signature, extra] = input.token.split(".");
    if (!payload || !signature || extra) {
      throw new AppError("Member checkout authorization is invalid. Check the member code again.", 401);
    }
    const expectedSignature = crypto
      .createHmac("sha256", this.getPintPointCheckoutSigningSecret())
      .update(payload)
      .digest("base64url");
    if (!timingSafeStringEqual(expectedSignature, signature)) {
      throw new AppError("Member checkout authorization is invalid. Check the member code again.", 401);
    }

    let claims: PintPointCheckoutClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PintPointCheckoutClaims;
    } catch {
      throw new AppError("Member checkout authorization is invalid. Check the member code again.", 401);
    }
    if (
      claims.version !== 1 ||
      typeof claims.userId !== "string" ||
      claims.venueId !== input.venueId ||
      claims.authorizedByUserId !== input.authorizedByUserId ||
      claims.transactionReference !== normalizePintPointTransactionReference(input.transactionReference) ||
      !Number.isFinite(Date.parse(claims.expiresAt))
    ) {
      throw new AppError("Member checkout authorization does not match this purchase. Check the member code again.", 401);
    }
    if (!input.allowExpired && Date.parse(claims.expiresAt) <= Date.parse(input.now)) {
      throw new AppError("Member checkout authorization expired. Check the member code again.", 410);
    }
    const user = await this.accountSessionRepository.getAccountById(claims.userId);
    if (!user) {
      throw new AppError("Pint Path account not found.", 404);
    }
    return user;
  }

  private async resolvePintPointUser(input: {
    code?: string | undefined;
    checkoutToken?: string | undefined;
    account: BusinessAccount;
    venueId: string;
    transactionReference: string;
    now: string;
    allowExpiredCheckoutToken?: boolean;
  }) {
    if (input.code) {
      const pass = this.repository.getActiveDiscountPassByCodeHash({
        codeHash: hashDiscountCode(input.code),
        now: input.now,
      });
      if (!pass) {
        throw new AppError("Pint Path code expired or not found. Ask the user to refresh their code.", 404);
      }
      const user = await this.accountSessionRepository.getAccountById(pass.userId);
      if (!user) {
        throw new AppError("Pint Path account not found.", 404);
      }
      return user;
    }

    if (input.checkoutToken) {
      return this.verifyPintPointCheckoutToken({
        token: input.checkoutToken,
        venueId: input.venueId,
        authorizedByUserId: input.account.id,
        transactionReference: input.transactionReference,
        now: input.now,
        ...(input.allowExpiredCheckoutToken === undefined
          ? {}
          : { allowExpired: input.allowExpiredCheckoutToken }),
      });
    }

    throw new AppError("Check the member code before recording this purchase.", 400);
  }

  async previewPintPointMember(account: BusinessAccount, venueId: string, input: PintPointMemberPreviewInput) {
    this.assertCommercialVenueFeatureOpen();
    this.requirePintPointsRewardsEnabled();
    const assignment = await this.requireAssignedVenue(account, venueId, "counter");
    const venue = await this.getDiscountVenueIdentity(venueId, assignment);
    const profile = await this.venueInventoryRepository.getBarProfile(venueId);
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
    const user = await this.accountSessionRepository.getAccountById(pass.userId);
    if (!user || !isFullAccess(user, this.isAdmin(user))) {
      throw new AppError("This Pint Path account cannot receive Pint Points right now.", 403);
    }

    const dayRange = getZonedDayRangeIso(new Date(now), this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE);
    const pointsToday = this.repository.countPintPointsAwardedSince({ userId: user.id, since: dayRange.startIso });
    const wallet = this.getPintPointWalletForAccount(user, now);
    const authorizationExpiresAt = addMinutes(now, PINT_POINT_CHECKOUT_AUTHORIZATION_MINUTES);
    const checkoutToken = this.createPintPointCheckoutToken({
      version: 1,
      userId: user.id,
      venueId,
      authorizedByUserId: account.id,
      transactionReference: normalizePintPointTransactionReference(input.transactionReference),
      expiresAt: authorizationExpiresAt,
    });

    return {
      accountId: user.publicAccountId,
      eligible: true,
      expiresAt: pass.expiresAt,
      checkoutToken,
      authorizationExpiresAt,
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
    this.assertCommercialVenueFeatureOpen();
    this.requirePintPointsRewardsEnabled();
    this.requireCurrentLegalAcceptance(account);
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
        if (error instanceof Error && error.message === "INSUFFICIENT_PINT_POINTS") {
          throw new AppError(`${FREE_PINT_REWARD_POINTS} available Pint Points are required for a Free Pint Reward.`, 409);
        }
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
    const redemptionParams = new URLSearchParams({
      freePintCode: code,
      accountId: account.publicAccountId,
      tab: "redemption",
    });
    if (input.venueId) {
      redemptionParams.set("venueId", input.venueId);
    }
    redeemUrl.hash = redemptionParams.toString();

    const qrDataUrl = await QRCode.toDataURL(redeemUrl.toString(), {
      margin: 1,
      width: 240,
    });

    await this.recordUserActivity({
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

  async recordPintPointDrink(account: BusinessAccount, venueId: string, input: PintPointDrinkRecordInput) {
    this.assertCommercialVenueFeatureOpen();
    this.requirePintPointsRewardsEnabled();
    const assignment = await this.requireAssignedVenue(account, venueId, "counter");
    const venue = await this.getDiscountVenueIdentity(venueId, assignment);
    const profile = await this.venueInventoryRepository.getBarProfile(venueId);
    if (!profile?.acceptsPintPathCodes) {
      throw new AppError("This venue is not currently enabled to accept Pint Path codes.", 403);
    }
    const now = nowIso();
    const idempotencyKey = `manual:${normalizePintPointTransactionReference(input.transactionReference)}`;
    const existingRecord = this.repository.getPintPointDrinkRecordByIdempotencyKey({ venueId, idempotencyKey });
    const user = await this.resolvePintPointUser({
      code: input.code,
      checkoutToken: input.checkoutToken,
      account,
      venueId,
      transactionReference: input.transactionReference,
      now,
      allowExpiredCheckoutToken: Boolean(existingRecord && input.checkoutToken),
    });

    if (!isFullAccess(user, this.isAdmin(user))) {
      throw new AppError("This Pint Path account cannot receive Pint Points right now.", 403);
    }

    const isAlcoholic = input.beverageCategory === "alcoholic";
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
      const voided = existingRecord.status === "void";
      return {
        record: sanitizeVenuePintPointDrinkRecord(existingRecord),
        accountId: user.publicAccountId,
        pointsEarned: voided ? 0 : existingRecord.pointsAwarded,
        wallet,
        idempotentReplay: true,
        voided,
        copy: voided
          ? "This receipt was recorded earlier and has since been voided. No Pint Points were added."
          : "Already recorded. No duplicate Pint Points were added.",
        progressCopy: `You now have ${wallet.available} / ${FREE_PINT_REWARD_POINTS} Pint Points.`,
        rewardCopy: wallet.pointsUntilReward === 0
          ? "You have enough Pint Points for a Free Pint Reward."
          : `${wallet.pointsUntilReward} Pint Point${wallet.pointsUntilReward === 1 ? "" : "s"} until your Free Pint Reward.`,
      };
    }
    const today = getZonedDayRangeIso(new Date(now), this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE);
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
      pointsAwarded: isAlcoholic ? input.quantity : 0,
      dailyCap: PINT_POINTS_DAILY_CAP,
      dailySince: today.startIso,
      source: "venue_portal",
      recordedByUserId: account.id,
      idempotencyKey,
      recordedAt: now,
      metadata: {
        notes: input.notes,
        enteredByRole: account.role,
      },
    });
    const pointsEarned = record.pointsAwarded;

    const wallet = this.getPintPointWalletForAccount(user, now);
    await this.recordUserActivity({
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
    await this.auditSecurity({
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
      voided: false,
      copy: pointsEarned > 0
        ? `Nice — you earned ${pointsEarned} Pint Point${pointsEarned === 1 ? "" : "s"}.`
        : "Recorded. Food and non-alcoholic drinks do not earn Pint Points.",
      progressCopy: `You now have ${wallet.available} / ${FREE_PINT_REWARD_POINTS} Pint Points.`,
      rewardCopy: wallet.pointsUntilReward === 0
        ? "You have enough Pint Points for a Free Pint Reward."
        : `${wallet.pointsUntilReward} Pint Point${wallet.pointsUntilReward === 1 ? "" : "s"} until your Free Pint Reward.`,
    };
  }

  async voidPintPointDrink(
    account: BusinessAccount,
    venueId: string,
    recordId: string,
    input: PintPointDrinkVoidInput,
  ) {
    this.assertCommercialVenueFeatureOpen();
    this.requirePintPointsRewardsEnabled();
    const assignment = await this.requireAssignedVenue(account, venueId, "counter");
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

    const member = await this.accountSessionRepository.getAccountById(result.record.userId);
    const wallet = member ? this.getPintPointWalletForAccount(member, now) : null;
    if (!result.idempotentReplay) {
      if (member) {
        await this.recordUserActivity({
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
      await this.auditSecurity({
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

  async handleFreePintRewardCode(account: BusinessAccount, venueId: string, input: FreePintRewardDecisionInput) {
    this.assertCommercialVenueFeatureOpen();
    this.requirePintPointsRewardsEnabled();
    const assignment = await this.requireAssignedVenue(account, venueId, "counter");
    const venue = await this.getDiscountVenueIdentity(venueId, assignment);
    const profile = await this.venueInventoryRepository.getBarProfile(venueId);
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

    const user = await this.accountSessionRepository.getAccountById(code.userId);
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

    await this.recordUserActivity({
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
    await this.auditSecurity({
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

  async getAccountDashboard(account: BusinessAccount) {
    const dashboardNow = nowIso();
    const commercialLaunchEnabled = this.config.COMMERCIAL_LAUNCH_ENABLED;
    if (commercialLaunchEnabled) {
      await this.expireVenueCounterStaffInvitations(dashboardNow);
    }
    const [preferences, storedPrivacySettings, savedItems, profile, recentSearches] = await Promise.all([
      this.accountProfilePreferencesRepository.getAccountPreferences(account.id),
      this.accountProfilePreferencesRepository.getAccountPrivacySettings(account.id),
      this.accountProfilePreferencesRepository.listSavedItems(account.id),
      this.accountProfilePreferencesRepository.getProfileById(account.id),
      this.accountProfilePreferencesRepository.listRecentSearches(account.id, 10),
    ]);
    const privacySettings = storedPrivacySettings ??
      await this.accountProfilePreferencesRepository.getDefaultAccountPrivacySettings(account.id, dashboardNow);
    const savedSuburbs = savedItems
      .filter((item) => item.itemType === "suburb")
      .map((item) => item.label);
    const suggestedSuburb = savedSuburbs[0] ?? preferences?.preferredSuburbs[0];
    const suggestedMissions = await this.listMissions({ suburb: suggestedSuburb, sort: "saved", limit: 6 }, account);
    const latestAgeVerification = await this.accountSessionRepository.getLatestAgeVerification(account.id);
    const submissionHistoryLimit = 12;
    const rawSubmissionRecords = await this.communitySubmissionRepository.listSubmissions({
      userId: account.id,
      limit: submissionHistoryLimit,
      offset: 0,
    });
    const submissionHistory = rawSubmissionRecords.map(({ submission, items }) => {
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
        items: items.map((item) => ({
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
    const recentSubmissions = submissionHistory;
    const [totalSubmissionCount, pendingCount, needsMoreInfoCount, verifiedCount, ...rejectedCounts] = await Promise.all([
      this.communitySubmissionRepository.countSubmissions({ userId: account.id }),
      this.communitySubmissionRepository.countSubmissions({ userId: account.id, status: "pending" }),
      this.communitySubmissionRepository.countSubmissions({ userId: account.id, status: "needs_more_evidence" }),
      this.communitySubmissionRepository.countSubmissions({ userId: account.id, status: "approved" }),
      ...(["rejected", "disputed", "fraud_flagged"] as const).map((status) =>
        this.communitySubmissionRepository.countSubmissions({ userId: account.id, status })),
    ]);
    const rejectedCount = rejectedCounts.reduce((total, count) => total + count, 0);
    const timezone = this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE;
    const monthKey = getZonedMonthKey(new Date(dashboardNow), timezone);
    const currentMonthPoints = await this.communitySubmissionRepository.getContributionPointsForMonth(account.id, monthKey);
    const dashboardAccount = currentMonthPoints === account.contributionPointsCurrentMonth
      ? account
      : { ...account, contributionPointsCurrentMonth: currentMonthPoints };
    const leaderboardEnabled = commercialLaunchEnabled && this.config.PINT_POINTS_REWARDS_ENABLED;
    const campaign = leaderboardEnabled
      ? this.getOrCreateLeaderboardPrizeCampaign(monthKey, dashboardNow)
      : null;
    const leaderboardRank = leaderboardEnabled
      ? this.repository.getLeaderboardRank({ userId: account.id, period: "month", now: dashboardNow, monthKey })
      : null;
    const leaderboardEntries = leaderboardEnabled
      ? this.repository.listLeaderboard({ period: "month", limit: 50, now: dashboardNow, monthKey })
      : [];
    const leaderboardPodium = campaign
      ? leaderboardEntries.slice(0, 3).map((entry) => ({
          ...entry,
          prizeCents: prizeAmountForRank(campaign, entry.rank),
          prizeLabel: formatAudCents(prizeAmountForRank(campaign, entry.rank)),
        }))
      : [];
    const disabledLeaderboard = this.getDisabledLeaderboard("month", monthKey);
    const discountStats = commercialLaunchEnabled
      ? this.repository.getDiscountRedemptionStats(account.id)
      : { totalRedemptions: 0, estimatedSavingsCents: 0, uniqueVenues: 0 };
    const recentDiscountRedemptions = commercialLaunchEnabled
      ? this.repository.listDiscountRedemptionsForUser(account.id, 10)
      : [];
    const rewardVouchers = commercialLaunchEnabled
      ? this.repository.listAccountRewardVouchers(account.id, 10)
      : [];
    const pintPointsWallet = commercialLaunchEnabled && this.config.PINT_POINTS_REWARDS_ENABLED
      ? this.getPintPointWalletForAccount(account, dashboardNow)
      : null;
    const counterStaffAssignmentRows = commercialLaunchEnabled
      ? await this.collectVenueAssignments({
          userId: account.id,
          accessLevel: "counter_staff",
          currentOnly: true,
        })
      : [];
    const counterStaffInvitations = counterStaffAssignmentRows
      .filter((assignment) => assignment.accessLevel === "counter_staff" && assignment.status === "pending")
      .map((assignment) => ({
        id: assignment.id,
        venueId: assignment.venueId,
        venueName: assignment.venueName,
        suburb: assignment.suburb,
        invitedAt: assignment.updatedAt,
        expiresAt: assignment.expiresAt,
      }));
    const counterStaffAssignments = await this.getCounterStaffAssignmentsForAccount(account.id);
    const currentAdmin = this.isAdmin(dashboardAccount);
    const hasFullAccess = isFullAccess(dashboardAccount, currentAdmin);
    const missionHistoryPage = await this.missionLifecycleRepository.listMissionProgressForUser({
      userId: account.id,
      limit: 12,
    });
    const missionHistory = await Promise.all(missionHistoryPage.progress.map(async (progress) => {
      const mission = await this.missionLifecycleRepository.getMissionById(progress.missionId);
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
    }));
    const savedUpdates = await this.getSavedUpdatesFeed(account, savedItems, dashboardNow);

    return {
      account: sanitizeAccount(dashboardAccount),
      billing: commercialLaunchEnabled
        ? {
            mode: this.config.DEMO_BILLING_MODE
              ? "demo"
              : dashboardAccount.stripeCustomerId
                ? "stripe"
                : "unlinked",
            managementAvailable: this.config.DEMO_BILLING_MODE || Boolean(dashboardAccount.stripeCustomerId),
          }
        : null,
      profile,
      access: this.getAccessState(account, null),
      submissions: submissionHistory,
      submissionHistory,
      recentSubmissions,
      submissionPagination: {
        total: totalSubmissionCount,
        limit: submissionHistoryLimit,
        offset: 0,
        hasMore: submissionHistory.length < totalSubmissionCount,
      },
      dashboardStats: {
        totalUploads: totalSubmissionCount,
        pendingCount,
        pendingVerificationCount: pendingCount + needsMoreInfoCount,
        needsMoreInfoCount,
        verifiedCount,
        rejectedCount,
        fraudStrikes: account.fraudStrikeCount,
        pointsThisMonth: currentMonthPoints,
        trustScore: account.trustScore,
      },
      verifications: await this.communitySubmissionRepository.listVerificationsForUser({
        verifierUserId: account.id,
        limit: 100,
      }),
      activity: (await this.activityAuditRepository.listUserActivityEvents({
        userId: account.id,
        limit: 25,
      })).items,
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
      savedUpdates,
      recentSearches,
      suggestedMissions,
      missionHistory,
      premiumMemberToolkit: buildConsumerPremiumToolkit({
        account: dashboardAccount,
        currentAdmin,
        consumerPaidEnrollmentEnabled: this.config.CONSUMER_PAID_ENROLLMENT_ENABLED,
        commercialLaunchEnabled: this.config.COMMERCIAL_LAUNCH_ENABLED,
        contributorUnlockPoints: this.config.CONTRIBUTOR_UNLOCK_POINTS,
        savedItems,
        preferences,
        discountStats,
      }),
      contributorProgress: {
        pointsThisMonth: roundPoints(currentMonthPoints),
        unlockThreshold: this.config.CONTRIBUTOR_UNLOCK_POINTS,
        pointsNeeded: roundPoints(Math.max(0, this.config.CONTRIBUTOR_UNLOCK_POINTS - currentMonthPoints)),
        unlockCopy: commercialLaunchEnabled
          ? "Earn 15 approved points in a month to unlock premium until the end of that month."
          : "Earn 15 approved points in a month to unlock full-map access until the end of that month.",
      },
      leaderboard: leaderboardEnabled && campaign
        ? {
            disabled: false,
            accountId: account.publicAccountId,
            monthRank: leaderboardRank,
            monthKey,
            campaign: this.sanitizeLeaderboardPrizeCampaign(campaign),
            podium: leaderboardPodium,
            entries: leaderboardEntries,
            copy: "Leaderboard counts approved contribution points only.",
          }
        : {
            ...disabledLeaderboard,
            accountId: null,
            monthRank: null,
          },
      discounts: {
        eligible: hasFullAccess && commercialLaunchEnabled,
        totalRedemptions: discountStats.totalRedemptions,
        estimatedSavingsCents: discountStats.estimatedSavingsCents,
        estimatedSavingsDollars: Number((discountStats.estimatedSavingsCents / 100).toFixed(2)),
        uniqueVenues: discountStats.uniqueVenues,
        recentRedemptions: recentDiscountRedemptions,
        copy: commercialLaunchEnabled
          ? "Discount redemptions are logged only when you show your rotating code or QR at a venue."
          : "Venue discount and redemption tools are not available in this release.",
      },
      pintPoints: pintPointsWallet,
      counterStaffInvitations,
      counterStaffAssignments,
      rewards: {
        status: !commercialLaunchEnabled
          ? "paused"
          : rewardVouchers.length
          ? "active"
          : leaderboardEnabled
            ? "leaderboard_monthly"
            : "paused",
        eligiblePlaceholder: commercialLaunchEnabled
          && canAccessAgeGatedRewards({ account, latestAgeVerification }),
        ageGatedEligible: commercialLaunchEnabled
          && canAccessAgeGatedRewards({ account, latestAgeVerification }),
        ageThreshold: 18,
        fulfillmentCopy: commercialLaunchEnabled
          ? "Rewards are fulfilled manually. Contact Pint Path support with the claim reference before the expiry date; your status updates after an admin verifies fulfillment."
          : "Rewards are not included in the current Free release.",
        vouchers: rewardVouchers.map((voucher) => this.sanitizeRewardVoucher(voucher)),
      },
      betaTesting: {
        enabled: commercialLaunchEnabled && hasFullAccess,
        label: commercialLaunchEnabled && hasFullAccess ? "Beta tools unlocked" : "Not included in the Free release",
        leaderboard: leaderboardEnabled && campaign
          ? {
              disabled: false,
              monthKey,
              campaign: this.sanitizeLeaderboardPrizeCampaign(campaign),
              podium: leaderboardPodium,
              entries: leaderboardEntries,
              me: leaderboardRank,
            }
          : disabledLeaderboard,
        pubGolf: {
          enabled: commercialLaunchEnabled && hasFullAccess && this.config.ALCOHOL_GAMIFICATION_ENABLED,
          defaultDrinks: commercialLaunchEnabled ? PUB_GOLF_DEFAULT_DRINKS : [],
          copy: !commercialLaunchEnabled
            ? "Pub Golf is not included in the current Free release."
            : this.config.ALCOHOL_GAMIFICATION_ENABLED
            ? "Build a nine-stop Pub Golf route from real venue drink data. Beta routing uses Pint Path venue coordinates with walking/transit hints."
            : "Pub Golf is paused pending App Store and Victorian responsible-promotion approval.",
        },
        canIDrive: {
          enabled: commercialLaunchEnabled && hasFullAccess,
          sourceDrinkLimit: commercialLaunchEnabled ? 25 : 0,
          copy: commercialLaunchEnabled
            ? "Review standard drinks only when exact ABV and serving volume are available. Pint Path does not estimate BAC or provide driving clearance."
            : "This beta tool is not included in the current Free release.",
        },
      },
      ageVerification: {
        latest: latestAgeVerification,
        status: account.ageVerificationStatus,
        isOver18Verified: account.isOver18Verified,
        copy: commercialLaunchEnabled
          ? "18+ confirmation is required for protected contribution and reward features. Pint Path does not store raw ID documents."
          : "18+ confirmation is required for protected contribution features. Pint Path does not store raw ID documents.",
      },
    };
  }

  private async getSavedUpdatesFeed(
    account: BusinessAccount,
    savedItems: readonly SavedItem[],
    asOf: string,
  ): Promise<SavedUpdatesFeed> {
    const variant = savedUpdatesExperimentVariant(account.id);
    if (!this.savedUpdatesReadRepository) {
      return {
        enabled: false,
        variant,
        asOf,
        windowDays: 7,
        revision: null,
        updates: [],
        eligibleResultCount: 0,
        copy: "Saved Updates is temporarily unavailable.",
      };
    }
    try {
      return await buildSavedUpdatesFeed({
        accountId: account.id,
        savedItems,
        asOf,
        repository: this.savedUpdatesReadRepository,
      });
    } catch (error) {
      logger.warn("Saved Updates evidence query failed", {
        accountId: account.publicAccountId,
        error: error instanceof Error ? error.message : "unknown",
      });
      return {
        enabled: false,
        variant,
        asOf,
        windowDays: 7,
        revision: null,
        updates: [],
        eligibleResultCount: 0,
        copy: "Saved Updates is temporarily unavailable.",
      };
    }
  }

  async recordAccountDashboardViewed(account: BusinessAccount) {
    const variant = savedUpdatesExperimentVariant(account.id);
    const savedItems = await this.accountProfilePreferencesRepository.listSavedItems(account.id);
    const savedUpdatesEligibleAtAssignment = savedItems.some((item) =>
      item.itemType === "venue" || item.itemType === "beer");
    await this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "account_dashboard_viewed",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: {
        accountRole: account.role,
        accountSubscriptionStatus: account.subscriptionStatus,
        savedUpdatesEligibleAtAssignment,
        savedUpdatesExperimentVersion: SAVED_UPDATES_EXPERIMENT_VERSION,
        savedUpdatesVariant: variant,
      },
    });
    return { recorded: true, savedUpdatesVariant: variant };
  }

  async recordSavedUpdatesViewed(account: BusinessAccount, input: SavedUpdatesViewedInput) {
    if (!this.savedUpdatesReadRepository) {
      throw new AppError("Saved Updates is temporarily unavailable.", 503);
    }
    const savedItems = await this.accountProfilePreferencesRepository.listSavedItems(account.id);
    const feed = await this.getSavedUpdatesFeed(account, savedItems, nowIso());
    if (
      !feed.enabled
      || feed.variant !== "treatment"
      || feed.revision === null
      || feed.revision !== input.revision
      || feed.updates.length === 0
    ) {
      throw new AppError("That Saved Updates feed is no longer current.", 409);
    }
    await this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "saved_updates_viewed",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: {
        savedUpdatesExperimentVersion: SAVED_UPDATES_EXPERIMENT_VERSION,
        savedUpdatesVariant: feed.variant,
        revision: feed.revision,
        updateCount: feed.updates.length,
        eligibleResultCount: feed.eligibleResultCount,
        windowDays: feed.windowDays,
      },
    });
    return { recorded: true, revision: feed.revision };
  }

  async recordSavedUpdateOpened(account: BusinessAccount, input: SavedUpdateOpenedInput) {
    if (!this.savedUpdatesReadRepository) {
      throw new AppError("Saved Updates is temporarily unavailable.", 503);
    }
    const savedItems = await this.accountProfilePreferencesRepository.listSavedItems(account.id);
    const feed = await this.getSavedUpdatesFeed(account, savedItems, nowIso());
    const update = feed.enabled && feed.variant === "treatment"
      ? feed.updates.find((candidate) => candidate.id === input.updateId) ?? null
      : null;
    if (!update) {
      throw new AppError("That Saved Update is no longer current.", 409);
    }
    await this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "saved_update_opened",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: {
        savedUpdatesExperimentVersion: SAVED_UPDATES_EXPERIMENT_VERSION,
        savedUpdatesVariant: feed.variant,
        updateId: update.id,
        updateType: update.type,
        effectiveAt: update.effectiveAt,
      },
    });
    return { recorded: true, updateId: update.id };
  }

  async exportAccountData(account: BusinessAccount) {
    const exportStartedAt = nowIso();
    const [preferences, storedPrivacySettings, profile, savedItems, recentSearches] = await Promise.all([
      this.accountProfilePreferencesRepository.getAccountPreferences(account.id),
      this.accountProfilePreferencesRepository.getAccountPrivacySettings(account.id),
      this.accountProfilePreferencesRepository.getProfileById(account.id),
      this.accountProfilePreferencesRepository.listSavedItems(account.id),
      this.accountProfilePreferencesRepository.listRecentSearches(account.id, RECENT_SEARCH_UNBOUNDED_LIMIT),
    ]);
    const privacySettings = storedPrivacySettings ??
      await this.accountProfilePreferencesRepository.getDefaultAccountPrivacySettings(account.id, exportStartedAt);
    const submissionRecords: CommunitySubmissionRecord[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.communitySubmissionRepository.listSubmissions({
        userId: account.id,
        limit: 100,
        offset,
      });
      submissionRecords.push(...page);
      if (page.length < 100) break;
    }
    const submissions = submissionRecords.map(({ submission, items }) => {
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
        uploadLatitude: submission.uploadLatitude,
        uploadLongitude: submission.uploadLongitude,
        uploadLocationCapturedAt: submission.uploadLocationCapturedAt,
        uploadAccuracyMeters: submission.uploadAccuracyMeters,
        hasPrivateEvidence: Boolean(submission.sourcePhotoUrl),
        reviewedAt: submission.reviewedAt,
        rejectionReason: submission.rejectionReason,
        fraudFlagged: submission.fraudFlagged,
        createdAt: submission.createdAt,
        updatedAt: submission.updatedAt,
        items: items.map((item) => ({
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

    await this.recordUserActivity({
      account,
      eventType: "account_data_exported",
      relatedEntityType: "account",
      relatedEntityId: account.id,
      metadata: { format: "json", submissionCount: submissions.length },
    });
    await this.auditSecurity({
      actor: account,
      action: "account_data_exported",
      targetType: "account",
      targetId: account.id,
      metadata: { submissionCount: submissions.length },
    });
    const relatedData = await this.accountPrivacyRepository.exportAccountRelatedData({
      userId: account.id,
    });

    return {
      exportedAt: exportStartedAt,
      exportFormat: "pint_path_account_export_v1",
      note: "Private evidence file bytes, raw photo data, raw tokens, and passwords are excluded. Exact stored upload coordinates and capture times are included until their post-review retention period ends.",
      account: sanitizeAccount(account),
      profile,
      privacySettings,
      preferences: preferences ?? null,
      savedItems,
      recentSearches,
      submissions,
      verifications: await this.listAllCommunityVerifications(account.id),
      activity: await this.listAllUserActivityEvents(account.id),
      ageVerification: {
        latest: await this.accountSessionRepository.getLatestAgeVerification(account.id),
        status: account.ageVerificationStatus,
        isOver18Verified: account.isOver18Verified,
      },
      relatedData,
      retentionPolicy: ACCOUNT_DATA_RETENTION_POLICY,
    };
  }

  private async listAllCommunityVerifications(userId: string) {
    const verifications: UserVerification[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.communitySubmissionRepository.listVerificationsForUser({
        verifierUserId: userId,
        limit: 100,
        offset,
      });
      verifications.push(...page);
      if (page.length < 100) return verifications;
    }
  }

  private async listAllUserActivityEvents(userId: string): Promise<UserActivityEventRecord[]> {
    const activity: UserActivityEventRecord[] = [];
    const seenIds = new Set<string>();
    let cursor: ActivityAuditCursor | null = null;
    for (;;) {
      const page = await this.activityAuditRepository.listUserActivityEvents({
        userId,
        limit: 200,
        cursor,
      });
      for (const event of page.items) {
        if (seenIds.has(event.id)) {
          throw new AppError("Account activity export could not be completed.", 500, undefined, false);
        }
        seenIds.add(event.id);
        activity.push(event);
      }
      if (!page.nextCursor) return activity;
      if (cursor?.createdAt === page.nextCursor.createdAt && cursor.id === page.nextCursor.id) {
        throw new AppError("Account activity export could not be completed.", 500, undefined, false);
      }
      cursor = page.nextCursor;
    }
  }

  private async getSubmissionLocationEligibility(input: CreateSubmissionInput): Promise<{
    uploadLatitude: number | null;
    uploadLongitude: number | null;
    uploadAccuracyMeters: number | null;
    uploadLocationCapturedAt: string | null;
    distanceToVenueMeters: number | null;
    pointsEligibleByLocation: boolean;
    pointsEligibilityReason: string;
  }> {
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
      : await this.venueIdentityRepository.getVenueLocationCache(input.venueId);
    const uploadLatitude = input.uploadLocation.latitude;
    const uploadLongitude = input.uploadLocation.longitude;
    const uploadAccuracyMeters = input.uploadLocation.accuracyMeters;
    const capturedAtMs = Date.parse(input.uploadLocation.capturedAt);
    const captureAgeMs = Date.now() - capturedAtMs;

    // Client geolocation is retained as anti-abuse/reviewer evidence. It is not
    // cryptographic proof and never bypasses admin review.
    if (!Number.isFinite(uploadAccuracyMeters)) {
      return {
        uploadLatitude,
        uploadLongitude,
        uploadAccuracyMeters: null,
        uploadLocationCapturedAt: input.uploadLocation.capturedAt,
        distanceToVenueMeters: null,
        pointsEligibleByLocation: false,
        pointsEligibilityReason: "location_accuracy_missing",
      };
    }
    if (uploadAccuracyMeters > CONTRIBUTION_POINTS.maxLocationAccuracyMeters) {
      return {
        uploadLatitude,
        uploadLongitude,
        uploadAccuracyMeters,
        uploadLocationCapturedAt: input.uploadLocation.capturedAt,
        distanceToVenueMeters: null,
        pointsEligibleByLocation: false,
        pointsEligibilityReason: "location_accuracy_over_100m",
      };
    }
    if (
      !Number.isFinite(capturedAtMs) ||
      captureAgeMs < -(15 * 60_000) ||
      captureAgeMs > CONTRIBUTION_POINTS.locationMaxAgeHours * 60 * 60_000
    ) {
      return {
        uploadLatitude,
        uploadLongitude,
        uploadAccuracyMeters,
        uploadLocationCapturedAt: input.uploadLocation.capturedAt,
        distanceToVenueMeters: null,
        pointsEligibleByLocation: false,
        pointsEligibilityReason: captureAgeMs < 0 ? "location_capture_in_future" : "location_capture_stale",
      };
    }

    if (
      !venueLocation ||
      venueLocation.latitude == null ||
      venueLocation.longitude == null
    ) {
      return {
        uploadLatitude,
        uploadLongitude,
        uploadAccuracyMeters,
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
      uploadAccuracyMeters,
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

  private async assertPendingVenueIsNotKnownDuplicate(pendingVenue: PendingVenueDetails | null): Promise<void> {
    if (!pendingVenue) {
      return;
    }

    const duplicate = await this.venueDataReadRepository.findLikelyVenueDuplicate({
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

  private mergeVenueRows(
    primary: VenueRow[],
    secondary: VenueRow[],
    limit: number,
    preferSecondaryDetails = false,
  ): VenueRow[] {
    const venuesByCanonicalId = new Map<string, VenueRow>();
    const canonicalIdByVenueId = new Map<string, string>();
    const canonicalIdByIdentity = new Map<string, string>();

    for (const [index, venue] of [...primary, ...secondary].entries()) {
      const enriched = venue;
      const identity = venueIdentityKey(enriched) ?? `id:${enriched.id}`;
      const canonicalId =
        canonicalIdByVenueId.get(enriched.id) ??
        canonicalIdByIdentity.get(identity);
      if (!canonicalId) {
        venuesByCanonicalId.set(enriched.id, enriched);
        canonicalIdByVenueId.set(enriched.id, enriched.id);
        canonicalIdByIdentity.set(identity, enriched.id);
        continue;
      }

      const existing = venuesByCanonicalId.get(canonicalId);
      if (!existing) {
        continue;
      }

      const preferIncomingDetails =
        preferSecondaryDetails &&
        index >= primary.length &&
        enriched.id === existing.id;
      const canonical = {
        ...enriched,
        ...existing,
        name: preferIncomingDetails ? enriched.name || existing.name : existing.name || enriched.name,
        address: preferIncomingDetails ? enriched.address ?? existing.address : existing.address ?? enriched.address,
        suburb: preferIncomingDetails ? enriched.suburb ?? existing.suburb : existing.suburb ?? enriched.suburb,
        state: preferIncomingDetails ? enriched.state ?? existing.state : existing.state ?? enriched.state,
        postcode: preferIncomingDetails ? enriched.postcode ?? existing.postcode : existing.postcode ?? enriched.postcode,
        latitude: preferIncomingDetails ? enriched.latitude ?? existing.latitude : existing.latitude ?? enriched.latitude,
        longitude: preferIncomingDetails ? enriched.longitude ?? existing.longitude : existing.longitude ?? enriched.longitude,
        phone: (preferIncomingDetails ? enriched.phone ?? existing.phone : existing.phone ?? enriched.phone) ?? null,
        website: (preferIncomingDetails ? enriched.website ?? existing.website : existing.website ?? enriched.website) ?? null,
        businessStatus: (preferIncomingDetails
          ? enriched.businessStatus ?? existing.businessStatus
          : existing.businessStatus ?? enriched.businessStatus) ?? null,
        lastCheckedAt: (preferIncomingDetails
          ? enriched.lastCheckedAt ?? existing.lastCheckedAt
          : existing.lastCheckedAt ?? enriched.lastCheckedAt) ?? null,
        membershipTier: existing.membershipTier === "pro" || enriched.membershipTier === "pro" ? "pro" : "basic",
        highlightedName: Boolean(existing.highlightedName || enriched.highlightedName),
        premiumBadge: existing.premiumBadge ?? enriched.premiumBadge ?? null,
        promoted: Boolean(existing.promoted || enriched.promoted),
        featuredSpecialEligible: Boolean(existing.featuredSpecialEligible || enriched.featuredSpecialEligible),
        acceptsPintPathCodes: Boolean(existing.acceptsPintPathCodes || enriched.acceptsPintPathCodes),
      } satisfies VenueRow;
      venuesByCanonicalId.set(canonicalId, canonical);
      canonicalIdByVenueId.set(enriched.id, canonicalId);
      canonicalIdByIdentity.set(identity, canonicalId);
    }

    return Array.from(venuesByCanonicalId.values()).slice(0, limit);
  }

  private assertAccountCanSubmit(account: BusinessAccount, options: { allowVenueManager?: boolean } = {}): void {
    if (account.status === "suspended") {
      throw new AppError("Suspended accounts cannot submit reward-eligible data.", 403);
    }

    if (account.role === "venue_manager" && !options.allowVenueManager) {
      throw new AppError("Venue accounts use the venue dashboard instead of reward submissions.", 403);
    }

    this.requireVerifiedEmail(account, "Verify your email before uploading venue data.");
    this.requireCurrentLegalAcceptance(account);

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

    // Base64 adds roughly one third to the request size; stay below Express' 16MB body limit.
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
      await this.systemStateRepository.set("job:menu_ocr", { state: "running", startedAt }, startedAt);
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
      await this.systemStateRepository.set("job:menu_ocr", {
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
      await this.systemStateRepository.set("job:menu_ocr", {
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

  private assertPublicHappyHourContributionAllowed(
    account: BusinessAccount,
    input: CreateSubmissionInput,
    options: {
      allowVenueManager?: boolean;
      photoOcr?: PreparedPhotoOcr | null;
    } = {},
  ): void {
    if (
      PUBLIC_HAPPY_HOUR_CONTRIBUTIONS_ENABLED ||
      options.allowVenueManager === true ||
      this.isAdmin(account)
    ) {
      return;
    }

    const items = [...input.items, ...(options.photoOcr?.items ?? [])];
    const containsHappyHourData = input.submissionType === "happy_hour_update" ||
      items.some((item) => item.isHappyHourPrice || Boolean(item.happyHourDetails?.trim()));
    if (containsHappyHourData) {
      throw new AppError(
        "Happy-hour contributions are not available during the current public launch.",
        403,
      );
    }
  }

  async createUserSubmission(account: BusinessAccount, input: CreateSubmissionInput) {
    this.assertAccountCanSubmit(account);
    this.assertPublicHappyHourContributionAllowed(account, input);
    if (input.clientSubmissionId) {
      const existing = await this.communitySubmissionRepository.getSubmissionByClientSubmissionId(
        account.id,
        input.clientSubmissionId,
      );
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
    const createdEvidenceRefs: string[] = [];
    try {
      const sourcePhotoRefs = await this.resolveSubmissionSourcePhotos(
        account,
        verifiedInput,
        (ref) => createdEvidenceRefs.push(ref),
      );
      const result = await this.createSubmission(account, verifiedInput, { photoOcr, sourcePhotoRefs });
      if (result.idempotentReplay) {
        await this.compensateUnlinkedSourceEvidence(createdEvidenceRefs);
      }
      return result;
    } catch (error) {
      await this.compensateUnlinkedSourceEvidence(createdEvidenceRefs);
      throw error;
    }
  }

  async createSubmission(
    account: BusinessAccount,
    input: CreateSubmissionInput,
    options: {
      allowVenueManager?: boolean;
      managerAssignmentId?: string;
      rewardEligible?: boolean;
      photoOcr?: PreparedPhotoOcr | null;
      sourcePhotoRefs?: string[];
    } = {},
  ) {
    this.assertAccountCanSubmit(account, { allowVenueManager: options.allowVenueManager === true });
    this.assertPublicHappyHourContributionAllowed(account, input, options);
    const containsDeferredHappyHourData = input.submissionType === "happy_hour_update"
      || input.items.some((item) => item.isHappyHourPrice || Boolean(item.happyHourDetails?.trim()))
      || Boolean(options.photoOcr?.items.some((item) => item.isHappyHourPrice || Boolean(item.happyHourDetails?.trim())));
    const isInternalVenueManagerHappyHour = options.allowVenueManager === true && containsDeferredHappyHourData;
    if (containsDeferredHappyHourData && !isInternalVenueManagerHappyHour) {
      throw new AppError("Happy-hour and special publication is not available during the current Free launch.", 403);
    }
    const rewardEligible = options.rewardEligible ?? true;

    if (input.clientSubmissionId && !isInternalVenueManagerHappyHour) {
      const existingSubmission = await this.communitySubmissionRepository.getSubmissionByClientSubmissionId(
        account.id,
        input.clientSubmissionId,
      );
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
    const submissionId = input.clientSubmissionId
      ? `community-${crypto.createHash("sha256")
          .update(`${account.id}\0${input.clientSubmissionId}`)
          .digest("hex")}`
      : crypto.randomUUID();
    const clientSubmissionId = input.clientSubmissionId ?? submissionId;
    const observedAtMs = Date.parse(input.observedAt);
    const nowMs = Date.parse(now);
    if (observedAtMs > nowMs + (15 * 60_000)) {
      throw new AppError("Observation time cannot be more than 15 minutes in the future.", 400);
    }
    if (observedAtMs < nowMs - (31 * 24 * 60 * 60_000)) {
      throw new AppError("Observation time must be within the last 31 days so published prices remain current.", 400);
    }
    if (input.uploadLocation) {
      const capturedAtMs = Date.parse(input.uploadLocation.capturedAt);
      if (
        capturedAtMs > nowMs + (15 * 60_000) ||
        capturedAtMs < nowMs - (CONTRIBUTION_POINTS.locationMaxAgeHours * 60 * 60_000)
      ) {
        throw new AppError("Upload location must have been captured within the last 12 hours and not in the future.", 400);
      }
    }
    let internalMissionFence: VenueManagerInternalMissionFence | null = null;
    if (input.missionId) {
      await this.runMissionMaintenance();
      const mission = await this.missionLifecycleRepository.getMissionById(input.missionId);
      if (!mission || !mission.active) {
        throw new AppError("This mission is no longer active. Refresh Missions and choose a current task.", 409);
      }
      if (!PUBLIC_HAPPY_HOUR_MISSIONS_ENABLED && isHappyHourMission(mission)) {
        throw new AppError("This happy-hour mission is not available during the current public launch.", 403);
      }
      if (mission.venueId !== input.venueId) {
        throw new AppError("The selected venue does not match this mission.", 400);
      }
      const progress = await this.missionLifecycleRepository.getMissionProgress({
        missionId: mission.id,
        userId: account.id,
      });
      if (progress?.status === "completed") {
        throw new AppError("You have already completed this mission.", 409);
      }
      const isExactInternalMissionReplay = isInternalVenueManagerHappyHour
        && progress?.status === "submitted"
        && progress.submissionId === submissionId;
      if (progress?.status !== "accepted" && !isExactInternalMissionReplay) {
        throw new AppError("Accept this mission before submitting it, or accept it again if your 24-hour reservation expired.", 409);
      }
      if (isInternalVenueManagerHappyHour && progress) {
        internalMissionFence = {
          id: mission.id,
          progressId: progress.id,
          expectedMissionUpdatedAt: mission.updatedAt,
          expectedProgressUpdatedAt: progress.updatedAt,
          acceptedAfter: missionAcceptanceCutoff(now),
        };
      }
    }
    const pendingVenue = this.normalizePendingVenue(input);
    await this.assertPendingVenueIsNotKnownDuplicate(pendingVenue);
    const sourcePhotoRefs = options.sourcePhotoRefs ?? await this.resolveInlineSubmissionSourcePhotos(account, input);
    const sourcePhotoUrl = sourcePhotoRefs[0] ?? null;
    const rawLocationEligibility = await this.getSubmissionLocationEligibility(input);
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
    // Free launch retains venue-manager happy-hour collection only as an
    // internal, non-public moderation row. Its dedicated PostgreSQL transaction
    // rejects publication and reward effects; Community approval also rejects
    // this submission type, so no public price or contributor reward can result.
    if (isInternalVenueManagerHappyHour) {
      if (!options.managerAssignmentId) {
        throw new AppError("Venue manager access is required for this internal submission.", 403);
      }
      const created = await this.venueManagerInternalSubmissionRepository.createInternalHappyHourSubmission({
        id: submissionId,
        clientSubmissionId,
        managerAccountId: account.id,
        managerAssignmentId: options.managerAssignmentId,
        venueId: input.venueId,
        venueName: pendingVenue?.name ?? input.venueName,
        suburb: pendingVenue?.suburb ?? input.suburb,
        submissionType: "happy_hour_update",
        observedAt: new Date(input.observedAt).toISOString(),
        evidenceIds: sourcePhotoRefs
          .map(getPrivateEvidenceId)
          .filter((id): id is string => Boolean(id)),
        ocrStatus: options.photoOcr?.status ?? "not_requested",
        ocrSummary: options.photoOcr?.summary ?? null,
        notes: input.notes,
        location: input.uploadLocation
          ? {
              latitude: rawLocationEligibility.uploadLatitude!,
              longitude: rawLocationEligibility.uploadLongitude!,
              accuracyMeters: rawLocationEligibility.uploadAccuracyMeters,
              capturedAt: new Date(input.uploadLocation.capturedAt).toISOString(),
              distanceToVenueMeters: rawLocationEligibility.distanceToVenueMeters,
            }
          : null,
        mission: internalMissionFence,
        safety: {
          internalOnly: true,
          publicationEligible: false,
          rewardEligible: false,
          pointsAwarded: 0,
        },
        now,
        pendingVenue,
        items: preparedItems.map((item, index) => {
          const beerName = canonicalizeTrackedBeerName(item.beerName);
          return {
            id: `${submissionId}:item:${index}`,
            beerName,
            normalizedBeerId: findTrackedBeerByName(beerName)?.key ?? null,
            servingSize: item.servingSize,
            price: item.price,
            isHappyHourPrice: item.isHappyHourPrice,
            happyHourDetails: item.happyHourDetails,
            isOnTap: item.isOnTap,
            confidence: item.confidence,
            captureSource: item.captureSource,
            sourceText: item.sourceText,
            requiresCatalogApproval: false,
          };
        }),
      });
      const submission = created.record.submission;
      if (created.outcome === "created") {
        await this.trackEvent(account, {
          anonymousSessionId: null,
          eventType: "submission_completed",
          venueId: submission.venueId,
          beerId: preparedItems[0]?.beerName ? normalizeTrackedBeerId(preparedItems[0].beerName) : null,
          suburb: submission.suburb,
          metadata: {
            submissionId: submission.id,
            submissionType: submission.submissionType,
            itemCount: preparedItems.length,
            hasSourcePhoto: Boolean(sourcePhotoUrl),
            rewardEligible: false,
            internalOnly: true,
          },
        });
        await this.recordUserActivity({
          account,
          eventType: "data_upload_created",
          relatedEntityType: "submission",
          relatedEntityId: submission.id,
          metadata: {
            submissionType: submission.submissionType,
            venueId: submission.venueId,
            itemCount: preparedItems.length,
            rewardEligible: false,
            internalOnly: true,
          },
        });
      }
      return {
        submission,
        statusCopy: "Venue happy-hour update saved for internal review. It is not eligible for public Free-launch publication.",
        ocrStatus: submission.ocrStatus,
        linkedVenueRequestCount: 0,
        ...(created.outcome === "replayed" ? { idempotentReplay: true } : {}),
      };
    }
    const standardizedCandidates: Array<PreparedSubmissionItem & {
      beerName: string;
      normalizedBeerId: string | null;
      requiresCatalogApproval: boolean;
      catalog: CommunityCatalogDecision;
    }> = [];
    for (const item of preparedItems) {
      const isPhotoOcr = item.captureSource === "photo_ocr";
      const beer = await this.standardizeBeerReference({
        name: item.beerName,
        source: isPhotoOcr
          ? "user_photo_ocr"
          : item.isHappyHourPrice
            ? "happy_hour_submission"
            : "user_submission",
        now,
        createIfMissing: false,
        isHappyHour: item.isHappyHourPrice,
        matchMode: isPhotoOcr ? "ocr" : "exact",
        brewery: item.catalogBrewery,
        abv: item.catalogAbv,
      });
      if (!beer.key) {
        throw new AppError("Enter a recognised beer name for the current Free launch.", 400);
      }
      const persistedCatalog = this.beerCatalogRepository
        ? await this.beerCatalogRepository.getAdminItem(beer.key)
        : null;
      const catalogSource = isPhotoOcr ? "user_photo_ocr" : "user_submission";
      const alias = canonicalizeTrackedBeerName(item.beerName);
      const aliasKey = normalizeBeerSearchKey(alias);
      if (!aliasKey) {
        throw new AppError("Enter a recognised beer name for the current Free launch.", 400);
      }
      standardizedCandidates.push({
        ...item,
        beerName: beer.name,
        normalizedBeerId: beer.key,
        requiresCatalogApproval: beer.status !== "active",
        catalog: beer.status === "active" && persistedCatalog?.status === "active"
          ? { kind: "active_existing" as const, key: beer.key }
          : beer.status === "active"
            ? {
                kind: "active_create" as const,
                key: beer.key,
                canonicalName: beer.name,
                aliasKey,
                alias,
                source: catalogSource,
                brewery: item.catalogBrewery ?? beer.brewery,
                style: beer.style,
                abv: item.catalogAbv ?? beer.abv,
              }
          : {
              kind: "pending_create" as const,
              key: beer.key,
              canonicalName: beer.name,
              aliasKey,
              alias,
              source: catalogSource,
              brewery: item.catalogBrewery ?? beer.brewery,
              style: beer.style,
              abv: item.catalogAbv ?? beer.abv,
            },
      });
    }
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
    let submission: BusinessSubmission;
    let idempotentReplay = false;
    try {
      const created = await this.communitySubmissionRepository.createSubmission({
        id: submissionId,
        clientSubmissionId,
        missionId: input.missionId,
        ...(input.missionId ? { missionAcceptedAfter: missionAcceptanceCutoff(now) } : {}),
        userId: account.id,
        venueId: input.venueId,
        venueName: pendingVenue?.name ?? input.venueName,
        suburb: pendingVenue?.suburb ?? input.suburb,
        submissionType: input.submissionType as Exclude<typeof input.submissionType, "happy_hour_update">,
        observedAt: input.observedAt,
        evidenceIds: sourcePhotoRefs
          .map(getPrivateEvidenceId)
          .filter((id): id is string => Boolean(id)),
        ocrStatus: options.photoOcr?.status ?? "not_requested",
        ocrSummary,
        notes: input.notes,
        now,
        ...locationEligibility,
        pendingVenue,
        items: standardizedItems.map((item, index) => ({
          id: `${submissionId}:item:${index}`,
          catalog: item.catalog,
          servingSize: item.servingSize,
          price: item.price,
          isHappyHourPrice: item.isHappyHourPrice,
          happyHourDetails: item.happyHourDetails,
          isOnTap: item.isOnTap,
          confidence: item.confidence,
          captureSource: item.captureSource,
          sourceText: item.sourceText,
        })),
      });
      submission = created.record.submission;
      idempotentReplay = created.replayed;
    } catch (error) {
      if (error instanceof MissionReservationError) {
        throw new AppError(error.message, 409);
      }
      throw error;
    }
    const publishedVenueImmediately = false;
    const linkedVenueRequestCount = 0;

    const firstItem = standardizedItems[0] ?? null;
    await this.trackEvent(account, {
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
        linkedVenueRequestCount,
      },
    });
    await this.recordUserActivity({
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
        linkedVenueRequestCount,
      },
    });

    const ocrItems = options.photoOcr
      ? standardizedItems.filter((item) => item.captureSource === "photo_ocr")
      : [];
    const ocrPreview = options.photoOcr
      ? ocrItems
          .slice(0, 3)
          .map((item) => {
            const price = item.price == null
              ? ""
              : ` ($${item.price.toFixed(item.price % 1 === 0 ? 0 : 2)} pint)`;
            return `${item.beerName}${price}`;
          })
          .join(", ")
      : "";
    return {
      submission,
      statusCopy: options.photoOcr
        ? ocrItems.length
          ? `OCR read ${ocrItems.length} beer row${ocrItems.length === 1 ? "" : "s"}${ocrPreview ? `: ${ocrPreview}${ocrItems.length > 3 ? ", and more" : ""}` : ""}. ${pendingCatalogCount ? `${pendingCatalogCount} new beer name${pendingCatalogCount === 1 ? " needs" : "s need"} catalogue approval. ` : ""}Everything remains pending admin review before publication.`
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
      linkedVenueRequestCount,
      ...(idempotentReplay ? { idempotentReplay: true } : {}),
    };
  }

  private async resolveSubmissionSourcePhotos(
    account: Pick<BusinessAccount, "id">,
    input: CreateSubmissionInput,
    onCreated?: (ref: string) => void,
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
      if (ref) {
        refs.push(ref);
        onCreated?.(ref);
      }
    }

    if (input.sourcePhotoUrl) {
      const ref = await this.resolveSourcePhoto(account, {
        sourcePhotoDataUrl: null,
        sourceDocumentDataUrl: null,
        sourcePhotoUrl: input.sourcePhotoUrl,
      });
      if (ref) {
        refs.push(ref);
        onCreated?.(ref);
      }
    }

    return refs;
  }

  /**
   * Reuses only byte-for-byte identical evidence on an internal-manager retry.
   * Provider reads happen before the repository transaction; the repository
   * still locks and revalidates each durable evidence row before commit.
   */
  private async resolveExistingInternalManagerEvidenceRefs(
    account: Pick<BusinessAccount, "id">,
    input: CreateSubmissionInput,
  ): Promise<string[] | null> {
    if (!input.clientSubmissionId) return null;
    const existing = await this.communitySubmissionRepository.getSubmissionByClientSubmissionId(
      account.id,
      input.clientSubmissionId,
    );
    if (!existing) return null;
    if (
      existing.submission.userId !== account.id
      || existing.submission.submissionType !== "happy_hour_update"
      || existing.submission.status !== "pending"
    ) {
      throw new AppError("Internal venue submission state changed. Refresh and try again.", 409);
    }
    if (input.sourcePhotoUrl) {
      parseSafeImageSourceUrl(input.sourcePhotoUrl, "Source photo URL");
      throw new AppError("For reviewer safety, upload the source image directly instead of linking to an external site.", 400);
    }

    const inputDataUrls = Array.from(new Set([
      input.sourcePhotoDataUrl,
      ...(input.sourcePhotoDataUrls ?? []),
      input.sourceDocumentDataUrl,
    ].filter((value): value is string => Boolean(value))));
    const evidence = [...existing.evidence].sort((left, right) => left.sortOrder - right.sortOrder);
    if (inputDataUrls.length !== evidence.length) {
      throw new AppError("Internal venue submission state changed. Refresh and try again.", 409);
    }

    for (const [index, dataUrl] of inputDataUrls.entries()) {
      const linked = evidence[index]?.object;
      if (!linked || linked.ownerUserId !== account.id) {
        throw new AppError("Internal venue submission state changed. Refresh and try again.", 409);
      }
      const { mimeType, bytes } = validateSubmissionEvidenceDataUrl(dataUrl);
      const durable = await this.sourceEvidenceObjectRepository.getSourceEvidenceObject(linked.id);
      if (!durable || durable.ownerUserId !== account.id || durable.mimeType !== mimeType || durable.byteSize !== bytes.length) {
        throw new AppError("Internal venue submission state changed. Refresh and try again.", 409);
      }
      const delivery = await this.getSourceEvidenceDelivery(durable);
      if (!delivery || delivery.mimeType !== mimeType || !delivery.bytes.equals(bytes)) {
        throw new AppError("Internal venue submission state changed. Refresh and try again.", 409);
      }
    }

    return evidence.map(({ object }) => privateEvidenceRef(object.id));
  }

  private async compensateUnlinkedSourceEvidence(refs: string[]): Promise<void> {
    for (const ref of [...refs].reverse()) {
      const evidenceId = getPrivateEvidenceId(ref);
      if (!evidenceId || await this.sourceEvidenceRetentionRepository.isSourceEvidenceLinked(evidenceId)) continue;
      const evidence = await this.sourceEvidenceObjectRepository.getSourceEvidenceObject(evidenceId);
      if (!evidence?.ownerUserId) continue;
      try {
        if (evidence.storageProvider === FILESYSTEM_EVIDENCE_PROVIDER) {
          await fs.promises.rm(this.getSourceEvidenceFilePath(evidence.objectPath), { force: true });
        } else if (evidence.storageProvider === SUPABASE_EVIDENCE_PROVIDER) {
          await this.removeSupabaseSourceEvidence(evidence.objectPath);
        }
        const deleted = await this.communitySubmissionRepository.deleteUnlinkedSourceEvidence({
          id: evidenceId,
          ownerUserId: evidence.ownerUserId,
          deletedAt: nowIso(),
        });
        if (!deleted) {
          throw new Error("Source evidence became linked or changed before compensation completed.");
        }
      } catch (error) {
        logger.error("Failed to compensate unlinked source evidence", {
          evidenceId,
          storageProvider: evidence.storageProvider,
          error: error instanceof Error ? redactSecrets(error.message) : "unknown",
        });
      }
    }
  }

  private async resolveInlineSubmissionSourcePhotos(
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
      const { mimeType, bytes } = validateSubmissionEvidenceDataUrl(sourcePhotoDataUrl);
      if (this.config.NODE_ENV === "production" && !this.config.ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION) {
        throw new AppError("Production evidence uploads must use the asynchronous submission endpoint.", 500, undefined, false);
      }
      const createdAt = nowIso();
      const { object: evidence } = await this.sourceEvidenceObjectRepository.registerSourceEvidenceObject({
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
      const { object: evidence } = await this.sourceEvidenceObjectRepository.registerSourceEvidenceObject({
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
    try {
      const { object } = await this.sourceEvidenceObjectRepository.registerSourceEvidenceObject({
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
      return object;
    } catch (error) {
      try {
        await fs.promises.rm(filePath, { force: true });
      } catch (cleanupError) {
        logger.error("Failed to compensate orphaned private source evidence file", {
          provider: FILESYSTEM_EVIDENCE_PROVIDER,
          objectPath,
          error: cleanupError,
        });
      }
      throw error;
    }
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
      const { object } = await this.sourceEvidenceObjectRepository.registerSourceEvidenceObject({
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
      return object;
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

  async getSubmissionSourceEvidenceUrl(account: BusinessAccount, submissionId: string) {
    const submission = await this.communitySubmissionRepository.getSubmissionById(submissionId);
    if (!submission) {
      throw new AppError("Submission not found.", 404);
    }

    if (!this.isAdmin(account) && submission.submission.userId !== account.id) {
      throw new AppError("You can only access your own source evidence.", 403);
    }

    const linkedEvidenceIds = await this.sourceEvidenceRetentionRepository.listSubmissionSourceEvidenceIds({
      submissionId,
      limit: 1_000,
    });
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
    const signedEvidence: Array<{ url: string; mimeType: string | null }> = [];
    for (const evidenceId of evidenceIds) {
      const evidence = await this.sourceEvidenceObjectRepository.getSourceEvidenceObject(evidenceId);
      if (!evidence) {
        throw new AppError("Source evidence not found.", 404);
      }
      const signature = this.signEvidenceUrl(evidence.id, expiresAt);
      const signedUrl = new URL(`/api/business/source-evidence/${encodeURIComponent(evidence.id)}`, this.config.PUBLIC_BASE_URL);
      signedUrl.searchParams.set("expires", String(expiresAt));
      signedUrl.searchParams.set("signature", signature);

      await this.auditSecurity({
        actor: account,
        action: "source_evidence_signed_url_created",
        targetType: "source_evidence",
        targetId: evidence.id,
        metadata: { submissionId },
      });
      signedEvidence.push({ url: signedUrl.toString(), mimeType: evidence.mimeType });
    }
    const signedUrls = signedEvidence.map((item) => item.url);

    return {
      signedUrl: signedUrls[0] ?? null,
      signedUrls,
      evidence: signedEvidence,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }

  async getSourceEvidenceForSignedRequest(input: {
    evidenceId: string;
    expires: string | undefined;
    signature: string | undefined;
  }): Promise<SourceEvidenceObject> {
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

    const evidence = await this.sourceEvidenceObjectRepository.getSourceEvidenceObject(input.evidenceId);
    if (!evidence) {
      throw new AppError("Source evidence not found.", 404);
    }

    return evidence;
  }

  async savePreferences(account: BusinessAccount, input: AccountPreferencesInput) {
    const now = nextRevisionTimestamp(input.expectedUpdatedAt);
    const preferences = await this.accountProfilePreferencesRepository.upsertAccountPreferences({
      userId: account.id,
      preferredSuburbs: cleanStringList(input.preferredSuburbs),
      preferredBeers: cleanStringList(input.preferredBeers),
      preferredUseCases: cleanStringList(input.preferredUseCases) as AccountPreferences["preferredUseCases"],
      onboardingCompletedAt: input.onboardingCompleted ? now : null,
      now,
      expectedUpdatedAt: input.expectedUpdatedAt,
    });

    return { preferences };
  }

  async savePrivacySettings(account: BusinessAccount, input: AccountPrivacySettingsInput) {
    const now = nextRevisionTimestamp(input.expectedUpdatedAt);
    const optionalAnalyticsEnabled = input.optionalAnalyticsEnabled;
    const privacySettings = await this.accountProfilePreferencesRepository.upsertAccountPrivacySettings({
      userId: account.id,
      optionalAnalyticsEnabled,
      venueReportInclusionEnabled: optionalAnalyticsEnabled && input.venueReportInclusionEnabled,
      // These preferences have no active consent-bound consumer yet. Store a
      // safe disabled state until the corresponding workflows exist.
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
      consentVersion: CURRENT_LEGAL_POLICY_VERSION,
      now,
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
    await this.recordUserActivity({
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

  async saveItem(account: BusinessAccount, input: SaveItemInput) {
    const now = nowIso();
    const requestedId = crypto.randomUUID();
    const savedItem = await this.accountProfilePreferencesRepository.saveItem({
      id: requestedId,
      userId: account.id,
      itemType: input.itemType,
      itemId: input.itemId,
      label: input.label,
      suburb: input.suburb,
      metadata: sanitizeEventMetadata(input.metadata),
      now,
    });
    const created = savedItem.id === requestedId;
    const eventTypeByItem: Record<SaveItemInput["itemType"], EventTrackInput["eventType"]> = {
      venue: "saved_venue_added",
      beer: "saved_beer_added",
      suburb: "saved_suburb_added",
      night_plan: "saved_night_plan_added",
    };

    if (created) {
      await this.trackEvent(account, {
        anonymousSessionId: null,
        eventType: eventTypeByItem[input.itemType],
        venueId: input.itemType === "venue" ? input.itemId : null,
        beerId: input.itemType === "beer" ? normalizeTrackedBeerId(input.label) : null,
        suburb: input.itemType === "suburb" ? input.label : input.suburb,
        metadata: {
          itemId: input.itemId,
          label: input.label,
          privacyScope: input.itemType === "venue" ? "venue_insight" : "optional_analytics",
        },
      });
      if (input.itemType === "night_plan") {
        await this.trackEvent(account, {
          anonymousSessionId: null,
          eventType: "tonight_plan_created",
          venueId: null,
          beerId: null,
          suburb: input.suburb,
          metadata: {
            itemId: input.itemId,
            label: input.label,
            source: "account_saved_night_plan",
          },
        });
      }
    }

    return { savedItem, created };
  }

  async removeSavedItem(account: BusinessAccount, input: RemoveSavedItemInput) {
    const removed = await this.accountProfilePreferencesRepository.removeSavedItem({
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
      await this.trackEvent(account, {
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

  async submitFeedback(account: BusinessAccount | null, input: FeedbackInput) {
    const now = nowIso();
    const triage = this.classifyFeedback(input);
    const feedback = await this.supportFeedbackRepository.createFeedback({
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

    await this.trackEvent(account, {
      anonymousSessionId: input.anonymousSessionId,
      eventType: "feedback_submitted",
      venueId: input.venueId,
      beerId: null,
      suburb: null,
      metadata: { feedbackType: input.feedbackType, feedbackId: feedback.id },
    });

    if (["security_report", "privacy_request", "data_export_request", "account_deletion_request"].includes(input.feedbackType)) {
      await this.auditSecurity({
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

  async requestAccountDeletion(account: BusinessAccount, input: { message?: string | null | undefined }) {
    const requestedAt = nowIso();
    const request = await this.accountDeletionQueueRepository.createAccountDeletionRequest({
      id: crypto.randomUUID(),
      userId: account.id,
      userMessage: input.message ?? null,
      requestedAt,
      executeAfter: addDays(requestedAt, 7),
    });

    await this.recordUserActivity({
      account,
      eventType: "account_deletion_requested",
      relatedEntityType: "account_deletion_request",
      relatedEntityId: String(request.id),
      metadata: { requestType: "account_deletion_request" },
    });
    await this.auditSecurity({
      actor: account,
      action: "account_deletion_requested",
      targetType: "account_deletion_request",
      targetId: String(request.id),
      metadata: { executeAfter: request.execute_after },
    });

    return {
      request,
      message: "Account deletion is scheduled after a seven-day cancellation window. An authorised operator must execute the documented provider-deletion and anonymisation workflow after that time.",
    };
  }

  async getAccountDeletionStatus(account: BusinessAccount) {
    return { request: await this.accountDeletionQueueRepository.getAccountDeletionRequestForUser(account.id) };
  }

  async cancelAccountDeletion(account: BusinessAccount, requestId: string) {
    const request = await this.accountDeletionQueueRepository.getAccountDeletionRequestById(requestId);
    if (!request || String(request.user_id) !== account.id) {
      throw new AppError("Deletion request not found.", 404);
    }
    if (!await this.accountDeletionQueueRepository.cancelAccountDeletion({
      requestId,
      userId: account.id,
      now: nowIso(),
    })) {
      throw new AppError("This deletion request can no longer be cancelled.", 409);
    }
    await this.accountDeletionQueueRepository.checkpointAccountDeletionNotificationSecrets(
      this.performAccountDeletionSecretPhysicalCheckpoint,
    );
    await this.auditSecurity({
      actor: account,
      action: "account_deletion_cancelled",
      targetType: "account_deletion_request",
      targetId: requestId,
    });
    return { requestId, status: "cancelled", cancelled: true };
  }

  async purgeExpiredSourceEvidence(pageSize = 100): Promise<{
    purged: number;
    failed: number;
    remaining: number;
    backlogBefore: number;
    passes: number;
    stalled: boolean;
    heldForOpenReview: number;
    pastHardCap: number;
    heldForOpenReviewBefore: number;
  }> {
    const purgeNow = nowIso();
    const hardCutoff = daysAgoIso(ACCOUNT_DATA_RETENTION_POLICY.pendingEvidenceHardCap.daysAfterCreation);
    const limit = Math.max(1, Math.min(500, Math.floor(pageSize)));
    const backlogBefore = await this.sourceEvidenceRetentionRepository.countExpiredSourceEvidence(purgeNow, hardCutoff);
    const heldBefore = await this.sourceEvidenceRetentionRepository.countOverdueHeldSourceEvidence(purgeNow, hardCutoff);
    let purged = 0;
    let passes = 0;
    const failedEvidenceIds = new Set<string>();
    let cursor: { retentionExpiresAt: string; createdAt: string; id: string } | null = null;
    while (true) {
      const expired = await this.sourceEvidenceRetentionRepository.listExpiredSourceEvidence({
        now: purgeNow,
        hardCutoff,
        limit,
        cursor,
      });
      if (!expired.length) break;
      passes += 1;
      for (const evidence of expired) {
        try {
          if (evidence.storageProvider === FILESYSTEM_EVIDENCE_PROVIDER) {
            await fs.promises.rm(this.getSourceEvidenceFilePath(evidence.objectPath), { force: true });
          } else if (evidence.storageProvider === SUPABASE_EVIDENCE_PROVIDER) {
            await this.removeSupabaseSourceEvidence(evidence.objectPath);
          }
          await this.sourceEvidenceRetentionRepository.markSourceEvidenceDeleted({
            id: evidence.id,
            deletionToken: evidence.deletionToken,
            now: purgeNow,
            hardCutoff,
            deletedAt: nowIso(),
          });
          purged += 1;
          failedEvidenceIds.delete(evidence.id);
        } catch (error) {
          failedEvidenceIds.add(evidence.id);
          logger.warn("Source evidence retention purge failed", {
            evidenceId: evidence.id,
            error: error instanceof Error ? redactSecrets(error.message) : "unknown",
          });
        }
      }
      const last = expired[expired.length - 1]!;
      cursor = {
        retentionExpiresAt: last.retentionExpiresAt,
        createdAt: last.createdAt,
        id: last.id,
      };
      if (expired.length < limit) break;
    }
    const remaining = await this.sourceEvidenceRetentionRepository.countExpiredSourceEvidence(purgeNow, hardCutoff);
    const heldAfter = await this.sourceEvidenceRetentionRepository.countOverdueHeldSourceEvidence(purgeNow, hardCutoff);
    const stalled = remaining > 0 && purged === 0;
    return {
      purged,
      failed: failedEvidenceIds.size,
      remaining,
      backlogBefore,
      passes,
      stalled,
      heldForOpenReview: heldAfter.heldForOpenReview,
      pastHardCap: heldAfter.pastHardCap,
      heldForOpenReviewBefore: heldBefore.heldForOpenReview,
    };
  }

  async runPrivacyRetention() {
    const asOf = nowIso();
    const sessionLimitEnforcement = await this.accountSessionRepository.revokeExcessActiveSessions({
      now: asOf,
      maxActiveSessions: MAX_ACTIVE_SESSIONS_PER_ACCOUNT,
    });
    const cutoffs = {
      authSessionCutoff: daysAgoIso(
        ACCOUNT_DATA_RETENTION_POLICY.authSessions.daysAfterExpiryOrRevocation,
        asOf,
      ),
      providerRevocationCutoff: daysAgoIso(
        ACCOUNT_DATA_RETENTION_POLICY.revokedProviderSessions.globallyRevokedRowsDaysAfterRevocation,
        asOf,
      ),
      stripePayloadCutoff: daysAgoIso(
        ACCOUNT_DATA_RETENTION_POLICY.stripeWebhookPayloads.daysAfterReceipt,
        asOf,
      ),
      stripeEnvelopeCutoff: daysAgoIso(
        ACCOUNT_DATA_RETENTION_POLICY.stripeWebhookEventEnvelope.daysAfterReceipt,
        asOf,
      ),
      securityFingerprintCutoff: daysAgoIso(
        ACCOUNT_DATA_RETENTION_POLICY.securityRequestFingerprints.daysAfterCreation,
        asOf,
      ),
      securityEnvelopeCutoff: daysAgoIso(
        ACCOUNT_DATA_RETENTION_POLICY.securityAuditEnvelope.daysAfterCreation,
        asOf,
      ),
      reviewedLocationCutoff: daysAgoIso(
        ACCOUNT_DATA_RETENTION_POLICY.reviewedSubmissionExactLocation.daysAfterReview,
        asOf,
      ),
      migrationQuarantineCutoff: daysAgoIso(
        ACCOUNT_DATA_RETENTION_POLICY.migrationQuarantinePayload.daysAfterQuarantine,
        asOf,
      ),
      deletionNotificationEventCutoff: daysAgoIso(
        ACCOUNT_DATA_RETENTION_POLICY.accountDeletion.completionNotification.nonIdentifyingWebhookReceiptDays,
        asOf,
      ),
    };
    const totals: PrivacyRetentionMutationCounts = {
      authSessionsDeleted: 0,
      providerRevocationsDeleted: 0,
      stripePayloadsRedacted: 0,
      stripeEnvelopesDeleted: 0,
      securityFingerprintsRedacted: 0,
      securityEnvelopesDeleted: 0,
      reviewedLocationsPurged: 0,
      migrationQuarantinePayloadsRedacted: 0,
      deletionNotificationEventsDeleted: 0,
    };
    const seenBatchObjects = new WeakSet<object>();
    let batches = 0;
    let processedCount = 0;
    let hasMore = false;
    let hasActionableMore = false;
    let stalled = false;
    let batchBudgetExhausted = false;
    let stripeEnvelopeDeletionDeferred = true;
    let stripeEnvelopesAwaitingTombstoneInBatch = 0;
    let stopReason:
      | "complete"
      | "deferred_stripe_envelopes"
      | "actionable_stall"
      | "duplicate_batch"
      | "batch_budget_exhausted" = "complete";

    for (let batch = 0; batch < MAX_PRIVACY_RETENTION_BATCHES; batch += 1) {
      const result = await this.privacyRetentionRepository.prunePrivacyRetention({
        asOf,
        ...cutoffs,
        batchLimit: PRIVACY_RETENTION_BATCH_SIZE,
      });
      if (seenBatchObjects.has(result)) {
        stalled = true;
        stopReason = "duplicate_batch";
        break;
      }
      seenBatchObjects.add(result);

      const batchMutationCount = PRIVACY_RETENTION_MUTATION_KEYS.reduce(
        (total, key) => total + result[key],
        0,
      );
      if (
        batchMutationCount !== result.processedCount
        || result.progressed !== (result.processedCount > 0)
      ) {
        throw new AppError("Privacy-retention progress was inconsistent.", 500, undefined, false);
      }

      batches += 1;
      processedCount += result.processedCount;
      for (const key of PRIVACY_RETENTION_MUTATION_KEYS) totals[key] += result[key];
      hasMore = result.hasMore;
      hasActionableMore = result.hasActionableMore;
      stalled = result.stalled;
      stripeEnvelopeDeletionDeferred = result.stripeEnvelopeDeletionDeferred;
      stripeEnvelopesAwaitingTombstoneInBatch = result.stripeEnvelopesAwaitingTombstoneInBatch;

      if (!result.hasActionableMore) {
        stopReason = result.hasMore ? "deferred_stripe_envelopes" : "complete";
        break;
      }
      if (!result.progressed) {
        stalled = true;
        stopReason = "actionable_stall";
        break;
      }
      if (batch === MAX_PRIVACY_RETENTION_BATCHES - 1) {
        batchBudgetExhausted = true;
        stopReason = "batch_budget_exhausted";
      }
    }

    return {
      asOf,
      policyVersion: ACCOUNT_DATA_RETENTION_POLICY.version,
      sessionLimitEnforcement,
      ...totals,
      processedCount,
      progressed: processedCount > 0,
      hasMore,
      hasActionableMore,
      stalled,
      stopReason,
      batches,
      batchSize: PRIVACY_RETENTION_BATCH_SIZE,
      batchBudget: MAX_PRIVACY_RETENTION_BATCHES,
      batchBudgetExhausted,
      stripeEnvelopeDeletionDeferred,
      stripeEnvelopesAwaitingTombstoneInBatch,
      migrationBackupsDeleted: this.config.DATABASE_PATH
        ? (await import("../../db/database.js")).purgeExpiredMigrationBackups(this.config.DATABASE_PATH)
        : 0,
    };
  }

  async listAccountDeletionRequests(admin: BusinessAccount, query: AdminPaginationInput = { limit: 50, offset: 0 }) {
    if (!this.isAdmin(admin)) throw new AppError("Admin access required.", 403);
    const asOf = nowIso();
    const [requests, total, queueSummary, notificationSummary] = await Promise.all([
      this.accountDeletionQueueRepository.listAccountDeletionRequests({ ...query, asOf }),
      this.accountDeletionQueueRepository.countAccountDeletionRequests(),
      this.accountDeletionQueueRepository.getAccountDeletionQueueSummary(asOf),
      this.accountDeletionQueueRepository.getAccountDeletionNotificationQueueSummary(asOf),
    ]);
    return {
      requests,
      total,
      summary: {
        asOf,
        ...queueSummary,
        notifications: notificationSummary,
      },
      pagination: { ...query, hasMore: query.offset + requests.length < total },
    };
  }

  async executeAccountDeletion(admin: BusinessAccount, requestId: string, reason: string) {
    if (!this.isAdmin(admin)) throw new AppError("Admin access required.", 403);
    const request = await this.accountDeletionQueueRepository.getAccountDeletionRequestById(requestId);
    if (!request) throw new AppError("Deletion request not found.", 404);
    if (!['pending_review', 'approved', 'failed', 'processing'].includes(String(request.status))) {
      throw new AppError("This account deletion request has already been processed.", 409);
    }
    if (new Date(String(request.execute_after)).getTime() > Date.now()) {
      throw new AppError("The seven-day account deletion safety window has not finished yet.", 409);
    }
    const account = await this.accountSessionRepository.getAccountById(String(request.user_id));
    if (!account) throw new AppError("Account not found.", 404);
    await this.assertAdminControlPreserved(admin, account);
    const canonicalProductionRuntime = isCanonicalProductionRuntime({
      nodeEnv: this.config.NODE_ENV,
      railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
    });
    const providerRehearsal = Boolean(
      this.config.ACCOUNT_DELETION_REHEARSAL_ENABLED
      || this.config.POSTGRES_RECOVERY_REHEARSAL_MODE,
    );
    const strictProductionProviderPolicy = canonicalProductionRuntime && !providerRehearsal;
    // Production deletion is irreversible across auth, billing, and evidence
    // providers. Refuse before acquiring the job or making any mutation when
    // this runtime cannot durably record the independent deletion tombstone.
    if (
      canonicalProductionRuntime &&
      !this.accountDeletionTombstoneWriter &&
      !providerRehearsal
    ) {
      throw new ExternalServiceError(
        "Independent account-deletion ledger is not configured; the request is saved for retry.",
      );
    }
    if (canonicalProductionRuntime && !providerRehearsal && !this.accountDeletionNotificationCoordinator) {
      throw new ExternalServiceError(
        "Account-deletion completion notifications are not configured; the request is saved for retry.",
      );
    }
    const startedAt = nowIso();
    const deletionClaim = {
      requestId,
      reviewedBy: admin.id,
      now: startedAt,
      staleBefore: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    const processing = this.accountDeletionNotificationCoordinator
      ? await this.accountDeletionNotificationCoordinator.beginDeletionWithPreparedNotification({
          ...deletionClaim,
          destination: account.email,
        })
      : await this.accountDeletionQueueRepository.beginAccountDeletion(deletionClaim);
    if (!processing) throw new AppError("This deletion request is already being processed.", 409);
    const attemptCount = processing.attempt_count;
    await this.accountSessionRepository.revokeUserSessionsWithSummary({ userId: account.id, revokedAt: startedAt });

    try {
      const deletedStripeCustomerSnapshot = typeof processing.stripe_customer_id_snapshot === "string"
        ? processing.stripe_customer_id_snapshot
        : null;
      const stripeCustomerNeedsDeletion = Boolean(
        account.stripeCustomerId && (
          !processing.stripe_customer_deleted_at || account.stripeCustomerId !== deletedStripeCustomerSnapshot
        ),
      );
      if (account.stripeCustomerId && stripeCustomerNeedsDeletion && !this.config.DEMO_BILLING_MODE) {
        if (!this.config.STRIPE_SECRET_KEY) {
          throw new ExternalServiceError("Stripe customer deletion is not configured; the request is saved for retry.");
        }
        const response = await fetchWithTimeout(
          `https://api.stripe.com/v1/customers/${encodeURIComponent(account.stripeCustomerId)}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${this.config.STRIPE_SECRET_KEY}` },
          },
        );
        if (!response.ok && response.status !== 404) {
          const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
          throw new ExternalServiceError("Stripe customer deletion failed; the request is saved for retry.", {
            status: response.status,
            message: redactSecrets(payload?.error?.message ?? "unknown"),
          });
        }
        const receiptRecorded = await this.accountDeletionQueueRepository.markAccountDeletionStripeCustomerDeleted({
          requestId,
          userId: account.id,
          stripeCustomerId: account.stripeCustomerId,
          attemptCount,
          now: nowIso(),
        });
        if (!receiptRecorded) {
          throw new AppError("This account deletion attempt no longer owns the request.", 409);
        }
      }

      if (account.supabaseUserId && !processing.identity_deleted_at && !this.supabase) {
        throw new ExternalServiceError("Supabase identity deletion is not configured; the request is saved for retry.");
      }
      if (account.supabaseUserId && this.supabase && !processing.identity_deleted_at) {
        const { error } = await this.supabase.auth.admin.deleteUser(account.supabaseUserId);
        const alreadyDeleted = Boolean(error && /not[ -]?found|does not exist/i.test(error.message));
        if (error && !alreadyDeleted) {
          throw new ExternalServiceError("Supabase account deletion failed; the request is saved for retry.", {
            message: redactSecrets(error.message),
          });
        }
        const receiptRecorded = await this.accountDeletionQueueRepository.markAccountDeletionIdentityDeleted({
          requestId,
          attemptCount,
          now: nowIso(),
        });
        if (!receiptRecorded) {
          throw new AppError("This account deletion attempt no longer owns the request.", 409);
        }
      }

      const evidencePageSize = 500;
      let evidenceCursor: { createdAt: string; id: string } | null = null;
      while (true) {
        const evidence = await this.sourceEvidenceRetentionRepository.listSourceEvidenceForOwner({
          ownerUserId: account.id,
          limit: evidencePageSize,
          cursor: evidenceCursor,
        });
        for (const item of evidence) {
          if (item.storageProvider === FILESYSTEM_EVIDENCE_PROVIDER) {
            await fs.promises.rm(this.getSourceEvidenceFilePath(item.objectPath), { force: true });
          } else if (item.storageProvider === SUPABASE_EVIDENCE_PROVIDER) {
            await this.removeSupabaseSourceEvidence(item.objectPath);
          }
        }
        if (evidence.length < evidencePageSize) break;
        const last = evidence[evidence.length - 1]!;
        evidenceCursor = { createdAt: last.createdAt, id: last.id };
      }
      if (!processing.deletion_tombstone_recorded_at) {
        if (this.accountDeletionTombstoneWriter) {
          const tombstoneRecordedAt = nowIso();
          await this.accountDeletionTombstoneWriter({
            requestId,
            userId: account.id,
            completedAt: tombstoneRecordedAt,
          });
          const receiptRecorded = await this.accountDeletionQueueRepository.markAccountDeletionTombstoneRecorded({
            requestId,
            attemptCount,
            recordedAt: tombstoneRecordedAt,
            now: nowIso(),
          });
          if (!receiptRecorded) {
            throw new AppError("This account deletion attempt no longer owns the request.", 409);
          }
        }
      }
      const completedAt = nowIso();
      const summary = await this.accountPrivacyRepository.executeAccountAnonymisation({
        requestId,
        attemptCount,
        reviewedBy: admin.id,
        now: completedAt,
        completionNotificationDisposition: this.accountDeletionNotificationCoordinator ? "enqueue_live" : "none",
        ...(this.accountDeletionNotificationCoordinator
          ? {
              completionNotificationRetentionExpiresAt:
                this.accountDeletionNotificationCoordinator.completionRetentionExpiresAt(completedAt),
            }
          : {}),
        providerPolicy: {
          requireTombstoneReceipt: strictProductionProviderPolicy,
          allowUnconfirmedStripeDeletion: !strictProductionProviderPolicy
            && (this.config.DEMO_BILLING_MODE || providerRehearsal),
        },
      });
      await this.auditSecurity({
        actor: admin,
        action: "account_deletion_executed",
        targetType: "account_deletion_request",
        targetId: requestId,
        metadata: {
          anonymisedAccount: typeof summary.surrogatePublicId === "string" ? summary.surrogatePublicId : "deleted-account",
          reason,
        },
      });
      return {
        requestId,
        status: "completed",
        completionNotificationStatus: this.accountDeletionNotificationCoordinator ? "pending" : "not_configured",
        summary,
      };
    } catch (error) {
      const message = error instanceof Error ? redactSecrets(error.message) : "Account deletion failed";
      const failurePersisted = await this.accountDeletionQueueRepository.failAccountDeletion({
        requestId,
        attemptCount,
        error: message,
        now: nowIso(),
      });
      await this.auditSecurity({
        actor: admin,
        action: "account_deletion_failed",
        targetType: "account_deletion_request",
        targetId: requestId,
        metadata: { reason, error: message, failurePersisted },
      });
      if (!failurePersisted) {
        throw new AppError("This account deletion attempt no longer owns the request.", 409);
      }
      throw error;
    }
  }

  async processAccountDeletionCompletionNotifications(limit = 20) {
    if (!this.accountDeletionNotificationCoordinator) {
      return {
        configured: false,
        claimed: 0,
        accepted: 0,
        delivered: 0,
        deferred: 0,
        failed: 0,
        manualReview: 0,
        recipientsPurged: 0,
        securePurgeCheckpointPendingCount: 0,
      };
    }
    return {
      configured: true,
      ...(await this.accountDeletionNotificationCoordinator.processDue({ limit })),
    };
  }

  async retryFailedAccountDeletionCompletionNotification(
    admin: BusinessAccount,
    requestId: string,
    reason: string,
  ) {
    if (!this.isAdmin(admin)) throw new AppError("Admin access required.", 403);
    if (!this.accountDeletionNotificationCoordinator) {
      throw new AppError("Account deletion notifications are not configured.", 503);
    }
    const notice = await this.accountDeletionQueueRepository.getAccountDeletionCompletionOutbox(requestId);
    if (!notice) throw new AppError("Account deletion completion notice not found.", 404);
    const retried = await this.accountDeletionQueueRepository.retryFailedAccountDeletionNotification({
      requestId,
      now: nowIso(),
      audit: {
        id: crypto.randomUUID(),
        actorUserId: admin.id,
        actorRole: admin.role,
        reason,
      },
    });
    if (!retried) {
      throw new AppError(
        "Only a confirmed pre-acceptance failure with an unexpired encrypted recipient can be retried automatically.",
        409,
      );
    }
    return {
      requestId,
      status: retried.status,
      nextAttemptAt: retried.next_attempt_at,
    };
  }

  async resolveAccountDeletionCompletionNotification(
    admin: BusinessAccount,
    requestId: string,
    resolution: "verified_delivered" | "undeliverable",
    reason: string,
  ) {
    if (!this.isAdmin(admin)) throw new AppError("Admin access required.", 403);
    const notice = await this.accountDeletionQueueRepository.getAccountDeletionCompletionOutbox(requestId);
    if (!notice) throw new AppError("Account deletion completion notice not found.", 404);
    const resolvedAt = nowIso();
    const resolved = await this.accountDeletionQueueRepository.resolveAccountDeletionNotificationManualReview({
      requestId,
      resolution,
      now: resolvedAt,
      audit: {
        id: crypto.randomUUID(),
        actorUserId: admin.id,
        actorRole: admin.role,
        reason,
      },
    });
    if (!resolved) {
      throw new AppError(
        "Only an unresolved manual-review, failed, or retention-expired completion notice can be resolved; verified delivery also requires a provider message ID.",
        409,
      );
    }
    const securePurgeCheckpointSucceeded = await this.accountDeletionQueueRepository
      .checkpointAccountDeletionNotificationSecrets(this.performAccountDeletionSecretPhysicalCheckpoint);
    return {
      requestId,
      status: resolved.status,
      resolution,
      resolvedAt,
      securePurgeCheckpointSucceeded,
    };
  }

  async handleResendAccountDeletionWebhook(input: {
    rawBody: Buffer;
    id: string | undefined;
    timestamp: string | undefined;
    signature: string | undefined;
  }): Promise<{ received: true; duplicate: boolean; matched: boolean }> {
    if (!this.accountDeletionNotificationCoordinator || !this.config.RESEND_WEBHOOK_SIGNING_SECRET) {
      throw new AppError("Account deletion notification webhook is not configured.", 503);
    }
    return this.accountDeletionNotificationCoordinator.handleVerifiedWebhook({
      rawBody: input.rawBody,
      headers: {
        id: input.id,
        timestamp: input.timestamp,
        signature: input.signature,
      },
      signingSecret: this.config.RESEND_WEBHOOK_SIGNING_SECRET,
    });
  }

  async answerPriceConfirmation(
    account: BusinessAccount,
    priceRecordId: string,
    input: PriceConfirmationInput,
  ) {
    this.assertCanCommunityVerify(account);
    const isVenueManagerPrice = priceRecordId.startsWith("bar_beer:");
    const record = isVenueManagerPrice
      ? await this.publicPriceRepository.getCurrentVenueManagerPriceRecordById(priceRecordId)
      : await this.publicPriceRepository.getPriceRecordById(priceRecordId);
    const canSeeExactPrice = record
      ? isFullAccess(account, this.isAdmin(account)) || canFreeUserSeeRecord(record)
      : false;
    if (!record || !isActionablePriceConfirmationRecord(record) || !canSeeExactPrice) {
      throw new AppError(
        "That public on-tap pint price is not available for confirmation. Refresh the venue and try again.",
        404,
      );
    }

    const canonicalVenueId = await this.venueIdentityRepository.getCanonicalVenueId(record.venueId);
    const isCurrentRecord = isVenueManagerPrice || (
      await this.publicPriceRepository.getCurrentCommunityPriceRecordById(record.id)
    ) !== null;
    if (!isCurrentRecord) {
      throw new AppError(
        "That price is no longer the current public record. Refresh the venue before confirming it.",
        409,
      );
    }

    const priceVersion = priceConfirmationVersion(record);
    const shouldRecordAnswer = input.outcome !== "didnt_order" || (
      await this.accountProfilePreferencesRepository.getAccountPrivacySettings(account.id) ??
      await this.accountProfilePreferencesRepository.getDefaultAccountPrivacySettings(account.id)
    ).optionalAnalyticsEnabled;
    const wrongPriceResult = input.outcome === "no"
      ? await this.reportWrongPrice(account, {
          anonymousSessionId: null,
          venueId: canonicalVenueId,
          venueName: record.venueName,
          priceRecordId: record.id,
          beerName: record.beerName,
          reason: "price_changed",
          notes: null,
          sourcePhotoDataUrl: null,
          sourcePhotoUrl: null,
        })
      : null;
    const event = shouldRecordAnswer
      ? await this.activityAuditRepository.recordIdempotentEvent({
          id: priceConfirmationEventId(account.id, record.id, priceVersion, input.outcome),
          userId: account.id,
          anonymousSessionId: null,
          eventType: "price_confirmation_answered",
          venueId: canonicalVenueId,
          beerId: record.normalizedBeerId ?? normalizeTrackedBeerId(record.beerName),
          suburb: record.suburb,
          metadata: sanitizeEventMetadata({
            outcome: input.outcome,
            priceRecordId: record.id,
            priceVersion,
            beerName: record.beerName,
            servingSize: record.servingSize,
            sourceType: record.sourceType,
            ...(input.outcome === "didnt_order" ? { privacyScope: "optional_analytics" } : {}),
          }),
          createdAt: nowIso(),
        })
      : null;

    return {
      priceRecordId: record.id,
      priceVersion,
      outcome: input.outcome,
      recordedAt: event?.record.createdAt ?? null,
      idempotentReplay: event?.outcome === "duplicate",
      analyticsRecorded: event !== null,
      publicTrustMutated: wrongPriceResult?.markedDisputed ?? false,
      wrongPriceReport: wrongPriceResult
        ? {
            id: wrongPriceResult.report.id,
            status: wrongPriceResult.report.status,
            duplicate: wrongPriceResult.duplicate,
            markedDisputed: wrongPriceResult.markedDisputed,
          }
        : null,
      message: input.outcome === "yes"
        ? "Thanks. Your confirmation was saved as durable signal-only evidence; it did not change the public verification date or confidence by itself."
        : input.outcome === "didnt_order"
          ? event
            ? "Thanks. Your optional product signal was saved without changing the price record."
            : "Got it. No price claim or optional analytics event was recorded."
          : wrongPriceResult?.message ?? "Thanks. The price was reported for review.",
    };
  }

  async reportWrongPrice(account: BusinessAccount | null, input: WrongPriceReportInput) {
    const now = nowIso();
    if (!account && !input.anonymousSessionId) {
      throw new AppError("A privacy-safe session identifier is required for anonymous reports.", 400);
    }
    const canonicalVenueId = await this.venueIdentityRepository.getCanonicalVenueId(input.venueId);
    let venueName = input.venueName;
    let beerName = input.beerName;
    if (input.priceRecordId) {
      const isVenueManagerPrice = input.priceRecordId.startsWith("bar_beer:");
      const record = isVenueManagerPrice
        ? await this.publicPriceRepository.getCurrentVenueManagerPriceRecordById(input.priceRecordId)
        : await this.publicPriceRepository.getPriceRecordById(input.priceRecordId);
      if (!record) {
        throw new AppError("That price record no longer exists. Refresh the venue before reporting it.", 404);
      }
      if (
        isVenueManagerPrice
        && (!account || !(isFullAccess(account, this.isAdmin(account)) || canFreeUserSeeRecord(record)))
      ) {
        throw new AppError("That price record no longer exists. Refresh the venue before reporting it.", 404);
      }
      const recordCanonicalVenueId = await this.venueIdentityRepository.getCanonicalVenueId(record.venueId);
      if (recordCanonicalVenueId !== canonicalVenueId) {
        throw new AppError("That price record does not belong to this venue.", 400);
      }
      venueName = record.venueName;
      beerName = record.beerName;
    }
    const sourcePhotoUrl = await this.resolveSourcePhoto(account, input);
    const result = await this.supportFeedbackRepository.createWrongPriceReport({
      id: crypto.randomUUID(),
      userId: account?.id ?? null,
      anonymousSessionId: input.anonymousSessionId,
      venueId: canonicalVenueId,
      venueName,
      priceRecordId: input.priceRecordId,
      beerName,
      reason: input.reason,
      notes: input.notes,
      sourcePhotoUrl,
      now,
    });

    if (!result.duplicate) {
      await this.trackEvent(account, {
        anonymousSessionId: input.anonymousSessionId,
        eventType: "wrong_price_reported",
        venueId: canonicalVenueId,
        beerId: beerName ? normalizeTrackedBeerId(beerName) : null,
        suburb: null,
        metadata: {
          reportId: result.report.id,
          reason: input.reason,
          hasSourcePhoto: Boolean(sourcePhotoUrl),
          markedDisputed: result.markedDisputed,
        },
      });
    }

    return {
      ...result,
      message: result.duplicate
        ? "You already have an open report for this price. The original report remains in review."
        : result.markedDisputed
        ? "Report saved. This price is now marked for review."
        : "Report saved for review. One report will not remove high-confidence data by itself.",
    };
  }

  async createVenueRequest(account: BusinessAccount | null, input: VenueRequestInput) {
    const now = nowIso();
    const googlePlaceId = input.googlePlaceId ?? input.notes
      ?.match(/^Google Place ID:\s*([^\r\n]{1,255})$/im)?.[1]
      ?.trim() ?? null;
    const result = await this.venueRequestRepository.createOrGetVenueRequest({
      id: crypto.randomUUID(),
      userId: account?.id ?? null,
      anonymousSessionId: input.anonymousSessionId,
      requestType: input.requestType,
      venueId: input.venueId,
      venueName: input.venueName,
      googlePlaceId,
      beerName: input.beerName,
      suburb: input.suburb,
      notes: input.notes,
      now,
    });
    const { request } = result;
    const isBeerRequest = input.requestType === "missing_beer" || input.requestType === "verify_beer_at_venue";

    if (!result.duplicate) {
      await this.trackEvent(account, {
        anonymousSessionId: input.anonymousSessionId,
        eventType: isBeerRequest ? "beer_requested" : "venue_requested",
        venueId: input.venueId,
        beerId: input.beerName ? normalizeTrackedBeerId(input.beerName) : null,
        suburb: input.suburb,
        metadata: {
          requestId: request.id,
          requestType: input.requestType,
          venueName: input.venueName,
          hasGooglePlaceId: Boolean(googlePlaceId),
        },
      });
    }

    const message = input.requestType === "missing_venue"
      ? result.duplicate
        ? `${input.venueName || "This venue"} is already in the admin review queue.`
        : `${input.venueName || "This venue"} has been added to the admin review queue.`
      : "Request saved. Admin can turn high-demand requests into missions.";

    return {
      request,
      duplicate: result.duplicate,
      message,
    };
  }

  async createVenueInterest(account: BusinessAccount | null, input: VenueInterestInput) {
    const now = nowIso();
    const interest = await this.venuePartnerRepository.createVenueInterest({
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

    await this.trackEvent(account, {
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

  async listSubmissions(account: BusinessAccount | null, input: { status?: string | undefined; mine: boolean; limit: number; offset?: number; includeReviewData?: boolean | undefined }) {
    if (!account) {
      throw new AppError("Login required.", 401);
    }

    const isAdmin = this.isAdmin(account);
    const records = await this.communitySubmissionRepository.listSubmissions({
      ...(input.mine || !isAdmin ? { userId: account.id } : {}),
      ...(input.status ? { status: input.status as BusinessSubmission["status"] } : {}),
      limit: input.limit,
      offset: input.offset ?? 0,
    });
    const includeReviewData = input.includeReviewData && (isAdmin || input.mine);
    return records.map((record) => includeReviewData
      ? { ...record.submission, items: record.items }
      : record.submission);
  }

  async getSubmissionsPage(account: BusinessAccount | null, input: { status?: string | undefined; mine: boolean; limit: number; offset: number; includeReviewData?: boolean | undefined }) {
    const submissions = await this.listSubmissions(account, input);
    if (!account) throw new AppError("Login required.", 401);
    const isAdmin = this.isAdmin(account);
    const filters = {
      ...(input.mine || !isAdmin ? { userId: account.id } : {}),
      ...(input.status ? { status: input.status as never } : {}),
    };
    const total = await this.communitySubmissionRepository.countSubmissions(filters);
    return {
      submissions,
      pagination: { total, limit: input.limit, offset: input.offset, hasMore: input.offset + submissions.length < total },
    };
  }

  getCommunityVerificationCandidates(
    account: BusinessAccount,
    input: { limit: number; offset: number },
  ) {
    return this.getCommunityVerificationCandidatesAsync(account, input);
  }

  private async getCommunityVerificationCandidatesAsync(
    account: BusinessAccount,
    input: { limit: number; offset: number },
  ) {
    this.assertCanCommunityVerify(account);
    const rawCandidates = await this.communitySubmissionRepository.listCommunityVerificationCandidates({
      verifierUserId: account.id,
      limit: input.limit,
      offset: input.offset,
    });
    const candidates = await Promise.all(rawCandidates.map(async (submission) => ({
      id: submission.id,
      venueId: submission.venueId,
      venueName: submission.venueName,
      suburb: submission.suburb,
      submissionType: submission.submissionType,
      status: submission.status,
      observedAt: submission.observedAt,
      createdAt: submission.createdAt,
      hasSourceEvidence: submission.hasSourceEvidence,
      confirmationCount: await this.communitySubmissionRepository.countConfirmedVerificationsForSubmission(submission.id),
      items: submission.items.map((item) => ({
        beerName: item.beerName,
        servingSize: item.servingSize,
        price: item.price,
        isHappyHourPrice: item.isHappyHourPrice,
        happyHourDetails: redactUserVisibleFreeText(item.happyHourDetails),
        isOnTap: item.isOnTap,
      })),
      verificationPath: `/api/business/submissions/${encodeURIComponent(submission.id)}/verifications`,
    })));
    const total = await this.communitySubmissionRepository.countCommunityVerificationCandidates(account.id);
    return {
      candidates,
      pagination: {
        total,
        limit: input.limit,
        offset: input.offset,
        hasMore: input.offset + candidates.length < total,
      },
      privacyCopy: "Candidate rows exclude submitter identity, private evidence, upload location, notes, and reviewer-only fields.",
    };
  }

  private assertCanCommunityVerify(account: BusinessAccount): void {
    if (account.status === "suspended") {
      throw new AppError("Suspended accounts cannot verify venue data.", 403);
    }
    this.requireVerifiedEmail(account, "Verify your email before verifying venue data.");
    this.requireCurrentLegalAcceptance(account);
    if (!account.ageConfirmedAt) {
      throw new AppError("Confirm you are 18+ before verifying venue data.", 403);
    }
  }

  private async hasUnapprovedCatalogItems(items: BusinessSubmissionItem[]): Promise<boolean> {
    for (const item of items) {
      if (
        item.requiresCatalogApproval
        && !(this.beerCatalogRepository && await this.beerCatalogRepository.isActiveBeer(item.normalizedBeerId))
      ) {
        return true;
      }
    }
    return false;
  }

  async verifySubmission(account: BusinessAccount, submissionId: string, input: VerificationInput) {
    this.assertCanCommunityVerify(account);

    const submission = await this.communitySubmissionRepository.getSubmissionById(submissionId);
    if (!submission) {
      throw new AppError("Submission not found.", 404);
    }

    if (submission.submission.userId === account.id) {
      throw new AppError("You cannot verify your own upload.", 403);
    }

    if (submission.submission.status !== "pending" && submission.submission.status !== "needs_more_evidence") {
      throw new AppError("Only pending submissions can be community verified.", 409);
    }

    if (await this.communitySubmissionRepository.getVerificationByUserAndSubmission({
      verifierUserId: account.id,
      submissionId,
    })) {
      throw new AppError("You have already verified this upload.", 409);
    }

    const verification = await this.communitySubmissionRepository.createVerification({
      id: crypto.randomUUID(),
      verifierUserId: account.id,
      submissionId,
      result: input.result,
      notes: input.notes,
      now: nowIso(),
    });

    await this.trackEvent(account, {
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
    await this.recordUserActivity({
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
      ? await this.communitySubmissionRepository.countConfirmedVerificationsForSubmission(submissionId)
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

  async reviewSubmission(admin: BusinessAccount, submissionId: string, input: ReviewSubmissionInput) {
    const submission = await this.communitySubmissionRepository.getSubmissionById(submissionId);

    if (!submission) {
      throw new AppError("Submission not found.", 404);
    }

    if (submission.submission.userId === admin.id) {
      throw new AppError("Admins cannot review their own submissions.", 403);
    }

    if (submission.submission.status !== "pending" && submission.submission.status !== "needs_more_evidence") {
      throw new AppError("Submission has already been reviewed.", 409);
    }

    if (input.status === "approved" && await this.hasUnapprovedCatalogItems(submission.items)) {
      throw new AppError(
        "Approve, merge, or reject every new beer name in the catalogue before publishing this submission.",
        409,
      );
    }

    const suggestedPoints = await this.calculatePoints(submission.submission, submission.items);
    const requestedPoints = input.pointsAwarded ?? suggestedPoints;
    const points = submission.submission.pointsEligibleByLocation
      ? roundPoints(Math.min(requestedPoints, suggestedPoints))
      : 0;
    const reviewedAt = nowIso();
    const reportTimezone = this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE;
    const reviewedMonthKey = getZonedMonthKey(new Date(reviewedAt), reportTimezone);
    let result: { submission: BusinessSubmission; pointsAwarded: number; account: BusinessAccount };
    try {
      if (input.status === "approved") {
        const [snapshot, confirmedVerificationCount] = await Promise.all([
          this.communitySubmissionRepository.getApprovalSnapshot(submissionId),
          this.communitySubmissionRepository.countConfirmedVerificationsForSubmission(submissionId),
        ]);
        const reviewConfidence: ConfidenceLabel = snapshot.evidenceDecisions.length > 0
          ? "photo_verified"
          : confirmedVerificationCount >= 2
            ? "community_confirmed"
            : "admin_verified";
        const approved = await this.communitySubmissionRepository.approveAndPublishSubmission({
          approvalId: `submission-approval-${crypto.createHash("sha256").update(submissionId).digest("hex")}`,
          submissionId,
          reviewerId: admin.id,
          catalogDecisions: snapshot.catalogDecisions,
          missionDecision: snapshot.missionDecision,
          venueDecision: snapshot.venueDecision,
          evidenceDecisions: snapshot.evidenceDecisions,
          pointsAwarded: points,
          confidence: reviewConfidence,
          now: reviewedAt,
          monthKey: reviewedMonthKey,
          premiumUntil: getZonedMonthRangeIso(reviewedMonthKey, reportTimezone).endIso,
          contributorUnlockPoints: this.config.CONTRIBUTOR_UNLOCK_POINTS,
        });
        const account = await this.accountSessionRepository.getAccountById(approved.submitter.id);
        if (!account) throw new AppError("Submitter not found.", 404);
        result = { submission: approved.submission, pointsAwarded: approved.pointsAwarded, account };
      } else {
        const reviewed = await this.communitySubmissionRepository.reviewSubmission({
          submissionId,
          reviewerId: admin.id,
          status: input.status,
          rejectionReason: input.rejectionReason,
          fraudFlagged: input.fraudFlagged || input.status === "fraud_flagged",
          now: reviewedAt,
          monthKey: reviewedMonthKey,
        });
        const account = await this.accountSessionRepository.getAccountById(reviewed.submitter.id);
        if (!account) throw new AppError("Submitter not found.", 404);
        result = { submission: reviewed.submission, pointsAwarded: 0, account };
      }
    } catch (error) {
      if (error instanceof MissionReservationError) {
        throw new AppError(error.message, 409);
      }
      throw error;
    }
    await this.auditSecurity({
      actor: admin,
      action: "admin_submission_review",
      targetType: "submission",
      targetId: submissionId,
      metadata: {
        status: input.status,
        fraudFlagged: input.status === "fraud_flagged" || input.fraudFlagged,
        pointsAwarded: input.status === "approved" ? result.pointsAwarded : 0,
        suggestedPoints,
        selfReview: submission.submission.userId === admin.id,
        pointsEligibilityReason: submission.submission.pointsEligibilityReason,
        venueId: result.submission.venueId,
      },
    });
    if (input.status !== "needs_more_evidence") {
      const eventType: EventTrackInput["eventType"] =
        input.status === "approved" ? "submission_approved" : "submission_rejected";
      await this.trackEvent(result.account, {
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
          reviewOutcome: input.status === "disputed" ? "disputed" : input.status,
        },
      });
    }

    if (result.account.subscriptionStatus === "contributor_unlocked" && result.pointsAwarded > 0) {
      await this.trackEvent(result.account, {
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

    if (input.status === "approved" && submission.submission.missionId) {
      try {
        await this.runMissionMaintenance({ forceRefresh: true });
      } catch (error) {
        logger.error("Mission maintenance failed after an approved submission", {
          submissionId,
          missionId: submission.submission.missionId,
          error: error instanceof Error ? redactSecrets(error.message) : "Unknown mission maintenance failure",
        });
      }
    }

    return {
      ...result,
      account: sanitizeAccount(result.account),
    };
  }

  async calculatePoints(submission: BusinessSubmission, items: BusinessSubmissionItem[]): Promise<number> {
    const [lastVerifiedAt, publishedFlags] = await Promise.all([
      this.venueDataReadRepository.getLatestVenueDataTimestamp(submission.venueId),
      Promise.all(items.map((item) => this.venueDataReadRepository.venueHasPublishedBeerRecord({
        venueId: submission.venueId,
        beerName: item.beerName,
        normalizedBeerId: item.normalizedBeerId,
      }))),
    ]);
    const freshnessPoints = this.calculateFreshnessPoints(lastVerifiedAt);
    const includesNewDrink = publishedFlags.some((published) => !published);

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

  async listVenues(
    query: string | undefined,
    limit: number,
    account: BusinessAccount | null = null,
  ): Promise<VenueRow[]> {
    return (await this.listVenuesPage(query, limit, 0, account)).venues;
  }

  private async attachVenueBeerKeys(venues: VenueRow[], hasFullAccess: boolean): Promise<VenueRow[]> {
    if (venues.length === 0) {
      return venues;
    }
    const beerKeysByVenue = await this.publicVenueDirectoryRepository.listPublicVenueBeerKeys(
      venues.map((venue) => venue.id),
    );
    return venues.map((venue) => ({
      ...venue,
      beerKeys: (beerKeysByVenue.get(venue.id) ?? []).filter(
        (beerKey) => hasFullAccess || FREE_PREVIEW_BEER_KEYS.has(beerKey),
      ),
    }));
  }

  private defaultPublicVenueTierMetadata(): PublicVenueTierMetadata {
    return {
      membershipTier: "basic",
      highlightedName: false,
      premiumBadge: null,
      promoted: false,
      featuredSpecialEligible: false,
      acceptsPintPathCodes: false,
    };
  }

  private publicVenueTierMetadata(
    profile: BarProfilePublicMetadata | BarProfile | null | undefined,
  ): PublicVenueTierMetadata {
    if (!this.config.COMMERCIAL_LAUNCH_ENABLED || !profile?.active) {
      return this.defaultPublicVenueTierMetadata();
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

  private async loadPublicVenueTierMetadata(
    venueIds: readonly string[],
  ): Promise<Map<string, PublicVenueTierMetadata>> {
    const uniqueVenueIds = Array.from(new Set(venueIds));
    if (!this.config.COMMERCIAL_LAUNCH_ENABLED) {
      return new Map(uniqueVenueIds.map((venueId) => [venueId, this.defaultPublicVenueTierMetadata()]));
    }

    const profiles = await this.venueInventoryRepository.listBarProfilePublicMetadata(uniqueVenueIds);
    return new Map(uniqueVenueIds.map((venueId) => [
      venueId,
      this.publicVenueTierMetadata(profiles.get(venueId)),
    ]));
  }

  private createPublicVenueTierMetadataAttacher(): (venues: VenueRow[]) => Promise<VenueRow[]> {
    const metadataByVenueId = new Map<string, PublicVenueTierMetadata>();
    return async (venues) => {
      const missingVenueIds = Array.from(new Set(
        venues.map((venue) => venue.id).filter((venueId) => !metadataByVenueId.has(venueId)),
      ));
      if (missingVenueIds.length > 0) {
        const loaded = await this.loadPublicVenueTierMetadata(missingVenueIds);
        for (const venueId of missingVenueIds) {
          metadataByVenueId.set(
            venueId,
            loaded.get(venueId) ?? this.defaultPublicVenueTierMetadata(),
          );
        }
      }
      return venues.map((venue) => ({
        ...venue,
        ...metadataByVenueId.get(venue.id),
      }));
    };
  }

  async listVenuesPage(
    query: string | undefined,
    limit: number,
    offset = 0,
    account: BusinessAccount | null = null,
  ): Promise<{
    venues: VenueRow[];
    pagination: { total: number; limit: number; offset: number; hasMore: boolean };
  }> {
    const hasFullAccess = isFullAccess(account, account ? this.isAdmin(account) : false);
    const normalizedLimit = Math.min(1000, Math.max(1, limit));
    const normalizedOffset = Math.max(0, offset);
    const attachPublicVenueTierMetadata = this.createPublicVenueTierMetadataAttacher();
    const deduplicateLocalVenues = async (venues: VenueRow[]) => this.mergeVenueRows(
      await attachPublicVenueTierMetadata(venues),
      [],
      venues.length,
      false,
    );
    if (!this.supabase || this.config.RESTORE_REHEARSAL_MODE) {
      const rawQuery = query?.trim();
      const labelStem = rawQuery?.split("·")[0] ?? "";
      const normalizedQuery = (labelStem.split(",")[0] ?? "").trim();
      const rawDirectory = await this.publicVenueDirectoryRepository.listPublicVenueDirectoryPage({
        query: normalizedQuery,
        limit: -1,
        offset: 0,
      });
      const directory = await deduplicateLocalVenues(rawDirectory.venues);
      const venues = directory.slice(normalizedOffset, normalizedOffset + normalizedLimit);
      return {
        venues: await this.attachVenueBeerKeys(venues, hasFullAccess),
        pagination: {
          total: directory.length,
          limit: normalizedLimit,
          offset: normalizedOffset,
          hasMore: normalizedOffset + venues.length < directory.length,
        },
      };
    }

    const normalizedSearch = query?.trim() ?? "";
    const labelStem = normalizedSearch.split("·")[0] ?? "";
    const localSearch = (labelStem.split(",")[0] ?? "").trim();
    const rawLocalDirectory = await this.publicVenueDirectoryRepository.listPublicVenueDirectoryPage({
      query: localSearch,
      limit: -1,
      offset: 0,
    });
    let localDirectory = await deduplicateLocalVenues(rawLocalDirectory.venues);
    let localPage = localDirectory.slice(normalizedOffset, normalizedOffset + normalizedLimit);
    const allLocalVenues = localSearch
      ? (await this.publicVenueDirectoryRepository.listPublicVenueDirectoryPage({
          limit: -1,
          offset: 0,
        })).venues
      : rawLocalDirectory.venues;
    let remoteOffset = Math.max(0, normalizedOffset - localDirectory.length);
    let remoteSlots = Math.max(0, normalizedLimit - localPage.length);
    // Always fetch at least one row so the exact remote count remains available
    // while a page is still fully occupied by local-authoritative venues.
    const remoteFetchLimit = Math.max(1, remoteSlots);
    const safeQuery = normalizedSearch
      ? sanitizePostgrestIlikeTerm((labelStem.split(",")[0] ?? "").trim())
      : "";
    const operationalStatusCutoff = new Date(Date.now() - MAX_PUBLIC_VENUE_STATUS_AGE_MS).toISOString();
    const createRemoteVenueRequest = () => {
      let request = this.supabase!
        .from("venues")
        .select(REMOTE_VENUE_PUBLIC_COLUMNS, { count: "exact" })
        .eq("directory_eligible", true)
        .eq("business_status", "OPERATIONAL")
        .gte("last_checked_at", operationalStatusCutoff);
      if (safeQuery) {
        request = request.or(`name.ilike.%${safeQuery}%,suburb.ilike.%${safeQuery}%,address.ilike.%${safeQuery}%`);
      }
      return request;
    };
    const executeOrderedRemoteVenueRequest = async (request: ReturnType<typeof createRemoteVenueRequest>) => {
      const nameOrderedRequest = request.order("name", { ascending: true });
      const stableOrderedRequest = typeof (nameOrderedRequest as unknown as { order?: unknown }).order === "function"
        ? nameOrderedRequest.order("id", { ascending: true })
        : nameOrderedRequest;
      return stableOrderedRequest;
    };
    let remoteRows: VenueRow[];
    let estimatedRemoteTotal: number;
    if (allLocalVenues.length === 0) {
      const request = createRemoteVenueRequest();
      const rangedRequest = typeof (request as { range?: unknown }).range === "function"
        ? request.range(remoteOffset, remoteOffset + remoteFetchLimit - 1)
        : request.limit(remoteFetchLimit);
      const { data, error, count } = await executeOrderedRemoteVenueRequest(rangedRequest);
      if (error) {
        throw new ExternalServiceError("Failed to fetch venues", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
      }
      remoteRows = normalizePublicRemoteVenueRows(data).slice(0, remoteSlots);
      estimatedRemoteTotal = typeof count === "number"
        ? count
        : remoteOffset + remoteRows.length + (remoteRows.length >= remoteFetchLimit ? 1 : 0);
    } else {
      // Once a local directory exists, a remote row can represent the same venue
      // under a different ID. Scan a small, hard-bounded remote directory so ID
      // and identity de-duplication happen before offset pagination is applied.
      const remoteCandidates: VenueRow[] = [];
      let exactRawRemoteTotal: number | null = null;
      let completedRemoteScan = false;
      let scanOffset = 0;
      while (scanOffset < MAX_REMOTE_VENUE_SCAN_ROWS) {
        const scanLimit = Math.min(REMOTE_VENUE_SCAN_PAGE_SIZE, MAX_REMOTE_VENUE_SCAN_ROWS - scanOffset);
        const request = createRemoteVenueRequest();
        const supportsRange = typeof (request as { range?: unknown }).range === "function";
        const rangedRequest = supportsRange
          ? request.range(scanOffset, scanOffset + scanLimit - 1)
          : request.limit(scanLimit);
        const { data, error, count } = await executeOrderedRemoteVenueRequest(rangedRequest);
        if (error) {
          throw new ExternalServiceError("Failed to fetch venues", {
            message: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code,
          });
        }
        const rawRows = Array.isArray(data) ? data : [];
        const rows = normalizePublicRemoteVenueRows(rawRows);
        if (typeof count === "number") {
          exactRawRemoteTotal = count;
          if (count > MAX_REMOTE_VENUE_SCAN_ROWS) {
            throw new ExternalServiceError(
              "Failed to fetch venues",
              {
                message: `Remote venue directory exceeds the safe reconciliation limit of ${MAX_REMOTE_VENUE_SCAN_ROWS} rows.`,
                code: "VENUE_DIRECTORY_SCAN_LIMIT",
              },
              503,
            );
          }
        }
        remoteCandidates.push(...rows);
        completedRemoteScan = exactRawRemoteTotal !== null
          ? scanOffset + rawRows.length >= exactRawRemoteTotal
          : rawRows.length < scanLimit;
        if (completedRemoteScan) {
          break;
        }
        if (!supportsRange || rawRows.length === 0) {
          break;
        }
        scanOffset += rawRows.length;
      }
      if (!completedRemoteScan) {
        throw new ExternalServiceError(
          "Failed to fetch venues",
          {
            message: `Remote venue reconciliation did not complete within ${MAX_REMOTE_VENUE_SCAN_ROWS} rows.`,
            code: "VENUE_DIRECTORY_SCAN_LIMIT",
          },
          503,
        );
      }

      const remoteCandidateById = new Map(remoteCandidates.map((venue) => [venue.id, venue]));
      const remoteCandidateByIdentity = new Map(
        remoteCandidates
          .map((venue) => [venueIdentityKey(venue), venue] as const)
          .filter((entry): entry is [string, VenueRow] => entry[0] !== null),
      );
      const originalOperationalLocalIdentities = new Set<string>();
      localDirectory = localDirectory
        .map((venue) => {
          const originalIdentity = venueIdentityKey(venue);
          const matchingRemote = remoteCandidateById.get(venue.id) ??
            (originalIdentity ? remoteCandidateByIdentity.get(originalIdentity) : undefined);
          if (!matchingRemote) {
            return null;
          }
          if (originalIdentity) {
            originalOperationalLocalIdentities.add(originalIdentity);
          }
          return this.mergeVenueRows([venue], [matchingRemote], 1, false)[0] ?? null;
        })
        .filter((venue): venue is VenueRow => venue !== null);
      localPage = localDirectory.slice(normalizedOffset, normalizedOffset + normalizedLimit);
      remoteOffset = Math.max(0, normalizedOffset - localDirectory.length);
      remoteSlots = Math.max(0, normalizedLimit - localPage.length);

      const seenVenueIds = new Set(localDirectory.map((venue) => venue.id));
      const seenVenueIdentities = new Set(
        [
          ...originalOperationalLocalIdentities,
          ...localDirectory
            .map((venue) => venueIdentityKey(venue))
            .filter((identity): identity is string => identity !== null),
        ],
      );
      const uniqueRemoteRows: VenueRow[] = [];
      for (const venue of remoteCandidates) {
        const identity = venueIdentityKey(venue);
        if (seenVenueIds.has(venue.id) || (identity !== null && seenVenueIdentities.has(identity))) {
          continue;
        }
        seenVenueIds.add(venue.id);
        if (identity !== null) {
          seenVenueIdentities.add(identity);
        }
        uniqueRemoteRows.push(venue);
      }
      remoteRows = uniqueRemoteRows.slice(remoteOffset, remoteOffset + remoteSlots);
      estimatedRemoteTotal = uniqueRemoteRows.length;
    }
    const remoteRowsWithMetadata = await attachPublicVenueTierMetadata(remoteRows);
    const page = this.mergeVenueRows(
      localPage,
      remoteRowsWithMetadata,
      normalizedLimit,
      false,
    );
    const estimatedTotal = localDirectory.length + estimatedRemoteTotal;
    const hasMore = normalizedOffset + page.length < estimatedTotal;
    return {
      venues: await this.attachVenueBeerKeys(page, hasFullAccess),
      pagination: {
        total: estimatedTotal,
        limit: normalizedLimit,
        offset: normalizedOffset,
        hasMore,
      },
    };
  }

  async getPublicVenueById(venueId: string): Promise<VenueRow | null> {
    const normalizedVenueId = await this.venueIdentityRepository.getCanonicalVenueId(venueId.trim());
    if (!normalizedVenueId) {
      return null;
    }

    const cachedLocation = await this.venueIdentityRepository.getVenueLocationCache(normalizedVenueId);
    const localVenue = await this.getLocalPublicVenueById(normalizedVenueId, cachedLocation);
    if (!this.supabase || this.config.RESTORE_REHEARSAL_MODE) return localVenue;
    if (!isPostgresUuid(normalizedVenueId)) {
      if (!localVenue) return null;
      const candidates = await this.listVenuesPage(localVenue.name, 1000, 0, null);
      const localIdentity = venueIdentityKey(localVenue);
      return candidates.venues.find((venue) =>
        venue.id === normalizedVenueId ||
        (localIdentity !== null && venueIdentityKey(venue) === localIdentity)
      ) ?? null;
    }

    const { data, error } = await this.supabase
      .from("venues")
      .select(REMOTE_VENUE_PUBLIC_COLUMNS)
      .eq("id", normalizedVenueId)
      .eq("directory_eligible", true)
      .eq("business_status", "OPERATIONAL")
      .gte("last_checked_at", new Date(Date.now() - MAX_PUBLIC_VENUE_STATUS_AGE_MS).toISOString())
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
      return null;
    }

    const venue = normalizePublicRemoteVenueRow(data);
    if (!venue) {
      return null;
    }
    const now = nowIso();
    await this.venueIdentityRepository.upsertVenueLocationCache({
      venueId: venue.id,
      venueName: venue.name,
      suburb: venue.suburb,
      latitude: venue.latitude,
      longitude: venue.longitude,
      expectedUpdatedAt: cachedLocation?.updatedAt ?? null,
      now,
    });

    const remoteVenue = { ...venue, ...await this.getPublicVenueTierMetadata(venue.id) };
    return localVenue
      ? this.mergeVenueRows([localVenue], [remoteVenue], 1, false)[0] ?? localVenue
      : remoteVenue;
  }

  private async getLocalPublicVenueById(
    venueId: string,
    location: VenueLocationCache | null,
  ): Promise<VenueRow | null> {
    const profile = await this.venueInventoryRepository.getBarProfile(venueId);
    if (!profile && !location) return null;
    return {
      id: venueId,
      name: profile?.name || location?.venueName || venueId,
      address: profile?.address ?? null,
      suburb: profile?.suburb || location?.suburb || null,
      state: "VIC",
      postcode: null,
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      phone: profile?.phone ?? null,
      website: profile?.website ?? null,
      instagram: profile?.instagram ?? null,
      description: profile?.description ?? null,
      openingHours: profile?.openingHours ?? {},
      venueTags: profile?.venueTags ?? [],
      isUserSubmittedVenue: profile?.venueTags.includes("user submitted") ?? false,
      ...this.publicVenueTierMetadata(profile),
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
        redirect: "error",
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
    const duplicate = await this.venueDataReadRepository.findLikelyVenueDuplicate({ name, suburb });
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
    if (postcode !== null && !isAustralianPostcode(postcode)) {
      logger.warn("Google Places returned a malformed Australian postcode for a venue submission lookup", {
        googlePlaceId,
      });
      return null;
    }
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

  private async getPublicVenueTierMetadata(venueId: string): Promise<Pick<
    VenueRow,
    "membershipTier" | "highlightedName" | "premiumBadge" | "promoted" | "featuredSpecialEligible" | "acceptsPintPathCodes"
  >> {
    return (await this.loadPublicVenueTierMetadata([venueId])).get(venueId)
      ?? this.defaultPublicVenueTierMetadata();
  }

  async seedDemoMissions() {
    if (this.config.NODE_ENV === "production") {
      throw new AppError("Demo missions are disabled in production.", 403);
    }
    if (await this.missionLifecycleRepository.countMissions({ activeOnly: false }) > 0) {
      return { created: 0 };
    }

    const now = nowIso();
    const missions = [
      ["mission:rooftop-bar", "demo:rooftop-bar", "Rooftop Bar", "Melbourne", "no prices", 5, 2],
      ["mission:railway-hotel-south-melb", "demo:railway-south-melb", "Railway Hotel", "South Melbourne", "stale prices", 3, 1],
      ["mission:fitzroy-beer-garden", "demo:fitzroy-beer-garden", "Fitzroy Beer Garden", "Fitzroy", "missing happy hour", 4, 1],
      ["mission:brighton-pub", "demo:brighton-pub", "Brighton Pub", "Brighton", "outside dense CBD cluster", 5, 1.5],
    ] as const;

    for (const [id, venueId, venueName, suburb, reason, points, multiplier] of missions) {
      await this.missionLifecycleRepository.createMission({
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
    }

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

  private async buildAutoMissionsForVenue(
    candidate: MissionVenueCandidate,
    now: string,
  ): Promise<Array<Omit<BusinessMission, "active" | "sponsorFlag"> & { active?: boolean; sponsorFlag?: boolean }>> {
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
      const lastVerifiedAt = await this.venueInventoryRepository.getLatestVenueBeerTimestamp({
        venueId: candidate.venueId,
        venueIds: await this.venueIdentityRepository.listVenueIdentityIds(candidate.venueId),
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

  private async refreshAutoMissions(force = false): Promise<{ candidates: number; generated: number; refreshed: boolean }> {
    const state = await this.systemStateRepository.get<{ refreshedAt?: string }>(AUTO_MISSION_REFRESH_STATE_KEY);
    const lastRefreshMs = state?.value.refreshedAt ? new Date(state.value.refreshedAt).getTime() : 0;
    if (!force && Number.isFinite(lastRefreshMs) && Date.now() - lastRefreshMs < AUTO_MISSION_REFRESH_INTERVAL_MS) {
      return {
        candidates: await this.missionLifecycleRepository.countMissions({ activeOnly: false }),
        generated: 0,
        refreshed: false,
      };
    }
    const rawCandidates: MissionVenueCandidate[] = [];
    const seenRawCandidateIds = new Set<string>();
    let candidateOffset = 0;
    let candidateScanComplete = false;
    for (let pageNumber = 0; pageNumber < MAX_AUTO_MISSION_CANDIDATE_PAGES; pageNumber += 1) {
      const page = await this.missionDiscoveryAutomationRepository.listMissionVenueCandidates({
        limit: AUTO_MISSION_VENUE_PAGE_SIZE,
        offset: candidateOffset,
      });
      if (page.length === 0) {
        candidateScanComplete = true;
        break;
      }
      if (page.length > AUTO_MISSION_VENUE_PAGE_SIZE) {
        throw new AppError("Auto-mission candidate pagination returned an oversized page.", 500, undefined, false);
      }
      for (const candidate of page) {
        if (seenRawCandidateIds.has(candidate.venueId)) {
          throw new AppError("Auto-mission candidate pagination returned a duplicate venue.", 500, undefined, false);
        }
        seenRawCandidateIds.add(candidate.venueId);
      }
      rawCandidates.push(...page);
      const nextOffset = candidateOffset + page.length;
      if (nextOffset <= candidateOffset || nextOffset > MAX_AUTO_MISSION_CANDIDATE_SCAN_ROWS) {
        throw new AppError("Auto-mission candidate pagination did not make progress.", 500, undefined, false);
      }
      if (page.length < AUTO_MISSION_VENUE_PAGE_SIZE) {
        candidateScanComplete = true;
        break;
      }
      candidateOffset = nextOffset;
    }
    if (!candidateScanComplete) {
      throw new AppError("Auto-mission candidate lookup exceeded its bounded scan budget.", 500, undefined, false);
    }
    const candidateByVenue = new Map<string, MissionVenueCandidate>();
    const newestIso = (left: string | null, right: string | null) => {
      if (!left) return right;
      if (!right) return left;
      return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
    };
    for (const candidate of rawCandidates) {
      if (this.config.NODE_ENV === "production" && candidate.venueId.trim().toLowerCase().startsWith("demo:")) {
        continue;
      }
      const venueId = await this.venueIdentityRepository.getCanonicalVenueId(candidate.venueId);
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
    const missions = (await Promise.all(candidates
      .map((candidate) => this.buildAutoMissionsForVenue(candidate, now))))
      .flat()
      .filter((mission) => mission.points > CONTRIBUTION_POINTS.veryFreshUpdate);
    if (missions.length > MAX_AUTO_MISSION_DEFINITIONS) {
      throw new AppError("Auto-mission generation exceeded its bounded replacement budget.", 500, undefined, false);
    }
    const generated = await this.missionDiscoveryAutomationRepository.replaceAutoMissions({ missions, now });
    await this.systemStateRepository.set(AUTO_MISSION_REFRESH_STATE_KEY, {
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

  private async runMissionAutomationBatches(
    label: string,
    work: () => Promise<{ changed: number; hasMore: boolean }>,
  ): Promise<number> {
    let changed = 0;
    for (let batch = 0; batch < MAX_MISSION_AUTOMATION_BATCHES; batch += 1) {
      const result = await work();
      changed += result.changed;
      if (!result.hasMore) return changed;
      if (result.changed === 0) {
        throw new AppError(`${label} did not make progress after an empty or locked batch.`, 500, undefined, false);
      }
    }
    throw new AppError(`${label} exceeded its bounded maintenance budget.`, 500, undefined, false);
  }

  async runMissionMaintenance(input: { forceRefresh?: boolean } = {}): Promise<{
    expiredAcceptances: number;
    candidates: number;
    generated: number;
    pruned: number;
    refreshed: boolean;
  }> {
    const now = nowIso();
    if (this.config.NODE_ENV === "production") {
      await this.runMissionAutomationBatches(
        "Demo mission deactivation",
        () => this.missionDiscoveryAutomationRepository.deactivateDemoMissions({
          now,
          limit: MISSION_AUTOMATION_BATCH_SIZE,
        }),
      );
    }
    const acceptedBefore = missionAcceptanceCutoff(now);
    let expiredAcceptances = 0;
    let expiryComplete = false;
    for (let batch = 0; batch < MAX_MISSION_EXPIRY_BATCHES; batch += 1) {
      const result = await this.missionLifecycleRepository.expireAcceptedMissionProgress({
        acceptedBefore,
        now,
        limit: MISSION_EXPIRY_BATCH_SIZE,
      });
      expiredAcceptances += result.expired;
      if (!result.hasMore) {
        expiryComplete = true;
        break;
      }
      if (result.expired === 0) {
        throw new AppError("Mission expiry did not make progress.", 500, undefined, false);
      }
    }
    if (!expiryComplete) {
      throw new AppError("Mission expiry exceeded its bounded maintenance budget.", 500, undefined, false);
    }
    const refreshed = await this.refreshAutoMissions(Boolean(input.forceRefresh));
    const pruned = await this.runMissionAutomationBatches(
      "Inactive auto-mission pruning",
      () => this.missionDiscoveryAutomationRepository.pruneInactiveAutoMissions({
        limit: MISSION_AUTOMATION_BATCH_SIZE,
      }),
    );
    return {
      expiredAcceptances,
      ...refreshed,
      pruned,
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

    const cachedLocation = await this.resolveMissionAreaFromLocalCache(normalizedQuery);
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

  private async resolveMissionAreaFromLocalCache(query: string): Promise<MissionAreaLookup | null> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);
    if (!terms.length) {
      return null;
    }

    const matches = (await Promise.all((await this.listActiveMissionsForLocalAreaLookup())
      .map(async (mission) => {
        const profile = await this.venueInventoryRepository.getBarProfile(mission.venueId);
        const location = await this.venueIdentityRepository.getVenueLocationCache(mission.venueId);
        return {
          mission,
          profile,
          location,
          searchable: [mission.venueName, mission.suburb, mission.reason, profile?.address, profile?.suburb]
            .filter(Boolean)
            .join(" ")
            .toLowerCase(),
        };
      })))
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

  private async listActiveMissionsForLocalAreaLookup(): Promise<MissionLifecycleMission[]> {
    const missions: MissionLifecycleMission[] = [];
    const seenMissionIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: MissionListCursor | null = null;
    while (missions.length < MAX_MISSION_LOCAL_CACHE_SCAN_ROWS) {
      const page = await this.missionLifecycleRepository.listMissions({
        activeOnly: true,
        limit: Math.min(
          MISSION_LOCAL_CACHE_PAGE_SIZE,
          MAX_MISSION_LOCAL_CACHE_SCAN_ROWS - missions.length,
        ),
        cursor,
      });
      for (const mission of page.missions) {
        if (seenMissionIds.has(mission.id)) {
          throw new AppError("Mission pagination returned a duplicate record.", 500, undefined, false);
        }
        seenMissionIds.add(mission.id);
        missions.push(mission);
      }
      if (!page.nextCursor) return missions;
      if (page.missions.length === 0) {
        throw new AppError("Mission pagination did not make progress.", 500, undefined, false);
      }
      const cursorKey = `${page.nextCursor.updatedAt}\0${page.nextCursor.id}`;
      if (seenCursors.has(cursorKey)) {
        throw new AppError("Mission pagination repeated a cursor.", 500, undefined, false);
      }
      const last = page.missions.at(-1);
      if (
        !last
        || last.updatedAt !== page.nextCursor.updatedAt
        || last.id !== page.nextCursor.id
      ) {
        throw new AppError("Mission pagination returned an invalid cursor.", 500, undefined, false);
      }
      seenCursors.add(cursorKey);
      cursor = page.nextCursor;
    }
    throw new AppError("Mission lookup exceeded its bounded scan budget.", 500, undefined, false);
  }

  private async buildMissionResults(query: MissionListQuery, account: BusinessAccount | null): Promise<{
    missions: BusinessMission[];
    total: number;
  }> {
    const radiusMeters = Math.max(100, Math.min(50_000, Number(query.radiusKm || 5) * 1000));
    const searchTerms = String(query.q || "")
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean);
    const savedSuburbs = query.sort === "saved" && account
      ? [
          ...(await this.accountProfilePreferencesRepository.listSavedItems(account.id))
            .filter((item) => item.itemType === "suburb")
            .map((item) => item.label.trim().toLowerCase()),
          ...((await this.accountProfilePreferencesRepository.getAccountPreferences(account.id))?.preferredSuburbs ?? [])
            .map((suburb) => suburb.trim().toLowerCase()),
        ].filter(Boolean)
      : [];
    const now = new Date();
    const page = await this.missionDiscoveryAutomationRepository.listMissionFeedPage({
      userId: account?.id ?? null,
      suburb: query.suburb,
      searchTerms,
      savedSuburbs: Array.from(new Set(savedSuburbs)),
      savedOnly: query.sort === "saved",
      latitude: query.latitude,
      longitude: query.longitude,
      radiusMeters,
      sort: query.sort ?? "points",
      limit: Math.max(1, query.limit),
      offset: Math.max(0, query.offset ?? 0),
      acceptedAfter: missionAcceptanceCutoff(now.toISOString()),
      veryFreshCutoff: new Date(now.getTime() - CONTRIBUTION_POINTS.veryFreshHours * 60 * 60 * 1000).toISOString(),
      weekOldCutoff: new Date(now.getTime() - CONTRIBUTION_POINTS.weekOldDays * 24 * 60 * 60 * 1000).toISOString(),
      veryFreshPoints: CONTRIBUTION_POINTS.veryFreshUpdate,
      weekOldPoints: CONTRIBUTION_POINTS.weekOldUpdate,
      stalePoints: CONTRIBUTION_POINTS.staleUpdate,
      newVenuePoints: CONTRIBUTION_POINTS.newVenue,
      excludeHappyHourMissions: !PUBLIC_HAPPY_HOUR_MISSIONS_ENABLED,
    });
    return {
      total: page.total,
      missions: page.missions.map((mission) => ({
        ...mission,
        freshnessLabel: this.missionFreshnessLabel(mission.lastVerifiedAt),
        reservationExpiresAt: mission.userProgress === "accepted" && mission.reservationAcceptedAt
          ? new Date(new Date(mission.reservationAcceptedAt).getTime() + MISSION_ACCEPTANCE_TTL_MS).toISOString()
          : null,
      })),
    };
  }

  async listMissions(query: MissionListQuery, account: BusinessAccount | null = null): Promise<BusinessMission[]> {
    return (await this.buildMissionResults(query, account)).missions;
  }

  async getMissionsPage(query: MissionListQuery, account: BusinessAccount | null = null) {
    const result = await this.buildMissionResults(query, account);
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(1, query.limit);
    return {
      missions: result.missions,
      pagination: {
        total: result.total,
        limit,
        offset,
        hasMore: offset + result.missions.length < result.total,
      },
    };
  }

  async createMission(input: {
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
    return this.missionLifecycleRepository.createMission({
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

  async acceptMission(account: BusinessAccount, missionId: string) {
    this.assertAccountCanSubmit(account);
    await this.runMissionMaintenance();
    const acceptedAt = nowIso();
    const mission = await this.missionLifecycleRepository.getMissionById(missionId);
    if (!mission || !mission.active) {
      throw new AppError("This mission is no longer active.", 404);
    }
    if (!PUBLIC_HAPPY_HOUR_MISSIONS_ENABLED && isHappyHourMission(mission)) {
      throw new AppError("This happy-hour mission is not available during the current public launch.", 404);
    }
    const progress = await this.missionLifecycleRepository.acceptMission({
      missionId,
      userId: account.id,
      now: acceptedAt,
      acceptedAfter: missionAcceptanceCutoff(acceptedAt),
    });
    if (progress.status === "completed") {
      throw new AppError("You have already completed this mission.", 409);
    }
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
      mission: {
        ...mission,
        userProgress: progress.status,
        reservationAcceptedAt: progress.acceptedAt,
        reservationExpiresAt: new Date(new Date(progress.acceptedAt).getTime() + MISSION_ACCEPTANCE_TTL_MS).toISOString(),
      },
      progress,
      reservationAcceptedAt: progress.acceptedAt,
      reservationExpiresAt: new Date(new Date(progress.acceptedAt).getTime() + MISSION_ACCEPTANCE_TTL_MS).toISOString(),
      submitUrl: `/submit.html?${params.toString()}`,
    };
  }

  async releaseMission(account: BusinessAccount, missionId: string) {
    this.assertAccountCanSubmit(account);
    const progress = await this.missionLifecycleRepository.getMissionProgress({ missionId, userId: account.id });
    if (!progress) throw new AppError("Mission reservation not found.", 404);
    if (progress.status !== "accepted") {
      throw new AppError("Only an accepted mission can be released before submission.", 409);
    }
    const released = await this.missionLifecycleRepository.releaseAcceptedMission({
      missionId,
      userId: account.id,
      expectedAcceptedAt: progress.acceptedAt,
      expectedUpdatedAt: progress.updatedAt,
      now: nowIso(),
    });
    return { missionId, progress: released, released: true };
  }

  async listAdminMissions(admin: BusinessAccount, input: number | AdminPaginationInput = 500) {
    if (!this.isAdmin(admin)) throw new AppError("Admin access required.", 403);
    const query = typeof input === "number"
      ? { limit: Math.min(1000, Math.max(1, input)), offset: 0 }
      : input;
    const missions = await this.missionLifecycleRepository.listAdminMissions(query);
    const total = await this.missionLifecycleRepository.countMissions({ activeOnly: false });
    return {
      missions,
      total,
      pagination: { ...query, hasMore: query.offset + missions.length < total },
    };
  }

  async updateAdminMission(admin: BusinessAccount, missionId: string, input: { active: boolean; reason: string }) {
    if (!this.isAdmin(admin)) throw new AppError("Admin access required.", 403);
    const current = await this.missionLifecycleRepository.getMissionById(missionId);
    if (!current) throw new AppError("Mission not found.", 404);
    const mission = await this.missionLifecycleRepository.setMissionActive({
      missionId,
      active: input.active,
      expectedUpdatedAt: current.updatedAt,
      now: nowIso(),
    });
    await this.auditSecurity({ actor: admin, action: "admin_mission_lifecycle_updated", targetType: "mission", targetId: missionId, metadata: input });
    return { mission };
  }

  async deleteAdminMission(admin: BusinessAccount, missionId: string, reason: string) {
    if (!this.isAdmin(admin)) throw new AppError("Admin access required.", 403);
    const mission = await this.missionLifecycleRepository.getMissionById(missionId);
    if (!mission) throw new AppError("Mission not found.", 404);
    await this.missionLifecycleRepository.deleteMissionIfUnused({
      missionId,
      expectedUpdatedAt: mission.updatedAt,
    });
    await this.auditSecurity({ actor: admin, action: "admin_mission_deleted", targetType: "mission", targetId: missionId, metadata: { venueId: mission.venueId, reason } });
    return { missionId, deleted: true };
  }

  async listPriceRecords(
    account: BusinessAccount | null,
    input: PriceRecordsQuery & { clientIp?: string | undefined },
  ) {
    const anonymousSessionId = input.anonymousSessionId
      || (account ? null : hashAnonymousFallback(input.clientIp || "unknown-client"));
    const requestedVenueId = input.venueId
      ? await this.venueIdentityRepository.getCanonicalVenueId(input.venueId)
      : null;
    const identityVenueIds = requestedVenueId
      ? await this.venueIdentityRepository.listVenueIdentityIds(requestedVenueId)
      : [];
    const canonicalizeRecord = async (record: PublicVenuePriceRecord): Promise<PublicVenuePriceRecord> => {
      const canonicalVenueId = await this.venueIdentityRepository.getCanonicalVenueId(record.venueId);
      return canonicalVenueId === record.venueId ? record : { ...record, venueId: canonicalVenueId };
    };
    const cursor = decodePriceCursor(input.cursor);
    const batchSize = Math.min(500, Math.max(50, input.limit * 2));
    const maxBatches = 10;
    const managerVenueIds: Array<string | null> = requestedVenueId
      ? (identityVenueIds.length ? identityVenueIds : [requestedVenueId])
      : [null];
    let scanCursor = cursor;
    let scanHasMore = false;
    let records: PublicVenuePriceRecord[] = [];
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const currentBatch = await this.publicPriceRepository.listCurrentPriceRecordPage({
        venueIds: identityVenueIds,
        limit: batchSize,
        before: scanCursor,
      });
      const managerBatches = await Promise.all(managerVenueIds.map((venueId) =>
        this.publicPriceRepository.listVenueManagerPriceRecords(batchSize, venueId, scanCursor)));
      const candidates = [...currentBatch, ...managerBatches.flat()]
        .sort((left, right) => {
          const timestampDifference = Date.parse(right.lastVerifiedAt) - Date.parse(left.lastVerifiedAt);
          return timestampDifference || right.id.localeCompare(left.id);
        });
      const globalBatch = candidates.slice(0, batchSize);
      if (!globalBatch.length) {
        scanHasMore = false;
        break;
      }
      const lastScanned = globalBatch[globalBatch.length - 1]!;
      scanCursor = { id: lastScanned.id, verifiedAt: lastScanned.lastVerifiedAt };
      scanHasMore = candidates.length > batchSize || currentBatch.length === batchSize ||
        managerBatches.some((managerBatch) => managerBatch.length === batchSize);

      const canonicalBatch = await Promise.all(globalBatch.map(canonicalizeRecord));
      const specialRecords = canonicalBatch.filter((record) =>
        isPublicLaunchPriceRecord(record) &&
        record.displayKind === "special" &&
        record.id.startsWith("venue_special:"),
      );
      const activeSpecialIds = new Set((await Promise.all(specialRecords.map(async (record) => {
        const special = await this.venueInventoryRepository.getBarSpecialById(
          record.id.slice("venue_special:".length),
        );
        return special && this.isBarSpecialActiveNow(special, new Date()) ? record.id : null;
      }))).filter((id): id is string => Boolean(id)));
      const visibleBatch = canonicalBatch
        .filter(isPublicLaunchPriceRecord)
        .filter((record) => {
          if (record.displayKind !== "special" || !record.id.startsWith("venue_special:")) return true;
          return activeSpecialIds.has(record.id);
        })
        .filter(shouldExposePriceRecord)
        .filter((record) =>
          !record.sourceType.startsWith("venue_manager_portal") ||
          record.displayKind !== "beer" ||
          record.price != null,
        );
      records = dedupePublicPriceRecords([...records, ...visibleBatch])
        .sort((left, right) => {
          const timestampDifference = Date.parse(right.lastVerifiedAt) - Date.parse(left.lastVerifiedAt);
          return timestampDifference || right.id.localeCompare(left.id);
        });
      if (records.length > input.limit || !scanHasMore) {
        break;
      }
    }
    const publicVenueMetadata = await this.loadPublicVenueTierMetadata(
      [...new Set(records.map((record) => record.venueId))],
    );
    const submissionEvidencePresence = new Map<string, boolean>();
    await Promise.all([...new Set(records
      .map((record) => record.sourceSubmissionId)
      .filter((submissionId): submissionId is string => Boolean(submissionId)))].map(async (submissionId) => {
      const evidenceIds = await this.sourceEvidenceRetentionRepository.listSubmissionSourceEvidenceIds({
        submissionId,
        limit: 1,
      });
      submissionEvidencePresence.set(submissionId, evidenceIds.length > 0);
    }));
    const hasSubmissionEvidence = (submissionId: string) => {
      const cached = submissionEvidencePresence.get(submissionId);
      return cached ?? false;
    };
    const addVenueMetadata = (record: PublicVenuePriceRecord): PublicVenuePriceRecord => ({
      ...record,
      ...publicVenueMetadata.get(record.venueId),
      hasSourceLinkage: record.hasSourceLinkage || Boolean(record.sourceSubmissionId),
      hasSourceEvidence: record.sourceSubmissionId
        ? hasSubmissionEvidence(record.sourceSubmissionId)
        : Boolean(record.hasSourceEvidence),
    });
    const allCurrentRecords = dedupePublicPriceRecords(records.map(addVenueMetadata))
      .sort((left, right) => {
        const timestampDifference = new Date(right.lastVerifiedAt).getTime() - new Date(left.lastVerifiedAt).getTime();
        return timestampDifference || right.id.localeCompare(left.id);
      });
    const dedupedRecords = allCurrentRecords.slice(0, input.limit);
    const nextCursor = allCurrentRecords.length > input.limit && dedupedRecords.length
      ? encodePriceCursor(dedupedRecords[dedupedRecords.length - 1]!)
      : scanHasMore && scanCursor
        ? encodePriceCursor({ id: scanCursor.id, lastVerifiedAt: scanCursor.verifiedAt })
        : null;
    const hasFullAccess = isFullAccess(account, account ? this.isAdmin(account) : false);

    if (hasFullAccess) {
      return {
        records: dedupedRecords,
        access: this.getAccessState(account, anonymousSessionId),
        nextCursor,
      };
    }

    const freePreviewRecords = dedupedRecords.map(freePreviewPriceRecord);
    const visibleCount = freePreviewRecords.filter((record) => "freePreviewIncluded" in record).length;
    const lockedCount = freePreviewRecords.filter((record) => "priceRedacted" in record).length;
    return {
      records: freePreviewRecords,
      access: this.getAccessState(account, anonymousSessionId),
      preview: {
        model: "fixed_preview" as const,
        includedCount: visibleCount,
        lockedCount,
      },
      nextCursor,
    };
  }

  async trackEvent(account: BusinessAccount | null, input: EventTrackInput): Promise<void> {
    try {
      const privacyScope = serverEventPrivacyScope(input);
      if (account && privacyScope === "optional_analytics") {
        const settings = await this.accountProfilePreferencesRepository.getAccountPrivacySettings(account.id) ??
          await this.accountProfilePreferencesRepository.getDefaultAccountPrivacySettings(account.id);
        if (!settings.optionalAnalyticsEnabled) {
          return;
        }
      }
      if (account && privacyScope === "venue_insight") {
        const settings = await this.accountProfilePreferencesRepository.getAccountPrivacySettings(account.id) ??
          await this.accountProfilePreferencesRepository.getDefaultAccountPrivacySettings(account.id);
        if (!settings.optionalAnalyticsEnabled || !settings.venueReportInclusionEnabled) {
          return;
        }
      }
      const metadata = { ...input.metadata };
      delete metadata.privacyScope;
      await this.activityAuditRepository.recordEvent({
        id: crypto.randomUUID(),
        userId: account?.id ?? null,
        anonymousSessionId: input.anonymousSessionId,
        eventType: input.eventType,
        venueId: input.venueId,
        beerId: input.beerId ? normalizeTrackedBeerId(input.beerId) : null,
        suburb: input.suburb,
        metadata: sanitizeEventMetadata({
          ...metadata,
          ...(privacyScope ? { privacyScope } : {}),
        }),
        createdAt: nowIso(),
      });
    } catch (error) {
      logger.warn("Analytics event capture failed", {
        eventType: input.eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async trackClientEvent(
    account: BusinessAccount | null,
    input: EventTrackInput,
    context?: SessionRequestContext | undefined,
  ): Promise<void> {
    if (SERVER_ONLY_EVENT_TYPES.has(input.eventType)) {
      throw new AppError(
        "This event can only be recorded through its dedicated product action.",
        400,
      );
    }
    // trackEvent always classifies privacy from server-parsed fields and event
    // semantics. Keeping a separate client entry point makes that trust
    // boundary explicit at the route.
    await this.trackEvent(account, {
      ...input,
      anonymousSessionId: account
        ? null
        : hashAnonymousFallback(context?.ip || "unknown-client"),
    });
  }

  async getAnalyticsPreview(admin: BusinessAccount) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const preview = await this.adminAnalyticsRepository.getAnalyticsPreview();
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

  private requireCompletedReportMonth(month: string): void {
    if (month > this.getDefaultReportMonth()) {
      throw new AppError("Only completed calendar months can be generated, exported, or delivered.", 400);
    }
  }

  private buildVenueMonthlyReportData(profile: BarProfile, month: string) {
    const timezone = this.getReportTimezone();
    const privacyThreshold = Math.max(10, this.config.ANALYTICS_MIN_BUCKET_SIZE);
    const range = getZonedMonthRangeIso(month, timezone);
    const analytics = this.repository.getVenueAreaAnalytics({
      venueId: profile.barId,
      venueName: profile.name,
      area: profile.suburb ?? profile.area,
      month,
      timezone,
      privacyThreshold,
    });
    const suggestedActions = analytics.privacyFloorMet
      ? [
          analytics.directionsClicks > 0
            ? "Keep your address, opening hours, and happy-hour conditions current because aggregate activity includes direction requests."
            : "Improve your listing call-to-action by keeping beer rows and happy-hour details fresh.",
          analytics.areaBeerSearches.length > 0
            ? "Match your tap-list updates to the top privacy-safe beer searches in your area."
            : "Add clearer beer styles and specials so nearby search demand has more useful matches.",
        ]
      : ["Not enough area data yet. Your report will become more useful as more accounts or anonymous sessions search nearby."];
    const capabilities = getBarTierCapabilities(profile.membershipTier);
    const demandSnapshot = capabilities.analytics
      ? buildHistoricalVenueDemandSnapshot(analytics)
      : null;
    const proRecommendations = capabilities.advancedRecommendations
      ? getHistoricalVenueRecommendations(analytics)
      : [];
    const discountSummary = this.getVenueDiscountSummary({
      venueId: profile.barId,
      startIso: range.startIso,
      endIso: range.endIso,
    });
    const discountPrivacyFloorMet = discountSummary.uniqueAccounts >= privacyThreshold;
    const suppressedMetrics = [
      ...analytics.suppressedVenueMetrics,
      ...(!discountPrivacyFloorMet
        ? ["discountRedemptions", "discountItemsRedeemed", "uniqueDiscountRedeemers", "estimatedDiscountSavingsCents", "topDiscountItems"]
        : []),
    ];

    return sanitizeMonthlyReportValue({
      schemaVersion: MONTHLY_REPORT_SCHEMA_VERSION,
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
        uniqueBarLookups: analytics.barLookups,
        uniqueProfileViews: analytics.profileViews,
        uniqueBeerListViews: analytics.beerListViews,
        uniqueSpecialsDealsViews: analytics.specialsViews,
        mapMarkerClicks: analytics.markerClicks,
        directionsClicks: analytics.directionsClicks,
        pricePreviewViews: analytics.pricePreviewViews,
        savesAndNightPlanAdds: analytics.saves,
        shares: analytics.shares,
        areaSearches: analytics.areaSearches,
        discountRedemptions: discountPrivacyFloorMet ? discountSummary.totalRedemptions : 0,
        discountItemsRedeemed: discountPrivacyFloorMet ? discountSummary.totalQuantity : 0,
        uniqueDiscountRedeemers: discountPrivacyFloorMet ? discountSummary.uniqueAccounts : 0,
        estimatedDiscountSavingsCents: discountPrivacyFloorMet ? discountSummary.estimatedSavingsCents : 0,
        topDiscountItems: discountPrivacyFloorMet ? discountSummary.topItems : [],
        mostSearchedBeerStylesInArea: analytics.privacyFloorMet ? analytics.areaStyleSearches : [],
        mostSearchedBeersInArea: analytics.privacyFloorMet ? analytics.areaBeerSearches : [],
        suggestedActions,
        demandSnapshot,
        proRecommendations,
        operationalSnapshotExcluded: true,
        historicalDataScope: "Reporting-period events and redemptions only. Current listing quality, open requests, disputes, tier placement, and inventory snapshots are excluded.",
      },
      privacy: {
        aggregateOnly: true,
        suppressedBelowCount: privacyThreshold,
        minimumDistinctContributors: privacyThreshold,
        countingUnit: "distinct account or anonymous session",
        suppressedMetrics,
        areaMetricsSuppressed: !analytics.privacyFloorMet,
        excludesUserEmails: true,
        excludesSessionIds: true,
        excludesExactLocation: true,
        excludesRawClickstream: true,
      },
    }) as Record<string, unknown>;
  }

  private async generateVenueMonthlyReportsInternal(
    input: MonthlyReportGenerateInput,
    options: { reuseCurrentReports?: boolean } = {},
  ) {
    const month = input.month ?? this.getDefaultReportMonth();
    if (!isValidMonthlyReportMonth(month)) {
      throw new AppError("Report month must use a valid YYYY-MM value.", 400);
    }
    this.requireCompletedReportMonth(month);
    const venues = await this.venueInventoryRepository.listReportableBarProfiles({
      venueId: input.venueId,
      limit: input.venueId ? 1 : 1000,
    });

    const reports = venues.map((profile) => {
      if (!input.dryRun && options.reuseCurrentReports) {
        const stored = this.repository.getVenueMonthlyReport({ venueId: profile.barId, month });
        if (isCompletedMonthlyReportSnapshot(stored)) {
          return stored;
        }
      }

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

  async generateVenueMonthlyReports(admin: BusinessAccount, input: MonthlyReportGenerateInput) {
    this.assertCommercialVenueFeatureOpen();
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const result = await this.generateVenueMonthlyReportsInternal(input);
    await this.auditSecurity({
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

  async generateScheduledVenueMonthlyReports(input: MonthlyReportGenerateInput) {
    this.assertCommercialVenueFeatureOpen();
    const result = await this.generateVenueMonthlyReportsInternal(input, { reuseCurrentReports: true });
    await this.auditSecurity({
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

  async getVenueReportDeliverySettings(account: BusinessAccount, venueId: string) {
    this.assertCommercialVenueFeatureOpen();
    this.requireVerifiedBarAccount(account);
    await this.requireAssignedVenue(account, venueId);
    const settings = await readVenueReportDeliverySettings(this.systemStateRepository, venueId);
    const effectiveRecipients = (await this.getVenueReportRecipients(venueId)).map((recipient) => recipient.email);
    const deliveryJob = await this.systemStateRepository.get<Record<string, unknown>>("job:monthly_report_delivery");
    return {
      ...settings,
      effectiveRecipients,
      recipientMode: settings.recipients.length > 0 ? "custom" : "verified_managers",
      schedule: {
        enabled: this.config.REPORT_DELIVERY_SCHEDULE_ENABLED ?? false,
        dayOfMonth: this.config.REPORT_DELIVERY_DAY ?? 2,
        hour: this.config.REPORT_DELIVERY_HOUR ?? 9,
        timezone: this.getReportTimezone(),
        providerConfigured: this.config.REPORT_EMAIL_MODE !== "disabled",
      },
      lastDeliveryJob: deliveryJob?.value ?? null,
      lastDeliveryJobUpdatedAt: deliveryJob?.updatedAt ?? null,
    };
  }

  async getVenueReconciliation(
    account: BusinessAccount,
    venueId: string,
    query: VenueReconciliationQuery,
  ) {
    this.assertCommercialVenueFeatureOpen();
    this.requireVerifiedBarAccount(account);
    const assignment = await this.requireAssignedVenue(account, venueId);
    const discountTotal = this.repository.countDiscountRedemptionsForVenue(venueId);
    const pintPointTotal = this.repository.countPintPointDrinkRecordsForVenue(venueId);
    const discountRedemptions = this.repository
      .listDiscountRedemptionsForVenue(venueId, query.limit, query.offset)
      .map((redemption) => ({
        id: redemption.id,
        publicAccountId: redemption.publicAccountId,
        itemName: redemption.itemName,
        quantity: redemption.quantity,
        estimatedSavingsCents: redemption.estimatedSavingsCents,
        source: typeof redemption.metadata.source === "string" ? redemption.metadata.source : "venue_portal",
        posReference: typeof redemption.metadata.posReference === "string" ? redemption.metadata.posReference : null,
        terminalId: typeof redemption.metadata.terminalId === "string" ? redemption.metadata.terminalId : null,
        redeemedAt: redemption.redeemedAt,
      }));
    const pintPointActivity = this.repository
      .listPintPointDrinkRecordsForVenue(venueId, query.limit, query.offset)
      .map((activity) => this.sanitizeVenuePintPointActivity(account, assignment, activity));

    return {
      venueId,
      pagination: {
        limit: query.limit,
        offset: query.offset,
      },
      discountRedemptions: {
        items: discountRedemptions,
        total: discountTotal,
        hasMore: query.offset + discountRedemptions.length < discountTotal,
      },
      pintPointActivity: {
        items: pintPointActivity,
        total: pintPointTotal,
        hasMore: query.offset + pintPointActivity.length < pintPointTotal,
      },
      privacyCopy: "Only public member identifiers and transaction reconciliation fields are returned; private account details are excluded.",
    };
  }

  async updateVenueReportDeliverySettings(
    account: BusinessAccount,
    venueId: string,
    input: VenueReportDeliverySettingsInput,
  ) {
    this.assertCommercialVenueFeatureOpen();
    this.requireVerifiedBarAccount(account);
    await this.requireAssignedVenue(account, venueId);
    const allowedRecipients = new Set(await this.getVerifiedVenueReportManagerEmails(venueId));
    const invalidRecipientCount = input.recipients.filter(
      (email) => !allowedRecipients.has(email.trim().toLowerCase()),
    ).length;
    if (invalidRecipientCount > 0) {
      throw new AppError(
        "Report recipients must be current, verified manager accounts assigned to this venue.",
        400,
      );
    }
    const now = nowIso();
    await writeVenueReportDeliverySettings(this.systemStateRepository, {
      venueId,
      enabled: input.enabled,
      recipients: input.recipients,
      updatedBy: account.id,
      now,
    });
    await this.auditSecurity({
      actor: account,
      action: "venue_report_delivery_settings_updated",
      targetType: "venue",
      targetId: venueId,
      metadata: {
        enabled: input.enabled,
        recipientCount: input.recipients.length,
        recipientDomains: [...new Set(input.recipients.map((email) => email.split("@")[1] ?? "unknown"))],
      },
    });
    return this.getVenueReportDeliverySettings(account, venueId);
  }

  private async getVerifiedVenueReportManagerEmails(venueId: string): Promise<string[]> {
    const assignments = await this.collectVenueAssignments({
      venueId,
      accessLevel: "manager",
      status: "active",
    });
    const accounts = await Promise.all(
      assignments.map((assignment) => this.accountSessionRepository.getAccountById(assignment.userId)),
    );
    return accounts
      .filter((account): account is BusinessAccount => Boolean(
        account &&
        account.role === "venue_manager" &&
        account.status === "active" &&
        account.email &&
        account.emailVerifiedAt &&
        account.ageConfirmedAt,
      ))
      .map((recipient) => recipient.email.trim().toLowerCase());
  }

  private async getVenueReportRecipients(venueId: string): Promise<Array<{ email: string }>> {
    const settings = await readVenueReportDeliverySettings(this.systemStateRepository, venueId);
    if (!settings.enabled) return [];
    const verified = new Set(await this.getVerifiedVenueReportManagerEmails(venueId));
    if (settings.recipients.length > 0) {
      const valid = settings.recipients.filter((email) => verified.has(email.trim().toLowerCase()));
      if (valid.length !== settings.recipients.length) {
        await writeVenueReportDeliverySettings(this.systemStateRepository, {
          venueId,
          enabled: valid.length > 0,
          recipients: valid,
          updatedBy: "system:recipient-validation",
          now: nowIso(),
        });
      }
      return valid.map((email) => ({ email }));
    }
    return [...verified].map((email) => ({ email }));
  }

  async deliverVenueMonthlyReports(admin: BusinessAccount, input: MonthlyReportDeliveryInput) {
    this.assertCommercialVenueFeatureOpen();
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }
    const dryRun = input.dryRun || !input.deliver;
    const provider = dryRun
      ? null
      : this.config.REPORT_EMAIL_MODE === "mock"
        ? createMockReportEmailProvider()
        : this.config.REPORT_EMAIL_MODE === "resend" && this.config.RESEND_API_KEY
          ? createResendReportEmailProvider({ apiKey: this.config.RESEND_API_KEY })
          : null;
    if (!dryRun && !provider) {
      throw new AppError("Report email delivery is disabled. Configure Resend or run a dry-run preview.", 503);
    }
    if (!dryRun && this.config.REPORT_EMAIL_MODE === "resend" && !this.config.REPORT_EMAIL_FROM) {
      throw new AppError("Report sender address is not configured.", 503);
    }
    const result = await runMonthlyReportDelivery({
      generator: this,
      repository: this.venueAccessRepository,
      accountRepository: this.accountSessionRepository,
      stateRepository: this.systemStateRepository,
      provider,
      publicBaseUrl: this.config.PUBLIC_BASE_URL,
      from: this.config.REPORT_EMAIL_FROM ?? "reports@mock.pintpath.local",
      ...(this.config.REPORT_EMAIL_REPLY_TO ? { replyTo: this.config.REPORT_EMAIL_REPLY_TO } : {}),
      timezone: this.config.REPORT_TIMEZONE || DEFAULT_REPORT_TIMEZONE,
      ...(input.month ? { month: input.month } : {}),
      venueId: input.venueId,
      dryRun,
    });
    await this.auditSecurity({
      actor: admin,
      action: dryRun ? "venue_monthly_report_delivery_previewed" : "venue_monthly_report_delivery_run",
      targetType: input.venueId ? "venue" : "venue_monthly_reports",
      targetId: input.venueId ?? result.month,
      metadata: {
        month: result.month,
        deliveredCount: result.deliveredCount,
        mockedCount: result.mockedCount,
        rejectedCount: result.rejectedCount,
        uncertainCount: result.uncertainCount,
        skippedNoEligibleRecipientCount: result.skippedNoEligibleRecipientCount,
      },
    });
    return {
      ...result,
      emailMode: this.config.REPORT_EMAIL_MODE,
      processedCount: result.deliveredCount + result.mockedCount + result.rejectedCount + result.uncertainCount,
      message: dryRun
        ? `Previewed ${result.generatedCount} report${result.generatedCount === 1 ? "" : "s"}.`
        : result.rejectedCount || result.uncertainCount
          ? `Delivery completed with ${result.rejectedCount} rejected and ${result.uncertainCount} uncertain send${result.rejectedCount + result.uncertainCount === 1 ? "" : "s"}.`
          : `Delivered ${result.deliveredCount} report email${result.deliveredCount === 1 ? "" : "s"}${result.mockedCount ? ` (${result.mockedCount} mocked)` : ""}.`,
    };
  }

  async deliverScheduledVenueMonthlyReports(input: MonthlyReportDeliveryInput) {
    this.assertCommercialVenueFeatureOpen();
    const generated = await this.generateScheduledVenueMonthlyReports(input);
    const deliveries: Array<Record<string, unknown>> = [];
    for (const report of generated.reports) {
      const monthlyReport = report as MonthlyBarReport;
      const recipients = await this.getVenueReportRecipients(monthlyReport.barId);
      if (recipients.length === 0) {
        deliveries.push({
          venueId: monthlyReport.barId,
          month: monthlyReport.month,
          status: "skipped_no_recipients",
          recipientCount: 0,
        });
        continue;
      }

      for (const recipient of recipients) {
        const status = input.dryRun || !input.deliver
          ? "dry_run"
          : this.config.REPORT_EMAIL_MODE === "mock"
            ? "mocked"
            : "skipped_email_disabled";

        if (status === "mocked") {
          await this.auditSecurity({
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

        deliveries.push({
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
        });
      }
    }

    return {
      ...generated,
      emailMode: this.config.REPORT_EMAIL_MODE,
      deliveries,
    };
  }

  async getVenueMonthlyReport(account: BusinessAccount, venueId: string, month: string) {
    this.assertCommercialVenueFeatureOpen();
    this.requireVerifiedBarAccount(account);
    await this.requireAssignedVenue(account, venueId);
    if (!isValidMonthlyReportMonth(month)) {
      throw new AppError("Report month must use a valid YYYY-MM value.", 400);
    }
    const currentMonth = getZonedMonthKey(new Date(), this.getReportTimezone());
    if (month > currentMonth) {
      throw new AppError("Future monthly reports are not available.", 400);
    }

    const profile = await this.venueInventoryRepository.getBarProfile(venueId);
    const capabilities = getBarTierCapabilities(profile?.membershipTier ?? "basic", this.isAdmin(account));
    if (!capabilities.monthlyReports) {
      throw new AppError("Pro venue tier required to view monthly reports.", 403);
    }

    const stored = this.repository.getVenueMonthlyReport({ venueId, month });
    if (month < currentMonth && isCompletedMonthlyReportSnapshot(stored)) {
      return sanitizeMonthlyReport(stored)!;
    }

    const reportProfile = profile ?? await this.getOrBuildBarProfile({ barId: venueId, name: venueId, suburb: null });
    return {
      id: null,
      barId: venueId,
      month,
      data: {
        ...this.buildVenueMonthlyReportData(reportProfile, month),
        generated: false,
        generatedAt: null,
      },
      createdAt: null,
    };
  }

  async exportVenueMonthlyReport(account: BusinessAccount, venueId: string, month: string, query: MonthlyReportExportQuery) {
    this.assertCommercialVenueFeatureOpen();
    this.requireVerifiedBarAccount(account);
    await this.requireAssignedVenue(account, venueId);
    if (!isValidMonthlyReportMonth(month)) {
      throw new AppError("Report month must use a valid YYYY-MM value.", 400);
    }

    const profile = await this.venueInventoryRepository.getBarProfile(venueId);
    const capabilities = getBarTierCapabilities(profile?.membershipTier ?? "basic", this.isAdmin(account));
    if (!capabilities.monthlyReports) {
      throw new AppError("Pro venue tier required to export monthly reports.", 403);
    }
    this.requireCompletedReportMonth(month);

    const stored = this.repository.getVenueMonthlyReport({ venueId, month });
    const reportProfile = profile ?? await this.getOrBuildBarProfile({ barId: venueId, name: venueId, suburb: null });
    const report = sanitizeMonthlyReport(
      isCompletedMonthlyReportSnapshot(stored)
        ? stored
        : this.repository.upsertVenueMonthlyReport({
          id: crypto.randomUUID(),
          venueId,
          month,
          data: this.buildVenueMonthlyReportData(reportProfile, month),
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

  async getVenuePortal(account: BusinessAccount, query: VenuePortalQuery) {
    this.requireVerifiedBarAccount(account);
    const isAdmin = this.isAdmin(account);
    const commercialLaunchEnabled = this.config.COMMERCIAL_LAUNCH_ENABLED;
    if (commercialLaunchEnabled) {
      await this.expireVenueCounterStaffInvitations(nowIso());
    }
    const managerAssignments = await this.collectVenueAssignments({
      ...(isAdmin ? {} : { userId: account.id }),
      ...(!commercialLaunchEnabled ? { accessLevel: "manager" as const } : {}),
      status: "active",
    });
    let assignments: VenueAccessAssignmentRecord[];
    if (isAdmin) {
      const loadedAt = nowIso();
      const venues = new Map<string, { venueId: string; venueName: string; suburb: string | null }>();
      const publicDirectory = await this.publicVenueDirectoryRepository.listPublicVenueDirectoryPage({
        limit: -1,
        offset: 0,
      });
      publicDirectory.venues.forEach((venue) => {
        venues.set(venue.id, { venueId: venue.id, venueName: venue.name, suburb: venue.suburb });
      });
      managerAssignments.forEach((assignment) => {
        if (!venues.has(assignment.venueId)) {
          venues.set(assignment.venueId, {
            venueId: assignment.venueId,
            venueName: assignment.venueName,
            suburb: assignment.suburb,
          });
        }
      });
      assignments = [...venues.values()]
        .sort((left, right) => left.venueName.localeCompare(right.venueName) || left.venueId.localeCompare(right.venueId))
        .map((venue) => ({
          id: `admin-venue:${venue.venueId}`,
          userId: account.id,
          venueId: venue.venueId,
          venueName: venue.venueName,
          suburb: venue.suburb,
          accessLevel: "manager",
          status: "active",
          approvedBy: account.id,
          expiresAt: null,
          createdAt: loadedAt,
          updatedAt: loadedAt,
        }));
    } else {
      assignments = managerAssignments;
    }

    if (!isAdmin && assignments.length === 0) {
      const claimRequests = (await this.venueAccessRepository
        .listVenueClaims({ userId: account.id, limit: 20 })).claims
        .map((record) => this.toBarClaimRequest(record))
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
        account: sanitizeAccount(account),
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

    if (!isAdmin && query.venueId && !assignments.some((item) => item.venueId === query.venueId)) {
      throw new AppError("You can only access assigned venues.", 403);
    }
    const requestedVenueId = query.venueId ?? null;
    const selectedVenueId = requestedVenueId
      ?? assignments.find((item) => item.accessLevel === "manager")?.venueId
      ?? assignments[0]?.venueId;
    if (!selectedVenueId) {
      return {
        account: sanitizeAccount(account),
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
      : await this.requireAssignedVenue(account, selectedVenueId, "counter");
    if (!isAdmin && !assignment) {
      throw new AppError("You can only access assigned venues.", 403);
    }

    const venueName = assignment?.venueName ?? selectedVenueId;
    const suburb = assignment?.suburb ?? null;
    const accessLevel = isAdmin ? "manager" : assignment?.accessLevel ?? "counter_staff";
    const profile = await this.getOrBuildBarProfile({ barId: selectedVenueId, name: venueName, suburb });
    const portalProfile = commercialLaunchEnabled
      ? profile
      : {
          ...profile,
          membershipTier: "basic" as const,
          highlightedName: false,
          premiumBadge: null,
          promoted: false,
          featuredSpecialEligible: false,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          subscriptionStatus: null,
          subscriptionCurrentPeriodEnd: null,
          stripePaidMembershipTier: null,
          tierManualOverride: false,
          acceptsPintPathCodes: false,
          posLastSuccessAt: null,
          posLastTerminalId: null,
        };

    if (accessLevel === "counter_staff") {
      this.assertCommercialVenueFeatureOpen();
      const recentActivity = this.config.PINT_POINTS_REWARDS_ENABLED
        ? this.repository
            .listPintPointDrinkRecordsForVenue(selectedVenueId, 12)
            .map((activity) => this.sanitizeVenuePintPointActivity(account, assignment, activity))
        : [];
      const counterBeers = (await this.venueInventoryRepository
        .listBarBeers(selectedVenueId))
        .filter((beer) => beer.inStock)
        .map((beer) => ({
          id: beer.id,
          beerName: beer.beerName,
          serveSize: beer.serveSize,
          price: beer.price,
          onTap: beer.onTap,
          inStock: beer.inStock,
        }));
      const counterSpecials = (await this.venueInventoryRepository
        .listBarSpecials(selectedVenueId))
        .filter((special) => special.active !== false)
        .map((special) => ({ id: special.id, title: special.title }));

      await this.trackEvent(account, {
        anonymousSessionId: null,
        eventType: "venue_portal_viewed",
        venueId: selectedVenueId,
        beerId: null,
        suburb,
        metadata: { accessLevel },
      });

      return {
        account: sanitizeAccount(account),
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
        pintPoints: this.config.PINT_POINTS_REWARDS_ENABLED
          ? {
              today: null,
              month: null,
              recentActivity,
              rewardThreshold: FREE_PINT_REWARD_POINTS,
              copy: "Counter access records member purchases and rewards only. It cannot edit venue data or view private business analytics.",
            }
          : null,
        posIntegration: null,
        monthlyReport: null,
        businessToolkit: null,
        staffAssignments: [],
        updateLink: null,
        privacyCopy: "Counter staff see only the public member ID needed to record a purchase.",
      };
    }

    const insightPriceRecords = await this.publicPriceRepository.listLatestPriceRecords(
      100,
      selectedVenueId,
    );
    const rawInsights = await this.venueManagerInsightsRepository.getVenueManagerInsights({
      venueId: selectedVenueId,
      suburb,
      staleBefore: daysAgoIso(30),
      priceRecords: insightPriceRecords,
    });
    const venueArea = profile.suburb ?? suburb ?? profile.area ?? null;
    const capabilities = getBarTierCapabilities(
      commercialLaunchEnabled ? profile.membershipTier : "basic",
      commercialLaunchEnabled && isAdmin,
    );
    if (!commercialLaunchEnabled) {
      capabilities.upgradeCopy = null;
    }
    const venueInsightPrivacyThreshold = Math.max(10, this.config.ANALYTICS_MIN_BUCKET_SIZE);
    const reportTimezone = this.getReportTimezone();
    const analyticsMonth = getZonedMonthKey(new Date(), reportTimezone);
    const analyticsMonthRange = monthKeyRange(analyticsMonth, reportTimezone);
    const monthlyReportMonth = this.getDefaultReportMonth();
    const todayRange = getZonedDayRangeIso(new Date(), reportTimezone);
    const analytics = capabilities.analytics
      ? this.repository.getVenueAreaAnalytics({
          venueId: selectedVenueId,
          venueName: profile.name,
          area: venueArea,
          month: analyticsMonth,
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
    const inventoryBeers = await this.venueInventoryRepository.listBarBeers(selectedVenueId);
    const inventoryHappyHours = await this.venueInventoryRepository.listBarHappyHours(selectedVenueId);
    const inventorySpecials = commercialLaunchEnabled && capabilities.canManageSpecials
      ? await this.venueInventoryRepository.listBarSpecials(selectedVenueId)
      : [];
    const areaPurchasedBeers = capabilities.analytics
      ? this.repository.listVenueAreaPurchasedBeers({
          area: venueArea,
          startIso: analyticsMonthRange.startsAt,
          endIso: analyticsMonthRange.endsAt,
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
    const sanitizedInsights = this.sanitizeVenueManagerInsights(rawInsights, {
      includeAggregate: capabilities.analytics,
      privacyThreshold: venueInsightPrivacyThreshold,
    });
    const insights = commercialLaunchEnabled
      ? sanitizedInsights
      : {
          ...sanitizedInsights,
          listingQuality: {
            ...sanitizedInsights.listingQuality,
            checklist: sanitizedInsights.listingQuality.checklist.map((item) => ({
              ...item,
              label: item.label === "Happy hour listed"
                ? "Internal happy-hour record saved"
                : item.label,
            })),
          },
        };
    const storedMonthlyReport = capabilities.monthlyReports
      ? this.repository.getVenueMonthlyReport({ venueId: selectedVenueId, month: monthlyReportMonth })
      : null;
    const savedMonthlyReport = isCompletedMonthlyReportSnapshot(storedMonthlyReport)
      ? sanitizeMonthlyReport(storedMonthlyReport)
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
    const discountSummary = commercialLaunchEnabled
      ? this.getVenueDiscountSummary({
          venueId: selectedVenueId,
          includeRecent: true,
          recentLimit: 10,
        })
      : null;
    const pintPointTodayStats = commercialLaunchEnabled && this.config.PINT_POINTS_REWARDS_ENABLED
      ? this.repository.getPintPointStatsForVenue({
          venueId: selectedVenueId,
          startIso: todayRange.startIso,
          endIso: todayRange.endIso,
        })
      : null;
    const pintPointMonthStats = commercialLaunchEnabled && this.config.PINT_POINTS_REWARDS_ENABLED
      ? this.repository.getPintPointStatsForVenue({
          venueId: selectedVenueId,
          startIso: analyticsMonthRange.startsAt,
          endIso: analyticsMonthRange.endsAt,
        })
      : null;
    const recentPintPointActivity = commercialLaunchEnabled && this.config.PINT_POINTS_REWARDS_ENABLED
      ? this.repository
          .listPintPointDrinkRecordsForVenue(selectedVenueId, 12)
          .map((activity) => this.sanitizeVenuePintPointActivity(account, assignment, activity))
      : [];
    const staffAssignmentRows = commercialLaunchEnabled
      ? await this.collectVenueAssignments({
          venueId: selectedVenueId,
          accessLevel: "counter_staff",
          currentOnly: true,
        })
      : [];
    const staffAssignments = await Promise.all(staffAssignmentRows.map(async (item) => {
      const staffAccount = await this.accountSessionRepository.getAccountById(item.userId);
      return {
        id: item.id,
        publicAccountId: staffAccount?.publicAccountId ?? null,
        displayName: staffAccount?.displayName ?? null,
        accessLevel: item.accessLevel,
        status: item.status,
        expiresAt: item.expiresAt,
        createdAt: item.createdAt,
      };
    }));
    const posIntegration = commercialLaunchEnabled
      ? await this.getVenuePosIntegration(account, selectedVenueId)
      : null;
    const monthlyReport = capabilities.monthlyReports
      ? savedMonthlyReport ?? {
          id: null,
          barId: selectedVenueId,
          month: monthlyReportMonth,
          data: {
            ...this.buildVenueMonthlyReportData(profile, monthlyReportMonth),
            generated: false,
            generatedAt: null,
          },
          createdAt: null,
        }
      : null;
    const updateLink = `/submit.html?venueId=${encodeURIComponent(selectedVenueId)}&venueName=${encodeURIComponent(venueName)}${suburb ? `&suburb=${encodeURIComponent(suburb)}` : ""}`;

    await this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_portal_viewed",
      venueId: selectedVenueId,
      beerId: null,
      suburb,
      metadata: { assignmentCount: assignments.length },
    });
    await this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_insights_viewed",
      venueId: selectedVenueId,
      beerId: null,
      suburb,
      metadata: { source: "venue_portal" },
    });

    return {
      account: sanitizeAccount(account),
      isAdmin,
      accessLevel,
      billing: commercialLaunchEnabled
        ? {
            mode: this.config.DEMO_BILLING_MODE
              ? "demo"
              : profile.stripeCustomerId
                ? "stripe"
                : "unlinked",
            managementAvailable: this.config.DEMO_BILLING_MODE || Boolean(profile.stripeCustomerId),
          }
        : null,
      assignments,
      selectedVenue: {
        venueId: selectedVenueId,
        venueName,
        suburb,
      },
      profile: portalProfile,
      tier: {
        ...capabilities,
        analyticsLocked: !capabilities.analytics,
      },
      inventory: {
        beers: inventoryBeers,
        happyHours: inventoryHappyHours,
        specials: inventorySpecials,
      },
      pendingChanges: (await this.venuePendingChangeRepository
        .listBarPendingChanges({ barId: selectedVenueId, status: "pending", limit: 200 }))
        .filter((change) => commercialLaunchEnabled || change.changeType !== "special"),
      insights,
      analytics,
      demandDashboard,
      paidVenueIntelligence,
      dailySpecialsPlanner,
      discounts: discountSummary,
      pintPoints: commercialLaunchEnabled && this.config.PINT_POINTS_REWARDS_ENABLED
        ? {
            today: pintPointTodayStats,
            month: pintPointMonthStats,
            recentActivity: recentPintPointActivity,
            rewardThreshold: FREE_PINT_REWARD_POINTS,
            copy: "Pint Points count only paid alcoholic beverages. Free Pint Rewards do not earn another point.",
          }
        : null,
      posIntegration,
      staffAssignments,
      staffPagination: {
        total: staffAssignments.length,
        limit: staffAssignments.length,
        offset: 0,
        hasMore: false,
      },
      monthlyReport,
      businessToolkit: commercialLaunchEnabled
        ? {
            demandSnapshot,
            proGrowthPlan,
            demandDashboard,
            paidVenueIntelligence,
            dailySpecialsPlanner,
            updateLink,
            qrCopy: "Copy this update link or turn it into a QR code for your venue/tap-list area.",
          }
        : null,
      updateLink,
      qrCopy: "Copy this update link or turn it into a QR code for your venue/tap-list area.",
      privacyCopy: commercialLaunchEnabled
        ? "Venue insights are aggregated and privacy-safe. Individual user clickstream and exact location are never shown."
        : "The Free portal returns only assigned-venue operational data; paid analytics and reports are not included.",
    };
  }

  async assignVenueCounterStaff(
    account: BusinessAccount,
    venueId: string,
    input: VenueCounterStaffAssignmentInput,
  ) {
    this.assertCommercialVenueFeatureOpen();
    const managerAssignment = await this.requireAssignedVenue(account, venueId);
    const staffAccount = await this.accountSessionRepository.getAccountByPublicAccountId(input.accountId);
    if (!staffAccount) {
      throw new AppError("Pint Path account ID not found.", 404);
    }
    if (staffAccount.id === account.id) {
      throw new AppError("Your manager assignment already includes counter access.", 409);
    }
    this.requireVerifiedBarAccount(staffAccount);
    await this.requireCounterStaffInvitationAvailable(staffAccount.id, venueId);

    const invitedAt = nowIso();
    const profile = await this.venueInventoryRepository.getBarProfile(venueId);
    const { assignment } = await this.venueAccessRepository.inviteCounterStaff({
      invitationToken: crypto.randomUUID(),
      inviterAccountId: account.id,
      userId: staffAccount.id,
      venueId,
      venueName: managerAssignment?.venueName ?? profile?.name ?? venueId,
      suburb: managerAssignment?.suburb ?? profile?.suburb ?? null,
      now: invitedAt,
      expiresAt: addMinutes(invitedAt, COUNTER_STAFF_INVITATION_TTL_MINUTES),
    });

    await this.auditSecurity({
      actor: account,
      action: "venue_counter_staff_invited",
      targetType: "venue_manager_assignment",
      targetId: assignment.id,
      metadata: {
        venueId,
        staffPublicAccountId: staffAccount.publicAccountId,
      },
    });

    return {
      message: "Counter-staff invitation sent. Access starts only after the account owner accepts it within 72 hours.",
      assignment: {
        ...assignment,
        userId: undefined,
        publicAccountId: staffAccount.publicAccountId,
        displayName: staffAccount.displayName,
      },
    };
  }

  private async requireCounterStaffInvitationAvailable(userId: string, venueId: string): Promise<void> {
    await this.expireVenueCounterStaffInvitations(nowIso());
    const existing = await this.venueAccessRepository.getVenueAssignment({
      userId,
      venueId,
      activeOnly: false,
    });
    if (!existing || existing.status === "revoked") return;
    if (existing.accessLevel === "manager") {
      throw new AppError("That account is already a manager for this venue.", 409);
    }
    if (existing.status === "active") {
      throw new AppError("That account already has counter access for this venue.", 409);
    }
    throw new AppError("That account already has a pending counter-staff invitation.", 409);
  }

  async respondToVenueCounterStaffInvitation(
    account: BusinessAccount,
    assignmentId: string,
    input: VenueCounterStaffInvitationResponseInput,
  ) {
    this.assertCommercialVenueFeatureOpen();
    this.requireVerifiedBarAccount(account);
    const respondedAt = nowIso();
    await this.expireVenueCounterStaffInvitations(respondedAt);
    const { assignment } = await this.venueAccessRepository.respondToCounterStaffInvitation({
      invitationToken: assignmentId,
      userId: account.id,
      decision: input.decision,
      now: respondedAt,
    });

    await this.auditSecurity({
      actor: account,
      action: input.decision === "accept" ? "venue_counter_staff_invitation_accepted" : "venue_counter_staff_invitation_declined",
      targetType: "venue_manager_assignment",
      targetId: assignment.id,
      metadata: { venueId: assignment.venueId },
    });

    return {
      account: sanitizeAccount(await this.accountSessionRepository.getAccountById(account.id) ?? account),
      assignment: {
        id: assignment.id,
        venueId: assignment.venueId,
        venueName: assignment.venueName,
        suburb: assignment.suburb,
        accessLevel: assignment.accessLevel,
        status: assignment.status,
        updatedAt: assignment.updatedAt,
      },
      message: input.decision === "accept"
        ? `Counter access is now active for ${assignment.venueName}.`
        : `Invitation from ${assignment.venueName} declined.`,
    };
  }

  async revokeVenueCounterStaff(
    account: BusinessAccount,
    venueId: string,
    input: VenueCounterStaffAssignmentInput,
  ) {
    this.assertCommercialVenueFeatureOpen();
    await this.requireAssignedVenue(account, venueId);
    const staffAccount = await this.accountSessionRepository.getAccountByPublicAccountId(input.accountId);
    if (!staffAccount) {
      throw new AppError("Pint Path account ID not found.", 404);
    }
    const existing = await this.venueAccessRepository.getVenueAssignment({
      userId: staffAccount.id,
      venueId,
      activeOnly: false,
    });
    if (!existing || existing.accessLevel !== "counter_staff" || !["active", "pending"].includes(existing.status)) {
      throw new AppError("Counter-staff assignment or invitation not found.", 404);
    }
    const result = await this.venueAccessRepository.revokeVenueAssignment({
      actorAccountId: account.id,
      userId: staffAccount.id,
      venueId,
      expectedAccessLevel: "counter_staff",
      now: nowIso(),
    });
    if (result.outcome === "duplicate") {
      throw new AppError("Counter-staff assignment not found.", 404);
    }
    const assignment = result.assignment;

    await this.auditSecurity({
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

  async createBarClaimRequest(account: BusinessAccount, input: BarClaimRequestInput) {
    this.requireVerifiedBarAccount(account);
    const barId = input.barId?.trim();
    if (!barId) {
      throw new AppError("Choose a known Pint Path venue before requesting access.", 400);
    }

    const contactEmail = normalizeEmail(input.contactEmail);
    if (contactEmail !== normalizeEmail(account.email)) {
      throw new AppError("Use the verified email address for your signed-in Pint Path account.", 400);
    }

    const profile = await this.venueInventoryRepository.getBarProfile(barId);
    const location = await this.venueIdentityRepository.getVenueLocationCache(barId);
    const priceRecord = (await this.publicPriceRepository.listLatestPriceRecords(1, barId))[0] ?? null;
    if (!profile && !location && !priceRecord) {
      throw new AppError("That venue is not in Pint Path yet. Submit it as a missing venue before claiming it.", 404);
    }

    const now = nowIso();
    const result = await this.venueAccessRepository.createVenueClaim({
      id: crypto.randomUUID(),
      userId: account.id,
      venueId: barId,
      venueName: profile?.name ?? location?.venueName ?? priceRecord?.venueName ?? input.barName,
      address: profile?.address ?? input.address,
      suburb: profile?.suburb ?? location?.suburb ?? priceRecord?.suburb ?? input.suburb,
      requesterName: input.requesterName,
      requesterRole: input.requesterRole,
      contactEmail,
      contactPhone: input.contactPhone,
      message: input.message,
      now,
    });
    const claim = this.toBarClaimRequest(result.claim);
    if (result.outcome === "existing") {
      return {
        claim,
        duplicate: true,
        message: "This venue claim is already waiting for manual verification.",
      };
    }

    await this.trackEvent(account, {
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

  async reviewVenueClaimRequest(admin: BusinessAccount, claimId: string, input: VenueClaimReviewInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const claimRecord = await this.venueAccessRepository.getVenueClaim(claimId);
    if (!claimRecord) {
      throw new AppError("Venue claim not found.", 404);
    }
    const claim = this.toBarClaimRequest(claimRecord);
    if (claim.status !== "pending") {
      if (claim.status === input.status) {
        return {
          claim,
          assignment: claim.status === "approved" && claim.barId
            ? await this.venueAccessRepository.getVenueAssignment({ userId: claim.userId, venueId: claim.barId })
            : null,
          duplicate: true,
          message: `This venue claim was already ${claim.status}.`,
        };
      }
      throw new AppError(`This venue claim was already ${claim.status}.`, 409);
    }

    const claimant = await this.accountSessionRepository.getAccountById(claim.userId);
    if (!claimant || claimant.status !== "active") {
      throw new AppError("The claimant account is no longer active.", 409);
    }
    if (input.status === "approved" && !claim.barId) {
      throw new AppError("Choose a known venue before approving this claim.", 400);
    }

    const reviewedAt = nowIso();
    const reviewResult = await this.venueAccessRepository.reviewVenueClaimAndAssignManager({
      claimId: claim.id,
      reviewerAccountId: admin.id,
      decision: input.status,
      reviewNote: input.reviewNote,
      expectedUpdatedAt: claim.updatedAt,
      assignmentId: input.status === "approved" ? crypto.randomUUID() : null,
      now: reviewedAt,
    });

    await this.auditSecurity({
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
      claim: this.toBarClaimRequest(reviewResult.claim),
      assignment: reviewResult.assignment,
      ...(reviewResult.outcome === "duplicate" ? { duplicate: true } : {}),
      message: reviewResult.outcome === "duplicate"
        ? `This venue claim was already ${reviewResult.claim.status}.`
        : input.status === "approved"
          ? "Venue claim approved and manager access assigned."
          : "Venue claim rejected without granting venue access.",
    };
  }

  async createVenueManagerSubmission(account: BusinessAccount, venueId: string, input: CreateSubmissionInput) {
    const assignment = await this.requireAssignedVenue(account, venueId);
    if (!assignment || assignment.accessLevel !== "manager") {
      throw new AppError("Venue manager access is required for this internal submission.", 403);
    }

    if (input.venueId !== venueId) {
      throw new AppError("Venue update must match the assigned venue.", 403);
    }

    const createdEvidenceRefs: string[] = [];
    let result: Awaited<ReturnType<BusinessService["createSubmission"]>>;
    try {
      const normalizedInput = {
        ...input,
        notes: [
          input.notes,
          "Venue manager submitted update. Keep pending for admin/data-quality review unless manually approved.",
        ].filter(Boolean).join(" "),
      };
      const submitWithEvidence = (sourcePhotoRefs: string[]) => this.createSubmission(account, normalizedInput, {
          allowVenueManager: true,
          managerAssignmentId: assignment.id,
          rewardEligible: false,
          sourcePhotoRefs,
        });
      const existingRefs = await this.resolveExistingInternalManagerEvidenceRefs(account, input);
      const sourcePhotoRefs = existingRefs ?? await this.resolveSubmissionSourcePhotos(
          account,
          input,
          (ref) => createdEvidenceRefs.push(ref),
        );
      try {
        result = await submitWithEvidence(sourcePhotoRefs);
      } catch (error) {
        const concurrentReplayRefs = error instanceof AppError
          && error.statusCode === 409
          && createdEvidenceRefs.length > 0
          ? await this.resolveExistingInternalManagerEvidenceRefs(account, input)
          : null;
        if (!concurrentReplayRefs) throw error;
        await this.compensateUnlinkedSourceEvidence(createdEvidenceRefs);
        createdEvidenceRefs.length = 0;
        result = await submitWithEvidence(concurrentReplayRefs);
      }
      if (result.idempotentReplay) {
        await this.compensateUnlinkedSourceEvidence(createdEvidenceRefs);
      }
    } catch (error) {
      await this.compensateUnlinkedSourceEvidence(createdEvidenceRefs);
      throw error;
    }

    if (!result.idempotentReplay) {
      await this.trackEvent(account, {
        anonymousSessionId: null,
        eventType: "venue_update_submitted",
        venueId,
        beerId: input.items[0]?.beerName ? normalizeTrackedBeerId(input.items[0].beerName) : null,
        suburb: assignment.suburb ?? input.suburb,
        metadata: {
          submissionId: result.submission.id,
          submissionType: input.submissionType,
        },
      });
    }

    return {
      ...result,
      message: "Venue update submitted for review. Approved updates can be shown as venue-confirmed data.",
    };
  }

  async upsertBarProfile(account: BusinessAccount, venueId: string, input: BarProfileInput) {
    const assignment = await this.requireAssignedVenue(account, venueId);
    const existing = await this.venueInventoryRepository.getBarProfile(venueId);
    if (existing && !input.expectedUpdatedAt) {
      throw new AppError("Refresh this venue profile before saving so a teammate's edits are not overwritten.", 409, {
        currentUpdatedAt: existing.updatedAt,
      });
    }
    if (existing && existing.updatedAt !== input.expectedUpdatedAt) {
      throw new AppError("This venue profile changed in another session. Refresh before saving your edits.", 409, {
        currentUpdatedAt: existing.updatedAt,
      });
    }
    if (
      !this.config.COMMERCIAL_LAUNCH_ENABLED &&
      (input.membershipTier === "pro" || input.acceptsPintPathCodes === true)
    ) {
      this.assertCommercialVenueFeatureOpen();
    }
    const existingTier = this.config.COMMERCIAL_LAUNCH_ENABLED
      ? existing?.membershipTier ?? "basic"
      : "basic";
    const membershipTier = this.config.COMMERCIAL_LAUNCH_ENABLED && this.isAdmin(account)
      ? input.membershipTier ?? existingTier
      : existingTier;
    const acceptsPintPathCodes = this.config.COMMERCIAL_LAUNCH_ENABLED && this.isAdmin(account)
      ? input.acceptsPintPathCodes ?? existing?.acceptsPintPathCodes ?? false
      : false;
    const flags = tierFlags(membershipTier);
    const now = nowIso();
    let profile;
    try {
      profile = await this.venueInventoryRepository.upsertBarProfile({
      barId: venueId,
      name: input.name,
      address: input.address,
      suburb: input.suburb ?? assignment?.suburb ?? existing?.suburb ?? null,
      area: input.area ?? input.suburb ?? assignment?.suburb ?? existing?.area ?? existing?.suburb ?? null,
      phone: input.phone,
      website: input.website,
      instagram: input.instagram,
      description: input.description,
      openingHours: normalizeVenueOpeningHours(existing?.openingHours ?? {}, input.openingHours),
      venueTags: normalizeVenueTags(existing?.venueTags ?? [], input.venueTags, input.replaceVenueTags),
      membershipTier,
      acceptsPintPathCodes,
      active: this.isAdmin(account) ? input.active : existing?.active ?? true,
      expectedUpdatedAt: input.expectedUpdatedAt,
      tierManualOverride: this.config.COMMERCIAL_LAUNCH_ENABLED && this.isAdmin(account) && input.membershipTier !== undefined
        ? true
        : this.config.COMMERCIAL_LAUNCH_ENABLED
          ? existing?.tierManualOverride ?? false
          : false,
      now,
      ...flags,
      });
    } catch (error) {
      if (error instanceof OptimisticConcurrencyError) {
        throw new AppError("This venue profile changed in another session. Refresh before saving your edits.", 409);
      }
      throw error;
    }

    await this.trackEvent(account, {
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

  private async assertBarBeerWriteReady(account: BusinessAccount, venueId: string, input: BarBeerInput): Promise<void> {
    await this.requireAssignedVenue(account, venueId);
    const existing = input.id ? await this.venueInventoryRepository.getBarBeerById(input.id) : null;
    if (existing && existing.barId !== venueId) {
      throw new AppError("Beer row belongs to another venue.", 403);
    }
    if (existing && !input.expectedUpdatedAt) {
      throw new AppError("Refresh this beer row before saving so a teammate's edits are not overwritten.", 409, {
        currentUpdatedAt: existing.updatedAt,
      });
    }
    if (existing && existing.updatedAt !== input.expectedUpdatedAt) {
      throw new AppError("This beer row changed in another session. Refresh before saving your edits.", 409, {
        currentUpdatedAt: existing.updatedAt,
      });
    }
  }

  async upsertBarBeer(account: BusinessAccount, venueId: string, input: BarBeerInput) {
    await this.assertBarBeerWriteReady(account, venueId, input);
    const now = nowIso();
    const beerInput = await this.standardizeBarBeerInput(
      input,
      this.isAdmin(account) ? "venue_inventory_admin" : "venue_inventory_manager",
      now,
    );
    return this.persistBarBeer(account, venueId, input, beerInput, now);
  }

  private async persistBarBeer(
    account: BusinessAccount,
    venueId: string,
    input: BarBeerInput,
    beerInput: BarBeerInput & { normalizedBeerId: string | null },
    now: string,
  ) {
    await this.assertBarBeerWriteReady(account, venueId, input);
    const assignment = await this.requireAssignedVenue(account, venueId);
    const existing = input.id ? await this.venueInventoryRepository.getBarBeerById(input.id) : null;
    const currentProfile = await this.venueInventoryRepository.getBarProfile(venueId);
    const profile = await this.ensureBarProfileAsync({
      barId: venueId,
      name: assignment?.venueName ?? currentProfile?.name ?? venueId,
      suburb: assignment?.suburb ?? currentProfile?.suburb ?? null,
    });
    const priceChanged = Boolean(existing) && existing?.price !== beerInput.price;
    const stockChanged = Boolean(existing) && (
      existing?.inStock !== beerInput.inStock || existing?.onTap !== beerInput.onTap
    );
    let beer;
    try {
      beer = await this.venueInventoryRepository.upsertBarBeer({
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
      priceVerifiedAt: beerInput.priceConfirmed
        ? now
        : priceChanged
          ? null
          : existing?.priceVerifiedAt ?? null,
      stockVerifiedAt: beerInput.stockConfirmed
        ? now
        : stockChanged
          ? null
          : existing?.stockVerifiedAt ?? null,
      expectedUpdatedAt: input.expectedUpdatedAt,
      now,
      });
    } catch (error) {
      if (error instanceof OptimisticConcurrencyError) {
        throw new AppError("This beer row changed in another session. Refresh before saving your edits.", 409);
      }
      throw error;
    }

    await this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId: normalizeTrackedBeerId(beer.beerName),
      suburb: profile.suburb,
      metadata: { section: "beer_inventory", onTap: beer.onTap, inStock: beer.inStock, hasPrice: beer.price != null },
    });

    return { beer, message: "Beer row saved." };
  }

  async bulkUpsertBarBeers(account: BusinessAccount, venueId: string, input: BarBeerBulkInput) {
    await this.requireAssignedVenue(account, venueId);
    const ids = input.items.map((item) => item.id).filter((id): id is string => Boolean(id));
    if (new Set(ids).size !== ids.length) {
      throw new AppError("Each beer row can appear only once in a bulk update.", 400);
    }
    for (const item of input.items) {
      await this.assertBarBeerWriteReady(account, venueId, item);
    }
    const standardized: Array<{
      input: BarBeerInput;
      beerInput: BarBeerInput & { normalizedBeerId: string | null };
      now: string;
    }> = [];
    for (const item of input.items) {
      const now = nowIso();
      standardized.push({
        input: item,
        beerInput: await this.standardizeBarBeerInput(
          item,
          this.isAdmin(account) ? "venue_inventory_admin" : "venue_inventory_manager",
          now,
        ),
        now,
      });
    }
    const results = await this.venueInventoryRepository.transaction(async () => {
      const beers = [];
      for (const { input: item, beerInput, now } of standardized) {
        beers.push((await this.persistBarBeer(account, venueId, item, beerInput, now)).beer);
      }
      return beers;
    });
    return {
      beers: results,
      total: results.length,
      priceVerifiedCount: results.filter((beer) => Boolean(beer.priceVerifiedAt)).length,
      stockVerifiedCount: results.filter((beer) => Boolean(beer.stockVerifiedAt)).length,
      message: `${results.length} beer row${results.length === 1 ? "" : "s"} saved atomically.`,
    };
  }

  async deleteBarBeer(account: BusinessAccount, venueId: string, beerId: string, expectedUpdatedAt: string) {
    const assignment = await this.requireAssignedVenue(account, venueId);
    const existing = await this.venueInventoryRepository.getBarBeerById(beerId);
    if (!existing || existing.barId !== venueId) {
      throw new AppError("Beer row not found for this venue.", 404);
    }
    if (existing.updatedAt !== expectedUpdatedAt) {
      throw new AppError("This beer row changed in another session. Refresh before deleting it.", 409, {
        currentUpdatedAt: existing.updatedAt,
      });
    }

    const queuedDelete = await this.maybeQueueVenueDeleteForReview({
      account,
      venueId,
      changeType: "beer",
      targetId: beerId,
      payload: {
        id: existing.id,
        beerName: existing.beerName,
        serveSize: existing.serveSize,
        price: existing.price,
        expectedUpdatedAt: existing.updatedAt,
      },
      suburb: assignment?.suburb ?? null,
    });
    if (queuedDelete) {
      return queuedDelete;
    }

    let deleted: boolean;
    try {
      deleted = await this.venueInventoryRepository.deleteBarBeer({ id: beerId, barId: venueId, expectedUpdatedAt });
    } catch (error) {
      if (error instanceof OptimisticConcurrencyError) {
        throw new AppError("This beer row changed in another session. Refresh before deleting it.", 409);
      }
      throw error;
    }
    if (!deleted) {
      throw new AppError("Beer row not found for this venue.", 404);
    }

    if (!this.isAdmin(account)) {
      await this.auditSecurity({
        actor: account,
        action: "venue_manager_delete",
        targetType: "venue_beer",
        targetId: beerId,
        metadata: { venueId, changeType: "beer" },
      });
    }

    await this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId,
      suburb: assignment?.suburb ?? null,
      metadata: { section: "beer_inventory", action: "delete", changeType: "beer" },
    });

    return { deleted: true, message: "Beer row removed." };
  }

  async upsertBarHappyHour(account: BusinessAccount, venueId: string, input: BarHappyHourInput) {
    const assignment = await this.requireAssignedVenue(account, venueId);
    const existing = input.id ? await this.venueInventoryRepository.getBarHappyHourById(input.id) : null;
    if (existing && existing.barId !== venueId) {
      throw new AppError("Happy-hour row belongs to another venue.", 403);
    }
    if (existing && !input.expectedUpdatedAt) {
      throw new AppError("Refresh this happy hour before saving so a teammate's edits are not overwritten.", 409, {
        currentUpdatedAt: existing.updatedAt,
      });
    }
    if (existing && existing.updatedAt !== input.expectedUpdatedAt) {
      throw new AppError("This happy hour changed in another session. Refresh before saving your edits.", 409, {
        currentUpdatedAt: existing.updatedAt,
      });
    }

    const currentProfile = await this.venueInventoryRepository.getBarProfile(venueId);
    const profile = await this.ensureBarProfileAsync({
      barId: venueId,
      name: assignment?.venueName ?? currentProfile?.name ?? venueId,
      suburb: assignment?.suburb ?? currentProfile?.suburb ?? null,
    });
    let happyHour;
    try {
      happyHour = await this.venueInventoryRepository.upsertBarHappyHour({
      id: input.id ?? crypto.randomUUID(),
      barId: venueId,
      title: input.title,
      daysOfWeek: input.daysOfWeek,
      startTime: input.startTime,
      endTime: input.endTime,
      description: input.description,
      happyHourBeers: input.happyHourBeers ?? [],
      active: input.active,
      expectedUpdatedAt: input.expectedUpdatedAt,
      now: nowIso(),
      });
    } catch (error) {
      if (error instanceof OptimisticConcurrencyError) {
        throw new AppError("This happy hour changed in another session. Refresh before saving your edits.", 409);
      }
      throw error;
    }

    await this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId: null,
      suburb: profile.suburb,
      metadata: { section: "happy_hours", active: happyHour.active, days: happyHour.daysOfWeek },
    });

    return { happyHour, message: "Happy hour saved." };
  }

  async deleteBarHappyHour(account: BusinessAccount, venueId: string, happyHourId: string, expectedUpdatedAt: string) {
    const assignment = await this.requireAssignedVenue(account, venueId);
    const existing = await this.venueInventoryRepository.getBarHappyHourById(happyHourId);
    if (!existing || existing.barId !== venueId) {
      throw new AppError("Happy hour not found for this venue.", 404);
    }
    if (existing.updatedAt !== expectedUpdatedAt) {
      throw new AppError("This happy hour changed in another session. Refresh before deleting it.", 409, {
        currentUpdatedAt: existing.updatedAt,
      });
    }

    const queuedDelete = await this.maybeQueueVenueDeleteForReview({
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

    let deleted: boolean;
    try {
      deleted = await this.venueInventoryRepository.deleteBarHappyHour({ id: happyHourId, barId: venueId, expectedUpdatedAt });
    } catch (error) {
      if (error instanceof OptimisticConcurrencyError) {
        throw new AppError("This happy hour changed in another session. Refresh before deleting it.", 409);
      }
      throw error;
    }
    if (!deleted) {
      throw new AppError("Happy hour not found for this venue.", 404);
    }

    await this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId: null,
      suburb: assignment?.suburb ?? null,
      metadata: { section: "happy_hours", action: "delete", changeType: "happy_hour" },
    });

    return { deleted: true, message: "Happy hour removed." };
  }

  async upsertBarSpecial(account: BusinessAccount, venueId: string, input: BarSpecialInput) {
    this.assertCommercialVenueFeatureOpen();
    const assignment = await this.requireAssignedVenue(account, venueId);
    await this.requireBarSpecialsTier(account, venueId);
    if (input.exclusive) {
      await this.requireFeaturedSpecialsTier(account, venueId);
    }
    const existing = input.id ? await this.venueInventoryRepository.getBarSpecialById(input.id) : null;
    if (existing && existing.barId !== venueId) {
      throw new AppError("Special belongs to another venue.", 403);
    }
    if (existing && !input.expectedUpdatedAt) {
      throw new AppError("Refresh this special before saving so a teammate's edits are not overwritten.", 409, {
        currentUpdatedAt: existing.updatedAt,
      });
    }
    if (existing && existing.updatedAt !== input.expectedUpdatedAt) {
      throw new AppError("This special changed in another session. Refresh before saving your edits.", 409, {
        currentUpdatedAt: existing.updatedAt,
      });
    }

    const currentProfile = await this.venueInventoryRepository.getBarProfile(venueId);
    const profile = await this.ensureBarProfileAsync({
      barId: venueId,
      name: assignment?.venueName ?? currentProfile?.name ?? venueId,
      suburb: assignment?.suburb ?? currentProfile?.suburb ?? null,
    });
    const recurrence = input.recurrence ?? {
      frequency: "none" as const,
      daysOfWeek: [],
      timezone: this.getReportTimezone(),
    };
    let special;
    try {
      special = await this.venueInventoryRepository.upsertBarSpecial({
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
      recurrenceFrequency: recurrence.frequency,
      daysOfWeek: recurrence.daysOfWeek,
      timezone: recurrence.timezone,
      scheduleNote: input.scheduleNote,
      exclusive: input.exclusive,
      active: input.active,
      expectedUpdatedAt: input.expectedUpdatedAt,
      now: nowIso(),
      });
    } catch (error) {
      if (error instanceof OptimisticConcurrencyError) {
        throw new AppError("This special changed in another session. Refresh before saving your edits.", 409);
      }
      throw error;
    }

    await this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId: null,
      suburb: profile.suburb,
      metadata: { section: "specials", active: special.active, exclusive: special.exclusive, hasPrice: special.price != null },
    });

    return { special, message: "Pint Path special saved." };
  }

  async deleteBarSpecial(account: BusinessAccount, venueId: string, specialId: string, expectedUpdatedAt: string) {
    this.assertCommercialVenueFeatureOpen();
    const assignment = await this.requireAssignedVenue(account, venueId);
    await this.requireBarSpecialsTier(account, venueId);
    const existing = await this.venueInventoryRepository.getBarSpecialById(specialId);
    if (!existing || existing.barId !== venueId) {
      throw new AppError("Special not found for this venue.", 404);
    }
    if (existing.updatedAt !== expectedUpdatedAt) {
      throw new AppError("This special changed in another session. Refresh before deleting it.", 409, {
        currentUpdatedAt: existing.updatedAt,
      });
    }

    const queuedDelete = await this.maybeQueueVenueDeleteForReview({
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

    let deleted: boolean;
    try {
      deleted = await this.venueInventoryRepository.deleteBarSpecial({ id: specialId, barId: venueId, expectedUpdatedAt });
    } catch (error) {
      if (error instanceof OptimisticConcurrencyError) {
        throw new AppError("This special changed in another session. Refresh before deleting it.", 409);
      }
      throw error;
    }
    if (!deleted) {
      throw new AppError("Special not found for this venue.", 404);
    }

    await this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "venue_update_submitted",
      venueId,
      beerId: null,
      suburb: assignment?.suburb ?? null,
      metadata: { section: "specials", action: "delete", changeType: "special" },
    });

    return { deleted: true, message: "Pint Path special removed." };
  }

  async reviewBarPendingChange(admin: BusinessAccount, changeId: string, input: BarPendingChangeReviewInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const now = nowIso();
    const pendingChange = await this.venuePendingChangeRepository.getBarPendingChangeById(changeId);
    if (!pendingChange) {
      throw new AppError("Pending venue change not found.", 404);
    }
    if (pendingChange.status !== "pending") {
      throw new AppError("Pending venue change has already been reviewed.", 409);
    }
    if (pendingChange.changeType === "special" && input.status === "approved") {
      this.assertCommercialVenueFeatureOpen();
      const profile = await this.venueInventoryRepository.getBarProfile(pendingChange.barId);
      if (!getBarTierCapabilities(profile?.membershipTier ?? "basic").canManageSpecials) {
        throw new AppError("Pro venue tier required to publish Pint Path specials.", 403);
      }
    }

    let resolvedBeerPayload: ResolvedVenueBeerPendingPayload | undefined;
    if (
      pendingChange.changeType === "beer"
      && pendingChange.action !== "delete"
      && input.status === "approved"
    ) {
      const payload = pendingChange.payload;
      const resolvedBeerInput = await this.standardizeBarBeerInput({
        id: pendingChange.targetId ?? stringOrNull(payload.id) ?? crypto.randomUUID(),
        beerName: stringOrNull(payload.beerName) ?? "Unnamed beer",
        brewery: stringOrNull(payload.brewery),
        style: stringOrNull(payload.style),
        abv: numberOrNull(payload.abv),
        serveSize: stringOrNull(payload.serveSize) as ServingSize | null,
        price: numberOrNull(payload.price),
        onTap: booleanFromUnknown(payload.onTap, false),
        inStock: booleanFromUnknown(payload.inStock, true),
        notes: stringOrNull(payload.notes),
        priceConfirmed: booleanFromUnknown(payload.priceConfirmed, false),
        stockConfirmed: booleanFromUnknown(payload.stockConfirmed, false),
        expectedUpdatedAt: null,
      }, "approved_venue_inventory_change", now);
      resolvedBeerPayload = {
        beerName: resolvedBeerInput.beerName,
        normalizedBeerId: resolvedBeerInput.normalizedBeerId,
        brewery: resolvedBeerInput.brewery,
        style: resolvedBeerInput.style,
        abv: resolvedBeerInput.abv,
        serveSize: resolvedBeerInput.serveSize,
        price: resolvedBeerInput.price,
        onTap: resolvedBeerInput.onTap,
        inStock: resolvedBeerInput.inStock,
        notes: resolvedBeerInput.notes,
        priceConfirmed: resolvedBeerInput.priceConfirmed,
        stockConfirmed: resolvedBeerInput.stockConfirmed,
      };
    }
    const result = await this.venuePendingChangeRepository.reviewBarPendingChange({
      id: pendingChange.id,
      status: input.status,
      reviewedBy: admin.id,
      expectedUpdatedAt: pendingChange.updatedAt,
      reviewedAt: now,
      rejectionReason: input.status === "rejected"
        ? input.rejectionReason ?? "Rejected by admin review."
        : null,
      ...(resolvedBeerPayload ? { resolvedBeerPayload } : {}),
    });

    await this.auditSecurity({
      actor: admin,
      action: "admin_venue_pending_change_review",
      targetType: "venue_pending_change",
      targetId: pendingChange.id,
      metadata: {
        venueId: pendingChange.barId,
        changeType: pendingChange.changeType,
        action: pendingChange.action,
        status: input.status,
      },
    });

    return {
      pendingChange: result.pendingChange,
      message: input.status === "approved" ? "Venue change approved and published." : "Venue change rejected. Public data was not changed.",
    };
  }

  async reviewVenuePendingChange(admin: BusinessAccount, changeId: string, input: BarPendingChangeReviewInput) {
    return this.reviewBarPendingChange(admin, changeId, input);
  }

  async assignVenueManager(admin: BusinessAccount, input: VenueManagerAssignmentInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const user = await this.accountSessionRepository.getAccountById(input.userId);
    if (!user) {
      throw new AppError("User account not found.", 404);
    }

    const accessLevel = input.accessLevel ?? "manager";
    if (accessLevel === "counter_staff") {
      this.assertCommercialVenueFeatureOpen();
      await this.requireCounterStaffInvitationAvailable(user.id, input.venueId);
    }
    const assignedAt = nowIso();
    const assignment = accessLevel === "counter_staff"
      ? (await this.venueAccessRepository.inviteCounterStaff({
          invitationToken: crypto.randomUUID(),
          inviterAccountId: admin.id,
          userId: user.id,
          venueId: input.venueId,
          venueName: input.venueName,
          suburb: input.suburb,
          now: assignedAt,
          expiresAt: addMinutes(assignedAt, COUNTER_STAFF_INVITATION_TTL_MINUTES),
        })).assignment
      : await this.venueAccessRepository.assignVenueManager({
          assignmentId: crypto.randomUUID(),
          adminAccountId: admin.id,
          userId: user.id,
          venueId: input.venueId,
          venueName: input.venueName,
          suburb: input.suburb,
          now: assignedAt,
        });
    await this.auditSecurity({
      actor: admin,
      action: accessLevel === "counter_staff" ? "admin_venue_counter_staff_invited" : "admin_venue_manager_assignment",
      targetType: "venue_manager_assignment",
      targetId: assignment.id,
      metadata: {
        managerUserId: assignment.userId,
        venueId: assignment.venueId,
        venueName: assignment.venueName,
        accessLevel: assignment.accessLevel,
      },
    });

    await this.trackEvent(admin, {
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

    return {
      assignment,
      message: accessLevel === "counter_staff"
        ? "Counter-staff invitation sent. Access starts after the account owner accepts it within 72 hours."
        : "Venue manager assigned.",
    };
  }

  async revokeVenueManager(admin: BusinessAccount, input: VenueManagerRevokeInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const existing = await this.venueAccessRepository.getVenueAssignment({
      userId: input.userId,
      venueId: input.venueId,
      activeOnly: false,
    });
    if (!existing || existing.status === "revoked") {
      throw new AppError("Venue manager assignment not found.", 404);
    }
    const revokeResult = await this.venueAccessRepository.revokeVenueAssignment({
      actorAccountId: admin.id,
      userId: input.userId,
      venueId: input.venueId,
      expectedAccessLevel: existing.accessLevel,
      now: nowIso(),
    });
    if (revokeResult.outcome === "duplicate") {
      throw new AppError("Venue manager assignment not found.", 404);
    }
    const assignment = revokeResult.assignment;
    // Re-evaluate and persist delivery recipients immediately so a revoked
    // manager cannot remain in a custom scheduled-report recipient list.
    await this.getVenueReportRecipients(assignment.venueId);
    await this.auditSecurity({
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

    await this.trackEvent(admin, {
      anonymousSessionId: null,
      eventType: "venue_manager_revoked",
      venueId: assignment.venueId,
      beerId: null,
      suburb: assignment.suburb,
      metadata: { managerUserId: assignment.userId, venueName: assignment.venueName },
    });

    return {
      assignment,
      message: "Venue manager revoked and removed from current assignments.",
    };
  }

  private async listVenueInterestOffsetPage(
    query: AdminPaginationInput,
    total: number,
  ): Promise<VenueInterestRecord[]> {
    const targetCount = query.offset + query.limit;
    if (!Number.isSafeInteger(targetCount) || targetCount > MAX_VENUE_PARTNER_ADMIN_SCAN_ROWS) {
      throw new AppError(
        `Venue-partner pagination is limited to the first ${MAX_VENUE_PARTNER_ADMIN_SCAN_ROWS} records.`,
        400,
      );
    }
    if (query.offset >= total) return [];

    const records: VenueInterestRecord[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: VenueInterestListCursor | null = null;
    while (records.length < targetCount) {
      const pageLimit = Math.min(VENUE_PARTNER_ADMIN_PAGE_SIZE, targetCount - records.length);
      const page = await this.venuePartnerRepository.listVenueInterests({ limit: pageLimit, cursor });
      if (page.interests.length > pageLimit) {
        throw new AppError("Venue-interest pagination exceeded its requested page size.", 500, undefined, false);
      }
      for (const interest of page.interests) {
        if (seenIds.has(interest.id)) {
          throw new AppError("Venue-interest pagination returned a duplicate record.", 500, undefined, false);
        }
        seenIds.add(interest.id);
        records.push(interest);
      }
      if (!page.nextCursor) {
        if (records.length < Math.min(targetCount, total)) {
          throw new AppError("Venue-interest pagination ended before its counted result set.", 500, undefined, false);
        }
        break;
      }
      if (page.interests.length === 0) {
        throw new AppError("Venue-interest pagination did not make progress.", 500, undefined, false);
      }
      const cursorKey = `${page.nextCursor.createdAt}\0${page.nextCursor.id}`;
      const last = page.interests.at(-1);
      if (
        seenCursors.has(cursorKey)
        || !last
        || last.createdAt !== page.nextCursor.createdAt
        || last.id !== page.nextCursor.id
      ) {
        throw new AppError("Venue-interest pagination returned an invalid cursor.", 500, undefined, false);
      }
      seenCursors.add(cursorKey);
      cursor = page.nextCursor;
    }
    return records.slice(query.offset, targetCount);
  }

  private async listVenuePartnerOutreachOffsetPage(
    query: AdminPaginationInput,
    total: number,
  ): Promise<VenuePartnerOutreachRecord[]> {
    const targetCount = query.offset + query.limit;
    if (!Number.isSafeInteger(targetCount) || targetCount > MAX_VENUE_PARTNER_ADMIN_SCAN_ROWS) {
      throw new AppError(
        `Venue-partner pagination is limited to the first ${MAX_VENUE_PARTNER_ADMIN_SCAN_ROWS} records.`,
        400,
      );
    }
    if (query.offset >= total) return [];

    const records: VenuePartnerOutreachRecord[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: VenuePartnerOutreachListCursor | null = null;
    while (records.length < targetCount) {
      const pageLimit = Math.min(VENUE_PARTNER_ADMIN_PAGE_SIZE, targetCount - records.length);
      const page = await this.venuePartnerRepository.listVenuePartnerOutreach({ limit: pageLimit, cursor });
      if (page.outreach.length > pageLimit) {
        throw new AppError("Venue-outreach pagination exceeded its requested page size.", 500, undefined, false);
      }
      for (const outreach of page.outreach) {
        if (seenIds.has(outreach.id)) {
          throw new AppError("Venue-outreach pagination returned a duplicate record.", 500, undefined, false);
        }
        seenIds.add(outreach.id);
        records.push(outreach);
      }
      if (!page.nextCursor) {
        if (records.length < Math.min(targetCount, total)) {
          throw new AppError("Venue-outreach pagination ended before its counted result set.", 500, undefined, false);
        }
        break;
      }
      if (page.outreach.length === 0) {
        throw new AppError("Venue-outreach pagination did not make progress.", 500, undefined, false);
      }
      const cursorKey = `${page.nextCursor.updatedAt}\0${page.nextCursor.venueId}`;
      const last = page.outreach.at(-1);
      if (
        seenCursors.has(cursorKey)
        || !last
        || last.updatedAt !== page.nextCursor.updatedAt
        || last.venueId !== page.nextCursor.venueId
      ) {
        throw new AppError("Venue-outreach pagination returned an invalid cursor.", 500, undefined, false);
      }
      seenCursors.add(cursorKey);
      cursor = page.nextCursor;
    }
    return records.slice(query.offset, targetCount);
  }

  async getVenuePartnerAdmin(admin: BusinessAccount, query: AdminPaginationInput = { limit: 100, offset: 0 }) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const [
      claimRequestsTotal,
      assignmentsTotal,
      pendingChangesTotal,
      interestTotal,
      outreachTotal,
      closedOutreach,
      notInterestedOutreach,
    ] = await Promise.all([
      this.venueAccessRepository.countVenueClaims(),
      this.venueAccessRepository.countVenueAssignments({ currentOnly: true }),
      this.venuePendingChangeRepository.countBarPendingChanges({ status: "pending" }),
      this.venuePartnerRepository.countVenueInterests(),
      this.venuePartnerRepository.countVenuePartnerOutreach(),
      this.venuePartnerRepository.countVenuePartnerOutreach({ status: "closed" }),
      this.venuePartnerRepository.countVenuePartnerOutreach({ status: "not_interested" }),
    ]);
    const totals = {
      claimRequests: claimRequestsTotal,
      assignments: assignmentsTotal,
      pendingChanges: pendingChangesTotal,
      interests: interestTotal,
      outreach: outreachTotal,
      openOutreach: Math.max(0, outreachTotal - closedOutreach - notInterestedOutreach),
    };
    const [assignmentPage, interests, claimPage, pendingChanges, outreach] = await Promise.all([
      this.getVenueAssignmentOffsetPage({ currentOnly: true }, query, totals.assignments),
      this.listVenueInterestOffsetPage(query, totals.interests),
      this.getVenueClaimOffsetPage({}, query, totals.claimRequests),
      this.venuePendingChangeRepository.listBarPendingChanges({ status: "pending", ...query }),
      this.listVenuePartnerOutreachOffsetPage(query, totals.outreach),
    ]);
    const assignments = await Promise.all(assignmentPage.map(async (assignment) => {
      const manager = await this.accountSessionRepository.getAccountById(assignment.userId);
      return {
        ...assignment,
        managerEmail: manager?.email ?? null,
        managerDisplayName: manager?.displayName ?? null,
        managerPublicAccountId: manager?.publicAccountId ?? null,
      };
    }));

    const claimRequests = claimPage.map((claim) => this.toBarClaimRequest(claim));
    const leadAsOf = nowIso();
    const leads = await this.adminAnalyticsRepository.getPotentialPartnerLeads({
      staleBefore: daysAgoIso(90, leadAsOf),
      limit: 25,
    });
    const leadVenueIds = leads.map((lead) => lead.venueId);
    // These are bounded, independently current table-owner reads. They are not
    // presented as a cross-repository transactional snapshot.
    const [assignedVenueIds, leadOutreach] = await Promise.all([
      this.venueAccessRepository.listActiveAssignedVenueIds({ venueIds: leadVenueIds }),
      this.venuePartnerRepository.listVenuePartnerOutreachByVenueIds({ venueIds: leadVenueIds }),
    ]);
    const leadRelationshipContext = {
      assignedVenueIds,
      outreachByVenueId: Object.fromEntries(
        leadOutreach.map((outreach) => [outreach.venueId, outreach]),
      ),
    };
    return {
      interests,
      claimRequests,
      assignments,
      pendingChanges,
      outreach,
      totals,
      pagination: {
        ...query,
        hasMore: {
          interests: query.offset + interests.length < totals.interests,
          claimRequests: query.offset + claimRequests.length < totals.claimRequests,
          assignments: query.offset + assignments.length < totals.assignments,
          pendingChanges: query.offset + pendingChanges.length < totals.pendingChanges,
          outreach: query.offset + outreach.length < totals.outreach,
        },
      },
      leads,
      leadRelationshipContext,
    };
  }

  async searchAccountsForAdmin(admin: BusinessAccount, query: AdminAccountSearchInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    return {
      accounts: await this.adminAccountRepository.searchAccountsForAdmin({
        actorAccountId: admin.id,
        query: query.q,
        limit: query.limit,
      }),
    };
  }

  async updateVenueInterestStatus(admin: BusinessAccount, interestId: string, input: VenueInterestStatusInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const existing = await this.venuePartnerRepository.getVenueInterestById(interestId);
    if (!existing) {
      throw new AppError("Venue interest request not found.", 404);
    }
    const interest = await this.venuePartnerRepository.updateVenueInterestWorkflow({
      actorAccountId: admin.id,
      interestId,
      status: input.status,
      assignedTo: existing.assignedTo,
      resolutionNote: existing.resolutionNote,
      expectedUpdatedAt: input.expectedUpdatedAt,
      now: nowIso(),
    });
    await this.auditSecurity({
      actor: admin,
      action: "admin_venue_interest_status_update",
      targetType: "venue_interest",
      targetId: interest.id,
      metadata: { status: interest.status, venueId: interest.venueId, venueName: interest.venueName },
    });

    await this.trackEvent(admin, {
      anonymousSessionId: null,
      eventType: "outreach_status_updated",
      venueId: interest.venueId,
      beerId: null,
      suburb: null,
      metadata: { interestId: interest.id, status: interest.status },
    });

    return { interest };
  }

  async upsertVenueOutreach(admin: BusinessAccount, input: VenueOutreachInput) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const existing = await this.venuePartnerRepository.getVenuePartnerOutreachByVenueId(input.venueId);
    const result = await this.venuePartnerRepository.upsertVenuePartnerOutreach({
      actorAccountId: admin.id,
      id: existing?.id ?? crypto.randomUUID(),
      venueId: input.venueId,
      venueName: input.venueName,
      suburb: input.suburb,
      status: input.status,
      tierFit: input.tierFit,
      nextAction: input.nextAction,
      // The admin form historically submits a date-only value. Keep that API
      // compatibility at the service boundary while persistence remains strict.
      lastContactedAt: canonicalVenueOutreachContactTimestamp(input.lastContactedAt),
      contactName: input.contactName,
      notes: input.notes,
      expectedUpdatedAt: input.expectedUpdatedAt ?? null,
      now: nowIso(),
    });
    const { outreach } = result;
    if (!result.replayed) {
      await this.auditSecurity({
        actor: admin,
        action: "admin_venue_outreach_update",
        targetType: "venue",
        targetId: outreach.venueId,
        metadata: { status: outreach.status, venueName: outreach.venueName },
      });

      await this.trackEvent(admin, {
        anonymousSessionId: null,
        eventType: "outreach_status_updated",
        venueId: outreach.venueId,
        beerId: null,
        suburb: outreach.suburb,
        metadata: { status: outreach.status },
      });
    }

    return { outreach, replayed: result.replayed };
  }

  async getAdminKpis(admin: BusinessAccount, query: AdminDashboardQuery) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const asOf = nowIso();
    const [knownVenues, missionCount] = await Promise.all([
      this.adminAnalyticsRepository.countKnownVenues(),
      this.missionLifecycleRepository.countMissions({ activeOnly: false }),
    ]);
    const totalVenues = Math.max(knownVenues, missionCount);
    const dashboard = await this.adminAnalyticsRepository.getAdminKpiDashboard({
      since: startOfAdminRange(query.range, asOf),
      asOf,
      sevenDaysAgo: daysAgoIso(7, asOf),
      thirtyDaysAgo: daysAgoIso(30, asOf),
      staleBefore: daysAgoIso(90, asOf),
      totalVenues,
    });
    return {
      ...dashboard,
      asOf,
      topSearchedBeers: this.applyAnalyticsThreshold(dashboard.topSearchedBeers),
      topSearchedSuburbs: this.applyAnalyticsThreshold(dashboard.topSearchedSuburbs),
      topClickedVenues: this.applyAnalyticsThreshold(dashboard.topClickedVenues),
      highDemandVenuesWithStaleOrMissingData: this.applyAnalyticsThreshold(
        dashboard.highDemandVenuesWithStaleOrMissingData,
      ),
      suppressedBelowCount: this.config.ANALYTICS_MIN_BUCKET_SIZE,
    };
  }

  async getRetentionCohorts(admin: BusinessAccount, query: RetentionQuery) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const asOf = nowIso();
    const [cohorts, savedUpdatesExperiment] = await Promise.all([
      this.adminAnalyticsRepository.getRetentionCohorts({ ...query, asOf }),
      this.adminAnalyticsRepository.getSavedUpdatesExperimentRollup({
        experimentVersion: SAVED_UPDATES_EXPERIMENT_VERSION,
        asOf,
      }),
    ]);
    return {
      groupBy: query.groupBy,
      asOf,
      population: "optional_analytics_enabled_accounts" as const,
      cohortAnchor: "current_optional_analytics_opt_in_episode" as const,
      populationCaveat: "Directional product-loop cohorts include only accounts currently opted into optional analytics and begin at the later of account creation or the recorded start of the current analytics opt-in episode. Legacy rows use a consent-time backfill, so this is not signup retention and does not represent all accounts.",
      cohorts,
      savedUpdatesExperiment: {
        definition: "saved_updates_d7_intent_to_treat_v1" as const,
        evidenceStatus: "directional_opt_in_experiment" as const,
        formalReleaseEvidence: false as const,
        experimentVersion: savedUpdatesExperiment.experimentVersion,
        observedD7RetentionDifference: savedUpdatesExperiment.observedD7RetentionDifference,
        population: "currently_opted_in_free_or_contributor_consumers_with_recorded_v1_dashboard_assignment" as const,
        anchor: "first_server_recorded_account_dashboard_viewed_in_current_opt_in_episode" as const,
        eligibilityDefinition: "The server observed at least one venue or beer save when it stored the neutral dashboard assignment event. This immutable baseline does not prove that a Saved Update was available.",
        exposureDefinition: "A server-validated Saved Updates panel view during UTC D0-D7. Exposure is treatment-only and is diagnostic, not the retention outcome.",
        outcomeDefinition: "At least one authenticated, variant-neutral core-loop event on UTC D1-D7 after assignment. Saved Updates view/open events are excluded.",
        caveat: "Directional intent-to-treat evidence only: v1 begins with the first persisted v1 assignment event after deployment; no commit-time or historical events are backfilled. Assignment is observed only for baseline Free or contributor consumer accounts currently opted into optional analytics whose neutral dashboard event was stored. Existing accounts enter on their first recorded dashboard view in the current opt-in episode. Compare D7 retention only after both arms have mature denominators; eligibility and exposure are diagnostics and must not be used to select the primary comparison population.",
        variants: savedUpdatesExperiment.variants,
      },
    };
  }

  async getCoverageDashboard(admin: BusinessAccount) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const asOf = nowIso();
    const [knownVenues, missionCount] = await Promise.all([
      this.adminAnalyticsRepository.countKnownVenues(),
      this.missionLifecycleRepository.countMissions({ activeOnly: false }),
    ]);
    const totalVenues = Math.max(knownVenues, missionCount);
    return this.adminAnalyticsRepository.getCoverageDashboard({
      staleBefore: daysAgoIso(90, asOf),
      asOf,
      totalVenues,
    });
  }

  async getPotentialPartnerLeads(admin: BusinessAccount) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    return {
      leads: await this.adminAnalyticsRepository.getPotentialPartnerLeads({
        staleBefore: daysAgoIso(90, nowIso()),
        limit: 20,
      }),
    };
  }

  private async listVenueRequestOffsetPage(query: AdminPaginationInput): Promise<VenueRequestRecord[]> {
    const targetCount = query.offset + query.limit;
    if (!Number.isSafeInteger(targetCount) || targetCount > MAX_VENUE_REQUEST_ADMIN_SCAN_ROWS) {
      throw new AppError(
        `Venue-request pagination is limited to the first ${MAX_VENUE_REQUEST_ADMIN_SCAN_ROWS} records.`,
        400,
      );
    }

    const records: VenueRequestRecord[] = [];
    const seenRequestIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: VenueRequestListCursor | null = null;
    while (records.length < targetCount) {
      const page = await this.venueRequestRepository.listVenueRequests({
        limit: Math.min(VENUE_REQUEST_ADMIN_PAGE_SIZE, targetCount - records.length),
        cursor,
      });
      for (const request of page.requests) {
        if (seenRequestIds.has(request.id)) {
          throw new AppError("Venue-request pagination returned a duplicate record.", 500, undefined, false);
        }
        seenRequestIds.add(request.id);
        records.push(request);
      }
      if (!page.nextCursor) break;
      if (page.requests.length === 0) {
        throw new AppError("Venue-request pagination did not make progress.", 500, undefined, false);
      }
      const cursorKey = `${page.nextCursor.createdAt}\0${page.nextCursor.id}`;
      if (seenCursors.has(cursorKey)) {
        throw new AppError("Venue-request pagination repeated a cursor.", 500, undefined, false);
      }
      const last = page.requests.at(-1);
      if (
        !last
        || last.createdAt !== page.nextCursor.createdAt
        || last.id !== page.nextCursor.id
      ) {
        throw new AppError("Venue-request pagination returned an invalid cursor.", 500, undefined, false);
      }
      seenCursors.add(cursorKey);
      cursor = page.nextCursor;
    }
    return records.slice(query.offset, targetCount);
  }

  async getAdminQueues(admin: BusinessAccount, query: AdminPaginationInput = { limit: 50, offset: 0 }) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const [
      feedback,
      wrongPriceReports,
      venueRequests,
      feedbackTotal,
      wrongPriceReportTotal,
      venueRequestTotal,
    ] = await Promise.all([
      this.supportFeedbackRepository.listFeedback(query),
      this.supportFeedbackRepository.listWrongPriceReports(query),
      this.listVenueRequestOffsetPage(query),
      this.supportFeedbackRepository.countFeedback(),
      this.supportFeedbackRepository.countWrongPriceReports(),
      this.venueRequestRepository.countVenueRequests(),
    ]);
    const totals = {
      feedback: feedbackTotal,
      wrongPriceReports: wrongPriceReportTotal,
      venueRequests: venueRequestTotal,
    };
    return {
      feedback,
      wrongPriceReports,
      venueRequests,
      totals,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        hasMore: {
          feedback: query.offset + feedback.length < totals.feedback,
          wrongPriceReports: query.offset + wrongPriceReports.length < totals.wrongPriceReports,
          venueRequests: query.offset + venueRequests.length < totals.venueRequests,
        },
      },
    };
  }

  async getOperationalHealth(admin: BusinessAccount) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }
    const keys = [
      "job:offsite_backup",
      "job:restore_rehearsal",
      "job:evidence_retention",
      "job:menu_ocr",
      "job:stripe_webhook",
      "job:account_deletion_notifications",
      AUTO_MISSION_REFRESH_STATE_KEY,
    ];
    const jobs = await Promise.all(keys.map(async (key) => {
      const state = await this.systemStateRepository.get<Record<string, unknown>>(key);
      return {
        key,
        state: state?.value ?? { state: "not_run" },
        updatedAt: state?.updatedAt ?? null,
      };
    }));
    return {
      checkedAt: nowIso(),
      jobs,
    };
  }

  async updateTrustQueueItem(
    admin: BusinessAccount,
    kind: "feedback" | "wrong_price" | "venue_request",
    id: string,
    input: TrustWorkflowUpdateInput,
  ) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }
    let assignedTo: string | null = null;
    if (input.assignedTo) {
      const assignee = input.assignedTo === "self"
        ? admin
        : await this.accountSessionRepository.getAccountById(input.assignedTo)
          ?? await this.accountSessionRepository.getAccountByPublicAccountId(input.assignedTo);
      if (!assignee || assignee.status !== "active" || !this.isAdmin(assignee)) {
        throw new AppError("Trust queue assignee must be an active, authorised administrator.", 400);
      }
      assignedTo = assignee.id;
    }
    const trustUpdatedAt = new Date(Math.max(
      Date.now(),
      new Date(input.expectedUpdatedAt).getTime() + 1,
    )).toISOString();
    const workflowInput = {
      id,
      status: input.status,
      assignedTo,
      resolutionNote: input.resolutionNote,
      resolvedBy: admin.id,
      expectedUpdatedAt: input.expectedUpdatedAt,
      now: trustUpdatedAt,
    };
    let item: unknown;
    if (kind === "venue_request") {
      item = await this.venueRequestRepository.updateTrustWorkflow({
        actorAccountId: admin.id,
        requestId: id,
        status: input.status,
        assignedTo,
        resolutionNote: input.resolutionNote,
        expectedUpdatedAt: input.expectedUpdatedAt,
        now: trustUpdatedAt,
      });
    } else {
      const result = kind === "feedback"
        ? await this.supportFeedbackRepository.updateFeedbackWorkflow(workflowInput)
        : await this.supportFeedbackRepository.updateWrongPriceWorkflow(workflowInput);
      if (result.state === "not_found") {
        throw new AppError("Trust queue item not found.", 404);
      }
      if (result.state === "conflict") {
        throw new AppError("This trust queue item changed. Refresh it before saving.", 409);
      }
      item = result.item;
    }
    await this.auditSecurity({
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

  async createMissionFromRequest(admin: BusinessAccount, requestId: string) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const currentRequest = await this.venueRequestRepository.getVenueRequestById(requestId);
    if (!currentRequest) throw new AppError("Request not found.", 404);
    const result = await this.venueRequestRepository.createMissionFromVenueRequest({
      actorAccountId: admin.id,
      requestId,
      missionId: crypto.randomUUID(),
      expectedRequestUpdatedAt: currentRequest.updatedAt,
      now: nowIso(),
    });
    const { mission, request } = result;

    await this.trackEvent(admin, {
      anonymousSessionId: null,
      eventType: "mission_created_from_request",
      venueId: mission.venueId,
      beerId: request.beerName ? normalizeTrackedBeerId(request.beerName) : null,
      suburb: request.suburb,
      metadata: { requestId: request.id, missionId: mission.id },
    });

    return { mission, request };
  }

  private assertCommercialEnrollmentOpen(): void {
    if (!this.config.COMMERCIAL_LAUNCH_ENABLED) {
      throw new AppError(
        "Paid and introductory-trial venue enrollment is not available in the current Free release.",
        503,
        { publicCode: "COMMERCIAL_LAUNCH_DISABLED" },
      );
    }
  }

  assertCommercialVenueFeatureOpen(): void {
    if (!this.config.COMMERCIAL_LAUNCH_ENABLED) {
      throw new AppError(
        "This venue feature is not available in the current Free release.",
        404,
        { publicCode: "COMMERCIAL_VENUE_FEATURE_DISABLED" },
      );
    }
  }

  private assertConsumerPaidEnrollmentOpen(): void {
    if (!this.config.CONSUMER_PAID_ENROLLMENT_ENABLED) {
      throw new AppError(
        "Consumer paid enrollment is not available in the current Free release.",
        503,
        { publicCode: "CONSUMER_PAID_ENROLLMENT_DISABLED" },
      );
    }
  }

  async createCheckout(account: BusinessAccount, input: CheckoutInput) {
    this.assertCommercialVenueFeatureOpen();
    this.requireCurrentLegalAcceptance(account);
    if (await this.accountSessionRepository.hasDeletionLock(account.id)) {
      throw new AppError("Billing changes are unavailable while account deletion is being processed.", 409);
    }
    if (!account.ageConfirmedAt) {
      throw new AppError("Please confirm you are 18+ before starting checkout.", 403);
    }

    this.assertConsumerPaidEnrollmentOpen();

    if (
      account.stripeCustomerId &&
      (
        account.stripePaidSubscriptionStatus === "premium_monthly" ||
        account.stripePaidSubscriptionStatus === "premium_yearly"
      )
    ) {
      const portal = await this.createStripeBillingPortalSession(
        account.stripeCustomerId,
        "/account.html?billing=returned",
      );
      return {
        ...portal,
        mode: "portal",
        checkoutUrl: portal.portalUrl,
        message: "Your Stripe billing profile already exists. Manage, recover, or change it in the billing portal.",
      };
    }

    const requestedPriceId = input.plan === "monthly"
      ? this.config.STRIPE_PRICE_MONTHLY
      : this.config.STRIPE_PRICE_YEARLY;

    await this.trackEvent(account, {
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

    if (!this.config.STRIPE_SECRET_KEY || !requestedPriceId) {
      throw new AppError("Stripe checkout is not configured for this plan.", 503);
    }

    const reservationNow = nowIso();
    const reservation = await this.billingCheckoutRepository.claimBillingCheckoutReservation({
      actorAccountId: account.id,
      subjectType: "consumer",
      subjectId: account.id,
      productKey: `consumer:${input.plan}`,
      reservationToken: crypto.randomUUID(),
      expiresAt: new Date(Date.parse(reservationNow) + STRIPE_CHECKOUT_RESERVATION_TTL_MS).toISOString(),
      now: reservationNow,
    });
    if (reservation.checkoutUrl) {
      return {
        mode: "stripe",
        checkoutUrl: reservation.checkoutUrl,
        message: "Resume the existing Stripe Checkout session. A second subscription session was not created.",
      };
    }
    const effectivePlan = reservation.productKey === "consumer:yearly" ? "yearly" : "monthly";
    const priceId = effectivePlan === "monthly"
      ? this.config.STRIPE_PRICE_MONTHLY
      : this.config.STRIPE_PRICE_YEARLY;
    const subscriptionStatus: SubscriptionStatus = effectivePlan === "monthly"
      ? "premium_monthly"
      : "premium_yearly";
    if (!priceId) {
      throw new AppError("The reserved Stripe checkout plan is not configured.", 503);
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
        "Idempotency-Key": crypto.createHash("sha256")
          .update(`consumer-checkout:${reservation.reservationToken}`)
          .digest("hex"),
      },
      body: formEncode({
        mode: "subscription",
        success_url: successUrlWithSession,
        cancel_url: cancelUrl,
        "automatic_tax[enabled]": "true",
        expires_at: String(Math.floor(Date.parse(reservation.expiresAt) / 1000)),
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        "metadata[user_id]": account.id,
        "metadata[subscription_status]": subscriptionStatus,
        "subscription_data[metadata][billing_context]": "consumer",
        "subscription_data[metadata][user_id]": account.id,
        "subscription_data[metadata][subscription_status]": subscriptionStatus,
        ...(account.stripeCustomerId
          ? { customer: account.stripeCustomerId }
          : { customer_email: account.email }),
      }),
    });

    const payload = (await response.json().catch(() => null)) as {
      id?: string;
      url?: string;
      error?: { message?: string };
    } | null;

    if (!response.ok || !payload?.url) {
      throw new ExternalServiceError(describeStripeCheckoutFailure(response.status, payload?.error?.message), {
        status: response.status,
        message: payload?.error?.message,
      });
    }

    const finalizedReservation = await this.billingCheckoutRepository.finalizeBillingCheckoutReservation({
      actorAccountId: account.id,
      subjectType: "consumer",
      subjectId: account.id,
      reservationToken: reservation.reservationToken,
      stripeCheckoutSessionId: payload.id ?? null,
      checkoutUrl: payload.url,
      now: nowIso(),
    });
    return {
      mode: "stripe",
      checkoutUrl: finalizedReservation.checkoutUrl!,
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
      throw new AppError("Stripe billing management is not configured.", 503, {
        publicCode: "BILLING_PORTAL_NOT_CONFIGURED",
      });
    }
    if (!customerId) {
      throw new AppError(
        "This premium access is not linked to a paid Stripe subscription, so there is no Stripe billing profile to manage or cancel. Contact support if you expected a paid subscription.",
        409,
        { publicCode: "BILLING_CUSTOMER_UNLINKED" },
      );
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
    const payload = await response.json().catch(() => null) as {
      url?: string;
      error?: { code?: string; message?: string; param?: string; type?: string };
    } | null;
    if (!response.ok || !payload?.url) {
      const failure = describeStripeBillingPortalFailure(response.status, payload?.error);
      throw new AppError(failure.message, failure.statusCode, {
        publicCode: failure.publicCode,
        stripeStatus: response.status,
        stripeType: payload?.error?.type,
        stripeCode: payload?.error?.code,
        stripeParam: payload?.error?.param,
        stripeRequestId: response.headers.get("request-id"),
      });
    }
    return { mode: "stripe", portalUrl: requireTrustedStripeBillingPortalUrl(payload.url) };
  }

  async createBillingPortal(account: BusinessAccount) {
    this.assertCommercialVenueFeatureOpen();
    const result = await this.createStripeBillingPortalSession(account.stripeCustomerId ?? "", "/account.html?billing=returned");
    await this.auditSecurity({
      actor: account,
      action: "stripe_billing_portal_opened",
      targetType: "account",
      targetId: account.id,
      metadata: { billingContext: "user" },
    });
    return result;
  }

  private async getSuspendedBillingRecoveryOptions(account: BusinessAccount) {
    const assignments = await this.collectVenueAssignments({
      userId: account.id,
      accessLevel: "manager",
      status: "active",
    });
    const venues = (await Promise.all(assignments.map(async (assignment) => {
        const profile = await this.venueInventoryRepository.getBarProfile(assignment.venueId);
        return profile?.stripeCustomerId
          ? [{ venueId: assignment.venueId, venueName: assignment.venueName }]
          : [];
      }))).flat();
    return { consumer: Boolean(account.stripeCustomerId), venues };
  }

  async createSuspendedAccountBillingPortal(input: BillingRecoveryPortalInput, context?: SessionRequestContext | undefined) {
    this.assertCommercialVenueFeatureOpen();
    let account: BusinessAccount | null = null;
    if (input.accessToken) {
      if (!this.supabase) {
        throw new AppError("Supabase authentication is not configured.", 503);
      }
      const { data, error } = await this.supabase.auth.getUser(input.accessToken);
      if (error || !data.user?.id || !data.user.email) {
        throw new AppError("Invalid billing recovery credentials.", 401);
      }
      const [byProviderId, byEmail] = await Promise.all([
        this.accountSessionRepository.getAccountBySupabaseUserId(data.user.id),
        this.accountSessionRepository.getAccountByEmail(normalizeEmail(data.user.email)),
      ]);
      if (byProviderId && byEmail && byProviderId.id !== byEmail.id) {
        throw new AppError("This provider identity conflicts with another Pint Path account. Contact support.", 409);
      }
      account = byProviderId ?? byEmail;
      if (!account || account.authProvider !== "supabase" || account.supabaseUserId !== data.user.id) {
        throw new AppError("Invalid billing recovery credentials.", 401);
      }
      requireSupabaseMfaAssurance(data.user, input.accessToken);
      requireFreshSupabaseCredentialCeremony(input.accessToken);
      if (account.providerTokensValidAfter) {
        const issuedAt = getSupabaseTokenIssuedAt(input.accessToken);
        if (!issuedAt || Date.parse(issuedAt) <= Date.parse(account.providerTokensValidAfter)) {
          throw new AppError("This sign-in token predates a security reset. Sign in again to manage billing.", 401);
        }
      }
      const providerSessionIdHash = getSupabaseSessionIdHash(input.accessToken);
      if (!providerSessionIdHash || await this.accountSessionRepository.isProviderSessionRevoked({
        userId: account.id,
        providerSessionIdHash,
      })) {
        throw new AppError("This provider session was revoked. Sign in again to manage billing.", 401);
      }
    } else if (input.email && input.password) {
      const candidate = await this.accountSessionRepository.getAccountByEmail(normalizeEmail(input.email));
      if (!candidate || candidate.authProvider !== "local" || !await verifyPassword(input.password, candidate.passwordHash)) {
        throw new AppError("Invalid billing recovery credentials.", 401);
      }
      account = candidate;
    }

    if (!account || account.status !== "suspended") {
      throw new AppError("Billing recovery is only available for suspended accounts. Sign in normally to manage billing.", 403);
    }
    if (account.authProvider === "deleted" || await this.accountSessionRepository.hasDeletionLock(account.id)) {
      throw new AppError("Deleted accounts cannot open billing recovery.", 410);
    }
    const recoveryOptions = await this.getSuspendedBillingRecoveryOptions(account);
    let billingContext: "consumer" | "venue" = "consumer";
    let venueId: string | null = null;
    let customerId = account.stripeCustomerId;
    if (input.venueId) {
      const requestedVenue = recoveryOptions.venues.find((venue) => venue.venueId === input.venueId);
      if (!requestedVenue) {
        throw new AppError("Only an assigned venue manager can recover that venue's billing. Counter access is not sufficient.", 403);
      }
      billingContext = "venue";
      venueId = requestedVenue.venueId;
      customerId = (await this.venueInventoryRepository.getBarProfile(requestedVenue.venueId))?.stripeCustomerId ?? null;
    } else if (!customerId && recoveryOptions.venues.length === 1) {
      billingContext = "venue";
      venueId = recoveryOptions.venues[0]!.venueId;
      customerId = (await this.venueInventoryRepository.getBarProfile(venueId))?.stripeCustomerId ?? null;
    } else if (!customerId && recoveryOptions.venues.length > 1) {
      throw new AppError("Choose which managed venue billing profile to recover.", 409, {
        publicCode: "BILLING_RECOVERY_VENUE_SELECTION_REQUIRED",
        billingRecoveryEligible: true,
        billingRecoveryConsumer: false,
        billingRecoveryVenues: recoveryOptions.venues,
      });
    }
    const result = await this.createStripeBillingPortalSession(
      customerId ?? "",
      "/pricing.html?billing=recovery-returned",
    );
    await this.auditSecurity({
      actor: account,
      action: "suspended_account_billing_portal_opened",
      targetType: billingContext === "venue" ? "venue" : "account",
      targetId: venueId ?? account.id,
      metadata: { billingContext, authProvider: account.authProvider, accountId: account.id },
      context,
    });
    return {
      ...result,
      accountId: account.publicAccountId,
      billingContext,
      venueId,
      message: "Billing portal opened without restoring application access.",
    };
  }

  async createBarBillingPortal(account: BusinessAccount, venueId: string) {
    this.assertCommercialVenueFeatureOpen();
    this.requireVerifiedBarAccount(account);
    await this.requireAssignedVenue(account, venueId);
    const profile = await this.venueInventoryRepository.getBarProfile(venueId);
    if (!profile) {
      throw new AppError("This venue does not have a billing profile.", 409);
    }
    const result = await this.createStripeBillingPortalSession(
      profile.stripeCustomerId ?? "",
      `/venue-portal.html?venueId=${encodeURIComponent(venueId)}&billing=returned`,
    );
    await this.auditSecurity({
      actor: account,
      action: "stripe_billing_portal_opened",
      targetType: "venue",
      targetId: venueId,
      metadata: { billingContext: "venue" },
    });
    return result;
  }

  async reconcileCheckoutSession(account: BusinessAccount, input: CheckoutSessionInput) {
    this.assertCommercialVenueFeatureOpen();
    if (account.authProvider === "deleted" || await this.accountSessionRepository.hasDeletionLock(account.id)) {
      throw new AppError("Deleted accounts cannot restore billing access.", 410);
    }
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
      await this.auditSecurity({
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

    const checkoutObject = payload as unknown as Record<string, unknown>;
    if (!isStripeCheckoutSettled(checkoutObject)) {
      throw new AppError("Stripe checkout payment is not settled yet. Please wait a few seconds and refresh Account.", 409);
    }

    const subscriptionId = stripeObjectId(payload.subscription);
    if (!subscriptionId) {
      throw new AppError("Stripe checkout is not linked to a subscription.", 409);
    }
    // Stripe event.created is second-granularity. Store a cursor one full second
    // before the authority read starts so a cancellation racing the GET always
    // remains eligible to apply instead of being suppressed by local wall time.
    const authoritySnapshotCursor = new Date((Math.floor(Date.now() / 1_000) - 1) * 1_000).toISOString();
    const subscriptionResponse = await fetchWithTimeout(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { headers: { Authorization: `Bearer ${this.config.STRIPE_SECRET_KEY}` } },
    );
    const authoritativeSubscription = await subscriptionResponse.json().catch(() => null) as Record<string, unknown> | null;
    if (
      !subscriptionResponse.ok ||
      !authoritativeSubscription ||
      !isStripeGrantEligibleStatus(authoritativeSubscription.status)
    ) {
      throw new AppError(
        "This checkout no longer has an active or trialing Stripe subscription. Open billing to recover or choose a plan.",
        409,
      );
    }

    const reconciledAt = nowIso();
    const updated = this.repository.updateSubscription({
      userId: account.id,
      subscriptionStatus,
      stripePaidSubscriptionStatus: subscriptionStatus,
      stripeCustomerId: stripeObjectId(authoritativeSubscription.customer) ?? stripeObjectId(payload.customer),
      premiumUntil: stripePeriodEndIso(authoritativeSubscription),
      now: reconciledAt,
      stripeEventCreatedAt: authoritySnapshotCursor,
    });
    if (updated.subscriptionStatus !== subscriptionStatus) {
      throw new AppError("Billing changed while checkout was being confirmed. Refresh Account to see the current Stripe status.", 409);
    }
    await this.trackEvent(updated, {
      anonymousSessionId: null,
      eventType: "subscription_created",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { mode: "stripe", source: "checkout_return", subscriptionStatus },
    });
    await this.auditSecurity({
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
    this.assertCommercialVenueFeatureOpen();
    this.requireVerifiedBarAccount(account);
    const assignment = await this.requireAssignedVenue(account, venueId);
    let profile = this.ensureBarProfile({
      barId: venueId,
      name: assignment?.venueName ?? this.repository.getBarProfile(venueId)?.name ?? venueId,
      suburb: assignment?.suburb ?? this.repository.getBarProfile(venueId)?.suburb ?? null,
    });

    this.assertCommercialEnrollmentOpen();

    const checkoutReadAt = nowIso();
    const billingSubjectVenueId = await this.venueIdentityRepository.getCanonicalVenueId(venueId);
    let venueTrialEverClaimed = await this.billingCheckoutRepository.hasVenueIntroTrialEverClaimed({
      venueId,
      asOf: checkoutReadAt,
    });
    const priorReservation = await this.billingCheckoutRepository.getBillingCheckoutReservation({
      subjectType: "venue",
      subjectId: billingSubjectVenueId,
      asOf: checkoutReadAt,
    });
    if (
      !venueTrialEverClaimed &&
      priorReservation &&
      /^venue:pro:trial:(30|60)$/.test(priorReservation.productKey) &&
      Date.parse(priorReservation.expiresAt) <= Date.now()
    ) {
      if (!priorReservation.stripeCheckoutSessionId) {
        throw new AppError(
          "The previous venue trial checkout could not be reconciled safely. No second trial was created; contact support to resolve the original checkout.",
          409,
          { publicCode: "VENUE_TRIAL_RECONCILIATION_REQUIRED" },
        );
      }
      if (!this.config.STRIPE_SECRET_KEY) {
        throw new AppError("Stripe trial reconciliation is not configured.", 503, {
          publicCode: "VENUE_TRIAL_RECONCILIATION_UNAVAILABLE",
        });
      }

      // Stripe event.created has second-level precision. Anchor the authority
      // read one full second in the past so any cancellation/update racing the
      // GET receives a newer cursor and cannot be overwritten by this snapshot.
      const priorAuthoritySnapshotCursor = new Date(
        (Math.floor(Date.now() / 1_000) - 1) * 1_000,
      ).toISOString();
      const priorResponse = await fetchWithTimeout(
        `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(priorReservation.stripeCheckoutSessionId)}?expand%5B%5D=subscription`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${this.config.STRIPE_SECRET_KEY}` },
        },
      );
      const priorPayload = (await priorResponse.json().catch(() => null)) as StripeCheckoutSession | null;
      if (!priorResponse.ok || !priorPayload) {
        throw new ExternalServiceError(
          "The previous venue trial checkout could not be confirmed with Stripe. No second trial was created.",
          { status: priorResponse.status, message: priorPayload?.error?.message },
        );
      }

      const priorMetadata = priorPayload.metadata ?? {};
      const priorVenueId = priorMetadata.venue_id;
      const priorBillingContext = priorMetadata.billing_context;
      if (
        (priorBillingContext !== "venue" && priorBillingContext !== "bar") ||
        !priorVenueId ||
        await this.venueIdentityRepository.getCanonicalVenueId(priorVenueId) !== billingSubjectVenueId
      ) {
        await this.auditSecurity({
          actor: account,
          action: "stripe_venue_trial_reconciliation_mismatch",
          targetType: "venue",
          targetId: venueId,
          metadata: {
            sessionPrefix: priorReservation.stripeCheckoutSessionId.slice(0, 12),
            billingContext: priorBillingContext ?? null,
            venueIdPresent: Boolean(priorVenueId),
          },
        });
        throw new AppError(
          "The previous venue trial checkout did not match this venue. No second trial was created.",
          409,
          { publicCode: "VENUE_TRIAL_RECONCILIATION_MISMATCH" },
        );
      }

      if (priorPayload.status === "open") {
        const checkoutUrl = priorPayload.url ?? priorReservation.checkoutUrl;
        if (!checkoutUrl) {
          throw new AppError(
            "The previous venue trial checkout is still open but has no safe resume URL. No second trial was created.",
            409,
            { publicCode: "VENUE_TRIAL_RECONCILIATION_REQUIRED" },
          );
        }
        return {
          mode: "stripe",
          checkoutUrl,
          message: "Resume the existing Stripe Checkout session. A second venue trial was not created.",
        };
      }

      if (priorPayload.status === "complete") {
        const reconciledAt = nowIso();
        await this.billingCheckoutRepository.markVenueIntroTrialEverClaimed({
          actorAccountId: account.id,
          venueId: priorVenueId,
          now: reconciledAt,
        });
        venueTrialEverClaimed = true;

        const priorSubscription = objectFromUnknown(priorPayload.subscription);
        const priorSubscriptionId = stripeObjectId(priorPayload.subscription);
        const priorCustomerId =
          stripeObjectId(priorPayload.customer) ?? stripeObjectId(priorSubscription.customer);
        const priorSubscriptionStatus = stringOrNull(priorSubscription.status);
        const rawPriorTier = priorMetadata.venue_membership_tier;
        const priorTier: BarMembershipTier | null =
          rawPriorTier === "pro" || rawPriorTier === "plus" ? "pro" : null;

        if (!priorSubscriptionId || !priorSubscriptionStatus || !priorTier) {
          throw new AppError(
            "The previous venue trial completed but its Stripe subscription is not yet safe to reconcile. No new checkout was created.",
            409,
            { publicCode: "VENUE_TRIAL_RECONCILIATION_REQUIRED" },
          );
        }

        const grantEligible = isStripeGrantEligibleStatus(priorSubscriptionStatus);
        const reconciledTier: BarMembershipTier = grantEligible ? priorTier : "basic";
        profile = this.repository.updateBarSubscription({
          barId: priorVenueId,
          membershipTier: reconciledTier,
          stripePaidMembershipTier: priorTier,
          stripeCustomerId: priorCustomerId,
          stripeSubscriptionId: priorSubscriptionId,
          subscriptionStatus: priorSubscriptionStatus,
          subscriptionCurrentPeriodEnd: stripePeriodEndIso(priorSubscription),
          now: reconciledAt,
          stripeEventCreatedAt: priorAuthoritySnapshotCursor,
          ...tierFlags(reconciledTier),
        });
        if (
          profile.stripeEventCreatedAt !== priorAuthoritySnapshotCursor ||
          profile.stripeSubscriptionId !== priorSubscriptionId ||
          profile.subscriptionStatus !== priorSubscriptionStatus ||
          profile.membershipTier !== reconciledTier
        ) {
          throw new AppError(
            "Venue billing changed while the previous trial was being reconciled. Refresh the venue portal; no new checkout was created.",
            409,
            { publicCode: "VENUE_TRIAL_RECONCILIATION_CHANGED" },
          );
        }
        await this.auditSecurity({
          actor: account,
          action: "stripe_venue_trial_reconciled",
          targetType: "venue",
          targetId: priorVenueId,
          metadata: {
            sessionPrefix: priorReservation.stripeCheckoutSessionId.slice(0, 12),
            subscriptionStatus: priorSubscriptionStatus,
          },
        });

        if (hasManageableStripeSubscription(priorSubscriptionId, priorSubscriptionStatus)) {
          if (!priorCustomerId) {
            throw new AppError(
              "The previous venue trial is active but its Stripe customer is not yet safe to manage. No new checkout was created.",
              409,
              { publicCode: "VENUE_TRIAL_RECONCILIATION_REQUIRED" },
            );
          }
          const portal = await this.createStripeBillingPortalSession(
            priorCustomerId,
            `/venue-portal.html?venueId=${encodeURIComponent(venueId)}&billing=returned`,
          );
          return {
            ...portal,
            mode: "portal",
            checkoutUrl: portal.portalUrl,
            message: "The existing venue trial was recovered from Stripe. Manage it in the billing portal.",
          };
        }
      } else if (priorPayload.status !== "expired") {
        throw new AppError(
          "The previous venue trial has an unknown Stripe state. No second trial was created.",
          409,
          { publicCode: "VENUE_TRIAL_RECONCILIATION_REQUIRED" },
        );
      }
    }

    if (
      profile.stripeCustomerId &&
      hasManageableStripeSubscription(profile.stripeSubscriptionId, profile.subscriptionStatus)
    ) {
      const portal = await this.createStripeBillingPortalSession(
        profile.stripeCustomerId,
        `/venue-portal.html?venueId=${encodeURIComponent(venueId)}&billing=returned`,
      );
      return {
        ...portal,
        mode: "portal",
        checkoutUrl: portal.portalUrl,
        message: "This venue already has a Stripe billing profile. Manage or recover it in the billing portal.",
      };
    }

    const priceId = this.config.STRIPE_PRO_PRICE_ID;
    const flags = tierFlags(input.tier);
    const introductoryTrialDays =
      profile.stripeCustomerId ||
      profile.stripeSubscriptionId ||
      venueTrialEverClaimed
        ? 0
        : this.config.VENUE_PRO_TRIAL_DAYS;

    await this.trackEvent(account, {
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
        subscriptionCurrentPeriodEnd: null,
        now: nowIso(),
        ...flags,
      });
      await this.auditSecurity({
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

    const reservationNow = nowIso();
    const reservation = await this.billingCheckoutRepository.claimBillingCheckoutReservation({
      actorAccountId: account.id,
      subjectType: "venue",
      subjectId: billingSubjectVenueId,
      productKey: introductoryTrialDays === 30
        ? "venue:pro:trial:30"
        : introductoryTrialDays === 60
          ? "venue:pro:trial:60"
          : "venue:pro:paid",
      reservationToken: crypto.randomUUID(),
      expiresAt: new Date(Date.parse(reservationNow) + STRIPE_CHECKOUT_RESERVATION_TTL_MS).toISOString(),
      now: reservationNow,
    });
    if (reservation.checkoutUrl) {
      return {
        mode: "stripe",
        checkoutUrl: reservation.checkoutUrl,
        message: "Resume the existing Stripe Checkout session. A second venue subscription session was not created.",
      };
    }
    const reservedTrialMatch = /^venue:pro:trial:(30|60)$/.exec(reservation.productKey);
    const reservedTrialDays = reservedTrialMatch
      ? Number.parseInt(reservedTrialMatch[1]!, 10)
      : 0;

    const successUrl = new URL(`/venue-portal?checkout=success&venueId=${encodeURIComponent(venueId)}`, this.config.PUBLIC_BASE_URL).toString();
    const cancelUrl = new URL(`/venue-portal?checkout=cancelled&venueId=${encodeURIComponent(venueId)}`, this.config.PUBLIC_BASE_URL).toString();
    const response = await fetchWithTimeout("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": crypto.createHash("sha256")
          .update(`venue-checkout:${reservation.reservationToken}`)
          .digest("hex"),
      },
      body: formEncode({
        mode: "subscription",
        success_url: successUrl,
        cancel_url: cancelUrl,
        "automatic_tax[enabled]": "true",
        expires_at: String(Math.floor(Date.parse(reservation.expiresAt) / 1000)),
        billing_address_collection: "required",
        "tax_id_collection[enabled]": "true",
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",
        "metadata[billing_context]": "venue",
        "metadata[user_id]": account.id,
        "metadata[venue_id]": venueId,
        "metadata[venue_membership_tier]": input.tier,
        "subscription_data[metadata][billing_context]": "venue",
        "subscription_data[metadata][user_id]": account.id,
        "subscription_data[metadata][venue_id]": venueId,
        "subscription_data[metadata][venue_membership_tier]": input.tier,
        ...(reservedTrialDays > 0
          ? {
              "subscription_data[trial_period_days]": String(reservedTrialDays),
              payment_method_collection: this.config.VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD
                ? "always"
                : "if_required",
              ...(!this.config.VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD
                ? {
                    "subscription_data[trial_settings][end_behavior][missing_payment_method]": "cancel",
                  }
                : {}),
            }
          : {}),
        ...(profile.stripeCustomerId
          ? { customer: profile.stripeCustomerId }
          : { customer_email: account.email }),
      }),
    });

    const payload = (await response.json().catch(() => null)) as {
      id?: string;
      url?: string;
      error?: { message?: string };
    } | null;

    if (!response.ok || !payload?.id || !payload.url) {
      throw new ExternalServiceError(describeStripeCheckoutFailure(response.status, payload?.error?.message), {
        status: response.status,
        message: payload?.error?.message,
      });
    }

    const finalizedReservation = await this.billingCheckoutRepository.finalizeBillingCheckoutReservation({
      actorAccountId: account.id,
      subjectType: "venue",
      subjectId: billingSubjectVenueId,
      reservationToken: reservation.reservationToken,
      stripeCheckoutSessionId: payload.id,
      checkoutUrl: payload.url,
      now: nowIso(),
    });
    return {
      mode: "stripe",
      checkoutUrl: finalizedReservation.checkoutUrl!,
      message: reservedTrialDays > 0
        ? `${reservedTrialDays}-day venue Pro trial checkout created.`
        : "Stripe checkout created for this venue tier.",
    };
  }

  async handleDemoSubscription(account: BusinessAccount, plan: "monthly" | "yearly") {
    this.assertCommercialVenueFeatureOpen();
    if (!this.config.DEMO_BILLING_MODE) {
      throw new AppError("Demo billing is not enabled.", 503);
    }
    this.assertConsumerPaidEnrollmentOpen();

    const now = nowIso();
    const status: SubscriptionStatus = plan === "monthly" ? "premium_monthly" : "premium_yearly";
    const updated = this.repository.updateSubscription({
      userId: account.id,
      subscriptionStatus: status,
      stripePaidSubscriptionStatus: status,
      premiumUntil: null,
      now,
    });
    await this.auditSecurity({
      actor: updated,
      action: "demo_subscription_grant",
      targetType: "account",
      targetId: updated.id,
      metadata: { plan, mode: "demo", subscriptionStatus: status },
    });
    await this.trackEvent(updated, {
      anonymousSessionId: null,
      eventType: "subscription_created",
      venueId: null,
      beerId: null,
      suburb: null,
      metadata: { plan, mode: "demo" },
    });
    return { account: sanitizeAccount(updated), access: this.getAccessState(updated, null) };
  }

  async handleStripeWebhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ received: true }> {
    this.assertCommercialVenueFeatureOpen();
    if (!this.config.STRIPE_WEBHOOK_SECRET) {
      throw new AppError("Stripe webhook secret is not configured.", 503);
    }

    // Missing user-controlled inputs only select a fail-closed audit/error
    // path; every accepted event is still verified with the server-held secret.
    // codeql[js/user-controlled-bypass]
    if (!rawBody || !signature) { // lgtm[js/user-controlled-bypass]
      await this.auditSecurity({
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
      await this.auditSecurity({
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
    let eventCreatedAt: string | null = null;
    if (Number.isSafeInteger(event.created)) {
      try {
        eventCreatedAt = new Date(Number(event.created) * 1000).toISOString();
      } catch {
        eventCreatedAt = null;
      }
    }
    let processingClaim;
    try {
      processingClaim = await this.stripeSubscriptionRepository.claimWebhookEvent({
        id: event.id,
        eventType: event.type,
        eventCreatedAt,
        payload: event as unknown as Record<string, unknown>,
        receivedAt,
      });
    } catch (error) {
      this.throwMappedStripeSubscriptionError(error);
    }

    if (processingClaim.state === "applied") {
      await this.systemStateRepository.set("job:stripe_webhook", {
        state: "succeeded",
        completedAt: receivedAt,
        eventType: event.type,
        replay: true,
      }, receivedAt);
      return { received: true };
    }
    if (processingClaim.state === "in_progress") {
      throw new AppError("This Stripe event is already being processed. Retry shortly.", 409);
    }
    const processingToken = processingClaim.processingToken;

    try {
      let authoritative = await this.resolveAuthoritativeStripeEvent(event, eventCreatedAt);
      let effect = await this.buildStripeApplicationEffect(
        authoritative.event,
        authoritative.authorityConfirmed,
      );
      try {
        await this.stripeSubscriptionRepository.applyClaimedEvent({
          id: event.id,
          processingToken,
          appliedAt: nowIso(),
          effect,
        });
      } catch (error) {
        if (
          error instanceof StripeSubscriptionRepositoryError
          && error.code === "authoritative_state_required"
          && !authoritative.authorityConfirmed
        ) {
          authoritative = await this.resolveAuthoritativeStripeEvent(event, eventCreatedAt, true);
          effect = await this.buildStripeApplicationEffect(
            authoritative.event,
            authoritative.authorityConfirmed,
          );
          await this.stripeSubscriptionRepository.applyClaimedEvent({
            id: event.id,
            processingToken,
            appliedAt: nowIso(),
            effect,
          });
        } else {
          throw error;
        }
      }
    } catch (error) {
      const failedAt = nowIso();
      let markedFailed: boolean;
      try {
        markedFailed = await this.stripeSubscriptionRepository.markWebhookEventFailed({
          id: event.id,
          processingToken,
          failedAt,
          error: error instanceof Error ? redactSecrets(error.message) : "Stripe event application failed",
        });
      } catch (markError) {
        this.throwMappedStripeSubscriptionError(markError);
      }
      if (!markedFailed) {
        throw new AppError("Stripe event processing ownership was lost; retrying safely.", 409);
      }
      await this.systemStateRepository.set("job:stripe_webhook", {
        state: "failed",
        completedAt: failedAt,
        eventType: event.type,
        error: error instanceof Error ? redactSecrets(error.message).slice(0, 300) : "Stripe event application failed",
      }, failedAt);
      this.throwMappedStripeSubscriptionError(error);
    }
    const completedAt = nowIso();
    await this.systemStateRepository.set("job:stripe_webhook", {
      state: "succeeded",
      completedAt,
      eventType: event.type,
      replay: false,
    }, completedAt);
    return { received: true };
  }

  private async resolveAuthoritativeStripeEvent(
    event: StripeEvent,
    eventCreatedAt: string | null,
    forceAuthority = false,
  ): Promise<AuthoritativeStripeEvent> {
    const object = event.data?.object;
    if (!object || !eventCreatedAt) return { event, authorityConfirmed: false };
    if (![
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.payment_failed",
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ].includes(event.type)) return { event, authorityConfirmed: false };

    const subscriptionId = event.type.startsWith("customer.subscription.")
      ? stripeObjectId(object.id)
      : stripeObjectId(object.subscription);
    if (!subscriptionId) return { event, authorityConfirmed: false };
    const customer = stripeObjectId(object.customer);
    let target: StripeResolvedBillingTarget | null = null;
    if (event.type.startsWith("checkout.session.")) {
      const metadata = objectFromUnknown(object.metadata);
      const billingContext = stringOrNull(metadata.billing_context);
      const venueId = stringOrNull(metadata.venue_id);
      const accountId = stringOrNull(metadata.user_id);
      if ((billingContext === "venue" || billingContext === "bar") && venueId) {
        target = await this.stripeSubscriptionRepository.resolveVenueBillingTarget(venueId);
      } else if (accountId) {
        target = await this.stripeSubscriptionRepository.resolveAccountBillingTarget(accountId);
      } else if (customer) {
        target = await this.stripeSubscriptionRepository.resolveBillingTarget({
          stripeCustomerId: customer,
          stripeSubscriptionId: subscriptionId,
        });
      }
    } else {
      target = await this.stripeSubscriptionRepository.resolveBillingTarget({
        stripeCustomerId: customer,
        stripeSubscriptionId: subscriptionId,
      });
    }
    const targetEventCreatedAt = target?.account?.stripeEventCreatedAt ?? target?.venue?.stripeEventCreatedAt ?? null;
    if (targetEventCreatedAt && targetEventCreatedAt > eventCreatedAt) {
      return { event, authorityConfirmed: false };
    }
    const isAmbiguousSameSecond =
      targetEventCreatedAt === eventCreatedAt;
    const isCheckoutGrantEvent = event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded";
    if (
      !forceAuthority
      && !isAmbiguousSameSecond
      && event.type !== "invoice.payment_failed"
      && !isCheckoutGrantEvent
    ) return { event, authorityConfirmed: false };
    if (!this.config.STRIPE_SECRET_KEY) {
      if (
        !forceAuthority
        && isCheckoutGrantEvent
        && this.config.NODE_ENV !== "production"
        && !isAmbiguousSameSecond
      ) {
        return { event, authorityConfirmed: false };
      }
      throw new AppError("Stripe subscription authority is unavailable for an ambiguous billing event.", 503);
    }

    const response = await fetchWithTimeout(
      `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { headers: { Authorization: `Bearer ${this.config.STRIPE_SECRET_KEY}` } },
    );
    if (response.status === 404) {
      const missingSubscription = { id: subscriptionId, status: "canceled" };
      return {
        authorityConfirmed: true,
        event: {
          ...event,
          data: {
            object: event.type.startsWith("checkout.session.")
              ? { ...object, subscription: missingSubscription }
              : { ...object, ...missingSubscription },
          },
        },
      };
    }
    const authoritative = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !authoritative) {
      throw new ExternalServiceError("Stripe subscription authority could not be confirmed; the event is queued for retry.", {
        status: response.status,
      });
    }
    const resolvedObject = event.type.startsWith("checkout.session.")
      ? {
          ...object,
          subscription: {
            ...authoritative,
            id: stripeObjectId(authoritative.id) ?? subscriptionId,
          },
          customer: authoritative.customer ?? object.customer,
        }
      : {
          ...object,
          ...authoritative,
          id: stripeObjectId(authoritative.id) ?? subscriptionId,
          customer: authoritative.customer ?? object.customer,
        };
    return {
      authorityConfirmed: true,
      event: {
        ...event,
        data: {
          object: resolvedObject,
        },
      },
    };
  }

  private verifyStripeWebhook(rawBody: Buffer, signature: string): StripeEvent {
    const entries = signature.split(",").map((part) => {
      const separator = part.indexOf("=");
      return separator < 0
        ? { key: part.trim(), value: "" }
        : { key: part.slice(0, separator).trim(), value: part.slice(separator + 1).trim() };
    });
    const timestamp = entries.find((entry) => entry.key === "t")?.value;
    const signatures = entries.filter((entry) => entry.key === "v1").map((entry) => entry.value);

    if (!timestamp || signatures.length === 0) {
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

    const validSignatures = signatures.filter((candidate) => /^[a-f0-9]{64}$/i.test(candidate));
    if (validSignatures.length === 0) {
      throw new AppError("Invalid Stripe webhook signature.", 401);
    }

    const expected = crypto
      .createHmac("sha256", this.config.STRIPE_WEBHOOK_SECRET!)
      .update(`${timestamp}.${rawBody.toString("utf8")}`)
      .digest("hex");

    if (!validSignatures.some((candidate) =>
      expected.length === candidate.length &&
      crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(candidate, "hex")))) {
      throw new AppError("Invalid Stripe webhook signature.", 401);
    }

    try {
      const parsed = JSON.parse(rawBody.toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("invalid_object");
      }
      return parsed as StripeEvent;
    } catch {
      throw new AppError("Invalid Stripe webhook event.", 400);
    }
  }

  private async buildStripeApplicationEffect(
    event: StripeEvent,
    authorityConfirmed: boolean,
  ): Promise<StripeApplicationEffect> {
    const object = event.data?.object;
    if (!object) {
      return { kind: "acknowledge", reason: "unsupported_or_noop" };
    }

    if (event.type === "checkout.session.async_payment_failed") {
      return {
        kind: "acknowledge",
        reason: "checkout_async_payment_failed",
        targetId: stripeObjectId(object.id),
      };
    }

    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      const authoritativeStatus = objectFromUnknown(object.subscription).status;
      if (
        (this.config.STRIPE_SECRET_KEY && !isStripeGrantEligibleStatus(authoritativeStatus)) ||
        (typeof authoritativeStatus === "string" && !isStripeGrantEligibleStatus(authoritativeStatus))
      ) {
        return {
          kind: "acknowledge",
          reason: "checkout_authority_rejected",
          targetId: stripeObjectId(object.id),
          metadata: {
            eventType: event.type,
            subscriptionStatus: typeof authoritativeStatus === "string" ? authoritativeStatus : "missing",
          },
        };
      }
      if (!isStripeCheckoutSettled(object)) {
        return {
          kind: "acknowledge",
          reason: "checkout_unsettled",
          targetId: stripeObjectId(object.id),
          metadata: {
            eventType: event.type,
            paymentStatus: object.payment_status ?? null,
            subscriptionStatus: typeof authoritativeStatus === "string" ? authoritativeStatus : null,
          },
        };
      }
      const metadata = objectFromUnknown(object.metadata);
      const billingContext = stringOrNull(metadata.billing_context);
      const barId = stringOrNull(metadata.venue_id);
      const rawBarMembershipTier = stringOrNull(metadata.venue_membership_tier);
      const barMembershipTier = rawBarMembershipTier === "pro" || rawBarMembershipTier === "plus" ? "pro" : null;
      const subscriptionId = stripeObjectId(object.subscription);
      const userId = stringOrNull(metadata.user_id);
      const rawSubscriptionStatus = stringOrNull(metadata.subscription_status);
      const subscriptionStatus = rawSubscriptionStatus === "premium_monthly" || rawSubscriptionStatus === "premium_yearly"
        ? rawSubscriptionStatus
        : null;
      const customer = stripeObjectId(object.customer);
      const providerStatus = isStripeGrantEligibleStatus(authoritativeStatus) ? authoritativeStatus : "active";
      const subscriptionCurrentPeriodEnd = stripePeriodEndIso(object.subscription);

      if (this.config.STRIPE_SECRET_KEY && !subscriptionId) {
        return {
          kind: "acknowledge",
          reason: "checkout_authority_rejected",
          targetId: stripeObjectId(object.id),
          metadata: { eventType: event.type, reason: "missing_subscription_identity" },
        };
      }

      if (
        (billingContext === "venue" || billingContext === "bar")
        && barId
        && barMembershipTier
        && subscriptionId
      ) {
        const target = await this.stripeSubscriptionRepository.resolveVenueBillingTarget(barId);
        return {
          kind: "checkout_grant",
          expectedTargetKind: "venue",
          expectedAccountId: null,
          expectedCanonicalVenueId: target.expectedCanonicalVenueId,
          billingProfileVenueId: target.billingProfileVenueId,
          authorityConfirmed,
          stripeCustomerId: customer,
          stripeSubscriptionId: subscriptionId,
          providerStatus,
          subscriptionCurrentPeriodEnd,
          target: { kind: "venue", venueId: target.billingProfileVenueId, paidTier: "pro" },
        };
      }

      if (userId && subscriptionStatus && customer) {
        const target = await this.stripeSubscriptionRepository.resolveAccountBillingTarget(userId);
        return {
          kind: "checkout_grant",
          expectedTargetKind: "account",
          expectedAccountId: target.expectedAccountId,
          expectedCanonicalVenueId: null,
          billingProfileVenueId: null,
          authorityConfirmed,
          stripeCustomerId: customer,
          stripeSubscriptionId: subscriptionId,
          providerStatus,
          subscriptionCurrentPeriodEnd,
          target: { kind: "account", userId: target.expectedAccountId, paidStatus: subscriptionStatus },
        };
      }

      return {
        kind: "acknowledge",
        reason: "checkout_authority_rejected",
        targetId: stripeObjectId(object.id),
        metadata: {
          eventType: event.type,
          reason: "invalid_or_untrusted_billing_target",
          billingContext,
        },
      };
    }

    if (
      event.type === "customer.subscription.deleted" ||
      event.type === "customer.subscription.updated" ||
      event.type === "invoice.payment_failed"
    ) {
      const customer = stripeObjectId(object.customer);
      const subscriptionId = event.type.startsWith("customer.subscription.")
        ? stripeObjectId(object.id)
        : stripeObjectId(object.subscription);
      if (!customer && !subscriptionId) {
        return { kind: "acknowledge", reason: "unsupported_or_noop" };
      }
      const target = await this.stripeSubscriptionRepository.resolveBillingTarget({
        stripeCustomerId: customer,
        stripeSubscriptionId: subscriptionId,
      });
      const stripeStatus = stringOrNull(object.status);
      const grantEligible = event.type === "customer.subscription.updated" && isStripeGrantEligibleStatus(stripeStatus);
      const subscriptionMetadata = objectFromUnknown(object.metadata);
      const subscriptionPriceIds = stripePriceIds(object);
      let intendedAccountPaidStatus: "premium_monthly" | "premium_yearly" | null = null;
      let intendedVenuePaidTier: "pro" | null = null;

      if (target.kind === "account") {
        const metadataStatus = stringOrNull(subscriptionMetadata.subscription_status);
        intendedAccountPaidStatus = metadataStatus === "premium_monthly" || metadataStatus === "premium_yearly"
          ? metadataStatus
          : this.config.STRIPE_PRICE_MONTHLY && subscriptionPriceIds.has(this.config.STRIPE_PRICE_MONTHLY)
            ? "premium_monthly"
            : this.config.STRIPE_PRICE_YEARLY && subscriptionPriceIds.has(this.config.STRIPE_PRICE_YEARLY)
              ? "premium_yearly"
              : target.account.stripePaidSubscriptionStatus
                ?? (target.account.subscriptionStatus === "premium_monthly" || target.account.subscriptionStatus === "premium_yearly"
                  ? target.account.subscriptionStatus
                  : null);
      } else if (target.kind === "venue") {
        const metadataTier = stringOrNull(subscriptionMetadata.venue_membership_tier);
        intendedVenuePaidTier = metadataTier === "pro" || metadataTier === "plus"
          ? "pro"
          : this.config.STRIPE_PRO_PRICE_ID && subscriptionPriceIds.has(this.config.STRIPE_PRO_PRICE_ID)
            ? "pro"
            : target.venue.stripePaidMembershipTier ?? (target.venue.membershipTier === "pro" ? "pro" : null);
      }

      return {
        kind: "subscription_state",
        expectedTargetKind: target.expectedTargetKind,
        expectedAccountId: target.expectedAccountId,
        expectedCanonicalVenueId: target.expectedCanonicalVenueId,
        billingProfileVenueId: target.billingProfileVenueId,
        authorityConfirmed,
        stripeCustomerId: customer,
        stripeSubscriptionId: subscriptionId,
        providerStatus: stripeStatus,
        grantEligible,
        intendedAccountPaidStatus,
        intendedVenuePaidTier,
        subscriptionCurrentPeriodEnd: stripePeriodEndIso(object),
      };
    }

    return { kind: "acknowledge", reason: "unsupported_or_noop" };
  }

  async adminOverrideUser(admin: BusinessAccount, userId: string, input: { status: "active" | "warned" | "suspended"; trustScore?: number | undefined; fraudStrikeCount?: number | undefined; reason: string }) {
    if (!this.isAdmin(admin)) {
      throw new AppError("Admin access required.", 403);
    }

    const target = await this.accountSessionRepository.getAccountById(userId);
    if (!target) throw new AppError("Account not found.", 404);
    if (target.role === "admin" || target.subscriptionStatus === "admin") {
      await this.assertAdminControlPreserved(admin, target);
    }
    const requestedAt = nowIso();
    const overrideNow = Date.parse(requestedAt) > Date.parse(target.updatedAt)
      ? requestedAt
      : new Date(Date.parse(target.updatedAt) + 1).toISOString();
    const override = await this.adminAccountRepository.overrideUserStatus({
      actorAccountId: admin.id,
      userId,
      status: input.status,
      trustScore: input.trustScore,
      fraudStrikeCount: input.fraudStrikeCount,
      expectedUpdatedAt: target.updatedAt,
      now: overrideNow,
    });
    const { account, revokedSessions, revokedDiscountPasses } = override;
    await this.auditSecurity({
      actor: admin,
      action: "admin_user_status_override",
      targetType: "account",
      targetId: userId,
      metadata: {
        status: input.status,
        ...(input.fraudStrikeCount === undefined ? {} : { fraudStrikeCount: input.fraudStrikeCount }),
        reason: input.reason,
        revokedSessions,
        revokedDiscountPasses,
      },
    });
    return {
      account: sanitizeAccount(account),
    };
  }

  private async getSupabaseOperationalReadiness(): Promise<SupabaseReadinessDependencies> {
    const postgresRecoveryRehearsal = Boolean(
      this.config.POSTGRES_RECOVERY_REHEARSAL_MODE,
    );
    const required = this.config.NODE_ENV === "production" && (
      !this.config.FIELD_TEST_MODE || Boolean(this.config.RESTORE_REHEARSAL_MODE)
    );
    const configured = !this.config.RESTORE_REHEARSAL_MODE && Boolean(
      this.config.SUPABASE_URL &&
      this.config.SUPABASE_ANON_KEY &&
      (postgresRecoveryRehearsal || this.config.SUPABASE_SERVICE_ROLE_KEY),
    );
    const commonStatus = (): RemoteReadinessDependency => ({
      status: configured
        ? "configured"
        : required
          ? "required_unconfigured"
          : this.config.FIELD_TEST_MODE
            ? "field_test_unconfigured"
            : "optional_unconfigured",
      required,
      liveProbe: false,
    });

    if (!configured) {
      return {
        ready: !required,
        supabaseAuth: commonStatus(),
        supabaseDatabase: commonStatus(),
        supabaseEvidenceStorage: commonStatus(),
      };
    }

    const now = Date.now();
    if (this.supabaseReadinessCache && this.supabaseReadinessCache.expiresAt > now) {
      return this.supabaseReadinessCache.value;
    }
    if (this.supabaseReadinessInFlight) {
      return this.supabaseReadinessInFlight;
    }

    const url = this.config.SUPABASE_URL!;
    const anonKey = this.config.SUPABASE_ANON_KEY!;
    const serviceRoleKey = this.config.SUPABASE_SERVICE_ROLE_KEY;
    const probe = async (
      endpoint: string,
      key: string,
      validate?: (response: Response) => Promise<string | null>,
    ): Promise<RemoteReadinessDependency> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_500);
      try {
        const response = await fetch(new URL(endpoint, `${url.replace(/\/$/, "")}/`), {
          headers: getSupabaseReadinessHeaders(key),
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) {
          return { status: "failed", required, liveProbe: true, error: `http_${response.status}` };
        }
        const validationError = validate ? await validate(response) : null;
        return validationError
          ? { status: "failed", required, liveProbe: true, error: validationError }
          : { status: "ok", required, liveProbe: true };
      } catch (error) {
        return {
          status: "failed",
          required,
          liveProbe: true,
          error: error instanceof Error && error.name === "AbortError" ? "timeout" : "request_failed",
        };
      } finally {
        clearTimeout(timeout);
      }
    };

    this.supabaseReadinessInFlight = (async () => {
      const productionProviderDataRequired = isCanonicalProductionRuntime({
        nodeEnv: this.config.NODE_ENV,
        railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
      });
      const databaseProbeEndpoint = this.config.RESTORE_REHEARSAL_MODE
        || !productionProviderDataRequired
        ? "rest/v1/profiles?select=id&limit=1"
        : "rest/v1/venues?select=id&limit=1";
      if (postgresRecoveryRehearsal) {
        const supabaseAuth = await probe("auth/v1/health", anonKey);
        const disabled = {
          status: "disabled_for_postgres_recovery_rehearsal",
          required: false,
          liveProbe: false,
        } satisfies RemoteReadinessDependency;
        return {
          ready: supabaseAuth.status === "ok",
          supabaseAuth,
          supabaseDatabase: disabled,
          supabaseEvidenceStorage: disabled,
        };
      }
      const [
        supabaseAuth,
        supabaseDatabase,
        supabaseEvidenceBucket,
        supabaseStoragePolicyPosture,
      ] = await Promise.all([
        probe("auth/v1/health", anonKey),
        // `profiles` is created by the repository-owned migration chain. The
        // production `venues` table is managed by a separate data pipeline and
        // is required only in the canonical production runtime. Staging and
        // isolated restore projects prove their repository-owned schema via
        // `profiles` without inventing an externally managed venue relation.
        probe(databaseProbeEndpoint, serviceRoleKey!),
        probe(`storage/v1/bucket/${encodeURIComponent(SUPABASE_EVIDENCE_BUCKET)}`, serviceRoleKey!, async (response) => {
          try {
            const bucket = await response.json() as {
              public?: unknown;
              file_size_limit?: unknown;
              allowed_mime_types?: unknown;
            };
            if (bucket.public !== false) return "bucket_not_private";
            const sizeLimit = Number(bucket.file_size_limit);
            if (!Number.isFinite(sizeLimit) || sizeLimit < SUPABASE_EVIDENCE_BUCKET_MIN_BYTES) {
              return "bucket_size_limit_too_small";
            }
            const mimeTypes = Array.isArray(bucket.allowed_mime_types)
              ? new Set(bucket.allowed_mime_types.filter((value): value is string => typeof value === "string"))
              : new Set<string>();
            return SUPABASE_EVIDENCE_MIME_TYPES.every((mimeType) => mimeTypes.has(mimeType))
              ? null
              : "bucket_mime_types_incomplete";
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            return "invalid_bucket_response";
          }
        }),
        probe(SUPABASE_STORAGE_POLICY_POSTURE_ENDPOINT, serviceRoleKey!, async (response) => {
          try {
            const rows = await response.json() as unknown;
            if (!Array.isArray(rows) || rows.length !== 1) {
              return "invalid_storage_policy_posture";
            }
            const row = rows[0];
            if (!row || typeof row !== "object" || Array.isArray(row)) {
              return "invalid_storage_policy_posture";
            }
            const keys = Object.keys(row).sort();
            if (keys.length !== 5
              || keys[0] !== "bucket_policy_count"
              || keys[1] !== "bucket_rls_enabled"
              || keys[2] !== "object_policy_count"
              || keys[3] !== "object_rls_enabled"
              || keys[4] !== "public_bucket_count") {
              return "invalid_storage_policy_posture";
            }
            const posture = row as {
              object_policy_count?: unknown;
              object_rls_enabled?: unknown;
              bucket_policy_count?: unknown;
              bucket_rls_enabled?: unknown;
              public_bucket_count?: unknown;
            };
            const counts = [
              posture.object_policy_count,
              posture.bucket_policy_count,
              posture.public_bucket_count,
            ];
            const rlsFlags = [posture.object_rls_enabled, posture.bucket_rls_enabled];
            if (counts.some((count) => typeof count !== "number"
              || !Number.isSafeInteger(count)
              || count < 0)
              || rlsFlags.some((enabled) => typeof enabled !== "boolean")) {
              return "invalid_storage_policy_posture";
            }
            if (rlsFlags.some((enabled) => !enabled)) return "storage_rls_disabled";
            if (posture.public_bucket_count !== 0) return "storage_public_bucket_present";
            return posture.object_policy_count === 0 && posture.bucket_policy_count === 0
              ? null
              : "storage_browser_policy_present";
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            return "invalid_storage_policy_posture";
          }
        }),
      ]);
      const supabaseEvidenceStorage = supabaseEvidenceBucket.status === "ok"
        ? supabaseStoragePolicyPosture
        : supabaseEvidenceBucket;
      return {
        ready: [supabaseAuth, supabaseDatabase, supabaseEvidenceStorage]
          .every((dependency) => dependency.status === "ok"),
        supabaseAuth,
        supabaseDatabase,
        supabaseEvidenceStorage,
      };
    })();

    try {
      const value = await this.supabaseReadinessInFlight;
      this.supabaseReadinessCache = { value, expiresAt: Date.now() + 15_000 };
      return value;
    } finally {
      this.supabaseReadinessInFlight = null;
    }
  }

  async getOperationalReadiness() {
    let database: {
      status: "ok" | "failed";
      foreignKeyViolations: number;
      poolMetrics?: readonly SafePostgresApplicationPoolMetrics[];
      error?: string;
    };
    try {
      const health = await this.databaseHealthProbe();
      database = {
        status: health.ok ? "ok" : "failed",
        foreignKeyViolations: health.foreignKeyViolations,
        ...(health.poolMetrics ? { poolMetrics: health.poolMetrics } : {}),
      };
    } catch (error) {
      database = {
        status: "failed",
        foreignKeyViolations: 0,
        error: error instanceof Error ? String(redactSecrets(error.message)).slice(0, 200) : "Database probe failed",
      };
    }

    let evidenceStorage: { status: "ok" | "failed"; error?: string };
    try {
      if (this.config.POSTGRES_RECOVERY_REHEARSAL_MODE) {
        // The protected PostgreSQL ceremony proves the restored application
        // database and disposable Auth boundary only.  It must not create or
        // probe a writable local evidence directory, and it is deliberately
        // denied a Supabase service credential for remote object access.
      } else if (!this.useSupabaseEvidenceStorage || this.config.RESTORE_REHEARSAL_MODE) {
        if (!this.config.RESTORE_REHEARSAL_MODE) {
          fs.mkdirSync(this.config.SOURCE_EVIDENCE_STORAGE_DIR, { recursive: true, mode: 0o700 });
        }
        fs.accessSync(
          this.config.SOURCE_EVIDENCE_STORAGE_DIR,
          this.config.RESTORE_REHEARSAL_MODE
            ? fs.constants.R_OK
            : fs.constants.R_OK | fs.constants.W_OK,
        );
      }
      evidenceStorage = { status: "ok" };
    } catch (error) {
      evidenceStorage = {
        status: "failed",
        error: error instanceof Error ? String(redactSecrets(error.message)).slice(0, 200) : "Evidence storage probe failed",
      };
    }

    const supabase = await this.getSupabaseOperationalReadiness();
    const paidEnrollmentRequired = Boolean(
      this.config.COMMERCIAL_LAUNCH_ENABLED ||
      this.config.CONSUMER_PAID_ENROLLMENT_ENABLED
    );
    const billingConfigured = Boolean(
      this.config.STRIPE_SECRET_KEY &&
      this.config.STRIPE_WEBHOOK_SECRET &&
      this.config.STRIPE_PRICE_MONTHLY &&
      this.config.STRIPE_PRICE_YEARLY &&
      this.config.STRIPE_PRO_PRICE_ID,
    );
    const postgresRecoveryRehearsal = Boolean(
      this.config.POSTGRES_RECOVERY_REHEARSAL_MODE,
    );
    const billingRequired = !this.config.RESTORE_REHEARSAL_MODE
      && !postgresRecoveryRehearsal
      && this.config.NODE_ENV === "production"
      && paidEnrollmentRequired;
    const venueLookupConfigured = Boolean(this.config.GOOGLE_PLACES_API_KEY);
    const menuExtractionConfigured = Boolean(this.config.OPENAI_API_KEY);
    const reportDeliveryConfigured = this.config.REPORT_EMAIL_MODE === "mock" || Boolean(
      this.config.REPORT_EMAIL_MODE === "resend" && this.config.RESEND_API_KEY && this.config.REPORT_EMAIL_FROM,
    );
    const deletionNotificationConfigured = Boolean(
      this.accountDeletionNotificationCoordinator &&
      this.config.ACCOUNT_DELETION_NOTICE_MODE !== "disabled" &&
      (this.config.ACCOUNT_DELETION_NOTICE_MODE !== "resend" || this.config.RESEND_WEBHOOK_SIGNING_SECRET),
    );
    const readinessCheckedAt = nowIso();
    const deletionNotificationQueue = await this.accountDeletionQueueRepository
      .getAccountDeletionNotificationQueueSummary(readinessCheckedAt);
    const deletionNotificationJob = await this.systemStateRepository
      .get<Record<string, unknown>>("job:account_deletion_notifications");
    const deletionNotificationJobState = typeof deletionNotificationJob?.value?.state === "string"
      ? deletionNotificationJob.value.state
      : "not_run";
    const deletionNotificationJobUpdatedAtMs = deletionNotificationJob?.updatedAt
      ? Date.parse(deletionNotificationJob.updatedAt)
      : Number.NaN;
    const deletionNotificationJobMaxAgeMinutes = Math.max(
      15,
      (this.config.ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES ?? 5) * 3,
    );
    const deletionNotificationJobAgeMinutes = Number.isFinite(deletionNotificationJobUpdatedAtMs)
      ? Math.max(0, (Date.parse(readinessCheckedAt) - deletionNotificationJobUpdatedAtMs) / 60_000)
      : null;
    const deletionNotificationSchedulerStatus = this.config.RESTORE_REHEARSAL_MODE
      ? "disabled_for_restore_rehearsal"
      : !deletionNotificationConfigured
        ? "not_configured"
        : deletionNotificationJobState === "failed"
          ? "failed"
          : deletionNotificationJobAgeMinutes !== null
              && deletionNotificationJobAgeMinutes > deletionNotificationJobMaxAgeMinutes
            ? "stale"
            : deletionNotificationJobState;
    const fullProviderReadinessRequired = !this.config.RESTORE_REHEARSAL_MODE
      && !postgresRecoveryRehearsal
      && isCanonicalProductionRuntime({
        nodeEnv: this.config.NODE_ENV,
        railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
      });
    const deletionNotificationsRequired = fullProviderReadinessRequired
      || Boolean(this.config.ACCOUNT_DELETION_REHEARSAL_ENABLED);
    const oldestSecurePurgeCheckpointAtMs = deletionNotificationQueue.oldestSecurePurgeCheckpointAt
      ? Date.parse(deletionNotificationQueue.oldestSecurePurgeCheckpointAt)
      : null;
    const securePurgeCheckpointPersistent = deletionNotificationQueue.securePurgeCheckpointPendingCount > 0
      && (
        oldestSecurePurgeCheckpointAtMs === null
        || !Number.isFinite(oldestSecurePurgeCheckpointAtMs)
        || (Date.parse(readinessCheckedAt) - oldestSecurePurgeCheckpointAtMs) / 60_000
          > deletionNotificationJobMaxAgeMinutes
      );
    const deletionNotificationOperationalBlockingReasons: string[] = [];
    if (deletionNotificationsRequired) {
      if (!deletionNotificationConfigured) {
        deletionNotificationOperationalBlockingReasons.push("notification_path_unconfigured");
      }
      if (deletionNotificationSchedulerStatus === "failed") {
        deletionNotificationOperationalBlockingReasons.push("scheduler_failed");
      } else if (deletionNotificationSchedulerStatus === "stale") {
        deletionNotificationOperationalBlockingReasons.push("scheduler_stale");
      }
      if (deletionNotificationQueue.overdueRetentionCount > 0) {
        deletionNotificationOperationalBlockingReasons.push("recipient_retention_overdue");
      }
      if (securePurgeCheckpointPersistent) {
        deletionNotificationOperationalBlockingReasons.push("secure_purge_checkpoint_persistent");
      }
    }
    const deletionNotificationOperationalGateReady =
      deletionNotificationOperationalBlockingReasons.length === 0;
    const providerReady = (!billingRequired || billingConfigured) && (
      !fullProviderReadinessRequired || (
        venueLookupConfigured &&
        menuExtractionConfigured &&
        (!(this.config.REPORT_DELIVERY_SCHEDULE_ENABLED ?? false) || reportDeliveryConfigured)
      )
    ) && deletionNotificationOperationalGateReady;

    return {
      ready: database.status === "ok" && evidenceStorage.status === "ok" && supabase.ready && providerReady,
      dependencies: {
        database,
        evidenceStorage,
        supabaseAuth: supabase.supabaseAuth,
        supabaseDatabase: supabase.supabaseDatabase,
        supabaseEvidenceStorage: supabase.supabaseEvidenceStorage,
        billingProvider: {
          status: this.config.RESTORE_REHEARSAL_MODE || postgresRecoveryRehearsal
            ? "disabled_for_restore_rehearsal"
            : !paidEnrollmentRequired
              ? "deferred"
              : billingConfigured
                ? "configured"
                : "missing",
          required: billingRequired,
        },
        venueLookupProvider: {
          status: this.config.RESTORE_REHEARSAL_MODE || postgresRecoveryRehearsal
            ? "disabled_for_restore_rehearsal"
            : venueLookupConfigured
              ? "configured"
              : "missing",
          required: fullProviderReadinessRequired,
        },
        menuExtractionProvider: {
          status: this.config.RESTORE_REHEARSAL_MODE || postgresRecoveryRehearsal
            ? "disabled_for_restore_rehearsal"
            : menuExtractionConfigured
              ? "configured"
              : "missing",
          required: fullProviderReadinessRequired,
        },
        reportDelivery: {
          status: this.config.REPORT_EMAIL_MODE === "disabled"
            ? "disabled"
            : reportDeliveryConfigured
              ? "configured"
              : "missing",
          scheduled: this.config.REPORT_DELIVERY_SCHEDULE_ENABLED ?? false,
          required: fullProviderReadinessRequired && (this.config.REPORT_DELIVERY_SCHEDULE_ENABLED ?? false),
        },
        accountDeletionNotifications: {
          status: this.config.RESTORE_REHEARSAL_MODE || postgresRecoveryRehearsal
            ? "disabled_for_restore_rehearsal"
            : deletionNotificationConfigured
              ? deletionNotificationQueue.manualReviewCount > 0
                  || deletionNotificationQueue.securePurgeCheckpointPendingCount > 0
                  || (["failed", "stale", "not_run"].includes(deletionNotificationSchedulerStatus)
                    && deletionNotificationsRequired)
                ? "operator_attention_required"
                : "configured"
              : "missing",
          required: deletionNotificationsRequired,
          operationalGateReady: deletionNotificationOperationalGateReady,
          operationalBlockingReasons: deletionNotificationOperationalBlockingReasons,
          securePurgeCheckpointPersistent,
          securePurgeCheckpointMaxAgeMinutes: deletionNotificationJobMaxAgeMinutes,
          scheduler: {
            status: deletionNotificationSchedulerStatus,
            updatedAt: deletionNotificationJob?.updatedAt ?? null,
            maxAgeMinutes: deletionNotificationJobMaxAgeMinutes,
          },
          ...deletionNotificationQueue,
        },
        restoreRehearsal: {
          enabled: Boolean(this.config.RESTORE_REHEARSAL_MODE),
          externalWritesAllowed: !this.config.RESTORE_REHEARSAL_MODE,
          httpMutationRoutesAllowed: !this.config.RESTORE_REHEARSAL_MODE,
          runtimeDatabase: this.config.RESTORE_REHEARSAL_MODE
            ? "read_only_attested_restored_copy"
            : "primary_runtime_database",
          remoteVenueDirectoryEnabled: !this.config.RESTORE_REHEARSAL_MODE,
        },
        postgresRecoveryRehearsal: {
          enabled: postgresRecoveryRehearsal,
          externalWritesAllowed: false,
          automaticMaintenanceEnabled: false,
          providerSchedulersEnabled: false,
          runtimeDatabase: postgresRecoveryRehearsal
            ? "disposable_postgres_recovery_target"
            : "not_applicable",
        },
      },
    };
  }

  async getLocalStartupReadiness() {
    let database: {
      status: "ok" | "failed";
      foreignKeyViolations: number;
      poolMetrics?: readonly SafePostgresApplicationPoolMetrics[];
      error?: string;
    };
    try {
      const health = await this.databaseHealthProbe();
      database = {
        status: health.ok ? "ok" : "failed",
        foreignKeyViolations: health.foreignKeyViolations,
        ...(health.poolMetrics ? { poolMetrics: health.poolMetrics } : {}),
      };
    } catch (error) {
      database = {
        status: "failed",
        foreignKeyViolations: 0,
        error: error instanceof Error
          ? String(redactSecrets(error.message)).slice(0, 200)
          : "Database probe failed",
      };
    }

    let evidenceStorage: { status: "ok" | "failed"; error?: string };
    try {
      if (this.config.POSTGRES_RECOVERY_REHEARSAL_MODE) {
        // See getOperationalReadiness: recovery startup is intentionally
        // incapable of touching either local or remote evidence storage.
      } else if (!this.useSupabaseEvidenceStorage || this.config.RESTORE_REHEARSAL_MODE) {
        if (!this.config.RESTORE_REHEARSAL_MODE) {
          fs.mkdirSync(this.config.SOURCE_EVIDENCE_STORAGE_DIR, { recursive: true, mode: 0o700 });
        }
        fs.accessSync(
          this.config.SOURCE_EVIDENCE_STORAGE_DIR,
          this.config.RESTORE_REHEARSAL_MODE
            ? fs.constants.R_OK
            : fs.constants.R_OK | fs.constants.W_OK,
        );
      }
      evidenceStorage = { status: "ok" };
    } catch (error) {
      evidenceStorage = {
        status: "failed",
        error: error instanceof Error
          ? String(redactSecrets(error.message)).slice(0, 200)
          : "Evidence storage probe failed",
      };
    }

    const deletionNotificationsRequired = !this.config.RESTORE_REHEARSAL_MODE
      && !this.config.POSTGRES_RECOVERY_REHEARSAL_MODE
      && (
        isCanonicalProductionRuntime({
          nodeEnv: this.config.NODE_ENV,
          railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
        })
        || Boolean(this.config.ACCOUNT_DELETION_REHEARSAL_ENABLED)
      );
    const deletionNotificationsConfigured = Boolean(
      this.accountDeletionNotificationCoordinator
      && this.config.ACCOUNT_DELETION_NOTICE_MODE === "resend"
      && this.config.RESEND_WEBHOOK_SIGNING_SECRET,
    );
    const deletionJob = await this.systemStateRepository
      .get<Record<string, unknown>>("job:account_deletion_notifications");
    const deletionSchedulerState = typeof deletionJob?.value?.state === "string"
      ? deletionJob.value.state
      : "not_run";
    // Startup runs before the scheduler's first tick and must remain restart-safe.
    // Scheduler freshness and queue retention belong to operational readiness.
    const deletionStartupReady = !deletionNotificationsRequired || deletionNotificationsConfigured;

    return {
      ready: database.status === "ok"
        && evidenceStorage.status === "ok"
        && deletionStartupReady,
      dependencies: {
        database,
        evidenceStorage,
        accountDeletionNotifications: {
          required: deletionNotificationsRequired,
          configured: deletionNotificationsConfigured,
          schedulerState: deletionSchedulerState,
        },
      },
    };
  }

  logStartupSummary() {
    logger.info("Business demo service ready", {
      priceAccessModel: "fixed_preview",
      contributorUnlockPoints: this.config.CONTRIBUTOR_UNLOCK_POINTS,
      demoBillingMode: this.config.DEMO_BILLING_MODE,
      fieldTestMode: this.config.FIELD_TEST_MODE,
    });
  }
}
