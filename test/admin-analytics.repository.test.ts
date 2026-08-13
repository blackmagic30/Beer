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

  it("uses SQLite-compatible week buckets without N+1 reads and enforces retention bounds", async () => {
    const { database, repository } = await fixture();
    const completedBefore = database.metrics().completedQueries;

    await expect(repository.getRetentionCohorts({ groupBy: "week", limit: 24 }))
      .resolves.toEqual(EXPECTED_WEEK_COHORTS);
    expect(database.metrics().completedQueries - completedBefore).toBe(1);
    await expect(repository.getRetentionCohorts({ groupBy: "month", limit: 24 }))
      .resolves.toEqual(EXPECTED_MONTH_COHORTS);
    await expect(repository.getRetentionCohorts({ groupBy: "week", limit: 2 }))
      .resolves.toEqual(EXPECTED_WEEK_COHORTS.slice(0, 2));
    await expect(repository.getRetentionCohorts({ groupBy: "week", limit: 0 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.getRetentionCohorts({ groupBy: "week", limit: 25 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
    await expect(repository.getRetentionCohorts({ groupBy: "quarter" as "week", limit: 4 }))
      .rejects.toSatisfy(expectCode("invalid_input"));
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
