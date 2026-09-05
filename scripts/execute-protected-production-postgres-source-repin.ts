import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRailwayMutationBoundaryCheck } from "./check-railway-mutation-boundary.js";
import { readTrustedRegularFile } from "./lib/trusted-filesystem.js";

export const PROTECTED_PRODUCTION_POSTGRES_SOURCE_REPIN_SCHEMA =
  "pintpath-protected-production-postgres-source-lock/v2" as const;

export const PRODUCTION_POSTGRES_SOURCE_LOCK_PHASES = [
  "prepare",
  "apply",
  "reconcile",
] as const;

export const PRODUCTION_POSTGRES_SOURCE_LOCK_CLI = {
  phase: "--phase",
  candidateSha: "--candidate-sha",
  priorCandidateSha: "--prior-candidate-sha",
  githubAuthority: "--github-authority",
  evidenceDirectory: "--evidence-dir",
  intentFile: "--intent-file",
} as const;

export const PRODUCTION_POSTGRES_SOURCE_LOCK_EVIDENCE_FILES = {
  intent: "source-lock-intent.json",
  prepareTerminal: "prepare-terminal.json",
  prepareReceipt: "prepare-receipt.json",
  applyTerminal: "apply-terminal.json",
  applyReceipt: "apply-receipt.json",
  reconcileTerminal: "reconcile-terminal.json",
  reconcileReceipt: "reconcile-receipt.json",
} as const;

export const PRODUCTION_POSTGRES_SOURCE_LOCK_ENVIRONMENT_BINDINGS = {
  confirmation: "PINTPATH_PRODUCTION_POSTGRES_SOURCE_REPIN_CONFIRMATION",
  externalMutationFreeze: "PINTPATH_EXTERNAL_MUTATION_FREEZE_ATTESTATION",
  productionMetadataToken: "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
  stagingMetadataToken: "PINTPATH_RAILWAY_STAGING_METADATA_TOKEN",
  productionMutationToken: "PINTPATH_RAILWAY_PRODUCTION_SOURCE_MUTATION_TOKEN",
  intentSha256: "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_SHA256",
  intentArtifactId:
    "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_ID",
  intentArtifactDigest:
    "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_DIGEST",
  intentArtifactName:
    "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_NAME",
  intentArtifactRunId:
    "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_RUN_ID",
  priorRunId: "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_RUN_ID",
  priorCandidateSha:
    "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_CANDIDATE_SHA",
  priorRunGrace: "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_RUN_GRACE",
  priorTerminalArtifactId:
    "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_ARTIFACT_ID",
  priorTerminalArtifactDigest:
    "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_ARTIFACT_DIGEST",
  priorTerminalArtifactSize:
    "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_ARTIFACT_SIZE",
  priorApplyTerminalSha256:
    "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_APPLY_TERMINAL_SHA256",
  priorApplyReceiptSha256:
    "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_APPLY_RECEIPT_SHA256",
  priorTerminalEvidenceExact:
    "PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_EVIDENCE_EXACT",
} as const;

const POLICY_PATH =
  "ops/railway/protected-production-postgres-source-repin-policy.json";
const BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json";

// These are intentionally explicit review pins. Update both only in the same reviewed
// candidate that updates the corresponding JSON policies.
export const PRODUCTION_POSTGRES_SOURCE_LOCK_POLICY_SHA256 =
  "00ae7aa221bab26d662822843ed624fcfb15fadcb892a2cdf2dd35574bcf3d90";
export const PRODUCTION_POSTGRES_SOURCE_LOCK_BOUNDARY_POLICY_SHA256 =
  "a61ccb5493bbb15e37c8b158f441219b4540937d9dd0ab46ddc0a0cf0be84079";

const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const PRODUCTION_ENVIRONMENT_ID = "13dab015-df74-45c6-b26f-69323daea99a";
const STAGING_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "4a2334a1-71e7-4745-970a-2cd95da10169";
const SERVICE_INSTANCE_ID = "bba99cde-3f9b-4045-b349-93da78461b44";
const DEPLOYMENT_ID = "f31d3dbd-a997-42cf-b3a8-970b8c337841";
const SNAPSHOT_ID = "03f6d2ff-e78e-42a5-a78f-216a4a1f498d";
const RUNNING_INSTANCE_ID = "0a8b344a-8d17-4f77-8f1b-1677dcf122de";
const VOLUME_INSTANCE_ID = "74cbfae2-3383-40b4-8464-21a403ca509d";
const VOLUME_ID = "a3585b0a-b57a-4b69-ad45-05f798e739e1";
const MUTABLE_SOURCE = "ghcr.io/railwayapp-templates/postgres-ssl:17";
const IMAGE_DIGEST =
  "sha256:7383de344f558c61a16ecdcb3e6fc86f05c45c82a4e02ad77d96aa72b5ae2ba8";
const IMMUTABLE_SOURCE = `ghcr.io/railwayapp-templates/postgres-ssl@${IMAGE_DIGEST}`;
const BASELINE_CONFIG_ETAG =
  "e50589bf4093433313fd07b844b6e25eeb69878679626006edb9784629989bf9";
const CROSS_CANDIDATE_RECOVERY = {
  priorCandidateSha: "52049a1ef414e274e47197e28726387c90d96990",
  priorRunId: "33923801697",
  intentArtifactId: "9956146300",
  intentArtifactDigest:
    "sha256:03f39ec4e154809d7f778067fed83ba908af4a30e4b17a5a70809c1bbe6654f3",
  intentSha256:
    "61381d0ea3fd5394bb4de33b63379fcd13f524614797a434ff2b3e13f862bf9c",
  terminalArtifactId: "9956147717",
  terminalArtifactDigest:
    "sha256:56829b4867083450e79eca099c75e1535453256cc4341611674f5228e34ec785",
  terminalArtifactSize: "5869",
  applyTerminalSha256:
    "608420a0186048d2f60b376774444f116d411029a359734e8d0b5fcdf296f431",
  applyReceiptSha256:
    "571c8b3269d557392c2fac317e330d9d28a38a95838265a926922f284b651b36",
  dismissedConfigEtag:
    "ac5fb1e97cc4451ab5c09d05ecf1bcf591646a90d04945017a68616363b3227f",
} as const;
export const PRODUCTION_POSTGRES_SOURCE_LOCK_CONFIRMATION =
  "LOCK_PRODUCTION_POSTGRES_SOURCE_AND_DISABLE_AUTO_UPDATES_WITHOUT_DEPLOY";
export const PRODUCTION_POSTGRES_SOURCE_LOCK_FREEZE_ATTESTATION =
  "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN";
export const PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_RUN_GRACE_ATTESTATION =
  "I_ATTEST_PRIOR_SOURCE_LOCK_RUN_ENDED_AND_NO_WRITER_IS_ACTIVE";
const CONFIRMATION = PRODUCTION_POSTGRES_SOURCE_LOCK_CONFIRMATION;
const FREEZE_ATTESTATION = PRODUCTION_POSTGRES_SOURCE_LOCK_FREEZE_ATTESTATION;
const PRIOR_RUN_GRACE_ATTESTATION =
  PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_RUN_GRACE_ATTESTATION;
const COMMIT_MESSAGE_PREFIX = "pintpath:production-postgres-source-lock:";
const ARTIFACT_NAME_PREFIX = "pintpath-production-postgres-source-lock-intent-";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const ARTIFACT_ID = /^[1-9][0-9]{0,19}$/;
const TOKEN = /^[^\r\n\0]{16,4096}$/;

const ARMED_AUTO_UPDATES = {
  remediationNotice: {
    armedAt: "2026-08-24T22:45:47.247Z",
    currentVersion: "17.10",
    cveId: "CVE-2026-15741",
    severity: "HIGH",
    targetImage: MUTABLE_SOURCE,
    targetVersion: "17",
  },
  schedule: [
    { day: 6, endHour: 24, startHour: 10 },
    { day: 0, endHour: 18, startHour: 0 },
  ],
  tagMode: "sha",
  type: "vuln",
} as const;

const DISMISSED_AUTO_UPDATES = {
  remediationNotice: null,
  schedule: ARMED_AUTO_UPDATES.schedule,
  tagMode: "sha",
  type: "disabled",
} as const;

const DESIRED_AUTO_UPDATES = {
  schedule: null,
  tagMode: null,
  type: "disabled",
} as const;

export const PRODUCTION_POSTGRES_SOURCE_REPIN_SCOPE_QUERY = `query PintPathProductionPostgresSourceLockScope{projectToken{projectId environmentId}}`;

const DEPLOYMENT_FRAGMENT = `
fragment PintPathProductionPostgresSourceLockDeployment on Deployment {
  id
  projectId
  environmentId
  serviceId
  status
  deploymentStopped
  snapshotId
  instances { id status }
}`;

export const PRODUCTION_POSTGRES_SOURCE_REPIN_STATE_QUERY = `${DEPLOYMENT_FRAGMENT}
query PintPathProductionPostgresSourceLockState(
  $projectId: String!
  $environmentId: String!
  $serviceId: String!
  $deploymentId: String!
) {
  environment(id: $environmentId, projectId: $projectId) {
    id
    configEtag
    config(decryptVariables: false)
    volumeInstances(first: 100) {
      edges {
        node {
          id
          environmentId
          serviceId
          volumeId
          deletedAt
          isPendingDeletion
          mountPath
          region
          volume { id }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
  staged: environmentStagedChanges(environmentId: $environmentId) {
    id environmentId status message createdAt updatedAt appliedAt lastAppliedError
    patch(decryptVariables: false)
  }
  patchHistory: environmentPatches(environmentId: $environmentId, first: 100) {
    edges {
      node {
        id environmentId status message createdAt updatedAt appliedAt lastAppliedError
        patch(decryptVariables: false)
      }
    }
    pageInfo { hasNextPage endCursor }
  }
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    id serviceId environmentId numReplicas region source { image repo }
    latestDeployment { ...PintPathProductionPostgresSourceLockDeployment }
    activeDeployments { ...PintPathProductionPostgresSourceLockDeployment }
  }
  deployments(
    input: {
      projectId: $projectId
      environmentId: $environmentId
      serviceId: $serviceId
      includeDeleted: true
    }
    first: 100
  ) {
    edges { node { ...PintPathProductionPostgresSourceLockDeployment } }
    pageInfo { hasNextPage endCursor }
  }
  baselineDeployment: deployment(id: $deploymentId) {
    id projectId environmentId serviceId status deploymentStopped snapshotId meta
    instances { id status }
  }
}`;

export const PRODUCTION_POSTGRES_SOURCE_REPIN_DISMISS_MUTATION = `mutation PintPathProductionPostgresSourceLockDismiss(
  $environmentId: String!
  $serviceId: String!
) {
  serviceInstanceVulnRemediationDismiss(
    environmentId: $environmentId
    serviceId: $serviceId
  )
}`;

export const PRODUCTION_POSTGRES_SOURCE_REPIN_STAGE_MUTATION = `mutation PintPathProductionPostgresSourceLockStage(
  $environmentId: String!
  $input: EnvironmentConfig!
  $merge: Boolean!
) {
  environmentStageChanges(environmentId: $environmentId, input: $input, merge: $merge) {
    id environmentId status message createdAt updatedAt appliedAt lastAppliedError
  }
}`;

export const PRODUCTION_POSTGRES_SOURCE_REPIN_PATCH_QUERY = `query PintPathProductionPostgresSourceLockPatch(
  $environmentId: String!
  $patchId: String!
) {
  active: environmentStagedChanges(environmentId: $environmentId) {
    id environmentId status message createdAt updatedAt appliedAt lastAppliedError
    patch(decryptVariables: false)
  }
  selected: environmentPatch(id: $patchId) {
    id environmentId status message createdAt updatedAt appliedAt lastAppliedError
    patch(decryptVariables: false)
  }
}`;

