import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ACCOUNT_DELETION_REHEARSAL_CLOSEOUT_SCHEMA =
  "pintpath-account-deletion-rehearsal-closeout/v2";

const OBSERVATION_SCHEMA =
  "pintpath-account-deletion-rehearsal-state-observation/v1";
const ARM_SCHEMA = "pintpath-account-deletion-rehearsal-cleanup-arm/v1";
const AUTHORITY_SCHEMA = "pintpath-account-deletion-rehearsal-authority/v1";
const EXECUTOR_STATE = "GITHUB_ENVIRONMENT_PROTECTED";
const INVENTORY_SCHEMA =
  "pintpath-account-deletion-rehearsal-attempt-inventory/v1";
const REPOSITORY = "blackmagic30/Beer";
const PROJECT_ID = "48d8c6cd-1c66-4148-874b-20877f48e1a5";
const ENVIRONMENT_ID = "a4e0f507-d6d3-4df9-a818-ad92c0071a35";
const SERVICE_ID = "6816c4a2-e392-4ee5-826f-2584cb599ec0";
const REGION = "asia-southeast1-eqsg3a";
const PUBLIC_ORIGIN = "https://beer-staging.up.railway.app";
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

const TERMINAL_STATES = Object.freeze([
  "SAFE_ONE_PREACTIVATION",
  "SAFE_ONE_FINAL",
  "QUARANTINED_ZERO",
]);
const ATTEMPT_OPERATIONS = Object.freeze([
  "prepare-two",
  "store-activation",
  "apply-active",
  "store-cleanup",
  "reconcile-cleanup",
  "cleanup-contained-zero",
  "apply-safe",
  "converge-one",
  "quarantine-zero",
  "quarantine-zero-retry-1",
  "quarantine-zero-retry-2",
]);
const CONTAINMENT_ATTEMPT_OPERATIONS = Object.freeze([
  "cleanup-contained-zero",
  "quarantine-zero",
  "quarantine-zero-retry-1",
  "quarantine-zero-retry-2",
]);

const CLOSEOUT_KEYS = Object.freeze([
  "schemaVersion",
  "repository",
  "mode",
  "state",
  "candidateSha",
  "activationRunId",
  "producerRunId",
  "recoveryRunId",
  "producerRunAttempt",
  "recoveryImplementationSha",
  "lock",
  "cleanupArmSha256",
  "authoritySha256",
  "providerEvidenceFilename",
  "providerEvidenceSchema",
  "providerEvidenceSha256",
  "attemptInventoryFilename",
  "attemptInventorySha256",
  "attemptArmCount",
  "cleanupObligationDisarmed",
  "mutationCredentialExposed",
  "secretMaterialIncluded",
]);

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function canonical(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requiredFileFlag(value, failureCode) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(failureCode);
  return value;
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function parseCanonicalSource(source, failureCode) {
  try {
    if (typeof source !== "string" || source.length <= 1
      || Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES
      || source.includes("\0")) throw new Error(failureCode);
    const value = JSON.parse(source);
    if (canonical(value) !== source) throw new Error(failureCode);
    return value;
  } catch {
    throw new Error(failureCode);
  }
}

function readCanonicalFile(filename, failureCode) {
  let descriptor = null;
  let bytes = null;
  let source = null;
  let exactRead = false;
  try {
    if (!path.isAbsolute(filename) || filename.includes("\0")) {
      throw new Error(failureCode);
    }
    descriptor = fs.openSync(
      filename,
      fs.constants.O_RDONLY
        | requiredFileFlag(fs.constants.O_NOFOLLOW, failureCode)
        | requiredFileFlag(fs.constants.O_NONBLOCK, failureCode),
    );
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n
      || before.size <= 1n || before.size > BigInt(MAX_SOURCE_BYTES)) {
      throw new Error(failureCode);
    }
    bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error(failureCode);
      }
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(before, after)) throw new Error(failureCode);
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parseCanonicalSource(source, failureCode);
    const final = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(after, final)) throw new Error(failureCode);
    exactRead = true;
  } catch {
    exactRead = false;
  } finally {
    bytes?.fill(0);
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        exactRead = false;
      }
    }
  }
  if (!exactRead || source === null) throw new Error(failureCode);
  return source;
}

