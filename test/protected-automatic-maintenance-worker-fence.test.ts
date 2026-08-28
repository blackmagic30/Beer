import crypto from "node:crypto";
import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AUTOMATIC_MAINTENANCE_WORKER_FENCE_MUTATION,
  AUTOMATIC_MAINTENANCE_WORKER_FENCE_POLICY_SHA256,
  automaticMaintenanceWorkerFenceInternals,
  runProtectedAutomaticMaintenanceWorkerFence,
} from "../scripts/execute-protected-automatic-maintenance-worker-fence.js";
import type { ProductionActivationRoleLimitPrerequisiteVerification } from
  "../scripts/verify-production-maintenance-role-limit-prerequisites.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";

const IDS = Object.freeze({
  project: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  production: "13dab015-df74-45c6-b26f-69323daea99a",
  staging: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  service: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  instance: "11111111-1111-4111-8111-111111111111",
  deployment: "22222222-2222-4222-8222-222222222222",
  snapshot: "33333333-3333-4333-8333-333333333333",
  nextDeployment: "44444444-4444-4444-8444-444444444444",
  nextSnapshot: "55555555-5555-4555-8555-555555555555",
} as const);
const CANDIDATE = "a".repeat(40);
const LEGACY_SHA = "9".repeat(40);
const REVIEWED_HEAD = "b".repeat(40);
const TREE = "c".repeat(40);
const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const EVIDENCE_DIRECTORY = "/tmp/pintpath-worker-fence-evidence";
const AUTHORITY_FILE = `${EVIDENCE_DIRECTORY}/authority.json`;
const METADATA_TOKEN = "production-metadata-token-fixture";
const STAGING_TOKEN = "staging-metadata-token-fixture";
const WRITE_TOKEN = "production-variable-write-token-fixture";
const STAGING_WRITE_TOKEN = "staging-variable-write-token-fixture";
const ROLE_LIMIT_RUN_ID = "223456789";

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const ACTIVATION_PREREQUISITE_SOURCE = canonical({
  fixture: "production-activate",
});

function confirmation(operation: "fence" | "activate"): string {
  return `${operation.toUpperCase()}_AUTOMATIC_MAINTENANCE_IN_PRODUCTION_FOR_${CANDIDATE}`;
}

function environment(operation: "fence" | "activate") {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "blackmagic30/Beer",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "123456789",
    GITHUB_SHA: CANDIDATE,
    PINTPATH_AUTOMATIC_MAINTENANCE_CONFIRMATION: confirmation(operation),
    ...(operation === "activate"
      ? { PINTPATH_PRODUCTION_ACTIVATE_ROLE_LIMIT_RUN_ID: ROLE_LIMIT_RUN_ID }
      : {}),
    PINTPATH_PROTECTED_ENVIRONMENT: "production-runtime-configuration",
    PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: METADATA_TOKEN,
    PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: STAGING_TOKEN,
    PINTPATH_RAILWAY_TARGET_METADATA_TOKEN: METADATA_TOKEN,
    PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN: WRITE_TOKEN,
  };
}

function parsedActivationPrerequisite(
  deploymentId = IDS.deployment,
): ProductionActivationRoleLimitPrerequisiteVerification {
  return {
    rolePrerequisites: {
      productionDeployment: {
        deploymentIdSha256: railwayDeploymentIdentityIdSha256(
          "deployment",
          deploymentId,
        ),
      },
    },
  } as unknown as ProductionActivationRoleLimitPrerequisiteVerification;
}

