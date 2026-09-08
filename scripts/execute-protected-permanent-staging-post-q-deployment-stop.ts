import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runRailwayMutationBoundaryCheck } from
  "./check-railway-mutation-boundary.js";
import {
  buildPostQDeploymentStopIntent,
  canonicalPostQEvidence,
  parsePostQAuthority,
  parsePostQDeploymentStopIntent,
  parseReviewedContainmentAuthority,
  POST_Q_DEPLOYMENT_STOP_APPLY_TERMINAL_SCHEMA,
  postQTokenScopeExact,
  POST_Q_DEPLOYMENT_STOP_EXECUTOR_SCHEMA,
  POST_Q_DEPLOYMENT_STOP_LOCK,
  POST_Q_DEPLOYMENT_STOP_OPERATION,
  POST_Q_DEPLOYMENT_STOP_Q_LEAVES,
  POST_Q_DEPLOYMENT_STOP_STATE_PROJECTION_SCHEMA,
  POST_Q_DEPLOYMENT_STOP_TERMINAL_SCHEMA,
  postQDeploymentStopInternals,
  postQSha256,
  probePostQRuntimeAbsence,
  providerLedgerBaselineExact,
  providerLedgerPostflightExact,
  readPostQDeploymentStopSnapshot,
  readPostQProviderLedger,
  readPostQTokenScope,
  reconcileStoppedDeployment,
  snapshotBaselineExact,
  snapshotEvidenceHashes,
  snapshotStateSha256,
  snapshotTopologySha256,
  stopPostQDeployment,
  validatePostQArtifactSources,
  type BoundaryEvidence,
  type PostQDeploymentStopSnapshot,
  type PostQDeploymentStopIntent,
  type PostQAuthorityEvidence,
  type ProviderLedger,
  type QArtifactEvidence,
  type ReviewedContainmentAuthorityEvidence,
  type RuntimeAbsenceEvidence,
  type StopAttempt,
} from "./lib/permanent-staging-post-q-deployment-stop.js";
import { parseStrictArguments } from "./lib/strict-arguments.js";
import {
  readTrustedRegularFile,
  writePrivateExclusiveFile,
} from "./lib/trusted-filesystem.js";

export const POST_Q_DEPLOYMENT_STOP_CONFIRMATION_PREFIX =
  "STOP_POST_Q_PERMANENT_STAGING_DEPLOYMENT_6300A324_9407_4B1C_B651_749C47E9537F_FOR_" as const;
export const POST_Q_DEPLOYMENT_STOP_FREEZE_ATTESTATION =
  "I_ATTEST_EXTERNAL_RAILWAY_MUTATIONS_ARE_FROZEN_FOR_THIS_RUN" as const;
export const POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_SCHEMA =
  "pintpath-permanent-staging-post-q-deployment-stop-apply-completion/v1" as const;
export const POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_LEAF =
  "stop-apply-terminal-completion.json" as const;
export const POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_SCHEMA =
  "pintpath-permanent-staging-post-q-deployment-stop-terminal-completion/v1" as const;
export const POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_LEAF =
  "stop-terminal-completion.json" as const;

const BOUNDARY_POLICY =
  "ops/railway/production-staging-mutation-policy.json";
const TOKEN_PATTERN = /^[^\r\n\0\s]{16,4096}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const MAX_EVIDENCE_BYTES = 1024 * 1024;

type Phase = "prepare" | "apply" | "finalize";
type FailureCode =
  | "arguments_invalid"
  | "github_context_invalid"
  | "confirmation_invalid"
  | "q_artifact_invalid"
  | "q_authority_invalid"
  | "reviewed_authority_invalid"
  | "authorization_expired"
  | "intent_invalid"
  | "token_configuration_invalid"
  | "token_scope_invalid"
  | "boundary_preflight_failed"
  | "target_preflight_failed"
  | "ledger_preflight_failed"
  | "prewrite_reassertion_failed"
  | "intent_write_failed"
  | "mutation_uncertain"
  | "reconciliation_failed"
  | "ledger_postflight_failed"
  | "boundary_postflight_failed"
  | "terminal_evidence_failed"
  | "unexpected_failure";

const FAILURE_CODES = new Set<FailureCode>([
  "arguments_invalid", "github_context_invalid", "confirmation_invalid",
  "q_artifact_invalid", "q_authority_invalid", "reviewed_authority_invalid",
  "authorization_expired", "intent_invalid", "token_configuration_invalid",
  "token_scope_invalid", "boundary_preflight_failed",
  "target_preflight_failed", "ledger_preflight_failed",
  "prewrite_reassertion_failed", "intent_write_failed", "mutation_uncertain",
  "reconciliation_failed", "ledger_postflight_failed",
  "boundary_postflight_failed", "terminal_evidence_failed",
  "unexpected_failure",
]);

const APPLY_PRE_ATTEMPT_FAILURE_CODES = new Set<FailureCode>([
  "boundary_preflight_failed", "token_configuration_invalid",
  "token_scope_invalid", "target_preflight_failed", "ledger_preflight_failed",
  "prewrite_reassertion_failed", "authorization_expired",
  "unexpected_failure",
]);

const APPLY_POST_ATTEMPT_FAILURE_CODES = new Set<FailureCode>([
  "mutation_uncertain", "reconciliation_failed", "ledger_postflight_failed",
]);

interface Arguments {
  readonly phase: Phase;
  readonly candidateSha: string;
  readonly qArtifactDir: string;
  readonly evidenceDir: string;
  readonly intentFile: string | null;
  readonly intentArtifactId: string | null;
  readonly intentArtifactDigest: string | null;
  readonly boundaryPreflightFile: string | null;
  readonly qAuthorityFile: string;
  readonly reviewedAuthorityFile: string;
  readonly boundaryPostflightFile: string | null;
  readonly applyTerminalFile: string | null;
  readonly intentArtifactMetadataFile: string | null;
}

interface Checks {
  argumentsExact: boolean;
  githubContextExact: boolean;
  confirmationExact: boolean;
  qArtifactExact: boolean;
  qAuthorityExact: boolean;
  reviewedAuthorityExact: boolean;
  authorizationDeadlineExact: boolean;
  intentArtifactExact: boolean;
  tokenConfigurationExact: boolean;
  tokenScopesExact: boolean;
  boundaryPreflightExact: boolean;
  targetPreflightExact: boolean;
  ledgerPreflightExact: boolean;
  durableIntentExact: boolean;
  boundaryPrewriteReasserted: boolean;
  targetPrewriteReasserted: boolean;
  ledgerPrewriteReasserted: boolean;
  writeAttemptedAtMostOnce: boolean;
  acknowledgementExact: boolean;
  mutationRequestExact: boolean;
  postflightAttempted: boolean;
  providerTerminalConvergenceExact: boolean;
  stableRuntimeAbsenceExact: boolean;
  topologyUnchanged: boolean;
  variablesUnchanged: boolean;
  sourceUnchanged: boolean;
  collateralUnchanged: boolean;
  ledgerPostflightExact: boolean;
  boundaryPostflightExact: boolean;
  terminalEvidenceExact: boolean;
}

export interface PostQDeploymentStopDependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly fetchImpl: typeof fetch;
  readonly repositoryExact: (candidateSha: string) => boolean;
  readonly confirmationExact: (
    candidateSha: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => boolean;
  readonly authorizationDeadlineExact: (
    authority: ReviewedContainmentAuthorityEvidence,
    nowMs: number,
  ) => boolean;
  readonly readQArtifact: (directory: string) => Readonly<Record<string, string>>;
  readonly validateQArtifact: typeof validatePostQArtifactSources;
  readonly parseQAuthority: typeof parsePostQAuthority;
  readonly parseReviewedAuthority: typeof parseReviewedContainmentAuthority;
  readonly parseIntent: typeof parsePostQDeploymentStopIntent;
  readonly snapshotBaselineExact: typeof snapshotBaselineExact;
  readonly ledgerBaselineExact: typeof providerLedgerBaselineExact;
  readonly reconcile: typeof reconcileStoppedDeployment;
  readonly snapshotCommitment: typeof snapshotCommitment;
  readonly ledgerCommitment: typeof ledgerCommitment;
  readonly readIntent: (filename: string) => string;
  readonly writeEvidence: (directory: string, leaf: string, source: string) => void;
  readonly boundaryCheck: () => Promise<BoundaryEvidence>;
  readonly readScope: (token: string) => Promise<unknown>;
  readonly readSnapshot: (token: string) => Promise<PostQDeploymentStopSnapshot | null>;
  readonly readLedger: (token: string) => Promise<ProviderLedger>;
  readonly stopDeployment: (token: string) => Promise<StopAttempt>;
  readonly probeRuntime: () => Promise<RuntimeAbsenceEvidence>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly monotonicNow: () => number;
  readonly now: () => number;
  readonly writeOutput: (source: string) => void;
}

function emptyChecks(): Checks {
  return {
    argumentsExact: false,
    githubContextExact: false,
    confirmationExact: false,
    qArtifactExact: false,
    qAuthorityExact: false,
    reviewedAuthorityExact: false,
    authorizationDeadlineExact: false,
    intentArtifactExact: false,
    tokenConfigurationExact: false,
    tokenScopesExact: false,
    boundaryPreflightExact: false,
    targetPreflightExact: false,
    ledgerPreflightExact: false,
    durableIntentExact: false,
    boundaryPrewriteReasserted: false,
    targetPrewriteReasserted: false,
    ledgerPrewriteReasserted: false,
    writeAttemptedAtMostOnce: true,
    acknowledgementExact: false,
    mutationRequestExact: false,
    postflightAttempted: false,
    providerTerminalConvergenceExact: false,
    stableRuntimeAbsenceExact: false,
    topologyUnchanged: false,
    variablesUnchanged: false,
    sourceUnchanged: false,
    collateralUnchanged: false,
    ledgerPostflightExact: false,
    boundaryPostflightExact: false,
    terminalEvidenceExact: false,
  };
}

function absolute(value: string): string | null {
  return path.isAbsolute(value) && path.resolve(value) === value &&
      path.normalize(value) === value && !value.includes("\0")
    ? value
    : null;
}

function parseArgs(argv: readonly string[]): Arguments | null {
  try {
    const base = new Set([
      "--phase", "--candidate-sha", "--q-artifact-dir", "--evidence-dir",
      "--intent-file", "--intent-artifact-id", "--intent-artifact-digest",
      "--boundary-preflight-file",
      "--q-authority-file", "--reviewed-authority-file",
      "--boundary-postflight-file", "--apply-terminal-file",
      "--intent-artifact-metadata-file",
    ]);
    const values = parseStrictArguments(argv, {
      allowed: base,
      required: new Set([
        "--phase", "--candidate-sha", "--q-artifact-dir", "--evidence-dir",
        "--q-authority-file", "--reviewed-authority-file",
      ]),
    });
    const phase = values.get("--phase");
    const candidateSha = values.get("--candidate-sha")!;
    const qArtifactDir = absolute(values.get("--q-artifact-dir")!);
    const evidenceDir = absolute(values.get("--evidence-dir")!);
    const qAuthorityFile = absolute(values.get("--q-authority-file")!);
    const reviewedAuthorityFile = absolute(
      values.get("--reviewed-authority-file")!,
    );
    const intentFileValue = values.get("--intent-file");
    const intentFile = intentFileValue === undefined ? null : absolute(intentFileValue);
    const intentArtifactId = values.get("--intent-artifact-id") ?? null;
    const intentArtifactDigest = values.get("--intent-artifact-digest") ?? null;
    const boundaryValue = values.get("--boundary-preflight-file");
    const boundaryPreflightFile = boundaryValue === undefined
      ? null
      : absolute(boundaryValue);
    const boundaryPostflightValue = values.get("--boundary-postflight-file");
    const boundaryPostflightFile = boundaryPostflightValue === undefined
      ? null
      : absolute(boundaryPostflightValue);
    const applyTerminalValue = values.get("--apply-terminal-file");
    const applyTerminalFile = applyTerminalValue === undefined
      ? null
      : absolute(applyTerminalValue);
    const intentMetadataValue = values.get("--intent-artifact-metadata-file");
    const intentArtifactMetadataFile = intentMetadataValue === undefined
      ? null
      : absolute(intentMetadataValue);
    const applyFields = intentFile !== null && intentArtifactId !== null &&
      intentArtifactDigest !== null && boundaryPreflightFile !== null &&
      intentArtifactMetadataFile !== null;
    const finalizeFields = applyFields && boundaryPostflightFile !== null &&
      applyTerminalFile !== null;
    if ((phase !== "prepare" && phase !== "apply" && phase !== "finalize") ||
      !SHA_PATTERN.test(candidateSha) || qArtifactDir === null ||
      evidenceDir === null || qAuthorityFile === null ||
      reviewedAuthorityFile === null || phase === "prepare" && (
        intentFileValue !== undefined || intentArtifactId !== null ||
        intentArtifactDigest !== null || boundaryValue !== undefined ||
        boundaryPostflightValue !== undefined || applyTerminalValue !== undefined ||
        intentMetadataValue !== undefined
      ) || phase === "apply" && (!applyFields ||
        boundaryPostflightValue !== undefined || applyTerminalValue !== undefined ||
        !RUN_ID_PATTERN.test(intentArtifactId!) ||
        !DIGEST_PATTERN.test(intentArtifactDigest!)) ||
      phase === "finalize" && (!finalizeFields ||
        !RUN_ID_PATTERN.test(intentArtifactId!) ||
        !DIGEST_PATTERN.test(intentArtifactDigest!))) return null;
    return {
      phase,
      candidateSha,
      qArtifactDir,
      evidenceDir,
      intentFile,
      intentArtifactId,
      intentArtifactDigest,
      boundaryPreflightFile,
      qAuthorityFile,
      reviewedAuthorityFile,
      boundaryPostflightFile,
      applyTerminalFile,
      intentArtifactMetadataFile,
    };
  } catch {
    return null;
  }
}

