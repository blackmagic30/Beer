import { z } from "zod";

import { CURRENT_LEGAL_POLICY_VERSION } from "../../config/legal.js";
import { CONTRIBUTION_POINTS } from "../../config/business-rules.js";

const canonicalUtcTimestampSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}, "Timestamp must be a canonical UTC ISO timestamp");

const nullableTrimmedStringSchema = z.preprocess((value) => {
  if (value == null) {
    return null;
  }

  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}, z.string().min(1).max(2_000).nullable());

const nullableAustralianPostcodeSchema = z.preprocess((value) => {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}, z.string().regex(/^\d{4}$/, "Postcode must be exactly four digits").nullable());

const nullableOfferTextSchema = z.preprocess((value) => {
  if (value == null) {
    return null;
  }

  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}, z.string().min(1).max(160).nullable());

const optionalTrimmedStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().min(1).max(2_000).optional());

const servingSizeSchema = z.enum(["pint", "pot", "schooner", "jug", "bottle", "can", "other"]);
const tapStatusSchema = z.enum(["yes", "no", "unknown"]);
const savedItemTypeSchema = z.enum(["venue", "beer", "suburb", "night_plan"]);
const feedbackTypeSchema = z.enum([
  "bug",
  "wrong_data",
  "feature_idea",
  "venue_suggestion",
  "venue_partner_interest",
  "general_feedback",
  "privacy_request",
  "data_export_request",
  "account_deletion_request",
  "moderation_appeal",
  "security_report",
  "abuse_report",
  "billing_support",
]);
const requestTypeSchema = z.enum(["missing_venue", "missing_beer", "verify_venue", "verify_beer_at_venue"]);
const barMembershipTierSchema = z.preprocess((value) => value === "plus" ? "pro" : value, z.enum(["basic", "pro"]));
const partnerInterestStatusSchema = z.enum(["open", "contacted", "interested", "partner", "not_interested", "closed"]);
const venueOutreachStatusSchema = z.enum(["lead", "contacted", "interested", "partner", "not_interested", "closed"]);
const venueOutreachTierFitSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }
  if (value === "plus") {
    return "pro";
  }
  return value;
}, z.enum(["basic", "pro"]).nullable());
const submissionStatusSchema = z.enum([
  "pending",
  "needs_more_evidence",
  "approved",
  "rejected",
  "disputed",
  "fraud_flagged",
]);
const confidenceSchema = z.enum([
  "admin_verified",
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
}, z
  .number()
  .gt(0, "Price must be greater than $0.")
  .max(250, "Price cannot exceed $250.")
  .refine(
    (value) => Math.abs((value * 100) - Math.round(value * 100)) < 1e-8,
    "Price can have at most 2 decimal places.",
  )
  .nullable());

const dataImageUrlSchema = z
  .string()
  .regex(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "sourcePhotoDataUrl must be a base64 image data URL");

const dataPdfUrlSchema = z
  .string()
  .regex(/^data:application\/pdf;base64,/, "sourceDocumentDataUrl must be a base64 PDF data URL");

const uploadLocationSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  accuracyMeters: z.number().min(0).max(CONTRIBUTION_POINTS.maxLocationAccuracyMeters),
  capturedAt: z.string().datetime({ offset: true }),
}).nullable().default(null);

const nullableUrlSchema = z.preprocess((value) => {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}, z.string().url().nullable());

export const authSignupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  displayName: nullableTrimmedStringSchema.default(null),
  ageConfirmed: z.boolean().refine((value) => value === true, "You must confirm you are 18+."),
  termsAccepted: z.boolean().refine((value) => value === true, "You must accept the Terms and Conditions."),
  privacyAccepted: z.boolean().refine((value) => value === true, "You must accept the Privacy Policy."),
});

export const authLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

export const billingRecoveryPortalSchema = z.object({
  accessToken: z.string().trim().min(20).max(16_384).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  password: z.string().min(1).max(128).optional(),
  venueId: z.string().trim().min(1).max(200).optional(),
}).superRefine((value, ctx) => {
  const providerMode = Boolean(value.accessToken);
  const passwordMode = Boolean(value.email && value.password);
  if (providerMode === passwordMode) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either a provider access token or email and password.",
    });
  }
});

const authConsentSourceSchema = z
  .enum(["web", "web_oauth", "ios", "ios_app", "android", "android_app"])
  .transform((source): "web" | "ios" | "android" => {
    if (source === "web" || source === "web_oauth") return "web";
    if (source === "ios" || source === "ios_app") return "ios";
    return "android";
  });

