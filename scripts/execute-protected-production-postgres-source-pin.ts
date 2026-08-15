import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectPostgresLogicalBackupSourceIdentity,
} from "../src/lib/postgres-logical-backup.js";
import {
  POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
} from "../src/lib/postgres-railway-stock-localhost-ca.js";
import {
  RAILWAY_PRODUCTION_POSTGRES_PIN_QUERY,
  parseProductionPostgresResponse,
  runRailwayMutationBoundaryCheck,
} from "./check-railway-mutation-boundary.js";
import type { RailwayProductionDeploymentBoundary } from
  "./lib/railway-environment-mutation-guard.js";

export const PRODUCTION_POSTGRES_SOURCE_PIN_STATE =
  "BLOCKED_PENDING_PROVIDER_COMPATIBILITY_PROOF" as const;
export const PRODUCTION_POSTGRES_SOURCE_PIN_RECEIPT_SCHEMA =
  "pintpath-protected-production-postgres-source-pin-receipt/v1" as const;
export const PRODUCTION_POSTGRES_SOURCE_PIN_SCOPE_QUERY =
  `query PintPathProductionPostgresSourcePinScope {
  projectToken { projectId environmentId }
}` as const;
export const PRODUCTION_POSTGRES_SOURCE_PIN_ENVIRONMENT_QUERY =
  `query PintPathProductionPostgresSourcePinEnvironment(
  $projectId: String!
  $environmentId: String!
) {
  environment(id: $environmentId, projectId: $projectId) {
    id
    projectId
    config(decryptVariables: false)
    variables(first: 100) {
      edges { node { id name environmentId serviceId isSealed references } }
      pageInfo { hasNextPage endCursor }
    }
    volumeInstances(first: 100) {
      edges { node { serviceId environmentId volume { id } } }
      pageInfo { hasNextPage endCursor }
    }
    serviceInstances(first: 100) {
      edges {
        node {
          id serviceId serviceName environmentId numReplicas
          source { repo image }
          domains {
            serviceDomains { id domain targetPort }
            customDomains { id domain targetPort }
          }
          cronSchedule startCommand
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
  staged: environmentStagedChanges(environmentId: $environmentId) {
    environmentId
    patch(decryptVariables: false)
  }
  deployments(
    input: {
      projectId: $projectId
      environmentId: $environmentId
    }
    first: 100
  ) {
    edges {
      cursor
      node {
        id projectId environmentId serviceId snapshotId
        createdAt status deploymentStopped meta
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}` as const;
export const PRODUCTION_POSTGRES_SOURCE_PIN_MUTATION =
  `mutation PintPathPinProductionPostgresSource(
  $environmentId: String!
  $patch: EnvironmentConfig!
  $commitMessage: String
) {
  environmentPatchCommit(
    environmentId: $environmentId
    patch: $patch
    commitMessage: $commitMessage
  )
}` as const;

const POLICY_PATH =
  "ops/railway/protected-production-postgres-source-pin-policy.json";
const BOUNDARY_POLICY_PATH =
  "ops/railway/production-staging-mutation-policy.json";
const POLICY_SHA256 =
  "f4655c25d7786c83d30933d31df0ab3ceed75e09b2669a47d3de5e9f74d46c8e";
const BOUNDARY_POLICY_SHA256 =
  "cebed5aebb1e2ada4cd247649eb418fa7d8b77b5c863ed4ecece601f492ac3c8";
const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const PRODUCTION_ENVIRONMENT_ID = "13dab015-df74-45c6-b26f-69323daea99a";
const STAGING_ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "4a2334a1-71e7-4745-970a-2cd95da10169";
const CURRENT_DEPLOYMENT_ID = "c6004774-7680-41ec-a816-d872221d5890";
const CURRENT_SNAPSHOT_ID = "3f601066-8b66-4315-8f2e-ef499d17fad8";
const CURRENT_SOURCE_IMAGE =
  "ghcr.io/railwayapp-templates/postgres-ssl:17.10";
const IMAGE_DIGEST =
  "sha256:786bb8fbbb78ba8d7f8cbef17eb1a2f15d39f118b17017bb12837345c4b16786";
const TARGET_SOURCE_IMAGE = `${CURRENT_SOURCE_IMAGE}@${IMAGE_DIGEST}`;
const CONFIRMATION = "PIN_PRODUCTION_POSTGRES_SOURCE_TO_OBSERVED_DIGEST";
const COMMIT_MESSAGE = "Pin production Postgres source to observed digest";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[^\r\n\0]{16,4096}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface Args {
  readonly candidateSha: string;
  readonly recoveryAuthority: string;
  readonly expectedRecoveryAuthorityFileSha256: string;
  readonly expectedPreparedArtifactId: string;
  readonly expectedPreparedArtifactDigest: string;
  readonly evidenceDir: string;
  readonly databaseUrlFile: string;
  readonly rootCaFile: string;
}

interface SourcePinPolicy {
  readonly activationState: string;
  readonly compatibilityAuthority: Readonly<Record<string, unknown>>;
  readonly databaseIdentityAuthority: Readonly<Record<string, unknown>>;
  readonly durabilityAuthority: Readonly<Record<string, unknown>>;
}

interface RecoveryAuthority {
  readonly authorityFileSha256: string;
  readonly authoritySha256: string;
  readonly sourceDatabaseIdentitySha256: string;
  readonly minimumRetainUntil: string;
  readonly completedAt: string;
  readonly workflowRunId: string;
}

interface PreparedAuthority {
  readonly preparedArtifactId: string;
  readonly preparedArtifactDigest: string;
  readonly recoveryAuthorityFileSha256: string;
}

interface EnvironmentInventory {
  readonly environmentId: string;
  readonly sourceImage: string | null;
  readonly autoUpdatesType: string | null;
  readonly rawSha256: string;
  readonly collateralSha256: string;
  readonly stagedPatchEmpty: boolean;
  readonly deploymentIds: readonly string[];
  readonly deployments: readonly Record<string, unknown>[];
}

interface DatabaseIdentityObservation {
  readonly identitySha256: string;
  readonly inRecovery: false;
}

interface BoundaryAuthority {
  readonly exact: boolean;
  readonly receiptSha256: string | null;
}

interface Checks {
  policyExact: boolean;
  policyActivationExact: boolean;
  compatibilityAuthorityExact: boolean;
  githubAuthorityExact: boolean;
  currentMainExact: boolean;
  confirmationExact: boolean;
  recoveryAuthorityExact: boolean;
  preparedAuthorityExact: boolean;
  preparedArtifactExact: boolean;
  credentialsExact: boolean;
  tokenScopesExact: boolean;
  boundaryRepairOnlyExact: boolean;
  preflightInventoryComplete: boolean;
  preflightTargetExact: boolean;
  preflightAutoUpdatesSafe: boolean;
  preflightDatabaseIdentityExact: boolean;
  adjacentPreflightExact: boolean;
  adjacentDatabaseIdentityExact: boolean;
  postflightDatabaseIdentityExact: boolean;
  databaseIdentityBindingExact: boolean;
  localIntentCustodyExact: boolean;
  writeAttemptedAtMostOnce: boolean;
  acknowledgementOpaqueCaptured: boolean;
  postflightAttempted: boolean;
  sourceTransitionExact: boolean;
  autoUpdatesDisabledExact: boolean;
  deploymentTransitionExact: boolean;
  targetHealthyExact: boolean;
  stagedPatchesEmptyExact: boolean;
  collateralInventoryUnchangedExact: boolean;
  dataRecoveryAuthorityPostflightExact: boolean;
  rebaselineCandidateExact: boolean;
  terminalEvidenceExact: boolean;
}

interface EvidenceCustody {
  readonly write: (leaf: string, source: string) => string;
  readonly close: () => void;
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly openEvidenceCustody: (
    directory: string,
    candidateSha: string,
  ) => EvidenceCustody;
  readonly writeOutput: (source: string) => void;
  readonly runBoundary: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<BoundaryAuthority>;
  readonly verifyCompatibility: (
    cwd: string,
    policy: SourcePinPolicy,
  ) => boolean;
  readonly verifyPolicyActivation: (policy: SourcePinPolicy) => boolean;
  readonly verifyCurrentMain: (
    fetchImpl: typeof fetch,
    token: string,
    candidateSha: string,
  ) => Promise<boolean>;
  readonly verifyPreparedArtifact: (
    fetchImpl: typeof fetch,
    token: string,
    args: Args,
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<boolean>;
  readonly observeDatabaseIdentity: (
    phase: "prewrite" | "postflight",
    input: {
      readonly databaseUrlFile: string;
      readonly rootCaFile: string;
      readonly expectedDatabaseUrlSha256: string;
      readonly expectedRootCaDerSha256: string;
    },
  ) => Promise<DatabaseIdentityObservation | null>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key, index) => Object.keys(value)[index] === key);
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function databaseObservationSha256(
  phase: "prewrite" | "postflight",
  candidateSha: string,
  observation: DatabaseIdentityObservation,
): string {
  return sha256(canonical({
    schemaVersion: "pintpath-production-postgres-source-pin-db-observation/v1",
    phase,
    candidateSha,
    projectId: PROJECT_ID,
    environmentId: PRODUCTION_ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    identitySha256: observation.identitySha256,
    inRecovery: observation.inRecovery,
  }));
}

function parseArgs(argv: readonly string[]): Args | null {
  if (argv.length !== 16) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !key ||
      ![
        "--candidate-sha",
        "--recovery-authority",
        "--expected-recovery-authority-file-sha256",
        "--expected-prepared-artifact-id",
        "--expected-prepared-artifact-digest",
        "--evidence-dir",
        "--database-url-file",
        "--root-ca-file",
      ].includes(key) ||
      !value ||
      values.has(key)
    ) return null;
    values.set(key, value);
  }
  const candidateSha = values.get("--candidate-sha") ?? "";
  const recoveryAuthority = values.get("--recovery-authority") ?? "";
  const expectedRecoveryAuthorityFileSha256 =
    values.get("--expected-recovery-authority-file-sha256") ?? "";
  const expectedPreparedArtifactId =
    values.get("--expected-prepared-artifact-id") ?? "";
  const expectedPreparedArtifactDigest =
    values.get("--expected-prepared-artifact-digest") ?? "";
  const evidenceDir = values.get("--evidence-dir") ?? "";
  const databaseUrlFile = values.get("--database-url-file") ?? "";
  const rootCaFile = values.get("--root-ca-file") ?? "";
  return SHA.test(candidateSha) &&
      path.isAbsolute(recoveryAuthority) &&
      path.resolve(recoveryAuthority) === recoveryAuthority &&
      SHA256.test(expectedRecoveryAuthorityFileSha256) &&
      /^[1-9][0-9]{0,19}$/.test(expectedPreparedArtifactId) &&
      /^sha256:[a-f0-9]{64}$/.test(expectedPreparedArtifactDigest) &&
      path.isAbsolute(evidenceDir) &&
      path.resolve(evidenceDir) === evidenceDir &&
      path.isAbsolute(databaseUrlFile) &&
      path.resolve(databaseUrlFile) === databaseUrlFile &&
      path.isAbsolute(rootCaFile) &&
      path.resolve(rootCaFile) === rootCaFile &&
      !recoveryAuthority.includes("\0") &&
      !evidenceDir.includes("\0") &&
      !databaseUrlFile.includes("\0") &&
      !rootCaFile.includes("\0") &&
      new Set([
        recoveryAuthority,
        evidenceDir,
        databaseUrlFile,
        rootCaFile,
      ]).size === 4
    ? {
        candidateSha,
        recoveryAuthority,
        expectedRecoveryAuthorityFileSha256,
        expectedPreparedArtifactId,
        expectedPreparedArtifactDigest,
        evidenceDir,
        databaseUrlFile,
        rootCaFile,
      }
    : null;
}

