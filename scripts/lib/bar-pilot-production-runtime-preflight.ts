import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  postgresMigrationReadyMetadataSchema,
  postgresMigrationApplyReceiptSchema,
  postgresMigrationReceiptSchema,
  postgresMigrationTargetIdentitySchema,
  sha256PostgresMigrationReadyMetadata,
  sha256PostgresMigrationTargetIdentity,
  verifyPostgresMigrationVerificationApproval,
  type PostgresMigrationReceipt,
  type PostgresMigrationTargetIdentity,
} from "../../src/db/postgres-migration-receipt.js";
import { postgresMigrationSourceInternals } from "../../src/db/postgres-migration-source.js";
import {
  serializeCanonicalPostgresMigrationJson,
  sha256PostgresMigrationBytes,
} from "../../src/db/postgres-migration-schema.js";
import { checkPostgresRuntimeReadiness } from "../../src/db/postgres-runtime.js";
import type { SqlDatabase } from "../../src/db/sql-database.js";
import { holdPrivateDirectoryIdentity, readTrustedRegularFile, writePrivateExclusiveFile,
  type HeldPrivateDirectoryIdentity } from "./trusted-filesystem.js";

/** These hashes come from independently approved custody, never from the supplied files. */
export interface BarPilotProductionMigrationPins {
  candidateSha: string;
  snapshotManifestFileSha256: string;
  applyReceiptFileSha256: string;
  verificationReceiptFileSha256: string;
  verificationApprovalFileSha256: string;
  verifierPublicKeySha256: string;
  targetIdentitySha256: string;
  targetUrlSha256: string;
  transportAuthoritySha256: string;
  targetDdlSha256: string;
  liveSchemaSha256: string;
  verifierAuthoritySha256: string;
  verifierAuthorityPolicySha256: string;
}

export interface BarPilotProductionMigrationArtifacts {
  snapshotManifestBytes: Buffer;
  applyReceiptBytes: Buffer;
  verificationReceiptBytes: Buffer;
  verificationApprovalBytes: Buffer;
  verifierPublicKeyBytes: Buffer;
  targetIdentityBytes: Buffer;
}

const migrationArtifactFiles = {
  snapshotManifestBytes: "snapshot-manifest.json",
  applyReceiptBytes: "apply-receipt.json",
  verificationReceiptBytes: "verification-receipt.json",
  verificationApprovalBytes: "verification-approval.json",
  verifierPublicKeyBytes: "verifier-public-key.pem",
  targetIdentityBytes: "target-identity.json",
} as const;

const migrationHashPins = ["snapshotManifestFileSha256", "applyReceiptFileSha256", "verificationReceiptFileSha256",
  "verificationApprovalFileSha256", "verifierPublicKeySha256", "targetIdentitySha256", "targetUrlSha256",
  "transportAuthoritySha256", "targetDdlSha256", "liveSchemaSha256", "verifierAuthoritySha256",
  "verifierAuthorityPolicySha256"] as const;

const migrationSecretInputs = {
  snapshotManifestBytes: "PINTPATH_PRODUCTION_MIGRATION_SNAPSHOT_MANIFEST_GZIP_BASE64",
  applyReceiptBytes: "PINTPATH_PRODUCTION_MIGRATION_APPLY_RECEIPT_GZIP_BASE64",
  verificationReceiptBytes: "PINTPATH_PRODUCTION_MIGRATION_VERIFICATION_RECEIPT_GZIP_BASE64",
  verificationApprovalBytes: "PINTPATH_PRODUCTION_MIGRATION_VERIFICATION_APPROVAL_GZIP_BASE64",
  verifierPublicKeyBytes: "PINTPATH_PRODUCTION_MIGRATION_VERIFIER_PUBLIC_KEY_GZIP_BASE64",
  targetIdentityBytes: "PINTPATH_PRODUCTION_MIGRATION_TARGET_IDENTITY_GZIP_BASE64",
} as const;

