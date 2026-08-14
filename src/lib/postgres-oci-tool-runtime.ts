import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE,
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS,
} from "./postgres-tool-runtime-closure-v4.js";
import {
  type OpenPostgresToolAuthorityOptions,
  type PostgresDumpOperationInput,
  type PostgresDumpToolAuthority,
  type PostgresListToolAuthority,
  type PostgresRestoreOperationInput,
  type PostgresRestoreToolAuthority,
  type PostgresToolAuthorityProcessInvocation,
  type PostgresToolAuthorityProcessRunner,
  type PostgresToolProcessResult,
} from "./postgres-tool-authority.js";

export const POSTGRES_OCI_TOOL_RUNTIME_PROFILE =
  "pintpath-postgres-17.10-operational-oci-linux-amd64-v1" as const;
export const POSTGRES_OCI_TOOL_RUNTIME_DOCKER_FILE =
  "/usr/local/libexec/pintpath/docker-static-29.7.2" as const;
export const POSTGRES_OCI_TOOL_RUNTIME_DOCKER_VERSION = "29.7.2" as const;
export const POSTGRES_OCI_TOOL_RUNTIME_DOCKER_SHA256 =
  "e45381109c685311cf84c5e33a1aca7da81d6b55c0f9aed74091fc08c3a94f13" as const;
export const POSTGRES_OCI_TOOL_RUNTIME_DOCKER_ARCHIVE_SHA256 =
  "803d433f226db4776e1768fd319fc6c6e4935a456acf84fcc0080818b854bc8f" as const;
export const POSTGRES_OCI_TOOL_RUNTIME_DOCKER_SOURCE =
  "https://download.docker.com/linux/static/stable/x86_64/docker-29.7.2.tgz" as const;
export const POSTGRES_OCI_TOOL_RUNTIME_IMAGE =
  `docker.io/library/postgres@${POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.platformManifestDigest}`;
export const POSTGRES_OCI_TOOL_RUNTIME_POLICY_ENV =
  "PINTPATH_POSTGRES_OCI_EGRESS_POLICY_FILE" as const;
export const POSTGRES_OCI_TOOL_RUNTIME_POLICY_SHA256_ENV =
  "PINTPATH_POSTGRES_OCI_EGRESS_POLICY_SHA256" as const;
export const POSTGRES_OCI_TOOL_RUNTIME_PROFILE_ENV =
  "PINTPATH_POSTGRES_OCI_RUNTIME_PROFILE" as const;
export const POSTGRES_OCI_TOOL_RUNTIME_OPERATION_ENV =
  "PINTPATH_POSTGRES_OCI_OPERATION_CLASS" as const;
export const POSTGRES_OCI_TOOL_RUNTIME_RESTORE_CA_SHA256_ENV =
  "PINTPATH_POSTGRES_OCI_RESTORE_ROOT_CA_SHA256" as const;

const DOCKER_HOST = "unix:///var/run/docker.sock";
const DOCKER_SOCKET_FILE = "/var/run/docker.sock";
const NETWORK_POLICY_LABEL = "au.pintpath.postgres-egress-policy-sha256";
const CONTAINER_LABEL = "au.pintpath.postgres-tool-runtime";
const NETWORK_DRIVER = "pintpath-egress-v1";
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_NETWORK_NAME = /^pintpath-[a-z0-9-]{1,55}-postgres-egress$/;
const SAFE_CONTAINER_NAME = /^pintpath-pg-(?:dump|restore)-[a-f0-9]{24}$/;
const MAX_DOCKER_OUTPUT = 4 * 1024 * 1024;
const DOCKER_TIMEOUT = 60_000;
const IMAGE_CONFIG_DIGEST = POSTGRES_TOOL_RUNTIME_CLOSURE_V4_IMAGE.configDigest;
const IMAGE_DATA_DIRECTORY = "/var/lib/postgresql/data";
const WORK_DIRECTORY = "/tmp";
const TOOL_PATHS = Object.freeze({
  pg_dump: "/usr/local/bin/pg_dump",
  pg_restore: "/usr/local/bin/pg_restore",
});
const TOOL_HASHES = Object.freeze(Object.fromEntries(
  POSTGRES_TOOL_RUNTIME_CLOSURE_V4_FILES
    .filter(({ path: file }) => file === TOOL_PATHS.pg_dump || file === TOOL_PATHS.pg_restore)
    .map(({ path: file, sha256 }) => [path.basename(file), sha256]),
) as Readonly<Record<"pg_dump" | "pg_restore", string>>);
const DUMP_ENVIRONMENT_KEYS = Object.freeze([
  "PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGSSLMODE",
  "PGSSLROOTCERT", "PGSSLMINPROTOCOLVERSION", "PGSSLSNI", "PGGSSENCMODE",
  "PGCONNECT_TIMEOUT", "PGAPPNAME", "PGPASSFILE",
] as const);
const RESTORE_ENVIRONMENT_KEYS = Object.freeze([
  "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE",
  "PGGSSENCMODE", "PGCONNECT_TIMEOUT", "PGAPPNAME",
] as const);
const RESTORE_TLS_ENVIRONMENT_KEYS = Object.freeze([
  ...RESTORE_ENVIRONMENT_KEYS,
  "PGHOSTADDR", "PGSSLROOTCERT", "PGSSLMINPROTOCOLVERSION", "PGSSLSNI",
] as const);

type ToolName = keyof typeof TOOL_PATHS;
type OperationClass = "backup" | "restore";

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface TrustedInputFile {
  readonly file: string;
  readonly descriptor: number;
  readonly identity: FileIdentity;
  readonly sha256: string;
}

interface EgressPolicy {
  readonly operationClass: OperationClass;
  readonly containerdCommitSha256: string;
  readonly daemonIdSha256: string;
  readonly daemonNameSha256: string;
  readonly dockerRootDirSha256: string;
  readonly kernelVersionSha256: string;
  readonly networkId: string;
  readonly networkName: string;
  readonly networkPluginId: string;
  readonly operatingSystemSha256: string;
  readonly runcCommitSha256: string;
  readonly securityOptionsSha256: string;
  readonly host: string;
  readonly hostAddress: string;
  readonly port: string;
}

interface RuntimeConfiguration {
  readonly operationClass: OperationClass;
  readonly policyFile: string;
  readonly expectedPolicySha256: string;
  readonly expectedRestoreCaSha256: string | null;
}

interface OciMount {
  readonly source: string;
  readonly destination: string;
  readonly input: TrustedInputFile;
}

interface OciExecutionPlan {
  readonly tool: ToolName;
  readonly toolArguments: readonly string[];
  readonly toolEnvironment: Readonly<Record<string, string>>;
  readonly mounts: readonly OciMount[];
  readonly networkName: "none" | string;
  readonly forbiddenSecret: string | null;
  readonly runAsUid: number;
  readonly runAsGid: number;
}

