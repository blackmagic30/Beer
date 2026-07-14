import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BeerCatalogRepository } from "../src/db/beer-catalog.repository.js";
import { CURRENT_LEGAL_POLICY_VERSION } from "../src/config/legal.js";
import {
  BusinessRepository,
  MissionReservationError,
  type BusinessAccount,
} from "../src/db/business.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { createSubmissionSchema } from "../src/modules/business/business.schemas.js";
import { BusinessService } from "../src/modules/business/business.service.js";

const START = "2026-07-14T01:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1_000;

interface Harness {
  database: BetterSqlite3.Database;
  repository: BusinessRepository;
  service: BusinessService;
}

const databases: BetterSqlite3.Database[] = [];
const evidenceDirectories: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(START));
});

afterEach(() => {
  vi.useRealTimers();
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (evidenceDirectories.length > 0) {
    fs.rmSync(evidenceDirectories.pop()!, { recursive: true, force: true });
  }
});

function createHarness(): Harness {
  const database = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(database);
  databases.push(database);

  const evidenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-mission-lifecycle-"));
  evidenceDirectories.push(evidenceDirectory);
  const repository = new BusinessRepository(database);
  const service = new BusinessService(repository, {
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    CONTRIBUTOR_UNLOCK_POINTS: 15,
    CONTRIBUTOR_UNLOCK_DAYS: 30,
    DEMO_BILLING_MODE: true,
    FIELD_TEST_MODE: false,
    SESSION_TTL_DAYS: 60,
    ADMIN_SESSION_TTL_DAYS: 7,
    REQUIRE_ADMIN_MFA_IN_PRODUCTION: true,
    ADMIN_MFA_MAX_AGE_MINUTES: 720,
    REQUIRE_VERIFIED_ACCOUNT_IN_PRODUCTION: true,
    ANALYTICS_MIN_BUCKET_SIZE: 5,
    REPORT_TIMEZONE: "Australia/Melbourne",
    REPORT_EMAIL_MODE: "disabled",
    ALLOW_DEMO_IMAGE_STORAGE_IN_PRODUCTION: false,
    SOURCE_EVIDENCE_STORAGE_DIR: evidenceDirectory,
    SOURCE_EVIDENCE_SIGNING_SECRET: "mission-lifecycle-test-signing-secret-32-bytes",
    SOURCE_EVIDENCE_SIGNED_URL_TTL_SECONDS: 300,
    SOURCE_EVIDENCE_RETENTION_DAYS: 30,
    POS_WEBHOOK_SIGNING_SECRET: "mission-lifecycle-pos-secret-32-bytes",
    NODE_ENV: "test",
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_PRICE_MONTHLY: undefined,
    STRIPE_PRICE_YEARLY: undefined,
    STRIPE_PRO_PRICE_ID: undefined,
    SUPABASE_URL: undefined,
    SUPABASE_ANON_KEY: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SUPABASE_OAUTH_PROVIDERS: "google,apple",
    ADMIN_EMAILS: "admin@pintpath.test",
    GOOGLE_MAPS_API_KEY: undefined,
    GOOGLE_PLACES_API_KEY: undefined,
  }, new BeerCatalogRepository(database));

  return { database, repository, service };
}

function createAccount(
  repository: BusinessRepository,
  id: string,
  role: "user" | "admin" = "user",
): BusinessAccount {
  const account = repository.createAccount({
    id,
    email: `${id}@example.com`,
    passwordHash: "test-password-hash",
    role,
    subscriptionStatus: role === "admin" ? "admin" : "free",
    emailVerifiedAt: START,
    termsAcceptedAt: START,
    privacyAcceptedAt: START,
    termsVersion: CURRENT_LEGAL_POLICY_VERSION,
    privacyVersion: CURRENT_LEGAL_POLICY_VERSION,
    now: START,
  });
  return repository.updateAgeConfirmed(account.id, START);
}

function createMission(
  service: BusinessService,
  venueId = "venue-mission-lifecycle",
  venueName = "Mission Lifecycle Hotel",
) {
  return service.createMission({
    venueId,
    venueName,
    suburb: "Melbourne",
    reason: "Missing Carlton Draught price - add this drink",
    priority: "high",
    points: 5,
    multiplier: 1,
    active: true,
  });
}

