import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK,
  PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS,
  type PermanentStagingProviderVariableWriteOperation,
} from "./permanent-staging-provider-variable-write-executor.js";
import {
  evaluatePermanentStagingProviderVariableCreatePreflight,
  foldPermanentStagingProviderDeploymentInventoryPages,
  foldPermanentStagingProviderVariableInventoryPages,
  parsePermanentStagingProviderDeploymentInventoryPage,
  parsePermanentStagingProviderVariableInventoryPage,
  type PermanentStagingProviderVariableCreatePreflightCandidate,
} from "./permanent-staging-provider-variable-write-railway-contract.js";
import {
  consumePermanentStagingProviderVariableWriteLocalReceiptAuthority,
  createPermanentStagingProviderVariableWriteLocalAttemptAuthority,
  type PermanentStagingProviderVariableWriteLocalAttemptAuthority,
} from "./permanent-staging-provider-variable-write-local-authority.js";

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_KERNEL_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-kernel/v3" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INTENT_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-intent/v3" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_TERMINAL_SCHEMA =
  "pintpath-permanent-staging-provider-variable-write-terminal-evidence/v4" as const;
export const PERMANENT_STAGING_PROVIDER_VARIABLE_PREFLIGHT_LINEAGE_SCHEMA =
  "pintpath-permanent-staging-provider-variable-preflight-lineage/v1" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DEPENDENCY_SNAPSHOT_DEPTH = 8;
const MAX_DEPENDENCY_SNAPSHOT_NODES = 12_000;
const MAX_DEPENDENCY_ARRAY_LENGTH = 2_048;
const MAX_DEPENDENCY_OBJECT_KEYS = 512;
const MAX_DEPENDENCY_STRING_BYTES = 64 * 1_024;
const MAX_INTENT_CANONICAL_BYTES = 64 * 1_024;
const MAX_TERMINAL_CANONICAL_BYTES = 64 * 1_024;
const MAX_PREFLIGHT_LINEAGE_CANONICAL_BYTES = 48 * 1_024;
const MAX_PREFLIGHT_LINEAGE_PAGES = 20;
const SAFE_ABORT_CONTROLLER = AbortController;
const SAFE_ABORT_CONTROLLER_ABORT = AbortController.prototype.abort;
const SAFE_ABORT_CONTROLLER_SIGNAL = Object.getOwnPropertyDescriptor(
  AbortController.prototype,
  "signal",
)?.get;
const SAFE_ARRAY_IS_ARRAY = Array.isArray;
const SAFE_ARRAY_BUFFER = ArrayBuffer;
const SAFE_ARRAY_BUFFER_IS_VIEW = SAFE_ARRAY_BUFFER.isView;
const SAFE_ARRAY_PROTOTYPE = Array.prototype;
const SAFE_BUFFER = Buffer;
const SAFE_BUFFER_BYTE_LENGTH = SAFE_BUFFER.byteLength;
const SAFE_BUFFER_IS_BUFFER = SAFE_BUFFER.isBuffer;
const SAFE_BUFFER_PROTOTYPE = SAFE_BUFFER.prototype;
const SAFE_CRYPTO = crypto;
const SAFE_ERROR = Error;
const SAFE_CRYPTO_CREATE_HASH = SAFE_CRYPTO.createHash;
const SAFE_CRYPTO_HASH_PROBE = SAFE_CRYPTO_CREATE_HASH("sha256");
const SAFE_CRYPTO_HASH_DIGEST = SAFE_CRYPTO_HASH_PROBE.digest;
const SAFE_CRYPTO_HASH_UPDATE = SAFE_CRYPTO_HASH_PROBE.update;
const SAFE_JSON_PARSE = JSON.parse;
const SAFE_JSON_STRINGIFY = JSON.stringify;
const SAFE_NUMBER_IS_FINITE = Number.isFinite;
const SAFE_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const SAFE_OBJECT = Object;
const SAFE_OBJECT_CREATE = SAFE_OBJECT.create;
const SAFE_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const SAFE_OBJECT_FREEZE = Object.freeze;
const SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR =
  Object.getOwnPropertyDescriptor;
const SAFE_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const SAFE_OBJECT_HAS_OWN = Object.hasOwn;
const SAFE_OBJECT_KEYS = Object.keys;
const SAFE_OBJECT_PROTOTYPE = Object.prototype;
const SAFE_OBJECT_SET_PROTOTYPE_OF = Object.setPrototypeOf;
const SAFE_REFLECT_APPLY = Reflect.apply;
const SAFE_REFLECT_OWN_KEYS = Reflect.ownKeys;
const SAFE_REGEXP_EXEC = RegExp.prototype.exec;
const SAFE_REGEXP_TEST = RegExp.prototype.test;
const SAFE_GLOBAL_THIS = globalThis;
const SAFE_CLEAR_TIMEOUT = SAFE_GLOBAL_THIS.clearTimeout;
const SAFE_SET_TIMEOUT = SAFE_GLOBAL_THIS.setTimeout;
const SAFE_STRING_CONSTRUCTOR = String;
const SAFE_WEAK_SET = WeakSet;
const SAFE_WEAK_SET_ADD = WeakSet.prototype.add;
const SAFE_WEAK_SET_HAS = WeakSet.prototype.has;
const SAFE_TYPED_ARRAY_PROTOTYPE = SAFE_OBJECT_GET_PROTOTYPE_OF(
  Uint8Array.prototype,
) as object;
const SAFE_TYPED_ARRAY_BYTE_LENGTH_GETTER =
  SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    SAFE_TYPED_ARRAY_PROTOTYPE,
    "byteLength",
  )?.get;
const SAFE_UTIL_TYPES = utilTypes;
const SAFE_UTIL_IS_PROXY = SAFE_UTIL_TYPES.isProxy;
const LOWERCASE_HEX = "0123456789abcdef";

function freezeNullRecord<T extends object>(value: T): T {
  SAFE_REFLECT_APPLY(
    SAFE_OBJECT_SET_PROTOTYPE_OF,
    SAFE_OBJECT,
    [value, null],
  );
  return SAFE_OBJECT_FREEZE(value);
}

function kernelError(message: string): Error {
  return new SAFE_ERROR(message);
}
SAFE_OBJECT_DEFINE_PROPERTY(SHA256_PATTERN, "exec", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: SAFE_REGEXP_EXEC,
});
SAFE_OBJECT_FREEZE(SHA256_PATTERN);
const VARIABLE_INVENTORY_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/variable-inventory/v1\0";
const DEPLOYMENT_INVENTORY_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/deployment-inventory/v1\0";
const LOCAL_AUTHORITY_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/local-authority/v2\0";
const COMMAND_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/command/v2\0";
const WRITE_ACKNOWLEDGEMENT_HASH_DOMAIN =
  "pintpath/permanent-staging/provider-variable-write/write-acknowledgement/v2\0";