export const authSupabaseSessionSchema = z.object({
  accessToken: z.string().trim().min(20),
  ageConfirmed: z.boolean().optional(),
  termsAccepted: z.boolean().optional(),
  privacyAccepted: z.boolean().optional(),
  termsVersion: z.literal(CURRENT_LEGAL_POLICY_VERSION).optional(),
  privacyVersion: z.literal(CURRENT_LEGAL_POLICY_VERSION).optional(),
  consentSource: authConsentSourceSchema.optional(),
  legalAcceptance: z.object({
    ageConfirmed: z.boolean().refine((value) => value === true, "You must confirm you are 18+."),
    termsAccepted: z.boolean().refine((value) => value === true, "You must accept the Terms and Conditions."),
    privacyAccepted: z.boolean().refine((value) => value === true, "You must accept the Privacy Policy."),
    termsVersion: z.literal(CURRENT_LEGAL_POLICY_VERSION).default(CURRENT_LEGAL_POLICY_VERSION),
    privacyVersion: z.literal(CURRENT_LEGAL_POLICY_VERSION).default(CURRENT_LEGAL_POLICY_VERSION),
    source: authConsentSourceSchema.default("web"),
  }).optional(),
}).superRefine((value, ctx) => {
  const hasTopLevelConsent = [
    value.ageConfirmed,
    value.termsAccepted,
    value.privacyAccepted,
    value.termsVersion,
    value.privacyVersion,
    value.consentSource,
  ].some((item) => item !== undefined);
  if (hasTopLevelConsent && (
    value.ageConfirmed !== true ||
    value.termsAccepted !== true ||
    value.privacyAccepted !== true ||
    value.termsVersion !== CURRENT_LEGAL_POLICY_VERSION ||
    value.privacyVersion !== CURRENT_LEGAL_POLICY_VERSION
  )) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["termsAccepted"],
      message: "Complete current age, Terms, and Privacy acceptance together.",
    });
  }
});

export const passwordResetCompleteSchema = z.object({
  accessToken: z.string().trim().min(20),
});

export const logoutAllSchema = z.object({
  accessToken: z.string().trim().min(20).optional(),
});

export const ageConfirmSchema = z.object({
  ageConfirmed: z.boolean().refine((value) => value === true, "You must confirm you are 18+."),
});

export const legalAcceptanceSchema = z.object({
  termsAccepted: z.boolean().refine((value) => value === true, "You must accept the Terms and Conditions."),
  privacyAccepted: z.boolean().refine((value) => value === true, "You must accept the Privacy Policy."),
  termsVersion: z.literal(CURRENT_LEGAL_POLICY_VERSION).default(CURRENT_LEGAL_POLICY_VERSION),
  privacyVersion: z.literal(CURRENT_LEGAL_POLICY_VERSION).default(CURRENT_LEGAL_POLICY_VERSION),
});

export const verificationSchema = z.object({
  result: z.enum(["confirmed", "disputed", "needs_more_evidence"]).default("confirmed"),
  notes: nullableTrimmedStringSchema.default(null),
});

export const verificationCandidatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
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
  expectedUpdatedAt: canonicalUtcTimestampSchema.nullable().default(null),
});

export const accountPrivacySettingsSchema = z.object({
  optionalAnalyticsEnabled: z.boolean().default(false),
  venueReportInclusionEnabled: z.boolean().default(false),
  productResearchEnabled: z.boolean().default(false),
  emailUpdatesEnabled: z.boolean().default(false),
  // Accepted only for backwards compatibility with older web clients. The
  // service always records the server-owned current legal policy version.
  consentVersion: z.string().trim().min(1).max(40).optional(),
  expectedUpdatedAt: canonicalUtcTimestampSchema.nullable().default(null),
});

export const accountDeletionRequestSchema = z.object({
  message: nullableTrimmedStringSchema.default(null),
});

export const adminReasonSchema = z.object({
  reason: z.string().trim().min(4).max(500),
});

export const accountDeletionNotificationResolutionSchema = z.object({
  resolution: z.enum(["verified_delivered", "undeliverable"]),
  reason: z.string().trim().min(4).max(500),
});

export const submissionItemSchema = z.object({
  beerName: z.string().trim().min(1).max(120),
  servingSize: servingSizeSchema.default("pint"),
  price: nullablePriceSchema.default(null),
  isHappyHourPrice: z.boolean().default(false),
  happyHourDetails: nullableTrimmedStringSchema.default(null),
  isOnTap: tapStatusSchema.default("unknown"),
}).superRefine((value, ctx) => {
  if (value.price == null && value.isOnTap === "unknown" && !value.happyHourDetails) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Add a price, tap status, or happy-hour detail for this item.",
      path: ["price"],
    });
  }
});

export const pendingSubmissionVenueSchema = z.object({
  googlePlaceId: nullableTrimmedStringSchema.default(null),
  name: z.string().trim().min(1).max(180),
  address: nullableTrimmedStringSchema.default(null),
  suburb: nullableTrimmedStringSchema.default(null),
  state: nullableTrimmedStringSchema.default("VIC"),
  postcode: nullableAustralianPostcodeSchema.default(null),
  phone: nullableTrimmedStringSchema.default(null),
  website: nullableUrlSchema.default(null),
  latitude: z.preprocess(
    (value) => value === "" || value === undefined ? null : value,
    z.coerce.number().min(-90).max(90).nullable(),
  ).default(null),
  longitude: z.preprocess(
    (value) => value === "" || value === undefined ? null : value,
    z.coerce.number().min(-180).max(180).nullable(),
  ).default(null),
}).nullable().default(null);

