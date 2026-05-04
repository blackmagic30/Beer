export const PREMIUM_PRICING = {
  monthlyAudCents: 199,
  yearlyAudCents: 1900,
  monthlyLabel: "A$1.99/month",
  yearlyLabel: "A$19/year",
} as const;

export const CONTRIBUTION_POINTS = {
  recentConfirmation: 1,
  stalePriceUpdate: 2,
  menuPhoto: 3,
  happyHourWithSource: 4,
  fullVenueUpdate: 5,
} as const;

export const SUBMISSION_LIMITS = {
  maxPhotoBytes: 6 * 1024 * 1024,
  allowedImageMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
} as const;

export const RESPONSIBLE_ALCOHOL_COPY = {
  footer:
    "Melbourne Beer Map is for adults 18+ in Victoria. Prices can change, availability is not guaranteed, and venues may refuse service under RSA obligations. Drink responsibly.",
  rewardsDisabled:
    "Partner venue credit is planned for a future release and is not live in this demo.",
} as const;