export interface BarPilotProductionMigrationBinding {
  readonly candidateSha: string;
  readonly pinsFileSha256: string;
  readonly verificationReceiptFileSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly targetIdentitySha256: string;
  readonly targetUrlSha256: string;
  readonly transportAuthoritySha256: string;
}

export class BarPilotProductionRuntimePreflightError extends Error {
  constructor(readonly code: "migration_evidence_invalid" | "runtime_import_not_ready") {
    super(code === "migration_evidence_invalid"
      ? "Production migration evidence is missing, inconsistent, or unauthorised."
      : "The production runtime does not match the independently verified import.");
    this.name = "BarPilotProductionRuntimePreflightError";
  }
}

function canonicalJson(bytes: Buffer, expectedHash?: string): unknown {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 1024 * 1024
    || expectedHash !== undefined && sha256PostgresMigrationBytes(bytes) !== expectedHash) {
    throw new Error("artifact");
  }
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  // Reject duplicate keys, alternate encodings and unexpected trailing content.
  if (!bytes.equals(serializeCanonicalPostgresMigrationJson(value))) throw new Error("canonical");
  return value;
}

function parsePins(bytes: Buffer, expectedHash: string, candidateSha: string): BarPilotProductionMigrationPins {
  const pins = canonicalJson(bytes, expectedHash);
  if (!pins || typeof pins !== "object" || Array.isArray(pins)
    || Object.keys(pins).sort().join("\n") !== ["candidateSha", ...migrationHashPins].sort().join("\n")) {
    throw new Error("pins");
  }
  const expected = pins as BarPilotProductionMigrationPins;
  if (expected.candidateSha !== candidateSha) throw new Error("candidate");
  return expected;
}

function privateMigrationPaths(env: Readonly<Record<string, string | undefined>>) {
  const root = env.RUNNER_TEMP;
  if (!root || !path.isAbsolute(root) || path.resolve(root) !== root) throw new Error("path");
  const evidenceDir = path.join(root, "production-migration-evidence");
  const authorityDir = path.join(root, "production-migration-authority");
  const pinsFile = path.join(authorityDir, "pins.json");
  const pinsHash = env.PINTPATH_PRODUCTION_MIGRATION_PINS_SHA256;
  if (env.PINTPATH_PRODUCTION_MIGRATION_EVIDENCE_DIR !== evidenceDir
    || env.PINTPATH_PRODUCTION_MIGRATION_PINS_FILE !== pinsFile
    || !pinsHash || !/^[a-f0-9]{64}$/.test(pinsHash)) throw new Error("authority");
  return { root, evidenceDir, authorityDir, pinsFile, pinsHash };
}

/** Materializes six native metadata files only; no archive extraction or row payload channel. */
export function materializeBarPilotProductionMigrationEvidence(input: {
  env: Readonly<Record<string, string | undefined>>;
  candidateSha: string;
  now: Date;
}): BarPilotProductionMigrationBinding {
  try {
    const paths = privateMigrationPaths(input.env);
    if (fs.realpathSync(paths.root) !== paths.root) throw new Error("path");
    const decode = (source: string | undefined): Buffer => {
      if (!source || source.length > 48 * 1024 || source.length % 4 !== 0
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(source)) throw new Error("input");
      const result = Buffer.from(source, "base64");
      if (result.toString("base64") !== source) throw new Error("encoding");
      return result;
    };
    const pinsBytes = decode(input.env.PINTPATH_PRODUCTION_MIGRATION_PINS_BASE64);
    const expected = parsePins(pinsBytes, paths.pinsHash, input.candidateSha);
    const artifacts = Object.fromEntries(Object.entries(migrationSecretInputs).map(([key, name]) =>
      [key, gunzipSync(decode(input.env[name]), { maxOutputLength: 1024 * 1024 })])) as unknown as BarPilotProductionMigrationArtifacts;
    // Validate strict native schemas and signatures before writing any input.
    assertBarPilotProductionMigrationEvidence({ artifacts, expected, now: input.now });
    for (const directory of [paths.authorityDir, paths.evidenceDir]) fs.mkdirSync(directory, { mode: 0o700 });
    const options = { requireExactDirectoryMode: true, requireOwner: true };
    writePrivateExclusiveFile(paths.authorityDir, "pins.json", pinsBytes, options);
    for (const [key, leaf] of Object.entries(migrationArtifactFiles)) {
      writePrivateExclusiveFile(paths.evidenceDir, leaf, artifacts[key as keyof BarPilotProductionMigrationArtifacts], options);
    }
    const held = loadBarPilotProductionMigrationEvidence(input);
    try { return held.binding; } finally { held.close(); }
  } catch {
    throw new BarPilotProductionRuntimePreflightError("migration_evidence_invalid");
  }
}

