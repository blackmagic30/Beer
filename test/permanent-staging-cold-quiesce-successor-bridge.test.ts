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
  COLD_QUIESCE_SUCCESSOR_BINDING,
  COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
  COLD_RECOVERY_LOCK,
  fullStateCanonical,
  parseColdQuiesceSuccessorBinding,
  sha256,
  type ColdRecoveryState,
} from "../scripts/lib/permanent-staging-cold-recovery.js";

const CANDIDATE = "a".repeat(40);
const CURRENT_PREPARE_RUN = "8999";
const CURRENT_REPLACEMENT_RUN = "8998";
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
    reviewedPullRequestNumber: 92,
    operation: COLD_QUIESCE_SUCCESSOR_BRIDGE.operation,
    workflowPath:
      ".github/workflows/recover-permanent-staging-cold-zero.yml",
    workflowRunId: CURRENT_RUN,
    workflowRunAttempt: 1,
    workflowRunCreatedAt: "2026-09-08T05:11:00Z",
    reviewedPullRequestMergedAt: "2026-09-08T05:00:00Z",
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
    legacyColdRecoveryCandidateSha:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyCandidateSha,
    legacyColdRecoveryReviewedHeadSha:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyReviewedHeadSha,
    legacyColdRecoveryTreeSha: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyTreeSha,
    legacyColdRecoveryPullRequestNumber:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyPullRequestNumber,
    legacyColdRecoveryCandidateMergedAt:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyMergedAt,
    legacyColdPrepareRunId: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyPrepareRunId,
    legacyColdQuiesceRunId: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyQuiesceRunId,
    legacyColdQuiesceRunCompletedAt:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyQuiesceRunCompletedAt,
    legacyFailedReadOnlyColdQuiesceReconcileRunId:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyReadOnlyReconcileRunId,
    intermediateColdRecoveryCandidateSha:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.intermediateCandidateSha,
    intermediateColdRecoveryReviewedHeadSha:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.intermediateReviewedHeadSha,
    intermediateColdRecoveryTreeSha:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.intermediateTreeSha,
    intermediateColdRecoveryPullRequestNumber:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.intermediatePullRequestNumber,
    intermediateColdRecoveryCandidateMergedAt:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.intermediateMergedAt,
    intermediateAmbiguousColdPrepareRunId:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.intermediateAmbiguousPrepareRunId,
    intermediateFailedReadOnlyColdPrepareReconcileRunId:
      COLD_QUIESCE_SUCCESSOR_BRIDGE
        .intermediateFailedReadOnlyPrepareReconcileRunId,
    priorAmbiguousColdQuiesceArtifactId:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorArtifactId,
    priorAmbiguousColdQuiesceArtifactName:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorArtifactName,
    priorAmbiguousColdQuiesceArtifactDigest:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorArtifactDigest,
    legacyAmbiguousColdQuiesceArtifactId:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyArtifactId,
    legacyAmbiguousColdQuiesceArtifactName:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyArtifactName,
    legacyAmbiguousColdQuiesceArtifactDigest:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyArtifactDigest,
    selectedReplacementRunId: CURRENT_REPLACEMENT_RUN,
    selectedReplacementRunStartedAt: "2026-09-08T04:40:00.000Z",
    selectedReplacementRunCompletedAt: "2026-09-08T04:50:00.000Z",
    selectedColdPrepareRunStartedAt: "2026-09-08T05:00:00.000Z",
    selectedColdPrepareRunCompletedAt: "2026-09-08T05:10:00.000Z",
    coldQuiesceSuccessorDirectParentExact: true,
    coldQuiesceSuccessorLegacyToIntermediateParentExact: true,
    coldQuiesceSuccessorIntermediateToPriorParentExact: true,
    coldQuiesceSuccessorCompleteFourCandidateLineageExact: true,
    coldQuiesceSuccessorLegacyHistoryExact: true,
    coldQuiesceSuccessorIntermediateHistoryExact: true,
    coldQuiesceSuccessorPriorHistoryExact: true,
    coldQuiesceSuccessorAllRefsHistoryExact: true,
    coldQuiesceSuccessorCurrentPrepareExact: true,
    coldQuiesceSuccessorLegacyArtifactMetadataExact: true,
    coldQuiesceSuccessorPriorArtifactMetadataExact: true,
    coldQuiesceSuccessorPriorProviderProofRequired: true,
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
    rows: [{
      id: "11111111-1111-4111-8111-111111111111",
      name: "PINTPATH_AUTOMATIC_MAINTENANCE_CANDIDATE_SHA",
      environmentId: COLD_RECOVERY_LOCK.environmentId,
      serviceId: COLD_RECOVERY_LOCK.serviceId,
      isSealed: false,
      references: [],
    }],
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
    PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:
      COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
    PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN:
      "production-metadata-token-long-enough",
    PINTPATH_RAILWAY_STAGING_METADATA_TOKEN:
      "staging-metadata-token-long-enough",
    ...overrides,
  };
}

