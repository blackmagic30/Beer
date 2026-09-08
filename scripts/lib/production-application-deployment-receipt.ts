import crypto from "node:crypto";

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

function canonicalKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalKeyOrder);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    canonicalKeyOrder(value[key]),
  ]));
}

function recursivelyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalKeyOrder(left))
    === JSON.stringify(canonicalKeyOrder(right));
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function nullableReplicaCount(value: unknown): boolean {
  return value === null || (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 50
  );
}

function productionTopologyEvidence(value: unknown): value is Json {
  if (!exact(value, [
    "configuredReplicas",
    "configuredRegions",
    "configuredTopologySha256",
  ])
    || (value.configuredReplicas !== 1 && value.configuredReplicas !== 2)
    || !Array.isArray(value.configuredRegions)
    || value.configuredRegions.length !== 1
    || !exact(value.configuredRegions[0], ["region", "numReplicas"])
    || value.configuredRegions[0].region !== "asia-southeast1-eqsg3a"
    || value.configuredRegions[0].numReplicas !== value.configuredReplicas
    || !sha256(value.configuredTopologySha256)) return false;
  return crypto.createHash("sha256").update(`${JSON.stringify(canonicalKeyOrder({
    configuredReplicas: value.configuredReplicas,
    configuredRegions: value.configuredRegions,
  }), null, 2)}\n`).digest("hex") === value.configuredTopologySha256;
}

function productionTopologyChain(value: unknown): boolean {
  if (!exact(value, [
    "authoritativeSource",
    "before",
    "immediatelyBeforeWrite",
    "after",
  ])
    || value.authoritativeSource
      !== "environment.config(decryptVariables:false)"
    || !productionTopologyEvidence(value.before)
    || !productionTopologyEvidence(value.immediatelyBeforeWrite)
    || !productionTopologyEvidence(value.after)) return false;
  return recursivelyEqual(value.before, value.immediatelyBeforeWrite)
    && recursivelyEqual(value.before, value.after);
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
    "legacyReplicaCounts", "configuredTopology", "runtimeAbsence",
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
    || value.collateralSnapshotSha256s.after
      !== value.collateralSnapshotSha256s.before
    || !exact(value.replicaCounts, ["before", "after"])
    || (value.replicaCounts.after !== 1 && value.replicaCounts.after !== 2)
    || value.replicaCounts.before !== value.replicaCounts.after
    || !exact(value.legacyReplicaCounts, [
      "before", "immediatelyBeforeWrite", "after",
    ])
    || !nullableReplicaCount(value.legacyReplicaCounts.before)
    || !nullableReplicaCount(value.legacyReplicaCounts.immediatelyBeforeWrite)
    || !nullableReplicaCount(value.legacyReplicaCounts.after)
    || !productionTopologyChain(value.configuredTopology)
    || !object(value.configuredTopology)
    || !object(value.configuredTopology.after)
    || value.configuredTopology.after.configuredReplicas
      !== value.replicaCounts.after
    || !exact(value.runtimeAbsence, [
      "required", "immediatelyBeforeWrite", "postflight",
    ])
    || value.runtimeAbsence.required !== false
    || value.runtimeAbsence.immediatelyBeforeWrite !== null
    || value.runtimeAbsence.postflight !== null
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
      "boundaryPreflightExact", "targetPreflightExact", "configuredTopologyExact",
      "immediatePrewriteExact", "fencedRuntimeAbsentBeforeWrite",
      "fencedRuntimeAbsentPostflight", "gitAutodeployAbsent",
      "collateralInventoryExact", "durableIntentExact", "sourceReasserted",
      "writeAttemptedAtMostOnce", "targetPostflightAttempted", "targetPostflightExact",
      "reconciliationCompleted", "topologyPreserved", "deploymentExact",
      "runtimeHealthExact", "runtimeStartupExact", "runtimeReadinessExact",
      "collateralStateUnchanged", "boundaryPostflightExact", "terminalEvidenceExact",
    ])
    || Object.values(value.checks).some((check) => check !== true)
    || (value.outcome === "already_deployed"
      ? value.writeAttempts !== 0 || value.acknowledgement !== "not_attempted"
        || value.deploymentIdSha256 !== value.previousDeploymentIdSha256
      : value.writeAttempts !== 1
        || value.deploymentIdSha256 === value.previousDeploymentIdSha256)
    || (value.outcome === "deployed" && value.acknowledgement !== "received")
    || (value.outcome === "reconciled_success"
      && value.acknowledgement !== "missing_or_failed")) return null;
  return {
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    deploymentIdSha256: value.deploymentIdSha256,
  };
}
