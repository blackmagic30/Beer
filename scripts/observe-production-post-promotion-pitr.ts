import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import { parsePostgresLogicalBackupManifest } from "../src/lib/postgres-logical-restore.js";
import { sha256ProductionPromotionRecoveryValue } from
  "../src/lib/production-promotion-recovery.js";
import {
  POSTGRES_HA_PITR_HEALTH,
  POSTGRES_HA_PITR_INVENTORY,
  POSTGRES_HA_PITR_PROGRESS,
  POSTGRES_HA_PITR_SCOPE,
  protectedPostgresHaPitrInternals,
} from "./execute-protected-postgres-ha-pitr.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";
import { parseProductionApplicationDeploymentReceipt } from
  "./lib/production-application-deployment-receipt.js";

export const PRODUCTION_POST_PROMOTION_PITR_OBSERVATION_SCHEMA =
  "pintpath-production-post-promotion-pitr-observation/v1" as const;

const ARGUMENTS = new Set([
  "--candidate-sha", "--production-deployment-receipt",
  "--production-scale-receipt",
  "--closed-route-receipt",
  "--logical-backup-manifest", "--output",
]);
const CANDIDATE = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[^\r\n\0]{16,4096}$/;
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const MAX_INPUT_BYTES = 128 * 1024 * 1024;

type Json = Record<string, unknown>;

export class ProductionPostPromotionPitrObservationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProductionPostPromotionPitrObservationError";
  }
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl: typeof fetch;
  readonly getUid: () => number | null;
  readonly now: () => Date;
  readonly writeOutput: (source: string) => void;
}

function fail(code: string): never {
  throw new ProductionPostPromotionPitrObservationError(code);
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Json {
  return isObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function absolute(value: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    fail("arguments_invalid");
  }
  return value;
}

function readPrivate(filename: string, uid: number): Buffer {
  const resolved = absolute(filename);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    const pathname = fs.lstatSync(resolved, { bigint: true });
    if (
      !before.isFile() || !pathname.isFile() || pathname.isSymbolicLink()
      || before.uid !== BigInt(uid) || pathname.uid !== BigInt(uid)
      || Number(before.mode & 0o7777n) !== 0o600
      || Number(pathname.mode & 0o7777n) !== 0o600
      || before.nlink !== 1n || pathname.nlink !== 1n
      || before.dev !== pathname.dev || before.ino !== pathname.ino
      || before.size < 2n || before.size > BigInt(MAX_INPUT_BYTES)
      || fs.realpathSync(resolved) !== resolved
    ) fail("evidence_file_unsafe");
    const source = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(resolved, { bigint: true });
    if (
      after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || afterPath.dev !== before.dev || afterPath.ino !== before.ino
      || afterPath.mtimeNs !== before.mtimeNs || afterPath.ctimeNs !== before.ctimeNs
    ) fail("evidence_file_drift");
    return source;
  } catch (error) {
    if (error instanceof ProductionPostPromotionPitrObservationError) throw error;
    return fail("evidence_file_unsafe");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function parseCanonical(source: Buffer): Json {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source));
  } catch {
    fail("evidence_invalid");
  }
  if (!isObject(value) || canonicalPostgresBackupJson(value) !== source.toString("utf8")) {
    fail("evidence_invalid");
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") fail("provider_invalid");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("provider_invalid");
  }
  return value;
}

