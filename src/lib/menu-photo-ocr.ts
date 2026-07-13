import type { BeerAvailabilityStatus, BeerUnavailableReason } from "../db/models.js";

export interface MenuPhotoOcrBeer {
  name: string;
  brewery: string | null;
  abv: number | null;
  servingSize: "pint";
  priceNumeric: number | null;
  priceText: string | null;
  availabilityStatus: BeerAvailabilityStatus;
  availableOnTap: boolean | null;
  availablePackageOnly: boolean;
  unavailableReason: BeerUnavailableReason;
  needsReview: boolean;
  confidence: number;
  notes: string | null;
  sourceText: string | null;
}

export interface MenuPhotoOcrResult {
  model: string;
  imageCount: number;
  venueNameGuess: string | null;
  capturedNotes: string | null;
  overallConfidence: number | null;
  rejectedCandidateCount: number;
  beers: MenuPhotoOcrBeer[];
}

export interface MenuPhotoOcrProcessor {
  extract(input: {
    venueNameHint: string | null;
    imageDataUrls: string[];
    documentDataUrls?: string[];
  }): Promise<MenuPhotoOcrResult>;
}
