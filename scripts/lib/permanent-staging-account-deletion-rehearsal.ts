import crypto from "node:crypto";

import { z } from "zod";

export const ACCOUNT_DELETION_REHEARSAL_POLICY_SCHEMA =
  "pintpath-permanent-staging-account-deletion-rehearsal-policy/v1" as const;
export const ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE =
  "GITHUB_ENVIRONMENT_PROTECTED" as const;
export const ACCOUNT_DELETION_REHEARSAL_POLICY_ID =
  "pintpath-permanent-staging-account-deletion-rehearsal" as const;

export const ACCOUNT_DELETION_REHEARSAL_LOCK = Object.freeze({
  projectId: "48d8c6cd-1c66-4148-874b-20877f48e1a5",
  stagingEnvironmentId: "a4e0f507-d6d3-4df9-a818-ad92c0071a35",
  forbiddenProductionEnvironmentId: "13dab015-df74-45c6-b26f-69323daea99a",
  serviceId: "6816c4a2-e392-4ee5-826f-2584cb599ec0",
  publicOrigin: "https://beer-staging.up.railway.app",
  stagingSupabaseOrigin: "https://bbfibbadwjxzrcdncavy.supabase.co",
  productionSupabaseOrigin: "https://jxpubqlmqnnqwadmjgyk.supabase.co",
  region: "asia-southeast1-eqsg3a",
  requiredGitRef: "refs/heads/main",
  concurrencyGroup: "pintpath-permanent-staging-key-rollout",
  providerMutationEnvironment: "permanent-staging-provider-mutation",
  deploymentEnvironment: "permanent-staging-deployment",
  scaleEnvironment: "permanent-staging-scale-evidence",
  railwayCliVersion: "5.32.0",
  railwayCliReleaseUrl:
    "https://github.com/railwayapp/cli/releases/download/v5.32.0/railway-v5.32.0-x86_64-unknown-linux-musl.tar.gz",
  railwayCliArchiveSha256:
    "cd69b2ecb556601751165d85ac31a5fbc38cff46397939356df28d2b96a005f5",
  railwayCliExecutableSha256:
    "27133cfc20bffc43b2f32c1638fa3c50eefc2f9d2d80301a93de34632ccb7a43",
} as const);

export const ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS = Object.freeze([
  "RESEND_TRANSACTIONAL_API_KEY",
  "RESEND_WEBHOOK_SIGNING_SECRET",
  "ACCOUNT_DELETION_NOTICE_ACTIVE_KEY_ID",
  "ACCOUNT_DELETION_NOTICE_KEYRING_JSON",
  "ACCOUNT_DELETION_NOTICE_FROM",
  "ACCOUNT_DELETION_NOTICE_REPLY_TO",
] as const);

export const ACCOUNT_DELETION_REHEARSAL_MARKERS = Object.freeze([
  "ACCOUNT_DELETION_REHEARSAL_ENABLED",
  "ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID",
  "ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID",
  "ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID",
  "ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL",
  "ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL",
  "ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT",
] as const);

export const ACCOUNT_DELETION_REHEARSAL_RUN_MARKER_PREFIX =
  "ACCOUNT_DELETION_REHEARSAL_RUN_" as const;

export function accountDeletionRehearsalRunMarkerName(runId: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(runId)) throw new Error("run_id_invalid");
  return `${ACCOUNT_DELETION_REHEARSAL_RUN_MARKER_PREFIX}${runId}`;
}

export const ACCOUNT_DELETION_REHEARSAL_ACTIVATION_VARIABLES = Object.freeze({
  SUPABASE_OAUTH_PROVIDERS: "google",
  ACCOUNT_DELETION_NOTICE_MODE: "resend",
  ACCOUNT_DELETION_REHEARSAL_ENABLED: "true",
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID:
    ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID:
    ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID:
    ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL:
    ACCOUNT_DELETION_REHEARSAL_LOCK.stagingSupabaseOrigin,
  ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL:
    ACCOUNT_DELETION_REHEARSAL_LOCK.productionSupabaseOrigin,
  ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT: "2",
} as const);

