import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.github/release-required-checks.json",
);
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RUN_URL_PATTERN =
  /^https:\/\/github\.com\/blackmagic30\/Beer\/actions\/runs\/([1-9][0-9]*)\/job\/[1-9][0-9]*$/;
const WORKFLOW_PATH_PATTERN =
  /^\.github\/workflows\/[a-z0-9][a-z0-9._-]*\.ya?ml$/;
const CHECK_EVENTS = new Set(["push", "workflow_dispatch"]);
const PHASES = Object.freeze([
  "staging",
  "production",
  "close",
  "promotion-recovery",
  "open",
  "release",
]);
const PRODUCTION_STAGES = Object.freeze([
  "deploy",
  "scale",
  "close",
  "promotion-recovery",
  "open",
]);
const PHASE_STAGE_COUNTS = Object.freeze({
  staging: 0,
  production: 0,
  close: 2,
  "promotion-recovery": 3,
  open: 4,
  release: 5,
});
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key, index) => Object.keys(value)[index] === key)
  );
}

function safeName(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 160 &&
    !/[\r\n\0]/.test(value)
  );
}

function timestamp(value) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function checkRequirementExact(value, production) {
  const keys = production
    ? ["stage", "name", "workflowPath", "event"]
    : ["name", "workflowPath", "event"];
  return exactKeys(value, keys)
    && (!production || PRODUCTION_STAGES.includes(value.stage))
    && safeName(value.name)
    && typeof value.workflowPath === "string"
    && WORKFLOW_PATH_PATTERN.test(value.workflowPath)
    && CHECK_EVENTS.has(value.event);
}

function artifactRequirementExact(value, production) {
  const keys = production
    ? ["stage", "name", "producerCheck"]
    : ["name", "producerCheck"];
  return exactKeys(value, keys)
    && (!production || PRODUCTION_STAGES.includes(value.stage))
    && safeName(value.name)
    && safeName(value.producerCheck);
}

export function parseGithubReleaseChecksPolicy(source) {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source, "utf8") > 64 * 1024 ||
    source.includes("\0")
  ) return null;
  try {
    const value = JSON.parse(source);
    if (
      !exactKeys(value, [
        "schemaVersion",
        "repository",
        "branch",
        "phaseConsumers",
        "requiredChecks",
        "requiredArtifacts",
      ]) ||
      value.schemaVersion !== "pintpath-github-release-required-checks/v3" ||
      value.repository !== "blackmagic30/Beer" ||
      value.branch !== "main" ||
      !exactKeys(value.phaseConsumers, PHASES) ||
      !exactKeys(value.requiredChecks, ["base", "staging", "production"]) ||
      !exactKeys(value.requiredArtifacts, ["base", "staging", "production"])
    ) return null;
    for (const phase of PHASES) {
      const consumer = value.phaseConsumers[phase];
      if (
        !exactKeys(consumer, ["workflowPath", "event"]) ||
        !WORKFLOW_PATH_PATTERN.test(consumer.workflowPath) ||
        consumer.event !== "workflow_dispatch"
      ) return null;
    }
    for (const group of [value.requiredChecks.base, value.requiredChecks.staging]) {
      if (
        !Array.isArray(group) ||
        group.length === 0 ||
        group.length > 32 ||
        group.some((item) => !checkRequirementExact(item, false))
      ) return null;
    }
    if (
      !Array.isArray(value.requiredChecks.production) ||
      value.requiredChecks.production.length !== PRODUCTION_STAGES.length ||
      value.requiredChecks.production.some((item, index) =>
        !checkRequirementExact(item, true) || item.stage !== PRODUCTION_STAGES[index])
    ) return null;
    const checks = [
      ...value.requiredChecks.base,
      ...value.requiredChecks.staging,
      ...value.requiredChecks.production,
    ];
    const checkNames = checks.map((item) => item.name);
    if (new Set(checkNames).size !== checkNames.length) return null;
    for (const group of [value.requiredArtifacts.base, value.requiredArtifacts.staging]) {
      if (
        !Array.isArray(group) ||
        group.length === 0 ||
        group.length > 32 ||
        group.some((item) => !artifactRequirementExact(item, false))
      ) return null;
    }
    if (
      !Array.isArray(value.requiredArtifacts.production) ||
      value.requiredArtifacts.production.length !== PRODUCTION_STAGES.length ||
      value.requiredArtifacts.production.some((item, index) =>
        !artifactRequirementExact(item, true) || item.stage !== PRODUCTION_STAGES[index])
    ) return null;
    const artifactRequirements = [
      ...value.requiredArtifacts.base,
      ...value.requiredArtifacts.staging,
      ...value.requiredArtifacts.production,
    ];
    if (
      new Set(artifactRequirements.map((item) => item.name)).size
        !== artifactRequirements.length ||
      artifactRequirements.some((item) => !checkNames.includes(item.producerCheck)) ||
      value.requiredArtifacts.production.some((artifact, index) =>
        artifact.producerCheck !== value.requiredChecks.production[index].name)
    ) return null;
    return canonicalJson(value) === source ? Object.freeze(value) : null;
  } catch {
    return null;
  }
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) throw new Error("argument_invalid");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--candidate-sha", "--phase", "--output"].includes(name) ||
      values.has(name) ||
      typeof value !== "string" ||
      value.length === 0
    ) throw new Error("argument_invalid");
    values.set(name, value);
  }
  const candidateSha = values.get("--candidate-sha");
  const phase = values.get("--phase");
  const output = values.get("--output");
  if (
    !SHA_PATTERN.test(candidateSha) ||
    !PHASES.includes(phase) ||
    !path.isAbsolute(output)
  ) throw new Error("argument_invalid");
  return { candidateSha, phase, output };
}

