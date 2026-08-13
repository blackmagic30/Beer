import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const cliRuntimeState = vi.hoisted(() => ({
  dependencies: null as PostgresReviewedPricePromotionCliDependencies | null,
}));

vi.mock("../scripts/lib/postgres-reviewed-price-promotion-runtime.js", () => ({
  POSTGRES_REVIEWED_PRICE_PROMOTION_RUNTIME: Object.freeze({
    get assertPublicationBoundary() {
      return cliRuntimeState.dependencies?.assertPublicationBoundary;
    },
    get releasePublishedArtifactHandle() {
      return cliRuntimeState.dependencies?.releasePublishedArtifactHandle;
    },
    openDatabase: (options: unknown) => {
      if (!cliRuntimeState.dependencies?.openDatabase) {
        throw new Error("test_runtime_not_configured");
      }
      return cliRuntimeState.dependencies.openDatabase(options as never);
    },
    buildPlan: (input: unknown) => {
      if (!cliRuntimeState.dependencies?.buildPlan) {
        throw new Error("test_runtime_not_configured");
      }
      return cliRuntimeState.dependencies.buildPlan(input as never);
    },
    get environment() {
      return cliRuntimeState.dependencies?.environment ?? {};
    },
    get expectedRootCaDerSha256() {
      return cliRuntimeState.dependencies?.expectedRootCaDerSha256 ?? "";
    },
    now: () => {
      if (!cliRuntimeState.dependencies?.now) {
        throw new Error("test_runtime_not_configured");
      }
      return cliRuntimeState.dependencies.now();
    },
    writeOutput: (value: string) => {
      if (!cliRuntimeState.dependencies?.writeOutput) {
        throw new Error("test_runtime_not_configured");
      }
      cliRuntimeState.dependencies.writeOutput(value);
    },
  }),
}));

import {
  openRailwayPlannerDatabase,
  POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND,
  postgresReviewedPricePromotionCliInternals,
  runPostgresReviewedPricePromotionCli,
  type PostgresReviewedPricePromotionCliDependencies,
} from "../scripts/postgres-reviewed-price-promotion.js";
import {
  derivePostgresMigrationRunId,
  finalizePostgresMigrationReceipt,
  sha256PostgresMigrationRunBinding,
  sha256PostgresMigrationTargetIdentity,
  type PostgresMigrationTargetIdentity,
  type PostgresMigrationReceipt,
} from "../src/db/postgres-migration-receipt.js";
import { POSTGRES_MIGRATION_CONTRACT } from
  "../src/db/postgres-migration-contract.js";
import {
  sha256PostgresMigrationBytes,
  sha256PostgresMigrationContract,
} from
  "../src/db/postgres-migration-schema.js";
import type { SqlDatabase } from "../src/db/sql-database.js";
import { sha256PostgresDatabaseIdentity } from
  "../src/lib/postgres-database-identity.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_VERSION,
  POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_MODE,
  POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_MODE,
  POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_VERSION,
  finalizePostgresReviewedPricePromotionReviewPacket,
  type PostgresReviewedPricePromotionAuthorityBundle,
  type PostgresReviewedPricePromotionReviewPacket,
} from "../src/lib/postgres-reviewed-price-promotion-authority.js";
import {
  RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SHA256,
  buildRailwayApplicationDeploymentAttestationReceipt,
  canonicalRailwayApplicationDeploymentAttestationReceipt,
  type RailwayApplicationDeploymentAttestationEvaluation,
  type RailwayApplicationDeploymentAttestationReceipt,
} from "../src/lib/railway-application-deployment-attestation.js";
import {
  POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS,
  POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_PRIVATE_INPUT_KIND,
  POSTGRES_REVIEWED_PRICE_PROMOTION_SOURCE_SCHEMA_SHA256,
  POSTGRES_REVIEWED_PRICE_PROMOTION_IDENTITY_QUERY,
  PostgresReviewedPricePromotionPlanError,
  canonicalPostgresReviewedPricePromotionJson,
  sha256PostgresReviewedPricePromotionIdentity,
  sha256PostgresReviewedPricePromotionValue,
  type PostgresReviewedPricePromotionPlanCandidate,
  type PostgresReviewedPricePromotionPlanArtifacts,
  type PostgresReviewedPricePromotionPrivateInput,
} from "../src/lib/postgres-reviewed-price-promotion-plan.js";
import { REVIEWED_PRICE_SELECTION_POLICY_SHA256 } from
  "../src/lib/reviewed-price-selection-policy.js";
import { REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256 } from
  "../src/lib/reviewed-price-wrong-price-policy.js";

const CANDIDATE_SHA = "c".repeat(40);
const HASH = "a".repeat(64);
const INGESTION_ID = "11111111-1111-4111-8111-111111111111";
const PLANNER_PASSWORD = "PRIVATE_PLANNER_PASSWORD";
const NOW = "2026-08-08T00:00:00.000Z";
const ATTESTATION_STARTED_AT = "2026-08-07T23:59:59.000Z";
const ATTESTATION_EXPIRES_AT = "2026-08-08T00:15:00.000Z";
const AUTHORITY_EXPIRES_AT = "2026-08-08T00:10:00.000Z";

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
const TEST_ROOT_CA_DER_SHA256 = crypto.createHash("sha256")
  .update(new crypto.X509Certificate(TEST_ROOT_CA_PEM).raw)
  .digest("hex");

function plannerUrl(rootCaPath: string): string {
  const search = new URLSearchParams([
    ["sslmode", "verify-full"],
    ["sslrootcert", rootCaPath],
  ]).toString();
  return `postgresql://pintpath_reviewed_price_planner:${PLANNER_PASSWORD}`
    + "@postgres-staging.railway.internal:5432/pintpath_staging"
    + `?${search}`;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  cliRuntimeState.dependencies = null;
  vi.restoreAllMocks();
});

function sha256(bytes: string | Buffer): string {
  return sha256PostgresMigrationBytes(bytes);
}

function canonicalRoot(): string {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "pintpath-postgres-plan-cli-"),
  );
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function writePrivate(filename: string, bytes: Buffer | string): void {
  fs.writeFileSync(filename, bytes, { flag: "wx", mode: 0o600 });
  fs.chmodSync(filename, 0o600);
}

function rewritePrivate(filename: string, bytes: Buffer | string): void {
  fs.unlinkSync(filename);
  writePrivate(filename, bytes);
}

class StubPlannerPgClient {}

function setArgument(argv: readonly string[], name: string, value: string): string[] {
  const result = [...argv];
  const index = result.indexOf(name);
  if (index < 0) throw new Error(`missing ${name}`);
  result[index + 1] = value;
  return result;
}

function plannerDatabaseOptions(rootCaFile: string) {
  return {
    applicationName: "pintpath-reviewed-price-promotion-planner" as const,
    connectionTimeoutMs: 10_000 as const,
    database: "pintpath_staging" as const,
    expectedRootCaDerSha256: TEST_ROOT_CA_DER_SHA256,
    hostname: "postgres-staging.railway.internal" as const,
    idleInTransactionTimeoutMs: 10_000 as const,
    idleTimeoutMs: 5_000 as const,
    maxConnections: 1 as const,
    password: PLANNER_PASSWORD,
    port: 5_432 as const,
    rootCaFile,
    statementTimeoutMs: 30_000 as const,
    user: "pintpath_reviewed_price_planner" as const,
  };
}

function historicalIdentity(): PostgresMigrationTargetIdentity {
  return {
    currentUser: "pintpath_migration_verifier",
    databaseName: "postgres",
    databaseOid: "16384",
    serverVersionNum: "170010",
    sessionUser: "pintpath_migration_verifier",
    systemIdentifier: "7460011223344556677",
  };
}

function deploymentAttestation(
  deployment: PostgresReviewedPricePromotionPlanCandidate["expectedDeployment"],
  candidateSha = CANDIDATE_SHA,
): RailwayApplicationDeploymentAttestationReceipt {
  const checks: RailwayApplicationDeploymentAttestationEvaluation["checks"] = {
    policyExact: true,
    queriesReadOnly: true,
    tokenScopeExact: true,
    patchEmptyBefore: true,
    patchEmptyAfter: true,
    providerTargetExact: true,
    providerSnapshotStable: true,
    deploymentSuccessful: true,
    providerOriginAttached: true,
    candidateExact: true,
    runtimeRoutesExact: true,
    runtimeIdentityExact: true,
    singleReplicaExact: true,
    restoreStateAbsent: true,
    observationWindowBounded: true,
    readOnlyStateRetained: true,
  };
  return buildRailwayApplicationDeploymentAttestationReceipt({
    candidateSha,
    startedAt: ATTESTATION_STARTED_AT,
    completedAt: NOW,
    expiresAt: ATTESTATION_EXPIRES_AT,
    checks,
    hashes: {
      policySha256: RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SHA256,
      projectIdSha256: deployment.projectIdSha256,
      environmentIdSha256: deployment.environmentIdSha256,
      serviceInstanceIdSha256: "2".repeat(64),
      serviceIdSha256: deployment.serviceIdSha256,
      deploymentIdSha256: deployment.deploymentIdSha256,
      snapshotIdSha256: "3".repeat(64),
      imageDigestSha256: deployment.imageDigestSha256,
      targetOriginSha256: "4".repeat(64),
      providerSnapshotSha256: "5".repeat(64),
      healthResponseSha256: "6".repeat(64),
      startupResponseSha256: "7".repeat(64),
      readyResponseSha256: "8".repeat(64),
      replicaIdSha256s: ["9".repeat(64)],
    },
  });
}

function authorityBundle(input: {
  readonly deployment: PostgresReviewedPricePromotionPlanCandidate["expectedDeployment"];
  readonly physicalIdentitySha256: string;
  readonly privateInputFileSha256: string;
}): PostgresReviewedPricePromotionAuthorityBundle {
  return {
    authorityMode: POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_MODE,
    candidateSha: CANDIDATE_SHA,
    evidenceReferences: {
      privateEvidenceManifestSha256: sha256("private-evidence-manifest"),
      restoreReceiptSha256: sha256("evidence-restore-receipt"),
      retrievalReceiptSha256: sha256("evidence-retrieval-receipt"),
      storageSnapshotManifestSha256: sha256("storage-snapshot-manifest"),
      wormManifestSha256: sha256("evidence-worm-manifest"),
    },
    expectedEnvironment: "permanent-staging",
    expiresAt: AUTHORITY_EXPIRES_AT,
    generatedAt: NOW,
    kind: POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_KIND,
    mutationAuthorized: false,
    privateInputManifestSha256: input.privateInputFileSha256,
    providerAuthorityObserved: false,
    recoveryReferences: {
      accountDeletionRecoveryManifestSha256: sha256("account-deletion-recovery"),
      logicalBackupManifestSha256: sha256("logical-backup-manifest"),
      pitrAttestationSha256: sha256("pitr-attestation"),
      privateStorageRecoveryManifestSha256: sha256("private-storage-recovery"),
      restoreReceiptSha256: sha256("recovery-restore-receipt"),
      wormManifestSha256: sha256("recovery-worm-manifest"),
    },
    reviewBindings: {
      approvalArtifactSha256: sha256("approval-artifact"),
      approvalReferenceSha256: sha256("approval-reference"),
      cryptographicApprovalVerified: false,
      operatorIdSha256: sha256("operator"),
      reviewMode: POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_MODE,
      reviewerIdSha256: sha256("reviewer"),
      trustRootPolicySha256: sha256("trust-root-policy"),
    },
    targetProfile: {
      deploymentAttestationFileSha256: input.deployment.attestationFileSha256,
      physicalDatabaseIdentitySha256: input.physicalIdentitySha256,
      railwayEnvironmentIdSha256: input.deployment.environmentIdSha256,
      railwayProjectIdSha256: input.deployment.projectIdSha256,
      railwayServiceIdSha256: input.deployment.serviceIdSha256,
      supabaseProjectIdentitySha256: sha256("supabase-project-identity"),
    },
    version: POSTGRES_REVIEWED_PRICE_PROMOTION_AUTHORITY_BUNDLE_VERSION,
  };
}

function reviewPacketCandidate(input: {
  readonly authorityBundleSha256: string;
  readonly physicalIdentitySha256: string;
  readonly privateInput: PostgresReviewedPricePromotionPrivateInput;
  readonly privateInputFileSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly targetProfileSha256: string;
}): PostgresReviewedPricePromotionReviewPacket {
  return finalizePostgresReviewedPricePromotionReviewPacket({
    authorityBundleSha256: input.authorityBundleSha256,
    candidateSha: CANDIDATE_SHA,
    expectedEnvironment: "permanent-staging",
    expiresAt: AUTHORITY_EXPIRES_AT,
    generatedAt: NOW,
    itemCount: 1,
    items: [{
      evidenceContentSha256: input.privateInput.items[0]!.evidenceContentSha256,
      evidenceReference: `source-ingestion:${INGESTION_ID}`,
      evidenceReferenceSha256: input.privateInput.items[0]!.evidenceReferenceSha256,
      rows: [{
        ordinal: 0,
        priceRecord: {
          beerName: "Fixture Beer",
          confidence: "admin_verified",
          happyHourDetails: null,
          id: `source-ingestion:${INGESTION_ID}:0`,
          isHappyHourPrice: false,
          isOnTap: "yes",
          normalizedBeerId: "fixture_beer",
          price: 13.5,
          servingSize: "pint",
          sourceEvidenceReference: `source-ingestion:${INGESTION_ID}`,
          sourceIngestionId: INGESTION_ID,
          sourceSubmissionId: null,
          sourceType: "source_ingestion",
          suburb: "Fitzroy",
          venueId: "22222222-2222-4222-8222-222222222222",
          venueName: "Fixture Hotel",
        },
        venueBeer: {
          abv: "4.5",
          beerName: "Fixture Beer",
          brewery: "Fixture Brewery",
          currency: "AUD",
          id: "admin-reviewed:22222222-2222-4222-8222-222222222222:fixture-beer:pint",
          inStock: true,
          normalizedBeerId: "fixture_beer",
          notes: "Published from admin source review.",
          onTap: true,
          price: 13.5,
          serveSize: "pint",
          sourceIngestionId: INGESTION_ID,
          style: "Lager",
          venueId: "22222222-2222-4222-8222-222222222222",
        },
      }],
      sourceIngestionId: INGESTION_ID,
      venue: {
        address: "123 Private Street",
        area: "inner-north",
        id: "22222222-2222-4222-8222-222222222222",
        name: "Fixture Hotel",
        suburb: "Fitzroy",
      },
    }],
    kind: POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_KIND,
    marketedSuburb: "Fitzroy",
    mutationEnabled: false,
    privateInputManifestSha256: input.privateInputFileSha256,
    rowCount: 1,
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    targetPhysicalIdentitySha256: input.physicalIdentitySha256,
    targetProfileSha256: input.targetProfileSha256,
    temporalPolicy: "single-apply-transaction-timestamp",
    version: POSTGRES_REVIEWED_PRICE_PROMOTION_REVIEW_PACKET_VERSION,
    wrongPricePolicySha256: REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256,
  });
}

function sourceSnapshotCandidate(
  privateInput: PostgresReviewedPricePromotionPrivateInput,
) {
  const withoutCombined = {
    items: [{
      catalogRowsSha256: "3".repeat(64),
      queueSnapshotSha256: "4".repeat(64),
      selectedRowCount: 1,
      selectedRowsSha256: "5".repeat(64),
      sourceIngestionId: privateInput.items[0]!.sourceIngestionId,
      venueIdSha256: privateInput.items[0]!.venueIdSha256,
      venueProfileSha256: "7".repeat(64),
    }],
    publicConflicts: {
      priceRecordCount: 0,
      rowsSha256: sha256PostgresReviewedPricePromotionValue([]),
      venueBeerCount: 0,
    },
    selectionPolicySha256: REVIEWED_PRICE_SELECTION_POLICY_SHA256,
    wrongPriceReports: {
      blockingCount: 0,
      blockingStatuses: ["in_progress", "open"] as const,
      openOrInProgressCount: 0,
      policySha256: REVIEWED_PRICE_WRONG_PRICE_POLICY_SHA256,
      rejectedCount: 0,
      resolvedCount: 0,
      rowsSha256: sha256PostgresReviewedPricePromotionValue([]),
      totalCount: 0,
    },
  };
  return {
    ...withoutCombined,
    combinedSha256: sha256PostgresReviewedPricePromotionValue(withoutCombined),
  };
}