export const createSubmissionSchema = z.object({
  clientSubmissionId: z
    .string()
    .trim()
    .min(8)
    .max(100)
    .regex(/^[a-zA-Z0-9._:-]+$/, "clientSubmissionId contains unsupported characters")
    .nullable()
    .default(null),
  missionId: nullableTrimmedStringSchema.default(null),
  venueId: z.string().min(1),
  venueName: z.string().trim().min(1).max(180),
  suburb: nullableTrimmedStringSchema.default(null),
  newVenue: pendingSubmissionVenueSchema,
  submissionType: z.enum(["single_beer_price", "full_venue_update", "happy_hour_update", "photo_upload"]),
  observedAt: z.string().datetime({ offset: true }),
  sourcePhotoDataUrl: dataImageUrlSchema.nullable().default(null),
  sourcePhotoDataUrls: z.array(dataImageUrlSchema).max(6).default([]),
  sourceDocumentDataUrl: dataPdfUrlSchema.nullable().default(null),
  sourcePhotoUrl: nullableTrimmedStringSchema.default(null),
  uploadLocation: uploadLocationSchema,
  notes: nullableTrimmedStringSchema.default(null),
  items: z.array(submissionItemSchema).max(20).default([]),
}).superRefine((value, ctx) => {
  const hasPhoto = Boolean(
    value.sourcePhotoDataUrl ||
    value.sourcePhotoDataUrls.length ||
    value.sourceDocumentDataUrl ||
    value.sourcePhotoUrl
  );

  if (value.newVenue) {
    if (!value.newVenue.address && (value.newVenue.latitude == null || value.newVenue.longitude == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "New venues need an address or saved venue coordinates before admin review.",
        path: ["newVenue", "address"],
      });
    }

    if (
      (value.newVenue.latitude == null && value.newVenue.longitude != null) ||
      (value.newVenue.latitude != null && value.newVenue.longitude == null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Add both latitude and longitude, or leave both blank.",
        path: ["newVenue", "latitude"],
      });
    }
  }

  if (value.submissionType === "single_beer_price" && value.items.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A single beer price submission needs exactly one beer row.",
      path: ["items"],
    });
  }

  if (value.submissionType === "full_venue_update" && value.items.length < 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A full venue update needs at least 3 beer rows.",
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

  const seenBeerServings = new Map<string, number>();
  value.items.forEach((item, index) => {
    const normalizedBeerName = item.beerName
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase()
      .replaceAll("&", " and ")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const key = `${normalizedBeerName}:${item.servingSize}`;
    const firstIndex = seenBeerServings.get(key);
    if (firstIndex !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `This beer and serving size already appear in row ${firstIndex + 1}.`,
        path: ["items", index, "beerName"],
      });
      return;
    }
    seenBeerServings.set(key, index);
  });

});

export const submissionsQuerySchema = z.object({
  status: submissionStatusSchema.optional(),
  mine: z.preprocess((value) => value === "true" || value === true, z.boolean()).default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  includeReviewData: z.preprocess((value) => value === "true" || value === true, z.boolean()).default(false),
});

export const reviewSubmissionSchema = z.object({
  status: z.enum(["approved", "rejected", "needs_more_evidence", "fraud_flagged", "disputed"]),
  rejectionReason: nullableTrimmedStringSchema.default(null),
  fraudFlagged: z.boolean().default(false),
  pointsAwarded: z.coerce.number().min(0).max(25).optional(),
});

export const missionsQuerySchema = z.object({
  suburb: optionalTrimmedStringSchema,
  q: optionalTrimmedStringSchema,
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(0.1).max(50).default(5),
  sort: z.enum(["points", "saved", "stale", "no_data", "missing_happy_hour", "most_requested", "high_demand", "nearby"]).default("points"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});

export const venuesQuerySchema = z.object({
  q: optionalTrimmedStringSchema,
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});

export const geocodeQuerySchema = z.object({
  q: z.string().trim().min(2).max(120),
});

export const venuePlaceSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(160),
});

