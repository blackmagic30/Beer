import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseGithubReleaseChecksPolicy,
  runGithubReleaseCandidateVerification,
} from "../scripts/verify-github-release-candidate.mjs";

const CANDIDATE = "a".repeat(40);
const POLICY = fs.readFileSync(
  path.resolve(".github/release-required-checks.json"),
  "utf8",
);
const temporaryDirectories: string[] = [];

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function artifact(name: string, runId: number) {
  const artifactId = runId * 100;
  return {
    id: artifactId,
    name,
    expired: false,
    size_in_bytes: 100,
    digest: `sha256:${crypto.createHash("sha256").update(name).digest("hex")}`,
    archive_download_url:
      `https://api.github.com/repos/blackmagic30/Beer/actions/artifacts/${artifactId}/zip`,
    workflow_run: { id: runId, head_sha: CANDIDATE },
  };
}

function harness(
  options: {
    phase?: "staging" | "production" | "close" | "activation" | "promotion-recovery" | "open" | "release";
    omitCheck?: string;
    omitArtifact?: string;
    duplicateCheck?: string;
    additionalWrongIdentityCheck?: string;
    wrongEventOnlyCheck?: string;
    wrongWorkflowOnlyCheck?: string;
    untrustedDuplicateCheck?: string;
    chronologyOverlapStage?: string;
    currentWorkflowPath?: string;
    currentEvent?: "push" | "workflow_dispatch";
    currentRunAttempt?: number;
    currentRunId?: number;
    predecessorRunAttempt?: number;
  } = {},
) {
  type RequiredCheck = {
    stage?: string;
    name: string;
    workflowPath: string;
    event: "push" | "workflow_dispatch";
  };
  type RequiredArtifact = {
    stage?: string;
    name: string;
    producerCheck: string;
  };
  const policy = JSON.parse(POLICY) as {
    phaseConsumers: Record<string, { workflowPath: string; event: "workflow_dispatch" }>;
    requiredChecks: Record<string, RequiredCheck[]>;
    requiredArtifacts: Record<string, RequiredArtifact[]>;
  };
  const phase = options.phase ?? "release";
  const requiredChecks = [...policy.requiredChecks.base];
  const artifactRequirements = [...policy.requiredArtifacts.base];
  if (phase !== "staging") {
    requiredChecks.push(...policy.requiredChecks.staging);
    artifactRequirements.push(...policy.requiredArtifacts.staging);
  }
  const stageCounts = {
    staging: 0,
    production: 0,
    close: 2,
    activation: 3,
    "promotion-recovery": 4,
    open: 5,
    release: 6,
  };
  requiredChecks.push(...policy.requiredChecks.production.slice(0, stageCounts[phase]));
  artifactRequirements.push(
    ...policy.requiredArtifacts.production.slice(0, stageCounts[phase]),
  );
  const expandedArtifacts = artifactRequirements.map((item) => ({
    ...item,
    name: item.name.replaceAll("{candidateSha}", CANDIDATE),
  }));
  const runByCheck = new Map(
    requiredChecks.map((check, index) => [check.name, index + 100]),
  );
  const runFixtures = new Map<number, RequiredCheck>();
  const checks = requiredChecks
    .filter((check) => check.name !== options.omitCheck)
    .flatMap((check) => {
      const runId = runByCheck.get(check.name)!;
      runFixtures.set(runId, {
        ...check,
        event:
          options.wrongEventOnlyCheck === check.name
            ? check.event === "push"
              ? "workflow_dispatch"
              : "push"
            : check.event,
        workflowPath:
          options.wrongWorkflowOnlyCheck === check.name
            ? ".github/workflows/venue-directory-refresh.yml"
            : check.workflowPath,
      });
      const value = {
        name: check.name,
        head_sha: CANDIDATE,
        status: "completed",
        conclusion: "success",
        started_at: new Date(Date.UTC(2026, 7, 14, 0, runId - 100, 0)).toISOString(),
        completed_at: new Date(Date.UTC(
          2026,
          7,
          14,
          0,
          options.chronologyOverlapStage === check.stage ? 59 : runId - 100,
          30,
        )).toISOString(),
        app: { slug: "github-actions" },
        check_suite: { id: runId + 10_000 },
        details_url: `https://github.com/blackmagic30/Beer/actions/runs/${runId}/job/1`,
      };
      const values =
        options.duplicateCheck === check.name ? [value, { ...value }] : [value];
      if (options.additionalWrongIdentityCheck === check.name) {
        const shadowRunId = runId + 1_000;
        runFixtures.set(shadowRunId, {
          ...check,
          event: check.event === "push" ? "workflow_dispatch" : "push",
          workflowPath: ".github/workflows/venue-directory-refresh.yml",
        });
        values.push({
          ...value,
          check_suite: { id: shadowRunId + 10_000 },
          details_url: `https://github.com/blackmagic30/Beer/actions/runs/${shadowRunId}/job/1`,
        });
      }
      if (options.untrustedDuplicateCheck === check.name) {
        values.push({ ...value, app: { slug: "untrusted-check-app" } });
      }
      return values;
    });
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/check-runs?")) {
      const requestedName = new URL(url).searchParams.get("check_name");
      const matchingChecks = checks.filter(
        (check) => check.name === requestedName,
      );
      return jsonResponse({
        total_count: matchingChecks.length,
        check_runs: matchingChecks,
      });
    }
    const runMatch = /\/actions\/runs\/(\d+)(?:\/artifacts)?/.exec(url);
    if (!runMatch) return new Response("", { status: 404 });
    const runId = Number(runMatch[1]);
    if (runId === 9_999) {
      const consumer = policy.phaseConsumers[phase];
      return jsonResponse({
        id: options.currentRunId ?? runId,
        head_sha: CANDIDATE,
        head_branch: "main",
        event: options.currentEvent ?? consumer.event,
        path: options.currentWorkflowPath ?? consumer.workflowPath,
        workflow_id: 29_999,
        run_attempt: options.currentRunAttempt ?? 1,
        run_started_at: "2026-08-14T02:00:00.000Z",
        status: "in_progress",
        conclusion: null,
        repository: { full_name: "blackmagic30/Beer" },
        head_repository: { full_name: "blackmagic30/Beer" },
      });
    }
    if (url.includes("/artifacts?")) {
      const values = expandedArtifacts
        .filter((item) => item.name !== options.omitArtifact)
        .filter((item) => runByCheck.get(item.producerCheck) === runId)
        .map((item) => artifact(item.name, runId));
      return jsonResponse({ total_count: values.length, artifacts: values });
    }
    const runFixture = runFixtures.get(runId);
    if (!runFixture) return new Response("", { status: 404 });
    return jsonResponse({
      id: runId,
      check_suite_id: runId + 10_000,
      head_sha: CANDIDATE,
      head_branch: "main",
      event: runFixture.event,
      path: runFixture.workflowPath,
      workflow_id: runId + 20_000,
      run_attempt: options.predecessorRunAttempt ?? 1,
      run_started_at: new Date(Date.UTC(2026, 7, 14, 0, runId - 100, 0)).toISOString(),
      status: "completed",
      conclusion: "success",
      repository: { full_name: "blackmagic30/Beer" },
      head_repository: { full_name: "blackmagic30/Beer" },
    });
  });
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "github-gate-test-")),
  );
  temporaryDirectories.push(directory);
  fs.chmodSync(directory, 0o700);
  return {
    argv: [
      "--candidate-sha",
      CANDIDATE,
      "--phase",
      phase,
      "--output",
      path.join(directory, "receipt.json"),
    ],
    directory,
    fetchImpl,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("GitHub release-candidate verifier", () => {
  it("accepts only the canonical current check/artifact policy", () => {
    expect(parseGithubReleaseChecksPolicy(POLICY)).not.toBeNull();
    expect(parseGithubReleaseChecksPolicy(POLICY.trimEnd())).toBeNull();
    expect(parseGithubReleaseChecksPolicy(`${POLICY}\n`)).toBeNull();
    expect(
      parseGithubReleaseChecksPolicy(
        POLICY.replace('"branch": "main"', '"branch": "develop"'),
      ),
    ).toBeNull();
    expect(
      parseGithubReleaseChecksPolicy(
        POLICY.replace('"event": "push"', '"event": "pull_request"'),
      ),
    ).toBeNull();
    expect(
      parseGithubReleaseChecksPolicy(
        POLICY.replace(
          '"workflowPath": ".github/workflows/ci.yml"',
          '"workflowPath": "../ci.yml"',
        ),
      ),
    ).toBeNull();
  });

  it("verifies successful same-SHA checks and artifacts for every phase", async () => {
    for (const phase of [
      "staging",
      "production",
      "close",
      "activation",
      "promotion-recovery",
      "open",
      "release",
    ] as const) {
      const fixture = harness({ phase });
      let summary = "";
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => {
          summary += value;
        },
      });
      expect(code, phase).toBe(0);
      expect(JSON.parse(summary)).toMatchObject({ ok: true, phase });
      const receipt = JSON.parse(
        fs.readFileSync(path.join(fixture.directory, "receipt.json"), "utf8"),
      );
      expect(receipt).toMatchObject({
        schemaVersion: "pintpath-github-release-candidate-receipt/v3",
        phase,
        candidateSha: CANDIDATE,
        consumer: {
          runId: 9_999,
          workflowPath: expect.stringContaining(".github/workflows/"),
          runAttempt: 1,
        },
        requiredChecksExact: true,
        requiredArtifactsExact: true,
        chronologyExact: true,
        currentConsumerExact: true,
      });
      expect(receipt.checks).toContainEqual(
        expect.objectContaining({
          name: "ios",
          workflowPath: ".github/workflows/native-apps.yml",
          event: "push",
          runAttempt: 1,
        }),
      );
      for (const request of fixture.fetchImpl.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes("/check-runs?"))) {
        expect(request).toContain("filter=all");
        expect(request).toContain("check_name=");
        expect(request).not.toContain("filter=latest");
      }
    }
  });

  it("selects only the check from the policy-bound workflow and event", async () => {
    const fixture = harness({
      phase: "staging",
      additionalWrongIdentityCheck: "ios",
    });
    const code = await runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: () => undefined,
    });
    expect(code).toBe(0);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(fixture.directory, "receipt.json"), "utf8"),
    );
    expect(
      receipt.checks.filter((check: { name: string }) => check.name === "ios"),
    ).toEqual([
      expect.objectContaining({
        workflowPath: ".github/workflows/native-apps.yml",
        event: "push",
      }),
    ]);
  });

  it("fails closed for missing, duplicated, spoofed, or misbound checks and missing artifacts", async () => {
    for (const fixture of [
      harness({ omitCheck: "build-test-scan" }),
      harness({ duplicateCheck: "build-test-scan" }),
      harness({ wrongEventOnlyCheck: "ios" }),
      harness({ wrongWorkflowOnlyCheck: "ios" }),
      harness({ untrustedDuplicateCheck: "ios" }),
      harness({ omitArtifact: `pintpath-production-deployment-${CANDIDATE}` }),
    ]) {
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: () => undefined,
      });
      expect(code).toBe(1);
      expect(fs.existsSync(path.join(fixture.directory, "receipt.json"))).toBe(
        false,
      );
    }
  });

  it("rejects an out-of-order rollout, a rerun predecessor, or the wrong current consumer", async () => {
    for (const fixture of [
      harness({ phase: "open", chronologyOverlapStage: "scale" }),
      harness({ phase: "close", predecessorRunAttempt: 2 }),
      harness({
        phase: "open",
        currentWorkflowPath: ".github/workflows/close-production-route.yml",
      }),
      harness({ phase: "open", currentEvent: "push" }),
      harness({ phase: "open", currentRunAttempt: 2 }),
      harness({ phase: "open", currentRunId: 9_998 }),
    ]) {
      const code = await runGithubReleaseCandidateVerification(fixture.argv, {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: fixture.fetchImpl,
        writeOutput: () => undefined,
      });
      expect(code).toBe(1);
      expect(fs.existsSync(path.join(fixture.directory, "receipt.json"))).toBe(false);
    }
  });

  it("rejects local, stale-ref, or wrong-candidate GitHub contexts before querying", async () => {
    const fixture = harness({ phase: "staging" });
    const code = await runGithubReleaseCandidateVerification(fixture.argv, {
      env: {
        GITHUB_ACTIONS: "false",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: fixture.fetchImpl,
      writeOutput: () => undefined,
    });
    expect(code).toBe(1);
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });
});
