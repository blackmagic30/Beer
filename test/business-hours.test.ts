import { describe, expect, it } from "vitest";

import { getCallingWindowStatus } from "../src/lib/business-hours.js";

const baseConfig = {
  timezone: "Australia/Melbourne",
  start: "11:00",
  end: "20:30",
  allowedDays: "mon,tue,wed,thu,fri,sat,sun",
};

describe("getCallingWindowStatus", () => {
  it("allows times within the configured Melbourne window", () => {
    const status = getCallingWindowStatus(new Date("2026-04-20T02:30:00.000Z"), baseConfig);

    expect(status.allowed).toBe(true);
    expect(status.localTime).toBe("12:30");
  });

  it("blocks times outside the configured Melbourne window", () => {
    const status = getCallingWindowStatus(new Date("2026-04-20T00:30:00.000Z"), baseConfig);

    expect(status.allowed).toBe(false);
    expect(status.reason).toContain("Outside allowed call hours");
  });

  it("blocks disallowed weekdays", () => {
    const status = getCallingWindowStatus(new Date("2026-04-19T02:30:00.000Z"), {
      ...baseConfig,
      allowedDays: "mon,tue,wed,thu,fri",
    });

    expect(status.allowed).toBe(false);
    expect(status.reason).toContain("Outside allowed call days");
  });
});
