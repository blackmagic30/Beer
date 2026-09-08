import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { fetchBoundedResponseText } from "./lib/bounded-http-response.js";
import {
  holdPrivateDirectoryIdentity,
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";
import { COLD_QUIESCE_SUCCESSOR_BINDING } from
  "./lib/permanent-staging-cold-recovery.js";
import {
  railwayEnvironmentPatchCommitVariables,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
  RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
} from "./lib/railway-environment-patch-commit.js";
import {
  PROTECTED_SCALE_RECEIPT_SCHEMA,
  protectedScaleReplicaTopologyExact,
} from "./lib/protected-scale-receipt-topology.js";
import { workerFenceTopologyEvidenceExact } from
  "./lib/worker-fence-topology-evidence.js";

export const STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA =
  "pintpath-permanent-staging-worker-bootstrap-prerequisites/v5" as const;
export const STAGING_WORKER_BOOTSTRAP_PREREQUISITES_FILENAME =
  "prerequisites-verification.json" as const;
export const STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256 =
  "91e15bd48282dbfcd03271edfd26b9e0f94e0b9d72633a82f5b70da6e509ec3c" as const;

const REPOSITORY = "blackmagic30/Beer" as const;
const BRANCH = "main" as const;
const GITHUB_API_ORIGIN = "https://api.github.com" as const;
const POLICY_PATH =
  "ops/railway/permanent-staging-worker-bootstrap-prerequisites-policy.json";
const WORKER_POLICY_PATH =
  "ops/railway/protected-automatic-maintenance-worker-fence-policy.json";
const WORKER_POLICY_SHA256 =
  "3178685f32c9d49e359d089d5afd7c2d8c62860899a0cc70b25760155c8d7236";
const SCALE_POLICY_PATH =
  "ops/railway/permanent-staging-scale-evidence-policy.json";
const SCALE_POLICY_SHA256 =
  "164d53a5bccff4a861c8568abebe5caa06352f64245ac7e734e55c056c2be608";
const FENCED_DEPLOYMENT_POLICY_PATH =
  "ops/railway/permanent-staging-fenced-app-deployment-policy.json";
const FENCED_DEPLOYMENT_POLICY_SHA256 =
  "9cea6cacfd33a2f4500532ecf2d4564c1dbc9595eb6835e2935ff9e2df5186f5";
const ACTIVE_DEPLOYMENT_POLICY_PATH =
  "ops/railway/permanent-staging-app-deployment-policy.json";
const ACTIVE_DEPLOYMENT_POLICY_SHA256 =
  "49367b816eb1ad86e32aa85dd9bd1e2297743760e113a23c882b3776b5afad77";
const COLD_RECOVERY_POLICY_PATH =
  "ops/railway/permanent-staging-cold-recovery-policy.json";
const COLD_RECOVERY_POLICY_SHA256 =
  "59478281f9f68cea6005ee4ad8bbd9d8048c15077456d2aa6430837bfd39cdf6";
const VENUE_DIRECTORY_POLICY_PATH =
  "ops/supabase/permanent-staging-venue-directory-policy.json";
const VENUE_DIRECTORY_POLICY_SHA256 =
  "3474e28c413e908b7dac76190709553e753fed39df753a1cd273b29f161bfcef";
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const COLD_SOURCE_SHA = "12c0d24f6619a0286e16b8daf56fc27aaa1e3aba";
const WORKER_RECEIPT_SCHEMA =
  "pintpath-automatic-maintenance-worker-fence-terminal/v2";
const SCALE_RECEIPT_SCHEMA =
  PROTECTED_SCALE_RECEIPT_SCHEMA;
const DEPLOYMENT_RECEIPT_SCHEMA =
  "pintpath-railway-application-deployment-executor/v6";
const VENUE_DIRECTORY_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-venue-directory-terminal/v1";
const VENUE_DIRECTORY_PLAN_SCHEMA =
  "pintpath-permanent-staging-venue-import-plan/v1";
const VENUE_DIRECTORY_IMPORT_TERMINAL_SCHEMA =
  "pintpath-permanent-staging-venue-import-terminal/v1";
const VENUE_DIRECTORY_CONSTRAINT_PREFLIGHT_SCHEMA =
  "pintpath-permanent-staging-venue-constraint-preflight/v1";
const VENUE_DIRECTORY_MIGRATION_PREWRITE_SCHEMA =
  "pintpath-permanent-staging-venue-migration-prewrite/v1";
const VENUE_DIRECTORY_MIGRATION_APPLY_SCHEMA =
  "pintpath-permanent-staging-venue-migration-apply/v1";
const VENUE_DIRECTORY_CONSTRAINT_POSTFLIGHT_SCHEMA =
  "pintpath-permanent-staging-venue-constraint-postflight/v1";
const COLD_PREPARE_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-cold-prepare/v2";
const COLD_PREPARE_RECONCILIATION_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-cold-prepare-reconciliation/v2";
const RESTORE_RECONCILIATION_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-bootstrap-restore-reconciliation/v2";
const ACTIVATE_RECONCILIATION_RECEIPT_SCHEMA =
  "pintpath-automatic-maintenance-worker-fence-activation-reconciliation/v2";
const COLD_QUIESCE_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-cold-quiesce/v5";
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const MAXIMUM_GITHUB_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_EVIDENCE_BYTES = 1024 * 1024;
const MAXIMUM_VENUE_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAXIMUM_RECEIPT_AGE_MS = 86_400_000;
const MAXIMUM_VERIFICATION_AGE_MS = 900_000;
const MAXIMUM_CLOCK_SKEW_MS = 300_000;
const REQUEST_TIMEOUT_MS = 20_000;

type JsonRecord = Record<string, unknown>;
export type BootstrapConsumerOperation =
  | "quiesce"
  | "cold-quiesce"
  | "cold-reconcile-quiesce"
  | "fenced-deploy"
  | "restore"
  | "reconcile-restore"
  | "activate"
  | "reconcile-activate"
  | "active-deploy"
  | "scale-evidence";
type ProducerKind =
  | "prepare"
  | "cold-prepare"
  | "quiesce"
  | "cold-quiesce"
  | "fenced-deployment"
  | "venue-directory"
  | "restore"
  | "activate"
  | "active-deployment";
export type BootstrapPath = "healthy-legacy" | "cold-dead";

type FailureCode =
  | "arguments_invalid"
  | "artifact_authority_invalid"
  | "chronology_invalid"
  | "environment_invalid"
  | "evidence_invalid"
  | "github_api_failed"
  | "github_api_invalid"
  | "history_invalid"
  | "policy_invalid"
  | "receipt_invalid"
  | "reviewed_candidate_invalid"
  | "run_authority_invalid";

class BootstrapPrerequisiteError extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
    this.name = "BootstrapPrerequisiteError";
  }
}

function fail(code: FailureCode): never {
  throw new BootstrapPrerequisiteError(code);
}

interface ProducerSpec {
  readonly workflowPath: string;
  readonly workflowName: string;
  readonly title: (candidateSha: string) => string;
  readonly artifact: (candidateSha: string) => string;
  readonly receiptFilename: string;
  readonly receiptSchema: string;
  readonly verificationFlag?: string;
  readonly verificationFilename?: string;
}

const PRODUCERS: Readonly<Record<ProducerKind, ProducerSpec>> = Object.freeze({
  prepare: {
    workflowPath:
      ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
    workflowName:
      "Configure candidate-bound automatic-maintenance worker fence",
    title: (sha) =>
      `Automatic maintenance worker fence | permanent-staging | prepare | ${sha}`,
    artifact: (sha) =>
      `pintpath-automatic-maintenance-worker-fence-permanent-staging-prepare-${sha}`,
    receiptFilename: "automatic-maintenance-worker-fence-terminal.json",
    receiptSchema: WORKER_RECEIPT_SCHEMA,
  },
  "cold-prepare": {
    workflowPath: ".github/workflows/recover-permanent-staging-cold-zero.yml",
    workflowName: "Recover dead permanent staging to explicit zero",
    title: (sha) => `Permanent staging cold recovery | prepare | ${sha}`,
    artifact: (sha) => `pintpath-permanent-staging-cold-prepare-${sha}`,
    receiptFilename: "cold-prepare-terminal.json",
    receiptSchema: COLD_PREPARE_RECEIPT_SCHEMA,
  },
  quiesce: {
    workflowPath:
      ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
    workflowName:
      "Bootstrap permanent-staging automatic-maintenance worker fence",
    title: (sha) => `Permanent staging worker bootstrap | quiesce | ${sha}`,
    artifact: (sha) =>
      `pintpath-permanent-staging-worker-bootstrap-quiesce-${sha}`,
    receiptFilename: "quiesce-staging-zero-receipt.json",
    receiptSchema: SCALE_RECEIPT_SCHEMA,
    verificationFlag: "--quiesce-verification-file",
    verificationFilename: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_FILENAME,
  },
  "cold-quiesce": {
    workflowPath: ".github/workflows/recover-permanent-staging-cold-zero.yml",
    workflowName: "Recover dead permanent staging to explicit zero",
    title: (sha) => `Permanent staging cold recovery | quiesce | ${sha}`,
    artifact: (sha) => `pintpath-permanent-staging-cold-quiesce-${sha}`,
    receiptFilename: "cold-quiesce-receipt.json",
    receiptSchema: COLD_QUIESCE_RECEIPT_SCHEMA,
    verificationFlag: "--cold-quiesce-verification-file",
    verificationFilename: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_FILENAME,
  },
  "fenced-deployment": {
    workflowPath: ".github/workflows/deploy-permanent-staging.yml",
    workflowName: "Deploy Pint Path permanent staging",
    title: (sha) => `Deploy permanent staging | fenced | ${sha}`,
    artifact: (sha) =>
      `pintpath-permanent-staging-fenced-deployment-${sha}`,
    receiptFilename: "deployment-receipt.json",
    receiptSchema: DEPLOYMENT_RECEIPT_SCHEMA,
  },
  "venue-directory": {
    workflowPath:
      ".github/workflows/permanent-staging-venue-directory.yml",
    workflowName: "Apply and prove permanent-staging venue directory",
    title: (sha) =>
      `Permanent staging venue directory | apply-refresh-validate | ${sha}`,
    artifact: (sha) =>
      `pintpath-permanent-staging-venue-directory-${sha}`,
    receiptFilename: "venue-directory-terminal.json",
    receiptSchema: VENUE_DIRECTORY_RECEIPT_SCHEMA,
  },
  restore: {
    workflowPath:
      ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
    workflowName:
      "Bootstrap permanent-staging automatic-maintenance worker fence",
    title: (sha) => `Permanent staging worker bootstrap | restore | ${sha}`,
    artifact: (sha) =>
      `pintpath-permanent-staging-worker-bootstrap-restore-${sha}`,
    receiptFilename: "bootstrap-staging-one-receipt.json",
    receiptSchema: SCALE_RECEIPT_SCHEMA,
    verificationFlag: "--restore-verification-file",
    verificationFilename: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_FILENAME,
  },
  activate: {
    workflowPath:
      ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
    workflowName:
      "Configure candidate-bound automatic-maintenance worker fence",
    title: (sha) =>
      `Automatic maintenance worker fence | permanent-staging | activate | ${sha}`,
    artifact: (sha) =>
      `pintpath-automatic-maintenance-worker-fence-permanent-staging-activate-${sha}`,
    receiptFilename: "automatic-maintenance-worker-fence-terminal.json",
    receiptSchema: WORKER_RECEIPT_SCHEMA,
    verificationFlag: "--activate-verification-file",
    verificationFilename: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_FILENAME,
  },
  "active-deployment": {
    workflowPath: ".github/workflows/deploy-permanent-staging.yml",
    workflowName: "Deploy Pint Path permanent staging",
    title: (sha) => `Deploy permanent staging | active | ${sha}`,
    artifact: (sha) => `pintpath-permanent-staging-deployment-${sha}`,
    receiptFilename: "deployment-receipt.json",
    receiptSchema: DEPLOYMENT_RECEIPT_SCHEMA,
  },
});

function producerSpecForObservedRun(
  kind: ProducerKind,
  candidateSha: string,
  value: unknown,
): ProducerSpec {
  const base = PRODUCERS[kind];
  if (!record(value)) return base;
  const alternateTitle = kind === "cold-prepare"
    ? `Permanent staging cold recovery | reconcile-prepare | ${candidateSha}`
    : kind === "cold-quiesce"
    ? `Permanent staging cold recovery | reconcile-quiesce | ${candidateSha}`
    : kind === "restore"
    ? `Permanent staging worker bootstrap | reconcile-restore | ${candidateSha}`
    : kind === "activate"
    ? `Automatic maintenance worker fence | permanent-staging | reconcile-activate | ${candidateSha}`
    : null;
  if (alternateTitle === null || value.display_title !== alternateTitle) return base;
  return Object.freeze({
    ...base,
    title: () => alternateTitle,
  });
}

const HEALTHY_REQUIRED_PRODUCERS: Readonly<
  Record<BootstrapConsumerOperation, readonly ProducerKind[]>
> = Object.freeze({
  quiesce: ["prepare"],
  "cold-quiesce": [],
  "cold-reconcile-quiesce": [],
  "fenced-deploy": ["prepare", "quiesce"],
  restore: ["prepare", "quiesce", "fenced-deployment", "venue-directory"],
  "reconcile-restore": ["prepare", "quiesce", "fenced-deployment", "venue-directory"],
  activate: ["prepare", "quiesce", "fenced-deployment", "venue-directory", "restore"],
  "reconcile-activate": ["prepare", "quiesce", "fenced-deployment", "venue-directory", "restore"],
  "active-deploy": ["activate"],
  "scale-evidence": ["activate", "active-deployment"],
});

const COLD_REQUIRED_PRODUCERS: Readonly<
  Record<BootstrapConsumerOperation, readonly ProducerKind[]>
> = Object.freeze({
  quiesce: [],
  "cold-quiesce": ["cold-prepare"],
  "cold-reconcile-quiesce": ["cold-prepare"],
  "fenced-deploy": ["cold-prepare", "cold-quiesce"],
  restore: ["cold-prepare", "cold-quiesce", "fenced-deployment", "venue-directory"],
  "reconcile-restore": ["cold-prepare", "cold-quiesce", "fenced-deployment", "venue-directory"],
  activate: ["cold-prepare", "cold-quiesce", "fenced-deployment", "venue-directory", "restore"],
  "reconcile-activate": ["cold-prepare", "cold-quiesce", "fenced-deployment", "venue-directory", "restore"],
  "active-deploy": ["activate"],
  "scale-evidence": ["activate", "active-deployment"],
});

function requiredProducers(
  operation: BootstrapConsumerOperation,
  bootstrapPath: BootstrapPath,
): readonly ProducerKind[] {
  const required = bootstrapPath === "cold-dead"
    ? COLD_REQUIRED_PRODUCERS[operation]
    : HEALTHY_REQUIRED_PRODUCERS[operation];
  if (required.length === 0) fail("arguments_invalid");
  return required;
}

const CONSUMERS = Object.freeze({
  quiesce: {
    workflowPath:
      ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
    workflowName:
      "Bootstrap permanent-staging automatic-maintenance worker fence",
    title: (sha: string) => `Permanent staging worker bootstrap | quiesce | ${sha}`,
    environment: "permanent-staging-scale-evidence",
  },
  "cold-quiesce": {
    workflowPath: ".github/workflows/recover-permanent-staging-cold-zero.yml",
    workflowName: "Recover dead permanent staging to explicit zero",
    title: (sha: string) => `Permanent staging cold recovery | quiesce | ${sha}`,
    environment: "permanent-staging-scale-evidence",
  },
  "cold-reconcile-quiesce": {
    workflowPath: ".github/workflows/recover-permanent-staging-cold-zero.yml",
    workflowName: "Recover dead permanent staging to explicit zero",
    title: (sha: string) =>
      `Permanent staging cold recovery | reconcile-quiesce | ${sha}`,
    environment: "permanent-staging-scale-evidence",
  },
  "fenced-deploy": {
    workflowPath: ".github/workflows/deploy-permanent-staging.yml",
    workflowName: "Deploy Pint Path permanent staging",
    title: (sha: string) => `Deploy permanent staging | fenced | ${sha}`,
    environment: "permanent-staging-deployment",
  },
  restore: {
    workflowPath:
      ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
    workflowName:
      "Bootstrap permanent-staging automatic-maintenance worker fence",
    title: (sha: string) => `Permanent staging worker bootstrap | restore | ${sha}`,
    environment: "permanent-staging-scale-evidence",
  },
  "reconcile-restore": {
    workflowPath:
      ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
    workflowName:
      "Bootstrap permanent-staging automatic-maintenance worker fence",
    title: (sha: string) =>
      `Permanent staging worker bootstrap | reconcile-restore | ${sha}`,
    environment: "permanent-staging-scale-evidence",
  },
  activate: {
    workflowPath:
      ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
    workflowName:
      "Configure candidate-bound automatic-maintenance worker fence",
    title: (sha: string) =>
      `Automatic maintenance worker fence | permanent-staging | activate | ${sha}`,
    environment: "permanent-staging-provider-mutation",
  },
  "reconcile-activate": {
    workflowPath:
      ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
    workflowName:
      "Configure candidate-bound automatic-maintenance worker fence",
    title: (sha: string) =>
      `Automatic maintenance worker fence | permanent-staging | reconcile-activate | ${sha}`,
    environment: "permanent-staging-provider-mutation",
  },
  "active-deploy": {
    workflowPath: ".github/workflows/deploy-permanent-staging.yml",
    workflowName: "Deploy Pint Path permanent staging",
    title: (sha: string) => `Deploy permanent staging | active | ${sha}`,
    environment: "permanent-staging-deployment",
  },
  "scale-evidence": {
    workflowPath: ".github/workflows/permanent-staging-scale-evidence.yml",
    workflowName: "Prove Pint Path permanent-staging two-replica scale",
    title: (_sha: string) => "",
    environment: "permanent-staging-scale-evidence",
  },
});

const ARGUMENT_FLAGS: Readonly<Record<ProducerKind, {
  readonly run: string;
  readonly receipt: string;
}>> = Object.freeze({
  prepare: {
    run: "--prepare-run-id",
    receipt: "--prepare-terminal-file",
  },
  "cold-prepare": {
    run: "--cold-prepare-run-id",
    receipt: "--cold-prepare-terminal-file",
  },
  quiesce: {
    run: "--quiesce-run-id",
    receipt: "--quiesce-receipt-file",
  },
  "cold-quiesce": {
    run: "--cold-quiesce-run-id",
    receipt: "--cold-quiesce-receipt-file",
  },
  "fenced-deployment": {
    run: "--fenced-deployment-run-id",
    receipt: "--fenced-deployment-receipt-file",
  },
  "venue-directory": {
    run: "--venue-directory-run-id",
    receipt: "--venue-directory-receipt-file",
  },
  restore: {
    run: "--restore-run-id",
    receipt: "--restore-receipt-file",
  },
  activate: {
    run: "--activate-run-id",
    receipt: "--activate-terminal-file",
  },
  "active-deployment": {
    run: "--active-deployment-run-id",
    receipt: "--active-deployment-receipt-file",
  },
});

