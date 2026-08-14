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
const O_NOFOLLOW = fs.constants.O_NOFOLLOW;
const O_NONBLOCK = fs.constants.O_NONBLOCK;

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
  let descriptor = null;
  let bytes = null;
  let value;
  try {
    if (
      !Number.isSafeInteger(O_NOFOLLOW) ||
      O_NOFOLLOW <= 0 ||
      !Number.isSafeInteger(O_NONBLOCK) ||
      O_NONBLOCK <= 0
    ) fail();
    descriptor = fs.openSync(
      filename,
      fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    const beforePath = fs.lstatSync(filename, { bigint: true });
    if (
      !before.isFile() ||
      !beforePath.isFile() ||
      beforePath.isSymbolicLink() ||
      before.size < 1n ||
      before.size > BigInt(MAX_EVIDENCE_BYTES) ||
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino ||
      before.mode !== beforePath.mode ||
      before.nlink !== 1n ||
      beforePath.nlink !== 1n ||
      before.uid !== beforePath.uid ||
      before.gid !== beforePath.gid ||
      fs.realpathSync(filename) !== filename
    ) fail();

    bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) fail();
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(filename, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mode !== before.mode ||
      after.nlink !== before.nlink ||
      after.uid !== before.uid ||
      after.gid !== before.gid ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      afterPath.dev !== before.dev ||
      afterPath.ino !== before.ino ||
      afterPath.size !== before.size ||
      afterPath.mode !== before.mode ||
      afterPath.nlink !== before.nlink ||
      afterPath.uid !== before.uid ||
      afterPath.gid !== before.gid ||
      afterPath.mtimeNs !== before.mtimeNs ||
      afterPath.ctimeNs !== before.ctimeNs ||
      fs.realpathSync(filename) !== filename
    ) fail();

    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.includes("\0") || Buffer.byteLength(source, "utf8") !== bytes.length) {
      fail();
    }
    value = JSON.parse(source);
  } catch {
    fail();
  } finally {
    bytes?.fill(0);
    if (descriptor !== null) fs.closeSync(descriptor);
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
