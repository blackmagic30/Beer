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
  createdAt: string;
  updatedAt: string;
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
  beerName: string | null;
  suburb: string | null;
  notes: string | null;
  status: TrustWorkflowStatus | "mission_created";
  missionId: string | null;
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
  tierManualOverride: boolean;
  acceptsPintPathCodes: boolean;
  stripeEventCreatedAt: string | null;
  posWebhookTokenVersion: number;
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
  beer_name: string | null;
  suburb: string | null;
  notes: string | null;
  status: TrustWorkflowStatus | "mission_created";
  mission_id: string | null;
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
  tier_manual_override: number;
  accepts_pint_path_codes: number;
  stripe_event_created_at: string | null;
  pos_webhook_token_version: number;
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
    beerName: row.beer_name,
    suburb: row.suburb,
    notes: row.notes,
    status: row.status,
    missionId: row.mission_id,
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
    tierManualOverride: Boolean(row.tier_manual_override),
    acceptsPintPathCodes: Boolean(row.accepts_pint_path_codes),
    stripeEventCreatedAt: row.stripe_event_created_at,
    posWebhookTokenVersion: Number(row.pos_webhook_token_version || 1),
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
      this.database
        .prepare(
          `UPDATE accounts
           SET supabase_user_id = ?,
               auth_provider = ?,
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
          input.displayName,
          input.displayNameKey ?? null,
          input.avatarUrl,
          input.emailVerifiedAt,
          input.mfaLevel,
          input.mfaVerifiedAt,
          input.now,
          input.userId,
        );
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

  createSession(input: {
    tokenHash: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
    lastUsedAt?: string | null | undefined;
    lastIpHash?: string | null | undefined;
    userAgentHash?: string | null | undefined;
  }): void {
    this.database
      .prepare(
        `INSERT INTO auth_sessions (
          token_hash, user_id, created_at, expires_at, last_used_at, last_ip_hash, user_agent_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tokenHash,
        input.userId,
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

  touchSession(input: {
    tokenHash: string;
    lastUsedAt: string;
    lastIpHash: string | null;
    userAgentHash: string | null;
  }): void {
    this.database
      .prepare(
        `UPDATE auth_sessions
         SET last_used_at = ?, last_ip_hash = ?, user_agent_hash = ?
         WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .run(input.lastUsedAt, input.lastIpHash, input.userAgentHash, input.tokenHash);
  }

  revokeSession(input: { tokenHash: string; revokedAt: string }): boolean {
    const result = this.database
      .prepare(
        `UPDATE auth_sessions
         SET revoked_at = ?
         WHERE token_hash = ? AND revoked_at IS NULL`,
      )
      .run(input.revokedAt, input.tokenHash);
    return result.changes > 0;
  }

  revokeUserSessions(input: { userId: string; revokedAt: string }): number {
    const result = this.database
      .prepare(
        `UPDATE auth_sessions
         SET revoked_at = ?
         WHERE user_id = ? AND revoked_at IS NULL`,
      )
      .run(input.revokedAt, input.userId);
    return result.changes;
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
           SET terms_accepted_at = COALESCE(terms_accepted_at, ?),
               privacy_accepted_at = COALESCE(privacy_accepted_at, ?),
               terms_version = COALESCE(terms_version, ?),
               privacy_version = COALESCE(privacy_version, ?),
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
    stripeCustomerId?: string | null;
    premiumUntil?: string | null;
    now: string;
    stripeEventCreatedAt?: string | null;
  }): BusinessAccount {
    this.database
      .prepare(
        `UPDATE accounts
         SET subscription_status = ?,
             stripe_customer_id = COALESCE(?, stripe_customer_id),
             premium_until = ?,
             stripe_event_created_at = COALESCE(?, stripe_event_created_at),
             updated_at = ?
         WHERE id = ?
           AND (? IS NULL OR stripe_event_created_at IS NULL OR stripe_event_created_at <= ?)`,
      )
      .run(
        input.subscriptionStatus,
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
             SELECT count(*)
               FROM submissions submission
              WHERE submission.user_id = a.id
                AND submission.status = 'approved'
                AND COALESCE(submission.fraud_flagged, 0) = 0
                ${input.period === "month" ? "AND strftime('%Y-%m', COALESCE(submission.reviewed_at, submission.updated_at)) = ledger.month_key" : ""}
           ) AS approved_submissions,
           COALESCE(sum(ledger.points), 0) AS points,
           min(ledger.created_at) AS first_points_at
         FROM contribution_ledger ledger
         JOIN accounts a ON a.id = ledger.user_id
         LEFT JOIN profiles p ON p.id = a.id
         WHERE a.status != 'suspended'
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
    const account = this.getAccountById(input.userId);
    if (!account) {
      return null;
    }

    return (
      this.listLeaderboard({
        period: input.period,
        limit: 10_000,
        now: input.now,
        monthKey: input.monthKey,
      }).find((entry) => entry.accountId === account.publicAccountId) ?? null
    );
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

      for (const entry of input.entries.slice(0, 3)) {
        const account = this.getAccountByPublicAccountId(entry.accountId);
        if (!account) {
          continue;
        }
        const amountCents = amountsByRank.get(entry.rank) ?? 0;
        if (amountCents <= 0) {
          continue;
        }
        const voucherId = `${campaign.monthKey}:${entry.rank}:${account.id}:voucher`;
        const awardId = `${campaign.monthKey}:${entry.rank}:${account.id}`;
        const title = `${campaign.title} ${entry.rank === 1 ? "winner" : `place ${entry.rank}`}`;
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
          null,
          JSON.stringify({
            monthKey: campaign.monthKey,
            rank: entry.rank,
            points: entry.points,
            approvedSubmissions: entry.approvedSubmissions,
          }),
          input.now,
          input.now,
        );
        insertAward.run(
          awardId,
          campaign.monthKey,
          entry.rank,
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

  markDiscountPassUsed(input: { id: string; lastUsedAt: string }): void {
    this.database
      .prepare(
        `UPDATE account_discount_passes
         SET status = 'revoked',
             last_used_at = ?,
             revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ?`,
      )
      .run(input.lastUsedAt, input.lastUsedAt, input.id);
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

  rotateBarPosWebhookToken(input: { barId: string; now: string }): BarProfile {
    this.database
      .prepare(
        `UPDATE venue_profiles
         SET pos_webhook_token_version = pos_webhook_token_version + 1, updated_at = ?
         WHERE venue_id = ?`,
      )
      .run(input.now, input.barId);
    return this.getBarProfile(input.barId)!;
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

  listDiscountRedemptionsForVenue(venueId: string, limit: number): DiscountRedemption[] {
    const rows = this.database
      .prepare("SELECT * FROM discount_redemptions WHERE venue_id = ? ORDER BY redeemed_at DESC LIMIT ?")
      .all(venueId, limit) as DiscountRedemptionRow[];
    return rows.map(toDiscountRedemption);
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
    source: string;
    recordedByUserId: string | null;
    idempotencyKey: string;
    recordedAt: string;
    metadata: Record<string, unknown>;
  }): PintPointDrinkRecord {
    const pointsAwarded = Math.max(0, Math.min(input.quantity, input.pointsAwarded ?? (input.isAlcoholic ? input.quantity : 0)));
    const create = this.database.transaction(() => {
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

  listPintPointDrinkRecordsForVenue(venueId: string, limit: number): VenuePintPointActivity[] {
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
         LIMIT ?`,
      )
      .all(venueId, Math.max(1, Math.min(limit, 50))) as VenuePintPointActivityRow[];

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

    const expire = this.database.transaction(() => {
      for (const row of rows) {
        this.database
          .prepare("UPDATE free_pint_reward_codes SET status = 'expired' WHERE id = ? AND status = 'active'")
          .run(row.id);
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
    return rows.length;
  }

  cancelFreePintRewardCode(input: { userId: string; codeId: string; now: string }): FreePintRewardCode | null {
    const code = this.getFreePintRewardCodeById(input.codeId);
    if (!code || code.userId !== input.userId || code.status !== "active") {
      return null;
    }

    const cancel = this.database.transaction(() => {
      this.database
        .prepare("UPDATE free_pint_reward_codes SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'active'")
        .run(input.now, input.codeId);
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
      this.database
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

  listSubmissionsWithItems(filters: { userId?: string | undefined; status?: SubmissionStatus | undefined; limit: number }): BusinessSubmissionWithItems[] {
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

  listSubmissions(filters: { userId?: string | undefined; status?: SubmissionStatus | undefined; limit: number }): BusinessSubmission[] {
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

    values.push(filters.limit);
    const rows = this.database
      .prepare(
        `SELECT * FROM submissions
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...values) as SubmissionRow[];
    return rows.map(toSubmission);
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

        awarded = submitter.status === "suspended" ? 0 : this.insertContributionLedger({
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
      } else {
        const isFraud = input.status === "fraud_flagged" || input.fraudFlagged;
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
          .run(isFraud ? 1 : 0, isFraud ? 20 : 4, isFraud ? 1 : 0, isFraud ? 1 : 0, input.now, submitter.id);
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
          input.fraudFlagged ? 1 : 0,
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

  private refreshCurrentMonthPoints(userId: string, monthKey: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(sum(points), 0) AS points FROM contribution_ledger WHERE user_id = ? AND month_key = ?")
      .get(userId, monthKey) as { points: number } | undefined;
    const points = Number(row?.points ?? 0);

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

  listMissionProgressForUser(userId: string, limit = 200): MissionProgress[] {
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

  setMissionActive(input: { missionId: string; active: boolean; now: string }): void {
    this.database
      .prepare("UPDATE missions SET active = ?, updated_at = ? WHERE id = ?")
      .run(input.active ? 1 : 0, input.now, input.missionId);
  }

  getSystemState<T extends Record<string, unknown>>(key: string): { value: T; updatedAt: string } | null {
    const row = this.database
      .prepare("SELECT value_json, updated_at FROM system_state WHERE key = ?")
      .get(key) as { value_json: string; updated_at: string } | undefined;
    return row ? { value: parseJsonObject(row.value_json) as T, updatedAt: row.updated_at } : null;
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

  countMissions(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM missions").get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  listMissions(filters: { activeOnly: boolean; suburb?: string | undefined; limit: number }): BusinessMission[] {
    const where: string[] = [];
    const values: unknown[] = [];

    if (filters.activeOnly) {
      where.push("active = 1");
    }

    if (filters.suburb) {
      where.push("lower(suburb) = lower(?)");
      values.push(filters.suburb);
    }

    values.push(filters.limit);
    const rows = this.database
      .prepare(
        `SELECT * FROM missions
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY (points * multiplier) DESC, updated_at DESC
         LIMIT ?`,
      )
      .all(...values) as MissionRow[];
    return rows.map(toMission);
  }

  listMissionVenueCandidates(limit: number): MissionVenueCandidate[] {
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
           SELECT venue_id FROM missions WHERE venue_id IS NOT NULL AND venue_id != '' AND id NOT LIKE 'auto:%'
         )
         SELECT
           ids.venue_id AS venue_id,
           COALESCE(
             (SELECT name FROM venue_profiles profile WHERE profile.venue_id = ids.venue_id AND profile.active = 1 LIMIT 1),
             (SELECT venue_name FROM venue_location_cache location WHERE location.venue_id = ids.venue_id LIMIT 1),
             (SELECT venue_name FROM venue_price_records record WHERE record.venue_id = ids.venue_id ORDER BY record.last_verified_at DESC LIMIT 1),
             (SELECT venue_name FROM venue_requests request WHERE request.venue_id = ids.venue_id ORDER BY request.created_at DESC LIMIT 1),
             (SELECT venue_name FROM missions mission WHERE mission.venue_id = ids.venue_id AND mission.id NOT LIKE 'auto:%' ORDER BY mission.updated_at DESC LIMIT 1),
             ids.venue_id
           ) AS venue_name,
           COALESCE(
             (SELECT suburb FROM venue_profiles profile WHERE profile.venue_id = ids.venue_id AND profile.active = 1 LIMIT 1),
             (SELECT suburb FROM venue_location_cache location WHERE location.venue_id = ids.venue_id LIMIT 1),
             (SELECT suburb FROM venue_price_records record WHERE record.venue_id = ids.venue_id ORDER BY record.last_verified_at DESC LIMIT 1),
             (SELECT suburb FROM venue_requests request WHERE request.venue_id = ids.venue_id ORDER BY request.created_at DESC LIMIT 1),
             (SELECT suburb FROM missions mission WHERE mission.venue_id = ids.venue_id AND mission.id NOT LIKE 'auto:%' ORDER BY mission.updated_at DESC LIMIT 1)
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
         ORDER BY latest_verified_at IS NOT NULL, latest_verified_at ASC, venue_name ASC
         LIMIT ?`,
      )
      .all(limit) as Array<{
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
    const rows = this.database
      .prepare(
        `SELECT
           profile.venue_id AS id,
           profile.name AS name,
           profile.address AS address,
           profile.suburb AS suburb,
           profile.venue_tags_json AS venue_tags_json,
           location.latitude AS latitude,
           location.longitude AS longitude
         FROM venue_profiles profile
         LEFT JOIN venue_location_cache location ON location.venue_id = profile.venue_id
         WHERE profile.active = 1
         ORDER BY profile.name COLLATE NOCASE ASC
         LIMIT ?`,
      )
      .all(Math.max(input.limit * 4, input.limit)) as Array<{
        id: string;
        name: string;
        address: string | null;
        suburb: string | null;
        venue_tags_json: string | null;
        latitude: number | null;
        longitude: number | null;
      }>;

    return rows
      .filter((row) => {
        if (!query) {
          return true;
        }
        return [row.name, row.suburb, row.address]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .slice(0, input.limit)
      .map((row) => {
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
          venueTags,
          isUserSubmittedVenue: venueTags.includes("user submitted"),
        };
      });
  }

  listVenueManagerPriceRecords(limit: number, venueId?: string | null): PublicVenuePriceRecord[] {
    const values = venueId ? [venueId, limit] : [limit];
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
        `SELECT
           beer.*,
           profile.name AS profile_name,
           profile.suburb AS profile_suburb,
           profile.address AS profile_address,
           profile.membership_tier AS profile_membership_tier,
           profile.highlighted_name AS profile_highlighted_name,
           profile.premium_badge AS profile_premium_badge,
           profile.promoted AS profile_promoted,
           profile.featured_special_eligible AS profile_featured_special_eligible,
           profile.accepts_pint_path_codes AS profile_accepts_pint_path_codes
         FROM venue_beers beer
         INNER JOIN venue_profiles profile ON profile.venue_id = beer.venue_id
         ${beerWhere}
         ORDER BY beer.updated_at DESC
         LIMIT ?`,
      )
      .all(...values) as Array<BarBeerRow & {
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
         ${happyWhere}
         ORDER BY happy.updated_at DESC
         LIMIT ?`,
      )
      .all(...values) as Array<BarHappyHourRow & {
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
         ${specialWhere}
         ORDER BY special.exclusive DESC, special.updated_at DESC
         LIMIT ?`,
      )
      .all(...values) as Array<BarSpecialRow & {
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
        confidence: "venue_confirmed" as const,
        sourceType: "venue_manager_portal",
        sourceSubmissionId: null,
        lastVerifiedAt: row.updated_at,
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
      .sort((left, right) => new Date(right.lastVerifiedAt).getTime() - new Date(left.lastVerifiedAt).getTime())
      .slice(0, limit);
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
      consentVersion: "2026-07-11",
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

  listFeedback(limit: number): FeedbackItem[] {
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
         LIMIT ?`,
      )
      .all(limit) as FeedbackRow[];
    return rows.map(toFeedback);
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
  }): { report: WrongPriceReport; markedDisputed: boolean } {
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
        .prepare("SELECT count(*) AS count FROM wrong_price_reports WHERE price_record_id = ? AND status = 'open'")
        .get(input.priceRecordId) as { count: number } | undefined;

      if (Number(row?.count ?? 0) >= 2) {
        this.database
          .prepare("UPDATE venue_price_records SET confidence = 'disputed', updated_at = ? WHERE id = ? AND confidence != 'venue_confirmed'")
          .run(input.now, input.priceRecordId);
        markedDisputed = true;
      }
    }

    const reportRow = this.database.prepare("SELECT * FROM wrong_price_reports WHERE id = ?").get(input.id) as WrongPriceReportRow;
    return { report: toWrongPriceReport(reportRow), markedDisputed };
  }

  listWrongPriceReports(limit: number): WrongPriceReport[] {
    const rows = this.database
      .prepare("SELECT * FROM wrong_price_reports ORDER BY created_at DESC LIMIT ?")
      .all(limit) as WrongPriceReportRow[];
    return rows.map(toWrongPriceReport);
  }

  createVenueRequest(input: {
    id: string;
    userId: string | null;
    anonymousSessionId: string | null;
    requestType: RequestType;
    venueId: string | null;
    venueName: string | null;
    beerName: string | null;
    suburb: string | null;
    notes: string | null;
    now: string;
  }): VenueRequest {
    this.database
      .prepare(
        `INSERT INTO venue_requests (
          id, user_id, anonymous_session_id, request_type, venue_id, venue_name,
          beer_name, suburb, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.anonymousSessionId,
        input.requestType,
        input.venueId,
        input.venueName,
        input.beerName,
        input.suburb,
        input.notes,
        input.now,
        input.now,
      );
    const row = this.database.prepare("SELECT * FROM venue_requests WHERE id = ?").get(input.id) as VenueRequestRow;
    return toVenueRequest(row);
  }

  markVenueRequestMission(input: { requestId: string; missionId: string; now: string }): VenueRequest {
    this.database
      .prepare("UPDATE venue_requests SET status = 'mission_created', mission_id = ?, updated_at = ? WHERE id = ?")
      .run(input.missionId, input.now, input.requestId);
    const row = this.database.prepare("SELECT * FROM venue_requests WHERE id = ?").get(input.requestId) as VenueRequestRow;
    return toVenueRequest(row);
  }

  listVenueRequests(limit: number): VenueRequest[] {
    const rows = this.database
      .prepare("SELECT * FROM venue_requests ORDER BY created_at DESC LIMIT ?")
      .all(limit) as VenueRequestRow[];
    return rows.map(toVenueRequest);
  }

  updateTrustWorkflow(input: {
    kind: "feedback" | "wrong_price" | "venue_request" | "venue_interest";
    id: string;
    status: TrustWorkflowStatus;
    assignedTo: string | null;
    resolutionNote: string | null;
    resolvedBy: string;
    now: string;
  }): FeedbackItem | WrongPriceReport | VenueRequest | VenueInterestRequest {
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
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.assignedTo,
        input.resolutionNote,
        resolved ? input.now : null,
        resolved ? input.resolvedBy : null,
        input.now,
        input.id,
      );
    if (result.changes !== 1) {
      throw new Error("Trust queue item not found");
    }

    const row = this.database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(input.id);
    if (input.kind === "feedback") return toFeedback(row as FeedbackRow);
    if (input.kind === "wrong_price") return toWrongPriceReport(row as WrongPriceReportRow);
    if (input.kind === "venue_request") return toVenueRequest(row as VenueRequestRow);
    return toVenueInterestRequest(row as VenueInterestRequestRow);
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

  listVenueInterestRequests(limit: number): VenueInterestRequest[] {
    const rows = this.database
      .prepare("SELECT * FROM venue_interest_requests ORDER BY created_at DESC LIMIT ?")
      .all(limit) as VenueInterestRequestRow[];
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

  listBarClaimRequests(input: { userId?: string | undefined; status?: string | undefined; limit: number }): BarClaimRequest[] {
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
      .prepare(`SELECT * FROM venue_claim_requests ${whereSql} ORDER BY created_at DESC LIMIT ?`)
      .all(...values, input.limit) as BarClaimRequestRow[];
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
      if (input.decision === "accept") {
        this.database
          .prepare("UPDATE accounts SET role = 'venue_manager', updated_at = ? WHERE id = ? AND role = 'user'")
          .run(input.now, input.userId);
      }
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
        .prepare("SELECT 1 FROM venue_manager_assignments WHERE user_id = ? AND status = 'active' LIMIT 1")
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

  listVenueManagerAssignments(input: { userId?: string | undefined; venueId?: string | undefined; activeOnly?: boolean | undefined; limit: number }): VenueManagerAssignment[] {
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
      .prepare(`SELECT * FROM venue_manager_assignments ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...values, input.limit) as VenueManagerAssignmentRow[];
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
    now: string;
  }): BarProfile {
    this.database
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
          updated_at = excluded.updated_at`,
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
      );
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
    now: string;
  }): BarBeer {
    this.database
      .prepare(
        `INSERT INTO venue_beers (
          id, venue_id, beer_name, normalized_beer_id, brewery, style, abv, serve_size, price, currency, on_tap, in_stock, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          updated_at = excluded.updated_at
        WHERE venue_beers.venue_id = excluded.venue_id`,
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
        input.now,
        input.now,
      );
    const row = this.database
      .prepare("SELECT * FROM venue_beers WHERE id = ? AND venue_id = ?")
      .get(input.id, input.barId) as BarBeerRow | undefined;
    if (!row) {
      throw new Error("Beer row belongs to another venue");
    }
    return toBarBeer(row);
  }

  deleteBarBeer(input: { id: string; barId: string }): boolean {
    const result = this.database.prepare("DELETE FROM venue_beers WHERE id = ? AND venue_id = ?").run(input.id, input.barId);
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
    now: string;
  }): BarHappyHour {
    this.database
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
        WHERE venue_happy_hours.venue_id = excluded.venue_id`,
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
      );
    const row = this.database
      .prepare("SELECT * FROM venue_happy_hours WHERE id = ? AND venue_id = ?")
      .get(input.id, input.barId) as BarHappyHourRow | undefined;
    if (!row) {
      throw new Error("Happy-hour row belongs to another venue");
    }
    return toBarHappyHour(row);
  }

  deleteBarHappyHour(input: { id: string; barId: string }): boolean {
    const result = this.database.prepare("DELETE FROM venue_happy_hours WHERE id = ? AND venue_id = ?").run(input.id, input.barId);
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
    scheduleNote: string | null;
    exclusive: boolean;
    active: boolean;
    now: string;
  }): BarSpecial {
    this.database
      .prepare(
        `INSERT INTO venue_specials (
          id, venue_id, title, description, price, discount, savings_amount_cents, starts_at, ends_at, start_time, end_time, schedule_note, exclusive, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          schedule_note = excluded.schedule_note,
          exclusive = excluded.exclusive,
          active = excluded.active,
          updated_at = excluded.updated_at
        WHERE venue_specials.venue_id = excluded.venue_id`,
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
        input.scheduleNote,
        input.exclusive ? 1 : 0,
        input.active ? 1 : 0,
        input.now,
        input.now,
      );
    const row = this.database
      .prepare("SELECT * FROM venue_specials WHERE id = ? AND venue_id = ?")
      .get(input.id, input.barId) as BarSpecialRow | undefined;
    if (!row) {
      throw new Error("Special row belongs to another venue");
    }
    return toBarSpecial(row);
  }

  deleteBarSpecial(input: { id: string; barId: string }): boolean {
    const result = this.database.prepare("DELETE FROM venue_specials WHERE id = ? AND venue_id = ?").run(input.id, input.barId);
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

  listBarPendingChanges(input: {
    barId?: string | undefined;
    submittedBy?: string | undefined;
    status?: BarPendingChangeStatus | undefined;
    limit: number;
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
         LIMIT ?`,
      )
      .all(...values, input.limit) as BarPendingChangeRow[];
    return rows.map(toBarPendingChange);
  }

  reviewBarPendingChange(input: {
    id: string;
    status: Exclude<BarPendingChangeStatus, "pending">;
    reviewedBy: string;
    reviewedAt: string;
    rejectionReason: string | null;
  }): BarPendingChange | null {
    this.database
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
      priceReveals: barEventCount(["price_view_revealed"]),
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
      priceReveals: reportableVenueMetric("priceReveals"),
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

  listVenuePartnerOutreach(limit: number): VenuePartnerOutreach[] {
    const rows = this.database
      .prepare("SELECT * FROM venue_partner_outreach ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as VenuePartnerOutreachRow[];
    return rows.map(toVenuePartnerOutreach);
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

  listSecurityAuditLogs(limit = 100): SecurityAuditLog[] {
    const rows = this.database
      .prepare("SELECT * FROM security_audit_log ORDER BY created_at DESC LIMIT ?")
      .all(limit) as SecurityAuditLogRow[];
    return rows.map(toSecurityAuditLog);
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

  listExpiredSourceEvidence(input: { now: string; limit: number }): SourceEvidenceObject[] {
    const rows = this.database
      .prepare(
        `SELECT evidence.*
         FROM source_evidence_objects evidence
         WHERE evidence.deleted_at IS NULL
           AND evidence.retention_expires_at IS NOT NULL
           AND evidence.retention_expires_at <= ?
           AND NOT EXISTS (
             SELECT 1
             FROM submission_source_evidence link
             JOIN submissions submission ON submission.id = link.submission_id
             WHERE link.evidence_id = evidence.id
               AND submission.status IN ('pending', 'needs_more_evidence')
           )
         ORDER BY evidence.retention_expires_at ASC
         LIMIT ?`,
      )
      .all(input.now, input.limit) as SourceEvidenceObjectRow[];
    return rows.map(toSourceEvidenceObject);
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
         WHERE user_id = ? AND status IN ('pending_review', 'approved')
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

  listAccountDeletionRequests(input: { status?: string; limit: number }): Array<Record<string, unknown>> {
    const rows = input.status
      ? this.database.prepare("SELECT * FROM account_deletion_requests WHERE status = ? ORDER BY requested_at DESC LIMIT ?").all(input.status, input.limit)
      : this.database.prepare("SELECT * FROM account_deletion_requests ORDER BY requested_at DESC LIMIT ?").all(input.limit);
    return rows as Array<Record<string, unknown>>;
  }

  executeAccountAnonymisation(input: { requestId: string; reviewedBy: string; now: string }): Record<string, unknown> {
    return this.database.transaction(() => {
      const request = this.database
        .prepare("SELECT * FROM account_deletion_requests WHERE id = ?")
        .get(input.requestId) as { user_id: string; status: string; execute_after: string } | undefined;
      if (!request) throw new Error("Deletion request not found");
      if (!['pending_review', 'approved'].includes(request.status)) throw new Error("Deletion request is already closed");

      const userId = request.user_id;
      const evidenceRows = this.database
        .prepare("SELECT * FROM source_evidence_objects WHERE owner_user_id = ? AND deleted_at IS NULL")
        .all(userId) as SourceEvidenceObjectRow[];

      this.database.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM account_discount_passes WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM account_preferences WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM account_privacy_settings WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM saved_items WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM user_activity_events WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM events WHERE user_id = ?").run(userId);
      this.database.prepare("UPDATE feedback SET user_id = NULL WHERE user_id = ?").run(userId);
      this.database.prepare("UPDATE wrong_price_reports SET user_id = NULL WHERE user_id = ?").run(userId);
      this.database.prepare("UPDATE venue_requests SET user_id = NULL WHERE user_id = ?").run(userId);
      this.database.prepare("UPDATE submissions SET client_submission_id = NULL, notes = NULL, source_photo_url = NULL, upload_latitude = NULL, upload_longitude = NULL, upload_accuracy_meters = NULL, upload_location_captured_at = NULL WHERE user_id = ?").run(userId);
      this.database.prepare("DELETE FROM submission_source_evidence WHERE submission_id IN (SELECT id FROM submissions WHERE user_id = ?)").run(userId);
      this.database.prepare("UPDATE source_evidence_objects SET owner_user_id = NULL WHERE owner_user_id = ?").run(userId);
      this.database.prepare("UPDATE profiles SET email = ?, username = NULL, avatar_url = NULL, display_name = NULL, display_name_key = NULL, updated_at = ? WHERE id = ?").run(`deleted-${userId}@invalid.pintpath.local`, input.now, userId);
      this.database.prepare(
        `UPDATE accounts
         SET email = ?, password_hash = 'deleted', display_name = NULL, display_name_key = NULL,
             avatar_url = NULL, supabase_user_id = NULL, role = 'user', subscription_status = 'free',
             stripe_customer_id = NULL, status = 'suspended', updated_at = ?
         WHERE id = ?`,
      ).run(`deleted-${userId}@invalid.pintpath.local`, input.now, userId);

      const summary = { anonymisedUserId: userId, evidenceIds: evidenceRows.map((row) => row.id) };
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
           'price_view_revealed', 'submission_completed', 'mission_opened', 'map_filter_used'
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
          WHERE e.event_type IN ('venue_card_viewed', 'venue_detail_opened', 'price_view_revealed')
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
      totalExactPriceReveals: eventCount(["price_view_revealed"]),
      totalBlockedPriceReveals: eventCount(["price_view_blocked_free_limit"]),
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
                 'price_view_revealed', 'submission_completed', 'mission_opened', 'map_filter_used'
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
        priceReveals: count(
          `SELECT count(DISTINCT CASE
             WHEN NULLIF(user_id, '') IS NOT NULL THEN 'user:' || user_id
             WHEN NULLIF(anonymous_session_id, '') IS NOT NULL THEN 'session:' || anonymous_session_id
             ELSE NULL
           END) AS count
           FROM events
           WHERE venue_id = ? AND event_type = 'price_view_revealed'${rangeClause}`,
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
  }): boolean {
    const inserted = this.database
      .prepare(
        `INSERT OR IGNORE INTO stripe_webhook_events (
          id, event_type, status, event_created_at, payload_json, attempts,
          last_error, received_at, applied_at, processed_at
        ) VALUES (?, ?, 'pending', ?, ?, 1, NULL, ?, NULL, ?)`,
      )
      .run(
        input.id,
        input.eventType,
        input.eventCreatedAt,
        JSON.stringify(redactSecrets(input.payload)),
        input.receivedAt,
        input.receivedAt,
      );
    if (inserted.changes > 0) {
      return true;
    }

    const row = this.database
      .prepare("SELECT status FROM stripe_webhook_events WHERE id = ?")
      .get(input.id) as { status: string } | undefined;
    if (row?.status === "applied") {
      return false;
    }

    this.database
      .prepare(
        `UPDATE stripe_webhook_events
         SET status = 'pending', attempts = attempts + 1, last_error = NULL,
             received_at = ?, payload_json = ?, event_created_at = COALESCE(?, event_created_at)
         WHERE id = ?`,
      )
      .run(input.receivedAt, JSON.stringify(redactSecrets(input.payload)), input.eventCreatedAt, input.id);
    return true;
  }

  markStripeEventApplied(input: { id: string; appliedAt: string }): void {
    this.database
      .prepare(
        `UPDATE stripe_webhook_events
         SET status = 'applied', applied_at = ?, processed_at = ?, last_error = NULL
         WHERE id = ?`,
      )
      .run(input.appliedAt, input.appliedAt, input.id);
  }

  markStripeEventFailed(input: { id: string; failedAt: string; error: string }): void {
    this.database
      .prepare(
        `UPDATE stripe_webhook_events
         SET status = 'failed', processed_at = ?, last_error = ?
         WHERE id = ?`,
      )
      .run(input.failedAt, input.error.slice(0, 500), input.id);
  }

  runInTransaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }
}
