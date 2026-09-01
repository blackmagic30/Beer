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
const STAGED_DELETION_PROOF_ATTESTATION_PATH =
  "docs/incident-evidence/railway-staged-deletion-proof-2026-08-29/attestation.json";
const STAGED_DELETION_PROOF_ATTESTATION_SHA256 =
  "e1faa9daff1ff4927c852ccf08b917f77b7893f77a04c20bbe192f556e276de2";
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
    message
    createdAt
    updatedAt
    appliedAt
    lastAppliedError
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
  `query PintPathProtectedEnvironmentPatch(
  $environmentId: String!
  $patchId: String!
) {
  activeMasked: environmentStagedChanges(environmentId: $environmentId) {
    id
    environmentId
    status
    message
    createdAt
    updatedAt
    appliedAt
    lastAppliedError
    patch(decryptVariables: false)
  }
  activeDecrypted: environmentStagedChanges(environmentId: $environmentId) {
    id
    environmentId
    status
    message
    createdAt
    updatedAt
    appliedAt
    lastAppliedError
    patch(decryptVariables: true)
  }
  selectedMasked: environmentPatch(id: $patchId) {
    id
    environmentId
    status
    message
    createdAt
    updatedAt
    appliedAt
    lastAppliedError
    patch(decryptVariables: false)
  }
  selectedDecrypted: environmentPatch(id: $patchId) {
    id
    environmentId
    status
    message
    createdAt
    updatedAt
    appliedAt
    lastAppliedError
    patch(decryptVariables: true)
  }
}`;

