import { describe, expect, it, vi } from "vitest";

import {
  verifyColdQuiesceSuccessorBridge,
} from "../scripts/verify-github-reviewed-candidate-authority.mjs";

const REPOSITORY = "blackmagic30/Beer";
const COLD_RECOVERY_PATH =
  ".github/workflows/recover-permanent-staging-cold-zero.yml";
const PRIOR_CANDIDATE = "838e8c877dcafc0a822a12e5a26afa81c26924a3";
const PRIOR_REVIEWED_HEAD =
  "cc2c5311d47f3e895173cb11ef094ef856e0cf07";
const PRIOR_TREE = "9da75485e85addfec7096b1c04c52f6780d17b64";
const CURRENT_CANDIDATE = "a".repeat(40);
const CURRENT_TREE = "b".repeat(40);
const PREPARE_RUN_ID = 34152745186;
const AMBIGUOUS_QUIESCE_RUN_ID = 34153306935;
const READ_ONLY_RECONCILE_RUN_ID = 34154020478;
const CURRENT_PREPARE_RUN_ID = 34160000001;
const CURRENT_RUN_ID = 34160000002;
const ARTIFACT_ID = 10030213299;
const ARTIFACT_NAME =
  `pintpath-permanent-staging-cold-quiesce-${PRIOR_CANDIDATE}`;
const ARTIFACT_DIGEST =
  "sha256:3f830a7376e604a46e0d8cfe3521fc8eb4e1db444ab73bec4063c22442c42fbe";
const CURRENT_MERGED_AT = "2026-09-08T00:00:00Z";
const CURRENT_RUN_STARTED_AT = "2026-09-08T00:10:00Z";

const CURRENT_QUIESCE_JOB_NAME =
  "Quiesce the configured Europe replica from one to zero";
const CURRENT_QUIESCE_WRITE_STEP =
  "Quiesce the configured Europe replica from one to zero once";
const LEGACY_QUIESCE_JOB_NAME =
  "Initialize the exact dead baseline at explicit zero";
const LEGACY_QUIESCE_WRITE_STEP =
  "Initialize the dead baseline from null to explicit zero once";
const CURRENT_COLD_JOB_NAMES = [
  "Bind the exact replacement and prepare the dead baseline",
  "Reconcile an ambiguous cold prepare at the exact dead baseline",
  CURRENT_QUIESCE_JOB_NAME,
  "Reconcile an ambiguous cold quiesce at exact zero",
] as const;
const LEGACY_COLD_JOB_NAMES = [
  "Bind the exact replacement and prepare the dead baseline",
  "Reconcile an ambiguous cold prepare at the exact dead baseline",
  LEGACY_QUIESCE_JOB_NAME,
  "Reconcile an ambiguous cold quiesce at exact zero",
] as const;

function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function coldRun(input: {
  id: number;
  operation: "prepare" | "quiesce" | "reconcile-quiesce";
  createdAt: string;
  completedAt: string;
  conclusion: "success" | "failure" | null;
  status?: string;
  headSha?: string;
}) {
  const headSha = input.headSha ?? PRIOR_CANDIDATE;
  return {
    id: input.id,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    head_sha: headSha,
    head_branch: "main",
    path: `${COLD_RECOVERY_PATH}@main`,
    event: "workflow_dispatch",
    display_title:
      `Permanent staging cold recovery | ${input.operation} | ${headSha}`,
    run_attempt: 1,
    status: input.status ?? "completed",
    conclusion: input.conclusion,
    created_at: input.createdAt,
    run_started_at: input.createdAt,
    updated_at: input.completedAt,
  };
}

