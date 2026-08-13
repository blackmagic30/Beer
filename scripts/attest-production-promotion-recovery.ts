import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA,
} from "./lib/permanent-staging-app-deployment-executor.js";
import {
  PROTECTED_STAGING_SCALE_SCHEMA,
} from "./execute-protected-permanent-staging-scale.js";
import {
  postgresReviewedPriceOperationAuthorizationReceiptSchema,
  postgresReviewedPriceOperationReceiptSchema,
} from "../src/lib/postgres-reviewed-price-promotion-operation.js";
import {
  parsePostgresAccountDeletionReplayReceipt,
} from "../src/lib/postgres-account-deletion-replay.js";
import {
  canonicalPostgresBackupJson,
} from "../src/lib/postgres-logical-backup.js";
import {
  parsePostgresLogicalBackupManifest,
} from "../src/lib/postgres-logical-restore.js";
import {
  buildProductionPromotionRecoveryReceipt,
  productionPromotionRecoveryAuthoritySchema,
  sha256ProductionPromotionRecoveryBytes,
  sha256ProductionPromotionRecoveryValue,
  verifyProductionPromotionRecoveryApproval,
  type ProductionPromotionRecoveryReceipt,
} from "../src/lib/production-promotion-recovery.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

export const PRODUCTION_PROMOTION_RECOVERY_POLICY_SHA256 =
  "d35f73daa16b62c84701a6a935d9594160bdbc7c8063529e530d9ac0e37beb5b" as const;
const POLICY_PATH = "ops/railway/production-promotion-recovery-policy.json";
const ROUTE_SCHEMA = "pintpath-protected-production-route-mutation/v1";
const PICTURE_PITR_SCHEMA = "pintpath-production-post-promotion-pitr-observation/v1";
const STOCK_LOCALHOST_PROFILE = "railway-stock-localhost-ca-v1";
const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE = /^[a-f0-9]{40}$/;
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const MAX_KEY_BYTES = 64 * 1024;
const MAX_APPROVAL_AGE_MS = 21_600_000;

const ARGUMENTS = new Set([
  "--authority", "--authority-sha256", "--production-deployment-receipt",
  "--production-scale-receipt",
  "--closed-route-receipt", "--closed-route-terminal",
  "--apply-authorization-receipt", "--apply-operation-receipt", "--pitr-receipt",
  "--logical-backup-manifest", "--logical-offsite-result", "--logical-worm-result",
  "--private-storage-capture-receipt", "--private-storage-recovery-manifest",
  "--offsite-retrieval-receipt", "--logical-restore-receipt",
  "--private-storage-restore-receipt", "--deletion-replay-first-receipt",
  "--deletion-replay-second-receipt", "--approval-one", "--approval-one-public-key",
  "--approval-two", "--approval-two-public-key", "--candidate-sha", "--output",
  "--expected-reviewer-one-public-key-sha256",
  "--expected-reviewer-two-public-key-sha256",
]);

type Json = Record<string, unknown>;

export class ProductionPromotionRecoveryAttestationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProductionPromotionRecoveryAttestationError";
  }
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly getUid: () => number | null;
  readonly now: () => Date;
  readonly writeOutput: (source: string) => void;
}

interface HeldFile {
  readonly path: string;
  readonly source: Buffer;
  readonly sha256: string;
  readonly stat: fs.BigIntStats;
}

function fail(code: string): never {
  throw new ProductionPromotionRecoveryAttestationError(code);
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail("evidence_invalid");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("evidence_invalid");
  return value;
}

function exactSha(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("evidence_invalid");
  return value;
}

function exactCandidate(value: unknown): string {
  if (typeof value !== "string" || !CANDIDATE.test(value)) fail("candidate_invalid");
  return value;
}

function absolutePath(value: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || value.includes("\0")) {
    fail("arguments_invalid");
  }
  return value;
}

