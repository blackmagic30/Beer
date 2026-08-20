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
import { postgresPrivateStorageRecoveryInternals } from
  "../src/lib/postgres-private-storage-recovery.js";
import {
  canonicalPostgresBackupJson,
} from "../src/lib/postgres-logical-backup.js";
import {
  parsePostgresLogicalBackupManifest,
} from "../src/lib/postgres-logical-restore.js";
import {
  buildProductionPromotionRecoveryReceipt,
  productionRecoveryLogicalWormResultSchema,
  productionRecoveryLogicalWormRetrievalSchema,
  productionRecoveryLogicalOffsiteResultSchema,
  productionRecoveryLogicalOffsiteRetrievalSchema,
  productionRecoveryLogicalRestoreReceiptSchema,
  productionRecoveryPitrReceiptSchema,
  productionRecoveryPrivateCaptureSchema,
  productionRecoveryPrivateRestoreSchema,
  productionRecoveryRecoveredApplicationSchema,
  productionRecoveryPrivateWormResultSchema,
  productionRecoveryPrivateWormRetrievalSchema,
  productionRecoveryRailwayTeardownTerminalSchema,
  productionRecoveryStoragePurgeReceiptSchema,
  productionRecoverySupabaseTeardownTerminalSchema,
  productionPromotionRecoveryAuthoritySchema,
  sha256ProductionPromotionRecoveryBytes,
  sha256ProductionPromotionRecoveryValue,
  verifyProductionPromotionRecoveryApproval,
  type ProductionPromotionRecoveryReceipt,
} from "../src/lib/production-promotion-recovery.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";

export const PRODUCTION_PROMOTION_RECOVERY_POLICY_SHA256 =
  "57f66c1c9dde912586ec510e37c28cc3dfea2c098e67c78edbea189c7dcc9988" as const;
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
  "--activation-receipt", "--activation-github-authority",
  "--production-scale-receipt",
  "--closed-route-receipt", "--closed-route-terminal",
  "--apply-authorization-receipt", "--apply-operation-receipt", "--pitr-receipt",
  "--logical-backup-manifest", "--logical-offsite-result", "--logical-worm-result",
  "--logical-worm-retrieval-receipt",
  "--private-storage-capture-receipt", "--private-storage-recovery-manifest",
  "--offsite-retrieval-receipt", "--logical-restore-receipt",
  "--private-storage-restore-receipt", "--deletion-replay-first-receipt",
  "--deletion-replay-second-receipt", "--approval-one", "--approval-one-public-key",
  "--private-storage-worm-receipt", "--private-storage-worm-retrieval-receipt",
  "--recovered-smoke-receipt", "--storage-purge-receipt",
  "--railway-teardown-terminal", "--supabase-teardown-terminal",
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

function selfHashedReceiptExact(value: Json): boolean {
  const { receiptSha256, ...withoutHash } = value;
  return typeof receiptSha256 === "string" && SHA256.test(receiptSha256)
    && receiptSha256 === sha256ProductionPromotionRecoveryValue(withoutHash);
}