const PREPARE_RUN = coldRun({
  id: PREPARE_RUN_ID,
  operation: "prepare",
  createdAt: "2026-09-07T18:43:02Z",
  completedAt: "2026-09-07T18:47:32Z",
  conclusion: "success",
});
const AMBIGUOUS_QUIESCE_RUN = coldRun({
  id: AMBIGUOUS_QUIESCE_RUN_ID,
  operation: "quiesce",
  createdAt: "2026-09-07T18:51:21Z",
  completedAt: "2026-09-07T18:57:20Z",
  conclusion: "failure",
});
const READ_ONLY_RECONCILE_RUN = coldRun({
  id: READ_ONLY_RECONCILE_RUN_ID,
  operation: "reconcile-quiesce",
  createdAt: "2026-09-07T19:02:23Z",
  completedAt: "2026-09-07T19:06:38Z",
  conclusion: "failure",
});
const CURRENT_PREPARE_RUN = coldRun({
  id: CURRENT_PREPARE_RUN_ID,
  operation: "prepare",
  createdAt: "2026-09-08T00:02:00Z",
  completedAt: "2026-09-08T00:07:00Z",
  conclusion: "success",
  headSha: CURRENT_CANDIDATE,
});

function coldJobs(
  runId: number,
  jobNames: readonly string[],
  selectedName: string,
  selectedConclusion: "success" | "failure",
  selectedSteps: Array<Record<string, string>>,
) {
  return {
    total_count: jobNames.length,
    jobs: jobNames.map((name) => name === selectedName
      ? {
          run_id: runId,
          run_attempt: 1,
          name,
          status: "completed",
          conclusion: selectedConclusion,
          steps: selectedSteps,
        }
      : {
          run_id: runId,
          run_attempt: 1,
          name,
          status: "completed",
          conclusion: "skipped",
          steps: [],
        }),
  };
}