export const PROTECTED_STAGING_VARIABLE_INCIDENT_PATCH_QUERY =
  `query PintPathProtectedIncidentEnvironmentPatch(
  $environmentId: String!
  $patchId: String!
) {
  active: environmentStagedChanges(environmentId: $environmentId) {
    id
    environmentId
    status
    message
    createdAt
    updatedAt
    appliedAt
    lastAppliedError
    patch(decryptVariables: false)
  }
  selected: environmentPatch(id: $patchId) {
    id
    environmentId
    status
    message
    createdAt
    updatedAt
    appliedAt
    lastAppliedError
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

const CLEANUP_CLOSEOUT_QUERY_DOCUMENTS = new Set([
  PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY,
  PROTECTED_STAGING_VARIABLE_METADATA_QUERY,
  PROTECTED_STAGING_VARIABLE_DEPLOYMENT_QUERY,
  PROTECTED_STAGING_VARIABLE_PATCH_QUERY,
]);

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
const FORBIDDEN_OFFSITE_VARIABLE_IDENTITIES = Object.freeze({
  OFFSITE_BACKUP_BUCKET: Object.freeze({
    id: "a43db07e-1152-4ce1-8eb5-f03c0df9c665",
    isSealed: false,
  }),
  OFFSITE_BACKUP_SERVICE_ROLE_KEY: Object.freeze({
    id: "0f0ba362-34a0-4afd-afc0-ca59447cda32",
    isSealed: false,
  }),
  OFFSITE_BACKUP_SUPABASE_URL: Object.freeze({
    id: "671c431d-15cf-4879-b2fa-8595004ad8ef",
    isSealed: false,
  }),
} as const);
const CLEANUP_OPERATION = "remove-forbidden-offsite-backup-variables" as const;
const RESUME_CLEANUP_OPERATION =
  "resume-forbidden-offsite-backup-deletion-patch" as const;
const CANCEL_CLEANUP_OPERATION =
  "cancel-forbidden-offsite-backup-deletion-patch" as const;
const INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION =
  "cancel-masked-forbidden-offsite-backup-deletion-patch" as const;
const CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION =
  "reconcile-completed-forbidden-offsite-backup-deletion" as const;
const CLEANUP_RECOVERY_OPERATIONS = Object.freeze([
  RESUME_CLEANUP_OPERATION,
  CANCEL_CLEANUP_OPERATION,
] as const);
const CLEANUP_PATCH_SHA256 =
  "3650174bf695aaebb3b9ba7f91a4f2a724a0806b30511578448964c36eebfb91";
const INCIDENT_ORIGINAL_CANDIDATE_SHA =
  "ac7130e0306802825922d21a4c61135b84edd43b";
const INCIDENT_PRIOR_CLEANUP_RUN_ID = "33164687424";
const INCIDENT_PRIOR_CLEANUP_ARTIFACT_ID = "9683176636";
const INCIDENT_PRIOR_CLEANUP_ARTIFACT_DIGEST =
  "sha256:0df300c84d53ece3fca5f7c72007bf5dd4a8ba9d1ea989e5d74bc80904aed98e";
const INCIDENT_PRIOR_DISPATCH_SHA256 =
  "44e7482cfe1b35d2267c515884c5c904f9fc9354048ffbe2d87a2401559d723d";
const INCIDENT_PRIOR_INTENT_SHA256 =
  "00ef7f3f90eded6a5a778ff6cfdbc3a8a146d0dec31f4eebb1119ff5f4806719";
const INCIDENT_PRIOR_TERMINAL_SHA256 =
  "b02f2583cd092b343d8e494f99197ed3c5cd927e393045f03a2937d2544eaf2f";
const INCIDENT_STAGED_PATCH_ID = "63b3cc8a-f68f-4b99-adb7-70dfdfa7d6ae";
const INCIDENT_STAGED_PATCH_CREATED_AT = "2026-08-28T10:51:38.861Z";
const INCIDENT_RECOVERY_DEADLINE_MS = Date.parse("2026-08-29T10:51:43Z");
const INCIDENT_ORIGINAL_BASELINE_METADATA_SHA256 =
  "c88c7915e91f391c4d40e4869d18b44783746a2b4e153c99637f34333c021abd";
const CLEANUP_BASELINE_METADATA_SHA256 =
  "c88c7915e91f391c4d40e4869d18b44783746a2b4e153c99637f34333c021abd";
const CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA =
  "0eadad05ce6c313ed3c12492d3095609ce5872d5";
const CLEANUP_CLOSEOUT_ORIGINAL_REVIEWED_HEAD_SHA =
  "b8d0d0e44cf63e996388a223ba4ee2ff02ab02e5";
const CLEANUP_CLOSEOUT_ORIGINAL_TREE_SHA =
  "2f624d697d97f5682d7b69231ed4d0ec66a21e6d";
const CLEANUP_CLOSEOUT_CANDIDATE_SHA =
  "d939a77d0950b27466f3b9ecd26643a2416059a7";
const CLEANUP_CLOSEOUT_CANDIDATE_TREE_SHA =
  "83b0b51efd2cf0ac5c2299c6cfd4c919d1973aff";
const CLEANUP_CLOSEOUT_EVIDENCE_ATTESTATION_PATH =
  "docs/incident-evidence/permanent-staging-cleanup-closeout-2026-08-29/attestation.json";
const CLEANUP_CLOSEOUT_EVIDENCE_ATTESTATION_SHA256 =
  "2f7f0204e4962f33d87d59b09da5a81ee76d343b8d23a48947547ed1099f0a64";
const CLEANUP_CLOSEOUT_RUN_ID = "33249810569";
const CLEANUP_CLOSEOUT_ARTIFACT_ID = "9714046913";
const CLEANUP_CLOSEOUT_ARTIFACT_DIGEST =
  "sha256:625fca28703f9c4c7897c6d52a3e54cef8caee6e68f66c3b26a1565d7e4f655d";
const CLEANUP_CLOSEOUT_ARTIFACT_BYTES = 2583;
const CLEANUP_CLOSEOUT_ORIGINAL_PULL_REQUEST_NUMBER = 71;
const CLEANUP_CLOSEOUT_ORIGINAL_MERGED_AT = "2026-08-29T09:42:49Z";
const CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID = "33246243698";
const CLEANUP_CLOSEOUT_ORIGINAL_RUN_CREATED_AT = "2026-08-29T09:45:53Z";
const CLEANUP_CLOSEOUT_ORIGINAL_RUN_COMPLETED_AT = "2026-08-29T09:49:29Z";
const CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_ID = "9712963222";
const CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_NAME =
  "pintpath-permanent-staging-provider-mutation-remove-forbidden-offsite-backup-variables-0eadad05ce6c313ed3c12492d3095609ce5872d5";
const CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_DIGEST =
  "sha256:aeb28aef046845e9f8ce830c2ae4a2eee762ce79810c69a1727fbef07f121ad3";
const CLEANUP_CLOSEOUT_ORIGINAL_DISPATCH_SHA256 =
  "35009e4ca3422b8728167e016b88ae6a9541d2c06043e0778efd1533250366e3";
const CLEANUP_CLOSEOUT_ORIGINAL_INTENT_SHA256 =
  "d8e4ed8dda9702c59a6c1c38abd04fc5f8f98f6d387458bc33150aaf8fad2574";
const CLEANUP_CLOSEOUT_ORIGINAL_TERMINAL_SHA256 =
  "eb3185f494758b79df76e2f366a8f174964c1ac624da03d62dfb2c047a395aea";
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID = "33246655561";
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_CREATED_AT =
  "2026-08-29T09:56:44Z";
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_COMPLETED_AT =
  "2026-08-29T10:00:57Z";
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_ID = "9713096183";
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_NAME =
  "pintpath-permanent-staging-provider-mutation-resume-forbidden-offsite-backup-deletion-patch-0eadad05ce6c313ed3c12492d3095609ce5872d5";
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_DIGEST =
  "sha256:e1a4e7017298b49df7c0afb3fcc8a354740248c5333cb21248d3bbd80d65c0b8";
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_DISPATCH_SHA256 =
  "951da3aa4f69fa84f157c27ef9430a8923c58f682029f7b1ed3962ac29492d3b";
const CLEANUP_CLOSEOUT_POST_METADATA_SHA256 =
  "54fae04fd4dda1688bae3080a2c9c2220fb257f7b5c3ea1ce8677685cc4b18dc";
const CLEANUP_CLOSEOUT_DEADLINE_MS = Date.parse("2026-08-30T09:49:29Z");
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
  | typeof CANCEL_CLEANUP_OPERATION
  | typeof INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION
  | typeof CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION;

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
    | "incident_masked_patch_cancel_acknowledged"
    | "incident_masked_patch_cancel_reconciled_after_lost_ack"
    | "incident_masked_patch_cancel_already_completed_reconciled"
    | "cleanup_already_completed_reconciled"
    | "cleanup_no_effect_retry_acknowledged"
    | "cleanup_no_effect_retry_reconciled_after_lost_ack"
    | "cleanup_already_cancelled_reconciled"
    | "cleanup_completed_read_only_reconciled"
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
    /** Present only for the incident-bound cancellation receipt. */
    selectedIncidentPatchNonCommittedExact?: boolean;
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
    expectedStagingPatch?:
      "empty" | "cleanup-deletion" | "incident-masked-cleanup-cancel",
  ) => Promise<0 | 1>;
  readonly readSecretFile: (filename: string) => Buffer;
  readonly verifyPriorCleanupEvidence: (
    directory: string,
    candidateSha: string,
  ) => boolean;
  readonly verifyIncidentPriorCleanupEvidence: (directory: string) => boolean;
  readonly verifyCleanupSuccessorCloseoutEvidence: (
    originalDirectory: string,
    failedRecoveryDirectory: string,
  ) => boolean;
  readonly verifyReviewedCleanupRecoveryAuthority: (
    filename: string,
    expected: Parameters<typeof reviewedCleanupRecoveryAuthorityValueExact>[1],
  ) => boolean;
  readonly verifyReviewedIncidentCleanupCancelAuthority: (
    filename: string,
    expected: Parameters<
      typeof reviewedIncidentCleanupCancelAuthorityValueExact
    >[1],
  ) => boolean;
  readonly verifyReviewedCleanupSuccessorCloseoutAuthority: (
    filename: string,
    expected: Parameters<
      typeof reviewedCleanupSuccessorCloseoutAuthorityValueExact
    >[1],
  ) => boolean;
  readonly now: () => number;
  readonly hashPrivateFile: (filename: string) => string;
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

function incidentMaskedCleanupPatch(): Record<string, unknown> {
  return {
    services: {
      [APPLICATION_SERVICE_ID]: {
        variables: Object.fromEntries(
          FORBIDDEN_OFFSITE_VARIABLE_NAMES.map((name) => [
            name,
            { value: "*****" },
          ]),
        ),
      },
    },
  };
}

function incidentMaskedCleanupPatchExact(value: unknown): boolean {
  if (!unorderedExactKeys(value, ["services"])
    || !unorderedExactKeys(value.services, [APPLICATION_SERVICE_ID])) return false;
  const service = value.services[APPLICATION_SERVICE_ID];
  if (!unorderedExactKeys(service, ["variables"])) return false;
  const variables = service.variables;
  if (!unorderedExactKeys(variables, FORBIDDEN_OFFSITE_VARIABLE_NAMES)) return false;
  return FORBIDDEN_OFFSITE_VARIABLE_NAMES.every((name) =>
    unorderedExactKeys(variables[name], ["value"])
      && variables[name].value === "*****");
}

function incidentCleanupCancelOperation(
  value: ProtectedStagingVariableOperation,
): value is typeof INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION {
  return value === INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION;
}

function cleanupSuccessorCloseoutOperation(
  value: ProtectedStagingVariableOperation,
): value is typeof CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION {
  return value === CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION;
}

function cleanupRecoveryOperation(
  value: ProtectedStagingVariableOperation,
): value is typeof RESUME_CLEANUP_OPERATION | typeof CANCEL_CLEANUP_OPERATION {
  return CLEANUP_RECOVERY_OPERATIONS.includes(
    value as typeof CLEANUP_RECOVERY_OPERATIONS[number],
  );
}

function cleanupOrIncidentRecoveryOperation(
  value: ProtectedStagingVariableOperation,
): value is typeof RESUME_CLEANUP_OPERATION | typeof CANCEL_CLEANUP_OPERATION |
  typeof INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION |
  typeof CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION {
  return cleanupRecoveryOperation(value) || incidentCleanupCancelOperation(value)
    || cleanupSuccessorCloseoutOperation(value);
}

function parseArguments(argv: readonly string[]): {
  operation: ProtectedStagingVariableOperation;
  valueFiles: readonly string[];
  evidenceDirectory: string;
  priorCleanupRunId: string | null;
  priorCleanupEvidenceDirectory: string | null;
  failedRecoveryEvidenceDirectory: string | null;
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
    "--failed-recovery-evidence-dir",
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
      values.has("--failed-recovery-evidence-dir") ||
      values.has("--reviewed-authority-file")) return null;
    return {
      operation,
      evidenceDirectory,
      valueFiles: [publishable, secret],
      priorCleanupRunId: null,
      priorCleanupEvidenceDirectory: null,
      failedRecoveryEvidenceDirectory: null,
      reviewedAuthorityFile: null,
    };
  }
  if (operation === CLEANUP_OPERATION) {
    if (values.has("--value-file") || values.has("--publishable-key-file")
      || values.has("--secret-key-file") || values.has("--prior-cleanup-run-id")
      || values.has("--prior-cleanup-evidence-dir")
      || values.has("--failed-recovery-evidence-dir")
      || values.has("--reviewed-authority-file")) return null;
    return {
      operation,
      evidenceDirectory,
      valueFiles: [],
      priorCleanupRunId: null,
      priorCleanupEvidenceDirectory: null,
      failedRecoveryEvidenceDirectory: null,
      reviewedAuthorityFile: null,
    };
  }
  if (cleanupOrIncidentRecoveryOperation(operation)) {
    const priorCleanupRunId = values.get("--prior-cleanup-run-id") ?? "";
    const priorCleanupEvidenceDirectory =
      values.get("--prior-cleanup-evidence-dir") ?? null;
    const failedRecoveryEvidenceDirectory =
      values.get("--failed-recovery-evidence-dir") ?? null;
    const reviewedAuthorityFile = values.get("--reviewed-authority-file") ?? "";
    if (values.has("--value-file") || values.has("--publishable-key-file")
      || values.has("--secret-key-file") || !RUN_ID_PATTERN.test(priorCleanupRunId)
      || (priorCleanupEvidenceDirectory !== null
        && !path.isAbsolute(priorCleanupEvidenceDirectory))
      || (cleanupSuccessorCloseoutOperation(operation)
        ? failedRecoveryEvidenceDirectory === null ||
          !path.isAbsolute(failedRecoveryEvidenceDirectory)
        : failedRecoveryEvidenceDirectory !== null)
      || !path.isAbsolute(reviewedAuthorityFile)) return null;
    return {
      operation,
      evidenceDirectory,
      valueFiles: [],
      priorCleanupRunId,
      priorCleanupEvidenceDirectory,
      failedRecoveryEvidenceDirectory,
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
    values.has("--failed-recovery-evidence-dir") ||
    values.has("--reviewed-authority-file")) return null;
  return {
    operation,
    evidenceDirectory,
    valueFiles: [value],
    priorCleanupRunId: null,
    priorCleanupEvidenceDirectory: null,
    failedRecoveryEvidenceDirectory: null,
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

function incidentPriorCleanupEvidenceExact(directory: string): boolean {
  try {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (entries.some((entry) => !entry.isFile()) || JSON.stringify(
      entries.map((entry) => entry.name).sort(),
    ) !== JSON.stringify(["dispatch.json", "intent.json", "terminal.json"])) {
      return false;
    }
    if (!priorCleanupEvidenceExact(directory, INCIDENT_ORIGINAL_CANDIDATE_SHA)) {
      return false;
    }
    const commitments = Object.freeze({
      "dispatch.json": INCIDENT_PRIOR_DISPATCH_SHA256,
      "intent.json": INCIDENT_PRIOR_INTENT_SHA256,
      "terminal.json": INCIDENT_PRIOR_TERMINAL_SHA256,
    });
    return Object.entries(commitments).every(([leaf, expected]) => {
      const source = readTrustedRegularFile(path.join(directory, leaf), {
        minBytes: 2,
        maxBytes: 256 * 1024,
        requireOwner: true,
      });
      return sha256(source) === expected;
    });
  } catch {
    return false;
  }
}

function cleanupSuccessorCloseoutEvidenceExact(
  originalDirectory: string,
  failedRecoveryDirectory: string,
): boolean {
  try {
    const originalEntries = fs.readdirSync(originalDirectory, {
      withFileTypes: true,
    });
    const originalNames = originalEntries.map((entry) => entry.name).sort();
    if (originalEntries.some((entry) => !entry.isFile()) ||
      JSON.stringify(originalNames) !==
        JSON.stringify(["dispatch.json", "intent.json", "terminal.json"]) ||
      !priorCleanupEvidenceExact(
        originalDirectory,
        CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA,
      )) return false;
    const originalCommitments = Object.freeze({
      "dispatch.json": CLEANUP_CLOSEOUT_ORIGINAL_DISPATCH_SHA256,
      "intent.json": CLEANUP_CLOSEOUT_ORIGINAL_INTENT_SHA256,
      "terminal.json": CLEANUP_CLOSEOUT_ORIGINAL_TERMINAL_SHA256,
    });
    if (!Object.entries(originalCommitments).every(([leaf, expected]) => {
      const source = readTrustedRegularFile(path.join(originalDirectory, leaf), {
        minBytes: 2,
        maxBytes: 256 * 1024,
        requireOwner: true,
      });
      return sha256(source) === expected;
    })) return false;
    const originalIntent = readEvidenceJson(originalDirectory, "intent.json");
    const originalTerminal = readEvidenceJson(originalDirectory, "terminal.json");
    if (!plainRecord(originalIntent) ||
      originalIntent.preflightMetadataSha256 !==
        "1a3b868b81d9e263941d92b919f31f6ab6a98ade1da1bc8d8c0f524e6374706f" ||
      !plainRecord(originalTerminal) ||
      !plainRecord(originalTerminal.receipt) ||
      !plainRecord(originalTerminal.receipt.checks) ||
      originalTerminal.receipt.outcome !== "mutation_uncertain" ||
      originalTerminal.receipt.attempts !== 2 ||
      originalTerminal.receipt.retryAllowed !== false ||
      originalTerminal.receipt.stagedDeletionPatchId !==
        INCIDENT_STAGED_PATCH_ID ||
      originalTerminal.receipt.checks.targetPreflightExact !== true ||
      originalTerminal.receipt.checks.boundaryPrecommitExact !== true ||
      originalTerminal.receipt.checks.stagedDeletionPatchExact !== true ||
      originalTerminal.receipt.checks.stageAcknowledgementExact !== true ||
      originalTerminal.receipt.checks.commitAcknowledgementExact !== true ||
      originalTerminal.receipt.checks.mutationAttemptedAtMostOnce !== true ||
      originalTerminal.receipt.checks.committedDeletionPatchExact !== false) {
      return false;
    }

    const recoveryEntries = fs.readdirSync(failedRecoveryDirectory, {
      withFileTypes: true,
    });
    if (recoveryEntries.some((entry) => !entry.isFile()) ||
      JSON.stringify(recoveryEntries.map((entry) => entry.name).sort()) !==
        JSON.stringify(["dispatch.json"])) return false;
    const recoverySource = readTrustedRegularFile(
      path.join(failedRecoveryDirectory, "dispatch.json"),
      { minBytes: 2, maxBytes: 64 * 1024, requireOwner: true },
    );
    if (sha256(recoverySource) !==
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_DISPATCH_SHA256) return false;
    const recoveryDispatch = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(recoverySource),
    ) as unknown;
    return exactKeys(recoveryDispatch, [
      "schemaVersion",
      "candidateSha",
      "operation",
      "secretMaterialIncluded",
    ]) && recoveryDispatch.schemaVersion ===
        "pintpath-provider-mutation-dispatch/v1" &&
      recoveryDispatch.candidateSha ===
        CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA &&
      recoveryDispatch.operation === RESUME_CLEANUP_OPERATION &&
      recoveryDispatch.secretMaterialIncluded === false;
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
    "reviewedTreeExact",
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
    || typeof value.reviewedPrHeadSha !== "string"
    || !SHA_PATTERN.test(value.reviewedPrHeadSha)
    || !Number.isSafeInteger(value.reviewedPullRequestNumber)
    || Number(value.reviewedPullRequestNumber) < 1
    || value.operation !== expected.operation
    || value.workflowPath !== REVIEWED_AUTHORITY_WORKFLOW_PATH
    || value.workflowRunId !== expected.currentRunId
    || value.workflowRunAttempt !== 1
    || value.candidateHistoryMaximumAgeHours !== 168
    || value.reviewedTreeExact !== true
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

function reviewedCleanupSuccessorCloseoutAuthorityValueExact(
  value: unknown,
  expected: {
    readonly candidateSha: string;
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
    "reviewedTreeExact",
    "candidateHistoryMaximumAgeHours",
    "completeRetainedHistoryExact",
    "safePriorSkippedWriteRunIds",
    "cleanupCloseoutOriginalCandidateSha",
    "cleanupCloseoutOriginalReviewedPrHeadSha",
    "cleanupCloseoutOriginalTreeSha",
    "cleanupCloseoutOriginalPullRequestNumber",
    "cleanupCloseoutOriginalPullRequestMergedAt",
    "cleanupCloseoutSuccessorDirectParentExact",
    "cleanupCloseoutOriginalRunId",
    "cleanupCloseoutOriginalRunCreatedAt",
    "cleanupCloseoutOriginalRunCompletedAt",
    "cleanupCloseoutOriginalRunMayHaveWrittenExact",
    "cleanupCloseoutOriginalArtifactId",
    "cleanupCloseoutOriginalArtifactName",
    "cleanupCloseoutOriginalArtifactDigest",
    "cleanupCloseoutOriginalArtifactExact",
    "cleanupCloseoutFailedRecoveryRunId",
    "cleanupCloseoutFailedRecoveryRunCreatedAt",
    "cleanupCloseoutFailedRecoveryRunCompletedAt",
    "cleanupCloseoutFailedRecoveryArtifactId",
    "cleanupCloseoutFailedRecoveryArtifactName",
    "cleanupCloseoutFailedRecoveryArtifactDigest",
    "cleanupCloseoutFailedRecoveryDispatchOnlyArtifactExact",
    "cleanupCloseoutOriginalHistoryExact",
    "cleanupCloseoutCurrentHistoryExact",
    "cleanupCloseoutRecoveryGraceHours",
    "cleanupCloseoutWithinGraceExact",
    "cleanupCloseoutMinimumObservationMinutes",
    "cleanupCloseoutMinimumObservationSatisfiedExact",
    "cleanupCloseoutAbsoluteDeadline",
    "cleanupCloseoutMetadataOnlyExact",
    "successfulStagingDeploymentRunIds",
    "stagingLifecycleSealed",
    "reviewedAuthorityExact",
    "freshDispatchWriteGuardExact",
  ];
  if (!unorderedExactKeys(value, keys) ||
    value.command !== "verify-github-reviewed-candidate-authority" ||
    value.ok !== true ||
    value.schemaVersion !== 1 ||
    value.kind !== "pintpath-github-reviewed-candidate-authority" ||
    value.repository !== REVIEWED_AUTHORITY_REPOSITORY ||
    value.candidateSha !== expected.candidateSha ||
    typeof value.reviewedPrHeadSha !== "string" ||
    !SHA_PATTERN.test(value.reviewedPrHeadSha) ||
    !Number.isSafeInteger(value.reviewedPullRequestNumber) ||
    Number(value.reviewedPullRequestNumber) < 1 ||
    value.operation !== CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION ||
    value.workflowPath !== REVIEWED_AUTHORITY_WORKFLOW_PATH ||
    value.workflowRunId !== expected.currentRunId ||
    value.workflowRunAttempt !== 1 ||
    canonicalTimestamp(value.workflowRunCreatedAt) === null ||
    canonicalTimestamp(value.reviewedPullRequestMergedAt) === null ||
    value.reviewedTreeExact !== true ||
    value.candidateHistoryMaximumAgeHours !== 168 ||
    value.completeRetainedHistoryExact !== true ||
    !exactRunIdArray(value.safePriorSkippedWriteRunIds) ||
    value.safePriorSkippedWriteRunIds.length !== 0 ||
    value.cleanupCloseoutOriginalCandidateSha !==
      CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA ||
    value.cleanupCloseoutOriginalReviewedPrHeadSha !==
      CLEANUP_CLOSEOUT_ORIGINAL_REVIEWED_HEAD_SHA ||
    value.cleanupCloseoutOriginalTreeSha !==
      CLEANUP_CLOSEOUT_ORIGINAL_TREE_SHA ||
    value.cleanupCloseoutOriginalPullRequestNumber !==
      CLEANUP_CLOSEOUT_ORIGINAL_PULL_REQUEST_NUMBER ||
    value.cleanupCloseoutOriginalPullRequestMergedAt !==
      CLEANUP_CLOSEOUT_ORIGINAL_MERGED_AT ||
    value.cleanupCloseoutSuccessorDirectParentExact !== true ||
    value.cleanupCloseoutOriginalRunId !== expected.priorCleanupRunId ||
    value.cleanupCloseoutOriginalRunId !== CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID ||
    value.cleanupCloseoutOriginalRunCreatedAt !==
      CLEANUP_CLOSEOUT_ORIGINAL_RUN_CREATED_AT ||
    value.cleanupCloseoutOriginalRunCompletedAt !==
      CLEANUP_CLOSEOUT_ORIGINAL_RUN_COMPLETED_AT ||
    value.cleanupCloseoutOriginalRunMayHaveWrittenExact !== true ||
    value.cleanupCloseoutOriginalArtifactId !==
      CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_ID ||
    value.cleanupCloseoutOriginalArtifactName !==
      CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_NAME ||
    value.cleanupCloseoutOriginalArtifactDigest !==
      CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_DIGEST ||
    value.cleanupCloseoutOriginalArtifactExact !== true ||
    value.cleanupCloseoutFailedRecoveryRunId !==
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID ||
    value.cleanupCloseoutFailedRecoveryRunCreatedAt !==
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_CREATED_AT ||
    value.cleanupCloseoutFailedRecoveryRunCompletedAt !==
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_COMPLETED_AT ||
    value.cleanupCloseoutFailedRecoveryArtifactId !==
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_ID ||
    value.cleanupCloseoutFailedRecoveryArtifactName !==
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_NAME ||
    value.cleanupCloseoutFailedRecoveryArtifactDigest !==
      CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_DIGEST ||
    value.cleanupCloseoutFailedRecoveryDispatchOnlyArtifactExact !== true ||
    value.cleanupCloseoutOriginalHistoryExact !== true ||
    value.cleanupCloseoutCurrentHistoryExact !== true ||
    value.cleanupCloseoutRecoveryGraceHours !== 24 ||
    value.cleanupCloseoutWithinGraceExact !== true ||
    value.cleanupCloseoutMinimumObservationMinutes !== 10 ||
    value.cleanupCloseoutMinimumObservationSatisfiedExact !== true ||
    canonicalTimestamp(value.cleanupCloseoutAbsoluteDeadline) !==
      CLEANUP_CLOSEOUT_DEADLINE_MS ||
    value.cleanupCloseoutMetadataOnlyExact !== true ||
    !exactRunIdArray(value.successfulStagingDeploymentRunIds) ||
    value.successfulStagingDeploymentRunIds.length > 1 ||
    value.stagingLifecycleSealed !== false ||
    value.reviewedAuthorityExact !== true ||
    value.freshDispatchWriteGuardExact !== true) return false;
  const currentCreatedAt = canonicalTimestamp(value.workflowRunCreatedAt)!;
  const successorMergedAt = canonicalTimestamp(
    value.reviewedPullRequestMergedAt,
  )!;
  const originalCompletedAt = canonicalTimestamp(
    value.cleanupCloseoutOriginalRunCompletedAt,
  )!;
  const failedRecoveryCompletedAt = canonicalTimestamp(
    value.cleanupCloseoutFailedRecoveryRunCompletedAt,
  )!;
  return originalCompletedAt < failedRecoveryCompletedAt &&
    failedRecoveryCompletedAt <= successorMergedAt &&
    successorMergedAt <= currentCreatedAt &&
    currentCreatedAt < CLEANUP_CLOSEOUT_DEADLINE_MS &&
    !value.successfulStagingDeploymentRunIds.includes(expected.currentRunId);
}

function reviewedCleanupSuccessorCloseoutAuthorityExact(
  filename: string,
  expected: Parameters<
    typeof reviewedCleanupSuccessorCloseoutAuthorityValueExact
  >[1],
): boolean {
  try {
    const source = readTrustedRegularFile(filename, {
      minBytes: 2,
      maxBytes: 64 * 1024,
      requireOwner: true,
      requirePrivate: true,
    });
    return reviewedCleanupSuccessorCloseoutAuthorityValueExact(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source)),
      expected,
    );
  } catch {
    return false;
  }
}

function reviewedIncidentCleanupCancelAuthorityValueExact(
  value: unknown,
  expected: {
    readonly candidateSha: string;
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
    "incidentOriginalCandidateSha",
    "incidentOriginalReviewedPrHeadSha",
    "incidentOriginalPullRequestNumber",
    "incidentOriginalPullRequestMergedAt",
    "incidentSuccessorDirectParentExact",
    "incidentPriorCleanupRunId",
    "incidentPriorCleanupRunCreatedAt",
    "incidentPriorCleanupRunCompletedAt",
    "incidentPriorCleanupArtifactId",
    "incidentPriorCleanupArtifactName",
    "incidentPriorCleanupArtifactDigest",
    "incidentPriorCleanupArtifactExact",
    "incidentStagedPatchId",
    "incidentStagedPatchCreatedAt",
    "incidentMaskedPatchStructure",
    "incidentOriginalBaselineMetadataSha256",
    "incidentCancellationOnlyExact",
    "incidentRecoveryGraceHours",
    "incidentRecoveryWithinGraceExact",
    "incidentSafePriorSkippedWriteRunIds",
    "incidentAmbiguousPriorCancelRunIds",
    "incidentPriorRunsStrictlyOrderedAndNonOverlappingExact",
    "incidentSameCandidateConvergenceExact",
    "incidentAbsoluteRecoveryDeadline",
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
    || typeof value.reviewedPrHeadSha !== "string"
    || !SHA_PATTERN.test(value.reviewedPrHeadSha)
    || !Number.isSafeInteger(value.reviewedPullRequestNumber)
    || Number(value.reviewedPullRequestNumber) < 1
    || value.operation !== INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION
    || value.workflowPath !== REVIEWED_AUTHORITY_WORKFLOW_PATH
    || value.workflowRunId !== expected.currentRunId
    || value.workflowRunAttempt !== 1
    || value.candidateHistoryMaximumAgeHours !== 168
    || value.completeRetainedHistoryExact !== true
    || !exactRunIdArray(value.safePriorSkippedWriteRunIds)
    || value.incidentOriginalCandidateSha !== INCIDENT_ORIGINAL_CANDIDATE_SHA
    || value.incidentOriginalReviewedPrHeadSha !==
      "b41c39a601f20a510ccbc09187acdca29abd7a02"
    || value.incidentOriginalPullRequestNumber !== 65
    || value.incidentOriginalPullRequestMergedAt !== "2026-08-28T10:20:39Z"
    || value.incidentSuccessorDirectParentExact !== true
    || value.incidentPriorCleanupRunId !== expected.priorCleanupRunId
    || value.incidentPriorCleanupRunId !== INCIDENT_PRIOR_CLEANUP_RUN_ID
    || value.incidentPriorCleanupRunCreatedAt !== "2026-08-28T10:47:25Z"
    || value.incidentPriorCleanupRunCompletedAt !== "2026-08-28T10:51:43Z"
    || value.incidentPriorCleanupArtifactId !==
      INCIDENT_PRIOR_CLEANUP_ARTIFACT_ID
    || value.incidentPriorCleanupArtifactName !==
      "pintpath-permanent-staging-provider-mutation-remove-forbidden-offsite-backup-variables-ac7130e0306802825922d21a4c61135b84edd43b"
    || value.incidentPriorCleanupArtifactDigest !==
      INCIDENT_PRIOR_CLEANUP_ARTIFACT_DIGEST
    || value.incidentPriorCleanupArtifactExact !== true
    || value.incidentStagedPatchId !== INCIDENT_STAGED_PATCH_ID
    || value.incidentStagedPatchCreatedAt !== INCIDENT_STAGED_PATCH_CREATED_AT
    || value.incidentMaskedPatchStructure !==
      "exact-three-offsite-variable-wrappers-with-five-asterisk-values"
    || value.incidentOriginalBaselineMetadataSha256 !==
      INCIDENT_ORIGINAL_BASELINE_METADATA_SHA256
    || value.incidentCancellationOnlyExact !== true
    || value.incidentRecoveryGraceHours !== 24
    || value.incidentRecoveryWithinGraceExact !== true
    || !exactRunIdArray(value.incidentSafePriorSkippedWriteRunIds)
    || !exactRunIdArray(value.incidentAmbiguousPriorCancelRunIds)
    || value.incidentPriorRunsStrictlyOrderedAndNonOverlappingExact !== true
    || value.incidentSameCandidateConvergenceExact !== true
    || value.incidentAbsoluteRecoveryDeadline !==
      "2026-08-29T10:51:43.000Z"
    || !exactRunIdArray(value.successfulStagingDeploymentRunIds)
    || value.successfulStagingDeploymentRunIds.length > 1
    || value.stagingLifecycleSealed !== false
    || value.reviewedAuthorityExact !== true
    || value.freshDispatchWriteGuardExact !== true) return false;
  const currentCreatedAt = canonicalTimestamp(value.workflowRunCreatedAt);
  const currentMergedAt = canonicalTimestamp(value.reviewedPullRequestMergedAt);
  const originalMergedAt = canonicalTimestamp(
    value.incidentOriginalPullRequestMergedAt,
  );
  const priorCreatedAt = canonicalTimestamp(value.incidentPriorCleanupRunCreatedAt);
  const priorCompletedAt = canonicalTimestamp(
    value.incidentPriorCleanupRunCompletedAt,
  );
  const absoluteDeadline = canonicalTimestamp(
    value.incidentAbsoluteRecoveryDeadline,
  );
  const sameCandidateHistoryRunIds = [
    ...value.incidentSafePriorSkippedWriteRunIds,
    ...value.incidentAmbiguousPriorCancelRunIds,
  ];
  return currentCreatedAt !== null && currentMergedAt !== null
    && originalMergedAt !== null && priorCreatedAt !== null
    && priorCompletedAt !== null && absoluteDeadline !== null
    && originalMergedAt <= priorCreatedAt
    && priorCreatedAt <= priorCompletedAt
    && priorCompletedAt <= currentMergedAt
    && currentMergedAt <= currentCreatedAt
    && absoluteDeadline - priorCompletedAt === 24 * 60 * 60 * 1_000
    && currentCreatedAt < absoluteDeadline
    && !value.safePriorSkippedWriteRunIds.includes(expected.currentRunId)
    && !value.safePriorSkippedWriteRunIds.includes(expected.priorCleanupRunId)
    && JSON.stringify(value.safePriorSkippedWriteRunIds) ===
      JSON.stringify(value.incidentSafePriorSkippedWriteRunIds)
    && !sameCandidateHistoryRunIds.includes(expected.currentRunId)
    && !sameCandidateHistoryRunIds.includes(expected.priorCleanupRunId)
    && new Set(sameCandidateHistoryRunIds).size ===
      sameCandidateHistoryRunIds.length
    && !value.successfulStagingDeploymentRunIds.includes(expected.currentRunId);
}

function reviewedIncidentCleanupCancelAuthorityExact(
  filename: string,
  expected: Parameters<
    typeof reviewedIncidentCleanupCancelAuthorityValueExact
  >[1],
): boolean {
  try {
    const source = readTrustedRegularFile(filename, {
      minBytes: 2,
      maxBytes: 64 * 1024,
      requireOwner: true,
      requirePrivate: true,
    });
    return reviewedIncidentCleanupCancelAuthorityValueExact(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source)),
      expected,
    );
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

async function cleanupCloseoutReadOnlyGraphql(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  if (!CLEANUP_CLOSEOUT_QUERY_DOCUMENTS.has(query) ||
    !query.trimStart().startsWith("query ")) {
    throw new Error("cleanup_closeout_query_invalid");
  }
  return await graphql(fetchImpl, token, query, variables);
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
    "empty" | "cleanup-deletion" | "empty-or-cleanup-deletion" |
      "incident-masked-cleanup-cancel" |
      "empty-or-incident-masked-cleanup-cancel" = "empty",
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
    || ((expectedStagedPatch === "cleanup-deletion"
      || expectedStagedPatch === "incident-masked-cleanup-cancel")
      && staged.status !== "STAGED")
    || (expectedStagedPatch === "empty"
      ? !plainRecord(staged.patch) || Object.keys(staged.patch).length !== 0
      : expectedStagedPatch === "cleanup-deletion"
        ? !incidentMaskedCleanupPatchExact(staged.patch)
        : expectedStagedPatch === "incident-masked-cleanup-cancel"
          ? staged.id !== INCIDENT_STAGED_PATCH_ID
            || !incidentMaskedCleanupPatchExact(staged.patch)
        : expectedStagedPatch === "empty-or-incident-masked-cleanup-cancel"
          ? (!plainRecord(staged.patch) || Object.keys(staged.patch).length !== 0)
            && (staged.id !== INCIDENT_STAGED_PATCH_ID
              || staged.status !== "STAGED"
              || !incidentMaskedCleanupPatchExact(staged.patch))
        : (!plainRecord(staged.patch) || Object.keys(staged.patch).length !== 0)
          && !incidentMaskedCleanupPatchExact(staged.patch))
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
    "empty" | "cleanup-deletion" | "empty-or-cleanup-deletion" |
      "incident-masked-cleanup-cancel" |
      "empty-or-incident-masked-cleanup-cancel" = "empty",
  graphqlRequest: typeof graphql = graphql,
): Promise<ProviderSnapshot | null> {
  const metadata = parseMetadata(await graphqlRequest(
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
  const deployment = parseDeployment(await graphqlRequest(
    fetchImpl,
    metadataToken,
    PROTECTED_STAGING_VARIABLE_DEPLOYMENT_QUERY,
    { deploymentId: metadata.serviceInstance.latestDeployment.id },
  ), metadata.serviceInstance.latestDeployment.id);
  if (!deployment
    || deployment.snapshotId !== metadata.serviceInstance.latestDeployment.snapshotId) return null;
  return { ...metadata, deployment };
}

function incidentPatchNodeExact(value: unknown): boolean {
  return exactKeys(value, [
    "id",
    "environmentId",
    "status",
    "message",
    "createdAt",
    "updatedAt",
    "appliedAt",
    "lastAppliedError",
    "patch",
  ])
    && value.id === INCIDENT_STAGED_PATCH_ID
    && value.environmentId === STAGING_ENVIRONMENT_ID
    && value.status === "STAGED"
    && value.message === null
    && value.createdAt === INCIDENT_STAGED_PATCH_CREATED_AT
    && value.updatedAt === INCIDENT_STAGED_PATCH_CREATED_AT
    && value.appliedAt === null
    && value.lastAppliedError === null
    && incidentMaskedCleanupPatchExact(value.patch);
}

function parseIncidentPatchProvenance(value: unknown): boolean {
  return exactKeys(value, ["data"])
    && exactKeys(value.data, ["active", "selected"])
    && incidentPatchNodeExact(value.data.active)
    && incidentPatchNodeExact(value.data.selected);
}

function incidentSelectedPatchNonCommittedNodeExact(value: unknown): boolean {
  if (!exactKeys(value, [
      "id",
      "environmentId",
      "status",
      "message",
      "createdAt",
      "updatedAt",
      "appliedAt",
      "lastAppliedError",
      "patch",
    ])) return false;
  const createdAt = canonicalTimestamp(value.createdAt);
  const updatedAt = canonicalTimestamp(value.updatedAt);
  const maskedPatch = incidentMaskedCleanupPatchExact(value.patch);
  const emptyPatch = plainRecord(value.patch)
    && Object.keys(value.patch).length === 0;
  return value.id === INCIDENT_STAGED_PATCH_ID
    && value.environmentId === STAGING_ENVIRONMENT_ID
    && value.status === "STAGED"
    && value.message === null
    && value.createdAt === INCIDENT_STAGED_PATCH_CREATED_AT
    && value.appliedAt === null
    && value.lastAppliedError === null
    && createdAt !== null
    && updatedAt !== null
    && updatedAt >= createdAt
    && updatedAt < INCIDENT_RECOVERY_DEADLINE_MS
    && (maskedPatch || emptyPatch);
}

function parseIncidentSelectedPatchNonCommitted(value: unknown): boolean {
  return exactKeys(value, ["data"])
    && exactKeys(value.data, ["active", "selected"])
    && incidentSelectedPatchNonCommittedNodeExact(value.data.selected);
}

function parseIncidentActiveEmptyWithSelectedNonCommitted(
  value: unknown,
): string | null {
  if (!exactKeys(value, ["data"])
    || !exactKeys(value.data, ["active", "selected"])
    || !incidentSelectedPatchNonCommittedNodeExact(value.data.selected)
    || !exactKeys(value.data.active, [
      "id",
      "environmentId",
      "status",
      "message",
      "createdAt",
      "updatedAt",
      "appliedAt",
      "lastAppliedError",
      "patch",
    ])) return null;
  const { active, selected } = value.data;
  if (active.environmentId !== STAGING_ENVIRONMENT_ID
    || active.status !== "STAGED"
    || active.message !== null
    || active.appliedAt !== null
    || active.lastAppliedError !== null
    || !plainRecord(active.patch)
    || Object.keys(active.patch).length !== 0) return null;
  if (active.id === "<empty>") {
    const createdAt = active.createdAt === null
      ? null
      : canonicalTimestamp(active.createdAt);
    const updatedAt = active.updatedAt === null
      ? null
      : canonicalTimestamp(active.updatedAt);
    return (active.createdAt === null || createdAt !== null)
      && (active.updatedAt === null || updatedAt !== null)
      && (createdAt === null || updatedAt === null || updatedAt >= createdAt)
      ? active.id
      : null;
  }
  return active.id === INCIDENT_STAGED_PATCH_ID
    && canonical(active) === canonical(selected)
    ? active.id
    : null;
}

async function readIncidentPatchObservation(
  fetchImpl: typeof fetch,
  metadataToken: string,
): Promise<{
  readonly activeAndSelectedExact: boolean;
  readonly selectedNonCommittedExact: boolean;
  readonly activeEmptyPatchId: string | null;
}> {
  const value = await graphql(
    fetchImpl,
    metadataToken,
    PROTECTED_STAGING_VARIABLE_INCIDENT_PATCH_QUERY,
    {
      environmentId: STAGING_ENVIRONMENT_ID,
      patchId: INCIDENT_STAGED_PATCH_ID,
    },
  );
  return Object.freeze({
    activeAndSelectedExact: parseIncidentPatchProvenance(value),
    selectedNonCommittedExact:
      parseIncidentSelectedPatchNonCommitted(value),
    activeEmptyPatchId:
      parseIncidentActiveEmptyWithSelectedNonCommitted(value),
  });
}

function incidentOriginalBaselineMetadataExact(
  snapshot: ProviderSnapshot,
  normalizeStagedPatch: boolean,
): boolean {
  const comparable = normalizeStagedPatch
    ? {
        ...snapshot,
        stagedPatchId: "<empty>",
        stagedPatchStatus: "STAGED" as const,
        stagedPatchEmpty: true,
      }
    : snapshot;
  return sha256(canonical(comparable)) ===
    INCIDENT_ORIGINAL_BASELINE_METADATA_SHA256;
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
      const identity = FORBIDDEN_OFFSITE_VARIABLE_IDENTITIES[name];
      return named.length === 1
        && named[0]?.id === identity.id
        && named[0]?.serviceId === APPLICATION_SERVICE_ID
        && named[0]?.isSealed === identity.isSealed
        && named[0].references.length === 0;
    });
}

function cleanupBaselineMetadataExact(snapshot: ProviderSnapshot): boolean {
  const normalizedStagedPatchId = snapshot.stagedPatchEmpty
      && snapshot.stagedPatchStatus === "STAGED"
      && (snapshot.stagedPatchId === "<empty>"
        || snapshot.stagedPatchId === INCIDENT_STAGED_PATCH_ID)
    ? "<empty>"
    : snapshot.stagedPatchId;
  return sha256(canonical({
    ...snapshot,
    stagedPatchId: normalizedStagedPatchId,
  })) === CLEANUP_BASELINE_METADATA_SHA256;
}

function cleanupCompletedSnapshotExact(snapshot: ProviderSnapshot): boolean {
  return snapshot.variables.length === 96
    && snapshot.stagedPatchId === "<empty>"
    && snapshot.stagedPatchStatus === "STAGED"
    && snapshot.stagedPatchEmpty
    && forbiddenOffsiteRowsAbsent(snapshot)
    && maintenanceMetadataExact(snapshot)
    && exactColdDeadBaseline(snapshot)
    && sha256(canonical(snapshot)) === CLEANUP_CLOSEOUT_POST_METADATA_SHA256;
}

function privateFileSha256(filename: string): string {
  return sha256(readTrustedRegularFile(filename, {
    minBytes: 2,
    maxBytes: 64 * 1024,
    requireOwner: true,
    requirePrivate: true,
  }));
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
      "id", "environmentId", "status", "message", "createdAt", "updatedAt",
      "appliedAt", "lastAppliedError",
    ])
    && typeof value.data.environmentStageChanges.id === "string"
    && UUID_PATTERN.test(value.data.environmentStageChanges.id)
    && value.data.environmentStageChanges.environmentId === STAGING_ENVIRONMENT_ID
    && value.data.environmentStageChanges.status === "STAGED"
    && value.data.environmentStageChanges.message === null
    && value.data.environmentStageChanges.appliedAt === null
    && value.data.environmentStageChanges.lastAppliedError === null)) {
    return null;
  }
  const createdAt = canonicalTimestamp(
    value.data.environmentStageChanges.createdAt,
  );
  const updatedAt = canonicalTimestamp(
    value.data.environmentStageChanges.updatedAt,
  );
  if (createdAt === null || updatedAt === null || updatedAt < createdAt) {
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

function parseCommitDeletionAcknowledgement(
  value: unknown,
  expectedPatchId: string,
): boolean {
  if (!(UUID_PATTERN.test(expectedPatchId)
    && exactKeys(value, ["data"])
    && exactKeys(value.data, ["environmentPatchCommitStaged"])
    && typeof value.data.environmentPatchCommitStaged === "string")) {
    return false;
  }
  const acknowledgement = value.data.environmentPatchCommitStaged;
  return acknowledgement ===
    `commitChanges/${STAGING_ENVIRONMENT_ID}/${expectedPatchId}`;
}

const DELETION_PATCH_NODE_KEYS = Object.freeze([
  "id",
  "environmentId",
  "status",
  "message",
  "createdAt",
  "updatedAt",
  "appliedAt",
  "lastAppliedError",
  "patch",
] as const);

function deletionPatchNodeMetadata(
  value: unknown,
  expectedPatchId: string,
  expectedStatus: "STAGED" | "COMMITTED",
  expectedMessage: string | null,
): Record<string, unknown> | null {
  if (!exactKeys(value, DELETION_PATCH_NODE_KEYS)
    || value.id !== expectedPatchId
    || value.environmentId !== STAGING_ENVIRONMENT_ID
    || value.status !== expectedStatus
    || value.message !== expectedMessage
    || value.lastAppliedError !== null) return null;
  const createdAt = canonicalTimestamp(value.createdAt);
  const updatedAt = canonicalTimestamp(value.updatedAt);
  const appliedAt = value.appliedAt === null
    ? null
    : canonicalTimestamp(value.appliedAt);
  if (createdAt === null || updatedAt === null || updatedAt < createdAt
    || (expectedStatus === "STAGED" && appliedAt !== null)
    || (expectedStatus === "COMMITTED" && (appliedAt === null
      || appliedAt < createdAt || updatedAt < appliedAt))) return null;
  return {
    id: value.id,
    environmentId: value.environmentId,
    status: value.status,
    message: value.message,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    appliedAt: value.appliedAt,
    lastAppliedError: value.lastAppliedError,
  };
}

function emptyActiveDeletionPatchNodeExact(value: unknown): boolean {
  if (!exactKeys(value, DELETION_PATCH_NODE_KEYS)
    || value.id !== "<empty>"
    || value.environmentId !== STAGING_ENVIRONMENT_ID
    || value.status !== "STAGED"
    || value.message !== null
    || value.appliedAt !== null
    || value.lastAppliedError !== null
    || !plainRecord(value.patch)
    || Object.keys(value.patch).length !== 0) return false;
  const createdAt = value.createdAt === null
    ? null
    : canonicalTimestamp(value.createdAt);
  const updatedAt = value.updatedAt === null
    ? null
    : canonicalTimestamp(value.updatedAt);
  return (value.createdAt === null || createdAt !== null)
    && (value.updatedAt === null || updatedAt !== null)
    && (createdAt === null || updatedAt === null || updatedAt >= createdAt);
}

function deletionPatchReadbackEnvelope(
  value: unknown,
): Record<string, unknown> | null {
  if (!exactKeys(value, ["data"])
    || !exactKeys(value.data, [
      "activeMasked",
      "activeDecrypted",
      "selectedMasked",
      "selectedDecrypted",
    ])) return null;
  return value.data;
}

function parseStagedDeletionPatchReadback(
  value: unknown,
  expectedPatchId: string,
): boolean {
  if (!UUID_PATTERN.test(expectedPatchId)) return false;
  const data = deletionPatchReadbackEnvelope(value);
  if (data === null) return false;
  const nodes = [
    data.activeMasked,
    data.activeDecrypted,
    data.selectedMasked,
    data.selectedDecrypted,
  ];
  const metadata = nodes.map((node) => deletionPatchNodeMetadata(
    node,
    expectedPatchId,
    "STAGED",
    null,
  ));
  return metadata.every((entry) => entry !== null)
    && metadata.every((entry) => canonical(entry) === canonical(metadata[0]))
    && incidentMaskedCleanupPatchExact(
      (data.activeMasked as Record<string, unknown>).patch,
    )
    && cleanupDeletionPatchExact(
      (data.activeDecrypted as Record<string, unknown>).patch,
    )
    && incidentMaskedCleanupPatchExact(
      (data.selectedMasked as Record<string, unknown>).patch,
    )
    && cleanupDeletionPatchExact(
      (data.selectedDecrypted as Record<string, unknown>).patch,
    );
}

function parseCommittedDeletionPatch(
  value: unknown,
  expectedPatchId: string,
  expectedCommitMessage: string,
): boolean {
  if (!UUID_PATTERN.test(expectedPatchId)) return false;
  const data = deletionPatchReadbackEnvelope(value);
  if (data === null) return false;
  const selectedMasked = deletionPatchNodeMetadata(
    data.selectedMasked,
    expectedPatchId,
    "COMMITTED",
    expectedCommitMessage,
  );
  const selectedDecrypted = deletionPatchNodeMetadata(
    data.selectedDecrypted,
    expectedPatchId,
    "COMMITTED",
    expectedCommitMessage,
  );
  return selectedMasked !== null
    && selectedDecrypted !== null
    && canonical(selectedMasked) === canonical(selectedDecrypted)
    && emptyActiveDeletionPatchNodeExact(data.activeMasked)
    && emptyActiveDeletionPatchNodeExact(data.activeDecrypted)
    && incidentMaskedCleanupPatchExact(
      (data.selectedMasked as Record<string, unknown>).patch,
    )
    && cleanupDeletionPatchExact(
      (data.selectedDecrypted as Record<string, unknown>).patch,
    );
}

async function readStagedDeletionPatchExact(
  fetchImpl: typeof fetch,
  metadataToken: string,
  patchId: string,
): Promise<boolean> {
  return parseStagedDeletionPatchReadback(await graphql(
    fetchImpl,
    metadataToken,
    PROTECTED_STAGING_VARIABLE_PATCH_QUERY,
    {
      environmentId: STAGING_ENVIRONMENT_ID,
      patchId,
    },
  ), patchId);
}

async function readCommittedDeletionPatchExact(
  fetchImpl: typeof fetch,
  metadataToken: string,
  patchId: string,
  commitMessage: string,
  graphqlRequest: typeof graphql = graphql,
): Promise<boolean> {
  return parseCommittedDeletionPatch(await graphqlRequest(
    fetchImpl,
    metadataToken,
    PROTECTED_STAGING_VARIABLE_PATCH_QUERY,
    {
      environmentId: STAGING_ENVIRONMENT_ID,
      patchId,
    },
  ), patchId, commitMessage);
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
    const deletionProofAttestation = fs.readFileSync(
      path.resolve(cwd, STAGED_DELETION_PROOF_ATTESTATION_PATH),
    );
    if (sha256(deletionProofAttestation) !==
      STAGED_DELETION_PROOF_ATTESTATION_SHA256) return false;
    const closeoutAttestation = fs.readFileSync(
      path.resolve(cwd, CLEANUP_CLOSEOUT_EVIDENCE_ATTESTATION_PATH),
    );
    if (sha256(closeoutAttestation) !==
      CLEANUP_CLOSEOUT_EVIDENCE_ATTESTATION_SHA256) return false;
    const policy = JSON.parse(fs.readFileSync(path.resolve(cwd, POLICY_PATH), "utf8")) as unknown;
    return canonical(policy) === canonical({
      schemaVersion: "pintpath-permanent-staging-variable-mutation-policy/v9",
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
          INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION,
          CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION,
        ],
        stagedDeletionProof: {
          attestationPath: STAGED_DELETION_PROOF_ATTESTATION_PATH,
          attestationSha256: STAGED_DELETION_PROOF_ATTESTATION_SHA256,
          independentReviewOutcome: "GO_NO_P0_P1",
        },
        legacyStagedDeletionDispatchState:
          "ENABLED_AFTER_SEALED_DISPOSABLE_PROOF",
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
            incidentBoundMaskedPatchCancellation: {
              operation: INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION,
              originalCandidateSha: INCIDENT_ORIGINAL_CANDIDATE_SHA,
              currentCandidateMustBeDirectChild: true,
              priorCleanupRunId: INCIDENT_PRIOR_CLEANUP_RUN_ID,
              priorCleanupArtifactId: INCIDENT_PRIOR_CLEANUP_ARTIFACT_ID,
              priorCleanupArtifactDigest:
                INCIDENT_PRIOR_CLEANUP_ARTIFACT_DIGEST,
              priorCleanupArtifactRequired: true,
              stagedPatchId: INCIDENT_STAGED_PATCH_ID,
              stagedPatchCreatedAt: INCIDENT_STAGED_PATCH_CREATED_AT,
              maskedPatchShape:
                "EXACT_THREE_OFFSITE_VARIABLE_WRAPPERS_WITH_FIVE_ASTERISK_VALUES",
              deletionSemanticsProven: true,
              originalBaselineMetadataSha256:
                INCIDENT_ORIGINAL_BASELINE_METADATA_SHA256,
              recoveryDeadline:
                new Date(INCIDENT_RECOVERY_DEADLINE_MS).toISOString(),
              ambiguousSameCandidateRerunsAllowed: true,
              priorAmbiguousRunWriteDisposition: "MAY_HAVE_WRITTEN",
              priorRunsStrictlyOrderedAndNonOverlapping: true,
              emptyActivePatchReadOnlyCloseoutAllowed: true,
              emptyActivePatchReadOnlyCloseoutMaximumAttempts: 0,
              selectedPatchNonCommittedAndUnappliedProofRequired: true,
              operationName: "environmentStageChanges",
              replacementPatch: {},
              merge: false,
              maximumAttempts: 1,
              commitAllowed: false,
              resumeAllowed: false,
              providerCasOrLockVerified: false,
              residualRisk:
                "OUT_OF_BAND_STAGED_PATCH_REPLACEMENT_CAN_BE_DISCARDED_BETWEEN_FINAL_READ_AND_CANCEL",
            },
            successorReadOnlyCloseout: {
              operation: CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION,
              originalCandidateSha: CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA,
              originalReviewedPrHeadSha:
                CLEANUP_CLOSEOUT_ORIGINAL_REVIEWED_HEAD_SHA,
              originalTreeSha: CLEANUP_CLOSEOUT_ORIGINAL_TREE_SHA,
              closeoutCandidateWasDirectChildOfOriginal: true,
              closeoutCandidateSha: CLEANUP_CLOSEOUT_CANDIDATE_SHA,
              closeoutCandidateTreeSha: CLEANUP_CLOSEOUT_CANDIDATE_TREE_SHA,
              closeoutEvidenceAttestationPath:
                CLEANUP_CLOSEOUT_EVIDENCE_ATTESTATION_PATH,
              closeoutEvidenceAttestationSha256:
                CLEANUP_CLOSEOUT_EVIDENCE_ATTESTATION_SHA256,
              closeoutRunId: CLEANUP_CLOSEOUT_RUN_ID,
              closeoutArtifactId: CLEANUP_CLOSEOUT_ARTIFACT_ID,
              closeoutArtifactDigest: CLEANUP_CLOSEOUT_ARTIFACT_DIGEST,
              closeoutArtifactBytes: CLEANUP_CLOSEOUT_ARTIFACT_BYTES,
              closeoutCompleted: true,
              closeoutDispatchState: "RETIRED_AFTER_COMPLETION",
              historicalRunRerunAllowed: false,
              laterCandidateCloseoutRerunsAllowed: false,
              originalCleanupRunId: CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID,
              originalCleanupArtifactId:
                CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_ID,
              originalCleanupArtifactDigest:
                CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_DIGEST,
              failedRecoveryRunId: CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID,
              failedRecoveryArtifactId:
                CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_ID,
              failedRecoveryArtifactDigest:
                CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_DIGEST,
              expectedPostCleanupMetadataSha256:
                CLEANUP_CLOSEOUT_POST_METADATA_SHA256,
              committedPatchId: INCIDENT_STAGED_PATCH_ID,
              committedPatchMessage:
                `pintpath:staging-offsite-cleanup:${
                  CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA
                }`,
              committedPatchReadback:
                "ACTIVE_EMPTY_AND_SELECTED_COMMITTED_MASKED_DECRYPTED_EXACT",
              minimumObservationMinutes: 10,
              recoveryDeadline:
                new Date(CLEANUP_CLOSEOUT_DEADLINE_MS).toISOString(),
              metadataOnly: true,
              mutationCredentialAllowed: false,
              maximumAttempts: 0,
            },
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
            incidentMaskedCleanupPatch(),
          ),
    readSecretFile: readPrivateSecretFile,
    verifyPriorCleanupEvidence: priorCleanupEvidenceExact,
    verifyIncidentPriorCleanupEvidence: incidentPriorCleanupEvidenceExact,
    verifyCleanupSuccessorCloseoutEvidence:
      cleanupSuccessorCloseoutEvidenceExact,
    verifyReviewedCleanupRecoveryAuthority:
      reviewedCleanupRecoveryAuthorityExact,
    verifyReviewedIncidentCleanupCancelAuthority:
      reviewedIncidentCleanupCancelAuthorityExact,
    verifyReviewedCleanupSuccessorCloseoutAuthority:
      reviewedCleanupSuccessorCloseoutAuthorityExact,
    now: Date.now,
    hashPrivateFile: privateFileSha256,
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
  let cleanupSuccessorCloseoutAtPreflight = false;
  let cleanupCloseoutCommittedPatchAtPreflight = false;
  let providerGraphql: typeof graphql = graphql;
  let stageAcknowledgementExact = false;
  let commitAcknowledgementExact = false;
  let stagedDeletionPatchId: string | null = null;
  let incidentReadOnlyCloseoutAtPreflight = false;
  let incidentMaskedPatchAtPreflight = false;
  try {
    checks.policyExact = policyExact(dependencies.cwd);
    checks.externalMutationFreezeAttested =
      dependencies.env.PINTPATH_EXTERNAL_MUTATION_FREEZE_ATTESTATION ===
        EXTERNAL_MUTATION_FREEZE_ATTESTATION;
    candidateSha = dependencies.env.GITHUB_SHA ?? null;
    const confirmation = operation
      ? `${cleanupSuccessorCloseoutOperation(operation) ? "RECONCILE" : "MUTATE"}_${
        operation.toUpperCase().replaceAll("-", "_")
      }_IN_PERMANENT_STAGING`
      : "";
    const requestedRecovery = args !== null && cleanupRecoveryOperation(args.operation);
    const requestedIncidentCancel = args !== null
      && incidentCleanupCancelOperation(args.operation);
    const requestedSuccessorCloseout = args !== null
      && cleanupSuccessorCloseoutOperation(args.operation);
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
        : requestedIncidentCancel
          ? dependencies.env.PINTPATH_PRIOR_CLEANUP_RUN_ID ===
            args?.priorCleanupRunId
            && args?.priorCleanupRunId === INCIDENT_PRIOR_CLEANUP_RUN_ID
            && dependencies.env.GITHUB_REPOSITORY ===
              REVIEWED_AUTHORITY_REPOSITORY
            && RUN_ID_PATTERN.test(dependencies.env.GITHUB_RUN_ID ?? "")
            && dependencies.verifyReviewedIncidentCleanupCancelAuthority(
              args!.reviewedAuthorityFile!,
              {
                candidateSha: candidateSha!,
                priorCleanupRunId: args!.priorCleanupRunId!,
                currentRunId: dependencies.env.GITHUB_RUN_ID!,
              },
            )
        : requestedSuccessorCloseout
          ? dependencies.env.PINTPATH_PRIOR_CLEANUP_RUN_ID ===
            args?.priorCleanupRunId
            && args?.priorCleanupRunId === CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID
            && dependencies.env.GITHUB_REPOSITORY ===
              REVIEWED_AUTHORITY_REPOSITORY
            && RUN_ID_PATTERN.test(dependencies.env.GITHUB_RUN_ID ?? "")
            && dependencies.verifyReviewedCleanupSuccessorCloseoutAuthority(
              args!.reviewedAuthorityFile!,
              {
                candidateSha: candidateSha!,
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
    const incidentCancel = incidentCleanupCancelOperation(activeOperation);
    const successorCloseout =
      cleanupSuccessorCloseoutOperation(activeOperation);
    providerGraphql = successorCloseout
      ? cleanupCloseoutReadOnlyGraphql
      : graphql;
    if (incidentCancel) {
      checks.selectedIncidentPatchNonCommittedExact = false;
    }
    priorCleanupEvidenceVerified = successorCloseout
      ? args.priorCleanupEvidenceDirectory !== null
        && args.failedRecoveryEvidenceDirectory !== null
        && dependencies.verifyCleanupSuccessorCloseoutEvidence(
          args.priorCleanupEvidenceDirectory,
          args.failedRecoveryEvidenceDirectory,
        )
      : incidentCancel
      ? args.priorCleanupEvidenceDirectory !== null
        && dependencies.verifyIncidentPriorCleanupEvidence(
          args.priorCleanupEvidenceDirectory,
        )
      : !recovery || args.priorCleanupEvidenceDirectory === null ||
        dependencies.verifyPriorCleanupEvidence(
          args.priorCleanupEvidenceDirectory,
          candidateSha!,
        );
    if (!priorCleanupEvidenceVerified) {
      throw new Error("prior_cleanup_evidence_invalid");
    }
    if (incidentCancel && dependencies.now() >= INCIDENT_RECOVERY_DEADLINE_MS) {
      throw new Error("incident_recovery_expired");
    }
    if (successorCloseout && dependencies.now() >= CLEANUP_CLOSEOUT_DEADLINE_MS) {
      throw new Error("cleanup_closeout_expired");
    }
    const mutationToken = dependencies.env.PINTPATH_RAILWAY_STAGING_MUTATION_TOKEN ?? "";
    metadataToken = dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    if (!TOKEN_PATTERN.test(metadataToken) ||
      (successorCloseout
        ? mutationToken !== ""
        : !TOKEN_PATTERN.test(mutationToken) || mutationToken === metadataToken)) {
      throw new Error("token_invalid");
    }
    const [mutationScope, metadataScope] = successorCloseout
      ? [null, await providerGraphql(
          dependencies.fetchImpl,
          metadataToken,
          PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY,
          {},
        )]
      : await Promise.all([
          providerGraphql(
            dependencies.fetchImpl,
            mutationToken,
            PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY,
            {},
          ),
          providerGraphql(
            dependencies.fetchImpl,
            metadataToken,
            PROTECTED_STAGING_VARIABLE_TOKEN_SCOPE_QUERY,
            {},
          ),
        ]);
    checks.tokenScopesExact = parseScope(metadataScope) &&
      (successorCloseout || parseScope(mutationScope));
    if (!checks.tokenScopesExact) throw new Error("token_scope_invalid");
    before = await readProviderSnapshot(
      dependencies.fetchImpl,
      metadataToken,
      incidentCancel
        ? "empty-or-incident-masked-cleanup-cancel"
        : recovery ? "empty-or-cleanup-deletion" : "empty",
      providerGraphql,
    );
    const incidentPatchObservation = incidentCancel
      ? await readIncidentPatchObservation(dependencies.fetchImpl, metadataToken)
      : null;
    incidentMaskedPatchAtPreflight = incidentCancel
      && before !== null
      && !before.stagedPatchEmpty
      && incidentPatchObservation?.activeAndSelectedExact === true
      && incidentOriginalBaselineMetadataExact(before, true);
    incidentReadOnlyCloseoutAtPreflight = incidentCancel
      && before !== null
      && before.stagedPatchEmpty
      && before.stagedPatchStatus === "STAGED"
      && incidentPatchObservation?.selectedNonCommittedExact === true
      && incidentPatchObservation.activeEmptyPatchId === before.stagedPatchId
      && incidentOriginalBaselineMetadataExact(before, true);
    checks.boundaryPreflightExact = (incidentCancel
      ? incidentMaskedPatchAtPreflight
        ? await dependencies.boundaryCheck("incident-masked-cleanup-cancel")
        : await dependencies.boundaryCheck()
      : await dependencies.boundaryCheck()) === 0;
    if (!checks.boundaryPreflightExact) throw new Error("boundary_invalid");
    authorizedBaseline = before === null
      ? null
      : recovery || incidentCancel || successorCloseout
        ? authorizedCleanupRecoveryBaselineKind(before, candidateSha)
        : authorizedBaselineKind(before, candidateSha);
    const variableName = Object.hasOwn(PROVIDER_OPERATIONS, activeOperation)
      ? PROVIDER_OPERATIONS[activeOperation as ProviderOperation]
      : null;
    checks.targetPreflightExact = before !== null
      && authorizedBaseline !== null
      && (activeOperation === CLEANUP_OPERATION
        ? forbiddenOffsiteRowsExactForDeletion(before)
          && cleanupBaselineMetadataExact(before)
          && maintenanceMetadataExact(before)
        : recovery
          ? priorCleanupEvidenceVerified
            && maintenanceMetadataExact(before)
            && (!before.stagedPatchEmpty
              ? forbiddenOffsiteRowsExactForDeletion(before)
              : forbiddenOffsiteRowsExactForDeletion(before)
                || activeOperation === RESUME_CLEANUP_OPERATION
                  && forbiddenOffsiteRowsAbsent(before))
        : incidentCancel
          ? priorCleanupEvidenceVerified
            && forbiddenOffsiteRowsExactForDeletion(before)
            && maintenanceMetadataExact(before)
            && (incidentMaskedPatchAtPreflight
              ? before.stagedPatchId === INCIDENT_STAGED_PATCH_ID
                && before.stagedPatchStatus === "STAGED"
              : incidentReadOnlyCloseoutAtPreflight)
        : successorCloseout
          ? priorCleanupEvidenceVerified
            && cleanupCompletedSnapshotExact(before)
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
    cleanupSuccessorCloseoutAtPreflight = successorCloseout
      && cleanupCompletedSnapshotExact(before);
    if (successorCloseout) {
      stagedDeletionPatchId = INCIDENT_STAGED_PATCH_ID;
      try {
        cleanupCloseoutCommittedPatchAtPreflight =
          await readCommittedDeletionPatchExact(
            dependencies.fetchImpl,
            metadataToken,
            INCIDENT_STAGED_PATCH_ID,
            `pintpath:staging-offsite-cleanup:${
              CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA
            }`,
            providerGraphql,
          );
      } catch {
        cleanupCloseoutCommittedPatchAtPreflight = false;
      }
      checks.committedDeletionPatchExact =
        cleanupCloseoutCommittedPatchAtPreflight;
      if (!checks.committedDeletionPatchExact) {
        throw new Error("cleanup_closeout_committed_patch_invalid");
      }
    }
    buffers = args.valueFiles.map((filename) => dependencies.readSecretFile(filename));
    variables = activeOperation === CLEANUP_OPERATION || recovery || incidentCancel
        || successorCloseout
      ? null
      : secretStrings(activeOperation, buffers);
    if (activeOperation === CLEANUP_OPERATION || recovery || incidentCancel
      || successorCloseout) {
      checks.inputZeroized = true;
    }
    const cleanup = activeOperation === CLEANUP_OPERATION;
    const cleanupOrRecovery = cleanup || recovery || incidentCancel
      || successorCloseout;
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
        : successorCloseout
          ? {
              readOnlyCloseout: {
                action: "reconcile-exact-completed-deletion-across-reviewed-successor",
                mutation: null,
                maximumAttempts: 0,
                mutationCredentialAvailable: false,
                expectedPostCleanupMetadataSha256:
                  CLEANUP_CLOSEOUT_POST_METADATA_SHA256,
              },
              originalCandidateSha: CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA,
              originalReviewedPrHeadSha:
                CLEANUP_CLOSEOUT_ORIGINAL_REVIEWED_HEAD_SHA,
              originalTreeSha: CLEANUP_CLOSEOUT_ORIGINAL_TREE_SHA,
              originalCleanupRunId: CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID,
              originalCleanupArtifact: {
                id: CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_ID,
                digest: CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_DIGEST,
                exact: true,
              },
              failedRecoveryRunId: CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID,
              failedRecoveryArtifact: {
                id: CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_ID,
                digest: CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_DIGEST,
                dispatchOnlyExact: true,
              },
              committedPatch: {
                id: INCIDENT_STAGED_PATCH_ID,
                status: "COMMITTED",
                commitMessage: `pintpath:staging-offsite-cleanup:${
                  CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA
                }`,
                activePatchEmpty: true,
                maskedAndDecryptedDeletionExact: true,
              },
              reviewedAuthoritySha256:
                dependencies.hashPrivateFile(args.reviewedAuthorityFile!),
              closeoutDeadline:
                new Date(CLEANUP_CLOSEOUT_DEADLINE_MS).toISOString(),
            }
        : incidentCancel
          ? {
              incidentCancellation: {
                action: incidentReadOnlyCloseoutAtPreflight
                  ? "reconcile-exact-already-cancelled-masked-provider-patch"
                  : "cancel-exact-masked-provider-patch",
                mutation: incidentReadOnlyCloseoutAtPreflight
                  ? null
                  : "environmentStageChanges",
                replacementPatch: {},
                merge: false,
                maximumAttempts: incidentReadOnlyCloseoutAtPreflight ? 0 : 1,
                commitAllowed: false,
                resumeAllowed: false,
                providerCasOrLockVerified: false,
                residualRisk:
                  "OUT_OF_BAND_STAGED_PATCH_REPLACEMENT_CAN_BE_DISCARDED_BETWEEN_FINAL_READ_AND_CANCEL",
              },
              originalCandidateSha: INCIDENT_ORIGINAL_CANDIDATE_SHA,
              priorCleanupRunId: INCIDENT_PRIOR_CLEANUP_RUN_ID,
              priorCleanupArtifact: {
                id: INCIDENT_PRIOR_CLEANUP_ARTIFACT_ID,
                digest: INCIDENT_PRIOR_CLEANUP_ARTIFACT_DIGEST,
                exact: true,
              },
              stagedPatch: {
                id: INCIDENT_STAGED_PATCH_ID,
                environmentId: STAGING_ENVIRONMENT_ID,
                status: "STAGED",
                message: null,
                createdAt: INCIDENT_STAGED_PATCH_CREATED_AT,
                updatedAt: INCIDENT_STAGED_PATCH_CREATED_AT,
                appliedAt: null,
                observedShape:
                  "exact-three-offsite-variable-wrappers-with-five-asterisk-values",
                deletionSemanticsProven: true,
              },
              originalBaselineMetadataSha256:
                INCIDENT_ORIGINAL_BASELINE_METADATA_SHA256,
              recoveryDeadline:
                new Date(INCIDENT_RECOVERY_DEADLINE_MS).toISOString(),
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
      incidentCancel
        ? "empty-or-incident-masked-cleanup-cancel"
        : recovery ? "empty-or-cleanup-deletion" : "empty",
      providerGraphql,
    );
    const prewriteIncidentPatchObservation = incidentCancel
      ? await readIncidentPatchObservation(dependencies.fetchImpl, metadataToken)
      : null;
    checks.targetPreflightExact = prewrite !== null
      && authorizedBaseline !== null
      && canonical(prewrite) === canonical(before)
      && (recovery || incidentCancel || successorCloseout
        ? authorizedCleanupRecoveryBaselineKind(prewrite, candidateSha)
        : authorizedBaselineKind(prewrite, candidateSha)) === authorizedBaseline
      && (cleanup
        ? forbiddenOffsiteRowsExactForDeletion(prewrite)
          && cleanupBaselineMetadataExact(prewrite)
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
        : successorCloseout
          ? cleanupSuccessorCloseoutAtPreflight
            && cleanupCompletedSnapshotExact(prewrite)
        : incidentCancel
          ? forbiddenOffsiteRowsExactForDeletion(prewrite)
            && maintenanceMetadataExact(prewrite)
            && (incidentMaskedPatchAtPreflight
              ? prewriteIncidentPatchObservation?.activeAndSelectedExact === true
                && prewrite.stagedPatchId === INCIDENT_STAGED_PATCH_ID
                && prewrite.stagedPatchStatus === "STAGED"
                && !prewrite.stagedPatchEmpty
                && incidentOriginalBaselineMetadataExact(prewrite, true)
              : incidentReadOnlyCloseoutAtPreflight
                && prewriteIncidentPatchObservation
                  ?.selectedNonCommittedExact === true
                && prewrite.stagedPatchEmpty
                && prewrite.stagedPatchStatus === "STAGED"
                && prewriteIncidentPatchObservation.activeEmptyPatchId ===
                  prewrite.stagedPatchId
                && incidentOriginalBaselineMetadataExact(prewrite, true))
        : activeOperation === "supabase-key-replacement"
          ? supabaseMetadataExact(prewrite)
          : providerPreflightExact(prewrite, variableName!));
    if (!checks.targetPreflightExact) throw new Error("prewrite_target_invalid");
    if (incidentCancel && dependencies.now() >= INCIDENT_RECOVERY_DEADLINE_MS) {
      throw new Error("incident_recovery_expired");
    }
    if (successorCloseout && dependencies.now() >= CLEANUP_CLOSEOUT_DEADLINE_MS) {
      throw new Error("cleanup_closeout_expired");
    }
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
    if (successorCloseout) {
      attempts = 0;
    } else if (cleanup) {
      attempts = 1;
      try {
        stagedDeletionPatchId = parseStageDeletionAcknowledgement(await providerGraphql(
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
      let authoritativeStageReadbackExact = false;
      if (stagedDeletionPatchId !== null) {
        try {
          authoritativeStageReadbackExact = await readStagedDeletionPatchExact(
            dependencies.fetchImpl,
            metadataToken,
            stagedDeletionPatchId,
          );
        } catch {
          authoritativeStageReadbackExact = false;
        }
      }
      let staged: ProviderSnapshot | null = null;
      try {
        staged = await readProviderSnapshot(
          dependencies.fetchImpl,
          metadataToken,
          "cleanup-deletion",
          providerGraphql,
        );
      } catch {
        staged = null;
      }
      const stagedSnapshotExact = staged !== null
        && !staged.stagedPatchEmpty
        && staged.stagedPatchStatus === "STAGED"
        && (stagedDeletionPatchId === null
          || staged.stagedPatchId === stagedDeletionPatchId)
        && JSON.stringify(staged.variables) === JSON.stringify(before.variables)
        && runtimeSnapshotUnchanged(before, staged);
      if (!stagedSnapshotExact) throw new Error("staged_patch_invalid");
      if (stagedDeletionPatchId === null) {
        stagedDeletionPatchId = staged!.stagedPatchId;
        try {
          authoritativeStageReadbackExact = await readStagedDeletionPatchExact(
            dependencies.fetchImpl,
            metadataToken,
            stagedDeletionPatchId,
          );
        } catch {
          authoritativeStageReadbackExact = false;
        }
      }
      checks.stagedDeletionPatchExact = authoritativeStageReadbackExact;
      if (!checks.stagedDeletionPatchExact) {
        throw new Error("staged_patch_readback_invalid");
      }
      checks.boundaryPrecommitExact = await dependencies.boundaryCheck(
        "cleanup-deletion",
      ) === 0;
      if (!checks.boundaryPrecommitExact) throw new Error("precommit_boundary_invalid");
      if (!await readStagedDeletionPatchExact(
        dependencies.fetchImpl,
        metadataToken,
        stagedDeletionPatchId,
      )) throw new Error("final_precommit_patch_invalid");
      attempts = 2;
      try {
        commitAcknowledgementExact = parseCommitDeletionAcknowledgement(await providerGraphql(
          dependencies.fetchImpl,
          mutationToken,
          PROTECTED_STAGING_VARIABLE_COMMIT_DELETION_QUERY,
          {
            environmentId: STAGING_ENVIRONMENT_ID,
            commitMessage: `pintpath:staging-offsite-cleanup:${candidateSha}`,
            skipDeploys: true,
          },
        ), stagedDeletionPatchId);
      } catch {
        commitAcknowledgementExact = false;
      }
      checks.commitAcknowledgementExact = commitAcknowledgementExact;
      checks.acknowledgementExact = stageAcknowledgementExact
        && commitAcknowledgementExact;
      try {
        checks.committedDeletionPatchExact = stagedDeletionPatchId !== null
          && await readCommittedDeletionPatchExact(
            dependencies.fetchImpl,
            metadataToken,
            stagedDeletionPatchId,
            `pintpath:staging-offsite-cleanup:${candidateSha}`,
          );
      } catch {
        checks.committedDeletionPatchExact = false;
      }
    } else if (incidentCancel) {
      stagedDeletionPatchId = INCIDENT_STAGED_PATCH_ID;
      if (incidentReadOnlyCloseoutAtPreflight) {
        attempts = 0;
      } else {
        checks.stagedDeletionPatchExact = incidentMaskedPatchAtPreflight
          && prewrite !== null
          && prewrite.stagedPatchId === INCIDENT_STAGED_PATCH_ID
          && prewrite.stagedPatchStatus === "STAGED"
          && !prewrite.stagedPatchEmpty
          && prewriteIncidentPatchObservation?.activeAndSelectedExact === true
          && incidentOriginalBaselineMetadataExact(prewrite, true);
        if (!checks.stagedDeletionPatchExact) {
          throw new Error("incident_staged_patch_invalid");
        }
        checks.boundaryPrecommitExact = await dependencies.boundaryCheck(
          "incident-masked-cleanup-cancel",
        ) === 0;
        const finalIncidentPatchObservation = checks.boundaryPrecommitExact
          ? await readIncidentPatchObservation(
            dependencies.fetchImpl,
            metadataToken,
          )
          : null;
        if (!checks.boundaryPrecommitExact
          || finalIncidentPatchObservation?.activeAndSelectedExact !== true
          || dependencies.now() >= INCIDENT_RECOVERY_DEADLINE_MS) {
          throw new Error("incident_prewrite_boundary_invalid");
        }
        attempts = 1;
        try {
          stageAcknowledgementExact = parseCancelDeletionAcknowledgement(
            await providerGraphql(
              dependencies.fetchImpl,
              mutationToken,
              PROTECTED_STAGING_VARIABLE_CANCEL_DELETION_QUERY,
              {
                environmentId: STAGING_ENVIRONMENT_ID,
                input: {},
                merge: false,
              },
            ),
          );
        } catch {
          stageAcknowledgementExact = false;
        }
        checks.stageAcknowledgementExact = stageAcknowledgementExact;
        checks.acknowledgementExact = stageAcknowledgementExact;
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
        try {
          checks.stagedDeletionPatchExact = await readStagedDeletionPatchExact(
            dependencies.fetchImpl,
            metadataToken,
            stagedDeletionPatchId,
          );
        } catch {
          checks.stagedDeletionPatchExact = false;
        }
      }
      if (readOnlyRecovery) {
        attempts = 0;
      } else if (cleanupNoEffectAtPreflight) {
        attempts = 1;
        try {
          stagedDeletionPatchId = parseStageDeletionAcknowledgement(await providerGraphql(
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
        let authoritativeStageReadbackExact = false;
        if (stagedDeletionPatchId !== null) {
          try {
            authoritativeStageReadbackExact =
              await readStagedDeletionPatchExact(
                dependencies.fetchImpl,
                metadataToken,
                stagedDeletionPatchId,
              );
          } catch {
            authoritativeStageReadbackExact = false;
          }
        }
        let staged: ProviderSnapshot | null = null;
        try {
          staged = await readProviderSnapshot(
            dependencies.fetchImpl,
            metadataToken,
            "cleanup-deletion",
            providerGraphql,
          );
        } catch {
          staged = null;
        }
        const stagedSnapshotExact = staged !== null
          && !staged.stagedPatchEmpty
          && staged.stagedPatchStatus === "STAGED"
          && (stagedDeletionPatchId === null
            || staged.stagedPatchId === stagedDeletionPatchId)
          && JSON.stringify(staged.variables) === JSON.stringify(before.variables)
          && runtimeSnapshotUnchanged(before, staged);
        if (!stagedSnapshotExact) throw new Error("staged_patch_invalid");
        if (stagedDeletionPatchId === null) {
          stagedDeletionPatchId = staged!.stagedPatchId;
          try {
            authoritativeStageReadbackExact =
              await readStagedDeletionPatchExact(
                dependencies.fetchImpl,
                metadataToken,
                stagedDeletionPatchId,
              );
          } catch {
            authoritativeStageReadbackExact = false;
          }
        }
        checks.stagedDeletionPatchExact = authoritativeStageReadbackExact;
        if (!checks.stagedDeletionPatchExact) {
          throw new Error("staged_patch_readback_invalid");
        }
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
      if (!readOnlyRecovery && (stagedDeletionPatchId === null
        || !await readStagedDeletionPatchExact(
          dependencies.fetchImpl,
          metadataToken,
          stagedDeletionPatchId,
        ))) throw new Error("final_precommit_patch_invalid");
      if (activeOperation === RESUME_CLEANUP_OPERATION
        && !cleanupAlreadyCompletedAtPreflight) {
        try {
          commitAcknowledgementExact = parseCommitDeletionAcknowledgement(await providerGraphql(
            dependencies.fetchImpl,
            mutationToken,
            PROTECTED_STAGING_VARIABLE_COMMIT_DELETION_QUERY,
            {
              environmentId: STAGING_ENVIRONMENT_ID,
              commitMessage: `pintpath:staging-offsite-cleanup:${candidateSha}`,
              skipDeploys: true,
            },
          ), stagedDeletionPatchId!);
        } catch {
          commitAcknowledgementExact = false;
        }
        checks.commitAcknowledgementExact = commitAcknowledgementExact;
        checks.acknowledgementExact = cleanupNoEffectAtPreflight
          ? stageAcknowledgementExact && commitAcknowledgementExact
          : commitAcknowledgementExact;
        try {
          checks.committedDeletionPatchExact = stagedDeletionPatchId !== null
            && await readCommittedDeletionPatchExact(
              dependencies.fetchImpl,
              metadataToken,
              stagedDeletionPatchId,
              `pintpath:staging-offsite-cleanup:${candidateSha}`,
            );
        } catch {
          checks.committedDeletionPatchExact = false;
        }
      } else if (activeOperation === CANCEL_CLEANUP_OPERATION
        && !cleanupNoEffectAtPreflight) {
        try {
          stageAcknowledgementExact = parseCancelDeletionAcknowledgement(await providerGraphql(
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
        checks.acknowledgementExact = parseAcknowledgement(await providerGraphql(
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
      after = await readProviderSnapshot(
        dependencies.fetchImpl,
        metadataToken,
        "empty",
        providerGraphql,
      );
    } catch {
      after = null;
    }
    if (incidentCancel) {
      try {
        const observation = await readIncidentPatchObservation(
          dependencies.fetchImpl,
          metadataToken,
        );
        checks.selectedIncidentPatchNonCommittedExact = after !== null
          && after.stagedPatchEmpty
          && after.stagedPatchStatus === "STAGED"
          && observation.activeEmptyPatchId === after.stagedPatchId
          && observation.selectedNonCommittedExact;
      } catch {
        checks.selectedIncidentPatchNonCommittedExact = false;
      }
    }
    if (successorCloseout) {
      try {
        checks.committedDeletionPatchExact =
          cleanupCloseoutCommittedPatchAtPreflight &&
          await readCommittedDeletionPatchExact(
            dependencies.fetchImpl,
            metadataToken,
            INCIDENT_STAGED_PATCH_ID,
            `pintpath:staging-offsite-cleanup:${
              CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE_SHA
            }`,
            providerGraphql,
          );
      } catch {
        checks.committedDeletionPatchExact = false;
      }
    }
    checks.deploymentUnchanged = after !== null
      && runtimeSnapshotUnchanged(before, after);
    checks.targetPostflightExact = after !== null
      && authorizedBaselineKind(after, candidateSha) === authorizedBaseline
      && (cleanup
        ? cleanupPostflightExact(before, after)
        : successorCloseout
          ? cleanupSuccessorCloseoutAtPreflight
            && cleanupCompletedSnapshotExact(after)
            && canonical(after) === canonical(before)
        : incidentCancel
          ? cleanupCancelPostflightExact(before, after)
            && after.stagedPatchEmpty
            && after.stagedPatchStatus === "STAGED"
            && incidentOriginalBaselineMetadataExact(after, true)
            && checks.selectedIncidentPatchNonCommittedExact === true
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
    outcome = successorCloseout ? "failed_before_attempt" : "mutation_uncertain";
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
          providerGraphql,
        );
      } catch { after = null; }
      if (operation === INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION) {
        try {
          const observation = await readIncidentPatchObservation(
            dependencies.fetchImpl,
            metadataToken,
          );
          checks.selectedIncidentPatchNonCommittedExact = after !== null
            && after.stagedPatchEmpty
            && after.stagedPatchStatus === "STAGED"
            && observation.activeEmptyPatchId === after.stagedPatchId
            && observation.selectedNonCommittedExact;
        } catch {
          checks.selectedIncidentPatchNonCommittedExact = false;
        }
      }
      if (before && operation) {
        checks.deploymentUnchanged = after !== null
          && runtimeSnapshotUnchanged(before, after);
        if (operation === CLEANUP_OPERATION && attempts === 1) {
          const stagedSnapshotExact = after !== null
            && !after.stagedPatchEmpty
            && after.stagedPatchStatus === "STAGED"
            && (stagedDeletionPatchId === null
              || after.stagedPatchId === stagedDeletionPatchId)
            && JSON.stringify(after.variables) === JSON.stringify(before.variables)
            && checks.deploymentUnchanged;
          if (stagedSnapshotExact) {
            stagedDeletionPatchId = after!.stagedPatchId;
            try {
              checks.stagedDeletionPatchExact =
                await readStagedDeletionPatchExact(
                  dependencies.fetchImpl,
                  metadataToken,
                  stagedDeletionPatchId,
                );
            } catch {
              checks.stagedDeletionPatchExact = false;
            }
          } else {
            checks.stagedDeletionPatchExact = false;
          }
          checks.targetPostflightExact = false;
        } else {
          const variableName = Object.hasOwn(PROVIDER_OPERATIONS, operation)
            ? PROVIDER_OPERATIONS[operation as ProviderOperation]
            : null;
          const recovery = cleanupRecoveryOperation(operation);
          const incidentCancel = incidentCleanupCancelOperation(operation);
          checks.targetPostflightExact = after !== null
            && authorizedBaselineKind(after, candidateSha) === authorizedBaseline
            && (operation === CLEANUP_OPERATION
              ? cleanupPostflightExact(before, after)
              : incidentCancel
                ? cleanupCancelPostflightExact(before, after)
                  && after.stagedPatchEmpty
                  && after.stagedPatchStatus === "STAGED"
                  && incidentOriginalBaselineMetadataExact(after, true)
                  && checks.selectedIncidentPatchNonCommittedExact === true
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
  if (operation === CLEANUP_SUCCESSOR_CLOSEOUT_OPERATION) {
    const cleanupCloseoutSuccess = attempts === 0
      && cleanupSuccessorCloseoutAtPreflight
      && priorCleanupEvidenceVerified
      && !checks.stagedDeletionPatchExact
      && checks.committedDeletionPatchExact
      && !checks.boundaryPrecommitExact
      && commonSuccess;
    outcome = cleanupCloseoutSuccess
      ? "cleanup_completed_read_only_reconciled"
      : outcome;
  } else if (operation === CLEANUP_OPERATION) {
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
  } else if (operation === INCIDENT_MASKED_CLEANUP_CANCEL_OPERATION) {
    const incidentCancelSuccess = attempts === 1
      && priorCleanupEvidenceVerified
      && checks.stagedDeletionPatchExact
      && !checks.committedDeletionPatchExact
      && checks.selectedIncidentPatchNonCommittedExact === true
      && checks.boundaryPrecommitExact
      && commonSuccess;
    const incidentReadOnlyCloseoutSuccess = attempts === 0
      && incidentReadOnlyCloseoutAtPreflight
      && priorCleanupEvidenceVerified
      && !checks.stagedDeletionPatchExact
      && !checks.committedDeletionPatchExact
      && checks.selectedIncidentPatchNonCommittedExact === true
      && !checks.boundaryPrecommitExact
      && commonSuccess;
    outcome = incidentReadOnlyCloseoutSuccess
      ? "incident_masked_patch_cancel_already_completed_reconciled"
      : incidentCancelSuccess
        ? checks.acknowledgementExact
          ? "incident_masked_patch_cancel_acknowledged"
          : "incident_masked_patch_cancel_reconciled_after_lost_ack"
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
    "incident_masked_patch_cancel_acknowledged",
    "incident_masked_patch_cancel_reconciled_after_lost_ack",
    "incident_masked_patch_cancel_already_completed_reconciled",
    "cleanup_already_completed_reconciled",
    "cleanup_no_effect_retry_acknowledged",
    "cleanup_no_effect_retry_reconciled_after_lost_ack",
    "cleanup_already_cancelled_reconciled",
    "cleanup_completed_read_only_reconciled",
  ].includes(receipt.outcome) && receipt.checks.terminalEvidenceExact ? 0 : 1;
}

export const protectedPermanentStagingVariableMutationInternals = {
  cleanupBaselineMetadataExact,
  cleanupCompletedSnapshotExact,
  cleanupDeletionPatch,
  cleanupDeletionPatchExact,
  cleanupPostflightExact,
  exactColdDeadBaseline,
  exactHealthyLegacyBaseline,
  forbiddenOffsiteRowsExactForDeletion,
  incidentMaskedCleanupPatch,
  incidentMaskedCleanupPatchExact,
  incidentOriginalBaselineMetadataExact,
  incidentPriorCleanupEvidenceExact,
  cleanupSuccessorCloseoutEvidenceExact,
  parseAcknowledgement,
  parseArguments,
  parseCommitDeletionAcknowledgement,
  parseCommittedDeletionPatch,
  parseDeployment,
  parseMetadata,
  parseIncidentPatchProvenance,
  parseIncidentSelectedPatchNonCommitted,
  parseScope,
  parseStageDeletionAcknowledgement,
  parseStagedDeletionPatchReadback,
  priorCleanupEvidenceExact,
  providerPostflightExact,
  providerPreflightExact,
  reviewedCleanupRecoveryAuthorityValueExact,
  reviewedCleanupSuccessorCloseoutAuthorityValueExact,
  reviewedIncidentCleanupCancelAuthorityValueExact,
  secretStrings,
  supabaseMetadataExact,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedPermanentStagingVariableMutation();
}
