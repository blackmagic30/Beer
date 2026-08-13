import crypto from "node:crypto";
import dns from "node:dns/promises";
import nodeFs from "node:fs";
import type * as Fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { TextDecoder } from "node:util";

// The locked production worker revokes the public fs module after this graph
// has initialized. Keep exact original capabilities in a private facade, but
// retain live module dispatch outside that finalized worker so fault-injection
// tests can still exercise every cleanup path.
const FINALIZED_WORKER_MARKER =
  "__PINTPATH_LOCKED_SENSITIVE_FINALIZED_V1__" as const;
const ORIGINAL_FS_PROMISES = nodeFs.promises;
const ORIGINAL_FS_PROMISE_CAPABILITIES = Object.freeze({
  chmod: nodeFs.promises.chmod,
  lstat: nodeFs.promises.lstat,
  mkdtemp: nodeFs.promises.mkdtemp,
  open: nodeFs.promises.open,
  readdir: nodeFs.promises.readdir,
  realpath: nodeFs.promises.realpath,
  rmdir: nodeFs.promises.rmdir,
  unlink: nodeFs.promises.unlink,
});
type FsPromiseCapabilityName = keyof typeof ORIGINAL_FS_PROMISE_CAPABILITIES;

function finalizedLockedWorker(): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    FINALIZED_WORKER_MARKER,
  );
  return descriptor !== undefined
    && descriptor.configurable === false
    && descriptor.writable === false
    && "value" in descriptor
    && typeof descriptor.value === "object"
    && descriptor.value !== null
    && Object.isFrozen(descriptor.value)
    && (descriptor.value as { readonly version?: unknown }).version === 1;
}

function callFsPromiseCapability(
  name: FsPromiseCapabilityName,
  args: readonly unknown[],
): unknown {
  const capability = finalizedLockedWorker()
    ? ORIGINAL_FS_PROMISE_CAPABILITIES[name]
    : ORIGINAL_FS_PROMISES[name];
  return Reflect.apply(capability, ORIGINAL_FS_PROMISES, args);
}

const fs = Object.freeze({
  constants: nodeFs.constants,
  promises: Object.freeze({
    chmod: (...args: unknown[]) => callFsPromiseCapability("chmod", args),
    lstat: (...args: unknown[]) => callFsPromiseCapability("lstat", args),
    mkdtemp: (...args: unknown[]) => callFsPromiseCapability("mkdtemp", args),
    open: (...args: unknown[]) => callFsPromiseCapability("open", args),
    readdir: (...args: unknown[]) => callFsPromiseCapability("readdir", args),
    realpath: (...args: unknown[]) => callFsPromiseCapability("realpath", args),
    rmdir: (...args: unknown[]) => callFsPromiseCapability("rmdir", args),
    unlink: (...args: unknown[]) => callFsPromiseCapability("unlink", args),
  }) as unknown as Pick<
    typeof nodeFs.promises,
    FsPromiseCapabilityName
  >,
});

export const POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE =
  "railway-stock-localhost-ca-v1" as const;
export const POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_DNS_TIMEOUT_MS = 15_000 as const;
export const POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_MINIMUM_REMAINING_VALIDITY_MS =
  86_400_000 as const;

const LOCALHOST = "localhost" as const;
const POSTGRES_PORT = 5_432 as const;
const TLS_MINIMUM_VERSION = "TLSv1.2" as const;
const ROOT_CA_FILE_NAME = "railway-root-ca.pem";
const TEMPORARY_DIRECTORY_PREFIX = "pintpath-railway-stock-localhost-ca-";
const MAX_ROOT_CA_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RAILWAY_PRIVATE_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.railway\.internal$/;

export type PostgresRailwayStockLocalhostCaFailureCode =
  | "invalid_arguments"
  | "unsafe_root_ca_file"
  | "root_ca_pin_mismatch"
  | "root_ca_certificate_invalid"
  | "railway_private_dns_invalid"
  | "unsafe_temporary_authority"
  | "transport_drift"
  | "cleanup_failed";

export class PostgresRailwayStockLocalhostCaError extends Error {
  readonly code: PostgresRailwayStockLocalhostCaFailureCode;

  constructor(code: PostgresRailwayStockLocalhostCaFailureCode) {
    super(code);
    this.name = "PostgresRailwayStockLocalhostCaError";
    this.code = code;
  }
}

export function checkPostgresRailwayStockLocalhostServerIdentity(
  hostname: string,
  certificate: tls.PeerCertificate,
): Error | undefined {
  if (hostname !== LOCALHOST) {
    return new Error("railway_stock_localhost_server_identity_required");
  }
  return tls.checkServerIdentity(LOCALHOST, certificate);
}

export interface PostgresRailwayStockLocalhostCaSourceUrlAuthority {
  readonly hostname: string;
  readonly port: number;
}

