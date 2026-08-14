import crypto from "node:crypto";

import { canonicalPostgresBackupJson } from "../../src/lib/postgres-logical-backup.js";

export const EMERGENCY_CLEANUP_STATE_SCHEMA =
  "pintpath-production-promotion-recovery-emergency-cleanup-state/v1" as const;
export const EMERGENCY_CLEANUP_STATE_REF =
  "refs/heads/pintpath-production-promotion-recovery-emergency-cleanup-state" as const;
export const EMERGENCY_CLEANUP_REPOSITORY = "blackmagic30/Beer" as const;
export const EMERGENCY_CLEANUP_WORKFLOW_PATH =
  ".github/workflows/reconcile-production-promotion-recovery-emergency-cleanup.yml" as const;
export const ACTIVATION_WORKFLOW_PATH =
  ".github/workflows/activate-production-promotion-recovery.yml" as const;
export const RAILWAY_CLEANUP_POLICY_SHA256 =
  "4d1c22a4d5779f9383e133a1da8cfa40d10a6317343298210efc81e4f18403ef" as const;
export const SUPABASE_CLEANUP_POLICY_SHA256 =
  "fd3a45234a02ba3df8fadb6e2f36d1070a72be75eec792986f85abd74e5f6796" as const;

const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[1-9]\d{0,19}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const PROJECT_NAME = /^pintpath-disposable-restore-[a-z0-9][a-z0-9-]{0,79}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Json = Record<string, unknown>;

export interface EmergencyCleanupTarget {
  readonly candidateSha: string;
  readonly activationRunId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly inventorySha256: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceProjectInventorySha256: string;
  readonly supabaseProjectRef: string;
  readonly supabaseProjectName: string;
  readonly organizationSlugSha256: string;
  readonly destinationOriginSha256: string;
  readonly destinationRestoreAuthoritySha256: string;
}

export interface EmergencyCleanupArmVerification extends EmergencyCleanupTarget {
  readonly schemaVersion: 2;
  readonly kind: string;
  readonly ok: true;
  readonly armTransition: "initial" | "renewal";
  readonly armLineageIdSha256: string;
  readonly previousArmAuthoritySha256: string | null;
  readonly renewalSequence: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly authoritySha256: string;
  readonly authorityPublicKeySha256: string;
}

export interface EmergencyCleanupState extends EmergencyCleanupTarget {
  readonly schemaVersion: typeof EMERGENCY_CLEANUP_STATE_SCHEMA;
  readonly repository: typeof EMERGENCY_CLEANUP_REPOSITORY;
  readonly stateRef: typeof EMERGENCY_CLEANUP_STATE_REF;
  readonly slot: "production-promotion-recovery";
  readonly status: "open" | "disarmed";
  readonly sequence: number;
  readonly previousStateSha256: string | null;
  readonly armLineageIdSha256: string;
  readonly armAuthoritySha256Lineage: readonly string[];
  readonly currentArmAuthoritySha256: string;
  readonly currentArmAuthorityPublicKeySha256: string;
  readonly armRenewalSequence: number;
  readonly armExpiresAt: string;
  readonly railwayDeleteAcknowledgement: Json | null;
  readonly supabaseDeleteAcknowledgement: Json | null;
  readonly disarmTerminal: Json | null;
  readonly updatedAt: string;
  readonly stateSha256: string;
}

const DISARM_TERMINAL_KEYS = [
  "schemaVersion",
  "kind",
  "repository",
  "activationRunId",
  "candidateSha",
  "armLineageIdSha256",
  "armAuthoritySha256",
  "observedCleanupRunId",
  "railwayTerminalReceiptSha256",
  "supabaseTerminalReceiptSha256",
  "completedAt",
  "terminalSha256",
] as const;

