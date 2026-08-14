import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import { POSTGRES_PRIVATE_STORAGE_BUCKET } from "../src/lib/postgres-private-storage-recovery.js";
import { assertOperatorMutationAllowed } from "./lib/operator-mutation-guard.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";
import { fetchBoundedResponseText } from "./lib/bounded-http-response.js";
import {
  emergencyCleanupSha256,
  parseEmergencyCleanupState,
  priorAcknowledgementFor,
  type EmergencyCleanupState,
} from "./lib/production-promotion-recovery-emergency-cleanup-state.js";
import {
  holdPrivateDirectoryIdentity,
  readTrustedRegularFile,
  writePrivateExclusiveFile,
  type HeldPrivateDirectoryIdentity,
  type PrivateDirectoryIdentity,
} from "./lib/trusted-filesystem.js";

export const PROTECTED_DISPOSABLE_SUPABASE_PROJECT_TEARDOWN_SCHEMA =
  "pintpath-protected-disposable-supabase-project-teardown-terminal/v1" as const;
export const PROTECTED_DISPOSABLE_SUPABASE_PROJECT_TEARDOWN_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;
export const SUPABASE_MANAGEMENT_ORIGIN = "https://api.supabase.com" as const;
export const SUPABASE_PROJECT_DELETE_METHOD = "DELETE" as const;
export const SUPABASE_ORGANIZATION_PROJECTS_PAGE_SIZE = 100 as const;

const POLICY_PATH =
  "ops/supabase/protected-disposable-project-teardown-policy.json";
const POLICY_SHA256 =
  "fd3a45234a02ba3df8fadb6e2f36d1070a72be75eec792986f85abd74e5f6796";
const REPOSITORY = "blackmagic30/Beer";
const ACTIVATION_WORKFLOW_PATH =
  ".github/workflows/activate-production-promotion-recovery.yml";
const EMERGENCY_CLEANUP_WORKFLOW_PATH =
  ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROJECTS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;
const FORBIDDEN_PROJECT_REFS = Object.freeze([
  "bbfibbadwjxzrcdncavy",
  "hfbmhdxrwtihukmixxta",
  "jxpubqlmqnnqwadmjgyk",
]);
const ARGUMENTS = new Set([
  "--candidate-sha",
  "--activation-run-id",
  "--project-ref",
  "--project-name",
  "--organization-slug",
  "--organization-slug-sha256",
  "--destination-origin-sha256",
  "--target-railway-project-id",
  "--target-railway-environment-id",
  "--cleanup-mode",
  "--destination-restore-authority-sha256",
  "--emergency-cleanup-arm-authority-sha256",
  "--emergency-cleanup-state-file",
  "--emergency-cleanup-state-sha256",
  "--purge-receipt-file",
  "--purge-receipt-sha256",
  "--teardown-authority-file",
  "--teardown-authority-sha256",
  "--teardown-authority-public-key-file",
  "--teardown-authority-public-key-sha256",
  "--read-token-file",
  "--delete-token-file",
  "--evidence-dir",
  "--output",
]);
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const PROJECT_NAME = /^pintpath-disposable-restore-[a-z0-9][a-z0-9-]{0,79}$/;
const ORGANIZATION_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TOKEN = /^[^\r\n\0\s]{20,4096}$/;

type Json = Record<string, unknown>;

interface TeardownArgs {
  readonly candidateSha: string;
  readonly activationRunId: string;
  readonly projectRef: string;
  readonly projectName: string;
  readonly organizationSlug: string;
  readonly organizationSlugSha256: string;
  readonly destinationOrigin: string;
  readonly destinationOriginSha256: string;
  readonly targetRailwayProjectId: string;
  readonly targetRailwayEnvironmentId: string;
  readonly cleanupMode: "orderly" | "emergency";
  readonly destinationRestoreAuthoritySha256: string;
  readonly emergencyCleanupArmAuthoritySha256: string;
  readonly emergencyCleanupStateFile: string | null;
  readonly emergencyCleanupStateSha256: string | null;
  readonly purgeReceiptFile: string | null;
  readonly purgeReceiptSha256: string | null;
  readonly teardownAuthorityFile: string;
  readonly teardownAuthoritySha256: string;
  readonly teardownAuthorityPublicKeyFile: string;
  readonly teardownAuthorityPublicKeySha256: string;
  readonly readTokenFile: string;
  readonly deleteTokenFile: string;
  readonly evidenceDir: string;
  readonly output: string;
}

interface ProjectInventoryEntry {
  readonly ref: string;
  readonly name: string;
  readonly cloudProvider: string;
  readonly region: string;
  readonly isBranch: boolean;
  readonly status:
    | "ACTIVE_HEALTHY"
    | "ACTIVE_UNHEALTHY"
    | "COMING_UP"
    | "UNKNOWN"
    | "GOING_DOWN"
    | "INIT_FAILED"
    | "REMOVED"
    | "RESTORING"
    | "UPGRADING"
    | "PAUSING"
    | "RESTORE_FAILED"
    | "RESTARTING"
    | "PAUSE_FAILED"
    | "RESIZING"
    | "INACTIVE";
  readonly insertedAt: string;
  readonly databasesSha256: string;
}

interface DirectProjectEntry {
  readonly ref: string;
  readonly name: string;
  readonly organizationSlug: string;
  readonly sourceSha256: string;
}

interface TeardownChecks {
  policyExact: boolean;
  githubAuthorityExact: boolean;
  targetNotProtected: boolean;
  orderlyPurgeEvidenceExactOrNotRequired: boolean;
  signedAuthorityExact: boolean;
  credentialsSeparatedExact: boolean;
  preflightInventoryExact: boolean;
  targetMetadataExact: boolean;
  durableIntentExact: boolean;
  deleteAttemptedAtMostOnce: boolean;
  acknowledgementExact: boolean;
  postflightAttempted: boolean;
  targetAbsentExact: boolean;
  terminalEvidenceExact: boolean;
}

export class ProtectedDisposableSupabaseProjectTeardownError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProtectedDisposableSupabaseProjectTeardownError";
  }
}

function fail(code: string): never {
  throw new ProtectedDisposableSupabaseProjectTeardownError(code);
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function exactTimestamp(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail(code);
  return value;
}

function exactSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function parseCanonical(source: string, code: string): Json {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail(code);
  }
  if (!record(value) || canonicalPostgresBackupJson(value) !== source)
    fail(code);
  return value;
}

function exactAbsolute(value: string): string {
  if (
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.includes("\0")
  ) {
    fail("arguments_invalid");
  }
  return value;
}

