import type { BeerAvailabilityStatus, BeerUnavailableReason } from "../db/models.js";

export interface BeerAvailabilityDetails {
  availabilityStatus: BeerAvailabilityStatus;
  availableOnTap: boolean | null;
  availablePackageOnly: boolean;
  unavailableReason: BeerUnavailableReason;
}

const SMALL_TAP_POUR_PATTERN = "(?:schooners?|pots?|midd(?:y|ies)|halves?)";
const CANS_ONLY_REGEX =
  /\b(?:only got (?:the )?(?:big )?cans?|only have (?:the )?(?:big )?cans?|(?:just |only )?do(?: it)? (?:like )?(?:on|in)? ?(?:the )?(?:big )?cans?|cans? only|only in cans?|only cans?)\b/i;
const BOTTLES_ONLY_REGEX =
  /\b(?:only got bottles?|only have bottles?|(?:just |only )?do(?: it)? (?:on|in)? ?(?:the )?bottles?|bottles? only|only in bottles?|only bottles?)\b/i;
const NO_PINTS_REGEX = new RegExp(
  `\\b(?:don't do(?: [^.!?\\n]{0,24})?pints?|dont do(?: [^.!?\\n]{0,24})?pints?|do not do(?: [^.!?\\n]{0,24})?pints?|no pints?(?: of)?|${SMALL_TAP_POUR_PATTERN} only|only (?:do|have|serve)(?: [^.!?\\n]{0,18})?${SMALL_TAP_POUR_PATTERN}|just (?:do|have|serve)(?: [^.!?\\n]{0,18})?${SMALL_TAP_POUR_PATTERN}|only in ${SMALL_TAP_POUR_PATTERN})\\b`,
  "i",
);
const NOT_ON_TAP_REGEX =
  /\b(?:don't have(?: [^.!?\n]{0,24})? on tap|dont have(?: [^.!?\n]{0,24})? on tap|do not have(?: [^.!?\n]{0,24})? on tap|not on tap)\b/i;
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

    if (NO_PINTS_REGEX.test(evidence)) {
      return {
        availabilityStatus: "unavailable",
        availableOnTap: true,
        availablePackageOnly: false,
        unavailableReason: "no_pints",
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
    if (input.unavailableReason === "no_pints") {
      return "No pints";
    }

    if (input.unavailableReason === "not_on_tap") {
      return "Not on tap";
    }

    return "Unavailable";
  }

  return "Unknown";
}
