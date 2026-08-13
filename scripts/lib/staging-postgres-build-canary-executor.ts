import crypto from "node:crypto";

import { STAGING_POSTGRES_BACKUP_CANARY_LOCK } from
  "../../src/lib/postgres-staging-backup-canary.js";

export const STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_SCHEMA =
  "pintpath-staging-postgres-build-canary-executor/v2" as const;
export const STAGING_POSTGRES_BUILD_CANARY_OPERATION =
  "staging-postgres-build-canary-upload" as const;
export const STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_STATE =
  "HARD_DISABLED_REVIEW_REQUIRED" as const;

export const STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK = Object.freeze({
  projectId: STAGING_POSTGRES_BACKUP_CANARY_LOCK.projectId,
  environmentId: STAGING_POSTGRES_BACKUP_CANARY_LOCK.environmentId,
  serviceId: STAGING_POSTGRES_BACKUP_CANARY_LOCK.serviceId,
  serviceInstanceId: "716b4818-7695-4b9f-b5f9-35249e785a58",
  serviceName: STAGING_POSTGRES_BACKUP_CANARY_LOCK.serviceName,
  railwayConfigPath: STAGING_POSTGRES_BACKUP_CANARY_LOCK.railwayConfigPath,
  rootCaDerSha256: STAGING_POSTGRES_BACKUP_CANARY_LOCK.rootCaDerSha256,
  expectedNodeVersion: "v22.23.2",
  expectedHeadSha: "b14bf9a5755b5ffd1e954ec786c35e5330dc9c5c",
  expectedTreeSha: "c1d614a7f88b23c281b3a8fa40a8a675a675992d",
  expectedSourceManifestSha256:
    "388abd36d7f64f01b717659acfb37b63b7589d3c9342fb0fa65455be30192c76",
  sourceManifestAlgorithm:
    "sha256-json-depth-first-bytewise-siblings-path-type-mode-size-content-v1",
  expectedSourceEntryCount: 684,
  expectedSourceDirectoryCount: 82,
  expectedSourceFileCount: 602,
  expectedSourceFileBytes: 14_904_195,
  expectedOpaqueConfigEtag:
    "97a3a71ae08a9b0cb797aec06f47ba601b52ad844a9dd44b136bb5d795348546",
  railwayVersion: "5.32.0",
  railwayBinary: "/opt/homebrew/Cellar/railway/5.32.0/bin/railway",
  railwayBinarySha256:
    "26e3e0fd2b59fd9f7b1e891cbc8f3ca9b0266556545f00ba4db3ce754fbc10d1",
  productionFreeze: true,
} as const);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EXPECTED_VARIABLE_NAMES = Object.freeze([
  "RAILPACK_PACKAGES",
  "STAGING_POSTGRES_CA_CANARY_MODE",
  "STAGING_POSTGRES_CA_CANARY_RAILWAY_CONFIG_PATH",
] as const);

export const STAGING_POSTGRES_BUILD_CANARY_DEADLINES = Object.freeze({
  localAuthorityMs: 20_000,
  boundaryMs: 20_000,
  durableEvidenceMs: 20_000,
  uploadMs: 120_000,
  postflightMs: 300_000,
  cleanupMs: 20_000,
  finalizationMs: 20_000,
} as const);

export interface StagingPostgresBuildCanaryLocalAuthority {
  readonly nodeVersion: string;
  readonly headSha: string;
  readonly treeSha: string;
  readonly sourceManifestSha256: string;
  readonly sourceDirectoryAbsolute: boolean;
  readonly sourceIdentityExact: boolean;
  readonly railwayVersion: string;
  readonly railwayBinary: string;
  readonly railwayBinarySha256: string;
  readonly sourceManifestAlgorithm: string;
  readonly sourceEntryCount: number;
  readonly sourceDirectoryCount: number;
  readonly sourceFileCount: number;
  readonly sourceFileBytes: number;
  readonly explicitUploadTargetExact: boolean;
}