export const ACCOUNT_DELETION_REHEARSAL_CLEANUP_VARIABLES = Object.freeze({
  ACCOUNT_DELETION_NOTICE_MODE: "disabled",
  ACCOUNT_DELETION_REHEARSAL_ENABLED: null,
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_PROJECT_ID: null,
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_ENVIRONMENT_ID: null,
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_RAILWAY_SERVICE_ID: null,
  ACCOUNT_DELETION_REHEARSAL_EXPECTED_SUPABASE_URL: null,
  ACCOUNT_DELETION_REHEARSAL_PRODUCTION_SUPABASE_URL: null,
  ACCOUNT_DELETION_REHEARSAL_REPLICA_COUNT: null,
} as const);

export const ACCOUNT_DELETION_REHEARSAL_CLEANUP_PATCH = Object.freeze({
  services: Object.freeze({
    [ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId]: Object.freeze({
      variables: ACCOUNT_DELETION_REHEARSAL_CLEANUP_VARIABLES,
    }),
  }),
} as const);

export function accountDeletionRehearsalActivationVariablesForRun(
  runId: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    ...ACCOUNT_DELETION_REHEARSAL_ACTIVATION_VARIABLES,
    [accountDeletionRehearsalRunMarkerName(runId)]: "true",
  });
}

export function accountDeletionRehearsalCleanupVariablesForRun(
  runId: string,
): Readonly<Record<string, string | null>> {
  return Object.freeze({
    ...ACCOUNT_DELETION_REHEARSAL_CLEANUP_VARIABLES,
    [accountDeletionRehearsalRunMarkerName(runId)]: null,
  });
}

export function accountDeletionRehearsalCleanupPatchForRun(
  runId: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    services: Object.freeze({
      [ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId]: Object.freeze({
        variables: accountDeletionRehearsalCleanupVariablesForRun(runId),
      }),
    }),
  });
}

export const ACCOUNT_DELETION_REHEARSAL_STATES = Object.freeze([
  "SAFE_ONE",
  "CREDENTIALS_STORED_NO_DEPLOY",
  "SAFE_TWO",
  "ACTIVATION_STORED_NO_DEPLOY",
  "ACTIVATION_STORED_SAFE_TWO",
  "ACTIVE_TWO",
  "CLEANUP_STORED_NO_DEPLOY",
  "CLEANUP_STAGED_ACTIVE_TWO",
  "CLEANUP_STORED_ACTIVE_TWO",
  "SAFE_TWO_REDEPLOYED",
  "SAFE_ONE_FINAL",
  "QUARANTINED_ZERO_PENDING_CLEANUP",
  "QUARANTINED_ZERO",
] as const);
export type AccountDeletionRehearsalState =
  typeof ACCOUNT_DELETION_REHEARSAL_STATES[number];

export const ACCOUNT_DELETION_REHEARSAL_TRANSITIONS = Object.freeze({
  prepareTwo: Object.freeze({
    from: "SAFE_ONE",
    to: "SAFE_TWO",
  }),
  storeActivation: Object.freeze({
    from: "SAFE_TWO",
    to: "ACTIVATION_STORED_NO_DEPLOY",
  }),
  applyActive: Object.freeze({
    from: "ACTIVATION_STORED_NO_DEPLOY",
    to: "ACTIVE_TWO",
  }),
  storeCleanup: Object.freeze({
    from: "ACTIVE_TWO",
    to: "CLEANUP_STORED_NO_DEPLOY",
  }),
  applySafe: Object.freeze({
    from: "CLEANUP_STORED_NO_DEPLOY",
    to: "SAFE_TWO_REDEPLOYED",
  }),
  convergeOne: Object.freeze({
    from: "SAFE_TWO_REDEPLOYED",
    to: "SAFE_ONE_FINAL",
  }),
  quarantine: Object.freeze({
    from: "CLEANUP_STORED_NO_DEPLOY",
    to: "QUARANTINED_ZERO_PENDING_CLEANUP",
  }),
  cleanupQuarantine: Object.freeze({
    from: "QUARANTINED_ZERO_PENDING_CLEANUP",
    to: "QUARANTINED_ZERO",
  }),
} as const);

