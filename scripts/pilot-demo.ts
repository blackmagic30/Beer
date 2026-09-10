import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AccountSessionRepository } from "../src/db/account-session.repository.js";
import { ActivityAuditRepository } from "../src/db/activity-audit.repository.js";
import { PintPointRepository } from "../src/db/pint-point.repository.js";
import { SystemStateRepository } from "../src/db/system-state.repository.js";
import { VenueAccessRepository } from "../src/db/venue-access.repository.js";
import { VenueIdentityRepository } from "../src/db/venue-identity.repository.js";
import { VenueInventoryRepository } from "../src/db/venue-inventory.repository.js";
import { createRuntimePersistence } from "../src/db/runtime-persistence.js";
import type { SqlDatabase } from "../src/db/sql-database.js";
import { isRestoreRehearsalEnvironment } from "./lib/operator-mutation-guard.js";

export const PILOT_DEMO_VENUE_ID = "pintpath-pilot-demo:venue:v1";
export const PILOT_DEMO_NAME = "PintPath Pilot Hotel — DEMO";
const FIXTURE_KEY = "pilot-demo:fixture:v1";
const STAGING_ORIGIN = "https://beer-staging.up.railway.app";
const STAGING_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
export const PILOT_DEMO_BEERS = Object.freeze([
  { name: "Carlton Draught", key: "carlton_draft", price: 13, brewery: "Carlton & United", style: "Lager", abv: 4.6 },
  { name: "Guinness", key: "guinness", price: 14.5, brewery: "Guinness", style: "Stout", abv: 4.2 },
  { name: "Stone & Wood Pacific Ale", key: "stone_wood_pacific_ale", price: 15, brewery: "Stone & Wood", style: "Pacific Ale", abv: 4.4 },
]);
type Mode = "preflight" | "setup" | "reset";
type Emails = { operator: string; manager: string; staff: string; customer: string };
type Binding = { version: 1; venueId: string; operator: string; manager: string; staff: string; customer: string };
type Environment = Readonly<Record<string, string | undefined>>;

function fail(message: string): never { throw new Error(message); }
function list(value: string | undefined): string[] { return (value ?? "").split(",").map(part => part.trim()).filter(Boolean); }

/** Runs before connecting. No permissive production or generic remote mode exists. */
export function assertPilotDemoTarget(environment: Environment): "local" | "staging" {
  if (environment.BAR_PILOT_ENABLED !== "true" || environment.BAR_PILOT_DEMO_ENABLED !== "true"
    || !list(environment.BAR_PILOT_VENUE_IDS).includes(PILOT_DEMO_VENUE_ID)
    || isRestoreRehearsalEnvironment(environment.RESTORE_REHEARSAL_MODE, environment)) {
    return fail("Enable the isolated bar-pilot demo and its exact venue allowlist first.");
  }
  let origin: URL;
  let databaseUrl: URL;
  try {
    origin = new URL(environment.PUBLIC_BASE_URL ?? "");
    databaseUrl = new URL(environment.DATABASE_URL ?? "");
  } catch { return fail("The pilot demo requires explicit application and PostgreSQL targets."); }
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) return fail("PostgreSQL is required.");
  const local = environment.NODE_ENV === "test"
    && ["localhost", "127.0.0.1"].includes(origin.hostname)
    && ["localhost", "127.0.0.1"].includes(databaseUrl.hostname)
    && /^\/pintpath_pilot_[a-z0-9_]+$/.test(databaseUrl.pathname)
    && databaseUrl.searchParams.get("sslmode") === "disable";
  if (local) return "local";
  const expectedDigest = environment.PINTPATH_EXPECTED_DATABASE_URL_SHA256;
  const actualDigest = crypto.createHash("sha256").update(environment.DATABASE_URL ?? "").digest("hex");
  if (origin.origin !== STAGING_ORIGIN || origin.pathname !== "/" || origin.search || origin.hash
    || environment.RAILWAY_ENVIRONMENT_NAME !== "staging"
    || environment.RAILWAY_ENVIRONMENT_ID !== STAGING_ENVIRONMENT_ID
    || !expectedDigest || expectedDigest !== actualDigest
    || databaseUrl.searchParams.get("sslmode") !== "verify-full") {
    return fail("Demo preparation is restricted to the pinned permanent-staging runtime or an isolated local test database.");
  }
  return "staging";
}