function appendOwnArrayItem<T>(values: T[], value: T): boolean {
  try {
    const index = values.length;
    const key = SAFE_REFLECT_APPLY(
      SAFE_STRING_CONSTRUCTOR,
      undefined,
      [index],
    ) as string;
    SAFE_OBJECT_DEFINE_PROPERTY(values, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
    return values.length === index + 1 && values[index] === value;
  } catch {
    return false;
  }
}

export const PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES =
SAFE_OBJECT_FREEZE({
  inputMs: 20_000,
  localAuthorityMs: 20_000,
  boundaryMs: 30_000,
  targetMs: 30_000,
  evidenceMs: 20_000,
  writeMs: 60_000,
  postflightMs: 30_000,
  cleanupMs: 20_000,
  finalizationMs: 20_000,
} as const);

export interface PermanentStagingProviderVariableInputAuthority {
  readonly schemaVersion:
    "pintpath-permanent-staging-provider-variable-write-input/v2";
  readonly variableName: string;
  readonly byteLength: number;
  readonly commitmentDomain:
    "pintpath/permanent-staging/provider-variable-write/input-commitment/v1";
  readonly commitmentSha256: string;
  readonly callbackIngressOnly: true;
  readonly stdinSourceAuthorityAvailable: false;
  readonly validUtf8: true;
  readonly controlCharactersAbsent: true;
}

export interface PermanentStagingProviderVariableLocalAuthority {
  readonly schemaVersion:
    "pintpath-permanent-staging-provider-variable-write-local-authority/v2";
  readonly railwayCliVersion: string;
  readonly railwayCliAbsolutePath: string;
  readonly railwayCliSha256: string;
  readonly railwayCliBytes: number;
  readonly railwayCliIdentitySha256: string;
  readonly absoluteCanonicalNonSymlinkPath: true;
  readonly regularFile: true;
  readonly currentUid: true;
  readonly mode0555: true;
  readonly nlinkOne: true;
  readonly descriptorHeld: true;
  readonly pathAndDescriptorIdentityExact: true;
  readonly bytesHashedFromHeldDescriptor: true;
  readonly privateExecutableCopyAbsolutePath: string;
  readonly privateExecutableCopySha256: string;
  readonly privateExecutableCopyBytes: number;
  readonly privateExecutableCopyIdentitySha256: string;
  readonly privateExecutableCopyAuthoritySha256: string;
  readonly environmentAuthoritySha256: string;
  readonly stdinAuthoritySha256: string;
  readonly processGroupAuthoritySha256: string;
  readonly processAdapterAuthoritySha256: string;
  readonly privateExecutableCopyDescriptorHeld: true;
  readonly privateExecutableCopyParentMode0700: true;
  readonly processAdapterInjectedSpawnOnly: true;
  readonly providerInvokedDuringInspection: false;
}

export interface PermanentStagingProviderVariableBoundaryAuthority {
  readonly schemaVersion:
    "pintpath-permanent-staging-provider-variable-boundary-authority/v1";
  readonly projectId: string;
  readonly productionEnvironmentId: string;
  readonly stagingEnvironmentId: string;
  readonly productionTokenExact: boolean;
  readonly stagingTokenExact: boolean;
  readonly productionPatchEmpty: boolean;
  readonly stagingPatchEmpty: boolean;
  readonly productionBaselineExact: boolean;
  readonly stagingScopeExact: boolean;
  readonly mutationPolicyExact: boolean;
  readonly snapshotSha256: string;
}

export interface PermanentStagingProviderVariableTargetPreflight {
  readonly schemaVersion:
    "pintpath-permanent-staging-provider-variable-target-preflight/v1";
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly variableName: string;
  readonly inventoryComplete: boolean;
  readonly targetAbsent: boolean;
  readonly sharedShadowAbsent: boolean;
  readonly metadataInventorySha256: string;
  readonly deploymentInventorySha256: string;
  readonly deploymentInventoryComplete: boolean;
}

export interface PermanentStagingProviderVariableInventoryPageTranscript {
  readonly requestedAfter: string | null;
  readonly source: string;
}

export interface PermanentStagingProviderVariablePreflightLineage {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_PREFLIGHT_LINEAGE_SCHEMA;
  readonly variablePages:
    readonly PermanentStagingProviderVariableInventoryPageTranscript[];
  readonly deploymentPages:
    readonly PermanentStagingProviderVariableInventoryPageTranscript[];
}

export interface PermanentStagingProviderVariableTargetPreflightObservation {
  readonly authority: PermanentStagingProviderVariableTargetPreflight;
  readonly recoveryLineage: PermanentStagingProviderVariablePreflightLineage;
}

export interface PermanentStagingProviderVariableTargetPostflight {
  readonly schemaVersion:
    "pintpath-permanent-staging-provider-variable-target-postflight/v1";
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly variableName: string;
  readonly inventoryComplete: boolean;
  readonly targetPresent: boolean;
  readonly sharedShadowAbsent: boolean;
  readonly expectedMetadataExact: boolean;
  readonly metadataDeltaExact: boolean;
  readonly beforeMetadataInventorySha256: string;
  readonly currentMetadataInventorySha256: string;
  readonly beforeDeploymentInventorySha256: string;
  readonly currentDeploymentInventorySha256: string;
  readonly deploymentInventoryComplete: boolean;
  readonly deploymentUnchanged: boolean;
}

export interface PermanentStagingProviderVariableWriteAcknowledgement {
  readonly schemaVersion:
    "pintpath-permanent-staging-provider-variable-write-local-receipt/v3";
  readonly variableName: string;
  readonly inputCommitmentSha256: string;
  readonly intentSha256: string;
  readonly localAuthoritySha256: string;
  readonly commandSha256: string;
  readonly processAdapterAuthoritySha256: string;
  readonly privateExecutableCopyAuthoritySha256: string;
  readonly environmentAuthoritySha256: string;
  readonly stdinAuthoritySha256: string;
  readonly processGroupAuthoritySha256: string;
  readonly processAdapterReceiptSha256: string;
  readonly childAttempts: number;
  readonly stdinWrites: number;
  readonly exitCode: number;
  readonly signal: null;
  readonly stdoutBytesCaptured: number;
  readonly stderrBytesCaptured: number;
  readonly childCloseAwaited: boolean;
  readonly environmentNullPrototype: boolean;
  readonly stdinWriteCompleted: boolean;
  readonly stdinEof: boolean;
  readonly detachedProcessGroup: boolean;
  readonly processGroupEmpty: boolean;
  readonly closeAndErrorSettled: boolean;
  readonly providerAcknowledgementInspected: boolean;
}

export interface PermanentStagingProviderVariableCleanupAuthority {
  readonly schemaVersion:
    "pintpath-permanent-staging-provider-variable-cleanup-authority/v1";
  readonly inputZeroized: boolean;
  readonly inputClosed: boolean;
  readonly localAuthorityClosed: boolean;
  readonly childReaped: boolean;
  readonly temporaryArtifactsRemoved: boolean;
}

export interface PermanentStagingProviderVariableDurableArtifactEvidence {
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

export interface PermanentStagingProviderVariableExistingIntent {
  readonly leaf: string;
  readonly canonical: string;
  readonly evidence: PermanentStagingProviderVariableDurableArtifactEvidence;
}

export interface PermanentStagingProviderVariableExistingTerminalEvidence {
  readonly leaf: string;
  readonly canonical: string;
  readonly evidence: PermanentStagingProviderVariableDurableArtifactEvidence;
}

export interface PermanentStagingProviderVariableWriteKernelDependencies {
  readonly inspectTerminalEvidence: (
    operation: PermanentStagingProviderVariableWriteOperation,
    signal: AbortSignal,
  ) => Promise<PermanentStagingProviderVariableExistingTerminalEvidence | null>;
  readonly inspectInput: (
    operation: PermanentStagingProviderVariableWriteOperation,
    signal: AbortSignal,
  ) => Promise<PermanentStagingProviderVariableInputAuthority>;
  readonly inspectLocalAuthority: (
    operation: PermanentStagingProviderVariableWriteOperation,
    signal: AbortSignal,
  ) => Promise<PermanentStagingProviderVariableLocalAuthority>;
  readonly inspectBoundary: (
    signal: AbortSignal,
  ) => Promise<PermanentStagingProviderVariableBoundaryAuthority>;
  readonly inspectTargetPreflight: (
    operation: PermanentStagingProviderVariableWriteOperation,
    signal: AbortSignal,
  ) => Promise<PermanentStagingProviderVariableTargetPreflightObservation>;
  readonly inspectIntent: (
    operation: PermanentStagingProviderVariableWriteOperation,
    signal: AbortSignal,
  ) => Promise<PermanentStagingProviderVariableExistingIntent | null>;
  readonly persistIntent: (
    operation: PermanentStagingProviderVariableWriteOperation,
    canonicalIntent: string,
    signal: AbortSignal,
  ) => Promise<PermanentStagingProviderVariableDurableArtifactEvidence>;
  readonly writeExactlyOnce: (
    operation: PermanentStagingProviderVariableWriteOperation,
    intentSha256: string,
    attemptAuthority:
      PermanentStagingProviderVariableWriteLocalAttemptAuthority,
    signal: AbortSignal,
  ) => Promise<PermanentStagingProviderVariableWriteAcknowledgement>;
  readonly inspectTargetPostflight: (
    operation: PermanentStagingProviderVariableWriteOperation,
    intent: PermanentStagingProviderVariableWriteIntent,
    preflight: PermanentStagingProviderVariableCreatePreflightCandidate,
    signal: AbortSignal,
  ) => Promise<PermanentStagingProviderVariableTargetPostflight>;
  readonly persistTerminalEvidence: (
    operation: PermanentStagingProviderVariableWriteOperation,
    canonicalTerminalEvidence: string,
    signal: AbortSignal,
  ) => Promise<PermanentStagingProviderVariableDurableArtifactEvidence>;
  readonly cleanup: (
    signal: AbortSignal,
  ) => Promise<PermanentStagingProviderVariableCleanupAuthority>;
  readonly finalize: (signal: AbortSignal) => Promise<boolean>;
}

const KERNEL_DEPENDENCY_NAMES = SAFE_OBJECT_FREEZE([
  "inspectTerminalEvidence",
  "inspectInput",
  "inspectLocalAuthority",
  "inspectBoundary",
  "inspectTargetPreflight",
  "inspectIntent",
  "persistIntent",
  "writeExactlyOnce",
  "inspectTargetPostflight",
  "persistTerminalEvidence",
  "cleanup",
  "finalize",
] as const satisfies readonly (keyof
PermanentStagingProviderVariableWriteKernelDependencies)[]);

type CapturedKernelDependencies = Readonly<
  PermanentStagingProviderVariableWriteKernelDependencies & {
    readonly receiver: object;
  }
>;

function captureKernelDependencies(
  value: unknown,
): CapturedKernelDependencies {
  if (
    typeof value !== "object"
    || value === null
    || SAFE_ARRAY_IS_ARRAY(value)
    || SAFE_REFLECT_APPLY(SAFE_UTIL_IS_PROXY, SAFE_UTIL_TYPES, [value]) === true
  ) throw kernelError("dependencies_invalid");
  const prototype = SAFE_OBJECT_GET_PROTOTYPE_OF(value);
  if (prototype !== SAFE_OBJECT_PROTOTYPE && prototype !== null) {
    throw kernelError("dependencies_invalid");
  }
  const keys = SAFE_REFLECT_OWN_KEYS(value);
  if (keys.length !== KERNEL_DEPENDENCY_NAMES.length) {
    throw kernelError("dependencies_invalid");
  }
  const captured = SAFE_OBJECT_CREATE(null) as Record<PropertyKey, unknown>;
  SAFE_OBJECT_DEFINE_PROPERTY(captured, "receiver", {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
  for (let index = 0; index < KERNEL_DEPENDENCY_NAMES.length; index += 1) {
    const name = KERNEL_DEPENDENCY_NAMES[index]!;
    const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, name);
    if (
      descriptor === undefined
      || !SAFE_OBJECT_HAS_OWN(descriptor, "value")
      || descriptor.enumerable !== true
      || typeof descriptor.value !== "function"
    ) throw kernelError("dependencies_invalid");
    SAFE_OBJECT_DEFINE_PROPERTY(captured, name, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  return SAFE_OBJECT_FREEZE(captured) as CapturedKernelDependencies;
}

function applyDependency<TArguments extends readonly unknown[], TResult>(
  capability: (...args: TArguments) => TResult,
  receiver: object,
  args: TArguments,
): TResult {
  return SAFE_REFLECT_APPLY(capability, receiver, args) as TResult;
}

export interface PermanentStagingProviderVariableWriteIntent {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INTENT_SCHEMA;
  readonly policySha256: string;
  readonly operationId: string;
  readonly variableName: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceId: string;
  readonly valueByteLength: number;
  readonly valueCommitmentSha256: string;
  readonly localAuthoritySha256: string;
  readonly commandSha256: string;
  readonly processAdapterAuthoritySha256: string;
  readonly privateExecutableCopyAuthoritySha256: string;
  readonly environmentAuthoritySha256: string;
  readonly stdinAuthoritySha256: string;
  readonly processGroupAuthoritySha256: string;
  readonly boundarySnapshotSha256: string;
  readonly metadataInventorySha256: string;
  readonly deploymentInventorySha256: string;
  readonly preflightLineage: PermanentStagingProviderVariablePreflightLineage;
  readonly expectedBefore: "absent";
  readonly sequentialNotAtomic: true;
  readonly externalMutationFreezeRequired: true;
}

export interface PermanentStagingProviderVariableWriteKernelChecks {
  frameworkEnabled: boolean;
  policyExact: boolean;
  inputHeldAndBound: boolean;
  localAuthorityExact: boolean;
  boundaryPreflightExact: boolean;
  targetPreflightExact: boolean;
  durableIntentExact: boolean;
  inputReasserted: boolean;
  localAuthorityReasserted: boolean;
  boundaryReasserted: boolean;
  targetReasserted: boolean;
  writeAttempted: boolean;
  acknowledgementExact: boolean;
  postflightAttempted: boolean;
  boundaryPostflightExact: boolean;
  targetPostflightExact: boolean;
  deploymentUnchanged: boolean;
  localPostflightExact: boolean;
  inputCleanupExact: boolean;
  cleanupExact: boolean;
  terminalEvidenceExact: boolean;
  finalizationExact: boolean;
}

export type PermanentStagingProviderVariableWriteKernelOutcome =
  | "acknowledged_pending_runtime_proof"
  | "failed"
  | "mutation_uncertain"
  | "cleanup_failed";

export interface PermanentStagingProviderVariableWriteKernelReceipt {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_KERNEL_SCHEMA;
  readonly executorState:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE;
  readonly mode: "internal-review-only-create";
  readonly outcome: PermanentStagingProviderVariableWriteKernelOutcome;
  readonly operationId: string;
  readonly variableName: string;
  readonly intentSha256: string | null;
  readonly terminalEvidenceSha256: string | null;
  readonly writeAcknowledgementSha256: string | null;
  readonly recoveryOnly: boolean;
  readonly runtimeValueProof: false;
  readonly activationAuthorized: false;
  readonly checks: PermanentStagingProviderVariableWriteKernelChecks;
}

export interface PermanentStagingProviderVariableWriteTerminalEvidence {
  readonly schemaVersion:
    typeof PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_TERMINAL_SCHEMA;
  readonly binding: "pre-finalization-receipt";
  readonly operationId: string;
  readonly variableName: string;
  readonly intentLeaf: string;
  readonly terminalEvidenceLeaf: string;
  readonly intentSha256: string;
  readonly preFinalizationReceipt:
    PermanentStagingProviderVariableWriteKernelReceipt;
  readonly preFinalizationReceiptSha256: string;
  readonly runtimeValueProof: false;
  readonly activationAuthorized: false;
}

function digestLowercaseHex(value: unknown): string {
  if (
    typeof SAFE_TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function"
    || !SAFE_REFLECT_APPLY(SAFE_BUFFER_IS_BUFFER, SAFE_BUFFER, [value])
    || !SAFE_REFLECT_APPLY(
      SAFE_ARRAY_BUFFER_IS_VIEW,
      SAFE_ARRAY_BUFFER,
      [value],
    )
    || SAFE_OBJECT_GET_PROTOTYPE_OF(value) !== SAFE_BUFFER_PROTOTYPE
    || SAFE_REFLECT_APPLY(
      SAFE_TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) !== 32
  ) throw kernelError("hash_invalid");
  let output = "";
  for (let index = 0; index < 32; index += 1) {
    const byte = (value as Buffer)[index];
    if (
      typeof byte !== "number"
      || !SAFE_NUMBER_IS_SAFE_INTEGER(byte)
      || byte < 0
      || byte > 0xff
    ) {
      throw kernelError("hash_invalid");
    }
    output += LOWERCASE_HEX[byte >>> 4] ?? "";
    output += LOWERCASE_HEX[byte & 0x0f] ?? "";
  }
  if (output.length !== 64) throw kernelError("hash_invalid");
  return output;
}

function sha256(value: string): string {
  const hash = SAFE_REFLECT_APPLY(
    SAFE_CRYPTO_CREATE_HASH,
    SAFE_CRYPTO,
    ["sha256"],
  ) as ReturnType<typeof crypto.createHash>;
  SAFE_REFLECT_APPLY(SAFE_CRYPTO_HASH_UPDATE, hash, [value, "utf8"]);
  const digest = SAFE_REFLECT_APPLY(
    SAFE_CRYPTO_HASH_DIGEST,
    hash,
    [],
  );
  return digestLowercaseHex(digest);
}

function canonical(value: unknown): string {
  let nodes = 0;
  const seen = new SAFE_WEAK_SET<object>();
  const serialize = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (
      nodes > MAX_DEPENDENCY_SNAPSHOT_NODES
      || depth > MAX_DEPENDENCY_SNAPSHOT_DEPTH
    ) throw kernelError("canonical_data_invalid");
    if (candidate === null) return "null";
    if (typeof candidate === "boolean") return candidate ? "true" : "false";
    if (typeof candidate === "string") {
      if (
        SAFE_BUFFER_BYTE_LENGTH(candidate, "utf8")
          > MAX_DEPENDENCY_STRING_BYTES
      ) throw kernelError("canonical_data_invalid");
      const encoded = SAFE_JSON_STRINGIFY(candidate);
      if (typeof encoded !== "string") throw kernelError("canonical_data_invalid");
      return encoded;
    }
    if (typeof candidate === "number") {
      if (!SAFE_NUMBER_IS_FINITE(candidate)) {
        throw kernelError("canonical_data_invalid");
      }
      const encoded = SAFE_JSON_STRINGIFY(candidate);
      if (typeof encoded !== "string") throw kernelError("canonical_data_invalid");
      return encoded;
    }
    if (typeof candidate !== "object") throw kernelError("canonical_data_invalid");
    if (SAFE_REFLECT_APPLY(SAFE_WEAK_SET_HAS, seen, [candidate]) === true) {
      throw kernelError("canonical_data_invalid");
    }
    SAFE_REFLECT_APPLY(SAFE_WEAK_SET_ADD, seen, [candidate]);

    const prototype = SAFE_OBJECT_GET_PROTOTYPE_OF(candidate);
    const keys = SAFE_REFLECT_OWN_KEYS(candidate);
    if (SAFE_ARRAY_IS_ARRAY(candidate)) {
      if (prototype !== SAFE_ARRAY_PROTOTYPE) {
        throw kernelError("canonical_data_invalid");
      }
      const lengthDescriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
        candidate,
        "length",
      );
      if (
        lengthDescriptor === undefined
        || !SAFE_OBJECT_HAS_OWN(lengthDescriptor, "value")
        || !SAFE_NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > MAX_DEPENDENCY_ARRAY_LENGTH
        || keys.length !== lengthDescriptor.value + 1
      ) throw kernelError("canonical_data_invalid");
      let serialized = "[";
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
          candidate,
          SAFE_REFLECT_APPLY(
            SAFE_STRING_CONSTRUCTOR,
            undefined,
            [index],
          ) as string,
        );
        if (
          descriptor === undefined
          || !SAFE_OBJECT_HAS_OWN(descriptor, "value")
          || descriptor.enumerable !== true
        ) throw kernelError("canonical_data_invalid");
        if (index > 0) serialized += ",";
        serialized += serialize(descriptor.value, depth + 1);
      }
      return `${serialized}]`;
    }

    if (
      prototype !== SAFE_OBJECT_PROTOTYPE
      && prototype !== null
      || keys.length > MAX_DEPENDENCY_OBJECT_KEYS
    ) throw kernelError("canonical_data_invalid");
    let serialized = "{";
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") throw kernelError("canonical_data_invalid");
      const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(candidate, key);
      if (
        descriptor === undefined
        || !SAFE_OBJECT_HAS_OWN(descriptor, "value")
        || descriptor.enumerable !== true
      ) throw kernelError("canonical_data_invalid");
      if (
        SAFE_BUFFER_BYTE_LENGTH(key, "utf8") > MAX_DEPENDENCY_STRING_BYTES
      ) throw kernelError("canonical_data_invalid");
      const encodedKey = SAFE_JSON_STRINGIFY(key);
      if (typeof encodedKey !== "string") throw kernelError("canonical_data_invalid");
      if (index > 0) serialized += ",";
      serialized += `${encodedKey}:${serialize(descriptor.value, depth + 1)}`;
    }
    return `${serialized}}`;
  };
  return serialize(value, 0);
}

