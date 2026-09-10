import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA,
  PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE,
  PERMANENT_STAGING_APP_DEPLOYMENT_LOCK,
  PERMANENT_STAGING_APP_DEPLOYMENT_POLICY_SCHEMA,
  permanentStagingAppDeploymentExecutorInternals,
  parsePermanentStagingAppDeploymentPolicy,
  runPermanentStagingAppDeploymentExecutor,
  type PermanentStagingAppDeploymentPolicy,
  type PilotProviderSnapshot,
} from "../scripts/lib/bar-pilot-staging-app-deployment-executor.js";
import {
  canonicalProtectedSourceArchiveManifest,
  type ProtectedSourceArchiveIdentity,
  type ProtectedSourceArchiveRuntimeResponse,
} from "../src/lib/protected-source-archive.js";
import type {
  RailwayApplicationDeploymentAttestationProviderSnapshot,
  RailwayApplicationDeploymentAttestationRuntimeResponse,
} from "../src/lib/railway-application-deployment-attestation.js";
import { railwayDeploymentIdentityIdSha256 } from
  "../src/lib/railway-deployment-identity.js";
import type { ProductionDeploymentWorkerFencePrerequisiteVerification } from
  "../scripts/verify-production-maintenance-role-limit-prerequisites.js";
import { BAR_PILOT_STOPPED_DEPLOYMENT_ID, BAR_PILOT_STOPPED_SOURCE_SHA } from
  "../scripts/lib/bar-pilot-staging-contract.js";

const CANDIDATE_SHA = "a".repeat(40);
const SOURCE_MANIFEST = {
  schemaVersion: "protected-source-archive/v1" as const,
  candidateSha: CANDIDATE_SHA,
  treeSha: "d".repeat(40),
  sourceArchiveSha256: "e".repeat(64),
  sourceBaseManifestSha256: "8".repeat(64),
  uploadNonce: "9".repeat(64),
};
const SOURCE_IDENTITY: ProtectedSourceArchiveIdentity = {
  ...SOURCE_MANIFEST,
  sourceIdentitySha256: crypto.createHash("sha256")
    .update(canonicalProtectedSourceArchiveManifest(SOURCE_MANIFEST)).digest("hex"),
};
const DEPLOYMENT_BEFORE = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_AFTER = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_BEFORE = "33333333-3333-4333-8333-333333333333";
const SNAPSHOT_AFTER = "44444444-4444-4444-8444-444444444444";
const INSTANCE_ID = "55555555-5555-4555-8555-555555555555";
const DOMAIN_ID = "66666666-6666-4666-8666-666666666666";
const TERMINAL_DRIFT_DEPLOYMENT = "77777777-7777-4777-8777-777777777777";
const TERMINAL_DRIFT_SNAPSHOT = "88888888-8888-4888-8888-888888888888";
const PRODUCTION_RUN_ID = "9000";
const PRODUCTION_FENCE_RUN_ID = "8000";

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function policySource(name: "permanent-staging" | "production"): string {
  const filename = name === "production"
    ? "ops/railway/production-app-deployment-policy.json"
    : "ops/railway/permanent-staging-app-deployment-policy.json";
  return fs.readFileSync(path.resolve(filename), "utf8");
}

function fencedStagingPolicySource(): string {
  return fs.readFileSync(path.resolve(
    "ops/railway/permanent-staging-fenced-app-deployment-policy.json",
  ), "utf8");
}

function policy(name: "permanent-staging" | "production"):
  PermanentStagingAppDeploymentPolicy {
  const value = parsePermanentStagingAppDeploymentPolicy(policySource(name));
  if (!value) throw new Error("fixture_policy_invalid");
  return value;
}

function canonicalKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalKeyOrder);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [
    key,
    canonicalKeyOrder(record[key]),
  ]));
}

function topologySha256(value: unknown): string {
  return crypto.createHash("sha256").update(
    `${JSON.stringify(canonicalKeyOrder(value), null, 2)}\n`,
  ).digest("hex");
}

