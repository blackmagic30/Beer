import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminIngestionQueueRepository } from "../src/db/admin-ingestion-queue.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { PublicPriceRepository } from "../src/db/public-price.repository.js";
import { PublicVenueDirectoryRepository } from "../src/db/public-venue-directory.repository.js";
import { asAsyncSqliteDatabase } from "../src/db/sql-database.js";
import { REVIEWED_PRICE_SELECTION_POLICY_SHA256 } from "../src/lib/reviewed-price-selection-policy.js";
import {
  PRODUCTION_MAP_BASE_POLICY,
  PRODUCTION_SUPABASE_PROJECT_REF,
  PRODUCTION_SUPABASE_CUSTOM_ORIGIN,
  assertExactSupabaseProjectTarget,
  assertProductionMutationTarget,
  assertReviewedManifestMutationTarget,
  buildPromotionReceipt,
  buildQuarantineReceipt,
  buildReviewedPricePromotionManifest,
  canonicalJson,
  executeReviewedPricePromotion,
  executeReviewedPriceQuarantine,
  isPrivateOrReservedAddress,
  loadReviewedPricePromotionManifest,
  loadPromotionReceiptAuthority,
  sha256Bytes,
  sha256Json,
  validateApplyControls,
  writeNewJsonArtifact,
  type PromotionApplyControls,
  type InProgressPromotionReceipt,
  type PromotionReceipt,
  type ReviewedPricePromotionManifest,
} from "../scripts/promote-reviewed-price-data.js";

const INGESTION_ID = "11111111-1111-4111-8111-111111111111";
const VENUE_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_INGESTION_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_VENUE_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_REF = PRODUCTION_SUPABASE_PROJECT_REF;
const NOW = new Date("2026-07-28T02:00:00.000Z");
const SAVED_AT = "2026-07-28T01:59:00.000Z";
const HASH = "a".repeat(64);
const CANDIDATE_SHA = "c".repeat(40);

let database: BetterSqlite3.Database | null = null;
let temporaryRoot: string | null = null;

afterEach(() => {
  database?.close();
  database = null;
  if (temporaryRoot) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = null;
  }
  vi.restoreAllMocks();
});

async function createFixture(): Promise<{
  database: BetterSqlite3.Database;
  databasePath: string;
  repository: AdminIngestionQueueRepository;
}> {
  temporaryRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-price-promotion-")),
  );
  const databasePath = path.join(temporaryRoot, "pint-path.sqlite");
  database = new BetterSqlite3(databasePath);
  initializeDatabaseSchema(database);
  const repository = new AdminIngestionQueueRepository(asAsyncSqliteDatabase(database));
  const created = await repository.create({
    capturedNotes: "Public regular drinks menu.",
    errorMessage: null,
    extractedBeers: [
      {
        availabilityStatus: "on_tap",
        availableOnTap: true,
        availablePackageOnly: false,
        confidence: 0.93,
        name: "Carlton Draught",
        needsReview: true,
        notes: null,
        priceNumeric: 13.5,
        priceText: "$13.50 pint",
        servingSize: "pint",
        unavailableReason: null,
      },
    ],
    imageDataUrl: null,
    note: "Crawler import for human review.",
    overallConfidence: 0.9,
    sourceType: "source_reference",
    sourceUrl: "https://example.com/drinks-menu.pdf",
    status: "pending_review",
    venueId: VENUE_ID,
    venueName: "Test Venue",
    venueNameGuess: "Test Venue",
  });
  database.prepare(
    `UPDATE admin_ingestion_queue
        SET id = ?, created_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    INGESTION_ID,
    "2026-07-28T00:00:00.000Z",
    "2026-07-28T00:01:00.000Z",
    created.id,
  );
  return { database, databasePath, repository };
}

async function createManifest(): Promise<ReviewedPricePromotionManifest> {
  const fixture = await createFixture();
  return buildReviewedPricePromotionManifest({
    candidateSha: CANDIDATE_SHA,
    database: fixture.database,
    databasePath: fixture.databasePath,
    ids: [INGESTION_ID],
    sourceVerifier: async () => undefined,
    supabaseOrigin: `https://${PROJECT_REF}.supabase.co`,
    supabaseProjectRef: PROJECT_REF,
  });
}

