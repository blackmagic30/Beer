import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV,
  STAGING_POSTGRES_BACKUP_CANARY_CONFIG_PATH_ENV,
  STAGING_POSTGRES_BACKUP_CANARY_LOCK,
  STAGING_POSTGRES_BACKUP_CANARY_ROOT_CA_ENV,
  STAGING_POSTGRES_BACKUP_CANARY_SCHEMA,
  STAGING_POSTGRES_BACKUP_CANARY_SCOPE,
  runStagingPostgresBackupCanary,
  stagingPostgresBackupDatabaseIdentitySha256,
  type StagingPostgresBackupCanaryConnection,
} from "../scripts/staging-postgres-backup-canary.js";
import type { PostgresRailwayStockLocalhostCaTransport } from
  "../src/lib/postgres-railway-stock-localhost-ca.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const deploymentId = "235d6994-7bd4-4a13-b1dc-f255775d5dc0";
const password = "secret:with\\characters";
const encodedPassword = encodeURIComponent(password);
const adminUrl =
  `postgresql://postgres:${encodedPassword}@postgres-staging.railway.internal:5432/pintpath_staging?sslmode=verify-full`;
const rootCaPem = "-----BEGIN CERTIFICATE-----\nPUBLIC-TEST-ROOT\n-----END CERTIFICATE-----\n";
const sourceRow = {
  systemIdentifier: "7567658762842437162",
  databaseOid: "16427",
  databaseName: STAGING_POSTGRES_BACKUP_CANARY_LOCK.database,
  serverVersionNum: "170010",
  adminRole: STAGING_POSTGRES_BACKUP_CANARY_LOCK.administrator,
  currentRole: STAGING_POSTGRES_BACKUP_CANARY_LOCK.administrator,
  adminCanLogin: true,
  adminSuperuser: true,
  transactionReadOnly: true,
  inRecovery: false,
};
const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const directory of temporaryRoots) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-canary-test-"));
  temporaryRoots.add(directory);
  return fs.realpathSync(directory);
}

function environment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    RAILWAY_PROJECT_ID: STAGING_POSTGRES_BACKUP_CANARY_LOCK.projectId,
    RAILWAY_ENVIRONMENT_ID: STAGING_POSTGRES_BACKUP_CANARY_LOCK.environmentId,
    RAILWAY_SERVICE_ID: STAGING_POSTGRES_BACKUP_CANARY_LOCK.serviceId,
    RAILWAY_SERVICE_NAME: STAGING_POSTGRES_BACKUP_CANARY_LOCK.serviceName,
    RAILWAY_DEPLOYMENT_ID: deploymentId,
    [STAGING_POSTGRES_BACKUP_CANARY_CONFIG_PATH_ENV]:
      STAGING_POSTGRES_BACKUP_CANARY_LOCK.railwayConfigPath,
    [STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV]: adminUrl,
    [STAGING_POSTGRES_BACKUP_CANARY_ROOT_CA_ENV]: rootCaPem,
    ...overrides,
  };
}