function authority(operation: "fence" | "activate"): string {
  return canonical({
    schemaVersion: "pintpath-automatic-maintenance-worker-fence-authority/v1",
    repository: "blackmagic30/Beer",
    branch: "main",
    workflowPath:
      ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
    workflowDisplayTitle:
      `Automatic maintenance worker fence | production | ${operation} | ${CANDIDATE}`,
    runId: "123456789",
    runAttempt: 1,
    runCreatedAt: "2026-08-21T00:00:00.000Z",
    runStartedAt: "2026-08-21T00:00:01.000Z",
    candidateSha: CANDIDATE,
    target: "production",
    operation,
    projectId: IDS.project,
    environmentId: IDS.production,
    serviceId: IDS.service,
    reviewedPullRequest: {
      number: 99,
      reviewedHeadSha: REVIEWED_HEAD,
      mergeCommitSha: CANDIDATE,
      treeSha: TREE,
      mergedAt: "2026-08-20T23:59:00.000Z",
      authorId: 100,
      mergedById: 101,
    },
    checks: {
      exactCurrentMain: true,
      reviewedTreeExact: true,
      originalManualRunExact: true,
      noPriorMatchingRun: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function stagingPrepareEnvironment() {
  return {
    ...environment("fence"),
    PINTPATH_AUTOMATIC_MAINTENANCE_CONFIRMATION:
      `PREPARE_AUTOMATIC_MAINTENANCE_IN_PERMANENT_STAGING_FOR_${CANDIDATE}`,
    PINTPATH_PROTECTED_ENVIRONMENT: "permanent-staging-provider-mutation",
    PINTPATH_RAILWAY_TARGET_METADATA_TOKEN: STAGING_TOKEN,
    PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN: STAGING_WRITE_TOKEN,
  };
}

function stagingPrepareAuthority(): string {
  const value = JSON.parse(authority("fence"));
  value.workflowDisplayTitle =
    `Automatic maintenance worker fence | permanent-staging | prepare | ${CANDIDATE}`;
  value.target = "permanent-staging";
  value.operation = "prepare";
  value.environmentId = IDS.staging;
  return canonical(value);
}

function forStaging<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll(IDS.production, IDS.staging)
      .replaceAll("pintpath.au", "beer-staging.up.railway.app"),
  ) as T;
}

function row(name: string, id: string) {
  return {
    node: {
      id,
      name,
      environmentId: IDS.production,
      serviceId: IDS.service,
      isSealed: false,
      references: [],
    },
  };
}

function metadataSource(input: {
  readonly activeDeployments?: readonly Record<string, unknown>[];
  readonly deploymentStopped?: boolean;
  readonly deploymentId?: string;
  readonly domain?: string;
  readonly numReplicas?: number;
  readonly snapshotId?: string;
  readonly rows?: readonly ReturnType<typeof row>[];
  readonly status?: string;
  readonly targetPort?: number | null;
}) {
  const deploymentId = input.deploymentId ?? IDS.deployment;
  const snapshotId = input.snapshotId ?? IDS.snapshot;
  const status = input.status ?? "SUCCESS";
  return {
    data: {
      environment: {
        id: IDS.production,
        variables: {
          edges: input.rows ?? [row("UNRELATED_FIXTURE", "variable-unrelated")],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
      staged: { environmentId: IDS.production, patch: {} },
      serviceInstance: {
        id: IDS.instance,
        serviceId: IDS.service,
        environmentId: IDS.production,
        numReplicas: input.numReplicas ?? 1,
        latestDeployment: {
          id: deploymentId,
          status,
          deploymentStopped: input.deploymentStopped ?? false,
          snapshotId,
        },
        activeDeployments: input.activeDeployments ?? [{
          id: deploymentId,
          status,
          deploymentStopped: input.deploymentStopped ?? false,
        }],
        domains: {
          serviceDomains: [{
            id: "66666666-6666-4666-8666-666666666666",
            domain: input.domain ?? "pintpath.au",
            targetPort: input.targetPort === undefined ? 3_000 : input.targetPort,
          }],
          customDomains: [],
        },
      },
    },
  };
}

function deploymentSource(input: {
  readonly candidateSha?: string;
  readonly deploymentId?: string;
  readonly patchId?: string | null;
  readonly snapshotId?: string;
}) {
  return {
    data: {
      deployment: {
        id: input.deploymentId ?? IDS.deployment,
        projectId: IDS.project,
        environmentId: IDS.production,
        serviceId: IDS.service,
        snapshotId: input.snapshotId ?? IDS.snapshot,
        meta: {
          commitHash: input.candidateSha ?? CANDIDATE,
          imageDigest: IMAGE_DIGEST,
          patchId: input.patchId ?? null,
        },
      },
    },
  };
}

function providerRows() {
  return [
    row("UNRELATED_FIXTURE", "variable-unrelated"),
    row("GOOGLE_MAPS_API_KEY", "variable-google-maps-api-key"),
    row("GOOGLE_MAPS_MAP_ID", "variable-google-maps-map-id"),
    row("GOOGLE_PLACES_API_KEY", "variable-google-places-api-key"),
    row("OPENAI_API_KEY", "variable-openai-api-key"),
  ];
}

function targetRows() {
  return [
    row("UNRELATED_FIXTURE", "variable-unrelated"),
    row("PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED", "variable-enabled"),
    row(
      "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
      "variable-candidate",
    ),
  ];
}

function stagingTargetRows() {
  return [
    ...providerRows(),
    row("PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED", "variable-enabled"),
    row(
      "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
      "variable-candidate",
    ),
  ];
}

function scopeSource() {
  return {
    data: {
      projectToken: { projectId: IDS.project, environmentId: IDS.production },
    },
  };
}

function runtimeSource(
  route: "/health" | "/startup" | "/ready",
  input: {
    readonly deploymentId?: string;
    readonly sourceSha?: string;
    readonly enabled?: boolean;
    readonly candidateBound?: boolean;
    readonly environmentId?: string;
  } = {},
) {
  const deploymentId = input.deploymentId ?? IDS.nextDeployment;
  const sourceSha = input.sourceSha ?? CANDIDATE;
  const enabled = input.enabled ?? true;
  const candidateBound = input.candidateBound ?? true;
  const environmentId = input.environmentId ?? IDS.production;
  const status = route === "/health"
    ? "ok"
    : route === "/startup"
      ? "startup_ready"
      : "ready";
  return {
    ok: true,
    data: {
      service: "pint-path",
      status,
      deployment: {
        version: "0.1.0",
        commitSha: sourceSha,
        environment: "production",
        projectIdSha256: railwayDeploymentIdentityIdSha256(
          "project",
          IDS.project,
        ),
        environmentIdSha256: railwayDeploymentIdentityIdSha256(
          "environment",
          environmentId,
        ),
        serviceIdSha256: railwayDeploymentIdentityIdSha256(
          "service",
          IDS.service,
        ),
        deploymentIdSha256: railwayDeploymentIdentityIdSha256(
          "deployment",
          deploymentId,
        ),
        replicaIdSha256: "e".repeat(64),
      },
      automaticMaintenance: { enabled, candidateBound },
      ...(route === "/health" ? {} : { dependencies: {} }),
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mutationArguments(operation: "fence" | "activate") {
  return [
    "--mode",
    "mutate",
    "--target",
    "production",
    "--operation",
    operation,
    "--candidate-sha",
    CANDIDATE,
    "--evidence-dir",
    EVIDENCE_DIRECTORY,
    "--authority-file",
    AUTHORITY_FILE,
  ];
}

function prepareArguments(target = "permanent-staging") {
  return [
    "--mode",
    "mutate",
    "--target",
    target,
    "--operation",
    "prepare",
    "--candidate-sha",
    CANDIDATE,
    "--evidence-dir",
    EVIDENCE_DIRECTORY,
    "--authority-file",
    AUTHORITY_FILE,
  ];
}

function authorityArguments() {
  return [
    "--mode",
    "authority",
    "--target",
    "production",
    "--operation",
    "fence",
    "--candidate-sha",
    CANDIDATE,
    "--evidence-dir",
    EVIDENCE_DIRECTORY,
  ];
}

function workflowRun() {
  return {
    id: 123456789,
    repository: { full_name: "blackmagic30/Beer" },
    head_repository: { full_name: "blackmagic30/Beer" },
    head_sha: CANDIDATE,
    head_branch: "main",
    path: ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
    event: "workflow_dispatch",
    display_title:
      `Automatic maintenance worker fence | production | fence | ${CANDIDATE}`,
    run_attempt: 1,
    status: "in_progress",
    conclusion: null,
    created_at: "2026-08-21T00:00:00.000Z",
    run_started_at: "2026-08-21T00:00:01.000Z",
  };
}

describe("candidate-bound automatic-maintenance worker fence", () => {
  it("locks the exact policy, targets, pair, and mutation boundary", () => {
    const source = fs.readFileSync(
      "ops/railway/protected-automatic-maintenance-worker-fence-policy.json",
    );
    expect(sha256(source)).toBe(
      AUTOMATIC_MAINTENANCE_WORKER_FENCE_POLICY_SHA256,
    );
    expect(automaticMaintenanceWorkerFenceInternals.policyExact(process.cwd()))
      .toBe(true);
    const policy = JSON.parse(source.toString("utf8"));
    expect(policy.projectId).toBe(IDS.project);
    expect(policy.serviceId).toBe(IDS.service);
    expect(policy.targets["permanent-staging"].environmentId).toBe(IDS.staging);
    expect(policy.targets.production.environmentId).toBe(IDS.production);
    expect(policy.variables).toEqual([
      "PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED",
      "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
    ]);
    expect(policy.operations.fence).toMatchObject({
      enabledValue: "false",
      skipDeploys: true,
    });
    expect(policy.operations.prepare).toMatchObject({
      allowedTargets: ["permanent-staging"],
      enabledValue: "false",
      skipDeploys: true,
      deploymentMustRemainUnchanged: true,
      runtimeProofRequired: false,
      legacySourceRuntimeFenceClaimAllowed: false,
      nextRequiredProof: "EXACT_SCALE_1_TO_0_QUIESCENCE_PROOF",
    });
    expect(policy.operations.activate).toMatchObject({
      enabledValue: "true",
      skipDeploys: false,
    });
    expect(policy.activationPrerequisites).toMatchObject({
      permanentStaging: {
        verificationOperation: "activate",
        requiredRunInputs: [
          "prepare_run_id",
          "quiesce_run_id",
          "fenced_deployment_run_id",
          "restore_run_id",
        ],
        productionRoleLimitRunInputAllowed: false,
        verifiedBeforeProviderTokenCustody: true,
      },
      production: {
        verificationMode: "production-activate",
        requiredRunInput: "role_limit_run_id",
        requiredArtifactRootFiles: [
          "intent.json",
          "terminal.json",
          "receipt.json",
          "prerequisites-verification.json",
        ],
        stagingRunInputsAllowed: false,
        executorMustBindVerificationSha256: true,
        executorMustBindRoleLimitRunId: true,
        liveDeploymentMustMatchRolePrerequisiteDeployment: true,
        runtimeAutomaticMaintenanceEnabledBeforeWrite: false,
        runtimeAutomaticMaintenanceCandidateBoundBeforeWrite: true,
      },
      nonActivationPrerequisiteRunInputsAllowed: false,
    });
    expect(policy.mutation).toMatchObject({
      operationName: "variableCollectionUpsert",
      exactlyTwoVariables: true,
      atomicSingleCallRequired: true,
      maximumAttempts: 1,
      automaticRetriesAllowed: false,
      rerunsAllowed: false,
      unconditionalReadOnlyReconciliationRequired: true,
      otherProviderChangesAllowed: false,
    });
  });

  it("materializes reviewed current-main authority with no prior matching run", async () => {
    const writes = new Map<string, string>();
    let output = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      const resource = new URL(String(input)).pathname + new URL(String(input)).search;
      if (resource.endsWith(`/git/ref/heads/main`)) {
        return jsonResponse({
          ref: "refs/heads/main",
          object: { type: "commit", sha: CANDIDATE },
        });
      }
      if (resource.includes(`/commits/${CANDIDATE}/pulls`)) {
        return jsonResponse([{
          number: 99,
          state: "closed",
          merge_commit_sha: CANDIDATE,
          base: { ref: "main", repo: { full_name: "blackmagic30/Beer" } },
          head: { repo: { full_name: "blackmagic30/Beer" } },
        }]);
      }
      if (resource.endsWith("/pulls/99")) {
        return jsonResponse({
          number: 99,
          state: "closed",
          merged: true,
          draft: false,
          merge_commit_sha: CANDIDATE,
          base: { ref: "main", repo: { full_name: "blackmagic30/Beer" } },
          head: {
            sha: REVIEWED_HEAD,
            repo: { full_name: "blackmagic30/Beer" },
          },
          user: { id: 100 },
          merged_by: { id: 101 },
          merged_at: "2026-08-20T23:59:00.000Z",
        });
      }
      if (resource.endsWith(`/git/commits/${CANDIDATE}`)) {
        return jsonResponse({
          sha: CANDIDATE,
          tree: { sha: TREE },
          parents: [{ sha: "f".repeat(40) }],
        });
      }
      if (resource.endsWith(`/git/commits/${REVIEWED_HEAD}`)) {
        return jsonResponse({
          sha: REVIEWED_HEAD,
          tree: { sha: TREE },
          parents: [{ sha: "1".repeat(40) }],
        });
      }
      if (resource.endsWith("/actions/runs/123456789")) {
        return jsonResponse(workflowRun());
      }
      if (resource.includes("/actions/workflows/")) {
        return jsonResponse({ total_count: 1, workflow_runs: [workflowRun()] });
      }
      throw new Error(`unexpected GitHub request: ${resource}`);
    }) as typeof fetch;
    const env = {
      ...environment("fence"),
      GITHUB_TOKEN: "github-authority-token-fixture",
    };

    const code = await runProtectedAutomaticMaintenanceWorkerFence({
      argv: authorityArguments(),
      env,
      cwd: process.cwd(),
      fetchImpl,
      writeDurable: (_directory, leaf, source) => {
        writes.set(leaf, source);
        return sha256(source);
      },
      writeOutput: (source) => {
        output += source;
      },
    });

    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      mode: "authority",
      outcome: "authorized",
      attempts: 0,
      failureCode: null,
      checks: { githubAuthorityExact: true },
    });
    const receipt = writes.get("authority.json");
    expect(receipt).toBeDefined();
    expect(automaticMaintenanceWorkerFenceInternals.authorityReceiptExact(
      receipt!,
      automaticMaintenanceWorkerFenceInternals.parseArguments(
        mutationArguments("fence"),
      )!,
      env,
    )).toBe(true);
    expect(receipt).not.toContain(env.GITHUB_TOKEN);
  });

  it("prepares only permanent staging without claiming the legacy source is fenced", async () => {
    expect(
      automaticMaintenanceWorkerFenceInternals.parseArguments(
        prepareArguments("production"),
      ),
    ).toBeNull();
    expect(
      automaticMaintenanceWorkerFenceInternals.parseArguments(prepareArguments()),
    ).not.toBeNull();
    expect(
      automaticMaintenanceWorkerFenceInternals.parseArguments([
        ...mutationArguments("fence").slice(0, 2),
        "--target",
        "permanent-staging",
        ...mutationArguments("fence").slice(4),
      ]),
    ).toBeNull();
    const existingSourceSha = LEGACY_SHA;
    const metadata = [
      forStaging(metadataSource({ rows: providerRows(), targetPort: 8_080 })),
      forStaging(metadataSource({ rows: providerRows(), targetPort: 8_080 })),
      forStaging(metadataSource({ rows: stagingTargetRows(), targetPort: 8_080 })),
    ];
    const deployments = [
      forStaging(deploymentSource({ candidateSha: existingSourceSha })),
      forStaging(deploymentSource({ candidateSha: existingSourceSha })),
      forStaging(deploymentSource({ candidateSha: existingSourceSha })),
    ];
    const mutationInputs: Record<string, unknown>[] = [];
    const writes = new Map<string, string>();
    let runtimeCalls = 0;
    let output = "";
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://beer-staging.up.railway.app/")) {
        runtimeCalls += 1;
        const route = new URL(url).pathname as "/health" | "/startup" | "/ready";
        return jsonResponse(runtimeSource(route, {
          deploymentId: IDS.nextDeployment,
          sourceSha: existingSourceSha,
          enabled: false,
          candidateBound: false,
          environmentId: IDS.staging,
        }));
      }
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("WorkerFenceScope")) {
        return jsonResponse(forStaging(scopeSource()));
      }
      if (body.query.includes("WorkerFenceMetadata")) {
        return jsonResponse(metadata.shift());
      }
      if (body.query.includes("WorkerFenceDeployment")) {
        return jsonResponse(deployments.shift());
      }
      if (body.query === AUTOMATIC_MAINTENANCE_WORKER_FENCE_MUTATION) {
        mutationInputs.push(body.variables);
        return jsonResponse({ data: { variableCollectionUpsert: true } });
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const code = await runProtectedAutomaticMaintenanceWorkerFence({
      argv: prepareArguments(),
      env: stagingPrepareEnvironment(),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: async () => undefined,
      boundaryCheck: async () => ({
        passed: true,
        receiptSha256: "6".repeat(64),
      }),
      reassertRepositoryState: () => true,
      readAuthority: stagingPrepareAuthority,
      writeDurable: (_directory, leaf, source) => {
        writes.set(leaf, source);
        return sha256(source);
      },
      writeOutput: (source) => {
        output += source;
      },
    });

    expect(code).toBe(0);
    expect(runtimeCalls).toBe(0);
    expect(mutationInputs).toEqual([{
      projectId: IDS.project,
      serviceId: IDS.service,
      environmentId: IDS.staging,
      variables: {
        PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED: "false",
        PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: CANDIDATE,
      },
      skipDeploys: true,
    }]);
    expect(JSON.parse(output)).toMatchObject({
      target: "permanent-staging",
      operation: "prepare",
      outcome: "prepared",
      attempts: 1,
      checks: {
        operationPreflightExact: true,
        postflightDeploymentExact: true,
        runtimeRoutesPolledExact: true,
        runtimeMaintenanceStateExact: true,
      },
    });
    const prepareTerminal = JSON.parse(
      writes.get("automatic-maintenance-worker-fence-terminal.json")!,
    );
    expect(prepareTerminal).toMatchObject({
      outcome: "prepared",
      binding: {
        target: "permanent-staging",
        operation: "prepare",
        skipDeploys: true,
      },
      providerEvidence: {
        sourceBeforeSha: existingSourceSha,
        sourceAfterSha: existingSourceSha,
        sourcePreservedExact: true,
        deploymentIdChanged: false,
      },
      stagingBootstrapVerification: {
        preparedReceiptExact: true,
        sufficientWithoutQuiescenceProof: false,
        nextRequiredProof: "EXACT_SCALE_1_TO_0_QUIESCENCE_PROOF",
        legacySourceRuntimeFenceClaimed: false,
      },
      runtimeEvidence: {
        required: false,
        observed: false,
        pollRounds: 0,
        expectedSourceSha: null,
        expectedAutomaticMaintenance: null,
      },
      productionDeploymentVerification: { eligible: false },
    });
    expect(prepareTerminal.providerEvidence.deploymentBeforeIdSha256).toBe(
      prepareTerminal.providerEvidence.deploymentAfterIdSha256,
    );
    expect(prepareTerminal.providerEvidence.topologyBeforeSha256).toBe(
      prepareTerminal.providerEvidence.topologyAfterSha256,
    );
    expect(
      prepareTerminal.providerEvidence.collateralVariablesBeforeSha256,
    ).toBe(prepareTerminal.providerEvidence.collateralVariablesAfterSha256);
  });

  it("requires an exact healthy one-replica legacy baseline before staging prepare", () => {
    const metadata = automaticMaintenanceWorkerFenceInternals.metadataPart(
      forStaging(metadataSource({ rows: providerRows(), targetPort: 8_080 })),
      IDS.staging,
    );
    expect(metadata).not.toBeNull();
    const deployment = automaticMaintenanceWorkerFenceInternals.deploymentPart(
      forStaging(deploymentSource({ candidateSha: LEGACY_SHA })),
      IDS.deployment,
    );
    expect(deployment).not.toBeNull();
    const healthy = { ...metadata!, deployment: deployment! };
    expect(automaticMaintenanceWorkerFenceInternals.soleHealthyLegacyBaseline(
      healthy,
      "permanent-staging",
      CANDIDATE,
    )).toBe(true);

    const scenarios = [
      {
        label: "failed latest deployment",
        snapshot: {
          ...healthy,
          latestDeployment: { ...healthy.latestDeployment, status: "FAILED" },
        },
      },
      {
        label: "stopped latest deployment",
        snapshot: {
          ...healthy,
          latestDeployment: { ...healthy.latestDeployment, deploymentStopped: true },
        },
      },
      { label: "multiple replicas", snapshot: { ...healthy, numReplicas: 2 } },
      {
        label: "multiple active deployments",
        snapshot: {
          ...healthy,
          activeDeployments: [
            ...healthy.activeDeployments,
            {
              id: IDS.nextDeployment,
              status: "SUCCESS",
              deploymentStopped: false,
            },
          ],
        },
      },
      {
        label: "latest and active identity mismatch",
        snapshot: {
          ...healthy,
          activeDeployments: [{
            id: IDS.nextDeployment,
            status: "SUCCESS",
            deploymentStopped: false,
          }],
        },
      },
      {
        label: "snapshot identity mismatch",
        snapshot: {
          ...healthy,
          deployment: { ...healthy.deployment, snapshotId: IDS.nextSnapshot },
        },
      },
      {
        label: "deployment patch present",
        snapshot: {
          ...healthy,
          deployment: { ...healthy.deployment, patchId: IDS.nextDeployment },
        },
      },
      {
        label: "unpinned domain",
        snapshot: {
          ...healthy,
          domains: healthy.domains.map((domain) => ({
            ...domain,
            domain: "wrong-staging.up.railway.app",
          })),
        },
      },
      {
        label: "stale staging port",
        snapshot: {
          ...healthy,
          domains: healthy.domains.map((domain) => ({ ...domain, targetPort: 3_000 })),
        },
      },
      {
        label: "missing staging target port",
        snapshot: {
          ...healthy,
          domains: healthy.domains.map((domain) => ({ ...domain, targetPort: null })),
        },
      },
      {
        label: "extra domain",
        snapshot: {
          ...healthy,
          domains: [
            ...healthy.domains,
            {
              kind: "service" as const,
              id: IDS.nextDeployment,
              domain: "extra-staging.up.railway.app",
              targetPort: 8_080,
            },
          ],
        },
      },
      {
        label: "custom-domain kind",
        snapshot: {
          ...healthy,
          domains: healthy.domains.map((domain) => ({
            ...domain,
            kind: "custom" as const,
          })),
        },
      },
      {
        label: "candidate already deployed as legacy",
        snapshot: {
          ...healthy,
          deployment: { ...healthy.deployment, commitHash: CANDIDATE },
        },
      },
      {
        label: "missing required provider row",
        snapshot: {
          ...healthy,
          rows: healthy.rows.filter((row) => row.name !== "OPENAI_API_KEY"),
        },
      },
      {
        label: "duplicate provider row",
        snapshot: {
          ...healthy,
          rows: [
            ...healthy.rows,
            {
              id: "variable-google-maps-api-key-duplicate",
              name: "GOOGLE_MAPS_API_KEY",
              environmentId: IDS.staging,
              serviceId: IDS.project,
              isSealed: false,
              references: [],
            },
          ],
        },
      },
      {
        label: "sealed provider row",
        snapshot: {
          ...healthy,
          rows: healthy.rows.map((row) => row.name === "GOOGLE_MAPS_MAP_ID"
            ? { ...row, isSealed: true }
            : row),
        },
      },
      {
        label: "foreign-service provider row",
        snapshot: {
          ...healthy,
          rows: healthy.rows.map((row) => row.name === "OPENAI_API_KEY"
            ? { ...row, serviceId: IDS.project }
            : row),
        },
      },
      {
        label: "referenced provider row",
        snapshot: {
          ...healthy,
          rows: healthy.rows.map((row) => row.name === "GOOGLE_PLACES_API_KEY"
            ? { ...row, references: ["OTHER_REFERENCE"] }
            : row),
        },
      },
    ];
    for (const scenario of scenarios) {
      expect(automaticMaintenanceWorkerFenceInternals.soleHealthyLegacyBaseline(
        scenario.snapshot,
        "permanent-staging",
        CANDIDATE,
      ), scenario.label).toBe(false);
    }
  });

  it("fails closed before staging prepare writes when the legacy baseline is unsafe", async () => {
    const scenarios: readonly {
      label: string;
      source: unknown;
      deploymentSha?: string;
    }[] = [
      {
        label: "failed latest deployment",
        source: forStaging(metadataSource({
          rows: providerRows(),
          status: "FAILED",
          targetPort: 8_080,
        })),
      },
      {
        label: "candidate already deployed as legacy",
        source: forStaging(metadataSource({
          rows: providerRows(),
          targetPort: 8_080,
        })),
        deploymentSha: CANDIDATE,
      },
      {
        label: "multiple replicas",
        source: forStaging(metadataSource({
          numReplicas: 2,
          rows: providerRows(),
          targetPort: 8_080,
        })),
      },
      {
        label: "latest and active identity mismatch",
        source: forStaging(metadataSource({
          activeDeployments: [{
            id: IDS.nextDeployment,
            status: "SUCCESS",
            deploymentStopped: false,
          }],
          rows: providerRows(),
          targetPort: 8_080,
        })),
      },
    ];

    for (const scenario of scenarios) {
      let mutationCalls = 0;
      let durableWrites = 0;
      let output = "";
      const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("WorkerFenceScope")) {
          return jsonResponse(forStaging(scopeSource()));
        }
        if (body.query.includes("WorkerFenceMetadata")) {
          return jsonResponse(scenario.source);
        }
        if (body.query.includes("WorkerFenceDeployment")) {
          return jsonResponse(forStaging(deploymentSource({
            candidateSha: scenario.deploymentSha ?? LEGACY_SHA,
          })));
        }
        if (body.query === AUTOMATIC_MAINTENANCE_WORKER_FENCE_MUTATION) {
          mutationCalls += 1;
          return jsonResponse({ data: { variableCollectionUpsert: true } });
        }
        throw new Error("unexpected request");
      }) as typeof fetch;

      const code = await runProtectedAutomaticMaintenanceWorkerFence({
        argv: prepareArguments(),
        env: stagingPrepareEnvironment(),
        cwd: process.cwd(),
        fetchImpl,
        boundaryCheck: async () => ({
          passed: true,
          receiptSha256: "6".repeat(64),
        }),
        readAuthority: stagingPrepareAuthority,
        writeDurable: (_directory, _leaf, source) => {
          durableWrites += 1;
          return sha256(source);
        },
        writeOutput: (source) => {
          output += source;
        },
      });

      expect(code, scenario.label).toBe(1);
      expect(mutationCalls, scenario.label).toBe(0);
      expect(durableWrites, scenario.label).toBe(0);
      expect(JSON.parse(output), scenario.label).toMatchObject({
        outcome: "failed_before_attempt",
        attempts: 0,
        failureCode: "OPERATION_PREFLIGHT_FAILED",
        checks: { operationPreflightExact: false },
      });
    }
  });

  it("fences once without a deploy and emits a production-consumable receipt", async () => {
    const metadata = [
      metadataSource({}),
      metadataSource({}),
      metadataSource({ rows: targetRows() }),
    ];
    const deployments = [
      deploymentSource({}),
      deploymentSource({}),
      deploymentSource({}),
    ];
    const writes = new Map<string, string>();
    const events: string[] = [];
    const mutationInputs: Record<string, unknown>[] = [];
    let boundaryCalls = 0;
    let runtimeCalls = 0;
    let output = "";
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://pintpath.au/")) {
        runtimeCalls += 1;
        return jsonResponse({});
      }
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("WorkerFenceScope")) return jsonResponse(scopeSource());
      if (body.query.includes("WorkerFenceMetadata")) {
        return jsonResponse(metadata.shift());
      }
      if (body.query.includes("WorkerFenceDeployment")) {
        return jsonResponse(deployments.shift());
      }
      if (body.query === AUTOMATIC_MAINTENANCE_WORKER_FENCE_MUTATION) {
        events.push("mutation");
        mutationInputs.push(body.variables);
        return jsonResponse({ data: { variableCollectionUpsert: true } });
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const code = await runProtectedAutomaticMaintenanceWorkerFence({
      argv: mutationArguments("fence"),
      env: environment("fence"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: async () => undefined,
      boundaryCheck: async () => {
        boundaryCalls += 1;
        return { passed: true, receiptSha256: String(boundaryCalls).repeat(64) };
      },
      reassertRepositoryState: () => true,
      readAuthority: () => authority("fence"),
      writeDurable: (_directory, leaf, source) => {
        events.push(`write:${leaf}`);
        writes.set(leaf, source);
        return sha256(source);
      },
      writeOutput: (source) => {
        output += source;
      },
    });

    expect(code).toBe(0);
    expect(boundaryCalls).toBe(2);
    expect(runtimeCalls).toBe(0);
    expect(events.indexOf("write:intent.json")).toBeLessThan(
      events.indexOf("mutation"),
    );
    expect(mutationInputs).toHaveLength(1);
    expect(mutationInputs[0]).toEqual({
      projectId: IDS.project,
      serviceId: IDS.service,
      environmentId: IDS.production,
      variables: {
        PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED: "false",
        PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: CANDIDATE,
      },
      skipDeploys: true,
    });
    const terminalSource = writes.get(
      "automatic-maintenance-worker-fence-terminal.json",
    );
    expect(terminalSource).toBeDefined();
    const terminal = JSON.parse(terminalSource!);
    expect(terminal).toMatchObject({
      outcome: "fenced",
      attempts: 1,
      retryAllowed: false,
      binding: {
        candidateSha: CANDIDATE,
        target: "production",
        operation: "fence",
        skipDeploys: true,
      },
      providerEvidence: { mutationCallCount: 1 },
      productionDeploymentVerification: {
        eligible: true,
        exactCandidateTargetOperationBindingRequired: true,
      },
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    expect(terminal.bindingSha256).toBe(
      sha256(canonical(terminal.binding)),
    );
    expect(terminalSource).not.toContain(METADATA_TOKEN);
    expect(terminalSource).not.toContain(STAGING_TOKEN);
    expect(terminalSource).not.toContain(WRITE_TOKEN);
    expect(JSON.parse(output)).toMatchObject({
      outcome: "fenced",
      attempts: 1,
      retryAllowed: false,
      failureCode: null,
      checks: {
        postflightAttempted: true,
        boundaryPostflightExact: true,
        terminalEvidenceExact: true,
      },
    });
  });

  it("activates only from the sole healthy candidate and polls every route", async () => {
    const metadata = [
      metadataSource({ rows: targetRows() }),
      metadataSource({ rows: targetRows() }),
      metadataSource({
        deploymentId: IDS.nextDeployment,
        snapshotId: IDS.nextSnapshot,
        rows: targetRows(),
      }),
    ];
    const deployments = [
      deploymentSource({}),
      deploymentSource({}),
      deploymentSource({
        deploymentId: IDS.nextDeployment,
        snapshotId: IDS.nextSnapshot,
      }),
    ];
    const runtimeRoutes: string[] = [];
    const mutationInputs: Record<string, unknown>[] = [];
    const writes = new Map<string, string>();
    let output = "";
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://pintpath.au/")) {
        const route = new URL(url).pathname as "/health" | "/startup" | "/ready";
        const preflight = runtimeRoutes.length < 6;
        runtimeRoutes.push(route);
        return jsonResponse(runtimeSource(route, {
          deploymentId: preflight ? IDS.deployment : IDS.nextDeployment,
          enabled: !preflight,
          candidateBound: true,
        }));
      }
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("WorkerFenceScope")) return jsonResponse(scopeSource());
      if (body.query.includes("WorkerFenceMetadata")) {
        return jsonResponse(metadata.shift());
      }
      if (body.query.includes("WorkerFenceDeployment")) {
        return jsonResponse(deployments.shift());
      }
      if (body.query === AUTOMATIC_MAINTENANCE_WORKER_FENCE_MUTATION) {
        mutationInputs.push(body.variables);
        return jsonResponse({ data: { variableCollectionUpsert: true } });
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const code = await runProtectedAutomaticMaintenanceWorkerFence({
      argv: mutationArguments("activate"),
      env: environment("activate"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: async () => undefined,
      boundaryCheck: async () => ({
        passed: true,
        receiptSha256: "f".repeat(64),
      }),
      reassertRepositoryState: () => true,
      readAuthority: () => authority("activate"),
      readActivationPrerequisite: () => ACTIVATION_PREREQUISITE_SOURCE,
      parseActivationPrerequisite: () => parsedActivationPrerequisite(),
      writeDurable: (_directory, leaf, source) => {
        writes.set(leaf, source);
        return sha256(source);
      },
      writeOutput: (source) => {
        output += source;
      },
    });

    expect(code).toBe(0);
    expect(mutationInputs).toHaveLength(1);
    expect(mutationInputs[0]).toMatchObject({
      variables: {
        PINTPATH_AUTOMATIC_MAINTENANCE_ENABLED: "true",
        PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA: CANDIDATE,
      },
      skipDeploys: false,
    });
    expect(runtimeRoutes).toEqual([
      "/health",
      "/startup",
      "/ready",
      "/health",
      "/startup",
      "/ready",
      "/health",
      "/startup",
      "/ready",
    ]);
    const intent = JSON.parse(writes.get("intent.json")!);
    expect(intent.productionActivationPrerequisite).toMatchObject({
      verificationSha256: sha256(ACTIVATION_PREREQUISITE_SOURCE),
      roleLimitRunId: ROLE_LIMIT_RUN_ID,
      expectedDeploymentIdSha256: railwayDeploymentIdentityIdSha256(
        "deployment",
        IDS.deployment,
      ),
      liveDeploymentIdSha256: railwayDeploymentIdentityIdSha256(
        "deployment",
        IDS.deployment,
      ),
      runtimeResponseSha256s: {
        "/health": expect.stringMatching(/^[a-f0-9]{64}$/),
        "/startup": expect.stringMatching(/^[a-f0-9]{64}$/),
        "/ready": expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const terminal = JSON.parse(
      writes.get("automatic-maintenance-worker-fence-terminal.json")!,
    );
    expect(terminal).toMatchObject({
      outcome: "activated",
      binding: {
        candidateSha: CANDIDATE,
        target: "production",
        operation: "activate",
      },
      runtimeEvidence: {
        observed: true,
        pollRounds: 1,
        responseSha256s: {
          "/health": expect.stringMatching(/^[a-f0-9]{64}$/),
          "/startup": expect.stringMatching(/^[a-f0-9]{64}$/),
          "/ready": expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(JSON.parse(output)).toMatchObject({
      outcome: "activated",
      failureCode: null,
      checks: {
        operationPreflightExact: true,
        postflightDeploymentExact: true,
        runtimeRoutesPolledExact: true,
        runtimeMaintenanceStateExact: true,
      },
    });
  });

  it("blocks a D1 generation drift after durable intent and before the variable upsert", async () => {
    const metadata = [
      metadataSource({ rows: targetRows() }),
      metadataSource({
        deploymentId: IDS.nextDeployment,
        snapshotId: IDS.nextSnapshot,
        rows: targetRows(),
      }),
    ];
    const deployments = [
      deploymentSource({}),
      deploymentSource({
        deploymentId: IDS.nextDeployment,
        snapshotId: IDS.nextSnapshot,
      }),
    ];
    let mutationCalls = 0;
    let output = "";
    const writes = new Map<string, string>();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://pintpath.au/")) {
        const route = new URL(url).pathname as "/health" | "/startup" | "/ready";
        return jsonResponse(runtimeSource(route, {
          deploymentId: IDS.deployment,
          enabled: false,
          candidateBound: true,
        }));
      }
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("WorkerFenceScope")) return jsonResponse(scopeSource());
      if (body.query.includes("WorkerFenceMetadata")) {
        return jsonResponse(metadata.shift());
      }
      if (body.query.includes("WorkerFenceDeployment")) {
        return jsonResponse(deployments.shift());
      }
      if (body.query === AUTOMATIC_MAINTENANCE_WORKER_FENCE_MUTATION) {
        mutationCalls += 1;
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const code = await runProtectedAutomaticMaintenanceWorkerFence({
      argv: mutationArguments("activate"),
      env: environment("activate"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: async () => undefined,
      boundaryCheck: async () => ({
        passed: true,
        receiptSha256: "f".repeat(64),
      }),
      reassertRepositoryState: () => true,
      readAuthority: () => authority("activate"),
      readActivationPrerequisite: () => ACTIVATION_PREREQUISITE_SOURCE,
      parseActivationPrerequisite: () => parsedActivationPrerequisite(),
      writeDurable: (_directory, leaf, source) => {
        writes.set(leaf, source);
        return sha256(source);
      },
      writeOutput: (source) => {
        output += source;
      },
    });

    expect(code).toBe(1);
    expect(writes.has("intent.json")).toBe(true);
    expect(mutationCalls).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      failureCode: "TARGET_PREFLIGHT_FAILED",
      checks: {
        durableIntentExact: true,
        targetPreflightExact: false,
        writeAttemptedAtMostOnce: true,
      },
    });
  });

  it("blocks activation before any write when the deployed source is not the candidate", async () => {
    let mutationCalls = 0;
    let boundaryCalls = 0;
    let output = "";
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("WorkerFenceScope")) return jsonResponse(scopeSource());
      if (body.query.includes("WorkerFenceMetadata")) {
        return jsonResponse(metadataSource({ rows: targetRows() }));
      }
      if (body.query.includes("WorkerFenceDeployment")) {
        return jsonResponse(deploymentSource({ candidateSha: "9".repeat(40) }));
      }
      if (body.query === AUTOMATIC_MAINTENANCE_WORKER_FENCE_MUTATION) {
        mutationCalls += 1;
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const code = await runProtectedAutomaticMaintenanceWorkerFence({
      argv: mutationArguments("activate"),
      env: environment("activate"),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: async () => {
        boundaryCalls += 1;
        return { passed: true, receiptSha256: "8".repeat(64) };
      },
      readAuthority: () => authority("activate"),
      readActivationPrerequisite: () => ACTIVATION_PREREQUISITE_SOURCE,
      parseActivationPrerequisite: () => parsedActivationPrerequisite(),
      writeDurable: () => {
        throw new Error("write must not occur");
      },
      writeOutput: (source) => {
        output += source;
      },
    });

    expect(code).toBe(1);
    expect(mutationCalls).toBe(0);
    expect(boundaryCalls).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      failureCode: "OPERATION_PREFLIGHT_FAILED",
    });
  });

  it("binds production activation to the role-limit deployment before any write", async () => {
    let mutationCalls = 0;
    let output = "";
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://pintpath.au/")) {
        const route = new URL(url).pathname as "/health" | "/startup" | "/ready";
        return jsonResponse(runtimeSource(route, {
          enabled: false,
          candidateBound: true,
        }));
      }
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("WorkerFenceScope")) return jsonResponse(scopeSource());
      if (body.query.includes("WorkerFenceMetadata")) {
        return jsonResponse(metadataSource({ rows: targetRows() }));
      }
      if (body.query.includes("WorkerFenceDeployment")) {
        return jsonResponse(deploymentSource({}));
      }
      if (body.query === AUTOMATIC_MAINTENANCE_WORKER_FENCE_MUTATION) {
        mutationCalls += 1;
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const code = await runProtectedAutomaticMaintenanceWorkerFence({
      argv: mutationArguments("activate"),
      env: environment("activate"),
      cwd: process.cwd(),
      fetchImpl,
      boundaryCheck: async () => ({
        passed: true,
        receiptSha256: "6".repeat(64),
      }),
      readAuthority: () => authority("activate"),
      readActivationPrerequisite: () => ACTIVATION_PREREQUISITE_SOURCE,
      parseActivationPrerequisite: () =>
        parsedActivationPrerequisite(IDS.nextDeployment),
      writeDurable: () => {
        throw new Error("write must not occur");
      },
      writeOutput: (source) => {
        output += source;
      },
    });

    expect(code).toBe(1);
    expect(mutationCalls).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      outcome: "failed_before_attempt",
      attempts: 0,
      failureCode: "OPERATION_PREFLIGHT_FAILED",
      checks: { operationPreflightExact: false },
    });
  });

  it("never retries an uncertain write and still performs read-only reconciliation", async () => {
    const metadata = [
      metadataSource({}),
      metadataSource({}),
      metadataSource({ rows: targetRows() }),
    ];
    const deployments = [
      deploymentSource({}),
      deploymentSource({}),
      deploymentSource({}),
    ];
    let mutationCalls = 0;
    let boundaryCalls = 0;
    let output = "";
    const writes = new Map<string, string>();
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("WorkerFenceScope")) return jsonResponse(scopeSource());
      if (body.query.includes("WorkerFenceMetadata")) {
        return jsonResponse(metadata.shift());
      }
      if (body.query.includes("WorkerFenceDeployment")) {
        return jsonResponse(deployments.shift());
      }
      if (body.query === AUTOMATIC_MAINTENANCE_WORKER_FENCE_MUTATION) {
        mutationCalls += 1;
        return new Response("provider acknowledgement unavailable", { status: 502 });
      }
      throw new Error("unexpected request");
    }) as typeof fetch;

    const code = await runProtectedAutomaticMaintenanceWorkerFence({
      argv: mutationArguments("fence"),
      env: environment("fence"),
      cwd: process.cwd(),
      fetchImpl,
      now: () => 0,
      sleep: async () => undefined,
      boundaryCheck: async () => {
        boundaryCalls += 1;
        return { passed: true, receiptSha256: "7".repeat(64) };
      },
      reassertRepositoryState: () => true,
      readAuthority: () => authority("fence"),
      writeDurable: (_directory, leaf, source) => {
        writes.set(leaf, source);
        return sha256(source);
      },
      writeOutput: (source) => {
        output += source;
      },
    });

    expect(code).toBe(1);
    expect(mutationCalls).toBe(1);
    expect(boundaryCalls).toBe(2);
    expect(writes.has("automatic-maintenance-worker-fence-terminal.json"))
      .toBe(true);
    expect(JSON.parse(output)).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: 1,
      retryAllowed: false,
      failureCode: "MUTATION_UNCERTAIN",
      checks: {
        acknowledgementExact: false,
        postflightAttempted: true,
        targetPostflightExact: true,
        boundaryPostflightExact: true,
      },
    });
  });

  it("keeps the workflow manual, protected, non-cancelling, and token-late", () => {
    const workflow = fs.readFileSync(
      ".github/workflows/configure-automatic-maintenance-worker-fence.yml",
      "utf8",
    );
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m);
    expect(workflow).toContain("prepare|fence|activate");
    expect(workflow).toContain("prepare_run_id:");
    expect(workflow).toContain("quiesce_run_id:");
    expect(workflow).toContain("fenced_deployment_run_id:");
    expect(workflow).toContain("restore_run_id:");
    expect(workflow).toContain("ambiguous_activate_run_id:");
    expect(workflow).toContain("role_limit_run_id:");
    expect(workflow).toContain('if test "$OPERATION" = prepare; then');
    expect(workflow).toContain('if test "$OPERATION" = fence; then');
    expect(workflow).toContain('if test "$OPERATION" = activate; then');
    expect(workflow).not.toContain("prime|fence|activate");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("queue: max");
    expect(workflow).toContain(
      "inputs.target == 'production' && 'pintpath-production-rollout' || " +
        "'pintpath-permanent-staging-key-rollout'",
    );
    expect(workflow).not.toContain(
      "group: pintpath-automatic-maintenance-worker-fence-${{ inputs.target }}",
    );
    expect(workflow).toContain("production-runtime-configuration");
    expect(workflow).toContain("permanent-staging-provider-mutation");
    expect(workflow).toContain("RUN_ATTEMPT\" = '1'");
    expect(workflow).toContain("npm run check");
    expect(workflow).toContain("--mode authority");
    expect(workflow).toContain("--mode mutate");
    expect(workflow).toContain(
      "scripts/verify-permanent-staging-worker-bootstrap-prerequisites.ts",
    );
    expect(workflow).toContain("--operation activate");
    expect(workflow).toContain(
      "scripts/verify-production-maintenance-role-limit-prerequisites.ts",
    );
    expect(workflow).toContain("--mode production-activate");
    expect(workflow).toContain("--role-intent-file \"$sealed/intent.json\"");
    expect(workflow.match(/actions\/download-artifact@b7c52a5f7a25/g))
      .toHaveLength(13);
    const reconcileJob = workflow.split("\n  reconcile-activate:")[1];
    expect(reconcileJob).toContain(
      "Reconcile an ambiguous staging automatic-maintenance activation",
    );
    expect(reconcileJob).not.toContain(
      "PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN",
    );
    expect(reconcileJob).not.toContain(
      "PINTPATH_RAILWAY_STAGING_VARIABLE_TOKEN",
    );
    expect(workflow).toContain("PINTPATH_RAILWAY_TARGET_METADATA_TOKEN");
    expect(workflow).toContain("PINTPATH_RAILWAY_TARGET_VARIABLE_TOKEN");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("readiness:railway:mutation-boundary");
    expect(workflow).toContain("actions/upload-artifact@043fb46d");
    const fullCheck = workflow.indexOf("npm run check");
    const authority = workflow.indexOf("--mode authority");
    const firstProviderSecret = workflow.indexOf(
      "secrets.PINTPATH_RAILWAY",
    );
    const reassertion = workflow.indexOf(
      "Reassert exact current main immediately before provider-token custody",
    );
    const stagingPrerequisite = workflow.indexOf(
      "scripts/verify-permanent-staging-worker-bootstrap-prerequisites.ts",
    );
    const productionPrerequisite = workflow.indexOf(
      "scripts/verify-production-maintenance-role-limit-prerequisites.ts",
    );
    expect(fullCheck).toBeGreaterThan(0);
    expect(authority).toBeGreaterThan(fullCheck);
    expect(stagingPrerequisite).toBeGreaterThan(fullCheck);
    expect(productionPrerequisite).toBeGreaterThan(stagingPrerequisite);
    expect(firstProviderSecret).toBeGreaterThan(productionPrerequisite);
    expect(reassertion).toBeGreaterThan(authority);
    expect(firstProviderSecret).toBeGreaterThan(reassertion);
  });
});
