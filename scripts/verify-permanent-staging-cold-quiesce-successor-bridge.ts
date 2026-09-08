import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  authorityExact,
  canonical,
  COLD_RECOVERY_CLI_SHA256,
  COLD_RECOVERY_LOCK,
  COLD_RECOVERY_SCOPE_QUERY,
  fullStateCanonical,
  railwayCall,
  readColdRecoveryState,
  readOnlyTokensExact,
  readPrivateEvidence,
  sha256,
  tokenScopeExact,
  writeDurable,
  type ColdRecoveryState,
} from "./lib/permanent-staging-cold-recovery.js";

export const COLD_QUIESCE_SUCCESSOR_BRIDGE = Object.freeze({
  operation: "cold-recovery-successor-quiesce",
  priorCandidateSha: "838e8c877dcafc0a822a12e5a26afa81c26924a3",
  priorReviewedHeadSha: "cc2c5311d47f3e895173cb11ef094ef856e0cf07",
  priorTreeSha: "9da75485e85addfec7096b1c04c52f6780d17b64",
  priorPullRequestNumber: 90,
  priorMergedAt: "2026-09-07T18:18:58Z",
  priorPrepareRunId: "34152745186",
  priorQuiesceRunId: "34153306935",
  priorQuiesceRunCompletedAt: "2026-09-07T18:57:20.000Z",
  successorGraceHours: 24,
  successorDeadline: "2026-09-08T18:57:20.000Z",
  priorReadOnlyReconcileRunId: "34154020478",
  intermediateCandidateSha: "919cbbc9ed4a5bb1d99bc2624f5b534e31ddb604",
  intermediateReviewedHeadSha:
    "a8448524162c36da3d220c4b8aa21dd42cb11535",
  intermediateTreeSha: "06257eba9476e393fe54b70395af8641f8b6d59a",
  intermediatePullRequestNumber: 91,
  intermediateMergedAt: "2026-09-08T02:22:51Z",
  intermediateAmbiguousPrepareRunId: "34180322982",
  intermediateFailedReadOnlyPrepareReconcileRunId: "34181145015",
  artifactId: "10030213299",
  artifactName:
    "pintpath-permanent-staging-cold-quiesce-838e8c877dcafc0a822a12e5a26afa81c26924a3",
  artifactDigest:
    "sha256:3f830a7376e604a46e0d8cfe3521fc8eb4e1db444ab73bec4063c22442c42fbe",
  evidence: Object.freeze({
    receipt: Object.freeze({
      filename: "cold-quiesce-receipt.json",
      sha256: "e9fa51ae3a56f405ba091417299cf6b4c3d0ad19d9ed8ff8601a7f51a450e0fd",
    }),
    intent: Object.freeze({
      filename: "cold-quiesce-intent.json",
      sha256: "7f37309fd87088b2333067387ba234622e4f24f8a9bcf2029ccb698b6ca12421",
    }),
    prerequisites: Object.freeze({
      filename: "prerequisites-verification.json",
      sha256: "b17e6b115d6331ba63b7abdd8a130d39ae2008f652480bbc167de4e9bb84b8bb",
    }),
    reviewedAuthority: Object.freeze({
      filename: "reviewed-authority.json",
      sha256: "f45df8c1260857eddbe1e326064ba822169d800392c4bf8fc95f6591df5c0d41",
    }),
  }),
  priorCliFailure: Object.freeze({
    cliVersion: "5.32.0",
    cliSha256: COLD_RECOVERY_CLI_SHA256,
    stderrSha256:
      "5df1ca8f5b08f53475635a850aaab5837e482d4096e9f6b319c4f962f4400930",
    normalizedReplicaAssignment:
      "project=48d8c6cd-1c66-4148-874b-20877f48e1a5",
    deterministicPrecommitBarrier:
      "replica-u64-parse-before-commit_scale_patch",
    scaleMutationPathReachable: false,
    providerWriteCommitted: false,
  }),
  sourceProof: Object.freeze({
    commandProducer: Object.freeze({
      repository: "blackmagic30/Beer",
      candidateSha: "838e8c877dcafc0a822a12e5a26afa81c26924a3",
      path: "scripts/lib/permanent-staging-cold-recovery.ts",
      gitBlobSha: "beb1eb9ac760101b3b477fe9960dfbe6f7332d7a",
      sha256:
        "3f761dd08c8a08f872fc9e37d626aac64614092aa0de548deeaf1b890952450c",
    }),
    railwayCli: Object.freeze({
      repository: "railwayapp/cli",
      version: "5.32.0",
      tag: "v5.32.0",
      tagCommitSha: "5a8c5065b5cb929d7a1cadf7e168c2eed9453999",
      main: Object.freeze({
        path: "src/main.rs",
        gitBlobSha: "e4516626d224e239ef3d74f9f85e33ea84b50d47",
        sha256:
          "09f30a5fa1ee19df3a352796ab9bf6a4ca599145bc08972717c3c4fb8147754d",
      }),
      scale: Object.freeze({
        path: "src/commands/scale.rs",
        gitBlobSha: "8d5530d85f2d5ce8771610417eb47787752b633c",
        sha256:
          "f015a7aa1cd9a90d75d6f9bd4903faed28569b942b61dfc5fe7e2638360b86f9",
      }),
    }),
  }),
} as const);

