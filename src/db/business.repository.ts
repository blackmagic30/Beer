import crypto from "node:crypto";

import type BetterSqlite3 from "better-sqlite3";

import { VIEWER_TRACKED_BEERS, findTrackedBeerByName } from "../constants/beers.js";
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
export type MissionProgressStatus = "accepted" | "submitted" | "completed" | "needs_revision" | "cancelled";
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

const EFFECTIVELY_UNBOUNDED_QUERY_LIMIT = 2_147_483_647;

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
  hasSourceLinkage?: boolean;
  hasSourceEvidence?: boolean;
  lastVerifiedAt: string;
  priceVerifiedAt?: string | null;
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
  subscriptionCurrentPeriodEnd: string | null;
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

interface VenueLocationCacheRow {
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  latitude: number | null;
  longitude: number | null;
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
  subscription_current_period_end: string | null;
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

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
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
    subscriptionCurrentPeriodEnd: row.subscription_current_period_end,
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
    const row = this.database.prepare("SELECT * FROM profiles WHERE id = ?").get(input.id) as ProfileRow | undefined;
    if (!row) throw new Error("Profile upsert did not persist a row");
    return toProfile(row);
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

  createSessionWithLimit(input: {
    tokenHash: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
    lastUsedAt?: string | null | undefined;
    lastIpHash?: string | null | undefined;
    userAgentHash?: string | null | undefined;
    providerSessionIdHash?: string | null | undefined;
    maxActiveSessions: number;
  }): { revokedSessions: number; revokedDiscountPasses: number; revokedProviderSessions: number } {
    return this.database.transaction(() => {
      this.createSession(input);
      return this.revokeExcessActiveSessions({
        userId: input.userId,
        now: input.createdAt,
        maxActiveSessions: input.maxActiveSessions,
        preserveTokenHash: input.tokenHash,
      });
    })();
  }

  revokeExcessActiveSessions(input: {
    now: string;
    maxActiveSessions: number;
    userId?: string | undefined;
    preserveTokenHash?: string | undefined;
  }): { revokedSessions: number; revokedDiscountPasses: number; revokedProviderSessions: number } {
    if (!Number.isInteger(input.maxActiveSessions) || input.maxActiveSessions < 1) {
      throw new Error("Active session limit must be a positive integer.");
    }
    return this.database.transaction(() => {
      const userClause = input.userId ? "AND user_id = ?" : "";
      const values = input.userId
        ? [input.preserveTokenHash ?? null, input.now, input.userId, input.maxActiveSessions]
        : [input.preserveTokenHash ?? null, input.now, input.maxActiveSessions];
      const excess = this.database.prepare(
        `WITH ranked_active_sessions AS (
           SELECT token_hash, user_id, provider_session_id_hash,
             row_number() OVER (
               PARTITION BY user_id
               ORDER BY CASE WHEN token_hash = ? THEN 1 ELSE 0 END DESC,
                 COALESCE(last_used_at, created_at) DESC, created_at DESC, token_hash DESC
             ) AS session_rank
           FROM auth_sessions
           WHERE revoked_at IS NULL
             AND expires_at > ?
             ${userClause}
         )
         SELECT token_hash, user_id, provider_session_id_hash
         FROM ranked_active_sessions
         WHERE session_rank > ?`,
      ).all(...values) as Array<{
        token_hash: string;
        user_id: string;
        provider_session_id_hash: string | null;
      }>;
      if (excess.length === 0) {
        return { revokedSessions: 0, revokedDiscountPasses: 0, revokedProviderSessions: 0 };
      }

      const placeholders = excess.map(() => "?").join(", ");
      const tokenHashes = excess.map((session) => session.token_hash);
      const revokedDiscountPasses = this.database.prepare(
        `UPDATE account_discount_passes
         SET status = 'revoked', revoked_at = ?
         WHERE status = 'active' AND session_token_hash IN (${placeholders})`,
      ).run(input.now, ...tokenHashes).changes;
      const revokedSessions = this.database.prepare(
        `UPDATE auth_sessions
         SET revoked_at = ?
         WHERE revoked_at IS NULL AND token_hash IN (${placeholders})`,
      ).run(input.now, ...tokenHashes).changes;

      let revokedProviderSessions = 0;
      const providerSessions = new Map<string, { userId: string; providerSessionIdHash: string }>();
      for (const session of excess) {
        if (!session.provider_session_id_hash) continue;
        providerSessions.set(`${session.user_id}:${session.provider_session_id_hash}`, {
          userId: session.user_id,
          providerSessionIdHash: session.provider_session_id_hash,
        });
      }
      for (const providerSession of providerSessions.values()) {
        const stillActive = this.database.prepare(
          `SELECT 1 FROM auth_sessions
           WHERE user_id = ? AND provider_session_id_hash = ?
             AND revoked_at IS NULL AND expires_at > ?
           LIMIT 1`,
        ).get(providerSession.userId, providerSession.providerSessionIdHash, input.now);
        if (stillActive) continue;
        this.revokeProviderSession({
          userId: providerSession.userId,
          providerSessionIdHash: providerSession.providerSessionIdHash,
          revokedAt: input.now,
          reason: "session_limit_exceeded",
        });
        revokedProviderSessions += 1;
      }

      return { revokedSessions, revokedDiscountPasses, revokedProviderSessions };
    })();
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

  private getContributionPointsForMonth(userId: string, monthKey: string): number {
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
      .all(query, pattern, input.limit < 0 ? EFFECTIVELY_UNBOUNDED_QUERY_LIMIT : input.limit) as Array<{
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

  getBarProfile(barId: string): BarProfile | null {
    const row = this.database.prepare("SELECT * FROM venue_profiles WHERE venue_id = ?").get(barId) as
      | BarProfileRow
      | undefined;
    return row ? toBarProfile(row) : null;
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

  updateBarSubscription(input: {
    barId: string;
    membershipTier: BarMembershipTier;
    stripePaidMembershipTier?: BarMembershipTier | null | undefined;
    stripeCustomerId?: string | null | undefined;
    stripeSubscriptionId?: string | null | undefined;
    subscriptionStatus?: string | null | undefined;
    subscriptionCurrentPeriodEnd: string | null;
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
             intro_trial_ever_claimed = CASE
               WHEN ? IS NOT NULL OR ? IS NOT NULL THEN 1
               ELSE intro_trial_ever_claimed
             END,
             subscription_status = ?,
             subscription_current_period_end = ?,
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
        input.stripeCustomerId ?? null,
        input.stripeSubscriptionId ?? null,
        input.subscriptionStatus ?? null,
        input.subscriptionCurrentPeriodEnd,
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

  runInTransaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }
}
