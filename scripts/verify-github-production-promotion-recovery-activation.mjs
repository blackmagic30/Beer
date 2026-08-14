import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  holdPrivateDirectoryIdentity,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";
import { fetchBoundedResponseText } from "./lib/bounded-http-response.js";

const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PATH =
  ".github/workflows/activate-production-promotion-recovery.yml";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

function fail(code) {
  throw new Error(`github_production_promotion_recovery_activation_${code}`);
}

function parseArgs(argv) {
  if (argv.length !== 6) fail("arguments_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index],
      value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key))
      fail("arguments_invalid");
    values.set(key, value);
  }
  const candidateSha = values.get("--candidate-sha") ?? "";
  const runId = values.get("--run-id") ?? "";
  const output = values.get("--output") ?? "";
  if (
    values.size !== 3 ||
    !SHA.test(candidateSha) ||
    !RUN_ID.test(runId) ||
    !path.isAbsolute(output) ||
    path.resolve(output) !== output ||
    output.includes("\0") ||
    path.basename(output) !== "activation-github-authority.json"
  )
    fail("arguments_invalid");
  return { candidateSha, runId, output };
}

function exactObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function normalizeGithubTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
  )
    fail("run_invalid");
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value.replace("Z", ".000Z")
  ) {
    fail("run_invalid");
  }
  return new Date(parsed).toISOString();
}

async function githubJson(fetchImpl, url, token, requestTimeoutMs) {
  let bounded;
  try {
    const signal = AbortSignal.timeout(requestTimeoutMs);
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
      { maximumBytes: MAX_RESPONSE_BYTES, signal },
    );
  } catch {
    fail("api_failed");
  }
  const { response, source } = bounded;
  if (!response.ok) fail("api_failed");
  try {
    return JSON.parse(source);
  } catch {
    return fail("api_invalid");
  }
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

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(",")}}`;
  fail("canonicalization_failed");
}

export async function verifyGithubProductionPromotionRecoveryActivation(input) {
  const repository = input.env.GITHUB_REPOSITORY ?? "";
  const token = input.env.GITHUB_TOKEN ?? "";
  const api = input.env.GITHUB_API_URL ?? "https://api.github.com";
  if (
    !REPOSITORY.test(repository) ||
    !token ||
    /[\r\n\0]/.test(token) ||
    api !== "https://api.github.com"
  )
    fail("environment_invalid");
  const base = `${api}/repos/${repository}`;
  const run = exactObject(
    await githubJson(
      input.fetchImpl,
      `${base}/actions/runs/${input.runId}`,
      token,
      input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
  );
  const runRepository = exactObject(run?.repository);
  if (
    !run ||
    String(run.id) !== input.runId ||
    runRepository?.full_name !== repository ||
    run.path !== WORKFLOW_PATH ||
    run.event !== "workflow_dispatch" ||
    run.head_sha !== input.candidateSha ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.run_attempt !== 1
  )
    fail("run_invalid");
  const workflowRunStartedAt = normalizeGithubTimestamp(run.run_started_at);
  const expectedName = `pintpath-production-promotion-recovery-activation-${input.candidateSha}`;
  const listing = exactObject(
    await githubJson(
      input.fetchImpl,
      `${base}/actions/runs/${input.runId}/artifacts?name=${encodeURIComponent(expectedName)}`,
      token,
      input.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ),
  );
  const artifacts = Array.isArray(listing?.artifacts) ? listing.artifacts : [];
  if (listing?.total_count !== 1 || artifacts.length !== 1)
    fail("artifact_invalid");
  const artifact = exactObject(artifacts[0]);
  const artifactRun = exactObject(artifact?.workflow_run);
  if (
    !artifact ||
    artifact.name !== expectedName ||
    artifact.expired !== false ||
    !RUN_ID.test(String(artifact.id)) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(artifact.digest)) ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    (artifactRun &&
      (String(artifactRun.id) !== input.runId ||
        artifactRun.head_sha !== input.candidateSha))
  )
    fail("artifact_invalid");
  return {
    schemaVersion: 1,
    kind: "pintpath-production-promotion-recovery-activation-github-authority",
    repository,
    candidateSha: input.candidateSha,
    workflowPath: WORKFLOW_PATH,
    workflowRunId: input.runId,
    workflowRunAttempt: 1,
    workflowRunStartedAt,
    workflowEvent: "workflow_dispatch",
    workflowConclusion: "success",
    artifactName: expectedName,
    artifactId: String(artifact.id),
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.size_in_bytes,
    artifactExpired: false,
  };
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  holdDirectory: (directory) =>
    holdPrivateDirectoryIdentity(directory, {
      requireExactDirectoryMode: true,
      requireOwner: true,
    }),
  assertOutputAbsent,
  writeFile: (directory, leaf, source, expectedDirectoryIdentity) =>
    writePrivateExclusiveFile(directory, leaf, source, {
      requireExactDirectoryMode: true,
      requireOwner: true,
      expectedDirectoryIdentity,
    }),
});

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  overrides = {},
) {
  const args = parseArgs(argv);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const parent = path.dirname(args.output);
  const heldDirectory = dependencies.holdDirectory(parent);
  let closed = false;
  try {
    heldDirectory.assertExact();
    dependencies.assertOutputAbsent(args.output);
    heldDirectory.assertExact();
    const authority = await verifyGithubProductionPromotionRecoveryActivation({
      ...args,
      env,
      fetchImpl,
      requestTimeoutMs: dependencies.requestTimeoutMs,
    });
    heldDirectory.assertExact();
    const directoryIdentity = heldDirectory.identity;
    heldDirectory.close();
    closed = true;
    dependencies.writeFile(
      parent,
      path.basename(args.output),
      `${canonicalize(authority)}\n`,
      directoryIdentity,
    );
    return authority;
  } catch (error) {
    if (!closed) {
      try {
        heldDirectory.close();
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
      `${error instanceof Error ? error.message : "github_activation_invalid"}\n`,
    );
    process.exitCode = 1;
  }
}
