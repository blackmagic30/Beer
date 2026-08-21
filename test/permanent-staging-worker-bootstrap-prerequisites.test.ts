import crypto from "node:crypto";
import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  runStagingWorkerBootstrapPrerequisiteVerifier,
  STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256,
  stagingWorkerBootstrapPrerequisiteInternals,
} from "../scripts/verify-permanent-staging-worker-bootstrap-prerequisites.js";

const CANDIDATE = "a".repeat(40);
const OLD_SOURCE = "b".repeat(40);
const REVIEWED_HEAD = "c".repeat(40);
const TREE = "d".repeat(40);
const CURRENT_RUN = "9000";
const PREPARE_RUN = "1000";
const QUIESCE_RUN = "2000";
const FENCED_DEPLOYMENT_RUN = "3000";
const POLICY_SHA =
  "a06c7393dfc332461d2c82af310b9cfb654f17884f85cd489d157ce7d06f61a3";
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const PREPARE_FILE =
  "/private/prepare/automatic-maintenance-worker-fence-terminal.json";
const QUIESCE_FILE = "/private/quiesce/quiesce-staging-zero-receipt.json";
const QUIESCE_VERIFICATION_FILE =
  "/private/quiesce/prerequisites-verification.json";
const FENCED_DEPLOYMENT_FILE =
  "/private/fenced/deployment-receipt.json";
const OUTPUT_FILE = "/private/output/prerequisites-verification.json";

const WORKER_CHECKS = {
  policyExact: true,
  githubAuthorityExact: true,
  tokenScopesExact: true,
  boundaryPreflightExact: true,
  targetPreflightExact: true,
  operationPreflightExact: true,
  durableIntentExact: true,
  writeAttemptedAtMostOnce: true,
  atomicVariablesExact: true,
  acknowledgementExact: true,
  postflightAttempted: true,
  targetPostflightExact: true,
  postflightDeploymentExact: true,
  runtimeRoutesPolledExact: true,
  runtimeMaintenanceStateExact: true,
  boundaryPostflightExact: true,
  noOtherProviderChanges: true,
  terminalEvidenceExact: true,
};

const SCALE_CHECKS = {
  policyExact: true,
  githubAuthorityExact: true,
  tokenScopesExact: true,
  cliExact: true,
  boundaryPreflightExact: true,
  targetPreflightExact: true,
  runtimePreflightExact: true,
  durableIntentExact: true,
  repositoryPrewriteReasserted: true,
  writeAttemptedAtMostOnce: true,
  acknowledgementExact: true,
  postflightAttempted: true,
  targetPostflightExact: true,
  runtimePostflightExact: true,
  candidateUnchanged: true,
  deploymentUnchanged: true,
  boundaryPostflightExact: true,
  terminalEvidenceExact: true,
  finalReceiptEvidenceExact: true,
};

const DEPLOYMENT_CHECKS = {
  policyExact: true,
  githubMainExact: true,
  sourceAuthorityExact: true,
  cliExact: true,
  writeTokenScopeExact: true,
  costPolicyExact: true,
  prerequisiteExact: true,
  boundaryPreflightExact: true,
  targetPreflightExact: true,
  gitAutodeployAbsent: true,
  collateralInventoryExact: true,
  durableIntentExact: true,
  sourceReasserted: true,
  writeAttemptedAtMostOnce: true,
  targetPostflightAttempted: true,
  targetPostflightExact: true,
  reconciliationCompleted: true,
  topologyPreserved: true,
  deploymentExact: true,
  runtimeHealthExact: true,
  runtimeStartupExact: true,
  runtimeReadinessExact: true,
  collateralStateUnchanged: true,
  boundaryPostflightExact: true,
  terminalEvidenceExact: true,
};

const VERIFICATION_CHECKS = {
  policiesExact: true,
  currentMainExact: true,
  reviewedCandidateExact: true,
  consumerRunAuthorityExact: true,
  prerequisiteRunsExact: true,
  artifactNamesAndDigestsExact: true,
  receiptSchemasAndBindingsExact: true,
  strictChronologyExact: true,
  noLaterMatchingRunsExact: true,
  evidenceSecretFreeExact: true,
};