function exactAbsoluteOrNone(value: string): string | null {
  return value === "none" ? null : exactAbsolute(value);
}

function assertOutputReady(
  filename: string,
  evidenceDir: HeldPrivateDirectoryIdentity,
): void {
  const output = exactAbsolute(filename);
  evidenceDir.assertExact();
  if (path.dirname(output) !== evidenceDir.path || fs.existsSync(output))
    fail("output_unsafe");
  const intent = path.join(
    evidenceDir.path,
    "supabase-project-delete-intent.json",
  );
  if (fs.existsSync(intent)) fail("output_unsafe");
}

function writePrivateExclusive(
  filename: string,
  value: object,
  expectedDirectoryIdentity?: PrivateDirectoryIdentity,
): string {
  const source = canonicalPostgresBackupJson(value);
  try {
    writePrivateExclusiveFile(
      path.dirname(filename),
      path.basename(filename),
      source,
      {
        requireExactDirectoryMode: true,
        requireOwner: true,
        ...(expectedDirectoryIdentity ? { expectedDirectoryIdentity } : {}),
      },
    );
  } catch {
    fail("evidence_write_failed");
  }
  return sha256(source);
}

async function readPrivateFile(filename: string): Promise<string> {
  try {
    return readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 64 * 1024,
      requireOwner: true,
      requirePrivate: true,
    }).toString("utf8");
  } catch {
    fail("private_file_unsafe");
  }
}

function parseArgs(argv: readonly string[]): TeardownArgs {
  let values: ReadonlyMap<string, string>;
  try {
    values = parseStrictArguments(argv, {
      allowed: ARGUMENTS,
      required: ARGUMENTS,
    });
  } catch {
    fail("arguments_invalid");
  }
  const candidateSha = values.get("--candidate-sha")!;
  const activationRunId = values.get("--activation-run-id")!;
  const projectRef = values.get("--project-ref")!;
  const projectName = values.get("--project-name")!;
  const organizationSlug = values.get("--organization-slug")!;
  const organizationSlugSha256 = values.get("--organization-slug-sha256")!;
  const destinationOrigin = `https://${projectRef}.supabase.co`;
  const destinationOriginSha256 = values.get("--destination-origin-sha256")!;
  const targetRailwayProjectId = values.get("--target-railway-project-id")!;
  const targetRailwayEnvironmentId = values.get(
    "--target-railway-environment-id",
  )!;
  const emergencyCleanupStateFile = exactAbsoluteOrNone(
    values.get("--emergency-cleanup-state-file")!,
  );
  const emergencyCleanupStateSha256 =
    values.get("--emergency-cleanup-state-sha256") === "none"
      ? null
      : values.get("--emergency-cleanup-state-sha256")!;
  if (
    !SHA.test(candidateSha) ||
    !/^[1-9]\d{0,19}$/.test(activationRunId) ||
    !PROJECT_REF.test(projectRef) ||
    !PROJECT_NAME.test(projectName) ||
    !ORGANIZATION_SLUG.test(organizationSlug) ||
    organizationSlugSha256 !== sha256(organizationSlug) ||
    destinationOriginSha256 !== sha256(destinationOrigin) ||
    !UUID.test(targetRailwayProjectId) ||
    !UUID.test(targetRailwayEnvironmentId) ||
    (values.get("--cleanup-mode") !== "orderly" &&
      values.get("--cleanup-mode") !== "emergency") ||
    !SHA256.test(values.get("--destination-restore-authority-sha256")!) ||
    !SHA256.test(values.get("--emergency-cleanup-arm-authority-sha256")!) ||
    (emergencyCleanupStateFile === null) !==
      (emergencyCleanupStateSha256 === null) ||
    (emergencyCleanupStateSha256 !== null &&
      !SHA256.test(emergencyCleanupStateSha256)) ||
    (values.get("--cleanup-mode") === "orderly" &&
      !SHA256.test(values.get("--purge-receipt-sha256")!)) ||
    (values.get("--cleanup-mode") === "emergency" &&
      (values.get("--purge-receipt-file") !== "none" ||
        values.get("--purge-receipt-sha256") !== "none")) ||
    !SHA256.test(values.get("--teardown-authority-sha256")!) ||
    !SHA256.test(values.get("--teardown-authority-public-key-sha256")!)
  ) {
    fail("arguments_invalid");
  }
  return {
    candidateSha,
    activationRunId,
    projectRef,
    projectName,
    organizationSlug,
    organizationSlugSha256,
    destinationOrigin,
    destinationOriginSha256,
    targetRailwayProjectId,
    targetRailwayEnvironmentId,
    cleanupMode: values.get("--cleanup-mode") as "orderly" | "emergency",
    destinationRestoreAuthoritySha256: values.get(
      "--destination-restore-authority-sha256",
    )!,
    emergencyCleanupArmAuthoritySha256: values.get(
      "--emergency-cleanup-arm-authority-sha256",
    )!,
    emergencyCleanupStateFile,
    emergencyCleanupStateSha256,
    purgeReceiptFile:
      values.get("--cleanup-mode") === "orderly"
        ? exactAbsolute(values.get("--purge-receipt-file")!)
        : null,
    purgeReceiptSha256:
      values.get("--cleanup-mode") === "orderly"
        ? values.get("--purge-receipt-sha256")!
        : null,
    teardownAuthorityFile: exactAbsolute(
      values.get("--teardown-authority-file")!,
    ),
    teardownAuthoritySha256: values.get("--teardown-authority-sha256")!,
    teardownAuthorityPublicKeyFile: exactAbsolute(
      values.get("--teardown-authority-public-key-file")!,
    ),
    teardownAuthorityPublicKeySha256: values.get(
      "--teardown-authority-public-key-sha256",
    )!,
    readTokenFile: exactAbsolute(values.get("--read-token-file")!),
    deleteTokenFile: exactAbsolute(values.get("--delete-token-file")!),
    evidenceDir: exactAbsolute(values.get("--evidence-dir")!),
    output: exactAbsolute(values.get("--output")!),
  };
}

