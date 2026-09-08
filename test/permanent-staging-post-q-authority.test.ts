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
import {
  POST_Q_AUTHORITY_V2_SCHEMA,
  POST_Q_REVIEWED_CANDIDATE_V2_SCHEMA,
  verifyPostQReviewedCandidate as verifyPostQReviewedCandidateV2,
  verifyPermanentStagingPostQAuthorityV2,
} from "../scripts/verify-permanent-staging-post-q-authority-v2.mjs";
import {
  parsePostQDeploymentStopAuthorityV2,
  parsePostQDeploymentStopReviewedAuthorityV2,
} from "../scripts/lib/permanent-staging-post-q-deployment-stop-authority-v2.js";
import {
  buildPostQDeploymentStopIntent,
  canonicalPostQEvidence,
  parsePostQDeploymentStopIntent,
  POST_Q_DEPLOYMENT_STOP_LOCK,
} from "../scripts/lib/permanent-staging-post-q-deployment-stop.js";

const CANDIDATE = "a".repeat(40);
const CURRENT_RUN_ID = "34240000000";
const Q_SHA = "606d33facb515dd10bc94c360e43c20beb999cc1";
const RECOVERY_BRIDGE_SHA = "f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7";
const RECOVERY_BRIDGE_TREE = "9978dca9491f7bf7bee77ce39debe1f713e89c53";
const RECOVERY_BRIDGE_RUN_ID = "34255228036";
const RECOVERY_BRIDGE_WORKFLOW_ID = 353312302;
const RECOVERY_BRIDGE_PREPARE_JOB_ID = 102159216963;
const RECOVERY_BRIDGE_APPLY_JOB_ID = 102160681336;
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

function containmentRunName(candidateSha: string): string {
  return `Permanent staging post-Q deployment stop | ${candidateSha}`;
}

function containmentRun(overrides: Record<string, unknown> = {}) {
  const headSha = typeof overrides.head_sha === "string"
    ? overrides.head_sha
    : CANDIDATE;
  return {
    id: Number(CURRENT_RUN_ID),
    workflow_id: RECOVERY_BRIDGE_WORKFLOW_ID,
    run_number: 2,
    run_attempt: 1,
    name: containmentRunName(headSha),
    display_title: containmentRunName(headSha),
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
    head_branch: "main",
    head_sha: headSha,
    path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
    repository: { id: 1215862300, full_name: "blackmagic30/Beer" },
    head_repository: { id: 1215862300, full_name: "blackmagic30/Beer" },
    actor: { id: 29029791, login: "blackmagic30" },
    triggering_actor: { id: 29029791, login: "blackmagic30" },
    check_suite_id: 92800000000,
    created_at: "2026-09-08T17:30:00Z",
    run_started_at: "2026-09-08T17:30:00Z",
    updated_at: "2026-09-08T17:31:00Z",
    ...overrides,
  };
}

function recoveryBridgeRun(overrides: Record<string, unknown> = {}) {
  return containmentRun({
    id: Number(RECOVERY_BRIDGE_RUN_ID),
    run_number: 1,
    run_attempt: 1,
    head_sha: RECOVERY_BRIDGE_SHA,
    status: "completed",
    conclusion: "failure",
    check_suite_id: 92795131798,
    created_at: "2026-09-08T17:07:48Z",
    run_started_at: "2026-09-08T17:07:48Z",
    updated_at: "2026-09-08T17:12:11Z",
    ...overrides,
  });
}

function recoveryBridgePrepareSteps() {
  const rows = [
    [1, "Set up job", "success", "2026-09-08T17:07:54Z", "2026-09-08T17:07:55Z"],
    [2, "Checkout the exact main candidate without persisted credentials", "success", "2026-09-08T17:07:55Z", "2026-09-08T17:07:58Z"],
    [3, "Require exact one-attempt staging-only containment authority", "success", "2026-09-08T17:07:58Z", "2026-09-08T17:07:59Z"],
    [4, "Setup the repository Node runtime", "success", "2026-09-08T17:07:59Z", "2026-09-08T17:08:00Z"],
    [5, "Install immutable dependencies", "success", "2026-09-08T17:08:00Z", "2026-09-08T17:08:04Z"],
    [6, "Run the complete repository gate before provider-token custody", "success", "2026-09-08T17:08:04Z", "2026-09-08T17:12:07Z"],
    [7, "Create private Q, intent, and evidence custody", "success", "2026-09-08T17:12:07Z", "2026-09-08T17:12:07Z"],
    [8, "Download the exact immutable failed-Q artifact", "success", "2026-09-08T17:12:07Z", "2026-09-08T17:12:08Z"],
    [9, "Authenticate the exact failed Q run, sole writer, and artifact bytes", "failure", "2026-09-08T17:12:08Z", "2026-09-08T17:12:08Z"],
    [10, "Prepare the exact post-Q stop intent with metadata credentials only", "skipped", "2026-09-08T17:12:08Z", "2026-09-08T17:12:08Z"],
    [11, "Persist the exact stop intent before any stop credential exists", "skipped", "2026-09-08T17:12:08Z", "2026-09-08T17:12:08Z"],
    [12, "Remove prepare Q custody", "success", "2026-09-08T17:12:08Z", "2026-09-08T17:12:08Z"],
    [23, "Post Setup the repository Node runtime", "skipped", "2026-09-08T17:12:08Z", "2026-09-08T17:12:08Z"],
    [24, "Post Checkout the exact main candidate without persisted credentials", "success", "2026-09-08T17:12:08Z", "2026-09-08T17:12:09Z"],
    [25, "Complete job", "success", "2026-09-08T17:12:09Z", "2026-09-08T17:12:09Z"],
  ] as const;
  return rows.map(([number, name, conclusion, startedAt, completedAt]) => ({
    number,
    name,
    status: "completed",
    conclusion,
    started_at: startedAt,
    completed_at: completedAt,
  }));
}

