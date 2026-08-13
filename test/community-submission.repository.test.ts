import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { initializeDatabaseSchema } from "../src/db/database.js";
import {
  CommunitySubmissionRepository,
  CommunitySubmissionRepositoryError,
  communityPendingVenueFingerprint,
  type CommunityApprovalFailureStage,
  type CommunityApprovalVenueDecision,
  type CommunityCatalogDecision,
} from "../src/db/community-submission.repository.js";
import { SourceEvidenceObjectRepository } from "../src/db/source-evidence-object.repository.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";

const NOW = "2026-08-08T05:00:00.000Z";
const OBSERVED_AT = "2026-08-08T04:30:00.000Z";
const CUTOFF = "2026-08-08T03:00:00.000Z";
const CATALOG_REVIEWED_AT = "2026-08-08T05:05:00.000Z";
const APPROVED_AT = "2026-08-08T05:10:00.000Z";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: CommunitySubmissionRepository;
  sourceEvidenceRepository: SourceEvidenceObjectRepository;
  activeCatalogKey: string;
}

function createFixture(options: { allowApprovalFailureInjection?: boolean } = {}): Fixture {
  const raw = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(raw);
  const active = raw.prepare(
    "SELECT key FROM beer_catalog_items WHERE status = 'active' ORDER BY key LIMIT 1",
  ).get() as { key: string } | undefined;
  if (!active) throw new Error("Expected the bootstrap beer catalogue.");
  const database = new AsyncSqliteDatabase(raw);
  return {
    raw,
    database,
    repository: new CommunitySubmissionRepository(database, options),
    sourceEvidenceRepository: new SourceEvidenceObjectRepository(database),
    activeCatalogKey: active.key,
  };
}