export class PostgresOciToolRuntimeError extends Error {
  constructor() {
    super("postgres_oci_tool_runtime_rejected");
    this.name = "PostgresOciToolRuntimeError";
  }
}

function reject(): never {
  throw new PostgresOciToolRuntimeError();
}

function identity(stat: fs.BigIntStats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return Object.keys(left).every((key) => (
    left[key as keyof FileIdentity] === right[key as keyof FileIdentity]
  ));
}

function sameStableFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function assertHardenedWorker(): void {
  if (
    process.platform !== "linux"
    || process.arch !== "x64"
    || process.env.NODE_ENV !== "production"
    || !process.execArgv.includes("--frozen-intrinsics")
    || !process.execArgv.includes("--disable-proto=throw")
    || !Object.isFrozen(Promise)
    || !Object.isFrozen(Promise.prototype)
    || !Object.isFrozen(Object)
    || !Object.isFrozen(Object.prototype)
  ) reject();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") reject();
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(",")}}`;
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject();
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    reject();
  }
}

function hashDescriptor(descriptor: number, bytes: bigint): string {
  if (bytes < 1n || bytes > 128n * 1024n * 1024n) reject();
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0n;
  try {
    while (position < bytes) {
      const requested = Number(bytes - position > BigInt(buffer.length)
        ? BigInt(buffer.length)
        : bytes - position);
      const read = fs.readSync(descriptor, buffer, 0, requested, Number(position));
      if (read !== requested) reject();
      digest.update(buffer.subarray(0, read));
      position += BigInt(read);
    }
    if (fs.readSync(descriptor, buffer, 0, 1, Number(position)) !== 0) reject();
    return digest.digest("hex");
  } finally {
    buffer.fill(0);
  }
}

function assertRootOwnedAncestors(file: string): void {
  let current = path.dirname(file);
  while (true) {
    const stat = fs.lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) reject();
    if (current === "/") return;
    const parent = path.dirname(current);
    if (parent === current) reject();
    current = parent;
  }
}

function openDockerClient(): TrustedInputFile {
  const file = POSTGRES_OCI_TOOL_RUNTIME_DOCKER_FILE;
  if (fs.realpathSync.native(file) !== file) reject();
  assertRootOwnedAncestors(file);
  const before = identity(fs.lstatSync(file, { bigint: true }));
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const held = identity(fs.fstatSync(descriptor, { bigint: true }));
    const permissions = held.mode & 0o7777n;
    if (
      !fs.lstatSync(file).isFile()
      || !sameIdentity(before, held)
      || held.uid !== 0n
      || held.nlink !== 1n
      || (permissions !== 0o555n && permissions !== 0o755n)
      || (permissions & 0o022n) !== 0n
    ) reject();
    const sha256 = hashDescriptor(descriptor, held.size);
    if (sha256 !== POSTGRES_OCI_TOOL_RUNTIME_DOCKER_SHA256) reject();
    return { file, descriptor, identity: held, sha256 };
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* rejected below */ }
    throw error;
  }
}

function assertTrustedInput(input: TrustedInputFile, expectedSha256 = input.sha256): void {
  const descriptor = identity(fs.fstatSync(input.descriptor, { bigint: true }));
  const current = identity(fs.lstatSync(input.file, { bigint: true }));
  if (
    fs.realpathSync.native(input.file) !== input.file
    || !sameIdentity(input.identity, descriptor)
    || !sameIdentity(input.identity, current)
    || hashDescriptor(input.descriptor, input.identity.size) !== expectedSha256
  ) reject();
}

function closeTrustedInput(input: TrustedInputFile): void {
  assertTrustedInput(input);
  fs.closeSync(input.descriptor);
}

function openCurrentUidInput(file: string, maximumBytes: number): TrustedInputFile {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || fs.realpathSync.native(file) !== file) {
    reject();
  }
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 1) reject();
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const held = identity(fs.fstatSync(descriptor, { bigint: true }));
    const current = identity(fs.lstatSync(file, { bigint: true }));
    if (
      !sameIdentity(held, current)
      || held.uid !== BigInt(uid)
      || held.nlink !== 1n
      || (held.mode & 0o7777n) !== 0o600n
      || held.size < 1n
      || held.size > BigInt(maximumBytes)
    ) reject();
    return { file, descriptor, identity: held, sha256: hashDescriptor(descriptor, held.size) };
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* rejected below */ }
    throw error;
  }
}

function readRootOwnedPolicy(configuration: RuntimeConfiguration): {
  readonly policy: EgressPolicy;
  readonly input: TrustedInputFile;
} {
  const file = configuration.policyFile;
  if (
    !file.startsWith("/etc/pintpath/")
    || !file.endsWith(".json")
    || path.normalize(file) !== file
    || fs.realpathSync.native(file) !== file
  ) reject();
  assertRootOwnedAncestors(file);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const held = identity(fs.fstatSync(descriptor, { bigint: true }));
    const current = identity(fs.lstatSync(file, { bigint: true }));
    const permissions = held.mode & 0o7777n;
    if (
      !sameIdentity(held, current)
      || held.uid !== 0n
      || held.nlink !== 1n
      || (permissions !== 0o444n && permissions !== 0o644n)
      || held.size < 1n
      || held.size > 65_536n
    ) reject();
    const bytes = Buffer.alloc(Number(held.size));
    try {
      if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) reject();
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== configuration.expectedPolicySha256) reject();
      const text = bytes.toString("utf8");
      const value = JSON.parse(text) as unknown;
      if (`${canonicalJson(value)}\n` !== text) reject();
      const record = exactRecord(value);
      exactKeys(record, [
        "schemaVersion", "kind", "operationClass", "containerdCommitSha256",
        "daemonIdSha256", "daemonNameSha256", "dockerRootDirSha256",
        "kernelVersionSha256", "networkId", "networkName", "networkPluginId",
        "operatingSystemSha256", "runcCommitSha256", "securityOptionsSha256",
        "host", "hostAddress", "port",
      ]);
      if (
        record.schemaVersion !== 1
        || record.kind !== "pintpath-postgres-oci-egress-policy"
        || record.operationClass !== configuration.operationClass
        || typeof record.containerdCommitSha256 !== "string"
        || !SHA256.test(record.containerdCommitSha256)
        || typeof record.daemonIdSha256 !== "string"
        || !SHA256.test(record.daemonIdSha256)
        || typeof record.daemonNameSha256 !== "string"
        || !SHA256.test(record.daemonNameSha256)
        || typeof record.dockerRootDirSha256 !== "string"
        || !SHA256.test(record.dockerRootDirSha256)
        || typeof record.kernelVersionSha256 !== "string"
        || !SHA256.test(record.kernelVersionSha256)
        || typeof record.networkId !== "string"
        || !SHA256.test(record.networkId)
        || typeof record.networkName !== "string"
        || !SAFE_NETWORK_NAME.test(record.networkName)
        || typeof record.networkPluginId !== "string"
        || !SHA256.test(record.networkPluginId)
        || typeof record.operatingSystemSha256 !== "string"
        || !SHA256.test(record.operatingSystemSha256)
        || typeof record.runcCommitSha256 !== "string"
        || !SHA256.test(record.runcCommitSha256)
        || typeof record.securityOptionsSha256 !== "string"
        || !SHA256.test(record.securityOptionsSha256)
        || typeof record.host !== "string"
        || record.host.length < 1
        || record.host.length > 253
        || typeof record.hostAddress !== "string"
        || net.isIP(record.hostAddress) === 0
        || record.port !== "5432"
      ) reject();
      return {
        policy: record as unknown as EgressPolicy,
        input: { file, descriptor, identity: held, sha256 },
      };
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* rejected below */ }
    throw error;
  }
}

function runtimeConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeConfiguration | null {
  const profile = environment[POSTGRES_OCI_TOOL_RUNTIME_PROFILE_ENV];
  const policyFile = environment[POSTGRES_OCI_TOOL_RUNTIME_POLICY_ENV];
  const expectedPolicySha256 = environment[POSTGRES_OCI_TOOL_RUNTIME_POLICY_SHA256_ENV];
  const operationClass = environment[POSTGRES_OCI_TOOL_RUNTIME_OPERATION_ENV];
  const expectedRestoreCaSha256 =
    environment[POSTGRES_OCI_TOOL_RUNTIME_RESTORE_CA_SHA256_ENV];
  if (
    [profile, policyFile, expectedPolicySha256, operationClass, expectedRestoreCaSha256]
      .every((value) => value === undefined)
  ) {
    return null;
  }
  if (
    profile !== POSTGRES_OCI_TOOL_RUNTIME_PROFILE
    || typeof policyFile !== "string"
    || typeof expectedPolicySha256 !== "string"
    || !SHA256.test(expectedPolicySha256)
    || (operationClass !== "backup" && operationClass !== "restore")
    || (operationClass === "backup" && expectedRestoreCaSha256 !== undefined)
    || (operationClass === "restore" && (
      typeof expectedRestoreCaSha256 !== "string"
      || !SHA256.test(expectedRestoreCaSha256)
    ))
  ) reject();
  return {
    operationClass,
    policyFile,
    expectedPolicySha256,
    expectedRestoreCaSha256: expectedRestoreCaSha256 ?? null,
  };
}

export function postgresOciToolRuntimeRequested(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return runtimeConfiguration(environment) !== null;
}

function exactEnvironment(
  value: Readonly<Record<string, string>>,
  keys: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = { LC_ALL: "C" };
  for (const key of keys) {
    const candidate = value[key];
    if (
      typeof candidate !== "string"
      || candidate.length < 1
      || candidate.length > 32 * 1024
      || candidate.includes("\0")
    ) reject();
    result[key] = candidate;
  }
  return result;
}

function escapePgpass(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

function createRestorePgpass(environment: Record<string, string>): TrustedInputFile {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-oci-pgpass-"));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "pgpass");
  const descriptor = fs.openSync(
    file,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const line = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]
      .map((key) => escapePgpass(environment[key]!)).join(":") + "\n";
    const bytes = Buffer.from(line, "utf8");
    try {
      if (fs.writeSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) reject();
      fs.fsyncSync(descriptor);
    } finally {
      bytes.fill(0);
    }
    const held = identity(fs.fstatSync(descriptor, { bigint: true }));
    return { file, descriptor, identity: held, sha256: hashDescriptor(descriptor, held.size) };
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* cleanup handled below */ }
    try { fs.unlinkSync(file); } catch { /* cleanup handled below */ }
    try { fs.rmdirSync(directory); } catch { /* cleanup handled below */ }
    throw error;
  }
}

function removeGeneratedInput(input: TrustedInputFile): void {
  const directory = path.dirname(input.file);
  const failures: unknown[] = [];
  let unlinked = false;
  try {
    assertTrustedInput(input);
    fs.ftruncateSync(input.descriptor, 0);
    fs.fsyncSync(input.descriptor);
    const held = identity(fs.fstatSync(input.descriptor, { bigint: true }));
    const current = identity(fs.lstatSync(input.file, { bigint: true }));
    if (
      !sameStableFile(input.identity, held)
      || !sameIdentity(held, current)
      || held.size !== 0n
    ) reject();
    fs.unlinkSync(input.file);
    if (fs.existsSync(input.file)) reject();
    unlinked = true;
  } catch (error) { failures.push(error); }
  try { fs.closeSync(input.descriptor); } catch (error) { failures.push(error); }
  if (unlinked) {
    try { fs.rmdirSync(directory); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "postgres_oci_generated_input_cleanup_failed");
  }
}

async function exactHostAddress(host: string): Promise<string> {
  if (net.isIP(host) !== 0) return host;
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  const addresses = [...new Set(answers.map(({ address }) => address))];
  if (addresses.length !== 1 || net.isIP(addresses[0]!) === 0) reject();
  return addresses[0]!;
}

async function executionPlan(
  tool: ToolName,
  toolArguments: readonly string[],
  environment: Readonly<Record<string, string>>,
  policy: EgressPolicy,
  expectedRestoreCaSha256: string | null,
): Promise<{ readonly plan: OciExecutionPlan; readonly generated: TrustedInputFile | null }> {
  const runAsUid = process.getuid?.();
  const runAsGid = process.getgid?.();
  if (
    !Number.isSafeInteger(runAsUid)
    || runAsUid === undefined
    || runAsUid < 1
    || !Number.isSafeInteger(runAsGid)
    || runAsGid === undefined
    || runAsGid < 1
  ) reject();
  if (toolArguments.length === 1 && toolArguments[0] === "--version") {
    return {
      plan: {
        tool,
        toolArguments,
        toolEnvironment: Object.freeze({ LC_ALL: "C" }),
        mounts: Object.freeze([]),
        networkName: "none",
        forbiddenSecret: null,
        runAsUid,
        runAsGid,
      },
      generated: null,
    };
  }
  if (tool === "pg_restore" && toolArguments[0] === "--list") {
    return {
      plan: {
        tool,
        toolArguments,
        toolEnvironment: Object.freeze({ LC_ALL: "C" }),
        mounts: Object.freeze([]),
        networkName: "none",
        forbiddenSecret: null,
        runAsUid,
        runAsGid,
      },
      generated: null,
    };
  }
  if (policy.operationClass === "backup" && tool === "pg_dump") {
    const closed = exactEnvironment(environment, DUMP_ENVIRONMENT_KEYS);
    if (
      closed.PGHOST !== policy.host
      || closed.PGHOSTADDR !== policy.hostAddress
      || closed.PGPORT !== policy.port
    ) reject();
    const ca = openCurrentUidInput(closed.PGSSLROOTCERT!, 64 * 1024);
    let pgpass: TrustedInputFile | null = null;
    try {
      pgpass = openCurrentUidInput(closed.PGPASSFILE!, 64 * 1024);
      closed.PGSSLROOTCERT = "/run/pintpath/root-ca.pem";
      closed.PGPASSFILE = "/run/pintpath/pgpass";
      return {
        plan: {
          tool,
          toolArguments,
          toolEnvironment: Object.freeze(closed),
          mounts: Object.freeze([
            { source: `/proc/${process.pid}/fd/${ca.descriptor}`, destination: closed.PGSSLROOTCERT, input: ca },
            { source: `/proc/${process.pid}/fd/${pgpass.descriptor}`, destination: closed.PGPASSFILE, input: pgpass },
          ]),
          networkName: policy.networkName,
          forbiddenSecret: null,
          runAsUid,
          runAsGid,
        },
        generated: null,
      };
    } catch (error) {
      try { closeTrustedInput(ca); } catch { /* rejected below */ }
      if (pgpass) try { closeTrustedInput(pgpass); } catch { /* rejected below */ }
      throw error;
    }
  }
  if (policy.operationClass === "restore" && tool === "pg_restore") {
    const hasRootCa = typeof environment.PGSSLROOTCERT === "string";
    if (!hasRootCa || expectedRestoreCaSha256 === null) reject();
    const closed = exactEnvironment(
      environment,
      hasRootCa ? RESTORE_TLS_ENVIRONMENT_KEYS : RESTORE_ENVIRONMENT_KEYS,
    );
    const forbiddenSecret = closed.PGPASSWORD!;
    if (
      closed.PGHOST !== "localhost"
      || closed.PGHOSTADDR !== policy.hostAddress
      || closed.PGPORT !== policy.port
      || closed.PGSSLMODE !== "verify-full"
      || closed.PGSSLMINPROTOCOLVERSION !== "TLSv1.2"
      || closed.PGSSLSNI !== "1"
    ) reject();
    let ca: TrustedInputFile | null = null;
    if (hasRootCa) {
      ca = openCurrentUidInput(closed.PGSSLROOTCERT!, 64 * 1024);
      if (ca.sha256 !== expectedRestoreCaSha256) {
        try { closeTrustedInput(ca); } finally { ca = null; }
        reject();
      }
      closed.PGSSLROOTCERT = "/run/pintpath/root-ca.pem";
    }
    let generated: TrustedInputFile;
    try {
      generated = createRestorePgpass(closed);
    } catch (error) {
      if (ca) try { closeTrustedInput(ca); } catch { /* rejected by caller */ }
      throw error;
    }
    delete closed.PGPASSWORD;
    closed.PGPASSFILE = "/run/pintpath/pgpass";
    return {
      plan: {
        tool,
        toolArguments,
        toolEnvironment: Object.freeze(closed),
        mounts: Object.freeze([
          ...(ca ? [{
            source: `/proc/${process.pid}/fd/${ca.descriptor}`,
            destination: closed.PGSSLROOTCERT!,
            input: ca,
          }] : []),
          {
            source: `/proc/${process.pid}/fd/${generated.descriptor}`,
            destination: closed.PGPASSFILE,
            input: generated,
          },
        ]),
        networkName: policy.networkName,
        forbiddenSecret,
        runAsUid,
        runAsGid,
      },
      generated,
    };
  }
  reject();
}

function parseJsonResult(result: PostgresToolProcessResult): unknown {
  if (result.exitCode !== 0 || result.stderr !== "" || result.stdout.length > MAX_DOCKER_OUTPUT) reject();
  try { return JSON.parse(result.stdout); } catch { reject(); }
}

export function validatePostgresOciImageInspection(value: unknown): void {
  if (!Array.isArray(value) || value.length !== 1) reject();
  const image = exactRecord(value[0]);
  const rootFs = exactRecord(image.RootFS);
  if (
    image.Id !== IMAGE_CONFIG_DIGEST
    || image.Architecture !== "amd64"
    || image.Os !== "linux"
    || !Array.isArray(image.RepoDigests)
    || !image.RepoDigests.includes(POSTGRES_OCI_TOOL_RUNTIME_IMAGE)
    || !Array.isArray(rootFs.Layers)
    || JSON.stringify(rootFs.Layers)
      !== JSON.stringify(POSTGRES_TOOL_RUNTIME_CLOSURE_V4_LAYERS.map(({ diffId }) => diffId))
  ) reject();
}

function snapshotDockerSocket(): FileIdentity {
  const stat = identity(fs.lstatSync(DOCKER_SOCKET_FILE, { bigint: true }));
  const groups = process.getgroups?.() ?? [];
  if (
    (stat.mode & BigInt(fs.constants.S_IFMT)) !== BigInt(fs.constants.S_IFSOCK)
    || stat.uid !== 0n
    || stat.nlink !== 1n
    || (stat.mode & 0o0002n) !== 0n
    || !groups.includes(Number(stat.gid))
  ) reject();
  return stat;
}

export function validatePostgresOciDockerInfo(value: unknown, policy: EgressPolicy): void {
  const info = exactRecord(value);
  const swarm = exactRecord(info.Swarm);
  const containerdCommit = exactRecord(info.ContainerdCommit);
  const runcCommit = exactRecord(info.RuncCommit);
  if (
    info.ServerVersion !== POSTGRES_OCI_TOOL_RUNTIME_DOCKER_VERSION
    || info.OSType !== "linux"
    || info.Architecture !== "x86_64"
    || info.Driver !== "overlay2"
    || info.CgroupDriver !== "systemd"
    || info.CgroupVersion !== "2"
    || info.DefaultRuntime !== "runc"
    || info.LiveRestoreEnabled !== false
    || info.ExperimentalBuild !== false
    || typeof info.ID !== "string"
    || sha256Text(info.ID) !== policy.daemonIdSha256
    || typeof info.Name !== "string"
    || sha256Text(info.Name) !== policy.daemonNameSha256
    || typeof info.DockerRootDir !== "string"
    || sha256Text(info.DockerRootDir) !== policy.dockerRootDirSha256
    || typeof info.KernelVersion !== "string"
    || sha256Text(info.KernelVersion) !== policy.kernelVersionSha256
    || typeof info.OperatingSystem !== "string"
    || sha256Text(info.OperatingSystem) !== policy.operatingSystemSha256
    || typeof containerdCommit.ID !== "string"
    || sha256Text(containerdCommit.ID) !== policy.containerdCommitSha256
    || typeof runcCommit.ID !== "string"
    || sha256Text(runcCommit.ID) !== policy.runcCommitSha256
    || !Array.isArray(info.SecurityOptions)
    || !info.SecurityOptions.includes("name=seccomp,profile=builtin")
    || !info.SecurityOptions.includes("name=cgroupns")
    || sha256Text(`${canonicalJson([...info.SecurityOptions].sort())}\n`)
      !== policy.securityOptionsSha256
    || swarm.LocalNodeState !== "inactive"
    || !Array.isArray(info.Warnings)
    || info.Warnings.length !== 0
  ) reject();
}

export function validatePostgresOciNetworkPluginInspection(
  value: unknown,
  policy: EgressPolicy,
): void {
  if (!Array.isArray(value) || value.length !== 1) reject();
  const plugin = exactRecord(value[0]);
  const config = exactRecord(plugin.Config);
  const pluginInterface = exactRecord(config.Interface);
  if (
    plugin.Id !== policy.networkPluginId
    || plugin.Name !== NETWORK_DRIVER
    || plugin.Enabled !== true
    || !Array.isArray(pluginInterface.Types)
    || JSON.stringify(pluginInterface.Types) !== JSON.stringify(["docker.networkdriver/1.0"])
  ) reject();
}

export function validatePostgresOciNetworkInspection(
  value: unknown,
  policy: EgressPolicy,
  policySha256: string,
): void {
  if (!Array.isArray(value) || value.length !== 1) reject();
  const network = exactRecord(value[0]);
  const labels = exactRecord(network.Labels);
  const options = exactRecord(network.Options);
  const containers = exactRecord(network.Containers);
  exactKeys(options, [
    "allowed_host_address", "allowed_port", "deny_dns",
    "deny_instance_metadata", "policy_sha256",
  ]);
  if (
    network.Id !== policy.networkId
    || network.Name !== policy.networkName
    || network.Driver !== NETWORK_DRIVER
    || network.Scope !== "local"
    || network.Internal !== false
    || network.EnableIPv6 !== true
    || network.Attachable !== false
    || network.Ingress !== false
    || network.ConfigOnly !== false
    || labels[NETWORK_POLICY_LABEL] !== policySha256
    || options.allowed_host_address !== policy.hostAddress
    || options.allowed_port !== policy.port
    || options.deny_dns !== "true"
    || options.deny_instance_metadata !== "true"
    || options.policy_sha256 !== policySha256
    || Object.keys(containers).length !== 0
  ) reject();
}

export function buildPostgresOciCreateArguments(input: {
  readonly name: string;
  readonly label: string;
  readonly plan: OciExecutionPlan;
}): readonly string[] {
  if (!SAFE_CONTAINER_NAME.test(input.name) || !SHA256.test(input.label)) reject();
  const args = [
    "create", "--pull=never", `--name=${input.name}`, "--interactive",
    `--label=${CONTAINER_LABEL}=${input.label}`,
    "--platform=linux/amd64", `--network=${input.plan.networkName}`,
    "--read-only", `--user=${input.plan.runAsUid}:${input.plan.runAsGid}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true", "--pids-limit=64", "--memory=536870912",
    "--memory-swap=536870912", "--cpus=1", "--cgroupns=private", "--ipc=private",
    "--log-driver=none", "--restart=no", "--stop-timeout=1", `--workdir=${WORK_DIRECTORY}`,
    "--ulimit=nofile=1024:1024", "--ulimit=nproc=64:64",
    `--tmpfs=${WORK_DIRECTORY}:rw,noexec,nosuid,nodev,size=16777216,mode=0700,uid=${input.plan.runAsUid},gid=${input.plan.runAsGid}`,
    `--tmpfs=${IMAGE_DATA_DIRECTORY}:ro,noexec,nosuid,nodev,size=4096,mode=0555,uid=0,gid=0`,
  ];
  for (const mount of input.plan.mounts) {
    args.push(`--mount=type=bind,src=${mount.source},dst=${mount.destination},readonly`);
  }
  const command = ["-i"];
  for (const [key, value] of Object.entries(input.plan.toolEnvironment).sort(([a], [b]) => a.localeCompare(b))) {
    command.push(`${key}=${value}`);
  }
  command.push(TOOL_PATHS[input.plan.tool], ...input.plan.toolArguments);
  args.push("--entrypoint=/usr/bin/env", POSTGRES_OCI_TOOL_RUNTIME_IMAGE, ...command);
  if (input.plan.forbiddenSecret && args.some((argument) => argument.includes(input.plan.forbiddenSecret!))) {
    reject();
  }
  return Object.freeze(args);
}