function shaListExact(value, length) {
  return Array.isArray(value) && value.length === length
    && new Set(value).size === length
    && value.every((item) => typeof item === "string" && SHA256.test(item));
}

function responseHashesExact(value, replicas) {
  return record(value)
    && JSON.stringify(Object.keys(value)) ===
      JSON.stringify(["/health", "/startup", "/ready"])
    && ["/health", "/startup", "/ready"].every((route) =>
      shaListExact(value[route], replicas));
}

function checksExact(checks) {
  const keys = [
    "policyExact",
    "githubAuthorityExact",
    "tokenScopesExact",
    "cliExact",
    "boundaryPreflightExact",
    "providerTopologyExact",
    "candidateExact",
    "rowCategoryExact",
    "stagedPatchExact",
    "activationMarkerExact",
    "runtimeProofExact",
    "boundaryPostflightExact",
  ];
  return exactKeys(checks, keys) && keys.every((key) => checks[key] === true);
}

function lockExact(lock) {
  return exactKeys(lock, [
    "projectId",
    "environmentId",
    "serviceId",
    "region",
    "publicOrigin",
  ])
    && lock.projectId === PROJECT_ID
    && lock.environmentId === ENVIRONMENT_ID
    && lock.serviceId === SERVICE_ID
    && lock.region === REGION
    && lock.publicOrigin === PUBLIC_ORIGIN;
}

function providerSnapshotCommonExact(snapshot) {
  return exactKeys(snapshot, [
    "replicas",
    "instanceCount",
    "instanceIdSha256s",
    "instanceStatuses",
    "deploymentIdSha256",
    "snapshotIdSha256",
    "imageDigestSha256",
    "invariantSha256",
    "rowNamesSha256",
    "rowCategory",
    "patchSha256",
    "patchCategory",
  ])
    && Number.isSafeInteger(snapshot.replicas)
    && Number.isSafeInteger(snapshot.instanceCount)
    && snapshot.replicas >= 0
    && snapshot.instanceCount >= 0
    && SHA256.test(snapshot.deploymentIdSha256)
    && SHA256.test(snapshot.snapshotIdSha256)
    && SHA256.test(snapshot.imageDigestSha256)
    && SHA256.test(snapshot.invariantSha256)
    && SHA256.test(snapshot.rowNamesSha256)
    && SHA256.test(snapshot.patchSha256);
}

function runtimeCommonExact(runtime) {
  return exactKeys(runtime, [
    "expected",
    "replicas",
    "publicExact",
    "providerExact",
    "runtimeUnavailableExact",
    "replicaIdSha256s",
    "responseSha256s",
    "providerReadinessSha256s",
  ]) && Number.isSafeInteger(runtime.replicas) && runtime.replicas >= 0;
}

function stateProofExact(state, snapshot, runtime) {
  if (!providerSnapshotCommonExact(snapshot) || !runtimeCommonExact(runtime)) {
    return false;
  }
  if (state === "SAFE_ONE_PREACTIVATION" || state === "SAFE_ONE_FINAL") {
    const expectedRow = state === "SAFE_ONE_PREACTIVATION"
      ? "preactivation" : "cleanup";
    return snapshot.replicas === 1
      && snapshot.instanceCount === 1
      && shaListExact(snapshot.instanceIdSha256s, 1)
      && Array.isArray(snapshot.instanceStatuses)
      && snapshot.instanceStatuses.length === 1
      && snapshot.instanceStatuses[0] === "RUNNING"
      && snapshot.rowCategory === expectedRow
      && snapshot.patchCategory === "empty"
      && runtime.expected === "safe"
      && runtime.replicas === 1
      && runtime.publicExact === true
      && runtime.providerExact === true
      && runtime.runtimeUnavailableExact === false
      && shaListExact(runtime.replicaIdSha256s, 1)
      && responseHashesExact(runtime.responseSha256s, 1)
      && shaListExact(runtime.providerReadinessSha256s, 1);
  }
  if (state === "QUARANTINED_ZERO") {
    return snapshot.replicas === 0
      && snapshot.instanceCount === 0
      && Array.isArray(snapshot.instanceIdSha256s)
      && snapshot.instanceIdSha256s.length === 0
      && Array.isArray(snapshot.instanceStatuses)
      && snapshot.instanceStatuses.length === 0
      && snapshot.rowCategory === "cleanup"
      && snapshot.patchCategory === "empty"
      && runtime.expected === "absent"
      && runtime.replicas === 0
      && runtime.publicExact === false
      && runtime.providerExact === false
      && runtime.runtimeUnavailableExact === true
      && Array.isArray(runtime.replicaIdSha256s)
      && runtime.replicaIdSha256s.length === 0
      && responseHashesExact(runtime.responseSha256s, 0)
      && Array.isArray(runtime.providerReadinessSha256s)
      && runtime.providerReadinessSha256s.length === 0;
  }
  return false;
}