function bridgeFixture(options: {
  currentParentSha?: string;
  artifactDigest?: string;
  currentRunStartedAt?: string;
  currentHistoryUpdatedAt?: string;
  ambiguousUsesCurrentNames?: boolean;
  currentPrepareUsesLegacyNames?: boolean;
  extraRuns?: Array<Record<string, unknown>>;
} = {}) {
  const currentParentSha = options.currentParentSha ?? PRIOR_CANDIDATE;
  const artifactDigest = options.artifactDigest ?? ARTIFACT_DIGEST;
  const currentRunStartedAt = options.currentRunStartedAt ??
    CURRENT_RUN_STARTED_AT;
  const currentRun = coldRun({
    id: CURRENT_RUN_ID,
    operation: "quiesce",
    createdAt: currentRunStartedAt,
    completedAt: currentRunStartedAt,
    conclusion: null,
    status: "in_progress",
    headSha: CURRENT_CANDIDATE,
  });
  const fetchImpl = vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (url.includes(`/commits/${PRIOR_CANDIDATE}/pulls?`)) {
      return response([{
        number: 90,
        state: "closed",
        merge_commit_sha: PRIOR_CANDIDATE,
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: { repo: { full_name: REPOSITORY } },
      }]);
    }
    if (url.endsWith("/pulls/90")) {
      return response({
        number: 90,
        state: "closed",
        merged: true,
        draft: false,
        merge_commit_sha: PRIOR_CANDIDATE,
        merged_at: "2026-09-07T18:18:58Z",
        user: { id: 101 },
        merged_by: { id: 202 },
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: {
          sha: PRIOR_REVIEWED_HEAD,
          repo: { full_name: REPOSITORY },
        },
      });
    }
    if (url.endsWith(`/git/commits/${PRIOR_CANDIDATE}`)) {
      return response({
        sha: PRIOR_CANDIDATE,
        tree: { sha: PRIOR_TREE },
        parents: [{ sha: "1".repeat(40) }],
      });
    }
    if (url.endsWith(`/git/commits/${PRIOR_REVIEWED_HEAD}`)) {
      return response({
        sha: PRIOR_REVIEWED_HEAD,
        tree: { sha: PRIOR_TREE },
        parents: [{ sha: "2".repeat(40) }],
      });
    }
    if (url.endsWith(`/git/commits/${CURRENT_CANDIDATE}`)) {
      return response({
        sha: CURRENT_CANDIDATE,
        tree: { sha: CURRENT_TREE },
        parents: [{ sha: currentParentSha }],
      });
    }
    if (
      url.includes(
        "/actions/workflows/recover-permanent-staging-cold-zero.yml/runs?",
      )
    ) {
      return response({
        total_count: 5 + (options.extraRuns?.length ?? 0),
        workflow_runs: [
          PREPARE_RUN,
          AMBIGUOUS_QUIESCE_RUN,
          READ_ONLY_RECONCILE_RUN,
          CURRENT_PREPARE_RUN,
          options.currentHistoryUpdatedAt
            ? { ...currentRun, updated_at: options.currentHistoryUpdatedAt }
            : currentRun,
          ...(options.extraRuns ?? []),
        ],
      });
    }
    if (
      url.includes(`/actions/runs/${AMBIGUOUS_QUIESCE_RUN_ID}/jobs?`)
    ) {
      return response(coldJobs(
        AMBIGUOUS_QUIESCE_RUN_ID,
        options.ambiguousUsesCurrentNames
          ? CURRENT_COLD_JOB_NAMES
          : LEGACY_COLD_JOB_NAMES,
        options.ambiguousUsesCurrentNames
          ? CURRENT_QUIESCE_JOB_NAME
          : LEGACY_QUIESCE_JOB_NAME,
        "failure",
        [{
          name: options.ambiguousUsesCurrentNames
            ? CURRENT_QUIESCE_WRITE_STEP
            : LEGACY_QUIESCE_WRITE_STEP,
          status: "completed",
          conclusion: "failure",
        }],
      ));
    }
    if (
      url.includes(`/actions/runs/${READ_ONLY_RECONCILE_RUN_ID}/jobs?`)
    ) {
      return response(coldJobs(
        READ_ONLY_RECONCILE_RUN_ID,
        LEGACY_COLD_JOB_NAMES,
        "Reconcile an ambiguous cold quiesce at exact zero",
        "failure",
        [],
      ));
    }
    if (url.includes(`/actions/runs/${CURRENT_PREPARE_RUN_ID}/jobs?`)) {
      const jobNames = options.currentPrepareUsesLegacyNames
        ? LEGACY_COLD_JOB_NAMES
        : CURRENT_COLD_JOB_NAMES;
      return response(coldJobs(
        CURRENT_PREPARE_RUN_ID,
        jobNames,
        "Bind the exact replacement and prepare the dead baseline",
        "success",
        [{
          name: "Prepare the exact dead staging baseline once",
          status: "completed",
          conclusion: "success",
        }],
      ));
    }
    if (
      url.includes(`/actions/runs/${AMBIGUOUS_QUIESCE_RUN_ID}/artifacts?`)
    ) {
      return response({
        total_count: 1,
        artifacts: [{
          id: ARTIFACT_ID,
          name: ARTIFACT_NAME,
          size_in_bytes: 4507,
          digest: artifactDigest,
          expired: false,
          created_at: "2026-09-07T18:57:18Z",
          updated_at: "2026-09-07T18:57:18Z",
          expires_at: "2026-10-07T18:57:18Z",
          workflow_run: {
            id: AMBIGUOUS_QUIESCE_RUN_ID,
            head_branch: "main",
            head_sha: PRIOR_CANDIDATE,
          },
        }],
      });
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  });

  return {
    fetchImpl,
    verify: () => verifyColdQuiesceSuccessorBridge(
      {
        fetchImpl,
        token: "github-metadata-token",
        candidateSha: CURRENT_CANDIDATE,
        priorCandidateSha: PRIOR_CANDIDATE,
        priorRunId: String(AMBIGUOUS_QUIESCE_RUN_ID),
        prepareRunId: String(CURRENT_PREPARE_RUN_ID),
        currentMergedAtMs: Date.parse(CURRENT_MERGED_AT),
      },
      { repository: REPOSITORY, branch: "main" },
      { treeSha: CURRENT_TREE },
      {
        ...currentRun,
        run_started_at: currentRunStartedAt,
        startedAt: Date.parse(currentRunStartedAt),
      },
    ),
  };
}

