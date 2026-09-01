import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  githubGet,
  parseGithubReleaseChecksPolicy,
  verifyReviewedPullRequest,
} from "./verify-github-release-candidate.mjs";

export const ACCOUNT_DELETION_REHEARSAL_AUTHORITY_SCHEMA =
  "pintpath-account-deletion-rehearsal-authority/v1";

const REPOSITORY = "blackmagic30/Beer";
const WORKFLOW_PATH =
  ".github/workflows/permanent-staging-account-deletion-rehearsal.yml";
const CLEANUP_WORKFLOW_PATH =
  ".github/workflows/reconcile-permanent-staging-account-deletion-rehearsal.yml";
const POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.github/release-required-checks.json",
);
const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  if (argv.length !== 6 && argv.length !== 10) return null;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || !argv[index + 1]
      || values.has(argv[index])) return null;
    values.set(argv[index], argv[index + 1]);
  }
  const mode = values.get("--mode");
  const candidateSha = values.get("--candidate-sha");
  const evidenceDirectory = values.get("--evidence-dir");
  const activationRunId = values.get("--activation-run-id") ?? null;
  const activationTerminalFile = values.get("--activation-terminal-file") ?? null;
  if (
    !["start", "cleanup"].includes(mode)
    || !SHA.test(candidateSha ?? "")
    || !path.isAbsolute(evidenceDirectory ?? "")
    || (mode === "start" && (activationRunId !== null
      || activationTerminalFile !== null || argv.length !== 6))
    || (mode === "cleanup" && (!RUN_ID.test(activationRunId ?? "")
      || !path.isAbsolute(activationTerminalFile ?? "") || argv.length !== 10))
  ) return null;
  return { mode, candidateSha, evidenceDirectory, activationRunId,
    activationTerminalFile };
}

function exactActivationTerminal(source, candidateSha, activationRunId) {
  try {
    const value = JSON.parse(source);
    const transitionTerminal = value?.schemaVersion ===
        "pintpath-account-deletion-rehearsal-transition-terminal/v1"
      && value?.receipt?.operation === "store-activation"
      && value?.receipt?.outcome === "activation_stored"
      && value?.receipt?.candidateSha === candidateSha
      && value?.receipt?.githubRunId === activationRunId
      && value?.receipt?.checks?.terminalEvidenceExact === false
      && value?.secretMaterialIncluded === false;
    const durableArm = value?.schemaVersion ===
        "pintpath-account-deletion-rehearsal-cleanup-arm/v1"
      && value?.candidateSha === candidateSha
      && value?.activationRunId === activationRunId
      && value?.projectId === "48d8c6cd-1c66-4148-874b-20877f48e1a5"
      && value?.environmentId === "a4e0f507-d6d3-4df9-a818-ad92c0071a35"
      && value?.serviceId === "6816c4a2-e392-4ee5-826f-2584cb599ec0"
      && value?.cleanupRequired === true
      && value?.disarmCondition ===
        "SAFE_ONE_PREACTIVATION_OR_SAFE_ONE_FINAL_OR_QUARANTINED_ZERO"
      && value?.secretMaterialIncluded === false;
    return transitionTerminal || durableArm;
  } catch {
    return false;
  }
}

function writeExclusive(directory, leaf, source) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, leaf);
  fs.writeFileSync(filename, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return sha256(source);
}

