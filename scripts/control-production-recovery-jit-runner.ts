import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPostgresBackupJson as canonical } from "../src/lib/postgres-logical-backup.js";
import { emergencyCleanupArmInternals } from "./verify-production-promotion-recovery-emergency-cleanup-arm.js";
import { productionRecoveryRailwayTeardownInternals as railway } from "./execute-protected-production-recovery-railway-teardown.js";
import { protectedDisposableSupabaseProjectTeardownInternals as supabase } from "./execute-protected-disposable-supabase-project-teardown.js";
import {
  ACTIVATION_WORKFLOW_PATH,
  EMERGENCY_CLEANUP_REPOSITORY as REPOSITORY,
  EMERGENCY_CLEANUP_STATE_REF,
  emergencyCleanupSha256 as hash,
  parseEmergencyCleanupState,
  type EmergencyCleanupState,
} from "./lib/production-promotion-recovery-emergency-cleanup-state.js";
import { fetchBoundedResponseText } from "./lib/bounded-http-response.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";
import {
  holdPrivateDirectoryIdentity,
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

type Json = Record<string, unknown>;
export type RecoveryRunnerRole = "production-capture" | "disposable-recover";
const JOB_NAMES = {
  "production-capture":
    "Capture production recovery authorities into immutable WORM",
  "disposable-recover": "Recover and prove exact disposable application",
} as const;
const BASE_LABELS = {
  "production-capture": "pintpath-production-backup",
  "disposable-recover": "pintpath-disposable-recovery",
} as const;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN = /^[1-9]\d{0,19}$/;
const API = `https://api.github.com/repos/${REPOSITORY}`;
export const RECOVERY_JIT_RECEIPT_PATH =
  "/etc/pintpath/production-recovery-jit-receipt.json";
const ACTIVATION_ENV = "production-promotion-recovery-activation";
const CLEANUP_ENV = "production-promotion-recovery-cleanup";
const ARM_PREFIX = "PINTPATH_RECOVERY_EMERGENCY_CLEANUP_ARM_AUTHORITY";
const RAILWAY_PREFIX = "PINTPATH_RECOVERY_RAILWAY_TEARDOWN_AUTHORITY";
const SUPABASE_PREFIX = "PINTPATH_RECOVERY_SUPABASE_TEARDOWN_AUTHORITY";

function fail(code: string): never {
  throw new Error(`recovery_jit_${code}`);
}
function object(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Json {
  if (!object(value)) fail("response_invalid");
  return value;
}
function role(value: unknown): RecoveryRunnerRole {
  if (value !== "production-capture" && value !== "disposable-recover")
    fail("role_invalid");
  return value;
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function privateRead(filename: string): string {
  return readTrustedRegularFile(filename, {
    minBytes: 1,
    maxBytes: 2 * 1024 * 1024,
    requireExactMode: 0o600,
    requireOwner: true,
  }).toString("utf8");
}
export function recoveryRunnerIdentity(
  runId: string,
  selectedRole: RecoveryRunnerRole,
) {
  if (!RUN.test(runId)) fail("run_invalid");
  const name = `pintpath-recovery-${runId}-1-${role(selectedRole)}`;
  return {
    name,
    labels: ["self-hosted", "linux", "x64", BASE_LABELS[selectedRole], name],
  };
}

export interface RecoveryJitInput {
  candidateSha: string;
  runId: string;
  role: RecoveryRunnerRole;
  runnerGroupId: number;
  authorityDirectory: string;
  journalDirectory: string;
}
export interface RecoveryJitDependencies {
  request(
    method: "GET" | "POST",
    endpoint: string,
    body?: Json,
  ): Promise<unknown>;
  readPrivate(filename: string): string;
  writePrivate(leaf: string, source: string): void;
  now(): Date;
}

function rows(source: unknown, key: string): Json[] {
  const value = record(source);
  const result = value[key];
  // One bounded page is enough for this dedicated four-job / two-runner flow.
  // An incomplete inventory is a rejection, never an invitation to register.
  if (
    !Array.isArray(result) ||
    value.total_count !== result.length ||
    result.length > 100
  )
    fail("inventory_incomplete");
  return result.map(record);
}
function variables(source: unknown): Map<string, string> {
  const items = rows(source, "variables");
  const result = new Map<string, string>();
  for (const item of items) {
    if (
      typeof item.name !== "string" ||
      typeof item.value !== "string" ||
      result.has(item.name)
    )
      fail("variables_invalid");
    result.set(item.name, item.value);
  }
  return result;
}
function requireInstalled(
  source: unknown,
  prefixes: string[],
  credentials: string[] = [],
) {
  const secrets = new Set(rows(source, "secrets").map((item) => item.name));
  for (const name of [
    ...prefixes.flatMap((prefix) => [
      `${prefix}_BASE64`,
      `${prefix}_PUBLIC_KEY_BASE64`,
    ]),
    ...credentials,
  ]) {
    if (!secrets.has(name)) fail("cleanup_secret_missing");
  }
}

/** Reuses the existing signature/inventory validators; no provider deletion path is invoked. */
export function verifyRecoveryJitAuthorities(input: {
  state: EmergencyCleanupState;
  authorityDirectory: string;
  activationVariables: Map<string, string>;
  cleanupVariables: Map<string, string>;
  readPrivate(filename: string): string;
  now: Date;
}) {
  const {
    state,
    activationVariables: active,
    cleanupVariables: cleanup,
    now,
  } = input;
  if (
    state.projectId === "48d8c6cd-1c66-4148-874b-20877f48e1a5" ||
    [
      "13dab015-df74-45c6-b26f-69323daea99a",
      "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
    ].includes(state.environmentId) ||
    [
      "bbfibbadwjxzrcdncavy",
      "hfbmhdxrwtihukmixxta",
      "jxpubqlmqnnqwadmjgyk",
    ].includes(state.supabaseProjectRef)
  )
    fail("protected_target");
  if (
    state.status !== "open" ||
    Date.parse(state.armExpiresAt) <= now.getTime() ||
    state.railwayDeleteAcknowledgement !== null ||
    state.supabaseDeleteAcknowledgement !== null
  )
    fail("arm_not_open");
  const load = (name: string, prefix: string) => {
    const source = input.readPrivate(
      path.join(input.authorityDirectory, `${name}.json`),
    );
    const publicKeyPem = input.readPrivate(
      path.join(input.authorityDirectory, `${name}-public.pem`),
    );
    const sourceSha256 = cleanup.get(`${prefix}_SHA256`) ?? "";
    const publicKeySha256 = cleanup.get(`${prefix}_PUBLIC_KEY_SHA256`) ?? "";
    if (
      !SHA256.test(sourceSha256) ||
      !SHA256.test(publicKeySha256) ||
      hash(source) !== sourceSha256 ||
      hash(publicKeyPem) !== publicKeySha256
    )
      fail("authority_pin_invalid");
    return { source, publicKeyPem, sourceSha256, publicKeySha256 };
  };
  const arm = load("arm", ARM_PREFIX);
  if (
    arm.sourceSha256 !== state.currentArmAuthoritySha256 ||
    arm.publicKeySha256 !== state.currentArmAuthorityPublicKeySha256 ||
    active.get(`${ARM_PREFIX}_SHA256`) !== arm.sourceSha256 ||
    active.get(`${ARM_PREFIX}_PUBLIC_KEY_SHA256`) !== arm.publicKeySha256
  )
    fail("arm_binding_invalid");
  const armPayload = emergencyCleanupArmInternals.verifyAuthority({
    source: arm.source,
    publicKeyPem: arm.publicKeyPem,
    now,
    args: {
      ...state,
      mode: "activation",
      authorityFile: "",
      authorityPublicKeyFile: "",
      authoritySha256: arm.sourceSha256,
      authorityPublicKeySha256: arm.publicKeySha256,
    },
  });
  if (
    armPayload.armLineageIdSha256 !== state.armLineageIdSha256 ||
    armPayload.renewalSequence !== state.armRenewalSequence
  )
    fail("arm_binding_invalid");
  const railwayAuthority = load("railway", RAILWAY_PREFIX);
  railway.verifyAuthority({
    ...railwayAuthority,
    now,
    args: {
      ...state,
      emergencyCleanupArmAuthoritySha256: arm.sourceSha256,
      emergencyCleanupStateFile: null,
      emergencyCleanupStateSha256: null,
      teardownAuthorityFile: "",
      teardownAuthoritySha256: railwayAuthority.sourceSha256,
      teardownAuthorityPublicKeyFile: "",
      teardownAuthorityPublicKeySha256: railwayAuthority.publicKeySha256,
      readTokenFile: "",
      deleteTokenFile: "",
      evidenceDir: "",
      output: "",
    },
  });
  const supabaseAuthority = load("supabase", SUPABASE_PREFIX);
  const supabasePayload = record(
    record(JSON.parse(supabaseAuthority.source)).payload,
  );
  const destinationOrigin = `https://${state.supabaseProjectRef}.supabase.co`;
  const organizationSlug = supabasePayload.organizationSlug;
  if (
    typeof organizationSlug !== "string" ||
    hash(organizationSlug) !== state.organizationSlugSha256 ||
    hash(destinationOrigin) !== state.destinationOriginSha256
  )
    fail("target_binding_invalid");
  supabase.verifySignedAuthority({
    ...supabaseAuthority,
    now,
    args: {
      ...state,
      projectRef: state.supabaseProjectRef,
      projectName: state.supabaseProjectName,
      destinationOrigin,
      organizationSlug,
      targetRailwayProjectId: state.projectId,
      targetRailwayEnvironmentId: state.environmentId,
      cleanupMode: "emergency",
      emergencyCleanupArmAuthoritySha256: arm.sourceSha256,
      emergencyCleanupStateFile: null,
      emergencyCleanupStateSha256: null,
      purgeReceiptFile: null,
      purgeReceiptSha256: null,
      teardownAuthorityFile: "",
      teardownAuthoritySha256: supabaseAuthority.sourceSha256,
      teardownAuthorityPublicKeyFile: "",
      teardownAuthorityPublicKeySha256: supabaseAuthority.publicKeySha256,
      readTokenFile: "",
      deleteTokenFile: "",
      evidenceDir: "",
      output: "",
    },
  });
  return {
    armAuthoritySha256: arm.sourceSha256,
    railwayAuthoritySha256: railwayAuthority.sourceSha256,
    supabaseAuthoritySha256: supabaseAuthority.sourceSha256,
  };
}

async function observe(
  input: RecoveryJitInput,
  dependencies: RecoveryJitDependencies,
) {
  if (
    !SHA.test(input.candidateSha) ||
    !RUN.test(input.runId) ||
    !positive(input.runnerGroupId)
  )
    fail("arguments_invalid");
  const identity = recoveryRunnerIdentity(input.runId, input.role);
  const get = (endpoint: string) => dependencies.request("GET", endpoint);
  const main = record(await get("/git/ref/heads/main"));
  if (record(main.object).sha !== input.candidateSha) fail("main_changed");
  const run = record(await get(`/actions/runs/${input.runId}`));
  if (
    String(run.id) !== input.runId ||
    run.run_attempt !== 1 ||
    run.event !== "workflow_dispatch" ||
    run.head_sha !== input.candidateSha ||
    run.head_branch !== "main" ||
    run.path !== ACTIVATION_WORKFLOW_PATH ||
    !["queued", "in_progress"].includes(String(run.status)) ||
    run.conclusion !== null ||
    record(run.repository).full_name !== REPOSITORY ||
    record(run.head_repository).full_name !== REPOSITORY
  )
    fail("run_invalid");
  const jobs = rows(
    await get(`/actions/runs/${input.runId}/attempts/1/jobs?per_page=100`),
    "jobs",
  );
  const matches = jobs.filter((job) => job.name === JOB_NAMES[input.role]);
  if (matches.length !== 1) fail("job_invalid");
  const job = matches[0]!;
  if (
    !positive(job.id) ||
    String(job.run_id) !== input.runId ||
    job.head_sha !== input.candidateSha ||
    job.head_branch !== "main" ||
    job.status !== "queued" ||
    job.conclusion !== null ||
    Number(job.runner_id ?? 0) !== 0 ||
    JSON.stringify(job.labels) !== JSON.stringify(identity.labels)
  )
    fail("job_not_held");
  if (input.role === "disposable-recover") {
    const capture = jobs.filter(
      (item) => item.name === JOB_NAMES["production-capture"],
    );
    if (
      capture.length !== 1 ||
      capture[0]!.status !== "completed" ||
      capture[0]!.conclusion !== "success" ||
      capture[0]!.runner_name !==
        recoveryRunnerIdentity(input.runId, "production-capture").name
    )
      fail("capture_not_complete");
  }
  const runners = rows(await get("/actions/runners?per_page=100"), "runners");
  if (
    runners.some(
      (runner) =>
        runner.name === identity.name ||
        (Array.isArray(runner.labels) &&
          runner.labels.some((label) => record(label).name === identity.name)),
    )
  )
    fail("runner_already_registered");
  const stateDocument = record(
    await get(
      `/contents/.pintpath/emergency-cleanup/state.json?ref=${encodeURIComponent(EMERGENCY_CLEANUP_STATE_REF)}`,
    ),
  );
  if (
    stateDocument.encoding !== "base64" ||
    typeof stateDocument.content !== "string"
  )
    fail("state_invalid");
  const state = parseEmergencyCleanupState(
    Buffer.from(stateDocument.content, "base64").toString("utf8"),
  );
  if (
    state.candidateSha !== input.candidateSha ||
    state.activationRunId !== input.runId
  )
    fail("state_invalid");
  const active = variables(
    await get(`/environments/${ACTIVATION_ENV}/variables?per_page=100`),
  );
  const cleanup = variables(
    await get(`/environments/${CLEANUP_ENV}/variables?per_page=100`),
  );
  requireInstalled(
    await get(`/environments/${ACTIVATION_ENV}/secrets?per_page=100`),
    [ARM_PREFIX],
  );
  requireInstalled(
    await get(`/environments/${CLEANUP_ENV}/secrets?per_page=100`),
    [ARM_PREFIX, RAILWAY_PREFIX, SUPABASE_PREFIX],
    [
      "PINTPATH_RECOVERY_RAILWAY_READ_TOKEN",
      "PINTPATH_RECOVERY_RAILWAY_DELETE_TOKEN",
      "PINTPATH_RECOVERY_SUPABASE_READ_TOKEN",
      "PINTPATH_RECOVERY_SUPABASE_DELETE_TOKEN",
    ],
  );
  const policyKey =
    input.role === "production-capture"
      ? "PINTPATH_PRODUCTION_BACKUP_EPHEMERAL_RUNNER_POLICY_SHA256"
      : "PINTPATH_DISPOSABLE_RECOVERY_EPHEMERAL_RUNNER_POLICY_SHA256";
  const runnerPolicySha256 = active.get(policyKey) ?? "";
  if (!SHA256.test(runnerPolicySha256)) fail("host_policy_missing");
  const authorities = verifyRecoveryJitAuthorities({
    state,
    authorityDirectory: input.authorityDirectory,
    activationVariables: active,
    cleanupVariables: cleanup,
    readPrivate: dependencies.readPrivate,
    now: dependencies.now(),
  });
  return {
    identity,
    jobId: job.id,
    stateSha256: state.stateSha256,
    runnerPolicySha256,
    ...authorities,
  };
}

/** Registers one offline JIT runner only. Starting it is a separate private-host action. */
export async function prepareRecoveryJitRunner(
  input: RecoveryJitInput,
  dependencies: RecoveryJitDependencies,
) {
  const preflight = await observe(input, dependencies);
  const intent = {
    schemaVersion: "pintpath-recovery-jit-intent/v1",
    candidateSha: input.candidateSha,
    runId: input.runId,
    runAttempt: 1,
    role: input.role,
    runnerGroupId: input.runnerGroupId,
    ...preflight,
    createdAt: dependencies.now().toISOString(),
    writeAttempts: 1,
    retryAllowed: false,
  };
  // Stable per-run/role journal leaf: a lost acknowledgment can never silently retry.
  const stem = preflight.identity.name;
  dependencies.writePrivate(`${stem}-intent.json`, canonical(intent));
  const immediate = await observe(input, dependencies);
  if (canonical(immediate) !== canonical(preflight)) fail("preflight_changed");
  let response: Json;
  try {
    response = record(
      await dependencies.request(
        "POST",
        "/actions/runners/generate-jitconfig",
        {
          name: preflight.identity.name,
          runner_group_id: input.runnerGroupId,
          labels: preflight.identity.labels,
          work_folder: "_work",
        },
      ),
    );
  } catch {
    dependencies.writePrivate(
      `${stem}-uncertain.json`,
      canonical({
        schemaVersion: "pintpath-recovery-jit-uncertain/v1",
        intentSha256: hash(canonical(intent)),
        writeAttempts: 1,
        retryAllowed: false,
      }),
    );
    fail("registration_uncertain_no_retry");
  }
  const runner = record(response.runner);
  const runnerLabels = Array.isArray(runner.labels)
    ? runner.labels.map((item: unknown) =>
        String(record(item).name).toLowerCase(),
      )
    : [];
  if (
    !positive(runner.id) ||
    runner.name !== preflight.identity.name ||
    runner.status !== "offline" ||
    runner.busy !== false ||
    preflight.identity.labels.some((label) => !runnerLabels.includes(label)) ||
    typeof response.encoded_jit_config !== "string" ||
    !/^[A-Za-z0-9+/=]+$/.test(response.encoded_jit_config)
  )
    fail("registration_response_invalid_no_retry");
  const receipt = {
    schemaVersion: "pintpath-recovery-jit-registration/v1",
    repository: REPOSITORY,
    workflowPath: ACTIVATION_WORKFLOW_PATH,
    candidateSha: input.candidateSha,
    runId: input.runId,
    runAttempt: 1,
    role: input.role,
    jobId: preflight.jobId,
    runnerId: runner.id,
    runnerName: runner.name,
    runnerGroupId: input.runnerGroupId,
    labels: preflight.identity.labels,
    runnerPolicySha256: preflight.runnerPolicySha256,
    stateSha256: preflight.stateSha256,
    armAuthoritySha256: preflight.armAuthoritySha256,
    railwayAuthoritySha256: preflight.railwayAuthoritySha256,
    supabaseAuthoritySha256: preflight.supabaseAuthoritySha256,
    createdAt: dependencies.now().toISOString(),
    intentSha256: hash(canonical(intent)),
    writeAttempts: 1,
    retryAllowed: false,
  };
  dependencies.writePrivate(`${stem}-jit-config`, response.encoded_jit_config);
  dependencies.writePrivate(`${stem}-receipt.json`, canonical(receipt));
  return receipt;
}

export async function verifyRecoveryJitJob(
  receipt: Json,
  env: NodeJS.ProcessEnv,
  request: RecoveryJitDependencies["request"],
  now = new Date(),
) {
  const selectedRole = role(env.GITHUB_JOB);
  const identity = recoveryRunnerIdentity(
    env.GITHUB_RUN_ID ?? "",
    selectedRole,
  );
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_RUN_ATTEMPT !== "1" ||
    env.GITHUB_WORKFLOW_REF !==
      `${REPOSITORY}/${ACTIVATION_WORKFLOW_PATH}@refs/heads/main` ||
    receipt.schemaVersion !== "pintpath-recovery-jit-registration/v1" ||
    receipt.repository !== REPOSITORY ||
    receipt.workflowPath !== ACTIVATION_WORKFLOW_PATH ||
    receipt.candidateSha !== env.GITHUB_SHA ||
    receipt.runId !== env.GITHUB_RUN_ID ||
    receipt.runAttempt !== 1 ||
    receipt.role !== selectedRole ||
    receipt.runnerName !== identity.name ||
    env.RUNNER_NAME !== identity.name ||
    !positive(receipt.runnerId) ||
    !positive(receipt.jobId) ||
    !positive(receipt.runnerGroupId) ||
    JSON.stringify(receipt.labels) !== JSON.stringify(identity.labels) ||
    receipt.writeAttempts !== 1 ||
    receipt.retryAllowed !== false ||
    [
      "stateSha256",
      "armAuthoritySha256",
      "railwayAuthoritySha256",
      "supabaseAuthoritySha256",
      "intentSha256",
      "runnerPolicySha256",
    ].some((key) => !SHA256.test(String(receipt[key]))) ||
    typeof receipt.createdAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    Date.parse(receipt.createdAt) > now.getTime() ||
    now.getTime() - Date.parse(receipt.createdAt) > 21_600_000
  )
    fail("receipt_invalid");
  const policyKey =
    selectedRole === "production-capture"
      ? "PINTPATH_PRODUCTION_BACKUP_EPHEMERAL_RUNNER_POLICY_SHA256"
      : "PINTPATH_DISPOSABLE_RECOVERY_EPHEMERAL_RUNNER_POLICY_SHA256";
  if (receipt.runnerPolicySha256 !== env[policyKey])
    fail("host_policy_mismatch");
  const stateDocument = record(
    await request(
      "GET",
      `/contents/.pintpath/emergency-cleanup/state.json?ref=${encodeURIComponent(EMERGENCY_CLEANUP_STATE_REF)}`,
    ),
  );
  if (
    stateDocument.encoding !== "base64" ||
    typeof stateDocument.content !== "string"
  )
    fail("state_invalid");
  const state = parseEmergencyCleanupState(
    Buffer.from(stateDocument.content, "base64").toString("utf8"),
  );
  if (
    state.status !== "open" ||
    state.stateSha256 !== receipt.stateSha256 ||
    state.candidateSha !== receipt.candidateSha ||
    state.activationRunId !== receipt.runId ||
    state.currentArmAuthoritySha256 !== receipt.armAuthoritySha256 ||
    Date.parse(state.armExpiresAt) <= now.getTime()
  )
    fail("arm_changed_before_job");
  const job = record(await request("GET", `/actions/jobs/${receipt.jobId}`));
  if (
    String(job.run_id) !== receipt.runId ||
    job.head_sha !== receipt.candidateSha ||
    job.status !== "in_progress" ||
    job.name !== JOB_NAMES[selectedRole] ||
    job.runner_id !== receipt.runnerId ||
    job.runner_name !== identity.name ||
    job.runner_group_id !== receipt.runnerGroupId ||
    JSON.stringify(job.labels) !== JSON.stringify(identity.labels)
  )
    fail("job_assignment_invalid");
  return {
    ok: true,
    kind: "exact-run-recovery-jit-job",
    role: selectedRole,
    jobId: receipt.jobId,
    runnerId: receipt.runnerId,
    receiptSha256: hash(canonical(receipt)),
  };
}

async function githubRequest(
  method: "GET" | "POST",
  endpoint: string,
  body?: Json,
): Promise<unknown> {
  const token = process.env.GH_TOKEN ?? "";
  if (!token || !endpoint.startsWith("/") || endpoint.includes(".."))
    fail("github_authority_missing");
  const signal = AbortSignal.timeout(20_000);
  const { response, source } = await fetchBoundedResponseText(
    fetch,
    `${API}${endpoint}`,
    {
      method,
      redirect: "error",
      signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    { maximumBytes: 2 * 1024 * 1024, signal },
  );
  if (response.status !== (method === "POST" ? 201 : 200))
    fail("github_request_failed");
  return JSON.parse(source);
}

async function main(argv: string[]) {
  const operation = argv.shift();
  if (operation === "verify-job") {
    if (argv.length !== 0 || process.platform !== "linux")
      fail("arguments_invalid");
    // Root installs the receipt before the one-job listener starts. A workload
    // cannot manufacture its own registration proof in RUNNER_TEMP/workspace.
    const parent = fs.lstatSync(path.dirname(RECOVERY_JIT_RECEIPT_PATH));
    if (
      parent.uid !== 0 ||
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (parent.mode & 0o022) !== 0
    )
      fail("receipt_file_untrusted");
    const stat = fs.lstatSync(RECOVERY_JIT_RECEIPT_PATH);
    if (
      stat.uid !== 0 ||
      (stat.mode & 0o777) !== 0o644 ||
      stat.isSymbolicLink()
    )
      fail("receipt_file_untrusted");
    const source = readTrustedRegularFile(RECOVERY_JIT_RECEIPT_PATH, {
      minBytes: 1,
      maxBytes: 16384,
      requireExactMode: 0o644,
    }).toString("utf8");
    const receipt = record(JSON.parse(source));
    if (canonical(receipt) !== source) fail("receipt_invalid");
    const proof = await verifyRecoveryJitJob(
      receipt,
      process.env,
      githubRequest,
    );
    process.stdout.write(`${JSON.stringify(proof)}\n`);
    return;
  }
  if (operation !== "prepare") fail("arguments_invalid");
  const names = new Set([
    "--candidate-sha",
    "--run-id",
    "--role",
    "--runner-group-id",
    "--authority-directory",
    "--journal-directory",
  ]);
  const args = parseStrictArguments(argv, { allowed: names, required: names });
  const journalDirectory = args.get("--journal-directory")!;
  const held = holdPrivateDirectoryIdentity(journalDirectory, {
    requireExactDirectoryMode: true,
    requireOwner: true,
  });
  try {
    const receipt = await prepareRecoveryJitRunner(
      {
        candidateSha: args.get("--candidate-sha")!,
        runId: args.get("--run-id")!,
        role: role(args.get("--role")),
        runnerGroupId: Number(args.get("--runner-group-id")),
        authorityDirectory: args.get("--authority-directory")!,
        journalDirectory,
      },
      {
        request: githubRequest,
        readPrivate: privateRead,
        now: () => new Date(),
        writePrivate(leaf, source) {
          held.assertExact();
          writePrivateExclusiveFile(journalDirectory, leaf, source, {
            requireOwner: true,
            requireExactDirectoryMode: true,
            expectedDirectoryIdentity: held.identity,
          });
        },
      },
    );
    process.stdout.write(
      `${JSON.stringify({ ok: true, runnerId: receipt.runnerId, jobId: receipt.jobId, role: receipt.role, receiptSha256: hash(canonical(receipt)), listenerStarted: false })}\n`,
    );
  } finally {
    held.close();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      "recovery_jit_rejected; preserve the journal and reconcile any registration before retry\n",
    );
    process.exitCode = 1;
  });
}