export interface StagingPostgresBuildCanaryBoundarySnapshot {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly serviceInstanceId: string;
  readonly serviceName: string;
  readonly railwayConfigPath: string;
  readonly productionBoundaryPassed: boolean;
  readonly stagingBoundaryPassed: boolean;
  readonly productionPatchEmpty: boolean;
  readonly stagingPatchEmpty: boolean;
  readonly productionFreeze: boolean;
  readonly opaqueConfigEtag: string;
  readonly autoDeploy: boolean;
  readonly triggerCount: number;
  readonly inventoriesComplete: boolean;
  readonly deploymentInventoryIds: readonly string[];
  readonly domainIds: readonly string[];
  readonly tcpProxyIds: readonly string[];
  readonly volumeIds: readonly string[];
  readonly region: string;
  readonly replicaCount: number;
  readonly cpuLimit: number;
  readonly memoryLimitBytes: number;
  readonly builder: string;
  readonly buildCommand: string;
  readonly startCommand: string;
  readonly restartPolicyType: string;
  readonly restartPolicyMaxRetries: number;
  readonly overlapSeconds: number;
  readonly drainingSeconds: number;
  readonly ipv6EgressEnabled: boolean;
  readonly sleepApplication: boolean;
  readonly preDeployCommands: readonly string[];
  readonly healthcheckPath: string | null;
  readonly healthcheckTimeout: number | null;
  readonly cronSchedule: string | null;
  readonly watchPatterns: readonly string[];
  readonly variableNames: readonly string[];
  readonly variableMetadataExact: boolean;
  readonly sourceImage: string | null;
  readonly sourceRepo: string | null;
  readonly latestDeploymentId: string | null;
  readonly activeDeploymentIds: readonly string[];
}

export interface StagingPostgresBuildCanaryPostflight
  extends StagingPostgresBuildCanaryBoundarySnapshot {
  readonly deploymentId: string | null;
  readonly deploymentStatus: "SUCCESS" | "FAILED" | "CRASHED" | "REMOVED" | null;
  readonly deploymentStopped: boolean;
  readonly deploymentSnapshotId: string | null;
  readonly deploymentImageDigest: string | null;
  readonly buildOnlyReceiptPassed: boolean;
  readonly buildOnlyReceiptSha256: string | null;
  readonly credentialCandidatesNull: boolean;
  readonly dedicatedRailwayConfig: boolean;
  readonly runtimePublicConfigurationExact: boolean;
}

export interface StagingPostgresBuildCanaryUploadAcknowledgement {
  readonly deploymentId: string;
}

interface StagingPostgresBuildCanaryIntent {
  readonly schemaVersion: "pintpath-staging-postgres-build-canary-intent/v2";
  readonly operation: typeof STAGING_POSTGRES_BUILD_CANARY_OPERATION;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly serviceInstanceId: string;
  readonly headSha: string;
  readonly treeSha: string;
  readonly sourceManifestSha256: string;
  readonly opaqueConfigEtag: string;
  readonly serviceName: string;
  readonly railwayConfigPath: string;
  readonly rootCaDerSha256: string;
  readonly railwayBinarySha256: string;
  readonly productionFreeze: true;
  readonly sequentialNotAtomic: true;
}

export interface StagingPostgresBuildCanaryDurableArtifactEvidence {
  readonly publication: "created-durable" | "existing-exact";
  readonly sha256: string;
  readonly canonicalPathExact: boolean;
  readonly parentMode0700: boolean;
  readonly fileMode0600: boolean;
  readonly currentUid: boolean;
  readonly regularFile: boolean;
  readonly nonSymlink: boolean;
  readonly nlinkOne: boolean;
  readonly exclusiveCreate: boolean;
  readonly fileFsync: boolean;
  readonly parentFsync: boolean;
  readonly identityHeld: boolean;
  readonly readbackExact: boolean;
}

export interface StagingPostgresBuildCanaryChildAuthority {
  readonly snapshotId: string;
  readonly imageDigest: string;
  readonly buildOnlyReceiptSha256: string;
}

export interface StagingPostgresBuildCanaryExecutorChecks {
  frameworkEnabled: boolean;
  sequentialNotAtomic: boolean;
  localPreflightExact: boolean;
  boundaryPreflightExact: boolean;
  durableIntentExact: boolean;
  localAuthorityReasserted: boolean;
  boundaryReasserted: boolean;
  writeAttempted: boolean;
  acknowledgementExact: boolean;
  postflightAttempted: boolean;
  boundaryPostflightExact: boolean;
  targetPostflightExact: boolean;
  localPostflightExact: boolean;
  cleanupExact: boolean;
  finalizationExact: boolean;
}