function providerObservation(
  exactPolicy: PermanentStagingAppDeploymentPolicy,
  candidateSha: string,
  deploymentId: string,
  snapshotId: string,
  status = "SUCCESS",
  legacyReplicaCount: number | null =
    exactPolicy.fencedDeploymentContract
      ? null
      : exactPolicy.target.allowedReplicaCounts[0],
  configuredReplicaCount = exactPolicy.target.allowedReplicaCounts[0],
  configuredRegionsOverride?: readonly {
    readonly region: string;
    readonly numReplicas: number;
  }[],
) {
  const configuredRegions = configuredRegionsOverride ?? [
      {
        region: exactPolicy.configuredTopologyContract.solePositiveRegion ?? "asia-southeast1-eqsg3a",
        numReplicas: configuredReplicaCount,
      },
      ...(exactPolicy.target.name === "permanent-staging" && exactPolicy.configuredTopologyContract.solePositiveRegion !== "us-west2"
        ? [{ region: "europe-west4-drams3a", numReplicas: 0 }]
        : []),
    ];
  const configuredTopologyBase = {
    configuredReplicas: configuredReplicaCount,
    configuredRegions,
  };
  const snapshot: PilotProviderSnapshot = {
    serviceInstanceId: INSTANCE_ID,
    serviceId: exactPolicy.target.serviceId,
    environmentId: exactPolicy.target.environmentId,
    numReplicas: legacyReplicaCount,
    latestDeployment: {
      id: deploymentId,
      status,
      deploymentStopped: false,
      snapshotId,
    },
    activeDeployments: [{ id: deploymentId, status, deploymentStopped: false }],
    domains: [{
      kind: "service",
      id: DOMAIN_ID,
      domain: new URL(exactPolicy.target.publicOrigin).hostname,
      targetPort: null,
    }],
    deployment: {
      id: deploymentId,
      projectId: exactPolicy.projectId,
      environmentId: exactPolicy.target.environmentId,
      serviceId: exactPolicy.target.serviceId,
      snapshotId,
      commitHash: candidateSha,
      imageDigest: `sha256:${"b".repeat(64)}`,
      patchId: null,
      providerSource: null,
      providerMessage: null,
      providerMessageField: null,
    },
  };
  return {
    tokenScopeExact: true,
    patchEmpty: true,
    gitAutodeployAbsent: true,
    collateralSha256: crypto.createHash("sha256").update(
      `${exactPolicy.target.environmentId}:collateral`,
    ).digest("hex"),
    configuredTopology: {
      ...configuredTopologyBase,
      configuredTopologySha256: topologySha256(configuredTopologyBase),
    },
    snapshot,
  };
}

function providerSnapshotResponse(
  exactPolicy: PermanentStagingAppDeploymentPolicy,
  environmentConfig: unknown,
  legacyReplicaCount: number | null,
): string {
  const snapshot = providerObservation(
    exactPolicy,
    CANDIDATE_SHA,
    DEPLOYMENT_AFTER,
    SNAPSHOT_AFTER,
    "SUCCESS",
    legacyReplicaCount,
  ).snapshot;
  return JSON.stringify({
    data: {
      environment: {
        id: exactPolicy.target.environmentId,
        config: environmentConfig,
      },
      serviceInstance: {
        id: snapshot.serviceInstanceId,
        serviceId: snapshot.serviceId,
        environmentId: snapshot.environmentId,
        numReplicas: snapshot.numReplicas,
        latestDeployment: snapshot.latestDeployment,
        activeDeployments: snapshot.activeDeployments,
        domains: {
          serviceDomains: snapshot.domains.map(({ kind: _kind, ...domain }) =>
            domain),
          customDomains: [],
        },
      },
      deployment: {
        id: snapshot.deployment.id,
        projectId: snapshot.deployment.projectId,
        environmentId: snapshot.deployment.environmentId,
        serviceId: snapshot.deployment.serviceId,
        snapshotId: snapshot.deployment.snapshotId,
        meta: {
          commitHash: snapshot.deployment.commitHash,
          imageDigest: snapshot.deployment.imageDigest,
          patchId: snapshot.deployment.patchId,
        },
      },
    },
  });
}

function runtimeObservation(
  exactPolicy: PermanentStagingAppDeploymentPolicy,
  candidateSha: string,
  deploymentId: string,
) {
  const response = (
    route: "/health" | "/startup" | "/ready",
    status: "ok" | "startup_ready" | "ready",
  ): ProtectedSourceArchiveRuntimeResponse => ({
    route,
    service: "pint-path",
    status,
    deployment: {
      version: "0.1.0",
      commitSha: "unknown",
      sourceArchive: SOURCE_IDENTITY,
      environment: "production",
      projectIdSha256:
        railwayDeploymentIdentityIdSha256("project", exactPolicy.projectId)!,
      environmentIdSha256: railwayDeploymentIdentityIdSha256(
        "environment",
        exactPolicy.target.environmentId,
      )!,
      serviceIdSha256: railwayDeploymentIdentityIdSha256(
        "service",
        exactPolicy.target.serviceId,
      )!,
      deploymentIdSha256: railwayDeploymentIdentityIdSha256(
        "deployment",
        deploymentId,
      )!,
      replicaIdSha256: crypto.createHash("sha256").update("replica").digest("hex"),
    },
    automaticMaintenance: {
      enabled: exactPolicy.postflightContract.automaticMaintenanceEnabled,
      candidateBound: true,
    },
    restoreMarkerPresent: false,
    responseSha256: crypto.createHash("sha256").update(route).digest("hex"),
  });
  return {
    health: response("/health", "ok"),
    startup: response("/startup", "startup_ready"),
    ready: response("/ready", "ready"),
  };
}

