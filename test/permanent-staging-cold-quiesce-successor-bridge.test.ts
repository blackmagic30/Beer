import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  COLD_QUIESCE_SUCCESSOR_BRIDGE,
  COLD_QUIESCE_SUCCESSOR_BRIDGE_SCHEMA,
  parseColdQuiesceSuccessorBridgeArguments,
  runPermanentStagingColdQuiesceSuccessorBridge,
} from "../scripts/verify-permanent-staging-cold-quiesce-successor-bridge.js";
import {
  COLD_RECOVERY_LOCK,
  sha256,
  type ColdRecoveryState,
} from "../scripts/lib/permanent-staging-cold-recovery.js";

const CANDIDATE = "a".repeat(40);
const CURRENT_PREPARE_RUN = "8999";
const CURRENT_RUN = "9000";
const FIXTURE_PREFIX = path.resolve(
  "test/fixtures/cold-quiesce-ambiguous-34153306935",
);

function currentAuthority(): string {
  return `${JSON.stringify({
    command: "verify-github-reviewed-candidate-authority",
    ok: true,
    schemaVersion: 1,
    kind: "pintpath-github-reviewed-candidate-authority",
    repository: COLD_RECOVERY_LOCK.repository,
    candidateSha: CANDIDATE,
    reviewedPrHeadSha: "b".repeat(40),
    reviewedPullRequestNumber: 91,
    operation: COLD_QUIESCE_SUCCESSOR_BRIDGE.operation,
    workflowPath:
      ".github/workflows/recover-permanent-staging-cold-zero.yml",
    workflowRunId: CURRENT_RUN,
    workflowRunAttempt: 1,
    workflowRunCreatedAt: "2026-09-08T00:10:00Z",
    reviewedPullRequestMergedAt: "2026-09-08T00:00:00Z",
    candidateHistoryMaximumAgeHours: 168,
    completeRetainedHistoryExact: true,
    safePriorSkippedWriteRunIds: [],
    priorAmbiguousColdQuiesceCandidateSha:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorCandidateSha,
    priorAmbiguousColdQuiesceReviewedHeadSha:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorReviewedHeadSha,
    priorAmbiguousColdQuiesceTreeSha:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorTreeSha,
    priorAmbiguousColdQuiescePullRequestNumber:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorPullRequestNumber,
    priorAmbiguousColdQuiesceCandidateMergedAt:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorMergedAt,
    priorAmbiguousColdQuiesceRunId:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorQuiesceRunId,
    priorAmbiguousColdQuiesceRunCompletedAt:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorQuiesceRunCompletedAt,
    coldQuiesceSuccessorGraceHours:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.successorGraceHours,
    coldQuiesceSuccessorDeadline:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.successorDeadline,
    coldQuiesceSuccessorWithinGraceExact: true,
    priorColdPrepareRunId:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorPrepareRunId,
    selectedColdPrepareRunId: CURRENT_PREPARE_RUN,
    priorFailedReadOnlyColdQuiesceReconcileRunId:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorReadOnlyReconcileRunId,
    priorAmbiguousColdQuiesceArtifactId:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.artifactId,
    priorAmbiguousColdQuiesceArtifactName:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.artifactName,
    priorAmbiguousColdQuiesceArtifactDigest:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.artifactDigest,
    coldQuiesceSuccessorDirectParentExact: true,
    coldQuiesceSuccessorPriorHistoryExact: true,
    coldQuiesceSuccessorAllRefsHistoryExact: true,
    coldQuiesceSuccessorCurrentPrepareExact: true,
    coldQuiesceSuccessorArtifactMetadataExact: true,
    coldQuiesceSuccessorBridgeRequired: true,
    successfulStagingDeploymentRunIds: [],
    stagingLifecycleSealed: false,
    reviewedAuthorityExact: true,
    freshDispatchWriteGuardExact: true,
  })}\n`;
}

function liveState(): ColdRecoveryState {
  return {
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    serviceInstanceId: COLD_RECOVERY_LOCK.serviceInstanceId,
    serviceId: COLD_RECOVERY_LOCK.serviceId,
    numReplicas: null,
    configuredReplicas: 1,
    configuredRegions: [{
      region: COLD_RECOVERY_LOCK.configuredRegionBefore,
      numReplicas: 1,
    }],
    deploymentRegions: [{
      region: COLD_RECOVERY_LOCK.region,
      numReplicas: 1,
    }],
    source: { repo: null, image: null },
    latestDeployment: {
      id: COLD_RECOVERY_LOCK.deploymentId,
      status: "FAILED",
      deploymentStopped: true,
      snapshotId: COLD_RECOVERY_LOCK.snapshotId,
    },
    activeDeployments: [],
    domains: [{
      kind: "service",
      id: COLD_RECOVERY_LOCK.domainId,
      domain: COLD_RECOVERY_LOCK.domain,
      targetPort: 8_080,
    }],
    deployment: {
      id: COLD_RECOVERY_LOCK.deploymentId,
      projectId: COLD_RECOVERY_LOCK.projectId,
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      snapshotId: COLD_RECOVERY_LOCK.snapshotId,
      commitHash: COLD_RECOVERY_LOCK.sourceSha,
      imageDigest: null,
      patchId: null,
    },
    rows: [],
  };
}

function testEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: COLD_RECOVERY_LOCK.repository,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: CURRENT_RUN,
    GITHUB_SHA: CANDIDATE,
    PINTPATH_PROTECTED_ENVIRONMENT: "permanent-staging-scale-evidence",
    PINTPATH_COLD_RECOVERY_CONFIRMATION:
      `QUIESCE_PERMANENT_STAGING_COLD_RECOVERY_TO_ZERO_FOR_${CANDIDATE}_FROM_${COLD_RECOVERY_LOCK.sourceSha}`,
    PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN:
      "production-metadata-token-long-enough",
    PINTPATH_RAILWAY_STAGING_METADATA_TOKEN:
      "staging-metadata-token-long-enough",
    ...overrides,
  };
}

function prepareFiles() {
  const root = fs.realpathSync(fs.mkdtempSync(
    path.join(os.tmpdir(), "pintpath-cold-bridge-"),
  ));
  const prior = path.join(root, "prior");
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(prior, { mode: 0o700 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  const fixtures = [
    ["receipt", "cold-quiesce-receipt.json"],
    ["intent", "cold-quiesce-intent.json"],
    ["prerequisites", "prerequisites-verification.json"],
    ["reviewed-authority", "reviewed-authority.json"],
  ] as const;
  for (const [fixture, leaf] of fixtures) {
    fs.copyFileSync(`${FIXTURE_PREFIX}-${fixture}.json`, path.join(prior, leaf));
    fs.chmodSync(path.join(prior, leaf), 0o600);
  }
  const authorityFile = path.join(root, "reviewed-authority.json");
  fs.writeFileSync(authorityFile, currentAuthority(), {
    encoding: "utf8",
    mode: 0o600,
  });
  const argv = [
    "--candidate-sha",
    CANDIDATE,
    "--prepare-run-id",
    CURRENT_PREPARE_RUN,
    "--prior-candidate-sha",
    COLD_QUIESCE_SUCCESSOR_BRIDGE.priorCandidateSha,
    "--prior-quiesce-run-id",
    COLD_QUIESCE_SUCCESSOR_BRIDGE.priorQuiesceRunId,
    "--prior-artifact-dir",
    prior,
    "--reviewed-authority-file",
    authorityFile,
    "--evidence-dir",
    evidence,
  ];
  return { root, prior, evidence, authorityFile, argv };
}

function dependencies(
  state: ColdRecoveryState = liveState(),
  env: Readonly<Record<string, string | undefined>> = testEnvironment(),
) {
  return {
    env,
    readScope: vi.fn().mockResolvedValue({
      data: {
        projectToken: {
          projectId: COLD_RECOVERY_LOCK.projectId,
          environmentId: COLD_RECOVERY_LOCK.environmentId,
        },
      },
    }),
    readState: vi.fn().mockResolvedValue(state),
    now: () => new Date("2026-09-08T00:10:01.000Z"),
    writeOutput: vi.fn(),
  };
}

describe("permanent-staging cold-quiesce successor bridge", () => {
  it("binds the exact predecessor artifact and configured live topology", async () => {
    const files = prepareFiles();
    try {
      const code = await runPermanentStagingColdQuiesceSuccessorBridge(
        files.argv,
        dependencies(),
      );
      expect(code).toBe(0);
      const source = fs.readFileSync(
        path.join(files.evidence, "cold-quiesce-successor-bridge.json"),
        "utf8",
      );
      const receipt = JSON.parse(source) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        schemaVersion: COLD_QUIESCE_SUCCESSOR_BRIDGE_SCHEMA,
        operation: "cold-quiesce-successor-bridge",
        candidateSha: CANDIDATE,
        currentRunId: CURRENT_RUN,
        currentPrepareRunId: CURRENT_PREPARE_RUN,
        priorCandidateSha: COLD_QUIESCE_SUCCESSOR_BRIDGE.priorCandidateSha,
        priorQuiesceRunId: COLD_QUIESCE_SUCCESSOR_BRIDGE.priorQuiesceRunId,
        coldQuiesceSuccessorDeadline:
          COLD_QUIESCE_SUCCESSOR_BRIDGE.successorDeadline,
        coldQuiesceSuccessorWithinGraceExact: true,
        priorArtifact: {
          id: COLD_QUIESCE_SUCCESSOR_BRIDGE.artifactId,
          digest: COLD_QUIESCE_SUCCESSOR_BRIDGE.artifactDigest,
          prerequisitesSha256:
            COLD_QUIESCE_SUCCESSOR_BRIDGE.evidence.prerequisites.sha256,
        },
        priorCliFailure: {
          cliVersion: "5.32.0",
          normalizedReplicaAssignment:
            "project=48d8c6cd-1c66-4148-874b-20877f48e1a5",
          deterministicPrecommitBarrier:
            "replica-u64-parse-before-commit_scale_patch",
          scaleMutationPathReachable: false,
          providerWriteCommitted: false,
        },
        sourceProof: {
          commandProducer: {
            gitBlobSha: "beb1eb9ac760101b3b477fe9960dfbe6f7332d7a",
            sha256:
              "3f761dd08c8a08f872fc9e37d626aac64614092aa0de548deeaf1b890952450c",
          },
          railwayCli: {
            tagCommitSha: "5a8c5065b5cb929d7a1cadf7e168c2eed9453999",
            main: {
              gitBlobSha: "e4516626d224e239ef3d74f9f85e33ea84b50d47",
              sha256:
                "09f30a5fa1ee19df3a352796ab9bf6a4ca599145bc08972717c3c4fb8147754d",
            },
            scale: {
              gitBlobSha: "8d5530d85f2d5ce8771610417eb47787752b633c",
              sha256:
                "f015a7aa1cd9a90d75d6f9bd4903faed28569b942b61dfc5fe7e2638360b86f9",
            },
          },
        },
        checks: {
          priorArtifactContentsExact: true,
          sourceAnchorsExact: true,
          priorCliDeterministicPrecommitBarrierExact: true,
          configuredLiveTopologyExact: true,
          noSecondScaleWritePerformed: true,
        },
      });
      expect(receipt.priorCliFailure).toEqual(
        COLD_QUIESCE_SUCCESSOR_BRIDGE.priorCliFailure,
      );
      expect(receipt.sourceProof).toEqual(
        COLD_QUIESCE_SUCCESSOR_BRIDGE.sourceProof,
      );
      expect(receipt.reviewedAuthoritySha256).toBe(
        sha256(currentAuthority()),
      );
      expect(`${JSON.stringify(receipt, null, 2)}\n`).toBe(source);
    } finally {
      fs.rmSync(files.root, { recursive: true, force: true });
    }
  });

  it("rejects a byte-substituted predecessor artifact before live reads", async () => {
    const files = prepareFiles();
    try {
      fs.appendFileSync(
        path.join(files.prior, "cold-quiesce-intent.json"),
        "\n",
      );
      const deps = dependencies();
      expect(await runPermanentStagingColdQuiesceSuccessorBridge(
        files.argv,
        deps,
      )).toBe(1);
      expect(deps.readScope).not.toHaveBeenCalled();
      expect(deps.writeOutput).toHaveBeenCalledWith(expect.stringContaining(
        "cold_quiesce_successor_bridge_artifact_contents_invalid",
      ));
    } finally {
      fs.rmSync(files.root, { recursive: true, force: true });
    }
  });

  it("rejects a different configured or deployment-manifest topology", async () => {
    for (const changed of [
      {
        ...liveState(),
        configuredRegions: [{
          region: COLD_RECOVERY_LOCK.region,
          numReplicas: 1,
        }],
      },
      {
        ...liveState(),
        deploymentRegions: [{
          region: COLD_RECOVERY_LOCK.configuredRegionBefore,
          numReplicas: 1,
        }],
      },
    ] satisfies ColdRecoveryState[]) {
      const files = prepareFiles();
      try {
        const deps = dependencies(changed);
        expect(await runPermanentStagingColdQuiesceSuccessorBridge(
          files.argv,
          deps,
        )).toBe(1);
        expect(deps.writeOutput).toHaveBeenCalledWith(expect.stringContaining(
          "cold_quiesce_successor_bridge_live_topology_invalid",
        ));
      } finally {
        fs.rmSync(files.root, { recursive: true, force: true });
      }
    }
  });

  it("rejects mutation-token custody and substituted pinned arguments", async () => {
    const files = prepareFiles();
    try {
      expect(parseColdQuiesceSuccessorBridgeArguments([
        ...files.argv.slice(0, 5),
        "b".repeat(40),
        ...files.argv.slice(6),
      ])).toBeNull();
      const deps = dependencies(liveState(), testEnvironment({
        PINTPATH_RAILWAY_STAGING_SCALE_TOKEN: "scale-token-long-enough",
      }));
      expect(await runPermanentStagingColdQuiesceSuccessorBridge(
        files.argv,
        deps,
      )).toBe(1);
      expect(deps.readScope).not.toHaveBeenCalled();
      expect(deps.writeOutput).toHaveBeenCalledWith(expect.stringContaining(
        "cold_quiesce_successor_bridge_token_scope_invalid",
      ));
    } finally {
      fs.rmSync(files.root, { recursive: true, force: true });
    }
  });

  it("rejects bridge verification at the pinned successor deadline", async () => {
    const files = prepareFiles();
    try {
      const deps = {
        ...dependencies(),
        now: () => new Date(COLD_QUIESCE_SUCCESSOR_BRIDGE.successorDeadline),
      };
      expect(await runPermanentStagingColdQuiesceSuccessorBridge(
        files.argv,
        deps,
      )).toBe(1);
      expect(deps.readScope).not.toHaveBeenCalled();
      expect(deps.writeOutput).toHaveBeenCalledWith(expect.stringContaining(
        "cold_quiesce_successor_bridge_successor_deadline_expired",
      ));
    } finally {
      fs.rmSync(files.root, { recursive: true, force: true });
    }
  });
});