export type StagingPostgresBuildCanaryExecutorOutcome =
  | "blocked"
  | "failed"
  | "mutation_uncertain"
  | "cleanup_failed"
  | "passed";

export interface StagingPostgresBuildCanaryExecutorReceipt {
  readonly schemaVersion: typeof STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_SCHEMA;
  readonly operation: typeof STAGING_POSTGRES_BUILD_CANARY_OPERATION;
  readonly mode: "framework-disabled" | "sequential-single-write";
  readonly outcome: StagingPostgresBuildCanaryExecutorOutcome;
  readonly deploymentId: string | null;
  readonly reconciliationDeploymentId: string | null;
  readonly intentSha256: string | null;
  readonly terminalEvidenceSha256: string | null;
  readonly childAuthority: StagingPostgresBuildCanaryChildAuthority | null;
  readonly checks: StagingPostgresBuildCanaryExecutorChecks;
}

export interface StagingPostgresBuildCanaryExecutorDependencies {
  readonly inspectLocalAuthority: (
    signal: AbortSignal,
  ) => Promise<StagingPostgresBuildCanaryLocalAuthority>;
  readonly preflight: (
    signal: AbortSignal,
  ) => Promise<StagingPostgresBuildCanaryBoundarySnapshot>;
  readonly inspectIntent: (
    canonicalIntent: string,
    signal: AbortSignal,
  ) => Promise<StagingPostgresBuildCanaryDurableArtifactEvidence | null>;
  readonly persistIntent: (
    canonicalIntent: string,
    signal: AbortSignal,
  ) => Promise<StagingPostgresBuildCanaryDurableArtifactEvidence>;
  readonly uploadExactlyOnce: (
    intentSha256: string,
    signal: AbortSignal,
  ) => Promise<StagingPostgresBuildCanaryUploadAcknowledgement>;
  readonly postflight: (
    deploymentId: string | null,
    signal: AbortSignal,
  ) => Promise<StagingPostgresBuildCanaryPostflight>;
  readonly persistTerminalEvidence: (
    canonicalCandidate: string,
    signal: AbortSignal,
  ) => Promise<StagingPostgresBuildCanaryDurableArtifactEvidence>;
  readonly cleanup: (signal: AbortSignal) => Promise<boolean>;
  readonly finalize: (signal: AbortSignal) => Promise<boolean>;
}

function initialChecks(): StagingPostgresBuildCanaryExecutorChecks {
  return {
    frameworkEnabled: false,
    sequentialNotAtomic: true,
    localPreflightExact: false,
    boundaryPreflightExact: false,
    durableIntentExact: false,
    localAuthorityReasserted: false,
    boundaryReasserted: false,
    writeAttempted: false,
    acknowledgementExact: false,
    postflightAttempted: false,
    boundaryPostflightExact: false,
    targetPostflightExact: false,
    localPostflightExact: false,
    cleanupExact: false,
    finalizationExact: false,
  };
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

const MAX_DEPENDENCY_SNAPSHOT_DEPTH = 8;
const MAX_DEPENDENCY_SNAPSHOT_NODES = 4_096;
const MAX_DEPENDENCY_ARRAY_LENGTH = 2_048;
const MAX_DEPENDENCY_OBJECT_KEYS = 512;
const MAX_DEPENDENCY_STRING_BYTES = 64 * 1_024;

function snapshotDependencyResult<T>(input: T): T {
  let nodes = 0;
  const seen = new Set<object>();
  const snapshot = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (
      nodes > MAX_DEPENDENCY_SNAPSHOT_NODES
      || depth > MAX_DEPENDENCY_SNAPSHOT_DEPTH
    ) throw new Error("dependency_result_invalid");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > MAX_DEPENDENCY_STRING_BYTES) {
        throw new Error("dependency_result_invalid");
      }
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("dependency_result_invalid");
      return value;
    }
    if (typeof value !== "object" || seen.has(value)) {
      throw new Error("dependency_result_invalid");
    }
    seen.add(value);
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new Error("dependency_result_invalid");
      const lengthDescriptor = descriptors.length;
      if (
        !lengthDescriptor
        || !Object.hasOwn(lengthDescriptor, "value")
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > MAX_DEPENDENCY_ARRAY_LENGTH
        || keys.length !== lengthDescriptor.value + 1
      ) throw new Error("dependency_result_invalid");
      const output: unknown[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor
          || !Object.hasOwn(descriptor, "value")
          || !descriptor.enumerable
        ) {
          throw new Error("dependency_result_invalid");
        }
        output.push(snapshot(descriptor.value, depth + 1));
      }
      if (keys.some((key) =>
        typeof key !== "string"
        || key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)
      )) throw new Error("dependency_result_invalid");
      return Object.freeze(output);
    }
    if (
      prototype !== Object.prototype
      && prototype !== null
      || keys.length > MAX_DEPENDENCY_OBJECT_KEYS
      || keys.some((key) => typeof key !== "string")
    ) throw new Error("dependency_result_invalid");
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        !descriptor
        || !Object.hasOwn(descriptor, "value")
        || !descriptor.enumerable
      ) {
        throw new Error("dependency_result_invalid");
      }
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: snapshot(descriptor.value, depth + 1),
      });
    }
    return Object.freeze(output);
  };
  return snapshot(input, 0) as T;
}