function disarmTerminalExact(value: Json, state: EmergencyCleanupState) {
  const { terminalSha256, ...withoutHash } = value;
  return (
    exactKeys(value, DISARM_TERMINAL_KEYS) &&
    value.schemaVersion ===
      "pintpath-production-promotion-recovery-emergency-cleanup-disarm-terminal/v1" &&
    value.kind ===
      "pintpath-production-promotion-recovery-emergency-cleanup-disarm-terminal" &&
    value.repository === EMERGENCY_CLEANUP_REPOSITORY &&
    value.activationRunId === state.activationRunId &&
    value.candidateSha === state.candidateSha &&
    value.armLineageIdSha256 === state.armLineageIdSha256 &&
    value.armAuthoritySha256 === state.currentArmAuthoritySha256 &&
    RUN_ID.test(String(value.observedCleanupRunId)) &&
    SHA256.test(String(value.railwayTerminalReceiptSha256)) &&
    SHA256.test(String(value.supabaseTerminalReceiptSha256)) &&
    timestamp(value.completedAt) &&
    SHA256.test(String(terminalSha256)) &&
    emergencyCleanupSha256(canonicalPostgresBackupJson(withoutHash)) ===
      terminalSha256
  );
}

export class EmergencyCleanupStateError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EmergencyCleanupStateError";
  }
}

function fail(code: string): never {
  throw new EmergencyCleanupStateError(code);
}

export function emergencyCleanupSha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function targetExact(value: Json): value is Json & EmergencyCleanupTarget {
  return (
    SHA.test(String(value.candidateSha)) &&
    RUN_ID.test(String(value.activationRunId)) &&
    UUID.test(String(value.projectId)) &&
    PROJECT_NAME.test(String(value.projectName)) &&
    UUID.test(String(value.environmentId)) &&
    value.environmentName === value.projectName &&
    SHA256.test(String(value.inventorySha256)) &&
    UUID.test(String(value.workspaceId)) &&
    typeof value.workspaceName === "string" &&
    value.workspaceName.length > 0 &&
    value.workspaceName.length <= 100 &&
    value.workspaceName === value.workspaceName.trim() &&
    !/[\r\n\0]/.test(value.workspaceName) &&
    SHA256.test(String(value.workspaceProjectInventorySha256)) &&
    PROJECT_REF.test(String(value.supabaseProjectRef)) &&
    value.supabaseProjectName === value.projectName &&
    SHA256.test(String(value.organizationSlugSha256)) &&
    SHA256.test(String(value.destinationOriginSha256)) &&
    SHA256.test(String(value.destinationRestoreAuthoritySha256))
  );
}

const TARGET_KEYS = [
  "candidateSha",
  "activationRunId",
  "projectId",
  "projectName",
  "environmentId",
  "environmentName",
  "inventorySha256",
  "workspaceId",
  "workspaceName",
  "workspaceProjectInventorySha256",
  "supabaseProjectRef",
  "supabaseProjectName",
  "organizationSlugSha256",
  "destinationOriginSha256",
  "destinationRestoreAuthoritySha256",
] as const;

function sameTarget(
  left: EmergencyCleanupTarget,
  right: EmergencyCleanupTarget,
) {
  return TARGET_KEYS.every((key) => left[key] === right[key]);
}

export function parseArmVerification(
  source: string,
): EmergencyCleanupArmVerification {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail("arm_verification_invalid");
  }
  const keys = [
    "schemaVersion",
    "kind",
    "ok",
    ...TARGET_KEYS,
    "armTransition",
    "armLineageIdSha256",
    "previousArmAuthoritySha256",
    "renewalSequence",
    "issuedAt",
    "expiresAt",
    "authoritySha256",
    "authorityPublicKeySha256",
  ];
  if (
    !record(value) ||
    canonicalPostgresBackupJson(value) !== source ||
    !exactKeys(value, keys) ||
    value.schemaVersion !== 2 ||
    value.kind !==
      "pintpath-production-promotion-recovery-emergency-cleanup-arm-verification" ||
    value.ok !== true ||
    !targetExact(value) ||
    (value.armTransition !== "initial" && value.armTransition !== "renewal") ||
    !SHA256.test(String(value.armLineageIdSha256)) ||
    !Number.isSafeInteger(value.renewalSequence) ||
    Number(value.renewalSequence) < 0 ||
    !timestamp(value.issuedAt) ||
    !timestamp(value.expiresAt) ||
    !SHA256.test(String(value.authoritySha256)) ||
    !SHA256.test(String(value.authorityPublicKeySha256)) ||
    (value.armTransition === "initial" &&
      (value.previousArmAuthoritySha256 !== null ||
        value.renewalSequence !== 0)) ||
    (value.armTransition === "renewal" &&
      !SHA256.test(String(value.previousArmAuthoritySha256)))
  )
    fail("arm_verification_invalid");
  return value as unknown as EmergencyCleanupArmVerification;
}

