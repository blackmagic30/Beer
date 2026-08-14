import path from "node:path";
import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  POSTGRES_LOGICAL_OFFSITE_CONFIRMATION_ENV,
  POSTGRES_LOGICAL_OFFSITE_CONFIRMATION_VALUE,
  runPostgresLogicalOffsiteCli,
  type PostgresLogicalOffsiteCliDependencies,
} from "../scripts/attest-postgres-logical-backup-offsite.js";
import type { SqlDatabase } from "../src/db/sql-database.js";
import {
  PostgresLogicalOffsiteError,
  type PostgresLogicalOffsiteResult,
  type PostgresLogicalOffsiteStorage,
} from "../src/lib/postgres-logical-offsite.js";
import {
  checkPostgresRailwayStockLocalhostServerIdentity,
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  PostgresRailwayStockLocalhostCaError,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";

const ROOT = "/private/operator/logical-offsite";
const BACKUP_DIRECTORY = path.join(ROOT, "backup");
const DATABASE_URL_FILE = path.join(ROOT, "runtime-database-url");
const RUNTIME_ROOT_CA_FILE = path.join(ROOT, "production-runtime-root-ca.pem");
const SERVICE_ROLE_FILE = path.join(ROOT, "offsite-service-role-key");
const DATABASE_SECRET = "runtime-database-secret";
const SERVICE_ROLE_SECRET = `sb_secret_${"s".repeat(32)}`;
const RUNTIME_HOST = "postgres-production.railway.internal";
const RUNTIME_ADDRESS = "fd12:3456:789a::10";
const DATABASE_URL = `postgresql://runtime:${DATABASE_SECRET}@${RUNTIME_HOST}:5432/pintpath?sslmode=verify-full`;
const RUNTIME_CONNECTION_URL_SHA256 = crypto
  .createHash("sha256").update(DATABASE_URL, "utf8").digest("hex");
const SOURCE_URL = "https://auth.pintpath.au";
const DESTINATION_URL = "https://hfbmhdxrwtihukmixxta.supabase.co";
const HASH = "a".repeat(64);
const RUNTIME_ROOT_CA_DER_SHA256 = "b".repeat(64);
const DESTINATION_ORIGIN_SHA256 = crypto
  .createHash("sha256").update(DESTINATION_URL).digest("hex");
const BUCKET_NAME_SHA256 = crypto
  .createHash("sha256").update("pintpath-backups").digest("hex");

const ARGV = [
  "--backup-directory", BACKUP_DIRECTORY,
  "--backup-manifest-sha256", HASH,
  "--expected-bucket-name-sha256", BUCKET_NAME_SHA256,
  "--expected-destination-origin-sha256", DESTINATION_ORIGIN_SHA256,
  "--expected-runtime-root-ca-der-sha256", RUNTIME_ROOT_CA_DER_SHA256,
  "--operator-id", "operator-reference-01",
  "--runtime-database-url-file", DATABASE_URL_FILE,
  "--runtime-root-ca-file", RUNTIME_ROOT_CA_FILE,
  "--service-role-key-file", SERVICE_ROLE_FILE,
] as const;

const RESULT: PostgresLogicalOffsiteResult = {
  schemaVersion: 1,
  ok: true,
  backupCreatedAt: "2026-08-09T01:00:00.000Z",
  completedAt: "2026-08-09T02:00:00.000Z",
  archiveSha256: "1".repeat(64),
  manifestSha256: "2".repeat(64),
  stateReceiptSha256: "3".repeat(64),
  overallStateSha256: "4".repeat(64),
  sourceDatabaseIdentitySha256: "9".repeat(64),
  remoteObjectSetSha256: "5".repeat(64),
  attestationSha256: "6".repeat(64),
  latestPointerSha256: "7".repeat(64),
  backupIdSha256: "8".repeat(64),
  successStateSha256: "a".repeat(64),
};

function harness(input: {
  readonly confirmed?: boolean;
  readonly runtimeReady?: boolean;
  readonly closeFails?: boolean;
  readonly attestError?: Error;
  readonly serviceRoleSecret?: string;
  readonly runtimeUrl?: string;
  readonly runtimeTransportOpenError?: Error;
  readonly runtimeTransportAssertFailureAt?: number;
  readonly runtimeTransportCloseFails?: boolean;
} = {}) {
  const output: string[] = [];
  const events: string[] = [];
  const storage = {} as PostgresLogicalOffsiteStorage;
  const database = {
    close: vi.fn(async () => {
      events.push("close");
      if (input.closeFails) throw new Error(`close failed ${DATABASE_SECRET}`);
    }),
  } as unknown as SqlDatabase;
  const nodeConnection = {
    host: RUNTIME_ADDRESS,
    port: 5_432 as const,
    ssl: {
      ca: "TEST_RUNTIME_ROOT_CA",
      servername: "localhost" as const,
      rejectUnauthorized: true as const,
      minVersion: "TLSv1.2" as const,
      checkServerIdentity: checkPostgresRailwayStockLocalhostServerIdentity,
    },
  };
  let runtimeTransportAssertCalls = 0;
  const runtimeTransport = {
    profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    rootCaDerSha256: RUNTIME_ROOT_CA_DER_SHA256,
    sourceUrlAuthority: { hostname: RUNTIME_HOST, port: 5_432 },
    resolvedAddress: RUNTIME_ADDRESS,
    temporaryDirectory: path.join(ROOT, "held-transport"),
    passwordFileDirectory: path.join(ROOT, "held-transport"),
    passwordFileHost: "localhost" as const,
    nodeConnection,
    libpqEnvironment: {
      PGHOST: "localhost" as const,
      PGHOSTADDR: RUNTIME_ADDRESS,
      PGPORT: "5432" as const,
      PGSSLMODE: "verify-full" as const,
      PGSSLROOTCERT: path.join(ROOT, "held-transport", "root-ca.pem"),
      PGSSLMINPROTOCOLVERSION: "TLSv1.2" as const,
      PGSSLSNI: "1" as const,
    },
    assertExact: vi.fn(async () => {
      runtimeTransportAssertCalls += 1;
      if (input.runtimeTransportAssertFailureAt === runtimeTransportAssertCalls) {
        throw new PostgresRailwayStockLocalhostCaError("transport_drift");
      }
    }),
    close: vi.fn(async () => {
      if (input.runtimeTransportCloseFails) throw new Error("transport close failed");
    }),
  } satisfies PostgresRailwayStockLocalhostCaTransport;
  const dependencies: Partial<PostgresLogicalOffsiteCliDependencies> = {
    env: {
      [POSTGRES_LOGICAL_OFFSITE_CONFIRMATION_ENV]: input.confirmed === false
        ? undefined
        : POSTGRES_LOGICAL_OFFSITE_CONFIRMATION_VALUE,
      SUPABASE_URL: SOURCE_URL,
      OFFSITE_BACKUP_SUPABASE_URL: DESTINATION_URL,
      OFFSITE_BACKUP_BUCKET: "pintpath-backups",
    },
    assertMutationAllowed: vi.fn(() => events.push("guard")),
    readSecretFile: vi.fn(async (filename: string) => {
      events.push(`secret:${path.basename(filename)}`);
      return filename === DATABASE_URL_FILE
        ? input.runtimeUrl ?? DATABASE_URL
        : input.serviceRoleSecret ?? SERVICE_ROLE_SECRET;
    }),
    getUid: () => 501,
    openRuntimeTransport: vi.fn(async (options) => {
      expect(options).toEqual({
        profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
        rootCaFile: RUNTIME_ROOT_CA_FILE,
        expectedRootCaDerSha256: RUNTIME_ROOT_CA_DER_SHA256,
        expectedUid: 501,
        sourceUrlAuthority: { hostname: RUNTIME_HOST, port: 5_432 },
      });
      if (input.runtimeTransportOpenError) throw input.runtimeTransportOpenError;
      return runtimeTransport;
    }),
    createDatabase: vi.fn((options) => {
      events.push("database");
      expect(options.connectionString).toContain("uselibpqcompat=true");
      expect(options.activeRole).toBe("pintpath_runtime");
      expect(options.sslRootCertificatePath).toBeUndefined();
      expect(options.railwayStockLocalhostCaConnection).toBe(nodeConnection);
      return database;
    }),
    checkRuntime: vi.fn(async () => {
      events.push("runtime-check");
      return { ready: input.runtimeReady !== false } as never;
    }),
    inspectRuntimeIdentity: vi.fn(async () => {
      events.push("runtime-identity");
      return "9".repeat(64);
    }),
    createStorage: vi.fn((options) => {
      events.push("storage");
      expect(options).toEqual({
        destinationSupabaseUrl: DESTINATION_URL,
        destinationServiceRoleKey: SERVICE_ROLE_SECRET,
      });
      return storage;
    }),
    attest: vi.fn(async (options) => {
      events.push("attest");
      expect(options).toMatchObject({
        backupDirectory: BACKUP_DIRECTORY,
        expectedManifestSha256: HASH,
        runtimeDatabaseIdentitySha256: "9".repeat(64),
        runtimeConnectionUrlSha256: RUNTIME_CONNECTION_URL_SHA256,
        sourceSupabaseUrl: SOURCE_URL,
        destinationSupabaseUrl: DESTINATION_URL,
        expectedDestinationOriginSha256: DESTINATION_ORIGIN_SHA256,
        bucketName: "pintpath-backups",
        expectedBucketNameSha256: BUCKET_NAME_SHA256,
        operatorId: "operator-reference-01",
        storage,
      });
      if (input.attestError) throw input.attestError;
      return RESULT;
    }),
    writeOutput: (value) => output.push(value),
  };
  return { dependencies, events, output, database, runtimeTransport };
}

describe("Postgres logical off-site attestation CLI", () => {
  it("guards the operator mutation, verifies canonical runtime, and emits hash-only JSON", async () => {
    const fixture = harness();

    await expect(runPostgresLogicalOffsiteCli(ARGV, fixture.dependencies)).resolves.toBe(0);

    expect(fixture.events).toEqual([
      "guard",
      "secret:runtime-database-url",
      "secret:offsite-service-role-key",
      "database",
      "runtime-check",
      "runtime-identity",
      "storage",
      "attest",
      "close",
    ]);
    expect(fixture.output).toHaveLength(1);
    expect(fixture.runtimeTransport.assertExact).toHaveBeenCalledTimes(6);
    expect(fixture.runtimeTransport.close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fixture.output[0]!)).toEqual(RESULT);
    for (const forbidden of [
      DATABASE_SECRET,
      RUNTIME_CONNECTION_URL_SHA256,
      SERVICE_ROLE_SECRET,
      DATABASE_URL,
      SOURCE_URL,
      DESTINATION_URL,
      BACKUP_DIRECTORY,
      DATABASE_URL_FILE,
      SERVICE_ROLE_FILE,
      RUNTIME_ROOT_CA_FILE,
      RUNTIME_ADDRESS,
      "operator-reference-01",
      "pintpath-backups",
    ]) expect(fixture.output[0]).not.toContain(forbidden);
  });

  it("requires verify-full and the exact pinned runtime CA before database use", async () => {
    const weakTls = harness({
      runtimeUrl: `postgresql://runtime:${DATABASE_SECRET}@${RUNTIME_HOST}:5432/pintpath?sslmode=require`,
    });
    await expect(runPostgresLogicalOffsiteCli(ARGV, weakTls.dependencies))
      .resolves.toBe(1);
    expect(JSON.parse(weakTls.output[0]!)).toMatchObject({
      failureCode: "configuration_missing_or_unsafe",
    });
    expect(weakTls.dependencies.createDatabase).not.toHaveBeenCalled();
    expect(weakTls.dependencies.openRuntimeTransport).not.toHaveBeenCalled();
    expect(weakTls.runtimeTransport.close).not.toHaveBeenCalled();

    const wrongPin = harness({
      runtimeTransportOpenError: new PostgresRailwayStockLocalhostCaError(
        "root_ca_pin_mismatch",
      ),
    });
    await expect(runPostgresLogicalOffsiteCli(ARGV, wrongPin.dependencies))
      .resolves.toBe(1);
    expect(JSON.parse(wrongPin.output[0]!)).toMatchObject({
      failureCode: "runtime_root_ca_pin_mismatch",
    });
    expect(wrongPin.dependencies.createDatabase).not.toHaveBeenCalled();
  });

  it.each([
    `postgresql://runtime:${DATABASE_SECRET}@db.example.test:5432/pintpath?sslmode=verify-full`,
    `postgresql://runtime:${DATABASE_SECRET}@${RUNTIME_HOST}:5433/pintpath?sslmode=verify-full`,
  ])("rejects a runtime URL outside the exact Railway private authority: %s", async (runtimeUrl) => {
    const fixture = harness({ runtimeUrl });
    await expect(runPostgresLogicalOffsiteCli(ARGV, fixture.dependencies))
      .resolves.toBe(1);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      failureCode: "configuration_missing_or_unsafe",
    });
    expect(fixture.dependencies.openRuntimeTransport).not.toHaveBeenCalled();
    expect(fixture.dependencies.createDatabase).not.toHaveBeenCalled();
  });

  it("fails closed when the pinned runtime transport drifts between database phases", async () => {
    const fixture = harness({ runtimeTransportAssertFailureAt: 3 });
    await expect(runPostgresLogicalOffsiteCli(ARGV, fixture.dependencies))
      .resolves.toBe(1);
    expect(JSON.parse(fixture.output[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      failureCode: "runtime_root_ca_drift",
    });
    expect(fixture.dependencies.inspectRuntimeIdentity).not.toHaveBeenCalled();
    expect(fixture.runtimeTransport.close).toHaveBeenCalledTimes(1);
  });

  it("requires explicit confirmation before reading secrets or constructing providers", async () => {
    const fixture = harness({ confirmed: false });

    await expect(runPostgresLogicalOffsiteCli(ARGV, fixture.dependencies)).resolves.toBe(1);

    expect(fixture.events).toEqual([]);
    expect(JSON.parse(fixture.output[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      failureCode: "confirmation_required",
    });
  });

  it("stops before Storage mutation when canonical runtime readiness is not green", async () => {
    const fixture = harness({ runtimeReady: false });

    await expect(runPostgresLogicalOffsiteCli(ARGV, fixture.dependencies)).resolves.toBe(1);

    expect(fixture.events).toEqual([
      "guard",
      "secret:runtime-database-url",
      "secret:offsite-service-role-key",
      "database",
      "runtime-check",
      "close",
    ]);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      ok: false,
      failureCode: "runtime_not_ready",
    });
  });

  it("maps stable authority failures and never serializes raw error text", async () => {
    const fixture = harness({
      attestError: new PostgresLogicalOffsiteError("object_verification_failed"),
    });
    await expect(runPostgresLogicalOffsiteCli(ARGV, fixture.dependencies)).resolves.toBe(1);
    expect(JSON.parse(fixture.output[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      failureCode: "object_verification_failed",
    });
    expect(fixture.output[0]).not.toContain(DATABASE_SECRET);
  });

  it("fails the command if the runtime pool cannot close after attestation", async () => {
    const fixture = harness({ closeFails: true });
    await expect(runPostgresLogicalOffsiteCli(ARGV, fixture.dependencies)).resolves.toBe(1);
    expect(JSON.parse(fixture.output[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      failureCode: "runtime_close_failed",
    });
    expect(fixture.output[0]).not.toContain(DATABASE_SECRET);
  });

  it("rejects relative secret paths and restore-rehearsal mutation containment", async () => {
    const unsafe = harness();
    const unsafeArgv = [...ARGV];
    unsafeArgv[unsafeArgv.indexOf(DATABASE_URL_FILE)] = "relative/database-url";
    await expect(runPostgresLogicalOffsiteCli(unsafeArgv, unsafe.dependencies)).resolves.toBe(1);
    expect(JSON.parse(unsafe.output[0]!)).toMatchObject({
      failureCode: "configuration_missing_or_unsafe",
    });
    expect(unsafe.events).toEqual(["guard"]);

    const contained = harness();
    contained.dependencies.assertMutationAllowed = () => {
      throw new Error("restore rehearsal is contained");
    };
    await expect(runPostgresLogicalOffsiteCli(ARGV, contained.dependencies)).resolves.toBe(1);
    expect(JSON.parse(contained.output[0]!)).toMatchObject({
      failureCode: "operator_guard_rejected",
    });
    expect(contained.events).toEqual([]);
  });

  it("does not accept a caller-matched digest as destination authority", async () => {
    const fixture = harness();
    const attackerOrigin = "https://attacker.invalid";
    const dependencies = {
      ...fixture.dependencies.env,
    };
    const attackerDependencies = {
      ...fixture.dependencies,
      env: {
        ...dependencies,
        OFFSITE_BACKUP_SUPABASE_URL: attackerOrigin,
      },
    };
    const argv = [...ARGV];
    argv[argv.indexOf(DESTINATION_ORIGIN_SHA256)] = crypto
      .createHash("sha256")
      .update(attackerOrigin)
      .digest("hex");

    await expect(runPostgresLogicalOffsiteCli(argv, attackerDependencies))
      .resolves.toBe(1);
    expect(fixture.events).toEqual(["guard"]);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      failureCode: "configuration_missing_or_unsafe",
    });
  });

  it.each(["other-private-bucket", " pintpath-backups", "pintpath-backups "])(
    "rejects an unreviewed offsite bucket before reading credentials: %s",
    async (bucketName) => {
      const fixture = harness();
      const dependencies = {
        ...fixture.dependencies,
        env: { ...fixture.dependencies.env, OFFSITE_BACKUP_BUCKET: bucketName },
      };
      await expect(runPostgresLogicalOffsiteCli(ARGV, dependencies))
        .resolves.toBe(1);
      expect(fixture.events).toEqual(["guard"]);
      expect(JSON.parse(fixture.output[0]!)).toMatchObject({
        failureCode: "configuration_missing_or_unsafe",
      });
    },
  );

  it.each([
    `sb_publishable_${"p".repeat(32)}`,
    `${SERVICE_ROLE_SECRET}\n`,
    "arbitrary-service-role-value",
  ])("rejects an unsafe offsite server key before Storage construction", async (key) => {
    const fixture = harness({ serviceRoleSecret: key });
    await expect(runPostgresLogicalOffsiteCli(ARGV, fixture.dependencies))
      .resolves.toBe(1);
    expect(fixture.events).toEqual([
      "guard",
      "secret:runtime-database-url",
      "secret:offsite-service-role-key",
    ]);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      failureCode: "secret_file_unsafe",
    });
    expect(fixture.output[0]).not.toContain(key);
  });
});
