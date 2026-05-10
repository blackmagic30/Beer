import type BetterSqlite3 from "better-sqlite3";

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
export type FeedbackType = "bug" | "wrong_data" | "feature_idea" | "venue_suggestion" | "general_feedback";
export type RequestType = "missing_venue" | "missing_beer" | "verify_venue" | "verify_beer_at_venue";
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
  role: AccountRole;
  ageConfirmedAt: string | null;
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

export interface PublicVenuePriceRecord {
  id: string;
  venueId: string;
  venueName: string;
  suburb: string | null;
  beerName: string;
  normalizedBeerId: string | null;
  servingSize: ServingSize;
  price: number | null;
  isHappyHourPrice: boolean;
  happyHourDetails: string | null;
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

interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  role: AccountRole;
  age_confirmed_at: string | null;
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

function toAccount(row: AccountRow): BusinessAccount {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    ageConfirmedAt: row.age_confirmed_at,
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

export class BusinessRepository {
  constructor(private readonly database: BetterSqlite3.Database) {}

  createAccount(input: {
    id: string;
    email: string;
    passwordHash: string;
    role: AccountRole;
    subscriptionStatus: SubscriptionStatus;
    now: string;
  }): BusinessAccount {
    this.database
      .prepare(
        `INSERT INTO accounts (
          id, email, password_hash, role, subscription_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.email, input.passwordHash, input.role, input.subscriptionStatus, input.now, input.now);
    return this.getAccountById(input.id)!;
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

  getAccountByStripeCustomerId(stripeCustomerId: string): BusinessAccount | null {
    const row = this.database
      .prepare("SELECT * FROM accounts WHERE stripe_customer_id = ?")
      .get(stripeCustomerId) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  createSession(input: { tokenHash: string; userId: string; createdAt: string; expiresAt: string }): void {
    this.database
      .prepare(
        `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.tokenHash, input.userId, input.createdAt, input.expiresAt);
  }

  getAccountBySessionTokenHash(tokenHash: string, now: string): BusinessAccount | null {
    const row = this.database
      .prepare(
        `SELECT accounts.*
         FROM auth_sessions
         JOIN accounts ON accounts.id = auth_sessions.user_id
         WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?`,
      )
      .get(tokenHash, now) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  updateAgeConfirmed(userId: string, confirmedAt: string): BusinessAccount {
    this.database
      .prepare("UPDATE accounts SET age_confirmed_at = ?, updated_at = ? WHERE id = ?")
      .run(confirmedAt, confirmedAt, userId);
    return this.getAccountById(userId)!;
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
            source_photo_url, notes, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(input.metadata),
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
    now: string;
  }): FeedbackItem {
    this.database
      .prepare(
        `INSERT INTO feedback (
          id, user_id, anonymous_session_id, feedback_type, message, venue_id, venue_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.anonymousSessionId,
        input.feedbackType,
        input.message,
        input.venueId,
        input.venueName,
        input.now,
        input.now,
      );
    const row = this.database.prepare("SELECT * FROM feedback WHERE id = ?").get(input.id) as FeedbackRow;
    return toFeedback(row);
  }

  listFeedback(limit: number): FeedbackItem[] {
    const rows = this.database
      .prepare("SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?")
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
      topClickedVenues: grouped(["venue_card_viewed", "venue_detail_opened"], "venue_id"),
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
      totalVenueDetailViews: eventCount(["venue_card_viewed", "venue_detail_opened"]),
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
      potentialPartnerLeadCount: count("SELECT count(DISTINCT venue_id) AS count FROM events WHERE venue_id IS NOT NULL AND event_type IN ('venue_detail_opened', 'venue_card_viewed')"),
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
      topClickedVenues: topEventGroup(["venue_card_viewed", "venue_detail_opened"], "venue_id"),
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