const STATE_KEYS = [
  "schemaVersion",
  "repository",
  "stateRef",
  "slot",
  "status",
  "sequence",
  "previousStateSha256",
  ...TARGET_KEYS,
  "armLineageIdSha256",
  "armAuthoritySha256Lineage",
  "currentArmAuthoritySha256",
  "currentArmAuthorityPublicKeySha256",
  "armRenewalSequence",
  "armExpiresAt",
  "railwayDeleteAcknowledgement",
  "supabaseDeleteAcknowledgement",
  "disarmTerminal",
  "updatedAt",
  "stateSha256",
] as const;

export function parseEmergencyCleanupState(
  source: string,
): EmergencyCleanupState {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail("state_invalid");
  }
  if (!record(value) || canonicalPostgresBackupJson(value) !== source)
    fail("state_invalid");
  const { stateSha256, ...withoutHash } = value;
  if (
    !exactKeys(value, STATE_KEYS) ||
    value.schemaVersion !== EMERGENCY_CLEANUP_STATE_SCHEMA ||
    value.repository !== EMERGENCY_CLEANUP_REPOSITORY ||
    value.stateRef !== EMERGENCY_CLEANUP_STATE_REF ||
    value.slot !== "production-promotion-recovery" ||
    (value.status !== "open" && value.status !== "disarmed") ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    (value.previousStateSha256 !== null &&
      !SHA256.test(String(value.previousStateSha256))) ||
    !targetExact(value) ||
    !SHA256.test(String(value.armLineageIdSha256)) ||
    !Array.isArray(value.armAuthoritySha256Lineage) ||
    value.armAuthoritySha256Lineage.length < 1 ||
    value.armAuthoritySha256Lineage.length > 10_000 ||
    value.armAuthoritySha256Lineage.some(
      (entry) => !SHA256.test(String(entry)),
    ) ||
    new Set(value.armAuthoritySha256Lineage).size !==
      value.armAuthoritySha256Lineage.length ||
    value.currentArmAuthoritySha256 !==
      value.armAuthoritySha256Lineage[
        value.armAuthoritySha256Lineage.length - 1
      ] ||
    !SHA256.test(String(value.currentArmAuthorityPublicKeySha256)) ||
    !Number.isSafeInteger(value.armRenewalSequence) ||
    Number(value.armRenewalSequence) !==
      value.armAuthoritySha256Lineage.length - 1 ||
    !timestamp(value.armExpiresAt) ||
    (value.railwayDeleteAcknowledgement !== null &&
      !record(value.railwayDeleteAcknowledgement)) ||
    (value.supabaseDeleteAcknowledgement !== null &&
      !record(value.supabaseDeleteAcknowledgement)) ||
    (value.disarmTerminal !== null && !record(value.disarmTerminal)) ||
    (value.status === "open" && value.disarmTerminal !== null) ||
    (value.status === "disarmed" && value.disarmTerminal === null) ||
    !timestamp(value.updatedAt) ||
    !SHA256.test(String(stateSha256)) ||
    emergencyCleanupSha256(canonicalPostgresBackupJson(withoutHash)) !==
      stateSha256
  )
    fail("state_invalid");
  const checked = value as unknown as EmergencyCleanupState;
  if (
    checked.disarmTerminal &&
    !disarmTerminalExact(checked.disarmTerminal, checked)
  )
    fail("state_invalid");
  if (checked.railwayDeleteAcknowledgement)
    verifyProviderTerminal(
      checked.railwayDeleteAcknowledgement,
      "railway",
      checked,
      true,
    );
  if (checked.supabaseDeleteAcknowledgement)
    verifyProviderTerminal(
      checked.supabaseDeleteAcknowledgement,
      "supabase",
      checked,
      true,
    );
  return checked;
}