function readHeldFile(filename: string, uid: number, maxBytes = MAX_JSON_BYTES): HeldFile {
  const resolved = absolutePath(filename);
  let handle: number | null = null;
  try {
    handle = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(handle, { bigint: true });
    const pathname = fs.lstatSync(resolved, { bigint: true });
    if (
      !stat.isFile() || !pathname.isFile() || pathname.isSymbolicLink()
      || stat.uid !== BigInt(uid) || pathname.uid !== BigInt(uid)
      || Number(stat.mode & 0o7777n) !== 0o600
      || Number(pathname.mode & 0o7777n) !== 0o600
      || stat.nlink !== 1n || pathname.nlink !== 1n
      || stat.dev !== pathname.dev || stat.ino !== pathname.ino
      || stat.size < 1n || stat.size > BigInt(maxBytes)
      || fs.realpathSync(resolved) !== resolved
    ) fail("evidence_file_unsafe");
    const source = fs.readFileSync(handle);
    const after = fs.fstatSync(handle, { bigint: true });
    const afterPath = fs.lstatSync(resolved, { bigint: true });
    if (
      after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
      || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs
      || afterPath.dev !== stat.dev || afterPath.ino !== stat.ino
      || afterPath.mtimeNs !== stat.mtimeNs || afterPath.ctimeNs !== stat.ctimeNs
    ) fail("evidence_file_drift");
    return { path: resolved, source, sha256: sha256(source), stat };
  } catch (error) {
    if (error instanceof ProductionPromotionRecoveryAttestationError) throw error;
    return fail("evidence_file_unsafe");
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

function parseCanonicalJson(file: HeldFile): Json {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.source));
  } catch {
    fail("evidence_invalid");
  }
  if (!isObject(value) || canonicalPostgresBackupJson(value) !== file.source.toString("utf8")) {
    fail("evidence_not_canonical");
  }
  return value;
}

function allTrue(value: unknown): boolean {
  return isObject(value)
    && Object.keys(value).length > 0
    && Object.values(value).every((entry) => entry === true);
}

function verifyPolicy(cwd: string): void {
  const source = fs.readFileSync(path.resolve(cwd, POLICY_PATH));
  if (sha256(source) !== PRODUCTION_PROMOTION_RECOVERY_POLICY_SHA256) fail("policy_invalid");
  const value = JSON.parse(source.toString("utf8")) as Json;
  if (
    value.schemaVersion !== "pintpath-production-promotion-recovery-policy/v1"
    || value.activationState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || value.githubEnvironment !== "production-promotion-recovery"
    || !isObject(value.recoveryContract)
    || value.recoveryContract.maximumRpoSeconds !== 3_600
    || value.recoveryContract.maximumRtoSeconds !== 14_400
  ) fail("policy_invalid");
}

function verifyGithubAuthority(
  dependencies: Dependencies,
  candidateSha: string,
): void {
  if (
    dependencies.env.GITHUB_ACTIONS !== "true"
    || dependencies.env.GITHUB_REF !== "refs/heads/main"
    || dependencies.env.GITHUB_SHA !== candidateSha
    || dependencies.env.GITHUB_RUN_ATTEMPT !== "1"
    || dependencies.env.PINTPATH_PRODUCTION_PROMOTION_RECOVERY_CONFIRMATION
      !== "ATTEST_PRODUCTION_PROMOTION_RECOVERY"
  ) fail("github_authority_invalid");
}

function verifyDeployment(value: Json, candidateSha: string): {
  readonly completedAt: string;
  readonly deploymentIdSha256: string;
} {
  if (
    value.schemaVersion !== PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA
    || value.operation !== "pintpath-railway-application-source-upload"
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || value.target !== "production"
    || !["deployed", "already_deployed", "reconciled_success"].includes(String(value.outcome))
    || value.candidateSha !== candidateSha
    || typeof value.deploymentIdSha256 !== "string" || !SHA256.test(value.deploymentIdSha256)
    || !allTrue(value.checks)
  ) fail("production_deployment_invalid");
  return {
    completedAt: exactTimestamp(value.completedAt),
    deploymentIdSha256: value.deploymentIdSha256,
  };
}

function verifyClosedRoute(
  value: Json,
  candidateSha: string,
  deploymentIdSha256: string,
  deploymentReceiptSha256: string,
  scaleReceiptSha256: string,
): { readonly completedAt: string; readonly terminalSha256: string } {
  const checks = value.checks;
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
  const checksExact = isObject(checks)
    && exactKeys(checks, checkKeys)
    && checks.publicRuntimePostflightExact === false
    && Object.entries(checks).every(([name, entry]) => (
      name === "publicRuntimePostflightExact" || name === "acknowledgementExact"
        ? typeof entry === "boolean"
        : entry === true
    ));
  if (
    value.schemaVersion !== ROUTE_SCHEMA
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || !["closed", "closed_reconciled_after_lost_ack"].includes(String(value.outcome))
    || value.operation !== "close"
    || value.candidateSha !== candidateSha
    || value.deploymentIdSha256 !== deploymentIdSha256
    || value.githubEnvironment !== "production-route-close"
    || value.attempts !== 1 || value.retryAllowed !== false
    || value.closedRouteArtifactDigest !== null
    || value.promotionRecoveryArtifactDigest !== null
    || value.promotionRecoveryReceiptSha256 !== null
    || value.productionDeploymentReceiptSha256 !== deploymentReceiptSha256
    || value.productionScaleReceiptSha256 !== scaleReceiptSha256
    || value.closedRouteReceiptSha256 !== null
    || !checksExact
    || (value.outcome === "closed" && checks.acknowledgementExact !== true)
    || (value.outcome === "closed_reconciled_after_lost_ack"
      && checks.acknowledgementExact !== false)
  ) fail("closed_route_invalid");
  return {
    completedAt: exactTimestamp(value.completedAt),
    terminalSha256: exactSha(value.terminalEvidenceSha256),
  };
}

