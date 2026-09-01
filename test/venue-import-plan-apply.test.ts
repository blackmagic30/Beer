import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PERMANENT_STAGING_SUPABASE_PROJECT_REF,
  VENUE_IMPORT_DATABASE_CONTRACT,
  VENUE_IMPORT_PLAN_SCHEMA,
  VENUE_IMPORT_TERMINAL_SCHEMA,
  applyVenueImportPlan,
  buildVenueImportPlan,
  canonicalJson,
  normalizeVenueRow,
  parseVenueImportPlan,
  type VenueImportApplyAdapter,
  type VenueImportPlan,
  type VenueManagedState,
  type VenuePayload,
  type VenueRow,
} from "../scripts/import-melbourne-venues.js";

const CANDIDATE_SHA = "1".repeat(40);
const STARTED_AT = "2026-09-01T03:30:00.000Z";
const CHECKED_AT = "2026-09-01T03:31:00.000Z";
const COMPLETED_AT = "2026-09-01T03:32:00.000Z";

function row(overrides: Partial<VenueRow> = {}): VenueRow {
  return {
    id: "venue-1",
    google_place_id: "place-1",
    name: "Existing Hotel",
    address: "1 Existing St, Melbourne VIC 3000, Australia",
    suburb: "Melbourne",
    state: "VIC",
    postcode: "3000",
    phone: "+61 3 9000 1000",
    website: "https://existing.example/",
    latitude: -37.8136,
    longitude: 144.9631,
    business_status: "OPERATIONAL",
    last_checked_at: "2026-08-31T03:31:00.000Z",
    directory_eligible: true,
    source: "google_places_bar_pub",
    ...overrides,
  };
}

function venue(overrides: Partial<VenuePayload> = {}): VenuePayload {
  return {
    google_place_id: "place-1",
    name: "Existing Hotel",
    address: "1 Existing St, Melbourne VIC 3000, Australia",
    suburb: "Melbourne",
    state: "VIC",
    postcode: "3000",
    phone: "+61 3 9000 1000",
    website: "https://existing.example/",
    latitude: -37.8136,
    longitude: 144.9631,
    business_status: "OPERATIONAL",
    last_checked_at: CHECKED_AT,
    directory_eligible: true,
    source: "google_places_bar_pub",
    ...overrides,
  };
}

function buildPlan(): VenueImportPlan {
  const existingRows = [
    row(),
    row({
      id: "venue-2",
      google_place_id: "place-closed",
      name: "Closed Hotel",
      address: "2 Closed St, Melbourne VIC 3000, Australia",
    }),
  ];
  return buildVenueImportPlan({
    candidateSha: CANDIDATE_SHA,
    supabaseProjectRef: PERMANENT_STAGING_SUPABASE_PROJECT_REF,
    operation: "directory-discovery-and-status-refresh",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    checkedAt: CHECKED_AT,
    existingRows,
    discoveredVenues: [
      venue(),
      venue({
        google_place_id: "place-2",
        name: "New Hotel",
        address: "3 New St, Melbourne VIC 3000, Australia",
        website: "https://new.example/",
      }),
    ],
    statusOnlyUpdates: new Map([
      [
        "venue-2",
        {
          business_status: "CLOSED_PERMANENTLY",
          last_checked_at: CHECKED_AT,
          directory_eligible: false as const,
        },
      ],
    ]),
    collection: {
      discoveryCellAttemptedCount: 1,
      discoveryCellSuccessfulCount: 1,
      discoveryCellFailureCount: 0,
      discoveryQueryAttemptedCount: 0,
      discoveryQuerySuccessfulCount: 0,
      discoveryQueryFailureCount: 0,
      existingPlaceIdAttemptedCount: 1,
      existingPlaceIdSuccessfulCount: 1,
      existingPlaceIdFailureCount: 0,
      existingPlaceIdSatisfiedByDiscoveryCount: 1,
      existingRowMissingPlaceIdCount: 0,
      quarantinedVenueCount: 0,
    },
  });
}

function cloneRows(rows: readonly VenueRow[]): VenueRow[] {
  return structuredClone(rows);
}