function privacyAnonymizedTerminalWrongPriceRowsSha256(): string {
  const sanitize = (row: Readonly<Record<string, string | null>>) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key,
      value === null
        ? null
        : sha256(`pintpath-reviewed-price-conflict-${key}-v1\0${value}`),
    ]));
  return sha256PostgresReviewedPricePromotionValue([
    sanitize({
      assignedTo: null,
      beerName: "Fixture Beer",
      createdAt: NOW,
      id: "wrong-price-resolved-anonymized",
      notes: null,
      priceRecordId: null,
      reason: "price_changed",
      resolutionNote: null,
      resolvedAt: NOW,
      resolvedBy: null,
      sourcePhotoUrl: null,
      status: "resolved",
      updatedAt: NOW,
      venueId: "22222222-2222-4222-8222-222222222222",
    }),
    sanitize({
      assignedTo: null,
      beerName: "Fixture Beer",
      createdAt: NOW,
      id: "wrong-price-rejected-anonymized",
      notes: null,
      priceRecordId: null,
      reason: "other",
      resolutionNote: null,
      resolvedAt: NOW,
      resolvedBy: null,
      sourcePhotoUrl: null,
      status: "rejected",
      updatedAt: NOW,
      venueId: "22222222-2222-4222-8222-222222222222",
    }),
  ]);
}

function planCandidate(input: {
  readonly authorityBundle: PostgresReviewedPricePromotionAuthorityBundle;
  readonly authorityBundleSha256: string;
  readonly deployment: PostgresReviewedPricePromotionPlanCandidate["expectedDeployment"];
  readonly migrationReceiptFileSha256: string;
  readonly migrationReceipt: PostgresMigrationReceipt;
  readonly migrationTargetIdentity: PostgresMigrationTargetIdentity;
  readonly privateInput: PostgresReviewedPricePromotionPrivateInput;
  readonly privateInputFileSha256: string;
  readonly physicalIdentitySha256: string;
  readonly plannerLoginIdentitySha256: string;
  readonly reviewPacket: PostgresReviewedPricePromotionReviewPacket;
}): PostgresReviewedPricePromotionPlanCandidate {
  const sourceSnapshot = sourceSnapshotCandidate(input.privateInput);
  const migrationReceipt = input.migrationReceipt;
  const targetIdentity = input.migrationTargetIdentity;
  const reviewedPriceBoundTextSha256 = (label: string, value: string) => sha256(
    `pintpath-reviewed-price-${label}-v1\0${value}`,
  );
  const roleSafetySha256 = sha256PostgresReviewedPricePromotionValue({
    authorityQuerySha256: sha256(POSTGRES_REVIEWED_PRICE_PROMOTION_IDENTITY_QUERY),
    requiredColumnCount: 84,
    requiredRelationCount: 9,
    roleAuthorityValid: true,
    searchPathSchemas: ["pg_catalog"],
    transactionIsolation: "repeatable read",
    transactionReadOnly: true,
  });
  const migrationSnapshot = {
    approvalReferenceSha256: migrationReceipt.approvalReferenceSha256,
    candidateSha: CANDIDATE_SHA,
    completedAt: NOW,
    contractSha256: migrationReceipt.contractSha256,
    expectedEnvironment: "permanent-staging" as const,
    failureCode: null,
    manifestSha256: migrationReceipt.manifestSha256,
    operatorIdSha256: migrationReceipt.operatorIdSha256,
    receiptSha256: migrationReceipt.receiptSha256,
    runId: migrationReceipt.runIdSha256,
    sourceSchemaFingerprint: migrationReceipt.sourceSchemaFingerprint,
    sourceSchemaVersion: POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion,
    sourceSnapshotSha256: migrationReceipt.sourceSnapshotSha256,
    startedAt: NOW,
    status: "ready" as const,
    targetBindingSha256: migrationReceipt.runBindingSha256,
    targetDdlSha256: migrationReceipt.targetDdlSha256,
    verifierIdSha256: migrationReceipt.verifierIdSha256,
  };
  const withoutHash = {
    activationBlockers: [...POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS],
    authority: {
      authorityBundleSha256: input.authorityBundleSha256,
      authorityMode: input.authorityBundle.authorityMode,
      evidenceReferencesSha256:
        sha256PostgresReviewedPricePromotionValue(input.authorityBundle.evidenceReferences),
      expiresAt: input.authorityBundle.expiresAt,
      generatedAt: input.authorityBundle.generatedAt,
      mutationAuthorized: false as const,
      providerAuthorityObserved: false as const,
      recoveryReferencesSha256:
        sha256PostgresReviewedPricePromotionValue(input.authorityBundle.recoveryReferences),
      reviewBindingsSha256:
        sha256PostgresReviewedPricePromotionValue(input.authorityBundle.reviewBindings),
      supabaseProjectIdentitySha256:
        input.authorityBundle.targetProfile.supabaseProjectIdentitySha256,
      targetProfileSha256:
        sha256PostgresReviewedPricePromotionValue(input.authorityBundle.targetProfile),
    },
    candidateSha: CANDIDATE_SHA,
    expectedDeployment: input.deployment,
    expectedEnvironment: "permanent-staging" as const,
    kind: POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_KIND,
    migration: {
      approvalReferenceSha256: migrationReceipt.approvalReferenceSha256,
      completedAt: NOW,
      contractSha256: migrationReceipt.contractSha256,
      manifestSha256: migrationReceipt.manifestSha256,
      operatorIdSha256: migrationReceipt.operatorIdSha256,
      planSha256: migrationReceipt.planSha256,
      receiptFileSha256: input.migrationReceiptFileSha256,
      receiptSha256: migrationReceipt.receiptSha256,
      runId: migrationReceipt.runIdSha256,
      runSnapshotSha256:
        sha256PostgresReviewedPricePromotionValue(migrationSnapshot),
      schemaMetadataSha256: migrationReceipt.schemaMetadataSha256,
      sourceSchemaFingerprint: migrationReceipt.sourceSchemaFingerprint,
      sourceSchemaSha256: POSTGRES_REVIEWED_PRICE_PROMOTION_SOURCE_SCHEMA_SHA256,
      sourceSchemaVersion: POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion,
      sourceSnapshotSha256: migrationReceipt.sourceSnapshotSha256,
      startedAt: NOW,
      targetBindingSha256: migrationReceipt.runBindingSha256,
      targetDdlSha256: migrationReceipt.targetDdlSha256,
      verifierIdSha256: migrationReceipt.verifierIdSha256,
    },
    mutationEnabled: false as const,
    privateInput: {
      evidenceSetSha256:
        sha256PostgresReviewedPricePromotionValue(input.privateInput.items),
      itemCount: input.privateInput.itemCount,
      manifestSha256: input.privateInputFileSha256,
      marketedSuburb: input.privateInput.marketedSuburb,
    },
    reviewPacket: {
      itemCount: input.reviewPacket.itemCount,
      reviewPacketCandidateSha256: input.reviewPacket.reviewPacketCandidateSha256,
      rowCount: input.reviewPacket.rowCount,
    },
    sourceSnapshot,
    target: {
      catalogIdentity: {
        currentUserSha256: reviewedPriceBoundTextSha256(
          "postgres-current-user",
          "pintpath_reviewed_price_planner",
        ),
        databaseNameSha256: reviewedPriceBoundTextSha256(
          "postgres-database-name",
          targetIdentity.databaseName,
        ),
        databaseOidSha256: reviewedPriceBoundTextSha256(
          "postgres-database-oid",
          targetIdentity.databaseOid,
        ),
        roleSafetySha256,
        serverVersionNum: targetIdentity.serverVersionNum,
        sessionUserSha256: reviewedPriceBoundTextSha256(
          "postgres-session-user",
          "pintpath_reviewed_price_planner",
        ),
        systemIdentifierSha256: reviewedPriceBoundTextSha256(
          "postgres-system-identifier",
          targetIdentity.systemIdentifier,
        ),
      },
      physicalIdentitySha256: input.physicalIdentitySha256,
      plannerLoginIdentitySha256: input.plannerLoginIdentitySha256,
    },
    version: 4 as const,
  };
  return {
    ...withoutHash,
    planCandidateSha256: sha256PostgresReviewedPricePromotionValue(withoutHash),
  } as PostgresReviewedPricePromotionPlanCandidate;
}

function rebindPlanArtifacts(input: {
  readonly plan: PostgresReviewedPricePromotionPlanCandidate;
  readonly reviewPacket: PostgresReviewedPricePromotionReviewPacket;
  readonly rows?: PostgresReviewedPricePromotionReviewPacket["items"][number]["rows"];
  readonly wrongPriceReports?: PostgresReviewedPricePromotionPlanCandidate[
    "sourceSnapshot"
  ]["wrongPriceReports"];
}): PostgresReviewedPricePromotionPlanArtifacts {
  const rows = input.rows ?? input.reviewPacket.items[0]!.rows;
  const sourceWithoutCombined = {
    items: [{
      ...input.plan.sourceSnapshot.items[0]!,
      selectedRowCount: rows.length,
    }],
    publicConflicts: input.plan.sourceSnapshot.publicConflicts,
    selectionPolicySha256: input.plan.sourceSnapshot.selectionPolicySha256,
    wrongPriceReports:
      input.wrongPriceReports ?? input.plan.sourceSnapshot.wrongPriceReports,
  };
  const sourceSnapshot = {
    ...sourceWithoutCombined,
    combinedSha256: sha256PostgresReviewedPricePromotionValue(
      sourceWithoutCombined,
    ),
  };
  const { reviewPacketCandidateSha256: _oldPacketHash, ...oldPacket } =
    input.reviewPacket;
  const reviewPacket = finalizePostgresReviewedPricePromotionReviewPacket({
    ...oldPacket,
    items: [{
      ...oldPacket.items[0]!,
      rows,
    }],
    rowCount: rows.length,
    sourceSnapshotSha256: sourceSnapshot.combinedSha256,
  });
  const { planCandidateSha256: _oldPlanHash, ...oldPlan } = input.plan;
  const planWithoutHash = {
    ...oldPlan,
    reviewPacket: {
      itemCount: reviewPacket.itemCount,
      reviewPacketCandidateSha256: reviewPacket.reviewPacketCandidateSha256,
      rowCount: reviewPacket.rowCount,
    },
    sourceSnapshot,
  };
  return {
    plan: {
      ...planWithoutHash,
      planCandidateSha256:
        sha256PostgresReviewedPricePromotionValue(planWithoutHash),
    } as PostgresReviewedPricePromotionPlanCandidate,
    reviewPacket,
  };
}

