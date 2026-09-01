import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import zlib from "node:zlib";

import { fetchBoundedResponseText } from "./lib/bounded-http-response.js";
import {
  holdPrivateDirectoryIdentity,
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

export const PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_SCHEMA =
  "pintpath-production-maintenance-login-limit-prerequisites/v1" as const;
export const PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_FILENAME =
  "prerequisites-verification.json" as const;
export const PRODUCTION_DEPLOYMENT_WORKER_FENCE_PREREQUISITE_SCHEMA =
  "pintpath-production-deployment-worker-fence-prerequisite/v1" as const;
export const PRODUCTION_DEPLOYMENT_WORKER_FENCE_PREREQUISITE_FILENAME =
  "production-deployment-worker-fence-verification.json" as const;
export const PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_SCHEMA =
  "pintpath-production-activation-role-limit-prerequisite/v1" as const;
export const PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_FILENAME =
  "production-activation-role-limit-verification.json" as const;
export const PRODUCTION_SCALE_ACTIVATION_PREREQUISITE_SCHEMA =
  "pintpath-production-scale-activation-prerequisite/v1" as const;
export const PRODUCTION_SCALE_ACTIVATION_PREREQUISITE_FILENAME =
  "production-scale-activation-verification.json" as const;
export const PRODUCTION_ROLE_LIMIT_RECONCILIATION_AUTHORITY_SCHEMA =
  "pintpath-production-maintenance-role-limit-reconciliation-authority/v1" as const;
export const PRODUCTION_ROLE_LIMIT_RECONCILIATION_AUTHORITY_FILENAME =
  "reconciliation-authority-verification.json" as const;
export const PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256 =
  "b9cf711daa228c4fc8b1a289320b64cf4c32de2c92003f99afd4e5e7b66b5317" as const;

const REPOSITORY = "blackmagic30/Beer" as const;
const ROLE_LIMIT_WORKFLOW =
  ".github/workflows/transition-production-postgres-maintenance-role-limit.yml" as const;
const ROLE_LIMIT_WORKFLOW_ID =
  "transition-production-postgres-maintenance-role-limit.yml" as const;
const ROLE_LIMIT_WORKFLOW_NAME =
  "Transition protected production Postgres maintenance LOGIN limit" as const;
const ROLE_LIMIT_WORKFLOW_SHA256 =
  "7eebf2f9f22e7a450918f548c355db5e9a8bda08073aecf23af17acdf6390684" as const;
const ROLE_LIMIT_GITHUB_ENVIRONMENT =
  "production-postgres-maintenance-role-limit" as const;
const ROLE_LIMIT_POLICY_PATH =
  "ops/postgres/protected-production-maintenance-login-limit-policy.json" as const;
const FENCE_WORKFLOW =
  ".github/workflows/configure-automatic-maintenance-worker-fence.yml" as const;
const FENCE_WORKFLOW_ID =
  "configure-automatic-maintenance-worker-fence.yml" as const;
const FENCE_WORKFLOW_NAME =
  "Configure candidate-bound automatic-maintenance worker fence" as const;
const FENCE_WORKFLOW_SHA256 =
  "c7cb09c187a92693141db89eb0b3313d4ca8c0d1bc85179a2cf1d39ffc5f17f8" as const;
const FENCE_POLICY_PATH =
  "ops/railway/protected-automatic-maintenance-worker-fence-policy.json" as const;
const FENCE_POLICY_SHA256 =
  "685539a691f290e2d870d69de452fe1fcbd0635065276e9a51b51864aaf29d27" as const;
const FENCE_PRODUCER_PATH =
  "scripts/execute-protected-automatic-maintenance-worker-fence.ts" as const;
const FENCE_PRODUCER_SHA256 =
  "d0383dc06a1fde24cd8a744d0d2b5ca024e1458596427d8e54ac10b7a8e8a0a9" as const;
const FENCE_TERMINAL_SCHEMA =
  "pintpath-automatic-maintenance-worker-fence-terminal/v1" as const;
const DEPLOYMENT_WORKFLOW = ".github/workflows/deploy-production.yml" as const;
const DEPLOYMENT_WORKFLOW_ID = "deploy-production.yml" as const;
const DEPLOYMENT_WORKFLOW_NAME =
  "Deploy Pint Path protected production" as const;
const DEPLOYMENT_WORKFLOW_SHA256 =
  "414163692a141fc581498e8faf9d810f441710c0312df4a814ceabd36f03b511" as const;
const PRODUCTION_SCALE_WORKFLOW =
  ".github/workflows/production-converge-two-replicas.yml" as const;
const PRODUCTION_SCALE_WORKFLOW_ID =
  "production-converge-two-replicas.yml" as const;
const PRODUCTION_SCALE_WORKFLOW_NAME =
  "Converge Pint Path production to two replicas" as const;
const PRODUCTION_SCALE_WORKFLOW_SHA256 =
  "3ceabb61fa568f8703104cbff66b84c9081d50ccc6bc3e877f9d61a6aff93917" as const;
const PRODUCTION_SCALE_POLICY_PATH =
  "ops/railway/permanent-staging-scale-evidence-policy.json" as const;
const PRODUCTION_SCALE_POLICY_SHA256 =
  "164d53a5bccff4a861c8568abebe5caa06352f64245ac7e734e55c056c2be608" as const;
const PRODUCTION_SCALE_PRODUCER_PATH =
  "scripts/execute-protected-permanent-staging-scale.ts" as const;
const PRODUCTION_SCALE_PRODUCER_SHA256 =
  "352697d0868bf5c9859a5d817b30034f01e49595b1eb6ba3de7861a637b4a33d" as const;
const DEPLOYMENT_POLICY_PATH =
  "ops/railway/production-app-deployment-policy.json" as const;
const DEPLOYMENT_POLICY_SHA256 =
  "e6fbbafd835a038e9bf7e803466b2519d56ffb1d4b4cc5d55a946dcda7a9c487" as const;
const DEPLOYMENT_PRODUCER_PATH =
  "scripts/lib/permanent-staging-app-deployment-executor.ts" as const;
const DEPLOYMENT_PRODUCER_SHA256 =
  "051b0fb59e359985a69fda2761d330ed07d86372ba2efefc72d90cff6bd6943d" as const;
const DEPLOYMENT_RECEIPT_SCHEMA =
  "pintpath-railway-application-deployment-executor/v5" as const;
const GITHUB_API_ORIGIN = "https://api.github.com" as const;
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5" as const;
const PRODUCTION_ENVIRONMENT_ID =
  "13dab015-df74-45c6-b26f-69323daea99a" as const;
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0" as const;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const MAXIMUM_GITHUB_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_EVIDENCE_BYTES = 1024 * 1024;
const MAXIMUM_RECEIPT_AGE_MS = 86_400_000;
const MAXIMUM_VERIFICATION_AGE_MS = 900_000;
const MAXIMUM_CLOCK_SKEW_MS = 300_000;
const REQUEST_TIMEOUT_MS = 20_000;
const ROLE_LIMIT_HISTORY_CREATED_AT_LOWER_BOUND =
  "2026-08-20T00:00:00.000Z" as const;
const ROLE_LIMIT_HISTORY_AUTHORITY_EXPIRES_AT =
  "2026-09-20T00:00:00.000Z" as const;
const ROLE_LIMIT_HISTORY_PAGE_SIZE = 100;
const ROLE_LIMIT_HISTORY_MAXIMUM_RUNS = 999;
const ROLE_LIMIT_RECEIPT_SCHEMA =
  "pintpath-production-maintenance-login-limit-receipt/v1" as const;
const ROLE_LIMIT_TERMINAL_SCHEMA =
  "pintpath-production-maintenance-login-limit-terminal/v1" as const;
const ROLE_LIMIT_POLICY_ID =
  "pintpath-production-maintenance-login-limit-2-to-8" as const;
const DOWNLOAD_ARTIFACT_ACTION_COMMIT =
  "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c" as const;

type JsonRecord = Record<string, unknown>;

type FailureCode =
  | "arguments_invalid"
  | "artifact_authority_invalid"
  | "chronology_invalid"
  | "deployment_receipt_invalid"
  | "environment_invalid"
  | "evidence_invalid"
  | "fence_receipt_invalid"
  | "github_api_failed"
  | "github_api_invalid"
  | "later_run_detected"
  | "policy_invalid"
  | "run_authority_invalid";

class PrerequisiteError extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
    this.name = "PrerequisiteError";
  }
}

function fail(code: FailureCode): never {
  throw new PrerequisiteError(code);
}

type VerificationMode =
  | "role-limit"
  | "production-deploy"
  | "role-limit-reconcile"
  | "production-activate"
  | "production-scale";

interface Arguments {
  readonly mode: VerificationMode;
  readonly candidateSha: string;
  readonly fenceRunId: string;
  readonly deploymentRunId: string | null;
  readonly fenceTerminalFile: string;
  readonly deploymentReceiptFile: string | null;
  readonly roleLimitRunId: string | null;
  readonly roleIntentFile: string | null;
  readonly roleTerminalFile: string | null;
  readonly roleReceiptFile: string | null;
  readonly rolePrerequisitesFile: string | null;
  readonly activateRunId: string | null;
  readonly activateTerminalFile: string | null;
  readonly activationPrerequisitesFile: string | null;
  readonly priorRoleRunId: string | null;
  readonly priorIntentFile: string | null;
  readonly priorPrerequisitesFile: string | null;
  readonly output: string;
}

interface GithubRun {
  readonly id: string;
  readonly workflowPath: string;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly createdAt: string;
  readonly createdAtMs: number;
  readonly completedAt: string;
  readonly completedAtMs: number;
}

interface GithubArtifact {
  readonly id: string;
  readonly name: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly archiveDownloadUrl: string;
}

export interface ProductionMaintenanceRoleLimitPrerequisitesVerification {
  readonly schemaVersion:
    typeof PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_SCHEMA;
  readonly policySha256:
    typeof PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256;
  readonly candidateSha: string;
  readonly repository: typeof REPOSITORY;
  readonly consumer: {
    readonly workflowPath: typeof ROLE_LIMIT_WORKFLOW;
    readonly githubEnvironment: typeof ROLE_LIMIT_GITHUB_ENVIRONMENT;
    readonly runId: string;
    readonly runAttempt: 1;
    readonly startedAt: string;
  };
  readonly workerFence: {
    readonly workflowPath: typeof FENCE_WORKFLOW;
    readonly runId: string;
    readonly runAttempt: 1;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly artifactName: string;
    readonly artifactId: string;
    readonly artifactDigest: string;
    readonly artifactSizeBytes: number;
    readonly policySha256: typeof FENCE_POLICY_SHA256;
    readonly producerSha256: typeof FENCE_PRODUCER_SHA256;
    readonly producerWorkflowSha256: typeof FENCE_WORKFLOW_SHA256;
    readonly terminalSha256: string;
    readonly bindingSha256: string;
    readonly intentSha256: string;
  };
  readonly productionDeployment: {
    readonly workflowPath: typeof DEPLOYMENT_WORKFLOW;
    readonly runId: string;
    readonly runAttempt: 1;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly artifactName: string;
    readonly artifactId: string;
    readonly artifactDigest: string;
    readonly artifactSizeBytes: number;
    readonly policySha256: typeof DEPLOYMENT_POLICY_SHA256;
    readonly producerSha256: typeof DEPLOYMENT_PRODUCER_SHA256;
    readonly producerWorkflowSha256: typeof DEPLOYMENT_WORKFLOW_SHA256;
    readonly receiptSha256: string;
    readonly deploymentIdSha256: string;
    readonly replicaCount: 1;
  };
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly checks: {
    readonly policiesExact: true;
    readonly consumerRunAuthorityExact: true;
    readonly fenceRunAuthorityExact: true;
    readonly fenceArtifactAuthorityExact: true;
    readonly downloadActionPinExact: true;
    readonly uniquePrerequisiteReceiptsExact: true;
    readonly independentArtifactArchiveDigestsExact: true;
    readonly localReceiptBytesMatchArchivesExact: true;
    readonly fenceReceiptExact: true;
    readonly fenceWorkersDisabledExact: true;
    readonly fenceCandidateBindingExact: true;
    readonly fenceDeploymentUnchangedExact: true;
    readonly deploymentRunAuthorityExact: true;
    readonly deploymentArtifactAuthorityExact: true;
    readonly deploymentReceiptExact: true;
    readonly deploymentRuntimeWorkersDisabledExact: true;
    readonly deploymentRuntimeCandidateBindingExact: true;
    readonly deploymentSoleHealthyCandidateExact: true;
    readonly chronologyExact: true;
    readonly noLaterProductionWorkerFenceRunExact: true;
    readonly noLaterProductionDeploymentRunExact: true;
    readonly noLaterProductionScaleRunExact: true;
    readonly noPriorRoleLimitApplyRunExact: true;
    readonly evidenceSecretFreeExact: true;
  };
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
}

export interface ProductionDeploymentWorkerFencePrerequisiteVerification {
  readonly schemaVersion:
    typeof PRODUCTION_DEPLOYMENT_WORKER_FENCE_PREREQUISITE_SCHEMA;
  readonly roleLimitPolicySha256:
    typeof PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256;
  readonly workerFencePolicySha256: typeof FENCE_POLICY_SHA256;
  readonly productionDeploymentPolicySha256: typeof DEPLOYMENT_POLICY_SHA256;
  readonly candidateSha: string;
  readonly repository: typeof REPOSITORY;
  readonly consumer: {
    readonly workflowPath: typeof DEPLOYMENT_WORKFLOW;
    readonly githubEnvironment: "production-deployment";
    readonly runId: string;
    readonly runAttempt: 1;
    readonly startedAt: string;
  };
  readonly workerFence: {
    readonly workflowPath: typeof FENCE_WORKFLOW;
    readonly runId: string;
    readonly runAttempt: 1;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly artifactName: string;
    readonly artifactId: string;
    readonly artifactDigest: string;
    readonly artifactSizeBytes: number;
    readonly terminalSha256: string;
    readonly bindingSha256: string;
    readonly intentSha256: string;
    readonly deploymentIdSha256: string;
    readonly producerSha256: typeof FENCE_PRODUCER_SHA256;
    readonly producerWorkflowSha256: typeof FENCE_WORKFLOW_SHA256;
  };
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly checks: {
    readonly policiesExact: true;
    readonly consumerRunAuthorityExact: true;
    readonly fenceRunAuthorityExact: true;
    readonly fenceArtifactAuthorityExact: true;
    readonly downloadActionPinExact: true;
    readonly uniqueFenceReceiptExact: true;
    readonly independentFenceArchiveDigestExact: true;
    readonly localFenceReceiptBytesMatchArchiveExact: true;
    readonly fenceReceiptExact: true;
    readonly fenceWorkersDisabledExact: true;
    readonly fenceCandidateBindingExact: true;
    readonly fenceDeploymentUnchangedExact: true;
    readonly chronologyExact: true;
    readonly noLaterProductionWorkerFenceRunExact: true;
    readonly noPriorProductionDeploymentRunExact: true;
    readonly noProductionScaleRunAfterFenceExact: true;
    readonly evidenceSecretFreeExact: true;
  };
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
}

export interface ProductionActivationRoleLimitPrerequisiteVerification {
  readonly schemaVersion:
    typeof PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_SCHEMA;
  readonly policySha256:
    typeof PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256;
  readonly candidateSha: string;
  readonly repository: typeof REPOSITORY;
  readonly consumer: {
    readonly workflowPath: typeof FENCE_WORKFLOW;
    readonly githubEnvironment: "production-runtime-configuration";
    readonly runId: string;
    readonly runAttempt: 1;
    readonly startedAt: string;
  };
  readonly roleLimit: {
    readonly workflowPath: typeof ROLE_LIMIT_WORKFLOW;
    readonly runId: string;
    readonly runAttempt: 1;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly artifactName: string;
    readonly artifactId: string;
    readonly artifactDigest: string;
    readonly artifactSizeBytes: number;
    readonly intentSha256: string;
    readonly terminalSha256: string;
    readonly receiptSha256: string;
    readonly prerequisitesSha256: string;
    readonly outcome: "updated" | "reconciled_after_ambiguous_write";
  };
  readonly rolePrerequisites:
    ProductionMaintenanceRoleLimitPrerequisitesVerification;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly checks: {
    readonly policiesExact: true;
    readonly consumerRunAuthorityExact: true;
    readonly roleRunAuthorityExact: true;
    readonly roleArtifactAuthorityExact: true;
    readonly independentRoleArchiveDigestExact: true;
    readonly localRoleFilesMatchArchiveExact: true;
    readonly roleIntentExact: true;
    readonly roleTerminalExact: true;
    readonly fullFenceDeployRoleChainExact: true;
    readonly chronologyExact: true;
    readonly noLaterProductionWorkerRunExact: true;
    readonly noLaterProductionDeploymentRunExact: true;
    readonly noLaterRoleLimitRunExact: true;
    readonly noProductionScaleRunAfterDeploymentExact: true;
    readonly evidenceSecretFreeExact: true;
  };
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
}

export interface ProductionScaleActivationPrerequisiteVerification {
  readonly schemaVersion: typeof PRODUCTION_SCALE_ACTIVATION_PREREQUISITE_SCHEMA;
  readonly policySha256:
    typeof PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256;
  readonly candidateSha: string;
  readonly repository: typeof REPOSITORY;
  readonly consumer: {
    readonly workflowPath: typeof PRODUCTION_SCALE_WORKFLOW;
    readonly githubEnvironment: "production-topology-configuration";
    readonly runId: string;
    readonly runAttempt: 1;
    readonly startedAt: string;
  };
  readonly activation: {
    readonly workflowPath: typeof FENCE_WORKFLOW;
    readonly runId: string;
    readonly runAttempt: 1;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly artifactName: string;
    readonly artifactId: string;
    readonly artifactDigest: string;
    readonly artifactSizeBytes: number;
    readonly terminalSha256: string;
    readonly prerequisitesSha256: string;
    readonly deploymentBeforeIdSha256: string;
    readonly deploymentAfterIdSha256: string;
  };
  readonly activationPrerequisites:
    ProductionActivationRoleLimitPrerequisiteVerification;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly checks: {
    readonly policiesExact: true;
    readonly consumerRunAuthorityExact: true;
    readonly activationRunAuthorityExact: true;
    readonly activationArtifactAuthorityExact: true;
    readonly independentActivationArchiveDigestExact: true;
    readonly localActivationFilesMatchArchiveExact: true;
    readonly activationTerminalExact: true;
    readonly fullRoleActivateChainExact: true;
    readonly chronologyExact: true;
    readonly noLaterProductionWorkerRunExact: true;
    readonly noLaterProductionDeploymentRunExact: true;
    readonly noLaterRoleLimitRunExact: true;
    readonly noPriorOrConcurrentScaleRunExact: true;
    readonly evidenceSecretFreeExact: true;
  };
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
}

