import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  runGithubReviewedCandidateAuthority,
  verifyGithubReviewedCandidateAuthority,
} from "../scripts/verify-github-reviewed-candidate-authority.mjs";
import {
  protectedPermanentStagingVariableMutationInternals,
} from "../scripts/execute-protected-permanent-staging-variable-mutation.js";

const CANDIDATE = "a".repeat(40);
const REVIEWED_HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
const INCIDENT_ORIGINAL_CANDIDATE =
  "ac7130e0306802825922d21a4c61135b84edd43b";
const INCIDENT_ORIGINAL_REVIEWED_HEAD =
  "b41c39a601f20a510ccbc09187acdca29abd7a02";
const INCIDENT_ORIGINAL_TREE = "b111b763883f04d06642f8e01386b0af5a201fa0";
const INCIDENT_OPERATION =
  "cancel-masked-forbidden-offsite-backup-deletion-patch";
const INCIDENT_PRIOR_RUN_ID = 33164687424;
const INCIDENT_ARTIFACT_ID = 9683176636;
const INCIDENT_ARTIFACT_NAME =
  "pintpath-permanent-staging-provider-mutation-remove-forbidden-offsite-backup-variables-ac7130e0306802825922d21a4c61135b84edd43b";
const INCIDENT_ARTIFACT_DIGEST =
  "sha256:0df300c84d53ece3fca5f7c72007bf5dd4a8ba9d1ea989e5d74bc80904aed98e";
const CLEANUP_CLOSEOUT_OPERATION =
  "reconcile-completed-forbidden-offsite-backup-deletion";
const CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE =
  "0eadad05ce6c313ed3c12492d3095609ce5872d5";
const CLEANUP_CLOSEOUT_ORIGINAL_HEAD =
  "b8d0d0e44cf63e996388a223ba4ee2ff02ab02e5";
const CLEANUP_CLOSEOUT_ORIGINAL_TREE =
  "2f624d697d97f5682d7b69231ed4d0ec66a21e6d";
const CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID = 33246243698;
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID = 33246655561;
const CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_ID = 9712963222;
const CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_ID = 9713096183;
const REPOSITORY = "blackmagic30/Beer";
const PROVIDER_PATH =
  ".github/workflows/permanent-staging-provider-mutation.yml";
const CUTOVER_PATH =
  ".github/workflows/permanent-staging-supabase-legacy-cutover.yml";
const RUNTIME_PATH = ".github/workflows/configure-runtime-variable.yml";
const COLD_RECOVERY_PATH =
  ".github/workflows/recover-permanent-staging-cold-zero.yml";
const STAGING_BOOTSTRAP_PATH =
  ".github/workflows/bootstrap-permanent-staging-worker-fence.yml";
const WORKER_FENCE_PATH =
  ".github/workflows/configure-automatic-maintenance-worker-fence.yml";
const DEPLOYMENT_PATH = ".github/workflows/deploy-permanent-staging.yml";
const PROVIDER_OPERATIONS = [
  "provider-google-maps-api-key",
  "provider-google-maps-map-id",
  "provider-google-places-api-key",
  "provider-openai-api-key",
  "supabase-key-replacement",
  "remove-forbidden-offsite-backup-variables",
  "resume-forbidden-offsite-backup-deletion-patch",
  "cancel-forbidden-offsite-backup-deletion-patch",
  "cancel-masked-forbidden-offsite-backup-deletion-patch",
  "reconcile-completed-forbidden-offsite-backup-deletion",
] as const;
const DISABLE_CUTOVER_MODE = "disable-enabled-legacy-keys";
const RECONCILE_CUTOVER_MODE = "reconcile-already-disabled-legacy-keys";

function cutoverTitle(mode: string) {
  return `Permanent staging Supabase legacy cutover | ${mode} | ${CANDIDATE}`;
}

type Run = ReturnType<typeof workflowRun>;

function title(operation: string) {
  return `Permanent staging provider mutation | ${operation} | ${CANDIDATE}`;
}

function workflowRun(input: {
  id: number;
  path: string;
  displayTitle: string;
  status?: string;
  conclusion?: string | null;
  createdAt?: string;
  updatedAt?: string;
  runAttempt?: number;
  headSha?: string;
}) {
  const createdAt = input.createdAt ?? "2026-08-14T01:00:00.000Z";
  const updatedAt = input.updatedAt ?? new Date(
    Date.parse(createdAt) + 10 * 60 * 1000,
  ).toISOString();
  return {
    id: input.id,
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    head_sha: input.headSha ?? CANDIDATE,
    head_branch: "main",
    path: `${input.path}@main`,
    event: "workflow_dispatch",
    display_title: input.displayTitle,
    run_attempt: input.runAttempt ?? 1,
    status: input.status ?? "completed",
    conclusion: input.conclusion === undefined ? "success" : input.conclusion,
    created_at: createdAt,
    run_started_at: createdAt,
    updated_at: updatedAt,
  };
}