function receiptSelfHash(receipt: Json): boolean {
  const { receiptSha256, ...withoutHash } = receipt;
  return (
    SHA256.test(String(receiptSha256)) &&
    emergencyCleanupSha256(canonicalPostgresBackupJson(withoutHash)) ===
      receiptSha256
  );
}

const RAILWAY_RECEIPT_KEYS = [
  "schemaVersion",
  "kind",
  "ok",
  "outcome",
  "completedAt",
  "candidateSha",
  "observedCleanupRunId",
  "signedActivationRunId",
  "cleanupWorkflowPath",
  "projectId",
  "projectName",
  "environmentId",
  "environmentName",
  "expectedInventorySha256",
  "workspaceId",
  "workspaceName",
  "expectedWorkspaceProjectInventorySha256",
  "emergencyCleanupArmAuthoritySha256",
  "policySha256",
  "teardownAuthoritySha256",
  "teardownAuthorityPublicKeySha256",
  "teardownAuthorityReviewerIdSha256",
  "intentSha256",
  "preflightInventorySha256",
  "postflightInventorySha256",
  "preflightWorkspaceProjectInventorySha256",
  "postflightWorkspaceProjectInventorySha256",
  "deleteAttempts",
  "retryAllowed",
  "checks",
  "receiptSha256",
] as const;
const RAILWAY_CHECK_KEYS = [
  "policyExact",
  "githubAuthorityExact",
  "targetNotProtected",
  "signedAuthorityExact",
  "credentialsSeparatedExact",
  "metadataAuthoritiesAgree",
  "completeInventoryExact",
  "signedServiceInventoryExact",
  "workspaceAuthoritiesExact",
  "completeWorkspaceInventoryExact",
  "signedWorkspaceInventoryExact",
  "durableIntentExact",
  "deleteAttemptedAtMostOnce",
  "acknowledgementExact",
  "postflightAttempted",
  "targetAbsentExact",
  "terminalEvidenceExact",
] as const;
const SUPABASE_RECEIPT_KEYS = [
  "schemaVersion",
  "kind",
  "ok",
  "executorState",
  "outcome",
  "completedAt",
  "candidateSha",
  "observedCleanupRunId",
  "signedActivationRunId",
  "cleanupWorkflowPath",
  "projectRef",
  "projectName",
  "destinationOriginSha256",
  "organizationSlugSha256",
  "targetRailwayProjectId",
  "targetRailwayEnvironmentId",
  "cleanupMode",
  "destinationRestoreAuthoritySha256",
  "emergencyCleanupArmAuthoritySha256",
  "purgeReceiptSha256",
  "policySha256",
  "teardownAuthoritySha256",
  "teardownAuthorityPublicKeySha256",
  "teardownAuthorityReviewerIdSha256",
  "intentSha256",
  "preflightInventorySha256",
  "postflightInventorySha256",
  "deleteAttempts",
  "retryAllowed",
  "checks",
  "receiptSha256",
] as const;
const SUPABASE_CHECK_KEYS = [
  "policyExact",
  "githubAuthorityExact",
  "targetNotProtected",
  "orderlyPurgeEvidenceExactOrNotRequired",
  "signedAuthorityExact",
  "credentialsSeparatedExact",
  "preflightInventoryExact",
  "targetMetadataExact",
  "durableIntentExact",
  "deleteAttemptedAtMostOnce",
  "acknowledgementExact",
  "postflightAttempted",
  "targetAbsentExact",
  "terminalEvidenceExact",
] as const;

