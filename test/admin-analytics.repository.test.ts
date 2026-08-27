import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  AdminAnalyticsRepository,
  AdminAnalyticsRepositoryError,
  type AdminAnalyticsRepositoryErrorCode,
} from "../src/db/admin-analytics.repository.js";
import { initializeDatabaseSchema } from "../src/db/database.js";
import { AsyncSqliteDatabase } from "../src/db/sql-database.js";
import {
  ANALYTICS_AS_OF,
  ANALYTICS_STALE_BEFORE,
  ANALYTICS_TOTAL_VENUES,
  EXPECTED_COVERAGE_WITHOUT_AGE,
  EXPECTED_KPI_BUCKETS,
  EXPECTED_KPI_METRICS,
  EXPECTED_MONTH_COHORTS,
  EXPECTED_PARTNER_LEADS,
  EXPECTED_WEEK_COHORTS,
  KPI_INPUT,
  seedAdminAnalyticsFixture,
} from "./admin-analytics.repository.fixtures.js";

interface Fixture {
  raw: BetterSqlite3.Database;
  database: AsyncSqliteDatabase;
  repository: AdminAnalyticsRepository;
}

function expectCode(code: AdminAnalyticsRepositoryErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof AdminAnalyticsRepositoryError && error.code === code;
}

