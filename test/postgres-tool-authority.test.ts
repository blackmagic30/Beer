import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS,
  POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_SCRATCH_RESTORE_OPTIONS,
} from "../src/lib/postgres-logical-backup-v4.js";
import {
  POSTGRES_LOGICAL_BACKUP_V4_PG_DUMP_WATCHDOG_TIMEOUT_MILLISECONDS,
} from "../src/lib/postgres-logical-backup-v4-source-authority.js";
import {
  POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS,
  type PostgresLogicalBackupV4TableDataDescriptor,
} from "../src/lib/postgres-logical-backup-v4-table-data-contract.js";
import {
  parsePostgresLogicalBackupV4TocListing,
  POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_BYTES,
  PostgresLogicalBackupV4TocError,
} from "../src/lib/postgres-logical-backup-v4-toc.js";
import {
  POSTGRES_TOOL_AUTHORITY_MAXIMUM_BYTES,
  POSTGRES_TOOL_AUTHORITY_V4_MAX_LISTING_BYTES,
  createPostgresToolProcessResultCarrier,
  createPostgresToolRawProcessResultCarrier,
  openPostgresToolAuthority,
  type PostgresDumpOperationInput,
  type PostgresDumpV4OperationInput,
  type PostgresListV4ToolAuthorityProcessRunner,
  type PostgresRestoreV4OperationInput,
  type PostgresToolAuthorityFailureCode,
  type PostgresToolAuthorityProcessInvocation,
  type PostgresToolAuthorityProcessRunner,
  type PostgresToolAuthorityPurpose,
  type PostgresToolAuthorityRawProcessInvocation,
  type PostgresToolRawProcessResultCarrier,
  type PostgresToolAuthorityTestFileSystemDependencies,
} from "../src/lib/postgres-tool-authority.js";

const UID = process.geteuid?.() ?? -1;
const TOOL_BYTES = Buffer.from("reviewed-postgresql-17-tool\n", "utf8");
const TOOL_SHA256 = crypto.createHash("sha256").update(TOOL_BYTES).digest("hex");
const roots: string[] = [];

const EXPECTED_V4_STATIC_DUMP_ARGUMENTS = [
  "--format=custom",
  "--data-only",
  "--no-large-objects",
  "--no-password",
  "--lock-wait-timeout=30s",
  "--no-owner",
  "--no-acl",
  "--enable-row-security",
  "--strict-names",
  "--table=pintpath_app.account_deletion_completion_outbox",
  "--table=pintpath_app.account_deletion_notice_recipient_secrets",
  "--table=pintpath_app.account_deletion_notification_events",
  "--table=pintpath_app.account_deletion_requests",
  "--table=pintpath_app.account_discount_passes",
  "--table=pintpath_app.account_preferences",
  "--table=pintpath_app.account_privacy_settings",
  "--table=pintpath_app.account_reward_vouchers",
  "--table=pintpath_app.accounts",
  "--table=pintpath_app.admin_ingestion_queue",
  "--table=pintpath_app.age_verifications",
  "--table=pintpath_app.auth_sessions",
  "--table=pintpath_app.beer_catalog_aliases",
  "--table=pintpath_app.beer_catalog_items",
  "--table=pintpath_app.billing_checkout_reservations",
  "--table=pintpath_app.contribution_ledger",
  "--table=pintpath_app.discount_redemptions",
  "--table=pintpath_app.events",
  "--table=pintpath_app.feedback",
  "--table=pintpath_app.free_pint_reward_codes",
  "--table=pintpath_app.free_pint_reward_redemptions",
  "--table=pintpath_app.leaderboard_prize_awards",
  "--table=pintpath_app.leaderboard_prize_campaigns",
  "--table=pintpath_app.migration_quarantined_records",
  "--table=pintpath_app.mission_progress",
  "--table=pintpath_app.missions",
  "--table=pintpath_app.pint_point_drink_records",
  "--table=pintpath_app.pint_point_ledger",
  "--table=pintpath_app.profiles",
  "--table=pintpath_app.revoked_provider_sessions",
  "--table=pintpath_app.saved_items",
  "--table=pintpath_app.schema_metadata",
  "--table=pintpath_app.security_audit_log",
  "--table=pintpath_app.source_evidence_objects",
  "--table=pintpath_app.stripe_webhook_events",
  "--table=pintpath_app.submission_items",
  "--table=pintpath_app.submission_source_evidence",
  "--table=pintpath_app.submissions",
  "--table=pintpath_app.system_state",
  "--table=pintpath_app.user_activity_events",
  "--table=pintpath_app.venue_analytics_events",
  "--table=pintpath_app.venue_beers",
  "--table=pintpath_app.venue_claim_requests",
  "--table=pintpath_app.venue_happy_hours",
  "--table=pintpath_app.venue_identity_aliases",
  "--table=pintpath_app.venue_interest_requests",
  "--table=pintpath_app.venue_location_cache",
  "--table=pintpath_app.venue_manager_assignments",
  "--table=pintpath_app.venue_monthly_reports",
  "--table=pintpath_app.venue_partner_outreach",
  "--table=pintpath_app.venue_pending_changes",
  "--table=pintpath_app.venue_price_records",
  "--table=pintpath_app.venue_profiles",
  "--table=pintpath_app.venue_requests",
  "--table=pintpath_app.venue_specials",
  "--table=pintpath_app.verifications",
  "--table=pintpath_app.wrong_price_reports",
  "--table=pintpath_ops.migration_chunks",
  "--table=pintpath_ops.migration_runs",
] as const;

const EXPECTED_V4_SCRATCH_RESTORE_OPTIONS = [
  "--data-only",
  "--disable-triggers",
  "--single-transaction",
  "--exit-on-error",
  "--no-password",
  "--no-owner",
  "--no-acl",
] as const;

interface Fixture {
  readonly root: string;
  readonly file: string;
  readonly purpose: PostgresToolAuthorityPurpose;
}

function fixture(
  purpose: PostgresToolAuthorityPurpose = "dump",
  bytes: Buffer = TOOL_BYTES,
): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    "pintpath-postgres-tool-authority-test-",
  )));
  roots.push(root);
  const file = path.join(
    root,
    purpose === "dump" || purpose === "dump-v4" ? "pg_dump" : "pg_restore",
  );
  fs.writeFileSync(file, bytes, { mode: 0o555 });
  fs.chmodSync(file, 0o555);
  return { root, file, purpose };
}

function options(value: Fixture, expectedSha256 = TOOL_SHA256) {
  return {
    purpose: value.purpose,
    executableFile: value.file,
    expectedSha256,
  } as const;
}

function versionOutput(invocation: PostgresToolAuthorityProcessInvocation): string {
  return `${path.basename(invocation.command)} (PostgreSQL) 17.10\n`;
}

function result(
  invocation: PostgresToolAuthorityProcessInvocation,
  overrides: Partial<{ exitCode: number; stdout: string; stderr: string }> = {},
) {
  return createPostgresToolProcessResultCarrier({
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout
      ?? (invocation.operation === "version"
        ? versionOutput(invocation)
        : invocation.operation === "list" ? "TOC entry\n" : ""),
    stderr: overrides.stderr ?? "",
  });
}

function runner(
  invocations: PostgresToolAuthorityProcessInvocation[] = [],
  observe?: (invocation: PostgresToolAuthorityProcessInvocation) => void,
): PostgresToolAuthorityProcessRunner {
  return async (invocation) => {
    invocations.push(invocation);
    observe?.(invocation);
    return result(invocation);
  };
}

type AnyToolInvocation =
  | PostgresToolAuthorityProcessInvocation
  | PostgresToolAuthorityRawProcessInvocation;

function tocEntryLine(
  entry: PostgresLogicalBackupV4TableDataDescriptor,
  index: number,
): string {
  const dumpId = index === 0 ? "4294967295" : String(4_000 + index);
  const catalogTableOid = index % 2 === 0 ? "0" : String(1_259 + index);
  const catalogObjectOid = index === 0 ? "0" : String(16_384 + index);
  const owner = index % 2 === 0 ? "postgres" : `pintpath_owner_${index}`;
  return `${dumpId}; ${catalogTableOid} ${catalogObjectOid} TABLE DATA ${entry.schemaName} ${entry.tableName} ${owner}`;
}