interface Arguments {
  readonly operation: BootstrapConsumerOperation;
  readonly bootstrapPath: BootstrapPath;
  readonly candidateSha: string;
  readonly expectedDeploymentSha: string | null;
  readonly output: string;
  readonly inputs: ReadonlyMap<ProducerKind, {
    readonly runId: string;
    readonly receiptFile: string;
    readonly verificationFile: string | null;
  }>;
}

interface GithubRun {
  readonly id: string;
  readonly createdAt: string;
  readonly createdAtMs: number;
  readonly startedAt: string;
  readonly startedAtMs: number;
  readonly completedAt: string;
  readonly completedAtMs: number;
}

interface GithubArtifact {
  readonly id: string;
  readonly name: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

interface ReceiptSummary {
  readonly filename: string;
  readonly schemaVersion: string;
  readonly sha256: string;
  readonly outcome: string;
  readonly candidateSha: string;
  readonly sourceSha: string;
  readonly deploymentIdSha256: string;
  readonly replicasBefore: number | null;
  readonly replicasAfter: number | null;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
}

interface PrerequisiteEvidence {
  readonly kind: ProducerKind;
  readonly workflowPath: string;
  readonly runId: string;
  readonly runAttempt: 1;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly artifactName: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly artifactSizeBytes: number;
  readonly receipt: Omit<ReceiptSummary, "startedAtMs" | "completedAtMs">;
  readonly prerequisiteVerificationSha256: string | null;
}

export interface StagingWorkerBootstrapPrerequisitesVerification {
  readonly schemaVersion: typeof STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA;
  readonly policySha256:
    typeof STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256;
  readonly operation: BootstrapConsumerOperation;
  readonly bootstrapPath: BootstrapPath;
  readonly candidateSha: string;
  readonly expectedDeploymentSha: string | null;
  readonly repository: typeof REPOSITORY;
  readonly reviewedPullRequest: {
    readonly number: number;
    readonly reviewedHeadSha: string;
    readonly mergeCommitSha: string;
    readonly treeSha: string;
    readonly mergedAt: string;
    readonly authorId: number;
    readonly mergedById: number;
  };
  readonly consumer: {
    readonly workflowPath: string;
    readonly githubEnvironment: string;
    readonly runId: string;
    readonly runAttempt: 1;
    readonly startedAt: string;
  };
  readonly prerequisites: readonly PrerequisiteEvidence[];
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly checks: {
    readonly policiesExact: true;
    readonly currentMainExact: true;
    readonly reviewedCandidateExact: true;
    readonly consumerRunAuthorityExact: true;
    readonly prerequisiteRunsExact: true;
    readonly artifactNamesAndDigestsExact: true;
    readonly receiptSchemasAndBindingsExact: true;
    readonly strictChronologyExact: true;
    readonly noLaterMatchingRunsExact: true;
    readonly evidenceSecretFreeExact: true;
  };
  readonly secretMaterialIncluded: false;
  readonly secretDerivedCommitmentsIncluded: false;
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly now: () => Date;
  readonly readPrivateFile: (filename: string, maximumBytes?: number) => Buffer;
  readonly writeEvidence: (filename: string, source: string) => void;
  readonly writeOutput: (source: string) => void;
  readonly requestTimeoutMs: number;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalCompactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCompactValue);
  if (!record(value)) return value;
  const result: JsonRecord = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = canonicalCompactValue(value[key]);
  }
  return result;
}

function canonicalCompact(value: unknown): string {
  return `${JSON.stringify(canonicalCompactValue(value))}\n`;
}

function record(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is JsonRecord {
  return record(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function exactTrueChecks(value: unknown, keys: readonly string[]): boolean {
  return exactKeys(value, keys) && keys.every((key) => value[key] === true);
}

function timestamp(value: unknown, code: FailureCode): {
  readonly canonical: string;
  readonly milliseconds: number;
} {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) fail(code);
  const milliseconds = Date.parse(value);
  const canonicalValue = Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : "";
  if (canonicalValue !== (value.includes(".") ? value : value.replace("Z", ".000Z"))) {
    fail(code);
  }
  return { canonical: canonicalValue, milliseconds };
}

function exactAbsoluteFile(value: string, leaf: string): boolean {
  return path.isAbsolute(value)
    && path.resolve(value) === value
    && path.normalize(value) === value
    && !value.includes("\0")
    && path.basename(value) === leaf;
}

function parseArguments(argv: readonly string[]): Arguments {
  if (argv.length % 2 !== 0) fail("arguments_invalid");
  const common = new Set([
    "--operation",
    "--bootstrap-path",
    "--candidate-sha",
    "--expected-deployment-sha",
    "--output",
  ]);
  const allowed = new Set(common);
  for (const kind of Object.keys(ARGUMENT_FLAGS) as ProducerKind[]) {
    allowed.add(ARGUMENT_FLAGS[kind].run);
    allowed.add(ARGUMENT_FLAGS[kind].receipt);
    const verificationFlag = PRODUCERS[kind].verificationFlag;
    if (verificationFlag) allowed.add(verificationFlag);
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !allowed.has(key) || !value || values.has(key)) {
      fail("arguments_invalid");
    }
    values.set(key, value);
  }
  const operation = values.get("--operation") as
    BootstrapConsumerOperation | undefined;
  const bootstrapPath = (values.get("--bootstrap-path") ?? "healthy-legacy") as
    BootstrapPath;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const expectedDeploymentSha =
    values.get("--expected-deployment-sha") ?? null;
  const output = values.get("--output") ?? "";
  if (
    !operation
    || !Object.hasOwn(HEALTHY_REQUIRED_PRODUCERS, operation)
    || !["healthy-legacy", "cold-dead"].includes(bootstrapPath)
    || !SHA_PATTERN.test(candidateSha)
    || !exactAbsoluteFile(
      output,
      STAGING_WORKER_BOOTSTRAP_PREREQUISITES_FILENAME,
    )
  ) fail("arguments_invalid");
  if (
    ((operation === "cold-quiesce" ||
      operation === "cold-reconcile-quiesce") &&
      bootstrapPath !== "cold-dead")
    || (operation === "quiesce" && bootstrapPath !== "healthy-legacy")
    || (bootstrapPath === "cold-dead"
      && (operation === "cold-quiesce" ||
        operation === "cold-reconcile-quiesce")
      && expectedDeploymentSha !== COLD_SOURCE_SHA)
  ) fail("arguments_invalid");
  if (
    operation === "quiesce" || operation === "cold-quiesce" ||
      operation === "cold-reconcile-quiesce"
      ? expectedDeploymentSha === null
        || !SHA_PATTERN.test(expectedDeploymentSha)
        || expectedDeploymentSha === candidateSha
      : operation === "restore" || operation === "reconcile-restore"
        ? expectedDeploymentSha !== candidateSha
        : expectedDeploymentSha !== null
  ) fail("arguments_invalid");

  const required = new Set(requiredProducers(operation, bootstrapPath));
  const inputs = new Map<ProducerKind, {
    runId: string;
    receiptFile: string;
    verificationFile: string | null;
  }>();
  for (const kind of Object.keys(PRODUCERS) as ProducerKind[]) {
    const flags = ARGUMENT_FLAGS[kind];
    const runId = values.get(flags.run) ?? null;
    const receiptFile = values.get(flags.receipt) ?? null;
    const verificationFlag = PRODUCERS[kind].verificationFlag;
    const verificationFile = verificationFlag
      ? values.get(verificationFlag) ?? null
      : null;
    if (!required.has(kind)) {
      if (runId !== null || receiptFile !== null || verificationFile !== null) {
        fail("arguments_invalid");
      }
      continue;
    }
    if (
      runId === null
      || !RUN_ID_PATTERN.test(runId)
      || receiptFile === null
      || !exactAbsoluteFile(receiptFile, PRODUCERS[kind].receiptFilename)
      || (verificationFlag
        && (verificationFile === null
          || !exactAbsoluteFile(
            verificationFile,
            PRODUCERS[kind].verificationFilename!,
          )))
    ) fail("arguments_invalid");
    inputs.set(kind, { runId, receiptFile, verificationFile });
  }
  if (new Set([...inputs.values()].map((input) => input.runId)).size !== inputs.size) {
    fail("arguments_invalid");
  }
  return {
    operation,
    bootstrapPath,
    candidateSha,
    expectedDeploymentSha,
    output,
    inputs,
  };
}

function validatePolicies(cwd: string): void {
  const policies = [
    [POLICY_PATH, STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256],
    [WORKER_POLICY_PATH, WORKER_POLICY_SHA256],
    [SCALE_POLICY_PATH, SCALE_POLICY_SHA256],
    [FENCED_DEPLOYMENT_POLICY_PATH, FENCED_DEPLOYMENT_POLICY_SHA256],
    [ACTIVE_DEPLOYMENT_POLICY_PATH, ACTIVE_DEPLOYMENT_POLICY_SHA256],
    [COLD_RECOVERY_POLICY_PATH, COLD_RECOVERY_POLICY_SHA256],
    [VENUE_DIRECTORY_POLICY_PATH, VENUE_DIRECTORY_POLICY_SHA256],
  ] as const;
  try {
    for (const [relative, expected] of policies) {
      const bytes = readTrustedRegularFile(path.resolve(cwd, relative), {
        minBytes: 1,
        maxBytes: MAXIMUM_EVIDENCE_BYTES,
      });
      const valid = sha256(bytes) === expected && record(JSON.parse(bytes.toString("utf8")));
      bytes.fill(0);
      if (!valid) fail("policy_invalid");
    }
  } catch (error) {
    if (error instanceof BootstrapPrerequisiteError) throw error;
    fail("policy_invalid");
  }
}

function validateEnvironment(args: Arguments, env: Dependencies["env"]): string {
  const consumer = CONSUMERS[args.operation];
  const currentRunId = env.GITHUB_RUN_ID ?? "";
  if (
    env.GITHUB_ACTIONS !== "true"
    || env.GITHUB_REPOSITORY !== REPOSITORY
    || env.GITHUB_REF !== `refs/heads/${BRANCH}`
    || env.GITHUB_SHA !== args.candidateSha
    || env.GITHUB_RUN_ATTEMPT !== "1"
    || !RUN_ID_PATTERN.test(currentRunId)
    || [...args.inputs.values()].some((input) => input.runId === currentRunId)
    || env.GITHUB_WORKFLOW_REF?.split("@")[0]
      !== `${REPOSITORY}/${consumer.workflowPath}`
    || env.GITHUB_API_URL !== GITHUB_API_ORIGIN
    || env.PINTPATH_STAGING_WORKER_BOOTSTRAP_OPERATION !== args.operation
    || env.PINTPATH_STAGING_WORKER_BOOTSTRAP_GITHUB_ENVIRONMENT
      !== consumer.environment
    || typeof env.GITHUB_TOKEN !== "string"
    || env.GITHUB_TOKEN.length < 16
    || /[\r\n\0]/.test(env.GITHUB_TOKEN)
  ) fail("environment_invalid");
  return currentRunId;
}

async function githubJson(dependencies: Dependencies, endpoint: string): Promise<unknown> {
  let bounded;
  try {
    bounded = await fetchBoundedResponseText(
      dependencies.fetchImpl,
      `${GITHUB_API_ORIGIN}/repos/${REPOSITORY}${endpoint}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${dependencies.env.GITHUB_TOKEN}`,
          "user-agent": "pintpath-staging-worker-bootstrap-prerequisites/1",
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        cache: "no-store",
      },
      {
        maximumBytes: MAXIMUM_GITHUB_RESPONSE_BYTES,
        signal: AbortSignal.timeout(dependencies.requestTimeoutMs),
      },
    );
  } catch {
    fail("github_api_failed");
  }
  if (!bounded.response.ok) fail("github_api_failed");
  try {
    return JSON.parse(bounded.source) as unknown;
  } catch {
    fail("github_api_invalid");
  }
}

function workflowPathExact(actual: unknown, expected: string): boolean {
  return actual === expected || actual === `${expected}@${BRANCH}`;
}

function workflowRunNameExact(
  actual: unknown,
  workflowName: string,
  displayTitle: string | null,
): boolean {
  return actual === workflowName ||
    (displayTitle !== null && actual === displayTitle);
}

function validateRun(value: unknown, input: {
  readonly runId: string;
  readonly candidateSha: string;
  readonly workflowPath: string;
  readonly workflowName: string;
  readonly status: "completed" | "in_progress";
  readonly conclusion: "success" | null;
  readonly displayTitle: string | null;
}): GithubRun {
  const run = record(value) ? value : null;
  const repository = record(run?.repository) ? run.repository : null;
  const headRepository = record(run?.head_repository)
    ? run.head_repository
    : null;
  if (
    !run
    || String(run.id) !== input.runId
    || repository?.full_name !== REPOSITORY
    || headRepository?.full_name !== REPOSITORY
    || !workflowRunNameExact(
      run.name,
      input.workflowName,
      input.displayTitle,
    )
    || !workflowPathExact(run.path, input.workflowPath)
    || run.event !== "workflow_dispatch"
    || run.head_sha !== input.candidateSha
    || run.head_branch !== BRANCH
    || run.run_attempt !== 1
    || run.status !== input.status
    || run.conclusion !== input.conclusion
    || (input.displayTitle !== null && run.display_title !== input.displayTitle)
  ) fail("run_authority_invalid");
  const created = timestamp(run.created_at, "run_authority_invalid");
  const started = timestamp(run.run_started_at, "run_authority_invalid");
  const completed = timestamp(
    input.status === "completed" ? run.updated_at : run.run_started_at,
    "run_authority_invalid",
  );
  if (
    created.milliseconds > started.milliseconds
    || (input.status === "completed"
      && completed.milliseconds <= started.milliseconds)
  ) fail("run_authority_invalid");
  return {
    id: input.runId,
    createdAt: created.canonical,
    createdAtMs: created.milliseconds,
    startedAt: started.canonical,
    startedAtMs: started.milliseconds,
    completedAt: completed.canonical,
    completedAtMs: completed.milliseconds,
  };
}

function validateArtifact(
  value: unknown,
  runId: string,
  candidateSha: string,
  expectedName: string,
): GithubArtifact {
  const listing = record(value) ? value : null;
  const artifacts = Array.isArray(listing?.artifacts) ? listing.artifacts : [];
  if (listing?.total_count !== 1 || artifacts.length !== 1) {
    fail("artifact_authority_invalid");
  }
  const artifact = record(artifacts[0]) ? artifacts[0] : null;
  const workflowRun = record(artifact?.workflow_run)
    ? artifact.workflow_run
    : null;
  if (
    !artifact
    || artifact.name !== expectedName
    || artifact.expired !== false
    || !RUN_ID_PATTERN.test(String(artifact.id))
    || !ARTIFACT_DIGEST_PATTERN.test(String(artifact.digest))
    || !Number.isSafeInteger(artifact.size_in_bytes)
    || Number(artifact.size_in_bytes) < 1
    || Number(artifact.size_in_bytes) > MAXIMUM_ARTIFACT_BYTES
    || artifact.archive_download_url
      !== `${GITHUB_API_ORIGIN}/repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`
    || workflowRun === null
    || String(workflowRun.id) !== runId
    || workflowRun.head_sha !== candidateSha
  ) fail("artifact_authority_invalid");
  return {
    id: String(artifact.id),
    name: expectedName,
    digest: String(artifact.digest),
    sizeBytes: Number(artifact.size_in_bytes),
  };
}

function validateHistory(
  value: unknown,
  spec: ProducerSpec,
  candidateSha: string,
  expectedRunId: string,
): void {
  const listing = record(value) ? value : null;
  const runs = Array.isArray(listing?.workflow_runs)
    ? listing.workflow_runs.filter(record)
    : [];
  if (
    !listing
    || !Number.isSafeInteger(listing.total_count)
    || Number(listing.total_count) < 1
    || Number(listing.total_count) > 100
    || runs.length !== listing.total_count
  ) fail("history_invalid");
  const matching = runs.filter((run) =>
    run.head_sha === candidateSha
    && run.display_title === spec.title(candidateSha)
  );
  if (matching.length !== 1 || String(matching[0]?.id) !== expectedRunId) {
    fail("history_invalid");
  }
}

async function verifyReviewedCandidate(
  candidateSha: string,
  dependencies: Dependencies,
): Promise<StagingWorkerBootstrapPrerequisitesVerification["reviewedPullRequest"]> {
  const main = await githubJson(dependencies, `/git/ref/heads/${BRANCH}`);
  const mainObject = record(main) && record(main.object) ? main.object : null;
  if (
    !record(main)
    || main.ref !== `refs/heads/${BRANCH}`
    || mainObject?.type !== "commit"
    || mainObject.sha !== candidateSha
  ) fail("reviewed_candidate_invalid");
  const associated = await githubJson(
    dependencies,
    `/commits/${candidateSha}/pulls?per_page=100&page=1`,
  );
  if (!Array.isArray(associated) || associated.length < 1 || associated.length >= 100) {
    fail("reviewed_candidate_invalid");
  }
  const matches = associated.filter((value) => {
    const pull = record(value) ? value : null;
    const base = record(pull?.base) ? pull.base : null;
    const baseRepo = record(base?.repo) ? base.repo : null;
    const head = record(pull?.head) ? pull.head : null;
    const headRepo = record(head?.repo) ? head.repo : null;
    return Number.isSafeInteger(pull?.number)
      && pull?.state === "closed"
      && pull.merge_commit_sha === candidateSha
      && base?.ref === BRANCH
      && baseRepo?.full_name === REPOSITORY
      && headRepo?.full_name === REPOSITORY;
  });
  if (matches.length !== 1) fail("reviewed_candidate_invalid");
  const summary = matches[0]!;
  const pullValue = await githubJson(dependencies, `/pulls/${summary.number}`);
  const pull = record(pullValue) ? pullValue : null;
  const base = record(pull?.base) ? pull.base : null;
  const baseRepo = record(base?.repo) ? base.repo : null;
  const head = record(pull?.head) ? pull.head : null;
  const headRepo = record(head?.repo) ? head.repo : null;
  const user = record(pull?.user) ? pull.user : null;
  const mergedBy = record(pull?.merged_by) ? pull.merged_by : null;
  const mergedAt = timestamp(pull?.merged_at, "reviewed_candidate_invalid");
  if (
    !pull
    || pull.number !== summary.number
    || pull.state !== "closed"
    || pull.merged !== true
    || pull.draft !== false
    || pull.merge_commit_sha !== candidateSha
    || base?.ref !== BRANCH
    || baseRepo?.full_name !== REPOSITORY
    || typeof head?.sha !== "string"
    || !SHA_PATTERN.test(head.sha)
    || headRepo?.full_name !== REPOSITORY
    || !Number.isSafeInteger(user?.id)
    || !Number.isSafeInteger(mergedBy?.id)
  ) fail("reviewed_candidate_invalid");
  const reviewedHeadSha = String(head.sha);
  const [candidateCommitValue, reviewedCommitValue] = await Promise.all([
    githubJson(dependencies, `/git/commits/${candidateSha}`),
    githubJson(dependencies, `/git/commits/${reviewedHeadSha}`),
  ]);
  const commit = (value: unknown, sha: string, linear: boolean) => {
    const item = record(value) ? value : null;
    const tree = record(item?.tree) ? item.tree : null;
    if (
      !item
      || item.sha !== sha
      || typeof tree?.sha !== "string"
      || !SHA_PATTERN.test(tree.sha)
      || !Array.isArray(item.parents)
      || (linear && item.parents.length !== 1)
      || item.parents.some((parent) =>
        !record(parent) || !SHA_PATTERN.test(String(parent.sha)))
    ) fail("reviewed_candidate_invalid");
    return String(tree.sha);
  };
  const treeSha = commit(candidateCommitValue, candidateSha, true);
  if (commit(reviewedCommitValue, reviewedHeadSha, false) !== treeSha) {
    fail("reviewed_candidate_invalid");
  }
  return {
    number: Number(pull.number),
    reviewedHeadSha,
    mergeCommitSha: candidateSha,
    treeSha,
    mergedAt: mergedAt.canonical,
    authorId: Number(user!.id),
    mergedById: Number(mergedBy!.id),
  };
}

