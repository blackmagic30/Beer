import crypto from "node:crypto";
import fs from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { VenueIdentityRepository } from "../src/db/venue-identity.repository.js";
import { createPilotTestService, PilotLoopbackDatabase } from "./helpers/pilot-postgres-runtime.js";
import { assertPostgresFixtureDisconnected } from "./helpers/postgres-pool-shutdown.js";

const configuredAdminUrl = process.env.PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL?.trim();

describe.skipIf(!configuredAdminUrl)("public price feed on the two-connection PostgreSQL runtime budget", () => {
  let admin: Client;
  let target: Client;
  let database: PilotLoopbackDatabase;
  let databaseName: string;
  let login: string;
  const count = 400;

  beforeAll(async () => {
    const url = new URL(configuredAdminUrl!);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)
      || url.pathname !== "/postgres" || url.searchParams.get("sslmode") !== "disable") {
      throw new Error("An isolated loopback PostgreSQL administrator is required.");
    }
    admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    const suffix = `${process.pid}_${crypto.randomBytes(3).toString("hex")}`;
    databaseName = `pintpath_pilot_price_${suffix}`;
    login = `pintpath_price_${suffix}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
    url.pathname = `/${databaseName}`;
    target = new Client({ connectionString: url.toString() });
    await target.connect();
    await target.query(fs.readFileSync("src/db/postgres-schema.sql", "utf8"));
    const password = crypto.randomBytes(24).toString("hex");
    await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2`);
    await admin.query(`GRANT pintpath_runtime TO ${login}`);
    url.username = login;
    url.password = password;
    // Real queries hold the two connections for a small deterministic transport
    // delay. Per-row fanout exceeds checkout time; page-sized queries do not.
    database = new PilotLoopbackDatabase(url.toString(), {
      maxConnections: 2, connectionTimeoutMs: 1000, queryDelayMs: 20,
    });
    await target.query(`
      SET search_path = pintpath_app, pg_catalog;
      INSERT INTO accounts (id,email,password_hash,created_at,updated_at)
        VALUES ('contributor','contributor@example.test','fixture',now(),now());
      INSERT INTO venue_identity_aliases
        (alias_venue_id,canonical_venue_id,identity_key,source,created_at,updated_at)
        SELECT 'alias-'||n, 'middle-'||n, 'hotel-'||n, 'manual_test', now(), now()
          FROM generate_series(1,${count}) n;
      INSERT INTO venue_identity_aliases
        (alias_venue_id,canonical_venue_id,identity_key,source,created_at,updated_at)
        SELECT 'middle-'||n, 'venue-'||n, 'hotel-'||n, 'manual_test', now(), now()
          FROM generate_series(1,${count}) n;
      INSERT INTO submissions
        (id,user_id,venue_id,venue_name,status,submission_type,observed_at,created_at,updated_at)
        SELECT 'submission-'||n,'contributor','venue-'||n,'Hotel '||n,'approved','manual',now(),now(),now()
          FROM generate_series(1,${count}) n;
      INSERT INTO source_evidence_objects (id,object_path,created_at)
        SELECT 'evidence-'||n,'private/'||n,now() FROM generate_series(1,${count}) n WHERE n % 2 = 0;
      INSERT INTO submission_source_evidence (submission_id,evidence_id,created_at)
        SELECT 'submission-'||n,'evidence-'||n,now() FROM generate_series(1,${count}) n WHERE n % 2 = 0;
      INSERT INTO venue_price_records
        (id,venue_id,venue_name,beer_name,normalized_beer_id,serving_size,price,is_on_tap,
         confidence,source_type,source_submission_id,last_verified_at,created_at,updated_at)
        SELECT 'price-'||lpad(n::text,3,'0'),'alias-'||n,'Hotel '||n,'Carlton Draught','carlton_draft',
          'pint',12,'yes','community_confirmed','community_submission','submission-'||n,
          '2026-09-10T00:00:00Z'::timestamptz,now(),now()
          FROM generate_series(1,${count}) n;
    `);
  }, 30000);

  afterAll(async () => {
    try {
      await database?.close();
      await target?.end();
      if (admin && databaseName) {
        await assertPostgresFixtureDisconnected(admin, databaseName);
        await admin.query(`DROP DATABASE ${databaseName}`);
      }
      if (admin && login) await admin.query(`DROP ROLE ${login}`);
    } finally {
      await admin?.end();
    }
  });

  it("resolves a full alias batch through all hops without exhausting the bounded pool", async () => {
    const ids = Array.from({ length: count }, (_, index) => `alias-${index + 1}`);
    const before = database.metrics().completedQueries;
    const result = await new VenueIdentityRepository(database).getCanonicalVenueIds(ids);
    expect(result.size).toBe(count);
    for (const [index, id] of ids.entries()) expect(result.get(id)).toBe(`venue-${index + 1}`);
    expect(database.metrics().totalConnections).toBeLessThanOrEqual(2);
    expect(database.metrics().waitingRequests).toBe(0);
    expect(database.metrics().completedQueries - before).toBeLessThanOrEqual(3);
  });

  it("returns complete anonymous pages with canonical venues and correct evidence presence", async () => {
    const service = createPilotTestService(database, { ...env,
      NODE_ENV: "test", PUBLIC_BASE_URL: "http://127.0.0.1",
      SUPABASE_URL: undefined, SUPABASE_ANON_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined,
      BAR_PILOT_ENABLED: true, BAR_PILOT_VENUE_IDS: "venue-1",
      COMMERCIAL_LAUNCH_ENABLED: false, PINT_POINTS_REWARDS_ENABLED: false,
      ALCOHOL_GAMIFICATION_ENABLED: false,
    });
    const before = database.metrics().completedQueries;
    const first = await service.listPriceRecords(null, { limit: 200, anonymousSessionId: "price-feed-test" });
    expect(database.metrics().completedQueries - before).toBeLessThanOrEqual(10);
    expect(first.records).toHaveLength(200);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await service.listPriceRecords(null, {
      limit: 200, anonymousSessionId: "price-feed-test", cursor: first.nextCursor!,
    });
    expect(second.records).toHaveLength(200);
    expect(second.nextCursor).toBeNull();
    const records = [...first.records, ...second.records];
    expect(new Set(records.map(({ id }) => id)).size).toBe(count);
    for (const record of records) {
      const n = Number(record.id.slice("price-".length));
      expect(record).toMatchObject({ venueId: `venue-${n}`, price: 12,
        hasSourceLinkage: true, hasSourceEvidence: n % 2 === 0, sourceSubmissionId: null });
    }
    expect(database.metrics().totalConnections).toBeLessThanOrEqual(2);
    expect(database.metrics().waitingRequests).toBe(0);
    expect(database.metrics().completedQueries - before).toBeLessThanOrEqual(20);
  }, 10000);
});