export interface OpenPostgresRailwayStockLocalhostCaTransportOptions {
  readonly profile: typeof POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE;
  readonly rootCaFile: string;
  readonly expectedRootCaDerSha256: string;
  readonly expectedUid: number;
  readonly sourceUrlAuthority: PostgresRailwayStockLocalhostCaSourceUrlAuthority;
}

export interface PostgresRailwayStockLocalhostCaDependencies {
  readonly getUid: () => number | null;
  readonly getEuid: () => number | null;
  readonly now: () => Date;
  readonly temporaryRoot: () => string;
  readonly resolve6: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly string[]>;
}

export interface PostgresRailwayStockLocalhostCaNodeConnection {
  readonly host: string;
  readonly port: typeof POSTGRES_PORT;
  readonly ssl: {
    readonly ca: string;
    readonly servername: typeof LOCALHOST;
    readonly rejectUnauthorized: true;
    readonly minVersion: typeof TLS_MINIMUM_VERSION;
    readonly checkServerIdentity: (
      hostname: string,
      certificate: tls.PeerCertificate,
    ) => Error | undefined;
  };
}

export interface PostgresRailwayStockLocalhostCaLibpqEnvironment {
  readonly PGHOST: typeof LOCALHOST;
  readonly PGHOSTADDR: string;
  readonly PGPORT: "5432";
  readonly PGSSLMODE: "verify-full";
  readonly PGSSLROOTCERT: string;
  readonly PGSSLMINPROTOCOLVERSION: typeof TLS_MINIMUM_VERSION;
  readonly PGSSLSNI: "1";
}

export interface PostgresRailwayStockLocalhostCaTransport {
  readonly profile: typeof POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE;
  readonly rootCaDerSha256: string;
  readonly sourceUrlAuthority: Readonly<PostgresRailwayStockLocalhostCaSourceUrlAuthority>;
  readonly resolvedAddress: string;
  readonly temporaryDirectory: string;
  readonly passwordFileDirectory: string;
  readonly passwordFileHost: typeof LOCALHOST;
  readonly nodeConnection: Readonly<PostgresRailwayStockLocalhostCaNodeConnection>;
  readonly libpqEnvironment: Readonly<PostgresRailwayStockLocalhostCaLibpqEnvironment>;
  assertExact(): Promise<void>;
  close(): Promise<void>;
}

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

interface CreatedFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
}

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
}

interface HeldRootCaFile {
  readonly path: string;
  readonly handle: Fs.promises.FileHandle;
  readonly identity: FileIdentity;
  readonly pemSha256: string;
  readonly pem: string;
}

interface OwnedTransportResources {
  source: HeldRootCaFile | null;
  directoryPath: string | null;
  directoryIdentity: DirectoryIdentity | null;
  directoryHandle: Fs.promises.FileHandle | null;
  rootCaPath: string | null;
  rootCaCreatedIdentity: CreatedFileIdentity | null;
  rootCaIdentity: FileIdentity | null;
  rootCaHandle: Fs.promises.FileHandle | null;
}

interface ValidatedRootCa {
  readonly derSha256: string;
}

const DEFAULT_DEPENDENCIES: PostgresRailwayStockLocalhostCaDependencies = {
  getUid: () => process.getuid?.() ?? null,
  getEuid: () => process.geteuid?.() ?? null,
  now: () => new Date(),
  temporaryRoot: () => os.tmpdir(),
  resolve6: async (hostname, signal) => {
    const resolver = new dns.Resolver();
    const cancel = (): void => {
      try {
        resolver.cancel();
      } catch {
        // The fixed caller deadline still contains resolver cancellation errors.
      }
    };
    if (signal.aborted) {
      cancel();
      throw new Error("railway_private_dns_cancelled");
    }
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await resolver.resolve6(hostname);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  },
};

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactAbsolutePath(value: string): string {
  if (
    !value
    || value.includes("\0")
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
  ) throw new PostgresRailwayStockLocalhostCaError("invalid_arguments");
  return value;
}

function validateOptions(options: OpenPostgresRailwayStockLocalhostCaTransportOptions): void {
  if (
    !isRecord(options)
    || options.profile !== POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE
    || typeof options.rootCaFile !== "string"
    || typeof options.expectedRootCaDerSha256 !== "string"
    || !SHA256_PATTERN.test(options.expectedRootCaDerSha256)
    || !Number.isSafeInteger(options.expectedUid)
    || options.expectedUid < 0
  ) throw new PostgresRailwayStockLocalhostCaError("invalid_arguments");
  const authority = options.sourceUrlAuthority;
  if (
    !isRecord(authority)
    || !exactKeys(authority, ["hostname", "port"])
    || typeof authority.hostname !== "string"
    || !RAILWAY_PRIVATE_HOST_PATTERN.test(authority.hostname)
    || authority.hostname !== authority.hostname.toLowerCase()
    || authority.port !== POSTGRES_PORT
  ) throw new PostgresRailwayStockLocalhostCaError("invalid_arguments");
  exactAbsolutePath(options.rootCaFile);
}