function jobs(run: Run, stepConclusion: string) {
  const cutover = run.path.startsWith(CUTOVER_PATH);
  const coldPrepare = run.path.startsWith(COLD_RECOVERY_PATH) &&
    run.display_title ===
      `Permanent staging cold recovery | prepare | ${CANDIDATE}`;
  const coldPrepareReconcile = run.path.startsWith(COLD_RECOVERY_PATH) &&
    run.display_title ===
      `Permanent staging cold recovery | reconcile-prepare | ${CANDIDATE}`;
  const coldQuiesce = run.path.startsWith(COLD_RECOVERY_PATH) &&
    run.display_title ===
      `Permanent staging cold recovery | quiesce | ${CANDIDATE}`;
  const coldReconcile = run.path.startsWith(COLD_RECOVERY_PATH) &&
    run.display_title ===
      `Permanent staging cold recovery | reconcile-quiesce | ${CANDIDATE}`;
  if (coldPrepare || coldPrepareReconcile || coldQuiesce || coldReconcile) {
    const selectedName = coldPrepare
      ? "Bind the exact replacement and prepare the dead baseline"
      : coldPrepareReconcile
      ? "Reconcile an ambiguous cold prepare at the exact dead baseline"
      : coldQuiesce
      ? "Initialize the exact dead baseline at explicit zero"
      : "Reconcile an ambiguous cold quiesce at exact zero";
    const selectedStep = coldPrepare
      ? "Prepare the exact dead staging baseline once"
      : coldPrepareReconcile
      ? "Prove the ambiguous cold prepare reached the exact dead baseline without a second write"
      : coldQuiesce
      ? "Initialize the dead baseline from null to explicit zero once"
      : "Prove the ambiguous cold quiesce reached exact zero without a second write";
    const names = [
      "Bind the exact replacement and prepare the dead baseline",
      "Reconcile an ambiguous cold prepare at the exact dead baseline",
      "Initialize the exact dead baseline at explicit zero",
      "Reconcile an ambiguous cold quiesce at exact zero",
    ];
    return {
      total_count: 4,
      jobs: names.map((name) => name === selectedName
        ? {
            run_id: run.id,
            run_attempt: 1,
            name,
            status: "completed",
            conclusion: run.conclusion,
            steps: [{
              name: selectedStep,
              status: "completed",
              conclusion: stepConclusion,
            }],
          }
        : {
            run_id: run.id,
            run_attempt: 1,
            name,
            status: "completed",
            conclusion: "skipped",
            steps: [],
      }),
    };
  }
  const bootstrapRestore = run.path.startsWith(STAGING_BOOTSTRAP_PATH) &&
    run.display_title ===
      `Permanent staging worker bootstrap | restore | ${CANDIDATE}`;
  const bootstrapReconcile = run.path.startsWith(STAGING_BOOTSTRAP_PATH) &&
    run.display_title ===
      `Permanent staging worker bootstrap | reconcile-restore | ${CANDIDATE}`;
  if (bootstrapRestore || bootstrapReconcile) {
    const selectedName = bootstrapRestore
      ? "Verify the chain and perform one exact protected scale transition"
      : "Reconcile an ambiguous staging bootstrap restore at exact one";
    const names = [
      "Verify the chain and perform one exact protected scale transition",
      "Reconcile an ambiguous staging bootstrap restore at exact one",
    ];
    return {
      total_count: 2,
      jobs: names.map((name) => name === selectedName
        ? {
            run_id: run.id,
            run_attempt: 1,
            name,
            status: "completed",
            conclusion: run.conclusion,
            steps: [{
              name: bootstrapRestore
                ? "Perform at most one exact candidate-bound scale transition"
                : "Prove exact candidate one without a second scale transition",
              status: "completed",
              conclusion: stepConclusion,
            }],
          }
        : {
            run_id: run.id,
            run_attempt: 1,
            name,
            status: "completed",
            conclusion: "skipped",
            steps: [],
          }),
    };
  }
  const workerActivate = run.path.startsWith(WORKER_FENCE_PATH) &&
    run.display_title ===
      `Automatic maintenance worker fence | permanent-staging | activate | ${CANDIDATE}`;
  const workerReconcile = run.path.startsWith(WORKER_FENCE_PATH) &&
    run.display_title ===
      `Automatic maintenance worker fence | permanent-staging | reconcile-activate | ${CANDIDATE}`;
  if (workerActivate || workerReconcile) {
    const selectedName = workerActivate
      ? "One candidate-bound automatic-maintenance transition"
      : "Reconcile an ambiguous staging automatic-maintenance activation";
    const names = [
      "One candidate-bound automatic-maintenance transition",
      "Reconcile an ambiguous staging automatic-maintenance activation",
    ];
    return {
      total_count: 2,
      jobs: names.map((name) => name === selectedName
        ? {
            run_id: run.id,
            run_attempt: 1,
            name,
            status: "completed",
            conclusion: run.conclusion,
            steps: [{
              name: workerActivate
                ? "Execute at most one exact atomic Railway variable upsert"
                : "Prove exact activated state without a second variable upsert",
              status: "completed",
              conclusion: stepConclusion,
            }],
          }
        : {
            run_id: run.id,
            run_attempt: 1,
            name,
            status: "completed",
            conclusion: "skipped",
            steps: [],
          }),
    };
  }
  return {
    total_count: 1,
    jobs: [{
      run_id: run.id,
      run_attempt: 1,
      name: cutover
        ? "Reconcile or disable exact permanent-staging legacy keys"
        : "One protected variable mutation plan",
      status: "completed",
      conclusion: run.conclusion,
      steps: [{
        name: cutover
          ? "Canary replacement keys and reconcile or disable legacy keys once"
          : "Execute one reviewed protected Railway mutation plan",
        status: "completed",
        conclusion: stepConclusion,
      }],
    }],
  };
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function harness(options: {
  operation?: string;
  current?: Partial<Run>;
  providerRuns?: Run[];
  cutoverRuns?: Run[];
  runtimeRuns?: Run[];
  coldRecoveryRuns?: Run[];
  bootstrapRuns?: Run[];
  workerRuns?: Run[];
  deploymentRuns?: Run[];
  jobEvidence?: Record<number, unknown>;
  mergedAt?: string;
  replacementRunId?: string | null;
  deployment?: Run;
  deploymentRunId?: string;
  cutoverMode?: string;
  priorRunId?: string | null;
  prepareRunId?: string | null;
  target?: string;
  variableName?: string;
  incidentCandidateParent?: string;
  incidentArtifactDigest?: string;
  incidentArtifactExpired?: boolean;
  incidentArtifactExpiresAt?: string;
  cleanupCloseoutOriginalArtifactDigest?: string;
  cleanupCloseoutOriginalArtifactExpired?: boolean;
  cleanupCloseoutOriginalArtifactExpiresAt?: string;
  cleanupCloseoutFailedRecoveryArtifactDigest?: string;
  cleanupCloseoutFailedRecoveryArtifactExpired?: boolean;
  cleanupCloseoutFailedRecoveryArtifactExpiresAt?: string;
  cleanupCloseoutExtraProviderRuns?: Run[];
} = {}) {
  const operation = options.operation ?? "supabase-key-replacement";
  const incident = operation === INCIDENT_OPERATION;
  const cleanupCloseout = operation === CLEANUP_CLOSEOUT_OPERATION;
  const cutover = operation === "supabase-legacy-key-cutover";
  const cutoverMode = options.cutoverMode ?? DISABLE_CUTOVER_MODE;
  const runtime = operation === "runtime-variable";
  const coldPrepare = operation === "cold-recovery-prepare";
  const coldPrepareReconcile =
    operation === "cold-recovery-reconcile-prepare";
  const coldQuiesce = operation === "cold-recovery-quiesce";
  const coldReconcile = operation === "cold-recovery-reconcile-quiesce";
  const restoreReconcile =
    operation === "staging-worker-bootstrap-reconcile-restore";
  const activateReconcile =
    operation === "staging-worker-fence-reconcile-activate";
  const coldRecovery = coldPrepare || coldPrepareReconcile || coldQuiesce ||
    coldReconcile;
  const currentId = cutover
    ? 600
    : runtime
    ? 650
    : coldPrepare
    ? 675
    : coldPrepareReconcile
    ? 674
    : coldQuiesce
    ? 676
    : coldReconcile
    ? 677
    : restoreReconcile
    ? 680
    : activateReconcile
    ? 690
    : 500;
  const target = options.target ?? "permanent-staging";
  const variableName = options.variableName ?? "SUPABASE_URL";
  const current = {
    ...workflowRun({
      id: currentId,
      path: cutover
        ? CUTOVER_PATH
        : runtime
        ? RUNTIME_PATH
        : coldRecovery
        ? COLD_RECOVERY_PATH
        : restoreReconcile
        ? STAGING_BOOTSTRAP_PATH
        : activateReconcile
        ? WORKER_FENCE_PATH
        : PROVIDER_PATH,
      displayTitle: cutover
        ? cutoverTitle(cutoverMode)
        : runtime
        ? `Configure runtime variable | ${target} | ${variableName} | ${CANDIDATE}`
        : coldRecovery
        ? `Permanent staging cold recovery | ${coldPrepare
          ? "prepare"
          : coldPrepareReconcile
          ? "reconcile-prepare"
          : coldQuiesce
          ? "quiesce"
          : "reconcile-quiesce"} | ${CANDIDATE}`
        : restoreReconcile
        ? `Permanent staging worker bootstrap | reconcile-restore | ${CANDIDATE}`
        : activateReconcile
        ? `Automatic maintenance worker fence | permanent-staging | reconcile-activate | ${CANDIDATE}`
        : title(operation),
      status: "in_progress",
      conclusion: null,
      createdAt: incident
        ? "2026-08-28T11:20:00.000Z"
        : cleanupCloseout
        ? "2026-08-29T10:20:00.000Z"
        : "2026-08-14T02:00:00.000Z",
    }),
    ...options.current,
  };
  const closeoutOriginal = workflowRun({
    id: CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID,
    path: PROVIDER_PATH,
    displayTitle:
      `Permanent staging provider mutation | remove-forbidden-offsite-backup-variables | ${CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE}`,
    conclusion: "failure",
    createdAt: "2026-08-29T09:45:53Z",
    updatedAt: "2026-08-29T09:49:29Z",
    headSha: CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE,
  });
  const closeoutFailedRecovery = workflowRun({
    id: CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID,
    path: PROVIDER_PATH,
    displayTitle:
      `Permanent staging provider mutation | resume-forbidden-offsite-backup-deletion-patch | ${CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE}`,
    conclusion: "failure",
    createdAt: "2026-08-29T09:56:44Z",
    updatedAt: "2026-08-29T10:00:57Z",
    headSha: CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE,
  });
  const providerRuns = options.providerRuns ??
    (cutover || coldPrepare || coldPrepareReconcile
    ? [workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      createdAt: "2026-08-14T00:45:00.000Z",
    })]
    : runtime || coldRecovery || restoreReconcile || activateReconcile
    ? []
    : cleanupCloseout
    ? [
        closeoutOriginal,
        closeoutFailedRecovery,
        ...(options.cleanupCloseoutExtraProviderRuns ?? []),
        current,
      ]
    : [current]);
  const cutoverRuns = options.cutoverRuns ?? (cutover ? [current] : []);
  const runtimeRuns = options.runtimeRuns ?? (runtime ? [current] : []);
  const selectedPrepare = workflowRun({
    id: 675,
    path: COLD_RECOVERY_PATH,
    displayTitle: `Permanent staging cold recovery | prepare | ${CANDIDATE}`,
    createdAt: "2026-08-14T00:45:00.000Z",
  });
  selectedPrepare.updated_at = "2026-08-14T01:00:00.000Z";
  const ambiguousPrepare = workflowRun({
    id: 673,
    path: COLD_RECOVERY_PATH,
    displayTitle: `Permanent staging cold recovery | prepare | ${CANDIDATE}`,
    conclusion: "cancelled",
    createdAt: "2026-08-14T01:10:00.000Z",
  });
  const ambiguousQuiesce = workflowRun({
    id: 676,
    path: COLD_RECOVERY_PATH,
    displayTitle: `Permanent staging cold recovery | quiesce | ${CANDIDATE}`,
    conclusion: "cancelled",
    createdAt: "2026-08-14T01:10:00.000Z",
  });
  const coldRecoveryRuns = options.coldRecoveryRuns ??
    (coldPrepareReconcile
      ? [ambiguousPrepare, current]
      : coldReconcile
      ? [selectedPrepare, ambiguousQuiesce, current]
      : coldRecovery ? [current] : []);
  const selectedQuiesce = workflowRun({
    id: 678,
    path: STAGING_BOOTSTRAP_PATH,
    displayTitle: `Permanent staging worker bootstrap | quiesce | ${CANDIDATE}`,
    createdAt: "2026-08-14T00:45:00.000Z",
  });
  const ambiguousRestore = workflowRun({
    id: 679,
    path: STAGING_BOOTSTRAP_PATH,
    displayTitle: `Permanent staging worker bootstrap | restore | ${CANDIDATE}`,
    conclusion: "cancelled",
    createdAt: "2026-08-14T01:10:00.000Z",
  });
  const bootstrapRuns = options.bootstrapRuns ?? (restoreReconcile
    ? [selectedQuiesce, ambiguousRestore, current]
    : []);
  const selectedWorkerPrepare = workflowRun({
    id: 688,
    path: WORKER_FENCE_PATH,
    displayTitle:
      `Automatic maintenance worker fence | permanent-staging | prepare | ${CANDIDATE}`,
    createdAt: "2026-08-14T00:45:00.000Z",
  });
  const ambiguousActivate = workflowRun({
    id: 689,
    path: WORKER_FENCE_PATH,
    displayTitle:
      `Automatic maintenance worker fence | permanent-staging | activate | ${CANDIDATE}`,
    conclusion: "cancelled",
    createdAt: "2026-08-14T01:10:00.000Z",
  });
  const workerRuns = options.workerRuns ?? (activateReconcile
    ? [selectedWorkerPrepare, ambiguousActivate, current]
    : []);
  const deployment = options.deployment ?? workflowRun({
    id: 700,
    path: DEPLOYMENT_PATH,
    displayTitle: "Deploy permanent staging",
    createdAt: "2026-08-14T01:15:00.000Z",
  });
  deployment.updated_at = "2026-08-14T01:50:00.000Z";
  const firstDeployment = workflowRun({
    id: 640,
    path: DEPLOYMENT_PATH,
    displayTitle: "Deploy permanent staging",
    createdAt: "2026-08-14T00:35:00.000Z",
  });
  const deploymentRuns = options.deploymentRuns ??
    (cutover ? [firstDeployment, deployment] : []);
  const deploymentRunId = options.deploymentRunId ?? "700";
  const selectedDeployment = deploymentRuns.find((run) =>
    String(run.id) === deploymentRunId) ?? deployment;
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes(`/commits/${CANDIDATE}/pulls?`)) {
      return response([{
        number: 24,
        state: "closed",
        merge_commit_sha: CANDIDATE,
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: { repo: { full_name: REPOSITORY } },
      }]);
    }
    if (url.endsWith("/pulls/24")) {
      return response({
        number: 24,
        state: "closed",
        merged: true,
        draft: false,
        merge_commit_sha: CANDIDATE,
        merged_at: options.mergedAt ?? (incident
          ? "2026-08-28T11:00:00.000Z"
          : cleanupCloseout
          ? "2026-08-29T10:10:00.000Z"
          : "2026-08-14T00:30:00.000Z"),
        user: { id: 101 },
        merged_by: { id: 202 },
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: { sha: REVIEWED_HEAD, repo: { full_name: REPOSITORY } },
      });
    }
    if (url.includes("/pulls/24/reviews?")) {
      return response([{
        id: 303,
        user: { id: 303, login: "trusted-reviewer" },
        state: "APPROVED",
        commit_id: REVIEWED_HEAD,
        submitted_at: "2026-08-14T00:20:00.000Z",
        author_association: "MEMBER",
      }]);
    }
    if (url.endsWith("/collaborators/trusted-reviewer/permission")) {
      return response({
        permission: "write",
        user: { id: 303, login: "trusted-reviewer" },
      });
    }
    if (url.endsWith(`/git/commits/${CANDIDATE}`)) {
      return response({
        sha: CANDIDATE,
        tree: { sha: TREE },
        parents: [{
          sha: incident
            ? options.incidentCandidateParent ?? INCIDENT_ORIGINAL_CANDIDATE
            : cleanupCloseout
            ? options.incidentCandidateParent ??
              CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE
            : "d".repeat(40),
        }],
      });
    }
    if (url.endsWith(`/git/commits/${REVIEWED_HEAD}`)) {
      return response({
        sha: REVIEWED_HEAD,
        tree: { sha: TREE },
        parents: [{ sha: "e".repeat(40) }],
      });
    }
    if (url.includes(`/commits/${INCIDENT_ORIGINAL_CANDIDATE}/pulls?`)) {
      return response([{
        number: 65,
        state: "closed",
        merge_commit_sha: INCIDENT_ORIGINAL_CANDIDATE,
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: { repo: { full_name: REPOSITORY } },
      }]);
    }
    if (url.endsWith("/pulls/65")) {
      return response({
        number: 65,
        state: "closed",
        merged: true,
        draft: false,
        merge_commit_sha: INCIDENT_ORIGINAL_CANDIDATE,
        merged_at: "2026-08-28T10:20:39Z",
        user: { id: 101 },
        merged_by: { id: 202 },
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: {
          sha: INCIDENT_ORIGINAL_REVIEWED_HEAD,
          repo: { full_name: REPOSITORY },
        },
      });
    }
    if (url.endsWith(`/git/commits/${INCIDENT_ORIGINAL_CANDIDATE}`)) {
      return response({
        sha: INCIDENT_ORIGINAL_CANDIDATE,
        tree: { sha: INCIDENT_ORIGINAL_TREE },
        parents: [{ sha: "f".repeat(40) }],
      });
    }
    if (url.endsWith(`/git/commits/${INCIDENT_ORIGINAL_REVIEWED_HEAD}`)) {
      return response({
        sha: INCIDENT_ORIGINAL_REVIEWED_HEAD,
        tree: { sha: INCIDENT_ORIGINAL_TREE },
        parents: [{ sha: "e".repeat(40) }],
      });
    }
    if (url.includes(
      `/commits/${CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE}/pulls?`,
    )) {
      return response([{
        number: 71,
        state: "closed",
        merge_commit_sha: CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE,
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: { repo: { full_name: REPOSITORY } },
      }]);
    }
    if (url.endsWith("/pulls/71")) {
      return response({
        number: 71,
        state: "closed",
        merged: true,
        draft: false,
        merge_commit_sha: CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE,
        merged_at: "2026-08-29T09:42:49Z",
        user: { id: 101 },
        merged_by: { id: 202 },
        base: { ref: "main", repo: { full_name: REPOSITORY } },
        head: {
          sha: CLEANUP_CLOSEOUT_ORIGINAL_HEAD,
          repo: { full_name: REPOSITORY },
        },
      });
    }
    if (url.endsWith(
      `/git/commits/${CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE}`,
    )) {
      return response({
        sha: CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE,
        tree: { sha: CLEANUP_CLOSEOUT_ORIGINAL_TREE },
        parents: [{ sha: "f".repeat(40) }],
      });
    }
    if (url.endsWith(`/git/commits/${CLEANUP_CLOSEOUT_ORIGINAL_HEAD}`)) {
      return response({
        sha: CLEANUP_CLOSEOUT_ORIGINAL_HEAD,
        tree: { sha: CLEANUP_CLOSEOUT_ORIGINAL_TREE },
        parents: [{ sha: "e".repeat(40) }],
      });
    }
    if (url.endsWith(`/actions/runs/${currentId}`)) return response(current);
    if (url.endsWith(`/actions/runs/${CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID}`)) {
      return response(closeoutOriginal);
    }
    if (url.endsWith(
      `/actions/runs/${CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID}`,
    )) {
      return response(closeoutFailedRecovery);
    }
    if (url.includes(
      `/actions/runs/${CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID}/artifacts?`,
    )) {
      return response({
        total_count: 1,
        artifacts: [{
          id: CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_ID,
          name:
            "pintpath-permanent-staging-provider-mutation-remove-forbidden-offsite-backup-variables-0eadad05ce6c313ed3c12492d3095609ce5872d5",
          size_in_bytes: 2111,
          expired: options.cleanupCloseoutOriginalArtifactExpired ?? false,
          digest: options.cleanupCloseoutOriginalArtifactDigest ??
            "sha256:aeb28aef046845e9f8ce830c2ae4a2eee762ce79810c69a1727fbef07f121ad3",
          created_at: "2026-08-29T09:49:26Z",
          updated_at: "2026-08-29T09:49:26Z",
          expires_at: options.cleanupCloseoutOriginalArtifactExpiresAt ??
            "2026-09-28T09:49:25Z",
          workflow_run: {
            id: CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID,
            head_branch: "main",
            head_sha: CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE,
          },
        }],
      });
    }
    if (url.includes(
      `/actions/runs/${CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID}/artifacts?`,
    )) {
      return response({
        total_count: 1,
        artifacts: [{
          id: CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_ID,
          name:
            "pintpath-permanent-staging-provider-mutation-resume-forbidden-offsite-backup-deletion-patch-0eadad05ce6c313ed3c12492d3095609ce5872d5",
          size_in_bytes: 313,
          expired: options.cleanupCloseoutFailedRecoveryArtifactExpired ?? false,
          digest: options.cleanupCloseoutFailedRecoveryArtifactDigest ??
            "sha256:e1a4e7017298b49df7c0afb3fcc8a354740248c5333cb21248d3bbd80d65c0b8",
          created_at: "2026-08-29T10:00:54Z",
          updated_at: "2026-08-29T10:00:54Z",
          expires_at: options.cleanupCloseoutFailedRecoveryArtifactExpiresAt ??
            "2026-09-28T10:00:53Z",
          workflow_run: {
            id: CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID,
            head_branch: "main",
            head_sha: CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE,
          },
        }],
      });
    }
    if (url.endsWith(`/actions/runs/${INCIDENT_PRIOR_RUN_ID}`)) {
      return response(workflowRun({
        id: INCIDENT_PRIOR_RUN_ID,
        path: PROVIDER_PATH,
        displayTitle:
          `Permanent staging provider mutation | remove-forbidden-offsite-backup-variables | ${INCIDENT_ORIGINAL_CANDIDATE}`,
        status: "completed",
        conclusion: "failure",
        createdAt: "2026-08-28T10:47:25Z",
        updatedAt: "2026-08-28T10:51:43Z",
        headSha: INCIDENT_ORIGINAL_CANDIDATE,
      }));
    }
    if (url.includes(
      `/actions/runs/${INCIDENT_PRIOR_RUN_ID}/artifacts?`,
    )) {
      return response({
        total_count: 1,
        artifacts: [{
          id: INCIDENT_ARTIFACT_ID,
          name: INCIDENT_ARTIFACT_NAME,
          size_in_bytes: 2090,
          expired: options.incidentArtifactExpired ?? false,
          digest: options.incidentArtifactDigest ?? INCIDENT_ARTIFACT_DIGEST,
          created_at: "2026-08-28T10:51:40Z",
          updated_at: "2026-08-28T10:51:40Z",
          expires_at: options.incidentArtifactExpiresAt ??
            "2026-11-26T10:51:40Z",
          workflow_run: {
            id: INCIDENT_PRIOR_RUN_ID,
            head_branch: "main",
            head_sha: INCIDENT_ORIGINAL_CANDIDATE,
          },
        }],
      });
    }
    if (url.endsWith(`/actions/runs/${deploymentRunId}`)) {
      return response(selectedDeployment);
    }
    if (url.includes("/actions/workflows/permanent-staging-provider-mutation.yml/runs?")) {
      return response({
        total_count: providerRuns.length,
        workflow_runs: providerRuns,
      });
    }
    if (url.includes("/actions/workflows/permanent-staging-supabase-legacy-cutover.yml/runs?")) {
      return response({
        total_count: cutoverRuns.length,
        workflow_runs: cutoverRuns,
      });
    }
    if (url.includes("/actions/workflows/configure-runtime-variable.yml/runs?")) {
      return response({
        total_count: runtimeRuns.length,
        workflow_runs: runtimeRuns,
      });
    }
    if (url.includes("/actions/workflows/recover-permanent-staging-cold-zero.yml/runs?")) {
      return response({
        total_count: coldRecoveryRuns.length,
        workflow_runs: coldRecoveryRuns,
      });
    }
    if (url.includes("/actions/workflows/bootstrap-permanent-staging-worker-fence.yml/runs?")) {
      return response({
        total_count: bootstrapRuns.length,
        workflow_runs: bootstrapRuns,
      });
    }
    if (url.includes("/actions/workflows/configure-automatic-maintenance-worker-fence.yml/runs?")) {
      return response({
        total_count: workerRuns.length,
        workflow_runs: workerRuns,
      });
    }
    if (url.includes("/actions/workflows/deploy-permanent-staging.yml/runs?")) {
      return response({
        total_count: deploymentRuns.length,
        workflow_runs: deploymentRuns,
      });
    }
    const jobsMatch = /\/actions\/runs\/(\d+)\/jobs\?/.exec(url);
    if (jobsMatch) {
      const runId = Number(jobsMatch[1]);
      return response(options.jobEvidence?.[runId] ??
        (incident && runId === INCIDENT_PRIOR_RUN_ID
          ? jobs(workflowRun({
              id: INCIDENT_PRIOR_RUN_ID,
              path: PROVIDER_PATH,
              displayTitle:
                `Permanent staging provider mutation | remove-forbidden-offsite-backup-variables | ${INCIDENT_ORIGINAL_CANDIDATE}`,
              status: "completed",
              conclusion: "failure",
              createdAt: "2026-08-28T10:47:25Z",
              updatedAt: "2026-08-28T10:51:43Z",
              headSha: INCIDENT_ORIGINAL_CANDIDATE,
            }), "failure")
          : cleanupCloseout && runId === CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID
          ? jobs(closeoutOriginal, "failure")
          : cleanupCloseout &&
              runId === CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID
          ? jobs(closeoutFailedRecovery, "failure")
          : coldPrepareReconcile && runId === ambiguousPrepare.id
          ? jobs(ambiguousPrepare, "cancelled")
          : coldReconcile && runId === ambiguousQuiesce.id
          ? jobs(ambiguousQuiesce, "cancelled")
          : restoreReconcile && runId === ambiguousRestore.id
          ? jobs(ambiguousRestore, "cancelled")
          : activateReconcile && runId === ambiguousActivate.id
          ? jobs(ambiguousActivate, "cancelled")
          : {
        total_count: 0,
        jobs: [],
      }));
    }
    return response({ message: "Not found" }, 404);
  }) as unknown as typeof fetch;
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: String(currentId),
    GITHUB_TOKEN: "github-token-long-enough", // security-scan allow: synthetic no-call fixture
  };
  return {
    current,
    env,
    fetchImpl,
    verify: () => verifyGithubReviewedCandidateAuthority({
      candidateSha: CANDIDATE,
      operation,
      replacementRunId: cutover || coldPrepare || coldPrepareReconcile
        ? options.replacementRunId ?? "500"
        : null,
      deploymentRunId: cutover ? deploymentRunId : null,
      cutoverMode: cutover ? cutoverMode : null,
      priorRunId: coldPrepareReconcile
        ? options.priorRunId ?? "673"
        : coldReconcile
        ? options.priorRunId ?? "676"
        : restoreReconcile
        ? options.priorRunId ?? "679"
        : activateReconcile
        ? options.priorRunId ?? "689"
        : incident
        ? options.priorRunId ?? String(INCIDENT_PRIOR_RUN_ID)
        : cleanupCloseout
        ? options.priorRunId ?? String(CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID)
        : options.priorRunId ?? null,
      prepareRunId: coldReconcile ? options.prepareRunId ?? "675" : null,
      target: runtime ? target : null,
      variableName: runtime ? variableName : null,
      env,
      fetchImpl,
    }),
  };
}