function canonicalSha256(domain: string, value: unknown): string {
  const hash = SAFE_REFLECT_APPLY(
    SAFE_CRYPTO_CREATE_HASH,
    SAFE_CRYPTO,
    ["sha256"],
  ) as ReturnType<typeof crypto.createHash>;
  SAFE_REFLECT_APPLY(SAFE_CRYPTO_HASH_UPDATE, hash, [domain, "utf8"]);
  SAFE_REFLECT_APPLY(
    SAFE_CRYPTO_HASH_UPDATE,
    hash,
    [canonical(value), "utf8"],
  );
  const digest = SAFE_REFLECT_APPLY(
    SAFE_CRYPTO_HASH_DIGEST,
    hash,
    [],
  );
  return digestLowercaseHex(digest);
}

function sha256StringExact(value: unknown): value is string {
  return typeof value === "string"
    && SAFE_REFLECT_APPLY(SAFE_REGEXP_TEST, SHA256_PATTERN, [value]) === true;
}

function exactObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || SAFE_ARRAY_IS_ARRAY(value)) {
    return false;
  }
  const keys = SAFE_OBJECT_KEYS(value);
  if (keys.length !== expectedKeys.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] !== expectedKeys[index]) return false;
  }
  return true;
}

function snapshotDependencyResult<T>(input: T): T {
  let nodes = 0;
  const seen = new SAFE_WEAK_SET<object>();
  const snapshot = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (
      nodes > MAX_DEPENDENCY_SNAPSHOT_NODES
      || depth > MAX_DEPENDENCY_SNAPSHOT_DEPTH
    ) throw kernelError("dependency_result_invalid");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (
        SAFE_BUFFER_BYTE_LENGTH(value, "utf8")
          > MAX_DEPENDENCY_STRING_BYTES
      ) {
        throw kernelError("dependency_result_invalid");
      }
      return value;
    }
    if (typeof value === "number") {
      if (!SAFE_NUMBER_IS_FINITE(value)) {
        throw kernelError("dependency_result_invalid");
      }
      return value;
    }
    if (
      typeof value !== "object"
      || SAFE_REFLECT_APPLY(SAFE_WEAK_SET_HAS, seen, [value]) === true
    ) {
      throw kernelError("dependency_result_invalid");
    }
    SAFE_REFLECT_APPLY(SAFE_WEAK_SET_ADD, seen, [value]);
    const prototype = SAFE_OBJECT_GET_PROTOTYPE_OF(value);
    const keys = SAFE_REFLECT_OWN_KEYS(value);
    if (SAFE_ARRAY_IS_ARRAY(value)) {
      if (prototype !== SAFE_ARRAY_PROTOTYPE) {
        throw kernelError("dependency_result_invalid");
      }
      const lengthDescriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
        value,
        "length",
      );
      if (
        !lengthDescriptor
        || !SAFE_OBJECT_HAS_OWN(lengthDescriptor, "value")
        || !SAFE_NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > MAX_DEPENDENCY_ARRAY_LENGTH
        || keys.length !== lengthDescriptor.value + 1
      ) throw kernelError("dependency_result_invalid");
      const output: unknown[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
          value,
          SAFE_REFLECT_APPLY(
            SAFE_STRING_CONSTRUCTOR,
            undefined,
            [index],
          ) as string,
        );
        if (
          !descriptor
          || !SAFE_OBJECT_HAS_OWN(descriptor, "value")
          || descriptor.enumerable !== true
        ) throw kernelError("dependency_result_invalid");
        if (!appendOwnArrayItem(
          output,
          snapshot(descriptor.value, depth + 1),
        )) throw kernelError("dependency_result_invalid");
      }
      return SAFE_OBJECT_FREEZE(output);
    }
    if (
      prototype !== SAFE_OBJECT_PROTOTYPE
      && prototype !== null
      || keys.length > MAX_DEPENDENCY_OBJECT_KEYS
    ) throw kernelError("dependency_result_invalid");
    const output = SAFE_OBJECT_CREATE(null) as Record<string, unknown>;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string") throw kernelError("dependency_result_invalid");
      const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
      if (
        !descriptor
        || !SAFE_OBJECT_HAS_OWN(descriptor, "value")
        || descriptor.enumerable !== true
      ) throw kernelError("dependency_result_invalid");
      SAFE_OBJECT_DEFINE_PROPERTY(output, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: snapshot(descriptor.value, depth + 1),
      });
    }
    return SAFE_OBJECT_FREEZE(output);
  };
  return snapshot(input, 0) as T;
}

