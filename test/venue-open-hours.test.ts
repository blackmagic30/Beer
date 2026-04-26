import { describe, expect, it } from "vitest";

import { isVenueLikelyOpenAt } from "../src/lib/venue-open-hours.js";

describe("isVenueLikelyOpenAt", () => {
  const timezone = "Australia/Melbourne";

  it("returns true when a venue is inside a normal same-day trading range", () => {
    const result = isVenueLikelyOpenAt(
      [
        "Monday: 12:00 PM - 10:00 PM",
        "Tuesday: 12:00 PM - 10:00 PM",
      ],
      new Date("2026-04-27T09:00:00.000Z"),
      timezone,
    );

    expect(result).toBe(true);
  });

  it("returns false when a venue is closed on the local weekday", () => {
    const result = isVenueLikelyOpenAt(
      [
        "Monday: Closed",
        "Tuesday: 12:00 PM - 10:00 PM",
      ],
      new Date("2026-04-27T09:00:00.000Z"),
      timezone,
    );

    expect(result).toBe(false);
  });

  it("handles overnight trading ranges from the same day", () => {
    const result = isVenueLikelyOpenAt(
      [
        "Monday: 5:00 PM - 2:00 AM",
        "Tuesday: 5:00 PM - 2:00 AM",
      ],
      new Date("2026-04-27T10:30:00.000Z"),
      timezone,
    );

    expect(result).toBe(true);
  });

  it("handles overnight carry-over from the previous day", () => {
    const result = isVenueLikelyOpenAt(
      [
        "Monday: 5:00 PM - 2:00 AM",
        "Tuesday: Closed",
      ],
      new Date("2026-04-27T15:30:00.000Z"),
      timezone,
    );

    expect(result).toBe(true);
  });

  it("returns null when no opening-hours data exists", () => {
    expect(isVenueLikelyOpenAt(null, new Date("2026-04-27T09:00:00.000Z"), timezone)).toBeNull();
  });
});
