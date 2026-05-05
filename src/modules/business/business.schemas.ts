import { z } from "zod";

const nullableTrimmedStringSchema = z.preprocess((value) => {
  if (value == null) {
    return null;
  }

  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}, z.string().min(1).nullable());

const optionalTrimmedStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().min(1).optional());

const servingSizeSchema = z.enum(["pint", "pot", "schooner", "jug", "bottle", "can", "other"]);
const tapStatusSchema = z.enum(["yes", "no", "unknown"]);
const savedItemTypeSchema = z.enum(["venue", "beer", "suburb"]);
const feedbackTypeSchema = z.enum(["bug", "wrong_data", "feature_idea", "venue_suggestion", "general_feedback"]);
const requestTypeSchema = z.enum(["missing_venue", "missing_beer", "verify_venue", "verify_beer_at_venue"]);
const submissionStatusSchema = z.enum([
  "pending",
  "needs_more_evidence",
  "approved",
  "rejected",
  "disputed",
  "fraud_flagged",
]);
const confidenceSchema = z.enum([
  "venue_confirmed",
  "photo_verified",
  "community_confirmed",
  "user_reported_pending",
  "stale",
  "disputed",
]);

const nullablePriceSchema = z.preprocess((value) => {
  if (value === "" || value == null) {
    return null;
  }

  const numeric = Number(value);
  return Number.isNaN(numeric) ? value : numeric;
}, z.number().min(0).max(250).nullable());

const dataImageUrlSchema = z
  .string()
  .regex(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "sourcePhotoDataUrl must be a base64 image data URL");

export const authSignupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8),
  ageConfirmed: z.boolean().refine((value) => value === true, "You must confirm you are 18+."),
});

export const authLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export const ageConfirmSchema = z.object({
  ageConfirmed: z.boolean().refine((value) => value === true, "You must confirm you are 18+."),
});

const stringListSchema = z.array(z.string().trim().min(1).max(80)).max(20).default([]);

export const accountPreferencesSchema = z.object({
  preferredSuburbs: stringListSchema,
  preferredBeers: stringListSchema,
  preferredUseCases: z.array(z.enum([
    "cheapest_beer",
    "happy_hours",
    "specific_beers",
    "recently_verified",
    "contributing_data",
  ])).max(8).default([]),
  onboardingCompleted: z.boolean().default(true),
});

export const submissionItemSchema = z.object({
  beerName: z.string().trim().min(1).max(120),
  servingSize: servingSizeSchema.default("pint"),
  price: nullablePriceSchema.default(null),
  isHappyHourPrice: z.boolean().default(false),
  happyHourDetails: nullableTrimmedStringSchema.default(null),
  isOnTap: tapStatusSchema.default("unknown"),
}).superRefine((value, ctx) => {
  if (!value.isHappyHourPrice && value.price == null && value.isOnTap === "unknown") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Add a price, tap status, or happy-hour detail for this item.",
      path: ["price"],
    });
  }
});

export const createSubmissionSchema = z.object({
  venueId: z.string().min(1),
  venueName: z.string().trim().min(1).max(180),
  suburb: nullableTrimmedStringSchema.default(null),
  submissionType: z.enum(["single_beer_price", "full_venue_update", "happy_hour_update", "photo_upload"]),
  observedAt: z.string().datetime({ offset: true }),
  sourcePhotoDataUrl: dataImageUrlSchema.nullable().default(null),
  sourcePhotoUrl: nullableTrimmedStringSchema.default(null),
  notes: nullableTrimmedStringSchema.default(null),
  items: z.array(submissionItemSchema).max(20).default([]),
}).superRefine((value, ctx) => {
  const hasPhoto = Boolean(value.sourcePhotoDataUrl || value.sourcePhotoUrl);

  if (value.submissionType === "single_beer_price" && value.items.length < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A single beer price submission needs one beer row.",
      path: ["items"],
    });
  }

  if (value.submissionType === "full_venue_update" && !hasPhoto && value.items.length < 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A full venue update needs either source evidence or at least 3 beer rows.",
      path: ["items"],
    });
  }

  if (value.submissionType === "photo_upload" && !hasPhoto) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Photo/source uploads need a source photo, menu, receipt, or screenshot.",
      path: ["sourcePhotoDataUrl"],
    });
  }

  if (value.submissionType === "happy_hour_update" && value.items.length < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Happy-hour updates need days, times, specials, and conditions.",
      path: ["items"],
    });
  }

  if (value.submissionType === "happy_hour_update" && !hasPhoto) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Happy-hour updates need a source photo, screenshot, or notes with enough evidence.",
      path: ["sourcePhotoDataUrl"],
    });
  }
});