function githubContextExact(
  args: Arguments,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.GITHUB_ACTIONS === "true" &&
    env.GITHUB_REPOSITORY === POST_Q_DEPLOYMENT_STOP_LOCK.repository &&
    env.GITHUB_REF === POST_Q_DEPLOYMENT_STOP_LOCK.ref &&
    env.GITHUB_SHA === args.candidateSha &&
    env.GITHUB_RUN_ATTEMPT === "1" && RUN_ID_PATTERN.test(env.GITHUB_RUN_ID ?? "");
}

function confirmationExact(
  args: Pick<Arguments, "candidateSha">,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.PINTPATH_EXTERNAL_RAILWAY_MUTATION_FREEZE_ATTESTATION ===
      POST_Q_DEPLOYMENT_STOP_FREEZE_ATTESTATION &&
    env.PINTPATH_POST_Q_DEPLOYMENT_STOP_CONFIRMATION ===
      `${POST_Q_DEPLOYMENT_STOP_CONFIRMATION_PREFIX}${args.candidateSha}_FROM_Q_34229745722`;
}

function sameSnapshot(
  left: PostQDeploymentStopSnapshot,
  right: PostQDeploymentStopSnapshot,
): boolean {
  return canonicalPostQEvidence(left) === canonicalPostQEvidence(right);
}

function sameLedger(left: ProviderLedger, right: ProviderLedger): boolean {
  return canonicalPostQEvidence(left) === canonicalPostQEvidence(right);
}

function snapshotCommitment(snapshot: PostQDeploymentStopSnapshot | null) {
  if (snapshot === null) return null;
  const evidenceHashes = snapshotEvidenceHashes(snapshot);
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
    ...evidenceHashes,
  };
}

function ledgerCommitment(ledger: ProviderLedger | null) {
  return ledger === null ? null : {
    historyCount: ledger.historyRows.length,
    historyRowsSha256:
      postQSha256(canonicalPostQEvidence(ledger.historyRows)),
    patchCount: ledger.patchRows.length,
    patchRowsSha256: postQSha256(canonicalPostQEvidence(ledger.patchRows)),
  };
}

function railwayCredentialSetExact(
  env: Readonly<Record<string, string | undefined>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.entries(env).every(([name, value]) => {
    const credentialName = name.startsWith("PINTPATH_RAILWAY_") ||
      /(?:^|_)RAILWAY(?:_[A-Z0-9]+)*_TOKEN$/.test(name);
    return value === undefined || !credentialName || allowed.has(name);
  });
}

function exactRecord(value: unknown, keys: readonly string[]):
  value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function boundaryReceiptExact(source: string): boolean {
  try {
    const value = JSON.parse(source) as unknown;
    if (!exactRecord(value, [
      "schemaVersion", "policy", "mode", "outcome", "checks",
    ]) ||
      `${JSON.stringify(value)}\n` !== source) return false;
    const receipt = value;
    const checkKeys = [
      "policyValid", "queriesMetadataOnly", "productionTokenScopeExact",
      "stagingTokenScopeExact", "productionEnvironmentExact",
      "stagingEnvironmentExact", "productionPatchEmpty", "stagingPatchEmpty",
      "productionPostgresExact", "approvedDeploymentCurrent",
      "approvedDeploymentActive", "approvedDeploymentHealthy",
      "approvedSnapshotExact", "approvedImageDigestExact",
      "deploymentPatchAbsent", "deploymentRecordedSourceExact",
      "sourceImageExact", "autoUpdatesDisabledExact",
      "sourceReferenceImmutable",
    ] as const;
    const receiptChecks = receipt.checks;
    return receipt.schemaVersion ===
        "pintpath-railway-mutation-boundary-readiness/v1" &&
      receipt.policy === "pintpath-production-staging-mutation-boundary" &&
      receipt.mode === "read-only-boundary" && receipt.outcome === "passed" &&
      exactRecord(receiptChecks, checkKeys) &&
      checkKeys.every((key) => receiptChecks[key] === true);
  } catch {
    return false;
  }
}

