/** Run only against a disposable loopback PG17 cluster, never hosted staging. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "pg";
import { assertPostgresFixtureDisconnected } from "./postgres-pool-shutdown.js";

if (process.env.NODE_ENV !== "test") throw new Error("Pilot browser fixtures require NODE_ENV=test.");
const adminUrl = new URL(process.env.PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL ?? "");
if (!["postgres:", "postgresql:"].includes(adminUrl.protocol)
  || !["localhost", "127.0.0.1"].includes(adminUrl.hostname)
  || adminUrl.pathname !== "/postgres" || adminUrl.searchParams.get("sslmode") !== "disable") {
  throw new Error("Only a disposable loopback PostgreSQL maintenance database is allowed.");
}
const venueId = "pintpath-pilot-demo:venue:v1";
const customerId = "pintpath-pilot-demo:customer:v1";
const port = Number(process.env.PINTPATH_PILOT_BROWSER_PORT ?? 3217);
const origin = `http://127.0.0.1:${port}`;
Object.assign(process.env, {
  PUBLIC_BASE_URL: origin, COMMERCIAL_LAUNCH_ENABLED: "false", CONSUMER_PAID_ENROLLMENT_ENABLED: "false",
  BAR_PILOT_ENABLED: "true", BAR_PILOT_VENUE_IDS: venueId,
  BAR_PILOT_DEMO_ENABLED: "true", BAR_PILOT_DEMO_CUSTOMER_IDS: customerId,
  PINT_POINTS_REWARDS_ENABLED: "false", ALCOHOL_GAMIFICATION_ENABLED: "false",
  SUPABASE_URL: "", SUPABASE_ANON_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "",
  GOOGLE_MAPS_API_KEY: "", GOOGLE_PLACES_API_KEY: "", OPENAI_API_KEY: "",
  REPORT_EMAIL_MODE: "disabled", ACCOUNT_DELETION_NOTICE_MODE: "disabled",
});
const [expressModule, { env }, { createBusinessRouter }, { errorHandler }, { createPublicVenuePageHandler },
  { PilotLoopbackDatabase, createPilotTestService }, { AccountSessionRepository }, { VenueInventoryRepository },
  { VenueAccessRepository }, { VenueIdentityRepository }, { CURRENT_LEGAL_POLICY_VERSION }] = await Promise.all([
  import("express"), import("../../src/config/env.js"), import("../../src/modules/business/business.routes.js"),
  import("../../src/middleware/error-handler.js"), import("../../src/app.js"), import("./pilot-postgres-runtime.js"),
  import("../../src/db/account-session.repository.js"), import("../../src/db/venue-inventory.repository.js"),
  import("../../src/db/venue-access.repository.js"), import("../../src/db/venue-identity.repository.js"),
  import("../../src/config/legal.js"),
]);
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
const databaseName = `pintpath_pilot_browser_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
await admin.query(`CREATE DATABASE ${databaseName}`);
const runtimeUrl = new URL(adminUrl);
runtimeUrl.pathname = `/${databaseName}`;
const bootstrap = new Client({ connectionString: runtimeUrl.toString() });
await bootstrap.connect();
await bootstrap.query(fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"));
await bootstrap.end();
const database = new PilotLoopbackDatabase(runtimeUrl.toString());
const accounts = new AccountSessionRepository(database);
const inventory = new VenueInventoryRepository(database);
const access = new VenueAccessRepository(database);
const identity = new VenueIdentityRepository(database);
const now = new Date().toISOString();
const password = `${crypto.randomBytes(18).toString("base64url")}!aA1`;
const salt = crypto.randomBytes(16).toString("hex");
const passwordHash = `scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
const fixtureAccounts: Record<string, { id: string; email: string; password: string; token: string }> = {};
for (const role of ["admin", "manager", "staff", "customer", "outsider"] as const) {
  const id = `pintpath-pilot-demo:${role}:v1`;
  const email = `${role}@pilot.pintpath.test`;
  await accounts.createAccount({ id, email, passwordHash, role: role === "admin" ? "admin" : "user",
    subscriptionStatus: role === "admin" ? "admin" : "free", displayName: `Pilot ${role}`,
    emailVerifiedAt: now, termsAcceptedAt: now, privacyAcceptedAt: now,
    termsVersion: CURRENT_LEGAL_POLICY_VERSION, privacyVersion: CURRENT_LEGAL_POLICY_VERSION, now });
  await accounts.updateAgeConfirmed(id, now);
  const token = crypto.randomBytes(32).toString("base64url");
  await accounts.createSession({ tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    userId: id, createdAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  fixtureAccounts[role] = { id, email, password, token };
}
await inventory.upsertBarProfile({ barId: venueId, name: "PintPath Pilot Hotel — DEMO", address: "120 Brunswick Street, Fitzroy VIC",
  suburb: "Fitzroy", area: "Inner North", phone: null, website: null, instagram: null,
  description: "Isolated PintPath pilot demonstration venue. Not a real public listing.",
  openingHours: { format: "weekly", timezone: "Australia/Melbourne", days: Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) =>
    [day, { open: true, openTime: "12:00", closeTime: "23:00" }])) },
  venueTags: ["pilot-demo"], membershipTier: "basic", highlightedName: false, premiumBadge: null, promoted: false,
  featuredSpecialEligible: false, acceptsPintPathCodes: true, active: true, now });
await identity.upsertVenueLocationCache({ venueId, venueName: "PintPath Pilot Hotel — DEMO", suburb: "Fitzroy",
  latitude: -37.804, longitude: 144.978, expectedUpdatedAt: null, now });
for (const [index, beer] of [
  { name: "Carlton Draught", key: "carlton_draft", price: 13, brewery: "Carlton & United", style: "Lager", abv: 4.6 },
  { name: "Guinness", key: "guinness", price: 14.5, brewery: "Guinness", style: "Stout", abv: 4.2 },
  { name: "Balter XPA", key: "balter_xpa", price: 15, brewery: "Balter", style: "XPA", abv: 5 },
].entries()) {
  await inventory.upsertBarBeer({ id: `pintpath-pilot-demo:beer:${index}`, barId: venueId, beerName: beer.name,
    normalizedBeerId: beer.key, brewery: beer.brewery, style: beer.style, abv: beer.abv, serveSize: "pint", price: beer.price,
    currency: "AUD", onTap: true, inStock: true, notes: "Pilot demonstration", priceVerifiedAt: now, stockVerifiedAt: now, now });
}
await access.assignVenueManager({ assignmentId: "pintpath-pilot-demo:manager-assignment:v1", adminAccountId: fixtureAccounts.admin!.id,
  userId: fixtureAccounts.manager!.id, venueId, venueName: "PintPath Pilot Hotel — DEMO", suburb: "Fitzroy", now });
const invitationToken = crypto.randomBytes(32).toString("hex");
await access.inviteCounterStaff({ invitationToken, inviterAccountId: fixtureAccounts.manager!.id,
  userId: fixtureAccounts.staff!.id, venueId, venueName: "PintPath Pilot Hotel — DEMO", suburb: "Fitzroy", now,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
await access.respondToCounterStaffInvitation({ invitationToken, userId: fixtureAccounts.staff!.id, decision: "accept", now });
const { PintPointRepository } = await import("../../src/db/pint-point.repository.js");
await new PintPointRepository(database).prepareDemoBalance({ userId: customerId, venueId, actorUserId: fixtureAccounts.manager!.id, target: 49, now });
const service = createPilotTestService(database, { ...env, SOURCE_EVIDENCE_STORAGE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "pilot-evidence-")),
  SOURCE_EVIDENCE_SIGNING_SECRET: crypto.randomBytes(32).toString("hex") });
const app = expressModule.default();
app.use(expressModule.default.json());
app.get("/health", (_req, res) => res.json({ ok: true, runtime: "postgres", fixture: true }));
app.get("/config.js", async (_req, res) => {
  const config = await service.getPublicConfig();
  res.type("application/javascript").setHeader("Cache-Control", "no-store").send(
    `window.MELB_BEER_BOT_VIEWER_CONFIG = ${JSON.stringify({
      publicBaseUrl: origin, googleMapsApiKey: "", googleMapsMapId: "", supabaseUrl: "", supabaseAnonKey: "",
      supabaseOauthProviders: [], trackedBeers: config.trackedBeers,
      business: { ...config, publicBaseUrl: origin, fieldTestMode: false, restoreRehearsalMode: false },
    })};`);
});
app.use("/api/business", createBusinessRouter(service));
app.get("/venue/:venueId", createPublicVenuePageHandler(async () => service));
app.get("/venue-portal", (_req, res) => res.sendFile(path.resolve("viewer/venue-portal.html")));
app.use(expressModule.default.static(path.resolve("viewer"), { extensions: ["html"] }));
app.use(errorHandler);
const server = app.listen(port, "127.0.0.1", () => {
  const fixturePath = process.env.PINTPATH_PILOT_BROWSER_FIXTURE_PATH ?? "/tmp/pintpath-bar-pilot-browser-fixture.json";
  fs.writeFileSync(fixturePath, JSON.stringify({ origin, databaseName, venueId, accounts: fixtureAccounts }, null, 2), { mode: 0o600 });
  console.info(`Pilot PostgreSQL browser fixture ready at ${origin}; private fixture file: ${fixturePath}`);
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  await database.close();
  await assertPostgresFixtureDisconnected(admin, databaseName);
  await admin.query(`DROP DATABASE ${databaseName}`);
  await admin.end();
  process.exit(0);
}
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