function parseCanonicalPrivateJson(
  filename: string,
  readPrivateFile: Dependencies["readPrivateFile"],
  compact = false,
  maximumBytes = MAXIMUM_EVIDENCE_BYTES,
): { readonly source: string; readonly value: JsonRecord } {
  let bytes: Buffer | null = null;
  try {
    bytes = readPrivateFile(filename, maximumBytes);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(source) as unknown;
    if (
      !record(value)
      || (compact ? canonicalCompact(value) : canonical(value)) !== source
    ) fail("receipt_invalid");
    return { source, value };
  } catch (error) {
    if (error instanceof BootstrapPrerequisiteError) throw error;
    fail("receipt_invalid");
  } finally {
    bytes?.fill(0);
  }
  throw new BootstrapPrerequisiteError("receipt_invalid");
}

const WORKER_CHECK_KEYS = [
  "policyExact",
  "githubAuthorityExact",
  "tokenScopesExact",
  "boundaryPreflightExact",
  "targetPreflightExact",
  "operationPreflightExact",
  "durableIntentExact",
  "writeAttemptedAtMostOnce",
  "atomicVariablesExact",
  "acknowledgementExact",
  "postflightAttempted",
  "targetPostflightExact",
  "postflightDeploymentExact",
  "configuredTopologyEvidenceExact",
  "runtimeRoutesPolledExact",
  "runtimeMaintenanceStateExact",
  "boundaryPostflightExact",
  "noOtherProviderChanges",
  "terminalEvidenceExact",
] as const;

const ACTIVATE_RECONCILIATION_CHECK_KEYS = [
  "policyExact",
  "githubAuthorityExact",
  "reviewedAuthorityExact",
  "activationPrerequisitesExact",
  "tokenScopeExact",
  "mutationCredentialsAbsent",
  "boundaryPreflightExact",
  "exactActivatedStateBefore",
  "runtimeActivatedBefore",
  "durableObservationExact",
  "repositoryReasserted",
  "providerReasserted",
  "runtimeReasserted",
  "noProviderWriteAttempted",
  "postflightAttempted",
  "exactActivatedStateAfter",
  "providerStateUnchanged",
  "collateralVariablesUnchanged",
  "runtimeActivatedAfter",
  "boundaryPostflightExact",
  "configuredTopologyEvidenceExact",
  "terminalEvidenceExact",
] as const;

function validateWorkerReceipt(
  source: string,
  value: JsonRecord,
  candidateSha: string,
  operation: "prepare" | "activate",
): ReceiptSummary {
  if (value.schemaVersion === ACTIVATE_RECONCILIATION_RECEIPT_SCHEMA) {
    if (operation !== "activate" || !exactKeys(value, [
      "schemaVersion",
      "executorState",
      "operation",
      "target",
      "outcome",
      "failureCode",
      "candidateSha",
      "startedAt",
      "completedAt",
      "attempts",
      "retryAllowed",
      "observationSha256",
      "prerequisitesVerificationSha256",
      "runnerLossReconciliation",
      "providerEvidence",
      "runtimeEvidence",
      "mutationBoundaryEvidence",
      "checks",
      "nextRequiredProof",
      "normalActivationMutationReceiptClaimed",
      "secretMaterialIncluded",
      "secretDerivedCommitmentsIncluded",
    ])) fail("receipt_invalid");
    const started = timestamp(value.startedAt, "receipt_invalid");
    const completed = timestamp(value.completedAt, "receipt_invalid");
    const runnerLoss = record(value.runnerLossReconciliation)
      ? value.runnerLossReconciliation
      : null;
    const provider = record(value.providerEvidence) ? value.providerEvidence : null;
    const runtime = record(value.runtimeEvidence) ? value.runtimeEvidence : null;
    const beforeRuntime = record(runtime?.before) ? runtime.before : null;
    const afterRuntime = record(runtime?.after) ? runtime.after : null;
    const boundary = record(value.mutationBoundaryEvidence)
      ? value.mutationBoundaryEvidence
      : null;
    const runtimeExact = (proof: JsonRecord | null): boolean => {
      const maintenance = record(proof?.expectedAutomaticMaintenance)
        ? proof.expectedAutomaticMaintenance
        : null;
      const responses = record(proof?.responseSha256s)
        ? proof.responseSha256s
        : null;
      return exactKeys(proof, [
        "required",
        "observed",
        "pollRounds",
        "expectedSourceSha",
        "expectedAutomaticMaintenance",
        "deploymentIdSha256",
        "responseSha256s",
      ]) && proof.required === true && proof.observed === true &&
        Number.isSafeInteger(proof.pollRounds) && Number(proof.pollRounds) >= 1 &&
        proof.expectedSourceSha === candidateSha &&
        exactKeys(maintenance, ["enabled", "candidateBound"]) &&
        maintenance.enabled === true && maintenance.candidateBound === true &&
        SHA256_PATTERN.test(String(proof.deploymentIdSha256)) &&
        exactKeys(responses, ["/health", "/startup", "/ready"]) &&
        [responses["/health"], responses["/startup"], responses["/ready"]]
          .every((item) => SHA256_PATTERN.test(String(item)));
    };
    if (value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED" ||
      value.operation !== "activate" || value.target !== "permanent-staging" ||
      value.outcome !== "reconciled_activated_after_runner_loss" ||
      value.failureCode !== null || value.candidateSha !== candidateSha ||
      completed.milliseconds < started.milliseconds ||
      value.attempts !== 0 || value.retryAllowed !== false ||
      !SHA256_PATTERN.test(String(value.observationSha256)) ||
      !SHA256_PATTERN.test(String(value.prerequisitesVerificationSha256)) ||
      !exactKeys(runnerLoss, [
        "priorAmbiguousActivateRunId",
        "reviewedAuthoritySha256",
        "variableMutationCredentialPresent",
        "providerWriteAttempted",
      ]) ||
      !RUN_ID_PATTERN.test(String(runnerLoss.priorAmbiguousActivateRunId)) ||
      !SHA256_PATTERN.test(String(runnerLoss.reviewedAuthoritySha256)) ||
      runnerLoss.variableMutationCredentialPresent !== false ||
      runnerLoss.providerWriteAttempted !== false ||
      !exactKeys(provider, [
        "providerBeforeSha256",
        "providerAfterSha256",
        "deploymentBeforeIdSha256",
        "deploymentAfterIdSha256",
        "sourceBeforeSha",
        "sourceAfterSha",
        "topologyBeforeSha256",
        "topologyAfterSha256",
        "configuredTopologyEvidence",
        "collateralVariablesBeforeSha256",
        "collateralVariablesAfterSha256",
      ]) ||
      !SHA256_PATTERN.test(String(provider.providerBeforeSha256)) ||
      provider.providerAfterSha256 !== provider.providerBeforeSha256 ||
      !SHA256_PATTERN.test(String(provider.deploymentBeforeIdSha256)) ||
      provider.deploymentAfterIdSha256 !== provider.deploymentBeforeIdSha256 ||
      provider.sourceBeforeSha !== candidateSha ||
      provider.sourceAfterSha !== candidateSha ||
      !SHA256_PATTERN.test(String(provider.topologyBeforeSha256)) ||
      provider.topologyAfterSha256 !== provider.topologyBeforeSha256 ||
      !workerFenceTopologyEvidenceExact(
        provider.configuredTopologyEvidence,
        {
          target: "permanent-staging",
          operation: "activate",
          writeAttempted: false,
        },
      ) ||
      !SHA256_PATTERN.test(String(provider.collateralVariablesBeforeSha256)) ||
      provider.collateralVariablesAfterSha256 !==
        provider.collateralVariablesBeforeSha256 ||
      !exactKeys(runtime, ["before", "after"]) ||
      !runtimeExact(beforeRuntime) || !runtimeExact(afterRuntime) ||
      beforeRuntime?.deploymentIdSha256 !== provider.deploymentBeforeIdSha256 ||
      afterRuntime?.deploymentIdSha256 !== provider.deploymentAfterIdSha256 ||
      !exactKeys(boundary, ["preflightReceiptSha256", "postflightReceiptSha256"]) ||
      !SHA256_PATTERN.test(String(boundary.preflightReceiptSha256)) ||
      !SHA256_PATTERN.test(String(boundary.postflightReceiptSha256)) ||
      !exactTrueChecks(value.checks, ACTIVATE_RECONCILIATION_CHECK_KEYS) ||
      value.nextRequiredProof !== "ACTIVE_DEPLOYMENT_AND_SCALE_EVIDENCE" ||
      value.normalActivationMutationReceiptClaimed !== false ||
      value.secretMaterialIncluded !== false ||
      value.secretDerivedCommitmentsIncluded !== false) fail("receipt_invalid");
    return {
      filename: "automatic-maintenance-worker-fence-terminal.json",
      schemaVersion: ACTIVATE_RECONCILIATION_RECEIPT_SCHEMA,
      sha256: sha256(source),
      outcome: "reconciled_activated_after_runner_loss",
      candidateSha,
      sourceSha: candidateSha,
      deploymentIdSha256: String(provider.deploymentAfterIdSha256),
      replicasBefore: 1,
      replicasAfter: 1,
      startedAtMs: started.milliseconds,
      completedAtMs: completed.milliseconds,
    };
  }
  if (!exactKeys(value, [
    "schemaVersion",
    "executorState",
    "binding",
    "bindingSha256",
    "outcome",
    "attempts",
    "retryAllowed",
    "failureCode",
    "authoritySha256",
    "intentSha256",
    "providerEvidence",
    "runtimeEvidence",
    "mutationBoundaryEvidence",
    "checks",
    "stagingBootstrapVerification",
    "productionDeploymentVerification",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ])) fail("receipt_invalid");
  const binding = record(value.binding) ? value.binding : null;
  const variables = record(binding?.configuredVariables)
    ? binding.configuredVariables
    : null;
  const provider = record(value.providerEvidence) ? value.providerEvidence : null;
  const runtime = record(value.runtimeEvidence) ? value.runtimeEvidence : null;
  const automaticMaintenance = record(runtime?.expectedAutomaticMaintenance)
    ? runtime.expectedAutomaticMaintenance
    : null;
  const responses = record(runtime?.responseSha256s)
    ? runtime.responseSha256s
    : null;
  const boundary = record(value.mutationBoundaryEvidence)
    ? value.mutationBoundaryEvidence
    : null;
  const staging = record(value.stagingBootstrapVerification)
    ? value.stagingBootstrapVerification
    : null;
  const production = record(value.productionDeploymentVerification)
    ? value.productionDeploymentVerification
    : null;
  const enabled = operation === "activate";
  const outcome = operation === "prepare" ? "prepared" : "activated";
  if (
    value.schemaVersion !== WORKER_RECEIPT_SCHEMA
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || !exactKeys(binding, [
      "policySha256",
      "candidateSha",
      "target",
      "operation",
      "projectId",
      "environmentId",
      "serviceId",
      "configuredVariables",
      "skipDeploys",
    ])
    || binding.policySha256 !== WORKER_POLICY_SHA256
    || binding.candidateSha !== candidateSha
    || binding.target !== "permanent-staging"
    || binding.operation !== operation
    || binding.projectId !== PROJECT_ID
    || binding.environmentId !== ENVIRONMENT_ID
    || binding.serviceId !== SERVICE_ID
    || !exactKeys(variables, [
      "PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED",
      "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
    ])
    || variables.PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED !== String(enabled)
    || variables.PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA !== candidateSha
    || binding.skipDeploys !== !enabled
    || value.bindingSha256 !== sha256(canonical(binding))
    || value.outcome !== outcome
    || value.attempts !== 1
    || value.retryAllowed !== false
    || value.failureCode !== null
    || !SHA256_PATTERN.test(String(value.authoritySha256))
    || !SHA256_PATTERN.test(String(value.intentSha256))
    || !exactKeys(provider, [
      "graphqlOperation",
      "mutationCallCount",
      "acknowledgementExact",
      "providerBeforeSha256",
      "providerImmediatelyBeforeWriteSha256",
      "providerAfterSha256",
      "deploymentBeforeIdSha256",
      "deploymentAfterIdSha256",
      "sourceBeforeSha",
      "sourceAfterSha",
      "sourcePreservedExact",
      "deploymentIdChanged",
      "topologyBeforeSha256",
      "topologyImmediatelyBeforeWriteSha256",
      "topologyAfterSha256",
      "configuredTopologyEvidence",
      "collateralVariablesBeforeSha256",
      "collateralVariablesAfterSha256",
    ])
    || provider.graphqlOperation !== "variableCollectionUpsert"
    || provider.mutationCallCount !== 1
    || provider.acknowledgementExact !== true
    || !SHA256_PATTERN.test(String(provider.providerBeforeSha256))
    || provider.providerImmediatelyBeforeWriteSha256
      !== provider.providerBeforeSha256
    || !SHA256_PATTERN.test(String(provider.providerAfterSha256))
    || !SHA256_PATTERN.test(String(provider.deploymentBeforeIdSha256))
    || !SHA256_PATTERN.test(String(provider.deploymentAfterIdSha256))
    || !SHA_PATTERN.test(String(provider.sourceBeforeSha))
    || !SHA_PATTERN.test(String(provider.sourceAfterSha))
    || provider.sourcePreservedExact !== true
    || provider.deploymentIdChanged !== enabled
    || !SHA256_PATTERN.test(String(provider.topologyBeforeSha256))
    || provider.topologyImmediatelyBeforeWriteSha256
      !== provider.topologyBeforeSha256
    || !SHA256_PATTERN.test(String(provider.topologyAfterSha256))
    || provider.topologyAfterSha256 !== provider.topologyBeforeSha256
    || !workerFenceTopologyEvidenceExact(
      provider.configuredTopologyEvidence,
      {
        target: "permanent-staging",
        operation,
        writeAttempted: true,
      },
    )
    || !SHA256_PATTERN.test(String(provider.collateralVariablesBeforeSha256))
    || provider.collateralVariablesAfterSha256
      !== provider.collateralVariablesBeforeSha256
    || !exactKeys(runtime, [
      "required",
      "observed",
      "pollRounds",
      "expectedSourceSha",
      "expectedAutomaticMaintenance",
      "deploymentIdSha256",
      "responseSha256s",
    ])
    || runtime.required !== enabled
    || runtime.observed !== enabled
    || (enabled
      ? !Number.isSafeInteger(runtime.pollRounds)
        || Number(runtime.pollRounds) < 1
        || runtime.expectedSourceSha !== candidateSha
        || !exactKeys(automaticMaintenance, ["enabled", "candidateBound"])
        || automaticMaintenance.enabled !== true
        || automaticMaintenance.candidateBound !== true
        || runtime.deploymentIdSha256 !== provider.deploymentAfterIdSha256
      : runtime.pollRounds !== 0
        || runtime.expectedSourceSha !== null
        || runtime.expectedAutomaticMaintenance !== null
        || runtime.deploymentIdSha256 !== null)
    || !exactKeys(responses, ["/health", "/startup", "/ready"])
    || (enabled
      ? !SHA256_PATTERN.test(String(responses["/health"]))
        || !SHA256_PATTERN.test(String(responses["/startup"]))
        || !SHA256_PATTERN.test(String(responses["/ready"]))
      : responses["/health"] !== null
        || responses["/startup"] !== null
        || responses["/ready"] !== null)
    || !exactKeys(boundary, [
      "preflightReceiptSha256",
      "postflightReceiptSha256",
    ])
    || !SHA256_PATTERN.test(String(boundary.preflightReceiptSha256))
    || !SHA256_PATTERN.test(String(boundary.postflightReceiptSha256))
    || !exactTrueChecks(value.checks, WORKER_CHECK_KEYS)
    || !exactKeys(staging, [
      "preparedReceiptExact",
      "sufficientWithoutQuiescenceProof",
      "nextRequiredProof",
      "legacySourceRuntimeFenceClaimed",
    ])
    || staging.preparedReceiptExact !== (operation === "prepare")
    || staging.sufficientWithoutQuiescenceProof !== false
    || staging.nextRequiredProof !== "EXACT_SCALE_1_TO_0_QUIESCENCE_PROOF"
    || staging.legacySourceRuntimeFenceClaimed !== false
    || !exactKeys(production, [
      "requiredReceiptFilename",
      "eligible",
      "exactCandidateTargetOperationBindingRequired",
      "bindingSha256Required",
      "oldRuntimeSafetyPrerequisite",
      "oldRuntimeSafetyVerifiedByThisOperation",
    ])
    || production.requiredReceiptFilename
      !== "automatic-maintenance-worker-fence-terminal.json"
    || production.eligible !== false
    || production.exactCandidateTargetOperationBindingRequired !== true
    || production.bindingSha256Required !== true
    || production.oldRuntimeSafetyPrerequisite !== null
    || production.oldRuntimeSafetyVerifiedByThisOperation !== false
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
  ) fail("receipt_invalid");
  if (operation === "prepare") {
    if (
      provider.sourceAfterSha !== provider.sourceBeforeSha
      || provider.deploymentAfterIdSha256 !== provider.deploymentBeforeIdSha256
      || provider.topologyAfterSha256 !== provider.topologyBeforeSha256
    ) fail("receipt_invalid");
  } else if (provider.sourceAfterSha !== candidateSha) {
    fail("receipt_invalid");
  }
  return {
    filename: "automatic-maintenance-worker-fence-terminal.json",
    schemaVersion: WORKER_RECEIPT_SCHEMA,
    sha256: sha256(source),
    outcome,
    candidateSha,
    sourceSha: String(provider.sourceAfterSha),
    deploymentIdSha256: String(provider.deploymentAfterIdSha256),
    replicasBefore: 1,
    replicasAfter: 1,
    startedAtMs: null,
    completedAtMs: null,
  };
}

const COLD_PREPARE_CHECK_KEYS = [
  "policyExact",
  "githubAuthorityExact",
  "replacementPrerequisiteExact",
  "tokenScopesExact",
  "boundaryPreflightExact",
  "exactDeadStateBefore",
  "requiredVariablesBeforeExact",
  "serviceRoleSealedBefore",
  "durableIntentExact",
  "repositoryPrewriteReasserted",
  "providerPrewriteReasserted",
  "writeAttemptedAtMostOnce",
  "atomicVariablesExact",
  "acknowledgementExact",
  "postflightAttempted",
  "exactDeadStateAfter",
  "maintenanceRowsAfterExact",
  "deploymentAndTopologyUnchanged",
  "collateralVariablesUnchanged",
  "boundaryPostflightExact",
  "terminalEvidenceExact",
] as const;