function submitMission(
  service: BusinessService,
  account: BusinessAccount,
  mission: { id: string; venueId: string; venueName: string; suburb: string | null },
) {
  return service.createSubmission(account, createSubmissionSchema.parse({
    clientSubmissionId: `mission-submission-${account.id}`,
    missionId: mission.id,
    venueId: mission.venueId,
    venueName: mission.venueName,
    suburb: mission.suburb,
    newVenue: null,
    submissionType: "single_beer_price",
    observedAt: new Date().toISOString(),
    sourcePhotoDataUrl: null,
    sourcePhotoDataUrls: [],
    sourceDocumentDataUrl: null,
    sourcePhotoUrl: null,
    uploadLocation: null,
    notes: "Mission lifecycle regression submission.",
    items: [{
      beerName: "Carlton Draught",
      servingSize: "pint",
      price: 13,
      isHappyHourPrice: false,
      happyHourDetails: null,
      isOnTap: "yes",
    }],
  }));
}

function seedLegacyMissionSubmission(
  repository: BusinessRepository,
  account: BusinessAccount,
  mission: { id: string; venueId: string; venueName: string; suburb: string | null },
  id: string,
) {
  return repository.createSubmission({
    id,
    clientSubmissionId: `legacy-${id}`,
    missionId: mission.id,
    missionAcceptedAfter: "2026-07-13T00:59:59.000Z",
    userId: account.id,
    venueId: mission.venueId,
    venueName: mission.venueName,
    suburb: mission.suburb,
    submissionType: "single_beer_price",
    observedAt: START,
    sourcePhotoUrl: null,
    sourceEvidenceIds: [],
    ocrStatus: "not_requested",
    ocrSummary: null,
    notes: "Legacy competing mission submission.",
    uploadLatitude: null,
    uploadLongitude: null,
    uploadAccuracyMeters: null,
    uploadLocationCapturedAt: null,
    distanceToVenueMeters: null,
    pointsEligibleByLocation: false,
    pointsEligibilityReason: "location_not_provided",
    pendingVenue: null,
    now: START,
    items: [{
      id: `${id}:item`,
      beerName: "Carlton Draught",
      normalizedBeerId: "carlton-draught",
      servingSize: "pint",
      price: 13,
      isHappyHourPrice: false,
      happyHourDetails: null,
      isOnTap: "yes",
      confidence: 0.8,
      captureSource: "manual",
      sourceText: null,
      requiresCatalogApproval: false,
    }],
  });
}

function approveMissionSubmission(
  service: BusinessService,
  admin: BusinessAccount,
  submissionId: string,
) {
  return service.reviewSubmission(admin, submissionId, {
    status: "approved",
    rejectionReason: null,
    fraudFlagged: false,
    confidence: "admin_verified",
  });
}