export function verifyProviderTerminal(
  terminal: unknown,
  provider: "railway" | "supabase",
  state: EmergencyCleanupState,
  requireDeleteAcknowledgement: boolean,
): Json {
  if (!record(terminal) || !exactKeys(terminal, ["schemaVersion", "receipt"]))
    fail("terminal_invalid");
  const receipt = terminal.receipt;
  if (!record(receipt) || !record(receipt.checks) || !receiptSelfHash(receipt))
    fail("terminal_invalid");
  const fromActivation =
    receipt.cleanupWorkflowPath === ACTIVATION_WORKFLOW_PATH;
  const fromEmergencyController =
    receipt.cleanupWorkflowPath === EMERGENCY_CLEANUP_WORKFLOW_PATH;
  const common =
    receipt.ok === true &&
    receipt.schemaVersion === 1 &&
    receipt.candidateSha === state.candidateSha &&
    receipt.signedActivationRunId === state.activationRunId &&
    RUN_ID.test(String(receipt.observedCleanupRunId)) &&
    (fromActivation || fromEmergencyController) &&
    (!fromActivation ||
      receipt.observedCleanupRunId === receipt.signedActivationRunId) &&
    state.armAuthoritySha256Lineage.includes(
      String(receipt.emergencyCleanupArmAuthoritySha256),
    ) &&
    receipt.retryAllowed === false &&
    receipt.checks.policyExact === true &&
    receipt.checks.githubAuthorityExact === true &&
    receipt.checks.targetNotProtected === true &&
    receipt.checks.signedAuthorityExact === true &&
    receipt.checks.credentialsSeparatedExact === true &&
    receipt.checks.postflightAttempted === true &&
    receipt.checks.targetAbsentExact === true &&
    receipt.checks.terminalEvidenceExact === true &&
    timestamp(receipt.completedAt);
  if (!common) fail("terminal_invalid");
  const acknowledged =
    receipt.outcome === "deleted" &&
    receipt.deleteAttempts === 1 &&
    receipt.checks.acknowledgementExact === true;
  const reconciled =
    fromEmergencyController &&
    receipt.outcome === "reconciled_from_prior_ack" &&
    receipt.deleteAttempts === 0 &&
    receipt.checks.acknowledgementExact === true;
  if (
    requireDeleteAcknowledgement ? !acknowledged : !acknowledged && !reconciled
  )
    fail("terminal_invalid");
  if (provider === "railway") {
    if (
      !exactKeys(receipt, RAILWAY_RECEIPT_KEYS) ||
      !exactKeys(receipt.checks, RAILWAY_CHECK_KEYS) ||
      terminal.schemaVersion !==
        "pintpath-production-recovery-railway-teardown-terminal/v1" ||
      receipt.kind !== "pintpath-production-recovery-railway-teardown" ||
      receipt.policySha256 !== RAILWAY_CLEANUP_POLICY_SHA256 ||
      receipt.projectId !== state.projectId ||
      receipt.projectName !== state.projectName ||
      receipt.environmentId !== state.environmentId ||
      receipt.environmentName !== state.environmentName ||
      receipt.expectedInventorySha256 !== state.inventorySha256 ||
      receipt.workspaceId !== state.workspaceId ||
      receipt.workspaceName !== state.workspaceName ||
      receipt.expectedWorkspaceProjectInventorySha256 !==
        state.workspaceProjectInventorySha256 ||
      receipt.checks.workspaceAuthoritiesExact !== true ||
      receipt.checks.completeWorkspaceInventoryExact !== true ||
      receipt.checks.signedWorkspaceInventoryExact !== true
    )
      fail("terminal_invalid");
  } else if (
    !exactKeys(receipt, SUPABASE_RECEIPT_KEYS) ||
    !exactKeys(receipt.checks, SUPABASE_CHECK_KEYS) ||
    terminal.schemaVersion !==
      "pintpath-protected-disposable-supabase-project-teardown-terminal/v1" ||
    receipt.kind !==
      "pintpath-protected-disposable-supabase-project-teardown" ||
    receipt.policySha256 !== SUPABASE_CLEANUP_POLICY_SHA256 ||
    receipt.projectRef !== state.supabaseProjectRef ||
    receipt.projectName !== state.supabaseProjectName ||
    receipt.destinationOriginSha256 !== state.destinationOriginSha256 ||
    receipt.organizationSlugSha256 !== state.organizationSlugSha256 ||
    receipt.targetRailwayProjectId !== state.projectId ||
    receipt.targetRailwayEnvironmentId !== state.environmentId ||
    (fromEmergencyController
      ? receipt.cleanupMode !== "emergency" ||
        receipt.purgeReceiptSha256 !== null
      : (receipt.cleanupMode !== "emergency" &&
          receipt.cleanupMode !== "orderly") ||
        (receipt.cleanupMode === "emergency" &&
          receipt.purgeReceiptSha256 !== null) ||
        (receipt.cleanupMode === "orderly" &&
          !SHA256.test(String(receipt.purgeReceiptSha256)))) ||
    receipt.destinationRestoreAuthoritySha256 !==
      state.destinationRestoreAuthoritySha256 ||
    receipt.checks.orderlyPurgeEvidenceExactOrNotRequired !== true ||
    receipt.checks.preflightInventoryExact !== true ||
    receipt.checks.targetMetadataExact !== true
  )
    fail("terminal_invalid");
  return terminal;
}

