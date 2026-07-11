(function attachMelbourneBeerMapLogic(root) {
  const UNKNOWN_PRICE_TEXT = "Price unknown";
  const UNAVAILABLE_LABELS = new Set(["Unavailable", "Not on tap", "No pints"]);
  const PACKAGE_LABELS = new Set(["Cans or bottles", "Cans only", "Bottles only"]);
  const PRICE_RING_COLORS = Object.freeze({
    cheap: "#16a34a",
    mid: "#facc15",
    high: "#ea580c",
    expensive: "#7f1d1d",
  });
  const MARKER_STATE_STYLES = Object.freeze({
    cheap: {
      fillColor: "#22d3ee",
      strokeColor: "#155e75",
      labelColor: "#06101f",
      labelText: null,
      scale: 17,
      fillOpacity: 0.96,
      strokeWeight: 2.2,
    },
    mid: {
      fillColor: "#a3e635",
      strokeColor: "#4d7c0f",
      labelColor: "#08110a",
      labelText: null,
      scale: 17,
      fillOpacity: 0.95,
      strokeWeight: 2.2,
    },
    high: {
      fillColor: "#f5c542",
      strokeColor: "#92400e",
      labelColor: "#111827",
      labelText: null,
      scale: 17,
      fillOpacity: 0.95,
      strokeWeight: 2.2,
    },
    expensive: {
      fillColor: "#d946ef",
      strokeColor: "#701a75",
      labelColor: "#ffffff",
      labelText: null,
      scale: 17,
      fillOpacity: 0.96,
      strokeWeight: 2.2,
    },
    unknown: {
      fillColor: "#64748b",
      strokeColor: "#cbd5e1",
      labelColor: "#ffffff",
      labelText: "?",
      scale: 14,
      fillOpacity: 0.74,
      strokeWeight: 2.8,
    },
    needs_data: {
      fillColor: "#475569",
      strokeColor: "#f8fafc",
      labelColor: "#ffffff",
      labelText: "?",
      scale: 10.5,
      fillOpacity: 0.46,
      strokeWeight: 2.7,
    },
    mapped: {
      fillColor: "#2563eb",
      strokeColor: "#bfdbfe",
      labelColor: "#ffffff",
      labelText: "✓",
      scale: 13,
      fillOpacity: 0.92,
      strokeWeight: 2.4,
    },
    package_only: {
      fillColor: "#8b5cf6",
      strokeColor: "#ddd6fe",
      labelColor: "#ffffff",
      labelText: null,
      scale: 15,
      fillOpacity: 0.88,
      strokeWeight: 2.6,
    },
    unavailable: {
      fillColor: "#ef4444",
      strokeColor: "#fecaca",
      labelColor: "#ffffff",
      labelText: "NO",
      scale: 14,
      fillOpacity: 0.8,
      strokeWeight: 2.7,
    },
    locked: {
      fillColor: "#8b5cf6",
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

  function normalizeSearchKey(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function normalizeHappyHourBeerItems(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item) => ({
        beerId: item.beerId || item.beer_id || null,
        beerName: item.beerName || item.beer_name || item.label || "",
        normalizedBeerId: item.normalizedBeerId || item.normalized_beer_id || null,
        servingSize: item.servingSize || item.serving_size || null,
        happyHourPrice: normalizePositivePrice(
          item.happyHourPrice ?? item.happy_hour_price ?? item.offerPrice ?? item.offer_price,
        ),
        offerText: typeof (item.offerText ?? item.offer_text) === "string"
          ? String(item.offerText ?? item.offer_text).trim() || null
          : null,
        onTap: Boolean(item.onTap ?? item.on_tap ?? item.available_on_tap),
        inStock: item.inStock == null && item.in_stock == null ? true : Boolean(item.inStock ?? item.in_stock),
      }))
      .filter((item) => String(item.beerName || "").trim().length > 0);
  }

  function beerCandidatesMatchSearch(candidates, beerQuery, options = {}) {
    const queryKey = normalizeSearchKey(beerQuery);
    if (!queryKey) {
      return false;
    }

    const getTrackedBeerMeta = typeof options.getTrackedBeerMeta === "function"
      ? options.getTrackedBeerMeta
      : null;
    const queryBeer = getTrackedBeerMeta ? getTrackedBeerMeta(beerQuery) : null;
    const queryBeerKey = queryBeer ? normalizeSearchKey(queryBeer.key || queryBeer.name) : "";
    const queryIdentityKeys = new Set(
      queryBeer
        ? [queryBeer.key, queryBeer.name, ...(queryBeer.aliases || [])]
            .map(normalizeSearchKey)
            .filter(Boolean)
        : [queryKey],
    );

    return (Array.isArray(candidates) ? candidates : []).some((candidate) => {
      const candidateKey = normalizeSearchKey(candidate);
      if (!candidateKey) {
        return false;
      }
      if (candidateKey === queryKey) {
        return true;
      }
      if (!queryBeer || !getTrackedBeerMeta) {
        return false;
      }

      const candidateBeer = getTrackedBeerMeta(candidate);
      if (candidateBeer) {
        return normalizeSearchKey(candidateBeer.key || candidateBeer.name) === queryBeerKey;
      }
      return queryIdentityKeys.has(candidateKey);
    });
  }

  function happyHourBeerMatchesSearch(item, beerQuery, options = {}) {
    const queryKey = normalizeSearchKey(beerQuery);
    if (!item || !queryKey) {
      return false;
    }

    if (options.onTapOnly && !item.onTap) {
      return false;
    }

    const getTrackedBeerMeta = typeof options.getTrackedBeerMeta === "function"
      ? options.getTrackedBeerMeta
      : null;
    const trackedBeer = getTrackedBeerMeta
      ? getTrackedBeerMeta(item.beerName) || getTrackedBeerMeta(item.normalizedBeerId)
      : null;
    const candidates = [
      item.beerName,
      item.normalizedBeerId,
      item.beerId,
      trackedBeer && trackedBeer.key,
      trackedBeer && trackedBeer.name,
      ...((trackedBeer && trackedBeer.aliases) || []),
    ].filter(Boolean);

    return beerCandidatesMatchSearch(candidates, queryKey, { getTrackedBeerMeta });
  }

  function happyHourTextMatchesBeer(details, beerQuery) {
    const queryKey = normalizeSearchKey(beerQuery);
    if (!details || !queryKey) {
      return false;
    }

    return [
      details.title,
      details.specials,
      details.summary,
      details.when,
    ].some((value) => {
      const candidateKey = normalizeSearchKey(value);
      return candidateKey && (candidateKey.includes(queryKey) || queryKey.includes(candidateKey));
    });
  }

  function resolveHappyHourDetails(row, options = {}) {
    if (typeof options.getHappyHourDetails === "function") {
      return options.getHappyHourDetails(row);
    }

    return row && typeof row === "object"
      ? row.happyHourDetails || row.happy_hour_details || row
      : null;
  }

  function happyHourMatchesBeerQuery(row, beerQuery, options = {}) {
    const queryKey = normalizeSearchKey(beerQuery);
    if (!queryKey) {
      return true;
    }

    const details = resolveHappyHourDetails(row, options);
    if (!details || details.exists === false) {
      return false;
    }

    const selectedBeers = normalizeHappyHourBeerItems(
      details.happyHourBeers ||
      details.happy_hour_beers ||
      details.selectedBeers ||
      details.selected_beers ||
      details.beers,
    );
    if (selectedBeers.length > 0) {
      return selectedBeers.some((item) => happyHourBeerMatchesSearch(item, queryKey, options));
    }

    return happyHourTextMatchesBeer(details, queryKey);
  }

  const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const DAY_ALIASES = Object.freeze({
    sunday: "sun", sun: "sun",
    monday: "mon", mon: "mon",
    tuesday: "tue", tues: "tue", tue: "tue",
    wednesday: "wed", weds: "wed", wed: "wed",
    thursday: "thu", thurs: "thu", thu: "thu",
    friday: "fri", fri: "fri",
    saturday: "sat", sat: "sat",
  });

  function happyHourTimeToMinutes(value) {
    const match = String(value || "").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const meridiem = match[3];
    if (meridiem && (hour < 1 || hour > 12)) return null;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
  }

  function parseHappyHourDays(value) {
    const values = Array.isArray(value) ? value : [value];
    const text = values.filter(Boolean).join(" ").toLowerCase();
    if (!text.trim()) return new Set();
    if (/\b(?:daily|every\s*day|everyday|all\s*week)\b/.test(text)) return new Set(DAY_KEYS);
    if (/\bweekdays?\b/.test(text)) return new Set(["mon", "tue", "wed", "thu", "fri"]);
    if (/\bweekends?\b/.test(text)) return new Set(["sat", "sun"]);

    const days = new Set();
    const rangePattern = /\b(sun(?:day)?|mon(?:day)?|tue(?:sday|s)?|wed(?:nesday|s)?|thu(?:rsday|rs)?|fri(?:day)?|sat(?:urday)?)\s*(?:-|–|—|to)\s*(sun(?:day)?|mon(?:day)?|tue(?:sday|s)?|wed(?:nesday|s)?|thu(?:rsday|rs)?|fri(?:day)?|sat(?:urday)?)/g;
    for (const match of text.matchAll(rangePattern)) {
      const start = DAY_ALIASES[match[1]];
      const end = DAY_ALIASES[match[2]];
      if (!start || !end) continue;
      let index = DAY_KEYS.indexOf(start);
      for (let count = 0; count < DAY_KEYS.length; count += 1) {
        const day = DAY_KEYS[index];
        days.add(day);
        if (day === end) break;
        index = (index + 1) % DAY_KEYS.length;
      }
    }
    for (const token of text.match(/\b(?:sun(?:day)?|mon(?:day)?|tue(?:sday|s)?|wed(?:nesday|s)?|thu(?:rsday|rs)?|fri(?:day)?|sat(?:urday)?)\b/g) || []) {
      const day = DAY_ALIASES[token];
      if (day) days.add(day);
    }
    return days;
  }

  function isHappyHourActiveNow(details, now = new Date()) {
    if (!details || details.exists === false || !(now instanceof Date) || Number.isNaN(now.getTime())) {
      return false;
    }
    const freeText = String(details.daysTimes || details.days_times || details.when || "");
    const times = freeText.match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi) || [];
    const startMinutes = happyHourTimeToMinutes(details.start || details.startTime || details.start_time || times[0]);
    const endMinutes = happyHourTimeToMinutes(details.end || details.endTime || details.end_time || times[1]);
    if (startMinutes == null || endMinutes == null || startMinutes === endMinutes) {
      return false;
    }

    const activeDays = parseHappyHourDays(details.daysOfWeek || details.days_of_week || details.days || freeText);
    if (activeDays.size === 0) {
      return false;
    }

    const currentDayIndex = now.getDay();
    const currentDay = DAY_KEYS[currentDayIndex];
    const previousDay = DAY_KEYS[(currentDayIndex + 6) % 7];
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (endMinutes > startMinutes) {
      return activeDays.has(currentDay) && nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    return (activeDays.has(currentDay) && nowMinutes >= startMinutes) ||
      (activeDays.has(previousDay) && nowMinutes < endMinutes);
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
        if (source.unavailable_reason === "cans_or_bottles") {
          return "Cans or bottles";
        }
        if (source.unavailable_reason === "bottles_only") {
          return "Bottles only";
        }
        return source.unavailable_reason === "cans_only" ? "Cans only" : "Cans or bottles";
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
      case "Cans or bottles":
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

  function getPriceRingColor(beer) {
    if (!hasNumericPrice(beer)) {
      return null;
    }

    return PRICE_RING_COLORS[getPriceTier(beer)] || null;
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
      priceRingColor: PRICE_RING_COLORS[state] || null,
    };

    if (!options.selected) {
      return visual;
    }

    return {
      ...visual,
      state: `${state}_selected`,
      strokeColor: "#f5c542",
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

    if (beer.availabilityLabel === "Cans or bottles") {
      return "C/B";
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

  function normalizeLatLng(value) {
    if (!value || typeof value !== "object") {
      return null;
    }

    const lat = Number(value.lat ?? value.latitude);
    const lng = Number(value.lng ?? value.longitude);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return null;
    }

    return { lat, lng };
  }

  function isLatLngInBounds(value, bounds) {
    const coords = normalizeLatLng(value);
    const south = Number(bounds && bounds.south);
    const north = Number(bounds && bounds.north);
    const west = Number(bounds && bounds.west);
    const east = Number(bounds && bounds.east);

    if (
      !coords ||
      !Number.isFinite(south) ||
      !Number.isFinite(north) ||
      !Number.isFinite(west) ||
      !Number.isFinite(east) ||
      south > north ||
      west > east
    ) {
      return false;
    }

    return coords.lat >= south && coords.lat <= north && coords.lng >= west && coords.lng <= east;
  }

  function getDistanceKm(origin, destination) {
    const start = normalizeLatLng(origin);
    const end = normalizeLatLng(destination);

    if (!start || !end) {
      return null;
    }

    const earthRadiusKm = 6371;
    const toRadians = (degrees) => degrees * (Math.PI / 180);
    const latDelta = toRadians(end.lat - start.lat);
    const lngDelta = toRadians(end.lng - start.lng);
    const startLat = toRadians(start.lat);
    const endLat = toRadians(end.lat);
    const haversine =
      Math.sin(latDelta / 2) ** 2 +
      Math.cos(startLat) * Math.cos(endLat) * Math.sin(lngDelta / 2) ** 2;
    const centralAngle = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));

    return earthRadiusKm * centralAngle;
  }

  function formatDistance(distanceKm) {
    if (distanceKm == null) {
      return "Distance unavailable";
    }

    const numericDistance = Number(distanceKm);

    if (!Number.isFinite(numericDistance) || numericDistance < 0) {
      return "Distance unavailable";
    }

    if (numericDistance < 1) {
      return `${Math.max(1, Math.round(numericDistance * 1000))} m`;
    }

    return `${numericDistance.toFixed(numericDistance < 10 ? 1 : 0)} km`;
  }

  function isWithinRadiusKm(origin, destination, radiusKm) {
    const distanceKm = getDistanceKm(origin, destination);
    const numericRadius = Number(radiusKm);

    return distanceKm !== null && Number.isFinite(numericRadius) && numericRadius >= 0 && distanceKm <= numericRadius;
  }

  function getClusterVisual(count) {
    const numericCount = Number(count);
    const safeCount = Number.isFinite(numericCount) && numericCount > 0 ? numericCount : 1;

    if (safeCount >= 100) {
      return {
        fillColor: "#f5c542",
        strokeColor: "#fef3c7",
        labelColor: "#111827",
        scale: 28,
        fillOpacity: 0.9,
        strokeWeight: 4,
        fontSize: "12px",
      };
    }

    if (safeCount >= 25) {
      return {
        fillColor: "#22d3ee",
        strokeColor: "#a5f3fc",
        labelColor: "#06101f",
        scale: 24,
        fillOpacity: 0.9,
        strokeWeight: 4,
        fontSize: "12px",
      };
    }

    if (safeCount >= 10) {
      return {
        fillColor: "#2563eb",
        strokeColor: "#bfdbfe",
        labelColor: "#ffffff",
        scale: 21,
        fillOpacity: 0.88,
        strokeWeight: 3.5,
        fontSize: "12px",
      };
    }

    return {
      fillColor: "#172554",
      strokeColor: "#38bdf8",
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
    PRICE_RING_COLORS,
    normalizeBeerPriceNumeric,
    getAvailabilityLabel,
    getBeerPriceText,
    getAvailabilityTone,
    normalizeSearchKey,
    normalizeHappyHourBeerItems,
    beerCandidatesMatchSearch,
    happyHourBeerMatchesSearch,
    happyHourTextMatchesBeer,
    happyHourMatchesBeerQuery,
    isHappyHourActiveNow,
    hasNumericPrice,
    getLowestKnownPrice,
    getPriceTier,
    getPriceRingColor,
    getMarkerState,
    getMarkerVisual,
    getMarkerColor,
    getMarkerLabel,
    getMarkerScale,
    getClusterVisual,
    isUnderPriceThreshold,
    isLatLngInBounds,
    getDistanceKm,
    formatDistance,
    isWithinRadiusKm,
  });
})(typeof window !== "undefined" ? window : globalThis);
