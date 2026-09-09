import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  derivePostQDeploymentStopV4Deadline,
  parsePostQDeploymentStopAuthorityV4,
  parsePostQDeploymentStopReviewedAuthorityV4,
  postQDeploymentStopV4ConfirmationExact,
  postQDeploymentStopV4DeadlineExact,
} from "../scripts/lib/permanent-staging-post-q-deployment-stop-authority-v4.js";
import {
  authorizationSourceExact,
  currentWorkflowAuthorityEvidence,
  currentWriterNotStarted,
  deriveSuccessorDeadline as deriveV4VerifierDeadline,
  failedV3ArtifactsExact,
  failedV3RunExact,
  historicalWorkflowBlobExact,
  POST_Q_ARTIFACT_MEMBERS,
  POST_Q_REVIEWED_CANDIDATE_V4_SCHEMA,
  successorPolicyExact,
  verifyDownloadedArtifact,
  verifyPermanentStagingPostQAuthorityV4,
  verifyPostQReviewedCandidate as verifyPostQReviewedCandidateV4,
} from "../scripts/verify-permanent-staging-post-q-authority-v4.mjs";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const hash = (source: string) =>
  crypto.createHash("sha256").update(source).digest("hex");
const candidateSha = "a".repeat(40);
const reviewedHeadSha = "c".repeat(40);
const reviewedTreeSha = "d".repeat(40);
const currentRunId = 34_310_000_000;
const failedV3CandidateSha =
  "c6f0f66302a96086c5a60962224af739050e8ff1";
const v2CandidateSha = "78162cf42a0ef3190343a657ff94f288d4a4c7ca";
const preV2CandidateSha = "d27275f4c101b764c6016e8b378969c14719258e";
const expiredRunHeadSha = "f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7";
const qHeadSha = "606d33facb515dd10bc94c360e43c20beb999cc1";
const repository = "blackmagic30/Beer";
const repositoryId = 1_215_862_300;
const actorId = 29_029_791;
const v4RequiredChecks = [
  ["postgres-tool-runtime-closure-observation", ".github/workflows/ci.yml"],
  ["postgres-migration-integration", ".github/workflows/ci.yml"],
  ["build-test-scan", ".github/workflows/ci.yml"],
  ["supabase-database", ".github/workflows/ci.yml"],
  ["CodeQL JavaScript and TypeScript", ".github/workflows/codeql.yml"],
  ["CodeQL Swift", ".github/workflows/codeql.yml"],
  ["release-readiness", ".github/workflows/pintpath-release-readiness.yml"],
  ["ios", ".github/workflows/native-apps.yml"],
] as const;
const v4Artifacts = new Map([
  ["postgres-migration-integration", "pintpath-mission-discovery-scale-evidence"],
  [
    "postgres-tool-runtime-closure-observation",
    "pintpath-postgres-tool-runtime-closure-v4-observation",
  ],
  ["release-readiness", "pintpath-automated-readiness-evidence"],
]);

function exactRepository() {
  return { id: repositoryId, full_name: repository };
}

function exactActor() {
  return { id: actorId, login: "blackmagic30" };
}

function v4CurrentRun() {
  const title = `Permanent staging post-Q deployment stop | ${candidateSha}`;
  return {
    id: currentRunId,
    workflow_id: 353_312_302,
    run_number: 3,
    run_attempt: 1,
    name: title,
    display_title: title,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
    head_branch: "main",
    head_sha: candidateSha,
    path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
    repository: exactRepository(),
    head_repository: exactRepository(),
    actor: exactActor(),
    triggering_actor: exactActor(),
    created_at: "2026-09-09T06:00:00Z",
    run_started_at: "2026-09-09T06:00:00Z",
    updated_at: "2026-09-09T06:01:00Z",
  };
}

function archivedV2WorkflowFixture() {
  const bytes = execFileSync("git", [
    "show",
    `${v2CandidateSha}:.github/workflows/stop-permanent-staging-post-q-deployment.yml`,
  ], { cwd: root });
  return {
    type: "file",
    path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
    sha: "6633205b7fdf36edae8986d6fa08c9a48e8a95c9",
    size: 30_062,
    encoding: "base64",
    content: bytes.toString("base64"),
  };
}

function ineligibleV2JobsFixture() {
  const rows = [
    [
      102_246_920_048,
      "supabase-database",
      "2026-09-08T21:35:34Z",
      "2026-09-08T21:37:47Z",
      "success",
    ],
    [
      102_246_920_166,
      "postgres-tool-runtime-closure-observation",
      "2026-09-08T21:35:35Z",
      "2026-09-08T21:36:06Z",
      "success",
    ],
    [
      102_247_091_137,
      "postgres-migration-integration",
      "2026-09-08T21:36:08Z",
      "2026-09-08T21:39:19Z",
      "success",
    ],
    [
      102_248_030_722,
      "build-test-scan",
      "2026-09-08T21:39:21Z",
      "2026-09-08T21:43:25Z",
      "failure",
    ],
  ] as const;
  return {
    total_count: 4,
    jobs: rows.map(([id, name, startedAt, completedAt, conclusion]) => ({
      id,
      name,
      run_id: 34_281_452_199,
      run_attempt: 1,
      workflow_name: "CI",
      head_sha: v2CandidateSha,
      status: "completed",
      conclusion,
      started_at: startedAt,
      completed_at: completedAt,
      steps: id === 102_248_030_722
        ? [
          {
            number: 8,
            name: "Build, test, and scan",
            status: "completed",
            conclusion: "success",
            started_at: "2026-09-08T21:39:51Z",
            completed_at: "2026-09-08T21:43:06Z",
          },
          {
            number: 11,
            name: "Dependency audit",
            status: "completed",
            conclusion: "failure",
            started_at: "2026-09-08T21:43:22Z",
            completed_at: "2026-09-08T21:43:23Z",
          },
        ]
        : [],
    })),
  };
}

function v4ProviderFixtures() {
  return {
    currentPullSummary: [{
      number: 103,
      state: "closed",
      merge_commit_sha: candidateSha,
      base: { ref: "main", repo: { full_name: repository } },
      head: { repo: { full_name: repository } },
    }],
    currentPull: {
      number: 103,
      state: "closed",
      merged: true,
      draft: false,
      merge_commit_sha: candidateSha,
      merged_at: "2026-09-09T05:30:00Z",
      head: {
        sha: reviewedHeadSha,
        repo: { full_name: repository },
      },
      base: { ref: "main", repo: { full_name: repository } },
      user: exactActor(),
      merged_by: exactActor(),
    },
    currentCommit: {
      sha: candidateSha,
      tree: { sha: reviewedTreeSha },
      parents: [{ sha: failedV3CandidateSha }],
    },
    currentReviewedHead: {
      sha: reviewedHeadSha,
      tree: { sha: reviewedTreeSha },
      parents: [{ sha: failedV3CandidateSha }],
    },
    failedV3Commit: {
      sha: failedV3CandidateSha,
      tree: { sha: "73028c14f816ed9599606add3d131a25737db2d2" },
      parents: [{ sha: v2CandidateSha }],
    },
    v2Commit: {
      sha: v2CandidateSha,
      tree: { sha: "410fd437bb0c459049f08bbff63ee605f2e65c9e" },
      parents: [{ sha: preV2CandidateSha }],
    },
    preV2Commit: {
      sha: preV2CandidateSha,
      tree: { sha: "53808bdd995a6ff1d2204e01f7639b103dbd5a76" },
      parents: [{ sha: expiredRunHeadSha }],
    },
    expiredRunHeadCommit: {
      sha: expiredRunHeadSha,
      tree: { sha: "9978dca9491f7bf7bee77ce39debe1f713e89c53" },
      parents: [{ sha: qHeadSha }],
    },
    preV2ReviewedHead: {
      sha: "3ab064f5026a923b42bf67dbd94cb5d16f125c0d",
      tree: { sha: "53808bdd995a6ff1d2204e01f7639b103dbd5a76" },
      parents: [{ sha: expiredRunHeadSha }],
    },
    preV2Pull: {
      number: 98,
      state: "closed",
      merged: true,
      merged_at: "2026-09-08T18:23:44Z",
      merge_commit_sha: preV2CandidateSha,
      head: {
        sha: "3ab064f5026a923b42bf67dbd94cb5d16f125c0d",
        repo: { full_name: repository },
      },
      base: {
        ref: "main",
        sha: expiredRunHeadSha,
        repo: { full_name: repository },
      },
      user: exactActor(),
      merged_by: exactActor(),
    },
    mainReference: {
      ref: "refs/heads/main",
      object: { type: "commit", sha: candidateSha },
    },
    ineligiblePull: {
      number: 99,
      state: "closed",
      merged: true,
      merged_at: "2026-09-08T21:35:27Z",
      merge_commit_sha: v2CandidateSha,
      head: {
        sha: "3b844ce9e5839251552419c3610a797bd1a1f3c7",
        repo: { full_name: repository },
      },
      base: {
        ref: "main",
        sha: preV2CandidateSha,
        repo: { full_name: repository },
      },
      user: exactActor(),
      merged_by: exactActor(),
    },
    ineligibleReviewedHead: {
      sha: "3b844ce9e5839251552419c3610a797bd1a1f3c7",
      tree: { sha: "410fd437bb0c459049f08bbff63ee605f2e65c9e" },
      parents: [{ sha: preV2CandidateSha }],
    },
    ineligibleRun: {
      id: 34_281_452_199,
      workflow_id: 275_221_294,
      path: ".github/workflows/ci.yml",
      run_number: 563,
      run_attempt: 1,
      check_suite_id: 92_869_213_373,
      event: "push",
      status: "completed",
      conclusion: "failure",
      head_branch: "main",
      head_sha: v2CandidateSha,
      created_at: "2026-09-08T21:35:31Z",
      run_started_at: "2026-09-08T21:35:31Z",
      updated_at: "2026-09-08T21:43:26Z",
      repository: exactRepository(),
      head_repository: exactRepository(),
      actor: exactActor(),
      triggering_actor: exactActor(),
    },
    ineligibleJobs: ineligibleV2JobsFixture(),
    archivedWorkflow: archivedV2WorkflowFixture(),
  };
}