export const priceRecordsQuerySchema = z.object({
  venueId: optionalTrimmedStringSchema,
  anonymousSessionId: nullableTrimmedStringSchema.default(null),
  cursor: optionalTrimmedStringSchema,
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const createMissionSchema = z.object({
  venueId: z.string().min(1),
  venueName: z.string().trim().min(1).max(180),
  suburb: nullableTrimmedStringSchema.default(null),
  reason: z.string().trim().min(1).max(160),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  points: z.coerce.number().min(0).max(20),
  multiplier: z.coerce.number().min(0).max(5).default(1),
  active: z.boolean().default(true),
});

export const adminMissionUpdateSchema = z.object({
  active: z.boolean(),
  reason: z.string().trim().min(4).max(500),
});

export const eventTrackSchema = z.object({
  anonymousSessionId: nullableTrimmedStringSchema.default(null),
  eventType: z.enum([
    "signup_started",
    "signup_completed",
    "age_confirmed",
    "age_verification_started",
    "age_verification_status_updated",
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
    "free_preview_viewed",
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
    "saved_night_plan_added",
    "saved_night_plan_removed",
    "mission_board_viewed",
    "mission_opened",
    "submission_started",
    "submission_completed",
    "data_upload_created",
    "data_verified",
    "data_edit_submitted",
    "venue_visit_logged",
    "reward_eligibility_checked",
    "submission_approved",
    "submission_rejected",
    "contributor_access_unlocked",
    "wrong_price_reported",
    "venue_requested",
    "beer_requested",
    "mission_created_from_request",
    "feedback_submitted",
    "needs_data_viewed",
    "location_permission_requested",
    "location_permission_granted",
    "location_permission_denied",
    "near_me_enabled",
    "happy_hour_near_me_used",
    "distance_sort_used",
    "radius_filter_changed",
    "best_options_used",
    "cheapest_near_me_used",
    "recently_verified_near_me_used",
    "suburb_area_selected",
    "share_link_copied",
    "venue_shared",
    "search_shared",
    "directions_clicked",
    "quick_submit_started",
    "venue_partner_page_viewed",
    "venue_interest_submitted",
    "venue_claim_requested",
    "venue_portal_viewed",
    "venue_update_submitted",
    "venue_qr_link_copied",
    "venue_insights_viewed",
    "venue_profile_viewed",
    "beer_list_viewed",
    "deal_viewed",
    "special_viewed",
    "beer_search",
    "style_search",
    "venue_lookup",
    "map_pin_click",
    "partner_lead_viewed",
    "venue_manager_assigned",
    "venue_manager_revoked",
    "outreach_status_updated",
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
  contactEmail: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().toLowerCase().email().nullable(),
  ).default(null),
});

export const trustWorkflowUpdateSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "rejected"]),
  assignedTo: nullableTrimmedStringSchema.default(null),
  resolutionNote: nullableTrimmedStringSchema.default(null),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
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
  googlePlaceId: z.string().trim().min(1).max(255).nullable().optional(),
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

export const venueInterestSchema = z.object({
  anonymousSessionId: nullableTrimmedStringSchema.default(null),
  venueId: nullableTrimmedStringSchema.default(null),
  venueName: z.string().trim().min(1).max(180),
  managerName: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: nullableTrimmedStringSchema.default(null),
  role: z.string().trim().min(1).max(80),
  notes: nullableTrimmedStringSchema.default(null),
  claimListing: z.boolean().default(false),
});

export const venueManagerAssignmentSchema = z.object({
  userId: z.string().trim().min(1),
  venueId: z.string().trim().min(1).max(180),
  venueName: z.string().trim().min(1).max(180),
  suburb: nullableTrimmedStringSchema.default(null),
  accessLevel: z.enum(["manager", "counter_staff"]).optional(),
});

export const venueManagerRevokeSchema = z.object({
  userId: z.string().trim().min(1),
  venueId: z.string().trim().min(1).max(180),
});

export const venueOutreachSchema = z.object({
  venueId: z.string().trim().min(1).max(180),
  venueName: z.string().trim().min(1).max(180),
  suburb: nullableTrimmedStringSchema.default(null),
  status: venueOutreachStatusSchema.default("lead"),
  tierFit: venueOutreachTierFitSchema.default(null),
  nextAction: nullableTrimmedStringSchema.default(null),
  lastContactedAt: z.preprocess((value) => {
    if (value == null || typeof value === "string" && value.trim() === "") return null;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
      return `${value.trim()}T00:00:00.000Z`;
    }
    return value;
  }, canonicalUtcTimestampSchema.nullable()).default(null),
  contactName: nullableTrimmedStringSchema.default(null),
  notes: nullableTrimmedStringSchema.default(null),
  expectedUpdatedAt: canonicalUtcTimestampSchema.nullable().default(null),
});

export const venueInterestStatusSchema = z.object({
  status: partnerInterestStatusSchema,
  expectedUpdatedAt: canonicalUtcTimestampSchema,
});

export const venuePortalQuerySchema = z.object({
  venueId: nullableTrimmedStringSchema.default(null),
});

export const venueReconciliationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});

const dayOfWeekSchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

