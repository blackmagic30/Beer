import crypto from "node:crypto";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  runPostgresLogicalOffsiteRetrievalCli,
  type PostgresLogicalOffsiteRetrievalCliDependencies,
} from "../scripts/retrieve-postgres-logical-offsite.js";
import type { SqlDatabase } from "../src/db/sql-database.js";
import {
  createSupabasePostgresLogicalOffsiteRetrievalStorage,
  postgresLogicalOffsiteRetrievalInternals,
  PostgresLogicalOffsiteRetrievalError,
  type PostgresLogicalOffsiteRetrievalResult,
  type PostgresLogicalOffsiteRetrievalStateAuthority,
  type PostgresLogicalOffsiteRetrievalStorage,
} from "../src/lib/postgres-logical-offsite-retrieval.js";
import {
  checkPostgresRailwayStockLocalhostServerIdentity,
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  PostgresRailwayStockLocalhostCaError,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";

const ROOT = "/private/operator/postgres-logical-retrieval";
const OUTPUT_DIRECTORY = path.join(ROOT, "retrieved-backup");
const DATABASE_URL_FILE = path.join(ROOT, "runtime-database-url");
const RUNTIME_ROOT_CA_FILE = path.join(ROOT, "production-runtime-root-ca.pem");
const SERVICE_ROLE_FILE = path.join(ROOT, "offsite-service-role-key");
const DATABASE_SECRET = "runtime-database-secret";
const SERVICE_ROLE_SECRET = `sb_secret_${"s".repeat(32)}`;
const RUNTIME_HOST = "postgres-production.railway.internal";
const RUNTIME_ADDRESS = "fd12:3456:789a::10";
const DATABASE_URL = `postgresql://runtime:${DATABASE_SECRET}@${RUNTIME_HOST}:5432/pintpath?sslmode=verify-full`;
const SOURCE_URL = "https://auth.pintpath.au";
const DESTINATION_URL = "https://hfbmhdxrwtihukmixxta.supabase.co";
const BUCKET = "pintpath-backups";
const HASH = "a".repeat(64);
const RUNTIME_ROOT_CA_DER_SHA256 = "b".repeat(64);
const DESTINATION_ORIGIN_SHA256 = crypto
  .createHash("sha256").update(DESTINATION_URL).digest("hex");
const BUCKET_NAME_SHA256 = crypto.createHash("sha256").update(BUCKET).digest("hex");

const ARGV = [
  "--expected-bucket-name-sha256", BUCKET_NAME_SHA256,
  "--expected-destination-origin-sha256", DESTINATION_ORIGIN_SHA256,
  "--expected-runtime-root-ca-der-sha256", RUNTIME_ROOT_CA_DER_SHA256,
  "--expected-success-state-sha256", HASH,
  "--output-directory", OUTPUT_DIRECTORY,
  "--runtime-database-url-file", DATABASE_URL_FILE,
  "--runtime-root-ca-file", RUNTIME_ROOT_CA_FILE,
  "--service-role-key-file", SERVICE_ROLE_FILE,
] as const;

const RESULT: PostgresLogicalOffsiteRetrievalResult = {
  schemaVersion: 1,
  kind: "pintpath-postgres-logical-offsite-retrieval",
  ok: true,
  retrievedAt: "2026-08-09T03:00:00.000Z",
  successStateSha256: HASH,
  backupCreatedAt: "2026-08-09T01:00:00.000Z",
  backupIdSha256: "1".repeat(64),
  latestPointerSha256: "2".repeat(64),
  attestationSha256: "3".repeat(64),
  remoteObjectSetSha256: "4".repeat(64),
  archiveSha256: "5".repeat(64),
  manifestSha256: "6".repeat(64),
  stateReceiptSha256: "7".repeat(64),
  sourceDatabaseIdentitySha256: "8".repeat(64),
  overallStateSha256: "9".repeat(64),
  archiveBytes: 100,
  manifestBytes: 200,
  stateReceiptBytes: 300,
  localArtifactSetSha256: "b".repeat(64),
};

function cliHarness(input: {
  readonly runtimeReady?: boolean;
  readonly closeFails?: boolean;
  readonly retrieveError?: Error;
  readonly serviceRoleSecret?: string;
  readonly runtimeUrl?: string;
  readonly runtimeTransportOpenError?: Error;
  readonly runtimeTransportAssertFailureAt?: number;
  readonly runtimeTransportCloseFails?: boolean;
} = {}) {
  const events: string[] = [];
  const output: string[] = [];
  const state = {} as PostgresLogicalOffsiteRetrievalStateAuthority;
  const storage = {} as PostgresLogicalOffsiteRetrievalStorage;
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
  const dependencies: Partial<PostgresLogicalOffsiteRetrievalCliDependencies> = {
    env: {
      SUPABASE_URL: SOURCE_URL,
      OFFSITE_BACKUP_SUPABASE_URL: DESTINATION_URL,
      OFFSITE_BACKUP_BUCKET: BUCKET,
    },
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
      return "8".repeat(64);
    }),
    createStateAuthority: vi.fn(() => {
      events.push("state");
      return state;
    }),
    createStorage: vi.fn((options) => {
      events.push("storage");
      expect(options).toEqual({
        destinationSupabaseUrl: DESTINATION_URL,
        destinationServiceRoleKey: SERVICE_ROLE_SECRET,
        bucketName: BUCKET,
      });
      return storage;
    }),
    retrieve: vi.fn(async (options) => {
      events.push("retrieve");
      expect(options).toMatchObject({
        outputDirectory: OUTPUT_DIRECTORY,
        expectedSuccessStateSha256: HASH,
        runtimeDatabaseIdentitySha256: "8".repeat(64),
        sourceSupabaseUrl: SOURCE_URL,
        destinationSupabaseUrl: DESTINATION_URL,
        expectedDestinationOriginSha256: DESTINATION_ORIGIN_SHA256,
        bucketName: BUCKET,
        expectedBucketNameSha256: BUCKET_NAME_SHA256,
        state,
        storage,
      });
      if (input.retrieveError) throw input.retrieveError;
      return RESULT;
    }),
    writeOutput: (value) => output.push(value),
  };
  return { dependencies, events, output, runtimeTransport };
}

