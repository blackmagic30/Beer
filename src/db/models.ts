export type BeerAvailabilityStatus = "on_tap" | "package_only" | "unavailable" | "unknown";
export type BeerUnavailableReason =
  | "cans_only"
  | "bottles_only"
  | "cans_or_bottles"
  | "no_pints"
  | "not_on_tap"
  | "not_stocked"
  | "unknown"
  | null;

export type AdminIngestionStatus =
  | "pending_review"
  | "publishing"
  | "rejecting"
  | "published"
  | "rejected"
  | "failed";

export type AdminIngestionSourceType = "menu_photo_upload" | "source_image_url" | "source_reference";

export interface AdminIngestionBeerRecord {
  name: string;
  servingSize: "pint";
  priceNumeric: number | null;
  priceText: string | null;
  availabilityStatus: BeerAvailabilityStatus;
  availableOnTap: boolean | null;
  availablePackageOnly: boolean;
  unavailableReason: BeerUnavailableReason;
  confidence: number;
  needsReview: boolean;
  notes: string | null;
}

export interface AdminIngestionCrawlerFeedback {
  outcome: "published" | "rejected";
  rewardScore: number;
  acceptedRowCount: number;
  extractedRowCount: number;
  rejectedRowCount: number;
  correctedRowCount: number;
  cleanRowCount: number;
  note: string | null;
  generatedAt: string;
  signals: string[];
}

export interface AdminIngestionQueueRecord {
  id: string;
  venueId: string;
  venueName: string;
  sourceType: AdminIngestionSourceType;
  sourceUrl: string | null;
  imageDataUrl: string | null;
  hasImageData: boolean;
  imageRetentionExpiresAt: string | null;
  imageRedactedAt: string | null;
  imageRedactionReason: string | null;
  note: string | null;
  status: AdminIngestionStatus;
  venueNameGuess: string | null;
  capturedNotes: string | null;
  overallConfidence: number | null;
  extractedBeers: AdminIngestionBeerRecord[];
  reviewBeers: AdminIngestionBeerRecord[] | null;
  crawlerFeedback: AdminIngestionCrawlerFeedback | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  rejectedAt: string | null;
}