function verifyScale(
  value: Json,
  candidateSha: string,
  deploymentIdSha256: string,
  deploymentCompletedAt: string,
): { readonly completedAt: string } {
  const checks = value.checks;
  if (
    value.schemaVersion !== PROTECTED_STAGING_SCALE_SCHEMA
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || value.direction !== "converge-production-two"
    || !["scaled", "already_converged"].includes(String(value.outcome))
    || value.candidateSha !== candidateSha
    || value.desiredReplicas !== 2
    || value.deploymentIdSha256 !== deploymentIdSha256
    || value.retryAllowed !== false
    || ![0, 1].includes(Number(value.attempts))
    || !isObject(checks)
    || checks.durableIntentExact !== (value.attempts === 1)
    || Object.entries(checks).some(([name, entry]) => (
      name !== "durableIntentExact" && entry !== true
    ))
    || (value.outcome === "scaled") !== (value.attempts === 1)
  ) fail("production_scale_invalid");
  const startedAt = exactTimestamp(value.startedAt);
  const completedAt = exactTimestamp(value.completedAt);
  if (
    Date.parse(startedAt) < Date.parse(deploymentCompletedAt)
    || Date.parse(completedAt) < Date.parse(startedAt)
  ) fail("production_scale_invalid");
  return { completedAt };
}

function verifyClosedRouteTerminal(
  value: Json,
  candidateSha: string,
  deploymentIdSha256: string,
): void {
  if (
    value.schemaVersion !== "pintpath-protected-production-route-terminal/v1"
    || !isObject(value.receipt)
    || value.receipt.schemaVersion !== ROUTE_SCHEMA
    || value.receipt.operation !== "close"
    || value.receipt.candidateSha !== candidateSha
    || value.receipt.deploymentIdSha256 !== deploymentIdSha256
    || value.receipt.terminalEvidenceSha256 !== null
    || !isObject(value.receipt.checks)
    || value.receipt.checks.terminalEvidenceExact !== false
    || value.receipt.checks.finalReceiptEvidenceExact !== false
  ) fail("closed_route_terminal_invalid");
}

function verifyPitr(
  value: Json,
  candidateSha: string,
  deploymentIdSha256: string,
): { readonly observedAt: string; readonly recoveryPointAt: string } {
  const { receiptSha256, ...withoutHash } = value;
  if (
    value.schemaVersion !== PICTURE_PITR_SCHEMA
    || value.outcome !== "verified"
    || value.candidateSha !== candidateSha
    || value.productionDeploymentIdSha256 !== deploymentIdSha256
    || value.pitrEnabled !== true
    || value.clusterHealthy !== true
    || !exactKeys(value, [
      "schemaVersion", "outcome", "candidateSha", "productionDeploymentIdSha256",
      "recoveryPointAt", "observedAt", "pitrEnabledAt", "projectIdSha256",
      "environmentIdSha256", "rootServiceIdSha256", "pitrWorkflowIdSha256",
      "providerHealthSha256", "pitrEnabled", "clusterHealthy", "receiptSha256",
    ])
    || [value.projectIdSha256, value.environmentIdSha256, value.rootServiceIdSha256,
      value.pitrWorkflowIdSha256, value.providerHealthSha256]
      .some((entry) => typeof entry !== "string" || !SHA256.test(entry))
    || receiptSha256 !== sha256ProductionPromotionRecoveryValue(withoutHash)
  ) fail("pitr_invalid");
  const enabledAt = exactTimestamp(value.pitrEnabledAt);
  const observedAt = exactTimestamp(value.observedAt);
  const recoveryPointAt = exactTimestamp(value.recoveryPointAt);
  if (Date.parse(enabledAt) > Date.parse(recoveryPointAt)
    || Date.parse(recoveryPointAt) > Date.parse(observedAt)) fail("pitr_invalid");
  return {
    observedAt,
    recoveryPointAt,
  };
}