function readPolicy(cwd: string): SourcePinPolicy | null {
  try {
    const source = fs.readFileSync(path.resolve(cwd, POLICY_PATH));
    if (sha256(source) !== POLICY_SHA256) return null;
    const value: unknown = JSON.parse(source.toString("utf8"));
    if (
      !exact(value, [
        "schemaVersion",
        "policyId",
        "activationState",
        "githubEnvironment",
        "requiredGitRef",
        "githubAuthority",
        "target",
        "mutationBoundary",
        "recoveryAuthority",
        "databaseIdentityAuthority",
        "durabilityAuthority",
        "compatibilityAuthority",
        "providerContract",
        "inventoryContract",
        "postflightContract",
        "evidence",
      ]) ||
      value.schemaVersion !==
        "pintpath-protected-production-postgres-source-pin-policy/v1" ||
      value.policyId !== "pintpath-production-postgres-immutable-source-pin" ||
      ![
        PRODUCTION_POSTGRES_SOURCE_PIN_STATE,
        "ACTIVE_PINNED_AUTHORITIES",
      ].includes(String(value.activationState)) ||
      value.githubEnvironment !== "production-postgres-source-pin" ||
      value.requiredGitRef !== "refs/heads/main" ||
      !record(value.githubAuthority) ||
      value.githubAuthority.releaseCandidateReceiptSchema !==
        "pintpath-github-release-candidate-receipt/v5" ||
      value.githubAuthority.pullRequestApprovalRequirement !== "not_required" ||
      value.githubAuthority.protectedEnvironmentRequired !== true ||
      value.githubAuthority.protectedEnvironmentApprovalRequirement !==
        "not_required" ||
      value.githubAuthority.priorWriteRunsAllowed !== false ||
      value.githubAuthority.confirmation !== CONFIRMATION ||
      !record(value.target) ||
      value.target.projectId !== PROJECT_ID ||
      value.target.productionEnvironmentId !== PRODUCTION_ENVIRONMENT_ID ||
      value.target.stagingEnvironmentId !== STAGING_ENVIRONMENT_ID ||
      value.target.serviceId !== SERVICE_ID ||
      value.target.currentDeploymentId !== CURRENT_DEPLOYMENT_ID ||
      value.target.currentSnapshotId !== CURRENT_SNAPSHOT_ID ||
      value.target.currentSourceImage !== CURRENT_SOURCE_IMAGE ||
      value.target.imageDigest !== IMAGE_DIGEST ||
      value.target.currentPatchId !== null ||
      value.target.targetSourceImage !== TARGET_SOURCE_IMAGE ||
      !record(value.mutationBoundary) ||
      value.mutationBoundary.policyPath !== BOUNDARY_POLICY_PATH ||
      value.mutationBoundary.policySha256 !== BOUNDARY_POLICY_SHA256 ||
      value.mutationBoundary.onlyAllowedFailedCheck !==
        "sourceReferenceImmutable" ||
      !record(value.databaseIdentityAuthority) ||
      value.databaseIdentityAuthority.state !==
        "ACTIVE_PINNED_READ_ONLY_PRE_POST_INSPECTOR" ||
      value.databaseIdentityAuthority.sourceIdentityContract !==
        "pintpath-postgres-logical-source-database/v1" ||
      value.databaseIdentityAuthority.inspector !==
        "inspectPostgresLogicalBackupSourceIdentity" ||
      !Array.isArray(value.databaseIdentityAuthority.runnerLabels) ||
      canonical(value.databaseIdentityAuthority.runnerLabels) !==
        canonical(["self-hosted", "linux", "x64", "pintpath-production-backup"]) ||
      value.databaseIdentityAuthority.volatileWorkRootOperation !== "recovery" ||
      value.databaseIdentityAuthority.databaseUrlSecretName !==
        "PINTPATH_PRODUCTION_BACKUP_DATABASE_URL" ||
      value.databaseIdentityAuthority.databaseUrlSha256VariableName !==
        "PINTPATH_PRODUCTION_BACKUP_SOURCE_URL_SHA256" ||
      value.databaseIdentityAuthority.rootCaSecretName !==
        "PINTPATH_PRODUCTION_POSTGRES_ROOT_CA_PEM" ||
      value.databaseIdentityAuthority.rootCaDerSha256VariableName !==
        "PINTPATH_PRODUCTION_POSTGRES_ROOT_CA_DER_SHA256" ||
      value.databaseIdentityAuthority.prewriteObservationRequired !== true ||
      value.databaseIdentityAuthority.postflightObservationRequired !== true ||
      value.databaseIdentityAuthority.exactRecoveryIdentityBindingRequired !== true ||
      value.databaseIdentityAuthority.nonRecoveryPrimaryRequired !== true ||
      value.databaseIdentityAuthority.freshTransportPerObservationRequired !== true ||
      value.databaseIdentityAuthority.productionMutationAllowed !== true ||
      !record(value.durabilityAuthority) ||
      value.durabilityAuthority.state !==
        "BLOCKED_PENDING_IMMUTABLE_OFF_RUNNER_INTENT_AND_RECONCILER" ||
      value.durabilityAuthority.schemaVersion !==
        "pintpath-production-postgres-source-pin-durability-authority/v1" ||
      value.durabilityAuthority.immutableOffRunnerPrewriteIntentRequired !== true ||
      value.durabilityAuthority.cancellationIndependentReadOnlyReconcilerRequired !== true ||
      value.durabilityAuthority.automaticRetryAllowed !== false ||
      value.durabilityAuthority.authorityPath !==
        "ops/railway/production-postgres-source-pin-durability-authority.json" ||
      value.durabilityAuthority.authoritySha256 !== null ||
      value.durabilityAuthority.productionMutationAllowed !== false ||
      !record(value.compatibilityAuthority) ||
      !record(value.providerContract) ||
      value.providerContract.graphqlEndpoint !== ENDPOINT ||
      value.providerContract.railwayCliSchemaVersion !== "5.32.0" ||
      value.providerContract.railwayCliSchemaSha256 !==
        "89530486d77ed677586554085d4ff67e8ae6d3c44a6825d67c94320d4a083285" ||
      value.providerContract.mutation !== "environmentPatchCommit" ||
      !Array.isArray(value.providerContract.allowedPatchPaths) ||
      value.providerContract.allowedPatchPaths.length !== 2 ||
      value.providerContract.allowedPatchPaths[0] !==
        "services.<serviceId>.source.image" ||
      value.providerContract.allowedPatchPaths[1] !==
        "services.<serviceId>.source.autoUpdates.type" ||
      value.providerContract.targetAutoUpdatesType !== "disabled" ||
      value.providerContract.maximumAttempts !== 1 ||
      value.providerContract.automaticRetriesAllowed !== false ||
      value.providerContract.rerunsAllowed !== false ||
      value.providerContract.commitMessage !== COMMIT_MESSAGE
    ) return null;
    return {
      activationState: String(value.activationState),
      compatibilityAuthority: value.compatibilityAuthority,
      databaseIdentityAuthority: value.databaseIdentityAuthority,
      durabilityAuthority: value.durabilityAuthority,
    };
  } catch {
    return null;
  }
}

function defaultPolicyActivation(policy: SourcePinPolicy): boolean {
  return policy.activationState === "ACTIVE_PINNED_AUTHORITIES" &&
    policy.compatibilityAuthority.state === "PROVEN_PINNED" &&
    policy.compatibilityAuthority.productionMutationAllowed === true &&
    policy.databaseIdentityAuthority.state ===
      "ACTIVE_PINNED_READ_ONLY_PRE_POST_INSPECTOR" &&
    policy.databaseIdentityAuthority.productionMutationAllowed === true &&
    policy.durabilityAuthority.state === "ACTIVE_PINNED_DURABILITY" &&
    policy.durabilityAuthority.productionMutationAllowed === true;
}

function defaultCompatibility(cwd: string, policy: SourcePinPolicy): boolean {
  const contract = policy.compatibilityAuthority;
  if (
    contract.required !== true ||
    contract.state !== "PROVEN_PINNED" ||
    contract.schemaVersion !==
      "pintpath-railway-postgres-tag-digest-compatibility-authority/v1" ||
    contract.authorityPath !==
      "ops/railway/production-postgres-source-pin-compatibility-authority.json" ||
    typeof contract.authoritySha256 !== "string" ||
    !SHA256.test(contract.authoritySha256) ||
    contract.disposableNoDataCanaryRequired !== true ||
    contract.exactTagDigestPreservationRequired !== true ||
    contract.newDeploymentMetadataExactRequired !== true ||
    contract.newDeploymentPatchIdRequired !== true ||
    contract.environmentPatchCommitAcknowledgementOpaque !== true ||
    contract.productionMutationAllowed !== true
  ) return false;
  try {
    const source = fs.readFileSync(path.resolve(cwd, String(contract.authorityPath)));
    if (sha256(source) !== contract.authoritySha256) return false;
    const value: unknown = JSON.parse(source.toString("utf8"));
    return record(value) &&
      value.schemaVersion === contract.schemaVersion &&
      value.provider === "railway" &&
      value.operation === "environmentPatchCommit" &&
      value.disposableNoDataCanary === true &&
      value.tagDigestPreservedExact === true &&
      value.autoUpdatesDisabledExact === true &&
      value.newDeploymentMetadataExact === true &&
      value.newDeploymentPatchIdExact === true &&
      value.collateralUnchangedExact === true &&
      value.productionMutationAllowed === true;
  } catch {
    return false;
  }
}

async function defaultCurrentMain(
  fetchImpl: typeof fetch,
  token: string,
  candidateSha: string,
): Promise<boolean> {
  if (!TOKEN.test(token) || !SHA.test(candidateSha)) return false;
  try {
    const response = await fetchImpl(
      "https://api.github.com/repos/blackmagic30/Beer/git/ref/heads/main",
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "pintpath-production-postgres-source-pin/1",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      },
    );
    const value: unknown = JSON.parse(await responseBytes(response));
    return record(value) &&
      value.ref === "refs/heads/main" &&
      record(value.object) &&
      value.object.type === "commit" &&
      value.object.sha === candidateSha &&
      value.object.url ===
        `https://api.github.com/repos/blackmagic30/Beer/git/commits/${candidateSha}`;
  } catch {
    return false;
  }
}