function withStateHash(value: Omit<EmergencyCleanupState, "stateSha256">) {
  return {
    ...value,
    stateSha256: emergencyCleanupSha256(canonicalPostgresBackupJson(value)),
  } as EmergencyCleanupState;
}

export function initializeEmergencyCleanupState(
  arm: EmergencyCleanupArmVerification,
  now: string,
  prior: EmergencyCleanupState | null = null,
): EmergencyCleanupState {
  if (
    arm.armTransition !== "initial" ||
    !timestamp(now) ||
    (prior !== null && prior.status !== "disarmed")
  )
    fail("transition_invalid");
  return withStateHash({
    schemaVersion: EMERGENCY_CLEANUP_STATE_SCHEMA,
    repository: EMERGENCY_CLEANUP_REPOSITORY,
    stateRef: EMERGENCY_CLEANUP_STATE_REF,
    slot: "production-promotion-recovery",
    status: "open",
    sequence: prior ? prior.sequence + 1 : 1,
    previousStateSha256: prior?.stateSha256 ?? null,
    ...(Object.fromEntries(
      TARGET_KEYS.map((key) => [key, arm[key]]),
    ) as unknown as EmergencyCleanupTarget),
    armLineageIdSha256: arm.armLineageIdSha256,
    armAuthoritySha256Lineage: [arm.authoritySha256],
    currentArmAuthoritySha256: arm.authoritySha256,
    currentArmAuthorityPublicKeySha256: arm.authorityPublicKeySha256,
    armRenewalSequence: 0,
    armExpiresAt: arm.expiresAt,
    railwayDeleteAcknowledgement: null,
    supabaseDeleteAcknowledgement: null,
    disarmTerminal: null,
    updatedAt: now,
  });
}

export function renewEmergencyCleanupState(
  current: EmergencyCleanupState,
  arm: EmergencyCleanupArmVerification,
  now: string,
): EmergencyCleanupState {
  if (
    current.status !== "open" ||
    arm.armTransition !== "renewal" ||
    !sameTarget(current, arm) ||
    arm.armLineageIdSha256 !== current.armLineageIdSha256 ||
    arm.previousArmAuthoritySha256 !== current.currentArmAuthoritySha256 ||
    arm.renewalSequence !== current.armRenewalSequence + 1 ||
    arm.authorityPublicKeySha256 !==
      current.currentArmAuthorityPublicKeySha256 ||
    current.armAuthoritySha256Lineage.includes(arm.authoritySha256) ||
    !timestamp(now)
  )
    fail("transition_invalid");
  const { stateSha256: previousStateSha256, ...base } = current;
  return withStateHash({
    ...base,
    sequence: current.sequence + 1,
    previousStateSha256,
    armAuthoritySha256Lineage: [
      ...current.armAuthoritySha256Lineage,
      arm.authoritySha256,
    ],
    currentArmAuthoritySha256: arm.authoritySha256,
    armRenewalSequence: arm.renewalSequence,
    armExpiresAt: arm.expiresAt,
    updatedAt: now,
  });
}

export function assertEmergencyCleanupRenewalSuccessor(input: {
  readonly previous: EmergencyCleanupState;
  readonly current: EmergencyCleanupState;
  readonly arm: EmergencyCleanupArmVerification;
}): EmergencyCleanupState {
  let expected: EmergencyCleanupState;
  try {
    expected = renewEmergencyCleanupState(
      input.previous,
      input.arm,
      input.current.updatedAt,
    );
  } catch {
    fail("renewal_successor_invalid");
  }
  if (
    canonicalPostgresBackupJson(expected) !==
    canonicalPostgresBackupJson(input.current)
  )
    fail("renewal_successor_invalid");
  return input.current;
}

