import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";
import { readTrustedRegularFile } from "./lib/trusted-filesystem.js";

const REPOSITORY = "blackmagic30/Beer";
const ACTIVATION_WORKFLOW_PATH =
  ".github/workflows/activate-production-promotion-recovery.yml";
const CONTROLLER_WORKFLOW_PATH =
  ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml";
const MANAGER_WORKFLOW_PATH =
  ".github/workflows/manage-production-promotion-recovery-emergency-cleanup-arm.yml";
const STATE_REF =
  "refs/heads/pintpath-production-promotion-recovery-emergency-cleanup-state";
const RAILWAY_CLEANUP_POLICY_SHA256 =
  "4d1c22a4d5779f9383e133a1da8cfa40d10a6317343298210efc81e4f18403ef";
const SUPABASE_CLEANUP_POLICY_SHA256 =
  "fd3a45234a02ba3df8fadb6e2f36d1070a72be75eec792986f85abd74e5f6796";
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[1-9]\d{0,19}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_NAME = /^pintpath-disposable-restore-[a-z0-9][a-z0-9-]{0,79}$/;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ARGUMENTS = new Set([
  "--mode",
  "--candidate-sha",
  "--activation-run-id",
  "--project-id",
  "--project-name",
  "--environment-id",
  "--environment-name",
  "--inventory-sha256",
  "--workspace-id",
  "--workspace-name",
  "--workspace-project-inventory-sha256",
  "--supabase-project-ref",
  "--supabase-project-name",
  "--organization-slug-sha256",
  "--destination-origin-sha256",
  "--destination-restore-authority-sha256",
  "--authority-file",
  "--authority-sha256",
  "--authority-public-key-file",
  "--authority-public-key-sha256",
]);

type Json = Record<string, unknown>;

interface Args {
  readonly mode: "activation" | "watchdog" | "manager";
  readonly candidateSha: string;
  readonly activationRunId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly inventorySha256: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceProjectInventorySha256: string;
  readonly supabaseProjectRef: string;
  readonly supabaseProjectName: string;
  readonly organizationSlugSha256: string;
  readonly destinationOriginSha256: string;
  readonly destinationRestoreAuthoritySha256: string;
  readonly authorityFile: string;
  readonly authoritySha256: string;
  readonly authorityPublicKeyFile: string;
  readonly authorityPublicKeySha256: string;
}

export class EmergencyCleanupArmError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EmergencyCleanupArmError";
  }
}

function fail(code: string): never {
  throw new EmergencyCleanupArmError(code);
}

