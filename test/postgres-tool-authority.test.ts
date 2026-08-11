import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  POSTGRES_TOOL_AUTHORITY_MAXIMUM_BYTES,
  createPostgresToolProcessResultCarrier,
  openPostgresToolAuthority,
  type PostgresDumpOperationInput,
  type PostgresToolAuthorityFailureCode,
  type PostgresToolAuthorityProcessInvocation,
  type PostgresToolAuthorityProcessRunner,
  type PostgresToolAuthorityPurpose,
  type PostgresToolAuthorityTestFileSystemDependencies,
} from "../src/lib/postgres-tool-authority.js";

const UID = process.geteuid?.() ?? -1;
const TOOL_BYTES = Buffer.from("reviewed-postgresql-17-tool\n", "utf8");
const TOOL_SHA256 = crypto.createHash("sha256").update(TOOL_BYTES).digest("hex");
const roots: string[] = [];

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
  const file = path.join(root, purpose === "dump" ? "pg_dump" : "pg_restore");
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