export function validatePostgresOciContainerInspection(input: {
  readonly value: unknown;
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly plan: OciExecutionPlan;
  readonly createArguments: readonly string[];
}): void {
  if (!Array.isArray(input.value) || input.value.length !== 1) reject();
  const container = exactRecord(input.value[0]);
  const config = exactRecord(container.Config);
  const host = exactRecord(container.HostConfig);
  const state = exactRecord(container.State);
  const labels = exactRecord(config.Labels);
  const tmpfs = exactRecord(host.Tmpfs);
  const imageVolumes = exactRecord(config.Volumes);
  const restartPolicy = exactRecord(host.RestartPolicy);
  const logConfig = exactRecord(host.LogConfig);
  const portBindings = exactRecord(host.PortBindings);
  const networkSettings = exactRecord(container.NetworkSettings);
  const networks = exactRecord(networkSettings.Networks);
  const devices = host.Devices === null ? [] : host.Devices;
  const deviceRequests = host.DeviceRequests === null ? [] : host.DeviceRequests;
  const capAdd = host.CapAdd === null ? [] : host.CapAdd;
  const groupAdd = host.GroupAdd === null ? [] : host.GroupAdd;
  const links = host.Links === null ? [] : host.Links;
  const volumesFrom = host.VolumesFrom === null ? [] : host.VolumesFrom;
  const deviceRules = host.DeviceCgroupRules === null ? [] : host.DeviceCgroupRules;
  const securityOptions = host.SecurityOpt;
  const ulimits = host.Ulimits;
  const labelsExact = Object.keys(labels).length === 1;
  if (
    container.Id !== input.id
    || container.Name !== `/${input.name}`
    || container.Image !== IMAGE_CONFIG_DIGEST
    || container.Path !== "/usr/bin/env"
    || config.Image !== POSTGRES_OCI_TOOL_RUNTIME_IMAGE
    || config.User !== `${input.plan.runAsUid}:${input.plan.runAsGid}`
    || JSON.stringify(config.Entrypoint) !== JSON.stringify(["/usr/bin/env"])
    || config.WorkingDir !== WORK_DIRECTORY
    || config.AttachStdin !== true
    || config.AttachStdout !== true
    || config.AttachStderr !== true
    || config.OpenStdin !== true
    || config.StdinOnce !== false
    || config.Tty !== false
    || config.StopTimeout !== 1
    || !labelsExact
    || labels[CONTAINER_LABEL] !== input.label
    || host.ReadonlyRootfs !== true
    || host.Privileged !== false
    || host.AutoRemove !== false
    || host.NetworkMode !== input.plan.networkName
    || host.PidMode !== ""
    || host.IpcMode !== "private"
    || host.UTSMode !== ""
    || host.UsernsMode !== ""
    || host.CgroupnsMode !== "private"
    || host.Binds !== null
    || !Array.isArray(devices)
    || devices.length !== 0
    || !Array.isArray(deviceRequests)
    || deviceRequests.length !== 0
    || !Array.isArray(capAdd)
    || capAdd.length !== 0
    || !Array.isArray(groupAdd)
    || groupAdd.length !== 0
    || !Array.isArray(links)
    || links.length !== 0
    || !Array.isArray(volumesFrom)
    || volumesFrom.length !== 0
    || !Array.isArray(deviceRules)
    || deviceRules.length !== 0
    || JSON.stringify(host.CapDrop) !== JSON.stringify(["ALL"])
    || !Array.isArray(securityOptions)
    || JSON.stringify(securityOptions) !== JSON.stringify(["no-new-privileges=true"])
    || host.PidsLimit !== 64
    || host.Memory !== 536_870_912
    || host.MemorySwap !== 536_870_912
    || host.NanoCpus !== 1_000_000_000
    || host.PublishAllPorts !== false
    || Object.keys(portBindings).length !== 0
    || restartPolicy.Name !== "no"
    || restartPolicy.MaximumRetryCount !== 0
    || logConfig.Type !== "none"
    || Object.keys(exactRecord(logConfig.Config)).length !== 0
    || host.Runtime !== "runc"
    || !Array.isArray(host.MaskedPaths)
    || host.MaskedPaths.length < 1
    || !Array.isArray(host.ReadonlyPaths)
    || host.ReadonlyPaths.length < 1
    || !Array.isArray(ulimits)
    || canonicalJson([...ulimits].sort((left, right) => (
      String(exactRecord(left).Name).localeCompare(String(exactRecord(right).Name))
    ))) !== canonicalJson([
      { Hard: 1024, Name: "nofile", Soft: 1024 },
      { Hard: 64, Name: "nproc", Soft: 64 },
    ])
    || !Array.isArray(host.Dns)
    || host.Dns.length !== 0
    || !Array.isArray(host.DnsOptions)
    || host.DnsOptions.length !== 0
    || !Array.isArray(host.DnsSearch)
    || host.DnsSearch.length !== 0
    || (host.ExtraHosts !== null && (!Array.isArray(host.ExtraHosts) || host.ExtraHosts.length !== 0))
    || JSON.stringify(Object.keys(networks)) !== JSON.stringify([input.plan.networkName])
    || JSON.stringify(Object.keys(imageVolumes)) !== JSON.stringify([IMAGE_DATA_DIRECTORY])
    || Object.keys(exactRecord(imageVolumes[IMAGE_DATA_DIRECTORY])).length !== 0
    || JSON.stringify(Object.keys(tmpfs).sort())
      !== JSON.stringify([IMAGE_DATA_DIRECTORY, WORK_DIRECTORY].sort())
    || tmpfs[WORK_DIRECTORY]
      !== `rw,noexec,nosuid,nodev,size=16777216,mode=0700,uid=${input.plan.runAsUid},gid=${input.plan.runAsGid}`
    || tmpfs[IMAGE_DATA_DIRECTORY]
      !== "ro,noexec,nosuid,nodev,size=4096,mode=0555,uid=0,gid=0"
    || state.Status !== "created"
    || state.Running !== false
    || state.Pid !== 0
    || state.Dead !== false
    || state.OOMKilled !== false
    || state.Error !== ""
    || state.ExitCode !== 0
  ) reject();
  const expectedCmd = input.createArguments.slice(
    input.createArguments.indexOf(POSTGRES_OCI_TOOL_RUNTIME_IMAGE) + 1,
  );
  if (JSON.stringify(config.Cmd) !== JSON.stringify(expectedCmd)) reject();
  const mounts = Array.isArray(container.Mounts) ? container.Mounts.map(exactRecord) : reject();
  if (mounts.length !== input.plan.mounts.length) reject();
  for (const expected of input.plan.mounts) {
    const actual = mounts.find((mount) => mount.Destination === expected.destination);
    if (
      !actual
      || actual.Type !== "bind"
      || actual.Source !== expected.source
      || actual.RW !== false
    ) reject();
  }
  if (
    input.plan.forbiddenSecret
    && JSON.stringify(input.value).includes(input.plan.forbiddenSecret)
  ) reject();
}