export const submissionsQuerySchema = z.object({
  status: submissionStatusSchema.optional(),
  mine: z.preprocess((value) => value === "true" || value === true, z.boolean()).default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const reviewSubmissionSchema = z.object({
  status: z.enum(["approved", "rejected", "needs_more_evidence", "fraud_flagged", "disputed"]),
  rejectionReason: nullableTrimmedStringSchema.default(null),
  fraudFlagged: z.boolean().default(false),
  pointsAwarded: z.coerce.number().int().min(0).max(25).optional(),
  confidence: confidenceSchema.default("photo_verified"),
});

export const missionsQuerySchema = z.object({
  suburb: optionalTrimmedStringSchema,
  sort: z.enum(["points", "saved", "stale", "no_data", "missing_happy_hour", "most_requested", "high_demand"]).default("points"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const createMissionSchema = z.object({
  venueId: z.string().min(1),
  venueName: z.string().trim().min(1).max(180),
  suburb: nullableTrimmedStringSchema.default(null),
  reason: z.string().trim().min(1).max(160),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  points: z.coerce.number().int().min(0).max(20),
  multiplier: z.coerce.number().min(0).max(5).default(1),
  active: z.boolean().default(true),
});

export const eventTrackSchema = z.object({
  anonymousSessionId: nullableTrimmedStringSchema.default(null),
  eventType: z.enum([
    "signup_started",
    "signup_completed",
    "age_confirmed",
    "pricing_page_viewed",
    "checkout_started",
    "subscription_created",
    "subscription_cancelled",
    "map_viewed",
    "search_performed",
    "beer_search_performed",
    "suburb_search_performed",
    "venue_card_viewed",
    "venue_detail_opened",
    "price_view_revealed",
    "price_view_blocked_free_limit",
    "map_filter_used",
    "cheapest_sort_used",
    "happy_hour_active_now_used",
    "verified_only_filter_used",
    "under_10_filter_used",
    "saved_venue_added",
    "saved_venue_removed",
    "saved_beer_added",
    "saved_beer_removed",
    "saved_suburb_added",
    "saved_suburb_removed",
    "mission_board_viewed",
    "mission_opened",
    "submission_started",
    "submission_completed",
    "submission_approved",
    "submission_rejected",
    "contributor_access_unlocked",
    "wrong_price_reported",
    "venue_requested",
    "beer_requested",
    "mission_created_from_request",
    "feedback_submitted",
    "needs_data_viewed",
  ]),
  venueId: nullableTrimmedStringSchema.default(null),
  beerId: nullableTrimmedStringSchema.default(null),
  suburb: nullableTrimmedStringSchema.default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const saveItemSchema = z.object({
  itemType: savedItemTypeSchema,
  itemId: z.string().trim().min(1).max(180),
  label: z.string().trim().min(1).max(180),
  suburb: nullableTrimmedStringSchema.default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const removeSavedItemSchema = z.object({
  itemType: savedItemTypeSchema,
  itemId: z.string().trim().min(1).max(180),
});

export const feedbackSchema = z.object({
  anonymousSessionId: nullableTrimmedStringSchema.default(null),
  feedbackType: feedbackTypeSchema,
  message: z.string().trim().min(3).max(1200),
  venueId: nullableTrimmedStringSchema.default(null),
  venueName: nullableTrimmedStringSchema.default(null),
});

export const wrongPriceReportSchema = z.object({
  anonymousSessionId: nullableTrimmedStringSchema.default(null),
  venueId: z.string().trim().min(1).max(180),
  venueName: z.string().trim().min(1).max(180),
  priceRecordId: nullableTrimmedStringSchema.default(null),
  beerName: nullableTrimmedStringSchema.default(null),
  reason: z.enum(["price_changed", "beer_not_available", "happy_hour_changed", "wrong_serving_size", "other"]),
  notes: nullableTrimmedStringSchema.default(null),
  sourcePhotoDataUrl: dataImageUrlSchema.nullable().default(null),
  sourcePhotoUrl: nullableTrimmedStringSchema.default(null),
});

export const venueRequestSchema = z.object({
  anonymousSessionId: nullableTrimmedStringSchema.default(null),
  requestType: requestTypeSchema,
  venueId: nullableTrimmedStringSchema.default(null),
  venueName: nullableTrimmedStringSchema.default(null),
  beerName: nullableTrimmedStringSchema.default(null),
  suburb: nullableTrimmedStringSchema.default(null),
  notes: nullableTrimmedStringSchema.default(null),
}).superRefine((value, ctx) => {
  if (!value.venueName && !value.venueId && value.requestType !== "missing_beer") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Add a venue name or choose a venue.",
      path: ["venueName"],
    });
  }

  if ((value.requestType === "missing_beer" || value.requestType === "verify_beer_at_venue") && !value.beerName) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Add the beer name for this request.",
      path: ["beerName"],
    });
  }
});

export const adminDashboardQuerySchema = z.object({
  range: z.enum(["today", "7d", "30d", "month", "all"]).default("7d"),
});

export const retentionQuerySchema = z.object({
  groupBy: z.enum(["week", "month"]).default("week"),
  limit: z.coerce.number().int().min(1).max(24).default(12),
});

export const checkoutSchema = z.object({
  plan: z.enum(["monthly", "yearly"]),
});

export const adminUserStatusSchema = z.object({
  status: z.enum(["active", "warned", "suspended"]),
  trustScore: z.coerce.number().int().min(0).max(100).optional(),
  fraudStrikeCount: z.coerce.number().int().min(0).max(10).optional(),
});

export type AuthSignupInput = z.infer<typeof authSignupSchema>;
export type AuthLoginInput = z.infer<typeof authLoginSchema>;
export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>;
export type ReviewSubmissionInput = z.infer<typeof reviewSubmissionSchema>;
export type EventTrackInput = z.infer<typeof eventTrackSchema>;
export type AccountPreferencesInput = z.infer<typeof accountPreferencesSchema>;
export type SaveItemInput = z.infer<typeof saveItemSchema>;
export type RemoveSavedItemInput = z.infer<typeof removeSavedItemSchema>;
export type FeedbackInput = z.infer<typeof feedbackSchema>;
export type WrongPriceReportInput = z.infer<typeof wrongPriceReportSchema>;
export type VenueRequestInput = z.infer<typeof venueRequestSchema>;
export type AdminDashboardQuery = z.infer<typeof adminDashboardQuerySchema>;
export type RetentionQuery = z.infer<typeof retentionQuerySchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
