import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

import {
  runRailwayExactStagedPatchBoundaryCheck,
  runRailwayMutationBoundaryCheck,
} from
  "./check-railway-mutation-boundary.js";
import {
  canaryPermanentStagingSupabaseKeyPair,
  type PermanentStagingSupabasePairCanaryEvidence,
} from "./verify-permanent-staging-supabase-profiles-prerequisite.js";

export const PROTECTED_STAGING_VARIABLE_MUTATION_SCHEMA =
  "pintpath-permanent-staging-variable-mutation/v4" as const;
export const PROTECTED_STAGING_VARIABLE_MUTATION_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;

const EXTERNAL_MUTATION_FREEZE_ATTESTATION =
  "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN" as const;
const EXTERNAL_MUTATION_FREEZE_ENFORCEMENT =
  "OPERATIONAL_NOT_PROVIDER_VERIFIED" as const;

const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const PRODUCTION_ENVIRONMENT_ID = "13dab015-df74-45c6-b26f-69323daea99a";
const STAGING_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const APPLICATION_SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const COLD_DEAD_SERVICE_INSTANCE_ID = "5a2f3970-2850-44e0-9b6c-f5c7627dde13";
const COLD_DEAD_DEPLOYMENT_ID = "c71fdb35-2be0-4031-b952-85595dfb2913";
const COLD_DEAD_SNAPSHOT_ID = "f1061f4f-e1dd-49f3-b91a-60efbc3d6841";
const COLD_DEAD_SOURCE_SHA = "12c0d24f6619a0286e16b8daf56fc27aaa1e3aba";
const COLD_DEAD_DOMAIN_ID = "afbb2417-c6df-48e3-9987-271b10ab2962";
const STAGING_DOMAIN = "beer-staging.up.railway.app";
const APPLICATION_TARGET_PORT = 8080;
const POLICY_PATH = "ops/railway/permanent-staging-variable-mutation-policy.json";
const BOUNDARY_POLICY_PATH = "ops/railway/production-staging-mutation-policy.json";
const GRAPHQL_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const TOKEN_PATTERN = /^[^\r\n\0]{16,4096}$/;
const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9_-]{20,220}$/;
const SECRET_KEY_PATTERN = /^sb_secret_[A-Za-z0-9_-]{20,220}$/;

export const PROTECTED_STAGING_VARIABLE_MUTATION_QUERY = `mutation PintPathProtectedVariableCollectionUpsert(
  $projectId: String!
  $serviceId: String!
  $environmentId: String!
  $variables: EnvironmentVariables!
  $skipDeploys: Boolean
) {
  variableCollectionUpsert(input: {
    projectId: $projectId
    environmentId: $environmentId
    serviceId: $serviceId
    variables: $variables
    skipDeploys: $skipDeploys
  })
}`;

export const PROTECTED_STAGING_VARIABLE_STAGE_DELETION_QUERY =
  `mutation PintPathProtectedStageForbiddenVariableDeletion(
  $environmentId: String!
  $input: EnvironmentConfig!
  $merge: Boolean!
) {
  environmentStageChanges(
    environmentId: $environmentId
    input: $input
    merge: $merge
  ) {
    id
    environmentId
    status
    patch(decryptVariables: false)
  }
}`;

export const PROTECTED_STAGING_VARIABLE_COMMIT_DELETION_QUERY =
  `mutation PintPathProtectedCommitForbiddenVariableDeletion(
  $environmentId: String!
  $commitMessage: String!
  $skipDeploys: Boolean!
) {
  environmentPatchCommitStaged(
    environmentId: $environmentId
    commitMessage: $commitMessage
    skipDeploys: $skipDeploys
  )
}`;

export const PROTECTED_STAGING_VARIABLE_CANCEL_DELETION_QUERY =
  `mutation PintPathProtectedCancelForbiddenVariableDeletion(
  $environmentId: String!
  $input: EnvironmentConfig!
  $merge: Boolean!
) {
  environmentStageChanges(
    environmentId: $environmentId
    input: $input
    merge: $merge
  ) {
    environmentId
    patch(decryptVariables: false)
  }
}`;

export const PROTECTED_STAGING_VARIABLE_PATCH_QUERY =
  `query PintPathProtectedEnvironmentPatch($patchId: String!) {
  environmentPatch(id: $patchId) {
    id
    environmentId
    status
    patch(decryptVariables: false)
  }
}`;

export const PROTECTED_STAGING_VARIABLE_METADATA_QUERY = `query PintPathProtectedVariableMetadata(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
) {
  environment(id: $environmentId, projectId: $projectId) {
    id
    variables(first: 100) {
      edges { node { id name environmentId serviceId isSealed references } }
      pageInfo { hasNextPage endCursor }
    }
  }
  staged: environmentStagedChanges(environmentId: $environmentId) {
    id
    environmentId
    status
    patch(decryptVariables: false)
  }
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    id
    serviceId
    environmentId
    numReplicas
    source { repo image }
    latestDeployment { id status deploymentStopped snapshotId }
    activeDeployments { id status deploymentStopped }
    domains {
      serviceDomains { id domain targetPort }
      customDomains { id domain targetPort }
    }
  }
}`;

export const PROTECTED_STAGING_VARIABLE_DEPLOYMENT_QUERY =
  `query PintPathProtectedVariableDeployment($deploymentId: String!) {
  deployment(id: $deploymentId) {
    id
    projectId
    environmentId
    serviceId
    snapshotId
    meta
  }
}`;

export const PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY =
  `query PintPathProtectedVariableTokenScope { projectToken { projectId environmentId } }`;

const PROVIDER_OPERATIONS = Object.freeze({
  "provider-google-maps-api-key": "GOOGLE_MAPS_API_KEY",
  "provider-google-maps-map-id": "GOOGLE_MAPS_MAP_ID",
  "provider-google-places-api-key": "GOOGLE_PLACES_API_KEY",
  "provider-openai-api-key": "OPENAI_API_KEY",
} as const);
const FORBIDDEN_OFFSITE_VARIABLE_NAMES = Object.freeze([
  "OFFSITE_BACKUP_BUCKET",
  "OFFSITE_BACKUP_SERVICE_ROLE_KEY",
  "OFFSITE_BACKUP_SUPABASE_URL",
] as const);
const CLEANUP_OPERATION = "remove-forbidden-offsite-backup-variables" as const;
const RESUME_CLEANUP_OPERATION =
  "resume-forbidden-offsite-backup-deletion-patch" as const;
const CANCEL_CLEANUP_OPERATION =
  "cancel-forbidden-offsite-backup-deletion-patch" as const;
const CLEANUP_RECOVERY_OPERATIONS = Object.freeze([
  RESUME_CLEANUP_OPERATION,
  CANCEL_CLEANUP_OPERATION,
] as const);
const CLEANUP_PATCH_SHA256 =
  "3650174bf695aaebb3b9ba7f91a4f2a724a0806b30511578448964c36eebfb91";
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const REVIEWED_AUTHORITY_WORKFLOW_PATH =
  ".github/workflows/permanent-staging-provider-mutation.yml";
const REVIEWED_AUTHORITY_REPOSITORY = "blackmagic30/Beer";
const MUTATION_CHECK_KEYS = Object.freeze([
  "policyExact",
  "githubAuthorityExact",
  "externalMutationFreezeAttested",
  "tokenScopesExact",
  "boundaryPreflightExact",
  "boundaryPrecommitExact",
  "targetPreflightExact",
  "supabasePairCanaryExact",
  "durableIntentExact",
  "mutationAttemptedAtMostOnce",
  "acknowledgementExact",
  "stageAcknowledgementExact",
  "commitAcknowledgementExact",
  "stagedDeletionPatchExact",
  "committedDeletionPatchExact",
  "deploySuppressionExact",
  "postflightAttempted",
  "targetPostflightExact",
  "deploymentUnchanged",
  "boundaryPostflightExact",
  "inputZeroized",
  "terminalEvidenceExact",
] as const);

type ProviderOperation = keyof typeof PROVIDER_OPERATIONS;
export type ProtectedStagingVariableOperation =
  | ProviderOperation
  | "supabase-key-replacement"
  | typeof CLEANUP_OPERATION
  | typeof RESUME_CLEANUP_OPERATION
  | typeof CANCEL_CLEANUP_OPERATION;

interface VariableRow {
  readonly id: string;
  readonly name: string;
  readonly environmentId: string;
  readonly serviceId: string | null;
  readonly isSealed: boolean;
  readonly references: readonly string[];
}

interface ProviderDomain {
  readonly kind: "service" | "custom";
  readonly id: string;
  readonly domain: string;
  readonly targetPort: number | null;
}

interface ProviderDeployment {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly snapshotId: string;
  readonly commitHash: string;
  readonly imageDigest: string | null;
  readonly patchId: string | null;
}

interface MetadataSnapshot {
  readonly environmentId: string;
  readonly variables: readonly VariableRow[];
  readonly stagedPatchId: string;
  readonly stagedPatchStatus: "APPLYING" | "COMMITTED" | "STAGED";
  readonly stagedPatchEmpty: boolean;
  readonly serviceInstance: {
    readonly id: string;
    readonly serviceId: string;
    readonly environmentId: string;
    readonly numReplicas: number | null;
    readonly source: {
      readonly repo: string | null;
      readonly image: string | null;
    };
    readonly latestDeployment: {
      readonly id: string;
      readonly status: string;
      readonly deploymentStopped: boolean;
      readonly snapshotId: string;
    };
    readonly activeDeployments: readonly {
      readonly id: string;
      readonly status: string;
      readonly deploymentStopped: boolean;
    }[];
    readonly domains: readonly ProviderDomain[];
  };
}

interface ProviderSnapshot extends MetadataSnapshot {
  readonly deployment: ProviderDeployment;
}

interface MutationReceipt {
  readonly schemaVersion: typeof PROTECTED_STAGING_VARIABLE_MUTATION_SCHEMA;
  readonly executorState: typeof PROTECTED_STAGING_VARIABLE_MUTATION_STATE;
  readonly operation: ProtectedStagingVariableOperation | null;
  readonly outcome:
    | "acknowledged_pending_runtime_proof"
    | "cleanup_acknowledged"
    | "cleanup_reconciled_after_lost_ack"
    | "cleanup_patch_resume_acknowledged"
    | "cleanup_patch_resume_reconciled_after_lost_ack"
    | "cleanup_patch_cancel_acknowledged"
    | "cleanup_patch_cancel_reconciled_after_lost_ack"
    | "cleanup_already_completed_reconciled"
    | "cleanup_no_effect_retry_acknowledged"
    | "cleanup_no_effect_retry_reconciled_after_lost_ack"
    | "cleanup_already_cancelled_reconciled"
    | "blocked"
    | "failed_before_attempt"
    | "mutation_uncertain";
  readonly candidateSha: string | null;
  readonly attempts: 0 | 1 | 2;
  readonly retryAllowed: false;
  readonly intentSha256: string | null;
  readonly terminalEvidenceSha256: string | null;
  readonly externalMutationFreeze: {
    readonly attestation: typeof EXTERNAL_MUTATION_FREEZE_ATTESTATION | null;
    readonly enforcement: typeof EXTERNAL_MUTATION_FREEZE_ENFORCEMENT;
    readonly providerCasOrLockVerified: false;
  };
  readonly stagedDeletionPatchId: string | null;
  readonly supabaseKeyCanary:
    PermanentStagingSupabasePairCanaryEvidence | null;
  readonly checks: {
    policyExact: boolean;
    githubAuthorityExact: boolean;
    externalMutationFreezeAttested: boolean;
    tokenScopesExact: boolean;
    boundaryPreflightExact: boolean;
    boundaryPrecommitExact: boolean;
    targetPreflightExact: boolean;
    supabasePairCanaryExact: boolean;
    durableIntentExact: boolean;
    mutationAttemptedAtMostOnce: boolean;
    acknowledgementExact: boolean;
    stageAcknowledgementExact: boolean;
    commitAcknowledgementExact: boolean;
    stagedDeletionPatchExact: boolean;
    committedDeletionPatchExact: boolean;
    deploySuppressionExact: boolean;
    postflightAttempted: boolean;
    targetPostflightExact: boolean;
    deploymentUnchanged: boolean;
    boundaryPostflightExact: boolean;
    inputZeroized: boolean;
    terminalEvidenceExact: boolean;
  };
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly boundaryCheck: (
    expectedStagingPatch?: "empty" | "cleanup-deletion",
  ) => Promise<0 | 1>;
  readonly readSecretFile: (filename: string) => Buffer;
  readonly verifyPriorCleanupEvidence: (
    directory: string,
    candidateSha: string,
  ) => boolean;
  readonly verifyReviewedCleanupRecoveryAuthority: (
    filename: string,
    expected: Parameters<typeof reviewedCleanupRecoveryAuthorityValueExact>[1],
  ) => boolean;
  readonly writeDurable: (directory: string, leaf: string, source: string) => string;
  readonly writeOutput: (source: string) => void;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plainRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key, index) => Object.keys(value)[index] === key);
}

function unorderedExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return plainRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function externalMutationFreezeEvidenceExact(
  value: unknown,
  expectedAttested: boolean,
): boolean {
  return exactKeys(value, [
    "attestation",
    "enforcement",
    "providerCasOrLockVerified",
  ])
    && value.attestation === (expectedAttested
      ? EXTERNAL_MUTATION_FREEZE_ATTESTATION
      : null)
    && value.enforcement === EXTERNAL_MUTATION_FREEZE_ENFORCEMENT
    && value.providerCasOrLockVerified === false;
}

function cleanupDeletionPatch(): Record<string, unknown> {
  return {
    services: {
      [APPLICATION_SERVICE_ID]: {
        variables: {
          OFFSITE_BACKUP_BUCKET: null,
          OFFSITE_BACKUP_SERVICE_ROLE_KEY: null,
          OFFSITE_BACKUP_SUPABASE_URL: null,
        },
      },
    },
  };
}

function cleanupDeletionPatchExact(value: unknown): boolean {
  if (!unorderedExactKeys(value, ["services"])
    || !unorderedExactKeys(value.services, [APPLICATION_SERVICE_ID])) return false;
  const service = value.services[APPLICATION_SERVICE_ID];
  if (!unorderedExactKeys(service, ["variables"])) return false;
  const variables = service.variables;
  if (!unorderedExactKeys(variables, FORBIDDEN_OFFSITE_VARIABLE_NAMES)) return false;
  return FORBIDDEN_OFFSITE_VARIABLE_NAMES.every(
    (name) => variables[name] === null,
  );
}

function cleanupRecoveryOperation(
  value: ProtectedStagingVariableOperation,
): value is typeof RESUME_CLEANUP_OPERATION | typeof CANCEL_CLEANUP_OPERATION {
  return CLEANUP_RECOVERY_OPERATIONS.includes(
    value as typeof CLEANUP_RECOVERY_OPERATIONS[number],
  );
}

function parseArguments(argv: readonly string[]): {
  operation: ProtectedStagingVariableOperation;
  valueFiles: readonly string[];
  evidenceDirectory: string;
  priorCleanupRunId: string | null;
  priorCleanupEvidenceDirectory: string | null;
  reviewedAuthorityFile: string | null;
} | null {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) return null;
    values.set(key, value);
  }
  const operation = values.get("--operation") as ProtectedStagingVariableOperation;
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const allowed = new Set([
    "--operation",
    "--evidence-dir",
    "--value-file",
    "--publishable-key-file",
    "--secret-key-file",
    "--prior-cleanup-run-id",
    "--prior-cleanup-evidence-dir",
    "--reviewed-authority-file",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))
    || !path.isAbsolute(evidenceDirectory)) return null;
  if (operation === "supabase-key-replacement") {
    const publishable = values.get("--publishable-key-file");
    const secret = values.get("--secret-key-file");
    if (!publishable || !secret || values.has("--value-file")) return null;
    if (values.has("--prior-cleanup-run-id") ||
      values.has("--prior-cleanup-evidence-dir") ||
      values.has("--reviewed-authority-file")) return null;
    return {
      operation,
      evidenceDirectory,
      valueFiles: [publishable, secret],
      priorCleanupRunId: null,
      priorCleanupEvidenceDirectory: null,
      reviewedAuthorityFile: null,
    };
  }
  if (operation === CLEANUP_OPERATION) {
    if (values.has("--value-file") || values.has("--publishable-key-file")
      || values.has("--secret-key-file") || values.has("--prior-cleanup-run-id")
      || values.has("--prior-cleanup-evidence-dir")
      || values.has("--reviewed-authority-file")) return null;
    return {
      operation,
      evidenceDirectory,
      valueFiles: [],
      priorCleanupRunId: null,
      priorCleanupEvidenceDirectory: null,
      reviewedAuthorityFile: null,
    };
  }
  if (cleanupRecoveryOperation(operation)) {
    const priorCleanupRunId = values.get("--prior-cleanup-run-id") ?? "";
    const priorCleanupEvidenceDirectory =
      values.get("--prior-cleanup-evidence-dir") ?? null;
    const reviewedAuthorityFile = values.get("--reviewed-authority-file") ?? "";
    if (values.has("--value-file") || values.has("--publishable-key-file")
      || values.has("--secret-key-file") || !RUN_ID_PATTERN.test(priorCleanupRunId)
      || (priorCleanupEvidenceDirectory !== null
        && !path.isAbsolute(priorCleanupEvidenceDirectory))
      || !path.isAbsolute(reviewedAuthorityFile)) return null;
    return {
      operation,
      evidenceDirectory,
      valueFiles: [],
      priorCleanupRunId,
      priorCleanupEvidenceDirectory,
      reviewedAuthorityFile,
    };
  }
  if (!Object.hasOwn(PROVIDER_OPERATIONS, operation)) return null;
  const value = values.get("--value-file");
  if (!value || values.has("--publishable-key-file") || values.has("--secret-key-file")) {
    return null;
  }
  if (values.has("--prior-cleanup-run-id") ||
    values.has("--prior-cleanup-evidence-dir") ||
    values.has("--reviewed-authority-file")) return null;
  return {
    operation,
    evidenceDirectory,
    valueFiles: [value],
    priorCleanupRunId: null,
    priorCleanupEvidenceDirectory: null,
    reviewedAuthorityFile: null,
  };
}

function readPrivateSecretFile(filename: string): Buffer {
  try {
    return readTrustedRegularFile(filename, {
      minBytes: 1,
      maxBytes: 4096,
      requireOwner: true,
      requirePrivate: true,
    });
  } catch {
    throw new Error("secret_file_invalid");
  }
}

function durableWrite(directory: string, leaf: string, source: string): string {
  try {
    writePrivateExclusiveFile(directory, leaf, source, { requireOwner: true });
  } catch {
    throw new Error("evidence_invalid");
  }
  return sha256(source);
}

function readEvidenceJson(directory: string, leaf: string): unknown {
  try {
    const source = readTrustedRegularFile(path.join(directory, leaf), {
      minBytes: 2,
      maxBytes: 256 * 1024,
      requireOwner: true,
    });
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(source),
    ) as unknown;
  } catch {
    throw new Error("prior_cleanup_evidence_invalid");
  }
}

function priorCleanupEvidenceExact(
  directory: string,
  candidateSha: string,
): boolean {
  try {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort();
    if (entries.some((entry) => !entry.isFile()) ||
      (JSON.stringify(names) !== JSON.stringify(["dispatch.json"])
        && JSON.stringify(names) !== JSON.stringify(["dispatch.json", "intent.json"])
        && JSON.stringify(names) !==
          JSON.stringify(["dispatch.json", "intent.json", "terminal.json"]))) {
      return false;
    }
    const dispatch = readEvidenceJson(directory, "dispatch.json");
    if (!exactKeys(dispatch, [
      "schemaVersion",
      "candidateSha",
      "operation",
      "secretMaterialIncluded",
    ]) || dispatch.schemaVersion !== "pintpath-provider-mutation-dispatch/v1"
      || dispatch.candidateSha !== candidateSha
      || dispatch.operation !== CLEANUP_OPERATION
      || dispatch.secretMaterialIncluded !== false) return false;

    if (!names.includes("intent.json")) return true;

    const intent = readEvidenceJson(directory, "intent.json");
    if (!exactKeys(intent, [
      "schemaVersion",
      "operation",
      "candidateSha",
      "projectId",
      "environmentId",
      "serviceId",
      "externalMutationFreeze",
      "authorizedBaseline",
      "variableNames",
      "mutationPlan",
      "retryAllowed",
      "privateInputCount",
      "secretMaterialIncluded",
      "secretDerivedCommitmentsIncluded",
      "preflightMetadataSha256",
    ]) || intent.schemaVersion !==
        "pintpath-permanent-staging-variable-mutation-intent/v4"
      || intent.operation !== CLEANUP_OPERATION
      || intent.candidateSha !== candidateSha
      || intent.projectId !== PROJECT_ID
      || intent.environmentId !== STAGING_ENVIRONMENT_ID
      || intent.serviceId !== APPLICATION_SERVICE_ID
      || !externalMutationFreezeEvidenceExact(
        intent.externalMutationFreeze,
        true,
      )
      || !["healthy-legacy-one", "cold-dead-null"].includes(
        intent.authorizedBaseline as string,
      )
      || JSON.stringify(intent.variableNames) !==
        JSON.stringify(FORBIDDEN_OFFSITE_VARIABLE_NAMES)
      || !exactKeys(intent.mutationPlan, ["stage", "commit"])
      || !exactKeys(intent.mutationPlan.stage, [
        "mutation", "merge", "maximumAttempts", "patch",
      ])
      || intent.mutationPlan.stage.mutation !== "environmentStageChanges"
      || intent.mutationPlan.stage.merge !== false
      || intent.mutationPlan.stage.maximumAttempts !== 1
      || !cleanupDeletionPatchExact(intent.mutationPlan.stage.patch)
      || sha256(canonical(intent.mutationPlan.stage.patch)) !== CLEANUP_PATCH_SHA256
      || !exactKeys(intent.mutationPlan.commit, [
        "mutation", "skipDeploys", "maximumAttempts", "commitMessage",
      ])
      || intent.mutationPlan.commit.mutation !== "environmentPatchCommitStaged"
      || intent.mutationPlan.commit.skipDeploys !== true
      || intent.mutationPlan.commit.maximumAttempts !== 1
      || intent.mutationPlan.commit.commitMessage !==
        `pintpath:staging-offsite-cleanup:${candidateSha}`
      || intent.retryAllowed !== false
      || intent.privateInputCount !== 0
      || intent.secretMaterialIncluded !== false
      || intent.secretDerivedCommitmentsIncluded !== false
      || typeof intent.preflightMetadataSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(intent.preflightMetadataSha256)) return false;

    if (!names.includes("terminal.json")) return true;
    const terminal = readEvidenceJson(directory, "terminal.json");
    if (!(exactKeys(terminal, [
      "schemaVersion",
      "receipt",
      "secretMaterialIncluded",
      "secretDerivedCommitmentsIncluded",
    ]) && terminal.schemaVersion ===
        "pintpath-permanent-staging-variable-mutation-terminal/v4"
      && plainRecord(terminal.receipt)
      && unorderedExactKeys(terminal.receipt, [
        "schemaVersion",
        "executorState",
        "operation",
        "outcome",
        "candidateSha",
        "attempts",
        "retryAllowed",
        "intentSha256",
        "terminalEvidenceSha256",
        "externalMutationFreeze",
        "stagedDeletionPatchId",
        "supabaseKeyCanary",
        "checks",
      ])
      && terminal.receipt.schemaVersion ===
        PROTECTED_STAGING_VARIABLE_MUTATION_SCHEMA
      && terminal.receipt.executorState ===
        PROTECTED_STAGING_VARIABLE_MUTATION_STATE
      && terminal.receipt.operation === CLEANUP_OPERATION
      && terminal.receipt.candidateSha === candidateSha
      && [0, 1, 2].includes(terminal.receipt.attempts as number)
      && terminal.receipt.retryAllowed === false
      && terminal.receipt.intentSha256 === sha256(canonical(intent))
      && terminal.receipt.terminalEvidenceSha256 === null
      && externalMutationFreezeEvidenceExact(
        terminal.receipt.externalMutationFreeze,
        true,
      )
      && (terminal.receipt.stagedDeletionPatchId === null
        || typeof terminal.receipt.stagedDeletionPatchId === "string"
          && UUID_PATTERN.test(terminal.receipt.stagedDeletionPatchId))
      && terminal.receipt.supabaseKeyCanary === null
      && plainRecord(terminal.receipt.checks)
      && unorderedExactKeys(terminal.receipt.checks, MUTATION_CHECK_KEYS)
      && MUTATION_CHECK_KEYS.every((key) =>
        typeof ((terminal.receipt as Record<string, unknown>).checks as
          Record<string, unknown>)[key] === "boolean")
      && terminal.receipt.checks.policyExact === true
      && terminal.receipt.checks.githubAuthorityExact === true
      && terminal.receipt.checks.externalMutationFreezeAttested === true
      && terminal.receipt.checks.tokenScopesExact === true
      && terminal.receipt.checks.boundaryPreflightExact === true
      && terminal.receipt.checks.supabasePairCanaryExact === true
      && terminal.receipt.checks.durableIntentExact === true
      && terminal.receipt.checks.mutationAttemptedAtMostOnce === true
      && terminal.receipt.checks.inputZeroized === true
      && terminal.receipt.checks.terminalEvidenceExact === false
      && terminal.secretMaterialIncluded === false
      && terminal.secretDerivedCommitmentsIncluded === false)) return false;
    const terminalReceipt = terminal.receipt as Record<string, unknown> & {
      checks: Record<string, unknown>;
    };
    const patchIdentityExact = terminalReceipt.stagedDeletionPatchId === null
      ? terminalReceipt.checks.stagedDeletionPatchExact === false
      : UUID_PATTERN.test(terminalReceipt.stagedDeletionPatchId as string);
    if (!patchIdentityExact) return false;
    return terminalReceipt.attempts === 0
      ? terminalReceipt.outcome === "failed_before_attempt"
        && terminalReceipt.checks.targetPreflightExact === false
        && terminalReceipt.checks.stagedDeletionPatchExact === false
        && terminalReceipt.checks.committedDeletionPatchExact === false
        && terminalReceipt.checks.boundaryPrecommitExact === false
      : terminalReceipt.attempts === 1
        ? terminalReceipt.outcome === "mutation_uncertain"
          && terminalReceipt.checks.targetPreflightExact === true
          && terminalReceipt.checks.committedDeletionPatchExact === false
          && terminalReceipt.checks.boundaryPrecommitExact === false
      : terminalReceipt.checks.stagedDeletionPatchExact === true
          && terminalReceipt.checks.targetPreflightExact === true
          && terminalReceipt.checks.boundaryPrecommitExact === true
          && (terminalReceipt.outcome === "mutation_uncertain"
            || terminalReceipt.checks.committedDeletionPatchExact === true
              && [
                "cleanup_acknowledged",
                "cleanup_reconciled_after_lost_ack",
              ].includes(terminalReceipt.outcome as string));
  } catch {
    return false;
  }
}

function exactRunIdArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > 100
    || !value.every((entry) => typeof entry === "string"
      && RUN_ID_PATTERN.test(entry))) return false;
  const numeric = value.map((entry) => Number(entry));
  return numeric.every(Number.isSafeInteger)
    && new Set(value).size === value.length
    && value.every((entry, index) => index === 0
      || Number(value[index - 1]) < Number(entry));
}

function canonicalTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const canonicalValue = new Date(milliseconds).toISOString();
  return canonicalValue === value || canonicalValue === value.replace("Z", ".000Z")
    ? milliseconds
    : null;
}

function reviewedCleanupRecoveryAuthorityValueExact(
  value: unknown,
  expected: {
    readonly candidateSha: string;
    readonly operation: typeof RESUME_CLEANUP_OPERATION |
      typeof CANCEL_CLEANUP_OPERATION;
    readonly priorCleanupRunId: string;
    readonly currentRunId: string;
  },
): boolean {
  const keys = [
    "command",
    "ok",
    "schemaVersion",
    "kind",
    "repository",
    "candidateSha",
    "reviewedPrHeadSha",
    "reviewedPullRequestNumber",
    "operation",
    "workflowPath",
    "workflowRunId",
    "workflowRunAttempt",
    "workflowRunCreatedAt",
    "reviewedPullRequestMergedAt",
    "candidateHistoryMaximumAgeHours",
    "completeRetainedHistoryExact",
    "safePriorSkippedWriteRunIds",
    "priorCleanupRunId",
    "priorCleanupPatchSha256",
    "exactPriorCleanupCandidateRunBound",
    "offsiteCleanupRecoveryOriginalRunCompletedAt",
    "offsiteCleanupRecoveryGraceHours",
    "offsiteCleanupRecoveryWithinGraceExact",
    "safePriorRecoverySkippedWriteRunIds",
    "ambiguousPriorSameModeRecoveryRunIds",
    "sameModeRecoveryConvergenceExact",
    "successfulStagingDeploymentRunIds",
    "stagingLifecycleSealed",
    "reviewedAuthorityExact",
    "freshDispatchWriteGuardExact",
  ];
  if (!unorderedExactKeys(value, keys)
    || value.command !== "verify-github-reviewed-candidate-authority"
    || value.ok !== true
    || value.schemaVersion !== 1
    || value.kind !== "pintpath-github-reviewed-candidate-authority"
    || value.repository !== REVIEWED_AUTHORITY_REPOSITORY
    || value.candidateSha !== expected.candidateSha
    || value.reviewedPrHeadSha !== expected.candidateSha
    || !Number.isSafeInteger(value.reviewedPullRequestNumber)
    || Number(value.reviewedPullRequestNumber) < 1
    || value.operation !== expected.operation
    || value.workflowPath !== REVIEWED_AUTHORITY_WORKFLOW_PATH
    || value.workflowRunId !== expected.currentRunId
    || value.workflowRunAttempt !== 1
    || value.candidateHistoryMaximumAgeHours !== 168
    || value.completeRetainedHistoryExact !== true
    || !exactRunIdArray(value.safePriorSkippedWriteRunIds)
    || value.priorCleanupRunId !== expected.priorCleanupRunId
    || value.priorCleanupPatchSha256 !== CLEANUP_PATCH_SHA256
    || value.exactPriorCleanupCandidateRunBound !== true
    || value.offsiteCleanupRecoveryGraceHours !== 24
    || value.offsiteCleanupRecoveryWithinGraceExact !== true
    || !exactRunIdArray(value.safePriorRecoverySkippedWriteRunIds)
    || !exactRunIdArray(value.ambiguousPriorSameModeRecoveryRunIds)
    || value.sameModeRecoveryConvergenceExact !== true
    || !exactRunIdArray(value.successfulStagingDeploymentRunIds)
    || value.successfulStagingDeploymentRunIds.length > 1
    || value.stagingLifecycleSealed !== false
    || value.reviewedAuthorityExact !== true
    || value.freshDispatchWriteGuardExact !== true) return false;
  const createdAt = canonicalTimestamp(value.workflowRunCreatedAt);
  const mergedAt = canonicalTimestamp(value.reviewedPullRequestMergedAt);
  const originalRunCompletedAt = canonicalTimestamp(
    value.offsiteCleanupRecoveryOriginalRunCompletedAt,
  );
  const forbiddenRunIds = new Set([
    expected.currentRunId,
    expected.priorCleanupRunId,
  ]);
  const recoveryHistoryRunIds = [
    ...value.safePriorRecoverySkippedWriteRunIds,
    ...value.ambiguousPriorSameModeRecoveryRunIds,
  ];
  return createdAt !== null && mergedAt !== null
    && originalRunCompletedAt !== null
    && mergedAt <= originalRunCompletedAt
    && originalRunCompletedAt <= createdAt
    && createdAt - originalRunCompletedAt <= 24 * 60 * 60 * 1_000
    && !value.safePriorSkippedWriteRunIds.some((id) => forbiddenRunIds.has(id))
    && !value.safePriorRecoverySkippedWriteRunIds.some(
      (id) => forbiddenRunIds.has(id),
    )
    && !value.ambiguousPriorSameModeRecoveryRunIds.some(
      (id) => forbiddenRunIds.has(id),
    )
    && new Set(recoveryHistoryRunIds).size === recoveryHistoryRunIds.length
    && !value.successfulStagingDeploymentRunIds.includes(expected.currentRunId);
}

function reviewedCleanupRecoveryAuthorityExact(
  filename: string,
  expected: Parameters<typeof reviewedCleanupRecoveryAuthorityValueExact>[1],
): boolean {
  try {
    const source = readTrustedRegularFile(filename, {
      minBytes: 2,
      maxBytes: 64 * 1024,
      requireOwner: true,
      requirePrivate: true,
    });
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(source),
    ) as unknown;
    return reviewedCleanupRecoveryAuthorityValueExact(value, expected);
  } catch {
    return false;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength)
    || Number(contentLength) > MAX_RESPONSE_BYTES)) throw new Error("provider_response_invalid");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider_response_invalid");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("provider_response_invalid");
    }
    chunks.push(next.value);
  }
  const source = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(source) as unknown;
}

async function graphql(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Project-Access-Token": token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok || !/^application\/json(?:;|$)/i.test(
    response.headers.get("content-type") ?? "",
  )) throw new Error("provider_response_invalid");
  return await readBoundedJson(response);
}

function parseScope(value: unknown): boolean {
  return exactKeys(value, ["data"])
    && exactKeys(value.data, ["projectToken"])
    && exactKeys(value.data.projectToken, ["projectId", "environmentId"])
    && value.data.projectToken.projectId === PROJECT_ID
    && value.data.projectToken.environmentId === STAGING_ENVIRONMENT_ID;
}

function parseVariable(value: unknown): VariableRow | null {
  if (!exactKeys(value, ["id", "name", "environmentId", "serviceId", "isSealed", "references"])
    || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 256
    || typeof value.name !== "string" || !/^[A-Z][A-Z0-9_]{1,127}$/.test(value.name)
    || value.environmentId !== STAGING_ENVIRONMENT_ID
    || !(value.serviceId === null || typeof value.serviceId === "string" && UUID_PATTERN.test(value.serviceId))
    || typeof value.isSealed !== "boolean" || !Array.isArray(value.references)
    || value.references.length > 100
    || !value.references.every((entry) => typeof entry === "string"
      && entry.length >= 1 && entry.length <= 512 && !/[\r\n\0]/.test(entry))) return null;
  return {
    id: value.id,
    name: value.name,
    environmentId: value.environmentId as string,
    serviceId: value.serviceId as string | null,
    isSealed: value.isSealed,
    references: [...value.references].sort() as string[],
  };
}

function validDeployment(value: unknown, detailed: boolean): boolean {
  const keys = detailed
    ? ["id", "status", "deploymentStopped", "snapshotId"]
    : ["id", "status", "deploymentStopped"];
  return exactKeys(value, keys)
    && typeof value.id === "string" && UUID_PATTERN.test(value.id)
    && typeof value.status === "string" && /^[A-Z_]{1,32}$/.test(value.status)
    && typeof value.deploymentStopped === "boolean"
    && (!detailed || typeof value.snapshotId === "string" && UUID_PATTERN.test(value.snapshotId));
}