const COLD_PREPARE_RECONCILIATION_CHECK_KEYS = [
  "policyExact",
  "githubAuthorityExact",
  "reviewedAuthorityExact",
  "replacementPrerequisiteExact",
  "tokenScopeExact",
  "mutationCredentialsAbsent",
  "boundaryPreflightExact",
  "exactPreparedDeadStateBefore",
  "maintenanceRowsBeforeExact",
  "serviceRoleSealedBefore",
  "runtimeAbsentBefore",
  "durableObservationExact",
  "repositoryReasserted",
  "providerReasserted",
  "runtimeReasserted",
  "noProviderWriteAttempted",
  "postflightAttempted",
  "exactPreparedDeadStateAfter",
  "maintenanceRowsAfterExact",
  "serviceRoleSealedAfter",
  "deploymentSourceAndTopologyUnchanged",
  "collateralVariablesUnchanged",
  "runtimeAbsentAfter",
  "boundaryPostflightExact",
  "terminalEvidenceExact",
] as const;

const COLD_QUIESCE_CHECK_KEYS = [
  "policyExact",
  "githubAuthorityExact",
  "externalMutationFreezeAttested",
  "successorBridgeExact",
  "successorBridgeTopologyExact",
  "successorBridgePrewriteReasserted",
  "preparePrerequisiteExact",
  "tokenScopesExact",
  "directMutationContractExact",
  "boundaryPreflightExact",
  "exactDeadStateBefore",
  "maintenanceRowsBeforeExact",
  "runtimeAbsentBefore",
  "durableIntentExact",
  "repositoryPrewriteReasserted",
  "providerPrewriteReasserted",
  "runtimePrewriteReasserted",
  "writeAttemptedAtMostOnce",
  "mutationResponseClassified",
  "acknowledgementExact",
  "lostAcknowledgementExact",
  "postflightAttempted",
  "exactZeroStateAfter",
  "configuredTopologyTransitionExact",
  "maintenanceRowsAfterExact",
  "deploymentSourceAndTopologyUnchanged",
  "collateralVariablesUnchanged",
  "runtimeAbsentAfter",
  "boundaryPostflightExact",
  "terminalEvidenceExact",
] as const;

const COLD_RECONCILE_QUIESCE_CHECK_KEYS = [
  "policyExact",
  "githubAuthorityExact",
  "reviewedAuthorityExact",
  "successorBridgeExact",
  "preparePrerequisiteExact",
  "tokenScopeExact",
  "scaleCredentialAbsent",
  "boundaryPreflightExact",
  "exactZeroStateBefore",
  "maintenanceRowsBeforeExact",
  "runtimeAbsentBefore",
  "durableObservationExact",
  "repositoryReasserted",
  "providerReasserted",
  "runtimeReasserted",
  "noProviderWriteAttempted",
  "postflightAttempted",
  "exactZeroStateAfter",
  "maintenanceRowsAfterExact",
  "deploymentSourceAndTopologyUnchanged",
  "collateralVariablesUnchanged",
  "runtimeAbsentAfter",
  "boundaryPostflightExact",
  "terminalEvidenceExact",
] as const;

const COLD_CONFIGURED_REGION_BEFORE = "europe-west4-drams3a" as const;
const COLD_DEPLOYMENT_REGION = "asia-southeast1-eqsg3a" as const;
const COLD_ALLOWED_QUIESCE_REGIONS = new Set<string>([
  COLD_CONFIGURED_REGION_BEFORE,
  COLD_DEPLOYMENT_REGION,
]);

interface ColdConfiguredRegion {
  readonly region: string;
  readonly numReplicas: number;
}

function coldConfiguredRegions(
  value: unknown,
  expected: "one" | "zero",
): readonly ColdConfiguredRegion[] | null {
  if (!Array.isArray(value) || value.length > COLD_ALLOWED_QUIESCE_REGIONS.size) {
    return null;
  }
  const regions: ColdConfiguredRegion[] = [];
  for (const entry of value) {
    if (!exactKeys(entry, ["region", "numReplicas"]) ||
      typeof entry.region !== "string" ||
      !COLD_ALLOWED_QUIESCE_REGIONS.has(entry.region) ||
      typeof entry.numReplicas !== "number" ||
      !Number.isSafeInteger(entry.numReplicas) ||
      entry.numReplicas < 0 || entry.numReplicas > 1) return null;
    regions.push({ region: entry.region, numReplicas: entry.numReplicas });
  }
  if (new Set(regions.map((entry) => entry.region)).size !== regions.length ||
    regions.some((entry, index) =>
      index > 0 && regions[index - 1]!.region >= entry.region)) return null;
  if (expected === "one") {
    return canonical(regions) === canonical([{
      region: COLD_CONFIGURED_REGION_BEFORE,
      numReplicas: 1,
    }]) ? regions : null;
  }
  return regions.every((entry) => entry.numReplicas === 0) ? regions : null;
}

function validateColdProviderEvidence(
  value: unknown,
  prepare: boolean,
): JsonRecord {
  const commonKeys = [
    "deploymentIdSha256",
    "snapshotIdSha256",
    "stateBeforeSha256",
    "stateAfterSha256",
    "topologyBeforeSha256",
    "topologyAfterSha256",
    "configuredTopologyBeforeSha256",
    "configuredTopologyAfterSha256",
    "collateralVariablesBeforeSha256",
    "collateralVariablesAfterSha256",
    "sourceDisconnectedBefore",
    "sourceDisconnectedAfter",
    "stagedPatchEmptyBefore",
    "stagedPatchEmptyAfter",
  ] as const;
  const expectedKeys = prepare
    ? ["graphqlOperation", "acknowledgementExact", ...commonKeys]
    : commonKeys;
  if (!exactKeys(value, expectedKeys) ||
    (prepare && (value.graphqlOperation !== "variableCollectionUpsert" ||
      value.acknowledgementExact !== true)) || [
    value.deploymentIdSha256,
    value.snapshotIdSha256,
    value.stateBeforeSha256,
    value.stateAfterSha256,
    value.topologyBeforeSha256,
    value.topologyAfterSha256,
    value.configuredTopologyBeforeSha256,
    value.configuredTopologyAfterSha256,
    value.collateralVariablesBeforeSha256,
    value.collateralVariablesAfterSha256,
  ].some((item) => !SHA256_PATTERN.test(String(item)))
    || value.topologyAfterSha256 !== value.topologyBeforeSha256
    || value.collateralVariablesAfterSha256
      !== value.collateralVariablesBeforeSha256
    || value.sourceDisconnectedBefore !== true
    || value.sourceDisconnectedAfter !== true
    || value.stagedPatchEmptyBefore !== true
    || value.stagedPatchEmptyAfter !== true
  ) fail("receipt_invalid");
  return value;
}

function validateColdPrepareReceipt(
  source: string,
  value: JsonRecord,
  candidateSha: string,
): ReceiptSummary {
  if (value.schemaVersion === COLD_PREPARE_RECONCILIATION_RECEIPT_SCHEMA) {
    if (!exactKeys(value, [
      "schemaVersion",
      "executorState",
      "operation",
      "target",
      "outcome",
      "failureCode",
      "candidateSha",
      "sourceSha",
      "startedAt",
      "completedAt",
      "replicasBefore",
      "replicasAfter",
      "configuredReplicasBefore",
      "configuredReplicasAfter",
      "configuredRegionsBefore",
      "configuredRegionsAfter",
      "attempts",
      "retryAllowed",
      "observationSha256",
      "replacementPrerequisite",
      "runnerLossReconciliation",
      "providerEvidence",
      "mutationBoundaryEvidence",
      "checks",
      "nextRequiredProof",
      "normalPrepareMutationReceiptClaimed",
      "secretMaterialIncluded",
      "secretDerivedCommitmentsIncluded",
    ])) fail("receipt_invalid");
    const started = timestamp(value.startedAt, "receipt_invalid");
    const completed = timestamp(value.completedAt, "receipt_invalid");
    const replacement = record(value.replacementPrerequisite)
      ? value.replacementPrerequisite
      : null;
    const runnerLoss = record(value.runnerLossReconciliation)
      ? value.runnerLossReconciliation
      : null;
    const provider = validateColdProviderEvidence(value.providerEvidence, false);
    const boundary = record(value.mutationBoundaryEvidence)
      ? value.mutationBoundaryEvidence
      : null;
    const configuredBefore = coldConfiguredRegions(
      value.configuredRegionsBefore,
      "one",
    );
    const configuredAfter = coldConfiguredRegions(
      value.configuredRegionsAfter,
      "one",
    );
    if (value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED" ||
      value.operation !== "cold-prepare" ||
      value.target !== "permanent-staging" ||
      value.outcome !== "reconciled_prepared_after_runner_loss" ||
      value.failureCode !== null || value.candidateSha !== candidateSha ||
      value.sourceSha !== COLD_SOURCE_SHA ||
      completed.milliseconds < started.milliseconds ||
      value.replicasBefore !== null || value.replicasAfter !== null ||
      value.configuredReplicasBefore !== 1 ||
      value.configuredReplicasAfter !== 1 ||
      configuredBefore === null || configuredAfter === null ||
      canonical(configuredBefore) !== canonical(configuredAfter) ||
      provider.configuredTopologyBeforeSha256 !==
        sha256(canonical(configuredBefore)) ||
      provider.configuredTopologyAfterSha256 !==
        sha256(canonical(configuredAfter)) ||
      value.attempts !== 0 || value.retryAllowed !== false ||
      !SHA256_PATTERN.test(String(value.observationSha256)) ||
      !exactKeys(replacement, ["runId", "terminalSha256"]) ||
      !RUN_ID_PATTERN.test(String(replacement.runId)) ||
      !SHA256_PATTERN.test(String(replacement.terminalSha256)) ||
      !exactKeys(runnerLoss, [
        "priorAmbiguousPrepareRunId",
        "reviewedAuthoritySha256",
        "mutationCredentialPresent",
        "providerWriteAttempted",
      ]) ||
      !RUN_ID_PATTERN.test(String(runnerLoss.priorAmbiguousPrepareRunId)) ||
      !SHA256_PATTERN.test(String(runnerLoss.reviewedAuthoritySha256)) ||
      runnerLoss.mutationCredentialPresent !== false ||
      runnerLoss.providerWriteAttempted !== false ||
      !exactKeys(boundary, ["preflightReceiptSha256", "postflightReceiptSha256"]) ||
      !SHA256_PATTERN.test(String(boundary.preflightReceiptSha256)) ||
      !SHA256_PATTERN.test(String(boundary.postflightReceiptSha256)) ||
      !exactTrueChecks(value.checks, COLD_PREPARE_RECONCILIATION_CHECK_KEYS) ||
      value.nextRequiredProof !==
        "EXACT_CONFIGURED_ONE_TO_ZERO_QUIESCENCE_PROOF" ||
      value.normalPrepareMutationReceiptClaimed !== false ||
      value.secretMaterialIncluded !== false ||
      value.secretDerivedCommitmentsIncluded !== false) fail("receipt_invalid");
    return {
      filename: "cold-prepare-terminal.json",
      schemaVersion: COLD_PREPARE_RECONCILIATION_RECEIPT_SCHEMA,
      sha256: sha256(source),
      outcome: "reconciled_prepared_after_runner_loss",
      candidateSha,
      sourceSha: COLD_SOURCE_SHA,
      deploymentIdSha256: String(provider.deploymentIdSha256),
      replicasBefore: 1,
      replicasAfter: 1,
      startedAtMs: started.milliseconds,
      completedAtMs: completed.milliseconds,
    };
  }
  if (!exactKeys(value, [
    "schemaVersion",
    "executorState",
    "operation",
    "target",
    "outcome",
    "failureCode",
    "candidateSha",
    "sourceSha",
    "startedAt",
    "completedAt",
    "replicasBefore",
    "replicasAfter",
    "configuredReplicasBefore",
    "configuredReplicasAfter",
    "configuredRegionsBefore",
    "configuredRegionsAfter",
    "attempts",
    "retryAllowed",
    "intentSha256",
    "replacementPrerequisite",
    "providerEvidence",
    "mutationBoundaryEvidence",
    "checks",
    "nextRequiredProof",
    "normalOneToZeroReceiptClaimed",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ])) fail("receipt_invalid");
  const started = timestamp(value.startedAt, "receipt_invalid");
  const completed = timestamp(value.completedAt, "receipt_invalid");
  const provider = validateColdProviderEvidence(value.providerEvidence, true);
  const replacement = record(value.replacementPrerequisite)
    ? value.replacementPrerequisite
    : null;
  const boundary = record(value.mutationBoundaryEvidence)
    ? value.mutationBoundaryEvidence
    : null;
  const configuredBefore = coldConfiguredRegions(
    value.configuredRegionsBefore,
    "one",
  );
  const configuredAfter = coldConfiguredRegions(
    value.configuredRegionsAfter,
    "one",
  );
  if (
    value.schemaVersion !== COLD_PREPARE_RECEIPT_SCHEMA
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || value.operation !== "cold-prepare"
    || value.target !== "permanent-staging"
    || value.outcome !== "prepared_cold"
    || value.failureCode !== null
    || value.candidateSha !== candidateSha
    || value.sourceSha !== COLD_SOURCE_SHA
    || completed.milliseconds < started.milliseconds
    || value.replicasBefore !== null
    || value.replicasAfter !== null
    || value.configuredReplicasBefore !== 1
    || value.configuredReplicasAfter !== 1
    || configuredBefore === null
    || configuredAfter === null
    || canonical(configuredBefore) !== canonical(configuredAfter)
    || provider.configuredTopologyBeforeSha256 !==
      sha256(canonical(configuredBefore))
    || provider.configuredTopologyAfterSha256 !==
      sha256(canonical(configuredAfter))
    || value.attempts !== 1
    || value.retryAllowed !== false
    || !SHA256_PATTERN.test(String(value.intentSha256))
    || !exactKeys(replacement, ["runId", "terminalSha256"])
    || !RUN_ID_PATTERN.test(String(replacement.runId))
    || !SHA256_PATTERN.test(String(replacement.terminalSha256))
    || !exactKeys(boundary, ["preflightReceiptSha256", "postflightReceiptSha256"])
    || !SHA256_PATTERN.test(String(boundary.preflightReceiptSha256))
    || !SHA256_PATTERN.test(String(boundary.postflightReceiptSha256))
    || !exactTrueChecks(value.checks, COLD_PREPARE_CHECK_KEYS)
    || value.nextRequiredProof !==
      "EXACT_CONFIGURED_ONE_TO_ZERO_QUIESCENCE_PROOF"
    || value.normalOneToZeroReceiptClaimed !== false
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
  ) fail("receipt_invalid");
  return {
    filename: "cold-prepare-terminal.json",
    schemaVersion: COLD_PREPARE_RECEIPT_SCHEMA,
    sha256: sha256(source),
    outcome: "prepared_cold",
    candidateSha,
    sourceSha: COLD_SOURCE_SHA,
    deploymentIdSha256: String(provider.deploymentIdSha256),
    replicasBefore: 1,
    replicasAfter: 1,
    startedAtMs: started.milliseconds,
    completedAtMs: completed.milliseconds,
  };
}