function validV4TocListing(): Buffer {
  const lines = [
    ";",
    "; Archive created at 2026-08-12 20:38:04 AEST",
    ";     dbname: postgres",
    ";     TOC Entries: 63",
    ";     Compression: gzip",
    ";     Dump Version: 1.16-0",
    ";     Format: CUSTOM",
    ";     Integer: 4 bytes",
    ";     Offset: 8 bytes",
    ";     Dumped from database version: 17.6 (Supabase)",
    ";     Dumped by pg_dump version: 17.10 (Homebrew)",
    ";",
    ";",
    "; Selected TOC Entries:",
    ";",
    ...[...POSTGRES_LOGICAL_BACKUP_V4_TABLE_DATA_DESCRIPTORS]
      .reverse()
      .map(tocEntryLine),
  ];
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function rawResult(
  overrides: Partial<{
    exitCode: number;
    stdout: Buffer;
    stderr: Buffer;
  }> = {},
): PostgresToolRawProcessResultCarrier {
  return createPostgresToolRawProcessResultCarrier({
    exitCode: overrides.exitCode ?? 0,
    stdout: overrides.stdout ?? validV4TocListing(),
    stderr: overrides.stderr ?? Buffer.alloc(0),
  });
}

function listV4Runner(
  invocations: AnyToolInvocation[] = [],
  listingBytes: Buffer = validV4TocListing(),
  observe?: (invocation: AnyToolInvocation) => void,
): PostgresListV4ToolAuthorityProcessRunner {
  return (async (invocation: AnyToolInvocation) => {
    invocations.push(invocation);
    observe?.(invocation);
    return invocation.operation === "list-v4"
      ? rawResult({ stdout: listingBytes })
      : result(invocation);
  }) as PostgresListV4ToolAuthorityProcessRunner;
}

function dumpEnvironment(): Record<string, string> {
  return {
    PGHOST: "localhost",
    PGHOSTADDR: "127.0.0.1",
    PGPORT: "5432",
    PGDATABASE: "pintpath",
    PGUSER: "pintpath_backup",
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: "/private/ca.pem",
    PGSSLMINPROTOCOLVERSION: "TLSv1.2",
    PGSSLSNI: "1",
    PGGSSENCMODE: "disable",
    PGCONNECT_TIMEOUT: "15",
    PGAPPNAME: "pintpath-logical-backup",
    PGPASSFILE: "/private/pgpass",
    PATH: "/attacker",
    LD_PRELOAD: "/attacker.so",
    DYLD_INSERT_LIBRARIES: "/attacker.dylib",
    PGOPTIONS: "-c session_preload_libraries=attacker",
    LC_ALL: "attacker",
  };
}

function dumpV4Environment(): Record<string, string> {
  return {
    ...dumpEnvironment(),
    PGREQUIREAUTH: "scram-sha-256",
  };
}

function restoreEnvironment(): Record<string, string> {
  return {
    PGHOST: "db.example.test",
    PGPORT: "5432",
    PGDATABASE: "pintpath_restore",
    PGUSER: "pintpath_restore",
    PGPASSWORD: "offline-test-secret",
    PGSSLMODE: "verify-full",
    PGGSSENCMODE: "disable",
    PGCONNECT_TIMEOUT: "15",
    PGAPPNAME: "pintpath-logical-restore-rehearsal",
    PATH: "/attacker",
    LD_PRELOAD: "/attacker.so",
    PGOPTIONS: "-c shared_preload_libraries=attacker",
  };
}

function dumpInput(environment = dumpEnvironment()): PostgresDumpOperationInput {
  return {
    snapshotIdentifier: "00000003-0000001B-1",
    roleName: "pintpath_logical_backup_d12345",
    environment,
    archiveOutputFileDescriptor: 41,
  };
}

function dumpV4Input(environment = dumpV4Environment()): PostgresDumpV4OperationInput {
  return {
    snapshotIdentifier: "00000003-0000001B-1",
    roleName: "pintpath_logical_backup_d12345",
    environment,
    archiveOutputFileDescriptor: 43,
  };
}

function restoreV4Input(
  archiveInputFileDescriptor: number,
  environment = restoreEnvironment(),
): PostgresRestoreV4OperationInput {
  return {
    environment,
    archiveInputFileDescriptor,
  };
}

function dependencies(
  overrides: Partial<PostgresToolAuthorityTestFileSystemDependencies> = {},
): PostgresToolAuthorityTestFileSystemDependencies {
  return {
    effectiveUid: () => UID,
    lstat: (filename) => fs.lstatSync(filename, { bigint: true }),
    realpath: (filename) => fs.realpathSync.native(filename),
    open: (filename, flags) => fs.openSync(filename, flags),
    fstat: (fileDescriptor) => fs.fstatSync(fileDescriptor, { bigint: true }),
    read: (fileDescriptor, buffer, offset, length, position) =>
      fs.readSync(fileDescriptor, buffer, offset, length, position),
    close: (fileDescriptor) => fs.closeSync(fileDescriptor),
    ...overrides,
  };
}

function statWith(
  stat: fs.BigIntStats,
  overrides: Partial<Record<
    "dev" | "ino" | "uid" | "gid" | "mode" | "nlink" | "size"
      | "mtimeNs" | "ctimeNs",
    bigint
  >>,
): fs.BigIntStats {
  const output = Object.create(null) as Record<string, bigint>;
  for (const key of [
    "dev",
    "ino",
    "uid",
    "gid",
    "mode",
    "nlink",
    "size",
    "mtimeNs",
    "ctimeNs",
  ] as const) {
    output[key] = overrides[key] ?? stat[key];
  }
  return output as unknown as fs.BigIntStats;
}

async function expectCode(
  promise: Promise<unknown>,
  code: PostgresToolAuthorityFailureCode,
): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    name: "PostgresToolAuthorityError",
    code,
    message: code,
  });
}

function rewrite(file: string, bytes = Buffer.from("mutated-postgresql-tool!!\n")): void {
  fs.chmodSync(file, 0o755);
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, 0o555);
}

function archiveFile(root: string, name = "archive.dump"): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, "postgres-custom-archive\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function openTestFileDescriptor(filename: string): number {
  return fs.openSync(filename, "r");
}

function openTestWritableFileDescriptor(filename: string): number {
  return fs.openSync(filename, "r+");
}