function providerProof(state: ColdRecoveryState) {
  return {
    schemaVersion: "pintpath-permanent-staging-cold-provider-no-write-proof/v1" as const,
    observedAt: "2026-09-08T05:11:01.000Z",
    environmentId: COLD_RECOVERY_LOCK.environmentId,
    serviceId: COLD_RECOVERY_LOCK.serviceId,
    querySha256: {
      history: COLD_QUIESCE_SUCCESSOR_BINDING.providerHistoryQuerySha256,
      patches: COLD_QUIESCE_SUCCESSOR_BINDING.providerPatchesQuerySha256,
      patch: COLD_QUIESCE_SUCCESSOR_BINDING.providerPatchQuerySha256,
    },
    history: {
      pages: [{
        requestAfter: null,
        count: 8,
        endCursor: "history-terminal",
        hasNextPage: false,
      }],
      count: 8,
      rowsSha256: "4".repeat(64),
      prefixCount: 6,
      prefixRowsSha256:
        "f1270eaf4378364f1d91624515f7a0b370f9274254535619704a56d948bf609f",
      suffixEventIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ] as const,
    },
    patches: {
      pages: [{
        requestAfter: null,
        count: 100,
        endCursor: "patch-page-one",
        hasNextPage: true,
      }, {
        requestAfter: "patch-page-one",
        count: 24,
        endCursor: "patch-terminal",
        hasNextPage: false,
      }],
      count: 124,
      rowsSha256: "5".repeat(64),
      prefixCount: 122,
      prefixRowsSha256:
        "a560f185f77fb091da39314eb1f7f9f5ab3a4d2f6593752339649751f6c133db",
      suffixPatchIds: [
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
      ] as const,
      crossFetchProjectionSha256: "6".repeat(64),
    },
    incidentWindows: [{
      startedAt: "2026-09-07T18:51:21.000Z",
      completedAt: "2026-09-07T18:57:20.000Z",
    }, {
      startedAt: "2026-09-08T04:30:38.868Z",
      completedAt: "2026-09-08T04:32:22.210Z",
    }],
    liveStateSha256: sha256(fullStateCanonical(state)),
    checks: {
      paginationCompleteExact: true,
      chronologicalOrderExact: true,
      historicalPrefixesExact: true,
      historicalScalePositiveControlExact: true,
      legacyUnauthorizedRunNoWriteExact: true,
      priorUnauthorizedRunNoWriteExact: true,
      authorizedSuffixExact: true,
      targetDeployAbsentFromSuffixExact: true,
      crossFetchedPatchesExact: true,
      ledgerRecheckExact: true,
      liveTopologyContinuityExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  } as const;
}