function applyCompletionSource(input: {
  readonly candidateSha: string;
  readonly runId: string;
  readonly applyTerminalSource: string;
}): string {
  return canonicalPostQEvidence({
    schemaVersion: POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_SCHEMA,
    operation: POST_Q_DEPLOYMENT_STOP_OPERATION,
    candidateSha: input.candidateSha,
    runId: input.runId,
    applyTerminalSha256: postQSha256(input.applyTerminalSource),
    applyTerminalSizeBytes: Buffer.byteLength(input.applyTerminalSource),
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function applyCompletionExact(
  source: string,
  input: {
    readonly candidateSha: string;
    readonly runId: string;
    readonly applyTerminalSource: string;
  },
): boolean {
  try {
    const value = JSON.parse(source) as unknown;
    return exactRecord(value, [
      "schemaVersion", "operation", "candidateSha", "runId",
      "applyTerminalSha256", "applyTerminalSizeBytes",
      "secretMaterialIncluded", "secretDerivedCommitmentsIncluded",
    ]) && canonicalPostQEvidence(value) === source &&
      value.schemaVersion === POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_SCHEMA &&
      value.operation === POST_Q_DEPLOYMENT_STOP_OPERATION &&
      value.candidateSha === input.candidateSha && value.runId === input.runId &&
      value.applyTerminalSha256 === postQSha256(input.applyTerminalSource) &&
      value.applyTerminalSizeBytes === Buffer.byteLength(input.applyTerminalSource) &&
      value.secretMaterialIncluded === false &&
      value.secretDerivedCommitmentsIncluded === false;
  } catch {
    return false;
  }
}

function terminalCompletionSource(input: {
  readonly candidateSha: string;
  readonly runId: string;
  readonly terminalSource: string;
}): string {
  return canonicalPostQEvidence({
    schemaVersion: POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_SCHEMA,
    operation: POST_Q_DEPLOYMENT_STOP_OPERATION,
    candidateSha: input.candidateSha,
    runId: input.runId,
    terminalSha256: postQSha256(input.terminalSource),
    terminalSizeBytes: Buffer.byteLength(input.terminalSource),
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  });
}

function terminalCompletionExact(
  source: string,
  input: {
    readonly candidateSha: string;
    readonly runId: string;
    readonly terminalSource: string;
  },
): boolean {
  return source === terminalCompletionSource(input);
}

function evidencePath(directory: string, leaf: string): string {
  return path.join(directory, leaf);
}

function trustedReadbackExact(
  dependencies: PostQDeploymentStopDependencies,
  directory: string,
  leaf: string,
  expectedSource: string,
): boolean {
  try {
    return dependencies.readIntent(evidencePath(directory, leaf)) === expectedSource;
  } catch {
    return false;
  }
}

function intentArtifactMetadataExact(
  source: string,
  args: Arguments,
  intentSha256: string,
  runId: string,
): boolean {
  try {
    const value = JSON.parse(source) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
      `${JSON.stringify(value)}\n` !== source) return false;
    const metadata = value as Record<string, unknown>;
    const workflowRun = metadata.workflow_run;
    return metadata.id === Number(args.intentArtifactId) &&
      metadata.name ===
        `pintpath-permanent-staging-post-q-deployment-stop-intent-${args.candidateSha}-${runId}` &&
      metadata.expired === false && metadata.digest === args.intentArtifactDigest &&
      Number.isSafeInteger(metadata.size_in_bytes) &&
      (metadata.size_in_bytes as number) > 0 &&
      (metadata.size_in_bytes as number) <= 65_536 &&
      typeof workflowRun === "object" && workflowRun !== null &&
      !Array.isArray(workflowRun) &&
      (workflowRun as Record<string, unknown>).id ===
        Number(runId) &&
      (workflowRun as Record<string, unknown>).repository_id === 1215862300 &&
      (workflowRun as Record<string, unknown>).head_repository_id === 1215862300 &&
      (workflowRun as Record<string, unknown>).head_branch === "main" &&
      (workflowRun as Record<string, unknown>).head_sha === args.candidateSha &&
      SHA256_PATTERN.test(intentSha256);
  } catch {
    return false;
  }
}

function outputReceipt(input: {
  readonly args: Arguments | null;
  readonly outcome: "prepared" | "stopped" |
    "stopped_pending_boundary_postflight" |
    "failed_before_attempt" | "mutation_uncertain";
  readonly attempts: 0 | 1;
  readonly failureCode: FailureCode | null;
  readonly checks: Checks;
  readonly qArtifact: QArtifactEvidence | null;
  readonly intentSha256: string | null;
  readonly terminalSha256: string | null;
  readonly stopAttempt: StopAttempt | null;
  readonly stableObservations: number;
  readonly pollRounds: number;
  readonly stableSpanMs?: number;
}) {
  return {
    schemaVersion: POST_Q_DEPLOYMENT_STOP_EXECUTOR_SCHEMA,
    operation: POST_Q_DEPLOYMENT_STOP_OPERATION,
    phase: input.args?.phase ?? null,
    candidateSha: input.args?.candidateSha ?? null,
    outcome: input.outcome,
    attempts: input.attempts,
    retryAllowed: false,
    failureCode: input.failureCode,
    qRunId: input.qArtifact === null
      ? null
      : POST_Q_DEPLOYMENT_STOP_LOCK.q.runId,
    qArtifactId: input.qArtifact?.artifactId ?? null,
    qArtifactDigest: input.qArtifact?.artifactDigest ?? null,
    intentSha256: input.intentSha256,
    terminalSha256: input.terminalSha256,
    target: {
      environmentId: POST_Q_DEPLOYMENT_STOP_LOCK.environmentId,
      forbiddenProductionEnvironmentId:
        POST_Q_DEPLOYMENT_STOP_LOCK.forbiddenProductionEnvironmentId,
      serviceId: POST_Q_DEPLOYMENT_STOP_LOCK.serviceId,
      deploymentId: POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId,
    },
    stopAttempt: input.stopAttempt,
    reconciliation: {
      requiredStableObservations:
        POST_Q_DEPLOYMENT_STOP_LOCK.stableObservationCount,
      stableObservations: input.stableObservations,
      pollRounds: input.pollRounds,
      stableSpanMs: input.stableSpanMs ?? 0,
    },
    checks: input.checks,
    nextRequiredProof: input.outcome === "stopped"
      ? "EXACT_SUPPORTED_US_WEST_ONE_TO_ASIA_ONE_TOPOLOGY_REPAIR_WHILE_STOPPED"
      : null,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
}

async function prepare(
  dependencies: PostQDeploymentStopDependencies,
  args: Arguments,
  checks: Checks,
  qArtifact: QArtifactEvidence,
  qAuthority: PostQAuthorityEvidence,
  reviewedAuthority: ReviewedContainmentAuthorityEvidence,
): Promise<0 | 1> {
  let failureCode: FailureCode | null = null;
  let intentSha256: string | null = null;
  try {
    const metadataToken = dependencies.env.PINTPATH_RAILWAY_STAGING_METADATA_TOKEN;
    const productionToken = dependencies.env.PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN;
    checks.tokenConfigurationExact = TOKEN_PATTERN.test(metadataToken ?? "") &&
      TOKEN_PATTERN.test(productionToken ?? "") && metadataToken !== productionToken &&
      railwayCredentialSetExact(dependencies.env, new Set([
        "PINTPATH_RAILWAY_STAGING_METADATA_TOKEN",
        "PINTPATH_RAILWAY_PRODUCTION_METADATA_TOKEN",
      ]));
    if (!checks.tokenConfigurationExact) throw new Error("token_configuration_invalid");
    const scope = await dependencies.readScope(metadataToken!);
    checks.tokenScopesExact = postQTokenScopeExact(scope);
    if (!checks.tokenScopesExact) throw new Error("token_scope_invalid");
    const boundary = await dependencies.boundaryCheck();
    checks.boundaryPreflightExact = boundary.passed &&
      boundary.receiptSha256 !== null && SHA256_PATTERN.test(boundary.receiptSha256);
    if (!checks.boundaryPreflightExact) throw new Error("boundary_preflight_failed");
    const [snapshot, ledger] = await Promise.all([
      dependencies.readSnapshot(metadataToken!),
      dependencies.readLedger(metadataToken!),
    ]);
    checks.targetPreflightExact = snapshot !== null &&
      dependencies.snapshotBaselineExact(snapshot);
    checks.ledgerPreflightExact = dependencies.ledgerBaselineExact(ledger);
    if (!checks.targetPreflightExact || snapshot === null) {
      throw new Error("target_preflight_failed");
    }
    if (!checks.ledgerPreflightExact) throw new Error("ledger_preflight_failed");
    const [reassertedSnapshot, reassertedLedger] = await Promise.all([
      dependencies.readSnapshot(metadataToken!),
      dependencies.readLedger(metadataToken!),
    ]);
    checks.targetPrewriteReasserted = reassertedSnapshot !== null &&
      sameSnapshot(snapshot, reassertedSnapshot);
    checks.ledgerPrewriteReasserted = sameLedger(ledger, reassertedLedger);
    checks.boundaryPrewriteReasserted = (await dependencies.boundaryCheck()).passed;
    if (!checks.targetPrewriteReasserted || !checks.ledgerPrewriteReasserted ||
      !checks.boundaryPrewriteReasserted) {
      throw new Error("prewrite_reassertion_failed");
    }
    const intent = buildPostQDeploymentStopIntent({
      candidateSha: args.candidateSha,
      runId: dependencies.env.GITHUB_RUN_ID!,
      qArtifact,
      qAuthority,
      reviewedAuthority,
      boundaryReceiptSha256: boundary.receiptSha256!,
    });
    if (intent === null) throw new Error("intent_write_failed");
    const source = canonicalPostQEvidence(intent);
    dependencies.writeEvidence(args.evidenceDir, "stop-intent.json", source);
    intentSha256 = postQSha256(source);
    checks.durableIntentExact = true;
  } catch (error) {
    failureCode = error instanceof Error && [
      "token_configuration_invalid", "token_scope_invalid",
      "boundary_preflight_failed", "target_preflight_failed",
      "ledger_preflight_failed", "prewrite_reassertion_failed",
      "intent_write_failed",
    ].includes(error.message)
      ? error.message as FailureCode
      : "unexpected_failure";
  }
  dependencies.writeOutput(`${JSON.stringify(outputReceipt({
    args,
    outcome: failureCode === null ? "prepared" : "failed_before_attempt",
    attempts: 0,
    failureCode,
    checks,
    qArtifact,
    intentSha256,
    terminalSha256: null,
    stopAttempt: null,
    stableObservations: 0,
    pollRounds: 0,
  }))}\n`);
  return failureCode === null ? 0 : 1;
}

async function apply(
  dependencies: PostQDeploymentStopDependencies,
  args: Arguments,
  checks: Checks,
  qArtifact: QArtifactEvidence,
  qAuthority: PostQAuthorityEvidence,
  reviewedAuthority: ReviewedContainmentAuthorityEvidence,
): Promise<0 | 1> {
  let failureCode: FailureCode | null = null;
  let attempts: 0 | 1 = 0;
  let intentSha256: string | null = null;
  let terminalSha256: string | null = null;
  let stopAttempt: StopAttempt | null = null;
  let stableObservations = 0;
  let pollRounds = 0;
  let stableSpanMs = 0;
  let before: PostQDeploymentStopSnapshot | null = null;
  let ledgerBefore: ProviderLedger | null = null;
  let requestStartedAt: string | null = null;
  let requestCompletedAt: string | null = null;
  let boundaryPreflightSha256: string | null = null;
  let intentMetadataSha256: string | null = null;
  let reconciliation: Awaited<ReturnType<typeof reconcileStoppedDeployment>> |
    null = null;
  try {
    const intentSource = dependencies.readIntent(args.intentFile!);
    intentSha256 = postQSha256(intentSource);
    const intent = dependencies.parseIntent(intentSource, {
      candidateSha: args.candidateSha,
      runId: dependencies.env.GITHUB_RUN_ID!,
    });
    const intentMetadataSource = dependencies.readIntent(
      args.intentArtifactMetadataFile!,
    );
    intentMetadataSha256 = postQSha256(intentMetadataSource);
    checks.intentArtifactExact = intent !== null &&
      RUN_ID_PATTERN.test(args.intentArtifactId!) &&
      DIGEST_PATTERN.test(args.intentArtifactDigest!) &&
      intent.expectedArtifactName ===
        `pintpath-permanent-staging-post-q-deployment-stop-intent-${args.candidateSha}-${dependencies.env.GITHUB_RUN_ID}` &&
      canonicalPostQEvidence(intent.qAuthority) ===
        canonicalPostQEvidence(qAuthority) &&
      canonicalPostQEvidence(intent.reviewedAuthority) ===
        canonicalPostQEvidence(reviewedAuthority) &&
      intentArtifactMetadataExact(
        intentMetadataSource,
        args,
        intentSha256,
        dependencies.env.GITHUB_RUN_ID!,
      );
    if (!checks.intentArtifactExact) throw new Error("intent_invalid");
    if (intent === null) throw new Error("intent_invalid");
    checks.durableIntentExact = true;
    const boundarySource = dependencies.readIntent(args.boundaryPreflightFile!);
    boundaryPreflightSha256 = postQSha256(boundarySource);
    checks.boundaryPreflightExact = boundaryReceiptExact(boundarySource) &&
      boundaryPreflightSha256 === intent.boundaryPreflightReceiptSha256;
    checks.boundaryPrewriteReasserted = checks.boundaryPreflightExact;
    if (!checks.boundaryPreflightExact) throw new Error("boundary_preflight_failed");
    const writeToken = dependencies.env.PINTPATH_RAILWAY_STAGING_SCALE_TOKEN ?? "";
    checks.tokenConfigurationExact = TOKEN_PATTERN.test(writeToken) &&
      railwayCredentialSetExact(dependencies.env, new Set([
        "PINTPATH_RAILWAY_STAGING_SCALE_TOKEN",
      ]));
    if (!checks.tokenConfigurationExact) throw new Error("token_configuration_invalid");
    const writeScope = await dependencies.readScope(writeToken);
    checks.tokenScopesExact = postQTokenScopeExact(writeScope);
    if (!checks.tokenScopesExact) throw new Error("token_scope_invalid");
    before = await dependencies.readSnapshot(writeToken);
    ledgerBefore = await dependencies.readLedger(writeToken);
    checks.targetPreflightExact = before !== null &&
      dependencies.snapshotBaselineExact(before);
    checks.ledgerPreflightExact = dependencies.ledgerBaselineExact(ledgerBefore);
    if (!checks.targetPreflightExact || before === null) {
      throw new Error("target_preflight_failed");
    }
    if (!checks.ledgerPreflightExact) throw new Error("ledger_preflight_failed");
    const immediateSnapshot = await dependencies.readSnapshot(writeToken);
    const immediateLedger = await dependencies.readLedger(writeToken);
    checks.targetPrewriteReasserted = immediateSnapshot !== null &&
      sameSnapshot(before, immediateSnapshot);
    checks.ledgerPrewriteReasserted = sameLedger(ledgerBefore, immediateLedger);
    if (!checks.targetPrewriteReasserted || !checks.ledgerPrewriteReasserted ||
      !checks.boundaryPrewriteReasserted) {
      throw new Error("prewrite_reassertion_failed");
    }
    const requestStartedMs = dependencies.now();
    checks.authorizationDeadlineExact = dependencies.authorizationDeadlineExact(
      reviewedAuthority,
      requestStartedMs,
    );
    if (!checks.authorizationDeadlineExact) throw new Error("authorization_expired");
    requestStartedAt = new Date(requestStartedMs).toISOString();
    attempts = 1;
    try {
      stopAttempt = await dependencies.stopDeployment(writeToken);
    } catch {
      stopAttempt = {
        outcome: "transport_uncertain",
        acknowledgementExact: false,
        querySha256: intent.mutation.querySha256,
        variablesSha256: intent.mutation.variablesSha256,
        requestBodySha256: intent.mutation.requestBodySha256,
        responseBodySha256: null,
        acknowledgementSha256: null,
      };
    }
    const requestCompletedMs = dependencies.now();
    requestCompletedAt = Number.isFinite(requestCompletedMs) &&
        requestCompletedMs >= requestStartedMs
      ? new Date(requestCompletedMs).toISOString()
      : null;
    checks.acknowledgementExact = stopAttempt.acknowledgementExact;
    checks.mutationRequestExact = stopAttempt.querySha256 ===
        intent.mutation.querySha256 &&
      stopAttempt.variablesSha256 === intent.mutation.variablesSha256 &&
      stopAttempt.requestBodySha256 === intent.mutation.requestBodySha256;
    checks.postflightAttempted = true;
    reconciliation = await dependencies.reconcile({
      before,
      beforeLedger: ledgerBefore,
      requestStartedAt,
      readSnapshot: () => dependencies.readSnapshot(writeToken),
      readLedger: () => dependencies.readLedger(writeToken),
      probeRuntime: dependencies.probeRuntime,
      sleep: dependencies.sleep,
      monotonicNow: dependencies.monotonicNow,
      wallNow: dependencies.now,
    });
    stableObservations = reconciliation.stableObservations;
    pollRounds = reconciliation.rounds;
    stableSpanMs = reconciliation.stableSpanMs;
    checks.providerTerminalConvergenceExact = reconciliation.exact;
    checks.stableRuntimeAbsenceExact = reconciliation.exact &&
      reconciliation.runtime?.absent === true;
    if (reconciliation.snapshot !== null) {
      const beforeCollateral = postQDeploymentStopInternals.snapshotCollateral(before);
      const afterCollateral = postQDeploymentStopInternals.snapshotCollateral(
        reconciliation.snapshot,
      );
      const unchanged = canonicalPostQEvidence(beforeCollateral) ===
        canonicalPostQEvidence(afterCollateral);
      checks.topologyUnchanged = unchanged;
      checks.variablesUnchanged = unchanged;
      checks.sourceUnchanged = unchanged;
      checks.collateralUnchanged = unchanged;
    }
    checks.ledgerPostflightExact = reconciliation.exact &&
      reconciliation.ledgerEvidence?.exact === true &&
      reconciliation.observations.length ===
        POST_Q_DEPLOYMENT_STOP_LOCK.stableObservationCount;
    if (!checks.acknowledgementExact || !checks.mutationRequestExact) {
      failureCode = "mutation_uncertain";
    }
    else if (!checks.providerTerminalConvergenceExact ||
      !checks.stableRuntimeAbsenceExact || !checks.topologyUnchanged ||
      !checks.variablesUnchanged || !checks.sourceUnchanged ||
      !checks.collateralUnchanged) failureCode = "reconciliation_failed";
    else if (!checks.ledgerPostflightExact) failureCode = "ledger_postflight_failed";
  } catch (error) {
    failureCode = attempts === 1
      ? "mutation_uncertain"
      : error instanceof Error && [
        "intent_invalid", "token_configuration_invalid", "token_scope_invalid",
        "boundary_preflight_failed", "target_preflight_failed",
        "ledger_preflight_failed", "prewrite_reassertion_failed",
        "authorization_expired",
      ].includes(error.message)
        ? error.message as FailureCode
        : "unexpected_failure";
  }

  const outcome = attempts === 1
    ? failureCode === null
      ? "stopped_pending_boundary_postflight" as const
      : "mutation_uncertain" as const
    : "failed_before_attempt" as const;
  const receipt = outputReceipt({
    args,
    outcome,
    attempts,
    failureCode,
    checks,
    qArtifact,
    intentSha256,
    terminalSha256: null,
    stopAttempt,
    stableObservations,
    pollRounds,
    stableSpanMs,
  });
  const terminal = {
    schemaVersion: POST_Q_DEPLOYMENT_STOP_APPLY_TERMINAL_SCHEMA,
    operation: POST_Q_DEPLOYMENT_STOP_OPERATION,
    phase: "apply",
    candidateSha: args.candidateSha,
    runId: dependencies.env.GITHUB_RUN_ID,
    outcome,
    failureCode,
    attempts,
    retryAllowed: false,
    receipt,
    intentArtifact: {
      id: args.intentArtifactId,
      name:
        `pintpath-permanent-staging-post-q-deployment-stop-intent-${args.candidateSha}-${dependencies.env.GITHUB_RUN_ID}`,
      digest: args.intentArtifactDigest,
      sha256: intentSha256,
      metadataSha256: intentMetadataSha256,
    },
    qArtifact,
    qAuthority,
    reviewedAuthority,
    boundaryPreflightSha256,
    requestWindow: {
      startedAt: requestStartedAt,
      completedAt: requestCompletedAt,
    },
    stopRequest: stopAttempt,
    providerEvidence: {
      beforeSnapshot: dependencies.snapshotCommitment(before),
      beforeLedger: dependencies.ledgerCommitment(ledgerBefore),
      terminalSnapshot:
        dependencies.snapshotCommitment(reconciliation?.snapshot ?? null),
      terminalLedger: dependencies.ledgerCommitment(reconciliation?.ledger ?? null),
      terminalLedgerEvidence: reconciliation?.ledgerEvidence ?? null,
      observations: reconciliation?.observations ?? [],
      stableObservationCount: stableObservations,
      stableObservationSpanMs: stableSpanMs,
      totalObservationSpanMs: reconciliation?.totalObservationSpanMs ?? 0,
      pollRounds,
      runtime: reconciliation?.runtime ?? null,
    },
    coldQuiesceSatisfied: false,
    authorizesDownstream: false,
    authorizedSuccessors: ["post-Q-topology-repair-only"],
    nextRequiredProof: null,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
  try {
    checks.terminalEvidenceExact = true;
    const source = canonicalPostQEvidence(terminal);
    let terminalWriteReturned = false;
    try {
      dependencies.writeEvidence(args.evidenceDir, "stop-apply-terminal.json", source);
      terminalWriteReturned = true;
    } catch {
      terminalWriteReturned = false;
    }
    if (!terminalWriteReturned || !trustedReadbackExact(
      dependencies,
      args.evidenceDir,
      "stop-apply-terminal.json",
      source,
    )) throw new Error("apply_terminal_write_unverified");
    terminalSha256 = postQSha256(source);
    if (outcome === "stopped_pending_boundary_postflight") {
      const completionSource = applyCompletionSource({
        candidateSha: args.candidateSha,
        runId: dependencies.env.GITHUB_RUN_ID!,
        applyTerminalSource: source,
      });
      try {
        dependencies.writeEvidence(
          args.evidenceDir,
          POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_LEAF,
          completionSource,
        );
      } catch {
        if (!trustedReadbackExact(
          dependencies,
          args.evidenceDir,
          POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_LEAF,
          completionSource,
        )) throw new Error("apply_completion_write_unverified");
      }
      if (!trustedReadbackExact(
        dependencies,
        args.evidenceDir,
        POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_LEAF,
        completionSource,
      )) throw new Error("apply_completion_write_unverified");
    }
  } catch {
    checks.terminalEvidenceExact = false;
    terminalSha256 = null;
    failureCode = attempts === 1 ? "mutation_uncertain" : "terminal_evidence_failed";
  }
  const emittedOutcome = failureCode === null
    ? outcome
    : attempts === 1 ? "mutation_uncertain" as const : "failed_before_attempt" as const;
  dependencies.writeOutput(`${JSON.stringify(outputReceipt({
    args,
    outcome: emittedOutcome,
    attempts,
    failureCode,
    checks,
    qArtifact,
    intentSha256,
    terminalSha256,
    stopAttempt,
    stableObservations,
    pollRounds,
    stableSpanMs,
  }))}\n`);
  return failureCode === null ? 0 : 1;
}

const SNAPSHOT_COMMITMENT_KEYS = Object.freeze([
  "stateProjectionSchema", "stateSha256", "topologySha256",
  "configuredRegions", "deploymentRegions", "source", "deployment",
  "latestDeployment", "activeDeployments", "domains", "variableRows",
  "variableInventorySha256", "collateralVariablesSha256",
  "offTargetVariablesSha256", "environmentConfigSha256",
  "stagedPatchSha256", "sourceIdentitySha256",
] as const);

function snapshotCommitmentExact(value: unknown, stopped: boolean): boolean {
  const expectedRegions = [{
    region: POST_Q_DEPLOYMENT_STOP_LOCK.configuredRegion,
    numReplicas: 1,
  }];
  const expectedSource = { repo: null, image: null };
  const expectedDeployment = {
    id: POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId,
    projectId: POST_Q_DEPLOYMENT_STOP_LOCK.projectId,
    environmentId: POST_Q_DEPLOYMENT_STOP_LOCK.environmentId,
    serviceId: POST_Q_DEPLOYMENT_STOP_LOCK.serviceId,
    snapshotId: POST_Q_DEPLOYMENT_STOP_LOCK.snapshotId,
    commitHash: POST_Q_DEPLOYMENT_STOP_LOCK.sourceSha,
    imageDigest: POST_Q_DEPLOYMENT_STOP_LOCK.imageDigest,
    patchId: null,
  };
  const expectedDomains = [{
    kind: "service",
    id: POST_Q_DEPLOYMENT_STOP_LOCK.domainId,
    domain: POST_Q_DEPLOYMENT_STOP_LOCK.domain,
    targetPort: POST_Q_DEPLOYMENT_STOP_LOCK.targetPort,
  }];
  const expectedActiveDeployments = stopped ? [] : [{
    id: POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId,
    status: "SUCCESS",
    deploymentStopped: false,
  }];
  if (!exactRecord(value, SNAPSHOT_COMMITMENT_KEYS) ||
    value.stateProjectionSchema !== POST_Q_DEPLOYMENT_STOP_STATE_PROJECTION_SCHEMA ||
    !SHA256_PATTERN.test(String(value.stateSha256)) ||
    value.topologySha256 !== POST_Q_DEPLOYMENT_STOP_LOCK.baseline.topologySha256 ||
    value.topologySha256 !== postQSha256(canonicalPostQEvidence({
      configuredReplicas: 1,
      configuredRegions: value.configuredRegions,
      deploymentRegions: value.deploymentRegions,
      legacyReplicas: null,
    })) ||
    value.variableInventorySha256 !==
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.variableInventorySha256 ||
    value.collateralVariablesSha256 !==
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.collateralVariablesSha256 ||
    value.offTargetVariablesSha256 !==
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.offTargetVariablesSha256 ||
    value.environmentConfigSha256 !==
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.environmentConfigSha256 ||
    value.stagedPatchSha256 !==
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.stagedPatchSha256 ||
    value.sourceIdentitySha256 !==
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.sourceIdentitySha256 ||
    value.sourceIdentitySha256 !== postQSha256(canonicalPostQEvidence({
      source: value.source,
      deployment: value.deployment,
    })) ||
    value.variableRows !== POST_Q_DEPLOYMENT_STOP_LOCK.baseline.variableRows ||
    canonicalPostQEvidence(value.configuredRegions) !==
      canonicalPostQEvidence(expectedRegions) ||
    canonicalPostQEvidence(value.deploymentRegions) !==
      canonicalPostQEvidence(expectedRegions) ||
    canonicalPostQEvidence(value.source) !== canonicalPostQEvidence(expectedSource) ||
    canonicalPostQEvidence(value.deployment) !==
      canonicalPostQEvidence(expectedDeployment) ||
    canonicalPostQEvidence(value.domains) !== canonicalPostQEvidence(expectedDomains) ||
    canonicalPostQEvidence(value.activeDeployments) !==
      canonicalPostQEvidence(expectedActiveDeployments) ||
    !exactRecord(value.latestDeployment, [
      "id", "status", "deploymentStopped", "snapshotId",
    ]) || value.latestDeployment.id !== POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId ||
    value.latestDeployment.status !== "SUCCESS" ||
    value.latestDeployment.snapshotId !== POST_Q_DEPLOYMENT_STOP_LOCK.snapshotId ||
    value.latestDeployment.deploymentStopped !== stopped ||
    !Array.isArray(value.activeDeployments) ||
    value.activeDeployments.length !== (stopped ? 0 : 1) ||
    !exactRecord(value.deployment, [
      "id", "projectId", "environmentId", "serviceId", "snapshotId",
      "commitHash", "imageDigest", "patchId",
    ]) || value.deployment.id !== POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId ||
    value.deployment.environmentId !== POST_Q_DEPLOYMENT_STOP_LOCK.environmentId ||
    value.deployment.serviceId !== POST_Q_DEPLOYMENT_STOP_LOCK.serviceId ||
    value.deployment.commitHash !== POST_Q_DEPLOYMENT_STOP_LOCK.sourceSha ||
    value.deployment.imageDigest !== POST_Q_DEPLOYMENT_STOP_LOCK.imageDigest ||
    value.deployment.patchId !== null) return false;
  return value.stateSha256 === (stopped
    ? POST_Q_DEPLOYMENT_STOP_LOCK.baseline.stoppedStateSha256
    : POST_Q_DEPLOYMENT_STOP_LOCK.baseline.stateSha256);
}

function snapshotCommitmentCollateral(value: Record<string, unknown>): unknown {
  const {
    stateSha256: _stateSha256,
    latestDeployment: _latestDeployment,
    activeDeployments: _activeDeployments,
    ...collateral
  } = value;
  return collateral;
}

const RUNTIME_ROUTES = ["/health", "/startup", "/ready"] as const;
type RuntimeRoute = typeof RUNTIME_ROUTES[number];
type RuntimeRequestRecord = Record<RuntimeRoute, Record<string, unknown>>;

interface ProviderObservationEvidence {
  readonly observedAt: string;
  readonly monotonicMs: number;
  readonly snapshotSha256: string;
  readonly topologySha256: string;
  readonly historyRowsSha256: string;
  readonly patchRowsSha256: string;
  readonly runtimeResponseSha256s: Record<RuntimeRoute, string | null>;
  readonly runtimeRequests: RuntimeRequestRecord;
}

function runtimeRequestSetStructuralExact(value: unknown):
  value is RuntimeRequestRecord {
  if (!exactRecord(value, RUNTIME_ROUTES)) return false;
  for (const route of RUNTIME_ROUTES) {
    const request = value[route];
    if (!exactRecord(request, [
      "requestUrlSha256", "statusCode", "responseBodySha256",
    ]) || !SHA256_PATTERN.test(String(request.requestUrlSha256)) ||
      !(request.statusCode === null || typeof request.statusCode === "number" &&
        Number.isInteger(request.statusCode) && request.statusCode >= 100 &&
        request.statusCode <= 599) ||
      !(request.responseBodySha256 === null ||
        SHA256_PATTERN.test(String(request.responseBodySha256)))) return false;
  }
  return true;
}

function runtimeEvidenceStructuralExact(value: unknown): value is {
  absent: boolean;
  responseSha256s: Record<RuntimeRoute, string | null>;
  requests: RuntimeRequestRecord;
} {
  if (!exactRecord(value, ["absent", "responseSha256s", "requests"]) ||
    typeof value.absent !== "boolean" ||
    !exactRecord(value.responseSha256s, RUNTIME_ROUTES) ||
    !runtimeRequestSetStructuralExact(value.requests)) return false;
  const statuses: Array<number | null> = [];
  for (const route of RUNTIME_ROUTES) {
    const responseSha = value.responseSha256s[route];
    const request = value.requests[route];
    if (!(responseSha === null || SHA256_PATTERN.test(String(responseSha))) ||
      request.responseBodySha256 !== responseSha ||
      (request.statusCode === null) !== (responseSha === null)) return false;
    statuses.push(request.statusCode as number | null);
  }
  const absentFromStatuses = statuses.every((status) =>
    typeof status === "number" && (status < 200 || status >= 300));
  return value.absent === absentFromStatuses;
}

function providerObservationStructuralExact(
  value: unknown,
): value is ProviderObservationEvidence {
  if (!exactRecord(value, [
    "observedAt", "monotonicMs", "snapshotSha256", "topologySha256",
    "historyRowsSha256", "patchRowsSha256", "runtimeResponseSha256s",
    "runtimeRequests",
  ]) || typeof value.observedAt !== "string" ||
    !Number.isFinite(Date.parse(value.observedAt)) ||
    typeof value.monotonicMs !== "number" || !Number.isFinite(value.monotonicMs) ||
    value.monotonicMs < 0 || !SHA256_PATTERN.test(String(value.snapshotSha256)) ||
    !SHA256_PATTERN.test(String(value.topologySha256)) ||
    !SHA256_PATTERN.test(String(value.historyRowsSha256)) ||
    !SHA256_PATTERN.test(String(value.patchRowsSha256)) ||
    !exactRecord(value.runtimeResponseSha256s, RUNTIME_ROUTES) ||
    !runtimeRequestSetStructuralExact(value.runtimeRequests)) return false;
  const runtimeResponseSha256s = value.runtimeResponseSha256s as Record<
    typeof RUNTIME_ROUTES[number], string | null
  >;
  const runtimeRequests = value.runtimeRequests as Record<
    typeof RUNTIME_ROUTES[number], Record<string, unknown>
  >;
  return RUNTIME_ROUTES.every((route) => {
    const responseSha = runtimeResponseSha256s[route];
    return (responseSha === null || SHA256_PATTERN.test(String(responseSha))) &&
      runtimeRequests[route].responseBodySha256 === responseSha &&
      (runtimeRequests[route].statusCode === null) === (responseSha === null);
  });
}

type ProviderEvidenceSummary = Record<string, unknown> & {
  readonly stableObservationCount: number;
  readonly stableObservationSpanMs: number;
  readonly totalObservationSpanMs: number;
  readonly pollRounds: number;
  readonly observations: readonly ProviderObservationEvidence[];
};

function successfulProviderEvidenceExact(
  value: unknown,
  requestStartedAt: string,
  requestCompletedAt: string,
): value is ProviderEvidenceSummary {
  if (!exactRecord(value, [
    "beforeSnapshot", "beforeLedger", "terminalSnapshot", "terminalLedger",
    "terminalLedgerEvidence", "observations", "stableObservationCount",
    "stableObservationSpanMs", "totalObservationSpanMs", "pollRounds", "runtime",
  ]) || !snapshotCommitmentExact(value.beforeSnapshot, false) ||
    !snapshotCommitmentExact(value.terminalSnapshot, true) ||
    canonicalPostQEvidence(snapshotCommitmentCollateral(
      value.beforeSnapshot as Record<string, unknown>,
    )) !== canonicalPostQEvidence(snapshotCommitmentCollateral(
      value.terminalSnapshot as Record<string, unknown>,
    )) ||
    !exactRecord(value.beforeLedger, [
      "historyCount", "historyRowsSha256", "patchCount", "patchRowsSha256",
    ]) || !exactRecord(value.terminalLedger, [
      "historyCount", "historyRowsSha256", "patchCount", "patchRowsSha256",
    ]) || value.beforeLedger.historyCount !==
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.historyCount ||
    value.beforeLedger.historyRowsSha256 !==
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.historyRowsSha256 ||
    value.beforeLedger.patchCount !== POST_Q_DEPLOYMENT_STOP_LOCK.baseline.patchCount ||
    value.beforeLedger.patchRowsSha256 !==
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.patchRowsSha256 ||
    canonicalPostQEvidence(value.terminalLedger) !==
      canonicalPostQEvidence(value.beforeLedger) ||
    !exactRecord(value.terminalLedgerEvidence, [
      "exact", "mode", "historyRowsSha256", "patchRowsSha256",
      "addedHistoryRowSha256", "addedHistoryRowCount",
      "addedHistoryRowPosition",
    ]) || value.terminalLedgerEvidence.exact !== true ||
    value.terminalLedgerEvidence.mode !== "unchanged" ||
    value.terminalLedgerEvidence.addedHistoryRowSha256 !== null ||
    value.terminalLedgerEvidence.addedHistoryRowCount !== 0 ||
    value.terminalLedgerEvidence.addedHistoryRowPosition !== null ||
    value.terminalLedgerEvidence.historyRowsSha256 !==
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.historyRowsSha256 ||
    value.terminalLedgerEvidence.patchRowsSha256 !==
      POST_Q_DEPLOYMENT_STOP_LOCK.baseline.patchRowsSha256 ||
    value.stableObservationCount !== 3 ||
    typeof value.stableObservationSpanMs !== "number" ||
    value.stableObservationSpanMs < 20_000 ||
    typeof value.totalObservationSpanMs !== "number" ||
    value.totalObservationSpanMs < value.stableObservationSpanMs ||
    value.totalObservationSpanMs > 300_000 ||
    typeof value.pollRounds !== "number" || value.pollRounds < 3 ||
    value.pollRounds > POST_Q_DEPLOYMENT_STOP_LOCK.maximumPollRounds ||
    !Array.isArray(value.observations) || value.observations.length !== 3 ||
    !runtimeEvidenceStructuralExact(value.runtime) ||
    value.runtime.absent !== true) return false;
  const seenRequestHashes = new Set<string>();
  const terminalSnapshot = value.terminalSnapshot as Record<string, unknown>;
  let firstMonotonic: number | null = null;
  let previousMonotonic: number | null = null;
  let previousWall: number | null = null;
  let stableRuntime: string | null = null;
  let lastObservation: {
    runtimeResponseSha256s: Record<
      typeof RUNTIME_ROUTES[number], string | null
    >;
    runtimeRequests: Record<
      typeof RUNTIME_ROUTES[number], Record<string, unknown>
    >;
  } | null = null;
  for (const observation of value.observations) {
    if (!providerObservationStructuralExact(observation) ||
      observation.snapshotSha256 !== terminalSnapshot.stateSha256 ||
      observation.topologySha256 !==
        POST_Q_DEPLOYMENT_STOP_LOCK.baseline.topologySha256 ||
      observation.historyRowsSha256 !==
        POST_Q_DEPLOYMENT_STOP_LOCK.baseline.historyRowsSha256 ||
      observation.patchRowsSha256 !==
        POST_Q_DEPLOYMENT_STOP_LOCK.baseline.patchRowsSha256) return false;
    const wall = Date.parse(observation.observedAt);
    if (wall < Date.parse(requestStartedAt) || previousWall !== null &&
      wall < previousWall || previousMonotonic !== null &&
      observation.monotonicMs - previousMonotonic < 10_000) return false;
    firstMonotonic ??= observation.monotonicMs;
    previousMonotonic = observation.monotonicMs;
    previousWall = wall;
    const runtimeRequests = observation.runtimeRequests;
    for (const route of RUNTIME_ROUTES) {
      const request = runtimeRequests[route];
      if (seenRequestHashes.has(String(request.requestUrlSha256)) ||
        !(typeof request.statusCode === "number" &&
          Number.isInteger(request.statusCode) &&
          (request.statusCode < 200 || request.statusCode >= 300)) ||
        request.responseBodySha256 !== observation.runtimeResponseSha256s[route]) {
        return false;
      }
      seenRequestHashes.add(String(request.requestUrlSha256));
    }
    const runtimeProjection = canonicalPostQEvidence({
      statuses: Object.fromEntries(RUNTIME_ROUTES.map((route) => [
        route,
        runtimeRequests[route].statusCode,
      ])),
    });
    stableRuntime ??= runtimeProjection;
    if (runtimeProjection !== stableRuntime) return false;
    lastObservation = observation;
  }
  if (Date.parse((value.observations[0] as Record<string, unknown>).observedAt as
      string) < Date.parse(requestCompletedAt) ||
    firstMonotonic === null || previousMonotonic === null ||
    previousMonotonic - firstMonotonic !== value.stableObservationSpanMs ||
    seenRequestHashes.size !== 9 || lastObservation === null) return false;
  return canonicalPostQEvidence(value.runtime) === canonicalPostQEvidence({
    absent: true,
    responseSha256s: lastObservation.runtimeResponseSha256s,
    requests: lastObservation.runtimeRequests,
  });
}

function failureProviderEvidenceStructuralExact(
  value: unknown,
): value is ProviderEvidenceSummary {
  if (!exactRecord(value, [
    "beforeSnapshot", "beforeLedger", "terminalSnapshot", "terminalLedger",
    "terminalLedgerEvidence", "observations", "stableObservationCount",
    "stableObservationSpanMs", "totalObservationSpanMs", "pollRounds", "runtime",
  ]) || !Number.isInteger(value.stableObservationCount) ||
    (value.stableObservationCount as number) < 0 ||
    (value.stableObservationCount as number) > 3 ||
    typeof value.stableObservationSpanMs !== "number" ||
    value.stableObservationSpanMs < 0 || value.stableObservationSpanMs > 300_000 ||
    typeof value.totalObservationSpanMs !== "number" ||
    value.totalObservationSpanMs < 0 || value.totalObservationSpanMs > 300_000 ||
    value.totalObservationSpanMs < value.stableObservationSpanMs ||
    !Number.isInteger(value.pollRounds) || (value.pollRounds as number) < 0 ||
    (value.pollRounds as number) > POST_Q_DEPLOYMENT_STOP_LOCK.maximumPollRounds ||
    !Array.isArray(value.observations) || value.observations.length > 3 ||
    value.observations.length !== value.stableObservationCount) return false;
  let previousMonotonic: number | null = null;
  let previousWall: number | null = null;
  for (const observation of value.observations) {
    if (!providerObservationStructuralExact(observation)) return false;
    const wall = Date.parse(observation.observedAt);
    if (previousMonotonic !== null &&
        observation.monotonicMs < previousMonotonic ||
      previousWall !== null && wall < previousWall) return false;
    previousMonotonic = observation.monotonicMs;
    previousWall = wall;
  }
  if (value.observations.length === 0 && value.stableObservationSpanMs !== 0 ||
    value.observations.length > 0 && (
      value.observations.at(-1)!.monotonicMs -
        value.observations[0]!.monotonicMs !== value.stableObservationSpanMs
    )) return false;
  for (const commitment of [value.beforeSnapshot, value.terminalSnapshot]) {
    if (commitment !== null && !snapshotCommitmentExact(commitment, false) &&
      !snapshotCommitmentExact(commitment, true)) return false;
  }
  for (const commitment of [value.beforeLedger, value.terminalLedger]) {
    if (commitment !== null && (!exactRecord(commitment, [
      "historyCount", "historyRowsSha256", "patchCount", "patchRowsSha256",
    ]) || !Number.isInteger(commitment.historyCount) ||
      !Number.isInteger(commitment.patchCount) ||
      !SHA256_PATTERN.test(String(commitment.historyRowsSha256)) ||
      !SHA256_PATTERN.test(String(commitment.patchRowsSha256)))) return false;
  }
  if (value.terminalLedgerEvidence !== null &&
    (!exactRecord(value.terminalLedgerEvidence, [
      "exact", "mode", "historyRowsSha256", "patchRowsSha256",
      "addedHistoryRowSha256", "addedHistoryRowCount",
      "addedHistoryRowPosition",
    ]) || typeof value.terminalLedgerEvidence.exact !== "boolean" ||
      !["unchanged", "invalid"].includes(String(value.terminalLedgerEvidence.mode)) ||
      !SHA256_PATTERN.test(String(value.terminalLedgerEvidence.historyRowsSha256)) ||
      !SHA256_PATTERN.test(String(value.terminalLedgerEvidence.patchRowsSha256)) ||
      !(value.terminalLedgerEvidence.addedHistoryRowSha256 === null ||
        SHA256_PATTERN.test(String(
          value.terminalLedgerEvidence.addedHistoryRowSha256,
        ))) || !Number.isInteger(
        value.terminalLedgerEvidence.addedHistoryRowCount,
      ) || (value.terminalLedgerEvidence.addedHistoryRowCount as number) < 0 ||
      (value.terminalLedgerEvidence.addedHistoryRowCount as number) > 100 ||
      !(value.terminalLedgerEvidence.addedHistoryRowPosition === null ||
        value.terminalLedgerEvidence.addedHistoryRowPosition === "newest-prefix"))) {
    return false;
  }
  if (value.terminalLedgerEvidence !== null) {
    if (!exactRecord(value.terminalLedger, [
      "historyCount", "historyRowsSha256", "patchCount", "patchRowsSha256",
    ]) || value.terminalLedger.historyRowsSha256 !==
        value.terminalLedgerEvidence.historyRowsSha256 ||
      value.terminalLedger.patchRowsSha256 !==
        value.terminalLedgerEvidence.patchRowsSha256) return false;
    const count = value.terminalLedgerEvidence.addedHistoryRowCount as number;
    const digest = value.terminalLedgerEvidence.addedHistoryRowSha256;
    const position = value.terminalLedgerEvidence.addedHistoryRowPosition;
    const unchanged = value.terminalLedgerEvidence.mode === "unchanged";
    if (value.terminalLedgerEvidence.exact !== unchanged ||
      unchanged && (
        value.terminalLedgerEvidence.historyRowsSha256 !==
          POST_Q_DEPLOYMENT_STOP_LOCK.baseline.historyRowsSha256 ||
        value.terminalLedgerEvidence.patchRowsSha256 !==
          POST_Q_DEPLOYMENT_STOP_LOCK.baseline.patchRowsSha256 ||
        count !== 0
      ) || count === 0 && (digest !== null || position !== null) ||
      count === 1 && (!SHA256_PATTERN.test(String(digest)) ||
        position !== "newest-prefix") ||
      count > 1 && (digest !== null || position !== "newest-prefix")) return false;
  } else if (value.terminalLedger !== null) return false;
  if (value.runtime !== null && !runtimeEvidenceStructuralExact(value.runtime)) {
    return false;
  }
  if (value.observations.length > 0) {
    const last = value.observations.at(-1)!;
    if (value.runtime === null || canonicalPostQEvidence(value.runtime) !==
      canonicalPostQEvidence({
        absent: RUNTIME_ROUTES.every((route) => {
          const status = last.runtimeRequests[route].statusCode;
          return typeof status === "number" &&
            (status < 200 || status >= 300);
        }),
        responseSha256s: last.runtimeResponseSha256s,
        requests: last.runtimeRequests,
      })) return false;
  }
  return true;
}

function stopAttemptExact(
  value: unknown,
  intent: PostQDeploymentStopIntent,
): value is Record<string, unknown> {
  if (!exactRecord(value, [
    "outcome", "acknowledgementExact", "querySha256", "variablesSha256",
    "requestBodySha256", "responseBodySha256", "acknowledgementSha256",
  ]) || value.querySha256 !== intent.mutation.querySha256 ||
    value.variablesSha256 !== intent.mutation.variablesSha256 ||
    value.requestBodySha256 !== intent.mutation.requestBodySha256 ||
    !(value.responseBodySha256 === null ||
      SHA256_PATTERN.test(String(value.responseBodySha256)))) return false;
  const acknowledgementSha256 = postQSha256(canonicalPostQEvidence({
    deploymentStop: true,
  }));
  return value.outcome === "acknowledged"
    ? value.acknowledgementExact === true &&
      typeof value.responseBodySha256 === "string" &&
      value.acknowledgementSha256 === acknowledgementSha256
    : value.outcome === "transport_uncertain" &&
      value.acknowledgementExact === false &&
      value.acknowledgementSha256 === null;
}

function validatedInnerCommonChecksExact(checks: Record<string, unknown>): boolean {
  return [
    "argumentsExact", "githubContextExact", "confirmationExact",
    "qArtifactExact", "qAuthorityExact", "reviewedAuthorityExact",
    "intentArtifactExact", "durableIntentExact", "writeAttemptedAtMostOnce",
    "terminalEvidenceExact",
  ].every((key) => checks[key] === true);
}

function applyTerminalExact(
  source: string,
  expected: {
    readonly args: Arguments;
    readonly runId: string;
    readonly intentSha256: string;
    readonly intentMetadataSha256: string;
    readonly boundaryPreflightSha256: string;
    readonly qArtifact: QArtifactEvidence;
    readonly qAuthority: PostQAuthorityEvidence;
    readonly reviewedAuthority: ReviewedContainmentAuthorityEvidence;
    readonly intent: PostQDeploymentStopIntent;
  },
): Record<string, unknown> | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!exactRecord(value, [
      "schemaVersion", "operation", "phase", "candidateSha", "runId",
      "outcome", "failureCode", "attempts", "retryAllowed", "receipt",
      "intentArtifact", "qArtifact", "qAuthority", "reviewedAuthority",
      "boundaryPreflightSha256", "requestWindow", "stopRequest",
      "providerEvidence", "coldQuiesceSatisfied", "authorizesDownstream",
      "authorizedSuccessors", "nextRequiredProof", "secretMaterialIncluded",
      "secretDerivedCommitmentsIncluded",
    ]) || canonicalPostQEvidence(value) !== source ||
      value.schemaVersion !== POST_Q_DEPLOYMENT_STOP_APPLY_TERMINAL_SCHEMA ||
      value.operation !== POST_Q_DEPLOYMENT_STOP_OPERATION ||
      value.phase !== "apply" || value.candidateSha !== expected.args.candidateSha ||
      value.runId !== expected.runId || value.retryAllowed !== false ||
      value.coldQuiesceSatisfied !== false || value.authorizesDownstream !== false ||
      canonicalPostQEvidence(value.authorizedSuccessors) !==
        canonicalPostQEvidence(["post-Q-topology-repair-only"]) ||
      value.nextRequiredProof !== null || value.secretMaterialIncluded !== false ||
      value.secretDerivedCommitmentsIncluded !== false ||
      !exactRecord(value.intentArtifact, [
        "id", "name", "digest", "sha256", "metadataSha256",
      ]) || value.intentArtifact.id !== expected.args.intentArtifactId ||
      value.intentArtifact.name !==
        `pintpath-permanent-staging-post-q-deployment-stop-intent-${expected.args.candidateSha}-${expected.runId}` ||
      value.intentArtifact.digest !== expected.args.intentArtifactDigest ||
      value.intentArtifact.sha256 !== expected.intentSha256 ||
      value.intentArtifact.metadataSha256 !== expected.intentMetadataSha256 ||
      value.boundaryPreflightSha256 !== expected.boundaryPreflightSha256 ||
      canonicalPostQEvidence(value.qArtifact) !==
        canonicalPostQEvidence(expected.qArtifact) ||
      canonicalPostQEvidence(value.qAuthority) !==
        canonicalPostQEvidence(expected.qAuthority) ||
      canonicalPostQEvidence(value.reviewedAuthority) !==
        canonicalPostQEvidence(expected.reviewedAuthority) ||
      !exactRecord(value.receipt, Object.keys(outputReceipt({
        args: expected.args,
        outcome: "failed_before_attempt",
        attempts: 0,
        failureCode: "unexpected_failure",
        checks: emptyChecks(),
        qArtifact: expected.qArtifact,
        intentSha256: expected.intentSha256,
        terminalSha256: null,
        stopAttempt: null,
        stableObservations: 0,
        pollRounds: 0,
      })))) return null;
    if (!exactRecord(value.receipt.checks, Object.keys(emptyChecks())) ||
      !Object.values(value.receipt.checks).every((check) =>
        typeof check === "boolean") ||
      value.receipt.schemaVersion !== POST_Q_DEPLOYMENT_STOP_EXECUTOR_SCHEMA ||
      value.receipt.operation !== POST_Q_DEPLOYMENT_STOP_OPERATION ||
      value.receipt.phase !== "apply" ||
      value.receipt.candidateSha !== expected.args.candidateSha ||
      value.receipt.outcome !== value.outcome ||
      value.receipt.attempts !== value.attempts ||
      value.receipt.failureCode !== value.failureCode ||
      value.receipt.retryAllowed !== false || value.receipt.terminalSha256 !== null ||
      value.receipt.intentSha256 !== expected.intentSha256 ||
      value.receipt.qRunId !== POST_Q_DEPLOYMENT_STOP_LOCK.q.runId ||
      value.receipt.qArtifactId !== POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactId ||
      value.receipt.qArtifactDigest !==
        POST_Q_DEPLOYMENT_STOP_LOCK.q.artifactDigest ||
      value.receipt.nextRequiredProof !== null ||
      value.receipt.secretMaterialIncluded !== false ||
      value.receipt.secretDerivedCommitmentsIncluded !== false ||
      !exactRecord(value.receipt.target, [
        "environmentId", "forbiddenProductionEnvironmentId", "serviceId",
        "deploymentId",
      ]) || value.receipt.target.environmentId !==
        POST_Q_DEPLOYMENT_STOP_LOCK.environmentId ||
      value.receipt.target.forbiddenProductionEnvironmentId !==
        POST_Q_DEPLOYMENT_STOP_LOCK.forbiddenProductionEnvironmentId ||
      value.receipt.target.serviceId !== POST_Q_DEPLOYMENT_STOP_LOCK.serviceId ||
      value.receipt.target.deploymentId !==
        POST_Q_DEPLOYMENT_STOP_LOCK.deploymentId ||
      !exactRecord(value.receipt.reconciliation, [
        "requiredStableObservations", "stableObservations", "pollRounds",
        "stableSpanMs",
      ]) || value.receipt.reconciliation.requiredStableObservations !== 3 ||
      !exactRecord(value.requestWindow, ["startedAt", "completedAt"]) ||
      canonicalPostQEvidence(value.receipt.stopAttempt) !==
        canonicalPostQEvidence(value.stopRequest)) return null;
    const receiptChecks = value.receipt.checks;
    if (value.outcome !== "stopped_pending_boundary_postflight") {
      if (typeof value.failureCode !== "string" ||
        !failureProviderEvidenceStructuralExact(value.providerEvidence)) return null;
      const providerEvidence = value.providerEvidence;
      if (value.receipt.reconciliation.stableObservations !==
          providerEvidence.stableObservationCount ||
        value.receipt.reconciliation.pollRounds !== providerEvidence.pollRounds ||
        value.receipt.reconciliation.stableSpanMs !==
          providerEvidence.stableObservationSpanMs ||
        !validatedInnerCommonChecksExact(receiptChecks)) return null;
      if (value.outcome === "failed_before_attempt") {
        const failureCode = value.failureCode as FailureCode;
        if (!APPLY_PRE_ATTEMPT_FAILURE_CODES.has(failureCode) ||
          value.attempts !== 0 || value.stopRequest !== null ||
          value.requestWindow.startedAt !== null ||
          value.requestWindow.completedAt !== null ||
          providerEvidence.stableObservationCount !== 0 ||
          providerEvidence.stableObservationSpanMs !== 0 ||
          providerEvidence.totalObservationSpanMs !== 0 ||
          providerEvidence.pollRounds !== 0 ||
          providerEvidence.observations.length !== 0 ||
          providerEvidence.terminalSnapshot !== null ||
          providerEvidence.terminalLedger !== null ||
          providerEvidence.terminalLedgerEvidence !== null ||
          providerEvidence.runtime !== null ||
          [
            "acknowledgementExact", "mutationRequestExact", "postflightAttempted",
            "providerTerminalConvergenceExact", "stableRuntimeAbsenceExact",
            "topologyUnchanged", "variablesUnchanged", "sourceUnchanged",
            "collateralUnchanged", "ledgerPostflightExact",
            "boundaryPostflightExact",
          ].some((key) => receiptChecks[key] !== false)) return null;
        if (failureCode === "authorization_expired") {
          if (receiptChecks.authorizationDeadlineExact !== false) return null;
        } else if (receiptChecks.authorizationDeadlineExact !== true) return null;
        if (failureCode === "boundary_preflight_failed" &&
          receiptChecks.boundaryPreflightExact !== false ||
          failureCode === "token_configuration_invalid" &&
          receiptChecks.tokenConfigurationExact !== false ||
          failureCode === "token_scope_invalid" &&
          receiptChecks.tokenScopesExact !== false ||
          failureCode === "target_preflight_failed" &&
          receiptChecks.targetPreflightExact !== false ||
          failureCode === "ledger_preflight_failed" &&
          receiptChecks.ledgerPreflightExact !== false ||
          failureCode === "prewrite_reassertion_failed" &&
          receiptChecks.boundaryPrewriteReasserted === true &&
          receiptChecks.targetPrewriteReasserted === true &&
          receiptChecks.ledgerPrewriteReasserted === true) return null;
        return value;
      }
      const failureCode = value.failureCode as FailureCode;
      if (value.outcome !== "mutation_uncertain" || value.attempts !== 1 ||
        !APPLY_POST_ATTEMPT_FAILURE_CODES.has(failureCode) ||
        typeof value.requestWindow.startedAt !== "string" ||
        !Number.isFinite(Date.parse(value.requestWindow.startedAt)) ||
        Date.parse(value.requestWindow.startedAt) >=
          Date.parse(expected.reviewedAuthority.authorizationDeadline) ||
        !(value.requestWindow.completedAt === null ||
          typeof value.requestWindow.completedAt === "string" &&
          Number.isFinite(Date.parse(value.requestWindow.completedAt)) &&
          Date.parse(value.requestWindow.completedAt) >=
            Date.parse(value.requestWindow.startedAt)) ||
        !stopAttemptExact(value.stopRequest, expected.intent) ||
        receiptChecks.authorizationDeadlineExact !== true ||
        receiptChecks.tokenConfigurationExact !== true ||
        receiptChecks.tokenScopesExact !== true ||
        receiptChecks.boundaryPreflightExact !== true ||
        receiptChecks.boundaryPrewriteReasserted !== true ||
        receiptChecks.targetPreflightExact !== true ||
        receiptChecks.ledgerPreflightExact !== true ||
        receiptChecks.targetPrewriteReasserted !== true ||
        receiptChecks.ledgerPrewriteReasserted !== true ||
        receiptChecks.mutationRequestExact !== true ||
        receiptChecks.acknowledgementExact !==
          value.stopRequest.acknowledgementExact ||
        receiptChecks.postflightAttempted !== true ||
        receiptChecks.boundaryPostflightExact !== false) return null;
      if (providerEvidence.observations.length > 0) {
        if (typeof value.requestWindow.completedAt !== "string" ||
          Date.parse(providerEvidence.observations[0]!.observedAt) <
            Date.parse(value.requestWindow.completedAt)) return null;
      }
      if (failureCode === "reconciliation_failed" &&
        (receiptChecks.acknowledgementExact !== true ||
          [
            "providerTerminalConvergenceExact", "stableRuntimeAbsenceExact",
            "topologyUnchanged", "variablesUnchanged", "sourceUnchanged",
            "collateralUnchanged",
          ].every((key) => receiptChecks[key] === true)) ||
        failureCode === "ledger_postflight_failed" &&
        (receiptChecks.acknowledgementExact !== true ||
          [
            "providerTerminalConvergenceExact", "stableRuntimeAbsenceExact",
            "topologyUnchanged", "variablesUnchanged", "sourceUnchanged",
            "collateralUnchanged",
          ].some((key) => receiptChecks[key] !== true) ||
          receiptChecks.ledgerPostflightExact !== false)) return null;
      return value;
    }
    if (value.failureCode !== null || value.attempts !== 1 ||
      !exactRecord(value.requestWindow, ["startedAt", "completedAt"]) ||
      typeof value.requestWindow.startedAt !== "string" ||
      typeof value.requestWindow.completedAt !== "string" ||
      !Number.isFinite(Date.parse(value.requestWindow.startedAt)) ||
      !Number.isFinite(Date.parse(value.requestWindow.completedAt)) ||
      Date.parse(value.requestWindow.startedAt) >=
        Date.parse(expected.reviewedAuthority.authorizationDeadline) ||
      Date.parse(value.requestWindow.completedAt) <
        Date.parse(value.requestWindow.startedAt) ||
      !stopAttemptExact(value.stopRequest, expected.intent) ||
      value.stopRequest.outcome !== "acknowledged" ||
      value.receipt.outcome !== value.outcome ||
      value.receipt.attempts !== value.attempts ||
      canonicalPostQEvidence(value.receipt.stopAttempt) !==
        canonicalPostQEvidence(value.stopRequest) ||
      !successfulProviderEvidenceExact(
        value.providerEvidence,
        value.requestWindow.startedAt,
        value.requestWindow.completedAt,
      ) ||
      !exactRecord(value.receipt.checks, Object.keys(emptyChecks()))) {
      return null;
    }
    const providerEvidence = value.providerEvidence;
    if (!successfulProviderEvidenceExact(
      providerEvidence,
      value.requestWindow.startedAt,
      value.requestWindow.completedAt,
    ) || value.receipt.reconciliation.stableObservations !==
        providerEvidence.stableObservationCount ||
      value.receipt.reconciliation.pollRounds !== providerEvidence.pollRounds ||
      value.receipt.reconciliation.stableSpanMs !==
        providerEvidence.stableObservationSpanMs) return null;
    const checks = value.receipt.checks;
    if (checks.boundaryPostflightExact !== false) return null;
    for (const key of [
      "argumentsExact", "githubContextExact", "confirmationExact",
      "qArtifactExact", "qAuthorityExact", "reviewedAuthorityExact",
      "authorizationDeadlineExact",
      "intentArtifactExact", "tokenConfigurationExact", "tokenScopesExact",
      "durableIntentExact",
      "boundaryPreflightExact", "targetPreflightExact", "ledgerPreflightExact",
      "boundaryPrewriteReasserted", "targetPrewriteReasserted",
      "ledgerPrewriteReasserted", "writeAttemptedAtMostOnce",
      "acknowledgementExact", "mutationRequestExact", "postflightAttempted",
      "providerTerminalConvergenceExact", "stableRuntimeAbsenceExact",
      "topologyUnchanged", "variablesUnchanged", "sourceUnchanged",
      "collateralUnchanged", "ledgerPostflightExact", "terminalEvidenceExact",
    ]) if (checks[key] !== true) return null;
    return value;
  } catch {
    return null;
  }
}

async function finalize(
  dependencies: PostQDeploymentStopDependencies,
  args: Arguments,
  checks: Checks,
  qArtifact: QArtifactEvidence,
  qAuthority: PostQAuthorityEvidence,
  reviewedAuthority: ReviewedContainmentAuthorityEvidence,
): Promise<0 | 1> {
  let failureCode: FailureCode | null = null;
  let intentSha256: string | null = null;
  let innerSource: string | null = null;
  let inner: Record<string, unknown> | null = null;
  let boundaryPreflightSource: string | null = null;
  let boundaryPostflightSource: string | null = null;
  let intentMetadataSource: string | null = null;
  let completionSource: string | null = null;
  let completionExact = false;
  const noProviderCredentials = railwayCredentialSetExact(
    dependencies.env,
    new Set(),
  );
  checks.tokenConfigurationExact = noProviderCredentials;
  try {
    const intentSource = dependencies.readIntent(args.intentFile!);
    intentSha256 = postQSha256(intentSource);
    const intent = dependencies.parseIntent(intentSource, {
      candidateSha: args.candidateSha,
      runId: dependencies.env.GITHUB_RUN_ID!,
    });
    intentMetadataSource = dependencies.readIntent(
      args.intentArtifactMetadataFile!,
    );
    checks.intentArtifactExact = intent !== null && intentArtifactMetadataExact(
      intentMetadataSource,
      args,
      intentSha256,
      dependencies.env.GITHUB_RUN_ID!,
    ) && canonicalPostQEvidence(intent.qAuthority) ===
      canonicalPostQEvidence(qAuthority) &&
      canonicalPostQEvidence(intent.reviewedAuthority) ===
        canonicalPostQEvidence(reviewedAuthority);
    if (!checks.intentArtifactExact || intent === null) {
      throw new Error("intent_invalid");
    }
    boundaryPreflightSource = dependencies.readIntent(args.boundaryPreflightFile!);
    checks.boundaryPreflightExact = boundaryReceiptExact(boundaryPreflightSource) &&
      postQSha256(boundaryPreflightSource) ===
        intent.boundaryPreflightReceiptSha256;
    try {
      boundaryPostflightSource = dependencies.readIntent(
        args.boundaryPostflightFile!,
      );
    } catch {
      boundaryPostflightSource = null;
    }
    checks.boundaryPostflightExact = boundaryPostflightSource !== null &&
      boundaryReceiptExact(boundaryPostflightSource);
    try {
      innerSource = dependencies.readIntent(args.applyTerminalFile!);
    } catch {
      innerSource = null;
    }
    inner = innerSource === null ? null : applyTerminalExact(innerSource, {
      args,
      runId: dependencies.env.GITHUB_RUN_ID!,
      intentSha256,
      intentMetadataSha256: postQSha256(intentMetadataSource),
      boundaryPreflightSha256: postQSha256(boundaryPreflightSource),
      qArtifact,
      qAuthority,
      reviewedAuthority,
      intent,
    });
    if (innerSource !== null) {
      try {
        completionSource = dependencies.readIntent(evidencePath(
          path.dirname(args.applyTerminalFile!),
          POST_Q_DEPLOYMENT_STOP_APPLY_COMPLETION_LEAF,
        ));
      } catch {
        completionSource = null;
      }
      completionExact = completionSource !== null && applyCompletionExact(
        completionSource,
        {
          candidateSha: args.candidateSha,
          runId: dependencies.env.GITHUB_RUN_ID!,
          applyTerminalSource: innerSource,
        },
      );
    }
    const finalizedIntentExact = checks.intentArtifactExact;
    const finalizedPreflightExact = checks.boundaryPreflightExact;
    const finalizedPostflightExact = checks.boundaryPostflightExact;
    if (inner !== null && exactRecord(inner.receipt, Object.keys(outputReceipt({
      args,
      outcome: "failed_before_attempt",
      attempts: 0,
      failureCode: "unexpected_failure",
      checks: emptyChecks(),
      qArtifact,
      intentSha256,
      terminalSha256: null,
      stopAttempt: null,
      stableObservations: 0,
      pollRounds: 0,
    }))) && exactRecord(inner.receipt.checks, Object.keys(emptyChecks()))) {
      Object.assign(checks, inner.receipt.checks);
    }
    checks.tokenConfigurationExact = noProviderCredentials;
    checks.intentArtifactExact = finalizedIntentExact;
    checks.boundaryPreflightExact = finalizedPreflightExact;
    checks.boundaryPostflightExact = finalizedPostflightExact;
    checks.terminalEvidenceExact = inner !== null &&
      (inner.outcome !== "stopped_pending_boundary_postflight" || completionExact);
    if (!checks.tokenConfigurationExact) {
      throw new Error("token_configuration_invalid");
    }
    if (!checks.boundaryPreflightExact) {
      throw new Error("boundary_preflight_failed");
    }
    if (inner === null) throw new Error("terminal_evidence_failed");
    if (inner.outcome !== "stopped_pending_boundary_postflight") {
      throw new Error(`inner_failure:${String(inner.failureCode)}`);
    }
    if (!completionExact) throw new Error("terminal_evidence_failed");
    if (!checks.boundaryPostflightExact) {
      throw new Error("boundary_postflight_failed");
    }
    if (Object.values(checks).some((check) => check !== true)) {
      throw new Error("terminal_evidence_failed");
    }
  } catch (error) {
    const innerFailure = error instanceof Error &&
        error.message.startsWith("inner_failure:")
      ? error.message.slice("inner_failure:".length)
      : null;
    failureCode = innerFailure !== null && FAILURE_CODES.has(
      innerFailure as FailureCode,
    )
      ? innerFailure as FailureCode
      : error instanceof Error && [
      "intent_invalid", "token_configuration_invalid",
      "boundary_preflight_failed", "boundary_postflight_failed",
      "terminal_evidence_failed", "mutation_uncertain",
    ].includes(error.message)
        ? error.message as FailureCode
        : "unexpected_failure";
  }
  const stopped = failureCode === null;
  const attempts = inner === null
    ? 1 as const
    : inner.attempts === 1 ? 1 as const : 0 as const;
  const outer = {
    schemaVersion: POST_Q_DEPLOYMENT_STOP_TERMINAL_SCHEMA,
    operation: POST_Q_DEPLOYMENT_STOP_OPERATION,
    phase: "finalize",
    candidateSha: args.candidateSha,
    runId: dependencies.env.GITHUB_RUN_ID,
    outcome: stopped ? "stopped" : attempts === 1
      ? "mutation_uncertain"
      : "failed_before_attempt",
    failureCode,
    attempts,
    retryAllowed: false,
    intentArtifact: {
      id: args.intentArtifactId,
      name:
        `pintpath-permanent-staging-post-q-deployment-stop-intent-${args.candidateSha}-${dependencies.env.GITHUB_RUN_ID}`,
      digest: args.intentArtifactDigest,
      sha256: intentSha256,
      metadataSha256: intentMetadataSource === null
        ? null
        : postQSha256(intentMetadataSource),
    },
    qArtifact,
    qAuthority,
    reviewedAuthority,
    boundary: {
      preflightSha256: boundaryPreflightSource === null
        ? null
        : postQSha256(boundaryPreflightSource),
      postflightSha256: boundaryPostflightSource === null
        ? null
        : postQSha256(boundaryPostflightSource),
      preflightExact: checks.boundaryPreflightExact,
      postflightExact: checks.boundaryPostflightExact,
    },
    applyTerminal: {
      sha256: innerSource === null ? null : postQSha256(innerSource),
      sizeBytes: innerSource === null ? null : Buffer.byteLength(innerSource),
      completionSha256: completionSource === null
        ? null
        : postQSha256(completionSource),
      completionSizeBytes: completionSource === null
        ? null
        : Buffer.byteLength(completionSource),
      receipt: inner,
    },
    checks,
    coldQuiesceSatisfied: false,
    authorizesDownstream: false,
    authorizedSuccessors: ["post-Q-topology-repair-only"],
    nextRequiredProof: stopped
      ? "EXACT_SUPPORTED_US_WEST_ONE_TO_ASIA_ONE_TOPOLOGY_REPAIR_WHILE_STOPPED"
      : null,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
  let terminalSha256: string | null = null;
  const outerSource = canonicalPostQEvidence(outer);
  let outerWriteReturned = false;
  try {
    dependencies.writeEvidence(args.evidenceDir, "stop-terminal.json", outerSource);
    outerWriteReturned = true;
  } catch {
    outerWriteReturned = false;
  }
  if (outerWriteReturned && trustedReadbackExact(
    dependencies,
    args.evidenceDir,
    "stop-terminal.json",
    outerSource,
  )) {
    if (!stopped) {
      terminalSha256 = postQSha256(outerSource);
    } else {
      const completion = terminalCompletionSource({
        candidateSha: args.candidateSha,
        runId: dependencies.env.GITHUB_RUN_ID!,
        terminalSource: outerSource,
      });
      try {
        dependencies.writeEvidence(
          args.evidenceDir,
          POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_LEAF,
          completion,
        );
      } catch {
        // A marker's late directory-sync failure is resolved only by exact,
        // trusted, canonical read-back of the already-bound marker bytes.
      }
      if (trustedReadbackExact(
        dependencies,
        args.evidenceDir,
        POST_Q_DEPLOYMENT_STOP_TERMINAL_COMPLETION_LEAF,
        completion,
      ) && terminalCompletionExact(completion, {
        candidateSha: args.candidateSha,
        runId: dependencies.env.GITHUB_RUN_ID!,
        terminalSource: outerSource,
      })) terminalSha256 = postQSha256(outerSource);
    }
  }
  if (terminalSha256 === null) {
    checks.terminalEvidenceExact = false;
    failureCode = "terminal_evidence_failed";
  }
  const finalizedStopped = stopped && terminalSha256 !== null;
  dependencies.writeOutput(`${JSON.stringify(outputReceipt({
    args,
    outcome: finalizedStopped ? "stopped" : attempts === 1
      ? "mutation_uncertain"
      : "failed_before_attempt",
    attempts,
    failureCode,
    checks,
    qArtifact,
    intentSha256,
    terminalSha256,
    stopAttempt: exactRecord(inner?.stopRequest, [
      "outcome", "acknowledgementExact", "querySha256", "variablesSha256",
      "requestBodySha256", "responseBodySha256", "acknowledgementSha256",
    ]) ? inner.stopRequest as unknown as StopAttempt : null,
    stableObservations: exactRecord(inner?.providerEvidence, [
      "beforeSnapshot", "beforeLedger", "terminalSnapshot", "terminalLedger",
      "terminalLedgerEvidence", "observations", "stableObservationCount",
      "stableObservationSpanMs", "totalObservationSpanMs", "pollRounds", "runtime",
    ]) && typeof inner.providerEvidence.stableObservationCount === "number"
      ? inner.providerEvidence.stableObservationCount
      : 0,
    pollRounds: exactRecord(inner?.providerEvidence, [
      "beforeSnapshot", "beforeLedger", "terminalSnapshot", "terminalLedger",
      "terminalLedgerEvidence", "observations", "stableObservationCount",
      "stableObservationSpanMs", "totalObservationSpanMs", "pollRounds", "runtime",
    ]) && typeof inner.providerEvidence.pollRounds === "number"
      ? inner.providerEvidence.pollRounds
      : 0,
  }))}\n`);
  return finalizedStopped ? 0 : 1;
}

function writeCommonPhaseFailure(
  dependencies: PostQDeploymentStopDependencies,
  args: Arguments,
  checks: Checks,
  failureCode: FailureCode,
  qArtifact: QArtifactEvidence | null,
): 1 {
  let terminalSha256: string | null = null;
  const safeRunId = RUN_ID_PATTERN.test(dependencies.env.GITHUB_RUN_ID ?? "")
    ? dependencies.env.GITHUB_RUN_ID!
    : null;
  if (args.phase === "apply") {
    const receipt = outputReceipt({
      args,
      outcome: "failed_before_attempt",
      attempts: 0,
      failureCode,
      checks,
      qArtifact,
      intentSha256: null,
      terminalSha256: null,
      stopAttempt: null,
      stableObservations: 0,
      pollRounds: 0,
    });
    const terminal = {
      schemaVersion: POST_Q_DEPLOYMENT_STOP_APPLY_TERMINAL_SCHEMA,
      operation: POST_Q_DEPLOYMENT_STOP_OPERATION,
      phase: "apply",
      candidateSha: args.candidateSha,
      runId: safeRunId,
      outcome: "failed_before_attempt",
      failureCode,
      attempts: 0,
      retryAllowed: false,
      receipt,
      intentArtifact: null,
      qArtifact,
      qAuthority: null,
      reviewedAuthority: null,
      boundaryPreflightSha256: null,
      requestWindow: { startedAt: null, completedAt: null },
      stopRequest: null,
      providerEvidence: {
        beforeSnapshot: null,
        beforeLedger: null,
        terminalSnapshot: null,
        terminalLedger: null,
        terminalLedgerEvidence: null,
        observations: [],
        stableObservationCount: 0,
        stableObservationSpanMs: 0,
        totalObservationSpanMs: 0,
        pollRounds: 0,
        runtime: null,
      },
      coldQuiesceSatisfied: false,
      authorizesDownstream: false,
      authorizedSuccessors: ["post-Q-topology-repair-only"],
      nextRequiredProof: null,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    };
    try {
      const source = canonicalPostQEvidence(terminal);
      dependencies.writeEvidence(args.evidenceDir, "stop-apply-terminal.json", source);
      terminalSha256 = postQSha256(source);
    } catch {
      terminalSha256 = null;
    }
  } else if (args.phase === "finalize") {
    let innerSource: string | null = null;
    try {
      innerSource = dependencies.readIntent(args.applyTerminalFile!);
    } catch {
      innerSource = null;
    }
    const outer = {
      schemaVersion: POST_Q_DEPLOYMENT_STOP_TERMINAL_SCHEMA,
      operation: POST_Q_DEPLOYMENT_STOP_OPERATION,
      phase: "finalize",
      candidateSha: args.candidateSha,
      runId: safeRunId,
      outcome: "mutation_uncertain",
      failureCode,
      attempts: 1,
      retryAllowed: false,
      intentArtifact: null,
      qArtifact,
      qAuthority: null,
      reviewedAuthority: null,
      boundary: {
        preflightSha256: null,
        postflightSha256: null,
        preflightExact: false,
        postflightExact: false,
      },
      applyTerminal: {
        sha256: innerSource === null ? null : postQSha256(innerSource),
        sizeBytes: innerSource === null ? null : Buffer.byteLength(innerSource),
        completionSha256: null,
        completionSizeBytes: null,
        receipt: null,
      },
      checks,
      coldQuiesceSatisfied: false,
      authorizesDownstream: false,
      authorizedSuccessors: ["post-Q-topology-repair-only"],
      nextRequiredProof: null,
      secretMaterialIncluded: false,
      secretDerivedCommitmentsIncluded: false,
    };
    try {
      const source = canonicalPostQEvidence(outer);
      dependencies.writeEvidence(args.evidenceDir, "stop-terminal.json", source);
      terminalSha256 = postQSha256(source);
    } catch {
      terminalSha256 = null;
    }
  }
  dependencies.writeOutput(`${JSON.stringify(outputReceipt({
    args,
    outcome: args.phase === "finalize"
      ? "mutation_uncertain"
      : "failed_before_attempt",
    attempts: args.phase === "finalize" ? 1 : 0,
    failureCode,
    checks,
    qArtifact,
    intentSha256: null,
    terminalSha256,
    stopAttempt: null,
    stableObservations: 0,
    pollRounds: 0,
  }))}\n`);
  return 1;
}

function writeInvalidFinalizeArgumentsFallback(
  dependencies: PostQDeploymentStopDependencies,
): boolean {
  const valueFor = (flag: string): string | null => {
    const indexes = dependencies.argv.flatMap((value, index) =>
      value === flag ? [index] : []);
    return indexes.length === 1 && indexes[0]! + 1 < dependencies.argv.length
      ? dependencies.argv[indexes[0]! + 1]!
      : null;
  };
  if (valueFor("--phase") !== "finalize") return false;
  const evidenceValue = valueFor("--evidence-dir");
  const evidenceDir = evidenceValue === null ? null : absolute(evidenceValue);
  if (evidenceDir === null) return false;
  const candidateValue = valueFor("--candidate-sha");
  const safeCandidateSha = candidateValue !== null && SHA_PATTERN.test(candidateValue)
    ? candidateValue
    : null;
  const safeRunId = RUN_ID_PATTERN.test(dependencies.env.GITHUB_RUN_ID ?? "")
    ? dependencies.env.GITHUB_RUN_ID!
    : null;
  const applyValue = valueFor("--apply-terminal-file");
  const applyFile = applyValue === null ? null : absolute(applyValue);
  let innerSource: string | null = null;
  if (applyFile !== null) {
    try {
      innerSource = dependencies.readIntent(applyFile);
    } catch {
      innerSource = null;
    }
  }
  const outer = {
    schemaVersion: POST_Q_DEPLOYMENT_STOP_TERMINAL_SCHEMA,
    operation: POST_Q_DEPLOYMENT_STOP_OPERATION,
    phase: "finalize",
    candidateSha: safeCandidateSha,
    runId: safeRunId,
    outcome: "mutation_uncertain",
    failureCode: "arguments_invalid",
    attempts: 1,
    retryAllowed: false,
    intentArtifact: null,
    qArtifact: null,
    qAuthority: null,
    reviewedAuthority: null,
    boundary: {
      preflightSha256: null,
      postflightSha256: null,
      preflightExact: false,
      postflightExact: false,
    },
    applyTerminal: {
      sha256: innerSource === null ? null : postQSha256(innerSource),
      sizeBytes: innerSource === null ? null : Buffer.byteLength(innerSource),
      completionSha256: null,
      completionSizeBytes: null,
      receipt: null,
    },
    checks: emptyChecks(),
    coldQuiesceSatisfied: false,
    authorizesDownstream: false,
    authorizedSuccessors: ["post-Q-topology-repair-only"],
    nextRequiredProof: null,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  };
  let terminalSha256: string | null = null;
  try {
    const source = canonicalPostQEvidence(outer);
    dependencies.writeEvidence(evidenceDir, "stop-terminal.json", source);
    terminalSha256 = postQSha256(source);
  } catch {
    terminalSha256 = null;
  }
  dependencies.writeOutput(`${JSON.stringify({
    schemaVersion: POST_Q_DEPLOYMENT_STOP_EXECUTOR_SCHEMA,
    operation: POST_Q_DEPLOYMENT_STOP_OPERATION,
    phase: "finalize",
    candidateSha: safeCandidateSha,
    outcome: "mutation_uncertain",
    attempts: 1,
    retryAllowed: false,
    failureCode: "arguments_invalid",
    terminalSha256,
    nextRequiredProof: null,
    secretMaterialIncluded: false,
    secretDerivedCommitmentsIncluded: false,
  })}\n`);
  return true;
}

export async function runProtectedPermanentStagingPostQDeploymentStop(
  overrides: Partial<PostQDeploymentStopDependencies> = {},
): Promise<0 | 1> {
  const env = overrides.env ?? process.env;
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const dependencies: PostQDeploymentStopDependencies = {
    argv: overrides.argv ?? process.argv.slice(2),
    env,
    cwd: overrides.cwd ?? process.cwd(),
    fetchImpl,
    repositoryExact: overrides.repositoryExact ?? ((candidateSha) => {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: overrides.cwd ?? process.cwd(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() === candidateSha && execFileSync(
          "git", ["status", "--porcelain"], {
            cwd: overrides.cwd ?? process.cwd(),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        ).length === 0;
      } catch {
        return false;
      }
    }),
    confirmationExact: overrides.confirmationExact ?? ((candidateSha, inputEnv) =>
      confirmationExact({ candidateSha }, inputEnv)),
    authorizationDeadlineExact: overrides.authorizationDeadlineExact ??
      ((authority, nowMs) => Number.isFinite(nowMs) &&
        nowMs < Date.parse(authority.authorizationDeadline)),
    readQArtifact: overrides.readQArtifact ?? readQArtifact,
    validateQArtifact: overrides.validateQArtifact ?? validatePostQArtifactSources,
    parseQAuthority: overrides.parseQAuthority ?? parsePostQAuthority,
    parseReviewedAuthority: overrides.parseReviewedAuthority ??
      parseReviewedContainmentAuthority,
    parseIntent: overrides.parseIntent ?? parsePostQDeploymentStopIntent,
    snapshotBaselineExact: overrides.snapshotBaselineExact ?? snapshotBaselineExact,
    ledgerBaselineExact: overrides.ledgerBaselineExact ?? providerLedgerBaselineExact,
    reconcile: overrides.reconcile ?? reconcileStoppedDeployment,
    snapshotCommitment: overrides.snapshotCommitment ?? snapshotCommitment,
    ledgerCommitment: overrides.ledgerCommitment ?? ledgerCommitment,
    readIntent: overrides.readIntent ?? ((filename) =>
      readTrustedRegularFile(filename, {
        minBytes: 2,
        maxBytes: MAX_EVIDENCE_BYTES,
      }).toString("utf8")),
    writeEvidence: overrides.writeEvidence ?? ((directory, leaf, source) =>
      writePrivateExclusiveFile(directory, leaf, source, { requireOwner: true })),
    boundaryCheck: overrides.boundaryCheck ?? (() =>
      defaultBoundaryCheck(env, fetchImpl)),
    readScope: overrides.readScope ?? ((token) => readPostQTokenScope(fetchImpl, token)),
    readSnapshot: overrides.readSnapshot ?? ((token) =>
      readPostQDeploymentStopSnapshot(fetchImpl, token)),
    readLedger: overrides.readLedger ?? ((token) =>
      readPostQProviderLedger(fetchImpl, token)),
    stopDeployment: overrides.stopDeployment ?? ((token) =>
      stopPostQDeployment(fetchImpl, token)),
    probeRuntime: overrides.probeRuntime ?? (() => probePostQRuntimeAbsence(fetchImpl)),
    sleep: overrides.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))),
    monotonicNow: overrides.monotonicNow ?? (() => performance.now()),
    now: overrides.now ?? (() => Date.now()),
    writeOutput: overrides.writeOutput ?? ((source) => process.stdout.write(source)),
  };
  const checks = emptyChecks();
  const args = parseArgs(dependencies.argv);
  checks.argumentsExact = args !== null;
  if (args === null) {
    if (writeInvalidFinalizeArgumentsFallback(dependencies)) return 1;
    dependencies.writeOutput(`${JSON.stringify(outputReceipt({
      args: null,
      outcome: "failed_before_attempt",
      attempts: 0,
      failureCode: "arguments_invalid",
      checks,
      qArtifact: null,
      intentSha256: null,
      terminalSha256: null,
      stopAttempt: null,
      stableObservations: 0,
      pollRounds: 0,
    }))}\n`);
    return 1;
  }
  checks.githubContextExact = githubContextExact(args, dependencies.env) &&
    dependencies.repositoryExact(args.candidateSha);
  checks.confirmationExact = dependencies.confirmationExact(
    args.candidateSha,
    dependencies.env,
  );
  if (!checks.githubContextExact || !checks.confirmationExact) {
    return writeCommonPhaseFailure(
      dependencies,
      args,
      checks,
      checks.githubContextExact
        ? "confirmation_invalid"
        : "github_context_invalid",
      null,
    );
  }
  let qArtifact: QArtifactEvidence | null = null;
  try {
    qArtifact = dependencies.validateQArtifact(
      dependencies.readQArtifact(args.qArtifactDir),
    );
  } catch {
    qArtifact = null;
  }
  checks.qArtifactExact = qArtifact !== null;
  if (qArtifact === null) {
    return writeCommonPhaseFailure(
      dependencies,
      args,
      checks,
      "q_artifact_invalid",
      null,
    );
  }
  let qAuthority: PostQAuthorityEvidence | null = null;
  let reviewedAuthority: ReviewedContainmentAuthorityEvidence | null = null;
  try {
    const expected = {
      candidateSha: args.candidateSha,
      runId: dependencies.env.GITHUB_RUN_ID!,
    };
    qAuthority = dependencies.parseQAuthority(
      dependencies.readIntent(args.qAuthorityFile),
      expected,
    );
    reviewedAuthority = dependencies.parseReviewedAuthority(
      dependencies.readIntent(args.reviewedAuthorityFile),
      expected,
    );
  } catch {
    qAuthority = null;
    reviewedAuthority = null;
  }
  checks.qAuthorityExact = qAuthority !== null;
  checks.reviewedAuthorityExact = reviewedAuthority !== null;
  checks.authorizationDeadlineExact = reviewedAuthority !== null &&
    (args.phase === "finalize" || dependencies.authorizationDeadlineExact(
      reviewedAuthority,
      dependencies.now(),
    ));
  if (qAuthority === null || reviewedAuthority === null ||
    !checks.authorizationDeadlineExact) {
    return writeCommonPhaseFailure(
      dependencies,
      args,
      checks,
      qAuthority === null
        ? "q_authority_invalid"
        : reviewedAuthority === null
          ? "reviewed_authority_invalid"
          : "authorization_expired",
      qArtifact,
    );
  }
  if (args.phase === "prepare") return prepare(
      dependencies,
      args,
      checks,
      qArtifact,
      qAuthority,
      reviewedAuthority,
    );
  if (args.phase === "apply") return apply(
      dependencies,
      args,
      checks,
      qArtifact,
      qAuthority,
      reviewedAuthority,
    );
  return finalize(
    dependencies,
    args,
    checks,
    qArtifact,
    qAuthority,
    reviewedAuthority,
  );
}