async function defaultDatabaseIdentityObservation(
  _phase: "prewrite" | "postflight",
  input: {
    readonly databaseUrlFile: string;
    readonly rootCaFile: string;
    readonly expectedDatabaseUrlSha256: string;
    readonly expectedRootCaDerSha256: string;
  },
): Promise<DatabaseIdentityObservation | null> {
  if (
    !SHA256.test(input.expectedDatabaseUrlSha256) ||
    !SHA256.test(input.expectedRootCaDerSha256)
  ) return null;
  try {
    const observed = await inspectPostgresLogicalBackupSourceIdentity({
      connectionFile: input.databaseUrlFile,
      expectedSourceUrlSha256: input.expectedDatabaseUrlSha256,
      transportProfile: POSTGRES_RAILWAY_STOCK_LOCALHOST_CA_PROFILE,
      rootCaFile: input.rootCaFile,
      expectedRootCaDerSha256: input.expectedRootCaDerSha256,
    });
    return {
      identitySha256: observed.sourceDatabaseIdentitySha256,
      inRecovery: observed.inRecovery,
    };
  } catch {
    return null;
  }
}

function samePrivateFile(
  left: fs.BigIntStats,
  right: fs.BigIntStats,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function canonicalAuthorityPath(filename: string): boolean {
  if (path.resolve(filename) !== filename) return false;
  const resolved = fs.realpathSync(filename);
  return resolved === filename ||
    (process.platform !== "linux" && process.env.VITEST === "true");
}

function privateFile(filename: string, maximumBytes: number): Buffer | null {
  let descriptor: number | null = null;
  let result: Buffer | null = null;
  try {
    const before = fs.lstatSync(filename, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size < 2n ||
      before.size > BigInt(maximumBytes) ||
      Number(before.mode & 0o7777n) !== 0o600 ||
      !canonicalAuthorityPath(filename) ||
      (typeof process.geteuid === "function" &&
        before.uid !== BigInt(process.geteuid()))
    ) return null;
    descriptor = fs.openSync(
      filename,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !samePrivateFile(before, opened)) return null;
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) return null;
      offset += count;
    }
    if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.length) !== 0) {
      return null;
    }
    const afterDescriptor = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(filename, { bigint: true });
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !samePrivateFile(before, afterDescriptor) ||
      !samePrivateFile(before, afterPath) ||
      !canonicalAuthorityPath(filename)
    ) return null;
    result = bytes;
  } catch {
    result = null;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        result = null;
      }
    }
  }
  return result;
}

function readRecoveryAuthority(
  filename: string,
  candidateSha: string,
  now: number,
): RecoveryAuthority | null {
  const bytes = privateFile(filename, 2 * 1024 * 1024);
  if (!bytes) return null;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(source);
    const topKeys = [
      "schemaVersion",
      "repository",
      "candidateSha",
      "workflowPath",
      "workflowRunId",
      "workflowRunAttempt",
      "workflowRunStartedAt",
      "workflowRunCompletedAt",
      "backupArtifact",
      "restoreArtifact",
      "recovery",
      "checks",
      "authoritySha256",
    ] as const;
    const artifactKeys = [
      "id",
      "name",
      "digest",
      "sizeBytes",
      "receiptSetSha256",
    ] as const;
    const recoveryKeys = [
      "backupCreatedAt",
      "completedAt",
      "manifestSha256",
      "archiveSha256",
      "stateReceiptSha256",
      "overallStateSha256",
      "sourceDatabaseIdentitySha256",
      "successStateSha256",
      "wormReceiptSha256",
      "minimumRetainUntil",
      "retrievedAt",
      "restoredAt",
      "restoreReceiptSha256",
      "restoreTargetIdentitySha256",
      "receiptFilesSha256",
    ] as const;
    const checkKeys = [
      "exactCandidateRun",
      "exactBackupArtifact",
      "exactRestoreArtifact",
      "crossCopyBindingsExact",
      "databaseIdentityBound",
      "restoreDrillExact",
      "freshnessExact",
      "wormRetentionExact",
    ] as const;
    if (
      canonical(value) !== source ||
      !exact(value, topKeys) ||
      value.schemaVersion !==
        "pintpath-production-postgres-source-pin-recovery-authority/v1" ||
      value.repository !== "blackmagic30/Beer" ||
      value.candidateSha !== candidateSha ||
      value.workflowPath !== ".github/workflows/production-logical-backup.yml" ||
      typeof value.workflowRunId !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(value.workflowRunId) ||
      value.workflowRunAttempt !== 1 ||
      !exact(value.backupArtifact, artifactKeys) ||
      !exact(value.restoreArtifact, artifactKeys) ||
      !exact(value.recovery, recoveryKeys) ||
      !exact(value.checks, checkKeys) ||
      typeof value.authoritySha256 !== "string" ||
      !SHA256.test(value.authoritySha256)
    ) return null;
    const authorityChecks = value.checks as Record<string, unknown>;
    if (checkKeys.some((key) => authorityChecks[key] !== true)) return null;
    const runId = Number(value.workflowRunId);
    const artifacts = [
      {
        value: value.backupArtifact,
        name: `production-logical-backup-receipts-${value.workflowRunId}-1`,
      },
      {
        value: value.restoreArtifact,
        name: `production-restore-drill-receipts-${value.workflowRunId}-1`,
      },
    ] as const;
    if (
      artifacts.some(({ value: artifact, name }) =>
        !Number.isSafeInteger(artifact.id) ||
        Number(artifact.id) <= 0 ||
        artifact.name !== name ||
        typeof artifact.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
        !Number.isSafeInteger(artifact.sizeBytes) ||
        Number(artifact.sizeBytes) <= 0 ||
        Number(artifact.sizeBytes) > 32 * 1024 * 1024 ||
        typeof artifact.receiptSetSha256 !== "string" ||
        !SHA256.test(artifact.receiptSetSha256) ||
        artifact.receiptSetSha256 !== String(artifact.digest).slice(7)
      ) ||
      value.backupArtifact.id === value.restoreArtifact.id ||
      !Number.isSafeInteger(runId)
    ) return null;
    const recovery = value.recovery;
    const timestampKeys = [
      "backupCreatedAt",
      "completedAt",
      "minimumRetainUntil",
      "retrievedAt",
      "restoredAt",
    ] as const;
    const hashKeys = recoveryKeys.filter((key) => !timestampKeys.includes(
      key as typeof timestampKeys[number],
    ));
    if (
      timestampKeys.some((key) =>
        typeof recovery[key] !== "string" ||
        !Number.isFinite(Date.parse(String(recovery[key]))) ||
        new Date(String(recovery[key])).toISOString() !== recovery[key]
      ) ||
      hashKeys.some((key) =>
        typeof recovery[key] !== "string" || !SHA256.test(String(recovery[key]))
      ) ||
      typeof value.workflowRunStartedAt !== "string" ||
      typeof value.workflowRunCompletedAt !== "string" ||
      !Number.isFinite(Date.parse(value.workflowRunStartedAt)) ||
      !Number.isFinite(Date.parse(value.workflowRunCompletedAt)) ||
      new Date(value.workflowRunStartedAt).toISOString() !==
        value.workflowRunStartedAt ||
      new Date(value.workflowRunCompletedAt).toISOString() !==
        value.workflowRunCompletedAt
    ) return null;
    const { authoritySha256, ...payload } = value;
    if (sha256(canonical(payload)) !== authoritySha256) return null;
    const runStartedAt = Date.parse(value.workflowRunStartedAt);
    const runCompletedAt = Date.parse(value.workflowRunCompletedAt);
    const backupCreatedAt = Date.parse(String(recovery.backupCreatedAt));
    const completedAt = Date.parse(String(recovery.completedAt));
    const retrievedAt = Date.parse(String(recovery.retrievedAt));
    const restoredAt = Date.parse(String(recovery.restoredAt));
    const minimumRetainUntil = Date.parse(String(recovery.minimumRetainUntil));
    if (
      runStartedAt > backupCreatedAt ||
      backupCreatedAt > completedAt ||
      completedAt > retrievedAt ||
      retrievedAt > restoredAt ||
      restoredAt > runCompletedAt ||
      runStartedAt >= runCompletedAt ||
      runCompletedAt > now + 5 * 60_000 ||
      completedAt > now + 5 * 60_000 ||
      now - completedAt > 2 * 60 * 60_000 ||
      minimumRetainUntil - now < 29 * 24 * 60 * 60_000
    ) return null;
    return {
      authorityFileSha256: sha256(bytes),
      authoritySha256,
      sourceDatabaseIdentitySha256: String(recovery.sourceDatabaseIdentitySha256),
      minimumRetainUntil: String(recovery.minimumRetainUntil),
      completedAt: String(recovery.completedAt),
      workflowRunId: value.workflowRunId,
    };
  } catch {
    return null;
  }
}

function readPreparedAuthority(
  args: Args,
  recovery: RecoveryAuthority,
): PreparedAuthority | null {
  try {
    if (
      path.basename(args.recoveryAuthority) !== "recovery-authority.json" ||
      recovery.authorityFileSha256 !==
        args.expectedRecoveryAuthorityFileSha256
    ) return null;
    const directory = path.dirname(args.recoveryAuthority);
    if (
      canonical(fs.readdirSync(directory).sort()) !==
        canonical(["recovery-authority.json"])
    ) {
      return null;
    }
    return {
      preparedArtifactId: args.expectedPreparedArtifactId,
      preparedArtifactDigest: args.expectedPreparedArtifactDigest,
      recoveryAuthorityFileSha256: recovery.authorityFileSha256,
    };
  } catch {
    return null;
  }
}