function validateColdQuiesceReceipt(
  source: string,
  value: JsonRecord,
  candidateSha: string,
): ReceiptSummary {
  if (!exactKeys(value, [
    "schemaVersion",
    "executorState",
    "operation",
    "target",
    "outcome",
    "failureCode",
    "candidateSha",
    "sourceSha",
    "startedAt",
    "completedAt",
    "configuredReplicasBefore",
    "configuredReplicasAfter",
    "configuredRegionsBefore",
    "configuredRegionsAfter",
    "legacyReplicasBefore",
    "legacyReplicasAfter",
    "attempts",
    "retryAllowed",
    "intentSha256",
    "preparePrerequisite",
    "successorBridge",
    "runnerLossReconciliation",
    "directMutationEvidence",
    "providerEvidence",
    "mutationBoundaryEvidence",
    "checks",
    "nextRequiredProof",
    "configuredOneToZeroReceiptClaimed",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ])) fail("receipt_invalid");
  const started = timestamp(value.startedAt, "receipt_invalid");
  const completed = timestamp(value.completedAt, "receipt_invalid");
  const prerequisite = record(value.preparePrerequisite)
    ? value.preparePrerequisite
    : null;
  const directMutation = record(value.directMutationEvidence)
    ? value.directMutationEvidence
    : null;
  const successorBridge = record(value.successorBridge)
    ? value.successorBridge
    : null;
  const runnerLoss = record(value.runnerLossReconciliation)
    ? value.runnerLossReconciliation
    : null;
  const provider = validateColdProviderEvidence(value.providerEvidence, false);
  const boundary = record(value.mutationBoundaryEvidence)
    ? value.mutationBoundaryEvidence
    : null;
  const reconciled = value.outcome === "reconciled_configured_zero";
  const configuredZero = value.outcome === "configured_zero";
  const runnerLossReconciled =
    value.outcome === "reconciled_configured_zero_after_runner_loss";
  const configuredBefore = coldConfiguredRegions(
    value.configuredRegionsBefore,
    runnerLossReconciled ? "zero" : "one",
  );
  const configuredAfter = coldConfiguredRegions(
    value.configuredRegionsAfter,
    "zero",
  );
  const checks = record(value.checks) ? value.checks : null;
  const commonChecks = COLD_QUIESCE_CHECK_KEYS.filter(
    (key) =>
      key !== "acknowledgementExact" && key !== "lostAcknowledgementExact",
  );
  const checkRelationExact = exactKeys(checks, COLD_QUIESCE_CHECK_KEYS) &&
    commonChecks.every((key) => checks[key] === true) &&
    checks.acknowledgementExact === configuredZero &&
    checks.lostAcknowledgementExact === reconciled;
  const runnerLossChecksExact = exactTrueChecks(
    checks,
    COLD_RECONCILE_QUIESCE_CHECK_KEYS,
  );
  const successorVerifiedAt = timestamp(
    successorBridge?.verifiedAt,
    "receipt_invalid",
  );
  const successorBridgeRelationExact = exactKeys(successorBridge, [
    "bridgeSha256",
    "reviewedAuthoritySha256",
    "currentRunId",
    "currentPrepareRunId",
    "priorCandidateSha",
    "priorQuiesceRunId",
    "priorArtifactId",
    "priorArtifactDigest",
    "liveStateSha256",
    "verifiedAt",
    "deadline",
  ]) &&
    SHA256_PATTERN.test(String(successorBridge.bridgeSha256)) &&
    SHA256_PATTERN.test(String(successorBridge.reviewedAuthoritySha256)) &&
    RUN_ID_PATTERN.test(String(successorBridge.currentRunId)) &&
    RUN_ID_PATTERN.test(String(successorBridge.currentPrepareRunId)) &&
    successorBridge.priorCandidateSha ===
      COLD_QUIESCE_SUCCESSOR_BINDING.priorCandidateSha &&
    successorBridge.priorQuiesceRunId ===
      COLD_QUIESCE_SUCCESSOR_BINDING.priorQuiesceRunId &&
    successorBridge.priorArtifactId ===
      COLD_QUIESCE_SUCCESSOR_BINDING.priorArtifactId &&
    successorBridge.priorArtifactDigest ===
      COLD_QUIESCE_SUCCESSOR_BINDING.priorArtifactDigest &&
    SHA256_PATTERN.test(String(successorBridge.liveStateSha256)) &&
    successorBridge.deadline === COLD_QUIESCE_SUCCESSOR_BINDING.deadline &&
    successorVerifiedAt.milliseconds >=
      Date.parse(COLD_QUIESCE_SUCCESSOR_BINDING.priorCompletedAt) &&
    successorVerifiedAt.milliseconds <
      Date.parse(COLD_QUIESCE_SUCCESSOR_BINDING.deadline) &&
    successorVerifiedAt.milliseconds <= started.milliseconds &&
    (runnerLossReconciled || successorBridge.liveStateSha256 ===
      provider.stateBeforeSha256);
  const commitMessage = successorBridgeRelationExact
    ? `PintPath cold quiesce ${candidateSha} run ${String(successorBridge.currentRunId)}`
    : "";
  const expectedVariables = railwayEnvironmentPatchCommitVariables({
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    regions: [
      { region: COLD_DEPLOYMENT_REGION, numReplicas: 0 },
      { region: COLD_CONFIGURED_REGION_BEFORE, numReplicas: 0 },
    ],
    commitMessage,
  });
  const expectedVariablesSource = expectedVariables === null
    ? null
    : JSON.stringify(expectedVariables);
  const expectedRequestSource = expectedVariables === null
    ? null
    : JSON.stringify({
      operationName: RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME,
      query: RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION,
      variables: expectedVariables,
    });
  const directMutationBaseExact = exactKeys(directMutation, [
    "operationName",
    "operation",
    "transportOutcome",
    "querySha256",
    "variablesSha256",
    "requestBodySha256",
    "responseBodySha256",
    "acknowledgementSha256",
    "acknowledgementExact",
    "commitMessageSha256",
    "zeroRegionsEncodedAsJsonNull",
  ]) && directMutation.operationName ===
      RAILWAY_ENVIRONMENT_PATCH_COMMIT_OPERATION_NAME &&
    directMutation.operation === "environmentPatchCommit" &&
    directMutation.querySha256 ===
      sha256(RAILWAY_ENVIRONMENT_PATCH_COMMIT_MUTATION);
  const directMutationRelationExact = runnerLossReconciled
    ? directMutationBaseExact &&
      directMutation.transportOutcome === "not_attempted" &&
      directMutation.variablesSha256 === null &&
      directMutation.requestBodySha256 === null &&
      directMutation.responseBodySha256 === null &&
      directMutation.acknowledgementSha256 === null &&
      directMutation.acknowledgementExact === false &&
      directMutation.commitMessageSha256 === null &&
      directMutation.zeroRegionsEncodedAsJsonNull === false
    : directMutationBaseExact && expectedVariablesSource !== null &&
      expectedRequestSource !== null &&
      directMutation.variablesSha256 === sha256(expectedVariablesSource) &&
      directMutation.requestBodySha256 === sha256(expectedRequestSource) &&
      directMutation.commitMessageSha256 === sha256(commitMessage) &&
      directMutation.zeroRegionsEncodedAsJsonNull === true &&
      (directMutation.responseBodySha256 === null ||
        SHA256_PATTERN.test(String(directMutation.responseBodySha256))) &&
      (configuredZero
        ? directMutation.transportOutcome === "acknowledged" &&
          SHA256_PATTERN.test(String(directMutation.responseBodySha256)) &&
          SHA256_PATTERN.test(String(directMutation.acknowledgementSha256)) &&
          directMutation.acknowledgementExact === true
        : reconciled &&
          directMutation.transportOutcome === "transport_uncertain" &&
          directMutation.acknowledgementSha256 === null &&
          directMutation.acknowledgementExact === false);
  const runnerLossRelationExact = runnerLossReconciled &&
    value.configuredReplicasBefore === 0 &&
    value.configuredReplicasAfter === 0 &&
    configuredBefore !== null && configuredAfter !== null &&
    canonical(configuredBefore) === canonical(configuredAfter) &&
    value.legacyReplicasBefore === value.legacyReplicasAfter &&
    value.attempts === 0 &&
    exactKeys(runnerLoss, [
      "priorAmbiguousQuiesceRunId",
      "reviewedAuthoritySha256",
      "scaleCredentialPresent",
      "providerWriteAttempted",
    ]) &&
    RUN_ID_PATTERN.test(String(runnerLoss.priorAmbiguousQuiesceRunId)) &&
    successorBridge?.currentRunId === runnerLoss.priorAmbiguousQuiesceRunId &&
    SHA256_PATTERN.test(String(runnerLoss.reviewedAuthoritySha256)) &&
    runnerLoss.scaleCredentialPresent === false &&
    runnerLoss.providerWriteAttempted === false &&
    directMutationRelationExact &&
    runnerLossChecksExact;
  if (
    value.schemaVersion !== COLD_QUIESCE_RECEIPT_SCHEMA
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || value.operation !== "cold-quiesce"
    || value.target !== "permanent-staging"
    || (!configuredZero && !reconciled && !runnerLossReconciled)
    || value.failureCode !== null
    || value.candidateSha !== candidateSha
    || value.sourceSha !== COLD_SOURCE_SHA
    || completed.milliseconds < started.milliseconds
    || (!runnerLossReconciled && value.configuredReplicasBefore !== 1)
    || value.configuredReplicasAfter !== 0
    || configuredBefore === null
    || configuredAfter === null
    || !(value.legacyReplicasBefore === null || value.legacyReplicasBefore === 0)
    || !(value.legacyReplicasAfter === null || value.legacyReplicasAfter === 0)
    || (!runnerLossReconciled && value.legacyReplicasBefore !== null)
    || provider.configuredTopologyBeforeSha256 !==
      sha256(canonical(configuredBefore))
    || provider.configuredTopologyAfterSha256 !==
      sha256(canonical(configuredAfter))
    || (!runnerLossReconciled && value.attempts !== 1)
    || value.retryAllowed !== false
    || !SHA256_PATTERN.test(String(value.intentSha256))
    || !exactKeys(prerequisite, ["runId", "verificationSha256"])
    || !RUN_ID_PATTERN.test(String(prerequisite.runId))
    || successorBridge?.currentPrepareRunId !== prerequisite.runId
    || !SHA256_PATTERN.test(String(prerequisite.verificationSha256))
    || !directMutationRelationExact
    || !successorBridgeRelationExact
    || (runnerLossReconciled
      ? !runnerLossRelationExact
      : runnerLoss !== null || !checkRelationExact)
    || !exactKeys(boundary, ["preflightReceiptSha256", "postflightReceiptSha256"])
    || !SHA256_PATTERN.test(String(boundary.preflightReceiptSha256))
    || !SHA256_PATTERN.test(String(boundary.postflightReceiptSha256))
    || value.nextRequiredProof !== "EXACT_CANDIDATE_UPLOAD_AT_CONFIGURED_ZERO"
    || value.configuredOneToZeroReceiptClaimed !== !runnerLossReconciled
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
  ) fail("receipt_invalid");
  return {
    filename: "cold-quiesce-receipt.json",
    schemaVersion: COLD_QUIESCE_RECEIPT_SCHEMA,
    sha256: sha256(source),
    outcome: runnerLossReconciled
      ? "reconciled_configured_zero_after_runner_loss"
      : configuredZero
      ? "configured_zero"
      : "reconciled_configured_zero",
    candidateSha,
    sourceSha: COLD_SOURCE_SHA,
    deploymentIdSha256: String(provider.deploymentIdSha256),
    replicasBefore: runnerLossReconciled ? 0 : 1,
    replicasAfter: 0,
    startedAtMs: started.milliseconds,
    completedAtMs: completed.milliseconds,
  };
}

const SCALE_CHECK_KEYS = [
  "policyExact",
  "githubAuthorityExact",
  "tokenScopesExact",
  "cliExact",
  "boundaryPreflightExact",
  "targetPreflightExact",
  "productionActivationPrerequisiteExact",
  "productionActivationDeploymentContinuityExact",
  "runtimePreflightExact",
  "durableIntentExact",
  "repositoryPrewriteReasserted",
  "writeAttemptedAtMostOnce",
  "acknowledgementExact",
  "postflightAttempted",
  "targetPostflightExact",
  "runtimePostflightExact",
  "candidateUnchanged",
  "deploymentUnchanged",
  "replicaTopologyEvidenceExact",
  "boundaryPostflightExact",
  "terminalEvidenceExact",
  "finalReceiptEvidenceExact",
] as const;

const RESTORE_RECONCILIATION_CHECK_KEYS = [
  "policyExact",
  "githubAuthorityExact",
  "reviewedAuthorityExact",
  "prerequisitesExact",
  "tokenScopeExact",
  "scaleCredentialAbsent",
  "boundaryPreflightExact",
  "exactCandidateOneBefore",
  "fencedDeploymentIdentityExact",
  "runtimeBeforeExact",
  "durableObservationExact",
  "repositoryBeforeExact",
  "repositoryAfterExact",
  "repositoryReasserted",
  "providerReasserted",
  "runtimeReasserted",
  "noProviderWriteAttempted",
  "postflightAttempted",
  "exactCandidateOneAfter",
  "deploymentAndTopologyUnchanged",
  "runtimeAfterExact",
  "boundaryPostflightExact",
  "configuredTopologyEvidenceExact",
  "terminalEvidenceExact",
] as const;

function validateScaleReceipt(
  source: string,
  value: JsonRecord,
  candidateSha: string,
  kind: "quiesce" | "restore",
  sourceSha: string,
): ReceiptSummary {
  if (value.schemaVersion === RESTORE_RECONCILIATION_RECEIPT_SCHEMA) {
    if (kind !== "restore" || !exactKeys(value, [
      "schemaVersion",
      "executorState",
      "operation",
      "target",
      "outcome",
      "failureCode",
      "candidateSha",
      "sourceSha",
      "bootstrapPath",
      "startedAt",
      "completedAt",
      "replicasBefore",
      "replicasAfter",
      "attempts",
      "retryAllowed",
      "observationSha256",
      "prerequisitesVerificationSha256",
      "runnerLossReconciliation",
      "commandEvidence",
      "providerEvidence",
      "runtimeEvidence",
      "repositoryEvidence",
      "mutationBoundaryEvidence",
      "checks",
      "nextRequiredProof",
      "normalZeroToOneReceiptClaimed",
      "secretMaterialIncluded",
      "secretDerivedCommitmentsIncluded",
    ])) fail("receipt_invalid");
    const started = timestamp(value.startedAt, "receipt_invalid");
    const completed = timestamp(value.completedAt, "receipt_invalid");
    const runnerLoss = record(value.runnerLossReconciliation)
      ? value.runnerLossReconciliation
      : null;
    const command = record(value.commandEvidence) ? value.commandEvidence : null;
    const provider = record(value.providerEvidence) ? value.providerEvidence : null;
    const runtime = record(value.runtimeEvidence) ? value.runtimeEvidence : null;
    const maintenance = record(runtime?.expectedAutomaticMaintenance)
      ? runtime.expectedAutomaticMaintenance
      : null;
    const repository = record(value.repositoryEvidence)
      ? value.repositoryEvidence
      : null;
    const boundary = record(value.mutationBoundaryEvidence)
      ? value.mutationBoundaryEvidence
      : null;
    const responseHashesExact = (responses: unknown): boolean =>
      record(responses) && exactKeys(responses, ["/health", "/startup", "/ready"]) &&
      [responses["/health"], responses["/startup"], responses["/ready"]]
        .every((item) => SHA256_PATTERN.test(String(item)));
    if (value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED" ||
      value.operation !== "restore" || value.target !== "permanent-staging" ||
      value.outcome !== "reconciled_one_after_runner_loss" ||
      value.failureCode !== null || value.candidateSha !== candidateSha ||
      value.sourceSha !== candidateSha ||
      !["healthy-legacy", "cold-dead"].includes(String(value.bootstrapPath)) ||
      completed.milliseconds < started.milliseconds ||
      value.replicasBefore !== 1 || value.replicasAfter !== 1 ||
      value.attempts !== 0 || value.retryAllowed !== false ||
      !SHA256_PATTERN.test(String(value.observationSha256)) ||
      !SHA256_PATTERN.test(String(value.prerequisitesVerificationSha256)) ||
      !exactKeys(runnerLoss, [
        "priorAmbiguousRestoreRunId",
        "reviewedAuthoritySha256",
        "scaleCredentialPresent",
        "providerWriteAttempted",
      ]) ||
      !RUN_ID_PATTERN.test(String(runnerLoss.priorAmbiguousRestoreRunId)) ||
      !SHA256_PATTERN.test(String(runnerLoss.reviewedAuthoritySha256)) ||
      runnerLoss.scaleCredentialPresent !== false ||
      runnerLoss.providerWriteAttempted !== false ||
      !exactKeys(command, ["exitCode", "timedOut", "stdoutSha256", "stderrSha256"]) ||
      command.exitCode !== null || command.timedOut !== false ||
      command.stdoutSha256 !== null || command.stderrSha256 !== null ||
      !exactKeys(provider, [
        "deploymentIdSha256",
        "snapshotIdSha256",
        "stateBeforeSha256",
        "stateAfterSha256",
        "topologyBeforeSha256",
        "topologyAfterSha256",
        "configuredTopologyEvidence",
        "stagedPatchEmptyBefore",
        "stagedPatchEmptyAfter",
      ]) ||
      [provider.deploymentIdSha256, provider.snapshotIdSha256,
        provider.stateBeforeSha256, provider.stateAfterSha256,
        provider.topologyBeforeSha256, provider.topologyAfterSha256]
        .some((item) => !SHA256_PATTERN.test(String(item))) ||
      provider.stateAfterSha256 !== provider.stateBeforeSha256 ||
      provider.topologyAfterSha256 !== provider.topologyBeforeSha256 ||
      !workerFenceTopologyEvidenceExact(
        provider.configuredTopologyEvidence,
        {
          target: "permanent-staging",
          operation: "restore",
          writeAttempted: false,
        },
      ) ||
      provider.stagedPatchEmptyBefore !== true ||
      provider.stagedPatchEmptyAfter !== true ||
      !exactKeys(runtime, [
        "required",
        "expectedSourceSha",
        "expectedAutomaticMaintenance",
        "deploymentIdSha256",
        "beforePollRounds",
        "afterPollRounds",
        "beforeResponseSha256s",
        "afterResponseSha256s",
      ]) || runtime.required !== true || runtime.expectedSourceSha !== candidateSha ||
      !exactKeys(maintenance, ["enabled", "candidateBound"]) ||
      maintenance.enabled !== false || maintenance.candidateBound !== true ||
      runtime.deploymentIdSha256 !== provider.deploymentIdSha256 ||
      !Number.isSafeInteger(runtime.beforePollRounds) ||
      Number(runtime.beforePollRounds) < 1 ||
      !Number.isSafeInteger(runtime.afterPollRounds) ||
      Number(runtime.afterPollRounds) < 1 ||
      !responseHashesExact(runtime.beforeResponseSha256s) ||
      !responseHashesExact(runtime.afterResponseSha256s) ||
      !exactKeys(repository, ["beforeExact", "afterExact"]) ||
      repository.beforeExact !== true || repository.afterExact !== true ||
      !exactKeys(boundary, ["preflightReceiptSha256", "postflightReceiptSha256"]) ||
      !SHA256_PATTERN.test(String(boundary.preflightReceiptSha256)) ||
      !SHA256_PATTERN.test(String(boundary.postflightReceiptSha256)) ||
      !exactTrueChecks(value.checks, RESTORE_RECONCILIATION_CHECK_KEYS) ||
      value.nextRequiredProof !== "ACTIVATE_AUTOMATIC_MAINTENANCE" ||
      value.normalZeroToOneReceiptClaimed !== false ||
      value.secretMaterialIncluded !== false ||
      value.secretDerivedCommitmentsIncluded !== false) fail("receipt_invalid");
    return {
      filename: "bootstrap-staging-one-receipt.json",
      schemaVersion: RESTORE_RECONCILIATION_RECEIPT_SCHEMA,
      sha256: sha256(source),
      outcome: "reconciled_one_after_runner_loss",
      candidateSha,
      sourceSha: candidateSha,
      deploymentIdSha256: String(provider.deploymentIdSha256),
      replicasBefore: 1,
      replicasAfter: 1,
      startedAtMs: started.milliseconds,
      completedAtMs: completed.milliseconds,
    };
  }
  if (!exactKeys(value, [
    "schemaVersion",
    "executorState",
    "direction",
    "outcome",
    "candidateSha",
    "startedAt",
    "completedAt",
    "desiredReplicas",
    "deploymentIdSha256",
    "attempts",
    "retryAllowed",
    "intentSha256",
    "terminalEvidenceSha256",
    "commandStdoutSha256",
    "commandStderrSha256",
    "productionActivationPrerequisite",
    "replicaTopology",
    "checks",
  ])) fail("receipt_invalid");
  const started = timestamp(value.startedAt, "receipt_invalid");
  const completed = timestamp(value.completedAt, "receipt_invalid");
  const quiesce = kind === "quiesce";
  if (
    value.schemaVersion !== SCALE_RECEIPT_SCHEMA
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || value.direction !== (quiesce
      ? "quiesce-staging-zero"
      : "bootstrap-staging-one")
    || value.outcome !== "scaled"
    || value.candidateSha !== candidateSha
    || completed.milliseconds < started.milliseconds
    || value.desiredReplicas !== (quiesce ? 0 : 1)
    || !SHA256_PATTERN.test(String(value.deploymentIdSha256))
    || value.attempts !== 1
    || value.retryAllowed !== false
    || !SHA256_PATTERN.test(String(value.intentSha256))
    || !SHA256_PATTERN.test(String(value.terminalEvidenceSha256))
    || !SHA256_PATTERN.test(String(value.commandStdoutSha256))
    || !SHA256_PATTERN.test(String(value.commandStderrSha256))
    || value.productionActivationPrerequisite !== null
    || !protectedScaleReplicaTopologyExact(value.replicaTopology, {
      direction: quiesce
        ? "quiesce-staging-zero"
        : "bootstrap-staging-one",
      attempts: 1,
      desiredReplicas: quiesce ? 0 : 1,
      target: "staging",
    })
    || !exactTrueChecks(value.checks, SCALE_CHECK_KEYS)
  ) fail("receipt_invalid");
  return {
    filename: quiesce
      ? "quiesce-staging-zero-receipt.json"
      : "bootstrap-staging-one-receipt.json",
    schemaVersion: SCALE_RECEIPT_SCHEMA,
    sha256: sha256(source),
    outcome: "scaled",
    candidateSha,
    sourceSha,
    deploymentIdSha256: String(value.deploymentIdSha256),
    replicasBefore: quiesce ? 1 : 0,
    replicasAfter: quiesce ? 0 : 1,
    startedAtMs: started.milliseconds,
    completedAtMs: completed.milliseconds,
  };
}