type V4ProviderFixtures = ReturnType<typeof v4ProviderFixtures>;

const prepareStepNames = [
  [1, "Set up job"],
  [2, "Checkout the exact main candidate without persisted credentials"],
  [3, "Require exact one-attempt staging-only containment authority"],
  [4, "Setup the repository Node runtime"],
  [5, "Install immutable dependencies"],
  [6, "Run the complete repository gate before provider-token custody"],
  [7, "Create private Q, intent, and evidence custody"],
  [8, "Download the exact failed V3 durable intent artifact"],
  [9, "Download the exact failed V3 terminal evidence artifact"],
  [10, "Download the exact immutable failed-Q artifact"],
  [11, "Authenticate the exact failed Q run, sole writer, and artifact bytes"],
  [12, "Prepare the exact post-Q stop intent with metadata credentials only"],
  [13, "Persist the exact stop intent before any stop credential exists"],
  [14, "Remove prepare Q custody"],
  [27, "Post Setup the repository Node runtime"],
  [28, "Post Checkout the exact main candidate without persisted credentials"],
  [29, "Complete job"],
] as const;

const applyStepNames = [
  [1, "Set up job"],
  [2, "Checkout the exact main candidate without persisted credentials"],
  [3, "Require exact apply authority and durable-intent outputs"],
  [4, "Setup the repository Node runtime"],
  [5, "Install immutable dependencies"],
  [6, "Run the complete repository gate again before the sole writer"],
  [7, "Create private Q, intent, and terminal evidence custody"],
  [8, "Download the exact failed V3 durable intent artifact again"],
  [9, "Download the exact failed V3 terminal evidence artifact again"],
  [10, "Download the exact immutable failed-Q artifact again"],
  [11, "Reauthenticate the exact failed Q run and artifact"],
  [12, "Download the exact durable stop intent"],
  [13, "Bind the exact durable intent artifact before the writer"],
  [14, "Download a fresh exact failed-Q artifact for immediate reassertion"],
  [15, "Prove the production-staging boundary in a metadata-only process"],
  [16, "Reassert current main, Q authority, and intent immediately before the writer"],
  [17, "Stop the exact accidental staging deployment once"],
  [18, "Reconcile the Railway production-staging mutation boundary"],
  [19, "Finalize the outer durable receipt without any provider credential"],
  [20, "Require terminal evidence after every writer outcome"],
  [21, "Remove downloaded Q and intent custody"],
  [22, "Upload bounded secret-free stop intent and terminal evidence"],
  [43, "Post Setup the repository Node runtime"],
  [44, "Post Checkout the exact main candidate without persisted credentials"],
  [45, "Complete job"],
] as const;

function currentSteps(
  names: ReadonlyArray<readonly [number, string]>,
  checkpoint: number,
) {
  return names.map(([number, name]) => number < checkpoint
    ? {
      number,
      name,
      status: "completed",
      conclusion: "success",
      started_at: "2026-09-09T06:00:00Z",
      completed_at: "2026-09-09T06:00:01Z",
    }
    : number === checkpoint
    ? {
      number,
      name,
      status: "in_progress",
      conclusion: null,
      started_at: "2026-09-09T06:00:02Z",
      completed_at: null,
    }
    : {
      number,
      name,
      status: "pending",
      conclusion: null,
      started_at: null,
      completed_at: null,
    });
}

function applyPhaseJobs(checkpoint: 11 | 16) {
  return [
    {
      id: 102_500_000_001,
      run_id: currentRunId,
      run_attempt: 1,
      name: "Authenticate Q and persist the exact stop intent",
      status: "completed",
      conclusion: "success",
      started_at: "2026-09-09T05:00:00Z",
      completed_at: "2026-09-09T05:30:00Z",
      steps: [],
    },
    {
      id: 102_500_000_002,
      run_id: currentRunId,
      run_attempt: 1,
      name: "Stop the one exact accidental staging deployment",
      status: "in_progress",
      conclusion: null,
      started_at: "2026-09-09T05:31:00Z",
      completed_at: null,
      steps: currentSteps(applyStepNames, checkpoint),
    },
  ];
}

function preparePhaseJobs() {
  return [
    {
      id: 102_500_000_001,
      run_id: currentRunId,
      run_attempt: 1,
      name: "Authenticate Q and persist the exact stop intent",
      status: "in_progress",
      conclusion: null,
      started_at: "2026-09-09T05:00:00Z",
      completed_at: null,
      steps: currentSteps(prepareStepNames, 11),
    },
    {
      id: 102_500_000_002,
      run_id: currentRunId,
      run_attempt: 1,
      name: "Stop the one exact accidental staging deployment",
      status: "queued",
      conclusion: null,
      started_at: null,
      completed_at: null,
      steps: [],
    },
  ];
}

const failedV3PrepareRows = [
  [1, "Set up job", "success", "2026-09-09T02:50:03Z", "2026-09-09T02:50:05Z"],
  [2, "Checkout the exact main candidate without persisted credentials", "success", "2026-09-09T02:50:05Z", "2026-09-09T02:50:09Z"],
  [3, "Require exact one-attempt staging-only containment authority", "success", "2026-09-09T02:50:09Z", "2026-09-09T02:50:10Z"],
  [4, "Setup the repository Node runtime", "success", "2026-09-09T02:50:10Z", "2026-09-09T02:50:14Z"],
  [5, "Install immutable dependencies", "success", "2026-09-09T02:50:14Z", "2026-09-09T02:50:18Z"],
  [6, "Run the complete repository gate before provider-token custody", "success", "2026-09-09T02:50:18Z", "2026-09-09T02:53:32Z"],
  [7, "Create private Q, intent, and evidence custody", "success", "2026-09-09T02:53:32Z", "2026-09-09T02:53:32Z"],
  [8, "Download the exact immutable failed-Q artifact", "success", "2026-09-09T02:53:32Z", "2026-09-09T02:53:33Z"],
  [9, "Authenticate the exact failed Q run, sole writer, and artifact bytes", "success", "2026-09-09T02:53:33Z", "2026-09-09T02:53:40Z"],
  [10, "Prepare the exact post-Q stop intent with metadata credentials only", "success", "2026-09-09T02:53:40Z", "2026-09-09T02:53:42Z"],
  [11, "Persist the exact stop intent before any stop credential exists", "success", "2026-09-09T02:53:42Z", "2026-09-09T02:53:43Z"],
  [12, "Remove prepare Q custody", "success", "2026-09-09T02:53:43Z", "2026-09-09T02:53:43Z"],
  [23, "Post Setup the repository Node runtime", "success", "2026-09-09T02:53:43Z", "2026-09-09T02:53:43Z"],
  [24, "Post Checkout the exact main candidate without persisted credentials", "success", "2026-09-09T02:53:43Z", "2026-09-09T02:53:43Z"],
  [25, "Complete job", "success", "2026-09-09T02:53:43Z", "2026-09-09T02:53:43Z"],
] as const;