function parseExactEvidence<T>(schema: { safeParse: (value: unknown) => {
  success: boolean; data?: T;
} }, value: unknown, code: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(code);
  return parsed.data as T;
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
    value.schemaVersion !== "pintpath-production-promotion-recovery-policy/v2"
    || value.activationState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || value.githubEnvironment !== "production-promotion-recovery"
    || value.requiredWorkflow !== ".github/workflows/attest-production-promotion-recovery.yml"
    || !isObject(value.activationContract)
    || value.activationContract.requiredWorkflow
      !== ".github/workflows/activate-production-promotion-recovery.yml"
    || value.activationContract.requiredCheck
      !== "Activate exact production promotion recovery"
    || value.activationContract.exactRunIdAndFirstAttemptRequired !== true
    || value.activationContract.immutableWorkflowRunStartedAtRequired !== true
    || value.activationContract.exactArtifactAuthorityRequired !== true
    || JSON.stringify(value.activationContract.jobsInOrder)
      !== JSON.stringify(["production-capture", "disposable-recover", "cleanup", "finalize"])
    || value.activationContract.productionCaptureRunnerLabel
      !== "pintpath-production-backup"
    || value.activationContract.disposableRecoveryRunnerLabel
      !== "pintpath-disposable-recovery"
    || value.activationContract.crossProjectPrivateNetworkSplitRequired !== true
    || value.activationContract.rawRecoveryBytesInGithubArtifactsAllowed !== false
    || value.activationContract.evidenceLeafCount !== 18
    || value.activationContract.finalArtifactFileCount !== 20
    || !isObject(value.recoveryContract)
    || value.recoveryContract.independentLogicalWormRetrievalRequired !== true
    || value.recoveryContract.independentPrivateRecoveryBundleWormRetrievalRequired
      !== true
    || value.recoveryContract.compiledApplicationSmokeRequired !== true
    || value.recoveryContract.exactRestoredStoragePurgeRequired !== true
    || value.recoveryContract.maximumRpoSeconds !== 3_600
    || value.recoveryContract.maximumRtoSeconds !== 14_400
    || !isObject(value.cleanupContract)
    || value.cleanupContract.separateNoninteractiveEnvironment
      !== "production-promotion-recovery-cleanup"
    || value.cleanupContract.signedAuthoritiesBindExactGithubRunId !== true
    || value.cleanupContract.railwayAndSupabaseStepsIndependentAlways !== true
    || value.cleanupContract.railwayTargetAbsenceRequired !== true
    || value.cleanupContract.supabaseTargetAbsenceRequired !== true
    || value.cleanupContract.orderlySupabaseCleanupRequiredForGreen !== true
    || value.cleanupContract.emergencyCleanupMayFinalizeGreen !== false
    || value.cleanupContract.forceCancelAllowedBeforeIndependentAbsence !== false
    || !isObject(value.reviewContract)
    || value.reviewContract.authorityVersion !== 2
    || value.reviewContract.approvalsAfterFinalActivationRequired !== true
    || value.reviewContract.activationReceiptBindingRequired !== true
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
    || value.failureCode !== null
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

const ACTIVATION_EVIDENCE = Object.freeze([
  "deletion-replay-first-receipt.json",
  "deletion-replay-second-receipt.json",
  "logical-backup-manifest.json",
  "logical-offsite-result.json",
  "logical-restore-receipt.json",
  "logical-worm-result.json",
  "logical-worm-retrieval-receipt.json",
  "offsite-retrieval-receipt.json",
  "pitr-receipt.json",
  "private-storage-capture-receipt.json",
  "private-storage-recovery-manifest.json",
  "private-storage-restore-receipt.json",
  "private-storage-worm-receipt.json",
  "private-storage-worm-retrieval-receipt.json",
  "recovered-smoke-receipt.json",
  "storage-purge-receipt.json",
  "railway-teardown-terminal.json",
  "supabase-teardown-terminal.json",
]);

const EXACT_SCHEMA_ACTIVATION_EVIDENCE = Object.freeze([
  "deletion-replay-first-receipt.json", "deletion-replay-second-receipt.json",
  "logical-backup-manifest.json", "logical-offsite-result.json",
  "logical-restore-receipt.json", "logical-worm-result.json",
  "logical-worm-retrieval-receipt.json", "offsite-retrieval-receipt.json",
  "pitr-receipt.json", "private-storage-capture-receipt.json",
  "private-storage-recovery-manifest.json", "private-storage-restore-receipt.json",
  "private-storage-worm-receipt.json", "private-storage-worm-retrieval-receipt.json",
  "recovered-smoke-receipt.json", "storage-purge-receipt.json",
  "railway-teardown-terminal.json", "supabase-teardown-terminal.json",
]);

interface VerifiedActivation {
  readonly receipt: Json;
  readonly github: Json;
  readonly smoke: Json;
  readonly storagePurge: Json;
  readonly railwayTeardown: Json;
  readonly supabaseTeardown: Json;
  readonly privateWorm: Json;
  readonly privateWormRetrieval: Json;
  readonly logicalWormRetrieval: Json;
}

function verifyActivation(
  files: ReadonlyMap<string, HeldFile>,
  json: (name: string) => Json,
  candidateSha: string,
  repository: string | undefined,
): VerifiedActivation {
  if (sha256ProductionPromotionRecoveryValue(ACTIVATION_EVIDENCE)
    !== sha256ProductionPromotionRecoveryValue(EXACT_SCHEMA_ACTIVATION_EVIDENCE)) {
    fail("activation_schema_coverage_invalid");
  }
  const receipt = json("activation-receipt");
  const github = json("activation-github-authority");
  const { receiptSha256, ...receiptWithoutHash } = receipt;
  const evidenceByLeaf = new Map<string, string>();
  if (Array.isArray(receipt.evidence)) {
    for (const value of receipt.evidence) {
      if (!isObject(value) || typeof value.leaf !== "string"
        || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)
        || evidenceByLeaf.has(value.leaf)) fail("activation_receipt_invalid");
      evidenceByLeaf.set(value.leaf, value.sha256);
    }
  }
  const fileByLeaf = new Map<string, string>([
    ["deletion-replay-first-receipt.json", "deletion-replay-first-receipt"],
    ["deletion-replay-second-receipt.json", "deletion-replay-second-receipt"],
    ["logical-backup-manifest.json", "logical-backup-manifest"],
    ["logical-offsite-result.json", "logical-offsite-result"],
    ["logical-restore-receipt.json", "logical-restore-receipt"],
    ["logical-worm-result.json", "logical-worm-result"],
    ["logical-worm-retrieval-receipt.json", "logical-worm-retrieval-receipt"],
    ["offsite-retrieval-receipt.json", "offsite-retrieval-receipt"],
    ["pitr-receipt.json", "pitr-receipt"],
    ["private-storage-capture-receipt.json", "private-storage-capture-receipt"],
    ["private-storage-recovery-manifest.json", "private-storage-recovery-manifest"],
    ["private-storage-restore-receipt.json", "private-storage-restore-receipt"],
    ["private-storage-worm-receipt.json", "private-storage-worm-receipt"],
    ["private-storage-worm-retrieval-receipt.json", "private-storage-worm-retrieval-receipt"],
    ["recovered-smoke-receipt.json", "recovered-smoke-receipt"],
    ["storage-purge-receipt.json", "storage-purge-receipt"],
    ["railway-teardown-terminal.json", "railway-teardown-terminal"],
    ["supabase-teardown-terminal.json", "supabase-teardown-terminal"],
  ]);
  if (
    !exactKeys(receipt, [
      "schemaVersion", "kind", "candidateSha", "producerWorkflow",
      "producerRunId", "producerRunAttempt", "completedAt",
      "targetProjectIdSha256", "targetEnvironmentIdSha256",
      "targetDatabaseIdentitySha256", "targetSupabaseOriginSha256",
      "evidence", "evidenceAggregateSha256", "cleanupEvidenceAggregateSha256",
      "allOperationsExact", "targetAbsent", "receiptSha256",
    ])
    || receipt.schemaVersion !== 1
    || receipt.kind !== "pintpath-production-promotion-recovery-activation"
    || receipt.candidateSha !== candidateSha
    || receipt.producerWorkflow !== "activate-production-promotion-recovery.yml"
    || typeof receipt.producerRunId !== "string"
    || !/^[1-9][0-9]{0,19}$/.test(receipt.producerRunId)
    || receipt.producerRunAttempt !== "1"
    || receipt.allOperationsExact !== true || receipt.targetAbsent !== true
    || ACTIVATION_EVIDENCE.length !== evidenceByLeaf.size
    || ACTIVATION_EVIDENCE.some((leaf) => !evidenceByLeaf.has(leaf))
    || [receipt.targetProjectIdSha256, receipt.targetEnvironmentIdSha256,
      receipt.targetDatabaseIdentitySha256, receipt.targetSupabaseOriginSha256]
      .some((value) => typeof value !== "string" || !SHA256.test(value))
    || receipt.evidenceAggregateSha256 !== sha256ProductionPromotionRecoveryValue(
      ACTIVATION_EVIDENCE.map((leaf) => ({ leaf, sha256: evidenceByLeaf.get(leaf) })),
    )
    || receipt.cleanupEvidenceAggregateSha256 !== sha256ProductionPromotionRecoveryValue([
      { leaf: "railway-teardown-terminal.json",
        sha256: evidenceByLeaf.get("railway-teardown-terminal.json") },
      { leaf: "storage-purge-receipt.json",
        sha256: evidenceByLeaf.get("storage-purge-receipt.json") },
      { leaf: "supabase-teardown-terminal.json",
        sha256: evidenceByLeaf.get("supabase-teardown-terminal.json") },
    ])
    || receiptSha256 !== sha256ProductionPromotionRecoveryValue(receiptWithoutHash)
  ) fail("activation_receipt_invalid");
  exactTimestamp(receipt.completedAt);
  for (const [leaf, name] of fileByLeaf) {
    if (evidenceByLeaf.get(leaf) !== files.get(name)!.sha256) {
      fail("activation_evidence_mismatch");
    }
  }
  if (
    !exactKeys(github, [
      "schemaVersion", "kind", "repository", "candidateSha", "workflowPath",
      "workflowRunId", "workflowRunAttempt", "workflowRunStartedAt", "workflowEvent",
      "workflowConclusion", "artifactName", "artifactId", "artifactDigest",
      "artifactSizeBytes", "artifactExpired",
    ])
    || github.schemaVersion !== 1
    || github.kind !== "pintpath-production-promotion-recovery-activation-github-authority"
    || github.repository !== repository || github.candidateSha !== candidateSha
    || github.workflowPath !== ".github/workflows/activate-production-promotion-recovery.yml"
    || github.workflowRunId !== receipt.producerRunId
    || github.workflowRunAttempt !== 1 || github.workflowEvent !== "workflow_dispatch"
    || github.workflowConclusion !== "success" || github.artifactExpired !== false
    || github.artifactName !== `pintpath-production-promotion-recovery-activation-${candidateSha}`
    || typeof github.artifactId !== "string" || !/^[1-9][0-9]{0,19}$/.test(github.artifactId)
    || typeof github.artifactDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(github.artifactDigest)
    || !Number.isSafeInteger(github.artifactSizeBytes) || Number(github.artifactSizeBytes) < 1
  ) fail("activation_github_authority_invalid");
  const workflowRunStartedAt = exactTimestamp(github.workflowRunStartedAt);
  if (Date.parse(workflowRunStartedAt) > Date.parse(String(receipt.completedAt))) {
    fail("activation_github_authority_invalid");
  }
  const privateWorm = parseExactEvidence(productionRecoveryPrivateWormResultSchema,
    json("private-storage-worm-receipt"), "private_storage_worm_invalid");
  const privateWormRetrieval = parseExactEvidence(
    productionRecoveryPrivateWormRetrievalSchema,
    json("private-storage-worm-retrieval-receipt"), "private_storage_worm_invalid",
  );
  let logicalManifest: ReturnType<typeof parsePostgresLogicalBackupManifest>;
  let recoveryManifest: ReturnType<
    typeof postgresPrivateStorageRecoveryInternals.parseRecoveryManifest
  >;
  try {
    logicalManifest = parsePostgresLogicalBackupManifest(
      files.get("logical-backup-manifest")!.source,
    );
    recoveryManifest = postgresPrivateStorageRecoveryInternals.parseRecoveryManifest(
      files.get("private-storage-recovery-manifest")!.source,
    );
  } catch {
    fail("recovery_manifest_invalid");
  }
  const logicalArchive = isObject(logicalManifest.archive) ? logicalManifest.archive : null;
  const logicalState = isObject(logicalManifest.state) ? logicalManifest.state : null;
  const logicalWorm = parseExactEvidence(productionRecoveryLogicalWormResultSchema,
    json("logical-worm-result"), "logical_worm_invalid");
  const logicalWormRetrieval = parseExactEvidence(productionRecoveryLogicalWormRetrievalSchema,
    json("logical-worm-retrieval-receipt"), "logical_worm_retrieval_invalid");
  const logicalRestore = parseExactEvidence(productionRecoveryLogicalRestoreReceiptSchema,
    json("logical-restore-receipt"), "logical_restore_invalid");
  const capture = parseExactEvidence(productionRecoveryPrivateCaptureSchema,
    json("private-storage-capture-receipt"), "private_storage_capture_invalid");
  const storageRestore = parseExactEvidence(productionRecoveryPrivateRestoreSchema,
    json("private-storage-restore-receipt"), "private_storage_restore_invalid");
  const offsite = parseExactEvidence(productionRecoveryLogicalOffsiteResultSchema,
    json("logical-offsite-result"), "logical_offsite_invalid");
  const offsiteRetrieval = parseExactEvidence(productionRecoveryLogicalOffsiteRetrievalSchema,
    json("offsite-retrieval-receipt"), "offsite_retrieval_invalid");
  const expectedBackupIdSha256 = sha256ProductionPromotionRecoveryBytes(
    `${logicalManifest.createdAt.replace(/[-:.]/g, "")}-${
      files.get("logical-backup-manifest")!.sha256}`,
  );
  const offsiteLocalArtifacts = [
    { filename: "manifest.json", bytes: offsiteRetrieval.manifestBytes,
      sha256: offsiteRetrieval.manifestSha256, mode: "0600" },
    { filename: "pintpath-postgres.dump", bytes: offsiteRetrieval.archiveBytes,
      sha256: offsiteRetrieval.archiveSha256, mode: "0600" },
    { filename: "state-receipt.json", bytes: offsiteRetrieval.stateReceiptBytes,
      sha256: offsiteRetrieval.stateReceiptSha256, mode: "0600" },
  ];
  if (offsite.backupCreatedAt !== logicalManifest.createdAt
    || offsite.archiveSha256 !== logicalManifest.archive.sha256
    || offsite.manifestSha256 !== files.get("logical-backup-manifest")!.sha256
    || offsite.stateReceiptSha256 !== logicalManifest.state.receiptSha256
    || offsite.sourceDatabaseIdentitySha256
      !== logicalManifest.state.sourceDatabaseIdentitySha256
    || offsite.overallStateSha256 !== logicalManifest.state.overallStateSha256
    || offsite.backupIdSha256 !== expectedBackupIdSha256
    || Date.parse(offsiteRetrieval.retrievedAt) < Date.parse(offsite.completedAt)
    || offsiteRetrieval.successStateSha256 !== offsite.successStateSha256
    || offsiteRetrieval.backupCreatedAt !== offsite.backupCreatedAt
    || offsiteRetrieval.backupIdSha256 !== offsite.backupIdSha256
    || offsiteRetrieval.latestPointerSha256 !== offsite.latestPointerSha256
    || offsiteRetrieval.attestationSha256 !== offsite.attestationSha256
    || offsiteRetrieval.remoteObjectSetSha256 !== offsite.remoteObjectSetSha256
    || offsiteRetrieval.archiveSha256 !== offsite.archiveSha256
    || offsiteRetrieval.manifestSha256 !== offsite.manifestSha256
    || offsiteRetrieval.stateReceiptSha256 !== offsite.stateReceiptSha256
    || offsiteRetrieval.sourceDatabaseIdentitySha256 !== offsite.sourceDatabaseIdentitySha256
    || offsiteRetrieval.overallStateSha256 !== offsite.overallStateSha256
    || offsiteRetrieval.archiveBytes !== logicalManifest.archive.bytes
    || offsiteRetrieval.manifestBytes !== files.get("logical-backup-manifest")!.source.length
    || offsiteRetrieval.localArtifactSetSha256
      !== sha256ProductionPromotionRecoveryValue(offsiteLocalArtifacts)) {
    fail("offsite_retrieval_invalid");
  }
  const privateWormCompletedAt = exactTimestamp(privateWorm.completedAt);
  const privateWormMinimumRetainUntil = exactTimestamp(privateWorm.minimumRetainUntil);
  const privateWormRetrievedAt = exactTimestamp(privateWormRetrieval.recoveredAt);
  const logicalWormCompletedAt = exactTimestamp(logicalWorm.completedAt);
  const logicalWormRetrievedAt = exactTimestamp(logicalWormRetrieval.retrievedAt);
  const logicalRestoreAt = exactTimestamp(logicalRestore.restoredAt);
  if (!logicalArchive || !logicalState
    || logicalWorm.backupCreatedAt !== logicalManifest.createdAt
    || logicalWorm.archiveSha256 !== logicalArchive.sha256
    || logicalWorm.manifestSha256 !== files.get("logical-backup-manifest")!.sha256
    || logicalWorm.stateReceiptSha256 !== logicalState.receiptSha256
    || logicalWorm.overallStateSha256 !== logicalState.overallStateSha256
    || logicalWorm.backupIdSha256
      !== sha256ProductionPromotionRecoveryBytes(
        `${String(logicalManifest.createdAt).replace(/[-:.]/g, "")}-${
          files.get("logical-backup-manifest")!.sha256}`,
      )
    || logicalWormRetrieval.backupCreatedAt !== logicalManifest.createdAt
    || logicalWormRetrieval.archiveSha256 !== logicalArchive.sha256
    || logicalWormRetrieval.manifestSha256 !== files.get("logical-backup-manifest")!.sha256
    || logicalWormRetrieval.stateReceiptSha256 !== logicalState.receiptSha256
    || logicalWormRetrieval.sourceDatabaseIdentitySha256
      !== logicalState.sourceDatabaseIdentitySha256
    || logicalWormRetrieval.overallStateSha256 !== logicalState.overallStateSha256
    || logicalWormRetrieval.wormResultSha256 !== files.get("logical-worm-result")!.sha256
    || logicalWormRetrieval.wormReceiptSha256 !== logicalWorm.receiptSha256
    || logicalWormRetrieval.immutableObjectSetSha256
      !== logicalWorm.immutableObjectSetSha256
    || logicalWormRetrieval.backupIdSha256 !== logicalWorm.backupIdSha256
    || logicalWormRetrieval.recoveryAccountIdSha256
      !== logicalWorm.recoveryAccountIdSha256
    || logicalWormRetrieval.bucketNameSha256 !== logicalWorm.bucketNameSha256
    || logicalWormRetrieval.readerPrincipalArnSha256
      !== logicalWorm.readerPrincipalArnSha256
    || logicalWormRetrieval.minimumRetainUntil !== logicalWorm.minimumRetainUntil
    || !Number.isSafeInteger(logicalWormRetrieval.archiveBytes)
    || logicalWormRetrieval.archiveBytes !== logicalArchive.bytes
    || !Number.isSafeInteger(logicalWormRetrieval.manifestBytes)
    || logicalWormRetrieval.manifestBytes !== files.get("logical-backup-manifest")!.source.length
    || !Number.isSafeInteger(logicalWormRetrieval.stateReceiptBytes)
    || Number(logicalWormRetrieval.stateReceiptBytes) < 1
    || logicalWormRetrieval.localArtifactSetSha256
      !== sha256ProductionPromotionRecoveryValue([
        { filename: logicalArchive.file, bytes: logicalWormRetrieval.archiveBytes,
          sha256: logicalWormRetrieval.archiveSha256 },
        { filename: "manifest.json", bytes: logicalWormRetrieval.manifestBytes,
          sha256: logicalWormRetrieval.manifestSha256 },
        { filename: logicalState.receiptFile, bytes: logicalWormRetrieval.stateReceiptBytes,
          sha256: logicalWormRetrieval.stateReceiptSha256 },
      ])
    || logicalRestore.backupManifestSha256 !== logicalWormRetrieval.manifestSha256
    || logicalRestore.backupArchiveSha256 !== logicalWormRetrieval.archiveSha256
    || logicalRestore.targetIdentitySha256 !== storageRestore.targetDatabaseIdentitySha256
    || logicalRestore.targetUrlSha256 !== storageRestore.destinationConnectionUrlSha256
    || logicalRestore.authoritativeTableCount !== logicalState.authoritativeTableCount
    || logicalRestore.authoritativeRowCount !== logicalState.authoritativeRowCount
    || logicalRestore.schemaMetadataSha256 !== logicalState.schemaMetadataSha256
    || logicalRestore.expectedSourceStateReceiptSha256
      !== logicalWormRetrieval.stateReceiptSha256
    || logicalRestore.sourceSnapshotBindingSha256 !== logicalState.snapshotBindingSha256
    || logicalRestore.expectedSourceTableSetSha256 !== logicalState.tableSetSha256
    || logicalRestore.expectedSourceDataSha256 !== logicalState.transformedDataSha256
    || logicalRestore.expectedSourceStateTotalsSha256 !== logicalState.stateTotalsSha256
    || logicalRestore.expectedSourceKeyRangesSha256 !== logicalState.keyRangesSha256
    || logicalRestore.expectedArchivedControlTableSetSha256
      !== logicalState.archivedControlTableSetSha256
    || logicalRestore.expectedArchivedControlDataSha256
      !== logicalState.archivedControlDataSha256
    || logicalRestore.expectedArchivedControlKeyRangesSha256
      !== logicalState.archivedControlKeyRangesSha256
    || logicalRestore.expectedSourceOverallStateSha256
      !== logicalWormRetrieval.overallStateSha256
    || Date.parse(logicalWormRetrievedAt) < Date.parse(logicalWormCompletedAt)
    || Date.parse(logicalRestoreAt) < Date.parse(logicalWormRetrievedAt)) {
    fail("logical_worm_retrieval_invalid");
  }
  if (logicalManifest.schemaVersion !== 3
    || privateWorm.candidateSha !== candidateSha
    || recoveryManifest.logicalBackup.candidateSha !== candidateSha
    || recoveryManifest.logicalBackup.sourceEnvironment !== "production"
    || recoveryManifest.capturedAt !== capture.capturedAt
    || recoveryManifest.logicalBackup.archiveSha256 !== logicalManifest.archive.sha256
    || recoveryManifest.logicalBackup.stateReceiptSha256 !== logicalManifest.state.receiptSha256
    || recoveryManifest.logicalBackup.sourceDatabaseIdentitySha256
      !== logicalManifest.state.sourceDatabaseIdentitySha256
    || recoveryManifest.logicalBackup.sourceUrlSha256 !== logicalManifest.state.sourceUrlSha256
    || recoveryManifest.logicalBackup.overallStateSha256
      !== logicalManifest.state.overallStateSha256
    || capture.logicalBackupManifestSha256 !== files.get("logical-backup-manifest")!.sha256
    || capture.recoverySetSha256 !== recoveryManifest.recoverySetSha256
    || capture.recoveryManifestSha256
      !== files.get("private-storage-recovery-manifest")!.sha256
    || capture.storageObjectCount !== recoveryManifest.sourceStorage.objectCount
    || capture.databaseReferenceCount !== recoveryManifest.sourceStorage.databaseReferenceCount
    || capture.deletionTombstoneCount !== recoveryManifest.deletionAuthority.tombstoneCount
    || capture.databaseConnectionUrlSha256 !== recoveryManifest.logicalBackup.captureUrlSha256
    || capture.databaseTransportRootCaDerSha256
      !== logicalManifest.transport.rootCaCertificateSha256
    || storageRestore.candidateSha !== candidateSha
    || storageRestore.targetDatabaseIdentitySha256 !== receipt.targetDatabaseIdentitySha256
    || storageRestore.recoverySetSha256 !== recoveryManifest.recoverySetSha256
    || storageRestore.recoveryManifestSha256
      !== files.get("private-storage-recovery-manifest")!.sha256
    || storageRestore.restoredObjectCount !== recoveryManifest.sourceStorage.objectCount
    || storageRestore.restoredBytes !== recoveryManifest.sourceStorage.totalBytes
    || storageRestore.destinationObjectSetSha256 !== recoveryManifest.sourceStorage.objectSetSha256
    || storageRestore.deletionAuthoritySetSha256
      !== recoveryManifest.deletionAuthority.authoritySetSha256
    || storageRestore.destinationOriginSha256 !== receipt.targetSupabaseOriginSha256
    || storageRestore.destinationBucketNameSha256 !== recoveryManifest.sourceStorage.bucketNameSha256
    || storageRestore.databaseTransportRootCaDerSha256
      !== logicalManifest.transport.rootCaCertificateSha256
    || storageRestore.destinationConnectionUrlSha256 === capture.databaseConnectionUrlSha256
    || storageRestore.destinationRailwayProjectIdSha256 !== receipt.targetProjectIdSha256
    || storageRestore.destinationRailwayEnvironmentIdSha256 !== receipt.targetEnvironmentIdSha256
    || privateWorm.recoverySetSha256 !== capture.recoverySetSha256
    || privateWorm.recoverySetSha256 !== storageRestore.recoverySetSha256
    || privateWorm.recoveryManifestSha256
      !== files.get("private-storage-recovery-manifest")!.sha256
    || privateWorm.recoveryManifestSha256 !== capture.recoveryManifestSha256
    || privateWorm.recoveryManifestSha256 !== storageRestore.recoveryManifestSha256
    || privateWorm.logicalBackupManifestSha256
      !== files.get("logical-backup-manifest")!.sha256
    || Date.parse(privateWormMinimumRetainUntil) <= Date.parse(privateWormCompletedAt)
    || privateWormRetrieval.candidateSha !== candidateSha
    || privateWormRetrieval.recoverySetSha256 !== privateWorm.recoverySetSha256
    || privateWormRetrieval.recoveryManifestSha256 !== privateWorm.recoveryManifestSha256
    || privateWormRetrieval.bundleManifestSha256 !== privateWorm.bundleManifestSha256
    || privateWormRetrieval.logicalBackupManifestSha256
      !== privateWorm.logicalBackupManifestSha256
    || privateWormRetrieval.wormResultSha256
      !== files.get("private-storage-worm-receipt")!.sha256
    || privateWormRetrieval.wormReceiptSha256 !== privateWorm.receiptSha256
    || privateWormRetrieval.immutableObjectSetSha256
      !== privateWorm.immutableObjectSetSha256
    || privateWormRetrieval.recoveryAccountIdSha256
      !== privateWorm.recoveryAccountIdSha256
    || privateWormRetrieval.bucketNameSha256 !== privateWorm.bucketNameSha256
    || privateWormRetrieval.readerPrincipalArnSha256 !== privateWorm.readerPrincipalArnSha256
    || privateWormRetrieval.minimumRetainUntil !== privateWorm.minimumRetainUntil
    || Date.parse(privateWormRetrievedAt) < Date.parse(privateWormCompletedAt)
    || privateWormRetrieval.recoveredEntryCount
      !== Number(storageRestore.restoredObjectCount) + 4) {
    fail("private_storage_worm_invalid");
  }
  const pitr = parseExactEvidence(productionRecoveryPitrReceiptSchema,
    json("pitr-receipt"), "pitr_invalid");
  let firstReplay, secondReplay;
  try {
    firstReplay = parsePostgresAccountDeletionReplayReceipt(
      json("deletion-replay-first-receipt"),
    );
    secondReplay = parsePostgresAccountDeletionReplayReceipt(
      json("deletion-replay-second-receipt"),
    );
  } catch {
    fail("deletion_replay_invalid");
  }
  const smoke = parseExactEvidence(productionRecoveryRecoveredApplicationSchema,
    json("recovered-smoke-receipt"), "recovered_application_invalid");
  if (pitr.candidateSha !== candidateSha || pitr.recoveryPointAt !== logicalManifest.createdAt
    || smoke.candidateSha !== candidateSha
    || smoke.targetIdentitySha256 !== receipt.targetDatabaseIdentitySha256
    || smoke.runtimeRoleExact !== true || smoke.maintenanceRoleRestricted !== true
    || smoke.applicationStateReady !== true || smoke.deletionPrivacyReconciled !== true
    || smoke.compiledArtifactExact !== true || smoke.compiledApplicationStarted !== true
    || smoke.startupProbeExact !== true || smoke.startupRouteReady !== true
    || smoke.readyProbeExact !== true || smoke.readyRouteReady !== true
    || smoke.authenticatedBoundaryExact !== true || smoke.authenticatedRuntimeExact !== true
    || smoke.restoredAuthAccountPreexistingExact !== true
    || smoke.noAdminOrVenueElevationExact !== true || smoke.noPrivateDataLeakageExact !== true
    || smoke.crossProjectTokenParserRejectedLocallyExact !== true
    || smoke.appSessionRevokedExact !== true || smoke.providerSessionLogoutExact !== true
    || smoke.automaticMaintenanceWorkersExternalWritesDisabledExact !== true
    || smoke.runtimeDependencyBoundaryExact !== true
    || smoke.childOutputBoundedRedactedExact !== true || smoke.childTerminatedExact !== true
    || smoke.applicationChildTerminated !== true
    || smoke.databaseAuthoritiesClosedExact !== true || smoke.transportClosedExact !== true
    || smoke.supabaseOriginSha256 !== receipt.targetSupabaseOriginSha256
    || smoke.firstReplayReceiptSha256 !== files.get("deletion-replay-first-receipt")!.sha256
    || smoke.secondReplayReceiptSha256 !== files.get("deletion-replay-second-receipt")!.sha256
    || smoke.semanticProjectionSha256 !== firstReplay.semanticProjectionSha256
    || smoke.semanticProjectionSha256 !== secondReplay.semanticProjectionSha256
    || smoke.tombstoneCount !== firstReplay.ledgerTombstoneCount
    || smoke.tombstoneCount !== secondReplay.ledgerTombstoneCount
    || !SHA256.test(String(smoke.compiledArtifactSha256))
    || !SHA256.test(String(smoke.compiledEntrypointSha256))
    || !SHA256.test(String(smoke.authSubjectSha256))
    || !SHA256.test(String(smoke.authEmailSha256))
    || !SHA256.test(String(smoke.supabasePublishableKeySha256))
    || !SHA256.test(String(smoke.runtimeDatabaseUrlSha256))
    || !SHA256.test(String(smoke.maintenanceDatabaseUrlSha256))
    || smoke.runtimeDatabaseUrlSha256 === smoke.maintenanceDatabaseUrlSha256
    || smoke.maintenanceDatabaseUrlSha256 !== storageRestore.destinationConnectionUrlSha256
    || !SHA256.test(String(smoke.redisUrlSha256))
    || smoke.transportProfile !== STOCK_LOCALHOST_PROFILE
    || smoke.transportRootCaDerSha256 !== storageRestore.databaseTransportRootCaDerSha256
    || smoke.transportRootCaDerSha256 !== firstReplay.transportRootCaDerSha256
    || smoke.transportRootCaDerSha256 !== secondReplay.transportRootCaDerSha256) {
    fail("recovered_application_invalid");
  }
  const storagePurge = parseExactEvidence(productionRecoveryStoragePurgeReceiptSchema,
    json("storage-purge-receipt"), "storage_purge_invalid");
  if (storagePurge.candidateSha !== candidateSha
    || storagePurge.destinationOriginSha256 !== receipt.targetSupabaseOriginSha256
    || storagePurge.targetRailwayProjectIdSha256 !== receipt.targetProjectIdSha256
    || storagePurge.targetRailwayEnvironmentIdSha256 !== receipt.targetEnvironmentIdSha256
    || storagePurge.targetDatabaseIdentitySha256 !== receipt.targetDatabaseIdentitySha256
    || storagePurge.bucketNameSha256
      !== sha256ProductionPromotionRecoveryBytes("beermap-source-evidence")
    || storagePurge.destinationRestoreAuthoritySha256
      !== storageRestore.destinationAuthoritySha256
    || storagePurge.recoverySetSha256 !== recoveryManifest.recoverySetSha256
    || storagePurge.recoveryManifestSha256
      !== files.get("private-storage-recovery-manifest")!.sha256
    || storagePurge.restoreReceiptSha256
      !== files.get("private-storage-restore-receipt")!.sha256
    || storagePurge.restoredObjectSetSha256 !== storageRestore.destinationObjectSetSha256
    || storagePurge.removedObjectCount !== storageRestore.restoredObjectCount) {
    fail("storage_purge_invalid");
  }
  const railwayTeardown = parseExactEvidence(productionRecoveryRailwayTeardownTerminalSchema,
    json("railway-teardown-terminal"), "railway_teardown_invalid");
  const railwayReceipt = railwayTeardown.receipt;
  if (railwayReceipt.candidateSha !== candidateSha
    || railwayReceipt.observedCleanupRunId !== receipt.producerRunId
    || railwayReceipt.signedActivationRunId !== receipt.producerRunId
    || sha256ProductionPromotionRecoveryBytes(String(railwayReceipt.projectId))
      !== receipt.targetProjectIdSha256
    || sha256ProductionPromotionRecoveryBytes(String(railwayReceipt.environmentId))
      !== receipt.targetEnvironmentIdSha256) fail("railway_teardown_invalid");
  const supabaseTeardown = parseExactEvidence(productionRecoverySupabaseTeardownTerminalSchema,
    json("supabase-teardown-terminal"), "supabase_teardown_invalid");
  const supabaseReceipt = supabaseTeardown.receipt;
  if (supabaseReceipt.candidateSha !== candidateSha
    || supabaseReceipt.observedCleanupRunId !== receipt.producerRunId
    || supabaseReceipt.signedActivationRunId !== receipt.producerRunId
    || supabaseReceipt.purgeReceiptSha256 !== files.get("storage-purge-receipt")!.sha256
    || supabaseReceipt.destinationOriginSha256 !== receipt.targetSupabaseOriginSha256
    || supabaseReceipt.destinationOriginSha256 !== sha256ProductionPromotionRecoveryBytes(
      `https://${supabaseReceipt.projectRef}.supabase.co`,
    )
    || storagePurge.destinationProjectRefSha256
      !== sha256ProductionPromotionRecoveryBytes(supabaseReceipt.projectRef)
    || supabaseReceipt.destinationRestoreAuthoritySha256
      !== storageRestore.destinationAuthoritySha256
    || sha256ProductionPromotionRecoveryBytes(supabaseReceipt.targetRailwayProjectId)
      !== receipt.targetProjectIdSha256
    || sha256ProductionPromotionRecoveryBytes(supabaseReceipt.targetRailwayEnvironmentId)
      !== receipt.targetEnvironmentIdSha256) {
    fail("supabase_teardown_invalid");
  }
  return { receipt, github, smoke, storagePurge, railwayTeardown, supabaseTeardown,
    privateWorm, privateWormRetrieval, logicalWormRetrieval };
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
    "activation-receipt", "activation-github-authority",
    "closed-route-receipt",
    "closed-route-terminal", "apply-authorization-receipt", "apply-operation-receipt",
    "pitr-receipt", "logical-backup-manifest", "logical-offsite-result",
    "logical-worm-result", "logical-worm-retrieval-receipt",
    "private-storage-capture-receipt",
    "private-storage-recovery-manifest", "offsite-retrieval-receipt",
    "logical-restore-receipt", "private-storage-restore-receipt",
    "deletion-replay-first-receipt", "deletion-replay-second-receipt",
    "private-storage-worm-receipt", "private-storage-worm-retrieval-receipt",
    "recovered-smoke-receipt", "storage-purge-receipt",
    "railway-teardown-terminal", "supabase-teardown-terminal",
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
  exactFile("logical-worm-retrieval-receipt",
    authority.logicalWormRetrievalReceiptSha256);
  exactFile("private-storage-capture-receipt", authority.privateStorageCaptureReceiptSha256);
  exactFile("offsite-retrieval-receipt", authority.offsiteRetrievalReceiptSha256);
  exactFile("logical-restore-receipt", authority.logicalRestoreReceiptSha256);
  exactFile("private-storage-restore-receipt", authority.privateStorageRestoreReceiptSha256);
  exactFile("deletion-replay-first-receipt", authority.deletionReplayFirstReceiptSha256);
  exactFile("deletion-replay-second-receipt", authority.deletionReplaySecondReceiptSha256);
  exactFile("activation-receipt", authority.activationReceiptSha256);
  exactFile("activation-github-authority", authority.activationGithubAuthoritySha256);
  exactFile("private-storage-worm-receipt", authority.privateStorageWormReceiptSha256);
  exactFile("private-storage-worm-retrieval-receipt",
    authority.privateStorageWormRetrievalReceiptSha256);
  exactFile("recovered-smoke-receipt", authority.recoveredApplicationReceiptSha256);
  exactFile("storage-purge-receipt", authority.storagePurgeReceiptSha256);
  exactFile("railway-teardown-terminal", authority.railwayTeardownTerminalSha256);
  exactFile("supabase-teardown-terminal", authority.supabaseTeardownTerminalSha256);

  const activation = verifyActivation(
    files,
    json,
    candidateSha,
    dependencies.env.GITHUB_REPOSITORY,
  );
  const activationEvidenceAggregateSha256 = sha256ProductionPromotionRecoveryValue(
    ACTIVATION_EVIDENCE.map((leaf) => {
      const entry = (activation.receipt.evidence as Json[]).find((value) => value.leaf === leaf);
      return { leaf, sha256: entry?.sha256 };
    }),
  );
  const cleanupEvidenceAggregateSha256 = sha256ProductionPromotionRecoveryValue([
    { leaf: "railway-teardown-terminal.json",
      sha256: files.get("railway-teardown-terminal")!.sha256 },
    { leaf: "storage-purge-receipt.json", sha256: files.get("storage-purge-receipt")!.sha256 },
    { leaf: "supabase-teardown-terminal.json",
      sha256: files.get("supabase-teardown-terminal")!.sha256 },
  ]);
  if (authority.activationProducerRepository !== activation.github.repository
    || authority.activationProducerWorkflowPath !== activation.github.workflowPath
    || authority.activationProducerRunId !== activation.github.workflowRunId
    || authority.activationProducerRunAttempt !== activation.github.workflowRunAttempt
    || authority.recoveryStartedAt !== activation.github.workflowRunStartedAt
    || authority.activationArtifactName !== activation.github.artifactName
    || authority.activationArtifactId !== activation.github.artifactId
    || authority.activationArtifactDigest !== activation.github.artifactDigest
    || authority.activationArtifactSizeBytes !== activation.github.artifactSizeBytes
    || authority.activationEvidenceAggregateSha256 !== activationEvidenceAggregateSha256
    || authority.cleanupEvidenceAggregateSha256 !== cleanupEvidenceAggregateSha256) {
    fail("activation_authority_binding_invalid");
  }

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
  const wormRetrieval = json("logical-worm-retrieval-receipt");
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
    wormRetrieval.schemaVersion !== 1
    || wormRetrieval.kind !== "pintpath-postgres-logical-worm-retrieval"
    || wormRetrieval.ok !== true
    || wormRetrieval.wormResultSha256 !== files.get("logical-worm-result")!.sha256
    || wormRetrieval.wormReceiptSha256 !== worm.receiptSha256
    || wormRetrieval.manifestSha256 !== files.get("logical-backup-manifest")!.sha256
    || wormRetrieval.archiveSha256 !== manifest.archive.sha256
    || wormRetrieval.stateReceiptSha256 !== manifest.state.receiptSha256
    || wormRetrieval.sourceDatabaseIdentitySha256
      !== manifest.state.sourceDatabaseIdentitySha256
    || wormRetrieval.overallStateSha256 !== manifest.state.overallStateSha256
  ) fail("logical_worm_retrieval_invalid");
  if (
    capture.schemaVersion !== 1
    || capture.kind !== "pintpath-postgres-private-storage-recovery-capture"
    || capture.ok !== true
    || capture.databaseTransportProfile !== STOCK_LOCALHOST_PROFILE
    || capture.databaseEffectiveRole !== "pintpath_migrator"
    || !SHA256.test(String(capture.databaseConnectionUrlSha256))
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
    || recoveryManifest.logicalBackup.sourceDatabaseIdentitySha256
      !== manifest.state.sourceDatabaseIdentitySha256
    || recoveryManifest.logicalBackup.sourceUrlSha256 !== manifest.state.sourceUrlSha256
    || recoveryManifest.logicalBackup.captureUrlSha256
      !== capture.databaseConnectionUrlSha256
    || recoveryManifest.logicalBackup.captureUrlSha256
      === recoveryManifest.logicalBackup.sourceUrlSha256
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
    || replayOne.backupManifestSha256 !== files.get("logical-backup-manifest")!.sha256
    || replayTwo.backupManifestSha256 !== files.get("logical-backup-manifest")!.sha256
    || replayOne.backupArchiveSha256 !== manifest.archive.sha256
    || replayTwo.backupArchiveSha256 !== manifest.archive.sha256
    || replayOne.sourceStateReceiptSha256 !== manifest.state.receiptSha256
    || replayTwo.sourceStateReceiptSha256 !== manifest.state.receiptSha256
    || replayOne.sourceSnapshotBindingSha256 !== manifest.state.snapshotBindingSha256
    || replayTwo.sourceSnapshotBindingSha256 !== manifest.state.snapshotBindingSha256
    || replayOne.expectedSourceOverallStateSha256 !== manifest.state.overallStateSha256
    || replayTwo.expectedSourceOverallStateSha256 !== manifest.state.overallStateSha256
    || replayOne.restoredOverallStateSha256 !== restore.restoredOverallStateSha256
    || replayTwo.restoredOverallStateSha256 !== restore.restoredOverallStateSha256
    || replayOne.migrationRunSha256 !== recoveryManifest.logicalBackup.migrationRunSha256
    || replayTwo.migrationRunSha256 !== recoveryManifest.logicalBackup.migrationRunSha256
    || replayOne.migrationCandidateSha !== candidateSha
    || replayTwo.migrationCandidateSha !== candidateSha
    || replayOne.ledgerCurrentSha256 !== recoveryManifest.deletionAuthority.currentSha256
    || replayTwo.ledgerCurrentSha256 !== recoveryManifest.deletionAuthority.currentSha256
    || replayOne.ledgerGenesisSha256 !== recoveryManifest.deletionAuthority.genesisSha256
    || replayTwo.ledgerGenesisSha256 !== recoveryManifest.deletionAuthority.genesisSha256
    || replayOne.ledgerCheckpointSha256 !== recoveryManifest.deletionAuthority.checkpointSha256
    || replayTwo.ledgerCheckpointSha256 !== recoveryManifest.deletionAuthority.checkpointSha256
    || replayOne.ledgerImmutableSetSha256 !== recoveryManifest.deletionAuthority.immutableSetSha256
    || replayTwo.ledgerImmutableSetSha256 !== recoveryManifest.deletionAuthority.immutableSetSha256
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
  if (
    activation.receipt.targetDatabaseIdentitySha256 !== targetIdentity
    || activation.receipt.targetDatabaseIdentitySha256
      !== activation.smoke.targetIdentitySha256
    || activation.privateWorm.recoverySetSha256 !== recoveryManifest.recoverySetSha256
    || activation.privateWorm.recoveryManifestSha256
      !== files.get("private-storage-recovery-manifest")!.sha256
    || activation.privateWormRetrieval.recoverySetSha256
      !== recoveryManifest.recoverySetSha256
    || activation.logicalWormRetrieval.wormResultSha256
      !== files.get("logical-worm-result")!.sha256
    || activation.logicalWormRetrieval.manifestSha256
      !== files.get("logical-backup-manifest")!.sha256
    || activation.smoke.firstReplayReceiptSha256
      !== files.get("deletion-replay-first-receipt")!.sha256
    || activation.smoke.secondReplayReceiptSha256
      !== files.get("deletion-replay-second-receipt")!.sha256
    || activation.smoke.semanticProjectionSha256 !== replayTwo.semanticProjectionSha256
  ) fail("activation_state_binding_invalid");

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
    logicalWormRetrieval: exactTimestamp(wormRetrieval.retrievedAt),
    logicalRestore: exactTimestamp(restore.restoredAt),
    privateRestore: exactTimestamp(storageRestore.restoredAt),
    replayOne: exactTimestamp(replayOne.replayedAt), replayTwo: exactTimestamp(replayTwo.replayedAt),
    privateWormSeal: exactTimestamp(activation.privateWorm.completedAt),
    privateWormRetrieval: exactTimestamp(activation.privateWormRetrieval.recoveredAt),
    applicationReady: exactTimestamp(activation.smoke.applicationReadyAt),
    applicationCompleted: exactTimestamp(activation.smoke.completedAt),
    purgeCompleted: exactTimestamp(activation.storagePurge.completedAt),
    railwayCleanupCompleted: exactTimestamp(
      (activation.railwayTeardown.receipt as Json).completedAt,
    ),
    supabaseCleanupCompleted: exactTimestamp(
      (activation.supabaseTeardown.receipt as Json).completedAt,
    ),
    activationCompleted: exactTimestamp(activation.receipt.completedAt),
    reviewerOne: approvalOne.payload.approvedAt, reviewerTwo: approvalTwo.payload.approvedAt,
  };
  const time = (name: keyof typeof times) => Date.parse(times[name]);
  const recoveryStartedAt = Date.parse(authority.recoveryStartedAt);
  const applicationReadyAt = Date.parse(authority.applicationReadyAt);
  const recoveryCompletedAt = Date.parse(authority.recoveryCompletedAt);
  const cleanupStartedAt = Date.parse(authority.cleanupStartedAt);
  const cleanupCompletedAt = Date.parse(authority.cleanupCompletedAt);
  const rpo = Math.floor((time("backup") - time("apply")) / 1_000);
  const rto = Math.floor((applicationReadyAt - recoveryStartedAt) / 1_000);
  const cleanupSeconds = Math.floor((cleanupCompletedAt - cleanupStartedAt) / 1_000);
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
    || time("logicalWormRetrieval") < time("worm")
    || time("logicalRestore") < Math.max(time("retrieval"), time("logicalWormRetrieval"))
    || time("privateRestore") < time("logicalRestore")
    || time("replayOne") < time("privateRestore") || time("replayTwo") <= time("replayOne")
    || time("privateWormSeal") < time("privateCapture")
    || time("privateWormRetrieval") < time("privateWormSeal")
    || time("logicalRestore") < time("privateWormRetrieval")
    || time("applicationReady") < time("replayTwo")
    || time("applicationCompleted") < time("applicationReady")
    || time("purgeCompleted") < time("applicationCompleted")
    || time("railwayCleanupCompleted") < time("purgeCompleted")
    || time("supabaseCleanupCompleted") < time("purgeCompleted")
    || time("activationCompleted") < Math.max(
      time("railwayCleanupCompleted"), time("supabaseCleanupCompleted"),
    )
    || approvalsAfterRecovery < time("activationCompleted")
    || !Number.isFinite(nowMs) || nowMs < Math.max(time("reviewerOne"), time("reviewerTwo"))
    || Object.keys(times).some((name) => time(name as keyof typeof times) > nowMs)
    || nowMs - Math.min(time("reviewerOne"), time("reviewerTwo")) > MAX_APPROVAL_AGE_MS
    || authority.recoveryPointAt !== times.backup || pitr.recoveryPointAt !== times.backup
    || authority.pitrObservedAt !== times.pitr
    || authority.logicalWormRetrievedAt !== times.logicalWormRetrieval
    || authority.applicationReadyAt !== times.applicationReady
    || authority.recoveryCompletedAt !== times.applicationCompleted
    || authority.cleanupStartedAt !== times.applicationCompleted
    || authority.cleanupCompletedAt !== times.activationCompleted
    || authority.recoveryStartedAt !== activation.github.workflowRunStartedAt
    || recoveryStartedAt <= time("apply")
    || recoveryStartedAt > Math.min(time("retrieval"), time("logicalWormRetrieval"))
    || cleanupStartedAt < recoveryCompletedAt || cleanupCompletedAt < cleanupStartedAt
    || authority.rpoSeconds !== rpo || authority.rtoSeconds !== rto
    || authority.cleanupSeconds !== cleanupSeconds
    || rpo < 0 || rpo > 3_600 || rto < 1 || rto > 14_400
    || cleanupSeconds < 0 || cleanupSeconds > 3_600
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
    activationReceiptSha256: files.get("activation-receipt")!.sha256,
    activationGithubAuthoritySha256: files.get("activation-github-authority")!.sha256,
    activationProducerWorkflow: "activate-production-promotion-recovery.yml",
    activationProducerRunId: String(activation.receipt.producerRunId),
    activationProducerRunAttempt: 1,
    activationRepository: String(activation.github.repository),
    activationArtifactName: String(activation.github.artifactName),
    activationArtifactId: String(activation.github.artifactId),
    activationArtifactDigest: String(activation.github.artifactDigest),
    activationArtifactSizeBytes: Number(activation.github.artifactSizeBytes),
    activationTargetProjectIdSha256: exactSha(activation.receipt.targetProjectIdSha256),
    activationTargetEnvironmentIdSha256: exactSha(
      activation.receipt.targetEnvironmentIdSha256,
    ),
    activationTargetSupabaseOriginSha256: exactSha(
      activation.receipt.targetSupabaseOriginSha256,
    ),
    privateStorageWormReceiptSha256: files.get("private-storage-worm-receipt")!.sha256,
    privateStorageWormRetrievalReceiptSha256:
      files.get("private-storage-worm-retrieval-receipt")!.sha256,
    recoveredApplicationReceiptSha256: files.get("recovered-smoke-receipt")!.sha256,
    storagePurgeReceiptSha256: files.get("storage-purge-receipt")!.sha256,
    railwayTeardownTerminalSha256: files.get("railway-teardown-terminal")!.sha256,
    supabaseTeardownTerminalSha256: files.get("supabase-teardown-terminal")!.sha256,
    activationEvidenceAggregateSha256,
    cleanupEvidenceAggregateSha256,
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
    logicalWormRetrievalReceiptSha256:
      authority.logicalWormRetrievalReceiptSha256,
    logicalWormRetrievedAt: times.logicalWormRetrieval,
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
    deletionReplayCompletedAt: times.replayTwo,
    recoveryStartedAt: authority.recoveryStartedAt,
    recoveryTargetIdentitySha256: targetIdentity,
    applicationReadyAt: times.applicationReady,
    recoveredApplicationCompletedAt: times.applicationCompleted,
    cleanupStartedAt: times.applicationCompleted,
    cleanupCompletedAt: times.activationCompleted,
    recoveryPointAt: times.backup, rpoSeconds: rpo, rtoSeconds: rto, cleanupSeconds,
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
      activationProducerExact: true, recoveredApplicationExact: true,
      teardownAbsentExact: true,
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