function policyExact(cwd: string): boolean {
  try {
    const source = fs.readFileSync(path.resolve(cwd, POLICY_PATH));
    const value = JSON.parse(source.toString("utf8")) as unknown;
    return (
      sha256(source) === POLICY_SHA256 &&
      record(value) &&
      value.schemaVersion ===
        "pintpath-protected-disposable-supabase-project-teardown-policy/v2" &&
      value.policyId === "pintpath-disposable-supabase-project-teardown" &&
      value.activationState ===
        PROTECTED_DISPOSABLE_SUPABASE_PROJECT_TEARDOWN_STATE &&
      value.githubEnvironment === "production-promotion-recovery-cleanup" &&
      value.repository === REPOSITORY &&
      value.activationWorkflowPath === ACTIVATION_WORKFLOW_PATH &&
      value.emergencyCleanupWorkflowPath === EMERGENCY_CLEANUP_WORKFLOW_PATH &&
      value.requiredGitRef === "refs/heads/main" &&
      value.requiredRunAttempt === 1 &&
      record(value.targetContract) &&
      value.targetContract
        .signedAuthorityRepositoryWorkflowRefAttemptAndActivationRunIdRequired ===
        true &&
      value.targetContract.signedEmergencyCleanupArmAuthoritySha256Required ===
        true &&
      JSON.stringify(value.targetContract.forbiddenProjectRefs) ===
        JSON.stringify(FORBIDDEN_PROJECT_REFS) &&
      record(value.executionContract) &&
      value.executionContract.observedCleanupRunIdRecorded === true &&
      value.executionContract.activationRunCleanupRequiresSameRunId === true &&
      value.executionContract.emergencyControllerMayUseDistinctRunId === true &&
      value.executionContract.emergencyControllerRequiresArmedAuthority ===
        true &&
      value.executionContract.emergencyControllerRequiresEmergencyMode ===
        true &&
      value.executionContract
        .emergencyControllerReceiptsAcceptedForGreenActivation === false &&
      value.executionContract.requiredRunAttempt === 1 &&
      JSON.stringify(value.executionContract.allowedEmergencyEvents) ===
        JSON.stringify(["schedule", "workflow_dispatch", "workflow_run"]) &&
      record(value.providerContract) &&
      value.providerContract.origin === SUPABASE_MANAGEMENT_ORIGIN &&
      value.providerContract.inventoryMethod === "GET" &&
      value.providerContract.inventoryPath ===
        "/v1/organizations/{slug}/projects" &&
      value.providerContract.inventoryPageSize ===
        SUPABASE_ORGANIZATION_PROJECTS_PAGE_SIZE &&
      value.providerContract.directProjectReadMethod === "GET" &&
      value.providerContract.directProjectReadPath === "/v1/projects/{ref}" &&
      value.providerContract.directProjectAbsentStatus === 404 &&
      value.providerContract.directPreflightAndPrewriteReassertionRequired ===
        true &&
      value.providerContract.consecutiveDirectPostflightAbsenceReadsRequired ===
        2 &&
      value.providerContract.deleteMethod === SUPABASE_PROJECT_DELETE_METHOD &&
      value.providerContract.deletePath === "/v1/projects/{ref}" &&
      value.providerContract.maximumDeleteAttempts === 1 &&
      value.providerContract.automaticRetriesAllowed === false &&
      value.providerContract.unconditionalReadReconciliationRequired === true &&
      record(value.credentials) &&
      JSON.stringify(value.credentials.readPermissions) ===
        JSON.stringify(["organization_projects_read", "project_admin_read"]) &&
      value.credentials.deletePermission === "project_admin_write"
    );
  } catch {
    return false;
  }
}

function verifyPurgeReceipt(source: string, args: TeardownArgs): void {
  if (
    args.cleanupMode !== "orderly" ||
    !args.purgeReceiptSha256 ||
    sha256(source) !== args.purgeReceiptSha256
  )
    fail("purge_receipt_invalid");
  const value = parseCanonical(source, "purge_receipt_invalid");
  if (
    !exactKeys(value, [
      "schemaVersion",
      "kind",
      "ok",
      "candidateSha",
      "completedAt",
      "destinationProjectRefSha256",
      "targetRailwayProjectIdSha256",
      "targetRailwayEnvironmentIdSha256",
      "targetDatabaseIdentitySha256",
      "targetConnectionUrlSha256",
      "destinationOriginSha256",
      "bucketNameSha256",
      "destinationRestoreAuthoritySha256",
      "purgeAuthoritySha256",
      "purgeAuthorityPublicKeySha256",
      "purgeAuthorityReviewerIdSha256",
      "recoverySetSha256",
      "recoveryManifestSha256",
      "restoreReceiptSha256",
      "restoredObjectSetSha256",
      "removedObjectCount",
      "bucketPrivateExact",
      "restoredObjectSetExact",
      "concurrentObjectSetAbsent",
      "storageObjectsAbsentExact",
      "receiptSha256",
    ])
  )
    fail("purge_receipt_invalid");
  const { receiptSha256, ...withoutHash } = value;
  const shaFields = [
    value.destinationProjectRefSha256,
    value.targetRailwayProjectIdSha256,
    value.targetRailwayEnvironmentIdSha256,
    value.targetDatabaseIdentitySha256,
    value.targetConnectionUrlSha256,
    value.destinationOriginSha256,
    value.bucketNameSha256,
    value.destinationRestoreAuthoritySha256,
    value.purgeAuthoritySha256,
    value.purgeAuthorityPublicKeySha256,
    value.purgeAuthorityReviewerIdSha256,
    value.recoverySetSha256,
    value.recoveryManifestSha256,
    value.restoreReceiptSha256,
    value.restoredObjectSetSha256,
    receiptSha256,
  ];
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "pintpath-postgres-private-storage-recovery-target-purge" ||
    value.ok !== true ||
    value.candidateSha !== args.candidateSha ||
    exactTimestamp(value.completedAt, "purge_receipt_invalid") === "" ||
    !shaFields.every(exactSha256) ||
    value.destinationProjectRefSha256 !== sha256(args.projectRef) ||
    value.targetRailwayProjectIdSha256 !==
      sha256(args.targetRailwayProjectId) ||
    value.targetRailwayEnvironmentIdSha256 !==
      sha256(args.targetRailwayEnvironmentId) ||
    value.destinationOriginSha256 !== args.destinationOriginSha256 ||
    value.bucketNameSha256 !== sha256(POSTGRES_PRIVATE_STORAGE_BUCKET) ||
    value.destinationRestoreAuthoritySha256 !==
      args.destinationRestoreAuthoritySha256 ||
    typeof value.removedObjectCount !== "number" ||
    !Number.isSafeInteger(value.removedObjectCount) ||
    value.removedObjectCount < 0 ||
    value.bucketPrivateExact !== true ||
    value.restoredObjectSetExact !== true ||
    value.concurrentObjectSetAbsent !== true ||
    value.storageObjectsAbsentExact !== true ||
    receiptSha256 !== sha256(canonicalPostgresBackupJson(withoutHash))
  )
    fail("purge_receipt_invalid");
}

interface VerifiedTeardownAuthority {
  readonly reviewerIdSha256: string;
  readonly signedActivationRunId: string;
}

