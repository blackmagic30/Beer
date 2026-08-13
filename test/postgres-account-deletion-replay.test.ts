import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccountDeletionRequestRow } from "../src/db/account-deletion-queue.repository.js";
import type { SqlDatabase, SqlStatement } from "../src/db/sql-database.js";
import type { AccountDeletionTombstone } from "../src/lib/data-backup.js";
import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import type { PostgresLogicalRestoreReceipt } from "../src/lib/postgres-logical-restore.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import {
  POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_ENV,
  POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE,
  PostgresAccountDeletionReplayError,
  postgresAccountDeletionReplayTargetIdentitySha256,
  replayPostgresAccountDeletionTombstones,
} from "../src/lib/postgres-account-deletion-replay.js";
import { runPostgresAccountDeletionReplayCli } from "../scripts/replay-postgres-account-deletion-tombstones.js";

const COMPLETED_AT = "2026-08-09T04:45:00.000Z";
const REPLAYED_AT = "2026-08-09T05:45:00.000Z";
const TOMBSTONE: AccountDeletionTombstone = {
  requestId: "synthetic-delete-request",
  userId: "synthetic-delete-user",
  completedAt: COMPLETED_AT,
};
const TARGET_IDENTITY_INPUT = {
  systemIdentifier: "7460011223344556677",
  databaseOid: "16385",
  databaseName: "pintpath_restore_test",
  serverVersionNum: "170010",
  targetClass: "disposable-rehearsal",
};
const TARGET_IDENTITY_SHA256 = postgresAccountDeletionReplayTargetIdentitySha256(
  TARGET_IDENTITY_INPUT,
);

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function privateRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-deletion-replay-")));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function writePrivate(filePath: string, bytes: string | Buffer): void {
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function failMatchingFileHandleClose(filePath: string, matchingOpenOrdinal: number): {
  readonly closeCallCount: () => number;
  readonly openedFileDescriptors: number[];
} {
  const originalOpen = fs.promises.open.bind(fs.promises);
  let matchingOpenCount = 0;
  let closeCallCount = 0;
  const openedFileDescriptors: number[] = [];
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== filePath) return handle;
    matchingOpenCount += 1;
    if (matchingOpenCount !== matchingOpenOrdinal) return handle;
    openedFileDescriptors.push(handle.fd);
    const close = handle.close.bind(handle);
    Object.defineProperty(handle, "close", {
      configurable: true,
      value: async () => {
        closeCallCount += 1;
        await close();
        throw new Error("simulated descriptor close failure");
      },
    });
    return handle;
  });
  return { closeCallCount: () => closeCallCount, openedFileDescriptors };
}

function failReceiptParentOperation(
  parentPath: string,
  operation: "sync" | "close",
): {
  readonly operationCallCount: () => number;
  readonly openedFileDescriptors: number[];
} {
  const originalOpen = fs.promises.open.bind(fs.promises);
  let operationCallCount = 0;
  const openedFileDescriptors: number[] = [];
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (path.resolve(String(args[0])) !== parentPath) return handle;
    openedFileDescriptors.push(handle.fd);
    const originalOperation = handle[operation].bind(handle);
    Object.defineProperty(handle, operation, {
      configurable: true,
      value: async () => {
        operationCallCount += 1;
        await originalOperation();
        throw new Error(`simulated receipt parent ${operation} failure`);
      },
    });
    return handle;
  });
  return { operationCallCount: () => operationCallCount, openedFileDescriptors };
}

function baseReceipt(): PostgresLogicalRestoreReceipt {
  return {
    kind: "pintpath-postgres-logical-restore-rehearsal",
    version: 1,
    status: "verified",
    restoredAt: "2026-08-09T04:30:00.000Z",
    backupManifestSha256: "1".repeat(64),
    backupArchiveSha256: "2".repeat(64),
    targetIdentitySha256: TARGET_IDENTITY_SHA256,
    targetUrlSha256: "3".repeat(64),
    authoritativeTableCount: 56,
    authoritativeColumnCount: 717,
    foreignKeyCount: 76,
    authoritativeRowCount: "13121",
    nonEmptyAuthoritativeTableCount: 45,
    authoritativeCountInventorySha256: "4".repeat(64),
    controlCountInventorySha256: "5".repeat(64),
    schemaMetadataSha256: "6".repeat(64),
    rowSecurityTableCount: 59,
    aclContractSha256: "7".repeat(64),
    apiRolesIsolated: true,
    runtimeApplicationAccessRestored: true,
    migratorReconciliationAccessVerified: true,
    runtimeOperationsIsolated: true,
    promotionReconciliationReady: true,
    sourceStateBindingStatus: "exact-match",
    expectedSourceStateReceiptSha256: "8".repeat(64),
    sourceSnapshotBindingSha256: "9".repeat(64),
    expectedSourceTableSetSha256: "a".repeat(64),
    expectedSourceDataSha256: "b".repeat(64),
    expectedSourceStateTotalsSha256: "c".repeat(64),
    expectedSourceKeyRangesSha256: "d".repeat(64),
    expectedArchivedControlTableSetSha256: "e".repeat(64),
    expectedArchivedControlDataSha256: "f".repeat(64),
    expectedArchivedControlKeyRangesSha256: "0".repeat(64),
    expectedSourceOverallStateSha256: "a1".repeat(32),
    restoredOverallStateSha256: "a1".repeat(32),
    exactDataReconciliation: "canonical-contract-exact",
  };
}