function recoverProviderAcknowledgement(input: {
  readonly current: EmergencyCleanupState;
  readonly provider: "railway" | "supabase";
  readonly terminal: unknown;
  readonly expectedCleanupRunId: string;
}): Json {
  if (!RUN_ID.test(input.expectedCleanupRunId)) fail("transition_invalid");
  const terminal = verifyProviderTerminal(
    input.terminal,
    input.provider,
    input.current,
    true,
  );
  const receipt = terminal.receipt as Json;
  if (receipt.observedCleanupRunId !== input.expectedCleanupRunId)
    fail("transition_invalid");
  const existing =
    input.provider === "railway"
      ? input.current.railwayDeleteAcknowledgement
      : input.current.supabaseDeleteAcknowledgement;
  if (
    existing &&
    canonicalPostgresBackupJson(existing) !==
      canonicalPostgresBackupJson(terminal)
  )
    fail("transition_invalid");
  return terminal;
}

export function recoverEmergencyCleanupAcknowledgements(input: {
  readonly current: EmergencyCleanupState;
  readonly arm: EmergencyCleanupArmVerification;
  readonly railwayTerminal?: unknown;
  readonly railwayCleanupRunId?: string;
  readonly supabaseTerminal?: unknown;
  readonly supabaseCleanupRunId?: string;
  readonly now: string;
}): EmergencyCleanupState {
  const current = input.current;
  if (
    current.status !== "open" ||
    !sameTarget(current, input.arm) ||
    input.arm.authoritySha256 !== current.currentArmAuthoritySha256 ||
    input.arm.armLineageIdSha256 !== current.armLineageIdSha256 ||
    !timestamp(input.now) ||
    (!input.railwayTerminal && !input.supabaseTerminal) ||
    Boolean(input.railwayTerminal) !== Boolean(input.railwayCleanupRunId) ||
    Boolean(input.supabaseTerminal) !== Boolean(input.supabaseCleanupRunId)
  )
    fail("transition_invalid");
  const railwayAck = input.railwayTerminal
    ? recoverProviderAcknowledgement({
        current,
        provider: "railway",
        terminal: input.railwayTerminal,
        expectedCleanupRunId: input.railwayCleanupRunId!,
      })
    : current.railwayDeleteAcknowledgement;
  const supabaseAck = input.supabaseTerminal
    ? recoverProviderAcknowledgement({
        current,
        provider: "supabase",
        terminal: input.supabaseTerminal,
        expectedCleanupRunId: input.supabaseCleanupRunId!,
      })
    : current.supabaseDeleteAcknowledgement;
  const { stateSha256: previousStateSha256, ...base } = current;
  return withStateHash({
    ...base,
    sequence: current.sequence + 1,
    previousStateSha256,
    railwayDeleteAcknowledgement: railwayAck,
    supabaseDeleteAcknowledgement: supabaseAck,
    updatedAt: input.now,
  });
}

