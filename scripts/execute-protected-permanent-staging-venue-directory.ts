import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stripVTControlCharacters, TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import { fetchBoundedResponseText } from "./lib/bounded-http-response.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

export const VENUE_DIRECTORY_POLICY_PATH =
  "ops/supabase/permanent-staging-venue-directory-policy.json" as const;
export const VENUE_DIRECTORY_POLICY_SHA256 =
  "08d01a0c1d97677334c734354d691159084b4e432512d0d25e2617f10a07d94f" as const;
export const VENUE_DIRECTORY_PLAN_SCHEMA =
  "pintpath-permanent-staging-venue-import-plan/v1" as const;
export const VENUE_DIRECTORY_IMPORT_TERMINAL_SCHEMA =
  "pintpath-permanent-staging-venue-import-terminal/v1" as const;
export const VENUE_DIRECTORY_TERMINAL_SCHEMA =
  "pintpath-permanent-staging-venue-directory-terminal/v1" as const;
export const VENUE_DIRECTORY_FENCED_AUTHORITY_SCHEMA =
  "pintpath-permanent-staging-venue-fenced-authority/v1" as const;
export const VENUE_DIRECTORY_INTENT_SCHEMA =
  "pintpath-permanent-staging-venue-directory-intent/v1" as const;
export const VENUE_DIRECTORY_CONSTRAINT_PREFLIGHT_SCHEMA =
  "pintpath-permanent-staging-venue-constraint-preflight/v1" as const;
export const VENUE_DIRECTORY_MIGRATION_PREWRITE_SCHEMA =
  "pintpath-permanent-staging-venue-migration-prewrite/v1" as const;
export const VENUE_DIRECTORY_MIGRATION_APPLY_SCHEMA =
  "pintpath-permanent-staging-venue-migration-apply/v1" as const;
export const VENUE_DIRECTORY_CONSTRAINT_POSTFLIGHT_SCHEMA =
  "pintpath-permanent-staging-venue-constraint-postflight/v1" as const;

const PROJECT_REF = "bbfibbadwjxzrcdncavy";
const PROJECT_ORIGIN = `https://${PROJECT_REF}.supabase.co`;
const REPOSITORY = "blackmagic30/Beer";
const WORKFLOW_PATH =
  ".github/workflows/permanent-staging-venue-directory.yml";
const WORKFLOW_NAME = "Apply and prove permanent-staging venue directory";
const RUN_NAME_PREFIX =
  "Permanent staging venue directory | apply-refresh-validate | ";
const FENCED_WORKFLOW_PATH = ".github/workflows/deploy-permanent-staging.yml";
const FENCED_WORKFLOW_ID = "deploy-permanent-staging.yml";
const FENCED_WORKFLOW_NAME = "Deploy Pint Path permanent staging";
const FENCED_RUN_NAME_PREFIX = "Deploy permanent staging | fenced | ";
const FENCED_ARTIFACT_PREFIX =
  "pintpath-permanent-staging-fenced-deployment-";
const IMPORTER_PATH = "scripts/import-melbourne-venues.ts";
const OPERATION = "directory-discovery-and-status-refresh";
const FREEZE_ATTESTATION =
  "I_ATTEST_EXTERNAL_PERMANENT_STAGING_VENUE_ROW_AND_SCHEMA_MIGRATION_WRITERS_ARE_FROZEN_FOR_THIS_RUN";
const DEPLOYMENT_RECEIPT_SCHEMA =
  "pintpath-railway-application-deployment-executor/v5";
const DEPLOYMENT_RECEIPT_OPERATION =
  "pintpath-railway-application-source-upload";
const DEPLOYMENT_CHECK_KEYS = Object.freeze([
  "boundaryPostflightExact",
  "boundaryPreflightExact",
  "cliExact",
  "collateralInventoryExact",
  "collateralStateUnchanged",
  "costPolicyExact",
  "deploymentExact",
  "durableIntentExact",
  "gitAutodeployAbsent",
  "githubMainExact",
  "policyExact",
  "prerequisiteExact",
  "reconciliationCompleted",
  "runtimeHealthExact",
  "runtimeReadinessExact",
  "runtimeStartupExact",
  "sourceAuthorityExact",
  "sourceReasserted",
  "targetPostflightAttempted",
  "targetPostflightExact",
  "targetPreflightExact",
  "terminalEvidenceExact",
  "topologyPreserved",
  "workerFenceDeploymentContinuityExact",
  "workerFencePrerequisiteExact",
  "writeAttemptedAtMostOnce",
  "writeTokenScopeExact",
] as const);
const PLAN_KEYS = Object.freeze([
  "schemaVersion", "planSha256", "candidateSha", "supabaseProjectRef",
  "databaseContract", "operation", "startedAt", "completedAt", "checkedAt",
  "inputSnapshot", "collection", "projected", "transitions",
] as const);
const IMPORT_TERMINAL_KEYS = Object.freeze([
  "schemaVersion", "status", "outcome", "candidateSha",
  "supabaseProjectRef", "databaseContract", "planSha256", "startedAt",
  "completedAt", "preflightSnapshot", "finalSnapshot",
  "attemptedWriteCount", "successfulWriteCount", "insertedCount",
  "updatedCount", "excludedCount", "partialWrite", "samePlanRetryAllowed",
  "failure",
] as const);
const CONSTRAINT_PREFLIGHT_KEYS = Object.freeze([
  "schemaVersion", "candidateSha", "supabaseProjectRef", "databaseContract",
  "migrationMode", "localMigrationVersions", "remoteMigrationVersions",
  "constraints", "violationCounts", "targetLedger", "dryRun",
  "preflightVerifier", "checkedAt", "checks",
  "secretMaterialIncluded", "secretDerivedCommitmentsIncluded",
] as const);
const MIGRATION_PREWRITE_KEYS = Object.freeze([
  "schemaVersion", "candidateSha", "supabaseProjectRef", "databaseContract",
  "migrationMode", "planSha256", "localMigrationVersions",
  "remoteMigrationVersions", "constraints", "violationCounts", "targetLedger",
  "dryRun", "checkedAt", "checks", "secretMaterialIncluded",
  "secretDerivedCommitmentsIncluded",
] as const);
const MIGRATION_APPLY_KEYS = Object.freeze([
  "schemaVersion", "candidateSha", "supabaseProjectRef", "databaseContract",
  "migrationMode", "planSha256", "startedAt", "completedAt",
  "writeAttempts", "acknowledgement", "exitCode", "command",
  "cliStdoutSha256", "cliStderrSha256",
  "samePlanRetryAllowed", "secretMaterialIncluded",
  "secretDerivedCommitmentsIncluded",
] as const);
const CONSTRAINT_POSTFLIGHT_KEYS = Object.freeze([
  "schemaVersion", "candidateSha", "supabaseProjectRef", "databaseContract",
  "migrationMode", "planSha256", "migrationApplySha256",
  "localMigrationVersions", "remoteMigrationVersions", "constraints",
  "violationCounts", "targetLedger", "dryRun", "strictVerifier", "checkedAt",
  "checks", "secretMaterialIncluded", "secretDerivedCommitmentsIncluded",
] as const);
const BOUNDARY_TERMINAL_KEYS = Object.freeze([
  "schemaVersion", "status", "outcome", "candidateSha", "supabaseProjectRef",
  "databaseContract", "migrationMode", "planSha256", "importTerminalSha256",
  "constraintPreflightSha256", "migrationPrewriteSha256",
  "migrationApplySha256", "constraintPostflightSha256", "startedAt",
  "completedAt", "migrationWriteAttempts", "samePlanRetryAllowed",
  "secretMaterialIncluded", "secretDerivedCommitmentsIncluded", "checks",
  "failure",
] as const);
const BOUNDARY_CHECK_KEYS = Object.freeze([
  "importApplied", "preflightStructureExact", "preflightZeroViolations",
  "preflightConstraintLedgerStateExact", "pendingSetPreflightExact",
  "pendingSetPrewriteExact", "migrationMutationExact", "migrationLedgerRecorded",
  "noPendingMigrationsPostflight", "constraintsValidatedPostflight",
] as const);
const CONSTRAINT_PREFLIGHT_CHECK_KEYS = Object.freeze([
  "structureExact", "zeroViolations", "constraintLedgerStateExact",
  "migrationFileExact", "pendingSetExact", "remoteLedgerExact",
] as const);
const MIGRATION_PREWRITE_CHECK_KEYS = Object.freeze([
  "planSealed", "repositoryMainExact", "stateUnchanged",
  "migrationFileExact", "pendingSetExact", "remoteLedgerExact",
] as const);
const CONSTRAINT_POSTFLIGHT_CHECK_KEYS = Object.freeze([
  "migrationLedgerRecorded", "noPendingMigrations", "constraintsValidated",
  "strictSchemaExact", "migrationFileExact", "remoteLedgerExact",
  "zeroViolations",
] as const);
const MANAGED_ROW_KEYS = Object.freeze([
  "id", "google_place_id", "name", "address", "suburb", "state",
  "postcode", "phone", "website", "latitude", "longitude",
  "business_status", "last_checked_at", "directory_eligible", "source",
] as const);
const DESIRED_ROW_KEYS = Object.freeze(MANAGED_ROW_KEYS.filter((key) => key !== "id"));
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const PREFLIGHT_VERIFIER = Object.freeze({
  path: "scripts/ci/supabase-venue-directory-preflight-verify.sql",
  sha256: "9ae8804c03f7f515beaa80b6fb99ae886f200712482c21ae5eae11f9709b8c6a",
  bytes: 6189,
});
const STRICT_VERIFIER = Object.freeze({
  path: "scripts/ci/supabase-venue-directory-schema-verify.sql",
  sha256: "e2a6d9cd5a5dcbc14c6932d2ac4c44f81814249c0338e9eb54e72a1a985a6130",
  bytes: 3956,
});