function cleanupArmExact(value, candidateSha, activationRunId) {
  return exactKeys(value, [
    "schemaVersion",
    "candidateSha",
    "activationRunId",
    "projectId",
    "environmentId",
    "serviceId",
    "cleanupRequired",
    "disarmCondition",
    "secretMaterialIncluded",
  ])
    && value.schemaVersion === ARM_SCHEMA
    && value.candidateSha === candidateSha
    && value.activationRunId === activationRunId
    && value.projectId === PROJECT_ID
    && value.environmentId === ENVIRONMENT_ID
    && value.serviceId === SERVICE_ID
    && value.cleanupRequired === true
    && value.disarmCondition ===
      "SAFE_ONE_PREACTIVATION_OR_SAFE_ONE_FINAL_OR_QUARANTINED_ZERO"
    && value.secretMaterialIncluded === false;
}

function authorityExact(
  value,
  { mode, candidateSha, activationRunId, producerRunId, cleanupArmSha256 },
) {
  if (!exactKeys(value, [
    "schemaVersion",
    "executorState",
    "mode",
    "candidateSha",
    "githubRunId",
    "workflowPath",
    "reviewedPullRequest",
    "originalActivation",
    "cleanupMayProceedAfterMainAdvances",
    "secretMaterialIncluded",
  ]) || value.schemaVersion !== AUTHORITY_SCHEMA
    || value.executorState !== EXECUTOR_STATE
    || value.candidateSha !== candidateSha
    || value.githubRunId !== producerRunId
    || value.secretMaterialIncluded !== false) return false;
  if (mode === "original") {
    return producerRunId === activationRunId
      && value.mode === "start"
      && value.workflowPath ===
        ".github/workflows/permanent-staging-account-deletion-rehearsal.yml"
      && exactKeys(value.reviewedPullRequest, [
        "number",
        "reviewedPrHeadSha",
        "mergeCommitSha",
        "treeSha",
        "mergedAt",
        "authorId",
        "mergedById",
        "githubMergeExact",
        "reviewedTreeExact",
        "pullRequestApprovalRequirement",
        "pullRequestApprovalRequirementExact",
        "linearHistoryExact",
      ])
      && Number.isSafeInteger(value.reviewedPullRequest.number)
      && value.reviewedPullRequest.number > 0
      && SHA.test(value.reviewedPullRequest.reviewedPrHeadSha)
      && value.reviewedPullRequest.mergeCommitSha === candidateSha
      && SHA.test(value.reviewedPullRequest.treeSha)
      && ISO_TIMESTAMP.test(value.reviewedPullRequest.mergedAt)
      && Number.isSafeInteger(value.reviewedPullRequest.authorId)
      && value.reviewedPullRequest.authorId > 0
      && Number.isSafeInteger(value.reviewedPullRequest.mergedById)
      && value.reviewedPullRequest.mergedById > 0
      && value.reviewedPullRequest.githubMergeExact === true
      && value.reviewedPullRequest.reviewedTreeExact === true
      && value.reviewedPullRequest.pullRequestApprovalRequirement ===
        "not_required"
      && value.reviewedPullRequest.pullRequestApprovalRequirementExact === true
      && value.reviewedPullRequest.linearHistoryExact === true
      && value.originalActivation === null
      && value.cleanupMayProceedAfterMainAdvances === false
      ;
  }
  return value.mode === "cleanup"
    && value.workflowPath ===
      ".github/workflows/reconcile-permanent-staging-account-deletion-rehearsal.yml"
    && value.reviewedPullRequest === null
    && value.cleanupMayProceedAfterMainAdvances === true
    && exactKeys(value.originalActivation, [
      "runId",
      "terminalSha256",
      "mainAdvanceIgnoredForCleanup",
    ])
    && value.originalActivation.runId === activationRunId
    && value.originalActivation.terminalSha256 === cleanupArmSha256
    && value.originalActivation.mainAdvanceIgnoredForCleanup === true;
}