const DEPLOYMENT_CHECK_KEYS = [
  "policyExact",
  "githubMainExact",
  "sourceAuthorityExact",
  "cliExact",
  "writeTokenScopeExact",
  "costPolicyExact",
  "configuredTopologyExact",
  "prerequisiteExact",
  "workerFencePrerequisiteExact",
  "workerFenceDeploymentContinuityExact",
  "boundaryPreflightExact",
  "targetPreflightExact",
  "gitAutodeployAbsent",
  "collateralInventoryExact",
  "durableIntentExact",
  "immediatePrewriteExact",
  "sourceReasserted",
  "writeAttemptedAtMostOnce",
  "targetPostflightAttempted",
  "targetPostflightExact",
  "reconciliationCompleted",
  "topologyPreserved",
  "deploymentExact",
  "runtimeHealthExact",
  "runtimeStartupExact",
  "runtimeReadinessExact",
  "fencedRuntimeAbsentBeforeWrite",
  "fencedRuntimeAbsentPostflight",
  "collateralStateUnchanged",
  "boundaryPostflightExact",
  "terminalEvidenceExact",
] as const;

function nullableLegacyReplicaCount(value: unknown): boolean {
  return value === null || (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 50
  );
}

function stagingTopologyEvidence(
  value: unknown,
  expectedReplicas: 0 | 1,
): value is JsonRecord {
  if (!exactKeys(value, [
    "configuredReplicas",
    "configuredRegions",
    "configuredTopologySha256",
  ]) || value.configuredReplicas !== expectedReplicas
    || !Array.isArray(value.configuredRegions)) return false;
  let previousRegion = "";
  const seen = new Set<string>();
  let asiaCount: number | null = null;
  let total = 0;
  for (const entry of value.configuredRegions) {
    if (!exactKeys(entry, ["region", "numReplicas"])
      || typeof entry.region !== "string"
      || ![
        "asia-southeast1-eqsg3a",
        "europe-west4-drams3a",
      ].includes(entry.region)
      || seen.has(entry.region)
      || entry.region <= previousRegion
      || typeof entry.numReplicas !== "number"
      || !Number.isSafeInteger(entry.numReplicas)
      || entry.numReplicas < 0 || entry.numReplicas > 50) return false;
    if (entry.region === "asia-southeast1-eqsg3a") asiaCount = entry.numReplicas;
    if (entry.region === "europe-west4-drams3a" && entry.numReplicas !== 0) {
      return false;
    }
    total += entry.numReplicas;
    seen.add(entry.region);
    previousRegion = entry.region;
  }
  if (total !== expectedReplicas
    || (expectedReplicas === 1 && asiaCount !== 1)) return false;
  return value.configuredTopologySha256 === sha256(`${JSON.stringify(
    canonicalCompactValue({
    configuredReplicas: value.configuredReplicas,
    configuredRegions: value.configuredRegions,
    }),
    null,
    2,
  )}\n`);
}

function stagingTopologyChain(
  value: unknown,
  expectedReplicas: 0 | 1,
): boolean {
  if (!exactKeys(value, [
    "authoritativeSource",
    "before",
    "immediatelyBeforeWrite",
    "after",
  ]) || value.authoritativeSource !==
    "environment.config(decryptVariables:false)"
    || !stagingTopologyEvidence(value.before, expectedReplicas)
    || !stagingTopologyEvidence(value.immediatelyBeforeWrite, expectedReplicas)
    || !stagingTopologyEvidence(value.after, expectedReplicas)) return false;
  return canonicalCompact(value.before)
      === canonicalCompact(value.immediatelyBeforeWrite)
    && canonicalCompact(value.before) === canonicalCompact(value.after);
}

function validateDeploymentReceipt(
  source: string,
  value: JsonRecord,
  candidateSha: string,
  kind: "fenced-deployment" | "active-deployment",
): ReceiptSummary {
  if (!exactKeys(value, [
    "schemaVersion",
    "operation",
    "executorState",
    "target",
    "outcome",
    "failureCode",
    "candidateSha",
    "startedAt",
    "completedAt",
    "writeAttempts",
    "acknowledgement",
    "previousDeploymentIdSha256",
    "deploymentIdSha256",
    "intentSha256",
    "cliOutputSha256",
    "boundaryPreflightSha256",
    "boundaryPostflightSha256",
    "collateralSnapshotSha256s",
    "replicaCounts",
    "legacyReplicaCounts",
    "configuredTopology",
    "runtimeAbsence",
    "runtimeResponseSha256s",
    "workerFencePrerequisite",
    "checks",
  ])) fail("receipt_invalid");
  const collateral = record(value.collateralSnapshotSha256s)
    ? value.collateralSnapshotSha256s
    : null;
  const replicas = record(value.replicaCounts) ? value.replicaCounts : null;
  const legacyReplicas = record(value.legacyReplicaCounts)
    ? value.legacyReplicaCounts
    : null;
  const configuredTopology = value.configuredTopology;
  const runtimeAbsence = record(value.runtimeAbsence) ? value.runtimeAbsence : null;
  const runtime = record(value.runtimeResponseSha256s)
    ? value.runtimeResponseSha256s
    : null;
  const started = timestamp(value.startedAt, "receipt_invalid");
  const completed = timestamp(value.completedAt, "receipt_invalid");
  const expectedReplicas = kind === "fenced-deployment" ? 0 : 1;
  const successfulOutcomes = ["deployed", "already_deployed", "reconciled_success"];
  const outcomeRelationExact =
    (value.outcome === "deployed"
      && value.writeAttempts === 1
      && value.acknowledgement === "received")
    || (value.outcome === "already_deployed"
      && value.writeAttempts === 0
      && value.acknowledgement === "not_attempted")
    || (value.outcome === "reconciled_success"
      && value.writeAttempts === 1
      && value.acknowledgement === "missing_or_failed");
  const nullableSha256 = (item: unknown) =>
    item === null || SHA256_PATTERN.test(String(item));
  if (
    value.schemaVersion !== DEPLOYMENT_RECEIPT_SCHEMA
    || value.operation !== "pintpath-railway-application-source-upload"
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || value.target !== "permanent-staging"
    || !successfulOutcomes.includes(String(value.outcome))
    || !outcomeRelationExact
    || value.failureCode !== null
    || value.candidateSha !== candidateSha
    || completed.milliseconds < started.milliseconds
    || !SHA256_PATTERN.test(String(value.previousDeploymentIdSha256))
    || !SHA256_PATTERN.test(String(value.deploymentIdSha256))
    || !SHA256_PATTERN.test(String(value.intentSha256))
    || !nullableSha256(value.cliOutputSha256)
    || !SHA256_PATTERN.test(String(value.boundaryPreflightSha256))
    || !SHA256_PATTERN.test(String(value.boundaryPostflightSha256))
    || !exactKeys(collateral, ["before", "after"])
    || !SHA256_PATTERN.test(String(collateral.before))
    || collateral.after !== collateral.before
    || !exactKeys(replicas, ["before", "after"])
    || replicas.before !== expectedReplicas
    || replicas.after !== expectedReplicas
    || !exactKeys(legacyReplicas, ["before", "immediatelyBeforeWrite", "after"])
    || Object.values(legacyReplicas).some((item) =>
      !nullableLegacyReplicaCount(item))
    || !stagingTopologyChain(configuredTopology, expectedReplicas)
    || !exactKeys(runtimeAbsence, [
      "required", "immediatelyBeforeWrite", "postflight",
    ])
    || (kind === "fenced-deployment"
      ? runtimeAbsence.required !== true
        || runtimeAbsence.immediatelyBeforeWrite !== true
        || runtimeAbsence.postflight !== true
      : runtimeAbsence.required !== false
        || runtimeAbsence.immediatelyBeforeWrite !== null
        || runtimeAbsence.postflight !== null)
    || !exactKeys(runtime, ["health", "startup", "ready"])
    || (kind === "fenced-deployment"
      ? runtime.health !== null
        || runtime.startup !== null
        || runtime.ready !== null
      : !SHA256_PATTERN.test(String(runtime.health))
        || !SHA256_PATTERN.test(String(runtime.startup))
        || !SHA256_PATTERN.test(String(runtime.ready)))
    || value.workerFencePrerequisite !== null
    || !exactTrueChecks(value.checks, DEPLOYMENT_CHECK_KEYS)
  ) fail("receipt_invalid");
  return {
    filename: "deployment-receipt.json",
    schemaVersion: DEPLOYMENT_RECEIPT_SCHEMA,
    sha256: sha256(source),
    outcome: String(value.outcome),
    candidateSha,
    sourceSha: candidateSha,
    deploymentIdSha256: String(value.deploymentIdSha256),
    replicasBefore: expectedReplicas,
    replicasAfter: expectedReplicas,
    startedAtMs: started.milliseconds,
    completedAtMs: completed.milliseconds,
  };
}

const VENUE_PROJECT_REF = "bbfibbadwjxzrcdncavy" as const;
const VENUE_MIGRATION_VERSION = "20260901032339" as const;
const VENUE_MIGRATION_FILENAME =
  "20260901032339_validate_external_venue_directory_constraints.sql" as const;
const VENUE_MIGRATION_PATH =
  `supabase/migrations/${VENUE_MIGRATION_FILENAME}` as const;
const VENUE_MIGRATION_SHA256 =
  "5068c2a678813e57fde83b29d3cb5e438ce9070705f246827b7ee8e2a70ee96c" as const;
const VENUE_MIGRATION_BYTES = 161 as const;
const VENUE_FIRST_RUN_MIGRATION_INVENTORY = Object.freeze([
  Object.freeze({
    version: VENUE_MIGRATION_VERSION,
    filename: VENUE_MIGRATION_FILENAME,
    path: VENUE_MIGRATION_PATH,
    sha256: VENUE_MIGRATION_SHA256,
    bytes: VENUE_MIGRATION_BYTES,
  }),
  Object.freeze({
    version: "20260901122942",
    filename:
      "20260901122942_remove_redundant_accounts_public_account_index.sql",
    path:
      "supabase/migrations/20260901122942_remove_redundant_accounts_public_account_index.sql",
    sha256:
      "70ba85af2938a7356740b5216b6577ad311e961359aa72746dd6ac2d25ef46ee",
    bytes: 4709,
  }),
] as const);
const VENUE_FIRST_RUN_MIGRATION_VERSIONS = Object.freeze(
  VENUE_FIRST_RUN_MIGRATION_INVENTORY.map((migration) => migration.version),
);
const VENUE_FIRST_RUN_MIGRATION_FILENAMES = Object.freeze(
  VENUE_FIRST_RUN_MIGRATION_INVENTORY.map((migration) => migration.filename),
);
const VENUE_CONSTRAINTS = Object.freeze([
  "venues_australian_postcode_check",
  "venues_business_status_check",
] as const);
const VENUE_PREFLIGHT_VERIFIER = Object.freeze({
  path: "scripts/ci/supabase-venue-directory-preflight-verify.sql",
  sha256: "9ae8804c03f7f515beaa80b6fb99ae886f200712482c21ae5eae11f9709b8c6a",
  bytes: 6189,
});
const VENUE_STRICT_VERIFIER = Object.freeze({
  path: "scripts/ci/supabase-venue-directory-schema-verify.sql",
  sha256: "e2a6d9cd5a5dcbc14c6932d2ac4c44f81814249c0338e9eb54e72a1a985a6130",
  bytes: 3956,
});
const VENUE_PLAN_KEYS = Object.freeze([
  "schemaVersion", "planSha256", "candidateSha", "supabaseProjectRef",
  "databaseContract", "operation", "startedAt", "completedAt", "checkedAt",
  "inputSnapshot", "collection", "projected", "transitions",
] as const);
const VENUE_IMPORT_TERMINAL_KEYS = Object.freeze([
  "schemaVersion", "status", "outcome", "candidateSha", "supabaseProjectRef",
  "databaseContract", "planSha256", "startedAt", "completedAt",
  "preflightSnapshot", "finalSnapshot", "attemptedWriteCount",
  "successfulWriteCount", "insertedCount", "updatedCount", "excludedCount",
  "partialWrite", "samePlanRetryAllowed", "failure",
] as const);
const VENUE_PREFLIGHT_KEYS = Object.freeze([
  "schemaVersion", "candidateSha", "supabaseProjectRef", "databaseContract",
  "migrationMode", "localMigrationVersions", "remoteMigrationVersions",
  "constraints", "violationCounts", "targetLedger", "dryRun",
  "preflightVerifier", "checkedAt", "checks", "secretMaterialIncluded",
  "secretDerivedCommitmentsIncluded",
] as const);
const VENUE_PREWRITE_KEYS = Object.freeze([
  "schemaVersion", "candidateSha", "supabaseProjectRef", "databaseContract",
  "migrationMode", "planSha256", "localMigrationVersions",
  "remoteMigrationVersions", "constraints", "violationCounts", "targetLedger",
  "dryRun", "checkedAt", "checks", "secretMaterialIncluded",
  "secretDerivedCommitmentsIncluded",
] as const);
const VENUE_MIGRATION_APPLY_KEYS = Object.freeze([
  "schemaVersion", "candidateSha", "supabaseProjectRef", "databaseContract",
  "migrationMode", "planSha256", "startedAt", "completedAt", "writeAttempts",
  "acknowledgement", "exitCode", "command", "cliStdoutSha256",
  "cliStderrSha256", "samePlanRetryAllowed", "secretMaterialIncluded",
  "secretDerivedCommitmentsIncluded",
] as const);
const VENUE_POSTFLIGHT_KEYS = Object.freeze([
  "schemaVersion", "candidateSha", "supabaseProjectRef", "databaseContract",
  "migrationMode", "planSha256", "migrationApplySha256",
  "localMigrationVersions", "remoteMigrationVersions", "constraints",
  "violationCounts", "targetLedger", "dryRun", "strictVerifier", "checkedAt",
  "checks", "secretMaterialIncluded", "secretDerivedCommitmentsIncluded",
] as const);
const VENUE_BOUNDARY_TERMINAL_KEYS = Object.freeze([
  "schemaVersion", "status", "outcome", "candidateSha", "supabaseProjectRef",
  "databaseContract", "migrationMode", "planSha256", "importTerminalSha256",
  "constraintPreflightSha256", "migrationPrewriteSha256",
  "migrationApplySha256", "constraintPostflightSha256", "startedAt",
  "completedAt", "migrationWriteAttempts", "samePlanRetryAllowed",
  "secretMaterialIncluded", "secretDerivedCommitmentsIncluded", "checks",
  "failure",
] as const);
const VENUE_PREFLIGHT_CHECKS = Object.freeze([
  "structureExact", "zeroViolations", "constraintLedgerStateExact",
  "migrationFileExact", "pendingSetExact", "remoteLedgerExact",
] as const);
const VENUE_PREWRITE_CHECKS = Object.freeze([
  "planSealed", "repositoryMainExact", "stateUnchanged", "migrationFileExact",
  "pendingSetExact", "remoteLedgerExact",
] as const);
const VENUE_POSTFLIGHT_CHECKS = Object.freeze([
  "migrationLedgerRecorded", "noPendingMigrations", "constraintsValidated",
  "strictSchemaExact", "migrationFileExact", "remoteLedgerExact",
  "zeroViolations",
] as const);
const VENUE_BOUNDARY_CHECKS = Object.freeze([
  "importApplied", "preflightStructureExact", "preflightZeroViolations",
  "preflightConstraintLedgerStateExact", "pendingSetPreflightExact",
  "pendingSetPrewriteExact", "migrationMutationExact", "migrationLedgerRecorded",
  "noPendingMigrationsPostflight", "constraintsValidatedPostflight",
] as const);
const VENUE_MANAGED_ROW_KEYS = Object.freeze([
  "id", "google_place_id", "name", "address", "suburb", "state", "postcode",
  "phone", "website", "latitude", "longitude", "business_status",
  "last_checked_at", "directory_eligible", "source",
] as const);
const VENUE_DESIRED_ROW_KEYS = Object.freeze(
  VENUE_MANAGED_ROW_KEYS.filter((key) => key !== "id"),
);

function venueDatabaseContractExact(value: unknown): boolean {
  return exactKeys(value, [
    "migrationVersion", "migrationPath", "migrationSha256", "migrationBytes",
    "validatedConstraints",
  ]) && value.migrationVersion === VENUE_MIGRATION_VERSION
    && value.migrationPath === VENUE_MIGRATION_PATH
    && value.migrationSha256 === VENUE_MIGRATION_SHA256
    && value.migrationBytes === VENUE_MIGRATION_BYTES
    && Array.isArray(value.validatedConstraints)
    && JSON.stringify(value.validatedConstraints) === JSON.stringify(VENUE_CONSTRAINTS);
}

function venueSnapshotExact(value: unknown): value is JsonRecord {
  return exactKeys(value, ["rowCount", "sha256"])
    && Number.isSafeInteger(value.rowCount) && Number(value.rowCount) >= 0
    && SHA256_PATTERN.test(String(value.sha256));
}

function venueNonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function venueRepositoryContractsExact(cwd: string): readonly string[] {
  try {
    for (const contract of [
      ...VENUE_FIRST_RUN_MIGRATION_INVENTORY,
      VENUE_PREFLIGHT_VERIFIER,
      VENUE_STRICT_VERIFIER,
    ]) {
      const source = fs.readFileSync(path.resolve(cwd, contract.path));
      if (source.byteLength !== contract.bytes || sha256(source) !== contract.sha256) {
        fail("receipt_invalid");
      }
    }
    const versions = fs.readdirSync(path.resolve(cwd, "supabase/migrations"))
      .filter((name) => /^[0-9]+_[a-z0-9_]+\.sql$/.test(name))
      .sort()
      .map((name) => name.slice(0, name.indexOf("_")));
    if (versions.length <= VENUE_FIRST_RUN_MIGRATION_INVENTORY.length
      || JSON.stringify(versions.slice(-VENUE_FIRST_RUN_MIGRATION_INVENTORY.length))
        !== JSON.stringify(VENUE_FIRST_RUN_MIGRATION_VERSIONS)
      || new Set(versions).size !== versions.length) fail("receipt_invalid");
    return versions;
  } catch (error) {
    if (error instanceof BootstrapPrerequisiteError) throw error;
    fail("receipt_invalid");
  }
}

function venueTargetLedgerExact(value: unknown): boolean {
  return exactKeys(value, ["version", "name", "statements"])
    && value.version === VENUE_MIGRATION_VERSION
    && value.name === "validate_external_venue_directory_constraints"
    && Array.isArray(value.statements)
    && JSON.stringify(value.statements) === JSON.stringify([
      "alter table public.venues\n  validate constraint venues_business_status_check",
      "alter table public.venues\n  validate constraint venues_australian_postcode_check",
    ]);
}

function venueConstraintsExact(value: unknown, validated: boolean): boolean {
  if (!Array.isArray(value) || value.length !== VENUE_CONSTRAINTS.length) return false;
  return value.every((item, index) => exactKeys(item,
    ["name", "type", "validated", "definition"])
    && item.name === VENUE_CONSTRAINTS[index] && item.type === "c"
    && item.validated === validated && typeof item.definition === "string")
    && String((value[0] as JsonRecord).definition).includes("^[0-9]{4}$")
    && ["OPERATIONAL", "CLOSED_TEMPORARILY", "CLOSED_PERMANENTLY", "FUTURE_OPENING"]
      .every((status) => String((value[1] as JsonRecord).definition).includes(status));
}

