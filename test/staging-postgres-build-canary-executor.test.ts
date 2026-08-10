import crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK,
  STAGING_POSTGRES_BUILD_CANARY_DEADLINES,
  STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_STATE,
  runStagingPostgresBuildCanaryExecutor,
  stagingPostgresBuildCanaryExecutorInternals,
  type StagingPostgresBuildCanaryBoundarySnapshot,
  type StagingPostgresBuildCanaryExecutorDependencies,
  type StagingPostgresBuildCanaryLocalAuthority,
  type StagingPostgresBuildCanaryPostflight,
} from "../scripts/execute-staging-postgres-build-canary.js";

const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const RECONCILIATION_DEPLOYMENT_ID = "55555555-5555-4555-8555-555555555555";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const IMAGE_DIGEST = `sha256:${"3".repeat(64)}`;
const BUILD_RECEIPT_SHA256 = "4".repeat(64);

function sha256(source: string): string {
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new Error("dependency_aborted"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function awaitAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function durable(source: string) {
  return {
    publication: "created-durable" as const,
    sha256: sha256(source),
    canonicalPathExact: true,
    parentMode0700: true,
    fileMode0600: true,
    currentUid: true,
    regularFile: true,
    nonSymlink: true,
    nlinkOne: true,
    exclusiveCreate: true,
    fileFsync: true,
    parentFsync: true,
    identityHeld: true,
    readbackExact: true,
  };
}

function exactLocal(): StagingPostgresBuildCanaryLocalAuthority {
  const lock = STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK;
  return {
    nodeVersion: lock.expectedNodeVersion,
    headSha: lock.expectedHeadSha,
    treeSha: lock.expectedTreeSha,
    sourceManifestSha256: lock.expectedSourceManifestSha256,
    sourceDirectoryAbsolute: true,
    sourceIdentityExact: true,
    railwayVersion: lock.railwayVersion,
    railwayBinary: lock.railwayBinary,
    railwayBinarySha256: lock.railwayBinarySha256,
    sourceManifestAlgorithm: lock.sourceManifestAlgorithm,
    sourceEntryCount: lock.expectedSourceEntryCount,
    sourceDirectoryCount: lock.expectedSourceDirectoryCount,
    sourceFileCount: lock.expectedSourceFileCount,
    sourceFileBytes: lock.expectedSourceFileBytes,
    explicitUploadTargetExact: true,
  };
}

function exactPreflight(): StagingPostgresBuildCanaryBoundarySnapshot {
  const lock = STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK;
  return {
    projectId: lock.projectId,
    environmentId: lock.environmentId,
    serviceId: lock.serviceId,
    serviceInstanceId: lock.serviceInstanceId,
    serviceName: lock.serviceName,
    railwayConfigPath: lock.railwayConfigPath,
    productionBoundaryPassed: true,
    stagingBoundaryPassed: true,
    productionPatchEmpty: true,
    stagingPatchEmpty: true,
    productionFreeze: true,
    opaqueConfigEtag: lock.expectedOpaqueConfigEtag,
    autoDeploy: false,
    triggerCount: 0,
    inventoriesComplete: true,
    deploymentInventoryIds: [],
    domainIds: [],
    tcpProxyIds: [],
    volumeIds: [],
    region: "asia-southeast1-eqsg3a",
    replicaCount: 1,
    cpuLimit: 0.1,
    memoryLimitBytes: 500_000_000,
    builder: "RAILPACK",
    buildCommand: "npm run build",
    startCommand: "node dist/scripts/staging-postgres-backup-canary.js",
    restartPolicyType: "NEVER",
    restartPolicyMaxRetries: 1,
    overlapSeconds: 0,
    drainingSeconds: 0,
    ipv6EgressEnabled: false,
    sleepApplication: false,
    preDeployCommands: [],
    healthcheckPath: null,
    healthcheckTimeout: null,
    cronSchedule: null,
    watchPatterns: [],
    variableNames: [
      "RAILPACK_PACKAGES",
      "STAGING_POSTGRES_CA_CANARY_MODE",
      "STAGING_POSTGRES_CA_CANARY_RAILWAY_CONFIG_PATH",
    ],
    variableMetadataExact: true,
    sourceImage: null,
    sourceRepo: null,
    latestDeploymentId: null,
    activeDeploymentIds: [],
  };
}

function exactPostflight(): StagingPostgresBuildCanaryPostflight {
  return {
    ...exactPreflight(),
    latestDeploymentId: DEPLOYMENT_ID,
    deploymentInventoryIds: [DEPLOYMENT_ID],
    deploymentId: DEPLOYMENT_ID,
    deploymentStatus: "SUCCESS",
    deploymentStopped: true,
    deploymentSnapshotId: SNAPSHOT_ID,
    deploymentImageDigest: IMAGE_DIGEST,
    buildOnlyReceiptPassed: true,
    buildOnlyReceiptSha256: BUILD_RECEIPT_SHA256,
    credentialCandidatesNull: true,
    dedicatedRailwayConfig: true,
    runtimePublicConfigurationExact: true,
  };
}

interface DependencyHarness {
  readonly calls: string[];
  readonly dependencies: StagingPostgresBuildCanaryExecutorDependencies;
}

function harness(overrides: Partial<StagingPostgresBuildCanaryExecutorDependencies> = {}): DependencyHarness {
  const calls: string[] = [];
  const dependencies: StagingPostgresBuildCanaryExecutorDependencies = {
    inspectLocalAuthority: async () => {
      calls.push("local");
      return exactLocal();
    },
    preflight: async () => {
      calls.push("preflight");
      return exactPreflight();
    },
    inspectIntent: async () => {
      calls.push("intent-inspect");
      return null;
    },
    persistIntent: async (source) => {
      calls.push("intent");
      return durable(source);
    },
    uploadExactlyOnce: async () => {
      calls.push("upload");
      return { deploymentId: DEPLOYMENT_ID };
    },
    postflight: async (deploymentId) => {
      calls.push(`postflight:${deploymentId ?? "null"}`);
      return exactPostflight();
    },
    persistTerminalEvidence: async (source) => {
      calls.push("terminal");
      return durable(source);
    },
    cleanup: async () => {
      calls.push("cleanup");
      return true;
    },
    finalize: async () => {
      calls.push("finalize");
      return true;
    },
    ...overrides,
  };
  return { calls, dependencies };
}

describe("staging Postgres build-canary executor", () => {
  it("is hard-disabled with exact non-production staging authority", () => {
    const lock = STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK;
    expect(STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_STATE).toBe(
      "HARD_DISABLED_REVIEW_REQUIRED",
    );
    expect(lock.projectId).toBe("48d8c6cd-1c66-4148-874b-20877f48e1a5");
    expect(lock.environmentId).toBe("a4e0f507-d6d3-4df9-a818-ad92c0071a35");
    expect(lock.serviceId).toBe("bb84fecc-a125-49ce-853f-d2f25f7019c5");
    expect(lock.serviceInstanceId).toBe("716b4818-7695-4b9f-b5f9-35249e785a58");
    expect(lock.productionFreeze).toBe(true);
    expect(lock.railwayBinarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(lock.sourceManifestAlgorithm).toBe(
      "sha256-json-depth-first-bytewise-siblings-path-type-mode-size-content-v1",
    );
    expect(lock.expectedOpaqueConfigEtag).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns one fixed blocked receipt without consulting any dependency", async () => {
    const output: string[] = [];
    const dependencyAccess = vi.fn();
    const poison = new Proxy(
      {} as StagingPostgresBuildCanaryExecutorDependencies,
      {
        get: () => {
          dependencyAccess();
          throw new Error("disabled dependency reached");
        },
      },
    );
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      const invoke = runStagingPostgresBuildCanaryExecutor as unknown as (
        dependencies: StagingPostgresBuildCanaryExecutorDependencies,
      ) => Promise<0 | 1>;
      await expect(invoke(poison)).resolves.toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(dependencyAccess).not.toHaveBeenCalled();
    expect(output).toHaveLength(1);
    const receipt = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      schemaVersion: "pintpath-staging-postgres-build-canary-executor/v2",
      mode: "framework-disabled",
      outcome: "blocked",
      deploymentId: null,
      reconciliationDeploymentId: null,
      intentSha256: null,
      terminalEvidenceSha256: null,
      checks: {
        finalizationExact: false,
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("token");
  });

  it("owns the exact sequential preflight, one write, postflight and evidence order", async () => {
    const { calls, dependencies } = harness();
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("passed");
    expect(receipt.schemaVersion).toBe(
      "pintpath-staging-postgres-build-canary-executor/v2",
    );
    expect(receipt.mode).toBe("sequential-single-write");
    expect(receipt.deploymentId).toBe(DEPLOYMENT_ID);
    expect(receipt.reconciliationDeploymentId).toBe(DEPLOYMENT_ID);
    expect(receipt.intentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.terminalEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.childAuthority).toEqual({
      snapshotId: SNAPSHOT_ID,
      imageDigest: IMAGE_DIGEST,
      buildOnlyReceiptSha256: BUILD_RECEIPT_SHA256,
    });
    expect(receipt.checks.sequentialNotAtomic).toBe(true);
    expect(calls).toEqual([
      "local",
      "intent-inspect",
      "preflight",
      "intent",
      "local",
      "preflight",
      "upload",
      `postflight:${DEPLOYMENT_ID}`,
      "local",
      "cleanup",
      "terminal",
      "finalize",
    ]);
    expect(receipt.checks.finalizationExact).toBe(true);
    expect(calls.filter((call) => call === "upload")).toHaveLength(1);
  });

  it("persists a v2 intent that names the opaque etag without claiming derivation", async () => {
    let persistedIntent = "";
    const { dependencies } = harness({
      persistIntent: async (source) => {
        persistedIntent = source;
        return durable(source);
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("passed");
    const intent = JSON.parse(persistedIntent) as Record<string, unknown>;
    expect(intent).toMatchObject({
      schemaVersion: "pintpath-staging-postgres-build-canary-intent/v2",
      opaqueConfigEtag:
        STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK.expectedOpaqueConfigEtag,
    });
    expect(intent).not.toHaveProperty("configEtag");
    expect(JSON.stringify(intent)).not.toContain("STAGING_POSTGRES_CA_CANARY_MODE\":\"build-only");
  });

  it.each([
    ["the source authority drifts", { headSha: "0".repeat(40) }],
    ["the source manifest drifts", { sourceManifestSha256: "0".repeat(64) }],
    ["the Railway binary drifts", { railwayBinarySha256: "0".repeat(64) }],
    ["the source path is not canonical", { sourceDirectoryAbsolute: false }],
    ["the source manifest algorithm is ambiguous", {
      sourceManifestAlgorithm: "sha256-json-bytewise-path-type-mode-size-content-v1",
    }],
    ["the upload target is implicit", { explicitUploadTargetExact: false }],
  ])("does not write when %s", async (_label, patch) => {
    const { calls, dependencies } = harness({
      inspectLocalAuthority: async () => {
        calls.push("local");
        return { ...exactLocal(), ...patch };
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("failed");
    expect(receipt.checks.writeAttempted).toBe(false);
    expect(calls).not.toContain("upload");
    expect(calls).toContain("cleanup");
    expect(calls).toContain("terminal");
  });

  it.each([
    ["production boundary fails", { productionBoundaryPassed: false }],
    ["production has staged drift", { productionPatchEmpty: false }],
    ["staging has staged drift", { stagingPatchEmpty: false }],
    ["autodeploy is enabled", { autoDeploy: true }],
    ["a trigger exists", { triggerCount: 1 }],
    ["the opaque config etag drifts", { opaqueConfigEtag: "0".repeat(64) }],
    ["an old deployment remains", { latestDeploymentId: DEPLOYMENT_ID }],
    ["the service name drifts", { serviceName: "wrong-service" }],
    ["the dedicated config path drifts", { railwayConfigPath: "/railway.toml" }],
    ["an inventory is incomplete", { inventoriesComplete: false }],
    ["a domain exists", { domainIds: ["domain-id"] }],
    ["a volume exists", { volumeIds: ["volume-id"] }],
    ["the region drifts", { region: "europe-west4-drams3a" }],
    ["the CPU cap drifts", { cpuLimit: 1 }],
    ["a required variable name is missing", {
      variableNames: exactPreflight().variableNames.slice(0, 2),
    }],
    ["variable names are reordered", {
      variableNames: [...exactPreflight().variableNames].reverse(),
    }],
    ["an extra variable name exists", {
      variableNames: [...exactPreflight().variableNames, "UNEXPECTED_PUBLIC_VALUE"],
    }],
    ["variable metadata is not exact", { variableMetadataExact: false }],
    ["a predeploy command exists", { preDeployCommands: ["echo forbidden"] }],
    ["a healthcheck path exists", { healthcheckPath: "/health" }],
    ["a watch pattern exists", { watchPatterns: ["src/**"] }],
  ])("does not write when %s", async (_label, patch) => {
    const { calls, dependencies } = harness({
      preflight: async () => {
        calls.push("preflight");
        return { ...exactPreflight(), ...patch };
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("failed");
    expect(receipt.checks.writeAttempted).toBe(false);
    expect(calls).not.toContain("upload");
  });

  it.each([
    "deploymentInventoryIds",
    "domainIds",
    "tcpProxyIds",
    "volumeIds",
    "activeDeploymentIds",
    "preDeployCommands",
    "watchPatterns",
    "variableNames",
  ] as const)("rejects an array-shaped object for %s", async (field) => {
    const fakeArray = Object.assign(Object.create(null) as Record<string, unknown>, {
      hidden: "unvalidated-resource",
      length: 0,
    });
    const { calls, dependencies } = harness({
      preflight: async () => {
        calls.push("preflight");
        return {
          ...exactPreflight(),
          [field]: fakeArray,
        } as unknown as StagingPostgresBuildCanaryBoundarySnapshot;
      },
    });

    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("failed");
    expect(receipt.checks.boundaryPreflightExact).toBe(false);
    expect(receipt.checks.writeAttempted).toBe(false);
    expect(calls).not.toContain("upload");
  });

  it("does not write when durable intent identity is unproven", async () => {
    const { calls, dependencies } = harness({
      persistIntent: async () => {
        calls.push("intent");
        return { ...durable("wrong"), sha256: "0".repeat(64) };
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.durableIntentExact).toBe(false);
    expect(calls).not.toContain("upload");
    expect(calls).toContain("postflight:null");
  });

  it.each([
    ["exclusive creation", { exclusiveCreate: false }],
    ["file fsync", { fileFsync: false }],
    ["parent fsync", { parentFsync: false }],
    ["held identity", { identityHeld: false }],
    ["readback", { readbackExact: false }],
  ])("does not write when durable intent lacks %s proof", async (_label, patch) => {
    const { calls, dependencies } = harness({
      persistIntent: async (source) => ({ ...durable(source), ...patch }),
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.durableIntentExact).toBe(false);
    expect(calls).not.toContain("upload");
    expect(calls).toContain("postflight:null");
  });

  it("never replays an upload when an exact durable intent already exists", async () => {
    const { calls, dependencies } = harness({
      inspectIntent: async (source) => ({
        ...durable(source),
        publication: "existing-exact",
        exclusiveCreate: false,
      }),
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.durableIntentExact).toBe(true);
    expect(receipt.checks.writeAttempted).toBe(false);
    expect(receipt.checks.postflightAttempted).toBe(true);
    expect(receipt.deploymentId).toBeNull();
    expect(receipt.reconciliationDeploymentId).toBe(DEPLOYMENT_ID);
    expect(receipt.checks.acknowledgementExact).toBe(false);
    expect(receipt.checks.targetPostflightExact).toBe(true);
    expect(receipt.childAuthority).not.toBeNull();
    expect(calls).not.toContain("upload");
    expect(calls).not.toContain("preflight");
    expect(calls).not.toContain("intent");
    expect(calls).toContain("postflight:null");
  });

  it("treats a mismatched existing intent as uncertain and reconciles without writing", async () => {
    const { calls, dependencies } = harness({
      inspectIntent: async (source) => ({
        ...durable(source),
        publication: "existing-exact",
        exclusiveCreate: false,
        sha256: "0".repeat(64),
      }),
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.intentSha256).toBeNull();
    expect(receipt.checks.durableIntentExact).toBe(false);
    expect(receipt.checks.writeAttempted).toBe(false);
    expect(receipt.checks.postflightAttempted).toBe(true);
    expect(calls).not.toContain("upload");
    expect(calls).toContain("postflight:null");
  });

  it("treats an ambiguous intent inspection failure as reconciliation-only", async () => {
    const { calls, dependencies } = harness({
      inspectIntent: async () => {
        throw new Error("untrusted path detail");
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.writeAttempted).toBe(false);
    expect(receipt.checks.postflightAttempted).toBe(true);
    expect(calls).not.toContain("preflight");
    expect(calls).not.toContain("upload");
    expect(calls).toContain("postflight:null");
    expect(JSON.stringify(receipt)).not.toContain("untrusted path detail");
  });

  it.each([
    ["false", false],
    ["zero", 0],
    ["an empty string", ""],
  ])("does not treat %s as an absent durable intent", async (_label, value) => {
    const { calls, dependencies } = harness({
      inspectIntent: async () => value as unknown as null,
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.durableIntentExact).toBe(false);
    expect(receipt.checks.writeAttempted).toBe(false);
    expect(calls).not.toContain("preflight");
    expect(calls).not.toContain("intent");
    expect(calls).not.toContain("upload");
    expect(calls).toContain("postflight:null");
  });

  it("does not replay when another process wins the intent publication race", async () => {
    const { calls, dependencies } = harness({
      persistIntent: async (source) => ({
        ...durable(source),
        publication: "existing-exact",
        exclusiveCreate: false,
      }),
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.writeAttempted).toBe(false);
    expect(calls).toContain("preflight");
    expect(calls).not.toContain("upload");
    expect(calls).toContain("postflight:null");
  });

  it("does not write when local authority changes after intent", async () => {
    let reads = 0;
    const { calls, dependencies } = harness({
      inspectLocalAuthority: async () => {
        calls.push("local");
        reads += 1;
        return reads === 1
          ? exactLocal()
          : { ...exactLocal(), treeSha: "0".repeat(40) };
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("failed");
    expect(receipt.checks.localAuthorityReasserted).toBe(false);
    expect(calls).not.toContain("upload");
  });

  it("rejects accessor-backed local authority without invoking or leaking it", async () => {
    const raw = "raw-local-authority-/tmp/secret";
    const local = exactLocal();
    const getter = vi.fn(() => {
      throw new Error(raw);
    });
    Object.defineProperty(local, "sourceManifestSha256", {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    const { calls, dependencies } = harness({
      inspectLocalAuthority: async () => local,
    });

    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("failed");
    expect(receipt.checks.localPreflightExact).toBe(false);
    expect(calls).not.toContain("preflight");
    expect(calls).not.toContain("upload");
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain(raw);
  });

  it("rejects accessor descriptors when Object.prototype.value is polluted", () => {
    const local = exactLocal();
    const getter = vi.fn(() => "0".repeat(64));
    Object.defineProperty(local, "sourceManifestSha256", {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, "value");
    let rejected = false;
    try {
      Object.defineProperty(Object.prototype, "value", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK
          .expectedSourceManifestSha256,
      });
      try {
        stagingPostgresBuildCanaryExecutorInternals.snapshotDependencyResult(local);
      } catch {
        rejected = true;
      }
    } finally {
      if (prior) {
        Object.defineProperty(Object.prototype, "value", prior);
      } else {
        delete (Object.prototype as { value?: unknown }).value;
      }
    }
    expect(rejected).toBe(true);
    expect(getter).not.toHaveBeenCalled();
  });

  it("reasserts the full boundary immediately before writing", async () => {
    let reads = 0;
    const { calls, dependencies } = harness({
      preflight: async () => {
        calls.push("preflight");
        reads += 1;
        return reads === 1
          ? exactPreflight()
          : { ...exactPreflight(), stagingPatchEmpty: false };
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("failed");
    expect(receipt.checks.boundaryPreflightExact).toBe(true);
    expect(receipt.checks.boundaryReasserted).toBe(false);
    expect(receipt.checks.writeAttempted).toBe(false);
    expect(calls.filter((call) => call === "preflight")).toHaveLength(2);
    expect(calls).not.toContain("upload");
  });

  it("postflights after an upload throw and marks the mutation uncertain", async () => {
    let persisted = "";
    const { calls, dependencies } = harness({
      uploadExactlyOnce: async () => {
        calls.push("upload");
        throw new Error("raw provider error must not escape");
      },
      persistTerminalEvidence: async (source) => {
        calls.push("terminal");
        persisted = source;
        return durable(source);
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.deploymentId).toBeNull();
    expect(receipt.reconciliationDeploymentId).toBe(DEPLOYMENT_ID);
    expect(receipt.checks.acknowledgementExact).toBe(false);
    expect(receipt.checks.targetPostflightExact).toBe(true);
    expect(receipt.childAuthority).toEqual({
      snapshotId: SNAPSHOT_ID,
      imageDigest: IMAGE_DIGEST,
      buildOnlyReceiptSha256: BUILD_RECEIPT_SHA256,
    });
    expect(receipt.checks.postflightAttempted).toBe(true);
    expect(calls).toContain("postflight:null");
    expect(JSON.stringify(receipt)).not.toContain("raw provider error");
    expect(JSON.parse(persisted)).toMatchObject({
      schemaVersion: "pintpath-staging-postgres-build-canary-evidence-candidate/v2",
      state: "pending-reconciliation",
      deploymentId: null,
      reconciliationDeploymentId: DEPLOYMENT_ID,
      childAuthority: {
        snapshotId: SNAPSHOT_ID,
        imageDigest: IMAGE_DIGEST,
        buildOnlyReceiptSha256: BUILD_RECEIPT_SHA256,
      },
    });
    expect(persisted).not.toContain("raw provider error");
  });

  it("postflights after a malformed acknowledgement without retrying", async () => {
    const { calls, dependencies } = harness({
      uploadExactlyOnce: async () => {
        calls.push("upload");
        return { deploymentId: "not-a-uuid" };
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.deploymentId).toBeNull();
    expect(receipt.reconciliationDeploymentId).toBe(DEPLOYMENT_ID);
    expect(receipt.checks.acknowledgementExact).toBe(false);
    expect(receipt.checks.targetPostflightExact).toBe(true);
    expect(receipt.childAuthority).not.toBeNull();
    expect(calls).toContain("postflight:null");
    expect(calls.filter((call) => call === "upload")).toHaveLength(1);
  });

  it("does not coerce a non-string acknowledgement ID", async () => {
    const { calls, dependencies } = harness({
      uploadExactlyOnce: async () => {
        calls.push("upload");
        return {
          deploymentId: 111_111 as unknown as string,
        };
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.deploymentId).toBeNull();
    expect(receipt.checks.acknowledgementExact).toBe(false);
    expect(calls.filter((call) => call === "upload")).toHaveLength(1);
  });

  it("cannot pass with a stateful acknowledgement getter", async () => {
    let reads = 0;
    const acknowledgement = {} as { deploymentId: string };
    Object.defineProperty(acknowledgement, "deploymentId", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? DEPLOYMENT_ID : RECONCILIATION_DEPLOYMENT_ID;
      },
    });
    const { calls, dependencies } = harness({
      uploadExactlyOnce: async () => {
        calls.push("upload");
        return acknowledgement;
      },
      postflight: async () => ({
        ...exactPostflight(),
        deploymentId: RECONCILIATION_DEPLOYMENT_ID,
        latestDeploymentId: RECONCILIATION_DEPLOYMENT_ID,
        deploymentInventoryIds: [RECONCILIATION_DEPLOYMENT_ID],
      }),
    });

    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.deploymentId).toBeNull();
    expect(receipt.checks.acknowledgementExact).toBe(false);
    expect(reads).toBe(0);
    expect(calls.filter((call) => call === "upload")).toHaveLength(1);
  });

  it("rejects accessor-backed durable evidence before any upload", async () => {
    const raw = "raw-durable-evidence-secret";
    const getter = vi.fn(() => {
      throw new Error(raw);
    });
    const { calls, dependencies } = harness({
      persistIntent: async (source) => {
        const result = durable(source);
        Object.defineProperty(result, "sha256", {
          configurable: true,
          enumerable: true,
          get: getter,
        });
        return result;
      },
    });

    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.durableIntentExact).toBe(false);
    expect(receipt.checks.writeAttempted).toBe(false);
    expect(calls).not.toContain("upload");
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain(raw);
  });

  it("contains a throwing recovery postflight and still finalizes fixed evidence", async () => {
    const raw = "raw-postflight-secret-/tmp/evidence";
    let localReads = 0;
    let persisted = "";
    const throwingPostflight = new Proxy(
      {} as StagingPostgresBuildCanaryPostflight,
      {
        get: (_target, property) => {
          if (property === "then") return undefined;
          throw new Error(raw);
        },
      },
    );
    const { calls, dependencies } = harness({
      inspectLocalAuthority: async () => {
        calls.push("local");
        localReads += 1;
        if (localReads > 1) throw new Error("raw local drift detail");
        return exactLocal();
      },
      inspectIntent: async (source) => ({
        ...durable(source),
        publication: "existing-exact",
        exclusiveCreate: false,
      }),
      postflight: async () => throwingPostflight,
      persistTerminalEvidence: async (source) => {
        calls.push("terminal");
        persisted = source;
        return durable(source);
      },
    });

    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.deploymentId).toBeNull();
    expect(receipt.reconciliationDeploymentId).toBeNull();
    expect(receipt.childAuthority).toBeNull();
    expect(receipt.checks.postflightAttempted).toBe(true);
    expect(receipt.checks.boundaryPostflightExact).toBe(false);
    expect(receipt.checks.targetPostflightExact).toBe(false);
    expect(receipt.checks.cleanupExact).toBe(true);
    expect(receipt.checks.finalizationExact).toBe(true);
    expect(receipt.terminalEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(calls).not.toContain("upload");
    expect(calls.slice(-3)).toEqual(["cleanup", "terminal", "finalize"]);
    expect(JSON.stringify(receipt)).not.toContain(raw);
    expect(persisted).not.toContain(raw);
    expect(persisted).not.toContain("raw local drift detail");
  });

  it("retains an exact reconciliation candidate when acknowledgement is absent", async () => {
    const { dependencies } = harness({
      uploadExactlyOnce: async () => ({
        deploymentId: undefined as unknown as string,
      }),
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.deploymentId).toBeNull();
    expect(receipt.reconciliationDeploymentId).toBe(DEPLOYMENT_ID);
    expect(receipt.checks.acknowledgementExact).toBe(false);
    expect(receipt.checks.targetPostflightExact).toBe(true);
    expect(receipt.childAuthority).not.toBeNull();
  });

  it("rejects an array-shaped postflight deployment inventory", async () => {
    const fakeInventory = Object.assign(
      Object.create(null) as Record<string, unknown>,
      {
        0: DEPLOYMENT_ID,
        hidden: "second-deployment",
        length: 1,
      },
    );
    const { dependencies } = harness({
      postflight: async () => ({
        ...exactPostflight(),
        deploymentInventoryIds: fakeInventory,
      } as unknown as StagingPostgresBuildCanaryPostflight),
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.boundaryPostflightExact).toBe(false);
    expect(receipt.checks.targetPostflightExact).toBe(false);
    expect(receipt.childAuthority).toBeNull();
  });

  it("rejects an array-shaped postflight active-deployment inventory", async () => {
    const fakeActive = Object.assign(
      Object.create(null) as Record<string, unknown>,
      { hidden: "active-deployment", length: 0 },
    );
    const { dependencies } = harness({
      postflight: async () => ({
        ...exactPostflight(),
        activeDeploymentIds: fakeActive,
      } as unknown as StagingPostgresBuildCanaryPostflight),
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.boundaryPostflightExact).toBe(true);
    expect(receipt.checks.targetPostflightExact).toBe(false);
    expect(receipt.childAuthority).toBeNull();
  });

  it("rejects a non-UUID postflight discovery without retaining child authority", async () => {
    const malformed = "not-a-deployment-id";
    const { dependencies } = harness({
      uploadExactlyOnce: async () => {
        throw new Error("ack lost");
      },
      postflight: async () => ({
        ...exactPostflight(),
        deploymentId: malformed,
        latestDeploymentId: malformed,
        deploymentInventoryIds: [malformed],
      }),
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.deploymentId).toBeNull();
    expect(receipt.reconciliationDeploymentId).toBeNull();
    expect(receipt.checks.boundaryPostflightExact).toBe(true);
    expect(receipt.checks.targetPostflightExact).toBe(false);
    expect(receipt.childAuthority).toBeNull();
  });

  it("retains mismatched acknowledgement and reconciliation IDs without child authority", async () => {
    let persisted = "";
    const { dependencies } = harness({
      postflight: async () => ({
        ...exactPostflight(),
        deploymentId: RECONCILIATION_DEPLOYMENT_ID,
        latestDeploymentId: RECONCILIATION_DEPLOYMENT_ID,
        deploymentInventoryIds: [RECONCILIATION_DEPLOYMENT_ID],
      }),
      persistTerminalEvidence: async (source) => {
        persisted = source;
        return durable(source);
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.deploymentId).toBe(DEPLOYMENT_ID);
    expect(receipt.reconciliationDeploymentId).toBe(RECONCILIATION_DEPLOYMENT_ID);
    expect(receipt.checks.acknowledgementExact).toBe(true);
    expect(receipt.checks.boundaryPostflightExact).toBe(true);
    expect(receipt.checks.targetPostflightExact).toBe(false);
    expect(receipt.childAuthority).toBeNull();
    expect(JSON.parse(persisted)).toMatchObject({
      deploymentId: DEPLOYMENT_ID,
      reconciliationDeploymentId: RECONCILIATION_DEPLOYMENT_ID,
      childAuthority: null,
    });
  });

  it.each([
    ["patch drift", { stagingPatchEmpty: false }],
    ["opaque etag drift", { opaqueConfigEtag: "0".repeat(64) }],
    ["an active container remains", { activeDeploymentIds: [DEPLOYMENT_ID] }],
    ["the build receipt is absent", { buildOnlyReceiptPassed: false }],
    ["the build receipt hash is absent", { buildOnlyReceiptSha256: null }],
    ["the image digest is malformed", { deploymentImageDigest: "latest" }],
    ["the snapshot is absent", { deploymentSnapshotId: null }],
    ["credentials were exercised", { credentialCandidatesNull: false }],
    ["the config path is not exact", { dedicatedRailwayConfig: false }],
    ["runtime public configuration is not exact", {
      runtimePublicConfigurationExact: false,
    }],
    ["a postflight domain exists", { domainIds: ["domain-id"] }],
    ["the postflight region drifts", { region: "europe-west4-drams3a" }],
    ["the deployment inventory is incomplete", { inventoriesComplete: false }],
  ])("marks the mutation uncertain on postflight %s", async (_label, patch) => {
    const { dependencies } = harness({
      postflight: async () => ({ ...exactPostflight(), ...patch }),
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.checks.writeAttempted).toBe(true);
    expect(receipt.childAuthority).toBeNull();
  });

  it("gives cleanup failure precedence over an otherwise successful write", async () => {
    const { dependencies } = harness({ cleanup: async () => false });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("cleanup_failed");
    expect(receipt.checks.cleanupExact).toBe(false);
  });

  it("rejects a truthy non-boolean cleanup result", async () => {
    const { dependencies } = harness({
      cleanup: async () => "true" as unknown as boolean,
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("cleanup_failed");
    expect(receipt.checks.cleanupExact).toBe(false);
    expect(receipt.checks.finalizationExact).toBe(true);
  });

  it("keeps cleanup failure precedence when terminal evidence also fails", async () => {
    const { dependencies } = harness({
      cleanup: async () => false,
      persistTerminalEvidence: async () => {
        throw new Error("evidence unavailable");
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("cleanup_failed");
    expect(receipt.terminalEvidenceSha256).toBeNull();
  });

  it("finalizes after terminal evidence failure", async () => {
    const { calls, dependencies } = harness({
      persistTerminalEvidence: async () => {
        calls.push("terminal");
        throw new Error("evidence unavailable");
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("mutation_uncertain");
    expect(receipt.terminalEvidenceSha256).toBeNull();
    expect(receipt.checks.finalizationExact).toBe(true);
    expect(calls.slice(-3)).toEqual(["cleanup", "terminal", "finalize"]);
  });

  it.each([
    ["returns false", async () => false],
    ["returns a non-boolean", async () => "true" as unknown as boolean],
    ["throws", async () => { throw new Error("raw finalization failure"); }],
  ])("gives finalization failure precedence when finalize %s", async (
    _label,
    finalize,
  ) => {
    const { calls, dependencies } = harness({
      finalize: async (_signal) => {
        calls.push("finalize");
        return finalize();
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("cleanup_failed");
    expect(receipt.terminalEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.checks.cleanupExact).toBe(true);
    expect(receipt.checks.finalizationExact).toBe(false);
    expect(calls.slice(-3)).toEqual(["cleanup", "terminal", "finalize"]);
    expect(JSON.stringify(receipt)).not.toContain("raw finalization failure");
  });

  it("persists only a non-green reconciliation candidate", async () => {
    let persisted = "";
    const { dependencies } = harness({
      persistTerminalEvidence: async (source) => {
        persisted = source;
        return durable(source);
      },
    });
    const receipt = await stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
      dependencies,
    );
    expect(receipt.outcome).toBe("passed");
    expect(JSON.parse(persisted)).toMatchObject({
      schemaVersion: "pintpath-staging-postgres-build-canary-evidence-candidate/v2",
      state: "pending-reconciliation",
      operation: "staging-postgres-build-canary-upload",
      deploymentId: DEPLOYMENT_ID,
      reconciliationDeploymentId: DEPLOYMENT_ID,
    });
    expect(persisted).not.toContain('"outcome":"passed"');
  });

  it("times out a stalled postflight and still cleans up", async () => {
    vi.useFakeTimers();
    try {
      const { calls, dependencies } = harness({
        postflight: async (_deploymentId, signal) => await rejectOnAbort(signal),
      });
      const pending = stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
        dependencies,
      );
      await vi.advanceTimersByTimeAsync(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.postflightMs,
      );
      const receipt = await pending;
      expect(receipt.outcome).toBe("mutation_uncertain");
      expect(calls).toContain("cleanup");
      expect(calls.filter((call) => call === "upload")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a stalled upload, aborts it, and postflights without retry", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | null = null;
      const { calls, dependencies } = harness({
        uploadExactlyOnce: async (_intent, uploadSignal) => {
          calls.push("upload");
          signal = uploadSignal;
          return await rejectOnAbort(uploadSignal);
        },
      });
      const pending = stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
        dependencies,
      );
      await vi.advanceTimersByTimeAsync(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.uploadMs,
      );
      const receipt = await pending;
      expect(receipt.outcome).toBe("mutation_uncertain");
      expect(signal?.aborted).toBe(true);
      expect(receipt.checks.postflightAttempted).toBe(true);
      expect(calls).toContain("postflight:null");
      expect(calls.filter((call) => call === "upload")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out stalled cleanup and preserves cleanup-failed precedence", async () => {
    vi.useFakeTimers();
    try {
      const { dependencies } = harness({
        cleanup: async (signal) => await rejectOnAbort(signal),
      });
      const pending = stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
        dependencies,
      );
      await vi.advanceTimersByTimeAsync(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.cleanupMs,
      );
      const receipt = await pending;
      expect(receipt.outcome).toBe("cleanup_failed");
      expect(receipt.checks.cleanupExact).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out stalled terminal evidence without returning success", async () => {
    vi.useFakeTimers();
    try {
      const { dependencies } = harness({
        persistTerminalEvidence: async (_source, signal) => {
          return await rejectOnAbort(signal);
        },
      });
      const pending = stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
        dependencies,
      );
      await vi.advanceTimersByTimeAsync(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.durableEvidenceMs,
      );
      const receipt = await pending;
      expect(receipt.outcome).toBe("mutation_uncertain");
      expect(receipt.terminalEvidenceSha256).toBeNull();
      expect(receipt.checks.finalizationExact).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out stalled finalization and preserves cleanup-failed precedence", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | null = null;
      const { calls, dependencies } = harness({
        finalize: async (finalizeSignal) => {
          calls.push("finalize");
          signal = finalizeSignal;
          return await rejectOnAbort(finalizeSignal);
        },
      });
      const pending = stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
        dependencies,
      );
      await vi.advanceTimersByTimeAsync(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.finalizationMs,
      );
      const receipt = await pending;
      expect(receipt.outcome).toBe("cleanup_failed");
      expect(receipt.checks.cleanupExact).toBe(true);
      expect(receipt.checks.finalizationExact).toBe(false);
      expect(signal?.aborted).toBe(true);
      expect(calls.slice(-3)).toEqual(["cleanup", "terminal", "finalize"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a real deadline alive for an otherwise unresolved operation", async () => {
    const started = Date.now();
    await expect(
      stagingPostgresBuildCanaryExecutorInternals.withDeadline(
        10,
        async (signal) => await rejectOnAbort(signal),
      ),
    ).rejects.toThrow("operation_timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);
  });

  it("does not advance after a deadline until the aborted operation settles", async () => {
    vi.useFakeTimers();
    try {
      let uploadSignal: AbortSignal | null = null;
      let releaseUpload: (() => void) | null = null;
      const uploadRelease = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      const { calls, dependencies } = harness({
        uploadExactlyOnce: async (_intent, signal) => {
          calls.push("upload");
          uploadSignal = signal;
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          await uploadRelease;
          return { deploymentId: DEPLOYMENT_ID };
        },
      });
      let executorSettled = false;
      const pending = stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
        dependencies,
      ).finally(() => {
        executorSettled = true;
      });

      await vi.advanceTimersByTimeAsync(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.uploadMs,
      );
      await Promise.resolve();
      expect(uploadSignal?.aborted).toBe(true);
      expect(executorSettled).toBe(false);
      expect(calls).not.toContain("postflight:null");
      expect(calls).not.toContain("cleanup");

      releaseUpload?.();
      const receipt = await pending;
      expect(receipt.outcome).toBe("mutation_uncertain");
      expect(receipt.checks.acknowledgementExact).toBe(false);
      expect(calls).toContain("postflight:null");
      expect(calls).toContain("cleanup");
      expect(calls.filter((call) => call === "upload")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reassert or postflight until a timed-out intent write settles", async () => {
    vi.useFakeTimers();
    try {
      const release = deferred<ReturnType<typeof durable>>();
      let persistedSource = "";
      let persistSignal: AbortSignal | null = null;
      const { calls, dependencies } = harness({
        persistIntent: async (source, signal) => {
          calls.push("intent");
          persistedSource = source;
          persistSignal = signal;
          await awaitAbort(signal);
          return await release.promise;
        },
      });
      let settled = false;
      const pending = stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
        dependencies,
      ).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.durableEvidenceMs,
      );
      expect(persistSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(calls.filter((call) => call === "local")).toHaveLength(1);
      expect(calls).not.toContain("postflight:null");
      expect(calls).not.toContain("cleanup");

      release.resolve(durable(persistedSource));
      const receipt = await pending;
      expect(receipt.outcome).toBe("mutation_uncertain");
      expect(receipt.checks.durableIntentExact).toBe(false);
      expect(receipt.checks.writeAttempted).toBe(false);
      expect(calls).toContain("postflight:null");
      expect(calls).toContain("cleanup");
      expect(calls).not.toContain("upload");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clean up until a timed-out postflight settles", async () => {
    vi.useFakeTimers();
    try {
      const release = deferred<StagingPostgresBuildCanaryPostflight>();
      let postflightSignal: AbortSignal | null = null;
      const { calls, dependencies } = harness({
        postflight: async (deploymentId, signal) => {
          calls.push(`postflight:${deploymentId ?? "null"}`);
          postflightSignal = signal;
          await awaitAbort(signal);
          return await release.promise;
        },
      });
      let settled = false;
      const pending = stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
        dependencies,
      ).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.postflightMs,
      );
      expect(postflightSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(calls).not.toContain("cleanup");

      release.resolve(exactPostflight());
      const receipt = await pending;
      expect(receipt.outcome).toBe("mutation_uncertain");
      expect(receipt.checks.boundaryPostflightExact).toBe(false);
      expect(receipt.checks.targetPostflightExact).toBe(false);
      expect(calls).toContain("cleanup");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not persist terminal evidence until timed-out cleanup settles", async () => {
    vi.useFakeTimers();
    try {
      const release = deferred<boolean>();
      let cleanupSignal: AbortSignal | null = null;
      const { calls, dependencies } = harness({
        cleanup: async (signal) => {
          calls.push("cleanup");
          cleanupSignal = signal;
          await awaitAbort(signal);
          return await release.promise;
        },
      });
      let settled = false;
      const pending = stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
        dependencies,
      ).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.cleanupMs,
      );
      expect(cleanupSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(calls).not.toContain("terminal");
      expect(calls).not.toContain("finalize");

      release.resolve(true);
      const receipt = await pending;
      expect(receipt.outcome).toBe("cleanup_failed");
      expect(receipt.checks.cleanupExact).toBe(false);
      expect(calls.slice(-3)).toEqual(["cleanup", "terminal", "finalize"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not finalize until a timed-out terminal write settles", async () => {
    vi.useFakeTimers();
    try {
      const release = deferred<ReturnType<typeof durable>>();
      let terminalSource = "";
      let terminalSignal: AbortSignal | null = null;
      const { calls, dependencies } = harness({
        persistTerminalEvidence: async (source, signal) => {
          calls.push("terminal");
          terminalSource = source;
          terminalSignal = signal;
          await awaitAbort(signal);
          return await release.promise;
        },
      });
      let settled = false;
      const pending = stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
        dependencies,
      ).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.durableEvidenceMs,
      );
      expect(terminalSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(calls).not.toContain("finalize");

      release.resolve(durable(terminalSource));
      const receipt = await pending;
      expect(receipt.outcome).toBe("mutation_uncertain");
      expect(receipt.terminalEvidenceSha256).toBeNull();
      expect(receipt.checks.finalizationExact).toBe(true);
      expect(calls.at(-1)).toBe("finalize");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not return until timed-out finalization settles", async () => {
    vi.useFakeTimers();
    try {
      const release = deferred<boolean>();
      let finalizationSignal: AbortSignal | null = null;
      const { dependencies } = harness({
        finalize: async (signal) => {
          finalizationSignal = signal;
          await awaitAbort(signal);
          return await release.promise;
        },
      });
      let settled = false;
      const pending = stagingPostgresBuildCanaryExecutorInternals.executeEnabled(
        dependencies,
      ).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.finalizationMs,
      );
      expect(finalizationSignal?.aborted).toBe(true);
      expect(settled).toBe(false);

      release.resolve(true);
      const receipt = await pending;
      expect(receipt.outcome).toBe("cleanup_failed");
      expect(receipt.checks.finalizationExact).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

});
