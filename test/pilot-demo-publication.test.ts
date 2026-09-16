import { describe, expect, it } from "vitest";
import {
  PILOT_DEMO_VENUE_ID, PILOT_DEMO_STAGING_ORIGIN, PILOT_DEMO_STAGING_ENVIRONMENT_ID,
  pilotDemoPublicationScopeAllowed, pilotDemoBindingAllowsPublication,
} from "../src/lib/pilot-demo-fixture.js";

const config = { NODE_ENV: "production", PUBLIC_BASE_URL: PILOT_DEMO_STAGING_ORIGIN,
  BAR_PILOT_ENABLED: true, BAR_PILOT_DEMO_ENABLED: true,
  BAR_PILOT_VENUE_IDS: PILOT_DEMO_VENUE_ID, BAR_PILOT_DEMO_CUSTOMER_IDS: "customer" };
const staging = { RAILWAY_ENVIRONMENT_NAME: "staging", RAILWAY_ENVIRONMENT_ID: PILOT_DEMO_STAGING_ENVIRONMENT_ID,
  RAILWAY_PROJECT_ID: "48d8c6cd-1c66-4148-874b-20877f48e1a5", RAILWAY_SERVICE_ID: "6816c4a2-e392-4ee5-826f-2584cb599ec0" };
const binding = { version: 1, venueId: PILOT_DEMO_VENUE_ID, operator: "operator", manager: "manager", staff: "staff", customer: "customer" };

describe("isolated demo publication authority", () => {
  it("accepts exact staging scope and an explicitly allowed four-account fixture", () => {
    expect(pilotDemoPublicationScopeAllowed(config, staging)).toBe(true);
    expect(pilotDemoBindingAllowsPublication(binding, "other,customer")).toBe(true);
  });
  it.each([
    { BAR_PILOT_ENABLED: false }, { BAR_PILOT_DEMO_ENABLED: false },
    { BAR_PILOT_VENUE_IDS: "ordinary-venue" }, { BAR_PILOT_DEMO_CUSTOMER_IDS: "" },
    { PUBLIC_BASE_URL: "https://pintpath.au" }, { PUBLIC_BASE_URL: "https://beer-staging.up.railway.app.evil.test" },
    { PUBLIC_BASE_URL: `${PILOT_DEMO_STAGING_ORIGIN}/other` }, { NODE_ENV: "development" },
    { RESTORE_REHEARSAL_MODE: true }, { POSTGRES_RECOVERY_REHEARSAL_MODE: true },
  ])("rejects an unapproved publication configuration %j", override => {
    expect(pilotDemoPublicationScopeAllowed({ ...config, ...override }, staging)).toBe(false);
  });
  it.each(Object.keys(staging))("rejects a changed staging resource %s", key => {
    expect(pilotDemoPublicationScopeAllowed(config, { ...staging, [key]: "other" })).toBe(false);
  });
  it("permits loopback only for the existing isolated PostgreSQL test naming boundary", () => {
    const local = { ...config, NODE_ENV: "test", PUBLIC_BASE_URL: "http://127.0.0.1:3217",
      DATABASE_URL: "postgresql://postgres@127.0.0.1:55439/pintpath_pilot_publication?sslmode=disable" };
    expect(pilotDemoPublicationScopeAllowed(local, {})).toBe(true);
    expect(pilotDemoPublicationScopeAllowed(local, staging)).toBe(false);
    for (const database of [undefined, "postgresql://production.example/pintpath_pilot_publication?sslmode=disable",
      "postgresql://127.0.0.1/production?sslmode=disable"]) {
      expect(pilotDemoPublicationScopeAllowed({ ...local, DATABASE_URL: database }, {})).toBe(false);
    }
    expect(pilotDemoPublicationScopeAllowed({ ...local, PUBLIC_BASE_URL: "https://remote.example" }, {})).toBe(false);
  });
  it.each([null, {}, { ...binding, version: 2 }, { ...binding, venueId: "ordinary-venue" },
    { ...binding, staff: "manager" }, { ...binding, operator: "" }, { ...binding, extra: true }])(
    "rejects absent, partial, changed or non-distinct fixture ownership %j", value => {
      expect(pilotDemoBindingAllowsPublication(value, "customer")).toBe(false);
    });
  it("requires the bound customer's exact internal account ID, not a substring or another account", () => {
    expect(pilotDemoBindingAllowsPublication(binding, "different-customer")).toBe(false);
    expect(pilotDemoBindingAllowsPublication(binding, "customer-extra")).toBe(false);
  });
});