function sha(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function prepareReceipt(): string {
  const binding = {
    policySha256: POLICY_SHA,
    candidateSha: CANDIDATE,
    target: "permanent-staging",
    operation: "prepare",
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    configuredVariables: {
      PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED: "false",
      PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: CANDIDATE,
    },
    skipDeploys: true,
  };
  const deployment = sha("legacy-deployment");
  const topology = sha("legacy-topology");
  const collateral = sha("legacy-collateral");
  return canonical({
    schemaVersion: "pintpath-automatic-maintenance-worker-fence-terminal/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    binding,
    bindingSha256: sha(canonical(binding)),
    outcome: "prepared",
    attempts: 1,
    retryAllowed: false,
    failureCode: null,
    authoritySha256: sha("authority"),
    intentSha256: sha("intent"),
    providerEvidence: {
      graphqlOperation: "variableCollectionUpsert",
      mutationCallCount: 1,
      acknowledgementExact: true,
      providerBeforeSha256: sha("before"),
      providerAfterSha256: sha("after"),
      deploymentBeforeIdSha256: deployment,
      deploymentAfterIdSha256: deployment,
      sourceBeforeSha: OLD_SOURCE,
      sourceAfterSha: OLD_SOURCE,
      sourcePreservedExact: true,
      deploymentIdChanged: false,
      topologyBeforeSha256: topology,
      topologyAfterSha256: topology,
      collateralVariablesBeforeSha256: collateral,
      collateralVariablesAfterSha256: collateral,
    },
    runtimeEvidence: {
      required: false,
      observed: false,
      pollRounds: 0,
      expectedSourceSha: null,
      expectedAutomaticMaintenance: null,
      deploymentIdSha256: null,
      responseSha256s: {
        "/health": null,
        "/startup": null,
        "/ready": null,
      },
    },
    mutationBoundaryEvidence: {
      preflightReceiptSha256: sha("boundary-before"),
      postflightReceiptSha256: sha("boundary-after"),
    },
    checks: WORKER_CHECKS,
    stagingBootstrapVerification: {
      preparedReceiptExact: true,
      sufficientWithoutQuiescenceProof: false,
      nextRequiredProof: "EXACT_SCALE_1_TO_0_QUIESCENCE_PROOF",
      legacySourceRuntimeFenceClaimed: false,
    },
    productionDeploymentVerification: {
      requiredReceiptFilename:
        "automatic-maintenance-worker-fence-terminal.json",
      eligible: false,
      exactCandidateTargetOperationBindingRequired: true,
      bindingSha256Required: true,
      oldRuntimeSafetyPrerequisite: null,
      oldRuntimeSafetyVerifiedByThisOperation: false,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function activateReceipt(): string {
  const binding = {
    policySha256: POLICY_SHA,
    candidateSha: CANDIDATE,
    target: "permanent-staging",
    operation: "activate",
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
    configuredVariables: {
      PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED: "true",
      PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: CANDIDATE,
    },
    skipDeploys: false,
  };
  const deploymentBefore = sha("candidate-before-activation");
  const deploymentAfter = sha("candidate-after-activation");
  const collateral = sha("activation-collateral");
  return canonical({
    schemaVersion: "pintpath-automatic-maintenance-worker-fence-terminal/v1",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    binding,
    bindingSha256: sha(canonical(binding)),
    outcome: "activated",
    attempts: 1,
    retryAllowed: false,
    failureCode: null,
    authoritySha256: sha("activation-authority"),
    intentSha256: sha("activation-intent"),
    providerEvidence: {
      graphqlOperation: "variableCollectionUpsert",
      mutationCallCount: 1,
      acknowledgementExact: true,
      providerBeforeSha256: sha("activation-before"),
      providerAfterSha256: sha("activation-after"),
      deploymentBeforeIdSha256: deploymentBefore,
      deploymentAfterIdSha256: deploymentAfter,
      sourceBeforeSha: CANDIDATE,
      sourceAfterSha: CANDIDATE,
      sourcePreservedExact: true,
      deploymentIdChanged: true,
      topologyBeforeSha256: sha("activation-topology-before"),
      topologyAfterSha256: sha("activation-topology-after"),
      collateralVariablesBeforeSha256: collateral,
      collateralVariablesAfterSha256: collateral,
    },
    runtimeEvidence: {
      required: true,
      observed: true,
      pollRounds: 2,
      expectedSourceSha: CANDIDATE,
      expectedAutomaticMaintenance: { enabled: true, candidateBound: true },
      deploymentIdSha256: deploymentAfter,
      responseSha256s: {
        "/health": sha("activation-health"),
        "/startup": sha("activation-startup"),
        "/ready": sha("activation-ready"),
      },
    },
    mutationBoundaryEvidence: {
      preflightReceiptSha256: sha("activation-boundary-before"),
      postflightReceiptSha256: sha("activation-boundary-after"),
    },
    checks: WORKER_CHECKS,
    stagingBootstrapVerification: {
      preparedReceiptExact: false,
      sufficientWithoutQuiescenceProof: false,
      nextRequiredProof: "EXACT_SCALE_1_TO_0_QUIESCENCE_PROOF",
      legacySourceRuntimeFenceClaimed: false,
    },
    productionDeploymentVerification: {
      requiredReceiptFilename:
        "automatic-maintenance-worker-fence-terminal.json",
      eligible: false,
      exactCandidateTargetOperationBindingRequired: true,
      bindingSha256Required: true,
      oldRuntimeSafetyPrerequisite: null,
      oldRuntimeSafetyVerifiedByThisOperation: false,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function scaleReceipt(): string {
  return canonical({
    schemaVersion: "pintpath-permanent-staging-scale-operation/v2",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    direction: "quiesce-staging-zero",
    outcome: "scaled",
    candidateSha: CANDIDATE,
    startedAt: "2026-08-21T01:03:10.000Z",
    completedAt: "2026-08-21T01:03:50.000Z",
    desiredReplicas: 0,
    deploymentIdSha256: sha("legacy-deployment"),
    attempts: 1,
    retryAllowed: false,
    intentSha256: sha("scale-intent"),
    terminalEvidenceSha256: sha("scale-terminal"),
    commandStdoutSha256: sha("scale-stdout"),
    commandStderrSha256: sha("scale-stderr"),
    checks: SCALE_CHECKS,
  });
}

function fencedDeploymentReceipt(): string {
  const collateral = sha("deployment-collateral");
  return canonical({
    schemaVersion: "pintpath-railway-application-deployment-executor/v5",
    operation: "pintpath-railway-application-source-upload",
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    target: "permanent-staging",
    outcome: "deployed",
    failureCode: null,
    candidateSha: CANDIDATE,
    startedAt: "2026-08-21T01:05:10.000Z",
    completedAt: "2026-08-21T01:05:50.000Z",
    writeAttempts: 1,
    acknowledgement: "received",
    previousDeploymentIdSha256: sha("legacy-deployment"),
    deploymentIdSha256: sha("candidate-deployment"),
    intentSha256: sha("deployment-intent"),
    cliOutputSha256: sha("deployment-cli"),
    boundaryPreflightSha256: sha("deployment-boundary-before"),
    boundaryPostflightSha256: sha("deployment-boundary-after"),
    collateralSnapshotSha256s: { before: collateral, after: collateral },
    replicaCounts: { before: 0, after: 0 },
    runtimeResponseSha256s: { health: null, startup: null, ready: null },
    checks: DEPLOYMENT_CHECKS,
  });
}

function activeDeploymentReceipt(): string {
  const value = JSON.parse(fencedDeploymentReceipt());
  value.startedAt = "2026-08-21T01:11:10.000Z";
  value.completedAt = "2026-08-21T01:11:50.000Z";
  value.replicaCounts = { before: 1, after: 1 };
  value.runtimeResponseSha256s = {
    health: sha("active-health"),
    startup: sha("active-startup"),
    ready: sha("active-ready"),
  };
  return canonical(value);
}

function priorQuiesceVerification(): string {
  return canonical({
    schemaVersion: "pintpath-permanent-staging-worker-bootstrap-prerequisites/v1",
    policySha256: STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256,
    operation: "quiesce",
    candidateSha: CANDIDATE,
    expectedDeploymentSha: OLD_SOURCE,
    repository: "blackmagic30/Beer",
    reviewedPullRequest: {},
    consumer: {
      workflowPath:
        ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
      githubEnvironment: "permanent-staging-scale-evidence",
      runId: QUIESCE_RUN,
      runAttempt: 1,
      startedAt: "2026-08-21T01:03:00.000Z",
    },
    prerequisites: [{
      kind: "prepare",
      workflowPath:
        ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
      runId: PREPARE_RUN,
      runAttempt: 1,
      artifactDigest: `sha256:${sha("prepare-archive")}`,
      receipt: {
        candidateSha: CANDIDATE,
        sha256: sha(prepareReceipt()),
      },
    }],
    verifiedAt: "2026-08-21T01:03:05.000Z",
    expiresAt: "2026-08-21T01:18:05.000Z",
    checks: VERIFICATION_CHECKS,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

interface RunInput {
  readonly id: string;
  readonly workflow: string;
  readonly name: string;
  readonly title: string;
  readonly created: string;
  readonly started: string;
  readonly completed: string;
  readonly current?: boolean;
}

function githubRun(input: RunInput): Record<string, unknown> {
  return {
    id: Number(input.id),
    repository: { full_name: "blackmagic30/Beer" },
    head_repository: { full_name: "blackmagic30/Beer" },
    name: input.name,
    path: input.workflow,
    display_title: input.title,
    event: "workflow_dispatch",
    head_sha: CANDIDATE,
    head_branch: "main",
    run_attempt: 1,
    status: input.current ? "in_progress" : "completed",
    conclusion: input.current ? null : "success",
    created_at: input.created,
    run_started_at: input.started,
    updated_at: input.completed,
  };
}

function artifact(name: string, runId: string, id: string) {
  return {
    id: Number(id),
    name,
    expired: false,
    digest: `sha256:${sha(`${name}-archive`)}`,
    size_in_bytes: 2048,
    archive_download_url:
      `https://api.github.com/repos/blackmagic30/Beer/actions/artifacts/${id}/zip`,
    workflow_run: { id: Number(runId), head_sha: CANDIDATE },
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function harness(operation: "quiesce" | "restore", options: {
  readonly laterPrepare?: boolean;
  readonly artifactDigestInvalid?: boolean;
} = {}) {
  const bootstrapWorkflow =
    ".github/workflows/bootstrap-permanent-staging-worker-fence.yml";
  const workerWorkflow =
    ".github/workflows/configure-automatic-maintenance-worker-fence.yml";
  const deploymentWorkflow = ".github/workflows/deploy-permanent-staging.yml";
  const prepare = githubRun({
    id: PREPARE_RUN,
    workflow: workerWorkflow,
    name: "Configure candidate-bound automatic-maintenance worker fence",
    title:
      `Automatic maintenance worker fence | permanent-staging | prepare | ${CANDIDATE}`,
    created: "2026-08-21T01:00:00.000Z",
    started: "2026-08-21T01:01:00.000Z",
    completed: "2026-08-21T01:02:00.000Z",
  });
  const quiesce = githubRun({
    id: QUIESCE_RUN,
    workflow: bootstrapWorkflow,
    name: "Bootstrap permanent-staging automatic-maintenance worker fence",
    title: `Permanent staging worker bootstrap | quiesce | ${CANDIDATE}`,
    created: "2026-08-21T01:02:30.000Z",
    started: "2026-08-21T01:03:00.000Z",
    completed: "2026-08-21T01:04:00.000Z",
  });
  const fencedDeployment = githubRun({
    id: FENCED_DEPLOYMENT_RUN,
    workflow: deploymentWorkflow,
    name: "Deploy Pint Path permanent staging",
    title: `Deploy permanent staging | fenced | ${CANDIDATE}`,
    created: "2026-08-21T01:04:30.000Z",
    started: "2026-08-21T01:05:00.000Z",
    completed: "2026-08-21T01:06:00.000Z",
  });
  const current = githubRun({
    id: CURRENT_RUN,
    workflow: bootstrapWorkflow,
    name: "Bootstrap permanent-staging automatic-maintenance worker fence",
    title: `Permanent staging worker bootstrap | ${operation} | ${CANDIDATE}`,
    created: operation === "quiesce"
      ? "2026-08-21T01:02:30.000Z"
      : "2026-08-21T01:06:30.000Z",
    started: operation === "quiesce"
      ? "2026-08-21T01:03:00.000Z"
      : "2026-08-21T01:07:00.000Z",
    completed: operation === "quiesce"
      ? "2026-08-21T01:03:00.000Z"
      : "2026-08-21T01:07:00.000Z",
    current: true,
  });
  const prepareArtifactName =
    `pintpath-automatic-maintenance-worker-fence-permanent-staging-prepare-${CANDIDATE}`;
  const quiesceArtifactName =
    `pintpath-permanent-staging-worker-bootstrap-quiesce-${CANDIDATE}`;
  const fencedArtifactName =
    `pintpath-permanent-staging-fenced-deployment-${CANDIDATE}`;
  const laterPrepare = {
    ...prepare,
    id: 1001,
    created_at: "2026-08-21T01:02:10.000Z",
    run_started_at: "2026-08-21T01:02:15.000Z",
    updated_at: "2026-08-21T01:02:20.000Z",
  };
  const fetchImpl = vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (!url.startsWith("https://api.github.com/repos/blackmagic30/Beer/")) {
      throw new Error("provider_contact_forbidden");
    }
    if (url.endsWith(`/actions/runs/${CURRENT_RUN}`)) return json(current);
    if (url.endsWith(`/actions/runs/${PREPARE_RUN}`)) return json(prepare);
    if (url.endsWith(`/actions/runs/${QUIESCE_RUN}`)) return json(quiesce);
    if (url.endsWith(`/actions/runs/${FENCED_DEPLOYMENT_RUN}`)) {
      return json(fencedDeployment);
    }
    if (url.endsWith("/git/ref/heads/main")) {
      return json({ ref: "refs/heads/main", object: { type: "commit", sha: CANDIDATE } });
    }
    if (url.includes(`/commits/${CANDIDATE}/pulls?`)) {
      return json([{
        number: 51,
        state: "closed",
        merge_commit_sha: CANDIDATE,
        base: { ref: "main", repo: { full_name: "blackmagic30/Beer" } },
        head: { repo: { full_name: "blackmagic30/Beer" } },
      }]);
    }
    if (url.endsWith("/pulls/51")) {
      return json({
        number: 51,
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
        merged_at: "2026-08-20T23:00:00.000Z",
      });
    }
    if (url.endsWith(`/git/commits/${CANDIDATE}`)) {
      return json({
        sha: CANDIDATE,
        tree: { sha: TREE },
        parents: [{ sha: "e".repeat(40) }],
      });
    }
    if (url.endsWith(`/git/commits/${REVIEWED_HEAD}`)) {
      return json({ sha: REVIEWED_HEAD, tree: { sha: TREE }, parents: [] });
    }
    if (url.includes(`/actions/runs/${PREPARE_RUN}/artifacts?`)) {
      const value = artifact(prepareArtifactName, PREPARE_RUN, "7001");
      if (options.artifactDigestInvalid) value.digest = "sha256:not-a-digest";
      return json({ total_count: 1, artifacts: [value] });
    }
    if (url.includes(`/actions/runs/${QUIESCE_RUN}/artifacts?`)) {
      return json({
        total_count: 1,
        artifacts: [artifact(quiesceArtifactName, QUIESCE_RUN, "7002")],
      });
    }
    if (url.includes(`/actions/runs/${FENCED_DEPLOYMENT_RUN}/artifacts?`)) {
      return json({
        total_count: 1,
        artifacts: [artifact(fencedArtifactName, FENCED_DEPLOYMENT_RUN, "7003")],
      });
    }
    if (url.includes("/actions/workflows/configure-automatic-maintenance-worker-fence.yml/runs?")) {
      const runs = options.laterPrepare ? [prepare, laterPrepare] : [prepare];
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    if (url.includes("/actions/workflows/bootstrap-permanent-staging-worker-fence.yml/runs?")) {
      return json({ total_count: 1, workflow_runs: [quiesce] });
    }
    if (url.includes("/actions/workflows/deploy-permanent-staging.yml/runs?")) {
      return json({ total_count: 1, workflow_runs: [fencedDeployment] });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const files = new Map<string, string>([
    [PREPARE_FILE, prepareReceipt()],
    [QUIESCE_FILE, scaleReceipt()],
    [QUIESCE_VERIFICATION_FILE, priorQuiesceVerification()],
    [FENCED_DEPLOYMENT_FILE, fencedDeploymentReceipt()],
  ]);
  const argv = [
    "--operation", operation,
    "--candidate-sha", CANDIDATE,
    "--expected-deployment-sha", operation === "quiesce" ? OLD_SOURCE : CANDIDATE,
    "--prepare-run-id", PREPARE_RUN,
    "--prepare-terminal-file", PREPARE_FILE,
    "--output", OUTPUT_FILE,
  ];
  if (operation === "restore") {
    argv.push(
      "--quiesce-run-id", QUIESCE_RUN,
      "--quiesce-receipt-file", QUIESCE_FILE,
      "--quiesce-verification-file", QUIESCE_VERIFICATION_FILE,
      "--fenced-deployment-run-id", FENCED_DEPLOYMENT_RUN,
      "--fenced-deployment-receipt-file", FENCED_DEPLOYMENT_FILE,
    );
  }
  const output: string[] = [];
  const written = new Map<string, string>();
  return {
    argv,
    env: {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "blackmagic30/Beer",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: CANDIDATE,
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: CURRENT_RUN,
      GITHUB_WORKFLOW_REF:
        `blackmagic30/Beer/${bootstrapWorkflow}@refs/heads/main`,
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_TOKEN: "github-token-long-enough",
      PINTPATH_STAGING_WORKER_BOOTSTRAP_OPERATION: operation,
      PINTPATH_STAGING_WORKER_BOOTSTRAP_GITHUB_ENVIRONMENT:
        "permanent-staging-scale-evidence",
    },
    fetchImpl,
    readPrivateFile: (filename: string) => Buffer.from(files.get(filename) ?? ""),
    writeEvidence: (filename: string, source: string) => written.set(filename, source),
    writeOutput: (source: string) => output.push(source),
    now: () => new Date(operation === "quiesce"
      ? "2026-08-21T01:03:30.000Z"
      : "2026-08-21T01:07:30.000Z"),
    output,
    written,
  };
}

describe("permanent-staging worker bootstrap prerequisites", () => {
  it("pins the policy and every producer policy digest", () => {
    const source = fs.readFileSync(
      "ops/railway/permanent-staging-worker-bootstrap-prerequisites-policy.json",
    );
    expect(sha(source.toString())).toBe(
      STAGING_WORKER_BOOTSTRAP_PREREQUISITES_POLICY_SHA256,
    );
    expect(stagingWorkerBootstrapPrerequisiteInternals.validatePolicies(
      process.cwd(),
    )).toBeUndefined();
  });

  it("verifies prepare before authorizing the exact old-source quiescence", async () => {
    const fixture = harness("quiesce");
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(0);
    const receipt = JSON.parse(fixture.written.get(OUTPUT_FILE)!);
    expect(receipt).toMatchObject({
      operation: "quiesce",
      candidateSha: CANDIDATE,
      expectedDeploymentSha: OLD_SOURCE,
      reviewedPullRequest: {
        number: 51,
        mergeCommitSha: CANDIDATE,
        treeSha: TREE,
      },
      prerequisites: [{
        kind: "prepare",
        runId: PREPARE_RUN,
        artifactName:
          `pintpath-automatic-maintenance-worker-fence-permanent-staging-prepare-${CANDIDATE}`,
        artifactDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        receipt: { sourceSha: OLD_SOURCE, outcome: "prepared" },
      }],
      checks: VERIFICATION_CHECKS,
      secretMaterialIncluded: false,
    });
    expect(fixture.fetchImpl.mock.calls.every(([request]) =>
      String(request).startsWith("https://api.github.com/"))).toBe(true);
  });

  it("verifies prepare, quiescence, and fenced zero-replica deployment before restore", async () => {
    const fixture = harness("restore");
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(0);
    const receipt = JSON.parse(fixture.written.get(OUTPUT_FILE)!);
    expect(receipt.expectedDeploymentSha).toBe(CANDIDATE);
    expect(receipt.prerequisites.map((item: { kind: string }) => item.kind))
      .toEqual(["prepare", "quiesce", "fenced-deployment"]);
    expect(receipt.prerequisites[1]).toMatchObject({
      receipt: {
        outcome: "scaled",
        sourceSha: OLD_SOURCE,
        replicasBefore: 1,
        replicasAfter: 0,
      },
      prerequisiteVerificationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(receipt.prerequisites[2]).toMatchObject({
      receipt: {
        sourceSha: CANDIDATE,
        replicasBefore: 0,
        replicasAfter: 0,
      },
    });
  });

  it("rejects an invalid GitHub artifact digest before any provider contact", async () => {
    const fixture = harness("quiesce", { artifactDigestInvalid: true });
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(1);
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "artifact_authority_invalid",
      productionContactAttempted: false,
    });
    expect(fixture.written.size).toBe(0);
  });

  it("rejects a later same-candidate prepare run in the consumer window", async () => {
    const fixture = harness("quiesce", { laterPrepare: true });
    const code = await runStagingWorkerBootstrapPrerequisiteVerifier(fixture);

    expect(code).toBe(1);
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      failureCode: "history_invalid",
      productionContactAttempted: false,
    });
  });

  it("validates the activation and active-closeout receipts used by later modes", () => {
    const activationSource = activateReceipt();
    expect(stagingWorkerBootstrapPrerequisiteInternals.validateWorkerReceipt(
      activationSource,
      JSON.parse(activationSource),
      CANDIDATE,
      "activate",
    )).toMatchObject({
      outcome: "activated",
      sourceSha: CANDIDATE,
      replicasAfter: 1,
    });
    const deploymentSource = activeDeploymentReceipt();
    expect(stagingWorkerBootstrapPrerequisiteInternals.validateDeploymentReceipt(
      deploymentSource,
      JSON.parse(deploymentSource),
      CANDIDATE,
      "active-deployment",
    )).toMatchObject({
      sourceSha: CANDIDATE,
      replicasBefore: 1,
      replicasAfter: 1,
    });
  });

  it("requires the complete ordered chain for activate mode arguments", () => {
    const parsed = stagingWorkerBootstrapPrerequisiteInternals.parseArguments([
      "--operation", "activate",
      "--candidate-sha", CANDIDATE,
      "--prepare-run-id", PREPARE_RUN,
      "--prepare-terminal-file", PREPARE_FILE,
      "--quiesce-run-id", QUIESCE_RUN,
      "--quiesce-receipt-file", QUIESCE_FILE,
      "--quiesce-verification-file", QUIESCE_VERIFICATION_FILE,
      "--fenced-deployment-run-id", FENCED_DEPLOYMENT_RUN,
      "--fenced-deployment-receipt-file", FENCED_DEPLOYMENT_FILE,
      "--restore-run-id", "4000",
      "--restore-receipt-file",
      "/private/restore/bootstrap-staging-one-receipt.json",
      "--restore-verification-file",
      "/private/restore/prerequisites-verification.json",
      "--output", OUTPUT_FILE,
    ]);
    expect([...parsed.inputs.keys()]).toEqual([
      "prepare",
      "quiesce",
      "fenced-deployment",
      "restore",
    ]);
    expect(() => stagingWorkerBootstrapPrerequisiteInternals.parseArguments([
      "--operation", "activate",
      "--candidate-sha", CANDIDATE,
      "--output", OUTPUT_FILE,
    ])).toThrow("arguments_invalid");
  });

  it("locks the manual workflow to one serialized direct scale mutation", () => {
    const source = fs.readFileSync(
      ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
      "utf8",
    );
    expect(source).toContain("group: pintpath-permanent-staging-key-rollout");
    expect(source).toContain("queue: max");
    expect(source).toContain("cancel-in-progress: false");
    expect(source).toContain("environment: permanent-staging-scale-evidence");
    expect(source).toContain("run-name: Permanent staging worker bootstrap | ${{ inputs.operation }} | ${{ inputs.candidate_sha }}");
    expect(source).toContain("--direction \"$direction\"");
    expect(source).toContain("--expected-deployment-sha \"$EXPECTED_DEPLOYMENT_SHA\"");
    expect(source).toContain("QUIESCE_PERMANENT_STAGING_TO_ZERO_FOR_WORKER_BOOTSTRAP");
    expect(source).toContain("RESTORE_PERMANENT_STAGING_TO_ONE_FOR_WORKER_BOOTSTRAP");
    expect(source).not.toMatch(/gh workflow run|\/dispatches|workflow_dispatch[^:]/);
  });

  it("binds fenced deployment, active closeout, and scale evidence to prior artifacts", () => {
    const deployment = fs.readFileSync(
      ".github/workflows/deploy-permanent-staging.yml",
      "utf8",
    );
    const scale = fs.readFileSync(
      ".github/workflows/permanent-staging-scale-evidence.yml",
      "utf8",
    );

    expect(deployment).toContain(
      "run-name: Deploy permanent staging | ${{ inputs.phase }} | ${{ inputs.candidate_sha }}",
    );
    expect(deployment).toContain("--operation fenced-deploy");
    expect(deployment).toContain("--operation active-deploy");
    expect(deployment).toContain(
      "pintpath-permanent-staging-fenced-deployment-${{ inputs.candidate_sha }}",
    );
    expect(deployment).toContain(
      "ops/railway/permanent-staging-fenced-app-deployment-policy.json",
    );
    expect(deployment).toContain(
      "DEPLOY_PERMANENT_STAGING_FENCED_AT_ZERO_FOR_${CANDIDATE_SHA}",
    );
    expect(deployment).toContain(
      "DEPLOY_PERMANENT_STAGING_ACTIVE_AT_ONE_FOR_${CANDIDATE_SHA}",
    );
    expect(deployment.indexOf(
      "Verify exact staging deployment prerequisite provenance and chronology",
    )).toBeLessThan(deployment.indexOf(
      "PINTPATH_RAILWAY_WRITE_TOKEN: ${{ secrets.PINTPATH_RAILWAY_STAGING_DEPLOY_TOKEN }}",
    ));

    expect(scale).toContain("group: pintpath-permanent-staging-key-rollout");
    expect(scale).toContain("queue: max");
    expect(scale).toContain("actions: read");
    expect(scale).toContain("pull-requests: read");
    expect(scale).toContain("--operation scale-evidence");
    expect(scale).toContain("--activate-run-id \"$ACTIVATION_RUN_ID\"");
    expect(scale).toContain(
      "--active-deployment-run-id \"$ACTIVE_DEPLOYMENT_RUN_ID\"",
    );
    expect(scale.indexOf(
      "Seal and verify the exact active staging prerequisites",
    )).toBeLessThan(scale.indexOf(
      "PINTPATH_RAILWAY_STAGING_SCALE_TOKEN: ${{ secrets.PINTPATH_RAILWAY_STAGING_SCALE_TOKEN }}",
    ));
  });
});
