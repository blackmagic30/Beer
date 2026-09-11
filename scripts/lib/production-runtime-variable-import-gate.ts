import crypto from "node:crypto";

import { sha256PostgresMigrationTransportAuthority } from "../../src/db/postgres-migration-receipt.js";
import { createPostgresDatabase, type SqlDatabase } from "../../src/db/sql-database.js";
import {
  assertPostgresRailwayStockLocalhostRootCaPem,
  openPostgresRailwayStockLocalhostCaTransportFromPem,
  parsePostgresRailwayStockLocalhostCaUrl,
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
  type PostgresRailwayStockLocalhostCaTransport,
} from "../../src/lib/postgres-railway-stock-localhost-ca.js";
import { POSTGRES_RUNTIME_VERIFIER_POOL_OPTIONS } from "../verify-postgres-runtime.js";
import {
  assertBarPilotProductionLiveImport,
  loadBarPilotProductionMigrationEvidence,
} from "./bar-pilot-production-runtime-preflight.js";

const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const RESOURCE = "railway:13dab015-df74-45c6-b26f-69323daea99a:4a2334a1-71e7-4745-970a-2cd95da10169";
const STAGING_RESOURCE = "railway:a4e0f507-d6d3-4df9-a818-ad92c0071a35:c454955f-263b-4599-aee0-dc447a4d3d15";
const RESOURCE_PATTERN = /^railway:[a-f0-9-]{36}:[a-f0-9-]{36}$/;
const failure = () => new Error("production_runtime_import_gate_failed");
const digest = (source: string) => crypto.createHash("sha256").update(source, "utf8").digest("hex");

export interface ProductionRuntimeVariableImportGateDependencies {
  now(): Date;
  getUid(): number | null;
  loadEvidence: typeof loadBarPilotProductionMigrationEvidence;
  openTransport: typeof openPostgresRailwayStockLocalhostCaTransportFromPem;
  createDatabase: typeof createPostgresDatabase;
  assertLiveImport: typeof assertBarPilotProductionLiveImport;
}
const defaults: ProductionRuntimeVariableImportGateDependencies = {
  now: () => new Date(),
  getUid: () => process.getuid?.() ?? null,
  loadEvidence: loadBarPilotProductionMigrationEvidence,
  openTransport: openPostgresRailwayStockLocalhostCaTransportFromPem,
  createDatabase: createPostgresDatabase,
  assertLiveImport: assertBarPilotProductionLiveImport,
};

function exactList(source: string | undefined, pattern: RegExp): string[] {
  if (!source) throw failure();
  const values = source.split(",").map(value => value.trim());
  if (values.length < 2 || new Set(values).size !== values.length || values.some(value => !pattern.test(value))) throw failure();
  return values;
}

/** The proposed restricted runtime URL has separate authority from the migrator URL. */
function assertConnectionPins(env: Readonly<Record<string, string | undefined>>, databaseUrl: string): void {
  const expected = env.PINTPATH_EXPECTED_DATABASE_URL_SHA256;
  const staging = env.PINTPATH_PERMANENT_STAGING_DATABASE_URL_SHA256;
  const forbiddenUrls = exactList(env.PINTPATH_FORBIDDEN_DATABASE_URL_SHA256S, HASH);
  const forbiddenResources = exactList(env.PINTPATH_FORBIDDEN_DATABASE_RESOURCE_IDS, RESOURCE_PATTERN);
  if (!expected || !HASH.test(expected) || databaseUrl.trim() !== databaseUrl
    || digest(databaseUrl) !== expected || forbiddenUrls.includes(expected)
    || !staging || !HASH.test(staging) || !forbiddenUrls.includes(staging)
    || env.PINTPATH_DATABASE_RESOURCE_ID !== RESOURCE
    || env.PINTPATH_EXPECTED_DATABASE_RESOURCE_ID !== RESOURCE
    || env.PINTPATH_PERMANENT_STAGING_DATABASE_RESOURCE_ID !== STAGING_RESOURCE
    || !forbiddenResources.includes(STAGING_RESOURCE) || forbiddenResources.includes(RESOURCE)) throw failure();
}