export function reconcileEmergencyCleanupState(input: {
  readonly current: EmergencyCleanupState;
  readonly arm: EmergencyCleanupArmVerification;
  readonly observedCleanupRunId: string;
  readonly priorRailwayTerminal?: unknown;
  readonly priorRailwayCleanupRunId?: string;
  readonly priorSupabaseTerminal?: unknown;
  readonly priorSupabaseCleanupRunId?: string;
  readonly railwayTerminal?: unknown;
  readonly supabaseTerminal?: unknown;
  readonly now: string;
}): EmergencyCleanupState {
  const current = input.current;
  if (
    current.status !== "open" ||
    !sameTarget(current, input.arm) ||
    input.arm.authoritySha256 !== current.currentArmAuthoritySha256 ||
    input.arm.armLineageIdSha256 !== current.armLineageIdSha256 ||
    !RUN_ID.test(input.observedCleanupRunId) ||
    !timestamp(input.now)
  )
    fail("transition_invalid");
  let railwayAck = current.railwayDeleteAcknowledgement;
  let supabaseAck = current.supabaseDeleteAcknowledgement;
  if (
    Boolean(input.priorRailwayTerminal) !==
      Boolean(input.priorRailwayCleanupRunId) ||
    Boolean(input.priorSupabaseTerminal) !==
      Boolean(input.priorSupabaseCleanupRunId)
  )
    fail("transition_invalid");
  if (input.priorRailwayTerminal)
    railwayAck = recoverProviderAcknowledgement({
      current,
      provider: "railway",
      terminal: input.priorRailwayTerminal,
      expectedCleanupRunId: input.priorRailwayCleanupRunId!,
    });
  if (input.priorSupabaseTerminal)
    supabaseAck = recoverProviderAcknowledgement({
      current,
      provider: "supabase",
      terminal: input.priorSupabaseTerminal,
      expectedCleanupRunId: input.priorSupabaseCleanupRunId!,
    });
  let railwayCurrent: Json | null = null;
  let supabaseCurrent: Json | null = null;
  if (input.railwayTerminal) {
    railwayCurrent = verifyProviderTerminal(
      input.railwayTerminal,
      "railway",
      current,
      false,
    );
    const receipt = railwayCurrent.receipt as Json;
    if (receipt.observedCleanupRunId !== input.observedCleanupRunId)
      fail("transition_invalid");
    if (receipt.outcome === "deleted") {
      if (
        railwayAck &&
        canonicalPostgresBackupJson(railwayAck) !==
          canonicalPostgresBackupJson(railwayCurrent)
      )
        fail("transition_invalid");
      railwayAck = railwayCurrent;
    }
    if (receipt.outcome === "reconciled_from_prior_ack" && !railwayAck)
      fail("transition_invalid");
  }
  if (input.supabaseTerminal) {
    supabaseCurrent = verifyProviderTerminal(
      input.supabaseTerminal,
      "supabase",
      current,
      false,
    );
    const receipt = supabaseCurrent.receipt as Json;
    if (receipt.observedCleanupRunId !== input.observedCleanupRunId)
      fail("transition_invalid");
    if (receipt.outcome === "deleted") {
      if (
        supabaseAck &&
        canonicalPostgresBackupJson(supabaseAck) !==
          canonicalPostgresBackupJson(supabaseCurrent)
      )
        fail("transition_invalid");
      supabaseAck = supabaseCurrent;
    }
    if (receipt.outcome === "reconciled_from_prior_ack" && !supabaseAck)
      fail("transition_invalid");
  }
  const disarmed = Boolean(
    railwayAck && supabaseAck && railwayCurrent && supabaseCurrent,
  );
  const disarmTerminalWithoutHash = disarmed
    ? {
        schemaVersion:
          "pintpath-production-promotion-recovery-emergency-cleanup-disarm-terminal/v1",
        kind: "pintpath-production-promotion-recovery-emergency-cleanup-disarm-terminal",
        repository: EMERGENCY_CLEANUP_REPOSITORY,
        activationRunId: current.activationRunId,
        candidateSha: current.candidateSha,
        armLineageIdSha256: current.armLineageIdSha256,
        armAuthoritySha256: current.currentArmAuthoritySha256,
        observedCleanupRunId: input.observedCleanupRunId,
        railwayTerminalReceiptSha256: (railwayCurrent!.receipt as Json)
          .receiptSha256,
        supabaseTerminalReceiptSha256: (supabaseCurrent!.receipt as Json)
          .receiptSha256,
        completedAt: input.now,
      }
    : null;
  const disarmTerminal = disarmTerminalWithoutHash
    ? {
        ...disarmTerminalWithoutHash,
        terminalSha256: emergencyCleanupSha256(
          canonicalPostgresBackupJson(disarmTerminalWithoutHash),
        ),
      }
    : null;
  const { stateSha256: previousStateSha256, ...base } = current;
  return withStateHash({
    ...base,
    status: disarmed ? "disarmed" : "open",
    sequence: current.sequence + 1,
    previousStateSha256,
    railwayDeleteAcknowledgement: railwayAck,
    supabaseDeleteAcknowledgement: supabaseAck,
    disarmTerminal,
    updatedAt: input.now,
  });
}

export function priorAcknowledgementFor(
  state: EmergencyCleanupState,
  provider: "railway" | "supabase",
): Json | null {
  if (state.status !== "open") fail("state_not_open");
  return provider === "railway"
    ? state.railwayDeleteAcknowledgement
    : state.supabaseDeleteAcknowledgement;
}