describe("GitHub-reviewed cold-quiesce successor bridge", () => {
  it("binds the direct successor to the exact prior history and artifact", async () => {
    const fixture = bridgeFixture();

    await expect(fixture.verify()).resolves.toMatchObject({
      priorAmbiguousColdQuiesceCandidateSha: PRIOR_CANDIDATE,
      priorAmbiguousColdQuiesceRunId: String(AMBIGUOUS_QUIESCE_RUN_ID),
      priorAmbiguousColdQuiesceRunCompletedAt:
        "2026-09-07T18:57:20.000Z",
      coldQuiesceSuccessorGraceHours: 24,
      coldQuiesceSuccessorDeadline: "2026-09-08T18:57:20.000Z",
      coldQuiesceSuccessorWithinGraceExact: true,
      priorColdPrepareRunId: String(PREPARE_RUN_ID),
      selectedColdPrepareRunId: String(CURRENT_PREPARE_RUN_ID),
      priorFailedReadOnlyColdQuiesceReconcileRunId:
        String(READ_ONLY_RECONCILE_RUN_ID),
      priorAmbiguousColdQuiesceArtifactId: String(ARTIFACT_ID),
      priorAmbiguousColdQuiesceArtifactDigest: ARTIFACT_DIGEST,
      coldQuiesceSuccessorDirectParentExact: true,
      coldQuiesceSuccessorPriorHistoryExact: true,
      coldQuiesceSuccessorAllRefsHistoryExact: true,
      coldQuiesceSuccessorCurrentPrepareExact: true,
      coldQuiesceSuccessorArtifactMetadataExact: true,
      coldQuiesceSuccessorBridgeRequired: true,
    });
    const historyUrl = String(fixture.fetchImpl.mock.calls.find(([request]) =>
      String(request).includes("/actions/workflows/") &&
      String(request).includes("/runs?"))?.[0]);
    expect(historyUrl).not.toContain("branch=");
    expect(historyUrl).not.toContain("created=");
  });

  it("pins legacy quiesce job and write names only to run 34153306935", async () => {
    await expect(bridgeFixture({
      ambiguousUsesCurrentNames: true,
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
    );
    await expect(bridgeFixture({
      currentPrepareUsesLegacyNames: true,
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
    );
  });

  it("accepts an advanced mutable updated_at for the current nonterminal run", async () => {
    await expect(bridgeFixture({
      currentHistoryUpdatedAt: "2026-09-08T00:10:05Z",
    }).verify()).resolves.toMatchObject({
      coldQuiesceSuccessorAllRefsHistoryExact: true,
    });
  });

  it.each([
    ["overlapping unknown ref", coldRun({
      id: 34150000000,
      operation: "quiesce",
      createdAt: "2026-09-07T18:00:00Z",
      completedAt: "2026-09-07T18:20:00Z",
      conclusion: "failure",
      headSha: "c".repeat(40),
    })],
    ["unknown nonterminal run", coldRun({
      id: 34150000001,
      operation: "quiesce",
      createdAt: "2026-09-01T00:00:00Z",
      completedAt: "2026-09-01T00:00:00Z",
      conclusion: null,
      status: "in_progress",
      headSha: "d".repeat(40),
    })],
    ["unknown future run status", coldRun({
      id: 34150000002,
      operation: "quiesce",
      createdAt: "2026-09-01T00:00:00Z",
      completedAt: "2026-09-01T00:00:00Z",
      conclusion: null,
      status: "future_status",
      headSha: "e".repeat(40),
    })],
  ])("fails closed on %s from complete all-ref history", async (_label, extra) => {
    await expect(bridgeFixture({ extraRuns: [extra] }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
    );
  });

  it("fails closed when the current candidate is not the direct child", async () => {
    const fixture = bridgeFixture({ currentParentSha: "3".repeat(40) });

    await expect(fixture.verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_invalid",
    );
  });

  it("fails closed when the prior artifact digest is substituted", async () => {
    const fixture = bridgeFixture({
      artifactDigest: `sha256:${"4".repeat(64)}`,
    });

    await expect(fixture.verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_artifact_invalid",
    );
  });

  it("fails closed at the pinned successor deadline", async () => {
    const fixture = bridgeFixture({
      currentRunStartedAt: "2026-09-08T18:57:20.000Z",
    });

    await expect(fixture.verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_quiesce_successor_bridge_history_invalid",
    );
  });
});