export async function runAccountDeletionRehearsalAuthorityVerification(
  argv = process.argv.slice(2),
  overrides = {},
) {
  const env = overrides.env ?? process.env;
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const writeDurable = overrides.writeDurable ?? writeExclusive;
  const writeOutput = overrides.writeOutput ?? ((source) => process.stdout.write(source));
  const args = parseArguments(argv);
  try {
    if (
      !args
      || env.GITHUB_REPOSITORY !== REPOSITORY
      || env.GITHUB_RUN_ATTEMPT !== "1"
      || !RUN_ID.test(env.GITHUB_RUN_ID ?? "")
      || !env.GITHUB_TOKEN
    ) throw new Error("authority_invalid");
    const workflow = env.GITHUB_WORKFLOW_REF?.split("@")[0]?.replace(
      `${REPOSITORY}/`,
      "",
    );
    if (workflow !== (args.mode === "start" ? WORKFLOW_PATH : CLEANUP_WORKFLOW_PATH)) {
      throw new Error("workflow_invalid");
    }
    const policy = parseGithubReleaseChecksPolicy(fs.readFileSync(POLICY_PATH, "utf8"));
    if (!policy || policy.repository !== REPOSITORY || policy.branch !== "main") {
      throw new Error("policy_invalid");
    }

    let reviewedPullRequest = null;
    let originalActivation = null;
    if (args.mode === "start") {
      if (env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_SHA !== args.candidateSha) {
        throw new Error("candidate_invalid");
      }
      const branch = await githubGet(
        fetchImpl,
        env.GITHUB_TOKEN,
        REPOSITORY,
        "/git/ref/heads/main",
      );
      if (branch?.object?.type !== "commit" || branch.object.sha !== args.candidateSha) {
        throw new Error("main_advanced");
      }
      reviewedPullRequest = await verifyReviewedPullRequest(
        fetchImpl,
        env.GITHUB_TOKEN,
        policy,
        args.candidateSha,
      );
    } else {
      const source = fs.readFileSync(args.activationTerminalFile, "utf8");
      if (!exactActivationTerminal(source, args.candidateSha, args.activationRunId)) {
        throw new Error("activation_terminal_invalid");
      }
      const run = await githubGet(
        fetchImpl,
        env.GITHUB_TOKEN,
        REPOSITORY,
        `/actions/runs/${args.activationRunId}/attempts/1`,
      );
      if (
        String(run?.id) !== args.activationRunId
        || run?.repository?.full_name !== REPOSITORY
        || run?.head_sha !== args.candidateSha
        || run?.event !== "workflow_dispatch"
        || run?.run_attempt !== 1
        || (run?.path !== WORKFLOW_PATH && run?.path !== `${WORKFLOW_PATH}@main`)
        || !["in_progress", "completed"].includes(run?.status)
      ) throw new Error("activation_run_invalid");
      originalActivation = {
        runId: args.activationRunId,
        terminalSha256: sha256(source),
        mainAdvanceIgnoredForCleanup: true,
      };
    }

    const authority = canonical({
      schemaVersion: ACCOUNT_DELETION_REHEARSAL_AUTHORITY_SCHEMA,
      executorState: "GITHUB_ENVIRONMENT_PROTECTED",
      mode: args.mode,
      candidateSha: args.candidateSha,
      githubRunId: env.GITHUB_RUN_ID,
      workflowPath: args.mode === "start" ? WORKFLOW_PATH : CLEANUP_WORKFLOW_PATH,
      reviewedPullRequest,
      originalActivation,
      cleanupMayProceedAfterMainAdvances: args.mode === "cleanup",
      secretMaterialIncluded: false,
    });
    const receiptSha256 = writeDurable(
      args.evidenceDirectory,
      "github-authority.json",
      authority,
    );
    if (receiptSha256 !== sha256(authority)) throw new Error("write_invalid");
    writeOutput(JSON.stringify({
      schemaVersion: ACCOUNT_DELETION_REHEARSAL_AUTHORITY_SCHEMA,
      outcome: "authorized",
      mode: args.mode,
      candidateSha: args.candidateSha,
      receiptSha256,
    }) + "\n");
    return 0;
  } catch {
    writeOutput(JSON.stringify({
      schemaVersion: ACCOUNT_DELETION_REHEARSAL_AUTHORITY_SCHEMA,
      outcome: "blocked",
      mode: args?.mode ?? null,
      candidateSha: args?.candidateSha ?? null,
      receiptSha256: null,
    }) + "\n");
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runAccountDeletionRehearsalAuthorityVerification();
}

export const accountDeletionRehearsalAuthorityInternals = {
  exactActivationTerminal,
  parseArguments,
};