function validateCompletedContainer(value: unknown, id: string, expectedExitCode: number): void {
  if (!Array.isArray(value) || value.length !== 1) reject();
  const container = exactRecord(value[0]);
  const state = exactRecord(container.State);
  if (
    container.Id !== id
    || state.Status !== "exited"
    || state.Running !== false
    || state.OOMKilled !== false
    || state.Error !== ""
    || state.ExitCode !== expectedExitCode
  ) reject();
}

export interface PostgresOciContainerLifecycleDependencies {
  readonly invoke: (args: readonly string[]) => Promise<PostgresToolProcessResult>;
  readonly start: (containerId: string) => Promise<PostgresToolProcessResult>;
  readonly validateCreated: (value: unknown, containerId: string) => void;
  readonly validateCompleted: (
    value: unknown,
    containerId: string,
    exitCode: number,
  ) => void;
  readonly validateCleanupIdentity: (value: unknown) => void;
}

function exactEmptyDockerResult(result: PostgresToolProcessResult): boolean {
  return result.exitCode === 0 && result.stdout === "" && result.stderr === "";
}

/**
 * One lifecycle for a name that was proved absent. The name and private label
 * remain available even when create/start responses are lost, so cleanup can
 * re-discover the container without trusting an ambiguous command result.
 */