function verifySignedAuthority(input: {
  readonly source: string;
  readonly sourceSha256: string;
  readonly publicKeyPem: string;
  readonly publicKeySha256: string;
  readonly args: TeardownArgs;
  readonly now: Date;
}): VerifiedTeardownAuthority {
  if (
    sha256(input.source) !== input.sourceSha256 ||
    sha256(input.publicKeyPem) !== input.publicKeySha256
  )
    fail("authority_invalid");
  const envelope = parseCanonical(input.source, "authority_invalid");
  const payload = envelope.payload;
  if (
    !exactKeys(envelope, ["schemaVersion", "payload", "signatureBase64"]) ||
    envelope.schemaVersion !==
      "pintpath-disposable-supabase-project-teardown-authority/v2" ||
    !record(payload) ||
    !exactKeys(payload, [
      "schemaVersion",
      "operation",
      "candidateSha",
      "projectRef",
      "projectName",
      "destinationOrigin",
      "destinationOriginSha256",
      "organizationSlug",
      "organizationSlugSha256",
      "targetRailwayProjectId",
      "targetRailwayEnvironmentId",
      "repository",
      "workflowPath",
      "requiredGitRef",
      "requiredRunAttempt",
      "requiredGithubRunId",
      "emergencyCleanupArmAuthoritySha256",
      "destinationRestoreAuthoritySha256",
      "reviewerIdSha256",
      "reviewerPublicKeySha256",
      "issuedAt",
      "expiresAt",
    ]) ||
    typeof envelope.signatureBase64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      envelope.signatureBase64,
    )
  )
    fail("authority_invalid");
  const issuedAt = exactTimestamp(payload.issuedAt, "authority_invalid");
  const expiresAt = exactTimestamp(payload.expiresAt, "authority_invalid");
  const nowMs = input.now.getTime();
  const args = input.args;
  if (
    payload.schemaVersion !==
      "pintpath-disposable-supabase-project-teardown-authority-payload/v2" ||
    payload.operation !== "delete-exact-disposable-supabase-project" ||
    payload.candidateSha !== args.candidateSha ||
    payload.projectRef !== args.projectRef ||
    payload.projectName !== args.projectName ||
    payload.destinationOrigin !== args.destinationOrigin ||
    payload.destinationOriginSha256 !== args.destinationOriginSha256 ||
    payload.organizationSlug !== args.organizationSlug ||
    payload.organizationSlugSha256 !== args.organizationSlugSha256 ||
    payload.targetRailwayProjectId !== args.targetRailwayProjectId ||
    payload.targetRailwayEnvironmentId !== args.targetRailwayEnvironmentId ||
    payload.repository !== REPOSITORY ||
    payload.workflowPath !== ACTIVATION_WORKFLOW_PATH ||
    payload.requiredGitRef !== "refs/heads/main" ||
    payload.requiredRunAttempt !== 1 ||
    payload.requiredGithubRunId !== args.activationRunId ||
    payload.emergencyCleanupArmAuthoritySha256 !==
      args.emergencyCleanupArmAuthoritySha256 ||
    payload.destinationRestoreAuthoritySha256 !==
      args.destinationRestoreAuthoritySha256 ||
    payload.reviewerPublicKeySha256 !== input.publicKeySha256 ||
    typeof payload.reviewerIdSha256 !== "string" ||
    !SHA256.test(payload.reviewerIdSha256) ||
    !Number.isFinite(nowMs) ||
    Date.parse(issuedAt) > nowMs ||
    Date.parse(expiresAt) <= nowMs ||
    Date.parse(expiresAt) - Date.parse(issuedAt) > 86_400_000
  )
    fail("authority_invalid");
  try {
    const key = crypto.createPublicKey(input.publicKeyPem);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !crypto.verify(
        null,
        Buffer.from(canonicalPostgresBackupJson(payload)),
        key,
        Buffer.from(envelope.signatureBase64, "base64"),
      )
    )
      fail("authority_invalid");
  } catch {
    fail("authority_invalid");
  }
  return {
    reviewerIdSha256: payload.reviewerIdSha256,
    signedActivationRunId: args.activationRunId,
  };
}

function parseProject(value: unknown): ProjectInventoryEntry {
  const statuses = new Set([
    "ACTIVE_HEALTHY",
    "ACTIVE_UNHEALTHY",
    "COMING_UP",
    "UNKNOWN",
    "GOING_DOWN",
    "INIT_FAILED",
    "REMOVED",
    "RESTORING",
    "UPGRADING",
    "PAUSING",
    "RESTORE_FAILED",
    "RESTARTING",
    "PAUSE_FAILED",
    "RESIZING",
    "INACTIVE",
  ]);
  if (
    !record(value) ||
    !exactKeys(value, [
      "ref",
      "name",
      "cloud_provider",
      "region",
      "is_branch",
      "status",
      "inserted_at",
      "databases",
    ]) ||
    typeof value.ref !== "string" ||
    !PROJECT_REF.test(value.ref) ||
    typeof value.name !== "string" ||
    value.name.length < 1 ||
    value.name.length > 128 ||
    typeof value.cloud_provider !== "string" ||
    value.cloud_provider.length < 1 ||
    typeof value.region !== "string" ||
    value.region.length < 1 ||
    typeof value.is_branch !== "boolean" ||
    typeof value.status !== "string" ||
    !statuses.has(value.status) ||
    typeof value.inserted_at !== "string" ||
    value.inserted_at.length < 1 ||
    !Array.isArray(value.databases) ||
    value.databases.length < 1
  )
    fail("inventory_invalid");
  for (const database of value.databases) {
    const requiredKeys = [
      "region",
      "status",
      "cloud_provider",
      "identifier",
      "type",
    ];
    const optionalKeys = [
      "infra_compute_size",
      "disk_volume_size_gb",
      "disk_type",
      "disk_throughput_mbps",
      "disk_last_modified_at",
    ];
    if (
      !record(database) ||
      !requiredKeys.every((key) => Object.hasOwn(database, key)) ||
      Object.keys(database).some(
        (key) => !requiredKeys.includes(key) && !optionalKeys.includes(key),
      ) ||
      !["region", "status", "cloud_provider", "identifier", "type"].every(
        (key) =>
          typeof database[key] === "string" &&
          (database[key] as string).length > 0,
      ) ||
      (Object.hasOwn(database, "infra_compute_size") &&
        (typeof database.infra_compute_size !== "string" ||
          database.infra_compute_size.length < 1)) ||
      (Object.hasOwn(database, "disk_volume_size_gb") &&
        (typeof database.disk_volume_size_gb !== "number" ||
          !Number.isFinite(database.disk_volume_size_gb) ||
          database.disk_volume_size_gb < 0)) ||
      (Object.hasOwn(database, "disk_throughput_mbps") &&
        (typeof database.disk_throughput_mbps !== "number" ||
          !Number.isFinite(database.disk_throughput_mbps) ||
          database.disk_throughput_mbps < 0)) ||
      (Object.hasOwn(database, "disk_type") &&
        (typeof database.disk_type !== "string" ||
          database.disk_type.length < 1)) ||
      (Object.hasOwn(database, "disk_last_modified_at") &&
        (typeof database.disk_last_modified_at !== "string" ||
          database.disk_last_modified_at.length < 1))
    )
      fail("inventory_invalid");
  }
  return {
    ref: value.ref,
    name: value.name,
    cloudProvider: value.cloud_provider,
    region: value.region,
    isBranch: value.is_branch,
    status: value.status as ProjectInventoryEntry["status"],
    insertedAt: value.inserted_at,
    databasesSha256: sha256(canonicalPostgresBackupJson(value.databases)),
  };
}

