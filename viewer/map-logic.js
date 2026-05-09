(function attachMelbourneBeerMapLogic(root) {
  const UNKNOWN_PRICE_TEXT = "Price unknown";
  const UNAVAILABLE_LABELS = new Set(["Unavailable", "Not on tap", "No pints"]);
  const PACKAGE_LABELS = new Set(["Cans only", "Bottles only"]);

  function normalizePositivePrice(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }

  function normalizeBeerPriceNumeric(source) {
    const availabilityStatus =
      source && typeof source.availability_status === "string"
        ? source.availability_status
        : "unknown";
    const numeric = normalizePositivePrice(source ? (source.price_numeric ?? source.price) : null);

    return availabilityStatus === "on_tap" ? numeric : null;
  }

  function getAvailabilityLabel(source = {}) {
    const availability = source && typeof source.availability === "object"
      ? source.availability
      : null;

    if (availability && availability.label) {
      return availability.label;
    }

    switch (source.availability_status) {
      case "on_tap":
        return "On tap";
      case "package_only":
        return source.unavailable_reason === "bottles_only" ? "Bottles only" : "Cans only";
      case "unavailable":
        if (source.unavailable_reason === "no_pints") {
          return "No pints";
        }

        return source.unavailable_reason === "not_on_tap" ? "Not on tap" : "Unavailable";
      default:
        return "Unknown";
    }
  }

  function getBeerPriceText(source, availabilityLabel, priceNumeric) {
    const explicitText =
      source && typeof source.price_text === "string" && source.price_text.trim().length > 0
        ? source.price_text.trim()
        : null;
    const explicitLooksUnknown = explicitText
      ? /^(?:price\s*)?(?:unknown|unavailable|not\s+available|n\/a)$/i.test(explicitText.replace(/\s+/g, " "))
      : false;

    if (priceNumeric !== null) {
      return explicitText && explicitText !== "$0"
        ? explicitText
        : `$${String(Number(priceNumeric).toFixed(2)).replace(/\.00$/, "")}`;
    }

    if (UNAVAILABLE_LABELS.has(availabilityLabel) || PACKAGE_LABELS.has(availabilityLabel)) {
      return availabilityLabel;
    }

    if (
      explicitText &&
      explicitText !== "$0" &&
      !explicitLooksUnknown &&
      !/^0(?:\.0+)?$/.test(explicitText.replace(/[$,\s]/g, ""))
    ) {
      return explicitText;
    }

    return UNKNOWN_PRICE_TEXT;
  }

  function getAvailabilityTone(availabilityLabel) {
    switch (availabilityLabel) {
      case "On tap":
        return {
          background: "#dcfce7",
          color: "#166534",
        };
      case "Cans only":
      case "Bottles only":
      case "No pints":
      case "Not on tap":
        return {
          background: "#fef3c7",
          color: "#92400e",
        };
      case "Unavailable":
        return {
          background: "#fee2e2",
          color: "#991b1b",
        };
      default:
        return {
          background: "#e2e8f0",
          color: "#334155",
        };
    }
  }

  function hasNumericPrice(beer) {
    const numeric = Number(beer && beer.priceNumeric);
    return Number.isFinite(numeric) && numeric > 0;
  }

  function getLowestKnownPrice(beers) {
    return (Array.isArray(beers) ? beers : [])
      .filter(hasNumericPrice)
      .reduce((lowest, beer) => lowest === null ? beer.priceNumeric : Math.min(lowest, beer.priceNumeric), null);
  }

  function getPriceTier(beer) {
    if (!hasNumericPrice(beer)) {
      return "unknown";
    }

    if (beer.priceNumeric <= 12) {
      return "cheap";
    }

    if (beer.priceNumeric <= 15) {
      return "mid";
    }

    if (beer.priceNumeric <= 17) {
      return "high";
    }

    return "expensive";
  }

  function getMarkerColor(beer) {
    if (!beer) {
      return "#64748b";
    }

    if (UNAVAILABLE_LABELS.has(beer.availabilityLabel)) {
      return "#b91c1c";
    }

    if (PACKAGE_LABELS.has(beer.availabilityLabel)) {
      return "#c2410c";
    }

    switch (getPriceTier(beer)) {
      case "cheap":
        return "#15803d";
      case "mid":
        return "#0f766e";
      case "high":
        return "#b45309";
      case "expensive":
        return "#b91c1c";
      default:
        return "#64748b";
    }
  }

  function getMarkerLabel(beer) {
    if (!beer) {
      return "?";
    }

    if (hasNumericPrice(beer)) {
      return String(Number(beer.priceNumeric).toFixed(1)).replace(/\.0$/, "");
    }

    if (beer.availabilityLabel === "Cans only") {
      return "CAN";
    }

    if (beer.availabilityLabel === "Bottles only") {
      return "BTL";
    }

    if (beer.availabilityLabel === "No pints") {
      return "NOP";
    }

    if (UNAVAILABLE_LABELS.has(beer.availabilityLabel)) {
      return "NO";
    }

    return "?";
  }

  function getMarkerScale(beer) {
    return hasNumericPrice(beer) ? 17 : 14;
  }

  function isUnderPriceThreshold(beers, threshold) {
    const lowest = getLowestKnownPrice(beers);
    return lowest !== null && lowest < threshold;
  }

  root.MelbBeerMapLogic = Object.freeze({
    UNKNOWN_PRICE_TEXT,
    normalizeBeerPriceNumeric,
    getAvailabilityLabel,
    getBeerPriceText,
    getAvailabilityTone,
    hasNumericPrice,
    getLowestKnownPrice,
    getPriceTier,
    getMarkerColor,
    getMarkerLabel,
    getMarkerScale,
    isUnderPriceThreshold,
  });
})(typeof window !== "undefined" ? window : globalThis);