function parseDomain(value: unknown, kind: ProviderDomain["kind"]): ProviderDomain | null {
  if (!exactKeys(value, ["id", "domain", "targetPort"])
    || typeof value.id !== "string" || !UUID_PATTERN.test(value.id)
    || typeof value.domain !== "string" || !/^[a-z0-9.-]{1,253}$/.test(value.domain)
    || !(value.targetPort === null || Number.isSafeInteger(value.targetPort)
      && Number(value.targetPort) >= 1 && Number(value.targetPort) <= 65_535)) return null;
  return {
    kind,
    id: value.id,
    domain: value.domain,
    targetPort: value.targetPort as number | null,
  };
}

function parseMetadata(
  value: unknown,
  expectedStagedPatch:
    "empty" | "cleanup-deletion" | "empty-or-cleanup-deletion" = "empty",
): MetadataSnapshot | null {
  if (!exactKeys(value, ["data"])
    || !exactKeys(value.data, ["environment", "staged", "serviceInstance"])) return null;
  const { environment, staged, serviceInstance } = value.data;
  if (!exactKeys(environment, ["id", "variables"])
    || environment.id !== STAGING_ENVIRONMENT_ID
    || !exactKeys(environment.variables, ["edges", "pageInfo"])
    || !Array.isArray(environment.variables.edges)
    || environment.variables.edges.length > 100
    || !exactKeys(environment.variables.pageInfo, ["hasNextPage", "endCursor"])
    || environment.variables.pageInfo.hasNextPage !== false
    || !(environment.variables.pageInfo.endCursor === null
      || typeof environment.variables.pageInfo.endCursor === "string")
    || !exactKeys(staged, ["id", "environmentId", "status", "patch"])
    || typeof staged.id !== "string"
    || !(UUID_PATTERN.test(staged.id)
      || staged.id === "<empty>"
        && staged.status === "STAGED"
        && plainRecord(staged.patch)
        && Object.keys(staged.patch).length === 0)
    || staged.environmentId !== STAGING_ENVIRONMENT_ID
    || !["APPLYING", "COMMITTED", "STAGED"].includes(
      staged.status as string,
    )
    || (expectedStagedPatch === "cleanup-deletion"
      && staged.status !== "STAGED")
    || (expectedStagedPatch === "empty"
      ? !plainRecord(staged.patch) || Object.keys(staged.patch).length !== 0
      : expectedStagedPatch === "cleanup-deletion"
        ? !cleanupDeletionPatchExact(staged.patch)
        : (!plainRecord(staged.patch) || Object.keys(staged.patch).length !== 0)
          && !cleanupDeletionPatchExact(staged.patch))
    || !exactKeys(serviceInstance, [
      "id", "serviceId", "environmentId", "numReplicas", "source", "latestDeployment",
      "activeDeployments", "domains",
    ])
    || typeof serviceInstance.id !== "string" || !UUID_PATTERN.test(serviceInstance.id)
    || serviceInstance.serviceId !== APPLICATION_SERVICE_ID
    || serviceInstance.environmentId !== STAGING_ENVIRONMENT_ID
    || !(serviceInstance.numReplicas === null
      || typeof serviceInstance.numReplicas === "number"
        && Number.isSafeInteger(serviceInstance.numReplicas)
        && serviceInstance.numReplicas >= 0
        && serviceInstance.numReplicas <= 8)
    || !exactKeys(serviceInstance.source, ["repo", "image"])
    || !(serviceInstance.source.repo === null
      || typeof serviceInstance.source.repo === "string"
        && serviceInstance.source.repo.length >= 1
        && serviceInstance.source.repo.length <= 512
        && !/[\r\n\0]/.test(serviceInstance.source.repo))
    || !(serviceInstance.source.image === null
      || typeof serviceInstance.source.image === "string"
        && serviceInstance.source.image.length >= 1
        && serviceInstance.source.image.length <= 512
        && !/[\r\n\0]/.test(serviceInstance.source.image))
    || !validDeployment(serviceInstance.latestDeployment, true)
    || !Array.isArray(serviceInstance.activeDeployments)
    || serviceInstance.activeDeployments.length > 100
    || !serviceInstance.activeDeployments.every((row: unknown) => validDeployment(row, false))
    || !exactKeys(serviceInstance.domains, ["serviceDomains", "customDomains"])
    || !Array.isArray(serviceInstance.domains.serviceDomains)
    || !Array.isArray(serviceInstance.domains.customDomains)
    || serviceInstance.domains.serviceDomains.length > 100
    || serviceInstance.domains.customDomains.length > 100) {
    return null;
  }
  const domains: ProviderDomain[] = [];
  for (const candidate of serviceInstance.domains.serviceDomains) {
    const domain = parseDomain(candidate, "service");
    if (!domain) return null;
    domains.push(domain);
  }
  for (const candidate of serviceInstance.domains.customDomains) {
    const domain = parseDomain(candidate, "custom");
    if (!domain) return null;
    domains.push(domain);
  }
  domains.sort((left, right) => `${left.kind}:${left.domain}:${left.id}`.localeCompare(
    `${right.kind}:${right.domain}:${right.id}`,
  ));
  if (new Set(domains.map((domain) => domain.id)).size !== domains.length
    || new Set(domains.map((domain) => domain.domain)).size !== domains.length) return null;
  const variables: VariableRow[] = [];
  for (const edge of environment.variables.edges) {
    if (!exactKeys(edge, ["node"])) return null;
    const row = parseVariable(edge.node);
    if (!row) return null;
    variables.push(row);
  }
  variables.sort((left, right) => `${left.serviceId}:${left.name}`.localeCompare(
    `${right.serviceId}:${right.name}`,
  ));
  if (new Set(variables.map((row) => `${row.serviceId}:${row.name}`)).size
    !== variables.length) return null;
  return {
    environmentId: STAGING_ENVIRONMENT_ID,
    variables,
    stagedPatchId: staged.id,
    stagedPatchStatus: staged.status as MetadataSnapshot["stagedPatchStatus"],
    stagedPatchEmpty: plainRecord(staged.patch)
      && Object.keys(staged.patch).length === 0,
    serviceInstance: {
      id: serviceInstance.id,
      serviceId: serviceInstance.serviceId,
      environmentId: serviceInstance.environmentId,
      numReplicas: serviceInstance.numReplicas as number | null,
      source: structuredClone(serviceInstance.source) as MetadataSnapshot["serviceInstance"]["source"],
      latestDeployment: structuredClone(serviceInstance.latestDeployment),
      activeDeployments: structuredClone(serviceInstance.activeDeployments),
      domains,
    } as MetadataSnapshot["serviceInstance"],
  };
}

function parseDeployment(value: unknown, expectedId: string): ProviderDeployment | null {
  if (!exactKeys(value, ["data"])
    || !exactKeys(value.data, ["deployment"])
    || !exactKeys(value.data.deployment, [
      "id", "projectId", "environmentId", "serviceId", "snapshotId", "meta",
    ])) return null;
  const deployment = value.data.deployment;
  if (deployment.id !== expectedId
    || deployment.projectId !== PROJECT_ID
    || deployment.environmentId !== STAGING_ENVIRONMENT_ID
    || deployment.serviceId !== APPLICATION_SERVICE_ID
    || typeof deployment.snapshotId !== "string" || !UUID_PATTERN.test(deployment.snapshotId)
    || !plainRecord(deployment.meta)) return null;
  const { commitHash } = deployment.meta;
  const imageDigest = Object.hasOwn(deployment.meta, "imageDigest")
    ? deployment.meta.imageDigest
    : null;
  const patchId = Object.hasOwn(deployment.meta, "patchId")
    ? deployment.meta.patchId
    : null;
  if (typeof commitHash !== "string" || !SHA_PATTERN.test(commitHash)
    || !(imageDigest === null || typeof imageDigest === "string"
      && /^sha256:[a-f0-9]{64}$/.test(imageDigest))
    || !(patchId === null || typeof patchId === "string" && UUID_PATTERN.test(patchId))) return null;
  return {
    id: deployment.id,
    projectId: deployment.projectId,
    environmentId: deployment.environmentId,
    serviceId: deployment.serviceId,
    snapshotId: deployment.snapshotId,
    commitHash,
    imageDigest: imageDigest as string | null,
    patchId: patchId as string | null,
  };
}

async function readProviderSnapshot(
  fetchImpl: typeof fetch,
  metadataToken: string,
  expectedStagedPatch:
    "empty" | "cleanup-deletion" | "empty-or-cleanup-deletion" = "empty",
): Promise<ProviderSnapshot | null> {
  const metadata = parseMetadata(await graphql(
    fetchImpl,
    metadataToken,
    PROTECTED_STAGING_VARIABLE_METADATA_QUERY,
    {
      projectId: PROJECT_ID,
      environmentId: STAGING_ENVIRONMENT_ID,
      serviceId: APPLICATION_SERVICE_ID,
    },
  ), expectedStagedPatch);
  if (!metadata) return null;
  const deployment = parseDeployment(await graphql(
    fetchImpl,
    metadataToken,
    PROTECTED_STAGING_VARIABLE_DEPLOYMENT_QUERY,
    { deploymentId: metadata.serviceInstance.latestDeployment.id },
  ), metadata.serviceInstance.latestDeployment.id);
  if (!deployment
    || deployment.snapshotId !== metadata.serviceInstance.latestDeployment.snapshotId) return null;
  return { ...metadata, deployment };
}

function exactHealthyLegacyBaseline(
  snapshot: ProviderSnapshot,
  candidateSha: string | null,
): boolean {
  const service = snapshot.serviceInstance;
  const active = service.activeDeployments[0];
  const pinnedDomain = service.domains[0];
  return snapshot.stagedPatchEmpty
    && service.numReplicas === 1
    && service.latestDeployment.status === "SUCCESS"
    && service.latestDeployment.deploymentStopped === false
    && service.activeDeployments.length === 1
    && active?.id === service.latestDeployment.id
    && active.status === "SUCCESS"
    && active.deploymentStopped === false
    && snapshot.deployment.id === service.latestDeployment.id
    && snapshot.deployment.projectId === PROJECT_ID
    && snapshot.deployment.environmentId === STAGING_ENVIRONMENT_ID
    && snapshot.deployment.serviceId === APPLICATION_SERVICE_ID
    && snapshot.deployment.snapshotId === service.latestDeployment.snapshotId
    && candidateSha !== null
    && snapshot.deployment.commitHash !== candidateSha
    && snapshot.deployment.imageDigest !== null
    && snapshot.deployment.patchId === null
    && (service.source.repo !== null || service.source.image !== null)
    && service.domains.length === 1
    && pinnedDomain?.kind === "service"
    && pinnedDomain.domain === STAGING_DOMAIN
    && pinnedDomain.targetPort === APPLICATION_TARGET_PORT;
}

function exactColdDeadBaseline(snapshot: ProviderSnapshot): boolean {
  const service = snapshot.serviceInstance;
  const pinnedDomain = service.domains[0];
  return snapshot.stagedPatchEmpty
    && service.id === COLD_DEAD_SERVICE_INSTANCE_ID
    && service.numReplicas === null
    && service.source.repo === null
    && service.source.image === null
    && service.latestDeployment.id === COLD_DEAD_DEPLOYMENT_ID
    && service.latestDeployment.status === "FAILED"
    && service.latestDeployment.deploymentStopped === true
    && service.latestDeployment.snapshotId === COLD_DEAD_SNAPSHOT_ID
    && service.activeDeployments.length === 0
    && snapshot.deployment.id === COLD_DEAD_DEPLOYMENT_ID
    && snapshot.deployment.projectId === PROJECT_ID
    && snapshot.deployment.environmentId === STAGING_ENVIRONMENT_ID
    && snapshot.deployment.serviceId === APPLICATION_SERVICE_ID
    && snapshot.deployment.snapshotId === COLD_DEAD_SNAPSHOT_ID
    && snapshot.deployment.commitHash === COLD_DEAD_SOURCE_SHA
    && snapshot.deployment.imageDigest === null
    && snapshot.deployment.patchId === null
    && service.domains.length === 1
    && pinnedDomain?.kind === "service"
    && pinnedDomain.id === COLD_DEAD_DOMAIN_ID
    && pinnedDomain.domain === STAGING_DOMAIN
    && pinnedDomain.targetPort === APPLICATION_TARGET_PORT;
}