function memoryAdapter(
  initialRows: readonly VenueRow[],
  options: {
    failWriteNumber?: number;
    driftPostflight?: boolean;
  } = {},
): VenueImportApplyAdapter & {
  writes: Array<"insert" | "update">;
} {
  const state = cloneRows(initialRows);
  const writes: Array<"insert" | "update"> = [];
  let readCount = 0;
  const maybeFail = () => {
    if (writes.length === options.failWriteNumber) {
      throw new Error("fixture write failure");
    }
  };
  return {
    writes,
    async readRows() {
      readCount += 1;
      const result = cloneRows(state);
      if (options.driftPostflight && readCount > 1) {
        result[0] = { ...result[0]!, name: "Unexpected concurrent edit" };
      }
      return result;
    },
    async insert(desiredAfter) {
      writes.push("insert");
      maybeFail();
      const inserted: VenueRow = {
        id: `venue-inserted-${writes.length}`,
        ...structuredClone(desiredAfter),
      };
      state.push(inserted);
      return cloneRows([inserted])[0]!;
    },
    async update(expectedBefore, desiredAfter) {
      writes.push("update");
      maybeFail();
      const index = state.findIndex(
        (candidate) => candidate.id === expectedBefore.id,
      );
      if (
        index < 0 ||
        canonicalJson(normalizeVenueRow(state[index]!)) !==
          canonicalJson(expectedBefore)
      ) {
        throw new Error("fixture exact-before mismatch");
      }
      const updated: VenueRow = {
        id: expectedBefore.id,
        ...structuredClone(desiredAfter),
      };
      state[index] = updated;
      return cloneRows([updated])[0]!;
    },
  };
}