export async function preparePilotDemo(input: {
  database: SqlDatabase; environment: Environment; emails: Emails; mode: Mode; now?: string;
}) {
  const target = assertPilotDemoTarget(input.environment);
  if (input.database.dialect !== "postgres") return fail("The pilot fixture requires canonical PostgreSQL persistence.");
  if (!["preflight", "setup", "reset"].includes(input.mode)) return fail("Choose preflight, setup, or reset.");
  const now = input.now ?? new Date().toISOString();
  const accounts = new AccountSessionRepository(input.database);
  const inventory = new VenueInventoryRepository(input.database);
  const access = new VenueAccessRepository(input.database);
  const identity = new VenueIdentityRepository(input.database);
  const state = new SystemStateRepository(input.database);
  const audit = new ActivityAuditRepository(input.database);
  const points = new PintPointRepository(input.database);

  return input.database.transaction(async () => {
    await input.database.prepare("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0))").get(FIXTURE_KEY);
    const selected = {} as Record<keyof Emails, NonNullable<Awaited<ReturnType<typeof accounts.getAccountByEmail>>>>;
    for (const name of ["operator", "manager", "staff", "customer"] as const) {
      const email = input.emails[name]?.trim().toLowerCase();
      if (!email || email.length > 254 || !email.includes("@")) return fail("Provide the four existing pilot account emails.");
      const account = await accounts.getAccountByEmail(email);
      if (!account || account.status !== "active" || !account.emailVerifiedAt || !account.ageConfirmedAt
        || target === "staging" && (!account.supabaseUserId || account.authProvider === "local" || account.authProvider === "deleted")) {
        return fail(`The ${name} must sign in, verify their email, and confirm their age on the target application first.`);
      }
      const deletion = await input.database.prepare(
        "SELECT id FROM account_deletion_requests WHERE user_id = ? AND status IN ('processing', 'failed', 'completed') LIMIT 1",
      ).get(account.id);
      if (deletion) return fail("A selected account is unavailable for pilot setup.");
      selected[name] = account;
    }
    if (new Set(Object.values(selected).map(account => account.id)).size !== 4
      || selected.operator.role !== "admin" || selected.manager.role === "admin"
      || selected.staff.role !== "user" || selected.customer.role !== "user") {
      return fail("Use four distinct accounts: an existing administrator, manager, staff member, and ordinary customer.");
    }
    if (!list(input.environment.BAR_PILOT_DEMO_CUSTOMER_IDS).includes(selected.customer.id)) {
      return fail("Add the existing customer account to the explicit pilot-demo customer allowlist first.");
    }
    const binding: Binding = { version: 1, venueId: PILOT_DEMO_VENUE_ID,
      operator: selected.operator.id, manager: selected.manager.id, staff: selected.staff.id, customer: selected.customer.id };
    const existing = await state.get<Binding>(FIXTURE_KEY);
    if (existing && JSON.stringify(existing.value) !== JSON.stringify(binding)) {
      // jsonb key order is not a stable serialization order.
      if (Object.keys(binding).some(key => existing.value[key as keyof Binding] !== binding[key as keyof Binding])) {
        return fail("This fixture belongs to a different account set. Use its original accounts.");
      }
    }
    const profile = await inventory.getBarProfile(PILOT_DEMO_VENUE_ID);
    const location = await identity.getVenueLocationCache(PILOT_DEMO_VENUE_ID);
    if (!existing && (profile || location)) return fail("The reserved fixture venue already exists without fixture ownership. No data was changed.");
    if (input.mode === "reset" && !existing) return fail("Run setup before resetting this fixture.");
    if (input.mode === "preflight") return { ready: true, changed: false, mode: input.mode, fixtureExists: Boolean(existing), venueId: PILOT_DEMO_VENUE_ID };
    if (input.mode === "setup" && existing) return { ready: true, changed: false, mode: input.mode, fixtureExists: true, venueId: PILOT_DEMO_VENUE_ID };

    await inventory.upsertBarProfile({ barId: PILOT_DEMO_VENUE_ID, name: PILOT_DEMO_NAME,
      address: "120 Brunswick Street, Fitzroy VIC", suburb: "Fitzroy", area: "Inner North",
      phone: null, website: null, instagram: null,
      description: "Isolated PintPath pilot demonstration venue. Not a real public listing.",
      openingHours: { format: "weekly", timezone: "Australia/Melbourne", days: Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(day =>
        [day, { open: true, openTime: "12:00", closeTime: "23:00" }])) },
      venueTags: ["pilot-demo"], membershipTier: "basic", highlightedName: false, premiumBadge: null, promoted: false,
      featuredSpecialEligible: false, acceptsPintPathCodes: true, active: true, expectedUpdatedAt: profile?.updatedAt ?? null, now });
    await identity.upsertVenueLocationCache({ venueId: PILOT_DEMO_VENUE_ID, venueName: PILOT_DEMO_NAME, suburb: "Fitzroy",
      latitude: -37.804, longitude: 144.978, expectedUpdatedAt: location?.updatedAt ?? null, now });
    for (const [index, beer] of PILOT_DEMO_BEERS.entries()) {
      const id = `pintpath-pilot-demo:beer:${index}`;
      const current = await inventory.getBarBeerById(id);
      if (current && current.barId !== PILOT_DEMO_VENUE_ID) return fail("A reserved fixture beer belongs to another venue.");
      await inventory.upsertBarBeer({ id, barId: PILOT_DEMO_VENUE_ID, beerName: beer.name,
        normalizedBeerId: beer.key, brewery: beer.brewery, style: beer.style, abv: beer.abv, serveSize: "pint", price: beer.price,
        currency: "AUD", onTap: true, inStock: true, notes: "Pilot demonstration",
        priceVerifiedAt: now, stockVerifiedAt: now, expectedUpdatedAt: current?.updatedAt ?? null, now });
    }
    await access.assignVenueManager({ assignmentId: "pintpath-pilot-demo:manager-assignment:v1",
      adminAccountId: selected.operator.id, userId: selected.manager.id, venueId: PILOT_DEMO_VENUE_ID,
      venueName: PILOT_DEMO_NAME, suburb: "Fitzroy", now });
    const currentStaff = await access.getVenueAssignment({ userId: selected.staff.id, venueId: PILOT_DEMO_VENUE_ID, activeOnly: false });
    if (currentStaff?.status === "active" && currentStaff.accessLevel !== "counter_staff") {
      return fail("The selected staff account already has manager access to this fixture.");
    }
    if (currentStaff?.status !== "active") {
      const invitationToken = currentStaff?.status === "pending" && currentStaff.expiresAt && currentStaff.expiresAt > now
        ? currentStaff.id : crypto.randomBytes(32).toString("hex");
      if (invitationToken !== currentStaff?.id) {
        await access.inviteCounterStaff({ invitationToken, inviterAccountId: selected.manager.id,
          userId: selected.staff.id, venueId: PILOT_DEMO_VENUE_ID, venueName: PILOT_DEMO_NAME, suburb: "Fitzroy", now,
          expiresAt: new Date(Date.parse(now) + 86_400_000).toISOString() });
      }
      await access.respondToCounterStaffInvitation({ invitationToken, userId: selected.staff.id, decision: "accept", now });
    }
    await points.prepareDemoBalance({ userId: selected.customer.id, venueId: PILOT_DEMO_VENUE_ID,
      actorUserId: selected.operator.id, target: 49, now });
    await audit.insertSecurityAuditLog({ id: crypto.randomUUID(), actorUserId: selected.operator.id, actorRole: "admin",
      action: input.mode === "setup" ? "pilot_demo_setup" : "pilot_demo_reset", targetType: "venue", targetId: PILOT_DEMO_VENUE_ID,
      metadata: { pilotDemo: true, customerId: selected.customer.id, managerId: selected.manager.id, staffId: selected.staff.id,
        targetPoints: 49, preservedHistory: true }, ipHash: null, userAgentHash: null, createdAt: now });
    await state.set(FIXTURE_KEY, binding, now);
    return { ready: true, changed: true, mode: input.mode, fixtureExists: true, venueId: PILOT_DEMO_VENUE_ID,
      beers: 3, customerPoints: 49, preservedHistory: true };
  })();
}