function parseDirectProject(value: unknown): DirectProjectEntry {
  if (
    !record(value) ||
    !exactKeys(value, [
      "id",
      "ref",
      "organization_id",
      "organization_slug",
      "name",
      "region",
      "created_at",
      "status",
      "database",
    ]) ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 128 ||
    typeof value.ref !== "string" ||
    !PROJECT_REF.test(value.ref) ||
    typeof value.organization_id !== "string" ||
    value.organization_id.length < 1 ||
    value.organization_id.length > 128 ||
    typeof value.organization_slug !== "string" ||
    !ORGANIZATION_SLUG.test(value.organization_slug) ||
    typeof value.name !== "string" ||
    value.name.length < 1 ||
    value.name.length > 128 ||
    typeof value.region !== "string" ||
    value.region.length < 1 ||
    value.region.length > 128 ||
    typeof value.created_at !== "string" ||
    value.created_at.length < 1 ||
    typeof value.status !== "string" ||
    value.status.length < 1 ||
    value.status.length > 64 ||
    !record(value.database) ||
    !exactKeys(value.database, [
      "host",
      "version",
      "postgres_engine",
      "release_channel",
    ]) ||
    Object.values(value.database).some(
      (entry) =>
        typeof entry !== "string" || entry.length < 1 || entry.length > 512,
    )
  ) {
    fail("project_read_invalid");
  }
  return {
    ref: value.ref,
    name: value.name,
    organizationSlug: value.organization_slug,
    sourceSha256: sha256(canonicalPostgresBackupJson(value)),
  };
}

async function providerResponse(
  fetchImpl: typeof fetch,
  request: string | URL | Request,
  init: RequestInit,
  requestTimeoutMs: number,
): Promise<{ readonly response: Response; readonly source: string }> {
  try {
    const signal = AbortSignal.timeout(requestTimeoutMs);
    return await fetchBoundedResponseText(fetchImpl, request, init, {
      maximumBytes: MAX_RESPONSE_BYTES,
      signal,
    });
  } catch {
    fail("provider_invalid");
  }
}

function responseJson(response: Response, source: string): unknown {
  if (
    !response.ok ||
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    fail("provider_invalid");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    fail("provider_invalid");
  }
}

async function listProjects(
  fetchImpl: typeof fetch,
  organizationSlug: string,
  token: string,
  requestTimeoutMs: number,
): Promise<readonly ProjectInventoryEntry[]> {
  const projects: ProjectInventoryEntry[] = [];
  let offset = 0;
  let count: number | null = null;
  while (count === null || offset < count) {
    const url = new URL(
      `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects`,
      SUPABASE_MANAGEMENT_ORIGIN,
    );
    url.searchParams.set("offset", String(offset));
    url.searchParams.set(
      "limit",
      String(SUPABASE_ORGANIZATION_PROJECTS_PAGE_SIZE),
    );
    const bounded = await providerResponse(
      fetchImpl,
      url,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        redirect: "error",
        cache: "no-store",
      },
      requestTimeoutMs,
    );
    const value = responseJson(bounded.response, bounded.source);
    if (
      !record(value) ||
      !exactKeys(value, ["projects", "pagination"]) ||
      !Array.isArray(value.projects) ||
      value.projects.length > SUPABASE_ORGANIZATION_PROJECTS_PAGE_SIZE ||
      !record(value.pagination) ||
      !exactKeys(value.pagination, ["count", "limit", "offset"]) ||
      typeof value.pagination.count !== "number" ||
      !Number.isSafeInteger(value.pagination.count) ||
      value.pagination.count < 0 ||
      value.pagination.count > MAX_PROJECTS ||
      value.pagination.limit !== SUPABASE_ORGANIZATION_PROJECTS_PAGE_SIZE ||
      value.pagination.offset !== offset
    )
      fail("inventory_invalid");
    if (count === null) count = value.pagination.count;
    if (
      count !== value.pagination.count ||
      offset + value.projects.length > count ||
      (offset < count && value.projects.length === 0)
    )
      fail("inventory_invalid");
    projects.push(...value.projects.map(parseProject));
    offset += value.projects.length;
  }
  if (
    count === null ||
    projects.length !== count ||
    new Set(projects.map((value) => value.ref)).size !== projects.length
  ) {
    fail("inventory_invalid");
  }
  return Object.freeze(
    [...projects].sort((left, right) => left.ref.localeCompare(right.ref)),
  );
}

async function readProject(
  fetchImpl: typeof fetch,
  projectRef: string,
  token: string,
  requestTimeoutMs: number,
): Promise<DirectProjectEntry | null> {
  const { response, source } = await providerResponse(
    fetchImpl,
    new URL(`/v1/projects/${projectRef}`, SUPABASE_MANAGEMENT_ORIGIN),
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      cache: "no-store",
    },
    requestTimeoutMs,
  );
  if (response.status === 404) return null;
  if (
    !response.ok ||
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    fail("provider_invalid");
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    fail("provider_invalid");
  }
  return parseDirectProject(value);
}

async function deleteProject(
  fetchImpl: typeof fetch,
  args: TeardownArgs,
  token: string,
  requestTimeoutMs: number,
): Promise<boolean> {
  const bounded = await providerResponse(
    fetchImpl,
    new URL(`/v1/projects/${args.projectRef}`, SUPABASE_MANAGEMENT_ORIGIN),
    {
      method: SUPABASE_PROJECT_DELETE_METHOD,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      cache: "no-store",
    },
    requestTimeoutMs,
  );
  const value = responseJson(bounded.response, bounded.source);
  return (
    record(value) &&
    exactKeys(value, ["id", "ref", "name"]) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.ref === args.projectRef &&
    value.name === args.projectName
  );
}