function venueDryRunExact(value: unknown, pending: readonly string[]): boolean {
  return exactKeys(value, ["pendingFilenames", "stdoutSha256", "stderrSha256"])
    && Array.isArray(value.pendingFilenames)
    && JSON.stringify(value.pendingFilenames) === JSON.stringify(pending)
    && SHA256_PATTERN.test(String(value.stdoutSha256))
    && SHA256_PATTERN.test(String(value.stderrSha256));
}

function validateVenuePlan(
  source: string,
  value: JsonRecord,
  candidateSha: string,
): { readonly startedAtMs: number; readonly completedAtMs: number } {
  const withoutHash = { ...value };
  delete withoutHash.planSha256;
  const computedHash = sha256(canonicalCompact(withoutHash).slice(0, -1));
  const started = timestamp(value.startedAt, "receipt_invalid");
  const completed = timestamp(value.completedAt, "receipt_invalid");
  timestamp(value.checkedAt, "receipt_invalid");
  const collection = record(value.collection) ? value.collection : null;
  const projected = record(value.projected) ? value.projected : null;
  const collectionKeys = [
    "discoveryCellAttemptedCount", "discoveryCellSuccessfulCount",
    "discoveryCellFailureCount", "discoveryQueryAttemptedCount",
    "discoveryQuerySuccessfulCount", "discoveryQueryFailureCount",
    "existingPlaceIdAttemptedCount", "existingPlaceIdSuccessfulCount",
    "existingPlaceIdFailureCount", "existingPlaceIdSatisfiedByDiscoveryCount",
    "existingRowMissingPlaceIdCount", "quarantinedVenueCount",
  ];
  if (source !== canonicalCompact(value) || !exactKeys(value, VENUE_PLAN_KEYS)
    || value.schemaVersion !== VENUE_DIRECTORY_PLAN_SCHEMA
    || value.planSha256 !== computedHash || value.candidateSha !== candidateSha
    || value.supabaseProjectRef !== VENUE_PROJECT_REF
    || !venueDatabaseContractExact(value.databaseContract)
    || value.operation !== "directory-discovery-and-status-refresh"
    || completed.milliseconds < started.milliseconds
    || !venueSnapshotExact(value.inputSnapshot)
    || !exactKeys(collection, collectionKeys)
    || Object.values(collection).some((item) => !venueNonnegativeInteger(item))
    || !exactKeys(projected,
      ["insertCount", "updateCount", "exclusionCount", "totalTransitionCount"])
    || Object.values(projected).some((item) => !venueNonnegativeInteger(item))
    || !Array.isArray(value.transitions)
    || value.transitions.length !== projected.totalTransitionCount
    || projected.totalTransitionCount !== Number(projected.insertCount)
      + Number(projected.updateCount) + Number(projected.exclusionCount)) {
    fail("receipt_invalid");
  }
  const counts = { insert: 0, update: 0, exclude: 0 };
  value.transitions.forEach((transition, index) => {
    if (!exactKeys(transition,
      ["ordinal", "operation", "identity", "expectedBefore", "desiredAfter"])
      || transition.ordinal !== index + 1
      || !Object.hasOwn(counts, String(transition.operation))
      || !exactKeys(transition.identity,
        ["venueId", "googlePlaceId", "normalizedNameAddressSha256"])
      || typeof transition.identity.googlePlaceId !== "string"
      || !SHA256_PATTERN.test(String(transition.identity.normalizedNameAddressSha256))
      || !exactKeys(transition.desiredAfter, VENUE_DESIRED_ROW_KEYS)
      || transition.desiredAfter.last_checked_at !== value.checkedAt) {
      fail("receipt_invalid");
    }
    const operation = transition.operation as keyof typeof counts;
    counts[operation] += 1;
    if (operation === "insert") {
      if (transition.expectedBefore !== null || transition.identity.venueId !== null) {
        fail("receipt_invalid");
      }
    } else if (!exactKeys(transition.expectedBefore, VENUE_MANAGED_ROW_KEYS)
      || typeof transition.identity.venueId !== "string"
      || transition.expectedBefore.id !== transition.identity.venueId) {
      fail("receipt_invalid");
    }
  });
  if (counts.insert !== projected.insertCount || counts.update !== projected.updateCount
    || counts.exclude !== projected.exclusionCount) fail("receipt_invalid");
  return { startedAtMs: started.milliseconds, completedAtMs: completed.milliseconds };
}

function validateVenueImportTerminal(
  source: string,
  value: JsonRecord,
  candidateSha: string,
  plan: JsonRecord,
): { readonly startedAtMs: number; readonly completedAtMs: number } {
  const started = timestamp(value.startedAt, "receipt_invalid");
  const completed = timestamp(value.completedAt, "receipt_invalid");
  const projected = record(plan.projected) ? plan.projected : fail("receipt_invalid");
  const input = record(plan.inputSnapshot) ? plan.inputSnapshot : fail("receipt_invalid");
  const classified = Number(value.insertedCount) + Number(value.updatedCount)
    + Number(value.excludedCount);
  if (source !== canonicalCompact(value)
    || !exactKeys(value, VENUE_IMPORT_TERMINAL_KEYS)
    || value.schemaVersion !== VENUE_DIRECTORY_IMPORT_TERMINAL_SCHEMA
    || value.status !== "succeeded" || value.outcome !== "applied"
    || value.candidateSha !== candidateSha || value.supabaseProjectRef !== VENUE_PROJECT_REF
    || !venueDatabaseContractExact(value.databaseContract)
    || value.planSha256 !== plan.planSha256 || completed.milliseconds < started.milliseconds
    || !venueSnapshotExact(value.preflightSnapshot)
    || !venueSnapshotExact(value.finalSnapshot)
    || value.preflightSnapshot.rowCount !== input.rowCount
    || value.preflightSnapshot.sha256 !== input.sha256
    || value.finalSnapshot.rowCount !== Number(input.rowCount) + Number(projected.insertCount)
    || [value.attemptedWriteCount, value.successfulWriteCount, value.insertedCount,
      value.updatedCount, value.excludedCount].some((item) => !venueNonnegativeInteger(item))
    || value.attemptedWriteCount !== value.successfulWriteCount
    || value.successfulWriteCount !== classified
    || value.insertedCount !== projected.insertCount
    || value.updatedCount !== projected.updateCount
    || value.excludedCount !== projected.exclusionCount
    || value.partialWrite !== false || value.samePlanRetryAllowed !== false
    || value.failure !== null) fail("receipt_invalid");
  return { startedAtMs: started.milliseconds, completedAtMs: completed.milliseconds };
}

function validateVenueDatabaseObservation(
  value: JsonRecord,
  phase: "preflight" | "prewrite" | "postflight",
  candidateSha: string,
  localVersions: readonly string[],
  planSha256: string,
  migrationApplySha256: string,
): { readonly mode: "first_run" | "steady_state"; readonly checkedAtMs: number } {
  const keys = phase === "preflight" ? VENUE_PREFLIGHT_KEYS
    : phase === "prewrite" ? VENUE_PREWRITE_KEYS : VENUE_POSTFLIGHT_KEYS;
  const schema = phase === "preflight" ? VENUE_DIRECTORY_CONSTRAINT_PREFLIGHT_SCHEMA
    : phase === "prewrite" ? VENUE_DIRECTORY_MIGRATION_PREWRITE_SCHEMA
      : VENUE_DIRECTORY_CONSTRAINT_POSTFLIGHT_SCHEMA;
  const mode = value.migrationMode;
  if (!exactKeys(value, keys) || value.schemaVersion !== schema
    || value.candidateSha !== candidateSha || value.supabaseProjectRef !== VENUE_PROJECT_REF
    || !venueDatabaseContractExact(value.databaseContract)
    || (mode !== "first_run" && mode !== "steady_state")
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false) fail("receipt_invalid");
  const checked = timestamp(value.checkedAt, "receipt_invalid");
  const before = mode === "first_run"
    ? localVersions.slice(0, -VENUE_FIRST_RUN_MIGRATION_INVENTORY.length)
    : localVersions;
  const postflight = phase === "postflight";
  const validated = postflight || mode === "steady_state";
  const expectedRemote = postflight ? localVersions : before;
  const expectedPending = validated ? [] : VENUE_FIRST_RUN_MIGRATION_FILENAMES;
  if (!Array.isArray(value.localMigrationVersions)
    || JSON.stringify(value.localMigrationVersions) !== JSON.stringify(localVersions)
    || !Array.isArray(value.remoteMigrationVersions)
    || JSON.stringify(value.remoteMigrationVersions) !== JSON.stringify(expectedRemote)
    || !venueConstraintsExact(value.constraints, validated)
    || !exactKeys(value.violationCounts, ["businessStatus", "postcode"])
    || value.violationCounts.businessStatus !== 0 || value.violationCounts.postcode !== 0
    || (validated ? !venueTargetLedgerExact(value.targetLedger) : value.targetLedger !== null)
    || !venueDryRunExact(value.dryRun, expectedPending)) fail("receipt_invalid");
  if (phase === "preflight") {
    if (!exactKeys(value.preflightVerifier, ["path", "sha256", "bytes", "passed"])
      || value.preflightVerifier.path !== VENUE_PREFLIGHT_VERIFIER.path
      || value.preflightVerifier.sha256 !== VENUE_PREFLIGHT_VERIFIER.sha256
      || value.preflightVerifier.bytes !== VENUE_PREFLIGHT_VERIFIER.bytes
      || value.preflightVerifier.passed !== true
      || !exactTrueChecks(value.checks, VENUE_PREFLIGHT_CHECKS)) fail("receipt_invalid");
  } else if (phase === "prewrite") {
    if (value.planSha256 !== planSha256
      || !exactTrueChecks(value.checks, VENUE_PREWRITE_CHECKS)) fail("receipt_invalid");
  } else if (value.planSha256 !== planSha256
    || value.migrationApplySha256 !== migrationApplySha256
    || !exactKeys(value.strictVerifier, ["path", "sha256", "bytes", "passed"])
    || value.strictVerifier.path !== VENUE_STRICT_VERIFIER.path
    || value.strictVerifier.sha256 !== VENUE_STRICT_VERIFIER.sha256
    || value.strictVerifier.bytes !== VENUE_STRICT_VERIFIER.bytes
    || value.strictVerifier.passed !== true
    || !exactTrueChecks(value.checks, VENUE_POSTFLIGHT_CHECKS)) fail("receipt_invalid");
  return { mode, checkedAtMs: checked.milliseconds };
}

function validateVenueMigrationApply(
  value: JsonRecord,
  candidateSha: string,
  planSha256: string,
  mode: "first_run" | "steady_state",
): { readonly startedAtMs: number; readonly completedAtMs: number; readonly attempts: number } {
  const started = timestamp(value.startedAt, "receipt_invalid");
  const completed = timestamp(value.completedAt, "receipt_invalid");
  if (!exactKeys(value, VENUE_MIGRATION_APPLY_KEYS)
    || value.schemaVersion !== VENUE_DIRECTORY_MIGRATION_APPLY_SCHEMA
    || value.candidateSha !== candidateSha || value.supabaseProjectRef !== VENUE_PROJECT_REF
    || !venueDatabaseContractExact(value.databaseContract)
    || value.migrationMode !== mode || value.planSha256 !== planSha256
    || completed.milliseconds < started.milliseconds
    || value.samePlanRetryAllowed !== false || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
    || !Array.isArray(value.command)
    || JSON.stringify(value.command) !== JSON.stringify([
      "supabase", "db", "push", "--linked", "--password", "<redacted>", "--yes",
    ])) fail("receipt_invalid");
  if (mode === "first_run") {
    if (value.writeAttempts !== 1 || value.exitCode !== 0
      || value.acknowledgement !== "received"
      || !SHA256_PATTERN.test(String(value.cliStdoutSha256))
      || !SHA256_PATTERN.test(String(value.cliStderrSha256))) fail("receipt_invalid");
  } else if (value.writeAttempts !== 0 || value.acknowledgement !== "not_attempted"
    || value.exitCode !== null || value.cliStdoutSha256 !== null
    || value.cliStderrSha256 !== null) fail("receipt_invalid");
  return {
    startedAtMs: started.milliseconds,
    completedAtMs: completed.milliseconds,
    attempts: Number(value.writeAttempts),
  };
}

function validateVenueDirectoryEvidence(
  terminalFilename: string,
  candidateSha: string,
  dependencies: Dependencies,
): ReceiptSummary {
  const directory = path.dirname(terminalFilename);
  const read = (leaf: string) => parseCanonicalPrivateJson(
    path.join(directory, leaf), dependencies.readPrivateFile, true,
    MAXIMUM_VENUE_EVIDENCE_BYTES,
  );
  const terminal = read("venue-directory-terminal.json");
  const plan = read("venue-directory-plan.json");
  const importTerminal = read("venue-import-terminal.json");
  const preflight = read("constraint-preflight.json");
  const prewrite = read("migration-prewrite.json");
  const migrationApply = read("migration-apply.json");
  const postflight = read("constraint-postflight.json");
  const localVersions = venueRepositoryContractsExact(dependencies.cwd);
  const planTimes = validateVenuePlan(plan.source, plan.value, candidateSha);
  const importTimes = validateVenueImportTerminal(
    importTerminal.source, importTerminal.value, candidateSha, plan.value,
  );
  const planSha256 = String(plan.value.planSha256);
  const preflightState = validateVenueDatabaseObservation(
    preflight.value, "preflight", candidateSha, localVersions, planSha256, "",
  );
  const prewriteState = validateVenueDatabaseObservation(
    prewrite.value, "prewrite", candidateSha, localVersions, planSha256, "",
  );
  if (prewriteState.mode !== preflightState.mode) fail("receipt_invalid");
  for (const key of ["localMigrationVersions", "remoteMigrationVersions", "constraints",
    "violationCounts", "targetLedger", "dryRun"] as const) {
    if (JSON.stringify(preflight.value[key]) !== JSON.stringify(prewrite.value[key])) {
      fail("receipt_invalid");
    }
  }
  const migrationTimes = validateVenueMigrationApply(
    migrationApply.value, candidateSha, planSha256, preflightState.mode,
  );
  const postflightState = validateVenueDatabaseObservation(
    postflight.value, "postflight", candidateSha, localVersions, planSha256,
    sha256(migrationApply.source),
  );
  if (postflightState.mode !== preflightState.mode) fail("receipt_invalid");
  const boundary = terminal.value;
  const boundaryStarted = timestamp(boundary.startedAt, "receipt_invalid");
  const boundaryCompleted = timestamp(boundary.completedAt, "receipt_invalid");
  if (!exactKeys(boundary, VENUE_BOUNDARY_TERMINAL_KEYS)
    || boundary.schemaVersion !== VENUE_DIRECTORY_RECEIPT_SCHEMA
    || boundary.status !== "succeeded" || boundary.outcome !== "applied_and_validated"
    || boundary.candidateSha !== candidateSha
    || boundary.supabaseProjectRef !== VENUE_PROJECT_REF
    || !venueDatabaseContractExact(boundary.databaseContract)
    || boundary.migrationMode !== preflightState.mode
    || boundary.planSha256 !== planSha256
    || boundary.importTerminalSha256 !== sha256(importTerminal.source)
    || boundary.constraintPreflightSha256 !== sha256(preflight.source)
    || boundary.migrationPrewriteSha256 !== sha256(prewrite.source)
    || boundary.migrationApplySha256 !== sha256(migrationApply.source)
    || boundary.constraintPostflightSha256 !== sha256(postflight.source)
    || boundary.startedAt !== plan.value.startedAt
    || boundary.migrationWriteAttempts !== migrationTimes.attempts
    || boundary.samePlanRetryAllowed !== false
    || boundary.secretMaterialIncluded !== false
    || boundary.secretDerivedCommitmentsIncluded !== false
    || !exactTrueChecks(boundary.checks, VENUE_BOUNDARY_CHECKS)
    || boundary.failure !== null
    || !(preflightState.checkedAtMs <= planTimes.startedAtMs
      && planTimes.startedAtMs <= planTimes.completedAtMs
      && planTimes.completedAtMs <= prewriteState.checkedAtMs
      && prewriteState.checkedAtMs <= migrationTimes.startedAtMs
      && migrationTimes.startedAtMs <= migrationTimes.completedAtMs
      && migrationTimes.completedAtMs <= postflightState.checkedAtMs
      && postflightState.checkedAtMs <= importTimes.startedAtMs
      && importTimes.startedAtMs <= importTimes.completedAtMs
      && importTimes.completedAtMs <= boundaryCompleted.milliseconds)
    || boundaryStarted.milliseconds !== planTimes.startedAtMs) fail("receipt_invalid");
  return {
    filename: "venue-directory-terminal.json",
    schemaVersion: VENUE_DIRECTORY_RECEIPT_SCHEMA,
    sha256: sha256(terminal.source),
    outcome: "applied_and_validated",
    candidateSha,
    sourceSha: candidateSha,
    deploymentIdSha256: planSha256,
    replicasBefore: null,
    replicasAfter: null,
    startedAtMs: boundaryStarted.milliseconds,
    completedAtMs: boundaryCompleted.milliseconds,
  };
}

const VERIFICATION_CHECK_KEYS = [
  "policiesExact",
  "currentMainExact",
  "reviewedCandidateExact",
  "consumerRunAuthorityExact",
  "prerequisiteRunsExact",
  "artifactNamesAndDigestsExact",
  "receiptSchemasAndBindingsExact",
  "strictChronologyExact",
  "noLaterMatchingRunsExact",
  "evidenceSecretFreeExact",
] as const;

function producerReceiptSchemaAllowed(
  kind: ProducerKind,
  schemaVersion: unknown,
): boolean {
  return schemaVersion === PRODUCERS[kind].receiptSchema ||
    (kind === "cold-prepare" &&
      schemaVersion === COLD_PREPARE_RECONCILIATION_RECEIPT_SCHEMA) ||
    (kind === "restore" &&
      schemaVersion === RESTORE_RECONCILIATION_RECEIPT_SCHEMA) ||
    (kind === "activate" &&
      schemaVersion === ACTIVATE_RECONCILIATION_RECEIPT_SCHEMA);
}

