import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runPostgresLogicalBackupCli,
  type PostgresLogicalBackupCliDependencies,
} from "../scripts/backup-postgres-logical.js";
import {
  canonicalPostgresBackupJson,
  createPostgresLogicalBackup,
  POSTGRES_LOGICAL_BACKUP_ARCHIVE,
  POSTGRES_LOGICAL_BACKUP_MANIFEST,
  POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
  PostgresLogicalBackupError,
  postgresLogicalBackupManifestBindingSha256,
  runPostgresBackupProcess,
  type CreatePostgresLogicalBackupOptions,
  type PostgresLogicalBackupDependencies,
  type PostgresLogicalBackupManifest,
  type PostgresLogicalBackupManifestV2,
  type PostgresLogicalBackupManifestV3,
  type ProcessInvocation,
  type RawProcessInvocation,
} from "../src/lib/postgres-logical-backup.js";
import {
  PostgresToolAuthorityError,
  createPostgresToolProcessResultCarrier,
  type PostgresDumpOperationInput,
  type PostgresDumpToolAuthority,
  type PostgresListToolAuthority,
  type PostgresToolProcessResult,
} from "../src/lib/postgres-tool-authority.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  PostgresRailwayStockLocalhostCaError,
  type OpenPostgresRailwayStockLocalhostCaTransportOptions,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import { sha256PostgresMigrationContract } from "../src/db/postgres-migration-schema.js";
import type { PostgresLogicalStateInventory } from "../src/lib/postgres-logical-state.js";
import { writeLogicalOffsiteFixture } from "./postgres-logical-offsite.fixtures.js";

const temporaryDirectories: string[] = [];
const connectionSecret = "logical-backup-secret";
const backupDatabaseOid = "16655";
const backupRole = `pintpath_logical_backup_d${backupDatabaseOid}`;
const backupLogin = `${backupRole}_v20260808`;
const sourceHostname = "postgres-staging.railway.internal";
const directTlsUrl = `postgresql://${backupLogin}:${connectionSecret}@${sourceHostname}:5432/pintpath?sslmode=verify-full`;
const testResolvedAddress = "fd12:3456:789a::10";
const testRootCaDerSha256 = "a".repeat(64);
const testRootCaPem = "test-only-public-root-ca\n";
const testPgDumpFile = "/reviewed/postgresql/17/bin/pg_dump";
const testPgDumpSha256 = crypto.createHash("sha256")
  .update("reviewed-test-pg-dump", "utf8")
  .digest("hex");
const testPgRestoreFile = "/reviewed/postgresql/17/bin/pg_restore";
const testPgRestoreSha256 = crypto.createHash("sha256")
  .update("reviewed-test-pg-restore", "utf8")
  .digest("hex");
const requiredTransportOptions = Object.freeze({
  transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  rootCaFile: "/private/railway-root-ca.pem",
  expectedRootCaDerSha256: testRootCaDerSha256,
});
const requiredToolOptions = Object.freeze({
  pgDumpFile: testPgDumpFile,
  expectedPgDumpSha256: testPgDumpSha256,
  pgRestoreFile: testPgRestoreFile,
  expectedPgRestoreSha256: testPgRestoreSha256,
});

interface TransportTestControl {
  assertions?: number;
  failAssertionAt?: number;
  closeFails?: boolean;
  events?: string[];
}

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pintpath-postgres-backup-test-"),
  );
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function openTestFileDescriptor(filePath: string, flags: number): number {
  return fs.openSync(filePath, flags);
}

async function openTestTransport(
  options: OpenPostgresRailwayStockLocalhostCaTransportOptions,
  control: TransportTestControl = {},
): Promise<PostgresRailwayStockLocalhostCaTransport> {
  control.events?.push("transport.open");
  expect(options).toEqual({
    profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    rootCaFile: path.resolve(requiredTransportOptions.rootCaFile),
    expectedRootCaDerSha256: testRootCaDerSha256,
    expectedUid: process.getuid?.() ?? -1,
    sourceUrlAuthority: { hostname: sourceHostname, port: 5_432 },
  });
  const directory = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    "pintpath-railway-stock-localhost-ca-test-",
  ));
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  const rootCaPath = path.join(directory, "railway-root-ca.pem");
  fs.writeFileSync(rootCaPath, testRootCaPem, { mode: 0o600 });
  fs.chmodSync(rootCaPath, 0o600);
  const directoryStat = fs.statSync(directory);
  const rootCaStat = fs.statSync(rootCaPath);
  let state: "open" | "closing" | "closed" = "open";
  let closePromise: Promise<void> | null = null;

  const transport: PostgresRailwayStockLocalhostCaTransport = {
    profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    rootCaDerSha256: testRootCaDerSha256,
    sourceUrlAuthority: Object.freeze({ ...options.sourceUrlAuthority }),
    resolvedAddress: testResolvedAddress,
    temporaryDirectory: directory,
    passwordFileDirectory: directory,
    passwordFileHost: "localhost",
    nodeConnection: Object.freeze({
      host: testResolvedAddress,
      port: 5_432,
      ssl: Object.freeze({
        ca: testRootCaPem,
        servername: "localhost",
        rejectUnauthorized: true as const,
        minVersion: "TLSv1.2" as const,
        checkServerIdentity: () => undefined,
      }),
    }),
    libpqEnvironment: Object.freeze({
      PGHOST: "localhost",
      PGHOSTADDR: testResolvedAddress,
      PGPORT: "5432",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: rootCaPath,
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLSNI: "1",
    }),
    assertExact: async () => {
      control.events?.push("transport.assert");
      control.assertions = (control.assertions ?? 0) + 1;
      if (control.failAssertionAt === control.assertions) {
        throw new PostgresRailwayStockLocalhostCaError("transport_drift");
      }
      try {
        const currentDirectory = fs.lstatSync(directory);
        const currentRootCa = fs.lstatSync(rootCaPath);
        const entries = fs.readdirSync(directory).sort();
        if (
          state !== "open"
          || !currentDirectory.isDirectory()
          || currentDirectory.dev !== directoryStat.dev
          || currentDirectory.ino !== directoryStat.ino
          || (currentDirectory.mode & 0o7777) !== 0o700
          || !currentRootCa.isFile()
          || currentRootCa.dev !== rootCaStat.dev
          || currentRootCa.ino !== rootCaStat.ino
          || currentRootCa.nlink !== 1
          || (currentRootCa.mode & 0o7777) !== 0o600
          || fs.readFileSync(rootCaPath, "utf8") !== testRootCaPem
          || entries.some((entry) => !["pgpass", "railway-root-ca.pem"].includes(entry))
        ) throw new Error("drift");
      } catch {
        throw new PostgresRailwayStockLocalhostCaError("transport_drift");
      }
    },
    close: () => {
      if (closePromise) return closePromise;
      state = "closing";
      closePromise = (async () => {
        control.events?.push("transport.close");
        let exact = true;
        try {
          const current = fs.lstatSync(rootCaPath);
          if (
            !current.isFile()
            || current.dev !== rootCaStat.dev
            || current.ino !== rootCaStat.ino
          ) {
            exact = false;
          } else {
            if (
              current.nlink !== 1
              || (current.mode & 0o7777) !== 0o600
              || fs.readFileSync(rootCaPath, "utf8") !== testRootCaPem
            ) exact = false;
            fs.unlinkSync(rootCaPath);
          }
        } catch {
          exact = false;
        }
        try {
          if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
          else exact = false;
        } catch {
          exact = false;
        }
        state = "closed";
        if (!exact || control.closeFails) {
          throw new PostgresRailwayStockLocalhostCaError("cleanup_failed");
        }
      })();
      return closePromise;
    },
  };
  await transport.assertExact();
  return transport;
}

function createTestPostgresLogicalBackup(
  options: Omit<CreatePostgresLogicalBackupOptions,
    | "transportProfile"
    | "rootCaFile"
    | "expectedRootCaDerSha256"
    | "pgDumpFile"
    | "expectedPgDumpSha256"
    | "pgRestoreFile"
    | "expectedPgRestoreSha256">,
  overrides: Partial<PostgresLogicalBackupDependencies> = {},
) {
  return createPostgresLogicalBackup({
    ...requiredTransportOptions,
    ...requiredToolOptions,
    ...options,
  }, overrides);
}

function writeConnectionFile(root: string, value = directTlsUrl, mode = 0o600): string {
  const filePath = path.join(root, "postgres-url");
  fs.writeFileSync(filePath, `${value}\n`, { mode });
  fs.chmodSync(filePath, mode);
  return filePath;
}

function pgpassTemporaryEntries(): string[] {
  return fs.readdirSync(fs.realpathSync(os.tmpdir()))
    .filter((entry) => entry.startsWith("pintpath-railway-stock-localhost-ca-test-"))
    .sort();
}

function validArchiveListing(): string {
  return [
    ";",
    "; Archive created at 2026-08-08 01:02:03 UTC",
    ";     TOC Entries: 4",
    ";     Compression: gzip",
    ";     Dump Version: 1.16-0",
    ";     Format: CUSTOM",
    ";     Integer: 4 bytes",
    ";     Offset: 8 bytes",
    ";     Dumped from database version: 17.6",
    ";     Dumped by pg_dump version: 17.10 (Homebrew)",
    ";",
    "2; 2615 100 SCHEMA - pintpath_app backup_user",
    "3; 2615 101 SCHEMA - pintpath_ops backup_user",
    "4; 1259 102 TABLE pintpath_app accounts backup_user",
    "5; 0 102 TABLE DATA pintpath_app accounts backup_user",
    "",
  ].join("\n");
}

interface ToolAuthorityHarnessOptions {
  dumpResult?: PostgresToolProcessResult;
  listingResult?: PostgresToolProcessResult;
  listing?: string;
  tamperDuringListing?: boolean;
  pgDumpVersion?: string;
  pgRestoreVersion?: string;
  dumpOpenFails?: boolean;
  listOpenFails?: boolean;
  dumpVersionFails?: boolean;
  listVersionFails?: boolean;
  dumpCloseFails?: boolean;
  listCloseFails?: boolean;
  throwOnDump?: boolean;
  events?: string[];
  pgpassMutation?:
    | "same-inode-content"
    | "same-inode-mode"
    | "replacement"
    | "extra-sibling"
    | "hardlink"
    | "missing";
}

interface PgpassObservation {
  path: string;
  contents: string;
  fileMode: number;
  directoryMode: number;
}

interface ArchiveDescriptorObservation {
  fileDescriptor: number;
  bytes: Buffer;
}

interface ArchiveDescriptorObservations {
  dump?: ArchiveDescriptorObservation;
  restoreList?: ArchiveDescriptorObservation;
  tamper?: ArchiveDescriptorObservation;
}

function writeAllToDescriptor(fileDescriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const bytesWritten = fs.writeSync(
      fileDescriptor,
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (bytesWritten < 1) throw new Error("test descriptor write made no progress");
    offset += bytesWritten;
  }
}

interface TrackedFileHandles {
  handlesByPath: Map<string, fs.promises.FileHandle[]>;
  openedStatsByHandle: Map<fs.promises.FileHandle, fs.Stats>;
  restore(): void;
}

type TrackedFileOpenHook = (
  filePath: string | null,
  handle: fs.promises.FileHandle,
) => void | Promise<void>;

function trackFileHandles(
  filePaths: readonly string[],
  onOpen?: TrackedFileOpenHook,
): TrackedFileHandles {
  const targets = new Set(filePaths);
  const handlesByPath = new Map<string, fs.promises.FileHandle[]>();
  const openedStatsByHandle = new Map<fs.promises.FileHandle, fs.Stats>();
  const originalOpen = fs.promises.open.bind(fs.promises);
  const openSpy = vi.spyOn(fs.promises, "open").mockImplementation((async (...args: unknown[]) => {
    const handle = await (originalOpen as (
      ...values: unknown[]
    ) => Promise<fs.promises.FileHandle>)(...args);
    const filePath = typeof args[0] === "string" ? args[0] : null;
    if (filePath && targets.has(filePath)) {
      const handles = handlesByPath.get(filePath) ?? [];
      handles.push(handle);
      handlesByPath.set(filePath, handles);
      openedStatsByHandle.set(handle, fs.fstatSync(handle.fd));
    }
    await onOpen?.(filePath, handle);
    return handle;
  }) as typeof fs.promises.open);
  return {
    handlesByPath,
    openedStatsByHandle,
    restore: () => openSpy.mockRestore(),
  };
}

async function fileHandleIsOpen(handle: fs.promises.FileHandle): Promise<boolean> {
  try {
    await handle.stat();
    return true;
  } catch {
    return false;
  }
}

async function openTrackedHandles(
  tracker: TrackedFileHandles,
  filePath: string,
): Promise<fs.promises.FileHandle[]> {
  const open: fs.promises.FileHandle[] = [];
  for (const handle of tracker.handlesByPath.get(filePath) ?? []) {
    if (await fileHandleIsOpen(handle)) open.push(handle);
  }
  return open;
}

interface RetainedOutputPaths {
  outputParent: string;
  outputDirectory: string;
  archive: string;
  manifest: string;
  stateReceipt: string;
}

interface RetainedOutputTracker {
  paths: RetainedOutputPaths;
  tracker: TrackedFileHandles;
}

interface RetainedOutputSyncTracker extends RetainedOutputTracker {
  syncStatesByPath: Map<string, Array<"zero-length" | "non-empty">>;
}