function initialChecks(): TeardownChecks {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    targetNotProtected: false,
    orderlyPurgeEvidenceExactOrNotRequired: false,
    signedAuthorityExact: false,
    credentialsSeparatedExact: false,
    preflightInventoryExact: false,
    targetMetadataExact: false,
    durableIntentExact: false,
    deleteAttemptedAtMostOnce: true,
    acknowledgementExact: false,
    postflightAttempted: false,
    targetAbsentExact: false,
    terminalEvidenceExact: false,
  };
}

type Outcome =
  | "deleted"
  | "reconciled_from_prior_ack"
  | "deleted_reconciled"
  | "already_absent"
  | "failed_before_attempt"
  | "mutation_uncertain";

function makeReceipt(input: {
  readonly args: TeardownArgs;
  readonly outcome: Outcome;
  readonly attempts: 0 | 1;
  readonly reviewerIdSha256: string | null;
  readonly observedCleanupRunId: string | null;
  readonly signedActivationRunId: string | null;
  readonly cleanupWorkflowPath: string | null;
  readonly intentSha256: string | null;
  readonly preflightInventorySha256: string | null;
  readonly postflightInventorySha256: string | null;
  readonly checks: TeardownChecks;
  readonly completedAt: string;
}) {
  const withoutHash = {
    schemaVersion: 1,
    kind: "pintpath-protected-disposable-supabase-project-teardown",
    ok: ["deleted", "deleted_reconciled", "reconciled_from_prior_ack"].includes(
      input.outcome,
    ),
    executorState: PROTECTED_DISPOSABLE_SUPABASE_PROJECT_TEARDOWN_STATE,
    outcome: input.outcome,
    completedAt: input.completedAt,
    candidateSha: input.args.candidateSha,
    observedCleanupRunId: input.observedCleanupRunId,
    signedActivationRunId: input.signedActivationRunId,
    cleanupWorkflowPath: input.cleanupWorkflowPath,
    projectRef: input.args.projectRef,
    projectName: input.args.projectName,
    destinationOriginSha256: input.args.destinationOriginSha256,
    organizationSlugSha256: input.args.organizationSlugSha256,
    targetRailwayProjectId: input.args.targetRailwayProjectId,
    targetRailwayEnvironmentId: input.args.targetRailwayEnvironmentId,
    cleanupMode: input.args.cleanupMode,
    destinationRestoreAuthoritySha256:
      input.args.destinationRestoreAuthoritySha256,
    emergencyCleanupArmAuthoritySha256:
      input.args.emergencyCleanupArmAuthoritySha256,
    purgeReceiptSha256: input.args.purgeReceiptSha256,
    policySha256: POLICY_SHA256,
    teardownAuthoritySha256: input.args.teardownAuthoritySha256,
    teardownAuthorityPublicKeySha256:
      input.args.teardownAuthorityPublicKeySha256,
    teardownAuthorityReviewerIdSha256: input.reviewerIdSha256,
    intentSha256: input.intentSha256,
    preflightInventorySha256: input.preflightInventorySha256,
    postflightInventorySha256: input.postflightInventorySha256,
    deleteAttempts: input.attempts,
    retryAllowed: false,
    checks: input.checks,
  };
  return {
    ...withoutHash,
    receiptSha256: sha256(canonicalPostgresBackupJson(withoutHash)),
  };
}

function cleanupWorkflowPath(
  args: TeardownArgs,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const observedRunId = env.GITHUB_RUN_ID ?? "";
  const workflowRef = env.GITHUB_WORKFLOW_REF ?? "";
  const common =
    env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_REPOSITORY === REPOSITORY &&
    env.GITHUB_REF === "refs/heads/main" &&
    env.PINTPATH_CHECKED_OUT_CANDIDATE_SHA === args.candidateSha &&
    env.GITHUB_RUN_ATTEMPT === "1" &&
    /^[1-9]\d{0,19}$/.test(observedRunId) &&
    env.PINTPATH_SUPABASE_PROJECT_TEARDOWN_CONFIRMATION ===
      `DELETE_${args.projectRef}`;
  if (!common) return null;
  if (
    workflowRef ===
      `${REPOSITORY}/${ACTIVATION_WORKFLOW_PATH}@refs/heads/main` &&
    env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.GITHUB_SHA === args.candidateSha &&
    observedRunId === args.activationRunId
  ) {
    return ACTIVATION_WORKFLOW_PATH;
  }
  if (
    workflowRef ===
      `${REPOSITORY}/${EMERGENCY_CLEANUP_WORKFLOW_PATH}@refs/heads/main` &&
    ["schedule", "workflow_dispatch", "workflow_run"].includes(
      env.GITHUB_EVENT_NAME ?? "",
    ) &&
    args.cleanupMode === "emergency" &&
    env.PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARMED === "true" &&
    env.PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_AUTHORITY_SHA256 ===
      args.emergencyCleanupArmAuthoritySha256
  ) {
    return EMERGENCY_CLEANUP_WORKFLOW_PATH;
  }
  return null;
}

async function loadEmergencyCleanupState(
  args: TeardownArgs,
  workflowPath: string,
  readPrivateFileImpl: (filename: string) => Promise<string>,
): Promise<EmergencyCleanupState | null> {
  if (workflowPath !== EMERGENCY_CLEANUP_WORKFLOW_PATH) {
    if (
      args.emergencyCleanupStateFile !== null ||
      args.emergencyCleanupStateSha256 !== null
    )
      fail("authority_invalid");
    return null;
  }
  if (
    args.emergencyCleanupStateFile === null ||
    args.emergencyCleanupStateSha256 === null
  )
    fail("authority_invalid");
  const source = await readPrivateFileImpl(
    args.emergencyCleanupStateFile,
  ).catch(() => fail("private_file_unsafe"));
  if (emergencyCleanupSha256(source) !== args.emergencyCleanupStateSha256)
    fail("authority_invalid");
  const state = parseEmergencyCleanupState(source);
  if (
    state.status !== "open" ||
    state.currentArmAuthoritySha256 !==
      args.emergencyCleanupArmAuthoritySha256 ||
    state.candidateSha !== args.candidateSha ||
    state.activationRunId !== args.activationRunId ||
    state.supabaseProjectRef !== args.projectRef ||
    state.supabaseProjectName !== args.projectName ||
    state.organizationSlugSha256 !== args.organizationSlugSha256 ||
    state.destinationOriginSha256 !== args.destinationOriginSha256 ||
    state.projectId !== args.targetRailwayProjectId ||
    state.environmentId !== args.targetRailwayEnvironmentId ||
    state.destinationRestoreAuthoritySha256 !==
      args.destinationRestoreAuthoritySha256
  )
    fail("authority_invalid");
  return state;
}