function recoveryBridgeJobs() {
  const workflowName = containmentRunName(RECOVERY_BRIDGE_SHA);
  return {
    total_count: 2,
    jobs: [
      {
        id: RECOVERY_BRIDGE_PREPARE_JOB_ID,
        run_id: Number(RECOVERY_BRIDGE_RUN_ID),
        run_attempt: 1,
        workflow_name: workflowName,
        head_sha: RECOVERY_BRIDGE_SHA,
        name: "Authenticate Q and persist the exact stop intent",
        status: "completed",
        conclusion: "failure",
        created_at: "2026-09-08T17:07:50Z",
        started_at: "2026-09-08T17:07:53Z",
        completed_at: "2026-09-08T17:12:10Z",
        steps: recoveryBridgePrepareSteps(),
      },
      {
        id: RECOVERY_BRIDGE_APPLY_JOB_ID,
        run_id: Number(RECOVERY_BRIDGE_RUN_ID),
        run_attempt: 1,
        workflow_name: workflowName,
        head_sha: RECOVERY_BRIDGE_SHA,
        name: "Stop the one exact accidental staging deployment",
        status: "completed",
        conclusion: "skipped",
        created_at: "2026-09-08T17:12:11Z",
        started_at: "2026-09-08T17:12:11Z",
        completed_at: "2026-09-08T17:12:10Z",
        steps: [],
      },
    ],
  };
}

