import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertPilotDemoTarget, PILOT_DEMO_VENUE_ID, preparePilotDemo } from "../scripts/pilot-demo.js";
import { AccountSessionRepository } from "../src/db/account-session.repository.js";
import { VenueInventoryRepository } from "../src/db/venue-inventory.repository.js";
import { VenueAccessRepository } from "../src/db/venue-access.repository.js";
import { PintPointRepository } from "../src/db/pint-point.repository.js";
import { PublicPriceRepository } from "../src/db/public-price.repository.js";
import { PilotLoopbackDatabase } from "./helpers/pilot-postgres-runtime.js";

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
        emailVerifiedAt: now, now });
      await accounts.updateAgeConfirmed(`demo-${name}`, now);
    }
  }, 30000);
  afterAll(async () => {
    await database?.close();
    if (admin && databaseName) await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await admin?.end();
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
});
