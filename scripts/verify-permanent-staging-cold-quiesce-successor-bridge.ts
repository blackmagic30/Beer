import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  authorityExact,
  canonical,
  COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
  COLD_RECOVERY_CLI_SHA256,
  COLD_RECOVERY_LOCK,
  COLD_RECOVERY_SCOPE_QUERY,
  fullStateCanonical,
  parseColdQuiesceSuccessorBinding,
  railwayCall,
  readColdRecoveryState,
  readOnlyTokensExact,
  readPrivateEvidence,
  sha256,
  tokenScopeExact,
  writeDurable,
  type ColdRecoveryState,
} from "./lib/permanent-staging-cold-recovery.js";
import {
  readPermanentStagingColdProviderNoWriteProof,
  type ColdProviderNoWriteProof,
} from "./lib/permanent-staging-cold-provider-history.js";

export const COLD_QUIESCE_SUCCESSOR_BRIDGE = Object.freeze({
  operation: "cold-recovery-successor-quiesce",
  legacyCandidateSha: "838e8c877dcafc0a822a12e5a26afa81c26924a3",
  legacyReviewedHeadSha: "cc2c5311d47f3e895173cb11ef094ef856e0cf07",
  legacyTreeSha: "9da75485e85addfec7096b1c04c52f6780d17b64",
  legacyPullRequestNumber: 90,
  legacyMergedAt: "2026-09-07T18:18:58Z",
  legacyPrepareRunId: "34152745186",
  legacyQuiesceRunId: "34153306935",
  legacyQuiesceRunCompletedAt: "2026-09-07T18:57:20.000Z",
  successorGraceHours: 24,
  successorDeadline: "2026-09-08T18:57:20.000Z",
  legacyReadOnlyReconcileRunId: "34154020478",
  intermediateCandidateSha: "919cbbc9ed4a5bb1d99bc2624f5b534e31ddb604",
  intermediateReviewedHeadSha:
    "a8448524162c36da3d220c4b8aa21dd42cb11535",
  intermediateTreeSha: "06257eba9476e393fe54b70395af8641f8b6d59a",
  intermediatePullRequestNumber: 91,
  intermediateMergedAt: "2026-09-08T02:22:51Z",
  intermediateAmbiguousPrepareRunId: "34180322982",
  intermediateFailedReadOnlyPrepareReconcileRunId: "34181145015",
  priorArtifactId: "10040956324",
  priorArtifactName:
    "pintpath-permanent-staging-cold-quiesce-1161e7ecd421556b104bcae059e8764ebf4a545e",
  priorArtifactDigest:
    "sha256:3db418b86eea098ff4cf8c3a5198ac445d5a51c2f0ac7481dce288027c70166e",
  priorCandidateSha: "1161e7ecd421556b104bcae059e8764ebf4a545e",
  priorReviewedHeadSha: "23f6b96154de7a0eb5a0cc90136d3796a1301668",
  priorTreeSha: "8a58c3eb755a68a2c456a5abff34fa7c01a9af3e",
  priorPullRequestNumber: 93,
  priorMergedAt: "2026-09-08T04:04:40Z",
  priorPrepareRunId: "34186355641",
  priorQuiesceRunId: "34186930666",
  priorQuiesceRunCompletedAt: "2026-09-08T04:32:27.000Z",
  priorEvidence: Object.freeze({
    receipt: Object.freeze({
      filename: "cold-quiesce-receipt.json",
      sha256: "e7b02c804d93b3d053551cf3373892768a71361bc59acdbf8a403efa0b4361cf",
    }),
    intent: Object.freeze({
      filename: "cold-quiesce-intent.json",
      sha256: "661406730dcac531cb7fc1c8af2916731b68a88f3e0a55e1f71b67c6eaa0b57c",
    }),
    successorBridge: Object.freeze({
      filename: "cold-quiesce-successor-bridge.json",
      sha256: "72c773b44f376b8368495f8461be4789a6de86c9e05fc18de6c14733ddfc2c03",
    }),
    prerequisites: Object.freeze({
      filename: "prerequisites-verification.json",
      sha256: "ba52630022c2c80f5d294716bc9dfffa5b8ae1dd7b6c6dcbe621f81191a83ffb",
    }),
    reviewedAuthority: Object.freeze({
      filename: "reviewed-authority.json",
      sha256: "973faf61ab61cec680ad064a88624c887b516a125b21f6792090b21d5a33fb46",
    }),
  }),
  legacyArtifactId: "10030213299",
  legacyArtifactName:
    "pintpath-permanent-staging-cold-quiesce-838e8c877dcafc0a822a12e5a26afa81c26924a3",
  legacyArtifactDigest:
    "sha256:3f830a7376e604a46e0d8cfe3521fc8eb4e1db444ab73bec4063c22442c42fbe",
  legacyEvidence: Object.freeze({
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
    cliExitCode: 1,
    timedOut: false,
    stdoutSha256:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    stderrSha256:
      "5df1ca8f5b08f53475635a850aaab5837e482d4096e9f6b319c4f962f4400930",
    normalizedErrorSha256:
      "5df1ca8f5b08f53475635a850aaab5837e482d4096e9f6b319c4f962f4400930",
    clapParseFailure: false,
    renderedErrorKind: "UnauthorizedToken",
    graphqlAuthorizationDenied: true,
    deniedResolver: null,
    resolverUnknown: true,
    environmentPatchCommitReached: null,
  }),
  sourceProof: Object.freeze({
    commandProducer: Object.freeze({
      repository: "blackmagic30/Beer",
      candidateSha: "1161e7ecd421556b104bcae059e8764ebf4a545e",
      path: "scripts/lib/permanent-staging-cold-recovery.ts",
      gitBlobSha: "e88780b8f83f87ee63f764ec5db7608d529e175f",
      sha256:
        "a7571fc741d3c422f3a7e33b626187ae3c794475adc8c4b2b5998d0405928860",
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
      regions: Object.freeze({
        path: "src/controllers/regions.rs",
        gitBlobSha: "2e21e12e3ce0fd1a71de4d33fa1f41952aa2e980",
        sha256:
          "6ed16ce3b48bc0f3e730efa569fd755061c9258e486cf4fd9e3626179b26dac7",
      }),
      client: Object.freeze({
        path: "src/client.rs",
        gitBlobSha: "bf93e00a5efb4a70c19c7ae74275e76c488d7199",
        sha256:
          "e3d9dcef12dc5c6108ecbfc6f11df6d7cdf803861f142aaceeadcd15f00ba5da",
      }),
      errors: Object.freeze({
        path: "src/errors.rs",
        gitBlobSha: "8ab2def1ffcfb082a811d0f7e23a4cb3a8414bed",
        sha256:
          "bc6ae769ac8816ea3aeaea8db83bd6f1dab30020a1cfb371a7416af54a5ed0b6",
      }),
      environmentPatchCommit: Object.freeze({
        path: "src/gql/mutations/strings/EnvironmentPatchCommit.graphql",
        gitBlobSha: "9c0883295e9f663e958f20a6bc3dbdce49c79ea8",
        sha256:
          "67a2b6e11d70170b1f797701ee47bc5a1678e55dd96e8927518296ee683d03a6",
      }),
    }),
  }),
} as const);