export function normalizeHappyHourTime(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return raw;
  }

  const compact = raw
    .replace(/\s+/g, "")
    .replace(/[.]/g, ":");
  const meridiemMatch = compact.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm)$/);
  if (meridiemMatch) {
    let hour = Number(meridiemMatch[1]);
    const minute = Number(meridiemMatch[2] ?? "0");
    const meridiem = meridiemMatch[3];
    if (hour >= 1 && hour <= 12 && minute >= 0 && minute <= 59) {
      if (meridiem === "pm" && hour !== 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
  }

  const numericMatch = compact.match(/^(\d{1,2})(?::?(\d{2}))$/);
  if (numericMatch) {
    const hour = Number(numericMatch[1]);
    const minute = Number(numericMatch[2]);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
  }

  const hourOnlyMatch = compact.match(/^(\d{1,2})$/);
  if (hourOnlyMatch) {
    const hour = Number(hourOnlyMatch[1]);
    if (hour >= 0 && hour <= 23) {
      return `${String(hour).padStart(2, "0")}:00`;
    }
  }

  return compact;
}

const timeSchema = z.preprocess(
  normalizeHappyHourTime,
  z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a valid time, e.g. 7:30 pm or 19:30."),
);

export const barProfileSchema = z.object({
  name: z.string().trim().min(1).max(180),
  address: nullableTrimmedStringSchema.default(null),
  suburb: nullableTrimmedStringSchema.default(null),
  area: nullableTrimmedStringSchema.default(null),
  phone: nullableTrimmedStringSchema.default(null),
  website: nullableUrlSchema.default(null),
  instagram: nullableUrlSchema.default(null),
  description: nullableTrimmedStringSchema.default(null),
  openingHours: z.record(z.string(), z.unknown()).default({}),
  venueTags: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  replaceVenueTags: z.boolean().default(false),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable().default(null),
  membershipTier: barMembershipTierSchema.optional(),
  acceptsPintPathCodes: z.boolean().optional(),
  active: z.boolean().default(true),
});

export const barBeerSchema = z.object({
  id: nullableTrimmedStringSchema.default(null),
  beerName: z.string().trim().min(1).max(160),
  brewery: nullableTrimmedStringSchema.default(null),
  style: nullableTrimmedStringSchema.default(null),
  abv: z.preprocess((value) => {
    if (value === "" || value == null) {
      return null;
    }
    const numeric = Number(value);
    return Number.isNaN(numeric) ? value : numeric;
  }, z.number().min(0).max(25).nullable()).default(null),
  serveSize: servingSizeSchema.nullable().default(null),
  price: nullablePriceSchema.default(null),
  onTap: z.boolean().default(false),
  inStock: z.boolean().default(true),
  notes: nullableTrimmedStringSchema.default(null),
  priceConfirmed: z.boolean().default(false),
  stockConfirmed: z.boolean().default(false),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable().default(null),
});

export const barBeerBulkSchema = z.object({
  items: z.array(barBeerSchema).min(1).max(100),
});

const happyHourBeerSchema = z.object({
  beerId: nullableTrimmedStringSchema.default(null),
  beerName: z.string().trim().min(1).max(160),
  normalizedBeerId: nullableTrimmedStringSchema.default(null),
  servingSize: servingSizeSchema.nullable().default(null),
  happyHourPrice: nullablePriceSchema.default(null),
  offerText: nullableOfferTextSchema.default(null),
  onTap: z.boolean().default(false),
  inStock: z.boolean().default(true),
});

export const barHappyHourSchema = z.object({
  id: nullableTrimmedStringSchema.default(null),
  title: z.string().trim().min(1).max(140),
  daysOfWeek: z.array(dayOfWeekSchema).min(1, "Choose at least one day.").max(7),
  startTime: timeSchema,
  endTime: timeSchema,
  description: z.string().trim().min(1).max(800),
  happyHourBeers: z.array(happyHourBeerSchema).max(60).default([]),
  active: z.boolean().default(true),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable().default(null),
});

export const barSpecialSchema = z.object({
  id: nullableTrimmedStringSchema.default(null),
  title: z.string().trim().min(1).max(140),
  description: z.string().trim().min(1).max(1000),
  price: nullablePriceSchema.default(null),
  discount: nullableTrimmedStringSchema.default(null),
  savingsAmountCents: z.preprocess(
    (value) => value === "" || value == null ? null : value,
    z.coerce.number().int().min(0).max(100_000).nullable(),
  ).default(null),
  startsAt: nullableTrimmedStringSchema.default(null),
  endsAt: nullableTrimmedStringSchema.default(null),
  startTime: timeSchema,
  endTime: timeSchema,
  recurrence: z.object({
    frequency: z.enum(["none", "weekly"]).default("none"),
    daysOfWeek: z.array(dayOfWeekSchema).max(7).default([]),
    timezone: z.string().trim().min(1).max(80).default("Australia/Melbourne"),
  }).default({ frequency: "none", daysOfWeek: [], timezone: "Australia/Melbourne" }),
  scheduleNote: nullableTrimmedStringSchema.default(null),
  exclusive: z.boolean().default(false),
  active: z.boolean().default(true),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable().default(null),
}).superRefine((value, ctx) => {
  if (value.recurrence.frequency === "weekly" && value.recurrence.daysOfWeek.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["recurrence", "daysOfWeek"], message: "Choose at least one weekday for a weekly special." });
  }
  if (value.startTime && value.endTime && value.startTime === value.endTime) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endTime"], message: "Special start and end times must differ." });
  }
});

export const versionedVenueDeleteSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});

