import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalPostgresBackupJson } from "../src/lib/postgres-logical-backup.js";
import {
  assertEmergencyCleanupRenewalSuccessor,
  EmergencyCleanupStateError,
  initializeEmergencyCleanupState,
  parseEmergencyCleanupState,
  recoverEmergencyCleanupAcknowledgements,
  reconcileEmergencyCleanupState,
  renewEmergencyCleanupState,
  type EmergencyCleanupArmVerification,
  type EmergencyCleanupState,
} from "../scripts/lib/production-promotion-recovery-emergency-cleanup-state.js";

const candidate = "a".repeat(40);
const activationRunId = "123456789";
const firstCleanupRunId = "987654321";
const secondCleanupRunId = "987654322";

function hash(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const target = {
  candidateSha: candidate,
  activationRunId,
  projectId: "11111111-1111-4111-8111-111111111111",
  projectName: "pintpath-disposable-restore-20260814",
  environmentId: "22222222-2222-4222-8222-222222222222",
  environmentName: "pintpath-disposable-restore-20260814",
  inventorySha256: "1".repeat(64),
  workspaceId: "33333333-3333-4333-8333-333333333333",
  workspaceName: "PintPath recovery rehearsals",
  workspaceProjectInventorySha256: "2".repeat(64),
  supabaseProjectRef: "bcdefghijklmnopqrstu",
  supabaseProjectName: "pintpath-disposable-restore-20260814",
  organizationSlugSha256: "3".repeat(64),
  destinationOriginSha256: "4".repeat(64),
  destinationRestoreAuthoritySha256: "5".repeat(64),
} as const;

function arm(
  input: Partial<EmergencyCleanupArmVerification> = {},
): EmergencyCleanupArmVerification {
  return {
    schemaVersion: 2,
    kind: "pintpath-production-promotion-recovery-emergency-cleanup-arm-verification",
    ok: true,
    ...target,
    armTransition: "initial",
    armLineageIdSha256: hash(canonicalPostgresBackupJson(target)),
    previousArmAuthoritySha256: null,
    renewalSequence: 0,
    issuedAt: "2026-08-14T04:00:00.000Z",
    expiresAt: "2026-08-14T06:00:00.000Z",
    authoritySha256: "6".repeat(64),
    authorityPublicKeySha256: "7".repeat(64),
    ...input,
  };
}

function withReceiptHash(value: Record<string, unknown>) {
  return {
    ...value,
    receiptSha256: hash(canonicalPostgresBackupJson(value)),
  };
}

function railwayTerminal(
  state: EmergencyCleanupState,
  runId: string,
  outcome: "deleted" | "reconciled_from_prior_ack" = "deleted",
  workflowPath = ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml",
) {
  const receipt = withReceiptHash({
    schemaVersion: 1,
    kind: "pintpath-production-recovery-railway-teardown",
    ok: true,
    outcome,
    completedAt: "2026-08-14T05:10:00.000Z",
    candidateSha: candidate,
    observedCleanupRunId: runId,
    signedActivationRunId: activationRunId,
    cleanupWorkflowPath: workflowPath,
    projectId: target.projectId,
    projectName: target.projectName,
    environmentId: target.environmentId,
    environmentName: target.environmentName,
    expectedInventorySha256: target.inventorySha256,
    workspaceId: target.workspaceId,
    workspaceName: target.workspaceName,
    expectedWorkspaceProjectInventorySha256:
      target.workspaceProjectInventorySha256,
    emergencyCleanupArmAuthoritySha256: state.currentArmAuthoritySha256,
    policySha256:
      "4d1c22a4d5779f9383e133a1da8cfa40d10a6317343298210efc81e4f18403ef",
    teardownAuthoritySha256: "8".repeat(64),
    teardownAuthorityPublicKeySha256: "9".repeat(64),
    teardownAuthorityReviewerIdSha256: "a".repeat(64),
    intentSha256: "b".repeat(64),
    preflightInventorySha256: "c".repeat(64),
    postflightInventorySha256: "d".repeat(64),
    preflightWorkspaceProjectInventorySha256: "e".repeat(64),
    postflightWorkspaceProjectInventorySha256: "f".repeat(64),
    deleteAttempts: outcome === "deleted" ? 1 : 0,
    retryAllowed: false,
    checks: {
      policyExact: true,
      githubAuthorityExact: true,
      targetNotProtected: true,
      signedAuthorityExact: true,
      credentialsSeparatedExact: true,
      metadataAuthoritiesAgree: true,
      completeInventoryExact: true,
      signedServiceInventoryExact: true,
      workspaceAuthoritiesExact: true,
      completeWorkspaceInventoryExact: true,
      signedWorkspaceInventoryExact: true,
      durableIntentExact: true,
      deleteAttemptedAtMostOnce: true,
      acknowledgementExact: true,
      postflightAttempted: true,
      targetAbsentExact: true,
      terminalEvidenceExact: true,
    },
  });
  return {
    schemaVersion: "pintpath-production-recovery-railway-teardown-terminal/v1",
    receipt,
  };
}

function supabaseTerminal(
  state: EmergencyCleanupState,
  runId: string,
  outcome: "deleted" | "reconciled_from_prior_ack" = "deleted",
  workflowPath = ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml",
  cleanupMode: "orderly" | "emergency" = "emergency",
) {
  const receipt = withReceiptHash({
    schemaVersion: 1,
    kind: "pintpath-protected-disposable-supabase-project-teardown",
    ok: true,
    executorState: "GITHUB_ENVIRONMENT_PROTECTED",
    outcome,
    completedAt: "2026-08-14T05:20:00.000Z",
    candidateSha: candidate,
    observedCleanupRunId: runId,
    signedActivationRunId: activationRunId,
    cleanupWorkflowPath: workflowPath,
    projectRef: target.supabaseProjectRef,
    projectName: target.supabaseProjectName,
    destinationOriginSha256: target.destinationOriginSha256,
    organizationSlugSha256: target.organizationSlugSha256,
    targetRailwayProjectId: target.projectId,
    targetRailwayEnvironmentId: target.environmentId,
    cleanupMode,
    destinationRestoreAuthoritySha256: target.destinationRestoreAuthoritySha256,
    emergencyCleanupArmAuthoritySha256: state.currentArmAuthoritySha256,
    purgeReceiptSha256: cleanupMode === "orderly" ? "0".repeat(64) : null,
    policySha256:
      "fd3a45234a02ba3df8fadb6e2f36d1070a72be75eec792986f85abd74e5f6796",
    teardownAuthoritySha256: "8".repeat(64),
    teardownAuthorityPublicKeySha256: "9".repeat(64),
    teardownAuthorityReviewerIdSha256: "a".repeat(64),
    intentSha256: "b".repeat(64),
    preflightInventorySha256: "c".repeat(64),
    postflightInventorySha256: "d".repeat(64),
    deleteAttempts: outcome === "deleted" ? 1 : 0,
    retryAllowed: false,
    checks: {
      policyExact: true,
      githubAuthorityExact: true,
      targetNotProtected: true,
      orderlyPurgeEvidenceExactOrNotRequired: true,
      signedAuthorityExact: true,
      credentialsSeparatedExact: true,
      preflightInventoryExact: true,
      targetMetadataExact: true,
      durableIntentExact: true,
      deleteAttemptedAtMostOnce: true,
      acknowledgementExact: true,
      postflightAttempted: true,
      targetAbsentExact: true,
      terminalEvidenceExact: true,
    },
  });
  return {
    schemaVersion:
      "pintpath-protected-disposable-supabase-project-teardown-terminal/v1",
    receipt,
  };
}

describe("production promotion-recovery durable cleanup state", () => {
  it("rejects a second initial arm and permits only same-target signed renewal lineage", () => {
    const state = initializeEmergencyCleanupState(
      arm(),
      "2026-08-14T04:01:00.000Z",
    );
    expect(() =>
      renewEmergencyCleanupState(
        state,
        arm({
          armTransition: "renewal",
          previousArmAuthoritySha256: state.currentArmAuthoritySha256,
          renewalSequence: 1,
          projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          authoritySha256: "8".repeat(64),
        }),
        "2026-08-15T05:00:00.000Z",
      ),
    ).toThrowError(new EmergencyCleanupStateError("transition_invalid"));
    expect(() =>
      initializeEmergencyCleanupState(
        arm({ activationRunId: "123456790" }),
        "2026-08-14T04:02:00.000Z",
        state,
      ),
    ).toThrowError(new EmergencyCleanupStateError("transition_invalid"));
    const renewed = renewEmergencyCleanupState(
      state,
      arm({
        armTransition: "renewal",
        previousArmAuthoritySha256: state.currentArmAuthoritySha256,
        renewalSequence: 1,
        authoritySha256: "8".repeat(64),
        issuedAt: "2026-08-15T04:00:00.000Z",
        expiresAt: "2026-08-15T06:00:00.000Z",
      }),
      "2026-08-15T04:01:00.000Z",
    );
    expect(renewed).toMatchObject({
      status: "open",
      armRenewalSequence: 1,
      previousStateSha256: state.stateSha256,
    });
  });

  it("rebases an A-run delete acknowledgement only across an exact signed A-to-B renewal successor", () => {
    const stateA = initializeEmergencyCleanupState(
      arm(),
      "2026-08-14T04:01:00.000Z",
    );
    const armB = arm({
      armTransition: "renewal",
      previousArmAuthoritySha256: stateA.currentArmAuthoritySha256,
      renewalSequence: 1,
      authoritySha256: "8".repeat(64),
      issuedAt: "2026-08-14T04:30:00.000Z",
      expiresAt: "2026-08-14T07:00:00.000Z",
    });
    const stateB = renewEmergencyCleanupState(
      stateA,
      armB,
      "2026-08-14T04:31:00.000Z",
    );
    expect(
      assertEmergencyCleanupRenewalSuccessor({
        previous: stateA,
        current: stateB,
        arm: armB,
      }),
    ).toEqual(stateB);
    const rebased = reconcileEmergencyCleanupState({
      current: stateB,
      arm: armB,
      observedCleanupRunId: firstCleanupRunId,
      railwayTerminal: railwayTerminal(stateA, firstCleanupRunId),
      now: "2026-08-14T05:11:00.000Z",
    });
    expect(rebased).toMatchObject({
      status: "open",
      currentArmAuthoritySha256: armB.authoritySha256,
      railwayDeleteAcknowledgement: {
        receipt: { emergencyCleanupArmAuthoritySha256: arm().authoritySha256 },
      },
    });
    expect(() =>
      assertEmergencyCleanupRenewalSuccessor({
        previous: stateA,
        current: {
          ...stateB,
          projectName: "pintpath-disposable-restore-other",
        },
        arm: armB,
      }),
    ).toThrowError(new EmergencyCleanupStateError("renewal_successor_invalid"));
  });

  it("recovers an exact run-bound raw ack artifact and rejects a mismatched origin run", () => {
    const state = initializeEmergencyCleanupState(
      arm(),
      "2026-08-14T04:01:00.000Z",
    );
    const terminal = railwayTerminal(state, firstCleanupRunId);
    const recovered = recoverEmergencyCleanupAcknowledgements({
      current: state,
      arm: arm(),
      railwayTerminal: terminal,
      railwayCleanupRunId: firstCleanupRunId,
      now: "2026-08-14T05:12:00.000Z",
    });
    expect(recovered.railwayDeleteAcknowledgement).toEqual(terminal);
    expect(() =>
      recoverEmergencyCleanupAcknowledgements({
        current: state,
        arm: arm(),
        railwayTerminal: terminal,
        railwayCleanupRunId: secondCleanupRunId,
        now: "2026-08-14T05:12:00.000Z",
      }),
    ).toThrowError(new EmergencyCleanupStateError("transition_invalid"));
  });

  it("turns exact same-run orderly activation cleanup into durable DISARMED state", () => {
    const state = initializeEmergencyCleanupState(
      arm(),
      "2026-08-14T04:01:00.000Z",
    );
    const activationWorkflow =
      ".github/workflows/activate-production-promotion-recovery.yml";
    const disarmed = reconcileEmergencyCleanupState({
      current: state,
      arm: arm(),
      observedCleanupRunId: activationRunId,
      railwayTerminal: railwayTerminal(
        state,
        activationRunId,
        "deleted",
        activationWorkflow,
      ),
      supabaseTerminal: supabaseTerminal(
        state,
        activationRunId,
        "deleted",
        activationWorkflow,
        "orderly",
      ),
      now: "2026-08-14T05:21:00.000Z",
    });
    expect(disarmed).toMatchObject({
      status: "disarmed",
      disarmTerminal: { observedCleanupRunId: activationRunId },
    });
    expect(() =>
      parseEmergencyCleanupState(canonicalPostgresBackupJson(disarmed)),
    ).not.toThrow();
  });

  it("recovers a complete activation cleanup artifact after activation CAS loss and converges on fresh watchdog absence", () => {
    const state = initializeEmergencyCleanupState(
      arm(),
      "2026-08-14T04:01:00.000Z",
    );
    const activationWorkflow =
      ".github/workflows/activate-production-promotion-recovery.yml";
    const activationRailway = railwayTerminal(
      state,
      activationRunId,
      "deleted",
      activationWorkflow,
    );
    const activationSupabase = supabaseTerminal(
      state,
      activationRunId,
      "deleted",
      activationWorkflow,
      "orderly",
    );
    const providerState = recoverEmergencyCleanupAcknowledgements({
      current: state,
      arm: arm(),
      railwayTerminal: activationRailway,
      railwayCleanupRunId: activationRunId,
      supabaseTerminal: activationSupabase,
      supabaseCleanupRunId: activationRunId,
      now: "2026-08-14T05:22:00.000Z",
    });
    expect(providerState).toMatchObject({
      status: "open",
      railwayDeleteAcknowledgement: activationRailway,
      supabaseDeleteAcknowledgement: activationSupabase,
    });
    const disarmed = reconcileEmergencyCleanupState({
      current: state,
      arm: arm(),
      observedCleanupRunId: secondCleanupRunId,
      priorRailwayTerminal: activationRailway,
      priorRailwayCleanupRunId: activationRunId,
      priorSupabaseTerminal: activationSupabase,
      priorSupabaseCleanupRunId: activationRunId,
      railwayTerminal: railwayTerminal(
        providerState,
        secondCleanupRunId,
        "reconciled_from_prior_ack",
      ),
      supabaseTerminal: supabaseTerminal(
        providerState,
        secondCleanupRunId,
        "reconciled_from_prior_ack",
      ),
      now: "2026-08-14T05:23:00.000Z",
    });
    expect(disarmed).toMatchObject({
      status: "disarmed",
      disarmTerminal: { observedCleanupRunId: secondCleanupRunId },
    });
  });

  it("converges Railway-success/Supabase-failure across two runs using exact prior ack plus fresh absence", () => {
    const state = initializeEmergencyCleanupState(
      arm(),
      "2026-08-14T04:01:00.000Z",
    );
    const partial = reconcileEmergencyCleanupState({
      current: state,
      arm: arm(),
      observedCleanupRunId: firstCleanupRunId,
      railwayTerminal: railwayTerminal(state, firstCleanupRunId),
      now: "2026-08-14T05:11:00.000Z",
    });
    expect(partial).toMatchObject({
      status: "open",
      supabaseDeleteAcknowledgement: null,
    });
    expect(partial.railwayDeleteAcknowledgement).not.toBeNull();
    const completed = reconcileEmergencyCleanupState({
      current: parseEmergencyCleanupState(canonicalPostgresBackupJson(partial)),
      arm: arm(),
      observedCleanupRunId: secondCleanupRunId,
      railwayTerminal: railwayTerminal(
        partial,
        secondCleanupRunId,
        "reconciled_from_prior_ack",
      ),
      supabaseTerminal: supabaseTerminal(partial, secondCleanupRunId),
      now: "2026-08-14T05:21:00.000Z",
    });
    expect(completed).toMatchObject({
      status: "disarmed",
      disarmTerminal: {
        observedCleanupRunId: secondCleanupRunId,
      },
    });
    expect(() =>
      parseEmergencyCleanupState(canonicalPostgresBackupJson(completed)),
    ).not.toThrow();
  });

  it("rejects a reconciled absence when no exact prior delete acknowledgement exists", () => {
    const state = initializeEmergencyCleanupState(
      arm(),
      "2026-08-14T04:01:00.000Z",
    );
    expect(() =>
      reconcileEmergencyCleanupState({
        current: state,
        arm: arm(),
        observedCleanupRunId: secondCleanupRunId,
        railwayTerminal: railwayTerminal(
          state,
          secondCleanupRunId,
          "reconciled_from_prior_ack",
        ),
        now: "2026-08-14T05:21:00.000Z",
      }),
    ).toThrowError(new EmergencyCleanupStateError("transition_invalid"));
  });

  it("permits a new target only after the prior state has an exact disarm terminal", () => {
    const state = initializeEmergencyCleanupState(
      arm(),
      "2026-08-14T04:01:00.000Z",
    );
    const disarmed = reconcileEmergencyCleanupState({
      current: state,
      arm: arm(),
      observedCleanupRunId: firstCleanupRunId,
      railwayTerminal: railwayTerminal(state, firstCleanupRunId),
      supabaseTerminal: supabaseTerminal(state, firstCleanupRunId),
      now: "2026-08-14T05:21:00.000Z",
    });
    const nextTarget = { ...target, activationRunId: "123456790" };
    const next = initializeEmergencyCleanupState(
      arm({
        activationRunId: nextTarget.activationRunId,
        armLineageIdSha256: hash(canonicalPostgresBackupJson(nextTarget)),
        authoritySha256: "8".repeat(64),
      }),
      "2026-08-14T05:22:00.000Z",
      disarmed,
    );
    expect(next).toMatchObject({
      status: "open",
      activationRunId: "123456790",
      previousStateSha256: disarmed.stateSha256,
      railwayDeleteAcknowledgement: null,
      supabaseDeleteAcknowledgement: null,
    });
  });
});