function insertAccount(
  raw: BetterSqlite3.Database,
  id: string,
  options: { role?: string; subscriptionStatus?: string; status?: string; strikes?: number } = {},
): void {
  raw.prepare(
    `INSERT INTO accounts (
       id, public_account_id, email, password_hash, auth_provider, role,
       subscription_status, trust_score, rejected_submission_count,
       fraud_strike_count, status, created_at, updated_at
     ) VALUES (?, ?, ?, 'hash', 'local', ?, ?, 50, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    `public-${id}`,
    `${id}@example.test`,
    options.role ?? "user",
    options.subscriptionStatus ?? "free",
    options.strikes ?? 0,
    options.status ?? "active",
    NOW,
    NOW,
  );
  raw.prepare(
    `INSERT INTO profiles (
       id, public_account_id, email, role, account_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `public-${id}`,
    `${id}@example.test`,
    options.role ?? "user",
    options.status ?? "active",
    NOW,
    NOW,
  );
}

function activeDecision(key: string): CommunityCatalogDecision {
  return { kind: "active_existing", key };
}

function pendingDecision(suffix: string): CommunityCatalogDecision {
  return {
    kind: "pending_create",
    key: `test_beer_${suffix}`,
    canonicalName: `Test Beer ${suffix}`,
    aliasKey: `test_alias_${suffix}`,
    alias: `Test Beer Alias ${suffix}`,
    source: "community_test",
    brewery: "Test Brewery",
    abv: 4.5,
  };
}

function baseInput(
  fixture: Fixture,
  overrides: Partial<Parameters<CommunitySubmissionRepository["createSubmission"]>[0]> = {},
): Parameters<CommunitySubmissionRepository["createSubmission"]>[0] {
  return {
    id: "submission-1",
    clientSubmissionId: "client-submission-1",
    userId: "submitter",
    venueId: "venue-1",
    venueName: "Test Venue",
    suburb: "Fitzroy",
    submissionType: "single_beer_price",
    observedAt: OBSERVED_AT,
    notes: "Observed from the current menu.",
    items: [{
      id: "item-1",
      catalog: activeDecision(fixture.activeCatalogKey),
      servingSize: "pint",
      price: 12.5,
      isOnTap: "yes",
      confidence: 0.9,
      captureSource: "manual",
      sourceText: null,
    }],
    now: NOW,
    ...overrides,
  };
}

async function registerEvidence(
  fixture: Fixture,
  id: string,
  ownerUserId = "submitter",
): Promise<void> {
  await fixture.sourceEvidenceRepository.registerSourceEvidenceObject({
    id,
    ownerUserId,
    storageProvider: "supabase_private",
    objectPath: `private/${ownerUserId}/${id}`,
    mimeType: "image/jpeg",
    byteSize: 2_048,
    dataBase64: null,
    externalUrl: null,
    retentionExpiresAt: "2026-11-08T05:00:00.000Z",
    createdAt: NOW,
  });
}

function expectCode(code: CommunitySubmissionRepositoryError["code"]) {
  return expect.objectContaining({ name: "CommunitySubmissionRepositoryError", code });
}

async function setupApprovalFixture(created: Fixture) {
  insertAccount(created.raw, "submitter");
  insertAccount(created.raw, "admin", { role: "admin", subscriptionStatus: "admin" });
  await registerEvidence(created, "approval-evidence");
  created.raw.prepare(
    `INSERT INTO missions (
       id, venue_id, venue_name, reason, priority, points, multiplier,
       active, sponsor_flag, created_at, updated_at
     ) VALUES ('approval-mission', 'approval-venue', 'Approval Venue', 'missing data',
               'high', 10, 1, 1, 0, ?, ?)`,
  ).run(NOW, NOW);
  created.raw.prepare(
    `INSERT INTO mission_progress (
       id, mission_id, user_id, status, accepted_at, updated_at
     ) VALUES ('approval-progress', 'approval-mission', 'submitter', 'accepted',
               '2026-08-08T04:00:00.000Z', ?)`,
  ).run(NOW);
  created.raw.prepare(
    `INSERT INTO venue_requests (
       id, user_id, request_type, venue_name, google_place_id, suburb, status,
       mission_id, created_at, updated_at
     ) VALUES ('approval-request', 'submitter', 'missing_venue', 'Approval Venue',
               'approval-place', 'Carlton', 'mission_created', 'approval-mission', ?, ?)`,
  ).run(NOW, NOW);
  const pendingVenue = {
    googlePlaceId: "approval-place",
    name: "Approval Venue",
    address: "10 Approval Street",
    suburb: "Carlton",
    state: "VIC",
    postcode: "3053",
    phone: "0399999999",
    website: "https://approval.example.test",
    latitude: -37.8,
    longitude: 144.96,
  };
  await created.repository.createSubmission(baseInput(created, {
    id: "approval-submission",
    clientSubmissionId: "approval-client",
    venueId: "approval-venue",
    venueName: "Approval Venue",
    suburb: "Carlton",
    submissionType: "photo_upload",
    evidenceIds: ["approval-evidence"],
    missionId: "approval-mission",
    missionAcceptedAfter: CUTOFF,
    pointsEligibleByLocation: true,
    pointsEligibilityReason: "within_radius",
    pendingVenue,
    items: [{
      id: "approval-item",
      catalog: pendingDecision("approval"),
      servingSize: "pint",
      price: 13.5,
      isOnTap: "yes",
      confidence: 0.92,
      captureSource: "photo_ocr",
      sourceText: "TEST BEER APPROVAL $13.50",
    }],
  }));
  created.raw.prepare(
    `UPDATE beer_catalog_items
        SET status = 'active', updated_at = ?
      WHERE key = 'test_beer_approval'`,
  ).run(CATALOG_REVIEWED_AT);
  created.raw.prepare(
    `INSERT INTO contribution_ledger (
       id, user_id, submission_id, venue_id, points, reason, month_key, created_at
     ) VALUES ('prior-ledger', 'submitter', NULL, 'prior-venue', 95,
               'single_beer_price', '2026-08', ?)`,
  ).run(NOW);
  const venueDecision: CommunityApprovalVenueDecision = {
    pendingVenueHash: communityPendingVenueFingerprint(pendingVenue),
    expectedVenueProfileUpdatedAt: null,
    expectedLocationUpdatedAt: null,
    requests: [{
      requestId: "approval-request",
      status: "mission_created",
      updatedAt: NOW,
      missionId: "approval-mission",
      missionUpdatedAt: NOW,
    }],
  };
  const approvalSnapshot = await created.repository.getApprovalSnapshot("approval-submission");
  const approvalInput: Parameters<CommunitySubmissionRepository["approveAndPublishSubmission"]>[0] = {
    approvalId: "approval-decision-1",
    submissionId: "approval-submission",
    reviewerId: "admin",
    catalogDecisions: [{
      itemId: "approval-item",
      expectedCatalogKey: "test_beer_approval",
      expectedCatalogUpdatedAt: CATALOG_REVIEWED_AT,
      activeCatalogKey: "test_beer_approval",
      activeCatalogName: "Test Beer approval",
      activeCatalogUpdatedAt: CATALOG_REVIEWED_AT,
    }],
    missionDecision: {
      missionId: "approval-mission",
      missionUpdatedAt: NOW,
      progressId: "approval-progress",
      progressUpdatedAt: NOW,
    },
    venueDecision,
    evidenceDecisions: approvalSnapshot.evidenceDecisions,
    pointsAwarded: 10,
    confidence: "photo_verified",
    monthKey: "2026-08",
    premiumUntil: "2026-09-01T00:00:00.000Z",
    contributorUnlockPoints: 100,
    now: APPROVED_AT,
  };
  return { approvalInput, pendingVenue };
}

describe("CommunitySubmissionRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  function fixture(options: { allowApprovalFailureInjection?: boolean } = {}): Fixture {
    const created = createFixture(options);
    databases.push(created.database);
    return created;
  }

  it("returns the exact bounded contribution total for one account month", async () => {
    const created = fixture();
    insertAccount(created.raw, "points-owner");
    created.raw.prepare(
      `INSERT INTO contribution_ledger (
         id, user_id, submission_id, venue_id, points, reason, month_key, created_at
       ) VALUES
         ('points-a', 'points-owner', NULL, 'venue-a', 7.25, 'approved', '2026-08', ?),
         ('points-b', 'points-owner', NULL, 'venue-b', 2.5, 'approved', '2026-08', ?),
         ('points-old', 'points-owner', NULL, 'venue-c', 99, 'approved', '2026-07', ?)`,
    ).run(NOW, NOW, NOW);

    await expect(created.repository.getContributionPointsForMonth("points-owner", "2026-08"))
      .resolves.toBe(9.75);
    await expect(created.repository.getContributionPointsForMonth("points-owner", "2026-09"))
      .resolves.toBe(0);
    await expect(created.repository.getContributionPointsForMonth("points-owner", "2026-13"))
      .rejects.toEqual(expectCode("invalid_input"));

    created.raw.prepare(
      "UPDATE contribution_ledger SET points = -10 WHERE id = 'points-a'",
    ).run();
    await expect(created.repository.getContributionPointsForMonth("points-owner", "2026-08"))
      .rejects.toEqual(expectCode("persistence_failure"));
  });

  it("owner-scoped safe deletion clears private payload metadata and preserves its provider tombstone", async () => {
    const created = fixture();
    insertAccount(created.raw, "evidence-owner");
    insertAccount(created.raw, "other-owner");
    await registerEvidence(created, "unlinked-private-evidence", "evidence-owner");
    created.raw.prepare(
      `UPDATE source_evidence_objects
          SET data_base64 = ?, external_url = ?
        WHERE id = ?`,
    ).run("cHJpdmF0ZQ==", "https://private.example.test/evidence.jpg", "unlinked-private-evidence");

    await expect(created.repository.deleteUnlinkedSourceEvidence({
      id: "unlinked-private-evidence",
      ownerUserId: "other-owner",
      deletedAt: "2026-08-08T06:01:00.000Z",
    })).resolves.toBe(false);
    await expect(created.repository.deleteUnlinkedSourceEvidence({
      id: "unlinked-private-evidence",
      ownerUserId: "evidence-owner",
      deletedAt: "2026-08-08T06:01:00.000Z",
    })).resolves.toBe(true);

    expect(created.raw.prepare(
      `SELECT storage_provider, object_path, data_base64, external_url, byte_size, deleted_at
         FROM source_evidence_objects WHERE id = ?`,
    ).get("unlinked-private-evidence")).toEqual({
      storage_provider: "supabase_private",
      object_path: "private/evidence-owner/unlinked-private-evidence",
      data_base64: null,
      external_url: null,
      byte_size: null,
      deleted_at: "2026-08-08T06:01:00.000Z",
    });
  });

  it("atomically creates private beer evidence, catalogue proposals, exact links, and idempotent replays", async () => {
    const created = fixture();
    insertAccount(created.raw, "submitter");
    await registerEvidence(created, "evidence-b");
    await registerEvidence(created, "evidence-a");
    const input = baseInput(created, {
      evidenceIds: ["evidence-b", "evidence-a"],
      ocrStatus: "processed",
      ocrSummary: {
        model: "test-ocr",
        imageCount: 2,
        extractedRowCount: 2,
        rejectedCandidateCount: 0,
        pendingCatalogCount: 1,
        message: null,
      },
      pendingVenue: {
        googlePlaceId: "place-1",
        name: "Test Venue",
        address: "1 Test Street",
        suburb: "Fitzroy",
        state: "VIC",
        postcode: "3065",
        phone: null,
        website: null,
        latitude: -37.8,
        longitude: 144.98,
      },
      items: [
        {
          id: "item-2",
          catalog: pendingDecision("one"),
          servingSize: "schooner",
          price: 10,
          isOnTap: "unknown",
          confidence: 0.7,
          captureSource: "photo_ocr",
          sourceText: "TEST BEER 10.00",
        },
        {
          id: "item-1",
          catalog: activeDecision(created.activeCatalogKey),
          servingSize: "pint",
          price: 12.5,
          isOnTap: "yes",
          confidence: 0.9,
        },
      ],
    });

    const first = await created.repository.createSubmission(input);
    expect(first.replayed).toBe(false);
    expect(first.record.submission).toMatchObject({
      status: "pending",
      sourcePhotoUrl: "private:evidence:evidence-b",
      submissionType: "single_beer_price",
    });
    expect(first.record.items.map((item) => item.id)).toEqual(["item-1", "item-2"]);
    expect(first.record.items[1]).toMatchObject({
      normalizedBeerId: "test_beer_one",
      requiresCatalogApproval: true,
    });
    expect(first.record.evidence.map((entry) => [entry.sortOrder, entry.object.id])).toEqual([
      [0, "evidence-b"],
      [1, "evidence-a"],
    ]);

    const replay = await created.repository.createSubmission({
      ...input,
      id: "a-new-server-id-is-ignored-on-replay",
      items: [...input.items].reverse(),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.record.submission.id).toBe("submission-1");
    expect(created.raw.prepare("SELECT count(*) AS count FROM submissions").get()).toEqual({ count: 1 });
    expect(created.raw.prepare("SELECT count(*) AS count FROM venue_price_records").get()).toEqual({ count: 0 });
    expect(created.raw.prepare("SELECT count(*) AS count FROM venue_profiles").get()).toEqual({ count: 0 });

    await expect(created.repository.createSubmission({ ...input, venueId: "different-venue" }))
      .rejects.toEqual(expectCode("idempotency_conflict"));
  });

  it("reserves a mission in the same transaction and rolls every effect back on a late item conflict", async () => {
    const created = fixture();
    insertAccount(created.raw, "submitter");
    insertAccount(created.raw, "other");
    await created.repository.createSubmission(baseInput(created, {
      id: "first-submission",
      clientSubmissionId: "first-client",
      items: [{
        id: "globally-duplicate-item",
        catalog: activeDecision(created.activeCatalogKey),
        servingSize: "pint",
        price: 12,
        isOnTap: "yes",
        confidence: 0.8,
      }],
    }));
    created.raw.prepare(
      `INSERT INTO missions (
         id, venue_id, venue_name, reason, priority, points, multiplier,
         active, sponsor_flag, created_at, updated_at
       ) VALUES ('mission-1', 'venue-2', 'Mission Venue', 'stale', 'normal', 10, 1, 1, 0, ?, ?)`,
    ).run(NOW, NOW);
    created.raw.prepare(
      `INSERT INTO mission_progress (
         id, mission_id, user_id, status, accepted_at, updated_at
       ) VALUES ('progress-1', 'mission-1', 'other', 'accepted', '2026-08-08T04:00:00.000Z', ?)`,
    ).run(NOW);

    await expect(created.repository.createSubmission(baseInput(created, {
      id: "rollback-submission",
      clientSubmissionId: "rollback-client",
      userId: "other",
      venueId: "venue-2",
      venueName: "Mission Venue",
      missionId: "mission-1",
      missionAcceptedAfter: CUTOFF,
      items: [{
        id: "globally-duplicate-item",
        catalog: pendingDecision("rollback"),
        servingSize: "pint",
        price: 11,
        isOnTap: "yes",
        confidence: 0.8,
      }],
    }))).rejects.toEqual(expectCode("persistence_failure"));

    expect(created.raw.prepare("SELECT status, submission_id FROM mission_progress WHERE id = 'progress-1'").get())
      .toEqual({ status: "accepted", submission_id: null });
    expect(created.raw.prepare("SELECT count(*) AS count FROM submissions WHERE id = 'rollback-submission'").get())
      .toEqual({ count: 0 });
    expect(created.raw.prepare("SELECT count(*) AS count FROM beer_catalog_items WHERE key = 'test_beer_rollback'").get())
      .toEqual({ count: 0 });
    expect(created.raw.prepare("SELECT count(*) AS count FROM beer_catalog_aliases WHERE alias_key = 'test_alias_rollback'").get())
      .toEqual({ count: 0 });
  });

  it("rejects free-launch happy-hour rows and ownership/deletion violations before publication", async () => {
    const created = fixture();
    insertAccount(created.raw, "submitter");
    insertAccount(created.raw, "other");
    await registerEvidence(created, "other-evidence", "other");

    await expect(created.repository.createSubmission(baseInput(created, {
      evidenceIds: ["other-evidence"],
    }))).rejects.toEqual(expectCode("evidence_not_owned"));

    await expect(created.repository.createSubmission(baseInput(created, {
      items: [{
        id: "happy-item",
        catalog: activeDecision(created.activeCatalogKey),
        servingSize: "pint",
        price: 8,
        isHappyHourPrice: true,
        happyHourDetails: "paid special",
        isOnTap: "yes",
        confidence: 0.9,
      }],
    }))).rejects.toEqual(expectCode("invalid_input"));

    created.raw.prepare(
      `INSERT INTO account_deletion_requests (
         id, user_id, status, requested_at, execute_after, created_at, updated_at
       ) VALUES ('delete-1', 'submitter', 'processing', ?, ?, ?, ?)`,
    ).run(NOW, NOW, NOW, NOW);
    await expect(created.repository.createSubmission(baseInput(created)))
      .rejects.toEqual(expectCode("account_not_eligible"));
    expect(created.raw.prepare("SELECT count(*) AS count FROM submissions").get()).toEqual({ count: 0 });
  });

  it("creates one concurrent community verification and exposes only a redacted candidate projection", async () => {
    const created = fixture();
    insertAccount(created.raw, "submitter");
    insertAccount(created.raw, "verifier");
    await registerEvidence(created, "private-evidence");
    await created.repository.createSubmission(baseInput(created, { evidenceIds: ["private-evidence"] }));

    const candidates = await created.repository.listCommunityVerificationCandidates({
      verifierUserId: "verifier",
      limit: 20,
      offset: 0,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).not.toHaveProperty("userId");
    expect(candidates[0]).not.toHaveProperty("sourcePhotoUrl");
    expect(candidates[0]).not.toHaveProperty("evidence");
    expect(candidates[0]).not.toHaveProperty("notes");
    expect(await created.repository.countCommunityVerificationCandidates("verifier")).toBe(1);

    const calls = ["verification-a", "verification-b"].map((id) => created.repository.createVerification({
      id,
      verifierUserId: "verifier",
      submissionId: "submission-1",
      result: "confirmed" as const,
      notes: null,
      now: NOW,
    }));
    const results = await Promise.allSettled(calls);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toEqual(expectCode("verification_conflict"));
    expect(await created.repository.countCommunityVerificationCandidates("verifier")).toBe(0);
    expect(await created.repository.countConfirmedVerificationsForSubmission("submission-1")).toBe(1);
    const persistedVerification = await created.repository.getVerificationByUserAndSubmission({
      verifierUserId: "verifier",
      submissionId: "submission-1",
    });
    expect(persistedVerification).toMatchObject({
      verifierUserId: "verifier",
      uploadId: "submission-1",
      result: "confirmed",
    });
    expect(await created.repository.getVerificationById(persistedVerification!.id)).toEqual(persistedVerification);
    expect(await created.repository.listVerificationsForUser({ verifierUserId: "verifier", limit: 10 }))
      .toEqual([persistedVerification]);

    await expect(created.repository.createVerification({
      id: "own-verification",
      verifierUserId: "submitter",
      submissionId: "submission-1",
      result: "confirmed",
      notes: null,
      now: NOW,
    })).rejects.toEqual(expectCode("own_verification"));
  });

  it("fences concurrent reviews and commits fraud counters, suspension containment, mission state, and review together", async () => {
    const created = fixture();
    insertAccount(created.raw, "submitter", { strikes: 2 });
    insertAccount(created.raw, "admin", { role: "admin", subscriptionStatus: "admin" });
    created.raw.prepare(
      `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
       VALUES ('session-token', 'submitter', ?, '2026-09-08T05:00:00.000Z')`,
    ).run(NOW);
    created.raw.prepare(
      `INSERT INTO missions (
         id, venue_id, venue_name, reason, priority, points, multiplier,
         active, sponsor_flag, created_at, updated_at
       ) VALUES ('mission-review', 'venue-1', 'Test Venue', 'stale', 'normal', 10, 1, 1, 0, ?, ?)`,
    ).run(NOW, NOW);
    created.raw.prepare(
      `INSERT INTO mission_progress (
         id, mission_id, user_id, status, accepted_at, updated_at
       ) VALUES ('progress-review', 'mission-review', 'submitter', 'accepted', '2026-08-08T04:00:00.000Z', ?)`,
    ).run(NOW);
    await created.repository.createSubmission(baseInput(created, {
      missionId: "mission-review",
      missionAcceptedAfter: CUTOFF,
    }));
    created.raw.prepare(
      `INSERT INTO contribution_ledger (
         id, user_id, submission_id, venue_id, points, reason, month_key, created_at
       ) VALUES ('ledger-review', 'submitter', 'submission-1', 'venue-1', 7.5,
                 'single_beer_price', '2026-08', ?)`,
    ).run(NOW);

    const reviews = ["fraud_flagged", "rejected"].map((status) => created.repository.reviewSubmission({
      submissionId: "submission-1",
      reviewerId: "admin",
      status: status as "fraud_flagged" | "rejected",
      rejectionReason: "reviewed",
      monthKey: "2026-08",
      now: NOW,
    }));
    const results = await Promise.allSettled(reviews);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const submission = created.raw.prepare(
      "SELECT status, reviewed_by, points_awarded FROM submissions WHERE id = 'submission-1'",
    ).get() as { status: string; reviewed_by: string; points_awarded: number };
    const account = created.raw.prepare(
      `SELECT rejected_submission_count, fraud_strike_count, trust_score, status,
              contribution_points_current_month
         FROM accounts WHERE id = 'submitter'`,
    ).get() as Record<string, unknown>;
    expect(account.rejected_submission_count).toBe(1);
    expect(account.contribution_points_current_month).toBe(7.5);
    if (submission.status === "fraud_flagged") {
      expect(account).toMatchObject({ fraud_strike_count: 3, trust_score: 30, status: "suspended" });
      expect(created.raw.prepare("SELECT revoked_at FROM auth_sessions WHERE token_hash = 'session-token'").get())
        .toEqual({ revoked_at: NOW });
      expect(created.raw.prepare("SELECT account_status FROM profiles WHERE id = 'submitter'").get())
        .toEqual({ account_status: "suspended" });
    } else {
      expect(account).toMatchObject({ fraud_strike_count: 2, trust_score: 46, status: "active" });
    }
    expect(submission).toMatchObject({ reviewed_by: "admin", points_awarded: 0 });
    expect(created.raw.prepare("SELECT status FROM mission_progress WHERE id = 'progress-review'").get())
      .toEqual({ status: "needs_revision" });
    expect(created.raw.prepare("SELECT count(*) AS count FROM venue_price_records").get()).toEqual({ count: 0 });
  });

  it("rolls back the review and account penalty when linked mission progress is stale", async () => {
    const created = fixture();
    await setupApprovalFixture(created);
    created.raw.exec(
      `CREATE TRIGGER stale_linked_progress_during_review
       AFTER UPDATE OF status ON submissions
       WHEN NEW.id = 'approval-submission'
       BEGIN
         UPDATE mission_progress
            SET status = 'cancelled'
          WHERE id = 'approval-progress';
       END`,
    );

    await expect(created.repository.reviewSubmission({
      submissionId: "approval-submission",
      reviewerId: "admin",
      status: "rejected",
      rejectionReason: "This review must roll back.",
      monthKey: "2026-08",
      now: APPROVED_AT,
    })).rejects.toEqual(expectCode("mission_decision_stale"));
    expect(created.raw.prepare(
      "SELECT status, reviewed_by FROM submissions WHERE id = 'approval-submission'",
    ).get()).toEqual({ status: "pending", reviewed_by: null });
    expect(created.raw.prepare(
      "SELECT status, submission_id FROM mission_progress WHERE id = 'approval-progress'",
    ).get()).toEqual({ status: "submitted", submission_id: "approval-submission" });
    expect(created.raw.prepare(
      `SELECT rejected_submission_count, trust_score
         FROM accounts WHERE id = 'submitter'`,
    ).get()).toEqual({ rejected_submission_count: 0, trust_score: 50 });
  });

  it("fails approval closed before any mutation and rejects non-admin or repeated reviewers", async () => {
    const created = fixture();
    insertAccount(created.raw, "submitter");
    insertAccount(created.raw, "admin", { role: "admin", subscriptionStatus: "admin" });
    insertAccount(created.raw, "ordinary-reviewer");
    await created.repository.createSubmission(baseInput(created));

    await expect(created.repository.reviewSubmission({
      submissionId: "submission-1",
      reviewerId: "admin",
      status: "approved",
      rejectionReason: null,
      monthKey: "2026-08",
      now: NOW,
    })).rejects.toEqual(expectCode("publication_required"));
    expect(created.raw.prepare("SELECT status, reviewed_by FROM submissions WHERE id = 'submission-1'").get())
      .toEqual({ status: "pending", reviewed_by: null });
    expect(created.raw.prepare("SELECT count(*) AS count FROM venue_price_records").get()).toEqual({ count: 0 });

    await expect(created.repository.reviewSubmission({
      submissionId: "submission-1",
      reviewerId: "ordinary-reviewer",
      status: "rejected",
      rejectionReason: "not allowed",
      monthKey: "2026-08",
      now: NOW,
    })).rejects.toEqual(expectCode("review_forbidden"));

    await created.repository.reviewSubmission({
      submissionId: "submission-1",
      reviewerId: "admin",
      status: "needs_more_evidence",
      rejectionReason: "Please add a menu image.",
      monthKey: "2026-08",
      now: NOW,
    });
    await created.repository.reviewSubmission({
      submissionId: "submission-1",
      reviewerId: "admin",
      status: "rejected",
      rejectionReason: "second decision",
      monthKey: "2026-08",
      now: NOW,
    });
    await expect(created.repository.reviewSubmission({
      submissionId: "submission-1",
      reviewerId: "admin",
      status: "disputed",
      rejectionReason: "third decision",
      monthKey: "2026-08",
      now: NOW,
    })).rejects.toEqual(expectCode("submission_not_reviewable"));
  });

  it("atomically publishes one beer-only approval and makes concurrent retries exactly idempotent", async () => {
    const created = fixture();
    const { approvalInput } = await setupApprovalFixture(created);

    const results = await Promise.all([
      created.repository.approveAndPublishSubmission(approvalInput),
      created.repository.approveAndPublishSubmission(approvalInput),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["already_applied", "applied"]);
    expect(results[0]).toMatchObject({
      submission: {
        id: "approval-submission",
        status: "approved",
        pointsAwarded: 10,
        reviewedBy: "admin",
      },
      pointsAwarded: 10,
      submitter: {
        trustScore: 53,
        contributionPointsCurrentMonth: 105,
        approvedSubmissionCount: 1,
        subscriptionStatus: "contributor_unlocked",
      },
      priceRecordIds: ["approval-submission:approval-item"],
      resolvedVenueRequestIds: ["approval-request"],
    });

    expect(created.raw.prepare(
      `SELECT beer_name, normalized_beer_id, requires_catalog_approval
         FROM submission_items WHERE id = 'approval-item'`,
    ).get()).toEqual({
      beer_name: "Test Beer approval",
      normalized_beer_id: "test_beer_approval",
      requires_catalog_approval: 0,
    });
    expect(created.raw.prepare(
      `SELECT id, is_happy_hour_price, source_type, source_submission_id,
              source_evidence_reference, source_evidence_verified_at
         FROM venue_price_records`,
    ).all()).toEqual([{
      id: "approval-submission:approval-item",
      is_happy_hour_price: 0,
      source_type: "photo_upload",
      source_submission_id: "approval-submission",
      source_evidence_reference: "community-submission:approval-submission:evidence:0",
      source_evidence_verified_at: APPROVED_AT,
    }]);
    expect(created.raw.prepare(
      `SELECT name, membership_tier, highlighted_name, promoted,
              featured_special_eligible, active
         FROM venue_profiles WHERE venue_id = 'approval-venue'`,
    ).get()).toEqual({
      name: "Approval Venue",
      membership_tier: "basic",
      highlighted_name: 0,
      promoted: 0,
      featured_special_eligible: 0,
      active: 1,
    });
    expect(created.raw.prepare(
      `SELECT venue_name, suburb, latitude, longitude
         FROM venue_location_cache WHERE venue_id = 'approval-venue'`,
    ).get()).toEqual({
      venue_name: "Approval Venue",
      suburb: "Carlton",
      latitude: -37.8,
      longitude: 144.96,
    });
    expect(created.raw.prepare(
      `SELECT normalized_beer_id, price, currency, on_tap, in_stock
         FROM venue_beers WHERE venue_id = 'approval-venue'`,
    ).get()).toEqual({
      normalized_beer_id: "test_beer_approval",
      price: 13.5,
      currency: "AUD",
      on_tap: 1,
      in_stock: 1,
    });
    expect(created.raw.prepare(
      `SELECT status, venue_id, source_submission_id, resolved_by
         FROM venue_requests WHERE id = 'approval-request'`,
    ).get()).toEqual({
      status: "resolved",
      venue_id: "approval-venue",
      source_submission_id: "approval-submission",
      resolved_by: "admin",
    });
    expect(created.raw.prepare(
      "SELECT status, completed_at FROM mission_progress WHERE id = 'approval-progress'",
    ).get()).toEqual({ status: "completed", completed_at: APPROVED_AT });
    expect(created.raw.prepare(
      "SELECT active FROM missions WHERE id = 'approval-mission'",
    ).get()).toEqual({ active: 0 });
    expect(created.raw.prepare(
      `SELECT subscription_status, premium_until, trust_score,
              approved_submission_count, contribution_points_current_month
         FROM accounts WHERE id = 'submitter'`,
    ).get()).toEqual({
      subscription_status: "contributor_unlocked",
      premium_until: "2026-09-01T00:00:00.000Z",
      trust_score: 53,
      approved_submission_count: 1,
      contribution_points_current_month: 105,
    });
    expect(created.raw.prepare(
      "SELECT count(*) AS count FROM contribution_ledger WHERE user_id = 'submitter'",
    ).get()).toEqual({ count: 2 });
    expect(created.raw.prepare(
      `SELECT deleted_at FROM source_evidence_objects WHERE id = 'approval-evidence'`,
    ).get()).toEqual({ deleted_at: null });
    expect(created.raw.prepare(
      `SELECT source_photo_url FROM submissions WHERE id = 'approval-submission'`,
    ).get()).toEqual({ source_photo_url: "private:evidence:approval-evidence" });
    expect(created.raw.prepare(
      `SELECT count(*) AS count FROM security_audit_log
        WHERE action = 'community_submission_approved' AND target_id = 'approval-submission'`,
    ).get()).toEqual({ count: 1 });
  });

  it("rejects stale catalogue, venue-request, and mission decisions without partial publication", async () => {
    const cases: Array<{
      mutate: (raw: BetterSqlite3.Database) => void;
      code: CommunitySubmissionRepositoryError["code"];
    }> = [
      {
        mutate: (raw) => raw.prepare(
          "UPDATE beer_catalog_items SET updated_at = '2026-08-08T05:06:00.000Z' WHERE key = 'test_beer_approval'",
        ).run(),
        code: "catalog_decision_stale",
      },
      {
        mutate: (raw) => raw.prepare(
          "UPDATE venue_requests SET updated_at = '2026-08-08T05:06:00.000Z' WHERE id = 'approval-request'",
        ).run(),
        code: "venue_decision_stale",
      },
      {
        mutate: (raw) => raw.prepare(
          "UPDATE missions SET updated_at = '2026-08-08T05:06:00.000Z' WHERE id = 'approval-mission'",
        ).run(),
        code: "mission_decision_stale",
      },
    ];

    for (const testCase of cases) {
      const created = fixture();
      const { approvalInput } = await setupApprovalFixture(created);
      testCase.mutate(created.raw);
      await expect(created.repository.approveAndPublishSubmission(approvalInput))
        .rejects.toEqual(expectCode(testCase.code));
      expect(created.raw.prepare(
        "SELECT status FROM submissions WHERE id = 'approval-submission'",
      ).get()).toEqual({ status: "pending" });
      expect(created.raw.prepare("SELECT count(*) AS count FROM venue_price_records").get())
        .toEqual({ count: 0 });
      expect(created.raw.prepare("SELECT count(*) AS count FROM venue_profiles").get())
        .toEqual({ count: 0 });
    }
  });

  it("rolls every approval stage back, including audit immediately before finalization", async () => {
    const stages: CommunityApprovalFailureStage[] = [
      "after_locks",
      "after_catalog",
      "after_venue",
      "after_public_prices",
      "after_rewards",
      "after_missions",
      "before_finalize",
    ];
    for (const stage of stages) {
      const created = fixture({ allowApprovalFailureInjection: true });
      const { approvalInput } = await setupApprovalFixture(created);
      await expect(created.repository.approveAndPublishSubmission({
        ...approvalInput,
        failureInjection: stage,
      })).rejects.toEqual(expectCode("persistence_failure"));
      expect(created.raw.prepare(
        `SELECT status, reviewed_by, points_awarded
           FROM submissions WHERE id = 'approval-submission'`,
      ).get()).toEqual({ status: "pending", reviewed_by: null, points_awarded: 0 });
      expect(created.raw.prepare(
        `SELECT normalized_beer_id, requires_catalog_approval
           FROM submission_items WHERE id = 'approval-item'`,
      ).get()).toEqual({ normalized_beer_id: "test_beer_approval", requires_catalog_approval: 1 });
      expect(created.raw.prepare("SELECT count(*) AS count FROM venue_price_records").get())
        .toEqual({ count: 0 });
      expect(created.raw.prepare("SELECT count(*) AS count FROM venue_profiles").get())
        .toEqual({ count: 0 });
      expect(created.raw.prepare("SELECT count(*) AS count FROM venue_beers").get())
        .toEqual({ count: 0 });
      expect(created.raw.prepare(
        "SELECT status FROM mission_progress WHERE id = 'approval-progress'",
      ).get()).toEqual({ status: "submitted" });
      expect(created.raw.prepare(
        "SELECT active FROM missions WHERE id = 'approval-mission'",
      ).get()).toEqual({ active: 1 });
      expect(created.raw.prepare(
        "SELECT status, source_submission_id FROM venue_requests WHERE id = 'approval-request'",
      ).get()).toEqual({ status: "mission_created", source_submission_id: null });
      expect(created.raw.prepare(
        `SELECT trust_score, approved_submission_count, contribution_points_current_month,
                subscription_status
           FROM accounts WHERE id = 'submitter'`,
      ).get()).toEqual({
        trust_score: 50,
        approved_submission_count: 0,
        contribution_points_current_month: 0,
        subscription_status: "free",
      });
      expect(created.raw.prepare(
        "SELECT count(*) AS count FROM contribution_ledger WHERE user_id = 'submitter'",
      ).get()).toEqual({ count: 1 });
      expect(created.raw.prepare(
        "SELECT count(*) AS count FROM security_audit_log WHERE action = 'community_submission_approved'",
      ).get()).toEqual({ count: 0 });
    }
  });

  it("rejects duplicate public lineage, legacy happy-hour rows, and non-reviewed confidence", async () => {
    const duplicate = fixture();
    const { approvalInput: duplicateInput } = await setupApprovalFixture(duplicate);
    duplicate.raw.prepare(
      `INSERT INTO venue_price_records (
         id, venue_id, venue_name, beer_name, serving_size, price,
         is_happy_hour_price, is_on_tap, confidence, source_type,
         source_submission_id, last_verified_at, created_at, updated_at
       ) VALUES (
         'approval-submission:approval-item', 'approval-venue', 'Approval Venue',
         'Conflicting Beer', 'pint', 99, 0, 'unknown', 'admin_verified',
         'manual_submission', 'approval-submission', ?, ?, ?
       )`,
    ).run(OBSERVED_AT, NOW, NOW);
    await expect(duplicate.repository.approveAndPublishSubmission(duplicateInput))
      .rejects.toEqual(expectCode("publication_conflict"));
    expect(duplicate.raw.prepare(
      "SELECT status FROM submissions WHERE id = 'approval-submission'",
    ).get()).toEqual({ status: "pending" });

    const happyHour = fixture();
    const { approvalInput: happyInput } = await setupApprovalFixture(happyHour);
    await expect(happyHour.repository.approveAndPublishSubmission({
      ...happyInput,
      confidence: "user_reported_pending",
    })).rejects.toEqual(expectCode("invalid_input"));
    happyHour.raw.prepare(
      `UPDATE submission_items
          SET is_happy_hour_price = 1, happy_hour_details = 'paid special'
        WHERE id = 'approval-item'`,
    ).run();
    await expect(happyHour.repository.approveAndPublishSubmission(happyInput))
      .rejects.toEqual(expectCode("publication_conflict"));
    expect(happyHour.raw.prepare("SELECT count(*) AS count FROM venue_price_records").get())
      .toEqual({ count: 0 });
  });

  it("enforces strict bounds and exposes safe errors without raw database details", async () => {
    const created = fixture();
    insertAccount(created.raw, "submitter");
    await expect(created.repository.createSubmission(baseInput(created, {
      venueName: "x".repeat(201),
    }))).rejects.toEqual(expectCode("invalid_input"));
    await expect(created.repository.createSubmission(baseInput(created, {
      id: "submission-bad-catalog",
      clientSubmissionId: "client-bad-catalog",
      items: [{
        id: "bad-item",
        catalog: { kind: "active_existing", key: "does_not_exist" },
        servingSize: "pint",
        price: 12,
        isOnTap: "yes",
        confidence: 0.8,
      }],
    }))).rejects.toEqual(expectCode("catalog_not_active"));

    const invalidPrimaryKey = baseInput(created, {
      id: "submission-primary-key",
      clientSubmissionId: "client-primary-key",
    });
    created.raw.prepare(
      `INSERT INTO submissions (
         id, client_submission_id, user_id, venue_id, venue_name, status,
         submission_type, observed_at, created_at, updated_at
       ) VALUES ('submission-primary-key', 'some-other-client', 'submitter', 'venue-1',
                 'Test Venue', 'pending', 'single_beer_price', ?, ?, ?)`,
    ).run(OBSERVED_AT, NOW, NOW);
    const error = await created.repository.createSubmission(invalidPrimaryKey).catch((caught: unknown) => caught);
    expect(error).toEqual(expectCode("persistence_failure"));
    expect(String(error)).not.toContain("UNIQUE");
    expect(String(error)).not.toContain("submissions.id");
  });
});