function harness(): {
  readonly argv: readonly string[];
  readonly authorityBundlePath: string;
  readonly buildPlan: NonNullable<
    Partial<PostgresReviewedPricePromotionCliDependencies>["buildPlan"]
  >;
  readonly database: SqlDatabase;
  readonly deployment: PostgresReviewedPricePromotionPlanCandidate["expectedDeployment"];
  readonly deploymentAttestationPath: string;
  readonly dependencies: Partial<PostgresReviewedPricePromotionCliDependencies>;
  readonly migrationReceiptPath: string;
  readonly migrationTargetIdentityPath: string;
  readonly output: string[];
  readonly outputPlanPath: string;
  readonly outputReviewPacketPath: string;
  readonly physicalIdentitySha256: string;
  readonly plannerLoginIdentitySha256: string;
  readonly plannerUrl: string;
  readonly plannerUrlPath: string;
  readonly privateInputPath: string;
  readonly rootCaPath: string;
  readonly assertExact: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
  readonly root: string;
} {
  const root = canonicalRoot();
  const deploymentAttestationPath = path.join(root, "deployment-attestation.json");
  const plannerUrlPath = path.join(root, "planner-url");
  const rootCaPath = path.join(root, "railway-root-ca.pem");
  const migrationReceiptPath = path.join(root, "migration-receipt.json");
  const migrationTargetIdentityPath = path.join(root, "migration-target-identity.json");
  const privateInputPath = path.join(root, "private-input.json");
  const authorityBundlePath = path.join(root, "authority-bundle.json");
  const outputPlanPath = path.join(root, "plan-candidate.json");
  const outputReviewPacketPath = path.join(root, "private-review-packet.json");
  const identity = historicalIdentity();
  const migrationTargetIdentityBytes = canonicalPostgresReviewedPricePromotionJson(identity);
  const migrationTargetIdentitySha256 = sha256(migrationTargetIdentityBytes);
  const receiptRunBindingSha256 = sha256PostgresMigrationRunBinding({
    approvalReferenceSha256: "1".repeat(64),
    candidateSha: CANDIDATE_SHA,
    contractSha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
    expectedEnvironment: "permanent-staging",
    manifestSha256: "4".repeat(64),
    operatorIdSha256: "5".repeat(64),
    planSha256: "6".repeat(64),
    sourceSchemaFingerprint: POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
    sourceSchemaVersion: POSTGRES_MIGRATION_CONTRACT.sourceSchemaVersion,
    sourceSnapshotSha256: "b".repeat(64),
    targetDdlSha256: "e".repeat(64),
    targetIdentitySha256: migrationTargetIdentitySha256,
    targetUrlSha256: "f".repeat(64),
    verifierIdSha256: "1".repeat(64),
  });
  const receipt = finalizePostgresMigrationReceipt({
    approvalReferenceSha256: "1".repeat(64),
    candidateSha: CANDIDATE_SHA,
    chunkCount: 1,
    columnCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.columns,
    contractSha256: sha256PostgresMigrationContract(POSTGRES_MIGRATION_CONTRACT),
    expectedEnvironment: "permanent-staging",
    foreignKeyCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.foreignKeys,
    keyRangesSha256: "3".repeat(64),
    kind: "pint-path-postgres-migration-receipt",
    manifestSha256: "4".repeat(64),
    operatorIdSha256: "5".repeat(64),
    planSha256: "6".repeat(64),
    rowCount: 1,
    runBindingSha256: receiptRunBindingSha256,
    runIdSha256: derivePostgresMigrationRunId(receiptRunBindingSha256),
    schemaMetadataSha256: "9".repeat(64),
    sourceSchemaFingerprint: POSTGRES_MIGRATION_CONTRACT.expectedSchemaFingerprint,
    sourceSnapshotSha256: "b".repeat(64),
    stateTotalsSha256: "c".repeat(64),
    status: "ready",
    tableCount: POSTGRES_MIGRATION_CONTRACT.expectedCounts.tables,
    tableSetSha256: "d".repeat(64),
    targetDdlSha256: "e".repeat(64),
    targetIdentitySha256: migrationTargetIdentitySha256,
    targetUrlSha256: "f".repeat(64),
    transformedDataSha256: HASH,
    verifierIdSha256: "1".repeat(64),
    version: 1,
    zeroRowTableCount: 0,
  });
  const migrationReceiptBytes = canonicalPostgresReviewedPricePromotionJson(receipt);
  const venueId = "22222222-2222-4222-8222-222222222222";
  const evidenceReference = `source-ingestion:${INGESTION_ID}`;
  const privateInput: PostgresReviewedPricePromotionPrivateInput = {
    itemCount: 1,
    items: [{
      evidenceContentSha256: "2".repeat(64),
      evidenceReferenceSha256: sha256PostgresReviewedPricePromotionIdentity(
        "evidence-reference",
        evidenceReference,
      ),
      sourceIngestionId: INGESTION_ID,
      venueIdSha256: sha256PostgresReviewedPricePromotionIdentity(
        "venue-id",
        venueId,
      ),
    }],
    kind: POSTGRES_REVIEWED_PRICE_PROMOTION_PRIVATE_INPUT_KIND,
    marketedSuburb: "Fitzroy",
    version: 1,
  };
  const privateInputBytes = canonicalPostgresReviewedPricePromotionJson(privateInput);
  const exactPlannerUrl = plannerUrl(rootCaPath);
  const plannerUrlBytes = Buffer.from(`${exactPlannerUrl}\n`, "utf8");
  writePrivate(plannerUrlPath, plannerUrlBytes);
  writePrivate(rootCaPath, TEST_ROOT_CA_PEM);
  writePrivate(migrationReceiptPath, migrationReceiptBytes);
  writePrivate(migrationTargetIdentityPath, migrationTargetIdentityBytes);
  writePrivate(privateInputPath, privateInputBytes);

  const receiptDeployment = {
    deploymentIdSha256: "5".repeat(64),
    environmentIdSha256: "6".repeat(64),
    imageDigestSha256: "7".repeat(64),
    projectIdSha256: "8".repeat(64),
    serviceIdSha256: "9".repeat(64),
  };
  const deploymentAttestationBytes = Buffer.from(
    canonicalRailwayApplicationDeploymentAttestationReceipt(
      deploymentAttestation(receiptDeployment),
    ),
    "utf8",
  );
  writePrivate(deploymentAttestationPath, deploymentAttestationBytes);
  const deployment = {
    attestationFileSha256: sha256(deploymentAttestationBytes),
    attestationPolicySha256:
      RAILWAY_APPLICATION_DEPLOYMENT_ATTESTATION_POLICY_SHA256,
    ...receiptDeployment,
  };
  const physicalIdentitySha256 = sha256PostgresDatabaseIdentity(identity);
  const plannerLoginIdentitySha256 = sha256PostgresReviewedPricePromotionValue({
    ...identity,
    currentUser: "pintpath_reviewed_price_planner",
    sessionUser: "pintpath_reviewed_price_planner",
  });
  const expectedAuthorityBundle = authorityBundle({
    deployment,
    physicalIdentitySha256,
    privateInputFileSha256: sha256(privateInputBytes),
  });
  const authorityBundleBytes = canonicalPostgresReviewedPricePromotionJson(
    expectedAuthorityBundle,
  );
  writePrivate(authorityBundlePath, authorityBundleBytes);
  const sourceSnapshot = sourceSnapshotCandidate(privateInput);
  const expectedReviewPacket = reviewPacketCandidate({
    authorityBundleSha256: sha256(authorityBundleBytes),
    physicalIdentitySha256,
    privateInput,
    privateInputFileSha256: sha256(privateInputBytes),
    sourceSnapshotSha256: sourceSnapshot.combinedSha256,
    targetProfileSha256: sha256PostgresReviewedPricePromotionValue(
      expectedAuthorityBundle.targetProfile,
    ),
  });
  const expectedPlan = planCandidate({
    authorityBundle: expectedAuthorityBundle,
    authorityBundleSha256: sha256(authorityBundleBytes),
    deployment,
    migrationReceipt: receipt,
    migrationReceiptFileSha256: sha256(migrationReceiptBytes),
    migrationTargetIdentity: identity,
    privateInput,
    privateInputFileSha256: sha256(privateInputBytes),
    physicalIdentitySha256,
    plannerLoginIdentitySha256,
    reviewPacket: expectedReviewPacket,
  });
  const database = { dialect: "postgres" } as SqlDatabase;
  const assertExact = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);
  const output: string[] = [];
  const buildPlan = vi.fn(async () => ({
    plan: expectedPlan,
    reviewPacket: expectedReviewPacket,
  }));
  const dependencies: Partial<PostgresReviewedPricePromotionCliDependencies> = {
    openDatabase: vi.fn(async (options) => {
      expect(options).toMatchObject({
        applicationName: "pintpath-reviewed-price-promotion-planner",
        connectionTimeoutMs: 10_000,
        database: "pintpath_staging",
        expectedRootCaDerSha256: TEST_ROOT_CA_DER_SHA256,
        hostname: "postgres-staging.railway.internal",
        idleInTransactionTimeoutMs: 10_000,
        idleTimeoutMs: 5_000,
        maxConnections: 1,
        password: PLANNER_PASSWORD,
        port: 5_432,
        rootCaFile: rootCaPath,
        statementTimeoutMs: 30_000,
        user: "pintpath_reviewed_price_planner",
      });
      expect(options).not.toHaveProperty("connectionString");
      return { database, assertExact, release };
    }),
    buildPlan,
    environment: {},
    expectedRootCaDerSha256: TEST_ROOT_CA_DER_SHA256,
    now: () => new Date(NOW),
    writeOutput: (value) => output.push(value),
  };
  const argv = [
    POSTGRES_REVIEWED_PRICE_PROMOTION_COMMAND,
    "--candidate-sha", CANDIDATE_SHA,
    "--expected-environment", "permanent-staging",
    "--deployment-attestation", deploymentAttestationPath,
    "--deployment-attestation-sha256", sha256(deploymentAttestationBytes),
    "--planner-url-file", plannerUrlPath,
    "--planner-url-sha256", sha256(plannerUrlBytes),
    "--expected-target-database-identity-sha256", physicalIdentitySha256,
    "--migration-receipt", migrationReceiptPath,
    "--migration-receipt-sha256", sha256(migrationReceiptBytes),
    "--migration-target-identity", migrationTargetIdentityPath,
    "--migration-target-identity-sha256", migrationTargetIdentitySha256,
    "--private-input", privateInputPath,
    "--private-input-sha256", sha256(privateInputBytes),
    "--authority-bundle", authorityBundlePath,
    "--authority-bundle-sha256", sha256(authorityBundleBytes),
    "--output-plan", outputPlanPath,
    "--output-review-packet", outputReviewPacketPath,
  ] as const;
  cliRuntimeState.dependencies = dependencies as PostgresReviewedPricePromotionCliDependencies;
  return {
    argv,
    authorityBundlePath,
    buildPlan,
    database,
    deployment,
    deploymentAttestationPath,
    dependencies,
    migrationReceiptPath,
    migrationTargetIdentityPath,
    output,
    outputPlanPath,
    outputReviewPacketPath,
    physicalIdentitySha256,
    plannerLoginIdentitySha256,
    plannerUrl: exactPlannerUrl,
    plannerUrlPath,
    privateInputPath,
    rootCaPath,
    assertExact,
    release,
    root,
  };
}

