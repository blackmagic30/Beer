import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadProductionRuntimeVariableImportGate,
  type ProductionRuntimeVariableImportGateDependencies } from "../scripts/lib/production-runtime-variable-import-gate.js";
import { sha256PostgresMigrationTransportAuthority } from "../src/db/postgres-migration-receipt.js";
import { checkPostgresRailwayStockLocalhostServerIdentity,
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE } from "../src/lib/postgres-railway-stock-localhost-ca.js";
import { TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
  TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256 } from "./postgres-railway-stock-localhost-ca.fixtures.js";

// Local orchestration regressions: the actual CA and URL parsers run, while
// native custody, network transport and database access are deliberately injected.
const CANDIDATE = "a".repeat(40);
const RESOURCE = "railway:13dab015-df74-45c6-b26f-69323daea99a:4a2334a1-71e7-4745-970a-2cd95da10169";
const STAGING = "railway:a4e0f507-d6d3-4df9-a818-ad92c0071a35:c454955f-263b-4599-aee0-dc447a4d3d15";
const OTHER = "railway:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
const URL = "postgresql://runtime_fixture:synthetic-password@postgres-production.railway.internal:5432/pintpath?sslmode=verify-full";
const MIGRATOR_URL = "postgresql://migrator_fixture:separate-synthetic-password@postgres-production.railway.internal:5432/pintpath?sslmode=verify-full";
const SECRET_ERROR = "synthetic-password: private SQL and provider diagnostic";
const FAILURE = "production_runtime_import_gate_failed";
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

function fixture() {
  const now = new Date("2026-09-11T09:00:00.000Z");
  const env: Record<string, string> = {
    PINTPATH_EXPECTED_DATABASE_URL_SHA256: hash(URL),
    PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256: "b".repeat(64),
    PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S: `${"b".repeat(64)},${"c".repeat(64)}`,
    PINTPATH_DATABASE_RESOURCE_ID: RESOURCE,
    PINTPATH_EXPECTED_DATABASE_RESOURCE_ID: RESOURCE,
    PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID: STAGING,
    PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS: `${STAGING},${OTHER}`,
    PINTPATH_POSTGRES_ROOT_CA_PEM: TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
    PINTPATH_POSTGRES_ROOT_CA_DER_SHA256: TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
  };
  const input = { env, candidateSha: CANDIDATE, databaseUrl: URL };
  const events: string[] = [];
  const transportAuthoritySha256 = sha256PostgresMigrationTransportAuthority({
    profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
    expectedRootCaDerSha256: TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256,
    sourceUrlAuthority: { hostname: "postgres-production.railway.internal", port: 5432 },
  });
  const evidence = {
    binding: { candidateSha: CANDIDATE, pinsFileSha256: "d".repeat(64),
      verificationReceiptFileSha256: "e".repeat(64), sourceSnapshotSha256: "f".repeat(64),
      targetIdentitySha256: "1".repeat(64), targetUrlSha256: hash(MIGRATOR_URL), transportAuthoritySha256 },
    proof: { receipt: { candidateSha: CANDIDATE, expectedEnvironment: "production" },
      targetIdentity: { databaseName: "pintpath", databaseOid: "12345", currentUser: "pintpath_migrator" } },
    reassert: vi.fn(() => { events.push("evidence.assert"); }),
    close: vi.fn(() => { events.push("evidence.close"); }),
  };
  const nodeConnection = {
    host: "fd12::1234", port: 5432,
    ssl: { ca: TEST_POSTGRES_RAILWAY_ROOT_CA_PEM, servername: "localhost",
      rejectUnauthorized: true, minVersion: "TLSv1.2", checkServerIdentity: checkPostgresRailwayStockLocalhostServerIdentity },
  };
  const transport = {
    nodeConnection,
    assertExact: vi.fn(async () => { events.push("transport.assert"); }),
    close: vi.fn(async () => { events.push("transport.close"); }),
  };
  const database = { dialect: "postgres", close: vi.fn(async () => { events.push("database.close"); }) };
  const loadEvidence = vi.fn(() => { events.push("evidence.open"); return evidence; });
  const openTransport = vi.fn(async () => { events.push("transport.open"); return transport; });
  const createDatabase = vi.fn(() => { events.push("database.open"); return database; });
  const assertLiveImport = vi.fn(async () => { events.push("database.verify"); });
  const dependencies = { now: () => now, getUid: () => 501,
    loadEvidence, openTransport, createDatabase, assertLiveImport } as unknown as ProductionRuntimeVariableImportGateDependencies;
  return { now, input, dependencies, evidence, transport, database, events,
    loadEvidence, openTransport, createDatabase, assertLiveImport };
}

