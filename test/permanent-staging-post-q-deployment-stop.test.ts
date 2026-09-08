import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assessProviderLedgerPostflight,
  buildPostQDeploymentStopIntent,
  buildPostQDeploymentStopRequestBody,
  canonicalPostQEvidence,
  parsePostQAuthority,
  parsePostQDeploymentStopSnapshot,
  parseReviewedContainmentAuthority,
  POST_Q_DEPLOYMENT_STOP_LOCK,
  POST_Q_DEPLOYMENT_STOP_MUTATION,
  POST_Q_DEPLOYMENT_STOP_Q_LEAVES,
  POST_Q_DEPLOYMENT_STOP_STATE_PROJECTION_SCHEMA,
  POST_Q_DEPLOYMENT_STOP_VARIABLES,
  postQDeploymentStopInternals,
  providerLedgerBoundedDelta,
  postQSha256,
  postQTokenScopeExact,
  probePostQRuntimeAbsence,
  reconcileStoppedDeployment,
  snapshotBaselineExact,
  snapshotEvidenceHashes,
  snapshotStateSha256,
  snapshotTopologySha256,
  stopPostQDeployment,
  stoppedSnapshotExact,
  type PostQAuthorityEvidence,
  type ProviderLedger,
  type QArtifactEvidence,
  type ReviewedContainmentAuthorityEvidence,
  type StopAttempt,
} from "../scripts/lib/permanent-staging-post-q-deployment-stop.js";
import {
  POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_LEAF,
  POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_SCHEMA,
  POST_Q_DEPLOYMENT_STOP_CONFIRMATION_PREFIX,
  POST_Q_DEPLOYMENT_STOP_FREEZE_ATTESTATION,
  POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_LEAF,
  POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_SCHEMA,
  postQDeploymentStopExecutorInternals,
  runProtectedPermanentStagingPostQDeploymentStop,
  type PostQDeploymentStopDependencies,
} from "../scripts/execute-protected-permanent-staging-post-q-deployment-stop.js";

const CANDIDATE_SHA = "a".repeat(40);
const RUN_ID = "34240000000";
const TOKEN = "staging-stop-token-with-safe-length";
const PRODUCTION_METADATA_TOKEN = "production-metadata-token-safe-length";
const INTENT_ARTIFACT_ID = "10060000000";
const INTENT_ARTIFACT_DIGEST = `sha256:${"1".repeat(64)}`;
const TEST_NOW = Date.parse("2026-09-08T15:00:00.000Z");
const RELEASE_POLICY_SHA256 =
  "4aaedd863d08e539e1628db5d14557cc23531a0c6d586ffb25acebcba7907e90";

const requiredChecks = [
  ["postgres-tool-runtime-closure-observation", ".github/workflows/ci.yml"],
  ["postgres-migration-integration", ".github/workflows/ci.yml"],
  ["build-test-scan", ".github/workflows/ci.yml"],
  ["supabase-database", ".github/workflows/ci.yml"],
  ["CodeQL JavaScript and TypeScript", ".github/workflows/codeql.yml"],
  ["CodeQL Swift", ".github/workflows/codeql.yml"],
  ["release-readiness", ".github/workflows/pintpath-release-readiness.yml"],
  ["ios", ".github/workflows/native-apps.yml"],
] as const;

function jsonResponse(
  value: unknown,
  status = 200,
  contentType = "application/json",
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": contentType },
  });
}

function qArtifact(): QArtifactEvidence {
  return {
    artifactId: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId,
    artifactName: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactName,
    artifactDigest: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest,
    receiptSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.receiptSha256,
    intentSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.intentSha256,
    prerequisiteSha256: POST_Q_DEPLOYMENT_STOP_LOCK.q.prerequisiteSha256,
    successorBridgeSha256:
      POST_Q_DEPLOYMENT_STOP_LOCK.q.successorBridgeSha256,
    reviewedAuthoritySha256:
      POST_Q_DEPLOYMENT_STOP_LOCK.q.reviewedAuthoritySha256,
  };
}

function qAuthority(): PostQAuthorityEvidence {
  return {
    sha256: "b".repeat(64),
    currentRunId: RUN_ID,
    currentRunAttempt: 1,
    totalWorkflowDispatchRuns: 2,
    priorSkippedAttemptCount: 1,
    qArtifactId: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId,
    qArtifactDigest: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest,
    singleUseAuthorityExact: true,
  };
}