/**
 * Reuses the actual importer contracts. It neither invents a cutover receipt nor
 * treats a staging import, an unsigned success flag, or a backup as production data.
 * Call again on freshly read held files immediately before a configuration write.
 */
export function assertBarPilotProductionMigrationEvidence(input: {
  artifacts: BarPilotProductionMigrationArtifacts;
  expected: BarPilotProductionMigrationPins;
  now: Date;
}): { receipt: PostgresMigrationReceipt; targetIdentity: PostgresMigrationTargetIdentity } {
  try {
    const { artifacts, expected } = input;
    if (!/^[a-f0-9]{40}$/.test(expected.candidateSha)
      || !Number.isFinite(input.now.getTime())
      || migrationHashPins.some(key => typeof expected[key] !== "string" || !/^[a-f0-9]{64}$/.test(expected[key]))) {
      throw new Error("pins");
    }
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(
      artifacts.verifierPublicKeyBytes.toString("utf8"),
    )) throw new Error("public-key-only");
    const manifest = postgresMigrationSourceInternals.normalizeSnapshotManifest(
      canonicalJson(artifacts.snapshotManifestBytes, expected.snapshotManifestFileSha256),
    );
    const apply = postgresMigrationApplyReceiptSchema.parse(
      canonicalJson(artifacts.applyReceiptBytes, expected.applyReceiptFileSha256),
    );
    const receipt = postgresMigrationReceiptSchema.parse(
      canonicalJson(artifacts.verificationReceiptBytes, expected.verificationReceiptFileSha256),
    );
    const targetIdentity = postgresMigrationTargetIdentitySchema.parse(canonicalJson(artifacts.targetIdentityBytes));
    if (sha256PostgresMigrationTargetIdentity(targetIdentity) !== expected.targetIdentitySha256
      || targetIdentity.currentUser !== "pintpath_migrator"
      || !/^17\d{4}$/.test(targetIdentity.serverVersionNum)
      || apply.expectedEnvironment !== "production" || receipt.expectedEnvironment !== "production"
      || receipt.candidateSha !== expected.candidateSha || manifest.candidateSha !== expected.candidateSha
      || receipt.manifestSha256 !== expected.snapshotManifestFileSha256
      || receipt.applyReceiptSha256 !== apply.receiptSha256
      || receipt.verificationApprovalFileSha256 !== expected.verificationApprovalFileSha256
      || receipt.operatorIdSha256 === receipt.verifierIdSha256
      || Date.parse(manifest.capturedAt) > Date.parse(receipt.verifiedAt)
      || Date.parse(receipt.verifiedAt) > input.now.getTime()) throw new Error("binding");

    // Every shared reconciliation field must agree, including counts, keys,
    // state totals and the source/target/authority commitments.
    for (const [key, value] of Object.entries(apply)) {
      if (key !== "status" && key !== "receiptSha256"
        && receipt[key as keyof PostgresMigrationReceipt] !== value) throw new Error("reconciliation");
    }
    const authorityPins = ["targetIdentitySha256", "targetUrlSha256", "transportAuthoritySha256",
      "targetDdlSha256", "liveSchemaSha256", "verifierPublicKeySha256", "verifierAuthoritySha256",
      "verifierAuthorityPolicySha256"] as const;
    if (authorityPins.some(key => receipt[key] !== expected[key])
      || receipt.sourceSnapshotSha256 !== manifest.database.sha256
      || receipt.sourceSchemaFingerprint !== manifest.schema.fingerprint
      || receipt.contractSha256 !== manifest.contractSha256
      || receipt.operatorIdSha256 !== manifest.operatorIdSha256
      || receipt.tableCount !== manifest.schema.counts.tables
      || receipt.columnCount !== manifest.schema.counts.columns
      || receipt.foreignKeyCount !== manifest.schema.counts.foreignKeys) throw new Error("source");

    verifyPostgresMigrationVerificationApproval({
      approval: canonicalJson(artifacts.verificationApprovalBytes, expected.verificationApprovalFileSha256),
      approvalFileSha256: expected.verificationApprovalFileSha256,
      expectedApprovalFileSha256: expected.verificationApprovalFileSha256,
      applyReceipt: apply,
      expectedVerifierPublicKeySha256: expected.verifierPublicKeySha256,
      expectedVerifierAuthoritySha256: expected.verifierAuthoritySha256,
      expectedVerifierAuthorityPolicySha256: expected.verifierAuthorityPolicySha256,
      verifierPublicKeyBytes: artifacts.verifierPublicKeyBytes,
      // Approval authorises the independently verified import event, not a later
      // upload. Its historical validity is checked at that event's timestamp.
      now: new Date(receipt.verifiedAt),
    });
    return { receipt, targetIdentity };
  } catch {
    throw new BarPilotProductionRuntimePreflightError("migration_evidence_invalid");
  }
}