export const PRODUCTION_POSTGRES_SOURCE_REPIN_COMMIT_MUTATION = `mutation PintPathProductionPostgresSourceLockCommit(
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

const BOUNDARY_CHECK_NAMES = [
  "policyValid",
  "queriesMetadataOnly",
  "productionTokenScopeExact",
  "stagingTokenScopeExact",
  "productionEnvironmentExact",
  "stagingEnvironmentExact",
  "productionPatchEmpty",
  "stagingPatchEmpty",
  "productionPostgresExact",
  "approvedDeploymentCurrent",
  "approvedDeploymentActive",
  "approvedDeploymentHealthy",
  "approvedSnapshotExact",
  "approvedImageDigestExact",
  "deploymentPatchAbsent",
  "deploymentRecordedSourceExact",
  "sourceImageExact",
  "autoUpdatesDisabledExact",
  "sourceReferenceImmutable",
] as const;

type Phase = (typeof PRODUCTION_POSTGRES_SOURCE_LOCK_PHASES)[number];
type BoundaryCheckName = (typeof BOUNDARY_CHECK_NAMES)[number];
type BoundaryChecks = Record<BoundaryCheckName, boolean>;

const SOURCE_LOCK_ALLOWED_FALSE_BOUNDARY_CHECKS = [
  "sourceImageExact",
  "autoUpdatesDisabledExact",
  "sourceReferenceImmutable",
] as const satisfies readonly BoundaryCheckName[];

interface BoundaryObservation {
  readonly code: 0 | 1;
  readonly checks: BoundaryChecks;
}

interface Args {
  readonly phase: Phase;
  readonly candidateSha: string;
  readonly priorCandidateSha: string | null;
  readonly githubAuthorityFile: string;
  readonly evidenceDirectory: string;
  readonly intentFile: string | null;
}

interface ReviewedAuthority {
  readonly sha256: string;
  readonly reviewedPullRequestNumber: number;
  readonly reviewedPrHeadSha: string;
  readonly workflowRunId: string;
  readonly workflowRunCreatedAt: string;
  readonly safePriorSkippedWriteRunIds: readonly string[];
  readonly recovery: {
    readonly priorRunId: string;
    readonly intentCandidateSha: string;
    readonly crossCandidateExact: boolean;
    readonly originalRunCompletedAt: string;
  } | null;
}

interface ProviderDeployment {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly status: string;
  readonly deploymentStopped: boolean;
  readonly snapshotId: string | null;
  readonly instances: readonly {
    readonly id: string;
    readonly status: string;
  }[];
}

interface ProviderPatch {
  readonly id: string;
  readonly environmentId: string;
  readonly status: string;
  readonly message: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly appliedAt: string | null;
  readonly lastAppliedError: string | null;
  readonly patch: Readonly<Record<string, unknown>>;
}

interface ProviderState {
  readonly configEtag: string;
  readonly configuredSourceImage: string | null;
  readonly configuredSourceRepo: string | null;
  readonly autoUpdates: Readonly<Record<string, unknown>> | null;
  readonly serviceInstanceId: string;
  readonly serviceId: string;
  readonly environmentId: string;
  readonly numReplicas: number | null;
  readonly region: string | null;
  readonly sourceImage: string | null;
  readonly sourceRepo: string | null;
  readonly latestDeployment: ProviderDeployment;
  readonly activeDeployments: readonly ProviderDeployment[];
  readonly deploymentInventory: readonly ProviderDeployment[];
  readonly volumeInstances: readonly {
    readonly id: string;
    readonly environmentId: string;
    readonly serviceId: string;
    readonly volumeId: string;
    readonly deletedAt: string | null;
    readonly isPendingDeletion: boolean;
    readonly mountPath: string;
    readonly region: string | null;
  }[];
  readonly stagedPatch: ProviderPatch;
  readonly patchHistory: readonly ProviderPatch[];
  readonly baselineDeployment: ProviderDeployment & {
    readonly sourceImage: string;
    readonly imageDigest: string;
    readonly patchId: null;
  };
}

interface Intent {
  readonly schemaVersion: "pintpath-production-postgres-source-lock-intent/v2";
  readonly operation: "production-postgres-source-repin";
  readonly candidateSha: string;
  readonly githubRunId: string;
  readonly reviewedAuthoritySha256: string;
  readonly reviewedPullRequestNumber: number;
  readonly projectId: typeof PROJECT_ID;
  readonly environmentId: typeof PRODUCTION_ENVIRONMENT_ID;
  readonly serviceId: typeof SERVICE_ID;
  readonly serviceInstanceId: typeof SERVICE_INSTANCE_ID;
  readonly deploymentId: typeof DEPLOYMENT_ID;
  readonly snapshotId: typeof SNAPSHOT_ID;
  readonly runningInstanceId: typeof RUNNING_INSTANCE_ID;
  readonly volumeInstanceId: typeof VOLUME_INSTANCE_ID;
  readonly volumeId: typeof VOLUME_ID;
  readonly sourceBefore: typeof MUTABLE_SOURCE;
  readonly sourceAfter: typeof IMMUTABLE_SOURCE;
  readonly baselineConfigEtag: string;
  readonly runtimeBeforeSha256: string;
  readonly armedAutoUpdatesSha256: string;
  readonly requestedPatchSha256: string;
  readonly providerNormalizedPatchSha256: string;
  readonly commitMessage: string;
  readonly externalMutationFreeze: typeof FREEZE_ATTESTATION;
  readonly retryAllowed: false;
  readonly deploymentAllowed: false;
  readonly secretMaterialIncluded: false;
  readonly rawProviderMetadataIncluded: false;
}

interface Checks {
  policyExact: boolean;
  authorityExact: boolean;
  credentialsExact: boolean;
  tokenScopesExact: boolean;
  artifactBindingExact: boolean;
  priorRunGraceExact: boolean;
  intentExact: boolean;
  durableIntentExact: boolean;
  baselineExact: boolean;
  boundaryPreflightExact: boolean;
  dismissAttemptedAtMostOnce: boolean;
  dismissAcknowledgementExact: boolean;
  dismissedReadbackExact: boolean;
  stageAttemptedAtMostOnce: boolean;
  stageAcknowledgementExact: boolean;
  stagedReadbackOneExact: boolean;
  stagedReadbackTwoExact: boolean;
  precommitRaceAbsent: boolean;
  commitAttemptedAtMostOnce: boolean;
  commitAcknowledgementExact: boolean;
  committedHistoryExact: boolean;
  desiredStateExact: boolean;
  runtimeContinuityExact: boolean;
  inventoryContinuityExact: boolean;
  boundaryPostflightExact: boolean;
  terminalEvidenceExact: boolean;
  receiptEvidenceExact: boolean;
}

type Outcome =
  | "prepared"
  | "applied"
  | "applied_reconciled_after_lost_ack"
  | "reconciled_read_only"
  | "reconciled_commit_only"
  | "reconciled_stage_and_commit"
  | "not_applied"
  | "failed_before_write"
  | "mutation_uncertain";

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly writeDurable: (
    directory: string,
    leaf: string,
    source: string,
  ) => string;
  readonly writeOutput: (source: string) => void;
  readonly runBoundary: () => Promise<BoundaryObservation>;
  readonly verifyPolicy: (cwd: string) => boolean;
  readonly now: () => number;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: unknown,
  names: readonly string[],
): value is Record<string, unknown> {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  const expected = new Set(names);
  return (
    actual.length === expected.size &&
    actual.every((name) => expected.has(name))
  );
}

function stable(value: unknown): string | null {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : null;
  }
  if (Array.isArray(value)) {
    const entries = value.map(stable);
    return entries.some((entry) => entry === null)
      ? null
      : `[${entries.join(",")}]`;
  }
  if (!record(value)) return null;
  const entries = Object.keys(value)
    .sort()
    .map((key) => {
      const encoded = stable(value[key]);
      return encoded === null ? null : `${JSON.stringify(key)}:${encoded}`;
    });
  return entries.some((entry) => entry === null)
    ? null
    : `{${entries.join(",")}}`;
}

function stableExact(left: unknown, right: unknown): boolean {
  const encoded = stable(left);
  return encoded !== null && encoded === stable(right);
}

function requestedPatch(): Readonly<Record<string, unknown>> {
  return {
    services: {
      [SERVICE_ID]: {
        source: {
          image: IMMUTABLE_SOURCE,
          autoUpdates: {
            type: "disabled",
            schedule: null,
            tagMode: null,
            remediationNotice: null,
            snoozedUntil: null,
          },
        },
      },
    },
  };
}

function providerNormalizedPatch(): Readonly<Record<string, unknown>> {
  return {
    services: {
      [SERVICE_ID]: {
        source: {
          image: IMMUTABLE_SOURCE,
          autoUpdates: {
            type: "disabled",
            schedule: null,
            tagMode: null,
          },
        },
      },
    },
  };
}

function parseArgs(argv: readonly string[]): Args | null {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !key ||
      !value ||
      ![
        "--phase",
        "--candidate-sha",
        "--prior-candidate-sha",
        "--github-authority",
        "--evidence-dir",
        "--intent-file",
      ].includes(key) ||
      values.has(key)
    )
      return null;
    values.set(key, value);
  }
  const phase = values.get("--phase");
  const candidateSha = values.get("--candidate-sha") ?? "";
  const priorCandidateSha = values.get("--prior-candidate-sha") ?? null;
  const githubAuthorityFile = values.get("--github-authority") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  const intentFile = values.get("--intent-file") ?? null;
  if (
    !PRODUCTION_POSTGRES_SOURCE_LOCK_PHASES.includes(phase as Phase) ||
    !SHA.test(candidateSha) ||
    !path.isAbsolute(githubAuthorityFile) ||
    !path.isAbsolute(evidenceDirectory) ||
    (phase === "reconcile"
      ? priorCandidateSha === null || !SHA.test(priorCandidateSha)
      : priorCandidateSha !== null) ||
    (phase === "prepare" ? intentFile !== null : intentFile === null) ||
    (intentFile !== null && !path.isAbsolute(intentFile))
  )
    return null;
  return {
    phase: phase as Phase,
    candidateSha,
    priorCandidateSha,
    githubAuthorityFile,
    evidenceDirectory,
    intentFile,
  };
}

function checks(): Checks {
  return {
    policyExact: false,
    authorityExact: false,
    credentialsExact: false,
    tokenScopesExact: false,
    artifactBindingExact: false,
    priorRunGraceExact: false,
    intentExact: false,
    durableIntentExact: false,
    baselineExact: false,
    boundaryPreflightExact: false,
    dismissAttemptedAtMostOnce: true,
    dismissAcknowledgementExact: false,
    dismissedReadbackExact: false,
    stageAttemptedAtMostOnce: true,
    stageAcknowledgementExact: false,
    stagedReadbackOneExact: false,
    stagedReadbackTwoExact: false,
    precommitRaceAbsent: false,
    commitAttemptedAtMostOnce: true,
    commitAcknowledgementExact: false,
    committedHistoryExact: false,
    desiredStateExact: false,
    runtimeContinuityExact: false,
    inventoryContinuityExact: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
    receiptEvidenceExact: false,
  };
}

function evidenceDirectoryExact(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      fs.realpathSync(directory) === directory &&
      (stat.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

function durable(directory: string, leaf: string, source: string): string {
  if (
    !evidenceDirectoryExact(directory) ||
    !/^[a-z][a-z0-9-]*\.json$/.test(leaf)
  )
    throw new Error("evidence_invalid");
  const filename = path.join(directory, leaf);
  const handle = fs.openSync(
    filename,
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(handle, source);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return sha256(source);
}

function safeProviderString(value: unknown, maximum = 1_024): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    !/[\r\n\0]/.test(value)
  );
}

function nullableProviderString(value: unknown, maximum = 1_024): boolean {
  return value === null || safeProviderString(value, maximum);
}

function parseTimestamp(value: unknown): string | null {
  if (!safeProviderString(value, 64)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString();
}

function readPrivateJson(filename: string): Buffer {
  return readTrustedRegularFile(filename, {
    minBytes: 2,
    maxBytes: 65_536,
    requirePrivate: true,
  });
}

function reviewedAuthorityExact(
  filename: string,
  args: Args,
  env: Readonly<Record<string, string | undefined>>,
): ReviewedAuthority | null {
  let source: Buffer | null = null;
  try {
    source = readPrivateJson(filename);
    const value = JSON.parse(source.toString("utf8")) as unknown;
    const commonKeys = [
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
      "reviewedAuthorityExact",
      "freshDispatchWriteGuardExact",
    ] as const;
    const recoveryKeys = [
      "priorAmbiguousProductionPostgresSourceRepinRunId",
      "priorProductionPostgresSourceRepinIntentCandidateSha",
      "crossCandidateProductionPostgresSourceRepinRecoveryExact",
      "exactPriorProductionPostgresSourceRepinCandidateRunBound",
      "secondProductionPostgresRemediationDismissPreventedExact",
      "runnerLossRecoveryOriginalRunCompletedAt",
      "runnerLossRecoverySettlementSeconds",
      "runnerLossRecoveryGraceHours",
      "runnerLossRecoveryWithinGraceExact",
    ] as const;
    const expectedOperation =
      args.phase === "reconcile"
        ? "production-postgres-source-repin-reconcile"
        : "production-postgres-source-repin";
    if (
      !exactKeys(
        value,
        args.phase === "reconcile"
          ? [...commonKeys, ...recoveryKeys]
          : commonKeys,
      ) ||
      value.command !== "verify-github-reviewed-candidate-authority" ||
      value.ok !== true ||
      value.schemaVersion !== 1 ||
      value.kind !== "pintpath-github-reviewed-candidate-authority" ||
      value.repository !== "blackmagic30/Beer" ||
      value.candidateSha !== args.candidateSha ||
      typeof value.reviewedPrHeadSha !== "string" ||
      !SHA.test(value.reviewedPrHeadSha) ||
      !Number.isSafeInteger(value.reviewedPullRequestNumber) ||
      Number(value.reviewedPullRequestNumber) < 1 ||
      value.operation !== expectedOperation ||
      value.workflowPath !==
        ".github/workflows/repin-production-postgres-source.yml" ||
      value.workflowRunId !== env.GITHUB_RUN_ID ||
      value.workflowRunAttempt !== 1 ||
      parseTimestamp(value.workflowRunCreatedAt) === null ||
      parseTimestamp(value.reviewedPullRequestMergedAt) === null ||
      value.candidateHistoryMaximumAgeHours !== 168 ||
      value.completeRetainedHistoryExact !== true ||
      !Array.isArray(value.safePriorSkippedWriteRunIds) ||
      value.safePriorSkippedWriteRunIds.length > 100 ||
      !value.safePriorSkippedWriteRunIds.every(
        (runId) =>
          typeof runId === "string" &&
          RUN_ID.test(runId) &&
          runId !== env.GITHUB_RUN_ID,
      ) ||
      new Set(value.safePriorSkippedWriteRunIds).size !==
        value.safePriorSkippedWriteRunIds.length ||
      value.reviewedAuthorityExact !== true ||
      value.freshDispatchWriteGuardExact !== true
    )
      return null;
    const workflowRunCreatedAt = parseTimestamp(value.workflowRunCreatedAt);
    if (workflowRunCreatedAt === null) return null;
    let recovery: ReviewedAuthority["recovery"] = null;
    if (args.phase === "reconcile") {
      const priorRunId = value.priorAmbiguousProductionPostgresSourceRepinRunId;
      const intentCandidateSha =
        value.priorProductionPostgresSourceRepinIntentCandidateSha;
      const crossCandidateExact =
        value.crossCandidateProductionPostgresSourceRepinRecoveryExact;
      const originalRunCompletedAt = parseTimestamp(
        value.runnerLossRecoveryOriginalRunCompletedAt,
      );
      if (
        typeof priorRunId !== "string" ||
        !RUN_ID.test(priorRunId) ||
        typeof intentCandidateSha !== "string" ||
        !SHA.test(intentCandidateSha) ||
        intentCandidateSha !== args.priorCandidateSha ||
        typeof crossCandidateExact !== "boolean" ||
        crossCandidateExact !== (intentCandidateSha !== args.candidateSha) ||
        priorRunId === env.GITHUB_RUN_ID ||
        value.safePriorSkippedWriteRunIds.includes(priorRunId) ||
        value.exactPriorProductionPostgresSourceRepinCandidateRunBound !==
          true ||
        value.secondProductionPostgresRemediationDismissPreventedExact !==
          true ||
        originalRunCompletedAt === null ||
        value.runnerLossRecoverySettlementSeconds !== 60 ||
        value.runnerLossRecoveryGraceHours !== 24 ||
        value.runnerLossRecoveryWithinGraceExact !== true
      )
        return null;
      recovery = {
        priorRunId,
        intentCandidateSha,
        crossCandidateExact,
        originalRunCompletedAt,
      };
    }
    return {
      sha256: sha256(source),
      reviewedPullRequestNumber: Number(value.reviewedPullRequestNumber),
      reviewedPrHeadSha: value.reviewedPrHeadSha,
      workflowRunId: String(value.workflowRunId),
      workflowRunCreatedAt,
      safePriorSkippedWriteRunIds:
        value.safePriorSkippedWriteRunIds as string[],
      recovery,
    };
  } catch {
    return null;
  } finally {
    source?.fill(0);
  }
}

function commonAuthorityExact(
  args: Args,
  env: Readonly<Record<string, string | undefined>>,
  authority: ReviewedAuthority | null,
): boolean {
  return (
    authority !== null &&
    env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_REPOSITORY === "blackmagic30/Beer" &&
    env.GITHUB_REF === "refs/heads/main" &&
    env.GITHUB_SHA === args.candidateSha &&
    env.GITHUB_RUN_ATTEMPT === "1" &&
    RUN_ID.test(env.GITHUB_RUN_ID ?? "") &&
    (args.phase === "reconcile"
      ? env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_CANDIDATE_SHA ===
        args.priorCandidateSha
      : !env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_CANDIDATE_SHA) &&
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_REPIN_CONFIRMATION ===
      CONFIRMATION &&
    env.PINTPATH_EXTERNAL_MUTATION_FREEZE_ATTESTATION === FREEZE_ATTESTATION
  );
}

function intentCandidateSha(args: Args): string {
  return args.phase === "reconcile"
    ? (args.priorCandidateSha ?? "")
    : args.candidateSha;
}

function parseIntent(
  filename: string,
  args: Args,
): { readonly intent: Intent; readonly sha256: string } | null {
  let source: Buffer | null = null;
  try {
    source = readPrivateJson(filename);
    const value = JSON.parse(source.toString("utf8")) as unknown;
    if (
      !exactKeys(value, [
        "schemaVersion",
        "operation",
        "candidateSha",
        "githubRunId",
        "reviewedAuthoritySha256",
        "reviewedPullRequestNumber",
        "projectId",
        "environmentId",
        "serviceId",
        "serviceInstanceId",
        "deploymentId",
        "snapshotId",
        "runningInstanceId",
        "volumeInstanceId",
        "volumeId",
        "sourceBefore",
        "sourceAfter",
        "baselineConfigEtag",
        "runtimeBeforeSha256",
        "armedAutoUpdatesSha256",
        "requestedPatchSha256",
        "providerNormalizedPatchSha256",
        "commitMessage",
        "externalMutationFreeze",
        "retryAllowed",
        "deploymentAllowed",
        "secretMaterialIncluded",
        "rawProviderMetadataIncluded",
      ]) ||
      value.schemaVersion !==
        "pintpath-production-postgres-source-lock-intent/v2" ||
      value.operation !== "production-postgres-source-repin" ||
      value.candidateSha !== intentCandidateSha(args) ||
      !RUN_ID.test(String(value.githubRunId)) ||
      !SHA256.test(String(value.reviewedAuthoritySha256)) ||
      !Number.isSafeInteger(value.reviewedPullRequestNumber) ||
      value.projectId !== PROJECT_ID ||
      value.environmentId !== PRODUCTION_ENVIRONMENT_ID ||
      value.serviceId !== SERVICE_ID ||
      value.serviceInstanceId !== SERVICE_INSTANCE_ID ||
      value.deploymentId !== DEPLOYMENT_ID ||
      value.snapshotId !== SNAPSHOT_ID ||
      value.runningInstanceId !== RUNNING_INSTANCE_ID ||
      value.volumeInstanceId !== VOLUME_INSTANCE_ID ||
      value.volumeId !== VOLUME_ID ||
      value.sourceBefore !== MUTABLE_SOURCE ||
      value.sourceAfter !== IMMUTABLE_SOURCE ||
      !SHA256.test(String(value.baselineConfigEtag)) ||
      !SHA256.test(String(value.runtimeBeforeSha256)) ||
      value.armedAutoUpdatesSha256 !==
        sha256(stable(ARMED_AUTO_UPDATES) ?? "") ||
      value.requestedPatchSha256 !== sha256(stable(requestedPatch()) ?? "") ||
      value.providerNormalizedPatchSha256 !==
        sha256(stable(providerNormalizedPatch()) ?? "") ||
      value.commitMessage !==
        `${COMMIT_MESSAGE_PREFIX}${intentCandidateSha(args)}:${value.githubRunId}` ||
      value.externalMutationFreeze !== FREEZE_ATTESTATION ||
      value.retryAllowed !== false ||
      value.deploymentAllowed !== false ||
      value.secretMaterialIncluded !== false ||
      value.rawProviderMetadataIncluded !== false
    )
      return null;
    return { intent: value as unknown as Intent, sha256: sha256(source) };
  } catch {
    return null;
  } finally {
    source?.fill(0);
  }
}

function artifactBindingExact(
  parsed: { readonly intent: Intent; readonly sha256: string },
  args: Args,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_SHA256 ===
      parsed.sha256 &&
    ARTIFACT_ID.test(
      env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_ID ?? "",
    ) &&
    /^sha256:[a-f0-9]{64}$/.test(
      env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_DIGEST ?? "",
    ) &&
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_NAME ===
      `${ARTIFACT_NAME_PREFIX}${intentCandidateSha(args)}-${parsed.intent.githubRunId}` &&
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_RUN_ID ===
      parsed.intent.githubRunId
  );
}

function crossCandidateIncidentBindingExact(
  args: Args,
  parsed: { readonly intent: Intent; readonly sha256: string },
  authority: ReviewedAuthority,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const crossCandidate =
    args.phase === "reconcile" &&
    args.priorCandidateSha !== null &&
    args.priorCandidateSha !== args.candidateSha;
  const incidentValues = [
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_ARTIFACT_ID,
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_ARTIFACT_DIGEST,
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_ARTIFACT_SIZE,
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_APPLY_TERMINAL_SHA256,
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_APPLY_RECEIPT_SHA256,
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_EVIDENCE_EXACT,
  ];
  if (!crossCandidate) {
    return incidentValues.every((value) => value === undefined || value === "");
  }
  return (
    authority.recovery !== null &&
    authority.recovery.crossCandidateExact === true &&
    authority.recovery.intentCandidateSha ===
      CROSS_CANDIDATE_RECOVERY.priorCandidateSha &&
    args.priorCandidateSha === CROSS_CANDIDATE_RECOVERY.priorCandidateSha &&
    authority.recovery.priorRunId === CROSS_CANDIDATE_RECOVERY.priorRunId &&
    parsed.intent.candidateSha === CROSS_CANDIDATE_RECOVERY.priorCandidateSha &&
    parsed.intent.githubRunId === CROSS_CANDIDATE_RECOVERY.priorRunId &&
    parsed.sha256 === CROSS_CANDIDATE_RECOVERY.intentSha256 &&
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_ID ===
      CROSS_CANDIDATE_RECOVERY.intentArtifactId &&
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_INTENT_ARTIFACT_DIGEST ===
      CROSS_CANDIDATE_RECOVERY.intentArtifactDigest &&
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_ARTIFACT_ID ===
      CROSS_CANDIDATE_RECOVERY.terminalArtifactId &&
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_ARTIFACT_DIGEST ===
      CROSS_CANDIDATE_RECOVERY.terminalArtifactDigest &&
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_ARTIFACT_SIZE ===
      CROSS_CANDIDATE_RECOVERY.terminalArtifactSize &&
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_APPLY_TERMINAL_SHA256 ===
      CROSS_CANDIDATE_RECOVERY.applyTerminalSha256 &&
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_APPLY_RECEIPT_SHA256 ===
      CROSS_CANDIDATE_RECOVERY.applyReceiptSha256 &&
    env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_TERMINAL_EVIDENCE_EXACT ===
      "true"
  );
}

async function readBounded(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("provider_invalid");
  }
  if (!response.body) throw new Error("provider_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("provider_invalid");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
}

async function providerCall(
  fetchImpl: typeof fetch,
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Project-Access-Token": token,
    },
    body: JSON.stringify({ operationName, query, variables }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("provider_invalid");
  }
  const source = await readBounded(response);
  if (source.includes("\0")) throw new Error("provider_invalid");
  return JSON.parse(source) as unknown;
}

function tokenScopeExact(value: unknown, environmentId: string): boolean {
  return (
    exactKeys(value, ["data"]) &&
    exactKeys(value.data, ["projectToken"]) &&
    exactKeys(value.data.projectToken, ["projectId", "environmentId"]) &&
    value.data.projectToken.projectId === PROJECT_ID &&
    value.data.projectToken.environmentId === environmentId
  );
}

function parseInstances(
  value: unknown,
): readonly { id: string; status: string }[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const instances: { id: string; status: string }[] = [];
  for (const item of value) {
    if (
      !exactKeys(item, ["id", "status"]) ||
      !UUID.test(String(item.id)) ||
      !safeProviderString(item.status, 64)
    )
      return null;
    instances.push({ id: String(item.id), status: item.status });
  }
  return instances.sort((left, right) => left.id.localeCompare(right.id));
}

function parseDeployment(value: unknown): ProviderDeployment | null {
  if (
    !exactKeys(value, [
      "id",
      "projectId",
      "environmentId",
      "serviceId",
      "status",
      "deploymentStopped",
      "snapshotId",
      "instances",
    ])
  )
    return null;
  const instances = parseInstances(value.instances);
  if (
    !UUID.test(String(value.id)) ||
    !UUID.test(String(value.projectId)) ||
    !UUID.test(String(value.environmentId)) ||
    !UUID.test(String(value.serviceId)) ||
    !safeProviderString(value.status, 64) ||
    typeof value.deploymentStopped !== "boolean" ||
    !(value.snapshotId === null || UUID.test(String(value.snapshotId))) ||
    instances === null
  )
    return null;
  return {
    id: String(value.id),
    projectId: String(value.projectId),
    environmentId: String(value.environmentId),
    serviceId: String(value.serviceId),
    status: value.status,
    deploymentStopped: value.deploymentStopped,
    snapshotId: value.snapshotId === null ? null : String(value.snapshotId),
    instances,
  };
}

function parsePatch(value: unknown): ProviderPatch | null {
  if (
    !exactKeys(value, [
      "id",
      "environmentId",
      "status",
      "message",
      "createdAt",
      "updatedAt",
      "appliedAt",
      "lastAppliedError",
      "patch",
    ]) ||
    !safeProviderString(value.id, 64) ||
    !(value.id === "<empty>" || UUID.test(value.id)) ||
    !UUID.test(String(value.environmentId)) ||
    !safeProviderString(value.status, 64) ||
    !nullableProviderString(value.message) ||
    !nullableProviderString(value.lastAppliedError) ||
    !record(value.patch)
  )
    return null;
  const createdAt =
    value.createdAt === null ? null : parseTimestamp(value.createdAt);
  const updatedAt =
    value.updatedAt === null ? null : parseTimestamp(value.updatedAt);
  const appliedAt =
    value.appliedAt === null ? null : parseTimestamp(value.appliedAt);
  if (
    (value.createdAt !== null && createdAt === null) ||
    (value.updatedAt !== null && updatedAt === null) ||
    (value.appliedAt !== null && appliedAt === null)
  )
    return null;
  return {
    id: value.id,
    environmentId: String(value.environmentId),
    status: value.status,
    message: value.message as string | null,
    createdAt,
    updatedAt,
    appliedAt,
    lastAppliedError: value.lastAppliedError as string | null,
    patch: value.patch,
  };
}

function parseConnection<T>(
  value: unknown,
  parseNode: (value: unknown) => T | null,
  maximum: number,
): readonly T[] | null {
  const endCursor =
    record(value) && record(value.pageInfo)
      ? value.pageInfo.endCursor
      : undefined;
  if (
    !exactKeys(value, ["edges", "pageInfo"]) ||
    !Array.isArray(value.edges) ||
    value.edges.length > maximum ||
    !exactKeys(value.pageInfo, ["hasNextPage", "endCursor"]) ||
    value.pageInfo.hasNextPage !== false ||
    (value.edges.length === 0
      ? endCursor !== null
      : !safeProviderString(endCursor, 1_024) || endCursor.length === 0)
  )
    return null;
  const result: T[] = [];
  for (const edge of value.edges) {
    if (!exactKeys(edge, ["node"])) return null;
    const node = parseNode(edge.node);
    if (node === null) return null;
    result.push(node);
  }
  return result;
}

function configuredSource(config: unknown): {
  image: string | null;
  repo: string | null;
  autoUpdates: Readonly<Record<string, unknown>> | null;
} | null {
  if (!record(config) || !record(config.services)) return null;
  const service = config.services[SERVICE_ID];
  if (!record(service) || !record(service.source)) return null;
  const source = service.source;
  if (
    !(source.image === null || safeProviderString(source.image, 512)) ||
    !(
      source.repo === undefined ||
      source.repo === null ||
      safeProviderString(source.repo, 512)
    ) ||
    !record(source.autoUpdates)
  )
    return null;
  return {
    image: source.image as string | null,
    repo: typeof source.repo === "string" ? source.repo : null,
    autoUpdates: source.autoUpdates,
  };
}

function parseState(value: unknown): ProviderState | null {
  if (
    !exactKeys(value, ["data"]) ||
    !exactKeys(value.data, [
      "environment",
      "staged",
      "patchHistory",
      "serviceInstance",
      "deployments",
      "baselineDeployment",
    ])
  )
    return null;
  const data = value.data;
  if (
    !exactKeys(data.environment, [
      "id",
      "configEtag",
      "config",
      "volumeInstances",
    ]) ||
    data.environment.id !== PRODUCTION_ENVIRONMENT_ID ||
    !SHA256.test(String(data.environment.configEtag))
  )
    return null;
  const source = configuredSource(data.environment.config);
  if (source === null) return null;

  const volumes = parseConnection(
    data.environment.volumeInstances,
    (value) => {
      if (
        !exactKeys(value, [
          "id",
          "environmentId",
          "serviceId",
          "volumeId",
          "deletedAt",
          "isPendingDeletion",
          "mountPath",
          "region",
          "volume",
        ]) ||
        !exactKeys(value.volume, ["id"]) ||
        !UUID.test(String(value.id)) ||
        !UUID.test(String(value.environmentId)) ||
        !UUID.test(String(value.serviceId)) ||
        !UUID.test(String(value.volumeId)) ||
        value.volume.id !== value.volumeId ||
        !nullableProviderString(value.deletedAt, 64) ||
        typeof value.isPendingDeletion !== "boolean" ||
        !safeProviderString(value.mountPath, 512) ||
        !nullableProviderString(value.region, 128)
      )
        return null;
      return {
        id: String(value.id),
        environmentId: String(value.environmentId),
        serviceId: String(value.serviceId),
        volumeId: String(value.volumeId),
        deletedAt: value.deletedAt as string | null,
        isPendingDeletion: value.isPendingDeletion,
        mountPath: value.mountPath,
        region: value.region as string | null,
      };
    },
    100,
  );
  if (volumes === null) return null;

  if (
    !exactKeys(data.serviceInstance, [
      "id",
      "serviceId",
      "environmentId",
      "numReplicas",
      "region",
      "source",
      "latestDeployment",
      "activeDeployments",
    ]) ||
    !exactKeys(data.serviceInstance.source, ["image", "repo"]) ||
    !UUID.test(String(data.serviceInstance.id)) ||
    !UUID.test(String(data.serviceInstance.serviceId)) ||
    !UUID.test(String(data.serviceInstance.environmentId)) ||
    !(
      data.serviceInstance.numReplicas === null ||
      Number.isSafeInteger(data.serviceInstance.numReplicas)
    ) ||
    !nullableProviderString(data.serviceInstance.region, 128) ||
    !nullableProviderString(data.serviceInstance.source.image, 512) ||
    !nullableProviderString(data.serviceInstance.source.repo, 512) ||
    !Array.isArray(data.serviceInstance.activeDeployments) ||
    data.serviceInstance.activeDeployments.length > 20
  )
    return null;
  const latestDeployment = parseDeployment(
    data.serviceInstance.latestDeployment,
  );
  const activeDeployments =
    data.serviceInstance.activeDeployments.map(parseDeployment);
  const deployments = parseConnection(data.deployments, parseDeployment, 100);
  const patchHistory = parseConnection(data.patchHistory, parsePatch, 100);
  const stagedPatch = parsePatch(data.staged);
  if (
    latestDeployment === null ||
    activeDeployments.some((item) => item === null) ||
    deployments === null ||
    patchHistory === null ||
    stagedPatch === null
  )
    return null;

  if (
    !exactKeys(data.baselineDeployment, [
      "id",
      "projectId",
      "environmentId",
      "serviceId",
      "status",
      "deploymentStopped",
      "snapshotId",
      "meta",
      "instances",
    ]) ||
    !record(data.baselineDeployment.meta)
  )
    return null;
  const baselineBase = parseDeployment({
    id: data.baselineDeployment.id,
    projectId: data.baselineDeployment.projectId,
    environmentId: data.baselineDeployment.environmentId,
    serviceId: data.baselineDeployment.serviceId,
    status: data.baselineDeployment.status,
    deploymentStopped: data.baselineDeployment.deploymentStopped,
    snapshotId: data.baselineDeployment.snapshotId,
    instances: data.baselineDeployment.instances,
  });
  const sourceImage = data.baselineDeployment.meta.image;
  const imageDigest = data.baselineDeployment.meta.imageDigest;
  const patchId = data.baselineDeployment.meta.patchId ?? null;
  if (
    baselineBase === null ||
    !safeProviderString(sourceImage, 512) ||
    !safeProviderString(imageDigest, 128) ||
    patchId !== null
  )
    return null;

  return {
    configEtag: String(data.environment.configEtag),
    configuredSourceImage: source.image,
    configuredSourceRepo: source.repo,
    autoUpdates: source.autoUpdates,
    serviceInstanceId: String(data.serviceInstance.id),
    serviceId: String(data.serviceInstance.serviceId),
    environmentId: String(data.serviceInstance.environmentId),
    numReplicas: data.serviceInstance.numReplicas as number | null,
    region: data.serviceInstance.region as string | null,
    sourceImage: data.serviceInstance.source.image as string | null,
    sourceRepo: data.serviceInstance.source.repo as string | null,
    latestDeployment,
    activeDeployments: (activeDeployments as ProviderDeployment[]).sort(
      (a, b) => a.id.localeCompare(b.id),
    ),
    deploymentInventory: [...deployments].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    volumeInstances: [...volumes].sort((a, b) => a.id.localeCompare(b.id)),
    stagedPatch,
    patchHistory: [...patchHistory].sort((a, b) => a.id.localeCompare(b.id)),
    baselineDeployment: {
      ...baselineBase,
      sourceImage,
      imageDigest,
      patchId: null,
    },
  };
}

function runtimeIdentityValue(state: ProviderState): unknown {
  return {
    serviceInstanceId: state.serviceInstanceId,
    serviceId: state.serviceId,
    environmentId: state.environmentId,
    numReplicas: state.numReplicas,
    region: state.region,
    latestDeployment: state.latestDeployment,
    activeDeployments: state.activeDeployments,
    deploymentInventory: state.deploymentInventory,
    volumeInstances: state.volumeInstances,
    baselineDeployment: state.baselineDeployment,
  };
}

function runtimeContinuitySha256(state: ProviderState): string {
  const value = stable(runtimeIdentityValue(state));
  if (value === null) throw new Error("provider_invalid");
  return sha256(value);
}

function pinnedRuntimeExact(state: ProviderState): boolean {
  const volumes = state.volumeInstances.filter(
    (item) => item.serviceId === SERVICE_ID,
  );
  return (
    state.serviceInstanceId === SERVICE_INSTANCE_ID &&
    state.serviceId === SERVICE_ID &&
    state.environmentId === PRODUCTION_ENVIRONMENT_ID &&
    state.numReplicas === 1 &&
    state.region === null &&
    state.sourceRepo === null &&
    state.configuredSourceRepo === null &&
    state.latestDeployment.id === DEPLOYMENT_ID &&
    state.latestDeployment.projectId === PROJECT_ID &&
    state.latestDeployment.environmentId === PRODUCTION_ENVIRONMENT_ID &&
    state.latestDeployment.serviceId === SERVICE_ID &&
    state.latestDeployment.status === "SUCCESS" &&
    state.latestDeployment.deploymentStopped === false &&
    state.latestDeployment.snapshotId === SNAPSHOT_ID &&
    state.latestDeployment.instances.length === 1 &&
    state.latestDeployment.instances[0]?.id === RUNNING_INSTANCE_ID &&
    state.latestDeployment.instances[0]?.status === "RUNNING" &&
    state.activeDeployments.length === 1 &&
    state.activeDeployments[0]?.id === DEPLOYMENT_ID &&
    state.activeDeployments[0]?.instances.length === 1 &&
    state.activeDeployments[0]?.instances[0]?.id === RUNNING_INSTANCE_ID &&
    state.deploymentInventory.some((item) => item.id === DEPLOYMENT_ID) &&
    volumes.length === 1 &&
    volumes[0]?.id === VOLUME_INSTANCE_ID &&
    volumes[0]?.volumeId === VOLUME_ID &&
    volumes[0]?.environmentId === PRODUCTION_ENVIRONMENT_ID &&
    volumes[0]?.deletedAt === null &&
    volumes[0]?.isPendingDeletion === false &&
    volumes[0]?.mountPath === "/var/lib/postgresql/data" &&
    state.baselineDeployment.id === DEPLOYMENT_ID &&
    state.baselineDeployment.projectId === PROJECT_ID &&
    state.baselineDeployment.environmentId === PRODUCTION_ENVIRONMENT_ID &&
    state.baselineDeployment.serviceId === SERVICE_ID &&
    state.baselineDeployment.status === "SUCCESS" &&
    state.baselineDeployment.deploymentStopped === false &&
    state.baselineDeployment.snapshotId === SNAPSHOT_ID &&
    state.baselineDeployment.instances.length === 1 &&
    state.baselineDeployment.instances[0]?.id === RUNNING_INSTANCE_ID &&
    state.baselineDeployment.sourceImage === MUTABLE_SOURCE &&
    state.baselineDeployment.imageDigest === IMAGE_DIGEST &&
    state.baselineDeployment.patchId === null
  );
}

function patchEmpty(patch: ProviderPatch): boolean {
  const timestampsExact =
    (patch.createdAt === null && patch.updatedAt === null) ||
    (patch.createdAt !== null &&
      patch.updatedAt !== null &&
      Date.parse(patch.createdAt) <= Date.parse(patch.updatedAt));
  return (
    patch.id === "<empty>" &&
    patch.environmentId === PRODUCTION_ENVIRONMENT_ID &&
    patch.status === "STAGED" &&
    patch.message === null &&
    timestampsExact &&
    patch.appliedAt === null &&
    patch.lastAppliedError === null &&
    Object.keys(patch.patch).length === 0
  );
}

function stagedPatchExact(patch: ProviderPatch): boolean {
  return (
    UUID.test(patch.id) &&
    patch.environmentId === PRODUCTION_ENVIRONMENT_ID &&
    patch.status === "STAGED" &&
    patch.message === null &&
    patch.createdAt !== null &&
    patch.updatedAt !== null &&
    Date.parse(patch.createdAt) <= Date.parse(patch.updatedAt) &&
    patch.appliedAt === null &&
    patch.lastAppliedError === null &&
    stableExact(patch.patch, providerNormalizedPatch())
  );
}

function armedBaselineExact(state: ProviderState): boolean {
  return (
    pinnedRuntimeExact(state) &&
    state.configEtag === BASELINE_CONFIG_ETAG &&
    state.sourceImage === MUTABLE_SOURCE &&
    state.configuredSourceImage === MUTABLE_SOURCE &&
    stableExact(state.autoUpdates, ARMED_AUTO_UPDATES) &&
    patchEmpty(state.stagedPatch)
  );
}

function dismissedBaselineExact(state: ProviderState): boolean {
  return (
    pinnedRuntimeExact(state) &&
    state.sourceImage === MUTABLE_SOURCE &&
    state.configuredSourceImage === MUTABLE_SOURCE &&
    stableExact(state.autoUpdates, DISMISSED_AUTO_UPDATES) &&
    patchEmpty(state.stagedPatch)
  );
}

function dismissedStagedExact(state: ProviderState): boolean {
  return (
    pinnedRuntimeExact(state) &&
    state.sourceImage === MUTABLE_SOURCE &&
    state.configuredSourceImage === MUTABLE_SOURCE &&
    stableExact(state.autoUpdates, DISMISSED_AUTO_UPDATES) &&
    stagedPatchExact(state.stagedPatch)
  );
}

function desiredStateExact(state: ProviderState): boolean {
  return (
    pinnedRuntimeExact(state) &&
    state.sourceImage === IMMUTABLE_SOURCE &&
    state.configuredSourceImage === IMMUTABLE_SOURCE &&
    stableExact(state.autoUpdates, DESIRED_AUTO_UPDATES) &&
    patchEmpty(state.stagedPatch)
  );
}

function boundaryFailsOnly(
  observation: BoundaryObservation,
  falseChecks: readonly BoundaryCheckName[],
): boolean {
  const expected = new Set(falseChecks);
  return (
    observation.code === 1 &&
    BOUNDARY_CHECK_NAMES.every(
      (name) => observation.checks[name] === !expected.has(name),
    )
  );
}

function boundaryPasses(observation: BoundaryObservation): boolean {
  return (
    observation.code === 0 &&
    BOUNDARY_CHECK_NAMES.every((name) => observation.checks[name] === true)
  );
}

function parseStageAcknowledgement(value: unknown): string | null {
  if (
    !exactKeys(value, ["data"]) ||
    !exactKeys(value.data, ["environmentStageChanges"]) ||
    !exactKeys(value.data.environmentStageChanges, [
      "id",
      "environmentId",
      "status",
      "message",
      "createdAt",
      "updatedAt",
      "appliedAt",
      "lastAppliedError",
    ])
  )
    return null;
  const stage = value.data.environmentStageChanges;
  return UUID.test(String(stage.id)) &&
    stage.environmentId === PRODUCTION_ENVIRONMENT_ID &&
    stage.status === "STAGED" &&
    stage.message === null &&
    parseTimestamp(stage.createdAt) !== null &&
    parseTimestamp(stage.updatedAt) !== null &&
    stage.appliedAt === null &&
    stage.lastAppliedError === null
    ? String(stage.id)
    : null;
}

function parsePatchResponse(
  value: unknown,
  expectedPatchId: string,
): { active: ProviderPatch; selected: ProviderPatch } | null {
  if (
    !UUID.test(expectedPatchId) ||
    !exactKeys(value, ["data"]) ||
    !exactKeys(value.data, ["active", "selected"])
  )
    return null;
  const active = parsePatch(value.data.active);
  const selected = parsePatch(value.data.selected);
  return active !== null &&
    selected !== null &&
    selected.id === expectedPatchId &&
    (active.id === expectedPatchId || active.id === "<empty>")
    ? { active, selected }
    : null;
}

function stagedPatchReadbackExact(value: {
  active: ProviderPatch;
  selected: ProviderPatch;
}): boolean {
  return (
    value.active.id === value.selected.id &&
    stagedPatchExact(value.active) &&
    stagedPatchExact(value.selected)
  );
}

function parseDismissAcknowledgement(value: unknown): boolean {
  return (
    exactKeys(value, ["data"]) &&
    exactKeys(value.data, ["serviceInstanceVulnRemediationDismiss"]) &&
    value.data.serviceInstanceVulnRemediationDismiss === true
  );
}

function parseCommitAcknowledgement(value: unknown, patchId: string): boolean {
  return (
    UUID.test(patchId) &&
    exactKeys(value, ["data"]) &&
    exactKeys(value.data, ["environmentPatchCommitStaged"]) &&
    value.data.environmentPatchCommitStaged ===
      `commitChanges/${PRODUCTION_ENVIRONMENT_ID}/${patchId}`
  );
}

function committedHistoryExact(
  state: ProviderState,
  intent: Intent,
): ProviderPatch | null {
  const matches = state.patchHistory.filter(
    (patch) =>
      patch.environmentId === PRODUCTION_ENVIRONMENT_ID &&
      UUID.test(patch.id) &&
      patch.status === "COMMITTED" &&
      patch.message === intent.commitMessage &&
      patch.createdAt !== null &&
      patch.updatedAt !== null &&
      patch.appliedAt !== null &&
      Date.parse(patch.createdAt) <= Date.parse(patch.appliedAt) &&
      Date.parse(patch.appliedAt) <= Date.parse(patch.updatedAt) &&
      patch.lastAppliedError === null &&
      stableExact(patch.patch, providerNormalizedPatch()),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function policyExact(cwd: string): boolean {
  try {
    const policy = fs.readFileSync(path.resolve(cwd, POLICY_PATH));
    const boundary = fs.readFileSync(path.resolve(cwd, BOUNDARY_POLICY_PATH));
    if (
      !SHA256.test(PRODUCTION_POSTGRES_SOURCE_LOCK_POLICY_SHA256) ||
      !SHA256.test(PRODUCTION_POSTGRES_SOURCE_LOCK_BOUNDARY_POLICY_SHA256) ||
      sha256(policy) !== PRODUCTION_POSTGRES_SOURCE_LOCK_POLICY_SHA256 ||
      sha256(boundary) !==
        PRODUCTION_POSTGRES_SOURCE_LOCK_BOUNDARY_POLICY_SHA256
    ) {
      return false;
    }
    const value = JSON.parse(policy.toString("utf8")) as unknown;
    const expected = {
      schemaVersion:
        "pintpath-protected-production-postgres-source-lock-policy/v2",
      policyId: "pintpath-protected-production-postgres-source-lock",
      activationState: "GITHUB_ENVIRONMENT_PROTECTED",
      githubEnvironment: "production-postgres-source-repin",
      requiredGitRef: "refs/heads/main",
      projectId: PROJECT_ID,
      productionEnvironmentId: PRODUCTION_ENVIRONMENT_ID,
      stagingEnvironmentId: STAGING_ENVIRONMENT_ID,
      target: {
        serviceId: SERVICE_ID,
        serviceInstanceId: SERVICE_INSTANCE_ID,
        runningInstanceId: RUNNING_INSTANCE_ID,
        deploymentId: DEPLOYMENT_ID,
        snapshotId: SNAPSHOT_ID,
        volumeInstanceId: VOLUME_INSTANCE_ID,
        volumeId: VOLUME_ID,
        expectedMutableSourceImage: MUTABLE_SOURCE,
        desiredImmutableSourceImage: IMMUTABLE_SOURCE,
        approvedImageDigest: IMAGE_DIGEST,
        baselineConfigEtag: BASELINE_CONFIG_ETAG,
      },
      securityRemediation: {
        cveId: "CVE-2026-15741",
        affectedVersions: "before 17.11",
        fixedVersion: "17.11",
        officialAdvisory:
          "https://www.postgresql.org/support/security/CVE-2026-15741/",
        observedRunningDatabaseVersion: "17.11",
        runtimeObservationMode: "READ_ONLY_SQL_SHOW_SERVER_VERSION",
        approvedDigestMatchesObservedRunningDeployment: true,
        armedNoticeCurrentVersionIsPreRemediationBaseline: "17.10",
        sourceLockMustNotDeploy: true,
      },
      autoUpdates: {
        armed: ARMED_AUTO_UPDATES,
        dismissed: DISMISSED_AUTO_UPDATES,
        desired: DESIRED_AUTO_UPDATES,
      },
      githubAuthorityContract: {
        applyOperation: "production-postgres-source-repin",
        reconcileOperation: "production-postgres-source-repin-reconcile",
        workflowPath: ".github/workflows/repin-production-postgres-source.yml",
        applyRunTitleTemplate:
          "Production Postgres source lock | apply | {candidateSha}",
        reconcileRunTitleTemplate:
          "Production Postgres source lock | reconcile | {candidateSha}",
        jobName: "Lock or reconcile the protected production Postgres source",
        writeStepName:
          "Apply or reconcile the exact production Postgres source lock",
        reviewedPullRequestRequired: true,
        completeRetainedHistoryRequired: true,
        runAttemptOneRequired: true,
        freshApplyHistoryIncludesApplyAndReconcileRuns: true,
        priorSameCandidateRunAllowedOnlyWhenWriterSkipped: true,
        reconcilePriorRunIdRequired: true,
        reconcilePriorIntentCandidateShaRequired: true,
        reconcileSelectedPriorRunMustBeOneAmbiguousApply: true,
        reconcileCrossCandidateDirectSingleParentSuccessorRequired: true,
        reconcileCrossCandidateRecoveryPinnedIncidentOnly: true,
        reconcileSecondMayHaveWrittenRunAllowed: false,
        reconcilePriorRunCompletionRequired: true,
        reconcileSettlementSeconds: 60,
        reconcileGraceHours: 24,
      },
      mutationBoundary: {
        policyPath: BOUNDARY_POLICY_PATH,
        policySha256: PRODUCTION_POSTGRES_SOURCE_LOCK_BOUNDARY_POLICY_SHA256,
        prepareAndApplyAllowedFalseChecks: [
          "sourceImageExact",
          "autoUpdatesDisabledExact",
          "sourceReferenceImmutable",
        ],
        prepareAndApplyAllOtherChecksRequiredTrue: true,
        reconcileObservedStateMustMatchOneDocumentedRecoveryState: true,
        unconditionalPostflightRequired: true,
        canonicalPostflightAllChecksRequiredTrue: true,
      },
      phases: {
        prepare: {
          mode: "READ_ONLY_METADATA_ONLY",
          mutationCredentialAllowed: false,
          armedBaselineRequired: true,
          exactConfigEtagRequired: true,
          durableIntentArtifactRequired: true,
          intentArtifactMustBeUploadedBeforeMutationCredential: true,
        },
        apply: {
          sameRunIntentRequired: true,
          sameRunReviewedAuthorityRequired: true,
          armedBaselineRequiredImmediatelyBeforeWrite: true,
          maximumDismissAttempts: 1,
          maximumStageAttempts: 1,
          maximumCommitAttempts: 1,
        },
        reconcile: {
          priorRunIntentArtifactRequired: true,
          priorRunArtifactIdentityAndDigestRequired: true,
          reviewedAuthorityMustBindExactPriorRun: true,
          priorRunGraceAttestationRequired: true,
          crossCandidatePriorTerminalArtifactRequired: true,
          crossCandidateEntryMustBeDismissedWithEmptyStagedPatch: true,
          crossCandidateConfigEtagPreservedThroughPrecommit: true,
          crossCandidateFinalConfigEtagMustChange: true,
          additionalDismissAllowed: false,
          maximumStageAttempts: 1,
          maximumCommitAttempts: 1,
        },
      },
      crossCandidateRecoveryIncident: CROSS_CANDIDATE_RECOVERY,
      mutationPlan: {
        confirmation: CONFIRMATION,
        requestedPatch: requestedPatch(),
        providerNormalizedPatch: providerNormalizedPatch(),
        dismissOperationName: "serviceInstanceVulnRemediationDismiss",
        dismissMaximumAttempts: 1,
        dismissAcknowledgementRequired: true,
        dismissedStateExactReadbackRequired: true,
        stageOperationName: "environmentStageChanges",
        stageMerge: false,
        stageMaximumAttempts: 1,
        stageAcknowledgementRequired: true,
        selectedAndActivePatchExactReadbackRequired: true,
        commitOperationName: "environmentPatchCommitStaged",
        commitSkipDeploys: true,
        commitMaximumAttempts: 1,
        commitAcknowledgementRequired: true,
        automaticRetriesAllowed: false,
        workflowRerunsAllowed: false,
        rollbackAllowed: false,
        ambiguousOutcomeAction: "SEPARATE_READ_ONLY_RECONCILIATION_NO_RETRY",
      },
      recoveryStateMachine: {
        desiredWithEmptyStagedPatch: "RECONCILED_READ_ONLY",
        dismissedWithExactStagedPatch: "RECONCILED_COMMIT_ONLY",
        dismissedWithEmptyStagedPatch: "RECONCILED_STAGE_AND_COMMIT",
        armedWithEmptyStagedPatch: "NOT_APPLIED_NO_WRITE",
        allOtherStates: "FAIL_CLOSED_NO_WRITE",
        writeRecoveryRequiresAuthorityAndPriorRunGrace: true,
        writeRecoveryMayNotDismissAgain: true,
      },
      runtimeContinuity: {
        exactPinnedIdentitiesRequiredBeforeAndAfter: true,
        completeDeploymentInventoryMustRemainUnchanged: true,
        serviceInstanceReplicaCountMustRemainUnchanged: true,
        serviceInstanceRegionMustRemainUnchanged: true,
        stagingPatchMustRemainEmpty: true,
        productionPatchMustBeEmptyAfterSuccess: true,
        noNewDeploymentAllowed: true,
        noRestartAllowed: true,
        noSnapshotChangeAllowed: true,
        noVolumeInstanceChangeAllowed: true,
        noVolumeChangeAllowed: true,
      },
      externalMutationFreeze: {
        required: true,
        dispatchAttestation: FREEZE_ATTESTATION,
        enforcement: "OPERATIONAL_NOT_PROVIDER_VERIFIED",
        providerCommitSelector: "ENVIRONMENT_ID_ONLY",
        providerStagedCommitPatchIdCasOrLockAvailable: false,
        residualRisk:
          "OUT_OF_BAND_STAGED_PATCH_REPLACEMENT_CAN_COMMIT_BEFORE_POSTFLIGHT_DETECTION",
      },
      evidence: {
        durableIntentRequiredBeforeMutationCredential: true,
        intentArtifactNameTemplate:
          "pintpath-production-postgres-source-lock-intent-{candidateSha}-{applyRunId}",
        terminalEvidenceRequired: true,
        finalReceiptEvidenceRequired: true,
        providerCredentialsAllowedInEvidence: false,
        crossCandidatePriorTerminalArtifactRequired: true,
        crossCandidatePriorTerminalAndReceiptHashesRequired: true,
        secretMaterialAllowed: false,
        secretDerivedCommitmentsAllowed: false,
        rawProviderMetadataAllowed: false,
      },
    };
    return stableExact(value, expected);
  } catch {
    return false;
  }
}

function parseBoundaryOutput(source: string, code: 0 | 1): BoundaryObservation {
  const value = JSON.parse(source) as unknown;
  if (
    !exactKeys(value, [
      "schemaVersion",
      "policy",
      "mode",
      "outcome",
      "checks",
    ]) ||
    value.schemaVersion !== "pintpath-railway-mutation-boundary-readiness/v1" ||
    value.policy !== "pintpath-production-staging-mutation-boundary" ||
    value.mode !== "read-only-boundary"
  ) {
    throw new Error("boundary_invalid");
  }
  const rawChecks = value.checks;
  if (
    !exactKeys(rawChecks, BOUNDARY_CHECK_NAMES) ||
    !BOUNDARY_CHECK_NAMES.every((name) => typeof rawChecks[name] === "boolean")
  ) {
    throw new Error("boundary_invalid");
  }
  const boundaryChecks = rawChecks as unknown as BoundaryChecks;
  const passed = BOUNDARY_CHECK_NAMES.every((name) => boundaryChecks[name]);
  if (
    (code === 0) !== passed ||
    value.outcome !== (passed ? "passed" : "failed")
  ) {
    throw new Error("boundary_invalid");
  }
  return { code, checks: boundaryChecks };
}

async function defaultBoundary(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
): Promise<BoundaryObservation> {
  let output = "";
  const code = await runRailwayMutationBoundaryCheck({
    argv: ["--policy", path.resolve(BOUNDARY_POLICY_PATH)],
    env,
    fetchImpl,
    writeOutput: (source) => {
      output += source;
    },
  });
  return parseBoundaryOutput(output, code);
}

async function queryState(
  dependencies: Dependencies,
  token: string,
): Promise<ProviderState> {
  const state = parseState(
    await providerCall(
      dependencies.fetchImpl,
      token,
      "PintPathProductionPostgresSourceLockState",
      PRODUCTION_POSTGRES_SOURCE_REPIN_STATE_QUERY,
      {
        projectId: PROJECT_ID,
        environmentId: PRODUCTION_ENVIRONMENT_ID,
        serviceId: SERVICE_ID,
        deploymentId: DEPLOYMENT_ID,
      },
    ),
  );
  if (state === null) throw new Error("provider_invalid");
  return state;
}

async function queryPatch(
  dependencies: Dependencies,
  token: string,
  patchId: string,
): Promise<{ active: ProviderPatch; selected: ProviderPatch }> {
  const value = parsePatchResponse(
    await providerCall(
      dependencies.fetchImpl,
      token,
      "PintPathProductionPostgresSourceLockPatch",
      PRODUCTION_POSTGRES_SOURCE_REPIN_PATCH_QUERY,
      { environmentId: PRODUCTION_ENVIRONMENT_ID, patchId },
    ),
    patchId,
  );
  if (value === null) throw new Error("provider_invalid");
  return value;
}

function makeIntent(
  args: Args,
  authority: ReviewedAuthority,
  state: ProviderState,
): Intent {
  const armed = stable(ARMED_AUTO_UPDATES);
  const request = stable(requestedPatch());
  const normalized = stable(providerNormalizedPatch());
  if (armed === null || request === null || normalized === null)
    throw new Error("intent_invalid");
  return {
    schemaVersion: "pintpath-production-postgres-source-lock-intent/v2",
    operation: "production-postgres-source-repin",
    candidateSha: args.candidateSha,
    githubRunId: authority.workflowRunId,
    reviewedAuthoritySha256: authority.sha256,
    reviewedPullRequestNumber: authority.reviewedPullRequestNumber,
    projectId: PROJECT_ID,
    environmentId: PRODUCTION_ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    serviceInstanceId: SERVICE_INSTANCE_ID,
    deploymentId: DEPLOYMENT_ID,
    snapshotId: SNAPSHOT_ID,
    runningInstanceId: RUNNING_INSTANCE_ID,
    volumeInstanceId: VOLUME_INSTANCE_ID,
    volumeId: VOLUME_ID,
    sourceBefore: MUTABLE_SOURCE,
    sourceAfter: IMMUTABLE_SOURCE,
    baselineConfigEtag: state.configEtag,
    runtimeBeforeSha256: runtimeContinuitySha256(state),
    armedAutoUpdatesSha256: sha256(armed),
    requestedPatchSha256: sha256(request),
    providerNormalizedPatchSha256: sha256(normalized),
    commitMessage: `${COMMIT_MESSAGE_PREFIX}${args.candidateSha}:${authority.workflowRunId}`,
    externalMutationFreeze: FREEZE_ATTESTATION,
    retryAllowed: false,
    deploymentAllowed: false,
    secretMaterialIncluded: false,
    rawProviderMetadataIncluded: false,
  };
}

function receipt(
  args: Args | null,
  outcome: Outcome,
  intentSha256: string | null,
  patchId: string | null,
  attempts: { dismiss: number; stage: number; commit: number },
  stateChecks: Checks,
  terminalSha256: string | null,
) {
  return {
    schemaVersion: PROTECTED_PRODUCTION_POSTGRES_SOURCE_REPIN_SCHEMA,
    operation: "production-postgres-source-repin",
    phase: args?.phase ?? null,
    candidateSha: args?.candidateSha ?? null,
    outcome,
    intentSha256,
    patchId,
    attempts,
    totalMutationCalls: attempts.dismiss + attempts.stage + attempts.commit,
    retryAllowed: false,
    deploymentAllowed: false,
    terminalSha256,
    checks: stateChecks,
    secretMaterialIncluded: false,
    providerCredentialsIncluded: false,
    rawProviderMetadataIncluded: false,
  };
}

function finish(
  dependencies: Dependencies,
  args: Args | null,
  outcome: Outcome,
  intentSha256: string | null,
  patchId: string | null,
  attempts: { dismiss: number; stage: number; commit: number },
  stateChecks: Checks,
): 0 | 1 {
  const phase = args?.phase ?? "unknown";
  let terminalSha256: string | null = null;
  if (args !== null && evidenceDirectoryExact(args.evidenceDirectory)) {
    try {
      const terminal = canonical({
        schemaVersion: "pintpath-production-postgres-source-lock-terminal/v2",
        phase,
        receipt: receipt(
          args,
          outcome,
          intentSha256,
          patchId,
          attempts,
          stateChecks,
          null,
        ),
      });
      terminalSha256 = dependencies.writeDurable(
        args.evidenceDirectory,
        `${phase}-terminal.json`,
        terminal,
      );
      stateChecks.terminalEvidenceExact = terminalSha256 === sha256(terminal);
    } catch {
      stateChecks.terminalEvidenceExact = false;
      if (attempts.dismiss + attempts.stage + attempts.commit > 0)
        outcome = "mutation_uncertain";
    }
    try {
      const durableReceipt = canonical(
        receipt(
          args,
          outcome,
          intentSha256,
          patchId,
          attempts,
          { ...stateChecks, receiptEvidenceExact: true },
          terminalSha256,
        ),
      );
      const receiptSha = dependencies.writeDurable(
        args.evidenceDirectory,
        `${phase}-receipt.json`,
        durableReceipt,
      );
      stateChecks.receiptEvidenceExact = receiptSha === sha256(durableReceipt);
    } catch {
      stateChecks.receiptEvidenceExact = false;
      if (attempts.dismiss + attempts.stage + attempts.commit > 0)
        outcome = "mutation_uncertain";
    }
  }
  const finalReceipt = receipt(
    args,
    outcome,
    intentSha256,
    patchId,
    attempts,
    stateChecks,
    terminalSha256,
  );
  dependencies.writeOutput(`${JSON.stringify(finalReceipt)}\n`);
  const success =
    [
      "prepared",
      "applied",
      "applied_reconciled_after_lost_ack",
      "reconciled_read_only",
      "reconciled_commit_only",
      "reconciled_stage_and_commit",
    ].includes(outcome) &&
    stateChecks.terminalEvidenceExact &&
    stateChecks.receiptEvidenceExact;
  return success ? 0 : 1;
}

async function scopeCredentials(
  dependencies: Dependencies,
  phase: Phase,
  productionMetadataToken: string,
  stagingMetadataToken: string,
  mutationToken: string,
): Promise<boolean> {
  const tokens =
    phase === "prepare"
      ? [productionMetadataToken, stagingMetadataToken]
      : [productionMetadataToken, stagingMetadataToken, mutationToken];
  const scopes = await Promise.all(
    tokens.map((token) =>
      providerCall(
        dependencies.fetchImpl,
        token,
        "PintPathProductionPostgresSourceLockScope",
        PRODUCTION_POSTGRES_SOURCE_REPIN_SCOPE_QUERY,
        {},
      ),
    ),
  );
  return (
    tokenScopeExact(scopes[0], PRODUCTION_ENVIRONMENT_ID) &&
    tokenScopeExact(scopes[1], STAGING_ENVIRONMENT_ID) &&
    (phase === "prepare" ||
      tokenScopeExact(scopes[2], PRODUCTION_ENVIRONMENT_ID))
  );
}

async function stageAndCommit(
  dependencies: Dependencies,
  metadataToken: string,
  mutationToken: string,
  intent: Intent,
  baselineRuntimeSha256: string,
  attempts: { dismiss: number; stage: number; commit: number },
  stateChecks: Checks,
  alreadyStaged: ProviderState | null,
  recoveryWriteAllowed: (() => boolean) | null = null,
  requiredConfigEtag: string | null = null,
): Promise<{ patchId: string; commitLostAck: boolean }> {
  let staged = alreadyStaged;
  let acknowledgedPatchId: string | null = null;
  if (staged === null) {
    if (recoveryWriteAllowed !== null && !recoveryWriteAllowed()) {
      throw new Error("prior_grace_invalid");
    }
    stateChecks.boundaryPreflightExact = boundaryFailsOnly(
      await dependencies.runBoundary(),
      SOURCE_LOCK_ALLOWED_FALSE_BOUNDARY_CHECKS,
    );
    if (!stateChecks.boundaryPreflightExact)
      throw new Error("boundary_invalid");
    attempts.stage += 1;
    try {
      acknowledgedPatchId = parseStageAcknowledgement(
        await providerCall(
          dependencies.fetchImpl,
          mutationToken,
          "PintPathProductionPostgresSourceLockStage",
          PRODUCTION_POSTGRES_SOURCE_REPIN_STAGE_MUTATION,
          {
            environmentId: PRODUCTION_ENVIRONMENT_ID,
            input: requestedPatch(),
            merge: false,
          },
        ),
      );
    } catch {
      acknowledgedPatchId = null;
    }
    stateChecks.stageAcknowledgementExact = acknowledgedPatchId !== null;
    staged = await queryState(dependencies, metadataToken);
  }
  if (
    !dismissedStagedExact(staged) ||
    (requiredConfigEtag !== null &&
      staged.configEtag !== requiredConfigEtag) ||
    runtimeContinuitySha256(staged) !== baselineRuntimeSha256
  ) {
    throw new Error("stage_readback_invalid");
  }
  const patchId = acknowledgedPatchId ?? staged.stagedPatch.id;
  if (!UUID.test(patchId) || staged.stagedPatch.id !== patchId) {
    throw new Error("stage_readback_invalid");
  }
  const first = await queryPatch(dependencies, metadataToken, patchId);
  stateChecks.stagedReadbackOneExact = stagedPatchReadbackExact(first);
  if (!stateChecks.stagedReadbackOneExact)
    throw new Error("stage_readback_invalid");

  const boundary = await dependencies.runBoundary();
  const precommit = await queryState(dependencies, metadataToken);
  const second = await queryPatch(dependencies, metadataToken, patchId);
  stateChecks.stagedReadbackTwoExact =
    dismissedStagedExact(precommit) &&
    (requiredConfigEtag === null ||
      precommit.configEtag === requiredConfigEtag) &&
    precommit.stagedPatch.id === patchId &&
    stagedPatchReadbackExact(second);
  stateChecks.precommitRaceAbsent =
    stateChecks.stagedReadbackTwoExact &&
    runtimeContinuitySha256(precommit) === baselineRuntimeSha256 &&
    boundaryFailsOnly(boundary, [
      "productionPatchEmpty",
      "sourceImageExact",
      "autoUpdatesDisabledExact",
      "sourceReferenceImmutable",
    ]);
  if (!stateChecks.precommitRaceAbsent) throw new Error("precommit_race");

  if (recoveryWriteAllowed !== null && !recoveryWriteAllowed()) {
    throw new Error("prior_grace_invalid");
  }
  attempts.commit += 1;
  try {
    stateChecks.commitAcknowledgementExact = parseCommitAcknowledgement(
      await providerCall(
        dependencies.fetchImpl,
        mutationToken,
        "PintPathProductionPostgresSourceLockCommit",
        PRODUCTION_POSTGRES_SOURCE_REPIN_COMMIT_MUTATION,
        {
          environmentId: PRODUCTION_ENVIRONMENT_ID,
          commitMessage: intent.commitMessage,
          skipDeploys: true,
        },
      ),
      patchId,
    );
  } catch {
    stateChecks.commitAcknowledgementExact = false;
  }
  return { patchId, commitLostAck: !stateChecks.commitAcknowledgementExact };
}

async function verifyPostflight(
  dependencies: Dependencies,
  metadataToken: string,
  intent: Intent,
  runtimeSha256: string,
  stateChecks: Checks,
  priorConfigEtag: string | null = null,
): Promise<boolean> {
  const after = await queryState(dependencies, metadataToken);
  stateChecks.desiredStateExact = desiredStateExact(after);
  if (priorConfigEtag !== null && after.configEtag === priorConfigEtag) {
    stateChecks.desiredStateExact = false;
  }
  stateChecks.runtimeContinuityExact =
    runtimeContinuitySha256(after) === runtimeSha256;
  stateChecks.inventoryContinuityExact = stateChecks.runtimeContinuityExact;
  stateChecks.committedHistoryExact =
    committedHistoryExact(after, intent) !== null;
  stateChecks.boundaryPostflightExact = boundaryPasses(
    await dependencies.runBoundary(),
  );
  return (
    stateChecks.desiredStateExact &&
    stateChecks.runtimeContinuityExact &&
    stateChecks.inventoryContinuityExact &&
    stateChecks.committedHistoryExact &&
    stateChecks.boundaryPostflightExact
  );
}

export async function runProtectedProductionPostgresSourceRepin(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const env = overrides.env ?? process.env;
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env,
    cwd: process.cwd(),
    fetchImpl,
    writeDurable: durable,
    writeOutput: (source) => process.stdout.write(source),
    runBoundary: () => defaultBoundary(env, fetchImpl),
    verifyPolicy: policyExact,
    now: Date.now,
    ...overrides,
  };
  const args = parseArgs(dependencies.argv);
  const stateChecks = checks();
  const attempts = { dismiss: 0, stage: 0, commit: 0 };
  let outcome: Outcome = "failed_before_write";
  let intentSha256: string | null = null;
  let patchId: string | null = null;
  const productionMetadataToken =
    dependencies.env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
  const stagingMetadataToken =
    dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
  const mutationToken =
    dependencies.env.PINTPATH_RAILWAY_PRODUCTION_SOURCE_MUTATION_TOKEN ?? "";

  try {
    if (args === null || !evidenceDirectoryExact(args.evidenceDirectory)) {
      throw new Error("arguments_invalid");
    }
    stateChecks.policyExact = dependencies.verifyPolicy(dependencies.cwd);
    const authority = reviewedAuthorityExact(
      args.githubAuthorityFile,
      args,
      dependencies.env,
    );
    stateChecks.authorityExact = commonAuthorityExact(
      args,
      dependencies.env,
      authority,
    );
    stateChecks.credentialsExact =
      TOKEN.test(productionMetadataToken) &&
      TOKEN.test(stagingMetadataToken) &&
      productionMetadataToken !== stagingMetadataToken &&
      (args.phase === "prepare"
        ? mutationToken === ""
        : TOKEN.test(mutationToken) &&
          mutationToken !== productionMetadataToken &&
          mutationToken !== stagingMetadataToken);
    if (
      !stateChecks.policyExact ||
      !stateChecks.authorityExact ||
      !stateChecks.credentialsExact ||
      authority === null
    ) {
      throw new Error("authority_invalid");
    }
    stateChecks.tokenScopesExact = await scopeCredentials(
      dependencies,
      args.phase,
      productionMetadataToken,
      stagingMetadataToken,
      mutationToken,
    );
    if (!stateChecks.tokenScopesExact) throw new Error("token_scope_invalid");

    if (args.phase === "prepare") {
      const boundary = await dependencies.runBoundary();
      const baseline = await queryState(dependencies, productionMetadataToken);
      stateChecks.baselineExact = armedBaselineExact(baseline);
      stateChecks.boundaryPreflightExact = boundaryFailsOnly(
        boundary,
        SOURCE_LOCK_ALLOWED_FALSE_BOUNDARY_CHECKS,
      );
      if (!stateChecks.baselineExact || !stateChecks.boundaryPreflightExact) {
        throw new Error("baseline_invalid");
      }
      const intent = makeIntent(args, authority, baseline);
      const source = canonical(intent);
      intentSha256 = dependencies.writeDurable(
        args.evidenceDirectory,
        PRODUCTION_POSTGRES_SOURCE_LOCK_EVIDENCE_FILES.intent,
        source,
      );
      stateChecks.durableIntentExact = intentSha256 === sha256(source);
      stateChecks.intentExact = stateChecks.durableIntentExact;
      if (!stateChecks.durableIntentExact) throw new Error("intent_invalid");
      outcome = "prepared";
      return finish(
        dependencies,
        args,
        outcome,
        intentSha256,
        null,
        attempts,
        stateChecks,
      );
    }

    const parsedIntent =
      args.intentFile === null ? null : parseIntent(args.intentFile, args);
    stateChecks.intentExact = parsedIntent !== null;
    if (parsedIntent === null) throw new Error("intent_invalid");
    intentSha256 = parsedIntent.sha256;
    stateChecks.artifactBindingExact =
      artifactBindingExact(parsedIntent, args, dependencies.env) &&
      crossCandidateIncidentBindingExact(
        args,
        parsedIntent,
        authority,
        dependencies.env,
      );
    if (!stateChecks.artifactBindingExact) throw new Error("artifact_invalid");
    const intent = parsedIntent.intent;

    const sameRun = intent.githubRunId === dependencies.env.GITHUB_RUN_ID;
    const recoveryAuthority = authority.recovery;
    const priorRunGraceNowExact = (): boolean => {
      const recoveryElapsedMilliseconds =
        recoveryAuthority === null
          ? Number.NaN
          : dependencies.now() -
            Date.parse(recoveryAuthority.originalRunCompletedAt);
      const exact =
        !sameRun &&
        recoveryAuthority !== null &&
        recoveryAuthority.priorRunId === intent.githubRunId &&
        recoveryElapsedMilliseconds >= 60 * 1_000 &&
        recoveryElapsedMilliseconds <= 24 * 60 * 60 * 1_000 &&
        dependencies.env
          .PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_RUN_ID ===
          intent.githubRunId &&
        dependencies.env
          .PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_CANDIDATE_SHA ===
          intent.candidateSha &&
        dependencies.env
          .PINTPATH_PRODUCTION_POSTGRES_SOURCE_LOCK_PRIOR_RUN_GRACE ===
          PRIOR_RUN_GRACE_ATTESTATION;
      stateChecks.priorRunGraceExact = exact;
      return exact;
    };
    priorRunGraceNowExact();
    if (args.phase === "apply") {
      stateChecks.authorityExact =
        stateChecks.authorityExact &&
        sameRun &&
        intent.reviewedAuthoritySha256 === authority.sha256 &&
        intent.reviewedPullRequestNumber ===
          authority.reviewedPullRequestNumber;
      if (!stateChecks.authorityExact)
        throw new Error("intent_authority_invalid");

      const boundary = await dependencies.runBoundary();
      const baseline = await queryState(dependencies, productionMetadataToken);
      const runtimeSha = runtimeContinuitySha256(baseline);
      stateChecks.baselineExact =
        armedBaselineExact(baseline) &&
        baseline.configEtag === intent.baselineConfigEtag &&
        runtimeSha === intent.runtimeBeforeSha256;
      stateChecks.boundaryPreflightExact = boundaryFailsOnly(
        boundary,
        SOURCE_LOCK_ALLOWED_FALSE_BOUNDARY_CHECKS,
      );
      if (!stateChecks.baselineExact || !stateChecks.boundaryPreflightExact) {
        throw new Error("baseline_invalid");
      }

      attempts.dismiss += 1;
      try {
        stateChecks.dismissAcknowledgementExact = parseDismissAcknowledgement(
          await providerCall(
            dependencies.fetchImpl,
            mutationToken,
            "PintPathProductionPostgresSourceLockDismiss",
            PRODUCTION_POSTGRES_SOURCE_REPIN_DISMISS_MUTATION,
            { environmentId: PRODUCTION_ENVIRONMENT_ID, serviceId: SERVICE_ID },
          ),
        );
      } catch {
        stateChecks.dismissAcknowledgementExact = false;
      }
      const dismissed = await queryState(dependencies, productionMetadataToken);
      stateChecks.dismissedReadbackExact =
        dismissedBaselineExact(dismissed) &&
        runtimeContinuitySha256(dismissed) === runtimeSha;
      if (!stateChecks.dismissedReadbackExact)
        throw new Error("dismiss_readback_invalid");

      const result = await stageAndCommit(
        dependencies,
        productionMetadataToken,
        mutationToken,
        intent,
        runtimeSha,
        attempts,
        stateChecks,
        null,
      );
      patchId = result.patchId;
      if (
        !(await verifyPostflight(
          dependencies,
          productionMetadataToken,
          intent,
          runtimeSha,
          stateChecks,
        ))
      )
        throw new Error("postflight_invalid");
      outcome =
        stateChecks.dismissAcknowledgementExact &&
        stateChecks.stageAcknowledgementExact &&
        stateChecks.commitAcknowledgementExact
          ? "applied"
          : "applied_reconciled_after_lost_ack";
    } else {
      const current = await queryState(dependencies, productionMetadataToken);
      const runtimeSha = runtimeContinuitySha256(current);
      const crossCandidateRecovery =
        authority.recovery?.crossCandidateExact === true;
      stateChecks.baselineExact =
        pinnedRuntimeExact(current) &&
        runtimeSha === intent.runtimeBeforeSha256;
      if (!stateChecks.baselineExact) throw new Error("runtime_invalid");

      if (crossCandidateRecovery) {
        stateChecks.baselineExact =
          stateChecks.baselineExact &&
          dismissedBaselineExact(current) &&
          current.configEtag ===
            CROSS_CANDIDATE_RECOVERY.dismissedConfigEtag;
        if (
          !stateChecks.baselineExact ||
          !stateChecks.priorRunGraceExact
        ) {
          throw new Error("cross_candidate_recovery_invalid");
        }
        const result = await stageAndCommit(
          dependencies,
          productionMetadataToken,
          mutationToken,
          intent,
          runtimeSha,
          attempts,
          stateChecks,
          null,
          priorRunGraceNowExact,
          CROSS_CANDIDATE_RECOVERY.dismissedConfigEtag,
        );
        patchId = result.patchId;
        if (
          !(await verifyPostflight(
            dependencies,
            productionMetadataToken,
            intent,
            runtimeSha,
            stateChecks,
            CROSS_CANDIDATE_RECOVERY.dismissedConfigEtag,
          ))
        ) {
          throw new Error("postflight_invalid");
        }
        outcome = "reconciled_stage_and_commit";
      } else if (
        desiredStateExact(current) &&
        committedHistoryExact(current, intent) !== null
      ) {
        stateChecks.desiredStateExact = true;
        stateChecks.runtimeContinuityExact = true;
        stateChecks.inventoryContinuityExact = true;
        stateChecks.committedHistoryExact = true;
        stateChecks.boundaryPostflightExact = boundaryPasses(
          await dependencies.runBoundary(),
        );
        if (!stateChecks.boundaryPostflightExact)
          throw new Error("boundary_invalid");
        outcome = "reconciled_read_only";
      } else if (dismissedStagedExact(current)) {
        if (!stateChecks.priorRunGraceExact)
          throw new Error("prior_grace_invalid");
        const result = await stageAndCommit(
          dependencies,
          productionMetadataToken,
          mutationToken,
          intent,
          runtimeSha,
          attempts,
          stateChecks,
          current,
          priorRunGraceNowExact,
        );
        patchId = result.patchId;
        if (
          !(await verifyPostflight(
            dependencies,
            productionMetadataToken,
            intent,
            runtimeSha,
            stateChecks,
          ))
        )
          throw new Error("postflight_invalid");
        outcome = "reconciled_commit_only";
      } else if (dismissedBaselineExact(current)) {
        if (!stateChecks.priorRunGraceExact)
          throw new Error("prior_grace_invalid");
        const result = await stageAndCommit(
          dependencies,
          productionMetadataToken,
          mutationToken,
          intent,
          runtimeSha,
          attempts,
          stateChecks,
          null,
          priorRunGraceNowExact,
        );
        patchId = result.patchId;
        if (
          !(await verifyPostflight(
            dependencies,
            productionMetadataToken,
            intent,
            runtimeSha,
            stateChecks,
          ))
        )
          throw new Error("postflight_invalid");
        outcome = "reconciled_stage_and_commit";
      } else if (armedBaselineExact(current)) {
        outcome = "not_applied";
      } else {
        throw new Error("reconcile_state_invalid");
      }
    }
  } catch {
    if (attempts.dismiss + attempts.stage + attempts.commit > 0) {
      outcome = "mutation_uncertain";
    } else if (outcome !== "not_applied") {
      outcome = "failed_before_write";
    }
  }

  stateChecks.dismissAttemptedAtMostOnce = attempts.dismiss <= 1;
  stateChecks.stageAttemptedAtMostOnce = attempts.stage <= 1;
  stateChecks.commitAttemptedAtMostOnce = attempts.commit <= 1;
  return finish(
    dependencies,
    args,
    outcome,
    intentSha256,
    patchId,
    attempts,
    stateChecks,
  );
}

export const protectedProductionPostgresSourceRepinInternals = {
  ARMED_AUTO_UPDATES,
  CROSS_CANDIDATE_RECOVERY,
  DISMISSED_AUTO_UPDATES,
  DESIRED_AUTO_UPDATES,
  armedBaselineExact,
  artifactBindingExact,
  boundaryFailsOnly,
  boundaryPasses,
  committedHistoryExact,
  desiredStateExact,
  dismissedBaselineExact,
  dismissedStagedExact,
  parseArgs,
  parseCommitAcknowledgement,
  parseDismissAcknowledgement,
  parseIntent,
  parseConnection,
  parsePatchResponse,
  parseStageAcknowledgement,
  parseState,
  policyExact,
  providerNormalizedPatch,
  requestedPatch,
  runtimeContinuitySha256,
  stagedPatchReadbackExact,
  tokenScopeExact,
  sourceOnlyPatch: requestedPatch,
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedProductionPostgresSourceRepin();
}