export async function executePostgresOciContainerLifecycle(input: {
  readonly name: string;
  readonly label: string;
  readonly createArguments: readonly string[];
  readonly dependencies: PostgresOciContainerLifecycleDependencies;
}): Promise<PostgresToolProcessResult> {
  if (
    !SAFE_CONTAINER_NAME.test(input.name)
    || !SHA256.test(input.label)
    || input.createArguments[0] !== "create"
    || !input.createArguments.includes(`--name=${input.name}`)
    || !input.createArguments.includes(`--label=${CONTAINER_LABEL}=${input.label}`)
  ) reject();
  const discover = () => input.dependencies.invoke([
    "ps", "-aq", "--filter", `name=^/${input.name}$`,
  ]);
  let primaryFailure: unknown = null;
  try {
    if (!exactEmptyDockerResult(await discover())) reject();
    const created = await input.dependencies.invoke(input.createArguments);
    const containerId = created.stdout.trim();
    if (created.exitCode !== 0 || created.stderr !== "" || !SHA256.test(containerId)) reject();
    input.dependencies.validateCreated(
      parseJsonResult(await input.dependencies.invoke(["inspect", containerId])),
      containerId,
    );
    const result = await input.dependencies.start(containerId);
    input.dependencies.validateCompleted(
      parseJsonResult(await input.dependencies.invoke(["inspect", containerId])),
      containerId,
      result.exitCode,
    );
    return result;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    let cleanupFailure: unknown = null;
    try {
      const discovered = await discover();
      if (discovered.exitCode !== 0 || discovered.stderr !== "") reject();
      if (discovered.stdout !== "") {
        const ids = discovered.stdout.trim().split("\n");
        if (ids.length !== 1 || !SHA256.test(ids[0]!)) reject();
        input.dependencies.validateCleanupIdentity(
          parseJsonResult(await input.dependencies.invoke(["inspect", input.name])),
        );
        let removalFailure: unknown = null;
        try {
          await input.dependencies.invoke(["rm", "--force", "--volumes", input.name]);
        } catch (error) {
          // A lost CLI response is not authoritative. The exact final absence
          // proof below decides whether cleanup completed.
          removalFailure = error;
        }
        const absent = await discover();
        if (!exactEmptyDockerResult(absent)) throw removalFailure ?? reject();
      }
    } catch (error) {
      cleanupFailure = error;
    }
    if (cleanupFailure !== null) {
      throw new AggregateError(
        primaryFailure === null
          ? [cleanupFailure]
          : [primaryFailure, cleanupFailure],
        "postgres_oci_tool_runtime_cleanup_failed",
      );
    }
  }
}

