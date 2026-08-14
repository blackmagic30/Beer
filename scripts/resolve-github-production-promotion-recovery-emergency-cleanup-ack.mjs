import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchBoundedResponseText } from "./lib/bounded-http-response.js";
import {
  holdPrivateDirectoryIdentity,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const REPOSITORY = "blackmagic30/Beer";
const ACTIVATION_WORKFLOW_PATH =
  ".github/workflows/activate-production-promotion-recovery.yml";
const CONTROLLER_WORKFLOW_PATH =
  ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

function fail(code) {
  throw new Error(`github_emergency_cleanup_ack_${code}`);
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (record(value))
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(",")}}`;
  fail("canonicalization_failed");
}

function parseArgs(argv) {
  if (argv.length !== 8) fail("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key))
      fail("arguments_invalid");
    values.set(key, value);
  }
  const candidateSha = values.get("--candidate-sha") ?? "";
  const activationRunId = values.get("--activation-run-id") ?? "";
  const provider = values.get("--provider") ?? "";
  const output = values.get("--output") ?? "";
  if (
    values.size !== 4 ||
    !SHA.test(candidateSha) ||
    !RUN_ID.test(activationRunId) ||
    (provider !== "railway" && provider !== "supabase") ||
    !path.isAbsolute(output) ||
    path.resolve(output) !== output ||
    output.includes("\0") ||
    path.basename(output) !== `emergency-cleanup-${provider}-ack-artifact.json`
  )
    fail("arguments_invalid");
  return { candidateSha, activationRunId, provider, output };
}

async function githubJson(fetchImpl, url, token, requestTimeoutMs) {
  let bounded;
  try {
    bounded = await fetchBoundedResponseText(
      fetchImpl,
      url,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        cache: "no-store",
      },
      {
        maximumBytes: MAX_RESPONSE_BYTES,
        signal: AbortSignal.timeout(requestTimeoutMs),
      },
    );
  } catch {
    fail("api_failed");
  }
  if (!bounded.response.ok) fail("api_failed");
  try {
    return JSON.parse(bounded.source);
  } catch {
    return fail("api_invalid");
  }
}

function artifactExact(value, expectedName) {
  const artifact = record(value);
  const run = record(artifact?.workflow_run);
  const createdAt = Date.parse(String(artifact?.created_at));
  return Boolean(
    artifact &&
    artifact.name === expectedName &&
    artifact.expired === false &&
    RUN_ID.test(String(artifact.id)) &&
    /^sha256:[a-f0-9]{64}$/.test(String(artifact.digest)) &&
    Number.isSafeInteger(artifact.size_in_bytes) &&
    artifact.size_in_bytes > 0 &&
    Number.isFinite(createdAt) &&
    run &&
    RUN_ID.test(String(run.id)) &&
    SHA.test(String(run.head_sha)),
  );
}

export async function resolveGithubEmergencyCleanupAckArtifact(input) {
  const repository = input.env.GITHUB_REPOSITORY ?? "";
  const token = input.env.GITHUB_TOKEN ?? "";
  const api = input.env.GITHUB_API_URL ?? "https://api.github.com";
  if (
    repository !== REPOSITORY ||
    !token ||
    /[\r\n\0]/.test(token) ||
    api !== "https://api.github.com"
  )
    fail("environment_invalid");
  const artifactName = `pintpath-production-promotion-recovery-emergency-cleanup-${input.activationRunId}-${input.provider}-delete-ack`;
  const base = `${api}/repos/${repository}`;
  const listing = record(
    await githubJson(
      input.fetchImpl,
      `${base}/actions/artifacts?name=${encodeURIComponent(artifactName)}&per_page=100`,
      token,
      input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
  );
  const artifacts = Array.isArray(listing?.artifacts) ? listing.artifacts : [];
  if (
    !listing ||
    !Number.isSafeInteger(listing.total_count) ||
    listing.total_count < 0 ||
    listing.total_count > 100 ||
    listing.total_count !== artifacts.length ||
    artifacts.some((artifact) => !artifactExact(artifact, artifactName))
  )
    fail("artifact_invalid");
  if (artifacts.length === 0)
    return {
      schemaVersion: 1,
      kind: "pintpath-production-promotion-recovery-emergency-cleanup-ack-artifact-resolution",
      found: false,
      repository,
      candidateSha: input.candidateSha,
      activationRunId: input.activationRunId,
      provider: input.provider,
      artifactName,
      artifactId: null,
      artifactDigest: null,
      artifactSizeBytes: null,
      cleanupWorkflowPath: null,
      cleanupRunId: null,
      cleanupRunHeadSha: null,
    };
  const ordered = [...artifacts].sort((left, right) => {
    const time = Date.parse(right.created_at) - Date.parse(left.created_at);
    return time || Number(right.id) - Number(left.id);
  });
  if (
    ordered.length > 1 &&
    ordered[0].created_at === ordered[1].created_at &&
    String(ordered[0].id) === String(ordered[1].id)
  )
    fail("artifact_ambiguous");
  const artifact = ordered[0];
  const cleanupRunId = String(artifact.workflow_run.id);
  if (
    artifacts.filter((entry) => String(entry.workflow_run.id) === cleanupRunId)
      .length !== 1
  )
    fail("artifact_ambiguous");
  const run = record(
    await githubJson(
      input.fetchImpl,
      `${base}/actions/runs/${cleanupRunId}`,
      token,
      input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
  );
  const runRepository = record(run?.repository);
  const artifactRun = record(artifact.workflow_run);
  const activationSource = run?.path === ACTIVATION_WORKFLOW_PATH;
  const controllerSource = run?.path === CONTROLLER_WORKFLOW_PATH;
  if (
    !run ||
    !artifactRun ||
    String(run.id) !== cleanupRunId ||
    runRepository?.full_name !== repository ||
    (!activationSource && !controllerSource) ||
    (activationSource
      ? run.event !== "workflow_dispatch" ||
        cleanupRunId !== input.activationRunId ||
        run.head_sha !== input.candidateSha ||
        artifactRun.head_sha !== input.candidateSha
      : cleanupRunId === input.activationRunId ||
        !["workflow_run", "schedule", "workflow_dispatch"].includes(
          run.event,
        ) ||
        !SHA.test(String(run.head_sha)) ||
        artifactRun.head_sha !== run.head_sha) ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    !["success", "failure", "cancelled", "timed_out"].includes(
      run.conclusion,
    ) ||
    run.run_attempt !== 1
  )
    fail("run_invalid");
  return {
    schemaVersion: 1,
    kind: "pintpath-production-promotion-recovery-emergency-cleanup-ack-artifact-resolution",
    found: true,
    repository,
    candidateSha: input.candidateSha,
    activationRunId: input.activationRunId,
    provider: input.provider,
    artifactName,
    artifactId: String(artifact.id),
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.size_in_bytes,
    cleanupWorkflowPath: run.path,
    cleanupRunId,
    cleanupRunHeadSha: run.head_sha,
  };
}

function assertOutputAbsent(filename) {
  try {
    fs.lstatSync(filename);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    fail("output_unsafe");
  }
  fail("output_collision");
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
) {
  const args = parseArgs(argv);
  const parent = path.dirname(args.output);
  const held = holdPrivateDirectoryIdentity(parent, {
    requireExactDirectoryMode: true,
    requireOwner: true,
  });
  let closed = false;
  try {
    held.assertExact();
    assertOutputAbsent(args.output);
    const result = await resolveGithubEmergencyCleanupAckArtifact({
      ...args,
      env,
      fetchImpl,
    });
    held.assertExact();
    const identity = held.identity;
    held.close();
    closed = true;
    writePrivateExclusiveFile(
      parent,
      path.basename(args.output),
      `${canonicalize(result)}\n`,
      {
        requireExactDirectoryMode: true,
        requireOwner: true,
        expectedDirectoryIdentity: identity,
      },
    );
    return result;
  } catch (error) {
    if (!closed) {
      try {
        held.close();
      } catch {
        fail("output_unsafe");
      }
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "github_emergency_cleanup_ack_invalid"}\n`,
    );
    process.exitCode = 1;
  }
}