function runtimeResponseSource(
  response: RailwayApplicationDeploymentAttestationRuntimeResponse,
): string {
  return JSON.stringify({
    ok: true,
    data: {
      service: response.service,
      status: response.status,
      deployment: response.deployment,
      automaticMaintenance: response.automaticMaintenance,
      ...(response.route === "/health" ? {} : { dependencies: {} }),
    },
  });
}

function harness(exactPolicy: PermanentStagingAppDeploymentPolicy, options: {
  acknowledgementCode?: number | null;
  acknowledgementTimedOut?: boolean;
  reconciliationSucceeds?: boolean;
  preflightCandidateSha?: string;
  boundaryPostflightPasses?: boolean;
  prerequisiteSucceeds?: boolean;
  writeTokenScopeSucceeds?: boolean;
  terminalDeploymentDrifts?: boolean;
  commandThrows?: boolean;
  pollThrows?: boolean;
  runtimeProbeThrows?: boolean;
  preflightFailureCode?: string;
  preflightGitAutodeployAbsent?: boolean;
  preflightTargetExact?: boolean;
  preflightReplicaCount?: number;
  postflightReplicaCount?: number;
  preflightLegacyReplicaCount?: number | null;
  immediatePrewriteLegacyReplicaCount?: number | null;
  postflightLegacyReplicaCount?: number | null;
  immediatePrewriteConfiguredReplicaCount?: number;
  postflightConfiguredReplicaCount?: number;
  runtimeAbsentStableBeforeWrite?: boolean;
  runtimeAbsentBeforeWrite?: boolean;
  runtimeAbsentPostflight?: boolean;
  workerFenceDeploymentId?: string;
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(
    path.join(os.tmpdir(), "pintpath-app-deploy-test-"),
  ));
  temporaryRoots.push(root);
  const evidenceDir = path.join(root, "evidence");
  const snapshotPath = path.join(root, "snapshot");
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  fs.mkdirSync(snapshotPath, { mode: 0o700 });
  const productionWorkerFenceVerificationFile = path.join(
    evidenceDir,
    "production-deployment-worker-fence-verification.json",
  );
  if (exactPolicy.target.name === "production") {
    fs.writeFileSync(productionWorkerFenceVerificationFile, "{}\n", {
      mode: 0o600,
    });
  }
  const output: string[] = [];
  const preflightCandidateSha = options.preflightCandidateSha ?? "c".repeat(40);
  const preflightReplicaCount = options.preflightReplicaCount
    ?? exactPolicy.target.allowedReplicaCounts[0];
  const postflightReplicaCount = options.postflightReplicaCount
    ?? preflightReplicaCount;
  const defaultLegacyReplicaCount = exactPolicy.fencedDeploymentContract
    ? null
    : preflightReplicaCount;
  const preflightLegacyReplicaCount = options.preflightLegacyReplicaCount
    === undefined
    ? defaultLegacyReplicaCount
    : options.preflightLegacyReplicaCount;
  const immediatePrewriteLegacyReplicaCount =
    options.immediatePrewriteLegacyReplicaCount === undefined
      ? preflightLegacyReplicaCount
      : options.immediatePrewriteLegacyReplicaCount;
  const postflightLegacyReplicaCount = options.postflightLegacyReplicaCount
    === undefined
    ? preflightLegacyReplicaCount
    : options.postflightLegacyReplicaCount;
  const immediatePrewriteConfiguredReplicaCount =
    options.immediatePrewriteConfiguredReplicaCount ?? preflightReplicaCount;
  const postflightConfiguredReplicaCount =
    options.postflightConfiguredReplicaCount ?? postflightReplicaCount;
  const observations = [
    providerObservation(
      exactPolicy,
      preflightCandidateSha,
      DEPLOYMENT_BEFORE,
      SNAPSHOT_BEFORE,
      "SUCCESS",
      preflightLegacyReplicaCount,
      preflightReplicaCount,
    ),
    providerObservation(
      exactPolicy,
      preflightCandidateSha,
      DEPLOYMENT_BEFORE,
      SNAPSHOT_BEFORE,
      "SUCCESS",
      immediatePrewriteLegacyReplicaCount,
      immediatePrewriteConfiguredReplicaCount,
    ),
    providerObservation(
      exactPolicy,
      CANDIDATE_SHA,
      preflightCandidateSha === CANDIDATE_SHA
        ? DEPLOYMENT_BEFORE
        : DEPLOYMENT_AFTER,
      preflightCandidateSha === CANDIDATE_SHA
        ? SNAPSHOT_BEFORE
        : SNAPSHOT_AFTER,
      "SUCCESS",
      immediatePrewriteLegacyReplicaCount,
      immediatePrewriteConfiguredReplicaCount,
    ),
    providerObservation(
      exactPolicy,
      CANDIDATE_SHA,
      preflightCandidateSha === CANDIDATE_SHA
        ? DEPLOYMENT_BEFORE
        : DEPLOYMENT_AFTER,
      preflightCandidateSha === CANDIDATE_SHA
        ? SNAPSHOT_BEFORE
        : SNAPSHOT_AFTER,
      "SUCCESS",
      postflightLegacyReplicaCount,
      postflightConfiguredReplicaCount,
    ),
  ];
  let targetCalls = 0;
  let boundaryCalls = 0;
  let runtimeAbsenceCalls = 0;
  const callOrder: string[] = [];
  const runCommand = vi.fn(async () => {
    callOrder.push("railway-up");
    if (options.commandThrows) throw new Error("injected_command_failure");
    return {
      code: options.acknowledgementCode ?? 0,
      signal: null,
      timedOut: options.acknowledgementTimedOut ?? false,
      stdout: options.acknowledgementTimedOut ? "" : JSON.stringify({
        deploymentId: DEPLOYMENT_AFTER,
        logsUrl: `https://railway.com/project/${exactPolicy.projectId}`,
      }),
      stderr: "",
    };
  });
  const cliAuthority = {
    executablePath: "/reviewed/railway-fd",
    assertExact: vi.fn(() => { callOrder.push("cli-reassert"); }),
    close: vi.fn(),
  };
  const sourceAuthority = {
    candidateSha: CANDIDATE_SHA,
    treeSha: "d".repeat(40),
    archiveSha256: "e".repeat(64),
    sourceArchive: SOURCE_IDENTITY,
    snapshotManifestSha256: "f".repeat(64),
    snapshotPath,
    deploymentPath: snapshotPath,
    close: vi.fn(),
    reassert: vi.fn(() => { callOrder.push("source-reassert"); }),
    cleanup: vi.fn(),
  };
  let nowTick = 0;
  return {
    evidenceDir,
    output,
    runCommand,
    cliAuthority,
    sourceAuthority,
    callOrder,
    overrides: {
      cwd: process.cwd(),
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_REF: "refs/heads/main",
        GITHUB_RUN_ID: PRODUCTION_RUN_ID,
        GITHUB_SHA: CANDIDATE_SHA,
        PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: "p".repeat(32),
        PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: "s".repeat(32),
        PINTPATH_RAILWAY_WRITE_TOKEN: "w".repeat(32),
        ...(exactPolicy.target.name === "production"
          ? {
              PINTPATH_PRODUCTION_DEPLOYMENT_FENCE_RUN_ID:
                PRODUCTION_FENCE_RUN_ID,
              PINTPATH_PRODUCTION_DEPLOYMENT_WORKER_FENCE_VERIFICATION_FILE:
                productionWorkerFenceVerificationFile,
            }
          : {}),
      },
      now: vi.fn(() => {
        const value = new Date(Date.parse("2026-08-13T00:00:00.000Z") + nowTick);
        nowTick += 10_000;
        return value;
      }),
      sleep: vi.fn(async () => {
        if (options.pollThrows) throw new Error("injected_poll_failure");
      }),
      createSourceAuthority: vi.fn(async () => sourceAuthority),
      validateCli: vi.fn(async () => cliAuthority),
      validateWriteToken: vi.fn(async () =>
        options.writeTokenScopeSucceeds !== false),
      validateProductionWorkerFencePrerequisite: vi.fn(() => ({
        candidateSha: CANDIDATE_SHA,
        consumer: { runId: PRODUCTION_RUN_ID },
        workerFence: {
          runId: PRODUCTION_FENCE_RUN_ID,
          bindingSha256: "1".repeat(64),
          terminalSha256: "2".repeat(64),
          deploymentIdSha256: railwayDeploymentIdentityIdSha256(
            "deployment",
            options.workerFenceDeploymentId ?? DEPLOYMENT_BEFORE,
          )!,
        },
      } as unknown as ProductionDeploymentWorkerFencePrerequisiteVerification)),
      runBoundary: vi.fn(async () => {
        boundaryCalls += 1;
        const ok = boundaryCalls === 1 || options.boundaryPostflightPasses !== false;
        return { ok, source: `${JSON.stringify({ outcome: ok ? "passed" : "failed" })}\n` };
      }),
      queryTarget: vi.fn(async (
        inputPolicy: PermanentStagingAppDeploymentPolicy,
        environmentId: string,
        _expectedReplicaCounts: readonly number[],
      ) => {
        if (environmentId !== exactPolicy.target.environmentId) {
          if (options.prerequisiteSucceeds === false) throw new Error("prerequisite");
          return providerObservation(
            {
              ...inputPolicy,
              target: {
                ...inputPolicy.target,
                environmentId,
                allowedReplicaCounts: [1],
              },
            },
            CANDIDATE_SHA,
            DEPLOYMENT_AFTER,
            SNAPSHOT_AFTER,
            "SUCCESS",
            1,
            1,
            [
              { region: "asia-southeast1-eqsg3a", numReplicas: 1 },
              { region: "europe-west4-drams3a", numReplicas: 0 },
            ],
          );
        }
        callOrder.push(`target-query-${targetCalls}`);
        const preflightCall = targetCalls === 0;
        if (preflightCall && options.preflightFailureCode) {
          throw new Error(options.preflightFailureCode);
        }
        const pollCall = preflightCandidateSha !== CANDIDATE_SHA
          && targetCalls === 2;
        const terminalCall = targetCalls >= (
          preflightCandidateSha === CANDIDATE_SHA ? 2 : 3
        );
        const exactValue = options.terminalDeploymentDrifts && terminalCall
          ? providerObservation(
            exactPolicy,
            CANDIDATE_SHA,
            TERMINAL_DRIFT_DEPLOYMENT,
            TERMINAL_DRIFT_SNAPSHOT,
            "SUCCESS",
            postflightLegacyReplicaCount,
            postflightConfiguredReplicaCount,
          )
          : observations[preflightCandidateSha === CANDIDATE_SHA
            ? (targetCalls === 0 ? 0 : targetCalls === 1 ? 1 : 3)
            : Math.min(targetCalls, 3)]!;
        const value = preflightCall
          ? {
            ...exactValue,
            tokenScopeExact: options.preflightTargetExact !== false,
            gitAutodeployAbsent:
              options.preflightGitAutodeployAbsent !== false,
          }
          : exactValue;
        targetCalls += 1;
        if (options.pollThrows && pollCall) {
          throw new Error("injected_poll_observation_failure");
        }
        if (targetCalls > 2 && options.reconciliationSucceeds === false) {
          return providerObservation(
            exactPolicy,
            preflightCandidateSha,
            DEPLOYMENT_BEFORE,
            SNAPSHOT_BEFORE,
            "SUCCESS",
            preflightLegacyReplicaCount,
            preflightReplicaCount,
          );
        }
        return value;
      }),
      probeRuntime: vi.fn(async (
        _origin: string,
        candidateSha: string,
        inputPolicy: PermanentStagingAppDeploymentPolicy,
        environmentId: string,
        deploymentId: string,
      ) => {
        if (options.runtimeProbeThrows) {
          throw new Error("injected_runtime_probe_failure");
        }
        return runtimeObservation(
          {
            ...inputPolicy,
            target: { ...inputPolicy.target, environmentId },
          },
          candidateSha,
          deploymentId,
        );
      }),
      probeRuntimeAbsent: vi.fn(async () => {
        callOrder.push(runtimeAbsenceCalls === 0
          ? "stable-runtime-absence"
          : "postflight-runtime-absence");
        const absent = runtimeAbsenceCalls === 0
          ? options.runtimeAbsentStableBeforeWrite !== false
          : options.runtimeAbsentPostflight !== false;
        runtimeAbsenceCalls += 1;
        return absent;
      }),
      probeRuntimeAbsentImmediately: vi.fn(async () => {
        callOrder.push("immediate-runtime-absence");
        return options.runtimeAbsentBeforeWrite !== false;
      }),
      runCommand,
      writeOutput: (value: string) => output.push(value),
    },
  };
}

