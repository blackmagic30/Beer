import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import type { FileHandle } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_DNS_TIMEOUT_MS,
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_MINIMUM_REMAINING_VALIDITY_MS,
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  PostgresRailwayStockLocalhostCaError,
  checkPostgresRailwayStockLocalhostServerIdentity,
  openPostgresRailwayStockLocalhostCaTransport,
  type OpenPostgresRailwayStockLocalhostCaTransportOptions,
  type PostgresRailwayStockLocalhostCaDependencies,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";

const TEST_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDUjCCAjqgAwIBAgIUYBQyRs0suyX5rXqgVNuwjILfVgwwDQYJKoZIhvcNAQEL
BQAwLzEtMCsGA1UEAwwkUGludFBhdGggUmFpbHdheSBUcmFuc3BvcnQgVGVzdCBS
b290MB4XDTI2MDgxMDA1MzYxM1oXDTM2MDgwNzA1MzYxM1owLzEtMCsGA1UEAwwk
UGludFBhdGggUmFpbHdheSBUcmFuc3BvcnQgVGVzdCBSb290MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzVV9MGHj6Z6rKbzATlt6Bwkh8H5tSoG9tIlI
nHWFdtoQgTft+jGH3gRvow+/r+4KBz+2f3d6lmIXf3Z2W32P3xPCO/A4HA5T+vHb
enNLWRBP/IHDkdPPVCjlXKwOR+cLUczOdd+YaEnDPZeQ+CrPyKgqCLTEBZqTIBWE
tbYwtElDdx/0f0QzbMMWOuP0LV9rnHg18M04yOdBqxGlKyi04mL2rZEoJurSsoeL
xNfeWiVch5Ret5hof3rf088qf02UN+K3d4Uk/1J3XgCCdzoaY6R3H7SqL3FGzsih
uIETTD7olfSz0DtgZ7RPMTEsrShAN5j8kyoR30SxnfQZRbPQdQIDAQABo2YwZDAd
BgNVHQ4EFgQUMrvU9IxE3Rw9I2Lb8Mu8ux8Q9wswHwYDVR0jBBgwFoAUMrvU9IxE
3Rw9I2Lb8Mu8ux8Q9wswEgYDVR0TAQH/BAgwBgEB/wIBATAOBgNVHQ8BAf8EBAMC
AQYwDQYJKoZIhvcNAQELBQADggEBABQBrpqpxBFYyOxryIcitEuRh0DMQWTn7oRE
jYHJJbNRKiyaFzVo5bqamf6Ft5wKXP/CNljUOTpfZa8Y+dY+TrcP197HMhcT0Zwi
F59mL1zAGSG9V1Kj2qDvNOtOeaQavk1G23bs8HU5tx7Bhx9zsZvkI2y//fX+EjCU
ZufpD/15KvvWwUmLXr8nUkZoLUxw1degtHWCPzNT3f+3Jjp4EYU1nQwz8yvxjL7g
EgybrSNRwoBxVF0Dbido1byzyZCn/LSdz817nfPkGynWvl49Bxtwz9nENfOUNCA7
kjqZ5XK0MFWChjgcl8iF0BqOJfAQTS6WltU1HpU29avHR3FEEgQ=
-----END CERTIFICATE-----
`;

const TEST_LEAF_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIDFjCCAf6gAwIBAgIUFukFuldssZYkJCxkXTEJqzdhE80wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgxMDA1MzYxM1oXDTM2MDgw
NzA1MzYxM1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAt4Ir9ums8qgCpPDsAjKuFjN8yS5pugmR8K9meWUaRITy
VoBcNhP2cfjOImXU2CzvZDtbM0jFWeRzg6aepzbJ9EQEvCFeIa+KzCoH8PBTxMte
ZGpJfvxOmUG0+EZInXuTD677BskGRHKsRyMmEzZiyXBync59FQkECFKlf1Z+WS1F
5CIKeRSLBIrR8X8kd+MxR7YPQPF1Etj9TGuJ2zkQWW1zIwDhmko1yCqAhbayW/kV
gqdTcsyFQg7+pIjSjuSjeIlCSK2SgiWAZeBvxTs4CiLVfYyTvQrp5mnbk1cK66NL
AlQkkKAo7QZyFoNXks9Pp9tl+4rVQQANS5lgoYOcHwIDAQABo2AwXjAdBgNVHQ4E
FgQUp1k9ZgmVhhCelje6Rzcmb44Llk4wHwYDVR0jBBgwFoAUp1k9ZgmVhhCelje6
Rzcmb44Llk4wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCBaAwDQYJKoZIhvcN
AQELBQADggEBAGurnQBZGs1m7LHsULUfg0z1TFwzdvCUMWa1Bvolt1Pj9HQHyDnv
oAKcN4/Z8Tw2LEKjFueKVTmRWBLyCtTOHj+qrlhxieHO5mC8ATtdGfOoOoo7ss1m
5NH6BrH/2UcMp6Q+rZzyUPULm8DHvggQ+1UTcd9SOgBZ3Xf/uW0TPkEd9lwM7f3I
m8d92Kgj7vQX72HAOBbJudAELMsl9eC6r+CWmh7O+hyswr36pfk0GiujCRbqfb+1
2zheVOUGwJu1NxfVRpTChoh2tMjeQ9BHUQS1FjD70Tv4BDlya8rku9UazZeHZDmD
JUXt+wYtOmqhv0ISS4rZfAYMkhd1Gz3jsmI=
-----END CERTIFICATE-----
`;