describe("AdminAnalyticsRepository with AsyncSqliteDatabase", () => {
  const databases: AsyncSqliteDatabase[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  async function fixture(): Promise<Fixture> {
    const raw = new BetterSqlite3(":memory:");
    initializeDatabaseSchema(raw);
    const database = new AsyncSqliteDatabase(raw);
    databases.push(database);
    await seedAdminAnalyticsFixture(database);
    return { raw, database, repository: new AdminAnalyticsRepository(database) };
  }

  it("preserves the complete KPI definitions with inclusive range boundaries and deterministic ties", async () => {
    const { repository } = await fixture();
    const dashboard = await repository.getAdminKpiDashboard(KPI_INPUT);
    const preview = await repository.getAnalyticsPreview();

    expect(preview.missionConversionCount).toBe(1);
    expect(preview.topSearchedBeers).toContainEqual({ key: "guinness", count: 3 });
    expect(preview.topClickedVenues).toContainEqual({ key: "venue-alpha", label: "Alpha Hotel", count: 3 });

    expect(dashboard.metrics).toEqual(EXPECTED_KPI_METRICS);
    expect(dashboard.searchUsefulness).toMatchObject({
      definition: "client_reported_search_usefulness_v1",
      evidenceStatus: "client_reported_non_formal",
      formalReleaseEvidence: false,
      searchEventCount: 4,
      measuredSearchCount: 0,
      unmeasuredSearchCount: 4,
      successfulSearchCount: 0,
      successfulSearchRate: null,
      averageUsefulResultCount: null,
    });
    expect({
      topSearchedBeers: dashboard.topSearchedBeers,
      topSearchedSuburbs: dashboard.topSearchedSuburbs,
      topClickedVenues: dashboard.topClickedVenues,
      topVenuesNeedingData: dashboard.topVenuesNeedingData,
      highDemandVenuesWithStaleOrMissingData: dashboard.highDemandVenuesWithStaleOrMissingData,
    }).toEqual(EXPECTED_KPI_BUCKETS);
    expect(dashboard.scorecard).toEqual([
      { label: "100 users tried the app", current: 27, target: 100, progress: 0.27, status: "in progress" },
      { label: "30 users returned within 30 days", current: 3, target: 30, progress: 0.1, status: "in progress" },
      { label: "20 users submitted data", current: 4, target: 20, progress: 0.2, status: "in progress" },
      { label: "100 verified prices added", current: 4, target: 100, progress: 0.04, status: "in progress" },
      { label: "10 users paid for yearly access", current: 1, target: 10, progress: 0.1, status: "in progress" },
      { label: "3 venues flagged as potential partner leads", current: 4, target: 3, progress: 1, status: "hit" },
    ]);

    const allTime = await repository.getAdminKpiDashboard({ ...KPI_INPUT, since: null });
    expect(allTime.metrics).toMatchObject({
      newUsers: 5,
      subscriptionConversionCount: 2,
      totalApprovedSubmissions: 1,
      totalRejectedSubmissions: 2,
      totalContributorPointsAwarded: 14.5,
    });
  });

  it("aggregates consent-scoped client-reported search usefulness through the server as-of boundary", async () => {
    const { raw, repository } = await fixture();
    raw.prepare(
      `UPDATE account_privacy_settings
          SET optional_analytics_enabled = 0
        WHERE user_id = 'user-b'`,
    ).run();
    const insert = raw.prepare(
      `INSERT INTO events (
         id, user_id, anonymous_session_id, event_type, venue_id, beer_id, suburb,
         metadata_json, created_at
       ) VALUES (?, ?, ?, 'search_performed', NULL, NULL, 'Richmond', ?, ?)`,
    );
    const events = [
      ["useful-success", null, "useful-anon", { usefulResultCount: 3, searchSuccessful: true }, "2026-07-20T00:00:00.000Z"],
      ["useful-zero", null, "useful-anon", { usefulResultCount: 0, searchSuccessful: false }, "2026-07-20T00:01:00.000Z"],
      ["useful-two", null, "useful-anon", { usefulResultCount: 2, searchSuccessful: false }, "2026-07-20T00:02:00.000Z"],
      ["useful-inconsistent", null, "useful-anon", { usefulResultCount: 3, searchSuccessful: false }, "2026-07-20T00:03:00.000Z"],
      ["useful-authenticated", "user-a", null, { usefulResultCount: 4, searchSuccessful: true }, "2026-07-20T00:04:00.000Z"],
      ["useful-invalid", null, "useful-anon", { usefulResultCount: "3", searchSuccessful: true }, "2026-07-20T00:05:00.000Z"],
      ["useful-opted-out", "user-b", null, { usefulResultCount: 10, searchSuccessful: true }, "2026-07-20T00:06:00.000Z"],
      ["useful-before-range", null, "useful-anon", { usefulResultCount: 10, searchSuccessful: true }, "2026-06-30T23:59:59.999Z"],
      ["useful-after-as-of", null, "useful-anon", { usefulResultCount: 10, searchSuccessful: true }, "2026-08-01T00:00:00.001Z"],
    ] as const;
    for (const [id, userId, anonymousSessionId, metadata, createdAt] of events) {
      insert.run(id, userId, anonymousSessionId, JSON.stringify(metadata), createdAt);
    }
    raw.prepare(
      `INSERT INTO events (
         id, user_id, anonymous_session_id, event_type, venue_id, beer_id, suburb,
         metadata_json, created_at
       ) VALUES ('useful-beer-search', NULL, 'useful-anon', 'beer_search_performed',
                 NULL, 'guinness', NULL, ?, '2026-07-20T00:07:00.000Z')`,
    ).run(JSON.stringify({ usefulResultCount: 5, searchSuccessful: true }));

    const dashboard = await repository.getAdminKpiDashboard(KPI_INPUT);

    expect(dashboard.searchUsefulness).toEqual({
      definition: "client_reported_search_usefulness_v1",
      evidenceStatus: "client_reported_non_formal",
      formalReleaseEvidence: false,
      population: "currently_opted_in_accounts_and_consented_anonymous_sessions",
      caveat: expect.stringContaining("not formal release evidence"),
      usefulResultThreshold: 3,
      searchEventCount: 11,
      measuredSearchCount: 6,
      unmeasuredSearchCount: 5,
      successfulSearchCount: 4,
      successfulSearchRate: 4 / 6,
      averageUsefulResultCount: 17 / 6,
      inconsistentSuccessFlagCount: 1,
      distribution: { zero: 1, one: 0, two: 1, threeOrMore: 4 },
    });
  });

  it("uses SQLite-compatible week buckets without N+1 reads and enforces retention bounds", async () => {
    const { database, repository } = await fixture();
    const completedBefore = database.metrics().completedQueries;

    await expect(repository.getRetentionCohorts({ groupBy: "week", limit: 24, asOf: ANALYTICS_AS_OF }))
      .resolves.toEqual(EXPECTED_WEEK_COHORTS);
    expect(database.metrics().completedQueries - completedBefore).toBe(1);
    await expect(repository.getRetentionCohorts({ groupBy: "month", limit: 24, asOf: ANALYTICS_AS_OF }))
      .resolves.toEqual(EXPECTED_MONTH_COHORTS);
    await expect(repository.getRetentionCohorts({ groupBy: "week", limit: 2, asOf: ANALYTICS_AS_OF }))
      .resolves.toEqual(EXPECTED_WEEK_COHORTS.slice(0, 2));
    await expect(repository.getRetentionCohorts({ groupBy: "week", limit: 0, asOf: ANALYTICS_AS_OF }))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.getRetentionCohorts({ groupBy: "week", limit: 25, asOf: ANALYTICS_AS_OF }))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.getRetentionCohorts({ groupBy: "quarter" as "week", limit: 4, asOf: ANALYTICS_AS_OF }))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.getRetentionCohorts({ groupBy: "week", limit: 4, asOf: "2026-08-01" }))
      .rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("counts core-loop activity on UTC D1-D7 but never signup-day activity as a return", async () => {
    const { raw, repository } = await fixture();
    const coreLoopEvents = [
      "map_viewed",
      "search_performed",
      "beer_search_performed",
      "suburb_search_performed",
      "venue_card_viewed",
      "venue_detail_opened",
      "saved_venue_added",
      "saved_beer_added",
      "saved_suburb_added",
      "saved_night_plan_added",
      "tonight_plan_created",
      "submission_completed",
      "data_verified",
      "price_confirmation_answered",
      "wrong_price_reported",
    ] as const;
    const signupAt = "2026-03-02T23:59:00.000Z";
    const d1At = "2026-03-03T00:01:00.000Z";
    const accountInsert = raw.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, status, created_at, updated_at
       ) VALUES (?, ?, 'hash', 'user', 'free', 'active', ?, ?)`,
    );
    const eventInsert = raw.prepare(
      `INSERT INTO events (
         id, user_id, anonymous_session_id, event_type, venue_id, beer_id, suburb,
         metadata_json, created_at
       ) VALUES (?, ?, NULL, ?, NULL, NULL, NULL, '{}', ?)`,
    );
    const privacyInsert = raw.prepare(
      `INSERT INTO account_privacy_settings (
         user_id, optional_analytics_enabled, venue_report_inclusion_enabled,
         product_research_enabled, email_updates_enabled, consent_version,
         consented_at, created_at, updated_at
       ) VALUES (?, 1, 0, 0, 0, 'test-v1', ?, ?, ?)`,
    );

    for (const [index, eventType] of coreLoopEvents.entries()) {
      const userId = `d1-loop-user-${index}`;
      accountInsert.run(userId, `${userId}@example.test`, signupAt, signupAt);
      privacyInsert.run(userId, signupAt, signupAt, signupAt);
      eventInsert.run(`d1-loop-event-${index}`, userId, eventType, d1At);
    }
    accountInsert.run("signup-day-only", "signup-day-only@example.test", signupAt, signupAt);
    privacyInsert.run("signup-day-only", signupAt, signupAt, signupAt);
    eventInsert.run(
      "signup-day-only-event",
      "signup-day-only",
      "saved_venue_added",
      "2026-03-02T23:59:59.999Z",
    );

    const march = (await repository.getRetentionCohorts({
      groupBy: "month",
      limit: 24,
      asOf: "2026-04-15T00:00:00.000Z",
    }))
      .find((cohort) => cohort.cohort === "2026-03");
    expect(march).toEqual({
      cohort: "2026-03",
      users: coreLoopEvents.length + 1,
      eligibleUsers7: coreLoopEvents.length + 1,
      eligibleUsers30: coreLoopEvents.length + 1,
      returned7: coreLoopEvents.length,
      returned30: coreLoopEvents.length,
      retention7: coreLoopEvents.length / (coreLoopEvents.length + 1),
      retention30: coreLoopEvents.length / (coreLoopEvents.length + 1),
    });
  });

  it("excludes explicitly opted-out accounts from the consented retention population", async () => {
    const { raw, repository } = await fixture();
    const signupAt = "2026-03-02T12:00:00.000Z";
    raw.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, status, created_at, updated_at
       ) VALUES ('opted-out-returner', 'opted-out@example.test', 'hash', 'user', 'free', 'active', ?, ?)`,
    ).run(signupAt, signupAt);
    raw.prepare(
      `INSERT INTO account_privacy_settings (
         user_id, optional_analytics_enabled, venue_report_inclusion_enabled,
         product_research_enabled, email_updates_enabled, consent_version,
         consented_at, created_at, updated_at
       ) VALUES ('opted-out-returner', 0, 0, 0, 0, 'test-v1', NULL, ?, ?)`,
    ).run(signupAt, signupAt);
    raw.prepare(
      `INSERT INTO events (
         id, user_id, anonymous_session_id, event_type, venue_id, beer_id, suburb,
         metadata_json, created_at
       ) VALUES ('opted-out-return', 'opted-out-returner', NULL, 'saved_venue_added',
                 NULL, NULL, NULL, '{}', '2026-03-03T12:00:00.000Z')`,
    ).run();

    const optedOut = await repository.getRetentionCohorts({
      groupBy: "month",
      limit: 24,
      asOf: "2026-04-15T00:00:00.000Z",
    });
    expect(optedOut.find((cohort) => cohort.cohort === "2026-03")).toBeUndefined();

    raw.prepare(
      `UPDATE account_privacy_settings
          SET optional_analytics_enabled = 1,
              consented_at = '2026-03-10T12:00:00.000Z',
              updated_at = '2026-03-10T12:00:00.000Z'
        WHERE user_id = 'opted-out-returner'`,
    ).run();
    const consentedBeforeReturn = await repository.getRetentionCohorts({
      groupBy: "month",
      limit: 24,
      asOf: "2026-04-15T00:00:00.000Z",
    });
    expect(consentedBeforeReturn.find((cohort) => cohort.cohort === "2026-03")).toEqual({
      cohort: "2026-03",
      users: 1,
      eligibleUsers7: 1,
      eligibleUsers30: 1,
      returned7: 0,
      returned30: 0,
      retention7: 0,
      retention30: 0,
    });
    raw.prepare(
      `INSERT INTO events (
         id, user_id, anonymous_session_id, event_type, venue_id, beer_id, suburb,
         metadata_json, created_at
       ) VALUES ('opted-in-return', 'opted-out-returner', NULL, 'saved_venue_added',
                 NULL, NULL, NULL, '{}', '2026-03-11T12:00:00.000Z')`,
    ).run();
    const optedIn = await repository.getRetentionCohorts({
      groupBy: "month",
      limit: 24,
      asOf: "2026-04-15T00:00:00.000Z",
    });
    expect(optedIn.find((cohort) => cohort.cohort === "2026-03")).toEqual({
      cohort: "2026-03",
      users: 1,
      eligibleUsers7: 1,
      eligibleUsers30: 1,
      returned7: 1,
      returned30: 1,
      retention7: 1,
      retention30: 1,
    });
  });

  it("keeps the current analytics opt-in cohort stable across unrelated consent revisions", async () => {
    const { raw, repository } = await fixture();
    raw.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, status, created_at, updated_at
       ) VALUES (
         'stable-opt-in', 'stable-opt-in@example.test', 'hash', 'user', 'free', 'active',
         '2026-02-01T12:00:00.000Z', '2026-02-01T12:00:00.000Z'
       )`,
    ).run();
    raw.prepare(
      `INSERT INTO account_privacy_settings (
         user_id, optional_analytics_enabled, venue_report_inclusion_enabled,
         product_research_enabled, email_updates_enabled, consent_version,
         consented_at, created_at, updated_at
       ) VALUES (
         'stable-opt-in', 1, 0, 0, 0, 'test-v1',
         '2026-02-02T12:00:00.000Z',
         '2026-02-02T12:00:00.000Z', '2026-02-02T12:00:00.000Z'
       )`,
    ).run();
    raw.prepare(
      `INSERT INTO user_activity_events (
         id, user_id, event_type, related_entity_type, related_entity_id,
         metadata_json, created_at
       ) VALUES (
         'stable-opt-in-enabled', 'stable-opt-in', 'account_privacy_settings_updated',
         'account', 'stable-opt-in', '{"optionalAnalyticsEnabled":true}',
         '2026-02-02T12:00:00.000Z'
       )`,
    ).run();
    raw.prepare(
      `INSERT INTO events (
         id, user_id, anonymous_session_id, event_type, venue_id, beer_id, suburb,
         metadata_json, created_at
       ) VALUES (
         'stable-opt-in-return', 'stable-opt-in', NULL, 'search_performed',
         NULL, NULL, NULL, '{}', '2026-02-03T12:00:00.000Z'
       )`,
    ).run();

    const before = await repository.getRetentionCohorts({
      groupBy: "month",
      limit: 24,
      asOf: "2026-04-15T00:00:00.000Z",
    });
    raw.prepare(
      `UPDATE account_privacy_settings
          SET consented_at = '2026-03-20T12:00:00.000Z',
              updated_at = '2026-03-20T12:00:00.000Z'
        WHERE user_id = 'stable-opt-in'`,
    ).run();
    raw.prepare(
      `INSERT INTO user_activity_events (
         id, user_id, event_type, related_entity_type, related_entity_id,
         metadata_json, created_at
       ) VALUES (
         'stable-opt-in-unrelated-edit', 'stable-opt-in', 'account_privacy_settings_updated',
         'account', 'stable-opt-in', '{"optionalAnalyticsEnabled":true}',
         '2026-03-20T12:00:00.000Z'
       )`,
    ).run();
    const after = await repository.getRetentionCohorts({
      groupBy: "month",
      limit: 24,
      asOf: "2026-04-15T00:00:00.000Z",
    });

    expect(after).toEqual(before);
    expect(after.find((cohort) => cohort.cohort === "2026-02")).toEqual({
      cohort: "2026-02",
      users: 1,
      eligibleUsers7: 1,
      eligibleUsers30: 1,
      returned7: 1,
      returned30: 1,
      retention7: 1,
      retention30: 1,
    });
  });

  it("measures a consent-scoped mature D7 Saved Updates ITT without treatment-only outcome bias", async () => {
    const { raw, database, repository } = await fixture();
    const anchor = "2026-08-20T12:00:00.000Z";
    const asOf = "2026-08-31T12:00:00.000Z";
    const metadata = (
      variant: "control" | "treatment",
      accountRole = "user",
      eligibleAtAssignment = false,
      accountSubscriptionStatus = "free",
    ) => JSON.stringify({
      accountRole,
      accountSubscriptionStatus,
      savedUpdatesEligibleAtAssignment: eligibleAtAssignment,
      savedUpdatesExperimentVersion: "v1",
      savedUpdatesVariant: variant,
    });
    const accountInsert = raw.prepare(
      `INSERT INTO accounts (
         id, email, password_hash, role, subscription_status, status, created_at, updated_at
       ) VALUES (?, ?, 'hash', ?, ?, 'active', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    );
    const privacyInsert = raw.prepare(
      `INSERT INTO account_privacy_settings (
         user_id, optional_analytics_enabled, venue_report_inclusion_enabled,
         product_research_enabled, email_updates_enabled, consent_version,
         consented_at, created_at, updated_at
       ) VALUES (?, ?, 0, 0, 0, 'experiment-v1', ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    );
    const eventInsert = raw.prepare(
      `INSERT INTO events (
         id, user_id, anonymous_session_id, event_type, venue_id, beer_id, suburb,
         metadata_json, created_at
       ) VALUES (?, ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
    );
    const addAccount = (input: {
      id: string;
      variant: "control" | "treatment";
      anchor?: string;
      optedIn?: boolean;
      role?: "user" | "admin" | "venue_manager";
      eligibleAtAssignment?: boolean;
      accountSubscriptionStatus?: string;
    }) => {
      const role = input.role ?? "user";
      const assignedAt = input.anchor ?? anchor;
      const accountSubscriptionStatus = input.accountSubscriptionStatus ?? "free";
      accountInsert.run(input.id, `${input.id}@example.test`, role, accountSubscriptionStatus);
      privacyInsert.run(input.id, input.optedIn === false ? 0 : 1, "2026-08-01T00:00:00.000Z");
      eventInsert.run(
        `${input.id}-assigned`,
        input.id,
        "account_dashboard_viewed",
        metadata(
          input.variant,
          role,
          input.eligibleAtAssignment ?? false,
          accountSubscriptionStatus,
        ),
        assignedAt,
      );
    };

    addAccount({ id: "itt-control-d0", variant: "control", eligibleAtAssignment: true });
    addAccount({ id: "itt-control-d1", variant: "control", eligibleAtAssignment: true });
    addAccount({ id: "itt-control-d7", variant: "control" });
    addAccount({ id: "itt-control-d8", variant: "control" });
    addAccount({ id: "itt-treatment-view-only", variant: "treatment", eligibleAtAssignment: true });
    addAccount({ id: "itt-treatment-return", variant: "treatment", eligibleAtAssignment: true });
    addAccount({
      id: "itt-treatment-maturing",
      variant: "treatment",
      anchor: "2026-08-25T12:00:00.000Z",
    });
    addAccount({ id: "itt-opted-out", variant: "control", optedIn: false });
    addAccount({ id: "itt-admin", variant: "treatment", role: "admin" });
    addAccount({
      id: "itt-legacy-premium",
      variant: "control",
      accountSubscriptionStatus: "premium_monthly",
    });

    eventInsert.run(
      "itt-control-d0-return",
      "itt-control-d0",
      "search_performed",
      "{}",
      "2026-08-20T23:59:59.999Z",
    );
    eventInsert.run(
      "itt-control-d0-crossover",
      "itt-control-d0",
      "account_dashboard_viewed",
      metadata("treatment"),
      "2026-08-20T23:59:59.999Z",
    );
    eventInsert.run(
      "itt-control-d0-invalid-exposure",
      "itt-control-d0",
      "saved_updates_viewed",
      metadata("control", "user", true),
      "2026-08-21T00:00:00.000Z",
    );
    eventInsert.run(
      "itt-control-d1-return",
      "itt-control-d1",
      "search_performed",
      "{}",
      "2026-08-21T00:00:00.000Z",
    );
    eventInsert.run(
      "itt-control-d7-return",
      "itt-control-d7",
      "price_confirmation_answered",
      "{}",
      "2026-08-27T23:59:59.999Z",
    );
    eventInsert.run(
      "itt-control-d8-return",
      "itt-control-d8",
      "search_performed",
      "{}",
      "2026-08-28T00:00:00.000Z",
    );
    for (const [id, eventType, createdAt] of [
      ["itt-treatment-view", "saved_updates_viewed", "2026-08-20T12:01:00.000Z"],
      ["itt-treatment-open", "saved_update_opened", "2026-08-21T12:00:00.000Z"],
    ] as const) {
      eventInsert.run(id, "itt-treatment-view-only", eventType, metadata("treatment", "user", true), createdAt);
    }
    eventInsert.run(
      "itt-treatment-return-view",
      "itt-treatment-return",
      "saved_updates_viewed",
      metadata("treatment", "user", true),
      "2026-08-22T12:00:00.000Z",
    );
    eventInsert.run(
      "itt-treatment-neutral-return",
      "itt-treatment-return",
      "venue_detail_opened",
      "{}",
      "2026-08-27T23:59:59.999Z",
    );
    eventInsert.run(
      "itt-treatment-maturing-return",
      "itt-treatment-maturing",
      "search_performed",
      "{}",
      "2026-08-26T12:00:00.000Z",
    );
    eventInsert.run(
      "itt-treatment-maturing-pre-anchor-exposure",
      "itt-treatment-maturing",
      "saved_updates_viewed",
      metadata("treatment"),
      "2026-08-25T11:59:59.999Z",
    );

    accountInsert.run("itt-invalid-first", "itt-invalid-first@example.test", "user", "free");
    privacyInsert.run("itt-invalid-first", 1, "2026-08-01T00:00:00.000Z");
    eventInsert.run(
      "itt-invalid-first-assignment",
      "itt-invalid-first",
      "account_dashboard_viewed",
      JSON.stringify({
        accountRole: "user",
        accountSubscriptionStatus: "free",
        savedUpdatesEligibleAtAssignment: false,
        savedUpdatesExperimentVersion: "v1",
        savedUpdatesVariant: 7,
      }),
      anchor,
    );
    eventInsert.run(
      "itt-invalid-later-valid",
      "itt-invalid-first",
      "account_dashboard_viewed",
      metadata("treatment"),
      "2026-08-21T12:00:00.000Z",
    );

    const completedBefore = database.metrics().completedQueries;
    const result = await repository.getSavedUpdatesExperimentRollup({
      experimentVersion: "v1",
      asOf,
    });
    expect(database.metrics().completedQueries - completedBefore).toBe(1);
    expect(result).toEqual({
      experimentVersion: "v1",
      observedD7RetentionDifference: 0,
      variants: [
        {
          variant: "control",
          assignedAccounts: 4,
          assignedShare: 4 / 7,
          eligibleAtAssignmentAccounts: 2,
          eligibilityRateAtAssignment: 0.5,
          exposedAccounts: 0,
          exposureRate: null,
          maturedAccounts7: 4,
          maturityRate7: 1,
          returnedAccounts7: 2,
          retentionRate7: 0.5,
        },
        {
          variant: "treatment",
          assignedAccounts: 3,
          assignedShare: 3 / 7,
          eligibleAtAssignmentAccounts: 2,
          eligibilityRateAtAssignment: 2 / 3,
          exposedAccounts: 2,
          exposureRate: 2 / 3,
          maturedAccounts7: 2,
          maturityRate7: 2 / 3,
          returnedAccounts7: 1,
          retentionRate7: 0.5,
        },
      ],
    });
  });

  it("counts the exact known-venue union and reports null, stale, disputed, and verified coverage", async () => {
    const { repository } = await fixture();

    await expect(repository.countKnownVenues()).resolves.toBe(12);
    const coverage = await repository.getCoverageDashboard({
      staleBefore: ANALYTICS_STALE_BEFORE,
      asOf: ANALYTICS_AS_OF,
      totalVenues: ANALYTICS_TOTAL_VENUES,
    });
    const { averagePriceRecordAgeDays, ...stableCoverage } = coverage;
    expect(stableCoverage).toEqual(EXPECTED_COVERAGE_WITHOUT_AGE);
    expect(averagePriceRecordAgeDays).toBe(32);
  });

  it("preserves lead join multiplicity and alias merging with deterministic bounded results", async () => {
    const { repository } = await fixture();

    await expect(repository.getPotentialPartnerLeads({ staleBefore: ANALYTICS_STALE_BEFORE, limit: 10 }))
      .resolves.toEqual(EXPECTED_PARTNER_LEADS);
    await expect(repository.getPotentialPartnerLeads({ staleBefore: ANALYTICS_STALE_BEFORE, limit: 2 }))
      .resolves.toEqual(EXPECTED_PARTNER_LEADS.slice(0, 2));
    await expect(repository.getPotentialPartnerLeads({ staleBefore: ANALYTICS_STALE_BEFORE, limit: 101 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
  });

  it("rejects malformed inputs and stored native values with stable private failures", async () => {
    const { raw, repository } = await fixture();

    await expect(repository.getAdminKpiDashboard({ ...KPI_INPUT, since: "2026-07-01" }))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.getAdminKpiDashboard({ ...KPI_INPUT, asOf: "2099-01-01" }))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.getAdminKpiDashboard({ ...KPI_INPUT, totalVenues: -1 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.getCoverageDashboard({
      staleBefore: "not-a-timestamp",
      asOf: ANALYTICS_AS_OF,
      totalVenues: ANALYTICS_TOTAL_VENUES,
    })).rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.getCoverageDashboard({
      staleBefore: ANALYTICS_STALE_BEFORE,
      asOf: "2026-08-01",
      totalVenues: ANALYTICS_TOTAL_VENUES,
    })).rejects.toSatisfy(expectCode("invalid_input"));

    raw.prepare("UPDATE venue_price_records SET last_verified_at = 'not-a-timestamp' WHERE id = 'price-stale'").run();
    await expect(repository.getPotentialPartnerLeads({ staleBefore: ANALYTICS_STALE_BEFORE, limit: 10 }))
      .rejects.toSatisfy(expectCode("malformed_record"));

    const jsonFixture = await fixture();
    jsonFixture.raw.prepare(
      `UPDATE events SET metadata_json = '{"venueName": 12}' WHERE id = 'event-alpha-card'`,
    ).run();
    await expect(jsonFixture.repository.getAnalyticsPreview())
      .rejects.toSatisfy(expectCode("malformed_record"));
    await expect(jsonFixture.repository.getAdminKpiDashboard(KPI_INPUT))
      .rejects.toSatisfy(expectCode("malformed_record"));

    const booleanFixture = await fixture();
    booleanFixture.raw.prepare(
      "UPDATE venue_price_records SET is_happy_hour_price = 2 WHERE id = 'price-alpha-1'",
    ).run();
    await expect(booleanFixture.repository.getCoverageDashboard({
      staleBefore: ANALYTICS_STALE_BEFORE,
      asOf: ANALYTICS_AS_OF,
      totalVenues: ANALYTICS_TOTAL_VENUES,
    })).rejects.toSatisfy(expectCode("malformed_record"));

    raw.prepare("UPDATE events SET metadata_json = 'not-json' WHERE id = 'event-alpha-card'").run();
    await expect(repository.getAdminKpiDashboard(KPI_INPUT))
      .rejects.toSatisfy(expectCode("persistence_failure"));
    await expect(repository.getAdminKpiDashboard(KPI_INPUT)).rejects.toThrow("Admin analytics could not be loaded.");
  });

  it("remains read-only through outer rollback and maps a closed database to one stable failure", async () => {
    const { raw, database, repository } = await fixture();
    const eventCountBefore = raw.prepare("SELECT count(*) AS count FROM events").get();

    await expect(database.transaction(async () => {
      await repository.getAdminKpiDashboard(KPI_INPUT);
      throw new Error("force outer rollback");
    })()).rejects.toThrow("force outer rollback");
    expect(raw.prepare("SELECT count(*) AS count FROM events").get()).toEqual(eventCountBefore);
    expect(database.metrics().transactionFailures).toBe(1);

    await database.close();
    await expect(repository.countKnownVenues()).rejects.toSatisfy(expectCode("persistence_failure"));
  });
});
