import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import { BusinessService } from "../../src/modules/business/business.service.js";
import { createUnavailableLegacyBusinessRepository } from "../../src/db/runtime-persistence.js";
import { sqlDatabaseInternals, type SqlDatabase, type SqlStatement, type SqlBindings } from "../../src/db/sql-database.js";
import { PintPointRepository } from "../../src/db/pint-point.repository.js";
import { BeerCatalogRepository } from "../../src/db/beer-catalog.repository.js";
import { SavedUpdatesReadRepository } from "../../src/db/saved-updates-read.repository.js";
import { PublicVenueDirectoryRepository } from "../../src/db/public-venue-directory.repository.js";
import { PublicPriceRepository } from "../../src/db/public-price.repository.js";
import { SystemStateRepository } from "../../src/db/system-state.repository.js";
import { ActivityAuditRepository } from "../../src/db/activity-audit.repository.js";
import { SupportFeedbackRepository } from "../../src/db/support-feedback.repository.js";
import { AccountSessionRepository } from "../../src/db/account-session.repository.js";
import { AccountProfilePreferencesRepository } from "../../src/db/account-profile-preferences.repository.js";
import { VenueInventoryRepository } from "../../src/db/venue-inventory.repository.js";
import { VenueIdentityRepository } from "../../src/db/venue-identity.repository.js";
import { BillingCheckoutRepository } from "../../src/db/billing-checkout.repository.js";
import { VenueAccessRepository } from "../../src/db/venue-access.repository.js";
import { MissionLifecycleRepository } from "../../src/db/mission-lifecycle.repository.js";
import { MissionDiscoveryAutomationRepository } from "../../src/db/mission-discovery-automation.repository.js";
import { StripeSubscriptionRepository } from "../../src/db/stripe-subscription.repository.js";
import { VenueRequestRepository } from "../../src/db/venue-request.repository.js";
import { VenuePartnerRepository } from "../../src/db/venue-partner.repository.js";
import { AdminAnalyticsRepository } from "../../src/db/admin-analytics.repository.js";
import { VenueManagerInsightsRepository } from "../../src/db/venue-manager-insights.repository.js";
import { AdminAccountRepository } from "../../src/db/admin-account.repository.js";
import { AccountDeletionQueueRepository } from "../../src/db/account-deletion-queue.repository.js";
import { AccountPrivacyRepository } from "../../src/db/account-privacy.repository.js";
import { PrivacyRetentionRepository } from "../../src/db/privacy-retention.repository.js";
import { CommunitySubmissionRepository } from "../../src/db/community-submission.repository.js";
import { VenueManagerInternalSubmissionRepository } from "../../src/db/venue-manager-internal-submission.repository.js";
import { SourceEvidenceObjectRepository } from "../../src/db/source-evidence-object.repository.js";
import { SourceEvidenceRetentionRepository } from "../../src/db/source-evidence-retention.repository.js";
import { VenuePendingChangeRepository } from "../../src/db/venue-pending-change.repository.js";
import { VenueDataReadRepository } from "../../src/db/venue-data-read.repository.js";