function writeReceipt(filename: string, uid: number, receipt: ProductionPromotionRecoveryReceipt): void {
  const target = absolutePath(filename);
  const parent = path.dirname(target);
  const parentStat = fs.lstatSync(parent, { bigint: true });
  if (
    !parentStat.isDirectory() || parentStat.isSymbolicLink()
    || parentStat.uid !== BigInt(uid) || Number(parentStat.mode & 0o7777n) !== 0o700
    || fs.realpathSync(parent) !== parent
  ) fail("output_unsafe");
  let handle: number | null = null;
  try {
    handle = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const source = Buffer.from(canonicalPostgresBackupJson(receipt), "utf8");
    fs.writeFileSync(handle, source);
    fs.fsyncSync(handle);
    const stat = fs.fstatSync(handle, { bigint: true });
    if (
      !stat.isFile() || stat.uid !== BigInt(uid) || stat.nlink !== 1n
      || Number(stat.mode & 0o7777n) !== 0o600
      || stat.size !== BigInt(source.length)
    ) fail("output_unsafe");
  } catch (error) {
    if (error instanceof ProductionPromotionRecoveryAttestationError) throw error;
    fail("output_unsafe");
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

export async function attestProductionPromotionRecovery(
  overrides: Partial<Dependencies> = {},
): Promise<ProductionPromotionRecoveryReceipt> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2), env: process.env, cwd: process.cwd(),
    getUid: () => process.getuid?.() ?? null, now: () => new Date(),
    writeOutput: (source) => process.stdout.write(source), ...overrides,
  };
  const uid = dependencies.getUid();
  if (!Number.isSafeInteger(uid) || Number(uid) < 0) fail("uid_invalid");
  let args: ReadonlyMap<string, string>;
  try {
    args = parseStrictArguments(dependencies.argv, { allowed: ARGUMENTS, required: ARGUMENTS });
  } catch {
    fail("arguments_invalid");
  }
  const candidateSha = exactCandidate(args.get("--candidate-sha"));
  verifyPolicy(dependencies.cwd);
  verifyGithubAuthority(dependencies, candidateSha);

  const names = [
    "authority", "production-deployment-receipt", "production-scale-receipt",
    "closed-route-receipt",
    "closed-route-terminal", "apply-authorization-receipt", "apply-operation-receipt",
    "pitr-receipt", "logical-backup-manifest", "logical-offsite-result",
    "logical-worm-result", "private-storage-capture-receipt",
    "private-storage-recovery-manifest", "offsite-retrieval-receipt",
    "logical-restore-receipt", "private-storage-restore-receipt",
    "deletion-replay-first-receipt", "deletion-replay-second-receipt",
    "approval-one", "approval-one-public-key", "approval-two", "approval-two-public-key",
  ] as const;
  const files = new Map<string, HeldFile>();
  try {
    for (const name of names) {
      files.set(name, readHeldFile(
        args.get(`--${name}`)!, Number(uid),
        name.includes("public-key") ? MAX_KEY_BYTES : MAX_JSON_BYTES,
      ));
    }
  const json = (name: string) => parseCanonicalJson(files.get(name)!);
  const authorityFile = files.get("authority")!;
  if (authorityFile.sha256 !== args.get("--authority-sha256")) fail("authority_hash_mismatch");
  const authority = productionPromotionRecoveryAuthoritySchema.parse(json("authority"));
  if (authority.candidateSha !== candidateSha) fail("candidate_invalid");
  const exactFile = (name: string, expected: string) => {
    if (files.get(name)!.sha256 !== expected) fail(`${name}_hash_mismatch`);
  };
  exactFile("production-deployment-receipt", authority.productionDeploymentReceiptSha256);
  exactFile("production-scale-receipt", authority.productionScaleReceiptSha256);
  exactFile("closed-route-receipt", authority.closedRouteReceiptSha256);
  exactFile("closed-route-terminal", authority.closedRouteTerminalEvidenceSha256);
  exactFile("apply-authorization-receipt", authority.applyAuthorizationReceiptSha256);
  exactFile("apply-operation-receipt", authority.applyOperationReceiptSha256);
  exactFile("pitr-receipt", authority.pitrReceiptSha256);
  exactFile("logical-backup-manifest", authority.logicalBackupManifestSha256);
  exactFile("logical-offsite-result", authority.logicalOffsiteResultSha256);
  exactFile("logical-worm-result", authority.logicalWormResultSha256);
  exactFile("private-storage-capture-receipt", authority.privateStorageCaptureReceiptSha256);
  exactFile("offsite-retrieval-receipt", authority.offsiteRetrievalReceiptSha256);
  exactFile("logical-restore-receipt", authority.logicalRestoreReceiptSha256);
  exactFile("private-storage-restore-receipt", authority.privateStorageRestoreReceiptSha256);
  exactFile("deletion-replay-first-receipt", authority.deletionReplayFirstReceiptSha256);
  exactFile("deletion-replay-second-receipt", authority.deletionReplaySecondReceiptSha256);

  const deployment = verifyDeployment(json("production-deployment-receipt"), candidateSha);
  if (deployment.deploymentIdSha256 !== authority.productionDeploymentIdSha256) {
    fail("production_deployment_invalid");
  }
  const scale = verifyScale(
    json("production-scale-receipt"), candidateSha,
    deployment.deploymentIdSha256, deployment.completedAt,
  );
  const closedRoute = verifyClosedRoute(
    json("closed-route-receipt"), candidateSha, deployment.deploymentIdSha256,
    authority.productionDeploymentReceiptSha256,
    authority.productionScaleReceiptSha256,
  );
  if (closedRoute.terminalSha256 !== authority.closedRouteTerminalEvidenceSha256) {
    fail("closed_route_invalid");
  }
  verifyClosedRouteTerminal(
    json("closed-route-terminal"), candidateSha, deployment.deploymentIdSha256,
  );

  const authorization = postgresReviewedPriceOperationAuthorizationReceiptSchema.parse(
    json("apply-authorization-receipt"),
  );
  const apply = postgresReviewedPriceOperationReceiptSchema.parse(json("apply-operation-receipt"));
  if (
    authorization.operationKind !== "apply" || apply.operationKind !== "apply"
    || apply.expectedEnvironment !== "production" || apply.candidateSha !== candidateSha
    || authorization.operationId !== apply.operationId
    || authorization.authorizationId !== apply.authorizationId
    || authorization.reviewerIdSha256 !== apply.reviewerIdSha256
    || authorization.approvalFileSha256 !== apply.approvalFileSha256
    || apply.sourceApplyOperationId !== null
  ) fail("promotion_invalid");

  const pitr = verifyPitr(json("pitr-receipt"), candidateSha, deployment.deploymentIdSha256);
  const manifest = parsePostgresLogicalBackupManifest(files.get("logical-backup-manifest")!.source);
  if (
    manifest.schemaVersion !== 3
    || apply.targetPhysicalIdentitySha256 !== manifest.state.sourceDatabaseIdentitySha256
  ) fail("logical_backup_invalid");
  const offsite = json("logical-offsite-result");
  const worm = json("logical-worm-result");
  const capture = json("private-storage-capture-receipt");
  const recoveryManifest = json("private-storage-recovery-manifest");
  const retrieval = json("offsite-retrieval-receipt");
  const restore = json("logical-restore-receipt");
  const storageRestore = json("private-storage-restore-receipt");
  if (
    offsite.schemaVersion !== 1 || offsite.ok !== true
    || offsite.manifestSha256 !== files.get("logical-backup-manifest")!.sha256
    || offsite.archiveSha256 !== manifest.archive.sha256
    || offsite.stateReceiptSha256 !== manifest.state.receiptSha256
    || offsite.sourceDatabaseIdentitySha256 !== manifest.state.sourceDatabaseIdentitySha256
    || offsite.overallStateSha256 !== manifest.state.overallStateSha256
  ) fail("logical_offsite_invalid");
  if (
    worm.schemaVersion !== 1 || worm.ok !== true
    || worm.manifestSha256 !== files.get("logical-backup-manifest")!.sha256
    || worm.archiveSha256 !== manifest.archive.sha256
    || worm.stateReceiptSha256 !== manifest.state.receiptSha256
    || worm.writerPrincipalArnSha256 === worm.readerPrincipalArnSha256
    || !SHA256.test(String(worm.receiptSha256))
  ) fail("logical_worm_invalid");
  if (
    capture.schemaVersion !== 1
    || capture.kind !== "pintpath-postgres-private-storage-recovery-capture"
    || capture.ok !== true
    || capture.databaseTransportProfile !== STOCK_LOCALHOST_PROFILE
    || capture.databaseEffectiveRole !== "pintpath_migrator"
    || !SHA256.test(String(capture.databaseTransportRootCaDerSha256))
    || capture.logicalBackupManifestSha256 !== files.get("logical-backup-manifest")!.sha256
    || capture.databaseTransportRootCaDerSha256 !== manifest.transport.rootCaCertificateSha256
    || !Number.isSafeInteger(capture.storageObjectCount) || Number(capture.storageObjectCount) < 1
    || !Number.isSafeInteger(capture.databaseReferenceCount)
      || Number(capture.databaseReferenceCount) < 1
    || !Number.isSafeInteger(capture.deletionTombstoneCount)
      || Number(capture.deletionTombstoneCount) < 1
    || files.get("private-storage-recovery-manifest")!.sha256
      !== capture.recoveryManifestSha256
  ) fail("private_storage_capture_invalid");
  if (
    recoveryManifest.kind !== "pintpath-postgres-private-storage-recovery-set"
    || recoveryManifest.version !== 2
    || !isObject(recoveryManifest.logicalBackup)
    || recoveryManifest.logicalBackup.candidateSha !== candidateSha
    || recoveryManifest.logicalBackup.sourceEnvironment !== "production"
    || recoveryManifest.logicalBackup.manifestSha256
      !== files.get("logical-backup-manifest")!.sha256
    || !isObject(recoveryManifest.deletionAuthority)
    || Number(recoveryManifest.deletionAuthority.tombstoneCount) < 1
    || recoveryManifest.recoverySetSha256 !== capture.recoverySetSha256
  ) fail("private_storage_manifest_invalid");
  if (
    retrieval.schemaVersion !== 1
    || retrieval.kind !== "pintpath-postgres-logical-offsite-retrieval"
    || retrieval.ok !== true
    || retrieval.successStateSha256 !== offsite.successStateSha256
    || retrieval.manifestSha256 !== files.get("logical-backup-manifest")!.sha256
    || retrieval.archiveSha256 !== manifest.archive.sha256
    || retrieval.stateReceiptSha256 !== manifest.state.receiptSha256
    || retrieval.sourceDatabaseIdentitySha256 !== manifest.state.sourceDatabaseIdentitySha256
  ) fail("offsite_retrieval_invalid");
  if (
    restore.kind !== "pintpath-postgres-logical-restore"
    || restore.version !== 1 || restore.status !== "verified"
    || restore.backupManifestSha256 !== files.get("logical-backup-manifest")!.sha256
    || restore.backupArchiveSha256 !== manifest.archive.sha256
    || restore.expectedSourceOverallStateSha256 !== manifest.state.overallStateSha256
    || restore.restoredOverallStateSha256 !== manifest.state.overallStateSha256
    || restore.sourceStateBindingStatus !== "exact-match"
    || restore.exactDataReconciliation !== "canonical-contract-exact"
  ) fail("logical_restore_invalid");
  const targetIdentity = exactSha(restore.targetIdentitySha256);
  if (
    storageRestore.schemaVersion !== 1
    || storageRestore.kind !== "pintpath-postgres-private-storage-recovery-restore"
    || storageRestore.ok !== true
    || storageRestore.databaseTransportProfile !== STOCK_LOCALHOST_PROFILE
    || storageRestore.databaseEffectiveRole !== "pintpath_migrator"
    || !SHA256.test(String(storageRestore.databaseTransportRootCaDerSha256))
    || !SHA256.test(String(storageRestore.destinationAuthoritySha256))
    || !SHA256.test(String(storageRestore.destinationAuthorityPublicKeySha256))
    || !SHA256.test(String(storageRestore.destinationAuthorityReviewerIdSha256))
    || storageRestore.targetDatabaseIdentitySha256 !== targetIdentity
    || storageRestore.recoverySetSha256 !== recoveryManifest.recoverySetSha256
    || storageRestore.recoveryManifestSha256
      !== files.get("private-storage-recovery-manifest")!.sha256
    || storageRestore.deletionAuthoritySetSha256
      !== recoveryManifest.deletionAuthority.authoritySetSha256
    || Number(storageRestore.restoredObjectCount) < 1
  ) fail("private_storage_restore_invalid");
  const replayOne = parsePostgresAccountDeletionReplayReceipt(json("deletion-replay-first-receipt"));
  const replayTwo = parsePostgresAccountDeletionReplayReceipt(json("deletion-replay-second-receipt"));
  if (
    replayOne.targetIdentitySha256 !== targetIdentity
    || replayTwo.targetIdentitySha256 !== targetIdentity
    || replayOne.baseRestoreReceiptSha256 !== files.get("logical-restore-receipt")!.sha256
    || replayTwo.baseRestoreReceiptSha256 !== files.get("logical-restore-receipt")!.sha256
    || replayOne.migrationCandidateSha !== candidateSha
    || replayTwo.migrationCandidateSha !== candidateSha
    || replayOne.ledgerCurrentSha256 !== recoveryManifest.deletionAuthority.currentSha256
    || replayTwo.ledgerCurrentSha256 !== recoveryManifest.deletionAuthority.currentSha256
    || replayOne.ledgerTombstoneCount !== recoveryManifest.deletionAuthority.tombstoneCount
    || replayOne.counts.seen < 1 || replayOne.counts.newlyApplied !== replayOne.counts.seen
    || replayOne.counts.alreadyApplied !== 0
    || replayTwo.counts.seen !== replayOne.counts.seen
    || replayTwo.counts.newlyApplied !== 0
    || replayTwo.counts.alreadyApplied !== replayTwo.counts.seen
    || replayTwo.semanticProjectionSha256 !== replayOne.semanticProjectionSha256
    || replayOne.transportProfile !== STOCK_LOCALHOST_PROFILE
    || replayTwo.transportProfile !== STOCK_LOCALHOST_PROFILE
    || replayOne.replayEffectiveRole !== "pintpath_maintenance"
    || replayTwo.replayEffectiveRole !== "pintpath_maintenance"
    || replayTwo.transportRootCaDerSha256 !== replayOne.transportRootCaDerSha256
    || replayOne.transportRootCaDerSha256
      !== storageRestore.databaseTransportRootCaDerSha256
  ) fail("deletion_replay_invalid");

  const approvalOne = verifyProductionPromotionRecoveryApproval({
    approval: json("approval-one"), authorityManifestSha256: authorityFile.sha256,
    candidateSha, publicKeyPem: files.get("approval-one-public-key")!.source,
  });
  const approvalTwo = verifyProductionPromotionRecoveryApproval({
    approval: json("approval-two"), authorityManifestSha256: authorityFile.sha256,
    candidateSha, publicKeyPem: files.get("approval-two-public-key")!.source,
  });
  const approvals = [approvalOne, approvalTwo].sort(
    (left, right) => left.payload.reviewerIdSha256.localeCompare(right.payload.reviewerIdSha256),
  );
  const publicKeyHashes = [
    approvalOne.payload.reviewerPublicKeySha256,
    approvalTwo.payload.reviewerPublicKeySha256,
  ].sort() as [string, string];
  const protectedReviewerKeyHashes = [
    exactSha(args.get("--expected-reviewer-one-public-key-sha256")),
    exactSha(args.get("--expected-reviewer-two-public-key-sha256")),
  ].sort();
  if (
    approvals[0]!.payload.reviewerIdSha256 === approvals[1]!.payload.reviewerIdSha256
    || publicKeyHashes[0] === publicKeyHashes[1]
    || JSON.stringify(publicKeyHashes) !== JSON.stringify(authority.reviewerPublicKeySha256s)
    || JSON.stringify(publicKeyHashes) !== JSON.stringify(protectedReviewerKeyHashes)
  ) fail("reviewers_invalid");

  const times = {
    deployment: deployment.completedAt, scale: scale.completedAt, close: closedRoute.completedAt,
    authorize: authorization.authorizedAt, apply: apply.committedAt,
    pitr: pitr.observedAt, backup: exactTimestamp(manifest.createdAt),
    privateCapture: exactTimestamp(capture.capturedAt), offsite: exactTimestamp(offsite.completedAt),
    worm: exactTimestamp(worm.completedAt), retrieval: exactTimestamp(retrieval.retrievedAt),
    logicalRestore: exactTimestamp(restore.restoredAt),
    privateRestore: exactTimestamp(storageRestore.restoredAt),
    replayOne: exactTimestamp(replayOne.replayedAt), replayTwo: exactTimestamp(replayTwo.replayedAt),
    reviewerOne: approvalOne.payload.approvedAt, reviewerTwo: approvalTwo.payload.approvedAt,
  };
  const time = (name: keyof typeof times) => Date.parse(times[name]);
  const recoveryStartedAt = Date.parse(authority.recoveryStartedAt);
  const recoveryCompletedAt = Date.parse(authority.recoveryCompletedAt);
  const rpo = Math.floor((time("backup") - time("apply")) / 1_000);
  const rto = Math.floor((recoveryCompletedAt - recoveryStartedAt) / 1_000);
  const approvalsAfterRecovery = Math.min(time("reviewerOne"), time("reviewerTwo"));
  const now = dependencies.now();
  const nowMs = now.getTime();
  if (
    time("deployment") > time("scale") || time("scale") > time("close")
    || time("close") > time("authorize")
    || time("authorize") > time("apply")
    || [time("pitr"), time("backup"), time("privateCapture"), time("offsite"), time("worm")]
      .some((entry) => entry <= time("apply"))
    || time("retrieval") < Math.max(time("offsite"), time("worm"), time("privateCapture"))
    || time("logicalRestore") < time("retrieval")
    || time("privateRestore") < time("logicalRestore")
    || time("replayOne") < time("privateRestore") || time("replayTwo") <= time("replayOne")
    || approvalsAfterRecovery < time("replayTwo")
    || !Number.isFinite(nowMs) || nowMs < Math.max(time("reviewerOne"), time("reviewerTwo"))
    || nowMs - Math.min(time("reviewerOne"), time("reviewerTwo")) > MAX_APPROVAL_AGE_MS
    || authority.recoveryPointAt !== times.backup || pitr.recoveryPointAt !== times.backup
    || authority.pitrObservedAt !== times.pitr
    || authority.recoveryCompletedAt !== times.replayTwo
    || recoveryStartedAt <= time("apply") || recoveryStartedAt > time("retrieval")
    || authority.rpoSeconds !== rpo || authority.rtoSeconds !== rto
    || rpo < 0 || rpo > 3_600 || rto < 1 || rto > 14_400
  ) fail("chronology_invalid");

  const chronology = Object.entries(times).map(([stage, at]) => ({ stage, at })).sort(
    (left, right) => left.at.localeCompare(right.at) || left.stage.localeCompare(right.stage),
  );
  const reviewerIds = approvals.map((entry) => entry.payload.reviewerIdSha256) as [string, string];
  const reviewerApprovalSetSha256 = sha256ProductionPromotionRecoveryValue(
    approvals.map((entry) => entry.payload),
  );
  const receipt = buildProductionPromotionRecoveryReceipt({
    schemaVersion: "pintpath-production-promotion-recovery-receipt/v1",
    outcome: "verified", candidateSha, githubEnvironment: "production-promotion-recovery",
    policySha256: PRODUCTION_PROMOTION_RECOVERY_POLICY_SHA256,
    authorityManifestSha256: authorityFile.sha256,
    productionDeploymentReceiptSha256: authority.productionDeploymentReceiptSha256,
    productionDeploymentIdSha256: deployment.deploymentIdSha256,
    productionScaleReceiptSha256: authority.productionScaleReceiptSha256,
    closedRouteReceiptSha256: authority.closedRouteReceiptSha256,
    closedRouteTerminalEvidenceSha256: authority.closedRouteTerminalEvidenceSha256,
    applyAuthorizationReceiptSha256: authority.applyAuthorizationReceiptSha256,
    applyOperationReceiptSha256: authority.applyOperationReceiptSha256,
    promotionOperationId: apply.operationId, promotionCommittedAt: apply.committedAt,
    quarantineReceiptSha256: null, pitrReceiptSha256: authority.pitrReceiptSha256,
    pitrObservedAt: times.pitr, logicalBackupManifestSha256: authority.logicalBackupManifestSha256,
    logicalBackupCreatedAt: times.backup, offsiteSuccessStateSha256: exactSha(offsite.successStateSha256),
    offsiteCompletedAt: times.offsite, wormReceiptSha256: exactSha(worm.receiptSha256),
    wormCompletedAt: times.worm,
    privateStorageCaptureReceiptSha256: authority.privateStorageCaptureReceiptSha256,
    privateStorageCapturedAt: times.privateCapture,
    offsiteRetrievalReceiptSha256: authority.offsiteRetrievalReceiptSha256,
    offsiteRetrievedAt: times.retrieval,
    logicalRestoreReceiptSha256: authority.logicalRestoreReceiptSha256,
    logicalRestoreRestoredAt: times.logicalRestore,
    privateStorageRestoreReceiptSha256: authority.privateStorageRestoreReceiptSha256,
    privateStorageRestoredAt: times.privateRestore,
    deletionReplayFirstReceiptSha256: authority.deletionReplayFirstReceiptSha256,
    deletionReplaySecondReceiptSha256: authority.deletionReplaySecondReceiptSha256,
    deletionReplayCompletedAt: times.replayTwo, recoveryTargetIdentitySha256: targetIdentity,
    recoveryPointAt: times.backup, rpoSeconds: rpo, rtoSeconds: rto,
    reviewerApprovalSetSha256, reviewerIdSha256s: reviewerIds,
    attestedAt: now.toISOString(), chronologySha256: sha256ProductionPromotionRecoveryValue(chronology),
    checks: {
      authorityExact: true, candidateExact: true, productionDeploymentExact: true,
      productionScaleExact: true,
      closedRouteExact: true, promotionAuthorizationExact: true, promotionApplyExact: true,
      quarantineAbsent: true, pitrExact: true, logicalBackupExact: true,
      operationalOffsiteExact: true, wormIndependentReaderExact: true,
      privateStorageCaptureExact: true, offsiteRetrievalExact: true,
      disposableLogicalRestoreExact: true, disposablePrivateStorageRestoreExact: true,
      deletionReplayAppliedExact: true, deletionReplayIdempotentExact: true,
      transportAndRoleExact: true, recoveryStateBindingsExact: true, rpoRtoExact: true,
      twoPersonApprovalExact: true, chronologyExact: true,
    },
  });
  writeReceipt(args.get("--output")!, Number(uid), receipt);
  dependencies.writeOutput(canonicalPostgresBackupJson({
    schemaVersion: 1, ok: true, candidateSha,
    receiptSha256: receipt.receiptSha256,
    receiptFileSha256: sha256ProductionPromotionRecoveryBytes(
      canonicalPostgresBackupJson(receipt),
    ),
  }));
    return receipt;
  } finally {
    for (const file of files.values()) file.source.fill(0);
  }
}

export async function runProductionPromotionRecoveryAttestation(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const output = overrides.writeOutput ?? ((source: string) => process.stdout.write(source));
  try {
    await attestProductionPromotionRecovery({ ...overrides, writeOutput: output });
    return 0;
  } catch (error) {
    output(canonicalPostgresBackupJson({
      schemaVersion: 1, ok: false,
      failureCode: error instanceof ProductionPromotionRecoveryAttestationError
        ? error.code : "evidence_invalid",
    }));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProductionPromotionRecoveryAttestation();
}