describe("bar pilot fresh-source staging deployment", () => {
  const policyPath = "ops/railway/bar-pilot-staging-app-deployment-policy.json";
  function pilotPolicy() {
    const parsed = parsePermanentStagingAppDeploymentPolicy(fs.readFileSync(policyPath, "utf8"));
    if (!parsed) throw new Error("pilot policy invalid");
    return parsed;
  }
  function pilotFixture(options: {
    current?: boolean; oldCandidateVisibleDuringPoll?: boolean; wrongSource?: boolean;
    runningOld?: boolean; drift?: boolean; uncertain?: boolean; wrongNonce?: boolean;
    wrongCandidate?: boolean; missingProvenance?: boolean; acknowledgedOtherId?: boolean;
    acknowledgedOldId?: boolean; wrongIntent?: boolean; explicitPatch?: boolean;
    snapshotMismatch?: boolean; imageDrift?: boolean;
  } = {}) {
    const exactPolicy = pilotPolicy();
    const fixture = harness(exactPolicy, { acknowledgementTimedOut: options.uncertain });
    const beforeId = options.current ? DEPLOYMENT_BEFORE : BAR_PILOT_STOPPED_DEPLOYMENT_ID;
    let calls = 0;
    fixture.overrides.queryTarget.mockImplementation(async () => {
      const before = calls++ < (options.oldCandidateVisibleDuringPoll ? 3 : 2);
      const value = providerObservation(exactPolicy,
        before ? (options.wrongSource ? "d".repeat(40) : options.current ? CANDIDATE_SHA : BAR_PILOT_STOPPED_SOURCE_SHA) : CANDIDATE_SHA,
        before ? beforeId : DEPLOYMENT_AFTER,
        before ? SNAPSHOT_BEFORE : SNAPSHOT_AFTER, "SUCCESS", null);
      if (!before || (options.current && !options.wrongSource)) value.snapshot.deployment.commitHash = null;
      if (!before && options.wrongIntent) {
        value.snapshot.deployment.providerMessage = `pintpath:permanent-staging:${CANDIDATE_SHA}:${"0".repeat(64)}`;
        value.snapshot.deployment.providerMessageField = "observedIntentField";
      }
      if (!before && options.explicitPatch) value.snapshot.deployment.patchId = SNAPSHOT_AFTER;
      if (!before && options.snapshotMismatch) value.snapshot.latestDeployment.snapshotId = SNAPSHOT_BEFORE;
      if (!before && options.imageDrift && calls >= 4) value.snapshot.deployment.imageDigest = `sha256:${"c".repeat(64)}`;
      if (before && !options.current && !options.runningOld) {
        value.snapshot.latestDeployment.deploymentStopped = true;
        value.snapshot.activeDeployments[0]!.deploymentStopped = true;
      }
      if (options.drift && calls === 2) value.collateralSha256 = "f".repeat(64);
      return value;
    });
    if (options.acknowledgedOtherId || options.acknowledgedOldId) {
      fixture.runCommand.mockResolvedValue({
        code: 0, signal: null, timedOut: false, stderr: "",
        stdout: JSON.stringify({
          deploymentId: options.acknowledgedOldId ? beforeId : TERMINAL_DRIFT_DEPLOYMENT,
          logsUrl: `https://railway.com/project/${exactPolicy.projectId}`,
        }),
      });
    }
    if (options.wrongNonce || options.wrongCandidate || options.missingProvenance) {
      fixture.overrides.probeRuntime.mockImplementation(async (
        _origin, candidate, inputPolicy, _environmentId, deploymentId,
      ) => {
        const runtime = structuredClone(runtimeObservation(inputPolicy, candidate, deploymentId));
        for (const response of [runtime.health, runtime.startup, runtime.ready]) {
          if (options.missingProvenance) {
            delete (response.deployment as unknown as Record<string, unknown>).sourceArchive;
          } else {
            const manifest = { ...SOURCE_MANIFEST,
              uploadNonce: options.wrongNonce ? "7".repeat(64) : SOURCE_MANIFEST.uploadNonce,
              candidateSha: options.wrongCandidate ? "c".repeat(40) : CANDIDATE_SHA,
            };
            response.deployment.sourceArchive = {
              ...manifest, sourceIdentitySha256: crypto.createHash("sha256")
                .update(canonicalProtectedSourceArchiveManifest(manifest)).digest("hex"),
            };
          }
        }
        return runtime;
      });
    }
    if (options.current) fixture.overrides.env.PINTPATH_BAR_PILOT_CURRENT_DEPLOYMENT_ID = beforeId;
    return { ...fixture, args: ["--policy", policyPath, "--candidate-sha", CANDIDATE_SHA, "--evidence-dir", fixture.evidenceDir] };
  }
  it("only permits US1 with workers disabled and the current reviewed lockfile", () => {
    const exact = pilotPolicy();
    expect(exact.configuredTopologyContract.solePositiveRegion).toBe("us-west2");
    expect(exact.postflightContract.automaticMaintenanceEnabled).toBe(false);
    expect(exact.postflightContract.runtimeProbeRequired).toBe(true);
    expect(exact.sourceContract.packageLockSha256).toBe(crypto.createHash("sha256").update(fs.readFileSync("package-lock.json")).digest("hex"));
    for (const edit of [
      (p: typeof exact) => { p.postflightContract.automaticMaintenanceEnabled = true; },
      (p: typeof exact) => { p.configuredTopologyContract.solePositiveRegion = "asia-southeast1-eqsg3a"; },
      (p: typeof exact) => { p.target.name = "production"; },
      (p: typeof exact) => { p.sourceContract.packageLockSha256 = "b5bfc2258853ab58dd5749b91ae55d9724620e102fe55e91de31a4599ab9f67b"; },
    ]) {
      const changed = structuredClone(exact); edit(changed);
      expect(parsePermanentStagingAppDeploymentPolicy(JSON.stringify(changed))).toBeNull();
    }
    const legacy = JSON.parse(policySource("permanent-staging"));
    legacy.configuredTopologyContract = exact.configuredTopologyContract;
    expect(parsePermanentStagingAppDeploymentPolicy(JSON.stringify(legacy))).toBeNull();
  });
  it("preserves historical producer authority and refuses its production or regular staging policies", () => {
    expect(crypto.createHash("sha256").update(fs.readFileSync(
      "scripts/lib/permanent-staging-app-deployment-executor.ts")).digest("hex"))
      .toBe("d161a40dc8b2a13cb33ef30687f031f3be44a8b24e8b27d378c07edac1260f65");
    expect(parsePermanentStagingAppDeploymentPolicy(policySource("production"))).toBeNull();
    expect(parsePermanentStagingAppDeploymentPolicy(policySource("permanent-staging"))).toBeNull();
  });
  it("rejects an archive pathname replaced after its no-follow descriptor opens", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pilot-archive-race-")));
    temporaryRoots.push(root);
    const archive = path.join(root, "candidate.tar");
    const bytes = "reviewed candidate archive";
    fs.writeFileSync(archive, bytes, { mode: 0o600 });
    expect(permanentStagingAppDeploymentExecutorInternals.readSourceArchiveSha256(archive))
      .toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    const originalOpen = fs.openSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "openSync").mockImplementation(((filename, flags, mode) => {
      const descriptor = originalOpen(filename, flags, mode);
      if (!swapped && filename === archive && typeof flags === "number"
        && (flags & fs.constants.O_NOFOLLOW) !== 0) {
        swapped = true;
        fs.renameSync(archive, path.join(root, "held.tar"));
        // Identical bytes must not conceal that the pathname names a new inode.
        fs.writeFileSync(archive, bytes, { mode: 0o600 });
      }
      return descriptor;
    }) as typeof fs.openSync);
    expect(() => permanentStagingAppDeploymentExecutorInternals.readSourceArchiveSha256(archive))
      .toThrow("trusted_file_invalid");
    expect(swapped).toBe(true);
  });
  it("uploads fresh source once from the exact stopped predecessor without restarting it", async () => {
    const fixture = pilotFixture();
    expect(await runPermanentStagingAppDeploymentExecutor(fixture.args, fixture.overrides)).toBe(0);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    expect(fixture.runCommand.mock.calls[0]![1][0]).toBe("up");
    expect(fixture.overrides.probeRuntime).toHaveBeenCalledTimes(1);
    expect(fixture.overrides.createSourceAuthority.mock.calls[0]![3]).toBe(pilotPolicy().sourceContract.packageLockSha256);
  });
  it("allows a same-candidate configuration refresh only by another fresh upload", async () => {
    const fixture = pilotFixture({ current: true });
    expect(await runPermanentStagingAppDeploymentExecutor(fixture.args, fixture.overrides)).toBe(0);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    expect(fixture.overrides.queryTarget).toHaveBeenCalledTimes(4);
  });
  it("waits for a new deployment identity when the old same-SHA process remains healthy", async () => {
    const fixture = pilotFixture({ current: true, oldCandidateVisibleDuringPoll: true });
    expect(await runPermanentStagingAppDeploymentExecutor(fixture.args, fixture.overrides)).toBe(0);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    expect(fixture.overrides.queryTarget).toHaveBeenCalledTimes(5);
    expect(fixture.overrides.probeRuntime.mock.calls.at(-1)![4]).toBe(DEPLOYMENT_AFTER);
  });
  it.each([{ runningOld: true }, { wrongSource: true }, { current: true, wrongSource: true }, { drift: true }])(
    "blocks changed predecessor/source/collateral before upload: %j", async (options) => {
      const fixture = pilotFixture(options);
      expect(await runPermanentStagingAppDeploymentExecutor(fixture.args, fixture.overrides)).toBe(1);
      expect(fixture.runCommand).not.toHaveBeenCalled();
    });
  it("only reconciles an uncertain upload and never retries", async () => {
    const fixture = pilotFixture({ uncertain: true });
    expect(await runPermanentStagingAppDeploymentExecutor(fixture.args, fixture.overrides)).toBe(0);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    expect(fixture.overrides.probeRuntime.mock.calls[0]![5]).toEqual(SOURCE_IDENTITY);
    const receipt = JSON.parse(fs.readFileSync(path.join(fixture.evidenceDir, "deployment-receipt.json"), "utf8"));
    expect(receipt.outcome).toBe("reconciled_success");
    expect(receipt.acknowledgement).toBe("missing_or_failed");
  });

  it.each([
    { uncertain: true, wrongNonce: true }, { wrongCandidate: true },
    { missingProvenance: true }, { acknowledgedOtherId: true },
    { acknowledgedOldId: true }, { wrongIntent: true }, { explicitPatch: true },
    { snapshotMismatch: true }, { imageDrift: true },
  ])("rejects mismatched upload provenance after exactly one attempt: %j", async (options) => {
    const fixture = pilotFixture(options);
    expect(await runPermanentStagingAppDeploymentExecutor(fixture.args, fixture.overrides)).toBe(1);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    const receipt = JSON.parse(fs.readFileSync(path.join(fixture.evidenceDir, "deployment-receipt.json"), "utf8"));
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.writeAttempts).toBe(1);
  });

  it("binds the nonce identity and full snapshot digest into the exact upload message", async () => {
    const fixture = pilotFixture();
    expect(await runPermanentStagingAppDeploymentExecutor(fixture.args, fixture.overrides)).toBe(0);
    const intentBytes = fs.readFileSync(path.join(fixture.evidenceDir, "deployment-intent.json"), "utf8");
    const intent = JSON.parse(intentBytes);
    expect(intent.sourceArchive).toEqual(SOURCE_IDENTITY);
    expect(intent.sourceSnapshotManifestSha256).toBe(fixture.sourceAuthority.snapshotManifestSha256);
    const command = fixture.runCommand.mock.calls[0]!;
    expect(command[1].at(-1)).toBe(`pintpath:permanent-staging:${CANDIDATE_SHA}:${crypto.createHash("sha256").update(intentBytes).digest("hex")}`);
    expect(command[2].env).toEqual({ CI: "true", NO_COLOR: "1", RAILWAY_TOKEN: "w".repeat(32) });
  });

  it("parses genuine CLI metadata without inventing Git/source/message fields", () => {
    const exact = pilotPolicy();
    const raw = JSON.parse(providerSnapshotResponse(exact, {
      services: { [exact.target.serviceId]: { deploy: { multiRegionConfig: {
        "us-west2": { numReplicas: 1 },
      } } } },
    }, null));
    const meta = raw.data.deployment.meta;
    delete meta.commitHash; delete meta.patchId;
    meta.cliCaller = "reviewed-cli";
    const parsed = permanentStagingAppDeploymentExecutorInternals.parseProviderSnapshotWithConfiguredTopology(
      JSON.stringify(raw), exact, exact.target.environmentId);
    expect(parsed?.snapshot.deployment).toMatchObject({
      commitHash: null, patchId: null, providerSource: null, providerMessage: null,
      imageDigest: `sha256:${"b".repeat(64)}`,
    });
    for (const bad of [SNAPSHOT_AFTER, false, {}, ""]) {
      meta.patchId = bad;
      expect(permanentStagingAppDeploymentExecutorInternals.parseProviderSnapshotWithConfiguredTopology(
        JSON.stringify(raw), exact, exact.target.environmentId)).toBeNull();
    }
    delete meta.patchId;
    delete meta.imageDigest;
    expect(permanentStagingAppDeploymentExecutorInternals.parseProviderSnapshotWithConfiguredTopology(
      JSON.stringify(raw), exact, exact.target.environmentId)).toBeNull();
  });

  it("only records an actually present, unambiguous intent value regardless of opaque metadata key", () => {
    const exact = pilotPolicy();
    const raw = JSON.parse(providerSnapshotResponse(exact, {}, null));
    const message = `pintpath:permanent-staging:${CANDIDATE_SHA}:${"f".repeat(64)}`;
    raw.data.deployment.meta.actualOpaqueField = message;
    const parse = () => permanentStagingAppDeploymentExecutorInternals.parsePilotProviderSnapshot(
      raw.data.serviceInstance, raw.data.deployment);
    expect(parse()?.deployment).toMatchObject({ providerMessage: message, providerMessageField: "actualOpaqueField" });
    raw.data.deployment.meta.anotherField = message;
    expect(parse()).toBeNull();
  });

  it("materializes distinct immutable upload identities for identical reviewed source bytes", () => {
    const identities = [];
    const finals = [];
    for (let index = 0; index < 2; index += 1) {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pilot-source-nonce-")));
      temporaryRoots.push(root);
      fs.writeFileSync(path.join(root, "app.js"), "reviewed source", { mode: 0o644 });
      const before = permanentStagingAppDeploymentExecutorInternals.snapshotManifestSha256(root);
      const identity = permanentStagingAppDeploymentExecutorInternals.materializeSourceArchiveIdentity(
        root, CANDIDATE_SHA, SOURCE_MANIFEST.treeSha, SOURCE_MANIFEST.sourceArchiveSha256);
      expect(identity.sourceBaseManifestSha256).toBe(before);
      expect(identity.uploadNonce).toMatch(/^[a-f0-9]{64}$/);
      expect(fs.statSync(path.join(root, ".pintpath-source-archive.json")).mode & 0o777).toBe(0o444);
      expect(fs.readFileSync(path.join(root, "app.js"), "utf8")).toBe("reviewed source");
      const final = permanentStagingAppDeploymentExecutorInternals.snapshotManifestSha256(root);
      expect(final).not.toBe(before);
      identities.push(identity); finals.push(final);
      expect(() => permanentStagingAppDeploymentExecutorInternals.materializeSourceArchiveIdentity(
        root, CANDIDATE_SHA, SOURCE_MANIFEST.treeSha, SOURCE_MANIFEST.sourceArchiveSha256)).toThrow();
      fs.writeFileSync(path.join(root, "app.js"), "tampered source");
      expect(permanentStagingAppDeploymentExecutorInternals.snapshotManifestSha256(root)).not.toBe(final);
    }
    expect(identities[0]!.sourceBaseManifestSha256).toBe(identities[1]!.sourceBaseManifestSha256);
    expect(identities[0]!.sourceIdentitySha256).not.toBe(identities[1]!.sourceIdentitySha256);
    expect(finals[0]).not.toBe(finals[1]);
  });
});
