import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACCOUNT_DELETION_REHEARSAL_ACTIVATION_VARIABLES,
  ACCOUNT_DELETION_REHEARSAL_CLEANUP_VARIABLES,
  ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS,
  ACCOUNT_DELETION_REHEARSAL_LOCK,
  accountDeletionRehearsalActivationVariablesForRun,
  accountDeletionRehearsalAttemptInvariantSha256,
  accountDeletionRehearsalAttemptSnapshotSha256,
  accountDeletionRehearsalCleanupPatchForRun,
  accountDeletionRehearsalRunMarkerName,
  canonicalJson,
  createAccountDeletionRehearsalAttemptArm,
  exactCleanupPatch,
  parseAccountDeletionRehearsalAttemptArm,
  parseAccountDeletionRehearsalPolicy,
  rowNamesSatisfyActivationPreflight,
  rowNamesSatisfyActivationStored,
  rowNamesSatisfyCleanupStored,
  runtimeStateExact,
  sha256Hex,
} from "../scripts/lib/permanent-staging-account-deletion-rehearsal.js";

const root = path.resolve(import.meta.dirname, "..");
const candidate = "a".repeat(40);
const replica = "b".repeat(64);

function runtime(route: "/health" | "/startup" | "/ready", active: boolean) {
  const accountDeletionNotifications = route === "/startup"
    ? { required: active, configured: active }
    : active
      ? { required: true, operationalGateReady: true }
      : { required: false, status: "missing", scheduler: { status: "not_configured" } };
  return {
    ok: true,
    data: {
      service: "pint-path",
      deployment: {
        commitSha: candidate,
        environment: "production",
        replicaIdSha256: replica,
      },
      automaticMaintenance: { enabled: true, candidateBound: true },
      ...(route === "/health" ? {} : {
        dependencies: { accountDeletionNotifications },
      }),
    },
  };
}

