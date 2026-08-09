import crypto from "node:crypto";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  POSTGRES_ACCOUNT_DELETION_RECOVERY_CONFIRMATION_ENV,
  POSTGRES_ACCOUNT_DELETION_RECOVERY_CONFIRMATION_VALUE,
  runPostgresAccountDeletionRecoveryCli,
  type PostgresAccountDeletionRecoveryCliDependencies,
} from "../scripts/prove-postgres-account-deletion-recovery.js";
import type {
  PostgresDatabaseOptions,
  SqlDatabase,
  SqlPoolMetrics,
  SqlStatement,
} from "../src/db/sql-database.js";
import type { AccountDeletionTombstone } from "../src/lib/data-backup.js";
import type { VerifiedAccountDeletionLedger } from "../src/lib/offsite-backup.js";
import {
  POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_KIND,
  POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_VERSION,
  PostgresAccountDeletionRecoveryFixtureError,
  createFailIfCalledAccountDeletionRecoveryProvider,
  postgresAccountDeletionRecoveryFixtureInternals,
  type PostgresAccountDeletionRecoveryFixtureReceipt,
  type PostgresAccountDeletionRecoveryFixtureSemanticState,
} from "../src/lib/postgres-account-deletion-recovery-fixture.js";
import { canonicalPostgresLogicalStateJson } from "../src/lib/postgres-logical-state.js";

const FIXTURE_ID = "018f0f5a-7b9c-7def-8abc-0123456789ab";
const USER_ID = `recovery-proof-${FIXTURE_ID}`;
const REQUEST_ID = `recovery-proof-delete-${FIXTURE_ID}`;
const PREPARED_AT = "2026-08-09T01:00:00.000Z";
const COMPLETED_AT = "2026-08-09T02:00:00.000Z";
const DATABASE_IDENTITY = "a".repeat(64);

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function preparedState(): PostgresAccountDeletionRecoveryFixtureSemanticState {
  return {
    phase: "prepared",
    account: {
      emailSha256: sha256(`${USER_ID}@pintpath.invalid`),
      publicAccountId: "PP-RECOVERY",
      authProvider: "local",
      supabaseUserId: null,
      stripeCustomerId: null,
      subscriptionStatus: "free",
      status: "active",
    },
    profile: {
      emailSha256: sha256(`${USER_ID}@pintpath.invalid`),
      publicAccountId: "PP-RECOVERY",
      accountStatus: "active",
    },
    request: {
      status: "processing",
      attemptCount: 1,
      requestedAt: "2026-08-09T00:58:00.000Z",
      executeAfter: "2026-08-09T00:59:00.000Z",
      processingStartedAt: PREPARED_AT,
      completedAt: null,
      identityDeletedAt: null,
      stripeCustomerDeletedAt: null,
      stripeCustomerIdSnapshot: null,
      deletionTombstoneRecordedAt: null,
      userMessagePresent: false,
      lastErrorPresent: false,
      resultSummarySha256: null,
    },
    outbox: {
      status: "held",
      attemptCount: 0,
      templateVersion: "account-deletion-complete-v1",
      idempotencyKeySha256: sha256(`recovery-proof-notice:${REQUEST_ID}`),
      payloadFingerprint: null,
      providerMessageId: null,
      providerLastEvent: null,
      providerEventAt: null,
      nextAttemptAt: null,
      leaseTokenPresent: false,
      leaseExpiresAt: null,
      acceptedAt: null,
      deliveredAt: null,
      terminalAt: null,
      secretPurgeCheckpointPending: false,
      secretPurgeGeneration: 0,
    },
    recipientSecret: {
      keyId: "recovery-proof-ephemeral-aes-gcm-v1",
      nonceSha256: "1".repeat(64),
      ciphertextSha256: "2".repeat(64),
      authTagSha256: "3".repeat(64),
      purgeAfter: "2026-10-08T01:00:00.000Z",
    },
    sessionTokenHashSha256: "4".repeat(64),
    counts: {
      account: "1",
      profile: "1",
      session: "1",
      deletionRequest: "1",
      completionOutbox: "1",
      recipientSecret: "1",
      notificationEvent: "0",
      sourceEvidence: "0",
      sendEligibleOutbox: "0",
      pendingSecretCheckpoint: "0",
    },
  };
}

