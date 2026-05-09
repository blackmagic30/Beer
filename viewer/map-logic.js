(function attachMelbourneBeerMapLogic(root) {
  const UNKNOWN_PRICE_TEXT = "Price unknown";
  const UNAVAILABLE_LABELS = new Set(["Unavailable", "Not on tap", "No pints"]);
  const PACKAGE_LABELS = new Set(["Cans only", "Bottles only"]);
  const MARKER_STATE_STYLES = Object.freeze({
    cheap: {
      fillColor: "#15803d",
      strokeColor: "#052e16",
      labelColor: "#ffffff",
      labelText: null,
      scale: 17,
      fillOpacity: 0.96,
      strokeWeight: 2.2,
    },
    mid: {
      fillColor: "#d97706",
      strokeColor: "#451a03",
      labelColor: "#111827",
      labelText: null,
      scale: 17,
      fillOpacity: 0.95,
      strokeWeight: 2.2,
    },
    high: {
      fillColor: "#ea580c",
      strokeColor: "#431407",
      labelColor: "#ffffff",
      labelText: null,
      scale: 17,
      fillOpacity: 0.95,
      strokeWeight: 2.2,
    },
    expensive: {
      fillColor: "#b91c1c",
      strokeColor: "#450a0a",
      labelColor: "#ffffff",
      labelText: null,
      scale: 17,
      fillOpacity: 0.96,
      strokeWeight: 2.2,
    },
    unknown: {
      fillColor: "#475569",
      strokeColor: "#e2e8f0",
      labelColor: "#ffffff",
      labelText: "?",
      scale: 14,
      fillOpacity: 0.74,
      strokeWeight: 2.8,
    },
    needs_data: {
      fillColor: "#2563eb",
      strokeColor: "#bfdbfe",
      labelColor: "#ffffff",
      labelText: "",
      scale: 10,
      fillOpacity: 0.72,
      strokeWeight: 2.4,
    },
    mapped: {
      fillColor: "#334155",
      strokeColor: "#e2e8f0",
      labelColor: "#ffffff",
      labelText: "",
      scale: 9,
      fillOpacity: 0.9,
      strokeWeight: 1.6,
    },
    package_only: {
      fillColor: "#c2410c",
      strokeColor: "#431407",
      labelColor: "#ffffff",
      labelText: null,
      scale: 15,
      fillOpacity: 0.88,
      strokeWeight: 2.6,
    },
    unavailable: {
      fillColor: "#7f1d1d",
      strokeColor: "#fecaca",
      labelColor: "#ffffff",
      labelText: "NO",
      scale: 14,
      fillOpacity: 0.8,
      strokeWeight: 2.7,
    },
    locked: {
      fillColor: "#7c3aed",
      strokeColor: "#ddd6fe",
      labelColor: "#ffffff",
      labelText: "$",
      scale: 15,
      fillOpacity: 0.84,
      strokeWeight: 2.7,
    },
  });

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

  function getMarkerState(beer, options = {}) {
    if (options.needsData) {
      return "needs_data";
    }

    if (options.mappedOnly || !beer) {
      return "mapped";
    }

    if (options.locked) {
      return "locked";
    }

    if (UNAVAILABLE_LABELS.has(beer.availabilityLabel)) {
      return "unavailable";
    }

    if (PACKAGE_LABELS.has(beer.availabilityLabel)) {
      return "package_only";
    }

    return getPriceTier(beer);
  }

  function getMarkerVisual(beer, options = {}) {
    const state = getMarkerState(beer, options);
    const baseStyle = MARKER_STATE_STYLES[state] || MARKER_STATE_STYLES.unknown;
    const labelText = baseStyle.labelText === null ? getMarkerLabel(beer) : baseStyle.labelText;
    const visual = {
      state,
      fillColor: baseStyle.fillColor,
      fillOpacity: baseStyle.fillOpacity,
      strokeColor: baseStyle.strokeColor,
      strokeWeight: baseStyle.strokeWeight,
      scale: baseStyle.scale,
      labelColor: baseStyle.labelColor,
      labelText,
    };

    if (!options.selected) {
      return visual;
    }

    return {
      ...visual,
      state: `${state}_selected`,
      strokeColor: "#f5c76b",
      strokeWeight: Math.max(visual.strokeWeight + 1.7, 4),
      scale: visual.scale + 2.4,
      fillOpacity: Math.min(visual.fillOpacity + 0.06, 1),
      selected: true,
    };
  }

  function getMarkerColor(beer) {
    return getMarkerVisual(beer).fillColor;
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
    return getMarkerVisual(beer).scale;
  }

  function isUnderPriceThreshold(beers, threshold) {
    const lowest = getLowestKnownPrice(beers);
    return lowest !== null && lowest < threshold;
  }

  function getClusterVisual(count) {
    const numericCount = Number(count);
    const safeCount = Number.isFinite(numericCount) && numericCount > 0 ? numericCount : 1;

    if (safeCount >= 100) {
      return {
        fillColor: "#9f1239",
        strokeColor: "#fecdd3",
        labelColor: "#ffffff",
        scale: 28,
        fillOpacity: 0.9,
        strokeWeight: 4,
        fontSize: "12px",
      };
    }

    if (safeCount >= 25) {
      return {
        fillColor: "#b45309",
        strokeColor: "#fde68a",
        labelColor: "#111827",
        scale: 24,
        fillOpacity: 0.9,
        strokeWeight: 4,
        fontSize: "12px",
      };
    }

    if (safeCount >= 10) {
      return {
        fillColor: "#1d4ed8",
        strokeColor: "#bfdbfe",
        labelColor: "#ffffff",
        scale: 21,
        fillOpacity: 0.88,
        strokeWeight: 3.5,
        fontSize: "12px",
      };
    }

    return {
      fillColor: "#334155",
      strokeColor: "#e2e8f0",
      labelColor: "#ffffff",
      scale: 18,
      fillOpacity: 0.86,
      strokeWeight: 3,
      fontSize: "12px",
    };
  }

  root.MelbBeerMapLogic = Object.freeze({
    UNKNOWN_PRICE_TEXT,
    MARKER_STATE_STYLES,
    normalizeBeerPriceNumeric,
    getAvailabilityLabel,
    getBeerPriceText,
    getAvailabilityTone,
    hasNumericPrice,
    getLowestKnownPrice,
    getPriceTier,
    getMarkerState,
    getMarkerVisual,
    getMarkerColor,
    getMarkerLabel,
    getMarkerScale,
    getClusterVisual,
    isUnderPriceThreshold,
  });
})(typeof window !== "undefined" ? window : globalThis);
