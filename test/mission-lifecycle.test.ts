import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BeerCatalogRepository } from "../src/db/beer-catalog.repository.js";
import { AccountSessionRepository } from "../src/db/account-session.repository.js";
import { AccountProfilePreferencesRepository } from "../src/db/account-profile-preferences.repository.js";
import { AccountDeletionQueueRepository } from "../src/db/account-deletion-queue.repository.js";
import { AccountPrivacyRepository } from "../src/db/account-privacy.repository.js";
import { PrivacyRetentionRepository } from "../src/db/privacy-retention.repository.js";
import { CommunitySubmissionRepository } from "../src/db/community-submission.repository.js";
import { VenueManagerInternalSubmissionRepository } from "../src/db/venue-manager-internal-submission.repository.js";
import { SourceEvidenceObjectRepository } from "../src/db/source-evidence-object.repository.js";
import { SourceEvidenceRetentionRepository } from "../src/db/source-evidence-retention.repository.js";
import { VenuePendingChangeRepository } from "../src/db/venue-pending-change.repository.js";
import { VenueDataReadRepository } from "../src/db/venue-data-read.repository.js";
import { CURRENT_LEGAL_POLICY_VERSION } from "../src/config/legal.js";
import {
  BusinessRepository,
  type BusinessAccount,
} from "../src/db/business.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { PublicVenueDirectoryRepository } from "../src/db/public-venue-directory.repository.js";
import { PublicPriceRepository } from "../src/db/public-price.repository.js";
import { asAsyncSqliteDatabase } from "../src/db/sql-database.js";
import { SystemStateRepository } from "../src/db/system-state.repository.js";
import { ActivityAuditRepository } from "../src/db/activity-audit.repository.js";
import { SupportFeedbackRepository } from "../src/db/support-feedback.repository.js";
import { VenueInventoryRepository } from "../src/db/venue-inventory.repository.js";
import { VenueIdentityRepository } from "../src/db/venue-identity.repository.js";
import { BillingCheckoutRepository } from "../src/db/billing-checkout.repository.js";
import { VenueAccessRepository } from "../src/db/venue-access.repository.js";
import {
  MissionLifecycleRepository,
  type MissionLifecycleProgress,
  type MissionProgressListCursor,
} from "../src/db/mission-lifecycle.repository.js";
import { MissionDiscoveryAutomationRepository } from "../src/db/mission-discovery-automation.repository.js";
import { StripeSubscriptionRepository } from "../src/db/stripe-subscription.repository.js";
import { VenueRequestRepository } from "../src/db/venue-request.repository.js";
import { VenuePartnerRepository } from "../src/db/venue-partner.repository.js";
import { AdminAnalyticsRepository } from "../src/db/admin-analytics.repository.js";
import { VenueManagerInsightsRepository } from "../src/db/venue-manager-insights.repository.js";
import { AdminAccountRepository } from "../src/db/admin-account.repository.js";
import { createSubmissionSchema } from "../src/modules/business/business.schemas.js";
import { BusinessService } from "../src/modules/business/business.service.js";
import { createSqliteAccountDeletionSecretPhysicalCheckpoint } from "../src/lib/account-deletion-secret-checkpoint.js";

const START = "2026-07-14T01:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1_000;

interface Harness {
  database: BetterSqlite3.Database;
  repository: BusinessRepository;
  missionLifecycleRepository: MissionLifecycleRepository;
  missionDiscoveryAutomationRepository: MissionDiscoveryAutomationRepository;
  communitySubmissionRepository: CommunitySubmissionRepository;
  service: BusinessService;
}

const databases: BetterSqlite3.Database[] = [];
const evidenceDirectories: string[] = [];
const missionLifecycleRepositories = new WeakMap<BusinessRepository, MissionLifecycleRepository>();

function getMissionLifecycleRepository(repository: BusinessRepository): MissionLifecycleRepository {
  const missionLifecycle = missionLifecycleRepositories.get(repository);
  if (!missionLifecycle) throw new Error("Mission lifecycle repository is not initialized for this test fixture.");
  return missionLifecycle;
}

