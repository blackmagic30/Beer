import crypto from "node:crypto";
import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_MAINTENANCE_ROLE_LIMIT_ADVISORY_LOCK_QUERY,
  PRODUCTION_MAINTENANCE_ROLE_LIMIT_ALTER,
  PRODUCTION_MAINTENANCE_ROLE_LIMIT_CATALOG_QUERY,
  PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_PATH,
  PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
  protectedProductionMaintenanceRoleLimitInternals,
  runProtectedProductionMaintenanceRoleLimit,
  type ProductionMaintenanceRoleLimitConnection,
} from "../scripts/execute-protected-production-maintenance-role-limit.js";

const CANDIDATE = "a".repeat(40);
const OTHER_CANDIDATE = "b".repeat(40);
const ROOT_CA_DER_SHA256 = "c".repeat(64);
const NOW = new Date("2026-08-21T01:02:03.000Z");
const EVIDENCE = "/private/evidence";
const INTENT = `${EVIDENCE}/intent.json`;
const PREREQUISITES = `${EVIDENCE}/prerequisites-verification.json`;
const RECONCILIATION_AUTHORITY =
  `${EVIDENCE}/reconciliation-authority-verification.json`;
const CREDENTIAL = "/private/credentials/admin-url.secret";
const ROOT_CA = "/private/credentials/root-ca.pem";
const FENCE_RUN_ID = "701";
const DEPLOYMENT_RUN_ID = "801";
const ADMIN_URL =
  "postgresql://postgres:synthetic-test-password@postgres-production.railway.internal:5432/pintpath?sslmode=verify-full"; // security-scan allow: synthetic test-only connection fixture

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function prerequisitesVerification(candidateSha = CANDIDATE): string {
  const hash = "d".repeat(64);
  return canonical({
    schemaVersion: "pintpath-production-maintenance-login-limit-prerequisites/v1",
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    candidateSha,
    repository: "blackmagic30/Beer",
    consumer: {
      workflowPath:
        ".github/workflows/transition-production-postgres-maintenance-role-limit.yml",
      githubEnvironment: "production-postgres-maintenance-role-limit",
      runId: "1001",
      runAttempt: 1,
      startedAt: "2026-08-21T00:58:03.000Z",
    },
    workerFence: {
      workflowPath:
        ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
      runId: FENCE_RUN_ID,
      runAttempt: 1,
      startedAt: "2026-08-21T00:50:03.000Z",
      completedAt: "2026-08-21T00:52:03.000Z",
      artifactName:
        `pintpath-automatic-maintenance-worker-fence-production-fence-${candidateSha}`,
      artifactId: "1701",
      artifactDigest: `sha256:${hash}`,
      artifactSizeBytes: 4096,
      policySha256:
        "260a15eb364fe6e95a40b1e15af8950f8ea6f8ccd1f3b0983ef4a39810ea57bb",
      producerSha256:
        "50a1e90da8f5d814c34d184f12c754d89d247ab2a19cd20ee87fe2119feb3693",
      producerWorkflowSha256:
        "8b0cc5a0c972da5c176b895e9a0105b3062466f45e3d797fc55fcbf4bffcdc86",
      terminalSha256: hash,
      bindingSha256: hash,
      intentSha256: hash,
    },
    productionDeployment: {
      workflowPath: ".github/workflows/deploy-production.yml",
      runId: DEPLOYMENT_RUN_ID,
      runAttempt: 1,
      startedAt: "2026-08-21T00:53:03.000Z",
      completedAt: "2026-08-21T00:57:03.000Z",
      artifactName: `pintpath-production-deployment-${candidateSha}`,
      artifactId: "1801",
      artifactDigest: `sha256:${hash}`,
      artifactSizeBytes: 8192,
      policySha256:
        "73bebbbbd71f2bc297c486b6dcb137b5a224fc0dcd944d5e30e1ce5a321cfa43",
      producerSha256:
        "35dea44121eb5ac9de6a89602838fd54394574005ed11594284d75d1f7f77492",
      producerWorkflowSha256:
        "517158926950ff623482a84fb3516c4218858f7f59fc9a7552c930eaa156768f",
      receiptSha256: hash,
      deploymentIdSha256: hash,
      replicaCount: 1,
    },
    verifiedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
    checks: {
      policiesExact: true,
      consumerRunAuthorityExact: true,
      fenceRunAuthorityExact: true,
      fenceArtifactAuthorityExact: true,
      downloadActionPinExact: true,
      uniquePrerequisiteReceiptsExact: true,
      independentArtifactArchiveDigestsExact: true,
      localReceiptBytesMatchArchivesExact: true,
      fenceReceiptExact: true,
      fenceWorkersDisabledExact: true,
      fenceCandidateBindingExact: true,
      fenceDeploymentUnchangedExact: true,
      deploymentRunAuthorityExact: true,
      deploymentArtifactAuthorityExact: true,
      deploymentReceiptExact: true,
      deploymentRuntimeWorkersDisabledExact: true,
      deploymentRuntimeCandidateBindingExact: true,
      deploymentSoleHealthyCandidateExact: true,
      chronologyExact: true,
      noLaterProductionWorkerFenceRunExact: true,
      noLaterProductionDeploymentRunExact: true,
      noLaterProductionScaleRunExact: true,
      noPriorRoleLimitApplyRunExact: true,
      evidenceSecretFreeExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function environment(
  mode: "apply" | "reconcile",
  runId: string,
  candidateSha = CANDIDATE,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "blackmagic30/Beer",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: candidateSha,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: runId,
    GITHUB_WORKFLOW_REF:
      "blackmagic30/Beer/.github/workflows/transition-production-postgres-maintenance-role-limit.yml@refs/heads/main",
    PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_GITHUB_ENVIRONMENT:
      "production-postgres-maintenance-role-limit",
    PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_MODE: mode,
    PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_CONFIRMATION: mode === "apply"
      ? "ALTER_PRIVACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT_2_TO_8"
      : "RECONCILE_PRIVACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT_8",
    ...overrides,
  };
}

function prepareArguments(candidateSha = CANDIDATE): string[] {
  return [
    "--phase",
    "prepare",
    "--candidate-sha",
    candidateSha,
    "--evidence-dir",
    EVIDENCE,
    "--root-ca-der-sha256",
    ROOT_CA_DER_SHA256,
    "--fence-run-id",
    FENCE_RUN_ID,
    "--deployment-run-id",
    DEPLOYMENT_RUN_ID,
    "--prerequisites-verification-file",
    PREREQUISITES,
  ];
}

function applyArguments(candidateSha = CANDIDATE): string[] {
  return [
    "--phase",
    "apply",
    "--candidate-sha",
    candidateSha,
    "--evidence-dir",
    EVIDENCE,
    "--root-ca-der-sha256",
    ROOT_CA_DER_SHA256,
    "--fence-run-id",
    FENCE_RUN_ID,
    "--deployment-run-id",
    DEPLOYMENT_RUN_ID,
    "--prerequisites-verification-file",
    PREREQUISITES,
    "--intent-file",
    INTENT,
    "--credential-file",
    CREDENTIAL,
    "--root-ca-file",
    ROOT_CA,
  ];
}

function reconcileArguments(
  priorRunId: string,
  candidateSha = CANDIDATE,
): string[] {
  return [
    "--phase",
    "reconcile",
    "--candidate-sha",
    candidateSha,
    "--evidence-dir",
    EVIDENCE,
    "--root-ca-der-sha256",
    ROOT_CA_DER_SHA256,
    "--intent-file",
    INTENT,
    "--prior-run-id",
    priorRunId,
    "--prerequisites-verification-file",
    PREREQUISITES,
    "--reconciliation-authority-file",
    RECONCILIATION_AUTHORITY,
    "--credential-file",
    CREDENTIAL,
    "--root-ca-file",
    ROOT_CA,
  ];
}

function catalogRow(
  connectionLimit: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    databaseName: "pintpath",
    sessionUser: "postgres",
    currentUser: "postgres",
    serverVersionNum: "170010",
    observedAt: NOW.toISOString(),
    authorityRoleName: "postgres",
    authorityCanLogin: true,
    authorityIsSuperuser: true,
    authorityCanCreateRole: true,
    loginRoleName: "privacy_maintenance_login",
    loginCanLogin: true,
    loginIsSuperuser: false,
    loginCanCreateDatabase: false,
    loginCanCreateRole: false,
    loginInheritsPrivileges: false,
    loginCanReplicate: false,
    loginBypassesRls: false,
    loginConnectionLimit: connectionLimit,
    loginValidUntilNull: true,
    loginMembershipExact: true,
    loginChildrenAbsent: true,
    loginRoleSettingsAbsent: true,
    groupRoleName: "pintpath_maintenance",
    groupCanLogin: false,
    groupIsSuperuser: false,
    groupCanCreateDatabase: false,
    groupCanCreateRole: false,
    groupInheritsPrivileges: false,
    groupCanReplicate: false,
    groupBypassesRls: false,
    groupConnectionLimit: -1,
    groupValidUntilNull: true,
    groupParentsAbsent: true,
    groupSoleMemberExact: true,
    groupRoleSettingsAbsent: true,
    ...overrides,
  };
}

interface DatabaseState {
  connectionLimit: number;
  alterCount: number;
  advisoryLock: boolean;
  commitLostAcknowledgement: boolean;
  catalogOverrides: Record<string, unknown>;
  closeFailureConnections: ReadonlySet<number>;
  statements: string[];
}

class FakeConnection implements ProductionMaintenanceRoleLimitConnection {
  private writeTransaction = false;
  private altered = false;

  constructor(
    private readonly state: DatabaseState,
    private readonly connectionNumber: number,
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
  ): Promise<{ rows: readonly Row[]; rowCount: number | null }> {
    this.state.statements.push(text);
    if (text === PRODUCTION_MAINTENANCE_ROLE_LIMIT_CATALOG_QUERY) {
      return {
        rows: [catalogRow(
          this.state.connectionLimit,
          this.state.catalogOverrides,
        ) as Row],
        rowCount: 1,
      };
    }
    if (text === PRODUCTION_MAINTENANCE_ROLE_LIMIT_ADVISORY_LOCK_QUERY) {
      return {
        rows: [{ locked: this.state.advisoryLock } as Row],
        rowCount: 1,
      };
    }
    if (text.includes(":write-begin")) {
      this.writeTransaction = true;
    }
    if (text === PRODUCTION_MAINTENANCE_ROLE_LIMIT_ALTER) {
      expect(this.writeTransaction).toBe(true);
      this.state.alterCount += 1;
      this.state.connectionLimit = 8;
      this.altered = true;
    }
    if (text.includes(":write-commit")) {
      this.writeTransaction = false;
      if (this.altered && this.state.commitLostAcknowledgement) {
        throw new Error("synthetic_lost_commit_acknowledgement");
      }
    }
    if (text.includes(":write-rollback")) {
      this.writeTransaction = false;
    }
    return { rows: [], rowCount: null };
  }

  async assertExact(): Promise<void> {}

  async close(): Promise<void> {
    if (this.state.closeFailureConnections.has(this.connectionNumber)) {
      throw new Error("synthetic_connection_close_failure");
    }
  }
}

function harness(input: {
  initialLimit?: number;
  advisoryLock?: boolean;
  commitLostAcknowledgement?: boolean;
  catalogOverrides?: Record<string, unknown>;
  closeFailureConnections?: readonly number[];
  repositoryResults?: boolean[];
} = {}) {
  const files = new Map<string, string>([
    [CREDENTIAL, ADMIN_URL],
    [ROOT_CA, "synthetic-root-ca"],
    [PREREQUISITES, prerequisitesVerification()],
  ]);
  const outputs: string[] = [];
  const state: DatabaseState = {
    connectionLimit: input.initialLimit ?? 2,
    alterCount: 0,
    advisoryLock: input.advisoryLock ?? true,
    commitLostAcknowledgement: input.commitLostAcknowledgement ?? false,
    catalogOverrides: input.catalogOverrides ?? {},
    closeFailureConnections: new Set(input.closeFailureConnections ?? []),
    statements: [],
  };
  let connectionCount = 0;
  const repositoryResults = [...(input.repositoryResults ?? [true, true])];
  const dependencies = {
    cwd: process.cwd(),
    now: () => new Date(NOW),
    connect: vi.fn(async () => {
      connectionCount += 1;
      return new FakeConnection(state, connectionCount);
    }),
    reassertRepository: vi.fn(async () => repositoryResults.shift() ?? true),
    readPrivateFile: (filename: string) => {
      const source = files.get(filename);
      if (source === undefined) throw new Error("missing_test_file");
      return Buffer.from(source, "utf8");
    },
    writeEvidence: (_directory: string, leaf: string, source: string) => {
      files.set(`${EVIDENCE}/${leaf}`, source);
      return digest(source);
    },
    writeOutput: (source: string) => outputs.push(source),
  };
  return {
    files,
    outputs,
    state,
    dependencies,
    connectionCount: () => connectionCount,
  };
}

async function prepareIntent(
  target: ReturnType<typeof harness>,
  runId = "1001",
  candidateSha = CANDIDATE,
): Promise<void> {
  const result = await runProtectedProductionMaintenanceRoleLimit({
    ...target.dependencies,
    argv: prepareArguments(candidateSha),
    env: environment("apply", runId, candidateSha),
  });
  expect(result).toBe(0);
  expect(target.files.has(INTENT)).toBe(true);
  const intentSource = target.files.get(INTENT)!;
  const prerequisitesSource = target.files.get(PREREQUISITES)!;
  target.files.set(RECONCILIATION_AUTHORITY, canonical({
    schemaVersion:
      "pintpath-production-maintenance-role-limit-reconciliation-authority/v1",
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    candidateSha,
    repository: "blackmagic30/Beer",
    consumer: {
      workflowPath:
        ".github/workflows/transition-production-postgres-maintenance-role-limit.yml",
      githubEnvironment: "production-postgres-maintenance-role-limit",
      runId: "2002",
      runAttempt: 1,
      startedAt: "2026-08-21T01:01:00.000Z",
    },
    priorApply: {
      workflowPath:
        ".github/workflows/transition-production-postgres-maintenance-role-limit.yml",
      runId,
      runAttempt: 1,
      conclusion: "failure",
      startedAt: "2026-08-21T00:59:00.000Z",
      completedAt: "2026-08-21T01:00:00.000Z",
      artifactName:
        `pintpath-production-maintenance-role-limit-intent-${candidateSha}-${runId}`,
      artifactId: "9901",
      artifactDigest: `sha256:${"e".repeat(64)}`,
      artifactSizeBytes: 4096,
      intentSha256: digest(intentSource),
      prerequisitesSha256: digest(prerequisitesSource),
    },
    verifiedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
    checks: {
      policiesExact: true,
      consumerRunAuthorityExact: true,
      priorApplyRunAuthorityExact: true,
      priorIntentArtifactAuthorityExact: true,
      independentPriorArchiveDigestExact: true,
      localPriorFilesMatchArchiveExact: true,
      priorIntentExact: true,
      priorPrerequisiteBindingExact: true,
      noNewMutationPrerequisitesRequiredExact: true,
      noLaterRoleApplyRunExact: true,
      evidenceSecretFreeExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  }));
  target.outputs.length = 0;
}

describe("protected production maintenance LOGIN limit transition", () => {
  it("pins the exact policy, read-only catalog query, one ALTER, and advisory lock", () => {
    const policy = fs.readFileSync(PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_PATH);
    expect(digest(policy)).toBe(
      PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    );
    expect(JSON.parse(policy.toString("utf8"))).toMatchObject({
      activationState: "GITHUB_ENVIRONMENT_PROTECTED",
      target: {
        environment: "production",
        authorityLogin: "postgres",
        loginRole: "privacy_maintenance_login",
        groupRole: "pintpath_maintenance",
        expectedOldConnectionLimit: 2,
        desiredConnectionLimit: 8,
      },
      writeContract: {
        maximumAlterRoleStatements: 1,
        maximumWriteAttempts: 1,
        automaticRetryAllowed: false,
        rerunAllowed: false,
      },
      mutationPrerequisites: {
        applyOnly: true,
        workerFence: {
          requiredTarget: "production",
          requiredOperation: "fence",
          workersEnabledValue: "false",
        },
        productionDeployment: {
          requiredTarget: "production",
          runtimeWorkersEnabledRequired: false,
          runtimeCandidateBindingRequired: true,
          soleHealthyCandidateRequired: true,
          requiredReplicaCount: 1,
        },
      },
    });
    expect(PRODUCTION_MAINTENANCE_ROLE_LIMIT_CATALOG_QUERY).toContain(
      "FROM pg_catalog.pg_roles",
    );
    expect(PRODUCTION_MAINTENANCE_ROLE_LIMIT_CATALOG_QUERY).not.toMatch(
      /\b(?:alter|insert|update|delete|grant|revoke|create|drop|truncate)\b/i,
    );
    expect(PRODUCTION_MAINTENANCE_ROLE_LIMIT_ADVISORY_LOCK_QUERY).toContain(
      "pg_try_advisory_xact_lock",
    );
    expect(PRODUCTION_MAINTENANCE_ROLE_LIMIT_ALTER).toBe(
      "/* pintpath:production-maintenance-role-limit:single-write */ ALTER ROLE privacy_maintenance_login CONNECTION LIMIT 8",
    );
    expect(
      protectedProductionMaintenanceRoleLimitInternals
        .exactNonRootProcessIdentity(1000, 1000),
    ).toBe(true);
    expect(
      protectedProductionMaintenanceRoleLimitInternals
        .exactNonRootProcessIdentity(0, 0),
    ).toBe(false);
    expect(
      protectedProductionMaintenanceRoleLimitInternals
        .exactNonRootProcessIdentity(1000, 1001),
    ).toBe(false);
  });

  it("persists a canonical secret-free intent before any connection", async () => {
    const target = harness();
    await prepareIntent(target);
    expect(target.connectionCount()).toBe(0);
    const intent = target.files.get(INTENT)!;
    expect(`${JSON.stringify(JSON.parse(intent), null, 2)}\n`).toBe(intent);
    expect(intent).toContain(CANDIDATE);
    expect(intent).toContain(PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256);
    expect(intent).toContain(digest(prerequisitesVerification()));
    expect(intent).toContain(FENCE_RUN_ID);
    expect(intent).toContain(DEPLOYMENT_RUN_ID);
    expect(intent).not.toContain("synthetic-test-password");
    expect(intent).not.toContain(ADMIN_URL);
  });

  it("changes exactly the canonical LOGIN from 2 to 8 once and reconciles on a fresh connection", async () => {
    const target = harness();
    await prepareIntent(target);
    const result = await runProtectedProductionMaintenanceRoleLimit({
      ...target.dependencies,
      argv: applyArguments(),
      env: environment("apply", "1001"),
    });
    expect(result).toBe(0);
    expect(target.state.connectionLimit).toBe(8);
    expect(target.state.alterCount).toBe(1);
    expect(target.connectionCount()).toBe(2);
    const writeBegin = target.state.statements.findIndex((value) =>
      value.includes(":write-begin"));
    const lock = target.state.statements.indexOf(
      PRODUCTION_MAINTENANCE_ROLE_LIMIT_ADVISORY_LOCK_QUERY,
    );
    const alter = target.state.statements.indexOf(
      PRODUCTION_MAINTENANCE_ROLE_LIMIT_ALTER,
    );
    const commit = target.state.statements.findIndex((value) =>
      value.includes(":write-commit"));
    expect(writeBegin).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(writeBegin);
    expect(alter).toBeGreaterThan(lock);
    expect(commit).toBeGreaterThan(alter);
    const output = JSON.parse(target.outputs.at(-1)!);
    expect(output).toMatchObject({
      ok: true,
      outcome: "updated",
      writeAttempts: 1,
      retryAllowed: false,
    });
    const evidence = [...target.files.entries()]
      .filter(([filename]) => filename.startsWith(`${EVIDENCE}/`))
      .map(([, source]) => source)
      .join("\n");
    expect(evidence).not.toContain("synthetic-test-password");
    expect(evidence).not.toContain(ADMIN_URL);
    expect(JSON.parse(target.files.get(`${EVIDENCE}/receipt.json`)!)).toMatchObject({
      candidateSha: CANDIDATE,
      policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
      writeAttempts: 1,
      retryAllowed: false,
      checks: {
        advisoryLockExact: true,
        immediateCatalogPrewriteExact: true,
        oneAlterRoleAtMost: true,
        automaticRetryAbsent: true,
        postflightAttempted: true,
        catalogPostflightExact: true,
        primaryConnectionCleanupExact: true,
        postflightConnectionCleanupExact: true,
        prerequisiteIntentBindingExact: true,
        prerequisiteVerificationExact: true,
        terminalEvidenceExact: true,
        receiptEvidenceExact: true,
      },
    });
  });

  it("never retries a lost commit acknowledgement and reconciles limit 8 read-only", async () => {
    const target = harness({ commitLostAcknowledgement: true });
    await prepareIntent(target);
    const result = await runProtectedProductionMaintenanceRoleLimit({
      ...target.dependencies,
      argv: applyArguments(),
      env: environment("apply", "1001"),
    });
    expect(result).toBe(0);
    expect(target.state.alterCount).toBe(1);
    expect(target.connectionCount()).toBe(2);
    expect(JSON.parse(target.outputs.at(-1)!)).toMatchObject({
      ok: true,
      outcome: "reconciled_after_ambiguous_write",
      writeAttempts: 1,
      retryAllowed: false,
    });
  });

  it("fails closed after a primary connection close failure while still reconciling read-only", async () => {
    const target = harness({ closeFailureConnections: [1] });
    await prepareIntent(target);
    const result = await runProtectedProductionMaintenanceRoleLimit({
      ...target.dependencies,
      argv: applyArguments(),
      env: environment("apply", "1001"),
    });
    expect(result).toBe(1);
    expect(target.state.alterCount).toBe(1);
    expect(target.connectionCount()).toBe(2);
    expect(JSON.parse(target.outputs.at(-1)!)).toMatchObject({
      ok: false,
      outcome: "mutation_uncertain",
      failureCode: "mutation_uncertain",
      writeAttempts: 1,
    });
    expect(JSON.parse(target.files.get(`${EVIDENCE}/receipt.json`)!)).toMatchObject({
      checks: {
        catalogPostflightExact: true,
        primaryConnectionCleanupExact: false,
        postflightConnectionCleanupExact: true,
      },
    });
  });

  it("fails closed when the fresh reconciliation connection cannot close", async () => {
    const target = harness({ closeFailureConnections: [2] });
    await prepareIntent(target);
    const result = await runProtectedProductionMaintenanceRoleLimit({
      ...target.dependencies,
      argv: applyArguments(),
      env: environment("apply", "1001"),
    });
    expect(result).toBe(1);
    expect(target.state.alterCount).toBe(1);
    expect(target.connectionCount()).toBe(2);
    expect(JSON.parse(target.outputs.at(-1)!)).toMatchObject({
      ok: false,
      outcome: "mutation_uncertain",
      failureCode: "mutation_uncertain",
      writeAttempts: 1,
    });
    expect(JSON.parse(target.files.get(`${EVIDENCE}/receipt.json`)!)).toMatchObject({
      checks: {
        catalogPostflightExact: true,
        primaryConnectionCleanupExact: true,
        postflightConnectionCleanupExact: false,
      },
    });
  });

  it("rejects a missing or changed prerequisite verification before credential custody", async () => {
    const target = harness();
    await prepareIntent(target);
    const parsed = JSON.parse(target.files.get(PREREQUISITES)!);
    parsed.checks.deploymentSoleHealthyCandidateExact = false;
    target.files.set(PREREQUISITES, canonical(parsed));
    const result = await runProtectedProductionMaintenanceRoleLimit({
      ...target.dependencies,
      argv: applyArguments(),
      env: environment("apply", "1001"),
    });
    expect(result).toBe(1);
    expect(target.connectionCount()).toBe(0);
    expect(target.state.alterCount).toBe(0);
    expect(JSON.parse(target.outputs.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "prerequisite_invalid",
      writeAttempts: 0,
    });
  });

  it("rejects an already-8 apply and permits only prior-run exact-candidate reconciliation", async () => {
    const target = harness({ initialLimit: 8 });
    await prepareIntent(target, "1001");
    const apply = await runProtectedProductionMaintenanceRoleLimit({
      ...target.dependencies,
      argv: applyArguments(),
      env: environment("apply", "1001"),
    });
    expect(apply).toBe(1);
    expect(target.state.alterCount).toBe(0);
    target.outputs.length = 0;
    const reconcile = await runProtectedProductionMaintenanceRoleLimit({
      ...target.dependencies,
      argv: reconcileArguments("1001"),
      env: environment("reconcile", "2002"),
    });
    expect(reconcile).toBe(0);
    expect(target.state.alterCount).toBe(0);
    expect(JSON.parse(target.outputs.at(-1)!)).toMatchObject({
      ok: true,
      outcome: "reconciled_from_prior_intent",
      writeAttempts: 0,
    });
  });

  it("conclusively reconciles a cancelled-before-commit prior intent at limit 2 without writing", async () => {
    const target = harness({ initialLimit: 2 });
    await prepareIntent(target, "1001");
    const reconcile = await runProtectedProductionMaintenanceRoleLimit({
      ...target.dependencies,
      argv: reconcileArguments("1001"),
      env: environment("reconcile", "2002"),
    });
    expect(reconcile).toBe(0);
    expect(target.state.alterCount).toBe(0);
    expect(JSON.parse(target.outputs.at(-1)!)).toMatchObject({
      ok: true,
      outcome: "not_applied_after_prior_intent",
      writeAttempts: 0,
    });
  });

  it("fails closed when the read-only reconciliation connection cannot close", async () => {
    const target = harness({
      initialLimit: 8,
      closeFailureConnections: [1],
    });
    await prepareIntent(target, "1001");
    const reconcile = await runProtectedProductionMaintenanceRoleLimit({
      ...target.dependencies,
      argv: reconcileArguments("1001"),
      env: environment("reconcile", "2002"),
    });
    expect(reconcile).toBe(1);
    expect(target.connectionCount()).toBe(1);
    expect(target.state.alterCount).toBe(0);
    expect(JSON.parse(target.outputs.at(-1)!)).toMatchObject({
      ok: false,
      outcome: "failed_before_write",
      failureCode: "transport_invalid",
      writeAttempts: 0,
    });
    expect(JSON.parse(target.files.get(`${EVIDENCE}/receipt.json`)!)).toMatchObject({
      checks: {
        primaryConnectionCleanupExact: false,
        postflightConnectionCleanupExact: true,
      },
    });
  });

  it("rejects candidate, role, membership, lock, and repository drift before ALTER", async () => {
    const cases = [
      harness({ catalogOverrides: { loginRoleName: "other_login" } }),
      harness({ catalogOverrides: { loginMembershipExact: false } }),
      harness({ catalogOverrides: { groupConnectionLimit: 2 } }),
      harness({ advisoryLock: false }),
      harness({ repositoryResults: [true, false] }),
    ];
    for (const target of cases) {
      await prepareIntent(target);
      const result = await runProtectedProductionMaintenanceRoleLimit({
        ...target.dependencies,
        argv: applyArguments(),
        env: environment("apply", "1001"),
      });
      expect(result).toBe(1);
      expect(target.state.alterCount).toBe(0);
    }

    const candidate = harness({ initialLimit: 8 });
    await prepareIntent(candidate, "1001", CANDIDATE);
    const mismatched = await runProtectedProductionMaintenanceRoleLimit({
      ...candidate.dependencies,
      argv: reconcileArguments("1001", OTHER_CANDIDATE),
      env: environment("reconcile", "2002", OTHER_CANDIDATE),
    });
    expect(mismatched).toBe(1);
    expect(candidate.state.alterCount).toBe(0);
  });

  it("refuses every ambient libpq or application database authority", async () => {
    for (const key of [
      "PGHOST",
      "PGPASSWORD",
      "PGSERVICEFILE",
      "PGSSLMODE",
      "DATABASE_URL",
      "DATABASE_MAINTENANCE_URL",
    ]) {
      const target = harness();
      const result = await runProtectedProductionMaintenanceRoleLimit({
        ...target.dependencies,
        argv: prepareArguments(),
        env: environment("apply", "1001", CANDIDATE, { [key]: "" }),
      });
      expect(result, key).toBe(1);
      expect(target.connectionCount(), key).toBe(0);
      expect(target.files.has(INTENT), key).toBe(false);
      expect(JSON.parse(target.outputs.at(-1)!)).toMatchObject({
        ok: false,
        failureCode: "ambient_postgres_authority_present",
        writeAttempts: 0,
      });
    }
  });

  it("keeps the manual workflow protected, non-cancelling, and intent-first", () => {
    const workflow = fs.readFileSync(
      ".github/workflows/transition-production-postgres-maintenance-role-limit.yml",
      "utf8",
    );
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s*(?:push|pull_request|schedule):/m);
    expect(workflow).toContain("environment: production-postgres-maintenance-role-limit");
    expect(workflow).toContain("      - pintpath-production-postgres");
    expect(workflow).toContain("group: pintpath-production-rollout");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("test \"$RUN_ATTEMPT\" = 1");
    expect(workflow).toContain("test \"$DISPATCH_SHA\" = \"$CANDIDATE_SHA\"");
    expect(workflow).toContain("worker_fence_run_id:");
    expect(workflow).toContain("production_deployment_run_id:");
    expect(workflow).toContain(
      "pintpath-automatic-maintenance-worker-fence-production-fence-${{ inputs.candidate_sha }}",
    );
    expect(workflow).toContain(
      "pintpath-production-deployment-${{ inputs.candidate_sha }}",
    );
    expect(workflow).toContain(
      "ALTER_PRIVACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT_2_TO_8",
    );
    expect(workflow).toContain(
      "RECONCILE_PRIVACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT_8",
    );
    expect(workflow).toContain(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(workflow).toContain(
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    );
    expect(workflow).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(workflow).toContain(
      "actions/download-artifact@b7c52a5f7a25fce4c22e476a93420dd79a061a70",
    );
    const repositoryGate = workflow.indexOf("npm run check");
    const prerequisiteVerifier = workflow.indexOf(
      "Verify exact run, artifact, fence, and sole-healthy-deployment prerequisites",
    );
    const intentUpload = workflow.indexOf(
      "Persist the exact intent before any database credential exists",
    );
    const credentialCustody = workflow.indexOf(
      "Materialize the production database authority into private files",
    );
    const executor = workflow.indexOf(
      "Apply once or perform read-only prior-intent reconciliation",
    );
    expect(repositoryGate).toBeGreaterThan(-1);
    expect(prerequisiteVerifier).toBeGreaterThan(repositoryGate);
    expect(intentUpload).toBeGreaterThan(prerequisiteVerifier);
    expect(credentialCustody).toBeGreaterThan(intentUpload);
    expect(executor).toBeGreaterThan(credentialCustody);
    expect(workflow).toContain(
      "if: always()\n        uses: actions/upload-artifact@",
    );
    expect(workflow).not.toContain("DATABASE_URL:");
    expect(workflow).not.toContain("DATABASE_MAINTENANCE_URL:");
    expect(workflow).not.toMatch(/--(?:password|target-url|database-url)\b/);
  });
});