function pretty(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeAuthority(root: string): {
  directory: string;
  currentSha256: string;
  genesisSha256: string;
  checkpointSha256: string;
  immutableSetSha256: string;
} {
  const directory = path.join(root, "authority");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const current = pretty({ version: 1, generatedAt: COMPLETED_AT, tombstones: [TOMBSTONE] });
  const genesis = pretty({
    version: 1,
    kind: "pint-path-account-deletion-ledger-genesis",
    createdAt: "2026-08-01T00:00:00.000Z",
    immutablePrefix: "_control/account-deletion-ledger/v1",
    currentLedgerPath: "_control/account-deletion-tombstones.json",
  });
  const currentSha256 = sha256(current);
  const genesisSha256 = sha256(genesis);
  const immutableSetSha256 = "b2".repeat(32);
  const checkpoint = pretty({
    version: 2,
    generatedAt: COMPLETED_AT,
    genesisPath: "_control/account-deletion-ledger-genesis.json",
    genesisSha256,
    currentLedgerPath: "_control/account-deletion-tombstones.json",
    currentLedgerSha256: currentSha256,
    immutableObjectCount: 1,
    immutableSetSha256,
    tombstoneCount: 1,
    latestCompletedAt: COMPLETED_AT,
  });
  writePrivate(path.join(directory, "current.json"), current);
  writePrivate(path.join(directory, "genesis.json"), genesis);
  writePrivate(path.join(directory, "checkpoint.json"), checkpoint);
  return {
    directory,
    currentSha256,
    genesisSha256,
    checkpointSha256: sha256(checkpoint),
    immutableSetSha256,
  };
}

interface MutableReplayState {
  completed: boolean;
  checkpointPending: boolean;
  beginCalls: number;
  privacyInputs: unknown[];
  lockAvailable: boolean;
  otherClientBackends: number;
  otherClientBackendObservations: number[];
  preparedSql: string[];
  closed: boolean;
}

function requestRow(state: MutableReplayState): AccountDeletionRequestRow {
  return {
    id: TOMBSTONE.requestId,
    user_id: TOMBSTONE.userId,
    status: state.completed ? "completed" : "processing",
    user_message: state.completed ? null : "delete me",
    requested_at: "2026-08-01T00:00:00.000Z",
    execute_after: "2026-08-08T00:00:00.000Z",
    reviewed_by: "synthetic-delete-admin",
    reviewed_at: "2026-08-08T00:05:00.000Z",
    completed_at: state.completed ? COMPLETED_AT : null,
    processing_started_at: "2026-08-08T00:05:00.000Z",
    identity_deleted_at: null,
    stripe_customer_deleted_at: null,
    stripe_customer_id_snapshot: null,
    deletion_tombstone_recorded_at: state.completed ? COMPLETED_AT : null,
    last_error: null,
    attempt_count: state.completed ? 2 : 1,
    result_summary_json: state.completed
      ? JSON.stringify({
        anonymisedAccount: `DEL-${sha256(TOMBSTONE.userId).slice(0, 12).toUpperCase()}`,
        surrogatePublicId: `DEL-${sha256(TOMBSTONE.userId).slice(0, 12).toUpperCase()}`,
        evidenceIds: [],
        removedSubmissions: 0,
        removedSubmissionItems: 0,
        removedContributionRows: 0,
        removedDerivedPriceRecords: 0,
        retentionPolicyVersion: "2026-08-03",
        transactionContractVersion: "2026-08-08",
      })
      : null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: state.completed ? COMPLETED_AT : "2026-08-08T00:05:00.000Z",
  };
}

function semanticRow(state: MutableReplayState): Record<string, unknown> {
  const surrogate = `DEL-${sha256(TOMBSTONE.userId).slice(0, 12).toUpperCase()}`;
  const request = requestRow(state);
  return {
    requestId: TOMBSTONE.requestId,
    userId: TOMBSTONE.userId,
    requestStatus: request.status,
    reviewedBy: request.reviewed_by,
    completedAt: request.completed_at,
    deletionTombstoneRecordedAt: request.deletion_tombstone_recorded_at,
    requestUserMessage: request.user_message,
    requestLastError: request.last_error,
    resultSummaryJson: request.result_summary_json,
    accountPublicId: state.completed ? surrogate : TOMBSTONE.userId,
    accountEmail: state.completed
      ? `deleted-${TOMBSTONE.userId}@invalid.pintpath.local`
      : "synthetic-delete@example.com",
    passwordHash: state.completed ? "deleted" : "password-hash",
    authProvider: state.completed ? "deleted" : "local",
    supabaseUserId: null,
    stripeCustomerId: null,
    accountStatus: state.completed ? "suspended" : "active",
    subscriptionStatus: "free",
    profilePublicId: state.completed ? surrogate : TOMBSTONE.userId,
    profileStatus: state.completed ? "suspended" : "active",
    outboxStatus: state.completed ? "suppressed_restore" : "held",
    outboxTerminalAt: state.completed ? COMPLETED_AT : null,
    outboxNextAttemptAt: null,
    outboxLeaseToken: null,
    outboxLeaseExpiresAt: null,
    outboxProviderMessageId: null,
    outboxProviderLastEvent: null,
    outboxProviderEventAt: null,
    outboxLastError: state.completed
      ? "Notification suppressed during deletion-tombstone restore reconciliation."
      : null,
    secretPurgeCheckpointPending: state.completed ? state.checkpointPending : false,
    authSessionCount: state.completed ? "0" : "1",
    recipientSecretCount: state.completed ? "0" : "1",
    notificationEventCount: "0",
    activeSourceEvidenceCount: "0",
  };
}

function fakeDatabase(state: MutableReplayState): SqlDatabase {
  const prepare = (sql: string): SqlStatement => {
    state.preparedSql.push(sql);
    return ({
    run: async () => ({ changes: 0 }),
    get: async <Row>() => {
      if (sql.includes("target-inspection")) {
        return {
          ...TARGET_IDENTITY_INPUT,
          targetClass: "disposable-rehearsal",
          transactionReadOnly: false,
          inRecovery: false,
          databaseIsTemplate: false,
          databaseAllowsConnections: true,
          effectiveRole: "pintpath_maintenance",
          roleName: "pintpath_replay_login",
          canLogin: true,
          superuser: false,
          createDatabase: false,
          createRole: false,
          replication: false,
          bypassRls: false,
          replayMember: true,
          runtimeMember: false,
          migratorMember: false,
          applicationSchemaUsage: true,
          operationsSchemaUsage: false,
          searchPathSchemas: ["pintpath_app", "pg_catalog"],
          currentSchema: "pintpath_app",
          hasDatabaseCreatePrivilege: false,
          applicationSchemaCreate: false,
          unexpectedMembership: false,
        } as Row;
      }
      if (sql.includes("restore-lock-held")) {
        return { held: true, backendPid: "4242" } as Row;
      }
      if (sql.includes("other-client-backends")) {
        return {
          otherClientBackends: String(
            state.otherClientBackendObservations.shift() ?? state.otherClientBackends,
          ),
        } as Row;
      }
      if (sql.includes("restore-lock")) {
        return { acquired: state.lockAvailable, backendPid: "4242" } as Row;
      }
      if (sql.includes("restore-unlock")) return { released: true } as Row;
      if (sql.includes("semantic-state")) return semanticRow(state) as Row;
      return undefined;
    },
    all: async <Row>() => {
      if (sql.includes("deletion-replay:metadata")) {
        return [
          { key: "import_state", value: "ready" },
          { key: "migration_candidate_sha", value: "c".repeat(40) },
          { key: "migration_manifest_sha256", value: "d".repeat(64) },
          { key: "migration_run_sha256", value: "e".repeat(64) },
          { key: "schema_version", value: "1" },
          { key: "source_snapshot_sha256", value: "f".repeat(64) },
        ] as Row[];
      }
      return [];
    },
    });
  };
  return {
    dialect: "postgres",
    prepare,
    exec: async () => undefined,
    transaction: <Result>(work: () => Result | Promise<Result>) => async () => work(),
    close: async () => { state.closed = true; },
    metrics: () => ({
      dialect: "postgres",
      totalConnections: state.closed ? 0 : 1,
      idleConnections: state.closed ? 0 : 1,
      waitingRequests: 0,
      completedQueries: 0,
      failedQueries: 0,
      transactionFailures: 0,
      lastQueryDurationMs: null,
    }),
  };
}

function fixture() {
  const root = privateRoot();
  const evidenceDirectory = path.join(root, "evidence");
  fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
  fs.chmodSync(evidenceDirectory, 0o700);
  const runtimeUrlFile = path.join(root, "runtime-url");
  writePrivate(
    runtimeUrlFile,
    "postgresql://pintpath_replay_login:private-password@127.0.0.1:55432/pintpath_restore_test?sslmode=disable\n",
  );
  const baseRestoreReceiptFile = path.join(root, "base-restore-receipt.json");
  const baseRestoreReceiptBytes = canonicalPostgresBackupJson(baseReceipt());
  writePrivate(baseRestoreReceiptFile, baseRestoreReceiptBytes);
  const baseRestoreReceiptSha256 = sha256(baseRestoreReceiptBytes);
  const authority = writeAuthority(root);
  const state: MutableReplayState = {
    completed: false,
    checkpointPending: false,
    beginCalls: 0,
    privacyInputs: [],
    lockAvailable: true,
    otherClientBackends: 0,
    otherClientBackendObservations: [],
    preparedSql: [],
    closed: false,
  };
  const database = fakeDatabase(state);
  const dependencies = {
    env: { NODE_ENV: "test" },
    getUid: () => process.getuid?.() ?? 0,
    now: () => new Date(REPLAYED_AT),
    allowInsecureLoopbackForTests: true,
    createDatabase: () => database,
    createQueue: () => ({
      getAccountDeletionRequestById: async () => requestRow(state),
      beginAccountDeletion: async () => {
        state.beginCalls += 1;
        return { ...requestRow(state), status: "processing" as const, attempt_count: 2 };
      },
      markAccountDeletionTombstoneRecorded: async () => true,
      checkpointAccountDeletionNotificationSecrets: async (
        checkpoint: (snapshot: readonly { requestId: string; generation: number }[]) => Promise<boolean>,
      ) => {
        if (!await checkpoint([{ requestId: TOMBSTONE.requestId, generation: 1 }])) return false;
        state.checkpointPending = false;
        return true;
      },
    }),
    createPrivacy: () => ({
      executeAccountAnonymisation: async (input: unknown) => {
        state.privacyInputs.push(input);
        state.completed = true;
        state.checkpointPending = true;
        return { evidenceIds: [] };
      },
    }),
    createPhysicalCheckpoint: () => async () => true,
  };
  const options = (receiptName: string) => ({
    runtimeUrlFile,
    baseRestoreReceiptFile,
    expectedBaseRestoreReceiptSha256: baseRestoreReceiptSha256,
    deletionLedgerAuthorityDirectory: authority.directory,
    expectedTargetIdentitySha256: TARGET_IDENTITY_SHA256,
    expectedLedgerCurrentSha256: authority.currentSha256,
    expectedLedgerGenesisSha256: authority.genesisSha256,
    expectedLedgerCheckpointSha256: authority.checkpointSha256,
    expectedLedgerImmutableSetSha256: authority.immutableSetSha256,
    expectedTombstoneCount: 1,
    receiptFile: path.join(evidenceDirectory, receiptName),
    confirmation: POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE,
  });
  return {
    root,
    evidenceDirectory,
    runtimeUrlFile,
    baseRestoreReceiptFile,
    baseRestoreReceiptSha256,
    authority,
    state,
    dependencies,
    options,
  };
}

describe("Postgres account-deletion tombstone replay", () => {
  it("applies one tombstone with suppress_restore and proves an exact idempotent second pass", async () => {
    const harness = fixture();
    const first = await replayPostgresAccountDeletionTombstones(
      harness.options("first-receipt.json"),
      harness.dependencies,
    );
    expect(first).toMatchObject({
      ok: true,
      seen: 1,
      newlyApplied: 1,
      alreadyApplied: 0,
      missing: 0,
      failed: 0,
      targetIdentitySha256: TARGET_IDENTITY_SHA256,
    });
    expect(harness.state.beginCalls).toBe(1);
    expect(harness.state.privacyInputs).toEqual([expect.objectContaining({
      requestId: TOMBSTONE.requestId,
      now: COMPLETED_AT,
      completionNotificationDisposition: "suppress_restore",
      providerPolicy: {
        requireTombstoneReceipt: true,
        allowUnconfirmedStripeDeletion: false,
      },
    })]);
    expect(fs.statSync(harness.options("first-receipt.json").receiptFile).mode & 0o7777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(
      harness.options("first-receipt.json").receiptFile,
      "utf8",
    )).baseRestoreReceiptSha256).toBe(harness.baseRestoreReceiptSha256);

    harness.state.closed = false;
    const second = await replayPostgresAccountDeletionTombstones(
      harness.options("second-receipt.json"),
      harness.dependencies,
    );
    expect(second).toMatchObject({
      ok: true,
      seen: 1,
      newlyApplied: 0,
      alreadyApplied: 1,
      missing: 0,
      failed: 0,
    });
    expect(second.semanticProjectionSha256).toBe(first.semanticProjectionSha256);
    expect(harness.state.beginCalls).toBe(1);
    expect(harness.state.preparedSql.some((sql) => sql.includes("restore-unlock"))).toBe(false);
  });

  it("binds production replay to the stock-localhost TLS transport and maintenance startup role", async () => {
    const harness = fixture();
    writePrivate(
      harness.runtimeUrlFile,
      "postgresql://pintpath_replay_login:private-password@postgres.railway.internal:5432/pintpath_restore_test?sslmode=verify-full\n",
    );
    const rootCaFile = path.join(harness.root, "railway-root-ca.pem");
    writePrivate(rootCaFile, "fixture-root-ca");
    const rootCaDerSha256 = "7".repeat(64);
    const assertExact = vi.fn(async () => undefined);
    const closeTransport = vi.fn(async () => undefined);
    const transport: PostgresRailwayStockLocalhostCaTransport = {
      profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaDerSha256,
      sourceUrlAuthority: { hostname: "postgres.railway.internal", port: 5432 },
      resolvedAddress: "fd12::1",
      temporaryDirectory: "/private/transport",
      passwordFileDirectory: "/private/transport",
      passwordFileHost: "localhost",
      nodeConnection: {
        host: "fd12::1",
        port: 5432,
        ssl: {
          ca: "fixture-root-ca",
          servername: "localhost",
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          checkServerIdentity: () => undefined,
        },
      },
      libpqEnvironment: {
        PGHOST: "localhost",
        PGHOSTADDR: "fd12::1",
        PGPORT: "5432",
        PGSSLMODE: "verify-full",
        PGSSLROOTCERT: "/private/transport/root-ca.pem",
        PGSSLMINPROTOCOLVERSION: "TLSv1.2",
        PGSSLSNI: "1",
      },
      assertExact,
      close: closeTransport,
    };
    const openRuntimeTransport = vi.fn(async () => transport);
    const createDatabase = vi.fn(() => fakeDatabase(harness.state));
    const result = await replayPostgresAccountDeletionTombstones({
      ...harness.options("secure-receipt.json"),
      runtimeRootCaFile: rootCaFile,
      expectedRuntimeRootCaDerSha256: rootCaDerSha256,
    }, {
      ...harness.dependencies,
      env: { NODE_ENV: "production" },
      allowInsecureLoopbackForTests: false,
      openRuntimeTransport,
      createDatabase,
    });
    expect(result.ok).toBe(true);
    expect(openRuntimeTransport).toHaveBeenCalledWith(expect.objectContaining({
      profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaFile,
      expectedRootCaDerSha256: rootCaDerSha256,
      sourceUrlAuthority: { hostname: "postgres.railway.internal", port: 5432 },
    }));
    expect(createDatabase).toHaveBeenCalledWith(expect.objectContaining({
      activeRole: "pintpath_maintenance",
      railwayStockLocalhostCaConnection: transport.nodeConnection,
    }));
    expect(assertExact.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(
      harness.options("secure-receipt.json").receiptFile,
      "utf8",
    ))).toMatchObject({
      version: 2,
      replayRoleRestricted: true,
      replayEffectiveRole: "pintpath_maintenance",
      transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      transportRootCaDerSha256: rootCaDerSha256,
    });
  });

  it("rejects a world-readable authority artifact before opening a database", async () => {
    const harness = fixture();
    fs.chmodSync(path.join(harness.authority.directory, "current.json"), 0o644);
    const createDatabase = vi.fn(() => fakeDatabase(harness.state));
    await expect(replayPostgresAccountDeletionTombstones(
      harness.options("receipt.json"),
      { ...harness.dependencies, createDatabase },
    )).rejects.toEqual(expect.objectContaining({ code: "unsafe_authority_directory" }));
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it("fails closed on a held restore lock without invoking repositories", async () => {
    const harness = fixture();
    harness.state.lockAvailable = false;
    await expect(replayPostgresAccountDeletionTombstones(
      harness.options("receipt.json"),
      harness.dependencies,
    )).rejects.toEqual(expect.objectContaining({ code: "target_busy" }));
    expect(harness.state.beginCalls).toBe(0);
    expect(harness.state.privacyInputs).toHaveLength(0);
    expect(harness.state.closed).toBe(true);
  });

  it("rejects a noncanonical or target-mismatched base receipt before connecting", async () => {
    const harness = fixture();
    const receipt = { ...baseReceipt(), targetIdentitySha256: "f".repeat(64) };
    const receiptBytes = canonicalPostgresBackupJson(receipt);
    writePrivate(harness.baseRestoreReceiptFile, receiptBytes);
    const createDatabase = vi.fn(() => fakeDatabase(harness.state));
    await expect(replayPostgresAccountDeletionTombstones(
      {
        ...harness.options("receipt.json"),
        expectedBaseRestoreReceiptSha256: sha256(receiptBytes),
      },
      { ...harness.dependencies, createDatabase },
    )).rejects.toEqual(expect.objectContaining({ code: "base_restore_receipt_invalid" }));
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined, "invalid_arguments"],
    ["wrong", "0".repeat(64), "base_restore_receipt_invalid"],
    ["uppercase", "A".repeat(64), "invalid_arguments"],
  ] as const)(
    "rejects a %s base restore receipt pin before connection or mutation",
    async (_case, pin, failureCode) => {
      const harness = fixture();
      fs.chmodSync(path.join(harness.authority.directory, "current.json"), 0o644);
      const createDatabase = vi.fn(() => fakeDatabase(harness.state));
      await expect(replayPostgresAccountDeletionTombstones({
        ...harness.options("receipt.json"),
        expectedBaseRestoreReceiptSha256: pin as unknown as string,
      }, {
        ...harness.dependencies,
        createDatabase,
      })).rejects.toEqual(expect.objectContaining({ code: failureCode }));
      expect(createDatabase).not.toHaveBeenCalled();
      expect(harness.state.beginCalls).toBe(0);
      expect(harness.state.privacyInputs).toHaveLength(0);
      expect(fs.existsSync(harness.options("receipt.json").receiptFile)).toBe(false);
    },
  );

  it("authenticates the successful base receipt before reading the runtime credential", async () => {
    const harness = fixture();
    fs.chmodSync(harness.runtimeUrlFile, 0o644);
    const createDatabase = vi.fn(() => fakeDatabase(harness.state));
    await expect(replayPostgresAccountDeletionTombstones({
      ...harness.options("receipt.json"),
      expectedBaseRestoreReceiptSha256: "0".repeat(64),
    }, {
      ...harness.dependencies,
      createDatabase,
    })).rejects.toEqual(expect.objectContaining({ code: "base_restore_receipt_invalid" }));
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "runtime credential directory",
      receiptFile: (harness: ReturnType<typeof fixture>) => path.join(
        harness.root,
        "overlap-receipt.json",
      ),
    },
    {
      name: "sealed ledger authority directory",
      receiptFile: (harness: ReturnType<typeof fixture>) => path.join(
        harness.authority.directory,
        "overlap-receipt.json",
      ),
    },
  ])("rejects the $name as a receipt parent before connection", async ({ receiptFile }) => {
    const harness = fixture();
    const createDatabase = vi.fn(() => fakeDatabase(harness.state));
    await expect(replayPostgresAccountDeletionTombstones({
      ...harness.options("unused.json"),
      receiptFile: receiptFile(harness),
    }, {
      ...harness.dependencies,
      createDatabase,
    })).rejects.toEqual(expect.objectContaining({ code: "invalid_arguments" }));
    expect(createDatabase).not.toHaveBeenCalled();
    expect(harness.state.beginCalls).toBe(0);
  });

  it("rejects a dangling receipt symlink before connection or mutation", async () => {
    const harness = fixture();
    const receiptFile = harness.options("dangling-receipt.json").receiptFile;
    fs.symlinkSync(path.join(harness.root, "missing-receipt-target"), receiptFile);
    const createDatabase = vi.fn(() => fakeDatabase(harness.state));
    await expect(replayPostgresAccountDeletionTombstones({
      ...harness.options("unused.json"),
      receiptFile,
    }, {
      ...harness.dependencies,
      createDatabase,
    })).rejects.toEqual(expect.objectContaining({ code: "invalid_arguments" }));
    expect(createDatabase).not.toHaveBeenCalled();
    expect(fs.lstatSync(receiptFile).isSymbolicLink()).toBe(true);
  });

  it("fails before mutation when another client backend is present", async () => {
    const harness = fixture();
    harness.state.otherClientBackends = 1;
    await expect(replayPostgresAccountDeletionTombstones(
      harness.options("busy-receipt.json"),
      harness.dependencies,
    )).rejects.toEqual(expect.objectContaining({ code: "target_busy" }));
    expect(harness.state.beginCalls).toBe(0);
    expect(harness.state.closed).toBe(true);
  });

  it("requires disposal when another client backend appears after replay", async () => {
    const harness = fixture();
    harness.state.otherClientBackendObservations.push(0, 1);
    const receiptFile = harness.options("late-client-receipt.json").receiptFile;
    await expect(replayPostgresAccountDeletionTombstones(
      harness.options("late-client-receipt.json"),
      harness.dependencies,
    )).rejects.toEqual(expect.objectContaining({
      code: "verification_failed_target_disposal_required",
    }));
    expect(harness.state.beginCalls).toBe(1);
    expect(harness.state.closed).toBe(true);
    expect(() => fs.lstatSync(receiptFile)).toThrow();
  });

  it("always attempts database close when pre-close metrics are uncertain", async () => {
    const harness = fixture();
    const baseDatabase = fakeDatabase(harness.state);
    let metricsCalls = 0;
    let closeCalls = 0;
    const database: SqlDatabase = {
      ...baseDatabase,
      metrics: () => {
        metricsCalls += 1;
        if (metricsCalls === 1) throw new Error("simulated metrics failure");
        return baseDatabase.metrics();
      },
      close: async () => {
        closeCalls += 1;
        await baseDatabase.close();
      },
    };
    const receiptFile = harness.options("metrics-receipt.json").receiptFile;
    await expect(replayPostgresAccountDeletionTombstones(
      harness.options("metrics-receipt.json"),
      { ...harness.dependencies, createDatabase: () => database },
    )).rejects.toEqual(expect.objectContaining({
      code: "verification_failed_target_disposal_required",
    }));
    expect(closeCalls).toBe(1);
    expect(harness.state.closed).toBe(true);
    expect(() => fs.lstatSync(receiptFile)).toThrow();
  });

  it("requires disposal when the database close promise rejects", async () => {
    const harness = fixture();
    const baseDatabase = fakeDatabase(harness.state);
    let closeCalls = 0;
    const database: SqlDatabase = {
      ...baseDatabase,
      close: async () => {
        closeCalls += 1;
        await baseDatabase.close();
        throw new Error("simulated close failure");
      },
    };
    await expect(replayPostgresAccountDeletionTombstones(
      harness.options("close-failed-receipt.json"),
      { ...harness.dependencies, createDatabase: () => database },
    )).rejects.toEqual(expect.objectContaining({
      code: "verification_failed_target_disposal_required",
    }));
    expect(closeCalls).toBe(1);
    expect(harness.state.closed).toBe(true);
  });

  it("reasserts the base receipt after database close before publishing replay evidence", async () => {
    const harness = fixture();
    const baseDatabase = fakeDatabase(harness.state);
    const originalSize = Buffer.byteLength(canonicalPostgresBackupJson(baseReceipt()), "utf8");
    const database: SqlDatabase = {
      ...baseDatabase,
      close: async () => {
        await baseDatabase.close();
        writePrivate(harness.baseRestoreReceiptFile, Buffer.alloc(originalSize, 0x58));
      },
    };
    const receiptFile = harness.options("post-close-drift-receipt.json").receiptFile;
    await expect(replayPostgresAccountDeletionTombstones(
      harness.options("post-close-drift-receipt.json"),
      { ...harness.dependencies, createDatabase: () => database },
    )).rejects.toEqual(expect.objectContaining({
      code: "verification_failed_target_disposal_required",
    }));
    expect(() => fs.lstatSync(receiptFile)).toThrow();
  });

  it.each([
    {
      name: "initial base-receipt",
      matchingOpenOrdinal: 1,
      expectedCode: "base_restore_receipt_invalid",
      expectedDatabaseCreates: 0,
    },
    {
      name: "post-session base-receipt",
      matchingOpenOrdinal: 4,
      expectedCode: "verification_failed_target_disposal_required",
      expectedDatabaseCreates: 1,
    },
  ])(
    "fails closed when the $name snapshot descriptor cannot close",
    async ({ matchingOpenOrdinal, expectedCode, expectedDatabaseCreates }) => {
      const harness = fixture();
      const closeFailure = failMatchingFileHandleClose(
        harness.baseRestoreReceiptFile,
        matchingOpenOrdinal,
      );
      const createDatabase = vi.fn(() => fakeDatabase(harness.state));
      await expect(replayPostgresAccountDeletionTombstones(
        harness.options("snapshot-close-receipt.json"),
        { ...harness.dependencies, createDatabase },
      )).rejects.toEqual(expect.objectContaining({ code: expectedCode }));
      expect(createDatabase).toHaveBeenCalledTimes(expectedDatabaseCreates);
      expect(closeFailure.closeCallCount()).toBe(1);
      expect(closeFailure.openedFileDescriptors).toHaveLength(1);
      expect(() => fs.fstatSync(closeFailure.openedFileDescriptors[0]!)).toThrow();
    },
  );

  it("retains an unauthorized receipt when its file descriptor cannot close", async () => {
    const harness = fixture();
    const receiptFile = harness.options("receipt-close-failed.json").receiptFile;
    const closeFailure = failMatchingFileHandleClose(receiptFile, 1);
    await expect(replayPostgresAccountDeletionTombstones(
      harness.options("receipt-close-failed.json"),
      harness.dependencies,
    )).rejects.toEqual(expect.objectContaining({
      code: "receipt_failed_target_disposal_required",
    }));
    expect(closeFailure.closeCallCount()).toBe(1);
    expect(closeFailure.openedFileDescriptors).toHaveLength(1);
    expect(() => fs.fstatSync(closeFailure.openedFileDescriptors[0]!)).toThrow();
    expect(JSON.parse(fs.readFileSync(receiptFile, "utf8"))).toMatchObject({
      kind: "pintpath-postgres-account-deletion-tombstone-replay",
      status: "verified",
    });
  });

  it.each(["sync", "close"] as const)(
    "retains an unauthorized receipt when parent-directory %s fails",
    async (operation) => {
      const harness = fixture();
      const receiptFile = harness.options(`parent-${operation}-failed.json`).receiptFile;
      const failure = failReceiptParentOperation(harness.evidenceDirectory, operation);
      await expect(replayPostgresAccountDeletionTombstones(
        harness.options(`parent-${operation}-failed.json`),
        harness.dependencies,
      )).rejects.toEqual(expect.objectContaining({
        code: "receipt_failed_target_disposal_required",
      }));
      expect(failure.operationCallCount()).toBe(1);
      expect(failure.openedFileDescriptors).toHaveLength(1);
      expect(() => fs.fstatSync(failure.openedFileDescriptors[0]!)).toThrow();
      expect(JSON.parse(fs.readFileSync(receiptFile, "utf8"))).toMatchObject({
        kind: "pintpath-postgres-account-deletion-tombstone-replay",
        status: "verified",
      });
    },
  );

  it("exposes a strict, confirmed, operator-guarded CLI with secret-free failures", async () => {
    const harness = fixture();
    const argv = [
      "--runtime-url-file", harness.runtimeUrlFile,
      "--runtime-root-ca-file", harness.runtimeUrlFile,
      "--expected-runtime-root-ca-der-sha256", "a".repeat(64),
      "--base-restore-receipt", harness.baseRestoreReceiptFile,
      "--expected-base-restore-receipt-sha256", harness.baseRestoreReceiptSha256,
      "--deletion-ledger-authority-directory", harness.authority.directory,
      "--expected-target-identity-sha256", TARGET_IDENTITY_SHA256,
      "--expected-ledger-current-sha256", harness.authority.currentSha256,
      "--expected-ledger-genesis-sha256", harness.authority.genesisSha256,
      "--expected-ledger-checkpoint-sha256", harness.authority.checkpointSha256,
      "--expected-ledger-immutable-set-sha256", harness.authority.immutableSetSha256,
      "--expected-tombstone-count", "1",
      "--receipt", path.join(harness.evidenceDirectory, "cli-receipt.json"),
    ];
    const replay = vi.fn(async () => ({
      schemaVersion: 1 as const,
      ok: true as const,
      receiptSha256: "1".repeat(64),
      targetIdentitySha256: TARGET_IDENTITY_SHA256,
      ledgerCurrentSha256: harness.authority.currentSha256,
      ledgerTombstoneCount: 1,
      seen: 1,
      newlyApplied: 1,
      alreadyApplied: 0,
      missing: 0,
      failed: 0,
      semanticProjectionSha256: "2".repeat(64),
    }));
    const outputs: string[] = [];
    expect(await runPostgresAccountDeletionReplayCli(argv, {
      [POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_ENV]:
        POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE,
    }, {
      replay,
      assertMutationAllowed: vi.fn(),
      writeOutput: (value) => outputs.push(value),
    })).toBe(0);
    expect(replay).toHaveBeenCalledWith(expect.objectContaining({
      expectedBaseRestoreReceiptSha256: harness.baseRestoreReceiptSha256,
      expectedTombstoneCount: 1,
      confirmation: POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE,
    }));
    expect(JSON.parse(outputs[0]!)).toMatchObject({ ok: true, newlyApplied: 1 });

    outputs.length = 0;
    expect(await runPostgresAccountDeletionReplayCli(argv, {}, {
      replay,
      assertMutationAllowed: vi.fn(),
      writeOutput: (value) => outputs.push(value),
    })).toBe(1);
    expect(JSON.parse(outputs[0]!)).toEqual({
      failureCode: "confirmation_required",
      ok: false,
      schemaVersion: 1,
      targetDisposalRequired: false,
    });
    expect(outputs[0]).not.toContain("private-password");
  });

  it("requires disposal when the successful receipt digest cannot be published", async () => {
    const harness = fixture();
    const argv = [
      "--runtime-url-file", harness.runtimeUrlFile,
      "--runtime-root-ca-file", harness.runtimeUrlFile,
      "--expected-runtime-root-ca-der-sha256", "a".repeat(64),
      "--base-restore-receipt", harness.baseRestoreReceiptFile,
      "--expected-base-restore-receipt-sha256", harness.baseRestoreReceiptSha256,
      "--deletion-ledger-authority-directory", harness.authority.directory,
      "--expected-target-identity-sha256", TARGET_IDENTITY_SHA256,
      "--expected-ledger-current-sha256", harness.authority.currentSha256,
      "--expected-ledger-genesis-sha256", harness.authority.genesisSha256,
      "--expected-ledger-checkpoint-sha256", harness.authority.checkpointSha256,
      "--expected-ledger-immutable-set-sha256", harness.authority.immutableSetSha256,
      "--expected-tombstone-count", "1",
      "--receipt", path.join(harness.evidenceDirectory, "cli-output-failed.json"),
    ];
    const outputs: string[] = [];
    let outputCalls = 0;
    const exit = await runPostgresAccountDeletionReplayCli(argv, {
      [POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_ENV]:
        POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE,
    }, {
      replay: async () => ({
        schemaVersion: 1,
        ok: true,
        receiptSha256: "1".repeat(64),
        targetIdentitySha256: TARGET_IDENTITY_SHA256,
        ledgerCurrentSha256: harness.authority.currentSha256,
        ledgerTombstoneCount: 1,
        seen: 1,
        newlyApplied: 1,
        alreadyApplied: 0,
        missing: 0,
        failed: 0,
        semanticProjectionSha256: "2".repeat(64),
      }),
      assertMutationAllowed: () => undefined,
      writeOutput: (value) => {
        outputCalls += 1;
        if (outputCalls === 1) throw new Error("simulated output failure");
        outputs.push(value);
      },
    });
    expect(exit).toBe(1);
    expect(outputCalls).toBe(2);
    expect(JSON.parse(outputs[0]!)).toEqual({
      failureCode: "receipt_failed_target_disposal_required",
      ok: false,
      schemaVersion: 1,
      targetDisposalRequired: true,
    });
  });

  it.each([
    ["missing", undefined],
    ["uppercase", "A".repeat(64)],
  ] as const)("the CLI rejects a %s base receipt pin before replay", async (_case, pin) => {
    const harness = fixture();
    const argv = [
      "--runtime-url-file", harness.runtimeUrlFile,
      "--runtime-root-ca-file", harness.runtimeUrlFile,
      "--expected-runtime-root-ca-der-sha256", "a".repeat(64),
      "--base-restore-receipt", harness.baseRestoreReceiptFile,
      ...(pin === undefined
        ? []
        : ["--expected-base-restore-receipt-sha256", pin]),
      "--deletion-ledger-authority-directory", harness.authority.directory,
      "--expected-target-identity-sha256", TARGET_IDENTITY_SHA256,
      "--expected-ledger-current-sha256", harness.authority.currentSha256,
      "--expected-ledger-genesis-sha256", harness.authority.genesisSha256,
      "--expected-ledger-checkpoint-sha256", harness.authority.checkpointSha256,
      "--expected-ledger-immutable-set-sha256", harness.authority.immutableSetSha256,
      "--expected-tombstone-count", "1",
      "--receipt", path.join(harness.evidenceDirectory, "cli-invalid-receipt.json"),
    ];
    const replay = vi.fn();
    const outputs: string[] = [];
    expect(await runPostgresAccountDeletionReplayCli(argv, {
      [POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_ENV]:
        POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE,
    }, {
      replay,
      assertMutationAllowed: vi.fn(),
      writeOutput: (value) => outputs.push(value),
    })).toBe(1);
    expect(replay).not.toHaveBeenCalled();
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      ok: false,
      failureCode: "invalid_arguments",
      targetDisposalRequired: false,
    });
  });

  it("the CLI rejects a wrong lowercase base receipt pin without connecting", async () => {
    const harness = fixture();
    const createDatabase = vi.fn(() => fakeDatabase(harness.state));
    const outputs: string[] = [];
    expect(await runPostgresAccountDeletionReplayCli([
      "--runtime-url-file", harness.runtimeUrlFile,
      "--runtime-root-ca-file", harness.runtimeUrlFile,
      "--expected-runtime-root-ca-der-sha256", "a".repeat(64),
      "--base-restore-receipt", harness.baseRestoreReceiptFile,
      "--expected-base-restore-receipt-sha256", "0".repeat(64),
      "--deletion-ledger-authority-directory", harness.authority.directory,
      "--expected-target-identity-sha256", TARGET_IDENTITY_SHA256,
      "--expected-ledger-current-sha256", harness.authority.currentSha256,
      "--expected-ledger-genesis-sha256", harness.authority.genesisSha256,
      "--expected-ledger-checkpoint-sha256", harness.authority.checkpointSha256,
      "--expected-ledger-immutable-set-sha256", harness.authority.immutableSetSha256,
      "--expected-tombstone-count", "1",
      "--receipt", path.join(harness.evidenceDirectory, "cli-wrong-receipt.json"),
    ], {
      [POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_ENV]:
        POSTGRES_ACCOUNT_DELETION_REPLAY_CONFIRMATION_VALUE,
    }, {
      replay: (options) => replayPostgresAccountDeletionTombstones(options, {
        ...harness.dependencies,
        createDatabase,
      }),
      assertMutationAllowed: vi.fn(),
      writeOutput: (value) => outputs.push(value),
    })).toBe(1);
    expect(createDatabase).not.toHaveBeenCalled();
    expect(harness.state.beginCalls).toBe(0);
    expect(JSON.parse(outputs[0]!)).toMatchObject({
      ok: false,
      failureCode: "base_restore_receipt_invalid",
      targetDisposalRequired: false,
    });
  });

  it("uses stable error messages without interpolating sensitive values", () => {
    const error = new PostgresAccountDeletionReplayError("authority_tampered");
    expect(error.message).toBe("authority_tampered");
    expect(error.message).not.toContain(TOMBSTONE.userId);
  });
});