export const COLD_QUIESCE_SUCCESSOR_BRIDGE_SCHEMA =
  "pintpath-permanent-staging-cold-quiesce-successor-bridge/v2" as const;

const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;

interface BridgeArguments {
  readonly candidateSha: string;
  readonly currentPrepareRunId: string;
  readonly priorCandidateSha: string;
  readonly priorQuiesceRunId: string;
  readonly priorArtifactDirectory: string;
  readonly reviewedAuthorityFile: string;
  readonly evidenceDirectory: string;
}

interface BridgeDependencies {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  readonly readState?: (
    fetchImpl: typeof fetch,
    token: string,
    configuredReplicas: 1,
  ) => Promise<ColdRecoveryState | null>;
  readonly readScope?: (
    fetchImpl: typeof fetch,
    token: string,
  ) => Promise<unknown>;
  readonly writeOutput?: (value: string) => void;
  readonly now?: () => Date;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string): never {
  throw new Error(`cold_quiesce_successor_bridge_${code}`);
}

export function parseColdQuiesceSuccessorBridgeArguments(
  argv: readonly string[],
): BridgeArguments | null {
  if (argv.length !== 14) return null;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || values.has(key)) return null;
    values.set(key, value);
  }
  const allowed = new Set([
    "--candidate-sha",
    "--prepare-run-id",
    "--prior-candidate-sha",
    "--prior-quiesce-run-id",
    "--prior-artifact-dir",
    "--reviewed-authority-file",
    "--evidence-dir",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))) return null;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const currentPrepareRunId = values.get("--prepare-run-id") ?? "";
  const priorCandidateSha = values.get("--prior-candidate-sha") ?? "";
  const priorQuiesceRunId = values.get("--prior-quiesce-run-id") ?? "";
  const priorArtifactDirectory = values.get("--prior-artifact-dir") ?? "";
  const reviewedAuthorityFile = values.get("--reviewed-authority-file") ?? "";
  const evidenceDirectory = values.get("--evidence-dir") ?? "";
  if (
    !SHA.test(candidateSha) ||
    !RUN_ID.test(currentPrepareRunId) ||
    currentPrepareRunId === priorQuiesceRunId ||
    currentPrepareRunId === COLD_QUIESCE_SUCCESSOR_BRIDGE.priorPrepareRunId ||
    priorCandidateSha !== COLD_QUIESCE_SUCCESSOR_BRIDGE.priorCandidateSha ||
    candidateSha === priorCandidateSha ||
    !RUN_ID.test(priorQuiesceRunId) ||
    priorQuiesceRunId !== COLD_QUIESCE_SUCCESSOR_BRIDGE.priorQuiesceRunId ||
    !path.isAbsolute(priorArtifactDirectory) ||
    !path.isAbsolute(reviewedAuthorityFile) ||
    path.basename(reviewedAuthorityFile) !== "reviewed-authority.json" ||
    !path.isAbsolute(evidenceDirectory)
  ) return null;
  return {
    candidateSha,
    currentPrepareRunId,
    priorCandidateSha,
    priorQuiesceRunId,
    priorArtifactDirectory,
    reviewedAuthorityFile,
    evidenceDirectory,
  };
}

function parseJson(source: string, code: string): Record<string, unknown> {
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value)) fail(code);
    return value;
  } catch {
    fail(code);
  }
}