function requirements(policy, phase, candidateSha) {
  const checks = [...policy.requiredChecks.base];
  const artifacts = [...policy.requiredArtifacts.base];
  if (phase !== "staging") {
    checks.push(...policy.requiredChecks.staging);
    artifacts.push(...policy.requiredArtifacts.staging);
  }
  const stageCount = PHASE_STAGE_COUNTS[phase];
  checks.push(...policy.requiredChecks.production.slice(0, stageCount));
  artifacts.push(...policy.requiredArtifacts.production.slice(0, stageCount));
  return {
    consumer: policy.phaseConsumers[phase],
    checks,
    artifacts: artifacts.map((item) => ({
      ...item,
      name: item.name.replaceAll("{candidateSha}", candidateSha),
    })),
    productionStages: PRODUCTION_STAGES.slice(0, stageCount),
  };
}

async function boundedJson(response) {
  if (!response.ok || !response.body) throw new Error("github_query_failed");
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("github_query_failed");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("github_query_failed");
    }
    chunks.push(next.value);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new Error("github_query_failed");
  }
}

async function githubGet(fetchImpl, token, repository, endpoint) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}${endpoint}`,
    {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "pintpath-release-candidate-verifier/2",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
  );
  return boundedJson(response);
}

function selectCheckRunCandidates(value, requirement, candidateSha) {
  if (
    !exactKeys(value, ["total_count", "check_runs"]) ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0 ||
    value.total_count > 100 ||
    !Array.isArray(value.check_runs) ||
    value.check_runs.length !== value.total_count
  ) throw new Error("checks_invalid");
  const candidates = [];
  for (const run of value.check_runs) {
    if (
      run?.name !== requirement.name ||
      run?.head_sha !== candidateSha ||
      run?.status !== "completed" ||
      run?.conclusion !== "success"
    ) continue;
    const startedAtMs = timestamp(run.started_at);
    const completedAtMs = timestamp(run.completed_at);
    if (
      run.app?.slug !== "github-actions" ||
      typeof run.details_url !== "string" ||
      !RUN_URL_PATTERN.test(run.details_url) ||
      !Number.isSafeInteger(run.check_suite?.id) ||
      run.check_suite.id <= 0 ||
      startedAtMs === null ||
      completedAtMs === null ||
      completedAtMs <= startedAtMs
    ) throw new Error(`required_check_invalid:${requirement.name}`);
    const runId = Number(RUN_URL_PATTERN.exec(run.details_url)[1]);
    if (!Number.isSafeInteger(runId)) throw new Error("checks_invalid");
    candidates.push(Object.freeze({
      checkSuiteId: run.check_suite.id,
      name: requirement.name,
      runId,
      startedAt: run.started_at,
      startedAtMs,
      completedAt: run.completed_at,
      completedAtMs,
    }));
  }
  return candidates;
}

function validateWorkflowRun(value, candidate, requirement, policy, candidateSha) {
  const runStartedAtMs = timestamp(value?.run_started_at);
  if (
    value?.id !== candidate.runId ||
    value?.check_suite_id !== candidate.checkSuiteId ||
    value?.head_sha !== candidateSha ||
    value?.head_branch !== policy.branch ||
    value?.status !== "completed" ||
    value?.conclusion !== "success" ||
    value?.repository?.full_name !== policy.repository ||
    value?.head_repository?.full_name !== policy.repository
  ) throw new Error("workflow_run_invalid");
  if (value.path !== requirement.workflowPath || value.event !== requirement.event) {
    return null;
  }
  if (
    !Number.isSafeInteger(value?.workflow_id) ||
    value.workflow_id <= 0 ||
    value?.run_attempt !== 1 ||
    runStartedAtMs === null ||
    candidate.startedAtMs < runStartedAtMs
  ) throw new Error("workflow_run_invalid");
  return Object.freeze({
    ...(requirement.stage ? { stage: requirement.stage } : {}),
    name: requirement.name,
    runId: candidate.runId,
    checkSuiteId: candidate.checkSuiteId,
    workflowId: value.workflow_id,
    workflowPath: value.path,
    event: value.event,
    runAttempt: value.run_attempt,
    startedAt: candidate.startedAt,
    completedAt: candidate.completedAt,
  });
}

function validateCurrentConsumer(value, expected, policy, candidateSha, runId) {
  const runStartedAtMs = timestamp(value?.run_started_at);
  if (
    value?.id !== runId ||
    value?.head_sha !== candidateSha ||
    value?.head_branch !== policy.branch ||
    value?.status !== "in_progress" ||
    value?.conclusion !== null ||
    !Number.isSafeInteger(value?.workflow_id) ||
    value.workflow_id <= 0 ||
    value?.run_attempt !== 1 ||
    value?.repository?.full_name !== policy.repository ||
    value?.head_repository?.full_name !== policy.repository ||
    value?.path !== expected.workflowPath ||
    value?.event !== expected.event ||
    runStartedAtMs === null
  ) throw new Error("current_consumer_invalid");
  return Object.freeze({
    runId,
    workflowId: value.workflow_id,
    workflowPath: value.path,
    event: value.event,
    runAttempt: value.run_attempt,
    runStartedAt: value.run_started_at,
  });
}

function selectArtifact(value, requirement, candidateSha, runId, repository) {
  if (
    !exactKeys(value, ["total_count", "artifacts"]) ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0 ||
    value.total_count > 100 ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length !== value.total_count
  ) throw new Error("artifacts_invalid");
  const matches = value.artifacts.filter((item) => item?.name === requirement.name);
  if (matches.length !== 1) {
    throw new Error(`required_artifact_missing_or_duplicate:${requirement.name}`);
  }
  const artifact = matches[0];
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    artifact.expired !== false ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    typeof artifact.digest !== "string" ||
    !DIGEST_PATTERN.test(artifact.digest) ||
    artifact.workflow_run?.head_sha !== candidateSha ||
    artifact.workflow_run?.id !== runId ||
    artifact.archive_download_url
      !== `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`
  ) throw new Error(`required_artifact_invalid:${requirement.name}`);
  return Object.freeze({
    ...(requirement.stage ? { stage: requirement.stage } : {}),
    artifactId: artifact.id,
    name: artifact.name,
    digest: artifact.digest,
    sizeBytes: artifact.size_in_bytes,
    runId,
    producerCheck: requirement.producerCheck,
  });
}

function writeExclusive(filename, source) {
  const parent = path.dirname(filename);
  const parentStat = fs.lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (parentStat.mode & 0o777) !== 0o700 ||
    (typeof process.geteuid === "function" && parentStat.uid !== process.geteuid()) ||
    fs.realpathSync(parent) !== path.resolve(parent)
  ) throw new Error("output_unsafe");
  fs.writeFileSync(filename, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const fd = fs.openSync(filename, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parentFd = fs.openSync(parent, "r");
  try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
}

export async function runGithubReleaseCandidateVerification(argv, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const env = dependencies.env ?? process.env;
  const writeOutput = dependencies.writeOutput
    ?? ((value) => process.stdout.write(value));
  try {
    const args = parseArguments(argv);
    const policySource = fs.readFileSync(POLICY_PATH, "utf8");
    const policy = parseGithubReleaseChecksPolicy(policySource);
    if (!policy) throw new Error("policy_invalid");
    if (
      env.GITHUB_ACTIONS !== "true" ||
      env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_SHA !== args.candidateSha ||
      env.GITHUB_REPOSITORY !== policy.repository ||
      env.GITHUB_RUN_ATTEMPT !== "1" ||
      typeof env.GITHUB_RUN_ID !== "string" ||
      !POSITIVE_INTEGER_PATTERN.test(env.GITHUB_RUN_ID) ||
      typeof env.GITHUB_TOKEN !== "string" ||
      env.GITHUB_TOKEN.length < 16 ||
      /[\r\n\0]/.test(env.GITHUB_TOKEN)
    ) throw new Error("github_context_invalid");
    const currentRunId = Number(env.GITHUB_RUN_ID);
    if (!Number.isSafeInteger(currentRunId)) throw new Error("github_context_invalid");
    const required = requirements(policy, args.phase, args.candidateSha);
    const currentRun = await githubGet(
      fetchImpl,
      env.GITHUB_TOKEN,
      policy.repository,
      `/actions/runs/${currentRunId}`,
    );
    const consumer = validateCurrentConsumer(
      currentRun,
      required.consumer,
      policy,
      args.candidateSha,
      currentRunId,
    );
    const consumerStartedAtMs = timestamp(consumer.runStartedAt);
    const workflowRuns = new Map([[currentRunId, currentRun]]);
    const checks = [];
    for (const requirement of required.checks) {
      const checksPayload = await githubGet(
        fetchImpl,
        env.GITHUB_TOKEN,
        policy.repository,
        `/commits/${args.candidateSha}/check-runs?filter=all&check_name=${encodeURIComponent(requirement.name)}&per_page=100`,
      );
      const candidates = selectCheckRunCandidates(
        checksPayload,
        requirement,
        args.candidateSha,
      );
      const intended = [];
      for (const candidate of candidates) {
        let run = workflowRuns.get(candidate.runId);
        if (run === undefined) {
          run = await githubGet(
            fetchImpl,
            env.GITHUB_TOKEN,
            policy.repository,
            `/actions/runs/${candidate.runId}`,
          );
          workflowRuns.set(candidate.runId, run);
        }
        const selected = validateWorkflowRun(
          run,
          candidate,
          requirement,
          policy,
          args.candidateSha,
        );
        if (selected) intended.push(selected);
      }
      if (intended.length !== 1) {
        throw new Error(`required_check_invalid:${requirement.name}`);
      }
      checks.push(intended[0]);
    }
    if (
      consumerStartedAtMs === null ||
      checks.some((check) => timestamp(check.completedAt) >= consumerStartedAtMs)
    ) throw new Error("chronology_invalid");
    const checkByName = new Map(checks.map((check) => [check.name, check]));
    const artifactPayloadByRun = new Map();
    const artifacts = [];
    for (const requirement of required.artifacts) {
      const producer = checkByName.get(requirement.producerCheck);
      if (!producer) throw new Error("artifact_producer_invalid");
      let payload = artifactPayloadByRun.get(producer.runId);
      if (payload === undefined) {
        payload = await githubGet(
          fetchImpl,
          env.GITHUB_TOKEN,
          policy.repository,
          `/actions/runs/${producer.runId}/artifacts?per_page=100`,
        );
        artifactPayloadByRun.set(producer.runId, payload);
      }
      artifacts.push(selectArtifact(
        payload,
        requirement,
        args.candidateSha,
        producer.runId,
        policy.repository,
      ));
    }
    const productionChain = required.productionStages.map((stage) => {
      const check = checks.find((item) => item.stage === stage);
      const artifact = artifacts.find((item) => item.stage === stage);
      if (!check || !artifact || check.runId !== artifact.runId) {
        throw new Error("production_chain_invalid");
      }
      return Object.freeze({ ...check, artifact });
    });
    for (let index = 1; index < productionChain.length; index += 1) {
      if (
        timestamp(productionChain[index - 1].completedAt)
          >= timestamp(productionChain[index].startedAt)
      ) throw new Error("chronology_invalid");
    }
    const orderedProductionChainSha256 = sha256(canonicalJson(productionChain));
    const receipt = Object.freeze({
      schemaVersion: "pintpath-github-release-candidate-receipt/v3",
      repository: policy.repository,
      branch: policy.branch,
      phase: args.phase,
      candidateSha: args.candidateSha,
      policySha256: sha256(policySource),
      consumer,
      checks,
      artifacts,
      productionChain,
      orderedProductionChainSha256,
      requiredChecksExact: true,
      requiredArtifactsExact: true,
      chronologyExact: true,
      currentConsumerExact: true,
    });
    const source = canonicalJson(receipt);
    writeExclusive(args.output, source);
    writeOutput(`${JSON.stringify({
      candidateSha: args.candidateSha,
      command: "verify-github-release-candidate",
      ok: true,
      phase: args.phase,
      orderedProductionChainSha256,
      receiptSha256: sha256(source),
    })}\n`);
    return 0;
  } catch (error) {
    const failureCode = error instanceof Error
      ? error.message.split(":", 1)[0]
      : "unexpected_failure";
    writeOutput(`${JSON.stringify({
      command: "verify-github-release-candidate",
      failureCode,
      ok: false,
    })}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runGithubReleaseCandidateVerification(process.argv.slice(2));
}
