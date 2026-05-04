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
  items: z.array(submissionItemSchema).min(1).max(20),
}).superRefine((value, ctx) => {
  const hasPhoto = Boolean(value.sourcePhotoDataUrl || value.sourcePhotoUrl);

  if (value.submissionType === "full_venue_update" && !hasPhoto && value.items.length < 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A full venue update needs either source evidence or at least 3 beer rows.",
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
    "search_performed",
    "beer_search_performed",
    "venue_card_viewed",
    "venue_detail_opened",
    "map_filter_used",
    "cheapest_sort_used",
    "happy_hour_filter_used",
    "needs_data_viewed",
    "mission_opened",
    "submission_started",
    "submission_completed",
    "price_view_revealed",
    "checkout_started",
    "subscription_created",
  ]),
  venueId: nullableTrimmedStringSchema.default(null),
  beerId: nullableTrimmedStringSchema.default(null),
  suburb: nullableTrimmedStringSchema.default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
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
export type CheckoutInput = z.infer<typeof checkoutSchema>;