function readPinnedEvidence(
  directory: string,
  evidence: { readonly filename: string; readonly sha256: string },
): { readonly source: string; readonly value: Record<string, unknown> } {
  const filename = path.resolve(directory, evidence.filename);
  if (path.dirname(filename) !== path.resolve(directory)) {
    fail("artifact_contents_invalid");
  }
  let source: string;
  try {
    source = readPrivateEvidence(filename);
  } catch {
    fail("artifact_contents_invalid");
  }
  if (sha256(source) !== evidence.sha256) fail("artifact_contents_invalid");
  return { source, value: parseJson(source, "artifact_contents_invalid") };
}

function priorArtifactExact(directory: string): Readonly<Record<string, string>> {
  const expected = COLD_QUIESCE_SUCCESSOR_BRIDGE;
  const receipt = readPinnedEvidence(directory, expected.evidence.receipt);
  const intent = readPinnedEvidence(directory, expected.evidence.intent);
  const prerequisites = readPinnedEvidence(
    directory,
    expected.evidence.prerequisites,
  );
  const priorAuthority = readPinnedEvidence(
    directory,
    expected.evidence.reviewedAuthority,
  );
  const commandEvidence = record(receipt.value.commandEvidence)
    ? receipt.value.commandEvidence
    : null;
  const receiptPrepare = record(receipt.value.preparePrerequisite)
    ? receipt.value.preparePrerequisite
    : null;
  const receiptChecks = record(receipt.value.checks)
    ? receipt.value.checks
    : null;
  const priorReviewedPullRequest = record(prerequisites.value.reviewedPullRequest)
    ? prerequisites.value.reviewedPullRequest
    : null;
  const consumer = record(prerequisites.value.consumer)
    ? prerequisites.value.consumer
    : null;
  const prerequisiteRows = Array.isArray(prerequisites.value.prerequisites)
    ? prerequisites.value.prerequisites
    : [];
  const selectedPrepare = prerequisiteRows.length === 1 &&
      record(prerequisiteRows[0])
    ? prerequisiteRows[0]
    : null;
  if (
    receipt.value.schemaVersion !==
      "pintpath-permanent-staging-cold-quiesce/v2" ||
    receipt.value.operation !== "cold-quiesce" ||
    receipt.value.outcome !== "mutation_uncertain" ||
    receipt.value.failureCode !== "reconciliation_failed" ||
    receipt.value.candidateSha !== expected.priorCandidateSha ||
    receipt.value.sourceSha !== COLD_RECOVERY_LOCK.sourceSha ||
    receipt.value.attempts !== 1 ||
    receipt.value.retryAllowed !== false ||
    receipt.value.intentSha256 !== expected.evidence.intent.sha256 ||
    receipt.value.normalOneToZeroReceiptClaimed !== false ||
    receipt.value.secretMaterialIncluded !== false ||
    receipt.value.secretDerivedCommitmentsIncluded !== false ||
    receiptPrepare?.runId !== expected.priorPrepareRunId ||
    commandEvidence?.exitCode !== 1 ||
    commandEvidence?.timedOut !== false ||
    commandEvidence?.stdoutSha256 !== sha256("") ||
    commandEvidence?.stderrSha256 !== expected.priorCliFailure.stderrSha256 ||
    receiptChecks?.cliExact !== true ||
    receiptChecks?.durableIntentExact !== true ||
    receiptChecks?.providerPrewriteReasserted !== true ||
    receiptChecks?.writeAttemptedAtMostOnce !== true ||
    receiptChecks?.acknowledgementExact !== false ||
    receiptChecks?.exactZeroStateAfter !== false ||
    intent.value.schemaVersion !==
      "pintpath-permanent-staging-cold-quiesce-intent/v1" ||
    intent.value.candidateSha !== expected.priorCandidateSha ||
    intent.value.prepareRunId !== expected.priorPrepareRunId ||
    intent.value.maximumAttempts !== 1 ||
    intent.value.retryAllowed !== false ||
    intent.value.secretMaterialIncluded !== false ||
    intent.value.secretDerivedCommitmentsIncluded !== false ||
    prerequisites.value.schemaVersion !==
      "pintpath-permanent-staging-worker-bootstrap-prerequisites/v4" ||
    prerequisites.value.operation !== "cold-quiesce" ||
    prerequisites.value.candidateSha !== expected.priorCandidateSha ||
    priorReviewedPullRequest?.number !== expected.priorPullRequestNumber ||
    priorReviewedPullRequest?.reviewedHeadSha !== expected.priorReviewedHeadSha ||
    priorReviewedPullRequest?.mergeCommitSha !== expected.priorCandidateSha ||
    priorReviewedPullRequest?.treeSha !== expected.priorTreeSha ||
    consumer?.runId !== expected.priorQuiesceRunId ||
    selectedPrepare?.kind !== "cold-prepare" ||
    selectedPrepare?.runId !== expected.priorPrepareRunId ||
    priorAuthority.value.command !==
      "verify-github-reviewed-candidate-authority" ||
    priorAuthority.value.ok !== true ||
    priorAuthority.value.candidateSha !== expected.priorCandidateSha ||
    priorAuthority.value.operation !== "cold-recovery-quiesce" ||
    priorAuthority.value.workflowRunId !== expected.priorQuiesceRunId ||
    priorAuthority.value.reviewedAuthorityExact !== true ||
    priorAuthority.value.freshDispatchWriteGuardExact !== true
  ) fail("artifact_contents_invalid");
  return Object.freeze({
    receiptSha256: expected.evidence.receipt.sha256,
    intentSha256: expected.evidence.intent.sha256,
    prerequisitesSha256: expected.evidence.prerequisites.sha256,
    priorReviewedAuthoritySha256:
      expected.evidence.reviewedAuthority.sha256,
  });
}