async function expectRejected(target: ReturnType<typeof fixture>) {
  await expect(loadProductionRuntimeVariableImportGate(target.input, target.dependencies))
    .rejects.toThrow(new Error(FAILURE));
}

describe("production runtime connection import gate", () => {
  it("accepts independently bound separate migrator/runtime credentials with one strict runtime pool", async () => {
    const f = fixture();
    const held = await loadProductionRuntimeVariableImportGate(f.input, f.dependencies);
    expect(f.evidence.binding.targetUrlSha256).not.toBe(hash(f.input.databaseUrl));
    expect(f.createDatabase).toHaveBeenCalledExactlyOnceWith({
      connectionString: URL, activeRole: "pintpath_runtime",
      railwayStockLocalhostCaConnection: f.transport.nodeConnection,
      applicationName: "pintpath-runtime-verifier", maxConnections: 1,
      idleTimeoutMs: 5_000, connectionTimeoutMs: 10_000,
      statementTimeoutMs: 15_000, idleInTransactionTimeoutMs: 10_000,
    });
    expect(f.openTransport).toHaveBeenCalledExactlyOnceWith({
      profile: "railway-stock-localhost-ca-v1", rootCaPem: TEST_POSTGRES_RAILWAY_ROOT_CA_PEM,
      expectedRootCaDerSha256: TEST_POSTGRES_RAILWAY_ROOT_CA_DER_SHA256, expectedUid: 501,
      sourceUrlAuthority: { hostname: "postgres-production.railway.internal", port: 5432 },
    });
    expect(f.assertLiveImport).toHaveBeenCalledExactlyOnceWith({ database: f.database, ...f.evidence.proof });
    expect(f.events).toEqual(["evidence.open", "transport.open", "transport.assert", "database.open",
      "evidence.assert", "transport.assert", "database.verify", "transport.assert", "evidence.assert"]);
    expect(Object.isFrozen(held.binding)).toBe(true);
    expect(Object.keys(held.binding).sort()).toEqual(["candidateSha", "verificationReceiptFileSha256",
      "sourceSnapshotSha256", "targetIdentitySha256", "transportAuthoritySha256"].sort());
    expect(JSON.stringify(held.binding)).not.toContain("synthetic-password");
    expect(JSON.stringify(held.binding)).not.toContain(hash(URL));
    expect(JSON.stringify(held.binding)).not.toContain(hash(MIGRATOR_URL));
    await held.reassert();
    expect(f.assertLiveImport).toHaveBeenCalledTimes(2);
    await held.close();
    await held.close();
    expect(f.events.slice(-3)).toEqual(["database.close", "transport.close", "evidence.close"]);
    expect(f.database.close).toHaveBeenCalledOnce();
    expect(f.transport.close).toHaveBeenCalledOnce();
    expect(f.evidence.close).toHaveBeenCalledOnce();
    await expect(held.reassert()).rejects.toThrow(FAILURE);
    expect(f.assertLiveImport).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["wrong expected URL pin", (f: ReturnType<typeof fixture>) => { f.input.env.PINTPATH_EXPECTED_DATABASE_URL_SHA256 = "f".repeat(64); }],
    ["forbidden runtime URL", (f: ReturnType<typeof fixture>) => { f.input.env.PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S += `,${hash(URL)}`; }],
    ["staging resource", (f: ReturnType<typeof fixture>) => { f.input.env.PINTPATH_DATABASE_RESOURCE_ID = STAGING; }],
    ["wrong expected resource", (f: ReturnType<typeof fixture>) => { f.input.env.PINTPATH_EXPECTED_DATABASE_RESOURCE_ID = OTHER; }],
    ["absent staging exclusion", (f: ReturnType<typeof fixture>) => { f.input.env.PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS = `${OTHER},${RESOURCE}`; }],
    ["duplicate exclusions", (f: ReturnType<typeof fixture>) => { f.input.env.PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S = `${"b".repeat(64)},${"b".repeat(64)}`; }],
    ["missing staging URL exclusion", (f: ReturnType<typeof fixture>) => { f.input.env.PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256 = "f".repeat(64); }],
    ["invalid candidate", (f: ReturnType<typeof fixture>) => { f.input.candidateSha = "not-a-sha"; }],
    ["wrong CA pin", (f: ReturnType<typeof fixture>) => { f.input.env.PINTPATH_POSTGRES_ROOT_CA_DER_SHA256 = "f".repeat(64); }],
    ["invalid CA", (f: ReturnType<typeof fixture>) => { f.input.env.PINTPATH_POSTGRES_ROOT_CA_PEM = "not a certificate"; }],
    ["expired CA", (f: ReturnType<typeof fixture>) => { f.now.setUTCFullYear(2040); }],
    ["unavailable owner", (f: ReturnType<typeof fixture>) => { f.dependencies.getUid = () => null; }],
  ] as const)("rejects %s before custody/transport/database access", async (_name, change) => {
    const f = fixture(); change(f);
    await expectRejected(f);
    expect(f.loadEvidence).not.toHaveBeenCalled();
    expect(f.openTransport).not.toHaveBeenCalled();
    expect(f.createDatabase).not.toHaveBeenCalled();
  });

  it.each([
    URL.replace("postgres-production.railway.internal", "database.example.invalid"),
    URL.replace("5432", "6543"), URL.replace("verify-full", "disable"),
    `${URL}&options=-c%20role=postgres`, `${URL}&sslmode=verify-full`, ` ${URL}`,
  ])("rejects an independently hashed unsupported URL before opening transport (%#)", async (databaseUrl) => {
    const f = fixture(); f.input.databaseUrl = databaseUrl;
    f.input.env.PINTPATH_EXPECTED_DATABASE_URL_SHA256 = hash(databaseUrl);
    await expectRejected(f);
    expect(f.openTransport).not.toHaveBeenCalled();
    expect(f.createDatabase).not.toHaveBeenCalled();
  });

  it.each(["staging host", "different candidate", "different native transport"])("rejects %s even with valid connection pins", async (change) => {
    const f = fixture();
    if (change === "staging host") {
      f.input.databaseUrl = URL.replace("postgres-production", "postgres-staging");
      f.input.env.PINTPATH_EXPECTED_DATABASE_URL_SHA256 = hash(f.input.databaseUrl);
    } else if (change === "different candidate") f.evidence.binding.candidateSha = "f".repeat(40);
    else f.evidence.binding.transportAuthoritySha256 = "f".repeat(64);
    await expectRejected(f);
    expect(f.openTransport).not.toHaveBeenCalled();
    expect(f.createDatabase).not.toHaveBeenCalled();
    expect(f.evidence.close).toHaveBeenCalledOnce();
  });

  it.each(["native", "open", "initial transport", "database", "live"])("cleans every acquired resource on %s failure and hides raw errors", async (phase) => {
    const f = fixture();
    if (phase === "native") f.loadEvidence.mockImplementation(() => { throw new Error(SECRET_ERROR); });
    if (phase === "open") f.openTransport.mockRejectedValue(new Error(SECRET_ERROR));
    if (phase === "initial transport") f.transport.assertExact.mockRejectedValue(new Error(SECRET_ERROR));
    if (phase === "database") f.createDatabase.mockImplementation(() => { throw new Error(SECRET_ERROR); });
    if (phase === "live") f.assertLiveImport.mockRejectedValue(new Error(SECRET_ERROR));
    await expectRejected(f);
    expect(f.evidence.close).toHaveBeenCalledTimes(phase === "native" ? 0 : 1);
    expect(f.transport.close).toHaveBeenCalledTimes(["native", "open"].includes(phase) ? 0 : 1);
    expect(f.database.close).toHaveBeenCalledTimes(phase === "live" ? 1 : 0);
  });

  it.each(["evidence", "transport", "live", "post-live transport", "post-live evidence"])("rejects %s drift on reassert, then releases custody", async (phase) => {
    const f = fixture();
    const held = await loadProductionRuntimeVariableImportGate(f.input, f.dependencies);
    if (phase === "evidence") f.evidence.reassert.mockImplementation(() => { throw new Error(SECRET_ERROR); });
    if (phase === "transport") f.transport.assertExact.mockRejectedValue(new Error(SECRET_ERROR));
    if (phase === "live") f.assertLiveImport.mockRejectedValue(new Error(SECRET_ERROR));
    if (phase === "post-live transport") f.transport.assertExact.mockResolvedValueOnce().mockRejectedValueOnce(new Error(SECRET_ERROR));
    if (phase === "post-live evidence") f.evidence.reassert.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error(SECRET_ERROR); });
    await expect(held.reassert()).rejects.toThrow(new Error(FAILURE));
    await held.close();
    expect(f.database.close).toHaveBeenCalledOnce();
    expect(f.transport.close).toHaveBeenCalledOnce();
    expect(f.evidence.close).toHaveBeenCalledOnce();
  });

  it("still releases transport and native custody if the database close fails", async () => {
    const f = fixture();
    const held = await loadProductionRuntimeVariableImportGate(f.input, f.dependencies);
    f.database.close.mockRejectedValue(new Error(SECRET_ERROR));
    await expect(held.close()).rejects.toThrow(new Error(FAILURE));
    expect(f.transport.close).toHaveBeenCalledOnce();
    expect(f.evidence.close).toHaveBeenCalledOnce();
    await held.close();
    expect(f.database.close).toHaveBeenCalledOnce();
  });
});
