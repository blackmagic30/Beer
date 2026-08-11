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
  finalizePostgresMigrationReceipt,
  sha256PostgresMigrationTargetIdentity,
  type PostgresMigrationTargetIdentity,
} from "../src/db/postgres-migration-receipt.js";
import { sha256PostgresMigrationBytes } from
  "../src/db/postgres-migration-schema.js";
import type { SqlDatabase } from "../src/db/sql-database.js";
import { sha256PostgresDatabaseIdentity } from
  "../src/lib/postgres-database-identity.js";
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
  PostgresReviewedPricePromotionPlanError,
  canonicalPostgresReviewedPricePromotionJson,
  sha256PostgresReviewedPricePromotionValue,
  type PostgresReviewedPricePromotionPlanCandidate,
} from "../src/lib/postgres-reviewed-price-promotion-plan.js";

const CANDIDATE_SHA = "c".repeat(40);
const HASH = "a".repeat(64);
const INGESTION_ID = "11111111-1111-4111-8111-111111111111";
const PLANNER_PASSWORD = "PRIVATE_PLANNER_PASSWORD";
const NOW = "2026-08-08T00:00:00.000Z";
const ATTESTATION_STARTED_AT = "2026-08-07T23:59:59.000Z";
const ATTESTATION_EXPIRES_AT = "2026-08-08T00:15:00.000Z";

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

function planCandidate(input: {
  readonly deployment: {
    readonly deploymentIdSha256: string;
    readonly environmentIdSha256: string;
    readonly imageDigestSha256: string;
    readonly projectIdSha256: string;
    readonly serviceIdSha256: string;
  };
  readonly migrationReceiptFileSha256: string;
  readonly privateInputFileSha256: string;
  readonly physicalIdentitySha256: string;
  readonly plannerLoginIdentitySha256: string;
}): PostgresReviewedPricePromotionPlanCandidate {
  const withoutHash = {
    activationBlockers: [...POSTGRES_REVIEWED_PRICE_PROMOTION_ACTIVATION_BLOCKERS],
    candidateSha: CANDIDATE_SHA,
    expectedDeployment: input.deployment,
    expectedEnvironment: "permanent-staging" as const,
    kind: POSTGRES_REVIEWED_PRICE_PROMOTION_PLAN_KIND,
    migration: {
      approvalReferenceSha256: "1".repeat(64),
      completedAt: NOW,
      contractSha256: "2".repeat(64),
      manifestSha256: "3".repeat(64),
      operatorIdSha256: "4".repeat(64),
      planSha256: "5".repeat(64),
      receiptFileSha256: input.migrationReceiptFileSha256,
      receiptSha256: "6".repeat(64),
      runId: "7".repeat(64),
      runSnapshotSha256: "8".repeat(64),
      schemaMetadataSha256: "9".repeat(64),
      sourceSchemaFingerprint: "a".repeat(64),
      sourceSchemaSha256: "b".repeat(64),
      sourceSchemaVersion: 16,
      sourceSnapshotSha256: "c".repeat(64),
      startedAt: NOW,
      targetBindingSha256: "d".repeat(64),
      targetDdlSha256: "e".repeat(64),
      verifierIdSha256: "f".repeat(64),
    },
    mutationEnabled: false as const,
    privateInput: {
      evidenceSetSha256: "1".repeat(64),
      itemCount: 1,
      manifestSha256: input.privateInputFileSha256,
      marketedSuburb: "Fitzroy",
    },
    sourceSnapshot: {
      combinedSha256: "2".repeat(64),
      items: [{
        catalogRowsSha256: "3".repeat(64),
        queueSnapshotSha256: "4".repeat(64),
        selectedRowCount: 1,
        selectedRowsSha256: "5".repeat(64),
        sourceIngestionId: INGESTION_ID,
        venueIdSha256: "6".repeat(64),
        venueProfileSha256: "7".repeat(64),
      }],
      publicConflicts: {
        priceRecordCount: 0,
        rowsSha256: "8".repeat(64),
        venueBeerCount: 0,
      },
      selectionPolicySha256: "9".repeat(64),
      wrongPriceReports: {
        openOrInProgressCount: 0,
        rejectedCount: 0,
        resolvedCount: 0,
        rowsSha256: "a".repeat(64),
        totalCount: 0,
      },
    },
    target: {
      catalogIdentity: {
        currentUserSha256: "b".repeat(64),
        databaseNameSha256: "c".repeat(64),
        databaseOidSha256: "d".repeat(64),
        roleSafetySha256: "e".repeat(64),
        serverVersionNum: "170010",
        sessionUserSha256: "f".repeat(64),
        systemIdentifierSha256: "1".repeat(64),
      },
      physicalIdentitySha256: input.physicalIdentitySha256,
      plannerLoginIdentitySha256: input.plannerLoginIdentitySha256,
    },
    version: 3 as const,
  };
  return {
    ...withoutHash,
    planCandidateSha256: sha256PostgresReviewedPricePromotionValue(withoutHash),
  } as PostgresReviewedPricePromotionPlanCandidate;
}