function currentAuthorityExact(
  source: string,
  candidateSha: string,
  currentRunId: string,
  currentPrepareRunId: string,
): boolean {
  const value = parseJson(source, "reviewed_authority_invalid");
  const expected = COLD_QUIESCE_SUCCESSOR_BRIDGE;
  return `${JSON.stringify(value)}\n` === source &&
    value.command === "verify-github-reviewed-candidate-authority" &&
    value.ok === true &&
    value.schemaVersion === 1 &&
    value.kind === "pintpath-github-reviewed-candidate-authority" &&
    value.repository === COLD_RECOVERY_LOCK.repository &&
    value.candidateSha === candidateSha &&
    value.operation === expected.operation &&
    value.workflowPath ===
      ".github/workflows/recover-permanent-staging-cold-zero.yml" &&
    value.workflowRunId === currentRunId &&
    value.workflowRunAttempt === 1 &&
    value.selectedColdPrepareRunId === currentPrepareRunId &&
    value.priorAmbiguousColdQuiesceCandidateSha ===
      expected.priorCandidateSha &&
    value.priorAmbiguousColdQuiesceReviewedHeadSha ===
      expected.priorReviewedHeadSha &&
    value.priorAmbiguousColdQuiesceTreeSha === expected.priorTreeSha &&
    value.priorAmbiguousColdQuiescePullRequestNumber ===
      expected.priorPullRequestNumber &&
    value.priorAmbiguousColdQuiesceCandidateMergedAt ===
      expected.priorMergedAt &&
    value.priorAmbiguousColdQuiesceRunId === expected.priorQuiesceRunId &&
    value.priorAmbiguousColdQuiesceRunCompletedAt ===
      expected.priorQuiesceRunCompletedAt &&
    value.coldQuiesceSuccessorGraceHours === expected.successorGraceHours &&
    value.coldQuiesceSuccessorDeadline === expected.successorDeadline &&
    value.coldQuiesceSuccessorWithinGraceExact === true &&
    value.priorColdPrepareRunId === expected.priorPrepareRunId &&
    value.priorFailedReadOnlyColdQuiesceReconcileRunId ===
      expected.priorReadOnlyReconcileRunId &&
    value.intermediateColdRecoveryCandidateSha ===
      expected.intermediateCandidateSha &&
    value.intermediateColdRecoveryReviewedHeadSha ===
      expected.intermediateReviewedHeadSha &&
    value.intermediateColdRecoveryTreeSha === expected.intermediateTreeSha &&
    value.intermediateColdRecoveryPullRequestNumber ===
      expected.intermediatePullRequestNumber &&
    value.intermediateColdRecoveryCandidateMergedAt ===
      expected.intermediateMergedAt &&
    value.intermediateAmbiguousColdPrepareRunId ===
      expected.intermediateAmbiguousPrepareRunId &&
    value.intermediateFailedReadOnlyColdPrepareReconcileRunId ===
      expected.intermediateFailedReadOnlyPrepareReconcileRunId &&
    value.priorAmbiguousColdQuiesceArtifactId === expected.artifactId &&
    value.priorAmbiguousColdQuiesceArtifactName === expected.artifactName &&
    value.priorAmbiguousColdQuiesceArtifactDigest ===
      expected.artifactDigest &&
    value.coldQuiesceSuccessorDirectParentExact === true &&
    value.coldQuiesceSuccessorPriorToIntermediateParentExact === true &&
    value.coldQuiesceSuccessorTwoHopLineageExact === true &&
    value.coldQuiesceSuccessorPriorHistoryExact === true &&
    value.coldQuiesceSuccessorIntermediateHistoryExact === true &&
    value.coldQuiesceSuccessorAllRefsHistoryExact === true &&
    value.coldQuiesceSuccessorCurrentPrepareExact === true &&
    value.coldQuiesceSuccessorArtifactMetadataExact === true &&
    value.coldQuiesceSuccessorBridgeRequired === true &&
    value.completeRetainedHistoryExact === true &&
    value.stagingLifecycleSealed === false &&
    value.reviewedAuthorityExact === true &&
    value.freshDispatchWriteGuardExact === true;
}

