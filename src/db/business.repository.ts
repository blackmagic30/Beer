import type BetterSqlite3 from "better-sqlite3";

import { redactSecrets } from "../lib/redact.js";

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
export type ServingSize = "pint" | "pot" | "schooner" | "jug" | "bottle" | "can" | "other";
export type TapStatus = "yes" | "no" | "unknown";
export type SavedItemType = "venue" | "beer" | "suburb";
export type FeedbackType =
  | "bug"
  | "wrong_data"
  | "feature_idea"
  | "venue_suggestion"
  | "general_feedback"
  | "privacy_request"
  | "data_export_request"
  | "account_deletion_request"
  | "moderation_appeal"
  | "security_report"
  | "abuse_report"
  | "billing_support";
export type FeedbackPriority = "low" | "normal" | "medium" | "high";
export type RequestType = "missing_venue" | "missing_beer" | "verify_venue" | "verify_beer_at_venue";
export type BarMembershipTier = "basic" | "plus" | "pro";
type StoredBarMembershipTier = BarMembershipTier | "free" | "super_premium";
export type AgeVerificationStatus = "not_started" | "pending" | "verified" | "rejected" | "expired";
export type ConfidenceLabel =
  | "venue_confirmed"
  | "photo_verified"
  | "community_confirmed"
  | "user_reported_pending"
  | "stale"
  | "disputed";

export interface BusinessAccount {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string | null;
  avatarUrl: string | null;
  authProvider: string;
  supabaseUserId: string | null;
  emailVerifiedAt: string | null;
  mfaLevel: string;
  mfaVerifiedAt: string | null;
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
  email: string | null;
  displayName: string | null;
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
  createdAt: string;
}

