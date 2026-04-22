import { z } from "zod";

const beerAvailabilityStatusSchema = z.enum(["on_tap", "package_only", "unavailable", "unknown"]);
const beerServingSizeSchema = z.enum(["pint"]);
const beerUnavailableReasonSchema = z.enum([
  "cans_only",
  "bottles_only",
  "not_on_tap",
  "not_stocked",
  "unknown",
]).nullable();

const optionalTrimmedStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().min(1).optional());

const nullableTrimmedStringSchema = z.preprocess((value) => {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}, z.string().min(1).nullable());

const nullableNumberSchema = z.preprocess((value) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = Number(value.trim());
    return Number.isNaN(normalized) ? value : normalized;
  }

  return value;
}, z.number().nonnegative().nullable());

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function titleCaseWords(value: string): string {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

const optionalWebsiteSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = collapseWhitespace(value);
  if (!trimmed) {
    return undefined;
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}, z.string().url().optional());

const optionalPostcodeSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}, z.string().regex(/^\d{4}$/, "Postcode must be four digits").optional());

export const adminVenueSchema = z.object({
  name: z.string().trim().min(1).transform(collapseWhitespace),
  address: z.string().trim().min(1).transform(collapseWhitespace),
  suburb: z.preprocess((value) => {
    if (typeof value !== "string") {
      return value;
    }

    const normalized = collapseWhitespace(value);
    return normalized.length > 0 ? titleCaseWords(normalized) : undefined;
  }, z.string().min(1).optional()).nullable().default(null),
  state: z.preprocess((value) => {
    if (typeof value !== "string") {
      return value;
    }

    const normalized = collapseWhitespace(value).toUpperCase();
    return normalized.length > 0 ? normalized : undefined;
  }, z.string().regex(/^[A-Z]{2,4}$/).optional()).nullable().default("VIC"),
  postcode: optionalPostcodeSchema.nullable().default(null),
  phone: z.preprocess((value) => {
    if (typeof value !== "string") {
      return value;
    }

    const normalized = collapseWhitespace(value);
    return normalized.length > 0 ? normalized : undefined;
  }, z.string().min(6).optional()).nullable().default(null),
  website: optionalWebsiteSchema.nullable().default(null),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});

export const adminBeerInputSchema = z.object({
  name: z.string().trim().min(1).transform(collapseWhitespace),
  servingSize: beerServingSizeSchema.default("pint"),
  priceNumeric: nullableNumberSchema.default(null),
  priceText: nullableTrimmedStringSchema.default(null),
  availabilityStatus: beerAvailabilityStatusSchema.default("on_tap"),
  availableOnTap: z.boolean().nullable().default(true),
  availablePackageOnly: z.boolean().default(false),
  unavailableReason: beerUnavailableReasonSchema.default(null),
  needsReview: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.availabilityStatus === "on_tap" && value.priceNumeric === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "On-tap beers must include the pint price.",
      path: ["priceNumeric"],
    });
  }
});

export const adminManualCaptureSchema = z.object({
  venueId: z.string().uuid(),
  source: z.enum(["manual_entry", "menu_photo_ocr"]).default("manual_entry"),
  note: nullableTrimmedStringSchema.default(null),
  beers: z.array(adminBeerInputSchema).min(1),
});

export const adminMenuPhotoOcrSchema = z.object({
  venueNameHint: nullableTrimmedStringSchema.default(null),
  imageDataUrl: z.string().regex(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "imageDataUrl must be a base64 data URL"),
});

export type AdminVenueInput = z.infer<typeof adminVenueSchema>;
export type AdminBeerInput = z.infer<typeof adminBeerInputSchema>;
export type AdminManualCaptureInput = z.infer<typeof adminManualCaptureSchema>;
export type AdminMenuPhotoOcrInput = z.infer<typeof adminMenuPhotoOcrSchema>;