export const ACCOUNT_DELETION_REHEARSAL_ATTEMPT_ARM_SCHEMA =
  "pintpath-account-deletion-rehearsal-attempt-arm/v1" as const;

export const ACCOUNT_DELETION_REHEARSAL_ATTEMPT_OPERATIONS = Object.freeze([
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
] as const);
export type AccountDeletionRehearsalAttemptOperation =
  typeof ACCOUNT_DELETION_REHEARSAL_ATTEMPT_OPERATIONS[number];

export interface AccountDeletionRehearsalAttemptSnapshot {
  readonly rowNames: readonly string[];
  readonly replicas: number;
  readonly deploymentId: string;
  readonly snapshotId: string;
  readonly candidateSha: string;
  readonly imageDigest: string;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly instances: readonly { readonly id: string; readonly status: string }[];
}

export interface AccountDeletionRehearsalAttemptArm {
  readonly schemaVersion: typeof ACCOUNT_DELETION_REHEARSAL_ATTEMPT_ARM_SCHEMA;
  readonly executorState: typeof ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE;
  readonly operation: AccountDeletionRehearsalAttemptOperation;
  readonly candidateSha: string;
  readonly activationRunId: string;
  readonly githubRunId: string;
  readonly projectId: typeof ACCOUNT_DELETION_REHEARSAL_LOCK.projectId;
  readonly environmentId:
    typeof ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId;
  readonly serviceId: typeof ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId;
  readonly authoritySha256: string;
  readonly prerequisiteSha256: string | null;
  readonly providerSnapshotSha256: string;
  readonly providerInvariantSha256: string;
  readonly maximumAttempts: 1;
  readonly retryAllowed: false;
  readonly mutationCredentialExposed: false;
  readonly secretMaterialIncluded: false;
}

export function accountDeletionRehearsalAttemptSnapshotSha256(
  snapshot: AccountDeletionRehearsalAttemptSnapshot,
): string {
  return sha256Hex(canonicalJson({
    rowNames: [...snapshot.rowNames].sort(),
    replicas: snapshot.replicas,
    deploymentId: snapshot.deploymentId,
    snapshotId: snapshot.snapshotId,
    candidateSha: snapshot.candidateSha,
    imageDigest: snapshot.imageDigest,
    patch: snapshot.patch,
    instances: [...snapshot.instances].sort((left, right) =>
      left.id.localeCompare(right.id)),
  }));
}

export function accountDeletionRehearsalAttemptInvariantSha256(
  snapshot: AccountDeletionRehearsalAttemptSnapshot,
): string {
  return sha256Hex(canonicalJson({
    rowNames: [...snapshot.rowNames].sort(),
    deploymentId: snapshot.deploymentId,
    snapshotId: snapshot.snapshotId,
    candidateSha: snapshot.candidateSha,
    imageDigest: snapshot.imageDigest,
    patch: snapshot.patch,
  }));
}

