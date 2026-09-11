import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertBarPilotProductionLiveImport,
  assertBarPilotProductionMigrationEvidence,
  loadBarPilotProductionMigrationEvidence,
  materializeBarPilotProductionMigrationEvidence,
  type BarPilotProductionMigrationArtifacts,
  type BarPilotProductionMigrationPins,
} from "../scripts/lib/bar-pilot-production-runtime-preflight.js";
import {
  finalizePostgresMigrationApplyReceipt,
  finalizePostgresMigrationReceipt,
  sha256PostgresMigrationReadyMetadata,
  sha256PostgresMigrationTargetIdentity,
} from "../src/db/postgres-migration-receipt.js";
import {
  serializeCanonicalPostgresMigrationJson as bytes,
  sha256PostgresMigrationBytes as hash,
  sha256PostgresMigrationContract,
} from "../src/db/postgres-migration-schema.js";
import { POSTGRES_MIGRATION_CONTRACT } from "../src/db/postgres-migration-contract.js";
import * as runtime from "../src/db/postgres-runtime.js";
import type { SqlDatabase } from "../src/db/sql-database.js";

const sha = (value: string) => hash(value);
const candidateSha = "a".repeat(40);
const now = new Date("2026-09-11T09:00:00.000Z");

function fixture() {
  const key = crypto.generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(key.publicKey.export({ format: "pem", type: "spki" }));
  const targetIdentity = { currentUser: "pintpath_migrator", sessionUser: "migration_test",
    databaseName: "pilot_production", databaseOid: "12345", serverVersionNum: "170010", systemIdentifier: "123456789" };
  const manifest = {
    kind: "pint-path-postgres-migration-source-snapshot", version: 2,
    capturedAt: "2026-09-11T08:00:00.000Z", candidateSha, contractSha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
    operatorIdSha256: sha("operator"), maintenanceReferenceSha256: sha("maintenance"),
    schema: { sourceVersion: POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion,
      fingerprint: POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint, counts: POSTGRES_MIGRATION_CONTRACT.expectedCounts },
    database: { file: "pint-path.sqlite", bytes: 8192, sha256: sha("private-unsanitized-source") },
    evidence: { bytes: 100, files: 1, directories: 0, treeSha256: sha("private-evidence") },
    deletionLedger: { directory: "account-deletion-ledger-authority", authorityManifestFile: "authority-manifest.json",
      authorityManifestSha256: sha("ledger-authority"), currentLedgerSha256: sha("ledger"),
      genesisSha256: sha("genesis"), checkpointSha256: sha("checkpoint"), immutableObjectCount: 0,
      immutableSetSha256: sha("immutable-set"), tombstoneCount: 0, latestCompletedAt: null },
  };
  const metadata = {
    import_state: "ready" as const, migration_candidate_sha: candidateSha,
    migration_contract_sha256: manifest.contractSha256, migration_manifest_sha256: hash(bytes(manifest)),
    migration_plan_sha256: sha("plan"), migration_run_sha256: sha("run"),
    source_schema_fingerprint: manifest.schema.fingerprint, source_schema_version: "16",
    source_snapshot_sha256: manifest.database.sha256, target_ddl_sha256: sha("ddl"), live_schema_sha256: sha("live-schema"),
  };
  const apply = finalizePostgresMigrationApplyReceipt({
    kind: "pint-path-postgres-migration-receipt", version: 3, status: "awaiting-verification",
    expectedEnvironment: "production", approvalReferenceSha256: sha("approved-change"),
    operatorIdSha256: manifest.operatorIdSha256, verifierIdSha256: sha("independent-verifier"),
    verifierAuthoritySha256: sha("verifier-authority"), verifierAuthorityPolicySha256: sha("authority-policy"),
    runIdSha256: metadata.migration_run_sha256, runBindingSha256: sha("run-binding"),
    targetIdentitySha256: sha256PostgresMigrationTargetIdentity(targetIdentity),
    transportAuthoritySha256: sha("transport"), targetUrlSha256: sha("private-migrator-url"),
    targetDdlSha256: metadata.target_ddl_sha256, liveSchemaSha256: metadata.live_schema_sha256,
    sourceSnapshotSha256: manifest.database.sha256, sourceSchemaFingerprint: manifest.schema.fingerprint,
    contractSha256: manifest.contractSha256, manifestSha256: hash(bytes(manifest)), planSha256: metadata.migration_plan_sha256,
    candidateSha, tableSetSha256: sha("all-tables"), transformedDataSha256: sha("all-rows"),
    keyRangesSha256: sha("all-keys"), stateTotalsSha256: sha("all-states"), schemaMetadataSha256: sha256PostgresMigrationReadyMetadata(metadata),
    tableCount: 56, columnCount: 717, rowCount: 100, chunkCount: 1, zeroRowTableCount: 55, foreignKeyCount: 76,
  });
  const payload = {
    applyReceiptSha256: apply.receiptSha256, approvedAt: "2026-09-11T08:10:00.000Z", candidateSha,
    expectedEnvironment: "production" as const, expiresAt: "2026-09-11T08:30:00.000Z",
    liveSchemaSha256: apply.liveSchemaSha256, targetIdentitySha256: apply.targetIdentitySha256,
    verifierIdSha256: apply.verifierIdSha256, verifierAuthoritySha256: apply.verifierAuthoritySha256,
    verifierAuthorityPolicySha256: apply.verifierAuthorityPolicySha256, verifierPublicKeySha256: hash(publicKey),
  };
  const approval = { kind: "pint-path-postgres-migration-verification-approval", version: 1, payload,
    signatureBase64: crypto.sign(null, bytes(payload), key.privateKey).toString("base64") };
  const { receiptSha256: _hash, ...shared } = apply;
  const receipt = finalizePostgresMigrationReceipt({ ...shared, status: "ready",
    applyReceiptSha256: apply.receiptSha256, verificationApprovalFileSha256: hash(bytes(approval)),
    verifierPublicKeySha256: hash(publicKey), verifiedAt: "2026-09-11T08:20:00.000Z" });
  const artifacts: BarPilotProductionMigrationArtifacts = {
    snapshotManifestBytes: bytes(manifest), applyReceiptBytes: bytes(apply), verificationReceiptBytes: bytes(receipt),
    verificationApprovalBytes: bytes(approval), verifierPublicKeyBytes: publicKey, targetIdentityBytes: bytes(targetIdentity),
  };
  const expected: BarPilotProductionMigrationPins = {
    candidateSha, snapshotManifestFileSha256: hash(artifacts.snapshotManifestBytes),
    applyReceiptFileSha256: hash(artifacts.applyReceiptBytes), verificationReceiptFileSha256: hash(artifacts.verificationReceiptBytes),
    verificationApprovalFileSha256: hash(artifacts.verificationApprovalBytes), verifierPublicKeySha256: hash(publicKey),
    targetIdentitySha256: apply.targetIdentitySha256, targetUrlSha256: apply.targetUrlSha256,
    transportAuthoritySha256: apply.transportAuthoritySha256, targetDdlSha256: apply.targetDdlSha256,
    liveSchemaSha256: apply.liveSchemaSha256, verifierAuthoritySha256: apply.verifierAuthoritySha256,
    verifierAuthorityPolicySha256: apply.verifierAuthorityPolicySha256,
  };
  return { artifacts, expected, now, manifest, apply, receipt, targetIdentity, metadata, approval, signingKey: key.privateKey };
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("bar pilot production migration artifact gate", () => {
  it("accepts matching native receipts and independently signed verification, not a new success envelope", () => {
    const input = fixture();
    expect(assertBarPilotProductionMigrationEvidence(input)).toEqual({ receipt: input.receipt, targetIdentity: input.targetIdentity });
  });

  it.each(["snapshotManifestBytes", "applyReceiptBytes", "verificationReceiptBytes", "verificationApprovalBytes", "verifierPublicKeyBytes", "targetIdentityBytes"] as const)(
    "rejects tampered %s without exposing its content", (field) => {
      const input = fixture(); input.artifacts[field] = Buffer.from("PRIVATE_VALUE_DO_NOT_EXPOSE");
      expect(() => assertBarPilotProductionMigrationEvidence(input)).toThrow("Production migration evidence is missing, inconsistent, or unauthorised.");
    },
  );

  it("rejects a self-hashed but differently reconciled final receipt", () => {
    const input = fixture();
    const { receiptSha256: _hash, ...receipt } = input.receipt;
    input.artifacts.verificationReceiptBytes = bytes(finalizePostgresMigrationReceipt({ ...receipt, rowCount: 101 }));
    input.expected.verificationReceiptFileSha256 = hash(input.artifacts.verificationReceiptBytes);
    expect(() => assertBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
  });

  it("rejects an unsigned approval even if its file and final receipt hashes are supplied", () => {
    const input = fixture();
    input.artifacts.verificationApprovalBytes = bytes({ ...input.approval, signatureBase64: Buffer.alloc(64).toString("base64") });
    input.expected.verificationApprovalFileSha256 = hash(input.artifacts.verificationApprovalBytes);
    const { receiptSha256: _hash, ...receipt } = input.receipt;
    input.artifacts.verificationReceiptBytes = bytes(finalizePostgresMigrationReceipt({ ...receipt, verificationApprovalFileSha256: input.expected.verificationApprovalFileSha256 }));
    input.expected.verificationReceiptFileSha256 = hash(input.artifacts.verificationReceiptBytes);
    expect(() => assertBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
  });

  it("never accepts a private signing key as the metadata public-key file", () => {
    const input = fixture();
    input.artifacts.verifierPublicKeyBytes = Buffer.from(input.signingKey.export({ format: "pem", type: "pkcs8" }));
    input.expected.verifierPublicKeySha256 = hash(input.artifacts.verifierPublicKeyBytes);
    const payload = { ...input.approval.payload, verifierPublicKeySha256: input.expected.verifierPublicKeySha256 };
    input.artifacts.verificationApprovalBytes = bytes({ ...input.approval, payload,
      signatureBase64: crypto.sign(null, bytes(payload), input.signingKey).toString("base64") });
    input.expected.verificationApprovalFileSha256 = hash(input.artifacts.verificationApprovalBytes);
    const { receiptSha256: _hash, ...receipt } = input.receipt;
    input.artifacts.verificationReceiptBytes = bytes(finalizePostgresMigrationReceipt({ ...receipt,
      verifierPublicKeySha256: input.expected.verifierPublicKeySha256,
      verificationApprovalFileSha256: input.expected.verificationApprovalFileSha256 }));
    input.expected.verificationReceiptFileSha256 = hash(input.artifacts.verificationReceiptBytes);
    expect(() => assertBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
  });

  it.each(["candidateSha", "targetUrlSha256", "targetIdentitySha256", "verifierPublicKeySha256", "verifierAuthoritySha256"] as const)(
    "rejects a different pinned %s", key => {
      const input = fixture(); input.expected[key] = "b".repeat(key === "candidateSha" ? 40 : 64);
      expect(() => assertBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
    },
  );

  it("rejects staging receipts even with their matching self hashes", () => {
    const input = fixture(); const { receiptSha256: _hash, ...receipt } = input.receipt;
    input.artifacts.verificationReceiptBytes = bytes(finalizePostgresMigrationReceipt({ ...receipt, expectedEnvironment: "permanent-staging" }));
    input.expected.verificationReceiptFileSha256 = hash(input.artifacts.verificationReceiptBytes);
    expect(() => assertBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
  });

  it("rejects duplicate JSON keys even when the exact noncanonical file hash is supplied", () => {
    const input = fixture(); input.artifacts.snapshotManifestBytes = Buffer.from(input.artifacts.snapshotManifestBytes.toString().replace('{', '{"candidateSha":"discarded",'));
    input.expected.snapshotManifestFileSha256 = hash(input.artifacts.snapshotManifestBytes);
    expect(() => assertBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
  });
});

describe("private production migration artifact custody", () => {
  function custody() {
    const input = fixture();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-production-import-test-")));
    temporaryDirectories.push(root);
    const evidence = path.join(root, "production-migration-evidence");
    const authority = path.join(root, "production-migration-authority");
    fs.mkdirSync(evidence, { mode: 0o700 }); fs.mkdirSync(authority, { mode: 0o700 });
    const files = { "snapshot-manifest.json": input.artifacts.snapshotManifestBytes,
      "apply-receipt.json": input.artifacts.applyReceiptBytes, "verification-receipt.json": input.artifacts.verificationReceiptBytes,
      "verification-approval.json": input.artifacts.verificationApprovalBytes, "verifier-public-key.pem": input.artifacts.verifierPublicKeyBytes,
      "target-identity.json": input.artifacts.targetIdentityBytes };
    for (const [leaf, content] of Object.entries(files)) fs.writeFileSync(path.join(evidence, leaf), content, { mode: 0o600 });
    const pinsFile = path.join(authority, "pins.json");
    fs.writeFileSync(pinsFile, bytes(input.expected), { mode: 0o600 });
    const env = { RUNNER_TEMP: root, PINTPATH_PRODUCTION_MIGRATION_EVIDENCE_DIR: evidence,
      PINTPATH_PRODUCTION_MIGRATION_PINS_FILE: pinsFile,
      PINTPATH_PRODUCTION_MIGRATION_PINS_SHA256: hash(bytes(input.expected)) };
    return { ...input, env, root, evidence, authority, pinsFile, candidateSha };
  }

  it("loads authentic native files with separate protected pins and reasserts before upload", () => {
    const input = custody(); const held = loadBarPilotProductionMigrationEvidence(input);
    try {
      expect(held.binding).toMatchObject({ candidateSha, pinsFileSha256: input.env.PINTPATH_PRODUCTION_MIGRATION_PINS_SHA256,
        sourceSnapshotSha256: input.receipt.sourceSnapshotSha256, targetIdentitySha256: input.receipt.targetIdentitySha256 });
      expect(() => held.reassert(now)).not.toThrow();
    } finally { held.close(); }
    expect(() => held.reassert(now)).toThrow(/migration evidence/);
  });

  it("requires independently supplied pin authority, not self-computed artifact hashes", () => {
    const input = custody(); input.env.PINTPATH_PRODUCTION_MIGRATION_PINS_SHA256 = "";
    expect(() => loadBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
  });

  it("rejects an authentic import for another deployment candidate", () => {
    const input = custody(); input.candidateSha = "b".repeat(40);
    expect(() => loadBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
  });

  it.each(["snapshot-manifest.json", "verification-approval.json", "target-identity.json"])(
    "rejects %s replacement before the provider write", leaf => {
      const input = custody(); const held = loadBarPilotProductionMigrationEvidence(input);
      try {
        fs.writeFileSync(path.join(input.evidence, leaf), "PRIVATE_CHANGED_VALUE");
        expect(() => held.reassert(now)).toThrow("Production migration evidence is missing, inconsistent, or unauthorised.");
      } finally { held.close(); }
    },
  );

  it("rejects a valid-looking replacement of the held evidence directory", () => {
    const input = custody(); const held = loadBarPilotProductionMigrationEvidence(input);
    try {
      fs.renameSync(input.evidence, `${input.evidence}-old`);
      fs.cpSync(`${input.evidence}-old`, input.evidence, { recursive: true });
      expect(() => held.reassert(now)).toThrow(/migration evidence/);
    } finally { held.close(); }
  });

  it("rejects symlinked, hardlinked and publicly readable evidence files", () => {
    const input = custody(); const source = path.join(input.evidence, "apply-receipt.json");
    const outside = path.join(input.root, "outside.json"); fs.renameSync(source, outside);
    fs.symlinkSync(outside, source);
    expect(() => loadBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
    fs.unlinkSync(source); fs.linkSync(outside, source);
    expect(() => loadBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
    fs.unlinkSync(source); fs.renameSync(outside, source); fs.chmodSync(source, 0o644);
    expect(() => loadBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
  });

  it("rejects public authority directories and altered protected pins", () => {
    const input = custody(); fs.chmodSync(input.authority, 0o755);
    expect(() => loadBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
    fs.chmodSync(input.authority, 0o700);
    fs.writeFileSync(input.pinsFile, bytes({ ...input.expected, targetUrlSha256: sha("different-url") }));
    expect(() => loadBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
  });
});

describe("bounded protected native metadata materialization", () => {
  function protectedInputs() {
    const input = fixture();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-production-materialize-test-")));
    temporaryDirectories.push(root);
    const env: Record<string, string> = {
      RUNNER_TEMP: root,
      PINTPATH_PRODUCTION_MIGRATION_EVIDENCE_DIR: path.join(root, "production-migration-evidence"),
      PINTPATH_PRODUCTION_MIGRATION_PINS_FILE: path.join(root, "production-migration-authority", "pins.json"),
      PINTPATH_PRODUCTION_MIGRATION_PINS_BASE64: bytes(input.expected).toString("base64"),
      PINTPATH_PRODUCTION_MIGRATION_PINS_SHA256: hash(bytes(input.expected)),
    };
    const sources = {
      SNAPSHOT_MANIFEST: input.artifacts.snapshotManifestBytes, APPLY_RECEIPT: input.artifacts.applyReceiptBytes,
      VERIFICATION_RECEIPT: input.artifacts.verificationReceiptBytes, VERIFICATION_APPROVAL: input.artifacts.verificationApprovalBytes,
      VERIFIER_PUBLIC_KEY: input.artifacts.verifierPublicKeyBytes, TARGET_IDENTITY: input.artifacts.targetIdentityBytes,
    };
    for (const [name, content] of Object.entries(sources)) env[`PINTPATH_PRODUCTION_MIGRATION_${name}_GZIP_BASE64`] = gzipSync(content).toString("base64");
    return { ...input, env, root, candidateSha };
  }

  it("materializes only the six native files and separately pinned authority with private custody", () => {
    const input = protectedInputs();
    const binding = materializeBarPilotProductionMigrationEvidence(input);
    expect(binding.verificationReceiptFileSha256).toBe(input.expected.verificationReceiptFileSha256);
    const directory = input.env.PINTPATH_PRODUCTION_MIGRATION_EVIDENCE_DIR!;
    expect(fs.readdirSync(directory).sort()).toEqual(["apply-receipt.json", "snapshot-manifest.json", "target-identity.json",
      "verification-approval.json", "verification-receipt.json", "verifier-public-key.pem"]);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    for (const leaf of fs.readdirSync(directory)) expect(fs.statSync(path.join(directory, leaf)).mode & 0o777).toBe(0o600);
    const held = loadBarPilotProductionMigrationEvidence(input);
    try { expect(() => held.reassert(now)).not.toThrow(); } finally { held.close(); }
    expect(() => materializeBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
  });

  it.each(["", "not-base64", "A".repeat(48 * 1024 + 4), Buffer.from("not-gzip").toString("base64")])(
    "rejects absent, malformed, oversized or non-gzip protected input before materialization", value => {
      const input = protectedInputs(); input.env.PINTPATH_PRODUCTION_MIGRATION_APPLY_RECEIPT_GZIP_BASE64 = value;
      expect(() => materializeBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
      expect(fs.readdirSync(input.root)).toEqual([]);
    },
  );

  it("bounds gzip expansion rather than trusting a small compressed input", () => {
    const input = protectedInputs();
    input.env.PINTPATH_PRODUCTION_MIGRATION_SNAPSHOT_MANIFEST_GZIP_BASE64 = gzipSync(Buffer.alloc(1024 * 1024 + 1)).toString("base64");
    expect(() => materializeBarPilotProductionMigrationEvidence(input)).toThrow(/migration evidence/);
    expect(fs.readdirSync(input.root)).toEqual([]);
  });

  it("rejects non-native or unsigned content before writing, even inside valid gzip", () => {
    const input = protectedInputs();
    input.env.PINTPATH_PRODUCTION_MIGRATION_APPLY_RECEIPT_GZIP_BASE64 = gzipSync(Buffer.from("SQLite format 3\0PRIVATE_ROWS")).toString("base64");
    expect(() => materializeBarPilotProductionMigrationEvidence(input)).toThrow("Production migration evidence is missing, inconsistent, or unauthorised.");
    expect(fs.readdirSync(input.root)).toEqual([]);
  });

  it("keeps materialization and the independent pins inside the existing protected source workflow", () => {
    const workflow = fs.readFileSync(new URL("../.github/workflows/deploy-production.yml", import.meta.url), "utf8");
    const materialize = workflow.indexOf("- name: Materialize and verify independently pinned native production import evidence");
    const upload = workflow.indexOf("- name: Execute one protected production source upload and reconcile it");
    expect(materialize).toBeGreaterThan(0); expect(materialize).toBeLessThan(upload);
    expect(workflow.slice(materialize, upload)).toContain("secrets.PINTPATH_PRODUCTION_MIGRATION_PINS_SHA256");
    expect(workflow.slice(upload)).toContain("secrets.PINTPATH_PRODUCTION_MIGRATION_PINS_SHA256");
    expect(workflow).toContain("scripts/materialize-bar-pilot-production-migration-evidence.ts");
    expect(workflow).toContain("- name: Remove private native migration input custody\n        if: always()");
  });
});

describe("live imported runtime gate", () => {
  function databaseFixture(input: ReturnType<typeof fixture>) {
    const statements: string[] = [];
    const current = { ...input.targetIdentity, readOnly: "on" };
    const rows = Object.entries(input.metadata).map(([key, value]) => ({ key, value }));
    const database = { dialect: "postgres", transaction: (work: () => Promise<unknown>) => work,
      prepare: (sql: string) => { statements.push(sql); return { run: async () => ({ changes: 0 }), get: async () => current, all: async () => rows }; },
    } as unknown as SqlDatabase;
    vi.spyOn(runtime, "checkPostgresRuntimeReadiness").mockResolvedValue({ ready: true, failures: [] } as never);
    return { database, current, rows, statements };
  }

  it("checks the actual runtime in a read-only transaction and exactly binds import metadata", async () => {
    const input = fixture(); const db = databaseFixture(input);
    await assertBarPilotProductionLiveImport({ ...input, database: db.database });
    expect(db.statements[0]).toBe("SET TRANSACTION READ ONLY");
    expect(runtime.checkPostgresRuntimeReadiness).toHaveBeenCalledWith(db.database);
    expect(db.statements).toHaveLength(3);
    expect(db.statements.some(sql => /INSERT|UPDATE|DELETE|ALTER|DROP/.test(sql))).toBe(false);
  });

  it("rejects a ready-looking database with a different imported source", async () => {
    const input = fixture(); const db = databaseFixture(input);
    db.rows.find(row => row.key === "source_snapshot_sha256")!.value = sha("other-source");
    await expect(assertBarPilotProductionLiveImport({ ...input, database: db.database })).rejects.toThrow(/runtime does not match/);
  });

  it("rejects a database with the same name but a different OID", async () => {
    const input = fixture(); const db = databaseFixture(input); db.current.databaseOid = "54321";
    await expect(assertBarPilotProductionLiveImport({ ...input, database: db.database })).rejects.toThrow(/runtime does not match/);
  });

  it("rejects failed native runtime authorisation/readiness", async () => {
    const input = fixture(); const db = databaseFixture(input);
    vi.mocked(runtime.checkPostgresRuntimeReadiness).mockResolvedValue({ ready: false, failures: ["runtime_role_unsafe"] } as never);
    await expect(assertBarPilotProductionLiveImport({ ...input, database: db.database })).rejects.toThrow(/runtime does not match/);
  });
});