describe("permanent-staging account-deletion rehearsal policy", () => {
  it("parses only the exact locked policy and exact variable maps", () => {
    const source = fs.readFileSync(path.join(root,
      "ops/railway/permanent-staging-account-deletion-rehearsal-policy.json"),
    "utf8");
    const policy = parseAccountDeletionRehearsalPolicy(source);
    expect(policy).not.toBeNull();
    expect(policy).toMatchObject({
      projectId: ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
      stagingEnvironmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
      replicas: { safeInitial: 1, rehearsal: 2, safeFinal: 1, quarantine: 0 },
      failurePolicy: {
        activationStoredSafeTwoAction: "RECONCILE_CLEANUP",
        cleanupStoredActiveTwoWithoutApplySafeAttempt: "APPLY_SAFE",
        cleanupStoredActiveTwoWithApplySafeAttempt: "QUARANTINE_ZERO",
        cleanupStagedActiveTwoWithoutReconcileAttempt: "RECONCILE_CLEANUP",
        cleanupStagedActiveTwoWithReconcileAttempt: "QUARANTINE_ZERO",
        containedZeroCleanupOperation: "cleanup-contained-zero",
        containedZeroCleanupRequiresZeroInstances: true,
        containedZeroCleanupMaximumAttempts: 1,
        containedZeroCleanupExhaustedAction: "MANUAL_FAIL_CLOSED",
        quarantineAttemptOperations: [
          "quarantine-zero",
          "quarantine-zero-retry-1",
          "quarantine-zero-retry-2",
        ],
        quarantineGlobalMaximumAttempts: 3,
        quarantineRetriesRequireFreshExactNonterminalObservation: true,
        quarantineLadderExhaustedAction: "MANUAL_FAIL_CLOSED",
        nonterminalObservationStates: [
          "SAFE_ONE_FINAL",
          "ACTIVATION_STORED_SAFE_TWO",
          "ACTIVE_TWO",
          "CLEANUP_STAGED_ACTIVE_TWO",
          "CLEANUP_STORED_ACTIVE_TWO",
          "CLEANUP_STORED_SAFE_TWO",
        ],
      },
    });
    expect(policy?.activationVariables).toEqual(
      ACCOUNT_DELETION_REHEARSAL_ACTIVATION_VARIABLES);
    expect(policy?.cleanupVariables).toEqual(ACCOUNT_DELETION_REHEARSAL_CLEANUP_VARIABLES);
    expect(parseAccountDeletionRehearsalPolicy(source.replace(
      ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
      ACCOUNT_DELETION_REHEARSAL_LOCK.forbiddenProductionEnvironmentId,
    ))).toBeNull();
  });

  it("requires all credential rows and rejects rehearsal markers before activation", () => {
    expect(rowNamesSatisfyActivationPreflight(
      [...ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS],
    )).toBe(true);
    expect(rowNamesSatisfyActivationPreflight([
      ...ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS,
      "ACCOUNT_DELETION_REHEARSAL_ENABLED",
    ])).toBe(false);
    expect(rowNamesSatisfyCleanupStored([
      ...ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS,
      "ACCOUNT_DELETION_NOTICE_MODE",
      "SUPABASE_OAUTH_PROVIDERS",
    ])).toBe(true);
  });

  it("binds activation and cleanup to exactly one activation-run marker", () => {
    const runId = "900";
    const otherRunId = "901";
    const marker = accountDeletionRehearsalRunMarkerName(runId);
    const activeRows = [
      ...ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS,
      ...Object.keys(ACCOUNT_DELETION_REHEARSAL_ACTIVATION_VARIABLES),
      marker,
    ];
    expect(accountDeletionRehearsalActivationVariablesForRun(runId)[marker])
      .toBe("true");
    expect(rowNamesSatisfyActivationStored(activeRows, runId)).toBe(true);
    expect(rowNamesSatisfyActivationStored(activeRows, otherRunId)).toBe(false);
    expect(rowNamesSatisfyActivationStored([
      ...activeRows, accountDeletionRehearsalRunMarkerName(otherRunId),
    ], runId)).toBe(false);
    expect(exactCleanupPatch(
      accountDeletionRehearsalCleanupPatchForRun(runId), runId,
    )).toBe(true);
    expect(exactCleanupPatch(
      accountDeletionRehearsalCleanupPatchForRun(otherRunId), runId,
    )).toBe(false);
  });

  it("arms one snapshot while retaining a replica-insensitive provider invariant", () => {
    const snapshot = {
      rowNames: [...ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS],
      replicas: 2,
      deploymentId: "11111111-1111-4111-8111-111111111111",
      snapshotId: "22222222-2222-4222-8222-222222222222",
      candidateSha: candidate,
      imageDigest: `sha256:${"c".repeat(64)}`,
      patch: {},
      instances: [
        { id: "33333333-3333-4333-8333-333333333333", status: "RUNNING" },
        { id: "44444444-4444-4444-8444-444444444444", status: "RUNNING" },
      ],
    };
    const authoritySource = canonicalJson({ mode: "cleanup" });
    const prerequisiteSource = canonicalJson({ state: "safe-two" });
    const arm = createAccountDeletionRehearsalAttemptArm({
      operation: "converge-one", candidateSha: candidate,
      activationRunId: "800", githubRunId: "900", authoritySource,
      prerequisiteSource, snapshot,
    });
    const scaled = { ...snapshot, replicas: 1,
      instances: [snapshot.instances[0]!] };
    expect(accountDeletionRehearsalAttemptSnapshotSha256(scaled))
      .not.toBe(arm.providerSnapshotSha256);
    expect(accountDeletionRehearsalAttemptInvariantSha256(scaled))
      .toBe(arm.providerInvariantSha256);
    const source = canonicalJson(arm);
    expect(parseAccountDeletionRehearsalAttemptArm(source, {
      operation: "converge-one", candidateSha: candidate,
      activationRunId: "800", githubRunId: "900", authoritySource,
      prerequisiteSource, contentSha256: sha256Hex(source),
    })).not.toBeNull();
  });

  it("accepts safe deletion state while the independent global worker remains enabled", () => {
    for (const route of ["/health", "/startup", "/ready"] as const) {
      expect(runtimeStateExact(route, runtime(route, false), candidate, "safe"))
        .not.toBeNull();
    }
  });

  it("requires the active gate and rejects a configured scheduler in safe state", () => {
    expect(runtimeStateExact("/ready", runtime("/ready", true), candidate, "active"))
      .not.toBeNull();
    const unsafe = runtime("/ready", false);
    unsafe.data.dependencies!.accountDeletionNotifications = {
      required: false,
      status: "ready",
      scheduler: { status: "configured" },
    };
    expect(runtimeStateExact("/ready", unsafe, candidate, "safe")).toBeNull();
  });
});