function authorizedBaselineKind(
  snapshot: ProviderSnapshot,
  candidateSha: string | null,
): "healthy-legacy-one" | "cold-dead-null" | null {
  if (exactHealthyLegacyBaseline(snapshot, candidateSha)) return "healthy-legacy-one";
  if (exactColdDeadBaseline(snapshot)) return "cold-dead-null";
  return null;
}

function authorizedCleanupRecoveryBaselineKind(
  snapshot: ProviderSnapshot,
  candidateSha: string | null,
): "healthy-legacy-one" | "cold-dead-null" | null {
  return authorizedBaselineKind(
    { ...snapshot, stagedPatchEmpty: true },
    candidateSha,
  );
}

function relevantRows(snapshot: MetadataSnapshot, names: readonly string[]): VariableRow[] {
  return snapshot.variables.filter((row) => names.includes(row.name));
}

function exactApplicationLiteralRow(row: VariableRow, expectedSealed: boolean): boolean {
  return row.serviceId === APPLICATION_SERVICE_ID
    && row.isSealed === expectedSealed
    && row.references.length === 0;
}

function forbiddenOffsiteRowsAbsent(snapshot: MetadataSnapshot): boolean {
  return relevantRows(snapshot, FORBIDDEN_OFFSITE_VARIABLE_NAMES).length === 0;
}

function forbiddenOffsiteRowsExactForDeletion(snapshot: MetadataSnapshot): boolean {
  const rows = relevantRows(snapshot, FORBIDDEN_OFFSITE_VARIABLE_NAMES);
  return rows.length === FORBIDDEN_OFFSITE_VARIABLE_NAMES.length
    && FORBIDDEN_OFFSITE_VARIABLE_NAMES.every((name) => {
      const named = rows.filter((row) => row.name === name);
      return named.length === 1
        && named[0]?.serviceId === APPLICATION_SERVICE_ID
        && named[0].references.length === 0;
    });
}

function maintenanceMetadataExact(snapshot: MetadataSnapshot): boolean {
  const enabled = relevantRows(snapshot, ["PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED"]);
  const candidate = relevantRows(
    snapshot,
    ["PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA"],
  );
  return candidate.length === 0
    && (enabled.length === 0
      || enabled.length === 1 && exactApplicationLiteralRow(enabled[0]!, false));
}

function providerPreflightExact(snapshot: MetadataSnapshot, variableName: string): boolean {
  const target = relevantRows(snapshot, [variableName]);
  return forbiddenOffsiteRowsAbsent(snapshot)
    && maintenanceMetadataExact(snapshot)
    && (target.length === 0
      || target.length === 1 && exactApplicationLiteralRow(target[0]!, false));
}

function providerPostflightExact(
  before: MetadataSnapshot,
  after: MetadataSnapshot,
  variableName: string,
): boolean {
  const beforeTarget = relevantRows(before, [variableName]);
  const reconciled = relevantRows(after, [variableName]);
  const beforeOthers = before.variables.filter((row) => row.name !== variableName);
  const afterOthers = after.variables.filter((row) => row.name !== variableName);
  return forbiddenOffsiteRowsAbsent(after)
    && reconciled.length === 1
    && exactApplicationLiteralRow(reconciled[0]!, false)
    && (beforeTarget.length === 0
      || beforeTarget.length === 1 && JSON.stringify(beforeTarget[0])
        === JSON.stringify(reconciled[0]))
    && JSON.stringify(beforeOthers) === JSON.stringify(afterOthers);
}

function supabaseMetadataExact(snapshot: MetadataSnapshot): boolean {
  const names = ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
  const rows = relevantRows(snapshot, names);
  if (rows.length !== 2 || !forbiddenOffsiteRowsAbsent(snapshot)
    || !maintenanceMetadataExact(snapshot)) return false;
  return names.every((name) => {
    const named = rows.filter((row) => row.name === name);
    return named.length === 1
      && exactApplicationLiteralRow(
        named[0]!,
        name === "SUPABASE_SERVICE_ROLE_KEY",
      );
  });
}

function cleanupPostflightExact(
  before: MetadataSnapshot,
  after: MetadataSnapshot,
): boolean {
  const beforeOthers = before.variables.filter(
    (row) => !FORBIDDEN_OFFSITE_VARIABLE_NAMES.includes(
      row.name as typeof FORBIDDEN_OFFSITE_VARIABLE_NAMES[number],
    ),
  );
  return forbiddenOffsiteRowsAbsent(after)
    && JSON.stringify(beforeOthers) === JSON.stringify(after.variables);
}

function cleanupCancelPostflightExact(
  before: MetadataSnapshot,
  after: MetadataSnapshot,
): boolean {
  return forbiddenOffsiteRowsExactForDeletion(after)
    && maintenanceMetadataExact(after)
    && JSON.stringify(before.variables) === JSON.stringify(after.variables);
}

function runtimeSnapshotUnchanged(
  before: ProviderSnapshot,
  after: ProviderSnapshot,
): boolean {
  return JSON.stringify({
    serviceInstance: before.serviceInstance,
    deployment: before.deployment,
  }) === JSON.stringify({
    serviceInstance: after.serviceInstance,
    deployment: after.deployment,
  });
}

function parseAcknowledgement(value: unknown): boolean {
  return exactKeys(value, ["data"])
    && exactKeys(value.data, ["variableCollectionUpsert"])
    && value.data.variableCollectionUpsert === true;
}

function parseStageDeletionAcknowledgement(value: unknown): string | null {
  if (!(exactKeys(value, ["data"])
    && exactKeys(value.data, ["environmentStageChanges"])
    && exactKeys(value.data.environmentStageChanges, [
      "id", "environmentId", "status", "patch",
    ])
    && typeof value.data.environmentStageChanges.id === "string"
    && UUID_PATTERN.test(value.data.environmentStageChanges.id)
    && value.data.environmentStageChanges.environmentId === STAGING_ENVIRONMENT_ID
    && value.data.environmentStageChanges.status === "STAGED"
    && cleanupDeletionPatchExact(value.data.environmentStageChanges.patch))) {
    return null;
  }
  return value.data.environmentStageChanges.id;
}

function parseCancelDeletionAcknowledgement(value: unknown): boolean {
  return exactKeys(value, ["data"])
    && exactKeys(value.data, ["environmentStageChanges"])
    && exactKeys(value.data.environmentStageChanges, ["environmentId", "patch"])
    && value.data.environmentStageChanges.environmentId === STAGING_ENVIRONMENT_ID
    && plainRecord(value.data.environmentStageChanges.patch)
    && Object.keys(value.data.environmentStageChanges.patch).length === 0;
}

function parseCommitDeletionAcknowledgement(value: unknown): boolean {
  return exactKeys(value, ["data"])
    && exactKeys(value.data, ["environmentPatchCommitStaged"])
    && typeof value.data.environmentPatchCommitStaged === "string"
    && UUID_PATTERN.test(value.data.environmentPatchCommitStaged);
}

function parseCommittedDeletionPatch(
  value: unknown,
  expectedPatchId: string,
): boolean {
  return UUID_PATTERN.test(expectedPatchId)
    && exactKeys(value, ["data"])
    && exactKeys(value.data, ["environmentPatch"])
    && exactKeys(value.data.environmentPatch, [
      "id", "environmentId", "status", "patch",
    ])
    && value.data.environmentPatch.id === expectedPatchId
    && value.data.environmentPatch.environmentId === STAGING_ENVIRONMENT_ID
    && value.data.environmentPatch.status === "COMMITTED"
    && cleanupDeletionPatchExact(value.data.environmentPatch.patch);
}