export interface ProductionRoleLimitReconciliationAuthorityVerification {
  readonly schemaVersion:
    typeof PRODUCTION_ROLE_LIMIT_RECONCILIATION_AUTHORITY_SCHEMA;
  readonly policySha256:
    typeof PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256;
  readonly candidateSha: string;
  readonly repository: typeof REPOSITORY;
  readonly consumer: {
    readonly workflowPath: typeof ROLE_LIMIT_WORKFLOW;
    readonly githubEnvironment: typeof ROLE_LIMIT_GITHUB_ENVIRONMENT;
    readonly runId: string;
    readonly runAttempt: 1;
    readonly startedAt: string;
  };
  readonly priorApply: {
    readonly workflowPath: typeof ROLE_LIMIT_WORKFLOW;
    readonly runId: string;
    readonly runAttempt: 1;
    readonly conclusion: "success" | "failure" | "cancelled" | "timed_out";
    readonly startedAt: string;
    readonly completedAt: string;
    readonly artifactName: string;
    readonly artifactId: string;
    readonly artifactDigest: string;
    readonly artifactSizeBytes: number;
    readonly intentSha256: string;
    readonly prerequisitesSha256: string;
  };
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly checks: {
    readonly policiesExact: true;
    readonly consumerRunAuthorityExact: true;
    readonly priorApplyRunAuthorityExact: true;
    readonly priorIntentArtifactAuthorityExact: true;
    readonly independentPriorArchiveDigestExact: true;
    readonly localPriorFilesMatchArchiveExact: true;
    readonly priorIntentExact: true;
    readonly priorPrerequisiteBindingExact: true;
    readonly noNewMutationPrerequisitesRequiredExact: true;
    readonly noLaterRoleApplyRunExact: true;
    readonly evidenceSecretFreeExact: true;
  };
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly now: () => Date;
  readonly readPrivateFile: (filename: string) => Buffer;
  readonly writeEvidence: (filename: string, source: string) => void;
  readonly writeOutput: (source: string) => void;
  readonly requestTimeoutMs: number;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
): value is JsonRecord {
  return record(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function exactAbsoluteFile(value: string, leaf: string): boolean {
  return path.isAbsolute(value)
    && path.resolve(value) === value
    && path.normalize(value) === value
    && !value.includes("\0")
    && path.basename(value) === leaf;
}

function parseArguments(argv: readonly string[]): Arguments {
  const allowed = new Set([
    "--mode",
    "--candidate-sha",
    "--fence-run-id",
    "--deployment-run-id",
    "--fence-terminal-file",
    "--deployment-receipt-file",
    "--role-limit-run-id",
    "--role-intent-file",
    "--role-terminal-file",
    "--role-receipt-file",
    "--role-prerequisites-file",
    "--activate-run-id",
    "--activate-terminal-file",
    "--activation-prerequisites-file",
    "--prior-role-run-id",
    "--prior-intent-file",
    "--prior-prerequisites-file",
    "--output",
  ]);
  if (argv.length < 10 || argv.length > 16 || argv.length % 2 !== 0) {
    fail("arguments_invalid");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !allowed.has(key) || !value || values.has(key)) {
      fail("arguments_invalid");
    }
    values.set(key, value);
  }
  const mode = values.get("--mode");
  if (
    mode !== "role-limit"
    && mode !== "production-deploy"
    && mode !== "role-limit-reconcile"
    && mode !== "production-activate"
    && mode !== "production-scale"
  ) {
    fail("arguments_invalid");
  }
  const result: Arguments = {
    mode,
    candidateSha: values.get("--candidate-sha") ?? "",
    fenceRunId: values.get("--fence-run-id") ?? "",
    deploymentRunId: values.get("--deployment-run-id") ?? null,
    fenceTerminalFile: values.get("--fence-terminal-file") ?? "",
    deploymentReceiptFile: values.get("--deployment-receipt-file") ?? null,
    roleLimitRunId: values.get("--role-limit-run-id") ?? null,
    roleIntentFile: values.get("--role-intent-file") ?? null,
    roleTerminalFile: values.get("--role-terminal-file") ?? null,
    roleReceiptFile: values.get("--role-receipt-file") ?? null,
    rolePrerequisitesFile: values.get("--role-prerequisites-file") ?? null,
    activateRunId: values.get("--activate-run-id") ?? null,
    activateTerminalFile: values.get("--activate-terminal-file") ?? null,
    activationPrerequisitesFile:
      values.get("--activation-prerequisites-file") ?? null,
    priorRoleRunId: values.get("--prior-role-run-id") ?? null,
    priorIntentFile: values.get("--prior-intent-file") ?? null,
    priorPrerequisitesFile: values.get("--prior-prerequisites-file") ?? null,
    output: values.get("--output") ?? "",
  };
  const exactKeysForMode = mode === "role-limit"
    ? [
        "--mode",
        "--candidate-sha",
        "--fence-run-id",
        "--deployment-run-id",
        "--fence-terminal-file",
        "--deployment-receipt-file",
        "--output",
      ]
    : mode === "production-deploy"
      ? [
        "--mode",
        "--candidate-sha",
        "--fence-run-id",
        "--fence-terminal-file",
        "--output",
      ]
      : mode === "role-limit-reconcile"
        ? [
            "--mode",
            "--candidate-sha",
            "--prior-role-run-id",
            "--prior-intent-file",
            "--prior-prerequisites-file",
            "--output",
          ]
      : mode === "production-activate"
        ? [
            "--mode",
            "--candidate-sha",
            "--role-limit-run-id",
            "--role-intent-file",
            "--role-terminal-file",
            "--role-receipt-file",
            "--role-prerequisites-file",
            "--output",
          ]
        : [
            "--mode",
            "--candidate-sha",
            "--activate-run-id",
            "--activate-terminal-file",
            "--activation-prerequisites-file",
            "--output",
          ];
  const expectedOutput = mode === "role-limit"
    ? PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_FILENAME
    : mode === "production-deploy"
      ? PRODUCTION_DEPLOYMENT_WORKER_FENCE_PREREQUISITE_FILENAME
      : mode === "role-limit-reconcile"
        ? PRODUCTION_ROLE_LIMIT_RECONCILIATION_AUTHORITY_FILENAME
      : mode === "production-activate"
        ? PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_FILENAME
        : PRODUCTION_SCALE_ACTIVATION_PREREQUISITE_FILENAME;
  if (
    values.size !== exactKeysForMode.length
    || exactKeysForMode.some((key) => !values.has(key))
    || !SHA_PATTERN.test(result.candidateSha)
    || !exactAbsoluteFile(result.output, expectedOutput)
  ) fail("arguments_invalid");
  if (
    (mode === "role-limit" || mode === "production-deploy")
    && (!RUN_ID_PATTERN.test(result.fenceRunId)
      || !exactAbsoluteFile(
        result.fenceTerminalFile,
        "automatic-maintenance-worker-fence-terminal.json",
      ))
  ) fail("arguments_invalid");
  if (
    mode === "role-limit"
    && (!result.deploymentRunId
      || !RUN_ID_PATTERN.test(result.deploymentRunId)
      || result.fenceRunId === result.deploymentRunId
      || !result.deploymentReceiptFile
      || !exactAbsoluteFile(
        result.deploymentReceiptFile,
        "deployment-receipt.json",
      ))
  ) fail("arguments_invalid");
  if (
    mode === "role-limit-reconcile"
    && (!result.priorRoleRunId
      || !RUN_ID_PATTERN.test(result.priorRoleRunId)
      || !result.priorIntentFile
      || !exactAbsoluteFile(result.priorIntentFile, "intent.json")
      || !result.priorPrerequisitesFile
      || !exactAbsoluteFile(
        result.priorPrerequisitesFile,
        PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_FILENAME,
      ))
  ) fail("arguments_invalid");
  if (
    mode === "production-activate"
    && (!result.roleLimitRunId
      || !RUN_ID_PATTERN.test(result.roleLimitRunId)
      || !result.roleIntentFile
      || !exactAbsoluteFile(result.roleIntentFile, "intent.json")
      || !result.roleTerminalFile
      || !exactAbsoluteFile(result.roleTerminalFile, "terminal.json")
      || !result.roleReceiptFile
      || !exactAbsoluteFile(result.roleReceiptFile, "receipt.json")
      || !result.rolePrerequisitesFile
      || !exactAbsoluteFile(
        result.rolePrerequisitesFile,
        PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_FILENAME,
      ))
  ) fail("arguments_invalid");
  if (
    mode === "production-scale"
    && (!result.activateRunId
      || !RUN_ID_PATTERN.test(result.activateRunId)
      || !result.activateTerminalFile
      || !exactAbsoluteFile(
        result.activateTerminalFile,
        "automatic-maintenance-worker-fence-terminal.json",
      )
      || !result.activationPrerequisitesFile
      || !exactAbsoluteFile(
        result.activationPrerequisitesFile,
        PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_FILENAME,
      ))
  ) fail("arguments_invalid");
  return result;
}

function timestamp(value: unknown, code: FailureCode): {
  readonly canonical: string;
  readonly milliseconds: number;
} {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) fail(code);
  const milliseconds = Date.parse(value);
  const canonicalValue = Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : "";
  if (
    canonicalValue
      !== (value.includes(".") ? value : value.replace("Z", ".000Z"))
  ) fail(code);
  return { canonical: canonicalValue, milliseconds };
}

function parseCanonicalPrivateJson(
  filename: string,
  readPrivateFile: (filename: string) => Buffer,
  code: FailureCode,
): { readonly source: string; readonly value: JsonRecord } {
  let bytes: Buffer | null = null;
  try {
    bytes = readPrivateFile(filename);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(source) as unknown;
    if (!record(value) || canonical(value) !== source) fail(code);
    return { source, value };
  } catch (error) {
    if (error instanceof PrerequisiteError) throw error;
    throw new PrerequisiteError(code);
  } finally {
    bytes?.fill(0);
  }
}

function validatePolicies(cwd: string): void {
  const policies = [
    [ROLE_LIMIT_POLICY_PATH, PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256],
    [FENCE_POLICY_PATH, FENCE_POLICY_SHA256],
    [DEPLOYMENT_POLICY_PATH, DEPLOYMENT_POLICY_SHA256],
    [PRODUCTION_SCALE_POLICY_PATH, PRODUCTION_SCALE_POLICY_SHA256],
  ] as const;
  try {
    for (const [relative, expected] of policies) {
      const bytes = readTrustedRegularFile(path.resolve(cwd, relative), {
        minBytes: 1,
        maxBytes: MAXIMUM_EVIDENCE_BYTES,
      });
      const actual = sha256(bytes);
      const value = JSON.parse(bytes.toString("utf8")) as unknown;
      bytes.fill(0);
      if (!record(value) || actual !== expected) fail("policy_invalid");
    }
    for (const [relative, expected] of [
      [FENCE_PRODUCER_PATH, FENCE_PRODUCER_SHA256],
      [DEPLOYMENT_PRODUCER_PATH, DEPLOYMENT_PRODUCER_SHA256],
      [FENCE_WORKFLOW, FENCE_WORKFLOW_SHA256],
      [DEPLOYMENT_WORKFLOW, DEPLOYMENT_WORKFLOW_SHA256],
      [ROLE_LIMIT_WORKFLOW, ROLE_LIMIT_WORKFLOW_SHA256],
      [PRODUCTION_SCALE_WORKFLOW, PRODUCTION_SCALE_WORKFLOW_SHA256],
      [PRODUCTION_SCALE_PRODUCER_PATH, PRODUCTION_SCALE_PRODUCER_SHA256],
    ] as const) {
      const bytes = readTrustedRegularFile(path.resolve(cwd, relative), {
        minBytes: 1,
        maxBytes: 1024 * 1024,
      });
      const actual = sha256(bytes);
      bytes.fill(0);
      if (actual !== expected) fail("policy_invalid");
    }
    const rolePolicy = JSON.parse(readTrustedRegularFile(
      path.resolve(cwd, ROLE_LIMIT_POLICY_PATH),
      { minBytes: 1, maxBytes: MAXIMUM_EVIDENCE_BYTES },
    ).toString("utf8")) as JsonRecord;
    const prerequisite = record(rolePolicy.mutationPrerequisites)
      ? rolePolicy.mutationPrerequisites
      : null;
    const sourceAuthority = record(rolePolicy.sourceAuthority)
      ? rolePolicy.sourceAuthority
      : null;
    const fence = record(prerequisite?.workerFence)
      ? prerequisite.workerFence
      : null;
    const deployment = record(prerequisite?.productionDeployment)
      ? prerequisite.productionDeployment
      : null;
    const chronology = record(prerequisite?.chronology)
      ? prerequisite.chronology
      : null;
    const oneTimeApplyHistory = record(chronology?.oneTimeApplyHistory)
      ? chronology.oneTimeApplyHistory
      : null;
    const download = record(prerequisite?.artifactDownloadContract)
      ? prerequisite.artifactDownloadContract
      : null;
    const deploymentPreflight = record(
      prerequisite?.productionDeploymentPreflight,
    )
      ? prerequisite.productionDeploymentPreflight
      : null;
    const verificationEvidence = record(prerequisite?.verificationEvidence)
      ? prerequisite.verificationEvidence
      : null;
    const downstream = record(prerequisite?.downstreamConsumers)
      ? prerequisite.downstreamConsumers
      : null;
    const activationConsumer = record(downstream?.productionActivation)
      ? downstream.productionActivation
      : null;
    const reconciliationConsumer = record(downstream?.roleReconciliation)
      ? downstream.roleReconciliation
      : null;
    const scaleConsumer = record(downstream?.productionScale)
      ? downstream.productionScale
      : null;
    if (
      !prerequisite
      || sourceAuthority?.workflowPath !== ROLE_LIMIT_WORKFLOW
      || sourceAuthority.workflowSha256 !== ROLE_LIMIT_WORKFLOW_SHA256
      || prerequisite.applyOnly !== true
      || prerequisite.githubApiOrigin !== GITHUB_API_ORIGIN
      || prerequisite.maximumReceiptAgeSeconds !== 86_400
      || prerequisite.maximumVerificationAgeSeconds !== 900
      || prerequisite.maximumClockSkewSeconds !== 300
      || prerequisite.requiredRunAttempt !== 1
      || download?.action !== "actions/download-artifact"
      || download.actionCommit !== DOWNLOAD_ARTIFACT_ACTION_COMMIT
      || download.actionVersion !== "v8.0.1"
      || download.downloadActionDigestMismatchBehavior
        !== "WARNING_ONLY_NOT_SECURITY_BOUNDARY"
      || download.independentArchiveSha256VerificationRequired !== true
      || download.githubRedirectAuthorizationStrippedRequired !== true
      || download.uniqueReceiptFilenameRequired !== true
      || download.localReceiptBytesMustMatchUniqueArchiveEntry !== true
      || deploymentPreflight?.workflowPath !== DEPLOYMENT_WORKFLOW
      || deploymentPreflight.workflowName !== DEPLOYMENT_WORKFLOW_NAME
      || deploymentPreflight.githubEnvironment !== "production-deployment"
      || deploymentPreflight.confirmationTemplate
        !== "DEPLOY_PRODUCTION_<candidate-sha>_AFTER_FENCE_RUN_<run-id>"
      || deploymentPreflight.verificationSchema
        !== PRODUCTION_DEPLOYMENT_WORKER_FENCE_PREREQUISITE_SCHEMA
      || deploymentPreflight.verificationFilename
        !== PRODUCTION_DEPLOYMENT_WORKER_FENCE_PREREQUISITE_FILENAME
      || fence?.workflowPath !== FENCE_WORKFLOW
      || fence.workflowId !== FENCE_WORKFLOW_ID
      || fence.workflowSha256 !== FENCE_WORKFLOW_SHA256
      || fence.policySha256 !== FENCE_POLICY_SHA256
      || fence.producerPath !== FENCE_PRODUCER_PATH
      || fence.producerSha256 !== FENCE_PRODUCER_SHA256
      || fence.receiptArchivePath
        !== "automatic-maintenance-worker-fence-terminal.json"
      || fence.requiredTarget !== "production"
      || fence.requiredOperation !== "fence"
      || fence.requiredOutcome !== "fenced"
      || fence.workersEnabledValue !== "false"
      || fence.candidateBindingRequired !== true
      || fence.deploymentMustRemainUnchanged !== true
      || fence.oldRuntimeSafetyPrerequisite
        !== "EXTERNAL_SQLITE_DETACHED_FROM_POSTGRES_PROOF"
      || fence.oldRuntimeSafetyVerifiedByFenceOperation !== false
      || deployment?.workflowPath !== DEPLOYMENT_WORKFLOW
      || deployment.workflowId !== DEPLOYMENT_WORKFLOW_ID
      || deployment.workflowSha256 !== DEPLOYMENT_WORKFLOW_SHA256
      || deployment.policySha256 !== DEPLOYMENT_POLICY_SHA256
      || deployment.producerPath !== DEPLOYMENT_PRODUCER_PATH
      || deployment.producerSha256 !== DEPLOYMENT_PRODUCER_SHA256
      || deployment.receiptArchivePath
        !== "pintpath-production-deployment-evidence/deployment-receipt.json"
      || deployment.requiredTarget !== "production"
      || deployment.runtimeWorkersEnabledRequired !== false
      || deployment.runtimeCandidateBindingRequired !== true
      || deployment.soleHealthyCandidateRequired !== true
      || deployment.requiredReplicaCount !== 1
      || deployment.preFenceOldRuntimeSafetyClosedBySoleHealthyDeployment
        !== true
      || chronology?.workerFenceMustCompleteBeforeDeploymentStarts !== true
      || chronology.deploymentMustCompleteBeforeRoleLimitRunStarts !== true
      || chronology.laterProductionWorkerFenceRunAllowed !== false
      || chronology.laterProductionDeploymentRunAllowed !== false
      || chronology.productionScaleWorkflowPath !== PRODUCTION_SCALE_WORKFLOW
      || chronology.productionScaleWorkflowId !== PRODUCTION_SCALE_WORKFLOW_ID
      || chronology.laterProductionScaleRunAllowed !== false
      || chronology.priorRoleLimitApplyRunAllowed !== false
      || oneTimeApplyHistory?.createdAtLowerBound
        !== ROLE_LIMIT_HISTORY_CREATED_AT_LOWER_BOUND
      || oneTimeApplyHistory.authorityExpiresAt
        !== ROLE_LIMIT_HISTORY_AUTHORITY_EXPIRES_AT
      || oneTimeApplyHistory.historyWindowCoversWorkflowLifetime !== true
      || oneTimeApplyHistory.pageSize !== ROLE_LIMIT_HISTORY_PAGE_SIZE
      || oneTimeApplyHistory.maximumRuns !== ROLE_LIMIT_HISTORY_MAXIMUM_RUNS
      || oneTimeApplyHistory.completePaginationRequired !== true
      || oneTimeApplyHistory.contiguousRunNumbersFromOneRequired !== true
      || oneTimeApplyHistory.missingOrDeletedRunAction !== "BLOCK"
      || oneTimeApplyHistory.anyPriorApplyStatusBlocks !== true
      || oneTimeApplyHistory.onlyCurrentApplyRunAllowed !== true
      || oneTimeApplyHistory.incompleteHistoryAction !== "BLOCK"
      || verificationEvidence?.downloadActionPinRequired !== true
      || verificationEvidence.independentArchiveDigestAndLocalBytesRequired
        !== true
      || reconciliationConsumer?.workflowPath !== ROLE_LIMIT_WORKFLOW
      || reconciliationConsumer.githubEnvironment
        !== ROLE_LIMIT_GITHUB_ENVIRONMENT
      || reconciliationConsumer.priorIntentArchivePath !== "intent.json"
      || reconciliationConsumer.priorPrerequisitesArchivePath
        !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_FILENAME
      || reconciliationConsumer.verificationSchema
        !== PRODUCTION_ROLE_LIMIT_RECONCILIATION_AUTHORITY_SCHEMA
      || reconciliationConsumer.verificationFilename
        !== PRODUCTION_ROLE_LIMIT_RECONCILIATION_AUTHORITY_FILENAME
      || reconciliationConsumer.newMutationPrerequisitesRequired !== false
      || activationConsumer?.workflowPath !== FENCE_WORKFLOW
      || activationConsumer.workflowName !== FENCE_WORKFLOW_NAME
      || activationConsumer.githubEnvironment
        !== "production-runtime-configuration"
      || activationConsumer.requiredTarget !== "production"
      || activationConsumer.requiredOperation !== "activate"
      || activationConsumer.roleIntentArchivePath !== "intent.json"
      || activationConsumer.roleTerminalArchivePath !== "terminal.json"
      || activationConsumer.roleReceiptArchivePath !== "receipt.json"
      || activationConsumer.rolePrerequisitesArchivePath
        !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_FILENAME
      || activationConsumer.verificationSchema
        !== PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_SCHEMA
      || activationConsumer.verificationFilename
        !== PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_FILENAME
      || scaleConsumer?.workflowPath !== PRODUCTION_SCALE_WORKFLOW
      || scaleConsumer.workflowSha256 !== PRODUCTION_SCALE_WORKFLOW_SHA256
      || scaleConsumer.workflowName !== PRODUCTION_SCALE_WORKFLOW_NAME
      || scaleConsumer.policyPath !== PRODUCTION_SCALE_POLICY_PATH
      || scaleConsumer.policySha256 !== PRODUCTION_SCALE_POLICY_SHA256
      || scaleConsumer.producerPath !== PRODUCTION_SCALE_PRODUCER_PATH
      || scaleConsumer.producerSha256 !== PRODUCTION_SCALE_PRODUCER_SHA256
      || scaleConsumer.githubEnvironment
        !== "production-topology-configuration"
      || scaleConsumer.confirmation !== "CONVERGE_PRODUCTION_TO_TWO_REPLICAS"
      || scaleConsumer.activationTerminalArchivePath
        !== "automatic-maintenance-worker-fence-terminal.json"
      || scaleConsumer.activationPrerequisitesArchivePath
        !== PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_FILENAME
      || scaleConsumer.verificationSchema
        !== PRODUCTION_SCALE_ACTIVATION_PREREQUISITE_SCHEMA
      || scaleConsumer.verificationFilename
        !== PRODUCTION_SCALE_ACTIVATION_PREREQUISITE_FILENAME
    ) fail("policy_invalid");
    const deploymentPolicy = JSON.parse(readTrustedRegularFile(
      path.resolve(cwd, DEPLOYMENT_POLICY_PATH),
      { minBytes: 1, maxBytes: MAXIMUM_EVIDENCE_BYTES },
    ).toString("utf8")) as JsonRecord;
    const postflight = record(deploymentPolicy.postflightContract)
      ? deploymentPolicy.postflightContract
      : null;
    const deploymentFencePrerequisite = record(
      deploymentPolicy.workerFencePrerequisiteContract,
    )
      ? deploymentPolicy.workerFencePrerequisiteContract
      : null;
    if (
      deploymentPolicy.policyId !== "pintpath-production-app-source-upload"
      || deploymentPolicy.activationState !== "GITHUB_ENVIRONMENT_PROTECTED"
      || postflight?.runtimeProbeRequired !== true
      || postflight?.automaticMaintenanceEnabled !== false
      || postflight.automaticMaintenanceCandidateBindingRequired !== true
      || deploymentFencePrerequisite?.required !== true
      || deploymentFencePrerequisite.verificationSchema
        !== PRODUCTION_DEPLOYMENT_WORKER_FENCE_PREREQUISITE_SCHEMA
      || deploymentFencePrerequisite.verificationFilename
        !== PRODUCTION_DEPLOYMENT_WORKER_FENCE_PREREQUISITE_FILENAME
      || deploymentFencePrerequisite.exactFenceRunBindingRequired !== true
      || deploymentFencePrerequisite.liveDeploymentContinuityRequired !== true
      || deploymentFencePrerequisite.durableIntentBindingRequired !== true
      || deploymentFencePrerequisite.terminalReceiptBindingRequired !== true
    ) fail("policy_invalid");
  } catch (error) {
    if (error instanceof PrerequisiteError) throw error;
    fail("policy_invalid");
  }
}