async function withDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    // A deadline requests cancellation; it never authorizes the next phase to
    // overlap an operation that may still be mutating external or durable
    // state. A non-cooperative dependency therefore fail-stops this executor.
    let result: T;
    try {
      result = await Promise.resolve().then(() => operation(controller.signal));
    } catch (error) {
      if (timedOut) throw new Error("operation_timeout");
      throw error;
    }
    if (timedOut) throw new Error("operation_timeout");
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function durableArtifactExact(
  evidence: StagingPostgresBuildCanaryDurableArtifactEvidence,
  expectedSha256: string,
): boolean {
  return (evidence.publication === "created-durable"
      || evidence.publication === "existing-exact")
    && evidence.sha256 === expectedSha256
    && evidence.canonicalPathExact === true
    && evidence.parentMode0700 === true
    && evidence.fileMode0600 === true
    && evidence.currentUid === true
    && evidence.regularFile === true
    && evidence.nonSymlink === true
    && evidence.nlinkOne === true
    && evidence.exclusiveCreate
      === (evidence.publication === "created-durable")
    && evidence.fileFsync === true
    && evidence.parentFsync === true
    && evidence.identityHeld === true
    && evidence.readbackExact === true;
}

function exactStringArray(
  actual: unknown,
  expected: readonly string[],
): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((value, index) => actual[index] === value);
}

function exactEmptyArray(actual: unknown): boolean {
  return Array.isArray(actual) && actual.length === 0;
}

function exactSingleStringArray(actual: unknown, expected: unknown): boolean {
  return typeof expected === "string"
    && Array.isArray(actual)
    && actual.length === 1
    && actual[0] === expected;
}

function targetConfigurationExact(
  snapshot: StagingPostgresBuildCanaryBoundarySnapshot,
): boolean {
  const lock = STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK;
  return snapshot.serviceName === lock.serviceName
    && snapshot.railwayConfigPath === lock.railwayConfigPath
    && snapshot.inventoriesComplete === true
    && exactEmptyArray(snapshot.domainIds)
    && exactEmptyArray(snapshot.tcpProxyIds)
    && exactEmptyArray(snapshot.volumeIds)
    && snapshot.region === "asia-southeast1-eqsg3a"
    && snapshot.replicaCount === 1
    && snapshot.cpuLimit === 0.1
    && snapshot.memoryLimitBytes === 500_000_000
    && snapshot.builder === "RAILPACK"
    && snapshot.buildCommand === "npm run build"
    && snapshot.startCommand
      === "node dist/scripts/staging-postgres-backup-canary.js"
    && snapshot.restartPolicyType === "NEVER"
    && snapshot.restartPolicyMaxRetries === 1
    && snapshot.overlapSeconds === 0
    && snapshot.drainingSeconds === 0
    && snapshot.ipv6EgressEnabled === false
    && snapshot.sleepApplication === false
    && exactEmptyArray(snapshot.preDeployCommands)
    && snapshot.healthcheckPath === null
    && snapshot.healthcheckTimeout === null
    && snapshot.cronSchedule === null
    && exactEmptyArray(snapshot.watchPatterns)
    && exactStringArray(snapshot.variableNames, EXPECTED_VARIABLE_NAMES)
    && snapshot.variableMetadataExact === true;
}

