import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { fetchBoundedResponseText } from "./lib/bounded-http-response.js";
import {
  holdPrivateDirectoryIdentity,
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

export const STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA =
  "pintpath-permanent-staging-worker-bootstrap-prerequisites/v1" as const;
export const STAGING_WORKER_BOOTSTRAP_PREREQUISITES_FILENAME =
  "prerequisites-verification.json" as const;
export const STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256 =
  "e052c0a6c6b5d9434335765b6f01a3824f1a467e25e01098f1fd1afc7f9347a2" as const;

const REPOSITORY = "blackmagic30/Beer" as const;
const BRANCH = "main" as const;
const GITHUB_API_ORIGIN = "https://api.github.com" as const;
const POLICY_PATH =
  "ops/railway/permanent-staging-worker-bootstrap-prerequisites-policy.json";
const WORKER_POLICY_PATH =
  "ops/railway/protected-automatic-maintenance-worker-fence-policy.json";
const WORKER_POLICY_SHA256 =
  "a06c7393dfc332461d2c82af310b9cfb654f17884f85cd489d157ce7d06f61a3";
const SCALE_POLICY_PATH =
  "ops/railway/permanent-staging-scale-evidence-policy.json";
const SCALE_POLICY_SHA256 =
  "7182b42fd454cab030e48f279d8d49ed9dc6638e5620b91d13b9ea08451afbd6";
const FENCED_DEPLOYMENT_POLICY_PATH =
  "ops/railway/permanent-staging-fenced-app-deployment-policy.json";
const FENCED_DEPLOYMENT_POLICY_SHA256 =
  "beda3ad174ae5c11757ce3b38f7f4b12a852e3c1726f009667d41d2423ad011e";
const ACTIVE_DEPLOYMENT_POLICY_PATH =
  "ops/railway/permanent-staging-app-deployment-policy.json";
const ACTIVE_DEPLOYMENT_POLICY_SHA256 =
  "27018e41f75661260e2d9a22b092c87d90490a46f85fcfb757f19d89e6cccae2";
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const WORKER_RECEIPT_SCHEMA =
  "pintpath-automatic-maintenance-worker-fence-terminal/v1";
const SCALE_RECEIPT_SCHEMA =
  "pintpath-permanent-staging-scale-operation/v2";
const DEPLOYMENT_RECEIPT_SCHEMA =
  "pintpath-railway-application-deployment-executor/v5";
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const MAXIMUM_GITHUB_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_EVIDENCE_BYTES = 1024 * 1024;
const MAXIMUM_RECEIPT_AGE_MS = 86_400_000;
const MAXIMUM_VERIFICATION_AGE_MS = 900_000;
const MAXIMUM_CLOCK_SKEW_MS = 300_000;
const REQUEST_TIMEOUT_MS = 20_000;

type JsonRecord = Record<string, unknown>;
export type BootstrapConsumerOperation =
  | "quiesce"
  | "fenced-deploy"
  | "restore"
  | "activate"
  | "active-deploy"
  | "scale-evidence";
type ProducerKind =
  | "prepare"
  | "quiesce"
  | "fenced-deployment"
  | "restore"
  | "activate"
  | "active-deployment";

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
  "fenced-deployment": {
    workflowPath: ".github/workflows/deploy-permanent-staging.yml",
    workflowName: "Deploy Pint Path permanent staging",
    title: (sha) => `Deploy permanent staging | fenced | ${sha}`,
    artifact: (sha) =>
      `pintpath-permanent-staging-fenced-deployment-${sha}`,
    receiptFilename: "deployment-receipt.json",
    receiptSchema: DEPLOYMENT_RECEIPT_SCHEMA,
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

const REQUIRED_PRODUCERS: Readonly<
  Record<BootstrapConsumerOperation, readonly ProducerKind[]>
> = Object.freeze({
  quiesce: ["prepare"],
  "fenced-deploy": ["prepare", "quiesce"],
  restore: ["prepare", "quiesce", "fenced-deployment"],
  activate: ["prepare", "quiesce", "fenced-deployment", "restore"],
  "active-deploy": ["activate"],
  "scale-evidence": ["activate", "active-deployment"],
});

const CONSUMERS = Object.freeze({
  quiesce: {
    workflowPath:
      ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
    workflowName:
      "Bootstrap permanent-staging automatic-maintenance worker fence",
    title: (sha: string) => `Permanent staging worker bootstrap | quiesce | ${sha}`,
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
  activate: {
    workflowPath:
      ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
    workflowName:
      "Configure candidate-bound automatic-maintenance worker fence",
    title: (sha: string) =>
      `Automatic maintenance worker fence | permanent-staging | activate | ${sha}`,
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
  quiesce: {
    run: "--quiesce-run-id",
    receipt: "--quiesce-receipt-file",
  },
  "fenced-deployment": {
    run: "--fenced-deployment-run-id",
    receipt: "--fenced-deployment-receipt-file",
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
  readonly replicasBefore: number;
  readonly replicasAfter: number;
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
  readonly readPrivateFile: (filename: string) => Buffer;
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
  const candidateSha = values.get("--candidate-sha") ?? "";
  const expectedDeploymentSha =
    values.get("--expected-deployment-sha") ?? null;
  const output = values.get("--output") ?? "";
  if (
    !operation
    || !Object.hasOwn(REQUIRED_PRODUCERS, operation)
    || !SHA_PATTERN.test(candidateSha)
    || !exactAbsoluteFile(
      output,
      STAGING_WORKER_BOOTSTRAP_PREREQUISITES_FILENAME,
    )
  ) fail("arguments_invalid");
  if (
    operation === "quiesce"
      ? expectedDeploymentSha === null
        || !SHA_PATTERN.test(expectedDeploymentSha)
        || expectedDeploymentSha === candidateSha
      : operation === "restore"
        ? expectedDeploymentSha !== candidateSha
        : expectedDeploymentSha !== null
  ) fail("arguments_invalid");

  const required = new Set(REQUIRED_PRODUCERS[operation]);
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
  return { operation, candidateSha, expectedDeploymentSha, output, inputs };
}

function validatePolicies(cwd: string): void {
  const policies = [
    [POLICY_PATH, STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256],
    [WORKER_POLICY_PATH, WORKER_POLICY_SHA256],
    [SCALE_POLICY_PATH, SCALE_POLICY_SHA256],
    [FENCED_DEPLOYMENT_POLICY_PATH, FENCED_DEPLOYMENT_POLICY_SHA256],
    [ACTIVE_DEPLOYMENT_POLICY_PATH, ACTIVE_DEPLOYMENT_POLICY_SHA256],
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
    || run.name !== input.workflowName
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
): { readonly source: string; readonly value: JsonRecord } {
  let bytes: Buffer | null = null;
  try {
    bytes = readPrivateFile(filename);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(source) as unknown;
    if (!record(value) || canonical(value) !== source) fail("receipt_invalid");
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
  "runtimeRoutesPolledExact",
  "runtimeMaintenanceStateExact",
  "boundaryPostflightExact",
  "noOtherProviderChanges",
  "terminalEvidenceExact",
] as const;

function validateWorkerReceipt(
  source: string,
  value: JsonRecord,
  candidateSha: string,
  operation: "prepare" | "activate",
): ReceiptSummary {
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
      "providerAfterSha256",
      "deploymentBeforeIdSha256",
      "deploymentAfterIdSha256",
      "sourceBeforeSha",
      "sourceAfterSha",
      "sourcePreservedExact",
      "deploymentIdChanged",
      "topologyBeforeSha256",
      "topologyAfterSha256",
      "collateralVariablesBeforeSha256",
      "collateralVariablesAfterSha256",
    ])
    || provider.graphqlOperation !== "variableCollectionUpsert"
    || provider.mutationCallCount !== 1
    || provider.acknowledgementExact !== true
    || !SHA256_PATTERN.test(String(provider.providerBeforeSha256))
    || !SHA256_PATTERN.test(String(provider.providerAfterSha256))
    || !SHA256_PATTERN.test(String(provider.deploymentBeforeIdSha256))
    || !SHA256_PATTERN.test(String(provider.deploymentAfterIdSha256))
    || !SHA_PATTERN.test(String(provider.sourceBeforeSha))
    || !SHA_PATTERN.test(String(provider.sourceAfterSha))
    || provider.sourcePreservedExact !== true
    || provider.deploymentIdChanged !== enabled
    || !SHA256_PATTERN.test(String(provider.topologyBeforeSha256))
    || !SHA256_PATTERN.test(String(provider.topologyAfterSha256))
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

const SCALE_CHECK_KEYS = [
  "policyExact",
  "githubAuthorityExact",
  "tokenScopesExact",
  "cliExact",
  "boundaryPreflightExact",
  "targetPreflightExact",
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
  "boundaryPostflightExact",
  "terminalEvidenceExact",
  "finalReceiptEvidenceExact",
] as const;

function validateScaleReceipt(
  source: string,
  value: JsonRecord,
  candidateSha: string,
  kind: "quiesce" | "restore",
  sourceSha: string,
): ReceiptSummary {
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
  "prerequisiteExact",
  "boundaryPreflightExact",
  "targetPreflightExact",
  "gitAutodeployAbsent",
  "collateralInventoryExact",
  "durableIntentExact",
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
  "collateralStateUnchanged",
  "boundaryPostflightExact",
  "terminalEvidenceExact",
] as const;

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
    "runtimeResponseSha256s",
    "checks",
  ])) fail("receipt_invalid");
  const collateral = record(value.collateralSnapshotSha256s)
    ? value.collateralSnapshotSha256s
    : null;
  const replicas = record(value.replicaCounts) ? value.replicaCounts : null;
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
    || !exactKeys(runtime, ["health", "startup", "ready"])
    || (kind === "fenced-deployment"
      ? runtime.health !== null
        || runtime.startup !== null
        || runtime.ready !== null
      : !SHA256_PATTERN.test(String(runtime.health))
        || !SHA256_PATTERN.test(String(runtime.startup))
        || !SHA256_PATTERN.test(String(runtime.ready)))
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

function validatePriorVerification(
  source: string,
  value: JsonRecord,
  input: {
    readonly operation: "quiesce" | "restore";
    readonly candidateSha: string;
    readonly runId: string;
  },
): { readonly sha256: string; readonly expectedDeploymentSha: string } {
  if (!exactKeys(value, [
    "schemaVersion",
    "policySha256",
    "operation",
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
  ])) fail("receipt_invalid");
  const consumer = record(value.consumer) ? value.consumer : null;
  const expectedKinds = REQUIRED_PRODUCERS[input.operation];
  const prerequisites = Array.isArray(value.prerequisites)
    ? value.prerequisites.filter(record)
    : [];
  if (
    value.schemaVersion !== STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA
    || value.policySha256
      !== STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256
    || value.operation !== input.operation
    || value.candidateSha !== input.candidateSha
    || !SHA_PATTERN.test(String(value.expectedDeploymentSha))
    || (input.operation === "quiesce"
      ? value.expectedDeploymentSha === input.candidateSha
      : value.expectedDeploymentSha !== input.candidateSha)
    || value.repository !== REPOSITORY
    || !exactKeys(consumer, [
      "workflowPath",
      "githubEnvironment",
      "runId",
      "runAttempt",
      "startedAt",
    ])
    || consumer.workflowPath !== CONSUMERS[input.operation].workflowPath
    || consumer.githubEnvironment !== CONSUMERS[input.operation].environment
    || consumer.runId !== input.runId
    || consumer.runAttempt !== 1
    || prerequisites.length !== expectedKinds.length
    || prerequisites.some((item, index) =>
      item.kind !== expectedKinds[index]
      || item.workflowPath !== PRODUCERS[expectedKinds[index]!].workflowPath
      || item.runAttempt !== 1
      || !RUN_ID_PATTERN.test(String(item.runId))
      || !ARTIFACT_DIGEST_PATTERN.test(String(item.artifactDigest))
      || !record(item.receipt)
      || item.receipt.candidateSha !== input.candidateSha
      || !SHA256_PATTERN.test(String(item.receipt.sha256)))
    || !exactTrueChecks(value.checks, VERIFICATION_CHECK_KEYS)
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
  ) fail("receipt_invalid");
  return {
    sha256: sha256(source),
    expectedDeploymentSha: String(value.expectedDeploymentSha),
  };
}

function validateReceipt(
  kind: ProducerKind,
  source: string,
  value: JsonRecord,
  candidateSha: string,
  sourceSha: string,
): ReceiptSummary {
  if (kind === "prepare" || kind === "activate") {
    return validateWorkerReceipt(source, value, candidateSha, kind);
  }
  if (kind === "quiesce" || kind === "restore") {
    return validateScaleReceipt(source, value, candidateSha, kind, sourceSha);
  }
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
  const requiredKinds = REQUIRED_PRODUCERS[expected.operation];
  if (
    value.schemaVersion !== STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA
    || value.policySha256
      !== STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256
    || value.operation !== expected.operation
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
      || item.receipt.schemaVersion
        !== PRODUCERS[requiredKinds[index]!].receiptSchema
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
  for (const kind of REQUIRED_PRODUCERS[args.operation]) {
    const input = args.inputs.get(kind);
    if (!input) fail("arguments_invalid");
    const spec = PRODUCERS[kind];
    const runValue = await githubJson(
      dependencies,
      `/actions/runs/${input.runId}`,
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
    if (kind === "quiesce" || kind === "restore") {
      if (!input.verificationFile) fail("arguments_invalid");
      const verificationInput = parseCanonicalPrivateJson(
        input.verificationFile,
        dependencies.readPrivateFile,
      );
      const prior = validatePriorVerification(
        verificationInput.source,
        verificationInput.value,
        { operation: kind, candidateSha: args.candidateSha, runId: input.runId },
      );
      priorVerificationSha = prior.sha256;
      if (kind === "quiesce") quiescedSourceSha = prior.expectedDeploymentSha;
    }
    const receiptInput = parseCanonicalPrivateJson(
      input.receiptFile,
      dependencies.readPrivateFile,
    );
    const sourceSha = kind === "prepare"
      ? args.expectedDeploymentSha ?? "0".repeat(40)
      : kind === "quiesce"
        ? quiescedSourceSha ?? "0".repeat(40)
        : args.candidateSha;
    const receipt = validateReceipt(
      kind,
      receiptInput.source,
      receiptInput.value,
      args.candidateSha,
      sourceSha,
    );
    if (!receiptWithinRun(receipt, run)) fail("chronology_invalid");
    if (kind === "prepare") preparedSourceSha = receipt.sourceSha;
    if (
      kind === "quiesce"
      && (preparedSourceSha !== quiescedSourceSha
        || quiescedSourceSha === args.candidateSha)
    ) fail("receipt_invalid");
    if (
      (kind === "fenced-deployment"
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
    args.operation === "quiesce"
    && preparedSourceSha !== args.expectedDeploymentSha
  ) fail("receipt_invalid");

  const verifiedAt = dependencies.now();
  const verification: StagingWorkerBootstrapPrerequisitesVerification = {
    schemaVersion: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_SCHEMA,
    policySha256: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256,
    operation: args.operation,
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
    candidateSha: args.candidateSha,
    currentRunId,
    now: verifiedAt,
  });
  return verification;
}

function defaultReadPrivateFile(filename: string): Buffer {
  return readTrustedRegularFile(filename, {
    minBytes: 1,
    maxBytes: MAXIMUM_EVIDENCE_BYTES,
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
  validatePolicies,
  validateEnvironment,
  validateRun,
  validateArtifact,
  validateHistory,
  validateWorkerReceipt,
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