function validateEnvironment(
  args: Arguments,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const currentRunId = env.GITHUB_RUN_ID ?? "";
  const workflow = args.mode === "role-limit"
      || args.mode === "role-limit-reconcile"
    ? ROLE_LIMIT_WORKFLOW
    : args.mode === "production-deploy"
      ? DEPLOYMENT_WORKFLOW
      : args.mode === "production-activate"
        ? FENCE_WORKFLOW
        : PRODUCTION_SCALE_WORKFLOW;
  const consumerExact = args.mode === "role-limit"
    ? env.PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_GITHUB_ENVIRONMENT
        === ROLE_LIMIT_GITHUB_ENVIRONMENT
      && env.PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_MODE === "apply"
      && env.PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_CONFIRMATION
        === "ALTER_PRIVACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT_2_TO_8"
    : args.mode === "role-limit-reconcile"
      ? env.PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_GITHUB_ENVIRONMENT
          === ROLE_LIMIT_GITHUB_ENVIRONMENT
        && env.PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_MODE === "reconcile"
        && env.PINTPATH_PRODUCTION_MAINTENANCE_ROLE_LIMIT_CONFIRMATION
          === "RECONCILE_PRIVACY_MAINTENANCE_LOGIN_CONNECTION_LIMIT_8"
        && env.PINTPATH_PRODUCTION_RECONCILE_PRIOR_ROLE_RUN_ID
          === args.priorRoleRunId
    : args.mode === "production-deploy"
      ? env.PINTPATH_PRODUCTION_DEPLOYMENT_GITHUB_ENVIRONMENT
        === "production-deployment"
      && env.PINTPATH_PRODUCTION_DEPLOYMENT_FENCE_CONFIRMATION
        === `DEPLOY_PRODUCTION_${args.candidateSha}_AFTER_FENCE_RUN_${args.fenceRunId}`
      : args.mode === "production-activate"
        ? env.PINTPATH_PROTECTED_ENVIRONMENT
            === "production-runtime-configuration"
          && env.PINTPATH_AUTOMATIC_MAINTENANCE_CONFIRMATION
            === `ACTIVATE_AUTOMATIC_MAINTENANCE_IN_PRODUCTION_FOR_${args.candidateSha}`
          && env.PINTPATH_PRODUCTION_ACTIVATE_ROLE_LIMIT_RUN_ID
            === args.roleLimitRunId
        : env.PINTPATH_PRODUCTION_SCALE_GITHUB_ENVIRONMENT
            === "production-topology-configuration"
          && env.PINTPATH_SCALE_CONFIRMATION
            === "CONVERGE_PRODUCTION_TO_TWO_REPLICAS"
          && env.PINTPATH_PRODUCTION_SCALE_ACTIVATE_RUN_ID
            === args.activateRunId;
  if (
    env.GITHUB_ACTIONS !== "true"
    || env.GITHUB_REPOSITORY !== REPOSITORY
    || env.GITHUB_REF !== "refs/heads/main"
    || env.GITHUB_SHA !== args.candidateSha
    || env.GITHUB_RUN_ATTEMPT !== "1"
    || !RUN_ID_PATTERN.test(currentRunId)
    || currentRunId === args.fenceRunId
    || (args.deploymentRunId !== null
      && currentRunId === args.deploymentRunId)
    || (args.roleLimitRunId !== null && currentRunId === args.roleLimitRunId)
    || (args.activateRunId !== null && currentRunId === args.activateRunId)
    || (args.priorRoleRunId !== null && currentRunId === args.priorRoleRunId)
    || env.GITHUB_WORKFLOW_REF?.split("@")[0]
      !== `${REPOSITORY}/${workflow}`
    || env.GITHUB_API_URL !== GITHUB_API_ORIGIN
    || !consumerExact
    || typeof env.GITHUB_TOKEN !== "string"
    || env.GITHUB_TOKEN.length < 16
    || /[\r\n\0]/.test(env.GITHUB_TOKEN)
  ) fail("environment_invalid");
  return currentRunId;
}

async function githubJson(
  dependencies: Dependencies,
  url: string,
): Promise<unknown> {
  let bounded;
  try {
    bounded = await fetchBoundedResponseText(
      dependencies.fetchImpl,
      url,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${dependencies.env.GITHUB_TOKEN}`,
          "user-agent": "pintpath-production-maintenance-role-limit-prerequisites/1",
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        cache: "no-store",
      },
      {
        maximumBytes: MAXIMUM_GITHUB_RESPONSE_BYTES,
        signal: AbortSignal.timeout(dependencies.requestTimeoutMs),
      },
    );
  } catch {
    fail("github_api_failed");
  }
  if (!bounded.response.ok) fail("github_api_failed");
  try {
    return JSON.parse(bounded.source) as unknown;
  } catch {
    fail("github_api_invalid");
  }
}

async function completeRoleLimitWorkflowHistory(
  dependencies: Dependencies,
  base: string,
  now: Date,
): Promise<readonly JsonRecord[]> {
  const nowMs = now.getTime();
  const lowerBoundMs = Date.parse(ROLE_LIMIT_HISTORY_CREATED_AT_LOWER_BOUND);
  const authorityExpiresAtMs = Date.parse(
    ROLE_LIMIT_HISTORY_AUTHORITY_EXPIRES_AT,
  );
  if (
    !Number.isFinite(nowMs)
    || nowMs < lowerBoundMs
    || nowMs > authorityExpiresAtMs
  ) fail("chronology_invalid");

  const window = `${ROLE_LIMIT_HISTORY_CREATED_AT_LOWER_BOUND}..${now.toISOString()}`;
  const runs: JsonRecord[] = [];
  const runIds = new Set<string>();
  const runNumbers = new Set<number>();
  let expectedTotalCount: number | null = null;
  let page = 1;
  do {
    const value = await githubJson(
      dependencies,
      `${base}/actions/workflows/${ROLE_LIMIT_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=${ROLE_LIMIT_HISTORY_PAGE_SIZE}&page=${page}`,
    );
    const listing = record(value) ? value : null;
    const pageRuns = Array.isArray(listing?.workflow_runs)
      && listing.workflow_runs.every(record)
      ? listing.workflow_runs
      : null;
    const totalCount = listing?.total_count;
    if (
      !pageRuns
      || !Number.isSafeInteger(totalCount)
      || Number(totalCount) < 1
      || Number(totalCount) > ROLE_LIMIT_HISTORY_MAXIMUM_RUNS
      || (expectedTotalCount !== null && totalCount !== expectedTotalCount)
    ) fail("later_run_detected");
    expectedTotalCount ??= Number(totalCount);
    const pageOffset = (page - 1) * ROLE_LIMIT_HISTORY_PAGE_SIZE;
    const expectedPageLength = Math.min(
      ROLE_LIMIT_HISTORY_PAGE_SIZE,
      expectedTotalCount - pageOffset,
    );
    if (expectedPageLength < 1 || pageRuns.length !== expectedPageLength) {
      fail("later_run_detected");
    }
    for (const run of pageRuns) {
      const runId = String(run.id);
      const runNumber = run.run_number;
      if (
        !RUN_ID_PATTERN.test(runId)
        || runIds.has(runId)
        || !Number.isSafeInteger(runNumber)
        || Number(runNumber) < 1
        || Number(runNumber) > ROLE_LIMIT_HISTORY_MAXIMUM_RUNS
        || runNumbers.has(Number(runNumber))
      ) {
        fail("later_run_detected");
      }
      runIds.add(runId);
      runNumbers.add(Number(runNumber));
      runs.push(run);
    }
    page += 1;
  } while (
    expectedTotalCount !== null
    && runs.length < expectedTotalCount
  );
  if (expectedTotalCount === null || runs.length !== expectedTotalCount) {
    fail("later_run_detected");
  }
  for (let runNumber = 1; runNumber <= expectedTotalCount; runNumber += 1) {
    if (!runNumbers.has(runNumber)) fail("later_run_detected");
  }
  return runs;
}

function validateOneTimeRoleLimitApplyHistory(
  runs: readonly JsonRecord[],
  currentRunId: string,
  candidateSha: string,
  now: Date,
): void {
  const exactTitle = new RegExp(
    "^Production maintenance LOGIN limit \\| (apply|reconcile) \\| ([a-f0-9]{40})$",
  );
  let currentCount = 0;
  for (const run of runs) {
    const repository = record(run.repository) ? run.repository : null;
    const headRepository = record(run.head_repository)
      ? run.head_repository
      : null;
    const title = typeof run.display_title === "string"
      ? exactTitle.exec(run.display_title)
      : null;
    const id = String(run.id);
    const created = timestamp(run.created_at, "later_run_detected");
    if (
      !title
      || repository?.full_name !== REPOSITORY
      || headRepository?.full_name !== REPOSITORY
      || run.name !== ROLE_LIMIT_WORKFLOW_NAME
      || !workflowPathExact(run.path, ROLE_LIMIT_WORKFLOW)
      || run.event !== "workflow_dispatch"
      || run.head_branch !== "main"
      || run.run_attempt !== 1
      || created.milliseconds < Date.parse(
        ROLE_LIMIT_HISTORY_CREATED_AT_LOWER_BOUND,
      )
      || created.milliseconds > now.getTime() + MAXIMUM_CLOCK_SKEW_MS
    ) fail("later_run_detected");
    if (title[1] === "apply" && id !== currentRunId) {
      fail("later_run_detected");
    }
    if (id === currentRunId) {
      currentCount += 1;
      if (
        title[1] !== "apply"
        || title[2] !== candidateSha
        || run.head_sha !== candidateSha
        || run.status !== "in_progress"
        || run.conclusion !== null
      ) fail("later_run_detected");
    }
  }
  if (currentCount !== 1) fail("later_run_detected");
}

function workflowPathExact(actual: unknown, expected: string): boolean {
  return actual === expected || actual === `${expected}@main`;
}

function validateRun(
  value: unknown,
  input: {
    readonly runId: string;
    readonly candidateSha: string;
    readonly workflowPath: string;
    readonly workflowName: string;
    readonly status: "completed" | "in_progress";
    readonly conclusion:
      | "success"
      | "failure"
      | "cancelled"
      | "timed_out"
      | null;
    readonly displayTitle?: string;
  },
): GithubRun {
  const run = record(value) ? value : null;
  const repository = record(run?.repository) ? run.repository : null;
  const headRepository = record(run?.head_repository)
    ? run.head_repository
    : null;
  if (
    !run
    || String(run.id) !== input.runId
    || repository?.full_name !== REPOSITORY
    || headRepository?.full_name !== REPOSITORY
    || run.name !== input.workflowName
    || !workflowPathExact(run.path, input.workflowPath)
    || run.event !== "workflow_dispatch"
    || run.head_sha !== input.candidateSha
    || run.head_branch !== "main"
    || run.run_attempt !== 1
    || run.status !== input.status
    || run.conclusion !== input.conclusion
    || (input.displayTitle !== undefined
      && run.display_title !== input.displayTitle)
  ) fail("run_authority_invalid");
  const started = timestamp(run.run_started_at, "run_authority_invalid");
  const created = timestamp(run.created_at, "run_authority_invalid");
  const completed = timestamp(
    input.status === "completed" ? run.updated_at : run.run_started_at,
    "run_authority_invalid",
  );
  if (
    created.milliseconds > started.milliseconds
    || (input.status === "completed"
      && completed.milliseconds <= started.milliseconds)
  ) fail("run_authority_invalid");
  return {
    id: input.runId,
    workflowPath: input.workflowPath,
    startedAt: started.canonical,
    startedAtMs: started.milliseconds,
    createdAt: created.canonical,
    createdAtMs: created.milliseconds,
    completedAt: completed.canonical,
    completedAtMs: completed.milliseconds,
  };
}

function validatePriorRoleApplyRun(
  value: unknown,
  runId: string,
  candidateSha: string,
): GithubRun & {
  readonly conclusion: "success" | "failure" | "cancelled" | "timed_out";
} {
  const run = record(value) ? value : null;
  const conclusion = run?.conclusion;
  if (
    conclusion !== "success"
    && conclusion !== "failure"
    && conclusion !== "cancelled"
    && conclusion !== "timed_out"
  ) fail("run_authority_invalid");
  const validated = validateRun(value, {
    runId,
    candidateSha,
    workflowPath: ROLE_LIMIT_WORKFLOW,
    workflowName: ROLE_LIMIT_WORKFLOW_NAME,
    status: "completed",
    conclusion,
    displayTitle: `Production maintenance LOGIN limit | apply | ${candidateSha}`,
  });
  return { ...validated, conclusion };
}

function validateArtifact(
  value: unknown,
  runId: string,
  candidateSha: string,
  expectedName: string,
): GithubArtifact {
  const listing = record(value) ? value : null;
  const artifacts = Array.isArray(listing?.artifacts)
    ? listing.artifacts
    : [];
  if (listing?.total_count !== 1 || artifacts.length !== 1) {
    fail("artifact_authority_invalid");
  }
  const artifact = record(artifacts[0]) ? artifacts[0] : null;
  const workflowRun = record(artifact?.workflow_run)
    ? artifact.workflow_run
    : null;
  if (
    !artifact
    || artifact.name !== expectedName
    || artifact.expired !== false
    || !RUN_ID_PATTERN.test(String(artifact.id))
    || !ARTIFACT_DIGEST_PATTERN.test(String(artifact.digest))
    || !Number.isSafeInteger(artifact.size_in_bytes)
    || Number(artifact.size_in_bytes) < 1
    || Number(artifact.size_in_bytes) > MAXIMUM_ARTIFACT_BYTES
    || artifact.archive_download_url
      !== `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`
    || workflowRun === null
    || String(workflowRun.id) !== runId
    || workflowRun.head_sha !== candidateSha
  ) fail("artifact_authority_invalid");
  return {
    id: String(artifact.id),
    name: expectedName,
    digest: String(artifact.digest),
    sizeBytes: Number(artifact.size_in_bytes),
    archiveDownloadUrl: String(artifact.archive_download_url),
  };
}

async function boundedResponseBytes(response: Response): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null
    && (!/^[0-9]+$/.test(contentLength)
      || Number(contentLength) < 1
      || Number(contentLength) > MAXIMUM_ARTIFACT_BYTES)
  ) fail("artifact_authority_invalid");
  if (!response.body) fail("artifact_authority_invalid");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAXIMUM_ARTIFACT_BYTES) {
        fail("artifact_authority_invalid");
      }
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    if (error instanceof PrerequisiteError) throw error;
    fail("artifact_authority_invalid");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (total < 1) fail("artifact_authority_invalid");
  return Buffer.concat(chunks, total);
}

async function downloadArtifactArchive(
  dependencies: Dependencies,
  artifact: GithubArtifact,
): Promise<Buffer> {
  let authority: Response;
  try {
    authority = await dependencies.fetchImpl(artifact.archiveDownloadUrl, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${dependencies.env.GITHUB_TOKEN}`,
        "user-agent":
          "pintpath-production-maintenance-role-limit-prerequisites/1",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(dependencies.requestTimeoutMs),
    });
  } catch {
    fail("artifact_authority_invalid");
  }
  const location = authority.headers.get("location");
  if (authority.status !== 302 || !location) {
    fail("artifact_authority_invalid");
  }
  let signedUrl: URL;
  try {
    signedUrl = new URL(location);
  } catch {
    fail("artifact_authority_invalid");
  }
  if (
    signedUrl.protocol !== "https:"
    || signedUrl.username !== ""
    || signedUrl.password !== ""
    || signedUrl.hostname === ""
  ) fail("artifact_authority_invalid");
  let archiveResponse: Response;
  try {
    archiveResponse = await dependencies.fetchImpl(signedUrl, {
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(dependencies.requestTimeoutMs),
    });
  } catch {
    fail("artifact_authority_invalid");
  }
  if (!archiveResponse.ok) fail("artifact_authority_invalid");
  const archive = await boundedResponseBytes(archiveResponse);
  if (`sha256:${sha256(archive)}` !== artifact.digest) {
    archive.fill(0);
    fail("artifact_authority_invalid");
  }
  return archive;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function exactSafeZipName(name: string): boolean {
  return name.length > 0
    && !name.includes("\0")
    && !name.includes("\\")
    && !name.startsWith("/")
    && !/^[A-Za-z]:/.test(name)
    && name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function extractUniqueArchiveEntry(
  archive: Buffer,
  expectedName: string,
): Buffer {
  const minimumEocdOffset = Math.max(0, archive.length - 65_557);
  let eocd = -1;
  for (let offset = archive.length - 22; offset >= minimumEocdOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x0605_4b50) {
      const commentLength = archive.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === archive.length) {
        eocd = offset;
        break;
      }
    }
  }
  if (eocd < 0) fail("artifact_authority_invalid");
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const diskEntries = archive.readUInt16LE(eocd + 8);
  const totalEntries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (
    disk !== 0
    || centralDisk !== 0
    || diskEntries !== totalEntries
    || totalEntries < 1
    || totalEntries === 0xffff
    || centralSize === 0xffff_ffff
    || centralOffset === 0xffff_ffff
    || centralOffset + centralSize !== eocd
  ) fail("artifact_authority_invalid");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = centralOffset;
  let match: {
    flags: number;
    method: number;
    crc: number;
    compressedSize: number;
    uncompressedSize: number;
    localOffset: number;
    name: string;
  } | null = null;
  try {
    for (let entry = 0; entry < totalEntries; entry += 1) {
      if (offset + 46 > eocd || archive.readUInt32LE(offset) !== 0x0201_4b50) {
        fail("artifact_authority_invalid");
      }
      const flags = archive.readUInt16LE(offset + 8);
      const method = archive.readUInt16LE(offset + 10);
      const crc = archive.readUInt32LE(offset + 16);
      const compressedSize = archive.readUInt32LE(offset + 20);
      const uncompressedSize = archive.readUInt32LE(offset + 24);
      const nameLength = archive.readUInt16LE(offset + 28);
      const extraLength = archive.readUInt16LE(offset + 30);
      const commentLength = archive.readUInt16LE(offset + 32);
      const diskStart = archive.readUInt16LE(offset + 34);
      const externalAttributes = archive.readUInt32LE(offset + 38);
      const localOffset = archive.readUInt32LE(offset + 42);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (
        next > eocd
        || nameLength < 1
        || diskStart !== 0
        || (flags & 1) !== 0
        || (method !== 0 && method !== 8)
        || compressedSize === 0xffff_ffff
        || uncompressedSize === 0xffff_ffff
        || uncompressedSize > MAXIMUM_EVIDENCE_BYTES
      ) fail("artifact_authority_invalid");
      const name = decoder.decode(archive.subarray(
        offset + 46,
        offset + 46 + nameLength,
      ));
      const unixMode = externalAttributes >>> 16;
      if (
        !exactSafeZipName(name)
        || (unixMode & 0o170000) === 0o120000
      ) fail("artifact_authority_invalid");
      if (name === expectedName) {
        if (match !== null) fail("artifact_authority_invalid");
        match = {
          flags,
          method,
          crc,
          compressedSize,
          uncompressedSize,
          localOffset,
          name,
        };
      }
      offset = next;
    }
  } catch (error) {
    if (error instanceof PrerequisiteError) throw error;
    fail("artifact_authority_invalid");
  }
  if (offset !== eocd || match === null) fail("artifact_authority_invalid");
  const local = match.localOffset;
  if (
    local + 30 > centralOffset
    || archive.readUInt32LE(local) !== 0x0403_4b50
    || archive.readUInt16LE(local + 6) !== match.flags
    || archive.readUInt16LE(local + 8) !== match.method
  ) fail("artifact_authority_invalid");
  const localNameLength = archive.readUInt16LE(local + 26);
  const localExtraLength = archive.readUInt16LE(local + 28);
  const dataOffset = local + 30 + localNameLength + localExtraLength;
  if (dataOffset + match.compressedSize > centralOffset) {
    fail("artifact_authority_invalid");
  }
  let localName: string;
  try {
    localName = decoder.decode(archive.subarray(local + 30, local + 30 + localNameLength));
  } catch {
    fail("artifact_authority_invalid");
  }
  if (localName !== match.name) fail("artifact_authority_invalid");
  const compressed = archive.subarray(
    dataOffset,
    dataOffset + match.compressedSize,
  );
  let extracted: Buffer;
  try {
    extracted = match.method === 0
      ? Buffer.from(compressed)
      : zlib.inflateRawSync(compressed, {
          maxOutputLength: MAXIMUM_EVIDENCE_BYTES,
        });
  } catch {
    fail("artifact_authority_invalid");
  }
  if (
    extracted.length !== match.uncompressedSize
    || crc32(extracted) !== match.crc
  ) {
    extracted.fill(0);
    fail("artifact_authority_invalid");
  }
  return extracted;
}

