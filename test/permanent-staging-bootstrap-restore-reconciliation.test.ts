import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  runPermanentStagingBootstrapRestoreReconciliationProbe,
  STAGING_BOOTSTRAP_RESTORE_DISCOVERY_QUERY,
  STAGING_BOOTSTRAP_RESTORE_EMPTY_PATCH_QUERY,
  STAGING_BOOTSTRAP_RESTORE_RECONCILIATION_SCHEMA,
  STAGING_BOOTSTRAP_RESTORE_SNAPSHOT_QUERY,
  stagingBootstrapRestoreReconciliationInternals,
} from "../scripts/probe-permanent-staging-bootstrap-restore-reconciliation.js";
import type { RailwayApplicationDeploymentAttestationProviderSnapshot } from
  "../src/lib/railway-application-deployment-attestation.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";
import {
  stagingWorkerBootstrapPrerequisiteInternals,
  type StagingWorkerBootstrapPrerequisitesVerification,
} from "../scripts/verify-permanent-staging-worker-bootstrap-prerequisites.js";

const CANDIDATE = "a".repeat(40);
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";
const DOMAIN_ID = "44444444-4444-4444-8444-444444444444";
const PRIOR_RESTORE_RUN_ID = "712";
const CURRENT_RUN_ID = "714";
const AUTHORITY_FILE = "/private/reviewed-authority.json";
const PREREQUISITES_FILE = "/private/prerequisites-verification.json";
const EVIDENCE_DIRECTORY = "/private/evidence";
const PRIMARY_REGION = "asia-southeast1-eqsg3a";
const OPTIONAL_ZERO_REGION = "europe-west4-drams3a";
const CONFIGURED_ONE_REGIONS = Object.freeze([
  Object.freeze({ region: PRIMARY_REGION, numReplicas: 1 }),
  Object.freeze({ region: OPTIONAL_ZERO_REGION, numReplicas: 0 }),
]);

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function snapshot(
  deploymentId = DEPLOYMENT_ID,
  legacyNumReplicas: number | null = 1,
): RailwayApplicationDeploymentAttestationProviderSnapshot {
  return {
    serviceInstanceId: INSTANCE_ID,
    serviceId: SERVICE_ID,
    environmentId: ENVIRONMENT_ID,
    numReplicas: legacyNumReplicas,
    latestDeployment: {
      id: deploymentId,
      status: "SUCCESS",
      deploymentStopped: false,
      snapshotId: SNAPSHOT_ID,
    },
    activeDeployments: [{
      id: deploymentId,
      status: "SUCCESS",
      deploymentStopped: false,
    }],
    domains: [{
      kind: "service",
      id: DOMAIN_ID,
      domain: "beer-staging.up.railway.app",
      targetPort: 8_080,
    }],
    deployment: {
      id: deploymentId,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      snapshotId: SNAPSHOT_ID,
      commitHash: CANDIDATE,
      imageDigest: `sha256:${"b".repeat(64)}`,
      patchId: null,
    },
  };
}

function configuredEnvironment(multiRegionConfig: unknown): Record<string, unknown> {
  return {
    services: {
      [SERVICE_ID]: { deploy: { multiRegionConfig } },
    },
  };
}

function snapshotResponse(
  config: unknown,
  legacyNumReplicas: number | null = 1,
): Record<string, unknown> {
  const value = snapshot(DEPLOYMENT_ID, legacyNumReplicas);
  return {
    data: {
      environment: { id: ENVIRONMENT_ID, config },
      serviceInstance: {
        id: value.serviceInstanceId,
        serviceId: value.serviceId,
        environmentId: value.environmentId,
        numReplicas: value.numReplicas,
        latestDeployment: value.latestDeployment,
        activeDeployments: value.activeDeployments,
        domains: {
          serviceDomains: value.domains.map(({ kind: _kind, ...domain }) => domain),
          customDomains: [],
        },
      },
      deployment: {
        id: value.deployment.id,
        projectId: value.deployment.projectId,
        environmentId: value.deployment.environmentId,
        serviceId: value.deployment.serviceId,
        snapshotId: value.deployment.snapshotId,
        meta: {
          commitHash: value.deployment.commitHash,
          imageDigest: value.deployment.imageDigest,
          patchId: value.deployment.patchId,
        },
      },
    },
  };
}

