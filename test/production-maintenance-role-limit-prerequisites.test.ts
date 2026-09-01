import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
  runProductionMaintenanceRoleLimitPrerequisiteVerifier,
} from "../scripts/verify-production-maintenance-role-limit-prerequisites.js";

const CANDIDATE = "a".repeat(40);
const CURRENT_RUN_ID = "3003";
const FENCE_RUN_ID = "1001";
const DEPLOYMENT_RUN_ID = "2002";
const REPOSITORY = "blackmagic30/Beer";
const FENCE_WORKFLOW =
  ".github/workflows/configure-automatic-maintenance-worker-fence.yml";
const DEPLOYMENT_WORKFLOW = ".github/workflows/deploy-production.yml";
const CURRENT_WORKFLOW =
  ".github/workflows/transition-production-postgres-maintenance-role-limit.yml";
const FENCE_FILE =
  "/private/prerequisites/automatic-maintenance-worker-fence-terminal.json";
const DEPLOYMENT_FILE = "/private/prerequisites/deployment-receipt.json";
const OUTPUT = "/private/evidence/prerequisites-verification.json";
const DEPLOYMENT_PREFLIGHT_OUTPUT =
  "/private/evidence/production-deployment-worker-fence-verification.json";
const ROLE_TERMINAL_FILE = "/private/downstream/terminal.json";
const ROLE_RECEIPT_FILE = "/private/downstream/receipt.json";
const ROLE_INTENT_FILE = "/private/downstream/intent.json";
const ROLE_PREREQUISITES_FILE =
  "/private/downstream/prerequisites-verification.json";
const ACTIVATION_OUTPUT =
  "/private/downstream/production-activation-role-limit-verification.json";
const ACTIVATE_TERMINAL_FILE =
  "/private/downstream/automatic-maintenance-worker-fence-terminal.json";
const ACTIVATION_PREREQUISITES_FILE = ACTIVATION_OUTPUT;
const SCALE_OUTPUT =
  "/private/downstream/production-scale-activation-verification.json";
const ACTIVATE_RUN_ID = "4004";
const SCALE_RUN_ID = "5005";
const RECONCILE_RUN_ID = "6006";
const PRIOR_INTENT_FILE = "/private/reconcile/intent.json";
const PRIOR_PREREQUISITES_FILE =
  "/private/reconcile/prerequisites-verification.json";
const RECONCILIATION_OUTPUT =
  "/private/reconcile/reconciliation-authority-verification.json";
const NOW = new Date("2026-08-21T01:13:00.000Z");