async function validateLocalReceiptAgainstArtifactArchive(
  dependencies: Dependencies,
  artifact: GithubArtifact,
  expectedName: string,
  localSource: string,
): Promise<void> {
  const archive = await downloadArtifactArchive(dependencies, artifact);
  let extracted: Buffer | null = null;
  try {
    extracted = extractUniqueArchiveEntry(archive, expectedName);
    const local = Buffer.from(localSource, "utf8");
    try {
      if (
        local.length !== extracted.length
        || !crypto.timingSafeEqual(local, extracted)
      ) fail("artifact_authority_invalid");
    } finally {
      local.fill(0);
    }
  } finally {
    extracted?.fill(0);
    archive.fill(0);
  }
}

async function validateLocalFilesAgainstArtifactArchive(
  dependencies: Dependencies,
  artifact: GithubArtifact,
  files: readonly { readonly archivePath: string; readonly source: string }[],
): Promise<void> {
  const archive = await downloadArtifactArchive(dependencies, artifact);
  try {
    for (const file of files) {
      const extracted = extractUniqueArchiveEntry(archive, file.archivePath);
      try {
        const local = Buffer.from(file.source, "utf8");
        try {
          if (
            local.length !== extracted.length
            || !crypto.timingSafeEqual(local, extracted)
          ) fail("artifact_authority_invalid");
        } finally {
          local.fill(0);
        }
      } finally {
        extracted.fill(0);
      }
    }
  } finally {
    archive.fill(0);
  }
}

function exactTrueChecks(value: unknown, keys: readonly string[]): boolean {
  return exactKeys(value, keys) && keys.every((key) => value[key] === true);
}

const FENCE_CHECK_KEYS = [
  "policyExact",
  "githubAuthorityExact",
  "tokenScopesExact",
  "boundaryPreflightExact",
  "targetPreflightExact",
  "operationPreflightExact",
  "durableIntentExact",
  "writeAttemptedAtMostOnce",
  "atomicVariablesExact",
  "acknowledgementExact",
  "postflightAttempted",
  "targetPostflightExact",
  "postflightDeploymentExact",
  "runtimeRoutesPolledExact",
  "runtimeMaintenanceStateExact",
  "boundaryPostflightExact",
  "noOtherProviderChanges",
  "terminalEvidenceExact",
] as const;

function validateWorkerTerminal(
  source: string,
  value: JsonRecord,
  candidateSha: string,
  expectedOperation: "fence" | "activate",
): {
  readonly terminalSha256: string;
  readonly bindingSha256: string;
  readonly intentSha256: string;
  readonly deploymentBeforeIdSha256: string;
  readonly deploymentAfterIdSha256: string;
  readonly runtimeDeploymentIdSha256: string | null;
} {
  if (!exactKeys(value, [
    "schemaVersion",
    "executorState",
    "binding",
    "bindingSha256",
    "outcome",
    "attempts",
    "retryAllowed",
    "failureCode",
    "authoritySha256",
    "intentSha256",
    "providerEvidence",
    "runtimeEvidence",
    "mutationBoundaryEvidence",
    "checks",
    "stagingBootstrapVerification",
    "productionDeploymentVerification",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ])) fail("fence_receipt_invalid");
  const binding = record(value.binding) ? value.binding : null;
  const variables = record(binding?.configuredVariables)
    ? binding.configuredVariables
    : null;
  const provider = record(value.providerEvidence)
    ? value.providerEvidence
    : null;
  const runtime = record(value.runtimeEvidence) ? value.runtimeEvidence : null;
  const responses = record(runtime?.responseSha256s)
    ? runtime.responseSha256s
    : null;
  const boundary = record(value.mutationBoundaryEvidence)
    ? value.mutationBoundaryEvidence
    : null;
  const consumer = record(value.productionDeploymentVerification)
    ? value.productionDeploymentVerification
    : null;
  const staging = record(value.stagingBootstrapVerification)
    ? value.stagingBootstrapVerification
    : null;
  const bindingSource = binding ? canonical(binding) : "";
  if (
    value.schemaVersion !== FENCE_TERMINAL_SCHEMA
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || !binding
    || !exactKeys(binding, [
      "policySha256",
      "candidateSha",
      "target",
      "operation",
      "projectId",
      "environmentId",
      "serviceId",
      "configuredVariables",
      "skipDeploys",
    ])
    || binding.policySha256 !== FENCE_POLICY_SHA256
    || binding.candidateSha !== candidateSha
    || binding.target !== "production"
    || binding.operation !== expectedOperation
    || binding.projectId !== PROJECT_ID
    || binding.environmentId !== PRODUCTION_ENVIRONMENT_ID
    || binding.serviceId !== SERVICE_ID
    || !exactKeys(variables, [
      "PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED",
      "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
    ])
    || variables.PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED
      !== (expectedOperation === "fence" ? "false" : "true")
    || variables.PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA !== candidateSha
    || binding.skipDeploys !== (expectedOperation === "fence")
    || value.bindingSha256 !== sha256(bindingSource)
    || value.outcome !== (expectedOperation === "fence" ? "fenced" : "activated")
    || value.attempts !== 1
    || value.retryAllowed !== false
    || value.failureCode !== null
    || !SHA256_PATTERN.test(String(value.authoritySha256))
    || !SHA256_PATTERN.test(String(value.intentSha256))
    || !exactKeys(provider, [
      "graphqlOperation",
      "mutationCallCount",
      "acknowledgementExact",
      "providerBeforeSha256",
      "providerAfterSha256",
      "deploymentBeforeIdSha256",
      "deploymentAfterIdSha256",
      "sourceBeforeSha",
      "sourceAfterSha",
      "sourcePreservedExact",
      "deploymentIdChanged",
      "topologyBeforeSha256",
      "topologyAfterSha256",
      "collateralVariablesBeforeSha256",
      "collateralVariablesAfterSha256",
    ])
    || provider.graphqlOperation !== "variableCollectionUpsert"
    || provider.mutationCallCount !== 1
    || provider.acknowledgementExact !== true
    || !SHA256_PATTERN.test(String(provider.providerBeforeSha256))
    || !SHA256_PATTERN.test(String(provider.providerAfterSha256))
    || !SHA256_PATTERN.test(String(provider.deploymentBeforeIdSha256))
    || (expectedOperation === "fence"
      ? provider.deploymentAfterIdSha256
        !== provider.deploymentBeforeIdSha256
      : provider.deploymentAfterIdSha256
        === provider.deploymentBeforeIdSha256)
    || !SHA_PATTERN.test(String(provider.sourceBeforeSha))
    || (expectedOperation === "activate"
      && provider.sourceBeforeSha !== candidateSha)
    || provider.sourceAfterSha !== provider.sourceBeforeSha
    || provider.sourcePreservedExact !== true
    || provider.deploymentIdChanged !== (expectedOperation === "activate")
    || !SHA256_PATTERN.test(String(provider.topologyBeforeSha256))
    || provider.topologyAfterSha256 !== provider.topologyBeforeSha256
    || !SHA256_PATTERN.test(String(provider.collateralVariablesBeforeSha256))
    || provider.collateralVariablesAfterSha256
      !== provider.collateralVariablesBeforeSha256
    || !exactKeys(runtime, [
      "required",
      "observed",
      "pollRounds",
      "expectedSourceSha",
      "expectedAutomaticMaintenance",
      "deploymentIdSha256",
      "responseSha256s",
    ])
    || runtime.required !== (expectedOperation === "activate")
    || runtime.observed !== (expectedOperation === "activate")
    || (expectedOperation === "fence"
      ? runtime.pollRounds !== 0
      : !Number.isSafeInteger(runtime.pollRounds)
        || Number(runtime.pollRounds) < 1
        || Number(runtime.pollRounds) > 91)
    || runtime.expectedSourceSha
      !== (expectedOperation === "fence" ? null : candidateSha)
    || (expectedOperation === "fence"
      ? runtime.expectedAutomaticMaintenance !== null
      : !exactKeys(runtime.expectedAutomaticMaintenance, [
          "enabled",
          "candidateBound",
        ])
        || runtime.expectedAutomaticMaintenance.enabled !== true
        || runtime.expectedAutomaticMaintenance.candidateBound !== true)
    || (expectedOperation === "fence"
      ? runtime.deploymentIdSha256 !== null
      : !SHA256_PATTERN.test(String(runtime.deploymentIdSha256))
        || runtime.deploymentIdSha256 !== provider.deploymentAfterIdSha256)
    || !exactKeys(responses, ["/health", "/startup", "/ready"])
    || (expectedOperation === "fence"
      ? responses["/health"] !== null
        || responses["/startup"] !== null
        || responses["/ready"] !== null
      : !SHA256_PATTERN.test(String(responses["/health"]))
        || !SHA256_PATTERN.test(String(responses["/startup"]))
        || !SHA256_PATTERN.test(String(responses["/ready"])))
    || !exactKeys(boundary, [
      "preflightReceiptSha256",
      "postflightReceiptSha256",
    ])
    || !SHA256_PATTERN.test(String(boundary.preflightReceiptSha256))
    || !SHA256_PATTERN.test(String(boundary.postflightReceiptSha256))
    || !exactTrueChecks(value.checks, FENCE_CHECK_KEYS)
    || !exactKeys(staging, [
      "preparedReceiptExact",
      "sufficientWithoutQuiescenceProof",
      "nextRequiredProof",
      "legacySourceRuntimeFenceClaimed",
    ])
    || staging.preparedReceiptExact !== false
    || staging.sufficientWithoutQuiescenceProof !== false
    || staging.nextRequiredProof !== "EXACT_SCALE_1_TO_0_QUIESCENCE_PROOF"
    || staging.legacySourceRuntimeFenceClaimed !== false
    || !exactKeys(consumer, [
      "requiredReceiptFilename",
      "eligible",
      "exactCandidateTargetOperationBindingRequired",
      "bindingSha256Required",
      "oldRuntimeSafetyPrerequisite",
      "oldRuntimeSafetyVerifiedByThisOperation",
    ])
    || consumer.requiredReceiptFilename
      !== "automatic-maintenance-worker-fence-terminal.json"
    || consumer.eligible !== (expectedOperation === "fence")
    || consumer.exactCandidateTargetOperationBindingRequired !== true
    || consumer.bindingSha256Required !== true
    || consumer.oldRuntimeSafetyPrerequisite
      !== (expectedOperation === "fence"
        ? "EXTERNAL_SQLITE_DETACHED_FROM_POSTGRES_PROOF"
        : null)
    || consumer.oldRuntimeSafetyVerifiedByThisOperation !== false
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
  ) fail("fence_receipt_invalid");
  return {
    terminalSha256: sha256(source),
    bindingSha256: String(value.bindingSha256),
    intentSha256: String(value.intentSha256),
    deploymentBeforeIdSha256: String(provider.deploymentBeforeIdSha256),
    deploymentAfterIdSha256: String(provider.deploymentAfterIdSha256),
    runtimeDeploymentIdSha256: runtime.deploymentIdSha256 === null
      ? null
      : String(runtime.deploymentIdSha256),
  };
}

function validateFenceTerminal(
  source: string,
  value: JsonRecord,
  candidateSha: string,
) {
  return validateWorkerTerminal(source, value, candidateSha, "fence");
}

function validateActivateTerminal(
  source: string,
  value: JsonRecord,
  candidateSha: string,
) {
  return validateWorkerTerminal(source, value, candidateSha, "activate");
}

const DEPLOYMENT_CHECK_KEYS = [
  "policyExact",
  "githubMainExact",
  "sourceAuthorityExact",
  "cliExact",
  "writeTokenScopeExact",
  "costPolicyExact",
  "prerequisiteExact",
  "workerFencePrerequisiteExact",
  "workerFenceDeploymentContinuityExact",
  "boundaryPreflightExact",
  "targetPreflightExact",
  "gitAutodeployAbsent",
  "collateralInventoryExact",
  "durableIntentExact",
  "sourceReasserted",
  "writeAttemptedAtMostOnce",
  "targetPostflightAttempted",
  "targetPostflightExact",
  "reconciliationCompleted",
  "topologyPreserved",
  "deploymentExact",
  "runtimeHealthExact",
  "runtimeStartupExact",
  "runtimeReadinessExact",
  "collateralStateUnchanged",
  "boundaryPostflightExact",
  "terminalEvidenceExact",
] as const;

function nullableSha256(value: unknown): boolean {
  return value === null || SHA256_PATTERN.test(String(value));
}

function validateDeploymentReceipt(
  source: string,
  value: JsonRecord,
  candidateSha: string,
): {
  readonly receiptSha256: string;
  readonly deploymentIdSha256: string;
  readonly workerFenceRunId: string;
  readonly workerFenceVerificationSha256: string;
  readonly workerFenceBindingSha256: string;
  readonly workerFenceTerminalSha256: string;
  readonly workerFenceDeploymentIdSha256: string;
  readonly replicaCount: 1;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
} {
  if (!exactKeys(value, [
    "schemaVersion",
    "operation",
    "executorState",
    "target",
    "outcome",
    "failureCode",
    "candidateSha",
    "startedAt",
    "completedAt",
    "writeAttempts",
    "acknowledgement",
    "previousDeploymentIdSha256",
    "deploymentIdSha256",
    "intentSha256",
    "cliOutputSha256",
    "boundaryPreflightSha256",
    "boundaryPostflightSha256",
    "collateralSnapshotSha256s",
    "replicaCounts",
    "runtimeResponseSha256s",
    "workerFencePrerequisite",
    "checks",
  ])) fail("deployment_receipt_invalid");
  const collateral = record(value.collateralSnapshotSha256s)
    ? value.collateralSnapshotSha256s
    : null;
  const replicas = record(value.replicaCounts) ? value.replicaCounts : null;
  const runtime = record(value.runtimeResponseSha256s)
    ? value.runtimeResponseSha256s
    : null;
  const workerFence = record(value.workerFencePrerequisite)
    ? value.workerFencePrerequisite
    : null;
  const started = timestamp(value.startedAt, "deployment_receipt_invalid");
  const completed = timestamp(value.completedAt, "deployment_receipt_invalid");
  const successfulOutcomes = [
    "deployed",
    "already_deployed",
    "reconciled_success",
  ];
  const outcomeRelationExact =
    (value.outcome === "deployed"
      && value.writeAttempts === 1
      && value.acknowledgement === "received"
      && SHA256_PATTERN.test(String(value.cliOutputSha256))
      && value.deploymentIdSha256 !== value.previousDeploymentIdSha256)
    || (value.outcome === "already_deployed"
      && value.writeAttempts === 0
      && value.acknowledgement === "not_attempted"
      && value.cliOutputSha256 === null
      && value.deploymentIdSha256 === value.previousDeploymentIdSha256)
    || (value.outcome === "reconciled_success"
      && value.writeAttempts === 1
      && value.acknowledgement === "missing_or_failed"
      && SHA256_PATTERN.test(String(value.cliOutputSha256))
      && value.deploymentIdSha256 !== value.previousDeploymentIdSha256);
  if (
    value.schemaVersion !== DEPLOYMENT_RECEIPT_SCHEMA
    || value.operation !== "pintpath-railway-application-source-upload"
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || value.target !== "production"
    || !successfulOutcomes.includes(String(value.outcome))
    || !outcomeRelationExact
    || value.failureCode !== null
    || value.candidateSha !== candidateSha
    || completed.milliseconds < started.milliseconds
    || !SHA256_PATTERN.test(String(value.previousDeploymentIdSha256))
    || !SHA256_PATTERN.test(String(value.deploymentIdSha256))
    || !SHA256_PATTERN.test(String(value.intentSha256))
    || !nullableSha256(value.cliOutputSha256)
    || !SHA256_PATTERN.test(String(value.boundaryPreflightSha256))
    || !SHA256_PATTERN.test(String(value.boundaryPostflightSha256))
    || !exactKeys(collateral, ["before", "after"])
    || !SHA256_PATTERN.test(String(collateral.before))
    || collateral.after !== collateral.before
    || !exactKeys(replicas, ["before", "after"])
    || replicas.before !== 1
    || replicas.after !== replicas.before
    || !exactKeys(runtime, ["health", "startup", "ready"])
    || !SHA256_PATTERN.test(String(runtime.health))
    || !SHA256_PATTERN.test(String(runtime.startup))
    || !SHA256_PATTERN.test(String(runtime.ready))
    || !exactKeys(workerFence, [
      "runId",
      "verificationSha256",
      "bindingSha256",
      "terminalSha256",
      "deploymentIdSha256",
    ])
    || !RUN_ID_PATTERN.test(String(workerFence.runId))
    || !SHA256_PATTERN.test(String(workerFence.verificationSha256))
    || !SHA256_PATTERN.test(String(workerFence.bindingSha256))
    || !SHA256_PATTERN.test(String(workerFence.terminalSha256))
    || !SHA256_PATTERN.test(String(workerFence.deploymentIdSha256))
    || !exactTrueChecks(value.checks, DEPLOYMENT_CHECK_KEYS)
  ) fail("deployment_receipt_invalid");
  return {
    receiptSha256: sha256(source),
    deploymentIdSha256: String(value.deploymentIdSha256),
    workerFenceRunId: String(workerFence.runId),
    workerFenceVerificationSha256: String(workerFence.verificationSha256),
    workerFenceBindingSha256: String(workerFence.bindingSha256),
    workerFenceTerminalSha256: String(workerFence.terminalSha256),
    workerFenceDeploymentIdSha256: String(workerFence.deploymentIdSha256),
    replicaCount: 1,
    startedAtMs: started.milliseconds,
    completedAtMs: completed.milliseconds,
  };
}

const ROLE_LIMIT_CHECK_KEYS = [
  "policyExact",
  "githubContextExact",
  "ambientPostgresAuthorityAbsent",
  "intentExact",
  "priorIntentRequiredForAlreadyDesired",
  "prerequisiteIntentBindingExact",
  "prerequisiteVerificationExact",
  "repositoryPreflightExact",
  "credentialCustodyExact",
  "transportExact",
  "catalogPreflightExact",
  "repositoryPrewriteExact",
  "advisoryLockExact",
  "immediateCatalogPrewriteExact",
  "oneAlterRoleAtMost",
  "automaticRetryAbsent",
  "postflightAttempted",
  "catalogPostflightExact",
  "primaryConnectionCleanupExact",
  "postflightConnectionCleanupExact",
  "terminalEvidenceExact",
  "receiptEvidenceExact",
] as const;