export async function verifyPermanentStagingColdQuiesceSuccessorBridge(
  args: BridgeArguments,
  dependencies: BridgeDependencies = {},
): Promise<Record<string, unknown>> {
  const env = dependencies.env ?? process.env;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const currentRunId = env.GITHUB_RUN_ID ?? "";
  if (
    !RUN_ID.test(currentRunId) ||
    currentRunId === args.currentPrepareRunId ||
    !authorityExact(
      env,
      "quiesce",
      args.candidateSha,
      COLD_RECOVERY_LOCK.sourceSha,
    )
  ) fail("environment_invalid");
  const verifiedAt = (dependencies.now ?? (() => new Date()))();
  if (
    !Number.isFinite(verifiedAt.getTime()) ||
    verifiedAt.getTime() >= Date.parse(
      COLD_QUIESCE_SUCCESSOR_BRIDGE.successorDeadline,
    )
  ) fail("successor_deadline_expired");
  const tokens = readOnlyTokensExact(env);
  if (!tokens) fail("token_scope_invalid");
  let reviewedAuthoritySource: string;
  try {
    reviewedAuthoritySource = readPrivateEvidence(args.reviewedAuthorityFile);
  } catch {
    fail("reviewed_authority_invalid");
  }
  if (!currentAuthorityExact(
    reviewedAuthoritySource,
    args.candidateSha,
    currentRunId,
    args.currentPrepareRunId,
  )) fail("reviewed_authority_invalid");
  const evidence = priorArtifactExact(args.priorArtifactDirectory);

  const readScope = dependencies.readScope ?? (async (providerFetch, token) =>
    await railwayCall(providerFetch, token, COLD_RECOVERY_SCOPE_QUERY, {}));
  if (!tokenScopeExact(await readScope(fetchImpl, tokens.metadata))) {
    fail("token_scope_invalid");
  }
  const readState = dependencies.readState ?? readColdRecoveryState;
  const state = await readState(fetchImpl, tokens.metadata, 1);
  const expectedConfiguredRegions = [{
    region: COLD_RECOVERY_LOCK.configuredRegionBefore,
    numReplicas: 1,
  }];
  const expectedDeploymentRegions = [{
    region: COLD_RECOVERY_LOCK.region,
    numReplicas: 1,
  }];
  if (
    state === null ||
    state.configuredReplicas !== 1 ||
    JSON.stringify(state.configuredRegions) !==
      JSON.stringify(expectedConfiguredRegions) ||
    JSON.stringify(state.deploymentRegions) !==
      JSON.stringify(expectedDeploymentRegions) ||
    state.deployment.commitHash !== COLD_RECOVERY_LOCK.sourceSha ||
    state.latestDeployment.id !== COLD_RECOVERY_LOCK.deploymentId ||
    state.activeDeployments.length !== 0
  ) fail("live_topology_invalid");

  const receipt = {
    schemaVersion: COLD_QUIESCE_SUCCESSOR_BRIDGE_SCHEMA,
    operation: "cold-quiesce-successor-bridge",
    candidateSha: args.candidateSha,
    currentRunId,
    currentPrepareRunId: args.currentPrepareRunId,
    sourceSha: COLD_RECOVERY_LOCK.sourceSha,
    priorCandidateSha: args.priorCandidateSha,
    priorQuiesceRunId: args.priorQuiesceRunId,
    priorAmbiguousColdQuiesceRunCompletedAt:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorQuiesceRunCompletedAt,
    coldQuiesceSuccessorGraceHours:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.successorGraceHours,
    coldQuiesceSuccessorDeadline:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.successorDeadline,
    coldQuiesceSuccessorWithinGraceExact: true,
    priorReadOnlyReconcileRunId:
      COLD_QUIESCE_SUCCESSOR_BRIDGE.priorReadOnlyReconcileRunId,
    intermediateCandidate: {
      candidateSha: COLD_QUIESCE_SUCCESSOR_BRIDGE.intermediateCandidateSha,
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
    priorArtifact: {
      id: COLD_QUIESCE_SUCCESSOR_BRIDGE.artifactId,
      name: COLD_QUIESCE_SUCCESSOR_BRIDGE.artifactName,
      digest: COLD_QUIESCE_SUCCESSOR_BRIDGE.artifactDigest,
      ...evidence,
    },
    priorCliFailure: COLD_QUIESCE_SUCCESSOR_BRIDGE.priorCliFailure,
    sourceProof: COLD_QUIESCE_SUCCESSOR_BRIDGE.sourceProof,
    liveTopology: {
      configuredReplicas: state.configuredReplicas,
      configuredRegions: state.configuredRegions,
      legacyAggregateReplicas: state.numReplicas,
      deploymentManifestRegions: state.deploymentRegions,
      liveStateSha256: sha256(fullStateCanonical(state)),
    },
    reviewedAuthoritySha256: sha256(reviewedAuthoritySource),
    verifiedAt: verifiedAt.toISOString(),
    checks: {
      reviewedSuccessorAuthorityExact: true,
      directSuccessorLineageExact: true,
      priorToIntermediateLineageExact: true,
      twoHopSuccessorLineageExact: true,
      priorColdHistoryExact: true,
      intermediateColdHistoryExact: true,
      priorArtifactMetadataExact: true,
      priorArtifactContentsExact: true,
      sourceAnchorsExact: true,
      priorCliDeterministicPrecommitBarrierExact: true,
      readOnlyTokenScopeExact: true,
      configuredLiveTopologyExact: true,
      deploymentManifestIdentityExact: true,
      noSecondScaleWritePerformed: true,
    },
    nextRequiredProof: "FRESH_REVIEWED_SUCCESSOR_CONFIGURED_ONE_TO_ZERO",
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
  writeDurable(
    args.evidenceDirectory,
    "cold-quiesce-successor-bridge.json",
    canonical(receipt),
  );
  return receipt;
}

export async function runPermanentStagingColdQuiesceSuccessorBridge(
  argv: readonly string[],
  dependencies: BridgeDependencies = {},
): Promise<number> {
  const writeOutput = dependencies.writeOutput ??
    ((value: string) => process.stdout.write(value));
  try {
    const args = parseColdQuiesceSuccessorBridgeArguments(argv);
    if (!args) fail("arguments_invalid");
    const receipt = await verifyPermanentStagingColdQuiesceSuccessorBridge(
      args,
      dependencies,
    );
    writeOutput(`${JSON.stringify({
      command: "verify-permanent-staging-cold-quiesce-successor-bridge",
      ok: true,
      candidateSha: receipt.candidateSha,
      currentRunId: receipt.currentRunId,
      priorCandidateSha: receipt.priorCandidateSha,
      priorQuiesceRunId: receipt.priorQuiesceRunId,
      configuredReplicas: 1,
      nextRequiredProof: receipt.nextRequiredProof,
    })}\n`);
    return 0;
  } catch (error) {
    writeOutput(`${JSON.stringify({
      command: "verify-permanent-staging-cold-quiesce-successor-bridge",
      ok: false,
      failureCode: error instanceof Error
        ? error.message
        : "cold_quiesce_successor_bridge_unexpected_failure",
    })}\n`);
    return 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runPermanentStagingColdQuiesceSuccessorBridge(
    process.argv.slice(2),
  );
}