function finalDeploymentFromScale(
  value: Json,
  candidateSha: string,
  deploymentIdSha256: string,
  deploymentCompletedAt: string,
): string {
  const checks = value.checks;
  const prerequisite = value.productionActivationPrerequisite;
  const attempts = value.attempts;
  const checkKeys = [
    "policyExact", "githubAuthorityExact", "tokenScopesExact", "cliExact",
    "boundaryPreflightExact", "targetPreflightExact",
    "productionActivationPrerequisiteExact",
    "productionActivationDeploymentContinuityExact", "runtimePreflightExact",
    "durableIntentExact", "repositoryPrewriteReasserted",
    "writeAttemptedAtMostOnce", "acknowledgementExact", "postflightAttempted",
    "targetPostflightExact", "runtimePostflightExact", "candidateUnchanged",
    "deploymentUnchanged", "boundaryPostflightExact", "terminalEvidenceExact",
    "finalReceiptEvidenceExact",
  ];
  if (
    !exactKeys(value, [
      "schemaVersion", "executorState", "direction", "outcome", "candidateSha",
      "startedAt", "completedAt", "desiredReplicas", "deploymentIdSha256",
      "attempts", "retryAllowed", "intentSha256", "terminalEvidenceSha256",
      "commandStdoutSha256", "commandStderrSha256",
      "productionActivationPrerequisite", "checks",
    ])
    || value.schemaVersion !== "pintpath-permanent-staging-scale-operation/v2"
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || value.direction !== "converge-production-two"
    || !["scaled", "already_converged"].includes(String(value.outcome))
    || value.candidateSha !== candidateSha
    || value.desiredReplicas !== 2
    || typeof value.deploymentIdSha256 !== "string"
    || !SHA256.test(value.deploymentIdSha256)
    || value.retryAllowed !== false
    || (attempts !== 0 && attempts !== 1)
    || typeof value.terminalEvidenceSha256 !== "string"
    || !SHA256.test(value.terminalEvidenceSha256)
    || (attempts === 0
      ? value.intentSha256 !== null
        || value.commandStdoutSha256 !== null
        || value.commandStderrSha256 !== null
      : typeof value.intentSha256 !== "string" || !SHA256.test(value.intentSha256)
        || typeof value.commandStdoutSha256 !== "string"
        || !SHA256.test(value.commandStdoutSha256)
        || typeof value.commandStderrSha256 !== "string"
        || !SHA256.test(value.commandStderrSha256))
    || !exactKeys(prerequisite, [
      "runId", "verificationSha256", "terminalSha256", "prerequisitesSha256",
      "deploymentBeforeIdSha256", "deploymentAfterIdSha256",
    ])
    || typeof prerequisite.runId !== "string"
    || !/^[1-9][0-9]*$/.test(prerequisite.runId)
    || [prerequisite.verificationSha256, prerequisite.terminalSha256,
      prerequisite.prerequisitesSha256].some(
      (entry) => typeof entry !== "string" || !SHA256.test(entry),
    )
    || prerequisite.deploymentBeforeIdSha256 !== deploymentIdSha256
    || prerequisite.deploymentAfterIdSha256 !== value.deploymentIdSha256
    || prerequisite.deploymentAfterIdSha256 === prerequisite.deploymentBeforeIdSha256
    || !exactKeys(checks, checkKeys)
    || Object.entries(checks).some(([name, entry]) => (
      name === "durableIntentExact" ? entry !== (attempts === 1) : entry !== true
    ))
    || (value.outcome === "scaled") !== (attempts === 1)
  ) fail("deployment_invalid");
  const startedAt = timestamp(value.startedAt);
  const completedAt = timestamp(value.completedAt);
  if (
    Date.parse(startedAt) < Date.parse(deploymentCompletedAt)
    || Date.parse(completedAt) < Date.parse(startedAt)
  ) fail("deployment_invalid");
  return value.deploymentIdSha256;
}