const DATABASE_CONTRACT = Object.freeze({
  migrationVersion: "20260901032339",
  migrationPath:
    "supabase/migrations/20260901032339_validate_external_venue_directory_constraints.sql",
  migrationSha256:
    "5068c2a678813e57fde83b29d3cb5e438ce9070705f246827b7ee8e2a70ee96c",
  migrationBytes: 161,
  validatedConstraints: Object.freeze([
    "venues_australian_postcode_check",
    "venues_business_status_check",
  ]),
});
const FIRST_RUN_MIGRATION_INVENTORY = Object.freeze([
  Object.freeze({
    version: DATABASE_CONTRACT.migrationVersion,
    filename:
      "20260901032339_validate_external_venue_directory_constraints.sql",
    path: DATABASE_CONTRACT.migrationPath,
    sha256: DATABASE_CONTRACT.migrationSha256,
    bytes: DATABASE_CONTRACT.migrationBytes,
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
const FIRST_RUN_MIGRATION_VERSIONS = Object.freeze(
  FIRST_RUN_MIGRATION_INVENTORY.map((migration) => migration.version),
);
const FIRST_RUN_MIGRATION_FILENAMES = Object.freeze(
  FIRST_RUN_MIGRATION_INVENTORY.map((migration) => migration.filename),
);

type JsonRecord = Record<string, unknown>;
type Mode =
  | "verify-fenced-authority"
  | "plan-refresh-validate"
  | "apply-refresh-validate"
  | "finalize-database-proof";

interface CommandResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

interface Arguments {
  readonly mode: Mode;
  readonly candidateSha: string;
  readonly fencedDeploymentRunId: string;
  readonly fencedDeploymentReceipt: string | null;
  readonly output: string | null;
  readonly fencedAuthorityFile: string | null;
  readonly evidenceDirectory: string | null;
}

interface Dependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly now: () => Date;
  readonly readText: (filename: string, maximumBytes: number) => string;
  readonly writeExclusive: (directory: string, leaf: string, source: string) => void;
  readonly runCommand: (request: CommandRequest) => CommandResult;
  readonly writeOutput: (source: string) => void;
}

function fail(code: string): never {
  throw new Error(`protected_permanent_staging_venue_directory_${code}`);
}

function record(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, keys: readonly string[]): value is JsonRecord {
  return record(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!record(value)) return value;
  const result: JsonRecord = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key]);
  return result;
}

export function canonicalVenueDirectoryJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timestamp(value: unknown, code: string): { canonical: string; milliseconds: number } {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(code);
  const canonical = new Date(milliseconds).toISOString();
  if (canonical !== (value.includes(".") ? value : value.replace("Z", ".000Z"))) {
    fail(code);
  }
  return { canonical, milliseconds };
}

function safeAbsolute(value: string, leaf?: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value
    && !value.includes("\0") && (leaf === undefined || path.basename(value) === leaf);
}

function parseArguments(argv: readonly string[]): Arguments {
  if (argv.length !== 10) fail("arguments_invalid");
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) fail("arguments_invalid");
    values.set(key, value);
  }
  const mode = values.get("--mode") ?? "";
  const candidateSha = values.get("--candidate-sha") ?? "";
  const fencedDeploymentRunId = values.get("--fenced-deployment-run-id") ?? "";
  if (!SHA.test(candidateSha) || !RUN_ID.test(fencedDeploymentRunId)) {
    fail("arguments_invalid");
  }
  if (mode === "verify-fenced-authority") {
    const receipt = values.get("--fenced-deployment-receipt") ?? "";
    const output = values.get("--output") ?? "";
    if (values.size !== 5 || !safeAbsolute(receipt, "deployment-receipt.json")
      || !safeAbsolute(output, "fenced-authority.json")) fail("arguments_invalid");
    return {
      mode, candidateSha, fencedDeploymentRunId,
      fencedDeploymentReceipt: receipt, output,
      fencedAuthorityFile: null, evidenceDirectory: null,
    };
  }
  if (mode === "plan-refresh-validate" || mode === "apply-refresh-validate"
    || mode === "finalize-database-proof") {
    const authority = values.get("--fenced-authority-file") ?? "";
    const evidenceDirectory = values.get("--evidence-dir") ?? "";
    if (values.size !== 5 || !safeAbsolute(authority, "fenced-authority.json")
      || !safeAbsolute(evidenceDirectory)) fail("arguments_invalid");
    return {
      mode, candidateSha, fencedDeploymentRunId,
      fencedDeploymentReceipt: null, output: null,
      fencedAuthorityFile: authority, evidenceDirectory,
    };
  }
  fail("arguments_invalid");
}

