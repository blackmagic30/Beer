import crypto from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  sha256CanonicalPostgresLogicalState,
  type PostgresLogicalStateCaptureV2,
} from "./postgres-logical-state.js";

export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_PROFILE =
  "detached-effective-role-snapshot-handoff-pg17-v1" as const;
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_RECEIPT_BYTES = 64 * 1024;
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_LIFETIME_SECONDS = 600;
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS =
  480_000;
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_STATEMENT_TIMEOUT_MILLISECONDS =
  180_000;
export const POSTGRES_LOGICAL_BACKUP_V4_PG_DUMP_WATCHDOG_TIMEOUT_MILLISECONDS =
  300_000;
export const POSTGRES_LOGICAL_BACKUP_V4_CLEANUP_RESERVE_MILLISECONDS = 120_000;

export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_CAPABILITY = Object.freeze({
  implementationState: "OFFLINE_CONTRACT_ONLY",
  sourceRoleProvisioningImplemented: false,
  sourceSnapshotExportImplemented: false,
  pgDumpHandoffImplemented: false,
  operationalSourceAuthorityImplemented: false,
  effectiveTargetOnlyDatabaseAccessVerified: false,
  completeRoleGraphVerified: false,
  artifactEmissionAuthorized: false,
  activationAuthorized: false,
  productionCutoverAuthorized: false,
} as const);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OID_PATTERN = /^(?:[1-9][0-9]{0,9})$/;
const LOGIN_VERSION_PATTERN = /^(?:[1-9][0-9]{0,19})$/;
const SNAPSHOT_IDENTIFIER_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{8}-([1-9][0-9]{0,9})$/;
const MAX_SNAPSHOT_SEQUENCE = 2_147_483_647;
const MAX_POSTGRES_OID = 4_294_967_295n;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 512;
const MAX_CAPTURE_DEPTH = 32;
const MAX_CAPTURE_NODES = 20_000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const BACKUP_GROUP_PREFIX = "pintpath_logical_backup_d";

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY = deepFreeze({
  kind: "pintpath-postgres-logical-backup-source-authority-policy",
  version: 1,
  profile: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_PROFILE,
  implementationState: "OFFLINE_CONTRACT_ONLY",
  postgresMajor: 17,
  maxLifetimeSeconds: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_LIFETIME_SECONDS,
  backupGroup: {
    oidScoped: true,
    login: false,
    inherit: false,
    superuser: false,
    createDatabase: false,
    createRole: false,
    replication: false,
    bypassRls: false,
  },
  ephemeralLogin: {
    oidScopedVersionedName: true,
    login: true,
    inherit: false,
    connectionLimit: 2,
    validUntilRequired: true,
    passwordVerifierFormat: "scram-sha-256",
    directTargetDatabaseConnectGrantCount: 1,
    directFunctionPrivilegeCount: 0,
    directPrivateObjectPrivilegeCount: 0,
    completeRoleGraphVerificationRequired: true,
    effectiveTargetOnlyDatabaseScopeVerified: false,
    operationalizationBlockedUntilEffectiveDatabaseScopeVerified: true,
    superuser: false,
    createDatabase: false,
    createRole: false,
    replication: false,
    bypassRls: false,
  },
  membership: {
    setOption: true,
    inheritOption: false,
    adminOption: false,
  },
  sessions: {
    independentAdminRequired: true,
    pgDumpSecondConnectionRequired: true,
    sourceSession: {
      statementTimeoutMilliseconds:
        POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_STATEMENT_TIMEOUT_MILLISECONDS,
      idleInTransactionSessionTimeoutMilliseconds:
        POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS,
      idleSessionTimeoutMilliseconds:
        POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS,
      transactionTimeoutMilliseconds:
        POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS,
    },
    pgDumpProcess: {
      serverGucTimeoutsAuthoritative: false,
      externalWallClockWatchdogRequired: true,
      watchdogStartsAt: "membership-regranted",
      externalWallClockTimeoutMilliseconds:
        POSTGRES_LOGICAL_BACKUP_V4_PG_DUMP_WATCHDOG_TIMEOUT_MILLISECONDS,
      absoluteDeadlineBoundToReceiptExpiry: true,
      cleanupReserveMilliseconds: POSTGRES_LOGICAL_BACKUP_V4_CLEANUP_RESERVE_MILLISECONDS,
      independentAdminBackendTerminationRequired: true,
    },
  },
  sourceTransaction: {
    roleSetBeforeBegin: true,
    membershipRevokedBeforeBegin: true,
    isolation: "repeatable read",
    readOnly: true,
    v2CaptureSequence: 1,
    snapshotExportSequence: 2,
    immediateCaptureToExportRequired: true,
  },
  snapshot: {
    rawIdentifierPersisted: false,
    identifierSha256Persisted: true,
    semanticRoleAndSnapshotArgumentBindingRequired: true,
    exactRawArgumentReceiptVerificationRequired: true,
  },
  sourceCapture: {
    profile: "opaque-logical-state-v2-capture-digest-v1",
    requiresIndependentFullV2Validation: true,
    manifestMustMatchSameRawCaptureSha256: true,
  },
  eventSequence: [
    "login-provisioned",
    "source-role-set",
    "membership-revoked",
    "source-transaction-began",
    "v2-capture-completed",
    "snapshot-exported",
    "membership-regranted",
    "pg-dump-snapshot-imported",
    "source-transaction-ended",
    "cleanup-completed",
  ],
  cleanup: {
    required: true,
    revokeMembership: true,
    disableLogin: true,
    dropLogin: true,
    terminateScopedBackends: true,
    requiredActiveSessionCount: 0,
  },
  authorization: {
    evidenceOnly: true,
    activationAuthorized: false,
    artifactEmissionAuthorized: false,
    productionCutoverAuthorized: false,
    operationalSourceAuthorityImplemented: false,
    effectiveTargetOnlyDatabaseAccessVerified: false,
    completeRoleGraphVerified: false,
    emitterMustRejectUntilOperationalSourceAuthorityImplemented: true,
  },
} as const);

export interface PostgresLogicalBackupV4SourceCaptureBinding {
  readonly profile: "opaque-logical-state-v2-capture-digest-v1";
  readonly captureSha256: string;
  readonly sourceDatabaseOid: string;
  readonly portableReadBoundarySha256: string;
  readonly physicalReadBoundarySha256: string;
  readonly overallStateSha256: string;
  readonly requiresIndependentFullV2Validation: true;
}

export interface PostgresLogicalBackupV4SnapshotHandoffBinding {
  readonly profile: "semantic-exported-snapshot-pg-dump-binding-v1";
  readonly sourceDatabaseOid: string;
  readonly databaseIdentitySha256: string;
  readonly sourceUrlSha256: string;
  readonly effectiveRoleName: string;
  readonly snapshotIdentifierSha256: string;
  readonly exportedSnapshotBindingSha256: string;
  readonly pgDumpSnapshotSemanticBindingSha256: string;
  readonly semanticHandoffBindingSha256: string;
}

interface RoleSafetyFlags {
  readonly inherit: false;
  readonly superuser: false;
  readonly createDatabase: false;
  readonly createRole: false;
  readonly replication: false;
  readonly bypassRls: false;
}

interface MembershipTransitionReceipt {
  readonly phase: "provisioned" | "detached-for-v2" | "regranted-for-pg-dump" | "cleaned-up";
  readonly observedAt: string;
  readonly backupGroupChildMembershipCount: 0 | 1;
  readonly loginParentMembershipCount: 0 | 1;
  readonly exactSetOnlyMembershipCount: 0 | 1;
  readonly inheritOptionTrueCount: 0;
  readonly adminOptionTrueCount: 0;
  readonly observerSessionIdentitySha256: string;
  readonly evidenceSha256: string;
}