export const barClaimRequestSchema = z.object({
  barId: nullableTrimmedStringSchema.default(null),
  barName: z.string().trim().min(1).max(180),
  address: nullableTrimmedStringSchema.default(null),
  suburb: nullableTrimmedStringSchema.default(null),
  requesterName: z.string().trim().min(1).max(120),
  requesterRole: z.string().trim().min(1).max(120),
  contactEmail: z.string().trim().toLowerCase().email(),
  contactPhone: nullableTrimmedStringSchema.default(null),
  message: nullableTrimmedStringSchema.default(null),
});

export const adminDashboardQuerySchema = z.object({
  range: z.enum(["today", "7d", "30d", "month", "all"]).default("7d"),
});

export const adminPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});

export const adminAccountSearchSchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export const beerCatalogApproveSchema = z.object({
  reviewNote: nullableTrimmedStringSchema.default(null),
});

export const beerCatalogAdminQuerySchema = z.object({
  pendingLimit: z.coerce.number().int().min(1).max(200).default(100),
  pendingOffset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  activeLimit: z.coerce.number().int().min(1).max(500).default(100),
  activeOffset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  activeQ: z.string().trim().max(120).default(""),
});

export const beerCatalogRejectSchema = z.object({
  reviewNote: z.string().trim().min(4).max(500),
});

export const beerCatalogBulkRejectSchema = z.object({
  keys: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
  reviewNote: z.string().trim().min(4).max(500),
});

export const beerCatalogMergeSchema = z.object({
  targetKey: z.string().trim().min(1).max(160),
  reviewNote: nullableTrimmedStringSchema.default(null),
});

const reportMonthSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}$/, "Use YYYY-MM, for example 2026-05.")
  .refine((value) => {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5));
    return Number.isInteger(year) && year >= 2020 && year <= 2100 &&
      Number.isInteger(month) && month >= 1 && month <= 12;
  }, "Use a valid calendar month from 2020 to 2100, for example 2026-05.");

export const monthlyReportParamsSchema = z.object({
  venueId: z.string().trim().min(1).max(200),
  month: reportMonthSchema,
});

export const monthlyReportGenerateSchema = z.object({
  month: reportMonthSchema.optional(),
  venueId: nullableTrimmedStringSchema.default(null),
  dryRun: z.boolean().default(false),
});

export const monthlyReportDeliverySchema = monthlyReportGenerateSchema.extend({
  deliver: z.boolean().default(true),
});

export const venueReportDeliverySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  recipients: z.array(
    z.string().trim().toLowerCase().email().max(254),
  ).max(10).default([]),
}).transform((value) => ({
  ...value,
  recipients: [...new Set(value.recipients)],
}));

export const monthlyReportExportQuerySchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
});

export const retentionQuerySchema = z.object({
  groupBy: z.enum(["week", "month"]).default("week"),
  limit: z.coerce.number().int().min(1).max(24).default(12),
});

export const checkoutSchema = z.object({
  plan: z.enum(["monthly", "yearly"]),
});

export const checkoutSessionSchema = z.object({
  sessionId: z.string().trim().min(8).max(255),
});