function safePriorJobs(runId = 34239999999, runAttempt = 1) {
  return {
    total_count: 2,
    jobs: [
      {
        id: runId + 60_000_000_000,
        run_id: runId,
        run_attempt: runAttempt,
        name: "Authenticate Q and persist the exact stop intent",
        status: "completed",
        conclusion: "failure",
        steps: [],
      },
      {
        id: runId + 70_000_000_000,
        run_id: runId,
        run_attempt: runAttempt,
        name: "Stop the one exact accidental staging deployment",
        status: "completed",
        conclusion: "skipped",
        steps: [],
      },
    ],
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

function applyPhaseCurrentJobs(
  writerStatus: "pending" | "queued" = "pending",
) {
  return {
    total_count: 2,
    jobs: [
      {
        id: 102400000001,
        run_id: Number(CURRENT_RUN_ID),
        run_attempt: 1,
        name: "Authenticate Q and persist the exact stop intent",
        status: "completed",
        conclusion: "success",
        steps: [],
      },
      {
        id: 102400000002,
        run_id: Number(CURRENT_RUN_ID),
        run_attempt: 1,
        name: "Stop the one exact accidental staging deployment",
        status: "in_progress",
        conclusion: null,
        started_at: "2026-09-08T17:31:00Z",
        completed_at: null,
        steps: [{
          number: 12,
          name: "Stop the exact accidental staging deployment once",
          status: writerStatus,
          conclusion: null,
          started_at: null,
          completed_at: null,
        }],
      },
    ],
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
  bridgeRun?: unknown;
  workflowMetadata?: unknown;
  containmentRuns?: unknown;
  currentJobs?: unknown;
  bridgeJobs?: unknown;
  bridgeArtifacts?: unknown;
  priorJobs?: unknown;
  historicalWorkflow?: unknown;
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
      : url.endsWith(`/actions/runs/${RECOVERY_BRIDGE_RUN_ID}`)
      ? overrides.bridgeRun ?? recoveryBridgeRun()
      : url.endsWith(
        `/actions/workflows/${RECOVERY_BRIDGE_WORKFLOW_ID}`,
      )
      ? overrides.workflowMetadata ?? {
        id: RECOVERY_BRIDGE_WORKFLOW_ID,
        name: "Stop the exact post-Q permanent staging deployment",
        path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
        state: "active",
      }
      : url.includes(
        "/actions/workflows/stop-permanent-staging-post-q-deployment.yml/runs?",
      ) || url.includes(
        `/actions/workflows/${RECOVERY_BRIDGE_WORKFLOW_ID}/runs?`,
      )
      ? overrides.containmentRuns ?? {
        total_count: 2,
        workflow_runs: [containmentRun(), recoveryBridgeRun()],
      }
      : url.includes(
        "/contents/.github/workflows/stop-permanent-staging-post-q-deployment.yml?",
      )
      ? overrides.historicalWorkflow ?? { type: "invalid" }
      : url.includes(`/actions/runs/${CURRENT_RUN_ID}/attempts/1/jobs?`)
      ? overrides.currentJobs ?? currentJobs()
      : url.includes(
        `/actions/runs/${RECOVERY_BRIDGE_RUN_ID}/attempts/1/jobs?`,
      )
      ? overrides.bridgeJobs ?? recoveryBridgeJobs()
      : url.includes(
        `/actions/runs/${RECOVERY_BRIDGE_RUN_ID}/artifacts?per_page=100&page=1`,
      )
      ? overrides.bridgeArtifacts ?? { total_count: 0, artifacts: [] }
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

function reviewedCandidateFetch(
  mainSha = CANDIDATE,
  recoveryBridgeCommitOverrides: Record<string, unknown> = {},
  mergedAt = "2026-09-08T17:20:00Z",
  timing = {
    checkStartedAt: "2026-09-08T17:21:00Z",
    checkCompletedAt: "2026-09-08T17:25:00Z",
    workflowRunStartedAt: "2026-09-08T14:09:00Z",
  },
) {
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
        merged_at: mergedAt,
      };
    } else if (url.pathname.endsWith(`/git/commits/${CANDIDATE}`)) {
    value = {
      sha: CANDIDATE,
      tree: { sha: REVIEWED_TREE },
      parents: [{ sha: RECOVERY_BRIDGE_SHA }],
    };
    } else if (url.pathname.endsWith(
      `/git/commits/${RECOVERY_BRIDGE_SHA}`,
    )) {
      value = {
        sha: RECOVERY_BRIDGE_SHA,
        tree: { sha: RECOVERY_BRIDGE_TREE },
        parents: [{ sha: Q_SHA }],
        ...recoveryBridgeCommitOverrides,
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
          started_at: timing.checkStartedAt,
          completed_at: timing.checkCompletedAt,
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
          run_started_at: timing.workflowRunStartedAt,
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

function reviewedCandidateFetchV2(
  predecessorReviewedTree = "53808bdd995a6ff1d2204e01f7639b103dbd5a76",
) {
  const fallback = reviewedCandidateFetch(
    CANDIDATE,
    {},
    "2026-09-08T18:24:00Z",
    {
      checkStartedAt: "2026-09-08T18:25:00Z",
      checkCompletedAt: "2026-09-08T18:45:00Z",
      workflowRunStartedAt: "2026-09-08T18:25:00Z",
    },
  );
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/git/commits/${CANDIDATE}`)) {
      return new Response(JSON.stringify({
        sha: CANDIDATE,
        tree: { sha: REVIEWED_TREE },
        parents: [{ sha: "d27275f4c101b764c6016e8b378969c14719258e" }],
      }), { status: 200 });
    }
    if (url.pathname.endsWith(
      "/git/commits/d27275f4c101b764c6016e8b378969c14719258e",
    )) {
      return new Response(JSON.stringify({
        sha: "d27275f4c101b764c6016e8b378969c14719258e",
        tree: { sha: "53808bdd995a6ff1d2204e01f7639b103dbd5a76" },
        parents: [{ sha: RECOVERY_BRIDGE_SHA }],
      }), { status: 200 });
    }
    if (url.pathname.endsWith(
      "/git/commits/3ab064f5026a923b42bf67dbd94cb5d16f125c0d",
    )) {
      return new Response(JSON.stringify({
        sha: "3ab064f5026a923b42bf67dbd94cb5d16f125c0d",
        tree: { sha: predecessorReviewedTree },
        parents: [{ sha: RECOVERY_BRIDGE_SHA }],
      }), { status: 200 });
    }
    if (url.pathname.endsWith("/pulls/98")) {
      return new Response(JSON.stringify({
        number: 98,
        state: "closed",
        merged: true,
        merged_at: "2026-09-08T18:23:44Z",
        merge_commit_sha: "d27275f4c101b764c6016e8b378969c14719258e",
        head: {
          sha: "3ab064f5026a923b42bf67dbd94cb5d16f125c0d",
          repo: { full_name: "blackmagic30/Beer" },
        },
        base: {
          ref: "main",
          sha: RECOVERY_BRIDGE_SHA,
          repo: { full_name: "blackmagic30/Beer" },
        },
        user: { id: 29_029_791, login: "blackmagic30" },
        merged_by: { id: 29_029_791, login: "blackmagic30" },
      }), { status: 200 });
    }
    return fallback(input, init);
  });
}

function runAuthority(
  overrides: Parameters<typeof githubFetch>[0] = {},
) {
  return verifyPermanentStagingPostQAuthority({
    argv: argumentsFor(),
    env: environment(),
    fetchImpl: githubFetch(overrides),
    now: () => Date.parse("2026-09-08T17:31:00.000Z"),
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
      Date.parse("2026-09-08T17:31:00.000Z"),
    );
    expect(authority).toMatchObject({
      schemaVersion: POST_Q_REVIEWED_CANDIDATE_SCHEMA,
      candidateSha: CANDIDATE,
      directParentSha: RECOVERY_BRIDGE_SHA,
      recoveryBridge: {
        candidateSha: RECOVERY_BRIDGE_SHA,
        treeSha: RECOVERY_BRIDGE_TREE,
        soleParentSha: Q_SHA,
      },
      authorizationDeadline: "2026-09-08T18:57:20.000Z",
      releasePolicySha256:
        "4aaedd863d08e539e1628db5d14557cc23531a0c6d586ffb25acebcba7907e90",
      checks: {
        soleParentSquashShapeExact: true,
        directParentExact: true,
        recoveryBridgeExact: true,
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
      Date.parse("2026-09-08T17:31:00.000Z"),
    )).rejects.toThrow("post_q_authority_reviewed_candidate_invalid");
    await expect(verifyPostQReviewedCandidate(
      reviewedCandidateFetch(),
      TOKEN,
      CANDIDATE,
      containmentRun(),
      Date.parse("2026-09-08T18:57:20.000Z"),
    )).rejects.toThrow("post_q_authority_reviewed_candidate_invalid");
  });

  it("rejects recovery-bridge tree or sole-parent substitution", async () => {
    await expect(verifyPostQReviewedCandidate(
      reviewedCandidateFetch(CANDIDATE, { tree: { sha: "b".repeat(40) } }),
      TOKEN,
      CANDIDATE,
      containmentRun(),
      Date.parse("2026-09-08T17:31:00.000Z"),
    )).rejects.toThrow("post_q_authority_reviewed_candidate_invalid");
    await expect(verifyPostQReviewedCandidate(
      reviewedCandidateFetch(CANDIDATE, {
        parents: [{ sha: "b".repeat(40) }],
      }),
      TOKEN,
      CANDIDATE,
      containmentRun(),
      Date.parse("2026-09-08T17:31:00.000Z"),
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
        runNumber: 2,
        totalWorkflowDispatchRuns: 2,
        priorAttempts: [{
          runId: RECOVERY_BRIDGE_RUN_ID,
          runAttempt: 1,
          headSha: RECOVERY_BRIDGE_SHA,
          writerDisposition: "completed_skipped",
        }],
        recoveryBridge: {
          runId: RECOVERY_BRIDGE_RUN_ID,
          runAttempt: 1,
          workflowId: RECOVERY_BRIDGE_WORKFLOW_ID,
          workflowPath:
            ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
          headSha: RECOVERY_BRIDGE_SHA,
          prepareJobId: String(RECOVERY_BRIDGE_PREPARE_JOB_ID),
          applyJobId: String(RECOVERY_BRIDGE_APPLY_JOB_ID),
          prepareFailedBeforeIntentExact: true,
          applyCompletedSkippedWithoutStepsExact: true,
          writerNeverExistedOrStartedExact: true,
          artifactsAbsentExact: true,
        },
        workflowMetadataExact: true,
        currentWriterNotStartedExact: true,
        everyPriorWriterDefinitelySkippedExact: true,
        priorCompletedBeforeWriterRunsDoNotConsumeAuthority: true,
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

  it("accepts only the exact pre-writer prepare and apply phases", async () => {
    await expect(runAuthority()).resolves.toBeDefined();
    await expect(runAuthority({
      currentJobs: applyPhaseCurrentJobs(),
    })).resolves.toBeDefined();
  });

  it("rejects indeterminate current writer states", async () => {
    const emptyInProgressApply = applyPhaseCurrentJobs();
    emptyInProgressApply.jobs[1]!.steps = [];
    await expect(runAuthority({
      currentJobs: emptyInProgressApply,
    })).rejects.toThrow("post_q_authority_containment_authority_consumed");

    const completedPrepareWithoutApply = currentJobs();
    completedPrepareWithoutApply.jobs[0]!.status = "completed";
    completedPrepareWithoutApply.jobs[0]!.conclusion = "success";
    await expect(runAuthority({
      currentJobs: completedPrepareWithoutApply,
    })).rejects.toThrow("post_q_authority_containment_authority_consumed");
  });

  it("requires the recovery candidate merge after the pinned failed run", async () => {
    await expect(verifyPostQReviewedCandidate(
      reviewedCandidateFetch(
        CANDIDATE,
        {},
        "2026-09-08T17:12:11Z",
      ),
      TOKEN,
      CANDIDATE,
      containmentRun(),
      Date.parse("2026-09-08T17:31:00.000Z"),
    )).rejects.toThrow("post_q_authority_reviewed_candidate_invalid");
  });

  it("permanently rejects a fresh dispatch after any prior writer started", async () => {
    const bridgeJobs = recoveryBridgeJobs();
    const apply = bridgeJobs.jobs[1]!;
    apply.status = "completed";
    apply.conclusion = "failure";
    apply.steps.push({
      number: 1,
      name: "Stop the exact accidental staging deployment once",
      status: "completed",
      conclusion: "failure",
      started_at: "2026-09-08T17:12:11Z",
      completed_at: "2026-09-08T17:12:12Z",
    });

    await expect(runAuthority({ bridgeJobs })).rejects.toThrow(
      "post_q_authority_containment_authority_consumed",
    );
  });

  it("consumes authority when a prior apply job ran even if the named writer was skipped", async () => {
    const bridgeJobs = recoveryBridgeJobs();
    const apply = bridgeJobs.jobs[1]!;
    apply.status = "completed";
    apply.conclusion = "failure";
    apply.steps.push({
      number: 1,
      name: "An unclassified apply step",
      status: "completed",
      conclusion: "success",
      started_at: "2026-09-08T17:12:11Z",
      completed_at: "2026-09-08T17:12:12Z",
    });

    await expect(runAuthority({ bridgeJobs })).rejects.toThrow(
      "post_q_authority_containment_authority_consumed",
    );
  });

  it("rejects any extra skipped run outside the exact two-run history", async () => {
    const prior = containmentRun({
      id: 34239999999,
      run_number: 0,
      status: "completed",
      conclusion: "failure",
      head_sha: "b".repeat(40),
    });
    const current = containmentRun();
    await expect(runAuthority({
        currentRun: current,
        containmentRuns: {
          total_count: 3,
          workflow_runs: [current, recoveryBridgeRun(), prior],
        },
        priorJobs: safePriorJobs(),
    })).rejects.toThrow("post_q_authority_containment_history_invalid");
  });

  it("rejects a rerun of either the current or recovery bridge run", async () => {
    await expect(runAuthority({
      currentRun: containmentRun({ run_attempt: 2 }),
    })).rejects.toThrow("post_q_authority_containment_history_invalid");
    const rerunBridge = recoveryBridgeRun({ run_attempt: 2 });
    await expect(runAuthority({
      containmentRuns: {
        total_count: 2,
        workflow_runs: [containmentRun(), rerunBridge],
      },
    })).rejects.toThrow("post_q_authority_containment_history_invalid");
  });

  it("rejects substituted run identity, job graph, and artifact inventory", async () => {
    await expect(runAuthority({
      currentRun: containmentRun({ name: "wrong-current-name" }),
    })).rejects.toThrow("post_q_authority_containment_history_invalid");

    const currentListing = containmentRun({
      display_title: "wrong-current-title",
    });
    await expect(runAuthority({
      containmentRuns: {
        total_count: 2,
        workflow_runs: [currentListing, recoveryBridgeRun()],
      },
    })).rejects.toThrow("post_q_authority_containment_history_invalid");

    await expect(runAuthority({
      bridgeRun: recoveryBridgeRun({ actor: undefined }),
    })).rejects.toThrow("post_q_authority_containment_authority_consumed");

    const bridgeListing = recoveryBridgeRun({ triggering_actor: undefined });
    await expect(runAuthority({
      containmentRuns: {
        total_count: 2,
        workflow_runs: [containmentRun(), bridgeListing],
      },
    })).rejects.toThrow("post_q_authority_containment_history_invalid");

    await expect(runAuthority({
      bridgeRun: recoveryBridgeRun({ check_suite_id: 92795131799 }),
    })).rejects.toThrow("post_q_authority_containment_authority_consumed");

    await expect(runAuthority({
      workflowMetadata: {
        id: RECOVERY_BRIDGE_WORKFLOW_ID,
        name: "Stop the exact post-Q permanent staging deployment",
        path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
        state: "disabled_manually",
      },
    })).rejects.toThrow("post_q_authority_containment_history_invalid");

    const bridgeJobs = recoveryBridgeJobs();
    bridgeJobs.jobs[0]!.steps[8]!.completed_at =
      "2026-09-08T17:12:09Z";
    await expect(runAuthority({ bridgeJobs })).rejects.toThrow(
      "post_q_authority_containment_authority_consumed",
    );

    await expect(runAuthority({
      bridgeArtifacts: {
        total_count: 1,
        artifacts: [{ id: 1, name: "unexpected-intent" }],
      },
    })).rejects.toThrow("post_q_authority_containment_history_invalid");
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

  it("emits v2 authority that both v2 parsers accept end to end", async () => {
    const current = containmentRun({
      created_at: "2026-09-09T06:00:00Z",
      run_started_at: "2026-09-09T06:00:00Z",
      updated_at: "2026-09-09T06:01:00Z",
    });
    const authorization = {
      authorizationId:
        "pintpath-post-q-staging-stop-reauthorization-2026-09-09/v2",
      sourceThreadId: "01a02140-8628-7d30-9374-8d29d4a9f3a3",
      sourceSchemaVersion:
        "pintpath-reviewed-user-authorization-provenance/v1",
      sourceSha256:
        "4203affc634766c1ba695c969448d8c126552d1c16ffb090e2a55d5f319a0779",
      sourceSizeBytes: 267,
      sourceSerialization: "JSON.stringify(value,null,2)+LF",
      messagesExact: true,
      reviewedProvenanceOnly: true,
      cryptographicUserSignatureClaimed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    };
    const requiredChecksV2 = requiredChecks.map(([name, workflowPath], index) => ({
      name,
      runId: 34_300_000_000 + index,
      checkSuiteId: 93_000_000_000 + index,
      workflowId: 400_000_000 + index,
      workflowPath,
      event: "push",
      runAttempt: 1,
      startedAt: "2026-09-09T05:31:00Z",
      completedAt: "2026-09-09T05:45:00Z",
    }));
    const reviewed = {
      schemaVersion: POST_Q_REVIEWED_CANDIDATE_V2_SCHEMA,
      repository: "blackmagic30/Beer",
      branch: "main",
      candidateSha: CANDIDATE,
      reviewedPullRequest: {
        number: 101,
        reviewedPrHeadSha: REVIEWED_HEAD,
        mergeCommitSha: CANDIDATE,
        treeSha: REVIEWED_TREE,
        mergedAt: "2026-09-09T05:30:00Z",
        authorId: 29_029_791,
        mergedById: 29_029_791,
        githubMergeExact: true,
        reviewedTreeExact: true,
        pullRequestApprovalRequirement: "not_required",
        pullRequestApprovalRequirementExact: true,
        linearHistoryExact: true,
      },
      releasePolicySha256:
        "4aaedd863d08e539e1628db5d14557cc23531a0c6d586ffb25acebcba7907e90",
      successorPolicySha256:
        "5f4c4bc20c8ef68ed77f51ad92a11cede00122e3274e4408eb8ea858d6a07e4b",
      directParentSha: "d27275f4c101b764c6016e8b378969c14719258e",
      predecessorBridge: {
        candidateSha: "d27275f4c101b764c6016e8b378969c14719258e",
        treeSha: "53808bdd995a6ff1d2204e01f7639b103dbd5a76",
        soleParentSha: RECOVERY_BRIDGE_SHA,
        recoveryCandidateSha: RECOVERY_BRIDGE_SHA,
        recoveryTreeSha: RECOVERY_BRIDGE_TREE,
        recoverySoleParentSha: Q_SHA,
        pullRequestNumber: 98,
        reviewedPrHeadSha: "3ab064f5026a923b42bf67dbd94cb5d16f125c0d",
        mergeCommitSha: "d27275f4c101b764c6016e8b378969c14719258e",
        baseSha: RECOVERY_BRIDGE_SHA,
        mergedAt: "2026-09-08T18:23:44Z",
        githubMergeExact: true,
        reviewedTreeExact: true,
        linearHistoryExact: true,
      },
      authorization,
      deadlinePolicy: {
        explicitExpiry: "2026-09-09T08:00:00.000Z",
        maximumAfterPullRequestMergeSeconds: 14_400,
        maximumAfterRunStartSeconds: 5_400,
        derivedDeadline: "2026-09-09T07:30:00.000Z",
        derivation:
          "min(pull_request_merged_at_plus_4h,current_run_started_at_plus_90m,explicit_expiry)",
        rederiveImmediatelyBeforeWriter: true,
        expirySuppressesPostWriteReconciliation: false,
        expirySuppressesFinalization: false,
      },
      currentContainmentRun: {
        runId: CURRENT_RUN_ID,
        workflowId: RECOVERY_BRIDGE_WORKFLOW_ID,
        workflowPath:
          ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
        runAttempt: 1,
        runStartedAt: "2026-09-09T06:00:00Z",
      },
      requiredChecks: requiredChecksV2,
      requiredArtifacts: [
        ["pintpath-mission-discovery-scale-evidence",
          "postgres-migration-integration"],
        ["pintpath-postgres-tool-runtime-closure-v4-observation",
          "postgres-tool-runtime-closure-observation"],
        ["pintpath-automated-readiness-evidence", "release-readiness"],
      ].map(([name, producerCheck], index) => {
        const producer = requiredChecksV2.find((check) =>
          check.name === producerCheck)!;
        return {
          artifactId: 11_000_000_000 + index,
          name,
          digest: `sha256:${"f".repeat(64)}`,
          sizeBytes: 100,
          runId: producer.runId,
          producerCheck,
        };
      }),
      checks: {
        mergedPullRequestAndTreeExact: true,
        soleParentSquashShapeExact: true,
        directParentExact: true,
        predecessorBridgeExact: true,
        currentMainTipExact: true,
        noLaterMainDriftExact: true,
        baseRequiredCheckLineageExact: true,
        baseRequiredArtifactsExact: true,
        chronologyExact: true,
        deadlineDerivedExact: true,
        authorizationProvenanceExact: true,
        expiredAuthorityNotReusedExact: true,
      },
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    };
    let authoritySource = "";
    let reviewedSource = "";
    const verifyCurrentPhase = async (currentJobsOverride: unknown) => {
      const fetchImpl = githubFetch({
        currentRun: current,
        containmentRuns: {
          total_count: 2,
          workflow_runs: [current, recoveryBridgeRun()],
        },
        currentJobs: currentJobsOverride,
        historicalWorkflow: { type: "fixture-validated-by-override" },
      });
      const result = await verifyPermanentStagingPostQAuthorityV2({
        argv: argumentsFor(),
        env: {
          ...environment(),
          PINTPATH_POST_Q_DEPLOYMENT_STOP_V2_AUTHORIZATION_ID:
            "pintpath-post-q-staging-stop-reauthorization-2026-09-09/v2",
          PINTPATH_POST_Q_DEPLOYMENT_STOP_V2_AUTHORIZATION_SOURCE_SHA256:
            "4203affc634766c1ba695c969448d8c126552d1c16ffb090e2a55d5f319a0779",
        },
        fetchImpl,
        now: () => Date.parse("2026-09-09T06:01:00.000Z"),
        historicalWorkflowExact: vi.fn(() => true),
        sealArtifact: vi.fn(() => ({
          sealedDirectory: "/tmp/pintpath-post-q-authority/sealed",
          members: POST_Q_ARTIFACT_MEMBERS.map((member) => ({
            ...member,
            sealedPath: member.path,
          })),
        })),
        verifyCandidate: vi.fn(async () => reviewed),
        writeAuthority: (_filename: string, source: string) => {
          authoritySource = source;
        },
        writeReviewedCandidate: (_filename: string, source: string) => {
          reviewedSource = source;
        },
        writeOutput: vi.fn(),
      });
      return { fetchImpl, result };
    };

    const preparePhase = await verifyCurrentPhase(currentJobs());
    expect(preparePhase.result.authority.schemaVersion).toBe(
      POST_Q_AUTHORITY_V2_SCHEMA,
    );
    const { fetchImpl, result } = await verifyCurrentPhase(
      applyPhaseCurrentJobs("queued"),
    );

    expect(result.authority.schemaVersion).toBe(POST_Q_AUTHORITY_V2_SCHEMA);
    expect(result.authority.expiredAuthority).toMatchObject({
      authorizationExpired: true,
      authorityReused: false,
      historicalWorkflowBlobOid:
        "0d5efadc53101ae6631e25bbff7c804a30faa672",
      historicalWorkflowByteSha256:
        "6a452880ccbe3d80d9d771b4aae7bd3be2bcf26beac7dee1af91d0c705e7a9a8",
    });
    const parsedAuthority = parsePostQDeploymentStopAuthorityV2(authoritySource, {
      candidateSha: CANDIDATE,
      runId: CURRENT_RUN_ID,
    });
    const parsedReviewed = parsePostQDeploymentStopReviewedAuthorityV2(
      reviewedSource,
      {
      candidateSha: CANDIDATE,
      runId: CURRENT_RUN_ID,
      },
    );
    expect(parsedAuthority).not.toBeNull();
    expect(parsedReviewed).toMatchObject({
      authorizationDeadline: "2026-09-09T07:30:00.000Z",
      workflowRunStartedAt: "2026-09-09T06:00:00Z",
    });
    const intent = buildPostQDeploymentStopIntent({
      candidateSha: CANDIDATE,
      runId: CURRENT_RUN_ID,
      qArtifact: {
        artifactId: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId,
        artifactName: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactName,
        artifactDigest: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest,
        receiptSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.receiptSha256,
        intentSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.intentSha256,
        prerequisiteSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.prerequisiteSha256,
        successorBridgeSha256:
          POST_Q_DEPLOYMENT_STOP_LOCK.q.successorBridgeSha256,
        reviewedAuthoritySha256:
          POST_Q_DEPLOYMENT_STOP_LOCK.q.reviewedAuthoritySha256,
      },
      qAuthority: parsedAuthority!,
      reviewedAuthority: parsedReviewed!,
      boundaryReceiptSha256: "b".repeat(64),
    });
    expect(intent).not.toBeNull();
    expect(parsePostQDeploymentStopIntent(canonicalPostQEvidence(intent), {
      candidateSha: CANDIDATE,
      runId: CURRENT_RUN_ID,
    })).not.toBeNull();
    const historyUrl = fetchImpl.mock.calls.map(([input]) => String(input)).find(
      (url) => url.includes("/actions/workflows/353312302/runs?"),
    );
    expect(historyUrl).toBeDefined();
    expect(historyUrl).not.toContain("event=");
  });

  it("authenticates the fresh reviewed successor and full d272-to-Q chain", async () => {
    const current = containmentRun({
      created_at: "2026-09-08T18:58:00Z",
      run_started_at: "2026-09-08T18:58:00Z",
      updated_at: "2026-09-08T18:59:00Z",
    });
    const authority = await verifyPostQReviewedCandidateV2(
      reviewedCandidateFetchV2(),
      TOKEN,
      CANDIDATE,
      current,
      Date.parse("2026-09-08T18:59:00.000Z"),
    );
    expect(authority).toMatchObject({
      schemaVersion: POST_Q_REVIEWED_CANDIDATE_V2_SCHEMA,
      candidateSha: CANDIDATE,
      directParentSha: "d27275f4c101b764c6016e8b378969c14719258e",
      successorPolicySha256:
        "5f4c4bc20c8ef68ed77f51ad92a11cede00122e3274e4408eb8ea858d6a07e4b",
      predecessorBridge: {
        candidateSha: "d27275f4c101b764c6016e8b378969c14719258e",
        soleParentSha: RECOVERY_BRIDGE_SHA,
        recoveryCandidateSha: RECOVERY_BRIDGE_SHA,
        recoveryTreeSha: RECOVERY_BRIDGE_TREE,
        recoverySoleParentSha: Q_SHA,
        pullRequestNumber: 98,
        reviewedTreeExact: true,
      },
      authorization: {
        sourceSizeBytes: 267,
        sourceSerialization: "JSON.stringify(value,null,2)+LF",
      },
      deadlinePolicy: {
        derivedDeadline: "2026-09-08T20:28:00.000Z",
        rederiveImmediatelyBeforeWriter: true,
        expirySuppressesPostWriteReconciliation: false,
        expirySuppressesFinalization: false,
      },
    });
    const source = `${JSON.stringify(authority, null, 2)}\n`;
    expect(parsePostQDeploymentStopReviewedAuthorityV2(source, {
      candidateSha: CANDIDATE,
      runId: CURRENT_RUN_ID,
    })).not.toBeNull();
  });

  it("rejects a PR98 reviewed-head tree substitution", async () => {
    const current = containmentRun({
      created_at: "2026-09-08T18:58:00Z",
      run_started_at: "2026-09-08T18:58:00Z",
    });
    await expect(verifyPostQReviewedCandidateV2(
      reviewedCandidateFetchV2("b".repeat(40)),
      TOKEN,
      CANDIDATE,
      current,
      Date.parse("2026-09-08T18:59:00.000Z"),
    )).rejects.toThrow("post_q_authority_reviewed_candidate_invalid");
  });

  it("fails v2 closed when unfiltered workflow history contains a third row", async () => {
    const current = containmentRun({
      created_at: "2026-09-09T06:00:00Z",
      run_started_at: "2026-09-09T06:00:00Z",
    });
    const third = containmentRun({
      id: 34_239_999_999,
      run_number: 3,
      status: "completed",
      conclusion: "cancelled",
    });
    await expect(verifyPermanentStagingPostQAuthorityV2({
      argv: argumentsFor(),
      env: {
        ...environment(),
        PINTPATH_POST_Q_DEPLOYMENT_STOP_V2_AUTHORIZATION_ID:
          "pintpath-post-q-staging-stop-reauthorization-2026-09-09/v2",
        PINTPATH_POST_Q_DEPLOYMENT_STOP_V2_AUTHORIZATION_SOURCE_SHA256:
          "4203affc634766c1ba695c969448d8c126552d1c16ffb090e2a55d5f319a0779",
      },
      fetchImpl: githubFetch({
        currentRun: current,
        containmentRuns: {
          total_count: 3,
          workflow_runs: [current, third, recoveryBridgeRun()],
        },
        historicalWorkflow: { type: "fixture-validated-by-override" },
      }),
      historicalWorkflowExact: vi.fn(() => true),
    })).rejects.toThrow("post_q_authority_containment_history_invalid");
  });

  it("fails v2 before any API call on run attempt two", async () => {
    const fetchImpl = githubFetch();
    await expect(verifyPermanentStagingPostQAuthorityV2({
      argv: argumentsFor(),
      env: {
        ...environment(),
        GITHUB_RUN_ATTEMPT: "2",
        PINTPATH_POST_Q_DEPLOYMENT_STOP_V2_AUTHORIZATION_ID:
          "pintpath-post-q-staging-stop-reauthorization-2026-09-09/v2",
        PINTPATH_POST_Q_DEPLOYMENT_STOP_V2_AUTHORIZATION_SOURCE_SHA256:
          "4203affc634766c1ba695c969448d8c126552d1c16ffb090e2a55d5f319a0779",
      },
      fetchImpl,
    })).rejects.toThrow("post_q_authority_environment_invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails v2 when the current writer has started", async () => {
    const current = containmentRun({
      created_at: "2026-09-09T06:00:00Z",
      run_started_at: "2026-09-09T06:00:00Z",
    });
    const jobs = applyPhaseCurrentJobs("queued");
    const writer = jobs.jobs[1]!;
    writer.steps[0] = {
      ...writer.steps[0]!,
      status: "in_progress",
      started_at: "2026-09-09T06:01:00Z",
    };
    await expect(verifyPermanentStagingPostQAuthorityV2({
      argv: argumentsFor(),
      env: {
        ...environment(),
        PINTPATH_POST_Q_DEPLOYMENT_STOP_V2_AUTHORIZATION_ID:
          "pintpath-post-q-staging-stop-reauthorization-2026-09-09/v2",
        PINTPATH_POST_Q_DEPLOYMENT_STOP_V2_AUTHORIZATION_SOURCE_SHA256:
          "4203affc634766c1ba695c969448d8c126552d1c16ffb090e2a55d5f319a0779",
      },
      fetchImpl: githubFetch({
        currentRun: current,
        containmentRuns: {
          total_count: 2,
          workflow_runs: [current, recoveryBridgeRun()],
        },
        currentJobs: jobs,
        historicalWorkflow: { type: "fixture-validated-by-override" },
      }),
      historicalWorkflowExact: vi.fn(() => true),
    })).rejects.toThrow("post_q_authority_containment_authority_consumed");
  });

  it("fails v2 when the current writer has completed", async () => {
    const current = containmentRun({
      created_at: "2026-09-09T06:00:00Z",
      run_started_at: "2026-09-09T06:00:00Z",
    });
    const jobs = applyPhaseCurrentJobs("queued");
    const writer = jobs.jobs[1]!;
    writer.steps[0] = {
      ...writer.steps[0]!,
      status: "completed",
      conclusion: "success",
      started_at: "2026-09-09T06:01:00Z",
      completed_at: "2026-09-09T06:01:01Z",
    };
    await expect(verifyPermanentStagingPostQAuthorityV2({
      argv: argumentsFor(),
      env: {
        ...environment(),
        PINTPATH_POST_Q_DEPLOYMENT_STOP_V2_AUTHORIZATION_ID:
          "pintpath-post-q-staging-stop-reauthorization-2026-09-09/v2",
        PINTPATH_POST_Q_DEPLOYMENT_STOP_V2_AUTHORIZATION_SOURCE_SHA256:
          "4203affc634766c1ba695c969448d8c126552d1c16ffb090e2a55d5f319a0779",
      },
      fetchImpl: githubFetch({
        currentRun: current,
        containmentRuns: {
          total_count: 2,
          workflow_runs: [current, recoveryBridgeRun()],
        },
        currentJobs: jobs,
        historicalWorkflow: { type: "fixture-validated-by-override" },
      }),
      historicalWorkflowExact: vi.fn(() => true),
    })).rejects.toThrow("post_q_authority_containment_authority_consumed");
  });
});
