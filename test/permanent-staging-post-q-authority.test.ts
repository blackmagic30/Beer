import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  POST_Q_ARTIFACT_MEMBERS,
  POST_Q_REVIEWED_CANDIDATE_SCHEMA,
  qArtifactExact,
  qJobsExact,
  qRunExact,
  sealPostQArtifact,
  verifyPostQReviewedCandidate,
  verifyPermanentStagingPostQAuthority,
} from "../scripts/verify-permanent-staging-post-q-authority.mjs";

const CANDIDATE = "a".repeat(40);
const CURRENT_RUN_ID = "34240000000";
const Q_SHA = "606d33facb515dd10bc94c360e43c20beb999cc1";
const Q_TITLE = `Permanent staging cold recovery | quiesce | ${Q_SHA}`;
const TOKEN = "github-test-token-with-safe-length";
const REVIEWED_HEAD = "c".repeat(40);
const REVIEWED_TREE = "d".repeat(40);
const temporaryDirectories: string[] = [];

function qRun() {
  return {
    id: 34229745722,
    workflow_id: 344383802,
    run_number: 13,
    run_attempt: 1,
    name: Q_TITLE,
    display_title: Q_TITLE,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    head_sha: Q_SHA,
    path: ".github/workflows/recover-permanent-staging-cold-zero.yml",
    created_at: "2026-09-08T13:04:29Z",
    run_started_at: "2026-09-08T13:04:29Z",
    updated_at: "2026-09-08T13:10:47Z",
    repository: { id: 1215862300, full_name: "blackmagic30/Beer" },
  };
}

const targetStepRows = [
  [1, "Set up job", "success"],
  [2, "Checkout the exact candidate without persisted credentials", "success"],
  [3, "Require exact cold quiesce authority", "success"],
  [4, "Setup the repository Node runtime", "success"],
  [5, "Install immutable dependencies", "success"],
  [6, "Run the complete repository gate before provider-token custody", "success"],
  [7, "Create private prerequisite and evidence custody", "success"],
  [8, "Authenticate the reviewed candidate and fresh cold quiesce dispatch", "success"],
  [9, "Retrieve the immediate prior quiesce artifact", "success"],
  [10, "Seal the exact immediate prior evidence bundle", "success"],
  [11, "Retrieve the exact failed-prewrite direct-predecessor artifact", "success"],
  [12, "Seal the exact failed-prewrite evidence bundle", "success"],
  [13, "Retrieve the pinned legacy quiesce artifact", "success"],
  [14, "Seal the exact legacy evidence bundle", "success"],
  [15, "Retrieve the exact cold prepare artifact", "success"],
  [16, "Seal and authenticate the exact cold prepare receipt", "success"],
  [17, "Bind the ambiguous predecessor to configured live topology", "success"],
  [18, "Quiesce the configured Europe replica from one to zero once", "failure"],
  [19, "Remove legacy artifact custody", "success"],
  [20, "Remove immediate prior, failed-prewrite, and prepare artifact custody", "success"],
  [21, "Reconcile the Railway production-staging mutation boundary", "success"],
  [22, "Upload bounded cold quiesce evidence", "success"],
  [43, "Post Setup the repository Node runtime", "skipped"],
  [44, "Post Checkout the exact candidate without persisted credentials", "success"],
  [45, "Complete job", "success"],
] as const;

function targetSteps() {
  return targetStepRows.map(([number, name, conclusion], index) => ({
    number,
    name,
    status: "completed",
    conclusion,
    started_at: index === 16
      ? "2026-09-08T13:08:52Z"
      : index === 17
      ? "2026-09-08T13:08:57Z"
      : index === 20 || index === 21
      ? "2026-09-08T13:10:42Z"
      : "2026-09-08T13:04:35Z",
    completed_at: index === 16
      ? "2026-09-08T13:08:57Z"
      : index === 17 || index === 20
      ? "2026-09-08T13:10:42Z"
      : index === 21
      ? "2026-09-08T13:10:43Z"
      : "2026-09-08T13:04:36Z",
  }));
}