function verifyClosedRouteForCapture(
  value: Json,
  candidateSha: string,
  deploymentIdSha256: string,
  deploymentReceiptSha256: string,
  scaleReceiptSha256: string,
  scaleCompletedAt: string,
): void {
  const checks = value.checks;
  const artifactDigest = /^sha256:[a-f0-9]{64}$/;
  const checkKeys = [
    "policyExact", "githubAuthorityExact", "repositoryAuthorityExact",
    "predecessorAuthorityExact", "predecessorReceiptsExact",
    "promotionRecoveryAuthorityExact", "credentialsExact", "tokenScopesExact",
    "patchPreflightEmpty", "inventoryPreflightExact", "candidateDeploymentPreflightExact",
    "boundaryPreflightExact", "durableIntentExact", "repositoryPrewriteReasserted",
    "providerPrewriteReasserted", "writeAttemptedAtMostOnce", "acknowledgementExact",
    "postflightAttempted", "patchPostflightEmpty", "inventoryTransitionExact",
    "candidateDeploymentPostflightExact", "boundaryPostflightExact",
    "publicRuntimePostflightExact", "terminalEvidenceExact", "finalReceiptEvidenceExact",
  ];
  if (
    !exactKeys(value, [
      "schemaVersion", "executorState", "outcome", "operation", "candidateSha",
      "startedAt", "completedAt", "githubEnvironment", "policySha256",
      "projectIdSha256", "environmentIdSha256", "serviceIdSha256", "domain",
      "targetPort", "routeIdSha256", "deploymentIdSha256",
      "predecessorAuthoritySha256", "orderedProductionChainSha256",
      "productionDeploymentArtifactDigest", "productionScaleArtifactDigest",
      "closedRouteArtifactDigest", "promotionRecoveryArtifactDigest",
      "promotionRecoveryReceiptSha256", "productionDeploymentReceiptSha256",
      "productionScaleReceiptSha256", "closedRouteReceiptSha256", "attempts",
      "retryAllowed", "intentSha256", "terminalEvidenceSha256",
      "beforeInventorySha256", "afterInventorySha256", "checks",
    ])
    || value.schemaVersion !== "pintpath-protected-production-route-mutation/v1"
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || !["closed", "closed_reconciled_after_lost_ack"].includes(String(value.outcome))
    || value.operation !== "close"
    || value.candidateSha !== candidateSha
    || value.githubEnvironment !== "production-route-close"
    || value.policySha256 !== "79639878b7938386421fdfb0258aec732f93fadd1e2823b697882de568076d0a"
    || value.domain !== "pintpath.au"
    || value.targetPort !== null
    || value.deploymentIdSha256 !== deploymentIdSha256
    || [value.projectIdSha256, value.environmentIdSha256, value.serviceIdSha256,
      value.routeIdSha256, value.predecessorAuthoritySha256,
      value.orderedProductionChainSha256, value.intentSha256,
      value.terminalEvidenceSha256, value.beforeInventorySha256,
      value.afterInventorySha256].some(
      (entry) => typeof entry !== "string" || !SHA256.test(entry),
    )
    || typeof value.productionDeploymentArtifactDigest !== "string"
    || !artifactDigest.test(value.productionDeploymentArtifactDigest)
    || typeof value.productionScaleArtifactDigest !== "string"
    || !artifactDigest.test(value.productionScaleArtifactDigest)
    || value.closedRouteArtifactDigest !== null
    || value.promotionRecoveryArtifactDigest !== null
    || value.promotionRecoveryReceiptSha256 !== null
    || value.productionDeploymentReceiptSha256 !== deploymentReceiptSha256
    || value.productionScaleReceiptSha256 !== scaleReceiptSha256
    || value.closedRouteReceiptSha256 !== null
    || value.attempts !== 1
    || value.retryAllowed !== false
    || !exactKeys(checks, checkKeys)
    || checks.publicRuntimePostflightExact !== false
    || Object.entries(checks).some(([name, entry]) => (
      name === "publicRuntimePostflightExact" || name === "acknowledgementExact"
        ? typeof entry !== "boolean"
        : entry !== true
    ))
    || (value.outcome === "closed" && checks.acknowledgementExact !== true)
    || (value.outcome === "closed_reconciled_after_lost_ack"
      && checks.acknowledgementExact !== false)
  ) fail("deployment_invalid");
  const startedAt = timestamp(value.startedAt);
  const completedAt = timestamp(value.completedAt);
  if (
    Date.parse(startedAt) < Date.parse(scaleCompletedAt)
    || Date.parse(completedAt) < Date.parse(startedAt)
  ) fail("deployment_invalid");
}

async function call(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { "Project-Access-Token": token, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const source = await response.text();
  if (!response.ok || Buffer.byteLength(source) > 1024 * 1024) fail("provider_invalid");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return fail("provider_invalid");
  }
}