async function withDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (typeof SAFE_ABORT_CONTROLLER_SIGNAL !== "function") {
    throw kernelError("operation_timeout");
  }
  const controller = new SAFE_ABORT_CONTROLLER();
  const signal = SAFE_REFLECT_APPLY(
    SAFE_ABORT_CONTROLLER_SIGNAL,
    controller,
    [],
  ) as AbortSignal;
  let timedOut = false;
  const timeout = SAFE_REFLECT_APPLY(SAFE_SET_TIMEOUT, SAFE_GLOBAL_THIS, [() => {
    timedOut = true;
    SAFE_REFLECT_APPLY(SAFE_ABORT_CONTROLLER_ABORT, controller, []);
  }, timeoutMs]) as ReturnType<typeof setTimeout>;
  try {
    let result: T;
    try {
      result = await operation(signal);
    } catch (error) {
      if (timedOut) throw kernelError("operation_timeout");
      throw error;
    }
    if (timedOut) throw kernelError("operation_timeout");
    return result;
  } finally {
    SAFE_REFLECT_APPLY(SAFE_CLEAR_TIMEOUT, SAFE_GLOBAL_THIS, [timeout]);
  }
}

function initialChecks(): PermanentStagingProviderVariableWriteKernelChecks {
  return {
    frameworkEnabled: true,
    policyExact: true,
    inputHeldAndBound: false,
    localAuthorityExact: false,
    boundaryPreflightExact: false,
    targetPreflightExact: false,
    durableIntentExact: false,
    inputReasserted: false,
    localAuthorityReasserted: false,
    boundaryReasserted: false,
    targetReasserted: false,
    writeAttempted: false,
    acknowledgementExact: false,
    postflightAttempted: false,
    boundaryPostflightExact: false,
    targetPostflightExact: false,
    deploymentUnchanged: false,
    localPostflightExact: false,
    inputCleanupExact: false,
    cleanupExact: false,
    terminalEvidenceExact: false,
    finalizationExact: false,
  };
}

function operationFromId(
  operationId: unknown,
): PermanentStagingProviderVariableWriteOperation | null {
  if (typeof operationId !== "string") return null;
  for (
    let index = 0;
    index < PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS.length;
    index += 1
  ) {
    const candidate = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS[index];
    if (candidate?.operationId === operationId) return candidate;
  }
  return null;
}

function inputAuthorityExact(
  value: PermanentStagingProviderVariableInputAuthority,
  operation: PermanentStagingProviderVariableWriteOperation,
): boolean {
  return value.schemaVersion
      === "pintpath-permanent-staging-provider-variable-write-input/v2"
    && value.variableName === operation.variableName
    && SAFE_NUMBER_IS_SAFE_INTEGER(value.byteLength)
    && value.byteLength > 0
    && value.byteLength
      <= PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.writeContract
        .maximumValueBytes
    && value.commitmentDomain
      === "pintpath/permanent-staging/provider-variable-write/input-commitment/v1"
    && sha256StringExact(value.commitmentSha256)
    && value.callbackIngressOnly === true
    && value.stdinSourceAuthorityAvailable === false
    && value.validUtf8 === true
    && value.controlCharactersAbsent === true;
}

function sameInputAuthority(
  left: PermanentStagingProviderVariableInputAuthority,
  right: PermanentStagingProviderVariableInputAuthority,
): boolean {
  let operation: PermanentStagingProviderVariableWriteOperation | undefined;
  for (
    let index = 0;
    index < PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS.length;
    index += 1
  ) {
    const candidate = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_OPERATIONS[index];
    if (candidate?.variableName === left.variableName) {
      operation = candidate;
      break;
    }
  }
  return operation !== undefined
    && inputAuthorityExact(right, operation)
    && canonical(left) === canonical(right);
}

function localAuthorityExact(
  value: PermanentStagingProviderVariableLocalAuthority,
): boolean {
  const lock = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK;
  if (!exactObjectKeys(value, [
    "schemaVersion",
    "railwayCliVersion",
    "railwayCliAbsolutePath",
    "railwayCliSha256",
    "railwayCliBytes",
    "railwayCliIdentitySha256",
    "absoluteCanonicalNonSymlinkPath",
    "regularFile",
    "currentUid",
    "mode0555",
    "nlinkOne",
    "descriptorHeld",
    "pathAndDescriptorIdentityExact",
    "bytesHashedFromHeldDescriptor",
    "privateExecutableCopyAbsolutePath",
    "privateExecutableCopySha256",
    "privateExecutableCopyBytes",
    "privateExecutableCopyIdentitySha256",
    "privateExecutableCopyAuthoritySha256",
    "environmentAuthoritySha256",
    "stdinAuthoritySha256",
    "processGroupAuthoritySha256",
    "processAdapterAuthoritySha256",
    "privateExecutableCopyDescriptorHeld",
    "privateExecutableCopyParentMode0700",
    "processAdapterInjectedSpawnOnly",
    "providerInvokedDuringInspection",
  ])) return false;
  return value.schemaVersion
      === "pintpath-permanent-staging-provider-variable-write-local-authority/v2"
    && value.railwayCliAbsolutePath === lock.railwayCli.absolutePath
    && value.railwayCliVersion === lock.railwayCli.version
    && value.railwayCliSha256 === lock.railwayCli.sha256
    && SAFE_NUMBER_IS_SAFE_INTEGER(value.railwayCliBytes)
    && value.railwayCliBytes > 0
    && value.railwayCliBytes <= 32 * 1_024 * 1_024
    && sha256StringExact(value.railwayCliIdentitySha256)
    && value.absoluteCanonicalNonSymlinkPath === true
    && value.regularFile === true
    && value.currentUid === true
    && value.mode0555 === true
    && value.nlinkOne === true
    && value.descriptorHeld === true
    && value.pathAndDescriptorIdentityExact === true
    && value.bytesHashedFromHeldDescriptor === true
    && typeof value.privateExecutableCopyAbsolutePath === "string"
    && value.privateExecutableCopyAbsolutePath.length > 0
    && value.privateExecutableCopyAbsolutePath !== value.railwayCliAbsolutePath
    && value.privateExecutableCopySha256 === value.railwayCliSha256
    && value.privateExecutableCopyBytes === value.railwayCliBytes
    && sha256StringExact(value.privateExecutableCopyIdentitySha256)
    && sha256StringExact(value.privateExecutableCopyAuthoritySha256)
    && sha256StringExact(value.environmentAuthoritySha256)
    && sha256StringExact(value.stdinAuthoritySha256)
    && sha256StringExact(value.processGroupAuthoritySha256)
    && sha256StringExact(value.processAdapterAuthoritySha256)
    && value.privateExecutableCopyDescriptorHeld === true
    && value.privateExecutableCopyParentMode0700 === true
    && value.processAdapterInjectedSpawnOnly === true
    && value.providerInvokedDuringInspection === false;
}

function localAuthoritySha256(
  value: PermanentStagingProviderVariableLocalAuthority,
): string {
  return canonicalSha256(LOCAL_AUTHORITY_HASH_DOMAIN, value);
}

function expectedCommand(
  operation: PermanentStagingProviderVariableWriteOperation,
  local: PermanentStagingProviderVariableLocalAuthority,
): unknown {
  const lock = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK;
  return {
    schemaVersion:
      "pintpath-permanent-staging-provider-variable-write-command/v2",
    executable: local.privateExecutableCopyAbsolutePath,
    executableAuthority: {
      privateExecutableCopySha256: local.privateExecutableCopySha256,
      privateExecutableCopyIdentitySha256:
        local.privateExecutableCopyIdentitySha256,
      privateExecutableCopyAuthoritySha256:
        local.privateExecutableCopyAuthoritySha256,
      descriptorHeld: true,
    },
    argv: [
      "variable",
      "set",
      operation.variableName,
      "--stdin",
      "--skip-deploys",
      "--project",
      lock.projectId,
      "--environment",
      lock.stagingEnvironmentId,
      "--service",
      lock.serviceId,
    ],
    environment: {
      inherit: false,
      prototype: "null",
      ownEnumerableDataPropertiesOnly: true,
      exactNames: ["RAILWAY_TOKEN"],
      valuesHandledByThisModule: false,
    },
    shell: false,
    stdin: "pipe",
    stdinWrites: 1,
    stdinEndCalls: 1,
    stdout: "ignore",
    stderr: "ignore",
    maximumCapturedStdoutBytes: 0,
    maximumCapturedStderrBytes: 0,
    detached: true,
    abortSignalSequence: ["SIGTERM", "SIGKILL"],
    processGroupEmptyBeforeSettlement: true,
  };
}

function commandSha256(
  operation: PermanentStagingProviderVariableWriteOperation,
  local: PermanentStagingProviderVariableLocalAuthority,
): string {
  return canonicalSha256(COMMAND_HASH_DOMAIN, expectedCommand(operation, local));
}

function boundaryAuthorityExact(
  value: PermanentStagingProviderVariableBoundaryAuthority,
): boolean {
  const lock = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK;
  return value.schemaVersion
      === "pintpath-permanent-staging-provider-variable-boundary-authority/v1"
    && value.projectId === lock.projectId
    && value.productionEnvironmentId === lock.productionEnvironmentId
    && value.stagingEnvironmentId === lock.stagingEnvironmentId
    && value.productionTokenExact === true
    && value.stagingTokenExact === true
    && value.productionPatchEmpty === true
    && value.stagingPatchEmpty === true
    && value.productionBaselineExact === true
    && value.stagingScopeExact === true
    && value.mutationPolicyExact === true
    && sha256StringExact(value.snapshotSha256);
}

function targetPreflightExact(
  value: PermanentStagingProviderVariableTargetPreflight,
  operation: PermanentStagingProviderVariableWriteOperation,
): boolean {
  if (!exactObjectKeys(value, [
    "schemaVersion",
    "projectId",
    "environmentId",
    "serviceId",
    "variableName",
    "inventoryComplete",
    "targetAbsent",
    "sharedShadowAbsent",
    "metadataInventorySha256",
    "deploymentInventorySha256",
    "deploymentInventoryComplete",
  ])) return false;
  const lock = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK;
  return value.schemaVersion
      === "pintpath-permanent-staging-provider-variable-target-preflight/v1"
    && value.projectId === lock.projectId
    && value.environmentId === lock.stagingEnvironmentId
    && value.serviceId === lock.serviceId
    && value.variableName === operation.variableName
    && value.inventoryComplete === true
    && value.targetAbsent === true
    && value.sharedShadowAbsent === true
    && sha256StringExact(value.metadataInventorySha256)
    && sha256StringExact(value.deploymentInventorySha256)
    && value.deploymentInventoryComplete === true;
}

interface RebuiltPreflightLineage {
  readonly lineage: PermanentStagingProviderVariablePreflightLineage;
  readonly preflight: PermanentStagingProviderVariableCreatePreflightCandidate;
}

interface ExactTargetPreflightObservation
  extends PermanentStagingProviderVariableTargetPreflightObservation {
  readonly preflight: PermanentStagingProviderVariableCreatePreflightCandidate;
}