function fileIdentity(stat: Fs.BigIntStats): FileIdentity {
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

function createdFileIdentity(stat: Fs.BigIntStats): CreatedFileIdentity {
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}

function directoryIdentity(stat: Fs.BigIntStats): DirectoryIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode,
  };
}

function sameCreatedFile(
  expected: CreatedFileIdentity,
  actual: Pick<Fs.BigIntStats, "dev" | "ino" | "uid">,
): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.uid === actual.uid;
}

function sameFileIdentity(expected: FileIdentity, actual: FileIdentity): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.uid === actual.uid
    && expected.gid === actual.gid
    && expected.mode === actual.mode
    && expected.nlink === actual.nlink
    && expected.size === actual.size
    && expected.mtimeNs === actual.mtimeNs
    && expected.ctimeNs === actual.ctimeNs;
}

function sameDirectoryIdentity(expected: DirectoryIdentity, actual: DirectoryIdentity): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.uid === actual.uid
    && expected.gid === actual.gid
    && expected.mode === actual.mode;
}

function sameDirectoryObject(expected: DirectoryIdentity, actual: DirectoryIdentity): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.uid === actual.uid;
}

function assertPrivateRootCaStat(
  stat: Fs.BigIntStats,
  expectedUid: number,
  maximumBytes = MAX_ROOT_CA_BYTES,
  allowEmpty = false,
): void {
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.uid !== BigInt(expectedUid)
    || stat.nlink !== 1n
    || Number(stat.mode & 0o7777n) !== 0o600
    || stat.size > BigInt(maximumBytes)
    || (!allowEmpty && stat.size < 1n)
  ) throw new PostgresRailwayStockLocalhostCaError("unsafe_root_ca_file");
}

function assertOwnedTemporaryDirectory(stat: Fs.BigIntStats, expectedUid: number): void {
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || stat.uid !== BigInt(expectedUid)
    || stat.nlink < 1n
    || Number(stat.mode & 0o7777n) !== 0o700
  ) throw new PostgresRailwayStockLocalhostCaError("unsafe_temporary_authority");
}

async function closeHandleExact(handle: Fs.promises.FileHandle): Promise<boolean> {
  try {
    await handle.close();
    return true;
  } catch {
    await handle.close().catch(() => undefined);
    return false;
  }
}

async function readExactFile(
  handle: Fs.promises.FileHandle,
  size: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        throw new PostgresRailwayStockLocalhostCaError("unsafe_root_ca_file");
      }
      offset += read.bytesRead;
    }
    const eof = Buffer.alloc(1);
    try {
      const extra = await handle.read(eof, 0, 1, bytes.length);
      if (extra.bytesRead !== 0) {
        throw new PostgresRailwayStockLocalhostCaError("unsafe_root_ca_file");
      }
    } finally {
      eof.fill(0);
    }
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

