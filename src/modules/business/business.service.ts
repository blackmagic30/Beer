import crypto from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { CONTRIBUTION_POINTS, PREMIUM_PRICING, SUBMISSION_LIMITS } from "../../config/business-rules.js";
import type { Env } from "../../config/env.js";
import {
  BusinessRepository,
  type BusinessAccount,
  type BusinessSubmission,
  type BusinessSubmissionItem,
  type ConfidenceLabel,
  type SubscriptionStatus,
} from "../../db/business.repository.js";
import { VIEWER_TRACKED_BEERS, canonicalizeTrackedBeerName } from "../../constants/beers.js";
import { AppError, ExternalServiceError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

import type {
  AccountPreferencesInput,
  AdminDashboardQuery,
  AuthLoginInput,
  AuthSignupInput,
  CheckoutInput,
  CreateSubmissionInput,
  EventTrackInput,
  FeedbackInput,
  RemoveSavedItemInput,
  ReviewSubmissionInput,
  RetentionQuery,
  SaveItemInput,
  VenueRequestInput,
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

interface StripeEvent {
  id: string;
  type: string;
  data?: {
    object?: Record<string, unknown>;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function addDays(baseIso: string, days: number): string {
  const date = new Date(baseIso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function monthKeyFromIso(value: string): string {
  return value.slice(0, 7);
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

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
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
    subscriptionStatus: account.subscriptionStatus,
    premiumUntil: account.premiumUntil,
    trustScore: account.trustScore,
    contributionPointsCurrentMonth: account.contributionPointsCurrentMonth,
    approvedSubmissionCount: account.approvedSubmissionCount,
    rejectedSubmissionCount: account.rejectedSubmissionCount,
    fraudStrikeCount: account.fraudStrikeCount,
    status: account.status,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function getSourcePhotoBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    return 0;
  }

  return Buffer.byteLength(dataUrl.slice(commaIndex + 1), "base64");
}

function getSourcePhotoMimeType(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:([^;]+);base64,/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function getBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
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

function formEncode(value: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, entry] of Object.entries(value)) {
    params.set(key, entry);
  }

  return params;
}

function cleanStringList(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ).slice(0, 20);
}

function sanitizeEventMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const blockedKeyPattern = /(email|phone|token|secret|password|authorization|auth|api.?key|photo|image|dataurl)/i;
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
      | "STRIPE_SECRET_KEY"
      | "STRIPE_WEBHOOK_SECRET"
      | "STRIPE_PRICE_MONTHLY"
      | "STRIPE_PRICE_YEARLY"
      | "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"
      | "SUPABASE_URL"
      | "SUPABASE_SERVICE_ROLE_KEY"
      | "ADMIN_EMAILS"
    >,
  ) {
    if (config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY) {
      this.supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });
    }
  }

  getPublicConfig() {
    return {
      pricing: PREMIUM_PRICING,
      freePriceRevealsPerDay: this.config.FREE_PRICE_REVEALS_PER_DAY,
      contributorUnlockPoints: this.config.CONTRIBUTOR_UNLOCK_POINTS,
      contributorUnlockDays: this.config.CONTRIBUTOR_UNLOCK_DAYS,
      stripePublishableKey: this.config.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null,
      demoBillingMode: this.config.DEMO_BILLING_MODE || !this.config.STRIPE_SECRET_KEY,
      rewards: {
        partnerVenueCredit: "disabled",
        copy: "Partner venue credit is coming soon and is not active in this demo.",
      },
      trackedBeers: VIEWER_TRACKED_BEERS,
    };
  }

  getAccountFromAuthorization(authorizationHeader: string | undefined): BusinessAccount | null {
    const token = getBearerToken(authorizationHeader);
    if (!token) {
      return null;
    }

    return this.repository.getAccountBySessionTokenHash(hashToken(token), nowIso());
  }

  requireAccount(authorizationHeader: string | undefined): BusinessAccount {
    const account = this.getAccountFromAuthorization(authorizationHeader);

    if (!account) {
      throw new AppError("Login required.", 401);
    }

    return account;
  }

  requireAdmin(authorizationHeader: string | undefined): BusinessAccount {
    const account = this.requireAccount(authorizationHeader);

    if (account.role !== "admin" && account.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    return account;
  }

  signup(input: AuthSignupInput) {
    const email = normalizeEmail(input.email);

    if (this.repository.getAccountByEmail(email)) {
      throw new AppError("An account already exists for that email.", 409);
    }

    const now = nowIso();
    const adminEmails = new Set(
      (this.config.ADMIN_EMAILS ?? "")
        .split(",")
        .map((value) => normalizeEmail(value))
        .filter(Boolean),
    );
    const account = this.repository.createAccount({
      id: crypto.randomUUID(),
      email,
      passwordHash: hashPassword(input.password),
      role: adminEmails.has(email) ? "admin" : "user",
      subscriptionStatus: adminEmails.has(email) ? "admin" : "free",
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

    return this.createSessionResponse(confirmed);
  }

  login(input: AuthLoginInput) {
    const account = this.repository.getAccountByEmail(normalizeEmail(input.email));

    if (!account || !verifyPassword(input.password, account.passwordHash)) {
      throw new AppError("Invalid email or password.", 401);
    }

    return this.createSessionResponse(account);
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
    return {
      account: sanitizeAccount(updated),
    };
  }

  private createSessionResponse(account: BusinessAccount) {
    const now = nowIso();
    const token = crypto.randomBytes(32).toString("base64url");

    this.repository.createSession({
      tokenHash: hashToken(token),
      userId: account.id,
      createdAt: now,
      expiresAt: addDays(now, 60),
    });

    return {
      token,
      account: sanitizeAccount(account),
      access: this.getAccessState(account, null),
    };
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
      canUseHappyHourActiveNow: hasFullAccess,
      canUseVerifiedOnly: hasFullAccess,
      premiumUntil: account?.premiumUntil ?? null,
    };
  }

  getAccountDashboard(account: BusinessAccount) {
    const preferences = this.repository.getAccountPreferences(account.id);
    const savedItems = this.repository.listSavedItems(account.id);
    const savedSuburbs = savedItems
      .filter((item) => item.itemType === "suburb")
      .map((item) => item.label);
    const suggestedSuburb = savedSuburbs[0] ?? preferences?.preferredSuburbs[0];
    const suggestedMissions = this.listMissions({ suburb: suggestedSuburb, sort: "saved", limit: 6 });

    return {
      account: sanitizeAccount(account),
      access: this.getAccessState(account, null),
      submissions: this.repository.listSubmissions({ userId: account.id, limit: 100 }),
      preferences: preferences ?? {
        userId: account.id,
        preferredSuburbs: [],
        preferredBeers: [],
        preferredUseCases: [],
        onboardingCompletedAt: null,
        createdAt: null,
        updatedAt: null,
      },
      savedItems,
      recentSearches: this.repository.listRecentSearches(account.id, 10),
      suggestedMissions,
      contributorProgress: {
        pointsThisMonth: account.contributionPointsCurrentMonth,
        unlockThreshold: this.config.CONTRIBUTOR_UNLOCK_POINTS,
        pointsNeeded: Math.max(0, this.config.CONTRIBUTOR_UNLOCK_POINTS - account.contributionPointsCurrentMonth),
      },
      rewards: {
        status: "coming_soon",
        eligiblePlaceholder: account.approvedSubmissionCount > 0,
      },
    };
  }

  createSubmission(account: BusinessAccount, input: CreateSubmissionInput) {
    if (account.status === "suspended") {
      throw new AppError("Suspended accounts cannot submit reward-eligible data.", 403);
    }

    if (!account.ageConfirmedAt) {
      throw new AppError("Please confirm you are 18+ before submitting venue data.", 403);
    }

    const sourcePhotoUrl = this.resolveSourcePhoto(input);
    const now = nowIso();
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
      },
    });

    return {
      submission,
      statusCopy: "Submitted for review. Approved data can earn points and may unlock contributor access.",
      ocrStatus: sourcePhotoUrl ? "queued_for_review" : "not_requested",
    };
  }

  private resolveSourcePhoto(input: Pick<CreateSubmissionInput, "sourcePhotoDataUrl" | "sourcePhotoUrl">): string | null {
    if (input.sourcePhotoDataUrl) {
      const mimeType = getSourcePhotoMimeType(input.sourcePhotoDataUrl);
      if (!mimeType || !SUBMISSION_LIMITS.allowedImageMimeTypes.includes(mimeType as never)) {
        throw new AppError("Upload must be a JPEG, PNG, WebP, HEIC, or HEIF image.", 400);
      }

      if (getSourcePhotoBytes(input.sourcePhotoDataUrl) > SUBMISSION_LIMITS.maxPhotoBytes) {
        throw new AppError("Upload image must be 6MB or smaller.", 400);
      }

      // Demo storage: keep the data URL with the pending submission. Production should move this
      // to object storage and keep only a private object key.
      return input.sourcePhotoDataUrl;
    }

    return input.sourcePhotoUrl;
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

  submitFeedback(account: BusinessAccount | null, input: FeedbackInput) {
    const now = nowIso();
    const feedback = this.repository.createFeedback({
      id: crypto.randomUUID(),
      userId: account?.id ?? null,
      anonymousSessionId: input.anonymousSessionId,
      feedbackType: input.feedbackType,
      message: input.message,
      venueId: input.venueId,
      venueName: input.venueName,
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

    return {
      feedback,
      message: "Thanks. Feedback is saved for admin review.",
    };
  }

  reportWrongPrice(account: BusinessAccount | null, input: WrongPriceReportInput) {
    const now = nowIso();
    const sourcePhotoUrl = this.resolveSourcePhoto(input);
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

  reviewSubmission(admin: BusinessAccount, submissionId: string, input: ReviewSubmissionInput) {
    const submission = this.repository.getSubmissionById(submissionId);

    if (!submission) {
      throw new AppError("Submission not found.", 404);
    }

    const points = input.pointsAwarded ?? this.calculatePoints(submission.submission, submission.items);
    const result = this.repository.reviewSubmission({
      submissionId,
      reviewerId: admin.id,
      status: input.status,
      rejectionReason: input.rejectionReason,
      fraudFlagged: input.fraudFlagged || input.status === "fraud_flagged",
      pointsAwarded: input.status === "approved" ? points : 0,
      confidence: input.confidence,
      now: nowIso(),
      monthKey: monthKeyFromIso(submission.submission.observedAt),
      premiumUntil: addDays(nowIso(), this.config.CONTRIBUTOR_UNLOCK_DAYS),
      contributorUnlockPoints: this.config.CONTRIBUTOR_UNLOCK_POINTS,
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
    const hasSource = Boolean(submission.sourcePhotoUrl);
    const hasHappyHour = items.some((item) => item.isHappyHourPrice || item.happyHourDetails);
    const hasThreePrices = items.filter((item) => item.price != null).length >= 3;

    if (hasHappyHour && hasSource) {
      return CONTRIBUTION_POINTS.happyHourWithSource;
    }

    if (submission.submissionType === "full_venue_update" && (hasSource || hasThreePrices)) {
      return CONTRIBUTION_POINTS.fullVenueUpdate;
    }

    if (hasSource) {
      return CONTRIBUTION_POINTS.menuPhoto;
    }

    if (items.some((item) => item.price != null)) {
      return CONTRIBUTION_POINTS.stalePriceUpdate;
    }

    return CONTRIBUTION_POINTS.recentConfirmation;
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

    return (data ?? []) as VenueRow[];
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

  listMissions(query: { suburb?: string | undefined; sort?: string | undefined; limit: number }) {
    this.seedDemoMissions();
    const missions = this.repository.listMissions({ activeOnly: true, suburb: query.suburb, limit: query.limit });

    switch (query.sort) {
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
        return missions;
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

  listPriceRecords() {
    return this.repository.listLatestPriceRecords(200);
  }

  trackEvent(account: BusinessAccount | null, input: EventTrackInput): void {
    try {
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

    return this.repository.getAnalyticsPreview();
  }

  getAdminKpis(admin: BusinessAccount, query: AdminDashboardQuery) {
    if (admin.role !== "admin" && admin.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    const totalVenues = Math.max(this.repository.countKnownVenues(), this.repository.countMissions());
    return this.repository.getAdminKpiDashboard({
      since: startOfAdminRange(query.range),
      sevenDaysAgo: daysAgoIso(7),
      thirtyDaysAgo: daysAgoIso(30),
      staleBefore: daysAgoIso(90),
      totalVenues,
    });
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

    if (this.config.DEMO_BILLING_MODE || !this.config.STRIPE_SECRET_KEY || !priceId) {
      return {
        mode: "demo",
        checkoutUrl: `/account.html?checkout=demo&plan=${input.plan}`,
        message: "Stripe is not configured, so this demo returns a simulated checkout URL.",
      };
    }

    const successUrl = new URL("/account.html?checkout=success", this.config.PUBLIC_BASE_URL).toString();
    const cancelUrl = new URL("/pricing.html?checkout=cancelled", this.config.PUBLIC_BASE_URL).toString();
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
        "metadata[user_id]": account.id,
        "metadata[subscription_status]": subscriptionStatus,
        customer_email: account.email,
      }),
    });

    const payload = (await response.json().catch(() => null)) as { url?: string; error?: { message?: string } } | null;

    if (!response.ok || !payload?.url) {
      throw new ExternalServiceError("Stripe checkout session failed", {
        status: response.status,
        message: payload?.error?.message,
      });
    }

    return {
      mode: "stripe",
      checkoutUrl: payload.url,
    };
  }

  handleDemoSubscription(account: BusinessAccount, plan: "monthly" | "yearly") {
    const now = nowIso();
    const status: SubscriptionStatus = plan === "monthly" ? "premium_monthly" : "premium_yearly";
    const updated = this.repository.updateSubscription({
      userId: account.id,
      subscriptionStatus: status,
      premiumUntil: null,
      now,
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
      throw new AppError("Missing Stripe webhook signature.", 400);
    }

    const event = this.verifyStripeWebhook(rawBody, signature);
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
      const userId = metadata?.user_id;
      const subscriptionStatus = metadata?.subscription_status as SubscriptionStatus | undefined;
      const customer = typeof object.customer === "string" ? object.customer : null;

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
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const customer = typeof object.customer === "string" ? object.customer : null;
      const account = customer ? this.repository.getAccountByStripeCustomerId(customer) : null;

      if (account) {
        const updated = this.repository.updateSubscription({
          userId: account.id,
          subscriptionStatus: "free",
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
      }
    }
  }

  adminOverrideUser(admin: BusinessAccount, userId: string, input: { status: "active" | "warned" | "suspended"; trustScore?: number | undefined; fraudStrikeCount?: number | undefined }) {
    if (admin.role !== "admin" && admin.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    return {
      account: sanitizeAccount(this.repository.overrideUserStatus({
        userId,
        status: input.status,
        trustScore: input.trustScore,
        fraudStrikeCount: input.fraudStrikeCount,
        now: nowIso(),
      })),
    };
  }

  logStartupSummary() {
    logger.info("Business demo service ready", {
      freePriceRevealsPerDay: this.config.FREE_PRICE_REVEALS_PER_DAY,
      contributorUnlockPoints: this.config.CONTRIBUTOR_UNLOCK_POINTS,
      demoBillingMode: this.config.DEMO_BILLING_MODE || !this.config.STRIPE_SECRET_KEY,
    });
  }
}