export const leaderboardQuerySchema = z.object({
  period: z.enum(["month", "all_time"]).default("month"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const displayNameUpdateSchema = z.object({
  displayName: nullableTrimmedStringSchema.default(null),
});

export const pubGolfPlanSchema = z.object({
  startLocation: z.string().trim().min(2).max(160),
  finishLocation: z.string().trim().min(2).max(160),
  drinks: z.array(z.string().trim().min(1).max(80)).length(9),
  mode: z.enum(["auto", "walking", "transit"]).default("auto"),
});

const leaderboardMonthKeySchema = z.string().trim().regex(/^\d{4}-\d{2}$/, "Use a YYYY-MM month key.");

export const leaderboardPrizeCampaignSchema = z.object({
  monthKey: leaderboardMonthKeySchema,
  title: z.string().trim().min(3).max(120).default("Monthly contributor leaderboard"),
  affiliateBar: nullableTrimmedStringSchema.default(null),
  terms: nullableTrimmedStringSchema.default(null),
  firstPlaceCents: z.coerce.number().int().min(0).max(100_000).default(10_000),
  secondPlaceCents: z.coerce.number().int().min(0).max(100_000).default(5_000),
  thirdPlaceCents: z.coerce.number().int().min(0).max(100_000).default(2_500),
});

export const leaderboardPrizeFinalizeSchema = z.object({
  monthKey: leaderboardMonthKeySchema,
  force: z.boolean().default(false),
});

export const rewardVoucherTransitionSchema = z.object({
  action: z.enum(["fulfill", "void"]),
  reason: z.string().trim().min(3).max(500),
});

export const discountRedemptionSchema = z.object({
  code: z.string().trim()
    .regex(/^[A-Za-z0-9]{6}$/, "Use the current 6-character Pint Path discount code.")
    .transform((value) => value.toUpperCase()),
  specialId: nullableTrimmedStringSchema.default(null),
  itemName: nullableTrimmedStringSchema.default(null),
  quantity: z.coerce.number().int().min(1).max(4).default(1),
  estimatedSavingsCents: z.coerce.number().int().min(0).max(100_000).default(0),
  notes: nullableTrimmedStringSchema.default(null),
});

export const pintPointMemberPreviewSchema = z.object({
  code: z.string().trim()
    .regex(/^[A-Za-z0-9]{6}$/, "Use the current 6-character Pint Path code.")
    .transform((value) => value.toUpperCase()),
  transactionReference: z.string().trim().min(4).max(120),
});

export const pintPointDrinkRecordSchema = z.object({
  code: z.string().trim()
    .regex(/^[A-Za-z0-9]{6}$/, "Use the current 6-character Pint Path code.")
    .transform((value) => value.toUpperCase())
    .optional(),
  checkoutToken: z.string().trim().min(32).max(2_048).optional(),
  itemName: nullableTrimmedStringSchema.default(null),
  beverageCategory: z.enum(["alcoholic", "non_alcoholic", "food"]).default("alcoholic"),
  quantity: z.coerce.number().int().min(1).max(4).default(1),
  transactionReference: z.string().trim().min(4).max(120),
  notes: nullableTrimmedStringSchema.default(null),
}).refine((value) => Boolean(value.code) !== Boolean(value.checkoutToken), {
  message: "Use either the current member code or its checked checkout authorization, not both.",
  path: ["code"],
});

export const pintPointDrinkVoidSchema = z.object({
  reason: z.string().trim().min(4).max(240),
});

export const venueCounterStaffAssignmentSchema = z.object({
  accountId: z.string().trim().min(3).max(32).transform((value) => value.toUpperCase()),
});

export const venueCounterStaffInvitationResponseSchema = z.object({
  decision: z.enum(["accept", "decline"]),
});

export const freePintRewardCodeSchema = z.object({
  venueId: nullableTrimmedStringSchema.default(null),
});

export const freePintRewardDecisionSchema = z.object({
  code: z.string().trim()
    .regex(/^[A-Za-z0-9]{6}$/, "Use the current 6-character Free Pint Reward code.")
    .transform((value) => value.toUpperCase()),
  action: z.enum(["confirm", "reject"]).default("confirm"),
  reason: nullableTrimmedStringSchema.default(null),
}).superRefine((value, ctx) => {
  if (value.action === "reject" && (!value.reason || value.reason.trim().length < 4)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reason"],
      message: "Add a clear rejection reason so the member and audit trail explain what happened.",
    });
  }
});

export const posDiscountRedemptionSchema = z.object({
  venueId: z.string().trim().min(1).max(180),
  code: z.string().trim()
    .regex(/^[A-Za-z0-9]{6}$/, "Use the current 6-character Pint Path discount code.")
    .transform((value) => value.toUpperCase()),
  specialId: nullableTrimmedStringSchema.default(null),
  itemName: z.string().trim().min(1).max(180),
  quantity: z.coerce.number().int().min(1).max(4).default(1),
  discountAmountCents: z.coerce.number().int().min(0).max(100_000).default(0),
  estimatedSavingsCents: z.coerce.number().int().min(0).max(100_000).optional(),
  posReference: z.string().trim().min(4).max(120),
  terminalId: nullableTrimmedStringSchema.default(null),
  redeemedAt: z.string().datetime({ offset: true }).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const barTierCheckoutSchema = z.object({
  tier: z.literal("pro"),
});

export const barPendingChangeReviewSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  rejectionReason: nullableTrimmedStringSchema.default(null),
});

export const venueClaimRequestSchema = barClaimRequestSchema;
export const venueClaimReviewSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  reviewNote: nullableTrimmedStringSchema.default(null),
}).superRefine((value, ctx) => {
  if (value.status === "rejected" && (!value.reviewNote || value.reviewNote.length < 4)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Add a short reason when rejecting a venue claim.",
      path: ["reviewNote"],
    });
  }
});
export const venuePendingChangeReviewSchema = barPendingChangeReviewSchema;

export const adminUserStatusSchema = z.object({
  status: z.enum(["active", "warned", "suspended"]),
  trustScore: z.coerce.number().int().min(0).max(100).optional(),
  fraudStrikeCount: z.coerce.number().int().min(0).max(10).optional(),
  reason: z.string().trim().min(4).max(500),
});