export async function runPilotDemoCli(args: string[], environment: Environment = process.env): Promise<void> {
  const mode = args[0];
  if (args.length !== 1 || !["preflight", "setup", "reset"].includes(mode ?? "")) {
    return fail("Usage: npx tsx scripts/pilot-demo.ts preflight|setup|reset");
  }
  if (assertPilotDemoTarget(environment) !== "staging") {
    return fail("For local browser fixtures use test/helpers/pilot-browser-server.ts; this operator command runs inside pinned staging.");
  }
  const persistence = await createRuntimePersistence({ postgresRuntime: true, restoreRehearsalMode: false,
    databaseUrl: environment.DATABASE_URL, postgresRootCaPem: environment.PINTPATH_POSTGRES_ROOT_CA_PEM,
    expectedPostgresRootCaDerSha256: environment.PINTPATH_POSTGRES_ROOT_CA_DER_SHA256 });
  try {
    await persistence.assertPostgresTransportExact();
    const result = await preparePilotDemo({ database: persistence.sqlDatabase, environment, mode: mode as Mode,
      emails: { operator: environment.PINTPATH_PILOT_OPERATOR_EMAIL ?? "", manager: environment.PINTPATH_PILOT_MANAGER_EMAIL ?? "",
        staff: environment.PINTPATH_PILOT_STAFF_EMAIL ?? "", customer: environment.PINTPATH_PILOT_CUSTOMER_EMAIL ?? "" } });
    await persistence.assertPostgresTransportExact();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await persistence.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runPilotDemoCli(process.argv.slice(2)).catch(() => {
    // Provider, SQL, or credential-bearing errors never reach the operator output.
    process.stderr.write("Pilot setup could not complete. Check the explicit staging target, demo allowlists, and verified account prerequisites. No secrets were logged.\n");
    process.exitCode = 1;
  });
}