export interface BusinessSubmission {
  id: string;
  userId: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  status: SubmissionStatus;
  submissionType: SubmissionType;
  observedAt: string;
  sourcePhotoUrl: string | null;
  notes: string | null;
  pointsAwarded: number;
  uploadLatitude: number | null;
  uploadLongitude: number | null;
  uploadAccuracyMeters: number | null;
  uploadLocationCapturedAt: string | null;
  distanceToVenueMeters: number | null;
  pointsEligibleByLocation: boolean;
  pointsEligibilityReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  fraudFlagged: boolean;
  createdAt: string;
  updatedAt: string;
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
  createdAt: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface VenueLocationCache {
  venueId: string;
  venueName: string;
  suburb: string | null;
  latitude: number | null;
  longitude: number | null;
  updatedAt: string;
}

export interface PublicVenuePriceRecord {
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  venueAddress?: string | null;
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
  displayKind?: "beer" | "happy_hour" | "special";
  specialTitle?: string | null;
  specialDescription?: string | null;
  specialDiscount?: string | null;
  specialStartsAt?: string | null;
  specialEndsAt?: string | null;
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
  status: string;
  priority: FeedbackPriority;
  triageReason: string | null;
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
  status: string;
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
  status: string;
  missionId: string | null;
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
  createdAt: string;
  updatedAt: string;
}

export interface VenueManagerAssignment {
  id: string;
  userId: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  status: string;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VenuePartnerOutreach {
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  status: string;
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
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BarBeer {
  id: string;
  barId: string;
  beerName: string;
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
  startsAt: string | null;
  endsAt: string | null;
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

interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  avatar_url: string | null;
  auth_provider: string;
  supabase_user_id: string | null;
  email_verified_at: string | null;
  mfa_level: string;
  mfa_verified_at: string | null;
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
  email: string | null;
  display_name: string | null;
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

interface SubmissionRow {
  id: string;
  user_id: string;
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  status: SubmissionStatus;
  submission_type: SubmissionType;
  observed_at: string;
  source_photo_url: string | null;
  notes: string | null;
  points_awarded: number;
  upload_latitude: number | null;
  upload_longitude: number | null;
  upload_accuracy_meters: number | null;
  upload_location_captured_at: string | null;
  distance_to_venue_meters: number | null;
  points_eligible_by_location: number;
  points_eligibility_reason: string | null;
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
  status: string;
  priority: FeedbackPriority;
  triage_reason: string | null;
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
  status: string;
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
  status: string;
  mission_id: string | null;
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
  created_at: string;
  updated_at: string;
}

interface VenueManagerAssignmentRow {
  id: string;
  user_id: string;
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  status: string;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

interface VenuePartnerOutreachRow {
  id: string;
  venue_id: string;
  venue_name: string;
  suburb: string | null;
  status: string;
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
  created_at: string;
  updated_at: string;
}

interface BarBeerRow {
  id: string;
  venue_id: string;
  beer_name: string;
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
  starts_at: string | null;
  ends_at: string | null;
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

function toAccount(row: AccountRow): BusinessAccount {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    authProvider: row.auth_provider,
    supabaseUserId: row.supabase_user_id,
    emailVerifiedAt: row.email_verified_at,
    mfaLevel: row.mfa_level,
    mfaVerifiedAt: row.mfa_verified_at,
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
    createdAt: row.created_at,
  };
}

function toProfile(row: ProfileRow): PublicProfile {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
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

function toSubmission(row: SubmissionRow): BusinessSubmission {
  return {
    id: row.id,
    userId: row.user_id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    suburb: row.suburb,
    status: row.status,
    submissionType: row.submission_type,
    observedAt: row.observed_at,
    sourcePhotoUrl: row.source_photo_url,
    notes: row.notes,
    pointsAwarded: row.points_awarded,
    uploadLatitude: row.upload_latitude,
    uploadLongitude: row.upload_longitude,
    uploadAccuracyMeters: row.upload_accuracy_meters,
    uploadLocationCapturedAt: row.upload_location_captured_at,
    distanceToVenueMeters: row.distance_to_venue_meters,
    pointsEligibleByLocation: Boolean(row.points_eligible_by_location),
    pointsEligibilityReason: row.points_eligibility_reason,
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

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeBarMembershipTier(value: StoredBarMembershipTier | string | null | undefined): BarMembershipTier {
  if (value === "plus") {
    return "plus";
  }

  if (value === "pro" || value === "super_premium") {
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
    status: row.status,
    priority: row.priority,
    triageReason: row.triage_reason,
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
    status: row.status,
    approvedBy: row.approved_by,
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
    startsAt: row.starts_at,
    endsAt: row.ends_at,
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

  createAccount(input: {
    id: string;
    email: string;
    passwordHash: string;
    role: AccountRole;
    subscriptionStatus: SubscriptionStatus;
    now: string;
    displayName?: string | null | undefined;
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
    const create = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO accounts (
            id, email, password_hash, display_name, avatar_url, auth_provider, supabase_user_id,
            email_verified_at, mfa_level, mfa_verified_at, role, subscription_status,
            terms_accepted_at, privacy_accepted_at, terms_version, privacy_version,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.email,
          input.passwordHash,
          input.displayName ?? null,
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
        email: input.email,
        displayName: input.displayName ?? null,
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
    email: string | null;
    displayName: string | null;
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
          id, email, display_name, username, avatar_url, role, account_status,
          age_verification_status, is_over_18_verified, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          display_name = excluded.display_name,
          avatar_url = excluded.avatar_url,
          role = excluded.role,
          account_status = excluded.account_status,
          age_verification_status = excluded.age_verification_status,
          is_over_18_verified = excluded.is_over_18_verified,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.email,
        input.displayName,
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

  linkSupabaseAccount(input: {
    userId: string;
    supabaseUserId: string;
    authProvider: string;
    displayName: string | null;
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
          email: account.email,
          displayName: input.displayName,
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
  }): BusinessAccount {
    this.database
      .prepare(
        `UPDATE accounts
         SET subscription_status = ?,
             stripe_customer_id = COALESCE(?, stripe_customer_id),
             premium_until = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(input.subscriptionStatus, input.stripeCustomerId ?? null, input.premiumUntil ?? null, input.now, input.userId);
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
    userId: string;
    venueId: string;
    venueName: string;
    suburb: string | null;
    submissionType: SubmissionType;
    observedAt: string;
    sourcePhotoUrl: string | null;
    notes: string | null;
    uploadLatitude?: number | null;
    uploadLongitude?: number | null;
    uploadAccuracyMeters?: number | null;
    uploadLocationCapturedAt?: string | null;
    distanceToVenueMeters?: number | null;
    pointsEligibleByLocation?: boolean;
    pointsEligibilityReason?: string | null;
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
    }>;
    now: string;
  }): BusinessSubmission {
    const create = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO submissions (
            id, user_id, venue_id, venue_name, suburb, status, submission_type, observed_at,
            source_photo_url, notes, upload_latitude, upload_longitude, upload_accuracy_meters,
            upload_location_captured_at, distance_to_venue_meters, points_eligible_by_location,
            points_eligibility_reason, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.userId,
          input.venueId,
          input.venueName,
          input.suburb,
          input.submissionType,
          input.observedAt,
          input.sourcePhotoUrl,
          input.notes,
          input.uploadLatitude ?? null,
          input.uploadLongitude ?? null,
          input.uploadAccuracyMeters ?? null,
          input.uploadLocationCapturedAt ?? null,
          input.distanceToVenueMeters ?? null,
          input.pointsEligibleByLocation ? 1 : 0,
          input.pointsEligibilityReason ?? null,
          input.now,
          input.now,
        );

      const insertItem = this.database.prepare(
        `INSERT INTO submission_items (
          id, submission_id, beer_name, normalized_beer_id, serving_size, price,
          is_happy_hour_price, happy_hour_details, is_on_tap, confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.now,
        );
      }
    });

    create();
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
  }): { submission: BusinessSubmission; pointsAwarded: number; account: BusinessAccount } {
    const review = this.database.transaction(() => {
      const current = this.getSubmissionById(input.submissionId);
      if (!current) {
        throw new Error("Submission not found");
      }

      if (current.submission.userId === input.reviewerId) {
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
        awarded = submitter.status === "suspended" ? 0 : this.insertContributionLedger({
          userId: submitter.id,
          submissionId: current.submission.id,
          venueId: current.submission.venueId,
          points: input.pointsAwarded,
          reason: current.submission.submissionType,
          monthKey: input.monthKey,
          now: input.now,
        });

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

    return review();
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
    }
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

  listLatestPriceRecords(limit: number, venueId?: string | null): PublicVenuePriceRecord[] {
    const where = venueId ? "WHERE venue_id = ?" : "";
    const values = venueId ? [venueId, limit] : [limit];
    const rows = this.database
      .prepare(`SELECT * FROM venue_price_records ${where} ORDER BY last_verified_at DESC LIMIT ?`)
      .all(...values) as PriceRecordRow[];
    return rows.map(toPriceRecord);
  }

  getLatestVenueDataTimestamp(venueId: string): string | null {
    const row = this.database
      .prepare("SELECT max(last_verified_at) AS last_verified_at FROM venue_price_records WHERE venue_id = ?")
      .get(venueId) as { last_verified_at: string | null } | undefined;
    return row?.last_verified_at ?? null;
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

  listVenueManagerPriceRecords(limit: number, venueId?: string | null): PublicVenuePriceRecord[] {
    const values = venueId ? [venueId, limit] : [limit];
    const beerWhere = venueId ? "WHERE beer.venue_id = ? AND profile.active = 1" : "WHERE profile.active = 1";
    const happyWhere = venueId
      ? "WHERE happy.venue_id = ? AND happy.active = 1 AND profile.active = 1"
      : "WHERE happy.active = 1 AND profile.active = 1";
    const specialWhere = venueId
      ? "WHERE special.venue_id = ? AND special.active = 1 AND profile.active = 1"
      : "WHERE special.active = 1 AND profile.active = 1";
    const beerRows = this.database
      .prepare(
        `SELECT
           beer.*,
           profile.name AS profile_name,
           profile.suburb AS profile_suburb,
           profile.address AS profile_address
         FROM venue_beers beer
         INNER JOIN venue_profiles profile ON profile.venue_id = beer.venue_id
         ${beerWhere}
         ORDER BY beer.updated_at DESC
         LIMIT ?`,
      )
      .all(...values) as Array<BarBeerRow & { profile_name: string | null; profile_suburb: string | null; profile_address: string | null }>;
    const happyRows = this.database
      .prepare(
        `SELECT
           happy.*,
           profile.name AS profile_name,
           profile.suburb AS profile_suburb,
           profile.address AS profile_address
         FROM venue_happy_hours happy
         INNER JOIN venue_profiles profile ON profile.venue_id = happy.venue_id
         ${happyWhere}
         ORDER BY happy.updated_at DESC
         LIMIT ?`,
      )
      .all(...values) as Array<BarHappyHourRow & { profile_name: string | null; profile_suburb: string | null; profile_address: string | null }>;
    const specialRows = this.database
      .prepare(
        `SELECT
           special.*,
           profile.name AS profile_name,
           profile.suburb AS profile_suburb,
           profile.address AS profile_address
         FROM venue_specials special
         INNER JOIN venue_profiles profile ON profile.venue_id = special.venue_id
         ${specialWhere}
         ORDER BY special.exclusive DESC, special.updated_at DESC
         LIMIT ?`,
      )
      .all(...values) as Array<BarSpecialRow & { profile_name: string | null; profile_suburb: string | null; profile_address: string | null }>;

    return [
      ...beerRows.map((row) => ({
        id: `bar_beer:${row.id}`,
        venueId: row.venue_id,
        venueName: row.profile_name || row.venue_id,
        venueAddress: row.profile_address,
        suburb: row.profile_suburb,
        beerName: row.beer_name,
        normalizedBeerId: null,
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
      optionalAnalyticsEnabled: true,
      venueReportInclusionEnabled: true,
      productResearchEnabled: true,
      emailUpdatesEnabled: false,
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
    now: string;
  }): AccountPrivacySettings {
    const existing = this.getAccountPrivacySettings(input.userId);
    this.database
      .prepare(
        `INSERT INTO account_privacy_settings (
          user_id, optional_analytics_enabled, venue_report_inclusion_enabled,
          product_research_enabled, email_updates_enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          optional_analytics_enabled = excluded.optional_analytics_enabled,
          venue_report_inclusion_enabled = excluded.venue_report_inclusion_enabled,
          product_research_enabled = excluded.product_research_enabled,
          email_updates_enabled = excluded.email_updates_enabled,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.userId,
        input.optionalAnalyticsEnabled ? 1 : 0,
        input.venueReportInclusionEnabled ? 1 : 0,
        input.productResearchEnabled ? 1 : 0,
        input.emailUpdatesEnabled ? 1 : 0,
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
    priority: FeedbackPriority;
    triageReason: string | null;
    now: string;
  }): FeedbackItem {
    this.database
      .prepare(
        `INSERT INTO feedback (
          id, user_id, anonymous_session_id, feedback_type, message, venue_id, venue_name,
          priority, triage_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.anonymousSessionId,
        input.feedbackType,
        input.message,
        input.venueId,
        input.venueName,
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
    approvedBy: string;
    now: string;
  }): VenueManagerAssignment {
    this.database
      .prepare(
        `INSERT INTO venue_manager_assignments (
          id, user_id, venue_id, venue_name, suburb, status, approved_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(user_id, venue_id) DO UPDATE SET
          venue_name = excluded.venue_name,
          suburb = excluded.suburb,
          status = 'active',
          approved_by = excluded.approved_by,
          updated_at = excluded.updated_at`,
      )
      .run(input.id, input.userId, input.venueId, input.venueName, input.suburb, input.approvedBy, input.now, input.now);

    this.database
      .prepare("UPDATE accounts SET role = 'venue_manager', updated_at = ? WHERE id = ? AND role = 'user'")
      .run(input.now, input.userId);

    const row = this.database
      .prepare("SELECT * FROM venue_manager_assignments WHERE user_id = ? AND venue_id = ?")
      .get(input.userId, input.venueId) as VenueManagerAssignmentRow;
    return toVenueManagerAssignment(row);
  }

  revokeVenueManager(input: { userId: string; venueId: string; now: string }): VenueManagerAssignment | null {
    this.database
      .prepare("UPDATE venue_manager_assignments SET status = 'revoked', updated_at = ? WHERE user_id = ? AND venue_id = ?")
      .run(input.now, input.userId, input.venueId);
    const row = this.database
      .prepare("SELECT * FROM venue_manager_assignments WHERE user_id = ? AND venue_id = ?")
      .get(input.userId, input.venueId) as VenueManagerAssignmentRow | undefined;
    return row ? toVenueManagerAssignment(row) : null;
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
    active: boolean;
    now: string;
  }): BarProfile {
    this.database
      .prepare(
        `INSERT INTO venue_profiles (
          venue_id, name, address, suburb, area, phone, website, instagram, description,
          opening_hours_json, venue_tags_json, membership_tier, highlighted_name, premium_badge,
          promoted, featured_special_eligible, stripe_customer_id, stripe_subscription_id,
          subscription_status, tier_manual_override, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
             updated_at = ?
         WHERE venue_id = ? AND tier_manual_override = 0`,
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
        input.now,
        input.barId,
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
          id, venue_id, beer_name, brewery, style, abv, serve_size, price, currency, on_tap, in_stock, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          beer_name = excluded.beer_name,
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
      throw new Error("Beer row belongs to another bar");
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
    active: boolean;
    now: string;
  }): BarHappyHour {
    this.database
      .prepare(
        `INSERT INTO venue_happy_hours (
          id, venue_id, title, days_of_week_json, start_time, end_time, description, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          days_of_week_json = excluded.days_of_week_json,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          description = excluded.description,
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
        input.active ? 1 : 0,
        input.now,
        input.now,
      );
    const row = this.database
      .prepare("SELECT * FROM venue_happy_hours WHERE id = ? AND venue_id = ?")
      .get(input.id, input.barId) as BarHappyHourRow | undefined;
    if (!row) {
      throw new Error("Happy-hour row belongs to another bar");
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
    startsAt: string | null;
    endsAt: string | null;
    scheduleNote: string | null;
    exclusive: boolean;
    active: boolean;
    now: string;
  }): BarSpecial {
    this.database
      .prepare(
        `INSERT INTO venue_specials (
          id, venue_id, title, description, price, discount, starts_at, ends_at, schedule_note, exclusive, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          price = excluded.price,
          discount = excluded.discount,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
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
        input.startsAt,
        input.endsAt,
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
      throw new Error("Special row belongs to another bar");
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
      .prepare(`SELECT * FROM venue_pending_changes ${where} ORDER BY submitted_at DESC LIMIT ?`)
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

  upsertMonthlyBarReport(input: { id: string; barId: string; month: string; data: Record<string, unknown>; createdAt: string }): MonthlyBarReport {
    this.database
      .prepare(
        `INSERT INTO venue_monthly_reports (id, venue_id, month, data_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(venue_id, month) DO UPDATE SET data_json = excluded.data_json`,
      )
      .run(input.id, input.barId, input.month, JSON.stringify(input.data), input.createdAt);
    return this.getMonthlyBarReport({ barId: input.barId, month: input.month })!;
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

  getBarAreaAnalytics(input: {
    barId: string;
    area: string | null;
    month?: string | undefined;
    privacyThreshold?: number | undefined;
  }) {
    const privacyThreshold = Math.max(1, input.privacyThreshold ?? 10);
    const since = input.month ? `${input.month}-01T00:00:00.000Z` : null;
    const count = (sql: string, values: unknown[] = []) => {
      const row = this.database.prepare(sql).get(...values) as { count: number } | undefined;
      return Number(row?.count ?? 0);
    };
    const grouped = (sql: string, values: unknown[] = []) =>
      this.database.prepare(sql).all(...values) as Array<{ key: string; count: number }>;
    const rangeClause = since ? "AND created_at >= ?" : "";
    const rangeValues = since ? [since] : [];
    const eventAreaClause = input.area ? "AND lower(COALESCE(suburb, '')) = lower(?)" : "";
    const barAreaClause = input.area ? "AND lower(COALESCE(suburb, area, '')) = lower(?)" : "";
    const areaValues = input.area ? [input.area] : [];

    const barEventCount = (eventTypes: string[]) => {
      const placeholders = eventTypes.map(() => "?").join(", ");
      return count(
        `SELECT count(*) AS count
         FROM events
         WHERE venue_id = ?
           AND event_type IN (${placeholders})
           ${rangeClause}`,
        [input.barId, ...eventTypes, ...rangeValues],
      );
    };

    const areaBeerSearches = grouped(
      `SELECT COALESCE(beer_id, json_extract(metadata_json, '$.query'), 'beer') AS key, count(*) AS count
       FROM events
       WHERE event_type = 'beer_search_performed'
         ${eventAreaClause}
         ${rangeClause}
       GROUP BY COALESCE(beer_id, json_extract(metadata_json, '$.query'), 'beer')
       HAVING count(*) >= ?
       ORDER BY count DESC
       LIMIT 8`,
      [...areaValues, ...rangeValues, privacyThreshold],
    );
    const areaStyleSearches = grouped(
      `SELECT COALESCE(beer_style, query_text, 'style') AS key, count(*) AS count
       FROM venue_analytics_events
       WHERE event_type IN ('beer_style_search', 'beer_search')
         ${barAreaClause}
         ${rangeClause}
       GROUP BY COALESCE(beer_style, query_text, 'style')
       HAVING count(*) >= ?
       ORDER BY count DESC
       LIMIT 8`,
      [...areaValues, ...rangeValues, privacyThreshold],
    );

    const areaSearches = count(
      `SELECT count(*) AS count
       FROM events
       WHERE event_type IN ('search_performed', 'beer_search_performed', 'suburb_search_performed')
           ${eventAreaClause}
           ${rangeClause}`,
      [...areaValues, ...rangeValues],
    );
    const privacyFloorMet = areaSearches >= privacyThreshold;

    return {
      barLookups: barEventCount(["map_pin_click", "venue_card_viewed", "venue_detail_opened", "venue_lookup"]),
      profileViews: barEventCount(["venue_detail_opened", "venue_profile_viewed", "venue_portal_viewed"]),
      beerListViews: barEventCount(["beer_list_viewed", "price_view_revealed", "venue_detail_opened"]),
      specialsViews: barEventCount(["deal_viewed", "special_viewed", "happy_hour_active_now_used", "happy_hour_near_me_used"]),
      markerClicks: barEventCount(["map_pin_click"]),
      priceReveals: barEventCount(["price_view_revealed"]),
      areaSearches,
      areaBeerSearches: privacyFloorMet ? areaBeerSearches : [],
      areaStyleSearches: privacyFloorMet ? areaStyleSearches : [],
      privacyFloorMet,
      privacyThreshold,
    };
  }

  upsertVenuePartnerOutreach(input: {
    id: string;
    venueId: string;
    venueName: string;
    suburb: string | null;
    status: string;
    contactName: string | null;
    notes: string | null;
    updatedBy: string;
    now: string;
  }): VenuePartnerOutreach {
    this.database
      .prepare(
        `INSERT INTO venue_partner_outreach (
          id, venue_id, venue_name, suburb, status, contact_name, notes, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(venue_id) DO UPDATE SET
          venue_name = excluded.venue_name,
          suburb = excluded.suburb,
          status = excluded.status,
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
        input.beerId,
        input.suburb,
        JSON.stringify(input.metadata),
        input.createdAt,
      );
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
    createdAt: string;
  }): SourceEvidenceObject {
    this.database
      .prepare(
        `INSERT INTO source_evidence_objects (
          id, owner_user_id, storage_provider, object_path, mime_type, byte_size,
          data_base64, external_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  getAnalyticsPreview(): {
    topSearchedBeers: Array<{ key: string; count: number }>;
    topClickedVenues: Array<{ key: string; count: number }>;
    topSuburbs: Array<{ key: string; count: number }>;
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
        .all(...types) as Array<{ key: string; count: number }>;
    };

    const missionRow = this.database
      .prepare("SELECT count(*) AS count FROM events WHERE event_type = 'submission_completed'")
      .get() as { count: number } | undefined;

    return {
      topSearchedBeers: grouped("beer_search_performed", "beer_id"),
      topClickedVenues: grouped(["map_pin_click", "venue_card_viewed", "venue_detail_opened", "venue_lookup"], "venue_id"),
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

    const totalUsers = count("SELECT count(*) AS count FROM accounts");
    const newUsers = count(`SELECT count(*) AS count FROM accounts WHERE 1=1 ${rangeClause}`, rangeValues);
    const subscriptionConversions = eventCount(["subscription_created"]);
    const verifiedVenueCount = count(
      `SELECT count(DISTINCT venue_id) AS count
       FROM venue_price_records
       WHERE confidence IN ('venue_confirmed', 'photo_verified', 'community_confirmed')`,
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
      `SELECT e.venue_id AS key, count(*) AS count
       FROM events e
       LEFT JOIN venue_price_records r ON r.venue_id = e.venue_id
       WHERE e.event_type IN ('venue_card_viewed', 'venue_detail_opened', 'price_view_revealed')
         AND e.venue_id IS NOT NULL
         AND e.venue_id != ''
         ${rangeFor("e.created_at")}
       GROUP BY e.venue_id
       HAVING max(r.last_verified_at) IS NULL OR max(r.last_verified_at) < ?
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
      verifiedPricesAdded: count("SELECT count(*) AS count FROM venue_price_records WHERE confidence IN ('venue_confirmed', 'photo_verified', 'community_confirmed')"),
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
      topClickedVenues: topEventGroup(["map_pin_click", "venue_card_viewed", "venue_detail_opened", "venue_lookup"], "venue_id"),
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
      "SELECT count(DISTINCT venue_id) AS count FROM venue_price_records WHERE confidence IN ('venue_confirmed', 'photo_verified', 'community_confirmed')",
    );

    return {
      totalVenues: input.totalVenues,
      venuesWithAtLeastOneVerifiedPrice: venuesWithVerified,
      venuesWithThreePlusVerifiedPrices: count(
        `SELECT count(*) AS count
         FROM (
           SELECT venue_id
           FROM venue_price_records
           WHERE confidence IN ('venue_confirmed', 'photo_verified', 'community_confirmed')
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

  getVenueManagerInsights(input: { venueId: string; suburb: string | null; staleBefore: string }) {
    const count = (sql: string, values: unknown[] = []) => {
      const row = this.database.prepare(sql).get(...values) as { count: number } | undefined;
      return Number(row?.count ?? 0);
    };
    const priceRecords = this.listLatestPriceRecords(100, input.venueId);
    const verifiedRecords = priceRecords.filter((record) =>
      ["venue_confirmed", "photo_verified", "community_confirmed"].includes(record.confidence),
    );
    const beerIds = new Set(priceRecords.map((record) => record.normalizedBeerId).filter(Boolean));
    const wrongPriceReports = this.database
      .prepare("SELECT * FROM wrong_price_reports WHERE venue_id = ? ORDER BY created_at DESC LIMIT 25")
      .all(input.venueId) as WrongPriceReportRow[];
    const requests = this.database
      .prepare(
        `SELECT * FROM venue_requests
         WHERE venue_id = ? OR lower(COALESCE(venue_name, '')) = lower(?)
         ORDER BY created_at DESC
         LIMIT 25`,
      )
      .all(input.venueId, priceRecords[0]?.venueName ?? input.venueId) as VenueRequestRow[];
    const submissions = this.database
      .prepare("SELECT * FROM submissions WHERE venue_id = ? ORDER BY created_at DESC LIMIT 25")
      .all(input.venueId) as SubmissionRow[];
    const topBeersNearby = input.suburb
      ? this.database
          .prepare(
            `SELECT COALESCE(beer_id, json_extract(metadata_json, '$.query'), 'beer') AS key, count(*) AS count
             FROM events
             WHERE event_type = 'beer_search_performed'
               AND lower(COALESCE(suburb, '')) = lower(?)
             GROUP BY COALESCE(beer_id, json_extract(metadata_json, '$.query'), 'beer')
             ORDER BY count DESC
             LIMIT 8`,
          )
          .all(input.suburb) as Array<{ key: string; count: number }>
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
          "SELECT count(*) AS count FROM events WHERE venue_id = ? AND event_type IN ('venue_card_viewed', 'venue_detail_opened')",
          [input.venueId],
        ),
        priceReveals: count("SELECT count(*) AS count FROM events WHERE venue_id = ? AND event_type = 'price_view_revealed'", [input.venueId]),
        happyHourClicks: count("SELECT count(*) AS count FROM events WHERE venue_id = ? AND event_type IN ('happy_hour_active_now_used', 'happy_hour_near_me_used')", [input.venueId]),
        markerClicks: count("SELECT count(*) AS count FROM events WHERE venue_id = ? AND event_type = 'venue_card_viewed'", [input.venueId]),
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
      .all(input.limit) as Array<{
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

    return rows.map((row) => {
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

  rememberStripeEvent(input: { id: string; eventType: string; processedAt: string }): boolean {
    const result = this.database
      .prepare(
        "INSERT OR IGNORE INTO stripe_webhook_events (id, event_type, processed_at) VALUES (?, ?, ?)",
      )
      .run(input.id, input.eventType, input.processedAt);
    return result.changes > 0;
  }
}