async function listAllMissionProgress(repository: BusinessRepository, userId: string) {
  const progress: MissionLifecycleProgress[] = [];
  let cursor: MissionProgressListCursor | null = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await getMissionLifecycleRepository(repository).listMissionProgressForUser({
      userId,
      limit: 200,
      cursor,
    });
    progress.push(...page.progress);
    if (!page.nextCursor) return progress;
    cursor = page.nextCursor;
  }
  throw new Error("Mission progress test pagination exceeded its bounded page budget.");
}

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

function createHarness(options: { nodeEnv?: "test" | "production" } = {}): Harness {
  const database = new BetterSqlite3(":memory:");
  initializeDatabaseSchema(database);
  databases.push(database);

  const evidenceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-mission-lifecycle-"));
  evidenceDirectories.push(evidenceDirectory);
  const repository = new BusinessRepository(database);
  const sqlDatabase = asAsyncSqliteDatabase(database);
  const missionLifecycleRepository = new MissionLifecycleRepository(sqlDatabase);
  const missionDiscoveryAutomationRepository = new MissionDiscoveryAutomationRepository(sqlDatabase);
  const communitySubmissionRepository = new CommunitySubmissionRepository(sqlDatabase);
  missionLifecycleRepositories.set(repository, missionLifecycleRepository);
  const service = new BusinessService(repository, {
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    CONTRIBUTOR_UNLOCK_POINTS: 15,
    CONTRIBUTOR_UNLOCK_DAYS: 30,
    DEMO_BILLING_MODE: true,
    COMMERCIAL_LAUNCH_ENABLED: true,
    CONSUMER_PAID_ENROLLMENT_ENABLED: true,
    FIELD_TEST_MODE: false,
    PINT_POINTS_REWARDS_ENABLED: true,
    ALCOHOL_GAMIFICATION_ENABLED: true,
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
    NODE_ENV: options.nodeEnv ?? "test",
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    STRIPE_PRICE_MONTHLY: undefined,
    STRIPE_PRICE_YEARLY: undefined,
    STRIPE_PRO_PRICE_ID: undefined,
    VENUE_PRO_TRIAL_DAYS: 60,
    VENUE_PRO_TRIAL_REQUIRE_PAYMENT_METHOD: false,
    SUPABASE_URL: undefined,
    SUPABASE_ANON_KEY: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    SUPABASE_OAUTH_PROVIDERS: "google,apple",
    ADMIN_EMAILS: "admin@pintpath.test",
    GOOGLE_MAPS_API_KEY: undefined,
    GOOGLE_PLACES_API_KEY: undefined,
  }, new PublicVenueDirectoryRepository(sqlDatabase), new PublicPriceRepository(sqlDatabase), new SystemStateRepository(sqlDatabase), new ActivityAuditRepository(sqlDatabase), new SupportFeedbackRepository(sqlDatabase), new AccountSessionRepository(sqlDatabase), new AccountProfilePreferencesRepository(sqlDatabase), new VenueInventoryRepository(sqlDatabase), new VenueIdentityRepository(sqlDatabase), new BillingCheckoutRepository(sqlDatabase), new VenueAccessRepository(sqlDatabase), missionLifecycleRepository, missionDiscoveryAutomationRepository, new StripeSubscriptionRepository(sqlDatabase), new VenueRequestRepository(sqlDatabase), new VenuePartnerRepository(sqlDatabase), new AdminAnalyticsRepository(sqlDatabase), new VenueManagerInsightsRepository(sqlDatabase), new AdminAccountRepository(sqlDatabase), new AccountDeletionQueueRepository(sqlDatabase), new AccountPrivacyRepository(sqlDatabase), new PrivacyRetentionRepository(sqlDatabase), communitySubmissionRepository, new VenueManagerInternalSubmissionRepository(sqlDatabase), new SourceEvidenceObjectRepository(sqlDatabase), new SourceEvidenceRetentionRepository(sqlDatabase), new VenuePendingChangeRepository(sqlDatabase), new VenueDataReadRepository(sqlDatabase), createSqliteAccountDeletionSecretPhysicalCheckpoint(database), new BeerCatalogRepository(sqlDatabase));

  return {
    database,
    repository,
    missionLifecycleRepository,
    missionDiscoveryAutomationRepository,
    communitySubmissionRepository,
    service,
  };
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
  repository: CommunitySubmissionRepository,
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
    evidenceIds: [],
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
      catalog: { kind: "active_existing", key: "carlton_draft" },
      servingSize: "pint",
      price: 13,
      isHappyHourPrice: false,
      happyHourDetails: null,
      isOnTap: "yes",
      confidence: 0.8,
      captureSource: "manual",
      sourceText: null,
    }],
  }).then((result) => result.record.submission);
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
  it("hides and blocks happy-hour missions while retaining them for admin operations", async () => {
    const { repository, service } = createHarness();
    const contributor = createAccount(repository, "mission-launch-scope-contributor");
    const admin = createAccount(repository, "mission-launch-scope-admin", "admin");
    const regularMission = await createMission(service, "mission-launch-regular", "Regular Mission Hotel");
    const happyHourMission = await service.createMission({
      venueId: "mission-launch-happy-hour",
      venueName: "Happy Hour Mission Hotel",
      suburb: "Melbourne",
      reason: "Missing happy-hour details - add current specials",
      priority: "high",
      points: 5,
      multiplier: 1,
      active: true,
    });

    const page = await service.getMissionsPage({ limit: 20, offset: 0, sort: "points" }, contributor);
    expect(page.missions.map((mission) => mission.id)).toEqual([regularMission.id]);
    expect(page.pagination).toEqual({ total: 1, limit: 20, offset: 0, hasMore: false });
    expect((await service.listMissions({ limit: 20, sort: "missing_happy_hour" }, contributor))
      .some((mission) => mission.id === happyHourMission.id)).toBe(false);
    expect((await service.listAdminMissions(admin)).missions.map((mission) => mission.id))
      .toContain(happyHourMission.id);

    await expect(service.acceptMission(contributor, happyHourMission.id))
      .rejects.toThrow("not available during the current public launch");
    expect(await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: happyHourMission.id,
      userId: contributor.id,
    }))
      .toBeNull();

    expect(await getMissionLifecycleRepository(repository).acceptMission({
      missionId: happyHourMission.id,
      userId: contributor.id,
      now: START,
      acceptedAfter: "2020-01-01T00:00:00.000Z",
    })).toMatchObject({ status: "accepted" });
    await expect(submitMission(service, contributor, happyHourMission))
      .rejects.toThrow("not available during the current public launch");
    expect(await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: happyHourMission.id,
      userId: contributor.id,
    }))
      .toMatchObject({ status: "accepted", submissionId: null });
  });

  it("opens menu-freshness missions as full updates without widening beer-specific missions", async () => {
    const { repository, missionLifecycleRepository, service } = createHarness();
    const contributor = createAccount(repository, "mission-routing-contributor");
    const createRoutedMission = (id: string, reason: string) => (
      missionLifecycleRepository.createMission({
        id,
        venueId: `venue-${id}`,
        venueName: `Venue ${id}`,
        suburb: "Brighton",
        reason,
        priority: "high",
        points: 5,
        multiplier: 1,
        active: true,
        lastVerifiedAt: "2026-06-01T00:00:00.000Z",
        createdAt: START,
        updatedAt: START,
      })
    );
    const staleDrinkMenu = await createRoutedMission(
      "mission-stale-drink-menu",
      "Stale drink-menu - update with current venue data",
    );
    const menuFreshness = await createRoutedMission(
      "mission-menu-freshness",
      "Menu-freshness check - update with current venue data",
    );
    const staleBeer = await createRoutedMission(
      "mission-stale-beer",
      "Stale Carlton Draught price - update with current venue data",
    );

    const acceptedTypes = await Promise.all(
      [staleDrinkMenu, menuFreshness, staleBeer].map(async (mission) => {
        const accepted = await service.acceptMission(contributor, mission.id);
        return new URL(accepted.submitUrl, "https://pintpath.test").searchParams.get("type");
      }),
    );

    expect(acceptedTypes).toEqual([
      "full_venue_update",
      "full_venue_update",
      "single_beer_price",
    ]);
  });

  it("moves an accepted mission through submitted to completed and archives it on approval", async () => {
    const { repository, service } = createHarness();
    const contributor = createAccount(repository, "mission-contributor");
    const challenger = createAccount(repository, "mission-challenger");
    const admin = createAccount(repository, "mission-admin", "admin");
    const mission = await createMission(service);

    expect((await service.acceptMission(contributor, mission.id)).progress.status).toBe("accepted");

    const submission = (await submitMission(service, contributor, mission)).submission;
    expect(await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: contributor.id,
    }))
      .toMatchObject({ status: "submitted", submissionId: submission.id });

    // Reopening an already-submitted mission must never regress it to accepted.
    expect((await service.acceptMission(contributor, mission.id)).progress)
      .toMatchObject({ status: "submitted", submissionId: submission.id });
    await expect(service.acceptMission(challenger, mission.id)).rejects.toThrow();

    expect((await approveMissionSubmission(service, admin, submission.id)).submission.status).toBe("approved");
    expect(await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: contributor.id,
    }))
      .toMatchObject({ status: "completed", submissionId: submission.id });
    expect((await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: contributor.id,
    }))?.completedAt)
      .toBe(START);
    expect((await getMissionLifecycleRepository(repository).getMissionById(mission.id))?.active).toBe(false);
  });

  it("cancels legacy competing acceptances and submissions when the winning submission is approved", async () => {
    const { database, repository, communitySubmissionRepository, service } = createHarness();
    const winner = createAccount(repository, "mission-winner");
    const acceptedCompetitor = createAccount(repository, "mission-accepted-competitor");
    const submittedCompetitor = createAccount(repository, "mission-submitted-competitor");
    const admin = createAccount(repository, "mission-reviewer", "admin");
    const mission = await createMission(service);

    await service.acceptMission(winner, mission.id);
    const winningSubmission = (await submitMission(service, winner, mission)).submission;
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
    const competingSubmission = await seedLegacyMissionSubmission(
      communitySubmissionRepository,
      submittedCompetitor,
      mission,
      "competing-legacy-submission",
    );

    await approveMissionSubmission(service, admin, winningSubmission.id);

    expect((await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: winner.id,
    }))?.status).toBe("completed");
    expect((await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: acceptedCompetitor.id,
    }))?.status)
      .toBe("cancelled");
    expect((await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: submittedCompetitor.id,
    }))?.status)
      .toBe("cancelled");

    // A later review of already-queued competing work must not replace the winner.
    await approveMissionSubmission(service, admin, competingSubmission.id);
    expect((await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: submittedCompetitor.id,
    }))?.status)
      .toBe("cancelled");
  });

  it("rejects a mission-linked submission unless that user owns its active reservation", async () => {
    const { repository, service } = createHarness();
    const reservedBy = createAccount(repository, "mission-reservation-owner");
    const bypassingUser = createAccount(repository, "mission-reservation-bypass");
    const mission = await createMission(service);

    await service.acceptMission(reservedBy, mission.id);
    await expect(submitMission(service, bypassingUser, mission)).rejects.toThrow();
    expect(await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: bypassingUser.id,
    })).toBeNull();
  });

  it("enforces mission ownership inside the repository transaction", async () => {
    const { repository, communitySubmissionRepository, service } = createHarness();
    const bypassingUser = createAccount(repository, "mission-repository-bypass");
    const mission = await createMission(service);

    await expect(seedLegacyMissionSubmission(
      communitySubmissionRepository,
      bypassingUser,
      mission,
      "repository-bypass-submission",
    )).rejects.toMatchObject({ code: "mission_reservation_invalid" });
    expect(repository.getSubmissionByClientSubmissionId(
      bypassingUser.id,
      "legacy-repository-bypass-submission",
    )).toBeNull();
  });

  it("rejects a reserved mission submission for a different venue inside the repository transaction", async () => {
    const { repository, communitySubmissionRepository, service } = createHarness();
    const contributor = createAccount(repository, "mission-cross-venue-contributor");
    const mission = await createMission(service);

    await service.acceptMission(contributor, mission.id);
    await expect(seedLegacyMissionSubmission(
      communitySubmissionRepository,
      contributor,
      {
        ...mission,
        venueId: "different-venue",
        venueName: "Different Venue Hotel",
      },
      "cross-venue-mission-submission",
    )).rejects.toMatchObject({ code: "mission_reservation_invalid" });
    expect(repository.getSubmissionByClientSubmissionId(
      contributor.id,
      "legacy-cross-venue-mission-submission",
    )).toBeNull();
    expect(await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: contributor.id,
    }))
      .toMatchObject({ status: "accepted", submissionId: null });
  });

  it("blocks an active reservation but atomically reclaims it after the 24-hour acceptance TTL", async () => {
    const { repository, service } = createHarness();
    const first = createAccount(repository, "mission-first-acceptor");
    const second = createAccount(repository, "mission-second-acceptor");
    const mission = await createMission(service);

    await service.acceptMission(first, mission.id);
    vi.advanceTimersByTime(DAY_MS - 1_000);
    await expect(service.acceptMission(second, mission.id)).rejects.toThrow();
    expect((await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: first.id,
    }))?.status).toBe("accepted");

    vi.advanceTimersByTime(2_000);
    expect((await service.acceptMission(second, mission.id)).progress.status).toBe("accepted");
    expect((await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: first.id,
    }))?.status).toBe("cancelled");
    expect((await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: second.id,
    }))?.status).toBe("accepted");
  });

  it("shows a reserved mission only to its current owner", async () => {
    const { repository, service } = createHarness();
    const owner = createAccount(repository, "mission-visible-owner");
    const otherUser = createAccount(repository, "mission-hidden-user");
    const mission = await createMission(service);

    await service.acceptMission(owner, mission.id);

    expect(await service.listMissions({ limit: 200 }, owner))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: mission.id, userProgress: "accepted" })]));
    expect((await service.listMissions({ limit: 200 }, otherUser)).some((candidate) => candidate.id === mission.id)).toBe(false);
    expect((await service.listMissions({ limit: 200 }, null)).some((candidate) => candidate.id === mission.id)).toBe(false);
  });

  it("keeps concurrent owner and public feed reads on the accepted reservation authority", async () => {
    const { repository, service } = createHarness();
    const owner = createAccount(repository, "mission-concurrent-feed-owner");
    const otherUser = createAccount(repository, "mission-concurrent-feed-other");
    const mission = await createMission(service, "concurrent-feed-venue", "Concurrent Feed Hotel");

    const accepted = await service.acceptMission(owner, mission.id);
    const [ownerMissions, otherMissions, publicMissions] = await Promise.all([
      service.listMissions({ limit: 200 }, owner),
      service.listMissions({ limit: 200 }, otherUser),
      service.listMissions({ limit: 200 }, null),
    ]);

    expect(accepted).toEqual(expect.objectContaining({
      mission: expect.objectContaining({ id: mission.id }),
    }));
    expect(ownerMissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: mission.id, userProgress: "accepted" }),
    ]));
    expect(otherMissions.some((candidate) => candidate.id === mission.id)).toBe(false);
    expect(publicMissions.some((candidate) => candidate.id === mission.id)).toBe(false);
  });

  it("keeps every mission reachable beyond the first 200 results", async () => {
    const { service } = createHarness();
    const createdIds = new Set<string>();
    for (let index = 0; index < 205; index += 1) {
      const mission = await createMission(service, `venue-page-${String(index).padStart(3, "0")}`, `Paged Venue ${index}`);
      createdIds.add(mission.id);
    }

    const returnedIds = new Set<string>();
    let offset = 0;
    let page = await service.getMissionsPage({ limit: 200, offset, sort: "points" });
    expect(page.pagination).toMatchObject({ limit: 200, offset: 0, hasMore: true });
    while (true) {
      page.missions.forEach((mission) => returnedIds.add(mission.id));
      if (!page.pagination.hasMore) break;
      offset += page.pagination.limit;
      page = await service.getMissionsPage({ limit: 200, offset, sort: "points" });
    }

    expect(page.pagination.hasMore).toBe(false);
    expect(returnedIds.size).toBe(page.pagination.total);
    expect([...createdIds].every((id) => returnedIds.has(id))).toBe(true);
  });

  it("retains completion state beyond 200 mission-progress rows", async () => {
    const { database, repository, service } = createHarness();
    const contributor = createAccount(repository, "mission-progress-heavy-user");
    let oldestMissionId = "";
    for (let index = 0; index < 201; index += 1) {
      const mission = await createMission(
        service,
        `progress-venue-${String(index).padStart(3, "0")}`,
        index === 0 ? "Oldest Completed Venue" : `Progress Filler Venue ${index}`,
      );
      if (index === 0) oldestMissionId = mission.id;
      await getMissionLifecycleRepository(repository).acceptMission({
        missionId: mission.id,
        userId: contributor.id,
        now: START,
        acceptedAfter: "2020-01-01T00:00:00.000Z",
      });
      const lifecycleAt = index === 0 ? "2025-01-01T00:00:00.000Z" : START;
      database.prepare(
        `UPDATE mission_progress
            SET status = 'completed', accepted_at = ?, completed_at = ?, updated_at = ?
          WHERE mission_id = ? AND user_id = ?`,
      ).run(
        lifecycleAt,
        lifecycleAt,
        index === 0 ? "2025-01-01T00:00:00.000Z" : `2026-07-14T01:${String(index % 60).padStart(2, "0")}:00.000Z`,
        mission.id,
        contributor.id,
      );
    }

    expect(await listAllMissionProgress(repository, contributor.id)).toHaveLength(201);
    expect((await service.listMissions({ q: "Oldest Completed Venue", limit: 10 }, contributor))
      .find((mission) => mission.id === oldestMissionId))
      .toEqual(expect.objectContaining({ id: oldestMissionId, userProgress: "completed" }));
  });

  it("expires abandoned acceptances during maintenance without waiting for another user", async () => {
    const { repository, service } = createHarness();
    const contributor = createAccount(repository, "mission-expired-acceptor");
    const mission = await createMission(service);

    await service.acceptMission(contributor, mission.id);
    vi.advanceTimersByTime(DAY_MS + 1_000);
    const result = await service.runMissionMaintenance({ forceRefresh: true });

    expect(result.expiredAcceptances).toBe(1);
    expect((await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: contributor.id,
    }))?.status)
      .toBe("cancelled");
    expect((await getMissionLifecycleRepository(repository).getMissionById(mission.id))?.active).toBe(true);
  });

  it("does not regenerate auto missions for legacy demo venue candidates in production", async () => {
    const { database, repository, missionDiscoveryAutomationRepository, service } = createHarness({ nodeEnv: "production" });
    await getMissionLifecycleRepository(repository).createMission({
      id: "mission:inactive-real-venue",
      venueId: "inactive-real-venue",
      venueName: "Inactive Real Venue",
      suburb: "Melbourne",
      reason: "Legacy inactive mission",
      priority: "normal",
      points: 3,
      multiplier: 1,
      active: false,
      lastVerifiedAt: null,
      createdAt: START,
      updatedAt: START,
    });
    await getMissionLifecycleRepository(repository).createMission({
      id: "mission:rooftop-bar",
      venueId: "demo:rooftop-bar",
      venueName: "Rooftop Bar",
      suburb: "Melbourne",
      reason: "Legacy demo mission",
      priority: "high",
      points: 5,
      multiplier: 1,
      active: true,
      lastVerifiedAt: null,
      createdAt: START,
      updatedAt: START,
    });
    repository.upsertVenueLocationCache({
      venueId: "demo:rooftop-bar",
      venueName: "Rooftop Bar",
      suburb: "Melbourne",
      latitude: -37.81,
      longitude: 144.96,
      now: START,
    });
    repository.upsertVenueLocationCache({
      venueId: "official-rooftop-bar",
      venueName: "Official Rooftop Bar",
      suburb: "Melbourne",
      latitude: -37.81,
      longitude: 144.96,
      now: START,
    });

    expect((await missionDiscoveryAutomationRepository.listMissionVenueCandidates({ limit: 100 }))
      .map((candidate) => candidate.venueId))
      .not.toContain("inactive-real-venue");

    const result = await service.runMissionMaintenance({ forceRefresh: true });

    expect(result.candidates).toBe(1);
    expect(result.generated).toBe(1);
    expect(await getMissionLifecycleRepository(repository).getMissionById("mission:rooftop-bar"))
      .toEqual(expect.objectContaining({ active: false }));
    expect(database.prepare(
      "SELECT count(*) AS total FROM missions WHERE venue_id LIKE 'demo:%' AND active = 1",
    ).get()).toEqual({ total: 0 });
    expect(await getMissionLifecycleRepository(repository).getMissionById("auto:venue:official-rooftop-bar:coverage"))
      .toEqual(expect.objectContaining({ venueId: "official-rooftop-bar", active: true }));
    expect(database.prepare(
      "SELECT count(*) AS total FROM missions WHERE id LIKE 'auto:%' AND venue_id = 'inactive-real-venue'",
    ).get()).toEqual({ total: 0 });
  });

  it("refreshes needed auto missions, prunes unreferenced inactive rows, and retains completed history", async () => {
    const { database, repository, service } = createHarness();
    const contributor = createAccount(repository, "mission-history-contributor");
    const admin = createAccount(repository, "mission-history-admin", "admin");

    await getMissionLifecycleRepository(repository).createMission({
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
    const completedMission = await getMissionLifecycleRepository(repository)
      .getMissionById("auto:venue:venue-completed-history:coverage");
    if (!completedMission) throw new Error("Expected completed-history mission fixture.");
    await service.acceptMission(contributor, completedMission.id);
    const completedSubmission = (await submitMission(service, contributor, completedMission)).submission;
    await approveMissionSubmission(service, admin, completedSubmission.id);

    await getMissionLifecycleRepository(repository).createMission({
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

    const result = await service.runMissionMaintenance({ forceRefresh: true });

    expect(result.generated).toBeGreaterThan(0);
    expect(result.pruned).toBeGreaterThanOrEqual(1);
    expect(await getMissionLifecycleRepository(repository)
      .getMissionById("auto:venue:unreferenced-old-venue:coverage")).toBeNull();
    expect(await getMissionLifecycleRepository(repository).getMissionById(completedMission.id))
      .toMatchObject({ active: false });
    expect((await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: completedMission.id,
      userId: contributor.id,
    }))?.status)
      .toBe("completed");
    expect(database.prepare(
      "SELECT COUNT(*) AS total FROM missions WHERE id LIKE 'auto:venue:venue-needing-coverage:%' AND active = 1",
    ).get()).toMatchObject({ total: 1 });
  });

  it("traverses every venue candidate in bounded pages beyond the old 2,000-venue ceiling", async () => {
    const { database, repository, missionDiscoveryAutomationRepository, service } = createHarness();
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
    const pageSpy = vi.spyOn(missionDiscoveryAutomationRepository, "listMissionVenueCandidates");

    const result = await service.runMissionMaintenance({ forceRefresh: true });

    expect(result.candidates).toBe(2_001);
    expect(result.generated).toBe(2_001);
    expect(pageSpy.mock.calls).toEqual([
      [{ limit: 500, offset: 0 }],
      [{ limit: 500, offset: 500 }],
      [{ limit: 500, offset: 1_000 }],
      [{ limit: 500, offset: 1_500 }],
      [{ limit: 500, offset: 2_000 }],
    ]);
    expect(await getMissionLifecycleRepository(repository)
      .getMissionById("auto:venue:deep-mission-venue-2000:coverage")).toEqual(
      expect.objectContaining({ venueId: "deep-mission-venue-2000", active: true }),
    );
  });

  it("fails closed on duplicate candidate pages and empty locked maintenance batches", async () => {
    const { missionDiscoveryAutomationRepository, service } = createHarness();
    const duplicateCandidate = {
      venueId: "duplicate-candidate",
      venueName: "Duplicate Candidate",
      suburb: "Melbourne",
      latestVerifiedAt: null,
      recordCount: 0,
      happyHourLastVerifiedAt: null,
    };
    const candidateSpy = vi.spyOn(missionDiscoveryAutomationRepository, "listMissionVenueCandidates")
      .mockResolvedValue([duplicateCandidate, duplicateCandidate]);
    await expect(service.runMissionMaintenance({ forceRefresh: true }))
      .rejects.toThrow("duplicate venue");
    expect(candidateSpy).toHaveBeenCalledTimes(1);

    candidateSpy.mockClear();
    candidateSpy.mockImplementation(async ({ offset = 0 }) => Array.from({ length: 500 }, (_, index) => ({
      ...duplicateCandidate,
      venueId: `bounded-candidate-${offset + index}`,
      venueName: `Bounded Candidate ${offset + index}`,
    })));
    await expect(service.runMissionMaintenance({ forceRefresh: true }))
      .rejects.toThrow("bounded scan budget");
    expect(candidateSpy).toHaveBeenCalledTimes(10);

    candidateSpy.mockClear();
    candidateSpy.mockResolvedValue([]);
    const pruneSpy = vi.spyOn(missionDiscoveryAutomationRepository, "pruneInactiveAutoMissions")
      .mockResolvedValue({ changed: 0, hasMore: true });
    await expect(service.runMissionMaintenance({ forceRefresh: true }))
      .rejects.toThrow("empty or locked batch");
    expect(pruneSpy).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent service maintenance into one deterministic auto mission", async () => {
    const { database, repository, service } = createHarness();
    repository.upsertVenueLocationCache({
      venueId: "concurrent-maintenance-venue",
      venueName: "Concurrent Maintenance Hotel",
      suburb: "Melbourne",
      latitude: -37.81,
      longitude: 144.96,
      now: START,
    });

    const results = await Promise.all([
      service.runMissionMaintenance({ forceRefresh: true }),
      service.runMissionMaintenance({ forceRefresh: true }),
    ]);

    expect(results.map((result) => result.generated)).toEqual([1, 1]);
    expect(database.prepare(
      "SELECT count(*) AS total FROM missions WHERE id = 'auto:venue:concurrent-maintenance-venue:coverage'",
    ).get()).toEqual({ total: 1 });
  });

  it("normalizes duplicate legacy reservations before restoring the exclusive database index", async () => {
    const { database, repository, service } = createHarness();
    const acceptedUser = createAccount(repository, "legacy-accepted-user");
    const submittedUser = createAccount(repository, "legacy-submitted-user");
    const thirdUser = createAccount(repository, "legacy-third-user");
    const mission = await createMission(service);

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

    expect((await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: submittedUser.id,
    }))?.status)
      .toBe("submitted");
    expect((await getMissionLifecycleRepository(repository).getMissionProgress({
      missionId: mission.id,
      userId: acceptedUser.id,
    }))?.status)
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
