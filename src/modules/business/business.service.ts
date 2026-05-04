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
import { VIEWER_TRACKED_BEERS } from "../../constants/beers.js";
import { AppError, ExternalServiceError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

import type {
  AuthLoginInput,
  AuthSignupInput,
  CheckoutInput,
  CreateSubmissionInput,
  EventTrackInput,
  ReviewSubmissionInput,
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
    return {
      account: sanitizeAccount(this.repository.updateAgeConfirmed(account.id, nowIso())),
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
    return {
      account: sanitizeAccount(account),
      access: this.getAccessState(account, null),
      submissions: this.repository.listSubmissions({ userId: account.id, limit: 100 }),
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
      items: input.items.map((item) => ({
        id: crypto.randomUUID(),
        beerName: item.beerName.trim(),
        normalizedBeerId: normalizeBeerId(item.beerName),
        servingSize: item.servingSize,
        price: item.price,
        isHappyHourPrice: item.isHappyHourPrice,
        happyHourDetails: item.happyHourDetails,
        isOnTap: item.isOnTap,
        confidence: sourcePhotoUrl ? 0.72 : 0.52,
      })),
    });

    this.trackEvent(account, {
      anonymousSessionId: null,
      eventType: "submission_completed",
      venueId: submission.venueId,
      beerId: input.items[0] ? normalizeBeerId(input.items[0].beerName) : null,
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

  private resolveSourcePhoto(input: CreateSubmissionInput): string | null {
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

  listSubmissions(account: BusinessAccount | null, input: { status?: string | undefined; mine: boolean; limit: number }) {
    if (input.mine) {
      if (!account) {
        throw new AppError("Login required.", 401);
      }

      return this.repository.listSubmissions({
        userId: account.id,
        status: input.status as never,
        limit: input.limit,
      });
    }

    if (!account || (account.role !== "admin" && account.subscriptionStatus !== "admin")) {
      throw new AppError("Admin access required.", 403);
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
      return this.repository
        .listMissions({ activeOnly: true, limit, suburb: undefined })
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
      request = request.ilike("name", `%${query.trim()}%`);
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

  listMissions(query: { suburb?: string | undefined; limit: number }) {
    this.seedDemoMissions();
    return this.repository.listMissions({ activeOnly: true, suburb: query.suburb, limit: query.limit });
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
    this.repository.recordEvent({
      id: crypto.randomUUID(),
      userId: account?.id ?? null,
      anonymousSessionId: input.anonymousSessionId,
      eventType: input.eventType,
      venueId: input.venueId,
      beerId: input.beerId,
      suburb: input.suburb,
      metadata: input.metadata,
      createdAt: nowIso(),
    });
  }

  getAnalyticsPreview(admin: BusinessAccount) {
    if (admin.role !== "admin" && admin.subscriptionStatus !== "admin") {
      throw new AppError("Admin access required.", 403);
    }

    return this.repository.getAnalyticsPreview();
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
        this.repository.updateSubscription({
          userId,
          subscriptionStatus,
          stripeCustomerId: customer,
          premiumUntil: null,
          now: nowIso(),
        });
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const customer = typeof object.customer === "string" ? object.customer : null;
      const account = customer ? this.repository.getAccountByStripeCustomerId(customer) : null;

      if (account) {
        this.repository.updateSubscription({
          userId: account.id,
          subscriptionStatus: "free",
          premiumUntil: null,
          now: nowIso(),
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
