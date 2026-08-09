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

const ROOT = "/private/operator/logical-offsite";
const BACKUP_DIRECTORY = path.join(ROOT, "backup");
const DATABASE_URL_FILE = path.join(ROOT, "runtime-database-url");
const SERVICE_ROLE_FILE = path.join(ROOT, "offsite-service-role-key");
const DATABASE_SECRET = "runtime-database-secret";
const SERVICE_ROLE_SECRET = "offsite-service-role-secret";
const DATABASE_URL = `postgresql://runtime:${DATABASE_SECRET}@db.example.test:5432/pintpath?sslmode=verify-full`;
const RUNTIME_CONNECTION_URL_SHA256 = crypto
  .createHash("sha256").update(DATABASE_URL, "utf8").digest("hex");
const SOURCE_URL = "https://production.example.test";
const DESTINATION_URL = "https://operational-copy.example.test";
const HASH = "a".repeat(64);
const DESTINATION_ORIGIN_SHA256 = crypto
  .createHash("sha256").update(DESTINATION_URL).digest("hex");
const BUCKET_NAME_SHA256 = crypto
  .createHash("sha256").update("pintpath-backups").digest("hex");

const ARGV = [
  "--backup-directory", BACKUP_DIRECTORY,
  "--backup-manifest-sha256", HASH,
  "--expected-bucket-name-sha256", BUCKET_NAME_SHA256,
  "--expected-destination-origin-sha256", DESTINATION_ORIGIN_SHA256,
  "--operator-id", "operator-reference-01",
  "--runtime-database-url-file", DATABASE_URL_FILE,
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
};

function harness(input: {
  readonly confirmed?: boolean;
  readonly runtimeReady?: boolean;
  readonly closeFails?: boolean;
  readonly attestError?: Error;
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
      return filename === DATABASE_URL_FILE ? DATABASE_URL : SERVICE_ROLE_SECRET;
    }),
    createDatabase: vi.fn((options) => {
      events.push("database");
      expect(options.connectionString).toContain("uselibpqcompat=true");
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
  return { dependencies, events, output, database };
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
      "operator-reference-01",
      "pintpath-backups",
    ]) expect(fixture.output[0]).not.toContain(forbidden);
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
});