function validateRoleLimitTerminalAndReceipt(
  terminalSource: string,
  terminal: JsonRecord,
  receiptSource: string,
  receipt: JsonRecord,
  input: {
    readonly candidateSha: string;
    readonly runId: string;
    readonly prerequisitesSha256: string;
    readonly fenceRunId: string;
    readonly deploymentRunId: string;
    readonly runStartedAtMs: number;
    readonly runCompletedAtMs: number;
  },
): {
  readonly terminalSha256: string;
  readonly receiptSha256: string;
  readonly intentSha256: string;
  readonly outcome: "updated" | "reconciled_after_ambiguous_write";
  readonly startedAtMs: number;
  readonly completedAtMs: number;
} {
  const successfulOutcomes = [
    "updated",
    "reconciled_after_ambiguous_write",
  ] as const;
  if (!exactKeys(terminal, [
    "schemaVersion",
    "policySha256",
    "candidateSha",
    "phase",
    "outcome",
    "failureCode",
    "intentSha256",
    "prerequisitesVerificationSha256",
    "workerFenceRunId",
    "productionDeploymentRunId",
    "writeAttempts",
    "retryAllowed",
    "preflightCatalogSha256",
    "postflightCatalogSha256",
    "startedAt",
    "completedAt",
    "secretMaterialIncluded",
  ])) fail("evidence_invalid");
  const terminalStarted = timestamp(terminal.startedAt, "evidence_invalid");
  const terminalCompleted = timestamp(terminal.completedAt, "evidence_invalid");
  if (
    terminal.schemaVersion !== ROLE_LIMIT_TERMINAL_SCHEMA
    || terminal.policySha256
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256
    || terminal.candidateSha !== input.candidateSha
    || terminal.phase !== "apply"
    || !successfulOutcomes.includes(terminal.outcome as never)
    || terminal.failureCode !== null
    || !SHA256_PATTERN.test(String(terminal.intentSha256))
    || terminal.prerequisitesVerificationSha256
      !== input.prerequisitesSha256
    || terminal.workerFenceRunId !== input.fenceRunId
    || terminal.productionDeploymentRunId !== input.deploymentRunId
    || terminal.writeAttempts !== 1
    || terminal.retryAllowed !== false
    || !SHA256_PATTERN.test(String(terminal.preflightCatalogSha256))
    || !SHA256_PATTERN.test(String(terminal.postflightCatalogSha256))
    || terminalCompleted.milliseconds < terminalStarted.milliseconds
    || terminalStarted.milliseconds
      < input.runStartedAtMs - MAXIMUM_CLOCK_SKEW_MS
    || terminalCompleted.milliseconds
      > input.runCompletedAtMs + MAXIMUM_CLOCK_SKEW_MS
    || terminal.secretMaterialIncluded !== false
  ) fail("evidence_invalid");

  if (!exactKeys(receipt, [
    "schemaVersion",
    "policyId",
    "policySha256",
    "phase",
    "outcome",
    "failureCode",
    "candidateSha",
    "repository",
    "workflowPath",
    "githubEnvironment",
    "githubRunId",
    "githubRunAttempt",
    "targetEnvironment",
    "databaseHost",
    "databasePort",
    "databaseName",
    "authorityLogin",
    "loginRole",
    "groupRole",
    "expectedOldConnectionLimit",
    "desiredConnectionLimit",
    "rootCaDerSha256",
    "intentSha256",
    "prerequisitesVerificationSha256",
    "workerFenceRunId",
    "productionDeploymentRunId",
    "terminalEvidenceSha256",
    "preflightCatalogSha256",
    "postflightCatalogSha256",
    "writeAttempts",
    "maximumWriteAttempts",
    "retryAllowed",
    "startedAt",
    "completedAt",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
    "checks",
    "receiptSha256",
  ])) fail("evidence_invalid");
  const receiptStarted = timestamp(receipt.startedAt, "evidence_invalid");
  const receiptCompleted = timestamp(receipt.completedAt, "evidence_invalid");
  const receiptChecks = record(receipt.checks) ? receipt.checks : null;
  const checkVectorExact = exactKeys(receiptChecks, ROLE_LIMIT_CHECK_KEYS)
    && ROLE_LIMIT_CHECK_KEYS.every((key) => receiptChecks[key]
      === (key === "priorIntentRequiredForAlreadyDesired" ? false : true));
  const receiptPayload = { ...receipt };
  delete receiptPayload.receiptSha256;
  const terminalDigest = sha256(terminalSource);
  if (
    receipt.schemaVersion !== ROLE_LIMIT_RECEIPT_SCHEMA
    || receipt.policyId !== ROLE_LIMIT_POLICY_ID
    || receipt.policySha256
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256
    || receipt.phase !== terminal.phase
    || receipt.outcome !== terminal.outcome
    || receipt.failureCode !== terminal.failureCode
    || receipt.candidateSha !== input.candidateSha
    || receipt.repository !== REPOSITORY
    || receipt.workflowPath !== ROLE_LIMIT_WORKFLOW
    || receipt.githubEnvironment !== ROLE_LIMIT_GITHUB_ENVIRONMENT
    || receipt.githubRunId !== input.runId
    || receipt.githubRunAttempt !== 1
    || receipt.targetEnvironment !== "production"
    || receipt.databaseHost !== "postgres-production.railway.internal"
    || receipt.databasePort !== 5432
    || receipt.databaseName !== "pintpath"
    || receipt.authorityLogin !== "postgres"
    || receipt.loginRole !== "privacy_maintenance_login"
    || receipt.groupRole !== "pintpath_maintenance"
    || receipt.expectedOldConnectionLimit !== 2
    || receipt.desiredConnectionLimit !== 8
    || !SHA256_PATTERN.test(String(receipt.rootCaDerSha256))
    || receipt.intentSha256 !== terminal.intentSha256
    || receipt.prerequisitesVerificationSha256
      !== terminal.prerequisitesVerificationSha256
    || receipt.workerFenceRunId !== terminal.workerFenceRunId
    || receipt.productionDeploymentRunId !== terminal.productionDeploymentRunId
    || receipt.terminalEvidenceSha256 !== terminalDigest
    || receipt.preflightCatalogSha256 !== terminal.preflightCatalogSha256
    || receipt.postflightCatalogSha256 !== terminal.postflightCatalogSha256
    || receipt.writeAttempts !== 1
    || receipt.maximumWriteAttempts !== 1
    || receipt.retryAllowed !== false
    || receiptStarted.canonical !== terminalStarted.canonical
    || receiptCompleted.canonical !== terminalCompleted.canonical
    || receipt.secretMaterialIncluded !== false
    || receipt.secretDerivedCommitmentsIncluded !== false
    || !checkVectorExact
    || receipt.receiptSha256 !== sha256(canonical(receiptPayload))
    || canonical(terminal) !== terminalSource
    || canonical(receipt) !== receiptSource
  ) fail("evidence_invalid");
  return {
    terminalSha256: terminalDigest,
    receiptSha256: sha256(receiptSource),
    intentSha256: String(terminal.intentSha256),
    outcome: terminal.outcome as
      | "updated"
      | "reconciled_after_ambiguous_write",
    startedAtMs: terminalStarted.milliseconds,
    completedAtMs: terminalCompleted.milliseconds,
  };
}

function validatePriorRoleIntent(
  source: string,
  value: JsonRecord,
  input: {
    readonly candidateSha: string;
    readonly priorRunId: string;
    readonly prerequisitesSha256: string;
  },
): {
  readonly intentSha256: string;
  readonly fenceRunId: string;
  readonly deploymentRunId: string;
} {
  if (!exactKeys(value, [
    "schemaVersion",
    "policyId",
    "policySha256",
    "candidateSha",
    "repository",
    "workflowPath",
    "githubEnvironment",
    "githubRunId",
    "githubRunAttempt",
    "targetEnvironment",
    "databaseHost",
    "databasePort",
    "databaseName",
    "authorityLogin",
    "loginRole",
    "groupRole",
    "expectedOldConnectionLimit",
    "desiredConnectionLimit",
    "prerequisitesVerificationSchema",
    "prerequisitesVerificationSha256",
    "workerFenceRunId",
    "productionDeploymentRunId",
    "rootCaDerSha256",
    "maximumWriteAttempts",
    "retryAllowed",
    "createdAt",
    "expiresAt",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ]) || canonical(value) !== source) fail("evidence_invalid");
  const created = timestamp(value.createdAt, "evidence_invalid");
  const expires = timestamp(value.expiresAt, "evidence_invalid");
  if (
    value.schemaVersion
      !== "pintpath-production-maintenance-login-limit-intent/v1"
    || value.policyId !== ROLE_LIMIT_POLICY_ID
    || value.policySha256
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256
    || value.candidateSha !== input.candidateSha
    || value.repository !== REPOSITORY
    || value.workflowPath !== ROLE_LIMIT_WORKFLOW
    || value.githubEnvironment !== ROLE_LIMIT_GITHUB_ENVIRONMENT
    || value.githubRunId !== input.priorRunId
    || value.githubRunAttempt !== 1
    || value.targetEnvironment !== "production"
    || value.databaseHost !== "postgres-production.railway.internal"
    || value.databasePort !== 5432
    || value.databaseName !== "pintpath"
    || value.authorityLogin !== "postgres"
    || value.loginRole !== "privacy_maintenance_login"
    || value.groupRole !== "pintpath_maintenance"
    || value.expectedOldConnectionLimit !== 2
    || value.desiredConnectionLimit !== 8
    || value.prerequisitesVerificationSchema
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_SCHEMA
    || value.prerequisitesVerificationSha256 !== input.prerequisitesSha256
    || !RUN_ID_PATTERN.test(String(value.workerFenceRunId))
    || !RUN_ID_PATTERN.test(String(value.productionDeploymentRunId))
    || value.workerFenceRunId === value.productionDeploymentRunId
    || !SHA256_PATTERN.test(String(value.rootCaDerSha256))
    || value.maximumWriteAttempts !== 1
    || value.retryAllowed !== false
    || expires.milliseconds - created.milliseconds !== 3_600_000
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
  ) fail("evidence_invalid");
  return {
    intentSha256: sha256(source),
    fenceRunId: String(value.workerFenceRunId),
    deploymentRunId: String(value.productionDeploymentRunId),
  };
}

function validateRunListing(
  value: unknown,
  predicate: (run: JsonRecord) => boolean,
  expectedRunId: string,
  allowOtherRunsCompletedByMs: number,
): void {
  const listing = record(value) ? value : null;
  const runs = Array.isArray(listing?.workflow_runs)
    ? listing.workflow_runs.filter(record)
    : [];
  if (
    !listing
    || !Number.isSafeInteger(listing.total_count)
    || Number(listing.total_count) < 1
    || Number(listing.total_count) > 100
    || runs.length !== listing.total_count
  ) fail("later_run_detected");
  const relevant = runs.filter(predicate);
  const selected = relevant.filter((run) => String(run.id) === expectedRunId);
  if (selected.length !== 1) fail("later_run_detected");
  for (const run of relevant) {
    if (String(run.id) === expectedRunId) continue;
    const completed = timestamp(run.updated_at, "later_run_detected");
    if (
      run.status !== "completed"
      || completed.milliseconds > allowOtherRunsCompletedByMs
    ) fail("later_run_detected");
  }
}

function validateNoRunAfter(
  value: unknown,
  allowRunsCompletedByMs: number,
): void {
  const listing = record(value) ? value : null;
  const runs = Array.isArray(listing?.workflow_runs)
    ? listing.workflow_runs.filter(record)
    : [];
  if (
    !listing
    || !Number.isSafeInteger(listing.total_count)
    || Number(listing.total_count) < 0
    || Number(listing.total_count) > 100
    || runs.length !== listing.total_count
  ) fail("later_run_detected");
  for (const run of runs) {
    const completed = timestamp(run.updated_at, "later_run_detected");
    if (
      run.status !== "completed"
      || completed.milliseconds > allowRunsCompletedByMs
    ) fail("later_run_detected");
  }
}

function validateReconciliationRoleRunListing(
  value: unknown,
  priorRunId: string,
  currentRunId: string,
  priorCompletedAtMs: number,
): void {
  const listing = record(value) ? value : null;
  const runs = Array.isArray(listing?.workflow_runs)
    ? listing.workflow_runs.filter(record)
    : [];
  if (
    !listing
    || !Number.isSafeInteger(listing.total_count)
    || Number(listing.total_count) < 2
    || Number(listing.total_count) > 100
    || runs.length !== listing.total_count
    || runs.filter((run) => String(run.id) === priorRunId).length !== 1
    || runs.filter((run) => String(run.id) === currentRunId).length !== 1
  ) fail("later_run_detected");
  for (const run of runs) {
    const id = String(run.id);
    if (id === priorRunId || id === currentRunId) continue;
    if (run.status !== "completed") fail("later_run_detected");
    if (
      typeof run.display_title === "string"
      && run.display_title.startsWith(
        "Production maintenance LOGIN limit | apply | ",
      )
      && timestamp(run.updated_at, "later_run_detected").milliseconds
        > priorCompletedAtMs
    ) fail("later_run_detected");
  }
}

function parseVerificationObject(
  source: string,
  expected: {
    readonly candidateSha: string;
    readonly currentRunId: string;
    readonly fenceRunId: string | null;
    readonly deploymentRunId: string | null;
    readonly now: Date;
  },
): ProductionMaintenanceRoleLimitPrerequisitesVerification {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    fail("evidence_invalid");
  }
  if (!exactKeys(value, [
    "schemaVersion",
    "policySha256",
    "candidateSha",
    "repository",
    "consumer",
    "workerFence",
    "productionDeployment",
    "verifiedAt",
    "expiresAt",
    "checks",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ]) || canonical(value) !== source) fail("evidence_invalid");
  const consumer = record(value.consumer) ? value.consumer : null;
  const fence = record(value.workerFence) ? value.workerFence : null;
  const deployment = record(value.productionDeployment)
    ? value.productionDeployment
    : null;
  const verifiedAt = timestamp(value.verifiedAt, "evidence_invalid");
  const expiresAt = timestamp(value.expiresAt, "evidence_invalid");
  const consumerStartedAt = timestamp(
    consumer?.startedAt,
    "evidence_invalid",
  );
  const fenceStartedAt = timestamp(fence?.startedAt, "evidence_invalid");
  const fenceCompletedAt = timestamp(fence?.completedAt, "evidence_invalid");
  const deploymentStartedAt = timestamp(
    deployment?.startedAt,
    "evidence_invalid",
  );
  const deploymentCompletedAt = timestamp(
    deployment?.completedAt,
    "evidence_invalid",
  );
  const checkKeys = [
    "policiesExact",
    "consumerRunAuthorityExact",
    "fenceRunAuthorityExact",
    "fenceArtifactAuthorityExact",
    "downloadActionPinExact",
    "uniquePrerequisiteReceiptsExact",
    "independentArtifactArchiveDigestsExact",
    "localReceiptBytesMatchArchivesExact",
    "fenceReceiptExact",
    "fenceWorkersDisabledExact",
    "fenceCandidateBindingExact",
    "fenceDeploymentUnchangedExact",
    "deploymentRunAuthorityExact",
    "deploymentArtifactAuthorityExact",
    "deploymentReceiptExact",
    "deploymentRuntimeWorkersDisabledExact",
    "deploymentRuntimeCandidateBindingExact",
    "deploymentSoleHealthyCandidateExact",
    "chronologyExact",
    "noLaterProductionWorkerFenceRunExact",
    "noLaterProductionDeploymentRunExact",
    "noLaterProductionScaleRunExact",
    "noPriorRoleLimitApplyRunExact",
    "evidenceSecretFreeExact",
  ] as const;
  if (
    value.schemaVersion
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_SCHEMA
    || value.policySha256
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256
    || value.candidateSha !== expected.candidateSha
    || value.repository !== REPOSITORY
    || !exactKeys(consumer, [
      "workflowPath",
      "githubEnvironment",
      "runId",
      "runAttempt",
      "startedAt",
    ])
    || consumer.workflowPath !== ROLE_LIMIT_WORKFLOW
    || consumer.githubEnvironment !== ROLE_LIMIT_GITHUB_ENVIRONMENT
    || consumer.runId !== expected.currentRunId
    || consumer.runAttempt !== 1
    || consumerStartedAt.milliseconds > verifiedAt.milliseconds
    || !exactKeys(fence, [
      "workflowPath",
      "runId",
      "runAttempt",
      "startedAt",
      "completedAt",
      "artifactName",
      "artifactId",
      "artifactDigest",
      "artifactSizeBytes",
      "policySha256",
      "producerSha256",
      "producerWorkflowSha256",
      "terminalSha256",
      "bindingSha256",
      "intentSha256",
    ])
    || fence.workflowPath !== FENCE_WORKFLOW
    || !RUN_ID_PATTERN.test(String(fence.runId))
    || (expected.fenceRunId !== null && fence.runId !== expected.fenceRunId)
    || fence.runAttempt !== 1
    || fence.artifactName
      !== `pintpath-automatic-maintenance-worker-fence-production-fence-${expected.candidateSha}`
    || !RUN_ID_PATTERN.test(String(fence.artifactId))
    || !ARTIFACT_DIGEST_PATTERN.test(String(fence.artifactDigest))
    || !Number.isSafeInteger(fence.artifactSizeBytes)
    || Number(fence.artifactSizeBytes) < 1
    || Number(fence.artifactSizeBytes) > MAXIMUM_ARTIFACT_BYTES
    || fence.policySha256 !== FENCE_POLICY_SHA256
    || fence.producerSha256 !== FENCE_PRODUCER_SHA256
    || fence.producerWorkflowSha256 !== FENCE_WORKFLOW_SHA256
    || !SHA256_PATTERN.test(String(fence.terminalSha256))
    || !SHA256_PATTERN.test(String(fence.bindingSha256))
    || !SHA256_PATTERN.test(String(fence.intentSha256))
    || !exactKeys(deployment, [
      "workflowPath",
      "runId",
      "runAttempt",
      "startedAt",
      "completedAt",
      "artifactName",
      "artifactId",
      "artifactDigest",
      "artifactSizeBytes",
      "policySha256",
      "producerSha256",
      "producerWorkflowSha256",
      "receiptSha256",
      "deploymentIdSha256",
      "replicaCount",
    ])
    || deployment.workflowPath !== DEPLOYMENT_WORKFLOW
    || !RUN_ID_PATTERN.test(String(deployment.runId))
    || (expected.deploymentRunId !== null
      && deployment.runId !== expected.deploymentRunId)
    || deployment.runAttempt !== 1
    || deployment.artifactName
      !== `pintpath-production-deployment-${expected.candidateSha}`
    || !RUN_ID_PATTERN.test(String(deployment.artifactId))
    || !ARTIFACT_DIGEST_PATTERN.test(String(deployment.artifactDigest))
    || !Number.isSafeInteger(deployment.artifactSizeBytes)
    || Number(deployment.artifactSizeBytes) < 1
    || Number(deployment.artifactSizeBytes) > MAXIMUM_ARTIFACT_BYTES
    || deployment.policySha256 !== DEPLOYMENT_POLICY_SHA256
    || deployment.producerSha256 !== DEPLOYMENT_PRODUCER_SHA256
    || deployment.producerWorkflowSha256 !== DEPLOYMENT_WORKFLOW_SHA256
    || !SHA256_PATTERN.test(String(deployment.receiptSha256))
    || !SHA256_PATTERN.test(String(deployment.deploymentIdSha256))
    || deployment.replicaCount !== 1
    || !exactTrueChecks(value.checks, checkKeys)
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
    || fenceCompletedAt.milliseconds <= fenceStartedAt.milliseconds
    || fenceCompletedAt.milliseconds > deploymentStartedAt.milliseconds
    || deploymentCompletedAt.milliseconds <= deploymentStartedAt.milliseconds
    || deploymentCompletedAt.milliseconds > consumerStartedAt.milliseconds
    || verifiedAt.milliseconds - fenceCompletedAt.milliseconds
      > MAXIMUM_RECEIPT_AGE_MS
    || verifiedAt.milliseconds - deploymentCompletedAt.milliseconds
      > MAXIMUM_RECEIPT_AGE_MS
    || expiresAt.milliseconds - verifiedAt.milliseconds
      !== MAXIMUM_VERIFICATION_AGE_MS
    || verifiedAt.milliseconds
      > expected.now.getTime() + MAXIMUM_CLOCK_SKEW_MS
    || expected.now.getTime() > expiresAt.milliseconds
  ) fail("evidence_invalid");
  return value as unknown as ProductionMaintenanceRoleLimitPrerequisitesVerification;
}

