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
const REVIEWED_PR_HEAD = "b".repeat(40);
const REVIEWED_TREE = "c".repeat(40);
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

function mutationRun(input: {
  id: number;
  workflowPath: string;
  displayTitle: string;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  conclusion?: string | null;
  status?: string;
  runAttempt?: number;
}) {
  return {
    id: input.id,
    repository: { full_name: "blackmagic30/Beer" },
    head_repository: { full_name: "blackmagic30/Beer" },
    head_sha: CANDIDATE,
    head_branch: "main",
    path: `${input.workflowPath}@main`,
    event: "workflow_dispatch",
    display_title: input.displayTitle,
    run_attempt: input.runAttempt ?? 1,
    status: input.status ?? "completed",
    conclusion: input.conclusion === undefined ? "success" : input.conclusion,
    created_at: input.createdAt,
    run_started_at: input.startedAt,
    updated_at: input.updatedAt,
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
    associatedPullCount?: number;
    associatedPullPages?: Array<Array<Record<string, unknown>>>;
    pullMergeCommitSha?: string;
    pullHeadSha?: string;
    pullMerged?: boolean;
    pullDraft?: boolean;
    pullBaseRef?: string;
    pullBaseRepository?: string;
    pullHeadRepository?: string;
    pullAuthorId?: number;
    pullMergedById?: number;
    candidateTreeSha?: string;
    reviewedTreeSha?: string;
    candidateParentCount?: number;
    additionalStagingDeployments?: Array<{
      runId: number;
      startedAt: string;
      completedAt: string;
      runStartedAt: string;
    }>;
    providerMutationRuns?: Array<Record<string, unknown>>;
    runtimeMutationRuns?: Array<Record<string, unknown>>;
    workerFenceRuns?: Array<Record<string, unknown>>;
    stagingBootstrapRuns?: Array<Record<string, unknown>>;
    mutationJobs?: Record<number, unknown>;
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
  const runStartedAtById = new Map<number, string>();
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
        started_at: new Date(Date.UTC(2026, 7, 14, 1, runId - 100, 0)).toISOString(),
        completed_at: new Date(Date.UTC(
          2026,
          7,
          14,
          1,
          options.chronologyOverlapStage !== undefined &&
            options.chronologyOverlapStage === check.stage
            ? 59
            : runId - 100,
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
  const artifactRunByCheck = new Map(runByCheck);
  const defaultAdditionalStagingDeployments = requiredChecks.some((item) =>
      item.name === "Deploy permanent staging")
    ? [{
      runId: 900,
      runStartedAt: "2026-08-14T01:08:35.000Z",
      startedAt: "2026-08-14T01:08:40.000Z",
      completedAt: "2026-08-14T01:08:50.000Z",
    }]
    : [];
  for (const extra of
    options.additionalStagingDeployments ?? defaultAdditionalStagingDeployments) {
    const check = requiredChecks.find((item) => item.name === "Deploy permanent staging");
    if (!check) throw new Error("staging deployment fixture unavailable");
    runFixtures.set(extra.runId, check);
    runStartedAtById.set(extra.runId, extra.runStartedAt);
    artifactRunByCheck.set(check.name, extra.runId);
    checks.push({
      name: check.name,
      head_sha: CANDIDATE,
      status: "completed",
      conclusion: "success",
      started_at: extra.startedAt,
      completed_at: extra.completedAt,
      app: { slug: "github-actions" },
      check_suite: { id: extra.runId + 10_000 },
      details_url:
        `https://github.com/blackmagic30/Beer/actions/runs/${extra.runId}/job/1`,
    });
  }
  const hasStagingChain = requiredChecks.some((item) =>
    item.name === "Deploy permanent staging");
  const defaultWorkerFenceRuns = hasStagingChain
    ? [
      mutationRun({
        id: 710,
        workflowPath:
          ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
        displayTitle:
          `Automatic maintenance worker fence | permanent-staging | prepare | ${CANDIDATE}`,
        createdAt: "2026-08-14T01:01:00.000Z",
        startedAt: "2026-08-14T01:01:10.000Z",
        updatedAt: "2026-08-14T01:02:00.000Z",
      }),
      mutationRun({
        id: 713,
        workflowPath:
          ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
        displayTitle:
          `Automatic maintenance worker fence | permanent-staging | activate | ${CANDIDATE}`,
        createdAt: "2026-08-14T01:08:32.000Z",
        startedAt: "2026-08-14T01:08:33.000Z",
        updatedAt: "2026-08-14T01:08:34.000Z",
      }),
    ]
    : [];
  const defaultStagingBootstrapRuns = hasStagingChain
    ? [
      mutationRun({
        id: 711,
        workflowPath:
          ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
        displayTitle:
          `Permanent staging worker bootstrap | quiesce | ${CANDIDATE}`,
        createdAt: "2026-08-14T01:02:05.000Z",
        startedAt: "2026-08-14T01:02:10.000Z",
        updatedAt: "2026-08-14T01:03:00.000Z",
      }),
      mutationRun({
        id: 712,
        workflowPath:
          ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
        displayTitle:
          `Permanent staging worker bootstrap | restore | ${CANDIDATE}`,
        createdAt: "2026-08-14T01:08:30.500Z",
        startedAt: "2026-08-14T01:08:31.000Z",
        updatedAt: "2026-08-14T01:08:32.000Z",
      }),
    ]
    : [];
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes(`/commits/${CANDIDATE}/pulls?`)) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const pull = {
        number: 24,
        state: "closed",
        merge_commit_sha: options.pullMergeCommitSha ?? CANDIDATE,
        base: {
          ref: options.pullBaseRef ?? "main",
          repo: {
            full_name: options.pullBaseRepository ?? "blackmagic30/Beer",
          },
        },
        head: {
          repo: {
            full_name: options.pullHeadRepository ?? "blackmagic30/Beer",
          },
        },
      };
      return jsonResponse(options.associatedPullPages?.[page - 1] ??
        (page === 1
          ? Array.from(
              { length: options.associatedPullCount ?? 1 },
              (_, index) => ({ ...pull, number: 24 + index }),
            )
          : []));
    }
    if (url.endsWith("/pulls/24")) {
      return jsonResponse({
        number: 24,
        state: "closed",
        merged: options.pullMerged ?? true,
        draft: options.pullDraft ?? false,
        merge_commit_sha: options.pullMergeCommitSha ?? CANDIDATE,
        merged_at: "2026-08-14T01:00:00.000Z",
        user: { id: options.pullAuthorId ?? 101 },
        merged_by: { id: options.pullMergedById ?? 202 },
        base: {
          ref: options.pullBaseRef ?? "main",
          repo: {
            full_name: options.pullBaseRepository ?? "blackmagic30/Beer",
          },
        },
        head: {
          sha: options.pullHeadSha ?? REVIEWED_PR_HEAD,
          repo: {
            full_name: options.pullHeadRepository ?? "blackmagic30/Beer",
          },
        },
      });
    }
    if (url.endsWith(`/git/commits/${CANDIDATE}`)) {
      return jsonResponse({
        sha: CANDIDATE,
        tree: { sha: options.candidateTreeSha ?? REVIEWED_TREE },
        parents: Array.from(
          { length: options.candidateParentCount ?? 1 },
          (_, index) => ({ sha: String(index + 1).repeat(40) }),
        ),
      });
    }
    if (url.endsWith(`/git/commits/${options.pullHeadSha ?? REVIEWED_PR_HEAD}`)) {
      return jsonResponse({
        sha: options.pullHeadSha ?? REVIEWED_PR_HEAD,
        tree: { sha: options.reviewedTreeSha ?? REVIEWED_TREE },
        parents: [{ sha: "d".repeat(40) }],
      });
    }
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
    if (url.includes(
      "/actions/workflows/permanent-staging-provider-mutation.yml/runs?",
    )) {
      const workflowRuns = options.providerMutationRuns ?? [];
      return jsonResponse({
        total_count: workflowRuns.length,
        workflow_runs: workflowRuns,
      });
    }
    if (url.includes("/actions/workflows/configure-runtime-variable.yml/runs?")) {
      const workflowRuns = options.runtimeMutationRuns ?? [];
      return jsonResponse({
        total_count: workflowRuns.length,
        workflow_runs: workflowRuns,
      });
    }
    if (url.includes(
      "/actions/workflows/configure-automatic-maintenance-worker-fence.yml/runs?",
    )) {
      const workflowRuns = options.workerFenceRuns ?? defaultWorkerFenceRuns;
      return jsonResponse({
        total_count: workflowRuns.length,
        workflow_runs: workflowRuns,
      });
    }
    if (url.includes(
      "/actions/workflows/bootstrap-permanent-staging-worker-fence.yml/runs?",
    )) {
      const workflowRuns = options.stagingBootstrapRuns ??
        defaultStagingBootstrapRuns;
      return jsonResponse({
        total_count: workflowRuns.length,
        workflow_runs: workflowRuns,
      });
    }
    const jobsMatch = /\/actions\/runs\/(\d+)\/jobs\?/.exec(url);
    if (jobsMatch) {
      return jsonResponse(options.mutationJobs?.[Number(jobsMatch[1])] ?? {
        total_count: 0,
        jobs: [],
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
        .filter((item) => artifactRunByCheck.get(item.producerCheck) === runId)
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
      run_started_at: runStartedAtById.get(runId) ??
        new Date(Date.UTC(2026, 7, 14, 1, runId - 100, 0)).toISOString(),
      display_title: runFixture.name === "Deploy permanent staging"
        ? runId === artifactRunByCheck.get(runFixture.name)
          ? `Deploy permanent staging | active | ${CANDIDATE}`
          : `Deploy permanent staging | fenced | ${CANDIDATE}`
        : runFixture.name,
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
      expect(code, `${phase}:${summary}`).toBe(0);
      expect(JSON.parse(summary)).toMatchObject({ ok: true, phase });
      const receipt = JSON.parse(
        fs.readFileSync(path.join(fixture.directory, "receipt.json"), "utf8"),
      );
      expect(receipt).toMatchObject({
        schemaVersion: "pintpath-github-release-candidate-receipt/v5",
        phase,
        candidateSha: CANDIDATE,
        reviewedPullRequest: {
          number: 24,
          reviewedPrHeadSha: REVIEWED_PR_HEAD,
          mergeCommitSha: CANDIDATE,
          treeSha: REVIEWED_TREE,
          githubMergeExact: true,
          reviewedTreeExact: true,
          pullRequestApprovalRequirement: "not_required",
          pullRequestApprovalRequirementExact: true,
          linearHistoryExact: true,
        },
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
      expect(Object.keys(receipt.reviewedPullRequest)).toEqual([
        "number",
        "reviewedPrHeadSha",
        "mergeCommitSha",
        "treeSha",
        "mergedAt",
        "authorId",
        "mergedById",
        "githubMergeExact",
        "reviewedTreeExact",
        "pullRequestApprovalRequirement",
        "pullRequestApprovalRequirementExact",
        "linearHistoryExact",
      ]);
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

  it("accepts an authenticated squash merge whose reviewed PR head is not an ancestor", async () => {
    const fixture = harness();
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
    expect(fixture.fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/git/commits/${REVIEWED_PR_HEAD}`),
      expect.anything(),
    );
  });

  it("paginates public associated-PR decoys and requires one exact merged PR", async () => {
    const exact = (number: number) => ({
      number,
      state: "closed",
      merge_commit_sha: CANDIDATE,
      base: { ref: "main", repo: { full_name: "blackmagic30/Beer" } },
      head: { repo: { full_name: "blackmagic30/Beer" } },
    });
    const decoys = Array.from({ length: 100 }, (_, index) => ({
      ...exact(1_000 + index),
      head: { repo: { full_name: `fork-${index}/Beer` } },
    }));
    const fixture = harness({ associatedPullPages: [decoys, [exact(24)]] });
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
    expect(fixture.fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/commits/${CANDIDATE}/pulls?per_page=100&page=2`),
      expect.anything(),
    );

    const duplicate = harness({
      associatedPullPages: [decoys, [exact(24), exact(25)]],
    });
    let summary = "";
    const duplicateCode = await runGithubReleaseCandidateVerification(
      duplicate.argv,
      {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: CANDIDATE,
          GITHUB_REPOSITORY: "blackmagic30/Beer",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "9999",
          GITHUB_TOKEN: "g".repeat(32),
        },
        fetchImpl: duplicate.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      },
    );
    expect(duplicateCode).toBe(1);
    expect(JSON.parse(summary)).toMatchObject({
      ok: false,
      failureCode: "reviewed_pull_request_invalid",
    });
  });

  it("selects the latest unambiguous staging deployment before scale", async () => {
    const fixture = harness({
      additionalStagingDeployments: [{
        runId: 900,
        runStartedAt: "2026-08-14T01:08:35.000Z",
        startedAt: "2026-08-14T01:08:40.000Z",
        completedAt: "2026-08-14T01:08:50.000Z",
      }],
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
    expect(receipt.checks).toContainEqual(expect.objectContaining({
      name: "Deploy permanent staging",
      runId: 900,
    }));
    expect(receipt.artifacts).toContainEqual(expect.objectContaining({
      name: `pintpath-permanent-staging-deployment-${CANDIDATE}`,
      runId: 900,
    }));
  });

  it("rejects a same-candidate staging deployment that overlaps or follows scale", async () => {
    for (const additionalStagingDeployment of [
      {
        runId: 900,
        runStartedAt: "2026-08-14T01:08:55.000Z",
        startedAt: "2026-08-14T01:08:59.000Z",
        completedAt: "2026-08-14T01:09:10.000Z",
      },
      {
        runId: 901,
        runStartedAt: "2026-08-14T01:09:05.000Z",
        startedAt: "2026-08-14T01:09:10.000Z",
        completedAt: "2026-08-14T01:09:20.000Z",
      },
    ]) {
      const fixture = harness({
        additionalStagingDeployments: [additionalStagingDeployment],
      });
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
        writeOutput: (value: string) => { summary += value; },
      });
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "required_check_invalid",
      });
    }
  });

  it("requires exactly the initial and closeout staging deployments", async () => {
    const cases = [
      harness({ additionalStagingDeployments: [] }),
      harness({
        additionalStagingDeployments: [
          {
            runId: 900,
            runStartedAt: "2026-08-14T01:08:35.000Z",
            startedAt: "2026-08-14T01:08:40.000Z",
            completedAt: "2026-08-14T01:08:50.000Z",
          },
          {
            runId: 901,
            runStartedAt: "2026-08-14T01:08:51.000Z",
            startedAt: "2026-08-14T01:08:52.000Z",
            completedAt: "2026-08-14T01:08:55.000Z",
          },
        ],
      }),
      harness({
        additionalStagingDeployments: [{
          runId: 900,
          runStartedAt: "2026-08-14T01:08:20.000Z",
          startedAt: "2026-08-14T01:08:25.000Z",
          completedAt: "2026-08-14T01:08:30.000Z",
        }],
      }),
    ];
    for (const fixture of cases) {
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
        writeOutput: (value: string) => { summary += value; },
      });
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "required_check_invalid",
      });
    }
  });

  it("rejects provider or staging-runtime writes not sealed by deployment two", async () => {
    const closeoutStartedAt = "2026-08-14T01:08:40.000Z";
    const provider = mutationRun({
      id: 700,
      workflowPath:
        ".github/workflows/permanent-staging-provider-mutation.yml",
      displayTitle:
        `Permanent staging provider mutation | provider-openai-api-key | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:08:35.000Z",
      startedAt: "2026-08-14T01:08:36.000Z",
      updatedAt: closeoutStartedAt,
    });
    const runtime = mutationRun({
      id: 701,
      workflowPath: ".github/workflows/configure-runtime-variable.yml",
      displayTitle:
        `Configure runtime variable | permanent-staging | SUPABASE_URL | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:08:35.000Z",
      startedAt: "2026-08-14T01:08:36.000Z",
      updatedAt: "2026-08-14T01:08:45.000Z",
    });
    for (const fixture of [
      harness({ providerMutationRuns: [provider] }),
      harness({ runtimeMutationRuns: [runtime] }),
    ]) {
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
        writeOutput: (value: string) => { summary += value; },
      });
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "staging_mutation_after_closeout_deployment",
      });
    }

    const unrelatedProduction = mutationRun({
      id: 702,
      workflowPath: ".github/workflows/configure-runtime-variable.yml",
      displayTitle:
        `Configure runtime variable | production | SUPABASE_URL | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:08:35.000Z",
      startedAt: "2026-08-14T01:08:36.000Z",
      updatedAt: "2026-08-14T01:08:45.000Z",
      status: "in_progress",
      conclusion: null,
      runAttempt: 2,
    });
    const allowed = harness({ runtimeMutationRuns: [unrelatedProduction] });
    await expect(runGithubReleaseCandidateVerification(allowed.argv, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: CANDIDATE,
        GITHUB_REPOSITORY: "blackmagic30/Beer",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "9999",
        GITHUB_TOKEN: "g".repeat(32),
      },
      fetchImpl: allowed.fetchImpl,
      writeOutput: () => undefined,
    })).resolves.toBe(0);
  });

  it("requires the complete candidate-bound staging worker bootstrap history", async () => {
    for (const fixture of [
      harness({ workerFenceRuns: [] }),
      harness({ stagingBootstrapRuns: [] }),
    ]) {
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
        writeOutput: (value: string) => { summary += value; },
      });
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "staging_bootstrap_history_invalid",
      });
    }
  });

  it("rejects a merge without exact GitHub PR, linear-history, tree, and identity binding", async () => {
    for (const fixture of [
      harness({ associatedPullCount: 0 }),
      harness({ pullMergeCommitSha: "e".repeat(40) }),
      harness({ pullMerged: false }),
      harness({ pullDraft: true }),
      harness({ pullBaseRef: "develop" }),
      harness({ pullBaseRepository: "other/Beer" }),
      harness({ pullHeadRepository: "fork/Beer" }),
      harness({ pullHeadSha: "invalid" }),
      harness({ pullAuthorId: 0 }),
      harness({ pullMergedById: 0 }),
      harness({ candidateParentCount: 2 }),
      harness({ reviewedTreeSha: "e".repeat(40) }),
    ]) {
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
        writeOutput: (value: string) => { summary += value; },
      });
      expect(code).toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "reviewed_pull_request_invalid",
      });
    }
  });

  it("accepts a merged solo-owner PR without querying reviews or collaborators", async () => {
    const fixture = harness();
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
    const requestedUrls = fixture.fetchImpl.mock.calls.map(([url]) => String(url));
    expect(requestedUrls.some((url) => url.includes("/reviews"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("/collaborators/"))).toBe(false);
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