export function validateAccountDeletionRehearsalArmBundle({
  cleanupArmSource,
  authoritySource,
  expectedCandidateSha,
  expectedActivationRunId,
}) {
  if (!SHA.test(expectedCandidateSha)
    || !RUN_ID.test(expectedActivationRunId)) {
    throw new Error("arm_expectation_invalid");
  }
  const cleanupArm = parseCanonicalSource(
    cleanupArmSource,
    "cleanup_arm_invalid",
  );
  if (!cleanupArmExact(
    cleanupArm,
    expectedCandidateSha,
    expectedActivationRunId,
  )) throw new Error("cleanup_arm_invalid");
  const cleanupArmSha256 = sha256(cleanupArmSource);
  const authority = parseCanonicalSource(authoritySource, "authority_invalid");
  if (!authorityExact(authority, {
    mode: "original",
    candidateSha: expectedCandidateSha,
    activationRunId: expectedActivationRunId,
    producerRunId: expectedActivationRunId,
    cleanupArmSha256,
  })) throw new Error("authority_invalid");
  return { cleanupArmSha256, authoritySha256: sha256(authoritySource) };
}

function observationExact(
  value,
  {
    candidateSha,
    activationRunId,
    producerRunId,
    implementationSha,
    authoritySha256,
  },
) {
  return exactKeys(value, [
    "schemaVersion",
    "executorState",
    "state",
    "candidateSha",
    "activationRunId",
    "githubRunId",
    "implementationSha",
    "authoritySha256",
    "exact",
    "lock",
    "providerSnapshot",
    "runtime",
    "checks",
    "mutationCredentialExposed",
    "secretMaterialIncluded",
  ])
    && value.schemaVersion === OBSERVATION_SCHEMA
    && value.executorState === EXECUTOR_STATE
    && TERMINAL_STATES.includes(value.state)
    && value.candidateSha === candidateSha
    && value.activationRunId === activationRunId
    && value.githubRunId === producerRunId
    && value.implementationSha === implementationSha
    && value.authoritySha256 === authoritySha256
    && value.exact === true
    && lockExact(value.lock)
    && stateProofExact(value.state, value.providerSnapshot, value.runtime)
    && checksExact(value.checks)
    && value.mutationCredentialExposed === false
    && value.secretMaterialIncluded === false;
}

function attemptInventoryExact(value, candidateSha, activationRunId) {
  if (!exactKeys(value, [
    "schemaVersion",
    "repository",
    "candidateSha",
    "activationRunId",
    "attempts",
    "complete",
    "mutationCredentialExposed",
    "secretMaterialIncluded",
  ])
    || value.schemaVersion !== INVENTORY_SCHEMA
    || value.repository !== REPOSITORY
    || value.candidateSha !== candidateSha
    || value.activationRunId !== activationRunId
    || !exactKeys(value.attempts, ATTEMPT_OPERATIONS)
    || value.complete !== true
    || value.mutationCredentialExposed !== false
    || value.secretMaterialIncluded !== false) return false;
  for (const operation of ATTEMPT_OPERATIONS) {
    const attempt = value.attempts[operation];
    if (attempt === null) continue;
    if (!exactKeys(attempt, [
      "artifactId",
      "artifactDigest",
      "producerRunId",
      "producerWorkflow",
      "producerHeadSha",
      "producerEvent",
      "contentSha256",
      "authoritySha256",
      "prerequisiteSha256",
      "providerSnapshotSha256",
      "providerInvariantSha256",
    ])
      || !Number.isSafeInteger(attempt.artifactId)
      || attempt.artifactId <= 0
      || !/^sha256:[a-f0-9]{64}$/.test(attempt.artifactDigest)
      || !RUN_ID.test(attempt.producerRunId)
      || !["original", "reconcile"].includes(attempt.producerWorkflow)
      || !SHA.test(attempt.producerHeadSha)
      || !(attempt.producerWorkflow === "original"
        ? attempt.producerRunId === activationRunId
          && attempt.producerHeadSha === candidateSha
          && attempt.producerEvent === "workflow_dispatch"
        : ["workflow_dispatch", "workflow_run", "schedule"]
          .includes(attempt.producerEvent))
      || !SHA256.test(attempt.contentSha256)
      || !SHA256.test(attempt.authoritySha256)
      || !(attempt.prerequisiteSha256 === null
        || SHA256.test(attempt.prerequisiteSha256))
      || !SHA256.test(attempt.providerSnapshotSha256)
      || !SHA256.test(attempt.providerInvariantSha256)) return false;
  }
  return true;
}