export function parseProductionMaintenanceRoleLimitPrerequisitesVerification(
  source: string,
  expected: {
    readonly candidateSha: string;
    readonly currentRunId: string;
    readonly fenceRunId: string | null;
    readonly deploymentRunId: string | null;
    readonly now: Date;
  },
): ProductionMaintenanceRoleLimitPrerequisitesVerification {
  return parseVerificationObject(source, expected);
}

export function parseProductionDeploymentWorkerFencePrerequisiteVerification(
  source: string,
  expected: {
    readonly candidateSha: string;
    readonly currentRunId: string;
    readonly fenceRunId: string;
    readonly now: Date;
  },
): ProductionDeploymentWorkerFencePrerequisiteVerification {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    fail("evidence_invalid");
  }
  if (!exactKeys(value, [
    "schemaVersion",
    "roleLimitPolicySha256",
    "workerFencePolicySha256",
    "productionDeploymentPolicySha256",
    "candidateSha",
    "repository",
    "consumer",
    "workerFence",
    "verifiedAt",
    "expiresAt",
    "checks",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ]) || canonical(value) !== source) fail("evidence_invalid");
  const consumer = record(value.consumer) ? value.consumer : null;
  const fence = record(value.workerFence) ? value.workerFence : null;
  const verifiedAt = timestamp(value.verifiedAt, "evidence_invalid");
  const expiresAt = timestamp(value.expiresAt, "evidence_invalid");
  const consumerStartedAt = timestamp(
    consumer?.startedAt,
    "evidence_invalid",
  );
  const fenceStartedAt = timestamp(fence?.startedAt, "evidence_invalid");
  const fenceCompletedAt = timestamp(fence?.completedAt, "evidence_invalid");
  const checkKeys = [
    "policiesExact",
    "consumerRunAuthorityExact",
    "fenceRunAuthorityExact",
    "fenceArtifactAuthorityExact",
    "downloadActionPinExact",
    "uniqueFenceReceiptExact",
    "independentFenceArchiveDigestExact",
    "localFenceReceiptBytesMatchArchiveExact",
    "fenceReceiptExact",
    "fenceWorkersDisabledExact",
    "fenceCandidateBindingExact",
    "fenceDeploymentUnchangedExact",
    "chronologyExact",
    "noLaterProductionWorkerFenceRunExact",
    "noPriorProductionDeploymentRunExact",
    "noProductionScaleRunAfterFenceExact",
    "evidenceSecretFreeExact",
  ] as const;
  if (
    value.schemaVersion
      !== PRODUCTION_DEPLOYMENT_WORKER_FENCE_PREREQUISITE_SCHEMA
    || value.roleLimitPolicySha256
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256
    || value.workerFencePolicySha256 !== FENCE_POLICY_SHA256
    || value.productionDeploymentPolicySha256 !== DEPLOYMENT_POLICY_SHA256
    || value.candidateSha !== expected.candidateSha
    || value.repository !== REPOSITORY
    || !exactKeys(consumer, [
      "workflowPath",
      "githubEnvironment",
      "runId",
      "runAttempt",
      "startedAt",
    ])
    || consumer.workflowPath !== DEPLOYMENT_WORKFLOW
    || consumer.githubEnvironment !== "production-deployment"
    || consumer.runId !== expected.currentRunId
    || consumer.runAttempt !== 1
    || consumerStartedAt.milliseconds > verifiedAt.milliseconds
    || !exactKeys(fence, [
      "workflowPath",
      "runId",
      "runAttempt",
      "startedAt",
      "completedAt",
      "artifactName",
      "artifactId",
      "artifactDigest",
      "artifactSizeBytes",
      "terminalSha256",
      "bindingSha256",
      "intentSha256",
      "deploymentIdSha256",
      "producerSha256",
      "producerWorkflowSha256",
    ])
    || fence.workflowPath !== FENCE_WORKFLOW
    || fence.runId !== expected.fenceRunId
    || fence.runAttempt !== 1
    || fence.artifactName
      !== `pintpath-automatic-maintenance-worker-fence-production-fence-${expected.candidateSha}`
    || !RUN_ID_PATTERN.test(String(fence.artifactId))
    || !ARTIFACT_DIGEST_PATTERN.test(String(fence.artifactDigest))
    || !Number.isSafeInteger(fence.artifactSizeBytes)
    || Number(fence.artifactSizeBytes) < 1
    || Number(fence.artifactSizeBytes) > MAXIMUM_ARTIFACT_BYTES
    || !SHA256_PATTERN.test(String(fence.terminalSha256))
    || !SHA256_PATTERN.test(String(fence.bindingSha256))
    || !SHA256_PATTERN.test(String(fence.intentSha256))
    || !SHA256_PATTERN.test(String(fence.deploymentIdSha256))
    || fence.producerSha256 !== FENCE_PRODUCER_SHA256
    || fence.producerWorkflowSha256 !== FENCE_WORKFLOW_SHA256
    || !exactTrueChecks(value.checks, checkKeys)
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
    || fenceCompletedAt.milliseconds <= fenceStartedAt.milliseconds
    || fenceCompletedAt.milliseconds > consumerStartedAt.milliseconds
    || verifiedAt.milliseconds - fenceCompletedAt.milliseconds
      > MAXIMUM_RECEIPT_AGE_MS
    || expiresAt.milliseconds - verifiedAt.milliseconds
      !== MAXIMUM_VERIFICATION_AGE_MS
    || verifiedAt.milliseconds
      > expected.now.getTime() + MAXIMUM_CLOCK_SKEW_MS
    || expected.now.getTime() > expiresAt.milliseconds
  ) fail("evidence_invalid");
  return value as unknown as ProductionDeploymentWorkerFencePrerequisiteVerification;
}

export function parseProductionActivationRoleLimitPrerequisiteVerification(
  source: string,
  expected: {
    readonly candidateSha: string;
    readonly currentRunId: string;
    readonly roleLimitRunId: string;
    readonly now: Date;
  },
): ProductionActivationRoleLimitPrerequisiteVerification {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    fail("evidence_invalid");
  }
  if (!exactKeys(value, [
    "schemaVersion",
    "policySha256",
    "candidateSha",
    "repository",
    "consumer",
    "roleLimit",
    "rolePrerequisites",
    "verifiedAt",
    "expiresAt",
    "checks",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ]) || canonical(value) !== source) fail("evidence_invalid");
  const consumer = record(value.consumer) ? value.consumer : null;
  const role = record(value.roleLimit) ? value.roleLimit : null;
  const rolePrerequisites = record(value.rolePrerequisites)
    ? value.rolePrerequisites
    : null;
  const verifiedAt = timestamp(value.verifiedAt, "evidence_invalid");
  const expiresAt = timestamp(value.expiresAt, "evidence_invalid");
  const consumerStarted = timestamp(consumer?.startedAt, "evidence_invalid");
  const roleStarted = timestamp(role?.startedAt, "evidence_invalid");
  const roleCompleted = timestamp(role?.completedAt, "evidence_invalid");
  const nestedVerifiedAt = timestamp(
    rolePrerequisites?.verifiedAt,
    "evidence_invalid",
  );
  parseProductionMaintenanceRoleLimitPrerequisitesVerification(
    canonical(rolePrerequisites),
    {
      candidateSha: expected.candidateSha,
      currentRunId: expected.roleLimitRunId,
      fenceRunId: null,
      deploymentRunId: null,
      now: new Date(nestedVerifiedAt.milliseconds),
    },
  );
  const checkKeys = [
    "policiesExact",
    "consumerRunAuthorityExact",
    "roleRunAuthorityExact",
    "roleArtifactAuthorityExact",
    "independentRoleArchiveDigestExact",
    "localRoleFilesMatchArchiveExact",
    "roleIntentExact",
    "roleTerminalExact",
    "fullFenceDeployRoleChainExact",
    "chronologyExact",
    "noLaterProductionWorkerRunExact",
    "noLaterProductionDeploymentRunExact",
    "noLaterRoleLimitRunExact",
    "noProductionScaleRunAfterDeploymentExact",
    "evidenceSecretFreeExact",
  ] as const;
  if (
    value.schemaVersion !== PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_SCHEMA
    || value.policySha256
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256
    || value.candidateSha !== expected.candidateSha
    || value.repository !== REPOSITORY
    || !exactKeys(consumer, [
      "workflowPath",
      "githubEnvironment",
      "runId",
      "runAttempt",
      "startedAt",
    ])
    || consumer.workflowPath !== FENCE_WORKFLOW
    || consumer.githubEnvironment !== "production-runtime-configuration"
    || consumer.runId !== expected.currentRunId
    || consumer.runAttempt !== 1
    || !exactKeys(role, [
      "workflowPath",
      "runId",
      "runAttempt",
      "startedAt",
      "completedAt",
      "artifactName",
      "artifactId",
      "artifactDigest",
      "artifactSizeBytes",
      "intentSha256",
      "terminalSha256",
      "receiptSha256",
      "prerequisitesSha256",
      "outcome",
    ])
    || role.workflowPath !== ROLE_LIMIT_WORKFLOW
    || role.runId !== expected.roleLimitRunId
    || role.runAttempt !== 1
    || role.artifactName
      !== `pintpath-production-maintenance-role-limit-apply-${expected.candidateSha}-${expected.roleLimitRunId}`
    || !RUN_ID_PATTERN.test(String(role.artifactId))
    || !ARTIFACT_DIGEST_PATTERN.test(String(role.artifactDigest))
    || !Number.isSafeInteger(role.artifactSizeBytes)
    || Number(role.artifactSizeBytes) < 1
    || Number(role.artifactSizeBytes) > MAXIMUM_ARTIFACT_BYTES
    || !SHA256_PATTERN.test(String(role.intentSha256))
    || !SHA256_PATTERN.test(String(role.terminalSha256))
    || !SHA256_PATTERN.test(String(role.receiptSha256))
    || !SHA256_PATTERN.test(String(role.prerequisitesSha256))
    || sha256(canonical(rolePrerequisites)) !== role.prerequisitesSha256
    || (role.outcome !== "updated"
      && role.outcome !== "reconciled_after_ambiguous_write")
    || !exactTrueChecks(value.checks, checkKeys)
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
    || roleCompleted.milliseconds <= roleStarted.milliseconds
    || roleCompleted.milliseconds > consumerStarted.milliseconds
    || consumerStarted.milliseconds > verifiedAt.milliseconds
    || verifiedAt.milliseconds - roleCompleted.milliseconds
      > MAXIMUM_RECEIPT_AGE_MS
    || expiresAt.milliseconds - verifiedAt.milliseconds
      !== MAXIMUM_VERIFICATION_AGE_MS
    || verifiedAt.milliseconds
      > expected.now.getTime() + MAXIMUM_CLOCK_SKEW_MS
    || expected.now.getTime() > expiresAt.milliseconds
  ) fail("evidence_invalid");
  return value as unknown as ProductionActivationRoleLimitPrerequisiteVerification;
}

export function parseProductionScaleActivationPrerequisiteVerification(
  source: string,
  expected: {
    readonly candidateSha: string;
    readonly currentRunId: string;
    readonly activateRunId: string;
    readonly now: Date;
  },
): ProductionScaleActivationPrerequisiteVerification {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    fail("evidence_invalid");
  }
  if (!exactKeys(value, [
    "schemaVersion",
    "policySha256",
    "candidateSha",
    "repository",
    "consumer",
    "activation",
    "activationPrerequisites",
    "verifiedAt",
    "expiresAt",
    "checks",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ]) || canonical(value) !== source) fail("evidence_invalid");
  const consumer = record(value.consumer) ? value.consumer : null;
  const activation = record(value.activation) ? value.activation : null;
  const prerequisites = record(value.activationPrerequisites)
    ? value.activationPrerequisites
    : null;
  const verifiedAt = timestamp(value.verifiedAt, "evidence_invalid");
  const expiresAt = timestamp(value.expiresAt, "evidence_invalid");
  const consumerStarted = timestamp(consumer?.startedAt, "evidence_invalid");
  const activationStarted = timestamp(
    activation?.startedAt,
    "evidence_invalid",
  );
  const activationCompleted = timestamp(
    activation?.completedAt,
    "evidence_invalid",
  );
  const nestedVerifiedAt = timestamp(
    prerequisites?.verifiedAt,
    "evidence_invalid",
  );
  const nested = parseProductionActivationRoleLimitPrerequisiteVerification(
    canonical(prerequisites),
    {
      candidateSha: expected.candidateSha,
      currentRunId: expected.activateRunId,
      roleLimitRunId: String(
        record(prerequisites?.roleLimit)
          ? prerequisites.roleLimit.runId
          : "",
      ),
      now: new Date(nestedVerifiedAt.milliseconds),
    },
  );
  const checkKeys = [
    "policiesExact",
    "consumerRunAuthorityExact",
    "activationRunAuthorityExact",
    "activationArtifactAuthorityExact",
    "independentActivationArchiveDigestExact",
    "localActivationFilesMatchArchiveExact",
    "activationTerminalExact",
    "fullRoleActivateChainExact",
    "chronologyExact",
    "noLaterProductionWorkerRunExact",
    "noLaterProductionDeploymentRunExact",
    "noLaterRoleLimitRunExact",
    "noPriorOrConcurrentScaleRunExact",
    "evidenceSecretFreeExact",
  ] as const;
  if (
    value.schemaVersion !== PRODUCTION_SCALE_ACTIVATION_PREREQUISITE_SCHEMA
    || value.policySha256
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256
    || value.candidateSha !== expected.candidateSha
    || value.repository !== REPOSITORY
    || !exactKeys(consumer, [
      "workflowPath",
      "githubEnvironment",
      "runId",
      "runAttempt",
      "startedAt",
    ])
    || consumer.workflowPath !== PRODUCTION_SCALE_WORKFLOW
    || consumer.githubEnvironment !== "production-topology-configuration"
    || consumer.runId !== expected.currentRunId
    || consumer.runAttempt !== 1
    || !exactKeys(activation, [
      "workflowPath",
      "runId",
      "runAttempt",
      "startedAt",
      "completedAt",
      "artifactName",
      "artifactId",
      "artifactDigest",
      "artifactSizeBytes",
      "terminalSha256",
      "prerequisitesSha256",
      "deploymentBeforeIdSha256",
      "deploymentAfterIdSha256",
    ])
    || activation.workflowPath !== FENCE_WORKFLOW
    || activation.runId !== expected.activateRunId
    || activation.runAttempt !== 1
    || activation.artifactName
      !== `pintpath-automatic-maintenance-worker-fence-production-activate-${expected.candidateSha}`
    || !RUN_ID_PATTERN.test(String(activation.artifactId))
    || !ARTIFACT_DIGEST_PATTERN.test(String(activation.artifactDigest))
    || !Number.isSafeInteger(activation.artifactSizeBytes)
    || Number(activation.artifactSizeBytes) < 1
    || Number(activation.artifactSizeBytes) > MAXIMUM_ARTIFACT_BYTES
    || !SHA256_PATTERN.test(String(activation.terminalSha256))
    || !SHA256_PATTERN.test(String(activation.prerequisitesSha256))
    || !SHA256_PATTERN.test(String(activation.deploymentBeforeIdSha256))
    || !SHA256_PATTERN.test(String(activation.deploymentAfterIdSha256))
    || activation.deploymentBeforeIdSha256
      !== nested.rolePrerequisites.productionDeployment.deploymentIdSha256
    || activation.deploymentAfterIdSha256
      === activation.deploymentBeforeIdSha256
    || sha256(canonical(prerequisites)) !== activation.prerequisitesSha256
    || nested.consumer.runId !== expected.activateRunId
    || !exactTrueChecks(value.checks, checkKeys)
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
    || activationCompleted.milliseconds <= activationStarted.milliseconds
    || activationCompleted.milliseconds > consumerStarted.milliseconds
    || consumerStarted.milliseconds > verifiedAt.milliseconds
    || verifiedAt.milliseconds - activationCompleted.milliseconds
      > MAXIMUM_RECEIPT_AGE_MS
    || expiresAt.milliseconds - verifiedAt.milliseconds
      !== MAXIMUM_VERIFICATION_AGE_MS
    || verifiedAt.milliseconds
      > expected.now.getTime() + MAXIMUM_CLOCK_SKEW_MS
    || expected.now.getTime() > expiresAt.milliseconds
  ) fail("evidence_invalid");
  return value as unknown as ProductionScaleActivationPrerequisiteVerification;
}

export function parseProductionRoleLimitReconciliationAuthorityVerification(
  source: string,
  expected: {
    readonly candidateSha: string;
    readonly currentRunId: string;
    readonly priorRoleRunId: string;
    readonly now: Date;
  },
): ProductionRoleLimitReconciliationAuthorityVerification {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    fail("evidence_invalid");
  }
  if (!exactKeys(value, [
    "schemaVersion",
    "policySha256",
    "candidateSha",
    "repository",
    "consumer",
    "priorApply",
    "verifiedAt",
    "expiresAt",
    "checks",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ]) || canonical(value) !== source) fail("evidence_invalid");
  const consumer = record(value.consumer) ? value.consumer : null;
  const prior = record(value.priorApply) ? value.priorApply : null;
  const verifiedAt = timestamp(value.verifiedAt, "evidence_invalid");
  const expiresAt = timestamp(value.expiresAt, "evidence_invalid");
  const consumerStarted = timestamp(consumer?.startedAt, "evidence_invalid");
  const priorStarted = timestamp(prior?.startedAt, "evidence_invalid");
  const priorCompleted = timestamp(prior?.completedAt, "evidence_invalid");
  const checkKeys = [
    "policiesExact",
    "consumerRunAuthorityExact",
    "priorApplyRunAuthorityExact",
    "priorIntentArtifactAuthorityExact",
    "independentPriorArchiveDigestExact",
    "localPriorFilesMatchArchiveExact",
    "priorIntentExact",
    "priorPrerequisiteBindingExact",
    "noNewMutationPrerequisitesRequiredExact",
    "noLaterRoleApplyRunExact",
    "evidenceSecretFreeExact",
  ] as const;
  if (
    value.schemaVersion
      !== PRODUCTION_ROLE_LIMIT_RECONCILIATION_AUTHORITY_SCHEMA
    || value.policySha256
      !== PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256
    || value.candidateSha !== expected.candidateSha
    || value.repository !== REPOSITORY
    || !exactKeys(consumer, [
      "workflowPath",
      "githubEnvironment",
      "runId",
      "runAttempt",
      "startedAt",
    ])
    || consumer.workflowPath !== ROLE_LIMIT_WORKFLOW
    || consumer.githubEnvironment !== ROLE_LIMIT_GITHUB_ENVIRONMENT
    || consumer.runId !== expected.currentRunId
    || consumer.runAttempt !== 1
    || !exactKeys(prior, [
      "workflowPath",
      "runId",
      "runAttempt",
      "conclusion",
      "startedAt",
      "completedAt",
      "artifactName",
      "artifactId",
      "artifactDigest",
      "artifactSizeBytes",
      "intentSha256",
      "prerequisitesSha256",
    ])
    || prior.workflowPath !== ROLE_LIMIT_WORKFLOW
    || prior.runId !== expected.priorRoleRunId
    || prior.runAttempt !== 1
    || !["success", "failure", "cancelled", "timed_out"].includes(
      String(prior.conclusion),
    )
    || prior.artifactName
      !== `pintpath-production-maintenance-role-limit-intent-${expected.candidateSha}-${expected.priorRoleRunId}`
    || !RUN_ID_PATTERN.test(String(prior.artifactId))
    || !ARTIFACT_DIGEST_PATTERN.test(String(prior.artifactDigest))
    || !Number.isSafeInteger(prior.artifactSizeBytes)
    || Number(prior.artifactSizeBytes) < 1
    || Number(prior.artifactSizeBytes) > MAXIMUM_ARTIFACT_BYTES
    || !SHA256_PATTERN.test(String(prior.intentSha256))
    || !SHA256_PATTERN.test(String(prior.prerequisitesSha256))
    || !exactTrueChecks(value.checks, checkKeys)
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
    || priorCompleted.milliseconds <= priorStarted.milliseconds
    || priorCompleted.milliseconds > consumerStarted.milliseconds
    || consumerStarted.milliseconds > verifiedAt.milliseconds
    || verifiedAt.milliseconds - priorCompleted.milliseconds
      > 2_592_000_000
    || expiresAt.milliseconds - verifiedAt.milliseconds
      !== MAXIMUM_VERIFICATION_AGE_MS
    || verifiedAt.milliseconds
      > expected.now.getTime() + MAXIMUM_CLOCK_SKEW_MS
    || expected.now.getTime() > expiresAt.milliseconds
  ) fail("evidence_invalid");
  return value as unknown as ProductionRoleLimitReconciliationAuthorityVerification;
}