function denseTranscriptArray(
  value: unknown,
): value is readonly PermanentStagingProviderVariableInventoryPageTranscript[] {
  if (
    !SAFE_ARRAY_IS_ARRAY(value)
    || SAFE_OBJECT_GET_PROTOTYPE_OF(value) !== SAFE_ARRAY_PROTOTYPE
  ) {
    return false;
  }
  const lengthDescriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    value,
    "length",
  );
  if (
    lengthDescriptor === undefined
    || !SAFE_OBJECT_HAS_OWN(lengthDescriptor, "value")
    || !SAFE_NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
    || lengthDescriptor.value < 1
    || lengthDescriptor.value > MAX_PREFLIGHT_LINEAGE_PAGES
    || SAFE_REFLECT_OWN_KEYS(value).length !== lengthDescriptor.value + 1
  ) return false;
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
      value,
      SAFE_REFLECT_APPLY(
        SAFE_STRING_CONSTRUCTOR,
        undefined,
        [index],
      ) as string,
    );
    if (
      descriptor === undefined
      || !SAFE_OBJECT_HAS_OWN(descriptor, "value")
      || descriptor.enumerable !== true
    ) return false;
  }
  return true;
}

function exactCanonicalJsonSource(value: unknown): value is string {
  if (
    typeof value !== "string"
    || SAFE_BUFFER_BYTE_LENGTH(value, "utf8") < 1
    || SAFE_BUFFER_BYTE_LENGTH(value, "utf8")
      > MAX_PREFLIGHT_LINEAGE_CANONICAL_BYTES
  ) return false;
  try {
    return canonical(SAFE_JSON_PARSE(value) as unknown) === value;
  } catch {
    return false;
  }
}

function rebuildPreflightLineage(
  value: unknown,
  variableName: unknown,
): RebuiltPreflightLineage | null {
  if (!exactObjectKeys(value, [
    "schemaVersion",
    "variablePages",
    "deploymentPages",
  ])) return null;
  if (
    value.schemaVersion
      !== PERMANENT_STAGING_PROVIDER_VARIABLE_PREFLIGHT_LINEAGE_SCHEMA
    || !denseTranscriptArray(value.variablePages)
    || !denseTranscriptArray(value.deploymentPages)
  ) return null;
  const variablePages: Array<NonNullable<ReturnType<
    typeof parsePermanentStagingProviderVariableInventoryPage
  >>> = [];
  const deploymentPages: Array<NonNullable<ReturnType<
    typeof parsePermanentStagingProviderDeploymentInventoryPage
  >>> = [];
  const normalizedVariableTranscripts:
  PermanentStagingProviderVariableInventoryPageTranscript[] = [];
  const normalizedDeploymentTranscripts:
  PermanentStagingProviderVariableInventoryPageTranscript[] = [];
  for (let index = 0; index < value.variablePages.length; index += 1) {
    const transcript = value.variablePages[index];
    if (
      !exactObjectKeys(transcript, ["requestedAfter", "source"])
      || !(transcript.requestedAfter === null
        || typeof transcript.requestedAfter === "string")
      || !exactCanonicalJsonSource(transcript.source)
    ) return null;
    const page = parsePermanentStagingProviderVariableInventoryPage(
      transcript.source,
      transcript.requestedAfter,
    );
    if (page === null) return null;
    const normalizedTranscript = SAFE_OBJECT_FREEZE({
      requestedAfter: transcript.requestedAfter,
      source: transcript.source,
    });
    if (
      !appendOwnArrayItem(variablePages, page)
      || !appendOwnArrayItem(
        normalizedVariableTranscripts,
        normalizedTranscript,
      )
    ) return null;
  }
  for (let index = 0; index < value.deploymentPages.length; index += 1) {
    const transcript = value.deploymentPages[index];
    if (
      !exactObjectKeys(transcript, ["requestedAfter", "source"])
      || !(transcript.requestedAfter === null
        || typeof transcript.requestedAfter === "string")
      || !exactCanonicalJsonSource(transcript.source)
    ) return null;
    const page = parsePermanentStagingProviderDeploymentInventoryPage(
      transcript.source,
      transcript.requestedAfter,
    );
    if (page === null) return null;
    const normalizedTranscript = SAFE_OBJECT_FREEZE({
      requestedAfter: transcript.requestedAfter,
      source: transcript.source,
    });
    if (
      !appendOwnArrayItem(deploymentPages, page)
      || !appendOwnArrayItem(
        normalizedDeploymentTranscripts,
        normalizedTranscript,
      )
    ) return null;
  }
  const variableInventory = foldPermanentStagingProviderVariableInventoryPages(
    variablePages,
  );
  const deploymentInventory =
    foldPermanentStagingProviderDeploymentInventoryPages(deploymentPages);
  if (variableInventory === null || deploymentInventory === null) return null;
  const preflight = evaluatePermanentStagingProviderVariableCreatePreflight({
    variableName,
    variableInventory,
    deploymentInventory,
  });
  if (preflight === null) return null;
  const lineage = SAFE_OBJECT_FREEZE({
    schemaVersion:
      PERMANENT_STAGING_PROVIDER_VARIABLE_PREFLIGHT_LINEAGE_SCHEMA,
    variablePages: SAFE_OBJECT_FREEZE(normalizedVariableTranscripts),
    deploymentPages: SAFE_OBJECT_FREEZE(normalizedDeploymentTranscripts),
  } as const satisfies PermanentStagingProviderVariablePreflightLineage);
  if (
    SAFE_BUFFER_BYTE_LENGTH(canonical(lineage), "utf8")
      > MAX_PREFLIGHT_LINEAGE_CANONICAL_BYTES
  ) return null;
  return SAFE_OBJECT_FREEZE({ lineage, preflight });
}

function targetPreflightObservationExact(
  value: PermanentStagingProviderVariableTargetPreflightObservation,
  operation: PermanentStagingProviderVariableWriteOperation,
): ExactTargetPreflightObservation | null {
  if (!exactObjectKeys(value, ["authority", "recoveryLineage"])) return null;
  const authority = value.authority;
  const rebuilt = rebuildPreflightLineage(
    value.recoveryLineage,
    operation.variableName,
  );
  if (
    !targetPreflightExact(authority, operation)
    || rebuilt === null
    || rebuilt.preflight.projectId !== authority.projectId
    || rebuilt.preflight.environmentId !== authority.environmentId
    || rebuilt.preflight.serviceId !== authority.serviceId
    || rebuilt.preflight.variableName !== authority.variableName
    || canonicalSha256(
      VARIABLE_INVENTORY_HASH_DOMAIN,
      rebuilt.preflight.variableInventory,
    ) !== authority.metadataInventorySha256
    || canonicalSha256(
      DEPLOYMENT_INVENTORY_HASH_DOMAIN,
      rebuilt.preflight.deploymentInventory,
    ) !== authority.deploymentInventorySha256
  ) return null;
  return SAFE_OBJECT_FREEZE({
    authority: SAFE_OBJECT_FREEZE({ ...authority }),
    recoveryLineage: rebuilt.lineage,
    preflight: rebuilt.preflight,
  });
}

function targetPostflightExact(
  value: PermanentStagingProviderVariableTargetPostflight,
  operation: PermanentStagingProviderVariableWriteOperation,
  intent: PermanentStagingProviderVariableWriteIntent,
): boolean {
  const lock = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK;
  return value.schemaVersion
      === "pintpath-permanent-staging-provider-variable-target-postflight/v1"
    && value.projectId === lock.projectId
    && value.environmentId === lock.stagingEnvironmentId
    && value.serviceId === lock.serviceId
    && value.variableName === operation.variableName
    && value.inventoryComplete === true
    && value.targetPresent === true
    && value.sharedShadowAbsent === true
    && value.expectedMetadataExact === true
    && value.metadataDeltaExact === true
    && value.beforeMetadataInventorySha256 === intent.metadataInventorySha256
    && sha256StringExact(value.currentMetadataInventorySha256)
    && value.beforeDeploymentInventorySha256
      === intent.deploymentInventorySha256
    && value.currentDeploymentInventorySha256
      === intent.deploymentInventorySha256
    && value.deploymentInventoryComplete === true
    && value.deploymentUnchanged === true;
}

function writeAcknowledgementExact(
  value: PermanentStagingProviderVariableWriteAcknowledgement,
  input: PermanentStagingProviderVariableInputAuthority,
  intent: PermanentStagingProviderVariableWriteIntent,
  expectedIntentSha256: string,
  attemptAuthority:
    PermanentStagingProviderVariableWriteLocalAttemptAuthority,
): boolean {
  if (!consumePermanentStagingProviderVariableWriteLocalReceiptAuthority(
    value,
    attemptAuthority,
  )) return false;
  if (!exactObjectKeys(value, [
    "schemaVersion",
    "variableName",
    "inputCommitmentSha256",
    "intentSha256",
    "localAuthoritySha256",
    "commandSha256",
    "processAdapterAuthoritySha256",
    "privateExecutableCopyAuthoritySha256",
    "environmentAuthoritySha256",
    "stdinAuthoritySha256",
    "processGroupAuthoritySha256",
    "processAdapterReceiptSha256",
    "childAttempts",
    "stdinWrites",
    "exitCode",
    "signal",
    "stdoutBytesCaptured",
    "stderrBytesCaptured",
    "childCloseAwaited",
    "environmentNullPrototype",
    "stdinWriteCompleted",
    "stdinEof",
    "detachedProcessGroup",
    "processGroupEmpty",
    "closeAndErrorSettled",
    "providerAcknowledgementInspected",
  ])) return false;
  return value.schemaVersion
      === "pintpath-permanent-staging-provider-variable-write-local-receipt/v3"
    && value.variableName === input.variableName
    && value.inputCommitmentSha256 === input.commitmentSha256
    && value.intentSha256 === expectedIntentSha256
    && value.localAuthoritySha256 === intent.localAuthoritySha256
    && value.commandSha256 === intent.commandSha256
    && value.processAdapterAuthoritySha256
      === intent.processAdapterAuthoritySha256
    && value.privateExecutableCopyAuthoritySha256
      === intent.privateExecutableCopyAuthoritySha256
    && value.environmentAuthoritySha256 === intent.environmentAuthoritySha256
    && value.stdinAuthoritySha256 === intent.stdinAuthoritySha256
    && value.processGroupAuthoritySha256 === intent.processGroupAuthoritySha256
    && sha256StringExact(value.processAdapterReceiptSha256)
    && value.childAttempts === 1
    && value.stdinWrites === 1
    && value.exitCode === 0
    && value.signal === null
    && value.stdoutBytesCaptured === 0
    && value.stderrBytesCaptured === 0
    && value.childCloseAwaited === true
    && value.environmentNullPrototype === true
    && value.stdinWriteCompleted === true
    && value.stdinEof === true
    && value.detachedProcessGroup === true
    && value.processGroupEmpty === true
    && value.closeAndErrorSettled === true
    && value.providerAcknowledgementInspected === false;
}

function writeAcknowledgementSha256(
  value: PermanentStagingProviderVariableWriteAcknowledgement,
): string {
  return canonicalSha256(WRITE_ACKNOWLEDGEMENT_HASH_DOMAIN, value);
}