function sha(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function crc32(value: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function zipArchiveEntries(
  entries: readonly { readonly name: string; readonly source: string }[],
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.source, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    localParts.push(local, nameBytes, data);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
  }
  const centralOffset = localOffset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x0605_4b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function zipArchive(name: string, source: string): Buffer {
  return zipArchiveEntries([{ name, source }]);
}

function githubRun(input: {
  id: string;
  workflow: string;
  name: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  status: "completed" | "in_progress" | "queued";
  conclusion: "success" | "failure" | "cancelled" | "timed_out" | null;
  displayTitle?: string;
  runNumber?: number;
}) {
  return {
    id: Number(input.id),
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    name: input.name,
    path: `${input.workflow}@main`,
    event: "workflow_dispatch",
    head_sha: CANDIDATE,
    head_branch: "main",
    run_number: input.runNumber ?? 1,
    run_attempt: 1,
    status: input.status,
    conclusion: input.conclusion,
    created_at: input.createdAt,
    run_started_at: input.startedAt,
    updated_at: input.updatedAt,
    ...(input.displayTitle === undefined
      ? {}
      : { display_title: input.displayTitle }),
  };
}

function artifact(name: string, runId: string, id: string, archive: Buffer) {
  return {
    id: Number(id),
    name,
    expired: false,
    size_in_bytes: 8192,
    digest: `sha256:${sha(archive)}`,
    archive_download_url:
      `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${id}/zip`,
    workflow_run: { id: Number(runId), head_sha: CANDIDATE },
  };
}

const FENCE_CHECKS = {
  policyExact: true,
  githubAuthorityExact: true,
  tokenScopesExact: true,
  boundaryPreflightExact: true,
  targetPreflightExact: true,
  operationPreflightExact: true,
  durableIntentExact: true,
  writeAttemptedAtMostOnce: true,
  atomicVariablesExact: true,
  acknowledgementExact: true,
  postflightAttempted: true,
  targetPostflightExact: true,
  postflightDeploymentExact: true,
  runtimeRoutesPolledExact: true,
  runtimeMaintenanceStateExact: true,
  boundaryPostflightExact: true,
  noOtherProviderChanges: true,
  terminalEvidenceExact: true,
};

function fenceTerminal(overrides: Record<string, unknown> = {}): string {
  const binding = {
    policySha256:
      "685539a691f290e2d870d69de452fe1fcbd0635065276e9a51b51864aaf29d27",
    candidateSha: CANDIDATE,
    target: "production",
    operation: "fence",
    projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
    environmentId: "13dab015-df74-45c6-b26f-69323daea99a",
    serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    configuredVariables: {
      PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED: "false",
      PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: CANDIDATE,
    },
    skipDeploys: true,
  };
  const deploymentHash = sha("deployment");
  const sourceSha = "b".repeat(40);
  const topology = sha("topology");
  const collateral = sha("collateral");
  return canonical({
    schemaVersion: "pintpath-automatic-maintenance-worker-fence-terminal/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    binding,
    bindingSha256: sha(canonical(binding)),
    outcome: "fenced",
    attempts: 1,
    retryAllowed: false,
    failureCode: null,
    authoritySha256: sha("authority"),
    intentSha256: sha("intent"),
    providerEvidence: {
      graphqlOperation: "variableCollectionUpsert",
      mutationCallCount: 1,
      acknowledgementExact: true,
      providerBeforeSha256: sha("provider-before"),
      providerAfterSha256: sha("provider-after"),
      deploymentBeforeIdSha256: deploymentHash,
      deploymentAfterIdSha256: deploymentHash,
      sourceBeforeSha: sourceSha,
      sourceAfterSha: sourceSha,
      sourcePreservedExact: true,
      deploymentIdChanged: false,
      topologyBeforeSha256: topology,
      topologyAfterSha256: topology,
      collateralVariablesBeforeSha256: collateral,
      collateralVariablesAfterSha256: collateral,
    },
    runtimeEvidence: {
      required: false,
      observed: false,
      pollRounds: 0,
      expectedSourceSha: null,
      expectedAutomaticMaintenance: null,
      deploymentIdSha256: null,
      responseSha256s: {
        "/health": null,
        "/startup": null,
        "/ready": null,
      },
    },
    mutationBoundaryEvidence: {
      preflightReceiptSha256: sha("boundary-before"),
      postflightReceiptSha256: sha("boundary-after"),
    },
    checks: FENCE_CHECKS,
    stagingBootstrapVerification: {
      preparedReceiptExact: false,
      sufficientWithoutQuiescenceProof: false,
      nextRequiredProof: "EXACT_SCALE_1_TO_0_QUIESCENCE_PROOF",
      legacySourceRuntimeFenceClaimed: false,
    },
    productionDeploymentVerification: {
      requiredReceiptFilename:
        "automatic-maintenance-worker-fence-terminal.json",
      eligible: true,
      exactCandidateTargetOperationBindingRequired: true,
      bindingSha256Required: true,
      oldRuntimeSafetyPrerequisite:
        "EXTERNAL_SQLITE_DETACHED_FROM_POSTGRES_PROOF",
      oldRuntimeSafetyVerifiedByThisOperation: false,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
    ...overrides,
  });
}

const DEPLOYMENT_CHECKS = {
  policyExact: true,
  githubMainExact: true,
  sourceAuthorityExact: true,
  cliExact: true,
  writeTokenScopeExact: true,
  costPolicyExact: true,
  prerequisiteExact: true,
  workerFencePrerequisiteExact: true,
  workerFenceDeploymentContinuityExact: true,
  boundaryPreflightExact: true,
  targetPreflightExact: true,
  gitAutodeployAbsent: true,
  collateralInventoryExact: true,
  durableIntentExact: true,
  sourceReasserted: true,
  writeAttemptedAtMostOnce: true,
  targetPostflightAttempted: true,
  targetPostflightExact: true,
  reconciliationCompleted: true,
  topologyPreserved: true,
  deploymentExact: true,
  runtimeHealthExact: true,
  runtimeStartupExact: true,
  runtimeReadinessExact: true,
  collateralStateUnchanged: true,
  boundaryPostflightExact: true,
  terminalEvidenceExact: true,
};

function deploymentReceipt(
  checks = DEPLOYMENT_CHECKS,
  replicaCount = 1,
): string {
  const collateral = sha("deployment-collateral");
  return canonical({
    schemaVersion: "pintpath-railway-application-deployment-executor/v5",
    operation: "pintpath-railway-application-source-upload",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    target: "production",
    outcome: "deployed",
    failureCode: null,
    candidateSha: CANDIDATE,
    startedAt: "2026-08-21T01:04:10.000Z",
    completedAt: "2026-08-21T01:09:00.000Z",
    writeAttempts: 1,
    acknowledgement: "received",
    previousDeploymentIdSha256: sha("old-deployment"),
    deploymentIdSha256: sha("new-deployment"),
    intentSha256: sha("deployment-intent"),
    cliOutputSha256: sha("cli-output"),
    boundaryPreflightSha256: sha("deploy-boundary-before"),
    boundaryPostflightSha256: sha("deploy-boundary-after"),
    collateralSnapshotSha256s: { before: collateral, after: collateral },
    replicaCounts: { before: replicaCount, after: replicaCount },
    runtimeResponseSha256s: {
      health: sha("health"),
      startup: sha("startup"),
      ready: sha("ready"),
    },
    workerFencePrerequisite: {
      runId: FENCE_RUN_ID,
      verificationSha256: sha("production-deploy-fence-verification"),
      bindingSha256: JSON.parse(fenceTerminal()).bindingSha256,
      terminalSha256: sha(fenceTerminal()),
      deploymentIdSha256:
        JSON.parse(fenceTerminal()).providerEvidence.deploymentAfterIdSha256,
    },
    checks,
  });
}

const ROLE_LIMIT_CHECKS = {
  policyExact: true,
  githubContextExact: true,
  ambientPostgresAuthorityAbsent: true,
  intentExact: true,
  priorIntentRequiredForAlreadyDesired: false,
  prerequisiteIntentBindingExact: true,
  prerequisiteVerificationExact: true,
  repositoryPreflightExact: true,
  credentialCustodyExact: true,
  transportExact: true,
  catalogPreflightExact: true,
  repositoryPrewriteExact: true,
  advisoryLockExact: true,
  immediateCatalogPrewriteExact: true,
  oneAlterRoleAtMost: true,
  automaticRetryAbsent: true,
  postflightAttempted: true,
  catalogPostflightExact: true,
  primaryConnectionCleanupExact: true,
  postflightConnectionCleanupExact: true,
  terminalEvidenceExact: true,
  receiptEvidenceExact: true,
};

function roleLimitFiles(prerequisitesSource: string): {
  readonly intent: string;
  readonly terminal: string;
  readonly receipt: string;
} {
  const prerequisites = JSON.parse(prerequisitesSource);
  const intent = canonical({
    schemaVersion: "pintpath-production-maintenance-login-limit-intent/v1",
    policyId: "pintpath-production-maintenance-login-limit-2-to-8",
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    candidateSha: CANDIDATE,
    repository: REPOSITORY,
    workflowPath: CURRENT_WORKFLOW,
    githubEnvironment: "production-postgres-maintenance-role-limit",
    githubRunId: CURRENT_RUN_ID,
    githubRunAttempt: 1,
    targetEnvironment: "production",
    databaseHost: "postgres-production.railway.internal",
    databasePort: 5432,
    databaseName: "pintpath",
    authorityLogin: "postgres",
    loginRole: "privacy_maintenance_login",
    groupRole: "pintpath_maintenance",
    expectedOldConnectionLimit: 2,
    desiredConnectionLimit: 8,
    prerequisitesVerificationSchema:
      "pintpath-production-maintenance-login-limit-prerequisites/v1",
    prerequisitesVerificationSha256: sha(prerequisitesSource),
    workerFenceRunId: prerequisites.workerFence.runId,
    productionDeploymentRunId: prerequisites.productionDeployment.runId,
    rootCaDerSha256: sha("root-ca"),
    maximumWriteAttempts: 1,
    retryAllowed: false,
    createdAt: "2026-08-21T01:13:00.000Z",
    expiresAt: "2026-08-21T02:13:00.000Z",
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
  const terminal = canonical({
    schemaVersion: "pintpath-production-maintenance-login-limit-terminal/v1",
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    candidateSha: CANDIDATE,
    phase: "apply",
    outcome: "updated",
    failureCode: null,
    intentSha256: sha(intent),
    prerequisitesVerificationSha256: sha(prerequisitesSource),
    workerFenceRunId: prerequisites.workerFence.runId,
    productionDeploymentRunId: prerequisites.productionDeployment.runId,
    writeAttempts: 1,
    retryAllowed: false,
    preflightCatalogSha256: sha("catalog-before"),
    postflightCatalogSha256: sha("catalog-after"),
    startedAt: "2026-08-21T01:14:05.000Z",
    completedAt: "2026-08-21T01:15:30.000Z",
    secretMaterialIncluded: false,
  });
  const terminalValue = JSON.parse(terminal);
  const payload = {
    schemaVersion: "pintpath-production-maintenance-login-limit-receipt/v1",
    policyId: "pintpath-production-maintenance-login-limit-2-to-8",
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    phase: "apply",
    outcome: "updated",
    failureCode: null,
    candidateSha: CANDIDATE,
    repository: REPOSITORY,
    workflowPath: CURRENT_WORKFLOW,
    githubEnvironment: "production-postgres-maintenance-role-limit",
    githubRunId: CURRENT_RUN_ID,
    githubRunAttempt: 1,
    targetEnvironment: "production",
    databaseHost: "postgres-production.railway.internal",
    databasePort: 5432,
    databaseName: "pintpath",
    authorityLogin: "postgres",
    loginRole: "privacy_maintenance_login",
    groupRole: "pintpath_maintenance",
    expectedOldConnectionLimit: 2,
    desiredConnectionLimit: 8,
    rootCaDerSha256: sha("root-ca"),
    intentSha256: terminalValue.intentSha256,
    prerequisitesVerificationSha256:
      terminalValue.prerequisitesVerificationSha256,
    workerFenceRunId: terminalValue.workerFenceRunId,
    productionDeploymentRunId: terminalValue.productionDeploymentRunId,
    terminalEvidenceSha256: sha(terminal),
    preflightCatalogSha256: terminalValue.preflightCatalogSha256,
    postflightCatalogSha256: terminalValue.postflightCatalogSha256,
    writeAttempts: 1,
    maximumWriteAttempts: 1,
    retryAllowed: false,
    startedAt: terminalValue.startedAt,
    completedAt: terminalValue.completedAt,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
    checks: ROLE_LIMIT_CHECKS,
  };
  return {
    intent,
    terminal,
    receipt: canonical({ ...payload, receiptSha256: sha(canonical(payload)) }),
  };
}

function activateTerminal(deploymentBeforeIdSha256: string): string {
  const binding = {
    policySha256:
      "685539a691f290e2d870d69de452fe1fcbd0635065276e9a51b51864aaf29d27",
    candidateSha: CANDIDATE,
    target: "production",
    operation: "activate",
    projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
    environmentId: "13dab015-df74-45c6-b26f-69323daea99a",
    serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
    configuredVariables: {
      PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED: "true",
      PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: CANDIDATE,
    },
    skipDeploys: false,
  };
  const deploymentAfterIdSha256 = sha("activated-deployment");
  const topology = sha("topology");
  const collateral = sha("collateral");
  return canonical({
    schemaVersion: "pintpath-automatic-maintenance-worker-fence-terminal/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    binding,
    bindingSha256: sha(canonical(binding)),
    outcome: "activated",
    attempts: 1,
    retryAllowed: false,
    failureCode: null,
    authoritySha256: sha("activation-authority"),
    intentSha256: sha("activation-intent"),
    providerEvidence: {
      graphqlOperation: "variableCollectionUpsert",
      mutationCallCount: 1,
      acknowledgementExact: true,
      providerBeforeSha256: sha("activation-provider-before"),
      providerAfterSha256: sha("activation-provider-after"),
      deploymentBeforeIdSha256,
      deploymentAfterIdSha256,
      sourceBeforeSha: CANDIDATE,
      sourceAfterSha: CANDIDATE,
      sourcePreservedExact: true,
      deploymentIdChanged: true,
      topologyBeforeSha256: topology,
      topologyAfterSha256: topology,
      collateralVariablesBeforeSha256: collateral,
      collateralVariablesAfterSha256: collateral,
    },
    runtimeEvidence: {
      required: true,
      observed: true,
      pollRounds: 1,
      expectedSourceSha: CANDIDATE,
      expectedAutomaticMaintenance: { enabled: true, candidateBound: true },
      deploymentIdSha256: deploymentAfterIdSha256,
      responseSha256s: {
        "/health": sha("activation-health"),
        "/startup": sha("activation-startup"),
        "/ready": sha("activation-ready"),
      },
    },
    mutationBoundaryEvidence: {
      preflightReceiptSha256: sha("activation-boundary-before"),
      postflightReceiptSha256: sha("activation-boundary-after"),
    },
    checks: FENCE_CHECKS,
    stagingBootstrapVerification: {
      preparedReceiptExact: false,
      sufficientWithoutQuiescenceProof: false,
      nextRequiredProof: "EXACT_SCALE_1_TO_0_QUIESCENCE_PROOF",
      legacySourceRuntimeFenceClaimed: false,
    },
    productionDeploymentVerification: {
      requiredReceiptFilename:
        "automatic-maintenance-worker-fence-terminal.json",
      eligible: false,
      exactCandidateTargetOperationBindingRequired: true,
      bindingSha256Required: true,
      oldRuntimeSafetyPrerequisite: null,
      oldRuntimeSafetyVerifiedByThisOperation: false,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function harness(input: {
  fenceSource?: string;
  deploymentSource?: string;
  fenceArchiveSource?: string;
  deploymentArchiveSource?: string;
  laterFenceRun?: boolean;
  priorRoleRuns?: readonly ReturnType<typeof githubRun>[];
  currentRoleRunNumber?: number;
} = {}) {
  const current = githubRun({
    id: CURRENT_RUN_ID,
    workflow: CURRENT_WORKFLOW,
    name: "Transition protected production Postgres maintenance LOGIN limit",
    createdAt: "2026-08-21T01:11:00.000Z",
    startedAt: "2026-08-21T01:12:00.000Z",
    updatedAt: "2026-08-21T01:12:00.000Z",
    status: "in_progress",
    conclusion: null,
    displayTitle: `Production maintenance LOGIN limit | apply | ${CANDIDATE}`,
    runNumber:
      input.currentRoleRunNumber ?? (input.priorRoleRuns?.length ?? 0) + 1,
  });
  const fence = githubRun({
    id: FENCE_RUN_ID,
    workflow: FENCE_WORKFLOW,
    name: "Configure candidate-bound automatic-maintenance worker fence",
    displayTitle:
      `Automatic maintenance worker fence | production | fence | ${CANDIDATE}`,
    createdAt: "2026-08-21T01:00:00.000Z",
    startedAt: "2026-08-21T01:01:00.000Z",
    updatedAt: "2026-08-21T01:02:00.000Z",
    status: "completed",
    conclusion: "success",
  });
  const deployment = githubRun({
    id: DEPLOYMENT_RUN_ID,
    workflow: DEPLOYMENT_WORKFLOW,
    name: "Deploy Pint Path protected production",
    createdAt: "2026-08-21T01:03:00.000Z",
    startedAt: "2026-08-21T01:04:00.000Z",
    updatedAt: "2026-08-21T01:10:00.000Z",
    status: "completed",
    conclusion: "success",
  });
  const fenceArtifactName =
    `pintpath-automatic-maintenance-worker-fence-production-fence-${CANDIDATE}`;
  const deploymentArtifactName = `pintpath-production-deployment-${CANDIDATE}`;
  const fenceSource = input.fenceSource ?? fenceTerminal();
  const deploymentSource = input.deploymentSource ?? deploymentReceipt();
  const fenceArchive = zipArchive(
    "automatic-maintenance-worker-fence-terminal.json",
    input.fenceArchiveSource ?? fenceSource,
  );
  const deploymentArchive = zipArchive(
    "pintpath-production-deployment-evidence/deployment-receipt.json",
    input.deploymentArchiveSource ?? deploymentSource,
  );
  const laterFence = githubRun({
    id: "1002",
    workflow: FENCE_WORKFLOW,
    name: "Configure candidate-bound automatic-maintenance worker fence",
    displayTitle:
      `Automatic maintenance worker fence | production | activate | ${CANDIDATE}`,
    createdAt: "2026-08-21T01:10:10.000Z",
    startedAt: "2026-08-21T01:10:20.000Z",
    updatedAt: "2026-08-21T01:11:00.000Z",
    status: "completed",
    conclusion: "success",
  });
  const fetchImpl = vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (url.endsWith(`/actions/runs/${CURRENT_RUN_ID}`)) return json(current);
    if (url.endsWith(`/actions/runs/${FENCE_RUN_ID}`)) return json(fence);
    if (url.endsWith(`/actions/runs/${DEPLOYMENT_RUN_ID}`)) {
      return json(deployment);
    }
    if (url.includes(`/actions/runs/${FENCE_RUN_ID}/artifacts?`)) {
      return json({
        total_count: 1,
        artifacts: [artifact(
          fenceArtifactName,
          FENCE_RUN_ID,
          "7001",
          fenceArchive,
        )],
      });
    }
    if (url.includes(`/actions/runs/${DEPLOYMENT_RUN_ID}/artifacts?`)) {
      return json({
        total_count: 1,
        artifacts: [
          artifact(
            deploymentArtifactName,
            DEPLOYMENT_RUN_ID,
            "8001",
            deploymentArchive,
          ),
        ],
      });
    }
    if (url.endsWith("/actions/artifacts/7001/zip")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://artifacts.invalid/7001.zip" },
      });
    }
    if (url.endsWith("/actions/artifacts/8001/zip")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://artifacts.invalid/8001.zip" },
      });
    }
    if (url === "https://artifacts.invalid/7001.zip") {
      return new Response(fenceArchive);
    }
    if (url === "https://artifacts.invalid/8001.zip") {
      return new Response(deploymentArchive);
    }
    if (url.includes(`/actions/workflows/${FENCE_WORKFLOW.split("/").at(-1)}/runs?`)) {
      const runs = input.laterFenceRun ? [fence, laterFence] : [fence];
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    if (url.includes(`/actions/workflows/${DEPLOYMENT_WORKFLOW.split("/").at(-1)}/runs?`)) {
      return json({ total_count: 1, workflow_runs: [deployment] });
    }
    if (url.includes("/actions/workflows/production-converge-two-replicas.yml/runs?")) {
      return json({ total_count: 0, workflow_runs: [] });
    }
    if (url.includes(`/actions/workflows/${CURRENT_WORKFLOW.split("/").at(-1)}/runs?`)) {
      const runs = [current, ...(input.priorRoleRuns ?? [])];
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const start = (page - 1) * 100;
      return json({
        total_count: runs.length,
        workflow_runs: runs.slice(start, start + 100),
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const files = new Map<string, string>([
    [FENCE_FILE, fenceSource],
    [DEPLOYMENT_FILE, deploymentSource],
  ]);
  const output: string[] = [];
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: CURRENT_RUN_ID,
    GITHUB_WORKFLOW_REF: `${REPOSITORY}/${CURRENT_WORKFLOW}@refs/heads/main`,
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_TOKEN: "synthetic-github-token", // security-scan allow: synthetic test-only fixture
    PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_GITHUB_ENVIRONMENT:
      "production-postgres-maintenance-role-limit",
    PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_MODE: "apply",
    PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_CONFIRMATION:
      "ALTER_PRIVACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT_2_TO_8",
  };
  return {
    files,
    output,
    fetchImpl,
    run: () => runProductionMaintenanceRoleLimitPrerequisiteVerifier({
      argv: [
        "--mode", "role-limit",
        "--candidate-sha", CANDIDATE,
        "--fence-run-id", FENCE_RUN_ID,
        "--deployment-run-id", DEPLOYMENT_RUN_ID,
        "--fence-terminal-file", FENCE_FILE,
        "--deployment-receipt-file", DEPLOYMENT_FILE,
        "--output", OUTPUT,
      ],
      env,
      cwd: process.cwd(),
      fetchImpl,
      now: () => new Date(NOW),
      readPrivateFile: (filename) => {
        const source = files.get(filename);
        if (source === undefined) throw new Error("missing_test_input");
        return Buffer.from(source, "utf8");
      },
      writeEvidence: (filename, source) => {
        if (files.has(filename)) throw new Error("output_collision");
        files.set(filename, source);
      },
      writeOutput: (source) => output.push(source),
      requestTimeoutMs: 1_000,
    }),
  };
}

function productionDeployHarness(input: {
  fenceSource?: string;
  fenceArchiveSource?: string;
  omitArtifactWorkflowRun?: boolean;
  laterFenceRun?: boolean;
} = {}) {
  const current = githubRun({
    id: CURRENT_RUN_ID,
    workflow: DEPLOYMENT_WORKFLOW,
    name: "Deploy Pint Path protected production",
    createdAt: "2026-08-21T01:03:00.000Z",
    startedAt: "2026-08-21T01:04:00.000Z",
    updatedAt: "2026-08-21T01:04:00.000Z",
    status: "in_progress",
    conclusion: null,
  });
  const fence = githubRun({
    id: FENCE_RUN_ID,
    workflow: FENCE_WORKFLOW,
    name: "Configure candidate-bound automatic-maintenance worker fence",
    displayTitle:
      `Automatic maintenance worker fence | production | fence | ${CANDIDATE}`,
    createdAt: "2026-08-21T01:00:00.000Z",
    startedAt: "2026-08-21T01:01:00.000Z",
    updatedAt: "2026-08-21T01:02:00.000Z",
    status: "completed",
    conclusion: "success",
  });
  const laterFence = githubRun({
    id: "1002",
    workflow: FENCE_WORKFLOW,
    name: "Configure candidate-bound automatic-maintenance worker fence",
    displayTitle:
      `Automatic maintenance worker fence | production | activate | ${CANDIDATE}`,
    createdAt: "2026-08-21T01:02:10.000Z",
    startedAt: "2026-08-21T01:02:20.000Z",
    updatedAt: "2026-08-21T01:03:00.000Z",
    status: "completed",
    conclusion: "success",
  });
  const fenceArtifactName =
    `pintpath-automatic-maintenance-worker-fence-production-fence-${CANDIDATE}`;
  const fenceSource = input.fenceSource ?? fenceTerminal();
  const fenceArchive = zipArchive(
    "automatic-maintenance-worker-fence-terminal.json",
    input.fenceArchiveSource ?? fenceSource,
  );
  const artifactValue = artifact(
    fenceArtifactName,
    FENCE_RUN_ID,
    "7001",
    fenceArchive,
  );
  if (input.omitArtifactWorkflowRun) delete artifactValue.workflow_run;
  const fetchImpl = vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (url.endsWith(`/actions/runs/${CURRENT_RUN_ID}`)) return json(current);
    if (url.endsWith(`/actions/runs/${FENCE_RUN_ID}`)) return json(fence);
    if (url.includes(`/actions/runs/${FENCE_RUN_ID}/artifacts?`)) {
      return json({ total_count: 1, artifacts: [artifactValue] });
    }
    if (url.endsWith("/actions/artifacts/7001/zip")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://artifacts.invalid/7001.zip" },
      });
    }
    if (url === "https://artifacts.invalid/7001.zip") {
      return new Response(fenceArchive);
    }
    if (url.includes(`/actions/workflows/${FENCE_WORKFLOW.split("/").at(-1)}/runs?`)) {
      const runs = input.laterFenceRun ? [fence, laterFence] : [fence];
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    if (url.includes(`/actions/workflows/${DEPLOYMENT_WORKFLOW.split("/").at(-1)}/runs?`)) {
      return json({ total_count: 1, workflow_runs: [current] });
    }
    if (url.includes("/actions/workflows/production-converge-two-replicas.yml/runs?")) {
      return json({ total_count: 0, workflow_runs: [] });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const files = new Map<string, string>([
    [FENCE_FILE, fenceSource],
  ]);
  const output: string[] = [];
  return {
    files,
    output,
    fetchImpl,
    run: () => runProductionMaintenanceRoleLimitPrerequisiteVerifier({
      argv: [
        "--mode", "production-deploy",
        "--candidate-sha", CANDIDATE,
        "--fence-run-id", FENCE_RUN_ID,
        "--fence-terminal-file", FENCE_FILE,
        "--output", DEPLOYMENT_PREFLIGHT_OUTPUT,
      ],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: CURRENT_RUN_ID,
        GITHUB_WORKFLOW_REF:
          `${REPOSITORY}/${DEPLOYMENT_WORKFLOW}@refs/heads/main`,
        GITHUB_API_URL: "https://api.github.com",
        GITHUB_TOKEN: "synthetic-github-token", // security-scan allow: synthetic test-only fixture
        PINTPATH_PRODUCTION_DEPLOYMENT_GITHUB_ENVIRONMENT:
          "production-deployment",
        PINTPATH_PRODUCTION_DEPLOYMENT_FENCE_CONFIRMATION:
          `DEPLOY_PRODUCTION_${CANDIDATE}_AFTER_FENCE_RUN_${FENCE_RUN_ID}`,
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => new Date("2026-08-21T01:05:00.000Z"),
      readPrivateFile: (filename) => {
        const source = files.get(filename);
        if (source === undefined) throw new Error("missing_test_input");
        return Buffer.from(source, "utf8");
      },
      writeEvidence: (filename, source) => {
        if (files.has(filename)) throw new Error("output_collision");
        files.set(filename, source);
      },
      writeOutput: (source) => output.push(source),
      requestTimeoutMs: 1_000,
    }),
  };
}

async function productionActivateHarness(input: {
  tamperIntentArchive?: boolean;
  tamperReceiptArchive?: boolean;
} = {}) {
  const rolePrerequisiteTarget = harness();
  if (await rolePrerequisiteTarget.run() !== 0) {
    throw new Error("role_prerequisite_fixture_failed");
  }
  const prerequisitesSource = rolePrerequisiteTarget.files.get(OUTPUT)!;
  const roleFiles = roleLimitFiles(prerequisitesSource);
  const current = githubRun({
    id: ACTIVATE_RUN_ID,
    workflow: FENCE_WORKFLOW,
    name: "Configure candidate-bound automatic-maintenance worker fence",
    displayTitle:
      `Automatic maintenance worker fence | production | activate | ${CANDIDATE}`,
    createdAt: "2026-08-21T01:17:00.000Z",
    startedAt: "2026-08-21T01:18:00.000Z",
    updatedAt: "2026-08-21T01:18:00.000Z",
    status: "in_progress",
    conclusion: null,
  });
  const role = githubRun({
    id: CURRENT_RUN_ID,
    workflow: CURRENT_WORKFLOW,
    name: "Transition protected production Postgres maintenance LOGIN limit",
    displayTitle: `Production maintenance LOGIN limit | apply | ${CANDIDATE}`,
    createdAt: "2026-08-21T01:11:00.000Z",
    startedAt: "2026-08-21T01:12:00.000Z",
    updatedAt: "2026-08-21T01:16:00.000Z",
    status: "completed",
    conclusion: "success",
  });
  const fence = githubRun({
    id: FENCE_RUN_ID,
    workflow: FENCE_WORKFLOW,
    name: "Configure candidate-bound automatic-maintenance worker fence",
    displayTitle:
      `Automatic maintenance worker fence | production | fence | ${CANDIDATE}`,
    createdAt: "2026-08-21T01:00:00.000Z",
    startedAt: "2026-08-21T01:01:00.000Z",
    updatedAt: "2026-08-21T01:02:00.000Z",
    status: "completed",
    conclusion: "success",
  });
  const deployment = githubRun({
    id: DEPLOYMENT_RUN_ID,
    workflow: DEPLOYMENT_WORKFLOW,
    name: "Deploy Pint Path protected production",
    createdAt: "2026-08-21T01:03:00.000Z",
    startedAt: "2026-08-21T01:04:00.000Z",
    updatedAt: "2026-08-21T01:10:00.000Z",
    status: "completed",
    conclusion: "success",
  });
  const artifactName =
    `pintpath-production-maintenance-role-limit-apply-${CANDIDATE}-${CURRENT_RUN_ID}`;
  const archive = zipArchiveEntries([
    {
      name: "intent.json",
      source: input.tamperIntentArchive
        ? canonical({ tampered: true })
        : roleFiles.intent,
    },
    { name: "terminal.json", source: roleFiles.terminal },
    {
      name: "receipt.json",
      source: input.tamperReceiptArchive
        ? canonical({ tampered: true })
        : roleFiles.receipt,
    },
    { name: "prerequisites-verification.json", source: prerequisitesSource },
  ]);
  const fetchImpl = vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (url.endsWith(`/actions/runs/${ACTIVATE_RUN_ID}`)) return json(current);
    if (url.endsWith(`/actions/runs/${CURRENT_RUN_ID}`)) return json(role);
    if (url.includes(`/actions/runs/${CURRENT_RUN_ID}/artifacts?`)) {
      return json({
        total_count: 1,
        artifacts: [artifact(artifactName, CURRENT_RUN_ID, "9001", archive)],
      });
    }
    if (url.endsWith("/actions/artifacts/9001/zip")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://artifacts.invalid/9001.zip" },
      });
    }
    if (url === "https://artifacts.invalid/9001.zip") {
      return new Response(archive);
    }
    if (url.includes(`/actions/workflows/${FENCE_WORKFLOW.split("/").at(-1)}/runs?`)) {
      return json({ total_count: 2, workflow_runs: [current, fence] });
    }
    if (url.includes(`/actions/workflows/${DEPLOYMENT_WORKFLOW.split("/").at(-1)}/runs?`)) {
      return json({ total_count: 1, workflow_runs: [deployment] });
    }
    if (url.includes(`/actions/workflows/${CURRENT_WORKFLOW.split("/").at(-1)}/runs?`)) {
      return json({ total_count: 1, workflow_runs: [role] });
    }
    if (url.includes("/actions/workflows/production-converge-two-replicas.yml/runs?")) {
      return json({ total_count: 0, workflow_runs: [] });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const files = new Map<string, string>([
    [ROLE_INTENT_FILE, roleFiles.intent],
    [ROLE_TERMINAL_FILE, roleFiles.terminal],
    [ROLE_RECEIPT_FILE, roleFiles.receipt],
    [ROLE_PREREQUISITES_FILE, prerequisitesSource],
  ]);
  const output: string[] = [];
  return {
    files,
    output,
    fetchImpl,
    run: () => runProductionMaintenanceRoleLimitPrerequisiteVerifier({
      argv: [
        "--mode", "production-activate",
        "--candidate-sha", CANDIDATE,
        "--role-limit-run-id", CURRENT_RUN_ID,
        "--role-intent-file", ROLE_INTENT_FILE,
        "--role-terminal-file", ROLE_TERMINAL_FILE,
        "--role-receipt-file", ROLE_RECEIPT_FILE,
        "--role-prerequisites-file", ROLE_PREREQUISITES_FILE,
        "--output", ACTIVATION_OUTPUT,
      ],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: ACTIVATE_RUN_ID,
        GITHUB_WORKFLOW_REF:
          `${REPOSITORY}/${FENCE_WORKFLOW}@refs/heads/main`,
        GITHUB_API_URL: "https://api.github.com",
        GITHUB_TOKEN: "synthetic-github-token", // security-scan allow: synthetic test-only fixture
        PINTPATH_PROTECTED_ENVIRONMENT: "production-runtime-configuration",
        PINTPATH_AUTOMATIC_MAINTENANCE_CONFIRMATION:
          `ACTIVATE_AUTOMATIC_MAINTENANCE_IN_PRODUCTION_FOR_${CANDIDATE}`,
        PINTPATH_PRODUCTION_ACTIVATE_ROLE_LIMIT_RUN_ID: CURRENT_RUN_ID,
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => new Date("2026-08-21T01:19:00.000Z"),
      readPrivateFile: (filename) => {
        const source = files.get(filename);
        if (source === undefined) throw new Error("missing_test_input");
        return Buffer.from(source, "utf8");
      },
      writeEvidence: (filename, source) => {
        if (files.has(filename)) throw new Error("output_collision");
        files.set(filename, source);
      },
      writeOutput: (source) => output.push(source),
      requestTimeoutMs: 1_000,
    }),
  };
}

async function productionScaleHarness(input: {
  tamperActivationTerminal?: boolean;
} = {}) {
  const activationTarget = await productionActivateHarness();
  if (await activationTarget.run() !== 0) {
    throw new Error("activation_prerequisite_fixture_failed");
  }
  const activationPrerequisites = activationTarget.files.get(ACTIVATION_OUTPUT)!;
  const parsedActivationPrerequisites = JSON.parse(activationPrerequisites);
  const activationTerminal = activateTerminal(
    parsedActivationPrerequisites.rolePrerequisites.productionDeployment
      .deploymentIdSha256,
  );
  const localActivationTerminal = input.tamperActivationTerminal
    ? canonical({ tampered: true })
    : activationTerminal;
  const current = githubRun({
    id: SCALE_RUN_ID,
    workflow: ".github/workflows/production-converge-two-replicas.yml",
    name: "Converge Pint Path production to two replicas",
    createdAt: "2026-08-21T01:22:00.000Z",
    startedAt: "2026-08-21T01:23:00.000Z",
    updatedAt: "2026-08-21T01:23:00.000Z",
    status: "in_progress",
    conclusion: null,
  });
  const activation = githubRun({
    id: ACTIVATE_RUN_ID,
    workflow: FENCE_WORKFLOW,
    name: "Configure candidate-bound automatic-maintenance worker fence",
    displayTitle:
      `Automatic maintenance worker fence | production | activate | ${CANDIDATE}`,
    createdAt: "2026-08-21T01:17:00.000Z",
    startedAt: "2026-08-21T01:18:00.000Z",
    updatedAt: "2026-08-21T01:21:00.000Z",
    status: "completed",
    conclusion: "success",
  });
  const role = githubRun({
    id: CURRENT_RUN_ID,
    workflow: CURRENT_WORKFLOW,
    name: "Transition protected production Postgres maintenance LOGIN limit",
    displayTitle: `Production maintenance LOGIN limit | apply | ${CANDIDATE}`,
    createdAt: "2026-08-21T01:11:00.000Z",
    startedAt: "2026-08-21T01:12:00.000Z",
    updatedAt: "2026-08-21T01:16:00.000Z",
    status: "completed",
    conclusion: "success",
  });
  const fence = githubRun({
    id: FENCE_RUN_ID,
    workflow: FENCE_WORKFLOW,
    name: "Configure candidate-bound automatic-maintenance worker fence",
    displayTitle:
      `Automatic maintenance worker fence | production | fence | ${CANDIDATE}`,
    createdAt: "2026-08-21T01:00:00.000Z",
    startedAt: "2026-08-21T01:01:00.000Z",
    updatedAt: "2026-08-21T01:02:00.000Z",
    status: "completed",
    conclusion: "success",
  });
  const deployment = githubRun({
    id: DEPLOYMENT_RUN_ID,
    workflow: DEPLOYMENT_WORKFLOW,
    name: "Deploy Pint Path protected production",
    createdAt: "2026-08-21T01:03:00.000Z",
    startedAt: "2026-08-21T01:04:00.000Z",
    updatedAt: "2026-08-21T01:10:00.000Z",
    status: "completed",
    conclusion: "success",
  });
  const artifactName =
    `pintpath-automatic-maintenance-worker-fence-production-activate-${CANDIDATE}`;
  const archive = zipArchiveEntries([
    {
      name: "automatic-maintenance-worker-fence-terminal.json",
      source: activationTerminal,
    },
    {
      name: "production-activation-role-limit-verification.json",
      source: activationPrerequisites,
    },
  ]);
  const fetchImpl = vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (url.endsWith(`/actions/runs/${SCALE_RUN_ID}`)) return json(current);
    if (url.endsWith(`/actions/runs/${ACTIVATE_RUN_ID}`)) {
      return json(activation);
    }
    if (url.includes(`/actions/runs/${ACTIVATE_RUN_ID}/artifacts?`)) {
      return json({
        total_count: 1,
        artifacts: [artifact(artifactName, ACTIVATE_RUN_ID, "9101", archive)],
      });
    }
    if (url.endsWith("/actions/artifacts/9101/zip")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://artifacts.invalid/9101.zip" },
      });
    }
    if (url === "https://artifacts.invalid/9101.zip") {
      return new Response(archive);
    }
    if (url.includes(`/actions/workflows/${FENCE_WORKFLOW.split("/").at(-1)}/runs?`)) {
      return json({ total_count: 2, workflow_runs: [activation, fence] });
    }
    if (url.includes(`/actions/workflows/${DEPLOYMENT_WORKFLOW.split("/").at(-1)}/runs?`)) {
      return json({ total_count: 1, workflow_runs: [deployment] });
    }
    if (url.includes(`/actions/workflows/${CURRENT_WORKFLOW.split("/").at(-1)}/runs?`)) {
      return json({ total_count: 1, workflow_runs: [role] });
    }
    if (url.includes("/actions/workflows/production-converge-two-replicas.yml/runs?")) {
      return json({ total_count: 1, workflow_runs: [current] });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const files = new Map<string, string>([
    [ACTIVATE_TERMINAL_FILE, localActivationTerminal],
    [ACTIVATION_PREREQUISITES_FILE, activationPrerequisites],
  ]);
  const output: string[] = [];
  return {
    files,
    output,
    fetchImpl,
    run: () => runProductionMaintenanceRoleLimitPrerequisiteVerifier({
      argv: [
        "--mode", "production-scale",
        "--candidate-sha", CANDIDATE,
        "--activate-run-id", ACTIVATE_RUN_ID,
        "--activate-terminal-file", ACTIVATE_TERMINAL_FILE,
        "--activation-prerequisites-file", ACTIVATION_PREREQUISITES_FILE,
        "--output", SCALE_OUTPUT,
      ],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: SCALE_RUN_ID,
        GITHUB_WORKFLOW_REF:
          `${REPOSITORY}/.github/workflows/production-converge-two-replicas.yml@refs/heads/main`,
        GITHUB_API_URL: "https://api.github.com",
        GITHUB_TOKEN: "synthetic-github-token", // security-scan allow: synthetic test-only fixture
        PINTPATH_PRODUCTION_SCALE_GITHUB_ENVIRONMENT:
          "production-topology-configuration",
        PINTPATH_SCALE_CONFIRMATION: "CONVERGE_PRODUCTION_TO_TWO_REPLICAS",
        PINTPATH_PRODUCTION_SCALE_ACTIVATE_RUN_ID: ACTIVATE_RUN_ID,
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => new Date("2026-08-21T01:24:00.000Z"),
      readPrivateFile: (filename) => {
        const source = files.get(filename);
        if (source === undefined) throw new Error("missing_test_input");
        return Buffer.from(source, "utf8");
      },
      writeEvidence: (filename, source) => {
        if (files.has(filename)) throw new Error("output_collision");
        files.set(filename, source);
      },
      writeOutput: (source) => output.push(source),
      requestTimeoutMs: 1_000,
    }),
  };
}

async function reconciliationHarness(input: { tamperArchive?: boolean } = {}) {
  const rolePrerequisiteTarget = harness();
  if (await rolePrerequisiteTarget.run() !== 0) {
    throw new Error("role_prerequisite_fixture_failed");
  }
  const prerequisitesSource = rolePrerequisiteTarget.files.get(OUTPUT)!;
  const intent = canonical({
    schemaVersion: "pintpath-production-maintenance-login-limit-intent/v1",
    policyId: "pintpath-production-maintenance-login-limit-2-to-8",
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    candidateSha: CANDIDATE,
    repository: REPOSITORY,
    workflowPath: CURRENT_WORKFLOW,
    githubEnvironment: "production-postgres-maintenance-role-limit",
    githubRunId: CURRENT_RUN_ID,
    githubRunAttempt: 1,
    targetEnvironment: "production",
    databaseHost: "postgres-production.railway.internal",
    databasePort: 5432,
    databaseName: "pintpath",
    authorityLogin: "postgres",
    loginRole: "privacy_maintenance_login",
    groupRole: "pintpath_maintenance",
    expectedOldConnectionLimit: 2,
    desiredConnectionLimit: 8,
    prerequisitesVerificationSchema:
      "pintpath-production-maintenance-login-limit-prerequisites/v1",
    prerequisitesVerificationSha256: sha(prerequisitesSource),
    workerFenceRunId: FENCE_RUN_ID,
    productionDeploymentRunId: DEPLOYMENT_RUN_ID,
    rootCaDerSha256: sha("root-ca"),
    maximumWriteAttempts: 1,
    retryAllowed: false,
    createdAt: "2026-08-21T01:13:00.000Z",
    expiresAt: "2026-08-21T02:13:00.000Z",
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
  const current = githubRun({
    id: RECONCILE_RUN_ID,
    workflow: CURRENT_WORKFLOW,
    name: "Transition protected production Postgres maintenance LOGIN limit",
    displayTitle:
      `Production maintenance LOGIN limit | reconcile | ${CANDIDATE}`,
    createdAt: "2026-08-21T01:19:00.000Z",
    startedAt: "2026-08-21T01:20:00.000Z",
    updatedAt: "2026-08-21T01:20:00.000Z",
    status: "in_progress",
    conclusion: null,
  });
  const prior = githubRun({
    id: CURRENT_RUN_ID,
    workflow: CURRENT_WORKFLOW,
    name: "Transition protected production Postgres maintenance LOGIN limit",
    displayTitle: `Production maintenance LOGIN limit | apply | ${CANDIDATE}`,
    createdAt: "2026-08-21T01:11:00.000Z",
    startedAt: "2026-08-21T01:12:00.000Z",
    updatedAt: "2026-08-21T01:16:00.000Z",
    status: "completed",
    conclusion: "failure",
  });
  const artifactName =
    `pintpath-production-maintenance-role-limit-intent-${CANDIDATE}-${CURRENT_RUN_ID}`;
  const archive = zipArchiveEntries([
    {
      name: "intent.json",
      source: input.tamperArchive ? canonical({ tampered: true }) : intent,
    },
    { name: "prerequisites-verification.json", source: prerequisitesSource },
  ]);
  const fetchImpl = vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (url.endsWith(`/actions/runs/${RECONCILE_RUN_ID}`)) {
      return json(current);
    }
    if (url.endsWith(`/actions/runs/${CURRENT_RUN_ID}`)) return json(prior);
    if (url.includes(`/actions/runs/${CURRENT_RUN_ID}/artifacts?`)) {
      return json({
        total_count: 1,
        artifacts: [artifact(artifactName, CURRENT_RUN_ID, "9201", archive)],
      });
    }
    if (url.endsWith("/actions/artifacts/9201/zip")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://artifacts.invalid/9201.zip" },
      });
    }
    if (url === "https://artifacts.invalid/9201.zip") {
      return new Response(archive);
    }
    if (url.includes(`/actions/workflows/${CURRENT_WORKFLOW.split("/").at(-1)}/runs?`)) {
      return json({ total_count: 2, workflow_runs: [current, prior] });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const files = new Map<string, string>([
    [PRIOR_INTENT_FILE, intent],
    [PRIOR_PREREQUISITES_FILE, prerequisitesSource],
  ]);
  const output: string[] = [];
  return {
    files,
    output,
    run: () => runProductionMaintenanceRoleLimitPrerequisiteVerifier({
      argv: [
        "--mode", "role-limit-reconcile",
        "--candidate-sha", CANDIDATE,
        "--prior-role-run-id", CURRENT_RUN_ID,
        "--prior-intent-file", PRIOR_INTENT_FILE,
        "--prior-prerequisites-file", PRIOR_PREREQUISITES_FILE,
        "--output", RECONCILIATION_OUTPUT,
      ],
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: RECONCILE_RUN_ID,
        GITHUB_WORKFLOW_REF:
          `${REPOSITORY}/${CURRENT_WORKFLOW}@refs/heads/main`,
        GITHUB_API_URL: "https://api.github.com",
        GITHUB_TOKEN: "synthetic-github-token", // security-scan allow: synthetic test-only fixture
        PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_GITHUB_ENVIRONMENT:
          "production-postgres-maintenance-role-limit",
        PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_MODE: "reconcile",
        PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_CONFIRMATION:
          "RECONCILE_PRIVACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT_8",
        PINTPATH_PRODUCTION_RECONCILE_PRIOR_ROLE_RUN_ID: CURRENT_RUN_ID,
      },
      cwd: process.cwd(),
      fetchImpl,
      now: () => new Date("2026-08-21T01:21:00.000Z"),
      readPrivateFile: (filename) => {
        const source = files.get(filename);
        if (source === undefined) throw new Error("missing_test_input");
        return Buffer.from(source, "utf8");
      },
      writeEvidence: (filename, source) => {
        if (files.has(filename)) throw new Error("output_collision");
        files.set(filename, source);
      },
      writeOutput: (source) => output.push(source),
      requestTimeoutMs: 1_000,
    }),
  };
}

describe("production maintenance role-limit prerequisites", () => {
  it("binds exact successful fence and sole-healthy production deployment authorities", async () => {
    const target = harness();
    await expect(target.run()).resolves.toBe(0);
    const verification = JSON.parse(target.files.get(OUTPUT)!);
    expect(verification).toMatchObject({
      schemaVersion:
        "pintpath-production-maintenance-login-limit-prerequisites/v1",
      policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
      candidateSha: CANDIDATE,
      consumer: { runId: CURRENT_RUN_ID, runAttempt: 1 },
      workerFence: { runId: FENCE_RUN_ID, runAttempt: 1 },
      productionDeployment: {
        runId: DEPLOYMENT_RUN_ID,
        runAttempt: 1,
        replicaCount: 1,
      },
      checks: {
        fenceWorkersDisabledExact: true,
        fenceCandidateBindingExact: true,
        deploymentRuntimeWorkersDisabledExact: true,
        deploymentRuntimeCandidateBindingExact: true,
        deploymentSoleHealthyCandidateExact: true,
        noLaterProductionWorkerFenceRunExact: true,
        noLaterProductionDeploymentRunExact: true,
        noPriorRoleLimitApplyRunExact: true,
      },
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    expect(target.fetchImpl).toHaveBeenCalledTimes(13);
    const evidence = target.files.get(OUTPUT)!;
    expect(evidence).not.toContain("synthetic-github-token");
    const summary = JSON.parse(target.output.at(-1)!);
    expect(Object.keys(summary)).toEqual([
      "ok",
      "candidateSha",
      "policySha256",
      "mode",
      "fenceRunId",
      "deploymentRunId",
      "priorRoleRunId",
      "roleLimitRunId",
      "activateRunId",
      "verificationSha256",
      "expiresAt",
      "secretMaterialIncluded",
    ]);
    expect(summary).toMatchObject({
      ok: true,
      mode: "role-limit",
      fenceRunId: FENCE_RUN_ID,
      deploymentRunId: DEPLOYMENT_RUN_ID,
      priorRoleRunId: null,
      roleLimitRunId: null,
      activateRunId: null,
      secretMaterialIncluded: false,
    });
  });

  it.each([
    [
      "worker candidate drift",
      () => fenceTerminal({
        binding: {
          ...JSON.parse(fenceTerminal()).binding,
          candidateSha: "b".repeat(40),
        },
      }),
      undefined,
      false,
    ],
    [
      "deployment no longer sole healthy",
      undefined,
      () => deploymentReceipt({
        ...DEPLOYMENT_CHECKS,
        deploymentExact: false,
      }),
      false,
    ],
    [
      "production already has two replicas",
      undefined,
      () => deploymentReceipt(DEPLOYMENT_CHECKS, 2),
      false,
    ],
    ["later production worker mutation", undefined, undefined, true],
  ])("blocks %s before emitting authority evidence", async (
    _label,
    fenceFactory,
    deploymentFactory,
    laterFenceRun,
  ) => {
    const target = harness({
      fenceSource: fenceFactory?.(),
      deploymentSource: deploymentFactory?.(),
      laterFenceRun,
    });
    await expect(target.run()).resolves.toBe(1);
    expect(target.files.has(OUTPUT)).toBe(false);
    expect(JSON.parse(target.output.at(-1)!)).toMatchObject({
      ok: false,
      productionContactAttempted: false,
      secretMaterialIncluded: false,
    });
  });

  it.each([
    [
      "failed apply completed before the selected deployment",
      githubRun({
        id: "2999",
        workflow: CURRENT_WORKFLOW,
        name: "Transition protected production Postgres maintenance LOGIN limit",
        displayTitle:
          `Production maintenance LOGIN limit | apply | ${CANDIDATE}`,
        createdAt: "2026-08-21T00:30:00.000Z",
        startedAt: "2026-08-21T00:31:00.000Z",
        updatedAt: "2026-08-21T00:40:00.000Z",
        status: "completed",
        conclusion: "failure",
        runNumber: 1,
      }),
    ],
    [
      "cancelled apply older than the receipt-age window",
      githubRun({
        id: "2998",
        workflow: CURRENT_WORKFLOW,
        name: "Transition protected production Postgres maintenance LOGIN limit",
        displayTitle:
          `Production maintenance LOGIN limit | apply | ${CANDIDATE}`,
        createdAt: "2026-08-20T00:10:00.000Z",
        startedAt: "2026-08-20T00:11:00.000Z",
        updatedAt: "2026-08-20T00:20:00.000Z",
        status: "completed",
        conclusion: "cancelled",
        runNumber: 1,
      }),
    ],
  ])("blocks a prior %s", async (_label, priorRun) => {
    const target = harness({ priorRoleRuns: [priorRun] });
    await expect(target.run()).resolves.toBe(1);
    expect(target.files.has(OUTPUT)).toBe(false);
    expect(JSON.parse(target.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "later_run_detected",
      productionContactAttempted: false,
    });
  });

  it("paginates the complete bounded workflow history before accepting first apply", async () => {
    const priorReconciliations = Array.from({ length: 99 }, (_, index) =>
      githubRun({
        id: String(7000 + index),
        workflow: CURRENT_WORKFLOW,
        name: "Transition protected production Postgres maintenance LOGIN limit",
        displayTitle:
          `Production maintenance LOGIN limit | reconcile | ${CANDIDATE}`,
        createdAt: "2026-08-21T00:30:00.000Z",
        startedAt: "2026-08-21T00:31:00.000Z",
        updatedAt: "2026-08-21T00:32:00.000Z",
        status: "completed",
        conclusion: "success",
        runNumber: index + 2,
      }));
    const priorApply = githubRun({
      id: "6999",
      workflow: CURRENT_WORKFLOW,
      name: "Transition protected production Postgres maintenance LOGIN limit",
      displayTitle: `Production maintenance LOGIN limit | apply | ${CANDIDATE}`,
      createdAt: "2026-08-21T00:20:00.000Z",
      startedAt: "2026-08-21T00:21:00.000Z",
      updatedAt: "2026-08-21T00:22:00.000Z",
      status: "completed",
      conclusion: "failure",
      runNumber: 1,
    });
    const target = harness({
      priorRoleRuns: [...priorReconciliations, priorApply],
    });
    await expect(target.run()).resolves.toBe(1);
    expect(target.files.has(OUTPUT)).toBe(false);
    expect(target.fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("per_page=100&page=2"),
      expect.anything(),
    );
    expect(JSON.parse(target.output.at(-1)!)).toMatchObject({
      failureCode: "later_run_detected",
    });
  });

  it("blocks a missing or deleted workflow run number in the bounded history", async () => {
    const priorReconciliation = githubRun({
      id: "2997",
      workflow: CURRENT_WORKFLOW,
      name: "Transition protected production Postgres maintenance LOGIN limit",
      displayTitle:
        `Production maintenance LOGIN limit | reconcile | ${CANDIDATE}`,
      createdAt: "2026-08-21T00:20:00.000Z",
      startedAt: "2026-08-21T00:21:00.000Z",
      updatedAt: "2026-08-21T00:22:00.000Z",
      status: "completed",
      conclusion: "failure",
      runNumber: 1,
    });
    const target = harness({
      priorRoleRuns: [priorReconciliation],
      currentRoleRunNumber: 3,
    });
    await expect(target.run()).resolves.toBe(1);
    expect(target.files.has(OUTPUT)).toBe(false);
    expect(JSON.parse(target.output.at(-1)!)).toMatchObject({
      failureCode: "later_run_detected",
    });
  });
});

describe("production deployment worker-fence prerequisite", () => {
  it("emits canonical same-candidate fence authority before deploy custody", async () => {
    const target = productionDeployHarness();
    await expect(target.run()).resolves.toBe(0);
    const verification = JSON.parse(
      target.files.get(DEPLOYMENT_PREFLIGHT_OUTPUT)!,
    );
    expect(verification).toMatchObject({
      schemaVersion:
        "pintpath-production-deployment-worker-fence-prerequisite/v1",
      roleLimitPolicySha256:
        PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
      candidateSha: CANDIDATE,
      consumer: {
        workflowPath: DEPLOYMENT_WORKFLOW,
        githubEnvironment: "production-deployment",
        runId: CURRENT_RUN_ID,
      },
      workerFence: {
        runId: FENCE_RUN_ID,
        deploymentIdSha256: sha("deployment"),
      },
      checks: {
        fenceWorkersDisabledExact: true,
        fenceCandidateBindingExact: true,
        downloadActionPinExact: true,
        noLaterProductionWorkerFenceRunExact: true,
        noPriorProductionDeploymentRunExact: true,
      },
      secretMaterialIncluded: false,
    });
    expect(target.fetchImpl).toHaveBeenCalledTimes(8);
    expect(target.files.get(DEPLOYMENT_PREFLIGHT_OUTPUT)).not.toContain(
      "synthetic-github-token",
    );
    expect(JSON.parse(target.output.at(-1)!)).toMatchObject({
      ok: true,
      mode: "production-deploy",
      fenceRunId: FENCE_RUN_ID,
      deploymentRunId: null,
      priorRoleRunId: null,
      roleLimitRunId: null,
      activateRunId: null,
    });
  });

  it.each([
    ["artifact without run provenance", { omitArtifactWorkflowRun: true }],
    ["later production fence", { laterFenceRun: true }],
    [
      "local receipt not present in the authority archive",
      { fenceArchiveSource: fenceTerminal({ outcome: "failed" }) },
    ],
    [
      "candidate-drifted terminal",
      {
        fenceSource: fenceTerminal({
          binding: {
            ...JSON.parse(fenceTerminal()).binding,
            candidateSha: "b".repeat(40),
          },
        }),
      },
    ],
  ])("blocks %s before deploy authority evidence", async (_label, input) => {
    const target = productionDeployHarness(input);
    await expect(target.run()).resolves.toBe(1);
    expect(target.files.has(DEPLOYMENT_PREFLIGHT_OUTPUT)).toBe(false);
    expect(JSON.parse(target.output.at(-1)!)).toMatchObject({
      ok: false,
      productionContactAttempted: false,
      secretMaterialIncluded: false,
    });
  });
});

describe("production activation role-limit prerequisite", () => {
  it("binds the full fence, deploy, and successful role mutation chain", async () => {
    const target = await productionActivateHarness();
    await expect(target.run()).resolves.toBe(0);
    const verification = JSON.parse(target.files.get(ACTIVATION_OUTPUT)!);
    expect(verification).toMatchObject({
      schemaVersion: "pintpath-production-activation-role-limit-prerequisite/v1",
      candidateSha: CANDIDATE,
      consumer: { runId: ACTIVATE_RUN_ID },
      roleLimit: { runId: CURRENT_RUN_ID, outcome: "updated" },
      rolePrerequisites: {
        workerFence: { runId: FENCE_RUN_ID },
        productionDeployment: { runId: DEPLOYMENT_RUN_ID, replicaCount: 1 },
      },
      checks: {
        fullFenceDeployRoleChainExact: true,
        independentRoleArchiveDigestExact: true,
        roleIntentExact: true,
        noLaterRoleLimitRunExact: true,
      },
      secretMaterialIncluded: false,
    });
    expect(JSON.parse(target.output.at(-1)!)).toMatchObject({
      ok: true,
      mode: "production-activate",
      fenceRunId: null,
      deploymentRunId: null,
      priorRoleRunId: null,
      roleLimitRunId: CURRENT_RUN_ID,
      activateRunId: null,
    });
  });

  it("blocks a role receipt that differs from its authority archive", async () => {
    const target = await productionActivateHarness({ tamperReceiptArchive: true });
    await expect(target.run()).resolves.toBe(1);
    expect(target.files.has(ACTIVATION_OUTPUT)).toBe(false);
  });

  it("blocks role intent bytes not present in the authority archive", async () => {
    const target = await productionActivateHarness({
      tamperIntentArchive: true,
    });
    await expect(target.run()).resolves.toBe(1);
    expect(target.files.has(ACTIVATION_OUTPUT)).toBe(false);
  });
});

describe("production scale activation prerequisite", () => {
  it("binds the role-to-activate deployment generation before scale", async () => {
    const target = await productionScaleHarness();
    await expect(target.run()).resolves.toBe(0);
    const verification = JSON.parse(target.files.get(SCALE_OUTPUT)!);
    expect(verification).toMatchObject({
      schemaVersion: "pintpath-production-scale-activation-prerequisite/v1",
      candidateSha: CANDIDATE,
      consumer: { runId: SCALE_RUN_ID },
      activation: {
        runId: ACTIVATE_RUN_ID,
        deploymentBeforeIdSha256: sha("new-deployment"),
        deploymentAfterIdSha256: sha("activated-deployment"),
      },
      activationPrerequisites: {
        roleLimit: { runId: CURRENT_RUN_ID },
      },
      checks: {
        activationTerminalExact: true,
        fullRoleActivateChainExact: true,
        noPriorOrConcurrentScaleRunExact: true,
      },
      secretMaterialIncluded: false,
    });
    expect(JSON.parse(target.output.at(-1)!)).toMatchObject({
      ok: true,
      mode: "production-scale",
      fenceRunId: null,
      deploymentRunId: null,
      priorRoleRunId: null,
      roleLimitRunId: null,
      activateRunId: ACTIVATE_RUN_ID,
    });
  });

  it("blocks activation terminal bytes not present in the authority archive", async () => {
    const target = await productionScaleHarness({
      tamperActivationTerminal: true,
    });
    await expect(target.run()).resolves.toBe(1);
    expect(target.files.has(SCALE_OUTPUT)).toBe(false);
  });
});

describe("production maintenance role-limit reconciliation authority", () => {
  it("authenticates the prior apply intent and prerequisites without a new mutation prerequisite", async () => {
    const target = await reconciliationHarness();
    await expect(target.run()).resolves.toBe(0);
    const verification = JSON.parse(
      target.files.get(RECONCILIATION_OUTPUT)!,
    );
    expect(verification).toMatchObject({
      schemaVersion:
        "pintpath-production-maintenance-role-limit-reconciliation-authority/v1",
      candidateSha: CANDIDATE,
      consumer: { runId: RECONCILE_RUN_ID },
      priorApply: {
        runId: CURRENT_RUN_ID,
        conclusion: "failure",
      },
      checks: {
        independentPriorArchiveDigestExact: true,
        localPriorFilesMatchArchiveExact: true,
        priorIntentExact: true,
        priorPrerequisiteBindingExact: true,
        noNewMutationPrerequisitesRequiredExact: true,
        noLaterRoleApplyRunExact: true,
      },
      secretMaterialIncluded: false,
    });
    expect(JSON.parse(target.output.at(-1)!)).toMatchObject({
      ok: true,
      mode: "role-limit-reconcile",
      fenceRunId: null,
      deploymentRunId: null,
      priorRoleRunId: CURRENT_RUN_ID,
      roleLimitRunId: null,
      activateRunId: null,
    });
  });

  it("blocks prior intent bytes that differ from the authority archive", async () => {
    const target = await reconciliationHarness({ tamperArchive: true });
    await expect(target.run()).resolves.toBe(1);
    expect(target.files.has(RECONCILIATION_OUTPUT)).toBe(false);
  });
});
