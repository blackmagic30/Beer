export const PREMIUM_PRICING = {
  monthlyAudCents: 499,
  yearlyAudCents: 5000,
  monthlyLabel: "A$4.99/month",
  yearlyLabel: "A$50/year",
} as const;

export const CONTRIBUTION_POINTS = {
  veryFreshUpdate: 0.1,
  weekOldUpdate: 0.5,
  staleUpdate: 1,
  newVenue: 5,
  locationRadiusMeters: 200,
  maxLocationAccuracyMeters: 100,
  locationMaxAgeHours: 12,
  veryFreshHours: 24,
  weekOldDays: 7,
} as const;

export const SUBMISSION_LIMITS = {
  maxPhotoBytes: 6 * 1024 * 1024,
  allowedImageMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
} as const;

export const RESPONSIBLE_ALCOHOL_COPY = {
  footer:
    "Pint Path is for adults 18+ in Victoria. Prices can change, availability is not guaranteed, and venues may refuse service under RSA obligations. Drink responsibly.",
} as const;
