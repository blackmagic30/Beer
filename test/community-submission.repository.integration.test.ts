import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Client, Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CommunitySubmissionRepository,
  CommunitySubmissionRepositoryError,
  communityPendingVenueFingerprint,
} from "../src/db/community-submission.repository.js";
import { SourceEvidenceObjectRepository } from "../src/db/source-evidence-object.repository.js";
import {
  missionLifecycleAccountLockKey,
  missionLifecycleMissionLockKey,
} from "../src/db/mission-lifecycle.repository.js";
import {
  sqlDatabaseInternals,
  type SqlBindings,
  type SqlDatabase,
  type SqlPoolMetrics,
  type SqlStatement,
} from "../src/db/sql-database.js";

const ADMIN_URL_ENV = "PINTPATH_POSTGRES_MIGRATION_TEST_ADMIN_URL";
const configuredAdminUrl = process.env[ADMIN_URL_ENV]?.trim() ?? "";
const TEST_DATABASE = "pintpath_community_submission_integration_test";
const TEST_LOGIN = "pintpath_community_submission_integration_login";
const NOW = "2026-08-08T06:00:00.000Z";
const OBSERVED_AT = "2026-08-08T05:30:00.000Z";
const CATALOG_REVIEWED_AT = "2026-08-08T06:05:00.000Z";
const APPROVED_AT = "2026-08-08T06:10:00.000Z";

function validateAdminUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new Error(`${ADMIN_URL_ENV} must be an explicit loopback PostgreSQL admin URL.`);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname.toLowerCase())
    || decodeURIComponent(url.pathname.slice(1)) !== "postgres"
    || !url.username || !url.password
    || url.searchParams.get("sslmode") !== "disable"
    || [...url.searchParams.keys()].some((key) => key !== "sslmode")
    || url.hash || /[\r\n\0]/.test(value)
  ) throw new Error(`${ADMIN_URL_ENV} must target the loopback postgres database with explicit test credentials.`);
  return url;
}

function withDatabase(url: URL, database: string, username?: string, password?: string): string {
  const result = new URL(url.toString());
  result.pathname = `/${database}`;
  if (username !== undefined) result.username = username;
  if (password !== undefined) result.password = password;
  return result.toString();
}

function normalizeBindings(bindings: unknown[]): SqlBindings {
  if (
    bindings.length === 1 && bindings[0] !== null && typeof bindings[0] === "object"
    && !Array.isArray(bindings[0]) && !Buffer.isBuffer(bindings[0]) && !(bindings[0] instanceof Date)
  ) return bindings[0] as Readonly<Record<string, unknown>>;
  return bindings;
}

function normalizeRow<Row extends QueryResultRow>(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key, value instanceof Date ? value.toISOString() : value,
  ])) as Row;
}

/** Restricted loopback-only adapter for the disposable PG17 rehearsal. */
class LoopbackPostgresTestDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  private readonly pool: Pool;
  private readonly transactionClient = new AsyncLocalStorage<{ client: PoolClient; nextSavepoint: number }>();
  private closed = false;
  private completedQueries = 0;
  private failedQueries = 0;
  private transactionFailures = 0;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 12,
      options: "-c search_path=pintpath_app,pg_catalog -c statement_timeout=30000 -c lock_timeout=10000",
    });
  }

  private async query<Row extends QueryResultRow>(sql: string, bindings: SqlBindings) {
    if (this.closed) throw new Error("Database is closed.");
    const compiled = sqlDatabaseInternals.compilePostgresQuery(sql, bindings);
    const executor = this.transactionClient.getStore()?.client ?? this.pool;
    try {
      const result = await executor.query<Row>(compiled.text, compiled.values);
      this.completedQueries += 1;
      return { rows: result.rows.map(normalizeRow), rowCount: result.rowCount ?? 0 };
    } catch (error) {
      this.failedQueries += 1;
      throw error;
    }
  }

  prepare(sql: string): SqlStatement {
    return {
      run: async (...bindings) => {
        const result = await this.query(sql, normalizeBindings(bindings));
        return { changes: result.rowCount };
      },
      get: async <Row extends QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, normalizeBindings(bindings));
        return result.rows[0];
      },
      all: async <Row extends QueryResultRow>(...bindings: unknown[]) => {
        const result = await this.query<Row>(sql, normalizeBindings(bindings));
        return result.rows;
      },
    };
  }

  async exec(sql: string): Promise<void> { await this.query(sql, []); }

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => {
      const active = this.transactionClient.getStore();
      if (active) {
        const savepoint = `community_submission_nested_${active.nextSavepoint++}`;
        await active.client.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await work();
          await active.client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          this.transactionFailures += 1;
          await active.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
          await active.client.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => undefined);
          throw error;
        }
      }
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await this.transactionClient.run({ client, nextSavepoint: 1 }, work);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        this.transactionFailures += 1;
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  metrics(): SqlPoolMetrics {
    return {
      dialect: "postgres",
      totalConnections: this.pool.totalCount,
      idleConnections: this.pool.idleCount,
      waitingRequests: this.pool.waitingCount,
      completedQueries: this.completedQueries,
      failedQueries: this.failedQueries,
      transactionFailures: this.transactionFailures,
      lastQueryDurationMs: null,
    };
  }
}