describe("autonomous mission lifecycle", () => {
  it("moves an accepted mission through submitted to completed and archives it on approval", () => {
    const { repository, service } = createHarness();
    const contributor = createAccount(repository, "mission-contributor");
    const challenger = createAccount(repository, "mission-challenger");
    const admin = createAccount(repository, "mission-admin", "admin");
    const mission = createMission(service);

    expect(service.acceptMission(contributor, mission.id).progress.status).toBe("accepted");

    const submission = submitMission(service, contributor, mission).submission;
    expect(repository.getMissionProgress({ missionId: mission.id, userId: contributor.id }))
      .toMatchObject({ status: "submitted", submissionId: submission.id });

    // Reopening an already-submitted mission must never regress it to accepted.
    expect(service.acceptMission(contributor, mission.id).progress)
      .toMatchObject({ status: "submitted", submissionId: submission.id });
    expect(() => service.acceptMission(challenger, mission.id)).toThrow();

    expect(approveMissionSubmission(service, admin, submission.id).submission.status).toBe("approved");
    expect(repository.getMissionProgress({ missionId: mission.id, userId: contributor.id }))
      .toMatchObject({ status: "completed", submissionId: submission.id });
    expect(repository.getMissionProgress({ missionId: mission.id, userId: contributor.id })?.completedAt)
      .toBe(START);
    expect(repository.getMissionById(mission.id)?.active).toBe(false);
  });

  it("cancels legacy competing acceptances and submissions when the winning submission is approved", () => {
    const { database, repository, service } = createHarness();
    const winner = createAccount(repository, "mission-winner");
    const acceptedCompetitor = createAccount(repository, "mission-accepted-competitor");
    const submittedCompetitor = createAccount(repository, "mission-submitted-competitor");
    const admin = createAccount(repository, "mission-reviewer", "admin");
    const mission = createMission(service);

    service.acceptMission(winner, mission.id);
    const winningSubmission = submitMission(service, winner, mission).submission;
    // Simulate rows written before exclusive reservations were enforced.
    database.exec("DROP INDEX idx_mission_progress_open_reservation");
    const insertProgress = database.prepare(
      `INSERT INTO mission_progress (
        id, mission_id, user_id, submission_id, status, accepted_at, submitted_at, completed_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?)`,
    );
    insertProgress.run(
      "competing-accepted-progress",
      mission.id,
      acceptedCompetitor.id,
      "accepted",
      START,
      null,
      START,
    );
    insertProgress.run(
      "competing-submitted-progress",
      mission.id,
      submittedCompetitor.id,
      "accepted",
      START,
      null,
      START,
    );
    const competingSubmission = seedLegacyMissionSubmission(
      repository,
      submittedCompetitor,
      mission,
      "competing-legacy-submission",
    );

    approveMissionSubmission(service, admin, winningSubmission.id);

    expect(repository.getMissionProgress({ missionId: mission.id, userId: winner.id })?.status).toBe("completed");
    expect(repository.getMissionProgress({ missionId: mission.id, userId: acceptedCompetitor.id })?.status)
      .toBe("cancelled");
    expect(repository.getMissionProgress({ missionId: mission.id, userId: submittedCompetitor.id })?.status)
      .toBe("cancelled");

    // A later review of already-queued competing work must not replace the winner.
    approveMissionSubmission(service, admin, competingSubmission.id);
    expect(repository.getMissionProgress({ missionId: mission.id, userId: submittedCompetitor.id })?.status)
      .toBe("cancelled");
  });

  it("rejects a mission-linked submission unless that user owns its active reservation", () => {
    const { repository, service } = createHarness();
    const reservedBy = createAccount(repository, "mission-reservation-owner");
    const bypassingUser = createAccount(repository, "mission-reservation-bypass");
    const mission = createMission(service);

    service.acceptMission(reservedBy, mission.id);
    expect(() => submitMission(service, bypassingUser, mission)).toThrow();
    expect(repository.getMissionProgress({ missionId: mission.id, userId: bypassingUser.id })).toBeNull();
  });

  it("enforces mission ownership inside the repository transaction", () => {
    const { repository, service } = createHarness();
    const bypassingUser = createAccount(repository, "mission-repository-bypass");
    const mission = createMission(service);

    expect(() => seedLegacyMissionSubmission(
      repository,
      bypassingUser,
      mission,
      "repository-bypass-submission",
    )).toThrow(MissionReservationError);
    expect(repository.getSubmissionByClientSubmissionId(
      bypassingUser.id,
      "legacy-repository-bypass-submission",
    )).toBeNull();
  });

  it("blocks an active reservation but atomically reclaims it after the 24-hour acceptance TTL", () => {
    const { repository, service } = createHarness();
    const first = createAccount(repository, "mission-first-acceptor");
    const second = createAccount(repository, "mission-second-acceptor");
    const mission = createMission(service);

    service.acceptMission(first, mission.id);
    vi.advanceTimersByTime(DAY_MS - 1_000);
    expect(() => service.acceptMission(second, mission.id)).toThrow();
    expect(repository.getMissionProgress({ missionId: mission.id, userId: first.id })?.status).toBe("accepted");

    vi.advanceTimersByTime(2_000);
    expect(service.acceptMission(second, mission.id).progress.status).toBe("accepted");
    expect(repository.getMissionProgress({ missionId: mission.id, userId: first.id })?.status).toBe("cancelled");
    expect(repository.getMissionProgress({ missionId: mission.id, userId: second.id })?.status).toBe("accepted");
  });

  it("shows a reserved mission only to its current owner", () => {
    const { repository, service } = createHarness();
    const owner = createAccount(repository, "mission-visible-owner");
    const otherUser = createAccount(repository, "mission-hidden-user");
    const mission = createMission(service);

    service.acceptMission(owner, mission.id);

    expect(service.listMissions({ limit: 200 }, owner))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: mission.id, userProgress: "accepted" })]));
    expect(service.listMissions({ limit: 200 }, otherUser).some((candidate) => candidate.id === mission.id)).toBe(false);
    expect(service.listMissions({ limit: 200 }, null).some((candidate) => candidate.id === mission.id)).toBe(false);
  });

  it("keeps every mission reachable beyond the first 200 results", () => {
    const { service } = createHarness();
    const createdIds = new Set<string>();
    for (let index = 0; index < 205; index += 1) {
      const mission = createMission(service, `venue-page-${String(index).padStart(3, "0")}`, `Paged Venue ${index}`);
      createdIds.add(mission.id);
    }

    const returnedIds = new Set<string>();
    let offset = 0;
    let page = service.getMissionsPage({ limit: 200, offset, sort: "points" });
    expect(page.pagination).toMatchObject({ limit: 200, offset: 0, hasMore: true });
    while (true) {
      page.missions.forEach((mission) => returnedIds.add(mission.id));
      if (!page.pagination.hasMore) break;
      offset += page.pagination.limit;
      page = service.getMissionsPage({ limit: 200, offset, sort: "points" });
    }

    expect(page.pagination.hasMore).toBe(false);
    expect(returnedIds.size).toBe(page.pagination.total);
    expect([...createdIds].every((id) => returnedIds.has(id))).toBe(true);
  });

  it("retains completion state beyond 200 mission-progress rows", () => {
    const { database, repository, service } = createHarness();
    const contributor = createAccount(repository, "mission-progress-heavy-user");
    let oldestMissionId = "";
    for (let index = 0; index < 201; index += 1) {
      const mission = createMission(
        service,
        `progress-venue-${String(index).padStart(3, "0")}`,
        index === 0 ? "Oldest Completed Venue" : `Progress Filler Venue ${index}`,
      );
      if (index === 0) oldestMissionId = mission.id;
      repository.acceptMission({
        missionId: mission.id,
        userId: contributor.id,
        now: START,
        acceptedAfter: "2020-01-01T00:00:00.000Z",
      });
      database.prepare(
        "UPDATE mission_progress SET status = 'completed', completed_at = ?, updated_at = ? WHERE mission_id = ? AND user_id = ?",
      ).run(
        START,
        index === 0 ? "2025-01-01T00:00:00.000Z" : `2026-07-14T01:${String(index % 60).padStart(2, "0")}:00.000Z`,
        mission.id,
        contributor.id,
      );
    }

    expect(repository.listMissionProgressForUser(contributor.id)).toHaveLength(201);
    expect(service.listMissions({ q: "Oldest Completed Venue", limit: 10 }, contributor)
      .find((mission) => mission.id === oldestMissionId))
      .toEqual(expect.objectContaining({ id: oldestMissionId, userProgress: "completed" }));
  });

  it("expires abandoned acceptances during maintenance without waiting for another user", () => {
    const { repository, service } = createHarness();
    const contributor = createAccount(repository, "mission-expired-acceptor");
    const mission = createMission(service);

    service.acceptMission(contributor, mission.id);
    vi.advanceTimersByTime(DAY_MS + 1_000);
    const result = service.runMissionMaintenance({ forceRefresh: true });

    expect(result.expiredAcceptances).toBe(1);
    expect(repository.getMissionProgress({ missionId: mission.id, userId: contributor.id })?.status)
      .toBe("cancelled");
    expect(repository.getMissionById(mission.id)?.active).toBe(true);
  });

  it("refreshes needed auto missions, prunes unreferenced inactive rows, and retains completed history", () => {
    const { database, repository, service } = createHarness();
    const contributor = createAccount(repository, "mission-history-contributor");
    const admin = createAccount(repository, "mission-history-admin", "admin");

    repository.createMission({
      id: "auto:venue:venue-completed-history:coverage",
      venueId: "venue-completed-history",
      venueName: "Completed History Hotel",
      suburb: "Melbourne",
      reason: "New or empty venue - add first verified beer prices",
      priority: "high",
      points: 5,
      multiplier: 1,
      active: true,
      lastVerifiedAt: null,
      createdAt: START,
      updatedAt: START,
    });
    const completedMission = repository.getMissionById("auto:venue:venue-completed-history:coverage")!;
    service.acceptMission(contributor, completedMission.id);
    const completedSubmission = submitMission(service, contributor, completedMission).submission;
    approveMissionSubmission(service, admin, completedSubmission.id);

    repository.createMission({
      id: "auto:venue:unreferenced-old-venue:coverage",
      venueId: "unreferenced-old-venue",
      venueName: "Unreferenced Old Venue",
      suburb: "Melbourne",
      reason: "New or empty venue - add first verified beer prices",
      priority: "high",
      points: 5,
      multiplier: 1,
      active: false,
      lastVerifiedAt: null,
      createdAt: START,
      updatedAt: START,
    });
    repository.upsertVenueLocationCache({
      venueId: "venue-needing-coverage",
      venueName: "Coverage Needed Hotel",
      suburb: "Melbourne",
      latitude: -37.81,
      longitude: 144.96,
      now: START,
    });

    const result = service.runMissionMaintenance({ forceRefresh: true });

    expect(result.generated).toBeGreaterThan(0);
    expect(result.pruned).toBeGreaterThanOrEqual(1);
    expect(repository.getMissionById("auto:venue:unreferenced-old-venue:coverage")).toBeNull();
    expect(repository.getMissionById(completedMission.id)).toMatchObject({ active: false });
    expect(repository.getMissionProgress({ missionId: completedMission.id, userId: contributor.id })?.status)
      .toBe("completed");
    expect(database.prepare(
      "SELECT COUNT(*) AS total FROM missions WHERE id LIKE 'auto:venue:venue-needing-coverage:%' AND active = 1",
    ).get()).toMatchObject({ total: 1 });
  });

  it("traverses every venue candidate in bounded pages beyond the old 2,000-venue ceiling", () => {
    const { database, repository, service } = createHarness();
    const insert = database.prepare(
      `INSERT INTO venue_location_cache (
        venue_id, venue_name, suburb, latitude, longitude, updated_at
      ) VALUES (?, ?, 'Melbourne', -37.81, 144.96, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < 2_001; index += 1) {
        const suffix = String(index).padStart(4, "0");
        insert.run(`deep-mission-venue-${suffix}`, `Deep Mission Venue ${suffix}`, START);
      }
    })();
    const pageSpy = vi.spyOn(repository, "listMissionVenueCandidates");

    const result = service.runMissionMaintenance({ forceRefresh: true });

    expect(result.candidates).toBe(2_001);
    expect(result.generated).toBe(2_001);
    expect(pageSpy.mock.calls).toEqual([
      [500, 0],
      [500, 500],
      [500, 1_000],
      [500, 1_500],
      [500, 2_000],
    ]);
    expect(repository.getMissionById("auto:venue:deep-mission-venue-2000:coverage")).toEqual(
      expect.objectContaining({ venueId: "deep-mission-venue-2000", active: true }),
    );
  });

  it("normalizes duplicate legacy reservations before restoring the exclusive database index", () => {
    const { database, repository, service } = createHarness();
    const acceptedUser = createAccount(repository, "legacy-accepted-user");
    const submittedUser = createAccount(repository, "legacy-submitted-user");
    const thirdUser = createAccount(repository, "legacy-third-user");
    const mission = createMission(service);

    database.exec("DROP INDEX idx_mission_progress_open_reservation");
    const insertProgress = database.prepare(
      `INSERT INTO mission_progress (
        id, mission_id, user_id, submission_id, status, accepted_at, submitted_at, completed_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?)`,
    );
    insertProgress.run(
      "legacy-accepted-reservation",
      mission.id,
      acceptedUser.id,
      "accepted",
      "2026-07-14T00:00:00.000Z",
      null,
      "2026-07-14T00:00:00.000Z",
    );
    insertProgress.run(
      "legacy-submitted-reservation",
      mission.id,
      submittedUser.id,
      "submitted",
      "2026-07-14T00:30:00.000Z",
      "2026-07-14T00:45:00.000Z",
      "2026-07-14T00:45:00.000Z",
    );

    initializeDatabaseSchema(database);

    expect(repository.getMissionProgress({ missionId: mission.id, userId: submittedUser.id })?.status)
      .toBe("submitted");
    expect(repository.getMissionProgress({ missionId: mission.id, userId: acceptedUser.id })?.status)
      .toBe("cancelled");
    expect(database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_mission_progress_open_reservation'",
    ).get()).toMatchObject({ sql: expect.stringContaining("CREATE UNIQUE INDEX") });
    expect(() => insertProgress.run(
      "legacy-third-reservation",
      mission.id,
      thirdUser.id,
      "accepted",
      START,
      null,
      START,
    )).toThrow(/UNIQUE constraint failed/);
  });
});