export function createAccountDeletionRehearsalAttemptArm(input: {
  readonly operation: AccountDeletionRehearsalAttemptOperation;
  readonly candidateSha: string;
  readonly activationRunId: string;
  readonly githubRunId: string;
  readonly authoritySource: string;
  readonly prerequisiteSource: string | null;
  readonly snapshot: AccountDeletionRehearsalAttemptSnapshot;
}): AccountDeletionRehearsalAttemptArm {
  return Object.freeze({
    schemaVersion: ACCOUNT_DELETION_REHEARSAL_ATTEMPT_ARM_SCHEMA,
    executorState: ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE,
    operation: input.operation,
    candidateSha: input.candidateSha,
    activationRunId: input.activationRunId,
    githubRunId: input.githubRunId,
    projectId: ACCOUNT_DELETION_REHEARSAL_LOCK.projectId,
    environmentId: ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
    serviceId: ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId,
    authoritySha256: sha256Hex(input.authoritySource),
    prerequisiteSha256: input.prerequisiteSource === null
      ? null : sha256Hex(input.prerequisiteSource),
    providerSnapshotSha256:
      accountDeletionRehearsalAttemptSnapshotSha256(input.snapshot),
    providerInvariantSha256:
      accountDeletionRehearsalAttemptInvariantSha256(input.snapshot),
    maximumAttempts: 1,
    retryAllowed: false,
    mutationCredentialExposed: false,
    secretMaterialIncluded: false,
  });
}