function qJobs() {
  return {
    total_count: 4,
    jobs: [
      {
        id: 102072625320,
        name: "Quiesce the configured Europe replica from one to zero",
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        started_at: "2026-09-08T13:04:34Z",
        completed_at: "2026-09-08T13:10:46Z",
        steps: targetSteps(),
      },
      {
        id: 102072626482,
        name: "Bind the exact replacement and prepare the dead baseline",
        run_attempt: 1,
        status: "completed",
        conclusion: "skipped",
        steps: [],
      },
      {
        id: 102072626886,
        name: "Reconcile an ambiguous cold prepare at the exact dead baseline",
        run_attempt: 1,
        status: "completed",
        conclusion: "skipped",
        steps: [],
      },
      {
        id: 102072656578,
        name: "Reconcile an ambiguous cold quiesce at exact zero",
        run_attempt: 1,
        status: "completed",
        conclusion: "skipped",
        steps: [],
      },
    ],
  };
}

function qArtifact() {
  return {
    id: 10057495901,
    name: `pintpath-permanent-staging-cold-quiesce-${Q_SHA}`,
    size_in_bytes: 12561,
    digest:
      "sha256:32a404cdd7078dc04d4b2531deec460dd4f44b4309fe35d873c8bcd46a367c4b",
    expired: false,
    created_at: "2026-09-08T13:10:43Z",
    updated_at: "2026-09-08T13:10:43Z",
    expires_at: "2026-10-08T13:10:42Z",
    workflow_run: {
      id: 34229745722,
      repository_id: 1215862300,
      head_repository_id: 1215862300,
      head_branch: "main",
      head_sha: Q_SHA,
    },
  };
}

function containmentRun(overrides: Record<string, unknown> = {}) {
  return {
    id: Number(CURRENT_RUN_ID),
    workflow_id: 400000001,
    run_number: 1,
    run_attempt: 1,
    name: "Stop the exact post-Q permanent staging deployment",
    display_title: `Permanent staging post-Q deployment stop | ${CANDIDATE}`,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
    head_branch: "main",
    head_sha: CANDIDATE,
    path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
    repository: { id: 1215862300, full_name: "blackmagic30/Beer" },
    head_repository: { id: 1215862300, full_name: "blackmagic30/Beer" },
    run_started_at: "2026-09-08T15:00:00Z",
    ...overrides,
  };
}

function currentJobs() {
  return {
    total_count: 1,
    jobs: [{
      id: 102400000001,
      run_id: Number(CURRENT_RUN_ID),
      run_attempt: 1,
      name: "Authenticate Q and persist the exact stop intent",
      status: "in_progress",
      conclusion: null,
      steps: [],
    }],
  };
}

function environment() {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "blackmagic30/Beer",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: CURRENT_RUN_ID,
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_TOKEN: TOKEN,
    PINTPATH_PROTECTED_ENVIRONMENT: "permanent-staging-scale-evidence",
    PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:
      "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN",
  };
}

function argumentsFor(root = "/tmp/pintpath-post-q-authority") {
  return [
    "--candidate-sha",
    CANDIDATE,
    "--q-run-id",
    "34229745722",
    "--q-artifact-id",
    "10057495901",
    "--downloaded-dir",
    `${root}/downloaded`,
    "--output-dir",
    root,
  ];
}

function githubFetch(overrides: {
  run?: unknown;
  jobs?: unknown;
  artifact?: unknown;
  currentRun?: unknown;
  containmentRuns?: unknown;
  currentJobs?: unknown;
  priorJobs?: unknown;
  link?: string;
} = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    const url = String(input);
    const value = url.endsWith("/actions/runs/34229745722")
      ? overrides.run ?? qRun()
      : url.endsWith("/actions/runs/34229745722/jobs?per_page=100")
      ? overrides.jobs ?? qJobs()
      : url.endsWith(`/actions/runs/${CURRENT_RUN_ID}`)
      ? overrides.currentRun ?? containmentRun()
      : url.includes(
        "/actions/workflows/stop-permanent-staging-post-q-deployment.yml/runs?",
      )
      ? overrides.containmentRuns ?? {
        total_count: 1,
        workflow_runs: [containmentRun()],
      }
      : url.includes(`/actions/runs/${CURRENT_RUN_ID}/attempts/1/jobs?`)
      ? overrides.currentJobs ?? currentJobs()
      : url.includes("/actions/runs/34239999999/attempts/1/jobs?")
      ? overrides.priorJobs
      : overrides.artifact ?? qArtifact();
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: overrides.link === undefined ? {} : { link: overrides.link },
    });
  });
}