async function runOciTool(
  configuration: RuntimeConfiguration,
  runProcess: PostgresToolAuthorityProcessRunner,
  tool: ToolName,
  toolArguments: readonly string[],
  environment: Readonly<Record<string, string>>,
  stdinFileDescriptor?: number,
  stdoutFileDescriptor?: number,
  timeoutMs = DOCKER_TIMEOUT,
  maxStdoutBytes = MAX_DOCKER_OUTPUT,
  maxStderrBytes = MAX_DOCKER_OUTPUT,
): Promise<PostgresToolProcessResult> {
  assertHardenedWorker();
  const docker = openDockerClient();
  const { policy, input: policyInput } = readRootOwnedPolicy(configuration);
  const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-docker-config-"));
  fs.chmodSync(dockerConfig, 0o700);
  const dockerEnvironment = Object.freeze({
    DOCKER_CONFIG: dockerConfig,
    DOCKER_HOST,
    HOME: dockerConfig,
    LC_ALL: "C",
    TMPDIR: dockerConfig,
  });
  const invoke = async (args: readonly string[], commandTimeout = DOCKER_TIMEOUT) => {
    assertTrustedInput(docker, POSTGRES_OCI_TOOL_RUNTIME_DOCKER_SHA256);
    const socket = snapshotDockerSocket();
    const result = await runProcess({
      operation: "version",
      command: `/proc/${process.pid}/fd/${docker.descriptor}`,
      args,
      env: dockerEnvironment,
      timeoutMs: commandTimeout,
      maxStdoutBytes: MAX_DOCKER_OUTPUT,
      maxStderrBytes: MAX_DOCKER_OUTPUT,
    } as PostgresToolAuthorityProcessInvocation);
    assertTrustedInput(docker, POSTGRES_OCI_TOOL_RUNTIME_DOCKER_SHA256);
    if (!sameIdentity(socket, snapshotDockerSocket())) reject();
    return result;
  };
  let plan: OciExecutionPlan | null = null;
  let generated: TrustedInputFile | null = null;
  let containerName: string | null = null;
  let label: string | null = null;
  let primaryFailure: unknown = null;
  try {
    const version = await invoke(["version", "--format", "{{.Client.Version}}"]);
    if (version.exitCode !== 0 || version.stderr !== "" || version.stdout.trim() !== POSTGRES_OCI_TOOL_RUNTIME_DOCKER_VERSION) {
      reject();
    }
    validatePostgresOciDockerInfo(
      parseJsonResult(await invoke(["info", "--format", "{{json .}}"])),
      policy,
    );
    validatePostgresOciImageInspection(parseJsonResult(await invoke([
      "image", "inspect", POSTGRES_OCI_TOOL_RUNTIME_IMAGE,
    ])));
    if (toolArguments[0] !== "--version" && toolArguments[0] !== "--list") {
      validatePostgresOciNetworkPluginInspection(parseJsonResult(await invoke([
        "plugin", "inspect", NETWORK_DRIVER,
      ])), policy);
      validatePostgresOciNetworkInspection(parseJsonResult(await invoke([
        "network", "inspect", policy.networkName,
      ])), policy, configuration.expectedPolicySha256);
    }
    ({ plan, generated } = await executionPlan(
      tool,
      toolArguments,
      environment,
      policy,
      configuration.expectedRestoreCaSha256,
    ));
    for (const mount of plan.mounts) assertTrustedInput(mount.input);
    containerName = `pintpath-pg-${tool === "pg_dump" ? "dump" : "restore"}-${crypto.randomBytes(12).toString("hex")}`;
    label = crypto.randomBytes(32).toString("hex");
    const createArguments = buildPostgresOciCreateArguments({ name: containerName, label, plan });
    const toolResult = await executePostgresOciContainerLifecycle({
      name: containerName,
      label,
      createArguments,
      dependencies: {
        invoke,
        start: async (containerId) => {
          for (const mount of plan!.mounts) assertTrustedInput(mount.input);
          assertTrustedInput(docker, POSTGRES_OCI_TOOL_RUNTIME_DOCKER_SHA256);
          const startSocket = snapshotDockerSocket();
          const result = await runProcess({
            operation: toolArguments[0] === "--version"
              ? "version"
              : toolArguments[0] === "--list"
                ? "list"
                : tool === "pg_dump" ? "dump" : "restore",
            command: `/proc/${process.pid}/fd/${docker.descriptor}`,
            args: ["start", "--attach", "--interactive", containerId],
            env: dockerEnvironment,
            timeoutMs,
            maxStdoutBytes,
            maxStderrBytes,
            stdinFileDescriptor,
            stdoutFileDescriptor,
          } as PostgresToolAuthorityProcessInvocation);
          assertTrustedInput(docker, POSTGRES_OCI_TOOL_RUNTIME_DOCKER_SHA256);
          if (!sameIdentity(startSocket, snapshotDockerSocket())) reject();
          for (const mount of plan!.mounts) assertTrustedInput(mount.input);
          return result;
        },
        validateCreated: (value, containerId) => validatePostgresOciContainerInspection({
          value,
          id: containerId,
          name: containerName!,
          label: label!,
          plan: plan!,
          createArguments,
        }),
        validateCompleted: validateCompletedContainer,
        validateCleanupIdentity: (value) => {
          if (!Array.isArray(value) || value.length !== 1) reject();
          const container = exactRecord(value[0]);
          const labels = exactRecord(exactRecord(container.Config).Labels);
          if (
            container.Name !== `/${containerName}`
            || typeof container.Id !== "string"
            || !SHA256.test(container.Id)
            || labels[CONTAINER_LABEL] !== label
          ) reject();
        },
      },
    });
    for (const mount of plan.mounts) assertTrustedInput(mount.input);
    return toolResult;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const failures: unknown[] = [];
    if (plan?.networkName !== "none") {
      try {
        validatePostgresOciNetworkPluginInspection(parseJsonResult(await invoke([
          "plugin", "inspect", NETWORK_DRIVER,
        ])), policy);
        validatePostgresOciNetworkInspection(parseJsonResult(await invoke([
          "network", "inspect", policy.networkName,
        ])), policy, configuration.expectedPolicySha256);
      } catch (error) { failures.push(error); }
    }
    if (plan) {
      for (const mount of plan.mounts) {
        if (mount.input === generated) continue;
        try { closeTrustedInput(mount.input); } catch (error) { failures.push(error); }
      }
    }
    if (generated) {
      try { removeGeneratedInput(generated); } catch (error) { failures.push(error); }
    }
    try {
      assertTrustedInput(policyInput, configuration.expectedPolicySha256);
      closeTrustedInput(policyInput);
    } catch (error) { failures.push(error); }
    try {
      assertTrustedInput(docker, POSTGRES_OCI_TOOL_RUNTIME_DOCKER_SHA256);
      closeTrustedInput(docker);
    } catch (error) { failures.push(error); }
    try { fs.rmdirSync(dockerConfig); } catch (error) { failures.push(error); }
    if (failures.length > 0) {
      throw new AggregateError(primaryFailure === null ? failures : [primaryFailure, ...failures],
        "postgres_oci_tool_runtime_cleanup_failed");
    }
  }
}

