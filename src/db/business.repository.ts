import crypto from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import { VIEWER_TRACKED_BEERS, findTrackedBeerByName } from "../constants/beers.js";
import { CURRENT_LEGAL_POLICY_VERSION } from "../config/legal.js";
import { redactSecrets } from "../lib/redact.js";
import { DEFAULT_REPORT_TIMEZONE, getZonedMonthRangeIso } from "../lib/time.js";

export type AccountRole = "user" | "admin" | "venue_manager";
export type AccountStatus = "active" | "warned" | "suspended";
export type SubscriptionStatus =
  | "free"
  | "premium_monthly"
  | "premium_yearly"
  | "contributor_unlocked"
  | "admin";
export type PaidSubscriptionStatus = Extract<SubscriptionStatus, "premium_monthly" | "premium_yearly">;

export const ACCOUNT_DATA_RETENTION_POLICY = {
  version: "2026-07-14",
  authSessions: { action: "delete", daysAfterExpiryOrRevocation: 30 },
  revokedProviderSessions: {
    action: "retain_device_denylist_until_account_deletion",
    globallyRevokedRowsDaysAfterRevocation: 90,
  },
  stripeWebhookPayloads: { action: "redact_payload", daysAfterReceipt: 30 },
  stripeWebhookEventEnvelope: { action: "delete", daysAfterReceipt: 400 },
  securityRequestFingerprints: { action: "redact", daysAfterCreation: 30 },
  securityAuditEnvelope: { action: "retain", daysAfterCreation: 400 },
  reviewedSubmissionExactLocation: { action: "purge", daysAfterReview: 30 },
  pendingEvidenceHardCap: { action: "purge_even_if_review_open", daysAfterCreation: 180 },
  pendingIngestionImages: {
    action: "redact_bytes_preserve_review_metadata",
    retentionDaysAfterCreation: 90,
    hardCapDaysAfterCreation: 180,
  },
  migrationQuarantinePayload: { action: "redact", daysAfterQuarantine: 30 },
  migrationBackups: { action: "delete", daysAfterCreation: 30 },
  accountDeletion: {
    delete: [
      "auth_sessions", "revoked_provider_sessions", "account_discount_passes", "account_preferences",
      "account_privacy_settings", "saved_items", "recent_searches", "user_activity_events", "events",
      "age_verifications", "verifications", "mission_progress", "venue_manager_assignments",
      "discount_redemptions", "pint_point_drink_records", "pint_point_ledger", "free_pint_reward_codes",
      "free_pint_reward_redemptions", "account_reward_vouchers", "leaderboard_prize_awards",
    ],
    redact: [
      "accounts", "profiles", "submissions", "source_evidence_objects", "feedback", "wrong_price_reports",
      "venue_requests", "venue_interest_requests", "venue_claim_requests", "venue_pending_changes",
      "venue_partner_outreach", "system_state venue-report-delivery settings", "security_audit_log",
      "stripe_webhook_events", "migration_quarantined_records", "account_deletion_requests",
    ],
    pseudonymise: ["contribution_ledger"],
  },
} as const;
export type SubmissionStatus =
  | "pending"
  | "needs_more_evidence"
  | "approved"
  | "rejected"
  | "disputed"
  | "fraud_flagged";
export type SubmissionType = "single_beer_price" | "full_venue_update" | "happy_hour_update" | "photo_upload";
export type SubmissionOcrStatus = "not_requested" | "processed" | "manual_review_required" | "failed";
export type SubmissionItemCaptureSource = "manual" | "photo_ocr";
export type ServingSize = "pint" | "pot" | "schooner" | "jug" | "bottle" | "can" | "other";
export type TapStatus = "yes" | "no" | "unknown";
export type SavedItemType = "venue" | "beer" | "suburb" | "night_plan";
export type FeedbackType =
  | "bug"
  | "wrong_data"
  | "feature_idea"
  | "venue_suggestion"
  | "venue_partner_interest"
  | "general_feedback"
  | "privacy_request"
  | "data_export_request"
  | "account_deletion_request"
  | "moderation_appeal"
  | "security_report"
  | "abuse_report"
  | "billing_support";
export type FeedbackPriority = "low" | "normal" | "medium" | "high";
export type TrustWorkflowStatus = "open" | "in_progress" | "resolved" | "rejected";
export type MissionProgressStatus = "accepted" | "submitted" | "completed" | "needs_revision" | "cancelled";
export type RequestType = "missing_venue" | "missing_beer" | "verify_venue" | "verify_beer_at_venue";
export type BarMembershipTier = "basic" | "pro";
type StoredBarMembershipTier = BarMembershipTier | "free" | "plus" | "super_premium";
export type AgeVerificationStatus = "not_started" | "pending" | "verified" | "rejected" | "expired";
export type ConfidenceLabel =
  | "admin_verified"
  | "venue_confirmed"
  | "photo_verified"
  | "community_confirmed"
  | "user_reported_pending"
  | "stale"
  | "disputed";

export interface BusinessAccount {
  id: string;
  publicAccountId: string;
  email: string;
  passwordHash: string;
  displayName: string | null;
  displayNameKey: string | null;
  avatarUrl: string | null;
  authProvider: string;
  supabaseUserId: string | null;
  emailVerifiedAt: string | null;
  mfaLevel: string;
  mfaVerifiedAt: string | null;
  providerTokensValidAfter: string | null;
  stripePaidSubscriptionStatus: PaidSubscriptionStatus | null;
  stripeEventCreatedAt: string | null;
  role: AccountRole;
  ageConfirmedAt: string | null;
  termsAcceptedAt: string | null;
  privacyAcceptedAt: string | null;
  termsVersion: string | null;
  privacyVersion: string | null;
  ageVerificationStatus: AgeVerificationStatus;
  isOver18Verified: boolean;
  subscriptionStatus: SubscriptionStatus;
  stripeCustomerId: string | null;
  premiumUntil: string | null;
  trustScore: number;
  contributionPointsCurrentMonth: number;
  approvedSubmissionCount: number;
  rejectedSubmissionCount: number;
  fraudStrikeCount: number;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AdminAccountSearchResult {
  id: string;
  publicAccountId: string;
  email: string;
  displayName: string | null;
  role: AccountRole;
  status: AccountStatus;
  emailVerifiedAt: string | null;
  ageConfirmedAt: string | null;
  createdAt: string;
}

export interface PublicProfile {
  id: string;
  publicAccountId: string | null;
  email: string | null;
  displayName: string | null;
  displayNameKey: string | null;
  username: string | null;
  avatarUrl: string | null;
  role: AccountRole;
  accountStatus: AccountStatus;
  ageVerificationStatus: AgeVerificationStatus;
  isOver18Verified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SourceEvidenceObject {
  id: string;
  ownerUserId: string | null;
  storageProvider: string;
  objectPath: string;
  mimeType: string | null;
  byteSize: number | null;
  dataBase64: string | null;
  externalUrl: string | null;
  retentionExpiresAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface VenueDuplicateCandidate {
  venueId: string;
  venueName: string;
  suburb: string | null;
  source: string;
}

export interface BusinessSubmission {
  id: string;
  clientSubmissionId: string | null;
  missionId: string | null;
  userId: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  status: SubmissionStatus;
  submissionType: SubmissionType;
  observedAt: string;
  sourcePhotoUrl: string | null;
  ocrStatus: SubmissionOcrStatus;
  ocrSummary: SubmissionOcrSummary | null;
  notes: string | null;
  pointsAwarded: number;
  uploadLatitude: number | null;
  uploadLongitude: number | null;
  uploadAccuracyMeters: number | null;
  uploadLocationCapturedAt: string | null;
  distanceToVenueMeters: number | null;
  pointsEligibleByLocation: boolean;
  pointsEligibilityReason: string | null;
  pendingVenue: PendingVenueDetails | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  fraudFlagged: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionOcrSummary {
  model: string | null;
  imageCount: number;
  extractedRowCount: number;
  rejectedCandidateCount: number;
  pendingCatalogCount: number;
  message: string | null;
}

export interface BusinessSubmissionItem {
  id: string;
  submissionId: string;
  beerName: string;
  normalizedBeerId: string | null;
  servingSize: ServingSize;
  price: number | null;
  isHappyHourPrice: boolean;
  happyHourDetails: string | null;
  isOnTap: TapStatus;
  confidence: number;
  captureSource: SubmissionItemCaptureSource;
  sourceText: string | null;
  requiresCatalogApproval: boolean;
  createdAt: string;
}

export interface BusinessSubmissionWithItems extends BusinessSubmission {
  items: BusinessSubmissionItem[];
}

export interface BusinessMission {
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  reason: string;
  priority: "low" | "normal" | "high";
  points: number;
  multiplier: number;
  active: boolean;
  sponsorFlag: boolean;
  lastVerifiedAt: string | null;
  venueAddress?: string | null;
  distanceMeters?: number | null;
  distanceKm?: number | null;
  freshnessLabel?: string;
  userProgress?: MissionProgressStatus | null;
  reservationAcceptedAt?: string | null;
  reservationExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessMissionFeedItem extends BusinessMission {
  latitude: number | null;
  longitude: number | null;
}

export interface MissionProgress {
  id: string;
  missionId: string;
  userId: string;
  submissionId: string | null;
  status: MissionProgressStatus;
  acceptedAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export class MissionReservationError extends Error {
  constructor(message = "Accept this mission before submitting it.") {
    super(message);
    this.name = "MissionReservationError";
  }
}

export class OptimisticConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimisticConcurrencyError";
  }
}

export interface MissionVenueCandidate {
  venueId: string;
  venueName: string;
  suburb: string | null;
  latestVerifiedAt: string | null;
  recordCount: number;
  happyHourLastVerifiedAt: string | null;
}

export interface VenueLocationCache {
  venueId: string;
  venueName: string;
  suburb: string | null;
  latitude: number | null;
  longitude: number | null;
  updatedAt: string;
}

export interface PendingVenueDetails {
  googlePlaceId: string | null;
  name: string;
  address: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  phone: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface LocalVenueLookup {
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
  instagram?: string | null;
  description?: string | null;
  openingHours?: Record<string, unknown>;
  venueTags?: string[];
  isUserSubmittedVenue?: boolean;
}

export interface BarHappyHourBeer {
  beerId: string | null;
  beerName: string;
  normalizedBeerId: string | null;
  servingSize: ServingSize | null;
  happyHourPrice: number | null;
  offerText: string | null;
  onTap: boolean;
  inStock: boolean;
}

export interface PublicVenuePriceRecord {
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  venueAddress?: string | null;
  membershipTier?: BarMembershipTier;
  highlightedName?: boolean;
  premiumBadge?: string | null;
  promoted?: boolean;
  featuredSpecialEligible?: boolean;
  acceptsPintPathCodes?: boolean;
  beerName: string;
  normalizedBeerId: string | null;
  servingSize: ServingSize;
  price: number | null;
  isHappyHourPrice: boolean;
  happyHourDetails: string | null;
  happyHourTitle?: string | null;
  happyHourDays?: string[];
  happyHourStartTime?: string | null;
  happyHourEndTime?: string | null;
  happyHourBeers?: BarHappyHourBeer[];
  displayKind?: "beer" | "happy_hour" | "special";
  specialTitle?: string | null;
  specialDescription?: string | null;
  specialDiscount?: string | null;
  specialStartsAt?: string | null;
  specialEndsAt?: string | null;
  specialStartTime?: string | null;
  specialEndTime?: string | null;
  specialScheduleNote?: string | null;
  specialExclusive?: boolean;
  isOnTap: TapStatus;
  confidence: ConfidenceLabel;
  sourceType: string;
  sourceSubmissionId: string | null;
  lastVerifiedAt: string;
  priceVerifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountPreferences {
  userId: string;
  preferredSuburbs: string[];
  preferredBeers: string[];
  preferredUseCases: string[];
  onboardingCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountPrivacySettings {
  userId: string;
  optionalAnalyticsEnabled: boolean;
  venueReportInclusionEnabled: boolean;
  productResearchEnabled: boolean;
  emailUpdatesEnabled: boolean;
  consentVersion: string;
  consentedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedItem {
  id: string;
  userId: string;
  itemType: SavedItemType;
  itemId: string;
  label: string;
  suburb: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface FeedbackItem {
  id: string;
  userId: string | null;
  anonymousSessionId: string | null;
  feedbackType: FeedbackType;
  message: string;
  venueId: string | null;
  venueName: string | null;
  contactEmail: string | null;
  status: TrustWorkflowStatus;
  priority: FeedbackPriority;
  triageReason: string | null;
  assignedTo: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WrongPriceReport {
  id: string;
  userId: string | null;
  anonymousSessionId: string | null;
  venueId: string;
  venueName: string;
  priceRecordId: string | null;
  beerName: string | null;
  reason: string;
  notes: string | null;
  sourcePhotoUrl: string | null;
  status: TrustWorkflowStatus;
  assignedTo: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VenueRequest {
  id: string;
  userId: string | null;
  anonymousSessionId: string | null;
  requestType: RequestType;
  venueId: string | null;
  venueName: string | null;
  googlePlaceId: string | null;
  beerName: string | null;
  suburb: string | null;
  notes: string | null;
  status: TrustWorkflowStatus | "mission_created";
  missionId: string | null;
  sourceSubmissionId: string | null;
  assignedTo: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VenueInterestRequest {
  id: string;
  userId: string | null;
  venueId: string | null;
  venueName: string;
  managerName: string;
  email: string;
  phone: string | null;
  role: string;
  notes: string | null;
  status: string;
  assignedTo: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type VenueAccessLevel = "manager" | "counter_staff";

export interface VenueManagerAssignment {
  id: string;
  userId: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  accessLevel: VenueAccessLevel;
  status: string;
  approvedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VenuePartnerOutreach {
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  status: string;
  tierFit: string | null;
  nextAction: string | null;
  lastContactedAt: string | null;
  contactName: string | null;
  notes: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BarClaimRequest {
  id: string;
  userId: string;
  barId: string | null;
  barName: string;
  address: string | null;
  suburb: string | null;
  requesterName: string;
  requesterRole: string;
  contactEmail: string;
  contactPhone: string | null;
  message: string | null;
  status: "pending" | "approved" | "rejected";
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BarProfile {
  barId: string;
  name: string;
  address: string | null;
  suburb: string | null;
  area: string | null;
  phone: string | null;
  website: string | null;
  instagram: string | null;
  description: string | null;
  openingHours: Record<string, unknown>;
  venueTags: string[];
  membershipTier: BarMembershipTier;
  highlightedName: boolean;
  premiumBadge: string | null;
  promoted: boolean;
  featuredSpecialEligible: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  stripePaidMembershipTier: BarMembershipTier | null;
  tierManualOverride: boolean;
  acceptsPintPathCodes: boolean;
  stripeEventCreatedAt: string | null;
  posWebhookTokenVersion: number;
  posPreviousTokenVersion: number | null;
  posPreviousTokenValidUntil: string | null;
  posLastSuccessAt: string | null;
  posLastTerminalId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyticsBucket {
  key: string;
  count: number;
  label?: string | null;
}

export interface SearchTimeBucket extends AnalyticsBucket {
  sort: number;
}

export interface AreaPurchasedBeerBucket extends AnalyticsBucket {
  quantity: number;
  estimatedSavingsCents: number;
}

export interface VenueAreaPriceBenchmark {
  beerName: string;
  serveSize: ServingSize | null;
  venuePrice: number;
  localMedian: number;
  difference: number;
  sampleSize: number;
  comparison: "above" | "below" | "at";
}

export interface BarBeer {
  id: string;
  barId: string;
  beerName: string;
  normalizedBeerId: string | null;
  brewery: string | null;
  style: string | null;
  abv: number | null;
  serveSize: ServingSize | null;
  price: number | null;
  currency: string;
  onTap: boolean;
  inStock: boolean;
  notes: string | null;
  priceVerifiedAt: string | null;
  stockVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BarHappyHour {
  id: string;
  barId: string;
  title: string;
  daysOfWeek: string[];
  startTime: string;
  endTime: string;
  description: string;
  happyHourBeers: BarHappyHourBeer[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BarSpecial {
  id: string;
  barId: string;
  title: string;
  description: string;
  price: number | null;
  discount: string | null;
  savingsAmountCents: number | null;
  startsAt: string | null;
  endsAt: string | null;
  startTime: string | null;
  endTime: string | null;
  recurrence: { frequency: "none" | "weekly"; daysOfWeek: string[]; timezone: string };
  scheduleNote: string | null;
  exclusive: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type BarPendingChangeType = "profile" | "beer" | "happy_hour" | "special";
export type BarPendingChangeAction = "upsert" | "delete";
export type BarPendingChangeStatus = "pending" | "approved" | "rejected";

export interface BarPendingChange {
  id: string;
  barId: string;
  changeType: BarPendingChangeType;
  action: BarPendingChangeAction;
  targetId: string | null;
  payload: Record<string, unknown>;
  status: BarPendingChangeStatus;
  submittedBy: string;
  submittedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonthlyBarReport {
  id: string;
  barId: string;
  month: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface SecurityAuditLog {
  id: string;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ipHash: string | null;
  userAgentHash: string | null;
  createdAt: string;
}

export interface AccountSession {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastIpHash: string | null;
  userAgentHash: string | null;
  providerBacked: boolean;
}

export interface UserActivityEvent {
  id: string;
  userId: string;
  eventType: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface UserVerification {
  id: string;
  verifierUserId: string;
  uploadId: string;
  targetEntityType: string;
  targetEntityId: string;
  result: string;
  notes: string | null;
  createdAt: string;
}

export interface AgeVerification {
  id: string;
  userId: string;
  status: AgeVerificationStatus;
  ageThreshold: number;
  isOver18: boolean;
  providerName: string | null;
  providerReferenceId: string | null;
  checkedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeaderboardEntry {
  rank: number;
  accountId: string;
  displayName: string;
  approvedSubmissions: number;
  points: number;
}

export interface AccountRewardVoucher {
  id: string;
  userId: string;
  publicAccountId: string;
  sourceType: string;
  sourceId: string | null;
  title: string;
  amountCents: number;
  currency: string;
  venueScope: string | null;
  status: "active" | "redeemed" | "expired" | "void";
  issuedAt: string;
  expiresAt: string | null;
  redeemedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LeaderboardPrizeCampaign {
  monthKey: string;
  title: string;
  startsAt: string;
  endsAt: string;
  firstPlaceCents: number;
  secondPlaceCents: number;
  thirdPlaceCents: number;
  affiliateBar: string | null;
  terms: string | null;
  status: "active" | "finalized";
  finalizedAt: string | null;
  finalizedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeaderboardPrizeAward {
  id: string;
  monthKey: string;
  rank: number;
  userId: string;
  publicAccountId: string;
  displayName: string | null;
  points: number;
  approvedSubmissions: number;
  voucherId: string | null;
  createdAt: string;
}

export interface PubGolfVenueCandidate {
  venueId: string;
  venueName: string;
  address: string | null;
  suburb: string | null;
  membershipTier: BarMembershipTier;
  latitude: number | null;
  longitude: number | null;
  beerName: string;
  servingSize: string | null;
  price: number | null;
  updatedAt: string;
}

export interface AccountDiscountPass {
  id: string;
  userId: string;
  sessionTokenHash: string;
  codeHash: string;
  status: "active" | "revoked";
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface DiscountRedemption {
  id: string;
  userId: string;
  publicAccountId: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  specialId: string | null;
  itemName: string | null;
  quantity: number;
  estimatedSavingsCents: number;
  discountPassId: string | null;
  redeemedByUserId: string | null;
  idempotencyKey: string | null;
  redeemedAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type PintPointLedgerType =
  | "drink_scan"
  | "manual_drink_entry"
  | "reward_code_created"
  | "reward_code_expired"
  | "reward_redeemed"
  | "reward_cancelled"
  | "reward_rejected"
  | "drink_void"
  | "admin_adjustment"
  | "fraud_reversal";

export type FreePintRewardCodeStatus = "active" | "used" | "expired" | "cancelled" | "rejected";

export type PintPointDrinkRecordStatus = "active" | "void";

export interface PintPointDrinkRecord {
  id: string;
  userId: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  itemName: string | null;
  beverageCategory: string;
  quantity: number;
  isAlcoholic: boolean;
  pointsAwarded: number;
  source: string;
  rewardCodeId: string | null;
  recordedByUserId: string | null;
  idempotencyKey: string | null;
  status: PintPointDrinkRecordStatus;
  voidedAt: string | null;
  voidedByUserId: string | null;
  voidReason: string | null;
  recordedAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface VenuePintPointActivity {
  id: string;
  publicAccountId: string;
  itemName: string | null;
  beverageCategory: string;
  quantity: number;
  pointsAwarded: number;
  source: string;
  recordedByUserId: string | null;
  status: PintPointDrinkRecordStatus;
  voidedAt: string | null;
  voidedByUserId: string | null;
  voidReason: string | null;
  recordedAt: string;
}

export interface PintPointLedgerEntry {
  id: string;
  userId: string;
  venueId: string | null;
  drinkRecordId: string | null;
  rewardCodeId: string | null;
  type: PintPointLedgerType;
  pointsDelta: number;
  pointsReservedDelta: number;
  description: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface FreePintRewardCode {
  id: string;
  userId: string;
  publicAccountId: string;
  codeHash: string;
  eligibleVenueScope: string;
  status: FreePintRewardCodeStatus;
  pointsReserved: number;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  cancelledAt: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
  redeemedByUserId: string | null;
  redeemedVenueId: string | null;
  metadata: Record<string, unknown>;
}

export interface FreePintRewardRedemption {
  id: string;
  userId: string;
  publicAccountId: string;
  rewardCodeId: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  redeemedByUserId: string | null;
  redeemedAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface AccountRow {
  id: string;
  public_account_id: string | null;
  email: string;
  password_hash: string;
  display_name: string | null;
  display_name_key: string | null;
  avatar_url: string | null;
  auth_provider: string;
  supabase_user_id: string | null;
  email_verified_at: string | null;
  mfa_level: string;
  mfa_verified_at: string | null;
  provider_tokens_valid_after: string | null;
  stripe_paid_subscription_status: PaidSubscriptionStatus | null;
  stripe_event_created_at: string | null;
  role: AccountRole;
  age_confirmed_at: string | null;
  terms_accepted_at: string | null;
  privacy_accepted_at: string | null;
  terms_version: string | null;
  privacy_version: string | null;
  age_verification_status: AgeVerificationStatus;
  is_over_18_verified: number;
  subscription_status: SubscriptionStatus;
  stripe_customer_id: string | null;
  premium_until: string | null;
  trust_score: number;
  contribution_points_current_month: number;
  approved_submission_count: number;
  rejected_submission_count: number;
  fraud_strike_count: number;
  status: AccountStatus;
  created_at: string;
  updated_at: string;
}

interface ProfileRow {
  id: string;
  public_account_id: string | null;
  email: string | null;
  display_name: string | null;
  display_name_key: string | null;
  username: string | null;
  avatar_url: string | null;
  role: AccountRole;
  account_status: AccountStatus;
  age_verification_status: AgeVerificationStatus;
  is_over_18_verified: number;
  created_at: string;
  updated_at: string;
}

interface SecurityAuditLogRow {
  id: string;
  actor_user_id: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata_json: string;
  ip_hash: string | null;
  user_agent_hash: string | null;
  created_at: string;
}

interface SourceEvidenceObjectRow {
  id: string;
  owner_user_id: string | null;
  storage_provider: string;
  object_path: string;
  mime_type: string | null;
  byte_size: number | null;
  data_base64: string | null;
  external_url: string | null;
  retention_expires_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

interface VerificationRow {
  id: string;
  verifier_user_id: string;
  upload_id: string;
  target_entity_type: string;
  target_entity_id: string;
  result: string;
  notes: string | null;
  created_at: string;
}

interface UserActivityEventRow {
  id: string;
  user_id: string;
  event_type: string;
  related_entity_type: string | null;
  related_entity_id: string | null;
  metadata_json: string;
  created_at: string;
}

interface AgeVerificationRow {
  id: string;
  user_id: string;
  status: AgeVerificationStatus;
  age_threshold: number;
  is_over_18: number;
  provider_name: string | null;
  provider_reference_id: string | null;
  checked_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AccountRewardVoucherRow {
  id: string;
  user_id: string;
  public_account_id: string;
  source_type: string;
  source_id: string | null;
  title: string;
  amount_cents: number;
  currency: string;
  venue_scope: string | null;
  status: "active" | "redeemed" | "expired" | "void";
  issued_at: string;
  expires_at: string | null;
  redeemed_at: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface LeaderboardPrizeCampaignRow {
  month_key: string;
  title: string;
  starts_at: string;
  ends_at: string;
  first_place_cents: number;
  second_place_cents: number;
  third_place_cents: number;
  affiliate_bar: string | null;
  terms: string | null;
  status: "active" | "finalized";
  finalized_at: string | null;
  finalized_by: string | null;
  created_at: string;
  updated_at: string;
}

interface LeaderboardPrizeAwardRow {
  id: string;
  month_key: string;
  rank: number;
  user_id: string;
  public_account_id: string;
  display_name: string | null;
  points: number;
  approved_submissions: number;
  voucher_id: string | null;
  created_at: string;
}

interface SubmissionRow {
  id: string;
  client_submission_id: string | null;
  mission_id: string | null;
  user_id: string;
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  status: SubmissionStatus;
  submission_type: SubmissionType;
  observed_at: string;
  source_photo_url: string | null;
  ocr_status: SubmissionOcrStatus;
  ocr_summary_json: string | null;
  notes: string | null;
  points_awarded: number;
  upload_latitude: number | null;
  upload_longitude: number | null;
  upload_accuracy_meters: number | null;
  upload_location_captured_at: string | null;
  distance_to_venue_meters: number | null;
  points_eligible_by_location: number;
  points_eligibility_reason: string | null;
  pending_venue_json: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  fraud_flagged: number;
  created_at: string;
  updated_at: string;
}

interface SubmissionItemRow {
  id: string;
  submission_id: string;
  beer_name: string;
  normalized_beer_id: string | null;
  serving_size: ServingSize;
  price: number | null;
  is_happy_hour_price: number;
  happy_hour_details: string | null;
  is_on_tap: TapStatus;
  confidence: number;
  capture_source: SubmissionItemCaptureSource;
  source_text: string | null;
  requires_catalog_approval: number;
  created_at: string;
}

interface MissionRow {
  id: string;
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  reason: string;
  priority: "low" | "normal" | "high";
  points: number;
  multiplier: number;
  active: number;
  sponsor_flag: number;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MissionProgressRow {
  id: string;
  mission_id: string;
  user_id: string;
  submission_id: string | null;
  status: MissionProgressStatus;
  accepted_at: string;
  submitted_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface VenueLocationCacheRow {
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  latitude: number | null;
  longitude: number | null;
  updated_at: string;
}

interface PriceRecordRow {
  id: string;
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  beer_name: string;
  normalized_beer_id: string | null;
  serving_size: ServingSize;
  price: number | null;
  is_happy_hour_price: number;
  happy_hour_details: string | null;
  is_on_tap: TapStatus;
  confidence: ConfidenceLabel;
  source_type: string;
  source_submission_id: string | null;
  last_verified_at: string;
  created_at: string;
  updated_at: string;
}

interface AccountPreferencesRow {
  user_id: string;
  preferred_suburbs_json: string;
  preferred_beers_json: string;
  preferred_use_cases_json: string;
  onboarding_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AccountPrivacySettingsRow {
  user_id: string;
  optional_analytics_enabled: number;
  venue_report_inclusion_enabled: number;
  product_research_enabled: number;
  email_updates_enabled: number;
  consent_version: string;
  consented_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SavedItemRow {
  id: string;
  user_id: string;
  item_type: SavedItemType;
  item_id: string;
  label: string;
  suburb: string | null;
  metadata_json: string;
  created_at: string;
}

interface FeedbackRow {
  id: string;
  user_id: string | null;
  anonymous_session_id: string | null;
  feedback_type: FeedbackType;
  message: string;
  venue_id: string | null;
  venue_name: string | null;
  contact_email: string | null;
  status: TrustWorkflowStatus;
  priority: FeedbackPriority;
  triage_reason: string | null;
  assigned_to: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

interface WrongPriceReportRow {
  id: string;
  user_id: string | null;
  anonymous_session_id: string | null;
  venue_id: string;
  venue_name: string;
  price_record_id: string | null;
  beer_name: string | null;
  reason: string;
  notes: string | null;
  source_photo_url: string | null;
  status: TrustWorkflowStatus;
  assigned_to: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

interface VenueRequestRow {
  id: string;
  user_id: string | null;
  anonymous_session_id: string | null;
  request_type: RequestType;
  venue_id: string | null;
  venue_name: string | null;
  google_place_id: string | null;
  beer_name: string | null;
  suburb: string | null;
  notes: string | null;
  status: TrustWorkflowStatus | "mission_created";
  mission_id: string | null;
  source_submission_id: string | null;
  assigned_to: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

interface VenueInterestRequestRow {
  id: string;
  user_id: string | null;
  venue_id: string | null;
  venue_name: string;
  manager_name: string;
  email: string;
  phone: string | null;
  role: string;
  notes: string | null;
  status: string;
  assigned_to: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

interface VenueManagerAssignmentRow {
  id: string;
  user_id: string;
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  access_level: VenueAccessLevel;
  status: string;
  approved_by: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface VenuePartnerOutreachRow {
  id: string;
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  status: string;
  tier_fit: string | null;
  next_action: string | null;
  last_contacted_at: string | null;
  contact_name: string | null;
  notes: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

interface BarProfileRow {
  venue_id: string;
  name: string;
  address: string | null;
  suburb: string | null;
  area: string | null;
  phone: string | null;
  website: string | null;
  instagram: string | null;
  description: string | null;
  opening_hours_json: string;
  venue_tags_json: string;
  membership_tier: StoredBarMembershipTier;
  highlighted_name: number;
  premium_badge: string | null;
  promoted: number;
  featured_special_eligible: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  stripe_paid_membership_tier: StoredBarMembershipTier | null;
  tier_manual_override: number;
  accepts_pint_path_codes: number;
  stripe_event_created_at: string | null;
  pos_webhook_token_version: number;
  pos_previous_token_version: number | null;
  pos_previous_token_valid_until: string | null;
  pos_last_success_at: string | null;
  pos_last_terminal_id: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

interface BarClaimRequestRow {
  id: string;
  user_id: string;
  venue_id: string | null;
  venue_name: string;
  address: string | null;
  suburb: string | null;
  requester_name: string;
  requester_role: string;
  contact_email: string;
  contact_phone: string | null;
  message: string | null;
  status: "pending" | "approved" | "rejected";
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface BarBeerRow {
  id: string;
  venue_id: string;
  beer_name: string;
  normalized_beer_id: string | null;
  brewery: string | null;
  style: string | null;
  abv: number | null;
  serve_size: ServingSize | null;
  price: number | null;
  currency: string;
  on_tap: number;
  in_stock: number;
  notes: string | null;
  price_verified_at: string | null;
  stock_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface BarHappyHourRow {
  id: string;
  venue_id: string;
  title: string;
  days_of_week_json: string;
  start_time: string;
  end_time: string;
  description: string;
  happy_hour_beers_json: string;
  active: number;
  created_at: string;
  updated_at: string;
}

interface BarSpecialRow {
  id: string;
  venue_id: string;
  title: string;
  description: string;
  price: number | null;
  discount: string | null;
  savings_amount_cents: number | null;
  starts_at: string | null;
  ends_at: string | null;
  start_time: string | null;
  end_time: string | null;
  recurrence_frequency: "none" | "weekly";
  days_of_week_json: string;
  timezone: string;
  schedule_note: string | null;
  exclusive: number;
  active: number;
  created_at: string;
  updated_at: string;
}

interface BarPendingChangeRow {
  id: string;
  venue_id: string;
  change_type: BarPendingChangeType;
  action: BarPendingChangeAction;
  target_id: string | null;
  payload_json: string;
  status: BarPendingChangeStatus;
  submitted_by: string;
  submitted_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface MonthlyBarReportRow {
  id: string;
  venue_id: string;
  month: string;
  data_json: string;
  created_at: string;
}

interface AccountDiscountPassRow {
  id: string;
  user_id: string;
  session_token_hash: string;
  code_hash: string;
  status: "active" | "revoked";
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

interface DiscountRedemptionRow {
  id: string;
  user_id: string;
  public_account_id: string;
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  special_id: string | null;
  item_name: string | null;
  quantity: number;
  estimated_savings_cents: number;
  discount_pass_id: string | null;
  redeemed_by_user_id: string | null;
  idempotency_key: string | null;
  redeemed_at: string;
  metadata_json: string;
  created_at: string;
}

interface PintPointDrinkRecordRow {
  id: string;
  user_id: string;
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  item_name: string | null;
  beverage_category: string;
  quantity: number;
  is_alcoholic: number;
  points_awarded: number;
  source: string;
  reward_code_id: string | null;
  recorded_by_user_id: string | null;
  idempotency_key: string | null;
  status: PintPointDrinkRecordStatus;
  voided_at: string | null;
  voided_by_user_id: string | null;
  void_reason: string | null;
  recorded_at: string;
  metadata_json: string;
  created_at: string;
}

interface VenuePintPointActivityRow {
  id: string;
  public_account_id: string;
  item_name: string | null;
  beverage_category: string;
  quantity: number;
  points_awarded: number;
  source: string;
  recorded_by_user_id: string | null;
  status: PintPointDrinkRecordStatus;
  voided_at: string | null;
  voided_by_user_id: string | null;
  void_reason: string | null;
  recorded_at: string;
}

interface PintPointLedgerRow {
  id: string;
  user_id: string;
  venue_id: string | null;
  drink_record_id: string | null;
  reward_code_id: string | null;
  type: PintPointLedgerType;
  points_delta: number;
  points_reserved_delta: number;
  description: string;
  created_at: string;
  metadata_json: string;
}

interface FreePintRewardCodeRow {
  id: string;
  user_id: string;
  public_account_id: string;
  code_hash: string;
  eligible_venue_scope: string;
  status: FreePintRewardCodeStatus;
  points_reserved: number;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  cancelled_at: string | null;
  rejected_at: string | null;
  rejected_reason: string | null;
  redeemed_by_user_id: string | null;
  redeemed_venue_id: string | null;
  metadata_json: string;
}

interface FreePintRewardRedemptionRow {
  id: string;
  user_id: string;
  public_account_id: string;
  reward_code_id: string;
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  redeemed_by_user_id: string | null;
  redeemed_at: string;
  metadata_json: string;
  created_at: string;
}

function toAccount(row: AccountRow): BusinessAccount {
  return {
    id: row.id,
    publicAccountId: row.public_account_id ?? row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    displayNameKey: row.display_name_key,
    avatarUrl: row.avatar_url,
    authProvider: row.auth_provider,
    supabaseUserId: row.supabase_user_id,
    emailVerifiedAt: row.email_verified_at,
    mfaLevel: row.mfa_level,
    mfaVerifiedAt: row.mfa_verified_at,
    providerTokensValidAfter: row.provider_tokens_valid_after,
    stripePaidSubscriptionStatus: row.stripe_paid_subscription_status,
    stripeEventCreatedAt: row.stripe_event_created_at,
    role: row.role,
    ageConfirmedAt: row.age_confirmed_at,
    termsAcceptedAt: row.terms_accepted_at,
    privacyAcceptedAt: row.privacy_accepted_at,
    termsVersion: row.terms_version,
    privacyVersion: row.privacy_version,
    ageVerificationStatus: row.age_verification_status,
    isOver18Verified: Boolean(row.is_over_18_verified),
    subscriptionStatus: row.subscription_status,
    stripeCustomerId: row.stripe_customer_id,
    premiumUntil: row.premium_until,
    trustScore: row.trust_score,
    contributionPointsCurrentMonth: row.contribution_points_current_month,
    approvedSubmissionCount: row.approved_submission_count,
    rejectedSubmissionCount: row.rejected_submission_count,
    fraudStrikeCount: row.fraud_strike_count,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSourceEvidenceObject(row: SourceEvidenceObjectRow): SourceEvidenceObject {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    storageProvider: row.storage_provider,
    objectPath: row.object_path,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    dataBase64: row.data_base64,
    externalUrl: row.external_url,
    retentionExpiresAt: row.retention_expires_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  };
}

function toProfile(row: ProfileRow): PublicProfile {
  return {
    id: row.id,
    publicAccountId: row.public_account_id,
    email: row.email,
    displayName: row.display_name,
    displayNameKey: row.display_name_key,
    username: row.username,
    avatarUrl: row.avatar_url,
    role: row.role,
    accountStatus: row.account_status,
    ageVerificationStatus: row.age_verification_status,
    isOver18Verified: Boolean(row.is_over_18_verified),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAccountRewardVoucher(row: AccountRewardVoucherRow): AccountRewardVoucher {
  return {
    id: row.id,
    userId: row.user_id,
    publicAccountId: row.public_account_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    title: row.title,
    amountCents: row.amount_cents,
    currency: row.currency,
    venueScope: row.venue_scope,
    status: row.status,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLeaderboardPrizeCampaign(row: LeaderboardPrizeCampaignRow): LeaderboardPrizeCampaign {
  return {
    monthKey: row.month_key,
    title: row.title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    firstPlaceCents: row.first_place_cents,
    secondPlaceCents: row.second_place_cents,
    thirdPlaceCents: row.third_place_cents,
    affiliateBar: row.affiliate_bar,
    terms: row.terms,
    status: row.status,
    finalizedAt: row.finalized_at,
    finalizedBy: row.finalized_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLeaderboardPrizeAward(row: LeaderboardPrizeAwardRow): LeaderboardPrizeAward {
  return {
    id: row.id,
    monthKey: row.month_key,
    rank: row.rank,
    userId: row.user_id,
    publicAccountId: row.public_account_id,
    displayName: row.display_name,
    points: row.points,
    approvedSubmissions: row.approved_submissions,
    voucherId: row.voucher_id,
    createdAt: row.created_at,
  };
}

function toAccountDiscountPass(row: AccountDiscountPassRow): AccountDiscountPass {
  return {
    id: row.id,
    userId: row.user_id,
    sessionTokenHash: row.session_token_hash,
    codeHash: row.code_hash,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

function toDiscountRedemption(row: DiscountRedemptionRow): DiscountRedemption {
  return {
    id: row.id,
    userId: row.user_id,
    publicAccountId: row.public_account_id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    suburb: row.suburb,
    specialId: row.special_id,
    itemName: row.item_name,
    quantity: row.quantity,
    estimatedSavingsCents: row.estimated_savings_cents,
    discountPassId: row.discount_pass_id,
    redeemedByUserId: row.redeemed_by_user_id,
    idempotencyKey: row.idempotency_key,
    redeemedAt: row.redeemed_at,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

function toPintPointDrinkRecord(row: PintPointDrinkRecordRow): PintPointDrinkRecord {
  return {
    id: row.id,
    userId: row.user_id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    suburb: row.suburb,
    itemName: row.item_name,
    beverageCategory: row.beverage_category,
    quantity: row.quantity,
    isAlcoholic: Boolean(row.is_alcoholic),
    pointsAwarded: Number(row.points_awarded ?? 0),
    source: row.source,
    rewardCodeId: row.reward_code_id,
    recordedByUserId: row.recorded_by_user_id,
    idempotencyKey: row.idempotency_key,
    status: row.status ?? "active",
    voidedAt: row.voided_at,
    voidedByUserId: row.voided_by_user_id,
    voidReason: row.void_reason,
    recordedAt: row.recorded_at,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

function toPintPointLedgerEntry(row: PintPointLedgerRow): PintPointLedgerEntry {
  return {
    id: row.id,
    userId: row.user_id,
    venueId: row.venue_id,
    drinkRecordId: row.drink_record_id,
    rewardCodeId: row.reward_code_id,
    type: row.type,
    pointsDelta: row.points_delta,
    pointsReservedDelta: row.points_reserved_delta,
    description: row.description,
    createdAt: row.created_at,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function toFreePintRewardCode(row: FreePintRewardCodeRow): FreePintRewardCode {
  return {
    id: row.id,
    userId: row.user_id,
    publicAccountId: row.public_account_id,
    codeHash: row.code_hash,
    eligibleVenueScope: row.eligible_venue_scope,
    status: row.status,
    pointsReserved: row.points_reserved,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    cancelledAt: row.cancelled_at,
    rejectedAt: row.rejected_at,
    rejectedReason: row.rejected_reason,
    redeemedByUserId: row.redeemed_by_user_id,
    redeemedVenueId: row.redeemed_venue_id,
    metadata: parseJsonObject(row.metadata_json),
  };
}

function toFreePintRewardRedemption(row: FreePintRewardRedemptionRow): FreePintRewardRedemption {
  return {
    id: row.id,
    userId: row.user_id,
    publicAccountId: row.public_account_id,
    rewardCodeId: row.reward_code_id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    suburb: row.suburb,
    redeemedByUserId: row.redeemed_by_user_id,
    redeemedAt: row.redeemed_at,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

function parseSubmissionOcrSummary(value: string | null): SubmissionOcrSummary | null {
  if (!value) return null;
  const parsed = parseJsonObject(value);
  return {
    model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : null,
    imageCount: Math.max(0, Number(parsed.imageCount) || 0),
    extractedRowCount: Math.max(0, Number(parsed.extractedRowCount) || 0),
    rejectedCandidateCount: Math.max(0, Number(parsed.rejectedCandidateCount) || 0),
    pendingCatalogCount: Math.max(0, Number(parsed.pendingCatalogCount) || 0),
    message: typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : null,
  };
}

function toSubmission(row: SubmissionRow): BusinessSubmission {
  return {
    id: row.id,
    clientSubmissionId: row.client_submission_id,
    missionId: row.mission_id,
    userId: row.user_id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    suburb: row.suburb,
    status: row.status,
    submissionType: row.submission_type,
    observedAt: row.observed_at,
    sourcePhotoUrl: row.source_photo_url,
    ocrStatus: row.ocr_status,
    ocrSummary: parseSubmissionOcrSummary(row.ocr_summary_json),
    notes: row.notes,
    pointsAwarded: row.points_awarded,
    uploadLatitude: row.upload_latitude,
    uploadLongitude: row.upload_longitude,
    uploadAccuracyMeters: row.upload_accuracy_meters,
    uploadLocationCapturedAt: row.upload_location_captured_at,
    distanceToVenueMeters: row.distance_to_venue_meters,
    pointsEligibleByLocation: Boolean(row.points_eligible_by_location),
    pointsEligibilityReason: row.points_eligibility_reason,
    pendingVenue: parsePendingVenueDetails(row.pending_venue_json),
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    rejectionReason: row.rejection_reason,
    fraudFlagged: Boolean(row.fraud_flagged),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMissionProgress(row: MissionProgressRow): MissionProgress {
  return {
    id: row.id,
    missionId: row.mission_id,
    userId: row.user_id,
    submissionId: row.submission_id,
    status: row.status,
    acceptedAt: row.accepted_at,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function toSubmissionItem(row: SubmissionItemRow): BusinessSubmissionItem {
  return {
    id: row.id,
    submissionId: row.submission_id,
    beerName: row.beer_name,
    normalizedBeerId: row.normalized_beer_id,
    servingSize: row.serving_size,
    price: row.price,
    isHappyHourPrice: Boolean(row.is_happy_hour_price),
    happyHourDetails: row.happy_hour_details,
    isOnTap: row.is_on_tap,
    confidence: row.confidence,
    captureSource: row.capture_source,
    sourceText: row.source_text,
    requiresCatalogApproval: Boolean(row.requires_catalog_approval),
    createdAt: row.created_at,
  };
}

function toMission(row: MissionRow): BusinessMission {
  return {
    id: row.id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    suburb: row.suburb,
    reason: row.reason,
    priority: row.priority,
    points: row.points,
    multiplier: row.multiplier,
    active: Boolean(row.active),
    sponsorFlag: Boolean(row.sponsor_flag),
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVenueLocationCache(row: VenueLocationCacheRow): VenueLocationCache {
  return {
    venueId: row.venue_id,
    venueName: row.venue_name,
    suburb: row.suburb,
    latitude: row.latitude,
    longitude: row.longitude,
    updatedAt: row.updated_at,
  };
}

function toPriceRecord(row: PriceRecordRow): PublicVenuePriceRecord {
  return {
    id: row.id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    suburb: row.suburb,
    beerName: row.beer_name,
    normalizedBeerId: row.normalized_beer_id,
    servingSize: row.serving_size,
    price: row.price,
    isHappyHourPrice: Boolean(row.is_happy_hour_price),
    happyHourDetails: row.happy_hour_details,
    isOnTap: row.is_on_tap,
    confidence: row.confidence,
    sourceType: row.source_type,
    sourceSubmissionId: row.source_submission_id,
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseHappyHourBeers(value: string | null): BarHappyHourBeer[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      .map((item) => ({
        beerId: typeof item.beerId === "string" && item.beerId.trim() ? item.beerId.trim() : null,
        beerName: typeof item.beerName === "string" ? item.beerName.trim() : "",
        normalizedBeerId: typeof item.normalizedBeerId === "string" && item.normalizedBeerId.trim() ? item.normalizedBeerId.trim() : null,
        servingSize: typeof item.servingSize === "string" && item.servingSize.trim() ? item.servingSize.trim() as ServingSize : null,
        happyHourPrice: typeof item.happyHourPrice === "number" && Number.isFinite(item.happyHourPrice) ? item.happyHourPrice : null,
        offerText: typeof item.offerText === "string" && item.offerText.trim() ? item.offerText.trim() : null,
        onTap: typeof item.onTap === "boolean" ? item.onTap : false,
        inStock: typeof item.inStock === "boolean" ? item.inStock : true,
      }))
      .filter((item) => item.beerName.length > 0)
      .slice(0, 60);
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function scrubDeletedIdentityJson(
  rawJson: string,
  input: { userId: string; email: string; surrogateId: string },
): string {
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value === input.userId) return input.surrogateId;
      const emailPattern = new RegExp(input.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      return value
        .replaceAll(input.userId, input.surrogateId)
        .replace(emailPattern, "[deleted-email]");
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        const scrubbedKey = scrub(key);
        return [typeof scrubbedKey === "string" ? scrubbedKey : "[deleted-key]", scrub(entry)];
      }));
    }
    return value;
  };
  try {
    return JSON.stringify(scrub(JSON.parse(rawJson)));
  } catch {
    return '{"redactedAfterAccountDeletion":true}';
  }
}

function normalizeAnalyticsBeerId(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return findTrackedBeerByName(value)?.key ?? value;
}

const REPORT_TREND_CONTACT_PATTERN = /(?:\bhttps?:\/\/|\bwww\.|@|\b(?:call|text|phone|mobile|email|contact)\b)/i;
const REPORT_TREND_PHONE_PATTERN = /(?:\+?\d[\s().-]*){7,}/;
const REPORT_STYLE_BY_KEY = new Map<string, string>();

for (const style of [
  ...VIEWER_TRACKED_BEERS.map((beer) => beer.style ?? ""),
  "ale",
  "lager",
  "stout",
  "porter",
  "pilsner",
  "ipa",
  "xpa",
  "pale ale",
  "hazy ipa",
  "hazy pale ale",
  "wheat beer",
  "sour",
  "cider",
  "pacific ale",
]) {
  const label = style.trim().toLowerCase().replace(/\s+/g, " ");
  const key = label.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (key && !REPORT_STYLE_BY_KEY.has(key)) REPORT_STYLE_BY_KEY.set(key, label);
}

function hasUnsafeReportTrendText(value: string | null | undefined): boolean {
  const text = String(value ?? "").trim();
  return !text || text.length > 80 || REPORT_TREND_CONTACT_PATTERN.test(text) || REPORT_TREND_PHONE_PATTERN.test(text);
}

function safeReportBeerTrend(row: AnalyticsBucket): AnalyticsBucket | null {
  const tracked = findTrackedBeerByName(row.key) ?? findTrackedBeerByName(row.label);
  if (tracked) return { key: tracked.key, count: row.count };
  if (hasUnsafeReportTrendText(row.key) || hasUnsafeReportTrendText(row.label)) return null;
  const key = row.key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (key.length < 2 || key.length > 60 || !/[a-z]/.test(key)) return null;
  return { key, count: row.count };
}

function safeReportStyleTrend(row: AnalyticsBucket): AnalyticsBucket | null {
  if (hasUnsafeReportTrendText(row.key) || hasUnsafeReportTrendText(row.label)) return null;
  const key = row.key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const label = REPORT_STYLE_BY_KEY.get(key);
  return label ? { key: label, count: row.count } : null;
}

function mergeReportTrendRows(rows: Array<AnalyticsBucket | null>): AnalyticsBucket[] {
  const merged = new Map<string, AnalyticsBucket>();
  for (const row of rows) {
    if (!row) continue;
    const existing = merged.get(row.key);
    if (!existing || row.count > existing.count) merged.set(row.key, row);
  }
  return [...merged.values()].sort((left, right) => right.count - left.count).slice(0, 8);
}

function normalizeBeerInsightKey(value: string | null | undefined): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "unknown";
  }

  return findTrackedBeerByName(trimmed)?.key ?? trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizePartnerLeadKeyPart(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatInsightBeerLabel(value: string | null | undefined): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "Unspecified beer";
  }

  return findTrackedBeerByName(trimmed)?.name ?? trimmed
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) {
    return null;
  }

  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[midpoint] ?? null;
  }

  const left = sorted[midpoint - 1];
  const right = sorted[midpoint];
  return left == null || right == null ? null : (left + right) / 2;
}

function formatHourLabel(hour: number): string {
  if (hour === 0) {
    return "12 am";
  }
  if (hour === 12) {
    return "12 pm";
  }
  return hour > 12 ? `${hour - 12} pm` : `${hour} am`;
}

function buildSearchTimeBuckets(
  rows: Array<{ created_at: string; actor_key: string }>,
  timezone: string,
  privacyThreshold: number,
): {
  byDay: SearchTimeBucket[];
  byHour: SearchTimeBucket[];
} {
  const dayFormatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone || DEFAULT_REPORT_TIMEZONE,
    weekday: "short",
  });
  const hourFormatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone || DEFAULT_REPORT_TIMEZONE,
    hour: "2-digit",
    hourCycle: "h23",
  });
  const dayOrder = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayActors = new Map<string, Set<string>>();
  const hourActors = new Map<number, Set<string>>();

  for (const row of rows) {
    const date = new Date(row.created_at);
    if (Number.isNaN(date.getTime())) {
      continue;
    }

    const dayLabel = dayFormatter.format(date);
    const actorsForDay = dayActors.get(dayLabel) ?? new Set<string>();
    actorsForDay.add(row.actor_key);
    dayActors.set(dayLabel, actorsForDay);

    const hour = Number(hourFormatter.format(date));
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23) {
      const actorsForHour = hourActors.get(hour) ?? new Set<string>();
      actorsForHour.add(row.actor_key);
      hourActors.set(hour, actorsForHour);
    }
  }

  return {
    byDay: Array.from(dayActors.entries())
      .map(([label, actors]) => ({
        key: label.toLowerCase(),
        label,
        count: actors.size,
        sort: dayOrder.indexOf(label),
      }))
      .filter((bucket) => bucket.count >= privacyThreshold)
      .sort((a, b) => b.count - a.count || a.sort - b.sort),
    byHour: Array.from(hourActors.entries())
      .map(([hour, actors]) => ({
        key: String(hour).padStart(2, "0"),
        label: formatHourLabel(hour),
        count: actors.size,
        sort: hour,
      }))
      .filter((bucket) => bucket.count >= privacyThreshold)
      .sort((a, b) => b.count - a.count || a.sort - b.sort),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parsePendingVenueDetails(value: string | null | undefined): PendingVenueDetails | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const name = stringOrNull(parsed.name);
    if (!name) {
      return null;
    }

    return {
      googlePlaceId: stringOrNull(parsed.googlePlaceId),
      name,
      address: stringOrNull(parsed.address),
      suburb: stringOrNull(parsed.suburb),
      state: stringOrNull(parsed.state),
      postcode: stringOrNull(parsed.postcode),
      phone: stringOrNull(parsed.phone),
      website: stringOrNull(parsed.website),
      latitude: numberOrNull(parsed.latitude),
      longitude: numberOrNull(parsed.longitude),
    };
  } catch {
    return null;
  }
}

function normalizeBarMembershipTier(value: StoredBarMembershipTier | string | null | undefined): BarMembershipTier {
  if (value === "pro" || value === "plus" || value === "super_premium") {
    return "pro";
  }

  return "basic";
}

function toAccountPreferences(row: AccountPreferencesRow): AccountPreferences {
  return {
    userId: row.user_id,
    preferredSuburbs: parseJsonArray(row.preferred_suburbs_json),
    preferredBeers: parseJsonArray(row.preferred_beers_json),
    preferredUseCases: parseJsonArray(row.preferred_use_cases_json),
    onboardingCompletedAt: row.onboarding_completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAccountPrivacySettings(row: AccountPrivacySettingsRow): AccountPrivacySettings {
  return {
    userId: row.user_id,
    optionalAnalyticsEnabled: Boolean(row.optional_analytics_enabled),
    venueReportInclusionEnabled: Boolean(row.venue_report_inclusion_enabled),
    productResearchEnabled: Boolean(row.product_research_enabled),
    emailUpdatesEnabled: Boolean(row.email_updates_enabled),
    consentVersion: row.consent_version,
    consentedAt: row.consented_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSavedItem(row: SavedItemRow): SavedItem {
  return {
    id: row.id,
    userId: row.user_id,
    itemType: row.item_type,
    itemId: row.item_id,
    label: row.label,
    suburb: row.suburb,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

function toFeedback(row: FeedbackRow): FeedbackItem {
  return {
    id: row.id,
    userId: row.user_id,
    anonymousSessionId: row.anonymous_session_id,
    feedbackType: row.feedback_type,
    message: row.message,
    venueId: row.venue_id,
    venueName: row.venue_name,
    contactEmail: row.contact_email,
    status: row.status,
    priority: row.priority,
    triageReason: row.triage_reason,
    assignedTo: row.assigned_to,
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWrongPriceReport(row: WrongPriceReportRow): WrongPriceReport {
  return {
    id: row.id,
    userId: row.user_id,
    anonymousSessionId: row.anonymous_session_id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    priceRecordId: row.price_record_id,
    beerName: row.beer_name,
    reason: row.reason,
    notes: row.notes,
    sourcePhotoUrl: row.source_photo_url,
    status: row.status,
    assignedTo: row.assigned_to,
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVenueRequest(row: VenueRequestRow): VenueRequest {
  return {
    id: row.id,
    userId: row.user_id,
    anonymousSessionId: row.anonymous_session_id,
    requestType: row.request_type,
    venueId: row.venue_id,
    venueName: row.venue_name,
    googlePlaceId: row.google_place_id,
    beerName: row.beer_name,
    suburb: row.suburb,
    notes: row.notes,
    status: row.status,
    missionId: row.mission_id,
    sourceSubmissionId: row.source_submission_id,
    assignedTo: row.assigned_to,
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVenueInterestRequest(row: VenueInterestRequestRow): VenueInterestRequest {
  return {
    id: row.id,
    userId: row.user_id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    managerName: row.manager_name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    notes: row.notes,
    status: row.status,
    assignedTo: row.assigned_to,
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVenueManagerAssignment(row: VenueManagerAssignmentRow): VenueManagerAssignment {
  return {
    id: row.id,
    userId: row.user_id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    suburb: row.suburb,
    accessLevel: row.access_level ?? "manager",
    status: row.status,
    approvedBy: row.approved_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVenuePartnerOutreach(row: VenuePartnerOutreachRow): VenuePartnerOutreach {
  return {
    id: row.id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    suburb: row.suburb,
    status: row.status,
    tierFit: row.tier_fit,
    nextAction: row.next_action,
    lastContactedAt: row.last_contacted_at,
    contactName: row.contact_name,
    notes: row.notes,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBarClaimRequest(row: BarClaimRequestRow): BarClaimRequest {
  return {
    id: row.id,
    userId: row.user_id,
    barId: row.venue_id,
    barName: row.venue_name,
    address: row.address,
    suburb: row.suburb,
    requesterName: row.requester_name,
    requesterRole: row.requester_role,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    message: row.message,
    status: row.status,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBarProfile(row: BarProfileRow): BarProfile {
  return {
    barId: row.venue_id,
    name: row.name,
    address: row.address,
    suburb: row.suburb,
    area: row.area,
    phone: row.phone,
    website: row.website,
    instagram: row.instagram,
    description: row.description,
    openingHours: parseJsonObject(row.opening_hours_json),
    venueTags: parseJsonArray(row.venue_tags_json),
    membershipTier: normalizeBarMembershipTier(row.membership_tier),
    highlightedName: Boolean(row.highlighted_name),
    premiumBadge: row.premium_badge,
    promoted: Boolean(row.promoted),
    featuredSpecialEligible: Boolean(row.featured_special_eligible),
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    subscriptionStatus: row.subscription_status,
    stripePaidMembershipTier: row.stripe_paid_membership_tier
      ? normalizeBarMembershipTier(row.stripe_paid_membership_tier)
      : null,
    tierManualOverride: Boolean(row.tier_manual_override),
    acceptsPintPathCodes: Boolean(row.accepts_pint_path_codes),
    stripeEventCreatedAt: row.stripe_event_created_at,
    posWebhookTokenVersion: Number(row.pos_webhook_token_version || 1),
    posPreviousTokenVersion: row.pos_previous_token_version == null ? null : Number(row.pos_previous_token_version),
    posPreviousTokenValidUntil: row.pos_previous_token_valid_until,
    posLastSuccessAt: row.pos_last_success_at,
    posLastTerminalId: row.pos_last_terminal_id,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBarBeer(row: BarBeerRow): BarBeer {
  return {
    id: row.id,
    barId: row.venue_id,
    beerName: row.beer_name,
    normalizedBeerId: row.normalized_beer_id,
    brewery: row.brewery,
    style: row.style,
    abv: row.abv,
    serveSize: row.serve_size,
    price: row.price,
    currency: row.currency,
    onTap: Boolean(row.on_tap),
    inStock: Boolean(row.in_stock),
    notes: row.notes,
    priceVerifiedAt: row.price_verified_at,
    stockVerifiedAt: row.stock_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBarHappyHour(row: BarHappyHourRow): BarHappyHour {
  return {
    id: row.id,
    barId: row.venue_id,
    title: row.title,
    daysOfWeek: parseJsonArray(row.days_of_week_json),
    startTime: row.start_time,
    endTime: row.end_time,
    description: row.description,
    happyHourBeers: parseHappyHourBeers(row.happy_hour_beers_json),
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBarSpecial(row: BarSpecialRow): BarSpecial {
  return {
    id: row.id,
    barId: row.venue_id,
    title: row.title,
    description: row.description,
    price: row.price,
    discount: row.discount,
    savingsAmountCents: row.savings_amount_cents,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    startTime: row.start_time,
    endTime: row.end_time,
    recurrence: {
      frequency: row.recurrence_frequency || "none",
      daysOfWeek: parseJsonArray(row.days_of_week_json ?? "[]"),
      timezone: row.timezone || "Australia/Melbourne",
    },
    scheduleNote: row.schedule_note,
    exclusive: Boolean(row.exclusive),
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toBarPendingChange(row: BarPendingChangeRow): BarPendingChange {
  return {
    id: row.id,
    barId: row.venue_id,
    changeType: row.change_type,
    action: row.action,
    targetId: row.target_id,
    payload: parseJsonObject(row.payload_json),
    status: row.status,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMonthlyBarReport(row: MonthlyBarReportRow): MonthlyBarReport {
  return {
    id: row.id,
    barId: row.venue_id,
    month: row.month,
    data: parseJsonObject(row.data_json),
    createdAt: row.created_at,
  };
}

function getReportMonthRange(month: string | undefined, timezone = DEFAULT_REPORT_TIMEZONE): { startIso: string; endIso: string } | null {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return null;
  }

  try {
    return getZonedMonthRangeIso(month, timezone);
  } catch {
    return null;
  }
}

function toSecurityAuditLog(row: SecurityAuditLogRow): SecurityAuditLog {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorRole: row.actor_role,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: parseJsonObject(row.metadata_json),
    ipHash: row.ip_hash,
    userAgentHash: row.user_agent_hash,
    createdAt: row.created_at,
  };
}

function toVerification(row: VerificationRow): UserVerification {
  return {
    id: row.id,
    verifierUserId: row.verifier_user_id,
    uploadId: row.upload_id,
    targetEntityType: row.target_entity_type,
    targetEntityId: row.target_entity_id,
    result: row.result,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function toUserActivityEvent(row: UserActivityEventRow): UserActivityEvent {
  return {
    id: row.id,
    userId: row.user_id,
    eventType: row.event_type,
    relatedEntityType: row.related_entity_type,
    relatedEntityId: row.related_entity_id,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

function toAgeVerification(row: AgeVerificationRow): AgeVerification {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    ageThreshold: row.age_threshold,
    isOver18: Boolean(row.is_over_18),
    providerName: row.provider_name,
    providerReferenceId: row.provider_reference_id,
    checkedAt: row.checked_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BusinessRepository {
  constructor(private readonly database: BetterSqlite3.Database) {}

  checkDatabaseHealth(): { ok: boolean; foreignKeyViolations: number } {
    const probe = this.database.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
    const violation = this.database.prepare("PRAGMA foreign_key_check").get() as Record<string, unknown> | undefined;
    return {
      ok: probe?.ok === 1 && !violation,
      foreignKeyViolations: violation ? 1 : 0,
    };
  }

  private generatePublicAccountId(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      let randomPart = "";
      for (let index = 0; index < 8; index += 1) {
        randomPart += alphabet[crypto.randomInt(alphabet.length)]!;
      }
      const candidate = `PP-${randomPart}`;
      const exists = this.database
        .prepare("SELECT 1 FROM accounts WHERE public_account_id = ? LIMIT 1")
        .get(candidate);
      if (!exists) {
        return candidate;
      }
    }

    throw new Error("Unable to generate unique public account ID");
  }

  createAccount(input: {
    id: string;
    email: string;
    passwordHash: string;
    role: AccountRole;
    subscriptionStatus: SubscriptionStatus;
    now: string;
    displayName?: string | null | undefined;
    displayNameKey?: string | null | undefined;
    avatarUrl?: string | null | undefined;
    authProvider?: string | undefined;
    supabaseUserId?: string | null | undefined;
    emailVerifiedAt?: string | null | undefined;
    mfaLevel?: string | undefined;
    mfaVerifiedAt?: string | null | undefined;
    termsAcceptedAt?: string | null | undefined;
    privacyAcceptedAt?: string | null | undefined;
    termsVersion?: string | null | undefined;
    privacyVersion?: string | null | undefined;
  }): BusinessAccount {
    const publicAccountId = this.generatePublicAccountId();
    const create = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO accounts (
            id, public_account_id, email, password_hash, display_name, display_name_key, avatar_url, auth_provider, supabase_user_id,
            email_verified_at, mfa_level, mfa_verified_at, role, subscription_status,
            terms_accepted_at, privacy_accepted_at, terms_version, privacy_version,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          publicAccountId,
          input.email,
          input.passwordHash,
          input.displayName ?? null,
          input.displayNameKey ?? null,
          input.avatarUrl ?? null,
          input.authProvider ?? "local",
          input.supabaseUserId ?? null,
          input.emailVerifiedAt ?? null,
          input.mfaLevel ?? "aal1",
          input.mfaVerifiedAt ?? null,
          input.role,
          input.subscriptionStatus,
          input.termsAcceptedAt ?? null,
          input.privacyAcceptedAt ?? null,
          input.termsVersion ?? null,
          input.privacyVersion ?? null,
          input.now,
          input.now,
        );

      this.upsertProfile({
        id: input.id,
        publicAccountId,
        email: input.email,
        displayName: input.displayName ?? null,
        displayNameKey: input.displayNameKey ?? null,
        username: null,
        avatarUrl: input.avatarUrl ?? null,
        role: input.role,
        accountStatus: "active",
        ageVerificationStatus: "not_started",
        isOver18Verified: false,
        now: input.now,
      });
    });

    create();
    return this.getAccountById(input.id)!;
  }

  upsertProfile(input: {
    id: string;
    publicAccountId?: string | null | undefined;
    email: string | null;
    displayName: string | null;
    displayNameKey?: string | null | undefined;
    username: string | null;
    avatarUrl: string | null;
    role: AccountRole;
    accountStatus: AccountStatus;
    ageVerificationStatus: AgeVerificationStatus;
    isOver18Verified: boolean;
    now: string;
  }): PublicProfile {
    this.database
      .prepare(
        `INSERT INTO profiles (
          id, public_account_id, email, display_name, display_name_key, username, avatar_url, role, account_status,
          age_verification_status, is_over_18_verified, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          public_account_id = COALESCE(excluded.public_account_id, profiles.public_account_id),
          email = excluded.email,
          display_name = excluded.display_name,
          display_name_key = excluded.display_name_key,
          avatar_url = excluded.avatar_url,
          role = excluded.role,
          account_status = excluded.account_status,
          age_verification_status = excluded.age_verification_status,
          is_over_18_verified = excluded.is_over_18_verified,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.publicAccountId ?? null,
        input.email,
        input.displayName,
        input.displayNameKey ?? null,
        input.username,
        input.avatarUrl,
        input.role,
        input.accountStatus,
        input.ageVerificationStatus,
        input.isOver18Verified ? 1 : 0,
        input.now,
        input.now,
      );
    return this.getProfileById(input.id)!;
  }

  getProfileById(id: string): PublicProfile | null {
    const row = this.database.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as ProfileRow | undefined;
    return row ? toProfile(row) : null;
  }

  getAccountByEmail(email: string): BusinessAccount | null {
    const row = this.database
      .prepare("SELECT * FROM accounts WHERE lower(email) = lower(?)")
      .get(email) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  getAccountById(id: string): BusinessAccount | null {
    const row = this.database.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  getAccountBySupabaseUserId(supabaseUserId: string): BusinessAccount | null {
    const row = this.database
      .prepare("SELECT * FROM accounts WHERE supabase_user_id = ? OR id = ? LIMIT 1")
      .get(supabaseUserId, supabaseUserId) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  getAccountByDisplayNameKey(displayNameKey: string): BusinessAccount | null {
    const row = this.database
      .prepare("SELECT * FROM accounts WHERE display_name_key = ? LIMIT 1")
      .get(displayNameKey) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  searchAccountsForAdmin(input: { query: string; limit: number }): AdminAccountSearchResult[] {
    const query = input.query.trim();
    if (query.length < 2) {
      return [];
    }

    const like = `%${query.toLowerCase()}%`;
    const rows = this.database
      .prepare(
        `SELECT id, public_account_id, email, display_name, role, status, email_verified_at, age_confirmed_at, created_at
           FROM accounts
          WHERE lower(email) LIKE ?
             OR lower(COALESCE(display_name, '')) LIKE ?
             OR lower(COALESCE(public_account_id, '')) LIKE ?
             OR lower(id) LIKE ?
          ORDER BY
            CASE
              WHEN lower(email) = lower(?) THEN 0
              WHEN lower(email) LIKE lower(?) THEN 1
              WHEN lower(COALESCE(display_name, '')) LIKE lower(?) THEN 2
              ELSE 3
            END,
            created_at DESC
          LIMIT ?`,
      )
      .all(like, like, like, like, query, `${query}%`, `${query}%`, input.limit) as Array<{
        id: string;
        public_account_id: string;
        email: string;
        display_name: string | null;
        role: AccountRole;
        status: AccountStatus;
        email_verified_at: string | null;
        age_confirmed_at: string | null;
        created_at: string;
      }>;

    return rows.map((row) => ({
      id: row.id,
      publicAccountId: row.public_account_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      emailVerifiedAt: row.email_verified_at,
      ageConfirmedAt: row.age_confirmed_at,
      createdAt: row.created_at,
    }));
  }

  linkSupabaseAccount(input: {
    userId: string;
    supabaseUserId: string;
    email: string;
    authProvider: string;
    displayName: string | null;
    displayNameKey?: string | null | undefined;
    avatarUrl: string | null;
    emailVerifiedAt: string | null;
    mfaLevel: string;
    mfaVerifiedAt: string | null;
    now: string;
  }): BusinessAccount {
    this.database.transaction(() => {
      const previous = this.database
        .prepare("SELECT supabase_user_id FROM accounts WHERE id = ?")
        .get(input.userId) as { supabase_user_id: string | null } | undefined;
      const establishesProviderCredentialBoundary = previous?.supabase_user_id !== input.supabaseUserId;
      this.database
        .prepare(
          `UPDATE accounts
           SET supabase_user_id = ?,
               auth_provider = ?,
               email = ?,
               password_hash = 'supabase-auth',
               display_name = ?,
               display_name_key = ?,
               avatar_url = ?,
               email_verified_at = COALESCE(?, email_verified_at),
               mfa_level = ?,
               mfa_verified_at = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.supabaseUserId,
          input.authProvider,
          input.email,
          input.displayName,
          input.displayNameKey ?? null,
          input.avatarUrl,
          input.emailVerifiedAt,
          input.mfaLevel,
          input.mfaVerifiedAt,
          input.now,
          input.userId,
        );
      if (establishesProviderCredentialBoundary) {
        // A first verified provider link is a credential boundary. Routine
        // logins for the same provider identity must not revoke other devices.
        this.database
          .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
          .run(input.now, input.userId);
        this.database
          .prepare("UPDATE account_discount_passes SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'")
          .run(input.now, input.userId);
      }
      const account = this.getAccountById(input.userId);
      if (account) {
        this.upsertProfile({
          id: account.id,
          publicAccountId: account.publicAccountId,
          email: account.email,
          displayName: input.displayName,
          displayNameKey: input.displayNameKey ?? null,
          username: null,
          avatarUrl: input.avatarUrl,
          role: account.role,
          accountStatus: account.status,
          ageVerificationStatus: account.ageVerificationStatus,
          isOver18Verified: account.isOver18Verified,
          now: input.now,
        });
      }
    })();
    return this.getAccountById(input.userId)!;
  }

  updateAccountDisplayName(input: { userId: string; displayName: string | null; displayNameKey?: string | null | undefined; now: string }): BusinessAccount {
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE accounts
           SET display_name = ?,
               display_name_key = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(input.displayName, input.displayNameKey ?? null, input.now, input.userId);

      const account = this.getAccountById(input.userId);
      if (account) {
        this.upsertProfile({
          id: account.id,
          publicAccountId: account.publicAccountId,
          email: account.email,
          displayName: input.displayName,
          displayNameKey: input.displayNameKey ?? null,
          username: null,
          avatarUrl: account.avatarUrl,
          role: account.role,
          accountStatus: account.status,
          ageVerificationStatus: account.ageVerificationStatus,
          isOver18Verified: account.isOver18Verified,
          now: input.now,
        });
      }
    })();

    return this.getAccountById(input.userId)!;
  }

  getAccountByPublicAccountId(publicAccountId: string): BusinessAccount | null {
    const row = this.database
      .prepare("SELECT * FROM accounts WHERE upper(public_account_id) = upper(?) LIMIT 1")
      .get(publicAccountId) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  updateAccountSecurityClaims(input: {
    userId: string;
    emailVerifiedAt?: string | null | undefined;
    mfaLevel?: string | undefined;
    mfaVerifiedAt?: string | null | undefined;
    now: string;
  }): BusinessAccount {
    this.database
      .prepare(
        `UPDATE accounts
         SET email_verified_at = COALESCE(?, email_verified_at),
             mfa_level = COALESCE(?, mfa_level),
             mfa_verified_at = COALESCE(?, mfa_verified_at),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.emailVerifiedAt ?? null,
        input.mfaLevel ?? null,
        input.mfaVerifiedAt ?? null,
        input.now,
        input.userId,
      );
    return this.getAccountById(input.userId)!;
  }

  getAccountByStripeCustomerId(stripeCustomerId: string): BusinessAccount | null {
    const row = this.database
      .prepare("SELECT * FROM accounts WHERE stripe_customer_id = ?")
      .get(stripeCustomerId) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  listActiveAdminAccounts(excludeUserId?: string): BusinessAccount[] {
    const rows = this.database.prepare(
      `SELECT * FROM accounts
        WHERE status = 'active' AND auth_provider <> 'deleted'
          AND (role = 'admin' OR subscription_status = 'admin')
          AND (? IS NULL OR id <> ?)
        ORDER BY created_at ASC`,
    ).all(excludeUserId ?? null, excludeUserId ?? null) as AccountRow[];
    return rows.map(toAccount);
  }

  hasDeletionLock(userId: string): boolean {
    return Boolean(this.database.prepare(
      `SELECT 1 FROM account_deletion_requests
        WHERE user_id = ? AND status IN ('processing', 'failed', 'completed') LIMIT 1`,
    ).get(userId));
  }

  createSession(input: {
    tokenHash: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
    lastUsedAt?: string | null | undefined;
    lastIpHash?: string | null | undefined;
    userAgentHash?: string | null | undefined;
    providerSessionIdHash?: string | null | undefined;
  }): void {
    this.database
      .prepare(
        `INSERT INTO auth_sessions (
          token_hash, user_id, provider_session_id_hash, created_at, expires_at, last_used_at, last_ip_hash, user_agent_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tokenHash,
        input.userId,
        input.providerSessionIdHash ?? null,
        input.createdAt,
        input.expiresAt,
        input.lastUsedAt ?? input.createdAt,
        input.lastIpHash ?? null,
        input.userAgentHash ?? null,
      );
  }

  getAccountBySessionTokenHash(tokenHash: string, now: string): BusinessAccount | null {
    const row = this.database
      .prepare(
        `SELECT accounts.*
         FROM auth_sessions
         JOIN accounts ON accounts.id = auth_sessions.user_id
         WHERE auth_sessions.token_hash = ?
           AND auth_sessions.expires_at > ?
           AND auth_sessions.revoked_at IS NULL
           AND accounts.status != 'suspended'`,
      )
      .get(tokenHash, now) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  getSessionExpiresAt(tokenHash: string, now: string): string | null {
    const row = this.database
      .prepare(
        `SELECT expires_at
         FROM auth_sessions
         WHERE token_hash = ?
           AND expires_at > ?
           AND revoked_at IS NULL`,
      )
      .get(tokenHash, now) as { expires_at: string } | undefined;
    return row?.expires_at ?? null;
  }

  getActiveProviderSessionExpiresAt(input: {
    tokenHash: string;
    userId: string;
    providerSessionIdHash: string;
    now: string;
  }): string | null {
    const row = this.database.prepare(
      `SELECT expires_at
       FROM auth_sessions
       WHERE token_hash = ?
         AND user_id = ?
         AND provider_session_id_hash = ?
         AND revoked_at IS NULL
         AND expires_at > ?
       LIMIT 1`,
    ).get(input.tokenHash, input.userId, input.providerSessionIdHash, input.now) as { expires_at: string } | undefined;
    return row?.expires_at ?? null;
  }

  getActiveSessionCreatedAt(input: { tokenHash: string; userId: string; now: string }): string | null {
    const row = this.database.prepare(
      `SELECT created_at FROM auth_sessions
        WHERE token_hash = ? AND user_id = ? AND expires_at > ? AND revoked_at IS NULL`,
    ).get(input.tokenHash, input.userId, input.now) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  touchSession(input: {
    tokenHash: string;
    lastUsedAt: string;
    lastIpHash: string | null;
    userAgentHash: string | null;
  }): boolean {
    return this.database
      .prepare(
        `UPDATE auth_sessions
         SET last_used_at = ?, last_ip_hash = ?, user_agent_hash = ?
         WHERE token_hash = ? AND revoked_at IS NULL
           AND (
             last_used_at IS NULL
             OR julianday(last_used_at) <= julianday(?, '-2 minutes')
             OR last_ip_hash IS NOT ?
             OR user_agent_hash IS NOT ?
           )`,
      )
      .run(
        input.lastUsedAt,
        input.lastIpHash,
        input.userAgentHash,
        input.tokenHash,
        input.lastUsedAt,
        input.lastIpHash,
        input.userAgentHash,
      ).changes === 1;
  }

  revokeSession(input: { tokenHash: string; revokedAt: string }): boolean {
    return this.database.transaction(() => {
      const session = this.database.prepare(
        "SELECT user_id, provider_session_id_hash FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL",
      ).get(input.tokenHash) as { user_id: string; provider_session_id_hash: string | null } | undefined;
      if (!session) return false;
      const result = session.provider_session_id_hash
        ? this.database.prepare(
            `UPDATE auth_sessions SET revoked_at = ?
             WHERE user_id = ? AND provider_session_id_hash = ? AND revoked_at IS NULL`,
          ).run(input.revokedAt, session.user_id, session.provider_session_id_hash)
        : this.database
            .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
            .run(input.revokedAt, input.tokenHash);
      if (session.provider_session_id_hash) {
        this.revokeProviderSession({
          userId: session.user_id,
          providerSessionIdHash: session.provider_session_id_hash,
          revokedAt: input.revokedAt,
          reason: "app_session_revoked",
        });
        this.database.prepare(
          `UPDATE account_discount_passes SET status = 'revoked', revoked_at = ?
           WHERE status = 'active' AND session_token_hash IN (
             SELECT token_hash FROM auth_sessions WHERE user_id = ? AND provider_session_id_hash = ?
           )`,
        ).run(input.revokedAt, session.user_id, session.provider_session_id_hash);
      }
      return result.changes > 0;
    })();
  }

  revokeUserSessions(input: { userId: string; revokedAt: string }): number {
    return this.database.transaction(() => {
      this.database.prepare(
        `INSERT OR IGNORE INTO revoked_provider_sessions (user_id, provider_session_id_hash, revoked_at, reason)
         SELECT user_id, provider_session_id_hash, ?, 'all_app_sessions_revoked'
         FROM auth_sessions
         WHERE user_id = ? AND provider_session_id_hash IS NOT NULL`,
      ).run(input.revokedAt, input.userId);
      const result = this.database
        .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(input.revokedAt, input.userId);
      return result.changes;
    })();
  }

  completePasswordResetContainment(input: {
    userId: string;
    providerSessionIdHash: string;
    providerTokensValidAfter: string;
    revokedAt: string;
  }): { revokedSessions: number; revokedDiscountPasses: number; cancelledRewardCodes: number } {
    return this.database.transaction(() => {
      this.database.prepare(
        `INSERT OR IGNORE INTO revoked_provider_sessions (user_id, provider_session_id_hash, revoked_at, reason)
         SELECT user_id, provider_session_id_hash, ?, 'password_reset_completed'
         FROM auth_sessions
         WHERE user_id = ? AND provider_session_id_hash IS NOT NULL`,
      ).run(input.revokedAt, input.userId);
      this.database.prepare(
        `INSERT INTO revoked_provider_sessions (user_id, provider_session_id_hash, revoked_at, reason)
         VALUES (?, ?, ?, 'password_reset_completed')
         ON CONFLICT(user_id, provider_session_id_hash) DO UPDATE SET
           revoked_at = excluded.revoked_at,
           reason = excluded.reason`,
      ).run(input.userId, input.providerSessionIdHash, input.revokedAt);
      const revokedSessions = this.database
        .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(input.revokedAt, input.userId).changes;
      const revokedDiscountPasses = this.database
        .prepare(
          `UPDATE account_discount_passes
           SET status = 'revoked', revoked_at = ?
           WHERE user_id = ? AND status = 'active'`,
        )
        .run(input.revokedAt, input.userId).changes;
      const cancelledRewardCodes = this.database
        .prepare(
          `UPDATE free_pint_reward_codes
           SET status = 'cancelled', cancelled_at = ?
           WHERE user_id = ? AND status = 'active'`,
        )
        .run(input.revokedAt, input.userId).changes;
      this.database.prepare(
        `UPDATE accounts
         SET provider_tokens_valid_after = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.providerTokensValidAfter, input.revokedAt, input.userId);
      return { revokedSessions, revokedDiscountPasses, cancelledRewardCodes };
    })();
  }

  revokeProviderSession(input: {
    userId: string;
    providerSessionIdHash: string;
    revokedAt: string;
    reason: string;
  }): void {
    this.database.prepare(
      `INSERT INTO revoked_provider_sessions (user_id, provider_session_id_hash, revoked_at, reason)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, provider_session_id_hash) DO UPDATE SET
         revoked_at = excluded.revoked_at,
         reason = excluded.reason`,
    ).run(input.userId, input.providerSessionIdHash, input.revokedAt, input.reason);
  }

  isProviderSessionRevoked(input: { userId: string; providerSessionIdHash: string }): boolean {
    return Boolean(this.database.prepare(
      "SELECT 1 FROM revoked_provider_sessions WHERE user_id = ? AND provider_session_id_hash = ? LIMIT 1",
    ).get(input.userId, input.providerSessionIdHash));
  }

  listUserSessions(input: { userId: string; now: string; limit?: number; offset?: number }): AccountSession[] {
    const limit = Math.min(200, Math.max(1, input.limit ?? 100));
    const rows = this.database
      .prepare(
        `SELECT token_hash, user_id, provider_session_id_hash, created_at, expires_at, revoked_at,
                last_used_at, last_ip_hash, user_agent_hash
         FROM auth_sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
         ORDER BY COALESCE(last_used_at, created_at) DESC
         LIMIT ? OFFSET ?`,
      )
      .all(input.userId, input.now, limit, Math.max(0, input.offset ?? 0)) as Array<{
        token_hash: string;
        user_id: string;
        created_at: string;
        expires_at: string;
        revoked_at: string | null;
        last_used_at: string | null;
        last_ip_hash: string | null;
        user_agent_hash: string | null;
        provider_session_id_hash: string | null;
      }>;
    return rows.map((row) => ({
      id: row.token_hash.slice(0, 24),
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      lastUsedAt: row.last_used_at,
      lastIpHash: row.last_ip_hash,
      userAgentHash: row.user_agent_hash,
      providerBacked: Boolean(row.provider_session_id_hash),
    }));
  }

  listUserSessionHistory(input: { userId: string; now: string; limit?: number; offset?: number }): AccountSession[] {
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const rows = this.database.prepare(
      `SELECT token_hash, user_id, provider_session_id_hash, created_at, expires_at, revoked_at,
              last_used_at, last_ip_hash, user_agent_hash
         FROM auth_sessions
        WHERE user_id = ? AND (revoked_at IS NOT NULL OR expires_at <= ?)
        ORDER BY COALESCE(revoked_at, expires_at) DESC
        LIMIT ? OFFSET ?`,
    ).all(input.userId, input.now, limit, Math.max(0, input.offset ?? 0)) as Array<{
      token_hash: string; user_id: string; provider_session_id_hash: string | null;
      created_at: string; expires_at: string; revoked_at: string | null; last_used_at: string | null;
      last_ip_hash: string | null; user_agent_hash: string | null;
    }>;
    return rows.map((row) => ({
      id: row.token_hash.slice(0, 24), userId: row.user_id, createdAt: row.created_at,
      expiresAt: row.expires_at, revokedAt: row.revoked_at, lastUsedAt: row.last_used_at,
      lastIpHash: row.last_ip_hash, userAgentHash: row.user_agent_hash,
      providerBacked: Boolean(row.provider_session_id_hash),
    }));
  }

  countUserSessionHistory(userId: string, now: string): number {
    const row = this.database.prepare(
      "SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND (revoked_at IS NOT NULL OR expires_at <= ?)",
    ).get(userId, now) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countUserSessions(userId: string, now: string): number {
    const row = this.database.prepare(
      "SELECT count(*) AS count FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?",
    ).get(userId, now) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  prunePrivacyRetention(input: {
    authSessionCutoff: string;
    providerRevocationCutoff: string;
    stripePayloadCutoff: string;
    stripeEnvelopeCutoff: string;
    securityFingerprintCutoff: string;
    securityEnvelopeCutoff: string;
    reviewedLocationCutoff: string;
    migrationQuarantineCutoff: string;
  }): {
    authSessionsDeleted: number;
    providerRevocationsDeleted: number;
    stripePayloadsRedacted: number;
    stripeEnvelopesDeleted: number;
    securityFingerprintsRedacted: number;
    securityEnvelopesDeleted: number;
    reviewedLocationsPurged: number;
    migrationQuarantinePayloadsRedacted: number;
  } {
    return this.database.transaction(() => {
      const authSessionsDeleted = this.database.prepare(
        `DELETE FROM auth_sessions
          WHERE (revoked_at IS NOT NULL AND revoked_at <= ?)
             OR expires_at <= ?`,
      ).run(input.authSessionCutoff, input.authSessionCutoff).changes;
      const providerRevocationsDeleted = this.database.prepare(
        `DELETE FROM revoked_provider_sessions
          WHERE revoked_at <= ?
            AND reason IN ('password_reset_completed', 'all_app_sessions_revoked')`,
      ).run(input.providerRevocationCutoff).changes;
      const stripePayloadsRedacted = this.database.prepare(
        `UPDATE stripe_webhook_events SET payload_json = NULL, last_error = NULL
          WHERE received_at <= ? AND status = 'applied' AND payload_json IS NOT NULL`,
      ).run(input.stripePayloadCutoff).changes;
      const stripeEnvelopesDeleted = this.database.prepare(
        "DELETE FROM stripe_webhook_events WHERE received_at <= ?",
      ).run(input.stripeEnvelopeCutoff).changes;
      const securityFingerprintsRedacted = this.database.prepare(
        `UPDATE security_audit_log SET ip_hash = NULL, user_agent_hash = NULL
          WHERE created_at <= ? AND (ip_hash IS NOT NULL OR user_agent_hash IS NOT NULL)`,
      ).run(input.securityFingerprintCutoff).changes;
      const securityEnvelopesDeleted = this.database.prepare(
        "DELETE FROM security_audit_log WHERE created_at <= ?",
      ).run(input.securityEnvelopeCutoff).changes;
      const reviewedLocationsPurged = this.database.prepare(
        `UPDATE submissions
            SET upload_latitude = NULL, upload_longitude = NULL, upload_accuracy_meters = NULL,
                upload_location_captured_at = NULL
          WHERE reviewed_at IS NOT NULL AND reviewed_at <= ?
            AND status NOT IN ('pending', 'needs_more_evidence', 'disputed')
            AND (upload_latitude IS NOT NULL OR upload_longitude IS NOT NULL
              OR upload_accuracy_meters IS NOT NULL OR upload_location_captured_at IS NOT NULL)`,
      ).run(input.reviewedLocationCutoff).changes;
      const migrationQuarantinePayloadsRedacted = this.database.prepare(
        `UPDATE migration_quarantined_records
            SET payload_json = '{"redactedAfterRetention":true}'
          WHERE quarantined_at <= ? AND payload_json <> '{"redactedAfterRetention":true}'`,
      ).run(input.migrationQuarantineCutoff).changes;
      return {
        authSessionsDeleted,
        providerRevocationsDeleted,
        stripePayloadsRedacted,
        stripeEnvelopesDeleted,
        securityFingerprintsRedacted,
        securityEnvelopesDeleted,
        reviewedLocationsPurged,
        migrationQuarantinePayloadsRedacted,
      };
    })();
  }

  revokeUserSessionById(input: { userId: string; sessionId: string; revokedAt: string }): {
    revoked: boolean;
    revokedDiscountPasses: number;
  } {
    return this.database.transaction(() => {
      const session = this.database
        .prepare(
          `SELECT token_hash, provider_session_id_hash
           FROM auth_sessions
           WHERE user_id = ? AND substr(token_hash, 1, 24) = ?
           LIMIT 1`,
        )
        .get(input.userId, input.sessionId) as { token_hash: string; provider_session_id_hash: string | null } | undefined;
      if (!session) {
        return { revoked: false, revokedDiscountPasses: 0 };
      }
      const result = session.provider_session_id_hash
        ? this.database.prepare(
            `UPDATE auth_sessions SET revoked_at = ?
             WHERE user_id = ? AND provider_session_id_hash = ? AND revoked_at IS NULL`,
          ).run(input.revokedAt, input.userId, session.provider_session_id_hash)
        : this.database.prepare(
            `UPDATE auth_sessions SET revoked_at = ?
             WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL`,
          ).run(input.revokedAt, session.token_hash, input.userId);
      const passes = session.provider_session_id_hash
        ? this.database.prepare(
            `UPDATE account_discount_passes SET status = 'revoked', revoked_at = ?
             WHERE status = 'active' AND session_token_hash IN (
               SELECT token_hash FROM auth_sessions WHERE user_id = ? AND provider_session_id_hash = ?
             )`,
          ).run(input.revokedAt, input.userId, session.provider_session_id_hash)
        : this.database.prepare(
            `UPDATE account_discount_passes SET status = 'revoked', revoked_at = ?
             WHERE session_token_hash = ? AND status = 'active'`,
          ).run(input.revokedAt, session.token_hash);
      if (result.changes > 0 && session.provider_session_id_hash) {
        this.revokeProviderSession({
          userId: input.userId,
          providerSessionIdHash: session.provider_session_id_hash,
          revokedAt: input.revokedAt,
          reason: "app_session_revoked",
        });
      }
      return { revoked: result.changes > 0, revokedDiscountPasses: passes.changes };
    })();
  }

  updateAgeConfirmed(userId: string, confirmedAt: string): BusinessAccount {
    this.database.transaction(() => {
      this.database
        .prepare("UPDATE accounts SET age_confirmed_at = ?, updated_at = ? WHERE id = ?")
        .run(confirmedAt, confirmedAt, userId);
      this.database
        .prepare("UPDATE profiles SET updated_at = ? WHERE id = ?")
        .run(confirmedAt, userId);
    })();
    return this.getAccountById(userId)!;
  }

  updateLegalAcceptance(input: {
    userId: string;
    acceptedAt: string;
    termsVersion: string;
    privacyVersion: string;
  }): BusinessAccount {
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE accounts
           SET terms_accepted_at = ?,
               privacy_accepted_at = ?,
               terms_version = ?,
               privacy_version = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.acceptedAt,
          input.acceptedAt,
          input.termsVersion,
          input.privacyVersion,
          input.acceptedAt,
          input.userId,
        );
      this.database
        .prepare("UPDATE profiles SET updated_at = ? WHERE id = ?")
        .run(input.acceptedAt, input.userId);
    })();
    return this.getAccountById(input.userId)!;
  }

  upsertAgeVerification(input: {
    id: string;
    userId: string;
    status: AgeVerificationStatus;
    ageThreshold: number;
    isOver18: boolean;
    providerName: string | null;
    providerReferenceId: string | null;
    checkedAt: string | null;
    expiresAt: string | null;
    now: string;
  }): AgeVerification {
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO age_verifications (
            id, user_id, status, age_threshold, is_over_18, provider_name,
            provider_reference_id, checked_at, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            age_threshold = excluded.age_threshold,
            is_over_18 = excluded.is_over_18,
            provider_name = excluded.provider_name,
            provider_reference_id = excluded.provider_reference_id,
            checked_at = excluded.checked_at,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.id,
          input.userId,
          input.status,
          input.ageThreshold,
          input.isOver18 ? 1 : 0,
          input.providerName,
          input.providerReferenceId,
          input.checkedAt,
          input.expiresAt,
          input.now,
          input.now,
        );

      this.database
        .prepare(
          `UPDATE accounts
           SET age_verification_status = ?, is_over_18_verified = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.status, input.status === "verified" && input.isOver18 ? 1 : 0, input.now, input.userId);

      this.database
        .prepare(
          `UPDATE profiles
           SET age_verification_status = ?, is_over_18_verified = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.status, input.status === "verified" && input.isOver18 ? 1 : 0, input.now, input.userId);
    })();

    return this.getAgeVerificationById(input.id)!;
  }

  getAgeVerificationById(id: string): AgeVerification | null {
    const row = this.database.prepare("SELECT * FROM age_verifications WHERE id = ?").get(id) as
      | AgeVerificationRow
      | undefined;
    return row ? toAgeVerification(row) : null;
  }

  getLatestAgeVerification(userId: string): AgeVerification | null {
    const row = this.database
      .prepare("SELECT * FROM age_verifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(userId) as AgeVerificationRow | undefined;
    return row ? toAgeVerification(row) : null;
  }

  updateSubscription(input: {
    userId: string;
    subscriptionStatus: SubscriptionStatus;
    stripePaidSubscriptionStatus?: PaidSubscriptionStatus | null;
    stripeCustomerId?: string | null;
    premiumUntil?: string | null;
    now: string;
    stripeEventCreatedAt?: string | null;
  }): BusinessAccount {
    this.database
      .prepare(
        `UPDATE accounts
         SET subscription_status = ?,
             stripe_paid_subscription_status = COALESCE(?, stripe_paid_subscription_status),
             stripe_customer_id = COALESCE(?, stripe_customer_id),
             premium_until = ?,
             stripe_event_created_at = COALESCE(?, stripe_event_created_at),
             updated_at = ?
         WHERE id = ?
           AND auth_provider <> 'deleted'
           AND NOT EXISTS (
             SELECT 1 FROM account_deletion_requests deletion
             WHERE deletion.user_id = accounts.id
               AND deletion.status IN ('processing', 'failed', 'completed')
           )
           AND (? IS NULL OR stripe_event_created_at IS NULL OR stripe_event_created_at <= ?)`,
      )
      .run(
        input.subscriptionStatus,
        input.stripePaidSubscriptionStatus ?? null,
        input.stripeCustomerId ?? null,
        input.premiumUntil ?? null,
        input.stripeEventCreatedAt ?? null,
        input.now,
        input.userId,
        input.stripeEventCreatedAt ?? null,
        input.stripeEventCreatedAt ?? null,
      );
    return this.getAccountById(input.userId)!;
  }

  overrideUserStatus(input: {
    userId: string;
    status: AccountStatus;
    trustScore?: number | undefined;
    fraudStrikeCount?: number | undefined;
    now: string;
  }): BusinessAccount {
    const account = this.getAccountById(input.userId);
    if (!account) {
      throw new Error("Account not found");
    }

    this.database
      .prepare(
        `UPDATE accounts
         SET status = ?,
             trust_score = ?,
             fraud_strike_count = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.trustScore ?? account.trustScore,
        input.fraudStrikeCount ?? account.fraudStrikeCount,
        input.now,
        input.userId,
      );
    this.database
      .prepare("UPDATE profiles SET account_status = ?, updated_at = ? WHERE id = ?")
      .run(input.status, input.now, input.userId);
    return this.getAccountById(input.userId)!;
  }

  createSubmission(input: {
    id: string;
    clientSubmissionId: string | null;
    missionId?: string | null;
    missionAcceptedAfter?: string | undefined;
    userId: string;
    venueId: string;
    venueName: string;
    suburb: string | null;
    submissionType: SubmissionType;
    observedAt: string;
    sourcePhotoUrl: string | null;
    sourceEvidenceIds?: string[];
    ocrStatus?: SubmissionOcrStatus;
    ocrSummary?: SubmissionOcrSummary | null;
    notes: string | null;
    uploadLatitude?: number | null;
    uploadLongitude?: number | null;
    uploadAccuracyMeters?: number | null;
    uploadLocationCapturedAt?: string | null;
    distanceToVenueMeters?: number | null;
    pointsEligibleByLocation?: boolean;
    pointsEligibilityReason?: string | null;
    pendingVenue?: PendingVenueDetails | null;
    items: Array<{
      id: string;
      beerName: string;
      normalizedBeerId: string | null;
      servingSize: ServingSize;
      price: number | null;
      isHappyHourPrice: boolean;
      happyHourDetails: string | null;
      isOnTap: TapStatus;
      confidence: number;
      captureSource?: SubmissionItemCaptureSource;
      sourceText?: string | null;
      requiresCatalogApproval?: boolean;
    }>;
    now: string;
  }): BusinessSubmission {
    const create = this.database.transaction(() => {
      if (input.missionId) {
        if (!input.missionAcceptedAfter) {
          throw new MissionReservationError();
        }
        const reservation = this.database
          .prepare(
            `SELECT progress.id
             FROM mission_progress progress
             INNER JOIN missions mission ON mission.id = progress.mission_id
             WHERE progress.mission_id = ?
               AND progress.user_id = ?
               AND progress.status = 'accepted'
               AND mission.active = 1
               AND julianday(progress.accepted_at) > julianday(?)
             LIMIT 1`,
          )
          .get(input.missionId, input.userId, input.missionAcceptedAfter) as { id: string } | undefined;
        if (!reservation) {
          throw new MissionReservationError("This mission reservation expired or belongs to another contributor.");
        }
      }

      this.database
        .prepare(
          `INSERT INTO submissions (
          id, client_submission_id, mission_id, user_id, venue_id, venue_name, suburb, status, submission_type, observed_at,
          source_photo_url, ocr_status, ocr_summary_json, notes, upload_latitude, upload_longitude, upload_accuracy_meters,
          upload_location_captured_at, distance_to_venue_meters, points_eligible_by_location,
          points_eligibility_reason, pending_venue_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.clientSubmissionId,
          input.missionId ?? null,
          input.userId,
          input.venueId,
          input.venueName,
          input.suburb,
          input.submissionType,
          input.observedAt,
          input.sourcePhotoUrl,
          input.ocrStatus ?? "not_requested",
          input.ocrSummary ? JSON.stringify(input.ocrSummary) : null,
          input.notes,
          input.uploadLatitude ?? null,
          input.uploadLongitude ?? null,
          input.uploadAccuracyMeters ?? null,
          input.uploadLocationCapturedAt ?? null,
          input.distanceToVenueMeters ?? null,
          input.pointsEligibleByLocation ? 1 : 0,
          input.pointsEligibilityReason ?? null,
          input.pendingVenue ? JSON.stringify(input.pendingVenue) : null,
          input.now,
          input.now,
        );

      if (input.missionId) {
        const progressUpdate = this.database
          .prepare(
            `UPDATE mission_progress
             SET submission_id = ?,
                 status = 'submitted',
                 submitted_at = ?,
                 completed_at = NULL,
                 updated_at = ?
             WHERE mission_id = ?
               AND user_id = ?
               AND status = 'accepted'
               AND julianday(accepted_at) > julianday(?)`,
          )
          .run(
            input.id,
            input.now,
            input.now,
            input.missionId,
            input.userId,
            input.missionAcceptedAfter,
          );
        if (progressUpdate.changes !== 1) {
          throw new MissionReservationError("This mission reservation is no longer available.");
        }
      }

      const insertItem = this.database.prepare(
        `INSERT INTO submission_items (
          id, submission_id, beer_name, normalized_beer_id, serving_size, price,
          is_happy_hour_price, happy_hour_details, is_on_tap, confidence, capture_source,
          source_text, requires_catalog_approval, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const item of input.items) {
        insertItem.run(
          item.id,
          input.id,
          item.beerName,
          item.normalizedBeerId,
          item.servingSize,
          item.price,
          item.isHappyHourPrice ? 1 : 0,
          item.happyHourDetails,
          item.isOnTap,
          item.confidence,
          item.captureSource ?? "manual",
          item.sourceText ?? null,
          item.requiresCatalogApproval ? 1 : 0,
          input.now,
        );
      }

      const linkEvidence = this.database.prepare(
        `INSERT INTO submission_source_evidence (submission_id, evidence_id, sort_order, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(submission_id, evidence_id) DO NOTHING`,
      );
      for (const [sortOrder, evidenceId] of (input.sourceEvidenceIds ?? []).entries()) {
        linkEvidence.run(input.id, evidenceId, sortOrder, input.now);
      }
    });

    create.immediate();
    return this.getSubmissionById(input.id)!.submission;
  }

  createVerification(input: {
    id: string;
    verifierUserId: string;
    uploadId: string;
    targetEntityType: string;
    targetEntityId: string;
    result: string;
    notes: string | null;
    now: string;
  }): UserVerification {
    const submission = this.getSubmissionById(input.uploadId);
    if (!submission) {
      throw new Error("Submission not found");
    }

    if (submission.submission.userId === input.verifierUserId) {
      throw new Error("Users cannot verify their own uploads");
    }

    this.database
      .prepare(
        `INSERT INTO verifications (
          id, verifier_user_id, upload_id, target_entity_type, target_entity_id, result, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.verifierUserId,
        input.uploadId,
        input.targetEntityType,
        input.targetEntityId,
        input.result,
        input.notes,
        input.now,
      );

    return this.getVerificationById(input.id)!;
  }

  getVerificationById(id: string): UserVerification | null {
    const row = this.database.prepare("SELECT * FROM verifications WHERE id = ?").get(id) as
      | VerificationRow
      | undefined;
    return row ? toVerification(row) : null;
  }

  getVerificationByUserAndUpload(input: { verifierUserId: string; uploadId: string }): UserVerification | null {
    const row = this.database
      .prepare("SELECT * FROM verifications WHERE verifier_user_id = ? AND upload_id = ? LIMIT 1")
      .get(input.verifierUserId, input.uploadId) as VerificationRow | undefined;
    return row ? toVerification(row) : null;
  }

  countConfirmedVerificationsForSubmission(uploadId: string): number {
    const row = this.database
      .prepare(
        `SELECT count(DISTINCT verifier_user_id) AS count
         FROM verifications
         WHERE upload_id = ? AND result = 'confirmed'`,
      )
      .get(uploadId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  listVerificationsForUser(userId: string, limit: number): UserVerification[] {
    const rows = this.database
      .prepare("SELECT * FROM verifications WHERE verifier_user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit) as VerificationRow[];
    return rows.map(toVerification);
  }

  createUserActivityEvent(input: {
    id: string;
    userId: string;
    eventType: string;
    relatedEntityType: string | null;
    relatedEntityId: string | null;
    metadata: Record<string, unknown>;
    now: string;
  }): UserActivityEvent {
    this.database
      .prepare(
        `INSERT INTO user_activity_events (
          id, user_id, event_type, related_entity_type, related_entity_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.eventType,
        input.relatedEntityType,
        input.relatedEntityId,
        JSON.stringify(redactSecrets(input.metadata)),
        input.now,
      );
    return this.getUserActivityEventById(input.id)!;
  }

  getUserActivityEventById(id: string): UserActivityEvent | null {
    const row = this.database.prepare("SELECT * FROM user_activity_events WHERE id = ?").get(id) as
      | UserActivityEventRow
      | undefined;
    return row ? toUserActivityEvent(row) : null;
  }

  listUserActivityEvents(userId: string, limit: number): UserActivityEvent[] {
    const rows = this.database
      .prepare("SELECT * FROM user_activity_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit) as UserActivityEventRow[];
    return rows.map(toUserActivityEvent);
  }

  listLeaderboard(input: { period: "month" | "all_time"; limit: number; now: string; monthKey?: string | undefined }): LeaderboardEntry[] {
    const values: unknown[] = [];
    const monthFilter = input.period === "month" ? "AND ledger.month_key = ?" : "";

    if (input.period === "month") {
      values.push(input.monthKey ?? input.now.slice(0, 7));
    }

    values.push(input.limit);

    const rows = this.database
      .prepare(
        `SELECT
           a.id AS user_id,
           COALESCE(a.public_account_id, a.id) AS account_id,
           COALESCE(NULLIF(a.display_name, ''), NULLIF(p.display_name, ''), COALESCE(a.public_account_id, a.id)) AS display_name,
           (
             ${input.period === "month"
               ? `SELECT count(DISTINCT counted.submission_id)
                    FROM contribution_ledger counted
                   WHERE counted.user_id = a.id
                     AND counted.month_key = ledger.month_key
                     AND counted.submission_id IS NOT NULL`
               : `SELECT count(*)
                    FROM submissions submission
                   WHERE submission.user_id = a.id
                     AND submission.status = 'approved'
                     AND COALESCE(submission.fraud_flagged, 0) = 0`}
           ) AS approved_submissions,
           COALESCE(sum(ledger.points), 0) AS points,
           min(ledger.created_at) AS first_points_at
         FROM contribution_ledger ledger
         JOIN accounts a ON a.id = ledger.user_id
         LEFT JOIN profiles p ON p.id = a.id
         WHERE a.status = 'active'
           AND a.role = 'user'
           AND a.subscription_status <> 'admin'
           AND NOT EXISTS (
             SELECT 1 FROM venue_manager_assignments assignment
             WHERE assignment.user_id = a.id AND assignment.status = 'active'
           )
           ${monthFilter}
         GROUP BY a.id
         HAVING COALESCE(sum(ledger.points), 0) > 0
         ORDER BY points DESC, approved_submissions DESC, first_points_at ASC, account_id ASC
         LIMIT ?`,
      )
      .all(...values) as Array<{
        user_id: string;
        account_id: string;
        display_name: string;
        approved_submissions: number;
        points: number;
      }>;

    return rows.map((row, index) => ({
      rank: index + 1,
      accountId: row.account_id,
      displayName: row.display_name,
      approvedSubmissions: Number(row.approved_submissions ?? 0),
      points: Number(row.points ?? 0),
    }));
  }

  getLeaderboardRank(input: { userId: string; period: "month" | "all_time"; now: string; monthKey?: string | undefined }): LeaderboardEntry | null {
    const values: unknown[] = [];
    const monthFilter = input.period === "month" ? "AND ledger.month_key = ?" : "";
    if (input.period === "month") {
      values.push(input.monthKey ?? input.now.slice(0, 7));
    }
    values.push(input.userId);

    const row = this.database
      .prepare(
        `WITH leaderboard AS (
           SELECT
             a.id AS user_id,
             COALESCE(a.public_account_id, a.id) AS account_id,
             COALESCE(NULLIF(a.display_name, ''), NULLIF(p.display_name, ''), COALESCE(a.public_account_id, a.id)) AS display_name,
             (
               ${input.period === "month"
                 ? `SELECT count(DISTINCT counted.submission_id)
                      FROM contribution_ledger counted
                     WHERE counted.user_id = a.id
                       AND counted.month_key = ledger.month_key
                       AND counted.submission_id IS NOT NULL`
                 : `SELECT count(*)
                      FROM submissions submission
                     WHERE submission.user_id = a.id
                       AND submission.status = 'approved'
                       AND COALESCE(submission.fraud_flagged, 0) = 0`}
             ) AS approved_submissions,
             COALESCE(sum(ledger.points), 0) AS points,
             min(ledger.created_at) AS first_points_at
           FROM contribution_ledger ledger
           JOIN accounts a ON a.id = ledger.user_id
           LEFT JOIN profiles p ON p.id = a.id
           WHERE a.status = 'active'
             AND a.role = 'user'
             AND a.subscription_status <> 'admin'
             AND NOT EXISTS (
               SELECT 1 FROM venue_manager_assignments assignment
               WHERE assignment.user_id = a.id AND assignment.status = 'active'
             )
             ${monthFilter}
           GROUP BY a.id
           HAVING COALESCE(sum(ledger.points), 0) > 0
         ), ranked AS (
           SELECT leaderboard.*,
                  row_number() OVER (
                    ORDER BY points DESC, approved_submissions DESC, first_points_at ASC, account_id ASC
                  ) AS rank
           FROM leaderboard
         )
         SELECT rank, account_id, display_name, approved_submissions, points
         FROM ranked
         WHERE user_id = ?
         LIMIT 1`,
      )
      .get(...values) as {
        rank: number;
        account_id: string;
        display_name: string;
        approved_submissions: number;
        points: number;
      } | undefined;

    return row
      ? {
          rank: Number(row.rank),
          accountId: row.account_id,
          displayName: row.display_name,
          approvedSubmissions: Number(row.approved_submissions ?? 0),
          points: Number(row.points ?? 0),
        }
      : null;
  }

  getLeaderboardPrizeCampaign(monthKey: string): LeaderboardPrizeCampaign | null {
    const row = this.database
      .prepare("SELECT * FROM leaderboard_prize_campaigns WHERE month_key = ?")
      .get(monthKey) as LeaderboardPrizeCampaignRow | undefined;
    return row ? toLeaderboardPrizeCampaign(row) : null;
  }

  upsertLeaderboardPrizeCampaign(input: {
    monthKey: string;
    title: string;
    startsAt: string;
    endsAt: string;
    firstPlaceCents: number;
    secondPlaceCents: number;
    thirdPlaceCents: number;
    affiliateBar: string | null;
    terms: string | null;
    now: string;
  }): LeaderboardPrizeCampaign {
    this.database
      .prepare(
        `INSERT INTO leaderboard_prize_campaigns (
          month_key, title, starts_at, ends_at, first_place_cents, second_place_cents,
          third_place_cents, affiliate_bar, terms, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(month_key) DO UPDATE SET
          title = excluded.title,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          first_place_cents = excluded.first_place_cents,
          second_place_cents = excluded.second_place_cents,
          third_place_cents = excluded.third_place_cents,
          affiliate_bar = excluded.affiliate_bar,
          terms = excluded.terms,
          status = CASE
            WHEN leaderboard_prize_campaigns.status = 'finalized' THEN leaderboard_prize_campaigns.status
            ELSE 'active'
          END,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.monthKey,
        input.title,
        input.startsAt,
        input.endsAt,
        input.firstPlaceCents,
        input.secondPlaceCents,
        input.thirdPlaceCents,
        input.affiliateBar,
        input.terms,
        input.now,
        input.now,
      );
    return this.getLeaderboardPrizeCampaign(input.monthKey)!;
  }

  listLeaderboardPrizeAwards(monthKey: string): LeaderboardPrizeAward[] {
    const rows = this.database
      .prepare("SELECT * FROM leaderboard_prize_awards WHERE month_key = ? ORDER BY rank ASC")
      .all(monthKey) as LeaderboardPrizeAwardRow[];
    return rows.map(toLeaderboardPrizeAward);
  }

  listAccountRewardVouchers(userId: string, limit: number): AccountRewardVoucher[] {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `UPDATE account_reward_vouchers
            SET status = 'expired', updated_at = ?
          WHERE user_id = ?
            AND status = 'active'
            AND expires_at IS NOT NULL
            AND expires_at <= ?`,
      )
      .run(now, userId, now);
    const rows = this.database
      .prepare("SELECT * FROM account_reward_vouchers WHERE user_id = ? ORDER BY issued_at DESC LIMIT ?")
      .all(userId, limit) as AccountRewardVoucherRow[];
    return rows.map(toAccountRewardVoucher);
  }

  finalizeLeaderboardPrizeCampaign(input: {
    campaign: LeaderboardPrizeCampaign;
    entries: LeaderboardEntry[];
    finalizedBy: string;
    now: string;
  }): { campaign: LeaderboardPrizeCampaign; awards: LeaderboardPrizeAward[]; vouchers: AccountRewardVoucher[] } {
    const finalize = this.database.transaction(() => {
      const campaign = this.getLeaderboardPrizeCampaign(input.campaign.monthKey);
      if (!campaign) {
        throw new Error("Leaderboard prize campaign not found");
      }

      const amountsByRank = new Map([
        [1, campaign.firstPlaceCents],
        [2, campaign.secondPlaceCents],
        [3, campaign.thirdPlaceCents],
      ]);
      const vouchers: AccountRewardVoucher[] = [];
      const insertVoucher = this.database.prepare(
        `INSERT OR IGNORE INTO account_reward_vouchers (
          id, user_id, public_account_id, source_type, source_id, title, amount_cents,
          currency, venue_scope, status, issued_at, expires_at, redeemed_at,
          metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'AUD', ?, 'active', ?, ?, NULL, ?, ?, ?)`,
      );
      const insertAward = this.database.prepare(
        `INSERT OR IGNORE INTO leaderboard_prize_awards (
          id, month_key, rank, user_id, public_account_id, display_name,
          points, approved_submissions, voucher_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const eligibleEntries = input.entries.flatMap((entry) => {
        const account = this.getAccountByPublicAccountId(entry.accountId);
        const hasStaffAssignment = account
          ? Boolean(this.database.prepare(
              "SELECT 1 FROM venue_manager_assignments WHERE user_id = ? AND status = 'active' LIMIT 1",
            ).get(account.id))
          : false;
        if (
          !account || account.status !== "active" || account.role !== "user" ||
          account.subscriptionStatus === "admin" || hasStaffAssignment
        ) {
          return [];
        }
        return [{ account, entry }];
      }).slice(0, 3);

      for (const [index, candidate] of eligibleEntries.entries()) {
        const { account, entry } = candidate;
        const rank = index + 1;
        const amountCents = amountsByRank.get(rank) ?? 0;
        if (amountCents <= 0) {
          continue;
        }
        const voucherId = `${campaign.monthKey}:${rank}:${account.id}:voucher`;
        const awardId = `${campaign.monthKey}:${rank}:${account.id}`;
        const title = `${campaign.title} ${rank === 1 ? "winner" : `place ${rank}`}`;
        const expiresAt = new Date(new Date(input.now).getTime() + (90 * 24 * 60 * 60 * 1_000)).toISOString();
        const claimReference = `PP-${campaign.monthKey.replace("-", "")}-${crypto
          .createHash("sha256")
          .update(voucherId)
          .digest("hex")
          .slice(0, 8)
          .toUpperCase()}`;
        insertVoucher.run(
          voucherId,
          account.id,
          account.publicAccountId,
          "leaderboard_prize",
          `${campaign.monthKey}:${entry.rank}`,
          title,
          amountCents,
          campaign.affiliateBar,
          input.now,
          expiresAt,
          JSON.stringify({
            monthKey: campaign.monthKey,
            rank,
            points: entry.points,
            approvedSubmissions: entry.approvedSubmissions,
            fulfillmentMethod: "manual_support",
            claimReference,
            fulfillmentInstructions: "Contact Pint Path support with this claim reference. A Pint Path admin will verify and mark the reward fulfilled.",
          }),
          input.now,
          input.now,
        );
        insertAward.run(
          awardId,
          campaign.monthKey,
          rank,
          account.id,
          account.publicAccountId,
          entry.displayName,
          entry.points,
          entry.approvedSubmissions,
          voucherId,
          input.now,
        );
        const voucher = this.getAccountRewardVoucherById(voucherId);
        if (voucher) {
          vouchers.push(voucher);
        }
      }

      this.database
        .prepare(
          `UPDATE leaderboard_prize_campaigns
             SET status = 'finalized',
                 finalized_at = COALESCE(finalized_at, ?),
                 finalized_by = COALESCE(finalized_by, ?),
                 updated_at = ?
           WHERE month_key = ?`,
        )
        .run(input.now, input.finalizedBy, input.now, campaign.monthKey);

      return {
        campaign: this.getLeaderboardPrizeCampaign(campaign.monthKey)!,
        awards: this.listLeaderboardPrizeAwards(campaign.monthKey),
        vouchers,
      };
    });

    return finalize();
  }

  getAccountRewardVoucherById(id: string): AccountRewardVoucher | null {
    const row = this.database
      .prepare("SELECT * FROM account_reward_vouchers WHERE id = ?")
      .get(id) as AccountRewardVoucherRow | undefined;
    return row ? toAccountRewardVoucher(row) : null;
  }

  transitionAccountRewardVoucher(input: {
    id: string;
    action: "fulfill" | "void";
    actorUserId: string;
    reason: string;
    now: string;
  }): { voucher: AccountRewardVoucher; idempotent: boolean; conflict: boolean } | null {
    const transition = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE account_reward_vouchers
              SET status = 'expired', updated_at = ?
            WHERE id = ?
              AND status = 'active'
              AND expires_at IS NOT NULL
              AND expires_at <= ?`,
        )
        .run(input.now, input.id, input.now);

      const current = this.getAccountRewardVoucherById(input.id);
      if (!current) {
        return null;
      }
      const nextStatus = input.action === "fulfill" ? "redeemed" : "void";
      if (current.status === nextStatus) {
        return { voucher: current, idempotent: true, conflict: false };
      }
      if (current.status !== "active") {
        return { voucher: current, idempotent: false, conflict: true };
      }

      const metadata = {
        ...current.metadata,
        fulfillmentMethod: "manual_support",
        fulfillmentAction: input.action,
        fulfillmentReason: input.reason,
        fulfilledBy: input.actorUserId,
        fulfillmentUpdatedAt: input.now,
      };
      const updated = this.database
        .prepare(
          `UPDATE account_reward_vouchers
              SET status = ?,
                  redeemed_at = CASE WHEN ? = 'redeemed' THEN ? ELSE NULL END,
                  metadata_json = ?,
                  updated_at = ?
            WHERE id = ? AND status = 'active'`,
        )
        .run(nextStatus, nextStatus, input.now, JSON.stringify(metadata), input.now, input.id);
      if (updated.changes !== 1) {
        const raced = this.getAccountRewardVoucherById(input.id);
        return raced ? { voucher: raced, idempotent: raced.status === nextStatus, conflict: raced.status !== nextStatus } : null;
      }
      return { voucher: this.getAccountRewardVoucherById(input.id)!, idempotent: false, conflict: false };
    });

    return transition();
  }

  listPubGolfVenueCandidates(drinkNames: string[], limitPerDrink: number): PubGolfVenueCandidate[] {
    const normalizedDrinks = Array.from(new Set(
      drinkNames
        .map((drink) => drink.trim().toLowerCase())
        .filter(Boolean),
    ));
    if (!normalizedDrinks.length) {
      return [];
    }

    const rows: PubGolfVenueCandidate[] = [];
    const query = this.database.prepare(
      `SELECT
         beer.venue_id AS venue_id,
         profile.name AS venue_name,
         profile.address AS address,
         profile.suburb AS suburb,
         profile.membership_tier AS membership_tier,
         location.latitude AS latitude,
         location.longitude AS longitude,
         beer.beer_name AS beer_name,
         beer.serve_size AS serving_size,
         beer.price AS price,
         beer.updated_at AS updated_at
       FROM venue_beers beer
       INNER JOIN venue_profiles profile ON profile.venue_id = beer.venue_id
       LEFT JOIN venue_location_cache location ON location.venue_id = beer.venue_id
       WHERE profile.active = 1
         AND beer.in_stock = 1
         AND lower(beer.beer_name) LIKE ?
       ORDER BY
         CASE profile.membership_tier WHEN 'pro' THEN 0 WHEN 'plus' THEN 1 ELSE 2 END,
         location.latitude IS NULL,
         beer.updated_at DESC,
         profile.name COLLATE NOCASE ASC
       LIMIT ?`,
    );

    for (const drink of normalizedDrinks) {
      const matches = query.all(`%${drink}%`, limitPerDrink) as Array<{
        venue_id: string;
        venue_name: string;
        address: string | null;
        suburb: string | null;
        membership_tier: BarMembershipTier;
        latitude: number | null;
        longitude: number | null;
        beer_name: string;
        serving_size: string | null;
        price: number | null;
        updated_at: string;
      }>;
      rows.push(...matches.map((row) => ({
        venueId: row.venue_id,
        venueName: row.venue_name,
        address: row.address,
        suburb: row.suburb,
        membershipTier: row.membership_tier,
        latitude: row.latitude,
        longitude: row.longitude,
        beerName: row.beer_name,
        servingSize: row.serving_size,
        price: row.price,
        updatedAt: row.updated_at,
      })));
    }

    return rows;
  }

  createDiscountPass(input: {
    id: string;
    userId: string;
    sessionTokenHash: string;
    codeHash: string;
    createdAt: string;
    expiresAt: string;
  }): AccountDiscountPass {
    this.database
      .prepare(
        `INSERT INTO account_discount_passes (
          id, user_id, session_token_hash, code_hash, status, created_at, expires_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(input.id, input.userId, input.sessionTokenHash, input.codeHash, input.createdAt, input.expiresAt);

    return this.getDiscountPassById(input.id)!;
  }

  getDiscountPassById(id: string): AccountDiscountPass | null {
    const row = this.database
      .prepare("SELECT * FROM account_discount_passes WHERE id = ?")
      .get(id) as AccountDiscountPassRow | undefined;
    return row ? toAccountDiscountPass(row) : null;
  }

  getActiveDiscountPassByCodeHash(input: { codeHash: string; now: string }): AccountDiscountPass | null {
    const row = this.database
      .prepare(
        `SELECT * FROM account_discount_passes
         WHERE code_hash = ?
           AND status = 'active'
           AND revoked_at IS NULL
           AND expires_at > ?
         LIMIT 1`,
      )
      .get(input.codeHash, input.now) as AccountDiscountPassRow | undefined;
    return row ? toAccountDiscountPass(row) : null;
  }

  getDiscountPassByCodeHash(codeHash: string): AccountDiscountPass | null {
    const row = this.database
      .prepare("SELECT * FROM account_discount_passes WHERE code_hash = ? LIMIT 1")
      .get(codeHash) as AccountDiscountPassRow | undefined;
    return row ? toAccountDiscountPass(row) : null;
  }

  revokeDiscountPassesForSession(input: { sessionTokenHash: string; revokedAt: string }): number {
    const result = this.database
      .prepare(
        `UPDATE account_discount_passes
         SET status = 'revoked', revoked_at = ?
         WHERE session_token_hash = ?
           AND status = 'active'
           AND revoked_at IS NULL`,
      )
      .run(input.revokedAt, input.sessionTokenHash);
    return result.changes;
  }

  revokeDiscountPassesForUser(input: { userId: string; revokedAt: string }): number {
    const result = this.database
      .prepare(
        `UPDATE account_discount_passes
         SET status = 'revoked', revoked_at = ?
         WHERE user_id = ?
           AND status = 'active'
           AND revoked_at IS NULL`,
      )
      .run(input.revokedAt, input.userId);
    return result.changes;
  }

  markDiscountPassUsed(input: { id: string; lastUsedAt: string }): boolean {
    const result = this.database
      .prepare(
        `UPDATE account_discount_passes
         SET status = 'revoked',
             last_used_at = ?,
             revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ? AND status = 'active' AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(input.lastUsedAt, input.lastUsedAt, input.id, input.lastUsedAt);
    return result.changes === 1;
  }

  createDiscountRedemption(input: {
    id: string;
    userId: string;
    publicAccountId: string;
    venueId: string;
    venueName: string;
    suburb: string | null;
    specialId: string | null;
    itemName: string | null;
    quantity: number;
    estimatedSavingsCents: number;
    discountPassId: string | null;
    redeemedByUserId: string | null;
    idempotencyKey: string;
    redeemedAt: string;
    metadata: Record<string, unknown>;
  }): DiscountRedemption {
    this.database
      .prepare(
        `INSERT INTO discount_redemptions (
          id, user_id, public_account_id, venue_id, venue_name, suburb, special_id, item_name,
          quantity, estimated_savings_cents, discount_pass_id, redeemed_by_user_id, idempotency_key,
          redeemed_at, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.publicAccountId,
        input.venueId,
        input.venueName,
        input.suburb,
        input.specialId,
        input.itemName,
        input.quantity,
        input.estimatedSavingsCents,
        input.discountPassId,
        input.redeemedByUserId,
        input.idempotencyKey,
        input.redeemedAt,
        JSON.stringify(redactSecrets(input.metadata)),
        input.redeemedAt,
      );

    return this.getDiscountRedemptionById(input.id)!;
  }

  getDiscountRedemptionById(id: string): DiscountRedemption | null {
    const row = this.database
      .prepare("SELECT * FROM discount_redemptions WHERE id = ?")
      .get(id) as DiscountRedemptionRow | undefined;
    return row ? toDiscountRedemption(row) : null;
  }

  getDiscountRedemptionByIdempotencyKey(input: { venueId: string; idempotencyKey: string }): DiscountRedemption | null {
    const row = this.database
      .prepare("SELECT * FROM discount_redemptions WHERE venue_id = ? AND idempotency_key = ? LIMIT 1")
      .get(input.venueId, input.idempotencyKey) as DiscountRedemptionRow | undefined;
    return row ? toDiscountRedemption(row) : null;
  }

  getDiscountRedemptionByPassId(discountPassId: string): DiscountRedemption | null {
    const row = this.database
      .prepare("SELECT * FROM discount_redemptions WHERE discount_pass_id = ? LIMIT 1")
      .get(discountPassId) as DiscountRedemptionRow | undefined;
    return row ? toDiscountRedemption(row) : null;
  }

  rotateBarPosWebhookToken(input: { barId: string; now: string; previousValidUntil: string }): BarProfile {
    this.database
      .prepare(
        `UPDATE venue_profiles
         SET pos_previous_token_version = pos_webhook_token_version,
             pos_previous_token_valid_until = ?,
             pos_webhook_token_version = pos_webhook_token_version + 1,
             updated_at = ?
         WHERE venue_id = ?`,
      )
      .run(input.previousValidUntil, input.now, input.barId);
    return this.getBarProfile(input.barId)!;
  }

  recordBarPosWebhookSuccess(input: { barId: string; terminalId: string | null; now: string }): void {
    this.database
      .prepare(
        `UPDATE venue_profiles
         SET pos_last_success_at = ?, pos_last_terminal_id = ?, updated_at = updated_at
         WHERE venue_id = ?`,
      )
      .run(input.now, input.terminalId, input.barId);
  }

  listDiscountRedemptionsForUser(userId: string, limit: number): DiscountRedemption[] {
    const rows = this.database
      .prepare("SELECT * FROM discount_redemptions WHERE user_id = ? ORDER BY redeemed_at DESC LIMIT ?")
      .all(userId, limit) as DiscountRedemptionRow[];
    return rows.map(toDiscountRedemption);
  }

  getDiscountRedemptionStats(userId: string): {
    totalRedemptions: number;
    estimatedSavingsCents: number;
    uniqueVenues: number;
  } {
    const row = this.database
      .prepare(
        `SELECT
           count(*) AS total_redemptions,
           COALESCE(sum(estimated_savings_cents), 0) AS estimated_savings_cents,
           count(DISTINCT venue_id) AS unique_venues
         FROM discount_redemptions
         WHERE user_id = ?`,
      )
      .get(userId) as { total_redemptions: number; estimated_savings_cents: number; unique_venues: number } | undefined;

    return {
      totalRedemptions: Number(row?.total_redemptions ?? 0),
      estimatedSavingsCents: Number(row?.estimated_savings_cents ?? 0),
      uniqueVenues: Number(row?.unique_venues ?? 0),
    };
  }

  listDiscountRedemptionsForVenue(venueId: string, limit: number, offset = 0): DiscountRedemption[] {
    const rows = this.database
      .prepare("SELECT * FROM discount_redemptions WHERE venue_id = ? ORDER BY redeemed_at DESC LIMIT ? OFFSET ?")
      .all(venueId, Math.max(1, Math.min(limit, 100)), Math.max(0, offset)) as DiscountRedemptionRow[];
    return rows.map(toDiscountRedemption);
  }

  countDiscountRedemptionsForVenue(venueId: string): number {
    const row = this.database
      .prepare("SELECT count(*) AS count FROM discount_redemptions WHERE venue_id = ?")
      .get(venueId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  getDiscountRedemptionStatsForVenue(input: {
    venueId: string;
    startIso?: string | null | undefined;
    endIso?: string | null | undefined;
  }): {
    totalRedemptions: number;
    estimatedSavingsCents: number;
    uniqueAccounts: number;
    totalQuantity: number;
  } {
    const clauses = ["venue_id = ?"];
    const values: unknown[] = [input.venueId];

    if (input.startIso) {
      clauses.push("redeemed_at >= ?");
      values.push(input.startIso);
    }

    if (input.endIso) {
      clauses.push("redeemed_at < ?");
      values.push(input.endIso);
    }

    const row = this.database
      .prepare(
        `SELECT
           count(*) AS total_redemptions,
           COALESCE(sum(estimated_savings_cents), 0) AS estimated_savings_cents,
           count(DISTINCT public_account_id) AS unique_accounts,
           COALESCE(sum(quantity), 0) AS total_quantity
         FROM discount_redemptions
         WHERE ${clauses.join(" AND ")}`,
      )
      .get(...values) as {
        total_redemptions: number;
        estimated_savings_cents: number;
        unique_accounts: number;
        total_quantity: number;
      } | undefined;

    return {
      totalRedemptions: Number(row?.total_redemptions ?? 0),
      estimatedSavingsCents: Number(row?.estimated_savings_cents ?? 0),
      uniqueAccounts: Number(row?.unique_accounts ?? 0),
      totalQuantity: Number(row?.total_quantity ?? 0),
    };
  }

  listDiscountItemStatsForVenue(input: {
    venueId: string;
    startIso?: string | null | undefined;
    endIso?: string | null | undefined;
    limit: number;
  }): Array<{
    itemName: string;
    redemptions: number;
    quantity: number;
    estimatedSavingsCents: number;
  }> {
    const clauses = ["venue_id = ?"];
    const values: unknown[] = [input.venueId];

    if (input.startIso) {
      clauses.push("redeemed_at >= ?");
      values.push(input.startIso);
    }

    if (input.endIso) {
      clauses.push("redeemed_at < ?");
      values.push(input.endIso);
    }

    values.push(input.limit);
    const rows = this.database
      .prepare(
        `SELECT
           COALESCE(NULLIF(trim(item_name), ''), 'Unspecified item') AS item_name,
           count(*) AS redemptions,
           COALESCE(sum(quantity), 0) AS quantity,
           COALESCE(sum(estimated_savings_cents), 0) AS estimated_savings_cents
         FROM discount_redemptions
         WHERE ${clauses.join(" AND ")}
         GROUP BY COALESCE(NULLIF(trim(item_name), ''), 'Unspecified item')
         ORDER BY redemptions DESC, estimated_savings_cents DESC
         LIMIT ?`,
      )
      .all(...values) as Array<{
        item_name: string;
        redemptions: number;
        quantity: number;
        estimated_savings_cents: number;
      }>;

    return rows.map((row) => ({
      itemName: row.item_name,
      redemptions: Number(row.redemptions),
      quantity: Number(row.quantity),
      estimatedSavingsCents: Number(row.estimated_savings_cents),
    }));
  }

  listVenueAreaPurchasedBeers(input: {
    area: string | null;
    startIso?: string | null | undefined;
    endIso?: string | null | undefined;
    privacyThreshold?: number | undefined;
    limit: number;
  }): AreaPurchasedBeerBucket[] {
    if (!input.area?.trim()) {
      return [];
    }
    const area = input.area.trim();

    const addDateClauses = (
      column: "recorded_at" | "redeemed_at",
      clauses: string[],
      values: unknown[],
    ) => {
      if (input.startIso) {
        clauses.push(`${column} >= ?`);
        values.push(input.startIso);
      }
      if (input.endIso) {
        clauses.push(`${column} < ?`);
        values.push(input.endIso);
      }
    };

    const drinkClauses = [
      "lower(COALESCE(suburb, '')) = lower(?)",
      "is_alcoholic = 1",
      "status = 'active'",
      "COALESCE(NULLIF(trim(item_name), ''), '') != ''",
    ];
    const drinkValues: unknown[] = [area];
    addDateClauses("recorded_at", drinkClauses, drinkValues);

    const redemptionClauses = [
      "lower(COALESCE(suburb, '')) = lower(?)",
      "COALESCE(NULLIF(trim(item_name), ''), '') != ''",
    ];
    const redemptionValues: unknown[] = [area];
    addDateClauses("redeemed_at", redemptionClauses, redemptionValues);

    const drinkRows = this.database
      .prepare(
        `SELECT
           item_name,
           count(*) AS count,
           COALESCE(sum(quantity), 0) AS quantity,
           0 AS estimated_savings_cents
         FROM pint_point_drink_records
         WHERE ${drinkClauses.join(" AND ")}
         GROUP BY item_name`,
      )
      .all(...drinkValues) as Array<{
        item_name: string | null;
        count: number;
        quantity: number;
        estimated_savings_cents: number;
      }>;

    const redemptionRows = this.database
      .prepare(
        `SELECT
           item_name,
           count(*) AS count,
           COALESCE(sum(quantity), 0) AS quantity,
           COALESCE(sum(estimated_savings_cents), 0) AS estimated_savings_cents
         FROM discount_redemptions
         WHERE ${redemptionClauses.join(" AND ")}
         GROUP BY item_name`,
      )
      .all(...redemptionValues) as Array<{
        item_name: string | null;
        count: number;
        quantity: number;
        estimated_savings_cents: number;
      }>;

    const buckets = new Map<string, AreaPurchasedBeerBucket>();
    for (const row of [...drinkRows, ...redemptionRows]) {
      const key = normalizeBeerInsightKey(row.item_name);
      const existing = buckets.get(key) ?? {
        key,
        label: formatInsightBeerLabel(row.item_name),
        count: 0,
        quantity: 0,
        estimatedSavingsCents: 0,
      };
      existing.count += Number(row.count ?? 0);
      existing.quantity += Number(row.quantity ?? 0);
      existing.estimatedSavingsCents += Number(row.estimated_savings_cents ?? 0);
      buckets.set(key, existing);
    }

    const privacyThreshold = Math.max(1, input.privacyThreshold ?? 5);
    return Array.from(buckets.values())
      .filter((bucket) => bucket.quantity >= privacyThreshold || bucket.count >= privacyThreshold)
      .sort((a, b) => b.quantity - a.quantity || b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, input.limit);
  }

  listVenueAreaPriceBenchmarks(input: {
    venueId: string;
    area: string | null;
    limit: number;
  }): VenueAreaPriceBenchmark[] {
    if (!input.area?.trim()) {
      return [];
    }
    const area = input.area.trim();

    const venueRows = this.database
      .prepare(
        `SELECT beer_name, serve_size, price
         FROM venue_beers
         WHERE venue_id = ?
           AND price IS NOT NULL
           AND in_stock = 1`,
      )
      .all(input.venueId) as Array<{ beer_name: string; serve_size: ServingSize | null; price: number }>;

    if (!venueRows.length) {
      return [];
    }

    const areaRows = this.database
      .prepare(
        `SELECT vb.beer_name, vb.serve_size, vb.price
         FROM venue_beers vb
         JOIN venue_profiles vp ON vp.venue_id = vb.venue_id
         WHERE lower(COALESCE(vp.suburb, vp.area, '')) = lower(?)
           AND vp.active = 1
           AND vb.price IS NOT NULL
           AND vb.in_stock = 1`,
      )
      .all(area) as Array<{ beer_name: string; serve_size: ServingSize | null; price: number }>;

    const pricesByBeerAndServe = new Map<string, number[]>();
    for (const row of areaRows) {
      const key = `${normalizeBeerInsightKey(row.beer_name)}::${row.serve_size ?? ""}`;
      const price = Number(row.price);
      if (!Number.isFinite(price)) {
        continue;
      }
      const prices = pricesByBeerAndServe.get(key) ?? [];
      prices.push(price);
      pricesByBeerAndServe.set(key, prices);
    }

    const benchmarks: VenueAreaPriceBenchmark[] = [];
    const seenVenueRows = new Set<string>();
    for (const row of venueRows) {
      const beerKey = normalizeBeerInsightKey(row.beer_name);
      const groupKey = `${beerKey}::${row.serve_size ?? ""}`;
      if (seenVenueRows.has(groupKey)) {
        continue;
      }
      seenVenueRows.add(groupKey);

      const prices = pricesByBeerAndServe.get(groupKey) ?? [];
      const localMedian = median(prices);
      const venuePrice = Number(row.price);
      if (localMedian == null || prices.length < 2 || !Number.isFinite(venuePrice)) {
        continue;
      }

      const difference = Number((venuePrice - localMedian).toFixed(2));
      benchmarks.push({
        beerName: formatInsightBeerLabel(row.beer_name),
        serveSize: row.serve_size,
        venuePrice,
        localMedian: Number(localMedian.toFixed(2)),
        difference,
        sampleSize: prices.length,
        comparison: Math.abs(difference) < 0.01 ? "at" : difference > 0 ? "above" : "below",
      });
    }

    return benchmarks
      .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || b.sampleSize - a.sampleSize)
      .slice(0, input.limit);
  }

  createPintPointDrinkRecord(input: {
    id: string;
    userId: string;
    venueId: string;
    venueName: string;
    suburb: string | null;
    itemName: string | null;
    beverageCategory: string;
    quantity: number;
    isAlcoholic: boolean;
    pointsAwarded?: number;
    dailyCap?: number;
    dailySince?: string;
    source: string;
    recordedByUserId: string | null;
    idempotencyKey: string;
    recordedAt: string;
    metadata: Record<string, unknown>;
  }): PintPointDrinkRecord {
    let pointsAwarded = 0;
    const create = this.database.transaction(() => {
      const requestedPoints = Math.max(0, Math.min(
        input.quantity,
        input.pointsAwarded ?? (input.isAlcoholic ? input.quantity : 0),
      ));
      if (input.dailyCap != null && input.dailySince) {
        const awarded = this.countPintPointsAwardedSince({ userId: input.userId, since: input.dailySince });
        pointsAwarded = Math.min(requestedPoints, Math.max(0, input.dailyCap - awarded));
      } else {
        pointsAwarded = requestedPoints;
      }
      this.database
        .prepare(
          `INSERT INTO pint_point_drink_records (
            id, user_id, venue_id, venue_name, suburb, item_name, beverage_category,
            quantity, is_alcoholic, points_awarded, source, reward_code_id, recorded_by_user_id,
            idempotency_key, recorded_at, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.userId,
          input.venueId,
          input.venueName,
          input.suburb,
          input.itemName,
          input.beverageCategory,
          input.quantity,
          input.isAlcoholic ? 1 : 0,
          pointsAwarded,
          input.source,
          input.recordedByUserId,
          input.idempotencyKey,
          input.recordedAt,
          JSON.stringify(redactSecrets(input.metadata)),
          input.recordedAt,
        );

      if (pointsAwarded > 0) {
        this.createPintPointLedgerEntry({
          id: crypto.randomUUID(),
          userId: input.userId,
          venueId: input.venueId,
          drinkRecordId: input.id,
          rewardCodeId: null,
          type: input.source === "manual_entry" ? "manual_drink_entry" : "drink_scan",
          pointsDelta: pointsAwarded,
          pointsReservedDelta: 0,
          description: pointsAwarded === 1 ? "Alcoholic beverage recorded." : `${pointsAwarded} alcoholic beverages recorded.`,
          createdAt: input.recordedAt,
          metadata: {
            itemName: input.itemName,
            quantity: input.quantity,
            source: input.source,
          },
        });
      }
    });

    create();
    return this.getPintPointDrinkRecordById(input.id)!;
  }

  getPintPointDrinkRecordById(id: string): PintPointDrinkRecord | null {
    const row = this.database
      .prepare("SELECT * FROM pint_point_drink_records WHERE id = ?")
      .get(id) as PintPointDrinkRecordRow | undefined;
    return row ? toPintPointDrinkRecord(row) : null;
  }

  getPintPointDrinkRecordByIdempotencyKey(input: {
    venueId: string;
    idempotencyKey: string;
  }): PintPointDrinkRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM pint_point_drink_records
         WHERE venue_id = ? AND idempotency_key = ?
         LIMIT 1`,
      )
      .get(input.venueId, input.idempotencyKey) as PintPointDrinkRecordRow | undefined;
    return row ? toPintPointDrinkRecord(row) : null;
  }

  getPintPointDrinkRecordByGlobalIdempotencyKey(idempotencyKey: string): PintPointDrinkRecord | null {
    const row = this.database
      .prepare("SELECT * FROM pint_point_drink_records WHERE idempotency_key = ? LIMIT 1")
      .get(idempotencyKey) as PintPointDrinkRecordRow | undefined;
    return row ? toPintPointDrinkRecord(row) : null;
  }

  listPintPointDrinkRecordsForUser(userId: string, limit: number): PintPointDrinkRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM pint_point_drink_records
         WHERE user_id = ? AND status = 'active'
         ORDER BY recorded_at DESC
         LIMIT ?`,
      )
      .all(userId, limit) as PintPointDrinkRecordRow[];
    return rows.map(toPintPointDrinkRecord);
  }

  listPintPointDrinkRecordsForVenue(venueId: string, limit: number, offset = 0): VenuePintPointActivity[] {
    const rows = this.database
      .prepare(
        `SELECT
           r.id,
           COALESCE(a.public_account_id, 'Pint Path member') AS public_account_id,
           r.item_name,
           r.beverage_category,
           r.quantity,
           r.points_awarded,
           r.source,
           r.recorded_by_user_id,
           r.status,
           r.voided_at,
           r.voided_by_user_id,
           r.void_reason,
           r.recorded_at
         FROM pint_point_drink_records r
         LEFT JOIN accounts a ON a.id = r.user_id
         WHERE r.venue_id = ?
         ORDER BY r.recorded_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(venueId, Math.max(1, Math.min(limit, 100)), Math.max(0, offset)) as VenuePintPointActivityRow[];

    return rows.map((row) => ({
      id: row.id,
      publicAccountId: row.public_account_id,
      itemName: row.item_name,
      beverageCategory: row.beverage_category,
      quantity: Number(row.quantity),
      pointsAwarded: Number(row.points_awarded),
      source: row.source,
      recordedByUserId: row.recorded_by_user_id,
      status: row.status ?? "active",
      voidedAt: row.voided_at,
      voidedByUserId: row.voided_by_user_id,
      voidReason: row.void_reason,
      recordedAt: row.recorded_at,
    }));
  }

  countPintPointDrinkRecordsForVenue(venueId: string): number {
    const row = this.database
      .prepare("SELECT count(*) AS count FROM pint_point_drink_records WHERE venue_id = ?")
      .get(venueId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countPintPointsAwardedSince(input: { userId: string; since: string }): number {
    const row = this.database
      .prepare(
        `SELECT COALESCE(sum(points_awarded), 0) AS points
         FROM pint_point_drink_records
         WHERE user_id = ? AND recorded_at >= ? AND status = 'active'`,
      )
      .get(input.userId, input.since) as { points: number } | undefined;
    return Number(row?.points ?? 0);
  }

  voidPintPointDrinkRecord(input: {
    recordId: string;
    venueId: string;
    actorUserId: string;
    reason: string;
    voidedAt: string;
  }): { record: PintPointDrinkRecord; idempotentReplay: boolean } | null {
    let idempotentReplay = false;
    const applyVoid = this.database.transaction(() => {
      const current = this.getPintPointDrinkRecordById(input.recordId);
      if (!current || current.venueId !== input.venueId) {
        return null;
      }
      if (current.status === "void") {
        idempotentReplay = true;
        return current;
      }

      const updated = this.database
        .prepare(
          `UPDATE pint_point_drink_records
           SET status = 'void', voided_at = ?, voided_by_user_id = ?, void_reason = ?
           WHERE id = ? AND venue_id = ? AND status = 'active'`,
        )
        .run(input.voidedAt, input.actorUserId, input.reason, input.recordId, input.venueId);

      if (updated.changes !== 1) {
        idempotentReplay = true;
        return this.getPintPointDrinkRecordById(input.recordId);
      }

      if (current.pointsAwarded > 0) {
        this.createPintPointLedgerEntry({
          id: crypto.randomUUID(),
          userId: current.userId,
          venueId: current.venueId,
          drinkRecordId: current.id,
          rewardCodeId: null,
          type: "drink_void",
          pointsDelta: -current.pointsAwarded,
          pointsReservedDelta: 0,
          description: current.pointsAwarded === 1
            ? "Voided purchase: 1 Pint Point reversed."
            : `Voided purchase: ${current.pointsAwarded} Pint Points reversed.`,
          createdAt: input.voidedAt,
          metadata: {
            reason: input.reason,
            voidedByUserId: input.actorUserId,
          },
        });
      }

      return this.getPintPointDrinkRecordById(input.recordId);
    });

    const record = applyVoid();
    return record ? { record, idempotentReplay } : null;
  }

  createPintPointLedgerEntry(input: {
    id: string;
    userId: string;
    venueId: string | null;
    drinkRecordId: string | null;
    rewardCodeId: string | null;
    type: PintPointLedgerType;
    pointsDelta: number;
    pointsReservedDelta: number;
    description: string;
    createdAt: string;
    metadata: Record<string, unknown>;
  }): PintPointLedgerEntry {
    this.database
      .prepare(
        `INSERT INTO pint_point_ledger (
          id, user_id, venue_id, drink_record_id, reward_code_id, type,
          points_delta, points_reserved_delta, description, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.venueId,
        input.drinkRecordId,
        input.rewardCodeId,
        input.type,
        input.pointsDelta,
        input.pointsReservedDelta,
        input.description,
        input.createdAt,
        JSON.stringify(redactSecrets(input.metadata)),
      );

    return this.getPintPointLedgerEntryById(input.id)!;
  }

  getPintPointLedgerEntryById(id: string): PintPointLedgerEntry | null {
    const row = this.database
      .prepare("SELECT * FROM pint_point_ledger WHERE id = ?")
      .get(id) as PintPointLedgerRow | undefined;
    return row ? toPintPointLedgerEntry(row) : null;
  }

  listPintPointLedgerForUser(userId: string, limit: number): PintPointLedgerEntry[] {
    const rows = this.database
      .prepare("SELECT * FROM pint_point_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit) as PintPointLedgerRow[];
    return rows.map(toPintPointLedgerEntry);
  }

  getPintPointBalance(userId: string): {
    balance: number;
    reserved: number;
    available: number;
    lifetimeEarned: number;
    lifetimeRedeemed: number;
  } {
    const row = this.database
      .prepare(
        `SELECT
           COALESCE(sum(points_delta), 0) AS balance,
           COALESCE(sum(points_reserved_delta), 0) AS reserved,
           COALESCE(sum(CASE WHEN points_delta > 0 THEN points_delta ELSE 0 END), 0) AS lifetime_earned,
           ABS(COALESCE(sum(CASE WHEN type = 'reward_redeemed' THEN points_delta ELSE 0 END), 0)) AS lifetime_redeemed
         FROM pint_point_ledger
         WHERE user_id = ?`,
      )
      .get(userId) as {
        balance: number;
        reserved: number;
        lifetime_earned: number;
        lifetime_redeemed: number;
      } | undefined;

    const balance = Number(row?.balance ?? 0);
    const reserved = Number(row?.reserved ?? 0);
    return {
      balance,
      reserved,
      available: Math.max(0, balance - reserved),
      lifetimeEarned: Number(row?.lifetime_earned ?? 0),
      lifetimeRedeemed: Number(row?.lifetime_redeemed ?? 0),
    };
  }

  createFreePintRewardCode(input: {
    id: string;
    userId: string;
    publicAccountId: string;
    codeHash: string;
    createdAt: string;
    expiresAt: string;
    metadata: Record<string, unknown>;
  }): FreePintRewardCode {
    const create = this.database.transaction(() => {
      const wallet = this.getPintPointBalance(input.userId);
      if (wallet.available < 50) {
        throw new Error("INSUFFICIENT_PINT_POINTS");
      }
      this.database
        .prepare(
          `INSERT INTO free_pint_reward_codes (
            id, user_id, public_account_id, code_hash, eligible_venue_scope, status,
            points_reserved, created_at, expires_at, metadata_json
          ) VALUES (?, ?, ?, ?, 'affiliated', 'active', 50, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.userId,
          input.publicAccountId,
          input.codeHash,
          input.createdAt,
          input.expiresAt,
          JSON.stringify(redactSecrets(input.metadata)),
        );

      this.createPintPointLedgerEntry({
        id: crypto.randomUUID(),
        userId: input.userId,
        venueId: null,
        drinkRecordId: null,
        rewardCodeId: input.id,
        type: "reward_code_created",
        pointsDelta: 0,
        pointsReservedDelta: 50,
        description: "Free Pint Reward code created.",
        createdAt: input.createdAt,
        metadata: { expiresAt: input.expiresAt },
      });
    });

    create();
    return this.getFreePintRewardCodeById(input.id)!;
  }

  getFreePintRewardCodeById(id: string): FreePintRewardCode | null {
    const row = this.database
      .prepare("SELECT * FROM free_pint_reward_codes WHERE id = ?")
      .get(id) as FreePintRewardCodeRow | undefined;
    return row ? toFreePintRewardCode(row) : null;
  }

  getFreePintRewardCodeByCodeHash(codeHash: string): FreePintRewardCode | null {
    const row = this.database
      .prepare("SELECT * FROM free_pint_reward_codes WHERE code_hash = ? LIMIT 1")
      .get(codeHash) as FreePintRewardCodeRow | undefined;
    return row ? toFreePintRewardCode(row) : null;
  }

  getActiveFreePintRewardCodeByCodeHash(input: { codeHash: string; now: string }): FreePintRewardCode | null {
    const row = this.database
      .prepare(
        `SELECT * FROM free_pint_reward_codes
         WHERE code_hash = ?
           AND status = 'active'
           AND expires_at > ?
         LIMIT 1`,
      )
      .get(input.codeHash, input.now) as FreePintRewardCodeRow | undefined;
    return row ? toFreePintRewardCode(row) : null;
  }

  listFreePintRewardCodesForUser(userId: string, limit: number): FreePintRewardCode[] {
    const rows = this.database
      .prepare("SELECT * FROM free_pint_reward_codes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit) as FreePintRewardCodeRow[];
    return rows.map(toFreePintRewardCode);
  }

  expireFreePintRewardCodesForUser(input: { userId: string; now: string }): number {
    const rows = this.database
      .prepare(
        `SELECT * FROM free_pint_reward_codes
         WHERE user_id = ?
           AND status = 'active'
           AND expires_at <= ?`,
      )
      .all(input.userId, input.now) as FreePintRewardCodeRow[];

    let expired = 0;
    const expire = this.database.transaction(() => {
      for (const row of rows) {
        const updated = this.database
          .prepare("UPDATE free_pint_reward_codes SET status = 'expired' WHERE id = ? AND status = 'active'")
          .run(row.id);
        if (updated.changes !== 1) {
          continue;
        }
        expired += 1;
        this.createPintPointLedgerEntry({
          id: crypto.randomUUID(),
          userId: row.user_id,
          venueId: null,
          drinkRecordId: null,
          rewardCodeId: row.id,
          type: "reward_code_expired",
          pointsDelta: 0,
          pointsReservedDelta: -row.points_reserved,
          description: "Free Pint Reward code expired.",
          createdAt: input.now,
          metadata: { expiresAt: row.expires_at },
        });
      }
    });

    expire();
    return expired;
  }

  cancelFreePintRewardCode(input: { userId: string; codeId: string; now: string }): FreePintRewardCode | null {
    const code = this.getFreePintRewardCodeById(input.codeId);
    if (!code || code.userId !== input.userId || code.status !== "active") {
      return null;
    }

    const cancel = this.database.transaction(() => {
      const updated = this.database
        .prepare("UPDATE free_pint_reward_codes SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'active'")
        .run(input.now, input.codeId);
      if (updated.changes !== 1) {
        return;
      }
      this.createPintPointLedgerEntry({
        id: crypto.randomUUID(),
        userId: code.userId,
        venueId: null,
        drinkRecordId: null,
        rewardCodeId: code.id,
        type: "reward_cancelled",
        pointsDelta: 0,
        pointsReservedDelta: -code.pointsReserved,
        description: "Free Pint Reward code cancelled.",
        createdAt: input.now,
        metadata: {},
      });
    });

    cancel();
    return this.getFreePintRewardCodeById(input.codeId);
  }

  rejectFreePintRewardCode(input: {
    codeId: string;
    venueId: string;
    actorUserId: string | null;
    reason: string | null;
    now: string;
    metadata: Record<string, unknown>;
  }): FreePintRewardCode | null {
    const code = this.getFreePintRewardCodeById(input.codeId);
    if (!code || code.status !== "active") {
      return null;
    }

    const reject = this.database.transaction(() => {
      const updated = this.database
        .prepare(
          `UPDATE free_pint_reward_codes
           SET status = 'rejected',
               rejected_at = ?,
               rejected_reason = ?,
               redeemed_by_user_id = ?,
               redeemed_venue_id = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(input.now, input.reason, input.actorUserId, input.venueId, input.codeId);
      if (updated.changes !== 1) {
        return;
      }
      this.createPintPointLedgerEntry({
        id: crypto.randomUUID(),
        userId: code.userId,
        venueId: input.venueId,
        drinkRecordId: null,
        rewardCodeId: code.id,
        type: "reward_rejected",
        pointsDelta: 0,
        pointsReservedDelta: -code.pointsReserved,
        description: "Free Pint Reward rejected by venue.",
        createdAt: input.now,
        metadata: {
          reason: input.reason,
          ...input.metadata,
        },
      });
    });

    reject();
    return this.getFreePintRewardCodeById(input.codeId);
  }

  redeemFreePintRewardCode(input: {
    codeId: string;
    userId: string;
    publicAccountId: string;
    venueId: string;
    venueName: string;
    suburb: string | null;
    redeemedByUserId: string | null;
    redeemedAt: string;
    metadata: Record<string, unknown>;
  }): FreePintRewardRedemption | null {
    const code = this.getFreePintRewardCodeById(input.codeId);
    if (!code || code.status !== "active" || code.userId !== input.userId) {
      return null;
    }

    const redemptionId = crypto.randomUUID();
    const redeem = this.database.transaction(() => {
      const update = this.database
        .prepare(
          `UPDATE free_pint_reward_codes
           SET status = 'used',
               used_at = ?,
               redeemed_by_user_id = ?,
               redeemed_venue_id = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(input.redeemedAt, input.redeemedByUserId, input.venueId, input.codeId);

      if (update.changes !== 1) {
        return;
      }

      this.database
        .prepare(
          `INSERT INTO free_pint_reward_redemptions (
            id, user_id, public_account_id, reward_code_id, venue_id, venue_name,
            suburb, redeemed_by_user_id, redeemed_at, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          redemptionId,
          input.userId,
          input.publicAccountId,
          input.codeId,
          input.venueId,
          input.venueName,
          input.suburb,
          input.redeemedByUserId,
          input.redeemedAt,
          JSON.stringify(redactSecrets(input.metadata)),
          input.redeemedAt,
        );

      this.createPintPointLedgerEntry({
        id: crypto.randomUUID(),
        userId: input.userId,
        venueId: input.venueId,
        drinkRecordId: null,
        rewardCodeId: input.codeId,
        type: "reward_redeemed",
        pointsDelta: -code.pointsReserved,
        pointsReservedDelta: -code.pointsReserved,
        description: "Free Pint Reward redeemed.",
        createdAt: input.redeemedAt,
        metadata: {
          venueName: input.venueName,
          suburb: input.suburb,
        },
      });
    });

    redeem();
    return this.getFreePintRewardRedemptionById(redemptionId);
  }

  getFreePintRewardRedemptionById(id: string): FreePintRewardRedemption | null {
    const row = this.database
      .prepare("SELECT * FROM free_pint_reward_redemptions WHERE id = ?")
      .get(id) as FreePintRewardRedemptionRow | undefined;
    return row ? toFreePintRewardRedemption(row) : null;
  }

  listFreePintRewardRedemptionsForUser(userId: string, limit: number): FreePintRewardRedemption[] {
    const rows = this.database
      .prepare("SELECT * FROM free_pint_reward_redemptions WHERE user_id = ? ORDER BY redeemed_at DESC LIMIT ?")
      .all(userId, limit) as FreePintRewardRedemptionRow[];
    return rows.map(toFreePintRewardRedemption);
  }

  getPintPointStatsForVenue(input: {
    venueId: string;
    startIso?: string | null | undefined;
    endIso?: string | null | undefined;
  }): {
    pointsIssued: number;
    drinkRecords: number;
    alcoholicDrinks: number;
    freeRewardsRedeemed: number;
    expiredOrRejectedCodes: number;
  } {
    const drinkClauses = ["venue_id = ?"];
    const drinkValues: unknown[] = [input.venueId];
    const rewardClauses = ["redeemed_venue_id = ?"];
    const rewardValues: unknown[] = [input.venueId];

    if (input.startIso) {
      drinkClauses.push("recorded_at >= ?");
      drinkValues.push(input.startIso);
      rewardClauses.push("COALESCE(used_at, rejected_at, cancelled_at, expires_at) >= ?");
      rewardValues.push(input.startIso);
    }

    if (input.endIso) {
      drinkClauses.push("recorded_at < ?");
      drinkValues.push(input.endIso);
      rewardClauses.push("COALESCE(used_at, rejected_at, cancelled_at, expires_at) < ?");
      rewardValues.push(input.endIso);
    }

    const drinkRow = this.database
      .prepare(
        `SELECT
           COALESCE(sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS drink_records,
           COALESCE(sum(CASE WHEN status = 'active' AND is_alcoholic = 1 THEN quantity ELSE 0 END), 0) AS alcoholic_drinks,
           COALESCE(sum(CASE WHEN status = 'active' THEN points_awarded ELSE 0 END), 0) AS points_issued
         FROM pint_point_drink_records
         WHERE ${drinkClauses.join(" AND ")}`,
      )
      .get(...drinkValues) as { drink_records: number; alcoholic_drinks: number; points_issued: number } | undefined;

    const rewardRow = this.database
      .prepare(
        `SELECT
           COALESCE(sum(CASE WHEN status = 'used' THEN 1 ELSE 0 END), 0) AS redeemed,
           COALESCE(sum(CASE WHEN status IN ('expired', 'rejected') THEN 1 ELSE 0 END), 0) AS failed
         FROM free_pint_reward_codes
         WHERE ${rewardClauses.join(" AND ")}`,
      )
      .get(...rewardValues) as { redeemed: number; failed: number } | undefined;

    return {
      pointsIssued: Number(drinkRow?.points_issued ?? 0),
      drinkRecords: Number(drinkRow?.drink_records ?? 0),
      alcoholicDrinks: Number(drinkRow?.alcoholic_drinks ?? 0),
      freeRewardsRedeemed: Number(rewardRow?.redeemed ?? 0),
      expiredOrRejectedCodes: Number(rewardRow?.failed ?? 0),
    };
  }

  getSubmissionById(id: string): { submission: BusinessSubmission; items: BusinessSubmissionItem[] } | null {
    const submissionRow = this.database.prepare("SELECT * FROM submissions WHERE id = ?").get(id) as
      | SubmissionRow
      | undefined;

    if (!submissionRow) {
      return null;
    }

    const itemRows = this.database
      .prepare("SELECT * FROM submission_items WHERE submission_id = ? ORDER BY created_at ASC")
      .all(id) as SubmissionItemRow[];

    return {
      submission: toSubmission(submissionRow),
      items: itemRows.map(toSubmissionItem),
    };
  }

  getSubmissionByClientSubmissionId(
    userId: string,
    clientSubmissionId: string,
  ): { submission: BusinessSubmission; items: BusinessSubmissionItem[] } | null {
    const submissionRow = this.database
      .prepare("SELECT * FROM submissions WHERE user_id = ? AND client_submission_id = ? LIMIT 1")
      .get(userId, clientSubmissionId) as SubmissionRow | undefined;

    if (!submissionRow) {
      return null;
    }

    const itemRows = this.database
      .prepare("SELECT * FROM submission_items WHERE submission_id = ? ORDER BY created_at ASC")
      .all(submissionRow.id) as SubmissionItemRow[];

    return {
      submission: toSubmission(submissionRow),
      items: itemRows.map(toSubmissionItem),
    };
  }

  listSubmissionsWithItems(filters: { userId?: string | undefined; status?: SubmissionStatus | undefined; limit: number; offset?: number | undefined }): BusinessSubmissionWithItems[] {
    return this.withSubmissionItems(this.listSubmissions(filters));
  }

  private withSubmissionItems(submissions: BusinessSubmission[]): BusinessSubmissionWithItems[] {
    if (!submissions.length) {
      return [];
    }

    const itemRows = this.database
      .prepare(
        `SELECT *
           FROM submission_items
          WHERE submission_id IN (${submissions.map(() => "?").join(", ")})
          ORDER BY created_at ASC`,
      )
      .all(...submissions.map((submission) => submission.id)) as SubmissionItemRow[];
    const itemsBySubmissionId = new Map<string, BusinessSubmissionItem[]>();
    itemRows.forEach((row) => {
      const items = itemsBySubmissionId.get(row.submission_id) ?? [];
      items.push(toSubmissionItem(row));
      itemsBySubmissionId.set(row.submission_id, items);
    });

    return submissions.map((submission) => ({
      ...submission,
      items: itemsBySubmissionId.get(submission.id) ?? [],
    }));
  }

  listSubmissions(filters: { userId?: string | undefined; status?: SubmissionStatus | undefined; limit: number; offset?: number | undefined }): BusinessSubmission[] {
    const where: string[] = [];
    const values: unknown[] = [];

    if (filters.userId) {
      where.push("user_id = ?");
      values.push(filters.userId);
    }

    if (filters.status) {
      where.push("status = ?");
      values.push(filters.status);
    }

    values.push(filters.limit, Math.max(0, filters.offset ?? 0));
    const rows = this.database
      .prepare(
        `SELECT * FROM submissions
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...values) as SubmissionRow[];
    return rows.map(toSubmission);
  }

  countSubmissions(filters: { userId?: string; status?: SubmissionStatus }): number {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filters.userId) { where.push("user_id = ?"); values.push(filters.userId); }
    if (filters.status) { where.push("status = ?"); values.push(filters.status); }
    const row = this.database.prepare(
      `SELECT count(*) AS count FROM submissions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
    ).get(...values) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  listCommunityVerificationCandidates(input: {
    verifierUserId: string;
    limit: number;
    offset: number;
  }): BusinessSubmissionWithItems[] {
    const rows = this.database.prepare(
      `SELECT submission.*
       FROM submissions submission
       WHERE submission.status IN ('pending', 'needs_more_evidence')
         AND submission.user_id != ?
         AND NOT EXISTS (
           SELECT 1 FROM verifications verification
           WHERE verification.upload_id = submission.id
             AND verification.verifier_user_id = ?
         )
       ORDER BY submission.created_at ASC, submission.id ASC
       LIMIT ? OFFSET ?`,
    ).all(
      input.verifierUserId,
      input.verifierUserId,
      Math.max(1, Math.min(100, input.limit)),
      Math.max(0, input.offset),
    ) as SubmissionRow[];
    return this.withSubmissionItems(rows.map(toSubmission));
  }

  countCommunityVerificationCandidates(verifierUserId: string): number {
    const row = this.database.prepare(
      `SELECT count(*) AS count
       FROM submissions submission
       WHERE submission.status IN ('pending', 'needs_more_evidence')
         AND submission.user_id != ?
         AND NOT EXISTS (
           SELECT 1 FROM verifications verification
           WHERE verification.upload_id = submission.id
             AND verification.verifier_user_id = ?
         )`,
    ).get(verifierUserId, verifierUserId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  reviewSubmission(input: {
    submissionId: string;
    reviewerId: string;
    status: Extract<SubmissionStatus, "approved" | "rejected" | "needs_more_evidence" | "fraud_flagged" | "disputed">;
    rejectionReason: string | null;
    fraudFlagged: boolean;
    pointsAwarded: number;
    confidence: ConfidenceLabel;
    now: string;
    monthKey: string;
    premiumUntil: string;
    contributorUnlockPoints: number;
    allowOwnReview?: boolean | undefined;
  }): { submission: BusinessSubmission; pointsAwarded: number; account: BusinessAccount } {
    const review = this.database.transaction(() => {
      const current = this.getSubmissionById(input.submissionId);
      if (!current) {
        throw new Error("Submission not found");
      }

      if (current.submission.userId === input.reviewerId && !input.allowOwnReview) {
        throw new Error("Users cannot review their own submissions");
      }

      if (current.submission.status !== "pending" && current.submission.status !== "needs_more_evidence") {
        throw new Error("Submission has already been reviewed");
      }

      const submitter = this.getAccountById(current.submission.userId);
      if (!submitter) {
        throw new Error("Submitter not found");
      }

      let awarded = 0;
      const isOwnReview = current.submission.userId === input.reviewerId;

      if (input.status === "approved") {
        const unresolvedCatalogItem = current.items.find((item) => {
          if (!item.requiresCatalogApproval || !item.normalizedBeerId) return false;
          const row = this.database
            .prepare("SELECT status FROM beer_catalog_items WHERE key = ? LIMIT 1")
            .get(item.normalizedBeerId) as { status: string } | undefined;
          return row?.status !== "active";
        });
        if (unresolvedCatalogItem) {
          throw new Error(`OCR beer requires catalogue approval: ${unresolvedCatalogItem.beerName}`);
        }

        awarded = submitter.status === "suspended" || isOwnReview ? 0 : this.insertContributionLedger({
          userId: submitter.id,
          submissionId: current.submission.id,
          venueId: current.submission.venueId,
          points: input.pointsAwarded,
          reason: current.submission.submissionType,
          monthKey: input.monthKey,
          now: input.now,
        });

        this.publishPendingVenueIfNeeded(current, input.now);
        this.publishSubmissionPriceRecords(current, input.confidence, input.now);
        this.database
          .prepare(
            `UPDATE accounts
             SET approved_submission_count = approved_submission_count + 1,
                 trust_score = min(100, trust_score + 3),
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(input.now, submitter.id);
      } else if (input.status !== "needs_more_evidence") {
        const isFraud = input.status === "fraud_flagged" || input.fraudFlagged;
        const trustPenalty = isFraud ? 20 : input.status === "disputed" ? 2 : 4;
        this.database
          .prepare(
            `UPDATE accounts
             SET rejected_submission_count = rejected_submission_count + 1,
                 fraud_strike_count = fraud_strike_count + ?,
                 trust_score = max(0, trust_score - ?),
                 status = CASE
                   WHEN fraud_strike_count + ? >= 3 THEN 'suspended'
                   WHEN ? = 1 THEN 'warned'
                   ELSE status
                 END,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(isFraud ? 1 : 0, trustPenalty, isFraud ? 1 : 0, isFraud ? 1 : 0, input.now, submitter.id);
        const accountAfterReview = this.getAccountById(submitter.id);
        if (accountAfterReview?.status === "suspended") {
          this.database.prepare(
            "UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
          ).run(input.now, submitter.id);
          this.database.prepare(
            "UPDATE account_discount_passes SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'",
          ).run(input.now, submitter.id);
          this.database.prepare(
            "UPDATE free_pint_reward_codes SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
          ).run(input.now, submitter.id);
        }
      }

      this.database
        .prepare(
          `UPDATE submissions
           SET status = ?,
               points_awarded = ?,
               reviewed_by = ?,
               reviewed_at = ?,
               rejection_reason = ?,
               fraud_flagged = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.status,
          awarded,
          input.reviewerId,
          input.now,
          input.rejectionReason,
          input.status === "fraud_flagged" || input.fraudFlagged ? 1 : 0,
          input.now,
          input.submissionId,
        );

      if (current.submission.missionId) {
        const missionStatus: MissionProgressStatus = input.status === "approved" ? "completed" : "needs_revision";
        const missionProgressUpdate = this.database
          .prepare(
            `UPDATE mission_progress
             SET status = ?,
                 completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END,
                 updated_at = ?
             WHERE mission_id = ?
               AND user_id = ?
               AND submission_id = ?
               AND status = 'submitted'`,
          )
          .run(
            missionStatus,
            missionStatus,
            input.now,
            input.now,
            current.submission.missionId,
            current.submission.userId,
            input.submissionId,
          );
        if (input.status === "approved" && missionProgressUpdate.changes !== 1) {
          throw new MissionReservationError("This mission was already completed or reassigned.");
        }
        if (input.status === "approved") {
          this.database
            .prepare(
              `UPDATE mission_progress
               SET status = 'cancelled', completed_at = NULL, updated_at = ?
               WHERE mission_id = ?
                 AND user_id != ?
                 AND status IN ('accepted', 'submitted')`,
            )
            .run(input.now, current.submission.missionId, current.submission.userId);
          this.database
            .prepare(
              `UPDATE submissions
               SET mission_id = NULL, updated_at = ?
               WHERE mission_id = ?
                 AND user_id != ?
                 AND status IN ('pending', 'needs_more_evidence')`,
            )
            .run(input.now, current.submission.missionId, current.submission.userId);
          this.database
            .prepare("UPDATE missions SET active = 0, updated_at = ? WHERE id = ?")
            .run(input.now, current.submission.missionId);
        }
      }

      const currentMonthPoints = this.refreshCurrentMonthPoints(submitter.id, input.monthKey);
      const accountAfterPoints = this.getAccountById(submitter.id)!;

      if (
        input.status === "approved" &&
        currentMonthPoints >= input.contributorUnlockPoints &&
        accountAfterPoints.subscriptionStatus !== "premium_monthly" &&
        accountAfterPoints.subscriptionStatus !== "premium_yearly" &&
        accountAfterPoints.subscriptionStatus !== "admin"
      ) {
        this.updateSubscription({
          userId: submitter.id,
          subscriptionStatus: "contributor_unlocked",
          premiumUntil: input.premiumUntil,
          now: input.now,
        });
      }

      return {
        submission: this.getSubmissionById(input.submissionId)!.submission,
        pointsAwarded: awarded,
        account: this.getAccountById(submitter.id)!,
      };
    });

    return review.immediate();
  }

  private publishSubmissionPriceRecords(
    current: { submission: BusinessSubmission; items: BusinessSubmissionItem[] },
    confidence: ConfidenceLabel,
    now: string,
  ): void {
    const insert = this.database.prepare(
      `INSERT INTO venue_price_records (
        id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, serving_size,
        price, is_happy_hour_price, happy_hour_details, is_on_tap, confidence,
        source_type, source_submission_id, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVenueBeer = this.database.prepare(
      `INSERT INTO venue_beers (
        id, venue_id, beer_name, normalized_beer_id, brewery, style, abv, serve_size, price, currency,
        on_tap, in_stock, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        beer_name = excluded.beer_name,
        normalized_beer_id = excluded.normalized_beer_id,
        serve_size = excluded.serve_size,
        price = excluded.price,
        on_tap = excluded.on_tap,
        in_stock = excluded.in_stock,
        notes = excluded.notes,
        updated_at = excluded.updated_at`,
    );

    for (const item of current.items) {
      insert.run(
        `${current.submission.id}:${item.id}`,
        current.submission.venueId,
        current.submission.venueName,
        current.submission.suburb,
        item.beerName,
        item.normalizedBeerId,
        item.servingSize,
        item.price,
        item.isHappyHourPrice ? 1 : 0,
        item.happyHourDetails,
        item.isOnTap,
        confidence,
        current.submission.sourcePhotoUrl ? "photo_upload" : "manual_submission",
        current.submission.id,
        current.submission.observedAt,
        now,
        now,
      );

      if (current.submission.pendingVenue && !item.isHappyHourPrice) {
        const beerKey = (item.normalizedBeerId || item.beerName)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || item.id;
        insertVenueBeer.run(
          `approved-submission:${current.submission.venueId}:${beerKey}:${item.servingSize}`,
          current.submission.venueId,
          item.beerName,
          item.normalizedBeerId,
          null,
          null,
          null,
          item.servingSize,
          item.price,
          "AUD",
          item.isOnTap === "yes" ? 1 : 0,
          item.isOnTap === "no" ? 0 : 1,
          "Approved user-submitted venue launch row.",
          now,
          now,
        );
      }
    }
  }

  publishPendingVenue(input: {
    venueId: string;
    venueName: string;
    suburb: string | null;
    pendingVenue: PendingVenueDetails | null;
    now: string;
  }): void {
    const pendingVenue = input.pendingVenue;
    if (!pendingVenue) {
      return;
    }

    this.upsertBarProfile({
      barId: input.venueId,
      name: pendingVenue.name || input.venueName,
      address: pendingVenue.address,
      suburb: pendingVenue.suburb ?? input.suburb,
      area: pendingVenue.suburb ?? input.suburb,
      phone: pendingVenue.phone,
      website: pendingVenue.website,
      instagram: null,
      description: "User-submitted venue. Beer data is reviewed before prices appear publicly.",
      openingHours: {},
      venueTags: ["user submitted"],
      membershipTier: "basic",
      highlightedName: false,
      premiumBadge: null,
      promoted: false,
      featuredSpecialEligible: false,
      active: true,
      now: input.now,
    });

    this.upsertVenueLocationCache({
      venueId: input.venueId,
      venueName: pendingVenue.name || input.venueName,
      suburb: pendingVenue.suburb ?? input.suburb,
      latitude: pendingVenue.latitude,
      longitude: pendingVenue.longitude,
      now: input.now,
    });
  }

  private publishPendingVenueIfNeeded(
    current: { submission: BusinessSubmission; items: BusinessSubmissionItem[] },
    now: string,
  ): void {
    this.publishPendingVenue({
      venueId: current.submission.venueId,
      venueName: current.submission.venueName,
      suburb: current.submission.suburb,
      pendingVenue: current.submission.pendingVenue,
      now,
    });
  }

  private insertContributionLedger(input: {
    userId: string;
    submissionId: string;
    venueId: string;
    points: number;
    reason: string;
    monthKey: string;
    now: string;
  }): number {
    if (input.points <= 0) {
      return 0;
    }

    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO contribution_ledger (
          id, user_id, submission_id, venue_id, points, reason, month_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${input.userId}:${input.venueId}:${input.monthKey}`,
        input.userId,
        input.submissionId,
        input.venueId,
        input.points,
        input.reason,
        input.monthKey,
        input.now,
      );

    return result.changes > 0 ? input.points : 0;
  }

  getContributionPointsForMonth(userId: string, monthKey: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(sum(points), 0) AS points FROM contribution_ledger WHERE user_id = ? AND month_key = ?")
      .get(userId, monthKey) as { points: number } | undefined;
    return Number(row?.points ?? 0);
  }

  private refreshCurrentMonthPoints(userId: string, monthKey: string): number {
    const points = this.getContributionPointsForMonth(userId, monthKey);

    this.database
      .prepare("UPDATE accounts SET contribution_points_current_month = ? WHERE id = ?")
      .run(points, userId);

    return points;
  }

  createMission(input: Omit<BusinessMission, "active" | "sponsorFlag"> & { active?: boolean; sponsorFlag?: boolean }): BusinessMission {
    this.database
      .prepare(
        `INSERT INTO missions (
          id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
          active, sponsor_flag, last_verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.venueId,
        input.venueName,
        input.suburb,
        input.reason,
        input.priority,
        input.points,
        input.multiplier,
        input.active === false ? 0 : 1,
        input.sponsorFlag ? 1 : 0,
        input.lastVerifiedAt,
        input.createdAt,
        input.updatedAt,
      );
    return this.getMissionById(input.id)!;
  }

  getMissionById(id: string): BusinessMission | null {
    const row = this.database.prepare("SELECT * FROM missions WHERE id = ?").get(id) as MissionRow | undefined;
    return row ? toMission(row) : null;
  }

  acceptMission(input: {
    missionId: string;
    userId: string;
    now: string;
    acceptedAfter: string;
  }): MissionProgress | null {
    const accept = this.database.transaction(() => {
      const activeMission = this.database
        .prepare("SELECT 1 AS active FROM missions WHERE id = ? AND active = 1 LIMIT 1")
        .get(input.missionId) as { active: number } | undefined;
      if (!activeMission) return null;

      this.database
        .prepare(
          `UPDATE mission_progress
           SET status = 'cancelled', completed_at = NULL, updated_at = ?
           WHERE mission_id = ?
             AND status = 'accepted'
             AND (
               julianday(accepted_at) IS NULL
               OR julianday(accepted_at) <= julianday(?)
             )`,
        )
        .run(input.now, input.missionId, input.acceptedAfter);

      const competingReservation = this.database
        .prepare(
          `SELECT 1 AS reserved
           FROM mission_progress
           WHERE mission_id = ?
             AND user_id != ?
             AND status IN ('accepted', 'submitted')
           LIMIT 1`,
        )
        .get(input.missionId, input.userId) as { reserved: number } | undefined;
      if (competingReservation) return null;

      const existing = this.getMissionProgress({ missionId: input.missionId, userId: input.userId });
      if (existing && ["accepted", "submitted", "completed"].includes(existing.status)) {
        return existing;
      }

      this.database
        .prepare(
          `INSERT INTO mission_progress (
            id, mission_id, user_id, submission_id, status, accepted_at, submitted_at, completed_at, updated_at
          ) VALUES (?, ?, ?, NULL, 'accepted', ?, NULL, NULL, ?)
          ON CONFLICT(mission_id, user_id) DO UPDATE SET
            submission_id = NULL,
            status = 'accepted',
            accepted_at = excluded.accepted_at,
            submitted_at = NULL,
            completed_at = NULL,
            updated_at = excluded.updated_at`,
        )
        .run(crypto.randomUUID(), input.missionId, input.userId, input.now, input.now);
      return this.getMissionProgress({ missionId: input.missionId, userId: input.userId });
    });

    return accept.immediate();
  }

  expireAcceptedMissionProgress(input: { acceptedBefore: string; now: string }): number {
    return this.database
      .prepare(
        `UPDATE mission_progress
         SET status = 'cancelled', completed_at = NULL, updated_at = ?
         WHERE status = 'accepted'
           AND (
             julianday(accepted_at) IS NULL
             OR julianday(accepted_at) <= julianday(?)
           )`,
      )
      .run(input.now, input.acceptedBefore).changes;
  }

  releaseAcceptedMission(input: { missionId: string; userId: string; now: string }): MissionProgress | null {
    const result = this.database
      .prepare(
        `UPDATE mission_progress
         SET status = 'cancelled', completed_at = NULL, updated_at = ?
         WHERE mission_id = ? AND user_id = ? AND status = 'accepted'`,
      )
      .run(input.now, input.missionId, input.userId);
    return result.changes === 1
      ? this.getMissionProgress({ missionId: input.missionId, userId: input.userId })
      : null;
  }

  listUnavailableMissionIds(input: { userId?: string | undefined; acceptedAfter: string }): Set<string> {
    const values: unknown[] = [input.acceptedAfter];
    const otherUserClause = input.userId ? "AND user_id != ?" : "";
    if (input.userId) values.push(input.userId);
    const rows = this.database
      .prepare(
        `SELECT DISTINCT mission_id
         FROM mission_progress
         WHERE (
           status = 'submitted'
           OR (status = 'accepted' AND julianday(accepted_at) > julianday(?))
         )
         ${otherUserClause}`,
      )
      .all(...values) as Array<{ mission_id: string }>;
    return new Set(rows.map((row) => row.mission_id));
  }

  getMissionProgress(input: { missionId: string; userId: string }): MissionProgress | null {
    const row = this.database
      .prepare("SELECT * FROM mission_progress WHERE mission_id = ? AND user_id = ? LIMIT 1")
      .get(input.missionId, input.userId) as MissionProgressRow | undefined;
    return row ? toMissionProgress(row) : null;
  }

  listMissionProgressForUser(userId: string, limit = -1): MissionProgress[] {
    const rows = this.database
      .prepare("SELECT * FROM mission_progress WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(userId, limit) as MissionProgressRow[];
    return rows.map(toMissionProgress);
  }

  updateMissionProgressForSubmission(input: {
    submissionId: string;
    status: Extract<MissionProgressStatus, "completed" | "needs_revision">;
    now: string;
  }): MissionProgress | null {
    this.database
      .prepare(
        `UPDATE mission_progress
         SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END, updated_at = ?
         WHERE submission_id = ?`,
      )
      .run(input.status, input.status, input.now, input.now, input.submissionId);
    const row = this.database
      .prepare("SELECT * FROM mission_progress WHERE submission_id = ? LIMIT 1")
      .get(input.submissionId) as MissionProgressRow | undefined;
    return row ? toMissionProgress(row) : null;
  }

  setMissionActive(input: { missionId: string; active: boolean; now: string }): boolean {
    const result = this.database
      .prepare("UPDATE missions SET active = ?, updated_at = ? WHERE id = ?")
      .run(input.active ? 1 : 0, input.now, input.missionId);
    return result.changes === 1;
  }

  deleteMissionIfUnused(missionId: string): boolean {
    const result = this.database
      .prepare(
        `DELETE FROM missions
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM mission_progress WHERE mission_id = missions.id)
           AND NOT EXISTS (SELECT 1 FROM submissions WHERE mission_id = missions.id)
           AND NOT EXISTS (SELECT 1 FROM venue_requests WHERE mission_id = missions.id)`,
      )
      .run(missionId);
    return result.changes === 1;
  }

  deactivateDemoMissions(now: string): number {
    return this.database
      .prepare(
        `UPDATE missions
         SET active = 0, updated_at = ?
         WHERE active = 1
           AND (venue_id LIKE 'demo:%' OR id LIKE 'mission:%' AND venue_id LIKE 'demo:%')`,
      )
      .run(now).changes;
  }

  getSystemState<T extends Record<string, unknown>>(key: string): { value: T; updatedAt: string } | null {
    const row = this.database
      .prepare("SELECT value_json, updated_at FROM system_state WHERE key = ?")
      .get(key) as { value_json: string; updated_at: string } | undefined;
    return row ? { value: parseJsonObject(row.value_json) as T, updatedAt: row.updated_at } : null;
  }

  getVenueReportDeliverySettings(venueId: string): {
    enabled: boolean;
    recipients: string[];
    updatedAt: string | null;
    configured: boolean;
  } {
    const stored = this.getSystemState<{ enabled?: unknown; recipients?: unknown }>(
      `venue-report-delivery:${venueId}`,
    );
    if (!stored) {
      return { enabled: true, recipients: [], updatedAt: null, configured: false };
    }
    return {
      enabled: stored.value.enabled !== false,
      recipients: Array.isArray(stored.value.recipients)
        ? stored.value.recipients
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 10)
        : [],
      updatedAt: stored.updatedAt,
      configured: true,
    };
  }

  setVenueReportDeliverySettings(input: {
    venueId: string;
    enabled: boolean;
    recipients: string[];
    updatedBy: string;
    now: string;
  }): void {
    this.setSystemState(
      `venue-report-delivery:${input.venueId}`,
      {
        enabled: input.enabled,
        recipients: input.recipients,
        updatedBy: input.updatedBy,
      },
      input.now,
    );
  }

  setSystemState(key: string, value: Record<string, unknown>, now: string): void {
    this.database
      .prepare(
        `INSERT INTO system_state (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), now);
  }

  compareAndSetSystemState(
    key: string,
    expectedUpdatedAt: string | null,
    value: Record<string, unknown>,
    now: string,
  ): boolean {
    const serialized = JSON.stringify(value);
    const result = expectedUpdatedAt === null
      ? this.database
          .prepare(
            `INSERT INTO system_state (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO NOTHING`,
          )
          .run(key, serialized, now)
      : this.database
          .prepare(
            `UPDATE system_state
             SET value_json = ?, updated_at = ?
             WHERE key = ? AND updated_at = ?`,
          )
          .run(serialized, now, key, expectedUpdatedAt);
    return result.changes === 1;
  }

  acquireSystemLease(input: {
    key: string;
    owner: string;
    now: string;
    leaseUntil: string;
  }): boolean {
    try {
      return this.database.transaction(() => {
        const stored = this.getSystemState<{ owner?: unknown; leaseUntil?: unknown }>(input.key);
        const activeLeaseUntil = typeof stored?.value.leaseUntil === "string"
          ? Date.parse(stored.value.leaseUntil)
          : Number.NaN;
        if (Number.isFinite(activeLeaseUntil) && activeLeaseUntil > Date.parse(input.now)) {
          return false;
        }
        this.setSystemState(input.key, {
          owner: input.owner,
          leaseUntil: input.leaseUntil,
          acquiredAt: input.now,
        }, input.now);
        return true;
      })();
    } catch {
      return false;
    }
  }

  releaseSystemLease(input: { key: string; owner: string; now: string }): boolean {
    return this.database.transaction(() => {
      const stored = this.getSystemState<{ owner?: unknown }>(input.key);
      if (stored?.value.owner !== input.owner) return false;
      this.setSystemState(input.key, {
        owner: input.owner,
        leaseUntil: input.now,
        releasedAt: input.now,
      }, input.now);
      return true;
    })();
  }

  countMissions(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM missions").get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  listMissions(filters: { activeOnly: boolean; suburb?: string | undefined; limit: number; offset?: number | undefined }): BusinessMission[] {
    const where: string[] = [];
    const values: unknown[] = [];

    if (filters.activeOnly) {
      where.push("active = 1");
    }

    if (filters.suburb) {
      where.push("lower(suburb) = lower(?)");
      values.push(filters.suburb);
    }

    values.push(filters.limit, Math.max(0, filters.offset ?? 0));
    const rows = this.database
      .prepare(
        `SELECT * FROM missions
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY (points * multiplier) DESC, updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...values) as MissionRow[];
    return rows.map(toMission);
  }

  listMissionFeedPage(input: {
    userId?: string | null | undefined;
    suburb?: string | undefined;
    searchTerms: string[];
    savedSuburbs: string[];
    savedOnly: boolean;
    latitude?: number | undefined;
    longitude?: number | undefined;
    radiusMeters: number;
    sort: "points" | "saved" | "stale" | "no_data" | "missing_happy_hour" | "most_requested" | "high_demand" | "nearby";
    limit: number;
    offset: number;
    acceptedAfter: string;
    veryFreshCutoff: string;
    weekOldCutoff: string;
    veryFreshPoints: number;
    weekOldPoints: number;
    stalePoints: number;
    newVenuePoints: number;
  }): { missions: BusinessMissionFeedItem[]; total: number } {
    if (input.savedOnly && input.savedSuburbs.length === 0) {
      return { missions: [], total: 0 };
    }
    const hasLocation = typeof input.latitude === "number" && typeof input.longitude === "number";
    const params: Record<string, string | number | null> = {
      userId: input.userId ?? null,
      suburb: input.suburb ?? null,
      acceptedAfter: input.acceptedAfter,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      radiusMeters: input.radiusMeters,
      veryFreshCutoff: input.veryFreshCutoff,
      weekOldCutoff: input.weekOldCutoff,
      veryFreshPoints: input.veryFreshPoints,
      weekOldPoints: input.weekOldPoints,
      stalePoints: input.stalePoints,
      newVenuePoints: input.newVenuePoints,
      limit: Math.max(1, input.limit),
      offset: Math.max(0, input.offset),
    };
    const searchClauses = input.searchTerms.map((term, index) => {
      params[`search${index}`] = `%${term.toLowerCase()}%`;
      return `lower(mission.venue_name || ' ' || COALESCE(mission.suburb, '') || ' ' || COALESCE(profile.address, '') || ' ' || mission.reason) LIKE @search${index}`;
    });
    const savedClause = input.savedOnly
      ? `AND lower(COALESCE(mission.suburb, '')) IN (${input.savedSuburbs.map((suburb, index) => {
          params[`saved${index}`] = suburb.toLowerCase();
          return `@saved${index}`;
        }).join(", ")})`
      : "";
    const distanceExpression = `2 * 6371000 * asin(sqrt(min(1,
      pow(sin(radians(latitude - @latitude) / 2), 2) +
      cos(radians(@latitude)) * cos(radians(latitude)) *
      pow(sin(radians(longitude - @longitude) / 2), 2)
    )))`;
    const commonCte = `WITH price_freshness AS (
      SELECT venue_id, max(last_verified_at) AS latest_verified_at
      FROM venue_price_records
      GROUP BY venue_id
    ), base AS (
      SELECT mission.*,
        profile.address AS venue_address,
        location.latitude,
        location.longitude,
        progress.status AS user_progress,
        progress.accepted_at AS reservation_accepted_at,
        CASE WHEN mission.id LIKE 'auto:%'
          THEN mission.last_verified_at
          ELSE COALESCE(price_freshness.latest_verified_at, mission.last_verified_at)
        END AS effective_last_verified_at
      FROM missions mission
      LEFT JOIN venue_profiles profile ON profile.venue_id = mission.venue_id
      LEFT JOIN venue_location_cache location ON location.venue_id = mission.venue_id
      LEFT JOIN price_freshness ON price_freshness.venue_id = mission.venue_id
      LEFT JOIN mission_progress progress
        ON progress.mission_id = mission.id AND progress.user_id = @userId
      WHERE mission.active = 1
        AND (@suburb IS NULL OR lower(COALESCE(mission.suburb, '')) = lower(@suburb))
        ${savedClause}
        ${searchClauses.length ? `AND ${searchClauses.join(" AND ")}` : ""}
        AND NOT EXISTS (
          SELECT 1 FROM mission_progress unavailable
          WHERE unavailable.mission_id = mission.id
            AND (unavailable.status = 'submitted'
              OR (unavailable.status = 'accepted' AND julianday(unavailable.accepted_at) > julianday(@acceptedAfter)))
            AND (@userId IS NULL OR unavailable.user_id != @userId)
        )
    ), scored AS (
      SELECT base.*,
        CASE
          WHEN effective_last_verified_at IS NULL
            OR lower(reason) LIKE '%no data%'
            OR lower(reason) LIKE '%no prices%'
            OR lower(reason) LIKE '%new venue%'
            OR ((lower(reason) LIKE '%new%' OR lower(reason) LIKE '%missing%')
                AND (lower(reason) LIKE '%beer%' OR lower(reason) LIKE '%drink%' OR lower(reason) LIKE '%price%'))
            THEN @newVenuePoints
          WHEN effective_last_verified_at >= @veryFreshCutoff THEN @veryFreshPoints
          WHEN effective_last_verified_at >= @weekOldCutoff THEN @weekOldPoints
          ELSE @stalePoints
        END AS dynamic_points,
        CASE WHEN @latitude IS NOT NULL AND @longitude IS NOT NULL
          AND latitude IS NOT NULL AND longitude IS NOT NULL
          THEN ${distanceExpression}
          ELSE NULL
        END AS distance_meters
      FROM base
    ), eligible AS (
      SELECT * FROM scored
      WHERE @latitude IS NULL OR @longitude IS NULL
        OR (distance_meters IS NOT NULL AND distance_meters <= @radiusMeters)
    )`;
    const orderBy = input.sort === "nearby" && hasLocation
      ? "distance_meters ASC, (dynamic_points * multiplier) DESC, updated_at DESC, id ASC"
      : input.sort === "stale"
        ? "COALESCE(effective_last_verified_at, '') ASC, id ASC"
        : input.sort === "no_data"
          ? "CASE WHEN effective_last_verified_at IS NULL THEN 0 ELSE 1 END ASC, (dynamic_points * multiplier) DESC, id ASC"
          : input.sort === "missing_happy_hour"
            ? "CASE WHEN lower(reason) LIKE '%happy%' THEN 0 ELSE 1 END ASC, (dynamic_points * multiplier) DESC, id ASC"
            : "(dynamic_points * multiplier) DESC, updated_at DESC, id ASC";
    const rows = this.database.prepare(
      `${commonCte}
       SELECT * FROM eligible
       ORDER BY ${orderBy}
       LIMIT @limit OFFSET @offset`,
    ).all(params) as Array<MissionRow & {
      venue_address: string | null;
      latitude: number | null;
      longitude: number | null;
      user_progress: MissionProgressStatus | null;
      reservation_accepted_at: string | null;
      effective_last_verified_at: string | null;
      dynamic_points: number;
      distance_meters: number | null;
    }>;
    const countRow = this.database.prepare(`${commonCte} SELECT count(*) AS count FROM eligible`).get(params) as { count: number };
    return {
      missions: rows.map((row) => ({
        ...toMission(row),
        points: Number(row.dynamic_points),
        lastVerifiedAt: row.effective_last_verified_at,
        venueAddress: row.venue_address,
        latitude: row.latitude,
        longitude: row.longitude,
        distanceMeters: row.distance_meters == null ? null : Math.round(row.distance_meters),
        distanceKm: row.distance_meters == null ? null : Math.round((row.distance_meters / 1000) * 10) / 10,
        userProgress: row.user_progress,
        reservationAcceptedAt: row.user_progress === "accepted" ? row.reservation_accepted_at : null,
      })),
      total: Number(countRow.count ?? 0),
    };
  }

  listMissionVenueCandidates(limit: number, offset = 0): MissionVenueCandidate[] {
    const rows = this.database
      .prepare(
        `WITH known_venue_ids AS (
           SELECT venue_id FROM venue_location_cache WHERE venue_id IS NOT NULL AND venue_id != ''
           UNION
           SELECT venue_id FROM venue_price_records WHERE venue_id IS NOT NULL AND venue_id != ''
           UNION
           SELECT venue_id FROM venue_profiles WHERE venue_id IS NOT NULL AND venue_id != '' AND active = 1
           UNION
           SELECT venue_id FROM venue_requests WHERE venue_id IS NOT NULL AND venue_id != ''
           UNION
           SELECT venue_id FROM missions
           WHERE venue_id IS NOT NULL
             AND venue_id != ''
             AND id NOT LIKE 'auto:%'
             AND active = 1
         )
         SELECT
           ids.venue_id AS venue_id,
           COALESCE(
             (SELECT name FROM venue_profiles profile WHERE profile.venue_id = ids.venue_id AND profile.active = 1 LIMIT 1),
             (SELECT venue_name FROM venue_location_cache location WHERE location.venue_id = ids.venue_id LIMIT 1),
             (SELECT venue_name FROM venue_price_records record WHERE record.venue_id = ids.venue_id ORDER BY record.last_verified_at DESC LIMIT 1),
             (SELECT venue_name FROM venue_requests request WHERE request.venue_id = ids.venue_id ORDER BY request.created_at DESC LIMIT 1),
             (SELECT venue_name FROM missions mission WHERE mission.venue_id = ids.venue_id AND mission.id NOT LIKE 'auto:%' AND mission.active = 1 ORDER BY mission.updated_at DESC LIMIT 1),
             ids.venue_id
           ) AS venue_name,
           COALESCE(
             (SELECT suburb FROM venue_profiles profile WHERE profile.venue_id = ids.venue_id AND profile.active = 1 LIMIT 1),
             (SELECT suburb FROM venue_location_cache location WHERE location.venue_id = ids.venue_id LIMIT 1),
             (SELECT suburb FROM venue_price_records record WHERE record.venue_id = ids.venue_id ORDER BY record.last_verified_at DESC LIMIT 1),
             (SELECT suburb FROM venue_requests request WHERE request.venue_id = ids.venue_id ORDER BY request.created_at DESC LIMIT 1),
             (SELECT suburb FROM missions mission WHERE mission.venue_id = ids.venue_id AND mission.id NOT LIKE 'auto:%' AND mission.active = 1 ORDER BY mission.updated_at DESC LIMIT 1)
           ) AS suburb,
           (SELECT max(last_verified_at) FROM venue_price_records record WHERE record.venue_id = ids.venue_id) AS latest_verified_at,
           (SELECT count(*) FROM venue_price_records record WHERE record.venue_id = ids.venue_id) AS record_count,
           (
             SELECT max(happy.verified_at)
             FROM (
               SELECT record.last_verified_at AS verified_at
               FROM venue_price_records record
               WHERE record.venue_id = ids.venue_id
                 AND (
                   record.is_happy_hour_price = 1
                   OR (record.happy_hour_details IS NOT NULL AND trim(record.happy_hour_details) != '')
                 )
               UNION ALL
               SELECT venue_happy.updated_at AS verified_at
               FROM venue_happy_hours venue_happy
               WHERE venue_happy.venue_id = ids.venue_id
                 AND venue_happy.active = 1
             ) happy
           ) AS happy_hour_last_verified_at
         FROM known_venue_ids ids
         ORDER BY latest_verified_at IS NOT NULL, latest_verified_at ASC, venue_name ASC, ids.venue_id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, Math.max(0, offset)) as Array<{
        venue_id: string;
        venue_name: string;
        suburb: string | null;
        latest_verified_at: string | null;
        record_count: number;
        happy_hour_last_verified_at: string | null;
      }>;

    return rows.map((row) => ({
      venueId: row.venue_id,
      venueName: row.venue_name,
      suburb: row.suburb,
      latestVerifiedAt: row.latest_verified_at,
      recordCount: Number(row.record_count ?? 0),
      happyHourLastVerifiedAt: row.happy_hour_last_verified_at,
    }));
  }

  getLatestVenueBeerTimestamp(input: {
    venueId: string;
    venueIds?: readonly string[];
    normalizedBeerId?: string | null;
    beerNames: readonly string[];
  }): string | null {
    const normalizedBeerId = input.normalizedBeerId?.trim();
    const names = Array.from(new Set(input.beerNames
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)));
    const clauses: string[] = [];
    const venueIds = Array.from(new Set((input.venueIds?.length ? input.venueIds : [input.venueId])
      .map((venueId) => venueId.trim())
      .filter(Boolean)));
    const values: unknown[] = [...venueIds];

    if (normalizedBeerId) {
      clauses.push("normalized_beer_id = ?");
      values.push(normalizedBeerId);
    }

    if (names.length) {
      clauses.push(`lower(trim(beer_name)) IN (${names.map(() => "?").join(", ")})`);
      values.push(...names);
    }

    if (!clauses.length) {
      return null;
    }

    const row = this.database
      .prepare(
        `SELECT max(last_verified_at) AS last_verified_at
         FROM venue_price_records
         WHERE venue_id IN (${venueIds.map(() => "?").join(", ")})
           AND (${clauses.join(" OR ")})`,
      )
      .get(...values) as { last_verified_at: string | null } | undefined;

    return row?.last_verified_at ?? null;
  }

  replaceAutoMissions(
    missions: Array<Omit<BusinessMission, "active" | "sponsorFlag"> & { active?: boolean; sponsorFlag?: boolean }>,
    now: string,
  ): number {
    const replace = this.database.transaction((generatedMissions: typeof missions) => {
      this.database
        .prepare(
          `UPDATE missions
           SET active = 0, updated_at = ?
           WHERE id LIKE 'auto:%'
             AND NOT EXISTS (
               SELECT 1
               FROM mission_progress progress
               WHERE progress.mission_id = missions.id
                 AND progress.status IN ('accepted', 'submitted')
             )`,
        )
        .run(now);

      const upsertMission = this.database.prepare(
        `INSERT INTO missions (
          id, venue_id, venue_name, suburb, reason, priority, points, multiplier,
          active, sponsor_flag, last_verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          venue_id = excluded.venue_id,
          venue_name = excluded.venue_name,
          suburb = excluded.suburb,
          reason = excluded.reason,
          priority = excluded.priority,
          points = excluded.points,
          multiplier = excluded.multiplier,
          active = excluded.active,
          sponsor_flag = excluded.sponsor_flag,
          last_verified_at = excluded.last_verified_at,
          updated_at = excluded.updated_at`,
      );

      for (const mission of generatedMissions) {
        upsertMission.run(
          mission.id,
          mission.venueId,
          mission.venueName,
          mission.suburb,
          mission.reason,
          mission.priority,
          mission.points,
          mission.multiplier,
          mission.active === false ? 0 : 1,
          mission.sponsorFlag ? 1 : 0,
          mission.lastVerifiedAt,
          mission.createdAt,
          mission.updatedAt,
        );
      }

      return generatedMissions.length;
    });

    return replace(missions);
  }

  pruneInactiveAutoMissions(): number {
    return this.database
      .prepare(
        `DELETE FROM missions
         WHERE id LIKE 'auto:%'
           AND active = 0
           AND NOT EXISTS (
             SELECT 1 FROM mission_progress progress WHERE progress.mission_id = missions.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM submissions submission WHERE submission.mission_id = missions.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM venue_requests request WHERE request.mission_id = missions.id
           )`,
      )
      .run().changes;
  }

  listLatestPriceRecords(limit: number, venueId?: string | null): PublicVenuePriceRecord[] {
    const where = venueId ? "WHERE venue_id = ?" : "";
    const values = venueId ? [venueId, limit] : [limit];
    const rows = this.database
      .prepare(`SELECT * FROM venue_price_records ${where} ORDER BY last_verified_at DESC LIMIT ?`)
      .all(...values) as PriceRecordRow[];
    return rows.map(toPriceRecord);
  }

  getPriceRecordById(id: string): PublicVenuePriceRecord | null {
    const row = this.database
      .prepare("SELECT * FROM venue_price_records WHERE id = ? LIMIT 1")
      .get(id) as PriceRecordRow | undefined;
    return row ? toPriceRecord(row) : null;
  }

  listCurrentPriceRecords(venueIds: string[] = []): PublicVenuePriceRecord[] {
    const normalizedVenueIds = Array.from(new Set(venueIds.map((id) => id.trim()).filter(Boolean)));
    const venueWhere = normalizedVenueIds.length
      ? `WHERE venue_id IN (${normalizedVenueIds.map(() => "?").join(", ")})`
      : "";
    const rows = this.database
      .prepare(
        `WITH ranked AS (
           SELECT *,
             row_number() OVER (
               PARTITION BY venue_id,
                 COALESCE(NULLIF(normalized_beer_id, ''), lower(trim(beer_name))),
                 serving_size,
                 is_happy_hour_price,
                 COALESCE(happy_hour_details, '')
               ORDER BY datetime(last_verified_at) DESC, datetime(updated_at) DESC, id DESC
             ) AS current_rank
           FROM venue_price_records
           ${venueWhere}
         )
         SELECT * FROM ranked
         WHERE current_rank = 1
         ORDER BY datetime(last_verified_at) DESC, id DESC`,
      )
      .all(...normalizedVenueIds) as PriceRecordRow[];
    return rows.map(toPriceRecord);
  }

  listCurrentPriceRecordPage(input: {
    venueIds?: string[] | undefined;
    limit: number;
    before?: { verifiedAt: string; id: string } | null | undefined;
  }): PublicVenuePriceRecord[] {
    const normalizedVenueIds = Array.from(new Set((input.venueIds ?? []).map((id) => id.trim()).filter(Boolean)));
    const venueWhere = normalizedVenueIds.length
      ? `WHERE venue_id IN (${normalizedVenueIds.map(() => "?").join(", ")})`
      : "";
    const cursorWhere = input.before
      ? `WHERE last_verified_at < ? OR (last_verified_at = ? AND id < ?)`
      : "";
    const values: unknown[] = [...normalizedVenueIds];
    if (input.before) {
      values.push(input.before.verifiedAt, input.before.verifiedAt, input.before.id);
    }
    values.push(Math.max(1, input.limit));
    const canonicalVenue = (alias: string) =>
      `COALESCE((SELECT identity.canonical_venue_id FROM venue_identity_aliases identity WHERE identity.alias_venue_id = ${alias}.venue_id LIMIT 1), ${alias}.venue_id)`;
    const rows = this.database.prepare(
      `WITH ranked AS (
         SELECT *,
           row_number() OVER (
             PARTITION BY ${canonicalVenue("venue_price_records")},
               COALESCE(NULLIF(normalized_beer_id, ''), lower(trim(beer_name))),
               serving_size,
               is_happy_hour_price,
               COALESCE(happy_hour_details, '')
             ORDER BY last_verified_at DESC, updated_at DESC, id DESC
           ) AS current_rank
         FROM venue_price_records
         ${venueWhere}
       ), current_records AS (
         SELECT * FROM ranked WHERE current_rank = 1
       ), authoritative_records AS (
         SELECT current.*
         FROM current_records current
         WHERE current.is_happy_hour_price = 1
            OR NOT EXISTS (
              SELECT 1
              FROM venue_beers manager_beer
              INNER JOIN venue_profiles manager_profile
                ON manager_profile.venue_id = manager_beer.venue_id
              WHERE manager_beer.on_tap = 1
                AND manager_beer.in_stock = 1
                AND manager_profile.active = 1
                AND ${canonicalVenue("manager_beer")} = ${canonicalVenue("current")}
                AND COALESCE(NULLIF(manager_beer.normalized_beer_id, ''), lower(trim(manager_beer.beer_name))) =
                    COALESCE(NULLIF(current.normalized_beer_id, ''), lower(trim(current.beer_name)))
                AND COALESCE(NULLIF(manager_beer.serve_size, ''), 'other') = COALESCE(NULLIF(current.serving_size, ''), 'other')
                AND COALESCE(manager_beer.price_verified_at, manager_beer.created_at) >= current.last_verified_at
            )
       )
       SELECT * FROM authoritative_records
       ${cursorWhere}
       ORDER BY last_verified_at DESC, id DESC
       LIMIT ?`,
    ).all(...values) as PriceRecordRow[];
    return rows.map(toPriceRecord);
  }

  upsertVenueIdentityAlias(input: {
    aliasVenueId: string;
    canonicalVenueId: string;
    identityKey: string;
    now: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO venue_identity_aliases (alias_venue_id, canonical_venue_id, identity_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(alias_venue_id) DO UPDATE SET
           canonical_venue_id = excluded.canonical_venue_id,
           identity_key = excluded.identity_key,
           updated_at = excluded.updated_at`,
      )
      .run(input.aliasVenueId, input.canonicalVenueId, input.identityKey, input.now, input.now);
  }

  getCanonicalVenueId(venueId: string): string {
    const row = this.database
      .prepare("SELECT canonical_venue_id FROM venue_identity_aliases WHERE alias_venue_id = ? LIMIT 1")
      .get(venueId) as { canonical_venue_id: string } | undefined;
    return row?.canonical_venue_id ?? venueId;
  }

  listVenueIdentityIds(venueId: string): string[] {
    const canonicalVenueId = this.getCanonicalVenueId(venueId);
    const rows = this.database
      .prepare("SELECT alias_venue_id FROM venue_identity_aliases WHERE canonical_venue_id = ?")
      .all(canonicalVenueId) as Array<{ alias_venue_id: string }>;
    return Array.from(new Set([canonicalVenueId, ...rows.map((row) => row.alias_venue_id)]));
  }

  getLatestVenueDataTimestamp(venueId: string): string | null {
    const row = this.database
      .prepare("SELECT max(last_verified_at) AS last_verified_at FROM venue_price_records WHERE venue_id = ?")
      .get(venueId) as { last_verified_at: string | null } | undefined;
    return row?.last_verified_at ?? null;
  }

  venueHasPublishedBeerRecord(input: {
    venueId: string;
    beerName: string;
    normalizedBeerId?: string | null;
  }): boolean {
    const normalizedBeerId = input.normalizedBeerId?.trim();
    if (normalizedBeerId) {
      const row = this.database
        .prepare("SELECT 1 AS exists_flag FROM venue_price_records WHERE venue_id = ? AND normalized_beer_id = ? LIMIT 1")
        .get(input.venueId, normalizedBeerId) as { exists_flag: number } | undefined;
      if (row) {
        return true;
      }
    }

    const beerName = input.beerName.trim().toLowerCase();
    if (!beerName) {
      return false;
    }

    const row = this.database
      .prepare("SELECT 1 AS exists_flag FROM venue_price_records WHERE venue_id = ? AND lower(trim(beer_name)) = ? LIMIT 1")
      .get(input.venueId, beerName) as { exists_flag: number } | undefined;
    return Boolean(row);
  }

  upsertVenueLocationCache(input: {
    venueId: string;
    venueName: string;
    suburb: string | null;
    latitude: number | null;
    longitude: number | null;
    now: string;
  }): VenueLocationCache {
    this.database
      .prepare(
        `INSERT INTO venue_location_cache (
          venue_id, venue_name, suburb, latitude, longitude, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(venue_id) DO UPDATE SET
          venue_name = excluded.venue_name,
          suburb = excluded.suburb,
          latitude = excluded.latitude,
          longitude = excluded.longitude,
          updated_at = excluded.updated_at`,
      )
      .run(input.venueId, input.venueName, input.suburb, input.latitude, input.longitude, input.now);

    return this.getVenueLocationCache(input.venueId)!;
  }

  getVenueLocationCache(venueId: string): VenueLocationCache | null {
    const row = this.database
      .prepare("SELECT * FROM venue_location_cache WHERE venue_id = ?")
      .get(venueId) as VenueLocationCacheRow | undefined;
    return row ? toVenueLocationCache(row) : null;
  }

  findLikelyVenueDuplicate(input: { name: string; suburb?: string | null | undefined }): VenueDuplicateCandidate | null {
    const name = input.name.trim().toLowerCase();
    const suburb = input.suburb?.trim().toLowerCase() || null;
    if (!name) {
      return null;
    }

    const rows = this.database
      .prepare(
        `WITH candidates AS (
           SELECT venue_id, name AS venue_name, suburb, 'venue_profile' AS source
             FROM venue_profiles
            WHERE active = 1
           UNION ALL
           SELECT venue_id, venue_name, suburb, 'location_cache' AS source
             FROM venue_location_cache
           UNION ALL
           SELECT venue_id, venue_name, suburb, 'price_record' AS source
             FROM venue_price_records
         )
         SELECT venue_id, venue_name, suburb, source
           FROM candidates
          WHERE lower(trim(venue_name)) = ?
          ORDER BY
            CASE
              WHEN ? IS NOT NULL AND lower(trim(COALESCE(suburb, ''))) = ? THEN 0
              ELSE 1
            END,
            source ASC
          LIMIT 5`,
      )
      .all(name, suburb, suburb) as Array<{
        venue_id: string;
        venue_name: string;
        suburb: string | null;
        source: string;
      }>;

    const best = rows.find((row) => !suburb || (row.suburb || "").trim().toLowerCase() === suburb) ?? rows[0];
    return best
      ? {
        venueId: best.venue_id,
        venueName: best.venue_name,
        suburb: best.suburb,
        source: best.source,
      }
      : null;
  }

  listLocalVenues(input: { query?: string | undefined; limit: number }): LocalVenueLookup[] {
    const query = input.query?.trim().toLowerCase() ?? "";
    const escapedQuery = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const pattern = `%${escapedQuery}%`;
    const rows = this.database
      .prepare(
        `SELECT
           profile.venue_id AS id,
           profile.name AS name,
           profile.address AS address,
           profile.suburb AS suburb,
           profile.phone AS phone,
           profile.website AS website,
           profile.instagram AS instagram,
           profile.description AS description,
           profile.opening_hours_json AS opening_hours_json,
           profile.venue_tags_json AS venue_tags_json,
           location.latitude AS latitude,
           location.longitude AS longitude
         FROM venue_profiles profile
         LEFT JOIN venue_location_cache location ON location.venue_id = profile.venue_id
         WHERE profile.active = 1
           AND (? = '' OR lower(
             profile.name || ' ' || COALESCE(profile.suburb, '') || ' ' || COALESCE(profile.address, '')
           ) LIKE ? ESCAPE '\\')
         ORDER BY profile.name COLLATE NOCASE ASC
         LIMIT ?`,
      )
      .all(query, pattern, input.limit < 0 ? -1 : input.limit) as Array<{
        id: string;
        name: string;
        address: string | null;
        suburb: string | null;
        phone: string | null;
        website: string | null;
        instagram: string | null;
        description: string | null;
        opening_hours_json: string;
        venue_tags_json: string | null;
        latitude: number | null;
        longitude: number | null;
      }>;

    return rows.map((row) => {
        const venueTags = parseJsonArray(row.venue_tags_json ?? "[]");
        return {
          id: row.id,
          name: row.name,
          address: row.address,
          suburb: row.suburb,
          state: "VIC",
          postcode: null,
          latitude: row.latitude,
          longitude: row.longitude,
          phone: row.phone,
          website: row.website,
          instagram: row.instagram,
          description: row.description,
          openingHours: parseJsonObject(row.opening_hours_json),
          venueTags,
          isUserSubmittedVenue: venueTags.includes("user submitted"),
        };
      });
  }

  listPublicVenueDirectoryPage(input: {
    query?: string | undefined;
    limit: number;
    offset: number;
  }): { venues: LocalVenueLookup[]; total: number } {
    const query = input.query?.trim().toLowerCase() ?? "";
    const escapedQuery = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const pattern = `%${escapedQuery}%`;
    const directoryCte = `WITH candidates AS (
      SELECT
        profile.venue_id AS id,
        profile.name AS name,
        profile.address AS address,
        profile.suburb AS suburb,
        'VIC' AS state,
        NULL AS postcode,
        location.latitude AS latitude,
        location.longitude AS longitude,
        profile.phone AS phone,
        profile.website AS website,
        profile.instagram AS instagram,
        profile.description AS description,
        profile.opening_hours_json AS opening_hours_json,
        profile.venue_tags_json AS venue_tags_json,
        0 AS source_rank,
        profile.updated_at AS source_updated_at
      FROM venue_profiles profile
      LEFT JOIN venue_location_cache location ON location.venue_id = profile.venue_id
      WHERE profile.active = 1
      UNION ALL
      SELECT
        mission.venue_id AS id,
        mission.venue_name AS name,
        NULL AS address,
        mission.suburb AS suburb,
        'VIC' AS state,
        NULL AS postcode,
        NULL AS latitude,
        NULL AS longitude,
        NULL AS phone,
        NULL AS website,
        NULL AS instagram,
        NULL AS description,
        '{}' AS opening_hours_json,
        '[]' AS venue_tags_json,
        1 AS source_rank,
        mission.updated_at AS source_updated_at
      FROM missions mission
      WHERE mission.active = 1
    ), ranked AS (
      SELECT candidates.*,
        row_number() OVER (
          PARTITION BY id
          ORDER BY source_rank ASC, source_updated_at DESC, name COLLATE NOCASE ASC
        ) AS source_row
      FROM candidates
    ), directory AS (
      SELECT * FROM ranked
      WHERE source_row = 1
        AND (? = '' OR lower(
          name || ' ' || COALESCE(suburb, '') || ' ' || COALESCE(address, '')
        ) LIKE ? ESCAPE '\\')
    )`;
    const rows = this.database.prepare(
      `${directoryCte}
       SELECT id, name, address, suburb, state, postcode, latitude, longitude,
              phone, website, instagram, description, opening_hours_json, venue_tags_json
       FROM directory
       ORDER BY name COLLATE NOCASE ASC, id ASC
       LIMIT ? OFFSET ?`,
    ).all(query, pattern, input.limit < 0 ? -1 : Math.max(1, input.limit), Math.max(0, input.offset)) as Array<{
      id: string;
      name: string;
      address: string | null;
      suburb: string | null;
      state: string | null;
      postcode: string | null;
      latitude: number | null;
      longitude: number | null;
      phone: string | null;
      website: string | null;
      instagram: string | null;
      description: string | null;
      opening_hours_json: string;
      venue_tags_json: string | null;
    }>;
    const countRow = this.database.prepare(
      `${directoryCte} SELECT count(*) AS count FROM directory`,
    ).get(query, pattern) as { count: number };
    return {
      venues: rows.map((row) => {
        const venueTags = parseJsonArray(row.venue_tags_json ?? "[]");
        return {
          id: row.id,
          name: row.name,
          address: row.address,
          suburb: row.suburb,
          state: row.state,
          postcode: row.postcode,
          latitude: row.latitude,
          longitude: row.longitude,
          phone: row.phone,
          website: row.website,
          instagram: row.instagram,
          description: row.description,
          openingHours: parseJsonObject(row.opening_hours_json),
          venueTags,
          isUserSubmittedVenue: venueTags.includes("user submitted"),
        };
      }),
      total: Number(countRow.count ?? 0),
    };
  }

  listVenueManagerPriceRecords(
    limit: number,
    venueId?: string | null,
    before?: { verifiedAt: string; id: string } | null,
  ): PublicVenuePriceRecord[] {
    const boundedLimit = limit < 0 ? -1 : Math.max(1, limit);
    const canonicalVenue = (alias: string) =>
      `COALESCE((SELECT identity.canonical_venue_id FROM venue_identity_aliases identity WHERE identity.alias_venue_id = ${alias}.venue_id LIMIT 1), ${alias}.venue_id)`;
    const cursorClause = (verifiedExpression: string, idExpression: string) => before
      ? ` AND (${verifiedExpression} < ? OR (${verifiedExpression} = ? AND ${idExpression} < ?))`
      : "";
    const valuesFor = () => [
      ...(venueId ? [venueId] : []),
      ...(before ? [before.verifiedAt, before.verifiedAt, before.id] : []),
      boundedLimit,
    ];
    const beerWhere = venueId
      ? "WHERE beer.venue_id = ? AND beer.on_tap = 1 AND beer.in_stock = 1 AND profile.active = 1"
      : "WHERE beer.on_tap = 1 AND beer.in_stock = 1 AND profile.active = 1";
    const happyWhere = venueId
      ? "WHERE happy.venue_id = ? AND happy.active = 1 AND profile.active = 1"
      : "WHERE happy.active = 1 AND profile.active = 1";
    const paidSpecialTierWhere = "profile.membership_tier IN ('plus', 'pro')";
    const specialWhere = venueId
      ? `WHERE special.venue_id = ? AND special.active = 1 AND profile.active = 1 AND ${paidSpecialTierWhere}`
      : `WHERE special.active = 1 AND profile.active = 1 AND ${paidSpecialTierWhere}`;
    const beerRows = this.database
      .prepare(
        `WITH ranked_beers AS (
           SELECT
             beer.*,
             profile.name AS profile_name,
             profile.suburb AS profile_suburb,
             profile.address AS profile_address,
             profile.membership_tier AS profile_membership_tier,
             profile.highlighted_name AS profile_highlighted_name,
             profile.premium_badge AS profile_premium_badge,
             profile.promoted AS profile_promoted,
             profile.featured_special_eligible AS profile_featured_special_eligible,
             profile.accepts_pint_path_codes AS profile_accepts_pint_path_codes,
             COALESCE(beer.price_verified_at, beer.created_at) AS authority_verified_at,
             row_number() OVER (
               PARTITION BY ${canonicalVenue("beer")},
                 COALESCE(NULLIF(beer.normalized_beer_id, ''), lower(trim(beer.beer_name))),
                 COALESCE(NULLIF(beer.serve_size, ''), 'other')
               ORDER BY COALESCE(beer.price_verified_at, beer.created_at) DESC, beer.updated_at DESC, beer.id DESC
             ) AS authority_rank
           FROM venue_beers beer
           INNER JOIN venue_profiles profile ON profile.venue_id = beer.venue_id
           ${beerWhere}
         )
         SELECT beer.*
         FROM ranked_beers beer
         WHERE beer.authority_rank = 1
           AND NOT EXISTS (
             SELECT 1
             FROM venue_price_records community
             WHERE community.is_happy_hour_price = 0
               AND ${canonicalVenue("community")} = ${canonicalVenue("beer")}
               AND COALESCE(NULLIF(community.normalized_beer_id, ''), lower(trim(community.beer_name))) =
                   COALESCE(NULLIF(beer.normalized_beer_id, ''), lower(trim(beer.beer_name)))
               AND COALESCE(NULLIF(community.serving_size, ''), 'other') = COALESCE(NULLIF(beer.serve_size, ''), 'other')
               AND community.last_verified_at > beer.authority_verified_at
           )
         ${cursorClause("beer.authority_verified_at", "'bar_beer:' || beer.id")}
         ORDER BY beer.authority_verified_at DESC, ('bar_beer:' || beer.id) DESC
         LIMIT ?`,
      )
      .all(...valuesFor()) as Array<BarBeerRow & {
        profile_name: string | null;
        profile_suburb: string | null;
        profile_address: string | null;
        profile_membership_tier: StoredBarMembershipTier;
        profile_highlighted_name: number;
        profile_premium_badge: string | null;
        profile_promoted: number;
        profile_featured_special_eligible: number;
        profile_accepts_pint_path_codes: number;
      }>;
    const happyRows = this.database
      .prepare(
        `SELECT
           happy.*,
           profile.name AS profile_name,
           profile.suburb AS profile_suburb,
           profile.address AS profile_address,
           profile.membership_tier AS profile_membership_tier,
           profile.highlighted_name AS profile_highlighted_name,
           profile.premium_badge AS profile_premium_badge,
           profile.promoted AS profile_promoted,
           profile.featured_special_eligible AS profile_featured_special_eligible,
           profile.accepts_pint_path_codes AS profile_accepts_pint_path_codes
         FROM venue_happy_hours happy
         INNER JOIN venue_profiles profile ON profile.venue_id = happy.venue_id
         ${happyWhere}${cursorClause("happy.updated_at", "'bar_happy_hour:' || happy.id")}
         ORDER BY happy.updated_at DESC, ('bar_happy_hour:' || happy.id) DESC
         LIMIT ?`,
      )
      .all(...valuesFor()) as Array<BarHappyHourRow & {
        profile_name: string | null;
        profile_suburb: string | null;
        profile_address: string | null;
        profile_membership_tier: StoredBarMembershipTier;
        profile_highlighted_name: number;
        profile_premium_badge: string | null;
        profile_promoted: number;
        profile_featured_special_eligible: number;
        profile_accepts_pint_path_codes: number;
      }>;
    const specialRows = this.database
      .prepare(
        `SELECT
           special.*,
           profile.name AS profile_name,
           profile.suburb AS profile_suburb,
           profile.address AS profile_address,
           profile.membership_tier AS profile_membership_tier,
           profile.highlighted_name AS profile_highlighted_name,
           profile.premium_badge AS profile_premium_badge,
           profile.promoted AS profile_promoted,
           profile.featured_special_eligible AS profile_featured_special_eligible,
           profile.accepts_pint_path_codes AS profile_accepts_pint_path_codes
         FROM venue_specials special
         INNER JOIN venue_profiles profile ON profile.venue_id = special.venue_id
         ${specialWhere}${cursorClause("special.updated_at", "'venue_special:' || special.id")}
         ORDER BY special.updated_at DESC, ('venue_special:' || special.id) DESC
         LIMIT ?`,
      )
      .all(...valuesFor()) as Array<BarSpecialRow & {
        profile_name: string | null;
        profile_suburb: string | null;
        profile_address: string | null;
        profile_membership_tier: StoredBarMembershipTier;
        profile_highlighted_name: number;
        profile_premium_badge: string | null;
        profile_promoted: number;
        profile_featured_special_eligible: number;
        profile_accepts_pint_path_codes: number;
      }>;

    return [
      ...beerRows.map((row) => ({
        id: `bar_beer:${row.id}`,
        venueId: row.venue_id,
        venueName: row.profile_name || row.venue_id,
        venueAddress: row.profile_address,
        suburb: row.profile_suburb,
        membershipTier: normalizeBarMembershipTier(row.profile_membership_tier),
        highlightedName: Boolean(row.profile_highlighted_name),
        premiumBadge: row.profile_premium_badge,
        promoted: Boolean(row.profile_promoted),
        featuredSpecialEligible: Boolean(row.profile_featured_special_eligible),
        acceptsPintPathCodes: Boolean(row.profile_accepts_pint_path_codes),
        beerName: row.beer_name,
        normalizedBeerId: row.normalized_beer_id,
        servingSize: row.serve_size || "other",
        price: row.price,
        isHappyHourPrice: false,
        happyHourDetails: null,
        displayKind: "beer" as const,
        isOnTap: row.on_tap ? "yes" as const : row.in_stock ? "unknown" as const : "no" as const,
        confidence: row.price_verified_at ? "venue_confirmed" as const : "stale" as const,
        sourceType: "venue_manager_portal",
        sourceSubmissionId: null,
        lastVerifiedAt: row.price_verified_at ?? row.created_at,
        priceVerifiedAt: row.price_verified_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      ...happyRows.map((row) => ({
        id: `bar_happy_hour:${row.id}`,
        venueId: row.venue_id,
        venueName: row.profile_name || row.venue_id,
        venueAddress: row.profile_address,
        suburb: row.profile_suburb,
        membershipTier: normalizeBarMembershipTier(row.profile_membership_tier),
        highlightedName: Boolean(row.profile_highlighted_name),
        premiumBadge: row.profile_premium_badge,
        promoted: Boolean(row.profile_promoted),
        featuredSpecialEligible: Boolean(row.profile_featured_special_eligible),
        acceptsPintPathCodes: Boolean(row.profile_accepts_pint_path_codes),
        beerName: row.title || "Happy hour",
        normalizedBeerId: null,
        servingSize: "other" as const,
        price: null,
        isHappyHourPrice: true,
        happyHourDetails: row.description,
        happyHourTitle: row.title,
        happyHourDays: parseJsonArray(row.days_of_week_json),
        happyHourStartTime: row.start_time,
        happyHourEndTime: row.end_time,
        happyHourBeers: parseHappyHourBeers(row.happy_hour_beers_json),
        displayKind: "happy_hour" as const,
        isOnTap: "unknown" as const,
        confidence: "venue_confirmed" as const,
        sourceType: "venue_manager_portal",
        sourceSubmissionId: null,
        lastVerifiedAt: row.updated_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      ...specialRows.map((row) => ({
        id: `venue_special:${row.id}`,
        venueId: row.venue_id,
        venueName: row.profile_name || row.venue_id,
        venueAddress: row.profile_address,
        suburb: row.profile_suburb,
        membershipTier: normalizeBarMembershipTier(row.profile_membership_tier),
        highlightedName: Boolean(row.profile_highlighted_name),
        premiumBadge: row.profile_premium_badge,
        promoted: Boolean(row.profile_promoted),
        featuredSpecialEligible: Boolean(row.profile_featured_special_eligible),
        acceptsPintPathCodes: Boolean(row.profile_accepts_pint_path_codes),
        beerName: row.exclusive ? "Pint Path exclusive" : row.title || "Venue special",
        normalizedBeerId: null,
        servingSize: "other" as const,
        price: row.price,
        isHappyHourPrice: false,
        happyHourDetails: null,
        specialTitle: row.title,
        specialDescription: row.description,
        specialDiscount: row.discount,
        specialStartsAt: row.starts_at,
        specialEndsAt: row.ends_at,
        specialStartTime: row.start_time,
        specialEndTime: row.end_time,
        specialScheduleNote: row.schedule_note,
        specialExclusive: Boolean(row.exclusive),
        displayKind: "special" as const,
        isOnTap: "unknown" as const,
        confidence: "venue_confirmed" as const,
        sourceType: row.exclusive ? "venue_manager_portal:pint_path_exclusive" : "venue_manager_portal:special",
        sourceSubmissionId: null,
        lastVerifiedAt: row.updated_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    ]
      .sort((left, right) => {
        const timestampDifference = Date.parse(right.lastVerifiedAt) - Date.parse(left.lastVerifiedAt);
        return timestampDifference || right.id.localeCompare(left.id);
      })
      .slice(0, limit < 0 ? undefined : limit);
  }

  getAccountPreferences(userId: string): AccountPreferences | null {
    const row = this.database
      .prepare("SELECT * FROM account_preferences WHERE user_id = ?")
      .get(userId) as AccountPreferencesRow | undefined;
    return row ? toAccountPreferences(row) : null;
  }

  upsertAccountPreferences(input: {
    userId: string;
    preferredSuburbs: string[];
    preferredBeers: string[];
    preferredUseCases: string[];
    onboardingCompletedAt: string | null;
    now: string;
  }): AccountPreferences {
    const existing = this.getAccountPreferences(input.userId);
    this.database
      .prepare(
        `INSERT INTO account_preferences (
          user_id, preferred_suburbs_json, preferred_beers_json, preferred_use_cases_json,
          onboarding_completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          preferred_suburbs_json = excluded.preferred_suburbs_json,
          preferred_beers_json = excluded.preferred_beers_json,
          preferred_use_cases_json = excluded.preferred_use_cases_json,
          onboarding_completed_at = excluded.onboarding_completed_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.userId,
        JSON.stringify(input.preferredSuburbs),
        JSON.stringify(input.preferredBeers),
        JSON.stringify(input.preferredUseCases),
        input.onboardingCompletedAt ?? existing?.onboardingCompletedAt ?? null,
        existing?.createdAt ?? input.now,
        input.now,
      );
    return this.getAccountPreferences(input.userId)!;
  }

  getAccountPrivacySettings(userId: string): AccountPrivacySettings | null {
    const row = this.database
      .prepare("SELECT * FROM account_privacy_settings WHERE user_id = ?")
      .get(userId) as AccountPrivacySettingsRow | undefined;
    return row ? toAccountPrivacySettings(row) : null;
  }

  getDefaultAccountPrivacySettings(userId: string, now = new Date().toISOString()): AccountPrivacySettings {
    return {
      userId,
      optionalAnalyticsEnabled: false,
      venueReportInclusionEnabled: false,
      productResearchEnabled: false,
      emailUpdatesEnabled: false,
      consentVersion: CURRENT_LEGAL_POLICY_VERSION,
      consentedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  upsertAccountPrivacySettings(input: {
    userId: string;
    optionalAnalyticsEnabled: boolean;
    venueReportInclusionEnabled: boolean;
    productResearchEnabled: boolean;
    emailUpdatesEnabled: boolean;
    consentVersion: string;
    now: string;
  }): AccountPrivacySettings {
    const existing = this.getAccountPrivacySettings(input.userId);
    this.database
      .prepare(
        `INSERT INTO account_privacy_settings (
          user_id, optional_analytics_enabled, venue_report_inclusion_enabled,
          product_research_enabled, email_updates_enabled, consent_version, consented_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          optional_analytics_enabled = excluded.optional_analytics_enabled,
          venue_report_inclusion_enabled = excluded.venue_report_inclusion_enabled,
          product_research_enabled = excluded.product_research_enabled,
          email_updates_enabled = excluded.email_updates_enabled,
          consent_version = excluded.consent_version,
          consented_at = excluded.consented_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.userId,
        input.optionalAnalyticsEnabled ? 1 : 0,
        input.venueReportInclusionEnabled ? 1 : 0,
        input.productResearchEnabled ? 1 : 0,
        input.emailUpdatesEnabled ? 1 : 0,
        input.consentVersion,
        input.now,
        existing?.createdAt ?? input.now,
        input.now,
      );
    return this.getAccountPrivacySettings(input.userId)!;
  }

  saveItem(input: {
    id: string;
    userId: string;
    itemType: SavedItemType;
    itemId: string;
    label: string;
    suburb: string | null;
    metadata: Record<string, unknown>;
    now: string;
  }): SavedItem {
    this.database
      .prepare(
        `INSERT INTO saved_items (
          id, user_id, item_type, item_id, label, suburb, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, item_type, item_id) DO UPDATE SET
          label = excluded.label,
          suburb = excluded.suburb,
          metadata_json = excluded.metadata_json`,
      )
      .run(
        input.id,
        input.userId,
        input.itemType,
        input.itemId,
        input.label,
        input.suburb,
        JSON.stringify(redactSecrets(input.metadata)),
        input.now,
      );

    const row = this.database
      .prepare("SELECT * FROM saved_items WHERE user_id = ? AND item_type = ? AND item_id = ?")
      .get(input.userId, input.itemType, input.itemId) as SavedItemRow;
    return toSavedItem(row);
  }

  removeSavedItem(input: { userId: string; itemType: SavedItemType; itemId: string }): boolean {
    const result = this.database
      .prepare("DELETE FROM saved_items WHERE user_id = ? AND item_type = ? AND item_id = ?")
      .run(input.userId, input.itemType, input.itemId);
    return result.changes > 0;
  }

  listSavedItems(userId: string): SavedItem[] {
    const rows = this.database
      .prepare("SELECT * FROM saved_items WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as SavedItemRow[];
    return rows.map(toSavedItem);
  }

  listRecentSearches(userId: string, limit: number): Array<{ eventType: string; label: string; suburb: string | null; createdAt: string }> {
    const rows = this.database
      .prepare(
        `SELECT event_type, suburb, metadata_json, created_at
         FROM events
         WHERE user_id = ?
           AND event_type IN ('search_performed', 'beer_search_performed', 'suburb_search_performed')
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(userId, limit) as Array<{ event_type: string; suburb: string | null; metadata_json: string; created_at: string }>;

    return rows.map((row) => {
      const metadata = parseJsonObject(row.metadata_json);
      return {
        eventType: row.event_type,
        label: String(metadata.query || metadata.label || row.suburb || row.event_type),
        suburb: row.suburb,
        createdAt: row.created_at,
      };
    });
  }

  createFeedback(input: {
    id: string;
    userId: string | null;
    anonymousSessionId: string | null;
    feedbackType: FeedbackType;
    message: string;
    venueId: string | null;
    venueName: string | null;
    contactEmail?: string | null;
    priority: FeedbackPriority;
    triageReason: string | null;
    now: string;
  }): FeedbackItem {
    this.database
      .prepare(
        `INSERT INTO feedback (
          id, user_id, anonymous_session_id, feedback_type, message, venue_id, venue_name,
          contact_email, priority, triage_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.anonymousSessionId,
        input.feedbackType,
        input.message,
        input.venueId,
        input.venueName,
        input.contactEmail ?? null,
        input.priority,
        input.triageReason,
        input.now,
        input.now,
      );
    const row = this.database.prepare("SELECT * FROM feedback WHERE id = ?").get(input.id) as FeedbackRow;
    return toFeedback(row);
  }

  listFeedback(limit: number, offset = 0): FeedbackItem[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM feedback
         ORDER BY
           CASE priority
             WHEN 'high' THEN 0
             WHEN 'medium' THEN 1
             WHEN 'normal' THEN 2
             ELSE 3
           END,
           created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(Math.max(1, Math.min(limit, 100)), Math.max(0, offset)) as FeedbackRow[];
    return rows.map(toFeedback);
  }

  countFeedback(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM feedback").get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  createWrongPriceReport(input: {
    id: string;
    userId: string | null;
    anonymousSessionId: string | null;
    venueId: string;
    venueName: string;
    priceRecordId: string | null;
    beerName: string | null;
    reason: string;
    notes: string | null;
    sourcePhotoUrl: string | null;
    now: string;
  }): { report: WrongPriceReport; markedDisputed: boolean; duplicate: boolean } {
    if (input.priceRecordId && (input.userId || input.anonymousSessionId)) {
      const existing = input.userId
        ? this.database.prepare(
            `SELECT * FROM wrong_price_reports
             WHERE price_record_id = ? AND user_id = ? AND status IN ('open', 'in_progress')
             ORDER BY created_at DESC LIMIT 1`,
          ).get(input.priceRecordId, input.userId) as WrongPriceReportRow | undefined
        : this.database.prepare(
            `SELECT * FROM wrong_price_reports
             WHERE price_record_id = ? AND user_id IS NULL AND anonymous_session_id = ?
               AND status IN ('open', 'in_progress')
             ORDER BY created_at DESC LIMIT 1`,
          ).get(input.priceRecordId, input.anonymousSessionId) as WrongPriceReportRow | undefined;
      if (existing) {
        return { report: toWrongPriceReport(existing), markedDisputed: false, duplicate: true };
      }
    }
    this.database
      .prepare(
        `INSERT INTO wrong_price_reports (
          id, user_id, anonymous_session_id, venue_id, venue_name, price_record_id, beer_name,
          reason, notes, source_photo_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.anonymousSessionId,
        input.venueId,
        input.venueName,
        input.priceRecordId,
        input.beerName,
        input.reason,
        input.notes,
        input.sourcePhotoUrl,
        input.now,
        input.now,
      );

    let markedDisputed = false;
    if (input.priceRecordId) {
      const row = this.database
        .prepare(
          `SELECT count(DISTINCT user_id) AS count
           FROM wrong_price_reports
           WHERE price_record_id = ? AND status = 'open' AND user_id IS NOT NULL`,
        )
        .get(input.priceRecordId) as { count: number } | undefined;

      if (Number(row?.count ?? 0) >= 2) {
        this.database
          .prepare("UPDATE venue_price_records SET confidence = 'disputed', updated_at = ? WHERE id = ? AND confidence != 'venue_confirmed'")
          .run(input.now, input.priceRecordId);
        markedDisputed = true;
      }
    }

    const reportRow = this.database.prepare("SELECT * FROM wrong_price_reports WHERE id = ?").get(input.id) as WrongPriceReportRow;
    return { report: toWrongPriceReport(reportRow), markedDisputed, duplicate: false };
  }

  listWrongPriceReports(limit: number, offset = 0): WrongPriceReport[] {
    const rows = this.database
      .prepare("SELECT * FROM wrong_price_reports ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(Math.max(1, Math.min(limit, 100)), Math.max(0, offset)) as WrongPriceReportRow[];
    return rows.map(toWrongPriceReport);
  }

  countWrongPriceReports(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM wrong_price_reports").get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  createVenueRequest(input: {
    id: string;
    userId: string | null;
    anonymousSessionId: string | null;
    requestType: RequestType;
    venueId: string | null;
    venueName: string | null;
    googlePlaceId?: string | null;
    beerName: string | null;
    suburb: string | null;
    notes: string | null;
    now: string;
  }): VenueRequest {
    this.database
      .prepare(
        `INSERT INTO venue_requests (
          id, user_id, anonymous_session_id, request_type, venue_id, venue_name,
          google_place_id, beer_name, suburb, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.anonymousSessionId,
        input.requestType,
        input.venueId,
        input.venueName,
        input.googlePlaceId ?? null,
        input.beerName,
        input.suburb,
        input.notes,
        input.now,
        input.now,
      );
    const row = this.database.prepare("SELECT * FROM venue_requests WHERE id = ?").get(input.id) as VenueRequestRow;
    return toVenueRequest(row);
  }

  createOrGetVenueRequest(input: {
    id: string;
    userId: string | null;
    anonymousSessionId: string | null;
    requestType: RequestType;
    venueId: string | null;
    venueName: string | null;
    googlePlaceId: string | null;
    beerName: string | null;
    suburb: string | null;
    notes: string | null;
    now: string;
  }): { request: VenueRequest; duplicate: boolean } {
    const create = this.database.transaction(() => {
      let existing: VenueRequestRow | undefined;
      if (input.requestType === "missing_venue" && input.googlePlaceId) {
        if (input.userId) {
          existing = this.database.prepare(
            `SELECT * FROM venue_requests
             WHERE request_type = 'missing_venue'
               AND google_place_id = ?
               AND status IN ('open', 'in_progress', 'mission_created')
               AND (
                 user_id = ?
                 OR (user_id IS NULL AND anonymous_session_id IS NOT NULL AND anonymous_session_id = ?)
               )
             ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END, created_at ASC
             LIMIT 1`,
          ).get(input.googlePlaceId, input.userId, input.anonymousSessionId, input.userId) as VenueRequestRow | undefined;
        } else if (input.anonymousSessionId) {
          existing = this.database.prepare(
            `SELECT * FROM venue_requests
             WHERE request_type = 'missing_venue'
               AND google_place_id = ?
               AND user_id IS NULL
               AND anonymous_session_id = ?
               AND status IN ('open', 'in_progress', 'mission_created')
             ORDER BY created_at ASC
             LIMIT 1`,
          ).get(input.googlePlaceId, input.anonymousSessionId) as VenueRequestRow | undefined;
        }
      }
      if (existing) {
        if (input.userId && !existing.user_id) {
          this.database.prepare(
            `UPDATE venue_requests
             SET user_id = ?, updated_at = ?
             WHERE id = ? AND user_id IS NULL`,
          ).run(input.userId, input.now, existing.id);
          existing = this.database.prepare("SELECT * FROM venue_requests WHERE id = ?")
            .get(existing.id) as VenueRequestRow;
        }
        return { request: toVenueRequest(existing), duplicate: true };
      }
      return { request: this.createVenueRequest(input), duplicate: false };
    });
    return create.immediate();
  }

  resolveGoogleVenueRequestsForSubmission(input: {
    googlePlaceId: string;
    venueId: string;
    submissionId: string;
    now: string;
  }): VenueRequest[] {
    const rows = this.database.prepare(
      `SELECT * FROM venue_requests
       WHERE request_type = 'missing_venue'
         AND google_place_id = ?
         AND status IN ('open', 'in_progress', 'mission_created')
       ORDER BY created_at ASC`,
    ).all(input.googlePlaceId) as VenueRequestRow[];
    if (!rows.length) return [];

    this.database.prepare(
      `UPDATE venue_requests
       SET venue_id = ?,
           source_submission_id = ?,
           status = 'resolved',
           resolution_note = 'Resolved by a Google-verified venue submission.',
           resolved_at = ?,
           resolved_by = NULL,
           updated_at = ?
       WHERE request_type = 'missing_venue'
         AND google_place_id = ?
         AND status IN ('open', 'in_progress', 'mission_created')`,
    ).run(input.venueId, input.submissionId, input.now, input.now, input.googlePlaceId);

    const missionIds = [...new Set(rows.map((row) => row.mission_id).filter((id): id is string => Boolean(id)))];
    for (const missionId of missionIds) {
      this.database.prepare(
        `UPDATE mission_progress
         SET status = 'cancelled', completed_at = NULL, updated_at = ?
         WHERE mission_id = ? AND status IN ('accepted', 'submitted')`,
      ).run(input.now, missionId);
      this.database.prepare(
        `UPDATE submissions
         SET mission_id = NULL, updated_at = ?
         WHERE mission_id = ? AND id != ? AND status IN ('pending', 'needs_more_evidence')`,
      ).run(input.now, missionId, input.submissionId);
      this.database.prepare("UPDATE missions SET active = 0, updated_at = ? WHERE id = ?")
        .run(input.now, missionId);
    }

    return rows.map((row) => toVenueRequest({
      ...row,
      venue_id: input.venueId,
      source_submission_id: input.submissionId,
      status: "resolved",
      resolution_note: "Resolved by a Google-verified venue submission.",
      resolved_at: input.now,
      resolved_by: null,
      updated_at: input.now,
    }));
  }

  markVenueRequestMission(input: { requestId: string; missionId: string; now: string }): VenueRequest {
    this.database
      .prepare("UPDATE venue_requests SET status = 'mission_created', mission_id = ?, updated_at = ? WHERE id = ?")
      .run(input.missionId, input.now, input.requestId);
    const row = this.database.prepare("SELECT * FROM venue_requests WHERE id = ?").get(input.requestId) as VenueRequestRow;
    return toVenueRequest(row);
  }

  createMissionFromVenueRequest(input: {
    requestId: string;
    missionId: string;
    now: string;
  }):
    | { state: "created"; mission: BusinessMission; request: VenueRequest }
    | { state: "not_found" }
    | { state: "conflict" } {
    const create = this.database.transaction(() => {
      const row = this.database.prepare("SELECT * FROM venue_requests WHERE id = ?")
        .get(input.requestId) as VenueRequestRow | undefined;
      if (!row) return { state: "not_found" as const };
      if (row.mission_id || !["open", "in_progress"].includes(row.status)) {
        return { state: "conflict" as const };
      }

      const mission = this.createMission({
        id: input.missionId,
        venueId: row.venue_id ?? `request:${row.id}`,
        venueName: row.venue_name ?? row.beer_name ?? "Requested venue",
        suburb: row.suburb,
        reason: row.request_type.replaceAll("_", " "),
        priority: "normal",
        points: row.request_type === "verify_beer_at_venue" ? 2 : 4,
        multiplier: 1,
        active: true,
        lastVerifiedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      });
      const claimed = this.database.prepare(
        `UPDATE venue_requests
         SET status = 'mission_created', mission_id = ?, updated_at = ?
         WHERE id = ?
           AND mission_id IS NULL
           AND status IN ('open', 'in_progress')`,
      ).run(input.missionId, input.now, input.requestId);
      if (claimed.changes !== 1) {
        throw new Error("Venue request mission claim lost");
      }
      const updated = this.database.prepare("SELECT * FROM venue_requests WHERE id = ?")
        .get(input.requestId) as VenueRequestRow;
      return { state: "created" as const, mission, request: toVenueRequest(updated) };
    });
    return create();
  }

  listVenueRequests(limit: number, offset = 0): VenueRequest[] {
    const rows = this.database
      .prepare("SELECT * FROM venue_requests ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(Math.max(1, Math.min(limit, 100)), Math.max(0, offset)) as VenueRequestRow[];
    return rows.map(toVenueRequest);
  }

  countVenueRequests(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM venue_requests").get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  updateTrustWorkflow(input: {
    kind: "feedback" | "wrong_price" | "venue_request" | "venue_interest";
    id: string;
    status: TrustWorkflowStatus;
    assignedTo: string | null;
    resolutionNote: string | null;
    resolvedBy: string;
    expectedUpdatedAt: string;
    now: string;
  }):
    | { state: "updated"; item: FeedbackItem | WrongPriceReport | VenueRequest | VenueInterestRequest }
    | { state: "not_found" }
    | { state: "conflict" } {
    const tableByKind = {
      feedback: "feedback",
      wrong_price: "wrong_price_reports",
      venue_request: "venue_requests",
      venue_interest: "venue_interest_requests",
    } as const;
    const table = tableByKind[input.kind];
    const resolved = input.status === "resolved" || input.status === "rejected";
    const result = this.database
      .prepare(
        `UPDATE ${table}
         SET status = ?,
             assigned_to = ?,
             resolution_note = ?,
             resolved_at = ?,
             resolved_by = ?,
             updated_at = ?
         WHERE id = ? AND updated_at = ?`,
      )
      .run(
        input.status,
        input.assignedTo,
        input.resolutionNote,
        resolved ? input.now : null,
        resolved ? input.resolvedBy : null,
        input.now,
        input.id,
        input.expectedUpdatedAt,
      );
    if (result.changes !== 1) {
      const exists = this.database.prepare(`SELECT 1 AS present FROM ${table} WHERE id = ?`).get(input.id);
      return { state: exists ? "conflict" : "not_found" };
    }

    const row = this.database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(input.id);
    if (input.kind === "feedback") return { state: "updated", item: toFeedback(row as FeedbackRow) };
    if (input.kind === "wrong_price") return { state: "updated", item: toWrongPriceReport(row as WrongPriceReportRow) };
    if (input.kind === "venue_request") return { state: "updated", item: toVenueRequest(row as VenueRequestRow) };
    return { state: "updated", item: toVenueInterestRequest(row as VenueInterestRequestRow) };
  }

  getVenueRequestById(id: string): VenueRequest | null {
    const row = this.database.prepare("SELECT * FROM venue_requests WHERE id = ?").get(id) as
      | VenueRequestRow
      | undefined;
    return row ? toVenueRequest(row) : null;
  }

  createVenueInterestRequest(input: {
    id: string;
    userId: string | null;
    venueId: string | null;
    venueName: string;
    managerName: string;
    email: string;
    phone: string | null;
    role: string;
    notes: string | null;
    now: string;
  }): VenueInterestRequest {
    this.database
      .prepare(
        `INSERT INTO venue_interest_requests (
          id, user_id, venue_id, venue_name, manager_name, email, phone, role, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.venueId,
        input.venueName,
        input.managerName,
        input.email,
        input.phone,
        input.role,
        input.notes,
        input.now,
        input.now,
      );
    const row = this.database.prepare("SELECT * FROM venue_interest_requests WHERE id = ?").get(input.id) as VenueInterestRequestRow;
    return toVenueInterestRequest(row);
  }

  listVenueInterestRequests(limit: number, offset = 0): VenueInterestRequest[] {
    const rows = this.database
      .prepare("SELECT * FROM venue_interest_requests ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(limit, Math.max(0, offset)) as VenueInterestRequestRow[];
    return rows.map(toVenueInterestRequest);
  }

  updateVenueInterestStatus(input: { id: string; status: string; now: string }): VenueInterestRequest | null {
    this.database
      .prepare("UPDATE venue_interest_requests SET status = ?, updated_at = ? WHERE id = ?")
      .run(input.status, input.now, input.id);
    const row = this.database.prepare("SELECT * FROM venue_interest_requests WHERE id = ?").get(input.id) as
      | VenueInterestRequestRow
      | undefined;
    return row ? toVenueInterestRequest(row) : null;
  }

  createBarClaimRequest(input: {
    id: string;
    userId: string;
    barId: string | null;
    barName: string;
    address: string | null;
    suburb: string | null;
    requesterName: string;
    requesterRole: string;
    contactEmail: string;
    contactPhone: string | null;
    message: string | null;
    now: string;
  }): BarClaimRequest {
    this.database
      .prepare(
        `INSERT INTO venue_claim_requests (
          id, user_id, venue_id, venue_name, address, suburb, requester_name, requester_role,
          contact_email, contact_phone, message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.barId,
        input.barName,
        input.address,
        input.suburb,
        input.requesterName,
        input.requesterRole,
        input.contactEmail,
        input.contactPhone,
        input.message,
        input.now,
        input.now,
      );
    const row = this.database.prepare("SELECT * FROM venue_claim_requests WHERE id = ?").get(input.id) as BarClaimRequestRow;
    return toBarClaimRequest(row);
  }

  getBarClaimRequestById(id: string): BarClaimRequest | null {
    const row = this.database
      .prepare("SELECT * FROM venue_claim_requests WHERE id = ?")
      .get(id) as BarClaimRequestRow | undefined;
    return row ? toBarClaimRequest(row) : null;
  }

  getPendingBarClaimRequest(input: { userId: string; barId: string }): BarClaimRequest | null {
    const row = this.database
      .prepare(
        `SELECT * FROM venue_claim_requests
         WHERE user_id = ? AND venue_id = ? AND status = 'pending'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(input.userId, input.barId) as BarClaimRequestRow | undefined;
    return row ? toBarClaimRequest(row) : null;
  }

  reviewBarClaimRequest(input: {
    id: string;
    status: "approved" | "rejected";
    reviewNote: string | null;
    reviewedBy: string;
    reviewedAt: string;
  }): BarClaimRequest | null {
    const result = this.database
      .prepare(
        `UPDATE venue_claim_requests
         SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(input.status, input.reviewNote, input.reviewedBy, input.reviewedAt, input.reviewedAt, input.id);
    return result.changes === 1 ? this.getBarClaimRequestById(input.id) : null;
  }

  listBarClaimRequests(input: { userId?: string | undefined; status?: string | undefined; limit: number; offset?: number }): BarClaimRequest[] {
    const where: string[] = [];
    const values: unknown[] = [];

    if (input.userId) {
      where.push("user_id = ?");
      values.push(input.userId);
    }

    if (input.status) {
      where.push("status = ?");
      values.push(input.status);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`SELECT * FROM venue_claim_requests ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...values, input.limit, Math.max(0, input.offset ?? 0)) as BarClaimRequestRow[];
    return rows.map(toBarClaimRequest);
  }

  assignVenueManager(input: {
    id: string;
    userId: string;
    venueId: string;
    venueName: string;
    suburb: string | null;
    accessLevel?: VenueAccessLevel;
    approvedBy: string;
    now: string;
  }): VenueManagerAssignment {
    this.database.transaction(() => {
      this.database
        .prepare(
        `INSERT INTO venue_manager_assignments (
          id, user_id, venue_id, venue_name, suburb, access_level, status, approved_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(user_id, venue_id) DO UPDATE SET
          venue_name = excluded.venue_name,
          suburb = excluded.suburb,
          access_level = excluded.access_level,
          status = 'active',
          approved_by = excluded.approved_by,
          expires_at = NULL,
          updated_at = excluded.updated_at`,
        )
        .run(input.id, input.userId, input.venueId, input.venueName, input.suburb, input.accessLevel ?? "manager", input.approvedBy, input.now, input.now);

      this.database
        .prepare("UPDATE accounts SET role = 'venue_manager', updated_at = ? WHERE id = ? AND role = 'user'")
        .run(input.now, input.userId);
    })();

    const row = this.database
      .prepare("SELECT * FROM venue_manager_assignments WHERE user_id = ? AND venue_id = ?")
      .get(input.userId, input.venueId) as VenueManagerAssignmentRow;
    return toVenueManagerAssignment(row);
  }

  inviteVenueCounterStaff(input: {
    id: string;
    userId: string;
    venueId: string;
    venueName: string;
    suburb: string | null;
    approvedBy: string;
    now: string;
    expiresAt: string;
  }): VenueManagerAssignment {
    this.database
      .prepare(
        `INSERT INTO venue_manager_assignments (
          id, user_id, venue_id, venue_name, suburb, access_level, status, approved_by, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'counter_staff', 'pending', ?, ?, ?, ?)
        ON CONFLICT(user_id, venue_id) DO UPDATE SET
          venue_name = excluded.venue_name,
          suburb = excluded.suburb,
          access_level = 'counter_staff',
          status = 'pending',
          approved_by = excluded.approved_by,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at`,
      )
      .run(input.id, input.userId, input.venueId, input.venueName, input.suburb, input.approvedBy, input.expiresAt, input.now, input.now);
    const row = this.database
      .prepare("SELECT * FROM venue_manager_assignments WHERE user_id = ? AND venue_id = ?")
      .get(input.userId, input.venueId) as VenueManagerAssignmentRow;
    return toVenueManagerAssignment(row);
  }

  respondVenueCounterStaffInvitation(input: {
    id: string;
    userId: string;
    decision: "accept" | "decline";
    now: string;
  }): VenueManagerAssignment | null {
    return this.database.transaction(() => {
      const status = input.decision === "accept" ? "active" : "revoked";
      const result = this.database
        .prepare(
          `UPDATE venue_manager_assignments
           SET status = ?, expires_at = NULL, updated_at = ?
           WHERE id = ? AND user_id = ? AND access_level = 'counter_staff' AND status = 'pending'
             AND julianday(expires_at) > julianday(?)`,
        )
        .run(status, input.now, input.id, input.userId, input.now);
      if (result.changes !== 1) return null;
      // Counter access is a venue-scoped capability. It must not replace the
      // member's global contributor persona with the venue-manager role.
      const row = this.database
        .prepare("SELECT * FROM venue_manager_assignments WHERE id = ?")
        .get(input.id) as VenueManagerAssignmentRow;
      return toVenueManagerAssignment(row);
    })();
  }

  revokeVenueManager(input: { userId: string; venueId: string; now: string }): VenueManagerAssignment | null {
    this.database.transaction(() => {
      this.database
        .prepare("UPDATE venue_manager_assignments SET status = 'revoked', expires_at = NULL, updated_at = ? WHERE user_id = ? AND venue_id = ?")
        .run(input.now, input.userId, input.venueId);
      const active = this.database
        .prepare("SELECT 1 FROM venue_manager_assignments WHERE user_id = ? AND status = 'active' AND access_level = 'manager' LIMIT 1")
        .get(input.userId);
      if (!active) {
        this.database
          .prepare("UPDATE accounts SET role = 'user', updated_at = ? WHERE id = ? AND role = 'venue_manager'")
          .run(input.now, input.userId);
      }
    })();
    const row = this.database
      .prepare("SELECT * FROM venue_manager_assignments WHERE user_id = ? AND venue_id = ?")
      .get(input.userId, input.venueId) as VenueManagerAssignmentRow | undefined;
    return row ? toVenueManagerAssignment(row) : null;
  }

  expireVenueCounterStaffInvitations(now: string): number {
    return this.database
      .prepare(
        `UPDATE venue_manager_assignments
         SET status = 'revoked', expires_at = NULL, updated_at = ?
         WHERE access_level = 'counter_staff' AND status = 'pending'
           AND (julianday(expires_at) IS NULL OR julianday(expires_at) <= julianday(?))`,
      )
      .run(now, now).changes;
  }

  listVenueManagerAssignments(input: { userId?: string | undefined; venueId?: string | undefined; activeOnly?: boolean | undefined; limit: number; offset?: number }): VenueManagerAssignment[] {
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (input.userId) {
      clauses.push("user_id = ?");
      values.push(input.userId);
    }

    if (input.venueId) {
      clauses.push("venue_id = ?");
      values.push(input.venueId);
    }

    if (input.activeOnly) {
      clauses.push("status = 'active'");
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`SELECT * FROM venue_manager_assignments ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...values, input.limit, Math.max(0, input.offset ?? 0)) as VenueManagerAssignmentRow[];
    return rows.map(toVenueManagerAssignment);
  }

  getVenueManagerAssignment(input: { userId: string; venueId: string; activeOnly?: boolean | undefined }): VenueManagerAssignment | null {
    const row = this.database
      .prepare(
        `SELECT * FROM venue_manager_assignments
         WHERE user_id = ? AND venue_id = ? ${input.activeOnly ? "AND status = 'active'" : ""}
         LIMIT 1`,
      )
      .get(input.userId, input.venueId) as VenueManagerAssignmentRow | undefined;
    return row ? toVenueManagerAssignment(row) : null;
  }

  getBarProfile(barId: string): BarProfile | null {
    const row = this.database.prepare("SELECT * FROM venue_profiles WHERE venue_id = ?").get(barId) as
      | BarProfileRow
      | undefined;
    return row ? toBarProfile(row) : null;
  }

  listReportableBarProfiles(input: { venueId?: string | null | undefined; limit: number }): BarProfile[] {
    const clauses = ["active = 1", "membership_tier = 'pro'"];
    const values: unknown[] = [];

    if (input.venueId) {
      clauses.push("venue_id = ?");
      values.push(input.venueId);
    }

    const rows = this.database
      .prepare(
        `SELECT * FROM venue_profiles
         WHERE ${clauses.join(" AND ")}
         ORDER BY membership_tier DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(...values, input.limit) as BarProfileRow[];
    return rows.map(toBarProfile);
  }

  upsertBarProfile(input: {
    barId: string;
    name: string;
    address: string | null;
    suburb: string | null;
    area: string | null;
    phone: string | null;
    website: string | null;
    instagram: string | null;
    description: string | null;
    openingHours: Record<string, unknown>;
    venueTags: string[];
    membershipTier: BarMembershipTier;
    highlightedName: boolean;
    premiumBadge: string | null;
    promoted: boolean;
    featuredSpecialEligible: boolean;
    stripeCustomerId?: string | null | undefined;
    stripeSubscriptionId?: string | null | undefined;
    subscriptionStatus?: string | null | undefined;
    tierManualOverride?: boolean | undefined;
    acceptsPintPathCodes?: boolean | undefined;
    active: boolean;
    expectedUpdatedAt?: string | null;
    now: string;
  }): BarProfile {
    const result = this.database
      .prepare(
        `INSERT INTO venue_profiles (
          venue_id, name, address, suburb, area, phone, website, instagram, description,
          opening_hours_json, venue_tags_json, membership_tier, highlighted_name, premium_badge,
          promoted, featured_special_eligible, stripe_customer_id, stripe_subscription_id,
          subscription_status, tier_manual_override, accepts_pint_path_codes, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(venue_id) DO UPDATE SET
          name = excluded.name,
          address = excluded.address,
          suburb = excluded.suburb,
          area = excluded.area,
          phone = excluded.phone,
          website = excluded.website,
          instagram = excluded.instagram,
          description = excluded.description,
          opening_hours_json = excluded.opening_hours_json,
          venue_tags_json = excluded.venue_tags_json,
          membership_tier = excluded.membership_tier,
          highlighted_name = excluded.highlighted_name,
          premium_badge = excluded.premium_badge,
          promoted = excluded.promoted,
          featured_special_eligible = excluded.featured_special_eligible,
          stripe_customer_id = COALESCE(excluded.stripe_customer_id, stripe_customer_id),
          stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, stripe_subscription_id),
          subscription_status = COALESCE(excluded.subscription_status, subscription_status),
          tier_manual_override = excluded.tier_manual_override,
          accepts_pint_path_codes = excluded.accepts_pint_path_codes,
          active = excluded.active,
          updated_at = excluded.updated_at
        WHERE (? IS NULL OR venue_profiles.updated_at = ?)`,
      )
      .run(
        input.barId,
        input.name,
        input.address,
        input.suburb,
        input.area,
        input.phone,
        input.website,
        input.instagram,
        input.description,
        JSON.stringify(input.openingHours),
        JSON.stringify(input.venueTags),
        input.membershipTier,
        input.highlightedName ? 1 : 0,
        input.premiumBadge,
        input.promoted ? 1 : 0,
        input.featuredSpecialEligible ? 1 : 0,
        input.stripeCustomerId ?? null,
        input.stripeSubscriptionId ?? null,
        input.subscriptionStatus ?? null,
        input.tierManualOverride ? 1 : 0,
        input.acceptsPintPathCodes ? 1 : 0,
        input.active ? 1 : 0,
        input.now,
        input.now,
        input.expectedUpdatedAt ?? null,
        input.expectedUpdatedAt ?? null,
      );
    if (result.changes !== 1 && this.getBarProfile(input.barId)) {
      throw new OptimisticConcurrencyError("Venue profile changed before this update could be saved.");
    }
    return this.getBarProfile(input.barId)!;
  }

  getBarProfileByStripeSubscriptionId(stripeSubscriptionId: string): BarProfile | null {
    const row = this.database
      .prepare("SELECT * FROM venue_profiles WHERE stripe_subscription_id = ? LIMIT 1")
      .get(stripeSubscriptionId) as BarProfileRow | undefined;
    return row ? toBarProfile(row) : null;
  }

  updateBarSubscription(input: {
    barId: string;
    membershipTier: BarMembershipTier;
    stripePaidMembershipTier?: BarMembershipTier | null | undefined;
    stripeCustomerId?: string | null | undefined;
    stripeSubscriptionId?: string | null | undefined;
    subscriptionStatus?: string | null | undefined;
    highlightedName: boolean;
    premiumBadge: string | null;
    promoted: boolean;
    featuredSpecialEligible: boolean;
    now: string;
    stripeEventCreatedAt?: string | null;
  }): BarProfile {
    this.database
      .prepare(
        `UPDATE venue_profiles
         SET membership_tier = ?,
             stripe_paid_membership_tier = COALESCE(?, stripe_paid_membership_tier),
             stripe_customer_id = COALESCE(?, stripe_customer_id),
             stripe_subscription_id = COALESCE(?, stripe_subscription_id),
             subscription_status = ?,
             highlighted_name = ?,
             premium_badge = ?,
             promoted = ?,
             featured_special_eligible = ?,
             stripe_event_created_at = COALESCE(?, stripe_event_created_at),
             updated_at = ?
         WHERE venue_id = ?
           AND tier_manual_override = 0
           AND (? IS NULL OR stripe_event_created_at IS NULL OR stripe_event_created_at <= ?)`,
      )
      .run(
        input.membershipTier,
        input.stripePaidMembershipTier ?? null,
        input.stripeCustomerId ?? null,
        input.stripeSubscriptionId ?? null,
        input.subscriptionStatus ?? null,
        input.highlightedName ? 1 : 0,
        input.premiumBadge,
        input.promoted ? 1 : 0,
        input.featuredSpecialEligible ? 1 : 0,
        input.stripeEventCreatedAt ?? null,
        input.now,
        input.barId,
        input.stripeEventCreatedAt ?? null,
        input.stripeEventCreatedAt ?? null,
      );
    return this.getBarProfile(input.barId)!;
  }

  listBarBeers(barId: string): BarBeer[] {
    const rows = this.database
      .prepare("SELECT * FROM venue_beers WHERE venue_id = ? ORDER BY on_tap DESC, in_stock DESC, beer_name COLLATE NOCASE ASC")
      .all(barId) as BarBeerRow[];
    return rows.map(toBarBeer);
  }

  getBarBeerById(id: string): BarBeer | null {
    const row = this.database.prepare("SELECT * FROM venue_beers WHERE id = ?").get(id) as BarBeerRow | undefined;
    return row ? toBarBeer(row) : null;
  }

  upsertBarBeer(input: {
    id: string;
    barId: string;
    beerName: string;
    normalizedBeerId?: string | null;
    brewery: string | null;
    style: string | null;
    abv: number | null;
    serveSize: ServingSize | null;
    price: number | null;
    currency: string;
    onTap: boolean;
    inStock: boolean;
    notes: string | null;
    priceVerifiedAt?: string | null;
    stockVerifiedAt?: string | null;
    expectedUpdatedAt?: string | null;
    now: string;
  }): BarBeer {
    const result = this.database
      .prepare(
        `INSERT INTO venue_beers (
          id, venue_id, beer_name, normalized_beer_id, brewery, style, abv, serve_size, price, currency,
          on_tap, in_stock, notes, price_verified_at, stock_verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          beer_name = excluded.beer_name,
          normalized_beer_id = excluded.normalized_beer_id,
          brewery = excluded.brewery,
          style = excluded.style,
          abv = excluded.abv,
          serve_size = excluded.serve_size,
          price = excluded.price,
          currency = excluded.currency,
          on_tap = excluded.on_tap,
          in_stock = excluded.in_stock,
          notes = excluded.notes,
          price_verified_at = excluded.price_verified_at,
          stock_verified_at = excluded.stock_verified_at,
          updated_at = excluded.updated_at
        WHERE venue_beers.venue_id = excluded.venue_id
          AND (? IS NULL OR venue_beers.updated_at = ?)`,
      )
      .run(
        input.id,
        input.barId,
        input.beerName,
        input.normalizedBeerId ?? null,
        input.brewery,
        input.style,
        input.abv,
        input.serveSize,
        input.price,
        input.currency,
        input.onTap ? 1 : 0,
        input.inStock ? 1 : 0,
        input.notes,
        input.priceVerifiedAt ?? null,
        input.stockVerifiedAt ?? null,
        input.now,
        input.now,
        input.expectedUpdatedAt ?? null,
        input.expectedUpdatedAt ?? null,
      );
    if (result.changes !== 1 && this.getBarBeerById(input.id)) {
      throw new OptimisticConcurrencyError("Beer row changed before this update could be saved.");
    }
    const row = this.database
      .prepare("SELECT * FROM venue_beers WHERE id = ? AND venue_id = ?")
      .get(input.id, input.barId) as BarBeerRow | undefined;
    if (!row) {
      throw new Error("Beer row belongs to another venue");
    }
    return toBarBeer(row);
  }

  deleteBarBeer(input: { id: string; barId: string; expectedUpdatedAt?: string | null }): boolean {
    const result = input.expectedUpdatedAt
      ? this.database.prepare("DELETE FROM venue_beers WHERE id = ? AND venue_id = ? AND updated_at = ?")
          .run(input.id, input.barId, input.expectedUpdatedAt)
      : this.database.prepare("DELETE FROM venue_beers WHERE id = ? AND venue_id = ?").run(input.id, input.barId);
    if (result.changes !== 1 && input.expectedUpdatedAt && this.getBarBeerById(input.id)) {
      throw new OptimisticConcurrencyError("Beer row changed before it could be deleted.");
    }
    return result.changes > 0;
  }

  listBarHappyHours(barId: string): BarHappyHour[] {
    const rows = this.database
      .prepare("SELECT * FROM venue_happy_hours WHERE venue_id = ? ORDER BY active DESC, start_time ASC, title COLLATE NOCASE ASC")
      .all(barId) as BarHappyHourRow[];
    return rows.map(toBarHappyHour);
  }

  getBarHappyHourById(id: string): BarHappyHour | null {
    const row = this.database.prepare("SELECT * FROM venue_happy_hours WHERE id = ?").get(id) as
      | BarHappyHourRow
      | undefined;
    return row ? toBarHappyHour(row) : null;
  }

  upsertBarHappyHour(input: {
    id: string;
    barId: string;
    title: string;
    daysOfWeek: string[];
    startTime: string;
    endTime: string;
    description: string;
    happyHourBeers: BarHappyHourBeer[];
    active: boolean;
    expectedUpdatedAt?: string | null;
    now: string;
  }): BarHappyHour {
    const result = this.database
      .prepare(
        `INSERT INTO venue_happy_hours (
          id, venue_id, title, days_of_week_json, start_time, end_time, description, happy_hour_beers_json, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          days_of_week_json = excluded.days_of_week_json,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          description = excluded.description,
          happy_hour_beers_json = excluded.happy_hour_beers_json,
          active = excluded.active,
          updated_at = excluded.updated_at
        WHERE venue_happy_hours.venue_id = excluded.venue_id
          AND (? IS NULL OR venue_happy_hours.updated_at = ?)`,
      )
      .run(
        input.id,
        input.barId,
        input.title,
        JSON.stringify(input.daysOfWeek),
        input.startTime,
        input.endTime,
        input.description,
        JSON.stringify(input.happyHourBeers ?? []),
        input.active ? 1 : 0,
        input.now,
        input.now,
        input.expectedUpdatedAt ?? null,
        input.expectedUpdatedAt ?? null,
      );
    if (result.changes !== 1 && this.getBarHappyHourById(input.id)) {
      throw new OptimisticConcurrencyError("Happy hour changed before this update could be saved.");
    }
    const row = this.database
      .prepare("SELECT * FROM venue_happy_hours WHERE id = ? AND venue_id = ?")
      .get(input.id, input.barId) as BarHappyHourRow | undefined;
    if (!row) {
      throw new Error("Happy-hour row belongs to another venue");
    }
    return toBarHappyHour(row);
  }

  deleteBarHappyHour(input: { id: string; barId: string; expectedUpdatedAt?: string | null }): boolean {
    const result = input.expectedUpdatedAt
      ? this.database.prepare("DELETE FROM venue_happy_hours WHERE id = ? AND venue_id = ? AND updated_at = ?")
          .run(input.id, input.barId, input.expectedUpdatedAt)
      : this.database.prepare("DELETE FROM venue_happy_hours WHERE id = ? AND venue_id = ?").run(input.id, input.barId);
    if (result.changes !== 1 && input.expectedUpdatedAt && this.getBarHappyHourById(input.id)) {
      throw new OptimisticConcurrencyError("Happy hour changed before it could be deleted.");
    }
    return result.changes > 0;
  }

  listBarSpecials(barId: string): BarSpecial[] {
    const rows = this.database
      .prepare("SELECT * FROM venue_specials WHERE venue_id = ? ORDER BY active DESC, exclusive DESC, starts_at DESC, title COLLATE NOCASE ASC")
      .all(barId) as BarSpecialRow[];
    return rows.map(toBarSpecial);
  }

  getBarSpecialById(id: string): BarSpecial | null {
    const row = this.database.prepare("SELECT * FROM venue_specials WHERE id = ?").get(id) as BarSpecialRow | undefined;
    return row ? toBarSpecial(row) : null;
  }

  upsertBarSpecial(input: {
    id: string;
    barId: string;
    title: string;
    description: string;
    price: number | null;
    discount: string | null;
    savingsAmountCents?: number | null;
    startsAt: string | null;
    endsAt: string | null;
    startTime: string | null;
    endTime: string | null;
    recurrenceFrequency?: "none" | "weekly";
    daysOfWeek?: string[];
    timezone?: string;
    scheduleNote: string | null;
    exclusive: boolean;
    active: boolean;
    expectedUpdatedAt?: string | null;
    now: string;
  }): BarSpecial {
    const result = this.database
      .prepare(
        `INSERT INTO venue_specials (
          id, venue_id, title, description, price, discount, savings_amount_cents, starts_at, ends_at,
          start_time, end_time, recurrence_frequency, days_of_week_json, timezone, schedule_note,
          exclusive, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          price = excluded.price,
          discount = excluded.discount,
          savings_amount_cents = excluded.savings_amount_cents,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          recurrence_frequency = excluded.recurrence_frequency,
          days_of_week_json = excluded.days_of_week_json,
          timezone = excluded.timezone,
          schedule_note = excluded.schedule_note,
          exclusive = excluded.exclusive,
          active = excluded.active,
          updated_at = excluded.updated_at
        WHERE venue_specials.venue_id = excluded.venue_id
          AND (? IS NULL OR venue_specials.updated_at = ?)`,
      )
      .run(
        input.id,
        input.barId,
        input.title,
        input.description,
        input.price,
        input.discount,
        input.savingsAmountCents ?? null,
        input.startsAt,
        input.endsAt,
        input.startTime,
        input.endTime,
        input.recurrenceFrequency ?? "none",
        JSON.stringify(input.daysOfWeek ?? []),
        input.timezone ?? "Australia/Melbourne",
        input.scheduleNote,
        input.exclusive ? 1 : 0,
        input.active ? 1 : 0,
        input.now,
        input.now,
        input.expectedUpdatedAt ?? null,
        input.expectedUpdatedAt ?? null,
      );
    if (result.changes !== 1 && this.getBarSpecialById(input.id)) {
      throw new OptimisticConcurrencyError("Special changed before this update could be saved.");
    }
    const row = this.database
      .prepare("SELECT * FROM venue_specials WHERE id = ? AND venue_id = ?")
      .get(input.id, input.barId) as BarSpecialRow | undefined;
    if (!row) {
      throw new Error("Special row belongs to another venue");
    }
    return toBarSpecial(row);
  }

  deleteBarSpecial(input: { id: string; barId: string; expectedUpdatedAt?: string | null }): boolean {
    const result = input.expectedUpdatedAt
      ? this.database.prepare("DELETE FROM venue_specials WHERE id = ? AND venue_id = ? AND updated_at = ?")
          .run(input.id, input.barId, input.expectedUpdatedAt)
      : this.database.prepare("DELETE FROM venue_specials WHERE id = ? AND venue_id = ?").run(input.id, input.barId);
    if (result.changes !== 1 && input.expectedUpdatedAt && this.getBarSpecialById(input.id)) {
      throw new OptimisticConcurrencyError("Special changed before it could be deleted.");
    }
    return result.changes > 0;
  }

  createBarPendingChange(input: {
    id: string;
    barId: string;
    changeType: BarPendingChangeType;
    action: BarPendingChangeAction;
    targetId: string | null;
    payload: Record<string, unknown>;
    submittedBy: string;
    now: string;
  }): BarPendingChange {
    this.database
      .prepare(
        `INSERT INTO venue_pending_changes (
          id, venue_id, change_type, action, target_id, payload_json, status,
          submitted_by, submitted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.barId,
        input.changeType,
        input.action,
        input.targetId,
        JSON.stringify(input.payload),
        input.submittedBy,
        input.now,
        input.now,
        input.now,
      );
    const row = this.database.prepare("SELECT * FROM venue_pending_changes WHERE id = ?").get(input.id) as BarPendingChangeRow;
    return toBarPendingChange(row);
  }

  getBarPendingChangeById(id: string): BarPendingChange | null {
    const row = this.database.prepare("SELECT * FROM venue_pending_changes WHERE id = ?").get(id) as
      | BarPendingChangeRow
      | undefined;
    return row ? toBarPendingChange(row) : null;
  }

  getPendingBarChangeForTarget(input: {
    barId: string;
    changeType: BarPendingChangeType;
    action: BarPendingChangeAction;
    targetId: string | null;
  }): BarPendingChange | null {
    const row = this.database.prepare(
      `SELECT * FROM venue_pending_changes
       WHERE venue_id = ? AND change_type = ? AND action = ? AND target_id IS ? AND status = 'pending'
       ORDER BY submitted_at DESC
       LIMIT 1`,
    ).get(input.barId, input.changeType, input.action, input.targetId) as BarPendingChangeRow | undefined;
    return row ? toBarPendingChange(row) : null;
  }

  listBarPendingChanges(input: {
    barId?: string | undefined;
    submittedBy?: string | undefined;
    status?: BarPendingChangeStatus | undefined;
    limit: number;
    offset?: number;
  }): BarPendingChange[] {
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (input.barId) {
      clauses.push("venue_id = ?");
      values.push(input.barId);
    }

    if (input.submittedBy) {
      clauses.push("submitted_by = ?");
      values.push(input.submittedBy);
    }

    if (input.status) {
      clauses.push("status = ?");
      values.push(input.status);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        `SELECT * FROM venue_pending_changes
         ${where}
         ORDER BY
           CASE
             WHEN COALESCE(
               (SELECT membership_tier FROM venue_profiles WHERE venue_id = venue_pending_changes.venue_id),
               'basic'
             ) = 'pro' THEN 0
             ELSE 1
           END,
           submitted_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...values, input.limit, Math.max(0, input.offset ?? 0)) as BarPendingChangeRow[];
    return rows.map(toBarPendingChange);
  }

  reviewBarPendingChange(input: {
    id: string;
    status: Exclude<BarPendingChangeStatus, "pending">;
    reviewedBy: string;
    reviewedAt: string;
    rejectionReason: string | null;
  }): BarPendingChange | null {
    const result = this.database
      .prepare(
        `UPDATE venue_pending_changes
         SET status = ?,
             reviewed_by = ?,
             reviewed_at = ?,
             rejection_reason = ?,
             updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(input.status, input.reviewedBy, input.reviewedAt, input.rejectionReason, input.reviewedAt, input.id);
    if (result.changes !== 1) {
      return null;
    }
    return this.getBarPendingChangeById(input.id);
  }

  getMonthlyBarReport(input: { barId: string; month: string }): MonthlyBarReport | null {
    const row = this.database
      .prepare("SELECT * FROM venue_monthly_reports WHERE venue_id = ? AND month = ?")
      .get(input.barId, input.month) as MonthlyBarReportRow | undefined;
    return row ? toMonthlyBarReport(row) : null;
  }

  getVenueMonthlyReport(input: { venueId: string; month: string }): MonthlyBarReport | null {
    return this.getMonthlyBarReport({ barId: input.venueId, month: input.month });
  }

  upsertMonthlyBarReport(input: { id: string; barId: string; month: string; data: Record<string, unknown>; createdAt: string }): MonthlyBarReport {
    this.database
      .prepare(
        `INSERT INTO venue_monthly_reports (id, venue_id, month, data_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(venue_id, month) DO UPDATE SET
           data_json = excluded.data_json,
           created_at = excluded.created_at`,
      )
      .run(input.id, input.barId, input.month, JSON.stringify(input.data), input.createdAt);
    return this.getMonthlyBarReport({ barId: input.barId, month: input.month })!;
  }

  upsertVenueMonthlyReport(input: { id: string; venueId: string; month: string; data: Record<string, unknown>; createdAt: string }): MonthlyBarReport {
    return this.upsertMonthlyBarReport({
      id: input.id,
      barId: input.venueId,
      month: input.month,
      data: input.data,
      createdAt: input.createdAt,
    });
  }

  recordBarAnalyticsEvent(input: {
    id: string;
    barId: string | null;
    area: string | null;
    suburb?: string | null | undefined;
    eventType: string;
    queryText: string | null;
    beerName: string | null;
    beerStyle: string | null;
    createdAt: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO venue_analytics_events (
          id, venue_id, area, suburb, event_type, query_text, beer_name, beer_style, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.barId, input.area, input.suburb ?? input.area, input.eventType, input.queryText, input.beerName, input.beerStyle, input.createdAt);
  }

  recordVenueAnalyticsEvent(input: {
    id: string;
    venueId: string | null;
    area: string | null;
    suburb?: string | null | undefined;
    eventType: string;
    queryText: string | null;
    beerName: string | null;
    beerStyle: string | null;
    createdAt: string;
  }): void {
    this.recordBarAnalyticsEvent({
      id: input.id,
      barId: input.venueId,
      area: input.area,
      suburb: input.suburb,
      eventType: input.eventType,
      queryText: input.queryText,
      beerName: input.beerName,
      beerStyle: input.beerStyle,
      createdAt: input.createdAt,
    });
  }

  getBarAreaAnalytics(input: {
    barId: string;
    venueName?: string | null | undefined;
    area: string | null;
    month?: string | undefined;
    startIso?: string | undefined;
    endIso?: string | undefined;
    timezone?: string | undefined;
    privacyThreshold?: number | undefined;
  }) {
    const privacyThreshold = Math.max(1, input.privacyThreshold ?? 10);
    const customRange = input.startIso && input.endIso
      ? { startIso: input.startIso, endIso: input.endIso }
      : null;
    const dateRange = customRange ?? getReportMonthRange(input.month, input.timezone);
    const count = (sql: string, values: unknown[] = []) => {
      const row = this.database.prepare(sql).get(...values) as { count: number } | undefined;
      return Number(row?.count ?? 0);
    };
    const grouped = (sql: string, values: unknown[] = []) =>
      this.database.prepare(sql).all(...values) as AnalyticsBucket[];
    const rangeClause = dateRange ? "AND created_at >= ? AND created_at < ?" : "";
    const rangeValues = dateRange ? [dateRange.startIso, dateRange.endIso] : [];
    const area = input.area?.trim() || null;
    // Area analytics must never silently widen to all users when a venue has no
    // suburb/area. Venue-specific counters below remain available in that case.
    const eventAreaClause = area ? "AND lower(COALESCE(suburb, '')) = lower(?)" : "AND 1 = 0";
    const areaValues = area ? [area] : [];
    const actorExpression = `CASE
      WHEN NULLIF(user_id, '') IS NOT NULL THEN 'user:' || user_id
      WHEN NULLIF(anonymous_session_id, '') IS NOT NULL THEN 'session:' || anonymous_session_id
      ELSE NULL
    END`;
    const venueSearchQueries = input.venueName?.trim()
      ? count(
          `SELECT count(DISTINCT ${actorExpression}) AS count
           FROM events
           WHERE event_type IN ('search_performed', 'suburb_search_performed')
             ${eventAreaClause}
             AND lower(COALESCE(json_extract(metadata_json, '$.query'), '')) = lower(?)
             ${rangeClause}`,
          [...areaValues, input.venueName.trim(), ...rangeValues],
        )
      : 0;

    const barEventCount = (eventTypes: string[]) => {
      const placeholders = eventTypes.map(() => "?").join(", ");
      return count(
        `SELECT count(DISTINCT ${actorExpression}) AS count
         FROM events
         WHERE venue_id = ?
           AND event_type IN (${placeholders})
           ${rangeClause}`,
        [input.barId, ...eventTypes, ...rangeValues],
      );
    };
    const barInteractionActorCount = (eventType: string, metadataPath: string, metadataValue: string) =>
      count(
        `SELECT count(DISTINCT ${actorExpression}) AS count
         FROM events
         WHERE venue_id = ?
           AND (
             event_type = ?
             OR (event_type = 'venue_lookup' AND json_extract(metadata_json, ?) = ?)
           )
           ${rangeClause}`,
        [input.barId, eventType, metadataPath, metadataValue, ...rangeValues],
      );

    const areaBeerSearches = mergeReportTrendRows(grouped(
      `SELECT COALESCE(beer_id, json_extract(metadata_json, '$.query'), 'beer') AS key,
              max(json_extract(metadata_json, '$.query')) AS label,
              count(DISTINCT ${actorExpression}) AS count
       FROM events
       WHERE event_type = 'beer_search_performed'
         ${eventAreaClause}
         ${rangeClause}
       GROUP BY COALESCE(beer_id, json_extract(metadata_json, '$.query'), 'beer')
       HAVING count(DISTINCT ${actorExpression}) >= ?
       ORDER BY count DESC
       LIMIT 24`,
      [...areaValues, ...rangeValues, privacyThreshold],
    ).map(safeReportBeerTrend));
    const styleKeyExpression = `COALESCE(
      NULLIF(trim(json_extract(metadata_json, '$.beerStyle')), ''),
      NULLIF(trim(json_extract(metadata_json, '$.query')), '')
    )`;
    const areaStyleSearches = mergeReportTrendRows(grouped(
      `SELECT ${styleKeyExpression} AS key,
              max(json_extract(metadata_json, '$.query')) AS label,
              count(DISTINCT ${actorExpression}) AS count
       FROM events
       WHERE (
           event_type = 'style_search'
           OR (
             event_type = 'beer_search_performed'
             AND lower(COALESCE(json_extract(metadata_json, '$.searchKind'), '')) = 'style'
           )
         )
         AND ${styleKeyExpression} IS NOT NULL
         ${eventAreaClause}
         ${rangeClause}
       GROUP BY ${styleKeyExpression}
       HAVING count(DISTINCT ${actorExpression}) >= ?
       ORDER BY count DESC
       LIMIT 24`,
      [...areaValues, ...rangeValues, privacyThreshold],
    ).map(safeReportStyleTrend));

    const areaSearches = count(
      `SELECT count(DISTINCT ${actorExpression}) AS count
       FROM events
       WHERE event_type IN ('search_performed', 'beer_search_performed', 'suburb_search_performed', 'style_search')
           ${eventAreaClause}
           ${rangeClause}`,
      [...areaValues, ...rangeValues],
    );
    const privacyFloorMet = areaSearches >= privacyThreshold;
    const searchTimeRows = this.database
      .prepare(
        `SELECT created_at, ${actorExpression} AS actor_key
         FROM events
         WHERE event_type IN ('search_performed', 'beer_search_performed', 'suburb_search_performed', 'style_search')
           AND ${actorExpression} IS NOT NULL
           ${eventAreaClause}
           ${rangeClause}`,
      )
      .all(...[...areaValues, ...rangeValues]) as Array<{ created_at: string; actor_key: string }>;
    const searchTimes = buildSearchTimeBuckets(
      searchTimeRows,
      input.timezone ?? DEFAULT_REPORT_TIMEZONE,
      privacyThreshold,
    );

    const rawVenueMetrics = {
      barLookups: barEventCount(["map_pin_click", "venue_card_viewed", "venue_lookup"]),
      profileViews: barEventCount(["venue_detail_opened", "venue_profile_viewed"]),
      beerListViews: barEventCount(["beer_list_viewed"]),
      specialsViews: barEventCount(["deal_viewed", "special_viewed", "happy_hour_active_now_used", "happy_hour_near_me_used"]),
      markerClicks: barEventCount(["map_pin_click"]),
      venueSearchQueries,
      pricePreviewViews: barEventCount(["free_preview_viewed", "price_view_revealed"]),
      directionsClicks: barInteractionActorCount("directions_clicked", "$.interactionType", "directions_click"),
      saves: barEventCount(["saved_venue_added", "saved_night_plan_added"]),
      shares: barEventCount(["venue_shared", "share_link_copied", "search_shared"]),
    };
    const suppressedVenueMetrics = Object.entries(rawVenueMetrics)
      .filter(([, value]) => value < privacyThreshold)
      .map(([key]) => key);
    const reportableVenueMetric = (key: keyof typeof rawVenueMetrics) =>
      rawVenueMetrics[key] >= privacyThreshold ? rawVenueMetrics[key] : 0;

    return {
      barLookups: reportableVenueMetric("barLookups"),
      profileViews: reportableVenueMetric("profileViews"),
      beerListViews: reportableVenueMetric("beerListViews"),
      specialsViews: reportableVenueMetric("specialsViews"),
      markerClicks: reportableVenueMetric("markerClicks"),
      venueSearchQueries: reportableVenueMetric("venueSearchQueries"),
      pricePreviewViews: reportableVenueMetric("pricePreviewViews"),
      directionsClicks: reportableVenueMetric("directionsClicks"),
      saves: reportableVenueMetric("saves"),
      shares: reportableVenueMetric("shares"),
      areaSearches: privacyFloorMet ? areaSearches : 0,
      areaBeerSearches: privacyFloorMet ? areaBeerSearches : [],
      areaStyleSearches: privacyFloorMet ? areaStyleSearches : [],
      searchTimesByDay: privacyFloorMet ? searchTimes.byDay : [],
      searchTimesByHour: privacyFloorMet ? searchTimes.byHour : [],
      suppressedVenueMetrics,
      privacyFloorMet,
      privacyThreshold,
      timezone: input.timezone ?? DEFAULT_REPORT_TIMEZONE,
    };
  }

  getVenueAreaAnalytics(input: {
    venueId: string;
    venueName?: string | null | undefined;
    area: string | null;
    month?: string | undefined;
    startIso?: string | undefined;
    endIso?: string | undefined;
    timezone?: string | undefined;
    privacyThreshold?: number | undefined;
  }) {
    return this.getBarAreaAnalytics({
      barId: input.venueId,
      venueName: input.venueName,
      area: input.area,
      month: input.month,
      startIso: input.startIso,
      endIso: input.endIso,
      timezone: input.timezone,
      privacyThreshold: input.privacyThreshold,
    });
  }

  upsertVenuePartnerOutreach(input: {
    id: string;
    venueId: string;
    venueName: string;
    suburb: string | null;
    status: string;
    tierFit: string | null;
    nextAction: string | null;
    lastContactedAt: string | null;
    contactName: string | null;
    notes: string | null;
    updatedBy: string;
    now: string;
  }): VenuePartnerOutreach {
    this.database
      .prepare(
        `INSERT INTO venue_partner_outreach (
          id, venue_id, venue_name, suburb, status, tier_fit, next_action, last_contacted_at,
          contact_name, notes, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(venue_id) DO UPDATE SET
          venue_name = excluded.venue_name,
          suburb = excluded.suburb,
          status = excluded.status,
          tier_fit = excluded.tier_fit,
          next_action = excluded.next_action,
          last_contacted_at = excluded.last_contacted_at,
          contact_name = excluded.contact_name,
          notes = excluded.notes,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.venueId,
        input.venueName,
        input.suburb,
        input.status,
        input.tierFit,
        input.nextAction,
        input.lastContactedAt,
        input.contactName,
        input.notes,
        input.updatedBy,
        input.now,
        input.now,
      );
    const row = this.database.prepare("SELECT * FROM venue_partner_outreach WHERE venue_id = ?").get(input.venueId) as VenuePartnerOutreachRow;
    return toVenuePartnerOutreach(row);
  }

  listVenuePartnerOutreach(limit: number, offset = 0): VenuePartnerOutreach[] {
    const rows = this.database
      .prepare("SELECT * FROM venue_partner_outreach ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(limit, Math.max(0, offset)) as VenuePartnerOutreachRow[];
    return rows.map(toVenuePartnerOutreach);
  }

  getVenuePartnerAdminCounts() {
    const row = this.database.prepare(`SELECT
      (SELECT count(*) FROM venue_interest_requests) AS interests,
      (SELECT count(*) FROM venue_claim_requests) AS claim_requests,
      (SELECT count(*) FROM venue_manager_assignments) AS assignments,
      (SELECT count(*) FROM venue_pending_changes WHERE status = 'pending') AS pending_changes,
      (SELECT count(*) FROM venue_partner_outreach) AS outreach,
      (SELECT count(*) FROM venue_partner_outreach WHERE status NOT IN ('closed', 'not_interested')) AS open_outreach`).get() as Record<string, number>;
    return {
      interests: Number(row.interests ?? 0),
      claimRequests: Number(row.claim_requests ?? 0),
      assignments: Number(row.assignments ?? 0),
      pendingChanges: Number(row.pending_changes ?? 0),
      outreach: Number(row.outreach ?? 0),
      openOutreach: Number(row.open_outreach ?? 0),
    };
  }

  getVenuePartnerLeadContext(venueIds: string[]): {
    assignedVenueIds: string[];
    outreachByVenueId: Record<string, VenuePartnerOutreach>;
  } {
    const uniqueVenueIds = [...new Set(venueIds.filter(Boolean))];
    if (!uniqueVenueIds.length) {
      return { assignedVenueIds: [], outreachByVenueId: {} };
    }

    const placeholders = uniqueVenueIds.map(() => "?").join(", ");
    const assignedRows = this.database
      .prepare(
        `SELECT DISTINCT venue_id
         FROM venue_manager_assignments
         WHERE status = 'active' AND venue_id IN (${placeholders})
         ORDER BY venue_id`,
      )
      .all(...uniqueVenueIds) as Array<{ venue_id: string }>;
    const outreachRows = this.database
      .prepare(`SELECT * FROM venue_partner_outreach WHERE venue_id IN (${placeholders})`)
      .all(...uniqueVenueIds) as VenuePartnerOutreachRow[];

    return {
      assignedVenueIds: assignedRows.map((row) => row.venue_id),
      outreachByVenueId: Object.fromEntries(
        outreachRows.map((row) => [row.venue_id, toVenuePartnerOutreach(row)]),
      ),
    };
  }

  countKnownVenues(): number {
    const row = this.database
      .prepare(
        `SELECT count(DISTINCT venue_id) AS count
         FROM (
           SELECT venue_id FROM missions WHERE venue_id IS NOT NULL AND venue_id != ''
           UNION ALL
           SELECT venue_id FROM venue_price_records WHERE venue_id IS NOT NULL AND venue_id != ''
           UNION ALL
           SELECT venue_id FROM events WHERE venue_id IS NOT NULL AND venue_id != ''
           UNION ALL
           SELECT venue_id FROM venue_requests WHERE venue_id IS NOT NULL AND venue_id != ''
           UNION ALL
           SELECT venue_id AS venue_id FROM venue_profiles WHERE venue_id IS NOT NULL AND venue_id != ''
         )`,
      )
      .get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  recordEvent(input: {
    id: string;
    userId: string | null;
    anonymousSessionId: string | null;
    eventType: string;
    venueId: string | null;
    beerId: string | null;
    suburb: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO events (
          id, user_id, anonymous_session_id, event_type, venue_id, beer_id, suburb, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.anonymousSessionId,
        input.eventType,
        input.venueId,
        normalizeAnalyticsBeerId(input.beerId),
        input.suburb,
        JSON.stringify(input.metadata),
        input.createdAt,
      );
  }

  deleteUserEventsByPrivacyScopes(userId: string, scopes: Array<"optional_analytics" | "venue_insight">): number {
    if (scopes.length === 0) return 0;
    const placeholders = scopes.map(() => "?").join(", ");
    return this.database
      .prepare(
        `DELETE FROM events
         WHERE user_id = ?
           AND json_extract(metadata_json, '$.privacyScope') IN (${placeholders})`,
      )
      .run(userId, ...scopes).changes;
  }

  countRecentVenueManagerDeletes(input: {
    venueId: string;
    since: string;
    changeType?: Exclude<BarPendingChangeType, "profile"> | undefined;
  }): number {
    const changeType = input.changeType ?? null;
    const row = this.database
      .prepare(
        `SELECT count(*) AS count
         FROM security_audit_log
         WHERE action = 'venue_manager_delete'
           AND created_at >= @since
           AND json_extract(metadata_json, '$.venueId') = @venueId
           AND (
             @changeType IS NULL
             OR json_extract(metadata_json, '$.changeType') = @changeType
           )`,
      )
      .get({
        venueId: input.venueId,
        since: input.since,
        changeType,
      }) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  insertSecurityAuditLog(input: {
    id: string;
    actorUserId: string | null;
    actorRole: string | null;
    action: string;
    targetType: string | null;
    targetId: string | null;
    metadata: Record<string, unknown>;
    ipHash: string | null;
    userAgentHash: string | null;
    createdAt: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO security_audit_log (
          id, actor_user_id, actor_role, action, target_type, target_id,
          metadata_json, ip_hash, user_agent_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.actorUserId,
        input.actorRole,
        input.action,
        input.targetType,
        input.targetId,
        JSON.stringify(redactSecrets(input.metadata)),
        input.ipHash,
        input.userAgentHash,
        input.createdAt,
      );
  }

  listSecurityAuditLogs(input: number | {
    limit?: number;
    offset?: number;
    action?: string | null;
    actorUserId?: string | null;
  } = 100): SecurityAuditLog[] {
    const query = typeof input === "number" ? { limit: input, offset: 0, action: null, actorUserId: null } : input;
    const limit = Math.min(500, Math.max(1, query.limit ?? 100));
    const offset = Math.max(0, query.offset ?? 0);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.action) {
      clauses.push("action = ?");
      params.push(query.action);
    }
    if (query.actorUserId) {
      clauses.push("actor_user_id = ?");
      params.push(query.actorUserId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`SELECT * FROM security_audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as SecurityAuditLogRow[];
    return rows.map(toSecurityAuditLog);
  }

  countSecurityAuditLogs(input: { action?: string | null; actorUserId?: string | null } = {}): number {
    const clauses: string[] = [];
    const params: string[] = [];
    if (input.action) {
      clauses.push("action = ?");
      params.push(input.action);
    }
    if (input.actorUserId) {
      clauses.push("actor_user_id = ?");
      params.push(input.actorUserId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM security_audit_log ${where}`)
      .get(...params) as { count: number };
    return Number(row.count);
  }

  createSourceEvidenceObject(input: {
    id: string;
    ownerUserId: string | null;
    storageProvider: string;
    objectPath: string;
    mimeType: string | null;
    byteSize: number | null;
    dataBase64: string | null;
    externalUrl: string | null;
    retentionExpiresAt: string;
    createdAt: string;
  }): SourceEvidenceObject {
    this.database
      .prepare(
        `INSERT INTO source_evidence_objects (
          id, owner_user_id, storage_provider, object_path, mime_type, byte_size,
          data_base64, external_url, retention_expires_at, deleted_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        input.id,
        input.ownerUserId,
        input.storageProvider,
        input.objectPath,
        input.mimeType,
        input.byteSize,
        input.dataBase64,
        input.externalUrl,
        input.retentionExpiresAt,
        input.createdAt,
      );
    return this.getSourceEvidenceObject(input.id)!;
  }

  getSourceEvidenceObject(id: string): SourceEvidenceObject | null {
    const row = this.database
      .prepare("SELECT * FROM source_evidence_objects WHERE id = ?")
      .get(id) as SourceEvidenceObjectRow | undefined;
    return row ? toSourceEvidenceObject(row) : null;
  }

  isSourceEvidenceLinked(id: string): boolean {
    return Boolean(this.database.prepare(
      "SELECT 1 AS linked FROM submission_source_evidence WHERE evidence_id = ? LIMIT 1",
    ).get(id));
  }

  deleteUnlinkedSourceEvidenceObject(id: string): boolean {
    const result = this.database.prepare(
      `DELETE FROM source_evidence_objects
       WHERE id = ?
         AND NOT EXISTS (
           SELECT 1 FROM submission_source_evidence link WHERE link.evidence_id = source_evidence_objects.id
         )`,
    ).run(id);
    return result.changes === 1;
  }

  listExpiredSourceEvidence(input: { now: string; hardCutoff: string; limit: number }): SourceEvidenceObject[] {
    const rows = this.database
      .prepare(
        `SELECT evidence.*
         FROM source_evidence_objects evidence
         WHERE evidence.deleted_at IS NULL
           AND evidence.retention_expires_at IS NOT NULL
           AND evidence.retention_expires_at <= ?
           AND (
             evidence.created_at <= ?
             OR NOT EXISTS (
               SELECT 1
               FROM submission_source_evidence link
               JOIN submissions submission ON submission.id = link.submission_id
               WHERE link.evidence_id = evidence.id
                 AND submission.status IN ('pending', 'needs_more_evidence')
             )
           )
         ORDER BY evidence.retention_expires_at ASC
         LIMIT ?`,
      )
      .all(input.now, input.hardCutoff, input.limit) as SourceEvidenceObjectRow[];
    return rows.map(toSourceEvidenceObject);
  }

  countExpiredSourceEvidence(now: string, hardCutoff: string): number {
    const row = this.database
      .prepare(
        `SELECT count(*) AS count
         FROM source_evidence_objects evidence
         WHERE evidence.deleted_at IS NULL
           AND evidence.retention_expires_at IS NOT NULL
           AND evidence.retention_expires_at <= ?
           AND (
             evidence.created_at <= ?
             OR NOT EXISTS (
               SELECT 1
               FROM submission_source_evidence link
               JOIN submissions submission ON submission.id = link.submission_id
               WHERE link.evidence_id = evidence.id
                 AND submission.status IN ('pending', 'needs_more_evidence')
             )
           )`,
      )
      .get(now, hardCutoff) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countOverdueHeldSourceEvidence(now: string, hardCutoff: string): { heldForOpenReview: number; pastHardCap: number } {
    const row = this.database.prepare(
      `SELECT
         count(*) AS held,
         sum(CASE WHEN evidence.created_at <= ? THEN 1 ELSE 0 END) AS past_hard_cap
       FROM source_evidence_objects evidence
       WHERE evidence.deleted_at IS NULL
         AND evidence.retention_expires_at IS NOT NULL
         AND evidence.retention_expires_at <= ?
         AND EXISTS (
           SELECT 1 FROM submission_source_evidence link
           JOIN submissions submission ON submission.id = link.submission_id
           WHERE link.evidence_id = evidence.id
             AND submission.status IN ('pending', 'needs_more_evidence')
         )`,
    ).get(hardCutoff, now) as { held: number; past_hard_cap: number | null } | undefined;
    return {
      heldForOpenReview: Number(row?.held ?? 0),
      pastHardCap: Number(row?.past_hard_cap ?? 0),
    };
  }

  listSourceEvidenceForOwner(ownerUserId: string): SourceEvidenceObject[] {
    const rows = this.database
      .prepare(
        `SELECT *
         FROM source_evidence_objects
         WHERE owner_user_id = ? AND deleted_at IS NULL
         ORDER BY created_at ASC`,
      )
      .all(ownerUserId) as SourceEvidenceObjectRow[];
    return rows.map(toSourceEvidenceObject);
  }

  markSourceEvidenceDeleted(input: { id: string; deletedAt: string }): void {
    this.database
      .prepare(
        `UPDATE source_evidence_objects
         SET data_base64 = NULL, external_url = NULL, byte_size = NULL, deleted_at = ?
         WHERE id = ?`,
      )
      .run(input.deletedAt, input.id);
  }

  createAccountDeletionRequest(input: {
    id: string;
    userId: string;
    userMessage: string | null;
    requestedAt: string;
    executeAfter: string;
  }) {
    const existing = this.database
      .prepare(
        `SELECT * FROM account_deletion_requests
         WHERE user_id = ? AND status IN ('pending_review', 'approved', 'processing', 'failed')
         ORDER BY requested_at DESC LIMIT 1`,
      )
      .get(input.userId) as Record<string, unknown> | undefined;
    if (existing) {
      return existing;
    }
    this.database
      .prepare(
        `INSERT INTO account_deletion_requests (
          id, user_id, status, user_message, requested_at, execute_after,
          reviewed_by, reviewed_at, completed_at, result_summary_json, created_at, updated_at
        ) VALUES (?, ?, 'pending_review', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(input.id, input.userId, input.userMessage, input.requestedAt, input.executeAfter, input.requestedAt, input.requestedAt);
    return this.database.prepare("SELECT * FROM account_deletion_requests WHERE id = ?").get(input.id) as Record<string, unknown>;
  }

  listAccountDeletionRequests(input: { status?: string; limit: number; offset?: number }): Array<Record<string, unknown>> {
    const offset = Math.max(0, input.offset ?? 0);
    const rows = input.status
      ? this.database.prepare("SELECT * FROM account_deletion_requests WHERE status = ? ORDER BY requested_at DESC LIMIT ? OFFSET ?").all(input.status, input.limit, offset)
      : this.database.prepare("SELECT * FROM account_deletion_requests ORDER BY requested_at DESC LIMIT ? OFFSET ?").all(input.limit, offset);
    return rows as Array<Record<string, unknown>>;
  }

  countAccountDeletionRequests(status?: string): number {
    const row = status
      ? this.database.prepare("SELECT count(*) AS count FROM account_deletion_requests WHERE status = ?").get(status)
      : this.database.prepare("SELECT count(*) AS count FROM account_deletion_requests").get();
    return Number((row as { count: number } | undefined)?.count ?? 0);
  }

  getAccountDeletionRequestForUser(userId: string): Record<string, unknown> | null {
    return (this.database
      .prepare("SELECT * FROM account_deletion_requests WHERE user_id = ? ORDER BY requested_at DESC LIMIT 1")
      .get(userId) as Record<string, unknown> | undefined) ?? null;
  }

  getAccountDeletionRequestById(requestId: string): Record<string, unknown> | null {
    return (this.database
      .prepare("SELECT * FROM account_deletion_requests WHERE id = ? LIMIT 1")
      .get(requestId) as Record<string, unknown> | undefined) ?? null;
  }

  beginAccountDeletion(input: { requestId: string; reviewedBy: string; now: string; staleBefore: string }): Record<string, unknown> | null {
    const result = this.database
      .prepare(
        `UPDATE account_deletion_requests
         SET status = 'processing', reviewed_by = ?, reviewed_at = COALESCE(reviewed_at, ?),
             processing_started_at = ?, last_error = NULL, attempt_count = attempt_count + 1, updated_at = ?
         WHERE id = ? AND (
           status IN ('pending_review', 'approved', 'failed')
           OR (status = 'processing' AND processing_started_at <= ?)
         )`,
      )
      .run(input.reviewedBy, input.now, input.now, input.now, input.requestId, input.staleBefore);
    if (result.changes !== 1) return null;
    return this.database.prepare("SELECT * FROM account_deletion_requests WHERE id = ?").get(input.requestId) as Record<string, unknown>;
  }

  markAccountDeletionIdentityDeleted(input: { requestId: string; now: string }): void {
    this.database
      .prepare(
        `UPDATE account_deletion_requests
         SET identity_deleted_at = COALESCE(identity_deleted_at, ?), updated_at = ?
         WHERE id = ? AND status = 'processing'`,
      )
      .run(input.now, input.now, input.requestId);
  }

  markAccountDeletionStripeCustomerDeleted(input: {
    requestId: string;
    userId: string;
    stripeCustomerId: string;
    now: string;
  }): void {
    this.database.transaction(() => {
      this.database.prepare(
        `UPDATE account_deletion_requests
            SET stripe_customer_deleted_at = COALESCE(stripe_customer_deleted_at, ?),
                stripe_customer_id_snapshot = COALESCE(stripe_customer_id_snapshot, ?), updated_at = ?
          WHERE id = ? AND user_id = ? AND status = 'processing'`,
      ).run(input.now, input.stripeCustomerId, input.now, input.requestId, input.userId);
      this.database.prepare(
        `UPDATE stripe_webhook_events SET payload_json = NULL, last_error = NULL
          WHERE payload_json IS NOT NULL AND json_valid(payload_json)
            AND json_extract(payload_json, '$.data.object.customer') = ?`,
      ).run(input.stripeCustomerId);
      this.database.prepare(
        `UPDATE accounts
            SET subscription_status = 'free', stripe_paid_subscription_status = NULL,
                stripe_customer_id = NULL, stripe_event_created_at = NULL, premium_until = NULL,
                updated_at = ?
          WHERE id = ?`,
      ).run(input.now, input.userId);
    })();
  }

  markAccountDeletionTombstoneRecorded(input: { requestId: string; recordedAt: string; now: string }): void {
    this.database.prepare(
      `UPDATE account_deletion_requests
          SET deletion_tombstone_recorded_at = COALESCE(deletion_tombstone_recorded_at, ?), updated_at = ?
        WHERE id = ? AND status = 'processing'`,
    ).run(input.recordedAt, input.now, input.requestId);
  }

  failAccountDeletion(input: { requestId: string; error: string; now: string }): void {
    this.database
      .prepare(
        `UPDATE account_deletion_requests
         SET status = 'failed', last_error = ?, updated_at = ?
         WHERE id = ? AND status = 'processing'`,
      )
      .run(input.error.slice(0, 500), input.now, input.requestId);
  }

  cancelAccountDeletion(input: { requestId: string; userId: string; now: string }): boolean {
    const result = this.database
      .prepare(
        `UPDATE account_deletion_requests
         SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND user_id = ?
           AND identity_deleted_at IS NULL
           AND stripe_customer_deleted_at IS NULL
           AND deletion_tombstone_recorded_at IS NULL
           AND status IN ('pending_review', 'approved', 'failed')`,
      )
      .run(input.now, input.requestId, input.userId);
    return result.changes === 1;
  }

  exportAccountRelatedData(input: { userId: string; email: string; stripeCustomerId: string | null }): Record<string, unknown> {
    const rows = (sql: string, ...values: unknown[]) =>
      this.database.prepare(sql).all(...values) as Array<Record<string, unknown>>;
    const row = (sql: string, ...values: unknown[]) =>
      (this.database.prepare(sql).get(...values) as Record<string, unknown> | undefined) ?? null;
    const userId = input.userId;
    const email = input.email.trim().toLowerCase();

    return {
      accountPrivate: row(
        `SELECT id, public_account_id, email, display_name, avatar_url, auth_provider, supabase_user_id,
                email_verified_at, mfa_level, mfa_verified_at, provider_tokens_valid_after, role,
                age_confirmed_at, terms_accepted_at, privacy_accepted_at, terms_version, privacy_version,
                age_verification_status, is_over_18_verified, subscription_status, stripe_customer_id,
                stripe_paid_subscription_status, stripe_event_created_at, premium_until, trust_score,
                contribution_points_current_month, approved_submission_count, rejected_submission_count,
                fraud_strike_count, status, created_at, updated_at
           FROM accounts WHERE id = ?`,
        userId,
      ),
      sessions: rows(
        `SELECT substr(token_hash, 1, 24) AS session_id, created_at, expires_at, revoked_at, last_used_at,
                last_ip_hash, user_agent_hash, provider_session_id_hash
           FROM auth_sessions WHERE user_id = ? ORDER BY created_at`,
        userId,
      ),
      revokedProviderSessions: rows(
        `SELECT provider_session_id_hash, revoked_at, reason
           FROM revoked_provider_sessions WHERE user_id = ? ORDER BY revoked_at`,
        userId,
      ),
      discountPasses: rows(
        `SELECT id, status, created_at, expires_at, revoked_at, last_used_at
           FROM account_discount_passes WHERE user_id = ? ORDER BY created_at`,
        userId,
      ),
      sourceEvidenceMetadata: rows(
        `SELECT id, storage_provider, object_path, mime_type, byte_size, retention_expires_at, deleted_at, created_at
           FROM source_evidence_objects WHERE owner_user_id = ? ORDER BY created_at`,
        userId,
      ),
      submissionsReviewed: rows(
        "SELECT * FROM submissions WHERE reviewed_by = ? ORDER BY reviewed_at",
        userId,
      ),
      feedback: rows(
        `SELECT * FROM feedback
          WHERE user_id = ? OR assigned_to = ? OR resolved_by = ? OR lower(COALESCE(contact_email, '')) = ?
          ORDER BY created_at`,
        userId, userId, userId, email,
      ),
      wrongPriceReports: rows(
        `SELECT * FROM wrong_price_reports WHERE user_id = ? OR assigned_to = ? OR resolved_by = ? ORDER BY created_at`,
        userId, userId, userId,
      ),
      venueRequests: rows(
        `SELECT * FROM venue_requests WHERE user_id = ? OR assigned_to = ? OR resolved_by = ? ORDER BY created_at`,
        userId, userId, userId,
      ),
      venueInterestRequests: rows(
        `SELECT * FROM venue_interest_requests
          WHERE user_id = ? OR assigned_to = ? OR resolved_by = ? OR lower(email) = ? ORDER BY created_at`,
        userId, userId, userId, email,
      ),
      venueClaimRequests: rows(
        `SELECT * FROM venue_claim_requests
          WHERE user_id = ? OR reviewed_by = ? OR lower(contact_email) = ? ORDER BY created_at`,
        userId, userId, email,
      ),
      ageVerifications: rows("SELECT * FROM age_verifications WHERE user_id = ? ORDER BY created_at", userId),
      verifications: rows("SELECT * FROM verifications WHERE verifier_user_id = ? ORDER BY created_at", userId),
      missionProgress: rows("SELECT * FROM mission_progress WHERE user_id = ? ORDER BY accepted_at", userId),
      venueAssignments: rows(
        "SELECT * FROM venue_manager_assignments WHERE user_id = ? OR approved_by = ? ORDER BY created_at",
        userId, userId,
      ),
      venuePendingChanges: rows(
        `SELECT * FROM venue_pending_changes
          WHERE submitted_by = ? OR reviewed_by = ? OR instr(payload_json, ?) > 0 OR instr(lower(payload_json), ?) > 0
          ORDER BY created_at`,
        userId, userId, userId, email,
      ),
      venuePartnerOutreach: rows(
        `SELECT * FROM venue_partner_outreach
          WHERE updated_by = ? OR instr(lower(COALESCE(notes, '')), ?) > 0 ORDER BY created_at`,
        userId, email,
      ),
      discountRedemptions: rows(
        "SELECT * FROM discount_redemptions WHERE user_id = ? OR redeemed_by_user_id = ? ORDER BY created_at",
        userId, userId,
      ),
      pintPointDrinkRecords: rows(
        `SELECT * FROM pint_point_drink_records
          WHERE user_id = ? OR recorded_by_user_id = ? OR voided_by_user_id = ? ORDER BY created_at`,
        userId, userId, userId,
      ),
      pintPointLedger: rows("SELECT * FROM pint_point_ledger WHERE user_id = ? ORDER BY created_at", userId),
      freePintRewardCodes: rows(
        "SELECT * FROM free_pint_reward_codes WHERE user_id = ? OR redeemed_by_user_id = ? ORDER BY created_at",
        userId, userId,
      ),
      freePintRewardRedemptions: rows(
        "SELECT * FROM free_pint_reward_redemptions WHERE user_id = ? OR redeemed_by_user_id = ? ORDER BY created_at",
        userId, userId,
      ),
      contributionLedger: rows("SELECT * FROM contribution_ledger WHERE user_id = ? ORDER BY created_at", userId),
      rewardVouchers: rows("SELECT * FROM account_reward_vouchers WHERE user_id = ? ORDER BY created_at", userId),
      leaderboardPrizeAwards: rows("SELECT * FROM leaderboard_prize_awards WHERE user_id = ? ORDER BY created_at", userId),
      leaderboardPrizeCampaignsFinalized: rows(
        "SELECT * FROM leaderboard_prize_campaigns WHERE finalized_by = ? ORDER BY created_at",
        userId,
      ),
      activity: rows("SELECT * FROM user_activity_events WHERE user_id = ? ORDER BY created_at", userId),
      analyticsEvents: rows("SELECT * FROM events WHERE user_id = ? ORDER BY created_at", userId),
      securityAudit: rows(
        `SELECT * FROM security_audit_log
          WHERE actor_user_id = ? OR (target_type = 'account' AND target_id = ?) ORDER BY created_at`,
        userId, userId,
      ),
      deletionRequests: rows(
        "SELECT * FROM account_deletion_requests WHERE user_id = ? OR reviewed_by = ? ORDER BY requested_at",
        userId, userId,
      ),
      venueReportDeliverySettings: rows(
        `SELECT key, value_json, updated_at FROM system_state
          WHERE key LIKE 'venue-report-delivery:%'
            AND json_valid(value_json)
            AND (
              json_extract(value_json, '$.updatedBy') = ?
              OR EXISTS (
                SELECT 1 FROM json_each(value_json, '$.recipients')
                WHERE lower(CAST(value AS TEXT)) = ?
              )
            )
          ORDER BY updated_at`,
        userId, email,
      ),
      migrationQuarantinedRecords: rows(
        `SELECT * FROM migration_quarantined_records
          WHERE instr(payload_json, ?) > 0 OR instr(lower(payload_json), ?) > 0
          ORDER BY quarantined_at`,
        userId, email,
      ),
      stripeWebhookEvents: input.stripeCustomerId
        ? rows(
            `SELECT * FROM stripe_webhook_events
              WHERE payload_json IS NOT NULL AND json_valid(payload_json)
                AND (
                  json_extract(payload_json, '$.data.object.customer') = ?
                  OR json_extract(payload_json, '$.data.object.metadata.user_id') = ?
                )
              ORDER BY received_at`,
            input.stripeCustomerId, userId,
          )
        : rows(
            `SELECT * FROM stripe_webhook_events
              WHERE payload_json IS NOT NULL AND json_valid(payload_json)
                AND json_extract(payload_json, '$.data.object.metadata.user_id') = ?
              ORDER BY received_at`,
            userId,
          ),
    };
  }

  executeAccountAnonymisation(input: { requestId: string; reviewedBy: string; now: string }): Record<string, unknown> {
    return this.database.transaction(() => {
      const request = this.database
        .prepare("SELECT * FROM account_deletion_requests WHERE id = ?")
        .get(input.requestId) as {
          user_id: string;
          status: string;
          execute_after: string;
          stripe_customer_id_snapshot: string | null;
        } | undefined;
      if (!request) throw new Error("Deletion request not found");
      if (request.status !== 'processing') throw new Error("Deletion request is not in processing state");

      const userId = request.user_id;
      const account = this.database
        .prepare("SELECT email, stripe_customer_id FROM accounts WHERE id = ?")
        .get(userId) as { email: string; stripe_customer_id: string | null } | undefined;
      if (!account) throw new Error("Account not found");
      const surrogatePublicId = `DEL-${crypto.createHash("sha256").update(userId).digest("hex").slice(0, 12).toUpperCase()}`;
      const surrogateEmail = `deleted-${userId}@invalid.pintpath.local`;
      const evidenceRows = this.database
        .prepare("SELECT * FROM source_evidence_objects WHERE owner_user_id = ? AND deleted_at IS NULL")
        .all(userId) as SourceEvidenceObjectRow[];

      this.database.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM revoked_provider_sessions WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM account_discount_passes WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM account_preferences WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM account_privacy_settings WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM saved_items WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM user_activity_events WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM events WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM age_verifications WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM verifications WHERE verifier_user_id = ?").run(userId);
      this.database.prepare("DELETE FROM mission_progress WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM venue_manager_assignments WHERE user_id = ?").run(userId);
      this.database.prepare("UPDATE venue_manager_assignments SET approved_by = NULL WHERE approved_by = ?").run(userId);
      this.database.prepare("DELETE FROM discount_redemptions WHERE user_id = ?").run(userId);
      this.database.prepare("UPDATE discount_redemptions SET redeemed_by_user_id = NULL WHERE redeemed_by_user_id = ?").run(userId);
      this.database.prepare("DELETE FROM pint_point_ledger WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM pint_point_drink_records WHERE user_id = ?").run(userId);
      this.database.prepare("UPDATE pint_point_drink_records SET recorded_by_user_id = NULL WHERE recorded_by_user_id = ?").run(userId);
      this.database.prepare("UPDATE pint_point_drink_records SET voided_by_user_id = NULL WHERE voided_by_user_id = ?").run(userId);
      this.database.prepare("DELETE FROM free_pint_reward_redemptions WHERE user_id = ?").run(userId);
      this.database.prepare("UPDATE free_pint_reward_redemptions SET redeemed_by_user_id = NULL WHERE redeemed_by_user_id = ?").run(userId);
      this.database.prepare("DELETE FROM free_pint_reward_codes WHERE user_id = ?").run(userId);
      this.database.prepare("UPDATE free_pint_reward_codes SET redeemed_by_user_id = NULL WHERE redeemed_by_user_id = ?").run(userId);
      this.database.prepare("DELETE FROM leaderboard_prize_awards WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM account_reward_vouchers WHERE user_id = ?").run(userId);
      this.database.prepare("UPDATE leaderboard_prize_campaigns SET finalized_by = NULL WHERE finalized_by = ?").run(userId);
      this.database.prepare("DELETE FROM venue_pending_changes WHERE submitted_by = ?").run(userId);
      this.database.prepare(
        `UPDATE venue_pending_changes
            SET reviewed_by = CASE WHEN reviewed_by = ? THEN NULL ELSE reviewed_by END,
                payload_json = CASE WHEN instr(payload_json, ?) > 0 OR instr(lower(payload_json), ?) > 0
                                    THEN '{"redactedAfterAccountDeletion":true}' ELSE payload_json END,
                rejection_reason = CASE WHEN reviewed_by = ? THEN NULL ELSE rejection_reason END,
                updated_at = ?
          WHERE reviewed_by = ? OR instr(payload_json, ?) > 0 OR instr(lower(payload_json), ?) > 0`,
      ).run(userId, userId, account.email.toLowerCase(), userId, input.now, userId, userId, account.email.toLowerCase());
      this.database.prepare(
        `UPDATE venue_partner_outreach
            SET updated_by = CASE WHEN updated_by = ? THEN NULL ELSE updated_by END,
                notes = CASE WHEN updated_by = ? OR instr(lower(COALESCE(notes, '')), ?) > 0 THEN NULL ELSE notes END,
                updated_at = ?
          WHERE updated_by = ? OR instr(lower(COALESCE(notes, '')), ?) > 0`,
      ).run(userId, userId, account.email.toLowerCase(), input.now, userId, account.email.toLowerCase());
      this.database.prepare(
        "UPDATE contribution_ledger SET reason = 'Retained anonymised contribution record' WHERE user_id = ?",
      ).run(userId);

      this.database.prepare(
        `UPDATE feedback
            SET user_id = CASE WHEN user_id = ? THEN NULL ELSE user_id END,
                anonymous_session_id = CASE WHEN user_id = ? OR lower(COALESCE(contact_email, '')) = lower(?) THEN NULL ELSE anonymous_session_id END,
                contact_email = CASE WHEN user_id = ? OR lower(COALESCE(contact_email, '')) = lower(?) THEN NULL ELSE contact_email END,
                message = CASE WHEN user_id = ? OR lower(COALESCE(contact_email, '')) = lower(?)
                               THEN '[redacted after account deletion]' ELSE message END,
                assigned_to = CASE WHEN assigned_to = ? THEN NULL ELSE assigned_to END,
                resolved_by = CASE WHEN resolved_by = ? THEN NULL ELSE resolved_by END,
                resolution_note = CASE WHEN user_id = ? OR lower(COALESCE(contact_email, '')) = lower(?) OR resolved_by = ?
                                       THEN NULL ELSE resolution_note END,
                updated_at = ?
          WHERE user_id = ? OR assigned_to = ? OR resolved_by = ? OR lower(COALESCE(contact_email, '')) = lower(?)`,
      ).run(
        userId, userId, account.email, userId, account.email, userId, account.email,
        userId, userId, userId, account.email, userId, input.now,
        userId, userId, userId, account.email,
      );
      this.database.prepare(
        `UPDATE wrong_price_reports
            SET user_id = CASE WHEN user_id = ? THEN NULL ELSE user_id END,
                anonymous_session_id = CASE WHEN user_id = ? THEN NULL ELSE anonymous_session_id END,
                notes = CASE WHEN user_id = ? THEN NULL ELSE notes END,
                source_photo_url = CASE WHEN user_id = ? THEN NULL ELSE source_photo_url END,
                assigned_to = CASE WHEN assigned_to = ? THEN NULL ELSE assigned_to END,
                resolved_by = CASE WHEN resolved_by = ? THEN NULL ELSE resolved_by END,
                resolution_note = CASE WHEN user_id = ? OR resolved_by = ? THEN NULL ELSE resolution_note END,
                updated_at = ?
          WHERE user_id = ? OR assigned_to = ? OR resolved_by = ?`,
      ).run(userId, userId, userId, userId, userId, userId, userId, userId, input.now, userId, userId, userId);
      this.database.prepare(
        `UPDATE venue_requests
            SET user_id = CASE WHEN user_id = ? THEN NULL ELSE user_id END,
                anonymous_session_id = CASE WHEN user_id = ? THEN NULL ELSE anonymous_session_id END,
                notes = CASE WHEN user_id = ? THEN NULL ELSE notes END,
                assigned_to = CASE WHEN assigned_to = ? THEN NULL ELSE assigned_to END,
                resolved_by = CASE WHEN resolved_by = ? THEN NULL ELSE resolved_by END,
                resolution_note = CASE WHEN user_id = ? OR resolved_by = ? THEN NULL ELSE resolution_note END,
                updated_at = ?
          WHERE user_id = ? OR assigned_to = ? OR resolved_by = ?`,
      ).run(userId, userId, userId, userId, userId, userId, userId, input.now, userId, userId, userId);
      this.database.prepare(
        `UPDATE venue_interest_requests
            SET user_id = CASE WHEN user_id = ? THEN NULL ELSE user_id END,
                manager_name = CASE WHEN user_id = ? OR lower(email) = lower(?) THEN 'Deleted account' ELSE manager_name END,
                email = CASE WHEN user_id = ? OR lower(email) = lower(?) THEN ? ELSE email END,
                phone = CASE WHEN user_id = ? OR lower(email) = lower(?) THEN NULL ELSE phone END,
                notes = CASE WHEN user_id = ? OR lower(email) = lower(?) THEN NULL ELSE notes END,
                assigned_to = CASE WHEN assigned_to = ? THEN NULL ELSE assigned_to END,
                resolved_by = CASE WHEN resolved_by = ? THEN NULL ELSE resolved_by END,
                resolution_note = CASE WHEN user_id = ? OR resolved_by = ? THEN NULL ELSE resolution_note END,
                updated_at = ?
          WHERE user_id = ? OR assigned_to = ? OR resolved_by = ? OR lower(email) = lower(?)`,
      ).run(
        userId, userId, account.email, userId, account.email, surrogateEmail, userId, account.email,
        userId, account.email, userId, userId, userId, userId, input.now, userId, userId, userId, account.email,
      );
      this.database.prepare(
        `UPDATE venue_claim_requests
            SET requester_name = CASE WHEN user_id = ? OR lower(contact_email) = lower(?) THEN 'Deleted account' ELSE requester_name END,
                requester_role = CASE WHEN user_id = ? OR lower(contact_email) = lower(?) THEN 'Deleted account' ELSE requester_role END,
                contact_email = CASE WHEN user_id = ? OR lower(contact_email) = lower(?) THEN ? ELSE contact_email END,
                contact_phone = CASE WHEN user_id = ? OR lower(contact_email) = lower(?) THEN NULL ELSE contact_phone END,
                message = CASE WHEN user_id = ? OR lower(contact_email) = lower(?) THEN NULL ELSE message END,
                reviewed_by = CASE WHEN reviewed_by = ? THEN NULL ELSE reviewed_by END,
                review_note = CASE WHEN reviewed_by = ? THEN NULL ELSE review_note END,
                updated_at = ?
          WHERE user_id = ? OR reviewed_by = ? OR lower(contact_email) = lower(?)`,
      ).run(
        userId, account.email, userId, account.email, userId, account.email, surrogateEmail,
        userId, account.email, userId, account.email, userId, userId, input.now, userId, userId, account.email,
      );
      this.database.prepare(
        `UPDATE submissions
            SET client_submission_id = NULL, notes = NULL, source_photo_url = NULL,
                upload_latitude = NULL, upload_longitude = NULL, upload_accuracy_meters = NULL,
                upload_location_captured_at = NULL,
                reviewed_by = CASE WHEN reviewed_by = ? THEN NULL ELSE reviewed_by END
          WHERE user_id = ? OR reviewed_by = ?`,
      ).run(userId, userId, userId);
      this.database.prepare("DELETE FROM submission_source_evidence WHERE submission_id IN (SELECT id FROM submissions WHERE user_id = ?)").run(userId);
      this.database.prepare("UPDATE source_evidence_objects SET owner_user_id = NULL WHERE owner_user_id = ?").run(userId);
      const reportSettings = this.database.prepare(
        `SELECT key, value_json FROM system_state
          WHERE key LIKE 'venue-report-delivery:%' AND json_valid(value_json)`,
      ).all() as Array<{ key: string; value_json: string }>;
      for (const setting of reportSettings) {
        const value = parseJsonObject(setting.value_json);
        const recipients = Array.isArray(value.recipients)
          ? value.recipients.filter((item): item is string => typeof item === "string")
          : [];
        const filteredRecipients = recipients.filter((recipient) => recipient.trim().toLowerCase() !== account.email.toLowerCase());
        const authoredByUser = value.updatedBy === userId;
        if (!authoredByUser && filteredRecipients.length === recipients.length) continue;
        this.database.prepare("UPDATE system_state SET value_json = ?, updated_at = ? WHERE key = ?").run(
          JSON.stringify({
            ...value,
            enabled: filteredRecipients.length > 0 ? value.enabled !== false : false,
            recipients: filteredRecipients,
            updatedBy: authoredByUser ? null : value.updatedBy,
            redactedAfterAccountDeletion: true,
          }),
          input.now,
          setting.key,
        );
      }
      this.database.prepare(
        `UPDATE migration_quarantined_records
            SET payload_json = '{"redactedAfterAccountDeletion":true}'
          WHERE instr(payload_json, ?) > 0 OR instr(lower(payload_json), ?) > 0`,
      ).run(userId, account.email.toLowerCase());
      this.database.prepare(
        `UPDATE security_audit_log
            SET actor_user_id = CASE WHEN actor_user_id = ? THEN NULL ELSE actor_user_id END,
                actor_role = CASE WHEN actor_user_id = ? THEN NULL ELSE actor_role END,
                target_id = CASE WHEN target_id = ? THEN ? ELSE target_id END,
                metadata_json = CASE WHEN actor_user_id = ? OR target_id = ?
                                     THEN '{"redactedAfterAccountDeletion":true}' ELSE metadata_json END,
                ip_hash = CASE WHEN actor_user_id = ? THEN NULL ELSE ip_hash END,
                user_agent_hash = CASE WHEN actor_user_id = ? THEN NULL ELSE user_agent_hash END
          WHERE actor_user_id = ? OR target_id = ?`,
      ).run(userId, userId, userId, surrogatePublicId, userId, userId, userId, userId, userId, userId);
      const jsonIdentityMatches = (
        table: "security_audit_log" | "events",
        idColumn: "id",
      ) => this.database.prepare(
        `SELECT ${idColumn} AS id, metadata_json
           FROM ${table}
          WHERE instr(metadata_json, ?) > 0 OR instr(lower(metadata_json), ?) > 0`,
      ).all(userId, account.email.toLowerCase()) as Array<{ id: string; metadata_json: string }>;
      for (const table of ["security_audit_log", "events"] as const) {
        for (const row of jsonIdentityMatches(table, "id")) {
          this.database.prepare(`UPDATE ${table} SET metadata_json = ? WHERE id = ?`).run(
            scrubDeletedIdentityJson(row.metadata_json, {
              userId,
              email: account.email,
              surrogateId: surrogatePublicId,
            }),
            row.id,
          );
        }
      }
      const stripeCustomerId = account.stripe_customer_id ?? request.stripe_customer_id_snapshot;
      if (stripeCustomerId) {
        this.database.prepare(
          `UPDATE stripe_webhook_events SET payload_json = NULL, last_error = NULL
            WHERE payload_json IS NOT NULL AND json_valid(payload_json)
              AND (json_extract(payload_json, '$.data.object.customer') = ?
                   OR json_extract(payload_json, '$.data.object.metadata.user_id') = ?)`,
        ).run(stripeCustomerId, userId);
      } else {
        this.database.prepare(
          `UPDATE stripe_webhook_events SET payload_json = NULL, last_error = NULL
            WHERE payload_json IS NOT NULL AND json_valid(payload_json)
              AND json_extract(payload_json, '$.data.object.metadata.user_id') = ?`,
        ).run(userId);
      }
      this.database.prepare(
        `UPDATE account_deletion_requests
            SET user_message = NULL, last_error = NULL, stripe_customer_id_snapshot = NULL
          WHERE user_id = ?`,
      ).run(userId);
      this.database.prepare(
        "UPDATE account_deletion_requests SET reviewed_by = NULL WHERE reviewed_by = ? AND user_id <> ?",
      ).run(userId, userId);
      this.database.prepare(
        `UPDATE profiles
            SET public_account_id = ?, email = ?, username = NULL, avatar_url = NULL, display_name = NULL,
                display_name_key = NULL, role = 'user', account_status = 'suspended',
                age_verification_status = 'not_started', is_over_18_verified = 0, updated_at = ?
          WHERE id = ?`,
      ).run(surrogatePublicId, surrogateEmail, input.now, userId);
      this.database.prepare(
        `UPDATE accounts
         SET public_account_id = ?, email = ?, password_hash = 'deleted', display_name = NULL, display_name_key = NULL,
             avatar_url = NULL, auth_provider = 'deleted', supabase_user_id = NULL, email_verified_at = NULL,
             mfa_level = 'aal1', mfa_verified_at = NULL, provider_tokens_valid_after = NULL,
             role = 'user', age_confirmed_at = NULL, terms_accepted_at = NULL, privacy_accepted_at = NULL,
             terms_version = NULL, privacy_version = NULL, age_verification_status = 'not_started',
             is_over_18_verified = 0, subscription_status = 'free', stripe_customer_id = NULL,
             stripe_paid_subscription_status = NULL, stripe_event_created_at = NULL, premium_until = NULL,
             trust_score = 0, contribution_points_current_month = 0, fraud_strike_count = 0,
             status = 'suspended', updated_at = ?
         WHERE id = ?`,
      ).run(surrogatePublicId, surrogateEmail, input.now, userId);

      const summary = {
        anonymisedAccount: surrogatePublicId,
        surrogatePublicId,
        evidenceIds: evidenceRows.map((row) => row.id),
        retentionPolicyVersion: ACCOUNT_DATA_RETENTION_POLICY.version,
      };
      this.database.prepare(
        `UPDATE account_deletion_requests
         SET status = 'completed', reviewed_by = ?, reviewed_at = ?, completed_at = ?,
             result_summary_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.reviewedBy, input.now, input.now, JSON.stringify(summary), input.now, input.requestId);
      return summary;
    })();
  }

  listSubmissionSourceEvidenceIds(submissionId: string): string[] {
    const rows = this.database
      .prepare(
        `SELECT evidence_id
           FROM submission_source_evidence
          WHERE submission_id = ?
          ORDER BY sort_order ASC`,
      )
      .all(submissionId) as Array<{ evidence_id: string }>;
    return rows.map((row) => row.evidence_id);
  }

  countEvents(input: {
    eventType: string;
    userId: string | null;
    anonymousSessionId: string | null;
    since: string;
    venueId?: string | null;
  }): number {
    const venueClause = input.venueId ? "AND venue_id = ?" : "";
    const values: unknown[] = [
      input.eventType,
      input.since,
      input.userId,
      input.userId,
      input.anonymousSessionId,
      input.anonymousSessionId,
    ];
    if (input.venueId) {
      values.push(input.venueId);
    }

    const row = this.database
      .prepare(
        `SELECT count(*) AS count
         FROM events
         WHERE event_type = ?
           AND created_at >= ?
           AND (
             (? IS NOT NULL AND user_id = ?)
             OR (? IS NOT NULL AND anonymous_session_id = ?)
           )
           ${venueClause}`,
      )
      .get(...values) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private venueLabelExpression(keyExpression: string, metadataExpression = "NULL"): string {
    return `COALESCE(
      NULLIF(${metadataExpression}, ''),
      (SELECT name FROM venue_profiles profile WHERE profile.venue_id = ${keyExpression} LIMIT 1),
      (SELECT venue_name FROM venue_location_cache location WHERE location.venue_id = ${keyExpression} LIMIT 1),
      (SELECT venue_name FROM venue_price_records record WHERE record.venue_id = ${keyExpression} ORDER BY last_verified_at DESC LIMIT 1),
      (SELECT venue_name FROM venue_requests request WHERE request.venue_id = ${keyExpression} ORDER BY created_at DESC LIMIT 1),
      (SELECT venue_name FROM missions mission WHERE mission.venue_id = ${keyExpression} ORDER BY updated_at DESC LIMIT 1),
      ${keyExpression}
    )`;
  }

  getAnalyticsPreview(): {
    topSearchedBeers: AnalyticsBucket[];
    topClickedVenues: AnalyticsBucket[];
    topSuburbs: AnalyticsBucket[];
    missionConversionCount: number;
  } {
    const grouped = (eventTypes: string | string[], column: "beer_id" | "venue_id" | "suburb") => {
      const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
      const placeholders = types.map(() => "?").join(", ");

      return this.database
        .prepare(
          `SELECT ${column} AS key, count(*) AS count
           FROM events
           WHERE event_type IN (${placeholders}) AND ${column} IS NOT NULL AND ${column} != ''
           GROUP BY ${column}
           ORDER BY count DESC
           LIMIT 10`,
        )
        .all(...types) as AnalyticsBucket[];
    };
    const groupedVenues = (eventTypes: string | string[], limit = 10) => {
      const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
      const placeholders = types.map(() => "?").join(", ");

      return this.database
        .prepare(
          `WITH grouped AS (
             SELECT venue_id AS key,
                    count(*) AS count,
                    max(json_extract(metadata_json, '$.venueName')) AS metadata_label
               FROM events
              WHERE event_type IN (${placeholders})
                AND venue_id IS NOT NULL
                AND venue_id != ''
              GROUP BY venue_id
              ORDER BY count DESC
              LIMIT ?
           )
           SELECT key,
                  count,
                  ${this.venueLabelExpression("key", "metadata_label")} AS label
             FROM grouped
            ORDER BY count DESC`,
        )
        .all(...types, limit) as AnalyticsBucket[];
    };

    const missionRow = this.database
      .prepare("SELECT count(*) AS count FROM events WHERE event_type = 'submission_completed'")
      .get() as { count: number } | undefined;

    return {
      topSearchedBeers: grouped("beer_search_performed", "beer_id"),
      topClickedVenues: groupedVenues(["map_pin_click", "venue_card_viewed", "venue_detail_opened", "venue_lookup"]),
      topSuburbs: grouped(
        [
          "search_performed",
          "beer_search_performed",
          "venue_card_viewed",
          "venue_detail_opened",
          "map_filter_used",
          "submission_completed",
        ],
        "suburb",
      ),
      missionConversionCount: Number(missionRow?.count ?? 0),
    };
  }

  getAdminKpiDashboard(input: {
    since: string | null;
    sevenDaysAgo: string;
    thirtyDaysAgo: string;
    staleBefore: string;
    totalVenues: number;
  }) {
    const rangeFor = (column: string) => input.since ? `AND ${column} >= ?` : "";
    const rangeClause = rangeFor("created_at");
    const rangeValues = input.since ? [input.since] : [];
    const count = (sql: string, values: unknown[] = []) => {
      const row = this.database.prepare(sql).get(...values) as { count: number } | undefined;
      return Number(row?.count ?? 0);
    };
    const scalar = (sql: string, values: unknown[] = []) => {
      const row = this.database.prepare(sql).get(...values) as { value: number } | undefined;
      return Number(row?.value ?? 0);
    };
    const grouped = (sql: string, values: unknown[] = []) =>
      this.database.prepare(sql).all(...values) as Array<{ key: string; count: number }>;
    const eventCount = (eventTypes: string[]) => {
      const placeholders = eventTypes.map(() => "?").join(", ");
      return count(
        `SELECT count(*) AS count FROM events WHERE event_type IN (${placeholders}) ${rangeClause}`,
        [...eventTypes, ...rangeValues],
      );
    };
    const topEventGroup = (eventTypes: string[], column: "beer_id" | "venue_id" | "suburb", limit = 8) => {
      const placeholders = eventTypes.map(() => "?").join(", ");
      return grouped(
        `SELECT ${column} AS key, count(*) AS count
         FROM events
         WHERE event_type IN (${placeholders})
           AND ${column} IS NOT NULL
           AND ${column} != ''
           ${rangeFor("created_at")}
         GROUP BY ${column}
         ORDER BY count DESC
         LIMIT ?`,
        [...eventTypes, ...rangeValues, limit],
      );
    };
    const topVenueEventGroup = (eventTypes: string[], limit = 8) => {
      const placeholders = eventTypes.map(() => "?").join(", ");
      return grouped(
        `WITH grouped AS (
           SELECT venue_id AS key,
                  count(*) AS count,
                  max(json_extract(metadata_json, '$.venueName')) AS metadata_label
             FROM events
            WHERE event_type IN (${placeholders})
              AND venue_id IS NOT NULL
              AND venue_id != ''
              ${rangeFor("created_at")}
            GROUP BY venue_id
            ORDER BY count DESC
            LIMIT ?
         )
         SELECT key,
                count,
                ${this.venueLabelExpression("key", "metadata_label")} AS label
           FROM grouped
          ORDER BY count DESC`,
        [...eventTypes, ...rangeValues, limit],
      );
    };

    const totalUsers = count("SELECT count(*) AS count FROM accounts");
    const newUsers = count(`SELECT count(*) AS count FROM accounts WHERE 1=1 ${rangeClause}`, rangeValues);
    const subscriptionConversions = eventCount(["subscription_created"]);
    const verifiedVenueCount = count(
      `SELECT count(DISTINCT venue_id) AS count
       FROM venue_price_records
       WHERE confidence IN ('admin_verified', 'venue_confirmed', 'photo_verified', 'community_confirmed')`,
    );
    const staleVenueCount = count(
      `SELECT count(DISTINCT venue_id) AS count
       FROM venue_price_records
       WHERE last_verified_at < ? OR confidence IN ('stale', 'disputed')`,
      [input.staleBefore],
    );
    const noDataVenueCount = Math.max(0, input.totalVenues - verifiedVenueCount);
    const approvedSubmissionCount = count(
      `SELECT count(*) AS count FROM submissions WHERE status = 'approved' ${input.since ? "AND reviewed_at >= ?" : ""}`,
      rangeValues,
    );
    const rejectedSubmissionCount = count(
      `SELECT count(*) AS count FROM submissions WHERE status IN ('rejected', 'fraud_flagged') ${input.since ? "AND reviewed_at >= ?" : ""}`,
      rangeValues,
    );
    const totalReviewed = approvedSubmissionCount + rejectedSubmissionCount;
    const yearlyPaidUsers = count("SELECT count(*) AS count FROM accounts WHERE subscription_status = 'premium_yearly'");
    const usersTried = count("SELECT count(DISTINCT COALESCE(user_id, anonymous_session_id)) AS count FROM events");
    const returnedThirtyDays = count(
      `SELECT count(DISTINCT a.id) AS count
       FROM accounts a
       JOIN events e ON e.user_id = a.id
       WHERE julianday(e.created_at) > julianday(a.created_at)
         AND julianday(e.created_at) <= julianday(a.created_at) + 30
         AND e.event_type IN (
           'search_performed', 'beer_search_performed', 'venue_detail_opened',
           'free_preview_viewed', 'price_view_revealed', 'submission_completed', 'mission_opened', 'map_filter_used'
         )`,
    );

    const topVenuesNeedingData = grouped(
      `SELECT venue_name AS key, CAST(points * multiplier AS INTEGER) AS count
       FROM missions
       WHERE active = 1
       ORDER BY (points * multiplier) DESC, updated_at DESC
       LIMIT 8`,
    );
    const highDemandMissing = grouped(
      `WITH grouped AS (
         SELECT e.venue_id AS key,
                count(*) AS count,
                max(json_extract(e.metadata_json, '$.venueName')) AS metadata_label
           FROM events e
          WHERE e.event_type IN ('venue_card_viewed', 'venue_detail_opened', 'free_preview_viewed', 'price_view_revealed')
            AND e.venue_id IS NOT NULL
            AND e.venue_id != ''
            ${rangeFor("e.created_at")}
          GROUP BY e.venue_id
       ),
       stale AS (
         SELECT grouped.*,
                (SELECT max(last_verified_at) FROM venue_price_records record WHERE record.venue_id = grouped.key) AS latest_verified_at
           FROM grouped
       )
       SELECT key,
              count,
              ${this.venueLabelExpression("key", "metadata_label")} AS label
         FROM stale
        WHERE latest_verified_at IS NULL OR latest_verified_at < ?
        ORDER BY count DESC
        LIMIT 8`,
      [...rangeValues, input.staleBefore],
    );

    const metrics = {
      totalUsers,
      newUsers,
      weeklyActiveUsers: count("SELECT count(DISTINCT user_id) AS count FROM events WHERE user_id IS NOT NULL AND created_at >= ?", [input.sevenDaysAgo]),
      monthlyActiveUsers: count("SELECT count(DISTINCT user_id) AS count FROM events WHERE user_id IS NOT NULL AND created_at >= ?", [input.thirtyDaysAgo]),
      returningUsers: count(
        `SELECT count(DISTINCT e.user_id) AS count
         FROM events e
         JOIN accounts a ON a.id = e.user_id
         WHERE e.user_id IS NOT NULL
           AND julianday(e.created_at) > julianday(a.created_at)
           ${rangeFor("e.created_at")}`,
        rangeValues,
      ),
      freeUsers: count("SELECT count(*) AS count FROM accounts WHERE subscription_status = 'free'"),
      paidUsers: count("SELECT count(*) AS count FROM accounts WHERE subscription_status IN ('premium_monthly', 'premium_yearly')"),
      contributorUnlockedUsers: count("SELECT count(*) AS count FROM accounts WHERE subscription_status = 'contributor_unlocked'"),
      subscriptionConversionCount: subscriptionConversions,
      subscriptionConversionRate: newUsers > 0 ? subscriptionConversions / newUsers : totalUsers > 0 ? subscriptionConversions / totalUsers : 0,
      totalVenueSearches: eventCount(["search_performed", "suburb_search_performed"]),
      totalBeerSearches: eventCount(["beer_search_performed"]),
      totalVenueDetailViews: eventCount(["map_pin_click", "venue_card_viewed", "venue_detail_opened", "venue_lookup"]),
      totalFreePreviewViews: eventCount(["free_preview_viewed", "price_view_revealed"]),
      totalMapFilterUses: eventCount([
        "map_filter_used",
        "cheapest_sort_used",
        "happy_hour_active_now_used",
        "happy_hour_near_me_used",
        "distance_sort_used",
        "verified_only_filter_used",
        "under_10_filter_used",
        "near_me_enabled",
        "radius_filter_changed",
      ]),
      totalNearMeUses: eventCount(["near_me_enabled"]),
      totalHappyHourNearMeUses: eventCount(["happy_hour_near_me_used"]),
      totalDistanceSortUses: eventCount(["distance_sort_used"]),
      totalSubmissionStarts: eventCount(["submission_started"]),
      totalSubmissionCompletions: eventCount(["submission_completed"]),
      totalPendingSubmissions: count("SELECT count(*) AS count FROM submissions WHERE status = 'pending'"),
      totalApprovedSubmissions: approvedSubmissionCount,
      totalRejectedSubmissions: rejectedSubmissionCount,
      submissionApprovalRate: totalReviewed > 0 ? approvedSubmissionCount / totalReviewed : 0,
      totalContributorPointsAwarded: scalar(`SELECT COALESCE(sum(points), 0) AS value FROM contribution_ledger WHERE 1=1 ${rangeClause}`, rangeValues),
      contributorAccessEarnedUsers: count("SELECT count(*) AS count FROM accounts WHERE subscription_status = 'contributor_unlocked'"),
      venuesWithVerifiedData: verifiedVenueCount,
      venuesWithStaleData: staleVenueCount,
      venuesWithNoBeerPriceData: noDataVenueCount,
      activeMissions: count("SELECT count(*) AS count FROM missions WHERE active = 1"),
      missionCompletionCount: eventCount(["submission_completed"]),
      potentialPartnerLeadCount: count("SELECT count(DISTINCT venue_id) AS count FROM events WHERE venue_id IS NOT NULL AND event_type IN ('map_pin_click', 'venue_detail_opened', 'venue_card_viewed', 'venue_lookup')"),
      yearlyPaidUsers,
      usersTried,
      returnedThirtyDays,
      usersSubmitted: count("SELECT count(DISTINCT user_id) AS count FROM submissions"),
      verifiedPricesAdded: count("SELECT count(*) AS count FROM venue_price_records WHERE confidence IN ('admin_verified', 'venue_confirmed', 'photo_verified', 'community_confirmed')"),
    };

    return {
      metrics,
      scorecard: [
        { label: "100 users tried the app", current: metrics.usersTried, target: 100 },
        { label: "30 users returned within 30 days", current: returnedThirtyDays, target: 30 },
        { label: "20 users submitted data", current: metrics.usersSubmitted, target: 20 },
        { label: "100 verified prices added", current: metrics.verifiedPricesAdded, target: 100 },
        { label: "10 users paid for yearly access", current: yearlyPaidUsers, target: 10 },
        { label: "3 venues flagged as potential partner leads", current: metrics.potentialPartnerLeadCount, target: 3 },
      ].map((item) => ({
        ...item,
        progress: item.target > 0 ? Math.min(1, item.current / item.target) : 0,
        status: item.current <= 0 ? "not started" : item.current >= item.target ? "hit" : "in progress",
      })),
      topSearchedBeers: topEventGroup(["beer_search_performed"], "beer_id"),
      topSearchedSuburbs: topEventGroup(["search_performed", "suburb_search_performed", "beer_search_performed"], "suburb"),
      topClickedVenues: topVenueEventGroup(["map_pin_click", "venue_card_viewed", "venue_detail_opened", "venue_lookup"]),
      topVenuesNeedingData,
      highDemandVenuesWithStaleOrMissingData: highDemandMissing,
    };
  }

  getRetentionCohorts(input: { groupBy: "week" | "month"; limit: number }) {
    const bucketExpression = input.groupBy === "week" ? "strftime('%Y-W%W', created_at)" : "strftime('%Y-%m', created_at)";
    const cohorts = this.database
      .prepare(
        `SELECT ${bucketExpression} AS cohort, count(*) AS users
         FROM accounts
         GROUP BY cohort
         ORDER BY cohort DESC
         LIMIT ?`,
      )
      .all(input.limit) as Array<{ cohort: string; users: number }>;

    return cohorts.map((cohort) => {
      const returned = (days: number) => {
        const row = this.database
          .prepare(
            `SELECT count(DISTINCT a.id) AS count
             FROM accounts a
             JOIN events e ON e.user_id = a.id
             WHERE ${input.groupBy === "week" ? "strftime('%Y-W%W', a.created_at)" : "strftime('%Y-%m', a.created_at)"} = ?
               AND julianday(e.created_at) > julianday(a.created_at)
               AND julianday(e.created_at) <= julianday(a.created_at) + ?
               AND e.event_type IN (
                 'search_performed', 'beer_search_performed', 'venue_detail_opened',
                 'free_preview_viewed', 'price_view_revealed', 'submission_completed', 'mission_opened', 'map_filter_used'
               )`,
          )
          .get(cohort.cohort, days) as { count: number } | undefined;
        return Number(row?.count ?? 0);
      };
      const returned7 = returned(7);
      const returned30 = returned(30);

      return {
        cohort: cohort.cohort,
        users: cohort.users,
        returned7,
        returned30,
        retention7: cohort.users > 0 ? returned7 / cohort.users : 0,
        retention30: cohort.users > 0 ? returned30 / cohort.users : 0,
      };
    });
  }

  getCoverageDashboard(input: { staleBefore: string; totalVenues: number }) {
    const count = (sql: string, values: unknown[] = []) => {
      const row = this.database.prepare(sql).get(...values) as { count: number } | undefined;
      return Number(row?.count ?? 0);
    };
    const rows = this.database
      .prepare(
        `SELECT COALESCE(suburb, 'Melbourne') AS suburb,
                count(DISTINCT venue_id) AS venues_with_prices,
                count(*) AS price_records
         FROM venue_price_records
         GROUP BY COALESCE(suburb, 'Melbourne')
         ORDER BY venues_with_prices DESC
         LIMIT 20`,
      )
      .all() as Array<{ suburb: string; venues_with_prices: number; price_records: number }>;
    const avgAgeRow = this.database
      .prepare("SELECT avg(julianday('now') - julianday(last_verified_at)) AS value FROM venue_price_records")
      .get() as { value: number | null } | undefined;
    const venuesWithVerified = count(
      "SELECT count(DISTINCT venue_id) AS count FROM venue_price_records WHERE confidence IN ('admin_verified', 'venue_confirmed', 'photo_verified', 'community_confirmed')",
    );

    return {
      totalVenues: input.totalVenues,
      venuesWithAtLeastOneVerifiedPrice: venuesWithVerified,
      venuesWithThreePlusVerifiedPrices: count(
        `SELECT count(*) AS count
         FROM (
           SELECT venue_id
           FROM venue_price_records
           WHERE confidence IN ('admin_verified', 'venue_confirmed', 'photo_verified', 'community_confirmed')
           GROUP BY venue_id
           HAVING count(*) >= 3
         )`,
      ),
      venuesWithHappyHourData: count("SELECT count(DISTINCT venue_id) AS count FROM venue_price_records WHERE is_happy_hour_price = 1 OR happy_hour_details IS NOT NULL"),
      venuesWithStaleData: count("SELECT count(DISTINCT venue_id) AS count FROM venue_price_records WHERE last_verified_at < ? OR confidence IN ('stale', 'disputed')", [input.staleBefore]),
      venuesWithNoData: Math.max(0, input.totalVenues - venuesWithVerified),
      averagePriceRecordAgeDays: Math.round(Number(avgAgeRow?.value ?? 0) * 10) / 10,
      disputedRecords: count("SELECT count(*) AS count FROM venue_price_records WHERE confidence = 'disputed'"),
      coverageBySuburb: rows.map((row) => ({
        suburb: row.suburb,
        venuesWithPrices: row.venues_with_prices,
        priceRecords: row.price_records,
      })),
    };
  }

  getVenueManagerInsights(input: {
    venueId: string;
    suburb: string | null;
    staleBefore: string;
    startIso?: string | undefined;
    endIso?: string | undefined;
  }) {
    const count = (sql: string, values: unknown[] = []) => {
      const row = this.database.prepare(sql).get(...values) as { count: number } | undefined;
      return Number(row?.count ?? 0);
    };
    const rangeClause = `${input.startIso ? " AND created_at >= ?" : ""}${input.endIso ? " AND created_at < ?" : ""}`;
    const rangeValues = [
      ...(input.startIso ? [input.startIso] : []),
      ...(input.endIso ? [input.endIso] : []),
    ];
    // Current price rows are snapshots rather than a history table. For a
    // historical report, exclude rows whose current snapshot did not yet exist
    // or had not yet been verified by the end of that reporting period.
    const priceRecords = this.listLatestPriceRecords(100, input.venueId)
      .filter((record) => !input.endIso || (record.createdAt < input.endIso && record.lastVerifiedAt < input.endIso));
    const verifiedRecords = priceRecords.filter((record) =>
      ["admin_verified", "venue_confirmed", "photo_verified", "community_confirmed"].includes(record.confidence),
    );
    const beerIds = new Set(priceRecords.map((record) => record.normalizedBeerId).filter(Boolean));
    const wrongPriceReports = this.database
      .prepare(`SELECT * FROM wrong_price_reports WHERE venue_id = ?${rangeClause} ORDER BY created_at DESC LIMIT 25`)
      .all(input.venueId, ...rangeValues) as WrongPriceReportRow[];
    const requests = this.database
      .prepare(
        `SELECT * FROM venue_requests
         WHERE (venue_id = ? OR lower(COALESCE(venue_name, '')) = lower(?))
           ${rangeClause}
         ORDER BY created_at DESC
         LIMIT 25`,
      )
      .all(input.venueId, priceRecords[0]?.venueName ?? input.venueId, ...rangeValues) as VenueRequestRow[];
    const submissions = this.database
      .prepare(`SELECT * FROM submissions WHERE venue_id = ?${rangeClause} ORDER BY created_at DESC LIMIT 25`)
      .all(input.venueId, ...rangeValues) as SubmissionRow[];
    const topBeersNearby = input.suburb
      ? this.database
          .prepare(
            `SELECT COALESCE(beer_id, json_extract(metadata_json, '$.query'), 'beer') AS key,
                    count(DISTINCT CASE
                      WHEN NULLIF(user_id, '') IS NOT NULL THEN 'user:' || user_id
                      WHEN NULLIF(anonymous_session_id, '') IS NOT NULL THEN 'session:' || anonymous_session_id
                      ELSE NULL
                    END) AS count
             FROM events
             WHERE event_type = 'beer_search_performed'
               AND lower(COALESCE(suburb, '')) = lower(?)
               ${rangeClause}
             GROUP BY COALESCE(beer_id, json_extract(metadata_json, '$.query'), 'beer')
             ORDER BY count DESC
             LIMIT 8`,
          )
          .all(input.suburb, ...rangeValues) as Array<{ key: string; count: number }>
      : [];
    const missingBeerSearches = topBeersNearby.filter((row) => !beerIds.has(row.key)).slice(0, 5);
    const latestVerifiedAt = priceRecords
      .map((record) => record.lastVerifiedAt)
      .sort()
      .at(-1) ?? null;
    const scoreItems = [
      { label: "At least one verified price", complete: verifiedRecords.length >= 1, points: 20 },
      { label: "At least 3 verified beers", complete: verifiedRecords.length >= 3, points: 20 },
      { label: "Happy hour listed", complete: priceRecords.some((record) => record.isHappyHourPrice || record.happyHourDetails), points: 15 },
      { label: "Verified within 30 days", complete: Boolean(latestVerifiedAt && new Date(latestVerifiedAt) >= new Date(input.staleBefore)), points: 15 },
      { label: "No unresolved disputes", complete: wrongPriceReports.filter((report) => report.status === "open").length === 0, points: 15 },
      { label: "Venue-submitted or photo source present", complete: priceRecords.some((record) => ["venue", "photo", "submission"].some((source) => record.sourceType.includes(source))), points: 10 },
      { label: "Coordinates present in venue directory", complete: false, points: 5 },
    ];
    const possiblePoints = scoreItems.reduce((sum, item) => sum + item.points, 0);
    const earnedPoints = scoreItems.reduce((sum, item) => sum + (item.complete ? item.points : 0), 0);

    return {
      venueId: input.venueId,
      priceRecords,
      wrongPriceReports: wrongPriceReports.map(toWrongPriceReport),
      requests: requests.map(toVenueRequest),
      submissions: submissions.map(toSubmission),
      aggregateInsights: {
        venueViews: count(
          `SELECT count(DISTINCT CASE
             WHEN NULLIF(user_id, '') IS NOT NULL THEN 'user:' || user_id
             WHEN NULLIF(anonymous_session_id, '') IS NOT NULL THEN 'session:' || anonymous_session_id
             ELSE NULL
           END) AS count
           FROM events
           WHERE venue_id = ? AND event_type IN ('venue_card_viewed', 'venue_detail_opened')${rangeClause}`,
          [input.venueId, ...rangeValues],
        ),
        pricePreviewViews: count(
          `SELECT count(DISTINCT CASE
             WHEN NULLIF(user_id, '') IS NOT NULL THEN 'user:' || user_id
             WHEN NULLIF(anonymous_session_id, '') IS NOT NULL THEN 'session:' || anonymous_session_id
             ELSE NULL
           END) AS count
           FROM events
           WHERE venue_id = ? AND event_type IN ('free_preview_viewed', 'price_view_revealed')${rangeClause}`,
          [input.venueId, ...rangeValues],
        ),
        happyHourClicks: count(
          `SELECT count(DISTINCT CASE
             WHEN NULLIF(user_id, '') IS NOT NULL THEN 'user:' || user_id
             WHEN NULLIF(anonymous_session_id, '') IS NOT NULL THEN 'session:' || anonymous_session_id
             ELSE NULL
           END) AS count
           FROM events
           WHERE venue_id = ? AND event_type IN ('happy_hour_active_now_used', 'happy_hour_near_me_used')${rangeClause}`,
          [input.venueId, ...rangeValues],
        ),
        markerClicks: count(
          `SELECT count(DISTINCT CASE
             WHEN NULLIF(user_id, '') IS NOT NULL THEN 'user:' || user_id
             WHEN NULLIF(anonymous_session_id, '') IS NOT NULL THEN 'session:' || anonymous_session_id
             ELSE NULL
           END) AS count
           FROM events
           WHERE venue_id = ? AND event_type = 'map_pin_click'${rangeClause}`,
          [input.venueId, ...rangeValues],
        ),
        wrongPriceReports: wrongPriceReports.length,
        verifyRequests: requests.length,
        updatesReceived: submissions.length,
        topSearchedBeersNearby: topBeersNearby,
        missingBeerSearches,
      },
      listingQuality: {
        score: Math.round((earnedPoints / possiblePoints) * 100),
        checklist: scoreItems,
        latestVerifiedAt,
      },
    };
  }

  getPotentialPartnerLeads(input: { staleBefore: string; limit: number }) {
    const queryLimit = Math.max(input.limit * 4, input.limit);
    const rows = this.database
      .prepare(
        `SELECT e.venue_id,
                COALESCE(
                  max(json_extract(e.metadata_json, '$.venueName')),
                  max(r.venue_name),
                  max(req.venue_name),
                  e.venue_id
                ) AS venue_name,
                COALESCE(max(e.suburb), max(r.suburb), 'Melbourne') AS suburb,
                count(CASE WHEN e.event_type = 'map_viewed' THEN 1 END) AS map_views,
                count(CASE WHEN e.event_type IN ('venue_card_viewed', 'venue_detail_opened') THEN 1 END) AS venue_clicks,
                count(CASE WHEN e.event_type IN ('beer_search_performed', 'happy_hour_active_now_used') THEN 1 END) AS searches_nearby,
                COALESCE(req.request_count, 0) AS requests,
                max(r.last_verified_at) AS last_verified_at,
                COALESCE(max(r.confidence), 'missing') AS confidence
         FROM events e
         LEFT JOIN venue_price_records r ON r.venue_id = e.venue_id
         LEFT JOIN (
           SELECT COALESCE(venue_id, venue_name) AS request_key, max(venue_name) AS venue_name, count(*) AS request_count
           FROM venue_requests
           GROUP BY COALESCE(venue_id, venue_name)
         ) req ON req.request_key = e.venue_id
         WHERE e.venue_id IS NOT NULL AND e.venue_id != ''
         GROUP BY e.venue_id
         ORDER BY (venue_clicks + searches_nearby + requests) DESC
         LIMIT ?`,
      )
      .all(queryLimit) as Array<{
        venue_id: string;
        venue_name: string;
        suburb: string;
        map_views: number;
        venue_clicks: number;
        searches_nearby: number;
        requests: number;
        last_verified_at: string | null;
        confidence: string;
      }>;

    const mergedRows = new Map<string, {
      venue_id: string;
      venue_name: string;
      suburb: string;
      map_views: number;
      venue_clicks: number;
      searches_nearby: number;
      requests: number;
      last_verified_at: string | null;
      confidence: string;
    }>();

    for (const row of rows) {
      const venueName = row.venue_name || row.venue_id;
      const suburb = row.suburb || "Melbourne";
      const hasHumanReadableName = normalizePartnerLeadKeyPart(venueName) !== normalizePartnerLeadKeyPart(row.venue_id);
      const key = hasHumanReadableName
        ? `${normalizePartnerLeadKeyPart(venueName)}|${normalizePartnerLeadKeyPart(suburb)}`
        : `id:${row.venue_id}`;
      const existing = mergedRows.get(key);
      if (!existing) {
        mergedRows.set(key, { ...row, venue_name: venueName, suburb });
        continue;
      }

      existing.map_views += row.map_views;
      existing.venue_clicks += row.venue_clicks;
      existing.searches_nearby += row.searches_nearby;
      existing.requests += row.requests;
      if (!existing.last_verified_at || (row.last_verified_at && row.last_verified_at > existing.last_verified_at)) {
        existing.last_verified_at = row.last_verified_at;
      }
      if (existing.confidence !== "disputed" && row.confidence === "disputed") {
        existing.confidence = "disputed";
      } else if (existing.confidence === "missing" && row.confidence !== "missing") {
        existing.confidence = row.confidence;
      }
    }

    return [...mergedRows.values()]
      .sort((a, b) => {
        const bScore = b.venue_clicks + b.searches_nearby + b.requests;
        const aScore = a.venue_clicks + a.searches_nearby + a.requests;
        return bScore - aScore;
      })
      .slice(0, input.limit)
      .map((row) => {
      const stale = !row.last_verified_at || row.last_verified_at < input.staleBefore || row.confidence === "disputed";
      const suggestedReason = row.requests > 0
        ? "users requested this"
        : row.searches_nearby > row.venue_clicks
          ? "popular happy hour or beer interest"
          : stale
            ? "missing data"
            : "high demand";

      return {
        venueId: row.venue_id,
        venueName: row.venue_name,
        suburb: row.suburb,
        mapViews: row.map_views,
        venueClicks: row.venue_clicks,
        searchesNearby: row.searches_nearby,
        requests: row.requests,
        dataFreshness: stale ? "stale_or_missing" : "fresh",
        currentConfidence: row.confidence,
        suggestedReason,
      };
    });
  }

  beginStripeEvent(input: {
    id: string;
    eventType: string;
    eventCreatedAt: string | null;
    payload: Record<string, unknown>;
    receivedAt: string;
  }):
    | { state: "claimed"; processingToken: string }
    | { state: "applied"; processingToken: null }
    | { state: "in_progress"; processingToken: null } {
    const processingToken = crypto.randomUUID();
    const inserted = this.database
      .prepare(
        `INSERT OR IGNORE INTO stripe_webhook_events (
          id, event_type, status, event_created_at, payload_json, attempts,
          last_error, received_at, applied_at, processed_at, processing_token
        ) VALUES (?, ?, 'processing', ?, ?, 1, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        input.id,
        input.eventType,
        input.eventCreatedAt,
        JSON.stringify(redactSecrets(input.payload)),
        input.receivedAt,
        input.receivedAt,
        processingToken,
      );
    if (inserted.changes > 0) {
      return { state: "claimed", processingToken };
    }

    const row = this.database
      .prepare("SELECT status, processed_at FROM stripe_webhook_events WHERE id = ?")
      .get(input.id) as { status: string; processed_at: string | null } | undefined;
    if (row?.status === "applied") {
      return { state: "applied", processingToken: null };
    }
    const staleBefore = new Date(Date.parse(input.receivedAt) - (5 * 60_000)).toISOString();
    if (row?.status === "processing" && row.processed_at && row.processed_at > staleBefore) {
      return { state: "in_progress", processingToken: null };
    }

    const claimed = this.database
      .prepare(
        `UPDATE stripe_webhook_events
         SET status = 'processing', attempts = attempts + 1, last_error = NULL,
             received_at = ?, payload_json = ?, event_created_at = COALESCE(?, event_created_at),
             processed_at = ?, processing_token = ?
         WHERE id = ?
           AND (
             status IN ('failed', 'pending')
             OR (status = 'processing' AND (processed_at IS NULL OR processed_at <= ?))
           )`,
      )
      .run(
        input.receivedAt,
        JSON.stringify(redactSecrets(input.payload)),
        input.eventCreatedAt,
        input.receivedAt,
        processingToken,
        input.id,
        staleBefore,
      );
    return claimed.changes === 1
      ? { state: "claimed", processingToken }
      : { state: "in_progress", processingToken: null };
  }

  markStripeEventApplied(input: { id: string; processingToken: string; appliedAt: string }): boolean {
    return this.database
      .prepare(
        `UPDATE stripe_webhook_events
         SET status = 'applied', applied_at = ?, processed_at = ?, last_error = NULL, processing_token = NULL
         WHERE id = ? AND status = 'processing' AND processing_token = ?`,
      )
      .run(input.appliedAt, input.appliedAt, input.id, input.processingToken).changes === 1;
  }

  markStripeEventFailed(input: { id: string; processingToken: string; failedAt: string; error: string }): boolean {
    return this.database
      .prepare(
        `UPDATE stripe_webhook_events
         SET status = 'failed', processed_at = ?, last_error = ?, processing_token = NULL
         WHERE id = ? AND status = 'processing' AND processing_token = ?`,
      )
      .run(input.failedAt, input.error.slice(0, 500), input.id, input.processingToken).changes === 1;
  }

  runInTransaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }
}