function localAuthorityExact(
  authority: StagingPostgresBuildCanaryLocalAuthority,
): boolean {
  const lock = STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK;
  return authority.nodeVersion === lock.expectedNodeVersion
    && authority.headSha === lock.expectedHeadSha
    && authority.treeSha === lock.expectedTreeSha
    && authority.sourceManifestSha256 === lock.expectedSourceManifestSha256
    && authority.sourceDirectoryAbsolute === true
    && authority.sourceIdentityExact === true
    && authority.railwayVersion === lock.railwayVersion
    && authority.railwayBinary === lock.railwayBinary
    && authority.railwayBinarySha256 === lock.railwayBinarySha256
    && authority.sourceManifestAlgorithm === lock.sourceManifestAlgorithm
    && authority.sourceEntryCount === lock.expectedSourceEntryCount
    && authority.sourceDirectoryCount === lock.expectedSourceDirectoryCount
    && authority.sourceFileCount === lock.expectedSourceFileCount
    && authority.sourceFileBytes === lock.expectedSourceFileBytes
    && authority.explicitUploadTargetExact === true;
}

function preflightExact(
  snapshot: StagingPostgresBuildCanaryBoundarySnapshot,
): boolean {
  const lock = STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK;
  return snapshot.projectId === lock.projectId
    && snapshot.environmentId === lock.environmentId
    && snapshot.serviceId === lock.serviceId
    && snapshot.serviceInstanceId === lock.serviceInstanceId
    && snapshot.productionBoundaryPassed === true
    && snapshot.stagingBoundaryPassed === true
    && snapshot.productionPatchEmpty === true
    && snapshot.stagingPatchEmpty === true
    && snapshot.productionFreeze === true
    && snapshot.opaqueConfigEtag === lock.expectedOpaqueConfigEtag
    && snapshot.autoDeploy === false
    && snapshot.triggerCount === 0
    && targetConfigurationExact(snapshot)
    && exactEmptyArray(snapshot.deploymentInventoryIds)
    && snapshot.sourceImage === null
    && snapshot.sourceRepo === null
    && snapshot.latestDeploymentId === null
    && exactEmptyArray(snapshot.activeDeploymentIds);
}

function postflightBoundaryExact(
  snapshot: StagingPostgresBuildCanaryPostflight,
): boolean {
  const lock = STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK;
  return snapshot.projectId === lock.projectId
    && snapshot.environmentId === lock.environmentId
    && snapshot.serviceId === lock.serviceId
    && snapshot.serviceInstanceId === lock.serviceInstanceId
    && snapshot.productionBoundaryPassed === true
    && snapshot.stagingBoundaryPassed === true
    && snapshot.productionPatchEmpty === true
    && snapshot.stagingPatchEmpty === true
    && snapshot.productionFreeze === true
    && snapshot.opaqueConfigEtag === lock.expectedOpaqueConfigEtag
    && snapshot.autoDeploy === false
    && snapshot.triggerCount === 0
    && targetConfigurationExact(snapshot)
    && exactSingleStringArray(
      snapshot.deploymentInventoryIds,
      snapshot.deploymentId,
    )
    && snapshot.sourceImage === null
    && snapshot.sourceRepo === null;
}

function targetPostflightExact(
  snapshot: StagingPostgresBuildCanaryPostflight,
  deploymentId: string,
): boolean {
  return snapshot.deploymentId === deploymentId
    && snapshot.latestDeploymentId === deploymentId
    && snapshot.deploymentStatus === "SUCCESS"
    && snapshot.deploymentStopped === true
    && typeof snapshot.deploymentSnapshotId === "string"
    && UUID_PATTERN.test(snapshot.deploymentSnapshotId)
    && typeof snapshot.deploymentImageDigest === "string"
    && IMAGE_DIGEST_PATTERN.test(snapshot.deploymentImageDigest)
    && exactEmptyArray(snapshot.activeDeploymentIds)
    && snapshot.buildOnlyReceiptPassed === true
    && typeof snapshot.buildOnlyReceiptSha256 === "string"
    && SHA256_PATTERN.test(snapshot.buildOnlyReceiptSha256)
    && snapshot.credentialCandidatesNull === true
    && snapshot.dedicatedRailwayConfig === true
    && snapshot.runtimePublicConfigurationExact === true;
}