async function openStableRootCaFile(
  filePathInput: string,
  expectedUid: number,
): Promise<HeldRootCaFile> {
  const filePath = exactAbsolutePath(filePathInput);
  let handle: Fs.promises.FileHandle | null = null;
  let bytes: Buffer | null = null;
  try {
    if (await fs.promises.realpath(filePath) !== filePath) {
      throw new PostgresRailwayStockLocalhostCaError("unsafe_root_ca_file");
    }
    const before = await fs.promises.lstat(filePath, { bigint: true });
    assertPrivateRootCaStat(before, expectedUid);
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY
        | (fs.constants.O_NOFOLLOW ?? 0)
        | (fs.constants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    assertPrivateRootCaStat(opened, expectedUid);
    const expectedIdentity = fileIdentity(before);
    if (!sameFileIdentity(expectedIdentity, fileIdentity(opened))) {
      throw new PostgresRailwayStockLocalhostCaError("unsafe_root_ca_file");
    }
    bytes = await readExactFile(handle, Number(opened.size));
    const afterDescriptor = await handle.stat({ bigint: true });
    const afterPath = await fs.promises.lstat(filePath, { bigint: true });
    assertPrivateRootCaStat(afterDescriptor, expectedUid);
    assertPrivateRootCaStat(afterPath, expectedUid);
    if (
      !sameFileIdentity(expectedIdentity, fileIdentity(afterDescriptor))
      || !sameFileIdentity(expectedIdentity, fileIdentity(afterPath))
      || await fs.promises.realpath(filePath) !== filePath
    ) throw new PostgresRailwayStockLocalhostCaError("unsafe_root_ca_file");
    let pem: string;
    try {
      pem = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new PostgresRailwayStockLocalhostCaError("unsafe_root_ca_file");
    }
    const result: HeldRootCaFile = {
      path: filePath,
      handle,
      identity: expectedIdentity,
      pemSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      pem,
    };
    handle = null;
    return result;
  } catch (error) {
    if (handle && !await closeHandleExact(handle)) {
      throw new PostgresRailwayStockLocalhostCaError("cleanup_failed");
    }
    if (error instanceof PostgresRailwayStockLocalhostCaError) throw error;
    throw new PostgresRailwayStockLocalhostCaError("unsafe_root_ca_file");
  } finally {
    bytes?.fill(0);
  }
}

function singlePemCertificate(pem: string): boolean {
  if (!pem || pem.includes("\0")) return false;
  const begin = "-----BEGIN CERTIFICATE-----";
  const end = "-----END CERTIFICATE-----";
  const firstBegin = pem.indexOf(begin);
  const firstEnd = pem.indexOf(end, firstBegin + begin.length);
  if (
    firstBegin < 0
    || firstEnd < 0
    || pem.indexOf(begin, firstBegin + begin.length) !== -1
    || pem.indexOf(end, firstEnd + end.length) !== -1
    || pem.slice(0, firstBegin).trim() !== ""
    || pem.slice(firstEnd + end.length).trim() !== ""
  ) return false;
  const body = pem.slice(firstBegin + begin.length, firstEnd).replace(/\s/g, "");
  return body.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(body);
}

function validateRootCa(
  pem: string,
  expectedDerSha256: string,
  now: Date,
): ValidatedRootCa {
  let certificate: crypto.X509Certificate;
  try {
    if (!singlePemCertificate(pem)) {
      throw new Error("not_one_pem_certificate");
    }
    certificate = new crypto.X509Certificate(pem);
  } catch {
    throw new PostgresRailwayStockLocalhostCaError("root_ca_certificate_invalid");
  }
  const derSha256 = crypto.createHash("sha256").update(certificate.raw).digest("hex");
  if (derSha256 !== expectedDerSha256) {
    throw new PostgresRailwayStockLocalhostCaError("root_ca_pin_mismatch");
  }
  const nowMs = now.getTime();
  const validFromMs = Date.parse(certificate.validFrom);
  const validToMs = Date.parse(certificate.validTo);
  let selfSigned = false;
  try {
    selfSigned = certificate.subject === certificate.issuer
      && certificate.checkIssued(certificate)
      && certificate.verify(certificate.publicKey);
  } catch {
    selfSigned = false;
  }
  if (
    !certificate.ca
    || !selfSigned
    || !Number.isFinite(nowMs)
    || !Number.isFinite(validFromMs)
    || !Number.isFinite(validToMs)
    || nowMs < validFromMs
    || nowMs >= validToMs
    || validToMs - nowMs
      < POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_MINIMUM_REMAINING_VALIDITY_MS
  ) throw new PostgresRailwayStockLocalhostCaError("root_ca_certificate_invalid");
  return { derSha256 };
}

function canonicalFd12Address(value: string): string | null {
  if (
    !value
    || value !== value.trim()
    || value.includes("%")
    || net.isIPv6(value) !== true
  ) return null;
  try {
    const parsed = new URL(`http://[${value}]/`);
    const bracketed = parsed.hostname.toLowerCase();
    if (!bracketed.startsWith("[") || !bracketed.endsWith("]")) return null;
    const normalized = bracketed.slice(1, -1);
    return normalized.split(":", 1)[0] === "fd12" ? normalized : null;
  } catch {
    return null;
  }
}

async function resolveExactRailwayPrivateAddress(
  hostname: string,
  dependencies: PostgresRailwayStockLocalhostCaDependencies,
): Promise<string> {
  const controller = new AbortController();
  let deadline: NodeJS.Timeout | null = null;
  try {
    const resolution = Promise.resolve().then(
      () => dependencies.resolve6(hostname, controller.signal),
    );
    const values = await new Promise<readonly string[]>((resolve, reject) => {
      let settled = false;
      deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          controller.abort();
        } catch {
          // The fixed timeout result remains authoritative.
        }
        reject(new Error("railway_private_dns_timeout"));
      }, POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_DNS_TIMEOUT_MS);
      deadline.ref();
      resolution.then(
        (answers) => {
          if (settled) return;
          settled = true;
          resolve(answers);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
    const address = Array.isArray(values)
      && values.length === 1
      && typeof values[0] === "string"
      ? canonicalFd12Address(values[0])
      : null;
    if (!address) throw new Error("not_one_fd12_address");
    return address;
  } catch {
    throw new PostgresRailwayStockLocalhostCaError("railway_private_dns_invalid");
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

async function writeAll(
  handle: Fs.promises.FileHandle,
  bytes: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const write = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (write.bytesWritten === 0) {
      throw new PostgresRailwayStockLocalhostCaError("unsafe_temporary_authority");
    }
    offset += write.bytesWritten;
  }
}

async function createOwnedRootCaCopy(
  resources: OwnedTransportResources,
  pem: string,
  expectedUid: number,
  dependencies: PostgresRailwayStockLocalhostCaDependencies,
): Promise<void> {
  let pemBytes: Buffer | null = null;
  try {
    const configuredRoot = dependencies.temporaryRoot();
    if (
      typeof configuredRoot !== "string"
      || !path.isAbsolute(configuredRoot)
      || configuredRoot.includes("\0")
    ) throw new PostgresRailwayStockLocalhostCaError("unsafe_temporary_authority");
    const canonicalRoot = await fs.promises.realpath(configuredRoot);
    const rootStat = await fs.promises.lstat(canonicalRoot, { bigint: true });
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new PostgresRailwayStockLocalhostCaError("unsafe_temporary_authority");
    }
    resources.directoryPath = await fs.promises.mkdtemp(
      path.join(canonicalRoot, TEMPORARY_DIRECTORY_PREFIX),
    );
    if (
      path.dirname(resources.directoryPath) !== canonicalRoot
      || await fs.promises.realpath(resources.directoryPath) !== resources.directoryPath
    ) throw new PostgresRailwayStockLocalhostCaError("unsafe_temporary_authority");
    await fs.promises.chmod(resources.directoryPath, 0o700);
    const createdDirectory = await fs.promises.lstat(resources.directoryPath, { bigint: true });
    assertOwnedTemporaryDirectory(createdDirectory, expectedUid);
    resources.directoryIdentity = directoryIdentity(createdDirectory);
    resources.directoryHandle = await fs.promises.open(
      resources.directoryPath,
      fs.constants.O_RDONLY
        | (fs.constants.O_DIRECTORY ?? 0)
        | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const openedDirectory = await resources.directoryHandle.stat({ bigint: true });
    assertOwnedTemporaryDirectory(openedDirectory, expectedUid);
    if (!sameDirectoryIdentity(resources.directoryIdentity, directoryIdentity(openedDirectory))) {
      throw new PostgresRailwayStockLocalhostCaError("unsafe_temporary_authority");
    }

    resources.rootCaPath = path.join(resources.directoryPath, ROOT_CA_FILE_NAME);
    resources.rootCaHandle = await fs.promises.open(
      resources.rootCaPath,
      fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_RDWR
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const createdFile = await resources.rootCaHandle.stat({ bigint: true });
    assertPrivateRootCaStat(createdFile, expectedUid, MAX_ROOT_CA_BYTES, true);
    resources.rootCaCreatedIdentity = createdFileIdentity(createdFile);
    pemBytes = Buffer.from(pem, "utf8");
    if (pemBytes.length < 1 || pemBytes.length > MAX_ROOT_CA_BYTES) {
      throw new PostgresRailwayStockLocalhostCaError("unsafe_temporary_authority");
    }
    await writeAll(resources.rootCaHandle, pemBytes);
    await resources.rootCaHandle.chmod(0o600);
    await resources.rootCaHandle.sync();
    const finalDescriptor = await resources.rootCaHandle.stat({ bigint: true });
    const finalPath = await fs.promises.lstat(resources.rootCaPath, { bigint: true });
    assertPrivateRootCaStat(finalDescriptor, expectedUid);
    assertPrivateRootCaStat(finalPath, expectedUid);
    const finalIdentity = fileIdentity(finalDescriptor);
    if (
      finalDescriptor.size !== BigInt(pemBytes.length)
      || !sameCreatedFile(resources.rootCaCreatedIdentity, finalDescriptor)
      || !sameFileIdentity(finalIdentity, fileIdentity(finalPath))
      || await fs.promises.realpath(resources.rootCaPath) !== resources.rootCaPath
    ) throw new PostgresRailwayStockLocalhostCaError("unsafe_temporary_authority");
    resources.rootCaIdentity = finalIdentity;
    await resources.directoryHandle.sync();
  } catch (error) {
    throw new PostgresRailwayStockLocalhostCaError("unsafe_temporary_authority");
  } finally {
    pemBytes?.fill(0);
  }
}

async function heldFileIsExact(
  file: HeldRootCaFile,
  expectedUid: number,
  expectedDerSha256: string,
  now: Date,
): Promise<boolean> {
  let bytes: Buffer | null = null;
  try {
    const descriptor = await file.handle.stat({ bigint: true });
    const current = await fs.promises.lstat(file.path, { bigint: true });
    assertPrivateRootCaStat(descriptor, expectedUid);
    assertPrivateRootCaStat(current, expectedUid);
    if (
      !sameFileIdentity(file.identity, fileIdentity(descriptor))
      || !sameFileIdentity(file.identity, fileIdentity(current))
      || await fs.promises.realpath(file.path) !== file.path
    ) return false;
    bytes = await readExactFile(file.handle, Number(descriptor.size));
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== file.pemSha256) return false;
    const pem = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    validateRootCa(pem, expectedDerSha256, now);
    return true;
  } catch {
    return false;
  } finally {
    bytes?.fill(0);
  }
}

async function ownedDirectoryIsExact(
  resources: OwnedTransportResources,
  expectedUid: number,
): Promise<boolean> {
  if (!resources.directoryPath || !resources.directoryIdentity || !resources.directoryHandle) {
    return false;
  }
  try {
    const descriptor = await resources.directoryHandle.stat({ bigint: true });
    const current = await fs.promises.lstat(resources.directoryPath, { bigint: true });
    assertOwnedTemporaryDirectory(descriptor, expectedUid);
    assertOwnedTemporaryDirectory(current, expectedUid);
    return sameDirectoryIdentity(resources.directoryIdentity, directoryIdentity(descriptor))
      && sameDirectoryIdentity(resources.directoryIdentity, directoryIdentity(current))
      && await fs.promises.realpath(resources.directoryPath) === resources.directoryPath;
  } catch {
    return false;
  }
}

async function ownedRootCaIsExact(
  resources: OwnedTransportResources,
  expectedUid: number,
  pemSha256: string,
): Promise<boolean> {
  if (
    !resources.rootCaPath
    || !resources.rootCaIdentity
    || !resources.rootCaHandle
  ) return false;
  let bytes: Buffer | null = null;
  try {
    const descriptor = await resources.rootCaHandle.stat({ bigint: true });
    const current = await fs.promises.lstat(resources.rootCaPath, { bigint: true });
    assertPrivateRootCaStat(descriptor, expectedUid);
    assertPrivateRootCaStat(current, expectedUid);
    if (
      !sameFileIdentity(resources.rootCaIdentity, fileIdentity(descriptor))
      || !sameFileIdentity(resources.rootCaIdentity, fileIdentity(current))
      || await fs.promises.realpath(resources.rootCaPath) !== resources.rootCaPath
    ) return false;
    bytes = await readExactFile(resources.rootCaHandle, Number(descriptor.size));
    return crypto.createHash("sha256").update(bytes).digest("hex") === pemSha256;
  } catch {
    return false;
  } finally {
    bytes?.fill(0);
  }
}

async function unlinkOwnedRootCa(resources: OwnedTransportResources, expectedUid: number): Promise<boolean> {
  const handle = resources.rootCaHandle;
  const filePath = resources.rootCaPath;
  if (!handle) return false;
  let exact = true;
  try {
    if (!filePath) throw new Error("owned_root_ca_path_unavailable");
    const descriptor = await handle.stat({ bigint: true });
    let expected = resources.rootCaIdentity ?? resources.rootCaCreatedIdentity;
    if (
      !expected
      && descriptor.isFile()
      && descriptor.uid === BigInt(expectedUid)
      && descriptor.nlink >= 1n
    ) expected = createdFileIdentity(descriptor);
    const current = await fs.promises.lstat(filePath, { bigint: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (
      !current
      || current.isSymbolicLink()
      || !current.isFile()
      || !descriptor.isFile()
      || descriptor.uid !== BigInt(expectedUid)
      || current.uid !== BigInt(expectedUid)
      || !expected
      || !sameCreatedFile(expected, descriptor)
      || !sameCreatedFile(expected, current)
    ) {
      exact = false;
    } else {
      if (
        descriptor.nlink !== 1n
        || current.nlink !== descriptor.nlink
        || Number(descriptor.mode & 0o7777n) !== 0o600
        || Number(current.mode & 0o7777n) !== 0o600
        || (resources.rootCaIdentity !== null
          && (!sameFileIdentity(resources.rootCaIdentity, fileIdentity(descriptor))
            || !sameFileIdentity(resources.rootCaIdentity, fileIdentity(current))))
      ) exact = false;
      const beforeLinks = descriptor.nlink;
      await fs.promises.unlink(filePath);
      const after = await handle.stat({ bigint: true });
      if (
        after.dev !== descriptor.dev
        || after.ino !== descriptor.ino
        || after.nlink !== beforeLinks - 1n
      ) exact = false;
      const remaining = await fs.promises.lstat(filePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (remaining) exact = false;
    }
  } catch {
    exact = false;
  } finally {
    if (!await closeHandleExact(handle)) exact = false;
    resources.rootCaHandle = null;
  }
  return exact;
}

async function removeOwnedDirectory(
  resources: OwnedTransportResources,
  expectedUid: number,
): Promise<boolean> {
  const directoryPath = resources.directoryPath;
  const identity = resources.directoryIdentity;
  const handle = resources.directoryHandle;
  if (!directoryPath || !identity) return false;
  let exact = true;
  try {
    const current = await fs.promises.lstat(directoryPath, { bigint: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    const descriptor = handle ? await handle.stat({ bigint: true }) : null;
    if (
      !current
      || !descriptor
      || current.isSymbolicLink()
      || !current.isDirectory()
      || !descriptor.isDirectory()
      || current.uid !== BigInt(expectedUid)
      || descriptor.uid !== BigInt(expectedUid)
      || !sameDirectoryObject(identity, directoryIdentity(current))
      || !sameDirectoryObject(identity, directoryIdentity(descriptor))
    ) {
      exact = false;
    } else {
      if (
        !sameDirectoryIdentity(identity, directoryIdentity(current))
        || !sameDirectoryIdentity(identity, directoryIdentity(descriptor))
      ) exact = false;
      if ((await fs.promises.readdir(directoryPath)).length !== 0) {
        exact = false;
      } else {
        await fs.promises.rmdir(directoryPath);
        const remaining = await fs.promises.lstat(directoryPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (remaining) exact = false;
      }
    }
  } catch {
    exact = false;
  }
  if (handle && !await closeHandleExact(handle)) exact = false;
  resources.directoryHandle = null;
  return exact;
}

async function cleanupResources(
  resources: OwnedTransportResources,
  expectedUid: number,
): Promise<boolean> {
  let exact = true;
  if (resources.rootCaHandle) {
    if (!await unlinkOwnedRootCa(resources, expectedUid)) exact = false;
  } else if (resources.rootCaPath) {
    const present = await fs.promises.lstat(resources.rootCaPath).then(
      () => true,
      (error: unknown) => (error as NodeJS.ErrnoException).code !== "ENOENT",
    );
    if (present) exact = false;
  }
  if (resources.directoryPath) {
    if (!await removeOwnedDirectory(resources, expectedUid)) exact = false;
  } else if (resources.directoryHandle) {
    if (!await closeHandleExact(resources.directoryHandle)) exact = false;
    resources.directoryHandle = null;
  }
  if (resources.source) {
    if (!await closeHandleExact(resources.source.handle)) exact = false;
    resources.source = null;
  }
  return exact;
}

class OpenRailwayStockLocalhostCaTransport
implements PostgresRailwayStockLocalhostCaTransport {
  readonly profile = POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE;
  readonly passwordFileHost = LOCALHOST;
  readonly passwordFileDirectory: string;
  readonly temporaryDirectory: string;
  readonly rootCaDerSha256: string;
  readonly sourceUrlAuthority: Readonly<PostgresRailwayStockLocalhostCaSourceUrlAuthority>;
  readonly resolvedAddress: string;
  readonly nodeConnection: Readonly<PostgresRailwayStockLocalhostCaNodeConnection>;
  readonly libpqEnvironment: Readonly<PostgresRailwayStockLocalhostCaLibpqEnvironment>;

  private state: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly resources: OwnedTransportResources,
    private readonly expectedUid: number,
    private readonly expectedRootCaDerSha256: string,
    sourceUrlAuthority: PostgresRailwayStockLocalhostCaSourceUrlAuthority,
    resolvedAddress: string,
    rootCaDerSha256: string,
    private readonly dependencies: PostgresRailwayStockLocalhostCaDependencies,
  ) {
    if (!resources.source || !resources.directoryPath || !resources.rootCaPath) {
      throw new PostgresRailwayStockLocalhostCaError("unsafe_temporary_authority");
    }
    this.rootCaDerSha256 = rootCaDerSha256;
    this.sourceUrlAuthority = Object.freeze({ ...sourceUrlAuthority });
    this.resolvedAddress = resolvedAddress;
    this.temporaryDirectory = resources.directoryPath;
    this.passwordFileDirectory = resources.directoryPath;
    this.nodeConnection = Object.freeze({
      host: resolvedAddress,
      port: POSTGRES_PORT,
      ssl: Object.freeze({
        ca: resources.source.pem,
        servername: LOCALHOST,
        rejectUnauthorized: true as const,
        minVersion: TLS_MINIMUM_VERSION,
        checkServerIdentity: checkPostgresRailwayStockLocalhostServerIdentity,
      }),
    });
    this.libpqEnvironment = Object.freeze({
      PGHOST: LOCALHOST,
      PGHOSTADDR: resolvedAddress,
      PGPORT: "5432" as const,
      PGSSLMODE: "verify-full" as const,
      PGSSLROOTCERT: resources.rootCaPath,
      PGSSLMINPROTOCOLVERSION: TLS_MINIMUM_VERSION,
      PGSSLSNI: "1" as const,
    });
  }

  async assertExact(): Promise<void> {
    if (this.state !== "open" || !this.resources.source) {
      throw new PostgresRailwayStockLocalhostCaError("transport_drift");
    }
    let now: Date;
    try {
      now = this.dependencies.now();
    } catch {
      throw new PostgresRailwayStockLocalhostCaError("transport_drift");
    }
    const sourceExact = await heldFileIsExact(
      this.resources.source,
      this.expectedUid,
      this.expectedRootCaDerSha256,
      now,
    );
    const directoryExact = await ownedDirectoryIsExact(this.resources, this.expectedUid);
    const copyExact = await ownedRootCaIsExact(
      this.resources,
      this.expectedUid,
      this.resources.source.pemSha256,
    );
    let currentAddress: string | null = null;
    try {
      currentAddress = await resolveExactRailwayPrivateAddress(
        this.sourceUrlAuthority.hostname,
        this.dependencies,
      );
    } catch {
      currentAddress = null;
    }
    if (
      this.state !== "open"
      || !sourceExact
      || !directoryExact
      || !copyExact
      || currentAddress !== this.resolvedAddress
    ) throw new PostgresRailwayStockLocalhostCaError("transport_drift");
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    this.closePromise = (async () => {
      const exact = await cleanupResources(this.resources, this.expectedUid);
      this.state = "closed";
      if (!exact) throw new PostgresRailwayStockLocalhostCaError("cleanup_failed");
    })();
    return this.closePromise;
  }
}

export async function openPostgresRailwayStockLocalhostCaTransport(
  options: OpenPostgresRailwayStockLocalhostCaTransportOptions,
  dependencyOverrides: Partial<PostgresRailwayStockLocalhostCaDependencies> = {},
): Promise<PostgresRailwayStockLocalhostCaTransport> {
  let stableOptions: OpenPostgresRailwayStockLocalhostCaTransportOptions;
  try {
    validateOptions(options);
    stableOptions = Object.freeze({
      profile: options.profile,
      rootCaFile: options.rootCaFile,
      expectedRootCaDerSha256: options.expectedRootCaDerSha256,
      expectedUid: options.expectedUid,
      sourceUrlAuthority: Object.freeze({
        hostname: options.sourceUrlAuthority.hostname,
        port: options.sourceUrlAuthority.port,
      }),
    });
  } catch (error) {
    if (error instanceof PostgresRailwayStockLocalhostCaError) throw error;
    throw new PostgresRailwayStockLocalhostCaError("invalid_arguments");
  }
  const dependencies: PostgresRailwayStockLocalhostCaDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencyOverrides,
  };
  let uid: number | null;
  let euid: number | null;
  try {
    uid = dependencies.getUid();
    euid = dependencies.getEuid();
  } catch {
    throw new PostgresRailwayStockLocalhostCaError("invalid_arguments");
  }
  if (
    uid === null
    || euid === null
    || uid !== euid
    || uid !== stableOptions.expectedUid
  ) throw new PostgresRailwayStockLocalhostCaError("invalid_arguments");

  const resources: OwnedTransportResources = {
    source: null,
    directoryPath: null,
    directoryIdentity: null,
    directoryHandle: null,
    rootCaPath: null,
    rootCaCreatedIdentity: null,
    rootCaIdentity: null,
    rootCaHandle: null,
  };
  try {
    resources.source = await openStableRootCaFile(stableOptions.rootCaFile, stableOptions.expectedUid);
    let now: Date;
    try {
      now = dependencies.now();
    } catch {
      throw new PostgresRailwayStockLocalhostCaError("root_ca_certificate_invalid");
    }
    const validated = validateRootCa(
      resources.source.pem,
      stableOptions.expectedRootCaDerSha256,
      now,
    );
    const resolvedAddress = await resolveExactRailwayPrivateAddress(
      stableOptions.sourceUrlAuthority.hostname,
      dependencies,
    );
    await createOwnedRootCaCopy(
      resources,
      resources.source.pem,
      stableOptions.expectedUid,
      dependencies,
    );
    const transport = new OpenRailwayStockLocalhostCaTransport(
      resources,
      stableOptions.expectedUid,
      stableOptions.expectedRootCaDerSha256,
      stableOptions.sourceUrlAuthority,
      resolvedAddress,
      validated.derSha256,
      dependencies,
    );
    await transport.assertExact();
    return transport;
  } catch (error) {
    const cleaned = await cleanupResources(resources, stableOptions.expectedUid);
    if (!cleaned) throw new PostgresRailwayStockLocalhostCaError("cleanup_failed");
    if (error instanceof PostgresRailwayStockLocalhostCaError) throw error;
    throw new PostgresRailwayStockLocalhostCaError("unsafe_temporary_authority");
  }
}