function attemptArmCount(value) {
  return ATTEMPT_OPERATIONS.filter((operation) =>
    value.attempts[operation] !== null).length;
}

function containmentHistoryAllowsTerminalState(inventory, state) {
  const containmentStarted = CONTAINMENT_ATTEMPT_OPERATIONS.some(
    (operation) => inventory.attempts[operation] !== null,
  );
  return containmentStarted ? state === "QUARANTINED_ZERO"
    : state === "SAFE_ONE_PREACTIVATION"
      || state === "SAFE_ONE_FINAL"
      || state === "QUARANTINED_ZERO";
}

function closeoutExact(value, expected) {
  return exactKeys(value, CLOSEOUT_KEYS)
    && value.schemaVersion === ACCOUNT_DELETION_REHEARSAL_CLOSEOUT_SCHEMA
    && value.repository === REPOSITORY
    && value.mode === expected.mode
    && TERMINAL_STATES.includes(value.state)
    && value.candidateSha === expected.candidateSha
    && value.activationRunId === expected.activationRunId
    && value.producerRunId === expected.producerRunId
    && value.recoveryRunId === (expected.mode === "reconcile"
      ? expected.producerRunId : null)
    && value.producerRunAttempt === 1
    && value.recoveryImplementationSha === expected.implementationSha
    && lockExact(value.lock)
    && value.cleanupArmSha256 === expected.cleanupArmSha256
    && value.authoritySha256 === expected.authoritySha256
    && value.providerEvidenceFilename === "provider-evidence.json"
    && value.providerEvidenceSchema === OBSERVATION_SCHEMA
    && value.providerEvidenceSha256 === expected.providerEvidenceSha256
    && value.attemptInventoryFilename === "attempt-inventory.json"
    && value.attemptInventorySha256 === expected.attemptInventorySha256
    && value.attemptArmCount === expected.attemptArmCount
    && value.cleanupObligationDisarmed === true
    && value.mutationCredentialExposed === false
    && value.secretMaterialIncluded === false;
}