async function createTwoItemManifest(): Promise<ReviewedPricePromotionManifest> {
  const fixture = await createFixture();
  const created = await fixture.repository.create({
    capturedNotes: "Second public regular drinks menu.",
    errorMessage: null,
    extractedBeers: [
      {
        availabilityStatus: "on_tap",
        availableOnTap: true,
        availablePackageOnly: false,
        confidence: 0.94,
        name: "Guinness",
        needsReview: true,
        notes: null,
        priceNumeric: 14,
        priceText: "$14 pint",
        servingSize: "pint",
        unavailableReason: null,
      },
    ],
    imageDataUrl: null,
    note: "Second crawler import for human review.",
    overallConfidence: 0.91,
    sourceType: "source_reference",
    sourceUrl: "https://example.com/second-drinks-menu.pdf",
    status: "pending_review",
    venueId: SECOND_VENUE_ID,
    venueName: "Second Test Venue",
    venueNameGuess: "Second Test Venue",
  });
  fixture.database.prepare(
    `UPDATE admin_ingestion_queue
        SET id = ?, created_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    SECOND_INGESTION_ID,
    "2026-07-28T00:03:00.000Z",
    "2026-07-28T00:04:00.000Z",
    created.id,
  );
  return buildReviewedPricePromotionManifest({
    candidateSha: CANDIDATE_SHA,
    database: fixture.database,
    databasePath: fixture.databasePath,
    ids: [SECOND_INGESTION_ID, INGESTION_ID],
    sourceVerifier: async () => undefined,
    supabaseOrigin: `https://${PROJECT_REF}.supabase.co`,
    supabaseProjectRef: PROJECT_REF,
  });
}

function controls(overrides: Partial<PromotionApplyControls> = {}): PromotionApplyControls {
  return {
    approvalReference: "CHANGE-2026-071",
    backupId: "pint-path-2026-07-28T01-45-00-000Z",
    backupManifestSha256: HASH,
    backupVerifiedAt: "2026-07-28T01:45:00.000Z",
    operator: "operator@example.test",
    reviewer: "reviewer@example.test",
    ...overrides,
  };
}

function disabledProductionEnvironment(): NodeJS.ProcessEnv {
  return {
    ALCOHOL_GAMIFICATION_ENABLED: "false",
    COMMERCIAL_LAUNCH_ENABLED: "false",
    CONSUMER_PAID_ENROLLMENT_ENABLED: "false",
    NODE_ENV: "production",
    PINT_POINTS_REWARDS_ENABLED: "false",
  };
}

function insertPublishedRows(
  target: BetterSqlite3.Database,
  manifest: ReviewedPricePromotionManifest,
  options: { evidence?: boolean } = {},
): void {
  for (const item of manifest.items) {
    insertPublishedItem(target, item, options);
  }
}

function insertPublishedItem(
  target: BetterSqlite3.Database,
  item: ReviewedPricePromotionManifest["items"][number],
  options: { evidence?: boolean } = {},
): void {
  const evidence = options.evidence !== false;
  const statement = target.prepare(
    `INSERT INTO venue_price_records (
       id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, serving_size,
       price, is_happy_hour_price, happy_hour_details, is_on_tap, confidence,
       source_type, source_submission_id, source_ingestion_id, source_evidence_reference,
       source_evidence_verified_at, last_verified_at, created_at, updated_at
     ) VALUES (
       @id, @venueId, @venueName, NULL, @beerName, NULL, @servingSize,
       @price, 0, NULL, 'yes', 'admin_verified',
       'source_ingestion', NULL, @sourceIngestionId, @sourceEvidenceReference,
       @sourceEvidenceVerifiedAt, @lastVerifiedAt, @createdAt, @updatedAt
     )`,
  );
  item.rows.forEach((row, index) => statement.run({
    beerName: row.name,
    createdAt: SAVED_AT,
    id: `source-ingestion:${item.id}:${index}`,
    lastVerifiedAt: SAVED_AT,
    price: row.priceNumeric,
    servingSize: row.servingSize,
    sourceEvidenceReference: evidence ? `source-ingestion:${item.id}` : null,
    sourceEvidenceVerifiedAt: evidence ? SAVED_AT : null,
    sourceIngestionId: item.id,
    updatedAt: SAVED_AT,
    venueId: item.venueId,
    venueName: item.venueName,
  }));
}

async function createSuccessfulPromotionReceipt(
  manifest: ReviewedPricePromotionManifest,
): Promise<{ path: string; receipt: PromotionReceipt; sha256: string }> {
  const execution = await executeReviewedPricePromotion({
    controls: controls(),
    database: database!,
    manifest,
    publisher: async () => {
      insertPublishedRows(database!, manifest);
      return { mapPriceRecordCount: manifest.rowCount, savedAt: SAVED_AT };
    },
    sourceVerifier: async () => undefined,
  });
  expect(execution.succeeded).toBe(true);
  const receiptPath = path.join(temporaryRoot!, "promotion-receipt.json");
  const receipt = buildPromotionReceipt({
    appliedAt: NOW.toISOString(),
    controls: controls(),
    execution,
    manifest,
    manifestPath: path.join(temporaryRoot!, "reviewed-manifest.json"),
    manifestSha256: HASH,
  });
  return {
    path: receiptPath,
    receipt,
    sha256: sha256Bytes(canonicalJson(receipt)),
  };
}