function executableOptions(
  options: OpenPostgresToolAuthorityOptions,
  purpose: "dump" | "list" | "restore",
): ToolName {
  const tool: ToolName = purpose === "dump" ? "pg_dump" : "pg_restore";
  if (
    options.purpose !== purpose
    || options.executableFile !== TOOL_PATHS[tool]
    || options.expectedSha256 !== TOOL_HASHES[tool]
  ) reject();
  return tool;
}

function snapshotArchive(descriptor: number, requireNonempty: boolean): FileIdentity {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 1) reject();
  const stat = identity(fs.fstatSync(descriptor, { bigint: true }));
  if (
    stat.uid !== BigInt(uid)
    || stat.nlink !== 1n
    || (stat.mode & 0o7777n) !== 0o600n
    || (requireNonempty ? stat.size < 1n : stat.size !== 0n)
  ) reject();
  return stat;
}

function exactDumpInput(input: PostgresDumpOperationInput): {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly descriptor: number;
} {
  if (
    !/^[a-fA-F0-9-]{1,128}$/.test(input.snapshotIdentifier)
    || !/^pintpath_logical_backup_d[1-9][0-9]{0,9}$/.test(input.roleName)
  ) reject();
  return {
    args: Object.freeze([
      "--format=custom", `--snapshot=${input.snapshotIdentifier}`,
      `--role=${input.roleName}`, "--no-owner", "--no-acl", "--enable-row-security",
      "--strict-names", "--lock-wait-timeout=30s", "--no-password",
      "--schema=pintpath_app", "--schema=pintpath_ops",
    ]),
    environment: input.environment,
    descriptor: input.archiveOutputFileDescriptor,
  };
}