function cleanupAuthorityExact(
  value: PermanentStagingProviderVariableCleanupAuthority,
): boolean {
  return value.schemaVersion
      === "pintpath-permanent-staging-provider-variable-cleanup-authority/v1"
    && value.inputZeroized === true
    && value.inputClosed === true
    && value.localAuthorityClosed === true
    && value.childReaped === true
    && value.temporaryArtifactsRemoved === true;
}

function durableArtifactExact(
  evidence: PermanentStagingProviderVariableDurableArtifactEvidence,
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

function makeIntent(
  operation: PermanentStagingProviderVariableWriteOperation,
  input: PermanentStagingProviderVariableInputAuthority,
  local: PermanentStagingProviderVariableLocalAuthority,
  boundary: PermanentStagingProviderVariableBoundaryAuthority,
  target: PermanentStagingProviderVariableTargetPreflightObservation,
): PermanentStagingProviderVariableWriteIntent {
  const lock = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK;
  return {
    schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INTENT_SCHEMA,
    policySha256: sha256(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE,
    ),
    operationId: operation.operationId,
    variableName: operation.variableName,
    projectId: lock.projectId,
    environmentId: lock.stagingEnvironmentId,
    serviceId: lock.serviceId,
    valueByteLength: input.byteLength,
    valueCommitmentSha256: input.commitmentSha256,
    localAuthoritySha256: localAuthoritySha256(local),
    commandSha256: commandSha256(operation, local),
    processAdapterAuthoritySha256: local.processAdapterAuthoritySha256,
    privateExecutableCopyAuthoritySha256:
      local.privateExecutableCopyAuthoritySha256,
    environmentAuthoritySha256: local.environmentAuthoritySha256,
    stdinAuthoritySha256: local.stdinAuthoritySha256,
    processGroupAuthoritySha256: local.processGroupAuthoritySha256,
    boundarySnapshotSha256: boundary.snapshotSha256,
    metadataInventorySha256: target.authority.metadataInventorySha256,
    deploymentInventorySha256: target.authority.deploymentInventorySha256,
    preflightLineage: target.recoveryLineage,
    expectedBefore: "absent",
    sequentialNotAtomic: true,
    externalMutationFreezeRequired: true,
  };
}

function freshIntentAuthorityExact(
  value: PermanentStagingProviderVariableWriteIntent,
  operation: PermanentStagingProviderVariableWriteOperation,
  input: PermanentStagingProviderVariableInputAuthority,
  local: PermanentStagingProviderVariableLocalAuthority,
  boundary: PermanentStagingProviderVariableBoundaryAuthority,
  target: ExactTargetPreflightObservation,
): boolean {
  const lock = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK;
  return value.schemaVersion
      === PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INTENT_SCHEMA
    && value.policySha256 === sha256(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE,
    )
    && value.operationId === operation.operationId
    && value.variableName === operation.variableName
    && value.projectId === lock.projectId
    && value.environmentId === lock.stagingEnvironmentId
    && value.serviceId === lock.serviceId
    && value.valueByteLength === input.byteLength
    && value.valueCommitmentSha256 === input.commitmentSha256
    && value.localAuthoritySha256 === localAuthoritySha256(local)
    && value.commandSha256 === commandSha256(operation, local)
    && value.processAdapterAuthoritySha256
      === local.processAdapterAuthoritySha256
    && value.privateExecutableCopyAuthoritySha256
      === local.privateExecutableCopyAuthoritySha256
    && value.environmentAuthoritySha256 === local.environmentAuthoritySha256
    && value.stdinAuthoritySha256 === local.stdinAuthoritySha256
    && value.processGroupAuthoritySha256 === local.processGroupAuthoritySha256
    && value.boundarySnapshotSha256 === boundary.snapshotSha256
    && value.metadataInventorySha256
      === target.authority.metadataInventorySha256
    && value.deploymentInventorySha256
      === target.authority.deploymentInventorySha256
    && canonical(value.preflightLineage) === canonical(target.recoveryLineage)
    && value.expectedBefore === "absent"
    && value.sequentialNotAtomic === true
    && value.externalMutationFreezeRequired === true;
}

function parseIntent(value: unknown): PermanentStagingProviderVariableWriteIntent | null {
  if (
    typeof value !== "string"
    || SAFE_BUFFER_BYTE_LENGTH(value, "utf8") > MAX_INTENT_CANONICAL_BYTES
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = SAFE_JSON_PARSE(value) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || SAFE_ARRAY_IS_ARRAY(parsed)) {
    return null;
  }
  const candidate = snapshotDependencyResult(parsed) as
    Partial<PermanentStagingProviderVariableWriteIntent>;
  const expectedKeys = [
    "schemaVersion",
    "policySha256",
    "operationId",
    "variableName",
    "projectId",
    "environmentId",
    "serviceId",
    "valueByteLength",
    "valueCommitmentSha256",
    "localAuthoritySha256",
    "commandSha256",
    "processAdapterAuthoritySha256",
    "privateExecutableCopyAuthoritySha256",
    "environmentAuthoritySha256",
    "stdinAuthoritySha256",
    "processGroupAuthoritySha256",
    "boundarySnapshotSha256",
    "metadataInventorySha256",
    "deploymentInventorySha256",
    "preflightLineage",
    "expectedBefore",
    "sequentialNotAtomic",
    "externalMutationFreezeRequired",
  ];
  if (
    canonical(candidate) !== value
    || !exactObjectKeys(candidate, expectedKeys)
    || candidate.schemaVersion
      !== PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_INTENT_SCHEMA
    || !sha256StringExact(candidate.policySha256)
    || typeof candidate.operationId !== "string"
    || typeof candidate.variableName !== "string"
    || typeof candidate.projectId !== "string"
    || typeof candidate.environmentId !== "string"
    || typeof candidate.serviceId !== "string"
    || !SAFE_NUMBER_IS_SAFE_INTEGER(candidate.valueByteLength)
    || (candidate.valueByteLength ?? 0) < 1
    || !sha256StringExact(candidate.valueCommitmentSha256)
    || !sha256StringExact(candidate.localAuthoritySha256)
    || !sha256StringExact(candidate.commandSha256)
    || !sha256StringExact(candidate.processAdapterAuthoritySha256)
    || !sha256StringExact(candidate.privateExecutableCopyAuthoritySha256)
    || !sha256StringExact(candidate.environmentAuthoritySha256)
    || !sha256StringExact(candidate.stdinAuthoritySha256)
    || !sha256StringExact(candidate.processGroupAuthoritySha256)
    || !sha256StringExact(candidate.boundarySnapshotSha256)
    || !sha256StringExact(candidate.metadataInventorySha256)
    || !sha256StringExact(candidate.deploymentInventorySha256)
    || candidate.expectedBefore !== "absent"
    || candidate.sequentialNotAtomic !== true
    || candidate.externalMutationFreezeRequired !== true
  ) return null;
  const intent = candidate as PermanentStagingProviderVariableWriteIntent;
  const rebuilt = rebuildPreflightLineage(
    intent.preflightLineage,
    intent.variableName,
  );
  if (
    rebuilt === null
    || canonical(rebuilt.lineage) !== canonical(intent.preflightLineage)
    || rebuilt.preflight.projectId !== intent.projectId
    || rebuilt.preflight.environmentId !== intent.environmentId
    || rebuilt.preflight.serviceId !== intent.serviceId
    || rebuilt.preflight.variableName !== intent.variableName
    || canonicalSha256(
      VARIABLE_INVENTORY_HASH_DOMAIN,
      rebuilt.preflight.variableInventory,
    ) !== intent.metadataInventorySha256
    || canonicalSha256(
      DEPLOYMENT_INVENTORY_HASH_DOMAIN,
      rebuilt.preflight.deploymentInventory,
    ) !== intent.deploymentInventorySha256
  ) return null;
  return intent;
}

function existingIntentExact(
  existing: PermanentStagingProviderVariableExistingIntent,
  operation: PermanentStagingProviderVariableWriteOperation,
  input: PermanentStagingProviderVariableInputAuthority,
  local: PermanentStagingProviderVariableLocalAuthority,
  boundary: PermanentStagingProviderVariableBoundaryAuthority,
): PermanentStagingProviderVariableWriteIntent | null {
  if (!exactObjectKeys(existing, ["leaf", "canonical", "evidence"])) return null;
  const intent = parseIntent(existing.canonical);
  const lock = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK;
  if (
    !intent
    || existing.leaf !== operation.intentLeaf
    || !durableArtifactExact(existing.evidence, sha256(existing.canonical))
    || existing.evidence.publication !== "existing-exact"
    || intent.policySha256 !== sha256(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE,
    )
    || intent.operationId !== operation.operationId
    || intent.variableName !== operation.variableName
    || intent.projectId !== lock.projectId
    || intent.environmentId !== lock.stagingEnvironmentId
    || intent.serviceId !== lock.serviceId
    || intent.valueByteLength !== input.byteLength
    || intent.valueCommitmentSha256 !== input.commitmentSha256
    || intent.localAuthoritySha256 !== localAuthoritySha256(local)
    || intent.commandSha256 !== commandSha256(operation, local)
    || intent.processAdapterAuthoritySha256
      !== local.processAdapterAuthoritySha256
    || intent.privateExecutableCopyAuthoritySha256
      !== local.privateExecutableCopyAuthoritySha256
    || intent.environmentAuthoritySha256 !== local.environmentAuthoritySha256
    || intent.stdinAuthoritySha256 !== local.stdinAuthoritySha256
    || intent.processGroupAuthoritySha256 !== local.processGroupAuthoritySha256
    || intent.boundarySnapshotSha256 !== boundary.snapshotSha256
  ) return null;
  return intent;
}

function checksShapeExact(
  value: unknown,
): value is PermanentStagingProviderVariableWriteKernelChecks {
  const expectedKeys = [
    "frameworkEnabled",
    "policyExact",
    "inputHeldAndBound",
    "localAuthorityExact",
    "boundaryPreflightExact",
    "targetPreflightExact",
    "durableIntentExact",
    "inputReasserted",
    "localAuthorityReasserted",
    "boundaryReasserted",
    "targetReasserted",
    "writeAttempted",
    "acknowledgementExact",
    "postflightAttempted",
    "boundaryPostflightExact",
    "targetPostflightExact",
    "deploymentUnchanged",
    "localPostflightExact",
    "inputCleanupExact",
    "cleanupExact",
    "terminalEvidenceExact",
    "finalizationExact",
  ];
  if (!exactObjectKeys(value, expectedKeys)) return false;
  for (let index = 0; index < expectedKeys.length; index += 1) {
    if (typeof value[expectedKeys[index]!] !== "boolean") return false;
  }
  return true;
}

function preFinalizationReceiptExact(
  value: unknown,
  operation: PermanentStagingProviderVariableWriteOperation,
  intentSha256: string,
): value is PermanentStagingProviderVariableWriteKernelReceipt {
  if (!exactObjectKeys(value, [
    "schemaVersion",
    "executorState",
    "mode",
    "outcome",
    "operationId",
    "variableName",
    "intentSha256",
    "terminalEvidenceSha256",
    "writeAcknowledgementSha256",
    "recoveryOnly",
    "runtimeValueProof",
    "activationAuthorized",
    "checks",
  ])) return false;
  return value.schemaVersion === PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_KERNEL_SCHEMA
    && value.executorState === PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE
    && value.mode === "internal-review-only-create"
    && (value.outcome === "acknowledged_pending_runtime_proof"
      || value.outcome === "mutation_uncertain"
      || value.outcome === "cleanup_failed")
    && value.operationId === operation.operationId
    && value.variableName === operation.variableName
    && value.intentSha256 === intentSha256
    && value.terminalEvidenceSha256 === null
    && (value.writeAcknowledgementSha256 === null
      || sha256StringExact(value.writeAcknowledgementSha256))
    && typeof value.recoveryOnly === "boolean"
    && value.runtimeValueProof === false
    && value.activationAuthorized === false
    && checksShapeExact(value.checks)
    && (value.checks.acknowledgementExact
      ? sha256StringExact(value.writeAcknowledgementSha256)
      : value.writeAcknowledgementSha256 === null)
    && value.checks.frameworkEnabled === true
    && value.checks.policyExact === true
    && value.checks.terminalEvidenceExact === false
    && value.checks.finalizationExact === false;
}

function parseTerminalEvidence(
  value: unknown,
  operation: PermanentStagingProviderVariableWriteOperation,
): PermanentStagingProviderVariableWriteTerminalEvidence | null {
  if (
    typeof value !== "string"
    || SAFE_BUFFER_BYTE_LENGTH(value, "utf8") > MAX_TERMINAL_CANONICAL_BYTES
  ) return null;
  let parsed: unknown;
  try {
    parsed = snapshotDependencyResult(SAFE_JSON_PARSE(value) as unknown);
  } catch {
    return null;
  }
  if (!exactObjectKeys(parsed, [
    "schemaVersion",
    "binding",
    "operationId",
    "variableName",
    "intentLeaf",
    "terminalEvidenceLeaf",
    "intentSha256",
    "preFinalizationReceipt",
    "preFinalizationReceiptSha256",
    "runtimeValueProof",
    "activationAuthorized",
  ])) return null;
  if (
    canonical(parsed) !== value
    || parsed.schemaVersion
      !== PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_TERMINAL_SCHEMA
    || parsed.binding !== "pre-finalization-receipt"
    || parsed.operationId !== operation.operationId
    || parsed.variableName !== operation.variableName
    || parsed.intentLeaf !== operation.intentLeaf
    || parsed.terminalEvidenceLeaf !== operation.terminalEvidenceLeaf
    || !sha256StringExact(parsed.intentSha256)
    || !sha256StringExact(parsed.preFinalizationReceiptSha256)
    || !preFinalizationReceiptExact(
      parsed.preFinalizationReceipt,
      operation,
      parsed.intentSha256,
    )
    || sha256(canonical(parsed.preFinalizationReceipt))
      !== parsed.preFinalizationReceiptSha256
    || parsed.runtimeValueProof !== false
    || parsed.activationAuthorized !== false
  ) return null;
  return parsed as unknown as PermanentStagingProviderVariableWriteTerminalEvidence;
}

function existingTerminalEvidenceExact(
  existing: PermanentStagingProviderVariableExistingTerminalEvidence,
  operation: PermanentStagingProviderVariableWriteOperation,
): PermanentStagingProviderVariableWriteTerminalEvidence | null {
  if (!exactObjectKeys(existing, ["leaf", "canonical", "evidence"])) return null;
  const terminal = parseTerminalEvidence(existing.canonical, operation);
  if (
    terminal === null
    || existing.leaf !== operation.terminalEvidenceLeaf
    || !durableArtifactExact(existing.evidence, sha256(existing.canonical))
    || existing.evidence.publication !== "existing-exact"
  ) return null;
  return terminal;
}

function existingIntentForTerminalExact(
  existing: PermanentStagingProviderVariableExistingIntent,
  operation: PermanentStagingProviderVariableWriteOperation,
  terminal: PermanentStagingProviderVariableWriteTerminalEvidence,
): PermanentStagingProviderVariableWriteIntent | null {
  if (!exactObjectKeys(existing, ["leaf", "canonical", "evidence"])) return null;
  const intent = parseIntent(existing.canonical);
  const lock = PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK;
  if (
    intent === null
    || existing.leaf !== operation.intentLeaf
    || !durableArtifactExact(existing.evidence, sha256(existing.canonical))
    || existing.evidence.publication !== "existing-exact"
    || sha256(existing.canonical) !== terminal.intentSha256
    || intent.policySha256 !== sha256(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_CANONICAL_POLICY_SOURCE,
    )
    || intent.operationId !== operation.operationId
    || intent.variableName !== operation.variableName
    || intent.projectId !== lock.projectId
    || intent.environmentId !== lock.stagingEnvironmentId
    || intent.serviceId !== lock.serviceId
    || intent.valueByteLength < 1
    || intent.valueByteLength
      > PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_LOCK.writeContract
        .maximumValueBytes
  ) return null;
  return intent;
}

function makeReceipt(
  operation: PermanentStagingProviderVariableWriteOperation,
  outcome: PermanentStagingProviderVariableWriteKernelOutcome,
  intentSha256: string | null,
  terminalEvidenceSha256: string | null,
  writeAcknowledgementSha256Value: string | null,
  recoveryOnly: boolean,
  checks: PermanentStagingProviderVariableWriteKernelChecks,
): PermanentStagingProviderVariableWriteKernelReceipt {
  const publishedChecks = freezeNullRecord({ ...checks });
  return freezeNullRecord({
    schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_KERNEL_SCHEMA,
    executorState: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_EXECUTOR_STATE,
    mode: "internal-review-only-create",
    outcome,
    operationId: operation.operationId,
    variableName: operation.variableName,
    intentSha256,
    terminalEvidenceSha256,
    writeAcknowledgementSha256: writeAcknowledgementSha256Value,
    recoveryOnly,
    runtimeValueProof: false,
    activationAuthorized: false,
    checks: publishedChecks,
  });
}

async function executeEnabled(
  operationId: string,
  dependencies: PermanentStagingProviderVariableWriteKernelDependencies,
): Promise<PermanentStagingProviderVariableWriteKernelReceipt> {
  const operation = operationFromId(operationId);
  if (!operation) throw kernelError("operation_invalid");
  const capturedDependencies = captureKernelDependencies(dependencies);
  const checks = initialChecks();
  let input: PermanentStagingProviderVariableInputAuthority | null = null;
  let local: PermanentStagingProviderVariableLocalAuthority | null = null;
  let boundary: PermanentStagingProviderVariableBoundaryAuthority | null = null;
  let intent: PermanentStagingProviderVariableWriteIntent | null = null;
  let preflightForPostflight:
  PermanentStagingProviderVariableCreatePreflightCandidate | null = null;
  let intentSha256: string | null = null;
  let terminalEvidenceSha256: string | null = null;
  let writeAcknowledgementSha256Value: string | null = null;
  let recoveryOnly = false;
  let terminalReplay = false;
  let writeAttempted = false;
  let outcome: PermanentStagingProviderVariableWriteKernelOutcome = "failed";

  const runPostflight = async (): Promise<void> => {
    checks.postflightAttempted = true;
    if (!intent || !preflightForPostflight || !boundary || !local) return;
    try {
      const observedBoundary = snapshotDependencyResult(await withDeadline(
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.postflightMs,
        (signal) => applyDependency(
          capturedDependencies.inspectBoundary,
          capturedDependencies.receiver,
          [signal],
        ),
      ));
      checks.boundaryPostflightExact = boundaryAuthorityExact(observedBoundary)
        && canonical(observedBoundary) === canonical(boundary);
    } catch {
      checks.boundaryPostflightExact = false;
    }
    try {
      const observedTarget = snapshotDependencyResult(await withDeadline(
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.postflightMs,
        (signal) => applyDependency(
          capturedDependencies.inspectTargetPostflight,
          capturedDependencies.receiver,
          [operation, intent!, preflightForPostflight!, signal],
        ),
      ));
      checks.targetPostflightExact = targetPostflightExact(
        observedTarget,
        operation,
        intent,
      );
      checks.deploymentUnchanged = checks.targetPostflightExact
        && observedTarget.deploymentUnchanged === true;
    } catch {
      checks.targetPostflightExact = false;
      checks.deploymentUnchanged = false;
    }
    try {
      const observedLocal = snapshotDependencyResult(await withDeadline(
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.localAuthorityMs,
        (signal) => applyDependency(
          capturedDependencies.inspectLocalAuthority,
          capturedDependencies.receiver,
          [operation, signal],
        ),
      ));
      checks.localPostflightExact = localAuthorityExact(observedLocal)
        && canonical(observedLocal) === canonical(local);
    } catch {
      checks.localPostflightExact = false;
    }
  };

  try {
    const existingTerminal = snapshotDependencyResult(await withDeadline(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.evidenceMs,
      (signal) => applyDependency(
        capturedDependencies.inspectTerminalEvidence,
        capturedDependencies.receiver,
        [operation, signal],
      ),
    ));
    if (existingTerminal !== null) {
      terminalReplay = true;
      recoveryOnly = true;
      outcome = "mutation_uncertain";
      const terminal = existingTerminalEvidenceExact(existingTerminal, operation);
      if (terminal !== null) {
        const existing = snapshotDependencyResult(await withDeadline(
          PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.evidenceMs,
          (signal) => applyDependency(
            capturedDependencies.inspectIntent,
            capturedDependencies.receiver,
            [operation, signal],
          ),
        ));
        if (existing !== null) {
          const matchedIntent = existingIntentForTerminalExact(
            existing,
            operation,
            terminal,
          );
          if (matchedIntent !== null) {
            const rebuilt = rebuildPreflightLineage(
              matchedIntent.preflightLineage,
              matchedIntent.variableName,
            );
            if (rebuilt !== null) {
              intent = matchedIntent;
              preflightForPostflight = rebuilt.preflight;
              intentSha256 = terminal.intentSha256;
              terminalEvidenceSha256 = existingTerminal.evidence.sha256;
              writeAcknowledgementSha256Value = terminal
                .preFinalizationReceipt.writeAcknowledgementSha256;
              checks.durableIntentExact = true;
              checks.terminalEvidenceExact = true;
            }
          }
        }
      }
    }
  } catch {
    terminalReplay = true;
    recoveryOnly = true;
    outcome = "mutation_uncertain";
  }

  if (!terminalReplay) {
    try {
    input = snapshotDependencyResult(await withDeadline(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.inputMs,
      (signal) => applyDependency(
        capturedDependencies.inspectInput,
        capturedDependencies.receiver,
        [operation, signal],
      ),
    ));
    checks.inputHeldAndBound = inputAuthorityExact(input, operation);
    if (!checks.inputHeldAndBound) throw kernelError("input_invalid");

    local = snapshotDependencyResult(await withDeadline(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.localAuthorityMs,
      (signal) => applyDependency(
        capturedDependencies.inspectLocalAuthority,
        capturedDependencies.receiver,
        [operation, signal],
      ),
    ));
    checks.localAuthorityExact = localAuthorityExact(local);
    if (!checks.localAuthorityExact) throw kernelError("local_authority_invalid");

    boundary = snapshotDependencyResult(await withDeadline(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.boundaryMs,
      (signal) => applyDependency(
        capturedDependencies.inspectBoundary,
        capturedDependencies.receiver,
        [signal],
      ),
    ));
    checks.boundaryPreflightExact = boundaryAuthorityExact(boundary);
    if (!checks.boundaryPreflightExact) throw kernelError("boundary_invalid");

    const existing = snapshotDependencyResult(await withDeadline(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.evidenceMs,
      (signal) => applyDependency(
        capturedDependencies.inspectIntent,
        capturedDependencies.receiver,
        [operation, signal],
      ),
    ));
    if (existing !== null) {
      recoveryOnly = true;
      intent = existingIntentExact(existing, operation, input, local, boundary);
      checks.durableIntentExact = intent !== null;
      if (!intent) throw kernelError("intent_invalid");
      const rebuilt = rebuildPreflightLineage(
        intent.preflightLineage,
        intent.variableName,
      );
      if (rebuilt === null) throw kernelError("intent_lineage_invalid");
      preflightForPostflight = rebuilt.preflight;
      intentSha256 = existing.evidence.sha256;
    } else {
      const targetInput = snapshotDependencyResult(await withDeadline(
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.targetMs,
        (signal) => applyDependency(
          capturedDependencies.inspectTargetPreflight,
          capturedDependencies.receiver,
          [operation, signal],
        ),
      ));
      const target = targetPreflightObservationExact(targetInput, operation);
      checks.targetPreflightExact = target !== null;
      if (target === null) throw kernelError("target_invalid");
      preflightForPostflight = target.preflight;
      const intentCandidate = makeIntent(operation, input, local, boundary, target);
      const canonicalIntent = canonical(intentCandidate);
      if (
        SAFE_BUFFER_BYTE_LENGTH(canonicalIntent, "utf8")
          > MAX_INTENT_CANONICAL_BYTES
      ) throw kernelError("intent_too_large");
      const parsedIntent = parseIntent(canonicalIntent);
      if (
        parsedIntent === null
        || !freshIntentAuthorityExact(
          parsedIntent,
          operation,
          input,
          local,
          boundary,
          target,
        )
      ) throw kernelError("intent_roundtrip_invalid");
      intent = parsedIntent;
      const expectedIntentSha256 = sha256(canonicalIntent);
      recoveryOnly = true;
      const persisted = snapshotDependencyResult(await withDeadline(
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.evidenceMs,
        (signal) => applyDependency(
          capturedDependencies.persistIntent,
          capturedDependencies.receiver,
          [operation, canonicalIntent, signal],
        ),
      ));
      checks.durableIntentExact = durableArtifactExact(
        persisted,
        expectedIntentSha256,
      );
      if (!checks.durableIntentExact) throw kernelError("intent_not_durable");
      intentSha256 = persisted.sha256;
      recoveryOnly = persisted.publication === "existing-exact";
    }

    const reassertedInput = snapshotDependencyResult(await withDeadline(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.inputMs,
      (signal) => applyDependency(
        capturedDependencies.inspectInput,
        capturedDependencies.receiver,
        [operation, signal],
      ),
    ));
    checks.inputReasserted = sameInputAuthority(input, reassertedInput);
    if (!checks.inputReasserted) throw kernelError("input_drift");

    const reassertedLocal = snapshotDependencyResult(await withDeadline(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.localAuthorityMs,
      (signal) => applyDependency(
        capturedDependencies.inspectLocalAuthority,
        capturedDependencies.receiver,
        [operation, signal],
      ),
    ));
    checks.localAuthorityReasserted = localAuthorityExact(reassertedLocal)
      && canonical(reassertedLocal) === canonical(local);
    if (!checks.localAuthorityReasserted) throw kernelError("local_drift");

    const reassertedBoundary = snapshotDependencyResult(await withDeadline(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.boundaryMs,
      (signal) => applyDependency(
        capturedDependencies.inspectBoundary,
        capturedDependencies.receiver,
        [signal],
      ),
    ));
    checks.boundaryReasserted = boundaryAuthorityExact(reassertedBoundary)
      && canonical(reassertedBoundary) === canonical(boundary);
    if (!checks.boundaryReasserted) throw kernelError("boundary_drift");

    if (!recoveryOnly) {
      const reassertedTargetInput = snapshotDependencyResult(await withDeadline(
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.targetMs,
        (signal) => applyDependency(
          capturedDependencies.inspectTargetPreflight,
          capturedDependencies.receiver,
          [operation, signal],
        ),
      ));
      const reassertedTarget = targetPreflightObservationExact(
        reassertedTargetInput,
        operation,
      );
      checks.targetReasserted = reassertedTarget !== null
        && reassertedTarget.authority.metadataInventorySha256
        === intent.metadataInventorySha256
        && reassertedTarget.authority.deploymentInventorySha256
          === intent.deploymentInventorySha256;
      if (!checks.targetReasserted) throw kernelError("target_drift");

      writeAttempted = true;
      checks.writeAttempted = true;
      const attemptAuthority =
        createPermanentStagingProviderVariableWriteLocalAttemptAuthority({
          operationId: operation.operationId,
          variableName: operation.variableName,
          inputCommitmentSha256: input.commitmentSha256,
          inputByteLength: input.byteLength,
          intentSha256: intentSha256!,
          localAuthoritySha256: intent.localAuthoritySha256,
          commandSha256: intent.commandSha256,
          processAdapterAuthoritySha256:
            intent.processAdapterAuthoritySha256,
          privateExecutableCopyAuthoritySha256:
            intent.privateExecutableCopyAuthoritySha256,
          environmentAuthoritySha256: intent.environmentAuthoritySha256,
          stdinAuthoritySha256: intent.stdinAuthoritySha256,
          processGroupAuthoritySha256: intent.processGroupAuthoritySha256,
        });
      try {
        const acknowledgement = await withDeadline(
          PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.writeMs,
          (signal) => applyDependency(
            capturedDependencies.writeExactlyOnce,
            capturedDependencies.receiver,
            [operation, intentSha256!, attemptAuthority, signal],
          ),
        );
        checks.acknowledgementExact = writeAcknowledgementExact(
          acknowledgement,
          input,
          intent,
          intentSha256!,
          attemptAuthority,
        );
        if (checks.acknowledgementExact) {
          writeAcknowledgementSha256Value = writeAcknowledgementSha256(
            acknowledgement,
          );
        }
      } catch {
        checks.acknowledgementExact = false;
      }
    }

    await runPostflight();
    const acknowledged = !recoveryOnly
      && checks.acknowledgementExact
      && checks.boundaryReasserted
      && checks.targetReasserted
      && checks.boundaryPostflightExact
      && checks.targetPostflightExact
      && checks.deploymentUnchanged
      && checks.localPostflightExact;
    outcome = acknowledged
      ? "acknowledged_pending_runtime_proof"
      : "mutation_uncertain";
    } catch {
      if (intent && !checks.postflightAttempted) await runPostflight();
      outcome = writeAttempted || recoveryOnly || intent
        ? "mutation_uncertain"
        : "failed";
    }
  }

  try {
    const cleanup = snapshotDependencyResult(await withDeadline(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.cleanupMs,
      (signal) => applyDependency(
        capturedDependencies.cleanup,
        capturedDependencies.receiver,
        [signal],
      ),
    ));
    checks.inputCleanupExact = cleanup.inputZeroized === true
      && cleanup.inputClosed === true;
    checks.cleanupExact = cleanupAuthorityExact(cleanup);
  } catch {
    checks.inputCleanupExact = false;
    checks.cleanupExact = false;
  }
  if (!checks.cleanupExact) {
    outcome = recoveryOnly || intent !== null || writeAttempted
      ? "mutation_uncertain"
      : "cleanup_failed";
  }

  if (!terminalReplay && intent && intentSha256) {
    try {
      const preFinalizationReceipt = makeReceipt(
        operation,
        outcome,
        intentSha256,
        null,
        writeAcknowledgementSha256Value,
        recoveryOnly,
        checks,
      );
      const preFinalizationReceiptCanonical = canonical(preFinalizationReceipt);
      const preFinalizationReceiptSha256 = sha256(
        preFinalizationReceiptCanonical,
      );
      const terminalCandidate = canonical({
        schemaVersion: PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_TERMINAL_SCHEMA,
        binding: "pre-finalization-receipt",
        operationId: operation.operationId,
        variableName: operation.variableName,
        intentLeaf: operation.intentLeaf,
        terminalEvidenceLeaf: operation.terminalEvidenceLeaf,
        intentSha256,
        preFinalizationReceipt,
        preFinalizationReceiptSha256,
        runtimeValueProof: false,
        activationAuthorized: false,
      } satisfies PermanentStagingProviderVariableWriteTerminalEvidence);
      const parsedTerminal = parseTerminalEvidence(terminalCandidate, operation);
      if (
        parsedTerminal === null
        || canonical(parsedTerminal.preFinalizationReceipt)
          !== preFinalizationReceiptCanonical
      ) {
        throw kernelError("terminal_roundtrip_invalid");
      }
      const persisted = snapshotDependencyResult(await withDeadline(
        PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.evidenceMs,
        (signal) => applyDependency(
          capturedDependencies.persistTerminalEvidence,
          capturedDependencies.receiver,
          [operation, terminalCandidate, signal],
        ),
      ));
      checks.terminalEvidenceExact = durableArtifactExact(
        persisted,
        sha256(terminalCandidate),
      );
      if (checks.terminalEvidenceExact) {
        terminalEvidenceSha256 = persisted.sha256;
      } else {
        outcome = "mutation_uncertain";
      }
    } catch {
      checks.terminalEvidenceExact = false;
      outcome = "mutation_uncertain";
    }
  }

  try {
    checks.finalizationExact = await withDeadline(
      PERMANENT_STAGING_PROVIDER_VARIABLE_WRITE_DEADLINES.finalizationMs,
      (signal) => applyDependency(
        capturedDependencies.finalize,
        capturedDependencies.receiver,
        [signal],
      ),
    ) === true;
  } catch {
    checks.finalizationExact = false;
  }
  if (!checks.finalizationExact) {
    outcome = recoveryOnly || intent !== null || writeAttempted
      ? "mutation_uncertain"
      : "cleanup_failed";
  }

  return makeReceipt(
    operation,
    outcome,
    intentSha256,
    terminalEvidenceSha256,
    writeAcknowledgementSha256Value,
    recoveryOnly,
    checks,
  );
}

export const permanentStagingProviderVariableWriteKernelInternals =
SAFE_OBJECT_FREEZE({
  durableArtifactExact,
  executeEnabled,
  snapshotDependencyResult,
  withDeadline,
});