export function parseAccountDeletionRehearsalAttemptArm(
  source: string,
  expected: {
    readonly operation: AccountDeletionRehearsalAttemptOperation;
    readonly candidateSha: string;
    readonly activationRunId: string;
    readonly githubRunId: string;
    readonly authoritySource: string;
    readonly prerequisiteSource: string | null;
    readonly contentSha256: string;
  },
): AccountDeletionRehearsalAttemptArm | null {
  if (Buffer.byteLength(source, "utf8") > 128 * 1024 || source.includes("\0")
    || sha256Hex(source) !== expected.contentSha256) return null;
  try {
    const value = JSON.parse(source) as unknown;
    if (!record(value)
      || value.schemaVersion !== ACCOUNT_DELETION_REHEARSAL_ATTEMPT_ARM_SCHEMA
      || value.executorState !== ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE
      || value.operation !== expected.operation
      || value.candidateSha !== expected.candidateSha
      || value.activationRunId !== expected.activationRunId
      || value.githubRunId !== expected.githubRunId
      || value.projectId !== ACCOUNT_DELETION_REHEARSAL_LOCK.projectId
      || value.environmentId !== ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId
      || value.serviceId !== ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId
      || value.authoritySha256 !== sha256Hex(expected.authoritySource)
      || value.prerequisiteSha256 !== (expected.prerequisiteSource === null
        ? null : sha256Hex(expected.prerequisiteSource))
      || !sha256ValueIsExact(value.providerSnapshotSha256)
      || !sha256ValueIsExact(value.providerInvariantSha256)
      || value.maximumAttempts !== 1 || value.retryAllowed !== false
      || value.mutationCredentialExposed !== false
      || value.secretMaterialIncluded !== false
      || Object.keys(value).length !== 17) return null;
    return value as unknown as AccountDeletionRehearsalAttemptArm;
  } catch {
    return null;
  }
}

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const policySchema = z.object({
  schemaVersion: z.literal(ACCOUNT_DELETION_REHEARSAL_POLICY_SCHEMA),
  policyId: z.literal(ACCOUNT_DELETION_REHEARSAL_POLICY_ID),
  activationState: z.literal(ACCOUNT_DELETION_REHEARSAL_EXECUTOR_STATE),
  projectId: z.literal(ACCOUNT_DELETION_REHEARSAL_LOCK.projectId),
  stagingEnvironmentId: z.literal(
    ACCOUNT_DELETION_REHEARSAL_LOCK.stagingEnvironmentId,
  ),
  forbiddenProductionEnvironmentId: z.literal(
    ACCOUNT_DELETION_REHEARSAL_LOCK.forbiddenProductionEnvironmentId,
  ),
  serviceId: z.literal(ACCOUNT_DELETION_REHEARSAL_LOCK.serviceId),
  publicOrigin: z.literal(ACCOUNT_DELETION_REHEARSAL_LOCK.publicOrigin),
  stagingSupabaseOrigin: z.literal(
    ACCOUNT_DELETION_REHEARSAL_LOCK.stagingSupabaseOrigin,
  ),
  productionSupabaseOrigin: z.literal(
    ACCOUNT_DELETION_REHEARSAL_LOCK.productionSupabaseOrigin,
  ),
  region: z.literal(ACCOUNT_DELETION_REHEARSAL_LOCK.region),
  requiredGitRef: z.literal(ACCOUNT_DELETION_REHEARSAL_LOCK.requiredGitRef),
  concurrencyGroup: z.literal(
    ACCOUNT_DELETION_REHEARSAL_LOCK.concurrencyGroup,
  ),
  githubEnvironments: z.object({
    providerMutation: z.literal(
      ACCOUNT_DELETION_REHEARSAL_LOCK.providerMutationEnvironment,
    ),
    deployment: z.literal(
      ACCOUNT_DELETION_REHEARSAL_LOCK.deploymentEnvironment,
    ),
    scale: z.literal(ACCOUNT_DELETION_REHEARSAL_LOCK.scaleEnvironment),
  }).strict(),
  railwayCli: z.object({
    version: z.literal(ACCOUNT_DELETION_REHEARSAL_LOCK.railwayCliVersion),
    releaseUrl: z.literal(
      ACCOUNT_DELETION_REHEARSAL_LOCK.railwayCliReleaseUrl,
    ),
    archiveSha256: z.literal(
      ACCOUNT_DELETION_REHEARSAL_LOCK.railwayCliArchiveSha256,
    ),
    executableSha256: z.literal(
      ACCOUNT_DELETION_REHEARSAL_LOCK.railwayCliExecutableSha256,
    ),
  }).strict(),
  credentialRowsRequiredBeforeActivation: z.tuple(
    ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS.map((value) => z.literal(value)) as [
      z.ZodLiteral<string>,
      ...z.ZodLiteral<string>[],
    ],
  ),
  activationVariables: z.record(z.string(), z.string()),
  cleanupVariables: z.record(z.string(), z.string().nullable()),
  intervalPolicy: z.object({
    variable: z.literal("ACCOUNT_DELETION_NOTICE_CHECK_INTERVAL_MINUTES"),
    allowedStoredValues: z.tuple([z.null(), z.literal("5")]),
  }).strict(),
  runMarkerPrefix: z.literal(ACCOUNT_DELETION_REHEARSAL_RUN_MARKER_PREFIX),
  replicas: z.object({
    safeInitial: z.literal(1),
    rehearsal: z.literal(2),
    safeFinal: z.literal(1),
    quarantine: z.literal(0),
  }).strict(),
  runtimeRoutes: z.tuple([
    z.literal("/health"),
    z.literal("/startup"),
    z.literal("/ready"),
  ]),
  stateMachine: z.tuple(
    ACCOUNT_DELETION_REHEARSAL_STATES.map((value) => z.literal(value)) as [
      z.ZodLiteral<string>,
      ...z.ZodLiteral<string>[],
    ],
  ),
  writeContract: z.object({
    maximumAttemptsPerTransition: z.literal(1),
    automaticRetriesAllowed: z.literal(false),
    activationMutation: z.literal("variableCollectionUpsert"),
    activationSkipDeploys: z.literal(true),
    cleanupStageMutation: z.literal("environmentStageChanges"),
    cleanupStageMerge: z.literal(false),
    cleanupCommitMutation: z.literal("environmentPatchCommitStaged"),
    cleanupCommitSkipDeploys: z.literal(true),
    deploymentMutation: z.literal("railway redeploy"),
    scaleMutation: z.literal("railway service scale"),
    scaleOutPrerequisite: z.literal("durable cleanup arm"),
    convergeOnePrerequisite: z.literal("exact safe redeploy terminal"),
    sourceUploadAllowed: z.literal(false),
    quarantineMutation: z.literal("railway service scale"),
    productionMutationAllowed: z.literal(false),
  }).strict(),
  failurePolicy: z.object({
    cleanupRunsUnconditionally: z.literal(true),
    safeRedeployRunsUnconditionally: z.literal(true),
    cleanupAuthorityBoundToOriginalActivationRun: z.literal(true),
    cleanupMayProceedAfterMainAdvances: z.literal(true),
    safeTerminalRequiredBeforeScaleToOne: z.literal(true),
    uncertainCleanupOrSafeRedeployAction: z.literal("QUARANTINE_ZERO"),
    quarantineRestorationRequiresReadOnlySafeReconciliation: z.literal(true),
    activationStoredSafeTwoAction: z.literal("RECONCILE_CLEANUP"),
    cleanupStoredActiveTwoWithoutApplySafeAttempt: z.literal("APPLY_SAFE"),
    cleanupStoredActiveTwoWithApplySafeAttempt: z.literal("QUARANTINE_ZERO"),
    cleanupStagedActiveTwoWithoutReconcileAttempt:
      z.literal("RECONCILE_CLEANUP"),
    cleanupStagedActiveTwoWithReconcileAttempt: z.literal("QUARANTINE_ZERO"),
    containedZeroCleanupOperation: z.literal("cleanup-contained-zero"),
    containedZeroCleanupRequiresZeroInstances: z.literal(true),
    containedZeroCleanupMaximumAttempts: z.literal(1),
    containedZeroCleanupExhaustedAction: z.literal("MANUAL_FAIL_CLOSED"),
    quarantineAttemptOperations: z.tuple([
      z.literal("quarantine-zero"),
      z.literal("quarantine-zero-retry-1"),
      z.literal("quarantine-zero-retry-2"),
    ]),
    quarantineGlobalMaximumAttempts: z.literal(3),
    quarantineRetriesRequireFreshExactNonterminalObservation: z.literal(true),
    quarantineLadderExhaustedAction: z.literal("MANUAL_FAIL_CLOSED"),
    nonterminalObservationStates: z.tuple([
      z.literal("SAFE_ONE_FINAL"),
      z.literal("ACTIVATION_STORED_SAFE_TWO"),
      z.literal("ACTIVE_TWO"),
      z.literal("CLEANUP_STAGED_ACTIVE_TWO"),
      z.literal("CLEANUP_STORED_ACTIVE_TWO"),
      z.literal("CLEANUP_STORED_SAFE_TWO"),
    ]),
  }).strict(),
}).strict();

