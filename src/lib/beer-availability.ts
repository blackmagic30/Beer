import type { BeerAvailabilityStatus, BeerUnavailableReason } from "../db/models.js";

export interface BeerAvailabilityDetails {
  availabilityStatus: BeerAvailabilityStatus;
  availableOnTap: boolean | null;
  availablePackageOnly: boolean;
  unavailableReason: BeerUnavailableReason;
}

const CANS_ONLY_REGEX =
  /\b(?:only got (?:the )?(?:big )?cans?|only have (?:the )?(?:big )?cans?|(?:just |only )?do(?: it)? (?:like )?(?:on|in)? ?(?:the )?(?:big )?cans?|cans? only|only in cans?)\b/i;
const BOTTLES_ONLY_REGEX =
  /\b(?:only got bottles?|only have bottles?|(?:just |only )?do(?: it)? (?:on|in)? ?(?:the )?bottles?|bottles? only|only in bottles?)\b/i;
const NOT_ON_TAP_REGEX =
  /\b(?:don't have(?: [^.!?\n]{0,24})? on tap|dont have(?: [^.!?\n]{0,24})? on tap|do not have(?: [^.!?\n]{0,24})? on tap|not on tap|don't do(?: pints?)?|dont do(?: pints?)?|do not do(?: pints?)?|no pints? of)\b/i;
const NOT_STOCKED_REGEX =
  /\b(?:don't have|dont have|don't sell|dont sell|do not have|do not sell|unavailable|not available|out of stock)\b/i;

export function inferBeerAvailability(input: {
  evidence: string | null;
  priceNumeric: number | null;
  isUnavailable: boolean;
}): BeerAvailabilityDetails {
  const evidence = input.evidence ?? "";

  if (input.isUnavailable) {
    if (CANS_ONLY_REGEX.test(evidence)) {
      return {
        availabilityStatus: "package_only",
        availableOnTap: false,
        availablePackageOnly: true,
        unavailableReason: "cans_only",
      };
    }

    if (BOTTLES_ONLY_REGEX.test(evidence)) {
      return {
        availabilityStatus: "package_only",
        availableOnTap: false,
        availablePackageOnly: true,
        unavailableReason: "bottles_only",
      };
    }

    if (NOT_ON_TAP_REGEX.test(evidence)) {
      return {
        availabilityStatus: "unavailable",
        availableOnTap: false,
        availablePackageOnly: false,
        unavailableReason: "not_on_tap",
      };
    }

    return {
      availabilityStatus: "unavailable",
      availableOnTap: false,
      availablePackageOnly: false,
      unavailableReason: NOT_STOCKED_REGEX.test(evidence) ? "not_stocked" : "unknown",
    };
  }

  if (input.priceNumeric !== null) {
    return {
      availabilityStatus: "on_tap",
      availableOnTap: true,
      availablePackageOnly: false,
      unavailableReason: null,
    };
  }

  return {
    availabilityStatus: "unknown",
    availableOnTap: null,
    availablePackageOnly: false,
    unavailableReason: null,
  };
}

export function formatBeerAvailabilityLabel(input: {
  availabilityStatus: BeerAvailabilityStatus;
  unavailableReason: BeerUnavailableReason;
}): string {
  if (input.availabilityStatus === "on_tap") {
    return "On tap";
  }

  if (input.availabilityStatus === "package_only") {
    if (input.unavailableReason === "bottles_only") {
      return "Bottles only";
    }

    return "Cans only";
  }

  if (input.availabilityStatus === "unavailable") {
    if (input.unavailableReason === "not_on_tap") {
      return "Not on tap";
    }

    return "Unavailable";
  }

  return "Unknown";
}