const TEST_ADDRESS = "fd12:3456:789a::10";
const uid = process.getuid?.() ?? -1;
const roots: string[] = [];

function certificateDerSha256(pem: string): string {
  return crypto.createHash("sha256").update(new crypto.X509Certificate(pem).raw).digest("hex");
}

const TEST_ROOT_CA_DER_SHA256 = certificateDerSha256(TEST_ROOT_CA_PEM);
const TEST_CERTIFICATE = new crypto.X509Certificate(TEST_ROOT_CA_PEM);
const TEST_VALID_NOW = new Date(
  Date.parse(TEST_CERTIFICATE.validFrom)
    + Math.floor((Date.parse(TEST_CERTIFICATE.validTo) - Date.parse(TEST_CERTIFICATE.validFrom)) / 2),
);

function temporaryRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pintpath-railway-ca-test-"),
  ));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function writeRootCa(root: string, pem = TEST_ROOT_CA_PEM, mode = 0o600): string {
  const file = path.join(root, "source-root-ca.pem");
  fs.writeFileSync(file, pem, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function options(
  rootCaFile: string,
  overrides: Partial<OpenPostgresRailwayStockLocalhostCaTransportOptions> = {},
): OpenPostgresRailwayStockLocalhostCaTransportOptions {
  return {
    profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    rootCaFile,
    expectedRootCaDerSha256: TEST_ROOT_CA_DER_SHA256,
    expectedUid: uid,
    sourceUrlAuthority: {
      hostname: "postgres-staging.railway.internal",
      port: 5_432,
    },
    ...overrides,
  };
}

function dependencies(
  root: string,
  overrides: Partial<PostgresRailwayStockLocalhostCaDependencies> = {},
): Partial<PostgresRailwayStockLocalhostCaDependencies> {
  return {
    getUid: () => uid,
    getEuid: () => uid,
    now: () => TEST_VALID_NOW,
    temporaryRoot: () => root,
    resolve6: async () => [TEST_ADDRESS],
    ...overrides,
  };
}

function transportDirectories(root: string): string[] {
  return fs.readdirSync(root)
    .filter((entry) => entry.startsWith("pintpath-railway-stock-localhost-ca-"));
}

function pemFromDer(der: Buffer): string {
  const base64 = der.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}

function certificateWithBrokenSignature(): string {
  const der = Buffer.from(TEST_CERTIFICATE.raw);
  der[der.length - 1] = (der[der.length - 1] ?? 0) ^ 1;
  return pemFromDer(der);
}

function failFirstHandleMethod(
  leafName: string,
  method: "write" | "sync" | "close",
  beforeFailure?: (filePath: string) => void,
): void {
  const originalOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, "open").mockImplementation((async (
    filePath: fs.PathLike,
    flags: string | number,
    mode?: fs.Mode,
  ) => {
    const handle = await originalOpen(filePath, flags, mode);
    if (path.basename(String(filePath)) === leafName) {
      const target = handle as unknown as Record<
        typeof method,
        (...args: readonly unknown[]) => Promise<unknown>
      >;
      const original = target[method].bind(handle);
      let failed = false;
      Object.defineProperty(handle, method, {
        configurable: true,
        value: async (...args: readonly unknown[]) => {
          if (!failed) {
            failed = true;
            beforeFailure?.(String(filePath));
            throw new Error(`forced-${method}-failure`);
          }
          return original(...args);
        },
      });
    }
    return handle;
  }) as typeof fs.promises.open);
}

function faultFirstOwnedCopyStat(
  fault: "throw" | "invalid_mode",
  failFirstClose = false,
): FileHandle[] {
  const captured: FileHandle[] = [];
  const originalOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, "open").mockImplementation((async (
    filePath: fs.PathLike,
    flags: string | number,
    mode?: fs.Mode,
  ) => {
    const handle = await originalOpen(filePath, flags, mode);
    if (path.basename(String(filePath)) === "railway-root-ca.pem") {
      captured.push(handle);
      const originalStat = handle.stat.bind(handle) as (
        options: { bigint: true },
      ) => Promise<fs.BigIntStats>;
      let statCalls = 0;
      Object.defineProperty(handle, "stat", {
        configurable: true,
        value: async (statOptions: { bigint: true }) => {
          statCalls += 1;
          if (statCalls === 1 && fault === "throw") {
            throw new Error("forced-first-stat-failure");
          }
          const stat = await originalStat(statOptions);
          if (statCalls === 1 && fault === "invalid_mode") {
            Object.defineProperty(stat, "mode", {
              configurable: true,
              value: (stat.mode & ~0o7777n) | 0o640n,
            });
          }
          return stat;
        },
      });
      if (failFirstClose) {
        const originalClose = handle.close.bind(handle);
        let failed = false;
        Object.defineProperty(handle, "close", {
          configurable: true,
          value: async () => {
            if (!failed) {
              failed = true;
              throw new Error("forced-close-failure");
            }
            return originalClose();
          },
        });
      }
    }
    return handle;
  }) as typeof fs.promises.open);
  return captured;
}

