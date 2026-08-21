import { PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA } from
  "./permanent-staging-app-deployment-executor.js";

const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[1-9][0-9]*$/;

type Json = Record<string, unknown>;

export interface ProductionApplicationDeploymentReceiptAuthority {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly deploymentIdSha256: string;
}

function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Json {
  return object(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

export function parseProductionApplicationDeploymentReceipt(
  value: unknown,
  candidateSha: string,
): ProductionApplicationDeploymentReceiptAuthority | null {
  if (!SHA.test(candidateSha) || !exact(value, [
    "schemaVersion", "operation", "executorState", "target", "outcome",
    "failureCode", "candidateSha", "startedAt", "completedAt", "writeAttempts",
    "acknowledgement", "previousDeploymentIdSha256", "deploymentIdSha256",
    "intentSha256", "cliOutputSha256", "boundaryPreflightSha256",
    "boundaryPostflightSha256", "collateralSnapshotSha256s", "replicaCounts",
    "runtimeResponseSha256s", "workerFencePrerequisite", "checks",
  ])
    || value.schemaVersion !== PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA
    || value.operation !== "pintpath-railway-application-source-upload"
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || value.target !== "production"
    || !["deployed", "already_deployed", "reconciled_success"].includes(
      String(value.outcome),
    )
    || value.failureCode !== null
    || value.candidateSha !== candidateSha
    || !timestamp(value.startedAt)
    || !timestamp(value.completedAt)
    || Date.parse(value.completedAt) < Date.parse(value.startedAt)
    || (value.writeAttempts !== 0 && value.writeAttempts !== 1)
    || !["not_attempted", "received", "missing_or_failed"].includes(
      String(value.acknowledgement),
    )
    || !sha256(value.previousDeploymentIdSha256)
    || !sha256(value.deploymentIdSha256)
    || !sha256(value.intentSha256)
    || !sha256(value.boundaryPreflightSha256)
    || !sha256(value.boundaryPostflightSha256)
    || (value.writeAttempts === 0
      ? value.cliOutputSha256 !== null
      : !sha256(value.cliOutputSha256))
    || !exact(value.collateralSnapshotSha256s, ["before", "after"])
    || !sha256(value.collateralSnapshotSha256s.before)
    || !sha256(value.collateralSnapshotSha256s.after)
    || !exact(value.replicaCounts, ["before", "after"])
    || (value.replicaCounts.after !== 1 && value.replicaCounts.after !== 2)
    || value.replicaCounts.before !== value.replicaCounts.after
    || !exact(value.runtimeResponseSha256s, ["health", "startup", "ready"])
    || !sha256(value.runtimeResponseSha256s.health)
    || !sha256(value.runtimeResponseSha256s.startup)
    || !sha256(value.runtimeResponseSha256s.ready)
    || !exact(value.workerFencePrerequisite, [
      "runId", "verificationSha256", "bindingSha256", "terminalSha256",
      "deploymentIdSha256",
    ])
    || typeof value.workerFencePrerequisite.runId !== "string"
    || !RUN_ID.test(value.workerFencePrerequisite.runId)
    || !sha256(value.workerFencePrerequisite.verificationSha256)
    || !sha256(value.workerFencePrerequisite.bindingSha256)
    || !sha256(value.workerFencePrerequisite.terminalSha256)
    || value.workerFencePrerequisite.deploymentIdSha256
      !== value.previousDeploymentIdSha256
    || !exact(value.checks, [
      "policyExact", "githubMainExact", "sourceAuthorityExact", "cliExact",
      "writeTokenScopeExact", "costPolicyExact", "prerequisiteExact",
      "workerFencePrerequisiteExact", "workerFenceDeploymentContinuityExact",
      "boundaryPreflightExact", "targetPreflightExact", "gitAutodeployAbsent",
      "collateralInventoryExact", "durableIntentExact", "sourceReasserted",
      "writeAttemptedAtMostOnce", "targetPostflightAttempted", "targetPostflightExact",
      "reconciliationCompleted", "topologyPreserved", "deploymentExact",
      "runtimeHealthExact", "runtimeStartupExact", "runtimeReadinessExact",
      "collateralStateUnchanged", "boundaryPostflightExact", "terminalEvidenceExact",
    ])
    || Object.values(value.checks).some((check) => check !== true)
    || (value.outcome === "already_deployed"
      ? value.writeAttempts !== 0 || value.acknowledgement !== "not_attempted"
      : value.writeAttempts !== 1)
    || (value.outcome === "deployed" && value.acknowledgement !== "received")
    || (value.outcome === "reconciled_success"
      && value.acknowledgement !== "missing_or_failed")) return null;
  return {
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    deploymentIdSha256: value.deploymentIdSha256,
  };
}