function reviewedAuthority(
  priorRestoreRunId = PRIOR_RESTORE_RUN_ID,
): string {
  return `${JSON.stringify({
    command: "verify-github-reviewed-candidate-authority",
    ok: true,
    kind: "pintpath-github-reviewed-candidate-authority",
    repository: "blackmagic30/Beer",
    candidateSha: CANDIDATE,
    operation: "staging-worker-bootstrap-reconcile-restore",
    workflowPath:
      ".github/workflows/bootstrap-permanent-staging-worker-fence.yml",
    workflowRunId: CURRENT_RUN_ID,
    workflowRunAttempt: 1,
    priorAmbiguousStagingRestoreRunId: priorRestoreRunId,
    exactPriorStagingRestoreCandidateRunBound: true,
    secondStagingRestoreScaleWritePreventedExact: true,
    runnerLossRecoveryOriginalRunCompletedAt: "2026-08-28T00:55:00.000Z",
    runnerLossRecoveryGraceHours: 24,
    runnerLossRecoveryWithinGraceExact: true,
    reviewedAuthorityExact: true,
    freshDispatchWriteGuardExact: true,
  })}\n`;
}

function prerequisites(
  deploymentId = DEPLOYMENT_ID,
): StagingWorkerBootstrapPrerequisitesVerification {
  const kinds = ["prepare", "quiesce", "fenced-deployment"] as const;
  return {
    operation: "reconcile-restore",
    bootstrapPath: "healthy-legacy",
    candidateSha: CANDIDATE,
    expectedDeploymentSha: CANDIDATE,
    prerequisites: kinds.map((kind, index) => ({
      kind,
      receipt: {
        sourceSha: kind === "fenced-deployment" ? CANDIDATE : "b".repeat(40),
        deploymentIdSha256: kind === "fenced-deployment"
          ? railwayDeploymentIdentityIdSha256("deployment", deploymentId)!
          : "c".repeat(64),
      },
      runId: String(710 + index),
    })),
  } as unknown as StagingWorkerBootstrapPrerequisitesVerification;
}

function runtimeProof(observed = true) {
  return {
    observed,
    pollRounds: 1,
    responseSha256s: {
      "/health": observed ? "d".repeat(64) : null,
      "/startup": observed ? "e".repeat(64) : null,
      "/ready": observed ? "f".repeat(64) : null,
    },
  } as const;
}

function environment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "blackmagic30/Beer",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: CANDIDATE,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: CURRENT_RUN_ID,
    PINTPATH_PROTECTED_ENVIRONMENT: "permanent-staging-scale-evidence",
    PINTPATH_STAGING_WORKER_BOOTSTRAP_CONFIRMATION:
      `RECONCILE_PERMANENT_STAGING_WORKER_BOOTSTRAP_AT_ONE_FOR_${CANDIDATE}`,
    PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN:
      "production-metadata-token-long-enough",
    PINTPATH_RAILWAY_STAGING_METADATA_TOKEN:
      "staging-metadata-token-long-enough",
    ...overrides,
  };
}

function argv(): string[] {
  return [
    "--candidate-sha", CANDIDATE,
    "--expected-deployment-sha", CANDIDATE,
    "--bootstrap-path", "healthy-legacy",
    "--prior-restore-run-id", PRIOR_RESTORE_RUN_ID,
    "--prerequisites-verification-file", PREREQUISITES_FILE,
    "--reviewed-authority-file", AUTHORITY_FILE,
    "--evidence-dir", EVIDENCE_DIRECTORY,
  ];
}