function childAuthority(
  snapshot: StagingPostgresBuildCanaryPostflight,
): StagingPostgresBuildCanaryChildAuthority | null {
  if (
    typeof snapshot.deploymentSnapshotId !== "string"
    || !UUID_PATTERN.test(snapshot.deploymentSnapshotId)
    || typeof snapshot.deploymentImageDigest !== "string"
    || !IMAGE_DIGEST_PATTERN.test(snapshot.deploymentImageDigest)
    || typeof snapshot.buildOnlyReceiptSha256 !== "string"
    || !SHA256_PATTERN.test(snapshot.buildOnlyReceiptSha256)
  ) {
    return null;
  }
  return {
    snapshotId: snapshot.deploymentSnapshotId,
    imageDigest: snapshot.deploymentImageDigest,
    buildOnlyReceiptSha256: snapshot.buildOnlyReceiptSha256,
  };
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function makeIntent(
  local: StagingPostgresBuildCanaryLocalAuthority,
): StagingPostgresBuildCanaryIntent {
  const lock = STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_LOCK;
  return {
    schemaVersion: "pintpath-staging-postgres-build-canary-intent/v2",
    operation: STAGING_POSTGRES_BUILD_CANARY_OPERATION,
    projectId: lock.projectId,
    environmentId: lock.environmentId,
    serviceId: lock.serviceId,
    serviceInstanceId: lock.serviceInstanceId,
    headSha: local.headSha,
    treeSha: local.treeSha,
    sourceManifestSha256: local.sourceManifestSha256,
    opaqueConfigEtag: lock.expectedOpaqueConfigEtag,
    serviceName: lock.serviceName,
    railwayConfigPath: lock.railwayConfigPath,
    rootCaDerSha256: lock.rootCaDerSha256,
    railwayBinarySha256: lock.railwayBinarySha256,
    productionFreeze: true,
    sequentialNotAtomic: true,
  };
}

function makeReceipt(
  mode: StagingPostgresBuildCanaryExecutorReceipt["mode"],
  outcome: StagingPostgresBuildCanaryExecutorOutcome,
  deploymentId: string | null,
  reconciliationDeploymentId: string | null,
  intentSha256: string | null,
  terminalEvidenceSha256: string | null,
  child: StagingPostgresBuildCanaryChildAuthority | null,
  checks: StagingPostgresBuildCanaryExecutorChecks,
): StagingPostgresBuildCanaryExecutorReceipt {
  return {
    schemaVersion: STAGING_POSTGRES_BUILD_CANARY_EXECUTOR_SCHEMA,
    operation: STAGING_POSTGRES_BUILD_CANARY_OPERATION,
    mode,
    outcome,
    deploymentId,
    reconciliationDeploymentId,
    intentSha256,
    terminalEvidenceSha256,
    childAuthority: child,
    checks: { ...checks },
  };
}

function fixedDisabledReceipt(): StagingPostgresBuildCanaryExecutorReceipt {
  return makeReceipt(
    "framework-disabled",
    "blocked",
    null,
    null,
    null,
    null,
    null,
    initialChecks(),
  );
}

async function executeEnabled(
  dependencies: StagingPostgresBuildCanaryExecutorDependencies,
): Promise<StagingPostgresBuildCanaryExecutorReceipt> {
  const checks = initialChecks();
  checks.frameworkEnabled = true;
  let deploymentId: string | null = null;
  let reconciliationDeploymentId: string | null = null;
  let intentSha256: string | null = null;
  let outcome: StagingPostgresBuildCanaryExecutorOutcome = "failed";
  let postflight: StagingPostgresBuildCanaryPostflight | null = null;
  let observedChildAuthority: StagingPostgresBuildCanaryChildAuthority | null = null;
  let writeAttempted = false;
  let uploadFailed = false;
  let recoveryOnly = false;
  const applyPostflightObservation = (): void => {
    if (!postflight) return;
    checks.boundaryPostflightExact = postflightBoundaryExact(postflight);
    const candidateDeploymentId = postflight.deploymentId;
    if (
      !checks.boundaryPostflightExact
      || typeof candidateDeploymentId !== "string"
      || !UUID_PATTERN.test(candidateDeploymentId)
    ) return;
    reconciliationDeploymentId = candidateDeploymentId;
    const acknowledgementMatches = deploymentId === null
      || deploymentId === candidateDeploymentId;
    checks.targetPostflightExact = acknowledgementMatches
      && targetPostflightExact(postflight, candidateDeploymentId);
    if (checks.targetPostflightExact) {
      observedChildAuthority = childAuthority(postflight);
    }
  };
  const applyPostflightObservationSafely = (): void => {
    checks.boundaryPostflightExact = false;
    checks.targetPostflightExact = false;
    reconciliationDeploymentId = null;
    observedChildAuthority = null;
    try {
      applyPostflightObservation();
    } catch {
      postflight = null;
      checks.boundaryPostflightExact = false;
      checks.targetPostflightExact = false;
      reconciliationDeploymentId = null;
      observedChildAuthority = null;
    }
  };

  try {
    const local = snapshotDependencyResult(await withDeadline(
      STAGING_POSTGRES_BUILD_CANARY_DEADLINES.localAuthorityMs,
      dependencies.inspectLocalAuthority,
    ));
    checks.localPreflightExact = localAuthorityExact(local);
    if (!checks.localPreflightExact) throw new Error("local_authority_invalid");

    const canonicalIntent = canonical(makeIntent(local));
    const expectedIntentSha256 = sha256(canonicalIntent);
    recoveryOnly = true;
    const existingIntent = snapshotDependencyResult(await withDeadline(
      STAGING_POSTGRES_BUILD_CANARY_DEADLINES.durableEvidenceMs,
      (signal) => dependencies.inspectIntent(canonicalIntent, signal),
    ));
    if (existingIntent !== null) {
      checks.durableIntentExact = existingIntent.publication === "existing-exact"
        && durableArtifactExact(existingIntent, expectedIntentSha256);
      if (checks.durableIntentExact) intentSha256 = existingIntent.sha256;
    } else {
      recoveryOnly = false;
      const boundary = snapshotDependencyResult(await withDeadline(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.boundaryMs,
        dependencies.preflight,
      ));
      checks.boundaryPreflightExact = preflightExact(boundary);
      if (!checks.boundaryPreflightExact) throw new Error("boundary_invalid");

      recoveryOnly = true;
      const persistedIntent = snapshotDependencyResult(await withDeadline(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.durableEvidenceMs,
        (signal) => dependencies.persistIntent(canonicalIntent, signal),
      ));
      checks.durableIntentExact = durableArtifactExact(
        persistedIntent,
        expectedIntentSha256,
      );
      if (checks.durableIntentExact) {
        intentSha256 = persistedIntent.sha256;
        recoveryOnly = persistedIntent.publication === "existing-exact";
      }
    }

    checks.localAuthorityReasserted = localAuthorityExact(
      snapshotDependencyResult(await withDeadline(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.localAuthorityMs,
        dependencies.inspectLocalAuthority,
      )),
    );
    if (!checks.localAuthorityReasserted) throw new Error("local_authority_drift");

    if (!recoveryOnly) {
      checks.boundaryReasserted = preflightExact(
        snapshotDependencyResult(await withDeadline(
          STAGING_POSTGRES_BUILD_CANARY_DEADLINES.boundaryMs,
          dependencies.preflight,
        )),
      );
      if (!checks.boundaryReasserted) throw new Error("boundary_drift");

      writeAttempted = true;
      checks.writeAttempted = true;
      try {
        const acknowledgement = snapshotDependencyResult(await withDeadline(
          STAGING_POSTGRES_BUILD_CANARY_DEADLINES.uploadMs,
          (signal) => dependencies.uploadExactlyOnce(intentSha256!, signal),
        ));
        if (
          typeof acknowledgement.deploymentId === "string"
          && UUID_PATTERN.test(acknowledgement.deploymentId)
        ) {
          deploymentId = acknowledgement.deploymentId;
          checks.acknowledgementExact = true;
        }
      } catch {
        uploadFailed = true;
      }
    }
    checks.postflightAttempted = true;
    try {
      postflight = snapshotDependencyResult(await withDeadline(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.postflightMs,
        (signal) => dependencies.postflight(deploymentId, signal),
      ));
    } catch {
      postflight = null;
    }

    applyPostflightObservationSafely();
    try {
      checks.localPostflightExact = localAuthorityExact(
        snapshotDependencyResult(await withDeadline(
          STAGING_POSTGRES_BUILD_CANARY_DEADLINES.localAuthorityMs,
          dependencies.inspectLocalAuthority,
        )),
      );
    } catch {
      checks.localPostflightExact = false;
    }
    const passed = !recoveryOnly
      && !uploadFailed
      && checks.acknowledgementExact
      && deploymentId === reconciliationDeploymentId
      && checks.boundaryReasserted
      && checks.boundaryPostflightExact
      && checks.targetPostflightExact
      && checks.localPostflightExact;
    outcome = passed ? "passed" : "mutation_uncertain";
  } catch {
    if (recoveryOnly && !checks.postflightAttempted) {
      checks.postflightAttempted = true;
      try {
        postflight = snapshotDependencyResult(await withDeadline(
          STAGING_POSTGRES_BUILD_CANARY_DEADLINES.postflightMs,
          (signal) => dependencies.postflight(null, signal),
        ));
      } catch {
        postflight = null;
      }
    }
    applyPostflightObservationSafely();
    outcome = writeAttempted || recoveryOnly ? "mutation_uncertain" : "failed";
  } finally {
    try {
      checks.cleanupExact = await withDeadline(
        STAGING_POSTGRES_BUILD_CANARY_DEADLINES.cleanupMs,
        dependencies.cleanup,
      ) === true;
    } catch {
      checks.cleanupExact = false;
    }
    if (!checks.cleanupExact) outcome = "cleanup_failed";
  }

  const provisional = makeReceipt(
    "sequential-single-write",
    outcome,
    deploymentId,
    reconciliationDeploymentId,
    intentSha256,
    null,
    observedChildAuthority,
    checks,
  );
  let terminalEvidenceSha256: string | null = null;
  try {
    const candidate = canonical({
      schemaVersion: "pintpath-staging-postgres-build-canary-evidence-candidate/v2",
      state: "pending-reconciliation",
      operation: STAGING_POSTGRES_BUILD_CANARY_OPERATION,
      candidateReceiptSha256: sha256(canonical(provisional)),
      deploymentId,
      reconciliationDeploymentId,
      intentSha256,
      childAuthority: observedChildAuthority,
      checks: { ...checks },
    });
    const expectedEvidenceSha256 = sha256(candidate);
    const persistedEvidence = snapshotDependencyResult(await withDeadline(
      STAGING_POSTGRES_BUILD_CANARY_DEADLINES.durableEvidenceMs,
      (signal) => dependencies.persistTerminalEvidence(candidate, signal),
    ));
    if (durableArtifactExact(persistedEvidence, expectedEvidenceSha256)) {
      terminalEvidenceSha256 = persistedEvidence.sha256;
    } else {
      outcome = checks.cleanupExact
        ? (writeAttempted || recoveryOnly ? "mutation_uncertain" : "failed")
        : "cleanup_failed";
    }
  } catch {
    outcome = checks.cleanupExact
      ? (writeAttempted || recoveryOnly ? "mutation_uncertain" : "failed")
      : "cleanup_failed";
  }
  try {
    checks.finalizationExact = await withDeadline(
      STAGING_POSTGRES_BUILD_CANARY_DEADLINES.finalizationMs,
      dependencies.finalize,
    ) === true;
  } catch {
    checks.finalizationExact = false;
  }
  if (!checks.finalizationExact) outcome = "cleanup_failed";
  return makeReceipt(
    "sequential-single-write",
    outcome,
    deploymentId,
    reconciliationDeploymentId,
    intentSha256,
    terminalEvidenceSha256,
    observedChildAuthority,
    checks,
  );
}

export async function runStagingPostgresBuildCanaryExecutor(): Promise<0 | 1> {
  const receipt = fixedDisabledReceipt();
  process.stdout.write(`${canonical(receipt)}\n`);
  return 1;
}

export const stagingPostgresBuildCanaryExecutorInternals = {
  executeEnabled,
  durableArtifactExact,
  fixedDisabledReceipt,
  localAuthorityExact,
  postflightBoundaryExact,
  preflightExact,
  snapshotDependencyResult,
  targetPostflightExact,
  withDeadline,
};