function postQAuthorityFixture() {
  const memberSizes = [5354, 2952, 6466, 12505, 2724] as const;
  return {
    schemaVersion: "pintpath-permanent-staging-post-q-authority/v1",
    operation: "post-q-deployment-stop-containment",
    repository: POST_Q_DEPLOYMENT_STOP_LOCK.repository,
    candidateSha: CANDIDATE_SHA,
    currentRunId: RUN_ID,
    currentRunAttempt: 1,
    containment: {
      workflowPath:
        ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
      workflowId: POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.workflowId,
      runId: RUN_ID,
      runNumber: 2,
      runAttempt: 1,
      headSha: CANDIDATE_SHA,
      totalWorkflowDispatchRuns: 2,
      priorAttempts: [{
        runId: POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.runId,
        runAttempt: 1,
        headSha: POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.candidateSha,
        writerDisposition: "completed_skipped",
      }],
      recoveryBridge: {
        runId: POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.runId,
        runAttempt: 1,
        workflowId: POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.workflowId,
        workflowPath:
          ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
        headSha: POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.candidateSha,
        prepareJobId: POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.prepareJobId,
        applyJobId: POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.applyJobId,
        prepareFailedBeforeIntentExact: true,
        applyCompletedSkippedWithoutStepsExact: true,
        writerNeverExistedOrStartedExact: true,
        artifactsAbsentExact: true,
      },
      workflowMetadataExact: true,
      currentWriterNotStartedExact: true,
      everyPriorWriterDefinitelySkippedExact: true,
      priorCompletedBeforeWriterRunsDoNotConsumeAuthority: true,
      allWorkflowRunPagesReadExact: true,
      allRunAttemptJobPagesReadExact: true,
      freshDispatchCannotRepeatWriteExact: true,
    },
    failedQ: {
      runId: POST_Q_DEPLOYMENT_STOP_LOCK.q.runId,
      runAttempt: 1,
      workflowId: 344_383_802,
      workflowPath: ".github/workflows/recover-permanent-staging-cold-zero.yml",
      headSha: POST_Q_DEPLOYMENT_STOP_LOCK.q.candidateSha,
      conclusion: "failure",
      bridgeStepConclusion: "success",
      soleWriterStepConclusion: "failure",
      boundaryStepConclusion: "success",
      artifactUploadStepConclusion: "success",
      otherJobsSkipped: true,
    },
    artifact: {
      id: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId,
      name: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactName,
      digest: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest,
      sizeBytes: 12561,
      members: POST_Q_DEPLOYMENT_STOP_Q_LEAVES.map((leaf, index) => ({
        path: leaf.relativePath,
        sizeBytes: memberSizes[index],
        sha256: leaf.sha256,
        sealedPath: leaf.relativePath,
      })),
    },
    qMutationDisposition: {
      attempts: 1,
      retryAllowed: false,
      acknowledgementExact: true,
      configuredZeroReached: false,
      reinterpretAsZeroAllowed: false,
    },
    checks: {
      currentDispatchExact: true,
      qRunExact: true,
      qFourJobInventoryExact: true,
      qSoleWriterDispositionExact: true,
      qArtifactMetadataExact: true,
      qFiveMemberCustodyExact: true,
      qRetryPreventedExact: true,
      containmentCurrentRunExact: true,
      containmentSingleUseHistoryExact: true,
      containmentSecondWritePreventedExact: true,
      evidenceSecretFreeExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
}

function postQAuthorityFixtureSource(value = postQAuthorityFixture()): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function reviewedAuthority(): ReviewedContainmentAuthorityEvidence {
  return {
    sha256: "c".repeat(64),
    candidateSha: CANDIDATE_SHA,
    reviewedPrHeadSha: "d".repeat(40),
    reviewedPullRequestNumber: 97,
    reviewedPullRequestMergedAt: "2026-09-08T14:00:00.000Z",
    authorizationDeadline: "2026-09-08T18:57:20.000Z",
    workflowRunId: RUN_ID,
    workflowRunAttempt: 1,
    reviewedAuthorityExact: true,
    freshDispatchWriteGuardExact: true,
  };
}

function intent(boundaryReceiptSha256 = "e".repeat(64)) {
  const value = buildPostQDeploymentStopIntent({
    candidateSha: CANDIDATE_SHA,
    runId: RUN_ID,
    qArtifact: qArtifact(),
    qAuthority: qAuthority(),
    reviewedAuthority: reviewedAuthority(),
    boundaryReceiptSha256,
  });
  if (value === null) throw new Error("test_intent_invalid");
  return value;
}

function compactJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function boundaryReceiptSource(): string {
  return compactJson({
    schemaVersion: "pintpath-railway-mutation-boundary-readiness/v1",
    policy: "pintpath-production-staging-mutation-boundary",
    mode: "read-only-boundary",
    outcome: "passed",
    checks: Object.fromEntries([
      "policyValid",
      "queriesMetadataOnly",
      "productionTokenScopeExact",
      "stagingTokenScopeExact",
      "productionEnvironmentExact",
      "stagingEnvironmentExact",
      "productionPatchEmpty",
      "stagingPatchEmpty",
      "productionPostgresExact",
      "approvedDeploymentCurrent",
      "approvedDeploymentActive",
      "approvedDeploymentHealthy",
      "approvedSnapshotExact",
      "approvedImageDigestExact",
      "deploymentPatchAbsent",
      "deploymentRecordedSourceExact",
      "sourceImageExact",
      "autoUpdatesDisabledExact",
      "sourceReferenceImmutable",
    ].map((name) => [name, true])),
  });
}

function phaseArgs(phase: "prepare" | "apply" | "finalize"): string[] {
  const base = [
    "--phase", phase,
    "--candidate-sha", CANDIDATE_SHA,
    "--q-artifact-dir", "/tmp/q-artifact",
    "--evidence-dir", "/tmp/evidence",
    "--q-authority-file", "/tmp/q-authority.json",
    "--reviewed-authority-file", "/tmp/reviewed-authority.json",
  ];
  if (phase === "prepare") return base;
  const apply = [
    ...base,
    "--intent-file", "/tmp/stop-intent.json",
    "--intent-artifact-id", INTENT_ARTIFACT_ID,
    "--intent-artifact-digest", INTENT_ARTIFACT_DIGEST,
    "--intent-artifact-metadata-file", "/tmp/intent-artifact.json",
    "--boundary-preflight-file", "/tmp/boundary-preflight.json",
  ];
  return phase === "apply" ? apply : [
    ...apply,
    "--boundary-postflight-file", "/tmp/boundary-postflight.json",
    "--apply-terminal-file", "/tmp/stop-apply-terminal.json",
  ];
}

function runnerEnvironment(phase: "prepare" | "apply" | "finalize"):
Readonly<Record<string, string>> {
  const base = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: POST_Q_DEPLOYMENT_STOP_LOCK.repository,
    GITHUB_REF: POST_Q_DEPLOYMENT_STOP_LOCK.ref,
    GITHUB_SHA: CANDIDATE_SHA,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: RUN_ID,
    PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION:
      POST_Q_DEPLOYMENT_STOP_FREEZE_ATTESTATION,
    PINTPATH_POST_Q_DEPLOYMENT_STOP_CONFIRMATION:
      `${POST_Q_DEPLOYMENT_STOP_CONFIRMATION_PREFIX}${CANDIDATE_SHA}_FROM_Q_34229745722`,
  };
  if (phase === "prepare") return {
    ...base,
    PINTPATH_RAILWAY_STAGING_METADATA_TOKEN: TOKEN,
    PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN: PRODUCTION_METADATA_TOKEN,
  };
  if (phase === "apply") return {
    ...base,
    PINTPATH_RAILWAY_STAGING_SCALE_TOKEN: TOKEN,
  };
  return base;
}

function exactScope() {
  return {
    data: {
      projectToken: {
        projectId: POST_Q_DEPLOYMENT_STOP_LOCK.projectId,
        environmentId: POST_Q_DEPLOYMENT_STOP_LOCK.environmentId,
      },
    },
  };
}

function stoppedSnapshot() {
  const before = liveSnapshot();
  return {
    ...before,
    latestDeployment: {
      ...before.latestDeployment,
      deploymentStopped: true,
    },
    activeDeployments: [],
  };
}

function runtimeAbsenceEvidence(round = 0) {
  const requestHash = (route: string) => postQSha256(`${round}:${route}`);
  return {
    absent: true,
    responseSha256s: {
      "/health": "3".repeat(64),
      "/startup": "4".repeat(64),
      "/ready": "5".repeat(64),
    },
    requests: {
      "/health": {
        requestUrlSha256: requestHash("/health"),
        statusCode: 503,
        responseBodySha256: "3".repeat(64),
      },
      "/startup": {
        requestUrlSha256: requestHash("/startup"),
        statusCode: 503,
        responseBodySha256: "4".repeat(64),
      },
      "/ready": {
        requestUrlSha256: requestHash("/ready"),
        statusCode: 503,
        responseBodySha256: "5".repeat(64),
      },
    },
  } as const;
}

function successfulReconciliation() {
  const snapshot = stoppedSnapshot();
  const ledger: ProviderLedger = { historyRows: [], patchRows: [] };
  const runtimes = [0, 1, 2].map(runtimeAbsenceEvidence);
  const runtime = runtimes[2]!;
  const ledgerEvidence = {
    exact: true,
    mode: "unchanged" as const,
    historyRowsSha256: POST_Q_DEPLOYMENT_STOP_LOCK.baseline.historyRowsSha256,
    patchRowsSha256: POST_Q_DEPLOYMENT_STOP_LOCK.baseline.patchRowsSha256,
    addedHistoryRowSha256: null,
    addedHistoryRowCount: 0,
    addedHistoryRowPosition: null,
  };
  return {
    exact: true,
    rounds: 3,
    stableObservations: 3,
    stableSpanMs: 20_000,
    snapshot,
    runtime,
    ledger,
    ledgerEvidence,
    observations: [0, 10_000, 20_000].map((monotonicMs, index) => {
      const observedRuntime = runtimes[index]!;
      return {
        observedAt: new Date(TEST_NOW + 1_000 + index * 10_000).toISOString(),
        monotonicMs,
        snapshotSha256: snapshotStateSha256(snapshot),
        topologySha256: snapshotTopologySha256(snapshot),
        historyRowsSha256: ledgerEvidence.historyRowsSha256,
        patchRowsSha256: ledgerEvidence.patchRowsSha256,
        runtimeResponseSha256s: observedRuntime.responseSha256s,
        runtimeRequests: observedRuntime.requests,
      };
    }),
    totalObservationSpanMs: 20_000,
  };
}

function authenticatedSnapshotCommitment(
  snapshot: ReturnType<typeof liveSnapshot> | null,
) {
  if (snapshot === null) return null;
  return {
    stateProjectionSchema: POST_Q_DEPLOYMENT_STOP_STATE_PROJECTION_SCHEMA,
    stateSha256: snapshotStateSha256(snapshot),
    topologySha256: snapshotTopologySha256(snapshot),
    configuredRegions: snapshot.configuredRegions,
    deploymentRegions: snapshot.deploymentRegions,
    source: snapshot.source,
    deployment: snapshot.deployment,
    latestDeployment: snapshot.latestDeployment,
    activeDeployments: snapshot.activeDeployments,
    domains: snapshot.domains,
    variableRows: snapshot.rows.length,
    ...snapshotEvidenceHashes(snapshot),
  };
}

function authenticatedLedgerCommitment(ledger: ProviderLedger | null) {
  return ledger === null ? null : {
    historyCount: POST_Q_DEPLOYMENT_STOP_LOCK.baseline.historyCount,
    historyRowsSha256: POST_Q_DEPLOYMENT_STOP_LOCK.baseline.historyRowsSha256,
    patchCount: POST_Q_DEPLOYMENT_STOP_LOCK.baseline.patchCount,
    patchRowsSha256: POST_Q_DEPLOYMENT_STOP_LOCK.baseline.patchRowsSha256,
  };
}

function intentArtifactMetadataSource(intentSource: string): string {
  return compactJson({
    id: Number(INTENT_ARTIFACT_ID),
    name:
      `pintpath-permanent-staging-post-q-deployment-stop-intent-${CANDIDATE_SHA}-${RUN_ID}`,
    expired: false,
    digest: INTENT_ARTIFACT_DIGEST,
    size_in_bytes: Buffer.byteLength(intentSource),
    workflow_run: {
      id: Number(RUN_ID),
      repository_id: 1215862300,
      head_repository_id: 1215862300,
      head_branch: "main",
      head_sha: CANDIDATE_SHA,
    },
  });
}

function runnerHarness(input: {
  readonly phase: "prepare" | "apply" | "finalize";
  readonly intentSource?: string;
  readonly applyTerminalSource?: string;
  readonly applyCompletionSource?: string;
  readonly stopAttempt?: StopAttempt;
  readonly boundaryPreflightSource?: string;
  readonly boundaryPostflightSource?: string | null;
  readonly snapshotBaselineExact?: boolean;
  readonly ledgerBaselineExact?: boolean;
  readonly reconciliation?: Awaited<ReturnType<typeof reconcileStoppedDeployment>>;
  readonly now?: () => number;
  readonly writeFailureLeaf?: string;
  readonly writeThenThrowLeaf?: string;
  readonly persistedWriteTransform?: (leaf: string, source: string) => string;
  readonly environmentOverrides?: Readonly<Record<string, string | undefined>>;
  readonly repositoryExact?: boolean;
  readonly qArtifactExact?: boolean;
  readonly qAuthorityExact?: boolean;
}) {
  const boundarySource = input.boundaryPreflightSource ?? boundaryReceiptSource();
  const boundaryPostflightSource = input.boundaryPostflightSource === null
    ? undefined
    : input.boundaryPostflightSource ?? boundarySource;
  const builtIntent = intent(postQSha256(boundarySource));
  const intentSource = input.intentSource ?? canonicalPostQEvidence(builtIntent);
  const metadataSource = intentArtifactMetadataSource(intentSource);
  const before = liveSnapshot();
  const ledger: ProviderLedger = { historyRows: [], patchRows: [] };
  const writes = new Map<string, string>();
  const writeEvidence = vi.fn((_directory: string, leaf: string, source: string) => {
    if (leaf === input.writeFailureLeaf) throw new Error("test_write_failed");
    writes.set(
      leaf,
      input.persistedWriteTransform?.(leaf, source) ?? source,
    );
    if (leaf === input.writeThenThrowLeaf) throw new Error("test_late_write_failed");
  });
  const writeOutput = vi.fn();
  const stopDeployment = vi.fn().mockResolvedValue(input.stopAttempt ?? {
    outcome: "acknowledged",
    acknowledgementExact: true,
    querySha256: builtIntent.mutation.querySha256,
    variablesSha256: builtIntent.mutation.variablesSha256,
    requestBodySha256: builtIntent.mutation.requestBodySha256,
    responseBodySha256: postQSha256(JSON.stringify({
      data: { deploymentStop: true },
    })),
    acknowledgementSha256: postQSha256(canonicalPostQEvidence({
      deploymentStop: true,
    })),
  } satisfies StopAttempt);
  const readScope = vi.fn().mockResolvedValue(exactScope());
  const readSnapshot = vi.fn().mockResolvedValue(before);
  const readLedger = vi.fn().mockResolvedValue(ledger);
  const reconcile = vi.fn().mockResolvedValue(
    input.reconciliation ?? successfulReconciliation(),
  );
  const fetchImpl = vi.fn(async () => {
    throw new Error("unexpected_network_call");
  });
  const boundaryCheck = vi.fn().mockResolvedValue({
    passed: true,
    receiptSha256: postQSha256(boundarySource),
  });
  const probeRuntime = vi.fn().mockResolvedValue(
    successfulReconciliation().runtime,
  );
  const sources: Readonly<Record<string, string | undefined>> = {
    "/tmp/q-authority.json": "{}\n",
    "/tmp/reviewed-authority.json": "{}\n",
    "/tmp/stop-intent.json": intentSource,
    "/tmp/intent-artifact.json": metadataSource,
    "/tmp/boundary-preflight.json": boundarySource,
    "/tmp/boundary-postflight.json": boundaryPostflightSource,
    "/tmp/stop-apply-terminal.json": input.applyTerminalSource,
    "/tmp/stop-apply-terminal-completion.json": input.applyCompletionSource,
  };
  const readIntent = vi.fn((filename: string) => {
    const evidencePrefix = "/tmp/evidence/";
    const persisted = filename.startsWith(evidencePrefix)
      ? writes.get(filename.slice(evidencePrefix.length))
      : undefined;
    const source = sources[filename] ?? persisted;
    if (source === undefined) throw new Error("test_source_absent");
    return source;
  });
  const overrides: Partial<PostQDeploymentStopDependencies> = {
    argv: phaseArgs(input.phase),
    env: {
      ...runnerEnvironment(input.phase),
      ...input.environmentOverrides,
    },
    cwd: "/tmp",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    repositoryExact: vi.fn(() => input.repositoryExact ?? true),
    readQArtifact: vi.fn(() => ({})),
    validateQArtifact: vi.fn(() => input.qArtifactExact === false
      ? null
      : qArtifact()),
    parseQAuthority: vi.fn(() => input.qAuthorityExact === false
      ? null
      : qAuthority()),
    parseReviewedAuthority: vi.fn(() => reviewedAuthority()),
    parseIntent: vi.fn(() => builtIntent),
    snapshotBaselineExact: vi.fn(() => input.snapshotBaselineExact ?? true),
    ledgerBaselineExact: vi.fn(() => input.ledgerBaselineExact ?? true),
    reconcile,
    snapshotCommitment: authenticatedSnapshotCommitment,
    ledgerCommitment: authenticatedLedgerCommitment,
    readIntent,
    writeEvidence,
    boundaryCheck,
    readScope,
    readSnapshot,
    readLedger,
    stopDeployment,
    probeRuntime,
    sleep: vi.fn().mockResolvedValue(undefined),
    monotonicNow: vi.fn(() => 0),
    now: input.now ?? vi.fn(() => TEST_NOW),
    writeOutput,
  };
  return {
    overrides,
    writes,
    writeEvidence,
    writeOutput,
    stopDeployment,
    readScope,
    readSnapshot,
    readLedger,
    reconcile,
    fetchImpl,
    boundaryCheck,
    probeRuntime,
    intentSource,
    boundarySource,
  };
}

function outputReceiptFrom(harness: ReturnType<typeof runnerHarness>) {
  return JSON.parse(
    harness.writeOutput.mock.calls.at(-1)![0] as string,
  ) as Record<string, unknown>;
}

function writtenEvidence(
  harness: ReturnType<typeof runnerHarness>,
  leaf: "stop-intent.json" | "stop-apply-terminal.json" |
    "stop-apply-terminal-completion.json" | "stop-terminal.json" |
    "stop-terminal-completion.json",
) {
  const source = harness.writes.get(leaf);
  if (source === undefined) throw new Error(`test_evidence_missing:${leaf}`);
  return {
    source,
    value: JSON.parse(source) as Record<string, unknown>,
  };
}

function applyCompletionMarkerSource(applyTerminalSource: string): string {
  return canonicalPostQEvidence({
    schemaVersion: POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_SCHEMA,
    operation: "permanent-staging-post-q-deployment-stop",
    candidateSha: CANDIDATE_SHA,
    runId: RUN_ID,
    applyTerminalSha256: postQSha256(applyTerminalSource),
    applyTerminalSizeBytes: Buffer.byteLength(applyTerminalSource),
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function expectNoProviderCalls(harness: ReturnType<typeof runnerHarness>): void {
  expect(harness.fetchImpl).not.toHaveBeenCalled();
  expect(harness.boundaryCheck).not.toHaveBeenCalled();
  expect(harness.readScope).not.toHaveBeenCalled();
  expect(harness.readSnapshot).not.toHaveBeenCalled();
  expect(harness.readLedger).not.toHaveBeenCalled();
  expect(harness.stopDeployment).not.toHaveBeenCalled();
  expect(harness.probeRuntime).not.toHaveBeenCalled();
  expect(harness.reconcile).not.toHaveBeenCalled();
}

function liveSnapshot() {
  const value = JSON.parse(fs.readFileSync(path.resolve(
    import.meta.dirname,
    "fixtures/permanent-staging-post-q-live-snapshot.json",
  ), "utf8")) as unknown;
  const parsed = parsePostQDeploymentStopSnapshot(value);
  if (parsed === null) throw new Error("test_snapshot_invalid");
  return parsed;
}

function reviewedAuthoritySource(): string {
  const checks = requiredChecks.map(([name, workflowPath], index) => ({
    name,
    runId: 40_000_000_000 + index,
    checkSuiteId: 50_000_000_000 + index,
    workflowId: 60_000_000 + index,
    workflowPath,
    event: "push",
    runAttempt: 1,
    startedAt: "2026-09-08T14:10:00.000Z",
    completedAt: "2026-09-08T14:20:00.000Z",
  }));
  const producerRun = new Map(checks.map((check) => [check.name, check.runId]));
  const artifacts = [
    [
      "pintpath-mission-discovery-scale-evidence",
      "postgres-migration-integration",
    ],
    [
      "pintpath-postgres-tool-runtime-closure-v4-observation",
      "postgres-tool-runtime-closure-observation",
    ],
    ["pintpath-automated-readiness-evidence", "release-readiness"],
  ].map(([name, producerCheck], index) => ({
    artifactId: 70_000_000_000 + index,
    name,
    digest: `sha256:${String(index + 1).repeat(64)}`,
    sizeBytes: 100 + index,
    runId: producerRun.get(producerCheck)!,
    producerCheck,
  }));
  return `${JSON.stringify({
    schemaVersion:
      "pintpath-permanent-staging-post-q-reviewed-candidate-authority/v1",
    repository: POST_Q_DEPLOYMENT_STOP_LOCK.repository,
    branch: "main",
    candidateSha: CANDIDATE_SHA,
    reviewedPullRequest: {
      number: 97,
      reviewedPrHeadSha: "d".repeat(40),
      mergeCommitSha: CANDIDATE_SHA,
      treeSha: "f".repeat(40),
      mergedAt: "2026-09-08T14:00:00.000Z",
      authorId: 1001,
      mergedById: 1002,
      githubMergeExact: true,
      reviewedTreeExact: true,
      pullRequestApprovalRequirement: "not_required",
      pullRequestApprovalRequirementExact: true,
      linearHistoryExact: true,
    },
    releasePolicySha256: RELEASE_POLICY_SHA256,
    directParentSha: POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.candidateSha,
    recoveryBridge: {
      candidateSha: POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.candidateSha,
      treeSha: POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.treeSha,
      soleParentSha: POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.soleParentSha,
    },
    authorizationDeadline: "2026-09-08T18:57:20.000Z",
    currentContainmentRun: {
      runId: RUN_ID,
      workflowId: POST_Q_DEPLOYMENT_STOP_LOCK.recoveryBridge.workflowId,
      workflowPath:
        ".github/workflows/stop-permanent-staging-post-q-deployment.yml",
      runAttempt: 1,
      runStartedAt: "2026-09-08T15:00:00.000Z",
    },
    requiredChecks: checks,
    requiredArtifacts: artifacts,
    checks: {
      mergedPullRequestAndTreeExact: true,
      soleParentSquashShapeExact: true,
      directParentExact: true,
      currentMainTipExact: true,
      noLaterMainDriftExact: true,
      baseRequiredCheckLineageExact: true,
      baseRequiredArtifactsExact: true,
      chronologyExact: true,
      candidateMaximumAgeHours: 168,
      fixedDeadlineExact: true,
      recoveryBridgeExact: true,
    },
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  }, null, 2)}\n`;
}

describe("permanent-staging post-Q deployment stop", () => {
  it("uses one canonical request body and binds the same bytes in the intent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      data: { deploymentStop: true },
    }));

    const attempt = await stopPostQDeployment(
      fetchImpl as unknown as typeof fetch,
      TOKEN,
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const expectedBody = JSON.stringify({
      query: POST_Q_DEPLOYMENT_STOP_MUTATION,
      variables: {
        deploymentId: POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId,
      },
    });
    expect(url).toBe("https://backboard.railway.com/graphql/v2");
    expect(init.body).toBe(expectedBody);
    expect(buildPostQDeploymentStopRequestBody()).toBe(expectedBody);
    expect(POST_Q_DEPLOYMENT_STOP_VARIABLES).toEqual({
      deploymentId: POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId,
    });
    expect(init.headers).toEqual({
      "Project-Access-Token": TOKEN,
      accept: "application/json",
      "content-type": "application/json",
    });
    expect(attempt).toEqual({
      outcome: "acknowledged",
      acknowledgementExact: true,
      querySha256: postQSha256(POST_Q_DEPLOYMENT_STOP_MUTATION),
      variablesSha256: postQSha256(JSON.stringify(
        POST_Q_DEPLOYMENT_STOP_VARIABLES,
      )),
      requestBodySha256: postQSha256(expectedBody),
      responseBodySha256: postQSha256(JSON.stringify({
        data: { deploymentStop: true },
      })),
      acknowledgementSha256: postQSha256(canonicalPostQEvidence({
        deploymentStop: true,
      })),
    });
    expect(intent().mutation).toMatchObject({
      operation: "deploymentStop",
      operationName: "PintPathPostQDeploymentStop",
      querySha256: attempt.querySha256,
      variablesSha256: attempt.variablesSha256,
      requestBodySha256: attempt.requestBodySha256,
      maximumAttempts: 1,
      retryAllowed: false,
    });
  });

  it.each([
    ["false acknowledgement", () => jsonResponse({
      data: { deploymentStop: false },
    })],
    ["GraphQL error with partial data", () => jsonResponse({
      data: { deploymentStop: true },
      errors: [{ message: "partial" }],
    })],
    ["extra response key", () => jsonResponse({
      data: { deploymentStop: true },
      extensions: {},
    })],
    ["HTTP failure", () => jsonResponse({
      errors: [{ message: "failed" }],
    }, 500)],
    ["wrong content type", () => jsonResponse({
      data: { deploymentStop: true },
    }, 200, "text/plain")],
    ["malformed JSON", () => new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    })],
  ])("makes one attempt and never retries after %s", async (_name, response) => {
    const fetchImpl = vi.fn().mockResolvedValue(response());

    await expect(stopPostQDeployment(
      fetchImpl as unknown as typeof fetch,
      TOKEN,
    )).resolves.toMatchObject({
      outcome: "transport_uncertain",
      acknowledgementExact: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not retry an exception with an unknowable provider outcome", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("socket closed"));

    await expect(stopPostQDeployment(
      fetchImpl as unknown as typeof fetch,
      TOKEN,
    )).resolves.toMatchObject({
      outcome: "transport_uncertain",
      acknowledgementExact: false,
      responseBodySha256: null,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps the deployment meta patch null and the failed-Q ledger patch distinct", () => {
    const snapshot = liveSnapshot();
    const mutationIntent = intent();
    const qPatch = postQDeploymentStopInternals.parsePatchNode({
      id: POST_Q_DEPLOYMENT_STOP_LOCK.qPatchId,
      environmentId: POST_Q_DEPLOYMENT_STOP_LOCK.environmentId,
      status: "COMMITTED",
      createdAt: "2026-09-08T13:09:24.380Z",
      updatedAt: "2026-09-08T13:09:25.340Z",
      appliedAt: "2026-09-08T13:09:25.339Z",
      message:
        "PintPath cold quiesce 606d33facb515dd10bc94c360e43c20beb999cc1 run 34229745722",
      patch: {
        services: {
          [POST_Q_DEPLOYMENT_STOP_LOCK.serviceId]: {
            deploy: {
              multiRegionConfig: { "europe-west4-drams3a": null },
            },
          },
        },
      },
    });

    expect(POST_Q_DEPLOYMENT_STOP_LOCK.deploymentPatchId).toBeNull();
    expect(snapshot.deployment.patchId).toBeNull();
    expect(mutationIntent.target.deploymentPatchId).toBeNull();
    expect(mutationIntent.target.qPatchId).toBe(
      "c6fe9c8a-b26e-4a1d-9d46-4b6ea7d84ad1",
    );
    expect(qPatch?.id).toBe(POST_Q_DEPLOYMENT_STOP_LOCK.qPatchId);
    expect(postQSha256(canonicalPostQEvidence([qPatch]))).toBe(
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.qPatchProjectionSha256,
    );
    expect(buildPostQDeploymentStopRequestBody()).not.toContain("patchId");
  });

  it("parses the committed live fixture and pins all corrected baseline hashes", () => {
    const snapshot = liveSnapshot();
    const evidenceHashes = snapshotEvidenceHashes(snapshot);

    expect(POST_Q_DEPLOYMENT_STOP_STATE_PROJECTION_SCHEMA).toBe(
      "pintpath-permanent-staging-post-q-state-projection/v1",
    );
    expect(snapshotBaselineExact(snapshot)).toBe(true);
    expect(snapshotStateSha256(snapshot)).toBe(
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.stateSha256,
    );
    expect(snapshotTopologySha256(snapshot)).toBe(
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.topologySha256,
    );
    expect(evidenceHashes).toEqual({
      variableInventorySha256:
        POST_Q_DEPLOYMENT_STOP_LOCK.baseline.variableInventorySha256,
      collateralVariablesSha256:
        POST_Q_DEPLOYMENT_STOP_LOCK.baseline.collateralVariablesSha256,
      offTargetVariablesSha256:
        POST_Q_DEPLOYMENT_STOP_LOCK.baseline.offTargetVariablesSha256,
      environmentConfigSha256:
        POST_Q_DEPLOYMENT_STOP_LOCK.baseline.environmentConfigSha256,
      stagedPatchSha256:
        POST_Q_DEPLOYMENT_STOP_LOCK.baseline.stagedPatchSha256,
      sourceIdentitySha256:
        POST_Q_DEPLOYMENT_STOP_LOCK.baseline.sourceIdentitySha256,
    });
    expect(snapshot.deployment.patchId).toBeNull();
    expect(snapshot.rows).toHaveLength(97);
  });

  it("requires the token to be scoped to the exact project and staging environment", () => {
    const exactScope = {
      data: {
        projectToken: {
          projectId: POST_Q_DEPLOYMENT_STOP_LOCK.projectId,
          environmentId: POST_Q_DEPLOYMENT_STOP_LOCK.environmentId,
        },
      },
    };

    expect(postQTokenScopeExact(exactScope)).toBe(true);
    expect(postQTokenScopeExact({
      data: {
        projectToken: {
          ...exactScope.data.projectToken,
          environmentId:
            POST_Q_DEPLOYMENT_STOP_LOCK.forbiddenProductionEnvironmentId,
        },
      },
    })).toBe(false);
    expect(postQTokenScopeExact({
      data: {
        projectToken: {
          ...exactScope.data.projectToken,
          projectId: "00000000-0000-4000-8000-000000000001",
        },
      },
    })).toBe(false);
    expect(postQTokenScopeExact({
      ...exactScope,
      extensions: {},
    })).toBe(false);
  });

  it("accepts only zero ledger delta and fails closed on every added row", () => {
    const before: ProviderLedger = { historyRows: [], patchRows: [] };
    const historyDelta: ProviderLedger = {
      historyRows: [{
        id: "00000000-0000-4000-8000-000000000001",
        createdAt: "2026-09-08T15:00:01.000Z",
        object: "Deployment",
        action: "removed",
        outcome: "",
        operationKind: "",
        severity: "INFO",
        source: "event",
        workflowId: null,
        activityPayload: {
          id: POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId,
          serviceId: POST_Q_DEPLOYMENT_STOP_LOCK.serviceId,
          status: "REMOVED",
        },
      }],
      patchRows: [],
    };
    const patchDelta: ProviderLedger = {
      historyRows: [],
      patchRows: [{ id: "unexpected-patch" }],
    };
    const wrongHistoryDelta: ProviderLedger = {
      historyRows: [{
        ...historyDelta.historyRows[0],
        action: "updated",
      }],
      patchRows: [],
    };
    const multipleHistoryDelta: ProviderLedger = {
      historyRows: [
        historyDelta.historyRows[0]!,
        { ...historyDelta.historyRows[0], id: "second-row" },
      ],
      patchRows: [],
    };
    const bounds = {
      requestStartedAt: "2026-09-08T15:00:00.000Z",
      observedAt: "2026-09-08T15:00:02.000Z",
    };

    expect(providerLedgerBoundedDelta(before, before, bounds)).toEqual({
      mode: "unchanged",
      addedHistoryRowSha256: null,
      addedHistoryRowCount: 0,
      addedHistoryRowPosition: null,
    });
    expect(providerLedgerBoundedDelta(before, historyDelta, bounds)).toBeNull();
    expect(providerLedgerBoundedDelta(before, wrongHistoryDelta, bounds)).toBeNull();
    expect(providerLedgerBoundedDelta(before, multipleHistoryDelta, bounds)).toBeNull();
    expect(providerLedgerBoundedDelta(before, patchDelta, bounds)).toBeNull();
    const singleRowEvidence = assessProviderLedgerPostflight(
      before,
      historyDelta,
      bounds,
    );
    expect(singleRowEvidence).toMatchObject({
      exact: false,
      mode: "invalid",
      addedHistoryRowSha256: postQSha256(canonicalPostQEvidence(
        historyDelta.historyRows[0],
      )),
      addedHistoryRowCount: 1,
      addedHistoryRowPosition: "newest-prefix",
    });
    expect(singleRowEvidence).not.toHaveProperty("addedHistoryRowCanonical");
    expect(assessProviderLedgerPostflight(
      before,
      multipleHistoryDelta,
      bounds,
    )).toMatchObject({
      exact: false,
      mode: "invalid",
      addedHistoryRowSha256: null,
      addedHistoryRowCount: 2,
      addedHistoryRowPosition: "newest-prefix",
    });
    expect(assessProviderLedgerPostflight(before, patchDelta, bounds)).toMatchObject({
      exact: false,
      mode: "invalid",
      addedHistoryRowSha256: null,
      addedHistoryRowCount: 0,
      addedHistoryRowPosition: null,
    });
  });

  it("probes all runtime routes with unique no-store requests and treats exceptions as reachable uncertainty", async () => {
    const nonces = ["1".repeat(32), "2".repeat(32), "3".repeat(32)];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/startup?")) throw new Error("connection_refused");
      return new Response(`offline:${url}`, {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    });

    const result = await probePostQRuntimeAbsence(
      fetchImpl as unknown as typeof fetch,
      () => nonces.shift()!,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const calls = fetchImpl.mock.calls as unknown as readonly [
      string,
      RequestInit,
    ][];
    const urls = calls.map(([url]) => url);
    expect(new Set(urls).size).toBe(3);
    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      "/health",
      "/startup",
      "/ready",
    ]);
    expect(urls.map((url) =>
      new URL(url).searchParams.get("pintpath_post_q_stop_probe")
    )).toEqual(["1".repeat(32), "2".repeat(32), "3".repeat(32)]);
    for (const [, options] of calls) {
      expect(options).toMatchObject({
        method: "GET",
        headers: {
          accept: "application/json",
          "cache-control": "no-cache, no-store",
          pragma: "no-cache",
        },
        cache: "no-store",
        redirect: "error",
      });
    }
    expect(new Set(Object.values(result.requests).map(
      (request) => request.requestUrlSha256,
    )).size).toBe(3);
    expect(result).toMatchObject({
      absent: false,
      responseSha256s: { "/startup": null },
      requests: {
        "/health": { statusCode: 503 },
        "/startup": { statusCode: null, responseBodySha256: null },
        "/ready": { statusCode: 503 },
      },
    });
  });

  it("lets one 2xx route veto absence and ignores dynamic hashes when non-2xx status projections converge", async () => {
    const before = liveSnapshot();
    const after = stoppedSnapshot();
    const ledger: ProviderLedger = { historyRows: [], patchRows: [] };
    const dynamicRuntime = (round: number) => {
      const base = runtimeAbsenceEvidence(round);
      const healthBody = postQSha256(`${round}:health:body`);
      const startupBody = postQSha256(`${round}:startup:body`);
      const readyBody = postQSha256(`${round}:ready:body`);
      return {
        ...base,
        responseSha256s: {
          "/health": healthBody,
          "/startup": startupBody,
          "/ready": readyBody,
        },
        requests: {
          "/health": {
            ...base.requests["/health"],
            responseBodySha256: healthBody,
          },
          "/startup": {
            ...base.requests["/startup"],
            responseBodySha256: startupBody,
          },
          "/ready": {
            ...base.requests["/ready"],
            responseBodySha256: readyBody,
          },
        },
      };
    };
    const ledgerEvidence = {
      exact: true,
      mode: "unchanged" as const,
      historyRowsSha256: "1".repeat(64),
      patchRowsSha256: "2".repeat(64),
      addedHistoryRowSha256: null,
      addedHistoryRowCount: 0,
      addedHistoryRowPosition: null,
    };

    let vetoClock = 0;
    const vetoReadLedger = vi.fn().mockResolvedValue(ledger);
    const nonAbsent = dynamicRuntime(0);
    const veto = await reconcileStoppedDeployment({
      before,
      beforeLedger: ledger,
      requestStartedAt: "2026-09-08T15:00:00.000Z",
      readSnapshot: vi.fn().mockResolvedValue(after),
      readLedger: vetoReadLedger,
      probeRuntime: vi.fn().mockResolvedValue({
        ...nonAbsent,
        absent: false,
        requests: {
          ...nonAbsent.requests,
          "/health": {
            ...nonAbsent.requests["/health"],
            statusCode: 200,
          },
        },
      }),
      sleep: vi.fn(async (milliseconds: number) => {
        vetoClock += milliseconds;
      }),
      monotonicNow: vi.fn(() => vetoClock),
      wallNow: vi.fn(() => TEST_NOW + 1_000 + vetoClock),
      assessLedger: vi.fn(() => ledgerEvidence),
    });
    expect(veto).toMatchObject({ exact: false, stableObservations: 0 });
    expect(vetoReadLedger).not.toHaveBeenCalled();

    let monotonicMs = 0;
    let round = 0;
    const probeRuntime = vi.fn(async () => dynamicRuntime(round++));
    const converged = await reconcileStoppedDeployment({
      before,
      beforeLedger: ledger,
      requestStartedAt: "2026-09-08T15:00:00.000Z",
      readSnapshot: vi.fn().mockResolvedValue(after),
      readLedger: vi.fn().mockResolvedValue(ledger),
      probeRuntime,
      sleep: vi.fn(async (milliseconds: number) => {
        monotonicMs += milliseconds;
      }),
      monotonicNow: vi.fn(() => monotonicMs),
      wallNow: vi.fn(() => TEST_NOW + 1_000 + monotonicMs),
      assessLedger: vi.fn(() => ledgerEvidence),
    });
    expect(converged).toMatchObject({
      exact: true,
      rounds: 3,
      stableObservations: 3,
      stableSpanMs: 20_000,
    });
    const requests = converged.observations.flatMap((observation) =>
      Object.values(observation.runtimeRequests)
    );
    expect(new Set(requests.map(
      (request) => request.requestUrlSha256,
    )).size).toBe(9);
    expect(new Set(requests.map(
      (request) => request.responseBodySha256,
    )).size).toBe(9);
  });

  it("requires three identical observations at 10-second intervals spanning 20 seconds", async () => {
    const before = liveSnapshot();
    const after = {
      ...before,
      latestDeployment: {
        ...before.latestDeployment,
        deploymentStopped: true,
      },
      activeDeployments: [],
    };
    expect(stoppedSnapshotExact(before, after)).toBe(true);
    const ledger: ProviderLedger = { historyRows: [], patchRows: [] };
    let monotonicMs = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      monotonicMs += milliseconds;
    });
    const monotonicNow = vi.fn(() => monotonicMs);
    const wallNow = vi.fn()
      .mockReturnValueOnce(Date.parse("2026-09-08T15:00:01.000Z"))
      .mockReturnValueOnce(Date.parse("2026-09-08T15:00:11.000Z"))
      .mockReturnValueOnce(Date.parse("2026-09-08T15:00:21.000Z"));
    const assessLedger = vi.fn(() => ({
      exact: true,
      mode: "unchanged" as const,
      historyRowsSha256: "1".repeat(64),
      patchRowsSha256: "2".repeat(64),
      addedHistoryRowSha256: null,
      addedHistoryRowCount: 0,
      addedHistoryRowPosition: null,
    }));

    const result = await reconcileStoppedDeployment({
      before,
      beforeLedger: ledger,
      requestStartedAt: "2026-09-08T15:00:00.000Z",
      readSnapshot: vi.fn().mockResolvedValue(after),
      readLedger: vi.fn().mockResolvedValue(ledger),
      probeRuntime: vi.fn().mockResolvedValue(runtimeAbsenceEvidence()),
      sleep,
      monotonicNow,
      wallNow,
      assessLedger,
    });

    expect(result).toMatchObject({
      exact: true,
      rounds: 3,
      stableObservations: 3,
      stableSpanMs: 20_000,
    });
    expect(result.observations).toHaveLength(3);
    expect(result.observations.map((item) => item.monotonicMs)).toEqual([
      0,
      10_000,
      20_000,
    ]);
    expect(sleep.mock.calls).toEqual([[10_000], [10_000]]);
    expect(assessLedger).toHaveBeenCalledTimes(3);
  });

  it("rejects observations closer than the required interval", async () => {
    const before = liveSnapshot();
    const after = {
      ...before,
      latestDeployment: {
        ...before.latestDeployment,
        deploymentStopped: true,
      },
      activeDeployments: [],
    };
    const ledger: ProviderLedger = { historyRows: [], patchRows: [] };
    let monotonicMs = 0;

    const result = await reconcileStoppedDeployment({
      before,
      beforeLedger: ledger,
      requestStartedAt: "2026-09-08T15:00:00.000Z",
      readSnapshot: vi.fn().mockResolvedValue(after),
      readLedger: vi.fn().mockResolvedValue(ledger),
      probeRuntime: vi.fn().mockResolvedValue(runtimeAbsenceEvidence()),
      sleep: vi.fn(async () => {
        monotonicMs += 9_999;
      }),
      monotonicNow: vi.fn(() => monotonicMs),
      wallNow: vi.fn()
        .mockReturnValueOnce(Date.parse("2026-09-08T15:00:01.000Z"))
        .mockReturnValueOnce(Date.parse("2026-09-08T15:00:11.000Z")),
      assessLedger: vi.fn(() => ({
        exact: true,
        mode: "unchanged" as const,
        historyRowsSha256: "1".repeat(64),
        patchRowsSha256: "2".repeat(64),
        addedHistoryRowSha256: null,
        addedHistoryRowCount: 0,
        addedHistoryRowPosition: null,
      })),
    });

    expect(result).toMatchObject({
      exact: false,
      rounds: 2,
      stableObservations: 1,
      stableSpanMs: 0,
    });
  });

  it.each(["snapshot", "runtime", "ledger"] as const)(
    "records elapsed time and fails closed when %s I/O crosses 300 seconds",
    async (slowStep) => {
      const before = liveSnapshot();
      const after = stoppedSnapshot();
      const ledger: ProviderLedger = { historyRows: [], patchRows: [] };
      let monotonicMs = 0;
      const crossDeadline = (step: typeof slowStep): void => {
        if (slowStep === step) monotonicMs = 300_001;
      };
      const probeRuntime = vi.fn(async () => {
        crossDeadline("runtime");
        return runtimeAbsenceEvidence();
      });
      const readLedger = vi.fn(async () => {
        crossDeadline("ledger");
        return ledger;
      });

      const result = await reconcileStoppedDeployment({
        before,
        beforeLedger: ledger,
        requestStartedAt: "2026-09-08T15:00:00.000Z",
        readSnapshot: vi.fn(async () => {
          crossDeadline("snapshot");
          return after;
        }),
        readLedger,
        probeRuntime,
        sleep: vi.fn().mockResolvedValue(undefined),
        monotonicNow: vi.fn(() => monotonicMs),
        wallNow: vi.fn(() => TEST_NOW + 1_000),
        assessLedger: vi.fn(() => ({
          exact: true,
          mode: "unchanged" as const,
          historyRowsSha256: "1".repeat(64),
          patchRowsSha256: "2".repeat(64),
          addedHistoryRowSha256: null,
          addedHistoryRowCount: 0,
          addedHistoryRowPosition: null,
        })),
      });

      expect(result).toMatchObject({
        exact: false,
        rounds: 1,
        stableObservations: 0,
        totalObservationSpanMs: 300_001,
      });
      expect(result.totalObservationSpanMs).toBeGreaterThan(
        POST_Q_DEPLOYMENT_STOP_LOCK.maximumObservationSpanMs,
      );
      if (slowStep === "snapshot") {
        expect(probeRuntime).not.toHaveBeenCalled();
        expect(readLedger).not.toHaveBeenCalled();
      }
      if (slowStep === "runtime") expect(readLedger).not.toHaveBeenCalled();
    },
  );

  it("parses the complete reviewed containment authority emitted by the verifier", () => {
    const source = reviewedAuthoritySource();
    const parsed = parseReviewedContainmentAuthority(source, {
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
    });

    expect(parsed).toMatchObject({
      candidateSha: CANDIDATE_SHA,
      reviewedPrHeadSha: "d".repeat(40),
      reviewedPullRequestNumber: 97,
      workflowRunId: RUN_ID,
      workflowRunAttempt: 1,
      reviewedAuthorityExact: true,
      freshDispatchWriteGuardExact: true,
    });
    expect(parsed?.sha256).toBe(postQSha256(source));
  });

  it("parses the complete post-Q authority emitted by the verifier", () => {
    const source = postQAuthorityFixtureSource();

    expect(parsePostQAuthority(source, {
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
    })).toEqual({
      sha256: postQSha256(source),
      currentRunId: RUN_ID,
      currentRunAttempt: 1,
      totalWorkflowDispatchRuns: 2,
      priorSkippedAttemptCount: 1,
      qArtifactId: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId,
      qArtifactDigest: POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest,
      singleUseAuthorityExact: true,
    });
  });

  it("rejects extra nested post-Q authority keys and altered failed-Q identity", () => {
    const nestedSections = [
      "containment",
      "failedQ",
      "artifact",
      "qMutationDisposition",
      "checks",
    ] as const;
    const cases: Array<{
      name: string;
      value: ReturnType<typeof postQAuthorityFixture>;
    }> = nestedSections.map((section) => {
      const value = structuredClone(postQAuthorityFixture());
      (value[section] as Record<string, unknown>).unreviewedExtra = true;
      return { name: `extra ${section} key`, value };
    });
    for (const [name, field, replacement] of [
      ["failed-Q workflow id", "workflowId", 344_383_803],
      [
        "failed-Q workflow path",
        "workflowPath",
        ".github/workflows/unreviewed.yml",
      ],
      ["failed-Q head SHA", "headSha", "f".repeat(40)],
    ] as const) {
      const value = structuredClone(postQAuthorityFixture());
      (value.failedQ as Record<string, unknown>)[field] = replacement;
      cases.push({ name, value });
    }

    for (const testCase of cases) {
      expect(parsePostQAuthority(postQAuthorityFixtureSource(testCase.value), {
        candidateSha: CANDIDATE_SHA,
        runId: RUN_ID,
      }), testCase.name).toBeNull();
    }
  });

  it("keeps prepare, apply, and finalize writes phase-disjoint", async () => {
    const prepared = runnerHarness({ phase: "prepare" });

    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      prepared.overrides,
    )).resolves.toBe(0);
    expect([...prepared.writes.keys()]).toEqual(["stop-intent.json"]);
    expect(prepared.stopDeployment).not.toHaveBeenCalled();

    const applied = runnerHarness({
      phase: "apply",
      intentSource: prepared.writes.get("stop-intent.json"),
    });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(0);
    expect([...applied.writes.keys()]).toEqual([
      "stop-apply-terminal.json",
      POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_LEAF,
    ]);
    expect(applied.stopDeployment).toHaveBeenCalledOnce();
    expect(applied.stopDeployment).toHaveBeenCalledWith(TOKEN);
    expect(applied.reconcile).toHaveBeenCalledOnce();
    const applySource = applied.writes.get("stop-apply-terminal.json")!;
    const completionSource = applied.writes.get(
      POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_LEAF,
    )!;
    expect(JSON.parse(completionSource)).toEqual({
      schemaVersion: POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_SCHEMA,
      operation: "permanent-staging-post-q-deployment-stop",
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      applyTerminalSha256: postQSha256(applySource),
      applyTerminalSizeBytes: Buffer.byteLength(applySource),
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    expect(canonicalPostQEvidence(JSON.parse(completionSource))).toBe(
      completionSource,
    );

    const finalized = runnerHarness({
      phase: "finalize",
      intentSource: prepared.writes.get("stop-intent.json"),
      applyTerminalSource: applySource,
      applyCompletionSource: completionSource,
    });
    const finalizeResult = await runProtectedPermanentStagingPostQDeploymentStop(
      finalized.overrides,
    );
    expect([...finalized.writes.keys()]).toEqual([
      "stop-terminal.json",
      POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_LEAF,
    ]);
    expect(finalizeResult).toBe(0);
    expectNoProviderCalls(finalized);

    const terminal = writtenEvidence(finalized, "stop-terminal.json");
    const terminalCompletion = writtenEvidence(
      finalized,
      "stop-terminal-completion.json",
    );
    expect(terminalCompletion.value).toEqual({
      schemaVersion: POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_SCHEMA,
      operation: "permanent-staging-post-q-deployment-stop",
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      terminalSha256: postQSha256(terminal.source),
      terminalSizeBytes: Buffer.byteLength(terminal.source),
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    expect(canonicalPostQEvidence(terminalCompletion.value)).toBe(
      terminalCompletion.source,
    );

    const receipt = JSON.parse(
      finalized.writeOutput.mock.calls.at(-1)![0] as string,
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      phase: "finalize",
      outcome: "stopped",
      attempts: 1,
      failureCode: null,
      retryAllowed: false,
    });
  });

  it("writes a zero-attempt inner terminal when apply target preflight fails", async () => {
    const applied = runnerHarness({
      phase: "apply",
      snapshotBaselineExact: false,
    });

    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(1);
    expect(applied.stopDeployment).not.toHaveBeenCalled();
    expect(applied.reconcile).not.toHaveBeenCalled();
    expect([...applied.writes.keys()]).toEqual(["stop-apply-terminal.json"]);
    const inner = writtenEvidence(applied, "stop-apply-terminal.json");
    expect(inner.value).toMatchObject({
      phase: "apply",
      outcome: "failed_before_attempt",
      failureCode: "target_preflight_failed",
      attempts: 0,
      retryAllowed: false,
      stopRequest: null,
    });
    expect(outputReceiptFrom(applied)).toMatchObject({
      outcome: "failed_before_attempt",
      failureCode: "target_preflight_failed",
      attempts: 0,
    });

    const finalized = runnerHarness({
      phase: "finalize",
      applyTerminalSource: inner.source,
    });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      finalized.overrides,
    )).resolves.toBe(1);
    expectNoProviderCalls(finalized);
    expect(outputReceiptFrom(finalized)).toMatchObject({
      outcome: "failed_before_attempt",
      failureCode: "target_preflight_failed",
      attempts: 0,
    });
    expect(writtenEvidence(finalized, "stop-terminal.json").value).toMatchObject({
      outcome: "failed_before_attempt",
      failureCode: "target_preflight_failed",
      attempts: 0,
      applyTerminal: {
        sha256: postQSha256(inner.source),
        receipt: inner.value,
      },
      nextRequiredProof: null,
    });
  });

  it("rechecks expiry immediately before send and records zero attempts", async () => {
    const deadline = Date.parse(reviewedAuthority().authorizationDeadline);
    const now = vi.fn()
      .mockReturnValueOnce(TEST_NOW)
      .mockReturnValue(deadline);
    const applied = runnerHarness({ phase: "apply", now });

    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(1);
    expect(now).toHaveBeenCalledTimes(2);
    expect(applied.stopDeployment).not.toHaveBeenCalled();
    expect(applied.reconcile).not.toHaveBeenCalled();
    expect(writtenEvidence(applied, "stop-apply-terminal.json").value).toMatchObject({
      outcome: "failed_before_attempt",
      failureCode: "authorization_expired",
      attempts: 0,
      stopRequest: null,
    });
  });

  it("rejects boundary receipts with a missing or extra check before mutation", async () => {
    const exact = JSON.parse(boundaryReceiptSource()) as {
      checks: Record<string, boolean>;
    };
    const missing = structuredClone(exact);
    delete missing.checks.policyValid;
    const extra = structuredClone(exact);
    extra.checks.unreviewedExtraCheck = true;

    for (const receipt of [missing, extra]) {
      const applied = runnerHarness({
        phase: "apply",
        boundaryPreflightSource: compactJson(receipt),
      });
      await expect(runProtectedPermanentStagingPostQDeploymentStop(
        applied.overrides,
      )).resolves.toBe(1);
      expect(applied.stopDeployment).not.toHaveBeenCalled();
      expect(writtenEvidence(
        applied,
        "stop-apply-terminal.json",
      ).value).toMatchObject({
        outcome: "failed_before_attempt",
        failureCode: "boundary_preflight_failed",
        attempts: 0,
      });
    }
  });

  it("contains common apply failures in an untrusted inner and conservative outer", async () => {
    const cases: readonly {
      readonly failureCode: string;
      readonly options: Partial<Parameters<typeof runnerHarness>[0]>;
    }[] = [
      {
        failureCode: "github_context_invalid",
        options: { repositoryExact: false },
      },
      {
        failureCode: "confirmation_invalid",
        options: {
          environmentOverrides: {
            PINTPATH_POST_Q_DEPLOYMENT_STOP_CONFIRMATION: "invalid",
          },
        },
      },
      {
        failureCode: "q_artifact_invalid",
        options: { qArtifactExact: false },
      },
      {
        failureCode: "q_authority_invalid",
        options: { qAuthorityExact: false },
      },
    ];

    for (const testCase of cases) {
      const applied = runnerHarness({
        phase: "apply",
        ...testCase.options,
      });
      await expect(runProtectedPermanentStagingPostQDeploymentStop(
        applied.overrides,
      )).resolves.toBe(1);
      expect(applied.stopDeployment).not.toHaveBeenCalled();
      const inner = writtenEvidence(applied, "stop-apply-terminal.json");
      expect(inner.value).toMatchObject({
        phase: "apply",
        outcome: "failed_before_attempt",
        failureCode: testCase.failureCode,
        attempts: 0,
      });

      const finalized = runnerHarness({
        phase: "finalize",
        applyTerminalSource: inner.source,
      });
      await expect(runProtectedPermanentStagingPostQDeploymentStop(
        finalized.overrides,
      )).resolves.toBe(1);
      expectNoProviderCalls(finalized);
      expect(outputReceiptFrom(finalized)).toMatchObject({
        outcome: "mutation_uncertain",
        failureCode: "terminal_evidence_failed",
        attempts: 1,
      });
      expect(writtenEvidence(finalized, "stop-terminal.json").value).toMatchObject({
        outcome: "mutation_uncertain",
        failureCode: "terminal_evidence_failed",
        attempts: 1,
        applyTerminal: {
          sha256: postQSha256(inner.source),
          receipt: null,
        },
        nextRequiredProof: null,
      });
    }
  });

  it("rejects every non-boolean value in a failure receipt check set", async () => {
    const applied = runnerHarness({
      phase: "apply",
      snapshotBaselineExact: false,
    });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(1);
    const inner = writtenEvidence(applied, "stop-apply-terminal.json");
    const receipt = inner.value.receipt as Record<string, unknown>;
    const checks = receipt.checks as Record<string, boolean>;

    for (const key of Object.keys(checks)) {
      const tampered = structuredClone(inner.value);
      const tamperedReceipt = tampered.receipt as Record<string, unknown>;
      const tamperedChecks = tamperedReceipt.checks as Record<string, unknown>;
      tamperedChecks[key] = checks[key] ? "true" : "false";
      const tamperedSource = canonicalPostQEvidence(tampered);
      const finalized = runnerHarness({
        phase: "finalize",
        applyTerminalSource: tamperedSource,
      });

      await expect(runProtectedPermanentStagingPostQDeploymentStop(
        finalized.overrides,
      )).resolves.toBe(1);
      expectNoProviderCalls(finalized);
      expect(outputReceiptFrom(finalized)).toMatchObject({
        outcome: "mutation_uncertain",
        failureCode: "terminal_evidence_failed",
        attempts: 1,
      });
      expect(writtenEvidence(finalized, "stop-terminal.json").value).toMatchObject({
        applyTerminal: {
          sha256: postQSha256(tamperedSource),
          receipt: null,
        },
      });
    }
  });

  it("records drift and insufficient stability as one-attempt uncertainty", async () => {
    const stable = successfulReconciliation();
    const driftedSnapshot = {
      ...stable.snapshot,
      source: { repo: "unreviewed/drift", image: null },
    };
    const failures = [
      {
        ...stable,
        exact: false,
        snapshot: driftedSnapshot,
      },
      {
        ...stable,
        exact: false,
        rounds: 2,
        stableObservations: 2,
        stableSpanMs: 10_000,
        totalObservationSpanMs: 10_000,
        observations: stable.observations.slice(0, 2),
      },
    ];

    for (const reconciliation of failures) {
      const applied = runnerHarness({ phase: "apply", reconciliation });
      await expect(runProtectedPermanentStagingPostQDeploymentStop(
        applied.overrides,
      )).resolves.toBe(1);
      expect(applied.stopDeployment).toHaveBeenCalledOnce();
      expect(applied.reconcile).toHaveBeenCalledOnce();
      expect(writtenEvidence(
        applied,
        "stop-apply-terminal.json",
      ).value).toMatchObject({
        outcome: "mutation_uncertain",
        failureCode: "reconciliation_failed",
        attempts: 1,
      });
    }
  });

  it("never reports pending success when the apply terminal cannot be written", async () => {
    const applied = runnerHarness({
      phase: "apply",
      writeFailureLeaf: "stop-apply-terminal.json",
    });

    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(1);
    expect(applied.stopDeployment).toHaveBeenCalledOnce();
    expect(applied.writeEvidence).toHaveBeenCalledOnce();
    expect(applied.writes.size).toBe(0);
    expect(outputReceiptFrom(applied)).toMatchObject({
      phase: "apply",
      outcome: "mutation_uncertain",
      failureCode: "mutation_uncertain",
      attempts: 1,
      terminalSha256: null,
      checks: { terminalEvidenceExact: false },
    });
  });

  it("does not promote an apply terminal whose write throws after persistence", async () => {
    const applied = runnerHarness({
      phase: "apply",
      writeThenThrowLeaf: "stop-apply-terminal.json",
    });

    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(1);
    expect(applied.stopDeployment).toHaveBeenCalledOnce();
    expect([...applied.writes.keys()]).toEqual(["stop-apply-terminal.json"]);
    const inner = writtenEvidence(applied, "stop-apply-terminal.json");
    expect(inner.value).toMatchObject({
      phase: "apply",
      outcome: "stopped_pending_boundary_postflight",
      failureCode: null,
      attempts: 1,
    });
    expect(outputReceiptFrom(applied)).toMatchObject({
      phase: "apply",
      outcome: "mutation_uncertain",
      failureCode: "mutation_uncertain",
      attempts: 1,
      terminalSha256: null,
      checks: { terminalEvidenceExact: false },
    });

    const finalized = runnerHarness({
      phase: "finalize",
      applyTerminalSource: inner.source,
    });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      finalized.overrides,
    )).resolves.toBe(1);
    expectNoProviderCalls(finalized);
    expect([...finalized.writes.keys()]).toEqual(["stop-terminal.json"]);
    expect(outputReceiptFrom(finalized)).toMatchObject({
      outcome: "mutation_uncertain",
      failureCode: "terminal_evidence_failed",
      attempts: 1,
      nextRequiredProof: null,
    });
  });

  it("requires the exact canonical apply completion marker for promotion", async () => {
    const applied = runnerHarness({ phase: "apply" });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(0);
    const inner = writtenEvidence(applied, "stop-apply-terminal.json");
    const completion = writtenEvidence(
      applied,
      "stop-apply-terminal-completion.json",
    );
    const marker = completion.value;
    const markerCases: readonly {
      readonly name: string;
      readonly source: string | undefined;
    }[] = [
      { name: "missing", source: undefined },
      {
        name: "wrong digest",
        source: canonicalPostQEvidence({
          ...marker,
          applyTerminalSha256: "0".repeat(64),
        }),
      },
      {
        name: "malformed digest",
        source: canonicalPostQEvidence({
          ...marker,
          applyTerminalSha256: `sha256:${postQSha256(inner.source)}`,
        }),
      },
      {
        name: "wrong size",
        source: canonicalPostQEvidence({
          ...marker,
          applyTerminalSizeBytes: Buffer.byteLength(inner.source) + 1,
        }),
      },
      {
        name: "wrong candidate binding",
        source: canonicalPostQEvidence({
          ...marker,
          candidateSha: "b".repeat(40),
        }),
      },
      {
        name: "wrong run binding",
        source: canonicalPostQEvidence({
          ...marker,
          runId: String(Number(RUN_ID) + 1),
        }),
      },
      {
        name: "extra field",
        source: canonicalPostQEvidence({ ...marker, unreviewed: true }),
      },
    ];

    for (const markerCase of markerCases) {
      const finalized = runnerHarness({
        phase: "finalize",
        applyTerminalSource: inner.source,
        applyCompletionSource: markerCase.source,
      });
      await expect(runProtectedPermanentStagingPostQDeploymentStop(
        finalized.overrides,
      ), markerCase.name).resolves.toBe(1);
      expectNoProviderCalls(finalized);
      expect([...finalized.writes.keys()]).toEqual(["stop-terminal.json"]);
      expect(outputReceiptFrom(finalized)).toMatchObject({
        phase: "finalize",
        outcome: "mutation_uncertain",
        failureCode: "terminal_evidence_failed",
        attempts: 1,
        nextRequiredProof: null,
      });
      expect(writtenEvidence(finalized, "stop-terminal.json").value).toMatchObject({
        applyTerminal: {
          sha256: postQSha256(inner.source),
          completionSha256: markerCase.source === undefined
            ? null
            : postQSha256(markerCase.source),
          receipt: inner.value,
        },
      });
    }
  });

  it("rejects a canonical marker cross-bound to another valid apply terminal", async () => {
    const first = runnerHarness({ phase: "apply" });
    const second = runnerHarness({
      phase: "apply",
      now: vi.fn(() => TEST_NOW + 1),
    });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      first.overrides,
    )).resolves.toBe(0);
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      second.overrides,
    )).resolves.toBe(0);
    const firstInner = writtenEvidence(first, "stop-apply-terminal.json");
    const secondInner = writtenEvidence(second, "stop-apply-terminal.json");
    const secondMarker = writtenEvidence(
      second,
      "stop-apply-terminal-completion.json",
    );
    expect(secondInner.source).not.toBe(firstInner.source);
    expect(secondMarker.value.applyTerminalSha256).toBe(
      postQSha256(secondInner.source),
    );

    const finalized = runnerHarness({
      phase: "finalize",
      applyTerminalSource: firstInner.source,
      applyCompletionSource: secondMarker.source,
    });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      finalized.overrides,
    )).resolves.toBe(1);
    expectNoProviderCalls(finalized);
    expect([...finalized.writes.keys()]).toEqual(["stop-terminal.json"]);
    expect(outputReceiptFrom(finalized)).toMatchObject({
      outcome: "mutation_uncertain",
      failureCode: "terminal_evidence_failed",
      attempts: 1,
      nextRequiredProof: null,
    });
  });

  it("accepts a late apply marker write only after exact trusted readback", async () => {
    const exact = runnerHarness({
      phase: "apply",
      writeThenThrowLeaf: POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_LEAF,
    });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      exact.overrides,
    )).resolves.toBe(0);
    expect([...exact.writes.keys()]).toEqual([
      "stop-apply-terminal.json",
      POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_LEAF,
    ]);
    const exactInner = writtenEvidence(exact, "stop-apply-terminal.json");
    const exactMarker = writtenEvidence(
      exact,
      "stop-apply-terminal-completion.json",
    );
    expect(outputReceiptFrom(exact)).toMatchObject({
      outcome: "stopped_pending_boundary_postflight",
      failureCode: null,
      attempts: 1,
      terminalSha256: postQSha256(exactInner.source),
      checks: { terminalEvidenceExact: true },
    });

    const exactFinalized = runnerHarness({
      phase: "finalize",
      applyTerminalSource: exactInner.source,
      applyCompletionSource: exactMarker.source,
    });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      exactFinalized.overrides,
    )).resolves.toBe(0);

    const tampered = runnerHarness({
      phase: "apply",
      writeThenThrowLeaf: POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_LEAF,
      persistedWriteTransform: (leaf, source) => {
        if (leaf !== POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_LEAF) return source;
        return canonicalPostQEvidence({
          ...(JSON.parse(source) as Record<string, unknown>),
          applyTerminalSha256: "G".repeat(64),
        });
      },
    });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      tampered.overrides,
    )).resolves.toBe(1);
    const tamperedInner = writtenEvidence(tampered, "stop-apply-terminal.json");
    const tamperedMarker = writtenEvidence(
      tampered,
      "stop-apply-terminal-completion.json",
    );
    expect(tamperedMarker.value.applyTerminalSha256).toBe("G".repeat(64));
    expect(outputReceiptFrom(tampered)).toMatchObject({
      outcome: "mutation_uncertain",
      failureCode: "mutation_uncertain",
      attempts: 1,
      terminalSha256: null,
      checks: { terminalEvidenceExact: false },
    });

    const tamperedFinalized = runnerHarness({
      phase: "finalize",
      applyTerminalSource: tamperedInner.source,
      applyCompletionSource: tamperedMarker.source,
    });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      tamperedFinalized.overrides,
    )).resolves.toBe(1);
    expectNoProviderCalls(tamperedFinalized);
    expect(tamperedFinalized.writes.has(
      POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_LEAF,
    )).toBe(false);
  });

  it("records an ambiguous apply once and never promotes it to final", async () => {
    const prepared = runnerHarness({ phase: "prepare" });
    await runProtectedPermanentStagingPostQDeploymentStop(prepared.overrides);
    const builtIntent = intent(postQSha256(boundaryReceiptSource()));
    const applied = runnerHarness({
      phase: "apply",
      intentSource: prepared.writes.get("stop-intent.json"),
      stopAttempt: {
        outcome: "transport_uncertain",
        acknowledgementExact: false,
        querySha256: builtIntent.mutation.querySha256,
        variablesSha256: builtIntent.mutation.variablesSha256,
        requestBodySha256: builtIntent.mutation.requestBodySha256,
        responseBodySha256: null,
        acknowledgementSha256: null,
      },
    });

    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(1);
    expect(applied.stopDeployment).toHaveBeenCalledOnce();
    expect([...applied.writes.keys()]).toEqual(["stop-apply-terminal.json"]);
    expect(applied.writes.has("stop-terminal.json")).toBe(false);
    expect(writtenEvidence(applied, "stop-apply-terminal.json").value).toMatchObject({
      outcome: "mutation_uncertain",
      failureCode: "mutation_uncertain",
      attempts: 1,
      retryAllowed: false,
      stopRequest: {
        outcome: "transport_uncertain",
        acknowledgementExact: false,
        requestBodySha256: builtIntent.mutation.requestBodySha256,
      },
    });
    const receipt = JSON.parse(
      applied.writeOutput.mock.calls.at(-1)![0] as string,
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      phase: "apply",
      outcome: "mutation_uncertain",
      attempts: 1,
      retryAllowed: false,
      failureCode: "mutation_uncertain",
    });
  });

  it("finalizes a valid inner receipt after the authorization deadline", async () => {
    const applied = runnerHarness({ phase: "apply" });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(0);
    const inner = writtenEvidence(applied, "stop-apply-terminal.json");
    const completion = writtenEvidence(
      applied,
      "stop-apply-terminal-completion.json",
    );
    const lateNow = vi.fn(() =>
      Date.parse(reviewedAuthority().authorizationDeadline) + 60_000);
    const finalized = runnerHarness({
      phase: "finalize",
      applyTerminalSource: inner.source,
      applyCompletionSource: completion.source,
      now: lateNow,
    });

    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      finalized.overrides,
    )).resolves.toBe(0);
    expect(lateNow).not.toHaveBeenCalled();
    expectNoProviderCalls(finalized);
    expect(writtenEvidence(finalized, "stop-terminal.json").value).toMatchObject({
      phase: "finalize",
      outcome: "stopped",
      failureCode: null,
      attempts: 1,
      applyTerminal: {
        sha256: postQSha256(inner.source),
        receipt: inner.value,
      },
    });
  });

  it("fails closed on an outer terminal write failure", async () => {
    const applied = runnerHarness({ phase: "apply" });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(0);
    const inner = writtenEvidence(applied, "stop-apply-terminal.json");
    const completion = writtenEvidence(
      applied,
      "stop-apply-terminal-completion.json",
    );
    const finalized = runnerHarness({
      phase: "finalize",
      applyTerminalSource: inner.source,
      applyCompletionSource: completion.source,
      writeFailureLeaf: "stop-terminal.json",
    });

    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      finalized.overrides,
    )).resolves.toBe(1);
    expectNoProviderCalls(finalized);
    expect(finalized.writeEvidence).toHaveBeenCalledOnce();
    expect(finalized.writes.size).toBe(0);
    expect(outputReceiptFrom(finalized)).toMatchObject({
      phase: "finalize",
      outcome: "mutation_uncertain",
      failureCode: "terminal_evidence_failed",
      attempts: 1,
      terminalSha256: null,
      checks: { terminalEvidenceExact: false },
      nextRequiredProof: null,
    });
  });

  it("does not emit an outer completion marker after a late terminal write failure", async () => {
    const applied = runnerHarness({ phase: "apply" });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(0);
    const inner = writtenEvidence(applied, "stop-apply-terminal.json");
    const completion = writtenEvidence(
      applied,
      "stop-apply-terminal-completion.json",
    );
    const finalized = runnerHarness({
      phase: "finalize",
      applyTerminalSource: inner.source,
      applyCompletionSource: completion.source,
      writeThenThrowLeaf: "stop-terminal.json",
    });

    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      finalized.overrides,
    )).resolves.toBe(1);
    expectNoProviderCalls(finalized);
    expect([...finalized.writes.keys()]).toEqual(["stop-terminal.json"]);
    expect(writtenEvidence(finalized, "stop-terminal.json").value).toMatchObject({
      outcome: "stopped",
      failureCode: null,
      attempts: 1,
      nextRequiredProof:
        "EXACT_SUPPORTED_US_WEST_ONE_TO_ASIA_ONE_TOPOLOGY_REPAIR_WHILE_STOPPED",
    });
    expect(outputReceiptFrom(finalized)).toMatchObject({
      phase: "finalize",
      outcome: "mutation_uncertain",
      failureCode: "terminal_evidence_failed",
      attempts: 1,
      terminalSha256: null,
      checks: { terminalEvidenceExact: false },
      nextRequiredProof: null,
    });
  });

  it("accepts a late outer marker write only after exact trusted readback", async () => {
    const applied = runnerHarness({ phase: "apply" });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(0);
    const inner = writtenEvidence(applied, "stop-apply-terminal.json");
    const applyCompletion = writtenEvidence(
      applied,
      "stop-apply-terminal-completion.json",
    );

    const exact = runnerHarness({
      phase: "finalize",
      applyTerminalSource: inner.source,
      applyCompletionSource: applyCompletion.source,
      writeThenThrowLeaf: POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_LEAF,
    });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      exact.overrides,
    )).resolves.toBe(0);
    expect([...exact.writes.keys()]).toEqual([
      "stop-terminal.json",
      POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_LEAF,
    ]);
    const exactTerminal = writtenEvidence(exact, "stop-terminal.json");
    const exactMarker = writtenEvidence(exact, "stop-terminal-completion.json");
    expect(exactMarker.value).toEqual({
      schemaVersion: POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_SCHEMA,
      operation: "permanent-staging-post-q-deployment-stop",
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      terminalSha256: postQSha256(exactTerminal.source),
      terminalSizeBytes: Buffer.byteLength(exactTerminal.source),
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    });
    expect(outputReceiptFrom(exact)).toMatchObject({
      outcome: "stopped",
      failureCode: null,
      attempts: 1,
      terminalSha256: postQSha256(exactTerminal.source),
      checks: { terminalEvidenceExact: true },
    });

    const tampered = runnerHarness({
      phase: "finalize",
      applyTerminalSource: inner.source,
      applyCompletionSource: applyCompletion.source,
      writeThenThrowLeaf: POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_LEAF,
      persistedWriteTransform: (leaf, source) => {
        if (leaf !== POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_LEAF) {
          return source;
        }
        return canonicalPostQEvidence({
          ...(JSON.parse(source) as Record<string, unknown>),
          terminalSha256: "G".repeat(64),
        });
      },
    });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      tampered.overrides,
    )).resolves.toBe(1);
    expectNoProviderCalls(tampered);
    expect([...tampered.writes.keys()]).toEqual([
      "stop-terminal.json",
      POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_LEAF,
    ]);
    expect(writtenEvidence(
      tampered,
      "stop-terminal-completion.json",
    ).value.terminalSha256).toBe("G".repeat(64));
    expect(outputReceiptFrom(tampered)).toMatchObject({
      phase: "finalize",
      outcome: "mutation_uncertain",
      failureCode: "terminal_evidence_failed",
      attempts: 1,
      terminalSha256: null,
      checks: { terminalEvidenceExact: false },
      nextRequiredProof: null,
    });

    const sizeTampered = runnerHarness({
      phase: "finalize",
      applyTerminalSource: inner.source,
      applyCompletionSource: applyCompletion.source,
      writeThenThrowLeaf: POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_LEAF,
      persistedWriteTransform: (leaf, source) => {
        if (leaf !== POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_LEAF) {
          return source;
        }
        const marker = JSON.parse(source) as Record<string, unknown>;
        return canonicalPostQEvidence({
          ...marker,
          terminalSizeBytes: Number(marker.terminalSizeBytes) + 1,
        });
      },
    });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      sizeTampered.overrides,
    )).resolves.toBe(1);
    expectNoProviderCalls(sizeTampered);
    expect(outputReceiptFrom(sizeTampered)).toMatchObject({
      phase: "finalize",
      outcome: "mutation_uncertain",
      failureCode: "terminal_evidence_failed",
      attempts: 1,
      terminalSha256: null,
      checks: { terminalEvidenceExact: false },
      nextRequiredProof: null,
    });
  });

  it.each(["missing", "malformed"] as const)(
    "treats a %s apply terminal as conservative one-attempt uncertainty",
    async (name) => {
      const applied = runnerHarness({
        phase: "apply",
        writeFailureLeaf: name === "missing"
          ? "stop-apply-terminal.json"
          : undefined,
      });
      await expect(runProtectedPermanentStagingPostQDeploymentStop(
        applied.overrides,
      )).resolves.toBe(name === "missing" ? 1 : 0);
      const applyTerminalSource = name === "missing"
        ? undefined
        : `${writtenEvidence(
          applied,
          "stop-apply-terminal.json",
        ).source.slice(0, -2)}\n`;
      const finalized = runnerHarness({
        phase: "finalize",
        applyTerminalSource,
      });

      await expect(runProtectedPermanentStagingPostQDeploymentStop(
        finalized.overrides,
      )).resolves.toBe(1);
      expectNoProviderCalls(finalized);
      expect(outputReceiptFrom(finalized)).toMatchObject({
        phase: "finalize",
        outcome: "mutation_uncertain",
        failureCode: "terminal_evidence_failed",
        attempts: 1,
        retryAllowed: false,
      });
      expect(writtenEvidence(finalized, "stop-terminal.json").value).toMatchObject({
        outcome: "mutation_uncertain",
        failureCode: "terminal_evidence_failed",
        attempts: 1,
        nextRequiredProof: null,
        applyTerminal: {
          sha256: applyTerminalSource === undefined
            ? null
            : postQSha256(applyTerminalSource),
          receipt: null,
        },
      });
    },
  );

  it("rejects null runtime status and raw response-body strings in success evidence", async () => {
    const applied = runnerHarness({ phase: "apply" });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(0);
    const inner = writtenEvidence(applied, "stop-apply-terminal.json");
    const mutations: readonly {
      readonly name: string;
      readonly mutate: (value: Record<string, unknown>) => void;
    }[] = [
      {
        name: "null runtime status",
        mutate: (value) => {
          const providerEvidence = value.providerEvidence as Record<string, unknown>;
          const observations = providerEvidence.observations as Record<string, unknown>[];
          const requests = observations[0]!.runtimeRequests as Record<
            string,
            Record<string, unknown>
          >;
          requests["/health"]!.statusCode = null;
        },
      },
      {
        name: "raw stop response body",
        mutate: (value) => {
          const rawBody = JSON.stringify({ data: { deploymentStop: true } });
          const stopRequest = value.stopRequest as Record<string, unknown>;
          stopRequest.responseBodySha256 = rawBody;
          const receipt = value.receipt as Record<string, unknown>;
          const receiptStopAttempt = receipt.stopAttempt as Record<string, unknown>;
          receiptStopAttempt.responseBodySha256 = rawBody;
        },
      },
    ];

    for (const mutation of mutations) {
      const tampered = structuredClone(inner.value);
      mutation.mutate(tampered);
      const tamperedSource = canonicalPostQEvidence(tampered);
      const finalized = runnerHarness({
        phase: "finalize",
        applyTerminalSource: tamperedSource,
        applyCompletionSource: applyCompletionMarkerSource(tamperedSource),
      });

      await expect(runProtectedPermanentStagingPostQDeploymentStop(
        finalized.overrides,
      ), mutation.name).resolves.toBe(1);
      expectNoProviderCalls(finalized);
      expect(outputReceiptFrom(finalized)).toMatchObject({
        outcome: "mutation_uncertain",
        failureCode: "terminal_evidence_failed",
        attempts: 1,
      });
      expect(writtenEvidence(finalized, "stop-terminal.json").value).toMatchObject({
        applyTerminal: {
          sha256: postQSha256(tamperedSource),
          receipt: null,
        },
      });
    }
  });

  it("rejects inner timing and nested receipt tampering", async () => {
    const applied = runnerHarness({ phase: "apply" });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(0);
    const inner = writtenEvidence(applied, "stop-apply-terminal.json");
    const completion = writtenEvidence(
      applied,
      "stop-apply-terminal-completion.json",
    );
    const deadline = Date.parse(reviewedAuthority().authorizationDeadline);
    const mutations: readonly {
      readonly name: string;
      readonly mutate: (value: Record<string, unknown>) => void;
    }[] = [
      {
        name: "request started at deadline",
        mutate: (value) => {
          const requestWindow = value.requestWindow as Record<string, unknown>;
          requestWindow.startedAt = new Date(deadline).toISOString();
          requestWindow.completedAt = new Date(deadline).toISOString();
        },
      },
      {
        name: "request started after deadline",
        mutate: (value) => {
          const requestWindow = value.requestWindow as Record<string, unknown>;
          requestWindow.startedAt = new Date(deadline + 1).toISOString();
          requestWindow.completedAt = new Date(deadline + 1).toISOString();
        },
      },
      {
        name: "completion after first observation",
        mutate: (value) => {
          const requestWindow = value.requestWindow as Record<string, unknown>;
          const providerEvidence = value.providerEvidence as Record<string, unknown>;
          const observations = providerEvidence.observations as Record<string, unknown>[];
          requestWindow.completedAt = new Date(
            Date.parse(String(observations[0]!.observedAt)) + 1,
          ).toISOString();
        },
      },
      {
        name: "nested receipt schema",
        mutate: (value) => {
          const receipt = value.receipt as Record<string, unknown>;
          receipt.schemaVersion = "tampered-schema";
        },
      },
      {
        name: "nested receipt target",
        mutate: (value) => {
          const receipt = value.receipt as Record<string, unknown>;
          const target = receipt.target as Record<string, unknown>;
          target.deploymentId = "00000000-0000-4000-8000-000000000001";
        },
      },
      {
        name: "nested receipt Q metadata",
        mutate: (value) => {
          const receipt = value.receipt as Record<string, unknown>;
          receipt.qArtifactId = "99999999999";
        },
      },
    ];

    for (const mutation of mutations) {
      const tampered = structuredClone(inner.value);
      mutation.mutate(tampered);
      const tamperedSource = canonicalPostQEvidence(tampered);
      const finalized = runnerHarness({
        phase: "finalize",
        applyTerminalSource: tamperedSource,
        applyCompletionSource: completion.source,
      });
      await expect(runProtectedPermanentStagingPostQDeploymentStop(
        finalized.overrides,
      ), mutation.name).resolves.toBe(1);
      expectNoProviderCalls(finalized);
      expect(outputReceiptFrom(finalized)).toMatchObject({
        outcome: "mutation_uncertain",
        failureCode: "terminal_evidence_failed",
        attempts: 1,
      });
      expect(writtenEvidence(finalized, "stop-terminal.json").value).toMatchObject({
        outcome: "mutation_uncertain",
        failureCode: "terminal_evidence_failed",
        attempts: 1,
        applyTerminal: {
          sha256: postQSha256(tamperedSource),
          receipt: null,
        },
      });
    }
  });

  it("emits an outer failure when boundary postflight is not exact", async () => {
    const applied = runnerHarness({ phase: "apply" });
    await runProtectedPermanentStagingPostQDeploymentStop(applied.overrides);
    const inner = writtenEvidence(applied, "stop-apply-terminal.json");
    const completion = writtenEvidence(
      applied,
      "stop-apply-terminal-completion.json",
    );
    const invalidPostflight = JSON.parse(boundaryReceiptSource()) as {
      outcome: string;
    };
    invalidPostflight.outcome = "failed";
    const finalized = runnerHarness({
      phase: "finalize",
      applyTerminalSource: inner.source,
      applyCompletionSource: completion.source,
      boundaryPostflightSource: compactJson(invalidPostflight),
    });

    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      finalized.overrides,
    )).resolves.toBe(1);
    expectNoProviderCalls(finalized);
    expect(writtenEvidence(finalized, "stop-terminal.json").value).toMatchObject({
      outcome: "mutation_uncertain",
      failureCode: "boundary_postflight_failed",
      attempts: 1,
      boundary: { postflightExact: false },
      nextRequiredProof: null,
    });
  });

  it("preserves a valid uncertain inner attempt without successor proof", async () => {
    const builtIntent = intent(postQSha256(boundaryReceiptSource()));
    const stopAttempt: StopAttempt = {
      outcome: "transport_uncertain",
      acknowledgementExact: false,
      querySha256: builtIntent.mutation.querySha256,
      variablesSha256: builtIntent.mutation.variablesSha256,
      requestBodySha256: builtIntent.mutation.requestBodySha256,
      responseBodySha256: "9".repeat(64),
      acknowledgementSha256: null,
    };
    const applied = runnerHarness({ phase: "apply", stopAttempt });
    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      applied.overrides,
    )).resolves.toBe(1);
    const inner = writtenEvidence(applied, "stop-apply-terminal.json");
    const finalized = runnerHarness({
      phase: "finalize",
      applyTerminalSource: inner.source,
    });

    await expect(runProtectedPermanentStagingPostQDeploymentStop(
      finalized.overrides,
    )).resolves.toBe(1);
    expectNoProviderCalls(finalized);
    const outer = writtenEvidence(finalized, "stop-terminal.json").value;
    expect(outer).toMatchObject({
      phase: "finalize",
      outcome: "mutation_uncertain",
      failureCode: "mutation_uncertain",
      attempts: 1,
      authorizesDownstream: false,
      nextRequiredProof: null,
      applyTerminal: {
        sha256: postQSha256(inner.source),
        receipt: inner.value,
      },
    });
    expect(outputReceiptFrom(finalized)).toMatchObject({
      outcome: "mutation_uncertain",
      attempts: 1,
      stopAttempt,
      nextRequiredProof: null,
    });
  });

  it("pins phase-specific artifact filenames and rejects cross-phase arguments", () => {
    const base = [
      "--candidate-sha", CANDIDATE_SHA,
      "--q-artifact-dir", "/tmp/q-artifact",
      "--evidence-dir", "/tmp/evidence",
      "--q-authority-file", "/tmp/q-authority.json",
      "--reviewed-authority-file", "/tmp/reviewed-authority.json",
    ];
    const apply = [
      ...base,
      "--intent-file", "/tmp/stop-intent.json",
      "--intent-artifact-id", "10060000000",
      "--intent-artifact-digest", `sha256:${"1".repeat(64)}`,
      "--intent-artifact-metadata-file", "/tmp/intent-artifact.json",
      "--boundary-preflight-file", "/tmp/boundary-preflight.json",
    ];

    expect(postQDeploymentStopExecutorInternals.parseArgs([
      "--phase", "prepare",
      ...base,
    ])).toMatchObject({
      phase: "prepare",
      intentFile: null,
      boundaryPreflightFile: null,
      applyTerminalFile: null,
    });
    expect(postQDeploymentStopExecutorInternals.parseArgs([
      "--phase", "apply",
      ...apply,
    ])).toMatchObject({
      phase: "apply",
      intentFile: "/tmp/stop-intent.json",
      intentArtifactMetadataFile: "/tmp/intent-artifact.json",
      boundaryPreflightFile: "/tmp/boundary-preflight.json",
      boundaryPostflightFile: null,
      applyTerminalFile: null,
    });
    expect(postQDeploymentStopExecutorInternals.parseArgs([
      "--phase", "finalize",
      ...apply,
      "--boundary-postflight-file", "/tmp/boundary-postflight.json",
      "--apply-terminal-file", "/tmp/stop-apply-terminal.json",
    ])).toMatchObject({
      phase: "finalize",
      boundaryPostflightFile: "/tmp/boundary-postflight.json",
      applyTerminalFile: "/tmp/stop-apply-terminal.json",
    });
    expect(postQDeploymentStopExecutorInternals.parseArgs([
      "--phase", "prepare",
      ...apply,
    ])).toBeNull();
  });
});
