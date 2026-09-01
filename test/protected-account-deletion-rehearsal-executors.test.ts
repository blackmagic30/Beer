import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_DELETION_REHEARSAL_METADATA_QUERY,
  accountDeletionRehearsalTransitionInternals,
  collectAccountDeletionRehearsalMetadata,
} from "../scripts/execute-protected-permanent-staging-account-deletion-rehearsal-transition.js";
import {
  accountDeletionRehearsalRedeployInternals,
  proveProviderReadinessOnEveryInstance,
} from "../scripts/execute-protected-permanent-staging-account-deletion-rehearsal-redeploy.js";
import { accountDeletionRehearsalScaleInternals } from
  "../scripts/execute-protected-permanent-staging-account-deletion-rehearsal-scale.js";
import { accountDeletionRehearsalQuarantineInternals } from
  "../scripts/execute-protected-permanent-staging-account-deletion-rehearsal-quarantine.js";
import { accountDeletionRehearsalActionPrepareInternals } from
  "../scripts/prepare-protected-permanent-staging-account-deletion-rehearsal-action.js";
import { accountDeletionRehearsalStateClassifierInternals } from
  "../scripts/classify-permanent-staging-account-deletion-rehearsal-state.js";
import {
  ACCOUNT_DELETION_REHEARSAL_ACTIVATION_VARIABLES,
  ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS,
  ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
  ACCOUNT_DELETION_REHEARSAL_LOCK,
  accountDeletionRehearsalAttemptInvariantSha256,
  accountDeletionRehearsalCleanupPatchForRun,
  accountDeletionRehearsalRunMarkerName,
  canonicalJson,
  sha256Hex,
} from "../scripts/lib/permanent-staging-account-deletion-rehearsal.js";

const root = path.resolve(import.meta.dirname, "..");
const project = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const environment = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const service = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const candidate = "a".repeat(40);
const deployment = "11111111-1111-4111-8111-111111111111";
const snapshot = "22222222-2222-4222-8222-222222222222";

function metadataPage(
  edges: Array<{ name: string; serviceId: string | null }>,
  hasNextPage: boolean,
  endCursor: string | null,
) {
  return {
    data: {
      environment: {
        id: environment,
        variables: {
          edges: edges.map((row, index) => ({ node: {
            id: `row-${index}`,
            name: row.name,
            environmentId: environment,
            serviceId: row.serviceId,
            isSealed: true,
            references: [],
          } })),
          pageInfo: { hasNextPage, endCursor },
        },
      },
      staged: { environmentId: environment, patch: {} },
      serviceInstance: {
        id: "instance",
        serviceId: service,
        environmentId: environment,
        numReplicas: 2,
        latestDeployment: { id: deployment, status: "SUCCESS",
          deploymentStopped: false, snapshotId: snapshot },
        activeDeployments: [{ id: deployment, status: "SUCCESS",
          deploymentStopped: false }],
      },
    },
  };
}