function hash(value: crypto.BinaryLike): string {
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

function exactAbsolute(value: string): string {
  if (
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.includes("\0")
  )
    fail("arguments_invalid");
  return value;
}

function parseArgs(argv: readonly string[]): Args {
  let values: ReadonlyMap<string, string>;
  try {
    values = parseStrictArguments(argv, {
      allowed: ARGUMENTS,
      required: ARGUMENTS,
    });
  } catch {
    fail("arguments_invalid");
  }
  const args = {
    mode: values.get("--mode"),
    candidateSha: values.get("--candidate-sha")!,
    activationRunId: values.get("--activation-run-id")!,
    projectId: values.get("--project-id")!,
    projectName: values.get("--project-name")!,
    environmentId: values.get("--environment-id")!,
    environmentName: values.get("--environment-name")!,
    inventorySha256: values.get("--inventory-sha256")!,
    workspaceId: values.get("--workspace-id")!,
    workspaceName: values.get("--workspace-name")!,
    workspaceProjectInventorySha256: values.get(
      "--workspace-project-inventory-sha256",
    )!,
    supabaseProjectRef: values.get("--supabase-project-ref")!,
    supabaseProjectName: values.get("--supabase-project-name")!,
    organizationSlugSha256: values.get("--organization-slug-sha256")!,
    destinationOriginSha256: values.get("--destination-origin-sha256")!,
    destinationRestoreAuthoritySha256: values.get(
      "--destination-restore-authority-sha256",
    )!,
    authorityFile: exactAbsolute(values.get("--authority-file")!),
    authoritySha256: values.get("--authority-sha256")!,
    authorityPublicKeyFile: exactAbsolute(
      values.get("--authority-public-key-file")!,
    ),
    authorityPublicKeySha256: values.get("--authority-public-key-sha256")!,
  };
  if (
    (args.mode !== "activation" &&
      args.mode !== "watchdog" &&
      args.mode !== "manager") ||
    !SHA.test(args.candidateSha) ||
    !RUN_ID.test(args.activationRunId) ||
    !UUID.test(args.projectId) ||
    !PROJECT_NAME.test(args.projectName) ||
    !UUID.test(args.environmentId) ||
    args.environmentName !== args.projectName ||
    !SHA256.test(args.inventorySha256) ||
    !UUID.test(args.workspaceId) ||
    args.workspaceName.length < 1 ||
    args.workspaceName.length > 100 ||
    args.workspaceName !== args.workspaceName.trim() ||
    /[\r\n\0]/.test(args.workspaceName) ||
    !SHA256.test(args.workspaceProjectInventorySha256) ||
    !PROJECT_REF.test(args.supabaseProjectRef) ||
    args.supabaseProjectName !== args.projectName ||
    !SHA256.test(args.organizationSlugSha256) ||
    !SHA256.test(args.destinationOriginSha256) ||
    !SHA256.test(args.destinationRestoreAuthoritySha256) ||
    !SHA256.test(args.authoritySha256) ||
    !SHA256.test(args.authorityPublicKeySha256)
  ) {
    fail("arguments_invalid");
  }
  return args as Args;
}

function parseCanonical(source: string): Json {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail("authority_invalid");
  }
  if (!record(value) || canonicalPostgresBackupJson(value) !== source)
    fail("authority_invalid");
  return value;
}

function exactTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("authority_invalid");
  return value;
}

function readPrivate(filename: string): string {
  try {
    return readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 256 * 1024,
      requireOwner: true,
      requirePrivate: true,
    }).toString("utf8");
  } catch {
    fail("private_file_unsafe");
  }
}

function githubAuthorityExact(
  args: Args,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const observedRunId = env.GITHUB_RUN_ID ?? "";
  const expectedPath =
    args.mode === "activation"
      ? ACTIVATION_WORKFLOW_PATH
      : args.mode === "watchdog"
        ? CONTROLLER_WORKFLOW_PATH
        : MANAGER_WORKFLOW_PATH;
  const expectedEvent =
    args.mode === "activation"
      ? env.GITHUB_EVENT_NAME === "workflow_dispatch"
      : args.mode === "watchdog"
        ? ["workflow_run", "schedule", "workflow_dispatch"].includes(
            env.GITHUB_EVENT_NAME ?? "",
          )
        : env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const durableStateAuthority =
    args.mode === "manager"
      ? env.PINTPATH_RECOVERY_EMERGENCY_CLEANUP_STATE_TRANSITION === "true"
      : args.mode === "activation"
        ? env.PINTPATH_RECOVERY_EMERGENCY_CLEANUP_STATE_REQUIRED === "true"
        : env.PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARMED === "true";
  return (
    env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_REPOSITORY === REPOSITORY &&
    env.GITHUB_REF === "refs/heads/main" &&
    env.GITHUB_RUN_ATTEMPT === "1" &&
    RUN_ID.test(observedRunId) &&
    env.GITHUB_WORKFLOW_REF ===
      `${REPOSITORY}/${expectedPath}@refs/heads/main` &&
    expectedEvent &&
    durableStateAuthority &&
    env.PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_AUTHORITY_SHA256 ===
      args.authoritySha256 &&
    (args.mode !== "activation" || observedRunId === args.activationRunId) &&
    (args.mode === "watchdog" || env.GITHUB_SHA === args.candidateSha) &&
    (env.GITHUB_EVENT_NAME !== "workflow_run" ||
      (env.PINTPATH_TRIGGERED_ACTIVATION_RUN_ID === args.activationRunId &&
        env.PINTPATH_TRIGGERED_ACTIVATION_CANDIDATE_SHA === args.candidateSha))
  );
}

