import { z } from "zod";

const beerAvailabilityStatusSchema = z.enum(["on_tap", "package_only", "unavailable", "unknown"]);
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

export const adminVenueSchema = z.object({
  name: z.string().trim().min(1),
  address: z.string().trim().min(1),
  suburb: optionalTrimmedStringSchema.nullable().default(null),
  state: optionalTrimmedStringSchema.nullable().default("VIC"),
  postcode: optionalTrimmedStringSchema.nullable().default(null),
  phone: optionalTrimmedStringSchema.nullable().default(null),
  website: optionalTrimmedStringSchema.nullable().default(null),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});

export const adminBeerInputSchema = z.object({
  name: z.string().trim().min(1),
  priceNumeric: nullableNumberSchema.default(null),
  priceText: nullableTrimmedStringSchema.default(null),
  availabilityStatus: beerAvailabilityStatusSchema.default("on_tap"),
  availableOnTap: z.boolean().nullable().default(true),
  availablePackageOnly: z.boolean().default(false),
  unavailableReason: beerUnavailableReasonSchema.default(null),
  needsReview: z.boolean().default(false),
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