describe("reviewed candidate mutation authority", () => {
  it("binds the metadata-only cleanup closeout to the exact direct successor and both retained runs", async () => {
    const authority = await harness({
      operation: CLEANUP_CLOSEOUT_OPERATION,
    }).verify();
    expect(authority).toMatchObject({
      candidateSha: CANDIDATE,
      reviewedPrHeadSha: REVIEWED_HEAD,
      reviewedTreeExact: true,
      operation: CLEANUP_CLOSEOUT_OPERATION,
      cleanupCloseoutOriginalCandidateSha:
        CLEANUP_CLOSEOUT_ORIGINAL_CANDIDATE,
      cleanupCloseoutOriginalReviewedPrHeadSha:
        CLEANUP_CLOSEOUT_ORIGINAL_HEAD,
      cleanupCloseoutOriginalTreeSha: CLEANUP_CLOSEOUT_ORIGINAL_TREE,
      cleanupCloseoutSuccessorDirectParentExact: true,
      cleanupCloseoutOriginalRunId:
        String(CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID),
      cleanupCloseoutOriginalArtifactId:
        String(CLEANUP_CLOSEOUT_ORIGINAL_ARTIFACT_ID),
      cleanupCloseoutFailedRecoveryRunId:
        String(CLEANUP_CLOSEOUT_FAILED_RECOVERY_RUN_ID),
      cleanupCloseoutFailedRecoveryArtifactId:
        String(CLEANUP_CLOSEOUT_FAILED_RECOVERY_ARTIFACT_ID),
      cleanupCloseoutFailedRecoveryDispatchOnlyArtifactExact: true,
      cleanupCloseoutOriginalHistoryExact: true,
      cleanupCloseoutCurrentHistoryExact: true,
      cleanupCloseoutMinimumObservationMinutes: 10,
      cleanupCloseoutMinimumObservationSatisfiedExact: true,
      cleanupCloseoutAbsoluteDeadline: "2026-08-30T09:49:29.000Z",
      cleanupCloseoutMetadataOnlyExact: true,
    });
    const authorityDocument = {
      command: "verify-github-reviewed-candidate-authority",
      ok: true,
      ...authority,
    };
    const authorityExpected = {
      candidateSha: CANDIDATE,
      priorCleanupRunId: String(CLEANUP_CLOSEOUT_ORIGINAL_RUN_ID),
      currentRunId: "500",
    };
    const authorityExact = protectedPermanentStagingVariableMutationInternals
      .reviewedCleanupSuccessorCloseoutAuthorityValueExact;
    expect(authorityExact(authorityDocument, authorityExpected)).toBe(true);
    for (const tampered of [
      { ...authorityDocument, reviewedTreeExact: false },
      {
        ...authorityDocument,
        cleanupCloseoutOriginalArtifactDigest: `sha256:${"0".repeat(64)}`,
      },
      {
        ...authorityDocument,
        cleanupCloseoutFailedRecoveryRunId: "33246655562",
      },
      {
        ...authorityDocument,
        cleanupCloseoutMinimumObservationMinutes: 9,
      },
      { ...authorityDocument, unexpected: true },
    ]) expect(authorityExact(tampered, authorityExpected)).toBe(false);

    await expect(harness({
      operation: CLEANUP_CLOSEOUT_OPERATION,
      incidentCandidateParent: "d".repeat(40),
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cleanup_successor_closeout_candidate_invalid",
    );
  });

  it("rejects substituted, expired, or unavailable cleanup closeout artifacts", async () => {
    for (const options of [
      {
        cleanupCloseoutOriginalArtifactDigest:
          `sha256:${"0".repeat(64)}`,
      },
      { cleanupCloseoutFailedRecoveryArtifactExpired: true },
      {
        cleanupCloseoutOriginalArtifactExpiresAt:
          "2026-08-29T10:20:00.000Z",
      },
    ]) {
      await expect(harness({
        operation: CLEANUP_CLOSEOUT_OPERATION,
        ...options,
      }).verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_cleanup_successor_closeout_artifact_invalid",
      );
    }
  });

  it("rejects unaccounted provider history, a prior closeout, and an expired closeout dispatch", async () => {
    const unrelated = workflowRun({
      id: 499,
      path: PROVIDER_PATH,
      displayTitle:
        `Permanent staging provider mutation | provider-openai-api-key | ${"d".repeat(40)}`,
      createdAt: "2026-08-29T10:12:00.000Z",
      headSha: "d".repeat(40),
    });
    await expect(harness({
      operation: CLEANUP_CLOSEOUT_OPERATION,
      cleanupCloseoutExtraProviderRuns: [unrelated],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cleanup_successor_closeout_history_invalid",
    );

    const priorCloseout = workflowRun({
      id: 499,
      path: PROVIDER_PATH,
      displayTitle: title(CLEANUP_CLOSEOUT_OPERATION),
      createdAt: "2026-08-29T10:12:00.000Z",
    });
    await expect(harness({
      operation: CLEANUP_CLOSEOUT_OPERATION,
      cleanupCloseoutExtraProviderRuns: [priorCloseout],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cleanup_successor_closeout_history_invalid",
    );

    await expect(harness({
      operation: CLEANUP_CLOSEOUT_OPERATION,
      mergedAt: "2026-08-30T09:30:00.000Z",
      current: {
        created_at: "2026-08-30T09:49:29.000Z",
        run_started_at: "2026-08-30T09:49:29.000Z",
        updated_at: "2026-08-30T09:49:29.000Z",
      },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cleanup_successor_closeout_history_invalid",
    );
  });

  it("authorizes only the direct-child incident cancellation bound to the retained failed run", async () => {
    const authority = await harness({ operation: INCIDENT_OPERATION }).verify();
    expect(authority).toMatchObject({
        operation: INCIDENT_OPERATION,
        incidentOriginalCandidateSha: INCIDENT_ORIGINAL_CANDIDATE,
        incidentSuccessorDirectParentExact: true,
        incidentPriorCleanupRunId: String(INCIDENT_PRIOR_RUN_ID),
        incidentPriorCleanupArtifactId: String(INCIDENT_ARTIFACT_ID),
        incidentPriorCleanupArtifactDigest: INCIDENT_ARTIFACT_DIGEST,
        incidentPriorCleanupArtifactExact: true,
        incidentCancellationOnlyExact: true,
        incidentRecoveryWithinGraceExact: true,
        incidentSafePriorSkippedWriteRunIds: [],
        incidentAmbiguousPriorCancelRunIds: [],
        incidentPriorRunsStrictlyOrderedAndNonOverlappingExact: true,
        incidentSameCandidateConvergenceExact: true,
        incidentAbsoluteRecoveryDeadline: "2026-08-29T10:51:43.000Z",
        safePriorSkippedWriteRunIds: [],
        successfulStagingDeploymentRunIds: [],
      });
    expect(protectedPermanentStagingVariableMutationInternals
      .reviewedIncidentCleanupCancelAuthorityValueExact({
        command: "verify-github-reviewed-candidate-authority",
        ok: true,
        ...authority,
      }, {
        candidateSha: CANDIDATE,
        priorCleanupRunId: String(INCIDENT_PRIOR_RUN_ID),
        currentRunId: "500",
      })).toBe(true);
  });

  it("allows an ordered same-candidate retry only after an exact ambiguous incident write", async () => {
    const current = workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title(INCIDENT_OPERATION),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-28T11:20:00.000Z",
    });
    const ambiguous = workflowRun({
      id: 450,
      path: PROVIDER_PATH,
      displayTitle: title(INCIDENT_OPERATION),
      status: "completed",
      conclusion: "failure",
      createdAt: "2026-08-28T11:05:00.000Z",
      updatedAt: "2026-08-28T11:10:00.000Z",
    });
    await expect(harness({
      operation: INCIDENT_OPERATION,
      providerRuns: [current, ambiguous],
      jobEvidence: { 450: jobs(ambiguous, "failure") },
    }).verify()).resolves.toMatchObject({
      safePriorSkippedWriteRunIds: [],
      incidentSafePriorSkippedWriteRunIds: [],
      incidentAmbiguousPriorCancelRunIds: ["450"],
      incidentPriorRunsStrictlyOrderedAndNonOverlappingExact: true,
      incidentSameCandidateConvergenceExact: true,
    });
  });

  it("rejects overlapping, successful, or different-operation rescue-candidate history", async () => {
    const current = workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title(INCIDENT_OPERATION),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-28T11:20:00.000Z",
    });
    const first = workflowRun({
      id: 440,
      path: PROVIDER_PATH,
      displayTitle: title(INCIDENT_OPERATION),
      conclusion: "failure",
      createdAt: "2026-08-28T11:05:00.000Z",
      updatedAt: "2026-08-28T11:15:00.000Z",
    });
    const overlapping = workflowRun({
      id: 450,
      path: PROVIDER_PATH,
      displayTitle: title(INCIDENT_OPERATION),
      conclusion: "cancelled",
      createdAt: "2026-08-28T11:14:00.000Z",
      updatedAt: "2026-08-28T11:18:00.000Z",
    });
    await expect(harness({
      operation: INCIDENT_OPERATION,
      providerRuns: [current, overlapping, first],
      jobEvidence: {
        440: jobs(first, "failure"),
        450: jobs(overlapping, "cancelled"),
      },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_incident_cleanup_cancel_history_invalid",
    );

    const successful = workflowRun({
      id: 450,
      path: PROVIDER_PATH,
      displayTitle: title(INCIDENT_OPERATION),
      conclusion: "success",
      createdAt: "2026-08-28T11:05:00.000Z",
      updatedAt: "2026-08-28T11:10:00.000Z",
    });
    await expect(harness({
      operation: INCIDENT_OPERATION,
      providerRuns: [current, successful],
      jobEvidence: { 450: jobs(successful, "success") },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_incident_cleanup_cancel_history_invalid",
    );

    const otherOperation = workflowRun({
      id: 450,
      path: PROVIDER_PATH,
      displayTitle: title("provider-openai-api-key"),
      conclusion: "failure",
      createdAt: "2026-08-28T11:05:00.000Z",
      updatedAt: "2026-08-28T11:10:00.000Z",
    });
    await expect(harness({
      operation: INCIDENT_OPERATION,
      providerRuns: [current, otherOperation],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_incident_cleanup_cancel_history_invalid",
    );
  });

  it("rejects incident cancellation with the wrong parent, artifact, or recovery deadline", async () => {
    await expect(harness({
      operation: INCIDENT_OPERATION,
      incidentCandidateParent: "d".repeat(40),
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_incident_cleanup_cancel_successor_invalid",
    );
    await expect(harness({
      operation: INCIDENT_OPERATION,
      incidentArtifactDigest: `sha256:${"0".repeat(64)}`,
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_incident_cleanup_cancel_artifact_invalid",
    );
    await expect(harness({
      operation: INCIDENT_OPERATION,
      current: {
        created_at: "2026-08-29T10:51:43.000Z",
        run_started_at: "2026-08-29T10:51:43.000Z",
        updated_at: "2026-08-29T10:51:44.000Z",
      },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_incident_cleanup_cancel_history_invalid",
    );
  });

  it("binds cold history to the exact workflow job names", () => {
    const workflow = fs.readFileSync(COLD_RECOVERY_PATH, "utf8");
    expect(workflow).toContain(
      "name: Bind the exact replacement and prepare the dead baseline",
    );
    expect(workflow).toContain(
      "name: Reconcile an ambiguous cold prepare at the exact dead baseline",
    );
    expect(workflow).toContain(
      "name: Initialize the exact dead baseline at explicit zero",
    );
    expect(workflow).toContain(
      "name: Reconcile an ambiguous cold quiesce at exact zero",
    );
  });

  it("requires a selected replacement run in the cold-prepare CLI contract", async () => {
    const fixture = harness({ operation: "cold-recovery-prepare" });
    let summary = "";
    await expect(runGithubReviewedCandidateAuthority([
      "--candidate-sha",
      CANDIDATE,
      "--operation",
      "cold-recovery-prepare",
      "--replacement-run-id",
      "500",
    ], {
      env: fixture.env,
      fetchImpl: fixture.fetchImpl,
      writeOutput: (value: string) => { summary += value; },
    })).resolves.toBe(0);
    expect(JSON.parse(summary)).toMatchObject({
      ok: true,
      operation: "cold-recovery-prepare",
      selectedReplacementRunId: "500",
    });

    summary = "";
    await expect(runGithubReviewedCandidateAuthority([
      "--candidate-sha",
      CANDIDATE,
      "--operation",
      "cold-recovery-prepare",
    ], {
      env: fixture.env,
      fetchImpl: fixture.fetchImpl,
      writeOutput: (value: string) => { summary += value; },
    })).resolves.toBe(1);
    expect(JSON.parse(summary)).toMatchObject({
      ok: false,
      failureCode: "github_reviewed_candidate_authority_arguments_invalid",
    });
  });

  it.each([
    ["cold-recovery-prepare", "prepare", "675"],
    ["cold-recovery-quiesce", "quiesce", "676"],
    ["cold-recovery-reconcile-quiesce", "reconcile-quiesce", "677"],
  ])(
    "binds %s to the exact cold-recovery workflow dispatch",
    async (operation, coldOperation, workflowRunId) => {
      await expect(harness({ operation }).verify()).resolves.toMatchObject({
        operation,
        workflowPath: COLD_RECOVERY_PATH,
        workflowRunId,
        safePriorSkippedWriteRunIds: [],
        stagingLifecycleSealed: false,
        ...(operation === "cold-recovery-prepare"
          ? { selectedReplacementRunId: "500" }
          : operation === "cold-recovery-reconcile-quiesce"
          ? {
              priorAmbiguousColdQuiesceRunId: "676",
              selectedColdPrepareRunId: "675",
              secondColdScaleWritePreventedExact: true,
            }
          : {}),
        reviewedAuthorityExact: true,
        freshDispatchWriteGuardExact: true,
      });
      expect(coldOperation).toMatch(/^(prepare|quiesce|reconcile-quiesce)$/);
    },
  );

  it("authorizes read-only cold reconciliation for exactly one ambiguous quiesce", async () => {
    const fixture = harness({
      operation: "cold-recovery-reconcile-quiesce",
    });
    let summary = "";
    await expect(runGithubReviewedCandidateAuthority([
      "--candidate-sha", CANDIDATE,
      "--operation", "cold-recovery-reconcile-quiesce",
      "--prior-run-id", "676",
      "--prepare-run-id", "675",
    ], {
      env: fixture.env,
      fetchImpl: fixture.fetchImpl,
      writeOutput: (value: string) => { summary += value; },
    })).resolves.toBe(0);
    expect(JSON.parse(summary)).toMatchObject({
      ok: true,
      operation: "cold-recovery-reconcile-quiesce",
      priorAmbiguousColdQuiesceRunId: "676",
      selectedColdPrepareRunId: "675",
      exactPriorColdQuiesceCandidateRunBound: true,
      secondColdScaleWritePreventedExact: true,
    });

    const prepare = workflowRun({
      id: 675,
      path: COLD_RECOVERY_PATH,
      displayTitle: `Permanent staging cold recovery | prepare | ${CANDIDATE}`,
      createdAt: "2026-08-14T00:45:00.000Z",
    });
    prepare.updated_at = "2026-08-14T01:00:00.000Z";
    const ambiguous = workflowRun({
      id: 676,
      path: COLD_RECOVERY_PATH,
      displayTitle: `Permanent staging cold recovery | quiesce | ${CANDIDATE}`,
      conclusion: "cancelled",
      createdAt: "2026-08-14T01:10:00.000Z",
    });
    const current = workflowRun({
      id: 677,
      path: COLD_RECOVERY_PATH,
      displayTitle:
        `Permanent staging cold recovery | reconcile-quiesce | ${CANDIDATE}`,
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    const extraReconcile = workflowRun({
      id: 674,
      path: COLD_RECOVERY_PATH,
      displayTitle:
        `Permanent staging cold recovery | reconcile-quiesce | ${CANDIDATE}`,
      conclusion: "failure",
      createdAt: "2026-08-14T01:30:00.000Z",
    });
    await expect(harness({
      operation: "cold-recovery-reconcile-quiesce",
      coldRecoveryRuns: [prepare, ambiguous, extraReconcile, current],
      jobEvidence: { 676: jobs(ambiguous, "cancelled") },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_reconciliation_history_invalid",
    );
    await expect(harness({
      operation: "cold-recovery-reconcile-quiesce",
      coldRecoveryRuns: [prepare, ambiguous, extraReconcile, current],
      jobEvidence: {
        676: jobs(ambiguous, "cancelled"),
        674: jobs(extraReconcile, "failure"),
      },
    }).verify()).resolves.toMatchObject({
      safePriorReadOnlyRunIds: ["674"],
      priorAmbiguousColdQuiesceRunId: "676",
    });
    await expect(harness({
      operation: "cold-recovery-reconcile-quiesce",
      coldRecoveryRuns: [prepare, ambiguous, current],
      jobEvidence: { 676: jobs(ambiguous, "skipped") },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_reconciliation_history_invalid",
    );
    const wrongSibling = jobs(ambiguous, "cancelled") as {
      jobs: Array<{ name: string; conclusion: string }>;
    };
    wrongSibling.jobs.find((job) => job.name ===
      "Bind the exact replacement and prepare the dead baseline")!.conclusion =
      "success";
    await expect(harness({
      operation: "cold-recovery-reconcile-quiesce",
      coldRecoveryRuns: [prepare, ambiguous, current],
      jobEvidence: { 676: wrongSibling },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cold_reconciliation_history_invalid",
    );
  });

  it("carries a reconciled cold prepare and bounded read-only retry into quiesce recovery", async () => {
    const ambiguousPrepare = workflowRun({
      id: 670,
      path: COLD_RECOVERY_PATH,
      displayTitle: `Permanent staging cold recovery | prepare | ${CANDIDATE}`,
      conclusion: "cancelled",
      createdAt: "2026-08-14T00:40:00.000Z",
    });
    const failedPrepareReconcile = workflowRun({
      id: 671,
      path: COLD_RECOVERY_PATH,
      displayTitle:
        `Permanent staging cold recovery | reconcile-prepare | ${CANDIDATE}`,
      conclusion: "failure",
      createdAt: "2026-08-14T00:55:00.000Z",
    });
    const selectedPrepare = workflowRun({
      id: 675,
      path: COLD_RECOVERY_PATH,
      displayTitle:
        `Permanent staging cold recovery | reconcile-prepare | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:10:00.000Z",
    });
    const ambiguousQuiesce = workflowRun({
      id: 676,
      path: COLD_RECOVERY_PATH,
      displayTitle: `Permanent staging cold recovery | quiesce | ${CANDIDATE}`,
      conclusion: "cancelled",
      createdAt: "2026-08-14T01:30:00.000Z",
    });
    const current = workflowRun({
      id: 677,
      path: COLD_RECOVERY_PATH,
      displayTitle:
        `Permanent staging cold recovery | reconcile-quiesce | ${CANDIDATE}`,
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    await expect(harness({
      operation: "cold-recovery-reconcile-quiesce",
      coldRecoveryRuns: [
        ambiguousPrepare,
        failedPrepareReconcile,
        selectedPrepare,
        ambiguousQuiesce,
        current,
      ],
      jobEvidence: {
        670: jobs(ambiguousPrepare, "cancelled"),
        671: jobs(failedPrepareReconcile, "failure"),
        675: jobs(selectedPrepare, "success"),
        676: jobs(ambiguousQuiesce, "cancelled"),
      },
    }).verify()).resolves.toMatchObject({
      selectedColdPrepareRunId: "675",
      priorAmbiguousColdQuiesceRunId: "676",
      safePriorReadOnlyRunIds: ["671"],
    });
  });

  it.each([
    [
      "cold-recovery-reconcile-prepare",
      "673",
      {
        priorAmbiguousColdPrepareRunId: "673",
        exactPriorColdPrepareCandidateRunBound: true,
        secondColdPrepareWritePreventedExact: true,
      },
    ],
    [
      "staging-worker-bootstrap-reconcile-restore",
      "679",
      {
        priorAmbiguousStagingRestoreRunId: "679",
        exactPriorStagingRestoreCandidateRunBound: true,
        secondStagingRestoreScaleWritePreventedExact: true,
      },
    ],
    [
      "staging-worker-fence-reconcile-activate",
      "689",
      {
        priorAmbiguousStagingActivateRunId: "689",
        exactPriorStagingActivateCandidateRunBound: true,
        secondStagingActivateVariableWritePreventedExact: true,
      },
    ],
  ])(
    "authorizes %s only as an exact read-only runner-loss convergence",
    async (operation, priorRunId, expected) => {
      await expect(harness({ operation, priorRunId }).verify()).resolves.toMatchObject({
        operation,
        ...expected,
        runnerLossRecoveryOriginalRunCompletedAt:
          "2026-08-14T01:20:00.000Z",
        runnerLossRecoveryGraceHours: 24,
        runnerLossRecoveryWithinGraceExact: true,
        reviewedAuthorityExact: true,
      });

      const fixture = harness({ operation, priorRunId: "999" });
      await expect(fixture.verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_runner_loss_reconciliation_history_invalid",
      );
    },
  );

  it("keeps runner-loss recovery inside a fixed grace from the original write", async () => {
    const predecessor = workflowRun({
      id: 678,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle: `Permanent staging worker bootstrap | quiesce | ${CANDIDATE}`,
      createdAt: "2026-08-20T23:40:00.000Z",
    });
    const ambiguous = workflowRun({
      id: 679,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle: `Permanent staging worker bootstrap | restore | ${CANDIDATE}`,
      conclusion: "cancelled",
      createdAt: "2026-08-21T00:20:00.000Z",
      updatedAt: "2026-08-21T00:30:00.000Z",
    });
    const currentListing = workflowRun({
      id: 680,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle:
        `Permanent staging worker bootstrap | reconcile-restore | ${CANDIDATE}`,
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-22T00:30:00.000Z",
      updatedAt: "2026-08-22T00:31:00.000Z",
    });
    const base = {
      operation: "staging-worker-bootstrap-reconcile-restore",
      priorRunId: "679",
      mergedAt: "2026-08-14T00:30:00.000Z",
      bootstrapRuns: [predecessor, ambiguous, currentListing],
      current: {
        created_at: currentListing.created_at,
        run_started_at: currentListing.run_started_at,
        updated_at: currentListing.updated_at,
      },
      jobEvidence: { 679: jobs(ambiguous, "cancelled") },
    };
    await expect(harness(base).verify()).resolves.toMatchObject({
      runnerLossRecoveryWithinGraceExact: true,
    });
    const outside = workflowRun({
      ...{
        id: 680,
        path: STAGING_BOOTSTRAP_PATH,
        displayTitle:
          `Permanent staging worker bootstrap | reconcile-restore | ${CANDIDATE}`,
        status: "in_progress",
        conclusion: null,
        createdAt: "2026-08-22T00:30:00.001Z",
        updatedAt: "2026-08-22T00:31:00.000Z",
      },
    });
    await expect(harness({
      ...base,
      bootstrapRuns: [predecessor, ambiguous, outside],
      current: {
        created_at: outside.created_at,
        run_started_at: outside.run_started_at,
        updated_at: outside.updated_at,
      },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_runner_loss_reconciliation_grace_expired",
    );
  });

  it("allows bounded failed read-only convergence attempts before one final restore proof", async () => {
    const predecessor = workflowRun({
      id: 678,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle: `Permanent staging worker bootstrap | quiesce | ${CANDIDATE}`,
      createdAt: "2026-08-14T00:45:00.000Z",
    });
    const ambiguous = workflowRun({
      id: 679,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle: `Permanent staging worker bootstrap | restore | ${CANDIDATE}`,
      conclusion: "cancelled",
      createdAt: "2026-08-14T01:10:00.000Z",
    });
    const failedReadOnly = workflowRun({
      id: 681,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle:
        `Permanent staging worker bootstrap | reconcile-restore | ${CANDIDATE}`,
      conclusion: "failure",
      createdAt: "2026-08-14T01:30:00.000Z",
    });
    const current = workflowRun({
      id: 680,
      path: STAGING_BOOTSTRAP_PATH,
      displayTitle:
        `Permanent staging worker bootstrap | reconcile-restore | ${CANDIDATE}`,
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    await expect(harness({
      operation: "staging-worker-bootstrap-reconcile-restore",
      priorRunId: "679",
      bootstrapRuns: [predecessor, ambiguous, failedReadOnly, current],
      jobEvidence: {
        679: jobs(ambiguous, "cancelled"),
        681: jobs(failedReadOnly, "failure"),
      },
    }).verify()).resolves.toMatchObject({
      safePriorReadOnlyRunIds: ["681"],
      priorAmbiguousStagingRestoreRunId: "679",
    });
    failedReadOnly.updated_at = "2026-08-14T02:01:00.000Z";
    await expect(harness({
      operation: "staging-worker-bootstrap-reconcile-restore",
      priorRunId: "679",
      bootstrapRuns: [predecessor, ambiguous, failedReadOnly, current],
      jobEvidence: {
        679: jobs(ambiguous, "cancelled"),
        681: jobs(failedReadOnly, "failure"),
      },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_runner_loss_reconciliation_history_invalid",
    );
  });

  it.each([
    ["cold-recovery-prepare", "prepare", 675],
    ["cold-recovery-quiesce", "quiesce", 676],
  ])(
    "allows a %s retry only when the exact prior cold write step was skipped",
    async (operation, coldOperation, currentId) => {
      const current = workflowRun({
        id: currentId,
        path: COLD_RECOVERY_PATH,
        displayTitle:
          `Permanent staging cold recovery | ${coldOperation} | ${CANDIDATE}`,
        status: "in_progress",
        conclusion: null,
        createdAt: "2026-08-14T02:00:00.000Z",
      });
      const prior = workflowRun({
        id: currentId - 10,
        path: COLD_RECOVERY_PATH,
        displayTitle:
          `Permanent staging cold recovery | ${coldOperation} | ${CANDIDATE}`,
        conclusion: "failure",
        createdAt: "2026-08-14T01:30:00.000Z",
      });
      await expect(harness({
        operation,
        coldRecoveryRuns: [prior, current],
        jobEvidence: { [prior.id]: jobs(prior, "skipped") },
      }).verify()).resolves.toMatchObject({
        safePriorSkippedWriteRunIds: [String(prior.id)],
      });
      for (const evidence of [
        jobs(prior, "failure"),
        { total_count: 0, jobs: [] },
      ]) {
        await expect(harness({
          operation,
          coldRecoveryRuns: [prior, current],
          jobEvidence: { [prior.id]: evidence },
        }).verify()).rejects.toThrow(
          "github_reviewed_candidate_authority_prior_write_ambiguous",
        );
      }
    },
  );

  it("binds cold prepare to one selected successful key-replacement run", async () => {
    const selected = workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      createdAt: "2026-08-14T00:45:00.000Z",
    });
    await expect(harness({
      operation: "cold-recovery-prepare",
      providerRuns: [selected],
      replacementRunId: "500",
    }).verify()).resolves.toMatchObject({
      selectedReplacementRunId: "500",
      safeSkippedReplacementRunIds: [],
    });
    await expect(harness({
      operation: "cold-recovery-prepare",
      providerRuns: [selected],
      replacementRunId: "501",
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_replacement_history_invalid",
    );
  });

  it("binds the protected off-site cleanup as its own candidate operation", async () => {
    await expect(harness({
      operation: "remove-forbidden-offsite-backup-variables",
    }).verify()).resolves.toMatchObject({
      operation: "remove-forbidden-offsite-backup-variables",
      workflowRunId: "500",
      safePriorSkippedWriteRunIds: [],
      reviewedAuthorityExact: true,
    });
  });

  it.each([
    "resume-forbidden-offsite-backup-deletion-patch",
    "cancel-forbidden-offsite-backup-deletion-patch",
  ])(
    "binds %s to one exact prior ambiguous cleanup and exact patch identity",
    async (operation) => {
      const current = workflowRun({
        id: 500,
        path: PROVIDER_PATH,
        displayTitle: title(operation),
        status: "in_progress",
        conclusion: null,
        createdAt: "2026-08-14T02:00:00.000Z",
      });
      const priorCleanup = workflowRun({
        id: 450,
        path: PROVIDER_PATH,
        displayTitle: title("remove-forbidden-offsite-backup-variables"),
        conclusion: "failure",
        createdAt: "2026-08-14T01:00:00.000Z",
      });
      const generated = await harness({
        operation,
        priorRunId: "450",
        providerRuns: [priorCleanup, current],
        jobEvidence: { 450: jobs(priorCleanup, "failure") },
      }).verify();
      expect(generated).toMatchObject({
        operation,
        candidateSha: CANDIDATE,
        reviewedPrHeadSha: REVIEWED_HEAD,
        reviewedTreeExact: true,
        priorCleanupRunId: "450",
        priorCleanupPatchSha256:
          "3650174bf695aaebb3b9ba7f91a4f2a724a0806b30511578448964c36eebfb91",
        exactPriorCleanupCandidateRunBound: true,
        offsiteCleanupRecoveryOriginalRunCompletedAt:
          "2026-08-14T01:10:00.000Z",
        offsiteCleanupRecoveryGraceHours: 24,
        offsiteCleanupRecoveryWithinGraceExact: true,
      });
      expect(protectedPermanentStagingVariableMutationInternals
        .reviewedCleanupRecoveryAuthorityValueExact({
          command: "verify-github-reviewed-candidate-authority",
          ok: true,
          ...generated,
        }, {
          candidateSha: CANDIDATE,
          operation,
          priorCleanupRunId: "450",
          currentRunId: "500",
        })).toBe(true);

      const priorSameModeRecovery = workflowRun({
        id: 440,
        path: PROVIDER_PATH,
        displayTitle: title(operation),
        conclusion: "failure",
        createdAt: "2026-08-14T01:30:00.000Z",
      });
      await expect(harness({
        operation,
        priorRunId: "450",
        providerRuns: [priorCleanup, priorSameModeRecovery, current],
        jobEvidence: {
          450: jobs(priorCleanup, "failure"),
          440: jobs(priorSameModeRecovery, "failure"),
        },
      }).verify()).resolves.toMatchObject({
        ambiguousPriorSameModeRecoveryRunIds: ["440"],
        sameModeRecoveryConvergenceExact: true,
      });

      const priorOppositeModeRecovery = workflowRun({
        id: 441,
        path: PROVIDER_PATH,
        displayTitle: title(
          operation === "resume-forbidden-offsite-backup-deletion-patch"
            ? "cancel-forbidden-offsite-backup-deletion-patch"
            : "resume-forbidden-offsite-backup-deletion-patch",
        ),
        conclusion: "failure",
        createdAt: "2026-08-14T01:30:00.000Z",
      });
      await expect(harness({
        operation,
        priorRunId: "450",
        providerRuns: [priorCleanup, priorOppositeModeRecovery, current],
        jobEvidence: {
          450: jobs(priorCleanup, "failure"),
          441: jobs(priorOppositeModeRecovery, "failure"),
        },
      }).verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_prior_write_ambiguous",
      );

      const overlappingRecovery = workflowRun({
        id: 439,
        path: PROVIDER_PATH,
        displayTitle: title(operation),
        conclusion: "failure",
        createdAt: "2026-08-14T01:35:00.000Z",
      });
      priorSameModeRecovery.updated_at = "2026-08-14T01:50:00.000Z";
      await expect(harness({
        operation,
        priorRunId: "450",
        providerRuns: [
          priorCleanup,
          priorSameModeRecovery,
          overlappingRecovery,
          current,
        ],
        jobEvidence: {
          450: jobs(priorCleanup, "failure"),
          440: jobs(priorSameModeRecovery, "failure"),
          439: jobs(overlappingRecovery, "failure"),
        },
      }).verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_cleanup_recovery_history_invalid",
      );
    },
  );

  it("limits OFFSITE convergence to 24 hours from the original cleanup", async () => {
    const priorCleanup = workflowRun({
      id: 450,
      path: PROVIDER_PATH,
      displayTitle: title("remove-forbidden-offsite-backup-variables"),
      conclusion: "failure",
      createdAt: "2026-08-21T00:20:00.000Z",
      updatedAt: "2026-08-21T00:30:00.000Z",
    });
    const recoveryAt = (createdAt: string) => workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle:
        title("resume-forbidden-offsite-backup-deletion-patch"),
      status: "in_progress",
      conclusion: null,
      createdAt,
      updatedAt: "2026-08-22T00:31:00.000Z",
    });
    const inside = recoveryAt("2026-08-22T00:30:00.000Z");
    const shared = {
      operation: "resume-forbidden-offsite-backup-deletion-patch",
      priorRunId: "450",
      mergedAt: "2026-08-14T00:30:00.000Z",
      jobEvidence: { 450: jobs(priorCleanup, "failure") },
    };
    await expect(harness({
      ...shared,
      providerRuns: [priorCleanup, inside],
      current: {
        created_at: inside.created_at,
        run_started_at: inside.run_started_at,
        updated_at: inside.updated_at,
      },
    }).verify()).resolves.toMatchObject({
      offsiteCleanupRecoveryWithinGraceExact: true,
    });
    const outside = recoveryAt("2026-08-22T00:30:00.001Z");
    await expect(harness({
      ...shared,
      providerRuns: [priorCleanup, outside],
      current: {
        created_at: outside.created_at,
        run_started_at: outside.run_started_at,
        updated_at: outside.updated_at,
      },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cleanup_recovery_history_invalid",
    );
  });

  it("binds a fresh provider operation while ignoring four distinct prior operations", async () => {
    const current = workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    const otherOperations = PROVIDER_OPERATIONS.slice(0, 4).map(
      (operation, index) => workflowRun({
        id: 400 + index,
        path: PROVIDER_PATH,
        displayTitle: title(operation),
        createdAt: `2026-08-14T01:0${index}:00.000Z`,
      }),
    );
    await expect(harness({
      providerRuns: [...otherOperations, current],
    }).verify()).resolves.toMatchObject({
      operation: "supabase-key-replacement",
      workflowRunId: "500",
      safePriorSkippedWriteRunIds: [],
      reviewedAuthorityExact: true,
      freshDispatchWriteGuardExact: true,
    });
  });

  it("allows only a prior same-operation run proven skipped before the write", async () => {
    const prior = workflowRun({
      id: 450,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      status: "completed",
      conclusion: "failure",
      createdAt: "2026-08-14T01:00:00.000Z",
    });
    const current = workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    await expect(harness({
      providerRuns: [current, prior],
      jobEvidence: { 450: jobs(prior, "skipped") },
    }).verify()).resolves.toMatchObject({
      safePriorSkippedWriteRunIds: ["450"],
    });
    for (const evidence of [jobs(prior, "failure"), { total_count: 0, jobs: [] }]) {
      await expect(harness({
        providerRuns: [current, prior],
        jobEvidence: { 450: evidence },
      }).verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_prior_write_ambiguous",
      );
    }
  });

  it("binds cutover to one selected replacement and rejects prior replacement writes", async () => {
    const selected = workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      createdAt: "2026-08-14T00:45:00.000Z",
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      providerRuns: [selected],
    }).verify()).resolves.toMatchObject({
      operation: "supabase-legacy-key-cutover",
      selectedReplacementRunId: "500",
      safeSkippedReplacementRunIds: [],
      stagingDeploymentRunIds: ["640", "700"],
      closeoutDeploymentRunId: "700",
      stagingDeploymentSequenceExact: true,
    });

    const earlier = workflowRun({
      id: 450,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      createdAt: "2026-08-14T00:40:00.000Z",
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      providerRuns: [selected, earlier],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_replacement_history_invalid",
    );
  });

  it("requires cutover to select the second of exactly two successful deployments", async () => {
    const first = workflowRun({
      id: 640,
      path: DEPLOYMENT_PATH,
      displayTitle: "Deploy permanent staging",
      createdAt: "2026-08-14T00:35:00.000Z",
    });
    const second = workflowRun({
      id: 700,
      path: DEPLOYMENT_PATH,
      displayTitle: "Deploy permanent staging",
      createdAt: "2026-08-14T01:15:00.000Z",
    });
    second.updated_at = "2026-08-14T01:50:00.000Z";
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      deployment: second,
      deploymentRuns: [second],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cutover_deployment_sequence_invalid",
    );
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      deploymentRunId: "640",
      deploymentRuns: [first, second],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_cutover_deployment_sequence_invalid",
    );
  });

  it("rejects a repeated disable unless its write step was definitely skipped", async () => {
    const current = workflowRun({
      id: 600,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(DISABLE_CUTOVER_MODE),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    const prior = workflowRun({
      id: 550,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(DISABLE_CUTOVER_MODE),
      status: "completed",
      conclusion: "failure",
      createdAt: "2026-08-14T01:30:00.000Z",
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      cutoverMode: DISABLE_CUTOVER_MODE,
      cutoverRuns: [current, prior],
      jobEvidence: { 550: jobs(prior, "skipped") },
    }).verify()).resolves.toMatchObject({ safePriorSkippedWriteRunIds: ["550"] });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      cutoverMode: DISABLE_CUTOVER_MODE,
      cutoverRuns: [current, prior],
      jobEvidence: { 550: jobs(prior, "failure") },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_prior_write_ambiguous",
    );
  });

  it("permits one mode-bound read-only reconciliation after an ambiguous disable", async () => {
    const current = workflowRun({
      id: 600,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(RECONCILE_CUTOVER_MODE),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    const ambiguousDisable = workflowRun({
      id: 550,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(DISABLE_CUTOVER_MODE),
      conclusion: "failure",
      createdAt: "2026-08-14T01:30:00.000Z",
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      cutoverMode: RECONCILE_CUTOVER_MODE,
      cutoverRuns: [current, ambiguousDisable],
      jobEvidence: { 550: jobs(ambiguousDisable, "failure") },
    }).verify()).resolves.toMatchObject({
      cutoverMode: RECONCILE_CUTOVER_MODE,
      reconciledPriorAmbiguousDisableRunId: "550",
      secondCutoverWritePreventedExact: true,
      safePriorSkippedWriteRunIds: [],
    });

    const secondAmbiguousDisable = workflowRun({
      id: 540,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(DISABLE_CUTOVER_MODE),
      conclusion: "cancelled",
      createdAt: "2026-08-14T01:20:00.000Z",
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      cutoverMode: RECONCILE_CUTOVER_MODE,
      cutoverRuns: [current, ambiguousDisable, secondAmbiguousDisable],
      jobEvidence: {
        550: jobs(ambiguousDisable, "failure"),
        540: jobs(secondAmbiguousDisable, "cancelled"),
      },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_prior_write_ambiguous",
    );
  });

  it("classifies prior reconcile runs as read-only and never as write authority", async () => {
    const current = workflowRun({
      id: 600,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(DISABLE_CUTOVER_MODE),
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T02:00:00.000Z",
    });
    const priorReadOnly = workflowRun({
      id: 550,
      path: CUTOVER_PATH,
      displayTitle: cutoverTitle(RECONCILE_CUTOVER_MODE),
      conclusion: "failure",
      createdAt: "2026-08-14T01:30:00.000Z",
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      cutoverMode: DISABLE_CUTOVER_MODE,
      cutoverRuns: [current, priorReadOnly],
    }).verify()).resolves.toMatchObject({
      cutoverMode: DISABLE_CUTOVER_MODE,
      safePriorReadOnlyRunIds: ["550"],
    });
  });

  it("authenticates a runtime-variable caller and binds target plus variable", async () => {
    await expect(harness({
      operation: "runtime-variable",
      target: "permanent-staging",
      variableName: "SUPABASE_URL",
    }).verify()).resolves.toMatchObject({
      operation: "runtime-variable",
      workflowPath: RUNTIME_PATH,
      workflowRunId: "650",
      safePriorSkippedWriteRunIds: [],
      reviewedAuthorityExact: true,
    });
  });

  it("binds the fixed PostgreSQL source repair to its one staging-only target-variable pair", async () => {
    const fixture = harness({
      operation: "runtime-variable",
      target: "permanent-staging-postgres",
      variableName: "PINTPATH_RUNTIME_DATABASE_URL",
    });
    let summary = "";
    await expect(runGithubReviewedCandidateAuthority([
      "--candidate-sha", CANDIDATE,
      "--operation", "runtime-variable",
      "--target", "permanent-staging-postgres",
      "--variable-name", "PINTPATH_RUNTIME_DATABASE_URL",
    ], {
      env: fixture.env,
      fetchImpl: fixture.fetchImpl,
      writeOutput: (value: string) => { summary += value; },
    })).resolves.toBe(0);
    expect(JSON.parse(summary)).toMatchObject({
      ok: true,
      operation: "runtime-variable",
      workflowPath: RUNTIME_PATH,
      stagingLifecycleSealed: false,
    });

    for (const [target, variableName] of [
      ["production", "PINTPATH_RUNTIME_DATABASE_URL"],
      ["permanent-staging", "PINTPATH_RUNTIME_DATABASE_URL"],
      ["permanent-staging-postgres", "DATABASE_URL"],
    ]) {
      summary = "";
      await expect(runGithubReviewedCandidateAuthority([
        "--candidate-sha", CANDIDATE,
        "--operation", "runtime-variable",
        "--target", target!,
        "--variable-name", variableName!,
      ], {
        env: fixture.env,
        fetchImpl: fixture.fetchImpl,
        writeOutput: (value: string) => { summary += value; },
      })).resolves.toBe(1);
      expect(JSON.parse(summary)).toMatchObject({
        ok: false,
        failureCode: "github_reviewed_candidate_authority_arguments_invalid",
      });
    }
  });

  it("allows writes after deploy one and seals staging after deploy two", async () => {
    const first = workflowRun({
      id: 300,
      path: DEPLOYMENT_PATH,
      displayTitle: "Deploy Pint Path permanent staging",
      createdAt: "2026-08-14T00:40:00.000Z",
    });
    const second = workflowRun({
      id: 350,
      path: DEPLOYMENT_PATH,
      displayTitle: "Deploy Pint Path permanent staging",
      createdAt: "2026-08-14T01:20:00.000Z",
    });
    second.updated_at = "2026-08-14T01:30:00.000Z";

    await expect(harness({ deploymentRuns: [first] }).verify()).resolves.toMatchObject({
      successfulStagingDeploymentRunIds: ["300"],
      stagingLifecycleSealed: false,
    });
    for (const fixture of [
      harness({ deploymentRuns: [first, second] }),
      harness({
        current: {
          created_at: "2026-08-14T00:50:00.000Z",
          run_started_at: "2026-08-14T02:00:00.000Z",
        },
        deploymentRuns: [first, second],
      }),
      harness({
        operation: "runtime-variable",
        target: "permanent-staging",
        variableName: "SUPABASE_URL",
        deploymentRuns: [first, second],
      }),
    ]) {
      await expect(fixture.verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_staging_lifecycle_sealed",
      );
    }
    await expect(harness({
      operation: "runtime-variable",
      target: "production",
      variableName: "SUPABASE_URL",
      deploymentRuns: [first, second],
    }).verify()).resolves.toMatchObject({ operation: "runtime-variable" });
  });

  it("rejects every candidate-bound staging write after the selected deployment", async () => {
    const selected = workflowRun({
      id: 500,
      path: PROVIDER_PATH,
      displayTitle: title("supabase-key-replacement"),
      createdAt: "2026-08-14T00:45:00.000Z",
    });
    const lateProvider = workflowRun({
      id: 501,
      path: PROVIDER_PATH,
      displayTitle: title("provider-openai-api-key"),
      createdAt: "2026-08-14T01:16:00.000Z",
    });
    lateProvider.updated_at = "2026-08-14T01:20:00.000Z";
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      providerRuns: [selected, lateProvider],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_stale_deployment",
    );

    const lateRuntime = workflowRun({
      id: 701,
      path: RUNTIME_PATH,
      displayTitle:
        `Configure runtime variable | permanent-staging | SUPABASE_URL | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:51:00.000Z",
    });
    lateRuntime.updated_at = "2026-08-14T01:55:00.000Z";
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      providerRuns: [selected],
      runtimeRuns: [lateRuntime],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_stale_deployment",
    );

    const latePostgresRuntimeSource = workflowRun({
      id: 703,
      path: RUNTIME_PATH,
      displayTitle:
        `Configure runtime variable | permanent-staging-postgres | PINTPATH_RUNTIME_DATABASE_URL | ${CANDIDATE}`,
      createdAt: "2026-08-14T01:51:00.000Z",
    });
    latePostgresRuntimeSource.updated_at = "2026-08-14T01:55:00.000Z";
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      providerRuns: [selected],
      runtimeRuns: [latePostgresRuntimeSource],
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_stale_deployment",
    );

    const unrelatedProduction = workflowRun({
      id: 702,
      path: RUNTIME_PATH,
      displayTitle:
        `Configure runtime variable | production | SUPABASE_URL | ${CANDIDATE}`,
      status: "in_progress",
      conclusion: null,
      createdAt: "2026-08-14T01:51:00.000Z",
      runAttempt: 2,
    });
    await expect(harness({
      operation: "supabase-legacy-key-cutover",
      providerRuns: [selected],
      runtimeRuns: [unrelatedProduction],
    }).verify()).resolves.toMatchObject({
      noPostDeploymentStagingWritesExact: true,
    });
  });

  it("uses run start for the exact seven-day retained-history boundary", async () => {
    const exactBoundary = harness({
      current: {
        created_at: "2026-08-14T00:31:00.000Z",
        run_started_at: "2026-08-21T00:30:00.000Z",
        updated_at: "2026-08-21T00:30:01.000Z",
      },
    });
    await expect(exactBoundary.verify()).resolves.toMatchObject({
      candidateHistoryMaximumAgeHours: 168,
    });
    expect(exactBoundary.fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent(
        "2026-08-14T00:30:00.000Z..2026-08-21T00:30:00.000Z",
      )),
      expect.anything(),
    );
    await expect(harness({
      current: {
        created_at: "2026-08-14T00:31:00.000Z",
        run_started_at: "2026-08-21T00:30:00.001Z",
        updated_at: "2026-08-21T00:30:01.000Z",
      },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_candidate_history_expired",
    );
  });

  it("rejects a misbound current workflow before trusting history", async () => {
    await expect(harness({
      current: { path: `${CUTOVER_PATH}@main` },
    }).verify()).rejects.toThrow(
      "github_reviewed_candidate_authority_current_run_invalid",
    );
  });

  it.each(["in_progress", "pending", "queued", "requested", "waiting"])(
    "accepts the exact current run while GitHub reports the nonterminal %s state",
    async (status) => {
      await expect(harness({
        current: { status, conclusion: null },
        runtimeRuns: undefined,
      }).verify()).resolves.toMatchObject({
        workflowRunId: "500",
      });
    },
  );

  it.each(["completed", "failure", "cancelled", "timed_out"])(
    "rejects a current run in terminal state %s",
    async (status) => {
      await expect(harness({
        current: { status, conclusion: status === "completed" ? "success" : status },
      }).verify()).rejects.toThrow(
        "github_reviewed_candidate_authority_current_run_invalid",
      );
    },
  );
});