/**
 * Loads native evidence from private job inputs. The pins digest must originate
 * in the independently protected workflow environment, never in the artifact
 * being checked. The deployment consumer separately binds its current run and
 * exact reviewed candidate before calling this loader.
 */
export function loadBarPilotProductionMigrationEvidence(input: {
  env: Readonly<Record<string, string | undefined>>;
  candidateSha: string;
  now: Date;
}): { binding: BarPilotProductionMigrationBinding;
  proof: Readonly<{ receipt: PostgresMigrationReceipt; targetIdentity: PostgresMigrationTargetIdentity }>;
  reassert(now?: Date): void; close(): void } {
  const directories: HeldPrivateDirectoryIdentity[] = [];
  try {
    const { evidenceDir, authorityDir, pinsFile, pinsHash } = privateMigrationPaths(input.env);
    for (const directory of [evidenceDir, authorityDir]) {
      directories.push(holdPrivateDirectoryIdentity(directory, { requireExactDirectoryMode: true, requireOwner: true }));
    }
    let closed = false;
    const read = (now: Date) => {
      if (closed) throw new Error("closed");
      for (const directory of directories) directory.assertExact();
      const options = { minBytes: 2, maxBytes: 1024 * 1024,
        requireExactMode: 0o600, requireOwner: true, requirePrivate: true };
      const expected = parsePins(readTrustedRegularFile(pinsFile, options), pinsHash, input.candidateSha);
      const artifacts = Object.fromEntries(Object.entries(migrationArtifactFiles).map(([key, leaf]) =>
        [key, readTrustedRegularFile(path.join(evidenceDir, leaf), options)])) as unknown as BarPilotProductionMigrationArtifacts;
      const result = assertBarPilotProductionMigrationEvidence({ artifacts, expected, now });
      for (const directory of directories) directory.assertExact();
      return { ...result, expected };
    };
    const initial = read(input.now);
    const binding = Object.freeze({ candidateSha: initial.receipt.candidateSha, pinsFileSha256: pinsHash,
      verificationReceiptFileSha256: initial.expected.verificationReceiptFileSha256,
      sourceSnapshotSha256: initial.receipt.sourceSnapshotSha256,
      targetIdentitySha256: initial.receipt.targetIdentitySha256,
      targetUrlSha256: initial.receipt.targetUrlSha256,
      transportAuthoritySha256: initial.receipt.transportAuthoritySha256 });
    return {
      binding,
      proof: Object.freeze({ receipt: Object.freeze(initial.receipt), targetIdentity: Object.freeze(initial.targetIdentity) }),
      reassert(now = new Date()): void {
        try { read(now); } catch { throw new BarPilotProductionRuntimePreflightError("migration_evidence_invalid"); }
      },
      close(): void {
        if (closed) return;
        closed = true;
        for (const directory of directories) directory.close();
      },
    };
  } catch {
    for (const directory of directories) directory.close();
    throw new BarPilotProductionRuntimePreflightError("migration_evidence_invalid");
  }
}