function verifyAuthority(input: {
  readonly args: Args;
  readonly source: string;
  readonly publicKeyPem: string;
  readonly now: Date;
}): Json {
  const args = input.args;
  if (
    hash(input.source) !== args.authoritySha256 ||
    hash(input.publicKeyPem) !== args.authorityPublicKeySha256
  )
    fail("authority_invalid");
  const envelope = parseCanonical(input.source);
  const payload = envelope.payload;
  if (
    !exactKeys(envelope, ["schemaVersion", "payload", "signatureBase64"]) ||
    envelope.schemaVersion !==
      "pintpath-production-promotion-recovery-emergency-cleanup-arm/v2" ||
    !record(payload) ||
    !exactKeys(payload, [
      "schemaVersion",
      "operation",
      "singletonArmSlot",
      "mechanicalCasRequired",
      "stateRef",
      "armTransition",
      "armLineageIdSha256",
      "previousArmAuthoritySha256",
      "renewalSequence",
      "repository",
      "activationWorkflowPath",
      "emergencyCleanupWorkflowPath",
      "requiredGitRef",
      "requiredActivationRunAttempt",
      "activationRunId",
      "candidateSha",
      "projectId",
      "projectName",
      "environmentId",
      "environmentName",
      "inventorySha256",
      "workspaceId",
      "workspaceName",
      "workspaceProjectInventorySha256",
      "supabaseProjectRef",
      "supabaseProjectName",
      "organizationSlugSha256",
      "destinationOriginSha256",
      "destinationRestoreAuthoritySha256",
      "railwayCleanupPolicySha256",
      "supabaseCleanupPolicySha256",
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
  const issuedAt = exactTimestamp(payload.issuedAt);
  const expiresAt = exactTimestamp(payload.expiresAt);
  const nowMs = input.now.getTime();
  const expected = {
    operation: "arm-exact-production-promotion-recovery-emergency-cleanup",
    singletonArmSlot: "production-promotion-recovery",
    mechanicalCasRequired: true,
    stateRef: STATE_REF,
    repository: REPOSITORY,
    activationWorkflowPath: ACTIVATION_WORKFLOW_PATH,
    emergencyCleanupWorkflowPath: CONTROLLER_WORKFLOW_PATH,
    requiredGitRef: "refs/heads/main",
    requiredActivationRunAttempt: 1,
    activationRunId: args.activationRunId,
    candidateSha: args.candidateSha,
    projectId: args.projectId,
    projectName: args.projectName,
    environmentId: args.environmentId,
    environmentName: args.environmentName,
    inventorySha256: args.inventorySha256,
    workspaceId: args.workspaceId,
    workspaceName: args.workspaceName,
    workspaceProjectInventorySha256: args.workspaceProjectInventorySha256,
    supabaseProjectRef: args.supabaseProjectRef,
    supabaseProjectName: args.supabaseProjectName,
    organizationSlugSha256: args.organizationSlugSha256,
    destinationOriginSha256: args.destinationOriginSha256,
    destinationRestoreAuthoritySha256: args.destinationRestoreAuthoritySha256,
    railwayCleanupPolicySha256: RAILWAY_CLEANUP_POLICY_SHA256,
    supabaseCleanupPolicySha256: SUPABASE_CLEANUP_POLICY_SHA256,
  };
  const expectedLineageIdSha256 = hash(
    canonicalPostgresBackupJson({
      repository: REPOSITORY,
      activationRunId: args.activationRunId,
      candidateSha: args.candidateSha,
      projectId: args.projectId,
      projectName: args.projectName,
      environmentId: args.environmentId,
      environmentName: args.environmentName,
      inventorySha256: args.inventorySha256,
      workspaceId: args.workspaceId,
      workspaceName: args.workspaceName,
      workspaceProjectInventorySha256: args.workspaceProjectInventorySha256,
      supabaseProjectRef: args.supabaseProjectRef,
      supabaseProjectName: args.supabaseProjectName,
      organizationSlugSha256: args.organizationSlugSha256,
      destinationOriginSha256: args.destinationOriginSha256,
      destinationRestoreAuthoritySha256: args.destinationRestoreAuthoritySha256,
    }),
  );
  if (
    payload.schemaVersion !==
      "pintpath-production-promotion-recovery-emergency-cleanup-arm-payload/v2" ||
    Object.entries(expected).some(([key, value]) => payload[key] !== value) ||
    (payload.armTransition !== "initial" &&
      payload.armTransition !== "renewal") ||
    payload.armLineageIdSha256 !== expectedLineageIdSha256 ||
    (payload.armTransition === "initial" &&
      (payload.previousArmAuthoritySha256 !== null ||
        payload.renewalSequence !== 0)) ||
    (payload.armTransition === "renewal" &&
      (!SHA256.test(String(payload.previousArmAuthoritySha256)) ||
        typeof payload.renewalSequence !== "number" ||
        !Number.isSafeInteger(payload.renewalSequence) ||
        payload.renewalSequence < 1)) ||
    payload.reviewerPublicKeySha256 !== args.authorityPublicKeySha256 ||
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
  return payload;
}

export function verifyEmergencyCleanupArm(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
): Json {
  const args = parseArgs(argv);
  if (!githubAuthorityExact(args, env)) fail("github_authority_invalid");
  return verifyAuthority({
    args,
    source: readPrivate(args.authorityFile),
    publicKeyPem: readPrivate(args.authorityPublicKeyFile),
    now,
  });
}

export const emergencyCleanupArmInternals = {
  parseArgs,
  githubAuthorityExact,
  verifyAuthority,
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const payload = verifyEmergencyCleanupArm(process.argv.slice(2));
    process.stdout.write(
      canonicalPostgresBackupJson({
        schemaVersion: 2,
        kind: "pintpath-production-promotion-recovery-emergency-cleanup-arm-verification",
        ok: true,
        activationRunId: payload.activationRunId,
        candidateSha: payload.candidateSha,
        projectId: payload.projectId,
        projectName: payload.projectName,
        environmentId: payload.environmentId,
        environmentName: payload.environmentName,
        inventorySha256: payload.inventorySha256,
        workspaceId: payload.workspaceId,
        workspaceName: payload.workspaceName,
        workspaceProjectInventorySha256:
          payload.workspaceProjectInventorySha256,
        supabaseProjectRef: payload.supabaseProjectRef,
        supabaseProjectName: payload.supabaseProjectName,
        organizationSlugSha256: payload.organizationSlugSha256,
        destinationOriginSha256: payload.destinationOriginSha256,
        destinationRestoreAuthoritySha256:
          payload.destinationRestoreAuthoritySha256,
        armTransition: payload.armTransition,
        armLineageIdSha256: payload.armLineageIdSha256,
        previousArmAuthoritySha256: payload.previousArmAuthoritySha256,
        renewalSequence: payload.renewalSequence,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        authoritySha256: hash(
          readPrivate(parseArgs(process.argv.slice(2)).authorityFile),
        ),
        authorityPublicKeySha256: payload.reviewerPublicKeySha256,
      }),
    );
  } catch (error) {
    process.stdout.write(
      canonicalPostgresBackupJson({
        schemaVersion: 1,
        ok: false,
        failureCode:
          error instanceof EmergencyCleanupArmError
            ? error.code
            : "unexpected_failure",
      }),
    );
    process.exitCode = 1;
  }
}