export type AuthSignupInput = z.infer<typeof authSignupSchema>;
export type AuthLoginInput = z.infer<typeof authLoginSchema>;
export type BillingRecoveryPortalInput = z.infer<typeof billingRecoveryPortalSchema>;
export type AuthSupabaseSessionInput = z.infer<typeof authSupabaseSessionSchema>;
export type PasswordResetCompleteInput = z.infer<typeof passwordResetCompleteSchema>;
export type LogoutAllInput = z.infer<typeof logoutAllSchema>;
export type LegalAcceptanceInput = z.infer<typeof legalAcceptanceSchema>;
export type VerificationInput = z.infer<typeof verificationSchema>;
export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>;
export type ReviewSubmissionInput = z.infer<typeof reviewSubmissionSchema>;
export type EventTrackInput = z.infer<typeof eventTrackSchema>;
export type AccountPreferencesInput = z.infer<typeof accountPreferencesSchema>;
export type AccountPrivacySettingsInput = z.infer<typeof accountPrivacySettingsSchema>;
export type SaveItemInput = z.infer<typeof saveItemSchema>;
export type RemoveSavedItemInput = z.infer<typeof removeSavedItemSchema>;
export type FeedbackInput = z.infer<typeof feedbackSchema>;
export type TrustWorkflowUpdateInput = z.infer<typeof trustWorkflowUpdateSchema>;
export type AccountDeletionRequestInput = z.infer<typeof accountDeletionRequestSchema>;
export type WrongPriceReportInput = z.infer<typeof wrongPriceReportSchema>;
export type VenueRequestInput = z.infer<typeof venueRequestSchema>;
export type VenueInterestInput = z.infer<typeof venueInterestSchema>;
export type VenueManagerAssignmentInput = z.infer<typeof venueManagerAssignmentSchema>;
export type VenueManagerRevokeInput = z.infer<typeof venueManagerRevokeSchema>;
export type VenueOutreachInput = z.infer<typeof venueOutreachSchema>;
export type VenueInterestStatusInput = z.infer<typeof venueInterestStatusSchema>;
export type VenuePortalQuery = z.infer<typeof venuePortalQuerySchema>;
export type VenueReconciliationQuery = z.infer<typeof venueReconciliationQuerySchema>;
export type BarProfileInput = z.infer<typeof barProfileSchema>;
export type BarBeerInput = z.infer<typeof barBeerSchema>;
export type BarBeerBulkInput = z.infer<typeof barBeerBulkSchema>;
export type BarHappyHourInput = z.infer<typeof barHappyHourSchema>;
export type BarSpecialInput = z.infer<typeof barSpecialSchema>;
export type BarClaimRequestInput = z.infer<typeof barClaimRequestSchema>;
export type BarPendingChangeReviewInput = z.infer<typeof barPendingChangeReviewSchema>;
export type VenueClaimRequestInput = z.infer<typeof venueClaimRequestSchema>;
export type VenueClaimReviewInput = z.infer<typeof venueClaimReviewSchema>;
export type VenuePendingChangeReviewInput = z.infer<typeof venuePendingChangeReviewSchema>;
export type AdminDashboardQuery = z.infer<typeof adminDashboardQuerySchema>;
export type AdminPaginationInput = z.infer<typeof adminPaginationSchema>;
export type BeerCatalogAdminQuery = z.infer<typeof beerCatalogAdminQuerySchema>;
export type AdminAccountSearchInput = z.infer<typeof adminAccountSearchSchema>;
export type MonthlyReportGenerateInput = z.infer<typeof monthlyReportGenerateSchema>;
export type MonthlyReportDeliveryInput = z.infer<typeof monthlyReportDeliverySchema>;
export type VenueReportDeliverySettingsInput = z.infer<typeof venueReportDeliverySettingsSchema>;
export type MonthlyReportExportQuery = z.infer<typeof monthlyReportExportQuerySchema>;
export type RetentionQuery = z.infer<typeof retentionQuerySchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type CheckoutSessionInput = z.infer<typeof checkoutSessionSchema>;
export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;
export type DisplayNameUpdateInput = z.infer<typeof displayNameUpdateSchema>;
export type PubGolfPlanInput = z.infer<typeof pubGolfPlanSchema>;
export type LeaderboardPrizeCampaignInput = z.infer<typeof leaderboardPrizeCampaignSchema>;
export type LeaderboardPrizeFinalizeInput = z.infer<typeof leaderboardPrizeFinalizeSchema>;
export type RewardVoucherTransitionInput = z.infer<typeof rewardVoucherTransitionSchema>;
export type DiscountRedemptionInput = z.infer<typeof discountRedemptionSchema>;
export type PintPointMemberPreviewInput = z.infer<typeof pintPointMemberPreviewSchema>;
export type PintPointDrinkRecordInput = z.infer<typeof pintPointDrinkRecordSchema>;
export type PintPointDrinkVoidInput = z.infer<typeof pintPointDrinkVoidSchema>;
export type VenueCounterStaffAssignmentInput = z.infer<typeof venueCounterStaffAssignmentSchema>;
export type VenueCounterStaffInvitationResponseInput = z.infer<typeof venueCounterStaffInvitationResponseSchema>;
export type FreePintRewardCodeInput = z.infer<typeof freePintRewardCodeSchema>;
export type FreePintRewardDecisionInput = z.infer<typeof freePintRewardDecisionSchema>;
export type PosDiscountRedemptionInput = z.infer<typeof posDiscountRedemptionSchema>;
export type BarTierCheckoutInput = z.infer<typeof barTierCheckoutSchema>;
export type PriceRecordsQuery = z.infer<typeof priceRecordsQuerySchema>;