/**
 * Run on the approved private network using the intended restricted runtime
 * connection and its existing exact TLS transport. This read-only transaction
 * must complete before changing the application's connection. The caller owns
 * transport assertions, provider/resource/URL pins and file-custody assertions.
 */
export async function assertBarPilotProductionLiveImport(input: {
  database: SqlDatabase;
  receipt: PostgresMigrationReceipt;
  targetIdentity: PostgresMigrationTargetIdentity;
}): Promise<void> {
  try {
    const receipt = postgresMigrationReceiptSchema.parse(input.receipt);
    const target = postgresMigrationTargetIdentitySchema.parse(input.targetIdentity);
    if (receipt.expectedEnvironment !== "production"
      || sha256PostgresMigrationTargetIdentity(target) !== receipt.targetIdentitySha256
      || input.database.dialect !== "postgres") throw new Error("target");
    await input.database.transaction(async () => {
      await input.database.prepare("SET TRANSACTION READ ONLY").run();
      const readiness = await checkPostgresRuntimeReadiness(input.database);
      if (!readiness.ready || readiness.failures.length) throw new Error("readiness");
      const current = await input.database.prepare(`SELECT current_database() AS "databaseName",
        (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS "databaseOid",
        current_setting('server_version_num') AS "serverVersionNum",
        current_setting('transaction_read_only') AS "readOnly"`).get<{
          databaseName: string; databaseOid: string; serverVersionNum: string; readOnly: string;
        }>();
      if (!current || current.databaseName !== target.databaseName || current.databaseOid !== target.databaseOid
        || current.serverVersionNum !== target.serverVersionNum || current.readOnly !== "on") throw new Error("identity");
      const rows = await input.database.prepare(`SELECT key, value FROM pintpath_app.schema_metadata
        WHERE key IN ('import_state','migration_candidate_sha','migration_contract_sha256',
        'migration_manifest_sha256','migration_plan_sha256','migration_run_sha256',
        'source_schema_fingerprint','source_schema_version','source_snapshot_sha256',
        'target_ddl_sha256','live_schema_sha256') ORDER BY key`).all<{ key: string; value: string }>();
      const metadata = postgresMigrationReadyMetadataSchema.parse(Object.fromEntries(rows.map(row => [row.key, row.value])));
      if (rows.length !== Object.keys(metadata).length
        || sha256PostgresMigrationReadyMetadata(metadata) !== receipt.schemaMetadataSha256
        || metadata.migration_candidate_sha !== receipt.candidateSha
        || metadata.migration_manifest_sha256 !== receipt.manifestSha256
        || metadata.source_snapshot_sha256 !== receipt.sourceSnapshotSha256
        || metadata.migration_run_sha256 !== receipt.runIdSha256
        || metadata.target_ddl_sha256 !== receipt.targetDdlSha256
        || metadata.live_schema_sha256 !== receipt.liveSchemaSha256) throw new Error("metadata");
    })();
  } catch {
    throw new BarPilotProductionRuntimePreflightError("runtime_import_not_ready");
  }
}