export type AccountDeletionRehearsalPolicy = z.infer<typeof policySchema>;

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function parseAccountDeletionRehearsalPolicy(
  source: string,
): AccountDeletionRehearsalPolicy | null {
  if (Buffer.byteLength(source, "utf8") > 64 * 1024 || source.includes("\0")) {
    return null;
  }
  try {
    const result = policySchema.safeParse(JSON.parse(source));
    if (!result.success) return null;
    if (
      canonicalJson(result.data.activationVariables)
        !== canonicalJson(ACCOUNT_DELETION_REHEARSAL_ACTIVATION_VARIABLES)
      || canonicalJson(result.data.cleanupVariables)
        !== canonicalJson(ACCOUNT_DELETION_REHEARSAL_CLEANUP_VARIABLES)
    ) return null;
    return result.data;
  } catch {
    return null;
  }
}

export function exactCleanupPatch(value: unknown, runId?: string): boolean {
  const expected = runId === undefined
    ? ACCOUNT_DELETION_REHEARSAL_CLEANUP_PATCH
    : accountDeletionRehearsalCleanupPatchForRun(runId);
  return canonicalJson(value) === canonicalJson(expected);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rowNamesSatisfyActivationPreflight(
  rowNames: readonly string[],
): boolean {
  const names = new Set(rowNames);
  return ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS.every((name) => names.has(name))
    && ACCOUNT_DELETION_REHEARSAL_MARKERS.every((name) => !names.has(name))
    && !rowNames.some((name) =>
      name.startsWith(ACCOUNT_DELETION_REHEARSAL_RUN_MARKER_PREFIX));
}

export function rowNamesSatisfyActivationStored(
  rowNames: readonly string[],
  runId?: string,
): boolean {
  const names = new Set(rowNames);
  const runMarkers = rowNames.filter((name) =>
    name.startsWith(ACCOUNT_DELETION_REHEARSAL_RUN_MARKER_PREFIX));
  return ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS.every((name) => names.has(name))
    && Object.keys(ACCOUNT_DELETION_REHEARSAL_ACTIVATION_VARIABLES)
      .every((name) => names.has(name))
    && (runId === undefined ? runMarkers.length === 0
      : runMarkers.length === 1
        && runMarkers[0] === accountDeletionRehearsalRunMarkerName(runId));
}

export function rowNamesSatisfyCleanupStored(
  rowNames: readonly string[],
): boolean {
  const names = new Set(rowNames);
  return ACCOUNT_DELETION_REHEARSAL_CREDENTIAL_ROWS.every((name) => names.has(name))
    && names.has("ACCOUNT_DELETION_NOTICE_MODE")
    && names.has("SUPABASE_OAUTH_PROVIDERS")
    && ACCOUNT_DELETION_REHEARSAL_MARKERS.every((name) => !names.has(name))
    && !rowNames.some((name) =>
      name.startsWith(ACCOUNT_DELETION_REHEARSAL_RUN_MARKER_PREFIX));
}

export function runtimeStateExact(
  route: "/health" | "/startup" | "/ready",
  value: unknown,
  candidateSha: string,
  expected: "active" | "safe",
): { readonly replicaIdSha256: string; readonly responseSha256: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  if (root.ok !== true || typeof root.data !== "object" || root.data === null) return null;
  const data = root.data as Record<string, unknown>;
  if (data.service !== "pint-path" || typeof data.deployment !== "object"
    || data.deployment === null || typeof data.automaticMaintenance !== "object"
    || data.automaticMaintenance === null) return null;
  const deployment = data.deployment as Record<string, unknown>;
  const maintenance = data.automaticMaintenance as Record<string, unknown>;
  if (
    deployment.commitSha !== candidateSha
    || deployment.environment !== "production"
    || typeof deployment.replicaIdSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(deployment.replicaIdSha256)
    // The surrounding permanent-staging worker remains intentionally active.
    // Rehearsal cleanup disables only the account-deletion coordinator; it must
    // not silently rewrite the independently attested global worker fence.
    || maintenance.enabled !== true
    || maintenance.candidateBound !== true
  ) return null;
  if (route !== "/health") {
    if (typeof data.dependencies !== "object" || data.dependencies === null) return null;
    const dependencies = data.dependencies as Record<string, unknown>;
    if (typeof dependencies.accountDeletionNotifications !== "object"
      || dependencies.accountDeletionNotifications === null) return null;
    const notices = dependencies.accountDeletionNotifications as Record<string, unknown>;
    if (route === "/startup") {
      if (
        notices.required !== (expected === "active")
        || notices.configured !== (expected === "active")
      ) return null;
    } else if (
      notices.required !== (expected === "active")
      || (expected === "active" && notices.operationalGateReady !== true)
      || (expected === "safe" && (
        notices.status !== "missing"
        || !record(notices.scheduler)
        || notices.scheduler.status !== "not_configured"
      ))
    ) return null;
  }
  return {
    replicaIdSha256: deployment.replicaIdSha256,
    responseSha256: sha256Hex(JSON.stringify(value)),
  };
}

export function sha256ValueIsExact(value: unknown): value is string {
  return typeof value === "string" && sha256.safeParse(value).success;
}

export function uuidValueIsExact(value: unknown): value is string {
  return typeof value === "string" && uuid.safeParse(value).success;
}
