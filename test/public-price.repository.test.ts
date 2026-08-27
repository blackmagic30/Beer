import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  PublicPriceRepository,
  publicPriceRepositoryLimits,
} from "../src/db/public-price.repository.js";
import { asAsyncSqliteDatabase, type SqlDatabase } from "../src/db/sql-database.js";

const BASE_TIME = "2026-08-08T00:00:00.000Z";
const MINUTE_1 = "2026-08-08T00:01:00.000Z";
const MINUTE_2 = "2026-08-08T00:02:00.000Z";
const MINUTE_3 = "2026-08-08T00:03:00.000Z";
const MINUTE_4 = "2026-08-08T00:04:00.000Z";
const MINUTE_5 = "2026-08-08T00:05:00.000Z";

interface PriceInput {
  id: string;
  venueId?: string;
  venueName?: string;
  beerName?: string;
  normalizedBeerId?: string | null;
  servingSize?: string;
  price?: number | null;
  happy?: boolean;
  happyDetails?: string | null;
  sourceType?: string;
  sourceIngestionId?: string | null;
  sourceEvidenceReference?: string | null;
  sourceEvidenceVerifiedAt?: string | null;
  verifiedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

describe("public price repository", () => {
  let sqlite: BetterSqlite3.Database | null = null;
  let adapter: SqlDatabase | null = null;

  afterEach(() => {
    if (sqlite?.open) sqlite.close();
    sqlite = null;
    adapter = null;
  });

  function createRepository(): PublicPriceRepository {
    sqlite = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(sqlite);
    adapter = asAsyncSqliteDatabase(sqlite);
    return new PublicPriceRepository(adapter);
  }

  function insertPrice(input: PriceInput): void {
    sqlite!.prepare(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, suburb, beer_name, normalized_beer_id,
         serving_size, price, is_happy_hour_price, happy_hour_details,
         is_on_tap, confidence, source_type, source_ingestion_id,
         source_evidence_reference, source_evidence_verified_at,
         last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'Fitzroy', ?, ?, ?, ?, ?, ?, 'yes',
                 'community_confirmed', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.venueId ?? "venue-a",
      input.venueName ?? "Alpha Hotel",
      input.beerName ?? "Carlton Draught",
      input.normalizedBeerId === undefined ? "carlton_draft" : input.normalizedBeerId,
      input.servingSize ?? "pint",
      input.price === undefined ? 12.5 : input.price,
      input.happy ? 1 : 0,
      input.happyDetails ?? null,
      input.sourceType ?? "community_verified",
      input.sourceIngestionId ?? null,
      input.sourceEvidenceReference ?? null,
      input.sourceEvidenceVerifiedAt ?? null,
      input.verifiedAt ?? BASE_TIME,
      input.createdAt ?? BASE_TIME,
      input.updatedAt ?? input.verifiedAt ?? BASE_TIME,
    );
  }

  function insertAlias(aliasVenueId: string, canonicalVenueId: string): void {
    sqlite!.prepare(
      `INSERT INTO venue_identity_aliases (
         alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
       ) VALUES (?, ?, ?, 'test', ?, ?)`,
    ).run(aliasVenueId, canonicalVenueId, `${canonicalVenueId}|test`, BASE_TIME, BASE_TIME);
  }

  function insertProfile(input: {
    venueId: string;
    name?: string;
    tier?: string;
    active?: boolean;
    highlighted?: boolean;
    promoted?: boolean;
    featured?: boolean;
    acceptsCodes?: boolean;
  }): void {
    sqlite!.prepare(
      `INSERT INTO venue_profiles (
         venue_id, name, address, suburb, membership_tier, highlighted_name,
         premium_badge, promoted, featured_special_eligible,
         accepts_pint_path_codes, active, created_at, updated_at
       ) VALUES (?, ?, '1 Test Street', 'Fitzroy', ?, ?, 'Partner', ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.venueId,
      input.name ?? input.venueId,
      input.tier ?? "basic",
      input.highlighted ? 1 : 0,
      input.promoted ? 1 : 0,
      input.featured ? 1 : 0,
      input.acceptsCodes ? 1 : 0,
      input.active === false ? 0 : 1,
      BASE_TIME,
      BASE_TIME,
    );
  }

  function insertManagerBeer(input: {
    id: string;
    venueId?: string;
    beerName?: string;
    normalizedBeerId?: string;
    servingSize?: string;
    price?: number | null;
    verifiedAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
    sourceIngestionId?: string | null;
    onTap?: boolean;
    inStock?: boolean;
  }): void {
    sqlite!.prepare(
      `INSERT INTO venue_beers (
         id, venue_id, beer_name, normalized_beer_id, serve_size, price,
         on_tap, in_stock, price_verified_at, source_ingestion_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.venueId ?? "venue-a",
      input.beerName ?? "Carlton Draught",
      input.normalizedBeerId ?? "carlton_draft",
      input.servingSize ?? "pint",
      input.price === undefined ? 10.5 : input.price,
      input.onTap === false ? 0 : 1,
      input.inStock === false ? 0 : 1,
      input.verifiedAt === undefined ? MINUTE_2 : input.verifiedAt,
      input.sourceIngestionId ?? null,
      input.createdAt ?? BASE_TIME,
      input.updatedAt ?? input.verifiedAt ?? BASE_TIME,
    );
  }

  it("maps linkage/evidence and excludes quarantined rows with deterministic latest ordering", async () => {
    const repository = createRepository();
    insertPrice({
      id: "latest-z",
      price: 13.25,
      verifiedAt: MINUTE_2,
      updatedAt: MINUTE_3,
      sourceIngestionId: "ingestion-1",
      sourceEvidenceReference: "evidence/object-1",
      sourceEvidenceVerifiedAt: MINUTE_3,
    });
    insertPrice({ id: "latest-a", verifiedAt: MINUTE_2, updatedAt: MINUTE_3 });
    insertPrice({ id: "other-venue", venueId: "venue-b", verifiedAt: MINUTE_4 });
    insertPrice({
      id: "quarantined",
      sourceType: "source_ingestion_quarantined",
      verifiedAt: MINUTE_5,
    });

    const latest = await repository.listLatestPriceRecords(10, " venue-a ");
    expect(latest.map((record) => record.id)).toEqual(["latest-z", "latest-a"]);
    expect(latest[0]).toEqual(expect.objectContaining({
      price: 13.25,
      isHappyHourPrice: false,
      hasSourceLinkage: true,
      hasSourceEvidence: true,
      sourceSubmissionId: null,
    }));
    await expect(repository.getPriceRecordById("latest-z")).resolves.toEqual(latest[0]);
    await expect(repository.getPriceRecordById("quarantined")).resolves.toBeNull();
    await expect(repository.listLatestPriceRecords(1)).resolves.toEqual([
      expect.objectContaining({ id: "other-venue" }),
    ]);
  });

  it("deduplicates canonical aliases and ranks every happy-hour identity dimension", async () => {
    const repository = createRepository();
    insertAlias("venue-alias", "venue-canonical");
    insertPrice({
      id: "canonical-old",
      venueId: "venue-canonical",
      verifiedAt: MINUTE_1,
    });
    insertPrice({
      id: "alias-new",
      venueId: "venue-alias",
      verifiedAt: MINUTE_2,
      updatedAt: MINUTE_2,
    });
    insertPrice({
      id: "tie-a",
      venueId: "venue-canonical",
      beerName: "Guinness",
      normalizedBeerId: "guinness",
      verifiedAt: MINUTE_3,
      updatedAt: MINUTE_3,
    });
    insertPrice({
      id: "tie-z",
      venueId: "venue-alias",
      beerName: "Guinness",
      normalizedBeerId: "guinness",
      verifiedAt: MINUTE_3,
      updatedAt: MINUTE_3,
    });
    insertPrice({
      id: "happy-monday",
      venueId: "venue-canonical",
      happy: true,
      happyDetails: "Monday 5-6",
      verifiedAt: MINUTE_4,
    });
    insertPrice({
      id: "happy-friday",
      venueId: "venue-alias",
      happy: true,
      happyDetails: "Friday 5-6",
      verifiedAt: MINUTE_5,
    });
    insertPrice({
      id: "quarantined-current",
      venueId: "venue-canonical",
      sourceType: "source_ingestion_quarantined",
      verifiedAt: MINUTE_5,
    });

    const records = await repository.listCurrentPriceRecords([
      "venue-canonical",
      "venue-alias",
      "venue-canonical",
      "",
    ]);
    expect(records.map((record) => record.id)).toEqual([
      "happy-friday",
      "happy-monday",
      "tie-z",
      "alias-new",
    ]);
    expect(records.filter((record) => record.isHappyHourPrice)).toHaveLength(2);
  });

  it("applies manager inventory precedence but retains happy-hour and newer community records", async () => {
    const repository = createRepository();
    insertProfile({ venueId: "venue-canonical" });
    insertAlias("venue-alias", "venue-canonical");
    insertManagerBeer({
      id: "manager-carlton",
      venueId: "venue-canonical",
      verifiedAt: MINUTE_3,
    });
    insertManagerBeer({
      id: "manager-guinness",
      venueId: "venue-canonical",
      beerName: "Guinness",
      normalizedBeerId: "guinness",
      verifiedAt: MINUTE_2,
    });
    insertPrice({
      id: "community-carlton-old",
      venueId: "venue-alias",
      verifiedAt: MINUTE_2,
    });
    insertPrice({
      id: "community-carlton-happy",
      venueId: "venue-alias",
      happy: true,
      happyDetails: "Weekdays",
      verifiedAt: MINUTE_1,
    });
    insertPrice({
      id: "community-guinness-new",
      venueId: "venue-alias",
      beerName: "Guinness",
      normalizedBeerId: "guinness",
      verifiedAt: MINUTE_4,
    });

    const records = await repository.listCurrentPriceRecordPage({ limit: 20 });
    expect(records.map((record) => record.id)).toEqual([
      "community-guinness-new",
      "community-carlton-happy",
    ]);
  });

  it("uses strict timestamp/id cursors with stable venue-filtered pagination", async () => {
    const repository = createRepository();
    insertPrice({ id: "same-z", verifiedAt: MINUTE_3, beerName: "Beer Z", normalizedBeerId: "z" });
    insertPrice({ id: "same-a", verifiedAt: MINUTE_3, beerName: "Beer A", normalizedBeerId: "a" });
    insertPrice({ id: "older", verifiedAt: MINUTE_2, beerName: "Beer O", normalizedBeerId: "o" });
    insertPrice({
      id: "other-venue",
      venueId: "venue-b",
      beerName: "Beer B",
      normalizedBeerId: "b",
      verifiedAt: MINUTE_4,
    });

    const first = await repository.listCurrentPriceRecordPage({
      venueIds: ["venue-a"],
      limit: 2,
    });
    expect(first.map((record) => record.id)).toEqual(["same-z", "same-a"]);
    const second = await repository.listCurrentPriceRecordPage({
      venueIds: ["venue-a"],
      limit: 2,
      before: { verifiedAt: first[1]!.lastVerifiedAt, id: first[1]!.id },
    });
    expect(second.map((record) => record.id)).toEqual(["older"]);
  });

  it("projects manager beer, happy-hour, and paid-tier special rows without N+1 reads", async () => {
    const repository = createRepository();
    insertProfile({
      venueId: "venue-a",
      name: "Alpha Hotel",
      tier: "plus",
      highlighted: true,
      promoted: true,
      featured: true,
      acceptsCodes: true,
    });
    insertProfile({ venueId: "venue-basic", name: "Basic Hotel", tier: "basic" });
    insertManagerBeer({ id: "beer-visible", price: 9.75, verifiedAt: MINUTE_3 });
    insertManagerBeer({
      id: "beer-quarantined",
      beerName: "Guinness",
      normalizedBeerId: "guinness",
      sourceIngestionId: "ingestion-quarantined",
      verifiedAt: MINUTE_4,
    });
    insertPrice({
      id: "quarantine-ledger",
      sourceType: "source_ingestion_quarantined",
      sourceIngestionId: "ingestion-quarantined",
    });
    sqlite!.prepare(
      `INSERT INTO venue_happy_hours (
         id, venue_id, title, days_of_week_json, start_time, end_time,
         description, happy_hour_beers_json, active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      "happy-1",
      "venue-a",
      "Friday Frothies",
      JSON.stringify(["friday"]),
      "17:00",
      "19:00",
      "Two hours of offers",
      JSON.stringify([{
        beerId: "beer-visible",
        beerName: "Carlton Draught",
        normalizedBeerId: "carlton_draft",
        servingSize: "pint",
        happyHourPrice: 7.5,
        offerText: "$7.50 pints",
        onTap: true,
        inStock: true,
      }]),
      BASE_TIME,
      MINUTE_4,
    );
    const insertSpecial = sqlite!.prepare(
      `INSERT INTO venue_specials (
         id, venue_id, title, description, price, discount, starts_at, ends_at,
         start_time, end_time, schedule_note, exclusive, active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    insertSpecial.run(
      "special-pro",
      "venue-a",
      "Member pint",
      "A launch offer",
      8.25,
      "$2 off",
      BASE_TIME,
      MINUTE_5,
      "17:00",
      "20:00",
      "Friday only",
      1,
      BASE_TIME,
      MINUTE_5,
    );
    insertSpecial.run(
      "special-basic",
      "venue-basic",
      "Must stay private",
      "Not a paid-tier special",
      8,
      null,
      BASE_TIME,
      MINUTE_5,
      null,
      null,
      null,
      0,
      BASE_TIME,
      MINUTE_5,
    );

    const completedBefore = adapter!.metrics().completedQueries;
    const records = await repository.listVenueManagerPriceRecords(20);
    expect(adapter!.metrics().completedQueries - completedBefore).toBe(3);
    expect(records.map((record) => record.id)).toEqual([
      "venue_special:special-pro",
      "bar_happy_hour:happy-1",
      "bar_beer:beer-visible",
    ]);
    expect(records[0]).toEqual(expect.objectContaining({
      displayKind: "special",
      price: 8.25,
      specialExclusive: true,
      sourceType: "venue_manager_portal:pint_path_exclusive",
      membershipTier: "pro",
      highlightedName: true,
      promoted: true,
      featuredSpecialEligible: true,
      acceptsPintPathCodes: true,
    }));
    expect(records[1]).toEqual(expect.objectContaining({
      displayKind: "happy_hour",
      happyHourDays: ["friday"],
      happyHourStartTime: "17:00",
      happyHourEndTime: "19:00",
      happyHourBeers: [expect.objectContaining({
        beerName: "Carlton Draught",
        happyHourPrice: 7.5,
        onTap: true,
      })],
    }));
    expect(records[2]).toEqual(expect.objectContaining({
      displayKind: "beer",
      price: 9.75,
      confidence: "venue_confirmed",
      priceVerifiedAt: MINUTE_3,
    }));
    await expect(repository.getCurrentVenueManagerPriceRecordById("bar_beer:beer-visible"))
      .resolves.toEqual(records[2]);
    await expect(repository.getCurrentVenueManagerPriceRecordById("bar_beer:beer-quarantined"))
      .resolves.toBeNull();
    await expect(repository.getCurrentVenueManagerPriceRecordById("bar_happy_hour:happy-1"))
      .resolves.toBeNull();

    const beforeHappy = await repository.listVenueManagerPriceRecords(
      20,
      "venue-a",
      { verifiedAt: MINUTE_4, id: "bar_happy_hour:happy-1" },
    );
    expect(beforeHappy.map((record) => record.id)).toEqual(["bar_beer:beer-visible"]);
  });

  it("suppresses manager beer inventory when newer community evidence exists", async () => {
    const repository = createRepository();
    insertProfile({ venueId: "venue-a" });
    insertManagerBeer({ id: "manager-old", verifiedAt: MINUTE_2 });
    insertPrice({ id: "community-new", verifiedAt: MINUTE_3 });

    await expect(repository.listVenueManagerPriceRecords(20, "venue-a")).resolves.toEqual([]);
    await expect(repository.getCurrentVenueManagerPriceRecordById("bar_beer:manager-old"))
      .resolves.toBeNull();
  });

  it("bounds dynamic venue filters and propagates adapter query failures", async () => {
    const repository = createRepository();
    const maximum = Array.from(
      { length: publicPriceRepositoryLimits.maxFilterVenueIds },
      (_, index) => `venue-${index}`,
    );
    await expect(repository.listCurrentPriceRecords(maximum)).resolves.toEqual([]);
    await expect(repository.listCurrentPriceRecords([...maximum, "venue-overflow"]))
      .rejects.toThrow("At most 500 venue IDs");

    await adapter!.close();
    sqlite = null;
    await expect(repository.listLatestPriceRecords(10)).rejects.toThrow(/database (?:is closed|connection is not open)/i);
  });
});