const requiredChecks = [
  ["postgres-tool-runtime-closure-observation", ".github/workflows/ci.yml"],
  ["postgres-migration-integration", ".github/workflows/ci.yml"],
  ["build-test-scan", ".github/workflows/ci.yml"],
  ["supabase-database", ".github/workflows/ci.yml"],
  ["CodeQL JavaScript and TypeScript", ".github/workflows/codeql.yml"],
  ["CodeQL Swift", ".github/workflows/codeql.yml"],
  ["release-readiness", ".github/workflows/pintpath-release-readiness.yml"],
  ["ios", ".github/workflows/native-apps.yml"],
] as const;

const baseArtifacts = new Map([
  ["postgres-tool-runtime-closure-observation",
    "pintpath-postgres-tool-runtime-closure-v4-observation"],
  ["postgres-migration-integration", "pintpath-mission-discovery-scale-evidence"],
  ["release-readiness", "pintpath-automated-readiness-evidence"],
]);

function reviewedCandidateFetch(mainSha = CANDIDATE) {
  const checkByRun = new Map(requiredChecks.map((row, index) => [
    34241000000 + index,
    row,
  ]));
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    let value: unknown;
    if (url.pathname.endsWith(`/commits/${CANDIDATE}/pulls`)) {
      value = [{
        number: 123,
        state: "closed",
        merge_commit_sha: CANDIDATE,
        base: { ref: "main", repo: { full_name: "blackmagic30/Beer" } },
        head: { repo: { full_name: "blackmagic30/Beer" } },
      }];
    } else if (url.pathname.endsWith("/pulls/123")) {
      value = {
        number: 123,
        state: "closed",
        merged: true,
        draft: false,
        merge_commit_sha: CANDIDATE,
        base: { ref: "main", repo: { full_name: "blackmagic30/Beer" } },
        head: {
          sha: REVIEWED_HEAD,
          repo: { full_name: "blackmagic30/Beer" },
        },
        user: { id: 1 },
        merged_by: { id: 2 },
        merged_at: "2026-09-08T14:00:00Z",
      };
    } else if (url.pathname.endsWith(`/git/commits/${CANDIDATE}`)) {
      value = {
        sha: CANDIDATE,
        tree: { sha: REVIEWED_TREE },
        parents: [{ sha: Q_SHA }],
      };
    } else if (url.pathname.endsWith(`/git/commits/${REVIEWED_HEAD}`)) {
      value = {
        sha: REVIEWED_HEAD,
        tree: { sha: REVIEWED_TREE },
        parents: [{ sha: "e".repeat(40) }],
      };
    } else if (url.pathname.endsWith("/git/ref/heads/main")) {
      value = { ref: "refs/heads/main", object: { type: "commit", sha: mainSha } };
    } else if (url.pathname.endsWith(`/commits/${CANDIDATE}/check-runs`)) {
      const name = url.searchParams.get("check_name")!;
      const index = requiredChecks.findIndex(([expected]) => expected === name);
      const runId = 34241000000 + index;
      value = {
        total_count: 1,
        check_runs: [{
          name,
          head_sha: CANDIDATE,
          status: "completed",
          conclusion: "success",
          app: { slug: "github-actions" },
          details_url:
            `https://github.com/blackmagic30/Beer/actions/runs/${runId}/job/1`,
          check_suite: { id: 9020000000 + index },
          started_at: "2026-09-08T14:10:00Z",
          completed_at: "2026-09-08T14:20:00Z",
        }],
      };
    } else {
      const runMatch = /\/actions\/runs\/(\d+)$/.exec(url.pathname);
      const artifactMatch = /\/actions\/runs\/(\d+)\/artifacts$/.exec(url.pathname);
      if (runMatch) {
        const runId = Number(runMatch[1]);
        const [name, workflowPath] = checkByRun.get(runId)!;
        const index = requiredChecks.findIndex(([expected]) => expected === name);
        value = {
          id: runId,
          check_suite_id: 9020000000 + index,
          head_sha: CANDIDATE,
          head_branch: "main",
          status: "completed",
          conclusion: "success",
          repository: { full_name: "blackmagic30/Beer" },
          head_repository: { full_name: "blackmagic30/Beer" },
          path: workflowPath,
          event: "push",
          workflow_id: 500000000 + index,
          run_attempt: 1,
          run_started_at: "2026-09-08T14:09:00Z",
        };
      } else if (artifactMatch) {
        const runId = Number(artifactMatch[1]);
        const [producer] = checkByRun.get(runId)!;
        const name = baseArtifacts.get(producer)!;
        value = {
          total_count: 1,
          artifacts: [{
            id: 11000000000 + runId,
            name,
            expired: false,
            size_in_bytes: 100,
            digest: `sha256:${"f".repeat(64)}`,
            workflow_run: { head_sha: CANDIDATE, id: runId },
            archive_download_url:
              `https://api.github.com/repos/blackmagic30/Beer/actions/artifacts/${11000000000 + runId}/zip`,
          }],
        };
      } else {
        throw new Error(`unexpected test URL: ${url}`);
      }
    }
    return new Response(JSON.stringify(value), { status: 200 });
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("permanent-staging post-Q GitHub authority", () => {
  it("binds the reviewed squash tree, direct M parent, main tip, and all base checks", async () => {
    const authority = await verifyPostQReviewedCandidate(
      reviewedCandidateFetch(),
      TOKEN,
      CANDIDATE,
      containmentRun(),
      Date.parse("2026-09-08T15:01:00.000Z"),
    );
    expect(authority).toMatchObject({
      schemaVersion: POST_Q_REVIEWED_CANDIDATE_SCHEMA,
      candidateSha: CANDIDATE,
      directParentSha: Q_SHA,
      authorizationDeadline: "2026-09-08T18:57:20.000Z",
      releasePolicySha256:
        "4aaedd863d08e539e1628db5d14557cc23531a0c6d586ffb25acebcba7907e90",
      checks: {
        soleParentSquashShapeExact: true,
        directParentExact: true,
        currentMainTipExact: true,
        baseRequiredCheckLineageExact: true,
        fixedDeadlineExact: true,
      },
    });
    expect(authority.requiredChecks).toHaveLength(8);
    expect(authority.requiredArtifacts).toHaveLength(3);
  });

  it("rejects later main drift and an expired fixed deadline", async () => {
    await expect(verifyPostQReviewedCandidate(
      reviewedCandidateFetch("b".repeat(40)),
      TOKEN,
      CANDIDATE,
      containmentRun(),
      Date.parse("2026-09-08T15:01:00.000Z"),
    )).rejects.toThrow("post_q_authority_reviewed_candidate_invalid");
    await expect(verifyPostQReviewedCandidate(
      reviewedCandidateFetch(),
      TOKEN,
      CANDIDATE,
      containmentRun(),
      Date.parse("2026-09-08T18:57:20.000Z"),
    )).rejects.toThrow("post_q_authority_reviewed_candidate_invalid");
  });

  it("pins the exact failed run, four-job inventory, and immutable artifact", () => {
    expect(qRunExact(qRun())).toBe(true);
    expect(qJobsExact(qJobs())).toBe(true);
    expect(qArtifactExact(qArtifact())).toBe(true);
  });

  it.each([
    ["run attempt", () => ({ ...qRun(), run_attempt: 2 }), qRunExact],
    ["run head", () => ({ ...qRun(), head_sha: "b".repeat(40) }), qRunExact],
    ["artifact digest", () => ({ ...qArtifact(), digest: `sha256:${"b".repeat(64)}` }), qArtifactExact],
    ["artifact expiry", () => ({ ...qArtifact(), expired: true }), qArtifactExact],
  ])("rejects substituted %s", (_name, create, verify) => {
    expect(verify(create())).toBe(false);
  });

  it("rejects any extra or second writer-shaped Q step", () => {
    const jobs = qJobs();
    jobs.jobs[0]!.steps.push({
      number: 46,
      name: "Stop something else",
      status: "completed",
      conclusion: "success",
      started_at: "2026-09-08T13:10:44Z",
      completed_at: "2026-09-08T13:10:45Z",
    });
    expect(qJobsExact(jobs)).toBe(false);
  });

  it("rejects a Q sibling job that was not skipped", () => {
    const jobs = qJobs();
    jobs.jobs[1]!.conclusion = "success";
    expect(qJobsExact(jobs)).toBe(false);
  });

  it("emits canonical secret-free authority only after Q, single-use history, and custody pass", async () => {
    let authoritySource = "";
    let reviewedCandidateSource = "";
    let summarySource = "";
    const sealArtifact = vi.fn(() => ({
      sealedDirectory: "/tmp/pintpath-post-q-authority/sealed",
      members: POST_Q_ARTIFACT_MEMBERS.map((member) => ({
        ...member,
        sealedPath: member.path,
      })),
    }));
    const result = await verifyPermanentStagingPostQAuthority({
      argv: argumentsFor(),
      env: environment(),
      fetchImpl: githubFetch(),
      now: () => Date.parse("2026-09-09T00:01:00.000Z"),
      sealArtifact,
      verifyCandidate: vi.fn(async () => ({
        schemaVersion: POST_Q_REVIEWED_CANDIDATE_SCHEMA,
        candidateSha: CANDIDATE,
        secretMaterialIncluded: false,
      })),
      writeAuthority: (_filename: string, source: string) => {
        authoritySource = source;
      },
      writeReviewedCandidate: (_filename: string, source: string) => {
        reviewedCandidateSource = source;
      },
      writeOutput: (source: string) => {
        summarySource += source;
      },
    });

    expect(sealArtifact).toHaveBeenCalledOnce();
    expect(JSON.parse(authoritySource)).toEqual(result.authority);
    expect(authoritySource).toBe(`${JSON.stringify(result.authority, null, 2)}\n`);
    expect(result.authority).toMatchObject({
      candidateSha: CANDIDATE,
      currentRunId: CURRENT_RUN_ID,
      containment: {
        runId: CURRENT_RUN_ID,
        totalWorkflowDispatchRuns: 1,
        priorAttempts: [],
        currentWriterNotStartedExact: true,
        everyPriorWriterDefinitelySkippedExact: true,
        freshDispatchCannotRepeatWriteExact: true,
      },
      failedQ: {
        runId: "34229745722",
        soleWriterStepConclusion: "failure",
        otherJobsSkipped: true,
      },
      qMutationDisposition: {
        attempts: 1,
        retryAllowed: false,
        acknowledgementExact: true,
        configuredZeroReached: false,
      },
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    expect(result.authority).not.toHaveProperty("verifiedAt");
    expect(result.authorityPath).toBe(
      "/tmp/pintpath-post-q-authority/q-authority.json",
    );
    expect(summarySource).not.toContain(TOKEN);
    expect(JSON.parse(summarySource)).toMatchObject({ ok: true });
    expect(JSON.parse(reviewedCandidateSource)).toEqual(result.reviewedCandidate);
    expect(result.reviewedCandidatePath).toBe(
      "/tmp/pintpath-post-q-authority/reviewed-containment-authority.json",
    );
  });

  it("fails before any API call when the dispatch environment is not exact", async () => {
    const fetchImpl = githubFetch();
    await expect(verifyPermanentStagingPostQAuthority({
      argv: argumentsFor(),
      env: { ...environment(), GITHUB_REF: "refs/heads/feature" },
      fetchImpl,
    })).rejects.toThrow("post_q_authority_environment_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed on a paginated job inventory", async () => {
    await expect(verifyPermanentStagingPostQAuthority({
      argv: argumentsFor(),
      env: environment(),
      fetchImpl: githubFetch({
        link: '<https://api.github.com/next>; rel="next"',
      }),
    })).rejects.toThrow("post_q_authority_github_response_invalid");
  });

  it("permanently rejects a fresh dispatch after any prior writer started", async () => {
    const prior = containmentRun({
      id: 34239999999,
      run_number: 1,
      status: "completed",
      conclusion: "failure",
      head_sha: CANDIDATE,
    });
    const current = containmentRun({ run_number: 2 });
    await expect(verifyPermanentStagingPostQAuthority({
      argv: argumentsFor(),
      env: environment(),
      fetchImpl: githubFetch({
        currentRun: current,
        containmentRuns: {
          total_count: 2,
          workflow_runs: [current, prior],
        },
        priorJobs: {
          total_count: 2,
          jobs: [
            {
              id: 102399999991,
              run_id: 34239999999,
              run_attempt: 1,
              name: "Authenticate Q and persist the exact stop intent",
              status: "completed",
              conclusion: "success",
              steps: [],
            },
            {
              id: 102399999992,
              run_id: 34239999999,
              run_attempt: 1,
              name: "Stop the one exact accidental staging deployment",
              status: "completed",
              conclusion: "failure",
              steps: [{
                name: "Stop the exact accidental staging deployment once",
                status: "completed",
                conclusion: "failure",
              }],
            },
          ],
        },
      }),
      sealArtifact: vi.fn(),
      verifyCandidate: vi.fn(),
    })).rejects.toThrow("post_q_authority_containment_authority_consumed");
  });

  it("consumes authority when a prior apply job ran even if the named writer was skipped", async () => {
    const prior = containmentRun({
      id: 34239999999,
      run_number: 1,
      status: "completed",
      conclusion: "failure",
      head_sha: CANDIDATE,
    });
    const current = containmentRun({ run_number: 2 });
    await expect(verifyPermanentStagingPostQAuthority({
      argv: argumentsFor(),
      env: environment(),
      fetchImpl: githubFetch({
        currentRun: current,
        containmentRuns: {
          total_count: 2,
          workflow_runs: [current, prior],
        },
        priorJobs: {
          total_count: 2,
          jobs: [
            {
              id: 102399999991,
              run_id: 34239999999,
              run_attempt: 1,
              name: "Authenticate Q and persist the exact stop intent",
              status: "completed",
              conclusion: "success",
              steps: [],
            },
            {
              id: 102399999992,
              run_id: 34239999999,
              run_attempt: 1,
              name: "Stop the one exact accidental staging deployment",
              status: "completed",
              conclusion: "failure",
              steps: [
                {
                  name: "An unclassified apply step",
                  status: "completed",
                  conclusion: "success",
                },
                {
                  name: "Stop the exact accidental staging deployment once",
                  status: "completed",
                  conclusion: "skipped",
                },
              ],
            },
          ],
        },
      }),
      sealArtifact: vi.fn(),
      verifyCandidate: vi.fn(),
    })).rejects.toThrow("post_q_authority_containment_authority_consumed");
  });

  it("consumes authority for a prior run from any other candidate revision", async () => {
    const prior = containmentRun({
      id: 34239999999,
      run_number: 1,
      status: "completed",
      conclusion: "failure",
      head_sha: "b".repeat(40),
    });
    const current = containmentRun({ run_number: 2 });
    await expect(verifyPermanentStagingPostQAuthority({
      argv: argumentsFor(),
      env: environment(),
      fetchImpl: githubFetch({
        currentRun: current,
        containmentRuns: {
          total_count: 2,
          workflow_runs: [current, prior],
        },
        priorJobs: {
          total_count: 2,
          jobs: [
            {
              id: 102399999991,
              run_id: 34239999999,
              run_attempt: 1,
              name: "Authenticate Q and persist the exact stop intent",
              status: "completed",
              conclusion: "failure",
              steps: [],
            },
            {
              id: 102399999992,
              run_id: 34239999999,
              run_attempt: 1,
              name: "Stop the one exact accidental staging deployment",
              status: "completed",
              conclusion: "skipped",
              steps: [],
            },
          ],
        },
      }),
      sealArtifact: vi.fn(),
      verifyCandidate: vi.fn(),
    })).rejects.toThrow("post_q_authority_containment_authority_consumed");
  });

  it("reads every containment history page and every safe prior attempt", async () => {
    const current = containmentRun({ run_number: 101 });
    const priorRuns = Array.from({ length: 100 }, (_, index) => containmentRun({
      id: 34230000000 + index,
      run_number: index + 1,
      status: "completed",
      conclusion: "failure",
      head_sha: CANDIDATE,
    }));
    const baseFetch = githubFetch({ currentRun: current });
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes(
        "/actions/workflows/stop-permanent-staging-post-q-deployment.yml/runs?",
      )) {
        const page = new URL(url).searchParams.get("page");
        const rows = page === "1"
          ? [current, ...priorRuns.slice(0, 99)]
          : page === "2"
          ? priorRuns.slice(99)
          : [];
        return new Response(JSON.stringify({
          total_count: 101,
          workflow_runs: rows,
        }), { status: 200 });
      }
      const priorMatch = /\/actions\/runs\/(3423\d+)\/attempts\/1\/jobs\?/.exec(url);
      if (priorMatch) {
        const runId = Number(priorMatch[1]);
        return new Response(JSON.stringify({
          total_count: 2,
          jobs: [
            {
              id: runId + 60000000000,
              run_id: runId,
              run_attempt: 1,
              name: "Authenticate Q and persist the exact stop intent",
              status: "completed",
              conclusion: "failure",
              steps: [],
            },
            {
              id: runId + 70000000000,
              run_id: runId,
              run_attempt: 1,
              name: "Stop the one exact accidental staging deployment",
              status: "completed",
              conclusion: "skipped",
              steps: [],
            },
          ],
        }), { status: 200 });
      }
      return baseFetch(input, init);
    });
    const result = await verifyPermanentStagingPostQAuthority({
      argv: argumentsFor(),
      env: environment(),
      fetchImpl,
      now: () => Date.parse("2026-09-08T15:01:00.000Z"),
      sealArtifact: vi.fn(() => ({
        sealedDirectory: "/tmp/pintpath-post-q-authority/sealed",
        members: POST_Q_ARTIFACT_MEMBERS.map((member) => ({
          ...member,
          sealedPath: member.path,
        })),
      })),
      verifyCandidate: vi.fn(async () => ({
        schemaVersion: POST_Q_REVIEWED_CANDIDATE_SCHEMA,
      })),
      writeAuthority: vi.fn(),
      writeReviewedCandidate: vi.fn(),
      writeOutput: vi.fn(),
    });
    expect(result.authority.containment).toMatchObject({
      totalWorkflowDispatchRuns: 101,
      allWorkflowRunPagesReadExact: true,
      allRunAttemptJobPagesReadExact: true,
    });
    expect(result.authority.containment.priorAttempts).toHaveLength(100);
    expect(fetchImpl.mock.calls.some(([input]) =>
      String(input).includes("per_page=100&page=2"))).toBe(true);
  });

  it("seals an exact regular-file inventory into a private flat directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-q-seal-"));
    temporaryDirectories.push(root);
    fs.chmodSync(root, 0o700);
    const downloaded = path.join(root, "downloaded");
    fs.mkdirSync(path.join(downloaded, "nested"), { recursive: true });
    const source = Buffer.from("exact fixture\n");
    fs.writeFileSync(path.join(downloaded, "nested", "fixture.json"), source);
    const sealed = sealPostQArtifact(downloaded, root, [{
      path: "nested/fixture.json",
      sizeBytes: source.byteLength,
      sha256: crypto.createHash("sha256").update(source).digest("hex"),
    }]);
    const target = path.join(sealed.sealedDirectory, "nested", "fixture.json");
    expect(fs.readFileSync(target)).toEqual(source);
    expect(fs.statSync(sealed.sealedDirectory).mode & 0o077).toBe(0);
    expect(fs.statSync(target).mode & 0o077).toBe(0);
  });

  it("rejects extra artifact members and symlinks", () => {
    const makeRoot = () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-q-seal-"));
      temporaryDirectories.push(root);
      fs.chmodSync(root, 0o700);
      fs.mkdirSync(path.join(root, "downloaded"));
      return root;
    };
    const extraRoot = makeRoot();
    fs.writeFileSync(path.join(extraRoot, "downloaded", "extra.json"), "{}\n");
    expect(() => sealPostQArtifact(
      path.join(extraRoot, "downloaded"),
      extraRoot,
      [],
    )).toThrow("post_q_authority_artifact_files_invalid");

    const linkRoot = makeRoot();
    const outside = path.join(linkRoot, "outside.json");
    fs.writeFileSync(outside, "{}\n");
    fs.symlinkSync(outside, path.join(linkRoot, "downloaded", "fixture.json"));
    expect(() => sealPostQArtifact(
      path.join(linkRoot, "downloaded"),
      linkRoot,
      [],
    )).toThrow("post_q_authority_artifact_files_invalid");
  });
});