function harness(): {
  readonly argv: readonly string[];
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
  const outputPlanPath = path.join(root, "plan-candidate.json");
  const identity = historicalIdentity();
  const migrationTargetIdentityBytes = canonicalPostgresReviewedPricePromotionJson(identity);
  const migrationTargetIdentitySha256 = sha256(migrationTargetIdentityBytes);
  const receipt = finalizePostgresMigrationReceipt({
    approvalReferenceSha256: "1".repeat(64),
    candidateSha: CANDIDATE_SHA,
    chunkCount: 1,
    columnCount: 1,
    contractSha256: "2".repeat(64),
    expectedEnvironment: "permanent-staging",
    foreignKeyCount: 0,
    keyRangesSha256: "3".repeat(64),
    kind: "pint-path-postgres-migration-receipt",
    manifestSha256: "4".repeat(64),
    operatorIdSha256: "5".repeat(64),
    planSha256: "6".repeat(64),
    rowCount: 1,
    runBindingSha256: "7".repeat(64),
    runIdSha256: "8".repeat(64),
    schemaMetadataSha256: "9".repeat(64),
    sourceSchemaFingerprint: "a".repeat(64),
    sourceSnapshotSha256: "b".repeat(64),
    stateTotalsSha256: "c".repeat(64),
    status: "ready",
    tableCount: 1,
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
  const privateInput = {
    itemCount: 1,
    items: [{
      evidenceContentSha256: "2".repeat(64),
      evidenceReferenceSha256: "3".repeat(64),
      sourceIngestionId: INGESTION_ID,
      venueIdSha256: "4".repeat(64),
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
  const expectedPlan = planCandidate({
    deployment,
    migrationReceiptFileSha256: sha256(migrationReceiptBytes),
    privateInputFileSha256: sha256(privateInputBytes),
    physicalIdentitySha256,
    plannerLoginIdentitySha256,
  });
  const database = { dialect: "postgres" } as SqlDatabase;
  const assertExact = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);
  const output: string[] = [];
  const buildPlan = vi.fn(async () => expectedPlan);
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
    "--output-plan", outputPlanPath,
  ] as const;
  cliRuntimeState.dependencies = dependencies as PostgresReviewedPricePromotionCliDependencies;
  return {
    argv,
    buildPlan,
    database,
    deployment,
    deploymentAttestationPath,
    dependencies,
    migrationReceiptPath,
    migrationTargetIdentityPath,
    output,
    outputPlanPath,
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
  it("creates only a new canonical 0600 plan and emits the exact secret-free summary", async () => {
    const fixture = harness();

    await expect(runPostgresReviewedPricePromotionCli(
      fixture.argv,
    )).resolves.toBe(0);

    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fixture.buildPlan).toHaveBeenCalledTimes(1);
    const plan = await fixture.buildPlan.mock.results[0]!.value;
    expect(fixture.buildPlan).toHaveBeenCalledWith(expect.objectContaining({
      expectedDeployment: fixture.deployment,
      expectedPhysicalDatabaseIdentitySha256: plan.target.physicalIdentitySha256,
    }));
    expect(plan.expectedDeployment).toEqual(fixture.deployment);
    expect(fixture.buildPlan.mock.calls[0]![0]).not.toHaveProperty(
      "expectedTargetIdentitySha256",
    );
    const planBytes = fs.readFileSync(fixture.outputPlanPath);
    expect(planBytes).toEqual(canonicalPostgresReviewedPricePromotionJson(plan));
    const stat = fs.lstatSync(fixture.outputPlanPath);
    expect(stat.mode & 0o7777).toBe(0o600);
    expect(stat.nlink).toBe(1);
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
    });
    for (const forbidden of [
      PLANNER_PASSWORD,
      fixture.plannerUrl,
      fixture.root,
      fixture.deploymentAttestationPath,
      fixture.plannerUrlPath,
      fixture.privateInputPath,
    ]) {
      expect(fixture.output[0]).not.toContain(forbidden);
    }
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
    expect(postgresReviewedPricePromotionCliInternals.ARGUMENT_COUNT).toBe(14);
    expect((harness().argv.length - 1) / 2).toBe(14);
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

  it("requires seven distinct files under one held private parent and validates the pinned CA", async () => {
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
      ...valid,
      mutationEnabled: true,
    }) as unknown as PostgresReviewedPricePromotionPlanCandidate);

    await expect(runPostgresReviewedPricePromotionCli(
      fixture.argv,
    )).resolves.toBe(1);

    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
    expect(JSON.parse(fixture.output[0]!).failureCode).toBe("plan_result_invalid");
  });

  it("rejects a validly rehashed plan that drifts a receipt-derived deployment hash", async () => {
    const fixture = harness();
    const valid = await fixture.buildPlan({} as never);
    const { planCandidateSha256: _validHash, ...validWithoutHash } = valid;
    const driftedWithoutHash = {
      ...validWithoutHash,
      expectedDeployment: {
        ...valid.expectedDeployment,
        deploymentIdSha256: "0".repeat(64),
      },
    };
    fixture.dependencies.buildPlan = vi.fn(async () => ({
      ...driftedWithoutHash,
      planCandidateSha256:
        sha256PostgresReviewedPricePromotionValue(driftedWithoutHash),
    }) as PostgresReviewedPricePromotionPlanCandidate);

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
      const { planCandidateSha256: _hash, ...withoutHash } = valid;
      const drifted = {
        ...withoutHash,
        expectedDeployment: {
          ...valid.expectedDeployment,
          deploymentIdSha256: "0".repeat(64),
        },
      };
      return {
        ...drifted,
        planCandidateSha256: sha256PostgresReviewedPricePromotionValue(drifted),
      } as PostgresReviewedPricePromotionPlanCandidate;
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
    for (const expireOnCall of [2, 3]) {
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
      const { planCandidateSha256: _validHash, ...validWithoutHash } = valid;
      const driftedWithoutHash = {
        ...validWithoutHash,
        target: {
          ...valid.target,
          [targetField]: "0".repeat(64),
        },
      };
      fixture.dependencies.buildPlan = vi.fn(async () => ({
        ...driftedWithoutHash,
        planCandidateSha256:
          sha256PostgresReviewedPricePromotionValue(driftedWithoutHash),
      }) as PostgresReviewedPricePromotionPlanCandidate);

      await expect(runPostgresReviewedPricePromotionCli(fixture.argv))
        .resolves.toBe(1);

      expect(fixture.release).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
      expect(JSON.parse(fixture.output[0]!).failureCode)
        .toBe("plan_result_invalid");
    }
  });

  it("never overwrites an existing output artifact", async () => {
    const fixture = harness();
    const sentinel = Buffer.from("operator-owned\n", "utf8");
    writePrivate(fixture.outputPlanPath, sentinel);

    await expect(runPostgresReviewedPricePromotionCli(
      fixture.argv,
    )).resolves.toBe(1);

    expect(fixture.release).not.toHaveBeenCalled();
    expect(fs.readFileSync(fixture.outputPlanPath)).toEqual(sentinel);
    expect(JSON.parse(fixture.output[0]!).failureCode).toBe("output_file_unsafe");
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

  it("rolls back the exact published inode on summary failure", async () => {
    const summaryFailure = harness();
    summaryFailure.dependencies.writeOutput = vi.fn(() => {
      throw new Error(`summary ${PLANNER_PASSWORD}`);
    });
    await expect(runPostgresReviewedPricePromotionCli(summaryFailure.argv))
      .resolves.toBe(1);
    expect(summaryFailure.release).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(summaryFailure.outputPlanPath)).toBe(false);
  });

  it("uses the captured unlink primitive when stdout fails", async () => {
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
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
    expect(JSON.parse(fixture.output[0]!)).toEqual({
      command: "plan",
      failureCode: "unexpected_failure",
      ok: false,
    });
  });

  it("invalidates the held plan inode when stdout renames it before failing", async () => {
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
    expect(fs.existsSync(renamedPlanPath)).toBe(true);
    expect(fs.statSync(renamedPlanPath).size).toBe(0);
    expect(() => JSON.parse(fs.readFileSync(renamedPlanPath, "utf8")))
      .toThrow();
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
      return new Date(nowCalls >= 3
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

    expect(nowCalls).toBe(3);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(replacementCalls).toBe(0);
    expect(fs.existsSync(fixture.outputPlanPath)).toBe(false);
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