function captureOpenedHandles(): FileHandle[] {
  const captured: FileHandle[] = [];
  const originalOpen = fs.promises.open.bind(fs.promises);
  vi.spyOn(fs.promises, "open").mockImplementation((async (
    filePath: fs.PathLike,
    flags: string | number,
    mode?: fs.Mode,
  ) => {
    const handle = await originalOpen(filePath, flags, mode);
    captured.push(handle);
    return handle;
  }) as typeof fs.promises.open);
  return captured;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Railway stock localhost CA transport", () => {
  it("projects one pinned fd12 authority into exact Node and libpq TLS settings", async () => {
    const root = temporaryRoot();
    const rootCaFile = writeRootCa(root);
    let resolutions = 0;
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(rootCaFile),
      dependencies(root, {
        resolve6: async (hostname) => {
          resolutions += 1;
          expect(hostname).toBe("postgres-staging.railway.internal");
          return ["FD12:3456:789A:0:0:0:0:10"];
        },
      }),
    );

    expect(transport.profile).toBe("railway-stock-localhost-ca-v1");
    expect(transport.rootCaDerSha256).toBe(TEST_ROOT_CA_DER_SHA256);
    expect(transport.sourceUrlAuthority).toEqual({
      hostname: "postgres-staging.railway.internal",
      port: 5_432,
    });
    expect(transport.resolvedAddress).toBe(TEST_ADDRESS);
    expect(transport.passwordFileHost).toBe("localhost");
    expect(transport.passwordFileDirectory).toBe(transport.temporaryDirectory);
    expect(transport.nodeConnection).toEqual({
      host: TEST_ADDRESS,
      port: 5_432,
      ssl: {
        ca: TEST_ROOT_CA_PEM,
        servername: "localhost",
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        checkServerIdentity: checkPostgresRailwayStockLocalhostServerIdentity,
      },
    });
    expect(Object.isFrozen(transport.nodeConnection)).toBe(true);
    expect(Object.isFrozen(transport.nodeConnection.ssl)).toBe(true);
    expect(transport.libpqEnvironment).toEqual({
      PGHOST: "localhost",
      PGHOSTADDR: TEST_ADDRESS,
      PGPORT: "5432",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: path.join(transport.temporaryDirectory, "railway-root-ca.pem"),
      PGSSLMINPROTOCOLVERSION: "TLSv1.2",
      PGSSLSNI: "1",
    });
    expect(Object.isFrozen(transport.libpqEnvironment)).toBe(true);
    expect(fs.realpathSync(transport.temporaryDirectory)).toBe(transport.temporaryDirectory);
    expect(fs.statSync(transport.temporaryDirectory).mode & 0o7777).toBe(0o700);
    const copied = transport.libpqEnvironment.PGSSLROOTCERT;
    expect(path.dirname(copied)).toBe(transport.passwordFileDirectory);
    expect(fs.statSync(copied).mode & 0o7777).toBe(0o600);
    expect(fs.statSync(copied).nlink).toBe(1);
    expect(fs.readFileSync(copied, "utf8")).toBe(TEST_ROOT_CA_PEM);

    await transport.assertExact();
    expect(resolutions).toBe(3);
    await transport.close();
    await transport.close();
    expect(fs.existsSync(transport.temporaryDirectory)).toBe(false);
    expect(fs.existsSync(rootCaFile)).toBe(true);
    await expect(transport.assertExact()).rejects.toMatchObject({ code: "transport_drift" });
  });

  it("requires the literal localhost Node TLS identity before delegating verification", () => {
    const verifier = vi.spyOn(tls, "checkServerIdentity");
    const certificate = new crypto.X509Certificate(
      TEST_LEAF_CERTIFICATE_PEM,
    ).toLegacyObject() as unknown as tls.PeerCertificate;
    expect(checkPostgresRailwayStockLocalhostServerIdentity(
      "localhost",
      certificate,
    )).toBeUndefined();
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledWith("localhost", certificate);
    verifier.mockClear();
    expect(checkPostgresRailwayStockLocalhostServerIdentity(
      "postgres-staging.railway.internal",
      certificate,
    )).toEqual(new Error("railway_stock_localhost_server_identity_required"));
    expect(verifier).not.toHaveBeenCalled();
  });

  it("allows a mode-600 password file in the shared private directory during use", async () => {
    const root = temporaryRoot();
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root),
    );
    const passwordFile = path.join(transport.passwordFileDirectory, "pgpass");
    fs.writeFileSync(passwordFile, "localhost:5432:db:user:test-only\n", { mode: 0o600 });
    fs.chmodSync(passwordFile, 0o600);
    await transport.assertExact();
    fs.unlinkSync(passwordFile);
    await transport.close();
  });

  it.each([
    ["railway-stock-localhost-ca-v2", { profile: "railway-stock-localhost-ca-v2" }],
    ["upper-case host", { sourceUrlAuthority: { hostname: "Postgres.railway.internal", port: 5_432 } }],
    ["bare suffix", { sourceUrlAuthority: { hostname: "railway.internal", port: 5_432 } }],
    ["nested host", { sourceUrlAuthority: { hostname: "a.b.railway.internal", port: 5_432 } }],
    ["trailing dot", { sourceUrlAuthority: { hostname: "postgres.railway.internal.", port: 5_432 } }],
    ["wrong port", { sourceUrlAuthority: { hostname: "postgres.railway.internal", port: 6_543 } }],
    ["upper-case digest", { expectedRootCaDerSha256: TEST_ROOT_CA_DER_SHA256.toUpperCase() }],
  ])("rejects the non-exact authority input %s before DNS", async (_label, adjustment) => {
    const root = temporaryRoot();
    let resolved = false;
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root), adjustment as Partial<OpenPostgresRailwayStockLocalhostCaTransportOptions>),
      dependencies(root, { resolve6: async () => { resolved = true; return [TEST_ADDRESS]; } }),
    )).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(resolved).toBe(false);
    expect(transportDirectories(root)).toEqual([]);
  });

  it("requires matching real and effective current-UID authority", async () => {
    const root = temporaryRoot();
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root, { getEuid: () => uid + 1 }),
    )).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(transportDirectories(root)).toEqual([]);
  });

  it("snapshots the validated authority before the first asynchronous boundary", async () => {
    const root = temporaryRoot();
    const supplied = options(writeRootCa(root));
    const mutable = supplied.sourceUrlAuthority as {
      hostname: string;
      port: number;
    };
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      supplied,
      dependencies(root, {
        resolve6: async (hostname) => {
          mutable.hostname = "changed.example.com";
          mutable.port = 6_543;
          expect(hostname).toBe("postgres-staging.railway.internal");
          return [TEST_ADDRESS];
        },
      }),
    );
    expect(transport.sourceUrlAuthority).toEqual({
      hostname: "postgres-staging.railway.internal",
      port: 5_432,
    });
    await transport.close();
  });

  it("contains malformed runtime options and UID callbacks behind fixed errors", async () => {
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      null as never,
    )).rejects.toEqual(new PostgresRailwayStockLocalhostCaError("invalid_arguments"));
    const root = temporaryRoot();
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root, { getUid: () => { throw new Error("uid-provider-detail"); } }),
    )).rejects.toEqual(new PostgresRailwayStockLocalhostCaError("invalid_arguments"));
  });

  it.each([
    { answers: [] as string[] },
    { answers: [TEST_ADDRESS, "fd12::20"] },
    { answers: ["127.0.0.1"] },
    { answers: ["::1"] },
    { answers: ["fd11::1"] },
    { answers: ["fd12::1%eth0"] },
    { answers: [" fd12::1"] },
    { answers: ["not-an-address"] },
  ])("rejects a DNS answer other than one fd12::/16 IPv6 address: $answers", async ({ answers }) => {
    const root = temporaryRoot();
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root, { resolve6: async () => answers }),
    )).rejects.toMatchObject({ code: "railway_private_dns_invalid" });
    expect(transportDirectories(root)).toEqual([]);
  });

  it("rejects DNS lookup failures without exposing the resolver error", async () => {
    const root = temporaryRoot();
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root, { resolve6: async () => { throw new Error("private-host-detail"); } }),
    )).rejects.toEqual(new PostgresRailwayStockLocalhostCaError("railway_private_dns_invalid"));
    expect(transportDirectories(root)).toEqual([]);
  });

  it("bounds a never-settling open DNS lookup and aborts its late settlement", async () => {
    vi.useFakeTimers();
    const root = temporaryRoot();
    let signal: AbortSignal | null = null;
    let markStarted!: () => void;
    let rejectLate!: (reason?: unknown) => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = new Promise<readonly string[]>((_resolve, reject) => {
      rejectLate = reject;
    });
    const opening = openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root, {
        resolve6: async (_hostname, currentSignal) => {
          signal = currentSignal;
          markStarted();
          return pending;
        },
      }),
    );
    const openingResult = opening.then(
      () => null,
      (error: unknown) => error,
    );
    await started;
    await vi.advanceTimersByTimeAsync(
      POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_DNS_TIMEOUT_MS,
    );
    expect(await openingResult).toEqual(
      new PostgresRailwayStockLocalhostCaError("railway_private_dns_invalid"),
    );
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    rejectLate(new Error("late-private-resolver-detail"));
    await Promise.resolve();
    await Promise.resolve();
    expect(transportDirectories(root)).toEqual([]);
  });

  it("bounds every assertion DNS lookup and maps timeout to transport drift", async () => {
    const root = temporaryRoot();
    let resolutions = 0;
    let signal: AbortSignal | null = null;
    let markStarted!: () => void;
    let rejectLate!: (reason?: unknown) => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = new Promise<readonly string[]>((_resolve, reject) => {
      rejectLate = reject;
    });
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root, {
        resolve6: async (_hostname, currentSignal) => {
          resolutions += 1;
          if (resolutions < 3) return [TEST_ADDRESS];
          signal = currentSignal;
          markStarted();
          return pending;
        },
      }),
    );
    vi.useFakeTimers();
    const assertion = transport.assertExact();
    const assertionResult = assertion.then(
      () => null,
      (error: unknown) => error,
    );
    await started;
    await vi.advanceTimersByTimeAsync(
      POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_DNS_TIMEOUT_MS,
    );
    expect(await assertionResult).toEqual(
      new PostgresRailwayStockLocalhostCaError("transport_drift"),
    );
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    rejectLate(new Error("late-assertion-resolver-detail"));
    await Promise.resolve();
    await Promise.resolve();
    vi.useRealTimers();
    await transport.close();
  });

  it("cleans every descriptor when the initial post-copy assertion DNS times out", async () => {
    vi.useFakeTimers();
    const root = temporaryRoot();
    const handles = captureOpenedHandles();
    let resolutions = 0;
    let signal: AbortSignal | null = null;
    let markStarted!: () => void;
    let rejectLate!: (reason?: unknown) => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const pending = new Promise<readonly string[]>((_resolve, reject) => {
      rejectLate = reject;
    });
    const opening = openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root, {
        resolve6: async (_hostname, currentSignal) => {
          resolutions += 1;
          if (resolutions === 1) return [TEST_ADDRESS];
          signal = currentSignal;
          markStarted();
          return pending;
        },
      }),
    );
    const openingResult = opening.then(
      () => null,
      (error: unknown) => error,
    );
    await started;
    await vi.advanceTimersByTimeAsync(
      POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_DNS_TIMEOUT_MS,
    );
    expect(await openingResult).toEqual(
      new PostgresRailwayStockLocalhostCaError("transport_drift"),
    );
    expect(signal?.aborted).toBe(true);
    expect(handles).toHaveLength(3);
    for (const handle of handles) {
      await expect(handle.stat()).rejects.toThrow();
    }
    expect(vi.getTimerCount()).toBe(0);
    rejectLate(new Error("late-initial-assertion-resolver-detail"));
    await Promise.resolve();
    await Promise.resolve();
    expect(transportDirectories(root)).toEqual([]);
  });

  it("contains clock failures behind fixed open and drift errors", async () => {
    const firstRoot = temporaryRoot();
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(firstRoot)),
      dependencies(firstRoot, { now: () => { throw new Error("clock-detail"); } }),
    )).rejects.toMatchObject({ code: "root_ca_certificate_invalid" });

    const secondRoot = temporaryRoot();
    let calls = 0;
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(secondRoot)),
      dependencies(secondRoot, {
        now: () => {
          calls += 1;
          if (calls > 2) throw new Error("later-clock-detail");
          return TEST_VALID_NOW;
        },
      }),
    );
    await expect(transport.assertExact()).rejects.toMatchObject({ code: "transport_drift" });
    await transport.close();
  });

  it.each([
    ["world-readable mode", 0o644, false],
    ["extra hardlink", 0o600, true],
  ])("rejects a source CA with %s", async (_label, mode, hardlink) => {
    const root = temporaryRoot();
    const rootCaFile = writeRootCa(root, TEST_ROOT_CA_PEM, mode);
    if (hardlink) fs.linkSync(rootCaFile, path.join(root, "root-ca-alias.pem"));
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(rootCaFile),
      dependencies(root),
    )).rejects.toMatchObject({ code: "unsafe_root_ca_file" });
    expect(transportDirectories(root)).toEqual([]);
  });

  it("accepts a canonical CA file at exactly 64 KiB", async () => {
    const root = temporaryRoot();
    const pem = TEST_ROOT_CA_PEM.padEnd(64 * 1024, " ");
    expect(Buffer.byteLength(pem, "utf8")).toBe(64 * 1024);
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root, pem)),
      dependencies(root),
    );
    await transport.assertExact();
    await transport.close();
  });

  it("rejects a CA file larger than 64 KiB before DNS", async () => {
    const root = temporaryRoot();
    const pem = TEST_ROOT_CA_PEM.padEnd((64 * 1024) + 1, " ");
    let resolved = false;
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root, pem)),
      dependencies(root, {
        resolve6: async () => {
          resolved = true;
          return [TEST_ADDRESS];
        },
      }),
    )).rejects.toEqual(
      new PostgresRailwayStockLocalhostCaError("unsafe_root_ca_file"),
    );
    expect(resolved).toBe(false);
    expect(transportDirectories(root)).toEqual([]);
  });

  it("rejects a symbolic-link CA path", async () => {
    const root = temporaryRoot();
    const target = writeRootCa(root);
    const link = path.join(root, "root-ca-link.pem");
    fs.symlinkSync(target, link);
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(link),
      dependencies(root),
    )).rejects.toMatchObject({ code: "unsafe_root_ca_file" });
  });

  it("rejects noncanonical and malformed CA inputs", async () => {
    const root = temporaryRoot();
    const valid = writeRootCa(root);
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(`${root}/./${path.basename(valid)}`),
      dependencies(root),
    )).rejects.toMatchObject({ code: "invalid_arguments" });
    const malformed = path.join(root, "malformed-root-ca.pem");
    fs.writeFileSync(malformed, "-----BEGIN CERTIFICATE-----\nnot-base64\n", { mode: 0o600 });
    fs.chmodSync(malformed, 0o600);
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(malformed),
      dependencies(root),
    )).rejects.toMatchObject({ code: "root_ca_certificate_invalid" });
  });

  it("requires the independently pinned DER hash", async () => {
    const root = temporaryRoot();
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root), { expectedRootCaDerSha256: "0".repeat(64) }),
      dependencies(root),
    )).rejects.toMatchObject({ code: "root_ca_pin_mismatch" });
    expect(transportDirectories(root)).toEqual([]);
  });

  it.each([
    ["non-CA certificate", TEST_LEAF_CERTIFICATE_PEM, () => TEST_VALID_NOW],
    ["two certificates", `${TEST_ROOT_CA_PEM}${TEST_ROOT_CA_PEM}`, () => TEST_VALID_NOW],
    ["not-yet-valid certificate", TEST_ROOT_CA_PEM, () => new Date(Date.parse(TEST_CERTIFICATE.validFrom) - 1)],
    ["expired certificate", TEST_ROOT_CA_PEM, () => new Date(Date.parse(TEST_CERTIFICATE.validTo))],
  ])("rejects a %s", async (_label, pem, now) => {
    const root = temporaryRoot();
    const expectedRootCaDerSha256 = pem === TEST_LEAF_CERTIFICATE_PEM
      ? certificateDerSha256(TEST_LEAF_CERTIFICATE_PEM)
      : TEST_ROOT_CA_DER_SHA256;
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root, pem), { expectedRootCaDerSha256 }),
      dependencies(root, { now }),
    )).rejects.toMatchObject({ code: "root_ca_certificate_invalid" });
    expect(transportDirectories(root)).toEqual([]);
  });

  it("accepts exactly 24 hours of CA validity remaining and rejects one millisecond less", async () => {
    const validToMs = Date.parse(TEST_CERTIFICATE.validTo);
    const exactBoundary = new Date(
      validToMs
        - POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_MINIMUM_REMAINING_VALIDITY_MS,
    );
    const acceptedRoot = temporaryRoot();
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(acceptedRoot)),
      dependencies(acceptedRoot, { now: () => exactBoundary }),
    );
    await transport.close();

    const rejectedRoot = temporaryRoot();
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(rejectedRoot)),
      dependencies(rejectedRoot, {
        now: () => new Date(exactBoundary.getTime() + 1),
      }),
    )).rejects.toEqual(
      new PostgresRailwayStockLocalhostCaError("root_ca_certificate_invalid"),
    );
    expect(transportDirectories(rejectedRoot)).toEqual([]);
  });

  it("rechecks the exact 24-hour CA validity boundary on every assertion", async () => {
    const root = temporaryRoot();
    let now = TEST_VALID_NOW;
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root, { now: () => now }),
    );
    const exactBoundaryMs = Date.parse(TEST_CERTIFICATE.validTo)
      - POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_MINIMUM_REMAINING_VALIDITY_MS;
    now = new Date(exactBoundaryMs);
    await transport.assertExact();
    now = new Date(exactBoundaryMs + 1);
    await expect(transport.assertExact()).rejects.toEqual(
      new PostgresRailwayStockLocalhostCaError("transport_drift"),
    );
    await transport.close();
  });

  it("rejects a CA whose self-signature does not verify", async () => {
    const root = temporaryRoot();
    const broken = certificateWithBrokenSignature();
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root, broken), {
        expectedRootCaDerSha256: certificateDerSha256(broken),
      }),
      dependencies(root),
    )).rejects.toMatchObject({ code: "root_ca_certificate_invalid" });
  });

  it("detects source CA identity drift and still closes its owned authority", async () => {
    const root = temporaryRoot();
    const rootCaFile = writeRootCa(root);
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(rootCaFile),
      dependencies(root),
    );
    fs.chmodSync(rootCaFile, 0o640);
    await expect(transport.assertExact()).rejects.toMatchObject({ code: "transport_drift" });
    fs.chmodSync(rootCaFile, 0o600);
    await transport.close();
    expect(fs.existsSync(transport.temporaryDirectory)).toBe(false);
  });

  it("detects a changed private DNS answer", async () => {
    const root = temporaryRoot();
    let address = TEST_ADDRESS;
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root, { resolve6: async () => [address] }),
    );
    address = "fd12:3456:789a::11";
    await expect(transport.assertExact()).rejects.toMatchObject({ code: "transport_drift" });
    await transport.close();
  });

  it("unlinks its exact CA after mode drift but reports cleanup_failed", async () => {
    const root = temporaryRoot();
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root),
    );
    fs.chmodSync(transport.libpqEnvironment.PGSSLROOTCERT, 0o640);
    await expect(transport.assertExact()).rejects.toMatchObject({ code: "transport_drift" });
    await expect(transport.close()).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(fs.existsSync(transport.temporaryDirectory)).toBe(false);
  });

  it("removes its exact directory after mode drift but reports cleanup_failed", async () => {
    const root = temporaryRoot();
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root),
    );
    fs.chmodSync(transport.temporaryDirectory, 0o750);
    await expect(transport.assertExact()).rejects.toMatchObject({ code: "transport_drift" });
    await expect(transport.close()).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(fs.existsSync(transport.temporaryDirectory)).toBe(false);
  });

  it("never deletes a replacement at the owned CA pathname", async () => {
    const root = temporaryRoot();
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root),
    );
    const copiedCa = transport.libpqEnvironment.PGSSLROOTCERT;
    fs.unlinkSync(copiedCa);
    fs.writeFileSync(copiedCa, TEST_ROOT_CA_PEM, { mode: 0o600 });
    fs.chmodSync(copiedCa, 0o600);
    await expect(transport.close()).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(fs.existsSync(copiedCa)).toBe(true);
  });

  it("requires the shared password-file leaf to be removed before close", async () => {
    const root = temporaryRoot();
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root),
    );
    const passwordFile = path.join(transport.passwordFileDirectory, "pgpass");
    fs.writeFileSync(passwordFile, "test-only\n", { mode: 0o600 });
    await expect(transport.close()).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(fs.existsSync(passwordFile)).toBe(true);
  });

  it("cleans an exact partial CA copy after a forced write failure", async () => {
    const root = temporaryRoot();
    failFirstHandleMethod("railway-root-ca.pem", "write");
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root),
    )).rejects.toMatchObject({ code: "unsafe_temporary_authority" });
    expect(transportDirectories(root)).toEqual([]);
  });

  it("closes and removes the captured CA after its first descriptor stat throws", async () => {
    const root = temporaryRoot();
    const captured = faultFirstOwnedCopyStat("throw");
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root),
    )).rejects.toEqual(
      new PostgresRailwayStockLocalhostCaError("unsafe_temporary_authority"),
    );
    expect(captured).toHaveLength(1);
    await expect(captured[0]!.stat()).rejects.toThrow();
    expect(transportDirectories(root)).toEqual([]);
  });

  it("closes and removes the captured CA after first-stat validation fails", async () => {
    const root = temporaryRoot();
    const captured = faultFirstOwnedCopyStat("invalid_mode");
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root),
    )).rejects.toEqual(
      new PostgresRailwayStockLocalhostCaError("unsafe_temporary_authority"),
    );
    expect(captured).toHaveLength(1);
    await expect(captured[0]!.stat()).rejects.toThrow();
    expect(transportDirectories(root)).toEqual([]);
  });

  it("gives captured-copy close failure precedence over its first-stat failure", async () => {
    const root = temporaryRoot();
    const captured = faultFirstOwnedCopyStat("throw", true);
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root),
    )).rejects.toEqual(
      new PostgresRailwayStockLocalhostCaError("cleanup_failed"),
    );
    expect(captured).toHaveLength(1);
    await expect(captured[0]!.stat()).rejects.toThrow();
    expect(transportDirectories(root)).toEqual([]);
  });

  it("reports cleanup_failed when a partial CA copy gains another hardlink", async () => {
    const root = temporaryRoot();
    const retained = path.join(root, "retained-root-ca.pem");
    failFirstHandleMethod(
      "railway-root-ca.pem",
      "sync",
      (filePath) => fs.linkSync(filePath, retained),
    );
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root),
    )).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(fs.existsSync(retained)).toBe(true);
    expect(transportDirectories(root)).toEqual([]);
  });

  it("gives source-handle cleanup failure precedence over a pin mismatch", async () => {
    const root = temporaryRoot();
    failFirstHandleMethod("source-root-ca.pem", "close");
    await expect(openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root), { expectedRootCaDerSha256: "0".repeat(64) }),
      dependencies(root),
    )).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(transportDirectories(root)).toEqual([]);
  });

  it("gives owned-copy handle cleanup failure precedence after successful use", async () => {
    const root = temporaryRoot();
    failFirstHandleMethod("railway-root-ca.pem", "close");
    const transport = await openPostgresRailwayStockLocalhostCaTransport(
      options(writeRootCa(root)),
      dependencies(root),
    );
    await expect(transport.close()).rejects.toMatchObject({ code: "cleanup_failed" });
    expect(fs.existsSync(transport.temporaryDirectory)).toBe(false);
  });
});