export function validateAccountDeletionRehearsalCloseoutBundle({
  closeoutSource,
  providerEvidenceSource,
  authoritySource,
  cleanupArmSource,
  attemptInventorySource,
  expectedMode,
  expectedCandidateSha,
  expectedActivationRunId,
  expectedProducerRunId,
  expectedImplementationSha,
}) {
  if (!["original", "reconcile"].includes(expectedMode)
    || !SHA.test(expectedCandidateSha)
    || !RUN_ID.test(expectedActivationRunId)
    || !RUN_ID.test(expectedProducerRunId)
    || !SHA.test(expectedImplementationSha)) {
    throw new Error("closeout_expectation_invalid");
  }
  const cleanupArm = parseCanonicalSource(
    cleanupArmSource,
    "cleanup_arm_invalid",
  );
  if (!cleanupArmExact(
    cleanupArm,
    expectedCandidateSha,
    expectedActivationRunId,
  )) throw new Error("cleanup_arm_invalid");
  const cleanupArmSha256 = sha256(cleanupArmSource);
  const authority = parseCanonicalSource(authoritySource, "authority_invalid");
  if (!authorityExact(authority, {
    mode: expectedMode,
    candidateSha: expectedCandidateSha,
    activationRunId: expectedActivationRunId,
    producerRunId: expectedProducerRunId,
    implementationSha: expectedImplementationSha,
    cleanupArmSha256,
  })) throw new Error("authority_invalid");
  const authoritySha256 = sha256(authoritySource);
  const observation = parseCanonicalSource(
    providerEvidenceSource,
    "provider_evidence_invalid",
  );
  if (!observationExact(observation, {
    candidateSha: expectedCandidateSha,
    activationRunId: expectedActivationRunId,
    producerRunId: expectedProducerRunId,
    implementationSha: expectedImplementationSha,
    authoritySha256,
  })) throw new Error("provider_evidence_invalid");
  const providerEvidenceSha256 = sha256(providerEvidenceSource);
  const attemptInventory = parseCanonicalSource(
    attemptInventorySource,
    "attempt_inventory_invalid",
  );
  if (!attemptInventoryExact(
    attemptInventory,
    expectedCandidateSha,
    expectedActivationRunId,
  )) throw new Error("attempt_inventory_invalid");
  if (!containmentHistoryAllowsTerminalState(
    attemptInventory,
    observation.state,
  )) throw new Error("containment_terminal_state_invalid");
  const attemptInventorySha256 = sha256(attemptInventorySource);
  const inventoryArmCount = attemptArmCount(attemptInventory);
  const closeout = parseCanonicalSource(closeoutSource, "closeout_invalid");
  if (!closeoutExact(closeout, {
    mode: expectedMode,
    candidateSha: expectedCandidateSha,
    activationRunId: expectedActivationRunId,
    producerRunId: expectedProducerRunId,
    implementationSha: expectedImplementationSha,
    cleanupArmSha256,
    authoritySha256,
    providerEvidenceSha256,
    attemptInventorySha256,
    attemptArmCount: inventoryArmCount,
  }) || closeout.state !== observation.state) {
    throw new Error("closeout_invalid");
  }
  return closeout;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 20) return null;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || values.has(key)) return null;
    values.set(key, value);
  }
  const args = {
    mode: values.get("--mode"),
    candidateSha: values.get("--candidate-sha"),
    activationRunId: values.get("--activation-run-id"),
    producerRunId: values.get("--producer-run-id"),
    implementationSha: values.get("--implementation-sha"),
    cleanupArmFile: values.get("--cleanup-arm-file"),
    authorityFile: values.get("--authority-file"),
    observationFile: values.get("--observation-file"),
    attemptInventoryFile: values.get("--attempt-inventory-file"),
    outputDirectory: values.get("--output-dir"),
  };
  return ["original", "reconcile"].includes(args.mode)
    && SHA.test(args.candidateSha ?? "")
    && RUN_ID.test(args.activationRunId ?? "")
    && RUN_ID.test(args.producerRunId ?? "")
    && SHA.test(args.implementationSha ?? "")
    && [args.cleanupArmFile, args.authorityFile, args.observationFile,
      args.attemptInventoryFile,
      args.outputDirectory].every((value) => path.isAbsolute(value ?? ""))
    ? args : null;
}