function fixtureReceipt(): PostgresAccountDeletionRecoveryFixtureReceipt {
  const state = preparedState();
  return {
    kind: POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_KIND,
    version: POSTGRES_ACCOUNT_DELETION_RECOVERY_FIXTURE_VERSION,
    fixtureId: FIXTURE_ID,
    userId: USER_ID,
    requestId: REQUEST_ID,
    preparedAt: PREPARED_AT,
    databaseIdentitySha256: DATABASE_IDENTITY,
    preparedState: state,
    preparedStateSha256: postgresAccountDeletionRecoveryFixtureInternals.semanticSha256(state),
    backupRowCounts: postgresAccountDeletionRecoveryFixtureInternals.BACKUP_BOUND_TABLES.map(
      (tableName) => ({ tableName, rowCount: "1" }),
    ),
  };
}

function ledgerAuthority(
  tombstone: AccountDeletionTombstone = {
    requestId: REQUEST_ID,
    userId: USER_ID,
    completedAt: COMPLETED_AT,
  },
): VerifiedAccountDeletionLedger {
  const current = {
    version: 1 as const,
    generatedAt: COMPLETED_AT,
    tombstones: [tombstone],
  };
  const currentBytes = Buffer.from(`${JSON.stringify(current, null, 2)}\n`);
  const genesis = {
    version: 1 as const,
    kind: "pint-path-account-deletion-ledger-genesis" as const,
    createdAt: PREPARED_AT,
    immutablePrefix: "_control/account-deletion-ledger/v1",
    currentLedgerPath: "_control/account-deletion-tombstones.json",
  };
  const genesisBytes = Buffer.from(`${JSON.stringify(genesis, null, 2)}\n`);
  const checkpoint = {
    version: 2 as const,
    generatedAt: COMPLETED_AT,
    genesisPath: "_control/account-deletion-ledger-genesis.json",
    genesisSha256: sha256(genesisBytes),
    currentLedgerPath: "_control/account-deletion-tombstones.json",
    currentLedgerSha256: sha256(currentBytes),
    immutableObjectCount: 1,
    immutableSetSha256: "5".repeat(64),
    tombstoneCount: 1,
    latestCompletedAt: COMPLETED_AT,
  };
  const checkpointBytes = Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`);
  return {
    bytes: currentBytes,
    sha256: sha256(currentBytes),
    genesisBytes,
    genesisSha256: sha256(genesisBytes),
    checkpointBytes,
    checkpointSha256: sha256(checkpointBytes),
    tombstones: [tombstone],
    checkpoint,
  };
}

class FakeDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;
  closeCalls = 0;

  prepare(): SqlStatement {
    throw new Error("The injected workflow should replace database access.");
  }

  async exec(): Promise<void> {}

  transaction<Result>(work: () => Result | Promise<Result>): () => Promise<Result> {
    return async () => work();
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  metrics(): SqlPoolMetrics {
    return {
      dialect: "postgres",
      totalConnections: 0,
      idleConnections: 0,
      waitingRequests: 0,
      completedQueries: 0,
      failedQueries: 0,
      transactionFailures: 0,
      lastQueryDurationMs: null,
    };
  }
}

function cliHarness(environment: Readonly<Record<string, string | undefined>> = {}) {
  const database = new FakeDatabase();
  const outputs: string[] = [];
  const databaseOptions: PostgresDatabaseOptions[] = [];
  const dependencies: Partial<PostgresAccountDeletionRecoveryCliDependencies> = {
    env: environment,
    readSecretFile: async (filePath) => filePath.includes("service-role")
      ? "service-role-test-secret"
      : "postgresql://runtime:database-secret@staging.invalid/pintpath?sslmode=require",
    createDatabase: (options) => {
      databaseOptions.push(options);
      return database;
    },
    assertMutationAllowed: vi.fn(),
    assertDestinationPins: vi.fn(),
    appendAndFetchVerifiedLedger: async (_config, tombstone) => ledgerAuthority(tombstone),
    writeOutput: (value) => outputs.push(value),
  };
  return { database, databaseOptions, dependencies, outputs };
}

describe("Postgres account-deletion recovery fixture authority", () => {
  it("strictly parses its canonical prepared receipt and rejects extra fields", () => {
    const receipt = fixtureReceipt();
    const bytes = Buffer.from(canonicalPostgresLogicalStateJson(receipt));
    expect(postgresAccountDeletionRecoveryFixtureInternals.parseFixtureReceipt(bytes)).toEqual(receipt);
    expect(() => postgresAccountDeletionRecoveryFixtureInternals.parseFixtureReceipt(
      Buffer.from(canonicalPostgresLogicalStateJson({ ...receipt, ignored: true })),
    )).toThrowError(expect.objectContaining({ code: "receipt_invalid" }));
  });

  it("accepts only exact canonical verified ledger bytes containing the requested tombstone", () => {
    const tombstone = { requestId: REQUEST_ID, userId: USER_ID, completedAt: COMPLETED_AT };
    const validated = postgresAccountDeletionRecoveryFixtureInternals.validateLedgerAuthority(
      ledgerAuthority(tombstone),
      tombstone,
    );
    expect(validated).toMatchObject({
      tombstoneCount: 1,
      currentSha256: sha256(ledgerAuthority(tombstone).bytes),
      immutableSetSha256: "5".repeat(64),
    });

    const tampered = ledgerAuthority(tombstone);
    tampered.checkpointBytes = Buffer.from(`${tampered.checkpointBytes.toString("utf8")} `);
    tampered.checkpointSha256 = sha256(tampered.checkpointBytes);
    expect(() => postgresAccountDeletionRecoveryFixtureInternals.validateLedgerAuthority(
      tampered,
      tombstone,
    )).toThrowError(expect.objectContaining({ code: "tombstone_verification_failed" }));
    expect(() => postgresAccountDeletionRecoveryFixtureInternals.validateLedgerAuthority(
      ledgerAuthority(tombstone),
      { ...tombstone, requestId: "different-request" },
    )).toThrowError(expect.objectContaining({ code: "tombstone_verification_failed" }));
  });

  it("provides a fail-if-called notification provider tripwire", async () => {
    const provider = createFailIfCalledAccountDeletionRecoveryProvider();
    await expect(provider.send({
      requestId: REQUEST_ID,
      from: "no-reply@pintpath.invalid",
      to: `${USER_ID}@pintpath.invalid`,
      subject: "forbidden",
      text: "forbidden",
      html: "<p>forbidden</p>",
    })).rejects.toEqual(expect.objectContaining({
      name: "PostgresAccountDeletionRecoveryFixtureError",
      code: "provider_call_forbidden",
    }));
    expect(provider.mode).toBe("mock");
  });
});

describe("Postgres account-deletion recovery proof CLI", () => {
  const runtimeFile = path.resolve("/private/runtime-url");
  const fixtureFile = path.resolve("/private/fixture.json");

  it("requires explicit confirmation before prepare and never opens Postgres on rejection", async () => {
    const harness = cliHarness();
    const exitCode = await runPostgresAccountDeletionRecoveryCli([
      "prepare",
      `--runtime-database-url-file=${runtimeFile}`,
      `--expected-database-identity-sha256=${DATABASE_IDENTITY}`,
      `--fixture-receipt=${fixtureFile}`,
    ], harness.dependencies);
    expect(exitCode).toBe(1);
    expect(JSON.parse(harness.outputs[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      failureCode: "confirmation_required",
    });
    expect(harness.databaseOptions).toEqual([]);
  });

  it("emits hash-only prepare success and closes its bounded runtime adapter", async () => {
    const harness = cliHarness({
      [POSTGRES_ACCOUNT_DELETION_RECOVERY_CONFIRMATION_ENV]:
        POSTGRES_ACCOUNT_DELETION_RECOVERY_CONFIRMATION_VALUE,
    });
    harness.dependencies.prepare = vi.fn(async () => ({
      receipt: fixtureReceipt(),
      receiptSha256: "b".repeat(64),
      stateSha256: "c".repeat(64),
      databaseIdentitySha256: DATABASE_IDENTITY,
    }));
    const exitCode = await runPostgresAccountDeletionRecoveryCli([
      "prepare",
      `--runtime-database-url-file=${runtimeFile}`,
      `--expected-database-identity-sha256=${DATABASE_IDENTITY}`,
      `--fixture-receipt=${fixtureFile}`,
      `--fixture-id=${FIXTURE_ID}`,
      `--prepared-at=${PREPARED_AT}`,
    ], harness.dependencies);
    expect(exitCode).toBe(0);
    expect(JSON.parse(harness.outputs[0]!)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: "prepare",
      fixtureReceiptSha256: "b".repeat(64),
      databaseIdentitySha256: DATABASE_IDENTITY,
      preparedStateSha256: "c".repeat(64),
    });
    expect(harness.database.closeCalls).toBe(1);
    expect(harness.databaseOptions[0]).toMatchObject({
      applicationName: "pintpath-account-deletion-recovery-proof",
      maxConnections: 1,
    });
    expect(harness.outputs[0]).not.toContain("database-secret");
  });

  it("keeps raw database/provider errors out of failure output", async () => {
    const harness = cliHarness({
      [POSTGRES_ACCOUNT_DELETION_RECOVERY_CONFIRMATION_ENV]:
        POSTGRES_ACCOUNT_DELETION_RECOVERY_CONFIRMATION_VALUE,
    });
    harness.dependencies.prepare = vi.fn(async () => {
      throw new Error("postgresql://runtime:leaked@private.internal/pintpath");
    });
    expect(await runPostgresAccountDeletionRecoveryCli([
      "prepare",
      `--runtime-database-url-file=${runtimeFile}`,
      `--expected-database-identity-sha256=${DATABASE_IDENTITY}`,
      `--fixture-receipt=${fixtureFile}`,
    ], harness.dependencies)).toBe(1);
    expect(JSON.parse(harness.outputs[0]!)).toMatchObject({
      ok: false,
      failureCode: "unexpected_failure",
    });
    expect(harness.outputs[0]).not.toContain("leaked");
    expect(harness.outputs[0]).not.toContain("private.internal");
    expect(harness.database.closeCalls).toBe(1);
  });

  it("keeps inspect read-only and emits only receipt/state identity hashes", async () => {
    const harness = cliHarness();
    harness.dependencies.inspect = vi.fn(async () => ({
      receipt: fixtureReceipt(),
      receiptSha256: "b".repeat(64),
      databaseIdentitySha256: DATABASE_IDENTITY,
      state: preparedState(),
      stateSha256: "c".repeat(64),
    }));
    expect(await runPostgresAccountDeletionRecoveryCli([
      "inspect",
      `--runtime-database-url-file=${runtimeFile}`,
      `--fixture-receipt=${fixtureFile}`,
      `--fixture-receipt-sha256=${"b".repeat(64)}`,
    ], harness.dependencies)).toBe(0);
    expect(JSON.parse(harness.outputs[0]!)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: "inspect",
      phase: "prepared",
      fixtureReceiptSha256: "b".repeat(64),
      databaseIdentitySha256: DATABASE_IDENTITY,
      stateSha256: "c".repeat(64),
    });
    expect(harness.dependencies.assertMutationAllowed).not.toHaveBeenCalled();
    expect(harness.database.closeCalls).toBe(1);
  });

  it("pins the complete ledger destination and emits no provider credential or fixture ID", async () => {
    const harness = cliHarness({
      [POSTGRES_ACCOUNT_DELETION_RECOVERY_CONFIRMATION_ENV]:
        POSTGRES_ACCOUNT_DELETION_RECOVERY_CONFIRMATION_VALUE,
      SUPABASE_URL: "https://source.supabase.test",
      OFFSITE_BACKUP_SUPABASE_URL: "https://ledger.supabase.test",
      OFFSITE_BACKUP_BUCKET: "private-ledger",
    });
    harness.dependencies.complete = vi.fn(async () => ({
      receipt: {
        kind: "pintpath-postgres-account-deletion-recovery-fixture-completion",
        version: 1,
        completedAt: COMPLETED_AT,
        fixtureReceiptSha256: "b".repeat(64),
        logicalBackupStateReceiptSha256: "c".repeat(64),
        databaseIdentitySha256: DATABASE_IDENTITY,
        tombstoneSha256: "d".repeat(64),
        ledgerAuthoritySha256: "e".repeat(64),
        ledgerCurrentSha256: "f".repeat(64),
        ledgerGenesisSha256: "1".repeat(64),
        ledgerCheckpointSha256: "2".repeat(64),
        ledgerImmutableSetSha256: "3".repeat(64),
        ledgerTombstoneCount: 1,
        completedStateSha256: "4".repeat(64),
        providerCallCount: 0,
      },
      receiptSha256: "5".repeat(64),
      stateSha256: "4".repeat(64),
      databaseIdentitySha256: DATABASE_IDENTITY,
      ledgerAuthoritySha256: "e".repeat(64),
    }));
    const serviceRoleFile = path.resolve("/private/service-role.key");
    expect(await runPostgresAccountDeletionRecoveryCli([
      "complete",
      `--runtime-database-url-file=${runtimeFile}`,
      `--fixture-receipt=${fixtureFile}`,
      `--fixture-receipt-sha256=${"b".repeat(64)}`,
      `--logical-backup-state-receipt=${path.resolve("/private/state-receipt.json")}`,
      `--logical-backup-state-receipt-sha256=${"c".repeat(64)}`,
      `--ledger-authority-output=${path.resolve("/private/ledger-authority")}`,
      `--completion-receipt=${path.resolve("/private/completion.json")}`,
      `--completed-at=${COMPLETED_AT}`,
      `--service-role-key-file=${serviceRoleFile}`,
      `--expected-destination-origin-sha256=${"6".repeat(64)}`,
      `--expected-bucket-name-sha256=${"7".repeat(64)}`,
    ], harness.dependencies)).toBe(0);
    expect(harness.dependencies.assertDestinationPins).toHaveBeenCalledWith({
      destinationSupabaseUrl: "https://ledger.supabase.test",
      bucketName: "private-ledger",
      expectedDestinationOriginSha256: "6".repeat(64),
      expectedBucketNameSha256: "7".repeat(64),
    });
    expect(JSON.parse(harness.outputs[0]!)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: "complete",
      completionReceiptSha256: "5".repeat(64),
      databaseIdentitySha256: DATABASE_IDENTITY,
      completedStateSha256: "4".repeat(64),
      ledgerAuthoritySha256: "e".repeat(64),
    });
    expect(harness.outputs[0]).not.toContain("service-role-test-secret");
    expect(harness.outputs[0]).not.toContain(FIXTURE_ID);
    expect(harness.database.closeCalls).toBe(1);
  });

  it("recognizes stable library errors without exposing their causes", () => {
    expect(new PostgresAccountDeletionRecoveryFixtureError("fixture_state_conflict")).toMatchObject({
      code: "fixture_state_conflict",
      message: "The account-deletion recovery fixture conflicts with durable state.",
    });
  });
});