function validatePriorVerification(
  source: string,
  value: JsonRecord,
  input: {
    readonly operation:
      | "quiesce"
      | "cold-quiesce"
      | "cold-reconcile-quiesce"
      | "restore"
      | "reconcile-restore"
      | "activate";
    readonly bootstrapPath: BootstrapPath;
    readonly candidateSha: string;
    readonly runId: string;
  },
): {
  readonly sha256: string;
  readonly expectedDeploymentSha: string | null;
} {
  let parsed: StagingWorkerBootstrapPrerequisitesVerification;
  try {
    const verifiedAt = timestamp(value.verifiedAt, "receipt_invalid");
    const evidenceOperation = input.operation === "cold-quiesce" &&
        value.operation === "cold-reconcile-quiesce"
      ? "cold-reconcile-quiesce"
      : input.operation === "restore" && value.operation === "reconcile-restore"
      ? "reconcile-restore"
      : input.operation === "activate" && value.operation === "reconcile-activate"
      ? "reconcile-activate"
      : input.operation;
    parsed = parseVerificationObject(source, {
      operation: evidenceOperation,
      bootstrapPath: input.bootstrapPath,
      candidateSha: input.candidateSha,
      currentRunId: input.runId,
      now: new Date(verifiedAt.milliseconds),
    });
  } catch {
    fail("receipt_invalid");
  }
  if (
    input.operation === "quiesce" || input.operation === "cold-quiesce" ||
      input.operation === "cold-reconcile-quiesce"
      ? !SHA_PATTERN.test(String(parsed.expectedDeploymentSha))
        || parsed.expectedDeploymentSha === input.candidateSha
      : input.operation === "restore" || input.operation === "reconcile-restore"
        ? parsed.expectedDeploymentSha !== input.candidateSha
        : parsed.expectedDeploymentSha !== null
  ) fail("receipt_invalid");
  return {
    sha256: sha256(source),
    expectedDeploymentSha: parsed.expectedDeploymentSha,
  };
}

function validateReceipt(
  kind: ProducerKind,
  source: string,
  value: JsonRecord,
  candidateSha: string,
  sourceSha: string,
): ReceiptSummary {
  if (kind === "cold-prepare") {
    return validateColdPrepareReceipt(source, value, candidateSha);
  }
  if (kind === "cold-quiesce") {
    return validateColdQuiesceReceipt(source, value, candidateSha);
  }
  if (kind === "prepare" || kind === "activate") {
    return validateWorkerReceipt(source, value, candidateSha, kind);
  }
  if (kind === "quiesce" || kind === "restore") {
    return validateScaleReceipt(source, value, candidateSha, kind, sourceSha);
  }
  if (kind === "venue-directory") fail("receipt_invalid");
  return validateDeploymentReceipt(source, value, candidateSha, kind);
}

function receiptWithinRun(receipt: ReceiptSummary, run: GithubRun): boolean {
  return receipt.startedAtMs === null || receipt.completedAtMs === null || (
    receipt.startedAtMs >= run.startedAtMs - MAXIMUM_CLOCK_SKEW_MS
    && receipt.completedAtMs <= run.completedAtMs + MAXIMUM_CLOCK_SKEW_MS
  );
}

function parseVerificationObject(
  source: string,
  expected: {
    readonly operation: BootstrapConsumerOperation;
    readonly bootstrapPath?: BootstrapPath;
    readonly candidateSha: string;
    readonly currentRunId: string;
    readonly now: Date;
  },
): StagingWorkerBootstrapPrerequisitesVerification {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    fail("evidence_invalid");
  }
  if (!exactKeys(value, [
    "schemaVersion",
    "policySha256",
    "operation",
    "bootstrapPath",
    "candidateSha",
    "expectedDeploymentSha",
    "repository",
    "reviewedPullRequest",
    "consumer",
    "prerequisites",
    "verifiedAt",
    "expiresAt",
    "checks",
    "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ]) || canonical(value) !== source) fail("evidence_invalid");
  const consumer = record(value.consumer) ? value.consumer : null;
  const reviewed = record(value.reviewedPullRequest)
    ? value.reviewedPullRequest
    : null;
  const prerequisites = Array.isArray(value.prerequisites)
    ? value.prerequisites.filter(record)
    : [];
  const verifiedAt = timestamp(value.verifiedAt, "evidence_invalid");
  const expiresAt = timestamp(value.expiresAt, "evidence_invalid");
  const bootstrapPath = value.bootstrapPath as BootstrapPath;
  const requiredKinds = requiredProducers(expected.operation, bootstrapPath);
  if (
    value.schemaVersion !== STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA
    || value.policySha256
      !== STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256
    || value.operation !== expected.operation
    || !["healthy-legacy", "cold-dead"].includes(bootstrapPath)
    || (expected.bootstrapPath !== undefined
      && bootstrapPath !== expected.bootstrapPath)
    || value.candidateSha !== expected.candidateSha
    || value.repository !== REPOSITORY
    || !exactKeys(reviewed, [
      "number",
      "reviewedHeadSha",
      "mergeCommitSha",
      "treeSha",
      "mergedAt",
      "authorId",
      "mergedById",
    ])
    || reviewed.mergeCommitSha !== expected.candidateSha
    || !SHA_PATTERN.test(String(reviewed.reviewedHeadSha))
    || !SHA_PATTERN.test(String(reviewed.treeSha))
    || !Number.isSafeInteger(reviewed.number)
    || !Number.isSafeInteger(reviewed.authorId)
    || !Number.isSafeInteger(reviewed.mergedById)
    || !exactKeys(consumer, [
      "workflowPath",
      "githubEnvironment",
      "runId",
      "runAttempt",
      "startedAt",
    ])
    || consumer.workflowPath !== CONSUMERS[expected.operation].workflowPath
    || consumer.githubEnvironment !== CONSUMERS[expected.operation].environment
    || consumer.runId !== expected.currentRunId
    || consumer.runAttempt !== 1
    || prerequisites.length !== requiredKinds.length
    || prerequisites.some((item, index) =>
      item.kind !== requiredKinds[index]
      || item.workflowPath !== PRODUCERS[requiredKinds[index]!].workflowPath
      || item.runAttempt !== 1
      || !RUN_ID_PATTERN.test(String(item.runId))
      || item.artifactName
        !== PRODUCERS[requiredKinds[index]!].artifact(expected.candidateSha)
      || !RUN_ID_PATTERN.test(String(item.artifactId))
      || !ARTIFACT_DIGEST_PATTERN.test(String(item.artifactDigest))
      || !Number.isSafeInteger(item.artifactSizeBytes)
      || !record(item.receipt)
      || item.receipt.filename
        !== PRODUCERS[requiredKinds[index]!].receiptFilename
      || !producerReceiptSchemaAllowed(
        requiredKinds[index]!,
        item.receipt.schemaVersion,
      )
      || item.receipt.candidateSha !== expected.candidateSha
      || !SHA256_PATTERN.test(String(item.receipt.sha256))
      || !SHA_PATTERN.test(String(item.receipt.sourceSha))
      || !SHA256_PATTERN.test(String(item.receipt.deploymentIdSha256)))
    || !exactTrueChecks(value.checks, VERIFICATION_CHECK_KEYS)
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
    || expiresAt.milliseconds - verifiedAt.milliseconds
      !== MAXIMUM_VERIFICATION_AGE_MS
    || verifiedAt.milliseconds > expected.now.getTime() + MAXIMUM_CLOCK_SKEW_MS
    || expected.now.getTime() > expiresAt.milliseconds
  ) fail("evidence_invalid");
  return value as unknown as StagingWorkerBootstrapPrerequisitesVerification;
}

export function parseStagingWorkerBootstrapPrerequisitesVerification(
  source: string,
  expected: {
    readonly operation: BootstrapConsumerOperation;
    readonly bootstrapPath?: BootstrapPath;
    readonly candidateSha: string;
    readonly currentRunId: string;
    readonly now: Date;
  },
): StagingWorkerBootstrapPrerequisitesVerification {
  return parseVerificationObject(source, expected);
}

async function verify(
  args: Arguments,
  currentRunId: string,
  dependencies: Dependencies,
): Promise<StagingWorkerBootstrapPrerequisitesVerification> {
  const consumerSpec = CONSUMERS[args.operation];
  const currentValue = await githubJson(
    dependencies,
    `/actions/runs/${currentRunId}`,
  );
  const current = validateRun(currentValue, {
    runId: currentRunId,
    candidateSha: args.candidateSha,
    workflowPath: consumerSpec.workflowPath,
    workflowName: consumerSpec.workflowName,
    status: "in_progress",
    conclusion: null,
    displayTitle: args.operation === "scale-evidence"
      ? null
      : consumerSpec.title(args.candidateSha),
  });
  const reviewedPullRequest = await verifyReviewedCandidate(
    args.candidateSha,
    dependencies,
  );
  const nowMs = dependencies.now().getTime();
  if (current.startedAtMs > nowMs + MAXIMUM_CLOCK_SKEW_MS) {
    fail("chronology_invalid");
  }

  const prerequisiteEvidence: PrerequisiteEvidence[] = [];
  let previousCompletedAtMs = Number.NEGATIVE_INFINITY;
  let preparedSourceSha: string | null = null;
  let quiescedSourceSha: string | null = null;
  for (const kind of requiredProducers(args.operation, args.bootstrapPath)) {
    const input = args.inputs.get(kind);
    if (!input) fail("arguments_invalid");
    const runValue = await githubJson(
      dependencies,
      `/actions/runs/${input.runId}`,
    );
    const spec = producerSpecForObservedRun(
      kind,
      args.candidateSha,
      runValue,
    );
    const run = validateRun(runValue, {
      runId: input.runId,
      candidateSha: args.candidateSha,
      workflowPath: spec.workflowPath,
      workflowName: spec.workflowName,
      status: "completed",
      conclusion: "success",
      displayTitle: spec.title(args.candidateSha),
    });
    if (
      run.startedAtMs < previousCompletedAtMs
      || run.completedAtMs > current.startedAtMs
      || nowMs - run.completedAtMs > MAXIMUM_RECEIPT_AGE_MS
    ) fail("chronology_invalid");
    previousCompletedAtMs = run.completedAtMs;

    const artifactName = spec.artifact(args.candidateSha);
    const artifactValue = await githubJson(
      dependencies,
      `/actions/runs/${input.runId}/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`,
    );
    const artifact = validateArtifact(
      artifactValue,
      input.runId,
      args.candidateSha,
      artifactName,
    );
    const historyWindow = `${run.createdAt}..${current.startedAt}`;
    const workflowId = path.basename(spec.workflowPath);
    const historyValue = await githubJson(
      dependencies,
      `/actions/workflows/${workflowId}/runs?branch=${BRANCH}`
        + `&event=workflow_dispatch&created=${encodeURIComponent(historyWindow)}`
        + "&per_page=100",
    );
    validateHistory(historyValue, spec, args.candidateSha, input.runId);

    let priorVerificationSha: string | null = null;
    if (
      kind === "quiesce" || kind === "cold-quiesce" ||
      kind === "restore" || kind === "activate"
    ) {
      if (!input.verificationFile) fail("arguments_invalid");
      const verificationInput = parseCanonicalPrivateJson(
        input.verificationFile,
        dependencies.readPrivateFile,
      );
      const prior = validatePriorVerification(
        verificationInput.source,
        verificationInput.value,
        {
          operation: kind,
          bootstrapPath: args.bootstrapPath,
          candidateSha: args.candidateSha,
          runId: input.runId,
        },
      );
      priorVerificationSha = prior.sha256;
      if (kind === "quiesce" || kind === "cold-quiesce") {
        quiescedSourceSha = prior.expectedDeploymentSha;
      }
    }
    const receiptInput = kind === "venue-directory"
      ? null
      : parseCanonicalPrivateJson(input.receiptFile, dependencies.readPrivateFile);
    const sourceSha: string = kind === "prepare" || kind === "cold-prepare"
      ? args.expectedDeploymentSha ?? "0".repeat(40)
      : kind === "quiesce" || kind === "cold-quiesce"
        ? quiescedSourceSha ?? "0".repeat(40)
        : args.candidateSha;
    const receipt: ReceiptSummary = kind === "venue-directory"
      ? validateVenueDirectoryEvidence(
        input.receiptFile, args.candidateSha, dependencies,
      )
      : validateReceipt(
        kind,
        receiptInput!.source,
        receiptInput!.value,
        args.candidateSha,
        sourceSha,
      );
    if (kind === "cold-quiesce") {
      if (!receiptInput) fail("receipt_invalid");
      const coldPrepare = args.inputs.get("cold-prepare");
      const boundPrepare = record(receiptInput.value.preparePrerequisite)
        ? receiptInput.value.preparePrerequisite
        : null;
      const boundSuccessorBridge = record(receiptInput.value.successorBridge)
        ? receiptInput.value.successorBridge
        : null;
      const bridgeVerifiedAtMs = Date.parse(
        String(boundSuccessorBridge?.verifiedAt ?? ""),
      );
      const runnerLoss = record(receiptInput.value.runnerLossReconciliation)
        ? receiptInput.value.runnerLossReconciliation
        : null;
      const runnerLossReconciled = receipt.outcome ===
        "reconciled_configured_zero_after_runner_loss";
      const bridgeRunAndChronologyExact = runnerLossReconciled
        ? boundSuccessorBridge?.currentRunId ===
            runnerLoss?.priorAmbiguousQuiesceRunId &&
          bridgeVerifiedAtMs < run.startedAtMs
        : boundSuccessorBridge?.currentRunId === input.runId &&
          bridgeVerifiedAtMs >= run.startedAtMs &&
          bridgeVerifiedAtMs <= run.completedAtMs;
      if (!coldPrepare || boundPrepare?.runId !== coldPrepare.runId ||
        !Number.isFinite(bridgeVerifiedAtMs) ||
        !bridgeRunAndChronologyExact) {
        fail("receipt_invalid");
      }
    }
    if (!receiptWithinRun(receipt, run)) fail("chronology_invalid");
    if (kind === "prepare" || kind === "cold-prepare") {
      preparedSourceSha = receipt.sourceSha;
    }
    if (
      (kind === "quiesce" || kind === "cold-quiesce")
      && (preparedSourceSha !== quiescedSourceSha
        || quiescedSourceSha === args.candidateSha)
    ) fail("receipt_invalid");
    if (
      (kind === "fenced-deployment"
        || kind === "venue-directory"
        || kind === "restore"
        || kind === "activate"
        || kind === "active-deployment")
      && receipt.sourceSha !== args.candidateSha
    ) fail("receipt_invalid");
    prerequisiteEvidence.push({
      kind,
      workflowPath: spec.workflowPath,
      runId: input.runId,
      runAttempt: 1,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      artifactName: artifact.name,
      artifactId: artifact.id,
      artifactDigest: artifact.digest,
      artifactSizeBytes: artifact.sizeBytes,
      receipt: {
        filename: receipt.filename,
        schemaVersion: receipt.schemaVersion,
        sha256: receipt.sha256,
        outcome: receipt.outcome,
        candidateSha: receipt.candidateSha,
        sourceSha: receipt.sourceSha,
        deploymentIdSha256: receipt.deploymentIdSha256,
        replicasBefore: receipt.replicasBefore,
        replicasAfter: receipt.replicasAfter,
      },
      prerequisiteVerificationSha256: priorVerificationSha,
    });
  }
  if (
    (args.operation === "quiesce" || args.operation === "cold-quiesce" ||
      args.operation === "cold-reconcile-quiesce")
    && preparedSourceSha !== args.expectedDeploymentSha
  ) fail("receipt_invalid");

  const verifiedAt = dependencies.now();
  const verification: StagingWorkerBootstrapPrerequisitesVerification = {
    schemaVersion: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA,
    policySha256: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256,
    operation: args.operation,
    bootstrapPath: args.bootstrapPath,
    candidateSha: args.candidateSha,
    expectedDeploymentSha: args.expectedDeploymentSha,
    repository: REPOSITORY,
    reviewedPullRequest,
    consumer: {
      workflowPath: consumerSpec.workflowPath,
      githubEnvironment: consumerSpec.environment,
      runId: currentRunId,
      runAttempt: 1,
      startedAt: current.startedAt,
    },
    prerequisites: prerequisiteEvidence,
    verifiedAt: verifiedAt.toISOString(),
    expiresAt: new Date(
      verifiedAt.getTime() + MAXIMUM_VERIFICATION_AGE_MS,
    ).toISOString(),
    checks: {
      policiesExact: true,
      currentMainExact: true,
      reviewedCandidateExact: true,
      consumerRunAuthorityExact: true,
      prerequisiteRunsExact: true,
      artifactNamesAndDigestsExact: true,
      receiptSchemasAndBindingsExact: true,
      strictChronologyExact: true,
      noLaterMatchingRunsExact: true,
      evidenceSecretFreeExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
  parseVerificationObject(canonical(verification), {
    operation: args.operation,
    bootstrapPath: args.bootstrapPath,
    candidateSha: args.candidateSha,
    currentRunId,
    now: verifiedAt,
  });
  return verification;
}

function defaultReadPrivateFile(
  filename: string,
  maximumBytes = MAXIMUM_EVIDENCE_BYTES,
): Buffer {
  return readTrustedRegularFile(filename, {
    minBytes: 1,
    maxBytes: maximumBytes,
    requireOwner: true,
    requirePrivate: true,
  });
}

function defaultWriteEvidence(filename: string, source: string): void {
  const directory = path.dirname(filename);
  const held = holdPrivateDirectoryIdentity(directory, {
    requireExactDirectoryMode: true,
    requireOwner: true,
  });
  let closed = false;
  try {
    held.assertExact();
    const identity = held.identity;
    held.close();
    closed = true;
    writePrivateExclusiveFile(directory, path.basename(filename), source, {
      requireExactDirectoryMode: true,
      requireOwner: true,
      expectedDirectoryIdentity: identity,
    });
  } catch {
    if (!closed) held.close();
    fail("evidence_invalid");
  }
}

export async function runStagingWorkerBootstrapPrerequisiteVerifier(
  overrides: Partial<Dependencies> = {},
): Promise<0 | 1> {
  const dependencies: Dependencies = {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    fetchImpl: fetch,
    now: () => new Date(),
    readPrivateFile: defaultReadPrivateFile,
    writeEvidence: defaultWriteEvidence,
    writeOutput: (source) => process.stdout.write(source),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    ...overrides,
  };
  try {
    const args = parseArguments(dependencies.argv);
    validatePolicies(dependencies.cwd);
    const currentRunId = validateEnvironment(args, dependencies.env);
    const verification = await verify(args, currentRunId, dependencies);
    const source = canonical(verification);
    dependencies.writeEvidence(args.output, source);
    dependencies.writeOutput(`${JSON.stringify({
      ok: true,
      operation: args.operation,
      bootstrapPath: args.bootstrapPath,
      candidateSha: args.candidateSha,
      policySha256: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256,
      prerequisiteRunIds: [...args.inputs.values()].map((input) => input.runId),
      verificationSha256: sha256(source),
      expiresAt: verification.expiresAt,
      productionContactAttempted: false,
      secretMaterialIncluded: false,
    })}\n`);
    return 0;
  } catch (error) {
    dependencies.writeOutput(`${JSON.stringify({
      ok: false,
      failureCode: error instanceof BootstrapPrerequisiteError
        ? error.code
        : "evidence_invalid",
      productionContactAttempted: false,
      secretMaterialIncluded: false,
    })}\n`);
    return 1;
  }
}

export const stagingWorkerBootstrapPrerequisiteInternals = {
  parseArguments,
  producerSpecForObservedRun,
  validatePolicies,
  validateEnvironment,
  validateRun,
  validateArtifact,
  validateHistory,
  validateWorkerReceipt,
  validateColdPrepareReceipt,
  validateColdQuiesceReceipt,
  validateScaleReceipt,
  validateDeploymentReceipt,
  validatePriorVerification,
};

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runStagingWorkerBootstrapPrerequisiteVerifier();
}