export interface PostgresLogicalBackupV4SourceAuthorityReceipt {
  readonly kind: "pintpath-postgres-logical-backup-source-authority";
  readonly version: 1;
  readonly profile: typeof POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_PROFILE;
  readonly policySha256: string;
  readonly createdAt: string;
  readonly validity: {
    readonly startedAt: string;
    readonly expiresAt: string;
    readonly maxLifetimeSeconds: typeof POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_LIFETIME_SECONDS;
    readonly serverClockEvidenceSha256: string;
  };
  readonly source: {
    readonly databaseOid: string;
    readonly databaseIdentitySha256: string;
    readonly urlSha256: string;
  };
  readonly roles: {
    readonly backupGroup: RoleSafetyFlags & {
      readonly roleName: string;
      readonly roleOid: string;
      readonly login: false;
      readonly catalogEvidenceSha256: string;
    };
    readonly ephemeralLogin: RoleSafetyFlags & {
      readonly roleName: string;
      readonly roleOid: string;
      readonly login: true;
      readonly connectionLimit: 2;
      readonly validUntil: string;
      readonly passwordVerifierFormat: "scram-sha-256";
      readonly sourceAuthenticationEvidenceSha256: string;
      readonly pgDumpAuthenticationEvidenceSha256: string;
      readonly directTargetDatabaseConnectGrantCount: 1;
      readonly directFunctionPrivilegeCount: 0;
      readonly directPrivateObjectPrivilegeCount: 0;
      readonly effectiveConnectableDatabaseCount: number;
      readonly effectiveTargetOnlyDatabaseScopeVerified: false;
      readonly effectiveDatabaseScopeEvidenceSha256: string;
      readonly operationalizationBlockedUntilEffectiveDatabaseScopeVerified: true;
      readonly catalogEvidenceSha256: string;
    };
  };
  readonly sessions: {
    readonly source: {
      readonly identitySha256: string;
      readonly currentUserRoleName: string;
      readonly sessionUserRoleName: string;
      readonly statementTimeoutMilliseconds: typeof POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_STATEMENT_TIMEOUT_MILLISECONDS;
      readonly idleInTransactionSessionTimeoutMilliseconds: typeof POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS;
      readonly idleSessionTimeoutMilliseconds: typeof POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS;
      readonly transactionTimeoutMilliseconds: typeof POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS;
      readonly timeoutEvidenceSha256: string;
    };
    readonly independentAdmin: {
      readonly identitySha256: string;
    };
    readonly pgDump: {
      readonly identitySha256: string;
      readonly currentUserRoleName: string;
      readonly sessionUserRoleName: string;
      readonly serverGucTimeoutsAuthoritative: false;
      readonly externalWallClockWatchdogRequired: true;
      readonly watchdogStartedAt: string;
      readonly externalWallClockTimeoutMilliseconds: typeof POSTGRES_LOGICAL_BACKUP_V4_PG_DUMP_WATCHDOG_TIMEOUT_MILLISECONDS;
      readonly absoluteDeadline: string;
      readonly cleanupReserveMilliseconds: typeof POSTGRES_LOGICAL_BACKUP_V4_CLEANUP_RESERVE_MILLISECONDS;
      readonly externalWatchdogEvidenceSha256: string;
    };
  };
  readonly eventTimes: {
    readonly loginProvisionedAt: string;
    readonly sourceRoleSetAt: string;
    readonly membershipRevokedAt: string;
    readonly sourceTransactionBeganAt: string;
    readonly v2CaptureCompletedAt: string;
    readonly snapshotExportedAt: string;
    readonly membershipRegrantedAt: string;
    readonly pgDumpSnapshotImportedAt: string;
    readonly sourceTransactionEndedAt: string;
    readonly cleanupCompletedAt: string;
  };
  readonly membershipTransitions: readonly [
    MembershipTransitionReceipt,
    MembershipTransitionReceipt,
    MembershipTransitionReceipt,
    MembershipTransitionReceipt,
  ];
  readonly sourceTransaction: {
    readonly isolation: "repeatable read";
    readonly readOnly: true;
    readonly currentUserRoleName: string;
    readonly sessionUserRoleName: string;
    readonly backupGroupChildMembershipCount: 0;
    readonly loginParentMembershipCount: 0;
    readonly sourceSessionIdentitySha256: string;
    readonly evidenceSha256: string;
  };
  readonly v2Capture: PostgresLogicalBackupV4SourceCaptureBinding & {
    readonly capturedAt: string;
    readonly captureSequence: 1;
    readonly sourceSessionIdentitySha256: string;
  };
  readonly exportedSnapshot: {
    readonly exportedAt: string;
    readonly bindingSha256: string;
    readonly snapshotIdentifierSha256: string;
    readonly semanticHandoffBindingSha256: string;
    readonly rawIdentifierPersisted: false;
    readonly exportSequence: 2;
    readonly sourceSessionIdentitySha256: string;
    readonly immediateAfterV2Capture: true;
    readonly sequenceEvidenceSha256: string;
  };
  readonly pgDumpHandoff: {
    readonly observedAt: string;
    readonly secondConnectionRequired: true;
    readonly roleArgumentSha256: string;
    readonly snapshotArgumentSemanticBindingSha256: string;
    readonly semanticHandoffBindingSha256: string;
    readonly argumentsBindingSha256: string;
    readonly importedSnapshotBindingSha256: string;
    readonly pgDumpSessionIdentitySha256: string;
    readonly exactRawArgumentsReceiptVerificationRequired: true;
    readonly exactRawArgumentsEvidenceSha256: string;
    readonly snapshotVisibilityEvidenceSha256: string;
  };
  readonly cleanup: {
    readonly required: true;
    readonly membershipRevoked: true;
    readonly loginDisabled: true;
    readonly loginDropped: true;
    readonly backendTerminationAttempted: true;
    readonly terminatedBackendCount: number;
    readonly activeSessionCount: 0;
    readonly evidenceSha256: string;
  };
  readonly evidenceOnly: true;
  readonly operationalSourceAuthorityImplemented: false;
  readonly effectiveTargetOnlyDatabaseAccessVerified: false;
  readonly completeRoleGraphVerified: false;
  readonly emitterMustRejectUntilOperationalSourceAuthorityImplemented: true;
  readonly activationAuthorized: false;
  readonly artifactEmissionAuthorized: false;
  readonly productionCutoverAuthorized: false;
  readonly receiptBindingSha256: string;
}

export interface BuildPostgresLogicalBackupV4SourceAuthorityReceiptInput {
  readonly createdAt: string;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly serverClockEvidenceSha256: string;
  readonly sourceDatabaseOid: string;
  readonly databaseIdentitySha256: string;
  readonly sourceUrlSha256: string;
  readonly backupGroupRoleOid: string;
  readonly ephemeralLoginRoleOid: string;
  readonly ephemeralLoginVersion: string;
  readonly backupGroupCatalogEvidenceSha256: string;
  readonly ephemeralLoginCatalogEvidenceSha256: string;
  readonly effectiveConnectableDatabaseCount: number;
  readonly effectiveDatabaseScopeEvidenceSha256: string;
  readonly sourceSessionIdentitySha256: string;
  readonly independentAdminSessionIdentitySha256: string;
  readonly pgDumpSessionIdentitySha256: string;
  readonly sourceAuthenticationEvidenceSha256: string;
  readonly pgDumpAuthenticationEvidenceSha256: string;
  readonly sourceSessionTimeoutEvidenceSha256: string;
  readonly pgDumpExternalWatchdogEvidenceSha256: string;
  readonly eventTimes: PostgresLogicalBackupV4SourceAuthorityReceipt["eventTimes"];
  readonly membershipEvidenceSha256: {
    readonly provisioned: string;
    readonly detachedForV2: string;
    readonly regrantedForPgDump: string;
    readonly cleanedUp: string;
  };
  readonly sourceTransactionEvidenceSha256: string;
  readonly captureToExportSequenceEvidenceSha256: string;
  readonly sourceCapture: PostgresLogicalBackupV4SourceCaptureBinding;
  readonly snapshotHandoff: PostgresLogicalBackupV4SnapshotHandoffBinding;
  readonly pgDumpSnapshotVisibilityEvidenceSha256: string;
  readonly pgDumpExactRawArgumentsEvidenceSha256: string;
  readonly cleanupEvidenceSha256: string;
  readonly terminatedBackendCount: number;
}

export class PostgresLogicalBackupV4SourceAuthorityError extends Error {
  constructor(readonly code: "policy_invalid" | "receipt_invalid" | "capture_binding_invalid" | "snapshot_binding_invalid") {
    super(code);
    this.name = "PostgresLogicalBackupV4SourceAuthorityError";
  }
}