export const COLD_QUIESCE_SUCCESSOR_BRIDGE_SCHEMA =
  "pintpath-permanent-staging-cold-quiesce-successor-bridge/v3" as const;

const SHA = /^[a-f0-9]{40}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;

interface BridgeArguments {
  readonly candidateSha: string;
  readonly currentPrepareRunId: string;
  readonly priorCandidateSha: string;
  readonly priorQuiesceRunId: string;
  readonly legacyArtifactDirectory: string;
  readonly priorArtifactDirectory: string;
  readonly currentPrepareTerminalFile: string;
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
  readonly readProviderProof?: (
    fetchImpl: typeof fetch,
    token: string,
    input: Parameters<typeof readPermanentStagingColdProviderNoWriteProof>[2],
  ) => Promise<ColdProviderNoWriteProof>;
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
  if (argv.length !== 18) return null;
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
    "--legacy-artifact-dir",
    "--prior-artifact-dir",
    "--prepare-terminal-file",
    "--reviewed-authority-file",
    "--evidence-dir",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))) return null;
  const candidateSha = values.get("--candidate-sha") ?? "";
  const currentPrepareRunId = values.get("--prepare-run-id") ?? "";
  const priorCandidateSha = values.get("--prior-candidate-sha") ?? "";
  const priorQuiesceRunId = values.get("--prior-quiesce-run-id") ?? "";
  const legacyArtifactDirectory = values.get("--legacy-artifact-dir") ?? "";
  const priorArtifactDirectory = values.get("--prior-artifact-dir") ?? "";
  const currentPrepareTerminalFile = values.get("--prepare-terminal-file") ?? "";
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
    !path.isAbsolute(legacyArtifactDirectory) ||
    !path.isAbsolute(priorArtifactDirectory) ||
    !path.isAbsolute(currentPrepareTerminalFile) ||
    path.basename(currentPrepareTerminalFile) !== "cold-prepare-terminal.json" ||
    !path.isAbsolute(reviewedAuthorityFile) ||
    path.basename(reviewedAuthorityFile) !== "reviewed-authority.json" ||
    !path.isAbsolute(evidenceDirectory)
  ) return null;
  return {
    candidateSha,
    currentPrepareRunId,
    priorCandidateSha,
    priorQuiesceRunId,
    legacyArtifactDirectory,
    priorArtifactDirectory,
    currentPrepareTerminalFile,
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

function legacyArtifactExact(directory: string): Readonly<Record<string, string>> {
  const expected = COLD_QUIESCE_SUCCESSOR_BRIDGE;
  const receipt = readPinnedEvidence(directory, expected.legacyEvidence.receipt);
  const intent = readPinnedEvidence(directory, expected.legacyEvidence.intent);
  const prerequisites = readPinnedEvidence(
    directory,
    expected.legacyEvidence.prerequisites,
  );
  const priorAuthority = readPinnedEvidence(
    directory,
    expected.legacyEvidence.reviewedAuthority,
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
    receipt.value.candidateSha !== expected.legacyCandidateSha ||
    receipt.value.sourceSha !== COLD_RECOVERY_LOCK.sourceSha ||
    receipt.value.attempts !== 1 ||
    receipt.value.retryAllowed !== false ||
    receipt.value.intentSha256 !== expected.legacyEvidence.intent.sha256 ||
    receipt.value.normalOneToZeroReceiptClaimed !== false ||
    receipt.value.secretMaterialIncluded !== false ||
    receipt.value.secretDerivedCommitmentsIncluded !== false ||
    receiptPrepare?.runId !== expected.legacyPrepareRunId ||
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
    intent.value.candidateSha !== expected.legacyCandidateSha ||
    intent.value.prepareRunId !== expected.legacyPrepareRunId ||
    intent.value.maximumAttempts !== 1 ||
    intent.value.retryAllowed !== false ||
    intent.value.secretMaterialIncluded !== false ||
    intent.value.secretDerivedCommitmentsIncluded !== false ||
    prerequisites.value.schemaVersion !==
      "pintpath-permanent-staging-worker-bootstrap-prerequisites/v4" ||
    prerequisites.value.operation !== "cold-quiesce" ||
    prerequisites.value.candidateSha !== expected.legacyCandidateSha ||
    priorReviewedPullRequest?.number !== expected.legacyPullRequestNumber ||
    priorReviewedPullRequest?.reviewedHeadSha !== expected.legacyReviewedHeadSha ||
    priorReviewedPullRequest?.mergeCommitSha !== expected.legacyCandidateSha ||
    priorReviewedPullRequest?.treeSha !== expected.legacyTreeSha ||
    consumer?.runId !== expected.legacyQuiesceRunId ||
    selectedPrepare?.kind !== "cold-prepare" ||
    selectedPrepare?.runId !== expected.legacyPrepareRunId ||
    priorAuthority.value.command !==
      "verify-github-reviewed-candidate-authority" ||
    priorAuthority.value.ok !== true ||
    priorAuthority.value.candidateSha !== expected.legacyCandidateSha ||
    priorAuthority.value.operation !== "cold-recovery-quiesce" ||
    priorAuthority.value.workflowRunId !== expected.legacyQuiesceRunId ||
    priorAuthority.value.reviewedAuthorityExact !== true ||
    priorAuthority.value.freshDispatchWriteGuardExact !== true
  ) fail("artifact_contents_invalid");
  return Object.freeze({
    receiptSha256: expected.legacyEvidence.receipt.sha256,
    intentSha256: expected.legacyEvidence.intent.sha256,
    prerequisitesSha256: expected.legacyEvidence.prerequisites.sha256,
    priorReviewedAuthoritySha256:
      expected.legacyEvidence.reviewedAuthority.sha256,
  });
}

function priorArtifactExact(
  directory: string,
): Readonly<Record<string, string>> {
  const expected = COLD_QUIESCE_SUCCESSOR_BRIDGE;
  const receipt = readPinnedEvidence(
    directory,
    expected.priorEvidence.receipt,
  );
  const intent = readPinnedEvidence(
    directory,
    expected.priorEvidence.intent,
  );
  const bridge = readPinnedEvidence(
    directory,
    expected.priorEvidence.successorBridge,
  );
  const prerequisites = readPinnedEvidence(
    directory,
    expected.priorEvidence.prerequisites,
  );
  const authority = readPinnedEvidence(
    directory,
    expected.priorEvidence.reviewedAuthority,
  );
  const commandEvidence = record(receipt.value.commandEvidence)
    ? receipt.value.commandEvidence
    : null;
  const checks = record(receipt.value.checks) ? receipt.value.checks : null;
  const successorBridge = record(receipt.value.successorBridge)
    ? receipt.value.successorBridge
    : null;
  if (
    receipt.value.schemaVersion !==
      "pintpath-permanent-staging-cold-quiesce/v4" ||
    receipt.value.operation !== "cold-quiesce" ||
    receipt.value.outcome !== "mutation_uncertain" ||
    receipt.value.failureCode !== "reconciliation_failed" ||
    receipt.value.candidateSha !== expected.priorCandidateSha ||
    receipt.value.sourceSha !== COLD_RECOVERY_LOCK.sourceSha ||
    receipt.value.startedAt !== "2026-09-08T04:30:38.868Z" ||
    receipt.value.completedAt !== "2026-09-08T04:32:22.210Z" ||
    receipt.value.attempts !== 1 || receipt.value.retryAllowed !== false ||
    commandEvidence?.exitCode !== expected.priorCliFailure.cliExitCode ||
    commandEvidence?.timedOut !== false ||
    commandEvidence?.stdoutSha256 !== sha256("") ||
    commandEvidence?.stderrSha256 !== expected.priorCliFailure.stderrSha256 ||
    successorBridge?.bridgeSha256 !==
      expected.priorEvidence.successorBridge.sha256 ||
    successorBridge?.currentRunId !== expected.priorQuiesceRunId ||
    successorBridge?.currentPrepareRunId !==
      expected.priorPrepareRunId ||
    !checks || checks.policyExact !== true ||
    checks.githubAuthorityExact !== true ||
    checks.writeAttemptedAtMostOnce !== true ||
    checks.acknowledgementExact !== false ||
    checks.postflightAttempted !== true ||
    checks.exactZeroStateAfter !== false ||
    checks.boundaryPostflightExact !== true ||
    checks.terminalEvidenceExact !== true ||
    intent.value.schemaVersion !==
      "pintpath-permanent-staging-cold-quiesce-intent/v3" ||
    intent.value.candidateSha !== expected.priorCandidateSha ||
    intent.value.prepareRunId !== expected.priorPrepareRunId ||
    bridge.value.schemaVersion !==
      "pintpath-permanent-staging-cold-quiesce-successor-bridge/v2" ||
    bridge.value.candidateSha !== expected.priorCandidateSha ||
    bridge.value.currentRunId !== expected.priorQuiesceRunId ||
    prerequisites.value.schemaVersion !==
      "pintpath-permanent-staging-worker-bootstrap-prerequisites/v5" ||
    prerequisites.value.candidateSha !== expected.priorCandidateSha ||
    authority.value.command !== "verify-github-reviewed-candidate-authority" ||
    authority.value.ok !== true ||
    authority.value.candidateSha !== expected.priorCandidateSha ||
    authority.value.workflowRunId !== expected.priorQuiesceRunId ||
    receipt.value.secretMaterialIncluded !== false ||
    receipt.value.secretDerivedCommitmentsIncluded !== false
  ) fail("prior_artifact_invalid");
  return Object.freeze({
    receiptSha256: expected.priorEvidence.receipt.sha256,
    intentSha256: expected.priorEvidence.intent.sha256,
    successorBridgeSha256:
      expected.priorEvidence.successorBridge.sha256,
    prerequisitesSha256:
      expected.priorEvidence.prerequisites.sha256,
    reviewedAuthoritySha256:
      expected.priorEvidence.reviewedAuthority.sha256,
  });
}

function currentPrepareTerminalExact(
  filename: string,
  candidateSha: string,
  prepareRunId: string,
  authority: Record<string, unknown>,
): {
  readonly sha256: string;
  readonly replacementRunId: string;
  readonly startedAt: string;
  readonly completedAt: string;
} {
  let source: string;
  try {
    source = readPrivateEvidence(filename);
  } catch {
    fail("current_prepare_terminal_invalid");
  }
  const value = parseJson(source, "current_prepare_terminal_invalid");
  const replacement = record(value.replacementPrerequisite)
    ? value.replacementPrerequisite
    : null;
  const checks = record(value.checks) ? value.checks : null;
  if (
    canonical(value) !== source ||
    value.schemaVersion !== "pintpath-permanent-staging-cold-prepare/v2" ||
    value.operation !== "cold-prepare" || value.outcome !== "prepared_cold" ||
    value.failureCode !== null || value.candidateSha !== candidateSha ||
    value.sourceSha !== COLD_RECOVERY_LOCK.sourceSha ||
    value.attempts !== 1 || value.retryAllowed !== false ||
    typeof value.startedAt !== "string" ||
    new Date(Date.parse(value.startedAt)).toISOString() !== value.startedAt ||
    typeof value.completedAt !== "string" ||
    new Date(Date.parse(value.completedAt)).toISOString() !== value.completedAt ||
    Date.parse(value.startedAt) >= Date.parse(value.completedAt) ||
    replacement?.runId !== authority.selectedReplacementRunId ||
    !RUN_ID.test(String(replacement?.runId)) ||
    typeof replacement?.terminalSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(replacement.terminalSha256) ||
    authority.selectedColdPrepareRunId !== prepareRunId ||
    typeof authority.selectedColdPrepareRunStartedAt !== "string" ||
    typeof authority.selectedColdPrepareRunCompletedAt !== "string" ||
    Date.parse(String(authority.selectedColdPrepareRunStartedAt)) >
      Date.parse(value.startedAt) ||
    Date.parse(value.completedAt) >
      Date.parse(String(authority.selectedColdPrepareRunCompletedAt)) ||
    !checks || Object.values(checks).some((check) => check !== true) ||
    value.secretMaterialIncluded !== false ||
    value.secretDerivedCommitmentsIncluded !== false
  ) fail("current_prepare_terminal_invalid");
  return Object.freeze({
    sha256: sha256(source),
    replacementRunId: String(replacement.runId),
    startedAt: value.startedAt,
    completedAt: value.completedAt,
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
    !Object.hasOwn(
      value,
      "priorFailedReadOnlyColdQuiesceReconcileRunId",
    ) &&
    value.legacyColdRecoveryCandidateSha === expected.legacyCandidateSha &&
    value.legacyColdRecoveryReviewedHeadSha ===
      expected.legacyReviewedHeadSha &&
    value.legacyColdRecoveryTreeSha === expected.legacyTreeSha &&
    value.legacyColdRecoveryPullRequestNumber ===
      expected.legacyPullRequestNumber &&
    value.legacyColdRecoveryCandidateMergedAt === expected.legacyMergedAt &&
    value.legacyColdPrepareRunId === expected.legacyPrepareRunId &&
    value.legacyColdQuiesceRunId === expected.legacyQuiesceRunId &&
    value.legacyColdQuiesceRunCompletedAt ===
      expected.legacyQuiesceRunCompletedAt &&
    value.legacyFailedReadOnlyColdQuiesceReconcileRunId ===
      expected.legacyReadOnlyReconcileRunId &&
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
    typeof value.selectedColdPrepareRunStartedAt === "string" &&
    typeof value.selectedColdPrepareRunCompletedAt === "string" &&
    typeof value.selectedReplacementRunId === "string" &&
    typeof value.selectedReplacementRunStartedAt === "string" &&
    typeof value.selectedReplacementRunCompletedAt === "string" &&
    value.priorAmbiguousColdQuiesceArtifactId ===
      expected.priorArtifactId &&
    value.priorAmbiguousColdQuiesceArtifactName ===
      expected.priorArtifactName &&
    value.priorAmbiguousColdQuiesceArtifactDigest ===
      expected.priorArtifactDigest &&
    value.legacyAmbiguousColdQuiesceArtifactId === expected.legacyArtifactId &&
    value.legacyAmbiguousColdQuiesceArtifactName === expected.legacyArtifactName &&
    value.legacyAmbiguousColdQuiesceArtifactDigest ===
      expected.legacyArtifactDigest &&
    value.coldQuiesceSuccessorDirectParentExact === true &&
    value.coldQuiesceSuccessorLegacyToIntermediateParentExact === true &&
    value.coldQuiesceSuccessorIntermediateToPriorParentExact === true &&
    value.coldQuiesceSuccessorCompleteFourCandidateLineageExact === true &&
    value.coldQuiesceSuccessorLegacyHistoryExact === true &&
    value.coldQuiesceSuccessorIntermediateHistoryExact === true &&
    value.coldQuiesceSuccessorPriorHistoryExact === true &&
    value.coldQuiesceSuccessorAllRefsHistoryExact === true &&
    value.coldQuiesceSuccessorCurrentPrepareExact === true &&
    value.coldQuiesceSuccessorLegacyArtifactMetadataExact === true &&
    value.coldQuiesceSuccessorPriorArtifactMetadataExact === true &&
    value.coldQuiesceSuccessorPriorProviderProofRequired === true &&
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
    env.PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION !==
      COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION ||
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
  const reviewedAuthority = parseJson(
    reviewedAuthoritySource,
    "reviewed_authority_invalid",
  );
  const legacyEvidence = legacyArtifactExact(args.legacyArtifactDirectory);
  const priorEvidence = priorArtifactExact(
    args.priorArtifactDirectory,
  );
  const currentPrepare = currentPrepareTerminalExact(
    args.currentPrepareTerminalFile,
    args.candidateSha,
    args.currentPrepareRunId,
    reviewedAuthority,
  );

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

  const readProviderProof = dependencies.readProviderProof ??
    readPermanentStagingColdProviderNoWriteProof;
  let providerNoWriteProof: ColdProviderNoWriteProof;
  try {
    providerNoWriteProof = await readProviderProof(fetchImpl, tokens.metadata, {
      replacement: {
        runId: currentPrepare.replacementRunId,
        startedAt: String(reviewedAuthority.selectedReplacementRunStartedAt),
        completedAt: String(reviewedAuthority.selectedReplacementRunCompletedAt),
      },
      prepare: {
        runId: args.currentPrepareRunId,
        startedAt: String(reviewedAuthority.selectedColdPrepareRunStartedAt),
        completedAt: String(reviewedAuthority.selectedColdPrepareRunCompletedAt),
      },
      observedAt: verifiedAt.toISOString(),
      liveState: state,
    });
  } catch {
    fail("provider_history_invalid");
  }
  if (
    providerNoWriteProof.liveStateSha256 !== sha256(fullStateCanonical(state)) ||
    Object.values(providerNoWriteProof.checks).some((check) => check !== true) ||
    providerNoWriteProof.secretMaterialIncluded !== false ||
    providerNoWriteProof.secretDerivedCommitmentsIncluded !== false
  ) fail("provider_history_invalid");
  const recheckedState = await readState(fetchImpl, tokens.metadata, 1);
  if (
    recheckedState === null ||
    fullStateCanonical(recheckedState) !== fullStateCanonical(state)
  ) fail("provider_history_invalid");

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
    legacyCandidate: {
      candidateSha: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyCandidateSha,
      reviewedHeadSha: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyReviewedHeadSha,
      treeSha: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyTreeSha,
      pullRequestNumber: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyPullRequestNumber,
      mergedAt: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyMergedAt,
      prepareRunId: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyPrepareRunId,
      quiesceRunId: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyQuiesceRunId,
      quiesceRunCompletedAt:
        COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyQuiesceRunCompletedAt,
      failedReadOnlyReconcileRunId:
        COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyReadOnlyReconcileRunId,
    },
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
    legacyArtifact: {
      id: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyArtifactId,
      name: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyArtifactName,
      digest: COLD_QUIESCE_SUCCESSOR_BRIDGE.legacyArtifactDigest,
      ...legacyEvidence,
    },
    priorCliFailure: COLD_QUIESCE_SUCCESSOR_BRIDGE.priorCliFailure,
    providerWriteCommitted: false,
    providerNoWriteProof,
    mutationExclusivity: {
      externalMutationFreezeAttestation:
        COLD_RECOVERY_EXTERNAL_MUTATION_FREEZE_ATTESTATION,
      enforcement: "OPERATIONAL_NOT_PROVIDER_VERIFIED",
      concurrencyGroup: "pintpath-permanent-staging-key-rollout",
      cancelInProgress: false,
      bridgeTokenCustody: "METADATA_ONLY",
      mutationTokenPresent: false,
    },
    priorArtifact: {
      id: COLD_QUIESCE_SUCCESSOR_BRIDGE.priorArtifactId,
      name: COLD_QUIESCE_SUCCESSOR_BRIDGE.priorArtifactName,
      digest: COLD_QUIESCE_SUCCESSOR_BRIDGE.priorArtifactDigest,
      ...priorEvidence,
    },
    currentPrepare: {
      runId: args.currentPrepareRunId,
      terminalSha256: currentPrepare.sha256,
      replacementRunId: currentPrepare.replacementRunId,
      startedAt: currentPrepare.startedAt,
      completedAt: currentPrepare.completedAt,
    },
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
      legacyToIntermediateLineageExact: true,
      intermediateToPriorLineageExact: true,
      completeFourCandidateLineageExact: true,
      legacyColdHistoryExact: true,
      intermediateColdHistoryExact: true,
      priorColdHistoryExact: true,
      legacyArtifactMetadataExact: true,
      legacyArtifactContentsExact: true,
      priorArtifactMetadataExact: true,
      priorArtifactContentsExact: true,
      currentPrepareTerminalExact: true,
      sourceAnchorsExact: true,
      priorCliGraphqlAuthorizationFailureExact: true,
      providerHistoryCompleteExact: true,
      providerNoWriteExact: true,
      externalMutationFreezeAttested: true,
      serializedMutationConcurrencyExact: true,
      metadataOnlyTokenCustodyExact: true,
      readOnlyTokenScopeExact: true,
      configuredLiveTopologyExact: true,
      deploymentManifestIdentityExact: true,
      noProviderMutationPerformed: true,
    },
    nextRequiredProof: "FRESH_REVIEWED_SUCCESSOR_CONFIGURED_ONE_TO_ZERO",
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
  const receiptSource = canonical(receipt);
  if (parseColdQuiesceSuccessorBinding(
    receiptSource,
    reviewedAuthoritySource,
    args.candidateSha,
    currentRunId,
    args.currentPrepareRunId,
    verifiedAt.getTime(),
  ) === null) fail("provider_history_invalid");
  writeDurable(
    args.evidenceDirectory,
    "cold-quiesce-successor-bridge.json",
    receiptSource,
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