describe("account-deletion rehearsal protected executors", () => {
  it("uses bounded cursor pagination and ignores structurally valid foreign service rows", async () => {
    expect(ACCOUNT_DELETION_REHEARSAL_METADATA_QUERY).toContain("$after: String");
    expect(ACCOUNT_DELETION_REHEARSAL_METADATA_QUERY).toContain("after:$after");
    const pages = [
      metadataPage([
        { name: "RESEND_TRANSACTIONAL_API_KEY", serviceId: service },
        { name: "POSTGRES_PASSWORD", serviceId: "33333333-3333-4333-8333-333333333333" },
      ], true, "cursor-1"),
      metadataPage([
        { name: "ACCOUNT_DELETION_NOTICE_MODE", serviceId: null },
      ], false, "terminal-cursor"),
    ];
    const seen: Array<string | null> = [];
    const result = await collectAccountDeletionRehearsalMetadata(async (after) => {
      seen.push(after);
      return pages.shift();
    });
    expect(seen).toEqual([null, "cursor-1"]);
    expect(result?.rowNames).toEqual([
      "ACCOUNT_DELETION_NOTICE_MODE", "RESEND_TRANSACTIONAL_API_KEY",
    ]);
  });

  it("rejects duplicate row identities and cursor cycles", async () => {
    const duplicate = metadataPage([
      { name: "X", serviceId: service }, { name: "X", serviceId: service },
    ], false, "terminal");
    expect(await collectAccountDeletionRehearsalMetadata(async () => duplicate))
      .toBeNull();
    const cycle = metadataPage([], true, "same");
    expect(await collectAccountDeletionRehearsalMetadata(async () => cycle))
      .toBeNull();
  });

  it("requires Railway RUNNING instance status for strict launch proof", async () => {
    const runReadinessCommand = vi.fn().mockResolvedValue({
      code: 0, timedOut: false, stderrSha256: "b".repeat(64),
      stdout: JSON.stringify({
        ok: true, environment: "production",
        readinessProfile: "permanent_staging_complete",
        strictLaunchCheck: true,
        summary: { failures: 0 },
        checks: [{ status: "pass" }],
      }),
    });
    const dependencies = { fetchImpl: fetch, now: Date.now,
      sleep: async () => undefined, runReadinessCommand };
    const running = [{ id: "44444444-4444-4444-8444-444444444444",
      status: "RUNNING" }];
    expect(await proveProviderReadinessOnEveryInstance(
      dependencies, running, "/railway", "token", "permanent_staging_complete", 1,
    )).toHaveLength(1);
    expect(await proveProviderReadinessOnEveryInstance(
      dependencies, [{ ...running[0]!, status: "SUCCESS" }], "/railway", "token",
      "permanent_staging_complete", 1,
    )).toBeNull();
  });

  it("binds cleanup authority to reconciled cleanup and scale to exact prerequisites", () => {
    expect(accountDeletionRehearsalTransitionInternals.parseArguments([
      "--operation", "cleanup-contained-zero",
      "--candidate-sha", candidate,
      "--activation-run-id", "800",
      "--authority-file", "/tmp/authority",
      "--prerequisite-file", "/tmp/observation",
      "--evidence-dir", "/tmp/evidence",
    ])?.operation).toBe("cleanup-contained-zero");
    expect(accountDeletionRehearsalTransitionInternals.parseArguments([
      "--operation", "reconcile-cleanup",
      "--candidate-sha", candidate,
      "--activation-run-id", "800",
      "--authority-file", "/tmp/authority",
      "--evidence-dir", "/tmp/evidence",
    ])).toBeNull();
    const redeployArgs = {
      operation: "apply-safe" as const, candidateSha: candidate,
      transitionRunId: "900", transitionTerminalFile: "/tmp/transition",
      authorityFile: "/tmp/authority", evidenceDirectory: "/tmp/evidence",
    };
    const cleanupAuthority = JSON.stringify({
      schemaVersion: "pintpath-account-deletion-rehearsal-authority/v1",
      executorState: "GITHUB_ENVIRONMENT_PROTECTED", mode: "cleanup",
      candidateSha: candidate, githubRunId: "900", secretMaterialIncluded: false,
      cleanupMayProceedAfterMainAdvances: true,
      originalActivation: { runId: "800" },
    });
    expect(accountDeletionRehearsalRedeployInternals.authorityExact(
      cleanupAuthority, redeployArgs, "900",
      { operation: "reconcile-cleanup", activationRunId: "800" },
    )).toBe(true);
    expect(accountDeletionRehearsalRedeployInternals.authorityExact(
      cleanupAuthority, redeployArgs, "900",
      { operation: "store-cleanup", activationRunId: "800" },
    )).toBe(false);

    const scaleArgs = accountDeletionRehearsalScaleInternals.parseArguments([
      "--operation", "prepare-two", "--candidate-sha", candidate,
      "--activation-run-id", "900", "--authority-file", "/tmp/authority",
      "--prerequisite-file", "/tmp/arm", "--evidence-dir", "/tmp/evidence",
    ]);
    expect(scaleArgs?.operation).toBe("prepare-two");
    const arm = JSON.stringify({
      schemaVersion: "pintpath-account-deletion-rehearsal-cleanup-arm/v1",
      candidateSha: candidate, activationRunId: "900", projectId: project,
      environmentId: environment, serviceId: service, cleanupRequired: true,
      disarmCondition:
        "SAFE_ONE_PREACTIVATION_OR_SAFE_ONE_FINAL_OR_QUARANTINED_ZERO",
      secretMaterialIncluded: false,
    });
    expect(accountDeletionRehearsalScaleInternals.prerequisiteExact(
      arm, scaleArgs!, "900",
    )).toBe(true);
  });

  it("accepts only strict authority-bound safe-two classifier evidence for convergence", () => {
    const authoritySource = canonicalJson({
      schemaVersion: "pintpath-account-deletion-rehearsal-authority/v1",
      executorState: ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
      mode: "cleanup", candidateSha: candidate, githubRunId: "900",
      secretMaterialIncluded: false, cleanupMayProceedAfterMainAdvances: true,
      originalActivation: { runId: "800" },
    });
    const args = accountDeletionRehearsalScaleInternals.parseArguments([
      "--operation", "converge-one", "--candidate-sha", candidate,
      "--activation-run-id", "800", "--authority-file", "/tmp/authority",
      "--prerequisite-file", "/tmp/observation", "--evidence-dir", "/tmp/evidence",
    ])!;
    const observation = {
      schemaVersion: "pintpath-account-deletion-rehearsal-state-observation/v1",
      executorState: ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
      state: "SAFE_TWO_PREACTIVATION", candidateSha: candidate,
      implementationSha: "b".repeat(40),
      activationRunId: "800", githubRunId: "900",
      authoritySha256: sha256Hex(authoritySource), exact: true,
      lock: { projectId: project, environmentId: environment, serviceId: service,
        region: "asia-southeast1-eqsg3a" },
      providerSnapshot: {
        replicas: 2, instanceCount: 2,
        instanceIdSha256s: ["1".repeat(64), "2".repeat(64)],
        instanceStatuses: ["RUNNING", "RUNNING"],
        rowCategory: "preactivation", patchCategory: "empty",
      },
      runtime: {
        expected: "safe", replicas: 2, publicExact: true, providerExact: true,
        runtimeUnavailableExact: false,
        replicaIdSha256s: ["3".repeat(64), "4".repeat(64)],
        providerReadinessSha256s: ["5".repeat(64), "6".repeat(64)],
      },
      checks: {
        policyExact: true, githubAuthorityExact: true, tokenScopesExact: true,
        cliExact: true, boundaryPreflightExact: true, providerTopologyExact: true,
        candidateExact: true, rowCategoryExact: true, stagedPatchExact: true,
        activationMarkerExact: true, runtimeProofExact: true,
        boundaryPostflightExact: true,
      },
      mutationCredentialExposed: false, secretMaterialIncluded: false,
    };
    expect(accountDeletionRehearsalScaleInternals.prerequisiteExact(
      JSON.stringify(observation), args, "900", authoritySource,
    )).toBe(true);
    expect(accountDeletionRehearsalScaleInternals.prerequisiteExact(
      JSON.stringify({ ...observation,
        authoritySha256: "f".repeat(64) }), args, "900", authoritySource,
    )).toBe(false);
    expect(accountDeletionRehearsalScaleInternals.prerequisiteExact(
      JSON.stringify({ ...observation, implementationSha: "main" }),
      args, "900", authoritySource,
    )).toBe(false);
    expect(accountDeletionRehearsalScaleInternals.prerequisiteExact(
      JSON.stringify({ ...observation, runtime: {
        ...observation.runtime, providerExact: false,
      } }), args, "900", authoritySource,
    )).toBe(false);
  });

  it("keeps quarantine candidate/source/run bound and guards child-process settlement", () => {
    const quarantine = fs.readFileSync(path.join(root,
      "scripts/execute-protected-permanent-staging-account-deletion-rehearsal-quarantine.ts"),
    "utf8");
    const activeRows = [
      ...ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS,
      ...Object.keys(ACCOUNT_DELETION_REHEARSAL_ACTIVATION_VARIABLES),
      accountDeletionRehearsalRunMarkerName("800"),
    ];
    const base = {
      rowNames: activeRows, replicas: 2, deploymentId: deployment,
      snapshotId: snapshot, candidateSha: candidate,
      imageDigest: `sha256:${"b".repeat(64)}`, patch: {},
      instances: [
        { id: "44444444-4444-4444-8444-444444444444", status: "RUNNING" },
        { id: "55555555-5555-4555-8555-555555555555", status: "RUNNING" },
      ],
    };
    expect(accountDeletionRehearsalQuarantineInternals.parseArguments([
      "--operation", "quarantine-zero-retry-1",
      "--candidate-sha", candidate,
      "--activation-run-id", "800",
      "--authority-file", "/tmp/authority",
      "--prerequisite-file", "/tmp/observation",
      "--evidence-dir", "/tmp/evidence",
    ])?.operation).toBe("quarantine-zero-retry-1");
    expect(accountDeletionRehearsalQuarantineInternals
      .quarantineSnapshotStateExact(base, {
        operation: "quarantine-zero", candidateSha: candidate,
        activationRunId: "800",
      })).toBe(true);
    expect(accountDeletionRehearsalQuarantineInternals
      .quarantineSnapshotStateExact(base, {
        operation: "quarantine-zero", candidateSha: candidate,
        activationRunId: "801",
      })).toBe(false);
    expect(accountDeletionRehearsalQuarantineInternals
      .quarantineSnapshotStateExact({ ...base,
        patch: accountDeletionRehearsalCleanupPatchForRun("800") }, {
        operation: "quarantine-zero-retry-1", candidateSha: candidate,
        activationRunId: "800",
      })).toBe(true);
    expect(accountDeletionRehearsalQuarantineInternals
      .quarantineSnapshotStateExact({ ...base,
        patch: { services: { foreign: { variables: { X: null } } } } }, {
        operation: "quarantine-zero-retry-2", candidateSha: candidate,
        activationRunId: "800",
      })).toBe(false);
    expect(accountDeletionRehearsalQuarantineInternals
      .quarantineSnapshotStateExact({ ...base, replicas: 0, instances: [] }, {
        operation: "quarantine-zero-retry-1", candidateSha: candidate,
        activationRunId: "800",
      })).toBe(false);
    expect(accountDeletionRehearsalQuarantineInternals
      .quarantineSnapshotStateExact({ ...base, replicas: 0, instances: [] }, {
        operation: "quarantine-zero-retry-1", candidateSha: candidate,
        activationRunId: "800",
      }, true)).toBe(true);
    const prepareBaseArgs = {
      operation: "quarantine-zero" as const,
      candidateSha: candidate, activationRunId: "800",
      authorityFile: "/tmp/authority", prerequisiteFile: "/tmp/observation",
      evidenceDirectory: "/tmp/evidence",
    };
    expect(accountDeletionRehearsalActionPrepareInternals.snapshotStateExact(
      base, prepareBaseArgs,
    )).toBe(true);
    expect(accountDeletionRehearsalActionPrepareInternals.snapshotStateExact(
      { ...base, instances: [base.instances[0]!] }, prepareBaseArgs,
    )).toBe(false);
    expect(accountDeletionRehearsalActionPrepareInternals.snapshotStateExact(
      { ...base, replicas: 0 }, prepareBaseArgs,
    )).toBe(false);
    expect(accountDeletionRehearsalActionPrepareInternals.snapshotStateExact(
      { ...base, instances: [base.instances[0]!,
        { ...base.instances[1]!, status: "SUCCESS" }] }, prepareBaseArgs,
    )).toBe(false);
    expect(quarantine).toContain("after.imageDigest === before.imageDigest");
    expect(quarantine).toContain("if (settled) return");
  });

  it("arms quarantine retry slots only from a fresh exact live observation", () => {
    const activeRows = [
      ...ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS,
      ...Object.keys(ACCOUNT_DELETION_REHEARSAL_ACTIVATION_VARIABLES),
      accountDeletionRehearsalRunMarkerName("800"),
    ];
    const live = {
      rowNames: activeRows, replicas: 2, deploymentId: deployment,
      snapshotId: snapshot, candidateSha: candidate,
      imageDigest: `sha256:${"b".repeat(64)}`, patch: {},
      instances: [
        { id: "44444444-4444-4444-8444-444444444444", status: "RUNNING" },
        { id: "55555555-5555-4555-8555-555555555555", status: "RUNNING" },
      ],
    };
    const authoritySource = canonicalJson({
      schemaVersion: "pintpath-account-deletion-rehearsal-authority/v1",
      executorState: ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
      mode: "cleanup", candidateSha: candidate, githubRunId: "900",
      secretMaterialIncluded: false, cleanupMayProceedAfterMainAdvances: true,
      originalActivation: { runId: "800" },
    });
    const instanceHashes = live.instances.map((instance) =>
      sha256Hex(instance.id)).sort();
    const observation = {
      schemaVersion: "pintpath-account-deletion-rehearsal-state-observation/v1",
      executorState: ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
      state: "ACTIVE_TWO", candidateSha: candidate,
      implementationSha: "b".repeat(40), activationRunId: "800",
      githubRunId: "900", authoritySha256: sha256Hex(authoritySource), exact: true,
      lock: {
        projectId: ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
        environmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
        serviceId: ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
        region: ACCOUNT_DELETION_REHEARSAL_LOCK.region,
        publicOrigin: ACCOUNT_DELETION_REHEARSAL_LOCK.publicOrigin,
      },
      providerSnapshot: {
        replicas: 2, instanceCount: 2, instanceIdSha256s: instanceHashes,
        instanceStatuses: ["RUNNING", "RUNNING"],
        deploymentIdSha256: sha256Hex(live.deploymentId),
        snapshotIdSha256: sha256Hex(live.snapshotId),
        imageDigestSha256: sha256Hex(live.imageDigest),
        invariantSha256: accountDeletionRehearsalAttemptInvariantSha256(live),
        rowNamesSha256: sha256Hex(canonicalJson([...live.rowNames].sort())),
        rowCategory: "active", patchSha256: sha256Hex(canonicalJson(live.patch)),
        patchCategory: "empty",
      },
      runtime: {
        expected: "active", replicas: 2, publicExact: true, providerExact: true,
        runtimeUnavailableExact: false, replicaIdSha256s: instanceHashes,
        responseSha256s: {
          "/health": ["1".repeat(64), "2".repeat(64)],
          "/startup": ["3".repeat(64), "4".repeat(64)],
          "/ready": ["5".repeat(64), "6".repeat(64)],
        },
        providerReadinessSha256s: ["7".repeat(64), "8".repeat(64)],
      },
      checks: {
        policyExact: true, githubAuthorityExact: true, tokenScopesExact: true,
        cliExact: true, boundaryPreflightExact: true, providerTopologyExact: true,
        candidateExact: true, rowCategoryExact: true, stagedPatchExact: true,
        activationMarkerExact: true, runtimeProofExact: true,
        boundaryPostflightExact: true,
      },
      mutationCredentialExposed: false, secretMaterialIncluded: false,
    };
    const args = {
      operation: "quarantine-zero-retry-1" as const,
      candidateSha: candidate, activationRunId: "800",
      authorityFile: "/tmp/authority", prerequisiteFile: "/tmp/observation",
      evidenceDirectory: "/tmp/evidence",
    };
    expect(accountDeletionRehearsalActionPrepareInternals
      .snapshotStateExact(live, args)).toBe(true);
    expect(accountDeletionRehearsalActionPrepareInternals
      .quarantineRetryObservationExact(
        canonicalJson(observation), live, args, "900", authoritySource,
      )).toBe(true);
    expect(accountDeletionRehearsalActionPrepareInternals
      .quarantineRetryObservationExact(canonicalJson({ ...observation,
        providerSnapshot: { ...observation.providerSnapshot,
          invariantSha256: "f".repeat(64) },
      }), live, args, "900", authoritySource)).toBe(false);
    expect(accountDeletionRehearsalActionPrepareInternals
      .quarantineRetryObservationExact(canonicalJson({ ...observation,
        state: "SAFE_TWO_PREACTIVATION",
      }), live, args, "900", authoritySource)).toBe(false);

    const cleanupRows = [
      ...ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS,
      "ACCOUNT_DELETION_NOTICE_MODE",
      "SUPABASE_OAUTH_PROVIDERS",
    ];
    const safeOne = {
      ...live,
      rowNames: cleanupRows,
      replicas: 1,
      instances: [live.instances[0]!],
    };
    const safeOneInstanceHashes = [sha256Hex(safeOne.instances[0]!.id)];
    const safeOneObservation = {
      ...observation,
      state: "SAFE_ONE_FINAL",
      providerSnapshot: {
        ...observation.providerSnapshot,
        replicas: 1,
        instanceCount: 1,
        instanceIdSha256s: safeOneInstanceHashes,
        instanceStatuses: ["RUNNING"],
        invariantSha256:
          accountDeletionRehearsalAttemptInvariantSha256(safeOne),
        rowNamesSha256: sha256Hex(canonicalJson([...safeOne.rowNames].sort())),
        rowCategory: "cleanup",
      },
      runtime: {
        ...observation.runtime,
        expected: "safe",
        replicas: 1,
        replicaIdSha256s: ["9".repeat(64)],
        responseSha256s: {
          "/health": ["1".repeat(64)],
          "/startup": ["2".repeat(64)],
          "/ready": ["3".repeat(64)],
        },
        providerReadinessSha256s: ["4".repeat(64)],
      },
    };
    const secondRetryArgs = {
      ...args,
      operation: "quarantine-zero-retry-2" as const,
    };
    expect(accountDeletionRehearsalActionPrepareInternals
      .snapshotStateExact(safeOne, secondRetryArgs)).toBe(true);
    expect(accountDeletionRehearsalActionPrepareInternals
      .quarantineRetryObservationExact(
        canonicalJson(safeOneObservation), safeOne, secondRetryArgs,
        "900", authoritySource,
      )).toBe(true);
  });

  it("classifies exact two-replica stored/runtime skew without admitting foreign markers", () => {
    const activeRows = [
      ...ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS,
      ...Object.keys(ACCOUNT_DELETION_REHEARSAL_ACTIVATION_VARIABLES),
      accountDeletionRehearsalRunMarkerName("800"),
    ];
    const cleanupRows = [
      ...ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS,
      "ACCOUNT_DELETION_NOTICE_MODE",
      "SUPABASE_OAUTH_PROVIDERS",
    ];
    const base = {
      rowNames: activeRows, replicas: 2, deploymentId: deployment,
      snapshotId: snapshot, candidateSha: candidate,
      imageDigest: `sha256:${"b".repeat(64)}`, patch: {},
      instances: [
        { id: "44444444-4444-4444-8444-444444444444", status: "RUNNING" },
        { id: "55555555-5555-4555-8555-555555555555", status: "RUNNING" },
      ],
    };
    const proof = (expected: "active" | "safe") => ({
      expected, replicas: 2, publicExact: true, providerExact: true,
      runtimeUnavailableExact: false,
      replicaIdSha256s: ["1".repeat(64), "2".repeat(64)],
      responseSha256s: {
        "/health": ["3".repeat(64), "4".repeat(64)],
        "/startup": ["5".repeat(64), "6".repeat(64)],
        "/ready": ["7".repeat(64), "8".repeat(64)],
      },
      providerReadinessSha256s: ["9".repeat(64), "a".repeat(64)],
    });
    const binding = { candidateSha: candidate, activationRunId: "800" };
    expect(accountDeletionRehearsalStateClassifierInternals
      .twoReplicaObservedState(base, binding, proof("safe")))
      .toBe("ACTIVATION_STORED_SAFE_TWO");
    expect(accountDeletionRehearsalStateClassifierInternals
      .twoReplicaObservedState(base, binding, proof("active")))
      .toBe("ACTIVE_TWO");
    expect(accountDeletionRehearsalStateClassifierInternals
      .twoReplicaObservedState({
        ...base,
        patch: accountDeletionRehearsalCleanupPatchForRun("800"),
      }, binding, proof("active"))).toBe("CLEANUP_STAGED_ACTIVE_TWO");
    expect(accountDeletionRehearsalStateClassifierInternals
      .twoReplicaObservedState({
        ...base,
        patch: accountDeletionRehearsalCleanupPatchForRun("800"),
      }, binding, proof("safe"))).toBeNull();
    expect(accountDeletionRehearsalStateClassifierInternals
      .twoReplicaObservedState({
        ...base,
        patch: accountDeletionRehearsalCleanupPatchForRun("801"),
      }, binding, proof("active"))).toBeNull();
    expect(accountDeletionRehearsalStateClassifierInternals
      .twoReplicaObservedState({
        ...base,
        patch: { services: { [service]: { variables: { foreign: null } } } },
      }, binding, proof("active"))).toBeNull();
    expect(accountDeletionRehearsalStateClassifierInternals
      .twoReplicaObservedState({ ...base, rowNames: cleanupRows }, binding,
        proof("active"))).toBe("CLEANUP_STORED_ACTIVE_TWO");
    expect(accountDeletionRehearsalStateClassifierInternals
      .twoReplicaObservedState({ ...base, rowNames: cleanupRows }, binding,
        proof("safe"))).toBe("CLEANUP_STORED_SAFE_TWO");
    expect(accountDeletionRehearsalStateClassifierInternals
      .rowCategory(cleanupRows, "800")).toBe("cleanup");
    expect(accountDeletionRehearsalStateClassifierInternals
      .twoReplicaObservedState({ ...base, rowNames: [
        ...ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS,
        ...Object.keys(ACCOUNT_DELETION_REHEARSAL_ACTIVATION_VARIABLES),
        accountDeletionRehearsalRunMarkerName("801"),
      ] }, binding, proof("safe"))).toBeNull();
  });

  it("treats active zero as contained pending cleanup and permits cleanup at zero", () => {
    const activeRows = [
      ...ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS,
      ...Object.keys(ACCOUNT_DELETION_REHEARSAL_ACTIVATION_VARIABLES),
      accountDeletionRehearsalRunMarkerName("800"),
    ];
    const cleanupRows = [
      ...ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS,
      "ACCOUNT_DELETION_NOTICE_MODE",
      "SUPABASE_OAUTH_PROVIDERS",
    ];
    const zero = {
      rowNames: activeRows, replicas: 0, deploymentId: deployment,
      snapshotId: snapshot, candidateSha: candidate,
      imageDigest: `sha256:${"b".repeat(64)}`, patch: {}, instances: [],
    };
    const binding = { candidateSha: candidate, activationRunId: "800" };
    expect(accountDeletionRehearsalStateClassifierInternals
      .quarantinedZeroState(zero, binding))
      .toBe("QUARANTINED_ZERO_PENDING_CLEANUP");
    expect(accountDeletionRehearsalStateClassifierInternals
      .quarantinedZeroState({ ...zero,
        patch: accountDeletionRehearsalCleanupPatchForRun("800") }, binding))
      .toBe("QUARANTINED_ZERO_PENDING_CLEANUP");
    expect(accountDeletionRehearsalStateClassifierInternals
      .quarantinedZeroState({ ...zero, rowNames: cleanupRows }, binding))
      .toBe("QUARANTINED_ZERO");
    expect(accountDeletionRehearsalQuarantineInternals
      .quarantinedZeroCleanupExact({ ...zero, rowNames: cleanupRows }))
      .toBe(true);

    const reconcileArgs = {
      operation: "reconcile-cleanup" as const,
      candidateSha: candidate, activationRunId: "800",
      authorityFile: "/tmp/authority", prerequisiteFile: null,
      evidenceDirectory: "/tmp/evidence",
    };
    expect(accountDeletionRehearsalActionPrepareInternals.snapshotStateExact(
      zero, reconcileArgs,
    )).toBe(true);
    expect(accountDeletionRehearsalActionPrepareInternals.snapshotStateExact(
      { ...zero, patch: accountDeletionRehearsalCleanupPatchForRun("800") },
      reconcileArgs,
    )).toBe(true);
    expect(accountDeletionRehearsalActionPrepareInternals.snapshotStateExact(
      { ...zero, patch: { foreign: true } }, reconcileArgs,
    )).toBe(false);
    const transitionArgs = {
      operation: "reconcile-cleanup" as const,
      candidateSha: candidate, activationRunId: "800",
      authorityFile: "/tmp/authority", prerequisiteFile: "/tmp/observation",
      evidenceDirectory: "/tmp/evidence",
    };
    expect(accountDeletionRehearsalTransitionInternals.transitionPreflightState(
      zero, transitionArgs,
    )).toMatchObject({ targetPreflightExact: true,
      exactStrandedCleanupPatch: false, cleanupAlreadyStored: false });
    expect(accountDeletionRehearsalTransitionInternals.transitionPreflightState(
      zero, { ...transitionArgs, operation: "store-cleanup" },
    ).targetPreflightExact).toBe(false);
    expect(accountDeletionRehearsalTransitionInternals.transitionPreflightState(
      { ...zero, patch: accountDeletionRehearsalCleanupPatchForRun("800") },
      transitionArgs,
    )).toMatchObject({ targetPreflightExact: true,
      exactStrandedCleanupPatch: true });
    expect(accountDeletionRehearsalTransitionInternals.transitionPreflightState(
      { ...zero, rowNames: cleanupRows }, transitionArgs,
    )).toMatchObject({ targetPreflightExact: true, cleanupAlreadyStored: true });
    const containedArgs = {
      ...reconcileArgs,
      operation: "cleanup-contained-zero" as const,
      prerequisiteFile: "/tmp/observation",
    };
    expect(accountDeletionRehearsalActionPrepareInternals.snapshotStateExact(
      zero, containedArgs,
    )).toBe(true);
    expect(accountDeletionRehearsalActionPrepareInternals.snapshotStateExact(
      { ...zero, patch: accountDeletionRehearsalCleanupPatchForRun("800") },
      containedArgs,
    )).toBe(true);
    expect(accountDeletionRehearsalActionPrepareInternals.snapshotStateExact(
      { ...zero, replicas: 2, instances: [
        { id: "44444444-4444-4444-8444-444444444444", status: "RUNNING" },
        { id: "55555555-5555-4555-8555-555555555555", status: "RUNNING" },
      ] }, containedArgs,
    )).toBe(false);
    expect(accountDeletionRehearsalTransitionInternals.transitionPreflightState(
      zero, { ...transitionArgs, operation: "cleanup-contained-zero" },
    ).targetPreflightExact).toBe(true);
    expect(accountDeletionRehearsalTransitionInternals.transitionPreflightState(
      { ...zero, replicas: 2, instances: [
        { id: "44444444-4444-4444-8444-444444444444", status: "RUNNING" },
        { id: "55555555-5555-4555-8555-555555555555", status: "RUNNING" },
      ] }, { ...transitionArgs, operation: "cleanup-contained-zero" },
    ).targetPreflightExact).toBe(false);
    const cleanupPatch = accountDeletionRehearsalCleanupPatchForRun("800");
    expect(accountDeletionRehearsalTransitionInternals.dualCleanupPatchReadbackExact({
      data: {
        masked: { environmentId: environment, patch: cleanupPatch },
        decrypted: { environmentId: environment, patch: cleanupPatch },
      },
    }, "800")).toBe(true);
    expect(accountDeletionRehearsalTransitionInternals.dualCleanupPatchReadbackExact({
      data: {
        masked: { environmentId: environment, patch: cleanupPatch },
        decrypted: { environmentId: environment, patch: { foreign: true } },
      },
    }, "800")).toBe(false);
  });
});