describe("reviewed production price promotion", () => {
  it("exposes a separate strict CLI without mutable production selection switches and fails nonzero on invalid use", () => {
    const packageJson = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "package.json"),
      "utf8",
    )) as { scripts: Record<string, string> };
    const source = fs.readFileSync(
      path.join(process.cwd(), "scripts/promote-reviewed-price-data.ts"),
      "utf8",
    );
    expect(packageJson.scripts["menus:promote-reviewed"]).toBe(
      "tsx scripts/promote-reviewed-price-data.ts",
    );
    for (const unsafeSwitch of [
      "--allow-homepage",
      "--allow-special-sources",
      "--include-covered-venues",
      "--min-overall-confidence",
      "--min-row-confidence",
      "--skip-source-check",
    ]) {
      expect(source).not.toContain(`"${unsafeSwitch}"`);
    }

    const invoked = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
        path.join(process.cwd(), "scripts/promote-reviewed-price-data.ts"),
        "invalid",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test" },
      },
    );
    expect(invoked.status).toBe(1);
    expect(invoked.stderr).toContain("Choose exactly one mode");
  });

  it("hard-disables legacy SQLite mutation modes before parsing poison inputs or touching paths", () => {
    temporaryRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-disabled-price-promotion-")),
    );
    const databasePath = path.join(temporaryRoot, "poison.sqlite");
    const manifestPath = path.join(temporaryRoot, "poison-manifest.json");
    const promotionReceiptPath = path.join(temporaryRoot, "poison-promotion-receipt.json");
    const dotenvPath = path.join(temporaryRoot, ".env");
    const applyReceiptPath = path.join(temporaryRoot, "must-not-create-apply-receipt.json");
    const quarantineReceiptPath = path.join(temporaryRoot, "must-not-create-quarantine-receipt.json");
    const sentinels = new Map([
      [databasePath, Buffer.from("database sentinel: do not open or replace\n")],
      [manifestPath, Buffer.from("manifest sentinel: deliberately invalid JSON\n")],
      [promotionReceiptPath, Buffer.from("receipt sentinel: deliberately invalid JSON\n")],
      [dotenvPath, Buffer.from("RESTORE_REHEARSAL_MODE=true\nSUPABASE_URL=poison://dotenv.invalid\n")],
    ]);
    for (const [sentinelPath, contents] of sentinels) {
      fs.writeFileSync(sentinelPath, contents, { mode: 0o600 });
    }
    const sentinelMtimes = new Map(
      [...sentinels].map(([sentinelPath]) => [sentinelPath, fs.statSync(sentinelPath).mtimeMs]),
    );
    const poisonEnvironment = {
      ...process.env,
      DOTENV_CONFIG_DEBUG: "true",
      DOTENV_CONFIG_PATH: dotenvPath,
      NODE_ENV: "test",
      NODE_PG_FORCE_NATIVE: "true",
      RESTORE_REHEARSAL_BACKUP_ID: "poison-restore-marker",
      RESTORE_REHEARSAL_MODE: "true",
      SUPABASE_MENU_CAPTURE_TABLE: "poison_table",
      SUPABASE_SERVICE_ROLE_KEY: "poison-not-a-credential",
      SUPABASE_URL: "poison://must-not-parse.invalid",
    };
    const cliPrefix = [
      path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
      path.join(process.cwd(), "scripts/promote-reviewed-price-data.ts"),
    ];
    const cases = [
      {
        args: [
          "--poison-unsupported-switch",
          "must-not-parse",
          "--database",
          databasePath,
          "--manifest",
          manifestPath,
          "--receipt",
          applyReceiptPath,
        ],
        message: "Legacy SQLite reviewed-price apply is disabled; PostgreSQL promotion is required.",
        mode: "apply",
        outputPath: applyReceiptPath,
      },
      {
        args: [
          "--poison-unsupported-switch",
          "must-not-parse",
          "--database",
          databasePath,
          "--manifest",
          manifestPath,
          "--promotion-receipt",
          promotionReceiptPath,
          "--quarantine-receipt",
          quarantineReceiptPath,
        ],
        message: "Legacy SQLite reviewed-price quarantine is disabled; PostgreSQL quarantine is required.",
        mode: "quarantine",
        outputPath: quarantineReceiptPath,
      },
    ] as const;

    for (const testCase of cases) {
      const invoked = spawnSync(
        process.execPath,
        [...cliPrefix, testCase.mode, ...testCase.args],
        {
          cwd: temporaryRoot,
          encoding: "utf8",
          env: poisonEnvironment,
        },
      );
      expect(invoked.status).toBe(1);
      expect(invoked.stdout).toBe("");
      expect(invoked.stderr.trim()).toBe(testCase.message);
      expect(fs.existsSync(testCase.outputPath)).toBe(false);
      for (const [sentinelPath, contents] of sentinels) {
        expect(fs.readFileSync(sentinelPath)).toEqual(contents);
        expect(fs.statSync(sentinelPath).mtimeMs).toBe(sentinelMtimes.get(sentinelPath));
      }
    }
  });

  it("builds a deterministic exact-ID manifest with the immutable conservative policy", async () => {
    const fixture = await createFixture();
    const sourceVerifier = vi.fn(async () => undefined);
    const input = {
      candidateSha: CANDIDATE_SHA,
      database: fixture.database,
      databasePath: fixture.databasePath,
      ids: [INGESTION_ID],
      sourceVerifier,
      supabaseOrigin: `https://${PROJECT_REF}.supabase.co`,
      supabaseProjectRef: PROJECT_REF,
    };

    const first = await buildReviewedPricePromotionManifest(input);
    const second = await buildReviewedPricePromotionManifest(input);

    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.policy).toEqual(PRODUCTION_MAP_BASE_POLICY);
    expect(first.policySha256).toBe(REVIEWED_PRICE_SELECTION_POLICY_SHA256);
    expect(first.candidateSha).toBe(CANDIDATE_SHA);
    expect(first.items).toEqual([
      expect.objectContaining({
        id: INGESTION_ID,
        rowCount: 1,
        sourceUrl: "https://example.com/drinks-menu.pdf",
        venueId: VENUE_ID,
      }),
    ]);
    expect(first.items[0]?.rows[0]).toMatchObject({
      availabilityStatus: "on_tap",
      availableOnTap: true,
      needsReview: false,
      priceNumeric: 13.5,
    });
    expect(sourceVerifier).toHaveBeenCalledTimes(2);
  });

  it("pins the canonical Supabase project and rejects private network source addresses", () => {
    expect(assertExactSupabaseProjectTarget(
      `https://${PROJECT_REF}.supabase.co`,
      PROJECT_REF,
    )).toEqual({
      origin: `https://${PROJECT_REF}.supabase.co`,
      projectRef: PROJECT_REF,
    });
    expect(assertExactSupabaseProjectTarget(
      PRODUCTION_SUPABASE_CUSTOM_ORIGIN,
      PROJECT_REF,
    )).toEqual({
      origin: PRODUCTION_SUPABASE_CUSTOM_ORIGIN,
      projectRef: PROJECT_REF,
    });
    expect(() => assertExactSupabaseProjectTarget(
      "https://bbbbbbbbbbbbbbbbbbbb.supabase.co",
      PROJECT_REF,
    )).toThrow("target mismatch");
    expect(() => assertExactSupabaseProjectTarget(
      `https://${PROJECT_REF}.supabase.co/rest/v1`,
      PROJECT_REF,
    )).toThrow("canonical HTTPS origin");
    for (const candidate of [
      ` https://${PROJECT_REF}.supabase.co`,
      `https://${PROJECT_REF}.supabase.co `,
      `HTTPS://${PROJECT_REF.toUpperCase()}.SUPABASE.CO`,
      `https://${PROJECT_REF}.supabase.co:443`,
      `https://${PROJECT_REF}.supabase.co/`,
    ]) {
      expect(() => assertExactSupabaseProjectTarget(candidate, PROJECT_REF)).toThrow(
        /exact unnormalized canonical HTTPS origin|canonical HTTPS origin/,
      );
    }
    for (const candidate of [` ${PROJECT_REF}`, `${PROJECT_REF} `, PROJECT_REF.toUpperCase()]) {
      expect(() => assertExactSupabaseProjectTarget(
        `https://${PROJECT_REF}.supabase.co`,
        candidate,
      )).toThrow("exactly 20 lowercase letters or digits");
    }
    expect(isPrivateOrReservedAddress("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedAddress("10.1.2.3")).toBe(true);
    expect(isPrivateOrReservedAddress("192.168.1.2")).toBe(true);
    expect(isPrivateOrReservedAddress("8.8.8.8")).toBe(false);
    expect(() => assertProductionMutationTarget("abcdefghijklmnopqrst")).toThrow(
      PRODUCTION_SUPABASE_PROJECT_REF,
    );
    expect(() => assertProductionMutationTarget(PRODUCTION_SUPABASE_PROJECT_REF)).not.toThrow();
  });

  it("requires distinct human controls, explicitly disabled launch flags, and a backup verified within 30 minutes", () => {
    expect(validateApplyControls(
      controls(),
      NOW,
      disabledProductionEnvironment(),
    )).toEqual(controls());

    expect(() => validateApplyControls(
      controls({ reviewer: "operator@example.test" }),
      NOW,
      disabledProductionEnvironment(),
    )).toThrow("distinct people");
    expect(() => validateApplyControls(
      controls({ backupVerifiedAt: "2026-07-28T01:29:59.999Z" }),
      NOW,
      disabledProductionEnvironment(),
    )).toThrow("no more than 30 minutes");
    expect(() => validateApplyControls(
      controls(),
      NOW,
      { ...disabledProductionEnvironment(), COMMERCIAL_LAUNCH_ENABLED: "true" },
    )).toThrow("COMMERCIAL_LAUNCH_ENABLED=false");
    expect(() => validateApplyControls(
      controls(),
      NOW,
      { ...disabledProductionEnvironment(), PINT_POINTS_REWARDS_ENABLED: undefined },
    )).toThrow("PINT_POINTS_REWARDS_ENABLED=false");
    expect(() => validateApplyControls(
      controls(),
      NOW,
      { ...disabledProductionEnvironment(), CONSUMER_PAID_ENROLLMENT_ENABLED: "true" },
    )).toThrow("CONSUMER_PAID_ENROLLMENT_ENABLED=false");
  });

  it("writes new canonical artifacts only and verifies the manifest's exact SHA-256", async () => {
    const manifest = await createManifest();
    const manifestPath = path.join(temporaryRoot!, "reviewed-manifest.json");
    const hash = writeNewJsonArtifact(manifestPath, manifest);

    expect(hash).toBe(sha256Bytes(fs.readFileSync(manifestPath)));
    const readFile = vi.spyOn(fs, "readFileSync");
    expect(loadReviewedPricePromotionManifest(manifestPath, hash).manifest).toEqual(manifest);
    expect(readFile.mock.calls.at(-1)?.[0]).toEqual(expect.any(Number));
    expect(() => loadReviewedPricePromotionManifest(manifestPath, "b".repeat(64))).toThrow("SHA-256 mismatch");
    expect(readFile.mock.calls.at(-1)?.[0]).toEqual(expect.any(Number));
    const manifestLinkPath = path.join(temporaryRoot!, "linked-reviewed-manifest.json");
    fs.symlinkSync(manifestPath, manifestLinkPath);
    expect(() => loadReviewedPricePromotionManifest(manifestLinkPath, hash)).toThrow("not a symlink");
    expect(() => writeNewJsonArtifact(manifestPath, manifest)).toThrow("already exists");
    expect(() => writeNewJsonArtifact("relative.json", manifest)).toThrow("canonical absolute path");
  });

  it("preflights every manifest item, publishes only the reviewed ID, and verifies evidence-backed public rows", async () => {
    const manifest = await createManifest();
    const publisher = vi.fn(async (id: string) => {
      expect(id).toBe(INGESTION_ID);
      insertPublishedRows(database!, manifest);
      return { mapPriceRecordCount: 1, savedAt: SAVED_AT };
    });
    const sourceVerifier = vi.fn(async () => undefined);

    const execution = await executeReviewedPricePromotion({
      controls: controls(),
      database: database!,
      manifest,
      publisher,
      sourceVerifier,
    });

    expect(execution.succeeded).toBe(true);
    expect(execution.failed).toEqual([]);
    expect(execution.beforePublicRows).toEqual([]);
    expect(execution.afterPublicRows).toEqual([
      expect.objectContaining({
        id: `source-ingestion:${INGESTION_ID}:0`,
        sourceEvidenceReference: `source-ingestion:${INGESTION_ID}`,
        sourceEvidenceVerifiedAt: SAVED_AT,
      }),
    ]);
    expect(publisher).toHaveBeenCalledTimes(1);
    expect(sourceVerifier).toHaveBeenCalledWith("https://example.com/drinks-menu.pdf");

    const receipt = buildPromotionReceipt({
      appliedAt: NOW.toISOString(),
      controls: controls(),
      execution,
      manifest,
      manifestPath: path.join(temporaryRoot!, "reviewed-manifest.json"),
      manifestSha256: HASH,
    });
    expect(receipt.outcome).toBe("succeeded");
    expect(receipt.candidateSha).toBe(CANDIDATE_SHA);
    expect(receipt.backup).toMatchObject({
      id: controls().backupId,
      manifestSha256: HASH,
    });
    expect(receipt.hashes).toMatchObject({
      afterPublicRowsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      backupAuthoritySha256: receipt.backup.authoritySha256,
      backupManifestSha256: HASH,
      beforePublicRowsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      failedItemsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifestSha256: HASH,
    });
  });

  it("does not publish anything when a queue row or public source changes after review", async () => {
    const manifest = await createManifest();
    database!.prepare(
      "UPDATE admin_ingestion_queue SET updated_at = ? WHERE id = ?",
    ).run("2026-07-28T00:02:00.000Z", INGESTION_ID);
    const publisher = vi.fn(async () => ({ mapPriceRecordCount: 1, savedAt: SAVED_AT }));
    const sourceVerifier = vi.fn(async () => {
      throw new Error("source unavailable");
    });

    const execution = await executeReviewedPricePromotion({
      controls: controls(),
      database: database!,
      manifest,
      publisher,
      sourceVerifier,
    });

    expect(execution.succeeded).toBe(false);
    expect(execution.failed).toEqual([
      expect.objectContaining({ id: INGESTION_ID, stage: "preflight" }),
    ]);
    expect(publisher).not.toHaveBeenCalled();
  });

  it("fails closed when a published row is missing durable source evidence linkage", async () => {
    const manifest = await createManifest();
    const publisher = vi.fn(async () => {
      insertPublishedRows(database!, manifest, { evidence: false });
      return { mapPriceRecordCount: 1, savedAt: SAVED_AT };
    });

    const execution = await executeReviewedPricePromotion({
      controls: controls(),
      database: database!,
      manifest,
      publisher,
      sourceVerifier: async () => undefined,
    });

    expect(execution.succeeded).toBe(false);
    expect(execution.failed).toEqual([
      expect.objectContaining({
        id: INGESTION_ID,
        stage: "verify",
      }),
    ]);
    expect(execution.afterPublicRows[0]).toMatchObject({
      sourceEvidenceReference: null,
      sourceEvidenceVerifiedAt: null,
    });
  });

  it("quarantines only receipt-authorized rows, preserves evidence and queue history, hides them publicly, and is idempotent", async () => {
    const manifest = await createManifest();
    const promotion = await createSuccessfulPromotionReceipt(manifest);
    database!.prepare(
      `INSERT INTO venue_profiles (venue_id, name, suburb, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(VENUE_ID, "Test Venue", "Melbourne", SAVED_AT, SAVED_AT);
    database!.prepare(
      `INSERT INTO venue_beers (
         id, venue_id, beer_name, normalized_beer_id, serve_size, price,
         on_tap, in_stock, price_verified_at, source_ingestion_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'pint', ?, 1, 1, ?, ?, ?, ?)`,
    ).run(
      "admin-reviewed:test-venue:carlton:pint",
      VENUE_ID,
      "Carlton Draught",
      "carlton_draft",
      13.5,
      SAVED_AT,
      INGESTION_ID,
      SAVED_AT,
      SAVED_AT,
    );
    const sqlDatabase = asAsyncSqliteDatabase(database!);
    const publicRepository = new PublicPriceRepository(sqlDatabase);
    const publicVenueDirectoryRepository = new PublicVenueDirectoryRepository(
      sqlDatabase,
    );
    expect(await publicRepository.listVenueManagerPriceRecords(10, VENUE_ID)).toHaveLength(1);
    expect((await publicVenueDirectoryRepository.listPublicVenueBeerKeys([VENUE_ID])).get(VENUE_ID)).toEqual([
      "carlton_draft",
    ]);
    const queueBefore = database!.prepare(
      "SELECT * FROM admin_ingestion_queue WHERE id = ?",
    ).get(INGESTION_ID);

    const first = await executeReviewedPriceQuarantine({
      controls: controls({ approvalReference: "ROLLBACK-2026-071" }),
      database: database!,
      manifest,
      manifestPath: promotion.receipt.manifest.path,
      manifestSha256: HASH,
      now: "2026-07-28T02:01:00.000Z",
      promotionReceipt: promotion.receipt,
    });

    expect(first.succeeded).toBe(true);
    expect(first.quarantinedIds).toEqual([INGESTION_ID]);
    expect(first.alreadyQuarantinedIds).toEqual([]);
    expect(first.queueHistoryAfterSha256).toBe(first.queueHistoryBeforeSha256);
    expect(first.afterRows).toEqual([
      expect.objectContaining({
        confidence: "disputed",
        sourceEvidenceReference: `source-ingestion:${INGESTION_ID}`,
        sourceEvidenceVerifiedAt: SAVED_AT,
        sourceType: "source_ingestion_quarantined",
      }),
    ]);
    expect(database!.prepare(
      "SELECT * FROM admin_ingestion_queue WHERE id = ?",
    ).get(INGESTION_ID)).toEqual(queueBefore);
    expect(await publicRepository.listLatestPriceRecords(10, VENUE_ID)).toEqual([]);
    expect(await publicRepository.listVenueManagerPriceRecords(10, VENUE_ID)).toEqual([]);
    expect((await publicVenueDirectoryRepository.listPublicVenueBeerKeys([VENUE_ID])).get(VENUE_ID)).toEqual([]);
    expect(database!.prepare(
      `SELECT count(*) AS total
         FROM venue_price_records
        WHERE source_ingestion_id = ?
          AND source_evidence_reference = ?
          AND source_evidence_verified_at = ?`,
    ).get(
      INGESTION_ID,
      `source-ingestion:${INGESTION_ID}`,
      SAVED_AT,
    )).toEqual({ total: 1 });

    const second = await executeReviewedPriceQuarantine({
      controls: controls({ approvalReference: "ROLLBACK-2026-072" }),
      database: database!,
      manifest,
      manifestPath: promotion.receipt.manifest.path,
      manifestSha256: HASH,
      now: "2026-07-28T02:02:00.000Z",
      promotionReceipt: promotion.receipt,
    });
    expect(second.succeeded).toBe(true);
    expect(second.quarantinedIds).toEqual([]);
    expect(second.alreadyQuarantinedIds).toEqual([INGESTION_ID]);

    const quarantineReceipt = buildQuarantineReceipt({
      controls: controls({ approvalReference: "ROLLBACK-2026-072" }),
      execution: second,
      manifest,
      manifestPath: promotion.receipt.manifest.path,
      manifestSha256: HASH,
      promotionReceipt: promotion.receipt,
      promotionReceiptPath: promotion.path,
      promotionReceiptSha256: promotion.sha256,
      quarantinedAt: "2026-07-28T02:02:00.000Z",
    });
    expect(quarantineReceipt).toMatchObject({
      candidateSha: CANDIDATE_SHA,
      outcome: "succeeded",
      promotionReceipt: {
        outcome: "succeeded",
        sha256: promotion.sha256,
      },
      reconciliation: {
        alreadyQuarantinedIds: [INGESTION_ID],
      },
    });
    const quarantineReceiptPath = path.join(temporaryRoot!, "quarantine-receipt.json");
    expect(writeNewJsonArtifact(
      quarantineReceiptPath,
      quarantineReceipt,
    )).toMatch(/^[a-f0-9]{64}$/);
    expect(() => writeNewJsonArtifact(
      quarantineReceiptPath,
      quarantineReceipt,
    )).toThrow("already exists");
  });

  it("reconciles an immutable in-progress crash receipt by quarantining only manifest rows that actually exist", async () => {
    const manifest = await createManifest();
    insertPublishedRows(database!, manifest);
    const backupAuthority = {
      id: controls().backupId,
      manifestSha256: controls().backupManifestSha256,
      verifiedAt: controls().backupVerifiedAt,
    };
    const inProgress: InProgressPromotionReceipt = {
      approvalReferenceSha256: sha256Bytes(controls().approvalReference),
      backupAuthoritySha256: sha256Json(backupAuthority),
      candidateSha: CANDIDATE_SHA,
      kind: "pintpath-reviewed-price-promotion-receipt",
      manifestSha256: HASH,
      operator: controls().operator,
      outcome: "in_progress",
      reviewer: controls().reviewer,
      supabaseProjectRef: PROJECT_REF,
      version: 1,
    };
    const inProgressPath = path.join(temporaryRoot!, "promotion-in-progress.json");
    const inProgressSha256 = writeNewJsonArtifact(inProgressPath, inProgress);
    const readFile = vi.spyOn(fs, "readFileSync");
    const loadedInProgress = loadPromotionReceiptAuthority(
      inProgressPath,
      inProgressSha256,
    );
    expect(readFile.mock.calls.at(-1)?.[0]).toEqual(expect.any(Number));
    expect(loadedInProgress.receipt.outcome).toBe("in_progress");

    const execution = await executeReviewedPriceQuarantine({
      controls: controls({ approvalReference: "CRASH-RECONCILE-071" }),
      database: database!,
      manifest,
      manifestPath: path.join(temporaryRoot!, "reviewed-manifest.json"),
      manifestSha256: HASH,
      now: "2026-07-28T02:03:00.000Z",
      promotionReceipt: loadedInProgress.receipt,
    });

    expect(execution.succeeded).toBe(true);
    expect(execution.quarantinedIds).toEqual([INGESTION_ID]);
    expect(execution.absentIds).toEqual([]);
    expect(execution.afterRows[0]).toMatchObject({
      sourceType: "source_ingestion_quarantined",
      confidence: "disputed",
    });
  });

  it("rejects promotion-receipt tampering and candidate/target mismatches before quarantine", async () => {
    const manifest = await createManifest();
    const promotion = await createSuccessfulPromotionReceipt(manifest);
    const promotionReceiptSha256 = writeNewJsonArtifact(promotion.path, promotion.receipt);
    expect(loadPromotionReceiptAuthority(
      promotion.path,
      promotionReceiptSha256,
    ).receipt).toEqual(promotion.receipt);
    fs.appendFileSync(promotion.path, "\n");
    expect(() => loadPromotionReceiptAuthority(
      promotion.path,
      promotionReceiptSha256,
    )).toThrow("SHA-256 mismatch");

    expect(() => assertReviewedManifestMutationTarget(manifest, {
      candidateSha: "d".repeat(40),
      databasePath: manifest.databasePath,
      supabaseOrigin: manifest.supabaseOrigin,
      supabaseProjectRef: manifest.supabaseProjectRef,
    })).toThrow("candidate");

    const wrongRef = "bbbbbbbbbbbbbbbbbbbb";
    const selfConsistentWrongTarget = assertExactSupabaseProjectTarget(
      `https://${wrongRef}.supabase.co`,
      wrongRef,
    );
    expect(() => assertProductionMutationTarget(selfConsistentWrongTarget.projectRef)).toThrow(
      PRODUCTION_SUPABASE_PROJECT_REF,
    );

    await expect(executeReviewedPriceQuarantine({
      controls: controls(),
      database: database!,
      manifest,
      manifestPath: promotion.receipt.manifest.path,
      manifestSha256: HASH,
      now: "2026-07-28T02:04:00.000Z",
      promotionReceipt: {
        ...promotion.receipt,
        candidateSha: "d".repeat(40),
      },
    })).rejects.toThrow("candidate or project");
    expect(database!.prepare(
      "SELECT source_type FROM venue_price_records WHERE source_ingestion_id = ?",
    ).get(INGESTION_ID)).toEqual({ source_type: "source_ingestion" });
  });

  it("uses a failed receipt's exact published subset and never quarantines another manifest or unrelated ingestion ID", async () => {
    const manifest = await createTwoItemManifest();
    const partialPromotion = await executeReviewedPricePromotion({
      controls: controls(),
      database: database!,
      manifest,
      publisher: async (id) => {
        if (id === SECOND_INGESTION_ID) {
          throw new Error("simulated second-item publication failure");
        }
        const item = manifest.items.find((candidate) => candidate.id === id)!;
        insertPublishedItem(database!, item);
        return { mapPriceRecordCount: item.rowCount, savedAt: SAVED_AT };
      },
      sourceVerifier: async () => undefined,
    });
    expect(partialPromotion.succeeded).toBe(false);
    expect(partialPromotion.published.map((item) => item.id)).toEqual([INGESTION_ID]);
    const promotionReceipt = buildPromotionReceipt({
      appliedAt: NOW.toISOString(),
      controls: controls(),
      execution: partialPromotion,
      manifest,
      manifestPath: path.join(temporaryRoot!, "reviewed-manifest.json"),
      manifestSha256: HASH,
    });

    const unrelatedId = "55555555-5555-4555-8555-555555555555";
    database!.prepare(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, suburb, beer_name, normalized_beer_id, serving_size,
         price, is_happy_hour_price, happy_hour_details, is_on_tap, confidence,
         source_type, source_submission_id, source_ingestion_id, source_evidence_reference,
         source_evidence_verified_at, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, 'Unrelated Venue', NULL, 'Guinness', NULL, 'pint',
         15, 0, NULL, 'yes', 'admin_verified',
         'source_ingestion', NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `source-ingestion:${unrelatedId}:0`,
      "66666666-6666-4666-8666-666666666666",
      unrelatedId,
      `source-ingestion:${unrelatedId}`,
      SAVED_AT,
      SAVED_AT,
      SAVED_AT,
      SAVED_AT,
    );

    const quarantine = await executeReviewedPriceQuarantine({
      controls: controls({ approvalReference: "PARTIAL-ROLLBACK-071" }),
      database: database!,
      manifest,
      manifestPath: promotionReceipt.manifest.path,
      manifestSha256: HASH,
      now: "2026-07-28T02:04:30.000Z",
      promotionReceipt,
    });

    expect(quarantine.succeeded).toBe(true);
    expect(quarantine.quarantinedIds).toEqual([INGESTION_ID]);
    expect(database!.prepare(
      "SELECT source_type FROM venue_price_records WHERE source_ingestion_id = ?",
    ).get(INGESTION_ID)).toEqual({ source_type: "source_ingestion_quarantined" });
    expect(database!.prepare(
      "SELECT source_type FROM venue_price_records WHERE source_ingestion_id = ?",
    ).get(SECOND_INGESTION_ID)).toBeUndefined();
    expect(database!.prepare(
      "SELECT source_type FROM venue_price_records WHERE source_ingestion_id = ?",
    ).get(unrelatedId)).toEqual({ source_type: "source_ingestion" });
  });

  it("fails the entire quarantine preflight when one receipt-listed row is incomplete, without partially hiding valid rows", async () => {
    const fixture = await createFixture();
    const queue = (await fixture.repository.getById(INGESTION_ID))!;
    fixture.database.prepare(
      `UPDATE admin_ingestion_queue
          SET extracted_beers_json = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      JSON.stringify([
        ...queue.extractedBeers,
        {
          ...queue.extractedBeers[0],
          name: "Guinness",
          priceNumeric: 14,
          priceText: "$14 pint",
        },
      ]),
      "2026-07-28T00:02:00.000Z",
      INGESTION_ID,
    );
    const manifest = await buildReviewedPricePromotionManifest({
      candidateSha: CANDIDATE_SHA,
      database: fixture.database,
      databasePath: fixture.databasePath,
      ids: [INGESTION_ID],
      sourceVerifier: async () => undefined,
      supabaseOrigin: `https://${PROJECT_REF}.supabase.co`,
      supabaseProjectRef: PROJECT_REF,
    });
    const promotion = await createSuccessfulPromotionReceipt(manifest);
    fixture.database.prepare(
      "UPDATE venue_price_records SET source_evidence_reference = NULL WHERE id = ?",
    ).run(`source-ingestion:${INGESTION_ID}:1`);

    const execution = await executeReviewedPriceQuarantine({
      controls: controls(),
      database: fixture.database,
      manifest,
      manifestPath: promotion.receipt.manifest.path,
      manifestSha256: HASH,
      now: "2026-07-28T02:05:00.000Z",
      promotionReceipt: promotion.receipt,
    });

    expect(execution.succeeded).toBe(false);
    expect(execution.failed).toEqual([
      expect.objectContaining({ id: INGESTION_ID, stage: "preflight" }),
    ]);
    expect(fixture.database.prepare(
      "SELECT DISTINCT source_type FROM venue_price_records WHERE source_ingestion_id = ?",
    ).all(INGESTION_ID)).toEqual([{ source_type: "source_ingestion" }]);
  });
});
