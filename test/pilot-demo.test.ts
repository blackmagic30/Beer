import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertPilotDemoTarget, PILOT_DEMO_VENUE_ID, preparePilotDemo } from "../scripts/pilot-demo.js";
import { CURRENT_LEGAL_POLICY_VERSION } from "../src/config/legal.js";
import { AccountSessionRepository } from "../src/db/account-session.repository.js";
import { VenueInventoryRepository } from "../src/db/venue-inventory.repository.js";
import { VenueAccessRepository } from "../src/db/venue-access.repository.js";
import { PintPointRepository } from "../src/db/pint-point.repository.js";
import { PublicPriceRepository } from "../src/db/public-price.repository.js";
import { PilotLoopbackDatabase, createPilotTestService, createEmptyPilotVenueDirectory } from "./helpers/pilot-postgres-runtime.js";
import { assertPostgresFixtureDisconnected } from "./helpers/postgres-pool-shutdown.js";

const baseEnvironment = {
  NODE_ENV: "test", PUBLIC_BASE_URL: "http://127.0.0.1:3217",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55439/pintpath_pilot_demo_test?sslmode=disable",
  BAR_PILOT_ENABLED: "true", BAR_PILOT_DEMO_ENABLED: "true", BAR_PILOT_VENUE_IDS: PILOT_DEMO_VENUE_ID,
  BAR_PILOT_DEMO_CUSTOMER_IDS: "demo-customer",
};
describe("pilot demo destination guard", () => {
  it("accepts only an explicit local disposable target", () => {
    expect(assertPilotDemoTarget(baseEnvironment)).toBe("local");
  });
  it.each([
    { PUBLIC_BASE_URL: "https://pintpath.au" },
    { PUBLIC_BASE_URL: "https://pintpath.com.au" },
    { DATABASE_URL: "postgresql://postgres:postgres@production.example/postgres?sslmode=disable" },
    { NODE_ENV: "production" },
    { BAR_PILOT_ENABLED: "false" },
    { BAR_PILOT_DEMO_ENABLED: "false" },
    { BAR_PILOT_VENUE_IDS: "another-venue" },
    { RESTORE_REHEARSAL_MODE: "true" },
  ])("rejects unsafe or disabled target %j", override => {
    expect(() => assertPilotDemoTarget({ ...baseEnvironment, ...override })).toThrow();
  });
});
const configuredAdminUrl = process.env.PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL?.trim();
describe.skipIf(!configuredAdminUrl)("pilot fixture on restricted canonical PostgreSQL", () => {
  let admin: Client;
  let database: PilotLoopbackDatabase;
  let databaseName: string;
  let environment: typeof baseEnvironment;
  const emails = { operator: "demo-operator@example.test", manager: "demo-manager@example.test",
    staff: "demo-staff@example.test", customer: "demo-customer@example.test" };
  const now = "2026-09-10T00:00:00.000Z";
  beforeAll(async () => {
    const url = new URL(configuredAdminUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/postgres"
      || url.searchParams.get("sslmode") !== "disable") throw new Error("Disposable loopback PostgreSQL required.");
    admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    databaseName = `pintpath_pilot_fixture_${process.pid}_${crypto.randomBytes(3).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
    url.pathname = `/${databaseName}`;
    const bootstrap = new Client({ connectionString: url.toString() });
    await bootstrap.connect();
    await bootstrap.query(fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"));
    await bootstrap.end();
    database = new PilotLoopbackDatabase(url.toString());
    environment = { ...baseEnvironment, DATABASE_URL: url.toString() };
    const accounts = new AccountSessionRepository(database);
    for (const name of ["operator", "manager", "staff", "customer"] as const) {
      await accounts.createAccount({ id: `demo-${name}`, email: emails[name], passwordHash: "fixture-password-hash",
        role: name === "operator" ? "admin" : "user", subscriptionStatus: name === "operator" ? "admin" : "free",
        emailVerifiedAt: now, termsAcceptedAt: now, privacyAcceptedAt: now,
        termsVersion: CURRENT_LEGAL_POLICY_VERSION, privacyVersion: CURRENT_LEGAL_POLICY_VERSION, now });
      await accounts.updateAgeConfirmed(`demo-${name}`, now);
    }
  }, 30000);
  afterAll(async () => {
    try {
      await database?.close();
      if (admin && databaseName) {
        await assertPostgresFixtureDisconnected(admin, databaseName);
        await admin.query(`DROP DATABASE ${databaseName}`);
      }
    } finally {
      await admin?.end();
    }
  });
  it("preflights without writes, prepares once, and resets without erasing audit history", async () => {
    expect(await preparePilotDemo({ database, environment, emails, mode: "preflight", now }))
      .toMatchObject({ changed: false, fixtureExists: false });
    expect(await new VenueInventoryRepository(database).getBarProfile(PILOT_DEMO_VENUE_ID)).toBeNull();
    expect(await preparePilotDemo({ database, environment, emails, mode: "setup", now }))
      .toMatchObject({ changed: true, beers: 3, customerPoints: 49 });
    const access = new VenueAccessRepository(database);
    expect(await access.getVenueAssignment({ userId: "demo-manager", venueId: PILOT_DEMO_VENUE_ID, activeOnly: true }))
      .toMatchObject({ accessLevel: "manager" });
    expect(await access.getVenueAssignment({ userId: "demo-staff", venueId: PILOT_DEMO_VENUE_ID, activeOnly: true }))
      .toMatchObject({ accessLevel: "counter_staff" });
    const inventory = new VenueInventoryRepository(database);
    expect((await inventory.getBarProfile(PILOT_DEMO_VENUE_ID))?.openingHours).toMatchObject({
      format: "weekly", timezone: "Australia/Melbourne", days: {
        mon: { open: true, openTime: "12:00", closeTime: "23:00" },
        sun: { open: true, openTime: "12:00", closeTime: "23:00" },
      },
    });
    const beers = await inventory.listBarBeers(PILOT_DEMO_VENUE_ID);
    expect(beers).toHaveLength(3);
    expect(beers.every(beer => beer.price && beer.serveSize === "pint" && beer.onTap && beer.inStock)).toBe(true);
    const points = new PintPointRepository(database);
    expect(await points.getPintPointBalance("demo-customer")).toMatchObject({ balance: 49 });
    expect(await preparePilotDemo({ database, environment, emails, mode: "setup", now })).toMatchObject({ changed: false });
    const ledgerBefore = await database.prepare("SELECT * FROM pint_point_ledger WHERE user_id = ?").all("demo-customer");
    expect(ledgerBefore).toHaveLength(1);
    expect(ledgerBefore[0]).toMatchObject({ type: "admin_adjustment", points_delta: 49 });
    expect(await preparePilotDemo({ database, environment, emails, mode: "reset", now: "2026-09-10T00:01:00.000Z" }))
      .toMatchObject({ changed: true, preservedHistory: true });
    const ledgerAfter = await database.prepare("SELECT * FROM pint_point_ledger WHERE user_id = ? ORDER BY created_at").all("demo-customer");
    expect(ledgerAfter).toHaveLength(2);
    expect(ledgerAfter[0]).toEqual(ledgerBefore[0]);
    expect(await points.getPintPointBalance("demo-customer")).toMatchObject({ balance: 49 });
    expect((await database.prepare("SELECT * FROM contribution_ledger WHERE user_id = ?").all("demo-customer"))).toEqual([]);
    expect((await new PublicPriceRepository(database).listVenueManagerPriceRecords(10, PILOT_DEMO_VENUE_ID))).toHaveLength(3);
  });
  it("rejects cross-account fixture takeover and nonallowlisted customer", async () => {
    await expect(preparePilotDemo({ database, environment, emails: { ...emails, customer: emails.staff, staff: emails.customer }, mode: "reset", now })).rejects.toThrow();
    await expect(preparePilotDemo({ database, environment: { ...environment, BAR_PILOT_DEMO_CUSTOMER_IDS: "other" }, emails, mode: "reset", now })).rejects.toThrow("allowlist");
    expect(await new PintPointRepository(database).getPintPointBalance("demo-customer")).toMatchObject({ balance: 49 });
  });
  it("roundtrips the manager portal weekly hours through PostgreSQL and public readback", async () => {
    await preparePilotDemo({ database, environment, emails, mode: "setup", now });
    const { env } = await import("../src/config/env.js");
    const config = { ...env, NODE_ENV: "test" as const, PUBLIC_BASE_URL: environment.PUBLIC_BASE_URL,
      DATABASE_URL: environment.DATABASE_URL, BAR_PILOT_ENABLED: true, BAR_PILOT_DEMO_ENABLED: true,
      BAR_PILOT_VENUE_IDS: PILOT_DEMO_VENUE_ID, BAR_PILOT_DEMO_CUSTOMER_IDS: "demo-customer",
      COMMERCIAL_LAUNCH_ENABLED: false, PINT_POINTS_REWARDS_ENABLED: false,
      SUPABASE_URL: undefined, SUPABASE_ANON_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined };
    const service = createPilotTestService(database, config, createEmptyPilotVenueDirectory());
    const manager = (await new AccountSessionRepository(database).getAccountById("demo-manager"))!;
    const profile = (await new VenueInventoryRepository(database).getBarProfile(PILOT_DEMO_VENUE_ID))!;
    const days = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(day => [day, {
      open: true, openTime: day === "mon" ? "13:00" : "12:00", closeTime: "23:00", closed: false,
    }]));
    const weeklyHours = { format: "weekly", timezone: "Australia/Melbourne", days };
    const expectedHours = { ...weeklyHours, days: Object.fromEntries(Object.entries(days)
      .map(([day, { closed: _closed, ...hours }]) => [day, hours])) };
    await service.upsertBarProfile(manager, PILOT_DEMO_VENUE_ID, { ...profile,
      phone: "03 9000 0123", expectedUpdatedAt: profile.updatedAt, openingHours: weeklyHours });
    expect((await new VenueInventoryRepository(database).getBarProfile(PILOT_DEMO_VENUE_ID))?.openingHours)
      .toEqual(expectedHours);
    // A fresh service must render what was saved, without relying on local state.
    const reloaded = createPilotTestService(database, config, createEmptyPilotVenueDirectory());
    expect((await reloaded.getVenuePortal(manager, { venueId: PILOT_DEMO_VENUE_ID })).profile?.openingHours)
      .toEqual(expectedHours);
    expect(await reloaded.getPublicVenueById(PILOT_DEMO_VENUE_ID))
      .toMatchObject({ phone: "03 9000 0123", openingHours: expectedHours });
    expect((await reloaded.listVenuesPage("Pilot", 1)).venues[0]?.openingHours).toEqual(expectedHours);
  });

  it("persists only the existing bound staff password session and rejects revoked access on PostgreSQL", async () => {
    await preparePilotDemo({ database, environment, emails, mode: "setup", now });
    const accounts = new AccountSessionRepository(database);
    const timestamp = new Date().toISOString();
    await accounts.linkSupabaseAccount({ userId: "demo-staff", supabaseUserId: "provider-demo-staff",
      email: emails.staff, authProvider: "supabase", displayName: null, avatarUrl: null,
      emailVerifiedAt: now, mfaLevel: "aal1", mfaVerifiedAt: null, now: timestamp });
    const { env } = await import("../src/config/env.js");
    const config = { ...env, NODE_ENV: "production" as const, PUBLIC_BASE_URL: "https://beer-staging.up.railway.app",
      DATABASE_URL: environment.DATABASE_URL, BAR_PILOT_ENABLED: true, BAR_PILOT_DEMO_ENABLED: true,
      BAR_PILOT_VENUE_IDS: PILOT_DEMO_VENUE_ID, BAR_PILOT_DEMO_CUSTOMER_IDS: "demo-customer",
      COMMERCIAL_LAUNCH_ENABLED: false, ADMIN_EMAILS: "owner@example.test" };
    // These are isolated fixture claims, never evidence of hosted provider auth.
    const remote = { auth: { getUser: async () => ({ data: { user: { id: "provider-demo-staff",
      email: emails.staff, email_confirmed_at: now } }, error: null }) } } as never;
    const service = createPilotTestService(database, config, remote);
    const seconds = Math.floor(Date.now() / 1000);
    const accessToken = [Buffer.from('{"alg":"HS256"}').toString("base64url"), Buffer.from(JSON.stringify({
      sub: "provider-demo-staff", iat: seconds, session_id: "pg-staff-password-session",
      amr: [{ method: "password", timestamp: seconds }],
    })).toString("base64url"), "local-test-signature"].join(".");
    const input = { accessToken, credentialCeremony: "browser_memory_v1" as const, pilotStaffSignIn: true as const };
    const scope = { RAILWAY_ENVIRONMENT_NAME: "staging", RAILWAY_PROJECT_ID: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
      RAILWAY_ENVIRONMENT_ID: "a4e0f507-d6d3-4df9-a818-ad92c0071a35", RAILWAY_SERVICE_ID: "6816c4a2-e392-4ee5-826f-2584cb599ec0" };
    const access = new VenueAccessRepository(database);
    try {
      Object.entries(scope).forEach(([key, value]) => vi.stubEnv(key, value));
      expect(await service.getPublicConfig()).toMatchObject({ pilotStaffEmailSignInEnabled: true });
      const before = await database.prepare("SELECT id, role FROM accounts ORDER BY id").all();
      const signedIn = await service.loginWithSupabaseAccessToken(input);
      expect(signedIn.account.id).toBe("demo-staff");
      expect(await database.prepare("SELECT user_id FROM auth_sessions WHERE revoked_at IS NULL").all()).toEqual([{ user_id: "demo-staff" }]);
      expect(await database.prepare("SELECT id, role FROM accounts ORDER BY id").all()).toEqual(before);
      await access.revokeVenueAssignment({ actorAccountId: "demo-operator", userId: "demo-staff", venueId: PILOT_DEMO_VENUE_ID,
        expectedAccessLevel: "counter_staff", now: timestamp });
      const sessions = await database.prepare("SELECT token_hash, user_id FROM auth_sessions ORDER BY token_hash").all();
      expect(await service.getPublicConfig()).toMatchObject({ pilotStaffEmailSignInEnabled: false });
      await expect(service.loginWithSupabaseAccessToken(input)).rejects.toThrow("assigned staging test staff");
      expect(await database.prepare("SELECT token_hash, user_id FROM auth_sessions ORDER BY token_hash").all()).toEqual(sessions);
    } finally {
      vi.unstubAllEnvs();
    }
    // Restore only this disposable fixture's assignment for the remaining tests.
    const invitationToken = crypto.randomUUID();
    await access.inviteCounterStaff({ invitationToken, inviterAccountId: "demo-operator", userId: "demo-staff",
      venueId: PILOT_DEMO_VENUE_ID, venueName: "PintPath Pilot Hotel — DEMO", suburb: "Fitzroy", now: timestamp,
      expiresAt: new Date(Date.parse(timestamp) + 86_400_000).toISOString() });
    await access.respondToCounterStaffInvitation({ invitationToken, userId: "demo-staff", decision: "accept", now: timestamp });
  });

  it("publishes the canonical bound fixture through the service with an empty remote directory", async () => {
    await preparePilotDemo({ database, environment, emails, mode: "setup", now });
    const { env } = await import("../src/config/env.js");
    const config = { ...env, NODE_ENV: "test" as const, PUBLIC_BASE_URL: environment.PUBLIC_BASE_URL,
      DATABASE_URL: environment.DATABASE_URL, BAR_PILOT_ENABLED: true, BAR_PILOT_DEMO_ENABLED: true,
      BAR_PILOT_VENUE_IDS: PILOT_DEMO_VENUE_ID, BAR_PILOT_DEMO_CUSTOMER_IDS: "demo-customer",
      COMMERCIAL_LAUNCH_ENABLED: false, PINT_POINTS_REWARDS_ENABLED: false,
      SUPABASE_URL: undefined, SUPABASE_ANON_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined };
    const remote = createEmptyPilotVenueDirectory();
    const service = createPilotTestService(database, config, remote);
    expect((await service.listVenuesPage("Pilot", 1)).venues.map(venue => venue.id)).toEqual([PILOT_DEMO_VENUE_ID]);
    expect(await service.getPublicVenueById(PILOT_DEMO_VENUE_ID)).toMatchObject({ latitude: -37.804, name: "PintPath Pilot Hotel — DEMO" });
    const inventory = new VenueInventoryRepository(database);
    const customer = (await new AccountSessionRepository(database).getAccountById("demo-customer"))!;
    const before = await service.listPriceRecords(customer, { venueId: PILOT_DEMO_VENUE_ID, limit: 10 });
    expect(before.records).toHaveLength(3);
    const beer = (await inventory.listBarBeers(PILOT_DEMO_VENUE_ID))[0]!;
    await inventory.upsertBarBeer({ ...beer, price: 11.5, onTap: true, inStock: true,
      expectedUpdatedAt: beer.updatedAt, now: new Date().toISOString() });
    const edited = await service.listPriceRecords(customer, { venueId: PILOT_DEMO_VENUE_ID, limit: 10 });
    expect(edited.records.find(record => record.id === `bar_beer:${beer.id}` || record.beerName === beer.beerName))
      .toMatchObject({ price: 11.5, isOnTap: "yes" });
    for (const override of [{ BAR_PILOT_ENABLED: false }, { BAR_PILOT_DEMO_ENABLED: false },
      { BAR_PILOT_VENUE_IDS: "other" }, { BAR_PILOT_DEMO_CUSTOMER_IDS: "other" },
      { NODE_ENV: "production" as const, PUBLIC_BASE_URL: "https://pintpath.au" }]) {
      const blocked = createPilotTestService(database, { ...config, ...override }, remote);
      expect((await blocked.listVenuesPage(undefined, 10)).venues).toEqual([]);
      expect(await blocked.getPublicVenueById(PILOT_DEMO_VENUE_ID)).toBeNull();
      expect((await blocked.listPriceRecords(customer, { venueId: PILOT_DEMO_VENUE_ID, limit: 10 })).records).toEqual([]);
    }
    await database.prepare("UPDATE venue_profiles SET active = FALSE WHERE venue_id = ?").run(PILOT_DEMO_VENUE_ID);
    expect(await service.getPublicVenueById(PILOT_DEMO_VENUE_ID)).toBeNull();
    expect((await service.listVenuesPage(undefined, 10)).venues).toEqual([]);
    await database.prepare("DELETE FROM venue_profiles WHERE venue_id = ?").run(PILOT_DEMO_VENUE_ID);
    expect(await service.getPublicVenueById(PILOT_DEMO_VENUE_ID)).toBeNull();
  });
});
