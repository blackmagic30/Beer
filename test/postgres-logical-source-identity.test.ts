import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inspectPostgresLogicalBackupSourceIdentity,
  PostgresLogicalBackupError,
  type InspectPostgresLogicalBackupSourceIdentityOptions,
  type PostgresLogicalBackupConnection,
  type PostgresLogicalBackupSourceIdentityDependencies,
} from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  PostgresRailwayStockLocalhostCaError,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";

const temporaryDirectories: string[] = [];
const databaseOid = "16655";
const backupRole = `pintpath_logical_backup_d${databaseOid}`;
const backupLogin = `${backupRole}_v20260808`;
const hostname = "postgres-production.railway.internal";
const password = "source-identity-secret";
const connectionUrl = `postgresql://${backupLogin}:${password}@${hostname}:5432/pintpath?sslmode=verify-full`;
const expectedRootCaDerSha256 = "a".repeat(64);
const resolvedAddress = "fd12:3456:789a::10";

interface HarnessControl {
  readonly connectionFile: string;
  readonly rootCaFile: string;
  readonly events: string[];
  readonly connectConfigs: unknown[];
  readonly openTransportOptions: unknown[];
  readonly transports: PostgresRailwayStockLocalhostCaTransport[];
  readonly connections: PostgresLogicalBackupConnection[];
  transportRootCaDerSha256?: string;
  transportDriftAt?: number;
  driftConnectionFileDuringQuery?: boolean;
  queryFails?: boolean;
  connectionCloseFails?: boolean;
  transportCloseFails?: boolean;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pintpath-source-identity-test-"),
  );
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function writePrivateFile(directory: string, name: string, value: string): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, `${value}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function sourceIdentityRow(): Record<string, unknown> {
  return {
    systemIdentifier: "7568999345281279000",
    databaseOid,
    databaseName: "pintpath",
    backupRoleName: backupRole,
    serverVersionNum: "170006",
    roleName: backupLogin,
    canLogin: true,
    inheritsPrivileges: false,
    connectionLimit: 2,
    validUntilIsNull: true,
    superuser: false,
    createDatabase: false,
    createRole: false,
    replication: false,
    bypassRls: false,
    membershipCount: 1,
    childMembershipCount: 0,
    hasExactLogicalBackupMembership: true,
    canSetLogicalBackup: true,
    canSetMigrator: false,
    canSetRuntime: false,
    canSetSiblingLogicalBackup: false,
    directDatabasePrivilegeCount: 1,
    hasDirectDatabaseConnect: true,
    directFunctionPrivilegeCount: 1,
    hasDirectControlSystemExecute: true,
    directPrivateObjectPrivilegeCount: 0,
    ownedPrivateObjectCount: 0,
    roleSettingCount: 0,
    sharedDependencyCount: 2,
    exactSharedDependencyCount: 2,
    transactionReadOnly: false,
    inRecovery: false,
  };
}

function createHarness(
  changes: Partial<Omit<HarnessControl,
    | "connectionFile"
    | "rootCaFile"
    | "events"
    | "connectConfigs"
    | "openTransportOptions"
    | "transports"
    | "connections">> = {},
): HarnessControl & { dependencies: PostgresLogicalBackupSourceIdentityDependencies } {
  const directory = makeTemporaryDirectory();
  const control: HarnessControl = {
    connectionFile: writePrivateFile(directory, "postgres-url", connectionUrl),
    rootCaFile: writePrivateFile(directory, "railway-root-ca.pem", "public-test-root-ca"),
    events: [],
    connectConfigs: [],
    openTransportOptions: [],
    transports: [],
    connections: [],
    ...changes,
  };
  let transportSequence = 0;
  const dependencies: PostgresLogicalBackupSourceIdentityDependencies = {
    getUid: () => process.getuid?.() ?? 0,
    openTransport: async (options) => {
      control.events.push("transport.open");
      control.openTransportOptions.push(options);
      transportSequence += 1;
      let assertions = 0;
      const transport: PostgresRailwayStockLocalhostCaTransport = {
        profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
        rootCaDerSha256: control.transportRootCaDerSha256 ?? expectedRootCaDerSha256,
        sourceUrlAuthority: Object.freeze({ ...options.sourceUrlAuthority }),
        resolvedAddress,
        temporaryDirectory: `/private/source-identity-transport-${transportSequence}`,
        passwordFileDirectory: `/private/source-identity-transport-${transportSequence}`,
        passwordFileHost: "localhost",
        nodeConnection: Object.freeze({
          host: resolvedAddress,
          port: 5_432,
          ssl: Object.freeze({
            ca: "public-test-root-ca",
            servername: "localhost",
            rejectUnauthorized: true as const,
            minVersion: "TLSv1.2" as const,
            checkServerIdentity: () => undefined,
          }),
        }),
        libpqEnvironment: Object.freeze({
          PGHOST: "localhost",
          PGHOSTADDR: resolvedAddress,
          PGPORT: "5432",
          PGSSLMODE: "verify-full",
          PGSSLROOTCERT: control.rootCaFile,
          PGSSLMINPROTOCOLVERSION: "TLSv1.2",
          PGSSLSNI: "1",
        }),
        assertExact: async () => {
          control.events.push(`transport.assert.${transportSequence}`);
          assertions += 1;
          if (assertions === control.transportDriftAt) {
            throw new PostgresRailwayStockLocalhostCaError("transport_drift");
          }
        },
        close: async () => {
          control.events.push(`transport.close.${transportSequence}`);
          if (control.transportCloseFails) {
            throw new PostgresRailwayStockLocalhostCaError("cleanup_failed");
          }
        },
      };
      control.transports.push(transport);
      return transport;
    },
    connect: async (config) => {
      control.events.push("connection.open");
      control.connectConfigs.push(config);
      const connection: PostgresLogicalBackupConnection = {
        query: (async (text: string) => {
          control.events.push("connection.query");
          expect(text).toContain("pintpath:logical-backup:source-identity");
          if (control.driftConnectionFileDuringQuery) {
            fs.writeFileSync(control.connectionFile, `${connectionUrl}x\n`, { mode: 0o600 });
          }
          if (control.queryFails) throw new Error("query failed with secret material");
          return { rows: [sourceIdentityRow()], rowCount: 1 };
        }) as PostgresLogicalBackupConnection["query"],
        close: async () => {
          control.events.push("connection.close");
          if (control.connectionCloseFails) throw new Error("connection cleanup failed");
        },
      };
      control.connections.push(connection);
      return connection;
    },
  };
  return Object.assign(control, { dependencies });
}

function options(
  control: Pick<HarnessControl, "connectionFile" | "rootCaFile">,
): InspectPostgresLogicalBackupSourceIdentityOptions {
  return {
    connectionFile: control.connectionFile,
    expectedSourceUrlSha256: sha256(connectionUrl),
    transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    rootCaFile: control.rootCaFile,
    expectedRootCaDerSha256,
  };
}

async function captureError(operation: Promise<unknown>): Promise<PostgresLogicalBackupError> {
  const error = await operation.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PostgresLogicalBackupError);
  expect(String((error as Error).message)).not.toContain(password);
  expect(String((error as Error).message)).not.toContain(hostname);
  return error as PostgresLogicalBackupError;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Postgres logical-backup source identity probe", () => {
  it("uses a fresh held Railway TLS transport and session for every read-only identity probe", async () => {
    const harness = createHarness();

    const first = await inspectPostgresLogicalBackupSourceIdentity(
      options(harness),
      harness.dependencies,
    );
    const second = await inspectPostgresLogicalBackupSourceIdentity(
      options(harness),
      harness.dependencies,
    );

    expect(first).toEqual({
      sourceDatabaseIdentitySha256: "1a396fa58dc6dce6c52d62845ee9acadb3b3f501f16d7a6a167a9e9ffc621d2e",
      inRecovery: false,
    });
    expect(second).toEqual(first);
    expect(harness.transports).toHaveLength(2);
    expect(harness.connections).toHaveLength(2);
    expect(harness.transports[0]).not.toBe(harness.transports[1]);
    expect(harness.connections[0]).not.toBe(harness.connections[1]);
    expect(harness.openTransportOptions).toEqual([
      {
        profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
        rootCaFile: harness.rootCaFile,
        expectedRootCaDerSha256,
        expectedUid: process.getuid?.() ?? 0,
        sourceUrlAuthority: { hostname, port: 5_432 },
      },
      {
        profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
        rootCaFile: harness.rootCaFile,
        expectedRootCaDerSha256,
        expectedUid: process.getuid?.() ?? 0,
        sourceUrlAuthority: { hostname, port: 5_432 },
      },
    ]);
    expect(harness.connectConfigs).toEqual([
      expect.objectContaining({
        host: resolvedAddress,
        port: 5_432,
        database: "pintpath",
        user: backupLogin,
        password,
        ssl: expect.objectContaining({
          servername: "localhost",
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
        }),
        application_name: "pintpath-logical-backup-state",
        connectionTimeoutMillis: 15_000,
        query_timeout: 120_000,
      }),
      expect.any(Object),
    ]);
    expect(harness.events.filter((event) => event === "connection.close")).toHaveLength(2);
    expect(harness.events.filter((event) => event.startsWith("transport.close."))).toHaveLength(2);
    expect(harness.events.at(-2)).toBe("connection.close");
    expect(harness.events.at(-1)).toBe("transport.close.2");
  });

  it("rejects URL and root-CA authority mismatches before opening a database session", async () => {
    const wrongUrlHash = createHarness();
    const wrongUrlError = await captureError(inspectPostgresLogicalBackupSourceIdentity({
      ...options(wrongUrlHash),
      expectedSourceUrlSha256: "b".repeat(64),
    }, wrongUrlHash.dependencies));
    expect(wrongUrlError.code).toBe("unsafe_connection_url");
    expect(wrongUrlHash.events).toEqual([]);

    const wrongCa = createHarness({ transportRootCaDerSha256: "b".repeat(64) });
    const wrongCaError = await captureError(inspectPostgresLogicalBackupSourceIdentity(
      options(wrongCa),
      wrongCa.dependencies,
    ));
    expect(wrongCaError.code).toBe("source_unreachable_or_unsafe");
    expect(wrongCa.events).toEqual(["transport.open", "transport.close.1"]);
  });

  it("fails closed when the credential file or held TLS transport drifts after inspection", async () => {
    const fileDrift = createHarness({ driftConnectionFileDuringQuery: true });
    const fileDriftError = await captureError(inspectPostgresLogicalBackupSourceIdentity(
      options(fileDrift),
      fileDrift.dependencies,
    ));
    expect(fileDriftError.code).toBe("unsafe_connection_file");
    expect(fileDrift.events.slice(-2)).toEqual(["connection.close", "transport.close.1"]);

    const transportDrift = createHarness({ transportDriftAt: 4 });
    const transportDriftError = await captureError(inspectPostgresLogicalBackupSourceIdentity(
      options(transportDrift),
      transportDrift.dependencies,
    ));
    expect(transportDriftError.code).toBe("source_unreachable_or_unsafe");
    expect(transportDrift.events).toContain("connection.query");
    expect(transportDrift.events.slice(-2)).toEqual([
      "connection.close",
      "transport.close.1",
    ]);
  });

  it("attempts both cleanup paths and makes cleanup failure dominate an earlier query failure", async () => {
    const harness = createHarness({
      queryFails: true,
      connectionCloseFails: true,
      transportCloseFails: true,
    });

    const error = await captureError(inspectPostgresLogicalBackupSourceIdentity(
      options(harness),
      harness.dependencies,
    ));

    expect(error.code).toBe("cleanup_failed");
    expect(harness.events.slice(-2)).toEqual(["connection.close", "transport.close.1"]);
  });

  it("rejects unsafe credential files and malformed authority inputs before provider access", async () => {
    const unsafeMode = createHarness();
    fs.chmodSync(unsafeMode.connectionFile, 0o644);
    const unsafeModeError = await captureError(inspectPostgresLogicalBackupSourceIdentity(
      options(unsafeMode),
      unsafeMode.dependencies,
    ));
    expect(unsafeModeError.code).toBe("unsafe_connection_file");
    expect(unsafeMode.events).toEqual([]);

    const malformedCaHash = createHarness();
    const getUid = vi.fn(() => process.getuid?.() ?? 0);
    const malformedCaError = await captureError(inspectPostgresLogicalBackupSourceIdentity({
      ...options(malformedCaHash),
      expectedRootCaDerSha256: expectedRootCaDerSha256.toUpperCase(),
    }, {
      ...malformedCaHash.dependencies,
      getUid,
    }));
    expect(malformedCaError.code).toBe("invalid_arguments");
    expect(getUid).not.toHaveBeenCalled();
    expect(malformedCaHash.events).toEqual([]);
  });
});
