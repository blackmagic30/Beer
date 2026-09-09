import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  derivePostQDeploymentStopV3Deadline,
  parsePostQDeploymentStopReviewedAuthorityV3,
  postQDeploymentStopV3ConfirmationExact,
  postQDeploymentStopV3DeadlineExact,
} from "../scripts/lib/permanent-staging-post-q-deployment-stop-authority-v3.js";
import {
  authorizationSourceExact,
  deriveSuccessorDeadline as deriveV3VerifierDeadline,
  historicalWorkflowBlobExact,
  successorPolicyExact,
  verifyPostQReviewedCandidate as verifyPostQReviewedCandidateV3,
} from "../scripts/verify-permanent-staging-post-q-authority-v3.mjs";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const hash = (source: string) =>
  crypto.createHash("sha256").update(source).digest("hex");
const candidateSha = "a".repeat(40);
const reviewedHeadSha = "c".repeat(40);
const reviewedTreeSha = "d".repeat(40);
const currentRunId = 34_240_000_000;
const v2CandidateSha = "78162cf42a0ef3190343a657ff94f288d4a4c7ca";
const preV2CandidateSha = "d27275f4c101b764c6016e8b378969c14719258e";
const expiredRunHeadSha = "f8640f6b3c5fb4c152dbd771eedb01a6e0df16d7";
const qHeadSha = "606d33facb515dd10bc94c360e43c20beb999cc1";
const repository = "blackmagic30/Beer";
const repositoryId = 1_215_862_300;
const actorId = 29_029_791;
const v3RequiredChecks = [
  ["postgres-tool-runtime-closure-observation", ".github/workflows/ci.yml"],
  ["postgres-migration-integration", ".github/workflows/ci.yml"],
  ["build-test-scan", ".github/workflows/ci.yml"],
  ["supabase-database", ".github/workflows/ci.yml"],
  ["CodeQL JavaScript and TypeScript", ".github/workflows/codeql.yml"],
  ["CodeQL Swift", ".github/workflows/codeql.yml"],
  ["release-readiness", ".github/workflows/pintpath-release-readiness.yml"],
  ["ios", ".github/workflows/native-apps.yml"],
] as const;
const v3Artifacts = new Map([
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

function v3CurrentRun() {
  const title = `Permanent staging post-Q deployment stop | ${candidateSha}`;
  return {
    id: currentRunId,
    workflow_id: 353_312_302,
    run_number: 2,
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

function v3ProviderFixtures() {
  return {
    currentPullSummary: [{
      number: 100,
      state: "closed",
      merge_commit_sha: candidateSha,
      base: { ref: "main", repo: { full_name: repository } },
      head: { repo: { full_name: repository } },
    }],
    currentPull: {
      number: 100,
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
      parents: [{ sha: v2CandidateSha }],
    },
    currentReviewedHead: {
      sha: reviewedHeadSha,
      tree: { sha: reviewedTreeSha },
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

type V3ProviderFixtures = ReturnType<typeof v3ProviderFixtures>;

function v3ReviewedCandidateFetch(
  mutate?: (fixtures: V3ProviderFixtures) => void,
) {
  const fixtures = v3ProviderFixtures();
  mutate?.(fixtures);
  const checkByRun = new Map(v3RequiredChecks.map((row, index) => [
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
    } else if (url.pathname.endsWith("/pulls/100")) {
      value = fixtures.currentPull;
    } else if (url.pathname.endsWith(`/git/commits/${candidateSha}`)) {
      value = fixtures.currentCommit;
    } else if (url.pathname.endsWith(`/git/commits/${reviewedHeadSha}`)) {
      value = fixtures.currentReviewedHead;
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
      const index = v3RequiredChecks.findIndex(([expected]) => expected === name);
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
        const index = v3RequiredChecks.findIndex(([expected]) =>
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
        const name = v3Artifacts.get(producer)!;
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
        throw new Error(`unexpected V3 provider fixture URL: ${url}`);
      }
    }
    return new Response(JSON.stringify(value), { status: 200 });
  };
}

describe("post-deadline post-Q staging containment v3", () => {
  it("binds the exact 394-byte reviewed provenance serialization", () => {
    const source = read(
      "ops/railway/permanent-staging-post-q-deployment-stop-authorization-v3.json",
    );
    expect(Buffer.byteLength(source)).toBe(394);
    expect(hash(source)).toBe(
      "d2c7b4c9d700a1d7c5219dd6c4245d5900154421497b8c637ac93f9215662549",
    );
    const value = JSON.parse(source);
    expect(source).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(value).toEqual({
      schemaVersion: "pintpath-reviewed-user-authorization-provenance/v2",
      threadId: "01a02140-8628-7d30-9374-8d29d4a9f3a3",
      messages: [
        "you are always authorised until we are prod ready",
        "perfect so can we continue with pint path readyness?",
      ],
      provenanceUse:
        "pintpath-post-q-staging-stop-successor-v3-reviewed-context",
      cryptographicUserSignatureClaimed: false,
    });
    expect(authorizationSourceExact(source)).toBe(true);
    expect(authorizationSourceExact(`${source}\n`)).toBe(false);
    expect(authorizationSourceExact(source.replace("always", "sometimes")))
      .toBe(false);
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
      "ops/railway/permanent-staging-post-q-deployment-stop-policy-v3.json",
    ));
    const policySource = read(
      "ops/railway/permanent-staging-post-q-deployment-stop-policy-v3.json",
    );
    expect(hash(policySource)).toBe(
      "e7c0adec553e42e28ff2ae877835aa3255cfaa2ee8584f64c08ebe7983d901dd",
    );
    expect(successorPolicyExact(policySource)).toBe(true);
    expect(successorPolicyExact(policySource.replace(
      '"requiredRunNumber": 2',
      '"requiredRunNumber": 3',
    ))).toBe(false);
    expect(policy).toMatchObject({
      schemaVersion:
        "pintpath-permanent-staging-post-q-deployment-stop-policy/v3",
      workflow: {
        path: ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
        workflowId: 353312302,
        requiredRunNumber: 2,
        requiredTotalHistoryRows: 2,
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
      candidateLineage: {
        directParentSha: "78162cf42a0ef3190343a657ff94f288d4a4c7ca",
        directParentTreeSha: "410fd437bb0c459049f08bbff63ee605f2e65c9e",
        directParentSoleParentSha:
          "d27275f4c101b764c6016e8b378969c14719258e",
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

  it("authenticates the complete provider-side V2 ineligibility and V3 successor", async () => {
    const authority = await verifyPostQReviewedCandidateV3(
      v3ReviewedCandidateFetch(),
      "github-test-token-with-safe-length",
      candidateSha,
      v3CurrentRun(),
      Date.parse("2026-09-09T06:01:00Z"),
    );
    expect(authority).toMatchObject({
      schemaVersion:
        "pintpath-permanent-staging-post-q-reviewed-candidate-authority/v3",
      candidateSha,
      directParentSha: v2CandidateSha,
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
      },
    });
    expect(authority.requiredChecks).toHaveLength(8);
    expect(authority.requiredArtifacts).toHaveLength(3);
    expect(parsePostQDeploymentStopReviewedAuthorityV3(
      `${JSON.stringify(authority, null, 2)}\n`,
      { candidateSha, runId: String(currentRunId) },
    )).not.toBeNull();
  });

  it("fails closed on every authenticated V2 provider-history substitution", async () => {
    type Mutation = (fixtures: V3ProviderFixtures) => void;
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
      await expect(verifyPostQReviewedCandidateV3(
        v3ReviewedCandidateFetch(mutate),
        "github-test-token-with-safe-length",
        candidateSha,
        v3CurrentRun(),
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
        const current = v3CurrentRun();
        current[field] = timestamp;
        await expect(verifyPostQReviewedCandidateV3(
          v3ReviewedCandidateFetch(),
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

  it("keeps v3 archived while the canonical workflow uses only v4 authority/runtime", () => {
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

  it("queries unfiltered history by numeric workflow id", () => {
    const verifier = read(
      "scripts/verify-permanent-staging-post-q-authority-v3.mjs",
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
    expect(derivePostQDeploymentStopV3Deadline(
      "2026-09-10T05:30:00Z",
      "2026-09-10T06:00:00Z",
    )).toBe("2026-09-10T07:30:00.000Z");
    expect(deriveV3VerifierDeadline(
      "2026-09-10T05:30:00Z",
      "2026-09-10T06:00:00Z",
    )).toBe("2026-09-10T07:30:00.000Z");
    expect(derivePostQDeploymentStopV3Deadline(
      "2026-09-10T03:00:00Z",
      "2026-09-10T06:00:00Z",
    )).toBe("2026-09-10T07:00:00.000Z");
    expect(derivePostQDeploymentStopV3Deadline(
      "2026-09-10T06:30:00Z",
      "2026-09-10T07:00:00Z",
    )).toBe("2026-09-10T08:00:00.000Z");
    expect(derivePostQDeploymentStopV3Deadline(
      "2026-09-10T07:00:01Z",
      "2026-09-10T07:00:00Z",
    )).toBeNull();
    expect(derivePostQDeploymentStopV3Deadline(
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
      expect(derivePostQDeploymentStopV3Deadline(
        noncanonical,
        "2026-09-10T07:00:00Z",
      ), `merge:${noncanonical}`).toBeNull();
      expect(derivePostQDeploymentStopV3Deadline(
        "2026-09-10T06:00:00Z",
        noncanonical,
      ), `run:${noncanonical}`).toBeNull();
      expect(deriveV3VerifierDeadline(
        noncanonical,
        "2026-09-10T07:00:00Z",
      ), `verifier-merge:${noncanonical}`).toBeNull();
      expect(deriveV3VerifierDeadline(
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
      reviewedPullRequestNumber: 101,
      reviewedPullRequestMergedAt: "2026-09-09T05:30:00Z",
      authorizationDeadline: "2026-09-09T07:30:00.000Z",
      workflowRunStartedAt: "2026-09-09T06:00:00Z",
      workflowRunId: "34300000000",
      workflowRunAttempt: 1 as const,
      reviewedAuthorityExact: true as const,
      freshDispatchWriteGuardExact: true as const,
    };
    expect(postQDeploymentStopV3DeadlineExact(
      authority,
      Date.parse("2026-09-09T07:29:59.999Z"),
    )).toBe(true);
    expect(postQDeploymentStopV3DeadlineExact(
      authority,
      Date.parse("2026-09-09T07:30:00.000Z"),
    )).toBe(false);
    expect(postQDeploymentStopV3DeadlineExact({
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

  it("requires the action-specific confirmation and fresh v3 identifiers", () => {
    const env = {
      PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:
        "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN",
      PINTPATH_POST_Q_DEPLOYMENT_STOP_V3_AUTHORIZATION_ID:
        "pintpath-post-q-staging-stop-reauthorization-2026-09-10/v3",
      PINTPATH_POST_Q_DEPLOYMENT_STOP_V3_AUTHORIZATION_SOURCE_SHA256:
        "d2c7b4c9d700a1d7c5219dd6c4245d5900154421497b8c637ac93f9215662549",
      PINTPATH_POST_Q_DEPLOYMENT_STOP_CONFIRMATION:
        `REAUTHORIZE_ONE_STAGING_DEPLOYMENT_STOP_6300A324_9407_4B1C_B651_749C47E9537F_FOR_${candidateSha}_UNDER_V3_FROM_01A02140_8628_7D30_9374_8D29D4A9F3A3`,
    };
    expect(postQDeploymentStopV3ConfirmationExact(candidateSha, env)).toBe(true);
    expect(postQDeploymentStopV3ConfirmationExact(candidateSha, {
      ...env,
      PINTPATH_POST_Q_DEPLOYMENT_STOP_V3_AUTHORIZATION_ID:
        "pintpath-permanent-staging-post-q-deployment-stop-containment",
    })).toBe(false);
  });
});