async function verifyRoleLimit(
  args: Arguments,
  currentRunId: string,
  dependencies: Dependencies,
): Promise<ProductionMaintenanceRoleLimitPrerequisitesVerification> {
  if (
    args.mode !== "role-limit"
    || args.deploymentRunId === null
    || args.deploymentReceiptFile === null
  ) fail("arguments_invalid");
  const deploymentRunId = args.deploymentRunId;
  const deploymentReceiptFile = args.deploymentReceiptFile;
  const base = `${GITHUB_API_ORIGIN}/repos/${REPOSITORY}`;
  const [currentValue, fenceValue, deploymentValue] = await Promise.all([
    githubJson(dependencies, `${base}/actions/runs/${currentRunId}`),
    githubJson(dependencies, `${base}/actions/runs/${args.fenceRunId}`),
    githubJson(dependencies, `${base}/actions/runs/${deploymentRunId}`),
  ]);
  const current = validateRun(currentValue, {
    runId: currentRunId,
    candidateSha: args.candidateSha,
    workflowPath: ROLE_LIMIT_WORKFLOW,
    workflowName: ROLE_LIMIT_WORKFLOW_NAME,
    status: "in_progress",
    conclusion: null,
  });
  const fence = validateRun(fenceValue, {
    runId: args.fenceRunId,
    candidateSha: args.candidateSha,
    workflowPath: FENCE_WORKFLOW,
    workflowName: FENCE_WORKFLOW_NAME,
    status: "completed",
    conclusion: "success",
    displayTitle:
      `Automatic maintenance worker fence | production | fence | ${args.candidateSha}`,
  });
  const deployment = validateRun(deploymentValue, {
    runId: deploymentRunId,
    candidateSha: args.candidateSha,
    workflowPath: DEPLOYMENT_WORKFLOW,
    workflowName: DEPLOYMENT_WORKFLOW_NAME,
    status: "completed",
    conclusion: "success",
  });
  const now = dependencies.now();
  const nowMs = now.getTime();
  if (
    fence.completedAtMs > deployment.startedAtMs
    || deployment.completedAtMs > current.startedAtMs
    || nowMs - fence.completedAtMs > MAXIMUM_RECEIPT_AGE_MS
    || nowMs - deployment.completedAtMs > MAXIMUM_RECEIPT_AGE_MS
    || current.startedAtMs > nowMs + MAXIMUM_CLOCK_SKEW_MS
  ) fail("chronology_invalid");

  const fenceArtifactName =
    `pintpath-automatic-maintenance-worker-fence-production-fence-${args.candidateSha}`;
  const deploymentArtifactName =
    `pintpath-production-deployment-${args.candidateSha}`;
  const historyStart = new Date(
    nowMs - MAXIMUM_RECEIPT_AGE_MS - MAXIMUM_CLOCK_SKEW_MS,
  ).toISOString();
  const window = `${historyStart}..${now.toISOString()}`;
  const [
    fenceArtifactValue,
    deploymentArtifactValue,
    fenceRuns,
    deploymentRuns,
    scaleRuns,
    roleLimitRuns,
  ] =
    await Promise.all([
      githubJson(
        dependencies,
        `${base}/actions/runs/${args.fenceRunId}/artifacts?name=${encodeURIComponent(fenceArtifactName)}&per_page=100`,
      ),
      githubJson(
        dependencies,
        `${base}/actions/runs/${deploymentRunId}/artifacts?name=${encodeURIComponent(deploymentArtifactName)}&per_page=100`,
      ),
      githubJson(
        dependencies,
        `${base}/actions/workflows/${FENCE_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
      ),
      githubJson(
        dependencies,
        `${base}/actions/workflows/${DEPLOYMENT_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
      ),
      githubJson(
        dependencies,
        `${base}/actions/workflows/${PRODUCTION_SCALE_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
      ),
      completeRoleLimitWorkflowHistory(dependencies, base, now),
    ]);
  const fenceArtifact = validateArtifact(
    fenceArtifactValue,
    args.fenceRunId,
    args.candidateSha,
    fenceArtifactName,
  );
  const deploymentArtifact = validateArtifact(
    deploymentArtifactValue,
    deploymentRunId,
    args.candidateSha,
    deploymentArtifactName,
  );
  validateRunListing(
    fenceRuns,
    (run) => typeof run.display_title === "string"
      && run.display_title.startsWith(
        "Automatic maintenance worker fence | production | ",
    ),
    args.fenceRunId,
    fence.startedAtMs,
  );
  validateNoRunAfter(scaleRuns, deployment.completedAtMs);
  validateRunListing(
    deploymentRuns,
    () => true,
    deploymentRunId,
    deployment.startedAtMs,
  );
  validateOneTimeRoleLimitApplyHistory(
    roleLimitRuns,
    currentRunId,
    args.candidateSha,
    now,
  );

  const fenceInput = parseCanonicalPrivateJson(
    args.fenceTerminalFile,
    dependencies.readPrivateFile,
    "fence_receipt_invalid",
  );
  const deploymentInput = parseCanonicalPrivateJson(
    deploymentReceiptFile,
    dependencies.readPrivateFile,
    "deployment_receipt_invalid",
  );
  await Promise.all([
    validateLocalReceiptAgainstArtifactArchive(
      dependencies,
      fenceArtifact,
      "automatic-maintenance-worker-fence-terminal.json",
      fenceInput.source,
    ),
    validateLocalReceiptAgainstArtifactArchive(
      dependencies,
      deploymentArtifact,
      "pintpath-production-deployment-evidence/deployment-receipt.json",
      deploymentInput.source,
    ),
  ]);
  const fenceReceipt = validateFenceTerminal(
    fenceInput.source,
    fenceInput.value,
    args.candidateSha,
  );
  const deploymentReceipt = validateDeploymentReceipt(
    deploymentInput.source,
    deploymentInput.value,
    args.candidateSha,
  );
  if (
    deploymentReceipt.workerFenceRunId !== args.fenceRunId
    || deploymentReceipt.workerFenceBindingSha256
      !== fenceReceipt.bindingSha256
    || deploymentReceipt.workerFenceTerminalSha256
      !== fenceReceipt.terminalSha256
    || deploymentReceipt.workerFenceDeploymentIdSha256
      !== fenceReceipt.deploymentAfterIdSha256
    || deploymentReceipt.startedAtMs
      < fence.completedAtMs - MAXIMUM_CLOCK_SKEW_MS
    || deploymentReceipt.startedAtMs
      < deployment.startedAtMs - MAXIMUM_CLOCK_SKEW_MS
    || deploymentReceipt.completedAtMs
      > deployment.completedAtMs + MAXIMUM_CLOCK_SKEW_MS
    || deploymentReceipt.completedAtMs > current.startedAtMs
  ) fail("chronology_invalid");

  const verifiedAt = dependencies.now();
  const verification: ProductionMaintenanceRoleLimitPrerequisitesVerification = {
    schemaVersion: PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_SCHEMA,
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    candidateSha: args.candidateSha,
    repository: REPOSITORY,
    consumer: {
      workflowPath: ROLE_LIMIT_WORKFLOW,
      githubEnvironment: ROLE_LIMIT_GITHUB_ENVIRONMENT,
      runId: currentRunId,
      runAttempt: 1,
      startedAt: current.startedAt,
    },
    workerFence: {
      workflowPath: FENCE_WORKFLOW,
      runId: args.fenceRunId,
      runAttempt: 1,
      startedAt: fence.startedAt,
      completedAt: fence.completedAt,
      artifactName: fenceArtifact.name,
      artifactId: fenceArtifact.id,
      artifactDigest: fenceArtifact.digest,
      artifactSizeBytes: fenceArtifact.sizeBytes,
      policySha256: FENCE_POLICY_SHA256,
      producerSha256: FENCE_PRODUCER_SHA256,
      producerWorkflowSha256: FENCE_WORKFLOW_SHA256,
      terminalSha256: fenceReceipt.terminalSha256,
      bindingSha256: fenceReceipt.bindingSha256,
      intentSha256: fenceReceipt.intentSha256,
    },
    productionDeployment: {
      workflowPath: DEPLOYMENT_WORKFLOW,
      runId: deploymentRunId,
      runAttempt: 1,
      startedAt: deployment.startedAt,
      completedAt: deployment.completedAt,
      artifactName: deploymentArtifact.name,
      artifactId: deploymentArtifact.id,
      artifactDigest: deploymentArtifact.digest,
      artifactSizeBytes: deploymentArtifact.sizeBytes,
      policySha256: DEPLOYMENT_POLICY_SHA256,
      producerSha256: DEPLOYMENT_PRODUCER_SHA256,
      producerWorkflowSha256: DEPLOYMENT_WORKFLOW_SHA256,
      receiptSha256: deploymentReceipt.receiptSha256,
      deploymentIdSha256: deploymentReceipt.deploymentIdSha256,
      replicaCount: deploymentReceipt.replicaCount,
    },
    verifiedAt: verifiedAt.toISOString(),
    expiresAt: new Date(
      verifiedAt.getTime() + MAXIMUM_VERIFICATION_AGE_MS,
    ).toISOString(),
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
  };
  parseVerificationObject(canonical(verification), {
    candidateSha: args.candidateSha,
    currentRunId,
    fenceRunId: args.fenceRunId,
    deploymentRunId,
    now: verifiedAt,
  });
  return verification;
}

async function verifyProductionDeploy(
  args: Arguments,
  currentRunId: string,
  dependencies: Dependencies,
): Promise<ProductionDeploymentWorkerFencePrerequisiteVerification> {
  if (
    args.mode !== "production-deploy"
    || args.deploymentRunId !== null
    || args.deploymentReceiptFile !== null
  ) fail("arguments_invalid");
  const base = `${GITHUB_API_ORIGIN}/repos/${REPOSITORY}`;
  const [currentValue, fenceValue] = await Promise.all([
    githubJson(dependencies, `${base}/actions/runs/${currentRunId}`),
    githubJson(dependencies, `${base}/actions/runs/${args.fenceRunId}`),
  ]);
  const current = validateRun(currentValue, {
    runId: currentRunId,
    candidateSha: args.candidateSha,
    workflowPath: DEPLOYMENT_WORKFLOW,
    workflowName: DEPLOYMENT_WORKFLOW_NAME,
    status: "in_progress",
    conclusion: null,
  });
  const fence = validateRun(fenceValue, {
    runId: args.fenceRunId,
    candidateSha: args.candidateSha,
    workflowPath: FENCE_WORKFLOW,
    workflowName: FENCE_WORKFLOW_NAME,
    status: "completed",
    conclusion: "success",
    displayTitle:
      `Automatic maintenance worker fence | production | fence | ${args.candidateSha}`,
  });
  const now = dependencies.now();
  const nowMs = now.getTime();
  if (
    fence.completedAtMs > current.startedAtMs
    || nowMs - fence.completedAtMs > MAXIMUM_RECEIPT_AGE_MS
    || current.startedAtMs > nowMs + MAXIMUM_CLOCK_SKEW_MS
  ) fail("chronology_invalid");

  const fenceArtifactName =
    `pintpath-automatic-maintenance-worker-fence-production-fence-${args.candidateSha}`;
  const historyStart = new Date(
    nowMs - MAXIMUM_RECEIPT_AGE_MS - MAXIMUM_CLOCK_SKEW_MS,
  ).toISOString();
  const window = `${historyStart}..${now.toISOString()}`;
  const [fenceArtifactValue, fenceRuns, deploymentRuns, scaleRuns] =
    await Promise.all([
    githubJson(
      dependencies,
      `${base}/actions/runs/${args.fenceRunId}/artifacts?name=${encodeURIComponent(fenceArtifactName)}&per_page=100`,
    ),
    githubJson(
      dependencies,
      `${base}/actions/workflows/${FENCE_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
    ),
    githubJson(
      dependencies,
      `${base}/actions/workflows/${DEPLOYMENT_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
    ),
    githubJson(
      dependencies,
      `${base}/actions/workflows/${PRODUCTION_SCALE_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
    ),
  ]);
  const fenceArtifact = validateArtifact(
    fenceArtifactValue,
    args.fenceRunId,
    args.candidateSha,
    fenceArtifactName,
  );
  validateRunListing(
    fenceRuns,
    (run) => typeof run.display_title === "string"
      && run.display_title.startsWith(
        "Automatic maintenance worker fence | production | ",
    ),
    args.fenceRunId,
    fence.startedAtMs,
  );
  validateNoRunAfter(scaleRuns, fence.completedAtMs);
  validateRunListing(
    deploymentRuns,
    () => true,
    currentRunId,
    fence.completedAtMs,
  );

  const fenceInput = parseCanonicalPrivateJson(
    args.fenceTerminalFile,
    dependencies.readPrivateFile,
    "fence_receipt_invalid",
  );
  const fenceReceipt = validateFenceTerminal(
    fenceInput.source,
    fenceInput.value,
    args.candidateSha,
  );
  await validateLocalReceiptAgainstArtifactArchive(
    dependencies,
    fenceArtifact,
    "automatic-maintenance-worker-fence-terminal.json",
    fenceInput.source,
  );
  const verifiedAt = dependencies.now();
  const verification: ProductionDeploymentWorkerFencePrerequisiteVerification = {
    schemaVersion: PRODUCTION_DEPLOYMENT_WORKER_FENCE_PREREQUISITE_SCHEMA,
    roleLimitPolicySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    workerFencePolicySha256: FENCE_POLICY_SHA256,
    productionDeploymentPolicySha256: DEPLOYMENT_POLICY_SHA256,
    candidateSha: args.candidateSha,
    repository: REPOSITORY,
    consumer: {
      workflowPath: DEPLOYMENT_WORKFLOW,
      githubEnvironment: "production-deployment",
      runId: currentRunId,
      runAttempt: 1,
      startedAt: current.startedAt,
    },
    workerFence: {
      workflowPath: FENCE_WORKFLOW,
      runId: args.fenceRunId,
      runAttempt: 1,
      startedAt: fence.startedAt,
      completedAt: fence.completedAt,
      artifactName: fenceArtifact.name,
      artifactId: fenceArtifact.id,
      artifactDigest: fenceArtifact.digest,
      artifactSizeBytes: fenceArtifact.sizeBytes,
      terminalSha256: fenceReceipt.terminalSha256,
      bindingSha256: fenceReceipt.bindingSha256,
      intentSha256: fenceReceipt.intentSha256,
      deploymentIdSha256: fenceReceipt.deploymentAfterIdSha256,
      producerSha256: FENCE_PRODUCER_SHA256,
      producerWorkflowSha256: FENCE_WORKFLOW_SHA256,
    },
    verifiedAt: verifiedAt.toISOString(),
    expiresAt: new Date(
      verifiedAt.getTime() + MAXIMUM_VERIFICATION_AGE_MS,
    ).toISOString(),
    checks: {
      policiesExact: true,
      consumerRunAuthorityExact: true,
      fenceRunAuthorityExact: true,
      fenceArtifactAuthorityExact: true,
      downloadActionPinExact: true,
      uniqueFenceReceiptExact: true,
      independentFenceArchiveDigestExact: true,
      localFenceReceiptBytesMatchArchiveExact: true,
      fenceReceiptExact: true,
      fenceWorkersDisabledExact: true,
      fenceCandidateBindingExact: true,
      fenceDeploymentUnchangedExact: true,
      chronologyExact: true,
      noLaterProductionWorkerFenceRunExact: true,
      noPriorProductionDeploymentRunExact: true,
      noProductionScaleRunAfterFenceExact: true,
      evidenceSecretFreeExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
  parseProductionDeploymentWorkerFencePrerequisiteVerification(
    canonical(verification),
    {
      candidateSha: args.candidateSha,
      currentRunId,
      fenceRunId: args.fenceRunId,
      now: verifiedAt,
    },
  );
  return verification;
}

async function verifyProductionActivate(
  args: Arguments,
  currentRunId: string,
  dependencies: Dependencies,
): Promise<ProductionActivationRoleLimitPrerequisiteVerification> {
  if (
    args.mode !== "production-activate"
    || args.roleLimitRunId === null
    || args.roleIntentFile === null
    || args.roleTerminalFile === null
    || args.roleReceiptFile === null
    || args.rolePrerequisitesFile === null
  ) fail("arguments_invalid");
  const roleRunId = args.roleLimitRunId;
  const base = `${GITHUB_API_ORIGIN}/repos/${REPOSITORY}`;
  const [currentValue, roleValue] = await Promise.all([
    githubJson(dependencies, `${base}/actions/runs/${currentRunId}`),
    githubJson(dependencies, `${base}/actions/runs/${roleRunId}`),
  ]);
  const current = validateRun(currentValue, {
    runId: currentRunId,
    candidateSha: args.candidateSha,
    workflowPath: FENCE_WORKFLOW,
    workflowName: FENCE_WORKFLOW_NAME,
    status: "in_progress",
    conclusion: null,
    displayTitle:
      `Automatic maintenance worker fence | production | activate | ${args.candidateSha}`,
  });
  const role = validateRun(roleValue, {
    runId: roleRunId,
    candidateSha: args.candidateSha,
    workflowPath: ROLE_LIMIT_WORKFLOW,
    workflowName: ROLE_LIMIT_WORKFLOW_NAME,
    status: "completed",
    conclusion: "success",
    displayTitle:
      `Production maintenance LOGIN limit | apply | ${args.candidateSha}`,
  });
  const now = dependencies.now();
  const nowMs = now.getTime();
  if (
    role.completedAtMs > current.startedAtMs
    || nowMs - role.completedAtMs > MAXIMUM_RECEIPT_AGE_MS
    || current.startedAtMs > nowMs + MAXIMUM_CLOCK_SKEW_MS
  ) fail("chronology_invalid");
  const artifactName =
    `pintpath-production-maintenance-role-limit-apply-${args.candidateSha}-${roleRunId}`;
  const historyStart = new Date(
    nowMs - MAXIMUM_RECEIPT_AGE_MS - MAXIMUM_CLOCK_SKEW_MS,
  ).toISOString();
  const window = `${historyStart}..${now.toISOString()}`;
  const [artifactValue, fenceRuns, deploymentRuns, roleRuns, scaleRuns] =
    await Promise.all([
      githubJson(
        dependencies,
        `${base}/actions/runs/${roleRunId}/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`,
      ),
      githubJson(
        dependencies,
        `${base}/actions/workflows/${FENCE_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
      ),
      githubJson(
        dependencies,
        `${base}/actions/workflows/${DEPLOYMENT_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
      ),
      githubJson(
        dependencies,
        `${base}/actions/workflows/${ROLE_LIMIT_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
      ),
      githubJson(
        dependencies,
        `${base}/actions/workflows/${PRODUCTION_SCALE_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
      ),
    ]);
  const artifact = validateArtifact(
    artifactValue,
    roleRunId,
    args.candidateSha,
    artifactName,
  );
  const terminalInput = parseCanonicalPrivateJson(
    args.roleTerminalFile,
    dependencies.readPrivateFile,
    "evidence_invalid",
  );
  const intentInput = parseCanonicalPrivateJson(
    args.roleIntentFile,
    dependencies.readPrivateFile,
    "evidence_invalid",
  );
  const receiptInput = parseCanonicalPrivateJson(
    args.roleReceiptFile,
    dependencies.readPrivateFile,
    "evidence_invalid",
  );
  const prerequisitesInput = parseCanonicalPrivateJson(
    args.rolePrerequisitesFile,
    dependencies.readPrivateFile,
    "evidence_invalid",
  );
  await validateLocalFilesAgainstArtifactArchive(dependencies, artifact, [
    { archivePath: "intent.json", source: intentInput.source },
    { archivePath: "terminal.json", source: terminalInput.source },
    { archivePath: "receipt.json", source: receiptInput.source },
    {
      archivePath: PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_FILENAME,
      source: prerequisitesInput.source,
    },
  ]);
  const nestedVerifiedAt = timestamp(
    prerequisitesInput.value.verifiedAt,
    "evidence_invalid",
  );
  const rolePrerequisites =
    parseProductionMaintenanceRoleLimitPrerequisitesVerification(
      prerequisitesInput.source,
      {
        candidateSha: args.candidateSha,
        currentRunId: roleRunId,
        fenceRunId: null,
        deploymentRunId: null,
        now: new Date(nestedVerifiedAt.milliseconds),
      },
    );
  const roleIntent = validatePriorRoleIntent(
    intentInput.source,
    intentInput.value,
    {
      candidateSha: args.candidateSha,
      priorRunId: roleRunId,
      prerequisitesSha256: sha256(prerequisitesInput.source),
    },
  );
  const roleEvidence = validateRoleLimitTerminalAndReceipt(
    terminalInput.source,
    terminalInput.value,
    receiptInput.source,
    receiptInput.value,
    {
      candidateSha: args.candidateSha,
      runId: roleRunId,
      prerequisitesSha256: sha256(prerequisitesInput.source),
      fenceRunId: rolePrerequisites.workerFence.runId,
      deploymentRunId: rolePrerequisites.productionDeployment.runId,
      runStartedAtMs: role.startedAtMs,
      runCompletedAtMs: role.completedAtMs,
    },
  );
  if (
    roleIntent.intentSha256 !== roleEvidence.intentSha256
    || roleIntent.fenceRunId !== rolePrerequisites.workerFence.runId
    || roleIntent.deploymentRunId
      !== rolePrerequisites.productionDeployment.runId
    || timestamp(rolePrerequisites.verifiedAt, "chronology_invalid").milliseconds
      > roleEvidence.startedAtMs + MAXIMUM_CLOCK_SKEW_MS
    || timestamp(rolePrerequisites.expiresAt, "chronology_invalid").milliseconds
      < roleEvidence.startedAtMs
  ) fail("chronology_invalid");
  validateRunListing(
    fenceRuns,
    (run) => typeof run.display_title === "string"
      && run.display_title.startsWith(
        "Automatic maintenance worker fence | production | ",
      ),
    currentRunId,
    timestamp(rolePrerequisites.workerFence.completedAt, "chronology_invalid")
      .milliseconds,
  );
  validateRunListing(
    deploymentRuns,
    () => true,
    rolePrerequisites.productionDeployment.runId,
    timestamp(rolePrerequisites.productionDeployment.startedAt, "chronology_invalid")
      .milliseconds,
  );
  validateRunListing(
    roleRuns,
    () => true,
    roleRunId,
    timestamp(rolePrerequisites.productionDeployment.completedAt, "chronology_invalid")
      .milliseconds,
  );
  validateNoRunAfter(
    scaleRuns,
    timestamp(rolePrerequisites.productionDeployment.completedAt, "chronology_invalid")
      .milliseconds,
  );
  const verification: ProductionActivationRoleLimitPrerequisiteVerification = {
    schemaVersion: PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_SCHEMA,
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    candidateSha: args.candidateSha,
    repository: REPOSITORY,
    consumer: {
      workflowPath: FENCE_WORKFLOW,
      githubEnvironment: "production-runtime-configuration",
      runId: currentRunId,
      runAttempt: 1,
      startedAt: current.startedAt,
    },
    roleLimit: {
      workflowPath: ROLE_LIMIT_WORKFLOW,
      runId: roleRunId,
      runAttempt: 1,
      startedAt: role.startedAt,
      completedAt: role.completedAt,
      artifactName: artifact.name,
      artifactId: artifact.id,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.sizeBytes,
      intentSha256: roleIntent.intentSha256,
      terminalSha256: roleEvidence.terminalSha256,
      receiptSha256: roleEvidence.receiptSha256,
      prerequisitesSha256: sha256(prerequisitesInput.source),
      outcome: roleEvidence.outcome,
    },
    rolePrerequisites,
    verifiedAt: now.toISOString(),
    expiresAt: new Date(nowMs + MAXIMUM_VERIFICATION_AGE_MS).toISOString(),
    checks: {
      policiesExact: true,
      consumerRunAuthorityExact: true,
      roleRunAuthorityExact: true,
      roleArtifactAuthorityExact: true,
      independentRoleArchiveDigestExact: true,
      localRoleFilesMatchArchiveExact: true,
      roleIntentExact: true,
      roleTerminalExact: true,
      fullFenceDeployRoleChainExact: true,
      chronologyExact: true,
      noLaterProductionWorkerRunExact: true,
      noLaterProductionDeploymentRunExact: true,
      noLaterRoleLimitRunExact: true,
      noProductionScaleRunAfterDeploymentExact: true,
      evidenceSecretFreeExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
  parseProductionActivationRoleLimitPrerequisiteVerification(
    canonical(verification),
    {
      candidateSha: args.candidateSha,
      currentRunId,
      roleLimitRunId: roleRunId,
      now,
    },
  );
  return verification;
}

async function verifyRoleLimitReconciliation(
  args: Arguments,
  currentRunId: string,
  dependencies: Dependencies,
): Promise<ProductionRoleLimitReconciliationAuthorityVerification> {
  if (
    args.mode !== "role-limit-reconcile"
    || args.priorRoleRunId === null
    || args.priorIntentFile === null
    || args.priorPrerequisitesFile === null
  ) fail("arguments_invalid");
  const priorRunId = args.priorRoleRunId;
  const base = `${GITHUB_API_ORIGIN}/repos/${REPOSITORY}`;
  const [currentValue, priorValue] = await Promise.all([
    githubJson(dependencies, `${base}/actions/runs/${currentRunId}`),
    githubJson(dependencies, `${base}/actions/runs/${priorRunId}`),
  ]);
  const current = validateRun(currentValue, {
    runId: currentRunId,
    candidateSha: args.candidateSha,
    workflowPath: ROLE_LIMIT_WORKFLOW,
    workflowName: ROLE_LIMIT_WORKFLOW_NAME,
    status: "in_progress",
    conclusion: null,
    displayTitle:
      `Production maintenance LOGIN limit | reconcile | ${args.candidateSha}`,
  });
  const prior = validatePriorRoleApplyRun(
    priorValue,
    priorRunId,
    args.candidateSha,
  );
  const now = dependencies.now();
  const nowMs = now.getTime();
  if (
    prior.completedAtMs > current.startedAtMs
    || nowMs - prior.completedAtMs > 2_592_000_000
    || current.startedAtMs > nowMs + MAXIMUM_CLOCK_SKEW_MS
  ) fail("chronology_invalid");
  const artifactName =
    `pintpath-production-maintenance-role-limit-intent-${args.candidateSha}-${priorRunId}`;
  const historyStart = new Date(
    nowMs - 2_592_000_000 - MAXIMUM_CLOCK_SKEW_MS,
  ).toISOString();
  const window = `${historyStart}..${now.toISOString()}`;
  const [artifactValue, roleRuns] = await Promise.all([
    githubJson(
      dependencies,
      `${base}/actions/runs/${priorRunId}/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`,
    ),
    githubJson(
      dependencies,
      `${base}/actions/workflows/${ROLE_LIMIT_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
    ),
  ]);
  const artifact = validateArtifact(
    artifactValue,
    priorRunId,
    args.candidateSha,
    artifactName,
  );
  validateReconciliationRoleRunListing(
    roleRuns,
    priorRunId,
    currentRunId,
    prior.completedAtMs,
  );
  const intentInput = parseCanonicalPrivateJson(
    args.priorIntentFile,
    dependencies.readPrivateFile,
    "evidence_invalid",
  );
  const prerequisitesInput = parseCanonicalPrivateJson(
    args.priorPrerequisitesFile,
    dependencies.readPrivateFile,
    "evidence_invalid",
  );
  await validateLocalFilesAgainstArtifactArchive(dependencies, artifact, [
    { archivePath: "intent.json", source: intentInput.source },
    {
      archivePath: PRODUCTION_MAINTENANCE_ROLE_LIMIT_PREREQUISITES_FILENAME,
      source: prerequisitesInput.source,
    },
  ]);
  const intent = validatePriorRoleIntent(
    intentInput.source,
    intentInput.value,
    {
      candidateSha: args.candidateSha,
      priorRunId,
      prerequisitesSha256: sha256(prerequisitesInput.source),
    },
  );
  const nestedVerifiedAt = timestamp(
    prerequisitesInput.value.verifiedAt,
    "evidence_invalid",
  );
  parseProductionMaintenanceRoleLimitPrerequisitesVerification(
    prerequisitesInput.source,
    {
      candidateSha: args.candidateSha,
      currentRunId: priorRunId,
      fenceRunId: intent.fenceRunId,
      deploymentRunId: intent.deploymentRunId,
      now: new Date(nestedVerifiedAt.milliseconds),
    },
  );
  const verification: ProductionRoleLimitReconciliationAuthorityVerification = {
    schemaVersion: PRODUCTION_ROLE_LIMIT_RECONCILIATION_AUTHORITY_SCHEMA,
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    candidateSha: args.candidateSha,
    repository: REPOSITORY,
    consumer: {
      workflowPath: ROLE_LIMIT_WORKFLOW,
      githubEnvironment: ROLE_LIMIT_GITHUB_ENVIRONMENT,
      runId: currentRunId,
      runAttempt: 1,
      startedAt: current.startedAt,
    },
    priorApply: {
      workflowPath: ROLE_LIMIT_WORKFLOW,
      runId: priorRunId,
      runAttempt: 1,
      conclusion: prior.conclusion,
      startedAt: prior.startedAt,
      completedAt: prior.completedAt,
      artifactName: artifact.name,
      artifactId: artifact.id,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.sizeBytes,
      intentSha256: intent.intentSha256,
      prerequisitesSha256: sha256(prerequisitesInput.source),
    },
    verifiedAt: now.toISOString(),
    expiresAt: new Date(nowMs + MAXIMUM_VERIFICATION_AGE_MS).toISOString(),
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
  };
  parseProductionRoleLimitReconciliationAuthorityVerification(
    canonical(verification),
    {
      candidateSha: args.candidateSha,
      currentRunId,
      priorRoleRunId: priorRunId,
      now,
    },
  );
  return verification;
}

async function verifyProductionScale(
  args: Arguments,
  currentRunId: string,
  dependencies: Dependencies,
): Promise<ProductionScaleActivationPrerequisiteVerification> {
  if (
    args.mode !== "production-scale"
    || args.activateRunId === null
    || args.activateTerminalFile === null
    || args.activationPrerequisitesFile === null
  ) fail("arguments_invalid");
  const activateRunId = args.activateRunId;
  const base = `${GITHUB_API_ORIGIN}/repos/${REPOSITORY}`;
  const [currentValue, activateValue] = await Promise.all([
    githubJson(dependencies, `${base}/actions/runs/${currentRunId}`),
    githubJson(dependencies, `${base}/actions/runs/${activateRunId}`),
  ]);
  const current = validateRun(currentValue, {
    runId: currentRunId,
    candidateSha: args.candidateSha,
    workflowPath: PRODUCTION_SCALE_WORKFLOW,
    workflowName: PRODUCTION_SCALE_WORKFLOW_NAME,
    status: "in_progress",
    conclusion: null,
  });
  const activation = validateRun(activateValue, {
    runId: activateRunId,
    candidateSha: args.candidateSha,
    workflowPath: FENCE_WORKFLOW,
    workflowName: FENCE_WORKFLOW_NAME,
    status: "completed",
    conclusion: "success",
    displayTitle:
      `Automatic maintenance worker fence | production | activate | ${args.candidateSha}`,
  });
  const now = dependencies.now();
  const nowMs = now.getTime();
  if (
    activation.completedAtMs > current.startedAtMs
    || nowMs - activation.completedAtMs > MAXIMUM_RECEIPT_AGE_MS
    || current.startedAtMs > nowMs + MAXIMUM_CLOCK_SKEW_MS
  ) fail("chronology_invalid");
  const artifactName =
    `pintpath-automatic-maintenance-worker-fence-production-activate-${args.candidateSha}`;
  const historyStart = new Date(
    nowMs - MAXIMUM_RECEIPT_AGE_MS - MAXIMUM_CLOCK_SKEW_MS,
  ).toISOString();
  const window = `${historyStart}..${now.toISOString()}`;
  const [artifactValue, fenceRuns, deploymentRuns, roleRuns, scaleRuns] =
    await Promise.all([
      githubJson(
        dependencies,
        `${base}/actions/runs/${activateRunId}/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`,
      ),
      githubJson(
        dependencies,
        `${base}/actions/workflows/${FENCE_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
      ),
      githubJson(
        dependencies,
        `${base}/actions/workflows/${DEPLOYMENT_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
      ),
      githubJson(
        dependencies,
        `${base}/actions/workflows/${ROLE_LIMIT_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
      ),
      githubJson(
        dependencies,
        `${base}/actions/workflows/${PRODUCTION_SCALE_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&created=${encodeURIComponent(window)}&per_page=100`,
      ),
    ]);
  const artifact = validateArtifact(
    artifactValue,
    activateRunId,
    args.candidateSha,
    artifactName,
  );
  const terminalInput = parseCanonicalPrivateJson(
    args.activateTerminalFile,
    dependencies.readPrivateFile,
    "evidence_invalid",
  );
  const prerequisitesInput = parseCanonicalPrivateJson(
    args.activationPrerequisitesFile,
    dependencies.readPrivateFile,
    "evidence_invalid",
  );
  await validateLocalFilesAgainstArtifactArchive(dependencies, artifact, [
    {
      archivePath: "automatic-maintenance-worker-fence-terminal.json",
      source: terminalInput.source,
    },
    {
      archivePath: PRODUCTION_ACTIVATION_ROLE_LIMIT_PREREQUISITE_FILENAME,
      source: prerequisitesInput.source,
    },
  ]);
  const nestedVerifiedAt = timestamp(
    prerequisitesInput.value.verifiedAt,
    "evidence_invalid",
  );
  const roleRunId = String(
    record(prerequisitesInput.value.roleLimit)
      ? prerequisitesInput.value.roleLimit.runId
      : "",
  );
  if (!RUN_ID_PATTERN.test(roleRunId)) fail("evidence_invalid");
  const activationPrerequisites =
    parseProductionActivationRoleLimitPrerequisiteVerification(
      prerequisitesInput.source,
      {
        candidateSha: args.candidateSha,
        currentRunId: activateRunId,
        roleLimitRunId: roleRunId,
        now: new Date(nestedVerifiedAt.milliseconds),
      },
    );
  const activationTerminal = validateActivateTerminal(
    terminalInput.source,
    terminalInput.value,
    args.candidateSha,
  );
  if (
    activationTerminal.deploymentBeforeIdSha256
      !== activationPrerequisites.rolePrerequisites.productionDeployment
        .deploymentIdSha256
    || activationTerminal.deploymentAfterIdSha256
      !== activationTerminal.runtimeDeploymentIdSha256
  ) fail("chronology_invalid");
  validateRunListing(
    fenceRuns,
    (run) => typeof run.display_title === "string"
      && run.display_title.startsWith(
        "Automatic maintenance worker fence | production | ",
      ),
    activateRunId,
    timestamp(
      activationPrerequisites.rolePrerequisites.workerFence.completedAt,
      "chronology_invalid",
    ).milliseconds,
  );
  validateRunListing(
    deploymentRuns,
    () => true,
    activationPrerequisites.rolePrerequisites.productionDeployment.runId,
    timestamp(
      activationPrerequisites.rolePrerequisites.productionDeployment.startedAt,
      "chronology_invalid",
    ).milliseconds,
  );
  validateRunListing(
    roleRuns,
    () => true,
    roleRunId,
    timestamp(
      activationPrerequisites.rolePrerequisites.productionDeployment.completedAt,
      "chronology_invalid",
    ).milliseconds,
  );
  validateRunListing(
    scaleRuns,
    () => true,
    currentRunId,
    activation.completedAtMs,
  );
  const verification: ProductionScaleActivationPrerequisiteVerification = {
    schemaVersion: PRODUCTION_SCALE_ACTIVATION_PREREQUISITE_SCHEMA,
    policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
    candidateSha: args.candidateSha,
    repository: REPOSITORY,
    consumer: {
      workflowPath: PRODUCTION_SCALE_WORKFLOW,
      githubEnvironment: "production-topology-configuration",
      runId: currentRunId,
      runAttempt: 1,
      startedAt: current.startedAt,
    },
    activation: {
      workflowPath: FENCE_WORKFLOW,
      runId: activateRunId,
      runAttempt: 1,
      startedAt: activation.startedAt,
      completedAt: activation.completedAt,
      artifactName: artifact.name,
      artifactId: artifact.id,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.sizeBytes,
      terminalSha256: activationTerminal.terminalSha256,
      prerequisitesSha256: sha256(prerequisitesInput.source),
      deploymentBeforeIdSha256:
        activationTerminal.deploymentBeforeIdSha256,
      deploymentAfterIdSha256:
        activationTerminal.deploymentAfterIdSha256,
    },
    activationPrerequisites,
    verifiedAt: now.toISOString(),
    expiresAt: new Date(nowMs + MAXIMUM_VERIFICATION_AGE_MS).toISOString(),
    checks: {
      policiesExact: true,
      consumerRunAuthorityExact: true,
      activationRunAuthorityExact: true,
      activationArtifactAuthorityExact: true,
      independentActivationArchiveDigestExact: true,
      localActivationFilesMatchArchiveExact: true,
      activationTerminalExact: true,
      fullRoleActivateChainExact: true,
      chronologyExact: true,
      noLaterProductionWorkerRunExact: true,
      noLaterProductionDeploymentRunExact: true,
      noLaterRoleLimitRunExact: true,
      noPriorOrConcurrentScaleRunExact: true,
      evidenceSecretFreeExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
  parseProductionScaleActivationPrerequisiteVerification(
    canonical(verification),
    {
      candidateSha: args.candidateSha,
      currentRunId,
      activateRunId,
      now,
    },
  );
  return verification;
}

function defaultReadPrivateFile(filename: string): Buffer {
  return readTrustedRegularFile(filename, {
    minBytes: 1,
    maxBytes: MAXIMUM_EVIDENCE_BYTES,
    requireOwner: true,
    requirePrivate: true,
  });
}

function defaultWriteEvidence(filename: string, source: string): void {
  const directory = path.dirname(filename);
  const held = holdPrivateDirectoryIdentity(directory, {
    requireExactDirectoryMode: true,
    requireOwner: true,
  });
  let closed = false;
  try {
    held.assertExact();
    const identity = held.identity;
    held.close();
    closed = true;
    writePrivateExclusiveFile(directory, path.basename(filename), source, {
      requireExactDirectoryMode: true,
      requireOwner: true,
      expectedDirectoryIdentity: identity,
    });
  } catch {
    if (!closed) held.close();
    fail("evidence_invalid");
  }
}

export async function runProductionMaintenanceRoleLimitPrerequisiteVerifier(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    now: () => new Date(),
    readPrivateFile: defaultReadPrivateFile,
    writeEvidence: defaultWriteEvidence,
    writeOutput: (source) => process.stdout.write(source),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    ...overrides,
  };
  try {
    const args = parseArguments(dependencies.argv);
    validatePolicies(dependencies.cwd);
    const currentRunId = validateEnvironment(args, dependencies.env);
    const verification = args.mode === "role-limit"
      ? await verifyRoleLimit(args, currentRunId, dependencies)
      : args.mode === "role-limit-reconcile"
        ? await verifyRoleLimitReconciliation(args, currentRunId, dependencies)
      : args.mode === "production-deploy"
        ? await verifyProductionDeploy(args, currentRunId, dependencies)
        : args.mode === "production-activate"
          ? await verifyProductionActivate(args, currentRunId, dependencies)
          : await verifyProductionScale(args, currentRunId, dependencies);
    const source = canonical(verification);
    dependencies.writeEvidence(args.output, source);
    dependencies.writeOutput(`${JSON.stringify({
      ok: true,
      candidateSha: args.candidateSha,
      policySha256: PRODUCTION_MAINTENANCE_ROLE_LIMIT_POLICY_SHA256,
      mode: args.mode,
      fenceRunId: args.fenceRunId === "" ? null : args.fenceRunId,
      deploymentRunId: args.deploymentRunId,
      priorRoleRunId: args.priorRoleRunId,
      roleLimitRunId: args.roleLimitRunId,
      activateRunId: args.activateRunId,
      verificationSha256: sha256(source),
      expiresAt: verification.expiresAt,
      secretMaterialIncluded: false,
    })}\n`);
    return 0;
  } catch (error) {
    dependencies.writeOutput(`${JSON.stringify({
      ok: false,
      failureCode: error instanceof PrerequisiteError
        ? error.code
        : "evidence_invalid",
      productionContactAttempted: false,
      secretMaterialIncluded: false,
    })}\n`);
    return 1;
  }
}

export const productionMaintenanceRoleLimitPrerequisiteInternals = {
  parseArguments,
  validatePolicies,
  validateEnvironment,
  validateRun,
  validateArtifact,
  validateFenceTerminal,
  validateDeploymentReceipt,
  validateRunListing,
};

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runProductionMaintenanceRoleLimitPrerequisiteVerifier();
}