function writePrivate(filename: string, uid: number, value: unknown): string {
  const target = absolute(filename);
  const parent = path.dirname(target);
  const parentStat = fs.lstatSync(parent, { bigint: true });
  if (
    !parentStat.isDirectory() || parentStat.isSymbolicLink()
    || parentStat.uid !== BigInt(uid) || Number(parentStat.mode & 0o7777n) !== 0o700
    || fs.realpathSync(parent) !== parent
  ) fail("output_unsafe");
  const source = Buffer.from(canonicalPostgresBackupJson(value), "utf8");
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(descriptor, source);
    fs.fsyncSync(descriptor);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.uid !== BigInt(uid) || stat.nlink !== 1n
      || Number(stat.mode & 0o7777n) !== 0o600 || stat.size !== BigInt(source.length)) {
      fail("output_unsafe");
    }
    return sha256(source);
  } catch (error) {
    if (error instanceof ProductionPostPromotionPitrObservationError) throw error;
    return fail("output_unsafe");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    source.fill(0);
  }
}

export async function observeProductionPostPromotionPitr(
  overrides: Partial<Dependencies> = {},
): Promise<Json> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2), env: process.env, fetchImpl: fetch,
    getUid: () => process.getuid?.() ?? null, now: () => new Date(),
    writeOutput: (source) => process.stdout.write(source), ...overrides,
  };
  let args: ReadonlyMap<string, string>;
  try {
    args = parseStrictArguments(dependencies.argv, { allowed: ARGUMENTS, required: ARGUMENTS });
  } catch {
    fail("arguments_invalid");
  }
  const candidateSha = args.get("--candidate-sha")!;
  const uid = dependencies.getUid();
  if (!CANDIDATE.test(candidateSha) || !Number.isSafeInteger(uid) || Number(uid) < 0) {
    fail("arguments_invalid");
  }
  if (
    dependencies.env.GITHUB_ACTIONS !== "true"
    || dependencies.env.GITHUB_REF !== "refs/heads/main"
    || dependencies.env.GITHUB_SHA !== candidateSha
    || dependencies.env.GITHUB_RUN_ATTEMPT !== "1"
    || dependencies.env.PINTPATH_PRODUCTION_PROMOTION_RECOVERY_CONFIRMATION
      !== "ATTEST_PRODUCTION_PROMOTION_RECOVERY"
  ) fail("github_authority_invalid");
  const deploymentSource = readPrivate(args.get("--production-deployment-receipt")!, Number(uid));
  const scaleSource = readPrivate(args.get("--production-scale-receipt")!, Number(uid));
  const closeSource = readPrivate(args.get("--closed-route-receipt")!, Number(uid));
  const manifestSource = readPrivate(args.get("--logical-backup-manifest")!, Number(uid));
  try {
    const deployment = parseCanonical(deploymentSource);
    const deploymentReceipt = parseProductionApplicationDeploymentReceipt(
      deployment,
      candidateSha,
    );
    if (!deploymentReceipt) fail("deployment_invalid");
    const scale = parseCanonical(scaleSource);
    const finalDeploymentIdSha256 = finalDeploymentFromScale(
      scale,
      candidateSha,
      deploymentReceipt.deploymentIdSha256,
      deploymentReceipt.completedAt,
    );
    verifyClosedRouteForCapture(
      parseCanonical(closeSource),
      candidateSha,
      finalDeploymentIdSha256,
      sha256(deploymentSource),
      sha256(scaleSource),
      timestamp(scale.completedAt),
    );
    const manifest = parsePostgresLogicalBackupManifest(manifestSource);
    if (manifest.schemaVersion !== 3) fail("backup_invalid");
    const recoveryPointAt = timestamp(manifest.createdAt);
    const target = protectedPostgresHaPitrInternals.resolveTargetAuthority({
      candidateSha, targetEnvironment: "production", evidenceDir: "/unused",
    }, dependencies.env);
    const token = dependencies.env.PINTPATH_RAILWAY_PITR_METADATA_TOKEN ?? "";
    if (!target || !TOKEN.test(token)) fail("provider_authority_invalid");
    const scope = await call(dependencies.fetchImpl, token, POSTGRES_HA_PITR_SCOPE, {});
    if (!protectedPostgresHaPitrInternals.scope(scope, target)) fail("provider_authority_invalid");
    const inventoryRaw = await call(dependencies.fetchImpl, token, POSTGRES_HA_PITR_INVENTORY, {
      projectId: target.projectId, environmentId: target.environmentId,
    });
    const serviceIds = protectedPostgresHaPitrInternals.inventory(inventoryRaw, target);
    if (!serviceIds) fail("provider_invalid");
    const observations = await Promise.all(serviceIds.map(async (serviceId) => ({
      serviceId,
      value: await call(dependencies.fetchImpl, token, POSTGRES_HA_PITR_HEALTH, {
        environmentId: target.environmentId, rootServiceId: serviceId,
      }),
    })));
    const discovered = protectedPostgresHaPitrInternals.discoveredRoot(observations, target);
    if (!discovered || discovered.rootServiceId !== target.rootServiceId
      || !protectedPostgresHaPitrInternals.health(discovered.health, target)) {
      fail("provider_health_invalid");
    }
    const progressRaw = await call(dependencies.fetchImpl, token, POSTGRES_HA_PITR_PROGRESS, {
      environmentId: target.environmentId, rootServiceId: target.rootServiceId,
    });
    if (protectedPostgresHaPitrInternals.progress(progressRaw, target) !== "done") {
      fail("pitr_not_enabled");
    }
    const progress = (progressRaw as { data: { pitrHaWorkflowProgress: Json } })
      .data.pitrHaWorkflowProgress;
    const health = (discovered.health as { data: { pitrHaClusterReplicationHealth: Json } })
      .data.pitrHaClusterReplicationHealth;
    const enabledAt = timestamp(progress.completedAt);
    const observedAt = timestamp(health.checkedAt);
    const now = dependencies.now();
    if (
      !Number.isFinite(now.getTime())
      || Date.parse(enabledAt) > Date.parse(recoveryPointAt)
      || Date.parse(recoveryPointAt) > Date.parse(observedAt)
      || Date.parse(observedAt) > now.getTime()
      || now.getTime() - Date.parse(observedAt) > 300_000
    ) fail("pitr_chronology_invalid");
    const withoutHash = {
      schemaVersion: PRODUCTION_POST_PROMOTION_PITR_OBSERVATION_SCHEMA,
      outcome: "verified",
      candidateSha,
      productionDeploymentIdSha256: finalDeploymentIdSha256,
      recoveryPointAt,
      observedAt,
      pitrEnabledAt: enabledAt,
      projectIdSha256: sha256(target.projectId),
      environmentIdSha256: sha256(target.environmentId),
      rootServiceIdSha256: sha256(target.rootServiceId),
      pitrWorkflowIdSha256: sha256(String(progress.workflowId)),
      providerHealthSha256: sha256ProductionPromotionRecoveryValue(discovered.health),
      pitrEnabled: true,
      clusterHealthy: true,
    };
    const receipt = {
      ...withoutHash,
      receiptSha256: sha256ProductionPromotionRecoveryValue(withoutHash),
    };
    const receiptFileSha256 = writePrivate(args.get("--output")!, Number(uid), receipt);
    dependencies.writeOutput(canonicalPostgresBackupJson({
      schemaVersion: 1, ok: true, candidateSha,
      receiptSha256: receipt.receiptSha256, receiptFileSha256,
    }));
    return receipt;
  } finally {
    deploymentSource.fill(0);
    scaleSource.fill(0);
    closeSource.fill(0);
    manifestSource.fill(0);
  }
}

export async function runProductionPostPromotionPitrObservation(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const output = overrides.writeOutput ?? ((source: string) => process.stdout.write(source));
  try {
    await observeProductionPostPromotionPitr({ ...overrides, writeOutput: output });
    return 0;
  } catch (error) {
    output(canonicalPostgresBackupJson({
      schemaVersion: 1, ok: false,
      failureCode: error instanceof ProductionPostPromotionPitrObservationError
        ? error.code : "provider_invalid",
    }));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProductionPostPromotionPitrObservation();
}