function scopeResponse(): Response {
  return new Response(JSON.stringify({
    data: { projectToken: { projectId: PROJECT_ID, environmentId: ENVIRONMENT_ID } },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function harness(options: {
  env?: Record<string, string | undefined>;
  authority?: string;
  states?: RailwayApplicationDeploymentAttestationProviderSnapshot[];
  configuredRegions?: readonly {
    readonly region: string;
    readonly numReplicas: number;
  }[];
  runtimeObserved?: boolean;
  repositoryStates?: boolean[];
} = {}) {
  const output: string[] = [];
  const writes: Array<{ leaf: string; source: string }> = [];
  const states = options.states ?? [snapshot(), snapshot()];
  const readState = vi.fn(async () => {
    const next = states.shift();
    const configuredRegions = options.configuredRegions ?? CONFIGURED_ONE_REGIONS;
    return next
      ? {
        patchEmpty: true as const,
        snapshot: next,
        configuredReplicas: configuredRegions.reduce(
          (total, entry) => total + entry.numReplicas,
          0,
        ),
        configuredRegions,
      }
      : null;
  });
  const parsePrerequisites = vi.fn(() => prerequisites());
  const probeRuntime = vi.fn().mockResolvedValue(
    runtimeProof(options.runtimeObserved ?? true),
  );
  const boundaryCheck = vi.fn().mockResolvedValue({
    passed: true,
    receiptSha256: "1".repeat(64),
  });
  const repositoryStates = options.repositoryStates ?? [true, true];
  const reassertRepositoryState = vi.fn(() => repositoryStates.shift() ?? false);
  const fetchImpl = vi.fn().mockResolvedValue(scopeResponse());
  const result = runPermanentStagingBootstrapRestoreReconciliationProbe({
    argv: argv(),
    env: options.env ?? environment(),
    cwd: process.cwd(),
    fetchImpl,
    now: () => 0,
    sleep: vi.fn(),
    boundaryCheck,
    readState,
    probeRuntime,
    readPrivateEvidence: (filename) => filename === AUTHORITY_FILE
      ? options.authority ?? reviewedAuthority()
      : "prerequisites\n",
    parsePrerequisites,
    reassertRepositoryState,
    writeDurable: (_directory, leaf, source) => {
      writes.push({ leaf, source });
      return sha256(source);
    },
    writeOutput: (source) => output.push(source),
  });
  return {
    result,
    output,
    writes,
    readState,
    parsePrerequisites,
    probeRuntime,
    boundaryCheck,
    reassertRepositoryState,
    fetchImpl,
  };
}

describe("permanent-staging bootstrap restore runner-loss reconciliation", () => {
  it("emits a truthful metadata-only 1→1 restore receipt", async () => {
    const fixture = harness();
    await expect(fixture.result).resolves.toBe(0);

    expect(fixture.fetchImpl).toHaveBeenCalledOnce();
    expect(fixture.readState).toHaveBeenCalledTimes(2);
    expect(fixture.probeRuntime).toHaveBeenCalledTimes(2);
    expect(fixture.boundaryCheck).toHaveBeenCalledTimes(2);
    expect(fixture.reassertRepositoryState).toHaveBeenCalledTimes(2);
    expect(fixture.writes.map((item) => item.leaf)).toEqual([
      "bootstrap-staging-one-reconciliation-observation.json",
      "bootstrap-staging-one-receipt.json",
    ]);
    const receipt = JSON.parse(fixture.writes[1]!.source) as Record<string, unknown>;
    const observation = JSON.parse(fixture.writes[0]!.source) as Record<string, unknown>;
    expect(observation).toMatchObject({
      configuredReplicasObserved: 1,
      configuredRegionsObserved: CONFIGURED_ONE_REGIONS,
      legacyReplicasObserved: 1,
    });
    expect(receipt).toMatchObject({
      schemaVersion: STAGING_BOOTSTRAP_RESTORE_RECONCILIATION_SCHEMA,
      operation: "restore",
      outcome: "reconciled_one_after_runner_loss",
      candidateSha: CANDIDATE,
      sourceSha: CANDIDATE,
      replicasBefore: 1,
      replicasAfter: 1,
      attempts: 0,
      retryAllowed: false,
      runnerLossReconciliation: {
        priorAmbiguousRestoreRunId: PRIOR_RESTORE_RUN_ID,
        scaleCredentialPresent: false,
        providerWriteAttempted: false,
      },
      commandEvidence: {
        exitCode: null,
        timedOut: false,
        stdoutSha256: null,
        stderrSha256: null,
      },
      repositoryEvidence: {
        beforeExact: true,
        afterExact: true,
      },
      nextRequiredProof: "ACTIVATE_AUTOMATIC_MAINTENANCE",
      normalZeroToOneReceiptClaimed: false,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    expect(Object.values(receipt.checks as Record<string, boolean>))
      .toEqual(expect.arrayContaining([true]));
    expect(Object.values(receipt.checks as Record<string, boolean>))
      .not.toContain(false);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      outcome: "reconciled_one_after_runner_loss",
      attempts: 0,
    });
    expect(stagingWorkerBootstrapPrerequisiteInternals.validateScaleReceipt(
      fixture.writes[1]!.source,
      receipt,
      CANDIDATE,
      "restore",
      CANDIDATE,
    )).toMatchObject({
      outcome: "reconciled_one_after_runner_loss",
      sourceSha: CANDIDATE,
      replicasBefore: 1,
      replicasAfter: 1,
    });
  });

  it("accepts null legacy replica evidence when configured topology is exactly one", async () => {
    const fixture = harness({
      states: [snapshot(DEPLOYMENT_ID, null), snapshot(DEPLOYMENT_ID, null)],
    });
    await expect(fixture.result).resolves.toBe(0);

    const observation = JSON.parse(fixture.writes[0]!.source) as Record<string, unknown>;
    const receipt = JSON.parse(fixture.writes[1]!.source) as Record<string, unknown>;
    expect(observation).toMatchObject({
      configuredReplicasObserved: 1,
      configuredRegionsObserved: CONFIGURED_ONE_REGIONS,
      legacyReplicasObserved: null,
    });
    expect(receipt).toMatchObject({ replicasBefore: 1, replicasAfter: 1 });
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      replicasBefore: 1,
      replicasAfter: 1,
      legacyReplicasBefore: null,
      legacyReplicasAfter: null,
    });
  });

  it("does not treat benign legacy replica drift as authoritative provider drift", async () => {
    const fixture = harness({
      states: [snapshot(DEPLOYMENT_ID, 1), snapshot(DEPLOYMENT_ID, null)],
    });
    await expect(fixture.result).resolves.toBe(0);

    const receipt = JSON.parse(fixture.writes[1]!.source) as {
      providerEvidence: {
        stateBeforeSha256: string;
        stateAfterSha256: string;
        topologyBeforeSha256: string;
        topologyAfterSha256: string;
      };
    };
    expect(receipt.providerEvidence.stateAfterSha256)
      .toBe(receipt.providerEvidence.stateBeforeSha256);
    expect(receipt.providerEvidence.topologyAfterSha256)
      .toBe(receipt.providerEvidence.topologyBeforeSha256);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      legacyReplicasBefore: 1,
      legacyReplicasAfter: null,
    });
  });

  it.each([
    [
      "wrong positive region",
      [{ region: OPTIONAL_ZERO_REGION, numReplicas: 1 }],
    ],
    [
      "unknown extra zero region",
      [
        { region: PRIMARY_REGION, numReplicas: 1 },
        { region: "us-west2", numReplicas: 0 },
      ],
    ],
  ])("rejects a %s", async (_label, configuredRegions) => {
    const fixture = harness({ configuredRegions });
    await expect(fixture.result).resolves.toBe(1);
    expect(fixture.writes).toEqual([]);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      outcome: "probe_failed",
      failureCode: "provider_state_invalid",
      checks: { exactCandidateOneBefore: false },
    });
  });

  it("rejects missing or malformed configured topology", () => {
    const exact = stagingBootstrapRestoreReconciliationInternals.configuredOneExact;
    const parse = stagingBootstrapRestoreReconciliationInternals
      .parseRestoreStateSnapshot;
    expect(exact(1, [{ region: PRIMARY_REGION, numReplicas: 1 }])).toBe(true);
    expect(exact(1, [])).toBe(false);
    expect(exact(1, [{ region: PRIMARY_REGION, numReplicas: 0 }])).toBe(false);
    expect(exact(0, CONFIGURED_ONE_REGIONS)).toBe(false);
    expect(parse(snapshotResponse(configuredEnvironment({
      [PRIMARY_REGION]: { numReplicas: 1 },
      [OPTIONAL_ZERO_REGION]: { numReplicas: 0 },
    }), null))).toMatchObject({
      snapshot: { numReplicas: null },
      configuredReplicas: 1,
      configuredRegions: CONFIGURED_ONE_REGIONS,
    });
    expect(parse(snapshotResponse({}, null))).toBeNull();
    expect(parse(snapshotResponse(configuredEnvironment("malformed"), null)))
      .toBeNull();
    expect(parse(snapshotResponse(configuredEnvironment({
      [PRIMARY_REGION]: { numReplicas: 1 },
      "unknown-region": { numReplicas: 0 },
    }), null))).toBeNull();
  });

  it("rejects an authority artifact bound to another ambiguous restore", async () => {
    const fixture = harness({ authority: reviewedAuthority("999") });
    await expect(fixture.result).resolves.toBe(1);
    expect(fixture.readState).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      outcome: "probe_failed",
      failureCode: "reviewed_authority_invalid",
    });
  });

  it("rejects any ambient scale credential before reading provider state", async () => {
    const fixture = harness({
      env: environment({
        PINTPATH_RAILWAY_STAGING_SCALE_TOKEN: "scale-token-that-is-long-enough",
      }),
    });
    await expect(fixture.result).resolves.toBe(1);
    expect(fixture.readState).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      failureCode: "token_configuration_invalid",
      checks: { scaleCredentialAbsent: false },
    });
  });

  it("rejects provider identity drift between the two observations", async () => {
    const fixture = harness({
      states: [snapshot(), snapshot("55555555-5555-4555-8555-555555555555")],
    });
    await expect(fixture.result).resolves.toBe(1);
    expect(fixture.writes.map((item) => item.leaf)).toEqual([
      "bootstrap-staging-one-reconciliation-observation.json",
    ]);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      failureCode: "provider_drift",
      checks: { deploymentAndTopologyUnchanged: false },
    });
  });

  it("rejects repository drift after the second runtime and boundary proof", async () => {
    const fixture = harness({ repositoryStates: [true, false] });
    await expect(fixture.result).resolves.toBe(1);
    expect(fixture.readState).toHaveBeenCalledTimes(2);
    expect(fixture.probeRuntime).toHaveBeenCalledTimes(2);
    expect(fixture.boundaryCheck).toHaveBeenCalledTimes(2);
    expect(fixture.reassertRepositoryState).toHaveBeenCalledTimes(2);
    expect(fixture.writes.map((item) => item.leaf)).toEqual([
      "bootstrap-staging-one-reconciliation-observation.json",
    ]);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      failureCode: "repository_drift",
      checks: {
        repositoryBeforeExact: true,
        repositoryAfterExact: false,
        repositoryReasserted: false,
      },
    });
  });

  it("rejects a candidate runtime that does not prove the disabled worker fence", async () => {
    const fixture = harness({ runtimeObserved: false });
    await expect(fixture.result).resolves.toBe(1);
    expect(fixture.readState).toHaveBeenCalledOnce();
    expect(fixture.writes).toEqual([]);
    expect(JSON.parse(fixture.output[0]!)).toMatchObject({
      failureCode: "runtime_invalid",
      checks: { runtimeBeforeExact: false },
    });
  });

  it("keeps every provider query read-only and the reconcile job mutation-free", () => {
    expect(STAGING_BOOTSTRAP_RESTORE_EMPTY_PATCH_QUERY).not.toMatch(/mutation\s/i);
    expect(STAGING_BOOTSTRAP_RESTORE_DISCOVERY_QUERY).not.toMatch(/mutation\s/i);
    expect(STAGING_BOOTSTRAP_RESTORE_SNAPSHOT_QUERY).not.toMatch(/mutation\s/i);
    expect(STAGING_BOOTSTRAP_RESTORE_SNAPSHOT_QUERY).toContain(
      "environment(id:$environmentId,projectId:$projectId)",
    );
    expect(STAGING_BOOTSTRAP_RESTORE_SNAPSHOT_QUERY).toContain(
      "config(decryptVariables:false)",
    );
    const workflow = fs.readFileSync(
      path.resolve(".github/workflows/bootstrap-permanent-staging-worker-fence.yml"),
      "utf8",
    );
    const reconcileJob = workflow.split("  reconcile-restore:\n")[1] ?? "";
    expect(reconcileJob).toContain(
      "name: Reconcile an ambiguous staging bootstrap restore at exact one",
    );
    expect(reconcileJob).toContain(
      "name: pintpath-permanent-staging-worker-bootstrap-restore-${{ inputs.candidate_sha }}",
    );
    expect(reconcileJob).not.toContain("PINTPATH_RAILWAY_STAGING_SCALE_TOKEN");
    expect(reconcileJob).not.toContain("PINTPATH_RAILWAY_STAGING_VARIABLE");
    expect(reconcileJob).not.toContain("PINTPATH_RAILWAY_STAGING_MUTATION");
    expect(reconcileJob).not.toContain(
      "execute-protected-permanent-staging-scale.ts",
    );
    expect(reconcileJob).not.toContain("service scale");
    expect(reconcileJob).not.toContain("PINTPATH_RAILWAY_CLI_PATH");
  });
});