function writeExclusive(directory, leaf, source) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(path.join(directory, leaf), source, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export function finalizeAccountDeletionRehearsalCloseout(argv) {
  const args = parseArguments(argv);
  if (!args) throw new Error("argument_invalid");
  const cleanupArmSource = readCanonicalFile(
    args.cleanupArmFile,
    "cleanup_arm_invalid",
  );
  const cleanupArm = parseCanonicalSource(
    cleanupArmSource,
    "cleanup_arm_invalid",
  );
  if (!cleanupArmExact(
    cleanupArm,
    args.candidateSha,
    args.activationRunId,
  )) throw new Error("cleanup_arm_invalid");
  const cleanupArmSha256 = sha256(cleanupArmSource);
  const authoritySource = readCanonicalFile(
    args.authorityFile,
    "authority_invalid",
  );
  const authority = parseCanonicalSource(authoritySource, "authority_invalid");
  if (!authorityExact(authority, {
    mode: args.mode,
    candidateSha: args.candidateSha,
    activationRunId: args.activationRunId,
    producerRunId: args.producerRunId,
    implementationSha: args.implementationSha,
    cleanupArmSha256,
  })) throw new Error("authority_invalid");
  const authoritySha256 = sha256(authoritySource);
  const providerEvidenceSource = readCanonicalFile(
    args.observationFile,
    "provider_evidence_invalid",
  );
  const observation = parseCanonicalSource(
    providerEvidenceSource,
    "provider_evidence_invalid",
  );
  if (!observationExact(observation, {
    candidateSha: args.candidateSha,
    activationRunId: args.activationRunId,
    producerRunId: args.producerRunId,
    implementationSha: args.implementationSha,
    authoritySha256,
  })) throw new Error("provider_evidence_invalid");
  const attemptInventorySource = readCanonicalFile(
    args.attemptInventoryFile,
    "attempt_inventory_invalid",
  );
  const attemptInventory = parseCanonicalSource(
    attemptInventorySource,
    "attempt_inventory_invalid",
  );
  if (!attemptInventoryExact(
    attemptInventory,
    args.candidateSha,
    args.activationRunId,
  )) throw new Error("attempt_inventory_invalid");
  if (!containmentHistoryAllowsTerminalState(
    attemptInventory,
    observation.state,
  )) throw new Error("containment_terminal_state_invalid");
  const inventoryArmCount = attemptArmCount(attemptInventory);
  const closeout = canonical({
    schemaVersion: ACCOUNT_DELETION_REHEARSAL_CLOSEOUT_SCHEMA,
    repository: REPOSITORY,
    mode: args.mode,
    state: observation.state,
    candidateSha: args.candidateSha,
    activationRunId: args.activationRunId,
    producerRunId: args.producerRunId,
    recoveryRunId: args.mode === "reconcile" ? args.producerRunId : null,
    producerRunAttempt: 1,
    recoveryImplementationSha: args.implementationSha,
    lock: {
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      serviceId: SERVICE_ID,
      region: REGION,
      publicOrigin: PUBLIC_ORIGIN,
    },
    cleanupArmSha256,
    authoritySha256,
    providerEvidenceFilename: "provider-evidence.json",
    providerEvidenceSchema: OBSERVATION_SCHEMA,
    providerEvidenceSha256: sha256(providerEvidenceSource),
    attemptInventoryFilename: "attempt-inventory.json",
    attemptInventorySha256: sha256(attemptInventorySource),
    attemptArmCount: inventoryArmCount,
    cleanupObligationDisarmed: true,
    mutationCredentialExposed: false,
    secretMaterialIncluded: false,
  });
  writeExclusive(args.outputDirectory, "provider-evidence.json",
    providerEvidenceSource);
  writeExclusive(args.outputDirectory, "authority.json", authoritySource);
  writeExclusive(args.outputDirectory, "attempt-inventory.json",
    attemptInventorySource);
  writeExclusive(args.outputDirectory, "closeout.json", closeout);
  validateAccountDeletionRehearsalCloseoutBundle({
    closeoutSource: closeout,
    providerEvidenceSource,
    authoritySource,
    cleanupArmSource,
    attemptInventorySource,
    expectedMode: args.mode,
    expectedCandidateSha: args.candidateSha,
    expectedActivationRunId: args.activationRunId,
    expectedProducerRunId: args.producerRunId,
    expectedImplementationSha: args.implementationSha,
  });
  return {
    state: observation.state,
    closeoutSha256: sha256(closeout),
    providerEvidenceSha256: sha256(providerEvidenceSource),
    cleanupArmSha256,
    authoritySha256,
    attemptInventorySha256: sha256(attemptInventorySource),
    attemptArmCount: inventoryArmCount,
  };
}

export async function runFinalizeAccountDeletionRehearsalCloseout(
  argv = process.argv.slice(2),
  writeOutput = (source) => process.stdout.write(source),
) {
  try {
    const result = finalizeAccountDeletionRehearsalCloseout(argv);
    writeOutput(`${JSON.stringify({ ok: true, ...result })}\n`);
    return 0;
  } catch {
    writeOutput(`${JSON.stringify({ ok: false })}\n`);
    return 1;
  }
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runFinalizeAccountDeletionRehearsalCloseout();
}

export const accountDeletionRehearsalCloseoutInternals = {
  authorityExact,
  attemptInventoryExact,
  containmentHistoryAllowsTerminalState,
  canonical,
  checksExact,
  cleanupArmExact,
  closeoutExact,
  observationExact,
  parseArguments,
  stateProofExact,
};