export async function openPostgresOciToolAuthority(
  options: OpenPostgresToolAuthorityOptions,
  runProcess: PostgresToolAuthorityProcessRunner,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<PostgresDumpToolAuthority | PostgresListToolAuthority | PostgresRestoreToolAuthority> {
  const configuration = runtimeConfiguration(environment);
  if (!configuration) reject();
  if (options.purpose !== "dump" && options.purpose !== "list" && options.purpose !== "restore") {
    reject();
  }
  const purpose = options.purpose;
  const tool = executableOptions(options, purpose);
  let state: "version" | "operation" | "restore" | "spent" | "closed" = "version";
  let listedArchive: FileIdentity | null = null;
  let listedDescriptor: number | null = null;
  const assertOpen = () => { if (state === "closed") reject(); };
  const assertExact = async () => {
    assertOpen();
    await runOciTool(configuration, runProcess, tool, ["--version"], {}, undefined, undefined,
      15_000, 4_096, 4_096);
  };
  const version = async () => {
    if (state !== "version") reject();
    const result = await runOciTool(configuration, runProcess, tool, ["--version"], {}, undefined,
      undefined, 15_000, 4_096, 4_096);
    state = "operation";
    return result;
  };
  const close = async () => { if (state === "closed") return; state = "closed"; };
  if (purpose === "dump") {
    return Object.freeze({
      version,
      assertExact,
      close,
      dump: async (input: PostgresDumpOperationInput) => {
        if (state !== "operation") reject();
        const exact = exactDumpInput(input);
        const before = snapshotArchive(exact.descriptor, false);
        const result = await runOciTool(configuration, runProcess, tool, exact.args,
          exact.environment, undefined, exact.descriptor, 60 * 60_000, 512 * 1024, 512 * 1024);
        const after = snapshotArchive(exact.descriptor, true);
        if (!sameStableFile(before, after)) reject();
        state = "spent";
        return result;
      },
    });
  }
  const list = async (archiveInputFileDescriptor: number) => {
    if (state !== "operation") reject();
    const before = snapshotArchive(archiveInputFileDescriptor, true);
    const result = await runOciTool(configuration, runProcess, tool,
      ["--list", "--format=custom"], {}, archiveInputFileDescriptor, undefined,
      5 * 60_000, purpose === "list" ? 32 * 1024 * 1024 : 64 * 1024 * 1024,
      purpose === "list" ? 512 * 1024 : 1024 * 1024);
    const after = snapshotArchive(archiveInputFileDescriptor, true);
    if (!sameIdentity(before, after)) reject();
    state = purpose === "restore" ? "restore" : "spent";
    listedArchive = before;
    listedDescriptor = archiveInputFileDescriptor;
    return result;
  };
  if (purpose === "list") return Object.freeze({ version, list, assertExact, close });
  return Object.freeze({
    version,
    list,
    assertExact,
    close,
    restore: async (input: PostgresRestoreOperationInput) => {
      if (state !== "restore" || !listedArchive || listedDescriptor === input.archiveInputFileDescriptor) {
        reject();
      }
      const before = snapshotArchive(input.archiveInputFileDescriptor, true);
      if (!sameIdentity(listedArchive, before)) reject();
      const result = await runOciTool(configuration, runProcess, tool, [
        "--format=custom", "--dbname=", "--no-owner", "--no-acl", "--exit-on-error",
        "--single-transaction", "--no-password",
      ], input.environment, input.archiveInputFileDescriptor, undefined,
      2 * 60 * 60_000, 1024 * 1024, 1024 * 1024);
      const after = snapshotArchive(input.archiveInputFileDescriptor, true);
      if (!sameIdentity(before, after)) reject();
      state = "spent";
      return result;
    },
  });
}

export const POSTGRES_OCI_TOOL_RUNTIME_TOOL_HASHES = TOOL_HASHES;
