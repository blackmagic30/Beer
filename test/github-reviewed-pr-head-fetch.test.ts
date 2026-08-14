import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runGithubReviewedPrHeadFetch } from
  "../scripts/fetch-github-reviewed-pr-head.mjs";

const REPOSITORY = "blackmagic30/Beer";
const temporaryDirectories: string[] = [];

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Pint Path Test",
      GIT_AUTHOR_EMAIL: "test@pintpath.invalid",
      GIT_COMMITTER_NAME: "Pint Path Test",
      GIT_COMMITTER_EMAIL: "test@pintpath.invalid",
    },
  }).trim();
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-head-fetch-")));
  temporaryDirectories.push(root);
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  const clone = path.join(root, "candidate-only");
  fs.mkdirSync(source);
  git(root, ["init", "--bare", remote]);
  git(source, ["init", "--initial-branch=main"]);
  fs.writeFileSync(path.join(source, "app.txt"), "base\n");
  git(source, ["add", "app.txt"]);
  git(source, ["commit", "-m", "base"]);
  const base = git(source, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(source, "app.txt"), "reviewed\n");
  git(source, ["add", "app.txt"]);
  git(source, ["commit", "-m", "reviewed head"]);
  const reviewedPrHeadSha = git(source, ["rev-parse", "HEAD"]);
  const treeSha = git(source, ["rev-parse", "HEAD^{tree}"]);
  const candidateSha = git(
    source,
    ["commit-tree", treeSha, "-p", base],
    "authenticated squash merge\n",
  );
  git(source, ["update-ref", "refs/heads/main", candidateSha]);
  git(source, ["remote", "add", "origin", remote]);
  git(source, ["push", "origin", "refs/heads/main:refs/heads/main"]);
  git(source, ["push", "origin", `${reviewedPrHeadSha}:refs/pull/24/head`]);
  git(root, [
    "clone",
    "--no-local",
    "--single-branch",
    "--branch",
    "main",
    remote,
    clone,
  ]);

  const evidence = JSON.parse(fs.readFileSync(
    path.resolve("docs/release-evidence.json"),
    "utf8",
  )) as Record<string, any>;
  evidence.release = {
    id: "PP-LAUNCH-2026-FETCH",
    reviewedPrHeadSha,
    candidateSha,
    environment: "production",
  };
  const evidencePath = path.join(clone, "release-evidence.json");
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes(`/commits/${candidateSha}/pulls?`)) {
      return json([{
        number: 24,
        state: "closed",
        merge_commit_sha: candidateSha,
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: { repo: { full_name: REPOSITORY } },
      }]);
    }
    if (url.endsWith("/pulls/24")) {
      return json({
        number: 24,
        state: "closed",
        merged: true,
        draft: false,
        merge_commit_sha: candidateSha,
        merged_at: "2026-08-14T01:00:00.000Z",
        user: { id: 101 },
        merged_by: { id: 202 },
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: {
          sha: reviewedPrHeadSha,
          repo: { full_name: REPOSITORY },
        },
      });
    }
    if (url.includes("/pulls/24/reviews?")) {
      return json([{
        id: 303,
        user: { id: 303, login: "trusted-reviewer" },
        state: "APPROVED",
        commit_id: reviewedPrHeadSha,
        submitted_at: "2026-08-14T00:30:00.000Z",
        author_association: "MEMBER",
      }]);
    }
    if (url.endsWith("/collaborators/trusted-reviewer/permission")) {
      return json({
        permission: "write",
        user: { id: 303, login: "trusted-reviewer" },
      });
    }
    if (url.endsWith(`/git/commits/${candidateSha}`)) {
      return json({
        sha: candidateSha,
        tree: { sha: treeSha },
        parents: [{ sha: base }],
      });
    }
    if (url.endsWith(`/git/commits/${reviewedPrHeadSha}`)) {
      return json({
        sha: reviewedPrHeadSha,
        tree: { sha: treeSha },
        parents: [{ sha: base }],
      });
    }
    return new Response("not found", { status: 404 });
  });
  return {
    root,
    remote,
    clone,
    evidencePath,
    candidateSha,
    reviewedPrHeadSha,
    fetchImpl,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("authenticated reviewed PR-head fetch", () => {
  it("hydrates a deleted-branch squash head into a candidate-only clone", async () => {
    const value = fixture();
    const pathnameRead = vi.spyOn(fs, "readFileSync");
    const descriptorRead = vi.spyOn(fs, "readSync");
    expect(spawnSync(
      "git",
      ["cat-file", "-e", `${value.reviewedPrHeadSha}^{commit}`],
      { cwd: value.clone },
    ).status).not.toBe(0);
    expect(spawnSync(
      process.execPath,
      [path.resolve("scripts/validate-release-evidence.ts")],
      {
        cwd: value.clone,
        env: { ...process.env, RELEASE_EVIDENCE_PATH: value.evidencePath },
      },
    ).status).toBe(1);

    let summary = "";
    await expect(runGithubReviewedPrHeadFetch(
      ["--evidence", value.evidencePath],
      {
        cwd: value.clone,
        remote: value.remote,
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: REPOSITORY,
          GITHUB_TOKEN: "github-token-long-enough", // security-scan allow: synthetic no-call fixture
        },
        fetchImpl: value.fetchImpl,
        writeOutput: (source: string) => { summary += source; },
      },
    )).resolves.toBe(0);

    expect(
      pathnameRead.mock.calls.some(([filename]) => filename === value.evidencePath),
    ).toBe(false);
    expect(descriptorRead).toHaveBeenCalled();

    expect(JSON.parse(summary)).toMatchObject({
      ok: true,
      skipped: false,
      candidateSha: value.candidateSha,
      reviewedPrHeadSha: value.reviewedPrHeadSha,
      reviewedPullRequestNumber: 24,
    });
    expect(spawnSync(
      "git",
      ["merge-base", "--is-ancestor", value.reviewedPrHeadSha, value.candidateSha],
      { cwd: value.clone },
    ).status).not.toBe(0);
    expect(spawnSync(
      process.execPath,
      [path.resolve("scripts/validate-release-evidence.ts")],
      {
        cwd: value.clone,
        env: { ...process.env, RELEASE_EVIDENCE_PATH: value.evidencePath },
      },
    ).status).toBe(0);
  });

  it("rejects a pathname replacement after opening the evidence descriptor", async () => {
    const value = fixture();
    const displaced = `${value.evidencePath}.held`;
    const replacementSource = fs.readFileSync(value.evidencePath);
    const originalRealpath = fs.realpathSync.bind(fs);
    const originalFstat = fs.fstatSync.bind(fs);
    const close = vi.spyOn(fs, "closeSync");
    let evidenceDescriptor: number | undefined;
    vi.spyOn(fs, "fstatSync").mockImplementation(((descriptor, options) => {
      evidenceDescriptor ??= descriptor;
      return originalFstat(descriptor, options as never);
    }) as typeof fs.fstatSync);
    let replaced = false;
    vi.spyOn(fs, "realpathSync").mockImplementation(((filename, options) => {
      const result = originalRealpath(filename, options as never);
      if (filename === value.evidencePath && !replaced) {
        replaced = true;
        fs.renameSync(value.evidencePath, displaced);
        fs.writeFileSync(value.evidencePath, replacementSource);
      }
      return result;
    }) as typeof fs.realpathSync);

    await expect(runGithubReviewedPrHeadFetch(
      ["--evidence", value.evidencePath],
      {
        cwd: value.clone,
        remote: value.remote,
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: REPOSITORY,
          GITHUB_TOKEN: "github-token-long-enough", // security-scan allow: synthetic no-call fixture
        },
        fetchImpl: value.fetchImpl,
        writeOutput: () => undefined,
      },
    )).rejects.toThrow("reviewed_pr_head_fetch_invalid");
    expect(value.fetchImpl).not.toHaveBeenCalled();
    expect(evidenceDescriptor).toBeDefined();
    expect(close.mock.calls.filter(([descriptor]) => descriptor === evidenceDescriptor)).toHaveLength(1);
  });

  it("rejects in-place evidence drift after its descriptor read", async () => {
    const value = fixture();
    const originalFstat = fs.fstatSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "fstatSync").mockImplementation(((descriptor, options) => {
      calls += 1;
      if (calls === 2) fs.appendFileSync(value.evidencePath, " ");
      return originalFstat(descriptor, options as never);
    }) as typeof fs.fstatSync);

    await expect(runGithubReviewedPrHeadFetch(
      ["--evidence", value.evidencePath],
      {
        cwd: value.clone,
        remote: value.remote,
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: REPOSITORY,
          GITHUB_TOKEN: "github-token-long-enough", // security-scan allow: synthetic no-call fixture
        },
        fetchImpl: value.fetchImpl,
        writeOutput: () => undefined,
      },
    )).rejects.toThrow("reviewed_pr_head_fetch_invalid");
    expect(value.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a symlinked evidence leaf without querying GitHub", async () => {
    const value = fixture();
    const original = `${value.evidencePath}.original`;
    fs.renameSync(value.evidencePath, original);
    fs.symlinkSync(original, value.evidencePath);

    await expect(runGithubReviewedPrHeadFetch(
      ["--evidence", value.evidencePath],
      {
        cwd: value.clone,
        remote: value.remote,
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: REPOSITORY,
          GITHUB_TOKEN: "github-token-long-enough", // security-scan allow: synthetic no-call fixture
        },
        fetchImpl: value.fetchImpl,
        writeOutput: () => undefined,
      },
    )).rejects.toThrow("reviewed_pr_head_fetch_invalid");
    expect(value.fetchImpl).not.toHaveBeenCalled();
  });
});
