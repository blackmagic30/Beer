import type BetterSqlite3 from "better-sqlite3";

export type AccountRole = "user" | "admin";
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

  listLatestPriceRecords(limit: number): PublicVenuePriceRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM venue_price_records ORDER BY last_verified_at DESC LIMIT ?")
      .all(limit) as PriceRecordRow[];
    return rows.map(toPriceRecord);
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

  countEvents(input: { eventType: string; userId: string | null; anonymousSessionId: string | null; since: string }): number {
    const row = this.database
      .prepare(
        `SELECT count(*) AS count
         FROM events
         WHERE event_type = ?
           AND created_at >= ?
           AND (
             (? IS NOT NULL AND user_id = ?)
             OR (? IS NOT NULL AND anonymous_session_id = ?)
           )`,
      )
      .get(
        input.eventType,
        input.since,
        input.userId,
        input.userId,
        input.anonymousSessionId,
        input.anonymousSessionId,
      ) as { count: number } | undefined;
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

  rememberStripeEvent(input: { id: string; eventType: string; processedAt: string }): boolean {
    const result = this.database
      .prepare(
        "INSERT OR IGNORE INTO stripe_webhook_events (id, event_type, processed_at) VALUES (?, ?, ?)",
      )
      .run(input.id, input.eventType, input.processedAt);
    return result.changes > 0;
  }
}