function prepareFiles() {
  const root = fs.realpathSync(fs.mkdtempSync(
    path.join(os.tmpdir(), "pintpath-cold-bridge-"),
  ));
  const legacy = path.join(root, "legacy");
  const prior = path.join(root, "prior");
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.mkdirSync(prior, { mode: 0o700 });
  fs.mkdirSync(evidence, { mode: 0o700 });
  const fixtures = [
    ["receipt", "cold-quiesce-receipt.json"],
    ["intent", "cold-quiesce-intent.json"],
    ["prerequisites", "prerequisites-verification.json"],
    ["reviewed-authority", "reviewed-authority.json"],
  ] as const;
  for (const [fixture, leaf] of fixtures) {
    fs.copyFileSync(`${FIXTURE_PREFIX}-${fixture}.json`, path.join(legacy, leaf));
    fs.chmodSync(path.join(legacy, leaf), 0o600);
  }
  const priorFixtures = [
    ["receipt", "cold-quiesce-receipt.json"],
    ["intent", "cold-quiesce-intent.json"],
    ["successor-bridge", "cold-quiesce-successor-bridge.json"],
    ["prerequisites", "prerequisites-verification.json"],
    ["reviewed-authority", "reviewed-authority.json"],
  ] as const;
  for (const [fixture, leaf] of priorFixtures) {
    fs.copyFileSync(
      path.resolve(`test/fixtures/cold-quiesce-prior-34186930666-${fixture}.json`),
      path.join(prior, leaf),
    );
    fs.chmodSync(path.join(prior, leaf), 0o600);
  }
  const authorityFile = path.join(root, "reviewed-authority.json");
  fs.writeFileSync(authorityFile, currentAuthority(), {
    encoding: "utf8",
    mode: 0o600,
  });
  const prepareTerminalFile = path.join(root, "cold-prepare-terminal.json");
  fs.writeFileSync(prepareTerminalFile, `${JSON.stringify({
    schemaVersion: "pintpath-permanent-staging-cold-prepare/v2",
    operation: "cold-prepare",
    outcome: "prepared_cold",
    failureCode: null,
    candidateSha: CANDIDATE,
    sourceSha: COLD_RECOVERY_LOCK.sourceSha,
    startedAt: "2026-09-08T05:05:00.000Z",
    completedAt: "2026-09-08T05:06:00.000Z",
    attempts: 1,
    retryAllowed: false,
    replacementPrerequisite: {
      runId: CURRENT_REPLACEMENT_RUN,
      terminalSha256: "c".repeat(64),
    },
    checks: { exact: true },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const argv = [
    "--candidate-sha",
    CANDIDATE,
    "--prepare-run-id",
    CURRENT_PREPARE_RUN,
    "--prior-candidate-sha",
    COLD_QUIESCE_SUCCESSOR_BRIDGE.priorCandidateSha,
    "--prior-quiesce-run-id",
    COLD_QUIESCE_SUCCESSOR_BRIDGE.priorQuiesceRunId,
    "--legacy-artifact-dir",
    legacy,
    "--prior-artifact-dir",
    prior,
    "--prepare-terminal-file",
    prepareTerminalFile,
    "--reviewed-authority-file",
    authorityFile,
    "--evidence-dir",
    evidence,
  ];
  return { root, legacy, prior, evidence, authorityFile, argv };
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
    readProviderProof: vi.fn().mockResolvedValue(providerProof(state)),
    now: () => new Date("2026-09-08T05:11:01.000Z"),
    writeOutput: vi.fn(),
  };
}

describe("permanent-staging cold-quiesce successor bridge", () => {
  it("rejects a missing external Railway mutation freeze before provider reads", async () => {
    const files = prepareFiles();
    try {
      const deps = dependencies(liveState(), testEnvironment({
        PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION: undefined,
      }));
      expect(await runPermanentStagingColdQuiesceSuccessorBridge(
        files.argv,
        deps,
      )).toBe(1);
      expect(deps.readScope).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(files.root, { recursive: true, force: true });
    }
  });

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
        intermediateCandidate: {
          candidateSha:
            COLD_QUIESCE_SUCCESSOR_BRIDGE.intermediateCandidateSha,
          reviewedHeadSha:
            COLD_QUIESCE_SUCCESSOR_BRIDGE.intermediateReviewedHeadSha,
          treeSha: COLD_QUIESCE_SUCCESSOR_BRIDGE.intermediateTreeSha,
          pullRequestNumber:
            COLD_QUIESCE_SUCCESSOR_BRIDGE.intermediatePullRequestNumber,
          mergedAt: COLD_QUIESCE_SUCCESSOR_BRIDGE.intermediateMergedAt,
          ambiguousPrepareRunId:
            COLD_QUIESCE_SUCCESSOR_BRIDGE.intermediateAmbiguousPrepareRunId,
          failedReadOnlyPrepareReconcileRunId:
            COLD_QUIESCE_SUCCESSOR_BRIDGE
              .intermediateFailedReadOnlyPrepareReconcileRunId,
        },
        legacyCandidate: {
          candidateSha: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyCandidateSha,
          quiesceRunId: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyQuiesceRunId,
        },
        legacyArtifact: {
          id: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyArtifactId,
          digest: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyArtifactDigest,
          prerequisitesSha256:
            COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyEvidence.prerequisites.sha256,
        },
        priorArtifact: {
          id: COLD_QUIESCE_SUCCESSOR_BRIDGE.priorArtifactId,
          digest: COLD_QUIESCE_SUCCESSOR_BRIDGE.priorArtifactDigest,
          receiptSha256:
            COLD_QUIESCE_SUCCESSOR_BRIDGE.priorEvidence.receipt.sha256,
        },
        priorCliFailure: {
          cliVersion: "5.32.0",
          cliExitCode: 1,
          clapParseFailure: false,
          renderedErrorKind: "UnauthorizedToken",
          graphqlAuthorizationDenied: true,
          deniedResolver: null,
          resolverUnknown: true,
          environmentPatchCommitReached: null,
        },
        providerWriteCommitted: false,
        mutationExclusivity: {
          externalMutationFreezeAttestation:
            COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
          enforcement: "OPERATIONAL_NOT_PROVIDER_VERIFIED",
          concurrencyGroup: "pintpath-permanent-staging-key-rollout",
          cancelInProgress: false,
          bridgeTokenCustody: "METADATA_ONLY",
          mutationTokenPresent: false,
        },
        sourceProof: {
          commandProducer: {
            gitBlobSha: "e88780b8f83f87ee63f764ec5db7608d529e175f",
            sha256:
              "a7571fc741d3c422f3a7e33b626187ae3c794475adc8c4b2b5998d0405928860",
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
          directSuccessorLineageExact: true,
          legacyToIntermediateLineageExact: true,
          intermediateToPriorLineageExact: true,
          completeFourCandidateLineageExact: true,
          intermediateColdHistoryExact: true,
          priorArtifactContentsExact: true,
          sourceAnchorsExact: true,
          priorCliGraphqlAuthorizationFailureExact: true,
          providerHistoryCompleteExact: true,
          providerNoWriteExact: true,
          externalMutationFreezeAttested: true,
          serializedMutationConcurrencyExact: true,
          metadataOnlyTokenCustodyExact: true,
          configuredLiveTopologyExact: true,
          noProviderMutationPerformed: true,
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

  it("rejects substituted intermediate-candidate authority before live reads", async () => {
    const files = prepareFiles();
    try {
      const authority = JSON.parse(fs.readFileSync(
        files.authorityFile,
        "utf8",
      )) as Record<string, unknown>;
      authority.intermediateColdRecoveryCandidateSha = "b".repeat(40);
      fs.writeFileSync(
        files.authorityFile,
        `${JSON.stringify(authority)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      const deps = dependencies();
      expect(await runPermanentStagingColdQuiesceSuccessorBridge(
        files.argv,
        deps,
      )).toBe(1);
      expect(deps.readScope).not.toHaveBeenCalled();
      expect(deps.writeOutput).toHaveBeenCalledWith(expect.stringContaining(
        "cold_quiesce_successor_bridge_reviewed_authority_invalid",
      ));
    } finally {
      fs.rmSync(files.root, { recursive: true, force: true });
    }
  });

  it("rejects a substituted intermediate-candidate binding", async () => {
    const files = prepareFiles();
    try {
      expect(await runPermanentStagingColdQuiesceSuccessorBridge(
        files.argv,
        dependencies(),
      )).toBe(0);
      const bridgeFile = path.join(
        files.evidence,
        "cold-quiesce-successor-bridge.json",
      );
      const source = fs.readFileSync(bridgeFile, "utf8");
      expect(parseColdQuiesceSuccessorBinding(
        source,
        currentAuthority(),
        CANDIDATE,
        CURRENT_RUN,
        CURRENT_PREPARE_RUN,
        Date.parse("2026-09-08T05:11:02.000Z"),
      )).not.toBeNull();
      const substituted = JSON.parse(source) as {
        intermediateCandidate: { candidateSha: string };
      };
      substituted.intermediateCandidate.candidateSha = "b".repeat(40);
      expect(parseColdQuiesceSuccessorBinding(
        `${JSON.stringify(substituted, null, 2)}\n`,
        currentAuthority(),
        CANDIDATE,
        CURRENT_RUN,
        CURRENT_PREPARE_RUN,
        Date.parse("2026-09-08T05:11:02.000Z"),
      )).toBeNull();
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