function retainedOutputPaths(requestedOutputDirectory: string): RetainedOutputPaths {
  const outputParent = fs.realpathSync(path.dirname(requestedOutputDirectory));
  const outputDirectory = path.join(outputParent, path.basename(requestedOutputDirectory));
  return {
    outputParent,
    outputDirectory,
    archive: path.join(outputDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
    manifest: path.join(outputDirectory, POSTGRES_LOGICAL_BACKUP_MANIFEST),
    stateReceipt: path.join(outputDirectory, POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT),
  };
}

function trackRetainedOutput(
  requestedOutputDirectory: string,
  onOpen?: TrackedFileOpenHook,
): RetainedOutputTracker {
  const paths = retainedOutputPaths(requestedOutputDirectory);
  return {
    paths,
    tracker: trackFileHandles(Object.values(paths), onOpen),
  };
}

function trackRetainedOutputSyncs(
  requestedOutputDirectory: string,
): RetainedOutputSyncTracker {
  const paths = retainedOutputPaths(requestedOutputDirectory);
  const artifactPaths = new Set([paths.archive, paths.manifest, paths.stateReceipt]);
  const syncStatesByPath = new Map<string, Array<"zero-length" | "non-empty">>();
  const tracker = trackFileHandles(Object.values(paths), (filePath, handle) => {
    if (!filePath || !artifactPaths.has(filePath)) return;
    const states = syncStatesByPath.get(filePath) ?? [];
    syncStatesByPath.set(filePath, states);
    const originalSync = handle.sync.bind(handle);
    Object.defineProperty(handle, "sync", {
      configurable: true,
      value: async () => {
        await originalSync();
        const stat = await handle.stat();
        states.push(stat.size === 0 ? "zero-length" : "non-empty");
      },
    });
  });
  return { paths, syncStatesByPath, tracker };
}

function expectCompletedArtifactsWereZeroizedAndSynced(
  retained: RetainedOutputSyncTracker,
): void {
  for (const artifactPath of [
    retained.paths.archive,
    retained.paths.manifest,
    retained.paths.stateReceipt,
  ]) {
    expect(retained.syncStatesByPath.get(artifactPath)).toEqual([
      "zero-length",
      "non-empty",
      "zero-length",
    ]);
  }
}

function sameFileIdentity(
  left: Pick<fs.Stats, "dev" | "ino">,
  right: Pick<fs.Stats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function expectRetainedZeroizedOutput(
  retained: RetainedOutputTracker,
  artifactFiles: readonly string[],
): Promise<void> {
  const artifactPaths = artifactFiles.map((artifactFile) => (
    path.join(retained.paths.outputDirectory, artifactFile)
  ));
  const heldPaths = [
    retained.paths.outputParent,
    retained.paths.outputDirectory,
    ...artifactPaths,
  ];
  for (const heldPath of heldPaths) {
    const handles = retained.tracker.handlesByPath.get(heldPath) ?? [];
    expect(handles.length).toBeGreaterThan(0);
    expect(await openTrackedHandles(retained.tracker, heldPath)).toEqual([]);
  }

  const directoryHandles = retained.tracker.handlesByPath.get(
    retained.paths.outputDirectory,
  ) ?? [];
  const openedDirectory = retained.tracker.openedStatsByHandle.get(directoryHandles[0]!);
  expect(openedDirectory).toBeDefined();
  const directoryFileDescriptor = fs.openSync(
    retained.paths.outputDirectory,
    fs.constants.O_RDONLY
      | (fs.constants.O_DIRECTORY ?? 0)
      | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const directoryStat = fs.fstatSync(directoryFileDescriptor);
    expect(directoryStat.isDirectory()).toBe(true);
    expect(directoryStat.uid).toBe(process.getuid?.() ?? directoryStat.uid);
    expect(directoryStat.mode & 0o7777).toBe(0o700);
    expect(sameFileIdentity(directoryStat, openedDirectory!)).toBe(true);
  } finally {
    fs.closeSync(directoryFileDescriptor);
  }

  for (const artifactPath of artifactPaths) {
    const artifactHandles = retained.tracker.handlesByPath.get(artifactPath) ?? [];
    const openedArtifact = retained.tracker.openedStatsByHandle.get(artifactHandles[0]!);
    expect(openedArtifact).toBeDefined();
    const artifactFileDescriptor = fs.openSync(
      artifactPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const artifactStat = fs.fstatSync(artifactFileDescriptor);
      expect(artifactStat.isFile()).toBe(true);
      expect(artifactStat.uid).toBe(process.getuid?.() ?? artifactStat.uid);
      expect(artifactStat.mode & 0o7777).toBe(0o600);
      expect(artifactStat.nlink).toBe(1);
      expect(artifactStat.size).toBe(0);
      expect(sameFileIdentity(artifactStat, openedArtifact!)).toBe(true);
    } finally {
      fs.closeSync(artifactFileDescriptor);
    }
  }
}

function readExactDescriptorBytes(fileDescriptor: number, byteLength: number): Buffer {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const bytesRead = fs.readSync(
      fileDescriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (bytesRead < 1) break;
    offset += bytesRead;
  }
  return bytes.subarray(0, offset);
}

interface HeldOperatorVictim {
  bytes: Buffer;
  directory: string;
  directoryFileDescriptor: number;
  directoryStat: fs.Stats;
  sentinelFileDescriptor: number;
  sentinelStat: fs.Stats;
}

function createHeldOperatorVictim(root: string, label: string): HeldOperatorVictim {
  const directory = path.join(root, `${label}-operator-victim`);
  const sentinelPath = path.join(directory, "operator-sentinel");
  const bytes = Buffer.from(`preserve-${label}-victim`);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(sentinelPath, bytes, { mode: 0o600 });
  const directoryFileDescriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
  );
  const sentinelFileDescriptor = fs.openSync(sentinelPath, fs.constants.O_RDONLY);
  return {
    bytes,
    directory,
    directoryFileDescriptor,
    directoryStat: fs.fstatSync(directoryFileDescriptor),
    sentinelFileDescriptor,
    sentinelStat: fs.fstatSync(sentinelFileDescriptor),
  };
}

function expectHeldOperatorVictimExact(victim: HeldOperatorVictim): void {
  const directoryStat = fs.fstatSync(victim.directoryFileDescriptor);
  const sentinelStat = fs.fstatSync(victim.sentinelFileDescriptor);
  expect(sameFileIdentity(directoryStat, victim.directoryStat)).toBe(true);
  expect(directoryStat.mode & 0o7777).toBe(0o700);
  expect(sameFileIdentity(sentinelStat, victim.sentinelStat)).toBe(true);
  expect(sentinelStat.mode & 0o7777).toBe(0o600);
  expect(sentinelStat.size).toBe(victim.bytes.length);
  expect(readExactDescriptorBytes(victim.sentinelFileDescriptor, victim.bytes.length)).toEqual(
    victim.bytes,
  );
}

function forbidRecursiveOutputRm(outputDirectory: string, victimDirectory: string) {
  let swapped = false;
  const displacedOutputDirectory = `${outputDirectory}-displaced-by-rm-test`;
  const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation((async (...args: unknown[]) => {
    if (String(args[0]) === outputDirectory) {
      await fs.promises.rename(outputDirectory, displacedOutputDirectory);
      await fs.promises.rename(victimDirectory, outputDirectory);
      swapped = true;
    }
    throw new Error("recursive output cleanup is forbidden");
  }) as typeof fs.promises.rm);
  return {
    callCount: () => rmSpy.mock.calls.length,
    restore: () => rmSpy.mockRestore(),
    wasSwapped: () => swapped,
  };
}

interface ToolAuthorityOpenObservation {
  purpose: "dump" | "list";
  executableFile: string;
  expectedSha256: string;
}

interface ToolProcessObservation extends ProcessInvocation {
  operation: "version" | "dump" | "list";
}

interface ToolAuthorityLifecycle {
  opened: number;
  versionCalls: number;
  operationCalls: number;
  assertExactCalls: number;
  closeCalls: number;
  operatedWhileOpen: boolean;
  closed: boolean;
}

function carrierResult(result: PostgresToolProcessResult) {
  return createPostgresToolProcessResultCarrier({
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function createToolAuthorityHarness(options: ToolAuthorityHarnessOptions = {}) {
  const invocations: ToolProcessObservation[] = [];
  const pgpassObservations: PgpassObservation[] = [];
  const archiveDescriptorObservations: ArchiveDescriptorObservations = {};
  const authorityOpens: ToolAuthorityOpenObservation[] = [];
  const authorityLifecycle: Record<"dump" | "list", ToolAuthorityLifecycle> = {
    dump: {
      opened: 0,
      versionCalls: 0,
      operationCalls: 0,
      assertExactCalls: 0,
      closeCalls: 0,
      operatedWhileOpen: false,
      closed: false,
    },
    list: {
      opened: 0,
      versionCalls: 0,
      operationCalls: 0,
      assertExactCalls: 0,
      closeCalls: 0,
      operatedWhileOpen: false,
      closed: false,
    },
  };

  const observeDump = async (
    executableFile: string,
    input: PostgresDumpOperationInput,
  ): Promise<PostgresToolProcessResult> => {
    const invocation: ToolProcessObservation = {
      operation: "dump",
      command: executableFile,
      args: [
        "--format=custom",
        `--snapshot=${input.snapshotIdentifier}`,
        `--role=${input.roleName}`,
        "--no-owner",
        "--no-acl",
        "--enable-row-security",
        "--strict-names",
        "--lock-wait-timeout=30s",
        "--no-password",
        "--schema=pintpath_app",
        "--schema=pintpath_ops",
      ],
      env: input.environment,
      timeoutMs: 60 * 60 * 1_000,
      maxStdoutBytes: 512 * 1_024,
      maxStderrBytes: 512 * 1_024,
      stdoutFileDescriptor: input.archiveOutputFileDescriptor,
    };
    invocations.push(invocation);
    options.events?.push("process.dump");
    if (options.throwOnDump) throw new Error(`could not connect to ${directTlsUrl}`);
    const pgpassPath = invocation.env.PGPASSFILE;
    if (!pgpassPath) throw new Error("test dump invocation omitted PGPASSFILE");
    pgpassObservations.push({
      path: pgpassPath,
      contents: fs.readFileSync(pgpassPath, "utf8"),
      fileMode: fs.statSync(pgpassPath).mode & 0o7777,
      directoryMode: fs.statSync(path.dirname(pgpassPath)).mode & 0o7777,
    });
    if (options.pgpassMutation === "same-inode-content") {
      fs.writeFileSync(pgpassPath, "tampered-in-place\n", { mode: 0o600 });
    } else if (options.pgpassMutation === "same-inode-mode") {
      fs.chmodSync(pgpassPath, 0o400);
    } else if (options.pgpassMutation === "replacement") {
      fs.unlinkSync(pgpassPath);
      fs.writeFileSync(pgpassPath, "untrusted-replacement\n", { mode: 0o600 });
    } else if (options.pgpassMutation === "extra-sibling") {
      fs.writeFileSync(path.join(path.dirname(pgpassPath), "unexpected"), "keep");
    } else if (options.pgpassMutation === "hardlink") {
      fs.linkSync(pgpassPath, path.join(path.dirname(pgpassPath), "retained-hardlink"));
    } else if (options.pgpassMutation === "missing") {
      fs.unlinkSync(pgpassPath);
    }
    if (invocation.args.some((argument) => argument.startsWith("--file"))) {
      throw new Error("test dump invocation passed --file");
    }
    const stdoutFileDescriptor = invocation.stdoutFileDescriptor;
    if (stdoutFileDescriptor === undefined) {
      throw new Error("test dump invocation omitted stdoutFileDescriptor");
    }
    const archiveBytes = Buffer.from("PGDMP-test-archive");
    // The fake pre-bound authority emulates the real runner's parent-side
    // stdout pipe copier; pg_dump itself never inherits this archive descriptor.
    writeAllToDescriptor(stdoutFileDescriptor, archiveBytes);
    archiveDescriptorObservations.dump = {
      fileDescriptor: stdoutFileDescriptor,
      bytes: archiveBytes,
    };
    return carrierResult(options.dumpResult ?? { exitCode: 0, stdout: "", stderr: "" });
  };

  const observeList = async (
    executableFile: string,
    archiveInputFileDescriptor: number,
  ): Promise<PostgresToolProcessResult> => {
    const invocation: ToolProcessObservation = {
      operation: "list",
      command: executableFile,
      args: ["--list", "--format=custom"],
      env: Object.freeze({ LC_ALL: "C" }),
      timeoutMs: 5 * 60 * 1_000,
      maxStdoutBytes: 32 * 1_024 * 1_024,
      maxStderrBytes: 512 * 1_024,
      stdinFileDescriptor: archiveInputFileDescriptor,
    };
    invocations.push(invocation);
    options.events?.push("process.list");
    if (archiveInputFileDescriptor === archiveDescriptorObservations.dump?.fileDescriptor) {
      throw new Error("test restore-list invocation reused dump stdoutFileDescriptor");
    }
    const archiveStat = fs.fstatSync(archiveInputFileDescriptor);
    const archiveBytes = readExactDescriptorBytes(
      archiveInputFileDescriptor,
      Number(archiveStat.size),
    );
    archiveDescriptorObservations.restoreList = {
      fileDescriptor: archiveInputFileDescriptor,
      bytes: archiveBytes,
    };
    if (options.tamperDuringListing) {
      const dumpFileDescriptor = archiveDescriptorObservations.dump?.fileDescriptor;
      if (dumpFileDescriptor === undefined) {
        throw new Error("test restore-list invocation had no observed dump descriptor");
      }
      const tamperBytes = Buffer.from("tampered");
      writeAllToDescriptor(dumpFileDescriptor, tamperBytes);
      archiveDescriptorObservations.tamper = {
        fileDescriptor: dumpFileDescriptor,
        bytes: tamperBytes,
      };
    }
    return carrierResult(options.listingResult ?? {
      exitCode: 0,
      stdout: options.listing ?? validArchiveListing(),
      stderr: "",
    });
  };

  const openDumpAuthority: PostgresLogicalBackupDependencies["openDumpAuthority"] = async (
    openOptions,
  ) => {
    authorityOpens.push({ purpose: "dump", ...openOptions });
    options.events?.push("authority.dump.open");
    const lifecycle = authorityLifecycle.dump;
    lifecycle.opened += 1;
    if (options.dumpOpenFails) throw new PostgresToolAuthorityError("unsafe_executable");
    let closePromise: Promise<void> | null = null;
    const authority = Object.assign(Object.create(null), {
      version: Object.freeze(async () => {
        if (lifecycle.closed) throw new Error("test dump authority version after close");
        lifecycle.versionCalls += 1;
        options.events?.push("authority.dump.version");
        options.events?.push("process.version");
        invocations.push({
          operation: "version",
          command: openOptions.executableFile,
          args: ["--version"],
          env: Object.freeze({ LC_ALL: "C" }),
          timeoutMs: 15_000,
          maxStdoutBytes: 4 * 1_024,
          maxStderrBytes: 4 * 1_024,
        });
        if (options.dumpVersionFails) throw new PostgresToolAuthorityError("process_failed");
        return carrierResult({
          exitCode: 0,
          stdout: `pg_dump (PostgreSQL) ${options.pgDumpVersion ?? "17.10 (Homebrew)"}\n`,
          stderr: "",
        });
      }),
      dump: Object.freeze(async (input: PostgresDumpOperationInput) => {
        lifecycle.operationCalls += 1;
        lifecycle.operatedWhileOpen = !lifecycle.closed;
        if (lifecycle.closed) throw new Error("test dump authority operation after close");
        return observeDump(openOptions.executableFile, input);
      }),
      assertExact: Object.freeze(async () => {
        lifecycle.assertExactCalls += 1;
        if (lifecycle.closed) throw new Error("test dump authority assertion after close");
      }),
      close: Object.freeze(() => {
        lifecycle.closeCalls += 1;
        if (closePromise) return closePromise;
        lifecycle.closed = true;
        options.events?.push("authority.dump.close");
        closePromise = options.dumpCloseFails
          ? Promise.reject(new PostgresToolAuthorityError("cleanup_failed"))
          : Promise.resolve();
        return closePromise;
      }),
    }) as PostgresDumpToolAuthority;
    return Object.freeze(authority);
  };

  const openListAuthority: PostgresLogicalBackupDependencies["openListAuthority"] = async (
    openOptions,
  ) => {
    authorityOpens.push({ purpose: "list", ...openOptions });
    options.events?.push("authority.list.open");
    const lifecycle = authorityLifecycle.list;
    lifecycle.opened += 1;
    if (options.listOpenFails) throw new PostgresToolAuthorityError("unsafe_executable");
    let closePromise: Promise<void> | null = null;
    const authority = Object.assign(Object.create(null), {
      version: Object.freeze(async () => {
        if (lifecycle.closed) throw new Error("test list authority version after close");
        lifecycle.versionCalls += 1;
        options.events?.push("authority.list.version");
        options.events?.push("process.version");
        invocations.push({
          operation: "version",
          command: openOptions.executableFile,
          args: ["--version"],
          env: Object.freeze({ LC_ALL: "C" }),
          timeoutMs: 15_000,
          maxStdoutBytes: 4 * 1_024,
          maxStderrBytes: 4 * 1_024,
        });
        if (options.listVersionFails) throw new PostgresToolAuthorityError("process_failed");
        return carrierResult({
          exitCode: 0,
          stdout: `pg_restore (PostgreSQL) ${options.pgRestoreVersion ?? "17.10 (Homebrew)"}\n`,
          stderr: "",
        });
      }),
      list: Object.freeze(async (archiveInputFileDescriptor: number) => {
        lifecycle.operationCalls += 1;
        lifecycle.operatedWhileOpen = !lifecycle.closed;
        if (lifecycle.closed) throw new Error("test list authority operation after close");
        return observeList(openOptions.executableFile, archiveInputFileDescriptor);
      }),
      assertExact: Object.freeze(async () => {
        lifecycle.assertExactCalls += 1;
        if (lifecycle.closed) throw new Error("test list authority assertion after close");
      }),
      close: Object.freeze(() => {
        lifecycle.closeCalls += 1;
        if (closePromise) return closePromise;
        lifecycle.closed = true;
        options.events?.push("authority.list.close");
        closePromise = options.listCloseFails
          ? Promise.reject(new PostgresToolAuthorityError("cleanup_failed"))
          : Promise.resolve();
        return closePromise;
      }),
    }) as PostgresListToolAuthority;
    return Object.freeze(authority);
  };

  return {
    archiveDescriptorObservations,
    authorityLifecycle,
    authorityOpens,
    invocations,
    openDumpAuthority,
    openListAuthority,
    pgpassObservations,
  };
}

function dependencies(
  harness: ReturnType<typeof createToolAuthorityHarness>,
  queries: string[] = [],
  transportControl: TransportTestControl = {},
): Partial<PostgresLogicalBackupDependencies> {
  const connection = {
    query: async <Row extends Record<string, unknown>>(text: string) => {
      queries.push(text);
      if (text.includes("source-identity")) return {
        rows: [{
          systemIdentifier: "7568999345281279000",
          databaseOid: "16655",
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
        } as unknown as Row],
        rowCount: 1,
      };
      if (text.includes("effective-role")) return {
        rows: [{
          effectiveRole: backupRole,
          sessionRole: backupLogin,
          transactionIsolation: "repeatable read",
          transactionReadOnly: true,
          canLogin: false,
          inheritsPrivileges: false,
          superuser: false,
          createDatabase: false,
          createRole: false,
          replication: false,
          bypassRls: false,
          membershipCount: 0,
          childMembershipCount: 1,
          exactSessionLoginChildCount: 1,
          directDatabasePrivilegeCount: 0,
          directFunctionPrivilegeCount: 0,
          roleSettingCount: 0,
          ownedCurrentDatabaseObjectCount: 0,
          sharedDependencyCount: 61,
          exactSharedDependencyCount: 61,
          privateSchemaCount: 2,
          directSchemaPrivilegeCount: 2,
          selectOnlySchemaCount: 2,
          privateRelationCount: 59,
          forceRlsRelationCount: 59,
          directRelationPrivilegeCount: 59,
          selectOnlyRelationCount: 59,
          privateSequenceCount: 0,
          selectOnlySequenceCount: 0,
          directColumnPrivilegeCount: 0,
          executablePrivateFunctionCount: 0,
          privatePolicyCount: 236,
          exactBasePolicyCount: 177,
          publicPrivatePolicyCount: 59,
          exactLogicalBackupSelectPolicyCount: 59,
          unsafePublicPrivatePolicyCount: 0,
          unsafeReservedPolicyNameCount: 0,
          directScopedPolicyCount: 0,
        } as unknown as Row],
        rowCount: 1,
      };
      if (text.includes("export-snapshot")) return {
        rows: [{ snapshotIdentifier: "00000003-0000001B-1" } as unknown as Row],
        rowCount: 1,
      };
      return { rows: [], rowCount: 0 };
    },
    close: async () => { transportControl.events?.push("connection.close"); },
  };
  return {
    env: {
      PATH: "/safe/bin",
      LANG: "en_AU.UTF-8",
      DATABASE_URL: "postgresql://inherited:must-not-leak@inherited.invalid/db",
      PGPASSWORD: "inherited-password-must-not-leak",
      PGOPTIONS: "-c search_path=attacker",
      PGPASSFILE: "/tmp/inherited-pgpass-must-not-leak",
      PGSERVICEFILE: "/tmp/inherited-service-must-not-leak",
      AWS_SECRET_ACCESS_KEY: "unrelated-secret-must-not-leak",
    },
    now: () => new Date("2026-08-08T01:02:03.000Z"),
    openDumpAuthority: harness.openDumpAuthority,
    openListAuthority: harness.openListAuthority,
    connect: async () => {
      transportControl.events?.push("connection.open");
      return connection;
    },
    computeState: async () => fakeStateInventory(),
    openTransport: (options) => openTestTransport(options, transportControl),
  };
}

function fakeStateInventory(): PostgresLogicalStateInventory {
  const tables = POSTGRES_MIGRATION_CONTRACT.tables.map((table) => ({
    tableName: table.name,
    columnCount: table.columns.length,
    rowCount: table.name === "system_state" ? "1" : "0",
    transformedSha256: sha256(`table:${table.name}`),
    firstPrimaryKeySha256: table.name === "system_state" ? sha256("first") : null,
    lastPrimaryKeySha256: table.name === "system_state" ? sha256("last") : null,
  }));
  return {
    authoritativeTableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables,
    authoritativeColumnCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns,
    authoritativeRowCount: "1",
    nonEmptyAuthoritativeTableCount: 1,
    zeroRowAuthoritativeTableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables - 1,
    migrationContractSha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
    sourceSchemaFingerprint: POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
    sourceSchemaSha256: "1".repeat(64),
    sourceSnapshotSha256: "2".repeat(64),
    targetDdlSha256: "3".repeat(64),
    schemaMetadataSha256: "4".repeat(64),
    tableSetSha256: "5".repeat(64),
    transformedDataSha256: "6".repeat(64),
    keyRangesSha256: "7".repeat(64),
    stateTotalsSha256: "8".repeat(64),
    archivedControlTableCount: 3,
    archivedControlRowCount: "12",
    archivedControlTableSetSha256: "a".repeat(64),
    archivedControlDataSha256: "b".repeat(64),
    archivedControlKeyRangesSha256: "c".repeat(64),
    overallStateSha256: "9".repeat(64),
    tables,
    archivedControlTables: [
      {
        tableName: "pintpath_app.schema_metadata", columnCount: 3, rowCount: "12",
        transformedSha256: "d".repeat(64), firstPrimaryKeySha256: "e".repeat(64),
        lastPrimaryKeySha256: "f".repeat(64),
      },
      {
        tableName: "pintpath_ops.migration_chunks", columnCount: 7, rowCount: "0",
        transformedSha256: "1".repeat(64), firstPrimaryKeySha256: null,
        lastPrimaryKeySha256: null,
      },
      {
        tableName: "pintpath_ops.migration_runs", columnCount: 18, rowCount: "0",
        transformedSha256: "2".repeat(64), firstPrimaryKeySha256: null,
        lastPrimaryKeySha256: null,
      },
    ],
  };
}

function historicalV2Manifest(): PostgresLogicalBackupManifestV2 {
  return {
    schemaVersion: 2,
    kind: "pintpath-postgres-logical-backup",
    createdAt: "2026-08-08T01:02:03.000Z",
    archive: {
      file: POSTGRES_LOGICAL_BACKUP_ARCHIVE,
      format: "custom",
      bytes: 123,
      sha256: "1".repeat(64),
      schemas: ["pintpath_app", "pintpath_ops"],
      aclStatementsIncluded: false,
      requiredRestoreOptions: ["--no-owner", "--no-acl"],
    },
    tools: {
      pgDump: { name: "pg_dump", version: "17.10", major: 17 },
      pgRestore: { name: "pg_restore", version: "17.10", major: 17 },
    },
    validation: {
      method: "pg_restore --list",
      tocEntries: 4,
      listedEntries: 4,
      listingSha256: "2".repeat(64),
      dumpedFromDatabaseVersion: "17.6",
      dumpedByPgDumpVersion: "17.10",
    },
    state: {
      receiptFile: POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      receiptSha256: "3".repeat(64),
      manifestBindingSha256: "4".repeat(64),
      sourceDatabaseIdentitySha256: "5".repeat(64),
      sourceUrlSha256: "6".repeat(64),
      snapshotBindingSha256: "7".repeat(64),
      migrationContractSha256: "8".repeat(64),
      schemaMetadataSha256: "9".repeat(64),
      targetDdlSha256: "a".repeat(64),
      authoritativeTableCount: 56,
      authoritativeRowCount: "1234",
      tableSetSha256: "b".repeat(64),
      transformedDataSha256: "c".repeat(64),
      stateTotalsSha256: "d".repeat(64),
      keyRangesSha256: "e".repeat(64),
      archivedControlTableCount: 3,
      archivedControlRowCount: "12",
      archivedControlTableSetSha256: "f".repeat(64),
      archivedControlDataSha256: "0".repeat(64),
      archivedControlKeyRangesSha256: "1".repeat(64),
      overallStateSha256: "2".repeat(64),
    },
  };
}

function sha256(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function expectBackupError(error: unknown, code: PostgresLogicalBackupError["code"]): void {
  expect(error).toBeInstanceOf(PostgresLogicalBackupError);
  expect((error as PostgresLogicalBackupError).code).toBe(code);
  expect(String((error as Error).message)).toBe(code);
  expect(String((error as Error).message)).not.toContain(connectionSecret);
  expect(String((error as Error).message)).not.toContain(sourceHostname);
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Postgres logical backup foundation", () => {
  it("ignores child stdin when no inherited file descriptor is supplied", async () => {
    const result = await runPostgresBackupProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write(JSON.stringify(require("node:fs").readFileSync(0, "utf8")))',
      ],
      env: { LC_ALL: "C" },
      timeoutMs: 5_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    });

    expect(result).toEqual({ exitCode: 0, stdout: JSON.stringify(""), stderr: "" });
  });

  it("inherits an explicitly supplied stdin file descriptor", async () => {
    const root = makeTemporaryDirectory();
    const inputPath = path.join(root, "archive-input");
    const input = "descriptor-custodied-archive\n";
    fs.writeFileSync(inputPath, input, { mode: 0o600 });
    const stdinFileDescriptor = fs.openSync(inputPath, fs.constants.O_RDONLY);

    try {
      const result = await runPostgresBackupProcess({
        command: process.execPath,
        args: [
          "-e",
          'process.stdout.write(require("node:fs").readFileSync(0, "utf8"))',
        ],
        env: { LC_ALL: "C" },
        timeoutMs: 5_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        stdinFileDescriptor,
      });

      expect(result).toEqual({ exitCode: 0, stdout: input, stderr: "" });
      expect(fs.fstatSync(stdinFileDescriptor).isFile()).toBe(true);
    } finally {
      fs.closeSync(stdinFileDescriptor);
    }
  });

  it("copies a child stdout pipe into the parent-owned output descriptor", async () => {
    const root = makeTemporaryDirectory();
    const outputPath = path.join(root, "archive-output");
    const output = "descriptor-custodied-archive\n";
    const outputBytes = Buffer.from(output);
    const stderr = "captured diagnostic\n";
    const stdoutFileDescriptor = fs.openSync(
      outputPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );

    try {
      const result = await runPostgresBackupProcess({
        command: process.execPath,
        args: [
          "-e",
          [
            'const fs = require("node:fs")',
            "if (fs.fstatSync(1).isFile()) process.exit(91)",
            `process.stdout.write(${JSON.stringify(output)})`,
            `process.stderr.write(${JSON.stringify(stderr)})`,
          ].join(";"),
        ],
        env: { LC_ALL: "C" },
        timeoutMs: 5_000,
        maxStdoutBytes: 0,
        maxStderrBytes: 1_024,
        stdoutFileDescriptor,
      });

      expect(result).toEqual({ exitCode: 0, stdout: "", stderr });
      const observedOutput = Buffer.alloc(outputBytes.length + 1);
      const bytesRead = fs.readSync(
        stdoutFileDescriptor,
        observedOutput,
        0,
        observedOutput.length,
        0,
      );
      expect(bytesRead).toBe(outputBytes.length);
      expect(observedOutput.subarray(0, bytesRead)).toEqual(outputBytes);
      const outputStat = fs.fstatSync(stdoutFileDescriptor);
      expect(outputStat.isFile()).toBe(true);
      expect(outputStat.size).toBe(outputBytes.length);
    } finally {
      fs.closeSync(stdoutFileDescriptor);
    }
  });

  it("returns the branded frozen null-prototype carrier from the direct process runner", async () => {
    const result = await runPostgresBackupProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("carrier-stdout"); process.stderr.write("carrier-stderr")',
      ],
      env: { LC_ALL: "C" },
      timeoutMs: 5_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "carrier-stdout",
      stderr: "carrier-stderr",
    });
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.ownKeys(result)).toEqual(["exitCode", "stdout", "stderr"]);
  });

  it("preserves raw stdout/stderr bytes only for the V4 list discriminator", async () => {
    const root = makeTemporaryDirectory();
    const archivePath = path.join(root, "raw-list-archive.dump");
    fs.writeFileSync(archivePath, "archive", { mode: 0o600 });
    const stdinFileDescriptor = fs.openSync(archivePath, "r");
    const expected = Buffer.from([0xff, 0xfe, 0x00, 0x61, 0x0a]);
    try {
      const result = await runPostgresBackupProcess({
        operation: "list-v4",
        stdoutMode: "raw",
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(Buffer.from([255,254,0,97,10]))",
        ],
        env: { LC_ALL: "C" },
        timeoutMs: 5_000,
        maxStdoutBytes: 65_536,
        maxStderrBytes: 65_536,
        stdinFileDescriptor,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual(expected);
      expect(result.stderr).toEqual(Buffer.alloc(0));
      expect(typeof result.stdout).not.toBe("string");
      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(Object.isFrozen(result)).toBe(true);
      expect(Reflect.ownKeys(result)).toEqual(["exitCode", "stdout", "stderr"]);

      await expect(runPostgresBackupProcess({
        operation: "list-v4",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: { LC_ALL: "C" },
        timeoutMs: 5_000,
        maxStdoutBytes: 65_536,
        maxStderrBytes: 65_536,
        stdinFileDescriptor,
      } as unknown as RawProcessInvocation)).rejects.toThrow();

      await expect(runPostgresBackupProcess({
        operation: "list-v4",
        stdoutMode: "raw",
        command: process.execPath,
        args: ["-e", "process.exit(99)"],
        env: { LC_ALL: "C" },
        timeoutMs: 5_000,
        maxStdoutBytes: 65_537,
        maxStderrBytes: 65_536,
        stdinFileDescriptor,
      })).rejects.toThrow("invalid_process_invocation");
    } finally {
      fs.closeSync(stdinFileDescriptor);
    }
  });

  it("enforces the V4 raw listing stream bound before returning a carrier", async () => {
    const root = makeTemporaryDirectory();
    const archivePath = path.join(root, "oversized-raw-list-archive.dump");
    fs.writeFileSync(archivePath, "archive", { mode: 0o600 });
    const stdinFileDescriptor = fs.openSync(archivePath, "r");
    try {
      await expect(runPostgresBackupProcess({
        operation: "list-v4",
        stdoutMode: "raw",
        command: process.execPath,
        args: ["-e", "process.stdout.write(Buffer.alloc(65537, 97))"],
        env: { LC_ALL: "C" },
        timeoutMs: 5_000,
        maxStdoutBytes: 65_536,
        maxStderrBytes: 65_536,
        stdinFileDescriptor,
      })).rejects.toThrow("process_output_limit_exceeded");
    } finally {
      fs.closeSync(stdinFileDescriptor);
    }
  });

  it("settles the direct process carrier without consulting inherited Object.prototype.then", () => {
    // Promise.prototype integrity belongs to the locked launch/runtime boundary.
    // This isolates the runner's own result-carrier assimilation guarantee.
    const moduleFile = path.join(process.cwd(), "src/lib/postgres-logical-backup.ts");
    const script = String.raw`
      import process from "node:process";
      import { pathToFileURL } from "node:url";
      const moduleFile = process.argv[1];
      const backupModule = await import(pathToFileURL(moduleFile).href);
      const ObjectExact = Object;
      const PromiseExact = Promise;
      const originalThen = ObjectExact.getOwnPropertyDescriptor(ObjectExact.prototype, "then");
      let thenGetterCalls = 0;
      let unhandledRejections = 0;
      const onUnhandled = () => { unhandledRejections += 1; };
      process.on("unhandledRejection", onUnhandled);
      await new PromiseExact((resolve) => setImmediate(resolve));
      await new PromiseExact((resolve) => setImmediate(resolve));
      try {
        ObjectExact.defineProperty(ObjectExact.prototype, "then", {
          configurable: true,
          get() {
            thenGetterCalls += 1;
            throw new Error("inherited Object.prototype.then getter must not run");
          },
        });
        const result = await backupModule.runPostgresBackupProcess({
          command: process.execPath,
          args: ["-e", "process.stdout.write('isolated-carrier')"],
          env: { LC_ALL: "C" },
          timeoutMs: 5000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
        });
        if (
          ObjectExact.getPrototypeOf(result) !== null
          || !ObjectExact.isFrozen(result)
          || result.exitCode !== 0
          || result.stdout !== "isolated-carrier"
          || result.stderr !== ""
        ) throw new Error("unexpected direct runner carrier");
        await new PromiseExact((resolve) => setImmediate(resolve));
      } finally {
        if (originalThen === undefined) Reflect.deleteProperty(ObjectExact.prototype, "then");
        else ObjectExact.defineProperty(ObjectExact.prototype, "then", originalThen);
        process.off("unhandledRejection", onUnhandled);
      }
      if (thenGetterCalls !== 0 || unhandledRejections !== 0) {
        throw new Error("unsafe Promise settlement observed");
      }
      process.stdout.write("ok");
    `;
    const output = execFileSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
      moduleFile,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output).toBe("ok");
  });

  it.skipIf(process.platform === "win32")(
    "promptly reaps and rejects a same-group grandchild retaining the stdout pipe",
    async () => {
      const root = makeTemporaryDirectory();
      const outputPath = path.join(root, "grandchild-output");
      const stdoutFileDescriptor = fs.openSync(
        outputPath,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      const grandchildCode = [
        "setInterval(() => undefined, 1_000)",
      ].join(";");
      const leaderCode = [
        'const fs = require("node:fs")',
        'const { spawn } = require("node:child_process")',
        `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], { stdio: ["ignore", 1, "ignore"] })`,
        "grandchild.unref()",
        'fs.writeSync(1, `${grandchild.pid}\\n`)',
        "process.exit(0)",
      ].join(";");
      let grandchildPid: number | null = null;

      try {
        const startedAt = Date.now();
        const error = await runPostgresBackupProcess({
          command: process.execPath,
          args: ["-e", leaderCode],
          env: { LC_ALL: "C" },
          timeoutMs: 5_000,
          maxStdoutBytes: 0,
          maxStderrBytes: 1_024,
          stdoutFileDescriptor,
        }).catch((caught: unknown) => caught);
        const elapsedMs = Date.now() - startedAt;

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("process_descendants_detected");
        expect(elapsedMs).toBeLessThan(2_000);
        const initialOutput = Buffer.alloc(64);
        const initialBytesRead = fs.readSync(
          stdoutFileDescriptor,
          initialOutput,
          0,
          initialOutput.length,
          0,
        );
        const grandchildPidRecord = initialOutput.subarray(0, initialBytesRead).toString("utf8");
        expect(grandchildPidRecord).toMatch(/^[1-9][0-9]*\n$/);
        grandchildPid = Number.parseInt(grandchildPidRecord, 10);
        expect(Number.isSafeInteger(grandchildPid) && grandchildPid > 0).toBe(true);
        let lookupError: NodeJS.ErrnoException | null = null;
        try {
          process.kill(grandchildPid, 0);
        } catch (error) {
          lookupError = error as NodeJS.ErrnoException;
        }
        expect(lookupError?.code).toBe("ESRCH");

        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        const observedOutput = Buffer.alloc(64);
        const observedBytesRead = fs.readSync(
          stdoutFileDescriptor,
          observedOutput,
          0,
          observedOutput.length,
          0,
        );
        expect(observedOutput.subarray(0, observedBytesRead).toString("utf8")).toBe(
          grandchildPidRecord,
        );
        const outputStat = fs.fstatSync(stdoutFileDescriptor);
        expect(outputStat.isFile()).toBe(true);
        expect(outputStat.size).toBe(Buffer.byteLength(grandchildPidRecord));
      } finally {
        if (grandchildPid !== null) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // Expected once the process-group reaper has removed the descendant.
          }
        }
        fs.closeSync(stdoutFileDescriptor);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "revokes the stdout pipe when a setsid descendant escapes the leader process group",
    async () => {
      const root = makeTemporaryDirectory();
      const targetPath = path.join(root, "escaped-descendant-output");
      const pidPath = path.join(root, "escaped-descendant-pid");
      const targetFileDescriptor = fs.openSync(
        targetPath,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      const pidFileDescriptor = fs.openSync(
        pidPath,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      const stableTargetBytes = Buffer.from("parent-owned-prefix\n");
      const delayedBytes = Buffer.from("escaped-delayed-output");
      writeAllToDescriptor(targetFileDescriptor, stableTargetBytes);
      const leaderCode = String.raw`
        const fs = require("node:fs");
        const { spawn } = require("node:child_process");
        const escaped = spawn(
          process.execPath,
          [
            "-e",
            'setTimeout(() => { try { require("node:fs").writeSync(1, "escaped-delayed-output") } catch {} }, 900); setInterval(() => undefined, 1_000)',
          ],
          { detached: true, stdio: ["ignore", 1, "ignore"] },
        );
        escaped.unref();
        fs.writeFileSync(process.argv[1], String(escaped.pid), { encoding: "utf8" });
        process.exit(0);
      `;
      const readPid = (): number | null => {
        const buffer = Buffer.alloc(64);
        const bytesRead = fs.readSync(
          pidFileDescriptor,
          buffer,
          0,
          buffer.length,
          0,
        );
        const record = buffer.subarray(0, bytesRead).toString("utf8");
        return /^[1-9][0-9]*$/.test(record) ? Number.parseInt(record, 10) : null;
      };
      const readTarget = (): Buffer => {
        const buffer = Buffer.alloc(stableTargetBytes.length + delayedBytes.length + 64);
        const bytesRead = fs.readSync(
          targetFileDescriptor,
          buffer,
          0,
          buffer.length,
          0,
        );
        return Buffer.from(buffer.subarray(0, bytesRead));
      };
      let escapedPid: number | null = null;

      try {
        const error = await runPostgresBackupProcess({
          command: process.execPath,
          args: ["-e", leaderCode, pidPath],
          env: { LC_ALL: "C" },
          timeoutMs: 500,
          maxStdoutBytes: 0,
          maxStderrBytes: 1_024,
          stdoutFileDescriptor: targetFileDescriptor,
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("process_timeout");
        escapedPid = readPid();
        expect(escapedPid).not.toBeNull();
        expect(() => process.kill(escapedPid!, 0)).not.toThrow();
        expect(() => process.kill(-escapedPid!, 0)).not.toThrow();
        expect(readTarget()).toEqual(stableTargetBytes);

        await new Promise<void>((resolve) => setTimeout(resolve, 600));
        expect(readTarget()).toEqual(stableTargetBytes);
        const targetStat = fs.fstatSync(targetFileDescriptor);
        expect(targetStat.isFile()).toBe(true);
        expect(targetStat.size).toBe(stableTargetBytes.length);
      } finally {
        escapedPid ??= readPid();
        if (escapedPid !== null) {
          try {
            process.kill(-escapedPid, "SIGKILL");
          } catch {
            try {
              process.kill(escapedPid, "SIGKILL");
            } catch {
              // The escaped descendant may already have been reaped.
            }
          }
          const reapDeadline = Date.now() + 5_000;
          let escapedPidExists = true;
          while (escapedPidExists && Date.now() < reapDeadline) {
            try {
              process.kill(escapedPid, 0);
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
              escapedPidExists = false;
            }
          }
          if (escapedPidExists) throw new Error("escaped test descendant was not reaped");
        }
        fs.closeSync(pidFileDescriptor);
        fs.closeSync(targetFileDescriptor);
      }
    },
  );

  it.each([
    -1,
    0,
    1,
    2,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0x8000_0000,
  ])("rejects invalid stdin file descriptor %s before spawning", async (stdinFileDescriptor) => {
    await expect(runPostgresBackupProcess({
      command: path.join(makeTemporaryDirectory(), "must-not-spawn"),
      args: [],
      env: { LC_ALL: "C" },
      timeoutMs: 5_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
      stdinFileDescriptor,
    })).rejects.toThrow("invalid_process_invocation");
  });

  it.each([
    -1,
    0,
    1,
    2,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0x8000_0000,
  ])("rejects invalid stdout file descriptor %s before spawning", async (stdoutFileDescriptor) => {
    await expect(runPostgresBackupProcess({
      command: path.join(makeTemporaryDirectory(), "must-not-spawn"),
      args: [],
      env: { LC_ALL: "C" },
      timeoutMs: 5_000,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
      stdoutFileDescriptor,
    })).rejects.toThrow("invalid_process_invocation");
  });

  it.skipIf(process.platform === "win32").each([
    "stdinFileDescriptor",
    "stdoutFileDescriptor",
  ] as const)("rejects a non-regular directory as %s", async (descriptorField) => {
    const root = makeTemporaryDirectory();
    const directoryFileDescriptor = fs.openSync(
      root,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
    );

    try {
      await expect(runPostgresBackupProcess({
        command: path.join(root, "must-not-spawn"),
        args: [],
        env: { LC_ALL: "C" },
        timeoutMs: 5_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        [descriptorField]: directoryFileDescriptor,
      })).rejects.toThrow("invalid_process_invocation");
      expect(fs.fstatSync(directoryFileDescriptor).isDirectory()).toBe(true);
    } finally {
      fs.closeSync(directoryFileDescriptor);
    }
  });

  it("rejects reusing one file descriptor for child stdin and stdout", async () => {
    const root = makeTemporaryDirectory();
    const descriptorPath = path.join(root, "shared-descriptor");
    const sharedFileDescriptor = fs.openSync(
      descriptorPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );

    try {
      await expect(runPostgresBackupProcess({
        command: path.join(root, "must-not-spawn"),
        args: [],
        env: { LC_ALL: "C" },
        timeoutMs: 5_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        stdinFileDescriptor: sharedFileDescriptor,
        stdoutFileDescriptor: sharedFileDescriptor,
      })).rejects.toThrow("invalid_process_invocation");
      expect(fs.fstatSync(sharedFileDescriptor).isFile()).toBe(true);
    } finally {
      fs.closeSync(sharedFileDescriptor);
    }
  });

  it("rejects distinct stdin and stdout descriptors for the same inode", async () => {
    const root = makeTemporaryDirectory();
    const descriptorPath = path.join(root, "shared-inode");
    fs.writeFileSync(descriptorPath, "input-must-remain-exact", { mode: 0o600 });
    const stdinFileDescriptor = fs.openSync(descriptorPath, fs.constants.O_RDONLY);
    const stdoutFileDescriptor = openTestFileDescriptor(
      descriptorPath,
      fs.constants.O_RDWR,
    );

    try {
      await expect(runPostgresBackupProcess({
        command: path.join(root, "must-not-spawn"),
        args: [],
        env: { LC_ALL: "C" },
        timeoutMs: 5_000,
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        stdinFileDescriptor,
        stdoutFileDescriptor,
      })).rejects.toThrow("invalid_process_invocation");
      const observed = Buffer.alloc(64);
      const bytesRead = fs.readSync(
        stdinFileDescriptor,
        observed,
        0,
        observed.length,
        0,
      );
      expect(observed.subarray(0, bytesRead).toString("utf8")).toBe(
        "input-must-remain-exact",
      );
    } finally {
      fs.closeSync(stdoutFileDescriptor);
      fs.closeSync(stdinFileDescriptor);
    }
  });

  it.each([
    ["process_output_limit_exceeded", 5_000, 0] as const,
    ["process_timeout", 1_000, 1_024] as const,
  ])("reaps the exact child before rejecting with %s", async (
    expectedError,
    timeoutMs,
    maxStdoutBytes,
  ) => {
    const root = makeTemporaryDirectory();
    const inputPath = path.join(root, "archive-input");
    const childPidPath = path.join(root, "child-pid");
    fs.writeFileSync(inputPath, "descriptor-custodied-archive\n", { mode: 0o600 });
    const stdinFileDescriptor = fs.openSync(inputPath, fs.constants.O_RDONLY);

    try {
      await expect(runPostgresBackupProcess({
        command: process.execPath,
        args: [
          "-e",
          [
            'const fs = require("node:fs")',
            'fs.writeFileSync(process.argv[1], String(process.pid), { mode: 0o600 })',
            'process.stdout.write("trigger-output-limit")',
            "setInterval(() => undefined, 1_000)",
          ].join(";"),
          childPidPath,
        ],
        env: { LC_ALL: "C" },
        timeoutMs,
        maxStdoutBytes,
        maxStderrBytes: 1_024,
        stdinFileDescriptor,
      })).rejects.toThrow(expectedError);

      expect(fs.fstatSync(stdinFileDescriptor).isFile()).toBe(true);
      const childPid = Number.parseInt(fs.readFileSync(childPidPath, "utf8"), 10);
      expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
      let childLookupError: NodeJS.ErrnoException | null = null;
      try {
        process.kill(childPid, 0);
      } catch (error) {
        childLookupError = error as NodeJS.ErrnoException;
      }
      expect(childLookupError?.code).toBe("ESRCH");
    } finally {
      fs.closeSync(stdinFileDescriptor);
    }
  });

  it("preserves the historical v2 binding domain and binds v3 transport under domain v2", () => {
    const v2 = historicalV2Manifest();
    expect(postgresLogicalBackupManifestBindingSha256(v2)).toBe(
      "a8fda0d78a15ac3345bc1d63e30d9b58f673620cfcb6e7e404767e15600a32ab",
    );
    const { schemaVersion: _historicalSchemaVersion, ...shared } = v2;
    const v3: PostgresLogicalBackupManifestV3 = {
      ...shared,
      schemaVersion: 3,
      transport: {
        profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
        rootCaCertificateSha256: testRootCaDerSha256,
      },
    };
    expect(postgresLogicalBackupManifestBindingSha256(v3)).toBe(
      "c825dcd06172799d1ebbd89d807e2a9611abe0a5396c1e039a3e378d020831fe",
    );
    expect(postgresLogicalBackupManifestBindingSha256({
      ...v3,
      transport: { ...v3.transport, rootCaCertificateSha256: "b".repeat(64) },
    })).not.toBe(postgresLogicalBackupManifestBindingSha256(v3));
  });

  it("keeps the exact frozen HEAD v2 offsite binding, receipt, and manifest hashes", () => {
    const root = makeTemporaryDirectory();
    const fixture = writeLogicalOffsiteFixture(
      root,
      "2026-08-09T01:00:00.000Z",
      2,
    );
    expect(fixture.manifest.schemaVersion).toBe(2);
    expect("transport" in fixture.manifest).toBe(false);
    expect(fixture.manifest.state.manifestBindingSha256).toBe(
      "a2f0cf1fd96f8f079b4de541e64476df4eb0c8f851e52a34e2e5fbb385892a0f",
    );
    expect(fixture.receiptSha256).toBe(
      "06712c88385f51501e64d8bc21a7bad327b41f494824467e36acfb3d3fbe351f",
    );
    expect(fixture.manifestSha256).toBe(
      "d6d4ce365aea2360da298c6bdd8f88d00f26c188b04c64a26cfc181690f20405",
    );
  });

  it("creates and validates a private custom archive with a canonical SHA manifest", async () => {
    const root = makeTemporaryDirectory();
    const connectionFile = writeConnectionFile(root);
    const outputDirectory = path.join(root, "logical-backup");
    const canonicalOutputDirectory = path.join(fs.realpathSync(root), "logical-backup");
    const harness = createToolAuthorityHarness();

    const result = await createTestPostgresLogicalBackup(
      {
        connectionFile,
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      },
      dependencies(harness),
    );

    expect(result).toEqual({
      schemaVersion: 3,
      ok: true,
      outputDirectory: canonicalOutputDirectory,
      archivePath: path.join(canonicalOutputDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
      manifestPath: path.join(canonicalOutputDirectory, POSTGRES_LOGICAL_BACKUP_MANIFEST),
      stateReceiptPath: path.join(
        canonicalOutputDirectory,
        POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      ),
      archiveSha256: sha256("PGDMP-test-archive"),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      stateReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      authoritativeRowCount: "1",
      overallStateSha256: "9".repeat(64),
    });
    expect(harness.archiveDescriptorObservations).toEqual({
      dump: {
        fileDescriptor: expect.any(Number),
        bytes: Buffer.from("PGDMP-test-archive"),
      },
      restoreList: {
        fileDescriptor: expect.any(Number),
        bytes: Buffer.from("PGDMP-test-archive"),
      },
    });
    expect(harness.archiveDescriptorObservations.dump?.fileDescriptor).not.toBe(
      harness.archiveDescriptorObservations.restoreList?.fileDescriptor,
    );
    expect(fs.statSync(outputDirectory).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(result.archivePath).mode & 0o7777).toBe(0o600);
    expect(fs.statSync(result.manifestPath).mode & 0o7777).toBe(0o600);
    expect(fs.statSync(result.stateReceiptPath).mode & 0o7777).toBe(0o600);
    expect(sha256(fs.readFileSync(result.manifestPath))).toBe(result.manifestSha256);

    const manifestBytes = fs.readFileSync(result.manifestPath, "utf8");
    const manifest = JSON.parse(manifestBytes) as PostgresLogicalBackupManifest;
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      kind: "pintpath-postgres-logical-backup",
      createdAt: "2026-08-08T01:02:03.000Z",
      transport: {
        profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
        rootCaCertificateSha256: testRootCaDerSha256,
      },
      archive: {
        file: POSTGRES_LOGICAL_BACKUP_ARCHIVE,
        format: "custom",
        bytes: Buffer.byteLength("PGDMP-test-archive"),
        sha256: sha256("PGDMP-test-archive"),
        schemas: ["pintpath_app", "pintpath_ops"],
        aclStatementsIncluded: false,
        requiredRestoreOptions: ["--no-owner", "--no-acl"],
      },
      tools: {
        pgDump: { name: "pg_dump", version: "17.10 (Homebrew)", major: 17 },
        pgRestore: { name: "pg_restore", version: "17.10 (Homebrew)", major: 17 },
      },
      validation: {
        method: "pg_restore --list",
        tocEntries: 4,
        listedEntries: 4,
        listingSha256: sha256(validArchiveListing()),
        dumpedFromDatabaseVersion: "17.6",
        dumpedByPgDumpVersion: "17.10 (Homebrew)",
      },
      state: {
        receiptFile: POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
        receiptSha256: result.stateReceiptSha256,
        manifestBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceDatabaseIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sourceUrlSha256: sha256(directTlsUrl),
        snapshotBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        migrationContractSha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
        schemaMetadataSha256: "4".repeat(64),
        targetDdlSha256: "3".repeat(64),
        authoritativeTableCount: 56,
        authoritativeRowCount: "1",
        tableSetSha256: "5".repeat(64),
        transformedDataSha256: "6".repeat(64),
        stateTotalsSha256: "8".repeat(64),
        keyRangesSha256: "7".repeat(64),
        archivedControlTableCount: 3,
        archivedControlRowCount: "12",
        archivedControlTableSetSha256: "a".repeat(64),
        archivedControlDataSha256: "b".repeat(64),
        archivedControlKeyRangesSha256: "c".repeat(64),
        overallStateSha256: "9".repeat(64),
      },
    });
    expect(manifestBytes).toBe(canonicalPostgresBackupJson(manifest));
    expect(manifestBytes).not.toContain(connectionSecret);
    expect(manifestBytes).not.toContain(sourceHostname);
    expect(manifestBytes).not.toContain("backup_user");
    expect(manifestBytes).not.toContain(backupLogin);
    const receiptBytes = fs.readFileSync(result.stateReceiptPath, "utf8");
    expect(sha256(receiptBytes)).toBe(result.stateReceiptSha256);
    expect(receiptBytes).not.toContain(connectionSecret);
    expect(receiptBytes).not.toContain(sourceHostname);
    expect(receiptBytes).not.toContain("backup_user");
    expect(receiptBytes).not.toContain(backupLogin);
  });

  it.each([
    ["wrong profile", { transportProfile: "railway-stock-localhost-ca-v2" }],
    ["missing root CA file", { rootCaFile: "" }],
    ["noncanonical DER pin", { expectedRootCaDerSha256: testRootCaDerSha256.toUpperCase() }],
  ])("rejects the required transport input %s before reading runtime authority", async (_label, change) => {
    const root = makeTemporaryDirectory();
    let uidRead = false;
    const error = await createPostgresLogicalBackup({
      ...requiredTransportOptions,
      ...requiredToolOptions,
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "invalid-transport-input"),
      ...change,
    } as CreatePostgresLogicalBackupOptions, {
      ...dependencies(createToolAuthorityHarness()),
      getUid: () => {
        uidRead = true;
        return process.getuid?.() ?? 0;
      },
    }).catch((caught: unknown) => caught);
    expectBackupError(error, "invalid_arguments");
    expect(uidRead).toBe(false);
  });

  it.each([
    ["missing pg_dump path", { pgDumpFile: undefined }],
    ["bare pg_dump path", { pgDumpFile: "pg_dump" }],
    ["padded pg_dump path", { pgDumpFile: ` ${testPgDumpFile}` }],
    ["missing pg_dump hash", { expectedPgDumpSha256: undefined }],
    ["uppercase pg_dump hash", { expectedPgDumpSha256: testPgDumpSha256.toUpperCase() }],
    ["missing pg_restore path", { pgRestoreFile: undefined }],
    ["bare pg_restore path", { pgRestoreFile: "pg_restore" }],
    ["padded pg_restore path", { pgRestoreFile: `${testPgRestoreFile} ` }],
    ["missing pg_restore hash", { expectedPgRestoreSha256: undefined }],
    ["uppercase pg_restore hash", { expectedPgRestoreSha256: testPgRestoreSha256.toUpperCase() }],
  ] as const)(
    "rejects the required tool authority input %s before reading runtime authority",
    async (_label, change) => {
      const root = makeTemporaryDirectory();
      const harness = createToolAuthorityHarness();
      let uidRead = false;
      const error = await createPostgresLogicalBackup({
        ...requiredTransportOptions,
        ...requiredToolOptions,
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory: path.join(root, "invalid-tool-authority-input"),
        ...change,
      } as unknown as CreatePostgresLogicalBackupOptions, {
        ...dependencies(harness),
        getUid: () => {
          uidRead = true;
          return process.getuid?.() ?? 0;
        },
      }).catch((caught: unknown) => caught);

      expectBackupError(error, "invalid_arguments");
      expect(uidRead).toBe(false);
      expect(harness.authorityOpens).toEqual([]);
    },
  );

  it("rejects noncanonical or overlapping authority paths before any asynchronous authority read", async () => {
    const root = makeTemporaryDirectory();
    const connectionFile = writeConnectionFile(root);
    const outputDirectory = path.join(root, "canonical-output");
    const cases: Array<Partial<CreatePostgresLogicalBackupOptions>> = [
      { connectionFile: "relative/source-url" },
      { rootCaFile: "relative/root-ca.pem" },
      { outputDirectory: "relative/output" },
      { rootCaFile: `/private/root-ca.pem\0suffix` },
      { rootCaFile: connectionFile },
      { outputDirectory: connectionFile },
      { outputDirectory: path.dirname(connectionFile) },
    ];
    for (const change of cases) {
      let uidRead = false;
      const error = await createPostgresLogicalBackup({
        ...requiredTransportOptions,
        ...requiredToolOptions,
        connectionFile,
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
        ...change,
      }, {
        ...dependencies(createToolAuthorityHarness()),
        getUid: () => {
          uidRead = true;
          return process.getuid?.() ?? 0;
        },
      }).catch((caught: unknown) => caught);
      expectBackupError(error, "invalid_arguments");
      expect(uidRead).toBe(false);
    }
  });

  it.each([
    [
      "dump open",
      { dumpOpenFails: true },
      [] as const,
      { dump: 0, list: 0 },
    ],
    [
      "dump version",
      { dumpVersionFails: true },
      ["version"] as const,
      { dump: 1, list: 0 },
    ],
    [
      "list open",
      { listOpenFails: true },
      ["version"] as const,
      { dump: 1, list: 0 },
    ],
    [
      "list version",
      { listVersionFails: true },
      ["version", "version"] as const,
      { dump: 1, list: 1 },
    ],
  ] as const)(
    "contains %s authority failure before transport, connection, or output creation",
    async (_label, harnessOptions, expectedOperations, expectedCloseCalls) => {
      const root = makeTemporaryDirectory();
      const outputDirectory = path.join(root, "tool-authority-failure");
      const harness = createToolAuthorityHarness(harnessOptions);
      const base = dependencies(harness);
      let transportOpened = false;
      let connected = false;
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, {
        ...base,
        openTransport: async (transportOptions) => {
          transportOpened = true;
          return base.openTransport!(transportOptions);
        },
        connect: async (config) => {
          connected = true;
          return base.connect!(config);
        },
      }).catch((caught: unknown) => caught);

      expectBackupError(error, "tool_unavailable_or_unsupported");
      expect(harness.invocations.map((invocation) => invocation.operation)).toEqual(
        expectedOperations,
      );
      expect(harness.authorityLifecycle.dump.closeCalls).toBe(expectedCloseCalls.dump);
      expect(harness.authorityLifecycle.list.closeCalls).toBe(expectedCloseCalls.list);
      expect(transportOpened).toBe(false);
      expect(connected).toBe(false);
      expect(fs.existsSync(outputDirectory)).toBe(false);
    },
  );

  it.each([
    ["profile", (transport: PostgresRailwayStockLocalhostCaTransport) => ({
      ...transport,
      profile: "railway-stock-localhost-ca-v2",
    })],
    ["DER pin", (transport: PostgresRailwayStockLocalhostCaTransport) => ({
      ...transport,
      rootCaDerSha256: "b".repeat(64),
    })],
    ["hostname", (transport: PostgresRailwayStockLocalhostCaTransport) => ({
      ...transport,
      sourceUrlAuthority: { hostname: "changed.railway.internal", port: 5_432 },
    })],
    ["port", (transport: PostgresRailwayStockLocalhostCaTransport) => ({
      ...transport,
      sourceUrlAuthority: { hostname: sourceHostname, port: 6_543 },
    })],
    ["authority shape", (transport: PostgresRailwayStockLocalhostCaTransport) => ({
      ...transport,
      sourceUrlAuthority: { hostname: sourceHostname, port: 5_432, extra: true },
    })],
  ])(
    "rejects a returned transport with mismatched %s after tool pinning but before connection",
    async (_label, mutate) => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "mismatched-returned-transport");
    const events: string[] = [];
    const control: TransportTestControl = { events };
    const harness = createToolAuthorityHarness({ events });
    let connected = false;
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, {
      ...dependencies(harness, [], control),
      openTransport: async (transportOptions) => mutate(
        await openTestTransport(transportOptions, control)
      ) as unknown as PostgresRailwayStockLocalhostCaTransport,
      connect: async () => {
        connected = true;
        throw new Error("must not connect");
      },
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "source_unreachable_or_unsafe");
    expect(harness.invocations.map((invocation) => invocation.operation)).toEqual([
      "version",
      "version",
    ]);
    expect(harness.authorityLifecycle.dump.closeCalls).toBe(1);
    expect(harness.authorityLifecycle.list.closeCalls).toBe(1);
    expect(connected).toBe(false);
    expect(fs.existsSync(outputDirectory)).toBe(false);
    expect(events).toContain("transport.close");
    },
  );

  it("gives cleanup failure precedence when rejecting a mismatched returned transport", async () => {
    const root = makeTemporaryDirectory();
    const control: TransportTestControl = { closeFails: true };
    const harness = createToolAuthorityHarness();
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "mismatch-close-failure"),
    }, {
      ...dependencies(harness),
      openTransport: async (transportOptions) => ({
        ...await openTestTransport(transportOptions, control),
        rootCaDerSha256: "b".repeat(64),
      }) as PostgresRailwayStockLocalhostCaTransport,
    }).catch((caught: unknown) => caught);
    expectBackupError(error, "cleanup_failed");
    expect(harness.invocations.map((invocation) => invocation.operation)).toEqual([
      "version",
      "version",
    ]);
    expect(harness.authorityLifecycle.dump.closeCalls).toBe(1);
    expect(harness.authorityLifecycle.list.closeCalls).toBe(1);
  });

  it("pins tools sequentially before transport or database access and closes each authority", async () => {
    const root = makeTemporaryDirectory();
    const events: string[] = [];
    const control: TransportTestControl = { events };
    const harness = createToolAuthorityHarness({ events });
    await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "ordered-lifecycle"),
    }, dependencies(harness, [], control));

    expect(control.assertions).toBe(11);
    expect(events.indexOf("authority.dump.open")).toBeLessThan(
      events.indexOf("authority.dump.version"),
    );
    expect(events.indexOf("authority.dump.version")).toBeLessThan(
      events.indexOf("authority.list.open"),
    );
    expect(events.indexOf("authority.list.open")).toBeLessThan(
      events.indexOf("authority.list.version"),
    );
    expect(events.indexOf("authority.list.version")).toBeLessThan(events.indexOf("transport.open"));
    expect(events.indexOf("transport.open")).toBeLessThan(events.indexOf("connection.open"));
    expect(events.indexOf("connection.open")).toBeLessThan(events.indexOf("process.dump"));
    expect(events.indexOf("process.dump")).toBeLessThan(events.indexOf("authority.dump.close"));
    expect(events.indexOf("process.dump")).toBeLessThan(events.indexOf("process.list"));
    expect(events.indexOf("process.list")).toBeLessThan(events.indexOf("authority.list.close"));
    expect(events.indexOf("connection.close")).toBeLessThan(events.indexOf("transport.close"));
    expect(events.at(-1)).toBe("transport.close");
    expect(harness.authorityLifecycle.dump).toMatchObject({
      opened: 1,
      versionCalls: 1,
      operationCalls: 1,
      closeCalls: 1,
      operatedWhileOpen: true,
      closed: true,
    });
    expect(harness.authorityLifecycle.list).toMatchObject({
      opened: 1,
      versionCalls: 1,
      operationCalls: 1,
      closeCalls: 1,
      operatedWhileOpen: true,
      closed: true,
    });
  });

  it("uses exact pinned tool files without PATH fallback or manifest schema expansion", async () => {
    const root = makeTemporaryDirectory();
    const harness = createToolAuthorityHarness();
    const base = dependencies(harness);
    const result = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "pinned-tools-no-path-fallback"),
    }, {
      ...base,
      env: { ...base.env, PATH: "/attacker-controlled/bin" },
    });

    expect(harness.authorityOpens).toEqual([
      {
        purpose: "dump",
        executableFile: testPgDumpFile,
        expectedSha256: testPgDumpSha256,
      },
      {
        purpose: "list",
        executableFile: testPgRestoreFile,
        expectedSha256: testPgRestoreSha256,
      },
    ]);
    expect(harness.invocations.map((invocation) => invocation.command)).toEqual([
      testPgDumpFile,
      testPgRestoreFile,
      testPgDumpFile,
      testPgRestoreFile,
    ]);
    expect(harness.invocations.some((invocation) => (
      invocation.command === "pg_dump" || invocation.command === "pg_restore"
    ))).toBe(false);
    const dump = harness.invocations.find((invocation) => invocation.operation === "dump");
    expect(dump?.env.PATH).toBe("/attacker-controlled/bin");

    const manifestBytes = fs.readFileSync(result.manifestPath, "utf8");
    const manifest = JSON.parse(manifestBytes) as PostgresLogicalBackupManifestV3;
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.tools).toEqual({
      pgDump: { name: "pg_dump", version: "17.10 (Homebrew)", major: 17 },
      pgRestore: { name: "pg_restore", version: "17.10 (Homebrew)", major: 17 },
    });
    expect(manifestBytes).not.toContain(testPgDumpFile);
    expect(manifestBytes).not.toContain(testPgRestoreFile);
    expect(manifestBytes).not.toContain(testPgDumpSha256);
    expect(manifestBytes).not.toContain(testPgRestoreSha256);
  });

  it.each([
    [
      "dump close-only failure",
      { dumpCloseFails: true },
      { dump: 1, list: 0 },
    ],
    [
      "dump close failure after an operation failure",
      {
        dumpCloseFails: true,
        dumpResult: { exitCode: 1, stdout: "", stderr: "injected dump failure" },
      },
      { dump: 1, list: 0 },
    ],
    [
      "list close-only failure",
      { listCloseFails: true },
      { dump: 1, list: 1 },
    ],
    [
      "list close failure after an operation failure",
      {
        listCloseFails: true,
        listingResult: { exitCode: 1, stdout: "", stderr: "injected list failure" },
      },
      { dump: 1, list: 1 },
    ],
  ] as const)(
    "%s yields cleanup_failed and zeroizes held output",
    async (_label, harnessOptions, expectedOperations) => {
      const root = makeTemporaryDirectory();
      const outputDirectory = path.join(root, "authority-close-dominance");
      const retained = trackRetainedOutput(outputDirectory);
      const harness = createToolAuthorityHarness(harnessOptions);
      try {
        const error = await createTestPostgresLogicalBackup({
          connectionFile: writeConnectionFile(root),
          expectedSourceUrlSha256: sha256(directTlsUrl),
          outputDirectory,
        }, dependencies(harness)).catch((caught: unknown) => caught);

        expectBackupError(error, "cleanup_failed");
        expect(harness.authorityLifecycle.dump.operationCalls).toBe(expectedOperations.dump);
        expect(harness.authorityLifecycle.list.operationCalls).toBe(expectedOperations.list);
        expect(harness.authorityLifecycle.dump.closeCalls).toBe(1);
        expect(harness.authorityLifecycle.list.closeCalls).toBe(1);
        expect(harness.authorityLifecycle.dump.operatedWhileOpen).toBe(true);
        if (expectedOperations.list === 1) {
          expect(harness.authorityLifecycle.list.operatedWhileOpen).toBe(true);
        }
        await expectRetainedZeroizedOutput(retained, [POSTGRES_LOGICAL_BACKUP_ARCHIVE]);
      } finally {
        retained.tracker.restore();
      }
    },
  );

  it("holds directory and artifact descriptors through cleanup and closes them before return", async () => {
    const root = makeTemporaryDirectory();
    const outputParent = fs.realpathSync(root);
    const outputDirectory = path.join(outputParent, "held-cleanup-handles");
    const trackedPaths = {
      outputParent,
      outputDirectory,
      archive: path.join(outputDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
      manifest: path.join(outputDirectory, POSTGRES_LOGICAL_BACKUP_MANIFEST),
      stateReceipt: path.join(outputDirectory, POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT),
    };
    const tracker = trackFileHandles(Object.values(trackedPaths));
    const harness = createToolAuthorityHarness();
    const base = dependencies(harness);
    const cleanupObservations: Array<{
      phase: "connection.close" | "transport.close";
      openCounts: Record<keyof typeof trackedPaths, number>;
    }> = [];
    const observeHeldHandles = async (
      phase: "connection.close" | "transport.close",
    ): Promise<void> => {
      const openCounts = {} as Record<keyof typeof trackedPaths, number>;
      for (const [label, filePath] of Object.entries(trackedPaths) as Array<[
        keyof typeof trackedPaths,
        string,
      ]>) {
        openCounts[label] = (await openTrackedHandles(tracker, filePath)).length;
      }
      cleanupObservations.push({ phase, openCounts });
    };

    try {
      const result = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, {
        ...base,
        connect: async (config) => {
          const connection = await base.connect!(config);
          return {
            ...connection,
            close: async () => {
              await observeHeldHandles("connection.close");
              await connection.close();
            },
          };
        },
        openTransport: async (options) => {
          const transport = await base.openTransport!(options);
          return {
            ...transport,
            close: async () => {
              await observeHeldHandles("transport.close");
              await transport.close();
            },
          };
        },
      });

      expect(result.ok).toBe(true);
      expect(cleanupObservations).toEqual([
        {
          phase: "connection.close",
          openCounts: {
            outputParent: 1,
            outputDirectory: 1,
            archive: 1,
            manifest: 1,
            stateReceipt: 1,
          },
        },
        {
          phase: "transport.close",
          openCounts: {
            outputParent: 1,
            outputDirectory: 1,
            archive: 1,
            manifest: 1,
            stateReceipt: 1,
          },
        },
      ]);
      for (const filePath of Object.values(trackedPaths)) {
        expect(await openTrackedHandles(tracker, filePath)).toEqual([]);
      }
    } finally {
      tracker.restore();
    }
  });

  it.each(["connection.close", "transport.close"] as const)(
    "zeroizes, fsyncs, and closes completed artifacts when only %s fails",
    async (failurePhase) => {
      const root = makeTemporaryDirectory();
      const outputDirectory = path.join(root, `completed-${failurePhase}-failure`);
      const retained = trackRetainedOutputSyncs(outputDirectory);
      const events: string[] = [];
      const control: TransportTestControl = {
        events,
        closeFails: failurePhase === "transport.close",
      };
      const harness = createToolAuthorityHarness({ events });
      const base = dependencies(harness, [], control);
      const overrides: Partial<PostgresLogicalBackupDependencies> = { ...base };
      if (failurePhase === "connection.close") {
        overrides.connect = async (config) => {
          const connection = await base.connect!(config);
          return {
            ...connection,
            close: async () => {
              await connection.close();
              throw new Error("injected completed connection cleanup failure");
            },
          };
        };
      }

      try {
        const error = await createTestPostgresLogicalBackup({
          connectionFile: writeConnectionFile(root),
          expectedSourceUrlSha256: sha256(directTlsUrl),
          outputDirectory,
        }, overrides).catch((caught: unknown) => caught);

        expectBackupError(error, "cleanup_failed");
        expect(harness.invocations.some((invocation) => (
          invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
        ))).toBe(true);
        expect(harness.invocations.some((invocation) => invocation.args.includes("--list"))).toBe(
          true,
        );
        expectCompletedArtifactsWereZeroizedAndSynced(retained);
        await expectRetainedZeroizedOutput(retained, [
          POSTGRES_LOGICAL_BACKUP_ARCHIVE,
          POSTGRES_LOGICAL_BACKUP_MANIFEST,
          POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
        ]);
        expect(events.indexOf("connection.close")).toBeLessThan(events.indexOf("transport.close"));
      } finally {
        retained.tracker.restore();
      }
    },
  );

  it.each(["connection.close", "transport.close"] as const)(
    "detects archive mutation during %s, zeroizes retained artifacts, and closes held handles",
    async (mutationPhase) => {
      const root = makeTemporaryDirectory();
      const outputParent = fs.realpathSync(root);
      const outputDirectory = path.join(outputParent, `cleanup-mutation-${mutationPhase}`);
      const trackedPaths = {
        outputParent,
        outputDirectory,
        archive: path.join(outputDirectory, POSTGRES_LOGICAL_BACKUP_ARCHIVE),
        manifest: path.join(outputDirectory, POSTGRES_LOGICAL_BACKUP_MANIFEST),
        stateReceipt: path.join(outputDirectory, POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT),
      };
      const tracker = trackFileHandles(Object.values(trackedPaths));
      const harness = createToolAuthorityHarness();
      const base = dependencies(harness);
      let mutated = false;
      let openCountsAtMutation: Record<keyof typeof trackedPaths, number> | null = null;
      const mutateHeldArchive = async (): Promise<void> => {
        const openCounts = {} as Record<keyof typeof trackedPaths, number>;
        for (const [label, filePath] of Object.entries(trackedPaths) as Array<[
          keyof typeof trackedPaths,
          string,
        ]>) {
          openCounts[label] = (await openTrackedHandles(tracker, filePath)).length;
        }
        openCountsAtMutation = openCounts;
        const archiveFileDescriptor = harness.archiveDescriptorObservations.dump?.fileDescriptor;
        if (archiveFileDescriptor === undefined) {
          throw new Error("test cleanup mutation had no held archive descriptor");
        }
        writeAllToDescriptor(archiveFileDescriptor, Buffer.from("cleanup-tamper"));
        mutated = true;
      };
      const overrides: Partial<PostgresLogicalBackupDependencies> = { ...base };
      if (mutationPhase === "connection.close") {
        overrides.connect = async (config) => {
          const connection = await base.connect!(config);
          return {
            ...connection,
            close: async () => {
              await mutateHeldArchive();
              await connection.close();
            },
          };
        };
      } else {
        overrides.openTransport = async (options) => {
          const transport = await base.openTransport!(options);
          return {
            ...transport,
            close: async () => {
              await mutateHeldArchive();
              await transport.close();
            },
          };
        };
      }

      try {
        const error = await createTestPostgresLogicalBackup({
          connectionFile: writeConnectionFile(root),
          expectedSourceUrlSha256: sha256(directTlsUrl),
          outputDirectory,
        }, overrides).catch((caught: unknown) => caught);

        expectBackupError(error, "archive_tampered");
        expect(mutated).toBe(true);
        expect(openCountsAtMutation).toEqual({
          outputParent: 1,
          outputDirectory: 1,
          archive: 1,
          manifest: 1,
          stateReceipt: 1,
        });
        for (const filePath of Object.values(trackedPaths)) {
          expect(await openTrackedHandles(tracker, filePath)).toEqual([]);
        }
        await expectRetainedZeroizedOutput(
          { paths: trackedPaths, tracker },
          [
            POSTGRES_LOGICAL_BACKUP_ARCHIVE,
            POSTGRES_LOGICAL_BACKUP_MANIFEST,
            POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
          ],
        );
      } finally {
        tracker.restore();
      }
    },
  );

  it.each([
    ["exported snapshot", 5, []],
    ["pg_dump completion", 9, [POSTGRES_LOGICAL_BACKUP_ARCHIVE]],
    [
      "manifest finalization",
      11,
      [
        POSTGRES_LOGICAL_BACKUP_ARCHIVE,
        POSTGRES_LOGICAL_BACKUP_MANIFEST,
        POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      ],
    ],
  ] as const)(
    "fails closed on transport drift at the %s boundary without retaining backup bytes",
    async (_label, failAssertionAt, retainedArtifacts) => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, `transport-drift-${failAssertionAt}`);
    const retained = retainedArtifacts.length > 0
      ? trackRetainedOutput(outputDirectory)
      : null;
    const events: string[] = [];
    const control: TransportTestControl = { events, failAssertionAt };
    const harness = createToolAuthorityHarness({ events });
    try {
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness, [], control)).catch((caught: unknown) => caught);

      expectBackupError(error, "source_unreachable_or_unsafe");
      if (retained) {
        await expectRetainedZeroizedOutput(retained, retainedArtifacts);
      } else {
        expect(fs.existsSync(outputDirectory)).toBe(false);
      }
      expect(events.indexOf("connection.close")).toBeLessThan(events.indexOf("transport.close"));
    } finally {
      retained?.tracker.restore();
    }
  });

  it("gives transport cleanup failure precedence and retains only a zeroized archive", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "transport-close-dominance");
    const retained = trackRetainedOutput(outputDirectory);
    const events: string[] = [];
    const control: TransportTestControl = { events, closeFails: true };
    const harness = createToolAuthorityHarness({
      events,
      dumpResult: { exitCode: 1, stdout: "", stderr: "test-only failure" },
    });
    try {
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness, [], control)).catch((caught: unknown) => caught);

      expectBackupError(error, "cleanup_failed");
      await expectRetainedZeroizedOutput(retained, [POSTGRES_LOGICAL_BACKUP_ARCHIVE]);
      expect(events.indexOf("connection.close")).toBeLessThan(events.indexOf("transport.close"));
    } finally {
      retained.tracker.restore();
    }
  });

  it("contains transport-open failures after tool pinning but before connection or output", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "transport-open-failure");
    const harness = createToolAuthorityHarness();
    let connected = false;
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, {
      ...dependencies(harness),
      openTransport: async () => {
        throw new PostgresRailwayStockLocalhostCaError("root_ca_pin_mismatch");
      },
      connect: async () => {
        connected = true;
        throw new Error("must not connect");
      },
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "source_unreachable_or_unsafe");
    expect(harness.invocations.map((invocation) => invocation.operation)).toEqual([
      "version",
      "version",
    ]);
    expect(harness.authorityLifecycle.dump.closeCalls).toBe(1);
    expect(harness.authorityLifecycle.list.closeCalls).toBe(1);
    expect(connected).toBe(false);
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("snapshots URL, CA, tool, profile, and output authorities before asynchronous work", async () => {
    const root = makeTemporaryDirectory();
    const originalOutput = path.join(root, "snapshotted-options");
    const harness = createToolAuthorityHarness();
    const base = dependencies(harness);
    const supplied: CreatePostgresLogicalBackupOptions = {
      ...requiredTransportOptions,
      ...requiredToolOptions,
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: originalOutput,
    };
    const result = await createPostgresLogicalBackup(supplied, {
      ...base,
      openDumpAuthority: async (authorityOptions) => {
        const mutable = supplied as unknown as Record<string, unknown>;
        mutable.expectedSourceUrlSha256 = "b".repeat(64);
        mutable.expectedRootCaDerSha256 = "d".repeat(64);
        mutable.transportProfile = "railway-stock-localhost-ca-v2";
        mutable.rootCaFile = "/private/replaced-root-ca.pem";
        mutable.pgDumpFile = "/private/replaced-pg-dump";
        mutable.expectedPgDumpSha256 = "e".repeat(64);
        mutable.pgRestoreFile = "/private/replaced-pg-restore";
        mutable.expectedPgRestoreSha256 = "f".repeat(64);
        mutable.outputDirectory = path.join(root, "mutated-output");
        return base.openDumpAuthority!(authorityOptions);
      },
    });
    expect(result.outputDirectory).toBe(fs.realpathSync(originalOutput));
    expect(fs.existsSync(path.join(root, "mutated-output"))).toBe(false);
    expect(harness.authorityOpens).toEqual([
      {
        purpose: "dump",
        executableFile: testPgDumpFile,
        expectedSha256: testPgDumpSha256,
      },
      {
        purpose: "list",
        executableFile: testPgRestoreFile,
        expectedSha256: testPgRestoreSha256,
      },
    ]);
  });

  it("passes credentials only through a scoped pg_dump environment", async () => {
    const root = makeTemporaryDirectory();
    const harness = createToolAuthorityHarness();
    const queries: string[] = [];
    await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "backup"),
    }, dependencies(harness, queries));

    const dump = harness.invocations.find((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))!;
    const restoreList = harness.invocations.find((invocation) => invocation.args.includes("--list"))!;
    const versionInvocations = harness.invocations.filter((invocation) => invocation.args[0] === "--version");
    expect(dump.args).toEqual([
      "--format=custom",
      "--snapshot=00000003-0000001B-1",
      `--role=${backupRole}`,
      "--no-owner",
      "--no-acl",
      "--enable-row-security",
      "--strict-names",
      "--lock-wait-timeout=30s",
      "--no-password",
      "--schema=pintpath_app",
      "--schema=pintpath_ops",
    ]);
    expect(dump.stdinFileDescriptor).toBeUndefined();
    expect(dump.stdoutFileDescriptor).toBe(
      harness.archiveDescriptorObservations.dump?.fileDescriptor,
    );
    expect(JSON.stringify(dump.args)).not.toContain(connectionSecret);
    expect(JSON.stringify(dump.args)).not.toContain(sourceHostname);
    expect(JSON.stringify(dump.args)).not.toContain("backup_user");
    expect(dump.env).toMatchObject({
      PATH: "/safe/bin",
      LC_ALL: "C",
      PGHOST: "localhost",
      PGHOSTADDR: testResolvedAddress,
      PGPORT: "5432",
      PGDATABASE: "pintpath",
      PGUSER: backupLogin,
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: path.join(path.dirname(dump.env.PGPASSFILE), "railway-root-ca.pem"),
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLSNI: "1",
      PGGSSENCMODE: "disable",
      PGCONNECT_TIMEOUT: "15",
      PGAPPNAME: "pintpath-logical-backup",
    });
    expect(dump.env.DATABASE_URL).toBeUndefined();
    expect(dump.env.PGOPTIONS).toBeUndefined();
    expect(dump.env.PGPASSFILE).toMatch(
      /\/pintpath-railway-stock-localhost-ca-test-[^/]+\/pgpass$/,
    );
    expect(dump.env.PGSERVICEFILE).toBeUndefined();
    expect(dump.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(dump.env.PGPASSWORD).toBeUndefined();
    expect(harness.pgpassObservations).toEqual([{
      path: dump.env.PGPASSFILE,
      contents: `localhost:5432:pintpath:${backupLogin}:${connectionSecret}\n`,
      fileMode: 0o600,
      directoryMode: 0o700,
    }]);
    expect(path.dirname(path.dirname(dump.env.PGPASSFILE))).toBe(fs.realpathSync(os.tmpdir()));
    expect(fs.existsSync(dump.env.PGPASSFILE)).toBe(false);
    expect(fs.existsSync(path.dirname(dump.env.PGPASSFILE))).toBe(false);
    expect(restoreList.args).toEqual(["--list", "--format=custom"]);
    expect(restoreList.stdinFileDescriptor).toBe(
      harness.archiveDescriptorObservations.restoreList?.fileDescriptor,
    );
    expect(restoreList.stdinFileDescriptor).not.toBe(dump.stdoutFileDescriptor);
    expect(restoreList.stdoutFileDescriptor).toBeUndefined();
    expect(restoreList.env.PGPASSWORD).toBeUndefined();
    expect(restoreList.env.PGPASSFILE).toBeUndefined();
    expect(restoreList.env.DATABASE_URL).toBeUndefined();
    expect(versionInvocations).toHaveLength(2);
    expect(versionInvocations.every((invocation) => invocation.env.PGPASSWORD === undefined)).toBe(true);
    expect(versionInvocations.every((invocation) => invocation.env.PGPASSFILE === undefined)).toBe(true);
    expect(versionInvocations.every((invocation) => invocation.env.DATABASE_URL === undefined)).toBe(true);
    expect(versionInvocations.every((invocation) => (
      invocation.stdinFileDescriptor === undefined
    ))).toBe(true);
    expect(versionInvocations.every((invocation) => (
      invocation.stdoutFileDescriptor === undefined
    ))).toBe(true);
    expect(queries.filter((query) => query.includes("logical-backup:set-role"))).toEqual([
      `/* pintpath:logical-backup:set-role */ SET ROLE ${backupRole}`,
    ]);
    expect(queries.some((query) => query.includes("SET ROLE pintpath_migrator"))).toBe(false);
    const identityQuery = queries.find((query) => query.includes("logical-backup:source-identity"))!;
    expect(identityQuery).toContain("NOT membership.admin_option");
    expect(identityQuery).toContain("NOT membership.inherit_option");
    expect(identityQuery).toContain("membership.set_option");
    expect(identityQuery).toContain("hasDirectDatabaseConnect");
    expect(identityQuery).toContain("hasDirectControlSystemExecute");
    expect(identityQuery).toContain(
      "pg_has_role(session_user, 'pintpath_runtime', 'SET') AS \"canSetRuntime\"",
    );
  });

  it("pins the exact trimmed source URL before tools, connection, output, or pgpass creation", async () => {
    const root = makeTemporaryDirectory();
    const connectionFile = writeConnectionFile(root);
    const outputDirectory = path.join(root, "hash-mismatch");
    const harness = createToolAuthorityHarness();
    const beforePgpassEntries = pgpassTemporaryEntries();
    let connected = false;
    const base = dependencies(harness);

    const mismatch = await createTestPostgresLogicalBackup({
      connectionFile,
      expectedSourceUrlSha256: "f".repeat(64),
      outputDirectory,
    }, {
      ...base,
      connect: async (config) => {
        connected = true;
        return base.connect!(config);
      },
    }).catch((caught: unknown) => caught);

    expectBackupError(mismatch, "unsafe_connection_url");
    expect(connected).toBe(false);
    expect(harness.invocations).toEqual([]);
    expect(fs.existsSync(outputDirectory)).toBe(false);
    expect(pgpassTemporaryEntries()).toEqual(beforePgpassEntries);

    for (const invalidHash of ["A".repeat(64), "a".repeat(63), ` ${"a".repeat(64)}`]) {
      let uidRead = false;
      const malformed = await createTestPostgresLogicalBackup({
        connectionFile,
        expectedSourceUrlSha256: invalidHash,
        outputDirectory,
      }, {
        ...base,
        getUid: () => {
          uidRead = true;
          return process.getuid?.() ?? 0;
        },
      }).catch((caught: unknown) => caught);
      expectBackupError(malformed, "invalid_arguments");
      expect(uidRead).toBe(false);
    }
    expect(harness.invocations).toEqual([]);
    expect(pgpassTemporaryEntries()).toEqual(beforePgpassEntries);
  });

  it("hashes the logical trimmed URL rather than connection-file whitespace", async () => {
    const root = makeTemporaryDirectory();
    const connectionFile = path.join(root, "postgres-url");
    fs.writeFileSync(connectionFile, ` \t${directTlsUrl}\n`, { mode: 0o600 });
    fs.chmodSync(connectionFile, 0o600);
    const harness = createToolAuthorityHarness();

    await createTestPostgresLogicalBackup({
      connectionFile,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "trimmed-url"),
    }, dependencies(harness));

    expect(harness.invocations.some((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))).toBe(true);
  });

  it("uses only the pinned localhost-CA projection and rejects the old loopback fallback", async () => {
    const root = makeTemporaryDirectory();
    const strictHarness = createToolAuthorityHarness();
    const strictBase = dependencies(strictHarness);
    const strictDelegate = await strictBase.connect!({} as never);
    let strictConfig: Parameters<NonNullable<PostgresLogicalBackupDependencies["connect"]>>[0] | null = null;
    await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "strict-tls"),
    }, {
      ...strictBase,
      connect: async (config) => {
        strictConfig = config;
        return strictDelegate;
      },
    });
    expect(strictConfig).toMatchObject({
      host: testResolvedAddress,
      port: 5_432,
      database: "pintpath",
      user: backupLogin,
      ssl: {
        ca: testRootCaPem,
        servername: "localhost",
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      },
    });
    expect(strictConfig?.ssl.checkServerIdentity).toBeTypeOf("function");
    const strictDump = strictHarness.invocations.find((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))!;
    expect(strictDump.env).toMatchObject({
      PGHOST: "localhost",
      PGHOSTADDR: testResolvedAddress,
      PGSSLMODE: "verify-full",
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLSNI: "1",
    });
    expect(strictDump.env.PGSSLROOTCERT).not.toBe("system");

    const loopbackUrl = `postgresql://${backupLogin}:${connectionSecret}@127.0.0.1:5432/pintpath?sslmode=disable`;
    const loopbackHarness = createToolAuthorityHarness();
    const loopbackError = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root, loopbackUrl),
      expectedSourceUrlSha256: sha256(loopbackUrl),
      outputDirectory: path.join(root, "loopback-test-seam"),
    }, dependencies(loopbackHarness)).catch((error: unknown) => error);
    expectBackupError(loopbackError, "unsafe_connection_url");
    expect(loopbackHarness.invocations).toEqual([]);
  });

  it("escapes database and password pgpass fields without exposing the secret in argv", async () => {
    const root = makeTemporaryDirectory();
    const database = "pint:path";
    const password = "secret:with\\backslash";
    const url = `postgresql://${backupLogin}:${encodeURIComponent(password)}@${sourceHostname}:5432/${encodeURIComponent(database)}?sslmode=verify-full`;
    const harness = createToolAuthorityHarness();

    await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root, url),
      expectedSourceUrlSha256: sha256(url),
      outputDirectory: path.join(root, "escaped-pgpass"),
    }, dependencies(harness));

    expect(harness.pgpassObservations[0]?.contents).toBe(
      `localhost:5432:pint\\:path:${backupLogin}:secret\\:with\\\\backslash\n`,
    );
    const dump = harness.invocations.find((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))!;
    expect(JSON.stringify(dump.args)).not.toContain(password);
    expect(dump.env.PGPASSWORD).toBeUndefined();
  });

  it.each([
    "not-a-url",
    "https://backup_user:secret@db.example.invalid/pintpath?sslmode=require",
    "postgresql://backup_user:secret@db.example.invalid/pintpath",
    "postgresql://backup_user:secret@db.example.invalid/pintpath?sslmode=disable",
    "postgresql://backup_user:secret@db.example.invalid/pintpath?sslmode=verify-ca",
    "postgresql://backup_user:secret@db.example.invalid/pintpath?sslmode=require&sslmode=verify-full",
    "postgresql://backup_user:secret@db.example.invalid/pintpath?sslmode=require&SSLMODE=require",
    "postgresql://backup_user:secret@pooler.example.invalid/pintpath?sslmode=require",
    "postgresql://backup_user:secret@pgbouncer.example.invalid/pintpath?sslmode=require",
    "postgresql://backup_user:secret@db.example.invalid:6543/pintpath?sslmode=require",
    "postgresql://backup_user:secret@db.example.invalid/pintpath?sslmode=require#fragment",
    "postgresql://backup_user:secret@db.example.invalid/pintpath?sslmode=require&options=-c%20role%3Dpostgres",
    "postgresql://backup_user@db.example.invalid/pintpath?sslmode=require",
    "postgresql://:secret@db.example.invalid/pintpath?sslmode=require",
    "postgresql://backup_user:secret@db.example.invalid/?sslmode=require",
    "postgresql://backup_user*:secret@db.example.invalid/pintpath?sslmode=verify-full",
    "postgresql://backup_user:secret@*.example.invalid/pintpath?sslmode=verify-full",
    "postgresql://backup_user:secret@db.example.invalid/pintpath*?sslmode=verify-full",
  ])("rejects an unsafe or pooled connection before invoking tools: %s", async (url) => {
    const root = makeTemporaryDirectory();
    const harness = createToolAuthorityHarness();

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root, url),
      expectedSourceUrlSha256: sha256(url),
      outputDirectory: path.join(root, "backup"),
    }, dependencies(harness)).catch((caught: unknown) => caught);

    expectBackupError(error, "unsafe_connection_url");
    expect(harness.invocations).toEqual([]);
    expect(fs.existsSync(path.join(root, "backup"))).toBe(false);
  });

  it("requires a current-user-owned regular mode-600 connection file", async () => {
    const root = makeTemporaryDirectory();
    const harness = createToolAuthorityHarness();
    const worldReadable = writeConnectionFile(root, directTlsUrl, 0o644);
    const worldReadableError = await createTestPostgresLogicalBackup({
      connectionFile: worldReadable,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "backup-mode"),
    }, dependencies(harness)).catch((caught: unknown) => caught);
    expectBackupError(worldReadableError, "unsafe_connection_file");

    fs.rmSync(worldReadable);
    const target = writeConnectionFile(root);
    const symbolicLink = path.join(root, "postgres-url-link");
    fs.symlinkSync(target, symbolicLink);
    const symbolicLinkError = await createTestPostgresLogicalBackup({
      connectionFile: symbolicLink,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "backup-link"),
    }, dependencies(harness)).catch((caught: unknown) => caught);
    expectBackupError(symbolicLinkError, "unsafe_connection_file");

    const uid = process.getuid?.() ?? 0;
    const wrongOwnerError = await createTestPostgresLogicalBackup({
      connectionFile: target,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "backup-owner"),
    }, {
      ...dependencies(harness),
      getUid: () => uid + 1,
    }).catch((caught: unknown) => caught);
    expectBackupError(wrongOwnerError, "unsafe_connection_file");
    expect(harness.invocations).toEqual([]);
  });

  it("requires a current-user mode-700 output parent without deleting an unsafe parent", async () => {
    const root = makeTemporaryDirectory();
    const outputParent = path.join(root, "unsafe-output-parent");
    fs.mkdirSync(outputParent, { mode: 0o700 });
    fs.chmodSync(outputParent, 0o755);
    const outputDirectory = path.join(outputParent, "logical-backup");
    fs.mkdirSync(outputDirectory, { mode: 0o700 });
    const sentinelPath = path.join(outputDirectory, "operator-sentinel");
    fs.writeFileSync(sentinelPath, "preserve me", { mode: 0o600 });
    const outputParentFileDescriptor = fs.openSync(
      outputParent,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
    );
    const outputDirectoryFileDescriptor = fs.openSync(
      outputDirectory,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
    );
    const sentinelFileDescriptor = fs.openSync(sentinelPath, fs.constants.O_RDONLY);
    const parentBefore = fs.fstatSync(outputParentFileDescriptor);
    const outputBefore = fs.fstatSync(outputDirectoryFileDescriptor);
    const sentinelBefore = fs.fstatSync(sentinelFileDescriptor);
    const harness = createToolAuthorityHarness();

    try {
      expect(parentBefore.uid).toBe(process.getuid?.() ?? parentBefore.uid);
      expect(parentBefore.mode & 0o7777).toBe(0o755);
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness)).catch((caught: unknown) => caught);

      expectBackupError(error, "unsafe_output_path");
      expect(harness.invocations.some((invocation) => (
        invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
      ))).toBe(false);
      const parentAfter = fs.fstatSync(outputParentFileDescriptor);
      const outputAfter = fs.fstatSync(outputDirectoryFileDescriptor);
      const sentinelAfter = fs.fstatSync(sentinelFileDescriptor);
      expect({ dev: parentAfter.dev, ino: parentAfter.ino, nlink: parentAfter.nlink }).toEqual({
        dev: parentBefore.dev,
        ino: parentBefore.ino,
        nlink: parentBefore.nlink,
      });
      expect({ dev: outputAfter.dev, ino: outputAfter.ino, nlink: outputAfter.nlink }).toEqual({
        dev: outputBefore.dev,
        ino: outputBefore.ino,
        nlink: outputBefore.nlink,
      });
      expect({ dev: sentinelAfter.dev, ino: sentinelAfter.ino, nlink: sentinelAfter.nlink }).toEqual({
        dev: sentinelBefore.dev,
        ino: sentinelBefore.ino,
        nlink: sentinelBefore.nlink,
      });
      const sentinelBytes = Buffer.alloc(Buffer.byteLength("preserve me") + 1);
      const bytesRead = fs.readSync(
        sentinelFileDescriptor,
        sentinelBytes,
        0,
        sentinelBytes.length,
        0,
      );
      expect(sentinelBytes.subarray(0, bytesRead).toString("utf8")).toBe("preserve me");
    } finally {
      fs.closeSync(sentinelFileDescriptor);
      fs.closeSync(outputDirectoryFileDescriptor);
      fs.closeSync(outputParentFileDescriptor);
    }
  });

  it("rejects an output parent whose held descriptor reports another owner", async () => {
    const root = makeTemporaryDirectory();
    const outputParent = path.join(fs.realpathSync(root), "wrong-owner-output-parent");
    fs.mkdirSync(outputParent, { mode: 0o700 });
    const outputDirectory = path.join(outputParent, "logical-backup");
    const sentinelPath = path.join(outputParent, "operator-sentinel");
    fs.writeFileSync(sentinelPath, "preserve me", { mode: 0o600 });
    const outputParentFileDescriptor = fs.openSync(
      outputParent,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
    );
    const sentinelFileDescriptor = fs.openSync(sentinelPath, fs.constants.O_RDONLY);
    const parentBefore = fs.fstatSync(outputParentFileDescriptor);
    const sentinelBefore = fs.fstatSync(sentinelFileDescriptor);
    const harness = createToolAuthorityHarness();
    const originalOpen = fs.promises.open.bind(fs.promises);
    let parentHandle: fs.promises.FileHandle | null = null;
    let ownerSpoofed = false;
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation((async (...args: unknown[]) => {
      const handle = await (originalOpen as (
        ...values: unknown[]
      ) => Promise<fs.promises.FileHandle>)(...args);
      if (String(args[0]) === outputParent) {
        parentHandle = handle;
        const originalStat = handle.stat.bind(handle);
        Object.defineProperty(handle, "stat", {
          configurable: true,
          value: async (...statArgs: unknown[]) => {
            const stat = await (originalStat as (
              ...values: unknown[]
            ) => Promise<fs.Stats>)(...statArgs);
            Object.defineProperty(stat, "uid", {
              configurable: true,
              value: parentBefore.uid + 1,
            });
            ownerSpoofed = true;
            return stat;
          },
        });
      }
      return handle;
    }) as typeof fs.promises.open);
    try {
      let error: unknown;
      try {
        error = await createTestPostgresLogicalBackup({
          connectionFile: writeConnectionFile(root),
          expectedSourceUrlSha256: sha256(directTlsUrl),
          outputDirectory,
        }, dependencies(harness)).catch((caught: unknown) => caught);
      } finally {
        openSpy.mockRestore();
      }

      expectBackupError(error, "unsafe_output_path");
      expect(ownerSpoofed).toBe(true);
      expect(harness.invocations.some((invocation) => (
        invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
      ))).toBe(false);
      const parentAfter = fs.fstatSync(outputParentFileDescriptor);
      const sentinelAfter = fs.fstatSync(sentinelFileDescriptor);
      expect({ dev: parentAfter.dev, ino: parentAfter.ino, nlink: parentAfter.nlink }).toEqual({
        dev: parentBefore.dev,
        ino: parentBefore.ino,
        nlink: parentBefore.nlink,
      });
      expect({ dev: sentinelAfter.dev, ino: sentinelAfter.ino, nlink: sentinelAfter.nlink }).toEqual({
        dev: sentinelBefore.dev,
        ino: sentinelBefore.ino,
        nlink: sentinelBefore.nlink,
      });
      const sentinelBytes = Buffer.alloc(Buffer.byteLength("preserve me") + 1);
      const bytesRead = fs.readSync(
        sentinelFileDescriptor,
        sentinelBytes,
        0,
        sentinelBytes.length,
        0,
      );
      expect(sentinelBytes.subarray(0, bytesRead).toString("utf8")).toBe("preserve me");
      expect(parentHandle).not.toBeNull();
      expect(await fileHandleIsOpen(parentHandle!)).toBe(false);
    } finally {
      fs.closeSync(sentinelFileDescriptor);
      fs.closeSync(outputParentFileDescriptor);
    }
  });

  it("reasserts the held output parent and retains only a zeroized archive before pg_dump", async () => {
    const root = makeTemporaryDirectory();
    const outputParent = fs.realpathSync(root);
    const outputDirectory = path.join(outputParent, "pre-dump-parent-drift");
    const outputParentFileDescriptor = fs.openSync(
      outputParent,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
    );
    const harness = createToolAuthorityHarness();
    let pgpassStatCalls = 0;
    let parentMutated = false;
    const retained = trackRetainedOutput(outputDirectory, (filePath, handle) => {
      if (filePath && path.basename(filePath) === "pgpass") {
        const originalStat = handle.stat.bind(handle);
        Object.defineProperty(handle, "stat", {
          configurable: true,
          value: async (...statArgs: unknown[]) => {
            const stat = await (originalStat as (
              ...values: unknown[]
            ) => Promise<fs.Stats>)(...statArgs);
            pgpassStatCalls += 1;
            if (pgpassStatCalls === 4) {
              fs.fchmodSync(outputParentFileDescriptor, 0o755);
              parentMutated = true;
            }
            return stat;
          },
        });
      }
    });

    try {
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness)).catch((caught: unknown) => caught);

      expectBackupError(error, "archive_tampered");
      expect(parentMutated).toBe(true);
      expect(pgpassStatCalls).toBeGreaterThanOrEqual(4);
      expect(fs.fstatSync(outputParentFileDescriptor).mode & 0o7777).toBe(0o755);
      expect(harness.invocations.some((invocation) => (
        invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
      ))).toBe(false);
      fs.fchmodSync(outputParentFileDescriptor, 0o700);
      await expectRetainedZeroizedOutput(retained, [POSTGRES_LOGICAL_BACKUP_ARCHIVE]);
    } finally {
      retained.tracker.restore();
      fs.fchmodSync(outputParentFileDescriptor, 0o700);
      fs.closeSync(outputParentFileDescriptor);
    }
  });

  it("refuses an existing output directory without deleting it", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "existing-backup");
    fs.mkdirSync(outputDirectory);
    const sentinel = path.join(outputDirectory, "belongs-to-operator.txt");
    fs.writeFileSync(sentinel, "preserve me");
    const harness = createToolAuthorityHarness();

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, dependencies(harness)).catch((caught: unknown) => caught);

    expectBackupError(error, "unsafe_output_path");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("preserve me");
  });

  it("never recursively removes a newly created marker when preparation fails", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = retainedOutputPaths(
      path.join(root, "prepare-catch-retained-marker"),
    ).outputDirectory;
    const victim = createHeldOperatorVictim(root, "prepare-catch");
    const rmGuard = forbidRecursiveOutputRm(outputDirectory, victim.directory);
    const harness = createToolAuthorityHarness();
    const originalOpen = fs.promises.open.bind(fs.promises);
    let parentHandle: fs.promises.FileHandle | null = null;
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation((async (
      ...args: unknown[]
    ) => {
      const filePath = String(args[0]);
      if (filePath === outputDirectory) {
        throw new Error("injected output-directory open failure");
      }
      const handle = await (originalOpen as (
        ...values: unknown[]
      ) => Promise<fs.promises.FileHandle>)(...args);
      if (filePath === path.dirname(outputDirectory)) parentHandle = handle;
      return handle;
    }) as typeof fs.promises.open);

    try {
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness)).catch((caught: unknown) => caught);

      expectBackupError(error, "unsafe_output_path");
      expect(rmGuard.callCount()).toBe(0);
      expect(rmGuard.wasSwapped()).toBe(false);
      expect(parentHandle).not.toBeNull();
      expect(await fileHandleIsOpen(parentHandle!)).toBe(false);
      expect(harness.invocations.some((invocation) => (
        invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
      ))).toBe(false);
      const markerFileDescriptor = fs.openSync(
        outputDirectory,
        fs.constants.O_RDONLY
          | (fs.constants.O_DIRECTORY ?? 0)
          | (fs.constants.O_NOFOLLOW ?? 0),
      );
      try {
        const markerStat = fs.fstatSync(markerFileDescriptor);
        expect(markerStat.isDirectory()).toBe(true);
        expect(markerStat.uid).toBe(process.getuid?.() ?? markerStat.uid);
        expect(markerStat.mode & 0o7777).toBe(0o700);
      } finally {
        fs.closeSync(markerFileDescriptor);
      }
      expectHeldOperatorVictimExact(victim);
    } finally {
      openSpy.mockRestore();
      rmGuard.restore();
      fs.closeSync(victim.sentinelFileDescriptor);
      fs.closeSync(victim.directoryFileDescriptor);
    }
  });

  it("never recursively removes a prepared marker after a final backup error", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "final-error-retained-marker");
    const victim = createHeldOperatorVictim(root, "final-error");
    const retained = trackRetainedOutput(outputDirectory);
    const rmGuard = forbidRecursiveOutputRm(retained.paths.outputDirectory, victim.directory);
    const harness = createToolAuthorityHarness({
      dumpResult: { exitCode: 1, stdout: "", stderr: "test-only failure" },
    });

    try {
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness)).catch((caught: unknown) => caught);

      expectBackupError(error, "dump_failed");
      expect(rmGuard.callCount()).toBe(0);
      expect(rmGuard.wasSwapped()).toBe(false);
      await expectRetainedZeroizedOutput(retained, [POSTGRES_LOGICAL_BACKUP_ARCHIVE]);
      expectHeldOperatorVictimExact(victim);
    } finally {
      rmGuard.restore();
      retained.tracker.restore();
      fs.closeSync(victim.sentinelFileDescriptor);
      fs.closeSync(victim.directoryFileDescriptor);
    }
  });

  it("retains a zeroized private archive marker when pg_dump fails and redacts diagnostics", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "failed-dump");
    const retained = trackRetainedOutput(outputDirectory);
    const harness = createToolAuthorityHarness({
      dumpResult: {
        exitCode: 1,
        stdout: "",
        stderr: `connection failed for ${directTlsUrl}`,
      },
    });

    try {
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness)).catch((caught: unknown) => caught);

      expectBackupError(error, "dump_failed");
      await expectRetainedZeroizedOutput(retained, [POSTGRES_LOGICAL_BACKUP_ARCHIVE]);
    } finally {
      retained.tracker.restore();
    }
  });

  it("retains a zeroized archive when the dump authority throws a credential-bearing error", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "thrown-dump-error");
    const retained = trackRetainedOutput(outputDirectory);
    const harness = createToolAuthorityHarness({ throwOnDump: true });

    try {
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness)).catch((caught: unknown) => caught);

      expectBackupError(error, "dump_failed");
      await expectRetainedZeroizedOutput(retained, [POSTGRES_LOGICAL_BACKUP_ARCHIVE]);
    } finally {
      retained.tracker.restore();
    }
  });

  it.each(["same-inode-content", "same-inode-mode"] as const)(
    "unlinks a %s pgpass drift, removes its pgpass directory, and retains a zeroized archive",
    async (pgpassMutation) => {
      const root = makeTemporaryDirectory();
      const outputDirectory = path.join(root, "pgpass-content-drift");
      const retained = trackRetainedOutput(outputDirectory);
      const harness = createToolAuthorityHarness({ pgpassMutation });

      try {
        const error = await createTestPostgresLogicalBackup({
          connectionFile: writeConnectionFile(root),
          expectedSourceUrlSha256: sha256(directTlsUrl),
          outputDirectory,
        }, dependencies(harness)).catch((caught: unknown) => caught);

        expectBackupError(error, "cleanup_failed");
        const pgpassPath = harness.pgpassObservations[0]!.path;
        expect(fs.existsSync(pgpassPath)).toBe(false);
        expect(fs.existsSync(path.dirname(pgpassPath))).toBe(false);
        await expectRetainedZeroizedOutput(retained, [POSTGRES_LOGICAL_BACKUP_ARCHIVE]);
      } finally {
        retained.tracker.restore();
      }
    },
  );

  it("never deletes a replacement pgpass and retains a zeroized archive on cleanup failure", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "pgpass-replacement");
    const retained = trackRetainedOutput(outputDirectory);
    const harness = createToolAuthorityHarness({ pgpassMutation: "replacement" });

    try {
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness)).catch((caught: unknown) => caught);

      expectBackupError(error, "cleanup_failed");
      const pgpassPath = harness.pgpassObservations[0]!.path;
      expect(fs.readFileSync(pgpassPath, "utf8")).toBe("untrusted-replacement\n");
      await expectRetainedZeroizedOutput(retained, [POSTGRES_LOGICAL_BACKUP_ARCHIVE]);
      fs.unlinkSync(pgpassPath);
      fs.rmdirSync(path.dirname(pgpassPath));
    } finally {
      retained.tracker.restore();
    }
  });

  it("removes only the trusted pgpass when an unexpected sibling blocks nonrecursive cleanup", async () => {
    const root = makeTemporaryDirectory();
    const harness = createToolAuthorityHarness({ pgpassMutation: "extra-sibling" });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "pgpass-extra-sibling"),
    }, dependencies(harness)).catch((caught: unknown) => caught);

    expectBackupError(error, "cleanup_failed");
    const pgpassPath = harness.pgpassObservations[0]!.path;
    const sibling = path.join(path.dirname(pgpassPath), "unexpected");
    expect(fs.existsSync(pgpassPath)).toBe(false);
    expect(fs.readFileSync(sibling, "utf8")).toBe("keep");
    fs.unlinkSync(sibling);
    fs.rmdirSync(path.dirname(pgpassPath));
  });

  it("unlinks the exact pgpass pathname but retains a post-spawn hardlink", async () => {
    const root = makeTemporaryDirectory();
    const harness = createToolAuthorityHarness({ pgpassMutation: "hardlink" });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "pgpass-hardlink"),
    }, dependencies(harness)).catch((caught: unknown) => caught);

    expectBackupError(error, "cleanup_failed");
    const pgpassPath = harness.pgpassObservations[0]!.path;
    const retained = path.join(path.dirname(pgpassPath), "retained-hardlink");
    expect(fs.existsSync(pgpassPath)).toBe(false);
    expect(fs.readFileSync(retained, "utf8")).toContain(connectionSecret);
    fs.unlinkSync(retained);
    fs.rmdirSync(path.dirname(pgpassPath));
  });

  it("removes an empty exact pgpass directory when the leaf disappears", async () => {
    const root = makeTemporaryDirectory();
    const harness = createToolAuthorityHarness({ pgpassMutation: "missing" });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "pgpass-missing"),
    }, dependencies(harness)).catch((caught: unknown) => caught);

    expectBackupError(error, "cleanup_failed");
    const pgpassPath = harness.pgpassObservations[0]!.path;
    expect(fs.existsSync(pgpassPath)).toBe(false);
    expect(fs.existsSync(path.dirname(pgpassPath))).toBe(false);
  });

  it("identity-safely removes a partial pgpass when writing fails before its full snapshot", async () => {
    const root = makeTemporaryDirectory();
    const harness = createToolAuthorityHarness();
    const beforePgpassEntries = pgpassTemporaryEntries();
    const originalOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, "open").mockImplementation((async (...args: unknown[]) => {
      const handle = await (originalOpen as (...values: unknown[]) => Promise<fs.promises.FileHandle>)(
        ...args,
      );
      if (path.basename(String(args[0])) === "pgpass") {
        Object.defineProperty(handle, "writeFile", {
          configurable: true,
          value: async () => { throw new Error("injected pgpass write failure"); },
        });
      }
      return handle;
    }) as typeof fs.promises.open);
    let error: unknown;
    try {
      error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory: path.join(root, "pgpass-partial-write"),
      }, dependencies(harness)).catch((caught: unknown) => caught);
    } finally {
      openSpy.mockRestore();
    }

    expectBackupError(error, "cleanup_failed");
    expect(pgpassTemporaryEntries()).toEqual(beforePgpassEntries);
    expect(harness.invocations.some((invocation) => (
      invocation.command.endsWith("pg_dump") && invocation.args[0] !== "--version"
    ))).toBe(false);
  });

  it.each([
    [
      "state receipt",
      POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      "state_receipt_failed",
      [
        POSTGRES_LOGICAL_BACKUP_ARCHIVE,
        POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      ],
    ],
    [
      "manifest",
      POSTGRES_LOGICAL_BACKUP_MANIFEST,
      "manifest_failed",
      [
        POSTGRES_LOGICAL_BACKUP_ARCHIVE,
        POSTGRES_LOGICAL_BACKUP_MANIFEST,
        POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      ],
    ],
  ] as const)(
    "rejects and zeroizes a %s mutation through its held writer descriptor",
    async (_label, artifactFile, expectedError, retainedArtifacts) => {
      const root = makeTemporaryDirectory();
      const outputDirectory = path.join(fs.realpathSync(root), `mutated-${artifactFile}`);
      const artifactPath = path.join(outputDirectory, artifactFile);
      const harness = createToolAuthorityHarness();
      let writerHandle: fs.promises.FileHandle | null = null;
      let writerOpenDuringMutation = false;
      const writerSyncStates: Array<"zero-length" | "non-empty"> = [];
      let mutated = false;
      const retained = trackRetainedOutput(outputDirectory, async (filePath, handle) => {
        if (filePath === artifactPath) {
          writerHandle = handle;
          const originalSync = handle.sync.bind(handle);
          Object.defineProperty(handle, "sync", {
            configurable: true,
            value: async () => {
              await originalSync();
              const stat = await handle.stat();
              writerSyncStates.push(stat.size === 0 ? "zero-length" : "non-empty");
              if (
                writerSyncStates.length === 2
                && writerSyncStates[1] === "non-empty"
                && !mutated
              ) {
                writerOpenDuringMutation = await fileHandleIsOpen(handle);
                writeAllToDescriptor(handle.fd, Buffer.from("tampered-after-writer"));
                mutated = true;
              }
            },
          });
        }
      });
      let error: unknown;
      try {
        error = await createTestPostgresLogicalBackup({
          connectionFile: writeConnectionFile(root),
          expectedSourceUrlSha256: sha256(directTlsUrl),
          outputDirectory,
        }, dependencies(harness)).catch((caught: unknown) => caught);
      } finally {
        retained.tracker.restore();
      }

      expectBackupError(error, expectedError);
      expect(mutated).toBe(true);
      expect(writerSyncStates).toEqual(["zero-length", "non-empty", "zero-length"]);
      expect(writerOpenDuringMutation).toBe(true);
      expect(writerHandle).not.toBeNull();
      expect(await fileHandleIsOpen(writerHandle!)).toBe(false);
      await expectRetainedZeroizedOutput(retained, retainedArtifacts);
    },
  );

  it("closes the exact canonical writer handle when its zeroization fsync fails", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(fs.realpathSync(root), "writer-zeroize-sync-failure");
    const artifactPath = path.join(outputDirectory, POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT);
    const harness = createToolAuthorityHarness();
    let writerHandle: fs.promises.FileHandle | null = null;
    let writerFileDescriptor: number | null = null;
    let writerCloseCalls = 0;
    let mutated = false;
    const syncEvents: Array<
      "zero-length-synced" | "non-empty-synced" | "zero-length-sync-failed"
    > = [];
    const retained = trackRetainedOutput(outputDirectory, async (filePath, handle) => {
      if (filePath !== artifactPath) return;
      writerHandle = handle;
      writerFileDescriptor = handle.fd;
      const originalSync = handle.sync.bind(handle);
      const originalClose = handle.close.bind(handle);
      let syncCalls = 0;
      Object.defineProperty(handle, "sync", {
        configurable: true,
        value: async () => {
          syncCalls += 1;
          const before = await handle.stat();
          if (syncCalls === 3) {
            if (before.size === 0) syncEvents.push("zero-length-sync-failed");
            throw new Error("injected canonical writer zeroization sync failure");
          }
          await originalSync();
          const after = await handle.stat();
          syncEvents.push(after.size === 0 ? "zero-length-synced" : "non-empty-synced");
          if (syncCalls === 2) {
            writeAllToDescriptor(handle.fd, Buffer.from("tampered-canonical-writer"));
            mutated = true;
          }
        },
      });
      Object.defineProperty(handle, "close", {
        configurable: true,
        value: async () => {
          writerCloseCalls += 1;
          await originalClose();
        },
      });
    });

    try {
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness)).catch((caught: unknown) => caught);

      expectBackupError(error, "cleanup_failed");
      expect(mutated).toBe(true);
      expect(syncEvents).toEqual([
        "zero-length-synced",
        "non-empty-synced",
        "zero-length-sync-failed",
      ]);
      expect(writerCloseCalls).toBe(1);
      expect(writerHandle).not.toBeNull();
      expect(await fileHandleIsOpen(writerHandle!)).toBe(false);
      expect(writerFileDescriptor).not.toBeNull();
      let descriptorError: NodeJS.ErrnoException | null = null;
      try {
        fs.fstatSync(writerFileDescriptor!);
      } catch (error) {
        descriptorError = error as NodeJS.ErrnoException;
      }
      expect(descriptorError?.code).toBe("EBADF");
      await expectRetainedZeroizedOutput(retained, [
        POSTGRES_LOGICAL_BACKUP_ARCHIVE,
        POSTGRES_LOGICAL_BACKUP_STATE_RECEIPT,
      ]);
    } finally {
      retained.tracker.restore();
    }
  });

  it("rejects pg_restore validation and retains only a zeroized archive", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "invalid-archive");
    const retained = trackRetainedOutput(outputDirectory);
    const harness = createToolAuthorityHarness({
      listingResult: {
        exitCode: 1,
        stdout: "",
        stderr: `archive from ${directTlsUrl} is corrupt`,
      },
    });

    try {
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness)).catch((caught: unknown) => caught);

      expectBackupError(error, "archive_invalid");
      await expectRetainedZeroizedOutput(retained, [POSTGRES_LOGICAL_BACKUP_ARCHIVE]);
    } finally {
      retained.tracker.restore();
    }
  });

  it("detects pg_restore-time tampering and retains only a zeroized archive", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "tampered-archive");
    const retained = trackRetainedOutput(outputDirectory);
    const harness = createToolAuthorityHarness({ tamperDuringListing: true });

    try {
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness)).catch((caught: unknown) => caught);

      expectBackupError(error, "archive_tampered");
      expect(harness.archiveDescriptorObservations).toEqual({
        dump: {
          fileDescriptor: expect.any(Number),
          bytes: Buffer.from("PGDMP-test-archive"),
        },
        restoreList: {
          fileDescriptor: expect.any(Number),
          bytes: Buffer.from("PGDMP-test-archive"),
        },
        tamper: {
          fileDescriptor: harness.archiveDescriptorObservations.dump?.fileDescriptor,
          bytes: Buffer.from("tampered"),
        },
      });
      expect(harness.archiveDescriptorObservations.restoreList?.fileDescriptor).not.toBe(
        harness.archiveDescriptorObservations.dump?.fileDescriptor,
      );
      const restoreList = harness.invocations.find((invocation) => (
        invocation.args.includes("--list")
      ));
      expect(restoreList?.args).toEqual(["--list", "--format=custom"]);
      expect(restoreList?.stdinFileDescriptor).toBe(
        harness.archiveDescriptorObservations.restoreList?.fileDescriptor,
      );
      await expectRetainedZeroizedOutput(retained, [POSTGRES_LOGICAL_BACKUP_ARCHIVE]);
    } finally {
      retained.tracker.restore();
    }
  });

  it("rejects an incomplete schema listing and retains only a zeroized archive", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "missing-schema");
    const retained = trackRetainedOutput(outputDirectory);
    const harness = createToolAuthorityHarness({
      listing: validArchiveListing().replace(
        "3; 2615 101 SCHEMA - pintpath_ops backup_user\n",
        "",
      ),
    });

    try {
      const error = await createTestPostgresLogicalBackup({
        connectionFile: writeConnectionFile(root),
        expectedSourceUrlSha256: sha256(directTlsUrl),
        outputDirectory,
      }, dependencies(harness)).catch((caught: unknown) => caught);

      expectBackupError(error, "archive_invalid");
      await expectRetainedZeroizedOutput(retained, [POSTGRES_LOGICAL_BACKUP_ARCHIVE]);
    } finally {
      retained.tracker.restore();
    }
  });

  it("rejects mismatched pg_dump and pg_restore majors before creating output", async () => {
    const root = makeTemporaryDirectory();
    const outputDirectory = path.join(root, "mismatched-tools");
    const harness = createToolAuthorityHarness({ pgRestoreVersion: "16.8" });

    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory,
    }, dependencies(harness)).catch((caught: unknown) => caught);

    expectBackupError(error, "tool_unavailable_or_unsupported");
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });

  it("fails closed for a privileged source login before creating an archive", async () => {
    const root = makeTemporaryDirectory();
    const harness = createToolAuthorityHarness();
    const base = dependencies(harness);
    let closed = false;
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "unsafe-role"),
    }, {
      ...base,
      connect: async () => ({
        query: async <Row extends Record<string, unknown>>(text: string) => {
          if (!text.includes("source-identity")) throw new Error("unexpected query");
          return {
            rows: [{
              systemIdentifier: "1", databaseOid: "2", databaseName: "pintpath",
              serverVersionNum: "170006", roleName: "privileged_backup", canLogin: true,
              superuser: true, createDatabase: false, createRole: false,
              replication: false, bypassRls: false, canSetMigrator: true,
              transactionReadOnly: false, inRecovery: false,
            } as unknown as Row],
            rowCount: 1,
          };
        },
        close: async () => { closed = true; },
      }),
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "source_unreachable_or_unsafe");
    expect(closed).toBe(true);
    expect(fs.existsSync(path.join(root, "unsafe-role"))).toBe(false);
    expect(harness.invocations.some((invocation) => invocation.command.endsWith("pg_dump")
      && invocation.args[0] !== "--version")).toBe(false);
  });

  it.each([
    ["an unversioned login", { roleName: "backup_user" }],
    ["a login bound to another database OID", {
      roleName: "pintpath_logical_backup_d16656_v1",
    }],
    ["a mismatched derived backup role", {
      backupRoleName: "pintpath_logical_backup_d16656",
    }],
    ["an inheriting login", { inheritsPrivileges: true }],
    ["an unbounded connection limit", { connectionLimit: -1 }],
    ["a VALID UNTIL boundary", { validUntilIsNull: false }],
    ["a second membership", { membershipCount: 2 }],
    ["a child membership", { childMembershipCount: 1 }],
    ["an inherited backup membership", { hasExactLogicalBackupMembership: false }],
    ["missing SET authority for the backup group", { canSetLogicalBackup: false }],
    ["migrator SET authority", { canSetMigrator: true }],
    ["runtime SET authority", { canSetRuntime: true }],
    ["sibling scoped-role SET authority", { canSetSiblingLogicalBackup: true }],
    ["grantable or extra database authority", { directDatabasePrivilegeCount: 2 }],
    ["missing direct database CONNECT", { hasDirectDatabaseConnect: false }],
    ["extra function authority", { directFunctionPrivilegeCount: 2 }],
    ["missing direct control-system EXECUTE", { hasDirectControlSystemExecute: false }],
    ["a direct private-object grant", { directPrivateObjectPrivilegeCount: 1 }],
    ["a privately owned object", { ownedPrivateObjectCount: 1 }],
    ["a role setting", { roleSettingCount: 1 }],
    ["an extra shared dependency", { sharedDependencyCount: 3 }],
    ["a wrong shared dependency", { exactSharedDependencyCount: 1 }],
  ])("rejects %s before creating an archive", async (_description, override) => {
    const root = makeTemporaryDirectory();
    const harness = createToolAuthorityHarness();
    const base = dependencies(harness);
    const delegate = await base.connect!({} as never);
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "unsafe-login-contract"),
    }, {
      ...base,
      connect: async () => ({
        query: async <Row extends Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await delegate.query<Row>(text, values);
          if (!text.includes("source-identity")) return result;
          return {
            ...result,
            rows: result.rows.map((row) => ({ ...row, ...override } as Row)),
          };
        },
        close: async () => delegate.close(),
      }),
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "source_unreachable_or_unsafe");
    expect(fs.existsSync(path.join(root, "unsafe-login-contract"))).toBe(false);
    expect(harness.invocations.some((invocation) => invocation.command.endsWith("pg_dump")
      && invocation.args[0] !== "--version")).toBe(false);
  });

  it.each([
    ["a parent membership", { membershipCount: 1 }],
    ["a second child", { childMembershipCount: 2 }],
    ["a non-session child", { exactSessionLoginChildCount: 0 }],
    ["a direct database ACL", { directDatabasePrivilegeCount: 1 }],
    ["a direct function ACL", { directFunctionPrivilegeCount: 1 }],
    ["a role setting", { roleSettingCount: 1 }],
    ["current-database ownership", { ownedCurrentDatabaseObjectCount: 1 }],
    ["an unexpected shared dependency", { sharedDependencyCount: 62 }],
    ["a non-allowlisted shared dependency", { exactSharedDependencyCount: 60 }],
    ["an extra schema ACL", { directSchemaPrivilegeCount: 3 }],
    ["a missing private schema", { privateSchemaCount: 1 }],
    ["an unsafe schema ACL", { selectOnlySchemaCount: 1 }],
    ["a write-capable table grant", { selectOnlyRelationCount: 58 }],
    ["an extra relation ACL", { directRelationPrivilegeCount: 60 }],
    ["a missing private relation", { privateRelationCount: 58 }],
    ["a table without forced RLS", { forceRlsRelationCount: 58 }],
    ["an unexpected sequence", { privateSequenceCount: 1, selectOnlySequenceCount: 1 }],
    ["a private function grant", { executablePrivateFunctionCount: 1 }],
    ["a direct column grant", { directColumnPrivilegeCount: 1 }],
    ["an extra arbitrary named-role policy", { privatePolicyCount: 237 }],
    ["a malformed canonical base policy", { exactBasePolicyCount: 176 }],
    ["a missing RLS policy", { publicPrivatePolicyCount: 58 }],
    ["a malformed backup RLS policy", { exactLogicalBackupSelectPolicyCount: 58 }],
    ["an unsafe PUBLIC policy", { unsafePublicPrivatePolicyCount: 1 }],
    ["an unsafe reserved policy name", { unsafeReservedPolicyNameCount: 1 }],
    ["a policy naming the scoped role", { directScopedPolicyCount: 1 }],
  ])("rejects the effective backup group with %s", async (_description, override) => {
    const root = makeTemporaryDirectory();
    const harness = createToolAuthorityHarness();
    const base = dependencies(harness);
    const delegate = await base.connect!({} as never);
    const error = await createTestPostgresLogicalBackup({
      connectionFile: writeConnectionFile(root),
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "unsafe-group-contract"),
    }, {
      ...base,
      connect: async () => ({
        query: async <Row extends Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ) => {
          const result = await delegate.query<Row>(text, values);
          if (!text.includes("effective-role")) return result;
          return {
            ...result,
            rows: result.rows.map((row) => ({ ...row, ...override } as Row)),
          };
        },
        close: async () => delegate.close(),
      }),
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "source_unreachable_or_unsafe");
    expect(fs.existsSync(path.join(root, "unsafe-group-contract"))).toBe(false);
    expect(harness.invocations.some((invocation) => invocation.command.endsWith("pg_dump")
      && invocation.args[0] !== "--version")).toBe(false);
  });

  it("rolls back, resets the role, closes, and removes artifacts on state failure", async () => {
    const root = makeTemporaryDirectory();
    const connectionFile = writeConnectionFile(root);
    const harness = createToolAuthorityHarness();
    const base = dependencies(harness);
    const queries: string[] = [];
    let closed = false;
    const delegate = await base.connect!({} as never);
    const error = await createTestPostgresLogicalBackup({
      connectionFile,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "state-failure"),
    }, {
      ...base,
      connect: async () => ({
        query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
          queries.push(text);
          return delegate.query<Row>(text, values);
        },
        close: async () => { closed = true; },
      }),
      computeState: async () => { throw new Error(`raw state failure ${directTlsUrl}`); },
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "source_contract_invalid");
    expect(queries.some((query) => query.includes("rollback-snapshot"))).toBe(true);
    expect(queries.some((query) => query.includes("reset-role"))).toBe(true);
    expect(closed).toBe(true);
    expect(fs.existsSync(path.join(root, "state-failure"))).toBe(false);
  });

  it("detects a connection-file identity change before pg_dump", async () => {
    const root = makeTemporaryDirectory();
    const connectionFile = writeConnectionFile(root);
    const harness = createToolAuthorityHarness();
    const base = dependencies(harness);
    const error = await createTestPostgresLogicalBackup({
      connectionFile,
      expectedSourceUrlSha256: sha256(directTlsUrl),
      outputDirectory: path.join(root, "connection-swap"),
    }, {
      ...base,
      computeState: async () => {
        fs.writeFileSync(
          connectionFile,
          "postgresql://other:replacement@other.invalid/db?sslmode=require\n",
          { mode: 0o600 },
        );
        fs.chmodSync(connectionFile, 0o600);
        return fakeStateInventory();
      },
    }).catch((caught: unknown) => caught);

    expectBackupError(error, "unsafe_connection_file");
    expect(fs.existsSync(path.join(root, "connection-swap"))).toBe(false);
    expect(harness.invocations.some((invocation) => invocation.command.endsWith("pg_dump")
      && invocation.args[0] !== "--version")).toBe(false);
  });

  it("emits one canonical, secret-free JSON failure from the CLI", async () => {
    const output: string[] = [];
    const cliDependencies: Partial<PostgresLogicalBackupCliDependencies> = {
      createBackup: async () => {
        throw new Error(`raw child error exposed ${directTlsUrl}`);
      },
      writeOutput: (value) => output.push(value),
    };

    const exitCode = await runPostgresLogicalBackupCli([
      "--connection-file", "/private/connection-file",
      "--expected-source-url-sha256", "e".repeat(64),
      "--transport-profile", POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      "--root-ca-file", "/private/railway-root-ca.pem",
      "--expected-root-ca-der-sha256", testRootCaDerSha256,
      "--pg-dump-file", testPgDumpFile,
      "--expected-pg-dump-sha256", testPgDumpSha256,
      "--pg-restore-file", testPgRestoreFile,
      "--expected-pg-restore-sha256", testPgRestoreSha256,
      "--output", "/private/output",
    ], cliDependencies);

    expect(exitCode).toBe(1);
    expect(output).toEqual([
      "{\"failureCode\":\"invalid_arguments\",\"ok\":false,\"schemaVersion\":1}\n",
    ]);
    expect(output[0]).not.toContain(connectionSecret);
    expect(output[0]).not.toContain(sourceHostname);
    expect(output[0]).not.toContain("backup_user");
  });

  it("emits only hashes, not local paths, after a successful CLI backup", async () => {
    const output: string[] = [];
    let receivedOptions:
      | Parameters<PostgresLogicalBackupCliDependencies["createBackup"]>[0]
      | null = null;
    const cliDependencies: Partial<PostgresLogicalBackupCliDependencies> = {
      createBackup: async (options) => {
        receivedOptions = options;
        return {
          schemaVersion: 3,
          ok: true,
          outputDirectory: "/Users/operator/private/release-id/postgres-logical",
          archivePath: "/Users/operator/private/release-id/postgres-logical/pintpath-postgres.dump",
          manifestPath: "/Users/operator/private/release-id/postgres-logical/manifest.json",
          stateReceiptPath:
            "/Users/operator/private/release-id/postgres-logical/state-receipt.json",
          archiveSha256: "a".repeat(64),
          manifestSha256: "b".repeat(64),
          stateReceiptSha256: "c".repeat(64),
          authoritativeRowCount: "42",
          overallStateSha256: "d".repeat(64),
        };
      },
      writeOutput: (value) => output.push(value),
    };

    const exitCode = await runPostgresLogicalBackupCli([
      "--connection-file", "/private/connection-file",
      "--expected-source-url-sha256", "e".repeat(64),
      "--transport-profile", POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      "--root-ca-file", "/private/railway-root-ca.pem",
      "--expected-root-ca-der-sha256", testRootCaDerSha256,
      "--pg-dump-file", testPgDumpFile,
      "--expected-pg-dump-sha256", testPgDumpSha256,
      "--pg-restore-file", testPgRestoreFile,
      "--expected-pg-restore-sha256", testPgRestoreSha256,
      "--output", "/private/output",
    ], cliDependencies);

    expect(exitCode).toBe(0);
    expect(receivedOptions).toEqual({
      connectionFile: "/private/connection-file",
      expectedSourceUrlSha256: "e".repeat(64),
      transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaFile: "/private/railway-root-ca.pem",
      expectedRootCaDerSha256: testRootCaDerSha256,
      pgDumpFile: testPgDumpFile,
      expectedPgDumpSha256: testPgDumpSha256,
      pgRestoreFile: testPgRestoreFile,
      expectedPgRestoreSha256: testPgRestoreSha256,
      outputDirectory: "/private/output",
    });
    expect(output).toEqual([
      `{"archiveSha256":"${"a".repeat(64)}","authoritativeRowCount":"42","manifestSha256":"${"b".repeat(64)}","ok":true,"overallStateSha256":"${"d".repeat(64)}","schemaVersion":3,"stateReceiptSha256":"${"c".repeat(64)}"}\n`,
    ]);
    expect(output[0]).not.toContain("/Users/operator");
    expect(output[0]).not.toContain("release-id");
  });

  it.each([
    "--expected-source-url-sha256",
    "--transport-profile",
    "--root-ca-file",
    "--expected-root-ca-der-sha256",
    "--pg-dump-file",
    "--expected-pg-dump-sha256",
    "--pg-restore-file",
    "--expected-pg-restore-sha256",
  ])("requires the %s CLI flag before invoking the backup", async (missingFlag) => {
    const output: string[] = [];
    let invoked = false;
    const completeArguments = [
      "--connection-file", "/private/connection-file",
      "--expected-source-url-sha256", "e".repeat(64),
      "--transport-profile", POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      "--root-ca-file", "/private/railway-root-ca.pem",
      "--expected-root-ca-der-sha256", testRootCaDerSha256,
      "--pg-dump-file", testPgDumpFile,
      "--expected-pg-dump-sha256", testPgDumpSha256,
      "--pg-restore-file", testPgRestoreFile,
      "--expected-pg-restore-sha256", testPgRestoreSha256,
      "--output", "/private/output",
    ];
    const missingIndex = completeArguments.indexOf(missingFlag);
    completeArguments.splice(missingIndex, 2);
    const exitCode = await runPostgresLogicalBackupCli(completeArguments, {
      createBackup: async () => {
        invoked = true;
        throw new Error("must not run");
      },
      writeOutput: (value) => output.push(value),
    });

    expect(exitCode).toBe(1);
    expect(invoked).toBe(false);
    expect(output).toEqual([
      "{\"failureCode\":\"invalid_arguments\",\"ok\":false,\"schemaVersion\":1}\n",
    ]);
  });

  it("rejects a non-exact transport profile in the CLI before invoking backup", async () => {
    let invoked = false;
    const output: string[] = [];
    const exitCode = await runPostgresLogicalBackupCli([
      "--connection-file", "/private/connection-file",
      "--expected-source-url-sha256", "e".repeat(64),
      "--transport-profile", "railway-stock-localhost-ca-v2",
      "--root-ca-file", "/private/railway-root-ca.pem",
      "--expected-root-ca-der-sha256", testRootCaDerSha256,
      "--pg-dump-file", testPgDumpFile,
      "--expected-pg-dump-sha256", testPgDumpSha256,
      "--pg-restore-file", testPgRestoreFile,
      "--expected-pg-restore-sha256", testPgRestoreSha256,
      "--output", "/private/output",
    ], {
      createBackup: async () => {
        invoked = true;
        throw new Error("must not run");
      },
      writeOutput: (value) => output.push(value),
    });
    expect(exitCode).toBe(1);
    expect(invoked).toBe(false);
    expect(output).toEqual([
      "{\"failureCode\":\"invalid_arguments\",\"ok\":false,\"schemaVersion\":1}\n",
    ]);
  });
});