describe("permanent-staging venue import plan/apply evidence", () => {
  it("orders the frozen venue snapshot by primary key before offset pagination", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/import-melbourne-venues.ts"),
      "utf8",
    );
    const fetchStart = source.indexOf("async function fetchExistingVenues()");
    const fetchEnd = source.indexOf("\nasync function", fetchStart + 1);
    const fetchSource = source.slice(fetchStart, fetchEnd);

    expect(fetchStart).toBeGreaterThanOrEqual(0);
    expect(fetchSource).toContain(
      '.select(VENUE_MANAGED_SELECT)\n      .order("id", { ascending: true })\n      .range(from, to)',
    );
  });

  it("builds and parses a canonical, candidate-bound, secret-free plan", () => {
    const plan = buildPlan();

    expect(plan).toMatchObject({
      schemaVersion: VENUE_IMPORT_PLAN_SCHEMA,
      candidateSha: CANDIDATE_SHA,
      supabaseProjectRef: PERMANENT_STAGING_SUPABASE_PROJECT_REF,
      databaseContract: VENUE_IMPORT_DATABASE_CONTRACT,
      operation: "directory-discovery-and-status-refresh",
      inputSnapshot: { rowCount: 2 },
      projected: {
        insertCount: 1,
        updateCount: 1,
        exclusionCount: 1,
        totalTransitionCount: 3,
      },
    });
    expect(plan.transitions.map((transition) => transition.operation)).toEqual([
      "update",
      "insert",
      "exclude",
    ]);
    expect(plan.collection).toMatchObject({
      existingPlaceIdAttemptedCount: 1,
      existingPlaceIdSuccessfulCount: 1,
      existingPlaceIdFailureCount: 0,
      discoveryCellFailureCount: 0,
      discoveryQueryFailureCount: 0,
    });

    const source = `${canonicalJson(plan)}\n`;
    expect(parseVenueImportPlan(source)).toEqual(plan);
    expect(source).not.toMatch(
      /api[_-]?key|service[_-]?role|authorization|bearer/i,
    );
  });

  it("rejects plan tampering, extra keys, and incomplete collection evidence", () => {
    const plan = buildPlan();
    expect(() =>
      parseVenueImportPlan(
        JSON.stringify({
          ...plan,
          candidateSha: "2".repeat(40),
        }),
      ),
    ).toThrow(/digest does not match/i);
    expect(() =>
      parseVenueImportPlan(
        JSON.stringify({
          ...plan,
          secretCommitment: "forbidden",
        }),
      ),
    ).toThrow(/unexpected shape/i);
    expect(() =>
      parseVenueImportPlan(`${JSON.stringify(plan, null, 2)}\n`),
    ).toThrow(/not exact canonical json/i);

    expect(() =>
      buildVenueImportPlan({
        candidateSha: CANDIDATE_SHA,
        supabaseProjectRef: PERMANENT_STAGING_SUPABASE_PROJECT_REF,
        operation: "existing-place-status-refresh",
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
        checkedAt: CHECKED_AT,
        existingRows: [],
        discoveredVenues: [],
        statusOnlyUpdates: new Map(),
        collection: {
          discoveryCellAttemptedCount: 1,
          discoveryCellSuccessfulCount: 0,
          discoveryCellFailureCount: 1,
          discoveryQueryAttemptedCount: 0,
          discoveryQuerySuccessfulCount: 0,
          discoveryQueryFailureCount: 0,
          existingPlaceIdAttemptedCount: 0,
          existingPlaceIdSuccessfulCount: 0,
          existingPlaceIdFailureCount: 0,
          existingPlaceIdSatisfiedByDiscoveryCount: 0,
          existingRowMissingPlaceIdCount: 0,
          quarantinedVenueCount: 0,
        },
      }),
    ).toThrow(/incomplete venue evidence/i);

    expect(() =>
      buildVenueImportPlan({
        candidateSha: CANDIDATE_SHA,
        supabaseProjectRef: PERMANENT_STAGING_SUPABASE_PROJECT_REF,
        operation: "directory-discovery-and-status-refresh",
        startedAt: STARTED_AT,
        completedAt: COMPLETED_AT,
        checkedAt: CHECKED_AT,
        existingRows: [],
        discoveredVenues: [
          venue({
            google_place_id: "place-invalid-postcode",
            postcode: "300",
          }),
        ],
        statusOnlyUpdates: new Map(),
        collection: {
          discoveryCellAttemptedCount: 1,
          discoveryCellSuccessfulCount: 1,
          discoveryCellFailureCount: 0,
          discoveryQueryAttemptedCount: 0,
          discoveryQuerySuccessfulCount: 0,
          discoveryQueryFailureCount: 0,
          existingPlaceIdAttemptedCount: 0,
          existingPlaceIdSuccessfulCount: 0,
          existingPlaceIdFailureCount: 0,
          existingPlaceIdSatisfiedByDiscoveryCount: 0,
          existingRowMissingPlaceIdCount: 0,
          quarantinedVenueCount: 0,
        },
      }),
    ).toThrow(/postcode must be null or exactly four digits/i);
  });

  it("applies the exact plan and proves the final snapshot", async () => {
    const plan = buildPlan();
    const beforeRows = plan.transitions.flatMap(
      (transition) => transition.expectedBefore ?? [],
    ) as VenueRow[];
    const adapter = memoryAdapter(beforeRows);
    const times = [
      new Date("2026-09-01T04:00:00.000Z"),
      new Date("2026-09-01T04:00:01.000Z"),
    ];
    const receipt = await applyVenueImportPlan(
      plan,
      adapter,
      () => times.shift() ?? new Date("2026-09-01T04:00:01.000Z"),
    );

    expect(receipt).toMatchObject({
      schemaVersion: VENUE_IMPORT_TERMINAL_SCHEMA,
      status: "succeeded",
      outcome: "applied",
      candidateSha: CANDIDATE_SHA,
      supabaseProjectRef: PERMANENT_STAGING_SUPABASE_PROJECT_REF,
      databaseContract: VENUE_IMPORT_DATABASE_CONTRACT,
      planSha256: plan.planSha256,
      attemptedWriteCount: 3,
      successfulWriteCount: 3,
      insertedCount: 1,
      updatedCount: 1,
      excludedCount: 1,
      partialWrite: false,
      samePlanRetryAllowed: false,
      failure: null,
    });
    expect(receipt.finalSnapshot?.rowCount).toBe(3);
    expect(adapter.writes).toEqual(["update", "insert", "update"]);
  });

  it("fails before writes when the database snapshot drifted", async () => {
    const plan = buildPlan();
    const beforeRows = plan.transitions.flatMap(
      (transition) => transition.expectedBefore ?? [],
    ) as VenueRow[];
    beforeRows[0] = { ...beforeRows[0]!, name: "Concurrent edit" };
    const adapter = memoryAdapter(beforeRows);
    const receipt = await applyVenueImportPlan(plan, adapter);

    expect(receipt).toMatchObject({
      status: "failed",
      outcome: "preflight_failed",
      attemptedWriteCount: 0,
      successfulWriteCount: 0,
      partialWrite: false,
      samePlanRetryAllowed: false,
      failure: {
        phase: "preflight",
        code: "INPUT_SNAPSHOT_DRIFT",
      },
    });
    expect(adapter.writes).toEqual([]);
  });

  it("makes a partial write terminal and forbids retrying the same plan", async () => {
    const plan = buildPlan();
    const beforeRows = plan.transitions.flatMap(
      (transition) => transition.expectedBefore ?? [],
    ) as VenueRow[];
    const adapter = memoryAdapter(beforeRows, { failWriteNumber: 2 });
    const receipt = await applyVenueImportPlan(plan, adapter);

    expect(receipt).toMatchObject({
      status: "failed",
      outcome: "partial_write_unretryable",
      attemptedWriteCount: 2,
      successfulWriteCount: 1,
      partialWrite: true,
      samePlanRetryAllowed: false,
      failure: {
        phase: "write",
        code: "WRITE_ERROR",
      },
    });
  });

  it("fails closed when postflight state differs from the exact desired snapshot", async () => {
    const plan = buildPlan();
    const beforeRows = plan.transitions.flatMap(
      (transition) => transition.expectedBefore ?? [],
    ) as VenueRow[];
    const adapter = memoryAdapter(beforeRows, { driftPostflight: true });
    const receipt = await applyVenueImportPlan(plan, adapter);

    expect(receipt).toMatchObject({
      status: "failed",
      outcome: "postflight_failed",
      attemptedWriteCount: 3,
      successfulWriteCount: 3,
      partialWrite: true,
      samePlanRetryAllowed: false,
      failure: {
        phase: "postflight",
        code: "FINAL_SNAPSHOT_MISMATCH",
      },
    });
  });

  it("writes a terminal failure receipt even when apply input is invalid", () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-venue-apply-"),
    );
    const receiptPath = path.join(temporaryDirectory, "terminal.json");
    const scriptPath = path.resolve(
      process.cwd(),
      "scripts/import-melbourne-venues.ts",
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        "--mode=apply",
        `--plan-input=${path.join(temporaryDirectory, "missing-plan.json")}`,
        `--receipt-output=${receiptPath}`,
        `--candidate-sha=${CANDIDATE_SHA}`,
        `--expected-project-ref=${PERMANENT_STAGING_SUPABASE_PROJECT_REF}`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          GOOGLE_PLACES_API_KEY: "must-not-be-read-or-committed",
        },
      },
    );

    expect(result.status).toBe(1);
    const source = fs.readFileSync(receiptPath, "utf8");
    expect(source.endsWith("\n")).toBe(true);
    expect(source).not.toContain("must-not-be-read-or-committed");
    expect(JSON.parse(source)).toMatchObject({
      schemaVersion: VENUE_IMPORT_TERMINAL_SCHEMA,
      status: "failed",
      outcome: "preflight_failed",
      candidateSha: CANDIDATE_SHA,
      supabaseProjectRef: PERMANENT_STAGING_SUPABASE_PROJECT_REF,
      databaseContract: VENUE_IMPORT_DATABASE_CONTRACT,
      planSha256: null,
      attemptedWriteCount: 0,
      successfulWriteCount: 0,
      partialWrite: false,
      samePlanRetryAllowed: false,
      failure: {
        phase: "input",
        code: "APPLY_INPUT_INVALID",
      },
    });
  });
});