function mutateArchiveDescriptor(fileDescriptor: number): void {
  fs.ftruncateSync(fileDescriptor, 1);
  fs.fsyncSync(fileDescriptor);
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("postgres tool authority", () => {
  it("emits only fixed dump operations and strips ambient/dynamic-loader environment", async () => {
    const tool = fixture("dump");
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const authority = await openPostgresToolAuthority(options(tool), runner(invocations));

    expect(Object.getPrototypeOf(authority)).toBeNull();
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Reflect.ownKeys(authority)).toEqual([
      "version",
      "dump",
      "assertExact",
      "close",
    ]);
    expect("command" in authority).toBe(false);
    expect("args" in authority).toBe(false);
    expect("path" in authority).toBe(false);
    expect("fileDescriptor" in authority).toBe(false);
    expect("runProcess" in authority).toBe(false);

    await authority.assertExact();
    await authority.version();
    await authority.dump(dumpInput());
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toMatchObject({
      operation: "version",
      command: tool.file,
      args: ["--version"],
      env: { LC_ALL: "C" },
      timeoutMs: 15_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
    });
    expect(invocations[1]).toMatchObject({
      operation: "dump",
      command: tool.file,
      args: [
        "--format=custom",
        "--snapshot=00000003-0000001B-1",
        "--role=pintpath_logical_backup_d12345",
        "--no-owner",
        "--no-acl",
        "--enable-row-security",
        "--strict-names",
        "--lock-wait-timeout=30s",
        "--no-password",
        "--schema=pintpath_app",
        "--schema=pintpath_ops",
      ],
      stdoutFileDescriptor: 41,
    });
    expect(Object.getPrototypeOf(invocations[1]!.env)).toBeNull();
    expect(Object.isFrozen(invocations[1]!.env)).toBe(true);
    expect(invocations[1]!.env).toEqual({
      LC_ALL: "C",
      PGHOST: "localhost",
      PGHOSTADDR: "127.0.0.1",
      PGPORT: "5432",
      PGDATABASE: "pintpath",
      PGUSER: "pintpath_backup",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/private/ca.pem",
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLSNI: "1",
      PGGSSENCMODE: "disable",
      PGCONNECT_TIMEOUT: "15",
      PGAPPNAME: "pintpath-logical-backup",
      PGPASSFILE: "/private/pgpass",
    });
    expect(invocations[1]!.env).not.toHaveProperty("PATH");
    expect(invocations[1]!.env).not.toHaveProperty("LD_PRELOAD");
    expect(invocations[1]!.env).not.toHaveProperty("PGOPTIONS");
    await expectCode(authority.version(), "invalid_arguments");
    await expectCode(authority.dump(dumpInput()), "invalid_arguments");
    await authority.close();
  });

  it("emits the exact purpose-bound V4 data-only dump contract", async () => {
    expect(POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS)
      .toEqual(EXPECTED_V4_STATIC_DUMP_ARGUMENTS);
    expect(POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_DUMP_ARGUMENTS).toHaveLength(68);

    const tool = fixture("dump-v4");
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const authority = await openPostgresToolAuthority({
      purpose: "dump-v4",
      executableFile: tool.file,
      expectedSha256: TOOL_SHA256,
    }, runner(invocations));

    expect(Object.getPrototypeOf(authority)).toBeNull();
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Reflect.ownKeys(authority)).toEqual([
      "version",
      "dumpV4",
      "assertExact",
      "close",
    ]);
    expect("dump" in authority).toBe(false);
    expect("command" in authority).toBe(false);
    expect("args" in authority).toBe(false);
    expect("runProcess" in authority).toBe(false);

    await authority.version();
    await authority.dumpV4(dumpV4Input());

    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toMatchObject({
      operation: "version",
      command: tool.file,
      args: ["--version"],
      env: { LC_ALL: "C" },
    });
    expect(invocations[1]).toMatchObject({
      operation: "dump",
      command: tool.file,
      args: [
        ...EXPECTED_V4_STATIC_DUMP_ARGUMENTS,
        "--role=pintpath_logical_backup_d12345",
        "--snapshot=00000003-0000001B-1",
      ],
      timeoutMs: POSTGRES_LOGICAL_BACKUP_V4_PG_DUMP_WATCHDOG_TIMEOUT_MILLISECONDS,
      maxStdoutBytes: 512 * 1_024,
      maxStderrBytes: 512 * 1_024,
      stdoutFileDescriptor: 43,
    });
    expect(invocations[1]!.args).toHaveLength(70);
    expect(Object.isFrozen(invocations[1]!.args)).toBe(true);
    expect(Object.getPrototypeOf(invocations[1]!.env)).toBeNull();
    expect(Object.isFrozen(invocations[1]!.env)).toBe(true);
    expect(invocations[1]!.env).toEqual({
      LC_ALL: "C",
      PGHOST: "localhost",
      PGHOSTADDR: "127.0.0.1",
      PGPORT: "5432",
      PGDATABASE: "pintpath",
      PGUSER: "pintpath_backup",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/private/ca.pem",
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLSNI: "1",
      PGGSSENCMODE: "disable",
      PGCONNECT_TIMEOUT: "15",
      PGAPPNAME: "pintpath-logical-backup",
      PGPASSFILE: "/private/pgpass",
      PGREQUIREAUTH: "scram-sha-256",
    });
    expect(invocations[1]!.env).not.toHaveProperty("PATH");
    expect(invocations[1]!.env).not.toHaveProperty("LD_PRELOAD");
    expect(invocations[1]!.env).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
    expect(invocations[1]!.env).not.toHaveProperty("PGOPTIONS");
    await expectCode(authority.dumpV4(dumpV4Input()), "invalid_arguments");
    await expectCode(authority.version(), "invalid_arguments");
    await authority.close();
  });

  it.each([
    ["missing required authentication", undefined],
    ["trust-equivalent none", "none"],
    ["generic authentication", "require"],
    ["comma-list", "scram-sha-256,password"],
    ["uppercase drift", "SCRAM-SHA-256"],
    ["trailing whitespace", "scram-sha-256 "],
  ] as const)("requires exact V4 SCRAM authentication: %s", async (
    _label,
    requireAuth,
  ) => {
    const tool = fixture("dump-v4");
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const authority = await openPostgresToolAuthority(options(tool), runner(invocations));
    await authority.version();
    const environment = dumpV4Environment();
    if (requireAuth === undefined) delete environment.PGREQUIREAUTH;
    else environment.PGREQUIREAUTH = requireAuth;
    await expectCode(authority.dumpV4(dumpV4Input(environment)), "invalid_arguments");
    expect(invocations).toHaveLength(1);
    await authority.dumpV4(dumpV4Input());
    expect(invocations).toHaveLength(2);
    await authority.close();
  });

  it.each([
    "postgresql://db.example.test/pintpath",
    "postgres://db.example.test/pintpath",
    "POSTGRESQL://db.example.test/pintpath",
    "dbname=pintpath",
    "pint path",
    "pint\tpath",
  ])("rejects URI/conninfo-shaped V4 PGDATABASE without changing legacy: %s", async (
    database,
  ) => {
    const v4Tool = fixture("dump-v4");
    const v4Invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const v4Authority = await openPostgresToolAuthority(
      options(v4Tool),
      runner(v4Invocations),
    );
    await v4Authority.version();
    await expectCode(v4Authority.dumpV4(dumpV4Input({
      ...dumpV4Environment(),
      PGDATABASE: database,
    })), "invalid_arguments");
    expect(v4Invocations).toHaveLength(1);
    await v4Authority.close();

    const legacyTool = fixture("dump");
    const legacyInvocations: PostgresToolAuthorityProcessInvocation[] = [];
    const legacyAuthority = await openPostgresToolAuthority(
      options(legacyTool),
      runner(legacyInvocations),
    );
    await legacyAuthority.version();
    await legacyAuthority.dump(dumpInput({
      ...dumpEnvironment(),
      PGDATABASE: database,
    }));
    expect(legacyInvocations[1]!.env.PGDATABASE).toBe(database);
    await legacyAuthority.close();
  });

  it.each([
    ["nonzero exit", { exitCode: 1, stdout: "", stderr: "" }],
    ["unexpected stdout", { exitCode: 0, stdout: "unexpected", stderr: "" }],
    ["stderr warning", { exitCode: 0, stdout: "", stderr: "warning" }],
  ] as const)("spends V4 authority on unsuccessful completion: %s", async (
    _label,
    completion,
  ) => {
    const tool = fixture("dump-v4");
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const authority = await openPostgresToolAuthority({
      purpose: "dump-v4",
      executableFile: tool.file,
      expectedSha256: TOOL_SHA256,
    }, async (invocation) => {
      invocations.push(invocation);
      return result(invocation, invocation.operation === "dump" ? completion : {});
    });
    await authority.version();
    await expectCode(authority.dumpV4(dumpV4Input()), "process_failed");
    await expectCode(authority.dumpV4(dumpV4Input()), "invalid_arguments");
    expect(invocations).toHaveLength(2);
    await authority.close();
  });

  it.each([
    ["lowercase snapshot", { snapshotIdentifier: "00000003-0000001b-1" }],
    ["zero snapshot sequence", { snapshotIdentifier: "00000003-0000001B-0" }],
    ["noncanonical snapshot sequence", { snapshotIdentifier: "00000003-0000001B-01" }],
    ["oversized snapshot sequence", { snapshotIdentifier: "00000003-0000001B-2147483648" }],
    ["short snapshot fields", { snapshotIdentifier: "3-1B-1" }],
    ["zero role OID", { roleName: "pintpath_logical_backup_d0" }],
    ["noncanonical role OID", { roleName: "pintpath_logical_backup_d012345" }],
    ["oversized role OID", { roleName: "pintpath_logical_backup_d4294967296" }],
    ["unscoped role", { roleName: "pintpath_logical_backup" }],
  ] as const)("rejects V4 dynamic argument drift: %s", async (_label, override) => {
    const tool = fixture("dump-v4");
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const authority = await openPostgresToolAuthority({
      purpose: "dump-v4",
      executableFile: tool.file,
      expectedSha256: TOOL_SHA256,
    }, runner(invocations));
    await authority.version();
    await expectCode(authority.dumpV4({
      ...dumpV4Input(),
      ...override,
    }), "invalid_arguments");
    expect(invocations).toHaveLength(1);
    await authority.dumpV4(dumpV4Input());
    expect(invocations).toHaveLength(2);
    await authority.close();
  });

  it("rejects hostile V4 inputs, incomplete environments, and unsafe descriptors", async () => {
    const tool = fixture("dump-v4");
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const authority = await openPostgresToolAuthority({
      purpose: "dump-v4",
      executableFile: tool.file,
      expectedSha256: TOOL_SHA256,
    }, runner(invocations));
    await authority.version();

    await expectCode(authority.dumpV4(new Proxy(dumpV4Input(), {})),
      "invalid_arguments");

    let accessorCalls = 0;
    const accessorInput = dumpV4Input() as {
      snapshotIdentifier: string;
      roleName: string;
      environment: Readonly<Record<string, string>>;
      archiveOutputFileDescriptor: number;
    };
    Object.defineProperty(accessorInput, "snapshotIdentifier", {
      configurable: true,
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "00000003-0000001B-1";
      },
    });
    await expectCode(authority.dumpV4(accessorInput), "invalid_arguments");
    expect(accessorCalls).toBe(0);

    const symbolInput = dumpV4Input() as PostgresDumpV4OperationInput & {
      [key: symbol]: string;
    };
    Object.defineProperty(symbolInput, Symbol("ambient-argv"), {
      enumerable: true,
      value: "--file=/attacker",
    });
    await expectCode(authority.dumpV4(symbolInput), "invalid_arguments");

    const incompleteEnvironment = dumpEnvironment();
    delete incompleteEnvironment.PGSSLROOTCERT;
    await expectCode(authority.dumpV4(dumpV4Input(incompleteEnvironment)),
      "invalid_arguments");
    await expectCode(authority.dumpV4(dumpV4Input(new Proxy(
      dumpEnvironment(),
      {},
    ))), "invalid_arguments");
    const accessorEnvironment = dumpEnvironment();
    Object.defineProperty(accessorEnvironment, "PGHOST", {
      configurable: true,
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "attacker";
      },
    });
    await expectCode(authority.dumpV4(dumpV4Input(accessorEnvironment)),
      "invalid_arguments");
    expect(accessorCalls).toBe(0);
    await expectCode(authority.dumpV4({
      ...dumpV4Input(),
      archiveOutputFileDescriptor: 2,
    }), "invalid_arguments");
    expect(invocations).toHaveLength(1);

    await authority.dumpV4(dumpV4Input());
    expect(invocations).toHaveLength(2);
    await authority.close();
  });

  it("binds V4 to a reviewed PostgreSQL 17 pg_dump and rechecks it around use", async () => {
    const wrongHash = fixture("dump-v4");
    await expectCode(openPostgresToolAuthority({
      purpose: "dump-v4",
      executableFile: wrongHash.file,
      expectedSha256: "0".repeat(64),
    }, runner()), "sha256_mismatch");

    const wrongVersion = fixture("dump-v4");
    const wrongVersionAuthority = await openPostgresToolAuthority({
      purpose: "dump-v4",
      executableFile: wrongVersion.file,
      expectedSha256: TOOL_SHA256,
    }, async (invocation) => result(invocation, {
      stdout: invocation.operation === "version"
        ? "pg_dump (PostgreSQL) 16.9\n"
        : "",
    }));
    await expectCode(wrongVersionAuthority.version(), "process_failed");
    await expectCode(wrongVersionAuthority.dumpV4(dumpV4Input()),
      "invalid_arguments");
    await wrongVersionAuthority.close();

    const drifted = fixture("dump-v4");
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const driftedAuthority = await openPostgresToolAuthority({
      purpose: "dump-v4",
      executableFile: drifted.file,
      expectedSha256: TOOL_SHA256,
    }, runner(invocations, (invocation) => {
      if (invocation.operation === "dump") rewrite(drifted.file);
    }));
    await driftedAuthority.version();
    await expectCode(driftedAuthority.dumpV4(dumpV4Input()), "tool_drift");
    expect(invocations).toHaveLength(2);
    await driftedAuthority.close();
  });

  it("emits a byte-exact, stable-inode, nonauthorizing V4 listing observation", async () => {
    expect(POSTGRES_TOOL_AUTHORITY_V4_MAX_LISTING_BYTES)
      .toBe(POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_BYTES);
    const tool = fixture("list-v4");
    const listing = validV4TocListing();
    const invocations: AnyToolInvocation[] = [];
    const authority = await openPostgresToolAuthority(
      options(tool),
      listV4Runner(invocations, listing),
    );
    const archive = archiveFile(tool.root);
    const descriptor = openTestFileDescriptor(archive);

    expect(Object.getPrototypeOf(authority)).toBeNull();
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Reflect.ownKeys(authority)).toEqual([
      "version",
      "listV4",
      "assertExact",
      "close",
    ]);
    expect("list" in authority).toBe(false);
    expect("restore" in authority).toBe(false);
    expect("restoreV4" in authority).toBe(false);
    expect("dump" in authority).toBe(false);
    expect("runProcess" in authority).toBe(false);

    await expectCode(authority.listV4(descriptor), "invalid_arguments");
    await authority.version();
    const observation = await authority.listV4(descriptor);
    await authority.assertExact();

    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toMatchObject({
      operation: "version",
      command: tool.file,
      args: ["--version"],
      env: { LC_ALL: "C" },
      timeoutMs: 15_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
    });
    expect(invocations[1]).toMatchObject({
      operation: "list-v4",
      stdoutMode: "raw",
      command: tool.file,
      args: ["--list", "--format=custom"],
      env: { LC_ALL: "C" },
      timeoutMs: 5 * 60 * 1_000,
      maxStdoutBytes: POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_BYTES,
      maxStderrBytes: POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_BYTES,
      stdinFileDescriptor: descriptor,
    });
    expect(Object.isFrozen(invocations[1]!.args)).toBe(true);
    expect(Object.getPrototypeOf(invocations[1]!.env)).toBeNull();
    expect(Object.isFrozen(invocations[1]!.env)).toBe(true);

    expect(Object.getPrototypeOf(observation)).toBeNull();
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Reflect.ownKeys(observation)).toEqual([
      "classification",
      "listingBytes",
      "listingByteLength",
      "listingSha256",
      "archiveStableIdentitySha256",
      "pgRestoreVersion",
      "configuredExecutableSha256",
      "operationalAuthorityGranted",
      "sourceAuthorityGranted",
      "archiveContentAuthorityGranted",
    ]);
    expect(observation).toMatchObject({
      classification: "V4_LISTING_OBSERVATION_ONLY",
      listingByteLength: listing.byteLength,
      listingSha256: crypto.createHash("sha256").update(listing).digest("hex"),
      archiveStableIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      pgRestoreVersion: "17.10",
      configuredExecutableSha256: TOOL_SHA256,
      operationalAuthorityGranted: false,
      sourceAuthorityGranted: false,
      archiveContentAuthorityGranted: false,
    });
    expect(observation.listingBytes).not.toBe(listing);
    expect(observation.listingBytes).toEqual(listing);
    expect(Buffer.isBuffer(observation.listingBytes)).toBe(true);
    expect(Object.getPrototypeOf(observation.listingBytes)).toBe(Buffer.prototype);
    const parsed = parsePostgresLogicalBackupV4TocListing(observation.listingBytes);
    expect(parsed.listingSha256).toBe(observation.listingSha256);

    const recordedHash = observation.listingSha256;
    observation.listingBytes[0] = 0x00;
    expect(observation.listingSha256).toBe(recordedHash);
    expect(crypto.createHash("sha256").update(observation.listingBytes).digest("hex"))
      .not.toBe(recordedHash);
    await expectCode(authority.listV4(descriptor), "invalid_arguments");
    await expectCode(authority.version(), "invalid_arguments");
    await authority.close();
    fs.closeSync(descriptor);
  });

  it("keeps raw carrier bytes private and rejects raw/string carrier cross-use", async () => {
    const listing = validV4TocListing();
    const carrier = rawResult({ stdout: listing });
    listing.fill(0x00);
    carrier.stdout.fill(0xff);

    const tool = fixture("list-v4");
    const archiveDescriptor = openTestFileDescriptor(archiveFile(tool.root));
    const isolatedRunner = (async (invocation: AnyToolInvocation) => (
      invocation.operation === "list-v4" ? carrier : result(invocation)
    )) as PostgresListV4ToolAuthorityProcessRunner;
    const authority = await openPostgresToolAuthority(options(tool), isolatedRunner);
    await authority.version();
    const observation = await authority.listV4(archiveDescriptor);
    expect(observation.listingBytes).toEqual(validV4TocListing());
    expect(observation.listingBytes).not.toEqual(carrier.stdout);
    await authority.close();
    fs.closeSync(archiveDescriptor);

    const rawVersionTool = fixture("list-v4");
    const rawVersionAuthority = await openPostgresToolAuthority(
      options(rawVersionTool),
      (async () => rawResult()) as PostgresListV4ToolAuthorityProcessRunner,
    );
    await expectCode(rawVersionAuthority.version(), "process_failed");
    await rawVersionAuthority.close();

    const stringListTool = fixture("list-v4");
    const stringListDescriptor = openTestFileDescriptor(archiveFile(stringListTool.root));
    const stringListRunner = (async (invocation: AnyToolInvocation) => (
      invocation.operation === "list-v4"
        ? createPostgresToolProcessResultCarrier({
          exitCode: 0,
          stdout: validV4TocListing().toString("utf8"),
          stderr: "",
        })
        : result(invocation)
    )) as PostgresListV4ToolAuthorityProcessRunner;
    const stringListAuthority = await openPostgresToolAuthority(
      options(stringListTool),
      stringListRunner,
    );
    await stringListAuthority.version();
    await expectCode(stringListAuthority.listV4(stringListDescriptor), "process_failed");
    await stringListAuthority.close();
    fs.closeSync(stringListDescriptor);
  });

  it("preserves invalid UTF-8 for the caller's strict TOC parser to reject", async () => {
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0x0a]);
    const tool = fixture("list-v4");
    const descriptor = openTestFileDescriptor(archiveFile(tool.root));
    const authority = await openPostgresToolAuthority(
      options(tool),
      listV4Runner([], invalidUtf8),
    );
    await authority.version();
    const observation = await authority.listV4(descriptor);
    expect(observation.listingBytes).toEqual(invalidUtf8);
    expect(observation.listingSha256).toBe(
      crypto.createHash("sha256").update(invalidUtf8).digest("hex"),
    );
    expect(() => parsePostgresLogicalBackupV4TocListing(observation.listingBytes))
      .toThrowError(PostgresLogicalBackupV4TocError);
    await authority.close();
    fs.closeSync(descriptor);
  });

  it.each([
    ["empty stdout", { stdout: Buffer.alloc(0) }],
    ["stderr byte", { stderr: Buffer.from("warning", "utf8") }],
    ["nonzero exit", { exitCode: 1 }],
    ["over 64 KiB", {
      stdout: Buffer.alloc(POSTGRES_LOGICAL_BACKUP_V4_MAX_TOC_LISTING_BYTES + 1),
    }],
  ] as const)("spends V4 list-only authority on invalid raw completion: %s", async (
    _label,
    completion,
  ) => {
    const tool = fixture("list-v4");
    const descriptor = openTestFileDescriptor(archiveFile(tool.root));
    const invocations: AnyToolInvocation[] = [];
    const rawRunner = (async (invocation: AnyToolInvocation) => {
      invocations.push(invocation);
      return invocation.operation === "list-v4"
        ? rawResult(completion)
        : result(invocation);
    }) as PostgresListV4ToolAuthorityProcessRunner;
    const authority = await openPostgresToolAuthority(options(tool), rawRunner);
    await authority.version();
    await expectCode(authority.listV4(descriptor), "process_failed");
    await expectCode(authority.listV4(descriptor), "invalid_arguments");
    expect(invocations).toHaveLength(2);
    await authority.close();
    fs.closeSync(descriptor);
  });

  it("rejects hostile raw carriers and non-plain Buffer inputs", () => {
    let getterCalls = 0;
    const accessor = {
      exitCode: 0,
      get stdout() {
        getterCalls += 1;
        return Buffer.from("attacker");
      },
      stderr: Buffer.alloc(0),
    };
    expect(() => createPostgresToolRawProcessResultCarrier(
      accessor as unknown as {
        exitCode: number;
        stdout: Buffer;
        stderr: Buffer;
      },
    )).toThrowError(expect.objectContaining({ code: "process_failed" }));
    expect(getterCalls).toBe(0);

    expect(() => createPostgresToolRawProcessResultCarrier(new Proxy({
      exitCode: 0,
      stdout: Buffer.from("attacker"),
      stderr: Buffer.alloc(0),
    }, {}))).toThrowError(expect.objectContaining({ code: "process_failed" }));
    expect(() => createPostgresToolRawProcessResultCarrier({
      exitCode: 0,
      stdout: new Proxy(Buffer.from("attacker"), {}),
      stderr: Buffer.alloc(0),
    })).toThrowError(expect.objectContaining({ code: "process_failed" }));

    const wrongPrototype = Buffer.from("attacker");
    Object.setPrototypeOf(wrongPrototype, Object.create(Buffer.prototype));
    expect(() => createPostgresToolRawProcessResultCarrier({
      exitCode: 0,
      stdout: wrongPrototype,
      stderr: Buffer.alloc(0),
    })).toThrowError(expect.objectContaining({ code: "process_failed" }));

    const extraProperty = Buffer.from("attacker") as Buffer & { extra?: string };
    extraProperty.extra = "ambient";
    expect(() => createPostgresToolRawProcessResultCarrier({
      exitCode: 0,
      stdout: extraProperty,
      stderr: Buffer.alloc(0),
    })).toThrowError(expect.objectContaining({ code: "process_failed" }));
  });

  it.each(["content", "mode", "link"] as const)(
    "rejects V4 list-only archive %s drift during observation",
    async (drift) => {
      const tool = fixture("list-v4");
      const archive = archiveFile(tool.root);
      const descriptor = openTestFileDescriptor(archive);
      const mutationDescriptor = openTestWritableFileDescriptor(archive);
      const authority = await openPostgresToolAuthority(
        options(tool),
        listV4Runner([], validV4TocListing(), (invocation) => {
          if (invocation.operation !== "list-v4") return;
          if (drift === "content") mutateArchiveDescriptor(mutationDescriptor);
          if (drift === "mode") fs.chmodSync(archive, 0o644);
          if (drift === "link") fs.linkSync(archive, `${archive}.second-link`);
        }),
      );
      await authority.version();
      await expectCode(authority.listV4(descriptor), "archive_drift");
      await authority.close();
      fs.closeSync(descriptor);
      fs.closeSync(mutationDescriptor);
    },
  );

  it("rejects replacement of the observed archive descriptor identity", async () => {
    const tool = fixture("list-v4");
    let archiveDescriptor = -1;
    let archiveFstatCalls = 0;
    const deps = dependencies({
      fstat(fileDescriptor) {
        const stat = fs.fstatSync(fileDescriptor, { bigint: true });
        if (fileDescriptor !== archiveDescriptor) return stat;
        archiveFstatCalls += 1;
        return archiveFstatCalls === 1
          ? stat
          : statWith(stat, { ino: stat.ino + 1n });
      },
    });
    const authority = await openPostgresToolAuthority(
      options(tool),
      listV4Runner(),
      deps,
    );
    archiveDescriptor = openTestFileDescriptor(archiveFile(tool.root));
    await authority.version();
    await expectCode(authority.listV4(archiveDescriptor), "archive_drift");
    expect(archiveFstatCalls).toBe(2);
    await authority.close();
    fs.closeSync(archiveDescriptor);
  });

  it("emits only the exact ordered V4 scratch-restore contract", async () => {
    expect(POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_SCRATCH_RESTORE_OPTIONS)
      .toEqual(EXPECTED_V4_SCRATCH_RESTORE_OPTIONS);

    const tool = fixture("restore-v4");
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const authority = await openPostgresToolAuthority(
      options(tool),
      runner(invocations),
    );
    const archive = archiveFile(tool.root);
    const listDescriptor = fs.openSync(archive, "r");
    const restoreDescriptor = openTestFileDescriptor(archive);

    expect(Object.getPrototypeOf(authority)).toBeNull();
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Reflect.ownKeys(authority)).toEqual([
      "version",
      "listV4",
      "restoreV4",
      "assertExact",
      "close",
    ]);
    expect("list" in authority).toBe(false);
    expect("restore" in authority).toBe(false);
    expect("args" in authority).toBe(false);
    expect("runProcess" in authority).toBe(false);

    await expectCode(authority.restoreV4(restoreV4Input(restoreDescriptor)),
      "archive_drift");
    await authority.version();
    await authority.listV4(listDescriptor);
    await authority.restoreV4(restoreV4Input(restoreDescriptor));

    expect(invocations).toHaveLength(3);
    expect(invocations[0]).toMatchObject({
      operation: "version",
      command: tool.file,
      args: ["--version"],
      env: { LC_ALL: "C" },
      timeoutMs: 15_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
    });
    expect(invocations[1]).toMatchObject({
      operation: "list",
      command: tool.file,
      args: ["--list", "--format=custom"],
      env: { LC_ALL: "C" },
      timeoutMs: 5 * 60 * 1_000,
      maxStdoutBytes: 64 * 1_024 * 1_024,
      maxStderrBytes: 1 * 1_024 * 1_024,
      stdinFileDescriptor: listDescriptor,
    });
    expect(invocations[2]).toMatchObject({
      operation: "restore",
      command: tool.file,
      args: [
        "--format=custom",
        "--dbname=",
        ...EXPECTED_V4_SCRATCH_RESTORE_OPTIONS,
      ],
      timeoutMs: 2 * 60 * 60 * 1_000,
      maxStdoutBytes: 1 * 1_024 * 1_024,
      maxStderrBytes: 1 * 1_024 * 1_024,
      stdinFileDescriptor: restoreDescriptor,
    });
    expect(invocations[2]!.args.slice(2))
      .toEqual(POSTGRES_LOGICAL_BACKUP_V4_REQUIRED_SCRATCH_RESTORE_OPTIONS);
    expect(Object.isFrozen(invocations[2]!.args)).toBe(true);
    expect(Object.getPrototypeOf(invocations[2]!.env)).toBeNull();
    expect(Object.isFrozen(invocations[2]!.env)).toBe(true);
    expect(invocations[2]!.env).toEqual({
      LC_ALL: "C",
      PGHOST: "db.example.test",
      PGPORT: "5432",
      PGDATABASE: "pintpath_restore",
      PGUSER: "pintpath_restore",
      PGPASSWORD: "offline-test-secret",
      PGSSLMODE: "verify-full",
      PGGSSENCMODE: "disable",
      PGCONNECT_TIMEOUT: "15",
      PGAPPNAME: "pintpath-logical-restore-rehearsal",
    });
    expect(invocations[2]!.env).not.toHaveProperty("PATH");
    expect(invocations[2]!.env).not.toHaveProperty("LD_PRELOAD");
    expect(invocations[2]!.env).not.toHaveProperty("PGOPTIONS");
    await expectCode(authority.listV4(listDescriptor), "invalid_arguments");
    await expectCode(authority.restoreV4(restoreV4Input(restoreDescriptor)),
      "invalid_arguments");
    await authority.close();
    fs.closeSync(listDescriptor);
    fs.closeSync(restoreDescriptor);
  });

  it("binds V4 scratch restore to a reviewed PostgreSQL 17 pg_restore and rechecks it", async () => {
    const wrongHash = fixture("restore-v4");
    await expectCode(openPostgresToolAuthority({
      purpose: "restore-v4",
      executableFile: wrongHash.file,
      expectedSha256: "0".repeat(64),
    }, runner()), "sha256_mismatch");

    const wrongVersion = fixture("restore-v4");
    const wrongVersionAuthority = await openPostgresToolAuthority(
      options(wrongVersion),
      async (invocation) => result(invocation, {
        stdout: invocation.operation === "version"
          ? "pg_restore (PostgreSQL) 16.9\n"
          : "",
      }),
    );
    const wrongVersionDescriptor = fs.openSync(
      archiveFile(wrongVersion.root),
      "r",
    );
    await expectCode(wrongVersionAuthority.version(), "process_failed");
    await expectCode(wrongVersionAuthority.listV4(wrongVersionDescriptor),
      "invalid_arguments");
    await wrongVersionAuthority.close();
    fs.closeSync(wrongVersionDescriptor);

    const drifted = fixture("restore-v4");
    const archive = archiveFile(drifted.root);
    const listDescriptor = fs.openSync(archive, "r");
    const restoreDescriptor = openTestFileDescriptor(archive);
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const driftedAuthority = await openPostgresToolAuthority(
      options(drifted),
      runner(invocations, (invocation) => {
        if (invocation.operation === "restore") rewrite(drifted.file);
      }),
    );
    await driftedAuthority.version();
    await driftedAuthority.listV4(listDescriptor);
    await expectCode(driftedAuthority.restoreV4(
      restoreV4Input(restoreDescriptor),
    ), "tool_drift");
    expect(invocations).toHaveLength(3);
    await driftedAuthority.close();
    fs.closeSync(listDescriptor);
    fs.closeSync(restoreDescriptor);
  });

  it.each([
    ["nonzero exit", { exitCode: 1, stdout: "TOC entry\n", stderr: "" }],
    ["empty stdout", { exitCode: 0, stdout: "", stderr: "" }],
    ["NUL stdout", { exitCode: 0, stdout: "TOC\0entry", stderr: "" }],
    ["stderr warning", { exitCode: 0, stdout: "TOC entry\n", stderr: "warning" }],
  ] as const)("spends V4 scratch authority on invalid listing: %s", async (
    _label,
    completion,
  ) => {
    const tool = fixture("restore-v4");
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const authority = await openPostgresToolAuthority(
      options(tool),
      async (invocation) => {
        invocations.push(invocation);
        return result(invocation, invocation.operation === "list" ? completion : {});
      },
    );
    const descriptor = fs.openSync(archiveFile(tool.root), "r");
    await authority.version();
    await expectCode(authority.listV4(descriptor), "process_failed");
    await expectCode(authority.listV4(descriptor), "invalid_arguments");
    expect(invocations).toHaveLength(2);
    await authority.close();
    fs.closeSync(descriptor);
  });

  it.each([
    ["nonzero exit", { exitCode: 1, stdout: "", stderr: "" }],
    ["unexpected stdout", { exitCode: 0, stdout: "restored", stderr: "" }],
    ["stderr warning", { exitCode: 0, stdout: "", stderr: "warning" }],
  ] as const)("spends V4 scratch authority on invalid restore completion: %s", async (
    _label,
    completion,
  ) => {
    const tool = fixture("restore-v4");
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const authority = await openPostgresToolAuthority(
      options(tool),
      async (invocation) => {
        invocations.push(invocation);
        return result(
          invocation,
          invocation.operation === "restore" ? completion : {},
        );
      },
    );
    const archive = archiveFile(tool.root);
    const listDescriptor = fs.openSync(archive, "r");
    const restoreDescriptor = openTestFileDescriptor(archive);
    await authority.version();
    await authority.listV4(listDescriptor);
    await expectCode(authority.restoreV4(restoreV4Input(restoreDescriptor)),
      "process_failed");
    await expectCode(authority.restoreV4(restoreV4Input(restoreDescriptor)),
      "invalid_arguments");
    expect(invocations).toHaveLength(3);
    await authority.close();
    fs.closeSync(listDescriptor);
    fs.closeSync(restoreDescriptor);
  });

  it("rejects hostile V4 scratch inputs and same-descriptor reuse without spending valid use", async () => {
    const tool = fixture("restore-v4");
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const authority = await openPostgresToolAuthority(
      options(tool),
      runner(invocations),
    );
    const archive = archiveFile(tool.root, "listed.dump");
    const listDescriptor = fs.openSync(archive, "r");
    const restoreDescriptor = openTestFileDescriptor(archive);
    await authority.version();
    await authority.listV4(listDescriptor);

    await expectCode(authority.restoreV4(new Proxy(
      restoreV4Input(restoreDescriptor),
      {},
    )), "invalid_arguments");

    let accessorCalls = 0;
    const accessorInput = restoreV4Input(restoreDescriptor) as {
      environment: Readonly<Record<string, string>>;
      archiveInputFileDescriptor: number;
    };
    Object.defineProperty(accessorInput, "environment", {
      configurable: true,
      enumerable: true,
      get() {
        accessorCalls += 1;
        return restoreEnvironment();
      },
    });
    await expectCode(authority.restoreV4(accessorInput), "invalid_arguments");
    expect(accessorCalls).toBe(0);

    const symbolInput = restoreV4Input(restoreDescriptor) as
      PostgresRestoreV4OperationInput & { [key: symbol]: string };
    Object.defineProperty(symbolInput, Symbol("ambient-argv"), {
      enumerable: true,
      value: "--clean",
    });
    await expectCode(authority.restoreV4(symbolInput), "invalid_arguments");

    const incompleteEnvironment = restoreEnvironment();
    delete incompleteEnvironment.PGPASSWORD;
    await expectCode(authority.restoreV4(restoreV4Input(
      restoreDescriptor,
      incompleteEnvironment,
    )), "invalid_arguments");
    await expectCode(authority.restoreV4(restoreV4Input(
      restoreDescriptor,
      new Proxy(restoreEnvironment(), {}),
    )), "invalid_arguments");
    await expectCode(authority.restoreV4(restoreV4Input(2)), "invalid_arguments");
    await expectCode(authority.restoreV4(restoreV4Input(listDescriptor)),
      "archive_drift");
    expect(invocations).toHaveLength(2);

    await authority.restoreV4(restoreV4Input(restoreDescriptor));
    expect(invocations).toHaveLength(3);
    await authority.close();
    fs.closeSync(listDescriptor);
    fs.closeSync(restoreDescriptor);
  });

  it.each(["during-list", "between-phases", "during-restore"] as const)(
    "rejects V4 held-archive mutation %s",
    async (phase) => {
      const tool = fixture("restore-v4");
      const archive = archiveFile(tool.root);
      const listDescriptor = fs.openSync(archive, "r");
      const restoreDescriptor = openTestFileDescriptor(archive);
      const mutationDescriptor = openTestWritableFileDescriptor(archive);
      const invocations: PostgresToolAuthorityProcessInvocation[] = [];
      const authority = await openPostgresToolAuthority(
        options(tool),
        runner(invocations, (invocation) => {
          if (
            (phase === "during-list" && invocation.operation === "list")
            || (phase === "during-restore" && invocation.operation === "restore")
          ) mutateArchiveDescriptor(mutationDescriptor);
        }),
      );
      await authority.version();
      if (phase === "during-list") {
        await expectCode(authority.listV4(listDescriptor), "archive_drift");
        expect(invocations).toHaveLength(2);
      } else {
        await authority.listV4(listDescriptor);
        if (phase === "between-phases") mutateArchiveDescriptor(mutationDescriptor);
        await expectCode(authority.restoreV4(restoreV4Input(restoreDescriptor)),
          "archive_drift");
        expect(invocations).toHaveLength(phase === "during-restore" ? 3 : 2);
      }
      await authority.close();
      fs.closeSync(listDescriptor);
      fs.closeSync(restoreDescriptor);
      fs.closeSync(mutationDescriptor);
    },
  );

  it("separates list-only from ordered destructive restore authority", async () => {
    const listTool = fixture("list");
    const listInvocations: PostgresToolAuthorityProcessInvocation[] = [];
    const listAuthority = await openPostgresToolAuthority(
      options(listTool),
      runner(listInvocations),
    );
    const listArchiveDescriptor = fs.openSync(archiveFile(listTool.root), "r");
    expect(Reflect.ownKeys(listAuthority)).toEqual([
      "version",
      "list",
      "assertExact",
      "close",
    ]);
    expect("restore" in listAuthority).toBe(false);
    expect("listV4" in listAuthority).toBe(false);
    expect("restoreV4" in listAuthority).toBe(false);
    await expectCode(listAuthority.list(listArchiveDescriptor), "invalid_arguments");
    await listAuthority.version();
    await listAuthority.list(listArchiveDescriptor);
    expect(listInvocations[1]).toMatchObject({
      operation: "list",
      args: ["--list", "--format=custom"],
      env: { LC_ALL: "C" },
      stdinFileDescriptor: listArchiveDescriptor,
      maxStdoutBytes: 32 * 1_024 * 1_024,
      maxStderrBytes: 512 * 1_024,
    });
    await expectCode(listAuthority.list(listArchiveDescriptor), "invalid_arguments");
    await listAuthority.close();
    fs.closeSync(listArchiveDescriptor);

    const restoreTool = fixture("restore");
    const restoreInvocations: PostgresToolAuthorityProcessInvocation[] = [];
    const restoreAuthority = await openPostgresToolAuthority(
      options(restoreTool),
      runner(restoreInvocations),
    );
    const restoreArchive = archiveFile(restoreTool.root);
    const restoreListDescriptor = fs.openSync(restoreArchive, "r");
    const restoreMutationDescriptor = openTestFileDescriptor(restoreArchive);
    expect(Reflect.ownKeys(restoreAuthority)).toEqual([
      "version",
      "list",
      "restore",
      "assertExact",
      "close",
    ]);
    expect("listV4" in restoreAuthority).toBe(false);
    expect("restoreV4" in restoreAuthority).toBe(false);
    await restoreAuthority.version();
    await expectCode(restoreAuthority.restore({
      environment: restoreEnvironment(),
      archiveInputFileDescriptor: restoreMutationDescriptor,
    }), "archive_drift");
    await restoreAuthority.list(restoreListDescriptor);
    await expectCode(restoreAuthority.restore({
      environment: restoreEnvironment(),
      archiveInputFileDescriptor: restoreListDescriptor,
    }), "archive_drift");
    expect(restoreInvocations).toHaveLength(2);
    await restoreAuthority.restore({
      environment: restoreEnvironment(),
      archiveInputFileDescriptor: restoreMutationDescriptor,
    });
    expect(restoreInvocations[1]).toMatchObject({
      maxStdoutBytes: 64 * 1_024 * 1_024,
      maxStderrBytes: 1_024 * 1_024,
    });
    expect(restoreInvocations[2]).toMatchObject({
      operation: "restore",
      args: [
        "--format=custom",
        "--dbname=",
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
        "--single-transaction",
        "--no-password",
      ],
      stdinFileDescriptor: restoreMutationDescriptor,
      env: {
        LC_ALL: "C",
        PGHOST: "db.example.test",
        PGPORT: "5432",
        PGDATABASE: "pintpath_restore",
        PGUSER: "pintpath_restore",
        PGPASSWORD: "offline-test-secret",
        PGSSLMODE: "verify-full",
        PGGSSENCMODE: "disable",
        PGCONNECT_TIMEOUT: "15",
        PGAPPNAME: "pintpath-logical-restore-rehearsal",
      },
    });
    expect(restoreInvocations[2]!.env).not.toHaveProperty("PATH");
    expect(restoreInvocations[2]!.env).not.toHaveProperty("LD_PRELOAD");
    await restoreAuthority.close();
    fs.closeSync(restoreListDescriptor);
    fs.closeSync(restoreMutationDescriptor);
  });

  it("binds restore to a distinct descriptor for the stable archive identity listed", async () => {
    const tool = fixture("restore");
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const authority = await openPostgresToolAuthority(
      options(tool),
      runner(invocations),
    );
    const listedFile = archiveFile(tool.root, "listed.dump");
    const otherFile = archiveFile(tool.root, "other.dump");
    const listedDescriptor = fs.openSync(listedFile, "r");
    const otherDescriptor = fs.openSync(otherFile, "r");
    await authority.version();
    await authority.list(listedDescriptor);
    await expectCode(authority.restore({
      environment: restoreEnvironment(),
      archiveInputFileDescriptor: otherDescriptor,
    }), "archive_drift");
    expect(invocations).toHaveLength(2);
    await authority.close();
    fs.closeSync(listedDescriptor);
    fs.closeSync(otherDescriptor);
  });

  it.each(["during-list", "between-phases", "during-restore"] as const)(
    "rejects ordinary held-archive mutation %s",
    async (phase) => {
      const tool = fixture("restore");
      const archive = archiveFile(tool.root);
      const listDescriptor = fs.openSync(archive, "r");
      const restoreDescriptor = openTestFileDescriptor(archive);
      const mutationDescriptor = openTestWritableFileDescriptor(archive);
      const invocations: PostgresToolAuthorityProcessInvocation[] = [];
      const authority = await openPostgresToolAuthority(
        options(tool),
        runner(invocations, (invocation) => {
          if (
            (phase === "during-list" && invocation.operation === "list")
            || (phase === "during-restore" && invocation.operation === "restore")
          ) mutateArchiveDescriptor(mutationDescriptor);
        }),
      );
      await authority.version();
      if (phase === "during-list") {
        await expectCode(authority.list(listDescriptor), "archive_drift");
        expect(invocations).toHaveLength(2);
      } else {
        await authority.list(listDescriptor);
        if (phase === "between-phases") mutateArchiveDescriptor(mutationDescriptor);
        await expectCode(authority.restore({
          environment: restoreEnvironment(),
          archiveInputFileDescriptor: restoreDescriptor,
        }), "archive_drift");
        expect(invocations).toHaveLength(phase === "during-restore" ? 3 : 2);
      }
      await authority.close();
      fs.closeSync(listDescriptor);
      fs.closeSync(restoreDescriptor);
      fs.closeSync(mutationDescriptor);
    },
  );

  it("rejects an unsafe list archive before invoking pg_restore", async () => {
    const tool = fixture("list");
    const invocations: PostgresToolAuthorityProcessInvocation[] = [];
    const authority = await openPostgresToolAuthority(
      options(tool),
      runner(invocations),
    );
    const unsafeArchive = archiveFile(tool.root);
    fs.chmodSync(unsafeArchive, 0o644);
    const descriptor = fs.openSync(unsafeArchive, "r");
    await authority.version();
    await expectCode(authority.list(descriptor), "archive_drift");
    expect(invocations).toHaveLength(1);
    await authority.close();
    fs.closeSync(descriptor);
  });

  it.each([
    ["uppercase", TOOL_SHA256.toUpperCase()],
    ["leading whitespace", ` ${TOOL_SHA256}`],
    ["trailing whitespace", `${TOOL_SHA256}\n`],
    ["short", TOOL_SHA256.slice(0, 63)],
  ])("rejects a noncanonical SHA-256 pin: %s", async (_label, pin) => {
    const tool = fixture();
    await expectCode(openPostgresToolAuthority(options(tool, pin), runner()),
      "invalid_arguments");
  });

  it("rejects a lowercase but incorrect SHA-256 and closes the opened descriptor", async () => {
    const tool = fixture();
    let held = -1;
    let closed = false;
    const deps = dependencies({
      open(filename, flags) {
        held = fs.openSync(filename, flags);
        return held;
      },
      close(fileDescriptor) {
        expect(fileDescriptor).toBe(held);
        fs.closeSync(fileDescriptor);
        closed = true;
      },
    });
    await expectCode(openPostgresToolAuthority(
      options(tool, "0".repeat(64)),
      runner(),
      deps,
    ), "sha256_mismatch");
    expect(closed).toBe(true);
    expect(() => fs.fstatSync(held)).toThrow();
  });

  it.each([
    ["dump 170.x", "dump", "pg_dump (PostgreSQL) 170.1\n", ""],
    ["dump 17evil", "dump", "pg_dump (PostgreSQL) 17evil\n", ""],
    ["dump 17.10evil", "dump", "pg_dump (PostgreSQL) 17.10evil\n", ""],
    ["dump wrong tool", "dump", "pg_restore (PostgreSQL) 17.10\n", ""],
    ["restore wrong tool", "restore", "pg_dump (PostgreSQL) 17.10\n", ""],
    ["stderr", "dump", "pg_dump (PostgreSQL) 17.10\n", "warning"],
    ["multiline", "dump", "pg_dump (PostgreSQL) 17.10\nsecond\n", ""],
    ["leading padding", "dump", " pg_dump (PostgreSQL) 17.10\n", ""],
    ["trailing padding", "dump", "pg_dump (PostgreSQL) 17.10 \n", ""],
  ] as const)("spends authority on invalid version evidence: %s", async (
    _label,
    purpose,
    stdout,
    stderr,
  ) => {
    const tool = fixture(purpose);
    const authority = await openPostgresToolAuthority(
      options(tool),
      async (invocation) => result(invocation, { stdout, stderr }),
    );
    await expectCode(authority.version(), "process_failed");
    await expectCode(authority.version(), "invalid_arguments");
    await authority.close();
  });

  it("takes cleanup custody of a rejected stdio-number descriptor without using it", async () => {
    const tool = fixture();
    const closed: number[] = [];
    const deps = dependencies({
      open: () => 1,
      close(fileDescriptor) {
        closed.push(fileDescriptor);
      },
      fstat() {
        throw new Error("must-not-fstat-stdio");
      },
    });
    await expectCode(openPostgresToolAuthority(
      options(tool),
      runner(),
      deps,
    ), "unsafe_executable");
    expect(closed).toEqual([1]);
  });

  it("rejects relative, nonnormalized, noncanonical, symlink, and wrong-basename paths", async () => {
    const relative = fixture();
    await expectCode(openPostgresToolAuthority({
      purpose: "dump",
      executableFile: path.relative(process.cwd(), relative.file),
      expectedSha256: TOOL_SHA256,
    }, runner()), "unsafe_executable");

    const nonnormalized = fixture();
    await expectCode(openPostgresToolAuthority({
      purpose: "dump",
      executableFile: `${nonnormalized.root}/missing/../pg_dump`,
      expectedSha256: TOOL_SHA256,
    }, runner()), "unsafe_executable");

    const canonical = fixture();
    const symlinkDirectory = path.join(canonical.root, "linked");
    fs.symlinkSync(canonical.root, symlinkDirectory);
    await expectCode(openPostgresToolAuthority({
      purpose: "dump",
      executableFile: path.join(symlinkDirectory, "pg_dump"),
      expectedSha256: TOOL_SHA256,
    }, runner()), "unsafe_executable");

    const symlink = fixture();
    fs.renameSync(symlink.file, `${symlink.file}.real`);
    fs.symlinkSync(`${symlink.file}.real`, symlink.file);
    await expectCode(openPostgresToolAuthority(options(symlink), runner()),
      "unsafe_executable");

    const wrong = fixture();
    const wrongName = path.join(wrong.root, "postgres-tool");
    fs.renameSync(wrong.file, wrongName);
    await expectCode(openPostgresToolAuthority({
      purpose: "dump",
      executableFile: wrongName,
      expectedSha256: TOOL_SHA256,
    }, runner()), "unsafe_executable");
  });

  it("rejects directory, FIFO, empty, oversized, hard-linked, and unsafe-mode files", async () => {
    const directory = fixture();
    fs.unlinkSync(directory.file);
    fs.mkdirSync(directory.file, { mode: 0o555 });
    await expectCode(openPostgresToolAuthority(options(directory), runner()),
      "unsafe_executable");

    const fifo = fixture();
    fs.unlinkSync(fifo.file);
    execFileSync("mkfifo", [fifo.file]);
    await expectCode(openPostgresToolAuthority(options(fifo), runner()),
      "unsafe_executable");

    const empty = fixture("dump", Buffer.alloc(0));
    await expectCode(openPostgresToolAuthority(options(empty), runner()),
      "unsafe_executable");

    const oversized = fixture();
    fs.chmodSync(oversized.file, 0o755);
    fs.truncateSync(oversized.file, POSTGRES_TOOL_AUTHORITY_MAXIMUM_BYTES + 1);
    fs.chmodSync(oversized.file, 0o555);
    await expectCode(openPostgresToolAuthority(options(oversized), runner()),
      "unsafe_executable");

    const linked = fixture();
    fs.linkSync(linked.file, `${linked.file}.second-link`);
    await expectCode(openPostgresToolAuthority(options(linked), runner()),
      "unsafe_executable");

    for (const mode of [0o755, 0o550, 0o777]) {
      const unsafeMode = fixture();
      fs.chmodSync(unsafeMode.file, mode);
      await expectCode(openPostgresToolAuthority(options(unsafeMode), runner()),
        "unsafe_executable");
    }
  });

  it("enforces current-owner 0555 or root-owned 0555/0755 policy", async () => {
    const wrongOwner = fixture();
    const wrongOwnerDeps = dependencies({
      lstat(filename) {
        return statWith(fs.lstatSync(filename, { bigint: true }), {
          uid: BigInt(UID + 1),
        });
      },
      fstat(fileDescriptor) {
        return statWith(fs.fstatSync(fileDescriptor, { bigint: true }), {
          uid: BigInt(UID + 1),
        });
      },
    });
    await expectCode(openPostgresToolAuthority(
      options(wrongOwner),
      runner(),
      wrongOwnerDeps,
    ), "unsafe_executable");

    for (const permissions of [0o555n, 0o755n]) {
      const rootOwned = fixture();
      const rootDeps = dependencies({
        lstat(filename) {
          const stat = fs.lstatSync(filename, { bigint: true });
          return statWith(stat, {
            uid: 0n,
            mode: (stat.mode & ~0o7777n) | permissions,
          });
        },
        fstat(fileDescriptor) {
          const stat = fs.fstatSync(fileDescriptor, { bigint: true });
          return statWith(stat, {
            uid: 0n,
            mode: (stat.mode & ~0o7777n) | permissions,
          });
        },
      });
      const authority = await openPostgresToolAuthority(
        options(rootOwned),
        runner(),
        rootDeps,
      );
      await authority.close();
    }
  });

  it("detects open-target and post-open path races across exact BigInt identity", async () => {
    const wrongOpen = fixture();
    const other = path.join(wrongOpen.root, "other-binary");
    fs.writeFileSync(other, TOOL_BYTES, { mode: 0o555 });
    fs.chmodSync(other, 0o555);
    await expectCode(openPostgresToolAuthority(
      options(wrongOpen),
      runner(),
      dependencies({ open: (_filename, flags) => fs.openSync(other, flags) }),
    ), "unsafe_executable");

    const postOpen = fixture();
    let lstatCalls = 0;
    await expectCode(openPostgresToolAuthority(
      options(postOpen),
      runner(),
      dependencies({
        lstat(filename) {
          lstatCalls += 1;
          if (lstatCalls === 2) rewrite(filename);
          return fs.lstatSync(filename, { bigint: true });
        },
      }),
    ), "unsafe_executable");
  });

  it("detects mutation before, during, and immediately after an operation", async () => {
    const before = fixture();
    let beforeRuns = 0;
    const beforeAuthority = await openPostgresToolAuthority(
      options(before),
      runner([], () => { beforeRuns += 1; }),
    );
    rewrite(before.file);
    await expectCode(beforeAuthority.version(), "tool_drift");
    expect(beforeRuns).toBe(0);
    await beforeAuthority.close();

    const during = fixture();
    const duringAuthority = await openPostgresToolAuthority(
      options(during),
      runner([], () => rewrite(during.file)),
    );
    await expectCode(duringAuthority.version(), "tool_drift");
    await duringAuthority.close();

    const replaced = fixture();
    const replacedAuthority = await openPostgresToolAuthority(
      options(replaced),
      runner([], () => {
        fs.renameSync(replaced.file, `${replaced.file}.original`);
        fs.writeFileSync(replaced.file, TOOL_BYTES, { mode: 0o555 });
        fs.chmodSync(replaced.file, 0o555);
      }),
    );
    await expectCode(replacedAuthority.version(), "tool_drift");
    await replacedAuthority.close();
  });

  it("retains the exact raw descriptor through process settlement and closes it once", async () => {
    const tool = fixture();
    let held = -1;
    let closed = false;
    let closeCalls = 0;
    const deps = dependencies({
      open(filename, flags) {
        held = fs.openSync(filename, flags);
        return held;
      },
      close(fileDescriptor) {
        closeCalls += 1;
        fs.closeSync(fileDescriptor);
        closed = true;
      },
    });
    const authority = await openPostgresToolAuthority(
      options(tool),
      runner([], () => {
        expect(closed).toBe(false);
        expect(fs.fstatSync(held, { bigint: true }).isFile()).toBe(true);
      }),
      deps,
    );
    await authority.version();
    expect(closed).toBe(false);
    const closing = authority.close();
    expect(closed).toBe(true);
    await closing;
    expect(closed).toBe(true);
    expect(closeCalls).toBe(1);
    await authority.close();
    expect(closeCalls).toBe(1);
  });

  it("makes cleanup failure dominate both open failure and explicit close", async () => {
    const failedOpen = fixture();
    let openCloseCalls = 0;
    const openDeps = dependencies({
      close(fileDescriptor) {
        openCloseCalls += 1;
        fs.closeSync(fileDescriptor);
        throw new Error("ambiguous-close-after-release");
      },
    });
    await expectCode(openPostgresToolAuthority(
      options(failedOpen, "0".repeat(64)),
      runner(),
      openDeps,
    ), "cleanup_failed");
    expect(openCloseCalls).toBe(1);

    const explicit = fixture();
    let closeCalls = 0;
    let held = -1;
    const closeDeps = dependencies({
      open(filename, flags) {
        held = fs.openSync(filename, flags);
        return held;
      },
      close(fileDescriptor) {
        closeCalls += 1;
        fs.closeSync(fileDescriptor);
        throw new Error("ambiguous-close-after-release");
      },
    });
    const authority = await openPostgresToolAuthority(
      options(explicit),
      runner(),
      closeDeps,
    );
    await expectCode(authority.close(), "cleanup_failed");
    expect(closeCalls).toBe(1);
    expect(() => fs.fstatSync(held)).toThrow();
    await expectCode(authority.close(), "cleanup_failed");
    expect(closeCalls).toBe(1);
  });

  it("makes post-operation reassertion dominate a simultaneous process failure", async () => {
    const tool = fixture();
    const authority = await openPostgresToolAuthority(
      options(tool),
      (async () => {
        rewrite(tool.file);
        throw new Error("process-failed-too");
      }) as PostgresToolAuthorityProcessRunner,
    );
    await expectCode(authority.version(), "tool_drift");
    await authority.close();
  });

  it("requires the branded null-prototype result carrier and rejects raw thenables", async () => {
    const ordinary = fixture();
    const ordinaryAuthority = await openPostgresToolAuthority(
      options(ordinary),
      (async (invocation) => ({
        exitCode: 0,
        stdout: versionOutput(invocation),
        stderr: "",
      })) as unknown as PostgresToolAuthorityProcessRunner,
    );
    await expectCode(ordinaryAuthority.version(), "process_failed");
    await ordinaryAuthority.close();

    const thenable = fixture();
    let thenCalls = 0;
    const thenableAuthority = await openPostgresToolAuthority(
      options(thenable),
      (() => ({
        then() {
          thenCalls += 1;
        },
      })) as unknown as PostgresToolAuthorityProcessRunner,
    );
    await expectCode(thenableAuthority.version(), "process_failed");
    expect(thenCalls).toBe(0);
    await thenableAuthority.close();
  });

  it("rejects a native runner Promise with an own constructor accessor without invoking it", async () => {
    const tool = fixture();
    const carrier = createPostgresToolProcessResultCarrier({
      exitCode: 0,
      stdout: "pg_dump (PostgreSQL) 17.10\n",
      stderr: "",
    });
    const pending = Promise.resolve(carrier);
    let constructorGetterCalls = 0;
    Object.defineProperty(pending, "constructor", {
      configurable: true,
      get() {
        constructorGetterCalls += 1;
        throw new Error("runner-promise-constructor-must-not-run");
      },
    });
    const authority = await openPostgresToolAuthority(
      options(tool),
      () => pending,
    );
    await expectCode(authority.version(), "process_failed");
    expect(constructorGetterCalls).toBe(0);
    await authority.close();
  });

  it("does not assimilate inherited then from stats, carrier, or returned facade", async () => {
    const tool = fixture();
    const carrier = createPostgresToolProcessResultCarrier({
      exitCode: 0,
      stdout: "pg_dump (PostgreSQL) 17.10\n",
      stderr: "",
    });
    let thenCalls = 0;
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, "then");
    Object.defineProperty(Object.prototype, "then", {
      configurable: true,
      value() {
        thenCalls += 1;
        throw new Error("inherited-then-must-not-run");
      },
    });
    try {
      const authority = await openPostgresToolAuthority(
        options(tool),
        () => new Promise((resolve) => resolve(carrier)),
      );
      await authority.version();
      await authority.close();
    } finally {
      if (prior === undefined) Reflect.deleteProperty(Object.prototype, "then");
      else Object.defineProperty(Object.prototype, "then", prior);
    }
    expect(thenCalls).toBe(0);
  });

  it("rejects accessor inputs without consulting inherited descriptor value", async () => {
    const tool = fixture();
    const ObjectExact = Object;
    const prior = ObjectExact.getOwnPropertyDescriptor(ObjectExact.prototype, "value");
    let inheritedValueReads = 0;
    let inputGetterCalls = 0;
    ObjectExact.defineProperty(ObjectExact.prototype, "value", {
      configurable: true,
      get() {
        inheritedValueReads += 1;
        throw new Error("inherited-descriptor-value");
      },
    });
    let invalidOptions: Promise<unknown>;
    try {
      const accessorOptions = {
        get purpose() {
          inputGetterCalls += 1;
          return "dump";
        },
        executableFile: tool.file,
        expectedSha256: TOOL_SHA256,
      } as const;
      invalidOptions = openPostgresToolAuthority(
        accessorOptions,
        runner(),
      );
    } finally {
      if (prior === undefined) {
        Reflect.deleteProperty(ObjectExact.prototype, "value");
      } else {
        ObjectExact.defineProperty(ObjectExact.prototype, "value", prior);
      }
    }
    await expectCode(invalidOptions!, "invalid_arguments");
    expect(inputGetterCalls).toBe(0);
    expect(inheritedValueReads).toBe(0);

    const authority = await openPostgresToolAuthority(options(tool), runner());
    await authority.version();
    const poisonedEnvironment = dumpEnvironment();
    ObjectExact.defineProperty(poisonedEnvironment, "PGHOST", {
      configurable: true,
      enumerable: true,
      get() {
        inputGetterCalls += 1;
        return "attacker";
      },
    });
    ObjectExact.defineProperty(ObjectExact.prototype, "value", {
      configurable: true,
      get() {
        inheritedValueReads += 1;
        throw new Error("inherited-descriptor-value");
      },
    });
    let invalidEnvironment: Promise<unknown>;
    try {
      invalidEnvironment = authority.dump(dumpInput(poisonedEnvironment));
    } finally {
      if (prior === undefined) {
        Reflect.deleteProperty(ObjectExact.prototype, "value");
      } else {
        ObjectExact.defineProperty(ObjectExact.prototype, "value", prior);
      }
    }
    await expectCode(invalidEnvironment!, "invalid_arguments");
    expect(inputGetterCalls).toBe(0);
    expect(inheritedValueReads).toBe(0);
    await authority.close();

    const accessorResult = {
      get exitCode() {
        inputGetterCalls += 1;
        return 0;
      },
      stdout: "pg_dump (PostgreSQL) 17.10\n",
      stderr: "",
    };
    ObjectExact.defineProperty(ObjectExact.prototype, "value", {
      configurable: true,
      get() {
        inheritedValueReads += 1;
        throw new Error("inherited-descriptor-value");
      },
    });
    let resultFailure: unknown = null;
    try {
      createPostgresToolProcessResultCarrier(
        accessorResult as unknown as { exitCode: number; stdout: string; stderr: string },
      );
    } catch (error) {
      resultFailure = error;
    } finally {
      if (prior === undefined) {
        Reflect.deleteProperty(ObjectExact.prototype, "value");
      } else {
        ObjectExact.defineProperty(ObjectExact.prototype, "value", prior);
      }
    }
    expect(resultFailure).toMatchObject({ code: "process_failed" });
    expect(inputGetterCalls).toBe(0);
    expect(inheritedValueReads).toBe(0);
  });

  it("uses captured globals and node module methods after post-import replacement", () => {
    const tool = fixture();
    const moduleFile = path.join(
      process.cwd(),
      "src/lib/postgres-tool-authority.ts",
    );
    const script = String.raw`
      import crypto from "node:crypto";
      import fs from "node:fs";
      import path from "node:path";
      import process from "node:process";
      import { pathToFileURL } from "node:url";
      const [moduleFile, toolFile, expectedSha256] = process.argv.slice(1);
      const authorityModule = await import(pathToFileURL(moduleFile).href);
      const ObjectExact = Object;
      const ReflectExact = Reflect;
      const PromiseExact = Promise;
      const BufferExact = Buffer;
      const TypedArrayPrototypeExact = ObjectExact.getPrototypeOf(Uint8Array.prototype);
      const carrier = authorityModule.createPostgresToolProcessResultCarrier({
        exitCode: 0,
        stdout: "pg_dump (PostgreSQL) 17.10\n",
        stderr: "",
      });
      const globalNames = [
        "Object", "Reflect", "Promise", "Number", "BigInt", "Math", "Symbol", "Buffer",
        "String", "Array", "Uint8Array", "RegExp"
      ];
      const globalDescriptors = globalNames.map((name) =>
        ObjectExact.getOwnPropertyDescriptor(globalThis, name));
      let trapCalls = 0;
      const poisoned = () => {
        trapCalls += 1;
        throw new Error("post-import-live-capability");
      };
      const moduleTargets = [
        [fs, "lstatSync"], [fs, "openSync"], [fs, "fstatSync"],
        [fs, "readSync"], [fs, "closeSync"], [fs.realpathSync, "native"],
        [fs, "realpathSync"],
        [path, "basename"], [path, "isAbsolute"], [path, "normalize"], [path, "resolve"],
        [crypto, "createHash"], [process, "geteuid"],
        [PromiseExact.prototype, "then"],
        [BufferExact, "alloc"], [BufferExact, "byteLength"],
        [BufferExact.prototype, "subarray"],
        [TypedArrayPrototypeExact, "length"],
      ];
      const moduleDescriptors = moduleTargets.map(([target, key]) =>
        ObjectExact.getOwnPropertyDescriptor(target, key));
      try {
        for (const [target, key] of moduleTargets) {
          ObjectExact.defineProperty(target, key, {
            configurable: true,
            value: poisoned,
            writable: true,
          });
        }
        for (const name of globalNames) {
          ObjectExact.defineProperty(globalThis, name, {
            configurable: true,
            value: new Proxy(function poison() {}, {
              apply: poisoned,
              get: poisoned,
            }),
            writable: true,
          });
        }
        const authority = await authorityModule.openPostgresToolAuthority({
          purpose: "dump",
          executableFile: toolFile,
          expectedSha256,
        }, () => new PromiseExact((resolve) => resolve(carrier)));
        await authority.version();
        await authority.close();
      } finally {
        for (let index = 0; index < globalNames.length; index += 1) {
          const descriptor = globalDescriptors[index];
          if (descriptor === undefined) {
            ReflectExact.deleteProperty(globalThis, globalNames[index]);
          } else {
            ObjectExact.defineProperty(globalThis, globalNames[index], descriptor);
          }
        }
        for (let index = 0; index < moduleTargets.length; index += 1) {
          const [target, key] = moduleTargets[index];
          const descriptor = moduleDescriptors[index];
          if (descriptor === undefined) ReflectExact.deleteProperty(target, key);
          else ObjectExact.defineProperty(target, key, descriptor);
        }
      }
      if (trapCalls !== 0) throw new Error("post-import-trap-called");
      process.stdout.write("ok");
    `;
    const output = execFileSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
      moduleFile,
      tool.file,
      TOOL_SHA256,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output).toBe("ok");
  });

  it("spends authority on a bad version and blocks restore after a failed list", async () => {
    const badVersion = fixture("dump");
    const badVersionAuthority = await openPostgresToolAuthority(
      options(badVersion),
      async (invocation) => result(invocation, {
        stdout: "pg_dump (PostgreSQL) 16.9\n",
      }),
    );
    await expectCode(badVersionAuthority.version(), "process_failed");
    await expectCode(badVersionAuthority.dump(dumpInput()), "invalid_arguments");
    await badVersionAuthority.close();

    const failedList = fixture("restore");
    const failedListAuthority = await openPostgresToolAuthority(
      options(failedList),
      async (invocation) => result(invocation, invocation.operation === "list"
        ? { exitCode: 1, stdout: "", stderr: "invalid archive" }
        : {}),
    );
    const failedArchive = archiveFile(failedList.root);
    const failedListDescriptor = fs.openSync(failedArchive, "r");
    const failedRestoreDescriptor = openTestFileDescriptor(failedArchive);
    await failedListAuthority.version();
    await expectCode(failedListAuthority.list(failedListDescriptor), "process_failed");
    await expectCode(failedListAuthority.restore({
      environment: restoreEnvironment(),
      archiveInputFileDescriptor: failedRestoreDescriptor,
    }), "archive_drift");
    await failedListAuthority.close();
    fs.closeSync(failedListDescriptor);
    fs.closeSync(failedRestoreDescriptor);
  });
});