function secretStrings(
  operation: ProtectedStagingVariableOperation,
  buffers: readonly Buffer[],
): Record<string, string> {
  if (operation === CLEANUP_OPERATION || cleanupRecoveryOperation(operation)
    || buffers.length !== (operation === "supabase-key-replacement" ? 2 : 1)) {
    throw new Error("secret_input_invalid");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const strings = buffers.map((buffer) => decoder.decode(buffer));
  if (strings.some((value) => value.length < 1 || /[\u0000-\u001f\u007f]/.test(value)
    || value !== value.trim())) throw new Error("secret_input_invalid");
  if (operation === "supabase-key-replacement") {
    if (!PUBLISHABLE_KEY_PATTERN.test(strings[0] ?? "")
      || !SECRET_KEY_PATTERN.test(strings[1] ?? "")
      || strings[0] === strings[1]) throw new Error("secret_input_invalid");
    return {
      SUPABASE_ANON_KEY: strings[0]!,
      SUPABASE_SERVICE_ROLE_KEY: strings[1]!,
    };
  }
  return { [PROVIDER_OPERATIONS[operation as ProviderOperation]]: strings[0]! };
}

function emptyChecks(): MutationReceipt["checks"] {
  return {
    policyExact: false,
    githubAuthorityExact: false,
    externalMutationFreezeAttested: false,
    tokenScopesExact: false,
    boundaryPreflightExact: false,
    boundaryPrecommitExact: false,
    targetPreflightExact: false,
    supabasePairCanaryExact: false,
    durableIntentExact: false,
    mutationAttemptedAtMostOnce: true,
    acknowledgementExact: false,
    stageAcknowledgementExact: false,
    commitAcknowledgementExact: false,
    stagedDeletionPatchExact: false,
    committedDeletionPatchExact: false,
    deploySuppressionExact: false,
    postflightAttempted: false,
    targetPostflightExact: false,
    deploymentUnchanged: false,
    boundaryPostflightExact: false,
    inputZeroized: false,
    terminalEvidenceExact: false,
  };
}

function policyExact(cwd: string): boolean {
  try {
    const policy = JSON.parse(fs.readFileSync(path.resolve(cwd, POLICY_PATH), "utf8")) as unknown;
    return canonical(policy) === canonical({
      schemaVersion: "pintpath-permanent-staging-variable-mutation-policy/v5",
      policyId: "pintpath-permanent-staging-protected-variable-mutations",
      activationState: PROTECTED_STAGING_VARIABLE_MUTATION_STATE,
      projectId: PROJECT_ID,
      productionEnvironmentId: PRODUCTION_ENVIRONMENT_ID,
      stagingEnvironmentId: STAGING_ENVIRONMENT_ID,
      applicationServiceId: APPLICATION_SERVICE_ID,
      githubEnvironment: "permanent-staging-provider-mutation",
      requiredGitRef: "refs/heads/main",
      authorizedBaselines: {
        healthyLegacyOneReplica: {
          replicas: 1,
          latestDeploymentStatus: "SUCCESS",
          latestDeploymentStopped: false,
          activeDeploymentCount: 1,
          candidateDeploymentForbidden: true,
          deploymentPatchId: null,
          sourceDetached: false,
          stagedPatchEmpty: true,
        },
        coldDeadNullReplica: {
          serviceInstanceId: COLD_DEAD_SERVICE_INSTANCE_ID,
          replicas: null,
          sourceRepo: null,
          sourceImage: null,
          latestDeploymentId: COLD_DEAD_DEPLOYMENT_ID,
          latestDeploymentStatus: "FAILED",
          latestDeploymentStopped: true,
          snapshotId: COLD_DEAD_SNAPSHOT_ID,
          sourceSha: COLD_DEAD_SOURCE_SHA,
          deploymentImageDigest: null,
          deploymentPatchId: null,
          activeDeploymentCount: 0,
          serviceDomainId: COLD_DEAD_DOMAIN_ID,
          stagedPatchEmpty: true,
        },
        domain: STAGING_DOMAIN,
        targetPort: APPLICATION_TARGET_PORT,
      },
      operations: {
        providerReconciliations: Object.values(PROVIDER_OPERATIONS),
        supabaseAtomicReplacement: [
          "SUPABASE_ANON_KEY",
          "SUPABASE_SERVICE_ROLE_KEY",
        ],
        supabasePairCanary: {
          origin: "https://bbfibbadwjxzrcdncavy.supabase.co",
          publishableEndpoint: "/auth/v1/settings",
          secretEndpoint: "/rest/v1/profiles?select=id&limit=1",
          exactInputPairRequired: true,
          requiredHttpStatus: 200,
          mustCompleteBeforeRailwayWrite: true,
        },
        stagingForbiddenVariableDeletion: [...FORBIDDEN_OFFSITE_VARIABLE_NAMES],
        stagingForbiddenVariableDeletionPatchSha256: CLEANUP_PATCH_SHA256,
        stagingForbiddenVariableDeletionRecoveryOperations: [
          ...CLEANUP_RECOVERY_OPERATIONS,
        ],
      },
      mutationPlans: {
        variableUpsert: {
          operationName: "variableCollectionUpsert",
          skipDeploys: true,
          maximumAttempts: 1,
        },
        forbiddenVariableDeletion: {
          stageOperationName: "environmentStageChanges",
          merge: false,
          stageMaximumAttempts: 1,
          commitOperationName: "environmentPatchCommitStaged",
          commitSkipDeploys: true,
          commitMaximumAttempts: 1,
          exactApplicationServicePatchOnly: true,
          strandedPatchRecovery: {
            reviewedPriorCandidateRunAuthorityRequired: true,
            priorArtifactVerification: "OPTIONAL_ADDITIONAL_IF_AVAILABLE",
            exactPatchSha256: CLEANUP_PATCH_SHA256,
            resumeOperationName: "environmentPatchCommitStaged",
            resumeSkipDeploys: true,
            cancelOperationName: "environmentStageChanges",
            cancelReplacementPatch: {},
            cancelMerge: false,
            completedDeletionReadOnlyReconciliationAllowed: true,
            completedDeletionMaximumAttempts: 0,
            noEffectRecovery: {
              exactOriginalRowsAndEmptyPatchRequired: true,
              resumeStageMaximumAttempts: 1,
              resumeCommitMaximumAttempts: 1,
              cancelReadOnlyMaximumAttempts: 0,
              ambiguousSameModeRedispatchAllowed: true,
            },
            maximumAttempts: 1,
            crossOperationRetryAllowed: false,
          },
        },
        automaticRetriesAllowed: false,
        rerunsAllowed: false,
        externalMutationFreeze: {
          required: true,
          dispatchAttestation: EXTERNAL_MUTATION_FREEZE_ATTESTATION,
          enforcement: EXTERNAL_MUTATION_FREEZE_ENFORCEMENT,
          providerCommitSelector: "ENVIRONMENT_ID_ONLY",
          providerStagedCommitPatchIdCasOrLockAvailable: false,
          residualRisk:
            "OUT_OF_BAND_STAGED_PATCH_REPLACEMENT_CAN_COMMIT_BEFORE_POSTFLIGHT_DETECTION",
        },
        unconditionalPostflightRequired: true,
        ambiguousOutcomeAction:
          "REVIEWED_SAME_MODE_CONVERGENCE_NO_CROSS_MODE",
      },
      evidence: {
        durableIntentRequiredBeforeAttempt: true,
        terminalEvidenceRequired: true,
        secretMaterialAllowed: false,
        secretDerivedCommitmentsAllowed: false,
      },
    });
  } catch {
    return false;
  }
}

function fixedReceipt(
  operation: ProtectedStagingVariableOperation | null,
  outcome: MutationReceipt["outcome"],
  candidateSha: string | null,
  attempts: 0 | 1 | 2,
  intentSha256: string | null,
  terminalEvidenceSha256: string | null,
  stagedDeletionPatchId: string | null,
  supabaseKeyCanary: PermanentStagingSupabasePairCanaryEvidence | null,
  checks: MutationReceipt["checks"],
): MutationReceipt {
  return {
    schemaVersion: PROTECTED_STAGING_VARIABLE_MUTATION_SCHEMA,
    executorState: PROTECTED_STAGING_VARIABLE_MUTATION_STATE,
    operation,
    outcome,
    candidateSha,
    attempts,
    retryAllowed: false,
    intentSha256,
    terminalEvidenceSha256,
    externalMutationFreeze: {
      attestation: checks.externalMutationFreezeAttested
        ? EXTERNAL_MUTATION_FREEZE_ATTESTATION
        : null,
      enforcement: EXTERNAL_MUTATION_FREEZE_ENFORCEMENT,
      providerCasOrLockVerified: false,
    },
    stagedDeletionPatchId,
    supabaseKeyCanary,
    checks,
  };
}

export async function runProtectedPermanentStagingVariableMutation(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    boundaryCheck: (expectedStagingPatch = "empty") =>
      expectedStagingPatch === "empty"
        ? runRailwayMutationBoundaryCheck({
            argv: ["--policy", BOUNDARY_POLICY_PATH],
          })
        : runRailwayExactStagedPatchBoundaryCheck(
            path.resolve(dependencies.cwd, BOUNDARY_POLICY_PATH),
            cleanupDeletionPatch(),
          ),
    readSecretFile: readPrivateSecretFile,
    verifyPriorCleanupEvidence: priorCleanupEvidenceExact,
    verifyReviewedCleanupRecoveryAuthority:
      reviewedCleanupRecoveryAuthorityExact,
    writeDurable: durableWrite,
    writeOutput: (source) => process.stdout.write(source),
    ...overrides,
  };
  const args = parseArguments(dependencies.argv);
  const checks = emptyChecks();
  let operation: ProtectedStagingVariableOperation | null = args?.operation ?? null;
  let candidateSha: string | null = null;
  let attempts: 0 | 1 | 2 = 0;
  let intentSha: string | null = null;
  let terminalSha: string | null = null;
  let outcome: MutationReceipt["outcome"] = "blocked";
  let buffers: Buffer[] = [];
  let before: ProviderSnapshot | null = null;
  let variables: Record<string, string> | null = null;
  let supabaseKeyCanary: PermanentStagingSupabasePairCanaryEvidence | null = null;
  let metadataToken = "";
  let authorizedBaseline: "healthy-legacy-one" | "cold-dead-null" | null = null;
  let priorCleanupEvidenceVerified = false;
  let cleanupAlreadyCompletedAtPreflight = false;
  let cleanupNoEffectAtPreflight = false;
  let stageAcknowledgementExact = false;
  let commitAcknowledgementExact = false;
  let stagedDeletionPatchId: string | null = null;
  try {
    checks.policyExact = policyExact(dependencies.cwd);
    checks.externalMutationFreezeAttested =
      dependencies.env.PINTPATH_EXTERNAL_MUTATION_FREEZE_ATTESTATION ===
        EXTERNAL_MUTATION_FREEZE_ATTESTATION;
    candidateSha = dependencies.env.GITHUB_SHA ?? null;
    const confirmation = operation
      ? `MUTATE_${operation.toUpperCase().replaceAll("-", "_")}_IN_PERMANENT_STAGING`
      : "";
    const requestedRecovery = args !== null && cleanupRecoveryOperation(args.operation);
    checks.githubAuthorityExact = dependencies.env.GITHUB_REF === "refs/heads/main"
      && candidateSha !== null && SHA_PATTERN.test(candidateSha)
      && dependencies.env.GITHUB_RUN_ATTEMPT === "1"
      && dependencies.env.PINTPATH_MUTATION_CONFIRMATION === confirmation
      && (requestedRecovery
        ? dependencies.env.PINTPATH_PRIOR_CLEANUP_RUN_ID ===
          args?.priorCleanupRunId
          && dependencies.env.GITHUB_REPOSITORY ===
            REVIEWED_AUTHORITY_REPOSITORY
          && RUN_ID_PATTERN.test(dependencies.env.GITHUB_RUN_ID ?? "")
          && dependencies.verifyReviewedCleanupRecoveryAuthority(
            args!.reviewedAuthorityFile!,
            {
              candidateSha: candidateSha!,
              operation: args!.operation as typeof RESUME_CLEANUP_OPERATION |
                typeof CANCEL_CLEANUP_OPERATION,
              priorCleanupRunId: args!.priorCleanupRunId!,
              currentRunId: dependencies.env.GITHUB_RUN_ID!,
            },
          )
        : !dependencies.env.PINTPATH_PRIOR_CLEANUP_RUN_ID);
    if (!args || !checks.policyExact || !checks.githubAuthorityExact
      || !checks.externalMutationFreezeAttested) {
      throw new Error("authority_invalid");
    }
    const activeOperation = args.operation;
    const recovery = cleanupRecoveryOperation(activeOperation);
    priorCleanupEvidenceVerified = !recovery ||
      args.priorCleanupEvidenceDirectory === null ||
      dependencies.verifyPriorCleanupEvidence(
        args.priorCleanupEvidenceDirectory,
        candidateSha!,
      );
    if (!priorCleanupEvidenceVerified) {
      throw new Error("prior_cleanup_evidence_invalid");
    }
    const mutationToken = dependencies.env.PINTPATH_RAILWAY_STAGING_MUTATION_TOKEN ?? "";
    metadataToken = dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    if (!TOKEN_PATTERN.test(mutationToken) || !TOKEN_PATTERN.test(metadataToken)
      || mutationToken === metadataToken) throw new Error("token_invalid");
    const [mutationScope, metadataScope] = await Promise.all([
      graphql(dependencies.fetchImpl, mutationToken,
        PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY, {}),
      graphql(dependencies.fetchImpl, metadataToken,
        PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY, {}),
    ]);
    checks.tokenScopesExact = parseScope(mutationScope) && parseScope(metadataScope);
    if (!checks.tokenScopesExact) throw new Error("token_scope_invalid");
    checks.boundaryPreflightExact = await dependencies.boundaryCheck() === 0;
    if (!checks.boundaryPreflightExact) throw new Error("boundary_invalid");
    before = await readProviderSnapshot(
      dependencies.fetchImpl,
      metadataToken,
      recovery ? "empty-or-cleanup-deletion" : "empty",
    );
    authorizedBaseline = before === null
      ? null
      : recovery
        ? authorizedCleanupRecoveryBaselineKind(before, candidateSha)
        : authorizedBaselineKind(before, candidateSha);
    const variableName = Object.hasOwn(PROVIDER_OPERATIONS, activeOperation)
      ? PROVIDER_OPERATIONS[activeOperation as ProviderOperation]
      : null;
    checks.targetPreflightExact = before !== null
      && authorizedBaseline !== null
      && (activeOperation === CLEANUP_OPERATION
        ? forbiddenOffsiteRowsExactForDeletion(before)
          && maintenanceMetadataExact(before)
        : recovery
          ? priorCleanupEvidenceVerified
            && maintenanceMetadataExact(before)
            && (!before.stagedPatchEmpty
              ? forbiddenOffsiteRowsExactForDeletion(before)
              : forbiddenOffsiteRowsExactForDeletion(before)
                || activeOperation === RESUME_CLEANUP_OPERATION
                  && forbiddenOffsiteRowsAbsent(before))
        : activeOperation === "supabase-key-replacement"
          ? supabaseMetadataExact(before)
          : providerPreflightExact(before, variableName!));
    if (!checks.targetPreflightExact || !before) throw new Error("target_invalid");
    cleanupAlreadyCompletedAtPreflight = recovery
      && activeOperation === RESUME_CLEANUP_OPERATION
      && before.stagedPatchEmpty
      && forbiddenOffsiteRowsAbsent(before);
    cleanupNoEffectAtPreflight = recovery
      && before.stagedPatchEmpty
      && forbiddenOffsiteRowsExactForDeletion(before);
    buffers = args.valueFiles.map((filename) => dependencies.readSecretFile(filename));
    variables = activeOperation === CLEANUP_OPERATION || recovery
      ? null
      : secretStrings(activeOperation, buffers);
    if (activeOperation === CLEANUP_OPERATION || recovery) checks.inputZeroized = true;
    const cleanup = activeOperation === CLEANUP_OPERATION;
    const cleanupOrRecovery = cleanup || recovery;
    const intent = canonical({
      schemaVersion: "pintpath-permanent-staging-variable-mutation-intent/v4",
      operation: activeOperation,
      candidateSha,
      projectId: PROJECT_ID,
      environmentId: STAGING_ENVIRONMENT_ID,
      serviceId: APPLICATION_SERVICE_ID,
      externalMutationFreeze: {
        attestation: EXTERNAL_MUTATION_FREEZE_ATTESTATION,
        enforcement: EXTERNAL_MUTATION_FREEZE_ENFORCEMENT,
        providerCasOrLockVerified: false,
      },
      authorizedBaseline,
      variableNames: cleanupOrRecovery
        ? [...FORBIDDEN_OFFSITE_VARIABLE_NAMES]
        : Object.keys(variables!),
      mutationPlan: cleanup
        ? {
            stage: {
              mutation: "environmentStageChanges",
              merge: false,
              maximumAttempts: 1,
              patch: cleanupDeletionPatch(),
            },
            commit: {
              mutation: "environmentPatchCommitStaged",
              skipDeploys: true,
              maximumAttempts: 1,
              commitMessage: `pintpath:staging-offsite-cleanup:${candidateSha}`,
            },
          }
        : recovery
          ? {
              recovery: cleanupAlreadyCompletedAtPreflight
                ? {
                    action: "reconcile-exact-completed-deletion",
                    mutation: null,
                    maximumAttempts: 0,
                  }
                : cleanupNoEffectAtPreflight &&
                    activeOperation === RESUME_CLEANUP_OPERATION
                  ? {
                      action: "retry-after-exact-no-effect",
                      stage: {
                        mutation: "environmentStageChanges",
                        merge: false,
                        maximumAttempts: 1,
                        patch: cleanupDeletionPatch(),
                      },
                      commit: {
                        mutation: "environmentPatchCommitStaged",
                        skipDeploys: true,
                        maximumAttempts: 1,
                        commitMessage:
                          `pintpath:staging-offsite-cleanup:${candidateSha}`,
                      },
                    }
                  : cleanupNoEffectAtPreflight
                    ? {
                        action: "reconcile-exact-already-cancelled-deletion",
                        mutation: null,
                        maximumAttempts: 0,
                      }
                : activeOperation === RESUME_CLEANUP_OPERATION
                ? {
                    action: "resume-exact-staged-patch",
                    mutation: "environmentPatchCommitStaged",
                    skipDeploys: true,
                    maximumAttempts: 1,
                    commitMessage:
                      `pintpath:staging-offsite-cleanup:${candidateSha}`,
                  }
                : {
                    action: "cancel-exact-staged-patch",
                    mutation: "environmentStageChanges",
                    replacementPatch: {},
                    merge: false,
                    maximumAttempts: 1,
                  },
              priorCleanupRunId: args.priorCleanupRunId,
              exactStagedPatchSha256: CLEANUP_PATCH_SHA256,
              reviewedPriorCleanupRunAuthorityExact: true,
              priorCleanupArtifactProvided:
                args.priorCleanupEvidenceDirectory !== null,
              priorCleanupArtifactExact:
                args.priorCleanupEvidenceDirectory === null
                  ? null
                  : priorCleanupEvidenceVerified,
            }
        : {
            mutation: "variableCollectionUpsert",
            skipDeploys: true,
            maximumAttempts: 1,
          },
      retryAllowed: false,
      privateInputCount: buffers.length,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
      preflightMetadataSha256: sha256(canonical(before)),
    });
    intentSha = dependencies.writeDurable(args.evidenceDirectory, "intent.json", intent);
    checks.durableIntentExact = intentSha === sha256(intent);
    if (!checks.durableIntentExact) throw new Error("intent_invalid");
    const prewrite = await readProviderSnapshot(
      dependencies.fetchImpl,
      metadataToken,
      recovery ? "empty-or-cleanup-deletion" : "empty",
    );
    checks.targetPreflightExact = prewrite !== null
      && authorizedBaseline !== null
      && canonical(prewrite) === canonical(before)
      && (recovery
        ? authorizedCleanupRecoveryBaselineKind(prewrite, candidateSha)
        : authorizedBaselineKind(prewrite, candidateSha)) === authorizedBaseline
      && (cleanup
        ? forbiddenOffsiteRowsExactForDeletion(prewrite)
          && maintenanceMetadataExact(prewrite)
        : recovery
          ? maintenanceMetadataExact(prewrite)
            && (cleanupAlreadyCompletedAtPreflight
              ? prewrite.stagedPatchEmpty
                && forbiddenOffsiteRowsAbsent(prewrite)
              : cleanupNoEffectAtPreflight
                ? prewrite.stagedPatchEmpty
                  && forbiddenOffsiteRowsExactForDeletion(prewrite)
              : !prewrite.stagedPatchEmpty
                && forbiddenOffsiteRowsExactForDeletion(prewrite))
        : activeOperation === "supabase-key-replacement"
          ? supabaseMetadataExact(prewrite)
          : providerPreflightExact(prewrite, variableName!));
    if (!checks.targetPreflightExact) throw new Error("prewrite_target_invalid");
    if (activeOperation === "supabase-key-replacement") {
      supabaseKeyCanary = await canaryPermanentStagingSupabaseKeyPair({
        fetchImpl: dependencies.fetchImpl,
        publishableKey: variables!.SUPABASE_ANON_KEY!,
        secretKey: variables!.SUPABASE_SERVICE_ROLE_KEY!,
      });
      checks.supabasePairCanaryExact =
        supabaseKeyCanary.publishableHttpStatus === 200 &&
        supabaseKeyCanary.secretHttpStatus === 200 &&
        Object.values(supabaseKeyCanary.checks).every((value) => value === true) &&
        supabaseKeyCanary.secretMaterialIncluded === false &&
        supabaseKeyCanary.secretDerivedCommitmentsIncluded === false;
      if (!checks.supabasePairCanaryExact) throw new Error("supabase_canary_invalid");
    } else {
      checks.supabasePairCanaryExact = true;
    }
    if (cleanup) {
      attempts = 1;
      try {
        stagedDeletionPatchId = parseStageDeletionAcknowledgement(await graphql(
          dependencies.fetchImpl,
          mutationToken,
          PROTECTED_STAGING_VARIABLE_STAGE_DELETION_QUERY,
          {
            environmentId: STAGING_ENVIRONMENT_ID,
            input: cleanupDeletionPatch(),
            merge: false,
          },
        ));
        stageAcknowledgementExact = stagedDeletionPatchId !== null;
      } catch {
        stageAcknowledgementExact = false;
      }
      checks.stageAcknowledgementExact = stageAcknowledgementExact;
      let staged: ProviderSnapshot | null = null;
      try {
        staged = await readProviderSnapshot(
          dependencies.fetchImpl,
          metadataToken,
          "cleanup-deletion",
        );
      } catch {
        staged = null;
      }
      checks.stagedDeletionPatchExact = staged !== null
        && !staged.stagedPatchEmpty
        && staged.stagedPatchStatus === "STAGED"
        && (stagedDeletionPatchId === null
          || staged.stagedPatchId === stagedDeletionPatchId)
        && JSON.stringify(staged.variables) === JSON.stringify(before.variables)
        && runtimeSnapshotUnchanged(before, staged);
      if (!checks.stagedDeletionPatchExact) throw new Error("staged_patch_invalid");
      stagedDeletionPatchId = staged!.stagedPatchId;
      checks.boundaryPrecommitExact = await dependencies.boundaryCheck(
        "cleanup-deletion",
      ) === 0;
      if (!checks.boundaryPrecommitExact) throw new Error("precommit_boundary_invalid");
      attempts = 2;
      try {
        commitAcknowledgementExact = parseCommitDeletionAcknowledgement(await graphql(
          dependencies.fetchImpl,
          mutationToken,
          PROTECTED_STAGING_VARIABLE_COMMIT_DELETION_QUERY,
          {
            environmentId: STAGING_ENVIRONMENT_ID,
            commitMessage: `pintpath:staging-offsite-cleanup:${candidateSha}`,
            skipDeploys: true,
          },
        ));
      } catch {
        commitAcknowledgementExact = false;
      }
      checks.commitAcknowledgementExact = commitAcknowledgementExact;
      checks.acknowledgementExact = stageAcknowledgementExact
        && commitAcknowledgementExact;
      try {
        checks.committedDeletionPatchExact = stagedDeletionPatchId !== null
          && parseCommittedDeletionPatch(await graphql(
            dependencies.fetchImpl,
            metadataToken,
            PROTECTED_STAGING_VARIABLE_PATCH_QUERY,
            { patchId: stagedDeletionPatchId },
          ), stagedDeletionPatchId);
      } catch {
        checks.committedDeletionPatchExact = false;
      }
    } else if (recovery) {
      const readOnlyRecovery = cleanupAlreadyCompletedAtPreflight ||
        cleanupNoEffectAtPreflight &&
          activeOperation === CANCEL_CLEANUP_OPERATION;
      checks.stagedDeletionPatchExact = !readOnlyRecovery
        && prewrite !== null
        && !prewrite.stagedPatchEmpty
        && prewrite.stagedPatchStatus === "STAGED"
        && sha256(canonical(cleanupDeletionPatch())) === CLEANUP_PATCH_SHA256;
      if (checks.stagedDeletionPatchExact) {
        stagedDeletionPatchId = prewrite!.stagedPatchId;
      }
      if (readOnlyRecovery) {
        attempts = 0;
      } else if (cleanupNoEffectAtPreflight) {
        attempts = 1;
        try {
          stagedDeletionPatchId = parseStageDeletionAcknowledgement(await graphql(
            dependencies.fetchImpl,
            mutationToken,
            PROTECTED_STAGING_VARIABLE_STAGE_DELETION_QUERY,
            {
              environmentId: STAGING_ENVIRONMENT_ID,
              input: cleanupDeletionPatch(),
              merge: false,
            },
          ));
          stageAcknowledgementExact = stagedDeletionPatchId !== null;
        } catch {
          stageAcknowledgementExact = false;
        }
        checks.stageAcknowledgementExact = stageAcknowledgementExact;
        let staged: ProviderSnapshot | null = null;
        try {
          staged = await readProviderSnapshot(
            dependencies.fetchImpl,
            metadataToken,
            "cleanup-deletion",
          );
        } catch {
          staged = null;
        }
        checks.stagedDeletionPatchExact = staged !== null
          && !staged.stagedPatchEmpty
          && staged.stagedPatchStatus === "STAGED"
          && (stagedDeletionPatchId === null
            || staged.stagedPatchId === stagedDeletionPatchId)
          && JSON.stringify(staged.variables) === JSON.stringify(before.variables)
          && runtimeSnapshotUnchanged(before, staged);
        if (!checks.stagedDeletionPatchExact) throw new Error("staged_patch_invalid");
        stagedDeletionPatchId = staged!.stagedPatchId;
        checks.boundaryPrecommitExact = await dependencies.boundaryCheck(
          "cleanup-deletion",
        ) === 0;
        if (!checks.boundaryPrecommitExact) {
          throw new Error("precommit_boundary_invalid");
        }
        attempts = 2;
      } else {
        checks.boundaryPrecommitExact = await dependencies.boundaryCheck(
          "cleanup-deletion",
        ) === 0;
        if (!checks.boundaryPrecommitExact) throw new Error("precommit_boundary_invalid");
        attempts = 1;
      }
      if (activeOperation === RESUME_CLEANUP_OPERATION
        && !cleanupAlreadyCompletedAtPreflight) {
        try {
          commitAcknowledgementExact = parseCommitDeletionAcknowledgement(await graphql(
            dependencies.fetchImpl,
            mutationToken,
            PROTECTED_STAGING_VARIABLE_COMMIT_DELETION_QUERY,
            {
              environmentId: STAGING_ENVIRONMENT_ID,
              commitMessage: `pintpath:staging-offsite-cleanup:${candidateSha}`,
              skipDeploys: true,
            },
          ));
        } catch {
          commitAcknowledgementExact = false;
        }
        checks.commitAcknowledgementExact = commitAcknowledgementExact;
        checks.acknowledgementExact = cleanupNoEffectAtPreflight
          ? stageAcknowledgementExact && commitAcknowledgementExact
          : commitAcknowledgementExact;
        try {
          checks.committedDeletionPatchExact = stagedDeletionPatchId !== null
            && parseCommittedDeletionPatch(await graphql(
              dependencies.fetchImpl,
              metadataToken,
              PROTECTED_STAGING_VARIABLE_PATCH_QUERY,
              { patchId: stagedDeletionPatchId },
            ), stagedDeletionPatchId);
        } catch {
          checks.committedDeletionPatchExact = false;
        }
      } else if (activeOperation === CANCEL_CLEANUP_OPERATION
        && !cleanupNoEffectAtPreflight) {
        try {
          stageAcknowledgementExact = parseCancelDeletionAcknowledgement(await graphql(
            dependencies.fetchImpl,
            mutationToken,
            PROTECTED_STAGING_VARIABLE_CANCEL_DELETION_QUERY,
            {
              environmentId: STAGING_ENVIRONMENT_ID,
              input: {},
              merge: false,
            },
          ));
        } catch {
          stageAcknowledgementExact = false;
        }
        checks.stageAcknowledgementExact = stageAcknowledgementExact;
        checks.acknowledgementExact = stageAcknowledgementExact;
      }
    } else {
      attempts = 1;
      try {
        checks.acknowledgementExact = parseAcknowledgement(await graphql(
          dependencies.fetchImpl,
          mutationToken,
          PROTECTED_STAGING_VARIABLE_MUTATION_QUERY,
          {
            projectId: PROJECT_ID,
            environmentId: STAGING_ENVIRONMENT_ID,
            serviceId: APPLICATION_SERVICE_ID,
            variables,
            skipDeploys: true,
          },
        ));
      } catch {
        checks.acknowledgementExact = false;
      }
      variables = null;
      for (const buffer of buffers) buffer.fill(0);
      checks.inputZeroized = buffers.every(
        (buffer) => buffer.every((byte) => byte === 0),
      );
    }
    checks.postflightAttempted = true;
    let after: ProviderSnapshot | null = null;
    try {
      after = await readProviderSnapshot(dependencies.fetchImpl, metadataToken);
    } catch {
      after = null;
    }
    checks.deploymentUnchanged = after !== null
      && runtimeSnapshotUnchanged(before, after);
    checks.targetPostflightExact = after !== null
      && authorizedBaselineKind(after, candidateSha) === authorizedBaseline
      && (cleanup
        ? cleanupPostflightExact(before, after)
        : recovery
          ? activeOperation === RESUME_CLEANUP_OPERATION
            ? cleanupPostflightExact(before, after)
            : cleanupCancelPostflightExact(before, after)
        : activeOperation === "supabase-key-replacement"
          ? supabaseMetadataExact(after)
            && JSON.stringify(before.variables) === JSON.stringify(after.variables)
          : providerPostflightExact(before, after, variableName!));
    checks.deploySuppressionExact = checks.deploymentUnchanged;
    try {
      checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
    } catch {
      checks.boundaryPostflightExact = false;
    }
    outcome = "mutation_uncertain";
  } catch {
    outcome = attempts > 0 ? "mutation_uncertain" : "failed_before_attempt";
  } finally {
    variables = null;
    for (const buffer of buffers) buffer.fill(0);
    checks.inputZeroized = buffers.every(
      (buffer) => buffer.every((byte) => byte === 0),
    );
    if (attempts > 0 && !checks.postflightAttempted) {
      checks.postflightAttempted = true;
      let after: ProviderSnapshot | null = null;
      try {
        after = await readProviderSnapshot(
          dependencies.fetchImpl,
          metadataToken,
          operation === CLEANUP_OPERATION && attempts === 1
            ? "cleanup-deletion"
            : "empty",
        );
      } catch { after = null; }
      if (before && operation) {
        checks.deploymentUnchanged = after !== null
          && runtimeSnapshotUnchanged(before, after);
        if (operation === CLEANUP_OPERATION && attempts === 1) {
          checks.stagedDeletionPatchExact = after !== null
            && !after.stagedPatchEmpty
            && after.stagedPatchStatus === "STAGED"
            && (stagedDeletionPatchId === null
              || after.stagedPatchId === stagedDeletionPatchId)
            && JSON.stringify(after.variables) === JSON.stringify(before.variables)
            && checks.deploymentUnchanged;
          if (checks.stagedDeletionPatchExact) {
            stagedDeletionPatchId = after!.stagedPatchId;
          }
          checks.targetPostflightExact = false;
        } else {
          const variableName = Object.hasOwn(PROVIDER_OPERATIONS, operation)
            ? PROVIDER_OPERATIONS[operation as ProviderOperation]
            : null;
          const recovery = cleanupRecoveryOperation(operation);
          checks.targetPostflightExact = after !== null
            && authorizedBaselineKind(after, candidateSha) === authorizedBaseline
            && (operation === CLEANUP_OPERATION
              ? cleanupPostflightExact(before, after)
              : recovery
                ? operation === RESUME_CLEANUP_OPERATION
                  ? cleanupPostflightExact(before, after)
                  : cleanupCancelPostflightExact(before, after)
              : operation === "supabase-key-replacement"
                ? supabaseMetadataExact(after)
                  && JSON.stringify(before.variables) === JSON.stringify(after.variables)
                : providerPostflightExact(before, after, variableName!));
        }
        checks.deploySuppressionExact = attempts === 2
          ? checks.deploymentUnchanged && checks.targetPostflightExact
          : operation !== CLEANUP_OPERATION && checks.deploymentUnchanged;
      }
    }
    if (checks.boundaryPreflightExact && !checks.boundaryPostflightExact) {
      try {
        checks.boundaryPostflightExact = await dependencies.boundaryCheck() === 0;
      } catch {
        checks.boundaryPostflightExact = false;
      }
    }
  }
  const commonSuccess = checks.targetPostflightExact
    && checks.externalMutationFreezeAttested
    && checks.supabasePairCanaryExact
    && checks.deploymentUnchanged
    && checks.deploySuppressionExact
    && checks.boundaryPostflightExact
    && checks.inputZeroized;
  if (operation === CLEANUP_OPERATION) {
    const cleanupSuccess = attempts === 2
      && checks.stagedDeletionPatchExact
      && checks.committedDeletionPatchExact
      && checks.boundaryPrecommitExact
      && commonSuccess;
    outcome = cleanupSuccess
      ? checks.acknowledgementExact
        ? "cleanup_acknowledged"
        : "cleanup_reconciled_after_lost_ack"
      : attempts > 0
        ? "mutation_uncertain"
        : outcome;
  } else if (operation !== null && cleanupRecoveryOperation(operation)) {
    const recoveryWriteSuccess = attempts === 1
      && priorCleanupEvidenceVerified
      && checks.stagedDeletionPatchExact
      && (operation === RESUME_CLEANUP_OPERATION
        ? checks.committedDeletionPatchExact
        : !checks.committedDeletionPatchExact)
      && checks.boundaryPrecommitExact
      && commonSuccess;
    const recoveryReadOnlySuccess = operation === RESUME_CLEANUP_OPERATION
      && attempts === 0
      && cleanupAlreadyCompletedAtPreflight
      && priorCleanupEvidenceVerified
      && !checks.stagedDeletionPatchExact
      && !checks.committedDeletionPatchExact
      && !checks.boundaryPrecommitExact
      && commonSuccess;
    const recoveryNoEffectRetrySuccess = operation === RESUME_CLEANUP_OPERATION
      && attempts === 2
      && cleanupNoEffectAtPreflight
      && priorCleanupEvidenceVerified
      && checks.stagedDeletionPatchExact
      && checks.committedDeletionPatchExact
      && checks.boundaryPrecommitExact
      && commonSuccess;
    const recoveryAlreadyCancelledSuccess =
      operation === CANCEL_CLEANUP_OPERATION
      && attempts === 0
      && cleanupNoEffectAtPreflight
      && priorCleanupEvidenceVerified
      && !checks.stagedDeletionPatchExact
      && !checks.committedDeletionPatchExact
      && !checks.boundaryPrecommitExact
      && commonSuccess;
    outcome = recoveryReadOnlySuccess
      ? "cleanup_already_completed_reconciled"
      : recoveryAlreadyCancelledSuccess
        ? "cleanup_already_cancelled_reconciled"
        : recoveryNoEffectRetrySuccess
          ? checks.acknowledgementExact
            ? "cleanup_no_effect_retry_acknowledged"
            : "cleanup_no_effect_retry_reconciled_after_lost_ack"
      : recoveryWriteSuccess
        ? operation === RESUME_CLEANUP_OPERATION
        ? checks.acknowledgementExact
          ? "cleanup_patch_resume_acknowledged"
          : "cleanup_patch_resume_reconciled_after_lost_ack"
        : checks.acknowledgementExact
          ? "cleanup_patch_cancel_acknowledged"
          : "cleanup_patch_cancel_reconciled_after_lost_ack"
        : attempts > 0
          ? "mutation_uncertain"
          : outcome;
  } else if (attempts === 1) {
    outcome = checks.acknowledgementExact && commonSuccess
      ? "acknowledged_pending_runtime_proof"
      : "mutation_uncertain";
  }
  const provisional = fixedReceipt(
    operation,
    outcome,
    candidateSha,
    attempts,
    intentSha,
    null,
    stagedDeletionPatchId,
    supabaseKeyCanary,
    checks,
  );
  if (args && checks.durableIntentExact) {
    try {
      const terminal = canonical({
        schemaVersion: "pintpath-permanent-staging-variable-mutation-terminal/v4",
        receipt: provisional,
        secretMaterialIncluded: false,
        secretDerivedCommitmentsIncluded: false,
      });
      terminalSha = dependencies.writeDurable(
        args.evidenceDirectory,
        "terminal.json",
        terminal,
      );
      checks.terminalEvidenceExact = terminalSha === sha256(terminal);
    } catch {
      checks.terminalEvidenceExact = false;
      if (attempts > 0) outcome = "mutation_uncertain";
    }
  }
  const receipt = fixedReceipt(
    operation,
    outcome,
    candidateSha,
    attempts,
    intentSha,
    terminalSha,
    stagedDeletionPatchId,
    supabaseKeyCanary,
    checks,
  );
  dependencies.writeOutput(`${JSON.stringify(receipt)}\n`);
  return [
    "acknowledged_pending_runtime_proof",
    "cleanup_acknowledged",
    "cleanup_reconciled_after_lost_ack",
    "cleanup_patch_resume_acknowledged",
    "cleanup_patch_resume_reconciled_after_lost_ack",
    "cleanup_patch_cancel_acknowledged",
    "cleanup_patch_cancel_reconciled_after_lost_ack",
    "cleanup_already_completed_reconciled",
    "cleanup_no_effect_retry_acknowledged",
    "cleanup_no_effect_retry_reconciled_after_lost_ack",
    "cleanup_already_cancelled_reconciled",
  ].includes(receipt.outcome) && receipt.checks.terminalEvidenceExact ? 0 : 1;
}

export const protectedPermanentStagingVariableMutationInternals = {
  cleanupDeletionPatch,
  cleanupDeletionPatchExact,
  cleanupPostflightExact,
  exactColdDeadBaseline,
  exactHealthyLegacyBaseline,
  forbiddenOffsiteRowsExactForDeletion,
  parseAcknowledgement,
  parseArguments,
  parseCommitDeletionAcknowledgement,
  parseCommittedDeletionPatch,
  parseDeployment,
  parseMetadata,
  parseScope,
  parseStageDeletionAcknowledgement,
  priorCleanupEvidenceExact,
  providerPostflightExact,
  providerPreflightExact,
  reviewedCleanupRecoveryAuthorityValueExact,
  secretStrings,
  supabaseMetadataExact,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedPermanentStagingVariableMutation();
}