describe("Postgres logical operational-copy retrieval boundaries", () => {
  it.each([
    ["unreviewed destination origin", {
      destinationSupabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
      destinationServiceRoleKey: SERVICE_ROLE_SECRET,
      bucketName: BUCKET,
    }],
    ["publishable key in the server slot", {
      destinationSupabaseUrl: DESTINATION_URL,
      destinationServiceRoleKey: `sb_publishable_${"p".repeat(32)}`,
      bucketName: BUCKET,
    }],
    ["alternate bucket", {
      destinationSupabaseUrl: DESTINATION_URL,
      destinationServiceRoleKey: SERVICE_ROLE_SECRET,
      bucketName: "private-ledger",
    }],
  ])("rejects %s before constructing any client or request", (_label, input) => {
    const fetchImplementation = vi.fn() as unknown as typeof globalThis.fetch;
    const clientFactory = vi.fn(() => ({ storage: {} } as unknown as SupabaseClient));

    expect(() => createSupabasePostgresLogicalOffsiteRetrievalStorage({
      ...input,
      fetchImplementation,
      clientFactory,
    })).toThrow(expect.objectContaining({ code: "destination_unsafe" }));
    expect(clientFactory).not.toHaveBeenCalled();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("allows only exact GETs for v2 immutable backup artifacts", async () => {
    const backupId = `20260809T010000000Z-${"a".repeat(64)}`;
    const objectPath = `_control/postgres-logical-backups/v2/backups/${backupId}/pintpath-postgres.dump`;
    const seen: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const scoped = postgresLogicalOffsiteRetrievalInternals.createReadOnlyArtifactFetch({
      destinationOrigin: DESTINATION_URL,
      bucketName: BUCKET,
      fetchImplementation: async (input, init) => {
        seen.push({
          url: typeof input === "string" ? input : input.toString(),
          ...(init?.redirect ? { redirect: init.redirect } : {}),
        });
        return new Response("archive", { status: 200 });
      },
    });
    const url = `${DESTINATION_URL}/storage/v1/object/${BUCKET}/${objectPath}`;

    await expect(scoped(url, { method: "GET" })).resolves.toMatchObject({ status: 200 });
    expect(seen).toEqual([{ url, redirect: "error" }]);
    await expect(scoped(url, { method: "POST" })).rejects.toMatchObject({
      code: "destination_unsafe",
    });
    await expect(scoped(`${url}?token=leak`, { method: "GET" })).rejects.toMatchObject({
      code: "destination_unsafe",
    });
    await expect(scoped(
      `${DESTINATION_URL}/storage/v1/object/${BUCKET}/unrelated/private.txt`,
      { method: "GET" },
    )).rejects.toMatchObject({ code: "destination_unsafe" });
    await expect(scoped(
      `https://attacker.example.test/storage/v1/object/${BUCKET}/${objectPath}`,
      { method: "GET" },
    )).rejects.toMatchObject({ code: "destination_unsafe" });
    expect(seen).toHaveLength(1);
  });

  it("streams through the read-only Supabase client without retaining archive bytes", async () => {
    const backupId = `20260809T010000000Z-${"a".repeat(64)}`;
    const objectPath = `_control/postgres-logical-backups/v2/backups/${backupId}/pintpath-postgres.dump`;
    const payload = Buffer.from("streamed-operational-copy-archive");
    let scopedFetch: typeof globalThis.fetch | null = null;
    const storage = createSupabasePostgresLogicalOffsiteRetrievalStorage({
      destinationSupabaseUrl: DESTINATION_URL,
      destinationServiceRoleKey: SERVICE_ROLE_SECRET,
      bucketName: BUCKET,
      requestTimeoutMs: 5_000,
      streamTimeoutMs: 5_000,
      fetchImplementation: async () => new Response(payload, { status: 200 }),
      clientFactory: (_url, _key, fetchImplementation) => {
        scopedFetch = fetchImplementation;
        return {
          storage: {
            from: () => ({
              download: () => ({
                asStream: async () => {
                  const response = await fetchImplementation(
                    `${DESTINATION_URL}/storage/v1/object/${BUCKET}/${objectPath}`,
                    { method: "GET" },
                  );
                  return { data: response.body, error: null };
                },
              }),
            }),
          },
        } as unknown as SupabaseClient;
      },
    });
    const chunks: Buffer[] = [];

    const result = await storage.streamDownload({
      bucketName: BUCKET,
      objectPath,
      maximumBytes: payload.length,
      onChunk: async (chunk) => {
        chunks.push(chunk);
      },
    });

    expect(Buffer.concat(chunks)).toEqual(payload);
    expect(result).toEqual({
      bytes: payload.length,
      sha256: crypto.createHash("sha256").update(payload).digest("hex"),
    });
    expect(result.retainedBytes).toBeUndefined();
    expect(scopedFetch).not.toBeNull();
  });
});

describe("Postgres logical operational-copy retrieval CLI", () => {
  it("verifies the runtime authority and emits a hash-only success receipt", async () => {
    const fixture = cliHarness();

    await expect(runPostgresLogicalOffsiteRetrievalCli(ARGV, fixture.dependencies))
      .resolves.toBe(0);

    expect(fixture.events).toEqual([
      "secret:runtime-database-url",
      "secret:offsite-service-role-key",
      "database",
      "runtime-check",
      "runtime-identity",
      "state",
      "storage",
      "retrieve",
      "close",
    ]);
    expect(JSON.parse(fixture.output[0]!)).toEqual(RESULT);
    expect(fixture.runtimeTransport.assertExact).toHaveBeenCalledTimes(6);
    expect(fixture.runtimeTransport.close).toHaveBeenCalledTimes(1);
    for (const forbidden of [
      DATABASE_SECRET,
      SERVICE_ROLE_SECRET,
      DATABASE_URL,
      SOURCE_URL,
      DESTINATION_URL,
      BUCKET,
      OUTPUT_DIRECTORY,
      DATABASE_URL_FILE,
      SERVICE_ROLE_FILE,
      RUNTIME_ROOT_CA_FILE,
      RUNTIME_ADDRESS,
    ]) expect(fixture.output[0]).not.toContain(forbidden);
  });

  it("requires verify-full and the exact pinned runtime CA before database use", async () => {
    const weakTls = cliHarness({
      runtimeUrl: `postgresql://runtime:${DATABASE_SECRET}@${RUNTIME_HOST}:5432/pintpath?sslmode=require`,
    });
    await expect(runPostgresLogicalOffsiteRetrievalCli(ARGV, weakTls.dependencies))
      .resolves.toBe(1);
    expect(JSON.parse(weakTls.output[0]!)).toMatchObject({
      failureCode: "configuration_missing_or_unsafe",
    });
    expect(weakTls.dependencies.createDatabase).not.toHaveBeenCalled();
    expect(weakTls.dependencies.openRuntimeTransport).not.toHaveBeenCalled();
    expect(weakTls.runtimeTransport.close).not.toHaveBeenCalled();

    const wrongPin = cliHarness({
      runtimeTransportOpenError: new PostgresRailwayStockLocalhostCaError(
        "root_ca_pin_mismatch",
      ),
    });
    await expect(runPostgresLogicalOffsiteRetrievalCli(ARGV, wrongPin.dependencies))
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
    const fixture = cliHarness({ runtimeUrl });
    await expect(runPostgresLogicalOffsiteRetrievalCli(ARGV, fixture.dependencies))
      .resolves.toBe(1);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      failureCode: "configuration_missing_or_unsafe",
    });
    expect(fixture.dependencies.openRuntimeTransport).not.toHaveBeenCalled();
    expect(fixture.dependencies.createDatabase).not.toHaveBeenCalled();
  });

  it("fails closed when the pinned runtime transport drifts between database phases", async () => {
    const fixture = cliHarness({ runtimeTransportAssertFailureAt: 3 });
    await expect(runPostgresLogicalOffsiteRetrievalCli(ARGV, fixture.dependencies))
      .resolves.toBe(1);
    expect(JSON.parse(fixture.output[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      failureCode: "runtime_root_ca_drift",
    });
    expect(fixture.dependencies.inspectRuntimeIdentity).not.toHaveBeenCalled();
    expect(fixture.runtimeTransport.close).toHaveBeenCalledTimes(1);
  });

  it("stops before constructing Storage when the canonical runtime is not ready", async () => {
    const fixture = cliHarness({ runtimeReady: false });

    await expect(runPostgresLogicalOffsiteRetrievalCli(ARGV, fixture.dependencies))
      .resolves.toBe(1);

    expect(fixture.events).toEqual([
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

  it("maps retrieval failures and close failures without serializing raw errors", async () => {
    const rejected = cliHarness({
      retrieveError: new PostgresLogicalOffsiteRetrievalError(
        "object_verification_failed",
      ),
    });
    await expect(runPostgresLogicalOffsiteRetrievalCli(ARGV, rejected.dependencies))
      .resolves.toBe(1);
    expect(JSON.parse(rejected.output[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      failureCode: "object_verification_failed",
    });
    expect(rejected.output[0]).not.toContain(SERVICE_ROLE_SECRET);

    const closeFailure = cliHarness({ closeFails: true });
    await expect(runPostgresLogicalOffsiteRetrievalCli(ARGV, closeFailure.dependencies))
      .resolves.toBe(1);
    expect(JSON.parse(closeFailure.output[0]!)).toEqual({
      schemaVersion: 1,
      ok: false,
      failureCode: "runtime_close_failed",
    });
    expect(closeFailure.output[0]).not.toContain(DATABASE_SECRET);
  });

  it("rejects unsafe pins and relative paths before reading credential files", async () => {
    const wrongPin = cliHarness();
    const wrongPinArgv = [...ARGV];
    wrongPinArgv[wrongPinArgv.indexOf(DESTINATION_ORIGIN_SHA256)] = "0".repeat(64);
    await expect(runPostgresLogicalOffsiteRetrievalCli(wrongPinArgv, wrongPin.dependencies))
      .resolves.toBe(1);
    expect(JSON.parse(wrongPin.output[0]!)).toMatchObject({
      failureCode: "destination_unsafe",
    });
    expect(wrongPin.events).toEqual([]);

    const relative = cliHarness();
    const relativeArgv = [...ARGV];
    relativeArgv[relativeArgv.indexOf(OUTPUT_DIRECTORY)] = "relative/output";
    await expect(runPostgresLogicalOffsiteRetrievalCli(relativeArgv, relative.dependencies))
      .resolves.toBe(1);
    expect(JSON.parse(relative.output[0]!)).toMatchObject({
      failureCode: "configuration_missing_or_unsafe",
    });
    expect(relative.events).toEqual([]);
  });

  it("does not accept a caller-matched digest as destination authority", async () => {
    const fixture = cliHarness();
    const attackerOrigin = "https://attacker.invalid";
    const attackerDependencies = {
      ...fixture.dependencies,
      env: {
        ...fixture.dependencies.env,
        OFFSITE_BACKUP_SUPABASE_URL: attackerOrigin,
      },
    };
    const argv = [...ARGV];
    argv[argv.indexOf(DESTINATION_ORIGIN_SHA256)] = crypto
      .createHash("sha256")
      .update(attackerOrigin)
      .digest("hex");

    await expect(runPostgresLogicalOffsiteRetrievalCli(argv, attackerDependencies))
      .resolves.toBe(1);
    expect(fixture.events).toEqual([]);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      failureCode: "configuration_missing_or_unsafe",
    });
  });

  it.each(["other-private-bucket", " pintpath-backups", "pintpath-backups "])(
    "rejects an unreviewed offsite bucket before reading credentials: %s",
    async (bucketName) => {
      const fixture = cliHarness();
      const dependencies = {
        ...fixture.dependencies,
        env: { ...fixture.dependencies.env, OFFSITE_BACKUP_BUCKET: bucketName },
      };
      await expect(runPostgresLogicalOffsiteRetrievalCli(ARGV, dependencies))
        .resolves.toBe(1);
      expect(fixture.events).toEqual([]);
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
    const fixture = cliHarness({ serviceRoleSecret: key });
    await expect(runPostgresLogicalOffsiteRetrievalCli(ARGV, fixture.dependencies))
      .resolves.toBe(1);
    expect(fixture.events).toEqual([
      "secret:runtime-database-url",
      "secret:offsite-service-role-key",
    ]);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      failureCode: "secret_file_unsafe",
    });
    expect(fixture.output[0]).not.toContain(key);
  });
});