function readQArtifact(directory: string): Readonly<Record<string, string>> {
  const sources: Record<string, string> = {};
  for (const leaf of POST_Q_DEPLOYMENT_STOP_Q_LEAVES) {
    const filename = path.join(directory, ...leaf.relativePath.split("/"));
    sources[leaf.relativePath] = readTrustedRegularFile(filename, {
      minBytes: 2,
      maxBytes: MAX_EVIDENCE_BYTES,
    }).toString("utf8");
  }
  const discovered: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const filename = path.join(current, name);
      const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) throw new Error("q_artifact_invalid");
      if (stat.isDirectory()) walk(filename, relative);
      else if (stat.isFile()) discovered.push(relative);
      else throw new Error("q_artifact_invalid");
    }
  };
  walk(directory, "");
  if (canonicalPostQEvidence(discovered.sort()) !==
    canonicalPostQEvidence(POST_Q_DEPLOYMENT_STOP_Q_LEAVES.map((leaf) =>
      leaf.relativePath).sort())) throw new Error("q_artifact_invalid");
  return sources;
}

async function defaultBoundaryCheck(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
): Promise<BoundaryEvidence> {
  let source = "";
  const code = await runRailwayMutationBoundaryCheck({
    argv: ["--policy", BOUNDARY_POLICY],
    env,
    fetchImpl,
    writeOutput: (chunk) => {
      if (Buffer.byteLength(source) + Buffer.byteLength(chunk) >
        MAX_EVIDENCE_BYTES) throw new Error("boundary_invalid");
      source += chunk;
    },
  });
  return {
    passed: code === 0,
    receiptSha256: source.length === 0 ? null : postQSha256(source),
  };
}

const direct = process.argv[1] === fileURLToPath(import.meta.url);
if (direct) {
  process.exitCode = await runProtectedPermanentStagingPostQDeploymentStop();
}

export const postQDeploymentStopExecutorInternals = Object.freeze({
  applyCompletionExact,
  applyCompletionSource,
  boundaryReceiptExact,
  confirmationExact,
  emptyChecks,
  githubContextExact,
  parseArgs,
  readQArtifact,
  terminalCompletionExact,
  terminalCompletionSource,
});
