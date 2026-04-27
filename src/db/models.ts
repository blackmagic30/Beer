import type { BeerName, TargetBeerKey } from "../constants/beers.js";

export type BeerAvailabilityStatus = "on_tap" | "package_only" | "unavailable" | "unknown";
export type BeerUnavailableReason =
  | "cans_only"
  | "bottles_only"
  | "no_pints"
  | "not_on_tap"
  | "not_stocked"
  | "unknown"
  | null;

export interface CallSessionRecord {
  sessionId: string;
  conversationId: string | null;
  callSid: string | null;
  venueName: string;
  phoneNumber: string;
  suburb: string;
  callStatus: string;
  transcriptStatus: string;
  requestedAt: string;
  updatedAt: string;
  transcriptReceivedAt: string | null;
  rawTranscript: string | null;
  notes: string | null;
}

export interface NewCallSessionRecord {
  sessionId: string;
  venueName: string;
  phoneNumber: string;
  suburb: string;
  callStatus: string;
  requestedAt: string;
  updatedAt: string;
}

export interface UpsertWebhookSessionInput {
  sessionId: string;
  venueName: string;
  phoneNumber: string;
  suburb: string;
  callSid: string | null;
  conversationId: string | null;
  callStatus: string;
  rawTranscript: string | null;
  requestedAt: string;
  updatedAt: string;
  transcriptReceivedAt: string | null;
  notes: string | null;
}

export interface PersistedBeerPriceResultInput {
  beerName: BeerName;
  priceText: string | null;
  priceNumeric: number | null;
  confidence: number;
  needsReview: boolean;
  availabilityStatus: BeerAvailabilityStatus;
  availableOnTap: boolean | null;
  availablePackageOnly: boolean;
  unavailableReason: BeerUnavailableReason;
}

export interface PersistedHappyHourInput {
  happyHour: boolean;
  happyHourDays: string | null;
  happyHourStart: string | null;
  happyHourEnd: string | null;
  happyHourPrice: number | null;
  happyHourConfidence: number;
}

export type CallStatus =
  | "queued"
  | "ringing"
  | "in-progress"
  | "completed"
  | "failed"
  | "no-answer"
  | "busy"
  | "canceled";

export type ParseStatus = "pending" | "parsed" | "partial" | "needs_review" | "failed";

export interface CallRunRecord {
  id: string;
  callSid: string | null;
  conversationId: string | null;
  venueId: string | null;
  requestedBeer: TargetBeerKey | null;
  venueName: string;
  phoneNumber: string;
  suburb: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  callStatus: CallStatus;
  rawTranscript: string | null;
  parseConfidence: number | null;
  parseStatus: ParseStatus;
  errorMessage: string | null;
  isTest: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NewCallRunInput {
  id: string;
  venueId: string | null;
  requestedBeer: TargetBeerKey;
  venueName: string;
  phoneNumber: string;
  suburb: string;
  startedAt: string;
  callStatus: CallStatus;
  parseStatus: ParseStatus;
  isTest: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CallRunsFilters {
  callSid?: string | undefined;
  venueName?: string | undefined;
  suburb?: string | undefined;
  testMode?: boolean | undefined;
  limit: number;
}

export interface BeerPriceResultRecord {
  id: number;
  venueId: string | null;
  venueName: string;
  phoneNumber: string;
  suburb: string;
  beerName: BeerName;
  priceText: string | null;
  priceNumeric: number | null;
  availabilityStatus: BeerAvailabilityStatus;
  availableOnTap: boolean | null;
  availablePackageOnly: boolean;
  unavailableReason: BeerUnavailableReason;
  timestamp: string;
  rawTranscript: string;
  confidence: number;
  happyHour: boolean;
  happyHourDays: string | null;
  happyHourStart: string | null;
  happyHourEnd: string | null;
  happyHourPrice: number | null;
  happyHourConfidence: number;
  callSid: string;
  conversationId: string | null;
  needsReview: boolean;
  createdAt: string;
}

export interface ResultFilters {
  callSid?: string | undefined;
  venueName?: string | undefined;
  suburb?: string | undefined;
  needsReview?: boolean | undefined;
  testMode?: boolean | undefined;
  limit: number;
}

export type AdminIngestionStatus = "pending_review" | "published" | "rejected" | "failed";

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

export interface AdminIngestionQueueRecord {
  id: string;
  venueId: string;
  venueName: string;
  sourceType: AdminIngestionSourceType;
  sourceUrl: string | null;
  imageDataUrl: string | null;
  note: string | null;
  status: AdminIngestionStatus;
  venueNameGuess: string | null;
  capturedNotes: string | null;
  overallConfidence: number | null;
  extractedBeers: AdminIngestionBeerRecord[];
  reviewBeers: AdminIngestionBeerRecord[] | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  rejectedAt: string | null;
}
