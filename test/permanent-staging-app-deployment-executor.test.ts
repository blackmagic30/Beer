import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
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
} from "../scripts/lib/permanent-staging-app-deployment-executor.js";
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
  const snapshot: RailwayApplicationDeploymentAttestationProviderSnapshot = {
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
  ): RailwayApplicationDeploymentAttestationRuntimeResponse => ({
    route,
    service: "pint-path",
    status,
    deployment: {
      version: "0.1.0",
      commitSha: candidateSha,
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
      enabled: exactPolicy.target.name === "permanent-staging",
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
      stdout: "queued",
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

async function linuxPinnedCliFixture(
  exactPolicy: PermanentStagingAppDeploymentPolicy,
) {
  const root = fs.realpathSync(fs.mkdtempSync(
    path.join(os.tmpdir(), "pintpath-pinned-cli-test-"),
  ));
  temporaryRoots.push(root);
  const cliPath = path.join(root, "railway");
  const archivePath = path.join(root, "railway.tar.gz");
  const trustedBytes = Buffer.from(
    `#!/bin/sh\nprintf 'railway ${exactPolicy.railwayCli.version}\\n'\n`,
    "utf8",
  );
  const maliciousBytes = Buffer.from(
    "#!/bin/sh\nprintf 'malicious railway\\n'\n",
    "utf8",
  );
  const archiveBytes = Buffer.from("trusted-railway-archive\n", "utf8");
  fs.writeFileSync(cliPath, trustedBytes);
  fs.chmodSync(cliPath, 0o500);
  fs.writeFileSync(archivePath, archiveBytes);
  fs.chmodSync(archivePath, 0o400);
  const pinnedPolicy = {
    ...exactPolicy,
    railwayCli: {
      ...exactPolicy.railwayCli,
      archiveSha256: crypto.createHash("sha256").update(archiveBytes).digest("hex"),
      executableSha256:
        crypto.createHash("sha256").update(trustedBytes).digest("hex"),
    },
  } satisfies PermanentStagingAppDeploymentPolicy;
  const versionCommand = vi.fn(async (
    executable: string,
    args: readonly string[],
  ) => {
    expect(args).toEqual(["--version"]);
    expect(executable).toMatch(new RegExp(`^/proc/${process.pid}/fd/[0-9]+$`));
    expect(fs.readFileSync(executable)).toEqual(trustedBytes);
    return {
      code: 0,
      signal: null,
      timedOut: false,
      stdout: `railway ${pinnedPolicy.railwayCli.version}\n`,
      stderr: "",
    };
  });
  const authority = await permanentStagingAppDeploymentExecutorInternals
    .validateCli(pinnedPolicy, {
      platform: "linux",
      arch: pinnedPolicy.railwayCli.architecture,
      env: {
        PINTPATH_RAILWAY_CLI_PATH: cliPath,
        PINTPATH_RAILWAY_CLI_ARCHIVE: archivePath,
      },
      runCommand: versionCommand,
    } as never);
  return {
    authority,
    cliPath,
    maliciousBytes,
    trustedBytes,
    versionCommand,
  };
}

describe("Railway application deployment executor", () => {
  it("pins active staging and production policies, source/config identities, and CLI bytes", () => {
    expect(PERMANENT_STAGING_APP_DEPLOYMENT_POLICY_SCHEMA).toBe(
      "pintpath-railway-application-deployment-policy/v6",
    );
    expect(PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_SCHEMA).toBe(
      "pintpath-railway-application-deployment-executor/v6",
    );
    expect(PERMANENT_STAGING_APP_DEPLOYMENT_EXECUTOR_STATE).toBe(
      "GITHUB_ENVIRONMENT_PROTECTED",
    );
    expect(PERMANENT_STAGING_APP_DEPLOYMENT_LOCK).toMatchObject({
      projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
      serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
      railwayCli: {
        version: "5.32.0",
        archiveSha256:
          "cd69b2ecb556601751165d85ac31a5fbc38cff46397939356df28d2b96a005f5",
        executableSha256:
          "27133cfc20bffc43b2f32c1638fa3c50eefc2f9d2d80301a93de34632ccb7a43",
      },
    });
    const staging = policy("permanent-staging");
    const fencedStaging = parsePermanentStagingAppDeploymentPolicy(
      fencedStagingPolicySource(),
    );
    const production = policy("production");
    expect(fencedStaging).not.toBeNull();
    expect(fencedStaging?.policyId).toBe(
      "pintpath-permanent-staging-fenced-app-source-upload",
    );
    expect(fencedStaging?.postflightContract.automaticMaintenanceEnabled).toBe(false);
    expect(fencedStaging?.postflightContract.runtimeProbeRequired).toBe(false);
    expect(fencedStaging?.target.allowedReplicaCounts).toEqual([0]);
    expect(fencedStaging?.configuredTopologyContract).toEqual({
      authoritativeSource: "environment.config(decryptVariables:false)",
      configuredReplicaCounts: [0],
      allowedConfiguredRegions: [
        "asia-southeast1-eqsg3a",
        "europe-west4-drams3a",
      ],
      solePositiveRegion: null,
      zeroOnlyRegions: [
        "asia-southeast1-eqsg3a",
        "europe-west4-drams3a",
      ],
      legacyReplicaCountRole: "nullable-observation-only",
      immediateProviderReassertionRequired: true,
      postflightProviderReassertionRequired: true,
    });
    expect(staging.target.name).toBe("permanent-staging");
    expect(staging.postflightContract.automaticMaintenanceEnabled).toBe(true);
    expect(staging.postflightContract.runtimeProbeRequired).toBe(true);
    expect(staging.target.allowedReplicaCounts).toEqual([1]);
    expect(staging.configuredTopologyContract).toMatchObject({
      configuredReplicaCounts: [1],
      allowedConfiguredRegions: [
        "asia-southeast1-eqsg3a",
        "europe-west4-drams3a",
      ],
      solePositiveRegion: "asia-southeast1-eqsg3a",
      zeroOnlyRegions: ["europe-west4-drams3a"],
    });
    expect(staging.postflightContract.replicaCountMustMatchPreflight).toBe(true);
    expect(staging.writeContract.topologyMutationAllowed).toBe(false);
    expect(staging.prerequisite).toBeNull();
    expect(staging.providerReadinessContract).toBeNull();
    expect(staging.costContract).toMatchObject({
      policySchema: "pintpath-permanent-staging-cost-policy/v2",
      policySha256:
        "57984ced59fa356baa9c19ac1e5018dad9c52829a6d7cc95a05cbd52112ddf86",
      deploymentMayClaimCostGatePassed: false,
      singleCombinedReceiptRequiredForRelease: true,
      receiptMayAuthorizeDeployment: false,
    });
    expect(production.target.name).toBe("production");
    expect(production.target.allowedReplicaCounts).toEqual([1, 2]);
    expect(production.configuredTopologyContract).toMatchObject({
      configuredReplicaCounts: [1, 2],
      allowedConfiguredRegions: ["asia-southeast1-eqsg3a"],
      solePositiveRegion: "asia-southeast1-eqsg3a",
      zeroOnlyRegions: [],
    });
    expect(production.postflightContract.replicaCountMustMatchPreflight).toBe(true);
    expect(production.writeContract.topologyMutationAllowed).toBe(false);
    expect(production.prerequisite?.sameCandidateRequired).toBe(true);
    expect(production.providerReadinessContract).toMatchObject({
      envelopeSchema: "pintpath-production-provider-readiness-envelope/v2",
      verificationSchema: "pintpath-production-provider-readiness-verification/v2",
      readinessProfile: "production_free_launch",
      maximumAgeSeconds: 86_400,
      candidateBindingRequired: true,
      allChecksPassRequired: true,
    });
    expect(production.target.environmentId).not.toBe(staging.target.environmentId);
    expect(permanentStagingAppDeploymentExecutorInternals
      .RAILWAY_APPLICATION_DEPLOYMENT_SNAPSHOT_QUERY).toContain(
        "config(decryptVariables: false)",
      );
  });

  it("rejects policy byte drift, reordered fields, extra fields, and target substitution", () => {
    const source = policySource("permanent-staging");
    expect(parsePermanentStagingAppDeploymentPolicy(source)).not.toBeNull();
    expect(parsePermanentStagingAppDeploymentPolicy(source.trimEnd())).toBeNull();
    expect(parsePermanentStagingAppDeploymentPolicy(`${source}\n`)).toBeNull();
    expect(parsePermanentStagingAppDeploymentPolicy(
      fencedStagingPolicySource(),
    )).not.toBeNull();
    const value = JSON.parse(source) as Record<string, unknown>;
    const reordered = source.replace(
      /^\{\n  "schemaVersion": ([^\n]+),\n  "policyId": ([^\n]+),/,
      "{\n  \"policyId\": $2,\n  \"schemaVersion\": $1,",
    );
    expect(reordered).not.toBe(source);
    expect(parsePermanentStagingAppDeploymentPolicy(reordered)).toBeNull();
    expect(parsePermanentStagingAppDeploymentPolicy(`${JSON.stringify({
      ...value,
      unknown: true,
    }, null, 2)}\n`)).toBeNull();
    expect(parsePermanentStagingAppDeploymentPolicy(`${JSON.stringify({
      ...value,
      postflightContract: {
        ...(value.postflightContract as Record<string, unknown>),
        automaticMaintenanceEnabled: false,
      },
    }, null, 2)}\n`)).toBeNull();
    const fencedValue = JSON.parse(fencedStagingPolicySource()) as
      Record<string, unknown>;
    expect(parsePermanentStagingAppDeploymentPolicy(`${JSON.stringify({
      ...fencedValue,
      postflightContract: {
        ...(fencedValue.postflightContract as Record<string, unknown>),
        automaticMaintenanceEnabled: true,
      },
    }, null, 2)}\n`)).toBeNull();
    const target = value.target as Record<string, unknown>;
    expect(parsePermanentStagingAppDeploymentPolicy(`${JSON.stringify({
      ...value,
      target: { ...target, environmentId: policy("production").target.environmentId },
    }, null, 2)}\n`)).toBeNull();

    const productionValue = JSON.parse(policySource("production")) as
      Record<string, unknown>;
    expect(parsePermanentStagingAppDeploymentPolicy(`${JSON.stringify({
      ...productionValue,
      target: {
        ...(productionValue.target as Record<string, unknown>),
        allowedReplicaCounts: [1],
      },
    }, null, 2)}\n`)).toBeNull();
    expect(parsePermanentStagingAppDeploymentPolicy(`${JSON.stringify({
      ...value,
      target: { ...target, allowedReplicaCounts: [1, 2] },
    }, null, 2)}\n`)).toBeNull();
    expect(parsePermanentStagingAppDeploymentPolicy(`${JSON.stringify({
      ...productionValue,
      postflightContract: {
        ...(productionValue.postflightContract as Record<string, unknown>),
        replicaCountMustMatchPreflight: false,
      },
    }, null, 2)}\n`)).toBeNull();
  });

  it("requires an explicit configured topology while retaining legacy null", () => {
    const exactPolicy = parsePermanentStagingAppDeploymentPolicy(
      fencedStagingPolicySource(),
    );
    if (!exactPolicy) throw new Error("fenced_fixture_policy_invalid");
    const config = (multiRegionConfig: unknown) => ({
      services: {
        [exactPolicy.target.serviceId]: {
          deploy: { multiRegionConfig },
        },
      },
    });
    const parsed = permanentStagingAppDeploymentExecutorInternals
      .parseProviderSnapshotWithConfiguredTopology(
        providerSnapshotResponse(exactPolicy, config({
          "asia-southeast1-eqsg3a": { numReplicas: 0 },
          "europe-west4-drams3a": { numReplicas: 0 },
        }), null),
        exactPolicy,
        exactPolicy.target.environmentId,
      );

    expect(parsed).toMatchObject({
      snapshot: { numReplicas: null },
      configuredTopology: {
        configuredReplicas: 0,
        configuredRegions: [
          { region: "asia-southeast1-eqsg3a", numReplicas: 0 },
          { region: "europe-west4-drams3a", numReplicas: 0 },
        ],
      },
    });
    expect(permanentStagingAppDeploymentExecutorInternals
      .parseProviderSnapshotWithConfiguredTopology(
        providerSnapshotResponse(exactPolicy, config(null), null),
        exactPolicy,
        exactPolicy.target.environmentId,
      )).toBeNull();
    expect(permanentStagingAppDeploymentExecutorInternals
      .parseProviderSnapshotWithConfiguredTopology(
        providerSnapshotResponse(exactPolicy, {}, null),
        exactPolicy,
        exactPolicy.target.environmentId,
      )).toBeNull();
  });

  it("proves fenced runtime absence only with repeated exact 404 responses", async () => {
    const sleep = vi.fn(async () => undefined);
    const absentFetch = vi.fn(async () => new Response(null, { status: 404 }));

    await expect(permanentStagingAppDeploymentExecutorInternals
      .defaultProbeRuntimeAbsent(
        absentFetch as unknown as typeof fetch,
        sleep,
        "https://beer-staging.up.railway.app",
      )).resolves.toBe(true);
    expect(absentFetch).toHaveBeenCalledTimes(9);
    expect(sleep).toHaveBeenCalledTimes(2);

    const liveFetch = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(permanentStagingAppDeploymentExecutorInternals
      .defaultProbeRuntimeAbsent(
        liveFetch as unknown as typeof fetch,
        sleep,
        "https://beer-staging.up.railway.app",
      )).resolves.toBe(false);
    expect(liveFetch).toHaveBeenCalledTimes(1);

    const uncertainFetch = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await expect(permanentStagingAppDeploymentExecutorInternals
      .defaultProbeRuntimeAbsent(
        uncertainFetch as unknown as typeof fetch,
        sleep,
        "https://beer-staging.up.railway.app",
      )).resolves.toBe(false);
  });

  it("performs one upload and emits SHA-bound route evidence after reconciliation", async () => {
    const exactPolicy = policy("permanent-staging");
    const fixture = harness(exactPolicy);
    const code = await runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides);
    expect(code).toBe(0);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    expect(fixture.runCommand.mock.calls[0]![0]).toBe(
      fixture.cliAuthority.executablePath,
    );
    expect(fixture.cliAuthority.assertExact).toHaveBeenCalledTimes(3);
    expect(fixture.cliAuthority.close).toHaveBeenCalledTimes(1);
    expect(fixture.sourceAuthority.reassert).toHaveBeenCalledTimes(3);
    expect(fixture.sourceAuthority.close).toHaveBeenCalledTimes(1);
    expect(fixture.overrides.queryTarget).toHaveBeenCalledTimes(4);
    const argv = fixture.runCommand.mock.calls[0]![1] as readonly string[];
    expect(argv).toEqual([
      "up",
      expect.stringContaining("snapshot"),
      "--path-as-root",
      "--no-gitignore",
      "--detach",
      "--json",
      "--project",
      exactPolicy.projectId,
      "--environment",
      exactPolicy.target.environmentId,
      "--service",
      exactPolicy.target.serviceId,
      "--message",
      expect.stringMatching(new RegExp(`^pintpath:permanent-staging:${CANDIDATE_SHA}:[a-f0-9]{64}$`)),
    ]);
    expect((fixture.runCommand.mock.calls[0]![2] as { env: Record<string, string> }).env)
      .toEqual({ CI: "true", NO_COLOR: "1", RAILWAY_TOKEN: "w".repeat(32) });
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      target: "permanent-staging",
      outcome: "deployed",
      failureCode: null,
      candidateSha: CANDIDATE_SHA,
      writeAttempts: 1,
      acknowledgement: "received",
      replicaCounts: { before: 1, after: 1 },
      checks: {
        boundaryPreflightExact: true,
        boundaryPostflightExact: true,
        targetPostflightAttempted: true,
        targetPostflightExact: true,
        topologyPreserved: true,
        deploymentExact: true,
        runtimeHealthExact: true,
        runtimeStartupExact: true,
        runtimeReadinessExact: true,
        terminalEvidenceExact: true,
      },
    });
    expect(fs.readdirSync(fixture.evidenceDir).sort()).toEqual([
      "deployment-intent.json",
      "deployment-receipt.json",
      "railway-boundary-postflight.json",
      "railway-boundary-preflight.json",
    ]);
  });

  it("uploads the fenced candidate at zero replicas without claiming runtime evidence", async () => {
    const exactPolicy = parsePermanentStagingAppDeploymentPolicy(
      fencedStagingPolicySource(),
    );
    if (!exactPolicy) throw new Error("fenced_fixture_policy_invalid");
    const fixture = harness(exactPolicy);
    const code = await runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-fenced-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides);

    expect(code).toBe(0);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    expect(fixture.overrides.probeRuntime).not.toHaveBeenCalled();
    expect(fixture.overrides.probeRuntimeAbsent).toHaveBeenCalledTimes(2);
    expect(fixture.overrides.probeRuntimeAbsentImmediately).toHaveBeenCalledOnce();
    const stableAbsence = fixture.callOrder.indexOf("stable-runtime-absence");
    const finalTopology = fixture.callOrder.indexOf("target-query-1");
    const upload = fixture.callOrder.indexOf("railway-up");
    expect(stableAbsence).toBeGreaterThanOrEqual(0);
    expect(finalTopology).toBeGreaterThan(stableAbsence);
    expect(fixture.callOrder.slice(upload - 3, upload + 1)).toEqual([
      "immediate-runtime-absence",
      "source-reassert",
      "cli-reassert",
      "railway-up",
    ]);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      target: "permanent-staging",
      outcome: "deployed",
      candidateSha: CANDIDATE_SHA,
      replicaCounts: { before: 0, after: 0 },
      legacyReplicaCounts: {
        before: null,
        immediatelyBeforeWrite: null,
        after: null,
      },
      runtimeAbsence: {
        required: true,
        immediatelyBeforeWrite: true,
        postflight: true,
      },
      runtimeResponseSha256s: {
        health: null,
        startup: null,
        ready: null,
      },
      checks: {
        topologyPreserved: true,
        deploymentExact: true,
        runtimeHealthExact: true,
        runtimeStartupExact: true,
        runtimeReadinessExact: true,
        configuredTopologyExact: true,
        immediatePrewriteExact: true,
        fencedRuntimeAbsentBeforeWrite: true,
        fencedRuntimeAbsentPostflight: true,
        terminalEvidenceExact: true,
      },
    });
  });

  it("blocks the fenced upload when configured topology drifts immediately before write", async () => {
    const exactPolicy = parsePermanentStagingAppDeploymentPolicy(
      fencedStagingPolicySource(),
    );
    if (!exactPolicy) throw new Error("fenced_fixture_policy_invalid");
    const fixture = harness(exactPolicy, {
      immediatePrewriteConfiguredReplicaCount: 1,
    });

    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-fenced-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);

    expect(fixture.runCommand).not.toHaveBeenCalled();
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      outcome: "blocked",
      failureCode: "immediate_prewrite_failed",
      writeAttempts: 0,
      configuredTopology: {
        before: { configuredReplicas: 0 },
        immediatelyBeforeWrite: { configuredReplicas: 1 },
      },
      checks: {
        fencedRuntimeAbsentBeforeWrite: false,
        immediatePrewriteExact: false,
      },
    });
  });

  it("blocks the fenced upload unless runtime absence is proven before write", async () => {
    const exactPolicy = parsePermanentStagingAppDeploymentPolicy(
      fencedStagingPolicySource(),
    );
    if (!exactPolicy) throw new Error("fenced_fixture_policy_invalid");
    const fixture = harness(exactPolicy, { runtimeAbsentBeforeWrite: false });

    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-fenced-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);

    expect(fixture.runCommand).not.toHaveBeenCalled();
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      outcome: "blocked",
      failureCode: "fenced_runtime_present",
      writeAttempts: 0,
      runtimeAbsence: {
        required: true,
        immediatelyBeforeWrite: false,
      },
      checks: {
        fencedRuntimeAbsentBeforeWrite: false,
        immediatePrewriteExact: true,
      },
    });
  });

  it("keeps a fenced upload non-green when configured topology drifts postflight", async () => {
    const exactPolicy = parsePermanentStagingAppDeploymentPolicy(
      fencedStagingPolicySource(),
    );
    if (!exactPolicy) throw new Error("fenced_fixture_policy_invalid");
    const fixture = harness(exactPolicy, { postflightConfiguredReplicaCount: 1 });

    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-fenced-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);

    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      outcome: "mutation_uncertain",
      writeAttempts: 1,
      configuredTopology: {
        before: { configuredReplicas: 0 },
        after: { configuredReplicas: 1 },
      },
      checks: {
        topologyPreserved: false,
        targetPostflightExact: false,
      },
    });
  });

  it("keeps a fenced upload non-green unless runtime remains absent postflight", async () => {
    const exactPolicy = parsePermanentStagingAppDeploymentPolicy(
      fencedStagingPolicySource(),
    );
    if (!exactPolicy) throw new Error("fenced_fixture_policy_invalid");
    const fixture = harness(exactPolicy, { runtimeAbsentPostflight: false });

    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-fenced-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);

    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      outcome: "mutation_uncertain",
      writeAttempts: 1,
      runtimeAbsence: {
        required: true,
        immediatelyBeforeWrite: true,
        postflight: false,
      },
      checks: {
        fencedRuntimeAbsentBeforeWrite: true,
        fencedRuntimeAbsentPostflight: false,
        targetPostflightExact: false,
      },
    });
  });

  it.each([
    ["initial launch", 1],
    ["evidence closeout", 2],
  ] as const)("preserves the exact healthy production topology during %s", async (
    _phase,
    replicaCount,
  ) => {
    const exactPolicy = policy("production");
    const fixture = harness(exactPolicy, { preflightReplicaCount: replicaCount });
    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/production-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(0);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    const targetReplicaExpectations = fixture.overrides.queryTarget.mock.calls
      .filter((call) => call[1] === exactPolicy.target.environmentId)
      .map((call) => call[2]);
    expect(targetReplicaExpectations).toEqual([
      [1, 2],
      [replicaCount],
      [replicaCount],
      [replicaCount],
    ]);
    const intent = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-intent.json"),
      "utf8",
    ));
    expect(intent).toMatchObject({
      schemaVersion: "pintpath-railway-application-deployment-intent/v3",
      preservedReplicaCount: replicaCount,
      configuredTopology: {
        authoritativeSource: "environment.config(decryptVariables:false)",
        immediatelyBeforeWriteRequired: true,
      },
      workerFencePrerequisite: {
        runId: PRODUCTION_FENCE_RUN_ID,
        verificationSha256: crypto.createHash("sha256").update("{}\n").digest("hex"),
        bindingSha256: "1".repeat(64),
        terminalSha256: "2".repeat(64),
        deploymentIdSha256: railwayDeploymentIdentityIdSha256(
          "deployment",
          DEPLOYMENT_BEFORE,
        ),
      },
    });
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      target: "production",
      outcome: "deployed",
      replicaCounts: { before: replicaCount, after: replicaCount },
      checks: {
        workerFencePrerequisiteExact: true,
        workerFenceDeploymentContinuityExact: true,
        topologyPreserved: true,
        targetPostflightExact: true,
      },
      workerFencePrerequisite: {
        runId: PRODUCTION_FENCE_RUN_ID,
      },
    });
  });

  it("uses the observed environment topology contract for the production staging prerequisite", () => {
    const production = policy("production");
    const staging = policy("permanent-staging");
    const stagingTopology = providerObservation(
      production,
      CANDIDATE_SHA,
      DEPLOYMENT_AFTER,
      SNAPSHOT_AFTER,
      "SUCCESS",
      null,
      1,
      [
        { region: "asia-southeast1-eqsg3a", numReplicas: 1 },
        { region: "europe-west4-drams3a", numReplicas: 0 },
      ],
    ).configuredTopology;

    expect(permanentStagingAppDeploymentExecutorInternals
      .configuredTopologyAllowed(production, stagingTopology, [1])).toBe(false);
    expect(permanentStagingAppDeploymentExecutorInternals
      .configuredTopologyAllowed(
        production,
        stagingTopology,
        [1],
        staging.target.environmentId,
      )).toBe(true);
  });

  it("uses active-staging runtime semantics for the production prerequisite", async () => {
    const production = policy("production");
    const staging = policy("permanent-staging");
    const stagingRuntime = runtimeObservation(
      staging,
      CANDIDATE_SHA,
      DEPLOYMENT_AFTER,
    );
    const exactResponses = [
      stagingRuntime.health,
      stagingRuntime.startup,
      stagingRuntime.ready,
    ];
    const exactFetch = vi.fn(async () => new Response(
      runtimeResponseSource(exactResponses.shift()!),
      { status: 200 },
    ));

    await expect(permanentStagingAppDeploymentExecutorInternals
      .defaultProbeRuntime(
        exactFetch as unknown as typeof fetch,
        staging.target.publicOrigin,
        CANDIDATE_SHA,
        production,
        staging.target.environmentId,
        DEPLOYMENT_AFTER,
      )).resolves.toMatchObject({
        health: { automaticMaintenance: { enabled: true } },
        startup: { automaticMaintenance: { enabled: true } },
        ready: { automaticMaintenance: { enabled: true } },
      });

    const disabledRuntime = runtimeObservation(
      production,
      CANDIDATE_SHA,
      DEPLOYMENT_AFTER,
    ).health;
    const disabledForStaging = {
      ...disabledRuntime,
      deployment: {
        ...disabledRuntime.deployment,
        environmentIdSha256: railwayDeploymentIdentityIdSha256(
          "environment",
          staging.target.environmentId,
        )!,
      },
    };
    const disabledFetch = vi.fn(async () => new Response(
      runtimeResponseSource(disabledForStaging),
      { status: 200 },
    ));
    await expect(permanentStagingAppDeploymentExecutorInternals
      .defaultProbeRuntime(
        disabledFetch as unknown as typeof fetch,
        staging.target.publicOrigin,
        CANDIDATE_SHA,
        production,
        staging.target.environmentId,
        DEPLOYMENT_AFTER,
      )).rejects.toThrow("runtime_probe_failed");
  });

  it("treats legacy replica counts as nullable observation on healthy paths", async () => {
    const exactPolicy = policy("permanent-staging");
    const fixture = harness(exactPolicy, {
      preflightLegacyReplicaCount: null,
      immediatePrewriteLegacyReplicaCount: 50,
      postflightLegacyReplicaCount: 0,
    });

    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(0);

    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      outcome: "deployed",
      replicaCounts: { before: 1, after: 1 },
      legacyReplicaCounts: {
        before: null,
        immediatelyBeforeWrite: 50,
        after: 0,
      },
    });
  });

  it("fails closed when a production upload changes the preflight replica count", async () => {
    const exactPolicy = policy("production");
    const fixture = harness(exactPolicy, {
      preflightReplicaCount: 2,
      postflightReplicaCount: 1,
    });
    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/production-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      outcome: "mutation_uncertain",
      replicaCounts: { before: 2, after: 1 },
      checks: {
        topologyPreserved: false,
        targetPostflightExact: false,
      },
    });
  });

  it("blocks production before source upload when the fenced deployment changed", async () => {
    const exactPolicy = policy("production");
    const fixture = harness(exactPolicy, {
      workerFenceDeploymentId: TERMINAL_DRIFT_DEPLOYMENT,
    });
    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/production-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);
    expect(fixture.runCommand).not.toHaveBeenCalled();
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      outcome: "blocked",
      failureCode: "worker_fence_prerequisite_failed",
      checks: {
        workerFencePrerequisiteExact: true,
        workerFenceDeploymentContinuityExact: false,
      },
    });
  });

  it("fails closed when the worker-fence prerequisite pathname is replaced after inspection", async () => {
    const exactPolicy = policy("production");
    const fixture = harness(exactPolicy);
    const prerequisite = path.join(
      fixture.evidenceDir,
      "production-deployment-worker-fence-verification.json",
    );
    const displaced = `${prerequisite}.displaced`;
    const originalLstat = fs.lstatSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "lstatSync").mockImplementation(((filename, options) => {
      const stat = originalLstat(filename, options as never);
      if (!replaced && filename === prerequisite) {
        replaced = true;
        fs.renameSync(prerequisite, displaced);
        fs.writeFileSync(prerequisite, "{\"forged\":true}\n", { mode: 0o600 });
      }
      return stat;
    }) as typeof fs.lstatSync);

    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/production-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);

    expect(replaced).toBe(true);
    expect(fixture.overrides.validateProductionWorkerFencePrerequisite)
      .not.toHaveBeenCalled();
    expect(fixture.runCommand).not.toHaveBeenCalled();
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      outcome: "blocked",
      failureCode: "worker_fence_prerequisite_failed",
      writeAttempts: 0,
      checks: { workerFencePrerequisiteExact: false },
    });
  });

  it("rejects a multiply linked worker-fence prerequisite before validation or upload", async () => {
    const exactPolicy = policy("production");
    const fixture = harness(exactPolicy);
    const prerequisite = path.join(
      fixture.evidenceDir,
      "production-deployment-worker-fence-verification.json",
    );
    fs.linkSync(prerequisite, `${prerequisite}.alias`);

    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/production-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);

    expect(fixture.overrides.validateProductionWorkerFencePrerequisite)
      .not.toHaveBeenCalled();
    expect(fixture.runCommand).not.toHaveBeenCalled();
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      outcome: "blocked",
      failureCode: "worker_fence_prerequisite_failed",
      writeAttempts: 0,
      checks: { workerFencePrerequisiteExact: false },
    });
  });

  it.each([
    ["permanent-staging", 2],
    ["production", 3],
  ] as const)("blocks %s before upload at an unauthorized replica count", async (
    target,
    replicaCount,
  ) => {
    const exactPolicy = policy(target);
    const fixture = harness(exactPolicy, { preflightReplicaCount: replicaCount });
    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy",
      target === "production"
        ? "ops/railway/production-app-deployment-policy.json"
        : "ops/railway/permanent-staging-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);
    expect(fixture.runCommand).not.toHaveBeenCalled();
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt.outcome).toBe("blocked");
    expect(receipt.checks.targetPreflightExact).toBe(false);
  });

  it.each([
    [
      "provider query failure",
      { preflightFailureCode: "provider_query_failed" },
      "provider_query_failed",
    ],
    [
      "provider target mismatch",
      { preflightFailureCode: "provider_target_mismatch" },
      "provider_target_mismatch",
    ],
    [
      "target preflight failure",
      { preflightTargetExact: false },
      "target_preflight_failed",
    ],
    [
      "active Git autodeploy",
      { preflightGitAutodeployAbsent: false },
      "git_autodeploy_active",
    ],
    [
      "unrecognized provider detail",
      { preflightFailureCode: "provider leaked detail: do not retain" },
      "unexpected_failure",
    ],
  ] as const)("emits only the bounded safe failure code for %s", async (
    _label,
    options,
    expectedFailureCode,
  ) => {
    const exactPolicy = policy("permanent-staging");
    const fixture = harness(exactPolicy, options);
    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);
    expect(fixture.runCommand).not.toHaveBeenCalled();
    const receiptSource = fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    );
    const receipt = JSON.parse(receiptSource);
    expect(receipt).toMatchObject({
      outcome: "blocked",
      failureCode: expectedFailureCode,
      writeAttempts: 0,
    });
    expect(JSON.parse(fixture.output.at(-1)!)).toMatchObject({
      ok: false,
      outcome: "blocked",
      failureCode: expectedFailureCode,
    });
    expect(receiptSource).not.toContain("provider leaked detail");
  });

  it("reconciles a successful provider mutation when the CLI acknowledgement is missing", async () => {
    const exactPolicy = policy("permanent-staging");
    const fixture = harness(exactPolicy, {
      acknowledgementCode: null,
      acknowledgementTimedOut: true,
    });
    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(0);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt.outcome).toBe("reconciled_success");
    expect(receipt.acknowledgement).toBe("missing_or_failed");
    expect(receipt.writeAttempts).toBe(1);
  });

  it("never retries an uncertain upload and exits nonzero after bounded reconciliation", async () => {
    const exactPolicy = policy("permanent-staging");
    const fixture = harness(exactPolicy, {
      acknowledgementCode: null,
      acknowledgementTimedOut: true,
      reconciliationSucceeds: false,
    });
    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.writeAttempts).toBe(1);
    expect(receipt.checks.targetPostflightAttempted).toBe(true);
    expect(receipt.checks.targetPostflightExact).toBe(false);
    expect(receipt.checks.reconciliationCompleted).toBe(true);
  });

  it("rejects provider deployment drift after the SHA-bound runtime probes", async () => {
    const exactPolicy = policy("permanent-staging");
    const fixture = harness(exactPolicy, { terminalDeploymentDrifts: true });
    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.reconciliationCompleted).toBe(true);
    expect(receipt.checks.targetPostflightAttempted).toBe(true);
    expect(receipt.checks.targetPostflightExact).toBe(false);
    expect(receipt.checks.terminalEvidenceExact).toBe(true);
  });

  it.each([
    ["thrown CLI", { commandThrows: true }],
    ["thrown poll", { pollThrows: true }],
    ["thrown runtime probe", { runtimeProbeThrows: true }],
  ])("always observes the target after an attempted write with a %s failure", async (
    _label,
    options,
  ) => {
    const exactPolicy = policy("permanent-staging");
    const fixture = harness(exactPolicy, options);
    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    expect(fixture.overrides.queryTarget).toHaveBeenCalledTimes(
      options.commandThrows ? 3 : 4,
    );
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      outcome: "mutation_uncertain",
      writeAttempts: 1,
      checks: {
        targetPostflightAttempted: true,
        targetPostflightExact: true,
        reconciliationCompleted: true,
        boundaryPostflightExact: true,
        terminalEvidenceExact: true,
      },
    });
  });

  it("is idempotent only when the exact candidate is already healthy", async () => {
    const exactPolicy = policy("permanent-staging");
    const fixture = harness(exactPolicy, { preflightCandidateSha: CANDIDATE_SHA });
    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(0);
    expect(fixture.runCommand).not.toHaveBeenCalled();
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt.outcome).toBe("already_deployed");
    expect(receipt.writeAttempts).toBe(0);
  });

  it("blocks production before any write unless the same candidate is healthy in staging", async () => {
    const exactPolicy = policy("production");
    const fixture = harness(exactPolicy, { prerequisiteSucceeds: false });
    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/production-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);
    expect(fixture.runCommand).not.toHaveBeenCalled();
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt.outcome).toBe("blocked");
    expect(receipt.checks.prerequisiteExact).toBe(false);
  });

  it("blocks before mutation when the write token is not scoped to the exact target", async () => {
    const exactPolicy = policy("permanent-staging");
    const fixture = harness(exactPolicy, { writeTokenScopeSucceeds: false });
    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);
    expect(fixture.runCommand).not.toHaveBeenCalled();
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt.outcome).toBe("blocked");
    expect(receipt.checks.writeTokenScopeExact).toBe(false);
  });

  it("fails the terminal outcome if the unconditional mutation-boundary postflight fails", async () => {
    const exactPolicy = policy("permanent-staging");
    const fixture = harness(exactPolicy, { boundaryPostflightPasses: false });
    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);
    expect(fixture.runCommand).toHaveBeenCalledTimes(1);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.boundaryPostflightExact).toBe(false);
  });

  it("hashes complete collateral inventory and detects Git autodeploy", () => {
    const exactPolicy = policy("permanent-staging");
    const collateral = (repo: string | null) => JSON.stringify({
      data: {
        environment: {
          id: exactPolicy.target.environmentId,
          variables: {
            edges: [{
              node: {
                id: "variable-database-url",
                name: "DATABASE_URL",
                environmentId: exactPolicy.target.environmentId,
                serviceId: exactPolicy.target.serviceId,
                isSealed: true,
                references: [],
              },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          volumeInstances: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          serviceInstances: {
            edges: [{
              node: {
                id: INSTANCE_ID,
                serviceId: exactPolicy.target.serviceId,
                serviceName: "Beer",
                environmentId: exactPolicy.target.environmentId,
                numReplicas: 1,
                source: { repo, image: null },
                domains: {
                  serviceDomains: [{
                    id: DOMAIN_ID,
                    domain: new URL(exactPolicy.target.publicOrigin).hostname,
                    targetPort: null,
                  }],
                  customDomains: [],
                },
                cronSchedule: null,
                startCommand: "node dist/src/server.js",
              },
            }, {
              node: {
                id: "77777777-7777-4777-8777-777777777779",
                serviceId: "88888888-8888-4888-8888-888888888889",
                serviceName: "stopped-helper",
                environmentId: exactPolicy.target.environmentId,
                numReplicas: null,
                source: null,
                domains: { serviceDomains: [], customDomains: [] },
                cronSchedule: null,
                startCommand: null,
              },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    const localUpload = permanentStagingAppDeploymentExecutorInternals
      .parseCollateralSnapshot(
        collateral(null),
        exactPolicy.target.environmentId,
        exactPolicy.target.serviceId,
      );
    expect(localUpload).toMatchObject({ gitAutodeployAbsent: true });
    expect(localUpload?.collateralSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(permanentStagingAppDeploymentExecutorInternals.parseCollateralSnapshot(
      collateral("blackmagic30/Beer"),
      exactPolicy.target.environmentId,
      exactPolicy.target.serviceId,
    )).toMatchObject({ gitAutodeployAbsent: false });
    const parsedGitSource = permanentStagingAppDeploymentExecutorInternals
      .parseCollateralSnapshot(
        collateral("blackmagic30/Beer"),
        exactPolicy.target.environmentId,
        exactPolicy.target.serviceId,
      );
    expect(permanentStagingAppDeploymentExecutorInternals
      .validatedProviderObservation(
        exactPolicy,
        exactPolicy.target.environmentId,
        exactPolicy.target.allowedReplicaCounts,
        exactPolicy.target.publicOrigin,
        {
          projectId: exactPolicy.projectId,
          environmentId: exactPolicy.target.environmentId,
        },
        { environmentId: exactPolicy.target.environmentId, patchEmpty: true },
        providerObservation(
          exactPolicy,
          CANDIDATE_SHA,
          DEPLOYMENT_AFTER,
          SNAPSHOT_AFTER,
        ).snapshot,
        providerObservation(
          exactPolicy,
          CANDIDATE_SHA,
          DEPLOYMENT_AFTER,
          SNAPSHOT_AFTER,
        ).configuredTopology,
        parsedGitSource,
      )).toMatchObject({ gitAutodeployAbsent: false });
    const paginated = collateral(null).replace(
      '"hasNextPage":false',
      '"hasNextPage":true',
    );
    expect(permanentStagingAppDeploymentExecutorInternals.parseCollateralSnapshot(
      paginated,
      exactPolicy.target.environmentId,
      exactPolicy.target.serviceId,
    )).toBeNull();
  });

  it("paginates every collateral connection without dropping stopped services", async () => {
    const exactPolicy = policy("permanent-staging");
    const pages = [
      {
        variables: {
          edges: [{ node: {
            id: "variable-one",
            name: "DATABASE_URL",
            environmentId: exactPolicy.target.environmentId,
            serviceId: exactPolicy.target.serviceId,
            isSealed: true,
            references: [],
          } }],
          pageInfo: { hasNextPage: true, endCursor: "variables-page-one" },
        },
        volumeInstances: {
          edges: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        serviceInstances: {
          edges: [{ node: {
            id: INSTANCE_ID,
            serviceId: exactPolicy.target.serviceId,
            serviceName: "Beer",
            environmentId: exactPolicy.target.environmentId,
            numReplicas: 1,
            source: null,
            domains: {
              serviceDomains: [{
                id: DOMAIN_ID,
                domain: new URL(exactPolicy.target.publicOrigin).hostname,
                targetPort: 8080,
              }],
              customDomains: [],
            },
            cronSchedule: null,
            startCommand: "node dist/src/server.js",
          } }, { node: {
            id: "77777777-7777-4777-8777-777777777779",
            serviceId: "88888888-8888-4888-8888-888888888889",
            serviceName: "stopped-helper",
            environmentId: exactPolicy.target.environmentId,
            numReplicas: null,
            source: null,
            domains: { serviceDomains: [], customDomains: [] },
            cronSchedule: null,
            startCommand: null,
          } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
      {
        variables: {
          edges: [{ node: {
            id: "variable-two",
            name: "REDIS_URL",
            environmentId: exactPolicy.target.environmentId,
            serviceId: exactPolicy.target.serviceId,
            isSealed: true,
            references: [],
          } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        volumeInstances: {
          edges: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        serviceInstances: {
          edges: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ];
    const requests: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const page = pages[requests.length - 1];
      return new Response(JSON.stringify({
        data: {
          environment: { id: exactPolicy.target.environmentId, ...page },
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const source = await permanentStagingAppDeploymentExecutorInternals
      .queryCollateralSnapshot(
        fetchImpl,
        "t".repeat(32),
        exactPolicy.projectId,
        exactPolicy.target.environmentId,
      );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requests).toMatchObject([
      { variables: { variablesAfter: null } },
      { variables: { variablesAfter: "variables-page-one" } },
    ]);
    expect(permanentStagingAppDeploymentExecutorInternals.parseCollateralSnapshot(
      source,
      exactPolicy.target.environmentId,
      exactPolicy.target.serviceId,
    )).toMatchObject({ gitAutodeployAbsent: true });
  });

  it("accepts nested source directories and rejects multiply linked files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pintpath-source-manifest-"));
    temporaryRoots.push(root);
    const nested = path.join(root, "src", "nested");
    fs.mkdirSync(nested, { recursive: true });
    const source = path.join(nested, "server.ts");
    fs.writeFileSync(source, "export const ok = true;\n", { mode: 0o644 });

    expect(permanentStagingAppDeploymentExecutorInternals
      .snapshotManifestSha256(root)).toMatch(/^[a-f0-9]{64}$/);

    fs.linkSync(source, path.join(root, "duplicate.ts"));
    expect(() => permanentStagingAppDeploymentExecutorInternals
      .snapshotManifestSha256(root)).toThrow("source_snapshot_invalid");
  });

  it("rejects a snapshot leaf replaced after O_NOFOLLOW open", () => {
    const root = fs.realpathSync(fs.mkdtempSync(
      path.join(os.tmpdir(), "pintpath-source-open-race-"),
    ));
    temporaryRoots.push(root);
    const source = path.join(root, "server.ts");
    const displaced = path.join(root, "server.held.ts");
    fs.writeFileSync(source, "export const trusted = true;\n", { mode: 0o644 });
    const originalOpen = fs.openSync.bind(fs);
    let replaced = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((
      filename,
      flags,
      mode,
    ) => {
      const descriptor = originalOpen(filename, flags, mode);
      if (
        !replaced
        && typeof flags === "number"
        && (flags & fs.constants.O_NOFOLLOW) !== 0
        && path.basename(String(filename)) === "server.ts"
      ) {
        replaced = true;
        fs.renameSync(source, displaced);
        fs.writeFileSync(source, "export const malicious = true;\n", {
          mode: 0o644,
        });
      }
      return descriptor;
    }) as typeof fs.openSync);

    expect(() => permanentStagingAppDeploymentExecutorInternals
      .snapshotManifestSha256(root)).toThrow("source_snapshot_invalid");
    expect(replaced).toBe(true);
    openSpy.mockRestore();
  });

  it("blocks every provider write when a held snapshot path is swapped during read", async () => {
    const exactPolicy = policy("permanent-staging");
    const fixture = harness(exactPolicy);
    const source = path.join(fixture.sourceAuthority.snapshotPath, "server.ts");
    const displaced = path.join(
      fixture.sourceAuthority.snapshotPath,
      "server.held.ts",
    );
    fs.writeFileSync(source, "export const trusted = true;\n", { mode: 0o644 });
    const originalOpen = fs.openSync.bind(fs);
    const originalRead = fs.readSync.bind(fs);
    let heldDescriptor: number | null = null;
    let replaced = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((
      filename,
      flags,
      mode,
    ) => {
      const descriptor = originalOpen(filename, flags, mode);
      if (path.basename(String(filename)) === "server.ts") {
        heldDescriptor = descriptor;
      }
      return descriptor;
    }) as typeof fs.openSync);
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((
      ...args: Parameters<typeof fs.readSync>
    ) => {
      if (!replaced && args[0] === heldDescriptor) {
        replaced = true;
        fs.renameSync(source, displaced);
        fs.writeFileSync(source, "export const malicious = true;\n", {
          mode: 0o644,
        });
      }
      return Reflect.apply(originalRead, fs, args);
    }) as typeof fs.readSync);
    fixture.sourceAuthority.reassert.mockImplementation(() => {
      permanentStagingAppDeploymentExecutorInternals.snapshotManifestSha256(
        fixture.sourceAuthority.snapshotPath,
      );
    });

    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);

    expect(replaced).toBe(true);
    expect(fixture.runCommand).not.toHaveBeenCalled();
    expect(fixture.cliAuthority.close).toHaveBeenCalledTimes(1);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      outcome: "blocked",
      failureCode: "source_snapshot_invalid",
      writeAttempts: 0,
      checks: { sourceReasserted: false },
    });
    readSpy.mockRestore();
    openSpy.mockRestore();
  });

  it.runIf(process.platform === "linux")(
    "lets a real child chdir to and read from the held snapshot root",
    () => {
      const snapshotPath = fs.realpathSync(fs.mkdtempSync(
        path.join(os.tmpdir(), "pintpath-held-root-child-"),
      ));
      temporaryRoots.push(snapshotPath);
      const trustedSource = "export const source = 'trusted child';\n";
      fs.chmodSync(snapshotPath, 0o700);
      fs.writeFileSync(path.join(snapshotPath, "server.ts"), trustedSource, {
        mode: 0o600,
      });
      const heldRoot = permanentStagingAppDeploymentExecutorInternals
        .holdSnapshotRootDirectory(snapshotPath);

      try {
        const child = spawnSync(process.execPath, [
          "-e",
          "process.stdout.write(require('node:fs').readFileSync('server.ts', 'utf8'))",
        ], {
          cwd: heldRoot.authorityPath,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });

        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(child.signal).toBeNull();
        expect(child.stderr).toBe("");
        expect(child.stdout).toBe(trustedSource);
        heldRoot.assertExact();
      } finally {
        heldRoot.close();
      }

      expect(fs.existsSync(heldRoot.authorityPath)).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "uploads only the held trusted tree when the snapshot root path is swapped",
    async () => {
      const exactPolicy = policy("permanent-staging");
      const fixture = harness(exactPolicy);
      const snapshotPath = fixture.sourceAuthority.snapshotPath;
      const trustedSource = "export const source = 'trusted';\n";
      const maliciousSource = "export const source = 'swapped';\n";
      fs.writeFileSync(path.join(snapshotPath, "server.ts"), trustedSource, {
        mode: 0o600,
      });
      const heldRoot = permanentStagingAppDeploymentExecutorInternals
        .holdSnapshotRootDirectory(snapshotPath);
      const manifestSha256 = permanentStagingAppDeploymentExecutorInternals
        .snapshotManifestSha256(snapshotPath, heldRoot.authorityPath);
      const sourceAuthority = {
        ...fixture.sourceAuthority,
        snapshotManifestSha256: manifestSha256,
        deploymentPath: heldRoot.authorityPath,
        close: vi.fn(() => heldRoot.close()),
        cleanup: vi.fn(),
        reassert: vi.fn(() => {
          try {
            heldRoot.assertExact();
            if (
              permanentStagingAppDeploymentExecutorInternals
                .snapshotManifestSha256(snapshotPath, heldRoot.authorityPath)
              !== manifestSha256
            ) throw new Error("source_reassertion_failed");
          } catch {
            throw new Error("source_reassertion_failed");
          }
        }),
      };
      fixture.overrides.createSourceAuthority = vi.fn(async () => sourceAuthority);
      const displaced = `${snapshotPath}.held`;
      let unsafeProviderWrites = 0;
      const providerCommand = vi.fn(async (
        _executable: string,
        args: readonly string[],
        options: { cwd?: string },
      ) => {
        expect(args[0]).toBe("up");
        expect(args[1]).toBe(heldRoot.authorityPath);
        expect(options.cwd).toBe(heldRoot.authorityPath);
        fs.renameSync(snapshotPath, displaced);
        fs.mkdirSync(snapshotPath, { mode: 0o700 });
        fs.writeFileSync(path.join(snapshotPath, "server.ts"), maliciousSource, {
          mode: 0o600,
        });
        const uploadedSource = fs.readFileSync(
          path.join(String(args[1]), "server.ts"),
          "utf8",
        );
        if (uploadedSource !== trustedSource) unsafeProviderWrites += 1;
        return {
          code: 0,
          signal: null,
          timedOut: false,
          stdout: "queued",
          stderr: "",
        };
      });
      fixture.overrides.runCommand = providerCommand;

      try {
        await expect(runPermanentStagingAppDeploymentExecutor([
          "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
          "--candidate-sha", CANDIDATE_SHA,
          "--evidence-dir", fixture.evidenceDir,
        ], fixture.overrides)).resolves.toBe(1);
      } finally {
        heldRoot.close();
      }

      expect(providerCommand).toHaveBeenCalledTimes(1);
      expect(unsafeProviderWrites).toBe(0);
      expect(sourceAuthority.reassert).toHaveBeenCalledTimes(3);
      expect(sourceAuthority.close).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(heldRoot.authorityPath)).toBe(false);
      const receipt = JSON.parse(fs.readFileSync(
        path.join(fixture.evidenceDir, "deployment-receipt.json"),
        "utf8",
      ));
      expect(receipt).toMatchObject({
        outcome: "mutation_uncertain",
        failureCode: "source_reassertion_failed",
        writeAttempts: 1,
        checks: { sourceReasserted: false },
      });
    },
  );

  it("blocks before upload when the held CLI identity no longer reasserts", async () => {
    const exactPolicy = policy("permanent-staging");
    const fixture = harness(exactPolicy);
    fixture.cliAuthority.assertExact.mockImplementation(() => {
      throw new Error("cli_invalid");
    });

    await expect(runPermanentStagingAppDeploymentExecutor([
      "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
      "--candidate-sha", CANDIDATE_SHA,
      "--evidence-dir", fixture.evidenceDir,
    ], fixture.overrides)).resolves.toBe(1);

    expect(fixture.runCommand).not.toHaveBeenCalled();
    expect(fixture.cliAuthority.close).toHaveBeenCalledTimes(1);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.evidenceDir, "deployment-receipt.json"),
      "utf8",
    ));
    expect(receipt).toMatchObject({
      outcome: "blocked",
      failureCode: "cli_invalid",
      writeAttempts: 0,
    });
  });

  it.runIf(process.platform === "linux")(
    "holds the exact owner/mode/link/hash-pinned CLI inode through path replacement",
    async () => {
      const fixture = await linuxPinnedCliFixture(policy("permanent-staging"));
      const displaced = `${fixture.cliPath}.held`;
      try {
        expect(fixture.versionCommand).toHaveBeenCalledTimes(1);
        fs.renameSync(fixture.cliPath, displaced);
        fs.writeFileSync(fixture.cliPath, fixture.maliciousBytes);
        fs.chmodSync(fixture.cliPath, 0o500);
        expect(() => fixture.authority.assertExact()).toThrow("cli_invalid");
        expect(fs.readFileSync(fixture.authority.executablePath))
          .toEqual(fixture.trustedBytes);
      } finally {
        fixture.authority.close();
      }
      expect(fs.existsSync(fixture.authority.executablePath)).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "executes the held CLI inode through its real procfs descriptor path",
    async () => {
      const exactPolicy = policy("permanent-staging");
      const fixture = await linuxPinnedCliFixture(exactPolicy);
      try {
        const child = spawnSync(fixture.authority.executablePath, ["--version"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });

        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(child.signal).toBeNull();
        expect(child.stderr).toBe("");
        expect(child.stdout).toBe(
          `railway ${exactPolicy.railwayCli.version}\n`,
        );
        fixture.authority.assertExact();
      } finally {
        fixture.authority.close();
      }

      expect(fs.existsSync(fixture.authority.executablePath)).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "never invokes an unsafe provider binary during the final path-swap race",
    async () => {
      const exactPolicy = policy("permanent-staging");
      const pinned = await linuxPinnedCliFixture(exactPolicy);
      const fixture = harness(exactPolicy);
      const displaced = `${pinned.cliPath}.held`;
      let unsafeProviderWrites = 0;
      let providerCalls = 0;
      const providerCommand = vi.fn(async (
        executable: string,
        args: readonly string[],
      ) => {
        expect(args[0]).toBe("up");
        providerCalls += 1;
        fs.renameSync(pinned.cliPath, displaced);
        fs.writeFileSync(pinned.cliPath, pinned.maliciousBytes);
        fs.chmodSync(pinned.cliPath, 0o500);
        if (!fs.readFileSync(executable).equals(pinned.trustedBytes)) {
          unsafeProviderWrites += 1;
        }
        return {
          code: 0,
          signal: null,
          timedOut: false,
          stdout: "queued",
          stderr: "",
        };
      });
      fixture.overrides.validateCli = vi.fn(async () => pinned.authority);
      fixture.overrides.runCommand = providerCommand;

      await expect(runPermanentStagingAppDeploymentExecutor([
        "--policy", "ops/railway/permanent-staging-app-deployment-policy.json",
        "--candidate-sha", CANDIDATE_SHA,
        "--evidence-dir", fixture.evidenceDir,
      ], fixture.overrides)).resolves.toBe(1);

      expect(providerCalls).toBe(1);
      expect(unsafeProviderWrites).toBe(0);
      expect(providerCommand).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^/proc/${process.pid}/fd/[0-9]+$`)),
        expect.arrayContaining(["up"]),
        expect.any(Object),
      );
      expect(fs.existsSync(pinned.authority.executablePath)).toBe(false);
      const receipt = JSON.parse(fs.readFileSync(
        path.join(fixture.evidenceDir, "deployment-receipt.json"),
        "utf8",
      ));
      expect(receipt).toMatchObject({
        outcome: "mutation_uncertain",
        failureCode: "cli_invalid",
        writeAttempts: 1,
      });
    },
  );

  it("keeps the exact CLI command contract free of adjacent Railway mutations", () => {
    const write = policy("permanent-staging").writeContract;
    expect(write.maximumWriteAttempts).toBe(1);
    expect(write.exactTargetTokenScopeRequired).toBe(true);
    expect(write.automaticRetryAllowed).toBe(false);
    expect(write.adjacentMutationAllowed).toBe(false);
    expect(write.topologyMutationAllowed).toBe(false);
    expect(write.exactArguments).toEqual([
      "up",
      "<snapshot>",
      "--path-as-root",
      "--no-gitignore",
      "--detach",
      "--json",
      "--project",
      "<project-id>",
      "--environment",
      "<environment-id>",
      "--service",
      "<service-id>",
      "--message",
      "<candidate-bound-message>",
    ]);
    const source = fs.readFileSync(
      path.resolve("scripts/lib/permanent-staging-app-deployment-executor.ts"),
      "utf8",
    );
    for (const forbidden of [
      "railway scale",
      "railway domain",
      "railway variables",
      "railway delete",
      "railway rollback",
      "serviceInstanceDeploy",
    ]) expect(source).not.toContain(forbidden);
    expect(permanentStagingAppDeploymentExecutorInternals.TARGET_LOCKS.production
      .githubEnvironment).toBe("production-deployment");
  });
});

describe("bar pilot fresh-source staging deployment", () => {
  const policyPath = "ops/railway/bar-pilot-staging-app-deployment-policy.json";
  function pilotPolicy() {
    const parsed = parsePermanentStagingAppDeploymentPolicy(fs.readFileSync(policyPath, "utf8"));
    if (!parsed) throw new Error("pilot policy invalid");
    return parsed;
  }
  function pilotFixture(options: { current?: boolean; oldCandidateVisibleDuringPoll?: boolean; wrongSource?: boolean; runningOld?: boolean; drift?: boolean; uncertain?: boolean } = {}) {
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
      if (before && !options.current && !options.runningOld) {
        value.snapshot.latestDeployment.deploymentStopped = true;
        value.snapshot.activeDeployments[0]!.deploymentStopped = true;
      }
      if (options.drift && calls === 2) value.collateralSha256 = "f".repeat(64);
      return value;
    });
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
    const legacy = structuredClone(policy("permanent-staging"));
    legacy.configuredTopologyContract = exact.configuredTopologyContract;
    expect(parsePermanentStagingAppDeploymentPolicy(JSON.stringify(legacy))).toBeNull();
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
    expect(fixture.overrides.probeRuntime.mock.calls[0]![4]).toBe(DEPLOYMENT_AFTER);
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
  });
});