/**
 * Used only by the protected production DATABASE_URL setter on its existing
 * private-network runner. It opens one restricted, pinned-TLS connection and
 * actually reads the imported state; metadata-only evidence cannot pass it.
 */
export async function loadProductionRuntimeVariableImportGate(input: {
  env: Readonly<Record<string, string | undefined>>;
  candidateSha: string;
  databaseUrl: string;
}, overrides: Partial<ProductionRuntimeVariableImportGateDependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  const env = Object.freeze({ ...input.env });
  let evidence: ReturnType<typeof loadBarPilotProductionMigrationEvidence> | null = null;
  let transport: PostgresRailwayStockLocalhostCaTransport | null = null;
  let database: SqlDatabase | null = null;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    let failed = false;
    try { if (database) await database.close(); } catch { failed = true; }
    try { if (transport) await transport.close(); } catch { failed = true; }
    try { evidence?.close(); } catch { failed = true; }
    if (failed) throw failure();
  };
  try {
    if (!SHA.test(input.candidateSha)) throw failure();
    assertConnectionPins(env, input.databaseUrl);
    const parsed = parsePostgresRailwayStockLocalhostCaUrl(input.databaseUrl);
    const rootCaPem = env.PINTPATH_POSTGRES_ROOT_CA_PEM ?? "";
    const expectedRootCaDerSha256 = env.PINTPATH_POSTGRES_ROOT_CA_DER_SHA256 ?? "";
    assertPostgresRailwayStockLocalhostRootCaPem(rootCaPem, expectedRootCaDerSha256, dependencies.now());
    const uid = dependencies.getUid();
    if (uid === null || !Number.isSafeInteger(uid) || uid < 0) throw failure();
    evidence = dependencies.loadEvidence({ env, candidateSha: input.candidateSha, now: dependencies.now() });
    // Migrator and runtime credentials differ; their exact private host, CA and
    // physical database must still refer to the independently verified target.
    if (evidence.binding.candidateSha !== input.candidateSha || evidence.binding.transportAuthoritySha256 !== sha256PostgresMigrationTransportAuthority({
      profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      expectedRootCaDerSha256,
      sourceUrlAuthority: { hostname: parsed.sourceUrlAuthority.hostname, port: 5432 },
    })) throw failure();
    transport = await dependencies.openTransport({
      profile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE, rootCaPem,
      expectedRootCaDerSha256, expectedUid: uid, sourceUrlAuthority: parsed.sourceUrlAuthority,
    });
    await transport.assertExact();
    database = dependencies.createDatabase({
      connectionString: parsed.connectionString,
      activeRole: "pintpath_runtime",
      railwayStockLocalhostCaConnection: transport.nodeConnection,
      ...POSTGRES_RUNTIME_VERIFIER_POOL_OPTIONS,
    });
    const heldEvidence = evidence, heldTransport = transport, heldDatabase = database;
    const reassert = async (): Promise<void> => {
      try {
        if (closed) throw failure();
        assertConnectionPins(env, input.databaseUrl);
        assertPostgresRailwayStockLocalhostRootCaPem(rootCaPem, expectedRootCaDerSha256, dependencies.now());
        heldEvidence.reassert(dependencies.now());
        await heldTransport.assertExact();
        await dependencies.assertLiveImport({ database: heldDatabase, ...heldEvidence.proof });
        await heldTransport.assertExact();
        heldEvidence.reassert(dependencies.now());
      } catch { throw failure(); }
    };
    await reassert();
    // No URLs, usernames, credential digests or raw provider errors in output.
    const binding = Object.freeze({
      candidateSha: input.candidateSha,
      verificationReceiptFileSha256: heldEvidence.binding.verificationReceiptFileSha256,
      sourceSnapshotSha256: heldEvidence.binding.sourceSnapshotSha256,
      targetIdentitySha256: heldEvidence.binding.targetIdentitySha256,
      transportAuthoritySha256: heldEvidence.binding.transportAuthoritySha256,
    });
    return { binding, reassert, close };
  } catch {
    try { await close(); } catch { /* Preserve the same secret-free failure. */ }
    throw failure();
  }
}
