import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { SavedItem } from "../src/db/account-profile-preferences.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { SavedUpdatesReadRepository } from "../src/db/saved-updates-read.repository.js";
import { asAsyncSqliteDatabase, type SqlDatabase } from "../src/db/sql-database.js";
import {
  buildSavedUpdatesFeed,
  savedUpdatesExperimentVariant,
} from "../src/modules/business/saved-updates.js";

const AS_OF = "2026-08-31T12:00:00.000Z";

function treatmentAccountId(): string {
  for (let index = 0; index < 1_000; index += 1) {
    const id = `saved-updates-account-${index}`;
    if (savedUpdatesExperimentVariant(id) === "treatment") return id;
  }
  throw new Error("Could not find deterministic treatment fixture.");
}

describe("no-schema Saved Updates", () => {
  let raw: BetterSqlite3.Database | null = null;
  let database: SqlDatabase | null = null;

  afterEach(async () => {
    await database?.close();
    raw = null;
    database = null;
  });

  function fixture(): { repository: SavedUpdatesReadRepository; accountId: string } {
    raw = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(raw);
    database = asAsyncSqliteDatabase(raw);
    return {
      repository: new SavedUpdatesReadRepository(database),
      accountId: treatmentAccountId(),
    };
  }

  function insertProfile(venueId: string, name: string): void {
    raw!.prepare(
      `INSERT INTO venue_profiles (venue_id, name, suburb, active, created_at, updated_at)
       VALUES (?, ?, 'Fitzroy', 1, '2026-01-01T00:00:00.000Z', '2026-08-30T00:00:00.000Z')`,
    ).run(venueId, name);
  }

  function insertCommunity(input: {
    id: string;
    venueId: string;
    venueName: string;
    beerKey: string;
    beerName: string;
    freshnessAt: string;
    authorityAt: string | null;
    price?: number | null;
    confidence?: string;
    isOnTap?: "yes" | "no" | "unknown";
  }): void {
    raw!.prepare(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, suburb, beer_name, normalized_beer_id,
         serving_size, price, is_happy_hour_price, is_on_tap, confidence,
         source_type, source_evidence_reference, source_evidence_verified_at,
         last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'Fitzroy', ?, ?, 'pint', ?, 0, ?, ?,
                 'admin_manual_capture', ?, ?, ?, '2026-01-01T00:00:00.000Z', ?)`,
    ).run(
      input.id,
      input.venueId,
      input.venueName,
      input.beerName,
      input.beerKey,
      input.price === undefined ? 12.5 : input.price,
      input.isOnTap ?? "yes",
      input.confidence ?? "admin_verified",
      input.authorityAt ? `evidence:${input.id}` : null,
      input.authorityAt,
      input.freshnessAt,
      input.authorityAt ?? input.freshnessAt,
    );
  }

  function savedItem(input: {
    id: string;
    type: "venue" | "beer";
    itemId: string;
    label: string;
    createdAt: string;
  }): SavedItem {
    return {
      id: input.id,
      userId: treatmentAccountId(),
      itemType: input.type,
      itemId: input.itemId,
      label: input.label,
      suburb: input.type === "venue" ? "Fitzroy" : null,
      metadata: {},
      createdAt: input.createdAt,
    };
  }

  it("derives only explicit post-save verification and post-save stale crossings without exposing prices", async () => {
    const { repository, accountId } = fixture();
    insertCommunity({
      id: "verified-record",
      venueId: "venue-verified",
      venueName: "Verified Hotel",
      beerKey: "guinness",
      beerName: "Guinness",
      freshnessAt: "2026-08-28T10:00:00.000Z",
      authorityAt: "2026-08-28T11:00:00.000Z",
      price: 12.34,
    });
    insertCommunity({
      id: "stale-record",
      venueId: "venue-stale",
      venueName: "Stale Hotel",
      beerKey: "carlton_draft",
      beerName: "Carlton Draught",
      freshnessAt: "2026-07-30T12:00:00.000Z",
      authorityAt: "2026-07-30T13:00:00.000Z",
      price: 9.87,
    });
    insertCommunity({
      id: "ambiguous-record",
      venueId: "venue-ambiguous",
      venueName: "Ambiguous Hotel",
      beerKey: "guinness",
      beerName: "Guinness",
      freshnessAt: "2026-08-29T10:00:00.000Z",
      authorityAt: null,
    });

    const before = database!.metrics().completedQueries;
    const feed = await buildSavedUpdatesFeed({
      accountId,
      savedItems: [
        savedItem({
          id: "saved-guinness",
          type: "beer",
          itemId: "guinness",
          label: "Guinness",
          createdAt: "2026-08-20T00:00:00.000Z",
        }),
        savedItem({
          id: "saved-carlton",
          type: "beer",
          itemId: "carlton_draft",
          label: "Carlton Draught",
          createdAt: "2026-07-01T00:00:00.000Z",
        }),
      ],
      asOf: AS_OF,
      repository,
    });

    expect(database!.metrics().completedQueries - before).toBe(1);
    expect(feed).toMatchObject({ enabled: true, variant: "treatment", eligibleResultCount: 2 });
    expect(feed.updates.map((update) => update.type).sort()).toEqual(["became_stale", "verified_after_save"]);
    expect(feed.updates.every((update) => update.mapHref.startsWith("/?venueId="))).toBe(true);
    const serialized = JSON.stringify(feed);
    expect(serialized).not.toContain("12.34");
    expect(serialized).not.toContain("9.87");
    expect(serialized).not.toContain("ambiguous-record");
    expect(serialized).not.toMatch(/cheaper|new verified venue|reconfirmed/i);
  });

  it("resolves venue aliases and chooses the newest manager authority", async () => {
    const { repository, accountId } = fixture();
    insertProfile("venue-canonical", "Canonical Hotel");
    raw!.prepare(
      `INSERT INTO venue_identity_aliases (
         alias_venue_id, canonical_venue_id, identity_key, source, created_at, updated_at
       ) VALUES ('venue-alias', 'venue-canonical', 'canonical|alias', 'test',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    insertCommunity({
      id: "older-community",
      venueId: "venue-canonical",
      venueName: "Canonical Hotel",
      beerKey: "guinness",
      beerName: "Guinness",
      freshnessAt: "2026-08-25T08:00:00.000Z",
      authorityAt: "2026-08-25T09:00:00.000Z",
    });
    raw!.prepare(
      `INSERT INTO venue_beers (
         id, venue_id, beer_name, normalized_beer_id, serve_size, price,
         on_tap, in_stock, price_verified_at, created_at, updated_at
       ) VALUES ('manager-current', 'venue-canonical', 'Guinness', 'guinness', 'pint', 11.11,
                 1, 1, '2026-08-29T09:00:00.000Z',
                 '2026-01-01T00:00:00.000Z', '2026-08-29T09:00:00.000Z')`,
    ).run();

    const feed = await buildSavedUpdatesFeed({
      accountId,
      savedItems: [savedItem({
        id: "saved-alias",
        type: "venue",
        itemId: "venue-alias",
        label: "Canonical Hotel",
        createdAt: "2026-08-20T00:00:00.000Z",
      })],
      asOf: AS_OF,
      repository,
    });

    expect(feed.updates).toHaveLength(1);
    expect(feed.updates[0]).toMatchObject({ type: "verified_after_save" });
    expect(feed.updates[0]!.effectiveAt).toBe("2026-08-29T09:00:00.000Z");
    expect(feed.updates[0]!.mapHref).toContain("venueId=venue-canonical");
    expect(JSON.stringify(feed)).not.toContain("11.11");
  });

  it("does not resurrect trusted-old evidence shadowed by current non-actionable authority", async () => {
    const { repository, accountId } = fixture();
    for (const [venueId, venueName] of [
      ["venue-pending", "Pending Hotel"],
      ["venue-off-tap", "Off Tap Hotel"],
      ["venue-null-price", "Null Price Hotel"],
      ["venue-manager-null", "Manager Null Hotel"],
      ["venue-future", "Future Hotel"],
    ] as const) {
      insertCommunity({
        id: `${venueId}-trusted-old`,
        venueId,
        venueName,
        beerKey: "guinness",
        beerName: "Guinness",
        freshnessAt: "2026-08-27T09:00:00.000Z",
        authorityAt: "2026-08-27T10:00:00.000Z",
      });
    }
    const savedGuinness = savedItem({
      id: "saved-guinness-supersession",
      type: "beer",
      itemId: "guinness",
      label: "Guinness",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    const beforeSupersession = await buildSavedUpdatesFeed({
      accountId,
      savedItems: [savedGuinness],
      asOf: AS_OF,
      repository,
    });
    expect(beforeSupersession.updates).toHaveLength(5);

    insertCommunity({
      id: "pending-current",
      venueId: "venue-pending",
      venueName: "Pending Hotel",
      beerKey: "guinness",
      beerName: "Guinness",
      freshnessAt: "2026-08-29T09:00:00.000Z",
      authorityAt: null,
      confidence: "user_reported_pending",
    });
    insertCommunity({
      id: "off-tap-current",
      venueId: "venue-off-tap",
      venueName: "Off Tap Hotel",
      beerKey: "guinness",
      beerName: "Guinness",
      freshnessAt: "2026-08-29T10:00:00.000Z",
      authorityAt: "2026-08-29T10:30:00.000Z",
      isOnTap: "no",
    });
    insertCommunity({
      id: "null-price-current",
      venueId: "venue-null-price",
      venueName: "Null Price Hotel",
      beerKey: "guinness",
      beerName: "Guinness",
      freshnessAt: "2026-08-29T11:00:00.000Z",
      authorityAt: "2026-08-29T11:30:00.000Z",
      price: null,
    });
    insertCommunity({
      id: "future-current",
      venueId: "venue-future",
      venueName: "Future Hotel",
      beerKey: "guinness",
      beerName: "Guinness",
      freshnessAt: "2026-09-02T09:00:00.000Z",
      authorityAt: "2026-09-02T10:00:00.000Z",
    });
    insertProfile("venue-manager-null", "Manager Null Hotel");
    raw!.prepare(
      `INSERT INTO venue_beers (
         id, venue_id, beer_name, normalized_beer_id, serve_size, price,
         on_tap, in_stock, price_verified_at, created_at, updated_at
       ) VALUES ('manager-null-current', 'venue-manager-null', 'Guinness', 'guinness',
                 'pint', NULL, 1, 1, NULL,
                 '2026-08-29T12:00:00.000Z', '2026-08-29T12:00:00.000Z')`,
    ).run();

    const afterSupersession = await buildSavedUpdatesFeed({
      accountId,
      savedItems: [savedGuinness],
      asOf: AS_OF,
      repository,
    });
    expect(afterSupersession).toMatchObject({
      enabled: true,
      variant: "treatment",
      eligibleResultCount: 0,
      updates: [],
    });
  });

  it("fails closed when more than 100 eligible results match", async () => {
    const { repository, accountId } = fixture();
    for (let index = 0; index < 101; index += 1) {
      insertCommunity({
        id: `record-${index}`,
        venueId: `venue-${index}`,
        venueName: `Venue ${index}`,
        beerKey: "guinness",
        beerName: "Guinness",
        freshnessAt: "2026-08-28T10:00:00.000Z",
        authorityAt: "2026-08-28T11:00:00.000Z",
      });
    }
    const feed = await buildSavedUpdatesFeed({
      accountId,
      savedItems: [savedItem({
        id: "saved-guinness",
        type: "beer",
        itemId: "guinness",
        label: "Guinness",
        createdAt: "2026-08-20T00:00:00.000Z",
      })],
      asOf: AS_OF,
      repository,
    });
    expect(feed).toMatchObject({ enabled: false, updates: [], revision: null, eligibleResultCount: 0 });
  });

  it("keeps assignment stable and gives control accounts no evidence query", async () => {
    const { repository } = fixture();
    let controlId = "";
    for (let index = 0; index < 1_000; index += 1) {
      const candidate = `control-${index}`;
      if (savedUpdatesExperimentVariant(candidate) === "control") {
        controlId = candidate;
        break;
      }
    }
    expect(controlId).not.toBe("");
    const before = database!.metrics().completedQueries;
    const feed = await buildSavedUpdatesFeed({
      accountId: controlId,
      savedItems: [savedItem({
        id: "saved-guinness",
        type: "beer",
        itemId: "guinness",
        label: "Guinness",
        createdAt: "2026-08-20T00:00:00.000Z",
      })],
      asOf: AS_OF,
      repository,
    });
    expect(feed).toMatchObject({ enabled: true, variant: "control", updates: [], revision: null });
    expect(database!.metrics().completedQueries - before).toBe(0);
    expect(savedUpdatesExperimentVariant(controlId)).toBe("control");
  });
});