function readUtf8(filename: string, maximumBytes: number): string {
  const value = readTrustedRegularFile(filename, {
    minBytes: 2,
    maxBytes: maximumBytes,
    requireOwner: true,
  });
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function defaultWrite(directory: string, leaf: string, source: string): void {
  writePrivateExclusiveFile(directory, leaf, source, {
    requireExactDirectoryMode: true,
    requireOwner: true,
  });
}

function defaultCommand(request: CommandRequest): CommandResult {
  const result = spawnSync(request.command, [...request.args], {
    cwd: request.cwd,
    env: request.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90 * 60 * 1_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const DEFAULT_DEPENDENCIES: Omit<Dependencies, "argv" | "env" | "cwd"> = {
  fetchImpl: fetch,
  now: () => new Date(),
  readText: readUtf8,
  writeExclusive: defaultWrite,
  runCommand: defaultCommand,
  writeOutput: (source) => process.stdout.write(source),
};

function readJsonCanonical(
  dependencies: Dependencies,
  filename: string,
  maximumBytes = MAX_JSON_BYTES,
): { source: string; value: JsonRecord } {
  let source: string;
  let value: unknown;
  try {
    source = dependencies.readText(filename, maximumBytes);
    value = JSON.parse(source);
  } catch {
    return fail("json_invalid");
  }
  if (!record(value) || source !== canonicalVenueDirectoryJson(value)) fail("json_invalid");
  return { source, value };
}

function validateRepositoryInputs(dependencies: Dependencies): void {
  const policy = path.resolve(dependencies.cwd, VENUE_DIRECTORY_POLICY_PATH);
  const preflightVerifier = path.resolve(dependencies.cwd, PREFLIGHT_VERIFIER.path);
  const strictVerifier = path.resolve(dependencies.cwd, STRICT_VERIFIER.path);
  let policySource: string;
  let migrationSources: readonly string[];
  let preflightVerifierSource: string;
  let strictVerifierSource: string;
  try {
    policySource = fs.readFileSync(policy, "utf8");
    migrationSources = FIRST_RUN_MIGRATION_INVENTORY.map((migration) =>
      fs.readFileSync(path.resolve(dependencies.cwd, migration.path), "utf8"));
    preflightVerifierSource = fs.readFileSync(preflightVerifier, "utf8");
    strictVerifierSource = fs.readFileSync(strictVerifier, "utf8");
    JSON.parse(policySource);
  } catch {
    return fail("repository_contract_invalid");
  }
  if (sha256(policySource) !== VENUE_DIRECTORY_POLICY_SHA256
    || policySource !== `${JSON.stringify(JSON.parse(policySource), null, 2)}\n`
    || migrationSources.some((source, index) => {
      const migration = FIRST_RUN_MIGRATION_INVENTORY[index]!;
      return Buffer.byteLength(source) !== migration.bytes
        || sha256(source) !== migration.sha256;
    })
    || Buffer.byteLength(preflightVerifierSource) !== PREFLIGHT_VERIFIER.bytes
    || sha256(preflightVerifierSource) !== PREFLIGHT_VERIFIER.sha256
    || Buffer.byteLength(strictVerifierSource) !== STRICT_VERIFIER.bytes
    || sha256(strictVerifierSource) !== STRICT_VERIFIER.sha256) {
    fail("repository_contract_invalid");
  }
}

async function githubJson(
  dependencies: Dependencies,
  url: string,
  token: string,
): Promise<JsonRecord> {
  let source: string;
  let response: Response;
  try {
    const bounded = await fetchBoundedResponseText(
      dependencies.fetchImpl,
      url,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "pintpath-permanent-staging-venue-directory/1",
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        cache: "no-store",
      },
      {
        maximumBytes: 2 * 1024 * 1024,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    source = bounded.source;
    response = bounded.response;
  } catch {
    return fail("github_api_failed");
  }
  if (!response.ok) fail("github_api_failed");
  try {
    const value: unknown = JSON.parse(source);
    return record(value) ? value : fail("github_api_invalid");
  } catch {
    return fail("github_api_invalid");
  }
}

function repositoryExact(value: unknown): boolean {
  return record(value) && value.full_name === REPOSITORY;
}

function workflowPathExact(value: unknown, expected: string): boolean {
  return value === expected || value === `${expected}@main`;
}

function validateDeploymentReceipt(
  source: string,
  value: JsonRecord,
  candidateSha: string,
  runStartedAt: number,
  runUpdatedAt: number,
): void {
  const keys = [
    "schemaVersion", "operation", "executorState", "target", "outcome",
    "failureCode", "candidateSha", "startedAt", "completedAt",
    "writeAttempts", "acknowledgement", "previousDeploymentIdSha256",
    "deploymentIdSha256", "intentSha256", "cliOutputSha256",
    "boundaryPreflightSha256", "boundaryPostflightSha256",
    "collateralSnapshotSha256s", "replicaCounts", "runtimeResponseSha256s",
    "workerFencePrerequisite", "checks",
  ];
  const replicas = value.replicaCounts;
  const runtime = value.runtimeResponseSha256s;
  const collateral = value.collateralSnapshotSha256s;
  const checks = value.checks;
  const started = timestamp(value.startedAt, "fenced_receipt_invalid");
  const completed = timestamp(value.completedAt, "fenced_receipt_invalid");
  const successfulOutcomes = ["deployed", "already_deployed", "reconciled_success"];
  const outcome = String(value.outcome);
  const relation = outcome === "already_deployed"
    ? value.writeAttempts === 0 && value.acknowledgement === "not_attempted"
      && value.cliOutputSha256 === null
    : value.writeAttempts === 1
      && (outcome === "deployed"
        ? value.acknowledgement === "received"
        : value.acknowledgement === "missing_or_failed")
      && SHA256.test(String(value.cliOutputSha256));
  if (source !== `${JSON.stringify(value, null, 2)}\n`
    || !exactKeys(value, keys)
    || value.schemaVersion !== DEPLOYMENT_RECEIPT_SCHEMA
    || value.operation !== DEPLOYMENT_RECEIPT_OPERATION
    || value.executorState !== "GITHUB_ENVIRONMENT_PROTECTED"
    || value.target !== "permanent-staging" || value.failureCode !== null
    || value.candidateSha !== candidateSha || !successfulOutcomes.includes(outcome)
    || !relation || started.milliseconds < runStartedAt
    || completed.milliseconds < started.milliseconds
    || completed.milliseconds > runUpdatedAt
    || !SHA256.test(String(value.previousDeploymentIdSha256))
    || !SHA256.test(String(value.deploymentIdSha256))
    || !SHA256.test(String(value.intentSha256))
    || !SHA256.test(String(value.boundaryPreflightSha256))
    || !SHA256.test(String(value.boundaryPostflightSha256))
    || !exactKeys(collateral, ["before", "after"])
    || !SHA256.test(String(collateral.before)) || collateral.after !== collateral.before
    || !exactKeys(replicas, ["before", "after"])
    || replicas.before !== 0 || replicas.after !== 0
    || !exactKeys(runtime, ["health", "startup", "ready"])
    || Object.values(runtime).some((item) => item !== null)
    || value.workerFencePrerequisite !== null
    || !exactKeys(checks, DEPLOYMENT_CHECK_KEYS)
    || Object.values(checks).some((item) => item !== true)) {
    fail("fenced_receipt_invalid");
  }
}

async function verifyFencedAuthority(
  args: Arguments,
  dependencies: Dependencies,
): Promise<number> {
  const receiptFilename = args.fencedDeploymentReceipt ?? fail("arguments_invalid");
  const output = args.output ?? fail("arguments_invalid");
  const env = dependencies.env;
  const token = env.GITHUB_TOKEN ?? "";
  const currentRunId = env.GITHUB_RUN_ID ?? "";
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== REPOSITORY
    || env.GITHUB_API_URL !== "https://api.github.com"
    || env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_SHA !== args.candidateSha
    || env.GITHUB_RUN_ATTEMPT !== "1" || !RUN_ID.test(currentRunId)
    || currentRunId === args.fencedDeploymentRunId || token.length < 16
    || /[\r\n\0]/.test(token)) fail("github_environment_invalid");
  const base = `https://api.github.com/repos/${REPOSITORY}`;
  const [current, fenced, history, artifacts] = await Promise.all([
    githubJson(dependencies, `${base}/actions/runs/${currentRunId}`, token),
    githubJson(dependencies,
      `${base}/actions/runs/${args.fencedDeploymentRunId}`, token),
    githubJson(dependencies,
      `${base}/actions/workflows/${FENCED_WORKFLOW_ID}/runs?branch=main&event=workflow_dispatch&per_page=100`,
      token),
    githubJson(dependencies,
      `${base}/actions/runs/${args.fencedDeploymentRunId}/artifacts?name=${encodeURIComponent(`${FENCED_ARTIFACT_PREFIX}${args.candidateSha}`)}&per_page=100`,
      token),
  ]);
  const currentStarted = timestamp(current.run_started_at, "consumer_run_invalid");
  if (String(current.id) !== currentRunId || !repositoryExact(current.repository)
    || !repositoryExact(current.head_repository) || current.head_sha !== args.candidateSha
    || current.head_branch !== "main" || !workflowPathExact(current.path, WORKFLOW_PATH)
    || current.name !== WORKFLOW_NAME
    || current.display_title !== `${RUN_NAME_PREFIX}${args.candidateSha}`
    || current.event !== "workflow_dispatch" || current.run_attempt !== 1
    || current.status !== "in_progress" || current.conclusion !== null) {
    fail("consumer_run_invalid");
  }
  const fencedStarted = timestamp(fenced.run_started_at, "fenced_run_invalid");
  const fencedUpdated = timestamp(fenced.updated_at, "fenced_run_invalid");
  if (String(fenced.id) !== args.fencedDeploymentRunId
    || !repositoryExact(fenced.repository) || !repositoryExact(fenced.head_repository)
    || fenced.head_sha !== args.candidateSha || fenced.head_branch !== "main"
    || !workflowPathExact(fenced.path, FENCED_WORKFLOW_PATH)
    || fenced.name !== FENCED_WORKFLOW_NAME
    || fenced.display_title !== `${FENCED_RUN_NAME_PREFIX}${args.candidateSha}`
    || fenced.event !== "workflow_dispatch" || fenced.run_attempt !== 1
    || fenced.status !== "completed" || fenced.conclusion !== "success"
    || !Number.isSafeInteger(fenced.run_number)
    || fencedUpdated.milliseconds < fencedStarted.milliseconds
    || fencedUpdated.milliseconds > currentStarted.milliseconds) fail("fenced_run_invalid");
  const runs = Array.isArray(history.workflow_runs) ? history.workflow_runs : [];
  const selected = runs.filter((run) => record(run)
    && String(run.id) === args.fencedDeploymentRunId);
  if (selected.length !== 1 || runs.some((run) => !record(run)
    || !Number.isSafeInteger(run.run_number)
    || Number(run.run_number) > Number(fenced.run_number))) {
    fail("fenced_run_not_latest");
  }
  const listed = Array.isArray(artifacts.artifacts) ? artifacts.artifacts : [];
  const artifact = listed[0];
  const artifactWorkflowRun = record(artifact) ? artifact.workflow_run : null;
  const artifactName = `${FENCED_ARTIFACT_PREFIX}${args.candidateSha}`;
  if (artifacts.total_count !== 1 || listed.length !== 1 || !record(artifact)
    || artifact.name !== artifactName || artifact.expired !== false
    || !RUN_ID.test(String(artifact.id))
    || !ARTIFACT_DIGEST.test(String(artifact.digest))
    || !Number.isSafeInteger(artifact.size_in_bytes) || Number(artifact.size_in_bytes) < 1
    || !record(artifactWorkflowRun)
    || String(artifactWorkflowRun.id) !== args.fencedDeploymentRunId
    || artifactWorkflowRun.head_sha !== args.candidateSha) fail("fenced_artifact_invalid");
  let receiptSource: string;
  let receipt: unknown;
  try {
    receiptSource = dependencies.readText(receiptFilename, 256 * 1024);
    receipt = JSON.parse(receiptSource);
  } catch {
    return fail("fenced_receipt_invalid");
  }
  if (!record(receipt)) fail("fenced_receipt_invalid");
  validateDeploymentReceipt(
    receiptSource,
    receipt,
    args.candidateSha,
    fencedStarted.milliseconds,
    fencedUpdated.milliseconds,
  );
  const authority = {
    schemaVersion: VENUE_DIRECTORY_FENCED_AUTHORITY_SCHEMA,
    repository: REPOSITORY,
    candidateSha: args.candidateSha,
    consumerWorkflowPath: WORKFLOW_PATH,
    consumerWorkflowRunId: currentRunId,
    consumerWorkflowRunAttempt: 1,
    fencedDeploymentWorkflowPath: FENCED_WORKFLOW_PATH,
    fencedDeploymentRunId: args.fencedDeploymentRunId,
    fencedDeploymentRunAttempt: 1,
    fencedDeploymentRunNumber: fenced.run_number,
    fencedDeploymentCompletedAt: fencedUpdated.canonical,
    fencedDeploymentArtifactName: artifactName,
    fencedDeploymentArtifactId: String(artifact.id),
    fencedDeploymentArtifactDigest: artifact.digest,
    fencedDeploymentArtifactSizeBytes: artifact.size_in_bytes,
    fencedDeploymentReceiptSha256: sha256(receiptSource),
    latestDeploymentRunExact: true,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
  dependencies.writeExclusive(
    path.dirname(output), path.basename(output), canonicalVenueDirectoryJson(authority),
  );
  dependencies.writeOutput(`${canonicalVenueDirectoryJson({
    ok: true,
    candidateSha: args.candidateSha,
    fencedDeploymentRunId: args.fencedDeploymentRunId,
  })}`);
  return 0;
}

function databaseContractExact(value: unknown): boolean {
  return exactKeys(value, [
    "migrationVersion", "migrationPath", "migrationSha256", "migrationBytes",
    "validatedConstraints",
  ]) && value.migrationVersion === DATABASE_CONTRACT.migrationVersion
    && value.migrationPath === DATABASE_CONTRACT.migrationPath
    && value.migrationSha256 === DATABASE_CONTRACT.migrationSha256
    && value.migrationBytes === DATABASE_CONTRACT.migrationBytes
    && Array.isArray(value.validatedConstraints)
    && JSON.stringify(value.validatedConstraints)
      === JSON.stringify(DATABASE_CONTRACT.validatedConstraints);
}

function snapshotExact(value: unknown): value is JsonRecord {
  return exactKeys(value, ["rowCount", "sha256"])
    && Number.isSafeInteger(value.rowCount) && Number(value.rowCount) >= 0
    && SHA256.test(String(value.sha256));
}

function validatePlan(source: string, value: JsonRecord, candidateSha: string): void {
  const input = value.inputSnapshot;
  const collection = value.collection;
  const projected = value.projected;
  const transitions = value.transitions;
  const started = timestamp(value.startedAt, "plan_invalid");
  const completed = timestamp(value.completedAt, "plan_invalid");
  timestamp(value.checkedAt, "plan_invalid");
  const planWithoutHash = { ...value };
  delete planWithoutHash.planSha256;
  const computedPlanSha = sha256(canonicalVenueDirectoryJson(planWithoutHash).slice(0, -1));
  const collectionKeys = [
    "discoveryCellAttemptedCount", "discoveryCellSuccessfulCount",
    "discoveryCellFailureCount", "discoveryQueryAttemptedCount",
    "discoveryQuerySuccessfulCount", "discoveryQueryFailureCount",
    "existingPlaceIdAttemptedCount", "existingPlaceIdSuccessfulCount",
    "existingPlaceIdFailureCount", "existingPlaceIdSatisfiedByDiscoveryCount",
    "existingRowMissingPlaceIdCount", "quarantinedVenueCount",
  ];
  if (source !== canonicalVenueDirectoryJson(value) || !exactKeys(value, PLAN_KEYS)
    || value.schemaVersion !== VENUE_DIRECTORY_PLAN_SCHEMA
    || value.planSha256 !== computedPlanSha || value.candidateSha !== candidateSha
    || value.supabaseProjectRef !== PROJECT_REF || !databaseContractExact(value.databaseContract)
    || value.operation !== OPERATION || completed.milliseconds < started.milliseconds
    || !snapshotExact(input) || !exactKeys(collection, collectionKeys)
    || Object.values(collection).some((item) => !Number.isSafeInteger(item) || Number(item) < 0)
    || !exactKeys(projected,
      ["insertCount", "updateCount", "exclusionCount", "totalTransitionCount"])
    || Object.values(projected).some((item) => !Number.isSafeInteger(item) || Number(item) < 0)
    || !Array.isArray(transitions)
    || transitions.length !== projected.totalTransitionCount
    || projected.totalTransitionCount !== Number(projected.insertCount)
      + Number(projected.updateCount) + Number(projected.exclusionCount)) fail("plan_invalid");
  const counts = { insert: 0, update: 0, exclude: 0 };
  transitions.forEach((transition, index) => {
    if (!exactKeys(transition,
      ["ordinal", "operation", "identity", "expectedBefore", "desiredAfter"])
      || transition.ordinal !== index + 1
      || !["insert", "update", "exclude"].includes(String(transition.operation))
      || !exactKeys(transition.identity,
        ["venueId", "googlePlaceId", "normalizedNameAddressSha256"])
      || !SHA256.test(String(transition.identity.normalizedNameAddressSha256))
      || !exactKeys(transition.desiredAfter, DESIRED_ROW_KEYS)
      || transition.desiredAfter.last_checked_at !== value.checkedAt) fail("plan_invalid");
    const operation = transition.operation as keyof typeof counts;
    counts[operation] += 1;
    if (operation === "insert") {
      if (transition.expectedBefore !== null || transition.identity.venueId !== null) {
        fail("plan_invalid");
      }
    } else if (!exactKeys(transition.expectedBefore, MANAGED_ROW_KEYS)
      || typeof transition.identity.venueId !== "string"
      || transition.expectedBefore.id !== transition.identity.venueId) fail("plan_invalid");
  });
  if (counts.insert !== projected.insertCount || counts.update !== projected.updateCount
    || counts.exclude !== projected.exclusionCount) fail("plan_invalid");
}

function validateImportTerminal(
  source: string,
  value: JsonRecord,
  candidateSha: string,
  plan: JsonRecord,
): boolean {
  const started = timestamp(value.startedAt, "terminal_invalid");
  const completed = timestamp(value.completedAt, "terminal_invalid");
  const counts = [
    value.attemptedWriteCount, value.successfulWriteCount, value.insertedCount,
    value.updatedCount, value.excludedCount,
  ];
  const success = value.status === "succeeded" && value.outcome === "applied";
  if (source !== canonicalVenueDirectoryJson(value) || !exactKeys(value, IMPORT_TERMINAL_KEYS)
    || value.schemaVersion !== VENUE_DIRECTORY_IMPORT_TERMINAL_SCHEMA
    || value.candidateSha !== candidateSha || value.supabaseProjectRef !== PROJECT_REF
    || !databaseContractExact(value.databaseContract)
    || value.planSha256 !== plan.planSha256
    || completed.milliseconds < started.milliseconds
    || !snapshotExact(value.preflightSnapshot)
    || value.preflightSnapshot.rowCount !== (plan.inputSnapshot as JsonRecord).rowCount
    || value.preflightSnapshot.sha256 !== (plan.inputSnapshot as JsonRecord).sha256
    || counts.some((item) => !Number.isSafeInteger(item) || Number(item) < 0)
    || Number(value.successfulWriteCount) > Number(value.attemptedWriteCount)
    || value.samePlanRetryAllowed !== false
    || typeof value.partialWrite !== "boolean"
    || (success
      ? value.failure !== null || value.partialWrite !== false
        || !snapshotExact(value.finalSnapshot)
        || value.attemptedWriteCount !== value.successfulWriteCount
        || Number(value.insertedCount) + Number(value.updatedCount)
          + Number(value.excludedCount) !== Number(value.successfulWriteCount)
      : value.status !== "failed"
        || !["preflight_failed", "partial_write_unretryable", "postflight_failed"]
          .includes(String(value.outcome))
        || !exactKeys(value.failure, ["phase", "code", "message"]))) {
    fail("terminal_invalid");
  }
  return success;
}

function validateFencedAuthority(
  dependencies: Dependencies,
  filename: string,
  candidateSha: string,
  fencedRunId: string,
): string {
  const { source, value } = readJsonCanonical(dependencies, filename, 256 * 1024);
  const keys = [
    "schemaVersion", "repository", "candidateSha", "consumerWorkflowPath",
    "consumerWorkflowRunId", "consumerWorkflowRunAttempt",
    "fencedDeploymentWorkflowPath", "fencedDeploymentRunId",
    "fencedDeploymentRunAttempt", "fencedDeploymentRunNumber",
    "fencedDeploymentCompletedAt", "fencedDeploymentArtifactName",
    "fencedDeploymentArtifactId", "fencedDeploymentArtifactDigest",
    "fencedDeploymentArtifactSizeBytes", "fencedDeploymentReceiptSha256",
    "latestDeploymentRunExact", "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ];
  timestamp(value.fencedDeploymentCompletedAt, "fenced_authority_invalid");
  if (!exactKeys(value, keys)
    || value.schemaVersion !== VENUE_DIRECTORY_FENCED_AUTHORITY_SCHEMA
    || value.repository !== REPOSITORY || value.candidateSha !== candidateSha
    || value.consumerWorkflowPath !== WORKFLOW_PATH
    || value.consumerWorkflowRunId !== dependencies.env.GITHUB_RUN_ID
    || value.consumerWorkflowRunAttempt !== 1
    || value.fencedDeploymentWorkflowPath !== FENCED_WORKFLOW_PATH
    || value.fencedDeploymentRunId !== fencedRunId
    || value.fencedDeploymentRunAttempt !== 1
    || !Number.isSafeInteger(value.fencedDeploymentRunNumber)
    || value.fencedDeploymentArtifactName !== `${FENCED_ARTIFACT_PREFIX}${candidateSha}`
    || !RUN_ID.test(String(value.fencedDeploymentArtifactId))
    || !ARTIFACT_DIGEST.test(String(value.fencedDeploymentArtifactDigest))
    || !Number.isSafeInteger(value.fencedDeploymentArtifactSizeBytes)
    || Number(value.fencedDeploymentArtifactSizeBytes) < 1
    || !SHA256.test(String(value.fencedDeploymentReceiptSha256))
    || value.latestDeploymentRunExact !== true || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false) fail("fenced_authority_invalid");
  return sha256(source);
}

function commandEnvironment(
  dependencies: Dependencies,
  includeGoogle: boolean,
): Readonly<Record<string, string>> {
  const source = dependencies.env;
  const result: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ",
    "npm_config_cache"]) {
    const value = source[key];
    if (value) result[key] = value;
  }
  result.SUPABASE_URL = PROJECT_ORIGIN;
  result.SUPABASE_SERVICE_ROLE_KEY = source.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (includeGoogle) result.GOOGLE_PLACES_API_KEY = source.GOOGLE_PLACES_API_KEY ?? "";
  return Object.freeze(result);
}

const CONSTRAINT_OBSERVATION_SQL =
  "with violations as (select count(*) filter (where business_status is not null " +
  "and business_status not in ('OPERATIONAL','CLOSED_TEMPORARILY'," +
  "'CLOSED_PERMANENTLY','FUTURE_OPENING'))::integer as \"businessStatus\", " +
  "count(*) filter (where postcode is not null and postcode !~ '^[0-9]{4}$')::integer " +
  "as \"postcode\" from public.venues) select conname as name, contype::text as type, " +
  "convalidated as validated, pg_get_constraintdef(oid,false) as definition, " +
  "violations.\"businessStatus\", violations.\"postcode\" from pg_constraint cross join " +
  "violations where conrelid='public.venues'::regclass and conname in " +
  "('venues_australian_postcode_check','venues_business_status_check') order by conname";
const LEDGER_OBSERVATION_SQL =
  "select version,name,statements from supabase_migrations.schema_migrations order by version";

function migrationCommandEnvironment(
  dependencies: Dependencies,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
    const value = dependencies.env[key];
    if (value) result[key] = value;
  }
  result.SUPABASE_ACCESS_TOKEN = dependencies.env.SUPABASE_ACCESS_TOKEN ?? "";
  return Object.freeze(result);
}

function checkedCommand(
  dependencies: Dependencies,
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  code: string,
): Required<CommandResult> {
  const result = dependencies.runCommand({ command, args, cwd: dependencies.cwd, env });
  if (result.status !== 0 || result.signal !== null) fail(code);
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseCommandJson(source: string, code: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return fail(code);
  }
}

function observeDatabase(
  dependencies: Dependencies,
  phase: "preflight" | "prewrite" | "postflight",
  candidateSha: string,
  expectedMode?: "first_run" | "steady_state",
  planSha256?: string,
  migrationApplySha256?: string,
): { readonly source: string; readonly value: JsonRecord; readonly mode: "first_run" | "steady_state" } {
  const password = dependencies.env.SUPABASE_DB_PASSWORD ?? "";
  const token = dependencies.env.SUPABASE_ACCESS_TOKEN ?? "";
  if (!password.trim() || !token.trim() || /[\r\n\0]/.test(password)
    || /[\r\n\0]/.test(token) || password === token) fail("migration_environment_invalid");
  const commandEnv = migrationCommandEnvironment(dependencies);
  const cli = checkedCommand(
    dependencies, "supabase", ["--version"], commandEnv, "supabase_version_failed",
  );
  if (stripVTControlCharacters(cli.stdout).trim() !== "2.109.1") {
    fail("supabase_version_invalid");
  }
  checkedCommand(dependencies, "supabase", ["link", "--project-ref", PROJECT_REF,
    "--password", password, "--yes"], commandEnv, "supabase_link_failed");
  const verifier = phase === "postflight" ? STRICT_VERIFIER : PREFLIGHT_VERIFIER;
  checkedCommand(dependencies, "supabase", ["db", "query", "--linked", "--agent", "no",
    "--output", "json", "--file", verifier.path], commandEnv, "schema_verify_failed");
  const constraintsResult = checkedCommand(
    dependencies, "supabase", ["db", "query", "--linked", "--agent", "no",
      "--output", "json", CONSTRAINT_OBSERVATION_SQL], commandEnv,
    "constraint_observation_failed",
  );
  const ledgerResult = checkedCommand(
    dependencies, "supabase", ["db", "query", "--linked", "--agent", "no",
      "--output", "json", LEDGER_OBSERVATION_SQL], commandEnv,
    "ledger_observation_failed",
  );
  const dryRun = checkedCommand(
    dependencies, "supabase", ["db", "push", "--linked", "--password", password,
      "--dry-run", "--yes"], commandEnv, "migration_dry_run_failed",
  );
  const rawConstraints = parseCommandJson(constraintsResult.stdout, "constraint_json_invalid");
  const rawLedger = parseCommandJson(ledgerResult.stdout, "ledger_json_invalid");
  if (!Array.isArray(rawConstraints) || rawConstraints.length !== 2
    || !Array.isArray(rawLedger)) fail("database_observation_invalid");
  const constraints = rawConstraints.map((item) => {
    if (!record(item)) fail("database_observation_invalid");
    return {
      name: item.name,
      type: item.type,
      validated: item.validated,
      definition: item.definition,
    };
  });
  const first = rawConstraints[0] as JsonRecord;
  const second = rawConstraints[1] as JsonRecord;
  const violationCounts = {
    businessStatus: first.businessStatus,
    postcode: first.postcode,
  };
  if (first.businessStatus !== second.businessStatus || first.postcode !== second.postcode) {
    fail("database_observation_invalid");
  }
  const remoteMigrationVersions = rawLedger.map((row) => {
    if (!record(row) || typeof row.version !== "string") fail("database_observation_invalid");
    return row.version;
  });
  const targetRows = rawLedger.filter((row) => record(row)
    && row.version === DATABASE_CONTRACT.migrationVersion);
  if (targetRows.length > 1) fail("database_observation_invalid");
  const targetLedger = targetRows[0] ?? null;
  const stderr = stripVTControlCharacters(dryRun.stderr);
  const stdout = stripVTControlCharacters(dryRun.stdout);
  if (!stderr.includes("DRY RUN: migrations will *not* be pushed to the database.")
    || stderr.includes("Would create custom roles") || stderr.includes("Would seed these files")) {
    fail("migration_dry_run_invalid");
  }
  const pendingFilenames = [...stderr.matchAll(/^ • ([0-9]+_[a-z0-9_]+\.sql)$/gm)]
    .map((match) => match[1] ?? "");
  const localVersions = localMigrationVersions(dependencies);
  const firstRun = JSON.stringify(remoteMigrationVersions)
      === JSON.stringify(localVersions.slice(0, -FIRST_RUN_MIGRATION_INVENTORY.length))
    && constraintsExact(constraints, false) && targetLedger === null
    && JSON.stringify(pendingFilenames) === JSON.stringify(FIRST_RUN_MIGRATION_FILENAMES);
  const steadyState = JSON.stringify(remoteMigrationVersions) === JSON.stringify(localVersions)
    && constraintsExact(constraints, true) && targetLedgerExact(targetLedger)
    && pendingFilenames.length === 0 && stdout.includes("Remote database is up to date.");
  const observedMode = firstRun ? "first_run" : steadyState ? "steady_state"
    : fail("database_state_invalid");
  if (phase !== "postflight" && expectedMode !== undefined && observedMode !== expectedMode) {
    fail("database_state_raced");
  }
  if (phase === "postflight" && observedMode !== "steady_state") {
    fail("database_postflight_invalid");
  }
  const mode = phase === "postflight" && expectedMode !== undefined
    ? expectedMode : observedMode;
  const dryRunEvidence = {
    cliVersion: "2.109.1",
    command: [
      "supabase", "db", "push", "--linked", "--password", "<redacted>",
      "--dry-run", "--yes",
    ],
    exitCode: 0,
    pendingFilenames,
    stdoutSha256: sha256(dryRun.stdout),
    stderrSha256: sha256(dryRun.stderr),
  };
  const checkedAt = dependencies.now().toISOString();
  let value: JsonRecord;
  if (phase === "preflight") {
    value = {
      schemaVersion: VENUE_DIRECTORY_CONSTRAINT_PREFLIGHT_SCHEMA,
      candidateSha,
      supabaseProjectRef: PROJECT_REF,
      databaseContract: DATABASE_CONTRACT,
      migrationMode: mode,
      localMigrationVersions: localVersions,
      remoteMigrationVersions,
      constraints,
      violationCounts,
      targetLedger,
      dryRun: dryRunEvidence,
      preflightVerifier: { ...PREFLIGHT_VERIFIER, passed: true },
      checkedAt,
      checks: Object.fromEntries(CONSTRAINT_PREFLIGHT_CHECK_KEYS.map((key) => [key, true])),
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    };
  } else if (phase === "prewrite") {
    value = {
      schemaVersion: VENUE_DIRECTORY_MIGRATION_PREWRITE_SCHEMA,
      candidateSha,
      supabaseProjectRef: PROJECT_REF,
      databaseContract: DATABASE_CONTRACT,
      migrationMode: mode,
      planSha256,
      localMigrationVersions: localVersions,
      remoteMigrationVersions,
      constraints,
      violationCounts,
      targetLedger,
      dryRun: dryRunEvidence,
      checkedAt,
      checks: Object.fromEntries(MIGRATION_PREWRITE_CHECK_KEYS.map((key) => [key, true])),
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    };
  } else {
    value = {
      schemaVersion: VENUE_DIRECTORY_CONSTRAINT_POSTFLIGHT_SCHEMA,
      candidateSha,
      supabaseProjectRef: PROJECT_REF,
      databaseContract: DATABASE_CONTRACT,
      migrationMode: mode,
      planSha256,
      migrationApplySha256,
      localMigrationVersions: localVersions,
      remoteMigrationVersions,
      constraints,
      violationCounts,
      targetLedger,
      dryRun: dryRunEvidence,
      strictVerifier: { ...STRICT_VERIFIER, passed: true },
      checkedAt,
      checks: Object.fromEntries(CONSTRAINT_POSTFLIGHT_CHECK_KEYS.map((key) => [key, true])),
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    };
  }
  const source = canonicalVenueDirectoryJson(value);
  databaseObservationExact(
    dependencies, value, phase, candidateSha, planSha256, migrationApplySha256,
  );
  return { source, value, mode };
}

function localMigrationVersions(dependencies: Dependencies): string[] {
  const directory = path.resolve(dependencies.cwd, "supabase/migrations");
  const versions = fs.readdirSync(directory)
    .filter((name) => /^[0-9]+_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => name.slice(0, name.indexOf("_")));
  if (versions.length <= FIRST_RUN_MIGRATION_INVENTORY.length
    || JSON.stringify(versions.slice(-FIRST_RUN_MIGRATION_INVENTORY.length))
      !== JSON.stringify(FIRST_RUN_MIGRATION_VERSIONS)
    || new Set(versions).size !== versions.length) fail("migration_inventory_invalid");
  return versions;
}

function allTrueChecks(value: unknown, keys: readonly string[], code: string): void {
  if (!exactKeys(value, keys) || Object.values(value).some((item) => item !== true)) fail(code);
}

function migrationMode(value: unknown): "first_run" | "steady_state" {
  if (value !== "first_run" && value !== "steady_state") fail("database_evidence_invalid");
  return value;
}

function targetLedgerExact(value: unknown): boolean {
  return exactKeys(value, ["version", "name", "statements"])
    && value.version === DATABASE_CONTRACT.migrationVersion
    && value.name === "validate_external_venue_directory_constraints"
    && Array.isArray(value.statements)
    && JSON.stringify(value.statements) === JSON.stringify([
      "alter table public.venues\n  validate constraint venues_business_status_check",
      "alter table public.venues\n  validate constraint venues_australian_postcode_check",
    ]);
}

function constraintsExact(value: unknown, validated: boolean): boolean {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const expected = [
    "venues_australian_postcode_check",
    "venues_business_status_check",
  ];
  return value.every((item, index) => exactKeys(item,
    ["name", "type", "validated", "definition"])
    && item.name === expected[index] && item.type === "c"
    && item.validated === validated && typeof item.definition === "string")
    && String((value[0] as JsonRecord).definition).includes("^[0-9]{4}$")
    && ["OPERATIONAL", "CLOSED_TEMPORARILY", "CLOSED_PERMANENTLY", "FUTURE_OPENING"]
      .every((status) => String((value[1] as JsonRecord).definition).includes(status));
}

function dryRunExact(value: unknown, expectedPending: readonly string[]): boolean {
  return exactKeys(value, [
    "cliVersion", "command", "exitCode", "pendingFilenames", "stdoutSha256",
    "stderrSha256",
  ])
    && value.cliVersion === "2.109.1" && value.exitCode === 0
    && Array.isArray(value.command)
    && JSON.stringify(value.command) === JSON.stringify([
      "supabase", "db", "push", "--linked", "--password", "<redacted>",
      "--dry-run", "--yes",
    ])
    && Array.isArray(value.pendingFilenames)
    && JSON.stringify(value.pendingFilenames) === JSON.stringify(expectedPending)
    && SHA256.test(String(value.stdoutSha256)) && SHA256.test(String(value.stderrSha256));
}

function databaseObservationExact(
  dependencies: Dependencies,
  value: JsonRecord,
  phase: "preflight" | "prewrite" | "postflight",
  candidateSha: string,
  planSha256?: string,
  migrationApplySha256?: string,
): "first_run" | "steady_state" {
  const keys = phase === "preflight" ? CONSTRAINT_PREFLIGHT_KEYS
    : phase === "prewrite" ? MIGRATION_PREWRITE_KEYS : CONSTRAINT_POSTFLIGHT_KEYS;
  const schema = phase === "preflight" ? VENUE_DIRECTORY_CONSTRAINT_PREFLIGHT_SCHEMA
    : phase === "prewrite" ? VENUE_DIRECTORY_MIGRATION_PREWRITE_SCHEMA
      : VENUE_DIRECTORY_CONSTRAINT_POSTFLIGHT_SCHEMA;
  if (!exactKeys(value, keys) || value.schemaVersion !== schema
    || value.candidateSha !== candidateSha || value.supabaseProjectRef !== PROJECT_REF
    || !databaseContractExact(value.databaseContract)
    || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false) fail("database_evidence_invalid");
  timestamp(value.checkedAt, "database_evidence_invalid");
  const mode = migrationMode(value.migrationMode);
  const local = localMigrationVersions(dependencies);
  const before = mode === "first_run"
    ? local.slice(0, -FIRST_RUN_MIGRATION_INVENTORY.length) : local;
  if (!Array.isArray(value.localMigrationVersions)
    || JSON.stringify(value.localMigrationVersions) !== JSON.stringify(local)
    || !Array.isArray(value.remoteMigrationVersions)
    || JSON.stringify(value.remoteMigrationVersions) !== JSON.stringify(
      phase === "postflight" ? local : before,
    )
    || !constraintsExact(value.constraints, phase === "postflight" || mode === "steady_state")
    || !exactKeys(value.violationCounts, ["businessStatus", "postcode"])
    || value.violationCounts.businessStatus !== 0 || value.violationCounts.postcode !== 0
    || (phase === "postflight" || mode === "steady_state"
      ? !targetLedgerExact(value.targetLedger) : value.targetLedger !== null)
    || !dryRunExact(value.dryRun,
      phase === "postflight" || mode === "steady_state"
        ? [] : FIRST_RUN_MIGRATION_FILENAMES)) {
    fail("database_evidence_invalid");
  }
  if (phase === "preflight") {
    if (!exactKeys(value.preflightVerifier, ["path", "sha256", "bytes", "passed"])
      || value.preflightVerifier.path !== PREFLIGHT_VERIFIER.path
      || value.preflightVerifier.sha256 !== PREFLIGHT_VERIFIER.sha256
      || value.preflightVerifier.bytes !== PREFLIGHT_VERIFIER.bytes
      || value.preflightVerifier.passed !== true) fail("database_evidence_invalid");
    allTrueChecks(value.checks, CONSTRAINT_PREFLIGHT_CHECK_KEYS, "database_evidence_invalid");
  } else if (phase === "prewrite") {
    if (value.planSha256 !== planSha256) fail("database_evidence_invalid");
    allTrueChecks(value.checks, MIGRATION_PREWRITE_CHECK_KEYS, "database_evidence_invalid");
  } else {
    if (value.planSha256 !== planSha256 || value.migrationApplySha256 !== migrationApplySha256
      || !exactKeys(value.strictVerifier, ["path", "sha256", "bytes", "passed"])
      || value.strictVerifier.path !== STRICT_VERIFIER.path
      || value.strictVerifier.sha256 !== STRICT_VERIFIER.sha256
      || value.strictVerifier.bytes !== STRICT_VERIFIER.bytes
      || value.strictVerifier.passed !== true) fail("database_evidence_invalid");
    allTrueChecks(value.checks, CONSTRAINT_POSTFLIGHT_CHECK_KEYS,
      "database_evidence_invalid");
  }
  return mode;
}

function validateMigrationApply(
  value: JsonRecord,
  candidateSha: string,
  planSha256: string,
  expectedMode: "first_run" | "steady_state",
): number {
  if (!exactKeys(value, MIGRATION_APPLY_KEYS)
    || value.schemaVersion !== VENUE_DIRECTORY_MIGRATION_APPLY_SCHEMA
    || value.candidateSha !== candidateSha || value.supabaseProjectRef !== PROJECT_REF
    || !databaseContractExact(value.databaseContract)
    || value.migrationMode !== expectedMode || value.planSha256 !== planSha256
    || value.samePlanRetryAllowed !== false || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false
    || !Array.isArray(value.command)
    || JSON.stringify(value.command) !== JSON.stringify([
      "supabase", "db", "push", "--linked", "--password", "<redacted>", "--yes",
    ])) fail("migration_apply_invalid");
  const started = timestamp(value.startedAt, "migration_apply_invalid");
  const completed = timestamp(value.completedAt, "migration_apply_invalid");
  if (completed.milliseconds < started.milliseconds) fail("migration_apply_invalid");
  if (expectedMode === "first_run") {
    if (value.writeAttempts !== 1 || value.exitCode !== 0
      || value.acknowledgement !== "received"
      || !SHA256.test(String(value.cliStdoutSha256))
      || !SHA256.test(String(value.cliStderrSha256))) fail("migration_apply_invalid");
  } else if (value.writeAttempts !== 0 || value.acknowledgement !== "not_attempted"
    || value.exitCode !== null || value.cliStdoutSha256 !== null
    || value.cliStderrSha256 !== null) fail("migration_apply_invalid");
  return Number(value.writeAttempts);
}

function validateIntent(
  value: JsonRecord,
  candidateSha: string,
  fencedRunId: string,
  planSha256: string,
): void {
  const keys = [
    "schemaVersion", "policySha256", "candidateSha", "supabaseProjectRef",
    "operation", "planSha256", "fencedDeploymentRunId", "fencedAuthoritySha256",
    "externalMutationFreezeAttested", "maximumApplyInvocations",
    "automaticRetriesAllowed", "samePlanRetryAllowed", "secretMaterialIncluded",
    "secretDerivedCommitmentsIncluded",
  ];
  if (!exactKeys(value, keys) || value.schemaVersion !== VENUE_DIRECTORY_INTENT_SCHEMA
    || value.policySha256 !== VENUE_DIRECTORY_POLICY_SHA256
    || value.candidateSha !== candidateSha || value.supabaseProjectRef !== PROJECT_REF
    || value.operation !== OPERATION || value.planSha256 !== planSha256
    || value.fencedDeploymentRunId !== fencedRunId
    || !SHA256.test(String(value.fencedAuthoritySha256))
    || value.externalMutationFreezeAttested !== true
    || value.maximumApplyInvocations !== 1 || value.automaticRetriesAllowed !== false
    || value.samePlanRetryAllowed !== false || value.secretMaterialIncluded !== false
    || value.secretDerivedCommitmentsIncluded !== false) fail("intent_invalid");
}

async function planRefreshValidate(
  args: Arguments,
  dependencies: Dependencies,
): Promise<number> {
  const authorityFile = args.fencedAuthorityFile ?? fail("arguments_invalid");
  const evidenceDirectory = args.evidenceDirectory ?? fail("arguments_invalid");
  const env = dependencies.env;
  const confirmation =
    `APPLY_REFRESH_VALIDATE_PERMANENT_STAGING_VENUE_DIRECTORY_${PROJECT_REF}_FOR_` +
    `${args.candidateSha}_AFTER_FENCED_RUN_${args.fencedDeploymentRunId}`;
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== REPOSITORY
    || env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_SHA !== args.candidateSha
    || env.GITHUB_RUN_ATTEMPT !== "1" || !RUN_ID.test(env.GITHUB_RUN_ID ?? "")
    || env.GITHUB_RUN_ID === args.fencedDeploymentRunId
    || env.PINTPATH_VENUE_DIRECTORY_CONFIRMATION !== confirmation
    || env.PINTPATH_EXTERNAL_MUTATION_FREEZE_ATTESTATION !== FREEZE_ATTESTATION
    || env.SUPABASE_URL !== PROJECT_ORIGIN
    || !(env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim()
    || !(env.GOOGLE_PLACES_API_KEY ?? "").trim()
    || !(env.SUPABASE_ACCESS_TOKEN ?? "").trim()
    || !(env.SUPABASE_DB_PASSWORD ?? "").trim()
    || [env.SUPABASE_SERVICE_ROLE_KEY, env.GOOGLE_PLACES_API_KEY,
      env.SUPABASE_ACCESS_TOKEN, env.SUPABASE_DB_PASSWORD]
      .some((value) => value === undefined || /[\r\n\0]/.test(value))
    || new Set([env.SUPABASE_SERVICE_ROLE_KEY, env.GOOGLE_PLACES_API_KEY,
      env.SUPABASE_ACCESS_TOKEN, env.SUPABASE_DB_PASSWORD]).size !== 4
    || ["OFFSITE_BACKUP_SUPABASE_URL", "PRODUCTION_SUPABASE_URL",
      "RESTORE_SUPABASE_URL"]
      .some((key) => Boolean(env[key]))) fail("apply_environment_invalid");
  validateRepositoryInputs(dependencies);
  const authoritySha256 = validateFencedAuthority(
    dependencies, authorityFile, args.candidateSha, args.fencedDeploymentRunId,
  );
  const preflight = observeDatabase(
    dependencies, "preflight", args.candidateSha,
  );
  dependencies.writeExclusive(
    evidenceDirectory, "constraint-preflight.json", preflight.source,
  );
  const planFilename = path.join(evidenceDirectory, "venue-directory-plan.json");
  for (const filename of [planFilename,
    path.join(evidenceDirectory, "venue-directory-intent.json")]) {
    if (fs.existsSync(filename)) fail("evidence_output_exists");
  }
  const startedAt = dependencies.now().toISOString();
  const planCommand = dependencies.runCommand({
    command: "npm",
    args: [
      "exec", "tsx", "--", IMPORTER_PATH, "--", "--mode=plan",
      `--plan-output=${planFilename}`, `--candidate-sha=${args.candidateSha}`,
      `--expected-project-ref=${PROJECT_REF}`,
    ],
    cwd: dependencies.cwd,
    env: commandEnvironment(dependencies, true),
  });
  if (planCommand.status !== 0 || planCommand.signal !== null) {
    return 1;
  }
  let planSource: string;
  let plan: JsonRecord;
  try {
    const parsed = readJsonCanonical(dependencies, planFilename);
    planSource = parsed.source;
    plan = parsed.value;
    validatePlan(planSource, plan, args.candidateSha);
  } catch {
    return 1;
  }
  const intent = {
    schemaVersion: VENUE_DIRECTORY_INTENT_SCHEMA,
    policySha256: VENUE_DIRECTORY_POLICY_SHA256,
    candidateSha: args.candidateSha,
    supabaseProjectRef: PROJECT_REF,
    operation: OPERATION,
    planSha256: plan.planSha256,
    fencedDeploymentRunId: args.fencedDeploymentRunId,
    fencedAuthoritySha256: authoritySha256,
    externalMutationFreezeAttested: true,
    maximumApplyInvocations: 1,
    automaticRetriesAllowed: false,
    samePlanRetryAllowed: false,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
  dependencies.writeExclusive(
    evidenceDirectory,
    "venue-directory-intent.json",
    canonicalVenueDirectoryJson(intent),
  );
  dependencies.writeOutput(canonicalVenueDirectoryJson({
    ok: true,
    candidateSha: args.candidateSha,
    planSha256: plan.planSha256,
    startedAt,
  }));
  return 0;
}

async function applyRefreshValidate(
  args: Arguments,
  dependencies: Dependencies,
): Promise<number> {
  const authorityFile = args.fencedAuthorityFile ?? fail("arguments_invalid");
  const evidenceDirectory = args.evidenceDirectory ?? fail("arguments_invalid");
  const env = dependencies.env;
  const confirmation =
    `APPLY_REFRESH_VALIDATE_PERMANENT_STAGING_VENUE_DIRECTORY_${PROJECT_REF}_FOR_` +
    `${args.candidateSha}_AFTER_FENCED_RUN_${args.fencedDeploymentRunId}`;
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== REPOSITORY
    || env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_SHA !== args.candidateSha
    || env.GITHUB_RUN_ATTEMPT !== "1" || !RUN_ID.test(env.GITHUB_RUN_ID ?? "")
    || env.GITHUB_RUN_ID === args.fencedDeploymentRunId
    || env.PINTPATH_VENUE_DIRECTORY_CONFIRMATION !== confirmation
    || env.PINTPATH_EXTERNAL_MUTATION_FREEZE_ATTESTATION !== FREEZE_ATTESTATION
    || env.SUPABASE_URL !== PROJECT_ORIGIN
    || !(env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim()
    || !(env.SUPABASE_ACCESS_TOKEN ?? "").trim()
    || !(env.SUPABASE_DB_PASSWORD ?? "").trim()
    || [env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_ACCESS_TOKEN,
      env.SUPABASE_DB_PASSWORD].some((value) => /[\r\n\0]/.test(value ?? ""))
    || new Set([env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_ACCESS_TOKEN,
      env.SUPABASE_DB_PASSWORD]).size !== 3
    || ["GOOGLE_PLACES_API_KEY",
      "OFFSITE_BACKUP_SUPABASE_URL", "PRODUCTION_SUPABASE_URL", "RESTORE_SUPABASE_URL"]
      .some((key) => Boolean(env[key]))) fail("apply_environment_invalid");
  validateRepositoryInputs(dependencies);
  validateFencedAuthority(
    dependencies, authorityFile, args.candidateSha, args.fencedDeploymentRunId,
  );
  const planFilename = path.join(evidenceDirectory, "venue-directory-plan.json");
  const intentFilename = path.join(evidenceDirectory, "venue-directory-intent.json");
  const importTerminalFilename = path.join(evidenceDirectory, "venue-import-terminal.json");
  if (fs.existsSync(importTerminalFilename)) fail("evidence_output_exists");
  const planParsed = readJsonCanonical(dependencies, planFilename);
  validatePlan(planParsed.source, planParsed.value, args.candidateSha);
  const intent = readJsonCanonical(dependencies, intentFilename, 256 * 1024).value;
  validateIntent(intent, args.candidateSha, args.fencedDeploymentRunId,
    String(planParsed.value.planSha256));
  const preflight = readJsonCanonical(
    dependencies, path.join(evidenceDirectory, "constraint-preflight.json"),
  ).value;
  const preflightMode = databaseObservationExact(
    dependencies, preflight, "preflight", args.candidateSha,
  );
  const planSha256 = String(planParsed.value.planSha256);
  const prewrite = observeDatabase(
    dependencies, "prewrite", args.candidateSha, preflightMode, planSha256,
  );
  dependencies.writeExclusive(
    evidenceDirectory, "migration-prewrite.json", prewrite.source,
  );
  const migrationStartedAt = dependencies.now().toISOString();
  let migrationApply: JsonRecord;
  if (preflightMode === "first_run") {
    const password = env.SUPABASE_DB_PASSWORD ?? fail("migration_environment_invalid");
    const result = dependencies.runCommand({
      command: "supabase",
      args: ["db", "push", "--linked", "--password", password, "--yes"],
      cwd: dependencies.cwd,
      env: migrationCommandEnvironment(dependencies),
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const acknowledged = result.status === 0 && result.signal === null
      && stripVTControlCharacters(stdout).includes("Finished supabase db push.")
      && !stripVTControlCharacters(stderr).includes("Schema migrations are up to date.");
    migrationApply = {
      schemaVersion: VENUE_DIRECTORY_MIGRATION_APPLY_SCHEMA,
      candidateSha: args.candidateSha,
      supabaseProjectRef: PROJECT_REF,
      databaseContract: DATABASE_CONTRACT,
      migrationMode: preflightMode,
      planSha256,
      startedAt: migrationStartedAt,
      completedAt: dependencies.now().toISOString(),
      writeAttempts: 1,
      acknowledgement: acknowledged ? "received" : "missing_or_failed",
      exitCode: result.status,
      command: ["supabase", "db", "push", "--linked", "--password", "<redacted>", "--yes"],
      cliStdoutSha256: sha256(stdout),
      cliStderrSha256: sha256(stderr),
      samePlanRetryAllowed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    };
    const migrationApplySource = canonicalVenueDirectoryJson(migrationApply);
    dependencies.writeExclusive(
      evidenceDirectory, "migration-apply.json", migrationApplySource,
    );
    if (!acknowledged) return 1;
  } else {
    migrationApply = {
      schemaVersion: VENUE_DIRECTORY_MIGRATION_APPLY_SCHEMA,
      candidateSha: args.candidateSha,
      supabaseProjectRef: PROJECT_REF,
      databaseContract: DATABASE_CONTRACT,
      migrationMode: preflightMode,
      planSha256,
      startedAt: migrationStartedAt,
      completedAt: dependencies.now().toISOString(),
      writeAttempts: 0,
      acknowledgement: "not_attempted",
      exitCode: null,
      command: ["supabase", "db", "push", "--linked", "--password", "<redacted>", "--yes"],
      cliStdoutSha256: null,
      cliStderrSha256: null,
      samePlanRetryAllowed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    };
    dependencies.writeExclusive(
      evidenceDirectory, "migration-apply.json",
      canonicalVenueDirectoryJson(migrationApply),
    );
  }
  validateMigrationApply(migrationApply, args.candidateSha, planSha256, preflightMode);
  const migrationApplySource = canonicalVenueDirectoryJson(migrationApply);
  const postflight = observeDatabase(
    dependencies, "postflight", args.candidateSha, preflightMode, planSha256,
    sha256(migrationApplySource),
  );
  dependencies.writeExclusive(
    evidenceDirectory, "constraint-postflight.json", postflight.source,
  );
  const applyCommand = dependencies.runCommand({
    command: "npm",
    args: [
      "exec", "tsx", "--", IMPORTER_PATH, "--", "--mode=apply",
      `--plan-input=${planFilename}`, `--receipt-output=${importTerminalFilename}`,
      `--candidate-sha=${args.candidateSha}`,
      `--expected-project-ref=${PROJECT_REF}`,
    ],
    cwd: dependencies.cwd,
    env: commandEnvironment(dependencies, false),
  });
  let terminalSource: string;
  let terminal: JsonRecord;
  try {
    const parsed = readJsonCanonical(dependencies, importTerminalFilename);
    terminalSource = parsed.source;
    terminal = parsed.value;
  } catch {
    return 1;
  }
  const succeeded = validateImportTerminal(
    terminalSource, terminal, args.candidateSha, planParsed.value,
  );
  dependencies.writeOutput(canonicalVenueDirectoryJson({
    ok: succeeded && applyCommand.status === 0 && applyCommand.signal === null,
    candidateSha: args.candidateSha,
    planSha256: planParsed.value.planSha256,
    attemptedWriteCount: terminal.attemptedWriteCount,
    samePlanRetryAllowed: false,
  }));
  return succeeded && applyCommand.status === 0 && applyCommand.signal === null ? 0 : 1;
}

async function finalizeDatabaseProof(
  args: Arguments,
  dependencies: Dependencies,
): Promise<number> {
  const evidenceDirectory = args.evidenceDirectory ?? fail("arguments_invalid");
  const finalFilename = path.join(evidenceDirectory, "venue-directory-terminal.json");
  if (fs.existsSync(finalFilename)) fail("evidence_output_exists");
  const completedAt = dependencies.now().toISOString();
  let failureCode: string | null = null;
  let plan: JsonRecord | null = null;
  let migrationModeValue: "first_run" | "steady_state" | null = null;
  let writeAttempts = 0;
  const sources: Record<string, string | null> = {
    importTerminal: null,
    constraintPreflight: null,
    migrationPrewrite: null,
    migrationApply: null,
    constraintPostflight: null,
  };
  try {
    validateRepositoryInputs(dependencies);
    const planParsed = readJsonCanonical(
      dependencies, path.join(evidenceDirectory, "venue-directory-plan.json"),
    );
    plan = planParsed.value;
    validatePlan(planParsed.source, plan, args.candidateSha);
    const importParsed = readJsonCanonical(
      dependencies, path.join(evidenceDirectory, "venue-import-terminal.json"),
    );
    sources.importTerminal = importParsed.source;
    if (!validateImportTerminal(importParsed.source, importParsed.value,
      args.candidateSha, plan)) fail("import_not_successful");
    const preflightParsed = readJsonCanonical(
      dependencies, path.join(evidenceDirectory, "constraint-preflight.json"),
    );
    sources.constraintPreflight = preflightParsed.source;
    migrationModeValue = databaseObservationExact(
      dependencies, preflightParsed.value, "preflight", args.candidateSha,
    );
    const prewriteParsed = readJsonCanonical(
      dependencies, path.join(evidenceDirectory, "migration-prewrite.json"),
    );
    sources.migrationPrewrite = prewriteParsed.source;
    if (databaseObservationExact(
      dependencies, prewriteParsed.value, "prewrite", args.candidateSha,
      String(plan.planSha256),
    ) !== migrationModeValue) fail("database_state_raced");
    const migrationApplyParsed = readJsonCanonical(
      dependencies, path.join(evidenceDirectory, "migration-apply.json"),
    );
    sources.migrationApply = migrationApplyParsed.source;
    writeAttempts = validateMigrationApply(
      migrationApplyParsed.value, args.candidateSha, String(plan.planSha256),
      migrationModeValue,
    );
    const postflightParsed = readJsonCanonical(
      dependencies, path.join(evidenceDirectory, "constraint-postflight.json"),
    );
    sources.constraintPostflight = postflightParsed.source;
    if (databaseObservationExact(
      dependencies, postflightParsed.value, "postflight", args.candidateSha,
      String(plan.planSha256), sha256(migrationApplyParsed.source),
    ) !== migrationModeValue) fail("database_state_raced");
    const chronology = [
      preflightParsed.value.checkedAt,
      plan.startedAt,
      plan.completedAt,
      prewriteParsed.value.checkedAt,
      migrationApplyParsed.value.startedAt,
      migrationApplyParsed.value.completedAt,
      postflightParsed.value.checkedAt,
      importParsed.value.startedAt,
      importParsed.value.completedAt,
      completedAt,
    ].map((value) => timestamp(value, "chronology_invalid").milliseconds);
    if (chronology.some((value, index) => index > 0 && value < chronology[index - 1]!)) {
      fail("chronology_invalid");
    }
  } catch (error) {
    failureCode = error instanceof Error ? error.message : "database_proof_invalid";
  }
  const checks = Object.fromEntries(BOUNDARY_CHECK_KEYS.map((key) => [key, failureCode === null]));
  const final = {
    schemaVersion: VENUE_DIRECTORY_TERMINAL_SCHEMA,
    status: failureCode === null ? "succeeded" : "failed",
    outcome: failureCode === null ? "applied_and_validated" : "proof_failed_unretryable",
    candidateSha: args.candidateSha,
    supabaseProjectRef: PROJECT_REF,
    databaseContract: DATABASE_CONTRACT,
    migrationMode: migrationModeValue,
    planSha256: plan?.planSha256 ?? null,
    importTerminalSha256: sources.importTerminal ? sha256(sources.importTerminal) : null,
    constraintPreflightSha256: sources.constraintPreflight
      ? sha256(sources.constraintPreflight) : null,
    migrationPrewriteSha256: sources.migrationPrewrite
      ? sha256(sources.migrationPrewrite) : null,
    migrationApplySha256: sources.migrationApply ? sha256(sources.migrationApply) : null,
    constraintPostflightSha256: sources.constraintPostflight
      ? sha256(sources.constraintPostflight) : null,
    startedAt: plan?.startedAt ?? completedAt,
    completedAt,
    migrationWriteAttempts: writeAttempts,
    samePlanRetryAllowed: false,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
    checks,
    failure: failureCode === null ? null : {
      phase: "proof",
      code: failureCode,
      message: "Protected venue-directory proof is incomplete or invalid; do not retry this plan.",
    },
  };
  dependencies.writeExclusive(
    evidenceDirectory, "venue-directory-terminal.json",
    canonicalVenueDirectoryJson(final),
  );
  return failureCode === null ? 0 : 1;
}

export async function runProtectedPermanentStagingVenueDirectory(
  overrides: Partial<Dependencies> = {},
): Promise<number> {
  const dependencies: Dependencies = {
    ...DEFAULT_DEPENDENCIES,
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    ...overrides,
  };
  const args = parseArguments(dependencies.argv);
  validateRepositoryInputs(dependencies);
  if (args.mode === "verify-fenced-authority") {
    return verifyFencedAuthority(args, dependencies);
  }
  if (args.mode === "plan-refresh-validate") {
    return planRefreshValidate(args, dependencies);
  }
  if (args.mode === "apply-refresh-validate") {
    return applyRefreshValidate(args, dependencies);
  }
  return finalizeDatabaseProof(args, dependencies);
}

export const protectedPermanentStagingVenueDirectoryInternals = Object.freeze({
  DATABASE_CONTRACT,
  PLAN_KEYS,
  IMPORT_TERMINAL_KEYS,
  BOUNDARY_TERMINAL_KEYS,
  canonicalVenueDirectoryJson,
  validatePlan,
  validateImportTerminal,
});

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runProtectedPermanentStagingVenueDirectory();
}