function fail(code: PostgresLogicalBackupV4SourceAuthorityError["code"]): never {
  throw new PostgresLogicalBackupV4SourceAuthorityError(code);
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("receipt_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalize(entry)}`
    )).join(",")}}`;
  }
  fail("receipt_invalid");
}

function canonicalJson(value: unknown): string {
  return `${canonicalize(value)}\n`;
}

function sha256Bytes(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

const POLICY_CANONICAL_JSON = canonicalJson(POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY);
export const POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY_SHA256 =
  sha256Bytes(POLICY_CANONICAL_JSON);

function snapshotBoundedPlainData(
  value: unknown,
  code: PostgresLogicalBackupV4SourceAuthorityError["code"],
  maxDepth = MAX_JSON_DEPTH,
  maxNodes = MAX_JSON_NODES,
): unknown {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) fail(code);
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isSafeInteger(candidate) || Object.is(candidate, -0)) fail(code);
      return candidate;
    }
    if (typeof candidate !== "object" || utilTypes.isProxy(candidate)) fail(code);
    let prototype: object | null;
    let keys: (string | symbol)[];
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(candidate);
      keys = Reflect.ownKeys(candidate);
      descriptors = Object.getOwnPropertyDescriptors(candidate);
    } catch {
      fail(code);
    }
    if (Array.isArray(candidate)) {
      if (prototype !== Array.prototype
        || keys.some((key) => typeof key !== "string"
          || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key)))) fail(code);
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) fail(code);
      const length = lengthDescriptor.value as number;
      if (keys.length !== length + 1) fail(code);
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
        output.push(visit(descriptor.value, depth + 1));
      }
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== "string") fail(code);
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
      output[key] = visit(descriptor.value, depth + 1);
    }
    return output;
  };
  return visit(value, 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const keys = [...expected].sort(compareText);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function safeHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function exactSnapshotIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = SNAPSHOT_IDENTIFIER_PATTERN.exec(value);
  return Boolean(match && Number(match[1]) <= MAX_SNAPSHOT_SEQUENCE);
}

function exactOid(value: unknown): value is string {
  if (typeof value !== "string" || !OID_PATTERN.test(value)) return false;
  try {
    return BigInt(value) <= MAX_POSTGRES_OID;
  } catch {
    return false;
  }
}

function exactIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function backupGroupRoleName(databaseOid: string): string {
  if (!exactOid(databaseOid)) fail("receipt_invalid");
  return `${BACKUP_GROUP_PREFIX}${databaseOid}`;
}

function ephemeralLoginRoleName(databaseOid: string, version: string): string {
  if (!LOGIN_VERSION_PATTERN.test(version)) fail("receipt_invalid");
  const roleName = `${backupGroupRoleName(databaseOid)}_v${version}`;
  if (Buffer.byteLength(roleName, "utf8") > 63) fail("receipt_invalid");
  return roleName;
}

function exactRoleSafetyFlags(
  value: unknown,
  login: boolean,
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const common = [
    "roleName", "roleOid", "login", "inherit", "superuser", "createDatabase",
    "createRole", "replication", "bypassRls", "catalogEvidenceSha256",
  ];
  const keys = login ? [
    ...common, "connectionLimit", "validUntil", "passwordVerifierFormat",
    "sourceAuthenticationEvidenceSha256", "pgDumpAuthenticationEvidenceSha256",
    "directTargetDatabaseConnectGrantCount", "directFunctionPrivilegeCount",
    "directPrivateObjectPrivilegeCount", "effectiveConnectableDatabaseCount",
    "effectiveTargetOnlyDatabaseScopeVerified", "effectiveDatabaseScopeEvidenceSha256",
    "operationalizationBlockedUntilEffectiveDatabaseScopeVerified",
  ] : common;
  return exactKeys(value, keys)
    && value.login === login
    && value.inherit === false
    && value.superuser === false
    && value.createDatabase === false
    && value.createRole === false
    && value.replication === false
    && value.bypassRls === false
    && typeof value.roleName === "string"
    && exactOid(value.roleOid)
    && safeHash(value.catalogEvidenceSha256)
    && (!login || (
      value.connectionLimit === 2
      && exactIsoInstant(value.validUntil)
      && value.passwordVerifierFormat === "scram-sha-256"
      && safeHash(value.sourceAuthenticationEvidenceSha256)
      && safeHash(value.pgDumpAuthenticationEvidenceSha256)
      && value.directTargetDatabaseConnectGrantCount === 1
      && value.directFunctionPrivilegeCount === 0
      && value.directPrivateObjectPrivilegeCount === 0
      && Number.isSafeInteger(value.effectiveConnectableDatabaseCount)
      && Number(value.effectiveConnectableDatabaseCount) >= 1
      && value.effectiveTargetOnlyDatabaseScopeVerified === false
      && safeHash(value.effectiveDatabaseScopeEvidenceSha256)
      && value.operationalizationBlockedUntilEffectiveDatabaseScopeVerified === true
    ));
}

function pgDumpRoleArgumentSha256(roleName: string): string {
  return sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-logical-backup-v4-pg-dump-role-argument",
    version: 1,
    argument: `--role=${roleName}`,
  });
}

function pgDumpArgumentsBindingSha256(
  roleArgumentSha256: string,
  snapshotArgumentSemanticBindingSha256: string,
  semanticHandoffBindingSha256: string,
): string {
  return sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-logical-backup-v4-pg-dump-argument-binding",
    version: 1,
    roleArgumentSha256,
    snapshotArgumentSemanticBindingSha256,
    semanticHandoffBindingSha256,
  });
}

function exportedSnapshotBindingSha256(input: {
  readonly sourceDatabaseOid: string;
  readonly databaseIdentitySha256: string;
  readonly sourceUrlSha256: string;
  readonly effectiveRoleName: string;
  readonly snapshotIdentifierSha256: string;
}): string {
  return sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-logical-backup-v4-exported-snapshot-binding",
    version: 1,
    ...input,
    transactionIsolation: "repeatable read",
    transactionReadOnly: true,
  });
}

function pgDumpSnapshotSemanticBindingSha256(snapshotIdentifierSha256: string): string {
  return sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-logical-backup-v4-pg-dump-snapshot-semantic-binding",
    version: 1,
    snapshotIdentifierSha256,
  });
}

function semanticHandoffBindingSha256(input: {
  readonly sourceDatabaseOid: string;
  readonly databaseIdentitySha256: string;
  readonly sourceUrlSha256: string;
  readonly effectiveRoleName: string;
  readonly snapshotIdentifierSha256: string;
  readonly exportedSnapshotBindingSha256: string;
  readonly pgDumpSnapshotSemanticBindingSha256: string;
}): string {
  return sha256CanonicalPostgresLogicalState({
    kind: "pintpath-postgres-logical-backup-v4-snapshot-handoff-semantic-binding",
    version: 1,
    ...input,
  });
}

function exactSnapshotHandoff(
  value: unknown,
): value is PostgresLogicalBackupV4SnapshotHandoffBinding {
  if (!isPlainObject(value) || !exactKeys(value, [
    "profile", "sourceDatabaseOid", "databaseIdentitySha256", "sourceUrlSha256",
    "effectiveRoleName", "snapshotIdentifierSha256", "exportedSnapshotBindingSha256",
    "pgDumpSnapshotSemanticBindingSha256", "semanticHandoffBindingSha256",
  ])
    || value.profile !== "semantic-exported-snapshot-pg-dump-binding-v1"
    || !exactOid(value.sourceDatabaseOid)
    || !safeHash(value.databaseIdentitySha256)
    || !safeHash(value.sourceUrlSha256)
    || value.effectiveRoleName !== backupGroupRoleName(value.sourceDatabaseOid)
    || !safeHash(value.snapshotIdentifierSha256)
    || !safeHash(value.exportedSnapshotBindingSha256)
    || !safeHash(value.pgDumpSnapshotSemanticBindingSha256)
    || !safeHash(value.semanticHandoffBindingSha256)) return false;
  const semantic = {
    sourceDatabaseOid: value.sourceDatabaseOid,
    databaseIdentitySha256: value.databaseIdentitySha256,
    sourceUrlSha256: value.sourceUrlSha256,
    effectiveRoleName: value.effectiveRoleName,
    snapshotIdentifierSha256: value.snapshotIdentifierSha256,
  };
  return value.exportedSnapshotBindingSha256 === exportedSnapshotBindingSha256(semantic)
    && value.pgDumpSnapshotSemanticBindingSha256
      === pgDumpSnapshotSemanticBindingSha256(value.snapshotIdentifierSha256)
    && value.semanticHandoffBindingSha256 === semanticHandoffBindingSha256({
      ...semantic,
      exportedSnapshotBindingSha256: value.exportedSnapshotBindingSha256,
      pgDumpSnapshotSemanticBindingSha256: value.pgDumpSnapshotSemanticBindingSha256,
    });
}

export function canonicalPostgresLogicalBackupV4SourceAuthorityPolicyJson(): string {
  return POLICY_CANONICAL_JSON;
}

export function parsePostgresLogicalBackupV4SourceAuthorityPolicy(
  bytes: Buffer,
): typeof POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY {
  if (bytes.length < 1 || bytes.length > 16 * 1024
    || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) fail("policy_invalid");
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    fail("policy_invalid");
  }
  const snapshot = snapshotBoundedPlainData(parsed, "policy_invalid");
  if (canonicalJson(snapshot) !== text || text !== POLICY_CANONICAL_JSON) fail("policy_invalid");
  return POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY;
}

export function buildPostgresLogicalBackupV4SourceCaptureBinding(
  capture: PostgresLogicalStateCaptureV2,
): PostgresLogicalBackupV4SourceCaptureBinding {
  const snapshot = snapshotBoundedPlainData(
    capture,
    "capture_binding_invalid",
    MAX_CAPTURE_DEPTH,
    MAX_CAPTURE_NODES,
  );
  if (!isPlainObject(snapshot)
    || !exactKeys(snapshot, ["inventory", "sourceDatabaseOid", "sourcePhysicalReadBoundarySha256"])
    || !isPlainObject(snapshot.inventory)
    || !exactOid(snapshot.sourceDatabaseOid)
    || !safeHash(snapshot.sourcePhysicalReadBoundarySha256)
    || !safeHash(snapshot.inventory.sourceReadBoundarySha256)
    || !safeHash(snapshot.inventory.overallStateSha256)) fail("capture_binding_invalid");
  const captureJson = canonicalJson(snapshot);
  if (Buffer.byteLength(captureJson, "utf8") > MAX_CAPTURE_BYTES) {
    fail("capture_binding_invalid");
  }
  return deepFreeze({
    profile: "opaque-logical-state-v2-capture-digest-v1",
    captureSha256: sha256Bytes(captureJson),
    sourceDatabaseOid: snapshot.sourceDatabaseOid,
    portableReadBoundarySha256: snapshot.inventory.sourceReadBoundarySha256,
    physicalReadBoundarySha256: snapshot.sourcePhysicalReadBoundarySha256,
    overallStateSha256: snapshot.inventory.overallStateSha256,
    requiresIndependentFullV2Validation: true,
  });
}

export function buildPostgresLogicalBackupV4SnapshotHandoffBinding(input: {
  readonly sourceDatabaseOid: string;
  readonly databaseIdentitySha256: string;
  readonly sourceUrlSha256: string;
  readonly effectiveRoleName: string;
  readonly snapshotIdentifier: string;
}): PostgresLogicalBackupV4SnapshotHandoffBinding {
  const snapshot = snapshotBoundedPlainData(input, "snapshot_binding_invalid");
  if (!isPlainObject(snapshot)
    || !exactKeys(snapshot, [
      "sourceDatabaseOid", "databaseIdentitySha256", "sourceUrlSha256",
      "effectiveRoleName", "snapshotIdentifier",
    ])
    || !exactOid(snapshot.sourceDatabaseOid)
    || !safeHash(snapshot.databaseIdentitySha256)
    || !safeHash(snapshot.sourceUrlSha256)
    || snapshot.effectiveRoleName !== backupGroupRoleName(snapshot.sourceDatabaseOid)
    || !exactSnapshotIdentifier(snapshot.snapshotIdentifier)) {
    fail("snapshot_binding_invalid");
  }
  const semantic = {
    sourceDatabaseOid: snapshot.sourceDatabaseOid,
    databaseIdentitySha256: snapshot.databaseIdentitySha256,
    sourceUrlSha256: snapshot.sourceUrlSha256,
    effectiveRoleName: snapshot.effectiveRoleName,
    snapshotIdentifierSha256: sha256Bytes(snapshot.snapshotIdentifier),
  };
  const exported = exportedSnapshotBindingSha256(semantic);
  const pgDumpSnapshot = pgDumpSnapshotSemanticBindingSha256(
    semantic.snapshotIdentifierSha256,
  );
  return deepFreeze({
    profile: "semantic-exported-snapshot-pg-dump-binding-v1",
    ...semantic,
    exportedSnapshotBindingSha256: exported,
    pgDumpSnapshotSemanticBindingSha256: pgDumpSnapshot,
    semanticHandoffBindingSha256: semanticHandoffBindingSha256({
      ...semantic,
      exportedSnapshotBindingSha256: exported,
      pgDumpSnapshotSemanticBindingSha256: pgDumpSnapshot,
    }),
  });
}

function transitionValid(
  value: unknown,
  phase: MembershipTransitionReceipt["phase"],
  observedAt: string,
  active: boolean,
): value is MembershipTransitionReceipt {
  if (!isPlainObject(value) || !exactKeys(value, [
    "phase", "observedAt", "backupGroupChildMembershipCount",
    "loginParentMembershipCount", "exactSetOnlyMembershipCount",
    "inheritOptionTrueCount", "adminOptionTrueCount", "observerSessionIdentitySha256",
    "evidenceSha256",
  ])) return false;
  const expected = active ? 1 : 0;
  return value.phase === phase
    && value.observedAt === observedAt
    && value.backupGroupChildMembershipCount === expected
    && value.loginParentMembershipCount === expected
    && value.exactSetOnlyMembershipCount === expected
    && value.inheritOptionTrueCount === 0
    && value.adminOptionTrueCount === 0
    && safeHash(value.observerSessionIdentitySha256)
    && safeHash(value.evidenceSha256);
}

function receiptBindingProjection(
  receipt: Omit<PostgresLogicalBackupV4SourceAuthorityReceipt, "receiptBindingSha256">,
): unknown {
  return {
    kind: "pintpath-postgres-logical-backup-v4-source-authority-receipt-binding",
    version: 1,
    receipt,
  };
}

function validateReceipt(value: unknown): asserts value is PostgresLogicalBackupV4SourceAuthorityReceipt {
  if (!isPlainObject(value) || !exactKeys(value, [
    "kind", "version", "profile", "policySha256", "createdAt", "validity", "source",
    "roles", "sessions", "eventTimes", "membershipTransitions", "sourceTransaction",
    "v2Capture", "exportedSnapshot", "pgDumpHandoff", "cleanup", "evidenceOnly",
    "operationalSourceAuthorityImplemented", "effectiveTargetOnlyDatabaseAccessVerified",
    "completeRoleGraphVerified", "emitterMustRejectUntilOperationalSourceAuthorityImplemented",
    "activationAuthorized", "artifactEmissionAuthorized", "productionCutoverAuthorized",
    "receiptBindingSha256",
  ])) fail("receipt_invalid");
  if (value.kind !== "pintpath-postgres-logical-backup-source-authority"
    || value.version !== 1
    || value.profile !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_PROFILE
    || value.policySha256 !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY_SHA256
    || !exactIsoInstant(value.createdAt)
    || value.evidenceOnly !== true
    || value.operationalSourceAuthorityImplemented !== false
    || value.effectiveTargetOnlyDatabaseAccessVerified !== false
    || value.completeRoleGraphVerified !== false
    || value.emitterMustRejectUntilOperationalSourceAuthorityImplemented !== true
    || value.activationAuthorized !== false
    || value.artifactEmissionAuthorized !== false
    || value.productionCutoverAuthorized !== false
    || !safeHash(value.receiptBindingSha256)) fail("receipt_invalid");

  if (!isPlainObject(value.validity) || !exactKeys(value.validity, [
    "startedAt", "expiresAt", "maxLifetimeSeconds", "serverClockEvidenceSha256",
  ])
    || !exactIsoInstant(value.validity.startedAt)
    || !exactIsoInstant(value.validity.expiresAt)
    || !safeHash(value.validity.serverClockEvidenceSha256)
    || value.validity.maxLifetimeSeconds
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_LIFETIME_SECONDS) fail("receipt_invalid");
  const started = Date.parse(value.validity.startedAt);
  const expires = Date.parse(value.validity.expiresAt);
  if (expires <= started
    || expires - started > POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_LIFETIME_SECONDS * 1000) {
    fail("receipt_invalid");
  }

  if (!isPlainObject(value.source) || !exactKeys(value.source, [
    "databaseOid", "databaseIdentitySha256", "urlSha256",
  ])
    || !exactOid(value.source.databaseOid)
    || !safeHash(value.source.databaseIdentitySha256)
    || !safeHash(value.source.urlSha256)) fail("receipt_invalid");
  const groupName = backupGroupRoleName(value.source.databaseOid);

  if (!isPlainObject(value.roles) || !exactKeys(value.roles, ["backupGroup", "ephemeralLogin"])
    || !exactRoleSafetyFlags(value.roles.backupGroup, false)
    || !exactRoleSafetyFlags(value.roles.ephemeralLogin, true)) fail("receipt_invalid");
  const backupGroup = value.roles.backupGroup;
  const ephemeralLogin = value.roles.ephemeralLogin;
  if (backupGroup.roleName !== groupName
    || backupGroup.roleOid === ephemeralLogin.roleOid
    || typeof ephemeralLogin.roleName !== "string"
    || !ephemeralLogin.roleName.startsWith(`${groupName}_v`)
    || !LOGIN_VERSION_PATTERN.test(ephemeralLogin.roleName.slice(groupName.length + 2))
    || Buffer.byteLength(ephemeralLogin.roleName, "utf8") > 63
    || ephemeralLogin.validUntil !== value.validity.expiresAt) fail("receipt_invalid");
  const loginName = ephemeralLogin.roleName;

  if (!isPlainObject(value.sessions) || !exactKeys(value.sessions, [
    "source", "independentAdmin", "pgDump",
  ])
    || !isPlainObject(value.sessions.source)
    || !exactKeys(value.sessions.source, [
      "identitySha256", "currentUserRoleName", "sessionUserRoleName",
      "statementTimeoutMilliseconds", "idleInTransactionSessionTimeoutMilliseconds",
      "idleSessionTimeoutMilliseconds", "transactionTimeoutMilliseconds",
      "timeoutEvidenceSha256",
    ])
    || !isPlainObject(value.sessions.independentAdmin)
    || !exactKeys(value.sessions.independentAdmin, ["identitySha256"])
    || !isPlainObject(value.sessions.pgDump)
    || !exactKeys(value.sessions.pgDump, [
      "identitySha256", "currentUserRoleName", "sessionUserRoleName",
      "serverGucTimeoutsAuthoritative", "externalWallClockWatchdogRequired",
      "watchdogStartedAt", "externalWallClockTimeoutMilliseconds", "absoluteDeadline",
      "cleanupReserveMilliseconds", "externalWatchdogEvidenceSha256",
    ])
    || !safeHash(value.sessions.source.identitySha256)
    || !safeHash(value.sessions.independentAdmin.identitySha256)
    || !safeHash(value.sessions.pgDump.identitySha256)
    || !safeHash(value.sessions.source.timeoutEvidenceSha256)
    || !safeHash(value.sessions.pgDump.externalWatchdogEvidenceSha256)
    || new Set([
      value.sessions.source.identitySha256,
      value.sessions.independentAdmin.identitySha256,
      value.sessions.pgDump.identitySha256,
    ]).size !== 3
    || value.sessions.source.currentUserRoleName !== groupName
    || value.sessions.source.sessionUserRoleName !== loginName
    || value.sessions.source.statementTimeoutMilliseconds
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_STATEMENT_TIMEOUT_MILLISECONDS
    || value.sessions.source.idleInTransactionSessionTimeoutMilliseconds
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS
    || value.sessions.source.idleSessionTimeoutMilliseconds
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS
    || value.sessions.source.transactionTimeoutMilliseconds
      !== POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS
    || value.sessions.pgDump.currentUserRoleName !== groupName
    || value.sessions.pgDump.sessionUserRoleName !== loginName
    || value.sessions.pgDump.serverGucTimeoutsAuthoritative !== false
    || value.sessions.pgDump.externalWallClockWatchdogRequired !== true
    || !exactIsoInstant(value.sessions.pgDump.watchdogStartedAt)
    || value.sessions.pgDump.externalWallClockTimeoutMilliseconds
      !== POSTGRES_LOGICAL_BACKUP_V4_PG_DUMP_WATCHDOG_TIMEOUT_MILLISECONDS
    || !exactIsoInstant(value.sessions.pgDump.absoluteDeadline)
    || value.sessions.pgDump.cleanupReserveMilliseconds
      !== POSTGRES_LOGICAL_BACKUP_V4_CLEANUP_RESERVE_MILLISECONDS) {
    fail("receipt_invalid");
  }
  const independentAdminSessionIdentitySha256 = value.sessions.independentAdmin.identitySha256;

  const eventKeys = [
    "loginProvisionedAt", "sourceRoleSetAt", "membershipRevokedAt",
    "sourceTransactionBeganAt", "v2CaptureCompletedAt", "snapshotExportedAt",
    "membershipRegrantedAt", "pgDumpSnapshotImportedAt", "sourceTransactionEndedAt",
    "cleanupCompletedAt",
  ] as const;
  if (!isPlainObject(value.eventTimes) || !exactKeys(value.eventTimes, eventKeys)) {
    fail("receipt_invalid");
  }
  const eventTimes = value.eventTimes;
  const eventValues = eventKeys.map((key) => eventTimes[key]);
  if (!eventValues.every(exactIsoInstant)) fail("receipt_invalid");
  const canonicalEvents = eventValues as string[];
  const typedEventTimes = eventTimes as unknown as PostgresLogicalBackupV4SourceAuthorityReceipt["eventTimes"];
  if (canonicalEvents.some(
    (instant) => Date.parse(instant) < started || Date.parse(instant) > expires,
  )
    || canonicalEvents.some((instant, index) => index > 0
      && Date.parse(instant) < Date.parse(canonicalEvents[index - 1]!))
    || value.createdAt !== eventTimes.cleanupCompletedAt) fail("receipt_invalid");
  const pgDumpWatchdogStarted = Date.parse(typedEventTimes.membershipRegrantedAt);
  const latestWatchdogDeadline = expires
    - POSTGRES_LOGICAL_BACKUP_V4_CLEANUP_RESERVE_MILLISECONDS;
  const expectedWatchdogDeadline = new Date(Math.min(
    pgDumpWatchdogStarted + POSTGRES_LOGICAL_BACKUP_V4_PG_DUMP_WATCHDOG_TIMEOUT_MILLISECONDS,
    latestWatchdogDeadline,
  )).toISOString();
  if (pgDumpWatchdogStarted >= latestWatchdogDeadline
    || value.sessions.pgDump.watchdogStartedAt !== typedEventTimes.membershipRegrantedAt
    || value.sessions.pgDump.absoluteDeadline !== expectedWatchdogDeadline
    || Date.parse(typedEventTimes.sourceTransactionEndedAt)
      > Date.parse(expectedWatchdogDeadline)) fail("receipt_invalid");

  if (!Array.isArray(value.membershipTransitions)
    || value.membershipTransitions.length !== 4
    || !transitionValid(
      value.membershipTransitions[0], "provisioned", typedEventTimes.loginProvisionedAt, true,
    )
    || !transitionValid(
      value.membershipTransitions[1], "detached-for-v2", typedEventTimes.membershipRevokedAt, false,
    )
    || !transitionValid(
      value.membershipTransitions[2], "regranted-for-pg-dump",
      typedEventTimes.membershipRegrantedAt, true,
    )
    || !transitionValid(
      value.membershipTransitions[3], "cleaned-up", typedEventTimes.cleanupCompletedAt, false,
    )
    || value.membershipTransitions.some((transition) => (
      !isPlainObject(transition)
      || transition.observerSessionIdentitySha256
        !== independentAdminSessionIdentitySha256
    ))) fail("receipt_invalid");

  if (!isPlainObject(value.sourceTransaction) || !exactKeys(value.sourceTransaction, [
    "isolation", "readOnly", "currentUserRoleName", "sessionUserRoleName",
    "backupGroupChildMembershipCount", "loginParentMembershipCount",
    "sourceSessionIdentitySha256", "evidenceSha256",
  ])
    || value.sourceTransaction.isolation !== "repeatable read"
    || value.sourceTransaction.readOnly !== true
    || value.sourceTransaction.currentUserRoleName !== groupName
    || value.sourceTransaction.sessionUserRoleName !== loginName
    || value.sourceTransaction.backupGroupChildMembershipCount !== 0
    || value.sourceTransaction.loginParentMembershipCount !== 0
    || value.sourceTransaction.sourceSessionIdentitySha256
      !== value.sessions.source.identitySha256
    || !safeHash(value.sourceTransaction.evidenceSha256)) fail("receipt_invalid");

  if (!isPlainObject(value.v2Capture) || !exactKeys(value.v2Capture, [
    "profile", "captureSha256", "sourceDatabaseOid", "portableReadBoundarySha256",
    "physicalReadBoundarySha256", "overallStateSha256", "capturedAt", "captureSequence",
    "sourceSessionIdentitySha256", "requiresIndependentFullV2Validation",
  ])
    || value.v2Capture.profile !== "opaque-logical-state-v2-capture-digest-v1"
    || !safeHash(value.v2Capture.captureSha256)
    || value.v2Capture.sourceDatabaseOid !== value.source.databaseOid
    || !safeHash(value.v2Capture.portableReadBoundarySha256)
    || !safeHash(value.v2Capture.physicalReadBoundarySha256)
    || !safeHash(value.v2Capture.overallStateSha256)
    || value.v2Capture.capturedAt !== value.eventTimes.v2CaptureCompletedAt
    || value.v2Capture.captureSequence !== 1
    || value.v2Capture.requiresIndependentFullV2Validation !== true
    || value.v2Capture.sourceSessionIdentitySha256
      !== value.sessions.source.identitySha256) fail("receipt_invalid");

  if (!isPlainObject(value.exportedSnapshot) || !exactKeys(value.exportedSnapshot, [
    "exportedAt", "bindingSha256", "snapshotIdentifierSha256",
    "semanticHandoffBindingSha256", "rawIdentifierPersisted", "exportSequence",
    "sourceSessionIdentitySha256", "immediateAfterV2Capture", "sequenceEvidenceSha256",
  ])
    || value.exportedSnapshot.exportedAt !== value.eventTimes.snapshotExportedAt
    || !safeHash(value.exportedSnapshot.bindingSha256)
    || !safeHash(value.exportedSnapshot.snapshotIdentifierSha256)
    || !safeHash(value.exportedSnapshot.semanticHandoffBindingSha256)
    || !safeHash(value.exportedSnapshot.sequenceEvidenceSha256)
    || value.exportedSnapshot.rawIdentifierPersisted !== false
    || value.exportedSnapshot.exportSequence !== 2
    || value.exportedSnapshot.immediateAfterV2Capture !== true
    || value.exportedSnapshot.sourceSessionIdentitySha256
      !== value.sessions.source.identitySha256) fail("receipt_invalid");

  const expectedSnapshotSemantic = {
    sourceDatabaseOid: value.source.databaseOid,
    databaseIdentitySha256: value.source.databaseIdentitySha256,
    sourceUrlSha256: value.source.urlSha256,
    effectiveRoleName: groupName,
    snapshotIdentifierSha256: value.exportedSnapshot.snapshotIdentifierSha256,
  };
  const expectedExportedSnapshotBindingSha256 = exportedSnapshotBindingSha256(
    expectedSnapshotSemantic,
  );
  const expectedPgDumpSnapshotSemanticBindingSha256 =
    pgDumpSnapshotSemanticBindingSha256(value.exportedSnapshot.snapshotIdentifierSha256);
  const expectedSemanticHandoffBindingSha256 = semanticHandoffBindingSha256({
    ...expectedSnapshotSemantic,
    exportedSnapshotBindingSha256: expectedExportedSnapshotBindingSha256,
    pgDumpSnapshotSemanticBindingSha256: expectedPgDumpSnapshotSemanticBindingSha256,
  });
  if (value.exportedSnapshot.bindingSha256 !== expectedExportedSnapshotBindingSha256
    || value.exportedSnapshot.semanticHandoffBindingSha256
      !== expectedSemanticHandoffBindingSha256) fail("receipt_invalid");

  const roleArgumentSha256 = pgDumpRoleArgumentSha256(groupName);
  if (!isPlainObject(value.pgDumpHandoff) || !exactKeys(value.pgDumpHandoff, [
    "observedAt", "secondConnectionRequired", "roleArgumentSha256",
    "snapshotArgumentSemanticBindingSha256", "semanticHandoffBindingSha256",
    "argumentsBindingSha256", "importedSnapshotBindingSha256",
    "pgDumpSessionIdentitySha256", "exactRawArgumentsReceiptVerificationRequired",
    "exactRawArgumentsEvidenceSha256", "snapshotVisibilityEvidenceSha256",
  ])
    || value.pgDumpHandoff.observedAt !== value.eventTimes.pgDumpSnapshotImportedAt
    || value.pgDumpHandoff.secondConnectionRequired !== true
    || value.pgDumpHandoff.roleArgumentSha256 !== roleArgumentSha256
    || !safeHash(value.pgDumpHandoff.snapshotArgumentSemanticBindingSha256)
    || value.pgDumpHandoff.snapshotArgumentSemanticBindingSha256
      !== expectedPgDumpSnapshotSemanticBindingSha256
    || value.pgDumpHandoff.semanticHandoffBindingSha256
      !== value.exportedSnapshot.semanticHandoffBindingSha256
    || value.pgDumpHandoff.importedSnapshotBindingSha256
      !== value.exportedSnapshot.bindingSha256
    || value.pgDumpHandoff.pgDumpSessionIdentitySha256
      !== value.sessions.pgDump.identitySha256
    || value.pgDumpHandoff.exactRawArgumentsReceiptVerificationRequired !== true
    || !safeHash(value.pgDumpHandoff.exactRawArgumentsEvidenceSha256)
    || value.pgDumpHandoff.argumentsBindingSha256 !== pgDumpArgumentsBindingSha256(
      roleArgumentSha256,
      value.pgDumpHandoff.snapshotArgumentSemanticBindingSha256,
      value.pgDumpHandoff.semanticHandoffBindingSha256,
    )
    || !safeHash(value.pgDumpHandoff.snapshotVisibilityEvidenceSha256)) fail("receipt_invalid");

  if (!isPlainObject(value.cleanup) || !exactKeys(value.cleanup, [
    "required", "membershipRevoked", "loginDisabled", "loginDropped",
    "backendTerminationAttempted", "terminatedBackendCount", "activeSessionCount",
    "evidenceSha256",
  ])
    || value.cleanup.required !== true
    || value.cleanup.membershipRevoked !== true
    || value.cleanup.loginDisabled !== true
    || value.cleanup.loginDropped !== true
    || value.cleanup.backendTerminationAttempted !== true
    || !Number.isSafeInteger(value.cleanup.terminatedBackendCount)
    || Number(value.cleanup.terminatedBackendCount) < 0
    || value.cleanup.activeSessionCount !== 0
    || !safeHash(value.cleanup.evidenceSha256)) fail("receipt_invalid");

  const { receiptBindingSha256: _ignored, ...withoutBinding } = value;
  if (value.receiptBindingSha256 !== sha256CanonicalPostgresLogicalState(
    receiptBindingProjection(withoutBinding as Omit<
      PostgresLogicalBackupV4SourceAuthorityReceipt,
      "receiptBindingSha256"
    >),
  )) fail("receipt_invalid");
}

export function buildPostgresLogicalBackupV4SourceAuthorityReceipt(
  input: BuildPostgresLogicalBackupV4SourceAuthorityReceiptInput,
): PostgresLogicalBackupV4SourceAuthorityReceipt {
  const snapshot = snapshotBoundedPlainData(input, "receipt_invalid");
  if (!isPlainObject(snapshot)
    || !exactKeys(snapshot, [
      "createdAt", "startedAt", "expiresAt", "sourceDatabaseOid",
      "databaseIdentitySha256", "sourceUrlSha256", "backupGroupRoleOid",
      "ephemeralLoginRoleOid", "ephemeralLoginVersion", "backupGroupCatalogEvidenceSha256",
      "ephemeralLoginCatalogEvidenceSha256", "effectiveConnectableDatabaseCount",
      "effectiveDatabaseScopeEvidenceSha256", "sourceSessionIdentitySha256",
      "independentAdminSessionIdentitySha256", "pgDumpSessionIdentitySha256",
      "sourceAuthenticationEvidenceSha256", "pgDumpAuthenticationEvidenceSha256",
      "sourceSessionTimeoutEvidenceSha256", "pgDumpExternalWatchdogEvidenceSha256", "eventTimes",
      "membershipEvidenceSha256", "sourceTransactionEvidenceSha256", "sourceCapture",
      "captureToExportSequenceEvidenceSha256", "snapshotHandoff",
      "pgDumpSnapshotVisibilityEvidenceSha256", "pgDumpExactRawArgumentsEvidenceSha256",
      "cleanupEvidenceSha256", "terminatedBackendCount", "serverClockEvidenceSha256",
    ])
    || !exactOid(snapshot.sourceDatabaseOid)
    || !exactOid(snapshot.backupGroupRoleOid)
    || !exactOid(snapshot.ephemeralLoginRoleOid)
    || typeof snapshot.ephemeralLoginVersion !== "string"
    || !LOGIN_VERSION_PATTERN.test(snapshot.ephemeralLoginVersion)
    || !safeHash(snapshot.backupGroupCatalogEvidenceSha256)
    || !safeHash(snapshot.ephemeralLoginCatalogEvidenceSha256)
    || !Number.isSafeInteger(snapshot.effectiveConnectableDatabaseCount)
    || Number(snapshot.effectiveConnectableDatabaseCount) < 1
    || !safeHash(snapshot.effectiveDatabaseScopeEvidenceSha256)
    || !safeHash(snapshot.databaseIdentitySha256)
    || !safeHash(snapshot.sourceUrlSha256)
    || !safeHash(snapshot.sourceSessionIdentitySha256)
    || !safeHash(snapshot.independentAdminSessionIdentitySha256)
    || !safeHash(snapshot.pgDumpSessionIdentitySha256)
    || !safeHash(snapshot.sourceAuthenticationEvidenceSha256)
    || !safeHash(snapshot.pgDumpAuthenticationEvidenceSha256)
    || !safeHash(snapshot.sourceSessionTimeoutEvidenceSha256)
    || !safeHash(snapshot.pgDumpExternalWatchdogEvidenceSha256)
    || !safeHash(snapshot.serverClockEvidenceSha256)
    || !isPlainObject(snapshot.eventTimes)
    || !isPlainObject(snapshot.membershipEvidenceSha256)
    || !exactKeys(snapshot.membershipEvidenceSha256, [
      "provisioned", "detachedForV2", "regrantedForPgDump", "cleanedUp",
    ])
    || !Object.values(snapshot.membershipEvidenceSha256).every(safeHash)
    || !safeHash(snapshot.sourceTransactionEvidenceSha256)
    || !safeHash(snapshot.captureToExportSequenceEvidenceSha256)
    || !isPlainObject(snapshot.sourceCapture)
    || !exactKeys(snapshot.sourceCapture, [
      "profile", "captureSha256", "sourceDatabaseOid", "portableReadBoundarySha256",
      "physicalReadBoundarySha256", "overallStateSha256",
      "requiresIndependentFullV2Validation",
    ])
    || !isPlainObject(snapshot.snapshotHandoff)
    || !exactSnapshotHandoff(snapshot.snapshotHandoff)
    || !safeHash(snapshot.pgDumpSnapshotVisibilityEvidenceSha256)
    || !safeHash(snapshot.pgDumpExactRawArgumentsEvidenceSha256)
    || !safeHash(snapshot.cleanupEvidenceSha256)
    || !Number.isSafeInteger(snapshot.terminatedBackendCount)
    || Number(snapshot.terminatedBackendCount) < 0) fail("receipt_invalid");

  const groupName = backupGroupRoleName(snapshot.sourceDatabaseOid);
  const loginName = ephemeralLoginRoleName(
    snapshot.sourceDatabaseOid,
    snapshot.ephemeralLoginVersion,
  );
  const roleArgumentSha256 = pgDumpRoleArgumentSha256(groupName);
  const snapshotArgumentSemanticBindingSha256 =
    snapshot.snapshotHandoff.pgDumpSnapshotSemanticBindingSha256;
  const exportedSnapshotBindingSha256 = snapshot.snapshotHandoff.exportedSnapshotBindingSha256;
  const handoffSemanticBindingSha256 = snapshot.snapshotHandoff.semanticHandoffBindingSha256;
  if (snapshot.sourceCapture.sourceDatabaseOid !== snapshot.sourceDatabaseOid
    || snapshot.sourceCapture.profile !== "opaque-logical-state-v2-capture-digest-v1"
    || snapshot.snapshotHandoff.sourceDatabaseOid !== snapshot.sourceDatabaseOid
    || snapshot.snapshotHandoff.databaseIdentitySha256 !== snapshot.databaseIdentitySha256
    || snapshot.snapshotHandoff.sourceUrlSha256 !== snapshot.sourceUrlSha256
    || snapshot.snapshotHandoff.effectiveRoleName !== groupName
    || !safeHash(snapshotArgumentSemanticBindingSha256)
    || !safeHash(exportedSnapshotBindingSha256)
    || !safeHash(handoffSemanticBindingSha256)) fail("receipt_invalid");
  const eventTimes = snapshot.eventTimes as unknown as PostgresLogicalBackupV4SourceAuthorityReceipt["eventTimes"];
  const membershipEvidence = snapshot.membershipEvidenceSha256 as unknown as {
    readonly provisioned: string;
    readonly detachedForV2: string;
    readonly regrantedForPgDump: string;
    readonly cleanedUp: string;
  };

  const base = {
    kind: "pintpath-postgres-logical-backup-source-authority" as const,
    version: 1 as const,
    profile: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_PROFILE,
    policySha256: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_POLICY_SHA256,
    createdAt: snapshot.createdAt as string,
    validity: {
      startedAt: snapshot.startedAt as string,
      expiresAt: snapshot.expiresAt as string,
      maxLifetimeSeconds: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_LIFETIME_SECONDS as typeof POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_LIFETIME_SECONDS,
      serverClockEvidenceSha256: snapshot.serverClockEvidenceSha256,
    },
    source: {
      databaseOid: snapshot.sourceDatabaseOid,
      databaseIdentitySha256: snapshot.databaseIdentitySha256,
      urlSha256: snapshot.sourceUrlSha256,
    },
    roles: {
      backupGroup: {
        roleName: groupName,
        roleOid: snapshot.backupGroupRoleOid,
        login: false as const,
        inherit: false as const,
        superuser: false as const,
        createDatabase: false as const,
        createRole: false as const,
        replication: false as const,
        bypassRls: false as const,
        catalogEvidenceSha256: snapshot.backupGroupCatalogEvidenceSha256,
      },
      ephemeralLogin: {
        roleName: loginName,
        roleOid: snapshot.ephemeralLoginRoleOid,
        login: true as const,
        inherit: false as const,
        connectionLimit: 2 as const,
        validUntil: snapshot.expiresAt as string,
        passwordVerifierFormat: "scram-sha-256" as const,
        sourceAuthenticationEvidenceSha256: snapshot.sourceAuthenticationEvidenceSha256,
        pgDumpAuthenticationEvidenceSha256: snapshot.pgDumpAuthenticationEvidenceSha256,
        directTargetDatabaseConnectGrantCount: 1 as const,
        directFunctionPrivilegeCount: 0 as const,
        directPrivateObjectPrivilegeCount: 0 as const,
        effectiveConnectableDatabaseCount: snapshot.effectiveConnectableDatabaseCount as number,
        effectiveTargetOnlyDatabaseScopeVerified: false as const,
        effectiveDatabaseScopeEvidenceSha256: snapshot.effectiveDatabaseScopeEvidenceSha256,
        operationalizationBlockedUntilEffectiveDatabaseScopeVerified: true as const,
        superuser: false as const,
        createDatabase: false as const,
        createRole: false as const,
        replication: false as const,
        bypassRls: false as const,
        catalogEvidenceSha256: snapshot.ephemeralLoginCatalogEvidenceSha256,
      },
    },
    sessions: {
      source: {
        identitySha256: snapshot.sourceSessionIdentitySha256,
        currentUserRoleName: groupName,
        sessionUserRoleName: loginName,
        statementTimeoutMilliseconds: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_STATEMENT_TIMEOUT_MILLISECONDS as typeof POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_STATEMENT_TIMEOUT_MILLISECONDS,
        idleInTransactionSessionTimeoutMilliseconds: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS as typeof POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS,
        idleSessionTimeoutMilliseconds: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS as typeof POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS,
        transactionTimeoutMilliseconds: POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS as typeof POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_SESSION_TIMEOUT_MILLISECONDS,
        timeoutEvidenceSha256: snapshot.sourceSessionTimeoutEvidenceSha256,
      },
      independentAdmin: { identitySha256: snapshot.independentAdminSessionIdentitySha256 },
      pgDump: {
        identitySha256: snapshot.pgDumpSessionIdentitySha256,
        currentUserRoleName: groupName,
        sessionUserRoleName: loginName,
        serverGucTimeoutsAuthoritative: false as const,
        externalWallClockWatchdogRequired: true as const,
        watchdogStartedAt: eventTimes.membershipRegrantedAt,
        externalWallClockTimeoutMilliseconds: POSTGRES_LOGICAL_BACKUP_V4_PG_DUMP_WATCHDOG_TIMEOUT_MILLISECONDS as typeof POSTGRES_LOGICAL_BACKUP_V4_PG_DUMP_WATCHDOG_TIMEOUT_MILLISECONDS,
        absoluteDeadline: new Date(Math.min(
          Date.parse(eventTimes.membershipRegrantedAt)
            + POSTGRES_LOGICAL_BACKUP_V4_PG_DUMP_WATCHDOG_TIMEOUT_MILLISECONDS,
          Date.parse(snapshot.expiresAt as string)
            - POSTGRES_LOGICAL_BACKUP_V4_CLEANUP_RESERVE_MILLISECONDS,
        )).toISOString(),
        cleanupReserveMilliseconds: POSTGRES_LOGICAL_BACKUP_V4_CLEANUP_RESERVE_MILLISECONDS as typeof POSTGRES_LOGICAL_BACKUP_V4_CLEANUP_RESERVE_MILLISECONDS,
        externalWatchdogEvidenceSha256: snapshot.pgDumpExternalWatchdogEvidenceSha256,
      },
    },
    eventTimes,
    membershipTransitions: [
      {
        phase: "provisioned" as const,
        observedAt: eventTimes.loginProvisionedAt,
        backupGroupChildMembershipCount: 1 as const,
        loginParentMembershipCount: 1 as const,
        exactSetOnlyMembershipCount: 1 as const,
        inheritOptionTrueCount: 0 as const,
        adminOptionTrueCount: 0 as const,
        observerSessionIdentitySha256: snapshot.independentAdminSessionIdentitySha256,
        evidenceSha256: membershipEvidence.provisioned,
      },
      {
        phase: "detached-for-v2" as const,
        observedAt: eventTimes.membershipRevokedAt,
        backupGroupChildMembershipCount: 0 as const,
        loginParentMembershipCount: 0 as const,
        exactSetOnlyMembershipCount: 0 as const,
        inheritOptionTrueCount: 0 as const,
        adminOptionTrueCount: 0 as const,
        observerSessionIdentitySha256: snapshot.independentAdminSessionIdentitySha256,
        evidenceSha256: membershipEvidence.detachedForV2,
      },
      {
        phase: "regranted-for-pg-dump" as const,
        observedAt: eventTimes.membershipRegrantedAt,
        backupGroupChildMembershipCount: 1 as const,
        loginParentMembershipCount: 1 as const,
        exactSetOnlyMembershipCount: 1 as const,
        inheritOptionTrueCount: 0 as const,
        adminOptionTrueCount: 0 as const,
        observerSessionIdentitySha256: snapshot.independentAdminSessionIdentitySha256,
        evidenceSha256: membershipEvidence.regrantedForPgDump,
      },
      {
        phase: "cleaned-up" as const,
        observedAt: eventTimes.cleanupCompletedAt,
        backupGroupChildMembershipCount: 0 as const,
        loginParentMembershipCount: 0 as const,
        exactSetOnlyMembershipCount: 0 as const,
        inheritOptionTrueCount: 0 as const,
        adminOptionTrueCount: 0 as const,
        observerSessionIdentitySha256: snapshot.independentAdminSessionIdentitySha256,
        evidenceSha256: membershipEvidence.cleanedUp,
      },
    ] as const,
    sourceTransaction: {
      isolation: "repeatable read" as const,
      readOnly: true as const,
      currentUserRoleName: groupName,
      sessionUserRoleName: loginName,
      backupGroupChildMembershipCount: 0 as const,
      loginParentMembershipCount: 0 as const,
      sourceSessionIdentitySha256: snapshot.sourceSessionIdentitySha256,
      evidenceSha256: snapshot.sourceTransactionEvidenceSha256,
    },
    v2Capture: {
      ...(snapshot.sourceCapture as unknown as PostgresLogicalBackupV4SourceCaptureBinding),
      capturedAt: eventTimes.v2CaptureCompletedAt,
      captureSequence: 1 as const,
      sourceSessionIdentitySha256: snapshot.sourceSessionIdentitySha256,
    },
    exportedSnapshot: {
      exportedAt: eventTimes.snapshotExportedAt,
      bindingSha256: exportedSnapshotBindingSha256,
      snapshotIdentifierSha256: snapshot.snapshotHandoff.snapshotIdentifierSha256,
      semanticHandoffBindingSha256: handoffSemanticBindingSha256,
      rawIdentifierPersisted: false as const,
      exportSequence: 2 as const,
      sourceSessionIdentitySha256: snapshot.sourceSessionIdentitySha256,
      immediateAfterV2Capture: true as const,
      sequenceEvidenceSha256: snapshot.captureToExportSequenceEvidenceSha256,
    },
    pgDumpHandoff: {
      observedAt: eventTimes.pgDumpSnapshotImportedAt,
      secondConnectionRequired: true as const,
      roleArgumentSha256,
      snapshotArgumentSemanticBindingSha256,
      semanticHandoffBindingSha256: handoffSemanticBindingSha256,
      argumentsBindingSha256: pgDumpArgumentsBindingSha256(
        roleArgumentSha256,
        snapshotArgumentSemanticBindingSha256,
        handoffSemanticBindingSha256,
      ),
      importedSnapshotBindingSha256: exportedSnapshotBindingSha256,
      pgDumpSessionIdentitySha256: snapshot.pgDumpSessionIdentitySha256,
      exactRawArgumentsReceiptVerificationRequired: true as const,
      exactRawArgumentsEvidenceSha256: snapshot.pgDumpExactRawArgumentsEvidenceSha256,
      snapshotVisibilityEvidenceSha256: snapshot.pgDumpSnapshotVisibilityEvidenceSha256,
    },
    cleanup: {
      required: true as const,
      membershipRevoked: true as const,
      loginDisabled: true as const,
      loginDropped: true as const,
      backendTerminationAttempted: true as const,
      terminatedBackendCount: snapshot.terminatedBackendCount as number,
      activeSessionCount: 0 as const,
      evidenceSha256: snapshot.cleanupEvidenceSha256,
    },
    evidenceOnly: true as const,
    operationalSourceAuthorityImplemented: false as const,
    effectiveTargetOnlyDatabaseAccessVerified: false as const,
    completeRoleGraphVerified: false as const,
    emitterMustRejectUntilOperationalSourceAuthorityImplemented: true as const,
    activationAuthorized: false as const,
    artifactEmissionAuthorized: false as const,
    productionCutoverAuthorized: false as const,
  };
  const receipt: PostgresLogicalBackupV4SourceAuthorityReceipt = {
    ...base,
    receiptBindingSha256: sha256CanonicalPostgresLogicalState(receiptBindingProjection(base)),
  };
  validateReceipt(receipt);
  return deepFreeze(receipt);
}

export function canonicalPostgresLogicalBackupV4SourceAuthorityReceiptJson(
  receipt: PostgresLogicalBackupV4SourceAuthorityReceipt,
): string {
  const snapshot = snapshotBoundedPlainData(receipt, "receipt_invalid");
  validateReceipt(snapshot);
  return canonicalJson(snapshot);
}

export function postgresLogicalBackupV4SourceAuthorityReceiptSha256(
  receipt: PostgresLogicalBackupV4SourceAuthorityReceipt,
): string {
  return sha256Bytes(canonicalPostgresLogicalBackupV4SourceAuthorityReceiptJson(receipt));
}

export function parsePostgresLogicalBackupV4SourceAuthorityReceipt(
  bytes: Buffer,
): PostgresLogicalBackupV4SourceAuthorityReceipt {
  if (bytes.length < 1
    || bytes.length > POSTGRES_LOGICAL_BACKUP_V4_SOURCE_AUTHORITY_MAX_RECEIPT_BYTES
    || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    fail("receipt_invalid");
  }
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    fail("receipt_invalid");
  }
  const snapshot = snapshotBoundedPlainData(parsed, "receipt_invalid");
  validateReceipt(snapshot);
  if (canonicalJson(snapshot) !== text) fail("receipt_invalid");
  return deepFreeze(snapshot as PostgresLogicalBackupV4SourceAuthorityReceipt);
}