const failedV3ApplyRows = [
  [1, "Set up job", "success", "2026-09-09T02:53:49Z", "2026-09-09T02:53:50Z"],
  [2, "Checkout the exact main candidate without persisted credentials", "success", "2026-09-09T02:53:50Z", "2026-09-09T02:53:53Z"],
  [3, "Require exact apply authority and durable-intent outputs", "success", "2026-09-09T02:53:53Z", "2026-09-09T02:53:53Z"],
  [4, "Setup the repository Node runtime", "success", "2026-09-09T02:53:53Z", "2026-09-09T02:53:54Z"],
  [5, "Install immutable dependencies", "success", "2026-09-09T02:53:54Z", "2026-09-09T02:53:59Z"],
  [6, "Run the complete repository gate again before the sole writer", "success", "2026-09-09T02:53:59Z", "2026-09-09T02:58:03Z"],
  [7, "Create private Q, intent, and terminal evidence custody", "success", "2026-09-09T02:58:03Z", "2026-09-09T02:58:03Z"],
  [8, "Download the exact immutable failed-Q artifact again", "success", "2026-09-09T02:58:03Z", "2026-09-09T02:58:04Z"],
  [9, "Reauthenticate the exact failed Q run and artifact", "failure", "2026-09-09T02:58:04Z", "2026-09-09T02:58:05Z"],
  [10, "Download the exact durable stop intent", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"],
  [11, "Bind the exact durable intent artifact before the writer", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"],
  [12, "Download a fresh exact failed-Q artifact for immediate reassertion", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"],
  [13, "Prove the production-staging boundary in a metadata-only process", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"],
  [14, "Reassert current main, Q authority, and intent immediately before the writer", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"],
  [15, "Stop the exact accidental staging deployment once", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"],
  [16, "Reconcile the Railway production-staging mutation boundary", "success", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"],
  [17, "Finalize the outer durable receipt without any provider credential", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"],
  [18, "Require terminal evidence after every writer outcome", "skipped", "2026-09-09T02:58:05Z", "2026-09-09T02:58:05Z"],
  [19, "Remove downloaded Q and intent custody", "success", "2026-09-09T02:58:05Z", "2026-09-09T02:58:06Z"],
  [20, "Upload bounded secret-free stop intent and terminal evidence", "success", "2026-09-09T02:58:06Z", "2026-09-09T02:58:06Z"],
  [39, "Post Setup the repository Node runtime", "skipped", "2026-09-09T02:58:06Z", "2026-09-09T02:58:06Z"],
  [40, "Post Checkout the exact main candidate without persisted credentials", "success", "2026-09-09T02:58:06Z", "2026-09-09T02:58:06Z"],
  [41, "Complete job", "success", "2026-09-09T02:58:06Z", "2026-09-09T02:58:06Z"],
] as const;

function completedSteps(rows: ReadonlyArray<readonly [number, string, string, string, string]>) {
  return rows.map(([number, name, conclusion, startedAt, completedAt]) => ({
    number,
    name,
    status: "completed",
    conclusion,
    started_at: startedAt,
    completed_at: completedAt,
  }));
}

function failedV3RunFixture() {
  const title = `Permanent staging post-Q deployment stop | ${failedV3CandidateSha}`;
  return {
    id: 34_304_764_597,
    workflow_id: 353_312_302,
    check_suite_id: 92_929_472_980,
    run_number: 2,
    run_attempt: 1,
    name: title,
    display_title: title,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    head_sha: failedV3CandidateSha,
    path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
    created_at: "2026-09-09T02:49:57Z",
    run_started_at: "2026-09-09T02:49:57Z",
    updated_at: "2026-09-09T02:58:09Z",
    repository: exactRepository(),
    head_repository: exactRepository(),
    actor: exactActor(),
    triggering_actor: exactActor(),
  };
}

function failedV3JobsFixture() {
  const workflowName =
    `Permanent staging post-Q deployment stop | ${failedV3CandidateSha}`;
  return {
    total_count: 2,
    jobs: [
      {
        id: 102_319_052_311,
        run_id: 34_304_764_597,
        run_attempt: 1,
        workflow_name: workflowName,
        head_sha: failedV3CandidateSha,
        name: "Authenticate Q and persist the exact stop intent",
        status: "completed",
        conclusion: "success",
        created_at: "2026-09-09T02:49:58Z",
        started_at: "2026-09-09T02:50:02Z",
        completed_at: "2026-09-09T02:53:45Z",
        steps: completedSteps(failedV3PrepareRows),
      },
      {
        id: 102_319_762_173,
        run_id: 34_304_764_597,
        run_attempt: 1,
        workflow_name: workflowName,
        head_sha: failedV3CandidateSha,
        name: "Stop the one exact accidental staging deployment",
        status: "completed",
        conclusion: "failure",
        created_at: "2026-09-09T02:53:46Z",
        started_at: "2026-09-09T02:53:49Z",
        completed_at: "2026-09-09T02:58:08Z",
        steps: completedSteps(failedV3ApplyRows),
      },
    ],
  };
}

function failedV3ArtifactsFixture() {
  const common = {
    expired: false,
    workflow_run: {
      id: 34_304_764_597,
      repository_id: repositoryId,
      head_repository_id: repositoryId,
      head_branch: "main",
      head_sha: failedV3CandidateSha,
    },
  };
  return {
    total_count: 2,
    artifacts: [
      {
        ...common,
        id: 10_086_316_260,
        name: `pintpath-permanent-staging-post-q-deployment-stop-intent-${failedV3CandidateSha}-34304764597`,
        size_in_bytes: 2_507,
        digest: "sha256:e6882bd5bd659f2d95de84a8163be011722a96802b3a08a2e8eea4216fdd8766",
        created_at: "2026-09-09T02:53:43Z",
        updated_at: "2026-09-09T02:53:43Z",
        expires_at: "2026-10-09T02:53:42Z",
      },
      {
        ...common,
        id: 10_086_412_037,
        name: `pintpath-permanent-staging-post-q-deployment-stop-${failedV3CandidateSha}-34304764597`,
        size_in_bytes: 471,
        digest: "sha256:49c92825d47b7c90b3aba605c12b9643990c9091b7b6dac0d207fb57e665d4eb",
        created_at: "2026-09-09T02:58:06Z",
        updated_at: "2026-09-09T02:58:06Z",
        expires_at: "2026-10-09T02:58:06Z",
      },
    ],
  };
}

function recoveryRunFixture() {
  const title =
    "Permanent staging post-Q deployment stop | f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7";
  return {
    id: 34_255_228_036,
    workflow_id: 353_312_302,
    check_suite_id: 92_795_131_798,
    run_number: 1,
    run_attempt: 1,
    name: title,
    display_title: title,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    head_sha: "f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7",
    path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
    created_at: "2026-09-08T17:07:48Z",
    run_started_at: "2026-09-08T17:07:48Z",
    updated_at: "2026-09-08T17:12:11Z",
    repository: exactRepository(),
    head_repository: exactRepository(),
    actor: exactActor(),
    triggering_actor: exactActor(),
  };
}

function recoveryJobsFixture() {
  const headSha = "f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7";
  const workflowName = `Permanent staging post-Q deployment stop | ${headSha}`;
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
  return {
    total_count: 2,
    jobs: [
      {
        id: 102_159_216_963,
        run_id: 34_255_228_036,
        run_attempt: 1,
        workflow_name: workflowName,
        head_sha: headSha,
        name: "Authenticate Q and persist the exact stop intent",
        status: "completed",
        conclusion: "failure",
        created_at: "2026-09-08T17:07:50Z",
        started_at: "2026-09-08T17:07:53Z",
        completed_at: "2026-09-08T17:12:10Z",
        steps: completedSteps(rows),
      },
      {
        id: 102_160_681_336,
        run_id: 34_255_228_036,
        run_attempt: 1,
        workflow_name: workflowName,
        head_sha: headSha,
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

const qTargetRows = [
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

function qRunFixture() {
  const title =
    "Permanent staging cold recovery | quiesce | 606d33facb515dd10bc94c360e43c20beb999cc1";
  return {
    id: 34_229_745_722,
    workflow_id: 344_383_802,
    run_number: 13,
    run_attempt: 1,
    name: title,
    display_title: title,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    head_sha: "606d33facb515dd10bc94c360e43c20beb999cc1",
    path: ".github/workflows/recover-permanent-staging-cold-zero.yml",
    created_at: "2026-09-08T13:04:29Z",
    run_started_at: "2026-09-08T13:04:29Z",
    updated_at: "2026-09-08T13:10:47Z",
    repository: exactRepository(),
  };
}

function qJobsFixture() {
  const steps = qTargetRows.map(([number, name, conclusion], index) => ({
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
  return {
    total_count: 4,
    jobs: [
      {
        id: 102_072_625_320,
        name: "Quiesce the configured Europe replica from one to zero",
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        started_at: "2026-09-08T13:04:34Z",
        completed_at: "2026-09-08T13:10:46Z",
        steps,
      },
      ...[
        [102_072_626_482, "Bind the exact replacement and prepare the dead baseline"],
        [102_072_626_886, "Reconcile an ambiguous cold prepare at the exact dead baseline"],
        [102_072_656_578, "Reconcile an ambiguous cold quiesce at exact zero"],
      ].map(([id, name]) => ({
        id,
        name,
        run_attempt: 1,
        status: "completed",
        conclusion: "skipped",
        steps: [],
      })),
    ],
  };
}

function qArtifactFixture() {
  return {
    id: 10_057_495_901,
    name:
      "pintpath-permanent-staging-cold-quiesce-606d33facb515dd10bc94c360e43c20beb999cc1",
    size_in_bytes: 12_561,
    digest:
      "sha256:32a404cdd7078dc04d4b2531deec460dd4f44b4309fe35d873c8bcd46a367c4b",
    expired: false,
    created_at: "2026-09-08T13:10:43Z",
    updated_at: "2026-09-08T13:10:43Z",
    expires_at: "2026-10-08T13:10:42Z",
    workflow_run: {
      id: 34_229_745_722,
      repository_id: repositoryId,
      head_repository_id: repositoryId,
      head_branch: "main",
      head_sha: "606d33facb515dd10bc94c360e43c20beb999cc1",
    },
  };
}

function v4AuthorityEnvironment() {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: candidateSha,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: String(currentRunId),
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_TOKEN: "github-test-token-with-safe-length",
    PINTPATH_PROTECTED_ENVIRONMENT: "permanent-staging-scale-evidence",
    PINTPATH_POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_ID:
      "pintpath-post-q-staging-stop-reauthorization-2026-09-09/v4",
    PINTPATH_POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_SOURCE_SHA256:
      "ccaf9c49e38f97368f6187d7c3ff1c853cffe8334fdfaf3478835c7e93f4028c",
    PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:
      "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN",
  };
}

function v4AuthorityArguments(
  phase: "prepare" | "apply-reauth" | "apply-prewrite",
) {
  return [
    "--phase", phase,
    "--candidate-sha", candidateSha,
    "--q-run-id", "34229745722",
    "--q-artifact-id", "10057495901",
    "--failed-v3-intent-downloaded-dir",
    "/tmp/pintpath-v4-failed-intent/downloaded",
    "--failed-v3-evidence-downloaded-dir",
    "/tmp/pintpath-v4-failed-evidence/downloaded",
    "--downloaded-dir", "/tmp/pintpath-v4-q/downloaded",
    "--output-dir", "/tmp/pintpath-v4-q",
  ];
}

type V4AuthorityOverrides = {
  currentRun?: unknown;
  history?: unknown;
  currentJobs?: unknown;
  failedV3Run?: unknown;
  failedV3Jobs?: unknown;
  failedV3Artifacts?: unknown;
};

function v4AuthorityFetch(overrides: V4AuthorityOverrides = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer github-test-token-with-safe-length",
    );
    const url = new URL(String(input));
    const target = `${url.pathname}${url.search}`;
    let value: unknown;
    if (target.endsWith("/actions/runs/34229745722")) {
      value = qRunFixture();
    } else if (target.endsWith("/actions/runs/34229745722/jobs?per_page=100")) {
      value = qJobsFixture();
    } else if (target.endsWith("/actions/artifacts/10057495901")) {
      value = qArtifactFixture();
    } else if (target.endsWith(`/actions/runs/${currentRunId}`)) {
      value = overrides.currentRun ?? v4CurrentRun();
    } else if (target.endsWith("/actions/runs/34255228036")) {
      value = recoveryRunFixture();
    } else if (target.endsWith("/actions/runs/34304764597")) {
      value = overrides.failedV3Run ?? failedV3RunFixture();
    } else if (target.includes(
      "/actions/runs/34255228036/artifacts?per_page=100&page=1",
    )) {
      value = { total_count: 0, artifacts: [] };
    } else if (target.includes(
      "/actions/runs/34304764597/artifacts?per_page=100&page=1",
    )) {
      value = overrides.failedV3Artifacts ?? failedV3ArtifactsFixture();
    } else if (target.endsWith("/actions/workflows/353312302")) {
      value = {
        id: 353_312_302,
        name: "Stop the exact post-Q permanent staging deployment",
        path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
        state: "active",
      };
    } else if (target.includes("/actions/workflows/353312302/runs?")) {
      value = overrides.history ?? {
        total_count: 3,
        workflow_runs: [
          v4CurrentRun(),
          failedV3RunFixture(),
          recoveryRunFixture(),
        ],
      };
    } else if (target.includes(
      `/actions/runs/${currentRunId}/attempts/1/jobs?`,
    )) {
      value = overrides.currentJobs ?? {
        total_count: 2,
        jobs: applyPhaseJobs(16),
      };
    } else if (target.includes(
      "/actions/runs/34304764597/attempts/1/jobs?",
    )) {
      value = overrides.failedV3Jobs ?? failedV3JobsFixture();
    } else if (target.includes(
      "/actions/runs/34255228036/attempts/1/jobs?",
    )) {
      value = recoveryJobsFixture();
    } else if (target.includes(
      "/contents/.github/workflows/stop-permanent-staging-post-q-deployment.yml?",
    )) {
      value = { type: "fixture-validated-by-override" };
    } else {
      throw new Error(`unexpected V4 authority fixture URL: ${target}`);
    }
    return new Response(JSON.stringify(value), { status: 200 });
  });
}

async function runV4Authority(
  phase: "prepare" | "apply-reauth" | "apply-prewrite",
  overrides: V4AuthorityOverrides = {},
) {
  let authoritySource = "";
  const fetchImpl = v4AuthorityFetch({
    ...overrides,
    currentJobs: overrides.currentJobs ?? {
      total_count: 2,
      jobs: phase === "prepare"
        ? preparePhaseJobs()
        : applyPhaseJobs(phase === "apply-reauth" ? 11 : 16),
    },
  });
  const result = await verifyPermanentStagingPostQAuthorityV4({
    argv: v4AuthorityArguments(phase),
    env: v4AuthorityEnvironment(),
    fetchImpl,
    historicalWorkflowExact: vi.fn(() => true),
    historicalV3WorkflowExact: vi.fn(() => true),
    sealArtifact: vi.fn(() => ({
      sealedDirectory: "/tmp/pintpath-v4-q/sealed",
      members: POST_Q_ARTIFACT_MEMBERS.map((member) => ({
        ...member,
        sealedPath: member.path,
      })),
    })),
    verifyArchivedArtifact: vi.fn((_directory, members) => ({
      members: members.map((member: Record<string, unknown>) => ({
        ...member,
        sealedPath: member.path,
      })),
    })),
    verifyCandidate: vi.fn(async () => ({
      schemaVersion: POST_Q_REVIEWED_CANDIDATE_V4_SCHEMA,
    })),
    writeAuthority: (_filename: string, source: string) => {
      authoritySource = source;
    },
    writeReviewedCandidate: vi.fn(),
    writeOutput: vi.fn(),
  });
  return { authoritySource, fetchImpl, result };
}

function v4ReviewedCandidateFetch(
  mutate?: (fixtures: V4ProviderFixtures) => void,
) {
  const fixtures = v4ProviderFixtures();
  mutate?.(fixtures);
  const checkByRun = new Map(v4RequiredChecks.map((row, index) => [
    34_300_000_000 + index,
    row,
  ]));
  return async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer github-test-token-with-safe-length",
    );
    const url = new URL(String(input));
    let value: unknown;
    if (url.pathname.endsWith(`/commits/${candidateSha}/pulls`)) {
      value = fixtures.currentPullSummary;
    } else if (url.pathname.endsWith("/pulls/103")) {
      value = fixtures.currentPull;
    } else if (url.pathname.endsWith(`/git/commits/${candidateSha}`)) {
      value = fixtures.currentCommit;
    } else if (url.pathname.endsWith(`/git/commits/${reviewedHeadSha}`)) {
      value = fixtures.currentReviewedHead;
    } else if (url.pathname.endsWith(`/git/commits/${failedV3CandidateSha}`)) {
      value = fixtures.failedV3Commit;
    } else if (url.pathname.endsWith(`/git/commits/${v2CandidateSha}`)) {
      value = fixtures.v2Commit;
    } else if (url.pathname.endsWith(`/git/commits/${preV2CandidateSha}`)) {
      value = fixtures.preV2Commit;
    } else if (url.pathname.endsWith(`/git/commits/${expiredRunHeadSha}`)) {
      value = fixtures.expiredRunHeadCommit;
    } else if (url.pathname.endsWith(
      "/git/commits/3ab064f5026a923b42bf67dbd94cb5d16f125c0d",
    )) {
      value = fixtures.preV2ReviewedHead;
    } else if (url.pathname.endsWith("/pulls/98")) {
      value = fixtures.preV2Pull;
    } else if (url.pathname.endsWith("/git/ref/heads/main")) {
      value = fixtures.mainReference;
    } else if (url.pathname.endsWith("/pulls/99")) {
      value = fixtures.ineligiblePull;
    } else if (url.pathname.endsWith(
      "/git/commits/3b844ce9e5839251552419c3610a797bd1a1f3c7",
    )) {
      value = fixtures.ineligibleReviewedHead;
    } else if (url.pathname.endsWith("/actions/runs/34281452199")) {
      value = fixtures.ineligibleRun;
    } else if (url.pathname.endsWith(
      "/actions/runs/34281452199/attempts/1/jobs",
    )) {
      value = fixtures.ineligibleJobs;
    } else if (url.pathname.endsWith(
      "/contents/.github/workflows/stop-permanent-staging-post-q-deployment.yml",
    )) {
      value = fixtures.archivedWorkflow;
    } else if (url.pathname.endsWith(`/commits/${candidateSha}/check-runs`)) {
      const name = url.searchParams.get("check_name")!;
      const index = v4RequiredChecks.findIndex(([expected]) => expected === name);
      const runId = 34_300_000_000 + index;
      value = {
        total_count: 1,
        check_runs: [{
          name,
          head_sha: candidateSha,
          status: "completed",
          conclusion: "success",
          app: { slug: "github-actions" },
          details_url:
            `https://github.com/${repository}/actions/runs/${runId}/job/1`,
          check_suite: { id: 93_000_000_000 + index },
          started_at: "2026-09-09T05:31:00Z",
          completed_at: "2026-09-09T05:45:00Z",
        }],
      };
    } else {
      const runMatch = /\/actions\/runs\/(\d+)$/u.exec(url.pathname);
      const artifactMatch = /\/actions\/runs\/(\d+)\/artifacts$/u.exec(
        url.pathname,
      );
      if (runMatch !== null) {
        const runId = Number(runMatch[1]);
        const [name, workflowPath] = checkByRun.get(runId)!;
        const index = v4RequiredChecks.findIndex(([expected]) =>
          expected === name);
        value = {
          id: runId,
          check_suite_id: 93_000_000_000 + index,
          head_sha: candidateSha,
          head_branch: "main",
          status: "completed",
          conclusion: "success",
          repository: { full_name: repository },
          head_repository: { full_name: repository },
          path: workflowPath,
          event: "push",
          workflow_id: 400_000_000 + index,
          run_attempt: 1,
          run_started_at: "2026-09-09T05:30:30Z",
        };
      } else if (artifactMatch !== null) {
        const runId = Number(artifactMatch[1]);
        const [producer] = checkByRun.get(runId)!;
        const name = v4Artifacts.get(producer)!;
        const artifactId = 11_000_000_000 + runId;
        value = {
          total_count: 1,
          artifacts: [{
            id: artifactId,
            name,
            expired: false,
            size_in_bytes: 100,
            digest: `sha256:${"f".repeat(64)}`,
            workflow_run: { head_sha: candidateSha, id: runId },
            archive_download_url:
              `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`,
          }],
        };
      } else {
        throw new Error(`unexpected V4 provider fixture URL: ${url}`);
      }
    }
    return new Response(JSON.stringify(value), { status: 200 });
  };
}

describe("failed-V3 successor post-Q staging containment v4", () => {
  it("binds the exact 613-byte reviewed provenance serialization", () => {
    const source = read(
      "ops/railway/permanent-staging-post-q-deployment-stop-authorization-v4.json",
    );
    expect(Buffer.byteLength(source)).toBe(613);
    expect(hash(source)).toBe(
      "ccaf9c49e38f97368f6187d7c3ff1c853cffe8334fdfaf3478835c7e93f4028c",
    );
    const value = JSON.parse(source);
    expect(source).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(value).toEqual({
      schemaVersion: "pintpath-reviewed-user-authorization-provenance/v2",
      threadId: "01a0840a-3590-74d1-9567-0e9eec01a9a4",
      messages: [
        "Codex was running for multiple days on two prompts and I had no clue what it did I just stopped them recently because they were eatting away at tokens and the logs were massive. Can you check what they had done, finish of what they were currently working on so there’s no error in the code or bug and tell me what it was doing",
      ],
      provenanceUse:
        "pintpath-post-q-staging-stop-successor-v4-reviewed-context",
      cryptographicUserSignatureClaimed: false,
    });
    expect(authorizationSourceExact(source)).toBe(true);
    expect(authorizationSourceExact(`${source}\n`)).toBe(false);
    expect(authorizationSourceExact(source.replace("eatting", "eating")))
      .toBe(false);
  });

  it("accepts the live pending writer and fails closed on queued or partial writer evidence", () => {
    const prepareJobs = preparePhaseJobs();
    expect(currentWriterNotStarted(prepareJobs, "prepare")).toBe(true);

    const reauth = applyPhaseJobs(11);
    const prewrite = applyPhaseJobs(16);
    expect(currentWriterNotStarted(reauth, "apply-reauth")).toBe(true);
    expect(currentWriterNotStarted(prewrite, "apply-prewrite")).toBe(true);

    const queuedWriter = structuredClone(reauth);
    queuedWriter[1]!.steps[16]!.status = "queued";
    expect(currentWriterNotStarted(queuedWriter, "apply-reauth")).toBe(false);

    const missingWriter = structuredClone(reauth);
    missingWriter[1]!.steps.splice(16, 1);
    expect(currentWriterNotStarted(missingWriter, "apply-reauth")).toBe(false);

    const timestampedWriter = structuredClone(prewrite);
    timestampedWriter[1]!.steps[16]!.started_at = "2026-09-09T06:00:03Z";
    expect(currentWriterNotStarted(timestampedWriter, "apply-prewrite"))
      .toBe(false);

    const unexpectedFutureStep = structuredClone(prewrite);
    unexpectedFutureStep[1]!.steps[17]!.name = "Unexpected executable step";
    expect(currentWriterNotStarted(unexpectedFutureStep, "apply-prewrite"))
      .toBe(false);
  });

  it("pins the exact failed V3 prewriter run and both artifact rows", () => {
    const run = failedV3RunFixture();
    const jobs = failedV3JobsFixture();
    const artifacts = failedV3ArtifactsFixture();
    expect(failedV3RunExact(run, jobs.jobs)).toBe(true);
    expect(failedV3ArtifactsExact(artifacts)).toBe(true);

    const failedStep = structuredClone(jobs.jobs);
    failedStep[1]!.steps[8]!.conclusion = "success";
    expect(failedV3RunExact(run, failedStep)).toBe(false);

    const startedWriter = structuredClone(jobs.jobs);
    startedWriter[1]!.steps[14]!.conclusion = "success";
    startedWriter[1]!.steps[14]!.started_at = "2026-09-09T02:58:05Z";
    startedWriter[1]!.steps[14]!.completed_at = "2026-09-09T02:58:06Z";
    expect(failedV3RunExact(run, startedWriter)).toBe(false);

    for (const mutate of [
      (value: ReturnType<typeof failedV3ArtifactsFixture>) => {
        value.artifacts[0]!.id += 1;
      },
      (value: ReturnType<typeof failedV3ArtifactsFixture>) => {
        value.artifacts[0]!.name += "-substituted";
      },
      (value: ReturnType<typeof failedV3ArtifactsFixture>) => {
        value.artifacts[1]!.digest = `sha256:${"0".repeat(64)}`;
      },
      (value: ReturnType<typeof failedV3ArtifactsFixture>) => {
        value.artifacts[1]!.expired = true;
      },
      (value: ReturnType<typeof failedV3ArtifactsFixture>) => {
        value.artifacts[0]!.updated_at = "2026-09-09T02:53:44Z";
      },
    ]) {
      const substituted = failedV3ArtifactsFixture();
      mutate(substituted);
      expect(failedV3ArtifactsExact(substituted)).toBe(false);
    }
  });

  it("emits phase-invariant workflow authority after both apply checkpoints", async () => {
    const reauth = applyPhaseJobs(11);
    const prewrite = applyPhaseJobs(16);
    expect(currentWriterNotStarted(reauth, "apply-reauth")).toBe(true);
    expect(currentWriterNotStarted(prewrite, "apply-prewrite")).toBe(true);
    const reauthEvidence = currentWorkflowAuthorityEvidence(
      v4CurrentRun(),
      candidateSha,
      3,
    );
    const prewriteEvidence = currentWorkflowAuthorityEvidence(
      v4CurrentRun(),
      candidateSha,
      3,
    );
    expect(JSON.stringify(reauthEvidence)).toBe(JSON.stringify(prewriteEvidence));
    expect(reauthEvidence).not.toHaveProperty("verificationPhase");

    const prepared = await runV4Authority("prepare");
    const reauthenticated = await runV4Authority("apply-reauth");
    const immediatelyPrewrite = await runV4Authority("apply-prewrite");
    expect(prepared.authoritySource).toBe(immediatelyPrewrite.authoritySource);
    expect(reauthenticated.authoritySource).toBe(
      immediatelyPrewrite.authoritySource,
    );
    expect(parsePostQDeploymentStopAuthorityV4(
      reauthenticated.authoritySource,
      { candidateSha, runId: String(currentRunId) },
    )).toMatchObject({
      totalWorkflowDispatchRuns: 3,
      priorSkippedAttemptCount: 1,
      singleUseAuthorityExact: true,
    });

    for (const mutate of [
      (value: Record<string, any>) => { value.archivedV3.runId = "1"; },
      (value: Record<string, any>) => {
        value.currentWorkflow.totalDispatchRuns = 2;
      },
      (value: Record<string, any>) => {
        value.currentWorkflow.verificationPhase = "apply-prewrite";
      },
    ]) {
      const substituted = JSON.parse(reauthenticated.authoritySource) as
        Record<string, any>;
      mutate(substituted);
      expect(parsePostQDeploymentStopAuthorityV4(
        `${JSON.stringify(substituted, null, 2)}\n`,
        { candidateSha, runId: String(currentRunId) },
      )).toBeNull();
    }
  });

  it("rejects extra, reordered, or rerun three-row containment history", async () => {
    const current = v4CurrentRun();
    const failed = failedV3RunFixture();
    const recovery = recoveryRunFixture();
    const extra = {
      ...recoveryRunFixture(),
      id: 34_200_000_000,
      run_number: 4,
      head_sha: "b".repeat(40),
      name: `Permanent staging post-Q deployment stop | ${"b".repeat(40)}`,
      display_title:
        `Permanent staging post-Q deployment stop | ${"b".repeat(40)}`,
    };
    await expect(runV4Authority("apply-prewrite", {
      history: {
        total_count: 4,
        workflow_runs: [current, failed, recovery, extra],
      },
    })).rejects.toThrow("post_q_authority_containment_history_invalid");
    await expect(runV4Authority("apply-prewrite", {
      history: {
        total_count: 3,
        workflow_runs: [failed, current, recovery],
      },
    })).rejects.toThrow("post_q_authority_containment_history_invalid");
    await expect(runV4Authority("apply-prewrite", {
      currentRun: { ...current, run_attempt: 2 },
    })).rejects.toThrow("post_q_authority_containment_history_invalid");

    const failedJobs = failedV3JobsFixture();
    failedJobs.jobs[1]!.steps[8]!.conclusion = "success";
    await expect(runV4Authority("apply-prewrite", {
      failedV3Jobs: failedJobs,
    })).rejects.toThrow("post_q_authority_containment_authority_consumed");

    const artifactSubstitution = failedV3ArtifactsFixture();
    artifactSubstitution.artifacts[0]!.expired = true;
    await expect(runV4Authority("apply-prewrite", {
      failedV3Artifacts: artifactSubstitution,
    })).rejects.toThrow("post_q_authority_containment_history_invalid");
  });

  it("authenticates archived V3 bytes read-only and can repeat the check", () => {
    const custody = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-v4-archive-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-v4-link-"));
    try {
      const source = Buffer.from("failed-v3-no-write-evidence\n");
      const evidencePath = path.join(custody, "evidence.json");
      fs.writeFileSync(evidencePath, source);
      const expected = [{
        path: "evidence.json",
        sizeBytes: source.byteLength,
        sha256: hash(source.toString()),
      }];
      const first = verifyDownloadedArtifact(custody, expected);
      const second = verifyDownloadedArtifact(custody, expected);
      expect(second).toEqual(first);
      expect(first.members).toEqual([{ ...expected[0], sealedPath: "evidence.json" }]);
      expect(fs.existsSync(path.join(custody, "sealed"))).toBe(false);
      fs.linkSync(evidencePath, path.join(outside, "second-link.json"));
      expect(() => verifyDownloadedArtifact(custody, expected)).toThrow(
        "post_q_authority_artifact_files_invalid",
      );
    } finally {
      fs.rmSync(custody, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("preserves the archived v1 policy and verifier byte-for-byte", () => {
    expect(hash(read(
      "ops/railway/permanent-staging-post-q-deployment-stop-policy.json",
    ))).toBe("e8bb67ef71e49f3179f1fe0cb8a6eeceb09f7cae05376b2e74b8b1eae0f7b2e1");
    expect(hash(read(
      "scripts/verify-permanent-staging-post-q-authority.mjs",
    ))).toBe("f5a12c286573226a86445d1bd8960f96be92a75aedc10f705e20ee9e95f8c6a3");
  });

  it("pins the canonical workflow ledger, old no-write run, and historical blob", () => {
    const policy = JSON.parse(read(
      "ops/railway/permanent-staging-post-q-deployment-stop-policy-v4.json",
    ));
    const policySource = read(
      "ops/railway/permanent-staging-post-q-deployment-stop-policy-v4.json",
    );
    expect(hash(policySource)).toBe(
      "5d1b8d898cf81b70cd53af57be869ba16f5ffe30de2b53e2a4ed1bc6afd09048",
    );
    expect(successorPolicyExact(policySource)).toBe(true);
    expect(successorPolicyExact(policySource.replace(
      '"requiredRunNumber": 3',
      '"requiredRunNumber": 4',
    ))).toBe(false);
    expect(policy).toMatchObject({
      schemaVersion:
        "pintpath-permanent-staging-post-q-deployment-stop-policy/v4",
      workflow: {
        path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
        workflowId: 353312302,
        requiredRunNumber: 3,
        requiredTotalHistoryRows: 3,
        historyQueryEventFilterAllowed: false,
      },
      archivedV1: {
        authorityDeadline: "2026-09-08T18:57:20.000Z",
        expired: true,
        reused: false,
      },
      archivedV2: {
        candidateSha: "78162cf42a0ef3190343a657ff94f288d4a4c7ca",
        candidateTreeSha: "410fd437bb0c459049f08bbff63ee605f2e65c9e",
        candidateSoleParentSha:
          "d27275f4c101b764c6016e8b378969c14719258e",
        ineligibility: {
          runId: 34281452199,
          runAttempt: 1,
          event: "push",
          headBranch: "main",
          status: "completed",
          conclusion: "failure",
          failedJobName: "build-test-scan",
          successfulBuildStepConclusion: "success",
          failedStepName: "Dependency audit",
          authorityConsumed: false,
          rerunCanQualify: false,
        },
      },
      archivedV3: {
        candidateSha: failedV3CandidateSha,
        candidateTreeSha: "73028c14f816ed9599606add3d131a25737db2d2",
        candidateSoleParentSha: v2CandidateSha,
        failedRun: {
          runId: 34304764597,
          runNumber: 2,
          failedStepNumber: 9,
          writerStepNumber: 15,
          deploymentStopAttempts: 0,
          writerNeverStartedExact: true,
          rerunCanQualify: false,
        },
        authorityConsumed: true,
        deploymentStopAuthorityConsumed: false,
        canonicalRun3SuccessorRequired: true,
      },
      candidateLineage: {
        directParentSha: failedV3CandidateSha,
        directParentTreeSha: "73028c14f816ed9599606add3d131a25737db2d2",
        directParentSoleParentSha: v2CandidateSha,
        preV2CandidateTreeSha:
          "53808bdd995a6ff1d2204e01f7639b103dbd5a76",
        recoveryTreeSha: "9978dca9491f7bf7bee77ce39debe1f713e89c53",
        recoverySoleParentSha:
          "606d33facb515dd10bc94c360e43c20beb999cc1",
      },
      environmentConfigProjection: {
        sourceQueryDecryptVariables: false,
        staticEligibilityProjection: {
          schemaVersion:
            "pintpath-permanent-staging-post-q-target-deploy-config-projection/v1",
          scope: "exact-target-service-deploy-object",
          projectionSizeBytes: 540,
          projectionSha256:
            "8ab34441af1ec87d5068ce0155975a9fea46a192537b70c54677e64f60ae183e",
          historicalFullEnvironmentHashRequired: false,
        },
        dynamicCollateralCommitment: {
          schemaVersion:
            "pintpath-permanent-staging-post-q-observed-environment-config/v1",
          exactKnownRootServiceVolumeAndNestedPathsRequired: true,
          unknownOrMissingPathRejected: true,
          numericBooleanAndNullMetadataValuesHashed: true,
          allProviderStringValuesRedactedBeforeHashing: true,
          rawProviderStringsComparedOnlyInProcess: true,
          rawProviderStringsPersistedOrHashed: false,
          exactPerServiceVariableNameSetsRequired: true,
          variableValueMustBeNull: true,
          onlyKnownPasswordGeneratorsMayBeStrings: true,
          generatorGrammarExact:
            "secret(32,lowercase-then-uppercase-ascii)",
          generatorProjectedAsSemanticDescriptor: true,
          rawGeneratorPersistedOrHashed: false,
          preflightPrewriteAndEveryTerminalObservationEqualityRequired: true,
          historicalDigestPinned: false,
          onlySchemaAndDigestPersisted: true,
        },
        secretMaterialIncluded: false,
        secretDerivedCommitmentsIncluded: false,
      },
    });
    expect(historicalWorkflowBlobExact({
      type: "file",
      name: "stop-permanent-staging-post-q-deployment.yml",
      path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
      sha: "1".repeat(40),
      size: 28_866,
      encoding: "base64",
      content: "",
    })).toBe(false);
  });

  it("authenticates the complete provider-side V2 ineligibility and V4 successor", async () => {
    const authority = await verifyPostQReviewedCandidateV4(
      v4ReviewedCandidateFetch(),
      "github-test-token-with-safe-length",
      candidateSha,
      v4CurrentRun(),
      Date.parse("2026-09-09T06:01:00Z"),
    );
    expect(authority).toMatchObject({
      schemaVersion:
        "pintpath-permanent-staging-post-q-reviewed-candidate-authority/v4",
      candidateSha,
      directParentSha: failedV3CandidateSha,
      ineligibleV2: {
        candidateSha: v2CandidateSha,
        candidateTreeSha: "410fd437bb0c459049f08bbff63ee605f2e65c9e",
        candidateSoleParentSha: preV2CandidateSha,
        pullRequestNumber: 99,
        reviewedPrHeadSha: "3b844ce9e5839251552419c3610a797bd1a1f3c7",
        runId: 34_281_452_199,
        runAttempt: 1,
        failedJobId: 102_248_030_722,
        successfulBuildStepNumber: 8,
        successfulBuildStepStartedAt: "2026-09-08T21:39:51Z",
        successfulBuildStepCompletedAt: "2026-09-08T21:43:06Z",
        failedStepNumber: 11,
        failedStepStartedAt: "2026-09-08T21:43:22Z",
        failedStepCompletedAt: "2026-09-08T21:43:23Z",
        canonicalWorkflowRunAbsent: true,
        authorityConsumed: false,
        rerunCanQualify: false,
        archivedFilesExact: true,
        archivedWorkflowExact: true,
      },
      deadlinePolicy: {
        derivedDeadline: "2026-09-09T07:30:00.000Z",
      },
      checks: {
        ineligibleV2Attempt1Exact: true,
        archivedV2BytesAndBlobExact: true,
        archivedV3BytesAndBlobExact: true,
        archivedV3RunCompletedBeforeMergeExact: true,
      },
    });
    expect(authority.requiredChecks).toHaveLength(8);
    expect(authority.requiredArtifacts).toHaveLength(3);
    expect(parsePostQDeploymentStopReviewedAuthorityV4(
      `${JSON.stringify(authority, null, 2)}\n`,
      { candidateSha, runId: String(currentRunId) },
    )).not.toBeNull();
  });

  it("fails closed on every authenticated V2 provider-history substitution", async () => {
    type Mutation = (fixtures: V4ProviderFixtures) => void;
    const cases: Array<readonly [string, Mutation]> = [
      ["PR99 number", (value) => { value.ineligiblePull.number = 100; }],
      ["PR99 state", (value) => { value.ineligiblePull.state = "open"; }],
      ["PR99 merged", (value) => { value.ineligiblePull.merged = false; }],
      ["PR99 merge time", (value) => {
        value.ineligiblePull.merged_at = "2026-09-08T21:35:28Z";
      }],
      ["PR99 merge SHA", (value) => {
        value.ineligiblePull.merge_commit_sha = "0".repeat(40);
      }],
      ["PR99 head", (value) => {
        value.ineligiblePull.head.sha = "0".repeat(40);
      }],
      ["PR99 head repository", (value) => {
        value.ineligiblePull.head.repo.full_name = "blackmagic30/Other";
      }],
      ["PR99 base branch", (value) => {
        value.ineligiblePull.base.ref = "release";
      }],
      ["PR99 base SHA", (value) => {
        value.ineligiblePull.base.sha = "0".repeat(40);
      }],
      ["PR99 base repository", (value) => {
        value.ineligiblePull.base.repo.full_name = "blackmagic30/Other";
      }],
      ["PR99 author", (value) => { value.ineligiblePull.user.id = 1; }],
      ["PR99 merger", (value) => { value.ineligiblePull.merged_by.id = 1; }],
      ["PR99 reviewed head", (value) => {
        value.ineligibleReviewedHead.sha = "0".repeat(40);
      }],
      ["PR99 reviewed tree", (value) => {
        value.ineligibleReviewedHead.tree.sha = "0".repeat(40);
      }],
      ["run id", (value) => { value.ineligibleRun.id += 1; }],
      ["run workflow", (value) => { value.ineligibleRun.workflow_id += 1; }],
      ["run path", (value) => {
        value.ineligibleRun.path = ".github/workflows/codeql.yml";
      }],
      ["run number", (value) => { value.ineligibleRun.run_number += 1; }],
      ["run attempt", (value) => { value.ineligibleRun.run_attempt = 2; }],
      ["run check suite", (value) => {
        value.ineligibleRun.check_suite_id += 1;
      }],
      ["run event", (value) => {
        value.ineligibleRun.event = "workflow_dispatch";
      }],
      ["run branch", (value) => { value.ineligibleRun.head_branch = "dev"; }],
      ["run status", (value) => {
        value.ineligibleRun.status = "in_progress";
      }],
      ["run conclusion", (value) => {
        value.ineligibleRun.conclusion = "success";
      }],
      ["run head", (value) => {
        value.ineligibleRun.head_sha = "0".repeat(40);
      }],
      ["run created", (value) => {
        value.ineligibleRun.created_at = "2026-09-08T21:35:32Z";
      }],
      ["run started", (value) => {
        value.ineligibleRun.run_started_at = "2026-09-08T21:35:32Z";
      }],
      ["run completed", (value) => {
        value.ineligibleRun.updated_at = "2026-09-08T21:43:27Z";
      }],
      ["run repository id", (value) => {
        value.ineligibleRun.repository.id += 1;
      }],
      ["run repository name", (value) => {
        value.ineligibleRun.repository.full_name = "blackmagic30/Other";
      }],
      ["run head repository id", (value) => {
        value.ineligibleRun.head_repository.id += 1;
      }],
      ["run head repository name", (value) => {
        value.ineligibleRun.head_repository.full_name = "blackmagic30/Other";
      }],
      ["run actor id", (value) => { value.ineligibleRun.actor.id = 1; }],
      ["run actor login", (value) => {
        value.ineligibleRun.actor.login = "other";
      }],
      ["run triggering actor id", (value) => {
        value.ineligibleRun.triggering_actor.id = 1;
      }],
      ["run triggering actor login", (value) => {
        value.ineligibleRun.triggering_actor.login = "other";
      }],
      ["job count", (value) => { value.ineligibleJobs.total_count = 3; }],
      ["job inventory", (value) => { value.ineligibleJobs.jobs.pop(); }],
      ["job run", (value) => { value.ineligibleJobs.jobs[0]!.run_id += 1; }],
      ["job attempt", (value) => {
        value.ineligibleJobs.jobs[0]!.run_attempt = 2;
      }],
      ["job workflow", (value) => {
        value.ineligibleJobs.jobs[0]!.workflow_name = "Other";
      }],
      ["job head", (value) => {
        value.ineligibleJobs.jobs[0]!.head_sha = "0".repeat(40);
      }],
      ["job status", (value) => {
        value.ineligibleJobs.jobs[0]!.status = "in_progress";
      }],
      ["build step number", (value) => {
        value.ineligibleJobs.jobs[3]!.steps[0]!.number = 7;
      }],
      ["build step name", (value) => {
        value.ineligibleJobs.jobs[3]!.steps[0]!.name = "Other";
      }],
      ["build step status", (value) => {
        value.ineligibleJobs.jobs[3]!.steps[0]!.status = "queued";
      }],
      ["build step conclusion", (value) => {
        value.ineligibleJobs.jobs[3]!.steps[0]!.conclusion = "failure";
      }],
      ["build step started", (value) => {
        value.ineligibleJobs.jobs[3]!.steps[0]!.started_at =
          "2026-09-08T21:39:52Z";
      }],
      ["build step completed", (value) => {
        value.ineligibleJobs.jobs[3]!.steps[0]!.completed_at =
          "2026-09-08T21:43:07Z";
      }],
      ["failed step number", (value) => {
        value.ineligibleJobs.jobs[3]!.steps[1]!.number = 12;
      }],
      ["failed step name", (value) => {
        value.ineligibleJobs.jobs[3]!.steps[1]!.name = "Other";
      }],
      ["failed step status", (value) => {
        value.ineligibleJobs.jobs[3]!.steps[1]!.status = "queued";
      }],
      ["failed step conclusion", (value) => {
        value.ineligibleJobs.jobs[3]!.steps[1]!.conclusion = "success";
      }],
      ["failed step started", (value) => {
        value.ineligibleJobs.jobs[3]!.steps[1]!.started_at =
          "2026-09-08T21:43:21Z";
      }],
      ["failed step completed", (value) => {
        value.ineligibleJobs.jobs[3]!.steps[1]!.completed_at =
          "2026-09-08T21:43:24Z";
      }],
      ["archived workflow type", (value) => {
        value.archivedWorkflow.type = "dir";
      }],
      ["archived workflow path", (value) => {
        value.archivedWorkflow.path = ".github/workflows/other.yml";
      }],
      ["archived workflow oid", (value) => {
        value.archivedWorkflow.sha = "0".repeat(40);
      }],
      ["archived workflow size", (value) => {
        value.archivedWorkflow.size += 1;
      }],
      ["archived workflow encoding", (value) => {
        value.archivedWorkflow.encoding = "utf-8";
      }],
      ["archived workflow bytes", (value) => {
        value.archivedWorkflow.content = Buffer.from("substituted")
          .toString("base64");
      }],
    ];
    for (let index = 0; index < 4; index += 1) {
      cases.push(
        [`job ${index} id`, (value) => {
          value.ineligibleJobs.jobs[index]!.id += 1;
        }],
        [`job ${index} name`, (value) => {
          value.ineligibleJobs.jobs[index]!.name = "Other";
        }],
        [`job ${index} started`, (value) => {
          value.ineligibleJobs.jobs[index]!.started_at =
            "2026-09-08T21:35:33Z";
        }],
        [`job ${index} completed`, (value) => {
          value.ineligibleJobs.jobs[index]!.completed_at =
            "2026-09-08T21:43:24Z";
        }],
        [`job ${index} conclusion`, (value) => {
          value.ineligibleJobs.jobs[index]!.conclusion = "cancelled";
        }],
      );
    }

    for (const [name, mutate] of cases) {
      await expect(verifyPostQReviewedCandidateV4(
        v4ReviewedCandidateFetch(mutate),
        "github-test-token-with-safe-length",
        candidateSha,
        v4CurrentRun(),
        Date.parse("2026-09-09T06:01:00Z"),
      ), name).rejects.toThrow(/post_q_authority_(?:archived_v2|reviewed_candidate)_invalid/u);
    }
  });

  it("rejects noncanonical current-run timestamps before provider verification", async () => {
    const noncanonical = [
      "2026-09-09T06:00:00+00:00",
      "2026-09-09",
      "2026-02-30T06:00:00Z",
      "2026-09-09T24:00:00Z",
      "2026-09-09T06:00:00.0000Z",
    ];
    for (const field of ["created_at", "run_started_at", "updated_at"] as const) {
      for (const timestamp of noncanonical) {
        const current = v4CurrentRun();
        current[field] = timestamp;
        await expect(verifyPostQReviewedCandidateV4(
          v4ReviewedCandidateFetch(),
          "github-test-token-with-safe-length",
          candidateSha,
          current,
          Date.parse("2026-09-09T06:01:00Z"),
        ), `${field}:${timestamp}`).rejects.toThrow(
          "post_q_authority_reviewed_candidate_invalid",
        );
      }
    }
  });

  it("uses the canonical workflow with only v4 authority/runtime and compatible intent name", () => {
    const workflow = read(
      ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
    );
    expect(() => parseYaml(workflow, { uniqueKeys: true })).not.toThrow();
    expect(workflow).toContain("authorization_id:");
    expect(workflow).toContain("authorization_source_sha256:");
    expect(workflow.match(
      /scripts\/verify-permanent-staging-post-q-authority-v4\.mjs/gu,
    )).toHaveLength(3);
    expect(workflow.match(
      /scripts\/execute-protected-permanent-staging-post-q-deployment-stop-v4\.ts/gu,
    )).toHaveLength(3);
    expect(workflow).not.toMatch(
      /scripts\/verify-permanent-staging-post-q-authority\.mjs/gu,
    );
    expect(workflow).toContain(
      "pintpath-permanent-staging-post-q-deployment-stop-intent-${{ inputs.candidate_sha }}-${{ github.run_id }}",
    );
    expect(workflow).not.toContain("post-deadline.yml");
    expect(workflow).not.toContain("PINTPATH_RAILWAY_PRODUCTION_SCALE_TOKEN");
  });

  it("documents failed run 2 and the exact pending-writer run-3 dispatch", () => {
    const runbook = read(
      "docs/permanent-staging-post-q-post-deadline-containment.md",
    );
    expect(runbook).toContain("containment under V4 authority");
    expect(runbook).toContain("V3 run `34304764597`");
    expect(runbook).toContain("writer row 17 must exist as exactly `pending`");
    expect(runbook).toContain(
      "`pintpath-post-q-staging-stop-reauthorization-2026-09-09/v4`",
    );
    expect(runbook).toContain("Any fourth dispatch or rerun");
    expect(runbook).not.toContain("writer must still be queued");
  });

  it("queries unfiltered history by numeric workflow id", () => {
    const verifier = read(
      "scripts/verify-permanent-staging-post-q-authority-v4.mjs",
    );
    expect(verifier).toContain(
      "`/repos/${REPOSITORY}/actions/workflows/${CONTAINMENT_WORKFLOW_ID}/runs`",
    );
    expect(verifier).toContain("`?per_page=100&page=${page}`");
    expect(verifier).not.toContain("?event=workflow_dispatch&per_page");
    expect(verifier).toContain("EXPIRED_WORKFLOW_BLOB_OID");
    expect(verifier).toContain("historicalWorkflowBlobExact");
  });

  it("derives the earliest independent deadline and rejects invalid chronology", () => {
    expect(derivePostQDeploymentStopV4Deadline(
      "2026-09-10T05:30:00Z",
      "2026-09-10T06:00:00Z",
    )).toBe("2026-09-10T07:30:00.000Z");
    expect(deriveV4VerifierDeadline(
      "2026-09-10T05:30:00Z",
      "2026-09-10T06:00:00Z",
    )).toBe("2026-09-10T07:30:00.000Z");
    expect(derivePostQDeploymentStopV4Deadline(
      "2026-09-10T03:00:00Z",
      "2026-09-10T06:00:00Z",
    )).toBe("2026-09-10T07:00:00.000Z");
    expect(derivePostQDeploymentStopV4Deadline(
      "2026-09-10T06:30:00Z",
      "2026-09-10T07:00:00Z",
    )).toBe("2026-09-10T08:00:00.000Z");
    expect(derivePostQDeploymentStopV4Deadline(
      "2026-09-10T07:00:01Z",
      "2026-09-10T07:00:00Z",
    )).toBeNull();
    expect(derivePostQDeploymentStopV4Deadline(
      "2026-09-10T07:00:00Z",
      "2026-09-10T08:00:00Z",
    )).toBeNull();
    for (const noncanonical of [
      "2026-09-10T06:00:00+00:00",
      "2026-09-10",
      "2026-02-30T06:00:00Z",
      "2026-09-10T24:00:00Z",
      "2026-09-10T06:00:00.0000Z",
    ]) {
      expect(derivePostQDeploymentStopV4Deadline(
        noncanonical,
        "2026-09-10T07:00:00Z",
      ), `merge:${noncanonical}`).toBeNull();
      expect(derivePostQDeploymentStopV4Deadline(
        "2026-09-10T06:00:00Z",
        noncanonical,
      ), `run:${noncanonical}`).toBeNull();
      expect(deriveV4VerifierDeadline(
        noncanonical,
        "2026-09-10T07:00:00Z",
      ), `verifier-merge:${noncanonical}`).toBeNull();
      expect(deriveV4VerifierDeadline(
        "2026-09-10T06:00:00Z",
        noncanonical,
      ), `verifier-run:${noncanonical}`).toBeNull();
    }
  });

  it("rederives the persisted deadline immediately before allowing a write", () => {
    const authority = {
      sha256: "b".repeat(64),
      candidateSha,
      reviewedPrHeadSha: "c".repeat(40),
      reviewedPullRequestNumber: 103,
      reviewedPullRequestMergedAt: "2026-09-09T05:30:00Z",
      authorizationDeadline: "2026-09-09T07:30:00.000Z",
      workflowRunStartedAt: "2026-09-09T06:00:00Z",
      workflowRunId: "34300000000",
      workflowRunAttempt: 1 as const,
      reviewedAuthorityExact: true as const,
      freshDispatchWriteGuardExact: true as const,
    };
    expect(postQDeploymentStopV4DeadlineExact(
      authority,
      Date.parse("2026-09-09T07:29:59.999Z"),
    )).toBe(true);
    expect(postQDeploymentStopV4DeadlineExact(
      authority,
      Date.parse("2026-09-09T07:30:00.000Z"),
    )).toBe(false);
    expect(postQDeploymentStopV4DeadlineExact({
      ...authority,
      authorizationDeadline: "2026-09-09T08:00:00.000Z",
    }, Date.parse("2026-09-09T07:00:00.000Z"))).toBe(false);

    const executor = read(
      "scripts/execute-protected-permanent-staging-post-q-deployment-stop.ts",
    );
    const requestStart = executor.indexOf("const requestStartedMs = dependencies.now()");
    const deadlineRecheck = executor.indexOf(
      "dependencies.authorizationDeadlineExact(\n      reviewedAuthority,\n      requestStartedMs",
      requestStart,
    );
    const writer = executor.indexOf("dependencies.stopDeployment(writeToken)");
    const reconciliation = executor.indexOf("dependencies.reconcile({", writer);
    expect(requestStart).toBeGreaterThan(0);
    expect(deadlineRecheck).toBeGreaterThan(requestStart);
    expect(writer).toBeGreaterThan(deadlineRecheck);
    expect(reconciliation).toBeGreaterThan(writer);
    expect(executor.slice(writer, reconciliation)).not.toContain(
      "authorizationDeadlineExact",
    );
    expect(executor).toContain("args.phase === \"finalize\" ||");
  });

  it("requires the action-specific confirmation and fresh v4 identifiers", () => {
    const env = {
      PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:
        "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN",
      PINTPATH_POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_ID:
        "pintpath-post-q-staging-stop-reauthorization-2026-09-09/v4",
      PINTPATH_POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_SOURCE_SHA256:
        "ccaf9c49e38f97368f6187d7c3ff1c853cffe8334fdfaf3478835c7e93f4028c",
      PINTPATH_POST_Q_DEPLOYMENT_STOP_CONFIRMATION:
        `REAUTHORIZE_ONE_STAGING_DEPLOYMENT_STOP_6300A324_9407_4B1C_B651_749C47E9537F_FOR_${candidateSha}_UNDER_V4_FROM_01A0840A_3590_74D1_9567_0E9EEC01A9A4`,
    };
    expect(postQDeploymentStopV4ConfirmationExact(candidateSha, env)).toBe(true);
    expect(postQDeploymentStopV4ConfirmationExact(candidateSha, {
      ...env,
      PINTPATH_POST_Q_DEPLOYMENT_STOP_V4_AUTHORIZATION_ID:
        "pintpath-permanent-staging-post-q-deployment-stop-containment",
    })).toBe(false);
  });
});