async function defaultPreparedArtifact(
  fetchImpl: typeof fetch,
  token: string,
  args: Args,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  if (
    !TOKEN.test(token) ||
    !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? "") ||
    env.GITHUB_REPOSITORY !== "blackmagic30/Beer"
  ) return false;
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/blackmagic30/Beer/actions/runs/${env.GITHUB_RUN_ID}/artifacts?per_page=100&page=1`,
      {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "pintpath-production-postgres-source-pin/1",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      },
    );
    const value: unknown = JSON.parse(await responseBytes(response));
    if (!record(value) || value.total_count !== 1 || !Array.isArray(value.artifacts)) {
      return false;
    }
    const artifact = value.artifacts[0];
    return value.artifacts.length === 1 &&
      record(artifact) &&
      String(artifact.id) === args.expectedPreparedArtifactId &&
      artifact.name === `production-postgres-source-pin-prepared-${args.candidateSha}` &&
      artifact.digest === args.expectedPreparedArtifactDigest &&
      artifact.expired === false &&
      record(artifact.workflow_run) &&
      String(artifact.workflow_run.id) === env.GITHUB_RUN_ID &&
      artifact.workflow_run.head_sha === args.candidateSha;
  } catch {
    return false;
  }
}

function sameDirectory(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.isDirectory() && right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode;
}

function heldDirectoryPath(descriptor: number, expected: string): string {
  if (process.platform !== "linux") {
    if (process.env.VITEST === "true") return expected;
    throw new Error("evidence_platform_invalid");
  }
  const target = `/proc/self/fd/${descriptor}`;
  if (fs.realpathSync(target) !== expected) throw new Error("evidence_invalid");
  return target;
}

function openEvidenceCustody(
  directory: string,
  candidateSha: string,
): EvidenceCustody {
  let descriptor: number | null = null;
  let closed = false;
  const expectedEntries = new Set(["dispatch.json"]);
  const heldLeaves = new Map<string, {
    readonly descriptor: number;
    readonly identity: fs.BigIntStats;
    readonly sha256: string;
  }>();
  try {
    const resolved = path.resolve(directory);
    const before = fs.lstatSync(directory, { bigint: true });
    if (
      directory !== resolved ||
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      Number(before.mode & 0o7777n) !== 0o700 ||
      !canonicalAuthorityPath(directory) ||
      (typeof process.geteuid === "function" &&
        before.uid !== BigInt(process.geteuid()))
    ) throw new Error("evidence_invalid");
    descriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY |
        (fs.constants.O_DIRECTORY ?? 0) |
        (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameDirectory(before, opened)) throw new Error("evidence_invalid");
    const heldPath = heldDirectoryPath(descriptor, resolved);
    const assertLeaf = (
      leaf: string,
      authority: {
        readonly descriptor: number;
        readonly identity: fs.BigIntStats;
        readonly sha256: string;
      },
    ) => {
      const target = path.join(heldPath, leaf);
      const descriptorStat = fs.fstatSync(authority.descriptor, { bigint: true });
      const pathStat = fs.lstatSync(target, { bigint: true });
      if (
        pathStat.isSymbolicLink() ||
        !samePrivateFile(authority.identity, descriptorStat) ||
        !samePrivateFile(authority.identity, pathStat) ||
        authority.identity.nlink !== 1n ||
        Number(authority.identity.mode & 0o7777n) !== 0o600 ||
        authority.identity.size > 2n * 1024n * 1024n
      ) throw new Error("evidence_invalid");
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      const size = Number(authority.identity.size);
      while (offset < size) {
        const count = fs.readSync(
          authority.descriptor,
          buffer,
          0,
          Math.min(buffer.length, size - offset),
          offset,
        );
        if (count <= 0) throw new Error("evidence_invalid");
        hash.update(buffer.subarray(0, count));
        offset += count;
      }
      if (
        hash.digest("hex") !== authority.sha256 ||
        !samePrivateFile(
          authority.identity,
          fs.fstatSync(authority.descriptor, { bigint: true }),
        ) ||
        !samePrivateFile(
          authority.identity,
          fs.lstatSync(target, { bigint: true }),
        )
      ) throw new Error("evidence_invalid");
    };
    const assertExact = () => {
      if (closed || descriptor === null) throw new Error("evidence_invalid");
      const pathStat = fs.lstatSync(directory, { bigint: true });
      const heldStat = fs.fstatSync(descriptor, { bigint: true });
      if (
        pathStat.isSymbolicLink() ||
        !sameDirectory(before, pathStat) ||
        !sameDirectory(before, heldStat) ||
        !canonicalAuthorityPath(directory) ||
        (process.platform === "linux" &&
          fs.realpathSync(heldPath) !== resolved)
      ) throw new Error("evidence_invalid");
      const entries = fs.readdirSync(heldPath).sort();
      const expected = [...expectedEntries].sort();
      if (canonical(entries) !== canonical(expected)) {
        throw new Error("evidence_invalid");
      }
      for (const [leaf, authority] of heldLeaves) {
        assertLeaf(leaf, authority);
      }
    };
    assertExact();
    const dispatchPath = path.join(heldPath, "dispatch.json");
    const dispatchDescriptor = fs.openSync(
      dispatchPath,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0),
    );
    let dispatchBytes: Buffer;
    const openedDispatch = fs.fstatSync(dispatchDescriptor, { bigint: true });
    const pathDispatch = fs.lstatSync(dispatchPath, { bigint: true });
    if (
      !openedDispatch.isFile() ||
      pathDispatch.isSymbolicLink() ||
      !samePrivateFile(openedDispatch, pathDispatch) ||
      openedDispatch.nlink !== 1n ||
      Number(openedDispatch.mode & 0o7777n) !== 0o600 ||
      openedDispatch.size < 2n ||
      openedDispatch.size > 64n * 1024n
    ) throw new Error("evidence_invalid");
    dispatchBytes = fs.readFileSync(dispatchDescriptor);
    heldLeaves.set("dispatch.json", {
      descriptor: dispatchDescriptor,
      identity: openedDispatch,
      sha256: sha256(dispatchBytes),
    });
    assertLeaf("dispatch.json", heldLeaves.get("dispatch.json")!);
    const dispatchSource = new TextDecoder("utf-8", { fatal: true })
      .decode(dispatchBytes!);
    const dispatch: unknown = JSON.parse(dispatchSource);
    if (
      canonical(dispatch) !== dispatchSource ||
      !exact(dispatch, [
        "schemaVersion",
        "candidateSha",
        "secretMaterialIncluded",
      ]) ||
      dispatch.schemaVersion !==
        "pintpath-production-postgres-source-pin-dispatch/v1" ||
      dispatch.candidateSha !== candidateSha ||
      dispatch.secretMaterialIncluded !== false
    ) throw new Error("evidence_invalid");
    assertExact();
    return {
      write: (leaf, source) => {
        if (
          !["intent.json", "rebaseline-candidate.json", "terminal.json"]
            .includes(leaf) ||
          expectedEntries.has(leaf) ||
          Buffer.byteLength(source) > 2 * 1024 * 1024
        ) throw new Error("evidence_invalid");
        assertExact();
        const target = path.join(heldPath, leaf);
        const handle = fs.openSync(
          target,
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_RDWR |
            (fs.constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        expectedEntries.add(leaf);
        try {
          fs.writeFileSync(handle, source);
          fs.fsyncSync(handle);
          const openedLeaf = fs.fstatSync(handle, { bigint: true });
          const pathLeaf = fs.lstatSync(target, { bigint: true });
          if (
            !openedLeaf.isFile() ||
            pathLeaf.isSymbolicLink() ||
            !samePrivateFile(openedLeaf, pathLeaf) ||
            Number(openedLeaf.mode & 0o7777n) !== 0o600 ||
            openedLeaf.nlink !== 1n
          ) throw new Error("evidence_invalid");
          heldLeaves.set(leaf, {
            descriptor: handle,
            identity: openedLeaf,
            sha256: sha256(source),
          });
        } catch (error) {
          try {
            fs.closeSync(handle);
          } catch {
            throw new Error("evidence_cleanup_failed", { cause: error });
          }
          throw error;
        }
        if (descriptor === null) throw new Error("evidence_invalid");
        fs.fsyncSync(descriptor);
        assertExact();
        return sha256(source);
      },
      close: () => {
        if (closed || descriptor === null) throw new Error("evidence_invalid");
        let failure: unknown = null;
        try {
          assertExact();
          fs.fsyncSync(descriptor);
        } catch (error) {
          failure = error;
        }
        for (const authority of heldLeaves.values()) {
          try {
            fs.closeSync(authority.descriptor);
          } catch (error) {
            failure ??= error;
          }
        }
        heldLeaves.clear();
        const held = descriptor;
        try {
          fs.closeSync(held);
        } catch (error) {
          failure ??= error;
        }
        closed = true;
        descriptor = null;
        if (failure !== null) throw new Error("evidence_cleanup_failed");
      },
    };
  } catch (error) {
    let cleanupFailure: unknown = null;
    for (const authority of heldLeaves.values()) {
      try {
        fs.closeSync(authority.descriptor);
      } catch (closeError) {
        cleanupFailure ??= closeError;
      }
    }
    heldLeaves.clear();
    if (descriptor !== null && !closed) {
      try {
        fs.closeSync(descriptor);
      } catch (closeError) {
        cleanupFailure ??= closeError;
      }
    }
    if (cleanupFailure !== null) {
      throw new Error("evidence_cleanup_failed", { cause: error });
    }
    throw error;
  }
}

async function responseBytes(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new Error("provider_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("provider_invalid");
    }
    chunks.push(next.value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw new Error("provider_invalid");
  }
}

async function call(
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
    signal: AbortSignal.timeout(20_000),
  });
  try {
    return JSON.parse(await responseBytes(response)) as unknown;
  } catch {
    throw new Error("provider_invalid");
  }
}

function tokenScope(value: unknown, environmentId: string): boolean {
  return exact(value, ["data"]) &&
    exact(value.data, ["projectToken"]) &&
    exact(value.data.projectToken, ["projectId", "environmentId"]) &&
    value.data.projectToken.projectId === PROJECT_ID &&
    value.data.projectToken.environmentId === environmentId;
}

function connectionNodes(value: unknown): readonly Record<string, unknown>[] | null {
  if (
    !exact(value, ["edges", "pageInfo"]) ||
    !Array.isArray(value.edges) ||
    value.edges.length > 100 ||
    !exact(value.pageInfo, ["hasNextPage", "endCursor"]) ||
    value.pageInfo.hasNextPage !== false ||
    !(value.pageInfo.endCursor === null ||
      typeof value.pageInfo.endCursor === "string")
  ) return null;
  const nodes: Record<string, unknown>[] = [];
  for (const edge of value.edges) {
    if (!exact(edge, ["node"]) || !record(edge.node)) return null;
    nodes.push(edge.node);
  }
  return nodes.sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

function normalizeCollateral(
  snapshot: Record<string, unknown>,
  targetServiceId: string,
): Record<string, unknown> | null {
  try {
    const cloned = structuredClone(snapshot);
    if (!record(cloned.config) || !record(cloned.config.services)) return null;
    const configured = cloned.config.services[targetServiceId];
    if (!record(configured) || !record(configured.source)) return null;
    configured.source.image = "<AUTHORIZED_SOURCE_IMAGE_TRANSITION>";
    if (
      configured.source.autoUpdates === null ||
      configured.source.autoUpdates === undefined
    ) {
      configured.source.autoUpdates = {
        type: "<AUTHORIZED_AUTO_UPDATES_TRANSITION>",
      };
    } else {
      if (!record(configured.source.autoUpdates)) return null;
      configured.source.autoUpdates.type =
        "<AUTHORIZED_AUTO_UPDATES_TRANSITION>";
    }
    if (!Array.isArray(cloned.serviceInstances)) return null;
    let targetCount = 0;
    for (const instance of cloned.serviceInstances) {
      if (!record(instance) || instance.serviceId !== targetServiceId) continue;
      targetCount += 1;
      if (!record(instance.source)) return null;
      instance.source.image = "<AUTHORIZED_SOURCE_IMAGE_TRANSITION>";
    }
    return targetCount === 1 ? cloned : null;
  } catch {
    return null;
  }
}

function deploymentCollateralExact(
  before: EnvironmentInventory,
  after: EnvironmentInventory,
  newDeploymentId: string,
): boolean {
  const normalize = (
    deployments: readonly Record<string, unknown>[],
    removeNew: boolean,
  ): string | null => {
    const normalized: Record<string, unknown>[] = [];
    for (const original of deployments) {
      if (removeNew && original.id === newDeploymentId) continue;
      const deployment = structuredClone(original);
      if (
        deployment.id === CURRENT_DEPLOYMENT_ID &&
        deployment.serviceId === SERVICE_ID
      ) {
        const validCurrentState =
          (deployment.status === "SUCCESS" &&
            deployment.deploymentStopped === false) ||
          (deployment.status === "REMOVED" &&
            deployment.deploymentStopped === true);
        if (!validCurrentState) return null;
        deployment.status = "<AUTHORIZED_CURRENT_DEPLOYMENT_STATUS>";
        deployment.deploymentStopped =
          "<AUTHORIZED_CURRENT_DEPLOYMENT_STOPPED>";
      }
      normalized.push(deployment);
    }
    normalized.sort((left, right) =>
      String(left.id).localeCompare(String(right.id))
    );
    return sha256(canonical(normalized));
  };
  const newDeployment = after.deployments.filter(
    (deployment) => deployment.id === newDeploymentId,
  );
  return newDeployment.length === 1 &&
    newDeployment[0]?.serviceId === SERVICE_ID &&
    newDeployment[0]?.environmentId === PRODUCTION_ENVIRONMENT_ID &&
    newDeployment[0]?.projectId === PROJECT_ID &&
    newDeployment[0]?.status === "SUCCESS" &&
    newDeployment[0]?.deploymentStopped === false &&
    normalize(before.deployments, false) !== null &&
    normalize(before.deployments, false) === normalize(after.deployments, true);
}

function parseEnvironmentInventory(
  value: unknown,
  expectedEnvironmentId: string,
  targetServiceId: string,
): EnvironmentInventory | null {
  if (
    !exact(value, ["data"]) ||
    !exact(value.data, ["environment", "staged", "deployments"]) ||
    !exact(value.data.environment, [
      "id",
      "projectId",
      "config",
      "variables",
      "volumeInstances",
      "serviceInstances",
    ]) ||
    value.data.environment.id !== expectedEnvironmentId ||
    value.data.environment.projectId !== PROJECT_ID ||
    !record(value.data.environment.config) ||
    !exact(value.data.staged, ["environmentId", "patch"]) ||
    value.data.staged.environmentId !== expectedEnvironmentId ||
    !record(value.data.staged.patch)
  ) return null;
  const variables = connectionNodes(value.data.environment.variables);
  const volumes = connectionNodes(value.data.environment.volumeInstances);
  const services = connectionNodes(value.data.environment.serviceInstances);
  if (variables === null || volumes === null || services === null) return null;
  if (
    !exact(value.data.deployments, ["edges", "pageInfo"]) ||
    !Array.isArray(value.data.deployments.edges) ||
    value.data.deployments.edges.length > 100 ||
    !exact(value.data.deployments.pageInfo, ["hasNextPage", "endCursor"]) ||
    value.data.deployments.pageInfo.hasNextPage !== false
  ) return null;
  const deployments: Record<string, unknown>[] = [];
  const deploymentIds: string[] = [];
  for (const edge of value.data.deployments.edges) {
    if (
      !exact(edge, ["cursor", "node"]) ||
      typeof edge.cursor !== "string" ||
      !exact(edge.node, [
        "id",
        "projectId",
        "environmentId",
        "serviceId",
        "snapshotId",
        "createdAt",
        "status",
        "deploymentStopped",
        "meta",
      ]) ||
      !UUID.test(String(edge.node.id)) ||
      edge.node.projectId !== PROJECT_ID ||
      edge.node.environmentId !== expectedEnvironmentId ||
      !UUID.test(String(edge.node.serviceId)) ||
      !UUID.test(String(edge.node.snapshotId)) ||
      typeof edge.node.createdAt !== "string" ||
      !Number.isFinite(Date.parse(edge.node.createdAt)) ||
      typeof edge.node.status !== "string" ||
      edge.node.status.length < 1 ||
      edge.node.status.length > 64 ||
      typeof edge.node.deploymentStopped !== "boolean" ||
      !record(edge.node.meta) ||
      deploymentIds.includes(String(edge.node.id))
    ) return null;
    deploymentIds.push(String(edge.node.id));
    deployments.push(edge.node);
  }
  deployments.sort((left, right) => canonical(left).localeCompare(canonical(right)));
  deploymentIds.sort();
  const config = value.data.environment.config;
  if (!record(config.services)) return null;
  const configured = config.services[targetServiceId];
  let sourceImage: string | null = null;
  let autoUpdatesType: string | null = null;
  if (expectedEnvironmentId === PRODUCTION_ENVIRONMENT_ID) {
    if (!record(configured) || !record(configured.source)) return null;
    sourceImage = typeof configured.source.image === "string"
      ? configured.source.image
      : null;
    if (configured.source.autoUpdates !== null &&
      configured.source.autoUpdates !== undefined) {
      if (!exact(configured.source.autoUpdates, ["type"]) ||
        typeof configured.source.autoUpdates.type !== "string") return null;
      autoUpdatesType = configured.source.autoUpdates.type;
    }
  }
  const snapshot: Record<string, unknown> = {
    environmentId: expectedEnvironmentId,
    config,
    variables,
    volumeInstances: volumes,
    serviceInstances: services,
    stagedPatch: value.data.staged.patch,
    deployments,
  };
  const collateralBase = { ...snapshot };
  if (expectedEnvironmentId === PRODUCTION_ENVIRONMENT_ID) {
    delete collateralBase.deployments;
  }
  const collateral = expectedEnvironmentId === PRODUCTION_ENVIRONMENT_ID
    ? normalizeCollateral(collateralBase, targetServiceId)
    : collateralBase;
  if (collateral === null) return null;
  return {
    environmentId: expectedEnvironmentId,
    sourceImage,
    autoUpdatesType,
    rawSha256: sha256(canonical(snapshot)),
    collateralSha256: sha256(canonical(collateral)),
    stagedPatchEmpty: Object.keys(value.data.staged.patch).length === 0,
    deploymentIds,
    deployments,
  };
}

function targetPreflightExact(value: RailwayProductionDeploymentBoundary): boolean {
  return value.environmentId === PRODUCTION_ENVIRONMENT_ID &&
    value.serviceId === SERVICE_ID &&
    value.sourceRepo === null &&
    value.sourceImage === CURRENT_SOURCE_IMAGE &&
    value.latestDeployment?.id === CURRENT_DEPLOYMENT_ID &&
    value.latestDeployment.snapshotId === CURRENT_SNAPSHOT_ID &&
    value.latestDeployment.status === "SUCCESS" &&
    value.latestDeployment.deploymentStopped === false &&
    value.activeDeployments.length === 1 &&
    value.activeDeployments[0]?.id === CURRENT_DEPLOYMENT_ID &&
    value.activeDeployments[0]?.status === "SUCCESS" &&
    value.activeDeployments[0]?.deploymentStopped === false &&
    value.approvedDeployment?.id === CURRENT_DEPLOYMENT_ID &&
    value.approvedDeployment.imageDigest === IMAGE_DIGEST &&
    value.approvedDeployment.patchId === null;
}

function targetPostflightExact(value: RailwayProductionDeploymentBoundary): boolean {
  const latest = value.latestDeployment;
  const deployed = value.approvedDeployment;
  return value.environmentId === PRODUCTION_ENVIRONMENT_ID &&
    value.serviceId === SERVICE_ID &&
    value.sourceRepo === null &&
    value.sourceImage === TARGET_SOURCE_IMAGE &&
    latest !== null &&
    latest.id !== CURRENT_DEPLOYMENT_ID &&
    latest.status === "SUCCESS" &&
    latest.deploymentStopped === false &&
    UUID.test(latest.snapshotId) &&
    latest.snapshotId !== CURRENT_SNAPSHOT_ID &&
    value.activeDeployments.length === 1 &&
    value.activeDeployments[0]?.id === latest.id &&
    value.activeDeployments[0]?.status === "SUCCESS" &&
    value.activeDeployments[0]?.deploymentStopped === false &&
    deployed?.id === latest.id &&
    deployed.projectId === PROJECT_ID &&
    deployed.environmentId === PRODUCTION_ENVIRONMENT_ID &&
    deployed.serviceId === SERVICE_ID &&
    deployed.snapshotId === latest.snapshotId &&
    deployed.sourceImage === TARGET_SOURCE_IMAGE &&
    deployed.imageDigest === IMAGE_DIGEST &&
    deployed.patchId !== null &&
    UUID.test(deployed.patchId);
}

function parsePostgres(value: unknown): RailwayProductionDeploymentBoundary | null {
  try {
    return parseProductionPostgresResponse(JSON.stringify(value));
  } catch {
    return null;
  }
}

async function defaultBoundary(
  env: Readonly<Record<string, string | undefined>>,
): Promise<BoundaryAuthority> {
  let output = "";
  const code = await runRailwayMutationBoundaryCheck({
    argv: ["--policy", BOUNDARY_POLICY_PATH],
    env,
    writeOutput: (source) => {
      output += source;
    },
  });
  try {
    const receipt: unknown = JSON.parse(output);
    if (
      code !== 1 ||
      !exact(receipt, ["schemaVersion", "policy", "mode", "outcome", "checks"]) ||
      receipt.schemaVersion !== "pintpath-railway-mutation-boundary-readiness/v1" ||
      receipt.policy !== "pintpath-production-staging-mutation-boundary" ||
      receipt.mode !== "read-only-boundary" ||
      receipt.outcome !== "failed" ||
      !record(receipt.checks)
    ) return { exact: false, receiptSha256: null };
    const failed = Object.entries(receipt.checks)
      .filter(([, value]) => value !== true)
      .map(([name]) => name);
    return {
      exact: failed.length === 1 && failed[0] === "sourceReferenceImmutable" &&
        receipt.checks.sourceReferenceImmutable === false,
      receiptSha256: sha256(output),
    };
  } catch {
    return { exact: false, receiptSha256: null };
  }
}

function emptyChecks(): Checks {
  return {
    policyExact: false,
    policyActivationExact: false,
    compatibilityAuthorityExact: false,
    githubAuthorityExact: false,
    currentMainExact: false,
    confirmationExact: false,
    recoveryAuthorityExact: false,
    preparedAuthorityExact: false,
    preparedArtifactExact: false,
    credentialsExact: false,
    tokenScopesExact: false,
    boundaryRepairOnlyExact: false,
    preflightInventoryComplete: false,
    preflightTargetExact: false,
    preflightAutoUpdatesSafe: false,
    preflightDatabaseIdentityExact: false,
    adjacentPreflightExact: false,
    adjacentDatabaseIdentityExact: false,
    postflightDatabaseIdentityExact: false,
    databaseIdentityBindingExact: false,
    localIntentCustodyExact: false,
    writeAttemptedAtMostOnce: true,
    acknowledgementOpaqueCaptured: false,
    postflightAttempted: false,
    sourceTransitionExact: false,
    autoUpdatesDisabledExact: false,
    deploymentTransitionExact: false,
    targetHealthyExact: false,
    stagedPatchesEmptyExact: false,
    collateralInventoryUnchangedExact: false,
    dataRecoveryAuthorityPostflightExact: false,
    rebaselineCandidateExact: false,
    terminalEvidenceExact: false,
  };
}

function receipt(input: {
  readonly args: Args | null;
  readonly outcome:
    | "blocked"
    | "failed_before_attempt"
    | "pinned"
    | "pinned_reconciled_after_lost_ack"
    | "mutation_uncertain";
  readonly attempts: 0 | 1;
  readonly recovery: RecoveryAuthority | null;
  readonly prepared: PreparedAuthority | null;
  readonly boundaryReceiptSha256: string | null;
  readonly preflightInventorySha256: string | null;
  readonly postflightInventorySha256: string | null;
  readonly preDatabaseObservationSha256: string | null;
  readonly postDatabaseObservationSha256: string | null;
  readonly newDeploymentId: string | null;
  readonly newSnapshotId: string | null;
  readonly newPatchId: string | null;
  readonly intentSha256: string | null;
  readonly acknowledgementSha256: string | null;
  readonly rebaselineCandidateSha256: string | null;
  readonly terminalEvidenceSha256: string | null;
  readonly checks: Checks;
}) {
  return {
    schemaVersion: PRODUCTION_POSTGRES_SOURCE_PIN_RECEIPT_SCHEMA,
    executorState: PRODUCTION_POSTGRES_SOURCE_PIN_STATE,
    operation: "environmentPatchCommit",
    outcome: input.outcome,
    attempts: input.attempts,
    retryAllowed: false,
    candidateSha: input.args?.candidateSha ?? null,
    policySha256: POLICY_SHA256,
    projectId: PROJECT_ID,
    productionEnvironmentId: PRODUCTION_ENVIRONMENT_ID,
    stagingEnvironmentId: STAGING_ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    currentAuthority: {
      deploymentId: CURRENT_DEPLOYMENT_ID,
      snapshotId: CURRENT_SNAPSHOT_ID,
      sourceImage: CURRENT_SOURCE_IMAGE,
      imageDigest: IMAGE_DIGEST,
      patchId: null,
    },
    targetAuthority: {
      sourceImage: TARGET_SOURCE_IMAGE,
      imageDigest: IMAGE_DIGEST,
      autoUpdatesType: "disabled",
    },
    recoveryAuthority: input.recovery === null
      ? null
      : {
          authorityFileSha256: input.recovery.authorityFileSha256,
          authoritySha256: input.recovery.authoritySha256,
          workflowRunId: input.recovery.workflowRunId,
          sourceDatabaseIdentitySha256:
            input.recovery.sourceDatabaseIdentitySha256,
          completedAt: input.recovery.completedAt,
          minimumRetainUntil: input.recovery.minimumRetainUntil,
        },
    preparedAuthority: input.prepared === null
      ? null
      : {
          preparedArtifactId: input.prepared.preparedArtifactId,
          preparedArtifactDigest: input.prepared.preparedArtifactDigest,
          recoveryAuthorityFileSha256:
            input.prepared.recoveryAuthorityFileSha256,
        },
    boundaryReceiptSha256: input.boundaryReceiptSha256,
    preflightInventorySha256: input.preflightInventorySha256,
    postflightInventorySha256: input.postflightInventorySha256,
    preDatabaseObservationSha256: input.preDatabaseObservationSha256,
    postDatabaseObservationSha256: input.postDatabaseObservationSha256,
    newDeploymentId: input.newDeploymentId,
    newSnapshotId: input.newSnapshotId,
    newPatchId: input.newPatchId,
    intentSha256: input.intentSha256,
    acknowledgementSha256: input.acknowledgementSha256,
    rebaselineCandidateSha256: input.rebaselineCandidateSha256,
    terminalEvidenceSha256: input.terminalEvidenceSha256,
    checks: input.checks,
  };
}

export async function runProtectedProductionPostgresSourcePin(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    now: () => Date.now(),
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    openEvidenceCustody,
    writeOutput: (source) => process.stdout.write(source),
    runBoundary: defaultBoundary,
    verifyCompatibility: defaultCompatibility,
    verifyPolicyActivation: defaultPolicyActivation,
    verifyCurrentMain: defaultCurrentMain,
    verifyPreparedArtifact: defaultPreparedArtifact,
    observeDatabaseIdentity: defaultDatabaseIdentityObservation,
    ...overrides,
  };
  const args = parseArgs(dependencies.argv);
  const checks = emptyChecks();
  let outcome: ReturnType<typeof receipt>["outcome"] = "blocked";
  let attempts: 0 | 1 = 0;
  let recovery: RecoveryAuthority | null = null;
  let prepared: PreparedAuthority | null = null;
  let evidenceCustody: EvidenceCustody | null = null;
  let boundaryReceiptSha256: string | null = null;
  let preflightInventorySha256: string | null = null;
  let postflightInventorySha256: string | null = null;
  let preDatabaseObservationSha256: string | null = null;
  let postDatabaseObservationSha256: string | null = null;
  let newDeploymentId: string | null = null;
  let newSnapshotId: string | null = null;
  let newPatchId: string | null = null;
  let intentSha256: string | null = null;
  let acknowledgementSha256: string | null = null;
  let rebaselineCandidateSha256: string | null = null;
  let terminalEvidenceSha256: string | null = null;
  let productionMetadataToken = "";
  let expectedDatabaseUrlSha256 = "";
  let expectedRootCaDerSha256 = "";
  let preProduction: EnvironmentInventory | null = null;
  let preStaging: EnvironmentInventory | null = null;
  let prePostgres: RailwayProductionDeploymentBoundary | null = null;
  let preDatabaseIdentity: DatabaseIdentityObservation | null = null;
  try {
    const policy = readPolicy(dependencies.cwd);
    checks.policyExact = policy !== null;
    checks.githubAuthorityExact = args !== null &&
      dependencies.env.GITHUB_ACTIONS === "true" &&
      dependencies.env.GITHUB_REPOSITORY === "blackmagic30/Beer" &&
      dependencies.env.GITHUB_REF === "refs/heads/main" &&
      dependencies.env.GITHUB_SHA === args.candidateSha &&
      /^[1-9][0-9]{0,19}$/.test(dependencies.env.GITHUB_RUN_ID ?? "") &&
      dependencies.env.GITHUB_RUN_ATTEMPT === "1";
    checks.confirmationExact =
      dependencies.env.PINTPATH_PRODUCTION_POSTGRES_SOURCE_PIN_CONFIRMATION ===
        CONFIRMATION;
    if (!args || !policy || !checks.githubAuthorityExact ||
      !checks.confirmationExact) throw new Error("authority_invalid");
    checks.policyActivationExact = dependencies.verifyPolicyActivation(policy);
    if (!checks.policyActivationExact) throw new Error("policy_not_active");
    checks.compatibilityAuthorityExact = dependencies.verifyCompatibility(
      dependencies.cwd,
      policy,
    );
    if (!checks.compatibilityAuthorityExact) {
      throw new Error("provider_compatibility_unproven");
    }
    recovery = readRecoveryAuthority(
      args.recoveryAuthority,
      args.candidateSha,
      dependencies.now(),
    );
    checks.recoveryAuthorityExact = recovery !== null;
    if (!recovery) throw new Error("recovery_authority_invalid");
    prepared = readPreparedAuthority(args, recovery);
    checks.preparedAuthorityExact = prepared !== null;
    if (!prepared) throw new Error("prepared_authority_invalid");
    checks.preparedArtifactExact = await dependencies.verifyPreparedArtifact(
      dependencies.fetchImpl,
      dependencies.env.GITHUB_TOKEN ?? "",
      args,
      dependencies.env,
    );
    if (!checks.preparedArtifactExact) {
      throw new Error("prepared_artifact_invalid");
    }
    evidenceCustody = dependencies.openEvidenceCustody(
      args.evidenceDir,
      args.candidateSha,
    );
    productionMetadataToken =
      dependencies.env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN ?? "";
    const stagingMetadataToken =
      dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "";
    const mutationToken =
      dependencies.env
        .PINTPATH_RAILWAY_PRODUCTION_POSTGRES_SOURCE_MUTATION_TOKEN ?? "";
    expectedDatabaseUrlSha256 =
      dependencies.env.PINTPATH_PRODUCTION_BACKUP_SOURCE_URL_SHA256 ?? "";
    expectedRootCaDerSha256 =
      dependencies.env.PINTPATH_PRODUCTION_POSTGRES_ROOT_CA_DER_SHA256 ?? "";
    checks.credentialsExact = TOKEN.test(productionMetadataToken) &&
      TOKEN.test(stagingMetadataToken) &&
      TOKEN.test(mutationToken) &&
      SHA256.test(expectedDatabaseUrlSha256) &&
      SHA256.test(expectedRootCaDerSha256) &&
      new Set([
        productionMetadataToken,
        stagingMetadataToken,
        mutationToken,
      ]).size === 3;
    if (!checks.credentialsExact) throw new Error("credentials_invalid");
    const [productionScope, stagingScope, mutationScope] = await Promise.all([
      call(
        dependencies.fetchImpl,
        productionMetadataToken,
        "PintPathProductionPostgresSourcePinScope",
        PRODUCTION_POSTGRES_SOURCE_PIN_SCOPE_QUERY,
        {},
      ),
      call(
        dependencies.fetchImpl,
        stagingMetadataToken,
        "PintPathProductionPostgresSourcePinScope",
        PRODUCTION_POSTGRES_SOURCE_PIN_SCOPE_QUERY,
        {},
      ),
      call(
        dependencies.fetchImpl,
        mutationToken,
        "PintPathProductionPostgresSourcePinScope",
        PRODUCTION_POSTGRES_SOURCE_PIN_SCOPE_QUERY,
        {},
      ),
    ]);
    checks.tokenScopesExact =
      tokenScope(productionScope, PRODUCTION_ENVIRONMENT_ID) &&
      tokenScope(stagingScope, STAGING_ENVIRONMENT_ID) &&
      tokenScope(mutationScope, PRODUCTION_ENVIRONMENT_ID);
    if (!checks.tokenScopesExact) throw new Error("scope_invalid");
    const boundary = await dependencies.runBoundary(dependencies.env);
    checks.boundaryRepairOnlyExact = boundary.exact;
    boundaryReceiptSha256 = boundary.receiptSha256;
    if (!checks.boundaryRepairOnlyExact || boundaryReceiptSha256 === null) {
      throw new Error("boundary_invalid");
    }
    const [productionInventoryValue, stagingInventoryValue, postgresValue] =
      await Promise.all([
        call(
          dependencies.fetchImpl,
          productionMetadataToken,
          "PintPathProductionPostgresSourcePinEnvironment",
          PRODUCTION_POSTGRES_SOURCE_PIN_ENVIRONMENT_QUERY,
          {
            projectId: PROJECT_ID,
            environmentId: PRODUCTION_ENVIRONMENT_ID,
            serviceId: SERVICE_ID,
          },
        ),
        call(
          dependencies.fetchImpl,
          stagingMetadataToken,
          "PintPathProductionPostgresSourcePinEnvironment",
          PRODUCTION_POSTGRES_SOURCE_PIN_ENVIRONMENT_QUERY,
          {
            projectId: PROJECT_ID,
            environmentId: STAGING_ENVIRONMENT_ID,
            serviceId: SERVICE_ID,
          },
        ),
        call(
          dependencies.fetchImpl,
          productionMetadataToken,
          "PintPathRailwayProductionPostgresPin",
          RAILWAY_PRODUCTION_POSTGRES_PIN_QUERY,
          {
            environmentId: PRODUCTION_ENVIRONMENT_ID,
            serviceId: SERVICE_ID,
            deploymentId: CURRENT_DEPLOYMENT_ID,
          },
        ),
      ]);
    preProduction = parseEnvironmentInventory(
      productionInventoryValue,
      PRODUCTION_ENVIRONMENT_ID,
      SERVICE_ID,
    );
    preStaging = parseEnvironmentInventory(
      stagingInventoryValue,
      STAGING_ENVIRONMENT_ID,
      SERVICE_ID,
    );
    prePostgres = parsePostgres(postgresValue);
    checks.preflightInventoryComplete = preProduction !== null &&
      preStaging !== null &&
      prePostgres !== null &&
      preProduction.stagedPatchEmpty &&
      preStaging.stagedPatchEmpty;
    checks.preflightTargetExact = prePostgres !== null &&
      targetPreflightExact(prePostgres) &&
      preProduction?.sourceImage === CURRENT_SOURCE_IMAGE &&
      preProduction.deploymentIds.includes(CURRENT_DEPLOYMENT_ID);
    checks.preflightAutoUpdatesSafe = preProduction !== null &&
      (preProduction.autoUpdatesType === null ||
        preProduction.autoUpdatesType === "disabled");
    if (
      !preProduction ||
      !preStaging ||
      !prePostgres ||
      !checks.preflightInventoryComplete ||
      !checks.preflightTargetExact ||
      !checks.preflightAutoUpdatesSafe
    ) throw new Error("preflight_invalid");
    preDatabaseIdentity = await dependencies.observeDatabaseIdentity(
      "prewrite",
      {
        databaseUrlFile: args.databaseUrlFile,
        rootCaFile: args.rootCaFile,
        expectedDatabaseUrlSha256,
        expectedRootCaDerSha256,
      },
    );
    checks.preflightDatabaseIdentityExact = preDatabaseIdentity !== null &&
      preDatabaseIdentity.inRecovery === false &&
      SHA256.test(preDatabaseIdentity.identitySha256) &&
      preDatabaseIdentity.identitySha256 ===
        recovery.sourceDatabaseIdentitySha256;
    if (!preDatabaseIdentity || !checks.preflightDatabaseIdentityExact) {
      throw new Error("database_identity_unproven");
    }
    preDatabaseObservationSha256 = databaseObservationSha256(
      "prewrite",
      args.candidateSha,
      preDatabaseIdentity,
    );
    preflightInventorySha256 = sha256(canonical({
      production: preProduction.rawSha256,
      staging: preStaging.rawSha256,
      postgres: sha256(canonical(prePostgres)),
    }));
    const patch = {
      services: {
        [SERVICE_ID]: {
          source: {
            image: TARGET_SOURCE_IMAGE,
            autoUpdates: { type: "disabled" },
          },
        },
      },
    };
    const intent = canonical({
      schemaVersion: "pintpath-protected-production-postgres-source-pin-intent/v1",
      candidateSha: args.candidateSha,
      policySha256: POLICY_SHA256,
      boundaryReceiptSha256,
      recoveryAuthoritySha256: recovery.authoritySha256,
      recoveryAuthorityFileSha256:
        prepared?.recoveryAuthorityFileSha256 ?? null,
      preparedArtifactId: prepared?.preparedArtifactId ?? null,
      preparedArtifactDigest: prepared?.preparedArtifactDigest ?? null,
      databaseIdentityObservationSha256:
        preDatabaseObservationSha256,
      preflightInventorySha256,
      projectId: PROJECT_ID,
      environmentId: PRODUCTION_ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      currentDeploymentId: CURRENT_DEPLOYMENT_ID,
      currentSnapshotId: CURRENT_SNAPSHOT_ID,
      currentSourceImage: CURRENT_SOURCE_IMAGE,
      imageDigest: IMAGE_DIGEST,
      patch,
      patchSha256: sha256(canonical(patch)),
      mutationDocumentSha256: sha256(PRODUCTION_POSTGRES_SOURCE_PIN_MUTATION),
      commitMessage: COMMIT_MESSAGE,
      maximumAttempts: 1,
      retryAllowed: false,
      acknowledgementIsOpaque: true,
      secretMaterialIncluded: false,
    });
    if (!evidenceCustody) throw new Error("evidence_invalid");
    intentSha256 = evidenceCustody.write("intent.json", intent);
    checks.localIntentCustodyExact = intentSha256 === sha256(intent);
    if (!checks.localIntentCustodyExact) throw new Error("intent_invalid");
    const adjacentDatabaseIdentity = await dependencies.observeDatabaseIdentity(
      "prewrite",
      {
        databaseUrlFile: args.databaseUrlFile,
        rootCaFile: args.rootCaFile,
        expectedDatabaseUrlSha256,
        expectedRootCaDerSha256,
      },
    );
    checks.adjacentDatabaseIdentityExact =
      adjacentDatabaseIdentity !== null &&
      adjacentDatabaseIdentity.inRecovery === false &&
      adjacentDatabaseIdentity.identitySha256 === preDatabaseIdentity.identitySha256 &&
      adjacentDatabaseIdentity.identitySha256 ===
        recovery.sourceDatabaseIdentitySha256;
    if (!checks.adjacentDatabaseIdentityExact) {
      throw new Error("adjacent_database_identity_changed");
    }
    const [adjacentProductionValue, adjacentStagingValue, adjacentPostgresValue] =
      await Promise.all([
        call(
          dependencies.fetchImpl,
          productionMetadataToken,
          "PintPathProductionPostgresSourcePinEnvironment",
          PRODUCTION_POSTGRES_SOURCE_PIN_ENVIRONMENT_QUERY,
          {
            projectId: PROJECT_ID,
            environmentId: PRODUCTION_ENVIRONMENT_ID,
            serviceId: SERVICE_ID,
          },
        ),
        call(
          dependencies.fetchImpl,
          stagingMetadataToken,
          "PintPathProductionPostgresSourcePinEnvironment",
          PRODUCTION_POSTGRES_SOURCE_PIN_ENVIRONMENT_QUERY,
          {
            projectId: PROJECT_ID,
            environmentId: STAGING_ENVIRONMENT_ID,
            serviceId: SERVICE_ID,
          },
        ),
        call(
          dependencies.fetchImpl,
          productionMetadataToken,
          "PintPathRailwayProductionPostgresPin",
          RAILWAY_PRODUCTION_POSTGRES_PIN_QUERY,
          {
            environmentId: PRODUCTION_ENVIRONMENT_ID,
            serviceId: SERVICE_ID,
            deploymentId: CURRENT_DEPLOYMENT_ID,
          },
        ),
      ]);
    const adjacentProduction = parseEnvironmentInventory(
      adjacentProductionValue,
      PRODUCTION_ENVIRONMENT_ID,
      SERVICE_ID,
    );
    const adjacentStaging = parseEnvironmentInventory(
      adjacentStagingValue,
      STAGING_ENVIRONMENT_ID,
      SERVICE_ID,
    );
    const adjacentPostgres = parsePostgres(adjacentPostgresValue);
    checks.adjacentPreflightExact = adjacentProduction !== null &&
      adjacentStaging !== null &&
      adjacentPostgres !== null &&
      adjacentProduction.rawSha256 === preProduction.rawSha256 &&
      adjacentStaging.rawSha256 === preStaging.rawSha256 &&
      sha256(canonical(adjacentPostgres)) === sha256(canonical(prePostgres)) &&
      adjacentProduction.stagedPatchEmpty &&
      adjacentStaging.stagedPatchEmpty &&
      targetPreflightExact(adjacentPostgres);
    if (!checks.adjacentPreflightExact) {
      throw new Error("adjacent_preflight_changed");
    }
    checks.currentMainExact = await dependencies.verifyCurrentMain(
      dependencies.fetchImpl,
      dependencies.env.GITHUB_TOKEN ?? "",
      args.candidateSha,
    );
    if (!checks.currentMainExact) throw new Error("current_main_advanced");
    attempts = 1;
    try {
      const acknowledgement = await call(
        dependencies.fetchImpl,
        mutationToken,
        "PintPathPinProductionPostgresSource",
        PRODUCTION_POSTGRES_SOURCE_PIN_MUTATION,
        {
          environmentId: PRODUCTION_ENVIRONMENT_ID,
          patch,
          commitMessage: COMMIT_MESSAGE,
        },
      );
      if (
        exact(acknowledgement, ["data"]) &&
        exact(acknowledgement.data, ["environmentPatchCommit"]) &&
        typeof acknowledgement.data.environmentPatchCommit === "string" &&
        acknowledgement.data.environmentPatchCommit.length >= 1 &&
        acknowledgement.data.environmentPatchCommit.length <= 1024 &&
        !/[\r\n\0]/.test(acknowledgement.data.environmentPatchCommit)
      ) {
        acknowledgementSha256 = sha256(
          acknowledgement.data.environmentPatchCommit,
        );
        checks.acknowledgementOpaqueCaptured = true;
      }
    } catch {
      checks.acknowledgementOpaqueCaptured = false;
    }
  } catch {
    outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
  } finally {
    if (attempts === 1 && args && preProduction && preStaging && recovery) {
      checks.postflightAttempted = true;
      const deadline = dependencies.now() + 15 * 60_000;
      for (let poll = 0; poll < 91; poll += 1) {
        try {
          const [postgresValue, productionValue, stagingValue] =
            await Promise.all([
              call(
                dependencies.fetchImpl,
                productionMetadataToken,
                "PintPathRailwayProductionPostgresPin",
                RAILWAY_PRODUCTION_POSTGRES_PIN_QUERY,
                {
                  environmentId: PRODUCTION_ENVIRONMENT_ID,
                  serviceId: SERVICE_ID,
                  deploymentId: CURRENT_DEPLOYMENT_ID,
                },
              ),
              call(
                dependencies.fetchImpl,
                productionMetadataToken,
                "PintPathProductionPostgresSourcePinEnvironment",
                PRODUCTION_POSTGRES_SOURCE_PIN_ENVIRONMENT_QUERY,
                {
                  projectId: PROJECT_ID,
                  environmentId: PRODUCTION_ENVIRONMENT_ID,
                  serviceId: SERVICE_ID,
                },
              ),
              call(
                dependencies.fetchImpl,
                dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN ?? "",
                "PintPathProductionPostgresSourcePinEnvironment",
                PRODUCTION_POSTGRES_SOURCE_PIN_ENVIRONMENT_QUERY,
                {
                  projectId: PROJECT_ID,
                  environmentId: STAGING_ENVIRONMENT_ID,
                  serviceId: SERVICE_ID,
                },
              ),
            ]);
          const observedPostgres = parsePostgres(postgresValue);
          const postProduction = parseEnvironmentInventory(
            productionValue,
            PRODUCTION_ENVIRONMENT_ID,
            SERVICE_ID,
          );
          const postStaging = parseEnvironmentInventory(
            stagingValue,
            STAGING_ENVIRONMENT_ID,
            SERVICE_ID,
          );
          const discoveredDeploymentId =
            observedPostgres?.latestDeployment?.id ?? null;
          let postPostgres = observedPostgres;
          if (
            discoveredDeploymentId !== null &&
            discoveredDeploymentId !== CURRENT_DEPLOYMENT_ID
          ) {
            postPostgres = parsePostgres(await call(
              dependencies.fetchImpl,
              productionMetadataToken,
              "PintPathRailwayProductionPostgresPin",
              RAILWAY_PRODUCTION_POSTGRES_PIN_QUERY,
              {
                environmentId: PRODUCTION_ENVIRONMENT_ID,
                serviceId: SERVICE_ID,
                deploymentId: discoveredDeploymentId,
              },
            ));
          }
          if (postPostgres && postProduction && postStaging) {
            checks.sourceTransitionExact =
              postPostgres.sourceImage === TARGET_SOURCE_IMAGE &&
              postProduction.sourceImage === TARGET_SOURCE_IMAGE;
            checks.autoUpdatesDisabledExact =
              postProduction.autoUpdatesType === "disabled";
            const newIds = postProduction.deploymentIds.filter(
              (id) => !preProduction!.deploymentIds.includes(id),
            );
            const discoveredDeployment = postProduction.deployments.find(
              (deployment) => deployment.id === discoveredDeploymentId,
            );
            checks.deploymentTransitionExact =
              discoveredDeploymentId !== null &&
              discoveredDeploymentId !== CURRENT_DEPLOYMENT_ID &&
              newIds.length === 1 &&
              newIds[0] === discoveredDeploymentId &&
              discoveredDeployment?.snapshotId ===
                postPostgres.latestDeployment?.snapshotId &&
              postPostgres.approvedDeployment?.id === discoveredDeploymentId;
            checks.targetHealthyExact = targetPostflightExact(postPostgres);
            checks.stagedPatchesEmptyExact =
              postProduction.stagedPatchEmpty && postStaging.stagedPatchEmpty;
            checks.collateralInventoryUnchangedExact =
              postProduction.collateralSha256 === preProduction.collateralSha256 &&
              postStaging.collateralSha256 === preStaging.collateralSha256 &&
              discoveredDeploymentId !== null &&
              deploymentCollateralExact(
                preProduction,
                postProduction,
                discoveredDeploymentId,
              );
            let postDatabaseIdentity: DatabaseIdentityObservation | null = null;
            if (
              checks.sourceTransitionExact &&
              checks.autoUpdatesDisabledExact &&
              checks.deploymentTransitionExact &&
              checks.targetHealthyExact &&
              checks.stagedPatchesEmptyExact &&
              checks.collateralInventoryUnchangedExact
            ) {
              postDatabaseIdentity = await dependencies.observeDatabaseIdentity(
                "postflight",
                {
                  databaseUrlFile: args.databaseUrlFile,
                  rootCaFile: args.rootCaFile,
                  expectedDatabaseUrlSha256,
                  expectedRootCaDerSha256,
                },
              );
            }
            checks.postflightDatabaseIdentityExact =
              postDatabaseIdentity !== null &&
              postDatabaseIdentity.inRecovery === false &&
              SHA256.test(postDatabaseIdentity.identitySha256) &&
              postDatabaseIdentity.identitySha256 ===
                recovery.sourceDatabaseIdentitySha256 &&
              postDatabaseIdentity.identitySha256 ===
                preDatabaseIdentity?.identitySha256;
            if (postDatabaseIdentity !== null) {
              postDatabaseObservationSha256 = databaseObservationSha256(
                "postflight",
                args.candidateSha,
                postDatabaseIdentity,
              );
            }
            checks.databaseIdentityBindingExact =
              checks.preflightDatabaseIdentityExact &&
              checks.postflightDatabaseIdentityExact;
            checks.dataRecoveryAuthorityPostflightExact =
              dependencies.now() - Date.parse(recovery.completedAt) <=
                2 * 60 * 60_000 &&
              Date.parse(recovery.minimumRetainUntil) - dependencies.now() >=
                29 * 24 * 60 * 60_000 &&
              checks.collateralInventoryUnchangedExact &&
              checks.databaseIdentityBindingExact;
            if (
              checks.sourceTransitionExact &&
              checks.autoUpdatesDisabledExact &&
              checks.deploymentTransitionExact &&
              checks.targetHealthyExact &&
              checks.stagedPatchesEmptyExact &&
              checks.collateralInventoryUnchangedExact &&
              checks.databaseIdentityBindingExact &&
              checks.dataRecoveryAuthorityPostflightExact
            ) {
              newDeploymentId = discoveredDeploymentId;
              newSnapshotId = postPostgres.latestDeployment?.snapshotId ?? null;
              newPatchId = postPostgres.approvedDeployment?.patchId ?? null;
              postflightInventorySha256 = sha256(canonical({
                production: postProduction.rawSha256,
                staging: postStaging.rawSha256,
                postgres: sha256(canonical(postPostgres)),
              }));
              break;
            }
          }
        } catch {
          // This is bounded read-only reconciliation after the one possible write.
        }
        if (dependencies.now() >= deadline || poll === 90) break;
        await dependencies.sleep(10_000);
      }
      const reconciled = newDeploymentId !== null && newSnapshotId !== null &&
        newPatchId !== null &&
        postflightInventorySha256 !== null;
      outcome = reconciled
        ? checks.acknowledgementOpaqueCaptured
          ? "pinned"
          : "pinned_reconciled_after_lost_ack"
        : "mutation_uncertain";
      if (reconciled) {
        try {
          const rebaseline = canonical({
            schemaVersion:
              "pintpath-railway-production-staging-mutation-policy-rebaseline-candidate/v1",
            predecessorPolicyPath: BOUNDARY_POLICY_PATH,
            predecessorPolicySha256: BOUNDARY_POLICY_SHA256,
            sourcePinPolicySha256: POLICY_SHA256,
            sourcePinIntentSha256: intentSha256,
            candidateSha: args.candidateSha,
            projectId: PROJECT_ID,
            productionEnvironmentId: PRODUCTION_ENVIRONMENT_ID,
            stagingEnvironmentId: STAGING_ENVIRONMENT_ID,
            serviceId: SERVICE_ID,
            deploymentId: newDeploymentId,
            snapshotId: newSnapshotId,
            sourceImage: TARGET_SOURCE_IMAGE,
            imageDigest: IMAGE_DIGEST,
            autoUpdatesType: "disabled",
            patchId: newPatchId,
            patchIdAuthority: "EXACT_NEW_DEPLOYMENT_METADATA",
            ordinaryBoundaryExpectedBlocked: true,
            automaticPolicyMutationAllowed: false,
          });
          if (!evidenceCustody) throw new Error("evidence_invalid");
          rebaselineCandidateSha256 = evidenceCustody.write(
            "rebaseline-candidate.json",
            rebaseline,
          );
          checks.rebaselineCandidateExact =
            rebaselineCandidateSha256 === sha256(rebaseline);
        } catch {
          checks.rebaselineCandidateExact = false;
          outcome = "mutation_uncertain";
        }
      }
    }
  }
  const provisional = receipt({
    args,
    outcome,
    attempts,
    recovery,
    prepared,
    boundaryReceiptSha256,
    preflightInventorySha256,
    postflightInventorySha256,
    preDatabaseObservationSha256,
    postDatabaseObservationSha256,
    newDeploymentId,
    newSnapshotId,
    newPatchId,
    intentSha256,
    acknowledgementSha256,
    rebaselineCandidateSha256,
    terminalEvidenceSha256: null,
    checks,
  });
  if (args && checks.localIntentCustodyExact) {
    try {
      const terminal = canonical({
        schemaVersion:
          "pintpath-protected-production-postgres-source-pin-terminal/v1",
        receipt: provisional,
      });
      if (!evidenceCustody) throw new Error("evidence_invalid");
      terminalEvidenceSha256 = evidenceCustody.write("terminal.json", terminal);
      checks.terminalEvidenceExact =
        terminalEvidenceSha256 === sha256(terminal);
    } catch {
      checks.terminalEvidenceExact = false;
      if (attempts === 1) outcome = "mutation_uncertain";
    }
  }
  if (evidenceCustody !== null) {
    try {
      evidenceCustody.close();
    } catch {
      checks.terminalEvidenceExact = false;
      outcome = attempts === 1 ? "mutation_uncertain" : "failed_before_attempt";
    }
    evidenceCustody = null;
  }
  const finalReceipt = receipt({
    args,
    outcome,
    attempts,
    recovery,
    prepared,
    boundaryReceiptSha256,
    preflightInventorySha256,
    postflightInventorySha256,
    preDatabaseObservationSha256,
    postDatabaseObservationSha256,
    newDeploymentId,
    newSnapshotId,
    newPatchId,
    intentSha256,
    acknowledgementSha256,
    rebaselineCandidateSha256,
    terminalEvidenceSha256,
    checks,
  });
  dependencies.writeOutput(`${JSON.stringify(finalReceipt)}\n`);
  return (outcome === "pinned" ||
      outcome === "pinned_reconciled_after_lost_ack") &&
      checks.rebaselineCandidateExact &&
      checks.terminalEvidenceExact
    ? 0
    : 1;
}

export const protectedProductionPostgresSourcePinInternals = {
  parseArgs,
  readPolicy,
  readRecoveryAuthority,
  readPreparedAuthority,
  tokenScope,
  parseEnvironmentInventory,
  targetPreflightExact,
  targetPostflightExact,
  defaultCompatibility,
  defaultPolicyActivation,
  databaseObservationSha256,
  deploymentCollateralExact,
  privateFile,
  openEvidenceCustody,
  defaultPreparedArtifact,
};

if (process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProtectedProductionPostgresSourcePin();
}