describe.skipIf(!configuredAdminUrl)("real PG17 community submission repository", () => {
  let adminUrl: URL;
  let admin: Client;
  let targetAdmin: Client | null = null;
  let database: LoopbackPostgresTestDatabase | null = null;
  let repository: CommunitySubmissionRepository;
  let sourceEvidenceRepository: SourceEvidenceObjectRepository;
  let runtimeRoleExisted = false;
  let migratorRoleExisted = false;

  beforeAll(async () => {
    adminUrl = validateAdminUrl(configuredAdminUrl);
    admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    const roles = await admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      [["pintpath_runtime", "pintpath_migrator"]],
    );
    runtimeRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_runtime");
    migratorRoleExisted = roles.rows.some((row) => row.rolname === "pintpath_migrator");
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
    targetAdmin = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await targetAdmin.connect();
    await targetAdmin.query(fs.readFileSync(path.resolve("src/db/postgres-schema.sql"), "utf8"));
    const password = crypto.randomBytes(24).toString("hex");
    await admin.query(
      `CREATE ROLE ${TEST_LOGIN} LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await admin.query(`GRANT pintpath_runtime TO ${TEST_LOGIN}`);
    database = new LoopbackPostgresTestDatabase(withDatabase(adminUrl, TEST_DATABASE, TEST_LOGIN, password));
    repository = new CommunitySubmissionRepository(database);
    sourceEvidenceRepository = new SourceEvidenceObjectRepository(database);
  }, 30_000);

  afterAll(async () => {
    await database?.close().catch(() => undefined);
    await targetAdmin?.end().catch(() => undefined);
    if (!admin) return;
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [TEST_DATABASE],
    ).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`).catch(() => undefined);
    await admin.query(`REVOKE pintpath_runtime FROM ${TEST_LOGIN}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${TEST_LOGIN}`).catch(() => undefined);
    const residue = await admin.query<{ databases: string; roles: string }>(
      `SELECT
         (SELECT count(*)::text FROM pg_catalog.pg_database WHERE datname = $1) AS databases,
         (SELECT count(*)::text FROM pg_catalog.pg_roles WHERE rolname = $2) AS roles`,
      [TEST_DATABASE, TEST_LOGIN],
    ).catch(() => ({ rows: [{ databases: "1", roles: "1" }] }));
    if (residue.rows[0]?.databases !== "0" || residue.rows[0]?.roles !== "0") {
      throw new Error("Community repository PG rehearsal left database or login residue.");
    }
    if (!runtimeRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_runtime").catch(() => undefined);
    if (!migratorRoleExisted) await admin.query("DROP ROLE IF EXISTS pintpath_migrator").catch(() => undefined);
    await admin.end().catch(() => undefined);
  }, 30_000);

  it("proves restricted-role native decoding, advisory idempotency, row fences, privacy, and atomic moderation", async () => {
    if (!database) throw new Error("PostgreSQL test database was not initialized.");
    for (const account of [
      { id: "pg-submitter", role: "user", subscription: "free", strikes: 2 },
      { id: "pg-verifier", role: "user", subscription: "free", strikes: 0 },
      { id: "pg-admin", role: "admin", subscription: "admin", strikes: 0 },
    ]) {
      await database.prepare(
        `INSERT INTO accounts (
           id, public_account_id, email, password_hash, role, subscription_status,
           fraud_strike_count, created_at, updated_at
         ) VALUES (@id, @publicId, @email, 'hash', @role, @subscription, @strikes, @now, @now)`,
      ).run({
        ...account,
        publicId: `public-${account.id}`,
        email: `${account.id}@example.test`,
        now: NOW,
      });
      await database.prepare(
        `INSERT INTO profiles (
           id, public_account_id, email, role, account_status, created_at, updated_at
         ) VALUES (@id, @publicId, @email, @role, 'active', @now, @now)`,
      ).run({
        ...account,
        publicId: `public-${account.id}`,
        email: `${account.id}@example.test`,
        now: NOW,
      });
    }
    await sourceEvidenceRepository.registerSourceEvidenceObject({
      id: "pg-unlinked-evidence",
      ownerUserId: "pg-submitter",
      storageProvider: "supabase_private",
      objectPath: "private/pg-submitter/pg-unlinked-evidence",
      mimeType: "image/jpeg",
      byteSize: 2_048,
      dataBase64: null,
      externalUrl: null,
      retentionExpiresAt: "2026-11-08T06:00:00.000Z",
      createdAt: NOW,
    });
    await database.prepare(
      `UPDATE source_evidence_objects
          SET data_base64 = ?, external_url = ?
        WHERE id = ?`,
    ).run("cHJpdmF0ZQ==", "https://private.example.test/pg-evidence.jpg", "pg-unlinked-evidence");
    await expect(repository.deleteUnlinkedSourceEvidence({
      id: "pg-unlinked-evidence",
      ownerUserId: "pg-submitter",
      deletedAt: "2026-08-08T06:01:00.000Z",
    })).resolves.toBe(true);
    await expect(database.prepare(
      `SELECT storage_provider AS "storageProvider", object_path AS "objectPath",
              data_base64 AS "dataBase64", external_url AS "externalUrl",
              byte_size AS "byteSize", deleted_at AS "deletedAt"
         FROM source_evidence_objects WHERE id = ?`,
    ).get("pg-unlinked-evidence")).resolves.toEqual({
      storageProvider: "supabase_private",
      objectPath: "private/pg-submitter/pg-unlinked-evidence",
      dataBase64: null,
      externalUrl: null,
      byteSize: null,
      deletedAt: "2026-08-08T06:01:00.000Z",
    });
    await sourceEvidenceRepository.registerSourceEvidenceObject({
      id: "pg-evidence",
      ownerUserId: "pg-submitter",
      storageProvider: "supabase_private",
      objectPath: "private/pg-submitter/pg-evidence",
      mimeType: "image/jpeg",
      byteSize: 4_096,
      dataBase64: null,
      externalUrl: null,
      retentionExpiresAt: "2026-11-08T06:00:00.000Z",
      createdAt: NOW,
    });
    const createInput = {
      clientSubmissionId: "pg-client-idempotency",
      userId: "pg-submitter",
      venueId: "pg-venue",
      venueName: "PG Venue",
      suburb: "Carlton",
      submissionType: "photo_upload" as const,
      observedAt: OBSERVED_AT,
      evidenceIds: ["pg-evidence"],
      ocrStatus: "processed" as const,
      ocrSummary: {
        model: "pg-ocr", imageCount: 1, extractedRowCount: 1,
        rejectedCandidateCount: 0, pendingCatalogCount: 1, message: null,
      },
      notes: "private reviewer note",
      items: [{
        catalog: {
          kind: "pending_create" as const,
          key: "pg_pending_beer",
          canonicalName: "PG Pending Beer",
          aliasKey: "pg_pending_alias",
          alias: "PG Pending Alias",
          source: "community_pg_test",
          brewery: "PG Brewery",
          abv: 5.25,
        },
        servingSize: "pint" as const,
        price: 13.75,
        isOnTap: "yes" as const,
        confidence: 0.875,
        captureSource: "photo_ocr" as const,
        sourceText: "PG PENDING BEER 13.75",
      }],
      now: NOW,
    };
    const creates = await Promise.all([
      repository.createSubmission({ ...createInput, id: "pg-submission-a", items: [{ ...createInput.items[0]!, id: "pg-item-a" }] }),
      repository.createSubmission({ ...createInput, id: "pg-submission-b", items: [{ ...createInput.items[0]!, id: "pg-item-b" }] }),
    ]);
    expect(creates.filter((result) => result.replayed)).toHaveLength(1);
    expect(new Set(creates.map((result) => result.record.submission.id)).size).toBe(1);
    const submissionId = creates[0]!.record.submission.id;
    expect(creates[0]!.record).toMatchObject({
      submission: {
        sourcePhotoUrl: "private:evidence:pg-evidence",
        pointsEligibleByLocation: false,
        ocrSummary: { model: "pg-ocr", pendingCatalogCount: 1 },
      },
      evidence: [{ sortOrder: 0, object: { id: "pg-evidence", byteSize: 4096 } }],
    });

    const candidates = await repository.listCommunityVerificationCandidates({
      verifierUserId: "pg-verifier", limit: 10, offset: 0,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).not.toHaveProperty("sourcePhotoUrl");
    expect(candidates[0]).not.toHaveProperty("notes");

    const verifications = await Promise.allSettled([
      repository.createVerification({
        id: "pg-verification-a", verifierUserId: "pg-verifier", submissionId,
        result: "confirmed", notes: null, now: NOW,
      }),
      repository.createVerification({
        id: "pg-verification-b", verifierUserId: "pg-verifier", submissionId,
        result: "confirmed", notes: null, now: NOW,
      }),
    ]);
    expect(verifications.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = verifications.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toEqual(
      expect.objectContaining({ code: "verification_conflict" }),
    );

    await expect(repository.reviewSubmission({
      submissionId, reviewerId: "pg-admin", status: "approved", rejectionReason: null,
      monthKey: "2026-08", now: NOW,
    })).rejects.toEqual(expect.objectContaining({ code: "publication_required" }));
    const reviewed = await repository.reviewSubmission({
      submissionId, reviewerId: "pg-admin", status: "fraud_flagged",
      rejectionReason: "fabricated evidence", monthKey: "2026-08", now: NOW,
    });
    expect(reviewed).toMatchObject({
      submission: { status: "fraud_flagged", fraudFlagged: true, pointsAwarded: 0 },
      submitter: { fraudStrikeCount: 3, trustScore: 30, status: "suspended" },
    });

    const native = await database.prepare(
      `SELECT submission.ocr_summary_json AS "summary",
              submission.fraud_flagged AS "fraudFlagged",
              item.price AS "price", item.is_happy_hour_price AS "happyHour",
              link.sort_order AS "sortOrder"
         FROM submissions submission
         INNER JOIN submission_items item ON item.submission_id = submission.id
         INNER JOIN submission_source_evidence link ON link.submission_id = submission.id
        WHERE submission.id = ?`,
    ).get<{
      summary: Record<string, unknown>;
      fraudFlagged: boolean;
      price: string;
      happyHour: boolean;
      sortOrder: string;
    }>(submissionId);
    expect(native).toEqual(expect.objectContaining({
      summary: expect.objectContaining({ model: "pg-ocr" }),
      fraudFlagged: true,
      price: "13.75",
      happyHour: false,
      sortOrder: "0",
    }));
    expect(await database.prepare("SELECT count(*) AS \"count\" FROM venue_price_records").get<{ count: string }>())
      .toEqual({ count: "0" });
    expect(await database.prepare("SELECT count(*) AS \"count\" FROM venue_profiles").get<{ count: string }>())
      .toEqual({ count: "0" });
    expect(database.metrics()).toMatchObject({ dialect: "postgres" });
    expect(CommunitySubmissionRepositoryError).toBeDefined();
  });

  it("atomically publishes and retries the full approval cluster with native PG17 types", async () => {
    if (!database) throw new Error("PostgreSQL test database was not initialized.");
    for (const account of [
      { id: "pg-approval-submitter", role: "user", subscription: "free" },
      { id: "pg-approval-admin", role: "admin", subscription: "admin" },
    ]) {
      await database.prepare(
        `INSERT INTO accounts (
           id, public_account_id, email, password_hash, role, subscription_status,
           created_at, updated_at
         ) VALUES (@id, @publicId, @email, 'hash', @role, @subscription, @now, @now)`,
      ).run({
        ...account,
        publicId: `public-${account.id}`,
        email: `${account.id}@example.test`,
        now: NOW,
      });
      await database.prepare(
        `INSERT INTO profiles (
           id, public_account_id, email, role, account_status, created_at, updated_at
         ) VALUES (@id, @publicId, @email, @role, 'active', @now, @now)`,
      ).run({
        ...account,
        publicId: `public-${account.id}`,
        email: `${account.id}@example.test`,
        now: NOW,
      });
    }
    await sourceEvidenceRepository.registerSourceEvidenceObject({
      id: "pg-approval-evidence",
      ownerUserId: "pg-approval-submitter",
      storageProvider: "supabase_private",
      objectPath: "private/pg-approval-submitter/evidence",
      mimeType: "image/jpeg",
      byteSize: 8_192,
      dataBase64: null,
      externalUrl: null,
      retentionExpiresAt: "2026-11-08T06:00:00.000Z",
      createdAt: NOW,
    });
    await database.prepare(
      `INSERT INTO missions (
         id, venue_id, venue_name, reason, priority, points, multiplier,
         active, sponsor_flag, created_at, updated_at
       ) VALUES (
         'pg-approval-mission', 'pg-approval-venue', 'PG Approval Venue',
         'missing data', 'high', 10, 1, TRUE, FALSE, @now, @now
       )`,
    ).run({ now: NOW });
    await database.prepare(
      `INSERT INTO mission_progress (
         id, mission_id, user_id, status, accepted_at, updated_at
       ) VALUES (
         'pg-approval-progress', 'pg-approval-mission', 'pg-approval-submitter',
         'accepted', '2026-08-08T05:00:00.000Z', @now
       )`,
    ).run({ now: NOW });
    await database.prepare(
      `INSERT INTO venue_requests (
         id, user_id, request_type, venue_name, google_place_id, suburb, status,
         mission_id, created_at, updated_at
       ) VALUES (
         'pg-approval-request', 'pg-approval-submitter', 'missing_venue',
         'PG Approval Venue', 'pg-approval-place', 'Carlton', 'mission_created',
         'pg-approval-mission', @now, @now
       )`,
    ).run({ now: NOW });
    const pendingVenue = {
      googlePlaceId: "pg-approval-place",
      name: "PG Approval Venue",
      address: "20 PostgreSQL Street",
      suburb: "Carlton",
      state: "VIC",
      postcode: "3053",
      phone: null,
      website: "https://pg-approval.example.test",
      latitude: -37.81,
      longitude: 144.97,
    };
    const createBlocker = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await createBlocker.connect();
    await createBlocker.query("BEGIN");
    await createBlocker.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))",
      [missionLifecycleMissionLockKey("pg-approval-mission")],
    );
    let createSettled = false;
    const create = repository.createSubmission({
      id: "pg-approval-submission",
      clientSubmissionId: "pg-approval-client",
      missionId: "pg-approval-mission",
      missionAcceptedAfter: "2026-08-08T04:00:00.000Z",
      userId: "pg-approval-submitter",
      venueId: "pg-approval-venue",
      venueName: "PG Approval Venue",
      suburb: "Carlton",
      submissionType: "photo_upload",
      observedAt: OBSERVED_AT,
      evidenceIds: ["pg-approval-evidence"],
      ocrStatus: "processed",
      ocrSummary: {
        model: "pg-approval-ocr",
        imageCount: 1,
        extractedRowCount: 1,
        rejectedCandidateCount: 0,
        pendingCatalogCount: 1,
        message: null,
      },
      notes: "PG private review note",
      pointsEligibleByLocation: true,
      pointsEligibilityReason: "within_radius",
      pendingVenue,
      items: [{
        id: "pg-approval-item",
        catalog: {
          kind: "pending_create",
          key: "pg_approval_beer",
          canonicalName: "PG Approval Beer",
          aliasKey: "pg_approval_alias",
          alias: "PG Approval Alias",
          source: "community_pg_test",
          brewery: "PG Brewery",
          abv: 5.5,
        },
        servingSize: "pint",
        price: 14.25,
        isOnTap: "yes",
        confidence: 0.93,
        captureSource: "photo_ocr",
        sourceText: "PG APPROVAL BEER 14.25",
      }],
      now: NOW,
    }).finally(() => {
      createSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(createSettled).toBe(false);
    await createBlocker.query("COMMIT");
    await create;
    await createBlocker.end();
    await database.prepare(
      `UPDATE beer_catalog_items
          SET status = 'active', updated_at = @reviewedAt
        WHERE key = 'pg_approval_beer'`,
    ).run({ reviewedAt: CATALOG_REVIEWED_AT });
    await database.prepare(
      `INSERT INTO contribution_ledger (
         id, user_id, submission_id, venue_id, points, reason, month_key, created_at
       ) VALUES (
         'pg-approval-prior-ledger', 'pg-approval-submitter', NULL,
         'pg-prior-venue', 95, 'single_beer_price', '2026-08', @now
       )`,
    ).run({ now: NOW });
    const approvalSnapshot = await repository.getApprovalSnapshot("pg-approval-submission");

    const approvalInput = {
      approvalId: "pg-approval-decision",
      submissionId: "pg-approval-submission",
      reviewerId: "pg-approval-admin",
      catalogDecisions: [{
        itemId: "pg-approval-item",
        expectedCatalogKey: "pg_approval_beer",
        expectedCatalogUpdatedAt: CATALOG_REVIEWED_AT,
        activeCatalogKey: "pg_approval_beer",
        activeCatalogName: "PG Approval Beer",
        activeCatalogUpdatedAt: CATALOG_REVIEWED_AT,
      }],
      missionDecision: {
        missionId: "pg-approval-mission",
        missionUpdatedAt: NOW,
        progressId: "pg-approval-progress",
        progressUpdatedAt: NOW,
      },
      venueDecision: {
        pendingVenueHash: communityPendingVenueFingerprint(pendingVenue),
        expectedVenueProfileUpdatedAt: null,
        expectedLocationUpdatedAt: null,
        requests: [{
          requestId: "pg-approval-request",
          status: "mission_created" as const,
          updatedAt: NOW,
          missionId: "pg-approval-mission",
          missionUpdatedAt: NOW,
        }],
      },
      evidenceDecisions: approvalSnapshot.evidenceDecisions,
      pointsAwarded: 10,
      confidence: "admin_verified" as const,
      monthKey: "2026-08",
      premiumUntil: "2026-09-01T00:00:00.000Z",
      contributorUnlockPoints: 100,
      now: APPROVED_AT,
    };
    const approvalBlocker = new Client({ connectionString: withDatabase(adminUrl, TEST_DATABASE) });
    await approvalBlocker.connect();
    await approvalBlocker.query("BEGIN");
    await approvalBlocker.query(
      "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))",
      [missionLifecycleAccountLockKey("pg-approval-submitter")],
    );
    let approvalSettled = false;
    const approvalsPromise = Promise.all([
      repository.approveAndPublishSubmission(approvalInput),
      repository.approveAndPublishSubmission(approvalInput),
    ]).finally(() => {
      approvalSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(approvalSettled).toBe(false);
    await approvalBlocker.query("COMMIT");
    const approvals = await approvalsPromise;
    await approvalBlocker.end();
    expect(approvals.map((result) => result.outcome).sort()).toEqual(["already_applied", "applied"]);
    expect(approvals[0]).toMatchObject({
      submission: { status: "approved", pointsAwarded: 10 },
      submitter: {
        trustScore: 53,
        contributionPointsCurrentMonth: 105,
        approvedSubmissionCount: 1,
        subscriptionStatus: "contributor_unlocked",
      },
    });
    await expect(repository.getContributionPointsForMonth("pg-approval-submitter", "2026-08"))
      .resolves.toBe(105);

    const native = await database.prepare(
      `SELECT price.price AS "price", price.is_happy_hour_price AS "happyHour",
              price.source_evidence_verified_at AS "evidenceVerifiedAt",
              venue.opening_hours_json AS "openingHours", venue.venue_tags_json AS "venueTags",
              venue.active AS "venueActive", mission.active AS "missionActive",
              audit.metadata_json AS "auditMetadata"
         FROM venue_price_records price
         INNER JOIN venue_profiles venue ON venue.venue_id = price.venue_id
         INNER JOIN missions mission ON mission.id = 'pg-approval-mission'
         INNER JOIN security_audit_log audit
                 ON audit.target_id = price.source_submission_id
                AND audit.action = 'community_submission_approved'
        WHERE price.id = 'pg-approval-submission:pg-approval-item'`,
    ).get<{
      price: string;
      happyHour: boolean;
      evidenceVerifiedAt: string;
      openingHours: Record<string, unknown>;
      venueTags: string[];
      venueActive: boolean;
      missionActive: boolean;
      auditMetadata: Record<string, unknown>;
    }>();
    expect(native).toEqual(expect.objectContaining({
      price: "14.25",
      happyHour: false,
      evidenceVerifiedAt: APPROVED_AT,
      openingHours: {},
      venueTags: ["user submitted"],
      venueActive: true,
      missionActive: false,
      auditMetadata: expect.objectContaining({ approvalId: "pg-approval-decision" }),
    }));
    expect(await database.prepare(
      `SELECT status AS "status", source_submission_id AS "sourceSubmissionId"
         FROM venue_requests WHERE id = 'pg-approval-request'`,
    ).get()).toEqual({ status: "resolved", sourceSubmissionId: "pg-approval-submission" });
    expect(await database.prepare(
      "SELECT count(*)::text AS \"count\" FROM venue_happy_hours WHERE venue_id = 'pg-approval-venue'",
    ).get()).toEqual({ count: "0" });
    expect(await database.prepare(
      "SELECT count(*)::text AS \"count\" FROM venue_specials WHERE venue_id = 'pg-approval-venue'",
    ).get()).toEqual({ count: "0" });

    await repository.createSubmission({
      id: "pg-approval-rollback-submission",
      clientSubmissionId: "pg-approval-rollback-client",
      userId: "pg-approval-submitter",
      venueId: "pg-rollback-venue",
      venueName: "PG Rollback Venue",
      suburb: "Carlton",
      submissionType: "single_beer_price",
      observedAt: OBSERVED_AT,
      notes: null,
      pointsEligibleByLocation: true,
      items: [{
        id: "pg-approval-rollback-item",
        catalog: { kind: "active_existing", key: "pg_approval_beer" },
        servingSize: "pint",
        price: 15,
        isOnTap: "yes",
        confidence: 0.9,
      }],
      now: NOW,
    });
    const failureRepository = new CommunitySubmissionRepository(database, {
      allowApprovalFailureInjection: true,
    });
    await expect(failureRepository.approveAndPublishSubmission({
      approvalId: "pg-rollback-decision",
      submissionId: "pg-approval-rollback-submission",
      reviewerId: "pg-approval-admin",
      catalogDecisions: [{
        itemId: "pg-approval-rollback-item",
        expectedCatalogKey: "pg_approval_beer",
        expectedCatalogUpdatedAt: CATALOG_REVIEWED_AT,
        activeCatalogKey: "pg_approval_beer",
        activeCatalogName: "PG Approval Beer",
        activeCatalogUpdatedAt: CATALOG_REVIEWED_AT,
      }],
      missionDecision: null,
      venueDecision: null,
      evidenceDecisions: [],
      pointsAwarded: 5,
      confidence: "admin_verified",
      monthKey: "2026-08",
      premiumUntil: "2026-09-01T00:00:00.000Z",
      contributorUnlockPoints: 100,
      now: "2026-08-08T06:20:00.000Z",
      failureInjection: "before_finalize",
    })).rejects.toEqual(expect.objectContaining({ code: "persistence_failure" }));
    expect(await database.prepare(
      `SELECT status AS "status", reviewed_by AS "reviewedBy"
         FROM submissions WHERE id = 'pg-approval-rollback-submission'`,
    ).get()).toEqual({ status: "pending", reviewedBy: null });
    expect(await database.prepare(
      `SELECT count(*)::text AS "count" FROM venue_price_records
        WHERE id = 'pg-approval-rollback-submission:pg-approval-rollback-item'`,
    ).get()).toEqual({ count: "0" });
    expect(await database.prepare(
      `SELECT count(*)::text AS "count" FROM security_audit_log
        WHERE target_id = 'pg-approval-rollback-submission'
          AND action = 'community_submission_approved'`,
    ).get()).toEqual({ count: "0" });
  });
});
