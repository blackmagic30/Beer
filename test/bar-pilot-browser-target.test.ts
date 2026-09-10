import { describe, expect, it } from "vitest";
import { validatePilotBrowserTarget } from "../scripts/lib/bar-pilot-browser-target.mjs";
const venueId = "pintpath-pilot-demo:venue:v1";
describe("pilot browser acceptance destination", () => {
  it("defaults to the isolated loopback runtime", () => {
    expect(validatePilotBrowserTarget({ origin: "http://127.0.0.1:3217", venueId })).toEqual({ origin: "http://127.0.0.1:3217", hosted: false });
    expect(() => validatePilotBrowserTarget({ origin: "https://beer-staging.up.railway.app", venueId })).toThrow();
  });
  it("requires explicit staging opt-in and the exact labelled demonstration venue", () => {
    expect(validatePilotBrowserTarget({ origin: "https://beer-staging.up.railway.app", venueId }, true).hosted).toBe(true);
    expect(() => validatePilotBrowserTarget({ origin: "https://beer-staging.up.railway.app", venueId: "real-venue" }, true)).toThrow();
  });
  it("rejects production, arbitrary hosts, paths, and credential-bearing origins even with opt-in", () => {
    for (const origin of ["https://pintpath.au", "https://example.com", "http://beer-staging.up.railway.app", "https://beer-staging.up.railway.app.evil.test", "https://user:secret@beer-staging.up.railway.app", "https://beer-staging.up.railway.app/other", "https://beer-staging.up.railway.app?target=production"]) {
      expect(() => validatePilotBrowserTarget({ origin, venueId }, true)).toThrow();
    }
  });
});