/** Test-only: rejects hosted destinations and selects the normal runtime role. */
export class PilotLoopbackDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly active = new AsyncLocalStorage<{ client: PoolClient; next: number }>();
  private completedQueries = 0;
  constructor(connectionString: string, private readonly options: {
    maxConnections?: number;
    connectionTimeoutMs?: number;
    queryDelayMs?: number;
  } = {}) {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["127.0.0.1", "localhost"].includes(url.hostname)
      || !/^\/pintpath_pilot_[a-z0-9_]+$/.test(url.pathname)
      || url.searchParams.get("sslmode") !== "disable") {
      throw new Error("Pilot tests require an isolated loopback PostgreSQL database.");
    }
    this.pool = new Pool({ connectionString, max: options.maxConnections ?? 8,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10000,
      types: sqlDatabaseInternals.createPostgresTypeOverrides(),
      options: "-c role=pintpath_runtime -c search_path=pintpath_app,pg_catalog -c statement_timeout=30000 -c lock_timeout=10000" });
  }
  private bindings(values: unknown[]): SqlBindings {
    return values.length === 1 && typeof values[0] === "object" && values[0] !== null
      && !Array.isArray(values[0]) ? values[0] as Record<string, unknown> : values;
  }
  private async query(sql: string, values: unknown[]) {
    const compiled = sqlDatabaseInternals.compilePostgresQuery(sql, this.bindings(values));
    const active = this.active.getStore()?.client;
    const client = active ?? await this.pool.connect();
    try {
      if (this.options.queryDelayMs) await client.query("SELECT pg_sleep($1)", [this.options.queryDelayMs / 1000]);
      const result = await client.query(compiled.text, compiled.values);
      this.completedQueries += 1;
      return { rows: result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) =>
        [key, value instanceof Date ? value.toISOString() : value]))), count: result.rowCount ?? 0 };
    } finally {
      if (!active) client.release();
    }
  }
  prepare(sql: string): SqlStatement {
    return {
      run: async (...values) => ({ changes: (await this.query(sql, values)).count }),
      get: async <Row>(...values: unknown[]) => (await this.query(sql, values)).rows[0] as Row | undefined,
      all: async <Row>(...values: unknown[]) => (await this.query(sql, values)).rows as Row[],
    };
  }
  async exec(sql: string) { await this.query(sql, []); }
  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      const active = this.active.getStore();
      if (active) {
        const name = `pilot_${active.next++}`;
        await active.client.query(`SAVEPOINT ${name}`);
        try { const result = await work(); await active.client.query(`RELEASE SAVEPOINT ${name}`); return result; }
        catch (error) { await active.client.query(`ROLLBACK TO SAVEPOINT ${name}`); throw error; }
      }
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await this.active.run({ client, next: 1 }, work);
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    };
  }
  async close() { await this.pool.end(); }
  metrics() { return { dialect: this.dialect, totalConnections: this.pool.totalCount,
    idleConnections: this.pool.idleCount, waitingRequests: this.pool.waitingCount,
    completedQueries: this.completedQueries, failedQueries: 0, transactionFailures: 0, lastQueryDurationMs: null }; }
}

export function createPilotTestService(database: SqlDatabase, config: ConstructorParameters<typeof BusinessService>[1]) {
  return new BusinessService(createUnavailableLegacyBusinessRepository(), config,
    new PublicVenueDirectoryRepository(database),
    new PublicPriceRepository(database),
    new SystemStateRepository(database),
    new ActivityAuditRepository(database),
    new SupportFeedbackRepository(database),
    new AccountSessionRepository(database),
    new AccountProfilePreferencesRepository(database),
    new VenueInventoryRepository(database),
    new VenueIdentityRepository(database),
    new BillingCheckoutRepository(database),
    new VenueAccessRepository(database),
    new MissionLifecycleRepository(database),
    new MissionDiscoveryAutomationRepository(database),
    new StripeSubscriptionRepository(database),
    new VenueRequestRepository(database),
    new VenuePartnerRepository(database),
    new AdminAnalyticsRepository(database),
    new VenueManagerInsightsRepository(database),
    new AdminAccountRepository(database),
    new AccountDeletionQueueRepository(database),
    new AccountPrivacyRepository(database),
    new PrivacyRetentionRepository(database),
    new CommunitySubmissionRepository(database),
    new VenueManagerInternalSubmissionRepository(database),
    new SourceEvidenceObjectRepository(database),
    new SourceEvidenceRetentionRepository(database),
    new VenuePendingChangeRepository(database),
    new VenueDataReadRepository(database),
    async () => { throw new Error("Account deletion is outside this disposable pilot browser fixture."); },
    new BeerCatalogRepository(database), undefined, undefined, undefined, undefined,
    async () => ({ ok: true, foreignKeyViolations: 0 }),
    new SavedUpdatesReadRepository(database), new PintPointRepository(database),
  );
}