function fakeTransport(overrides: Partial<PostgresRailwayStockLocalhostCaTransport> = {}):
PostgresRailwayStockLocalhostCaTransport {
  return {
    profile: STAGING_POSTGRES_BACKUP_CANARY_LOCK.transportProfile,
    rootCaDerSha256: STAGING_POSTGRES_BACKUP_CANARY_LOCK.rootCaDerSha256,
    sourceUrlAuthority: {
      hostname: STAGING_POSTGRES_BACKUP_CANARY_LOCK.hostname,
      port: STAGING_POSTGRES_BACKUP_CANARY_LOCK.port,
    },
    resolvedAddress: "fd12:3456:789a::42",
    temporaryDirectory: "/private/tmp/fake-transport",
    passwordFileDirectory: "/private/tmp/fake-transport",
    passwordFileHost: "localhost",
    nodeConnection: {
      host: "fd12:3456:789a::42",
      port: 5_432,
      ssl: {
        ca: rootCaPem,
        servername: "localhost",
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        checkServerIdentity: () => undefined,
      },
    },
    libpqEnvironment: {
      PGHOST: "localhost",
      PGHOSTADDR: "fd12:3456:789a::42",
      PGPORT: "5432",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/private/tmp/fake-transport/railway-root-ca.pem",
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLSNI: "1",
    },
    assertExact: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function fakeConnection(
  row: typeof sourceRow = sourceRow,
  authenticationMethod: "scram-sha-256" | "other" | "unknown" = "scram-sha-256",
): StagingPostgresBackupCanaryConnection {
  return {
    authenticationMethod,
    query: vi.fn(async (text: string) => {
      if (text.includes(":source-identity")) {
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: null };
    }),
    close: vi.fn(async () => {}),
  };
}

function parseReceipt(output: string[]): Record<string, unknown> {
  expect(output).toHaveLength(1);
  expect(output[0]!.endsWith("\n")).toBe(true);
  expect(output[0]!.slice(0, -1)).not.toContain("\n");
  const receipt = JSON.parse(output[0]!) as Record<string, unknown>;
  expect(`${JSON.stringify(receipt)}\n`).toBe(output[0]);
  return receipt;
}

describe("staging Postgres backup authority canary", () => {
  it("uses a dedicated one-shot Railway lifecycle", () => {
    const config = fs.readFileSync(
      path.join(
        projectRoot,
        STAGING_POSTGRES_BACKUP_CANARY_LOCK.railwayConfigPath.slice(1),
      ),
      "utf8",
    );
    expect(config).toContain('[build]\nbuilder = "RAILPACK"');
    expect(config).toContain('buildCommand = "npm run build"');
    expect(config).toContain(
      'startCommand = "node dist/scripts/staging-postgres-backup-canary.js"',
    );
    expect(config).toContain('restartPolicyType = "NEVER"');
    expect(config).toContain("restartPolicyMaxRetries = 1");
    expect(config).toContain("overlapSeconds = 0");
    expect(config).toContain("drainingSeconds = 0");
    expect(config).not.toMatch(/preDeployCommand|healthcheck|ON_FAILURE|dist\/src\/server\.js/);
    const script = fs.readFileSync(
      path.join(projectRoot, "scripts/staging-postgres-backup-canary.ts"),
      "utf8",
    );
    expect(script).not.toMatch(/console\.|\.unref\(\)|process\.stderr/);
  });

  it("returns only candidate hashes after pinned TLS and one read-only transaction", async () => {
    const output: string[] = [];
    const env = environment();
    const temp = temporaryRoot();
    const transport = fakeTransport();
    const connection = fakeConnection();
    const openTransport = vi.fn(async (options) => {
      expect(env[STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV]).toBeUndefined();
      expect(env[STAGING_POSTGRES_BACKUP_CANARY_ROOT_CA_ENV]).toBeUndefined();
      expect(options.profile).toBe(STAGING_POSTGRES_BACKUP_CANARY_LOCK.transportProfile);
      expect(options.expectedRootCaDerSha256).toBe(
        STAGING_POSTGRES_BACKUP_CANARY_LOCK.rootCaDerSha256,
      );
      expect(options.sourceUrlAuthority).toEqual({
        hostname: STAGING_POSTGRES_BACKUP_CANARY_LOCK.hostname,
        port: 5_432,
      });
      const stat = fs.lstatSync(options.rootCaFile);
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.nlink).toBe(1);
      expect(fs.readFileSync(options.rootCaFile, "utf8")).toBe(rootCaPem);
      return transport;
    });
    const connect = vi.fn(async (config) => {
      expect(config).toMatchObject({
        host: "fd12:3456:789a::42",
        port: 5_432,
        database: STAGING_POSTGRES_BACKUP_CANARY_LOCK.database,
        user: STAGING_POSTGRES_BACKUP_CANARY_LOCK.administrator,
        password,
        application_name: "pintpath-staging-postgres-backup-canary",
        connectionTimeoutMillis: 15_000,
        query_timeout: 15_000,
        statement_timeout: 15_000,
      });
      expect(config.ssl).toBe(transport.nodeConnection.ssl);
      expect(JSON.stringify(config)).not.toContain(adminUrl);
      return connection;
    });
    const exitCode = await runStagingPostgresBackupCanary({
      argv: [],
      env,
      getUid: () => process.getuid!(),
      getEuid: () => process.getuid!(),
      temporaryRoot: () => temp,
      openTransport,
      connect,
      writeOutput: (value) => output.push(value),
    });
    expect(exitCode).toBe(0);
    expect(openTransport).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connection.query).mock.calls.map(([text]) => text)).toEqual([
      expect.stringContaining("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"),
      expect.stringContaining("SELECT"),
      expect.stringContaining("ROLLBACK"),
    ]);
    expect(transport.assertExact).toHaveBeenCalledTimes(4);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(temp)).toEqual([]);

    const receipt = parseReceipt(output);
    expect(Object.keys(receipt)).toEqual([
      "schemaVersion",
      "scope",
      "outcome",
      "deploymentId",
      "transport",
      "candidates",
      "identity",
    ]);
    expect(receipt).toEqual({
      schemaVersion: STAGING_POSTGRES_BACKUP_CANARY_SCHEMA,
      scope: STAGING_POSTGRES_BACKUP_CANARY_SCOPE,
      outcome: "passed",
      deploymentId,
      transport: {
        profile: STAGING_POSTGRES_BACKUP_CANARY_LOCK.transportProfile,
        rootCaDerSha256: STAGING_POSTGRES_BACKUP_CANARY_LOCK.rootCaDerSha256,
      },
      candidates: {
        adminUrlSha256: crypto.createHash("sha256").update(adminUrl).digest("hex"),
        databaseIdentitySha256: stagingPostgresBackupDatabaseIdentitySha256(sourceRow),
      },
      identity: {
        railwayProject: true,
        railwayEnvironment: true,
        railwayService: true,
        railwayServiceName: true,
        railwayDeployment: true,
        dedicatedRailwayConfig: true,
        forbiddenEnvironmentAbsent: true,
        adminUrlAuthority: true,
        rootCaAuthority: true,
        transportAuthority: true,
        tlsScram: true,
        readOnlyTransaction: true,
        stagingDatabase: true,
        administrator: true,
      },
    });
    expect(output[0]).not.toMatch(
      /secret|postgres-staging|pintpath_staging|PUBLIC-TEST-ROOT|fd12|source_query/i,
    );
  });

  it.each([
    ["project", { RAILWAY_PROJECT_ID: "00000000-0000-4000-8000-000000000000" }],
    ["environment", { RAILWAY_ENVIRONMENT_ID: "00000000-0000-4000-8000-000000000000" }],
    ["service", { RAILWAY_SERVICE_ID: "00000000-0000-4000-8000-000000000000" }],
    ["service name", { RAILWAY_SERVICE_NAME: "production" }],
    ["deployment", { RAILWAY_DEPLOYMENT_ID: "invalid" }],
    ["config", { [STAGING_POSTGRES_BACKUP_CANARY_CONFIG_PATH_ENV]: "/railway.toml" }],
    ["PG environment", { PGHOST: "unexpected" }],
    ["database URL", { DATABASE_URL: "postgresql://unexpected" }],
    ["TLS override", { NODE_TLS_REJECT_UNAUTHORIZED: "0" }],
    ["proxy", { HTTPS_PROXY: "https://proxy.invalid" }],
    ["host", { [STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV]: adminUrl.replace("postgres-staging", "postgres") }],
    ["user", { [STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV]: adminUrl.replace("postgres:", "admin:") }],
    ["database", { [STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV]: adminUrl.replace("pintpath_staging", "railway") }],
    ["TLS mode", { [STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV]: adminUrl.replace("verify-full", "require") }],
    ["query", { [STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV]: `${adminUrl}&application_name=bad` }],
    ["CA", { [STAGING_POSTGRES_BACKUP_CANARY_ROOT_CA_ENV]: "" }],
  ])("fails before transport for invalid %s authority", async (_name, overrides) => {
    const output: string[] = [];
    const env = environment(overrides);
    const openTransport = vi.fn();
    const connect = vi.fn();
    const exitCode = await runStagingPostgresBackupCanary({
      argv: [],
      env,
      getUid: () => process.getuid!(),
      getEuid: () => process.getuid!(),
      temporaryRoot: () => temporaryRoot(),
      openTransport,
      connect,
      writeOutput: (value) => output.push(value),
    });
    expect(exitCode).toBe(1);
    expect(openTransport).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(env[STAGING_POSTGRES_BACKUP_CANARY_ADMIN_URL_ENV]).toBeUndefined();
    expect(env[STAGING_POSTGRES_BACKUP_CANARY_ROOT_CA_ENV]).toBeUndefined();
    const receipt = parseReceipt(output);
    expect(receipt.outcome).toBe("failed");
    expect(receipt.candidates).toEqual({
      adminUrlSha256: null,
      databaseIdentitySha256: null,
    });
    expect(output[0]).not.toContain(adminUrl);
    expect(output[0]).not.toContain(rootCaPem);
  });

  it("rejects arguments before transport", async () => {
    const openTransport = vi.fn();
    const exitCode = await runStagingPostgresBackupCanary({
      argv: ["--unexpected"],
      env: environment(),
      getUid: () => process.getuid!(),
      getEuid: () => process.getuid!(),
      temporaryRoot: () => temporaryRoot(),
      openTransport,
      connect: vi.fn(),
      writeOutput: () => {},
    });
    expect(exitCode).toBe(1);
    expect(openTransport).not.toHaveBeenCalled();
  });

  it("closes a mismatched transport without connecting", async () => {
    const output: string[] = [];
    const transport = fakeTransport({ rootCaDerSha256: "0".repeat(64) });
    const connect = vi.fn();
    const exitCode = await runStagingPostgresBackupCanary({
      argv: [],
      env: environment(),
      getUid: () => process.getuid!(),
      getEuid: () => process.getuid!(),
      temporaryRoot: () => temporaryRoot(),
      openTransport: async () => transport,
      connect,
      writeOutput: (value) => output.push(value),
    });
    expect(exitCode).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(parseReceipt(output).outcome).toBe("failed");
  });

  it("requires SCRAM before issuing any SQL", async () => {
    const transport = fakeTransport();
    const connection = fakeConnection(sourceRow, "other");
    const exitCode = await runStagingPostgresBackupCanary({
      argv: [],
      env: environment(),
      getUid: () => process.getuid!(),
      getEuid: () => process.getuid!(),
      temporaryRoot: () => temporaryRoot(),
      openTransport: async () => transport,
      connect: async () => connection,
      writeOutput: () => {},
    });
    expect(exitCode).toBe(1);
    expect(connection.query).not.toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["writable transaction", { ...sourceRow, transactionReadOnly: false }],
    ["wrong database", { ...sourceRow, databaseName: "railway" }],
    ["non-superuser", { ...sourceRow, adminSuperuser: false }],
    ["recovery", { ...sourceRow, inRecovery: true }],
    ["server version", { ...sourceRow, serverVersionNum: "160010" }],
  ])("rejects %s source identity and rolls back", async (_name, row) => {
    const output: string[] = [];
    const connection = fakeConnection(row);
    const exitCode = await runStagingPostgresBackupCanary({
      argv: [],
      env: environment(),
      getUid: () => process.getuid!(),
      getEuid: () => process.getuid!(),
      temporaryRoot: () => temporaryRoot(),
      openTransport: async () => fakeTransport(),
      connect: async () => connection,
      writeOutput: (value) => output.push(value),
    });
    expect(exitCode).toBe(1);
    expect(vi.mocked(connection.query).mock.calls.at(-1)?.[0]).toContain("ROLLBACK");
    expect(parseReceipt(output).candidates).toEqual({
      adminUrlSha256: null,
      databaseIdentitySha256: null,
    });
  });

  it("suppresses raw query errors and cleanup failure dominates candidates", async () => {
    const output: string[] = [];
    const connection = fakeConnection();
    vi.mocked(connection.query).mockImplementation(async (text: string) => {
      if (text.includes(":source-identity")) {
        throw new Error(`raw-${adminUrl}-${rootCaPem}`);
      }
      return { rows: [], rowCount: null };
    });
    vi.mocked(connection.close).mockRejectedValue(new Error("raw-close"));
    const exitCode = await runStagingPostgresBackupCanary({
      argv: [],
      env: environment(),
      getUid: () => process.getuid!(),
      getEuid: () => process.getuid!(),
      temporaryRoot: () => temporaryRoot(),
      openTransport: async () => fakeTransport(),
      connect: async () => connection,
      writeOutput: (value) => output.push(value),
    });
    expect(exitCode).toBe(1);
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain("raw-");
    expect(output[0]).not.toContain(adminUrl);
    expect(output[0]).not.toContain(rootCaPem);
    expect(parseReceipt(output).outcome).toBe("failed");
  });

  it("pins the canonical database identity hash domain", () => {
    expect(stagingPostgresBackupDatabaseIdentitySha256(sourceRow)).toBe(
      "d4486cb726e95647d9dd85ba2e683cfa3420652e5978b6ae08f454fb439199b8",
    );
  });
});