describe("Postgres reviewed-price promotion plan CLI", () => {
  it("creates only canonical 0600 plan and review packet artifacts with a secret-free summary", async () => {
    const fixture = harness();

    await expect(runPostgresReviewedPricePromotionCli(
      fixture.argv,
    )).resolves.toBe(0);

    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fixture.buildPlan).toHaveBeenCalledTimes(1);
    const artifacts = await fixture.buildPlan.mock.results[0]!.value;
    const plan = artifacts.plan;
    const reviewPacket = artifacts.reviewPacket;
    expect(fixture.buildPlan).toHaveBeenCalledWith(expect.objectContaining({
      expectedDeployment: fixture.deployment,
      expectedAuthorityBundleSha256: plan.authority.authorityBundleSha256,
      expectedPhysicalDatabaseIdentitySha256: plan.target.physicalIdentitySha256,
    }));
    expect(plan.expectedDeployment).toEqual(fixture.deployment);
    expect(fixture.buildPlan.mock.calls[0]![0]).not.toHaveProperty(
      "expectedTargetIdentitySha256",
    );
    const planBytes = fs.readFileSync(fixture.outputPlanPath);
    expect(planBytes).toEqual(canonicalPostgresReviewedPricePromotionJson(plan));
    const reviewPacketBytes = fs.readFileSync(fixture.outputReviewPacketPath);
    expect(reviewPacketBytes).toEqual(
      canonicalPostgresReviewedPricePromotionJson(reviewPacket),
    );
    for (const artifactPath of [
      fixture.outputPlanPath,
      fixture.outputReviewPacketPath,
    ]) {
      const stat = fs.lstatSync(artifactPath);
      expect(stat.mode & 0o7777).toBe(0o600);
      expect(stat.nlink).toBe(1);
    }
    const journalPath = postgresReviewedPricePromotionCliInternals
      .publicationJournalPath(
        fixture.outputPlanPath,
        fixture.outputReviewPacketPath,
      );
    const journalStat = fs.lstatSync(journalPath);
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    expect(journalStat.mode & 0o7777).toBe(0o600);
    expect(journalStat.nlink).toBe(1);
    expect(journal).toMatchObject({
      artifacts: {
        plan: {
          bytes: planBytes.length,
          identity: {
            ino: fs.lstatSync(fixture.outputPlanPath).ino.toString(),
            nlink: "1",
          },
          path: fixture.outputPlanPath,
          sha256: sha256(planBytes),
        },
        reviewPacket: {
          bytes: reviewPacketBytes.length,
          identity: {
            ino: fs.lstatSync(fixture.outputReviewPacketPath).ino.toString(),
            nlink: "1",
          },
          path: fixture.outputReviewPacketPath,
          sha256: sha256(reviewPacketBytes),
        },
      },
      outputPlan: fixture.outputPlanPath,
      outputReviewPacket: fixture.outputReviewPacketPath,
      processId: process.pid,
      state: "committed",
      summary: { ok: true },
      version: 1,
    });
    expect(JSON.parse(fixture.output[0]!)).toEqual({
      activationBlockerCount:
        POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS.length,
      candidateSha: CANDIDATE_SHA,
      command: "plan",
      expectedEnvironment: "permanent-staging",
      itemCount: 1,
      mutationEnabled: false,
      ok: true,
      planCandidateSha256: plan.planCandidateSha256,
      planFileSha256: sha256(planBytes),
      physicalIdentitySha256: plan.target.physicalIdentitySha256,
      plannerLoginIdentitySha256: plan.target.plannerLoginIdentitySha256,
      reviewPacketCandidateSha256: reviewPacket.reviewPacketCandidateSha256,
      reviewPacketFileSha256: sha256(reviewPacketBytes),
      rowCount: 1,
    });
    for (const forbidden of [
      PLANNER_PASSWORD,
      fixture.plannerUrl,
      fixture.root,
      fixture.deploymentAttestationPath,
      fixture.plannerUrlPath,
      fixture.privateInputPath,
      fixture.authorityBundlePath,
    ]) {
      expect(fixture.output[0]).not.toContain(forbidden);
    }
  });

  it("replays an exact committed pair idempotently without reopening Postgres", async () => {
    const fixture = harness();

    await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
      .resolves.toBe(0);
    const firstSummary = fixture.output[0];
    const journalPath = postgresReviewedPricePromotionCliInternals
      .publicationJournalPath(
        fixture.outputPlanPath,
        fixture.outputReviewPacketPath,
      );
    const journalBefore = fs.readFileSync(journalPath);
    const planBefore = fs.readFileSync(fixture.outputPlanPath);
    const reviewPacketBefore = fs.readFileSync(fixture.outputReviewPacketPath);

    await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
      .resolves.toBe(0);

    expect(fixture.buildPlan).toHaveBeenCalledTimes(1);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fixture.output).toEqual([firstSummary, firstSummary]);
    expect(fs.readFileSync(journalPath)).toEqual(journalBefore);
    expect(fs.readFileSync(fixture.outputPlanPath)).toEqual(planBefore);
    expect(fs.readFileSync(fixture.outputReviewPacketPath))
      .toEqual(reviewPacketBefore);
  });

  it("recovers a killed prepared publication and never consumes it as committed", async () => {
    const fixture = harness();
    await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
      .resolves.toBe(0);
    const journalPath = postgresReviewedPricePromotionCliInternals
      .publicationJournalPath(
        fixture.outputPlanPath,
        fixture.outputReviewPacketPath,
      );
    const committed = JSON.parse(fs.readFileSync(journalPath, "utf8"));
    const prepared = {
      ...committed,
      artifacts: {
        plan: {
          bytes: committed.artifacts.plan.bytes,
          path: committed.artifacts.plan.path,
          sha256: committed.artifacts.plan.sha256,
          temporaryPath: committed.artifacts.plan.temporaryPath,
        },
        reviewPacket: {
          bytes: committed.artifacts.reviewPacket.bytes,
          path: committed.artifacts.reviewPacket.path,
          sha256: committed.artifacts.reviewPacket.sha256,
          temporaryPath: committed.artifacts.reviewPacket.temporaryPath,
        },
      },
      processId: 2_147_483_647,
      state: "prepared",
    };
    fs.writeFileSync(
      journalPath,
      canonicalPostgresReviewedPricePromotionJson(prepared),
      { mode: 0o600 },
    );
    fs.unlinkSync(fixture.outputPlanPath);
    fs.renameSync(
      fixture.outputReviewPacketPath,
      prepared.artifacts.reviewPacket.temporaryPath,
    );

    await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
      .resolves.toBe(0);

    expect(fixture.buildPlan).toHaveBeenCalledTimes(2);
    expect(fixture.release).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(prepared.artifacts.reviewPacket.temporaryPath))
      .toBe(false);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(true);
    expect(fs.existsSync(fixture.outputReviewPacketPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(journalPath, "utf8")).state)
      .toBe("committed");
  });

  it("rejects production before any file or database capability is used", async () => {
    const fixture = harness();
    const openDatabase = fixture.dependencies.openDatabase as ReturnType<typeof vi.fn>;
    const argv = setArgument(
      fixture.argv,
      "--expected-environment",
      "production",
    );

    await expect(runPostgresReviewedPricePromotionCli(argv))
      .resolves.toBe(1);

    expect(openDatabase).not.toHaveBeenCalled();
    expect(fixture.buildPlan).not.toHaveBeenCalled();
    expect(JSON.parse(fixture.output[0]!)).toEqual({
      command: "plan",
      failureCode: "environment_not_allowed",
      ok: false,
    });
  });

  it("requires the command and every exact argument once", async () => {
    expect(postgresReviewedPricePromotionCliInternals.ARGUMENT_COUNT).toBe(17);
    expect((harness().argv.length - 1) / 2).toBe(17);
    const missingCommand = harness();
    await expect(runPostgresReviewedPricePromotionCli(
      missingCommand.argv.slice(1),
    )).resolves.toBe(1);
    expect(JSON.parse(missingCommand.output[0]!).failureCode).toBe("argument_invalid");

    const duplicate = harness();
    await expect(runPostgresReviewedPricePromotionCli([
      ...duplicate.argv,
      "--candidate-sha",
      CANDIDATE_SHA,
    ])).resolves.toBe(1);
    expect(JSON.parse(duplicate.output[0]!).failureCode).toBe("argument_invalid");

    const unsupported = harness();
    await expect(runPostgresReviewedPricePromotionCli([
      ...unsupported.argv,
      "--apply",
      "confirmed",
    ])).resolves.toBe(1);
    expect(JSON.parse(unsupported.output[0]!).failureCode).toBe("argument_invalid");

    const legacyIdentityFlag = harness();
    const artifactOpen = vi.spyOn(fs.promises, "open");
    const legacyArgv = [...legacyIdentityFlag.argv];
    const physicalIdentityFlagIndex = legacyArgv.indexOf(
      "--expected-target-database-identity-sha256",
    );
    expect(physicalIdentityFlagIndex).toBeGreaterThan(0);
    legacyArgv[physicalIdentityFlagIndex] =
      "--expected-planner-target-identity-sha256";
    await expect(runPostgresReviewedPricePromotionCli(legacyArgv))
      .resolves.toBe(1);
    expect(artifactOpen).not.toHaveBeenCalled();
    expect(legacyIdentityFlag.dependencies.openDatabase).not.toHaveBeenCalled();
    expect(legacyIdentityFlag.buildPlan).not.toHaveBeenCalled();
    expect(JSON.parse(legacyIdentityFlag.output[0]!).failureCode)
      .toBe("argument_invalid");
  });

  it("rejects every legacy free-form deployment hash before files or Postgres", async () => {
    for (const legacyFlag of [
      "--deployment-project-id-sha256",
      "--deployment-environment-id-sha256",
      "--deployment-service-id-sha256",
      "--deployment-id-sha256",
      "--deployment-image-digest-sha256",
    ]) {
      const fixture = harness();
      const artifactOpen = vi.spyOn(fs.promises, "open");

      await expect(runPostgresReviewedPricePromotionCli([
        ...fixture.argv,
        legacyFlag,
        HASH,
      ])).resolves.toBe(1);

      expect(artifactOpen).not.toHaveBeenCalled();
      expect(fixture.dependencies.openDatabase).not.toHaveBeenCalled();
      expect(fixture.buildPlan).not.toHaveBeenCalled();
      expect(JSON.parse(fixture.output[0]!)).toEqual({
        command: "plan",
        failureCode: "argument_invalid",
        ok: false,
      });
      artifactOpen.mockRestore();
    }
  });

  it("requires an independently hashed canonical fresh deployment attestation", async () => {
    const wrongHash = harness();
    await expect(runPostgresReviewedPricePromotionCli(setArgument(
      wrongHash.argv,
      "--deployment-attestation-sha256",
      HASH,
    ))).resolves.toBe(1);
    expect(wrongHash.dependencies.openDatabase).not.toHaveBeenCalled();
    expect(JSON.parse(wrongHash.output[0]!).failureCode)
      .toBe("artifact_hash_mismatch");

    const noncanonical = harness();
    const noncanonicalReceipt = JSON.parse(
      fs.readFileSync(noncanonical.deploymentAttestationPath, "utf8"),
    ) as unknown;
    const prettyBytes = Buffer.from(
      `${JSON.stringify(noncanonicalReceipt, null, 2)}\n`,
      "utf8",
    );
    rewritePrivate(noncanonical.deploymentAttestationPath, prettyBytes);
    await expect(runPostgresReviewedPricePromotionCli(setArgument(
      noncanonical.argv,
      "--deployment-attestation-sha256",
      sha256(prettyBytes),
    ))).resolves.toBe(1);
    expect(noncanonical.dependencies.openDatabase).not.toHaveBeenCalled();
    expect(JSON.parse(noncanonical.output[0]!).failureCode)
      .toBe("artifact_invalid");

    const stale = harness();
    stale.dependencies.now = () => new Date("2026-08-08T00:15:00.001Z");
    await expect(runPostgresReviewedPricePromotionCli(stale.argv)).resolves.toBe(1);
    expect(stale.dependencies.openDatabase).not.toHaveBeenCalled();
    expect(JSON.parse(stale.output[0]!).failureCode).toBe("artifact_invalid");
  });

  it("rejects attestation candidate, environment, read-only, or check drift", async () => {
    for (const mutate of [
      (receipt: Record<string, unknown>) => ({
        ...receipt,
        candidateSha: "d".repeat(40),
      }),
      (receipt: Record<string, unknown>) => ({
        ...receipt,
        expectedEnvironment: "production",
      }),
      (receipt: Record<string, unknown>) => ({
        ...receipt,
        readOnlyEvidence: false,
      }),
      (receipt: Record<string, unknown>) => ({
        ...receipt,
        checks: {
          ...(receipt.checks as Record<string, unknown>),
          queriesReadOnly: false,
        },
      }),
    ]) {
      const fixture = harness();
      const parsed = JSON.parse(
        fs.readFileSync(fixture.deploymentAttestationPath, "utf8"),
      ) as Record<string, unknown>;
      const bytes = Buffer.from(`${JSON.stringify(mutate(parsed))}\n`, "utf8");
      rewritePrivate(fixture.deploymentAttestationPath, bytes);

      await expect(runPostgresReviewedPricePromotionCli(setArgument(
        fixture.argv,
        "--deployment-attestation-sha256",
        sha256(bytes),
      ))).resolves.toBe(1);

      expect(fixture.dependencies.openDatabase).not.toHaveBeenCalled();
      expect(fixture.buildPlan).not.toHaveBeenCalled();
      expect(JSON.parse(fixture.output[0]!)).toEqual({
        command: "plan",
        failureCode: "artifact_invalid",
        ok: false,
      });
    }
  });

  it("requires a canonical fresh offline-only authority bundle bound to the exact inputs", async () => {
    const wrongHash = harness();
    await expect(runPostgresReviewedPricePromotionCli(setArgument(
      wrongHash.argv,
      "--authority-bundle-sha256",
      HASH,
    ))).resolves.toBe(1);
    expect(wrongHash.dependencies.openDatabase).not.toHaveBeenCalled();
    expect(JSON.parse(wrongHash.output[0]!).failureCode)
      .toBe("artifact_hash_mismatch");

    const noncanonical = harness();
    const parsed = JSON.parse(
      fs.readFileSync(noncanonical.authorityBundlePath, "utf8"),
    ) as unknown;
    const compact = Buffer.from(JSON.stringify(parsed), "utf8");
    rewritePrivate(noncanonical.authorityBundlePath, compact);
    await expect(runPostgresReviewedPricePromotionCli(setArgument(
      noncanonical.argv,
      "--authority-bundle-sha256",
      sha256(compact),
    ))).resolves.toBe(1);
    expect(noncanonical.dependencies.openDatabase).not.toHaveBeenCalled();
    expect(JSON.parse(noncanonical.output[0]!).failureCode).toBe("artifact_invalid");

    for (const mutate of [
      (bundle: PostgresReviewedPricePromotionAuthorityBundle) => ({
        ...bundle,
        candidateSha: "d".repeat(40),
      }),
      (bundle: PostgresReviewedPricePromotionAuthorityBundle) => ({
        ...bundle,
        expiresAt: "2026-08-07T23:59:59.999Z",
        generatedAt: "2026-08-07T23:00:00.000Z",
      }),
      (bundle: PostgresReviewedPricePromotionAuthorityBundle) => ({
        ...bundle,
        reviewBindings: {
          ...bundle.reviewBindings,
          cryptographicApprovalVerified: true,
        },
      }),
    ]) {
      const fixture = harness();
      const bundle = JSON.parse(
        fs.readFileSync(fixture.authorityBundlePath, "utf8"),
      ) as PostgresReviewedPricePromotionAuthorityBundle;
      const bytes = canonicalPostgresReviewedPricePromotionJson(mutate(bundle));
      rewritePrivate(fixture.authorityBundlePath, bytes);
      await expect(runPostgresReviewedPricePromotionCli(setArgument(
        fixture.argv,
        "--authority-bundle-sha256",
        sha256(bytes),
      ))).resolves.toBe(1);
      expect(fixture.dependencies.openDatabase).not.toHaveBeenCalled();
      expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
      expect(fs.existsSync(fixture.outputReviewPacketPath)).toBe(false);
      expect(JSON.parse(fixture.output[0]!).failureCode).toBe("artifact_invalid");
    }
  });

  it("rejects the former role-bearing planner-login hash as physical authority", async () => {
    const fixture = harness();
    const argv = setArgument(
      fixture.argv,
      "--expected-target-database-identity-sha256",
      fixture.plannerLoginIdentitySha256,
    );

    await expect(runPostgresReviewedPricePromotionCli(argv)).resolves.toBe(1);

    expect(fixture.dependencies.openDatabase).not.toHaveBeenCalled();
    expect(fixture.buildPlan).not.toHaveBeenCalled();
    expect(JSON.parse(fixture.output[0]!).failureCode).toBe("artifact_invalid");
  });

  it("maps a roleful-only historical identity outside the physical domain to artifact_invalid", async () => {
    const fixture = harness();
    const invalidPhysicalIdentity = {
      ...historicalIdentity(),
      databaseName: "d".repeat(64),
    };
    const invalidIdentityBytes = canonicalPostgresReviewedPricePromotionJson(
      invalidPhysicalIdentity,
    );
    const invalidIdentitySha256 = sha256(invalidIdentityBytes);
    const receipt = JSON.parse(
      fs.readFileSync(fixture.migrationReceiptPath, "utf8"),
    ) as ReturnType<typeof finalizePostgresMigrationReceipt>;
    const { receiptSha256: _receiptSha256, ...receiptWithoutHash } = receipt;
    const reboundReceipt = finalizePostgresMigrationReceipt({
      ...receiptWithoutHash,
      targetIdentitySha256: invalidIdentitySha256,
    });
    const reboundReceiptBytes = canonicalPostgresReviewedPricePromotionJson(
      reboundReceipt,
    );
    fs.unlinkSync(fixture.migrationTargetIdentityPath);
    fs.unlinkSync(fixture.migrationReceiptPath);
    writePrivate(fixture.migrationTargetIdentityPath, invalidIdentityBytes);
    writePrivate(fixture.migrationReceiptPath, reboundReceiptBytes);
    const argv = setArgument(
      setArgument(
        fixture.argv,
        "--migration-target-identity-sha256",
        invalidIdentitySha256,
      ),
      "--migration-receipt-sha256",
      sha256(reboundReceiptBytes),
    );

    await expect(runPostgresReviewedPricePromotionCli(argv)).resolves.toBe(1);

    expect(fixture.dependencies.openDatabase).not.toHaveBeenCalled();
    expect(fixture.buildPlan).not.toHaveBeenCalled();
    expect(JSON.parse(fixture.output[0]!).failureCode).toBe("artifact_invalid");
  });

  it("rejects ambient Postgres, database URL, Supabase, and runtime authority before files or pg", async () => {
    for (const name of [
      "PGHOST",
      "DATABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "PINTPATH_RUNTIME_DATABASE_URL",
      "NODE_PG_FORCE_NATIVE",
    ]) {
      const fixture = harness();
      fixture.dependencies.environment = { [name]: `private-${name}` };
      await expect(runPostgresReviewedPricePromotionCli(
        fixture.argv,
      )).resolves.toBe(1);
      expect(fixture.dependencies.openDatabase).not.toHaveBeenCalled();
      expect(JSON.parse(fixture.output[0]!)).toEqual({
        command: "plan",
        failureCode: "argument_invalid",
        ok: false,
      });
      expect(fixture.output[0]).not.toContain(`private-${name}`);
    }
  });

  it("rejects unsafe descriptors, wrong hashes, and noncanonical JSON before opening Postgres", async () => {
    const unsafeAttestation = harness();
    fs.chmodSync(unsafeAttestation.deploymentAttestationPath, 0o640);
    await expect(runPostgresReviewedPricePromotionCli(
      unsafeAttestation.argv,
    )).resolves.toBe(1);
    expect(JSON.parse(unsafeAttestation.output[0]!).failureCode)
      .toBe("artifact_file_unsafe");

    const permissive = harness();
    fs.chmodSync(permissive.plannerUrlPath, 0o640);
    await expect(runPostgresReviewedPricePromotionCli(
      permissive.argv,
    )).resolves.toBe(1);
    expect(JSON.parse(permissive.output[0]!).failureCode).toBe("artifact_file_unsafe");

    const wrongHash = harness();
    await expect(runPostgresReviewedPricePromotionCli(
      setArgument(wrongHash.argv, "--planner-url-sha256", HASH),
    )).resolves.toBe(1);
    expect(JSON.parse(wrongHash.output[0]!).failureCode).toBe("artifact_hash_mismatch");

    const noncanonical = harness();
    const parsed = JSON.parse(fs.readFileSync(noncanonical.privateInputPath, "utf8"));
    const compact = Buffer.from(JSON.stringify(parsed), "utf8");
    fs.unlinkSync(noncanonical.privateInputPath);
    writePrivate(noncanonical.privateInputPath, compact);
    await expect(runPostgresReviewedPricePromotionCli(
      setArgument(noncanonical.argv, "--private-input-sha256", sha256(compact)),
    )).resolves.toBe(1);
    expect(JSON.parse(noncanonical.output[0]!).failureCode).toBe("artifact_invalid");

    for (const fixture of [
      unsafeAttestation,
      permissive,
      wrongHash,
      noncanonical,
    ]) {
      expect(fixture.dependencies.openDatabase).not.toHaveBeenCalled();
    }
  });

  it("rejects hard-linked inputs and any planner URL that is not a canonical direct verify-full login", async () => {
    const linked = harness();
    fs.linkSync(linked.migrationReceiptPath, path.join(linked.root, "receipt-link"));
    await expect(runPostgresReviewedPricePromotionCli(
      linked.argv,
    )).resolves.toBe(1);
    expect(JSON.parse(linked.output[0]!).failureCode).toBe("artifact_file_unsafe");

    const weakTls = harness();
    const weakUrlBytes = Buffer.from(
      `${weakTls.plannerUrl.replace("verify-full", "require")}\n`,
      "utf8",
    );
    fs.unlinkSync(weakTls.plannerUrlPath);
    writePrivate(weakTls.plannerUrlPath, weakUrlBytes);
    await expect(runPostgresReviewedPricePromotionCli(
      setArgument(weakTls.argv, "--planner-url-sha256", sha256(weakUrlBytes)),
    )).resolves.toBe(1);
    expect(JSON.parse(weakTls.output[0]!).failureCode).toBe("planner_url_unsafe");

    const pooled = harness();
    const pooledBytes = Buffer.from(
      `${pooled.plannerUrl.replace(
        "postgres-staging.railway.internal",
        "pooler.example.test",
      )}\n`,
      "utf8",
    );
    fs.unlinkSync(pooled.plannerUrlPath);
    writePrivate(pooled.plannerUrlPath, pooledBytes);
    await expect(runPostgresReviewedPricePromotionCli(
      setArgument(pooled.argv, "--planner-url-sha256", sha256(pooledBytes)),
    )).resolves.toBe(1);
    expect(JSON.parse(pooled.output[0]!).failureCode).toBe("planner_url_unsafe");

    const mutations = [
      (value: string) => value.replace(":5432/", ":5433/"),
      (value: string) => value.replace("/pintpath_staging?", "/postgres?"),
      (value: string) => value.replace(
        "pintpath_reviewed_price_planner:",
        "postgres:",
      ),
      (value: string) => `${value}&sslmode=verify-full`,
      (value: string) => {
        const [base, search] = value.split("?") as [string, string];
        const root = new URLSearchParams(search).get("sslrootcert")!;
        return `${base}?sslrootcert=${encodeURIComponent(root)}&sslmode=verify-full`;
      },
      (value: string) => `${value}&application_name=escape`,
    ];
    for (const mutate of mutations) {
      const fixture = harness();
      const bytes = Buffer.from(`${mutate(fixture.plannerUrl)}\n`, "utf8");
      fs.unlinkSync(fixture.plannerUrlPath);
      writePrivate(fixture.plannerUrlPath, bytes);
      await expect(runPostgresReviewedPricePromotionCli(
        setArgument(fixture.argv, "--planner-url-sha256", sha256(bytes)),
      )).resolves.toBe(1);
      expect(JSON.parse(fixture.output[0]!).failureCode).toBe("planner_url_unsafe");
      expect(fixture.dependencies.openDatabase).not.toHaveBeenCalled();
    }
  });

  it("requires nine distinct input/output paths under one held private parent and validates the pinned CA", async () => {
    const permissiveParent = harness();
    fs.chmodSync(permissiveParent.root, 0o750);
    await expect(runPostgresReviewedPricePromotionCli(
      permissiveParent.argv,
    )).resolves.toBe(1);
    expect(JSON.parse(permissiveParent.output[0]!).failureCode)
      .toBe("artifact_file_unsafe");

    const externalCa = harness();
    const otherRoot = canonicalRoot();
    const externalCaPath = path.join(otherRoot, "railway-root-ca.pem");
    writePrivate(externalCaPath, TEST_ROOT_CA_PEM);
    const externalUrl = plannerUrl(externalCaPath);
    const externalUrlBytes = Buffer.from(`${externalUrl}\n`, "utf8");
    fs.unlinkSync(externalCa.plannerUrlPath);
    writePrivate(externalCa.plannerUrlPath, externalUrlBytes);
    await expect(runPostgresReviewedPricePromotionCli(
      setArgument(
        externalCa.argv,
        "--planner-url-sha256",
        sha256(externalUrlBytes),
      ),
    )).resolves.toBe(1);
    expect(JSON.parse(externalCa.output[0]!).failureCode)
      .toBe("artifact_file_unsafe");

    const aliasedCa = harness();
    const aliasedUrl = plannerUrl(aliasedCa.plannerUrlPath);
    const aliasedBytes = Buffer.from(`${aliasedUrl}\n`, "utf8");
    fs.unlinkSync(aliasedCa.plannerUrlPath);
    writePrivate(aliasedCa.plannerUrlPath, aliasedBytes);
    await expect(runPostgresReviewedPricePromotionCli(
      setArgument(aliasedCa.argv, "--planner-url-sha256", sha256(aliasedBytes)),
    )).resolves.toBe(1);
    expect(JSON.parse(aliasedCa.output[0]!).failureCode)
      .toBe("artifact_file_unsafe");

    const wrongPin = harness();
    wrongPin.dependencies.expectedRootCaDerSha256 = "f".repeat(64);
    await expect(runPostgresReviewedPricePromotionCli(
      wrongPin.argv,
    )).resolves.toBe(1);
    expect(JSON.parse(wrongPin.output[0]!).failureCode)
      .toBe("root_ca_pin_mismatch");

    const twoCertificates = harness();
    fs.unlinkSync(twoCertificates.rootCaPath);
    writePrivate(
      twoCertificates.rootCaPath,
      `${TEST_ROOT_CA_PEM}${TEST_ROOT_CA_PEM}`,
    );
    await expect(runPostgresReviewedPricePromotionCli(
      twoCertificates.argv,
    )).resolves.toBe(1);
    expect(JSON.parse(twoCertificates.output[0]!).failureCode)
      .toBe("root_ca_invalid");

    for (const fixture of [
      permissiveParent,
      externalCa,
      aliasedCa,
      wrongPin,
      twoCertificates,
    ]) expect(fixture.dependencies.openDatabase).not.toHaveBeenCalled();
  });

  it("always releases once and suppresses publication on planner or release failure", async () => {
    const plannerFailure = harness();
    plannerFailure.dependencies.buildPlan = vi.fn(async () => {
      throw new PostgresReviewedPricePromotionPlanError("role_unsafe");
    });
    await expect(runPostgresReviewedPricePromotionCli(
      plannerFailure.argv,
    )).resolves.toBe(1);
    expect(plannerFailure.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(plannerFailure.outputPlanPath)).toBe(false);
    expect(JSON.parse(plannerFailure.output[0]!).failureCode).toBe("role_unsafe");

    const releaseFailure = harness();
    releaseFailure.release.mockRejectedValueOnce(new Error(`close ${PLANNER_PASSWORD}`));
    await expect(runPostgresReviewedPricePromotionCli(
      releaseFailure.argv,
    )).resolves.toBe(1);
    expect(releaseFailure.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(releaseFailure.outputPlanPath)).toBe(false);
    expect(JSON.parse(releaseFailure.output[0]!)).toEqual({
      command: "plan",
      failureCode: "database_release_failed",
      ok: false,
    });
    expect(releaseFailure.output[0]).not.toContain(PLANNER_PASSWORD);
  });

  it("reasserts the held CA, parent, and transport across planning", async () => {
    const caDrift = harness();
    const originalBuild = caDrift.buildPlan;
    caDrift.dependencies.buildPlan = vi.fn(async (input) => {
      const result = await originalBuild(input);
      fs.chmodSync(caDrift.rootCaPath, 0o640);
      return result;
    });
    await expect(runPostgresReviewedPricePromotionCli(
      caDrift.argv,
    )).resolves.toBe(1);
    expect(caDrift.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(caDrift.outputPlanPath)).toBe(false);
    expect(JSON.parse(caDrift.output[0]!).failureCode)
      .toBe("artifact_file_unsafe");

    const transportDrift = harness();
    transportDrift.assertExact
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error(`transport ${PLANNER_PASSWORD}`));
    await expect(runPostgresReviewedPricePromotionCli(
      transportDrift.argv,
    )).resolves.toBe(1);
    expect(transportDrift.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(transportDrift.outputPlanPath)).toBe(false);
    expect(JSON.parse(transportDrift.output[0]!)).toEqual({
      command: "plan",
      failureCode: "database_open_failed",
      ok: false,
    });
    expect(transportDrift.output[0]).not.toContain(PLANNER_PASSWORD);
  });

  it("rejects an injected plan that changes a blocker, binding, or mutation bit", async () => {
    const fixture = harness();
    const valid = await fixture.buildPlan({} as never);
    fixture.dependencies.buildPlan = vi.fn(async () => ({
      plan: {
        ...valid.plan,
        mutationEnabled: true,
      } as unknown as PostgresReviewedPricePromotionPlanCandidate,
      reviewPacket: valid.reviewPacket,
    }));

    await expect(runPostgresReviewedPricePromotionCli(
      fixture.argv,
    )).resolves.toBe(1);

    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
    expect(JSON.parse(fixture.output[0]!).failureCode).toBe("plan_result_invalid");
  });

  it("rejects an augmented artifact container or a review packet not bound by the plan", async () => {
    const augmented = harness();
    const augmentedValid = await augmented.buildPlan({} as never);
    augmented.dependencies.buildPlan = vi.fn(async () => ({
      plan: augmentedValid.plan,
      reviewPacket: augmentedValid.reviewPacket,
      unexpected: true,
    }) as unknown as PostgresReviewedPricePromotionPlanArtifacts);
    await expect(runPostgresReviewedPricePromotionCli(augmented.argv))
      .resolves.toBe(1);
    expect(JSON.parse(augmented.output[0]!).failureCode).toBe("plan_result_invalid");
    expect(fs.existsSync(augmented.outputPlanPath)).toBe(false);
    expect(fs.existsSync(augmented.outputReviewPacketPath)).toBe(false);

    const drifted = harness();
    const valid = await drifted.buildPlan({} as never);
    const { reviewPacketCandidateSha256: _packetHash, ...packetWithoutHash } =
      valid.reviewPacket;
    const changedPacketWithoutHash = {
      ...packetWithoutHash,
      items: [{
        ...packetWithoutHash.items[0]!,
        venue: {
          ...packetWithoutHash.items[0]!.venue,
          address: "999 Changed Private Street",
        },
      }],
    };
    const changedPacket = {
      ...changedPacketWithoutHash,
      reviewPacketCandidateSha256:
        sha256PostgresReviewedPricePromotionValue(changedPacketWithoutHash),
    } as PostgresReviewedPricePromotionReviewPacket;
    drifted.dependencies.buildPlan = vi.fn(async () => ({
      plan: valid.plan,
      reviewPacket: changedPacket,
    }));
    await expect(runPostgresReviewedPricePromotionCli(drifted.argv))
      .resolves.toBe(1);
    expect(JSON.parse(drifted.output[0]!).failureCode).toBe("plan_result_invalid");
    expect(fs.existsSync(drifted.outputPlanPath)).toBe(false);
    expect(fs.existsSync(drifted.outputReviewPacketPath)).toBe(false);
  });

  it("rejects self-consistently rehashed held-input and semantic rebinds", async () => {
    const heldRebind = harness();
    const validHeld = await heldRebind.buildPlan({} as never);
    const replacementVenue = "33333333-3333-4333-8333-333333333333";
    const { reviewPacketCandidateSha256: _packetHash, ...packetWithoutHash } =
      validHeld.reviewPacket;
    const changedItem = {
      ...packetWithoutHash.items[0]!,
      evidenceContentSha256: "0".repeat(64),
      rows: packetWithoutHash.items[0]!.rows.map((row) => ({
        ...row,
        priceRecord: { ...row.priceRecord, venueId: replacementVenue },
        venueBeer: { ...row.venueBeer, venueId: replacementVenue },
      })),
      venue: { ...packetWithoutHash.items[0]!.venue, id: replacementVenue },
    };
    const changedPacket = finalizePostgresReviewedPricePromotionReviewPacket({
      ...packetWithoutHash,
      items: [changedItem],
    });
    const { planCandidateSha256: _planHash, ...planWithoutHash } = validHeld.plan;
    const reboundPlanWithoutHash = {
      ...planWithoutHash,
      reviewPacket: {
        ...planWithoutHash.reviewPacket,
        reviewPacketCandidateSha256: changedPacket.reviewPacketCandidateSha256,
      },
    };
    heldRebind.dependencies.buildPlan = vi.fn(async () => ({
      plan: {
        ...reboundPlanWithoutHash,
        planCandidateSha256:
          sha256PostgresReviewedPricePromotionValue(reboundPlanWithoutHash),
      } as PostgresReviewedPricePromotionPlanCandidate,
      reviewPacket: changedPacket,
    }));

    await expect(runPostgresReviewedPricePromotionCli(heldRebind.argv))
      .resolves.toBe(1);
    expect(JSON.parse(heldRebind.output[0]!).failureCode)
      .toBe("plan_result_invalid");

    const semanticRebind = harness();
    const validSemantic = await semanticRebind.buildPlan({} as never);
    const rebound = rebindPlanArtifacts({
      ...validSemantic,
      wrongPriceReports: {
        ...validSemantic.plan.sourceSnapshot.wrongPriceReports,
        blockingCount: 1,
        openOrInProgressCount: 1,
        totalCount: 1,
      },
    });
    semanticRebind.dependencies.buildPlan = vi.fn(async () => rebound);

    await expect(runPostgresReviewedPricePromotionCli(semanticRebind.argv))
      .resolves.toBe(1);
    expect(JSON.parse(semanticRebind.output[0]!).failureCode)
      .toBe("plan_result_invalid");

    for (const drift of ["authority", "migration", "target"] as const) {
      const fixture = harness();
      const valid = await fixture.buildPlan({} as never);
      const { planCandidateSha256: _hash, ...withoutHash } = valid.plan;
      const changed = drift === "authority"
        ? {
            ...withoutHash,
            authority: {
              ...withoutHash.authority,
              evidenceReferencesSha256: "0".repeat(64),
            },
          }
        : drift === "migration"
          ? {
              ...withoutHash,
              migration: {
                ...withoutHash.migration,
                manifestSha256: "0".repeat(64),
              },
            }
          : {
              ...withoutHash,
              target: {
                ...withoutHash.target,
                catalogIdentity: {
                  ...withoutHash.target.catalogIdentity,
                  roleSafetySha256: "0".repeat(64),
                },
              },
            };
      fixture.dependencies.buildPlan = vi.fn(async () => ({
        plan: {
          ...changed,
          planCandidateSha256: sha256PostgresReviewedPricePromotionValue(changed),
        } as PostgresReviewedPricePromotionPlanCandidate,
        reviewPacket: valid.reviewPacket,
      }));
      await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
        .resolves.toBe(1);
      expect(JSON.parse(fixture.output[0]!).failureCode)
        .toBe("plan_result_invalid");
    }
  });

  it("accepts self-consistent privacy-anonymized terminal wrong-price authority", async () => {
    const fixture = harness();
    const valid = await fixture.buildPlan({} as never);
    const rebound = rebindPlanArtifacts({
      ...valid,
      wrongPriceReports: {
        ...valid.plan.sourceSnapshot.wrongPriceReports,
        rejectedCount: 1,
        resolvedCount: 1,
        rowsSha256: privacyAnonymizedTerminalWrongPriceRowsSha256(),
        totalCount: 2,
      },
    });
    fixture.dependencies.buildPlan = vi.fn(async () => rebound);

    await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
      .resolves.toBe(0);

    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(true);
    expect(fs.existsSync(fixture.outputReviewPacketPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(fixture.outputPlanPath, "utf8")))
      .toMatchObject({
        mutationEnabled: false,
        sourceSnapshot: {
          wrongPriceReports: {
            blockingCount: 0,
            openOrInProgressCount: 0,
            rejectedCount: 1,
            resolvedCount: 1,
            totalCount: 2,
          },
        },
      });
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      command: "plan",
      mutationEnabled: false,
      ok: true,
    });
  });

  it("rejects a terminal wrong-price count/hash emptiness mismatch", async () => {
    const cases = [
      {
        label: "zero-count-nonempty-hash",
        rejectedCount: 0,
        resolvedCount: 0,
        rowsSha256: privacyAnonymizedTerminalWrongPriceRowsSha256(),
        totalCount: 0,
      },
      {
        label: "positive-count-empty-hash",
        rejectedCount: 1,
        resolvedCount: 1,
        rowsSha256: sha256PostgresReviewedPricePromotionValue([]),
        totalCount: 2,
      },
    ] as const;
    for (const mismatch of cases) {
      const fixture = harness();
      const valid = await fixture.buildPlan({} as never);
      const rebound = rebindPlanArtifacts({
        ...valid,
        wrongPriceReports: {
          ...valid.plan.sourceSnapshot.wrongPriceReports,
          rejectedCount: mismatch.rejectedCount,
          resolvedCount: mismatch.resolvedCount,
          rowsSha256: mismatch.rowsSha256,
          totalCount: mismatch.totalCount,
        },
      });
      fixture.dependencies.buildPlan = vi.fn(async () => rebound);

      await expect(
        runPostgresReviewedPricePromotionCli(fixture.argv),
        mismatch.label,
      ).resolves.toBe(1);

      expect(fs.existsSync(fixture.outputPlanPath), mismatch.label).toBe(false);
      expect(fs.existsSync(fixture.outputReviewPacketPath), mismatch.label)
        .toBe(false);
      expect(JSON.parse(fixture.output[0]!).failureCode, mismatch.label)
        .toBe("plan_result_invalid");
    }
  });

  it("rejects a validly rehashed plan that drifts a receipt-derived deployment hash", async () => {
    const fixture = harness();
    const valid = await fixture.buildPlan({} as never);
    const { planCandidateSha256: _validHash, ...validWithoutHash } = valid.plan;
    const driftedWithoutHash = {
      ...validWithoutHash,
      expectedDeployment: {
        ...valid.plan.expectedDeployment,
        deploymentIdSha256: "0".repeat(64),
      },
    };
    fixture.dependencies.buildPlan = vi.fn(async () => ({
      plan: {
        ...driftedWithoutHash,
        planCandidateSha256:
          sha256PostgresReviewedPricePromotionValue(driftedWithoutHash),
      } as PostgresReviewedPricePromotionPlanCandidate,
      reviewPacket: valid.reviewPacket,
    }));

    await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
      .resolves.toBe(1);

    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
    expect(JSON.parse(fixture.output[0]!).failureCode)
      .toBe("plan_result_invalid");
  });

  it("keeps receipt-derived deployment bindings immutable across the builder callback", async () => {
    const fixture = harness();
    const valid = await fixture.buildPlan({} as never);
    fixture.dependencies.buildPlan = vi.fn(async (input) => {
      expect(Reflect.set(
        input.expectedDeployment,
        "deploymentIdSha256",
        "0".repeat(64),
      )).toBe(false);
      expect(Reflect.set(
        input.authorityBundle.targetProfile,
        "physicalDatabaseIdentitySha256",
        "0".repeat(64),
      )).toBe(false);
      expect(Reflect.set(
        input.privateInput.items[0]!,
        "evidenceContentSha256",
        "0".repeat(64),
      )).toBe(false);
      expect(Reflect.set(
        input.migrationReceipt,
        "manifestSha256",
        "0".repeat(64),
      )).toBe(false);
      const { planCandidateSha256: _hash, ...withoutHash } = valid.plan;
      const drifted = {
        ...withoutHash,
        expectedDeployment: {
          ...valid.plan.expectedDeployment,
          deploymentIdSha256: "0".repeat(64),
        },
      };
      return {
        plan: {
          ...drifted,
          planCandidateSha256: sha256PostgresReviewedPricePromotionValue(drifted),
        } as PostgresReviewedPricePromotionPlanCandidate,
        reviewPacket: valid.reviewPacket,
      };
    });

    await expect(runPostgresReviewedPricePromotionCli(fixture.argv)).resolves.toBe(1);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
    expect(JSON.parse(fixture.output[0]!).failureCode).toBe("plan_result_invalid");
  });

  it("keeps held bytes private from a poisoned Array push mutation and leak", async () => {
    const fixture = harness();
    const originalDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "push")!;
    const originalPush = originalDescriptor.value as typeof Array.prototype.push;
    let exposedByteCustodies = 0;
    let equalLengthMutationAttempts = 0;
    let heldPushCalls = 0;
    let leakedPlannerUrl = "";
    let exit: 0 | 1 | undefined;
    try {
      Object.defineProperty(Array.prototype, "push", {
        ...originalDescriptor,
        value(this: unknown[], ...values: unknown[]) {
          const candidate = values.length === 1 ? values[0] : undefined;
          if (
            typeof candidate === "object"
            && candidate !== null
            && Object.hasOwn(candidate, "path")
            && Object.hasOwn(candidate, "sha256")
            && Object.hasOwn(candidate, "assertExact")
            && Object.hasOwn(candidate, "close")
          ) {
            heldPushCalls += 1;
            const exposed = (candidate as { readonly bytes?: unknown }).bytes;
            if (Buffer.isBuffer(exposed)) {
              exposedByteCustodies += 1;
              const source = exposed.toString("utf8");
              if (source.includes("postgresql://")) {
                leakedPlannerUrl = source;
                const forged = Buffer.from(exposed);
                const passwordOffset = forged.indexOf(PLANNER_PASSWORD, 0, "utf8");
                if (passwordOffset >= 0) {
                  const replacement = "X".repeat(PLANNER_PASSWORD.length);
                  forged.write(replacement, passwordOffset, "utf8");
                  if (forged.length !== exposed.length) {
                    throw new Error("equal-length held-byte fixture drifted");
                  }
                  forged.copy(exposed);
                  equalLengthMutationAttempts += 1;
                }
              }
            }
            return Reflect.apply(originalPush, this, [
              new Proxy(candidate, {}),
            ]);
          }
          return Reflect.apply(originalPush, this, values);
        },
      });
      exit = await runPostgresReviewedPricePromotionCli(fixture.argv);
    } finally {
      Object.defineProperty(Array.prototype, "push", originalDescriptor);
    }

    expect(exit).toBe(0);
    expect(heldPushCalls).toBe(0);
    expect(exposedByteCustodies).toBe(0);
    expect(equalLengthMutationAttempts).toBe(0);
    expect(leakedPlannerUrl).not.toContain(PLANNER_PASSWORD);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(true);
  });

  it("binds argv directly without a live Map get redirection", async () => {
    const fixture = harness();
    const forgedReceiptPath = path.join(fixture.root, "forged-attestation.json");
    writePrivate(forgedReceiptPath, "{}\n");
    const forgedReceiptSha256 = sha256("{}\n");
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Map.prototype,
      "get",
    )!;
    const originalGet = originalDescriptor.value as typeof Map.prototype.get;
    let redirectedArgumentGets = 0;
    let exit: 0 | 1 | undefined;
    try {
      Object.defineProperty(Map.prototype, "get", {
        ...originalDescriptor,
        value(this: Map<unknown, unknown>, key: unknown) {
          if (key === "--deployment-attestation") {
            redirectedArgumentGets += 1;
            return forgedReceiptPath;
          }
          if (key === "--deployment-attestation-sha256") {
            redirectedArgumentGets += 1;
            return forgedReceiptSha256;
          }
          return Reflect.apply(originalGet, this, [key]);
        },
      });
      exit = await runPostgresReviewedPricePromotionCli(fixture.argv);
    } finally {
      Object.defineProperty(Map.prototype, "get", originalDescriptor);
    }

    expect(exit).toBe(0);
    expect(redirectedArgumentGets).toBe(0);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(true);
  });

  it("keeps planner secrets behind captured byte, URL, regex, and fs primitives", async () => {
    const fixture = harness();
    const probe = await fs.promises.open(fixture.plannerUrlPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as object;
    await probe.close();
    const originalIncludes = String.prototype.includes;
    const restores: Array<() => void> = [];
    const calls = {
      bufferEquals: 0,
      bufferFrom: 0,
      decoder: 0,
      fileHandleRead: 0,
      fsOpen: 0,
      typedFill: 0,
      urlSearchParams: 0,
    };
    let secretObservations = 0;
    const seesSecret = (value: unknown): boolean => typeof value === "string"
      && Reflect.apply(originalIncludes, value, [PLANNER_PASSWORD]);
    const replaceMethod = (
      target: object,
      key: string,
      observe: (receiver: unknown, values: readonly unknown[]) => void,
    ): void => {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor || typeof descriptor.value !== "function") {
        throw new Error(`missing poison fixture ${key}`);
      }
      const original = descriptor.value as (...values: unknown[]) => unknown;
      Object.defineProperty(target, key, {
        ...descriptor,
        value(this: unknown, ...values: unknown[]) {
          observe(this, values);
          return Reflect.apply(original, this, values);
        },
      });
      restores.push(() => Object.defineProperty(target, key, descriptor));
    };

    replaceMethod(fs.promises, "open", (_receiver, values) => {
      calls.fsOpen += 1;
      if (seesSecret(values[0])) secretObservations += 1;
    });
    replaceMethod(fileHandlePrototype, "read", () => {
      calls.fileHandleRead += 1;
    });
    replaceMethod(TextDecoder.prototype, "decode", () => {
      calls.decoder += 1;
    });
    replaceMethod(Buffer, "from", (_receiver, values) => {
      calls.bufferFrom += 1;
      if (seesSecret(values[0])) secretObservations += 1;
    });
    replaceMethod(Buffer.prototype, "equals", () => {
      calls.bufferEquals += 1;
    });
    replaceMethod(Object.getPrototypeOf(Uint8Array.prototype) as object, "fill", () => {
      calls.typedFill += 1;
    });
    replaceMethod(RegExp.prototype, "test", (_receiver, values) => {
      if (seesSecret(values[0])) secretObservations += 1;
    });
    for (const key of [
      "endsWith",
      "includes",
      "indexOf",
      "slice",
      "startsWith",
      "toUpperCase",
      "trim",
    ]) {
      replaceMethod(String.prototype, key, (receiver, values) => {
        if (seesSecret(receiver) || values.some(seesSecret)) {
          secretObservations += 1;
        }
      });
    }
    for (const key of ["append", "get", "getAll", "toString"]) {
      replaceMethod(URLSearchParams.prototype, key, (_receiver, values) => {
        calls.urlSearchParams += 1;
        if (values.some(seesSecret)) secretObservations += 1;
      });
    }
    const urlDescriptor = Object.getOwnPropertyDescriptor(globalThis, "URL")!;
    const OriginalURL = urlDescriptor.value as typeof URL;
    Object.defineProperty(globalThis, "URL", {
      ...urlDescriptor,
      value: function PoisonedURL(this: unknown, ...values: unknown[]) {
        if (values.some(seesSecret)) secretObservations += 1;
        return Reflect.construct(OriginalURL, values);
      },
    });
    restores.push(() => Object.defineProperty(globalThis, "URL", urlDescriptor));
    const constructDescriptor = Object.getOwnPropertyDescriptor(Reflect, "construct")!;
    const originalConstruct = constructDescriptor.value as typeof Reflect.construct;
    Object.defineProperty(Reflect, "construct", {
      ...constructDescriptor,
      value(target: Function, values: ArrayLike<unknown>, newTarget?: Function) {
        for (let index = 0; index < values.length; index += 1) {
          if (seesSecret(values[index])) secretObservations += 1;
        }
        return newTarget === undefined
          ? originalConstruct(target, values)
          : originalConstruct(target, values, newTarget);
      },
    });
    restores.push(() => Object.defineProperty(Reflect, "construct", constructDescriptor));

    let exit: 0 | 1 | undefined;
    try {
      exit = await runPostgresReviewedPricePromotionCli(fixture.argv);
    } finally {
      for (let index = restores.length - 1; index >= 0; index -= 1) {
        restores[index]!();
      }
    }

    expect(exit).toBe(0);
    expect(calls.bufferEquals).toBe(0);
    expect(calls.decoder).toBe(0);
    expect(calls.fileHandleRead).toBe(0);
    expect(calls.fsOpen).toBe(0);
    expect(calls.typedFill).toBe(0);
    expect(calls.urlSearchParams).toBe(0);
    expect(secretObservations).toBe(0);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(true);
  });

  it("writes the runtime summary through captured exact stdout primitives", () => {
    const runtimeUrl = pathToFileURL(path.resolve(
      process.cwd(),
      "scripts/lib/postgres-reviewed-price-promotion-runtime.ts",
    )).href;
    const script = `
      const runtime = await import(${JSON.stringify(runtimeUrl)});
      const fs = (await import("node:fs")).default;
      const originalFrom = Buffer.from;
      const originalWriteSync = fs.writeSync;
      const originalSafeInteger = Number.isSafeInteger;
      let bufferFromCalls = 0;
      let writeCalls = 0;
      let numberCalls = 0;
      Buffer.from = function (...values) {
        bufferFromCalls += 1;
        return Reflect.apply(originalFrom, Buffer, values);
      };
      fs.writeSync = function (...values) {
        writeCalls += 1;
        return Reflect.apply(originalWriteSync, fs, values);
      };
      Number.isSafeInteger = function (value) {
        numberCalls += 1;
        return Reflect.apply(originalSafeInteger, Number, [value]);
      };
      try {
        runtime.POSTGRES_REVIEWED_PRICE_PROMOTION_RUNTIME.writeOutput(
          '{"runtime":true}\\n',
        );
      } finally {
        Buffer.from = originalFrom;
        fs.writeSync = originalWriteSync;
        Number.isSafeInteger = originalSafeInteger;
      }
      process.stderr.write(JSON.stringify({ bufferFromCalls, numberCalls, writeCalls }));
    `;
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"runtime":true}\n');
    expect(JSON.parse(result.stderr)).toEqual({
      bufferFromCalls: 0,
      numberCalls: 0,
      writeCalls: 0,
    });
  });

  it("compares activation blockers without live JSON stringify", async () => {
    const fixture = harness();
    const originalBuildPlan = fixture.buildPlan;
    const originalStringify = JSON.stringify;
    let poisonCalls = 0;
    fixture.dependencies.buildPlan = vi.fn(async (input) => {
      const candidate = await originalBuildPlan(input);
      JSON.stringify = (() => {
        poisonCalls += 1;
        throw new Error(`activation blocker stringify ${PLANNER_PASSWORD}`);
      }) as typeof JSON.stringify;
      return candidate;
    });

    let exit: 0 | 1 | undefined;
    try {
      exit = await runPostgresReviewedPricePromotionCli(fixture.argv);
    } finally {
      JSON.stringify = originalStringify;
    }

    expect(exit).toBe(0);
    expect(poisonCalls).toBe(0);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(true);
  });

  it("rechecks deployment-attestation freshness immediately around publication", async () => {
    for (const expireOnCall of [3, 5]) {
      const fixture = harness();
      let nowCalls = 0;
      fixture.dependencies.now = () => {
        nowCalls += 1;
        return new Date(nowCalls >= expireOnCall
          ? "2026-08-08T00:15:00.001Z"
          : NOW);
      };

      await expect(runPostgresReviewedPricePromotionCli(fixture.argv)).resolves.toBe(1);
      expect(fixture.release).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
      expect(JSON.parse(fixture.output[0]!).failureCode).toBe("artifact_invalid");
    }
  });

  it("rejects independently drifted physical and planner-login identity bindings", async () => {
    for (const targetField of [
      "physicalIdentitySha256",
      "plannerLoginIdentitySha256",
    ] as const) {
      const fixture = harness();
      const valid = await fixture.buildPlan({} as never);
      const { planCandidateSha256: _validHash, ...validWithoutHash } = valid.plan;
      const driftedWithoutHash = {
        ...validWithoutHash,
        target: {
          ...valid.plan.target,
          [targetField]: "0".repeat(64),
        },
      };
      fixture.dependencies.buildPlan = vi.fn(async () => ({
        plan: {
          ...driftedWithoutHash,
          planCandidateSha256:
            sha256PostgresReviewedPricePromotionValue(driftedWithoutHash),
        } as PostgresReviewedPricePromotionPlanCandidate,
        reviewPacket: valid.reviewPacket,
      }));

      await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
        .resolves.toBe(1);

      expect(fixture.release).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
      expect(JSON.parse(fixture.output[0]!).failureCode)
        .toBe("plan_result_invalid");
    }
  });

  it("never overwrites an existing output artifact", async () => {
    for (const outputKey of [
      "outputPlanPath",
      "outputReviewPacketPath",
    ] as const) {
      const fixture = harness();
      const sentinel = Buffer.from("operator-owned\n", "utf8");
      writePrivate(fixture[outputKey], sentinel);

      await expect(runPostgresReviewedPricePromotionCli(
        fixture.argv,
      )).resolves.toBe(1);

      expect(fixture.release).not.toHaveBeenCalled();
      expect(fs.readFileSync(fixture[outputKey])).toEqual(sentinel);
      expect(JSON.parse(fixture.output[0]!).failureCode).toBe("output_file_unsafe");
    }
  });

  it("does not dispatch temporary publication cleanup through a replaced fs method", async () => {
    const fixture = harness();
    const originalUnlink = fs.promises.unlink.bind(fs.promises);
    let temporaryUnlinkCount = 0;
    vi.spyOn(fs.promises, "unlink").mockImplementation(async (filename) => {
      if (
        typeof filename === "string"
        && path.basename(filename).startsWith(
          ".pintpath-postgres-reviewed-price-plan-",
        )
      ) {
        temporaryUnlinkCount += 1;
        if (temporaryUnlinkCount > 1) {
          throw new Error(`redundant temporary unlink ${PLANNER_PASSWORD}`);
        }
      }
      await originalUnlink(filename);
    });

    await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
      .resolves.toBe(0);

    expect(temporaryUnlinkCount).toBe(0);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(true);
    expect(fs.readdirSync(fixture.root).some((filename) => filename.startsWith(
      ".pintpath-postgres-reviewed-price-plan-",
    ))).toBe(false);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      command: "plan",
      ok: true,
    });
  });

  it("publishes the pair atomically across every release boundary", async () => {
    for (const boundary of [
      "review-packet-published",
      "plan-published",
      "plan-finalized",
      "review-packet-finalized",
    ] as const) {
      const fixture = harness();
      fixture.dependencies.assertPublicationBoundary = vi.fn((observed) => {
        if (observed === boundary) throw new Error(`injected ${boundary}`);
      });

      await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
        .resolves.toBe(1);

      expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
      expect(fs.existsSync(fixture.outputReviewPacketPath)).toBe(false);
      expect(fixture.output).toHaveLength(1);
      expect(JSON.parse(fixture.output[0]!)).toEqual({
        command: "plan",
        failureCode: "output_file_unsafe",
        ok: false,
      });
      expect(fixture.output.some((value) => value.includes('"ok": true')))
        .toBe(false);
    }
  });

  it("keeps inode-bound rollback custody across every precommit rename boundary", async () => {
    const cases = [
      ["review-packet-published", "review-packet"],
      ["plan-published", "plan"],
      ["plan-published", "review-packet"],
      ["plan-finalized", "plan"],
      ["plan-finalized", "review-packet"],
      ["review-packet-finalized", "plan"],
      ["review-packet-finalized", "review-packet"],
    ] as const;
    for (const [boundary, artifact] of cases) {
      const fixture = harness();
      const originalPath = artifact === "plan"
        ? fixture.outputPlanPath
        : fixture.outputReviewPacketPath;
      const renamedPath = path.join(
        fixture.root,
        `${boundary}-${artifact}-renamed.json`,
      );
      fixture.dependencies.assertPublicationBoundary = vi.fn((observed) => {
        if (observed !== boundary) return;
        fs.renameSync(originalPath, renamedPath);
        throw new Error(`injected rename ${boundary} ${artifact}`);
      });

      await expect(
        runPostgresReviewedPricePromotionCli(fixture.argv),
        `${boundary}:${artifact}`,
      ).resolves.toBe(1);

      expect(fs.existsSync(fixture.outputPlanPath), `${boundary}:${artifact}`)
        .toBe(false);
      expect(
        fs.existsSync(fixture.outputReviewPacketPath),
        `${boundary}:${artifact}`,
      ).toBe(false);
      expect(fs.existsSync(renamedPath), `${boundary}:${artifact}`).toBe(true);
      expect(fs.statSync(renamedPath).size, `${boundary}:${artifact}`).toBe(0);
      expect(fixture.output, `${boundary}:${artifact}`).toHaveLength(1);
      expect(JSON.parse(fixture.output[0]!), `${boundary}:${artifact}`).toEqual({
        command: "plan",
        failureCode: "output_file_unsafe",
        ok: false,
      });
      expect(
        fixture.output.some((value) => value.includes('"ok": true')),
        `${boundary}:${artifact}`,
      ).toBe(false);
    }
  });

  it("revalidates both artifacts after callbacks that rename and return normally", async () => {
    const cases = [
      ["review-packet-published", "review-packet"],
      ["plan-published", "plan"],
      ["plan-published", "review-packet"],
      ["plan-finalized", "plan"],
      ["plan-finalized", "review-packet"],
      ["review-packet-finalized", "plan"],
      ["review-packet-finalized", "review-packet"],
    ] as const;
    for (const [boundary, artifact] of cases) {
      const fixture = harness();
      const originalPath = artifact === "plan"
        ? fixture.outputPlanPath
        : fixture.outputReviewPacketPath;
      const renamedPath = path.join(
        fixture.root,
        `${boundary}-${artifact}-normal-return.json`,
      );
      fixture.dependencies.assertPublicationBoundary = vi.fn((observed) => {
        if (observed === boundary) fs.renameSync(originalPath, renamedPath);
      });

      await expect(
        runPostgresReviewedPricePromotionCli(fixture.argv),
        `${boundary}:${artifact}`,
      ).resolves.toBe(1);

      expect(fs.existsSync(fixture.outputPlanPath), `${boundary}:${artifact}`)
        .toBe(false);
      expect(
        fs.existsSync(fixture.outputReviewPacketPath),
        `${boundary}:${artifact}`,
      ).toBe(false);
      expect(fs.existsSync(renamedPath), `${boundary}:${artifact}`).toBe(true);
      expect(fs.statSync(renamedPath).size, `${boundary}:${artifact}`).toBe(0);
      expect(fixture.output, `${boundary}:${artifact}`).toHaveLength(1);
      expect(JSON.parse(fixture.output[0]!), `${boundary}:${artifact}`).toEqual({
        command: "plan",
        failureCode: "output_file_unsafe",
        ok: false,
      });
      expect(
        fixture.output.some((value) => value.includes('"ok": true')),
        `${boundary}:${artifact}`,
      ).toBe(false);
    }
  });

  it("revalidates both artifacts after final callbacks truncate and return normally", async () => {
    const cases = [
      ["plan-finalized", "plan"],
      ["plan-finalized", "review-packet"],
      ["review-packet-finalized", "plan"],
      ["review-packet-finalized", "review-packet"],
    ] as const;
    for (const [boundary, artifact] of cases) {
      const fixture = harness();
      const artifactPath = artifact === "plan"
        ? fixture.outputPlanPath
        : fixture.outputReviewPacketPath;
      fixture.dependencies.assertPublicationBoundary = vi.fn((observed) => {
        if (observed !== boundary) return;
        const size = fs.statSync(artifactPath).size;
        fs.truncateSync(artifactPath, size - 1);
      });

      await expect(
        runPostgresReviewedPricePromotionCli(fixture.argv),
        `${boundary}:${artifact}`,
      ).resolves.toBe(1);

      expect(fs.existsSync(fixture.outputPlanPath), `${boundary}:${artifact}`)
        .toBe(false);
      expect(
        fs.existsSync(fixture.outputReviewPacketPath),
        `${boundary}:${artifact}`,
      ).toBe(false);
      expect(fixture.output, `${boundary}:${artifact}`).toHaveLength(1);
      expect(JSON.parse(fixture.output[0]!), `${boundary}:${artifact}`).toEqual({
        command: "plan",
        failureCode: "output_file_unsafe",
        ok: false,
      });
      expect(
        fixture.output.some((value) => value.includes('"ok": true')),
        `${boundary}:${artifact}`,
      ).toBe(false);
    }
  });

  it("retains the committed pair and emits no success on every close ambiguity", async () => {
    for (const artifact of ["plan", "review-packet"] as const) {
      for (const mode of ["reject-without-close", "close-then-reject"] as const) {
        const fixture = harness();
        const releases: string[] = [];
        fixture.dependencies.releasePublishedArtifactHandle = vi.fn(
          async (observed, close) => {
            releases.push(observed);
            if (observed !== artifact) {
              await close();
              return;
            }
            if (mode === "close-then-reject") await close();
            throw new Error(`injected close ambiguity ${artifact} ${mode}`);
          },
        );

        await expect(
          runPostgresReviewedPricePromotionCli(fixture.argv),
          `${artifact}:${mode}`,
        ).resolves.toBe(1);

        expect(releases, `${artifact}:${mode}`).toEqual([
          "plan",
          "review-packet",
        ]);
        for (const artifactPath of [
          fixture.outputPlanPath,
          fixture.outputReviewPacketPath,
        ]) {
          expect(fs.existsSync(artifactPath), `${artifact}:${mode}`).toBe(true);
          expect(fs.statSync(artifactPath).size, `${artifact}:${mode}`)
            .toBeGreaterThan(0);
          expect(
            () => JSON.parse(fs.readFileSync(artifactPath, "utf8")),
            `${artifact}:${mode}`,
          ).not.toThrow();
        }
        expect(fixture.output, `${artifact}:${mode}`).toHaveLength(1);
        expect(JSON.parse(fixture.output[0]!), `${artifact}:${mode}`).toEqual({
          command: "plan",
          failureCode: "output_file_unsafe",
          ok: false,
        });
        expect(
          fixture.output.some((value) => value.includes('"ok": true')),
          `${artifact}:${mode}`,
        ).toBe(false);
      }
    }
  });

  it("rolls back a schema-valid packet larger than the 256 KiB plan cap", async () => {
    const fixture = harness();
    const valid = await fixture.buildPlan({} as never);
    const base = valid.reviewPacket.items[0]!.rows[0]!;
    const fill = (prefix: string, maximum: number) =>
      prefix + "\u0001".repeat(maximum - prefix.length);
    const rows = Array.from({ length: 100 }, (_, ordinal) => {
      const beerName = fill(`beer-${ordinal}-`, 180);
      const normalizedBeerId = fill(`normalized-${ordinal}-`, 180);
      return {
        ordinal,
        priceRecord: {
          ...base.priceRecord,
          beerName,
          id: fill(`price-${ordinal}-`, 500),
          normalizedBeerId,
          suburb: fill(`suburb-${ordinal}-`, 180),
          venueName: fill(`venue-${ordinal}-`, 180),
        },
        venueBeer: {
          ...base.venueBeer,
          beerName,
          brewery: fill(`brewery-${ordinal}-`, 180),
          id: fill(`inventory-${ordinal}-`, 500),
          normalizedBeerId,
          style: fill(`style-${ordinal}-`, 180),
        },
      };
    });
    const rebound = rebindPlanArtifacts({
      ...valid,
      rows,
    });
    expect(canonicalPostgresReviewedPricePromotionJson(rebound.reviewPacket).length)
      .toBeGreaterThan(256 * 1_024);
    fixture.dependencies.buildPlan = vi.fn(async () => rebound);
    fixture.dependencies.assertPublicationBoundary = vi.fn((boundary) => {
      if (boundary === "plan-finalized") throw new Error("large packet rollback");
    });

    await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
      .resolves.toBe(1);

    expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
    expect(fs.existsSync(fixture.outputReviewPacketPath)).toBe(false);
    expect(JSON.parse(fixture.output[0]!)).toEqual({
      command: "plan",
      failureCode: "output_file_unsafe",
      ok: false,
    });
  });

  it("retains both committed artifacts without claiming success on summary failure", async () => {
    const summaryFailure = harness();
    summaryFailure.dependencies.writeOutput = vi.fn(() => {
      throw new Error(`summary ${PLANNER_PASSWORD}`);
    });
    await expect(runPostgresReviewedPricePromotionCli(summaryFailure.argv))
      .resolves.toBe(1);
    expect(summaryFailure.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(summaryFailure.outputPlanPath)).toBe(true);
    expect(fs.existsSync(summaryFailure.outputReviewPacketPath)).toBe(true);
    expect(summaryFailure.output).toEqual([]);

    summaryFailure.dependencies.writeOutput = (value) => {
      summaryFailure.output.push(value);
    };
    await expect(runPostgresReviewedPricePromotionCli(summaryFailure.argv))
      .resolves.toBe(0);
    expect(summaryFailure.release).toHaveBeenCalledTimes(1);
    expect(summaryFailure.buildPlan).toHaveBeenCalledTimes(1);
    expect(JSON.parse(summaryFailure.output[0]!)).toMatchObject({
      command: "plan",
      ok: true,
    });
  });

  it("does not attempt to unlink either committed artifact when stdout fails", async () => {
    const fixture = harness();
    const originalUnlink = fs.promises.unlink.bind(fs.promises);
    let replacementCalls = 0;
    vi.spyOn(fs.promises, "unlink").mockImplementation(async (filename) => {
      replacementCalls += 1;
      if (String(filename) === fixture.outputPlanPath) {
        throw Object.assign(new Error("plan unlink fixture"), { code: "EIO" });
      }
      await originalUnlink(filename);
    });
    fixture.dependencies.writeOutput = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error(`summary ${PLANNER_PASSWORD}`);
      })
      .mockImplementation((value: string) => fixture.output.push(value));

    await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
      .resolves.toBe(1);

    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(replacementCalls).toBe(0);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(true);
    expect(fs.existsSync(fixture.outputReviewPacketPath)).toBe(true);
    expect(JSON.parse(fixture.output[0]!)).toEqual({
      command: "plan",
      failureCode: "output_file_unsafe",
      ok: false,
    });
  });

  it("never mutates a committed artifact after stdout renames it and fails", async () => {
    const fixture = harness();
    const renamedPlanPath = path.join(fixture.root, "renamed-plan.json");
    fixture.dependencies.writeOutput = vi.fn()
      .mockImplementationOnce(() => {
        fs.renameSync(fixture.outputPlanPath, renamedPlanPath);
        throw new Error(`renamed summary ${PLANNER_PASSWORD}`);
      })
      .mockImplementation((value: string) => fixture.output.push(value));

    await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
      .resolves.toBe(1);

    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
    expect(fs.existsSync(fixture.outputReviewPacketPath)).toBe(true);
    expect(fs.existsSync(renamedPlanPath)).toBe(true);
    expect(fs.statSync(renamedPlanPath).size).toBeGreaterThan(0);
    expect(() => JSON.parse(fs.readFileSync(renamedPlanPath, "utf8")))
      .not.toThrow();
    expect(JSON.parse(fixture.output[0]!)).toEqual({
      command: "plan",
      failureCode: "output_file_unsafe",
      ok: false,
    });
  });

  it("uses the captured unlink primitive for an expired post-publication plan", async () => {
    const fixture = harness();
    let nowCalls = 0;
    fixture.dependencies.now = () => {
      nowCalls += 1;
      return new Date(nowCalls >= 5
        ? "2026-08-08T00:15:00.001Z"
        : NOW);
    };
    const originalUnlink = fs.promises.unlink.bind(fs.promises);
    let replacementCalls = 0;
    vi.spyOn(fs.promises, "unlink").mockImplementation(async (filename) => {
      replacementCalls += 1;
      if (String(filename) === fixture.outputPlanPath) {
        throw Object.assign(new Error("freshness unlink fixture"), { code: "EIO" });
      }
      await originalUnlink(filename);
    });

    await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
      .resolves.toBe(1);

    expect(nowCalls).toBe(5);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(replacementCalls).toBe(0);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
    expect(fs.existsSync(fixture.outputReviewPacketPath)).toBe(false);
    expect(JSON.parse(fixture.output[0]!)).toEqual({
      command: "plan",
      failureCode: "artifact_invalid",
      ok: false,
    });
  });

  it("accepts only whitelisted own-data failure codes", async () => {
    const accessor = harness();
    const accessorError = new PostgresReviewedPricePromotionPlanError("role_unsafe");
    Object.defineProperty(accessorError, "code", {
      configurable: true,
      get: () => {
        throw new Error(`getter ${PLANNER_PASSWORD}`);
      },
    });
    const pollutedDescriptor = Object.assign(Object.create(null) as object, {
      configurable: true,
      value: "role_unsafe",
    });
    const proxiedError = new Proxy(accessorError, {
      getOwnPropertyDescriptor: (target, property) => {
        if (property === "code") {
          Object.defineProperty(Object.prototype, "value", pollutedDescriptor);
          queueMicrotask(() => {
            delete (Object.prototype as { value?: unknown }).value;
          });
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    accessor.dependencies.buildPlan = vi.fn(async () => {
      throw proxiedError;
    });
    await expect(runPostgresReviewedPricePromotionCli(accessor.argv))
      .resolves.toBe(1);
    expect(accessor.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(accessor.outputPlanPath)).toBe(false);
    expect(JSON.parse(accessor.output[0]!)).toEqual({
      command: "plan",
      failureCode: "unexpected_failure",
      ok: false,
    });
    expect(accessor.output[0]).not.toContain(PLANNER_PASSWORD);

    const unlisted = harness();
    unlisted.dependencies.buildPlan = vi.fn(async () => {
      const error = new PostgresReviewedPricePromotionPlanError("role_unsafe");
      Object.defineProperty(error, "code", {
        configurable: true,
        value: `private-${PLANNER_PASSWORD}`,
      });
      throw error;
    });
    await expect(runPostgresReviewedPricePromotionCli(unlisted.argv))
      .resolves.toBe(1);
    expect(JSON.parse(unlisted.output[0]!).failureCode)
      .toBe("unexpected_failure");
    expect(unlisted.output[0]).not.toContain(PLANNER_PASSWORD);
  });

  it("opens Railway through the pinned stock-localhost transport and no connection string", async () => {
    const root = canonicalRoot();
    const rootCaFile = path.join(root, "railway-root-ca.pem");
    writePrivate(rootCaFile, TEST_ROOT_CA_PEM);
    const events: string[] = [];
    const ssl = Object.freeze({
      ca: TEST_ROOT_CA_PEM,
      servername: "localhost" as const,
      rejectUnauthorized: true as const,
      minVersion: "TLSv1.2" as const,
      checkServerIdentity: () => undefined,
    });
    const assertTransportExact = vi.fn(async () => {
      events.push("transport.assertExact");
    });
    const closeTransport = vi.fn(async () => {
      events.push("transport.close");
    });
    const transport = {
      nodeConnection: {
        host: "fd12:3456:789a::10",
        port: 5_432,
        ssl,
      },
      assertExact: assertTransportExact,
      close: closeTransport,
    };
    const openTransport = vi.fn(async () => {
      events.push("transport.open");
      return transport as never;
    });
    const capturedConfigs: Record<string, unknown>[] = [];
    const clientConstruct = vi.fn();
    class CapturedClient {
      constructor() {
        clientConstruct();
      }
    }
    const types = Object.freeze({ exact: true });
    const end = vi.fn(async () => {
      events.push("pool.end");
    });
    class CapturedPool {
      totalCount = 1;
      idleCount = 1;
      waitingCount = 0;

      constructor(config: Record<string, unknown>) {
        capturedConfigs.push(config);
        events.push("pool.construct");
      }

      on(): this {
        return this;
      }

      async connect() {
        events.push("pool.connect");
        return {
          release: () => events.push("client.release"),
        };
      }

      async query() {
        return { rowCount: 0, rows: [] };
      }

      end = end;
    }
    const loadPgRuntime = vi.fn(async () => {
      events.push("pg.load");
      return {
        Client: CapturedClient as never,
        Pool: CapturedPool as never,
        compileQuery: (text: string) => ({ text, values: [] }),
        createTypeOverrides: () => types as never,
      };
    });
    const options = plannerDatabaseOptions(rootCaFile);

    const handle = await openRailwayPlannerDatabase(options, {
        loadPgRuntime,
        openTransport,
      });

    expect(openTransport).toHaveBeenCalledWith({
      profile: "railway-stock-localhost-ca-v1",
      rootCaFile,
      expectedRootCaDerSha256: TEST_ROOT_CA_DER_SHA256,
      expectedUid: process.geteuid!(),
      sourceUrlAuthority: {
        hostname: "postgres-staging.railway.internal",
        port: 5_432,
      },
    });
    expect(capturedConfigs).toHaveLength(1);
    const config = capturedConfigs[0]!;
    expect(Object.hasOwn(config, "connectionString")).toBe(false);
    expect(config).toEqual({
      Client: expect.any(Function),
      host: "fd12:3456:789a::10",
      port: 5_432,
      database: "pintpath_staging",
      user: "pintpath_reviewed_price_planner",
      password: PLANNER_PASSWORD,
      ssl,
      application_name: "pintpath-reviewed-price-promotion-planner",
      max: 1,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 10_000,
      query_timeout: 30_000,
      options: "-c search_path=pg_catalog"
        + " -c default_transaction_read_only=on"
        + " -c row_security=on"
        + " -c statement_timeout=30000"
        + " -c idle_in_transaction_session_timeout=10000"
        + " -c lock_timeout=10000"
        + " -c synchronous_commit=on",
      types,
    });
    expect(config.ssl).toBe(ssl);
    expect(config.Client).not.toBe(CapturedClient);
    const previousClientEncoding = process.env.PGCLIENTENCODING;
    try {
      process.env.PGCLIENTENCODING = "private-deferred-client-poison";
      expect(() => new (config.Client as new () => unknown)())
        .toThrow(expect.objectContaining({ code: "argument_invalid" }));
      expect(clientConstruct).not.toHaveBeenCalled();

      delete process.env.PGCLIENTENCODING;
      expect(() => new (config.Client as new () => unknown)()).not.toThrow();
      expect(clientConstruct).toHaveBeenCalledTimes(1);
    } finally {
      if (previousClientEncoding === undefined) {
        delete process.env.PGCLIENTENCODING;
      } else {
        process.env.PGCLIENTENCODING = previousClientEncoding;
      }
    }
    expect(events).toEqual([
      "transport.open",
      "transport.assertExact",
      "pg.load",
      "transport.assertExact",
      "pool.construct",
      "transport.assertExact",
      "pool.connect",
      "client.release",
      "transport.assertExact",
    ]);

    events.length = 0;
    await handle.assertExact();
    await handle.release();
    await handle.release();
    expect(events).toEqual([
      "transport.assertExact",
      "transport.assertExact",
      "pool.end",
      "transport.close",
    ]);
    expect(end).toHaveBeenCalledTimes(1);
    expect(closeTransport).toHaveBeenCalledTimes(1);
  });

  it("validates database password options without live RegExp test dispatch", async () => {
    const root = canonicalRoot();
    const rootCaFile = path.join(root, "railway-root-ca.pem");
    writePrivate(rootCaFile, TEST_ROOT_CA_PEM);
    const transport = {
      nodeConnection: {
        host: "fd12:3456:789a::10",
        port: 5_432,
        ssl: Object.freeze({
          ca: TEST_ROOT_CA_PEM,
          servername: "localhost" as const,
          rejectUnauthorized: true as const,
          minVersion: "TLSv1.2" as const,
          checkServerIdentity: () => undefined,
        }),
      },
      assertExact: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    class CapturedPool {
      totalCount = 1;
      idleCount = 1;
      waitingCount = 0;
      on(): this { return this; }
      async connect() { return { release: () => undefined }; }
      async query() { return { rowCount: 0, rows: [] }; }
      async end() { return undefined; }
    }
    const descriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, "test")!;
    const originalTest = descriptor.value as typeof RegExp.prototype.test;
    let passwordTestCalls = 0;
    let handle: Awaited<ReturnType<typeof openRailwayPlannerDatabase>> | null = null;
    try {
      Object.defineProperty(RegExp.prototype, "test", {
        ...descriptor,
        value(this: RegExp, value: string) {
          if (value === PLANNER_PASSWORD) passwordTestCalls += 1;
          return Reflect.apply(originalTest, this, [value]);
        },
      });
      handle = await openRailwayPlannerDatabase(plannerDatabaseOptions(rootCaFile), {
        openTransport: async () => transport as never,
        loadPgRuntime: async () => ({
          Client: StubPlannerPgClient as never,
          Pool: CapturedPool as never,
          compileQuery: (text: string) => ({ text, values: [] }),
          createTypeOverrides: () => ({}) as never,
        }),
      });
    } finally {
      Object.defineProperty(RegExp.prototype, "test", descriptor);
    }

    expect(passwordTestCalls).toBe(0);
    expect(handle).not.toBeNull();
    await handle!.release();
  });

  it("closes transport on Pool startup failure and closes it after a failing Pool end", async () => {
    const root = canonicalRoot();
    const rootCaFile = path.join(root, "railway-root-ca.pem");
    writePrivate(rootCaFile, TEST_ROOT_CA_PEM);
    const options = plannerDatabaseOptions(rootCaFile);
    const events: string[] = [];
    const transport = () => ({
      nodeConnection: {
        host: "fd12:3456:789a::10",
        port: 5_432,
        ssl: {
          ca: TEST_ROOT_CA_PEM,
          servername: "localhost",
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          checkServerIdentity: () => undefined,
        },
      },
      assertExact: vi.fn(async () => events.push("transport.assertExact")),
      close: vi.fn(async () => events.push("transport.close")),
    });
    const firstTransport = transport();
    class ThrowingPool {
      constructor() {
        events.push("pool.construct");
        throw new Error(`pool startup ${PLANNER_PASSWORD}`);
      }
    }
    await expect(openRailwayPlannerDatabase(options, {
        openTransport: async () => firstTransport as never,
        loadPgRuntime: async () => ({
          Client: StubPlannerPgClient as never,
          Pool: ThrowingPool as never,
          compileQuery: (text: string) => ({ text, values: [] }),
          createTypeOverrides: () => ({}) as never,
        }),
      })).rejects.toThrow();
    expect(firstTransport.close).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toBe("transport.close");

    events.length = 0;
    const secondTransport = transport();
    class EndFailingPool {
      totalCount = 1;
      idleCount = 1;
      waitingCount = 0;
      on(): this { return this; }
      async connect() { return { release: () => undefined }; }
      async query() { return { rowCount: 0, rows: [] }; }
      async end() {
        events.push("pool.end");
        throw new Error(`pool end ${PLANNER_PASSWORD}`);
      }
    }
    const handle = await openRailwayPlannerDatabase(options, {
        openTransport: async () => secondTransport as never,
        loadPgRuntime: async () => ({
          Client: StubPlannerPgClient as never,
          Pool: EndFailingPool as never,
          compileQuery: (text: string) => ({ text, values: [] }),
          createTypeOverrides: () => ({}) as never,
        }),
      });
    events.length = 0;
    await expect(handle.release()).rejects.toMatchObject({
      code: "database_release_failed",
    });
    expect(events).toEqual([
      "transport.assertExact",
      "pool.end",
      "transport.close",
    ]);
    expect(secondTransport.close).toHaveBeenCalledTimes(1);
  });

  it("rechecks actual ambient pg authority around import, Pool, and initial connect", async () => {
    const root = canonicalRoot();
    const rootCaFile = path.join(root, "railway-root-ca.pem");
    writePrivate(rootCaFile, TEST_ROOT_CA_PEM);
    const options = plannerDatabaseOptions(rootCaFile);
    const previous = process.env.PGCLIENTENCODING;
    const close = vi.fn(async () => undefined);
    const transport = {
      nodeConnection: {
        host: "fd12:3456:789a::10",
        port: 5_432,
        ssl: {
          ca: TEST_ROOT_CA_PEM,
          servername: "localhost",
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          checkServerIdentity: () => undefined,
        },
      },
      assertExact: vi.fn(async () => undefined),
      close,
    };
    const loadPgRuntime = vi.fn(async () => {
      throw new Error("pg import must remain lazy");
    });
    try {
      process.env.PGCLIENTENCODING = "private-poison";
      await expect(openRailwayPlannerDatabase(options, {
        openTransport: async () => transport as never,
        loadPgRuntime,
      })).rejects.toMatchObject({ code: "argument_invalid" });
      expect(loadPgRuntime).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);

      delete process.env.PGCLIENTENCODING;
      close.mockClear();
      class PoisoningPool {
        totalCount = 0;
        idleCount = 0;
        waitingCount = 0;
        constructor() {
          process.env.PGCLIENTENCODING = "private-constructor-poison";
        }
        on(): this { return this; }
        async connect() { return { release: () => undefined }; }
        async query() { return { rowCount: 0, rows: [] }; }
        async end() { return undefined; }
      }
      await expect(openRailwayPlannerDatabase(options, {
        openTransport: async () => transport as never,
        loadPgRuntime: async () => ({
          Client: StubPlannerPgClient as never,
          Pool: PoisoningPool as never,
          compileQuery: (text: string) => ({ text, values: [] }),
          createTypeOverrides: () => ({}) as never,
        }),
      })).rejects.toMatchObject({ code: "argument_invalid" });
      expect(close).toHaveBeenCalledTimes(1);

      delete process.env.PGCLIENTENCODING;
      close.mockClear();
      let transportAssertions = 0;
      const deferredConnect = vi.fn(async () => ({
        release: () => undefined,
      }));
      const gapTransport = {
        ...transport,
        assertExact: vi.fn(async () => {
          transportAssertions += 1;
          if (transportAssertions === 3) {
            process.env.PGCLIENTENCODING = "private-connect-gap-poison";
          }
        }),
      };
      class DeferredClientPool {
        totalCount = 0;
        idleCount = 0;
        waitingCount = 0;
        on(): this { return this; }
        connect = deferredConnect;
        async query() { return { rowCount: 0, rows: [] }; }
        async end() { return undefined; }
      }
      await expect(openRailwayPlannerDatabase(options, {
        openTransport: async () => gapTransport as never,
        loadPgRuntime: async () => ({
          Client: StubPlannerPgClient as never,
          Pool: DeferredClientPool as never,
          compileQuery: (text: string) => ({ text, values: [] }),
          createTypeOverrides: () => ({}) as never,
        }),
      })).rejects.toMatchObject({ code: "argument_invalid" });
      expect(deferredConnect).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.PGCLIENTENCODING;
      else process.env.PGCLIENTENCODING = previous;
    }
  });

  it("guards every deferred Pool query and transaction connect", async () => {
    const root = canonicalRoot();
    const rootCaFile = path.join(root, "railway-root-ca.pem");
    writePrivate(rootCaFile, TEST_ROOT_CA_PEM);
    const previous = process.env.PGCLIENTENCODING;
    const connect = vi.fn(async () => ({
      query: vi.fn(async () => ({ rowCount: 0, rows: [] })),
      release: () => undefined,
    }));
    const query = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    class DeferredClientPool {
      totalCount = 1;
      idleCount = 1;
      waitingCount = 0;
      on(): this { return this; }
      connect = connect;
      query = query;
      async end() { return undefined; }
    }
    const transport = {
      nodeConnection: {
        host: "fd12:3456:789a::10",
        port: 5_432,
        ssl: {
          ca: TEST_ROOT_CA_PEM,
          servername: "localhost",
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          checkServerIdentity: () => undefined,
        },
      },
      assertExact: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    try {
      delete process.env.PGCLIENTENCODING;
      const handle = await openRailwayPlannerDatabase(
        plannerDatabaseOptions(rootCaFile),
        {
          openTransport: async () => transport as never,
          loadPgRuntime: async () => ({
            Client: StubPlannerPgClient as never,
            Pool: DeferredClientPool as never,
            compileQuery: (text: string) => ({ text, values: [] }),
            createTypeOverrides: () => ({}) as never,
          }),
        },
      );
      expect(connect).toHaveBeenCalledTimes(1);

      process.env.PGCLIENTENCODING = "private-query-poison";
      await expect(handle.database.prepare("SELECT 1").all())
        .rejects.toMatchObject({ code: "argument_invalid" });
      expect(query).not.toHaveBeenCalled();

      delete process.env.PGCLIENTENCODING;
      process.env.PGCLIENTENCODING = "private-transaction-poison";
      await expect(handle.database.transaction(async () => undefined)())
        .rejects.toMatchObject({ code: "argument_invalid" });
      expect(connect).toHaveBeenCalledTimes(1);

      delete process.env.PGCLIENTENCODING;
      await handle.release();
    } finally {
      if (previous === undefined) delete process.env.PGCLIENTENCODING;
      else process.env.PGCLIENTENCODING = previous;
    }
  });

  it("pins the package entry and keeps the production planner graph provider-neutral", () => {
    const packageJson = JSON.parse(fs.readFileSync(
      path.resolve(process.cwd(), "package.json"),
      "utf8",
    ));
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/postgres-reviewed-price-promotion.ts"),
      "utf8",
    );
    const runtimeSource = fs.readFileSync(
      path.resolve(
        process.cwd(),
        "scripts/lib/postgres-reviewed-price-promotion-runtime.ts",
      ),
      "utf8",
    );
    const databaseIdentitySource = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/postgres-database-identity.ts"),
      "utf8",
    );

    expect(packageJson.scripts["menus:promote-reviewed:postgres"]).toBeUndefined();
    expect(source).not.toMatch(/@supabase|service[_-]role|dotenv/);
    expect(databaseIdentitySource).toContain("postgres-migration-schema.js");
    expect(databaseIdentitySource).not.toMatch(
      /postgres-logical-state|postgres-migration-source|better-sqlite|@supabase|supabase-client/,
    );
    expect(runtimeSource).toContain("environment: process.env");
    expect(runtimeSource).toContain("const DATE_CONSTRUCTOR = Date;");
    expect(runtimeSource).toContain("now: () => new DATE_CONSTRUCTOR()");
    expect(runtimeSource).not.toContain("now: () => new Date()");
    expect(runtimeSource).toContain("const FS_WRITE_SYNC = fs.writeSync;");
    expect(runtimeSource).toContain("REFLECT_APPLY(FS_WRITE_SYNC, FS_OBJECT");
    expect(runtimeSource).not.toContain("runPostgresReviewedPricePromotionCliWithDependencies");
    expect(source).toContain('import postgresRuntime, {');
    expect(source).toContain('} from "pg";');
    expect(source).not.toContain('import("pg")');
    expect(source).not.toContain('import("../src/db/sql-database.js")');
    expect(runtimeSource).not.toContain('await import(');
    expect(source).not.toContain("runPostgresReviewedPricePromotionCliForTest");
    expect(runPostgresReviewedPricePromotionCli).toHaveLength(1);
    expect(source).not.toMatch(
      /applyPostgresMigration|quarantine|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE\s+TABLE/i,
    );
    expect(source).toContain("maxConnections: 1");
    expect(source).toContain("plan.mutationEnabled !== false");
    expect(source).toContain("POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS");
  });

  it("loads no Supabase or better-sqlite3 module before planner finalization", () => {
    const plannerUrl = pathToFileURL(path.resolve(
      process.cwd(),
      "scripts/postgres-reviewed-price-promotion.ts",
    )).href;
    const script = `
      const Module = (await import("node:module")).default;
      await import(${JSON.stringify(plannerUrl)});
      const loaded = Object.keys(Module._cache ?? {});
      const forbidden = loaded.filter((filename) => (
        filename.includes("/@supabase+")
        || filename.includes("/node_modules/@supabase/")
        || filename.includes("/better-sqlite3@")
        || filename.includes("/node_modules/better-sqlite3/")
      ));
      process.stdout.write(JSON.stringify(forbidden));
    `;
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
    expect(result.stderr).toBe("");
  });
});