export interface ProtectedDisposableSupabaseProjectTeardownDependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly now: () => Date;
  readonly fetchImpl: typeof fetch;
  readonly requestTimeoutMs: number;
  readonly readPrivateFile: (filename: string) => Promise<string>;
  readonly writePrivate: (
    filename: string,
    value: object,
    expectedDirectoryIdentity?: PrivateDirectoryIdentity,
  ) => string;
  readonly holdEvidenceDirectory: (
    directory: string,
  ) => HeldPrivateDirectoryIdentity;
  readonly assertMutationAllowed: (operation: string) => void;
  readonly writeOutput: (source: string) => void;
}

export async function runProtectedDisposableSupabaseProjectTeardown(
  overrides: Partial<ProtectedDisposableSupabaseProjectTeardownDependencies> = {},
): Promise<0 | 1> {
  const dependencies: ProtectedDisposableSupabaseProjectTeardownDependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date(),
    fetchImpl: fetch,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    readPrivateFile,
    writePrivate: writePrivateExclusive,
    holdEvidenceDirectory: (directory) =>
      holdPrivateDirectoryIdentity(directory, {
        requireExactDirectoryMode: true,
        requireOwner: true,
      }),
    assertMutationAllowed: assertOperatorMutationAllowed,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  let args: TeardownArgs;
  try {
    args = parseArgs(dependencies.argv);
  } catch (error) {
    dependencies.writeOutput(
      canonicalPostgresBackupJson({
        schemaVersion: 1,
        ok: false,
        failureCode:
          error instanceof ProtectedDisposableSupabaseProjectTeardownError
            ? error.code
            : "unexpected_failure",
      }),
    );
    return 1;
  }
  const checks = initialChecks();
  let attempts: 0 | 1 = 0;
  let reviewerIdSha256: string | null = null;
  let signedActivationRunId: string | null = null;
  let observedWorkflowPath: string | null = null;
  let intentSha256: string | null = null;
  let preflightInventorySha256: string | null = null;
  let postflightInventorySha256: string | null = null;
  let outcome: Outcome = "failed_before_attempt";
  let readToken = "";
  let outputReady = false;
  let evidenceAuthority: HeldPrivateDirectoryIdentity | null = null;
  let evidenceDirectoryIdentity: PrivateDirectoryIdentity | null = null;
  let emergencyState: EmergencyCleanupState | null = null;
  try {
    evidenceAuthority = dependencies.holdEvidenceDirectory(args.evidenceDir);
    evidenceDirectoryIdentity = evidenceAuthority.identity;
    assertOutputReady(args.output, evidenceAuthority);
    outputReady = true;
    checks.policyExact = policyExact(dependencies.cwd);
    observedWorkflowPath = cleanupWorkflowPath(args, dependencies.env);
    checks.githubAuthorityExact = observedWorkflowPath !== null;
    checks.targetNotProtected =
      !FORBIDDEN_PROJECT_REFS.includes(args.projectRef) &&
      !FORBIDDEN_PROJECT_REFS.map((ref) =>
        sha256(`https://${ref}.supabase.co`),
      ).includes(args.destinationOriginSha256);
    if (
      !checks.policyExact ||
      !checks.githubAuthorityExact ||
      !checks.targetNotProtected
    ) {
      fail("authority_invalid");
    }
    emergencyState = await loadEmergencyCleanupState(
      args,
      observedWorkflowPath!,
      dependencies.readPrivateFile,
    );
    const [authoritySource, publicKeyPem, loadedReadToken, deleteToken] =
      await Promise.all([
        dependencies.readPrivateFile(args.teardownAuthorityFile),
        dependencies.readPrivateFile(args.teardownAuthorityPublicKeyFile),
        dependencies.readPrivateFile(args.readTokenFile),
        dependencies.readPrivateFile(args.deleteTokenFile),
      ]).catch(() => fail("private_file_unsafe"));
    if (args.cleanupMode === "orderly") {
      verifyPurgeReceipt(
        await dependencies
          .readPrivateFile(args.purgeReceiptFile!)
          .catch(() => fail("private_file_unsafe")),
        args,
      );
      checks.orderlyPurgeEvidenceExactOrNotRequired = true;
    } else {
      checks.orderlyPurgeEvidenceExactOrNotRequired = true;
    }
    const authority = verifySignedAuthority({
      source: authoritySource,
      sourceSha256: args.teardownAuthoritySha256,
      publicKeyPem,
      publicKeySha256: args.teardownAuthorityPublicKeySha256,
      args,
      now: dependencies.now(),
    });
    reviewerIdSha256 = authority.reviewerIdSha256;
    signedActivationRunId = authority.signedActivationRunId;
    checks.signedAuthorityExact = true;
    checks.credentialsSeparatedExact =
      TOKEN.test(loadedReadToken) &&
      TOKEN.test(deleteToken) &&
      loadedReadToken !== deleteToken &&
      args.readTokenFile !== args.deleteTokenFile;
    if (!checks.credentialsSeparatedExact) fail("credentials_invalid");
    readToken = loadedReadToken;
    dependencies.assertMutationAllowed(
      "Delete exact disposable Supabase recovery project",
    );
    const before = await listProjects(
      dependencies.fetchImpl,
      args.organizationSlug,
      readToken,
      dependencies.requestTimeoutMs,
    );
    preflightInventorySha256 = sha256(canonicalPostgresBackupJson(before));
    checks.preflightInventoryExact = true;
    const matches = before.filter((value) => value.ref === args.projectRef);
    if (matches.length > 1) fail("inventory_invalid");
    const directBefore = await readProject(
      dependencies.fetchImpl,
      args.projectRef,
      readToken,
      dependencies.requestTimeoutMs,
    );
    checks.targetMetadataExact =
      (directBefore === null && matches.length === 0) ||
      (directBefore !== null &&
        matches.length === 1 &&
        directBefore.ref === args.projectRef &&
        directBefore.name === args.projectName &&
        directBefore.organizationSlug === args.organizationSlug &&
        matches[0]!.name === args.projectName &&
        matches[0]!.isBranch === false);
    if (!checks.targetMetadataExact) fail("target_mismatch");
    const intent = {
      schemaVersion:
        "pintpath-protected-disposable-supabase-project-teardown-intent/v2",
      candidateSha: args.candidateSha,
      projectRef: args.projectRef,
      signedActivationRunId,
      observedCleanupRunId: dependencies.env.GITHUB_RUN_ID!,
      cleanupWorkflowPath: observedWorkflowPath,
      emergencyCleanupArmAuthoritySha256:
        args.emergencyCleanupArmAuthoritySha256,
      projectName: args.projectName,
      destinationOriginSha256: args.destinationOriginSha256,
      organizationSlugSha256: args.organizationSlugSha256,
      targetRailwayProjectId: args.targetRailwayProjectId,
      targetRailwayEnvironmentId: args.targetRailwayEnvironmentId,
      cleanupMode: args.cleanupMode,
      destinationRestoreAuthoritySha256: args.destinationRestoreAuthoritySha256,
      purgeReceiptSha256: args.purgeReceiptSha256,
      teardownAuthoritySha256: args.teardownAuthoritySha256,
      preflightInventorySha256,
      operation: "delete-exact-disposable-supabase-project",
      maximumDeleteAttempts: 1,
      retryAllowed: false,
      targetPresentBefore: directBefore !== null,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    };
    intentSha256 = dependencies.writePrivate(
      path.join(args.evidenceDir, "supabase-project-delete-intent.json"),
      intent,
    );
    evidenceAuthority.assertExact();
    checks.durableIntentExact =
      intentSha256 === sha256(canonicalPostgresBackupJson(intent));
    if (!checks.durableIntentExact) fail("intent_invalid");
    const reasserted = await listProjects(
      dependencies.fetchImpl,
      args.organizationSlug,
      readToken,
      dependencies.requestTimeoutMs,
    );
    const directReasserted = await readProject(
      dependencies.fetchImpl,
      args.projectRef,
      readToken,
      dependencies.requestTimeoutMs,
    );
    if (
      canonicalPostgresBackupJson(reasserted) !==
        canonicalPostgresBackupJson(before) ||
      directReasserted?.sourceSha256 !== directBefore?.sourceSha256
    ) {
      fail("concurrent_inventory_change");
    }
    if (directBefore === null) {
      checks.postflightAttempted = true;
      postflightInventorySha256 = preflightInventorySha256;
      checks.targetAbsentExact = true;
      const priorAcknowledgement = emergencyState
        ? priorAcknowledgementFor(emergencyState, "supabase")
        : null;
      checks.acknowledgementExact = priorAcknowledgement !== null;
      outcome = priorAcknowledgement
        ? "reconciled_from_prior_ack"
        : "already_absent";
    } else {
      attempts = 1;
      try {
        evidenceAuthority.assertExact();
        checks.acknowledgementExact = await deleteProject(
          dependencies.fetchImpl,
          args,
          deleteToken,
          dependencies.requestTimeoutMs,
        );
      } catch {
        checks.acknowledgementExact = false;
      }
      checks.postflightAttempted = true;
      try {
        const firstDirectAbsence =
          (await readProject(
            dependencies.fetchImpl,
            args.projectRef,
            readToken,
            dependencies.requestTimeoutMs,
          )) === null;
        const after = await listProjects(
          dependencies.fetchImpl,
          args.organizationSlug,
          readToken,
          dependencies.requestTimeoutMs,
        );
        postflightInventorySha256 = sha256(canonicalPostgresBackupJson(after));
        const secondDirectAbsence =
          (await readProject(
            dependencies.fetchImpl,
            args.projectRef,
            readToken,
            dependencies.requestTimeoutMs,
          )) === null;
        checks.targetAbsentExact =
          firstDirectAbsence &&
          secondDirectAbsence &&
          !after.some((value) => value.ref === args.projectRef);
      } catch {
        checks.targetAbsentExact = false;
      }
      outcome = checks.targetAbsentExact
        ? checks.acknowledgementExact
          ? "deleted"
          : "deleted_reconciled"
        : "mutation_uncertain";
    }
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  }
  const now = dependencies.now();
  const completedAt = Number.isFinite(now.getTime())
    ? now.toISOString()
    : "1970-01-01T00:00:00.000Z";
  let terminalWritten = false;
  let evidenceDirectoryClosed = false;
  try {
    evidenceAuthority?.assertExact();
    evidenceAuthority?.close();
    evidenceAuthority = null;
    evidenceDirectoryClosed = true;
  } catch {
    checks.terminalEvidenceExact = false;
    if (attempts === 1) outcome = "mutation_uncertain";
  }
  if (outputReady && evidenceDirectoryClosed) {
    try {
      checks.terminalEvidenceExact = true;
      const provisional = makeReceipt({
        args,
        outcome,
        attempts,
        reviewerIdSha256,
        observedCleanupRunId: dependencies.env.GITHUB_RUN_ID ?? null,
        signedActivationRunId,
        cleanupWorkflowPath: observedWorkflowPath,
        intentSha256,
        preflightInventorySha256,
        postflightInventorySha256,
        checks,
        completedAt,
      });
      const terminal = {
        schemaVersion: PROTECTED_DISPOSABLE_SUPABASE_PROJECT_TEARDOWN_SCHEMA,
        receipt: provisional,
      };
      dependencies.writePrivate(
        args.output,
        terminal,
        evidenceDirectoryIdentity ?? undefined,
      );
      terminalWritten = true;
    } catch {
      terminalWritten = false;
      checks.terminalEvidenceExact = false;
      if (attempts === 1) outcome = "mutation_uncertain";
    }
  }
  const finalReceipt = makeReceipt({
    args,
    outcome,
    attempts,
    reviewerIdSha256,
    observedCleanupRunId: dependencies.env.GITHUB_RUN_ID ?? null,
    signedActivationRunId,
    cleanupWorkflowPath: observedWorkflowPath,
    intentSha256,
    preflightInventorySha256,
    postflightInventorySha256,
    checks,
    completedAt,
  });
  dependencies.writeOutput(
    canonicalPostgresBackupJson({
      schemaVersion: 1,
      ok: finalReceipt.ok && terminalWritten,
      outcome,
      receiptSha256: finalReceipt.receiptSha256,
    }),
  );
  return finalReceipt.ok && terminalWritten ? 0 : 1;
}

export const protectedDisposableSupabaseProjectTeardownInternals = {
  parseArgs,
  policyExact,
  verifyPurgeReceipt,
  verifySignedAuthority,
  parseProject,
  parseDirectProject,
  listProjects,
  readProject,
  holdPrivateDirectory: holdPrivateDirectoryIdentity,
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runProtectedDisposableSupabaseProjectTeardown();
}
