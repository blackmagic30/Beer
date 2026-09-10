import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertBarPilotPreviousCandidateAncestor,
  barPilotPreviousCandidateSha,
} from "../scripts/lib/bar-pilot-healthy-rollout.js";

const candidate = "a".repeat(40);
const previous = "b".repeat(40);
const currentId = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("healthy bar pilot candidate succession", () => {
  it("defaults to same-candidate enablement and requires an explicit healthy deployment pair", () => {
    expect(barPilotPreviousCandidateSha({}, candidate)).toBe(candidate);
    expect(barPilotPreviousCandidateSha({ PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID: currentId }, candidate)).toBe(candidate);
    expect(barPilotPreviousCandidateSha({ PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID: currentId,
      PINTPATH_BAR_PILOT_PREVIOUS_CANDIDATE_SHA: previous }, candidate)).toBe(previous);
  });
  it.each([
    { PINTPATH_BAR_PILOT_PREVIOUS_CANDIDATE_SHA: previous },
    { PINTPATH_BAR_PILOT_PREVIOUS_CANDIDATE_SHA: "HEAD~1", PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID: currentId },
    { PINTPATH_BAR_PILOT_PREVIOUS_CANDIDATE_SHA: previous.toUpperCase(), PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID: currentId },
    { PINTPATH_BAR_PILOT_PREVIOUS_CANDIDATE_SHA: previous, PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID: "invalid" },
    { PINTPATH_BAR_PILOT_PREVIOUS_CANDIDATE_SHA: previous, PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID: currentId,
      PINTPATH_BAR_PILOT_RECOVER_FAILED_STARTUP: "true" },
  ])("rejects malformed, unpaired or combined recovery input: %j", (env) => {
    expect(() => barPilotPreviousCandidateSha(env, candidate)).toThrow();
  });
  it("uses actual Git ancestry and rejects foreign branches, missing commits and tag objects", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pilot-rollout-git-")));
    roots.push(root);
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: {
        ...process.env, GIT_AUTHOR_NAME: "Pilot fixture", GIT_COMMITTER_NAME: "Pilot fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      } });
      if (result.status !== 0) throw new Error("fixture git operation failed");
      return result.stdout.trim();
    };
    git("init", "--initial-branch=main");
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "successor");
    const successor = git("rev-parse", "HEAD");
    git("checkout", "-b", "foreign", base);
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "foreign");
    const foreign = git("rev-parse", "HEAD");
    git("-c", "tag.gpgsign=false", "tag", "-a", "base-tag", base, "-m", "tag object");
    const tag = git("rev-parse", "base-tag");
    expect(() => assertBarPilotPreviousCandidateAncestor(root, base, successor)).not.toThrow();
    expect(() => assertBarPilotPreviousCandidateAncestor(root, successor, successor)).not.toThrow();
    for (const invalid of [foreign, "f".repeat(40), tag, "HEAD~1"]) {
      expect(() => assertBarPilotPreviousCandidateAncestor(root, invalid, successor)).toThrow("source_authority_failed");
    }
    expect(() => assertBarPilotPreviousCandidateAncestor(root, successor, base)).toThrow("source_authority_failed");
  });
});
