import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseGithubReleaseChecksPolicy,
  verifyReviewedPullRequest,
} from "./verify-github-release-candidate.mjs";

const POLICY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.github/release-required-checks.json",
);
const SHA = /^[a-f0-9]{40}$/;
const MAX_EVIDENCE_BYTES = 1024 * 1024;

function fail() {
  throw new Error("reviewed_pr_head_fetch_invalid");
}

function exactKeys(value, expected) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key, index) => Object.keys(value)[index] === key);
}

function parseArguments(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    argv[0] !== "--evidence" ||
    typeof argv[1] !== "string" ||
    !path.isAbsolute(argv[1]) ||
    path.resolve(argv[1]) !== argv[1] ||
    argv[1].includes("\0")
  ) fail();
  return Object.freeze({ evidence: argv[1] });
}

function readReleaseIdentity(filename) {
  const stat = fs.lstatSync(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > MAX_EVIDENCE_BYTES ||
    fs.realpathSync(filename) !== filename
  ) fail();
  const source = fs.readFileSync(filename, "utf8");
  if (source.includes("\0") || Buffer.byteLength(source, "utf8") !== stat.size) fail();
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail();
  }
  if (
    !exactKeys(value, ["version", "release", "items"]) ||
    value.version !== 4 ||
    !exactKeys(value.release, [
      "id",
      "reviewedPrHeadSha",
      "candidateSha",
      "environment",
    ]) ||
    value.release.environment !== "production"
  ) fail();
  const identity = value.release;
  if (
    identity.id === null &&
    identity.reviewedPrHeadSha === null &&
    identity.candidateSha === null
  ) return null;
  if (
    typeof identity.id !== "string" ||
    identity.id.length < 1 ||
    identity.id.length > 128 ||
    !SHA.test(identity.reviewedPrHeadSha) ||
    !SHA.test(identity.candidateSha)
  ) fail();
  return Object.freeze({
    reviewedPrHeadSha: identity.reviewedPrHeadSha,
    candidateSha: identity.candidateSha,
  });
}

function defaultRunGit(args, cwd) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function requireGit(runGit, args, cwd) {
  const result = runGit(args, cwd);
  if (result.status !== 0) fail();
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

export async function runGithubReviewedPrHeadFetch(argv, dependencies = {}) {
  const args = parseArguments(argv);
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const cwd = dependencies.cwd ?? process.cwd();
  const runGit = dependencies.runGit ?? defaultRunGit;
  const writeOutput = dependencies.writeOutput ?? ((value) => process.stdout.write(value));
  const policySource = fs.readFileSync(POLICY_PATH, "utf8");
  const policy = parseGithubReleaseChecksPolicy(policySource);
  if (
    !policy ||
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== policy.repository ||
    typeof env.GITHUB_TOKEN !== "string" ||
    env.GITHUB_TOKEN.length < 16 ||
    /[\r\n\0]/.test(env.GITHUB_TOKEN) ||
    fs.realpathSync(cwd) !== path.resolve(cwd)
  ) fail();

  const identity = readReleaseIdentity(args.evidence);
  if (identity === null) {
    writeOutput(`${JSON.stringify({ command: "fetch-github-reviewed-pr-head", ok: true, skipped: true })}\n`);
    return 0;
  }

  const pull = await verifyReviewedPullRequest(
    fetchImpl,
    env.GITHUB_TOKEN,
    policy,
    identity.candidateSha,
  );
  if (pull.reviewedPrHeadSha !== identity.reviewedPrHeadSha) fail();

  const localRef = `refs/pintpath/reviewed-pr-head/${identity.candidateSha}`;
  const remote = dependencies.remote ?? `https://github.com/${policy.repository}.git`;
  requireGit(runGit, [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--force",
    remote,
    `+refs/pull/${pull.number}/head:${localRef}`,
  ], cwd);
  const fetchedSha = requireGit(runGit, ["rev-parse", `${localRef}^{commit}`], cwd);
  const reviewedTree = requireGit(runGit, ["rev-parse", `${localRef}^{tree}`], cwd);
  const candidateTree = requireGit(
    runGit,
    ["rev-parse", `${identity.candidateSha}^{tree}`],
    cwd,
  );
  if (
    fetchedSha !== identity.reviewedPrHeadSha ||
    reviewedTree !== pull.treeSha ||
    candidateTree !== pull.treeSha
  ) fail();

  writeOutput(`${JSON.stringify({
    command: "fetch-github-reviewed-pr-head",
    ok: true,
    skipped: false,
    candidateSha: identity.candidateSha,
    reviewedPrHeadSha: identity.reviewedPrHeadSha,
    reviewedPullRequestNumber: pull.number,
  })}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = await runGithubReviewedPrHeadFetch(process.argv.slice(2));
  } catch {
    process.stdout.write(`${JSON.stringify({
      command: "fetch-github-reviewed-pr-head",
      ok: false,
      failureCode: "reviewed_pr_head_fetch_invalid",
    })}\n`);
    process.exitCode = 1;
  }
}
